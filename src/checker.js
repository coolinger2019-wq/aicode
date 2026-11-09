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
//   {k:'param',name}   — 泛型参数(检查体内)
//   {k:'var',id}       — 推断变量,由 binds 解析

import { err, warn, MingError, CODE_HINTS } from './diag.js';
import { parse } from './parser.js';
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
export function mkFn(ps, ret) { return { k: 'fn', ps, ret }; }
export function mkRange(el) { return { k: 'range', el }; }
export function mkJoin(el) { return { k: 'join', el }; }

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
    case 'struct': case 'enum': return (t.targs ?? []).some(x => occurs(x, id, binds));
    default: return false;
  }
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
    case 'bool': case 'str': case 'unit': case 'never': return true;
    case 'vec': return unify(a.el, b.el, binds);
    case 'range': return unify(a.el, b.el, binds);
    case 'join': return unify(a.el, b.el, binds);
    case 'opt': return unify(a.el, b.el, binds);
    case 'res': return unify(a.ok, b.ok, binds) && unify(a.err, b.err, binds);
    case 'map': return unify(a.kt, b.kt, binds) && unify(a.vt, b.vt, binds);
    case 'tuple': return a.ts.length === b.ts.length && a.ts.every((x, i) => unify(x, b.ts[i], binds));
    case 'fn': return a.ps.length === b.ps.length && a.ps.every((x, i) => unify(x, b.ps[i], binds)) && unify(a.ret, b.ret, binds);
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
    case 'tuple': return t.ts.length === 0 ? '()' : `(${t.ts.map(r).join(', ')})`;
    case 'fn': return `(${t.ps.map(r).join(', ')}) -> ${r(t.ret)}`;
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
export const KNOWN_EFFECTS = new Set(['io', 'time', 'fs', 'net', 'sync', 'proc', 'env', 'rand', 'crypto']);

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
  constructor(entryFile, readFile = null) {
    this.readFile = readFile ?? ((p) => nodeFs.readFileSync(p, 'utf8'));
    this.entryFile = entryFile;
    this.modules = [];
    this.byPath = new Map();
    this.diags = [];
    this.entry = null;
    this.methodImpls = new Map();  // Map<def, Map<methodName, fnEntry>>
    this.implTraits = new Map();   // Map<def, Set<traitName>>
    this.implInfo = new Map();     // Map<def, Map<traitName, {tparams, bounds}>>
    this.methodEntries = [];       // 待检查体的 impl 方法(伪 fn entry)
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
          if (parts.length === 1 && t.name === 'Vec') {
            if (t.args.length !== 1) self.diagT(t.span, `Vec 需要 1 个类型参数,得到 ${t.args.length}`);
            return mkVec(go(t.args[0]));
          }
          if (parts.length === 1 && t.name === 'Map') {
            if (t.args.length !== 2) self.diagT(t.span, `Map 需要 2 个类型参数,得到 ${t.args.length}`);
            return mkMap(go(t.args[0]), go(t.args[1]));
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
    return { modules: this.modules, entry: this.entry, diags: this.diags, methodImpls: this.methodImpls };
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
        entry.sig = {
          tparams: d.tparams,
          bounds: d.bounds ?? [],
          params: d.params.map(p => ({ name: p.name, mut: !!p.mut, type: this.resolveTypeAst(p.type, mod, tp), span: p.span })),
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
      if (entry.kind === 'fn' && entry.decl.body) this.checkFnBody(entry, mod);
      if (entry.kind === 'test') this.checkTest(entry, mod);
    }
    // impl 方法体(在 resolveImpls 中注册到 methodEntries)
    for (const entry of this.methodEntries) {
      if (entry.mod === mod) this.checkFnBody(entry, mod);
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
        const pseudoEntry = { kind: 'fn', decl: m, pub: false, sig, mod, methodName: m.name, traitName: traitDef.name };
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
    const scope = new Scope(null, mod);
    for (const p of entry.sig.params) {
      scope.bind(p.name, p.type, p.mut, p.span, true);
    }
    const ctx = {
      mod, scope, fnRet: entry.sig.ret, inLoop: false,
      fnName: d.name, warnings: this.diags,
      genericNames: new Set(entry.sig.tparams),
      effects: entry.sig.effects,
      genericBounds: new Map((entry.sig.bounds ?? []).map(b => [b.name, b.trait])),
    };
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

  // 效果检查:调用方必须声明被调方需要的全部效果
  checkEffects(ctx, required, span) {
    if (!required || !required.size) return;
    const missing = [...required].filter(e => !ctx.effects?.has(e));
    if (missing.length) {
      this.diags.push(err('M3029',
        `此调用需要效果 [${missing.join(', ')}],但函数 "${ctx.fnName ?? '?'}" 声明的是 [${[...(ctx.effects ?? [])].join(', ') || '纯函数'}]`,
        span, CODE_HINTS.M3029));
    }
  }

  // ---------- 语句 ----------
  checkBlock(block, ctx, expected) {
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
      bt = this.checkExpr(block.tail, ctx, expected ?? undefined, expected != null);
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
        this.checkPattern(s.pat, t, ctx2, s.span, true);
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
    const valueT = this.checkExpr(s.value, ctx, targetT ?? undefined);
    const binds = new Map();
    if (s.op !== '=') {
      // 复合赋值:要求支持对应算术
      this.checkBinaryOp(s.op[0], targetT, valueT, s.span, binds);
    } else if (targetT && !unify(targetT, valueT, binds)) {
      this.diags.push(err('M3002', `赋值类型不匹配:目标是 ${typeStr(targetT, binds)},值是 ${typeStr(valueT, binds)}`, s.span));
    }
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
    this.diags.push(err('M3001', `找不到值 "${name}"`, span,
      near ? `未定义;最接近的名字是 "${near}"` : (ctx.rootScopeOnly ? '本地函数内只能访问:参数、模块级函数/类型与内置项;不能捕获外层局部变量(v0.1)' : null)));
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
        const t = this.checkExpr(e.expr, ctx, e.op === '!' ? T_BOOL : (expected && resolveT(expected, binds)?.k === 'float' ? expected : undefined));
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
        const t = this.checkExpr(e.expr, ctx);
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
        return T_NEVER;
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
      return mkFn(localFn.params.map(p => p.type), localFn.ret);
    }
    // 模块级函数(当前模块,用户定义优先于内置)
    const entry = ctx.mod.items.get(name);
    if (entry?.kind === 'fn') {
      if (entry.sig.tparams.length) {
        this.diags.push(err('M3003', `泛型函数 "${name}" 作为值使用前需要确定类型参数`, e.span, '直接调用它,让类型从实参推断。'));
        return null;
      }
      return mkFn(entry.sig.params.map(p => p.type), entry.sig.ret);
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
      return mkFn(entry.sig.params.map(p => p.type), entry.sig.ret);
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
        e.args.forEach((a, i) => {
          const t = this.checkExpr(a, ctx, localFn.params[i]?.type ?? undefined, true);
          if (localFn.params[i] && !unify(t, localFn.params[i].type, binds)) {
            this.diags.push(err('M3002', `参数 #${i + 1}(${localFn.params[i].name})类型不匹配:期望 ${typeStr(localFn.params[i].type)},实际 ${typeStr(t, binds)}`, a.span));
          }
        });
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
    const ret = substTypes(sig.ret, sig.tparams, paramMap);
    const resolved = resolveT(ret, binds);
    return resolved ?? ret;
  }

  callFnType(ft, e, ctx, expected) {
    const r = resolveT(ft, new Map());
    if (!r) return null;
    if (r.k === 'ctor') return this.callCtor(r, e, ctx);
    if (r.k !== 'fn') {
      this.diags.push(err('M3021', `${typeStr(r)} 不是函数,不能调用`, e.callee.span));
      return null;
    }
    if (e.args.length !== r.ps.length) {
      this.diags.push(err('M3005', `这个函数需要 ${r.ps.length} 个参数,得到 ${e.args.length}`, e.span));
    }
    const binds = new Map();
    const argTs = [];
    for (let i = 0; i < e.args.length; i++) {
      argTs.push(this.checkExpr(e.args[i], ctx, r.ps[i] ?? undefined));
    }
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
    const argTs = e.args.map(a => this.checkExpr(a, ctx));
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
    const min = f.fn.min ?? f.fn.params.length;
    const max = f.fn.max ?? f.fn.params.length;
    if (e.args.length < min || e.args.length > max) {
      this.diags.push(err('M3005', `std.${f.mod}.${f.fn.name} 需要 ${min}${max !== min ? '-' + max : ''} 个参数,得到 ${e.args.length}`, e.span));
    }
    const binds = new Map();
    e.args.forEach((a, i) => {
      const p = f.fn.params[i];
      if (typeof p === 'string' && p === 'jsonval') {
        // JSON 兼容性静态检查(stringify 等)
        const t = this.checkExpr(a, ctx);
        this.checkJsonCompatible(t, binds, a.span);
        return;
      }
      const t = this.checkExpr(a, ctx, p ?? undefined);
      if (p && !unify(t, p, binds)) {
        this.diags.push(err('M3002', `参数 #${i + 1} 类型不匹配:期望 ${typeStr(p)},实际 ${typeStr(t, binds)}`, a.span));
      }
    });
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
        args.forEach((a, i) => {
          const pt = sig.params[i + 1].type;
          const t = this.checkExpr(a, ctx, pt, true);
          if (!unify(t, pt, mbinds)) {
            this.diags.push(err('M3002', `方法 .${name}() 参数 #${i + 1} 类型不匹配:期望 ${typeStr(pt, mbinds)},实际 ${typeStr(t, mbinds)}`, a.span));
          }
        });
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
          this.diags.push(err('M3005', `方法 .${name}() 需要 ${spec.params.length} 个参数,得到 ${args.length}`, span));
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
    const lt = this.checkExpr(e.l, ctx);
    const rt = this.checkExpr(e.r, ctx, ['==', '!=', '<', '<=', '>', '>='].includes(op) ? lt ?? undefined : undefined);
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
    const tt = this.checkBlock(e.then, ctx, expected);
    const et = e.els.nt === 'If' ? this.checkIf(e.els, ctx, expected, true) : this.checkBlock(e.els, ctx, expected);
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
        pat.pats.forEach((p, i) => this.checkMatchPattern(p, scrutR.ts[i], resolveT(scrutR.ts[i], new Map()), ctx, binds));
        return 'all';
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
    return mkVec(elT ?? tvar());
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
    return { k: 'struct', name: decl.name, def: decl, mod: fromMod, targs };
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
    const ctx2 = { ...ctx, scope };
    let retT;
    const retExpected = fnExpected ? fnExpected.ret : (expected && resolveT(expected, new Map())?.k !== 'fn' ? expected : undefined);
    if (e.body.nt === 'BlockExpr') retT = this.checkBlock(e.body.block, ctx2, retExpected ?? undefined);
    else retT = this.checkExpr(e.body, ctx2, retExpected ?? undefined, true);
    // 返回类型与期望的函数类型对齐(绑定 U 这样的推断变量)
    if (retT && fnExpected) unify(retT, fnExpected.ret, binds);
    // 推断变量填充
    ps.forEach(p => { if (p.type.k === 'var') p.type = resolveT(p.type, binds) ?? p.type; });
    if (retT) retT = resolveT(retT, binds) ?? retT;
    return mkFn(ps.map(p => p.type), retT ?? T_UNIT);
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
    default: return false;
  }
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
  }
  if (block.tail && block.tail.nt === 'LoopExpr' && hasBreak(block.tail.body)) return true;
  return false;
}

// ===================== 辅助 =====================

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
