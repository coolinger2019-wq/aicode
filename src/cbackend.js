// src/cbackend.js — C 后端 C1(v0.39):eligible 数值函数 → C(GCC/Clang -O2)
//
// 资格分析直接复用 wasm 层(analyzeEligibility numericOnly = i64/u64/f64 签名,
// design.md §6.8 "零新判定逻辑")。映射:
//   i64 → long long / u64 → unsigned long long / f64 → double
//   checked 运算 → __builtin_add/sub/mul_overflow;除/模/移位显式守卫
//   panic → ming_panic(发射期嵌入的完整诊断首行)+ exit(101)
//
// panic 消息逐点对齐:
//   M4002(溢出/移位) = 四引擎统一(v0.81 N-65.4 架构师收口:main 与 eligible 函数同模板,
//     与 tree/VM/wasm 逐字,含操作数值,如 "整数+溢出:a + b 超出 i64 范围";除法溢出为
//     tree 专属模板 "整数除法溢出:a / b")
//   M4004(除零/取模零) = main 内具体消息(含操作数)/ eligible 函数内泛化(同族登记不预支)
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

const CTYPE = { i64: 'long long', u64: 'unsigned long long', f64: 'double', bool: 'long long', str: 'ming_str', vi64: 'ming_vec', mi64: 'ming_map', oi64: 'ming_opt', ri64: 'ming_res', pu8: 'unsigned char*', pcu8: 'const unsigned char*' }; // v0.54/C5:bool 局部 + Ptr[mut u8]/Ptr[u8]
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
  if (t.k === 'res' && t.ok?.k === 'int' && t.ok?.bits === 64 && t.ok?.signed && t.err?.k === 'str') return 'ri64';
  // v0.54/C5:Ptr[mut u8] → unsigned char*;Ptr[u8] → const unsigned char*
  if (t.k === 'ptr' && t.el?.k === 'int' && t.el.bits === 8 && t.el.signed === false) return t.mut ? 'pu8' : 'pcu8';
  // v0.61/M1(审查修复):Untrusted 运行时擦除——已解析形状(checker sig 层 mkUntrusted)按载体判定
  // (extern 返回/ffi 槽位签名/普通函数返回;载体非 str 时返回 null,沿用既有 Unsupported 拒绝)。
  if (t.k === 'untrusted') return mingTyNum(t.el);
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
    // v0.61/M1(审查修复):Untrusted 是运行时擦除的载体包装——穿透到载体,检查同载体既有规则
    // (Untrusted[str] 的 let 标注/as 目标按 str 走;载体面非 str 时 annoTarget 返回 null,沿用既有拒绝)。
    if (n === 'Untrusted' && t.args?.length === 1) return annoTarget(t.args[0]);
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
    if ((n === 'Result') && t.args?.length === 2) {
      const ok = annoTarget(t.args[0]);
      const er = annoTarget(t.args[1]);
      if (ok?.k === 'int' && ok.bits === 64 && ok.signed && er?.k === 'str') return { k: 'res' };
      return null;
    }
    // v0.54/C5:Ptr[mut u8] / Ptr[u8](元素仅 u8;mut 由 TMut 包装)
    if ((n === 'Ptr') && t.args?.length === 1) {
      let arg = t.args[0];
      let mut = false;
      if (arg?.nt === 'TMut') { mut = true; arg = arg.type; }
      const el = annoTarget(arg);
      if (el?.k === 'int' && el.bits === 8 && el.signed === false) return { k: 'ptr', mut };
      return null;
    }
    return ANNO_PRIM[n] ?? null;
  }
  if (t.k === 'int' || t.k === 'float') return { k: t.k, bits: t.bits, signed: !!t.signed };
  if (t.k === 'str') return { k: 'str' };
  if (t.k === 'vec') return { k: 'vec', el: t.el };
  if (t.k === 'ptr') return { k: 'ptr', mut: !!t.mut }; // v0.54/C5
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
  if (a.k === 'res') return 'ri64';
  if (a.k === 'ptr') return a.mut ? 'pu8' : 'pcu8'; // v0.54/C5
  return mingTyNum(a);
}

// ---------- 发射器 ----------

class CEmit {
  constructor(check, compiled, opts = {}) {
    this.check = check;
    this.compiled = compiled;
    this.opts = opts; // v0.54/C5:unsafe = C 专用资格扩展(由 ming cc 路径传入)
    this.modulesByFile = new Map(check.modules.map(m => [m.file, m]));
    this.usedConsts = new Map(); // const 名 → 'i64'|'u64'|'f64'|'str'(发射期收集,顶部统一定义)
    this.strLits = new Map();    // str 字面量 → 全局数组名
    this.usesMemAlloc = false;   // v0.54/C5:仅在使用 std.mem.alloc 时发射 malloc 失败助手
    this.tmpSeq = 0;
  }

  newTmp(ctx, ty, init) {
    const name = `__t${++this.tmpSeq}`;
    ctx.line(init !== undefined ? `${CTYPE[ty]} ${name} = ${init};` : `${CTYPE[ty]} ${name};`);
    return name;
  }

  // v1.2.2(#90,plan §5.1):实参求值序。C 标准不规定函数实参求值顺序——本机 gcc x86-64
  // 实测右→左,两个实参都 panic 时 cc 的首条 panic 行与 tree/VM(源码序左→右)相反
  // (退出码同为 101,违反 AGENTS §9 "panic 逐字对齐"口径)。修法 = 每个实参先按源码顺序
  // 物化为临时(类型取发射点既有 ty,不猜类型),调用文本只引用临时:物化是独立语句,
  // 语句间的先后由 C 块序确定 → 求值序跨编译器稳定。
  // 单实参调用同样走此路径(机制统一;无顺序歧义时仅多一条声明,语义不变)。
  emitArgTmp(arg, ty, ctx) {
    return this.newTmp(ctx, ty, this.emitExpr(arg, ty, ctx));
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
        // v0.54/C5:std.mem.alloc → Ptr[mut u8];free → unit(值位置无类型)
        const memFn = this.memNameOf(e.callee, ctx);
        if (memFn === 'alloc') return 'pu8';
        if (memFn === 'free') return null;
        if (e.callee.nt === 'Field') {
          // 方法调用类型推断(C2 方法面;base 可为任意 str/Vec[i64] 表达式)
          const m = e.callee.name;
          let bt = null;
          if (e.callee.base.nt === 'Ident' && ctx.nameOf(e.callee.base.name)) bt = ctx.typeOf(e.callee.base.name);
          else bt = this.inferTy(e.callee.base, ctx);
          // v0.54/C5:Ptr 方法(load → i64 载体(值语义 u8 提升);offset 保持 mut 性)
          if (bt === 'pu8' || bt === 'pcu8') {
            if (m === 'load') return 'i64';
            if (m === 'is_null') return 'bool';
            if (m === 'offset') return bt;
            return null; // store → unit
          }
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
          if (bt === 'ri64') {
            if (m === 'is_ok' || m === 'is_err') return 'bool';
            if (m === 'unwrap' || m === 'unwrap_or') return 'i64';
            if (m === 'unwrap_err') return 'str';
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
        // 裸枚举构造器:Option[i64] 的 Some/None 与 Result[i64,str] 的 Ok/Err(C3/C3.5)
        if (e.callee.name === 'Some' && e.args?.length === 1 && this.inferTy(e.args[0], ctx) === 'i64') return 'oi64';
        if (e.callee.name === 'None' && (!e.args || e.args.length === 0)) return 'oi64';
        if (e.callee.name === 'Ok' && e.args?.length === 1 && this.inferTy(e.args[0], ctx) === 'i64') return 'ri64';
        if (e.callee.name === 'Err' && e.args?.length === 1 && this.inferTy(e.args[0], ctx) === 'str') return 'ri64';
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

  // v0.54/C5:std.mem.alloc/free(std.mem.* 或 use std.mem [as 别名] 后的绑定.*;局部同名遮蔽时不识别)
  memNameOf(callee, ctx) {
    if (callee.nt !== 'Field') return null;
    if (callee.base.nt === 'Ident' && !ctx.scopeHas(callee.base.name)) {
      const imp = this.modulesByFile.get(ctx.modFile)?.imports?.get(callee.base.name);
      if (imp?.std === 'mem') return callee.name;
    }
    if (callee.base.nt === 'Field' && callee.base.base.nt === 'Ident' && callee.base.base.name === 'std'
      && callee.base.name === 'mem' && !ctx.scopeHas('std')) return callee.name;
    return null;
  }

  // ---- 表达式:返回 C 表达式文本;含检查的子式先把语句写进 ctx(三地址化)----
  emitExpr(e, ty, ctx) {
    switch (e.nt) {
      case 'IntLit': {
        if (ty !== 'i64' && ty !== 'u64') throw new Unsupported('int 字面量位置');
        if (e.bits !== 64) throw new Unsupported('非 64 位字面量');
        if (ty === 'u64' && e.v < 0n) throw new Unsupported('u64 负字面量');
        // v0.59 P1 审查 MINOR 6 回归修复(与 wasm 同口径):字面量超出位宽时
        // C 的十进制常量会隐式转 unsigned 再折返(9223372036854775808LL 实际是
        // LLONG_MIN),取负后语义与 tree/VM 不符。2^63 用于 -i64.min 特判;
        // 其余越界形态显式拒绝(C1 不支持,不再静默错值)。
        if (ty === 'i64') {
          if (e.v === 9223372036854775808n) return '(-9223372036854775807LL - 1LL)';
          if (e.v < -9223372036854775808n || e.v > 9223372036854775807n) throw new Unsupported('i64 字面量越界');
          return `${e.v}LL`;
        }
        if (e.v > 18446744073709551615n) throw new Unsupported('u64 字面量越界');
        return `${e.v}ULL`;
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
          const idx = this.emitArgTmp(e.index, 'i64', ctx); // #90:helper 实参按源码序物化
          return `ming_vec_get(${base}, ${idx}, "${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0})`;
        }
        if (bt === 'mi64') {
          if (ty !== 'i64') throw new Unsupported('下标结果位置 ' + ty);
          const base = ctx.nameOf(e.base.name);
          const k = this.emitArgTmp(e.index, 'str', ctx); // #90
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
        // v0.59 P1 审查 MINOR 6 回归修复:-(-9223372036854775808) 的操作数是 2^63
        // 字面量,取负恰为 i64.min;直接发 LLONG_MIN,不走 ming_neg_i64(其 MIN 守卫
        // 针对运行时值取负,会误判)。
        if (e.expr.nt === 'IntLit' && e.expr.bits === 64 && e.expr.v === 9223372036854775808n) {
          return 'LLONG_MIN';
        }
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

  // match 表达式(C2:整数字面量臂 + 通配 + 可选 guard → 顺序命中链;穷尽由检查器保证)
  // v1.2.1(#85):guard 必须惰性求值——旧实现把 guard 用 C && 拼进 else-if 文本,纯表达式
  // 可借 C 短路,但 guard 内的 checked 算术/&& 物化语句在构造期被提升到链外 → 未命中臂
  // (或前序臂已命中)的 guard 也会求值(panic 分歧)。改为 done 旗标顺序块:模式测试与
  // guard 的语句都落在对应条件块内,表达式只在双重命中时求值。
  emitMatch(e, ty, ctx) {
    const st = this.inferTy(e.scrutinee, ctx);
    if (st !== 'i64' && st !== 'u64') throw new Unsupported('match 宗量 ' + st + '(C2 仅整数)');
    const svT = this.newTmp(ctx, st);
    ctx.line(`${svT} = ${this.emitExpr(e.scrutinee, st, ctx)};`);
    const t = this.newTmp(ctx, ty === 'bool' ? 'i64' : ty);
    // 臂分类(2026-11-23 审查 MAJOR-1 修复):**全部臂按源序**参与 done 链——无 guard 通配
    // 是恒真臂(test=null),同样按源序发射;旧实现把无 guard 通配特判留到最后 → 通配之后
    // 的臂抢先命中(`match 5 { _ => 1, 5 => 2 }` cc 曾输出 2,tree/VM 输出 1 首臂语义)。
    // (AST 实测:PLit 的值在 pat.val(字符串数字);通配在解析后是 PIdent 无 name)
    const arms = [];
    for (const arm of e.arms) {
      const p = arm.pat;
      const isWild = p.nt === 'PWild' || (p.nt === 'PIdent' && (p.name === undefined || p.name === '_'));
      if (isWild && !arm.guard) { arms.push({ test: null, guard: null, expr: arm.expr }); continue; }
      let test = null;
      if (!isWild) {
        if (p.nt === 'PLit' && p.lit && typeof p.lit.val !== 'object') {
          const pv = BigInt(p.lit.val) * (p.neg ? -1n : 1n);
          test = `${svT} == ${pv}${CSUF[st]}`;
        } else {
          throw new Unsupported('match 模式(C2 仅整数字面量)');
        }
      }
      arms.push({ test, guard: arm.guard, expr: arm.expr });
    }
    const done = this.newTmp(ctx, 'i64', '0');
    for (const a of arms) {
      ctx.open(`if (!${done}) {`);
      if (a.test) ctx.open(`if (${a.test}) {`);
      if (a.guard) {
        const g = this.emitCond(a.guard, ctx);
        ctx.open(`if (${g}) {`);
      }
      ctx.line(`${t} = ${this.emitValue(a.expr, ty, ctx)};`);
      ctx.line(`${done} = 1;`);
      if (a.guard) ctx.close('}');
      if (a.test) ctx.close('}');
      ctx.close('}');
    }
    ctx.open(`if (!${done}) {`);
    // 检查器保证穷尽(含无 guard 通配臂,已按源序在链内);此分支与 VM 一致(内部错误 panic)。
    ctx.line('ming_panic("内部错误:match 未命中\\n");');
    ctx.line('exit(101);');
    ctx.close('}');
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
      // v1.2.1(#85):短路 RHS 惰性——文本 && 的 C 短路不救语句提升(见 emitLogical 头注)
      const t = this.emitLogical(e, ctx);
      return ty === 'bool' ? t : `((long long)(${t}))`;
    }
    if (['==', '!=', '<', '<=', '>', '>='].includes(op)) {
      const lt = this.inferTy(e.l, ctx);
      const rt = this.inferTy(e.r, ctx);
      if (!lt || !rt || lt !== rt) throw new Unsupported('比较两侧类型');
      let text;
      if (lt === 'str') {
        // str 比较:字节序(UTF-8 保序;与 JS 的 UTF-16 序仅在非 BMP 与 U+E000..U+FFFF 交叉处可能不同)
        // #90:helper 实参按源码序物化
        if (op === '==' || op === '!=') {
          const l = this.emitArgTmp(e.l, 'str', ctx);
          const r = this.emitArgTmp(e.r, 'str', ctx);
          text = `(ming_str_eq(${l}, ${r}))`;
        } else {
          const l = this.emitArgTmp(e.l, 'str', ctx);
          const r = this.emitArgTmp(e.r, 'str', ctx);
          text = `(ming_str_cmp(${l}, ${r}) ${op} 0)`;
        }
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
      // #90:ming_str_cat 实参按源码序物化
      const l = this.emitArgTmp(e.l, 'str', ctx);
      const r = this.emitArgTmp(e.r, 'str', ctx);
      return `ming_str_cat(${l}, ${r})`;
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
    // v1.2.4(#92,plan §5.1):checked 算术的操作数求值序/求值次数(根因表述经审查 MINOR-1 修正)。
    // `/ % << >>` 不走 __builtin_*_overflow 实参位,发射文本是「守卫语句 + 正式运算」多次
    // 引用操作数:守卫语句 `if (m1() == 0LL)` 只引用 RHS 且先于任何 LHS 引用——语句序
    // 确定地先求值 RHS(即使编译器同语句左→右也一样,这不是同语句 unspecified 序问题);
    // 两侧都 panic 时 cc 首行 = RHS,而 tree/VM(源码序左→右)= LHS,违反 AGENTS §9
    // panic 首行逐字口径;成功路径还把两侧表达式重求值(守卫 + 消息 + 正式运算,#91)。
    // 修法 = 与 v1.2.2 #90 同一哲学:按源码序把两侧物化为临时(独立声明语句,先后由 C
    // 块序确定),守卫/消息/正式运算只引用临时 → 每侧恰求值一次、跨编译器顺序稳定;
    // extern/ffi 操作数的副作用因此按源码序单次发生(此前守卫/消息位会被多次求值——
    // 该行为变化属本修复面,已入门槛断言)。消息模板打印的是值(FMT.i64/u64 = fprintf
    // 的 %lld/%llu 实参),换成临时名不改变任何消息文本(既有消息断言零校准)。
    // `+ - *` 走 __builtin_*_overflow 的实参位:C 标准未规定实参求值序(本机 gcc 实测
    // 左→右);一并物化,消除对该实现细节的依赖(#91 算术面)。
    const a = this.emitArgTmp(e.l, lt, ctx);
    const b = this.emitArgTmp(e.r, lt, ctx);
    const t = this.newTmp(ctx, lt);
    if (lt === 'u64') this.emitCheckedU(op, a, b, t, e.span, ctx);
    else this.emitCheckedS(op, a, b, t, e.span, ctx);
    return t;
  }

  // checked 运算发射。v0.81(N-65.4 架构师收口):M4002 消息四引擎统一——main 与 eligible
  // 函数同模板同逐字(tree/VM/wasm 单一事实 interp.js panicOverflow/intBinSlow);除法溢出
  // 用 tree 专属模板 `整数除法溢出:a / b`(无"超出范围"后缀,interp.js intBinSlow 除法
  // 分支口径——顺带修正 cc
  // main 的预存偏差)。v0.83(§4.13.4 P1.1):M4004(除零/取模零)同款收口——除零/取模零
  // 消息四引擎同模板(interp.js:386/392/423/429 口径),ctx.specific 门拆除(旗标废除)。
  emitCheckedS(op, a, b, dst, span, ctx) {
    const P = (msg) => this.emitPanicStmt('M4002', 'integer-overflow', msg, span, ctx);
    const PZ = (msg) => this.emitPanicStmt('M4004', 'division-by-zero', msg, span, ctx);
    const ovfMsg = { fmt: `整数${op}溢出:${FMT.i64} ${op} ${FMT.i64} 超出 i64 范围\\n`, args: `, ${a}, ${b}` };
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
        // v0.83(§4.13.4 P1.1):M4004 四引擎统一——除零/取模零消息 main/eligible 同模板
        // (原 ctx.specific 门拆除;与 tree/VM/wasm 逐字,interp.js:386/423 口径)
        PZ({ fmt: `整数除零:${FMT.i64} / 0\\n`, args: `, ${a}` });
        ctx.close('}');
        ctx.open(`if (${b} == -1LL && ${a} == LLONG_MIN) {`);
        // v0.81 N-65.4:除法溢出与 tree 同模板(整数除法溢出:a / b,无"超出范围"后缀)——
        // 旧实现走 ovfMsg 渲染为"整数/溢出:…超出 i64 范围",与 tree 预存分歧,此处一并修正
        P({ fmt: `整数除法溢出:${FMT.i64} / ${FMT.i64}\\n`, args: `, ${a}, ${b}` });
        ctx.close('}');
        ctx.line(`${dst} = ${a} / ${b};`);
        return;
      case '%':
        ctx.open(`if (${b} == 0LL) {`);
        // v0.83(§4.13.4 P1.1):取模零措辞修正为 tree 模板(interp.js:392/429 口径)——
        // eligible 侧原泛化输出"整数除零",连措辞都不同
        PZ({ fmt: `整数取模零:${FMT.i64} %% 0\\n`, args: `, ${a}` });
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
        P({ fmt: `移位位数 ${FMT.i64} 越界(必须在 0..63)\\n`, args: `, ${b}` });
        ctx.close('}');
        if (op === '<<') {
          // v0.59 P1 审查阻塞 1:C 的 `unsigned long long << b` 丢位静默回绕
          // (3LL << 62 → LLONG_MIN),tree/VM 报 M4002。操作数先落临时量
          // (单次求值),移位后算术右移回检 (r >> b) != a → M4002。
          // 消息口径 v0.81 N-65.4:main 与 eligible 同模板,与 tree 逐字。
          const av = this.newTmp(ctx, 'i64', a);
          const bv = this.newTmp(ctx, 'i64', b);
          ctx.line(`${dst} = (long long)((unsigned long long)${av} << ${bv});`);
          ctx.open(`if ((${dst} >> ${bv}) != ${av}) {`);
          P({ fmt: `整数<<溢出:${FMT.i64} << ${FMT.i64} 超出 i64 范围\\n`, args: `, ${av}, ${bv}` });
          ctx.close('}');
          return;
        }
        ctx.line(`${dst} = ${a} >> ${b};`); // gcc/clang:有符号右移 = 算术移位
        return;
      default:
        throw new Unsupported('i64 运算 ' + op);
    }
  }

  emitCheckedU(op, a, b, dst, span, ctx) {
    const P = (msg) => this.emitPanicStmt('M4002', 'integer-overflow', msg, span, ctx);
    const PZ = (msg) => this.emitPanicStmt('M4004', 'division-by-zero', msg, span, ctx);
    // v0.81 N-65.4:M4002 四引擎统一(main/eligible 同模板;见 emitCheckedS 头注)
    const ovfMsg = { fmt: `整数${op}溢出:${FMT.u64} ${op} ${FMT.u64} 超出 i64u 范围\\n`, args: `, ${a}, ${b}` };
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
        // v0.83(§4.13.4 P1.1):u64 除零同模板(main/eligible 同口径,无符号 display 与
        // tree 的 u64 display 一致)
        PZ({ fmt: `整数除零:${FMT.u64} / 0\\n`, args: `, ${a}` });
        ctx.close('}');
        ctx.line(`${dst} = ${a} / ${b};`);
        return;
      case '%':
        ctx.open(`if (${b} == 0ULL) {`);
        // v0.83(§4.13.4 P1.1):u64 取模零同模板(main/eligible 同口径)
        PZ({ fmt: `整数取模零:${FMT.u64} %% 0\\n`, args: `, ${a}` });
        ctx.close('}');
        ctx.line(`${dst} = ${a} % ${b};`);
        return;
      case '<<': case '>>':
        ctx.open(`if (${b} >= 64) {`);
        P({ fmt: `移位位数 ${FMT.u64} 越界(必须在 0..63)\\n`, args: `, ${b}` });
        ctx.close('}');
        if (op === '<<') {
          // v0.59 P1 审查阻塞 1(u64):丢位回绕静默错值;逻辑右移回检
          // (r >>u b) != a → M4002(v0.81 N-65.4:main/eligible 同模板,与 tree 逐字)。
          const av = this.newTmp(ctx, 'u64', a);
          const bv = this.newTmp(ctx, 'u64', b);
          ctx.line(`${dst} = ${av} << ${bv};`);
          ctx.open(`if ((${dst} >> ${bv}) != ${av}) {`);
          P({ fmt: `整数<<溢出:${FMT.u64} << ${FMT.u64} 超出 i64u 范围\\n`, args: `, ${av}, ${bv}` });
          ctx.close('}');
          return;
        }
        ctx.line(`${dst} = ${a} >> ${b};`);
        return;
      default:
        throw new Unsupported('u64 运算 ' + op);
    }
  }

  // panic 语句。msg:{fmt, args}(fprintf 动态值)或 null(静态文本 = wasm 层通用消息)
  emitPanicStmt(code, name, msg, span, ctx) {
    // v0.81 N-65.4:M4002 消息携带 msg 即动态发射(main/eligible 同口径);
    // v0.83 §4.13.4 P1.1:M4004 同款收口——除零/取模零全部调用点传 msg(四引擎逐字),
    // msg=null 静态路径现仅 M4002 兜底位可用(现行调用面已无 M4004 null 调用者)
    if (msg) {
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
      return `ming_sext((unsigned long long)(${x}), ${N})`;
    }
    if (srcTy === 'bool') return `((unsigned long long)(${x}))`;
    if (N === 64) return `(unsigned long long)(${x})`;
    return `((unsigned long long)(${x}) & 0x${((1n << BigInt(N)) - 1n).toString(16)}ULL)`;
  }

  // 调用:发射参数(语句),返回 { call, retTy }('i64'|'u64'|'f64'|null=unit)
  emitCallRef(e, ctx) {
    const mn = this.mathNameOf(e.callee, ctx);    if (mn) {
      if (!MATH_SAFE.has(mn)) throw new Unsupported('std.math ' + mn + '(JS/库位级一致性未证,C2)');
      const wantArity = (mn === 'min' || mn === 'max') ? 2 : 1;
      if (e.args.length !== wantArity) throw new Unsupported('math ' + mn + ' 参数数');
      const args = e.args.map(ar => this.emitArgTmp(ar, 'f64', ctx)); // #90:按源码序物化
      return { call: `${MATH_CNAME[mn]}(${args.join(', ')})`, retTy: 'f64' };
    }
    // v0.54/C5:std.mem.alloc/free(必须在 Field 方法分支之前:std.mem 不是局部值)
    const memFn = this.memNameOf(e.callee, ctx);
    if (memFn) {
      const SPm = `"${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0}`;
      if (memFn === 'alloc' && e.args.length === 1) {
        this.usesMemAlloc = true;
        const n = this.emitArgTmp(e.args[0], 'i64', ctx); // #90
        return { call: `ming_mem_alloc(${n}, ${SPm})`, retTy: 'pu8' };
      }
      if (memFn === 'free' && e.args.length === 1) {
        const at = this.inferTy(e.args[0], ctx);
        if (at !== 'pu8' && at !== 'pcu8') throw new Unsupported('std.mem.free 参数类型 ' + at);
        const p = this.emitArgTmp(e.args[0], at, ctx); // #90
        return { call: `free(${p})`, retTy: null };
      }
      throw new Unsupported('std.mem.' + memFn + '(C5 面:alloc/free)');
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
        if (bt === 'str' || bt === 'vi64' || bt === 'mi64' || bt === 'oi64' || bt === 'ri64' || bt === 'pu8' || bt === 'pcu8') {
          // 非 Ident base:求值一次入临时(方法体可能引用 baseText 两次,如 unwrap_or)
          const txt = this.emitExpr(e.callee.base, bt, ctx);
          baseText = this.newTmp(ctx, bt, txt);
        }
      }
      const SP = `"${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0}`;
      // v0.54/C5:Ptr 方法(load/store/offset/is_null);offset 保持 mut 性
      if (bt === 'pu8' || bt === 'pcu8') {
        if (m === 'load' && e.args.length === 0) return { call: `((long long)${baseText}[0])`, retTy: 'i64' };
        if (m === 'store' && e.args.length === 1) {
          if (bt === 'pcu8') throw new Unsupported('只读 Ptr 不能 store');
          const at = this.inferTy(e.args[0], ctx);
          const val = this.emitArgTmp(e.args[0], at === 'u64' ? 'u64' : 'i64', ctx); // #90
          return { call: `(${baseText}[0] = (unsigned char)(${val}))`, retTy: null };
        }
        if (m === 'offset' && e.args.length === 1) {
          const off = this.emitArgTmp(e.args[0], 'i64', ctx); // #90
          return { call: `(${baseText} + ${off})`, retTy: bt };
        }
        if (m === 'is_null' && e.args.length === 0) return { call: `(${baseText} == NULL)`, retTy: 'bool' };
        throw new Unsupported('Ptr.' + m + '(C5 面:load/store/offset/is_null)');
      }
      if (bt === 'str') {
        if (m === 'char_len' && e.args.length === 0) return { call: `ming_str_chars(${baseText})`, retTy: 'i64' };
        if (m === 'byte_len' && e.args.length === 0) return { call: `(${baseText}.n)`, retTy: 'i64' };
        if (m === 'is_empty' && e.args.length === 0) return { call: `(${baseText}.n == 0)`, retTy: 'bool' };
        if (m === 'contains' && e.args.length === 1) {
          const x = this.emitArgTmp(e.args[0], 'str', ctx);
          return { call: `ming_str_contains(${baseText}, ${x})`, retTy: 'bool' };
        }
        if (m === 'replace' && e.args.length === 2) {
          const from = this.emitArgTmp(e.args[0], 'str', ctx);
          const to = this.emitArgTmp(e.args[1], 'str', ctx);
          return { call: `ming_str_replace(${baseText}, ${from}, ${to})`, retTy: 'str' };
        }
        if (m === 'pad_left' && e.args.length === 1) {
          const n = this.emitArgTmp(e.args[0], 'i64', ctx);
          return { call: `ming_str_pad_left(${baseText}, ${n})`, retTy: 'str' };
        }
        if (m === 'pad_right' && e.args.length === 1) {
          const n = this.emitArgTmp(e.args[0], 'i64', ctx);
          return { call: `ming_str_pad_right(${baseText}, ${n})`, retTy: 'str' };
        }
        if (m === 'slice_chars' && e.args.length === 2) {
          const from = this.emitArgTmp(e.args[0], 'i64', ctx);
          const to = this.emitArgTmp(e.args[1], 'i64', ctx);
          return { call: `ming_str_slice(${baseText}, ${from}, ${to}, ${SP})`, retTy: 'str' };
        }
        if ((m === 'trim' || m === 'trim_start' || m === 'trim_end') && e.args.length === 0) {
          const mode = m === 'trim' ? '1, 1' : (m === 'trim_start' ? '1, 0' : '0, 1');
          return { call: `ming_str_trim_impl(${baseText}, ${mode})`, retTy: 'str' };
        }
        if (m === 'starts_with' && e.args.length === 1) {
          const x = this.emitArgTmp(e.args[0], 'str', ctx);
          return { call: `ming_str_starts(${baseText}, ${x})`, retTy: 'bool' };
        }
        if (m === 'ends_with' && e.args.length === 1) {
          const x = this.emitArgTmp(e.args[0], 'str', ctx);
          return { call: `ming_str_ends(${baseText}, ${x})`, retTy: 'bool' };
        }
        throw new Unsupported('str.' + m + '(C4:to_upper/to_lower/chars/split/parse_* 等)');
      }
      if (bt === 'vi64') {
        const gvSP = `"${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0}`;
        if (m === 'len' && e.args.length === 0) return { call: `(${baseText}.n)`, retTy: 'i64' };
        if (m === 'contains' && e.args.length === 1) {
          const x = this.emitArgTmp(e.args[0], 'i64', ctx);
          return { call: `ming_vec_contains(${baseText}, ${x})`, retTy: 'bool' };
        }
        if (m === 'pop' && e.args.length === 0) return { call: `ming_vec_pop(&${baseText})`, retTy: 'oi64' };
        if (m === 'get' && e.args.length === 1) {
          const i = this.emitArgTmp(e.args[0], 'i64', ctx);
          return { call: `ming_vec_get_opt(${baseText}, ${i})`, retTy: 'oi64' };
        }
        if (!baseIsIdent) throw new Unsupported('Vec.' + m + '(变异方法要求局部变量接收者)');
        if (m === 'push' && e.args.length === 1) {
          const x = this.emitArgTmp(e.args[0], 'i64', ctx);
          return { call: `ming_vec_push(&${baseText}, ${x})`, retTy: null };
        }
        if (m === 'reverse' && e.args.length === 0) return { call: `ming_vec_reverse(&${baseText})`, retTy: null };
        throw new Unsupported('Vec.' + m + '(C3 面:pop/get 已入)');
      }
      if (bt === 'mi64') {
        const SPm = `"${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0}`;
        if (m === 'len' && e.args.length === 0) return { call: `(${baseText}.n)`, retTy: 'i64' };
        if (m === 'is_empty' && e.args.length === 0) return { call: `(${baseText}.n == 0)`, retTy: 'bool' };
        if (m === 'has' && e.args.length === 1) {
          const k = this.emitArgTmp(e.args[0], 'str', ctx);
          return { call: `(ming_map_find(${baseText}, ${k}) >= 0)`, retTy: 'bool' };
        }
        if (m === 'get' && e.args.length === 1) {
          const k = this.emitArgTmp(e.args[0], 'str', ctx);
          return { call: `ming_map_get(${baseText}, ${k})`, retTy: 'oi64' };
        }
        if (m === 'set' && e.args.length === 2 && baseIsIdent) {
          const k = this.emitArgTmp(e.args[0], 'str', ctx);
          const v = this.emitArgTmp(e.args[1], 'i64', ctx);
          return { call: `ming_map_set(&${baseText}, ${k}, ${v})`, retTy: null };
        }
        if (m === 'delete' && e.args.length === 1 && baseIsIdent) {
          const k = this.emitArgTmp(e.args[0], 'str', ctx);
          return { call: `ming_map_delete(&${baseText}, ${k})`, retTy: 'bool' };
        }
        if (m === 'clear' && e.args.length === 0 && baseIsIdent) return { call: `(${baseText}.n = 0)`, retTy: null };
        throw new Unsupported('Map.' + m + '(keys/values/items 属 C4)');
      }
      if (bt === 'oi64') {
        if (m === 'is_some' && e.args.length === 0) return { call: `(${baseText}.some)`, retTy: 'bool' };
        if (m === 'is_none' && e.args.length === 0) return { call: `(!${baseText}.some)`, retTy: 'bool' };
        if (m === 'unwrap' && e.args.length === 0) return { call: `ming_opt_unwrap(${baseText}, "${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0})`, retTy: 'i64' };
        if (m === 'unwrap_or' && e.args.length === 1) {
          // v1.2.1(审查 MAJOR-2):回退实参物化为临时——C 三元对**无语句文本**的实参
          // (裸调用 `boom()`/取负 `-m`)惰性跳过,而 JS 急切求值(tree/VM panic,cc 曾静默出值)。
          const fe = this.emitExpr(e.args[0], 'i64', ctx);
          const ft = this.newTmp(ctx, 'i64', fe);
          return { call: `(${baseText}.some ? ${baseText}.v : ${ft})`, retTy: 'i64' };
        }
        throw new Unsupported('Option.' + m + '(C3 面:unwrap/unwrap_or/is_some/is_none)');
      }
      if (bt === 'ri64') {
        const SPm = `"${cstr(e.span?.file ?? '?')}", ${e.span?.line ?? 0}, ${e.span?.col ?? 0}`;
        if (m === 'is_ok' && e.args.length === 0) return { call: `(${baseText}.ok)`, retTy: 'bool' };
        if (m === 'is_err' && e.args.length === 0) return { call: `(!${baseText}.ok)`, retTy: 'bool' };
        if (m === 'unwrap' && e.args.length === 0) return { call: `ming_res_unwrap(${baseText}, ${SPm})`, retTy: 'i64' };
        if (m === 'unwrap_err' && e.args.length === 0) return { call: `ming_res_unwrap_err(${baseText}, ${SPm})`, retTy: 'str' };
        if (m === 'unwrap_or' && e.args.length === 1) {
          // 同 Option.unwrap_or(审查 MAJOR-2):回退实参物化,急切求值对齐 JS。
          const fe = this.emitExpr(e.args[0], 'i64', ctx);
          const ft = this.newTmp(ctx, 'i64', fe);
          return { call: `(${baseText}.ok ? ${baseText}.v : ${ft})`, retTy: 'i64' };
        }
        throw new Unsupported('Result.' + m + '(C3.5 面:unwrap/unwrap_err/unwrap_or/is_ok/is_err)');
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
    // 裸枚举构造器:Option[i64] 的 Some/None 与 Result[i64,str] 的 Ok/Err(C3/C3.5)
    if (e.callee.nt === 'Ident' && ['Some', 'None', 'Ok', 'Err'].includes(e.callee.name)) {
      if (e.callee.name === 'None') {
        if (e.args?.length) throw new Unsupported('None 带参数');
        return { call: 'ming_opt_none()', retTy: 'oi64' };
      }
      if (e.callee.name === 'Some') {
        if (e.args?.length !== 1) throw new Unsupported('Some 参数数');
        return { call: `ming_opt_some(${this.emitArgTmp(e.args[0], 'i64', ctx)})`, retTy: 'oi64' };
      }
      if (e.callee.name === 'Ok') {
        if (e.args?.length !== 1) throw new Unsupported('Ok 参数数');
        return { call: `ming_res_ok(${this.emitArgTmp(e.args[0], 'i64', ctx)})`, retTy: 'ri64' };
      }
      if (e.args?.length !== 1) throw new Unsupported('Err 参数数');
      return { call: `ming_res_err(${this.emitArgTmp(e.args[0], 'str', ctx)})`, retTy: 'ri64' };
    }
    if (e.callee.nt !== 'Ident') throw new Unsupported('调用目标 ' + e.callee.nt);
    const entry = this.resolveEntry(ctx, e.callee.name);
    if (!entry || entry.kind !== 'fn') throw new Unsupported('调用 ' + e.callee.name);
    const sig = entry.sig;
    // v0.42:extern fn(C4 FFI)—— dlsym 槽直调;仅数值签名
    if (entry.extern) {
      // v0.43:str 参数/返回进 ffi 面(ming_str ↔ NUL 结尾 C 串)
      const args = e.args.map((ar, i) => {
        const pt = mingTyNum(sig.params[i]?.type);
        if (!pt || pt === 'vi64' || pt === 'mi64' || pt === 'oi64' || pt === 'ri64') throw new Unsupported('extern 参数类型 ' + i + '(v1 面仅数值/str)');
        // #90:实参按源码序物化;str 载体临时为 ming_str,ming_cstr 转换留在调用文本
        // (纯分配,无用户可见求值序)
        const txt = this.emitArgTmp(ar, pt, ctx);
        return pt === 'str' ? `ming_cstr(${txt})` : txt;
      });
      const rt = sig.ret?.k === 'unit' ? null : mingTyNum(sig.ret);
      if (rt === null && sig.ret?.k !== 'unit') throw new Unsupported('extern 返回类型');
      if (rt && (rt === 'vi64' || rt === 'mi64' || rt === 'oi64' || rt === 'ri64')) throw new Unsupported('extern 返回类型(v1 面仅数值/str)');
      const call = `ming_ffi_${e.callee.name}(${args.join(', ')})`;
      return { call: rt === 'str' ? `ming_str_from_c(${call})` : call, retTy: rt };
    }
    const idx = this.compiled.entryFnIdx?.get(entry);
    if (idx === undefined || !this.eligible.has(idx)) throw new Unsupported('被调方不 eligible: ' + e.callee.name);
    const args = e.args.map((ar, i) => {
      const pt = mingTyNum(sig.params[i]?.type);
      if (!pt) throw new Unsupported('参数类型 ' + i);
      // #90:按源码序物化(含 mut Vec/Map 的深拷贝——tree/VM 在实参求值处即 deepCopy,
      // 拷贝落在该实参的物化语句里与之一致;非 mut 容器不可变,浅拷不引入别名可观察面)
      let txt = this.emitExpr(ar, pt, ctx);
      // 值语义:mut Vec/Map 实参在调用边界深拷贝(同 wasm ming_copy_vec 边界)
      if (pt === 'vi64' && sig.params[i]?.mut) txt = `ming_vec_copy(${txt})`;
      if (pt === 'mi64' && sig.params[i]?.mut) txt = `ming_map_copy(${txt})`;
      return this.newTmp(ctx, pt, txt);
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

  // v1.2.1(#85,plan §5.1):&&/|| 的 RHS 必须惰性求值。
  // emitCond 返回 C 表达式文本,但子表达式(checked 算术/值型 if/容器字面量等)以语句
  // 形式三地址化进 ctx——直接拼文本 "(L && R)" 时 R 的语句在构造期就被提升到当前语句位,
  // R 在 JS 会短路跳过时仍被求值(seed 39039:cc 在 JS 跳过的位置 panic M4002)。
  // 改为物化 i64 临时量 + C if/else 块:L 的语句落在当前位置(L 恒求值);R 的语句严格
  // 落在守卫块内(R 只在 JS 会求值时才求值)。返回值恒 0/1(与 bool 载体一致)。
  emitLogical(e, ctx) {
    const t = this.newTmp(ctx, 'i64');
    const L = this.emitCond(e.l, ctx);
    ctx.open(`if (${L}) {`);
    if (e.op === '&&') {
      const R = this.emitCond(e.r, ctx);
      ctx.line(`${t} = (${R}) ? 1LL : 0LL;`);
    } else {
      ctx.line(`${t} = 1LL;`);
    }
    ctx.close('}');
    ctx.open('else {');
    if (e.op === '&&') {
      ctx.line(`${t} = 0LL;`);
    } else {
      const R = this.emitCond(e.r, ctx);
      ctx.line(`${t} = (${R}) ? 1LL : 0LL;`);
    }
    ctx.close('}');
    return t;
  }

  // ---- 条件(语句位;C int 0/1)----
  emitCond(e, ctx) {
    switch (e.nt) {
      case 'BoolLit': return e.v ? '1' : '0';
      case 'Unary':
        if (e.op !== '!') throw new Unsupported('条件一元 ' + e.op);
        return `(!(${this.emitCond(e.expr, ctx)}))`;
      case 'Binary': {
        if (e.op === '&&' || e.op === '||') return this.emitLogical(e, ctx);
        if (!['==', '!=', '<', '<=', '>', '>='].includes(e.op)) throw new Unsupported('条件 ' + e.op);
        const lt = this.inferTy(e.l, ctx);
        const rt = this.inferTy(e.r, ctx);
        if (!lt || !rt || lt !== rt) throw new Unsupported('条件两侧类型');
        if (lt === 'bool') return `(${this.emitExpr(e.l, 'bool', ctx)} ${e.op} ${this.emitExpr(e.r, 'bool', ctx)})`;
        if (lt === 'str') {
          if (e.op === '==' || e.op === '!=') {
            // #90:helper 实参按源码序物化(ming_str_eq 的 C 实参求值序 unspecified)
            const l = this.emitArgTmp(e.l, 'str', ctx);
            const r = this.emitArgTmp(e.r, 'str', ctx);
            const t2 = `ming_str_eq(${l}, ${r})`;
            return e.op === '==' ? `(${t2})` : `(!(${t2}))`;
          }
          const l = this.emitArgTmp(e.l, 'str', ctx);
          const r = this.emitArgTmp(e.r, 'str', ctx);
          return `(ming_str_cmp(${l}, ${r}) ${e.op} 0)`;
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
          // v0.56(#30):extern fn 值存入局部变量后调用需要独立的 C 函数指针载体与调用
          // 路径(签名相关的 typedef、ctx 类型、Call 分派与资格面都要扩展)。本版选择
          // 明确诊断(而非把原因埋在“let 推导 null”里);直接调用 f(...) 不受影响。
          if (!ty && s.init?.nt === 'Ident') {
            const ent = this.resolveEntry(ctx, s.init.name);
            if (ent?.kind === 'fn' && ent.extern) {
              throw new Unsupported(`extern fn 值 "${s.init.name}":C 后端不支持把 extern fn 存入局部变量再调用;请直接调用 ${s.init.name}(...)(tree/VM 上该形态可解析,FFI 调用仍由 C 后端执行)`);
            }
          }
          // v0.54/C5:bool 局部(C 载体 long long)支持——Ptr 黄金程序需要 let b = p.is_null()
          if (!ty) throw new Unsupported('let 推导 ' + ty);
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
            // #90:下标/值按源码序物化(ming_vec_set 的 C 实参求值序 unspecified)
            const idx = this.emitArgTmp(s.target.index, 'i64', ctx);
            const val = this.emitArgTmp(s.value, 'i64', ctx);
            // v0.83 #58(plan §5.1):span 对齐 tree/VM 的写界检查口径(SETINDEX → target.span,
            // interp.js:889)——原取语句级 span,列差 1(cc 报语句首列,tree/VM 报 `[i]` 起列)
            const tsp = s.target.span;
            ctx.line(`ming_vec_set(&${base}, ${idx}, ${val}, "${cstr(tsp?.file ?? s.span?.file ?? '?')}", ${tsp?.line ?? s.span?.line ?? 0}, ${tsp?.col ?? s.span?.col ?? 0});`);
            return;
          }
          if (bt === 'mi64') {
            const base = ctx.nameOf(s.target.base.name);
            const k = this.emitArgTmp(s.target.index, 'str', ctx); // #90
            const val = this.emitArgTmp(s.value, 'i64', ctx);
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
        if (dty === 'bool' || dty === 'pu8' || dty === 'pcu8') throw new Unsupported('复合赋值类型 ' + dty); // v0.54/C5
        const op = s.op[0];
        if (dty === 'str') {
          if (op !== '+') throw new Unsupported('str 复合 ' + s.op);
          const b2 = this.emitArgTmp(s.value, 'str', ctx); // #90:helper 实参物化
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
      case 'UnsafeBlock': {
        // v0.54/C5:unsafe 块是类型层门禁;C 端语义 = 普通块(块内指针操作见 Ptr 方法发射)
        // v0.54 审查 B2:必须发射 C 作用域块——块内 let 遮蔽外层同名变量时,
        // 裸 emitBlock 会把两个同名 long long 放在同一作用域 → redefinition 编译失败。
        ctx.open('{');
        this.emitBlock(s.body, ctx);
        ctx.close('}');
        return;
      }
      case 'AsmBlock': {
        // v0.74/C6(ADR-006 §2):内联汇编——GCC 扩展 asm 逐字透传(volatile 固定,副作用块)
        ctx.line(this.emitAsmBlock(s, ctx));
        return;
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
        // v1.2.1(#85):条件每轮重新求值。C 没有表达式内置语句——原 `while (<cond text>)`
        // 把 emitCond 的语句式子表达式(checked 算术/&& 物化/值型 if)提升到循环外,条件
        // 只求值一次(依赖循环变量的条件 → 死循环/错值;JS 每轮求值)。改为语句化条件:
        // for (;;) { <cond stmts>; if (!(cond)) break; <body> }——continue 仍回到条件求值。
        ctx.open('for (;;) {');
        const c = this.emitCond(s.cond, ctx);
        ctx.line(`if (!(${c})) break;`);
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
        // v0.53:str for-in 按 UTF-8 码点迭代(对齐 tree/vm 的 [...s];此前按容器拒绝)
        if (s.iter.nt !== 'Range' && s.iter.nt !== 'Ident') throw new Unsupported('for 迭代 ' + s.iter.nt);
        if (s.iter.nt === 'Ident') {
          const bt = ctx.typeOf(s.iter.name);
          if (bt === 'str') {
            if (s.pat.nt !== 'PIdent') throw new Unsupported('str for-in 模式');
            const base = ctx.nameOf(s.iter.name);
            // 快照:迭代开始时的字符串值(tree/vm 的迭代器同样持有旧值);循环体可重绑 s
            const snap = this.newTmp(ctx, 'str', base);
            const lenT = this.newTmp(ctx, 'i64', `${snap}.n`);
            ctx.open('{');
            // v0.53 审查修复:循环变量必须落在内层作用域(此前 declare 在函数作用域,
            // 遮蔽外层同名变量后 nameOf 指向块内 cname,v_ch_2 → 块外引用非法 C)
            ctx.pushScope();
            const ivar = ctx.declare('__is' + s.pat.name, 'i64');
            ctx.open(`for (long long ${ivar} = 0; ${ivar} < ${lenT}; ) {`);
            // UTF-8 码点宽度:1/2/3/4 字节(与运行时 ming_str_chars 同一判定)
            const bv = this.newTmp(ctx, 'i64', `(long long)(unsigned char)${snap}.p[${ivar}]`);
            const cv = this.newTmp(ctx, 'i64', `(${bv} < 0x80) ? 1 : ((${bv} & 0xE0) == 0xC0) ? 2 : ((${bv} & 0xF0) == 0xE0) ? 3 : 4`);
            // 防御:截断序列不越界读(合法 UTF-8 下恒不触发)
            ctx.line(`if (${ivar} + ${cv} > ${lenT}) ${cv} = ${lenT} - ${ivar};`);
            const ev = ctx.declare(s.pat.name, 'str');
            ctx.line(`ming_str ${ev}; ${ev}.p = ${snap}.p + ${ivar}; ${ev}.n = ${cv};`);
            ctx.line(`${ivar} += ${cv};`);
            this.emitBlock(s.body, ctx);
            ctx.close('}');
            ctx.close('}');
            ctx.popScope();
            return;
          }
          if (bt === 'vi64') {
            if (s.pat.nt !== 'PIdent') throw new Unsupported('for 模式');
            const base = ctx.nameOf(s.iter.name);
            const lenT = this.newTmp(ctx, 'i64');
            ctx.line(`${lenT} = ${base}.n;`);
            ctx.open('{');
            // v0.53 审查修复:容器 for-in 循环变量落入内层作用域(同 str 分支)
            ctx.pushScope();
            const ivar = ctx.declare('__i' + s.pat.name, 'i64');
            ctx.open(`for (long long ${ivar} = 0; ${ivar} < ${lenT}; ${ivar}++) {`);
            const ev = ctx.declare(s.pat.name, 'i64');
            ctx.line(`long long ${ev} = ${base}.d[${ivar}];`);
            this.emitBlock(s.body, ctx);
            ctx.close('}');
            ctx.close('}');
            ctx.popScope();
            return;
          }
          if (bt === 'mi64') {
            if (s.pat.nt !== 'PTuple' || s.pat.pats.length !== 2) throw new Unsupported('map for-in 模式(须 (k, v))');
            const base = ctx.nameOf(s.iter.name);
            const lenT = this.newTmp(ctx, 'i64');
            ctx.line(`${lenT} = ${base}.n;`);
            ctx.open('{');
            // v0.53 审查修复:容器 for-in 循环变量落入内层作用域(同 str 分支)
            ctx.pushScope();
            const ivar = ctx.declare('__im' + s.pat.pats[0].name, 'i64');
            ctx.open(`for (long long ${ivar} = 0; ${ivar} < ${lenT}; ${ivar}++) {`);
            const kv = ctx.declare(s.pat.pats[0].name, 'str');
            ctx.line(`ming_str ${kv}; ${kv}.p = ${base}.d[${ivar}].k; ${kv}.n = ${base}.d[${ivar}].kn;`);
            const vv = ctx.declare(s.pat.pats[1].name, 'i64');
            ctx.line(`long long ${vv} = ${base}.d[${ivar}].v;`);
            this.emitBlock(s.body, ctx);
            ctx.close('}');
            ctx.close('}');
            ctx.popScope();
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
        // v0.53 审查修复(同根因):区间 for 的循环变量同样落入内层作用域——
        // 此前遮蔽外层同名变量时块外引用 v_i_2 → 非法 C;非遮蔽程序发射逐字不变
        ctx.pushScope();
        const ivar = ctx.declare(s.pat.name, 'i64');
        ctx.open(`for (long long ${ivar} = ${loV}; ${ivar} < ${hiV}; ${ivar}++) {`);
        this.emitBlock(s.body, ctx);
        ctx.close('}');
        ctx.close('}');
        ctx.popScope();
        return;
      }
      default:
        throw new Unsupported('语句 ' + s.nt);
    }
  }

  // v0.74/C6(ADR-006 §2):发射 __asm__ volatile(<模板拼接> : <outs> : <ins> : <clobbers>);
  // * 模板/约束/clobber 已由 parser 保证为纯字符串字面量(注入面在解析层闭合),此处逐字
  //   透传(模板内 %% 与 %N 修饰符等 GCC 语法由用户负责,不做改写);
  // * 操作数编号 = GCC 约定 %0/%1…:out 子句先(各占一位),然后 in 子句(声明序);
  // * 空段按 GCC 位置语法保留:无 out 有 in → "tpl : : ins";全空 → "tpl"(无冒号段);
  // * in 操作数按声明序发射(emitExpr 副作用语句按序落盘)——GCC 对 input 操作数的实际
  //   求值序无合同,v1 面向无副作用 i64 操作数(如实登记);
  // * 防御:模板内 %N 引用越界 → Unsupported 发射期拒绝(ming cc 报"C1 不支持该程序形态")。
  emitAsmBlock(s, ctx) {
    const tpl = s.templates.join(''); // ADR-006 §1:1+ 模板字面量逐字拼接
    const outs = [];
    for (const o of s.outs) {
      const cname = ctx.nameOf(o.target);
      if (!cname) throw new Unsupported('asm out 目标非局部: ' + o.target);
      const ty = ctx.typeOf(o.target);
      if (ty !== 'i64') throw new Unsupported('asm out 目标类型 ' + ty);
      outs.push(`"${cstr(o.constraint)}"(${cname})`);
    }
    const ins = [];
    for (const iv of s.ins) {
      const ty = this.inferTy(iv.value, ctx);
      if (ty !== 'i64') throw new Unsupported('asm in 操作数类型 ' + (ty ?? '?'));
      ins.push(`"${cstr(iv.constraint)}"(${this.emitExpr(iv.value, 'i64', ctx)})`);
    }
    const clobbers = s.clobbers.map(c => `"${cstr(c)}"`);
    const nOps = outs.length + ins.length;
    // %% = GCC 字面百分号输出形(v0.74 审查 MINOR-1:匹配前剔除,避免 %%0 被误判为操作数引用 %0)
    for (const m of tpl.replace(/%%/g, '').matchAll(/%([a-zA-Z]+)?([0-9]+)/g)) {
      const n = Number(m[2]);
      if (n >= nOps) {
        throw new Unsupported(`asm 模板引用操作数 %${m[2]} 超出操作数个数 ${nOps}(编号 = out 先 in 后,GCC 约定)`);
      }
    }
    const sections = [];
    if (outs.length || ins.length || clobbers.length) sections.push(outs.join(', '));
    if (ins.length || clobbers.length) sections.push(ins.join(', '));
    if (clobbers.length) sections.push(clobbers.join(', '));
    return `__asm__ volatile("${cstr(tpl)}"${sections.length ? ' : ' + sections.join(' : ') : ''});`;
  }

  // 块发射。opts.isBody = 函数体位:块尾表达式 = 返回值(fib.ming 的 fib_loop 形态,
  // tree execBlock/VM compileBlock 以块尾值为函数返回值)→ return <尾表达式>;
  // unit 返回的函数体尾仅放行 Call 形态(求值后丢弃,与 ExprStmt 同路径)。
  // 语句位块(if/while/for/unsafe 体)的块尾表达式维持具名拒绝(消息逐字不变——
  // tree/VM 对该形态"求值后丢弃",C 面本版不放行,具名登记见 plan T5.2)。
  // 契约(requires/ensures)与函数体尾并用具名拒绝:C 后端不发射契约,放行将静默
  // 跳过 tree/VM 在块尾值上执行的 ensures 检查(interp.js execBlock isBody)——新增
  // 分歧面,不许;既有无尾契约 main 的行为本版不动(不扩大范围)。
  emitBlock(block, ctx, opts = {}) {
    ctx.pushScope();
    for (const st of block.stmts) this.emitStmt(st, ctx);
    if (block.tail) {
      if (!opts.isBody) throw new Unsupported('块尾表达式(语句位)');
      if (opts.hasContract) throw new Unsupported('契约与函数体块尾表达式并用(C 后端不支持契约)');
      if (ctx.retTy !== null) {
        ctx.line(`return ${this.emitExpr(block.tail, ctx.retTy, ctx)};`);
      } else if (block.tail.nt === 'Call') {
        if (ctx.isMain && block.tail.callee.nt === 'Ident' && block.tail.callee.name === 'print') {
          this.emitPrint(block.tail, ctx);
        } else {
          const { call, retTy } = this.emitCallRef(block.tail, ctx);
          ctx.line(retTy === null ? `${call};` : `(void)(${call});`);
        }
      } else {
        throw new Unsupported('块尾表达式(unit 返回 ' + block.tail.nt + ')');
      }
    }
    ctx.popScope();
  }

  // print:整数、str、f64(floatStr 对齐)、插值串(T5.2:逐段 displayStr 对齐);Vec/Map → C4
  emitPrint(e, ctx) {
    if (e.args.length !== 1) throw new Unsupported('print 参数数');
    const a = e.args[0];
    if (a.nt === 'StrLit') {
      if (!(a.parts.length === 1 && 'lit' in a.parts[0])) {
        this.emitPrintInterp(a, ctx);
        return;
      }
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
      if (it === 'bool') {
        // v0.54/C5:str(bool) 与 displayStr 对齐(true/false)
        const v = this.emitExpr(a.args[0], 'bool', ctx);
        ctx.line(`printf("%s\\n", (${v}) ? "true" : "false");`);
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
    if (t === 'bool') {
      const v = this.emitExpr(a, 'bool', ctx);
      ctx.line(`printf("%s\\n", (${v}) ? "true" : "false");`);
      return;
    }
    throw new Unsupported('print ' + (t ?? a.nt) + '(Vec/Map 形态属 C4)');
  }

  // ---- print 插值串(T5.2)----
  // 逐段 printf,末尾补 '\n'。每段渲染与 tree/VM displayStr(interp.js:121)逐字节一致:
  //   str 原样 / i64·u64 十进制(%lld·%llu)/ f64 ming_float_str(v0.42 floatStr 对齐)/
  //   bool true-false(f64 负零归一 +0.0 对齐 JS toFixed——审查 M1);lit 段经静态字节数组按 %.*s 传参输出(内容含 % 亦安全)。
  // 求值序:先左→右把全部表达式段求值入临时,再按段序统一输出——与 tree/VM "先求值
  // 后拼串"一致(段表达式若为 extern fn 等效应调用,其副作用整体先于本 print 的输出)。
  emitPrintInterp(a, ctx) {
    const segs = [];
    this.collectDisplaySegs(a.parts, ctx, segs);
    for (const s of segs) {
      if ('lit' in s) {
        const n = Buffer.byteLength(s.lit, 'utf8');
        if (n > 0) ctx.line(`printf("%.*s", (int)${n}, ${this.strLitName(s.lit)});`);
        continue;
      }
      if (s.ty === 'i64' || s.ty === 'u64') { ctx.line(`printf("${FMT[s.ty]}", ${s.tmp});`); continue; }
      if (s.ty === 'str') { ctx.line(`printf("%.*s", (int)${s.tmp}.n, ${s.tmp}.p);`); continue; }
      if (s.ty === 'f64') { ctx.line(`{ unsigned char __fb[340]; printf("%.*s", (int)ming_float_str(${s.tmp}, __fb), __fb); }`); continue; }
      ctx.line(`printf("%s", (${s.tmp}) ? "true" : "false");`);
    }
    ctx.line(`printf("\\n");`);
  }

  // 插值段收集:lit 段与表达式段依序入 out;嵌套插值展平(displayStr 对 str 恒等,展平
  // 不改变求值序与输出字节,probe2 实测 "x\{"in\{y}ner"}z" 三引擎逐字)。
  collectDisplaySegs(parts, ctx, out) {
    for (const p of parts) {
      if ('lit' in p) { out.push({ lit: p.lit }); continue; }
      const e = p.expr;
      if (e.nt === 'StrLit' && !(e.parts.length === 1 && 'lit' in e.parts[0])) {
        this.collectDisplaySegs(e.parts, ctx, out);
        continue;
      }
      out.push(this.evalDisplaySeg(e, ctx));
    }
  }

  // 表达式段求值:求值一次入临时,返回 { ty, tmp }。str(...) 内建段按内层类型渲染
  // (displayStr(str(x)) 与 displayStr(x) 同字节,与既有 print str(...) 面同口径);
  // 其余形态具名拒绝(Vec/Map/Option/Result 显示形态属 C4)。
  evalDisplaySeg(e, ctx) {
    if (e.nt === 'Call' && e.callee.nt === 'Ident' && e.callee.name === 'str' && e.args.length === 1) {
      const it = this.inferTy(e.args[0], ctx);
      if (!it) throw new Unsupported('print 插值段 str(...)(C4)@ 行 ' + (e.span?.line ?? '?'));
      return this.evalDisplaySeg(e.args[0], ctx);
    }
    const t = this.inferTy(e, ctx);
    if (t === 'i64' || t === 'u64' || t === 'f64' || t === 'str') {
      return { ty: t, tmp: this.newTmp(ctx, t, this.emitExpr(e, t, ctx)) };
    }
    if (t === 'bool') {
      return { ty: t, tmp: this.newTmp(ctx, 'bool', this.emitExpr(e, 'bool', ctx)) };
    }
    throw new Unsupported('print 插值段 ' + (t ?? e.nt) + '(Vec/Map 形态属 C4)@ 行 ' + (e.span?.line ?? '?'));
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
    // v0.43(C3.5):sigExt3 = Result[i64,str] 进入 C 面;ffi = 效果 ⊆ {ffi} 的函数可编译
    // v0.54/C5:unsafe 为 C 专用扩展(效果 ⊆ {ffi, unsafe} + Ptr 签名);wasm 路径不传
    // v0.74/C6(ADR-006):asm 为 C 专用扩展(效果 ⊆ {ffi, unsafe, asm} 可编译——内联
    // 汇编仅由 ming cc 真实执行);wasm 路径不传,with asm 永不 wasm eligible
    this.eligible = analyzeEligibility(this.check, this.compiled, { numericOnly: true, sigExt: true, sigExt2: true, sigExt3: true, ffi: true, unsafe: !!this.opts.unsafe, asm: !!this.opts.asm });
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

    // eligible 函数体(发射失败 → 整体回落);extern fn 跳过(体为桩,dlsym 槽替代)
    const bodies = [];
    const order = [...this.eligible.keys()].sort((a, b) => a - b).filter(fi => fns[fi]?.entry?.decl?.nt !== 'ExternFnDecl');
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
      // T5.2:isBody 开启函数体块尾(return <尾>);eligible 函数无契约(analyze 拒收),
      // hasContract 为防御位。契约函数 + 块尾在 emitBlock 内具名拒绝。
      this.emitBlock(f.entry.decl.body, ctx, { isBody: true, hasContract: !!(f.entry.decl.requires || f.entry.decl.ensures) });
      // 检查器保证必然 return;此处为 C 需要的防御零值
      if (retTy) {
        ctx.line(retTy === 'str' ? 'return (ming_str){0, 0};'
          : retTy === 'vi64' ? 'return (ming_vec){0, 0, 0};'
          : retTy === 'mi64' ? 'return (ming_map){0, 0, 0};'
          : retTy === 'oi64' ? 'return (ming_opt){0, 0};'
          : retTy === 'ri64' ? 'return (ming_res){0, 0, {0, 0}};'
          : 'return 0;');
      }
      ctx.close('}');
      bodies.push(ctx.lines.join('\n'));
    }

    // main AOT 形态
    const mctx = this.fnCtx(this.check.entry?.file, mainRet, true);
    mctx.open(`${mainRet ? 'int' : 'void'} ming_main(void) {`);
    // T5.2:main 同为函数体位(块尾 = main 返回值;unit main 的块尾 Call 求值后丢弃)。
    // 契约 main + 块尾具名拒绝(避免静默跳过 ensures)。
    this.emitBlock(mainFn.entry.decl.body, mctx, { isBody: true, hasContract: !!(mainFn.entry.decl.requires || mainFn.entry.decl.ensures) });
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
    // v0.54/C5:仅在程序实际使用 std.mem.alloc 时发射 —— 非 unsafe 程序的 C 输出逐字不变
    const memRuntime = this.usesMemAlloc ? [
      '/* v0.54/C5:std.mem.alloc —— malloc 失败即 panic(M4011;tree/VM 在 alloc 处已 M4016) */',
      'static unsigned char* ming_mem_alloc(long long n, const char* f, int l, int c) {',
      '    size_t sz = (size_t)n;',
      '    void* p = malloc(sz ? sz : 1);',
      '    if (!p) {',
      '        fprintf(stderr, "%s:%d:%d: error M4011[alloc-quota-exceeded]: 内存分配失败:std.mem.alloc(%lld) 返回 NULL\\n", f, l, c, n);',
      '        exit(101);',
      '    }',
      '    return (unsigned char*)p;',
      '}',
      '',
    ] : [];
    // v0.42:extern fn(C4 FFI)—— 槽位声明 + 启动绑定
    const externs = [];
    for (const [, entry] of this.check.entry.items) {
      if (entry.kind === 'fn' && entry.extern) externs.push(entry);
    }
    const ffiSlots = externs.map((entry) => {
      const sig = entry.sig;
      // v0.43:C ABI 槽签名(str → const char*)
      const slotTy = (t) => (mingTyNum(t) === 'str' ? 'const char*' : CTYPE[mingTyNum(t)]);
      const rt = sig.ret?.k === 'unit' ? 'void' : slotTy(sig.ret);
      const ps = sig.params.map((p) => slotTy(p.type)).join(', ');
      return `static ${rt} (*ming_ffi_${entry.decl.name})(${ps}) = 0; /* extern ${entry.extern.lib ?? '<进程>'}.${entry.decl.name} */`;
    });
    const ffiBinds = externs.map((entry) =>
      `    ming_ffi_bind("${cstr(entry.extern.lib ?? '')}", "${cstr(entry.decl.name)}", (void**)&ming_ffi_${entry.decl.name});`);
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
      '#include <windows.h>',
      '#else',
      '#include <dlfcn.h>',
      '#endif',
      '',
      '/* ---- Ming C 运行时(C2:str + Vec[i64];分配不回收,与 wasm 线性内存同策略)---- */',
      'typedef struct { const unsigned char* p; long long n; } ming_str;',
      'typedef struct { long long* d; long long n; long long cap; } ming_vec;',
      'typedef struct { const unsigned char* k; long long kn; long long v; } ming_kv;',
      'typedef struct { ming_kv* d; long long n; long long cap; } ming_map;',
      'typedef struct { long long some; long long v; } ming_opt;',
      'typedef struct { long long ok; long long v; ming_str e; } ming_res;',
      '',
      'static void* ming_alloc(size_t n) {',
      '    void* p = malloc(n ? n : 1);',
      '    if (!p) { fputs("ming: 内存分配失败\\n", stderr); exit(101); }',
      '    return p;',
      '}',
      '',
      ...memRuntime,
      'static ming_opt ming_opt_some(long long v) { ming_opt o; o.some = 1; o.v = v; return o; }',
      'static ming_opt ming_opt_none(void) { ming_opt o; o.some = 0; o.v = 0; return o; }',
      '',
      'static ming_res ming_res_ok(long long v) { ming_res r; r.ok = 1; r.v = v; r.e.n = 0; r.e.p = 0; return r; }',
      'static ming_res ming_res_err(ming_str e) { ming_res r; r.ok = 0; r.v = 0; r.e = e; return r; }',
      '',
      'static long long ming_res_unwrap(ming_res r, const char* f, int l, int c) {',
      '    if (!r.ok) {',
      '        fprintf(stderr, "%s:%d:%d: error M4006[unwrap-failed]: 对 Err(%.*s) 调用 unwrap()\\n", f, l, c, (int)r.e.n, r.e.p);',
      '        exit(101);',
      '    }',
      '    return r.v;',
      '}',
      '',
      'static ming_str ming_res_unwrap_err(ming_res r, const char* f, int l, int c) {',
      '    if (r.ok) {',
      '        fprintf(stderr, "%s:%d:%d: error M4006[unwrap-failed]: 对 Ok(%lld) 调用 unwrap_err()\\n", f, l, c, r.v);',
      '        exit(101);',
      '    }',
      '    return r.e;',
      '}',
      '',
      '/* v0.43:ffi 字符串桥(ming_str ↔ NUL 结尾 C 串) */',
      'static char* ming_cstr(ming_str s) {',
      '    char* d = (char*)ming_alloc((size_t)s.n + 1);',
      '    if (s.n) memcpy(d, s.p, (size_t)s.n);',
      '    d[s.n] = 0;',
      '    return d;',
      '}',
      '',
      'static ming_str ming_str_from_c(const char* c) {',
      '    long long n = c ? (long long)strlen(c) : 0;',
      '    unsigned char* d = (unsigned char*)ming_alloc((size_t)n + 1);',
      '    if (n) memcpy(d, c, (size_t)n);',
      '    d[n] = 0;',
      '    ming_str s; s.p = d; s.n = n; return s;',
      '}',
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
      '    if (from.n == 0) {',
      '        /* 空模式:每个 Unicode 码点之间插入 to(与 interp [...s].join(to) 对齐) */',
      '        long long chars = ming_str_chars(a);',
      '        if (chars <= 1) return a;',
      '        size_t need = (size_t)a.n + (size_t)(chars - 1) * (size_t)to.n + 1;',
      '        unsigned char* d = (unsigned char*)ming_alloc(need);',
      '        long long w = 0, i = 0, ci = 0;',
      '        while (i < a.n) {',
      '            if (ci > 0 && to.n) { memcpy(d + w, to.p, (size_t)to.n); w += to.n; }',
      '            unsigned char b = a.p[i];',
      '            long long cl = (b < 0x80) ? 1 : ((b & 0xE0) == 0xC0) ? 2 : ((b & 0xF0) == 0xE0) ? 3 : 4;',
      '            memcpy(d + w, a.p + i, (size_t)cl); w += cl; i += cl; ci++;',
      '        }',
      '        ming_str e; e.p = d; e.n = w; return e;',
      '    }',
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
      '    long long chars = ming_str_chars(a);',
      '    if (chars >= n) return a;',
      '    long long pad = n - chars;',
      '    unsigned char* d = (unsigned char*)ming_alloc((size_t)a.n + (size_t)pad + 1);',
      '    memset(d, 0x20, (size_t)pad);',
      '    if (a.n) memcpy(d + pad, a.p, (size_t)a.n);',
      '    ming_str s; s.p = d; s.n = a.n + pad; return s;',
      '}',
      '',
      'static ming_str ming_str_pad_right(ming_str a, long long n) {',
      '    long long chars = ming_str_chars(a);',
      '    if (chars >= n) return a;',
      '    long long pad = n - chars;',
      '    unsigned char* d = (unsigned char*)ming_alloc((size_t)a.n + (size_t)pad + 1);',
      '    if (a.n) memcpy(d, a.p, (size_t)a.n);',
      '    memset(d + a.n, 0x20, (size_t)pad);',
      '    ming_str s; s.p = d; s.n = a.n + pad; return s;',
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
      // v0.83 #58(plan §5.1):元素写 = 写 flavor——消息不带 "(用 .get(i) 返回 Option)" 读后缀
      // (interp.js:889 单一事实;读 flavor ming_vec_get 保持后缀,interp.js:1044 口径)
      '        fprintf(stderr, "%s:%d:%d: error M4003[index-out-of-bounds]: 索引越界:长度 %lld,访问 %lld\\n", f, l, c, v->n, i);',
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
      '/* 窄整数截断后符号扩展(N 位位型 → 64 位有符号;避免有符号左移/实现定义右移) */',
      'static long long ming_sext(unsigned long long u, int bits) {',
      '    if (bits >= 64) return (long long)u;',
      '    unsigned long long mask = (1ULL << bits) - 1;',
      '    u &= mask;',
      '    if (u & (1ULL << (bits - 1))) u |= ~mask;',
      '    return (long long)u;',
      '}',
      '',
      '/* ---- floatStr 对齐(interp floatStr 语义)+ JS Number::toString 格式化 ---- */',
      'static long long ming_float_str(double x, unsigned char* out) {',
      '    if (x != x) { memcpy(out, "NaN", 3); return 3; }',
      '    if (x == 0.0 && 1.0 / x < 0) { x = 0.0; } /* v0.92 审查 M1:-0.0 归一 +0.0(JS toFixed 负号仅 x<0,负零不加号);原行为空体死代码,cc 曾输出 -0.0 与 tree/VM 分歧 */',
      '    if (x == INFINITY) { memcpy(out, "Infinity", 8); return 8; }',
      '    if (x == -INFINITY) { memcpy(out, "-Infinity", 9); return 9; }',
      '    long long w = 0;',
      '    if (x < 0) { out[w++] = (unsigned char)\'-\'; x = -x; }',
      '    if (x == floor(x) && x < 1e21) {',
      '        /* toFixed(1):printf 对 double 输出精确十进制,避免 x*10 溢出 long long 的 UB */',
      '        w += snprintf((char*)out + w, 340 - (size_t)w, "%.1f", x);',
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
      '/* ---- C4:extern fn(dlopen/LoadLibrary + dlsym/GetProcAddress;M4013 逐字对齐设计)---- */',
      'static void ming_ffi_bind(const char* lib, const char* sym, void** slot) {',
      '#ifdef _WIN32',
      '    void* h = lib[0] ? (void*)LoadLibraryA(lib) : (void*)GetModuleHandleA(0);',
      '#else',
      '    void* h = dlopen(lib[0] ? lib : 0, RTLD_NOW | RTLD_GLOBAL);',
      '#endif',
      '    if (!h) { fprintf(stderr, "error M4013[ffi-load-failed]: ffi 库加载失败: %s\\n", lib); exit(101); }',
      '#ifdef _WIN32',
      '    void* s = (void*)GetProcAddress((HMODULE)h, sym);',
      '#else',
      '    void* s = dlsym(h, sym);',
      '#endif',
      '    if (!s) { fprintf(stderr, "error M4013[ffi-load-failed]: ffi 符号未找到: %s\\n", sym); exit(101); }',
      '    *slot = s;',
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
      ...ffiSlots,
      ...(ffiSlots.length ? [''] : []),
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
      ...ffiBinds,
      ...(mainRet
        ? ['    return ming_main(); /* v0.92 m2:main 返回值 = 进程退出码(对齐 tree/VM;i64→int 截断与 OS 退出码语义一致) */']
        : ['    ming_main();', '    return 0;']),
      '}',
      '',
    ];
    return { code: parts.join('\n'), eligible: this.eligible };
  }

  fnCtx(modFile, retTy, isMain) {
    const ctx = {
      modFile,
      isMain,
      // v0.83(§4.13.4 P1.1):specific 旗标废除——M4004(除零/取模零)随 M4002(v0.81)
      // 四引擎统一,main/eligible 同模板,最后一个消费点(emitCheckedS/U 的 PZ 门)已拆。
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

export function tryEmitC(check, compiled, opts = {}) {
  try {
    return new CEmit(check, compiled, opts).run();
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

// 抛错版(CLI 用:需要 Unsupported 的具体原因作为诊断消息)
// v0.54/C5:opts.unsafe = C 专用资格扩展(由 ming cc 路径传入)
export function emitC(check, compiled, opts = {}) {
  return new CEmit(check, compiled, opts).run();
}
