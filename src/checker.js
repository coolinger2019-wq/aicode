// checker.js — Ming 类型检查器。
// 职责:多文件模块加载、名字解析、双向类型检查与推断、穷尽性检查、
//       流分析(缺 return)、可变性检查、内置方法签名表、结构化诊断。
//
// 类型表示(普通对象):
//   {k:'int',bits,signed} {k:'float',bits} {k:'bool'} {k:'str'} {k:'unit'} {k:'never'}
//   {k:'vec',el} {k:'map',kt,vt} {k:'opt',el} {k:'res',ok,err}
//   {k:'tuple',ts} {k:'fn',ps,ret}
//   {k:'struct',name,def,targs} {k:'enum',name,def,targs}   — def 指向 Decl,按引用比较
//   {k:'range',el}
//   {k:'ptr',el,mut}   — v0.54:不透明指针(仅 el=u8;mut 区分 Ptr[mut u8]/Ptr[u8],无隐式转换)
//   {k:'param',name}   — 泛型参数(检查体内)
//   {k:'var',id}       — 推断变量,由 binds 解析

import { err, warn, MingError, CODE_HINTS } from './diag.js';
import { parse } from './parser.js';
import { linFromInt, linAdd, linMulConst, linIsConst, linEvalAt, proveImplication, solveDiffConstraints } from './prover.js';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

// ===================== 类型工具 =====================

export const T_BOOL = { k: 'bool' };
export const T_STR = { k: 'str' };
export const T_UNIT = { k: 'unit' };
export const T_NEVER = { k: 'never' };

export function tint(bits, signed = true) { return { k: 'int', bits, signed }; }
export function tfloat(bits) { return { k: 'float', bits }; }
export function mkVec(el) { return { k: 'vec', el }; }
export function mkMap(kt, vt) { return { k: 'map', kt, vt }; }
export function mkOpt(el) { return { k: 'opt', el }; }
export function mkRes(ok, er) { return { k: 'res', ok, err: er }; }
export function mkTuple(ts) { return { k: 'tuple', ts }; }
export function mkFn(ps, ret, effects = new Set()) { return { k: 'fn', ps, ret, effects }; }
export function mkRange(el) { return { k: 'range', el }; }
export function mkJoin(el) { return { k: 'join', el }; }
// v0.54:Ptr 类型面 {k:'ptr', el, mut};el 当前只允许 u8(检查器 resolveTypeAst 强制)
export function mkPtr(el, mut = false) { return { k: 'ptr', el, mut: !!mut }; }

export const INT_TYPES = {
  i8: tint(8, true), i16: tint(16, true), i32: tint(32, true), i64: tint(64, true),
  u8: tint(8, false), u16: tint(16, false), u32: tint(32, false), u64: tint(64, false),
};
export const FLOAT_TYPES = { f32: tfloat(32), f64: tfloat(64) };
export const PRIM_TYPES = { ...INT_TYPES, ...FLOAT_TYPES, bool: T_BOOL, str: T_STR };

export function tvar(binds = null) {
  const t = { k: 'var', id: nextVarId++ };
  if (binds) binds.set(t.id, t);
  return t;
}
let nextVarId = 0;
export function resetVarIds() { nextVarId = 0; }

export function resolveT(t, binds) {
  while (t && t.k === 'var' && binds.has(t.id)) t = binds.get(t.id);
  return t;
}

function occurs(t, id, binds) {
  t = resolveT(t, binds);
  if (!t) return false;
  switch (t.k) {
    case 'var': return t.id === id;
    case 'vec': return occurs(t.el, id, binds);
    case 'map': return occurs(t.kt, id, binds) || occurs(t.vt, id, binds);
    case 'opt': return occurs(t.el, id, binds);
    case 'res': return occurs(t.ok, id, binds) || occurs(t.err, id, binds);
    case 'tuple': return t.ts.some(x => occurs(x, id, binds));
    case 'fn': return t.ps.some(x => occurs(x, id, binds)) || occurs(t.ret, id, binds);
    case 'range': return occurs(t.el, id, binds);
    case 'ptr': return occurs(t.el, id, binds);
    case 'struct': case 'enum': return (t.targs ?? []).some(x => occurs(x, id, binds));
    default: return false;
  }
}

function effectsSubset(a, b) {
  const as = a.effects ?? new Set();
  const bs = b.effects ?? new Set();
  for (const e of as) if (!bs.has(e)) return false;
  return true;
}

// 尝试统一;成功返回 true(可能写入 binds)
// 顺序关键:var 绑定优先(推断),param 只在两侧都非 var 时绑定(泛型 impl 的结构匹配)
export function unify(a, b, binds) {
  a = resolveT(a, binds); b = resolveT(b, binds);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.k === 'var') {
    if (occurs(b, a.id, binds)) return false;
    binds.set(a.id, b); return true;
  }
  if (b.k === 'var') {
    if (occurs(a, b.id, binds)) return false;
    binds.set(b.id, a); return true;
  }
  if (a.k === 'param') { binds.set('param:' + a.name, b); return true; }
  if (b.k === 'param') { binds.set('param:' + b.name, a); return true; }
  if (a.k !== b.k) {
    if (a.k === 'never') return true; // never 兼容一切
    if (b.k === 'never') return true;
    return false;
  }
  switch (a.k) {
    case 'int': return a.bits === b.bits && a.signed === b.signed;
    case 'float': return a.bits === b.bits;
    case 'bool': case 'str': case 'unit': case 'never': case 'json': return true; // v0.44:json 缺失曾被误判为不兼容(Json 值无法传参/赋值)
    case 'vec': return unify(a.el, b.el, binds);
    case 'range': return unify(a.el, b.el, binds);
    // v0.54:Ptr 精确匹配——mut/非 mut 不同型,无隐式转换
    case 'ptr': return a.mut === b.mut && unify(a.el, b.el, binds);
    case 'join': return unify(a.el, b.el, binds);
    case 'opt': return unify(a.el, b.el, binds);
    case 'res': return unify(a.ok, b.ok, binds) && unify(a.err, b.err, binds);
    case 'map': return unify(a.kt, b.kt, binds) && unify(a.vt, b.vt, binds);
    case 'tuple': return a.ts.length === b.ts.length && a.ts.every((x, i) => unify(x, b.ts[i], binds));
    case 'fn': return a.ps.length === b.ps.length && a.ps.every((x, i) => unify(x, b.ps[i], binds)) && unify(a.ret, b.ret, binds) && effectsSubset(a, b);
    case 'struct': case 'enum':
      return a.def === b.def && (a.targs ?? []).length === (b.targs ?? []).length
        && (a.targs ?? []).every((x, i) => unify(x, b.targs[i], binds));
    default: return false;
  }
}

export function typeStr(t, binds = null) {
  const b = binds ?? new Map();
  const r = (x) => typeStr(x, b);
  t = resolveT(t, b);
  if (!t) return '?';
  switch (t.k) {
    case 'int': return Object.entries(INT_TYPES).find(([, v]) => v.bits === t.bits && v.signed === t.signed)?.[0] ?? `i${t.bits}`;
    case 'float': return t.bits === 32 ? 'f32' : 'f64';
    case 'bool': return 'bool';
    case 'str': return 'str';
    case 'json': return 'Json';
    case 'unit': return '()';
    case 'never': return '!';
    case 'var': return '?';
    case 'vec': return `Vec[${r(t.el)}]`;
    case 'map': return `Map[${r(t.kt)}, ${r(t.vt)}]`;
    case 'opt': return `Option[${r(t.el)}]`;
    case 'res': return `Result[${r(t.ok)}, ${r(t.err)}]`;
    case 'range': return `Range[${r(t.el)}]`;
    case 'join': return `Join[${r(t.el)}]`;
    case 'ptr': return `Ptr[${t.mut ? 'mut ' : ''}${r(t.el)}]`; // v0.54
    case 'tuple': return t.ts.length === 0 ? '()' : `(${t.ts.map(r).join(', ')})`;
    case 'fn': { const base = `(${t.ps.map(r).join(', ')}) -> ${r(t.ret)}`; const es = [...(t.effects ?? [])]; return es.length ? base + ' with ' + es.join(', ') : base; }
    case 'param': return t.name;
    case 'typename': case 'typeobj': return t.prim ?? t.name;
    case 'typeref': return t.entry?.decl?.name ?? t.name;
    case 'ctor': return `${t.enumT?.name ?? '?'}.${t.variant}`;
    case 'builtinmod': return `std.${t.mod}.${t.fn?.name}`;
    case 'struct': case 'enum': {
      const base = t.targs?.length ? `${t.name}[${t.targs.map(r).join(', ')}]` : t.name;
      return base;
    }
    default: return '?';
  }
}

// 判断类型是否可安全做 == (运行时结构相等)
export function isComparable(t, binds) {
  t = resolveT(t, binds);
  if (!t) return true;
  switch (t.k) {
    case 'fn': return false;
    case 'vec': return isComparable(t.el, binds);
    case 'ptr': return false; // v0.54:Ptr 不支持 ==/!=(用 is_null)
    case 'map': return isComparable(t.kt, binds) && isComparable(t.vt, binds);
    case 'opt': return isComparable(t.el, binds);
    case 'res': return isComparable(t.ok, binds) && isComparable(t.err, binds);
    case 'tuple': return t.ts.every(x => isComparable(x, binds));
    case 'struct': return (t.def?.fields ?? []).every(f => isComparable(f.type, binds));
    case 'enum': return t.def.variants.every(v => v.types.every(x => isComparable(x, binds)));
    default: return true;
  }
}

// 值语义深拷贝代价提示:大集合按值传递会拷贝(v0.1 语义;路线图:写时复制)
export function isPrimitiveDisplay(t, binds) {
  t = resolveT(t, binds);
  return t && ['int', 'float', 'bool', 'str'].includes(t.k);
}

// ===================== 效果系统 =====================
// v0.2 已开放:io(stdout/stderr/stdin)、time(时钟)。
// 副作用必须显式声明并逐层传播;声明为纯函数的代码在编译期即可证明无副作用。
export const KNOWN_EFFECTS = new Set(['io', 'time', 'fs', 'net', 'sync', 'proc', 'env', 'rand', 'crypto', 'ffi', 'unsafe']); // v0.54:unsafe

// ===================== prelude traits =====================
// Eq / ToStr 隐式存在,无需 use。Self 表示"实现者类型"。
// v0.2 限制:trait 方法无默认实现;impl 只针对非泛型用户类型;原始类型内置实现 Eq/ToStr。
const T_SELF = { k: 'selftype' };

export const TRAIT_PRELUDE = {
  Eq: {
    name: 'Eq',
    methods: new Map([['eq', { name: 'eq', params: [{ name: 'other', type: T_SELF }], ret: T_BOOL, selfMut: false }]]),
  },
  ToStr: {
    name: 'ToStr',
    methods: new Map([['to_str', { name: 'to_str', params: [], ret: T_STR, selfMut: false }]]),
  },
  Compare: {
    name: 'Compare',
    methods: new Map([['cmp', { name: 'cmp', params: [{ name: 'other', type: T_SELF }], ret: INT_TYPES.i64, selfMut: false }]]),
  },
};

export const BUILTIN_EQ_TYPES = new Set(['int', 'float', 'bool', 'str']);
export const BUILTIN_TOSTR_TYPES = new Set(['int', 'float', 'bool', 'str']);
export const BUILTIN_CMP_TYPES = new Set(['int', 'float', 'str']);

// ===================== 内置全局函数签名 =====================

// sig(params:[Type|'any'], minArgs, maxArgs, ret, effect?: 'io'|'time')
export const BUILTIN_FNS = {
  print: { params: ['display'], ret: T_UNIT, effect: 'io' },
  eprint: { params: ['display'], ret: T_UNIT, effect: 'io' },
  print_raw: { params: ['display'], ret: T_UNIT, effect: 'io' },
  str: { params: ['display'], ret: T_STR },
  debug: { params: ['any'], ret: T_STR, noFn: true },
  assert: { params: [T_BOOL, T_STR], min: 1, max: 2, ret: T_UNIT },
  assert_eq: { params: ['eq', 'eq'], ret: T_UNIT },
  panic: { params: [T_STR], ret: T_NEVER },
};

// prelude 变体别名:裸名 → 内置枚举变体
export const PRELUDE_VARIANTS = {
  Some: { enumName: 'Option', variant: 'Some' },
  None: { enumName: 'Option', variant: 'None' },
  Ok: { enumName: 'Result', variant: 'Ok' },
  Err: { enumName: 'Result', variant: 'Err' },
};

// ===================== stdlib 模块签名 =====================

function mF(name, params, ret, extra = {}) { return { name, params, ret, ...extra }; }
export const STD_MODULES = {
  math: {
    fns: [
      mF('sqrt', [tfloat(64)], tfloat(64)), mF('pow', [tfloat(64), tfloat(64)], tfloat(64)),
      mF('abs', [tfloat(64)], tfloat(64)), mF('floor', [tfloat(64)], tfloat(64)),
      mF('ceil', [tfloat(64)], tfloat(64)), mF('round', [tfloat(64)], tfloat(64)),
      mF('min', [tfloat(64), tfloat(64)], tfloat(64)), mF('max', [tfloat(64), tfloat(64)], tfloat(64)),
      mF('exp', [tfloat(64)], tfloat(64)), mF('ln', [tfloat(64)], tfloat(64)),
      mF('sin', [tfloat(64)], tfloat(64)), mF('cos', [tfloat(64)], tfloat(64)),
      mF('tan', [tfloat(64)], tfloat(64)),
      mF('asin', [tfloat(64)], tfloat(64)), mF('acos', [tfloat(64)], tfloat(64)),
      mF('atan', [tfloat(64)], tfloat(64)), mF('atan2', [tfloat(64), tfloat(64)], tfloat(64)),
      mF('sinh', [tfloat(64)], tfloat(64)), mF('cosh', [tfloat(64)], tfloat(64)),
      mF('tanh', [tfloat(64)], tfloat(64)),
      mF('log2', [tfloat(64)], tfloat(64)), mF('log10', [tfloat(64)], tfloat(64)),
      mF('cbrt', [tfloat(64)], tfloat(64)), mF('hypot', [tfloat(64), tfloat(64)], tfloat(64)),
      mF('pi', [], tfloat(64)), mF('e', [], tfloat(64)),
    ],
  },
  io: {
    fns: [
      mF('read_line', [], T_STR, { effect: 'io' }),
      mF('read_to_end', [], T_STR, { effect: 'io' }),
      mF('read_to_end', [], T_STR, { effect: 'io' }),
    ],
  },
  time: {
    fns: [
      mF('now_ms', [], INT_TYPES.i64, { effect: 'time' }),
      mF('sleep', [INT_TYPES.i64], T_UNIT, { effect: 'time' }),
      mF('monotonic_ms', [], INT_TYPES.i64, { effect: 'time' }),
      mF('date_parts', [INT_TYPES.i64], { k: 'json' }, { effect: 'time' }),
      mF('format_iso', [INT_TYPES.i64], T_STR, { effect: 'time' }),
      mF('parse_iso', [T_STR], mkRes(INT_TYPES.i64, T_STR), { effect: 'time' }),
    ],
  },
  // 文件系统(capability:必须声明 fs 效果才可调用)
  fs: {
    fns: [
      mF('read_file', [T_STR], mkRes(T_STR, T_STR), { effect: 'fs' }),
      mF('write_file', [T_STR, T_STR], mkRes(T_BOOL, T_STR), { effect: 'fs' }),
      mF('append_file', [T_STR, T_STR], mkRes(T_BOOL, T_STR), { effect: 'fs' }),
      mF('exists', [T_STR], T_BOOL, { effect: 'fs' }),
      mF('is_dir', [T_STR], T_BOOL, { effect: 'fs' }),
      mF('list_dir', [T_STR], mkRes(mkVec(T_STR), T_STR), { effect: 'fs' }),
      mF('make_dir', [T_STR], mkRes(T_BOOL, T_STR), { effect: 'fs' }),
      mF('remove_file', [T_STR], mkRes(T_BOOL, T_STR), { effect: 'fs' }),
      mF('metadata', [T_STR], mkRes({ k: 'json' }, T_STR), { effect: 'fs' }),
      mF('copy_file', [T_STR, T_STR], mkRes(T_BOOL, T_STR), { effect: 'fs' }),
      mF('rename', [T_STR, T_STR], mkRes(T_BOOL, T_STR), { effect: 'fs' }),
      mF('remove_dir', [T_STR], mkRes(T_BOOL, T_STR), { effect: 'fs' }),
      mF('remove_dir_recursive', [T_STR], mkRes(T_BOOL, T_STR), { effect: 'fs' }),
      mF('read_bytes', [T_STR], mkRes(mkVec(INT_TYPES.u8), T_STR), { effect: 'fs' }),
      mF('write_bytes', [T_STR, mkVec(INT_TYPES.u8)], mkRes(T_BOOL, T_STR), { effect: 'fs' }),
      mF('append_bytes', [T_STR, mkVec(INT_TYPES.u8)], mkRes(T_BOOL, T_STR), { effect: 'fs' }),
    ],
  },
  // 正则(JS RegExp 桥接;pattern 非法 = 程序员错误 → panic;纯函数,wasm 内自动回落)
  re: {
    fns: [
      mF('is_match', [T_STR, T_STR], T_BOOL),
      mF('find', [T_STR, T_STR], mkOpt(T_STR)),
      mF('find_all', [T_STR, T_STR], mkVec(T_STR)),
      mF('replace', [T_STR, T_STR, T_STR], T_STR),
      mF('split', [T_STR, T_STR], mkVec(T_STR)),
      mF('is_match_bytes', [T_STR, mkVec(INT_TYPES.u8)], T_BOOL),
      mF('find_bytes', [T_STR, mkVec(INT_TYPES.u8)], mkOpt(mkVec(INT_TYPES.u8))),
      mF('replace_bytes', [T_STR, mkVec(INT_TYPES.u8), mkVec(INT_TYPES.u8)], mkVec(INT_TYPES.u8)),
    ],
  },
  // 随机数(能力:rand;确定性模式:seed 后同序列)
  rand: {
    fns: [
      mF('u64', [], INT_TYPES.u64, { effect: 'rand' }),
      mF('f64', [], tfloat(64), { effect: 'rand' }),
      mF('range', [INT_TYPES.i64, INT_TYPES.i64], INT_TYPES.i64, { effect: 'rand' }),
      mF('seed', [INT_TYPES.u64], T_UNIT, { effect: 'rand' }),
    ],
  },
  // 密码学哈希(能力:crypto;node:crypto 桥接;安全工具之北支柱 6 第一块,v0.34)
  crypto: {
    fns: [
      mF('md5', [T_STR], T_STR, { effect: 'crypto' }),
      mF('sha1', [T_STR], T_STR, { effect: 'crypto' }),
      mF('sha256', [T_STR], T_STR, { effect: 'crypto' }),
      mF('sha384', [T_STR], T_STR, { effect: 'crypto' }),
      mF('sha512', [T_STR], T_STR, { effect: 'crypto' }),
      mF('hmac_md5', [T_STR, T_STR], T_STR, { effect: 'crypto' }),
      mF('hmac_sha1', [T_STR, T_STR], T_STR, { effect: 'crypto' }),
      mF('hmac_sha256', [T_STR, T_STR], T_STR, { effect: 'crypto' }),
      mF('hmac_sha384', [T_STR, T_STR], T_STR, { effect: 'crypto' }),
      mF('hmac_sha512', [T_STR, T_STR], T_STR, { effect: 'crypto' }),
      mF('aes256_encrypt', [T_STR, T_STR], mkRes(mkVec(INT_TYPES.u8), T_STR), { effect: 'crypto' }),
      mF('aes256_decrypt', [T_STR, mkVec(INT_TYPES.u8)], mkRes(T_STR, T_STR), { effect: 'crypto' }),
      mF('aes256_gcm_encrypt', [T_STR, T_STR], mkRes(mkVec(INT_TYPES.u8), T_STR), { effect: 'crypto' }),
      mF('aes256_gcm_decrypt', [T_STR, mkVec(INT_TYPES.u8)], mkRes(T_STR, T_STR), { effect: 'crypto' }),
    ],
  },
  // 二进制显式字节序打包/解包(纯函数;安全工具之北支柱 1:拒绝隐式端序,be/le 显式枚举;v0.35)
  bin: {
    fns: [
      mF('pack_u16_le', [INT_TYPES.i64], mkVec(INT_TYPES.u8)),
      mF('pack_u16_be', [INT_TYPES.i64], mkVec(INT_TYPES.u8)),
      mF('pack_u32_le', [INT_TYPES.i64], mkVec(INT_TYPES.u8)),
      mF('pack_u32_be', [INT_TYPES.i64], mkVec(INT_TYPES.u8)),
      mF('pack_u64_le', [INT_TYPES.i64], mkVec(INT_TYPES.u8)),
      mF('pack_u64_be', [INT_TYPES.i64], mkVec(INT_TYPES.u8)),
      mF('unpack_u16_le', [mkVec(INT_TYPES.u8), INT_TYPES.i64], mkRes(INT_TYPES.i64, T_STR)),
      mF('unpack_u16_be', [mkVec(INT_TYPES.u8), INT_TYPES.i64], mkRes(INT_TYPES.i64, T_STR)),
      mF('unpack_u32_le', [mkVec(INT_TYPES.u8), INT_TYPES.i64], mkRes(INT_TYPES.i64, T_STR)),
      mF('unpack_u32_be', [mkVec(INT_TYPES.u8), INT_TYPES.i64], mkRes(INT_TYPES.i64, T_STR)),
      mF('unpack_u64_le', [mkVec(INT_TYPES.u8), INT_TYPES.i64], mkRes(INT_TYPES.i64, T_STR)),
      mF('unpack_u64_be', [mkVec(INT_TYPES.u8), INT_TYPES.i64], mkRes(INT_TYPES.i64, T_STR)),
    ],
  },
  // HTTP 客户端(capability:必须声明 net 效果;同步实现:worker + Atomics)
  net: {
    fns: [
      mF('http_get', [T_STR], mkRes(mkTuple([INT_TYPES.i64, T_STR]), T_STR), { effect: 'net' }),
      mF('http_request', [T_STR, T_STR, mkMap(T_STR, T_STR), T_STR], mkRes(mkTuple([INT_TYPES.i64, T_STR]), T_STR), { effect: 'net', min: 3, max: 4 }),
      mF('http_request_opts', [T_STR, T_STR, mkMap(T_STR, T_STR), T_STR, INT_TYPES.i64], mkRes(mkTuple([INT_TYPES.i64, mkMap(T_STR, T_STR), T_STR]), T_STR), { effect: 'net' }),
    ],
  },
  // 格式化(纯函数;v0.27)
  fmt: {
    fns: [
      mF('fixed', [tfloat(64), INT_TYPES.i64], T_STR),
      mF('hex', [INT_TYPES.i64], T_STR),
      mF('bin', [INT_TYPES.i64], T_STR),
      mF('exp', [tfloat(64), INT_TYPES.i64], T_STR),
      mF('align', [T_STR, INT_TYPES.i64, T_STR], T_STR),
    ],
  },
  // 日志(能力:io;级别过滤,stderr 输出;v0.28)
  log: {
    fns: [
      mF('debug', [T_STR], T_UNIT, { effect: 'io' }),
      mF('info', [T_STR], T_UNIT, { effect: 'io' }),
      mF('warn', [T_STR], T_UNIT, { effect: 'io' }),
      mF('error', [T_STR], T_UNIT, { effect: 'io' }),
      mF('set_level', [T_STR], T_UNIT, { effect: 'io' }),
      mF('get_level', [], T_STR, { effect: 'io' }),
    ],
  },
  // 操作系统进程(能力:proc;worker 同步化)
  proc: {
    fns: [
      mF('exec', [T_STR, mkVec(T_STR)], mkRes(mkTuple([INT_TYPES.i64, T_STR, T_STR]), T_STR), { effect: 'proc' }),
    ],
  },
  // 环境变量(能力:env)
  env: {
    fns: [
      mF('get', [T_STR], mkOpt(T_STR), { effect: 'env' }),
      mF('set', [T_STR, T_STR], mkRes(T_BOOL, T_STR), { effect: 'env' }),
      mF('remove', [T_STR], T_BOOL, { effect: 'env' }),
    ],
  },
  // 结构化并发(能力:sync;spawn/join/join_detailed 走特例签名)
  sync: {
    fns: [
      mF('spawn', [], mkJoin(tvar()), { effect: 'sync' }),
      mF('spawn_all', [], mkVec(mkRes(tvar(), T_STR)), { effect: 'sync' }),
      mF('join', [], mkRes(tvar(), T_STR), { effect: 'sync' }),
      mF('join_detailed', [], mkRes(tvar(), { k: 'json' }), { effect: 'sync' }),
      mF('cancel', [], T_BOOL, { effect: 'sync' }),
    ],
  },
  // JSON(纯函数)
  json: {
    fns: [
      mF('stringify', ['jsonval'], T_STR),
      mF('parse', [T_STR], mkRes({ k: 'json' }, T_STR)),
    ],
  },
  // 路径工具(纯函数,无效果)
  path: {
    fns: [
      mF('join', [T_STR, T_STR], T_STR),
      mF('base_name', [T_STR], T_STR),
      mF('dir_name', [T_STR], T_STR),
      mF('extension', [T_STR], T_STR),
    ],
  },
  // v0.54:原生存取(能力 unsafe;C 后端兑现,tree/VM 运行时 M4016 诚实拒绝)
  mem: {
    fns: [
      mF('alloc', [INT_TYPES.i64], mkPtr(INT_TYPES.u8, true), { effect: 'unsafe' }),
      mF('free', [mkPtr(INT_TYPES.u8, true)], T_UNIT, { effect: 'unsafe' }),
    ],
  },
};

// ===================== 方法表(签名)=====================
// 每个方法:recv → 参数类型/返回类型的求解函数。T 表示接收者元素类型。
// mut: true 表示修改接收者,要求接收者是可变位置。
// special: 'map' | 'fold' 等需要在 checkMethod 中特殊处理。

export const MUT_METHODS = new Set(['push', 'pop', 'reverse', 'sort', 'sort_by', 'insert', 'remove', 'extend', 'clear', 'set', 'delete']);
export const METHOD_NAMES = {
  vec: ['len', 'push', 'pop', 'get', 'first', 'last', 'contains', 'index_of', 'reverse',
    'sort', 'sort_by', 'map', 'filter', 'fold', 'join', 'slice', 'insert', 'remove',
    'extend', 'clear', 'clone', 'is_empty', 'min', 'max', 'to_str'],
  map: ['len', 'get', 'set', 'has', 'delete', 'keys', 'values', 'items', 'clear', 'clone', 'is_empty'],
  str: ['char_len', 'byte_len', 'chars', 'bytes', 'split', 'trim', 'trim_start', 'trim_end',
    'to_upper', 'to_lower', 'starts_with', 'ends_with', 'contains', 'replace', 'repeat',
    'get', 'slice_chars', 'parse_i64', 'parse_f64', 'is_empty',
    'is_alpha', 'is_digit', 'is_space', 'is_upper', 'is_lower', 'pad_left', 'pad_right', 'to_bytes'],
  opt: ['unwrap', 'expect', 'unwrap_or', 'is_some', 'is_none'],
  res: ['unwrap', 'unwrap_err', 'expect', 'unwrap_or', 'is_ok', 'is_err'],
  int: ['abs', 'to_f32', 'to_f64', 'to_i8', 'to_i16', 'to_i32', 'to_i64', 'to_u8', 'to_u16', 'to_u32', 'to_u64'],
  float: ['abs', 'to_fixed', 'to_f32', 'to_f64', 'to_i8', 'to_i16', 'to_i32', 'to_i64', 'to_u8', 'to_u16', 'to_u32', 'to_u64', 'is_nan', 'is_infinite'],
};
export const TYPE_LEVEL_FNS = {
  int: ['max_value', 'min_value'],
  float: ['infinity', 'neg_infinity', 'nan'],
};

// ===================== 模块 =====================

class Module {
  constructor(file, absPath, src) {
    this.file = file;          // 展示用路径
    this.absPath = absPath;
    this.src = src;
    this.items = new Map();    // name → {kind:'fn'|'struct'|'enum'|'test', decl, pub}
    this.imports = new Map();  // bindName → {std: [...segs]} | {local: Module}
    this.localVarNames = new Set();
  }
  add(name, entry) {
    if (this.items.has(name)) return false;
    this.items.set(name, entry);
    return true;
  }
}

// ===================== 检查器 =====================

export class Checker {
  constructor(entryFile, readFile = null, options = null) {
    this.readFile = readFile ?? ((p) => nodeFs.readFileSync(p, 'utf8'));
    this.entryFile = entryFile;
    this.options = options ?? {};  // v0.52:checker 选项(--warn-unproven-index 由阶段 3 接 CLI)
    this.proofRecords = [];  // v0.52 阶段 3:边界证明逐义务记录(--proof-report 消费;只记录,不改诊断)
    this.modules = [];
    this.byPath = new Map();
    this.diags = [];
    this.entry = null;
    this.methodImpls = new Map();  // Map<def, Map<methodName, fnEntry>>
    this.implTraits = new Map();   // Map<def, Set<traitName>>
    this.implInfo = new Map();     // Map<def, Map<traitName, {tparams, bounds}>>
    this.methodEntries = [];       // 待检查体的 impl 方法(伪 fn entry)
    // v0.54 审查 B3:容器/构造器载荷点已报 M3046 的 span(参数传递检查据此去重,
    // 避免 "take(H { p: q })" 在字面量点与实参点各报一次)
    this.ptrPayloadSpans = new Set();
  }

  // ---------- 加载 ----------
  load(absPath, displayFile, importChain = []) {
    if (this.byPath.has(absPath)) return this.byPath.get(absPath);
    let src;
    try {
      src = this.readFile(absPath);
    } catch (e) {
      throw new MingError([err('M3022', `无法读取模块文件 "${displayFile}": ${e.message}`, importChain.length ? importChain[importChain.length - 1].span : null)]);
    }
    const { program, diags } = parse(displayFile, src);
    const mod = new Module(displayFile, absPath, src);
    mod.program = program;
    this.byPath.set(absPath, mod);
    this.modules.push(mod);
    for (const d of diags) this.diags.push(d);

    // 递归加载 use
    for (const item of program.items) {
      if (item.nt !== 'UseDecl') continue;
      const bind = item.alias ?? item.segs[item.segs.length - 1];
      if (item.segs[0] === 'std') {
        const sub = item.segs.slice(1);
        if (sub.length !== 1 || !STD_MODULES[sub[0]]) {
          this.diags.push(err('M3022', `未知的标准库模块 "std.${sub.join('.')}"(可用:${Object.keys(STD_MODULES).join(', ')})`, item.span));
          continue;
        }
        mod.imports.set(bind, { std: sub[0], span: item.span });
      } else {
        const rel = item.segs.join('/') + '.ming';
        const target = nodePath.resolve(nodePath.dirname(absPath), rel);
        if (importChain.some(c => c.absPath === target)) {
          this.diags.push(err('M3025', `模块循环导入:${[...importChain.map(c => c.file), displayFile].join(' → ')}`, item.span));
          continue;
        }
        if (!nodeFs.existsSync(target)) {
          this.diags.push(err('M3022', `找不到模块文件 "${rel}"(相对于 ${displayFile})`, item.span,
            'use 路径按文件解析:use geom; → 同目录 geom.ming;use utils.math; → utils/math.ming。'));
          continue;
        }
        mod.imports.set(bind, { local: this.load(target, rel, [...importChain, { absPath, file: displayFile, span: item.span }]), span: item.span });
      }
    }
    return mod;
  }

  // ---------- 项注册 ----------
  register(mod) {
    mod.impls = mod.impls ?? [];
    for (const item of mod.program.items) {
      switch (item.nt) {
        case 'StructDecl':
          if (!mod.add(item.name, { kind: 'struct', decl: item, pub: item.pub }))
            this.dupDiag(mod, item.name, item.span);
          break;
        case 'EnumDecl':
          if (!mod.add(item.name, { kind: 'enum', decl: item, pub: item.pub }))
            this.dupDiag(mod, item.name, item.span);
          break;
        case 'FnDecl':
          if (!mod.add(item.name, { kind: 'fn', decl: item, pub: item.pub }))
            this.dupDiag(mod, item.name, item.span);
          break;
        case 'ExternFnDecl': {
          // v0.42:extern fn —— FFI 声明(隐含 ffi 效果,调用方须 with ffi)。
          // 合成桩体让 JS 引擎在运行时以 M4001 明确拒绝;C 后端经 dlsym 兑现真实现。
          const stubCall = { nt: 'Call', callee: { nt: 'Ident', name: 'panic', span: item.span }, args: [{ nt: 'StrLit', parts: [{ lit: 'ffi 调用需要 C 后端(ming cc);JS 引擎不执行 FFI' }], span: item.span }], span: item.span };
          const shaped = { ...item, body: { stmts: [{ nt: 'ExprStmt', expr: stubCall, span: item.span }], tail: null, span: item.span }, span: item.span };
          if (!mod.add(item.name, { kind: 'fn', decl: shaped, pub: false, extern: { lib: item.lib } }))
            this.dupDiag(mod, item.name, item.span);
          break;
        }
        case 'TestDecl':
          if (!mod.add('test:' + item.name, { kind: 'test', decl: item, pub: false }))
            this.dupDiag(mod, 'test ' + item.name, item.span);
          break;
        case 'ConstDecl':
          if (!mod.add(item.name, { kind: 'const', decl: item, pub: item.pub }))
            this.dupDiag(mod, item.name, item.span);
          break;
        case 'TraitDecl':
          if (!mod.add(item.name, { kind: 'trait', decl: item, pub: item.pub }))
            this.dupDiag(mod, item.name, item.span);
          break;
        case 'ImplDecl':
          mod.impls.push(item);
          break;
      }
    }
  }

  dupDiag(mod, name, span) {
    this.diags.push(err('M3009', `"${name}" 在模块 ${mod.file} 中重复定义`, span));
  }

  // ---------- 类型解析 ----------
  resolveTypeAst(ast, mod, tparams = new Map(), selfMode = null) {
    const self = this;
    function go(t) {
      switch (t.nt) {
        case 'TName': {
          if (t.name === 'Self') {
            if (selfMode === 'trait') return T_SELF;
            if (selfMode && typeof selfMode === 'object') return selfMode;
            self.diags.push(err('M3001', '"Self" 只能在 trait 声明或 impl 方法中使用', t.span));
            return T_UNIT;
          }
          const parts = t.name.split('.');
          // 泛型参数
          if (parts.length === 1 && tparams.has(t.name)) {
            if (t.args.length) self.diagT(t.span, `泛型参数 "${t.name}" 不能再带类型参数`);
            return tparams.get(t.name);
          }
          // 内置基本类型
          if (parts.length === 1 && PRIM_TYPES[t.name]) {
            if (t.args.length) self.diagT(t.span, `基本类型 "${t.name}" 不带类型参数`);
            return PRIM_TYPES[t.name];
          }
          // v0.54:Ptr[mut u8] / Ptr[u8](不透明指针;仅 u8 元素,无隐式转换)
          if (parts.length === 1 && t.name === 'Ptr') {
            if (t.args.length !== 1) {
              self.diagT(t.span, `Ptr 需要 1 个类型参数,得到 ${t.args.length}(写法:Ptr[u8] 或 Ptr[mut u8])`);
              return mkPtr(INT_TYPES.u8, false);
            }
            let argAst = t.args[0];
            let mut = false;
            if (argAst.nt === 'TMut') { mut = true; argAst = argAst.type; }
            const el = go(argAst);
            if (!(el?.k === 'int' && el.bits === 8 && el.signed === false)) {
              self.diagT(argAst.span ?? t.span, `Ptr 的元素类型只支持 u8,得到 ${typeStr(el)}`);
              return mkPtr(INT_TYPES.u8, mut);
            }
            return mkPtr(el, mut);
          }
          if (parts.length === 1 && t.name === 'Vec') {
            if (t.args.length !== 1) self.diagT(t.span, `Vec 需要 1 个类型参数,得到 ${t.args.length}`);
            return mkVec(go(t.args[0]));
          }
          if (parts.length === 1 && t.name === 'Map') {
            if (t.args.length !== 2) self.diagT(t.span, `Map 需要 2 个类型参数,得到 ${t.args.length}`);
            { const kt = go(t.args[0]); const vt = go(t.args[1]); self.checkMapKey(kt, t.args[0].span ?? t.span); return mkMap(kt, vt); }
          }
          if (parts.length === 1 && t.name === 'Option') {
            if (t.args.length !== 1) self.diagT(t.span, `Option 需要 1 个类型参数,得到 ${t.args.length}`);
            return mkOpt(go(t.args[0]));
          }
          if (parts.length === 1 && t.name === 'Result') {
            if (t.args.length !== 2) self.diagT(t.span, `Result 需要 2 个类型参数,得到 ${t.args.length}`);
            return mkRes(go(t.args[0]), go(t.args[1]));
          }
          if (parts.length === 1 && t.name === 'Join') {
            if (t.args.length !== 1) self.diagT(t.span, `Join 需要 1 个类型参数,得到 ${t.args.length}`);
            return mkJoin(t.args.length ? go(t.args[0]) : tvar());
          }
          if (parts.length === 1 && t.name === 'Json') {
            if (t.args.length) self.diagT(t.span, 'Json 类型不带类型参数');
            return { k: 'json' };
          }
          if (parts.length === 1 && t.name === 'Range') {
            const el = t.args.length === 1 ? go(t.args[0]) : INT_TYPES.i64;
            if (el?.k !== 'int') self.diagT(t.span, `Range 的元素必须是整数类型`);
            return mkRange(el);
          }
          // 模块限定类型 geom.Point / 内置枚举 Option(x 方面已在上方处理)
          if (parts.length === 2) {
            const [modBind, typeName] = parts;
            if (modBind === 'std') { self.diagT(t.span, `"std" 不是类型命名空间`); return T_UNIT; }
            const imp = mod.imports.get(modBind);
            if (!imp) { self.cannotFindName(t.name, t.span, mod); return T_UNIT; }
            if (imp.std) { self.diagT(t.span, `"${modBind}" 是标准库模块,不含类型 "${typeName}"`); return T_UNIT; }
            const entry = imp.local.items.get(typeName);
            if (!entry || (entry.kind !== 'struct' && entry.kind !== 'enum')) {
              self.diagT(t.span, `模块 ${modBind} 中没有类型 "${typeName}"`);
              return T_UNIT;
            }
            if (!entry.pub) self.visDiag(entry, typeName, t.span, imp.local);
            return self.instantiateDecl(entry.decl, entry.kind, imp.local, t.args.map(go), t.span);
          }
          if (parts.length === 1 && (mod.items.get(t.name)?.kind === 'struct' || mod.items.get(t.name)?.kind === 'enum')) {
            const entry = mod.items.get(t.name);
            return self.instantiateDecl(entry.decl, entry.kind, mod, t.args.map(go), t.span);
          }
          self.cannotFindName(t.name, t.span, mod);
          return T_UNIT;
        }
        case 'TTuple': {
          if (t.ts.length === 0) return T_UNIT; // () 即 unit
          return mkTuple(t.ts.map(go));
        }
        case 'TFn': return mkFn(t.ps.map(go), go(t.ret));
        case 'TMut': {
          // v0.54:mut 只允许作为 Ptr 的元素修饰(如 let x: mut u8 非法)
          self.diagT(t.span, '"mut" 只能用于 Ptr 的元素类型,例如 Ptr[mut u8]');
          return go(t.type);
        }
        default:
          self.diagT(t.span, '无法解析的类型');
          return T_UNIT;
      }
    }
    return go(ast);
  }

  instantiateDecl(decl, kind, mod, targs, span) {
    const n = decl.tparams.length;
    if (targs.length !== n) {
      this.diags.push(err('M3005', `${kind === 'struct' ? '结构体' : '枚举'} ${decl.name} 需要 ${n} 个类型参数,得到 ${targs.length}`, span));
    }
    const targs2 = [];
    for (let i = 0; i < n; i++) targs2.push(targs[i] ?? tvar());
    if (kind === 'struct') {
      return { k: 'struct', name: decl.name, def: decl, mod, targs: targs2 };
    }
    return { k: 'enum', name: decl.name, def: decl, mod, targs: targs2 };
  }

  diagT(span, msg, hint) { this.diags.push(err('M3002', msg, span, hint)); }
  cannotFindName(name, span, mod, kindHint = '类型或值') {
    const avail = [...mod.items.keys()].filter(k => !k.startsWith('test:'));
    const near = nearest(name, avail);
    this.diags.push(err('M3001', `找不到${kindHint} "${name}"`, span,
      near ? `未定义;最接近的名字是 "${near}"` : `未定义;当前模块可见的名字:${avail.slice(0, 12).join(', ') || '(无)'}`));
  }
  visDiag(entry, name, span, fromMod) {
    if (!entry.pub) {
      this.diags.push(err('M3001', `"${name}" 在模块 ${fromMod.file} 中不是 pub,无法从这里访问`, span,
        '给目标声明加上 pub 前缀,或把逻辑放进同一模块。'));
    }
  }

  // ---------- 顶层入口 ----------
  run() {
    const entryAbs = nodePath.resolve(this.entryFile);
    // displayFile 保留调用方给的形式(LSP 需要绝对路径做诊断过滤;CLI 传相对路径显示友好)
    this.entry = this.load(entryAbs, this.entryFile);
    for (const m of this.modules) this.register(m);
    // 先解析所有模块的签名,再检查所有函数体(跨模块引用与递归)
    for (const m of this.modules) this.resolveSigs(m);
    for (const m of this.modules) this.resolveImpls(m);
    for (const m of this.modules) this.checkBodies(m);
    return { modules: this.modules, entry: this.entry, diags: this.diags, methodImpls: this.methodImpls, proofs: this.proofRecords };
  }

  resolveSigs(mod) {
    for (const [, entry] of mod.items) {
      if (entry.kind === 'fn') {
        const d = entry.decl;
        const tp = new Map(d.tparams.map(n => [n, { k: 'param', name: n }]));
        // 效果:名字校验 + 存入签名
        const effects = new Set();
        for (const e of d.effects ?? []) {
          if (!KNOWN_EFFECTS.has(e.name)) {
            this.diags.push(err('M3030', `未知的效果 "${e.name}"(可用:${[...KNOWN_EFFECTS].join(', ')})`, e.span));
            continue;
          }
          effects.add(e.name);
        }
        // v0.46 修复:解析恢复产物——顶层 fn 带裸 self(type:null)只可能来自
        // "impl 缺 for"的恢复路径(真实错误 M2002 已由解析器报告),此处不得崩溃;
        // 标记 poisoned,函数体检查跳过(调用方类型检查必然失败,编译不会发生)
        if (d.params.some(p => p.self && !p.type)) entry.poisoned = true;
        entry.sig = {
          tparams: d.tparams,
          bounds: d.bounds ?? [],
          params: d.params.map(p => ({ name: p.name, mut: !!p.mut, type: p.type ? this.resolveTypeAst(p.type, mod, tp) : T_UNIT, span: p.span })),
          ret: d.ret ? this.resolveTypeAst(d.ret, mod, tp) : T_UNIT,
          effects,
        };
      } else if (entry.kind === 'trait') {
        const d = entry.decl;
        const methodsSig = new Map();
        for (const m of d.methods) {
          const ps = [];
          for (let i = 1; i < m.params.length; i++) {
            if (!m.params[i].type) continue;
            ps.push({ name: m.params[i].name, type: this.resolveTypeAst(m.params[i].type, mod, new Map(), 'trait'), span: m.params[i].span });
          }
          const ret = m.ret ? this.resolveTypeAst(m.ret, mod, new Map(), 'trait') : T_UNIT;
          methodsSig.set(m.name, { name: m.name, params: ps, ret, selfMut: m.selfMut, span: m.span });
        }
        entry.methodsSig = methodsSig;
      } else if (entry.kind === 'struct' || entry.kind === 'enum') {
        const d = entry.decl;
        const tp = new Map(d.tparams.map(n => [n, { k: 'param', name: n }]));
        if (entry.kind === 'struct') {
          for (const f of d.fields) f.rtype = this.resolveTypeAst(f.type, mod, tp);
        } else {
          for (const v of d.variants) v.rtypes = v.types.map(t => this.resolveTypeAst(t, mod, tp));
        }
      } else if (entry.kind === 'const') {
        const d = entry.decl;
        entry.rtype = this.constExprType(d.init, mod, new Set([entry]));
        if (d.type) {
          const declared = this.resolveTypeAst(d.type, mod);
          if (!unify(entry.rtype, declared, new Map())) {
            this.diags.push(err('M3002', `常量 "${d.name}" 标注类型是 ${typeStr(declared)},但表达式是 ${typeStr(entry.rtype)}`, d.span));
          }
        }
      }
    }
  }

  // 常量表达式:字面量、四则/逻辑运算、字符串拼接、集合/元组字面量、其他常量的引用。
  // 调用、方法、字段访问等一律不是常量(M3031)。
  constExprType(ast, mod, visiting) {
    switch (ast.nt) {
      case 'IntLit': return tint(ast.bits, ast.signed);
      case 'FloatLit': return tfloat(ast.bits);
      case 'BoolLit': return T_BOOL;
      case 'StrLit': {
        for (const p of ast.parts) {
          if (p.expr) this.constExprType(p.expr, mod, visiting);
        }
        return T_STR;
      }
      case 'Unary': {
        const t = this.constExprType(ast.expr, mod, visiting);
        const r = resolveT(t, new Map());
        if (ast.op === '!' && r?.k === 'bool') return T_BOOL;
        if (ast.op === '-' && (r?.k === 'int' || r?.k === 'float')) return t;
        this.diags.push(err('M3031', '常量表达式:一元运算只支持 - (数字) 与 ! (bool)', ast.span));
        return null;
      }
      case 'Binary': {
        const lt = this.constExprType(ast.l, mod, visiting);
        const rt = this.constExprType(ast.r, mod, visiting);
        if (!lt || !rt) return null;
        const t = this.checkBinaryOp(ast.op, lt, rt, ast.span, new Map());
        return resolveT(t, new Map());
      }
      case 'VecLit': {
        let elT = null;
        for (const el of ast.elems) {
          const t = this.constExprType(el, mod, visiting);
          if (!t) return null;
          if (!elT) elT = t;
          else if (!unify(t, elT, new Map())) {
            this.diags.push(err('M3031', '常量数组的元素类型不一致', el.span));
          }
        }
        return mkVec(elT ?? tvar());
      }
      case 'MapLit': {
        let kt = null, vt = null;
        for (const en of ast.entries) {
          const k = this.constExprType(en.k, mod, visiting);
          const v = this.constExprType(en.v, mod, visiting);
          if (!k || !v) return null;
          if (!kt) kt = k;
          if (!vt) vt = v;
        }
        return mkMap(kt ?? tvar(), vt ?? tvar());
      }
      case 'TupleLit': {
        const ts = [];
        for (const el of ast.elems) {
          const t = this.constExprType(el, mod, visiting);
          if (!t) return null;
          ts.push(t);
        }
        return mkTuple(ts);
      }
      case 'Ident': {
        const entry = mod.items.get(ast.name);
        if (entry?.kind !== 'const') {
          this.diags.push(err('M3031', `常量表达式只能引用其他常量,不是 "${ast.name}"`, ast.span));
          return null;
        }
        if (visiting.has(entry)) {
          this.diags.push(err('M3031', `常量 "${ast.name}" 存在循环定义`, ast.span));
          return null;
        }
        if (!entry.rtype) entry.rtype = this.constExprType(entry.decl.init, mod, new Set([...visiting, entry]));
        return entry.rtype;
      }
      case 'As': {
        const t = this.constExprType(ast.expr, mod, visiting);
        const target = this.resolveTypeAst(ast.type, mod);
        const r = resolveT(t, new Map()), tr = resolveT(target, new Map());
        const numOk = (x) => x?.k === 'int' || x?.k === 'float';
        if (!numOk(r) || !numOk(tr)) {
          this.diags.push(err('M3019', `常量表达式中的 as 只支持数值类型`, ast.span));
          return null;
        }
        return target;
      }
      default:
        this.diags.push(err('M3031', '这里只能是常量表达式(字面量、运算、其他常量);不接受函数调用', ast.span));
        return null;
    }
  }

  checkBodies(mod) {
    for (const [, entry] of mod.items) {
      if (entry.kind === 'fn' && entry.decl.body) {
        if (entry.poisoned) continue; // v0.46:解析恢复产物(真实错误已在解析期报告)
        this.checkFnBody(entry, mod);
      }
      if (entry.kind === 'test') this.checkTest(entry, mod);
    }
    // impl 方法体(在 resolveImpls 中注册到 methodEntries)
    for (const entry of this.methodEntries) {
      if (entry.mod === mod) this.checkFnBody(entry, mod);
    }
    // v0.44:测试字面量过拟合检查(实现分支条件中出现测试断言的字面量)
    this.checkTestLiteralOverfit(mod);
    // v0.48(M3042):ensures 直线体符号执行(QF_LIA 第一片)
    for (const [, entry] of mod.items) {
      if (entry.kind === 'fn' && !entry.poisoned) this.checkEnsuresStatically(entry);
    }
    // v0.52 阶段 2(M3045/W3105,QF_LIA 第二片):requires 线性边界的 Vec 索引越界静态证明
    for (const [, entry] of mod.items) {
      if (entry.kind === 'fn' && !entry.poisoned) this.checkIndexBoundsStatically(entry, mod);
    }
  }

  // v0.44(Jenny E0905 的 Ming 版):收集本模块 test 块中的非常量字面量,
  // 扫描非测试函数 if/while 条件中的等值比较 → W3104 告警(不阻断)。
  checkTestLiteralOverfit(mod) {
    // 1) 测试字面量集合(key: 'i:42' / 's:abc';排除通用值)
    const lits = new Map();
    const collect = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) collect(x); return; }
      if (node.nt === 'IntLit' && typeof node.v === 'bigint') {
        if (node.v !== 0n && node.v !== 1n && node.v !== -1n && node.v !== 2n) {
          lits.set('i:' + node.v, { kind: 'int', v: node.v });
        }
      } else if (node.nt === 'StrLit' && node.parts?.length === 1 && 'lit' in node.parts[0]) {
        if (node.parts[0].lit !== '') lits.set('s:' + node.parts[0].lit, { kind: 'str', v: node.parts[0].lit });
      }
      for (const k of Object.keys(node)) {
        if (k === 'span' || k === 'docs') continue;
        const v = node[k];
        if (v && typeof v === 'object') collect(v);
      }
    };
    for (const [, entry] of mod.items) {
      if (entry.kind === 'test') collect(entry.decl.body);
    }
    if (lits.size === 0) return;
    // 2) 实现体:if/while 条件内的比较,一侧是变量、另一侧是测试字面量 → 告警
    const hit = (op, side, other, span) => {
      if (!['==', '!=', '<', '<=', '>', '>='].includes(op)) return;
      if (other?.nt !== 'Ident') return;
      if (side?.nt === 'IntLit' && typeof side.v === 'bigint') {
        const k = 'i:' + side.v;
        if (lits.has(k)) this.diags.push(warn('W3104', `测试字面量 ${side.v} 出现在实现分支条件中(可能针对测试硬编码;若为业务常量,提为命名常量)`, span ?? side.span, '把该值提为命名常量,或让测试使用生成的数据。'));
      } else if (side?.nt === 'StrLit' && side.parts?.length === 1 && 'lit' in side.parts[0]) {
        const k = 's:' + side.parts[0].lit;
        if (lits.has(k)) this.diags.push(warn('W3104', `测试字面量 "${side.parts[0].lit}" 出现在实现分支条件中(可能针对测试硬编码;若为业务常量,提为命名常量)`, span ?? side.span, '把该值提为命名常量,或让测试使用生成的数据。'));
      }
    };
    const walkCond = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) walkCond(x); return; }
      if (node.nt === 'Binary') {
        hit(node.op, node.l, node.r, node.span);
        hit(node.op, node.r, node.l, node.span);
      }
      for (const k of Object.keys(node)) {
        if (k === 'span' || k === 'docs' || k === 'lit') continue;
        const v = node[k];
        if (v && typeof v === 'object') walkCond(v);
      }
    };
    const walkBody = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) walkBody(x); return; }
      if (node.nt === 'If' || node.nt === 'While') {
        walkCond(node.cond);
        if (node.then) walkBody(node.then);
        if (node.els) walkBody(node.els);
        if (node.body) walkBody(node.body);
        return;
      }
      if (node.nt === 'Lambda' || node.nt === 'FnStmt') return;
      for (const k of Object.keys(node)) {
        if (k === 'span' || k === 'docs' || k === 'lit') continue;
        const v = node[k];
        if (v && typeof v === 'object') walkBody(v);
      }
    };
    for (const [, entry] of mod.items) {
      if (entry.kind === 'fn' && entry.decl.body) walkBody(entry.decl.body);
    }
    for (const entry of this.methodEntries) {
      if (entry.mod === mod && entry.decl.body) walkBody(entry.decl.body);
    }
  }

  // ---------- trait 实现 ----------
  resolveImpls(mod) {
    for (const item of mod.impls ?? []) {
      // trait 查找:prelude 或同模块
      let traitDef = null;
      if (TRAIT_PRELUDE[item.trait]) {
        traitDef = TRAIT_PRELUDE[item.trait];
      } else {
        const entry = mod.items.get(item.trait);
        if (entry?.kind === 'trait') traitDef = { name: entry.decl.name, methods: entry.methodsSig };
      }
      if (!traitDef) {
        this.diags.push(err('M3001', '未知 trait "' + item.trait + '"(prelude 提供 Eq / ToStr / Compare)', item.span));
        continue;
      }
      // 目标类型:同模块 struct/enum(泛型目标自 v0.5 支持)
      const tEntry = mod.items.get(item.typeName);
      if (!tEntry || (tEntry.kind !== 'struct' && tEntry.kind !== 'enum')) {
        this.diags.push(err('M3001', 'impl 的目标必须是本模块的 struct/enum,不是 "' + item.typeName + '"', item.span));
        continue;
      }
      const def = tEntry.decl;
      // impl 的类型参数与目标类型参数模式
      // 目标类型参数里出现的自由名必须被 impl 类型参数覆盖(M3032),否则是未约束参数
      const freeNames = this.collectFreeTypeNames(item.typeArgs);
      const unconstrained = freeNames.filter(n => !item.tparams.includes(n) && !PRIM_TYPES[n] && !['Vec', 'Map', 'Option', 'Result', 'Range'].includes(n) && !(mod.items.get(n)?.kind === 'struct' || mod.items.get(n)?.kind === 'enum'));
      if (unconstrained.length) {
        this.diags.push(err('M3032', '目标类型参数中的 "' + unconstrained.join(', ') + '" 未被 impl 的类型参数覆盖:在 impl[...] 声明它(带 bound),或用具体类型', item.span));
        continue;
      }
      const tpMap = new Map(item.tparams.map(n => [n, { k: 'param', name: n }]));
      const targPattern = item.typeArgs.map(t => this.resolveTypeAst(t, mod, tpMap, undefined));
      if (item.typeArgs.length !== def.tparams.length) {
        this.diags.push(err('M3005', `impl 目标 ${def.name} 需要 ${def.tparams.length} 个类型参数,得到 ${item.typeArgs.length}`, item.span));
        continue;
      }
      if (item.tparams.length && !item.typeArgs.some(t => t.nt === 'TName' && item.tparams.includes(t.name))) {
        this.diags.push(err('M3032', `impl 声明了类型参数 [${item.tparams.join(', ')}],但目标类型参数中未使用`, item.span));
        continue;
      }
      const selfT = { k: tEntry.kind, name: def.name, def, mod, targs: targPattern };
      const implBounds = item.bounds ?? [];

      const implsForDef = this.methodImpls.get(def) ?? new Map();
      const traitsForDef = this.implTraits.get(def) ?? new Set();
      const seen = new Set();

      for (const m of item.methods) {
        if (seen.has(m.name)) {
          this.diags.push(err('M3009', 'impl 中重复的方法 "' + m.name + '"', m.span));
          continue;
        }
        seen.add(m.name);
        const spec = traitDef.methods.get(m.name);
        if (!spec) {
          this.diags.push(err('M3032', 'trait ' + traitDef.name + ' 没有方法 "' + m.name + '"(需要:' + [...traitDef.methods.keys()].join(', ') + ')', m.span));
          continue;
        }
        // 效果
        const effects = new Set();
        for (const e of m.effects ?? []) {
          if (!KNOWN_EFFECTS.has(e.name)) {
            this.diags.push(err('M3030', '未知的效果 "' + e.name + '"', e.span));
            continue;
          }
          effects.add(e.name);
        }
        const sig = {
          tparams: item.tparams.slice(),
          bounds: implBounds.slice(),
          params: m.params.map((p) => p.self
            ? { name: 'self', mut: !!p.mut, type: selfT, span: p.span, self: true }
            : { name: p.name, mut: false, type: this.resolveTypeAst(p.type, mod, tpMap, selfT), span: p.span }),
          ret: m.ret ? this.resolveTypeAst(m.ret, mod, tpMap, selfT) : T_UNIT,
          effects,
        };
        // 与 trait 声明匹配
        const nonSelf = sig.params.filter(p => !p.self);
        if (nonSelf.length !== spec.params.length) {
          this.diags.push(err('M3005', '方法 ' + m.name + ' 需要 ' + spec.params.length + ' 个参数(不含 self),得到 ' + nonSelf.length, m.span));
          continue;
        }
        const binds = new Map();
        let ok = true;
        nonSelf.forEach((p, i) => {
          const want = resolveT(spec.params[i].type, new Map())?.k === 'selftype' ? selfT : spec.params[i].type;
          if (!unify(p.type, want, binds)) {
            this.diags.push(err('M3002', '方法 ' + m.name + ' 参数 #' + (i + 1) + ' 类型与 trait 声明不符:期望 ' + typeStr(want) + ',实际 ' + typeStr(p.type), p.span));
            ok = false;
          }
        });
        const wantRet = resolveT(spec.ret, new Map())?.k === 'selftype' ? selfT : spec.ret;
        if (!unify(sig.ret, wantRet, binds)) {
          this.diags.push(err('M3002', '方法 ' + m.name + ' 返回类型与 trait 声明不符:期望 ' + typeStr(wantRet) + ',实际 ' + typeStr(sig.ret), m.span));
          ok = false;
        }
        if (sig.params[0].mut !== spec.selfMut) {
          this.diags.push(err('M3032', '方法 ' + m.name + ' 的 self 可变性与 trait 声明不符:trait 要求 ' + (spec.selfMut ? 'mut self' : 'self'), m.span));
          ok = false;
        }
        if (!ok) continue;
        const pseudoEntry = { kind: 'fn', decl: m, pub: false, sig, mod, methodName: m.name, traitName: traitDef.name, implTypeName: item.typeName };
        implsForDef.set(m.name, pseudoEntry);
        this.methodEntries.push(pseudoEntry);
      }
      // 完整性:当前 trait 的每个方法都要实现(跨 impl 的方法已在注册时按 spec 校验)
      for (const [name] of traitDef.methods) {
        if (!seen.has(name)) {
          this.diags.push(err('M3032', 'impl ' + traitDef.name + ' for ' + def.name + ' 缺少方法 "' + name + '"', item.span));
        }
      }
      this.methodImpls.set(def, implsForDef);
      traitsForDef.add(traitDef.name);
      this.implTraits.set(def, traitsForDef);
      const infoForDef = this.implInfo.get(def) ?? new Map();
      infoForDef.set(traitDef.name, { tparams: item.tparams.slice(), bounds: implBounds.slice() });
      this.implInfo.set(def, infoForDef);
    }
  }

  // Join[T] 是线性资源:不能存入集合/元组/struct 字段/enum 载荷/Option/Result(v0.15)
  // (深拷贝语义下,存入集合会产生指向同一子任务的别名句柄,重复 join 语义混乱)
  checkJoinNotStored(t, binds, span, what) {
    const r = resolveT(t, binds);
    if (!r) return;
    if (r.k === 'join') {
      this.diags.push(err('M3034', `Join 句柄不能${what}(句柄是线性资源:克隆出多个别名会指向同一子任务)`, span,
        'join 要尽早;句柄只保存在单个 let 绑定中并直接传给 join。'));
      return;
    }
    switch (r.k) {
      case 'vec': this.checkJoinNotStored(r.el, binds, span, what === '' ? '作为 Vec 元素' : what); return;
      case 'map':
        this.checkJoinNotStored(r.vt, binds, span, '作为 Map 值');
        return;
      case 'tuple': r.ts.forEach(x => this.checkJoinNotStored(x, binds, span, '作为元组成分')); return;
      case 'opt': this.checkJoinNotStored(r.el, binds, span, '作为 Option 载荷'); return;
      case 'res':
        this.checkJoinNotStored(r.ok, binds, span, '作为 Ok 载荷');
        this.checkJoinNotStored(r.err, binds, span, '作为 Err 载荷');
        return;
      case 'struct':
        for (const f of r.def.fields) {
          const ft = substTypes(f.rtype, r.def.tparams, new Map(r.def.tparams.map((n, i) => [n, r.targs[i]])));
          this.checkJoinNotStored(ft, binds, span, `作为字段 ${f.name} 的类型`);
        }
        return;
      case 'enum':
        for (const v of r.def.variants) {
          for (const vt of v.rtypes) {
            const st = substTypes(vt, r.def.tparams, new Map(r.def.tparams.map((n, i) => [n, r.targs[i]])));
            this.checkJoinNotStored(st, binds, span, `作为变体 ${v.name} 的载荷`);
          }
        }
        return;
      default: return;
    }
  }


  // 泛型 bound 检查:类型必须实现 trait(泛型 impl 递归校验其自身 bound)
  boundSatisfied(targ, traitName, ctx, span) {    const r = resolveT(targ, new Map());
    if (!r) return;
    if (r.k === 'param') {
      if (ctx.genericBounds?.get(r.name) === traitName) return;
      this.diags.push(err('M3032', '泛型参数 ' + r.name + ' 未声明实现 ' + traitName + ':在调用方为它添加 bound,例如 [' + r.name + ': ' + traitName + ']', span));
      return;
    }
    if (r.k === 'int' || r.k === 'float' || r.k === 'bool' || r.k === 'str') {
      if (traitName === 'Eq' && BUILTIN_EQ_TYPES.has(r.k)) return;
      if (traitName === 'ToStr' && BUILTIN_TOSTR_TYPES.has(r.k)) return;
      if (traitName === 'Compare' && BUILTIN_CMP_TYPES.has(r.k)) return;
    }
    // 结构化内置:Vec[T] / (T, U) 的 Eq 随元素递归
    if (r.k === 'vec' && traitName === 'Eq') { this.boundSatisfied(r.el, traitName, ctx, span); return; }
    if (r.k === 'tuple' && traitName === 'Eq') { r.ts.forEach(t => this.boundSatisfied(t, traitName, ctx, span)); return; }
    if (r.k === 'struct' || r.k === 'enum') {
      const info = this.implInfo.get(r.def)?.get(traitName);
      if (info) {
        // 泛型 impl:递归校验其自身 bound(例如 impl[T: Eq] Eq for Pair[T, U] → 校验 r.targs[0]: Eq)
        for (const b of info.bounds) {
          const idx = info.tparams.indexOf(b.name);
          if (idx >= 0 && r.targs?.[idx]) this.boundSatisfied(r.targs[idx], b.trait, ctx, span);
        }
        return;
      }
    }
    this.diags.push(err('M3032', typeStr(r) + ' 没有实现 trait ' + traitName + ':写 impl ' + traitName + ' for ' + typeStr(r) + ' { ... }', span));
  }

  // 收集类型 AST 中引用的自由类型名(单段 TName)
  collectFreeTypeNames(t) {
    const out = new Set();
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      if (x.nt === 'TName' && !x.name.includes('.')) out.add(x.name);
      for (const k of Object.keys(x)) {
        if (k === 'span') continue;
        const v = x[k];
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') walk(v);
      }
    };
    (Array.isArray(t) ? t : [t]).forEach(walk);
    return [...out];
  }

  traitMethodsOf(traitName, mod) {
    if (TRAIT_PRELUDE[traitName]) return TRAIT_PRELUDE[traitName].methods;
    const entry = mod?.items.get(traitName);
    if (entry?.kind === 'trait') return entry.methodsSig;
    return null;
  }

  checkFnBody(entry, mod) {
    const d = entry.decl;
    if (d.nt === 'ExternFnDecl') return; // v0.42:外部函数,体为合成桩,不做类型检查
    const scope = new Scope(null, mod);
    for (const p of entry.sig.params) {
      scope.bind(p.name, p.type, p.mut, p.span, true);
    }
    const ctx = {
      mod, scope, fnRet: entry.sig.ret, inLoop: false,
      fnName: d.name, warnings: this.diags,
      implTypeName: entry.implTypeName ?? null, // v0.46:invariant 字段封装需要知道所在 impl 的目标类型
      fnDecl: d, // v0.44:效果修复处方需要函数体起点(函数签名尾部)
      genericNames: new Set(entry.sig.tparams),
      effects: entry.sig.effects,
      genericBounds: new Map((entry.sig.bounds ?? []).map(b => [b.name, b.trait])),
    };
    // 契约检查(v0.45):纯表达式 + bool;ensures 中 result 绑定返回值
    if (d.requires) {
      const pureCtx = { ...ctx, scope, effects: new Set(), fnDecl: d, contractMode: true };
      const t = this.checkExpr(d.requires.expr, pureCtx, T_BOOL);
      const r = t ? resolveT(t, new Map()) : null;
      if (r && r.k !== 'bool') this.diags.push(err('M3014', `requires 条件必须是 bool,实际是 ${typeStr(r)}`, d.requires.expr.span));
    }
    if (d.ensures) {
      const resScope = new Scope(scope, mod);
      resScope.bind('result', entry.sig.ret, false, d.ensures.expr.span, true);
      const pureCtx = { ...ctx, scope: resScope, effects: new Set(), fnDecl: d, contractMode: true };
      const t = this.checkExpr(d.ensures.expr, pureCtx, T_BOOL);
      const r = t ? resolveT(t, new Map()) : null;
      if (r && r.k !== 'bool') this.diags.push(err('M3014', `ensures 条件必须是 bool,实际是 ${typeStr(r)}`, d.ensures.expr.span));
    }
    // REPL 求值包装(按名字识别):块值即返回值(类型随块推断),不设期望
    const replMode = d.name.startsWith('__repl_');
    const bt = this.checkBlock(d.body, ctx, replMode ? null : (entry.sig.ret.k === 'unit' ? null : entry.sig.ret));
    if (replMode) {
      entry.sig.ret = bt === null ? T_UNIT : bt; // 块值类型作为包装返回类型
      return;
    }
    const ret = entry.sig.ret;
    const binds = new Map();
    if (bt === null) return; // 体内已有诊断
    if (ret.k === 'unit') {
      if (!unify(bt, T_UNIT, binds) && bt.k !== 'never') {
        this.diags.push(err('M3002', `函数 "${d.name}" 没有返回类型,但块产生了 ${typeStr(bt, binds)} 值`, d.body.span,
          '删除块尾表达式,或给函数添加 "-> ' + typeStr(bt, binds) + '"。'));
      }
    } else {
      if (bt.k === 'unit') {
        this.diags.push(err('M3017', `函数 "${d.name}" 标注返回 ${typeStr(ret)},但有的执行路径不会产生返回值`, d.body.span,
          '补上 return 语句或块尾表达式;检查 if/match 的每个分支是否都返回。'));
      } else if (!unify(bt, ret, binds) && bt.k !== 'never') {
        this.diags.push(err('M3002', `函数 "${d.name}" 返回类型是 ${typeStr(ret)},但块产生 ${typeStr(bt, binds)}`, d.body.span));
      }
    }
    scope.reportUnused(this.diags);
  }

  checkTest(entry, mod) {
    const scope = new Scope(null, mod);
    // 测试块允许全部效果(它们是验证脚手架;print 输出会被捕获)
    const ctx = { mod, scope, fnRet: T_UNIT, inLoop: false, fnName: 'test ' + entry.decl.name, warnings: this.diags, genericNames: new Set(), effects: new Set(KNOWN_EFFECTS) };
    this.checkBlock(entry.decl.body, ctx, null);
    scope.reportUnused(this.diags);
  }

  // v0.54:unsafe {} 门禁——块只能出现在声明 with unsafe 的函数内;块内才允许指针读写/传递
  // v0.54 审查 B4:只要在函数体内消费 unsafe 上下文,该消费就记入当前闭包的效果集
  // (effectSink)。否则 unsafe 块里定义的闭包类型为 "() -> T"(纯),可被纯函数参数接收,
  // 把指针操作洗成无效果调用——违反效果逐层传播合同。
  requireUnsafeContext(ctx, span, what) {
    if (ctx.effectSink) ctx.effectSink.add('unsafe');
    if (ctx.inUnsafe) return true;
    this.diags.push(err('M3046',
      `${what} 必须在 unsafe {} 块内(所在函数需声明 "with unsafe")`,
      span, CODE_HINTS.M3046));
    return false;
  }

  // v0.54:Ptr 实参传递门禁——任何函数(除 extern)收到含 Ptr 的实参都必须在 unsafe 块内。
  // allowPtr=true 用于 extern(签名可接受 Ptr)与 std.mem(已由 mem 专项检查覆盖,避免重复诊断)。
  // v0.54 审查 B3:判定改为递归类型谓词(容器/元组/结构/枚举载荷都算"Ptr 逃逸"),
  // 不再只看实参类型本身 k==='ptr'——否则 Vec[Ptr[mut u8]]/Option[Ptr]/含 Ptr 的结构体
  // 可以把指针偷运出 unsafe 块。泛型形参(param/var)在调用点用**实参类型**判定;
  // 泛型体内类型被擦除时无从静态判定,跳过(见 GUIDE §14.1)。
  checkPtrArgs(args, argTs, ctx, calleeDesc, allowPtr = false) {
    if (allowPtr || ctx.inUnsafe) return;
    for (let i = 0; i < args.length; i++) {
      const t = resolveT(argTs[i], new Map());
      if (!typeContainsPtr(t)) continue;
      const key = spanKey(args[i]?.span);
      if (key && this.ptrPayloadSpans.has(key)) continue; // 构造点已报,不重复
      this.diags.push(err('M3046',
        `把 ${typeStr(t)} 实参传给${calleeDesc} 必须在 unsafe {} 块内(所在函数需声明 "with unsafe")`,
        args[i]?.span, CODE_HINTS.M3046));
    }
  }

  // v0.54 审查 B3:把含 Ptr 的值放进容器/元组/结构体/枚举变体,同样属于指针逃逸。
  // site 是载荷位置的中文主语(如 "Vec 元素"/"结构体字段")。
  checkPtrPayload(t, span, ctx, site) {
    if (ctx.inUnsafe) return;
    const r = t ? resolveT(t, new Map()) : null;
    if (!typeContainsPtr(r)) return;
    const key = spanKey(span);
    if (key && this.ptrPayloadSpans.has(key)) return; // 同一表达式已报(嵌套构造/实参去重)
    if (key) this.ptrPayloadSpans.add(key);
    this.diags.push(err('M3046',
      `${site}含 Ptr(${typeStr(r)}),必须在 unsafe {} 块内(所在函数需声明 "with unsafe")`,
      span, CODE_HINTS.M3046));
  }

  // 效果检查:调用方必须声明被调方需要的全部效果
  // contextLabel:非调用场景(如 v0.54 的 unsafe 块)可覆盖消息主语,仍复用 M3029 与修复处方
  checkEffects(ctx, required, span, contextLabel = null) {
    if (!required || !required.size) return;
    if (ctx.effectSink) for (const e of required) ctx.effectSink.add(e);
    const missing = [...required].filter(e => !ctx.effects?.has(e));
    if (!missing.length) return;
    const d = err('M3029',
      contextLabel
        ? `${contextLabel}需要效果 [${missing.join(', ')}],但函数 "${ctx.fnName ?? '?'}" 没有声明 "with ${missing.join(', ')}"(当前:[${[...(ctx.effects ?? [])].join(', ') || '纯函数'}])`
        : `此调用需要效果 [${missing.join(', ')}],但函数 "${ctx.fnName ?? '?'}" 声明的是 [${[...(ctx.effects ?? [])].join(', ') || '纯函数'}]`,
      span, CODE_HINTS.M3029);
    // v0.44:结构化修复处方——在函数体 "{" 前补声明缺失效果
    const bodySpan = ctx.fnDecl?.body?.span;
    if (bodySpan?.line) {
      const declared = [...(ctx.effects ?? [])];
      const repl = declared.length ? `, ${missing.join(', ')} ` : ` with ${missing.join(', ')} `;
      d.fix = { start: { line: bodySpan.line, col: bodySpan.col }, end: { line: bodySpan.line, col: bodySpan.col }, replacement: repl };
    }
    this.diags.push(d);
  }

  // ---------- 语句 ----------
  checkBlock(block, ctx, expected, valuePos = false) {
    const scope = new Scope(ctx.scope, ctx.mod);
    ctx = { ...ctx, scope };
    for (const s of block.stmts) this.checkStmt(s, ctx);
    let bt;
    if (block.tail) {
      // 前面若有必然终止的语句,尾表达式不可达
      for (let i = 0; i < block.stmts.length; i++) {
        if (stmtTerminates(block.stmts[i])) {
          this.diags.push(warn('W3103', '这条语句之后的代码不可达', block.tail.span));
          break;
        }
      }
      // v0.39 修复:值上下文中的块尾也是值位置(此前 expected == null 时 valuePos
      // 恒为 false → 块尾 if 表达式被当作语句形式返回 unit)
      bt = this.checkExpr(block.tail, ctx, expected ?? undefined, expected != null || valuePos);
    } else {
      bt = T_UNIT;
    }
    scope.reportUnused(this.diags);
    // 块是否必然终止(任一语句必然终止 → 块不会正常完成)
    const terminated = block.tail ? false : block.stmts.some(stmtTerminates);
    if (terminated) return T_NEVER;
    return bt;
  }

  checkStmt(s, ctx) {
    switch (s.nt) {
      case 'Let': return this.checkLet(s, ctx);
      case 'Assign': return this.checkAssign(s, ctx);
      case 'Return': {
        const binds = new Map();
        if (s.value) {
          const t = this.checkExpr(s.value, ctx, ctx.fnRet.k === 'unit' ? undefined : ctx.fnRet);
          if (t === null) break; // 表达式已报错;不再连锁
          if (!unify(t, ctx.fnRet, binds) && t.k !== 'never' && ctx.fnRet.k !== 'never') {
            this.diags.push(err('M3002', `return 的值类型 ${typeStr(t, binds)} 与函数返回类型 ${typeStr(ctx.fnRet)} 不匹配`, s.span));
          }
        } else if (ctx.fnRet.k !== 'unit' && ctx.fnRet.k !== 'never') {
          this.diags.push(err('M3002', `函数返回类型是 ${typeStr(ctx.fnRet)},裸 return 不能省略返回值`, s.span));
        }
        return;
      }
      case 'Break':
        if (!ctx.inLoop) this.diags.push(err('M3010', 'break 只能出现在循环内', s.span));
        return;
      case 'Continue':
        if (!ctx.inLoop) this.diags.push(err('M3011', 'continue 只能出现在循环内', s.span));
        return;
      case 'While': {
        const t = this.checkExpr(s.cond, ctx, T_BOOL);
        if (!unify(t, T_BOOL, new Map())) {
          this.diags.push(err('M3014', `while 条件必须是 bool,实际是 ${typeStr(t)}`, s.cond.span,
            'Ming 没有真值化:显式写比较,例如 x != 0。'));
        }
        this.checkBlock(s.body, { ...ctx, inLoop: true }, T_UNIT);
        return;
      }
      case 'WhileLet': {
        const t = this.checkExpr(s.expr, ctx);
        const inner = new Scope(ctx.scope, ctx.mod);
        const ctx2 = { ...ctx, scope: inner, bindings: new Map() };
        const r = t ? resolveT(t, new Map()) : null;
        this.checkMatchPattern(s.pat, t, r, ctx2, new Map());
        this.checkBlock(s.body, { ...ctx2, inLoop: true }, T_UNIT);
        return;
      }
      case 'For': {
        const it = this.checkExpr(s.iter, ctx);
        const r = resolveT(it, new Map());
        let elemT = null;
        if (r?.k === 'vec') elemT = r.el;
        else if (r?.k === 'range') elemT = r.el;
        else if (r?.k === 'str') elemT = T_STR;
        else if (r?.k === 'map') elemT = mkTuple([r.kt, r.vt]);
        else {
          this.diags.push(err('M3026', `${typeStr(it)} 不可迭代(for 支持:Vec、Map、str、Range)`, s.iter.span));
          elemT = null;
        }
        const inner = new Scope(ctx.scope, ctx.mod);
        const ctx2 = { ...ctx, scope: inner, bindings: new Map() };
        if (elemT) this.checkPattern(s.pat, elemT, ctx2, s.pat.span, false);
        this.checkBlock(s.body, { ...ctx2, inLoop: true }, T_UNIT);
        return;
      }
      case 'Loop': {
        this.checkBlock(s.body, { ...ctx, inLoop: true }, T_UNIT);
        return;
      }
      case 'SyncScopeBlock': {
        // 结构化并发作用域块:需要 sync 效果;块体为语句序列(unit)
        this.checkEffects(ctx, new Set(['sync']), s.span);
        this.checkBlock(s.body, { ...ctx, inLoop: ctx.inLoop }, T_UNIT);
        return;
      }
      case 'UnsafeBlock': {
        // v0.54:块级效果门禁——先要求函数声明 with unsafe(M3029),块内才置 inUnsafe。
        // 块本身不改变周围效果集:块内调用仍受 ctx.effects 约束(与普通代码一致)。
        this.checkEffects(ctx, new Set(['unsafe']), s.span, 'unsafe {} 块');
        this.checkBlock(s.body, { ...ctx, inUnsafe: true }, T_UNIT);
        return;
      }
      case 'ExprStmt': {
        const expected = s.semi ? undefined : T_UNIT;
        this.checkExpr(s.expr, ctx, expected);
        return;
      }
      case 'FnStmt': {
        // 本地函数:不能捕获外部局部变量;可递归;效果独立声明
        const d = s.decl;
        const tp = new Map(d.tparams.map(n => [n, { k: 'param', name: n }]));
        const effects = new Set();
        for (const e of d.effects ?? []) {
          if (!KNOWN_EFFECTS.has(e.name)) {
            this.diags.push(err('M3030', `未知的效果 "${e.name}"(可用:${[...KNOWN_EFFECTS].join(', ')})`, e.span));
            continue;
          }
          effects.add(e.name);
        }
        const sig = {
          tparams: d.tparams,
          params: d.params.map(p => ({ name: p.name, mut: !!p.mut, type: this.resolveTypeAst(p.type, ctx.mod, tp), span: p.span })),
          ret: d.ret ? this.resolveTypeAst(d.ret, ctx.mod, tp) : T_UNIT,
          effects,
        };
        const scope = new Scope(ctx.mod.rootScope, ctx.mod);
        for (const p of sig.params) scope.bind(p.name, p.type, p.mut, p.span, true);
        const inner = { mod: ctx.mod, scope, fnRet: sig.ret, inLoop: false, fnName: d.name, warnings: this.diags, genericNames: new Set(d.tparams), rootScopeOnly: true, effects };
        const bt = this.checkBlock(d.body, inner, null);
        const binds = new Map();
        if (sig.ret.k === 'unit') {
          if (!unify(bt, T_UNIT, binds) && bt.k !== 'never') {
            this.diags.push(err('M3002', `函数 "${d.name}" 没有返回类型,但块产生了值`, d.body.span));
          }
        } else if (bt && bt.k === 'unit') {
          this.diags.push(err('M3017', `函数 "${d.name}" 标注返回 ${typeStr(sig.ret)},但有的执行路径不返回值`, d.body.span));
        } else if (bt && !unify(bt, sig.ret, binds) && bt.k !== 'never') {
          this.diags.push(err('M3002', `函数 "${d.name}" 返回类型不匹配:声明 ${typeStr(sig.ret)},实际 ${typeStr(bt, binds)}`, d.body.span));
        }
        scope.reportUnused(this.diags);
        ctx.scope.registerLocalFn(d.name, sig);
        return;
      }
      default:
        this.diags.push(err('M2001', `未支持的语句 ${s.nt}`, s.span));
    }
  }

  checkLet(s, ctx) {
    let declared = null;
    if (s.type) declared = this.resolveTypeAst(s.type, ctx.mod);
    let initT = null;
    if (s.init) {
      initT = this.checkExpr(s.init, ctx, declared ?? undefined, true);
    }
    const binds = new Map();
    if (s.init && declared) {
      if (!unify(initT, declared, binds)) {
        this.diags.push(err('M3002', `let 标注类型是 ${typeStr(declared)},但初始化表达式是 ${typeStr(initT, binds)}`, s.span));
      }
    }
    if (!s.init && !declared) {
      this.diags.push(err('M3003', `let "${patternBrief(s.pat)}" 缺少初始化与类型标注(至少给一个)`, s.span,
        'Ming 没有未初始化的变量:写 let x: T = ...; 或 let x = ...;'));
      return;
    }
    const patT = declared ?? initT;
    this.checkPattern(s.pat, patT, ctx, s.span, false, s.mutable);
  }

  checkPattern(pat, t, ctx, span, refutableOk, forceMut = false) {
    // 把模式绑定写入 ctx.scope / ctx.bindings
    t = t ?? null;
    switch (pat.nt) {
      case 'PWild': return;
      case 'PIdent': {
        if (!t) { this.diags.push(err('M3003', `无法推断 "${pat.name}" 的类型`, span, CODE_HINTS.M3003)); return; }
        if (ctx.scope) {
          if (ctx.scope.vars.has(pat.name)) {
            this.diags.push(err('M3016', `同一作用域内 "${pat.name}" 已存在,不能重复绑定`, pat.span,
              'Ming 禁止同层遮蔽;换个名字,或复用已有绑定。'));
          }
          ctx.scope.bind(pat.name, t, forceMut || !!ctx.mutAll, pat.span, false);
        }
        if (ctx.bindings) ctx.bindings.set(pat.name, t);
        return;
      }
      case 'PTuple': {
        const r = resolveT(t, new Map());
        if (t && r.k !== 'tuple') {
          this.diags.push(err('M3002', `元组模式要求元组类型,实际是 ${typeStr(t)}`, span));
          return;
        }
        if (r && r.ts.length !== pat.pats.length) {
          this.diags.push(err('M3002', `元组模式有 ${pat.pats.length} 个元素,类型有 ${r.ts.length} 个`, span));
          return;
        }
        pat.pats.forEach((p, i) => this.checkPattern(p, r ? r.ts[i] : null, ctx, p.span, refutableOk, forceMut));
        return;
      }
      case 'PLit': {
        // 模式字面量与被匹配类型的一致性在 match 中检查;let 中出现则报错
        this.diags.push(err('M3028', 'let 绑定不支持字面量模式(不可反驳性)', span));
        return;
      }
      case 'PEnum': {
        this.diags.push(err('M3028', 'let 绑定不支持枚举模式(可反驳);用 match 或 while let', span));
        return;
      }
      default:
        this.diags.push(err('M2003', '无效的模式', span));
    }
  }

  checkAssign(s, ctx) {
    const targetT = this.checkPlace(s.target, ctx);
    // v0.39 修复:右值是值位置(此前缺 valuePos → if 表达式右值被当作语句形式返回 unit)
    const valueT = this.checkExpr(s.value, ctx, targetT ?? undefined, true);
    const binds = new Map();
    if (s.op !== '=') {
      // 复合赋值:要求支持对应算术
      this.checkBinaryOp(s.op[0], targetT, valueT, s.span, binds);
    } else if (targetT && !unify(targetT, valueT, binds)) {
      this.diags.push(err('M3002', `赋值类型不匹配:目标是 ${typeStr(targetT, binds)},值是 ${typeStr(valueT, binds)}`, s.span));
    } else if (targetT) {
      // v0.54 审查 B4:unify(目标, 值) 的效果子集方向是"目标 ⊆ 值"(为实参→形参而设),
      // 赋值需要的是"值 ⊆ 目标";否则闭包可把 unsafe 效果洗进纯函数类型变量。
      this.checkFnEffectNarrowing(targetT, valueT, s.span);
    }
  }

  // 把闭包/函数值放进已声明的函数类型位置(赋值、结构体字段初始化)时,
  // 值的效果集必须 ⊆ 目标效果集——效果只增不减。
  checkFnEffectNarrowing(targetT, valueT, span) {
    const tv = resolveT(targetT, new Map()), vv = valueT ? resolveT(valueT, new Map()) : null;
    if (tv?.k !== 'fn' || vv?.k !== 'fn') return;
    const have = tv.effects ?? new Set();
    const extra = [...(vv.effects ?? new Set())].filter(e => !have.has(e));
    if (!extra.length) return;
    this.diags.push(err('M3029',
      `把需要效果 [${extra.join(', ')}] 的 ${typeStr(vv)} 放进声明为 ${typeStr(tv)} 的位置(效果只增不减)`,
      span, '目标函数类型没有声明这些效果;要么扩宽目标类型,要么把危险操作留在函数体内。'));
  }

  // 可变位置(左值)
  checkPlace(e, ctx) {
    switch (e.nt) {
      case 'Ident': {
        const v = ctx.scope.lookup(e.name);
        if (!v) {
          // 常量不可赋值
          const entry = ctx.mod.items.get(e.name);
          if (entry?.kind === 'const') {
            this.diags.push(err('M3004', `"${e.name}" 是常量,不可赋值`, e.span));
            return entry.rtype;
          }
          this.cannotFindValue(e.name, e.span, ctx);
          return null;
        }
        if (!v.mut) this.diags.push(err('M3004', `"${e.name}" 不是 mut,不能赋值`, e.span, '声明时写 let mut x = ...'));
        v.used = true;
        return v.type;
      }
      case 'Field': {
        const baseT = this.checkPlace(e.base, ctx);
        if (!baseT) return null;
        const r = resolveT(baseT, new Map());
        if (r?.k !== 'struct') {
          this.diags.push(err('M3006', `${typeStr(baseT)} 没有字段 "${e.name}"(字段访问只支持结构体)`, e.span));
          return null;
        }
        const f = r.def.fields.find(x => x.name === e.name);
        if (!f) {
          this.diags.push(err('M3006', `结构体 ${r.name} 没有字段 "${e.name}"(有:${r.def.fields.map(x => x.name).join(', ') || '无'})`, e.span));
          return null;
        }
        // v0.46(M3040):带 invariant 的 struct 字段封装——字段只能在自身 impl 方法内修改
        if (r.def.invariants?.length && ctx.implTypeName !== r.name) {
          this.diags.push(err('M3040', `结构体 ${r.name} 带有 invariant,字段 "${e.name}" 只能在它的 impl 方法内修改`, e.span,
            '通过 impl 提供的(mut)方法修改字段,由方法负责维护不变量。'));
          return null;
        }
        return substTypes(f.rtype, r.def.tparams, r.targs);
      }
      case 'Index': {
        const baseT = this.checkPlace(e.base, ctx);
        if (!baseT) return null;
        const r = resolveT(baseT, new Map());
        const iT = this.checkExpr(e.index, ctx);
        if (r?.k === 'vec') {
          if (!unify(iT, INT_TYPES.i64, new Map())) this.diags.push(err('M3002', `Vec 索引必须是 i64,实际是 ${typeStr(iT)}`, e.index.span));
          return r.el;
        }
        if (r?.k === 'map') {
          if (!unify(iT, r.kt, new Map())) this.diags.push(err('M3002', `map 键类型是 ${typeStr(r.kt)},实际是 ${typeStr(iT)}`, e.index.span));
          return r.vt;
        }
        this.diags.push(err('M3020', `${typeStr(baseT)} 不支持索引赋值`, e.span));
        return null;
      }
      default:
        this.diags.push(err('M2007', '赋值目标必须是:变量、结构体字段(p.x)或下标(v[i] / m[k])', e.span));
        return null;
    }
  }

  cannotFindValue(name, span, ctx) {
    const avail = [...ctx.scope.allVisibleNames()];
    const near = nearest(name, avail);
    const d = err('M3001', `找不到值 "${name}"`, span,
      near ? `未定义;最接近的名字是 "${near}"` : (ctx.rootScopeOnly ? '本地函数内只能访问:参数、模块级函数/类型与内置项;不能捕获外层局部变量(v0.1)' : null));
    // v0.44:结构化修复处方——替换为最接近的可见名字
    if (near && span?.line) {
      d.fix = {
        start: { line: span.line, col: span.col },
        end: { line: span.endLine ?? span.line, col: span.endCol ?? span.col },
        replacement: near,
      };
    }
    this.diags.push(d);
  }

  // ---------- 表达式 ----------
  // valuePos:该表达式处于"值位置"(let 初始化、实参、return 值等)。
  // 用于区分语句位置的 if(允许无 else)与值位置的 if(必须有 else)。
  checkExpr(e, ctx, expected, valuePos = false) {
    const binds = new Map();
    switch (e.nt) {
      case 'IntLit': {
        if (expected) {
          const r = resolveT(expected, binds);
          if (r?.k === 'int') {
            if (!intLitFits(e, r)) this.diags.push(err('M3002', `字面量 ${e.v} 超出 ${typeStr(r)} 的范围`, e.span));
            return { ...r };
          }
        }
        return tint(e.bits, e.signed);
      }
      case 'FloatLit': {
        if (expected) {
          const r = resolveT(expected, binds);
          if (r?.k === 'float') return { ...r };
        }
        return tfloat(e.bits);
      }
      case 'BoolLit': return T_BOOL;
      case 'StrLit': {
        for (const p of e.parts) {
          if (p.expr) {
            const t = this.checkExpr(p.expr, ctx);
            const r = resolveT(t, new Map());
            if (!isPrimitiveDisplay(r, binds)) {
              this.diags.push(err('M3012', `插值 \\{...} 只支持 int/float/bool/str,实际是 ${typeStr(r)}`, p.expr.span,
                '其他类型用 debug(x) 生成调试字符串,或给它实现 to_str(计划 v0.2)。'));
            }
          }
        }
        return T_STR;
      }
      case 'Ident': return this.checkIdent(e, ctx, expected);
      case 'Field': return this.checkField(e, ctx, expected);
      case 'Call': return this.checkCall(e, ctx, expected);
      case 'Index': {
        const baseT = this.checkExpr(e.base, ctx);
        const r = resolveT(baseT, new Map());
        const iT = this.checkExpr(e.index, ctx);
        if (r?.k === 'vec') {
          if (!unify(iT, INT_TYPES.i64, new Map())) this.diags.push(err('M3002', `Vec 索引必须是 i64,实际是 ${typeStr(iT)}`, e.index.span));
          return r.el;
        }
        if (r?.k === 'map') {
          if (!unify(iT, r.kt, new Map())) this.diags.push(err('M3002', `map 键类型是 ${typeStr(r.kt)},实际是 ${typeStr(iT)}`, e.index.span));
          return r.vt;
        }
        if (r?.k === 'str') {
          this.diags.push(err('M3020', 'str 不支持 [] 索引(UTF-8 语义歧义)', e.span,
            '用 s.get(i)(字符 Option)、s.chars() 或 s.slice_chars(a, b)。'));
          return T_STR;
        }
        if (r?.k === 'tuple') {
          this.diags.push(err('M3020', '元组不支持 [] 索引', e.span, '用 let (a, b) = t; 解构。'));
          return r.ts[0] ?? T_UNIT;
        }
        this.diags.push(err('M3020', `${typeStr(baseT)} 不支持下标索引`, e.span));
        return null;
      }
      case 'Unary': {
        // v0.40 修复:操作数是值位置(此前缺 valuePos → if 表达式操作数返回 unit)
        const t = this.checkExpr(e.expr, ctx, e.op === '!' ? T_BOOL : (expected && resolveT(expected, binds)?.k === 'float' ? expected : undefined), true);
        const r = resolveT(t, new Map());
        if (e.op === '!') {
          if (r?.k !== 'bool') this.diags.push(err('M3008', `"!" 要求 bool,实际是 ${typeStr(r)}`, e.expr.span));
          return T_BOOL;
        }
        if (r?.k === 'param') {
          this.diags.push(err('M3018', `泛型参数上不能做一元 "-" 运算(v0.1 泛型是参数化的)`, e.expr.span));
          return t;
        }
        if (r?.k === 'int' || r?.k === 'float') return t;
        this.diags.push(err('M3008', `一元 "-" 要求数字类型,实际是 ${typeStr(r)}`, e.expr.span));
        return t;
      }
      case 'Binary': return this.checkBinary(e, ctx, expected);
      case 'Range': {
        const lt = this.checkExpr(e.lo, ctx);
        const rt = this.checkExpr(e.hi, ctx, lt ?? undefined);
        const lr = resolveT(lt, new Map()), rr = resolveT(rt, new Map());
        if (lr?.k !== 'int' || !unify(lr, rr, new Map())) {
          this.diags.push(err('M3008', `区间两端必须是同宽度的整数,实际是 ${typeStr(lr)} 与 ${typeStr(rr)}`, e.span));
          return mkRange(INT_TYPES.i64);
        }
        return mkRange(lr);
      }
      case 'As': {
        // v0.39 修复:as 操作数是值位置(此前缺 valuePos → if 表达式操作数返回 unit)
        const t = this.checkExpr(e.expr, ctx, undefined, true);
        const target = this.resolveTypeAst(e.type, ctx.mod);
        const r = resolveT(t, new Map()), tr = resolveT(target, new Map());
        const numOk = (x) => x?.k === 'int' || x?.k === 'float';
        if (!numOk(r) || !numOk(tr)) {
          this.diags.push(err('M3019', `"as" 只支持数值类型之间的转换:${typeStr(r)} → ${typeStr(tr)}`, e.span,
            r?.k === 'str' ? '字符串转数字用 s.parse_i64() / s.parse_f64()(返回 Result)' : '数字转字符串用 str(x)'));
          return target;
        }
        return target;
      }
      case 'PostQ': return this.checkPostQ(e, ctx);
      case 'If': return this.checkIf(e, ctx, expected, valuePos);
      case 'Match': return this.checkMatch(e, ctx, expected);
      case 'VecLit': return this.checkVecLit(e, ctx, expected);
      case 'MapLit': return this.checkMapLit(e, ctx, expected);
      case 'TupleLit': {
        if (e.elems.length === 0) return T_UNIT; // () 即 unit
        const ts = e.elems.map(x => this.checkExpr(x, ctx));
        const tt = mkTuple(ts);
        this.checkJoinNotStored(tt, new Map(), e.span, '作为元组成分');
        this.checkPtrPayload(tt, e.span, ctx, '元组成分'); // v0.54 审查 B3
        return tt;
      }
      case 'StructLit': return this.checkStructLit(e, ctx);
      case 'Lambda': return this.checkLambda(e, ctx, expected);
      case 'BlockExpr': {
        // 块表达式出现在表达式位置(如 match 分支、闭包体)
        return this.checkBlock(e.block, ctx, expected ?? undefined);
      }
      case 'LoopExpr': {
        this.checkBlock(e.body, { ...ctx, inLoop: true }, T_UNIT);
        // v0.54 审查 B1:loop 内出现 break → 循环以 unit 结束(break 不携带值);
        // 只有完全无 break 的 loop 才是 never。此前恒返回 never,`let x: i64 = loop { break; }`
        // 会静默通过并把 unit 装进 i64。hasBreak 对 unsafe 块递归(见函数定义处)。
        return hasBreak(e.body) ? T_UNIT : T_NEVER;
      }
      default:
        this.diags.push(err('M2001', `未支持的表达式 ${e.nt}`, e.span));
        return null;
    }
  }

  checkIdent(e, ctx, expected) {
    const name = e.name;
    // 局部变量
    const v = ctx.scope.lookup(name);
    if (v) { v.used = true; return v.type; }
    // 本地函数(作为值)
    const localFn = ctx.scope.lookupFn(name);
    if (localFn) {
      if (localFn.tparams?.length) {
        this.diags.push(err('M3003', `泛型函数 "${name}" 作为值使用前需要确定类型参数`, e.span));
        return null;
      }
      return mkFn(localFn.params.map(p => p.type), localFn.ret, new Set(localFn.effects ?? []));
    }
    // 模块级函数(当前模块,用户定义优先于内置)
    const entry = ctx.mod.items.get(name);
    if (entry?.kind === 'fn') {
      if (entry.sig.tparams.length) {
        this.diags.push(err('M3003', `泛型函数 "${name}" 作为值使用前需要确定类型参数`, e.span, '直接调用它,让类型从实参推断。'));
        return null;
      }
      const ft = mkFn(entry.sig.params.map(p => p.type), entry.sig.ret, new Set(entry.sig.effects ?? []));
      if (entry.extern) ft.extern = true; // v0.54:extern 函数值可接收 Ptr,不受 unsafe 块限制
      return ft;
    }
    if (entry?.kind === 'const') {
      return entry.rtype ?? null;
    }
    // 内置函数不能作为值
    if (BUILTIN_FNS[name]) {
      this.diags.push(err('M3001', `"${name}" 是内置函数,不能作为值传递`, e.span, '需要函数值时用闭包:(x) => ...。'));
      return null;
    }
    // prelude 变体别名
    if (PRELUDE_VARIANTS[name]) {
      const ctor = this.variantCtorType(PRELUDE_VARIANTS[name].enumName, PRELUDE_VARIANTS[name].variant, e.span);
      if (ctor.arity === 0) return ctor.enumT; // None 是完整值
      this.diags.push(err('M3005', `${name} 需要一个值:${name}(表达式)`, e.span));
      return null;
    }
    // 内置类型名 → 类型层(仅用于类型级函数,如 i64.max_value())
    if (PRIM_TYPES[name]) return { k: 'typename', prim: name };
    // std 根命名空间
    if (name === 'std') return { k: 'stdmod', name: 'std' };
    // 导入绑定单独出现 → 提示
    if (ctx.mod.imports.has(name)) {
      this.diags.push(err('M3001', `"${name}" 是模块绑定,需要以 "${name}.成员" 的方式使用`, e.span));
      return null;
    }
    this.cannotFindValue(name, e.span, ctx);
    return null;
  }

  variantCtorType(enumName, variantName, span) {
    if (enumName === 'Option') {
      const T = tvar();
      return { k: 'ctor', enumT: mkOpt(T), variant: variantName, tvars: [T], arity: variantName === 'None' ? 0 : 1 };
    }
    if (enumName === 'Result') {
      const T = tvar(), E = tvar();
      return { k: 'ctor', enumT: mkRes(T, E), variant: variantName, tvars: [T, E], arity: variantName === 'Ok' ? 1 : 1 };
    }
    this.diags.push(err('M3024', `未知枚举 "${enumName}"`, span));
    return null;
  }

  checkField(e, ctx, expected) {
    // base 的几种身份:局部变量 / 模块绑定 / 类型名
    const base = e.base;
    if (base.nt === 'Ident') {
      const name = base.name;
      // 局部变量优先(允许局部名遮蔽导入绑定)
      if (!ctx.scope.lookup(name)) {
        // std 根命名空间:std.math.pi() 无需 use
        if (name === 'std') {
          return { k: 'stdmod', name: e.name };
        }
        // 导入模块成员
        if (ctx.mod.imports.has(name)) {
          const imp = ctx.mod.imports.get(name);
          if (imp.std) {
            this.stdModuleMember(imp.std, e.name, e, ctx, expected);
            return null;
          }
          const entry = imp.local.items.get(e.name);
          if (!entry) {
            this.diags.push(err('M3001', `模块 ${name} 中没有 "${e.name}"(可见:${[...imp.local.items.keys()].filter(k => !k.startsWith('test:')).join(', ') || '无'})`, e.span));
            return null;
          }
          return this.moduleEntryValue(entry, e.name, e.span, imp.local, ctx, expected);
        }
        // 内置枚举名 → 变体构造器 Option.Some
        if (name === 'Option' || name === 'Result') {
          return this.variantCtorType(name, e.name, e.span);
        }
        // 用户枚举/结构体的变体(当前模块)
        const entry = ctx.mod.items.get(name);
        if (entry?.kind === 'enum') {
          const v = entry.decl.variants.find(x => x.name === e.name);
          if (!v) {
            this.diags.push(err('M3024', `枚举 ${name} 没有变体 "${e.name}"(有:${entry.decl.variants.map(x => x.name).join(', ')})`, e.span));
            return null;
          }
          const targs = entry.decl.tparams.map(() => tvar());
          const enumT = { k: 'enum', name: entry.decl.name, def: entry.decl, mod: ctx.mod, targs };
          // 零参变体是完整值;带参变体需要调用
          if (v.rtypes.length === 0) return enumT;
          return this.userVariantCtor(enumT, v, targs);
        }
      }
    }
    // 普通字段访问
    const baseT = this.checkExpr(base, ctx, undefined);
    const r = baseT ? resolveT(baseT, new Map()) : null;
    if (r?.k === 'struct') {
      const f = r.def.fields.find(x => x.name === e.name);
      if (!f) {
        this.diags.push(err('M3006', `结构体 ${r.name} 没有字段 "${e.name}"(有:${r.def.fields.map(x => x.name).join(', ') || '无'})`, e.span));
        return null;
      }
      return substTypes(f.rtype, r.def.tparams, r.targs);
    }
    if (r?.k === 'enum') {
      this.diags.push(err('M3006', '枚举值不能直接访问字段;用 match 解构', e.span));
      return null;
    }
    if (r?.k === 'typename') {
      return { k: 'typeobj', prim: r.prim }; // 交给 Call(类型级函数,如 i64.max_value())
    }
    if (r?.k === 'stdmod') {
      return { k: 'stdmod', name: e.name }; // std.math / std.io ...
    }
    if (r?.k === 'param') {
      this.diags.push(err('M3018', `泛型参数 ${r.name} 上没有字段访问(v0.1 泛型是参数化的)`, e.span));
      return null;
    }
    this.diags.push(err('M3006', `${typeStr(r)} 没有字段 "${e.name}"`, e.span));
    return null;
  }

  stdModuleMember(stdName, fnName, e, ctx, expected) {
    const m = STD_MODULES[stdName];
    const f = m.fns.find(x => x.name === fnName);
    if (!f) {
      this.diags.push(err('M3001', `std.${stdName} 中没有 "${fnName}"(有:${m.fns.map(x => x.name).join(', ')})`, e.span));
      return null;
    }
    return { k: 'builtinmod', mod: stdName, fn: f };
  }

  moduleEntryValue(entry, name, span, fromMod, ctx, expected) {
    if (entry.kind === 'fn') {
      if (!entry.pub) this.visDiag(entry, name, span, fromMod);
      if (entry.sig.tparams.length) {
        this.diags.push(err('M3003', `泛型函数 "${name}" 作为值使用前需要确定类型参数`, span));
        return null;
      }
      const ft = mkFn(entry.sig.params.map(p => p.type), entry.sig.ret, new Set(entry.sig.effects ?? []));
      if (entry.extern) ft.extern = true; // v0.54
      return ft;
    }
    if (entry.kind === 'enum') {
      if (!entry.pub) this.visDiag(entry, name, span, fromMod);
      return { k: 'typeref', entry, mod: fromMod };
    }
    if (entry.kind === 'struct') {
      if (!entry.pub) this.visDiag(entry, name, span, fromMod);
      return { k: 'typeref', entry, mod: fromMod };
    }
    this.diags.push(err('M3001', `"${name}" 不是值`, span));
    return null;
  }

  userVariantCtor(enumT, variantDecl, targs) {
    const sub = new Map(enumT.def.tparams.map((n, i) => [n, targs[i]]));
    const ps = variantDecl.rtypes.map(t => substTypes(t, enumT.def.tparams, sub));
    return { k: 'ctor', enumT, variant: variantDecl.name, ps, arity: ps.length };
  }

  checkCall(e, ctx, expected) {
    const callee = e.callee;

    // 1) 普通标识符调用(局部/本地函数 > 模块函数 > 内置 > prelude 变体)
    if (callee.nt === 'Ident') {
      const name = callee.name;
      const local = ctx.scope.lookup(name);
      if (local) {
        local.used = true;
        return this.callFnType(local.type, e, ctx, expected);
      }
      // 本地函数
      const localFn = ctx.scope.lookupFn(name);
      if (localFn) {
        if (e.args.length !== localFn.params.length) {
          this.diags.push(err('M3005', `函数 "${name}" 需要 ${localFn.params.length} 个参数,得到 ${e.args.length}`, e.span));
        }
        const binds = new Map();
        const argTs = [];
        e.args.forEach((a, i) => {
          const t = this.checkExpr(a, ctx, localFn.params[i]?.type ?? undefined, true);
          argTs.push(t);
          if (localFn.params[i] && !unify(t, localFn.params[i].type, binds)) {
            this.diags.push(err('M3002', `参数 #${i + 1}(${localFn.params[i].name})类型不匹配:期望 ${typeStr(localFn.params[i].type)},实际 ${typeStr(t, binds)}`, a.span));
          }
        });
        this.checkPtrArgs(e.args, argTs, ctx, `函数 "${name}"`); // v0.54
        this.checkEffects(ctx, localFn.effects, callee.span);
        return localFn.ret;
      }
      const entry = ctx.mod.items.get(name);
      if (entry?.kind === 'fn') return this.callUserFn(entry, e, ctx, expected);
      if (entry?.kind === 'const') {
        this.diags.push(err('M3021', `常量 "${name}" 不是函数,不能调用`, callee.span));
        return null;
      }
      if (BUILTIN_FNS[name]) return this.checkBuiltinCall(name, e, ctx);
      if (PRELUDE_VARIANTS[name]) {
        const ctor = this.variantCtorType(PRELUDE_VARIANTS[name].enumName, PRELUDE_VARIANTS[name].variant, callee.span);
        return this.callCtor(ctor, e, ctx);
      }
      // 不是值
      const t = this.checkIdent(callee, ctx);
      if (t) return this.callFnType(t, e, ctx, expected);
      return null;
    }

    // 2) 模块成员调用 math.sqrt(x) / geom.dist(p)
    if (callee.nt === 'Field') {
      const base = callee.base;
      if (base.nt === 'Ident' && ctx.mod.imports.has(base.name)) {
        const imp = ctx.mod.imports.get(base.name);
        if (imp.std) {
          const f = this.stdModuleMember(imp.std, callee.name, callee, ctx, expected);
          if (!f) return null;
          return this.checkStdCall(f, e, ctx);
        }
        const entry = imp.local.items.get(callee.name);
        if (!entry) {
          this.diags.push(err('M3001', `模块 ${base.name} 中没有 "${callee.name}"`, callee.span));
          return null;
        }
        if (!entry.pub) this.visDiag(entry, callee.name, callee.span, imp.local);
        if (entry.kind === 'fn') return this.callUserFn(entry, e, ctx, expected);
        if (entry.kind === 'enum') {
          // geom.Shape.Circle(r) — 三段路径在此表示为 Field(Field(geom,Shape),Circle)
          const v = entry.decl.variants.find(x => x.name === callee.name);
          if (!v) { this.diags.push(err('M3024', `枚举 ${entry.decl.name} 没有变体 "${callee.name}"`, callee.span)); return null; }
          const targs = entry.decl.tparams.map(() => tvar());
          const enumT = { k: 'enum', name: entry.decl.name, def: entry.decl, mod: imp.local, targs };
          return this.callCtor(this.userVariantCtor(enumT, v, targs), e, ctx);
        }
        this.diags.push(err('M3001', `"${base.name}.${callee.name}" 不是可调用值`, callee.span));
        return null;
      }
      // 方法调用 recv.method(args)
      return this.checkMethodCall(callee, e, ctx, expected);
    }

    // 3) 其他表达式(闭包、fn 值)
    const ft = this.checkExpr(callee, ctx);
    return this.callFnType(ft, e, ctx, expected);
  }

  callUserFn(entry, e, ctx, expected) {
    const sig = entry.sig;
    const binds = new Map();
    // 效果传播:调用方必须声明被调方的全部效果
    this.checkEffects(ctx, sig.effects, e.callee.span);
    // 泛型:类型参数 → 推断变量(运行时擦除;参数上的操作由体内的 M3018 报告)
    const paramVars = sig.tparams.map(() => tvar());
    const paramMap = new Map(sig.tparams.map((n, i) => [n, paramVars[i]]));
    const argTs = [];
    for (let i = 0; i < e.args.length; i++) {
      const pt = i < sig.params.length ? substTypes(sig.params[i].type, sig.tparams, paramMap) : null;
      argTs.push(this.checkExpr(e.args[i], ctx, pt ?? undefined));
    }
    // v0.54:Ptr 实参传递门禁(extern 签名可接受 Ptr,不受块限制)
    this.checkPtrArgs(e.args, argTs, ctx, `函数 "${entry.decl.name}"`, !!entry.extern);
    if (e.args.length !== sig.params.length) {
      this.diags.push(err('M3005', `函数 "${entry.decl.name}" 需要 ${sig.params.length} 个参数,得到 ${e.args.length}`, e.span,
        sig.params.length ? `签名: ${entry.decl.name}(${sig.params.map(p => typeStr(p.type)).join(', ')})` : null));
      return sig.ret.k === 'unit' ? T_UNIT : null;
    }
    for (let i = 0; i < sig.params.length; i++) {
      const pt = substTypes(sig.params[i].type, sig.tparams, paramMap);
      if (!unify(argTs[i], pt, binds)) {
        this.diags.push(err('M3002', `参数 #${i + 1}(${sig.params[i].name})类型不匹配:期望 ${typeStr(pt, binds)},实际 ${typeStr(argTs[i], binds)}`, e.args[i].span));
      }
    }
    // bound 检查:每个 [T: Trait] 的实参必须实现该 trait
    for (const b of sig.bounds ?? []) {
      const idx = sig.tparams.indexOf(b.name);
      if (idx === -1) continue;
      const targ = resolveT(paramVars[idx], binds);
      if (targ) this.boundSatisfied(targ, b.trait, ctx, e.span);
    }
    // v0.46(M3041):调用点静态契约校验——全部实参为整数字面量时,代入 requires 求值
    if (sig.tparams.length === 0) this.checkRequiresAtCallSite(entry, e, sig);
    const ret = substTypes(sig.ret, sig.tparams, paramMap);
    const resolved = resolveT(ret, binds);
    return resolved ?? ret;
  }

  // v0.46(M3041,Jenny 反例风格):字面量实参代入 requires,静态可判定即编译期报错
  checkRequiresAtCallSite(entry, e, sig) {
    const req = entry.decl.requires;
    if (!req?.expr) return;
    const litOf = (a) => {
      if (a?.nt === 'IntLit' && a.bits === 64 && typeof a.v === 'bigint') return a.v;
      // 负字面量解析为 Unary(-IntLit)
      if (a?.nt === 'Unary' && a.op === '-' && a.expr?.nt === 'IntLit' && a.expr.bits === 64 && typeof a.expr.v === 'bigint') return -a.expr.v;
      return undefined;
    };
    const binds = new Map();
    for (let i = 0; i < sig.params.length; i++) {
      const v = litOf(e.args[i]);
      if (v === undefined) return; // v1:全部实参都是整数字面量才判定;含变量/表达式交给运行时 M4015
      binds.set(sig.params[i].name, v);
    }
    const r = this.evalContractExpr(req.expr, binds);
    if (!r.ok || r.v !== false) return; // 可判定且为假 → 报错;其余放弃判定
    const parts = [];
    for (const [n, v] of binds) parts.push(`${n} = ${v}`);
    this.diags.push(err('M3041',
      `调用点静态违反契约:实参使 requires 不成立(反例:${parts.join(', ')})${req.msg ? ';' + req.msg : ''}`,
      e.span, '调整实参以满足前置条件;该错误在运行时本会以 M4015 出现。'));
  }

  // ---------- v0.48(M3042,QF_LIA 第一片):ensures 直线体符号执行 ----------
  // 变量追踪为参数的线性形式 {coeffs: Map<param,BigInt>, c: BigInt};
  // 遇非直线语句/非 i64 参数/非子集表达式 → 静默放弃(运行时 M4015 保留,语义不变);
  // 返回点以 `result` 绑定返回值形式求值 ensures:可证明为假 → M3042 + 反例。
  // v0.52:线性形式代数与差分约束证明抽到 src/prover.js,此处只留 AST 适配与诊断。

  // 表达式 → 线性形式;子集之外返回 null(resultForm:`result` 绑定的形式)
  linOfExpr(e, varForms, resultForm) {
    switch (e.nt) {
      case 'IntLit': {
        if (e.bits !== 64 || typeof e.v !== 'bigint') return null;
        return linFromInt(e.v);
      }
      case 'Ident': {
        if (e.name === 'result' && resultForm) return { coeffs: new Map(resultForm.coeffs), c: resultForm.c };
        const f = varForms.get(e.name);
        if (!f) return null;
        return { coeffs: new Map(f.coeffs), c: f.c };
      }
      case 'Unary': {
        if (e.op !== '-') return null;
        const a = this.linOfExpr(e.expr, varForms, resultForm);
        return a ? linMulConst(a, -1n) : null;
      }
      case 'Binary': {
        const op = e.op;
        if (op === '+') {
          const l = this.linOfExpr(e.l, varForms, resultForm), r = this.linOfExpr(e.r, varForms, resultForm);
          return (l && r) ? linAdd(l, r, 1n) : null;
        }
        if (op === '-') {
          const l = this.linOfExpr(e.l, varForms, resultForm), r = this.linOfExpr(e.r, varForms, resultForm);
          return (l && r) ? linAdd(l, r, -1n) : null;
        }
        if (op === '*') {
          const l = this.linOfExpr(e.l, varForms, resultForm), r = this.linOfExpr(e.r, varForms, resultForm);
          if (l && r && linIsConst(r)) return linMulConst(l, r.c);
          if (l && r && linIsConst(l)) return linMulConst(r, l.c);
          return null;
        }
        return null; // / % 位运算移位 → 放弃
      }
      default: return null; // 调用/字段/浮点/字符串等 → 放弃
    }
  }

  // ensures 表达式在(变量 → 线性形式)下的判定:'true' | 'false' | 'unknown'
  // resultForm:返回值的线性形式(result 绑定)
  decideEnsures(e, varForms, resultForm) {
    switch (e.nt) {
      case 'Ident': {
        if (e.name === 'result') {
          if (linIsConst(resultForm)) return resultForm.c !== 0n ? 'true' : 'false';
          return 'unknown';
        }
        const f = varForms.get(e.name);
        if (f && linIsConst(f)) return f.c !== 0n ? 'true' : 'false';
        return 'unknown';
      }
      case 'Unary': {
        if (e.op !== '!') return 'unknown';
        const inner = this.decideEnsures(e.expr, varForms, resultForm);
        return inner === 'true' ? 'false' : inner === 'false' ? 'true' : 'unknown';
      }
      case 'Binary': {
        const op = e.op;
        if (op === '&&' || op === '||') {
          const l = this.decideEnsures(e.l, varForms, resultForm);
          if (op === '&&' && l === 'false') return 'false';
          if (op === '||' && l === 'true') return 'true';
          const r = this.decideEnsures(e.r, varForms, resultForm);
          if (l === r && l !== 'unknown') return l;
          return 'unknown';
        }
        if (!['==', '!=', '<', '<=', '>', '>='].includes(op)) return 'unknown';
        const l = this.linOfExpr(e.l, varForms, resultForm), r = this.linOfExpr(e.r, varForms, resultForm);
        if (!l || !r) return 'unknown';
        const diff = linAdd(l, r, -1n); // L - R
        // 常量差:直接整数判定(与 v0.48 逐字等价,零求解开销)
        if (linIsConst(diff)) {
          const c = diff.c;
          switch (op) {
            case '==': return c === 0n ? 'true' : 'false';
            case '!=': return c === 0n ? 'false' : 'true';
            case '<': return c < 0n ? 'true' : 'false';
            case '<=': return c <= 0n ? 'true' : 'false';
            case '>': return c > 0n ? 'true' : 'false';
            default: return c >= 0n ? 'true' : 'false';
          }
        }
        // v0.52:非常量差交差分约束证明。假设集本阶段为空(requires 边界假设是阶段 2/3 的事):
        // 空假设下任何含变量的单一约束皆可满足,各方向义务均不可证 → 'unknown',
        // 与 v0.48 的"非常量 → unknown"严格一致;变量 >12 → too-many-vars → 同样静默。
        return this.decideCmpByProof(diff, op);
      }
      default: return 'unknown';
    }
  }

  // v0.52:非常量差的比较叶判定,经 prover 的差分约束证明(成立/证伪两向义务):
  //   '<'  :true ⇔ 证 diff <= -1;false ⇔ 证 diff >= 0
  //   '<=' :true ⇔ 证 diff <= 0; false ⇔ 证 diff >= 1
  //   '>'  :true ⇔ 证 diff >= 1; false ⇔ 证 diff <= 0
  //   '>=' :true ⇔ 证 diff >= 0; false ⇔ 证 diff <= -1
  //   '==' :true ⇔ 双向(<= 0 且 >= 0)均证;false ⇔ 证 <= -1 或 >= 1(单向即可)
  //   '!=' :与 '==' 对偶
  // 阶段 2/3 传入非空假设集(.requires 归一化 + len$x 符号)后,同一义务表即可扩大可证面。
  decideCmpByProof(diff, op) {
    const le = (k) => proveImplication([], { lhs: diff, op: '<=', rhs: linFromInt(k) }).kind === 'proven';
    const ge = (k) => proveImplication([], { lhs: diff, op: '>=', rhs: linFromInt(k) }).kind === 'proven';
    switch (op) {
      case '<': return le(-1n) ? 'true' : ge(0n) ? 'false' : 'unknown';
      case '<=': return le(0n) ? 'true' : ge(1n) ? 'false' : 'unknown';
      case '>': return ge(1n) ? 'true' : le(0n) ? 'false' : 'unknown';
      case '>=': return ge(0n) ? 'true' : le(-1n) ? 'false' : 'unknown';
      case '==': return (le(0n) && ge(0n)) ? 'true' : (le(-1n) || ge(1n)) ? 'false' : 'unknown';
      default: return (le(-1n) || ge(1n)) ? 'true' : (le(0n) && ge(0n)) ? 'false' : 'unknown'; // '!='
    }
  }

  checkEnsuresStatically(entry) {
    const d = entry.decl;
    const ens = d.ensures;
    if (!ens?.expr) return;
    const sig = entry.sig;
    // v1:全 i64 参数
    for (const p of sig.params) {
      if (p.type?.k !== 'int' || p.type.bits !== 64 || !p.type.signed) return;
    }
    const body = d.body;
    // 直线体:语句仅 Let/Assign/ExprStmt
    for (const st of body.stmts) {
      if (!['Let', 'Assign', 'ExprStmt', 'Return'].includes(st.nt)) return;
    }
    // 变量 → 线性形式(参数初始化)
    const varForms = new Map();
    for (const p of sig.params) varForms.set(p.name, { coeffs: new Map([[p.name, 1n]]), c: 0n });
    // 遍历语句;遇到 Return/块尾 → 以当前形式判定 ensures
    const checkAtReturn = (retForm, span) => {
      const verdict = this.decideEnsures(ens.expr, varForms, retForm);
      if (verdict !== 'false') return;
      // 反例:满足 requires 的小值搜索(线性 ensures 恒假 → 任意满足 requires 的值皆反例)
      const names = sig.params.map(p => p.name);
      const cands = [0n, 1n, 2n, 3n, 5n, -1n, -2n, 10n, 100n, -5n];
      const vals = new Map();
      let found = null;
      const n = names.length;
      if (n <= 3) {
        const idx = new Array(n).fill(0);
        const total = Math.pow(cands.length, n);
        for (let t = 0; t < total && !found; t++) {
          for (let i = 0; i < n; i++) vals.set(names[i], cands[idx[i]]);
          const rr = this.evalContractExpr(d.requires?.expr ?? { nt: 'BoolLit', v: true }, vals);
          const passR = !d.requires?.expr || (rr.ok && rr.v === true);
          if (passR) {
            // 用同一组值复核 ensures 数值(线性求值)
            const resVal = linEvalAt(retForm, vals);
            const v2 = new Map(vals);
            v2.set('result', resVal);
            const rr2 = this.evalContractExpr(ens.expr, v2);
            if (rr2.ok && rr2.v === false) found = new Map(vals);
          }
          let carry = 0;
          while (carry < n) {
            idx[carry]++;
            if (idx[carry] < cands.length) break;
            idx[carry] = 0; carry++;
          }
          if (carry >= n) break;
        }
      }
      if (found) {
        const parts = [];
        for (const [k, v] of found) parts.push(`${k} = ${v}`);
        this.diags.push(err('M3042',
          `函数 "${d.name}" 的 ensures 可静态证伪(反例:${parts.join(', ')})${ens.msg ? ';' + ens.msg : ''}`,
          ens.span ?? d.span, '修正确保表达式或函数体;该错误在运行时本会以 M4015 出现。'));
      } else {
        this.diags.push(err('M3042',
          `函数 "${d.name}" 的 ensures 可静态证伪${ens.msg ? ';' + ens.msg : ''}`,
          ens.span ?? d.span, '修正确保表达式或函数体;该错误在运行时本会以 M4015 出现。'));
      }
    };
    // Return 语句单独走:以返回值形式判定(直接递归处理块的后续不需要——直线体遇 return 即结束)
    const walkBodyForReturns = (block) => {
      for (const st of block.stmts) {
        if (st.nt === 'Return') {
          const f = st.value ? this.linOfExpr(st.value, varForms) : null;
          if (f) checkAtReturn(f, st.span ?? block.span);
          return; // return 之后的语句不可达,停止本块分析
        }
        if (st.nt === 'Let' && st.pat?.nt === 'PIdent') {
          const f2 = this.linOfExpr(st.init, varForms);
          if (f2) varForms.set(st.pat.name, f2); else return;
        } else if (st.nt === 'Assign' && st.target?.nt === 'Ident') {
          const f3 = this.linOfExpr(st.value, varForms);
          if (f3 && varForms.has(st.target.name)) varForms.set(st.target.name, f3); else return;
        } else if (st.nt === 'ExprStmt' && st.expr?.nt === 'Call') {
          continue;
        } else if (st.nt !== 'ExprStmt') {
          return; // 非直线语句 → 放弃整条路径
        }
      }
      if (block.tail) {
        const f4 = this.linOfExpr(block.tail, varForms);
        if (f4) checkAtReturn(f4, block.tail.span ?? block.span);
      }
    };
    walkBodyForReturns(body);
  }

  // ---------- v0.52 阶段 2(M3045/W3105,QF_LIA 第二片):requires 边界的 Vec 索引越界静态证明 ----------
  // 范围(超范围一律静默放弃,不误报是硬门槛):
  //   i64 参数(含 mut,Assign(=) 更新其线性形式);非 mut 的 Vec[i64] 参数(基名 → len$x 符号);
  //   requires 中可编码的合取叶子(==/</<=/>/>=;|| / != / 非线性 / 未知 len 的叶子跳过 = 不作为假设);
  //   直线体(Let / Assign(= / Ident 目标)/ Return / 纯调用语句——与 M3042 遍历同口径);
  //   单个索引点 buf[i](含作为表达式子项;按求值序内层先登记)。
  // 保守性合同:假设集负环(unsat)= requires 自相矛盾 → 函数不可达 → 整函数跳过报告(语义不变);
  //   义务两向证明:两向都成立 → 安全;任一被证伪 → M3045 + 小值反例(反例按被跳过的可求值
  //   requires 叶子过滤,保证满足完整 requires;无候选则不给反例);其余未证明 → 默认静默,
  //   仅在 options.warnUnprovenIndex(--warn-unproven-index)下发 W3105(文件已有 error 诊断时不叠加)。
  // 只报告不改语义:运行时 M4003 保留;compiler/interp/vm/cbackend/artifact 零改动。

  // 表达式 → 线性形式(变量:i64 参数名与 len$x 符号;子集之外 → null)。
  // 与 M3042 的 linOfExpr 平行,额外支持 x.len()(仅限被追踪的非 mut Vec 参数)→ 新符号 len$x。
  linOfBoundExpr(e, varForms, vecTracked) {
    switch (e.nt) {
      case 'IntLit': return (e.bits === 64 && typeof e.v === 'bigint') ? linFromInt(e.v) : null;
      case 'Ident': {
        const f = varForms.get(e.name);
        return f ? { coeffs: new Map(f.coeffs), c: f.c } : null;
      }
      case 'Unary': {
        if (e.op !== '-') return null;
        const a = this.linOfBoundExpr(e.expr, varForms, vecTracked);
        return a ? linMulConst(a, -1n) : null;
      }
      case 'Binary': {
        const op = e.op;
        if (op === '+' || op === '-') {
          const l = this.linOfBoundExpr(e.l, varForms, vecTracked);
          const r = this.linOfBoundExpr(e.r, varForms, vecTracked);
          return (l && r) ? linAdd(l, r, op === '+' ? 1n : -1n) : null;
        }
        if (op === '*') {
          const l = this.linOfBoundExpr(e.l, varForms, vecTracked);
          const r = this.linOfBoundExpr(e.r, varForms, vecTracked);
          if (l && r && linIsConst(r)) return linMulConst(l, r.c);
          if (l && r && linIsConst(l)) return linMulConst(r, l.c);
          return null;
        }
        return null; // / % 位运算移位比较等 → 放弃
      }
      case 'Call': {
        // x.len():仅限被追踪的非 mut Vec 参数(局部 Vec / mut 参数 / 其他接收者 → 整体 unknown)
        const cal = e.callee;
        if (e.args?.length === 0 && cal?.nt === 'Field' && cal.name === 'len' && cal.base?.nt === 'Ident') {
          const lv = vecTracked.get(cal.base.name);
          if (lv) return { coeffs: new Map([[lv, 1n]]), c: 0n };
        }
        return null;
      }
      default: return null;
    }
  }

  // 按 span 从模块源码切原文(单行直取;跨行逐段拼接;越界返回 null)
  boundSourceText(src, span) {
    if (!src || !span?.line || !span.file) return null;
    const lines = src.split(/\r?\n/);
    const l1 = span.line, l2 = span.endLine ?? span.line;
    if (l1 < 1 || l2 < l1 || l2 > lines.length) return null;
    if (l1 === l2) {
      const line = lines[l1 - 1];
      const a = Math.max(0, (span.col ?? 1) - 1);
      const b = Math.min(line.length, Math.max(a, (span.endCol ?? 1) - 1));
      return line.slice(a, b);
    }
    const out = [lines[l1 - 1].slice(Math.max(0, (span.col ?? 1) - 1))];
    for (let i = l1; i <= l2 - 2; i++) out.push(lines[i]);
    out.push(lines[l2 - 1].slice(0, Math.max(0, (span.endCol ?? 1) - 1)));
    return out.join('\n');
  }

  checkIndexBoundsStatically(entry, mod) {
    const d = entry.decl;
    const sig = entry.sig;
    if (!d.body || !d.requires?.expr || !sig) return; // 无 requires → 无边界可依(含 extern/测试;静默)

    // 参数分类(签名序,确定性):i64 参数(含 mut);非 mut 的 Vec[i64] 参数 → len$x 符号
    const i64Params = [];
    const vecParamsAll = new Map(); // 原始集合(name → len$x;反例枚举用)
    for (const p of sig.params) {
      const t = p.type;
      if (t?.k === 'int' && t.bits === 64 && t.signed) { i64Params.push(p.name); continue; }
      if (!p.mut && t?.k === 'vec' && t.el?.k === 'int' && t.el.bits === 64 && t.el.signed) {
        vecParamsAll.set(p.name, 'len$' + p.name);
      }
    }
    if (vecParamsAll.size === 0) return; // 无可分析基 → 静默
    const i64ParamSet = new Set(i64Params);

    // 1) requires 归一化:合取叶子 → 差分约束假设(|| / != / 非线性 / 未知 len 的叶子跳过);
    //    被跳过叶子另存 skippedLeaves —— M3045 反例枚举命中后按其过滤(第 4 步),保证反例满足完整 requires
    const varForms = new Map();
    for (const nm of i64Params) varForms.set(nm, { coeffs: new Map([[nm, 1n]]), c: 0n });
    const vecTracked = new Map(vecParamsAll); // 直线体内的存活集合(名字重绑定即移除)
    const assumptions = [];
    const skippedLeaves = [];
    const leaves = [];
    const collectConj = (e) => {
      if (e.nt === 'Binary' && e.op === '&&') { collectConj(e.l); collectConj(e.r); return; }
      leaves.push(e);
    };
    collectConj(d.requires.expr);
    for (const leaf of leaves) {
      if (leaf.nt !== 'Binary' || !['==', '<', '<=', '>', '>='].includes(leaf.op)) { skippedLeaves.push(leaf); continue; } // || / 布尔叶子 → 跳过
      const l = this.linOfBoundExpr(leaf.l, varForms, vecTracked);
      const r = this.linOfBoundExpr(leaf.r, varForms, vecTracked);
      if (!l || !r) { skippedLeaves.push(leaf); continue; } // 非线性 / 未知 len 等 → 该子句不作为假设
      assumptions.push({ lhs: l, op: leaf.op, rhs: r });
    }

    // 2) 假设集负环(unsat)= requires 自相矛盾 → 函数不可达 → 整函数跳过报告(运行时语义不变);
    //    变量超上限(too-many-vars)同样整函数放弃
    if (solveDiffConstraints(assumptions).kind !== 'sat') return;

    // 3) 直线体符号执行:按求值序收集索引义务;遇非直线语句 → 后续义务不再收集
    const src = mod?.src ?? null;
    const obligations = [];
    const unproven = [];
    let aborted = false;
    const registerPoint = (e) => {
      if (e.base.nt !== 'Ident') return;
      const lenVar = vecTracked.get(e.base.name);
      if (!lenVar) return; // 局部 Vec / mut Vec 参数 / 已重绑定名字 → 静默放弃
      const form = this.linOfBoundExpr(e.index, varForms, vecTracked);
      const bs = e.base.span ?? e.span;
      const span = { file: bs.file, line: bs.line, col: bs.col, endLine: e.span?.endLine ?? bs.endLine, endCol: e.span?.endCol ?? bs.endCol };
      // 索引原文:从完整 Index 跨度切方括号内文。不能用 e.index.span 直接切 —— parser 的
      // Binary/Call 子节点 span 起点在操作符/实参括号(buf[n * n] 会截成 "* n"、buf.len() 截成 "()"),
      // 而 Index span 覆盖 buf[...] 全程;取首个 '[' 之后、去掉结尾 ']' 即索引内文(嵌套括号安全)。
      const fullIdx = this.boundSourceText(src, e.span) ?? '';
      const br = fullIdx.indexOf('[');
      const idxText = (br >= 0 && fullIdx.endsWith(']'))
        ? fullIdx.slice(br + 1, -1)
        : (this.boundSourceText(src, e.index.span) ?? '?');
      const text = this.boundSourceText(src, span) ?? `${e.base.name}[…]`;
      obligations.push({ baseName: e.base.name, lenVar, form, span, text, idxText });
    };
    // 表达式白名单下钻(全部无条件求值且不含嵌套语句);Lambda/Match/If/BlockExpr 等不下钻
    const descend = (e) => {
      if (!e || typeof e.nt !== 'string') return;
      switch (e.nt) {
        case 'Unary': descend(e.expr); return;
        case 'Binary': descend(e.l); descend(e.r); return;
        case 'Index': descend(e.base); descend(e.index); registerPoint(e); return;
        case 'Field': descend(e.base); return;
        case 'Call': descend(e.callee); for (const a of e.args ?? []) descend(a); return;
        case 'As': case 'PostQ': descend(e.expr); return;
        case 'StrLit': for (const p of e.parts ?? []) if (p.expr) descend(p.expr); return;
        case 'VecLit': case 'TupleLit': for (const x of e.elems ?? []) descend(x); return;
        case 'MapLit': for (const en of e.entries ?? []) { descend(en.k); descend(en.v); } return;
        case 'StructLit': for (const f of e.fields ?? []) descend(f.value); return;
        case 'Range': descend(e.lo); descend(e.hi); return;
        default: return;
      }
    };
    const walk = (block) => {
      for (const st of block.stmts) {
        if (st.nt === 'Return') {
          if (st.value) descend(st.value);
          aborted = true; // return 后不可达,结束本块(M3042 同口径)
          return;
        }
        if (st.nt === 'Let' && st.pat?.nt === 'PIdent') {
          descend(st.init);
          const f = this.linOfBoundExpr(st.init, varForms, vecTracked);
          if (!f) { aborted = true; return; } // 形式不可计算 → 后续义务 unknown(不报告)
          varForms.set(st.pat.name, f);
          if (vecTracked.has(st.pat.name)) vecTracked.delete(st.pat.name); // 名字重绑定:不再是原 Vec 参数
          continue;
        }
        if (st.nt === 'Assign' && st.target?.nt === 'Ident' && st.op === '=') {
          descend(st.value);
          const f = this.linOfBoundExpr(st.value, varForms, vecTracked);
          if (!f || !varForms.has(st.target.name)) { aborted = true; return; }
          varForms.set(st.target.name, f);
          if (vecTracked.has(st.target.name)) vecTracked.delete(st.target.name);
          continue;
        }
        if (st.nt === 'ExprStmt') { descend(st.expr); continue; } // 纯调用/裸表达式语句
        // 其余(复合赋值、下标赋值目标、If/While/Match、元组模式 let 等):无条件求值部分先收集,再放弃
        if (st.nt === 'Assign') { descend(st.target); descend(st.value); }
        aborted = true;
        return;
      }
      if (!aborted && block.tail) descend(block.tail);
    };
    walk(d.body);

    // 4) 义务判定:0 <= i 与 i < len$buf;两向证明(成立 / 违反),未证明默认静默
    //    v0.52 阶段 3:逐义务结果同步记入 obResults(--proof-report 消费;诊断输出逐字不变)
    const cmpHold = (x, op, y) => op === '==' ? x === y : op === '<=' ? x <= y : op === '<' ? x < y : op === '>=' ? x >= y : x > y;
    const obResults = [];
    for (const ob of obligations) {
      const lf = { coeffs: new Map([[ob.lenVar, 1n]]), c: 0n };
      if (!ob.form) {
        const goals = [`0 <= ${ob.idxText}`, `${ob.idxText} < len$${ob.baseName}`];
        unproven.push({ ob, goals });
        obResults.push({ ob, kind: 'unproven', obligation: goals.join('; '), counterexample: null });
        continue;
      }
      const lowOk = proveImplication(assumptions, { lhs: ob.form, op: '>=', rhs: linFromInt(0n) }).kind === 'proven';
      const highOk = proveImplication(assumptions, { lhs: ob.form, op: '<', rhs: lf }).kind === 'proven';
      if (lowOk && highOk) {
        obResults.push({ ob, kind: 'proven', obligation: `0 <= ${ob.idxText} && ${ob.idxText} < len$${ob.baseName}`, counterexample: null });
        continue; // 两向都成立 → 可证安全,不报告
      }
      const lowBad = !lowOk && proveImplication(assumptions, { lhs: ob.form, op: '<', rhs: linFromInt(0n) }).kind === 'proven';
      const highBad = !highOk && proveImplication(assumptions, { lhs: ob.form, op: '>=', rhs: lf }).kind === 'proven';
      if (!lowBad && !highBad) {
        const goals = [];
        if (!lowOk) goals.push(`0 <= ${ob.idxText}`);
        if (!highOk) goals.push(`${ob.idxText} < len$${ob.baseName}`);
        unproven.push({ ob, goals });
        obResults.push({ ob, kind: 'unproven', obligation: goals.join('; '), counterexample: null });
        continue;
      }
      const kind = lowBad ? 'low' : 'high';
      const oblText = kind === 'low' ? `0 <= ${ob.idxText}` : `${ob.idxText} < len$${ob.baseName}`;
      // 反例:i64 参数从 {-2,-1,0,1,2}、len$x 从 0..8 确定性枚举(签名序,首个变量最慢);
      // 只枚举出现在已采纳假设或违反义务中的变量(≤3 个 i64 + ≤2 个 len,超限不给反例);
      // 命中候选后按被跳过叶子过滤(evalContractExpr 代入求值)—— 反例必须满足完整 requires(v0.52.1)
      const relVars = new Set();
      for (const a of assumptions) for (const s of [a.lhs, a.rhs]) for (const k of s.coeffs.keys()) relVars.add(k);
      for (const k of ob.form.coeffs.keys()) relVars.add(k);
      if (kind === 'high') relVars.add(ob.lenVar);
      const enumVars = [];
      let nI64 = 0, nLen = 0;
      for (const p of sig.params) {
        if (i64ParamSet.has(p.name) && relVars.has(p.name)) { enumVars.push({ name: p.name, vals: [-2n, -1n, 0n, 1n, 2n] }); nI64++; }
        else if (vecParamsAll.get(p.name) && relVars.has(vecParamsAll.get(p.name))) { enumVars.push({ name: vecParamsAll.get(p.name), vals: [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] }); nLen++; }
      }
      let found = null;
      if (nI64 <= 3 && nLen <= 2) {
        const vals = new Map();
        const idx = new Array(enumVars.length).fill(0);
        for (;;) {
          for (let i = 0; i < enumVars.length; i++) vals.set(enumVars[i].name, enumVars[i].vals[idx[i]]);
          if (assumptions.every((a) => cmpHold(linEvalAt(a.lhs, vals), a.op, linEvalAt(a.rhs, vals)))) {
            const iv = linEvalAt(ob.form, vals);
            if (kind === 'low' ? iv < 0n : iv >= linEvalAt(lf, vals)) {
              // 被跳过叶子逐一代入过滤:可求值(evalContractExpr ok)必须为真,不可求值不据此剔除;
              // 全部候选被滤掉 → found 保持 null,退回"无反例"消息变体
              if (skippedLeaves.every((sl) => { const r2 = this.evalContractExpr(sl, vals); return !r2.ok || r2.v === true; })) {
                found = new Map(vals); break;
              }
            }
          }
          let carry = enumVars.length - 1; // 末位最快推进,确定性枚举序
          while (carry >= 0) {
            idx[carry]++;
            if (idx[carry] < enumVars[carry].vals.length) break;
            idx[carry] = 0; carry--;
          }
          if (carry < 0) break;
        }
      }
      const parts = [];
      if (found) for (const [k, v] of found) parts.push(`${k} = ${v}`);
      const cex = parts.length ? `(反例:${parts.join(', ')})` : '';
      const msgSuffix = d.requires.msg ? ';' + d.requires.msg : '';
      obResults.push({ ob, kind: 'violated', obligation: oblText, counterexample: parts.length ? parts.join(', ') : null });
      this.diags.push(err('M3045',
        `函数 "${d.name}" 的索引 "${ob.text}" 可静态证明越界(违反义务:${oblText})${cex}${msgSuffix}`,
        ob.span,
        `让索引满足 ${oblText} 对所有满足 requires 的调用成立(调整 requires 边界或索引表达式);该越界在运行时本会以 M4003 panic。`));
    }

    // 5) 未证明清单:默认只收集;options.warnUnprovenIndex(--warn-unproven-index)下发 W3105。
    //    噪声门控:该文件已有 error 诊断(如索引类型错误 M3002)时不再叠加 W3105 —— 错误优先,告警不稀释
    if (this.options?.warnUnprovenIndex && unproven.length > 0) {
      const file = unproven[0].ob.span.file ?? mod.file;
      const hasError = this.diags.some((x) => x.severity === 'error' && (x.span?.file ?? null) === file);
      if (!hasError) {
        for (const u of unproven) {
          this.diags.push(warn('W3105',
            `函数 "${d.name}" 的索引 "${u.ob.text}" 无法静态证明在界内(未证明:${u.goals.join('; ')})`,
            u.ob.span));
        }
      }
    }

    // 6) 证明记录(v0.52 阶段 3,--proof-report 消费):仅登记有索引义务的函数;纯只读视图,
    //    不进诊断通道、不影响退出码 —— 与 M3045/W3105 共存而不冲突
    if (obligations.length > 0) {
      const file = obResults[0].ob.span.file ?? mod.file;
      const rec = { file, fn: d.name, total: obligations.length, proven: 0, violated: 0, unproven: 0, obligations: [] };
      for (const r of obResults) {
        rec[r.kind]++;
        rec.obligations.push({
          file, fn: d.name, index: r.ob.idxText, kind: r.kind, obligation: r.obligation,
          line: r.ob.span.line ?? null, col: r.ob.span.col ?? null, counterexample: r.counterexample,
        });
      }
      this.proofRecords.push(rec);
    }
  }

  // 契约表达式线性子集求值(IntLit/Ident/一元 - !/算术 +-*/%/比较/&& ||)。
  // 返回 {ok:true, v:BigInt|bool} 或 {ok:false}(子集之外、除零、i64 溢出均放弃判定)。
  evalContractExpr(e, binds) {
    switch (e.nt) {
      case 'IntLit': {
        if (e.bits !== 64 || typeof e.v !== 'bigint') return { ok: false };
        return { ok: true, v: e.v };
      }
      case 'Ident': {
        const b = binds.get(e.name);
        return b !== undefined ? { ok: true, v: b } : { ok: false };
      }
      case 'Unary': {
        const a = this.evalContractExpr(e.expr, binds);
        if (!a.ok) return a;
        if (e.op === '-' && typeof a.v === 'bigint') return { ok: true, v: -a.v };
        if (e.op === '!' && typeof a.v === 'boolean') return { ok: true, v: !a.v };
        return { ok: false };
      }
      case 'Binary': {
        const op = e.op;
        if (op === '&&' || op === '||') {
          const l = this.evalContractExpr(e.l, binds);
          if (!l.ok || typeof l.v !== 'boolean') return { ok: false };
          if (op === '&&' && !l.v) return { ok: true, v: false };
          if (op === '||' && l.v) return { ok: true, v: true };
          const r = this.evalContractExpr(e.r, binds);
          if (!r.ok || typeof r.v !== 'boolean') return { ok: false };
          return { ok: true, v: r.v };
        }
        const l = this.evalContractExpr(e.l, binds);
        const r = this.evalContractExpr(e.r, binds);
        if (!l.ok || !r.ok) return { ok: false };
        if (['==', '!=', '<', '<=', '>', '>='].includes(op)) {
          if (typeof l.v !== typeof r.v) return { ok: false };
          let b2;
          switch (op) {
            case '==': b2 = l.v === r.v; break;
            case '!=': b2 = l.v !== r.v; break;
            case '<': b2 = l.v < r.v; break;
            case '<=': b2 = l.v <= r.v; break;
            case '>': b2 = l.v > r.v; break;
            default: b2 = l.v >= r.v; break;
          }
          return { ok: true, v: b2 };
        }
        if (typeof l.v !== 'bigint' || typeof r.v !== 'bigint') return { ok: false };
        const I64_MIN = -(2n ** 63n), I64_MAX = (2n ** 63n) - 1n;
        let v;
        switch (op) {
          case '+': v = l.v + r.v; break;
          case '-': v = l.v - r.v; break;
          case '*': v = l.v * r.v; break;
          case '/': if (r.v === 0n || (r.v === -1n && l.v === I64_MIN)) return { ok: false }; v = l.v / r.v; break;
          case '%': if (r.v === 0n) return { ok: false }; v = l.v % r.v; break;
          default: return { ok: false }; // 位运算/移位 v1 不支持(放弃判定)
        }
        if (v < I64_MIN || v > I64_MAX) return { ok: false }; // 溢出语义无法镜像,放弃判定
        return { ok: true, v };
      }
      default: return { ok: false };
    }
  }

  callFnType(ft, e, ctx, expected) {
    const r = resolveT(ft, new Map());
    if (!r) return null;
    if (r.k === 'ctor') return this.callCtor(r, e, ctx);
    if (r.k !== 'fn') {
      this.diags.push(err('M3021', `${typeStr(r)} 不是函数,不能调用`, e.callee.span));
      return null;
    }
    if (r.effects?.size) this.checkEffects(ctx, r.effects, e.callee.span);
    if (e.args.length !== r.ps.length) {
      this.diags.push(err('M3005', `这个函数需要 ${r.ps.length} 个参数,得到 ${e.args.length}`, e.span));
    }
    const binds = new Map();
    const argTs = [];
    for (let i = 0; i < e.args.length; i++) {
      argTs.push(this.checkExpr(e.args[i], ctx, r.ps[i] ?? undefined));
    }
    this.checkPtrArgs(e.args, argTs, ctx, '函数值', !!r.extern); // v0.54
    for (let i = 0; i < Math.min(e.args.length, r.ps.length); i++) {
      if (!unify(argTs[i], r.ps[i], binds)) {
        this.diags.push(err('M3002', `参数 #${i + 1} 类型不匹配:期望 ${typeStr(r.ps[i], binds)},实际 ${typeStr(argTs[i], binds)}`, e.args[i].span));
      }
    }
    return resolveT(r.ret, binds) ?? r.ret;
  }

  callCtor(ctor, e, ctx) {
    if (!ctor) return null;
    const binds = new Map();
    if (e.args.length !== ctor.arity) {
      this.diags.push(err('M3005', `变体 ${ctor.enumT.name}.${ctor.variant} 需要 ${ctor.arity} 个值,得到 ${e.args.length}`, e.span));
    }
    const argTs = e.args.map(a => this.checkExpr(a, ctx, ctor.ps?.[0] ?? undefined));
    // v0.54 审查 B3:Some(q)/Ok(q)/用户变体把 Ptr 装进载荷,同样不能在 unsafe 块外。
    // 报在调用表达式 span 上,便于与 checkPtrArgs(直接作为实参)按 span 去重。
    const ptrI = argTs.findIndex(t => typeContainsPtr(t ? resolveT(t, new Map()) : null));
    if (ptrI >= 0) this.checkPtrPayload(argTs[ptrI], e.span, ctx, '变体载荷');
    if (ctor.ps) {
      for (let i = 0; i < Math.min(argTs.length, ctor.ps.length); i++) {
        if (!unify(argTs[i], ctor.ps[i], binds)) {
          this.diags.push(err('M3002', `变体值类型不匹配:期望 ${typeStr(ctor.ps[i], binds)},实际 ${typeStr(argTs[i], binds)}`, e.args[i].span));
        }
      }
    }
    return resolveT(ctor.enumT, binds) ?? ctor.enumT;
  }

  checkBuiltinCall(name, e, ctx) {
    const spec = BUILTIN_FNS[name];
    if (spec.effect) this.checkEffects(ctx, new Set([spec.effect]), e.callee.span);
    const min = spec.min ?? spec.params.length;
    const max = spec.max ?? spec.params.length;
    if (e.args.length < min || e.args.length > max) {
      this.diags.push(err('M3005', `${name} 需要 ${min}${max !== min ? '-' + max : ''} 个参数,得到 ${e.args.length}`, e.span));
    }
    // v0.40 修复:内建调用参数是值位置(此前缺 valuePos → if 表达式实参返回 unit)
    const argTs = e.args.map(a => this.checkExpr(a, ctx, undefined, true));
    const binds = new Map();
    for (let i = 0; i < Math.min(argTs.length, spec.params.length); i++) {
      const p = spec.params[i];
      if (p === 'display') {
        if (!isPrimitiveDisplay(argTs[i], binds)) {
          this.diags.push(err('M3002', `${name} 的参数 #${i + 1} 必须是 int/float/bool/str,实际是 ${typeStr(argTs[i], binds)}`, e.args[i].span,
            '其他类型用 debug(x)。'));
        }
      } else if (p === 'any') {
        const r = resolveT(argTs[i], binds);
        if (spec.noFn && r?.k === 'fn') this.diags.push(err('M3002', 'debug 不能用于函数值', e.args[i].span));
        // v0.54:Ptr 不可打印/调试
        if (r?.k === 'ptr') this.diags.push(err('M3002', `${typeStr(r)} 不能传给 debug(指针不可打印)`, e.args[i].span));
      } else if (p === 'eq') {
        if (i === 1 && !unify(argTs[0], argTs[1], binds)) {
          this.diags.push(err('M3002', `assert_eq 两侧类型不同:${typeStr(argTs[0], binds)} vs ${typeStr(argTs[1], binds)}`, e.span));
        }
        if (!isComparable(argTs[i], binds)) this.diags.push(err('M3008', 'assert_eq 不支持函数值', e.args[i].span));
      } else if (p === 'jsonval') {
        this.checkJsonCompatible(argTs[i], binds, e.args[i].span);
      } else if (!unify(argTs[i], p, binds)) {
        this.diags.push(err('M3002', `${name} 的参数 #${i + 1} 类型不匹配:期望 ${typeStr(p)},实际 ${typeStr(argTs[i], binds)}`, e.args[i].span));
      }
    }
    return spec.ret;
  }

  // JSON 兼容性静态检查(递归):int/float/bool/str/Vec[T]/Map[str,T]/Option[T]/元组/Json
  checkJsonCompatible(t, binds, span, depth = 0) {
    if (depth > 32) { this.diags.push(err('M3033', '类型嵌套过深,无法 JSON 序列化', span)); return; }
    const r = resolveT(t, binds);
    if (!r) return;
    switch (r.k) {
      case 'int': case 'float': case 'bool': case 'str': case 'json': return;
      case 'vec': this.checkJsonCompatible(r.el, binds, span, depth + 1); return;
      case 'tuple': r.ts.forEach(x => this.checkJsonCompatible(x, binds, span, depth + 1)); return;
      case 'opt': this.checkJsonCompatible(r.el, binds, span, depth + 1); return;
      case 'map':
        if (resolveT(r.kt, binds)?.k !== 'str') {
          this.diags.push(err('M3033', `JSON 对象的键必须是 str,实际 ${typeStr(r.kt, binds)}`, span));
          return;
        }
        this.checkJsonCompatible(r.vt, binds, span, depth + 1);
        return;
      default:
        this.diags.push(err('M3033', `${typeStr(r, binds)} 不能 JSON 序列化(结构体/枚举请自行拆解字段)`, span,
          'JSON 兼容类型:int/float/bool/str/Vec[T]/Map[str, T]/Option[T]/元组/Json。'));
    }
  }

  checkStdCall(f, e, ctx) {
    // ---- std.sync.spawn / std.sync.join(泛型特例)----
    if (f.mod === 'sync' && f.fn.name === 'spawn') {
      if (f.fn.effect) this.checkEffects(ctx, new Set([f.fn.effect]), e.callee?.span ?? e.span);
      if (e.args.length < 1) {
        this.diags.push(err('M3005', 'spawn 需要 1-N 个参数:spawn(函数值, 参数...)', e.span));
        return null;
      }
      const fnT = this.checkExpr(e.args[0], ctx);
      const fnR = resolveT(fnT, new Map());
      if (!fnR || fnR.k !== 'fn') {
        this.diags.push(err('M3002', `spawn 的第一个参数必须是函数值(实际 ${typeStr(fnR, new Map())})`, e.args[0].span,
          'spawn 只接受模块级命名函数值;子任务在隔离子 VM 中运行,建议只 spawn 纯函数。'));
        return null;
      }
      if (e.args.length - 1 !== fnR.ps.length) {
        this.diags.push(err('M3005', `spawn 需要 ${fnR.ps.length} 个任务参数,得到 ${e.args.length - 1}`, e.span));
        return null;
      }
      e.args.slice(1).forEach((a, i) => {
        const at = this.checkExpr(a, ctx, fnR.ps[i]);
        if (!unify(at, fnR.ps[i], new Map())) {
          this.diags.push(err('M3002', `spawn 参数 #${i + 1} 类型不匹配:期望 ${typeStr(fnR.ps[i])},实际 ${typeStr(at, new Map())}`, a.span));
        }
      });
      const ret = fnR.ret;
      // Join 检查优先于通用跨任务白名单(更具体的错误码 M3034)
      this.checkJoinNotStored(ret, new Map(), e.span, '作为 spawn 的返回类型(子任务句柄不能跨任务)');
      if (fnR.ps.length === 1) this.checkJoinNotStored(fnR.ps[0], new Map(), e.span, '作为 spawn 的参数类型(子任务句柄不能跨任务)');
      if (ret.k !== 'int' && ret.k !== 'float' && ret.k !== 'bool' && ret.k !== 'str' && ret.k !== 'json' &&
          !(ret.k === 'vec') && !(ret.k === 'map') && !(ret.k === 'unit')) {
        this.diags.push(err('M3002', `spawn 的返回类型 ${typeStr(ret)} 不能跨任务传递(支持:int/u64/float/bool/str/Json/Vec/Map)`, e.span));
        return null;
      }
      return mkJoin(ret);
    }
    if (f.mod === 'sync' && f.fn.name === 'spawn_all') {
      if (f.fn.effect) this.checkEffects(ctx, new Set([f.fn.effect]), e.callee?.span ?? e.span);
      if (e.args.length !== 2) {
        this.diags.push(err('M3005', 'spawn_all 需要 2 个参数:spawn_all(单参数函数值, Vec[参数类型])', e.span));
        return null;
      }
      const fnT = this.checkExpr(e.args[0], ctx);
      const fnR = resolveT(fnT, new Map());
      if (!fnR || fnR.k !== 'fn' || fnR.ps.length !== 1) {
        this.diags.push(err('M3002', `spawn_all 的第一个参数必须是单参数函数值(实际 ${typeStr(fnR, new Map())})`, e.args[0].span));
        return null;
      }
      const vT = this.checkExpr(e.args[1], ctx);
      const vR = resolveT(vT, new Map());
      if (!vR || vR.k !== 'vec' || !unify(vR.el, fnR.ps[0], new Map())) {
        this.diags.push(err('M3002', `spawn_all 的第二个参数必须是 Vec[${typeStr(fnR.ps[0])}](实际 ${typeStr(vR, new Map())})`, e.args[1].span));
        return null;
      }
      const ret = fnR.ret;
      this.checkJoinNotStored(ret, new Map(), e.span, '作为 spawn_all 的任务返回类型');
      if (ret.k !== 'int' && ret.k !== 'float' && ret.k !== 'bool' && ret.k !== 'str' && ret.k !== 'json' &&
          !(ret.k === 'vec') && !(ret.k === 'map') && !(ret.k === 'unit')) {
        this.diags.push(err('M3002', `spawn_all 的任务返回类型 ${typeStr(ret)} 不能跨任务传递`, e.span));
        return null;
      }
      return mkVec(mkRes(ret, T_STR));
    }
    if (f.mod === 'sync' && f.fn.name === 'join') {
      if (f.fn.effect) this.checkEffects(ctx, new Set([f.fn.effect]), e.callee?.span ?? e.span);
      if (e.args.length !== 1) {
        this.diags.push(err('M3005', 'join 需要 1 个参数:join(句柄)', e.span));
        return null;
      }
      const ht = this.checkExpr(e.args[0], ctx);
      const hr = resolveT(ht, new Map());
      if (!hr || hr.k !== 'join') {
        this.diags.push(err('M3002', `join 的参数必须是 Join[T] 句柄(实际 ${typeStr(hr, new Map())})`, e.args[0].span));
        return null;
      }
      return mkRes(hr.el, T_STR);
    }
    if (f.mod === 'sync' && f.fn.name === 'join_detailed') {
      if (f.fn.effect) this.checkEffects(ctx, new Set([f.fn.effect]), e.callee?.span ?? e.span);
      if (e.args.length < 1 || e.args.length > 2) {
        this.diags.push(err('M3005', 'join_detailed 需要 1-2 个参数:join_detailed(句柄[, 超时毫秒])', e.span));
        return null;
      }
      const ht = this.checkExpr(e.args[0], ctx);
      const hr = resolveT(ht, new Map());
      if (!hr || hr.k !== 'join') {
        this.diags.push(err('M3002', `join_detailed 的参数必须是 Join[T] 句柄(实际 ${typeStr(hr, new Map())})`, e.args[0].span));
        return null;
      }
      if (e.args.length === 2) {
        const tt = this.checkExpr(e.args[1], ctx, INT_TYPES.i64);
        const tr = resolveT(tt, new Map());
        if (!tr || tr.k !== 'int' || tr.bits !== 64 || tr.signed !== true) {
          this.diags.push(err('M3002', `join_detailed 的超时参数必须是 i64 毫秒(实际 ${typeStr(tr, new Map())})`, e.args[1].span));
          return null;
        }
      }
      return mkRes(hr.el, { k: 'json' });
    }
    if (f.mod === 'sync' && f.fn.name === 'cancel') {
      if (f.fn.effect) this.checkEffects(ctx, new Set([f.fn.effect]), e.callee?.span ?? e.span);
      if (e.args.length !== 1) {
        this.diags.push(err('M3005', 'cancel 需要 1 个参数:cancel(句柄)', e.span));
        return null;
      }
      const ht = this.checkExpr(e.args[0], ctx);
      const hr = resolveT(ht, new Map());
      if (!hr || hr.k !== 'join') {
        this.diags.push(err('M3002', `cancel 的参数必须是 Join[T] 句柄(实际 ${typeStr(hr, new Map())})`, e.args[0].span));
        return null;
      }
      return T_BOOL;
    }
    if (f.fn.effect) this.checkEffects(ctx, new Set([f.fn.effect]), e.callee?.span ?? e.span);
    // v0.54:std.mem.alloc/free 是原生存取,必须在 unsafe 块内
    if (f.mod === 'mem') this.requireUnsafeContext(ctx, e.callee?.span ?? e.span, `std.mem.${f.fn.name}`);
    const min = f.fn.min ?? f.fn.params.length;
    const max = f.fn.max ?? f.fn.params.length;
    if (e.args.length < min || e.args.length > max) {
      this.diags.push(err('M3005', `std.${f.mod}.${f.fn.name} 需要 ${min}${max !== min ? '-' + max : ''} 个参数,得到 ${e.args.length}`, e.span));
    }
    const binds = new Map();
    const argTs = [];
    e.args.forEach((a, i) => {
      const p = f.fn.params[i];
      if (typeof p === 'string' && p === 'jsonval') {
        // JSON 兼容性静态检查(stringify 等)
        const t = this.checkExpr(a, ctx);
        argTs.push(t);
        this.checkJsonCompatible(t, binds, a.span);
        return;
      }
      const t = this.checkExpr(a, ctx, p ?? undefined);
      argTs.push(t);
      if (p && !unify(t, p, binds)) {
        this.diags.push(err('M3002', `参数 #${i + 1} 类型不匹配:期望 ${typeStr(p)},实际 ${typeStr(t, binds)}`, a.span));
      }
    });
    // mem 的 Ptr 门禁已由上面的专项检查覆盖(allowPtr=true,避免重复诊断)
    this.checkPtrArgs(e.args, argTs, ctx, `std.${f.mod}.${f.fn.name}`, f.mod === 'mem');
    return f.fn.ret;
  }

  // ---- 方法调用 ----
  checkMethodCall(fieldCallee, callNode, ctx, expected) {
    const name = fieldCallee.name;
    const args = callNode.args;

    // 用户枚举变体构造:Shape.Circle(r);内置:Option.Some(v) / Result.Ok(v)
    if (fieldCallee.base.nt === 'Ident' && !ctx.scope.lookup(fieldCallee.base.name)) {
      const baseName = fieldCallee.base.name;
      if (baseName === 'Option' || baseName === 'Result') {
        const ctor = this.variantCtorType(baseName, name, fieldCallee.span);
        return this.callCtor(ctor, callNode, ctx);
      }
      const ent = ctx.mod.items.get(baseName);
      if (ent?.kind === 'enum') {
        const v = ent.decl.variants.find(x => x.name === name);
        if (!v) {
          this.diags.push(err('M3024', `枚举 ${ent.decl.name} 没有变体 "${name}"`, fieldCallee.span));
          return null;
        }
        const targs = ent.decl.tparams.map(() => tvar());
        const enumT = { k: 'enum', name: ent.decl.name, def: ent.decl, mod: ctx.mod, targs };
        return this.callCtor(this.userVariantCtor(enumT, v, targs), callNode, ctx);
      }
    }

    const recvT = this.checkExpr(fieldCallee.base, ctx);
    const r = recvT ? resolveT(recvT, new Map()) : null;
    if (!r) return null;


  // 类型级函数:i64.max_value() / f64.nan()
    if (r.k === 'typename' || r.k === 'typeobj') {
      return this.typeLevelCall(r.prim ?? r.name, name, args, ctx, fieldCallee);
    }
    // std 命名空间:std.math.pi()(无需 use)
    if (r.k === 'stdmod') {
      const stdName = r.name === 'std' ? name : r.name;
      if (r.name === 'std') {
        // std.math... 还差一层:此处 name 是模块名,应返回 stdmod
        // 但语法上 std.math 必须出现在调用链,这里直接报错并提示
        this.diags.push(err('M3001', `"std.${name}" 是模块,需要继续调用其函数,例如 std.${name}.函数名(...)`, fieldCallee.span));
        return null;
      }
      const f = this.stdModuleMember(stdName, name, fieldCallee, ctx, expected);
      if (!f) return null;
      return this.checkStdCall(f, callNode, ctx);
    }

    const mutNeeded = MUT_METHODS.has(name);

    // Ptr 方法(v0.54):load/store/offset 需 unsafe 上下文;is_null 块外允许
    if (r.k === 'ptr') return this.ptrMethod(r, name, args, ctx, callNode, expected, fieldCallee);
    // Vec 方法
    if (r.k === 'vec') return this.vecMethod(r, name, args, ctx, callNode, expected, mutNeeded, fieldCallee);
    if (r.k === 'map') return this.mapMethod(r, name, args, ctx, callNode, expected, mutNeeded, fieldCallee);
    if (r.k === 'str') return this.strMethod(r, name, args, ctx, callNode, expected, fieldCallee);
    if (r.k === 'opt') return this.optMethod(r, name, args, ctx, callNode, expected);
    if (r.k === 'res') return this.resMethod(r, name, args, ctx, callNode, expected);
    if (r.k === 'json') return this.jsonMethod(r, name, args, ctx, callNode, expected);
    if (r.k === 'int') return this.numMethod(r, name, args, ctx, callNode, expected);
    if (r.k === 'float') return this.numMethod(r, name, args, ctx, callNode, expected);
    if (r.k === 'var') {
      this.diags.push(err('M3003', `无法推断接收者类型,不能调用方法 ".${name}"`, fieldCallee.span, CODE_HINTS.M3003));
      return null;
    }
    if (r.k === 'struct' || r.k === 'enum') {
      // 用户方法(trait impl;泛型 impl 的方法签名按接收者实例类型代换)
      const impls = this.methodImpls.get(r.def);
      const mEntry = impls?.get(name);
      if (mEntry) {
        const mspan = fieldCallee.span;
        const sig0 = mEntry.sig;
        const mtparams = sig0.tparams ?? [];
        let sig = sig0;
        if (mtparams.length) {
          if (!r.targs || r.targs.length !== mtparams.length) {
            this.diags.push(err('M4001', '内部错误:泛型方法代换的类型参数数量不符', mspan));
            return null;
          }
          // 泛型约束强化(v0.15):方法调用点校验接收者实例满足 impl 自身 bound
          // (例如 impl[A: Eq, B: Eq] Eq for Pair[A, B] 的 .eq 被调用时,校验 r.targs[0]/[1] 满足 Eq)
          const info = this.implInfo.get(r.def)?.get(mEntry.traitName);
          if (info) {
            for (const bd of info.bounds) {
              const bi = info.tparams.indexOf(bd.name);
              if (bi >= 0 && r.targs[bi]) this.boundSatisfied(r.targs[bi], bd.trait, ctx, mspan);
            }
          }
          const pmap = new Map(mtparams.map((n, i) => [n, r.targs[i]]));
          sig = {
            ...sig0,
            params: sig0.params.map(p => ({ ...p, type: substTypes(p.type, mtparams, pmap) })),
            ret: substTypes(sig0.ret, mtparams, pmap),
          };
        }
        if (sig.params[0].mut) this.checkMutReceiver(fieldCallee.base, ctx, name, mspan);
        this.checkEffects(ctx, sig.effects, mspan);
        if (args.length !== sig.params.length - 1) {
          this.diags.push(err('M3005', `方法 .${name}() 需要 ${sig.params.length - 1} 个参数,得到 ${args.length}`, mspan));
          return sig.ret;
        }
        const mbinds = new Map();
        const argTs = [];
        args.forEach((a, i) => {
          const pt = sig.params[i + 1].type;
          const t = this.checkExpr(a, ctx, pt, true);
          argTs.push(t);
          if (!unify(t, pt, mbinds)) {
            this.diags.push(err('M3002', `方法 .${name}() 参数 #${i + 1} 类型不匹配:期望 ${typeStr(pt, mbinds)},实际 ${typeStr(t, mbinds)}`, a.span));
          }
        });
        this.checkPtrArgs(args, argTs, ctx, `方法 ".${name}"`); // v0.54
        return sig.ret;
      }
      this.diags.push(err('M3015', `${typeStr(r)} 没有方法 ".${name}"`, fieldCallee.span,
        '用户类型的方法必须通过 trait impl 定义:trait T { fn m(self, ...) -> ...; } impl T for ' + r.name + ' { fn m(self, ...) -> ... { ... } }'));
      return null;
    }
    if (r.k === 'param') {
      // 泛型参数:bound 声明的 trait 方法可用(运行时按具体类型分派)
      const traitName = ctx.genericBounds?.get(r.name);
      const methods = traitName ? this.traitMethodsOf(traitName, ctx.mod) : null;
      const spec = methods?.get(name);
      if (spec) {
        if (args.length !== spec.params.length) {
          this.diags.push(err('M3005', `方法 .${name}() 需要 ${spec.params.length} 个参数,得到 ${args.length}`, fieldCallee.span));
          return r;
        }
        const mbinds = new Map();
        args.forEach((a, i) => {
          const want = resolveT(spec.params[i].type, new Map())?.k === 'selftype' ? r : spec.params[i].type;
          const t = this.checkExpr(a, ctx, want, true);
          if (!unify(t, want, mbinds)) {
            this.diags.push(err('M3002', `方法 .${name}() 参数 #${i + 1} 类型不匹配:期望 ${typeStr(want, mbinds)},实际 ${typeStr(t, mbinds)}`, a.span));
          }
        });
        return resolveT(spec.ret, new Map())?.k === 'selftype' ? r : spec.ret;
      }
      this.diags.push(err('M3018', `泛型参数 ${r.name} 上没有方法 ".${name}"(为类型参数添加 bound,例如 [${r.name}: Eq];traits:Eq / ToStr)`, fieldCallee.span));
      return null;
    }
    this.diags.push(err('M3015', `${typeStr(r)} 没有方法 ".${name}"`, fieldCallee.span));
    return null;
  }

  checkMutReceiver(baseExpr, ctx, methodName, span) {
    // v0.51:契约表达式必须纯——禁止 mut 方法修改参数/状态(M3043)
    if (ctx.contractMode) {
      this.diags.push(err('M3043', `契约表达式必须是纯表达式:不能调用会修改接收者的方法 .${methodName}()`, span,
        '把修改操作移出 requires/ensures/invariant,或改用不修改接收者的查询方法。'));
      return false;
    }
    // 方法修改接收者时,要求接收者来自可变绑定(链式 p.x / v[i] 亦然)
    let cur = baseExpr;
    for (;;) {
      if (cur.nt === 'Ident') {
        const v = ctx.scope.lookup(cur.name);
        if (!v) {
          const entry = ctx.mod.items.get(cur.name);
          if (entry?.kind === 'const') {
            this.diags.push(err('M3004', `.${methodName}() 会修改接收者,"${cur.name}" 是常量,不可修改`, span));
            return false;
          }
          this.cannotFindValue(cur.name, cur.span, ctx);
          return false;
        }
        v.used = true;
        if (!v.mut) {
          this.diags.push(err('M3004', `.${methodName}() 会修改接收者,"${cur.name}" 不是 mut`, span,
            '声明时写 let mut ' + cur.name + ' = ...'));
          return false;
        }
        return true;
      }
      if (cur.nt === 'Field' || cur.nt === 'Index') { cur = cur.base; continue; }
      return true; // 临时值,允许(修改副本无效果)
    }
  }

  arityCheck(name, args, min, max, span) {
    if (args.length < min || args.length > max) {
      this.diags.push(err('M3005', `.${name}() 需要 ${min}${max !== min ? '-' + max : ''} 个参数,得到 ${args.length}`, span));
      return false;
    }
    return true;
  }

  // v0.54:Ptr 值方法(不可索引/算术/比较/打印;offset 保持可写性)
  ptrMethod(r, name, args, ctx, callNode, expected, fieldCallee) {
    const span = fieldCallee.span, binds = new Map();
    // v0.54 审查 B4:需要 unsafe 上下文的三个方法把 unsafe 记入闭包效果集。
    // is_null 是块外也允许的纯判断,不污染闭包效果。
    if (name !== 'is_null' && ctx.effectSink) ctx.effectSink.add('unsafe');
    const aT = (i, exp) => this.checkExpr(args[i], ctx, exp);
    switch (name) {
      case 'load':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        this.requireUnsafeContext(ctx, span, '指针操作 ".load()"');
        return INT_TYPES.u8;
      case 'store': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        this.requireUnsafeContext(ctx, span, '指针操作 ".store()"');
        if (!r.mut) {
          this.diags.push(err('M3002', `${typeStr(r)} 是只读指针,不能 store(需要 Ptr[mut u8])`, span,
            'std.mem.alloc 返回 Ptr[mut u8];只读指针只能 load/is_null/offset/传递。'));
        }
        const t = aT(0, INT_TYPES.u8);
        if (!unify(t, INT_TYPES.u8, binds)) {
          this.diags.push(err('M3002', `store 的值必须是 u8,实际是 ${typeStr(t, binds)}`, args[0].span));
        }
        return T_UNIT;
      }
      case 'offset': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        this.requireUnsafeContext(ctx, span, '指针操作 ".offset()"');
        const t = aT(0, INT_TYPES.i64);
        if (!unify(t, INT_TYPES.i64, binds)) {
          this.diags.push(err('M3002', `offset 的偏移量必须是 i64,实际是 ${typeStr(t, binds)}`, args[0].span));
        }
        return mkPtr(r.el, r.mut); // 保持 mut 性
      }
      case 'is_null':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return T_BOOL; // 块外允许(仅空指针判断)
      default:
        this.diags.push(err('M3015', `${typeStr(r)} 没有方法 ".${name}"(Ptr 方法:load/store/offset/is_null)`, span));
        return null;
    }
  }

  vecMethod(r, name, args, ctx, callNode, expected, mutNeeded, fieldCallee) {
    const T = r.el, binds = new Map();
    const span = fieldCallee.span;
    const aT = (i, exp) => this.checkExpr(args[i], ctx, exp);
    switch (name) {
      case 'len': case 'is_empty':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return name === 'len' ? INT_TYPES.i64 : T_BOOL;
      case 'to_str': {
        // v0.31:仅 Vec[u8] 支持(UTF-8 解码,无效序列 → U+FFFD)
        if (!(T && T.k === 'int' && T.bits === 8 && T.signed === false)) {
          this.diags.push(err('M3015', `Vec[${typeStr(T, binds)}] 没有方法 ".to_str"(只有 Vec[u8] 支持,UTF-8 解码)`, span));
          return null;
        }
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return T_STR;
      }
      case 'push': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        if (mutNeeded) this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        const t = aT(0, T);
        if (!unify(t, T, binds)) this.diags.push(err('M3002', `push 的元素类型是 ${typeStr(T, binds)},实际 ${typeStr(t, binds)}`, args[0].span));
        this.checkPtrPayload(t, args[0].span, ctx, 'Vec 元素'); // v0.54 审查 B3
        return T_UNIT;
      }
      case 'pop':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        if (mutNeeded) this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        return mkOpt(T);
      case 'get': case 'first': case 'last': {
        if (name === 'get') {
          if (!this.arityCheck(name, args, 1, 1, span)) return null;
          const t = aT(0, INT_TYPES.i64);
          if (!unify(t, INT_TYPES.i64, binds)) this.diags.push(err('M3002', `get 的索引必须是 i64`, args[0].span));
        } else if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return mkOpt(T);
      }
      case 'contains': case 'index_of': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        if (!isComparable(T, binds)) this.diags.push(err('M3008', `Vec[${typeStr(T)}] 的元素不支持相等比较(含函数值)`, span));
        const t = aT(0, T);
        if (!unify(t, T, binds)) this.diags.push(err('M3002', `参数类型是 ${typeStr(T, binds)},实际 ${typeStr(t, binds)}`, args[0].span));
        return name === 'contains' ? T_BOOL : mkOpt(INT_TYPES.i64);
      }
      case 'reverse': case 'clear':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        return T_UNIT;
      case 'sort':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        {
          const rr = resolveT(T, new Map());
          if (!(rr?.k === 'int' || rr?.k === 'float' || rr?.k === 'str')) {
            this.diags.push(err('M3008', `.sort() 只支持元素为整数/浮点/str 的 Vec;其他类型用 sort_by(比较函数)`, span));
          }
        }
        return T_UNIT;
      case 'sort_by': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        const t = aT(0, mkFn([T, T], INT_TYPES.i64));
        if (!unify(t, mkFn([T, T], INT_TYPES.i64), binds)) {
          this.diags.push(err('M3002', `sort_by 需要 (T, T) -> i64 比较函数,实际 ${typeStr(t, binds)}`, args[0].span));
        }
        return T_UNIT;
      }
      case 'map': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        const U = tvar();
        const ft = aT(0, mkFn([T], U));
        if (!unify(ft, mkFn([T], U), binds)) {
          this.diags.push(err('M3002', `map 需要 (T) -> U 函数,实际 ${typeStr(ft, binds)}`, args[0].span));
          return null;
        }
        return mkVec(resolveT(U, binds) ?? U);
      }
      case 'filter': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        const ft = aT(0, mkFn([T], T_BOOL));
        if (!unify(ft, mkFn([T], T_BOOL), binds)) {
          this.diags.push(err('M3002', `filter 需要 (T) -> bool 函数,实际 ${typeStr(ft, binds)}`, args[0].span));
        }
        return mkVec(T);
      }
      case 'fold': {
        if (!this.arityCheck(name, args, 2, 2, span)) return null;
        const U = tvar();
        const initT = aT(0);
        unify(initT, U, binds); // 先绑定累计类型
        const U2 = resolveT(U, binds) ?? U; // 快照成具体类型,供闭包体检查使用
        const ft = aT(1, mkFn([U2, T], U2));
        if (!unify(ft, mkFn([U2, T], U2), binds)) {
          this.diags.push(err('M3002', `fold 需要 (U, T) -> U 累计函数,实际 ${typeStr(ft, binds)}`, args[1].span));
          return null;
        }
        return U2;
      }
      case 'join': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        {
          const rr = resolveT(T, new Map());
          if (rr?.k !== 'str') this.diags.push(err('M3008', `.join() 只支持 Vec[str];其他类型先 map((x) => str(x))`, span));
        }
        const t = aT(0, T_STR);
        if (!unify(t, T_STR, binds)) this.diags.push(err('M3002', `join 的分隔符必须是 str`, args[0].span));
        return T_STR;
      }
      case 'slice': {
        if (!this.arityCheck(name, args, 2, 2, span)) return null;
        args.forEach((a, i) => { const t = aT(i, INT_TYPES.i64); if (!unify(t, INT_TYPES.i64, binds)) this.diags.push(err('M3002', `slice 的参数必须是 i64`, a.span)); });
        return mkVec(T);
      }
      case 'insert': {
        if (!this.arityCheck(name, args, 2, 2, span)) return null;
        this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        const t0 = aT(0, INT_TYPES.i64);
        if (!unify(t0, INT_TYPES.i64, binds)) this.diags.push(err('M3002', `insert 的索引必须是 i64`, args[0].span));
        const t1 = aT(1, T);
        if (!unify(t1, T, binds)) this.diags.push(err('M3002', `insert 的元素类型是 ${typeStr(T, binds)},实际 ${typeStr(t1, binds)}`, args[1].span));
        this.checkPtrPayload(t1, args[1].span, ctx, 'Vec 元素'); // v0.54 审查 B3
        return T_UNIT;
      }
      case 'remove': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        const t = aT(0, INT_TYPES.i64);
        if (!unify(t, INT_TYPES.i64, binds)) this.diags.push(err('M3002', `remove 的索引必须是 i64`, args[0].span));
        return T;
      }
      case 'extend': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        const t = aT(0, mkVec(T));
        if (!unify(t, mkVec(T), binds)) this.diags.push(err('M3002', `extend 的参数类型是 ${typeStr(mkVec(T), binds)},实际 ${typeStr(t, binds)}`, args[0].span));
        this.checkPtrPayload(t, args[0].span, ctx, 'Vec 元素'); // v0.54 审查 B3
        return T_UNIT;
      }
      case 'clone':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return mkVec(T);
      case 'min': case 'max': {
        // 要求元素实现 Compare trait
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        this.boundSatisfied(T, 'Compare', ctx, span);
        return mkOpt(T);
      }
      default:
        this.diags.push(err('M3015', `Vec[${typeStr(T)}] 没有方法 ".${name}"(有:${METHOD_NAMES.vec.join(', ')})`, span));
        return null;
    }
  }

  mapMethod(r, name, args, ctx, callNode, expected, mutNeeded, fieldCallee) {
    const { kt: K, vt: V } = r, binds = new Map();
    const span = fieldCallee.span;
    const aT = (i, exp) => this.checkExpr(args[i], ctx, exp);
    switch (name) {
      case 'len': case 'is_empty':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return name === 'len' ? INT_TYPES.i64 : T_BOOL;
      case 'get':
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        { const t = aT(0, K); if (!unify(t, K, binds)) this.diags.push(err('M3002', `map 键类型是 ${typeStr(K, binds)},实际 ${typeStr(t, binds)}`, args[0].span)); }
        return mkOpt(V);
      case 'set': {
        if (!this.arityCheck(name, args, 2, 2, span)) return null;
        this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        const t0 = aT(0, K); if (!unify(t0, K, binds)) this.diags.push(err('M3002', `map 键类型是 ${typeStr(K, binds)},实际 ${typeStr(t0, binds)}`, args[0].span));
        const t1 = aT(1, V); if (!unify(t1, V, binds)) this.diags.push(err('M3002', `map 值类型是 ${typeStr(V, binds)},实际 ${typeStr(t1, binds)}`, args[1].span));
        this.checkPtrPayload(t0, args[0].span, ctx, 'Map 键'); // v0.54 审查 B3
        this.checkPtrPayload(t1, args[1].span, ctx, 'Map 值');
        return T_UNIT;
      }
      case 'has':
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        { const t = aT(0, K); if (!unify(t, K, binds)) this.diags.push(err('M3002', `map 键类型是 ${typeStr(K, binds)}`, args[0].span)); }
        return T_BOOL;
      case 'delete':
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        { const t = aT(0, K); if (!unify(t, K, binds)) this.diags.push(err('M3002', `map 键类型是 ${typeStr(K, binds)}`, args[0].span)); }
        return T_BOOL;
      case 'keys':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return mkVec(K);
      case 'values':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return mkVec(V);
      case 'items':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return mkVec(mkTuple([K, V]));
      case 'clear':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        this.checkMutReceiver(fieldCallee.base, ctx, name, span);
        return T_UNIT;
      case 'clone':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return mkMap(K, V);
      default:
        this.diags.push(err('M3015', `Map[${typeStr(K)}, ${typeStr(V)}] 没有方法 ".${name}"(有:${METHOD_NAMES.map.join(', ')})`, span));
        return null;
    }
  }

  strMethod(r, name, args, ctx, callNode, expected, fieldCallee) {
    const span = fieldCallee.span, binds = new Map();
    const aT = (i, exp) => this.checkExpr(args[i], ctx, exp);
    const strArg = (i, what) => {
      const t = aT(i, T_STR);
      if (!unify(t, T_STR, binds)) this.diags.push(err('M3002', `${what} 的参数必须是 str,实际 ${typeStr(t, binds)}`, args[i].span));
    };
    const i64Arg = (i, what) => {
      const t = aT(i, INT_TYPES.i64);
      if (!unify(t, INT_TYPES.i64, binds)) this.diags.push(err('M3002', `${what} 的参数必须是 i64,实际 ${typeStr(t, binds)}`, args[i].span));
    };
    switch (name) {
      case 'char_len': case 'byte_len':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return INT_TYPES.i64;
      case 'chars': if (!this.arityCheck(name, args, 0, 0, span)) return null; return mkVec(T_STR);
      case 'bytes': if (!this.arityCheck(name, args, 0, 0, span)) return null; return mkVec(INT_TYPES.u8);
      case 'split': if (!this.arityCheck(name, args, 1, 1, span)) return null; strArg(0, '.split()'); return mkVec(T_STR);
      case 'trim': case 'trim_start': case 'trim_end': case 'to_upper': case 'to_lower':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return T_STR;
      case 'starts_with': case 'ends_with': case 'contains':
        if (!this.arityCheck(name, args, 1, 1, span)) return null; strArg(0, `.${name}()`); return T_BOOL;
      case 'replace':
        if (!this.arityCheck(name, args, 2, 2, span)) return null; strArg(0, '.replace()'); strArg(1, '.replace()'); return T_STR;
      case 'repeat':
        if (!this.arityCheck(name, args, 1, 1, span)) return null; i64Arg(0, '.repeat()'); return T_STR;
      case 'get':
        if (!this.arityCheck(name, args, 1, 1, span)) return null; i64Arg(0, '.get()'); return mkOpt(T_STR);
      case 'slice_chars':
        if (!this.arityCheck(name, args, 2, 2, span)) return null; i64Arg(0, '.slice_chars()'); i64Arg(1, '.slice_chars()'); return T_STR;
      case 'parse_i64': if (!this.arityCheck(name, args, 0, 0, span)) return null; return mkRes(INT_TYPES.i64, T_STR);
      case 'parse_f64': if (!this.arityCheck(name, args, 0, 0, span)) return null; return mkRes(tfloat(64), T_STR);
      case 'is_empty': if (!this.arityCheck(name, args, 0, 0, span)) return null; return T_BOOL;
      case 'is_alpha': case 'is_digit': case 'is_space': case 'is_upper': case 'is_lower':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return T_BOOL;
      case 'pad_left': case 'pad_right':
        if (!this.arityCheck(name, args, 1, 1, span)) return null; i64Arg(0, '.' + name + '()'); return T_STR;
      case 'to_bytes':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return mkVec(INT_TYPES.u8);
      default:
        this.diags.push(err('M3015', `str 没有方法 ".${name}"(有:${METHOD_NAMES.str.join(', ')})`, span));
        return null;
    }
  }

  optMethod(r, name, args, ctx, callNode, expected) {
    const T = r.el, span = callNode.span, binds = new Map();
    switch (name) {
      case 'unwrap': case 'expect': {
        if (!this.arityCheck(name, args, name === 'expect' ? 1 : 0, name === 'expect' ? 1 : 0, span)) return null;
        if (name === 'expect') { const t = this.checkExpr(args[0], ctx, T_STR); if (!unify(t, T_STR, binds)) this.diags.push(err('M3002', 'expect 的参数必须是 str', args[0].span)); }
        return T;
      }
      case 'unwrap_or': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        const t = this.checkExpr(args[0], ctx, T);
        if (!unify(t, T, binds)) this.diags.push(err('M3002', `unwrap_or 的默认值类型是 ${typeStr(T, binds)},实际 ${typeStr(t, binds)}`, args[0].span));
        return T;
      }
      case 'is_some': case 'is_none':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return T_BOOL;
      default:
        this.diags.push(err('M3015', `Option[${typeStr(T)}] 没有方法 ".${name}"`, span));
        return null;
    }
  }

  resMethod(r, name, args, ctx, callNode, expected) {
    const T = r.ok, E = r.err, span = callNode.span, binds = new Map();
    switch (name) {
      case 'unwrap': case 'expect': {
        if (!this.arityCheck(name, args, name === 'expect' ? 1 : 0, name === 'expect' ? 1 : 0, span)) return null;
        if (name === 'expect') { const t = this.checkExpr(args[0], ctx, T_STR); if (!unify(t, T_STR, binds)) this.diags.push(err('M3002', 'expect 的参数必须是 str', args[0].span)); }
        return T;
      }
      case 'unwrap_err':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return E;
      case 'unwrap_or':
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        { const t = this.checkExpr(args[0], ctx, T); if (!unify(t, T, binds)) this.diags.push(err('M3002', `unwrap_or 的默认值类型不匹配`, args[0].span)); }
        return T;
      case 'is_ok': case 'is_err':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return T_BOOL;
      default:
        this.diags.push(err('M3015', `Result[${typeStr(T)}, ${typeStr(E)}] 没有方法 ".${name}"`, span));
        return null;
    }
  }

  numMethod(r, name, args, ctx, callNode, expected) {
    const span = callNode.span, binds = new Map();
    const toTargets = { to_i8: INT_TYPES.i8, to_i16: INT_TYPES.i16, to_i32: INT_TYPES.i32, to_i64: INT_TYPES.i64, to_u8: INT_TYPES.u8, to_u16: INT_TYPES.u16, to_u32: INT_TYPES.u32, to_u64: INT_TYPES.u64 };
    if (name.startsWith('to_') && toTargets[name]) {
      if (!this.arityCheck(name, args, 0, 0, span)) return null;
      return mkOpt(toTargets[name]);
    }
    switch (name) {
      case 'abs':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        if (r.k === 'float') return r;
        if (!r.signed) {
          this.diags.push(err('M3008', '无符号整数没有 .abs()', span));
          return null;
        }
        return r;
      case 'to_f32': if (!this.arityCheck(name, args, 0, 0, span)) return null; return tfloat(32);
      case 'to_f64': if (!this.arityCheck(name, args, 0, 0, span)) return null; return tfloat(64);
      case 'to_fixed': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        const t = this.checkExpr(args[0], ctx, INT_TYPES.i64);
        if (!unify(t, INT_TYPES.i64, binds)) this.diags.push(err('M3002', 'to_fixed 的参数必须是 i64(小数位数)', args[0].span));
        return T_STR;
      }
      case 'is_nan': case 'is_infinite':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return T_BOOL;
      default:
        this.diags.push(err('M3015', `${typeStr(r)} 没有方法 ".${name}"`, span));
        return null;
    }
  }

  // 类型级函数:i64.max_value() / u8.min_value() / f64.infinity() ...
  // Json 方法(动态值访问器)
  jsonMethod(r, name, args, ctx, callNode, expected) {
    const span = callNode.span, binds = new Map();
    switch (name) {
      case 'is_null': case 'is_bool': case 'is_num': case 'is_str': case 'is_arr': case 'is_obj':
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        return T_BOOL;
      case 'as_bool': case 'as_num': case 'as_str': case 'as_arr': case 'as_obj': {
        if (!this.arityCheck(name, args, 0, 0, span)) return null;
        const inner = { as_bool: T_BOOL, as_num: tfloat(64), as_str: T_STR, as_arr: mkVec({ k: 'json' }), as_obj: mkMap(T_STR, { k: 'json' }) }[name];
        return mkOpt(inner);
      }
      case 'get': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        const t = this.checkExpr(args[0], ctx, T_STR);
        if (!unify(t, T_STR, binds)) this.diags.push(err('M3002', 'get 的键必须是 str', args[0].span));
        return mkOpt({ k: 'json' });
      }
      case 'at': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        const t = this.checkExpr(args[0], ctx, INT_TYPES.i64);
        if (!unify(t, INT_TYPES.i64, binds)) this.diags.push(err('M3002', 'at 的下标必须是 i64', args[0].span));
        return mkOpt({ k: 'json' });
      }
      case 'eq': {
        if (!this.arityCheck(name, args, 1, 1, span)) return null;
        const t = this.checkExpr(args[0], ctx, { k: 'json' });
        if (!unify(t, { k: 'json' }, binds)) this.diags.push(err('M3002', 'eq 的参数必须是 Json', args[0].span));
        return T_BOOL;
      }
      default:
        this.diags.push(err('M3015', 'Json 没有方法 ".' + name + '"(有:is_null is_bool is_num is_str is_arr is_obj as_bool as_num as_str as_arr as_obj get at eq)', span));
        return null;
    }
  }

  typeLevelCall(primName, name, args, ctx, fieldCallee) {
    const span = fieldCallee.span;
    if (!this.arityCheck(name, args, 0, 0, span)) return null;
    const t = PRIM_TYPES[primName];
    if (t.k === 'int') {
      if (name === 'max_value' || name === 'min_value') return t;
    } else if (t.k === 'float') {
      if (['infinity', 'neg_infinity', 'nan'].includes(name)) return t;
    }
    this.diags.push(err('M3015', `${primName} 没有类型级函数 ".${name}"(int: max_value/min_value;float: infinity/neg_infinity/nan)`, span));
    return null;
  }

  // ---- 复合节点 ----
  checkBinary(e, ctx, expected) {
    const op = e.op;
    // v0.39 修复:操作数是值位置(此前缺 valuePos → if 表达式操作数被当作语句形式返回 unit)
    const lt = this.checkExpr(e.l, ctx, undefined, true);
    const rt = this.checkExpr(e.r, ctx, ['==', '!=', '<', '<=', '>', '>='].includes(op) ? lt ?? undefined : undefined, true);
    return this.checkBinaryOp(op, lt, rt, e.span, new Map(), e.l, e.r);
  }

  checkBinaryOp(op, lt, rt, span, binds, lNode = null, rNode = null) {
    const l = resolveT(lt, binds), r = resolveT(rt, binds);
    // 泛型参数上没有运算(v0.1 参数化泛型)
    if (l?.k === 'param' || r?.k === 'param') {
      this.diags.push(err('M3018', `泛型参数上不能做 "${op}" 运算(v0.1 泛型是参数化的;需要操作请具体化类型)`, span,
        'traits 与泛型约束计划于 v0.2。'));
      return l ?? null;
    }
    // v0.54:Ptr 禁止一切算术/比较/相等运算(移动用 p.offset(n),空判断用 p.is_null())
    if (l?.k === 'ptr' || r?.k === 'ptr') {
      if (op === '==' || op === '!=') {
        this.diags.push(err('M3008', `Ptr 不支持 "${op}" 相等比较;用 p.is_null() 判断空指针`, span));
      } else if (['<', '<=', '>', '>='].includes(op)) {
        this.diags.push(err('M3008', `Ptr 不支持 "${op}" 比较`, span));
      } else {
        this.diags.push(err('M3008', `运算符 "${op}" 不支持 ${typeStr(l)} 与 ${typeStr(r)}(Ptr 只能用 offset(n) 移动)`, span));
      }
      return T_BOOL;
    }
    const both = (pred) => l && r && pred(l) && pred(r);
    const same = () => unify(l, r, binds);
    switch (op) {
      case '+': case '-': case '*': case '/': {
        if (op === '+' && l?.k === 'str' && r?.k === 'str') return T_STR;
        if (both(t => t.k === 'int')) {
          if (!same()) {
            if (l.signed === r.signed) this.diags.push(err('M3013', `整数宽度不同:${typeStr(l)} 与 ${typeStr(r)} 不能直接运算`, span, CODE_HINTS.M3013));
            else this.diags.push(err('M3013', `有符号与无符号不能直接运算:${typeStr(l)} 与 ${typeStr(r)}`, span, CODE_HINTS.M3013));
            return l;
          }
          return l;
        }
        if (both(t => t.k === 'float')) {
          if (!same()) this.diags.push(err('M3013', `浮点宽度不同:${typeStr(l)} 与 ${typeStr(r)}`, span));
          return l;
        }
        this.diags.push(err('M3008', `运算符 "${op}" 不支持 ${typeStr(l)} 与 ${typeStr(r)}`, span,
          (l?.k === 'str' || r?.k === 'str') && op !== '+' ? '字符串只支持 "+";其他比较用对应方法' : null));
        return l ?? null;
      }
      case '%': {
        if (both(t => t.k === 'int') && same()) return l;
        this.diags.push(err('M3008', `"%" 只支持同宽度的整数(${typeStr(l)} 与 ${typeStr(r)})`, span));
        return l ?? null;
      }
      case '<<': case '>>': {
        if (l?.k === 'int' && r?.k === 'int') return l;
        this.diags.push(err('M3008', `"${op}" 要求两侧都是整数(${typeStr(l)}, ${typeStr(r)})`, span));
        return l ?? null;
      }
      case '&': case '|': case '^': {
        if (both(t => t.k === 'int') && same()) return l;
        if (l?.k === 'bool' && r?.k === 'bool') this.diags.push(err('M3008', '布尔运算用 && / ||,不用 & / |', span));
        else this.diags.push(err('M3008', `"${op}" 只支持同宽度整数(${typeStr(l)}, ${typeStr(r)})`, span));
        return l ?? null;
      }
      case '<': case '<=': case '>': case '>=': {
        const ok = (both(t => t.k === 'int') && same()) || (both(t => t.k === 'float') && same()) || (both(t => t.k === 'str'));
        if (!ok) this.diags.push(err('M3008', `"${op}" 不能比较 ${typeStr(l)} 与 ${typeStr(r)}`, span));
        return T_BOOL;
      }
      case '==': case '!=': {
        if (!same()) {
          this.diags.push(err('M3002', `"${op}" 两侧类型不同:${typeStr(l, binds)} 与 ${typeStr(r, binds)}`, span));
          return T_BOOL;
        }
        if (!isComparable(l, binds)) this.diags.push(err('M3008', '函数值不支持相等比较', span));
        if ((resolveT(l, binds)?.k === 'float')) {
          this.diags.push(warn('W3102', '浮点数用 == 比较可能因精度产生意外结果', span,
            '通常改用差值判断:abs(a - b) < 1e-9(std.math.abs)。确需相等比较可忽略此警告。'));
        }
        return T_BOOL;
      }
      case '&&': case '||': {
        if (!(l?.k === 'bool' && r?.k === 'bool')) {
          this.diags.push(err('M3008', `"${op}" 要求两侧都是 bool,实际 ${typeStr(l)} 与 ${typeStr(r)}`, span));
        }
        return T_BOOL;
      }
      default:
        this.diags.push(err('M2001', `未知运算符 "${op}"`, span));
        return null;
    }
  }

  checkIf(e, ctx, expected, valuePos = false) {
    const ct = this.checkExpr(e.cond, ctx, T_BOOL);
    if (!unify(ct, T_BOOL, new Map())) {
      this.diags.push(err('M3014', `if 条件必须是 bool,实际是 ${typeStr(ct)}`, e.cond.span,
        'Ming 没有真值化:显式写比较,例如 x != 0。'));
    }
    const expR = expected != null ? resolveT(expected, new Map()) : null;
    const stmtForm = expR ? expR.k === 'unit' : !valuePos;
    if (stmtForm) {
      // 语句形式:分支必须是 unit;else 可省略
      this.checkBlock(e.then, ctx, T_UNIT);
      if (e.els) {
        if (e.els.nt === 'If') this.checkIf(e.els, ctx, T_UNIT, false);
        else this.checkBlock(e.els, ctx, T_UNIT);
      }
      return T_UNIT;
    }
    // 值形式:必须有 else
    if (!e.els) {
      this.diags.push(err('M3002', `作为值的 if 必须有 else(此位置期望 ${typeStr(expected)})`, e.span,
        '补上 else 分支,或把它作为语句使用(分支内语句以 ";" 结尾)。'));
      this.checkBlock(e.then, ctx, expected);
      return null;
    }
    const tt = this.checkBlock(e.then, ctx, expected, true);
    const et = e.els.nt === 'If' ? this.checkIf(e.els, ctx, expected, true) : this.checkBlock(e.els, ctx, expected, true);
    const binds = new Map();
    if (tt && et && !unify(tt, et, binds) && tt.k !== 'never' && et.k !== 'never') {
      this.diags.push(err('M3002', `if 两个分支类型不同:${typeStr(tt, binds)} 与 ${typeStr(et, binds)}`, e.span));
    }
    return tt?.k === 'never' ? et : (tt ?? et);
  }

  checkMatch(e, ctx, expected) {
    const st = this.checkExpr(e.scrutinee, ctx);
    const binds = new Map();
    let resultT = null;
    const covered = { all: false, variants: new Set(), lits: new Set() };
    const scrutR = st ? resolveT(st, new Map()) : null;

    for (const arm of e.arms) {
      // 模式检查
      const armBinds = new Map();
      const scope = new Scope(ctx.scope, ctx.mod);
      const ctx2 = { ...ctx, scope };
      const cover = this.checkMatchPattern(arm.pat, st, scrutR, ctx2, armBinds);
      // 带守卫的分支不算覆盖(守卫可能不成立)
      if (!arm.guard) {
        if (cover === 'all') covered.all = true;
        else if (cover === 'variant') covered.variants.add(arm.pat.variant);
        else if (cover && typeof cover === 'object') covered.lits.add(cover.key);
      }

      if (arm.guard) {
        const gt = this.checkExpr(arm.guard, ctx2, T_BOOL);
        if (!unify(gt, T_BOOL, new Map())) this.diags.push(err('M3014', `match 守卫必须是 bool`, arm.guard.span));
      }

      const vt = this.checkExpr(arm.expr, ctx2, expected ?? undefined);
      if (vt) {
        if (resultT === null) resultT = vt;
        else if (!unify(vt, resultT, armBinds) && vt.k !== 'never' && resultT.k !== 'never') {
          this.diags.push(err('M3002', `match 分支类型不一致:${typeStr(resultT, armBinds)} 与 ${typeStr(vt, armBinds)}`, arm.span));
        }
      }
    }

    // 穷尽性
    if (!covered.all) {
      if (scrutR?.k === 'enum') {
        const missing = scrutR.def.variants.map(v => v.name).filter(n => !covered.variants.has(n));
        if (missing.length) {
          this.diags.push(err('M3007', `match 未覆盖 ${scrutR.name} 的变体:${missing.join(', ')}`, e.span,
            '补齐这些分支,或添加 "_ =>" 兜底分支。'));
        }
      } else if (scrutR?.k === 'opt') {
        if (!(covered.variants.has('Some') && covered.variants.has('None'))) {
          this.diags.push(err('M3007', 'match Option 需要 Some 与 None 分支,或添加 "_" 兜底', e.span));
        }
      } else if (scrutR?.k === 'res') {
        if (!(covered.variants.has('Ok') && covered.variants.has('Err'))) {
          this.diags.push(err('M3007', 'match Result 需要 Ok 与 Err 分支,或添加 "_" 兜底', e.span));
        }
      } else if (scrutR?.k === 'bool') {
        if (!(covered.lits.has('true') && covered.lits.has('false'))) {
          this.diags.push(err('M3007', 'match bool 需要覆盖 true 和 false,或添加 "_" 分支', e.span));
        }
      } else if (scrutR && scrutR.k !== 'never') {
        this.diags.push(err('M3007', `match ${typeStr(scrutR)} 必须有 "_" 或绑定分支兜底(字面量分支无法穷尽)`, e.span));
      }
    }

    if (expected && resultT && !unify(resultT, expected, binds) && resultT.k !== 'never') {
      this.diags.push(err('M3002', `match 的值类型 ${typeStr(resultT, binds)} 与期望的 ${typeStr(expected)} 不匹配`, e.span));
    }
    return resultT;
  }

  // 返回:'all' | 'variant' | {key} | null(不覆盖)
  checkMatchPattern(pat, scrutT, scrutR, ctx, binds) {
    switch (pat.nt) {
      case 'PWild': return 'all';
      case 'PIdent': {
        if (scrutT) ctx.scope.bind(pat.name, scrutT, false, pat.span, false);
        return 'all';
      }
      case 'PLit': {
        const lit = pat.lit;
        let litT;
        if (lit.kind === 'int') {
          litT = pat.neg ? { ...tint(lit.extra.bits, lit.extra.signed) } : tint(lit.extra.bits, lit.extra.signed);
          const v = BigInt(lit.val) * (pat.neg ? -1n : 1n);
          if (scrutR?.k === 'int') {
            if (!sameIntType(scrutR, litT)) {
              this.diags.push(err('M3013', `模式字面量是 ${typeStr(litT)},被匹配值是 ${typeStr(scrutR)}`, pat.span, CODE_HINTS.M3013));
            } else if (!intFits(v, scrutR.bits, scrutR.signed)) {
              this.diags.push(err('M3002', `字面量 ${v} 超出 ${typeStr(scrutR)} 范围`, pat.span));
            }
          } else if (scrutR && scrutR.k !== 'var') {
            this.diags.push(err('M3002', `整数字面量模式不能匹配 ${typeStr(scrutR)}`, pat.span));
          }
          return { key: 'int:' + v.toString() };
        }
        if (lit.kind === 'str') {
          litT = T_STR;
          if (scrutR && scrutR.k !== 'str' && scrutR.k !== 'var') this.diags.push(err('M3002', `字符串模式不能匹配 ${typeStr(scrutR)}`, pat.span));
          return { key: 'str:' + lit.val };
        }
        litT = T_BOOL;
        if (scrutR && scrutR.k !== 'bool' && scrutR.k !== 'var') this.diags.push(err('M3002', `布尔模式不能匹配 ${typeStr(scrutR)}`, pat.span));
        return { key: lit.val ? 'true' : 'false' };
      }
      case 'PEnum': {
        // prelude 裸变体(enumName=null)与内置 Option/Result / 用户枚举
        const enumName = pat.enumName;
        if (!scrutR) return null;
        // 内置 Option
        if (scrutR.k === 'opt' && (enumName === null || enumName === 'Option')) {
          if (pat.variant === 'Some') {
            if (pat.args.length !== 1) this.diags.push(err('M3005', 'Some 模式需要 1 个子模式', pat.span));
            else this.checkMatchPattern(pat.args[0], scrutR.el, resolveT(scrutR.el, new Map()), ctx, binds);
            return 'variant';
          }
          if (pat.variant === 'None') {
            if (pat.args.length) this.diags.push(err('M3005', 'None 模式不取子模式', pat.span));
            return 'variant';
          }
          this.diags.push(err('M3024', `Option 没有变体 "${pat.variant}"`, pat.span));
          return null;
        }
        // 内置 Result
        if (scrutR.k === 'res' && (enumName === null || enumName === 'Result')) {
          if (pat.variant === 'Ok' || pat.variant === 'Err') {
            const el = pat.variant === 'Ok' ? scrutR.ok : scrutR.err;
            if (pat.args.length !== 1) this.diags.push(err('M3005', `${pat.variant} 模式需要 1 个子模式`, pat.span));
            else this.checkMatchPattern(pat.args[0], el, resolveT(el, new Map()), ctx, binds);
            return 'variant';
          }
          this.diags.push(err('M3024', `Result 没有变体 "${pat.variant}"`, pat.span));
          return null;
        }
        // 用户枚举
        if (scrutR.k === 'enum') {
          if (enumName === null) {
            this.diags.push(err('M3024', `"${pat.variant}" 不是 prelude 变体;用户枚举必须限定:${scrutR.name}.${pat.variant}`, pat.span));
            return null;
          }
          if (enumName !== scrutR.def.name) {
            this.diags.push(err('M3024', `枚举模式 "${enumName}.${pat.variant}" 与被匹配类型 ${scrutR.name} 不符`, pat.span));
            return null;
          }
          const v = scrutR.def.variants.find(x => x.name === pat.variant);
          if (!v) {
            this.diags.push(err('M3024', `枚举 ${scrutR.def.name} 没有变体 "${pat.variant}"(有:${scrutR.def.variants.map(x => x.name).join(', ')})`, pat.span));
            return null;
          }
          if (pat.args.length !== v.rtypes.length) {
            this.diags.push(err('M3005', `变体 ${scrutR.def.name}.${pat.variant} 有 ${v.rtypes.length} 个值,模式给出 ${pat.args.length} 个`, pat.span));
            return 'variant';
          }
          const sub = new Map(scrutR.def.tparams.map((n, i) => [n, scrutR.targs[i]]));
          pat.args.forEach((ap, i) => {
            const vt = substTypes(v.rtypes[i], scrutR.def.tparams, sub);
            this.checkMatchPattern(ap, vt, resolveT(vt, new Map()), ctx, binds);
          });
          return 'variant';
        }
        if (scrutR.k === 'param') {
          this.diags.push(err('M3018', `泛型参数 ${scrutR.name} 上无法做枚举匹配(v0.1 泛型是参数化的,不含操作)`, pat.span));
          return null;
        }
        this.diags.push(err('M3002', `枚举模式不能匹配 ${typeStr(scrutR)}`, pat.span));
        return null;
      }
      case 'PTuple': {
        if (!scrutR || scrutR.k !== 'tuple') {
          if (scrutR) this.diags.push(err('M3002', `元组模式不能匹配 ${typeStr(scrutR)}`, pat.span));
          return null;
        }
        if (scrutR.ts.length !== pat.pats.length) {
          this.diags.push(err('M3002', `元组模式有 ${pat.pats.length} 个元素,类型有 ${scrutR.ts.length} 个`, pat.span));
          return null;
        }
        const cov = pat.pats.map((p, i) => this.checkMatchPattern(p, scrutR.ts[i], resolveT(scrutR.ts[i], new Map()), ctx, binds));
        return cov.every(x => x === 'all') ? 'all' : 'variant';
      }
      default:
        this.diags.push(err('M2003', '无效的模式', pat.span));
        return null;
    }
  }

  checkVecLit(e, ctx, expected) {
    let elT = null;
    if (expected) {
      const r = resolveT(expected, new Map());
      if (r?.k === 'vec') elT = r.el;
    }
    if (e.elems.length === 0 && !elT) {
      this.diags.push(err('M3003', '无法推断空 Vec 的元素类型', e.span,
        '添加类型标注:`let v: Vec[i64] = [];` 或让上下文确定类型。'));
      return mkVec(tvar());
    }
    const binds = new Map();
    for (const el of e.elems) {
      const t = this.checkExpr(el, ctx, elT ?? undefined);
      if (elT === null) elT = t;
      else if (!unify(t, elT, binds)) {
        this.diags.push(err('M3002', `Vec 元素类型不一致:${typeStr(elT, binds)} 与 ${typeStr(t, binds)}`, el.span));
      }
    }
    if (elT) this.checkJoinNotStored(elT, binds, e.span, '作为 Vec 元素');
    if (e.elems.length > 0) this.checkPtrPayload(elT, e.span, ctx, 'Vec 元素'); // v0.54 审查 B3
    return mkVec(elT ?? tvar());
  }

  checkMapKey(t, span) {
    const r = t ? resolveT(t, new Map()) : null;
    if (!r || r.k === 'param' || r.k === 'var') return;
    if (!['int', 'float', 'bool', 'str'].includes(r.k)) {
      this.diags.push(err('M3044', `Map 键类型必须是 int/float/bool/str,实际是 ${typeStr(r)}`, span,
        '结构/Vec 键没有值语义相等;请用 str 编码或 i64 id 作为键。'));
    }
  }

  checkMapLit(e, ctx, expected) {
    let kt = null, vt = null;
    if (expected) {
      const r = resolveT(expected, new Map());
      if (r?.k === 'map') { kt = r.kt; vt = r.vt; }
    }
    if (e.entries.length === 0 && !kt) {
      this.diags.push(err('M3003', '无法推断空 Map 的键值类型', e.span,
        '添加类型标注:`let m: Map[str, i64] = [:];`。注意 {} 在表达式位置是空 Map,但通常仍需标注。'));
      return mkMap(tvar(), tvar());
    }
    const binds = new Map();
    for (const en of e.entries) {
      const k = this.checkExpr(en.k, ctx, kt ?? undefined);
      const v = this.checkExpr(en.v, ctx, vt ?? undefined);
      if (kt === null) kt = k; else if (!unify(k, kt, binds)) this.diags.push(err('M3002', `map 键类型不一致:${typeStr(kt, binds)} 与 ${typeStr(k, binds)}`, en.k.span));
      if (vt === null) vt = v; else if (!unify(v, vt, binds)) this.diags.push(err('M3002', `map 值类型不一致:${typeStr(vt, binds)} 与 ${typeStr(v, binds)}`, en.v.span));
    }
    if (vt) this.checkJoinNotStored(vt, binds, e.span, '作为 Map 值');
    if (e.entries.length > 0) {
      // v0.54 审查 B3:Map 字面量把 Ptr 装进键/值时同样属于逃逸(键本身另受 M3044 约束)
      this.checkPtrPayload(typeContainsPtr(kt) ? kt : vt, e.span, ctx, 'Map 条目');
    }
    if (!expected) this.checkMapKey(kt, e.span);
    return mkMap(kt ?? tvar(), vt ?? tvar());
  }

  checkStructLit(e, ctx) {
    // 解析类型路径
    let structEntry = null, fromMod = null, name = e.path.join('.');
    if (e.path.length === 1) {
      structEntry = ctx.mod.items.get(e.path[0]);
      fromMod = ctx.mod;
    } else {
      const bind = e.path[0];
      const imp = ctx.mod.imports.get(bind);
      if (!imp) {
        this.diags.push(err('M3001', `找不到结构体 "${name}"`, e.span));
        return null;
      }
      if (imp.std) {
        this.diags.push(err('M3001', `std.${imp.std} 没有结构体 "${e.path[1]}"`, e.span));
        return null;
      }
      structEntry = imp.local.items.get(e.path[1]);
      fromMod = imp.local;
    }
    if (!structEntry || structEntry.kind !== 'struct') {
      this.diags.push(err('M3001', `"${name}" 不是结构体${structEntry?.kind === 'enum' ? '(是枚举;构造变体请用 枚举名.变体名(值))' : ''}`, e.span));
      return null;
    }
    if (fromMod !== ctx.mod && !structEntry.pub) this.visDiag(structEntry, e.path[1], e.span, fromMod);
    const decl = structEntry.decl;
    // 类型参数 → 推断变量
    const tvars = decl.tparams.map(() => tvar());
    const sub = new Map(decl.tparams.map((n, i) => [n, tvars[i]]));
    const seen = new Set();
    const binds = new Map();
    let ptrField = false; // v0.54 审查 B3:任一字段值为含 Ptr 的类型
    for (const f of e.fields) {
      seen.add(f.name);
      const fd = decl.fields.find(x => x.name === f.name);
      if (!fd) {
        this.diags.push(err('M3006', `结构体 ${decl.name} 没有字段 "${f.name}"(有:${decl.fields.map(x => x.name).join(', ') || '无'})`, f.span));
        this.checkExpr(f.value, ctx);
        continue;
      }
      const expected = substTypes(fd.rtype, decl.tparams, sub);
      const ft = this.checkExpr(f.value, ctx, expected, true);
      if (ft) unify(expected, ft, binds); // 绑定未定的类型参数
      if (typeContainsPtr(ft)) ptrField = true;
      this.checkFnEffectNarrowing(expected, ft, f.value.span);  // v0.54 审查 B4
    }
    const missing = decl.fields.filter(f => !seen.has(f.name)).map(f => f.name);
    if (missing.length) {
      this.diags.push(err('M3027', `结构体 ${decl.name} 缺少字段:${missing.join(', ')}`, e.span,
        'Ming 结构体没有默认值:每个字段都必须显式给出。'));
    }
    // 解析未定的类型参数
    const targs = tvars.map(tv => resolveT(tv, binds) ?? tv);
    for (const f of decl.fields) {
      const ft = substTypes(f.rtype, decl.tparams, new Map(decl.tparams.map((n, i) => [n, targs[i]])));
      this.checkJoinNotStored(ft, new Map(), e.span, `作为字段 ${f.name} 的类型`);
    }
    const unresolved = targs.filter(t => t.k === 'var');
    if (unresolved.length) {
      this.diags.push(err('M3003', `无法从字段推断 ${decl.name} 的全部类型参数`, e.span,
        '用 let 标注:`let p: ' + decl.name + '[' + '?, '.repeat(targs.length - 1) + '?] = ' + decl.name + ' { ... };` 或补足字段信息。'));
    }
    // 契约:invariant 类型检查(v0.45)
    if (decl.invariants && decl.invariants.length) {
      const invScope = new Scope(ctx.scope, ctx.mod);
      const targsResolved = targs;
      for (const fd of decl.fields) {
        const ft = substTypes(fd.rtype, decl.tparams, new Map(decl.tparams.map((n, i) => [n, targsResolved[i]])));
        invScope.bind(fd.name, ft, false, fd.span, true);
      }
      const pureCtx = { ...ctx, scope: invScope, effects: new Set(), fnDecl: ctx.fnDecl, contractMode: true };
      for (const inv of decl.invariants) {
        const t = this.checkExpr(inv.expr, pureCtx, T_BOOL);
        const r = t ? resolveT(t, new Map()) : null;
        if (r && r.k !== 'bool') this.diags.push(err('M3014', `invariant 条件必须是 bool,实际是 ${typeStr(r)}`, inv.expr.span));
      }
    }
    const structT = { k: 'struct', name: decl.name, def: decl, mod: fromMod, targs };
    if (ptrField) this.checkPtrPayload(structT, e.span, ctx, '结构体字段'); // v0.54 审查 B3
    return structT;
  }

  checkLambda(e, ctx, expected) {
    let fnExpected = null;
    if (expected) {
      const r = resolveT(expected, new Map());
      if (r?.k === 'fn') fnExpected = r;
    }
    const binds = new Map();
    const ps = e.params.map((p, i) => {
      let t = p.type ? this.resolveTypeAst(p.type, ctx.mod) : null;
      if (!t && fnExpected) t = fnExpected.ps[i] ?? null;
      if (!t) {
        this.diags.push(err('M3003', `闭包参数 "${p.name}" 无法推断类型`, p.span,
          '为参数标注类型:(x: i64) => ...,或让调用的上下文提供函数类型。'));
        t = tvar();
      }
      return { name: p.name, type: t, span: p.span };
    });
    const scope = new Scope(ctx.scope, ctx.mod);
    for (const p of ps) scope.bind(p.name, p.type, false, p.span, true);
    const sink = new Set();
    const ctx2 = { ...ctx, scope, effectSink: sink };
    let retT;
    const retExpected = fnExpected ? fnExpected.ret : (expected && resolveT(expected, new Map())?.k !== 'fn' ? expected : undefined);
    if (e.body.nt === 'BlockExpr') retT = this.checkBlock(e.body.block, ctx2, retExpected ?? undefined);
    else retT = this.checkExpr(e.body, ctx2, retExpected ?? undefined, true);
    // 返回类型与期望的函数类型对齐(绑定 U 这样的推断变量)
    if (retT && fnExpected) unify(retT, fnExpected.ret, binds);
    // 推断变量填充
    ps.forEach(p => { if (p.type.k === 'var') p.type = resolveT(p.type, binds) ?? p.type; });
    if (retT) retT = resolveT(retT, binds) ?? retT;
    if (ctx.effectSink) for (const e of sink) ctx.effectSink.add(e);
    return mkFn(ps.map(p => p.type), retT ?? T_UNIT, sink);
  }

  checkPostQ(e, ctx) {
    const t = this.checkExpr(e.expr, ctx);
    const r = resolveT(t, new Map());
    const fnRet = resolveT(ctx.fnRet, new Map());
    if (r?.k === 'opt') {
      if (fnRet?.k !== 'opt') {
        this.diags.push(err('M3002', `"?" 作用于 Option[T],但当前函数返回 ${typeStr(fnRet)}`, e.span,
          '把函数返回类型改为 Option[...],或用 match / unwrap_or 处理 None。'));
        return r.el;
      }
      const binds = new Map();
      unify(r.el, fnRet.el, binds);
      return resolveT(r.el, binds) ?? r.el;
    }
    if (r?.k === 'res') {
      if (fnRet?.k !== 'res') {
        this.diags.push(err('M3002', `"?" 作用于 Result[T, E],但当前函数返回 ${typeStr(fnRet)}`, e.span,
          '把函数返回类型改为 Result[...],或用 match / unwrap 处理 Err。'));
        return r.ok;
      }
      const binds = new Map();
      unify(r.ok, fnRet.ok, binds);
      if (!unify(r.err, fnRet.err, binds)) {
        this.diags.push(err('M3002', `"?" 的错误类型 ${typeStr(r.err)} 与函数返回的错误类型 ${typeStr(fnRet.err)} 不一致`, e.span));
      }
      return resolveT(r.ok, binds) ?? r.ok;
    }
    this.diags.push(err('M3002', `"?" 只能作用于 Option[T] 或 Result[T, E],实际是 ${typeStr(r)}`, e.span));
    return null;
  }
}

// ===================== 作用域 =====================

class Scope {
  constructor(parent, mod) {
    this.parent = parent;
    this.mod = mod;
    this.vars = new Map();
    this.localFns = new Map();
  }
  bind(name, type, mut, span, isParam) {
    if (this.vars.has(name)) {
      return { dup: true };
    }
    this.vars.set(name, { type, mut, span, used: isParam ? true : false, isParam });
    return { dup: false };
  }
  registerLocalFn(name, sig) { this.localFns.set(name, sig); }
  lookupFn(name) {
    let s = this;
    while (s) {
      if (s.localFns.has(name)) return s.localFns.get(name);
      s = s.parent;
    }
    return null;
  }
  lookupLocal(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    return null;
  }
  lookup(name) {
    let s = this;
    while (s) {
      if (s.vars.has(name)) return s.vars.get(name);
      s = s.parent;
    }
    return null;
  }
  *allVisibleNames() {
    let s = this;
    while (s) {
      yield* s.vars.keys();
      yield* s.localFns.keys();
      s = s.parent;
    }
    const m = this.mod;
    if (m) {
      yield* m.items.keys();
      yield* Object.keys(BUILTIN_FNS);
      yield* Object.keys(PRELUDE_VARIANTS);
    }
  }
  reportUnused(diags) {
    for (const [name, v] of this.vars) {
      if (!v.used && !v.isParam && !name.startsWith('_')) {
        diags.push(warn('W3101', `变量 "${name}" 未使用`, v.span,
          '不需要的绑定写 let _ = ...;或暂时以 _ 开头命名。'));
      }
    }
  }
}

// ===================== 流分析 =====================

function stmtTerminates(s) {
  switch (s.nt) {
    case 'Return': case 'Break': case 'Continue': return true;
    case 'ExprStmt': return exprTerminates(s.expr);
    // v0.54 审查 B1:unsafe 块是普通块的一部分,块内终止(return/break/continue/尾 loop)
    // 同样决定函数/循环体的可达性——此前漏接导致 "块内 return 是最后语句" 误报 M3017,
    // 且 loop { unsafe { break; } } 被当作必然终止(unreachable)而不是 unit。
    case 'UnsafeBlock': return blockTerminates(s.body);
    default: return false;
  }
}

// 块是否必然终止:任一语句终止(尾表达式因此不可达)→ 终止;否则看尾表达式自身是否终止。
function blockTerminates(b) {
  if (!b) return false;
  if (b.stmts.some(stmtTerminates)) return true;
  return !!(b.tail && exprTerminates(b.tail));
}

function exprTerminates(e) {
  switch (e.nt) {
    case 'LoopExpr': return !hasBreak(e.body);
    case 'BlockExpr': {
      const b = e.block;
      if (b.tail) return false;
      return b.stmts.some(stmtTerminates);
    }
    case 'If': {
      if (!e.els) return false;
      return blockOrIfTerminates(e.then) && blockOrIfTerminates(e.els);
    }
    case 'Match': {
      return e.arms.length > 0 && e.arms.every(a => armTerminates(a));
    }
    default: return false;
  }
}

function blockOrIfTerminates(x) {
  if (x.nt === 'If') return exprTerminates(x);
  const b = x;
  if (b.tail) return false;
  return b.stmts.some(stmtTerminates);
}

function armTerminates(a) {
  if (a.expr.nt === 'BlockExpr') return blockOrIfTerminates(a.expr.block);
  return false;
}

function hasBreak(block) {
  for (const s of block.stmts) {
    if (s.nt === 'Break') return true;
    if (s.nt === 'ExprStmt' && s.expr.nt === 'LoopExpr' && hasBreak(s.expr.body)) return true;
    if (s.nt === 'While' && hasBreak(s.body)) return true;
    if (s.nt === 'For' && hasBreak(s.body)) return true;
    // v0.54 审查 B1:unsafe 块内的 break 属于外层循环(块本身不建立 break 目标)
    if (s.nt === 'UnsafeBlock' && hasBreak(s.body)) return true;
  }
  if (block.tail && block.tail.nt === 'LoopExpr' && hasBreak(block.tail.body)) return true;
  return false;
}

// ===================== 辅助 =====================

function spanKey(span) {
  if (!span) return null;
  return `${span.file ?? ''}:${span.line ?? 0}:${span.col ?? 0}`;
}

// v0.54 审查 B3:类型是否(递归地)含 Ptr 值。
// 遍历类型结构(容器元素、元组元素、结构体字段、枚举载荷);用 seen 防止递归类型
// (struct Node { next: Option[Node] })无限展开。类型参数(param/var)无法静态判定 → false,
// 调用点传入的具体实参类型由调用方负责判定。
export function typeContainsPtr(t, seen = new Set()) {
  if (!t) return false;
  switch (t.k) {
    case 'ptr': return true;
    case 'vec': case 'opt': case 'range': case 'join': return typeContainsPtr(t.el, seen);
    case 'map': return typeContainsPtr(t.kt, seen) || typeContainsPtr(t.vt, seen);
    case 'res': return typeContainsPtr(t.ok, seen) || typeContainsPtr(t.err, seen);
    case 'tuple': return (t.ts ?? []).some(x => typeContainsPtr(x, seen));
    case 'struct': {
      const def = t.def;
      if (!def?.fields?.length || seen.has(def)) return false;
      const tps = def.tparams ?? [];
      const sub = new Map(tps.map((n, i) => [n, t.targs?.[i] ?? { k: 'param', name: n }]));
      const seen2 = new Set(seen).add(def);
      return def.fields.some(f => f.rtype && typeContainsPtr(substTypes(f.rtype, tps, sub), seen2));
    }
    case 'enum': {
      const def = t.def;
      if (!def?.variants?.length || seen.has(def)) return false;
      const tps = def.tparams ?? [];
      const sub = new Map(tps.map((n, i) => [n, t.targs?.[i] ?? { k: 'param', name: n }]));
      const seen2 = new Set(seen).add(def);
      return def.variants.some(v => (v.rtypes ?? []).some(x => typeContainsPtr(substTypes(x, tps, sub), seen2)));
    }
    default: return false;
  }
}

export function substTypes(t, tparams, sub) {
  if (!tparams?.length) return t;
  const isMap = !(sub instanceof Array);
  function go(t) {
    if (!t) return t;
    if (t.k === 'param') {
      if (isMap) return sub.get(t.name) ?? t;
      const i = tparams.indexOf(t.name);
      return sub[i] ?? t;
    }
    switch (t.k) {
      case 'vec': return mkVec(go(t.el));
      case 'ptr': return mkPtr(go(t.el), t.mut); // v0.54
      case 'map': return mkMap(go(t.kt), go(t.vt));
      case 'opt': return mkOpt(go(t.el));
      case 'res': return mkRes(go(t.ok), go(t.err));
      case 'tuple': return mkTuple(t.ts.map(go));
      case 'fn': return mkFn(t.ps.map(go), go(t.ret));
      case 'range': return mkRange(go(t.el));
      case 'struct': case 'enum': return { ...t, targs: (t.targs ?? []).map(go) };
      default: return t;
    }
  }
  return go(t);
}

function sameIntType(a, b) { return a.bits === b.bits && a.signed === b.signed; }

export function intFits(v, bits, signed) {
  if (signed) return v >= -(1n << BigInt(bits - 1)) && v < (1n << BigInt(bits - 1));
  return v >= 0n && v < (1n << BigInt(bits));
}

function intLitFits(e, t) { return intFits(e.v, t.bits, t.signed); }

function nearest(name, candidates) {
  let best = null, bestD = 3;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}
