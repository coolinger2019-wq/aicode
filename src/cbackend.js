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

const CTYPE = { i64: 'long long', u64: 'unsigned long long', f64: 'double' };
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

// Ming 类型节点 → 'i64'|'u64'|'f64'|null(仅 64 位数值)
function mingTyNum(t) {
  if (!t) return null;
  if (t.k === 'int' && t.bits === 64) return t.signed ? 'i64' : 'u64';
  if (t.k === 'float' && t.bits === 64) return 'f64';
  return null;
}

// 类型标注节点:解析器形状是 nt:'TName'(let 标注 / as 目标);签名里是已解析的 k+bits 形状。
// 返回 {k,bits,signed} | null(与 interp castValue 的 PRIM_TYPES 口径一致)
const ANNO_PRIM = {
  i8: { k: 'int', bits: 8, signed: true }, u8: { k: 'int', bits: 8, signed: false },
  i16: { k: 'int', bits: 16, signed: true }, u16: { k: 'int', bits: 16, signed: false },
  i32: { k: 'int', bits: 32, signed: true }, u32: { k: 'int', bits: 32, signed: false },
  i64: { k: 'int', bits: 64, signed: true }, u64: { k: 'int', bits: 64, signed: false },
  f64: { k: 'float', bits: 64, signed: true },
};

function annoTarget(t) {
  if (!t) return null;
  if (t.nt === 'TName') return ANNO_PRIM[t.name.split('.').pop()] ?? null;
  if (t.k === 'int' || t.k === 'float') return { k: t.k, bits: t.bits, signed: !!t.signed };
  return null;
}

// ---------- 发射器 ----------

class CEmit {
  constructor(check, compiled) {
    this.check = check;
    this.compiled = compiled;
    this.modulesByFile = new Map(check.modules.map(m => [m.file, m]));
    this.usedConsts = new Map(); // const 名 → 'i64'|'u64'|'f64'(发射期收集,顶部统一定义)
    this.tmpSeq = 0;
  }

  newTmp(ctx, ty) {
    const name = `__t${++this.tmpSeq}`;
    ctx.line(`${CTYPE[ty]} ${name};`);
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
      case 'Ident': {
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
        if (e.callee.nt === 'Field' && e.callee.base.nt === 'Ident') {
          const t = ANNO_PRIM[e.callee.base.name];
          if (t && (e.callee.name === 'max_value' || e.callee.name === 'min_value')) return t.signed ? 'i64' : 'u64';
          if (e.callee.base.name === 'f64' && ['infinity', 'neg_infinity', 'nan'].includes(e.callee.name)) return 'f64';
          return null;
        }
        if (e.callee.nt !== 'Ident') return null;
        const entry = this.resolveEntry(ctx, e.callee.name);
        if (entry?.kind !== 'fn') return null;
        return mingTyNum(entry.sig?.ret);
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
      case 'Ident': {
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
      const text = `(${this.emitExpr(e.l, lt, ctx)} ${op} ${this.emitExpr(e.r, rt, ctx)})`;
      return ty === 'bool' ? text : `((long long)(${text}))`;
    }
    // 算术
    const lt = this.inferTy(e.l, ctx);
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
      if (target.bits !== 64) throw new Unsupported('as f32(C2)');
      if (ty !== 'f64') throw new Unsupported('as f64 位置');
      if (srcTy === 'f64') return this.emitExpr(e.expr, 'f64', ctx);
      if (srcTy === 'bool') throw new Unsupported('bool→f64');
      return `(double)(${this.emitExpr(e.expr, srcTy, ctx)})`;
    }
    if (target?.k !== 'int') throw new Unsupported('as 目标 ' + (target?.k ?? '?'));
    if (srcTy === 'f64') throw new Unsupported('float→int 截断(C2)');
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
    if (e.callee.nt !== 'Ident') throw new Unsupported('调用目标 ' + e.callee.nt);
    const entry = this.resolveEntry(ctx, e.callee.name);
    if (!entry || entry.kind !== 'fn') throw new Unsupported('调用 ' + e.callee.name);
    const idx = this.compiled.entryFnIdx?.get(entry);
    if (idx === undefined || !this.eligible.has(idx)) throw new Unsupported('被调方不 eligible: ' + e.callee.name);
    const sig = entry.sig;
    const args = e.args.map((ar, i) => {
      const pt = mingTyNum(sig.params[i]?.type);
      if (!pt) throw new Unsupported('参数类型 ' + i);
      return this.emitExpr(ar, pt, ctx);
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
        return `(${this.emitExpr(e.l, lt, ctx)} ${e.op} ${this.emitExpr(e.r, rt, ctx)})`;
      }
      default:
        throw new Unsupported('条件 ' + e.nt);
    }
  }

  // ---- 语句 ----
  emitStmt(s, ctx) {
    switch (s.nt) {
      case 'Let': {
        if (!s.init || s.pat.nt !== 'PIdent') throw new Unsupported('let 形式');
        let ty;
        if (s.type) {
          const t = annoTarget(s.type);
          ty = t ? mingTyNum(t) : null;
          if (!ty) throw new Unsupported('let 标注 ' + (s.type?.name ?? s.type?.k ?? '?') + '(C1 仅数值)');
        } else {
          ty = this.inferTy(s.init, ctx);
          if (!ty || ty === 'bool') throw new Unsupported('let 推导 ' + ty);
        }
        const v = this.emitExpr(s.init, ty, ctx);
        const name = ctx.declare(s.pat.name, ty);
        ctx.line(`${CTYPE[ty]} ${name} = ${v};`);
        return;
      }
      case 'Assign': {
        if (s.target.nt !== 'Ident') throw new Unsupported('赋值目标 ' + s.target.nt);
        const dst = ctx.nameOf(s.target.name);
        if (!dst) throw new Unsupported('赋值目标非局部');
        const dty = ctx.typeOf(s.target.name);
        if (s.op === '=') {
          const v = this.emitExpr(s.value, dty, ctx);
          ctx.line(`${dst} = ${v};`);
          return;
        }
        if (!['+=', '-=', '*=', '/=', '%=', '<<=', '>>='].includes(s.op)) throw new Unsupported('复合 ' + s.op);
        const op = s.op[0];
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
        // C1 仅区间 for(lo..hi;hi 排他,与 V.range 一致);容器 for-in 属 C2
        if (s.iter.nt !== 'Range') throw new Unsupported('for 迭代 ' + s.iter.nt + '(容器 for-in 属 C2)');
        if (s.pat.nt !== 'PIdent') throw new Unsupported('for 模式');
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

  // print:仅 i64/u64 整数(str(int) 或直接数值)与纯字面量串;f64/插值/拼接 → C2
  emitPrint(e, ctx) {
    if (e.args.length !== 1) throw new Unsupported('print 参数数');
    const a = e.args[0];
    if (a.nt === 'StrLit') {
      if (!(a.parts.length === 1 && 'lit' in a.parts[0])) throw new Unsupported('print 插值串(C2)');
      ctx.line(`printf("%s\\n", "${cstr(a.parts[0].lit)}");`);
      return;
    }
    if (a.nt === 'Call' && a.callee.nt === 'Ident' && a.callee.name === 'str' && a.args.length === 1) {
      const it = this.inferTy(a.args[0], ctx);
      if (it !== 'i64' && it !== 'u64') throw new Unsupported('str(打印 ' + it + ')(f64/str 形态属 C2)');
      const v = this.emitExpr(a.args[0], it, ctx);
      ctx.line(`printf("${FMT[it]}\\n", ${v});`);
      return;
    }
    const t = this.inferTy(a, ctx);
    if (t === 'i64' || t === 'u64') {
      const v = this.emitExpr(a, t, ctx);
      ctx.line(`printf("${FMT[t]}\\n", ${v});`);
      return;
    }
    throw new Unsupported('print ' + (t ?? a.nt) + '(f64/str 形态属 C2)');
  }

  // ---- 常量定义(发射期收集;f64 用 17 位有效数字往返)----
  emitConstDefs() {
    const lines = [];
    for (const [name, ty] of this.usedConsts) {
      const c = this.resolveConst({ modFile: this.check.entry?.file }, name);
      if (!c) throw new Unsupported('常量 ' + name);
      if (ty === 'f64') lines.push(`static const double g_${name} = ${Number(c.v).toExponential(16)};`);
      else if (ty === 'u64') lines.push(`static const unsigned long long g_${name} = ${c.v}ULL;`);
      else lines.push(`static const long long g_${name} = ${c.v}LL;`);
    }
    return lines;
  }

  // ---- 顶层 ----
  run() {
    // v0.39:eligible 为空也继续 —— 只有 main 的程序(main 本身带 io 不 eligible)
    // 只要 main 具备 AOT 形态就是合法的 C1 产物;main 形态不符由发射期报 Unsupported
    this.eligible = analyzeEligibility(this.check, this.compiled, { numericOnly: true });
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
      if (retTy) ctx.line('return 0;');
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
    const parts = [
      '/* 由 ming cc 生成(Ming C 后端 C1)— 请勿手改 */',
      '#include <stdio.h>',
      '#include <stdlib.h>',
      '#include <limits.h>',
      '#include <math.h>',
      '#ifdef _WIN32',
      '#include <io.h>',
      '#include <fcntl.h>',
      '#endif',
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
