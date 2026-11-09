// src/cbackend.js — C 后端 C1(v0.39):eligible 数值函数 → C(GCC/Clang -O2)
//
// 资格分析直接复用 wasm 层(analyzeEligibility numericOnly = i64/u64/f64 签名,
// design.md §6.8 "零新判定逻辑")。映射:
//   i64 → long long / u64 → unsigned long long / f64 → double
//   checked 运算 → __builtin_add/sub/mul_overflow;除/模/移位显式守卫
//   panic → ming_panic(发射期嵌入的完整诊断首行)+ exit(101)
//
// panic 消息逐点对齐:
//   eligible 函数内 = wasm 层通用消息(vm.js panic_m4002/m4004:"整数运算溢出/移位越界")
//   main 内         = binopValues 具体消息(含操作数值,如 "整数+溢出:a + b 超出 i64 范围")
// 诊断首行格式 = formatDiag 非TTY:"file:line:col: error CODE[name]: message"
//
// C1 明确不做(C2):str/Vec/Map 传参、容器 for-in、float→int 截断、f64 的
// print/diag(JS 最短往返格式与 printf 无法逐字保证)、std.math 仅位级精确子集。

import { Unsupported, analyzeEligibility } from './wasm.js';

// ---------- 小工具 ----------

// C 字符串字面量体转义
function cstr(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

const CTYPE = { i64: 'long long', u64: 'unsigned long long', f64: 'double', str: 'ming_str', vi64: 'ming_vec', mi64: 'ming_map', oi64: 'ming_opt' };
const CSUF = { i64: 'LL', u64: 'ULL', f64: '' };
const FMT = { i64: '%lld', u64: '%llu' };

// std.math 位级精确子集:sqrt(IEEE 正确舍入)、fabs/floor/ceil/fmin/fmax(IEEE 定义)。
// round 单独实现:JS Math.round = floor(x+0.5)(半数向上),C round() 是半数远离零。
// 其余超越函数 JS/库实现可能差 1 ulp,C1 不收(emit 期 Unsupported → 整体回落)。
const MATH_SAFE = new Set(['sqrt', 'abs', 'floor', 'ceil', 'min', 'max']);
const MATH_CNAME = { sqrt: 'sqrt', abs: 'fabs', floor: 'floor', ceil: 'ceil', min: 'fmin', max: 'fmax' };

// 诊断首行(= formatDiag 非TTY 第一行;panic 无 hint,调用栈节 C1 不复刻)
function diagHead(span, code, name, msg) {
  const f = span?.file ?? '<unknown>';
  return `${f}:${span?.line ?? 0}:${span?.col ?? 0}: error ${code}[${name}]: ${msg}`;
}

// Ming 类型节点 → 载体类型(C3 起:str/Vec[i64]/Map[str,i64]/Option[i64] 全消费面)
function mingTyNum(t) {
  if (!t) return null;
  if (t.k === 'int' && t.bits === 64) return t.signed ? 'i64' : 'u64';
  if (t.k === 'float' && t.bits === 64) return 'f64';
  if (t.k === 'str') return 'str';
  if (t.k === 'vec' && t.el?.k === 'int' && t.el?.bits === 64 && t.el?.signed) return 'vi64';
  if (t.k === 'map' && t.kt?.k === 'str' && t.vt?.k === 'int' && t.vt?.bits === 64 && t.vt?.signed) return 'mi64';
  if (t.k === 'opt' && t.el?.k === 'int' && t.el?.bits === 64 && t.el?.signed) return 'oi64';
  return null;
}

// 类型标注节点:解析器形状是 nt:'TName'(let 标注 / as 目标);签名里是已解析的 k+bits 形状。
// 返回 {k,bits,signed} | null(与 interp castValue 的 PRIM_TYPES 口径一致);str/Vec 用扩展形状
const ANNO_PRIM = {
  i8: { k: 'int', bits: 8, signed: true }, u8: { k: 'int', bits: 8, signed: false },
  i16: { k: 'int', bits: 16, signed: true }, u16: { k: 'int', bits: 16, signed: false },
  i32: { k: 'int', bits: 32, signed: true }, u32: { k: 'int', bits: 32, signed: false },
  i64: { k: 'int', bits: 64, signed: true }, u64: { k: 'int', bits: 64, signed: false },
  f64: { k: 'float', bits: 64, signed: true },
};

function annoTarget(t) {
  if (!t) return null;
  if (t.nt === 'TName') {
    const n = t.name.split('.').pop();
    if (n === 'str') return { k: 'str' };
    if ((n === 'Vec') && t.args?.length === 1) {
      const el = annoTarget(t.args[0]);
      if (el && el.k === 'int' && el.bits === 64 && el.signed) return { k: 'vec', el };
      return null;
    }
    if ((n === 'Map') && t.args?.length === 2) {
      const kt = annoTarget(t.args[0]);
      const vt = annoTarget(t.args[1]);
      if (kt?.k === 'str' && vt?.k === 'int' && vt.bits === 64 && vt.signed) return { k: 'map', vt };
      return null;
    }
    if ((n === 'Option') && t.args?.length === 1) {
      const el = annoTarget(t.args[0]);
      if (el && el.k === 'int' && el.bits === 64 && el.signed) return { k: 'opt', el };
      return null;
    }
    return ANNO_PRIM[n] ?? null;
  }
  if (t.k === 'int' || t.k === 'float') return { k: t.k, bits: t.bits, signed: !!t.signed };
  if (t.k === 'str') return { k: 'str' };
  if (t.k === 'vec') return { k: 'vec', el: t.el };
  return null;
}

// 标注 → 载体类型(let 标注用)
function annoTy(t) {
  const a = annoTarget(t);
  if (!a) return null;
  if (a.k === 'str') return 'str';
  if (a.k === 'vec') return 'vi64';
  if (a.k === 'map') return 'mi64';
  if (a.k === 'opt') return 'oi64';
  return mingTyNum(a);
}

// ---------- 发射器 ----------

class CEmit {
  constructor(check, compiled) {
    this.check = check;
    this.compiled = compiled;
    this.modulesByFile = new Map(check.modules.map(m => [m.file, m]));
    this.usedConsts = new Map(); // const 名 → 'i64'|'u64'|'f64'|'str'(发射期收集,顶部统一定义)
    this.strLits = new Map();    // str 字面量 → 全局数组名
    this.tmpSeq = 0;
  }

  newTmp(ctx, ty, init) {
    const name = `__t${++this.tmpSeq}`;
    ctx.line(init !== undefined ? `${CTYPE[ty]} ${name} = ${init};` : `${CTYPE[ty]} ${name};`);
    return name;
  }

  // 名字解析(按调用方所在模块,与 wasm resolveMingFn 同源)
  resolveEntry(callerCtx, name) {
    const mod = this.modulesByFile.get(callerCtx.modFile) ?? this.check.entry;
    return mod?.items.get(name) ?? null;
  }

  resolveConst(callerCtx, name) {
    const entry = this.resolveEntry(callerCtx, name);
    if (!entry || entry.kind !== 'const') return null;
    const val = this.compiled.constEntryVals?.get(entry);
    if (!val) return null;
    if (val.t === 'int') return { ty: 'i64', v: val.v };
    if (val.t === 'float') return { ty: 'f64', v: val.v };
    if (val.t === 'str') return { ty: 'str', v: val.v };
    return null;
  }

  // ---- 类型推断(镜像 wasm inferNumType 的数值面)----
  inferTy(e, ctx) {
    switch (e.nt) {
      case 'IntLit':
        if (e.bits !== 64) return null;
        if (e.suffix === 'u64') return 'u64';
        return e.signed ? 'i64' : 'u64';
      case 'FloatLit': return e.bits === 64 ? 'f64' : null;
      case 'BoolLit': return 'bool';
      case 'StrLit': return 'str';
      case 'VecLit': {
        if (e.elems.length === 0) return null; // 空 Vec 需标注
        let ok = true;
        for (const el of e.elems) { if (this.inferTy(el, ctx) !== 'i64') { ok = false; break; } }
        return ok ? 'vi64' : null;
      }
      case 'Ident': {
        if (e.name === 'None') return 'oi64';
        const local = ctx.typeOf(e.name);
        if (local) return local;
        const c = this.resolveConst(ctx, e.name);
        if (c) { this.usedConsts.set(e.name, c.ty); return c.ty; }
        return null;
      }
      case 'Unary': return e.op === '-' ? this.inferTy(e.expr, ctx) : null;
      case 'Binary': {
        if (e.op === '+' && this.inferTy(e.l, ctx) === 'str') return 'str';
        if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(e.op)) return 'bool';
        return this.inferTy(e.l, ctx);
      }
      case 'Call': {
        const mn = this.mathNameOf(e.callee, ctx);
        if (mn) return 'f64';
        if (e.callee.nt === 'Field') {
          // 方法调用类型推断(C2 方法面;base 可为任意 str/Vec[i64] 表达式)
          const m = e.callee.name;
          let bt = null;
          if (e.callee.base.nt === 'Ident' && ctx.nameOf(e.callee.base.name)) bt = ctx.typeOf(e.callee.base.name);
          else bt = this.inferTy(e.callee.base, ctx);
          if (bt === 'str') {
            if (m === 'char_len' || m === 'byte_len') return 'i64';
            if (m === 'contains' || m === 'is_empty' || m === 'starts_with' || m === 'ends_with') return 'bool';
            if (['replace', 'pad_left', 'pad_right', 'slice_chars', 'trim', 'trim_start', 'trim_end'].includes(m)) return 'str';
            return null;
          }
          if (bt === 'vi64') {
            if (m === 'len') return 'i64';
            if (m === 'contains') return 'bool';
            if (m === 'pop' || m === 'get') return 'oi64';
            return null;
          }
          if (bt === 'mi64') {
            if (m === 'len') return 'i64';
            if (m === 'is_empty' || m === 'has') return 'bool';
            if (m === 'get') return 'oi64';
            if (m === 'set' || m === 'delete' || m === 'clear') return null;
            return null;
          }
          if (bt === 'oi64') {
            if (m === 'is_some' || m === 'is_none') return 'bool';
            if (m === 'unwrap' || m === 'unwrap_or') return 'i64';
            return null;
          }
          if (e.callee.base.nt === 'Ident') {
            const t = ANNO_PRIM[e.callee.base.name];
            if (t && (m === 'max_value' || m === 'min_value')) return t.signed ? 'i64' : 'u64';
            if (e.callee.base.name === 'f64' && ['infinity', 'neg_infinity', 'nan'].includes(m)) return 'f64';
          }
          return null;
        }
        if (e.callee.nt !== 'Ident') return null;
        // 裸枚举构造器:Option[i64] 的 Some/None(C3)
        if (e.callee.name === 'Some' && e.args?.length === 1 && this.inferTy(e.args[0], ctx) === 'i64') return 'oi64';
        if (e.callee.name === 'None' && (!e.args || e.args.length === 0)) return 'oi64';
        const entry = this.resolveEntry(ctx, e.callee.name);
        if (entry?.kind !== 'fn') return null;
        return mingTyNum(entry.sig?.ret);
      }
      case 'MapLit': {
        // Map[str, i64](C3)
        for (const en of e.entries) {
          if (this.inferTy(en.k, ctx) !== 'str' || this.inferTy(en.v, ctx) !== 'i64') return null;
        }
        return 'mi64';
      }
      case 'Match': {
        // 推导取第一个臂的值型(检查器已保证各臂同型)
        const a0 = e.arms?.[0]?.expr;
        if (!a0) return null;
        if (a0.nt === 'BlockExpr') return a0.block?.tail ? this.inferTy(a0.block.tail, ctx) : null;
        return this.inferTy(a0, ctx);
      }
      case 'Index': {
        // 下标读:Vec[i64]/Map[str,i64] → i64
        if (e.base.nt === 'Ident' && (ctx.typeOf(e.base.name) === 'vi64' || ctx.typeOf(e.base.name) === 'mi64')) return 'i64';
        return null;
      }
      case 'As': {
        const t = annoTarget(e.type);
        if (!t) return null;
        if (t.k === 'float') return t.bits === 64 ? 'f64' : null;
        // 64 位 → 本类型;<64 位 → 位型载体(无符号窄型零扩展入 u64,有符号入 i64)
        return t.signed ? 'i64' : 'u64';
      }
      case 'If': {
        if (!e.els) return null;
        const t = e.then?.tail ? this.inferTy(e.then.tail, ctx) : null;
        return t ?? this.inferTy(e.els, ctx);
      }
      default: return null;
    }
  }

  mathNameOf(callee, ctx) {
    if (callee.nt !== 'Field') return null;
    if (callee.base.nt === 'Ident' && callee.base.name === 'math' && !ctx.scopeHas('math')) return callee.name;
    if (callee.base.nt === 'Field' && callee.base.base.nt === 'Ident' && callee.base.base.name === 'std'
      && callee.base.name === 'math' && !ctx.scopeHas('std')) return callee.name;
    return null;
  }

  // ---- 表达式:返回 C 表达式文本;含检查的子式先把语句写进 ctx(三地址化)----
  emitExpr(e, ty, ctx) {
    switch (e.nt) {
      case 'IntLit': {
        if (ty !== 'i64' && ty !== 'u64') throw new Unsupported('int 字面量位置');
        if (e.bits !== 64) throw new Unsupported('非 64 位字面量');
        if (ty === 'u64' && e.v < 0n) throw new Unsupported('u64 负字面量');
        return `${e.v}${CSUF[ty]}`;
      }
      case 'FloatLit': {
        if (ty !== 'f64') throw new Unsupported('float 字面量位置');
        // 17 位有效数字在正确舍入的 strtod 下位级往返
        return e.v.toExponential(16);
      }
      case 'BoolLit': {
        if (ty !== 'bool') throw new Unsupported('bool 字面量位置');
        return e.v ? '1' : '0';
      }
      case 'StrLit': {
        if (ty !== 'str') throw new Unsupported('str 字面量位置');
        if (!(e.parts.length === 1 && 'lit' in e.parts[0])) throw new Unsupported('字符串插值(C3)');
        const name = this.strLitName(e.parts[0].lit);
        const n = Buffer.byteLength(e.parts[0].lit, 'utf8');
        return `ming_str_lit(${name}, ${n})`;
      }
      case 'VecLit': {
        if (ty !== 'vi64') throw new Unsupported('Vec 字面量位置');
        const n = e.elems.length;
        if (n === 0) throw new Unsupported('空 Vec 字面量(需标注,先赋非空再用)');
        const an = `__a${++this.tmpSeq}`;
        ctx.line(`long long ${an}[${n}];`);
        for (let i = 0; i < n; i++) ctx.line(`${an}[${i}] = ${this.emitExpr(e.elems[i], 'i64', ctx)};`);
        const t = this.newTmp(ctx, 'vi64');
        ctx.line(`${t} = ming_vec_lit(${an}, ${n});`);
        return t;
      }
      case 'MapLit': {
        if (ty !== 'mi64') throw new Unsupported('Map 字面量位置');
        const n = e.entries.length;
        const an = `__k${++this.tmpSeq}`;
        ctx.line(`ming_kv ${an}[${n}];`);
        for (let i = 0; i < n; i++) {
          const k = this.emitExpr(e.entries[i].k, 'str', ctx);
          const kv = this.emitExpr(e.entries[i].v, 'i64', ctx);
          ctx.line(`${an}[${i}].k = ${k}.p; ${an}[${i}].kn = ${k}.n; ${an}[${i}].v = ${kv};`);
        }
        const t = this.newTmp(ctx, 'mi64');
        ctx.line(`${t} = ming_map_lit(${an}, ${n});`);
        return t;
      }
      case 'Index': {
        // 下标读:Vec[i64](OOB M4003)/ Map[str,i64](缺键 M4007)
        if (e.base.nt !== 'Ident') throw new Unsupported('下标目标非局部');
        const bt = ctx.typeOf(e.base.name);
        if (bt === 'vi64') {
          if (ty !== 'i64') throw new Unsupported('下标结果位置 ' + ty);
          const base = ctx.nameOf(e.base.name);
          const idx = this.emitExpr(e.index, 'i64', ctx);
          return `ming_vec_get(${base}, ${idx}, "${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0})`;
        }
        if (bt === 'mi64') {
          if (ty !== 'i64') throw new Unsupported('下标结果位置 ' + ty);
          const base = ctx.nameOf(e.base.name);
          const k = this.emitExpr(e.index, 'str', ctx);
          return `ming_map_index(${base}, ${k}, "${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0})`;
        }
        throw new Unsupported('下标类型 ' + bt);
      }
      case 'Ident': {
        // prelude 裸变体:None(无括号形式)
        if (e.name === 'None') {
          if (ty !== 'oi64') throw new Unsupported('None 位置 ' + ty);
          return 'ming_opt_none()';
        }
        const local = ctx.nameOf(e.name);
        if (local) return local;
        const c = this.resolveConst(ctx, e.name);
        if (c) {
          this.usedConsts.set(e.name, c.ty);
          return `(${CTYPE[ty]})g_${e.name}`;
        }
        throw new Unsupported('名字 ' + e.name);
      }
      case 'Unary': {
        if (e.op !== '-') throw new Unsupported('一元 ' + e.op);
        const it = this.inferTy(e.expr, ctx);
        if (it === 'f64') return `(-(${this.emitExpr(e.expr, 'f64', ctx)}))`;
        if (it !== 'i64' && it !== 'u64') throw new Unsupported('取负类型');
        if (it === 'u64') return `(0ULL - (${this.emitExpr(e.expr, 'u64', ctx)}))`; // wasm 同语义:0-x 回绕
        const a = this.emitExpr(e.expr, 'i64', ctx);
        return `ming_neg_i64(${a}, "${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0})`;
      }
      case 'Binary': return this.emitBin(e, ty, ctx);
      case 'As': return this.emitAs(e, ty, ctx);
      case 'Call': return this.emitCallValue(e, ty, ctx);
      case 'Match': return this.emitMatch(e, ty, ctx);
      case 'If': {
        // 表达式形式(必须带 else,分支块为纯尾表达式)
        if (!e.els) throw new Unsupported('无 else 的 if 表达式');
        const t = this.newTmp(ctx, ty === 'bool' ? 'i64' : ty);
        ctx.open(`if (${this.emitCond(e.cond, ctx)}) {`);
        ctx.line(`${t} = ${this.emitValue(e.then, ty, ctx)};`);
        ctx.close('}');
        ctx.open('else {');
        ctx.line(`${t} = ${this.emitValue(e.els, ty, ctx)};`);
        ctx.close('}');
        return t;
      }
      default:
        throw new Unsupported('表达式 ' + e.nt);
    }
  }

  // match 表达式(C2:整数字面量臂 + 通配 + 可选 guard → if/else 链;穷尽由检查器保证)
  emitMatch(e, ty, ctx) {
    const st = this.inferTy(e.scrutinee, ctx);
    if (st !== 'i64' && st !== 'u64') throw new Unsupported('match 宗量 ' + st + '(C2 仅整数)');
    const svT = this.newTmp(ctx, st);
    ctx.line(`${svT} = ${this.emitExpr(e.scrutinee, st, ctx)};`);
    const t = this.newTmp(ctx, ty === 'bool' ? 'i64' : ty);
    // 臂分类:条件臂(字面量 ± guard,含带 guard 的通配)与无 guard 兜底
    // (AST 实测:PLit 的值在 pat.val(字符串数字);通配在解析后是 PIdent 无 name)
    const conds = [];
    let wildArm = null;
    for (const arm of e.arms) {
      const p = arm.pat;
      const isWild = p.nt === 'PWild' || (p.nt === 'PIdent' && (p.name === undefined || p.name === '_'));
      if (isWild && !arm.guard) { wildArm = arm; continue; }
      let cond;
      if (isWild) {
        cond = this.emitCond(arm.guard, ctx);
      } else if (p.nt === 'PLit' && p.lit && typeof p.lit.val !== 'object') {
        const pv = BigInt(p.lit.val) * (p.neg ? -1n : 1n);
        cond = `${svT} == ${pv}${CSUF[st]}`;
        if (arm.guard) cond = `(${cond}) && ${this.emitCond(arm.guard, ctx)}`;
      } else {
        throw new Unsupported('match 模式(C2 仅整数字面量)');
      }
      conds.push({ cond, arm });
    }
    let first = true;
    for (const { cond, arm } of conds) {
      ctx.line(`${first ? 'if (' : '} else if ('}${cond}) {`);
      ctx.line(`    ${t} = ${this.emitValue(arm.expr, ty, ctx)};`);
      first = false;
    }
    ctx.line(`${first ? '{' : '} else {'}`);
    if (wildArm) {
      ctx.line(`    ${t} = ${this.emitValue(wildArm.expr, ty, ctx)};`);
    } else {
      // 检查器保证穷尽;防御分支与 VM 一致(内部错误 panic)
      ctx.line('    ming_panic("内部错误:match 未命中\\n");');
      ctx.line('    exit(101);');
    }
    ctx.line('}');
    return t;
  }

  // 值位置(If 表达式的分支块:取块尾表达式)
  emitValue(x, ty, ctx) {
    if (x?.stmts) {
      if (x.stmts.length) throw new Unsupported('块含语句的 if 表达式');
      if (!x.tail) throw new Unsupported('空块值');
      return this.emitExpr(x.tail, ty, ctx);
    }
    return this.emitExpr(x, ty, ctx);
  }

  emitBin(e, ty, ctx) {
    const op = e.op;
    // 逻辑/比较作为值(C 的比较与短路天然 0/1,与 Ming bool 一致)
    if (op === '&&' || op === '||') {
      if (ty !== 'bool' && ty !== 'i64' && ty !== 'u64') throw new Unsupported('逻辑值位置');
      const text = `(${this.emitCond(e.l, ctx)} ${op} ${this.emitCond(e.r, ctx)})`;
      return ty === 'bool' ? text : `((long long)(${text}))`;
    }
    if (['==', '!=', '<', '<=', '>', '>='].includes(op)) {
      const lt = this.inferTy(e.l, ctx);
      const rt = this.inferTy(e.r, ctx);
      if (!lt || !rt || lt !== rt) throw new Unsupported('比较两侧类型');
      let text;
      if (lt === 'str') {
        // str 比较:字节序(UTF-8 保序;与 JS 的 UTF-16 序仅在非 BMP 与 U+E000..U+FFFF 交叉处可能不同)
        if (op === '==' || op === '!=') text = `(ming_str_eq(${this.emitExpr(e.l, 'str', ctx)}, ${this.emitExpr(e.r, 'str', ctx)}))`;
        else text = `(ming_str_cmp(${this.emitExpr(e.l, 'str', ctx)}, ${this.emitExpr(e.r, 'str', ctx)}) ${op} 0)`;
        if (op === '!=') text = `(!${text})`;
      } else {
        text = `(${this.emitExpr(e.l, lt, ctx)} ${op} ${this.emitExpr(e.r, rt, ctx)})`;
      }
      return ty === 'bool' ? text : `((long long)(${text}))`;
    }
    // 算术
    const lt = this.inferTy(e.l, ctx);
    if (lt === 'str') {
      if (op !== '+' || ty !== 'str') throw new Unsupported('str 运算 ' + op);
      return `ming_str_cat(${this.emitExpr(e.l, 'str', ctx)}, ${this.emitExpr(e.r, 'str', ctx)})`;
    }
    if (lt === 'vi64') throw new Unsupported('Vec 运算 ' + op);
    if (lt === 'f64') {
      if (ty !== 'f64') throw new Unsupported('f64 运算位置');
      if (!['+', '-', '*', '/'].includes(op)) throw new Unsupported('f64 运算 ' + op);
      return `(${this.emitExpr(e.l, 'f64', ctx)} ${op} ${this.emitExpr(e.r, 'f64', ctx)})`;
    }
    if (lt !== 'i64' && lt !== 'u64') throw new Unsupported('运算类型 ' + lt);
    if (ty !== lt) throw new Unsupported('运算结果位置 ' + ty);
    if (op === '&' || op === '|' || op === '^') {
      return `(${this.emitExpr(e.l, lt, ctx)} ${op} ${this.emitExpr(e.r, lt, ctx)})`;
    }
    const a = this.emitExpr(e.l, lt, ctx);
    const b = this.emitExpr(e.r, lt, ctx);
    const t = this.newTmp(ctx, lt);
    if (lt === 'u64') this.emitCheckedU(op, a, b, t, e.span, ctx);
    else this.emitCheckedS(op, a, b, t, e.span, ctx);
    return t;
  }

  // checked 运算发射。ctx.specific=true → main(binopValues 具体消息含操作数值)
  // ctx.specific=false → eligible 函数内(对齐 wasm 层通用消息 vm.js panic_m4002/m4004)
  emitCheckedS(op, a, b, dst, span, ctx) {
    const P = (msg) => this.emitPanicStmt('M4002', 'integer-overflow', msg, span, ctx);
    const PZ = (msg) => this.emitPanicStmt('M4004', 'division-by-zero', msg, span, ctx);
    const ovfMsg = ctx.specific
      ? { fmt: `整数${op}溢出:${FMT.i64} ${op} ${FMT.i64} 超出 i64 范围\\n`, args: `, ${a}, ${b}` }
      : null;
    switch (op) {
      case '+':
        ctx.open(`if (__builtin_add_overflow(${a}, ${b}, &${dst})) {`); P(ovfMsg); ctx.close('}');
        return;
      case '-':
        ctx.open(`if (__builtin_sub_overflow(${a}, ${b}, &${dst})) {`); P(ovfMsg); ctx.close('}');
        return;
      case '*':
        ctx.open(`if (__builtin_mul_overflow(${a}, ${b}, &${dst})) {`); P(ovfMsg); ctx.close('}');
        return;
      case '/':
        ctx.open(`if (${b} == 0LL) {`);
        PZ(ctx.specific ? { fmt: `整数除零:${FMT.i64} / 0\\n`, args: `, ${a}` } : null);
        ctx.close('}');
        ctx.open(`if (${b} == -1LL && ${a} == LLONG_MIN) {`); P(ovfMsg); ctx.close('}');
        ctx.line(`${dst} = ${a} / ${b};`);
        return;
      case '%':
        ctx.open(`if (${b} == 0LL) {`);
        PZ(ctx.specific ? { fmt: `整数取模零:${FMT.i64} %% 0\\n`, args: `, ${a}` } : null);
        ctx.close('}');
        // C 的 LLONG_MIN % -1 是 UB;Ming rem 语义 = 0
        ctx.open(`if (${b} == -1LL) {`);
        ctx.line(`${dst} = 0LL;`);
        ctx.close('}');
        ctx.open('else {');
        ctx.line(`${dst} = ${a} % ${b};`);
        ctx.close('}');
        return;
      case '<<': case '>>':
        ctx.open(`if (${b} < 0 || ${b} >= 64) {`);
        P(ctx.specific ? { fmt: `移位位数 ${FMT.i64} 越界(必须在 0..63)\\n`, args: `, ${b}` } : null);
        ctx.close('}');
        if (op === '<<') ctx.line(`${dst} = (long long)((unsigned long long)(${a}) << ${b});`);
        else ctx.line(`${dst} = ${a} >> ${b};`); // gcc/clang:有符号右移 = 算术移位
        return;
      default:
        throw new Unsupported('i64 运算 ' + op);
    }
  }

  emitCheckedU(op, a, b, dst, span, ctx) {
    const P = (msg) => this.emitPanicStmt('M4002', 'integer-overflow', msg, span, ctx);
    const PZ = (msg) => this.emitPanicStmt('M4004', 'division-by-zero', msg, span, ctx);
    const ovfMsg = ctx.specific
      ? { fmt: `整数${op}溢出:${FMT.u64} ${op} ${FMT.u64} 超出 i64u 范围\\n`, args: `, ${a}, ${b}` }
      : null;
    switch (op) {
      case '+':
        ctx.open(`if (__builtin_add_overflow(${a}, ${b}, &${dst})) {`); P(ovfMsg); ctx.close('}');
        return;
      case '-':
        ctx.open(`if (__builtin_sub_overflow(${a}, ${b}, &${dst})) {`); P(ovfMsg); ctx.close('}');
        return;
      case '*':
        ctx.open(`if (__builtin_mul_overflow(${a}, ${b}, &${dst})) {`); P(ovfMsg); ctx.close('}');
        return;
      case '/':
        ctx.open(`if (${b} == 0ULL) {`);
        PZ(ctx.specific ? { fmt: `整数除零:${FMT.u64} / 0\\n`, args: `, ${a}` } : null);
        ctx.close('}');
        ctx.line(`${dst} = ${a} / ${b};`);
        return;
      case '%':
        ctx.open(`if (${b} == 0ULL) {`);
        PZ(ctx.specific ? { fmt: `整数取模零:${FMT.u64} %% 0\\n`, args: `, ${a}` } : null);
        ctx.close('}');
        ctx.line(`${dst} = ${a} % ${b};`);
        return;
      case '<<': case '>>':
        ctx.open(`if (${b} >= 64) {`);
        P(ctx.specific ? { fmt: `移位位数 ${FMT.u64} 越界(必须在 0..63)\\n`, args: `, ${b}` } : null);
        ctx.close('}');
        ctx.line(`${dst} = ${a} ${op} ${b};`);
        return;
      default:
        throw new Unsupported('u64 运算 ' + op);
    }
  }

  // panic 语句。msg:{fmt, args}(fprintf 动态值)或 null(静态文本 = wasm 层通用消息)
  emitPanicStmt(code, name, msg, span, ctx) {
    if (ctx.specific && msg) {
      const head = `${span?.file ?? '<unknown>'}:${span?.line ?? 0}:${span?.col ?? 0}: error ${code}[${name}]: `;
      ctx.line(`fprintf(stderr, "%s${msg.fmt}", "${cstr(head)}"${msg.args});`);
    } else {
      const text = code === 'M4004' ? '整数除零' : '整数运算溢出/移位越界';
      ctx.line(`ming_panic("${cstr(diagHead(span, code, name, text))}\\n");`);
    }
    ctx.line('exit(101);');
  }

  // as:int↔int 位截断(经 64 位载体;窄型按符号选择零延/符号延载体);
  // int→f64 就近舍入;float→int(C1 不做饱和转换)→ Unsupported
  emitAs(e, ty, ctx) {
    const target = annoTarget(e.type);
    const srcTy = this.inferTy(e.expr, ctx);
    if (!srcTy) throw new Unsupported('as 源类型');
    if (target?.k === 'float') {
      if (target.bits !== 64) throw new Unsupported('as f32(C4)');
      if (ty !== 'f64') throw new Unsupported('as f64 位置');
      if (srcTy === 'f64') return this.emitExpr(e.expr, 'f64', ctx);
      if (srcTy === 'bool') throw new Unsupported('bool→f64');
      return `(double)(${this.emitExpr(e.expr, srcTy, ctx)})`;
    }
    if (target?.k !== 'int') throw new Unsupported('as 目标 ' + (target?.k ?? '?'));
    if (srcTy === 'f64') {
      // v0.41:float→int 截断 + 饱和(ming_f2i_sat/ming_f2u_sat,与 interp castValue 对齐)
      if (ty !== 'i64' && ty !== 'u64') throw new Unsupported('float→int 位置');
      const x = this.emitExpr(e.expr, 'f64', ctx);
      return ty === 'u64' ? `ming_f2u_sat(${x})` : `ming_f2i_sat(${x})`;
    }
    if (target.bits === 64) {
      if (ty !== 'i64' && ty !== 'u64') throw new Unsupported('as 位置');
      if (srcTy === 'bool') {
        const x = this.emitExpr(e.expr, 'bool', ctx);
        return ty === 'u64' ? `((unsigned long long)(${x}))` : `((long long)(${x}))`;
      }
      const x = this.emitExpr(e.expr, srcTy, ctx);
      return ty === 'u64' ? `(unsigned long long)(${x})` : `(long long)(${x})`;
    }
    // <64 位整数截断:产生 N 位位型,装进按符号选择的 64 位载体。
    // 允许出现在 i64/u64 期望位置(模糊器双重转换形态);f64 位置/后续窄型算术 → C2。
    if (ty !== 'i64' && ty !== 'u64') throw new Unsupported('窄截断位置 ' + ty);
    const x = this.emitExpr(e.expr, srcTy === 'u64' ? 'u64' : (srcTy === 'bool' ? 'bool' : 'i64'), ctx);
    const N = target.bits;
    if (target.signed) {
      if (srcTy === 'bool') return `((long long)(${x}))`;
      if (N === 64) return `(long long)(${x})`;
      return `(long long)(((long long)(${x}) << ${64 - N}) >> ${64 - N})`;
    }
    if (srcTy === 'bool') return `((unsigned long long)(${x}))`;
    if (N === 64) return `(unsigned long long)(${x})`;
    return `((unsigned long long)(${x}) & 0x${((1n << BigInt(N)) - 1n).toString(16)}ULL)`;
  }

  // 调用:发射参数(语句),返回 { call, retTy }('i64'|'u64'|'f64'|null=unit)
  emitCallRef(e, ctx) {
    const mn = this.mathNameOf(e.callee, ctx);
    if (mn) {
      if (!MATH_SAFE.has(mn)) throw new Unsupported('std.math ' + mn + '(JS/库位级一致性未证,C2)');
      const wantArity = (mn === 'min' || mn === 'max') ? 2 : 1;
      if (e.args.length !== wantArity) throw new Unsupported('math ' + mn + ' 参数数');
      const args = e.args.map(ar => this.emitExpr(ar, 'f64', ctx));
      return { call: `${MATH_CNAME[mn]}(${args.join(', ')})`, retTy: 'f64' };
    }
    // 方法调用:str / Vec[i64] 的 C2 方法面(纯方法允许任意 base 表达式;变异方法须局部)
    if (e.callee.nt === 'Field') {
      const m = e.callee.name;
      let baseText = null;
      let bt = null;
      let baseIsIdent = false;
      if (e.callee.base.nt === 'Ident' && ctx.nameOf(e.callee.base.name)) {
        baseText = ctx.nameOf(e.callee.base.name);
        bt = ctx.typeOf(e.callee.base.name);
        baseIsIdent = true;
      } else {
        bt = this.inferTy(e.callee.base, ctx);
        if (bt === 'str' || bt === 'vi64' || bt === 'mi64' || bt === 'oi64') {
          // 非 Ident base:求值一次入临时(方法体可能引用 baseText 两次,如 unwrap_or)
          const txt = this.emitExpr(e.callee.base, bt, ctx);
          baseText = this.newTmp(ctx, bt, txt);
        }
      }
      const SP = `"${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0}`;
      if (bt === 'str') {
        if (m === 'char_len' && e.args.length === 0) return { call: `ming_str_chars(${baseText})`, retTy: 'i64' };
        if (m === 'byte_len' && e.args.length === 0) return { call: `(${baseText}.n)`, retTy: 'i64' };
        if (m === 'is_empty' && e.args.length === 0) return { call: `(${baseText}.n == 0)`, retTy: 'bool' };
        if (m === 'contains' && e.args.length === 1) return { call: `ming_str_contains(${baseText}, ${this.emitExpr(e.args[0], 'str', ctx)})`, retTy: 'bool' };
        if (m === 'replace' && e.args.length === 2) return { call: `ming_str_replace(${baseText}, ${this.emitExpr(e.args[0], 'str', ctx)}, ${this.emitExpr(e.args[1], 'str', ctx)})`, retTy: 'str' };
        if (m === 'pad_left' && e.args.length === 1) return { call: `ming_str_pad_left(${baseText}, ${this.emitExpr(e.args[0], 'i64', ctx)})`, retTy: 'str' };
        if (m === 'pad_right' && e.args.length === 1) return { call: `ming_str_pad_right(${baseText}, ${this.emitExpr(e.args[0], 'i64', ctx)})`, retTy: 'str' };
        if (m === 'slice_chars' && e.args.length === 2) return { call: `ming_str_slice(${baseText}, ${this.emitExpr(e.args[0], 'i64', ctx)}, ${this.emitExpr(e.args[1], 'i64', ctx)}, ${SP})`, retTy: 'str' };
        if ((m === 'trim' || m === 'trim_start' || m === 'trim_end') && e.args.length === 0) {
          const mode = m === 'trim' ? '1, 1' : (m === 'trim_start' ? '1, 0' : '0, 1');
          return { call: `ming_str_trim_impl(${baseText}, ${mode})`, retTy: 'str' };
        }
        if (m === 'starts_with' && e.args.length === 1) return { call: `ming_str_starts(${baseText}, ${this.emitExpr(e.args[0], 'str', ctx)})`, retTy: 'bool' };
        if (m === 'ends_with' && e.args.length === 1) return { call: `ming_str_ends(${baseText}, ${this.emitExpr(e.args[0], 'str', ctx)})`, retTy: 'bool' };
        throw new Unsupported('str.' + m + '(C4:to_upper/to_lower/chars/split/parse_* 等)');
      }
      if (bt === 'vi64') {
        const gvSP = `"${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0}`;
        if (m === 'len' && e.args.length === 0) return { call: `(${baseText}.n)`, retTy: 'i64' };
        if (m === 'contains' && e.args.length === 1) return { call: `ming_vec_contains(${baseText}, ${this.emitExpr(e.args[0], 'i64', ctx)})`, retTy: 'bool' };
        if (m === 'pop' && e.args.length === 0) return { call: `ming_vec_pop(&${baseText})`, retTy: 'oi64' };
        if (m === 'get' && e.args.length === 1) return { call: `ming_vec_get_opt(${baseText}, ${this.emitExpr(e.args[0], 'i64', ctx)})`, retTy: 'oi64' };
        if (!baseIsIdent) throw new Unsupported('Vec.' + m + '(变异方法要求局部变量接收者)');
        if (m === 'push' && e.args.length === 1) return { call: `ming_vec_push(&${baseText}, ${this.emitExpr(e.args[0], 'i64', ctx)})`, retTy: null };
        if (m === 'reverse' && e.args.length === 0) return { call: `ming_vec_reverse(&${baseText})`, retTy: null };
        throw new Unsupported('Vec.' + m + '(C3 面:pop/get 已入)');
      }
      if (bt === 'mi64') {
        const SPm = `"${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0}`;
        if (m === 'len' && e.args.length === 0) return { call: `(${baseText}.n)`, retTy: 'i64' };
        if (m === 'is_empty' && e.args.length === 0) return { call: `(${baseText}.n == 0)`, retTy: 'bool' };
        if (m === 'has' && e.args.length === 1) return { call: `(ming_map_find(${baseText}, ${this.emitExpr(e.args[0], 'str', ctx)}) >= 0)`, retTy: 'bool' };
        if (m === 'get' && e.args.length === 1) return { call: `ming_map_get(${baseText}, ${this.emitExpr(e.args[0], 'str', ctx)})`, retTy: 'oi64' };
        if (m === 'set' && e.args.length === 2 && baseIsIdent) return { call: `ming_map_set(&${baseText}, ${this.emitExpr(e.args[0], 'str', ctx)}, ${this.emitExpr(e.args[1], 'i64', ctx)})`, retTy: null };
        if (m === 'delete' && e.args.length === 1 && baseIsIdent) return { call: `ming_map_delete(&${baseText}, ${this.emitExpr(e.args[0], 'str', ctx)})`, retTy: 'bool' };
        if (m === 'clear' && e.args.length === 0 && baseIsIdent) return { call: `(${baseText}.n = 0)`, retTy: null };
        throw new Unsupported('Map.' + m + '(keys/values/items 属 C4)');
      }
      if (bt === 'oi64') {
        if (m === 'is_some' && e.args.length === 0) return { call: `(${baseText}.some)`, retTy: 'bool' };
        if (m === 'is_none' && e.args.length === 0) return { call: `(!${baseText}.some)`, retTy: 'bool' };
        if (m === 'unwrap' && e.args.length === 0) return { call: `ming_opt_unwrap(${baseText}, "${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0})`, retTy: 'i64' };
        if (m === 'unwrap_or' && e.args.length === 1) return { call: `(${baseText}.some ? ${baseText}.v : ${this.emitExpr(e.args[0], 'i64', ctx)})`, retTy: 'i64' };
        throw new Unsupported('Option.' + m + '(C3 面:unwrap/unwrap_or/is_some/is_none)');
      }
    }
    // 类型级数值函数:i64.max_value() / u64.min_value() / f64.infinity() 等
    if (e.callee.nt === 'Field' && e.callee.base.nt === 'Ident') {
      const prim = e.callee.base.name;
      const tlf = e.callee.name;
      const t = ANNO_PRIM[prim];
      if (t) {
        if (tlf === 'max_value') {
          const v = t.signed ? (1n << BigInt(t.bits - 1)) - 1n : (1n << BigInt(t.bits)) - 1n;
          return { call: `${v}${t.signed ? 'LL' : 'ULL'}`, retTy: t.signed ? 'i64' : 'u64' };
        }
        if (tlf === 'min_value') {
          if (t.signed && t.bits === 64) return { call: '(-9223372036854775807LL - 1LL)', retTy: 'i64' };
          return { call: `${t.signed ? -(1n << BigInt(t.bits - 1)) : 0n}LL`, retTy: 'i64' };
        }
      }
      if (prim === 'f64') {
        if (tlf === 'infinity') return { call: 'INFINITY', retTy: 'f64' };
        if (tlf === 'neg_infinity') return { call: '(-INFINITY)', retTy: 'f64' };
        if (tlf === 'nan') return { call: '(0.0 / 0.0)', retTy: 'f64' };
      }
      throw new Unsupported('类型级 ' + prim + '.' + tlf);
    }
    // 裸枚举构造器:Option[i64] 的 Some/None(C3;Ok/Err 属 Result,C4)
    if (e.callee.nt === 'Ident' && (e.callee.name === 'Some' || e.callee.name === 'None')) {
      if (e.callee.name === 'None') {
        if (e.args?.length) throw new Unsupported('None 带参数');
        return { call: 'ming_opt_none()', retTy: 'oi64' };
      }
      if (e.args?.length !== 1) throw new Unsupported('Some 参数数');
      return { call: `ming_opt_some(${this.emitExpr(e.args[0], 'i64', ctx)})`, retTy: 'oi64' };
    }
    if (e.callee.nt !== 'Ident') throw new Unsupported('调用目标 ' + e.callee.nt);
    const entry = this.resolveEntry(ctx, e.callee.name);
    if (!entry || entry.kind !== 'fn') throw new Unsupported('调用 ' + e.callee.name);
    const idx = this.compiled.entryFnIdx?.get(entry);
    if (idx === undefined || !this.eligible.has(idx)) throw new Unsupported('被调方不 eligible: ' + e.callee.name);
    const sig = entry.sig;
    const args = e.args.map((ar, i) => {
      const pt = mingTyNum(sig.params[i]?.type);
      if (!pt) throw new Unsupported('参数类型 ' + i);
      const txt = this.emitExpr(ar, pt, ctx);
      // 值语义:mut Vec/Map 实参在调用边界深拷贝(同 wasm ming_copy_vec 边界)
      if (pt === 'vi64' && sig.params[i]?.mut) return `ming_vec_copy(${txt})`;
      if (pt === 'mi64' && sig.params[i]?.mut) return `ming_map_copy(${txt})`;
      return txt;
    });
    const retTy = sig.ret?.k === 'unit' ? null : mingTyNum(sig.ret);
    if (sig.ret?.k !== 'unit' && !retTy) throw new Unsupported('返回类型 ' + e.callee.name);
    return { call: `m${idx}(${args.join(', ')})`, retTy };
  }

  emitCallValue(e, ty, ctx) {
    const { call, retTy } = this.emitCallRef(e, ctx);
    if (retTy === null) throw new Unsupported('unit 返回值位置');
    if (retTy !== ty) throw new Unsupported('返回类型不符');
    return call;
  }

  // ---- 条件(语句位;C int 0/1)----
  emitCond(e, ctx) {
    switch (e.nt) {
      case 'BoolLit': return e.v ? '1' : '0';
      case 'Unary':
        if (e.op !== '!') throw new Unsupported('条件一元 ' + e.op);
        return `(!(${this.emitCond(e.expr, ctx)}))`;
      case 'Binary': {
        if (e.op === '&&' || e.op === '||') {
          return `(${this.emitCond(e.l, ctx)} ${e.op} ${this.emitCond(e.r, ctx)})`;
        }
        if (!['==', '!=', '<', '<=', '>', '>='].includes(e.op)) throw new Unsupported('条件 ' + e.op);
        const lt = this.inferTy(e.l, ctx);
        const rt = this.inferTy(e.r, ctx);
        if (!lt || !rt || lt !== rt) throw new Unsupported('条件两侧类型');
        if (lt === 'bool') return `(${this.emitExpr(e.l, 'bool', ctx)} ${e.op} ${this.emitExpr(e.r, 'bool', ctx)})`;
        if (lt === 'str') {
          if (e.op === '==' || e.op === '!=') {
            const t2 = `ming_str_eq(${this.emitExpr(e.l, 'str', ctx)}, ${this.emitExpr(e.r, 'str', ctx)})`;
            return e.op === '==' ? `(${t2})` : `(!(${t2}))`;
          }
          return `(ming_str_cmp(${this.emitExpr(e.l, 'str', ctx)}, ${this.emitExpr(e.r, 'str', ctx)}) ${e.op} 0)`;
        }
        return `(${this.emitExpr(e.l, lt, ctx)} ${e.op} ${this.emitExpr(e.r, rt, ctx)})`;
      }
      default: {
        // bool 型调用作条件(is_empty / contains 等)
        const t = this.inferTy(e, ctx);
        if (t === 'bool') return this.emitExpr(e, 'bool', ctx);
        throw new Unsupported('条件 ' + e.nt);
      }
    }
  }

  // ---- 语句 ----
  emitStmt(s, ctx) {
    switch (s.nt) {
      case 'Let': {
        if (!s.init || s.pat.nt !== 'PIdent') throw new Unsupported('let 形式');
        let ty;
        if (s.type) {
          ty = annoTy(s.type);
          if (!ty) throw new Unsupported('let 标注 ' + (s.type?.name ?? s.type?.k ?? '?') + '(C2 仅数值/str/Vec[i64])');
        } else {
          ty = this.inferTy(s.init, ctx);
          if (!ty || ty === 'bool') throw new Unsupported('let 推导 ' + ty);
        }
        const v = this.emitExpr(s.init, ty, ctx);
        const name = ctx.declare(s.pat.name, ty);
        // 值语义:Vec/Map 绑定即深拷贝(str 缓冲不可变,头部拷贝即可)
        const cpy = ty === 'vi64' ? `ming_vec_copy(${v})` : ty === 'mi64' ? `ming_map_copy(${v})` : v;
        ctx.line(`${CTYPE[ty]} ${name} = ${cpy};`);
        return;
      }
      case 'Assign': {
        // 下标赋值:v[i] = x / m[k] = v
        if (s.target.nt === 'Index' && s.op === '=' && s.target.base.nt === 'Ident') {
          const bt = ctx.typeOf(s.target.base.name);
          if (bt === 'vi64') {
            const base = ctx.nameOf(s.target.base.name);
            const idx = this.emitExpr(s.target.index, 'i64', ctx);
            const val = this.emitExpr(s.value, 'i64', ctx);
            ctx.line(`ming_vec_set(&${base}, ${idx}, ${val}, "${cstr(s.span?.file ?? '?')}", ${s.span?.line ?? 0}, ${s.span?.col ?? 0});`);
            return;
          }
          if (bt === 'mi64') {
            const base = ctx.nameOf(s.target.base.name);
            const k = this.emitExpr(s.target.index, 'str', ctx);
            const val = this.emitExpr(s.value, 'i64', ctx);
            ctx.line(`ming_map_set(&${base}, ${k}, ${val});`);
            return;
          }
          throw new Unsupported('下标赋值目标 ' + bt);
        }
        if (s.target.nt !== 'Ident') throw new Unsupported('赋值目标 ' + s.target.nt);
        const dst = ctx.nameOf(s.target.name);
        if (!dst) throw new Unsupported('赋值目标非局部');
        const dty = ctx.typeOf(s.target.name);
        if (s.op === '=') {
          const v = this.emitExpr(s.value, dty, ctx);
          const cpy = dty === 'vi64' ? `ming_vec_copy(${v})` : dty === 'mi64' ? `ming_map_copy(${v})` : v;
          ctx.line(`${dst} = ${cpy};`);
          return;
        }
        if (!['+=', '-=', '*=', '/=', '%=', '<<=', '>>='].includes(s.op)) throw new Unsupported('复合 ' + s.op);
        const op = s.op[0];
        if (dty === 'str') {
          if (op !== '+') throw new Unsupported('str 复合 ' + s.op);
          const b2 = this.emitExpr(s.value, 'str', ctx);
          ctx.line(`${dst} = ming_str_cat(${dst}, ${b2});`);
          return;
        }
        const b = this.emitExpr(s.value, dty, ctx);
        const bt = this.newTmp(ctx, dty);
        ctx.line(`${bt} = ${b};`);
        if (dty === 'f64') {
          ctx.line(`${dst} = ${dst} ${op} ${bt};`);
          return;
        }
        const t = this.newTmp(ctx, dty);
        if (dty === 'u64') this.emitCheckedU(op, dst, bt, t, s.span, ctx);
        else this.emitCheckedS(op, dst, bt, t, s.span, ctx);
        ctx.line(`${dst} = ${t};`);
        return;
      }
      case 'Return': {
        if (ctx.retTy === null) {
          if (s.value) throw new Unsupported('void 返回值');
          ctx.line('return;');
        } else {
          if (!s.value) throw new Unsupported('缺返回值');
          const v = this.emitExpr(s.value, ctx.retTy, ctx);
          ctx.line(`return ${v};`);
        }
        return;
      }
      case 'ExprStmt': {
        const ex = s.expr;
        if (ex.nt === 'Call') {
          if (ctx.isMain && ex.callee.nt === 'Ident' && ex.callee.name === 'print') {
            this.emitPrint(ex, ctx);
            return;
          }
          const { call, retTy } = this.emitCallRef(ex, ctx);
          ctx.line(retTy === null ? `${call};` : `(void)(${call});`);
          return;
        }
        if (ex.nt === 'If' || ex.nt === 'Loop') { this.emitStmt(ex, ctx); return; }
        throw new Unsupported('表达式语句 ' + ex.nt);
      }
      case 'If': {
        ctx.open(`if (${this.emitCond(s.cond, ctx)}) {`);
        this.emitBlock(s.then, ctx);
        ctx.close('}');
        if (s.els) {
          ctx.open('else {');
          if (s.els.nt === 'If') this.emitStmt(s.els, ctx);
          else this.emitBlock(s.els, ctx);
          ctx.close('}');
        }
        return;
      }
      case 'While': {
        ctx.open(`while (${this.emitCond(s.cond, ctx)}) {`);
        this.emitBlock(s.body, ctx);
        ctx.close('}');
        return;
      }
      case 'Loop': {
        ctx.open('for (;;) {');
        this.emitBlock(s.body, ctx);
        ctx.close('}');
        return;
      }
      case 'Break': ctx.line('break;'); return;
      case 'Continue': ctx.line('continue;'); return;
      case 'For': {
        // C1:区间 for;C2:Vec[i64] for-in;C3:Map[str,i64] for-in(PTuple(k,v),插入序)
        if (s.iter.nt !== 'Range' && s.iter.nt !== 'Ident') throw new Unsupported('for 迭代 ' + s.iter.nt);
        if (s.iter.nt === 'Ident') {
          const bt = ctx.typeOf(s.iter.name);
          if (bt === 'vi64') {
            if (s.pat.nt !== 'PIdent') throw new Unsupported('for 模式');
            const base = ctx.nameOf(s.iter.name);
            const lenT = this.newTmp(ctx, 'i64');
            ctx.line(`${lenT} = ${base}.n;`);
            ctx.open('{');
            const ivar = ctx.declare('__i' + s.pat.name, 'i64');
            ctx.open(`for (long long ${ivar} = 0; ${ivar} < ${lenT}; ${ivar}++) {`);
            const ev = ctx.declare(s.pat.name, 'i64');
            ctx.line(`long long ${ev} = ${base}.d[${ivar}];`);
            this.emitBlock(s.body, ctx);
            ctx.close('}');
            ctx.close('}');
            return;
          }
          if (bt === 'mi64') {
            if (s.pat.nt !== 'PTuple' || s.pat.pats.length !== 2) throw new Unsupported('map for-in 模式(须 (k, v))');
            const base = ctx.nameOf(s.iter.name);
            const lenT = this.newTmp(ctx, 'i64');
            ctx.line(`${lenT} = ${base}.n;`);
            ctx.open('{');
            const ivar = ctx.declare('__im' + s.pat.pats[0].name, 'i64');
            ctx.open(`for (long long ${ivar} = 0; ${ivar} < ${lenT}; ${ivar}++) {`);
            const kv = ctx.declare(s.pat.pats[0].name, 'str');
            ctx.line(`ming_str ${kv}; ${kv}.p = ${base}.d[${ivar}].k; ${kv}.n = ${base}.d[${ivar}].kn;`);
            const vv = ctx.declare(s.pat.pats[1].name, 'i64');
            ctx.line(`long long ${vv} = ${base}.d[${ivar}].v;`);
            this.emitBlock(s.body, ctx);
            ctx.close('}');
            ctx.close('}');
            return;
          }
          throw new Unsupported('for 容器 ' + bt);
        }
        if (this.inferTy(s.iter.lo, ctx) !== 'i64') throw new Unsupported('for 区间类型');
        // lo/hi 求值一次(Ming Range 语义);循环体可能突变来源变量
        const loV = this.newTmp(ctx, 'i64');
        ctx.line(`${loV} = ${this.emitExpr(s.iter.lo, 'i64', ctx)};`);
        const hiV = this.newTmp(ctx, 'i64');
        ctx.line(`${hiV} = ${this.emitExpr(s.iter.hi, 'i64', ctx)};`);
        ctx.open('{');
        const ivar = ctx.declare(s.pat.name, 'i64');
        ctx.open(`for (long long ${ivar} = ${loV}; ${ivar} < ${hiV}; ${ivar}++) {`);
        this.emitBlock(s.body, ctx);
        ctx.close('}');
        ctx.close('}');
        return;
      }
      default:
        throw new Unsupported('语句 ' + s.nt);
    }
  }

  emitBlock(block, ctx) {
    ctx.pushScope();
    for (const st of block.stmts) this.emitStmt(st, ctx);
    if (block.tail) throw new Unsupported('块尾表达式(语句位)');
    ctx.popScope();
  }

  // print:整数、str、f64(floatStr 对齐);插值/Vec/Map → C4
  emitPrint(e, ctx) {
    if (e.args.length !== 1) throw new Unsupported('print 参数数');
    const a = e.args[0];
    if (a.nt === 'StrLit') {
      if (!(a.parts.length === 1 && 'lit' in a.parts[0])) throw new Unsupported('print 插值串(C4)');
      const name = this.strLitName(a.parts[0].lit);
      const n = Buffer.byteLength(a.parts[0].lit, 'utf8');
      ctx.line(`printf("%.*s\\n", (int)${n}, ${name});`);
      return;
    }
    if (a.nt === 'Call' && a.callee.nt === 'Ident' && a.callee.name === 'str' && a.args.length === 1) {
      const it = this.inferTy(a.args[0], ctx);
      if (it === 'i64' || it === 'u64') {
        const v = this.emitExpr(a.args[0], it, ctx);
        ctx.line(`printf("${FMT[it]}\\n", ${v});`);
        return;
      }
      if (it === 'str') {
        const v = this.emitExpr(a.args[0], 'str', ctx);
        ctx.line(`printf("%.*s\\n", (int)${v}.n, ${v}.p);`);
        return;
      }
      if (it === 'f64') {
        const v = this.emitExpr(a.args[0], 'f64', ctx);
        ctx.line(`{ unsigned char __fb[340]; printf("%.*s\\n", (int)ming_float_str(${v}, __fb), __fb); }`);
        return;
      }
      throw new Unsupported('str(打印 ' + it + ')(Vec/Map 形态属 C4)@ 行 ' + (e.span?.line ?? '?'));
    }
    const t = this.inferTy(a, ctx);
    if (t === 'i64' || t === 'u64') {
      const v = this.emitExpr(a, t, ctx);
      ctx.line(`printf("${FMT[t]}\\n", ${v});`);
      return;
    }
    if (t === 'str') {
      const v = this.emitExpr(a, 'str', ctx);
      ctx.line(`printf("%.*s\\n", (int)${v}.n, ${v}.p);`);
      return;
    }
    if (t === 'f64') {
      const v = this.emitExpr(a, 'f64', ctx);
      ctx.line(`{ unsigned char __fb[340]; printf("%.*s\\n", (int)ming_float_str(${v}, __fb), __fb); }`);
      return;
    }
    throw new Unsupported('print ' + (t ?? a.nt) + '(Vec/Map 形态属 C4)');
  }

  // ---- 字面量收集(str → 全局静态字节数组;C 转义用八进制,避免 \x 的贪婪十六进制)----
  strLitName(text) {
    if (this.strLits.has(text)) return this.strLits.get(text);
    const name = `L${this.strLits.size}`;
    this.strLits.set(text, name);
    return name;
  }

  // ---- 常量定义(发射期收集;f64 用 17 位有效数字往返)----
  emitConstDefs() {
    const lines = [];
    for (const [name, ty] of this.usedConsts) {
      const c = this.resolveConst({ modFile: this.check.entry?.file }, name);
      if (!c) throw new Unsupported('常量 ' + name);
      if (ty === 'f64') lines.push(`static const double g_${name} = ${Number(c.v).toExponential(16)};`);
      else if (ty === 'u64') lines.push(`static const unsigned long long g_${name} = ${c.v}ULL;`);
      else if (ty === 'i64') lines.push(`static const long long g_${name} = ${c.v}LL;`);
      else if (ty === 'str') {
        const bytes = Buffer.from(c.v, 'utf8');
        const lname = this.strLitName(c.v);
        lines.push(`static const ming_str g_${name} = { ${lname}, ${bytes.length} };`);
      } else throw new Unsupported('常量类型 ' + ty);
    }
    return lines;
  }

  // str 字面量数组定义(发射期收集,顶层统一定义)
  emitStrLits() {
    const lines = [];
    for (const [text, name] of this.strLits) {
      const bytes = Buffer.from(text, 'utf8');
      let esc = '';
      for (const b of bytes) {
        if (b === 0x5c) esc += '\\\\';        // 反斜杠
        else if (b === 0x22) esc += '\\"';    // 双引号
        else if (b >= 0x20 && b <= 0x7e) esc += String.fromCharCode(b);
        else esc += '\\' + b.toString(8).padStart(3, '0');
      }
      lines.push(`static const unsigned char ${name}[] = "${esc}"; /* ${bytes.length} 字节 */`);
    }
    return lines;
  }

  // ---- 顶层 ----
  run() {
    // v0.39:eligible 为空也继续 —— 只有 main 的程序(main 本身带 io 不 eligible)
    // 只要 main 具备 AOT 形态就是合法的 C1 产物;main 形态不符由发射期报 Unsupported
    // v0.41(C3):sigExt2 = Map[str,i64] 与 Option[i64] 进入 C 面(全消费面)
    this.eligible = analyzeEligibility(this.check, this.compiled, { numericOnly: true, sigExt: true, sigExt2: true });
    const fns = this.compiled.functions;

    // main(entry 模块的 main;无参)
    const mainEntry = this.check.entry?.items.get('main');
    if (!mainEntry || mainEntry.kind !== 'fn') throw new Unsupported('缺少 main');
    const mainIdx = this.compiled.entryFnIdx?.get(mainEntry);
    const mainFn = mainIdx !== undefined ? fns[mainIdx] : null;
    if (!mainFn?.entry?.decl?.body) throw new Unsupported('main 无函数体');
    if (mainFn.entry.sig?.params?.length) throw new Unsupported('main 带参数(C1)');
    const mainRet = mainFn.entry.sig?.ret?.k === 'unit' ? null : mingTyNum(mainFn.entry.sig?.ret);
    if (mainFn.entry.sig?.ret?.k !== 'unit' && !mainRet) throw new Unsupported('main 返回类型');

    // eligible 函数体(发射失败 → 整体回落)
    const bodies = [];
    const order = [...this.eligible.keys()].sort((a, b) => a - b);
    for (const fi of order) {
      const f = fns[fi];
      const sig = f.entry.sig;
      const retTy = sig.ret?.k === 'unit' ? null : mingTyNum(sig.ret);
      if (sig.ret?.k !== 'unit' && !retTy) throw new Unsupported('返回类型 ' + f.name);
      const ctx = this.fnCtx(f.modFile, retTy, false);
      const params = sig.params.map((p, i) => {
        const pt = mingTyNum(p.type);
        if (!pt) throw new Unsupported('参数 ' + p.name);
        return `${CTYPE[pt]} ${ctx.declare(p.name, pt)}`;
      });
      ctx.open(`${retTy ? CTYPE[retTy] : 'void'} m${fi}(${params.join(', ')}) {`);
      this.emitBlock(f.entry.decl.body, ctx);
      // 检查器保证必然 return;此处为 C 需要的防御零值
      if (retTy) {
        ctx.line(retTy === 'str' ? 'return (ming_str){0, 0};'
          : retTy === 'vi64' ? 'return (ming_vec){0, 0, 0};'
          : 'return 0;');
      }
      ctx.close('}');
      bodies.push(ctx.lines.join('\n'));
    }

    // main AOT 形态
    const mctx = this.fnCtx(this.check.entry?.file, mainRet, true);
    mctx.open(`${mainRet ? 'int' : 'void'} ming_main(void) {`);
    this.emitBlock(mainFn.entry.decl.body, mctx);
    if (mainRet) mctx.line('return 0;');
    mctx.close('}');
    const mainBody = mctx.lines.join('\n');

    // 汇编(原型先行,递归/互递归皆可)
    const decls = order.map((fi) => {
      const sig = fns[fi].entry.sig;
      const rt = sig.ret?.k === 'unit' ? 'void' : CTYPE[mingTyNum(sig.ret)];
      const ps = sig.params.map((p) => CTYPE[mingTyNum(p.type)]).join(', ');
      return `static ${rt} m${fi}(${ps});`;
    });
    const constDefs = this.emitConstDefs();
    const strLits = this.emitStrLits();
    const parts = [
      '/* 由 ming cc 生成(Ming C 后端 C2)— 请勿手改 */',
      '#include <stdio.h>',
      '#include <stdlib.h>',
      '#include <string.h>',
      '#include <limits.h>',
      '#include <math.h>',
      '#ifdef _WIN32',
      '#include <io.h>',
      '#include <fcntl.h>',
      '#endif',
      '',
      '/* ---- Ming C 运行时(C2:str + Vec[i64];分配不回收,与 wasm 线性内存同策略)---- */',
      'typedef struct { const unsigned char* p; long long n; } ming_str;',
      'typedef struct { long long* d; long long n; long long cap; } ming_vec;',
      'typedef struct { const unsigned char* k; long long kn; long long v; } ming_kv;',
      'typedef struct { ming_kv* d; long long n; long long cap; } ming_map;',
      'typedef struct { long long some; long long v; } ming_opt;',
      '',
      'static void* ming_alloc(size_t n) {',
      '    void* p = malloc(n ? n : 1);',
      '    if (!p) { fputs("ming: 内存分配失败\\n", stderr); exit(101); }',
      '    return p;',
      '}',
      '',
      'static ming_opt ming_opt_some(long long v) { ming_opt o; o.some = 1; o.v = v; return o; }',
      'static ming_opt ming_opt_none(void) { ming_opt o; o.some = 0; o.v = 0; return o; }',
      '',
      'static long long ming_f2i_sat(double x) {',
      '    /* as i64:向零截断 + 饱和(NaN → min;与 interp castValue 逐字对齐) */',
      '    if (x != x) return LLONG_MIN;',
      '    if (x >= 9223372036854775808.0) return LLONG_MAX;',
      '    if (x <= -9223372036854775808.0) return LLONG_MIN;',
      '    return (long long)x;',
      '}',
      '',
      'static unsigned long long ming_f2u_sat(double x) {',
      '    if (x != x) return 0ULL;',
      '    if (x >= 18446744073709551615.0) return 18446744073709551615ULL;',
      '    if (x <= 0.0) return 0ULL;',
      '    return (unsigned long long)x;',
      '}',
      '',
      'static ming_str ming_str_lit(const unsigned char* p, long long n) { ming_str s; s.p = p; s.n = n; return s; }',
      '',
      'static ming_str ming_str_cat(ming_str a, ming_str b) {',
      '    unsigned char* d = (unsigned char*)ming_alloc((size_t)(a.n + b.n));',
      '    if (a.n) memcpy(d, a.p, (size_t)a.n);',
      '    if (b.n) memcpy(d + a.n, b.p, (size_t)b.n);',
      '    ming_str s; s.p = d; s.n = a.n + b.n; return s;',
      '}',
      '',
      'static long long ming_str_eq(ming_str a, ming_str b) {',
      '    return (a.n == b.n) && (a.n == 0 || memcmp(a.p, b.p, (size_t)a.n) == 0);',
      '}',
      '',
      'static long long ming_str_cmp(ming_str a, ming_str b) {',
      '    long long n = a.n < b.n ? a.n : b.n;',
      '    for (long long i = 0; i < n; i++) { if (a.p[i] != b.p[i]) return a.p[i] < b.p[i] ? -1 : 1; }',
      '    return a.n < b.n ? -1 : (a.n > b.n ? 1 : 0);',
      '}',
      '',
      'static long long ming_str_chars(ming_str s) {',
      '    long long c = 0, i = 0;',
      '    while (i < s.n) { unsigned char b = s.p[i]; i += (b < 0x80) ? 1 : ((b & 0xE0) == 0xC0) ? 2 : ((b & 0xF0) == 0xE0) ? 3 : 4; c++; }',
      '    return c;',
      '}',
      '',
      'static long long ming_str_contains(ming_str a, ming_str b) {',
      '    if (b.n == 0) return 1;',
      '    for (long long i = 0; i + b.n <= a.n; i++) {',
      '        long long j = 0;',
      '        while (j < b.n && a.p[i + j] == b.p[j]) j++;',
      '        if (j == b.n) return 1;',
      '    }',
      '    return 0;',
      '}',
      '',
      'static ming_str ming_str_replace(ming_str a, ming_str from, ming_str to) {',
      '    if (from.n == 0) return a;',
      '    long long cnt = 0, i = 0;',
      '    while (i + from.n <= a.n) {',
      '        long long j = 0;',
      '        while (j < from.n && a.p[i + j] == from.p[j]) j++;',
      '        if (j == from.n) { cnt++; i += from.n; } else i++;',
      '    }',
      '    if (cnt == 0) return a;',
      '    unsigned char* d = (unsigned char*)ming_alloc((size_t)(a.n + cnt * (to.n > from.n ? to.n - from.n : 0)) + 1);',
      '    long long w = 0; i = 0;',
      '    while (i < a.n) {',
      '        long long j = 0;',
      '        while (j < from.n && i + j < a.n && a.p[i + j] == from.p[j]) j++;',
      '        if (j == from.n) { if (to.n) memcpy(d + w, to.p, (size_t)to.n); w += to.n; i += from.n; }',
      '        else d[w++] = a.p[i++];',
      '    }',
      '    ming_str s; s.p = d; s.n = w; return s;',
      '}',
      '',
      'static ming_str ming_str_slice(ming_str a, long long from, long long to, const char* f, int l, int c) {',
      '    /* slice_chars:码点索引 [from, to),越界 → M4003(与 interp 逐字对齐) */',
      '    long long chars = ming_str_chars(a);',
      '    if (from < 0 || to < from || to > chars) {',
      '        fprintf(stderr, "%s:%d:%d: error M4003[index-out-of-bounds]: slice_chars 越界:请求 [%lld, %lld),字符数 %lld\\n", f, l, c, from, to, chars);',
      '        exit(101);',
      '    }',
      '    long long bi = 0, bo = 0, ci = 0;',
      '    long long sb = -1, eb = -1;',
      '    while (bi < a.n) {',
      '        if (ci == from) sb = bi;',
      '        if (ci == to) { eb = bi; break; }',
      '        unsigned char b = a.p[bi];',
      '        bi += (b < 0x80) ? 1 : ((b & 0xE0) == 0xC0) ? 2 : ((b & 0xF0) == 0xE0) ? 3 : 4;',
      '        ci++;',
      '    }',
      '    if (sb < 0) sb = a.n;',
      '    if (eb < 0) eb = a.n;',
      '    ming_str s; s.p = a.p + sb; s.n = eb - sb; return s;',
      '}',
      '',
      'static ming_str ming_str_pad_left(ming_str a, long long n) {',
      '    if (a.n >= n) return a;',
      '    unsigned char* d = (unsigned char*)ming_alloc((size_t)n + 1);',
      '    long long pad = n - a.n;',
      '    memset(d, 0x20, (size_t)pad);',
      '    if (a.n) memcpy(d + pad, a.p, (size_t)a.n);',
      '    ming_str s; s.p = d; s.n = n; return s;',
      '}',
      '',
      'static ming_str ming_str_pad_right(ming_str a, long long n) {',
      '    if (a.n >= n) return a;',
      '    unsigned char* d = (unsigned char*)ming_alloc((size_t)n + 1);',
      '    if (a.n) memcpy(d, a.p, (size_t)a.n);',
      '    memset(d + a.n, 0x20, (size_t)(n - a.n));',
      '    ming_str s; s.p = d; s.n = n; return s;',
      '}',
      '',
      'static ming_vec ming_vec_lit(const long long* src, long long n) {',
      '    ming_vec v; v.n = n; v.cap = n > 4 ? n : 4;',
      '    v.d = (long long*)ming_alloc((size_t)v.cap * sizeof(long long));',
      '    if (n) memcpy(v.d, src, (size_t)n * sizeof(long long));',
      '    return v;',
      '}',
      '',
      'static ming_vec ming_vec_copy(ming_vec v) {',
      '    /* 值语义:赋值/传参深拷贝 */',
      '    ming_vec c; c.n = v.n; c.cap = v.n > 4 ? v.n : 4;',
      '    c.d = (long long*)ming_alloc((size_t)c.cap * sizeof(long long));',
      '    if (v.n) memcpy(c.d, v.d, (size_t)v.n * sizeof(long long));',
      '    return c;',
      '}',
      '',
      'static void ming_vec_push(ming_vec* v, long long x) {',
      '    if (v->n == v->cap) {',
      '        long long nc = v->cap < 4 ? 4 : v->cap * 2;',
      '        long long* nd = (long long*)ming_alloc((size_t)nc * sizeof(long long));',
      '        if (v->n) memcpy(nd, v->d, (size_t)v->n * sizeof(long long));',
      '        v->d = nd; v->cap = nc;',
      '    }',
      '    v->d[v->n] = x; v->n++;',
      '}',
      '',
      'static long long ming_vec_get(ming_vec v, long long i, const char* f, int l, int c) {',
      '    if (i < 0 || i >= v.n) {',
      '        fprintf(stderr, "%s:%d:%d: error M4003[index-out-of-bounds]: 索引越界:长度 %lld,访问 %lld(用 .get(i) 返回 Option)\\n", f, l, c, v.n, i);',
      '        exit(101);',
      '    }',
      '    return v.d[i];',
      '}',
      '',
      'static void ming_vec_set(ming_vec* v, long long i, long long x, const char* f, int l, int c) {',
      '    if (i < 0 || i >= v->n) {',
      '        fprintf(stderr, "%s:%d:%d: error M4003[index-out-of-bounds]: 索引越界:长度 %lld,访问 %lld(用 .get(i) 返回 Option)\\n", f, l, c, v->n, i);',
      '        exit(101);',
      '    }',
      '    v->d[i] = x;',
      '}',
      '',
      'static void ming_vec_reverse(ming_vec* v) {',
      '    for (long long i = 0, j = v->n - 1; i < j; i++, j--) { long long t = v->d[i]; v->d[i] = v->d[j]; v->d[j] = t; }',
      '}',
      '',
      'static long long ming_vec_contains(ming_vec v, long long x) {',
      '    for (long long i = 0; i < v.n; i++) { if (v.d[i] == x) return 1; }',
      '    return 0;',
      '}',
      '',
      'static ming_opt ming_vec_pop(ming_vec* v) {',
      '    if (v->n == 0) return ming_opt_none();',
      '    return ming_opt_some(v->d[--v->n]);',
      '}',
      '',
      'static ming_opt ming_vec_get_opt(ming_vec v, long long i) {',
      '    if (i < 0 || i >= v.n) return ming_opt_none();',
      '    return ming_opt_some(v.d[i]);',
      '}',
      '',
      '/* ---- C3:Map[str,i64](插入序线性表)/ Option[i64] / floatStr 对齐 ---- */',
      'static ming_map ming_map_lit(ming_kv* src, long long n) {',
      '    ming_map m; m.n = n; m.cap = n > 4 ? n : 4;',
      '    m.d = (ming_kv*)ming_alloc((size_t)m.cap * sizeof(ming_kv));',
      '    if (n) memcpy(m.d, src, (size_t)n * sizeof(ming_kv));',
      '    return m;',
      '}',
      '',
      'static ming_map ming_map_copy(ming_map m) {',
      '    /* 值语义:赋值/传参深拷贝 */',
      '    ming_map c; c.n = m.n; c.cap = m.n > 4 ? m.n : 4;',
      '    c.d = (ming_kv*)ming_alloc((size_t)c.cap * sizeof(ming_kv));',
      '    if (m.n) memcpy(c.d, m.d, (size_t)m.n * sizeof(ming_kv));',
      '    return c;',
      '}',
      '',
      'static void ming_map_set(ming_map* m, ming_str k, long long v) {',
      '    /* 插入序保持:已有键原位更新,否则追加 */',
      '    for (long long i = 0; i < m->n; i++) {',
      '        if (m->d[i].kn == k.n && (k.n == 0 || memcmp(m->d[i].k, k.p, (size_t)k.n) == 0)) { m->d[i].v = v; return; }',
      '    }',
      '    if (m->n == m->cap) {',
      '        long long nc = m->cap < 4 ? 4 : m->cap * 2;',
      '        ming_kv* nd = (ming_kv*)ming_alloc((size_t)nc * sizeof(ming_kv));',
      '        if (m->n) memcpy(nd, m->d, (size_t)m->n * sizeof(ming_kv));',
      '        m->d = nd; m->cap = nc;',
      '    }',
      '    m->d[m->n].k = k.p; m->d[m->n].kn = k.n; m->d[m->n].v = v; m->n++;',
      '}',
      '',
      'static long long ming_map_find(ming_map m, ming_str k) {',
      '    for (long long i = 0; i < m.n; i++) {',
      '        if (m.d[i].kn == k.n && (k.n == 0 || memcmp(m.d[i].k, k.p, (size_t)k.n) == 0)) return i;',
      '    }',
      '    return -1;',
      '}',
      '',
      'static ming_opt ming_map_get(ming_map m, ming_str k) {',
      '    ming_opt o; o.some = 0; o.v = 0;',
      '    long long i = ming_map_find(m, k);',
      '    if (i >= 0) { o.some = 1; o.v = m.d[i].v; }',
      '    return o;',
      '}',
      '',
      'static long long ming_map_index(ming_map m, ming_str k, const char* f, int l, int c) {',
      '    /* m[k] 读:缺键 → M4007(消息与引擎逐字对齐,键经 debugStr 引号) */',
      '    long long i = ming_map_find(m, k);',
      '    if (i < 0) {',
      '        fprintf(stderr, "%s:%d:%d: error M4007[missing-key]: map 中不存在键 \\"%.*s\\"(用 .get(k) 返回 Option)\\n", f, l, c, (int)k.n, k.p);',
      '        exit(101);',
      '    }',
      '    return m.d[i].v;',
      '}',
      '',
      'static long long ming_map_delete(ming_map* m, ming_str k) {',
      '    long long i = ming_map_find(*m, k);',
      '    if (i < 0) return 0;',
      '    for (long long j = i; j < m->n - 1; j++) m->d[j] = m->d[j + 1];',
      '    m->n--;',
      '    return 1;',
      '}',
      '',
      'static long long ming_opt_unwrap(ming_opt o, const char* f, int l, int c) {',
      '    if (!o.some) {',
      '        fprintf(stderr, "%s:%d:%d: error M4006[unwrap-failed]: 对 None 调用 unwrap()\\n", f, l, c);',
      '        exit(101);',
      '    }',
      '    return o.v;',
      '}',
      '',
      '/* ---- floatStr 对齐(interp floatStr 语义)+ JS Number::toString 格式化 ---- */',
      'static long long ming_float_str(double x, unsigned char* out) {',
      '    if (x != x) { memcpy(out, "NaN", 3); return 3; }',
      '    if (x > 1.7976931348623157e308 || (x == 0.0 && 1.0 / x < 0)) { }',
      '    if (x == INFINITY) { memcpy(out, "Infinity", 8); return 8; }',
      '    if (x == -INFINITY) { memcpy(out, "-Infinity", 9); return 9; }',
      '    long long w = 0;',
      '    if (x < 0) { out[w++] = (unsigned char)\'-\'; x = -x; }',
      '    if (x == floor(x) && x < 1e21) {',
      '        /* toFixed(1):平局取较大者(与 JS toFixed 一致);-0 已在符号层归零 */',
      '        long long n = (long long)(x * 10.0 + 0.5);',
      '        w += sprintf((char*)out + w, "%lld.0", n / 10);',
      '        return w;',
      '    }',
      '    char tmp[64];',
      '    int p;',
      '    for (p = 1; p <= 17; p++) {',
      '        snprintf(tmp, sizeof tmp, "%.*e", p - 1, x);',
      '        if (strtod(tmp, 0) == x) break;',
      '    }',
      '    if (p > 17) { p = 17; snprintf(tmp, sizeof tmp, "%.16e", x); }',
      '    char digits[24]; int nd = 0, e10 = 0;',
      '    digits[nd++] = tmp[0];',
      '    for (int i = 1; tmp[i] != \'e\' && i < 32; i++) { if (tmp[i] != \'.\') digits[nd++] = tmp[i]; }',
      '    e10 = atoi(strchr(tmp, \'e\') + 1);',
      '    if (e10 >= 21 || e10 <= -7) {',
      '        /* JS 指数形式:d[.ddd]e±X */',
      '        out[w++] = (unsigned char)digits[0];',
      '        if (nd > 1) { out[w++] = (unsigned char)\'.\'; memcpy(out + w, digits + 1, (size_t)(nd - 1)); w += nd - 1; }',
      '        w += sprintf((char*)out + w, "e%+d", e10);',
      '    } else if (e10 >= 0) {',
      '        long long keep = e10 + 1;',
      '        if (nd > keep) { memcpy(out + w, digits, (size_t)keep); w += keep; out[w++] = (unsigned char)\'.\'; memcpy(out + w, digits + keep, (size_t)(nd - keep)); w += nd - keep; }',
      '        else { memcpy(out + w, digits, (size_t)nd); w += nd; for (int i = 0; i < keep - nd; i++) out[w++] = (unsigned char)\'0\'; }',
      '    } else {',
      '        out[w++] = (unsigned char)\'0\'; out[w++] = (unsigned char)\'.\';',
      '        for (int i = 0; i < -e10 - 1; i++) out[w++] = (unsigned char)\'0\';',
      '        memcpy(out + w, digits, (size_t)nd); w += nd;',
      '    }',
      '    return w;',
      '}',
      '',
      'static long long ming_is_js_ws(const unsigned char* p, long long n, long long i) {',
      '    /* JS trim 的空白集(UTF-8 码点) */',
      '    unsigned char b = p[i];',
      '    if (b == 0x09 || b == 0x0a || b == 0x0b || b == 0x0c || b == 0x0d || b == 0x20) return 1;',
      '    if (b == 0xc2 && i + 1 < n && p[i + 1] == 0xa0) return 2;           /* U+00A0 */',
      '    if (b == 0xe1 && i + 2 < n && p[i + 1] == 0x9a && p[i + 2] == 0x80) return 3; /* U+1680 */',
      '    if (b == 0xe2 && i + 2 < n) {',
      '        if (p[i + 1] == 0x80 && p[i + 2] >= 0x80 && p[i + 2] <= 0x8a) return 3; /* U+2000-200A */',
      '        if (p[i + 1] == 0x80 && (p[i + 2] == 0xa8 || p[i + 2] == 0xa9)) return 3; /* U+2028/9 */',
      '        if (p[i + 1] == 0x80 && p[i + 2] == 0xaf) return 3;             /* U+202F */',
      '        if (p[i + 1] == 0x81 && p[i + 2] == 0x9f) return 3;             /* U+205F */',
      '        if (p[i + 1] == 0x80 && p[i + 2] == 0x80) return 3;             /* U+3000 */',
      '        if (p[i + 1] == 0x80 && p[i + 2] == 0x8b) return 2;             /* U+200B ZWSP */',
      '    }',
      '    if (b == 0xef && i + 2 < n && p[i + 1] == 0xbb && p[i + 2] == 0xbf) return 3; /* U+FEFF */',
      '    return 0;',
      '}',
      '',
      'static ming_str ming_str_trim_impl(ming_str a, int left, int right) {',
      '    long long s = 0, e = a.n;',
      '    if (left) { while (s < e) { long long w = ming_is_js_ws(a.p, a.n, s); if (!w) break; s += w; } }',
      '    if (right) { while (e > s) { long long w = 0;',
      '        /* 反向:检查以 e 结尾的码点宽度 */',
      '        for (long long b = e - 1; b >= s && b >= e - 4; b--) {',
      '            long long r = ming_is_js_ws(a.p, a.n, b);',
      '            if (r && b + r == e) { w = r; break; }',
      '        }',
      '        if (!w) break; e -= w; } }',
      '    ming_str r; r.p = a.p + s; r.n = e - s; return r;',
      '}',
      '',
      'static long long ming_str_starts(ming_str a, ming_str b) {',
      '    return a.n >= b.n && (b.n == 0 || memcmp(a.p, b.p, (size_t)b.n) == 0);',
      '}',
      '',
      'static long long ming_str_ends(ming_str a, ming_str b) {',
      '    return a.n >= b.n && (b.n == 0 || memcmp(a.p + a.n - b.n, b.p, (size_t)b.n) == 0);',
      '}',
      '',
      'static void ming_panic(const char *text) {',
      '    fputs(text, stderr);',
      '    exit(101);',
      '}',
      '',
      'static long long ming_neg_i64(long long a, const char *f, int l, int c) {',
      '    if (a == LLONG_MIN) {',
      '        fprintf(stderr, "%s:%d:%d: error M4002[integer-overflow]: 整数取负溢出:-%lld 超出范围\\n", f, l, c, a);',
      '        exit(101);',
      '    }',
      '    return -a;',
      '}',
      '',
      ...strLits,
      ...(strLits.length ? [''] : []),
      ...constDefs,
      ...(constDefs.length ? [''] : []),
      ...decls,
      '',
      ...bodies.flatMap(b => [b, '']),
      mainBody,
      '',
      'int main(void) {',
      '    /* v0.39:关闭 CRLF 翻译,stdout/stderr 与 Ming 引擎逐字节一致 */',
      '#ifdef _WIN32',
      '    _setmode(_fileno(stdout), _O_BINARY);',
      '    _setmode(_fileno(stderr), _O_BINARY);',
      '#endif',
      '    ming_main();',
      '    return 0;',
      '}',
      '',
    ];
    return { code: parts.join('\n'), eligible: this.eligible };
  }

  fnCtx(modFile, retTy, isMain) {
    const ctx = {
      modFile,
      isMain,
      specific: isMain, // main 用 binopValues 具体消息;函数内用 wasm 层通用消息
      scopes: [new Map()],
      retTy,
      lines: [],
      indent: 1,
      line(t) { ctx.lines.push('    '.repeat(ctx.indent) + t); },
      open(t) { ctx.line(t); ctx.indent++; },
      close(t) { ctx.indent--; ctx.line(t); },
      pushScope() { ctx.scopes.push(new Map()); },
      popScope() { ctx.scopes.pop(); },
      scopeHas(n) {
        for (let i = ctx.scopes.length - 1; i >= 0; i--) if (ctx.scopes[i].has(n)) return true;
        return false;
      },
      nameOf(n) {
        for (let i = ctx.scopes.length - 1; i >= 0; i--) {
          if (ctx.scopes[i].has(n)) return ctx.scopes[i].get(n).cname;
        }
        return null;
      },
      typeOf(n) {
        for (let i = ctx.scopes.length - 1; i >= 0; i--) {
          if (ctx.scopes[i].has(n)) return ctx.scopes[i].get(n).ty;
        }
        return null;
      },
      declare(n, ty) {
        // 同名重声明/关键字冲突都安全:统一 v_ 前缀 + 作用域内去重
        const scope = ctx.scopes[ctx.scopes.length - 1];
        const base = 'v_' + String(n).replace(/[^A-Za-z0-9_]/g, '_');
        let cname = base;
        let k = 2;
        while ([...scope.values()].some(v => v.cname === cname)) cname = base + '_' + k++;
        scope.set(n, { cname, ty });
        return cname;
      },
    };
    return ctx;
  }
}

export function tryEmitC(check, compiled) {
  try {
    return new CEmit(check, compiled).run();
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

// 抛错版(CLI 用:需要 Unsupported 的具体原因作为诊断消息)
export function emitC(check, compiled) {
  return new CEmit(check, compiled).run();
}
