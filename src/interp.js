// interp.js — Ming 树遍历解释器。
// 核心语义:
//   * 值语义:赋值/传参/闭包捕获都是深拷贝,不存在别名(消除共享可变状态)
//   * 整数运算全程检查:溢出 / 除零 / 移位越界 → panic(M4002/M4004)
//   * 无 null;索引/键缺失 → panic,或用 get() 拿 Option
//   * panic 携带 Ming 调用栈(Ming 层文件:行:列)

import { err } from './diag.js';
import { PRIM_TYPES, INT_TYPES, typeStr, resolveT, unify, mkOpt, mkRes, T_UNIT, T_STR, T_BOOL } from './checker.js';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

// 源码文件绝对 URL(wasm/worker eval 的 ESM import 用)
const SRC_DIR = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC_URL = (f) => 'file:///' + nodePath.join(SRC_DIR, f).split(nodePath.sep).join('/');
import { Worker } from 'node:worker_threads';
import * as nodeChildProcess from 'node:child_process';

// ===================== 运行时值 =====================
// 全部带类型标签 t:
//   int{bits,signed,v: number|BigInt} —— 值表示优化(v0.4):|v| ≤ 2^53-1 时用 JS number
//   (安全整数,运算精确),超出才落 BigInt。所有创建口经 V.int 归一化,因此同一数值
//   恒为同一表示,相等比较可直接 ===。float{bits,v} bool{v} str{v} unit{} vec{a:[]} map{m:Map}
//   tuple{a:[]} struct{def,name,fields:Map} enum{def,name,tag,vals:[]}
//   closure{params,body,env,fnType} fnref{mod,entry} range{lo,hi}

const INT_MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53-1

export function normInt(v) {
  return typeof v === 'bigint' ? (v >= -INT_MAX_SAFE && v <= INT_MAX_SAFE ? Number(v) : v) : v;
}

const SMALL_INT_CACHE = new Array(256);
export class V {
  static int(v, bits = 64, signed = true) {
    const n = normInt(v);
    // 小整数驻留:i64 常见值共享对象,降低分配压力(整数不可变,共享安全)
    if (bits === 64 && signed && typeof n === 'number' && Number.isInteger(n) && n >= -128 && n <= 127) {
      const cached = SMALL_INT_CACHE[n + 128];
      if (cached !== undefined) return cached;
      const obj = { t: 'int', bits, signed, v: n };
      SMALL_INT_CACHE[n + 128] = obj;
      return obj;
    }
    return { t: 'int', bits, signed, v: n };
  }
  static float(v, bits = 64) { return { t: 'float', bits, v }; }
  static bool(v) { return { t: 'bool', v }; }
  static str(v) { return { t: 'str', v }; }
  static unit() { return UNIT; }
  static vec(a = []) { return { t: 'vec', a }; }
  static map(m = new Map()) { return { t: 'map', m }; }
  static tuple(a) { return { t: 'tuple', a }; }
  static struct(def, fields) { return { t: 'struct', def, name: def.name, fields }; }
  static enumv(def, tag, vals) { return { t: 'enum', def, name: def.name, tag, vals }; }
  static closure(params, body, env, fnType) { return { t: 'closure', params, body, env, fnType }; }
  static fnref(mod, entry) { return { t: 'fnref', mod, entry }; }
  static range(lo, hi) { return { t: 'range', lo, hi }; }
  static json(kind, v) { return { t: 'json', kind, v }; }
  static handle(id) { return { t: 'handle', id }; }
}

export const UNIT = { t: 'unit' };

export function deepCopy(v) {
  switch (v.t) {
    case 'int': case 'float': case 'bool': case 'str': case 'unit': case 'range': case 'json': case 'handle':
      return v;
    case 'vec': return { t: 'vec', a: v.a.map(deepCopy) };
    case 'tuple': return { t: 'tuple', a: v.a.map(deepCopy) };
    case 'map': {
      const m = new Map();
      for (const [k, val] of v.m) m.set(k, deepCopy(val));
      return { t: 'map', m };
    }
    case 'struct': {
      const fields = new Map();
      for (const [k, val] of v.fields) fields.set(k, deepCopy(val));
      return { t: 'struct', def: v.def, name: v.name, fields };
    }
    case 'enum': return { t: 'enum', def: v.def, name: v.name, tag: v.tag, vals: v.vals.map(deepCopy) };
    case 'closure': {
      const env = new Map();
      for (const [k, val] of v.env.vars) env.set(k, deepCopy(val));
      return { t: 'closure', params: v.params, body: v.body, env: { vars: env, parent: v.env.parent }, fnType: v.fnType };
    }
    case 'fnref': return v;
    default: return v;
  }
}

export function displayStr(v) {
  switch (v.t) {
    case 'int': return v.v.toString();
    case 'float': return floatStr(v.v);
    case 'bool': return v.v ? 'true' : 'false';
    case 'str': return v.v;
    case 'unit': return '()';
    case 'json': return jsonText(v);
    case 'handle': return `<join#` + v.id + `>`;
    default: return debugStr(v);
  }
}

function floatStr(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return x.toFixed(1);
  return String(x);
}

export function debugStr(v) {
  switch (v.t) {
    case 'int': return v.v.toString();
    case 'float': return floatStr(v.v);
    case 'bool': return v.v ? 'true' : 'false';
    case 'str': return '"' + v.v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
    case 'unit': return '()';
    case 'json': return jsonText(v);
    case 'handle': return `<join#` + v.id + `>`;
    case 'vec': return '[' + v.a.map(debugStr).join(', ') + ']';
    case 'tuple': return '(' + v.a.map(debugStr).join(', ') + ')';
    case 'map': return '{' + [...v.m.entries()].map(([k, val]) => `${debugStr(keyValue(k))}: ${debugStr(val)}`).join(', ') + '}';
    case 'struct': return `${v.name}{${[...v.fields.entries()].map(([k, val]) => `${k}: ${debugStr(val)}`).join(', ')}}`;
    case 'enum': return v.vals.length ? `${v.tag}(${v.vals.map(debugStr).join(', ')})` : v.tag;
    case 'closure': return '<闭包>';
    case 'fnref': return `<fn ${v.entry?.decl?.name ?? '?'}>`;
    case 'range': return `${displayStr(v.lo)}..${displayStr(v.hi)}`;
    default: return '?';
  }
}

export function keyValue(k) {
  if (typeof k === 'bigint') return V.int(k);
  if (typeof k === 'boolean') return V.bool(k);
  if (typeof k === 'number') return V.float(k);
  return V.str(k);
}

export // ===================== JSON(动态值)=====================
// Json 值:{t:'json', kind:'null'|'bool'|'num'|'str'|'arr'|'obj', v}
//   null→null  bool→bool  num→number  str→string  arr→[Json]  obj→Map<string,Json>
// Json 视为不可变值(同 str):deepCopy 原样返回,as_obj 返回副本。

function jsonText(v) { return jsonWrite(v); }

function jsonWrite(v) {
  switch (v.kind) {
    case 'null': return 'null';
    case 'bool': return v.v ? 'true' : 'false';
    case 'num': return jsonNum(v.v);
    case 'str': return JSON.stringify(v.v);
    case 'arr': return '[' + v.v.map(jsonWrite).join(',') + ']';
    case 'obj': {
      const parts = [];
      for (const [k, val] of v.v) parts.push(JSON.stringify(k) + ':' + jsonWrite(val));
      return '{' + parts.join(',') + '}';
    }
    default: return 'null';
  }
}

function jsonNum(x) {
  if (Number.isNaN(x) || !Number.isFinite(x)) return 'null'; // JS JSON.stringify 同款约定
  return String(x);
}

function jsonEquals(a, b) {
  if (a.kind !== b.kind) {
    // num 与 bool/str 不等;null 仅与 null
    return false;
  }
  switch (a.kind) {
    case 'null': return true;
    case 'bool': case 'num': case 'str': return a.v === b.v;
    case 'arr': return a.v.length === b.v.length && a.v.every((x, i) => jsonEquals(x, b.v[i]));
    case 'obj': {
      if (a.v.size !== b.v.size) return false;
      for (const [k, val] of a.v) {
        const other = b.v.get(k);
        if (!other || !jsonEquals(val, other)) return false;
      }
      return true;
    }
    default: return false;
  }
}

// 手写递归下降 JSON 解析(无依赖;错误带位置)
function parseJsonText(src) {
  let i = 0;
  const err = (msg) => new Error(`JSON 语法错误(位置 ${i + 1}): ${msg}`);
  const ws = () => { while (i < src.length && ' \t\n\r'.includes(src[i])) i++; };
  const value = (depth) => {
    ws();
    if (i >= src.length) throw err('意外结束');
    const ch = src[i];
    if (ch === '{') return obj(depth);
    if (ch === '[') return arr(depth);
    if (ch === '"') return V.json('str', str());
    if (ch === 't') { expect('true'); return V.json('bool', true); }
    if (ch === 'f') { expect('false'); return V.json('bool', false); }
    if (ch === 'n') { expect('null'); return V.json('null', null); }
    return num();
  };
  const expect = (word) => {
    if (src.startsWith(word, i)) { i += word.length; return; }
    throw err(`期望 "${word}"`);
  };
  const obj = (depth) => {
    i++; ws();
    const m = new Map();
    if (src[i] === '}') { i++; return V.json('obj', m); }
    for (;;) {
      ws();
      if (src[i] !== '"') throw err('对象的键必须是字符串');
      const k = str();
      ws();
      if (src[i] !== ':') throw err('对象键后缺少 ":"');
      i++; ws();
      m.set(k, value(depth + 1));
      ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === '}') { i++; return V.json('obj', m); }
      throw err('对象中缺少 "," 或 "}"');
    }
  };
  const arr = (depth) => {
    i++; ws();
    const a = [];
    if (src[i] === ']') { i++; return V.json('arr', a); }
    for (;;) {
      a.push(value(depth + 1));
      ws();
      if (src[i] === ',') { i++; ws(); continue; }
      if (src[i] === ']') { i++; return V.json('arr', a); }
      throw err('数组中缺少 "," 或 "]"');
    }
  };
  const str = () => {
    i++; // 开头引号
    let out = '';
    for (;;) {
      if (i >= src.length) throw err('字符串未闭合');
      const ch = src[i];
      if (ch === '"') { i++; return out; }
      if (ch === '\\') {
        i++;
        const e = src[i];
        switch (e) {
          case '"': out += '"'; i++; break;
          case '\\': out += '\\'; i++; break;
          case '/': out += '/'; i++; break;
          case 'b': out += '\b'; i++; break;
          case 'f': out += '\f'; i++; break;
          case 'n': out += '\n'; i++; break;
          case 'r': out += '\r'; i++; break;
          case 't': out += '\t'; i++; break;
          case 'u': {
            const hex = src.slice(i + 1, i + 5);
            const cp = Number.parseInt(hex, 16);
            if (Number.isNaN(cp)) throw err('无效的 \\u 转义');
            out += String.fromCodePoint(cp);
            i += 5;
            break;
          }
          default: throw err(`未知转义 "\\\\${e}"`);
        }
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) throw err('字符串中有未转义的控制字符');
      out += ch;
      i++;
    }
  };
  const num = () => {
    const start = i;
    if (src[i] === '-') i++;
    if (src[i] === '0') { i++; }
    else if (/[1-9]/.test(src[i] ?? '')) { i++; while (/[0-9]/.test(src[i] ?? '')) i++; }
    else throw err('无效的数字');
    if (src[i] === '.') { i++; if (!/[0-9]/.test(src[i] ?? '')) throw err('小数点后缺少数字'); while (/[0-9]/.test(src[i] ?? '')) i++; }
    if (src[i] === 'e' || src[i] === 'E') { i++; if (src[i] === '+' || src[i] === '-') i++; if (!/[0-9]/.test(src[i] ?? '')) throw err('指数缺少数字'); while (/[0-9]/.test(src[i] ?? '')) i++; }
    const text = src.slice(start, i);
    const n = Number(text);
    if (!Number.isFinite(n)) throw err(`数字 "${text}" 无效`);
    return V.json('num', n);
  };
  const top = value(0);
  ws();
  if (i < src.length) throw err('JSON 文档结束后有多余内容');
  return top;
}

export function normKey(v) {
  switch (v.t) {
    case 'int': case 'float': case 'bool': case 'str': return v.v;
    default: return v; // 检查器已排除其他类型
  }
}

export function valueEquals(a, b) {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'int': return a.v === b.v; // 检查器保证同宽
    case 'float': return a.v === b.v;
    case 'bool': case 'str': case 'unit': return a.v === b.v;
    case 'vec': return a.a.length === b.a.length && a.a.every((x, i) => valueEquals(x, b.a[i]));
    case 'tuple': return a.a.length === b.a.length && a.a.every((x, i) => valueEquals(x, b.a[i]));
    case 'map': {
      if (a.m.size !== b.m.size) return false;
      for (const [k, v] of a.m) {
        if (!b.m.has(k) || !valueEquals(v, b.m.get(k))) return false;
      }
      return true;
    }
    case 'struct': {
      if (a.def !== b.def) return false;
      for (const [k, v] of a.fields) {
        if (!valueEquals(v, b.fields.get(k))) return false;
      }
      return true;
    }
    case 'enum': return a.def === b.def && a.tag === b.tag
      && a.vals.length === b.vals.length && a.vals.every((x, i) => valueEquals(x, b.vals[i]));
    case 'range': return a.lo.v === b.lo.v && a.hi.v === b.hi.v;
    case 'json': return jsonEquals(a, b);
    default: return false;
  }
}

// ===================== 整数运算(检查;number 快路径 + BigInt 慢路径)=====================

function panicOverflow(op, a, b, span = null) {
  return new Panic('M4002', `整数${op}溢出:${a.v} ${op} ${b.v} 超出 i${a.bits}${a.signed ? '' : 'u'} 范围`, span);
}

// 双类型 fit 检查:v 可能是 number(安全整数)或 BigInt
export function fits(v, bits, signed) {
  if (typeof v === 'number') {
    if (bits <= 53) {
      if (signed) { const m = (1 << (bits - 1)); return v >= -m && v < m; }
      return v >= 0 && v < (2 ** bits);
    }
    // bits=64:number 路径只可能在安全整数内 → 一定在 i64/u64 范围内(符号已由运算守卫保证)
    if (signed) return v >= -INT_MAX_SAFE && v <= INT_MAX_SAFE;
    return v >= 0;
  }
  if (signed) return v >= -(1n << BigInt(bits - 1)) && v < (1n << BigInt(bits - 1));
  return v >= 0n && v < (1n << BigInt(bits));
}

export function intBin(op, a, b, span = null) {
  const { bits, signed } = a;
  const bad = (msg) => new Panic('M4002', msg, span);
  const av = a.v, bv = b.v;
  const bothNum = typeof av === 'number' && typeof bv === 'number';

  if (bothNum && (op === '+' || op === '-' || op === '*' || op === '/' || op === '%')) {
    switch (op) {
      case '+': {
        const r = av + bv;
        if (!Number.isSafeInteger(r)) return intBinSlow(op, a, b, span); // 可能仍在 i64 内:精确重算
        return V.int(r, bits, signed);
      }
      case '-': {
        const r = av - bv;
        if (!Number.isSafeInteger(r)) return intBinSlow(op, a, b, span);
        return V.int(r, bits, signed);
      }
      case '*': {
        const r = av * bv;
        if (!Number.isSafeInteger(r)) return intBinSlow(op, a, b, span);
        return V.int(r, bits, signed);
      }
      case '/': {
        if (bv === 0) throw new Panic('M4004', `整数除零:${av} / 0`, span);
        // (av - av % bv) / bv:余数与被减数都是精确安全整数 → 商精确
        const rem = av % bv;
        const r = (av - rem) / bv;
        return V.int(r, bits, signed);
      }
      case '%': {
        if (bv === 0) throw new Panic('M4004', `整数取模零:${av} % 0`, span);
        return V.int(av % bv, bits, signed);
      }
    }
  }
  return intBinSlow(op, a, b, span);
}

// BigInt 慢路径:精确计算(任意宽度、溢出检查)
function intBinSlow(op, a, b, span) {
  const { bits, signed } = a;
  const bad = (msg) => new Panic('M4002', msg, span);
  const av = BigInt(a.v), bv = BigInt(b.v);
  switch (op) {
    case '+': {
      const r = av + bv;
      if (!fits(r, bits, signed)) throw panicOverflow('+', a, b, span);
      return V.int(r, bits, signed);
    }
    case '-': {
      const r = av - bv;
      if (!fits(r, bits, signed)) throw panicOverflow('-', a, b, span);
      return V.int(r, bits, signed);
    }
    case '*': {
      const r = av * bv;
      if (!fits(r, bits, signed)) throw panicOverflow('*', a, b, span);
      return V.int(r, bits, signed);
    }
    case '/': {
      if (bv === 0n) throw new Panic('M4004', `整数除零:${av} / 0`, span);
      const r = av / bv;
      if (!fits(r, bits, signed)) throw bad(`整数除法溢出:${av} / ${bv}`);
      return V.int(r, bits, signed);
    }
    case '%': {
      if (bv === 0n) throw new Panic('M4004', `整数取模零:${av} % 0`, span);
      return V.int(av % bv, bits, signed);
    }
    case '<<': {
      if (bv < 0n || bv >= BigInt(bits)) throw new Panic('M4002', `移位位数 ${bv} 越界(必须在 0..${bits - 1})`, span);
      const r = av << bv;
      if (!fits(r, bits, signed)) throw panicOverflow('<<', a, b, span);
      return V.int(r, bits, signed);
    }
    case '>>': {
      if (bv < 0n || bv >= BigInt(bits)) throw new Panic('M4002', `移位位数 ${bv} 越界(必须在 0..${bits - 1})`, span);
      return V.int(av >> bv, bits, signed);
    }
    case '&': return V.int(av & bv, bits, signed);
    case '|': return V.int(av | bv, bits, signed);
    case '^': return V.int(av ^ bv, bits, signed);
    default: throw new Error(`intBin: ${op}`);
  }
}

// ===================== panic 信号 =====================

export class Panic {
  constructor(code, message, span = null) {
    this.code = code; this.message = message; this.span = span;
    this.stack = [];
    this.cause = null;   // v0.30 错误链:{code, message, stack:[{name,file,line,col}]} | null
  }
}

export class RetSig { constructor(value) { this.value = value; } }
class BrkSig { }
class ContSig { }

// ===================== 解释器 =====================

export class Interp {
  constructor(checkResult, opts = {}) {
    this.check = checkResult;
    this.syncTasks = new Map(); // handleId → {sab, worker, done}
    this.syncTaskSeq = 0;
    this.randState = (BigInt(Date.now()) ^ BigInt(process.pid)) & 0xFFFFFFFFn; // mulberry32
    this.syncTaskSeq = 0;
    this.syncScopeStack = [];   // scoped 块栈(v0.17):[{tasks: [handleId]}]
    this.entry = checkResult.entry;
    this.methodImpls = checkResult.methodImpls ?? null;
    this.out = opts.out ?? process.stdout;
    this.errOut = opts.errOut ?? process.stderr;
    this.logLevel = 1;                         // std.log 阈值(v0.28):0=debug 1=info 2=warn 3=error
    // v0.32 发布期门禁:内存配额(累计分配口径)+ 时间熔断
    this.maxAlloc = opts.maxAlloc ?? 268_435_456;   // 累计分配单位上限(Vec/Map 元素 + str 字符)
    this.allocBytes = 0;
    this.maxMs = opts.maxMs ?? 600_000;             // 墙钟上限(默认 10 分钟)
    this.runStart = Date.now();
    this.capture = opts.capture ?? false;      // 测试模式:捕获 print
    this.captured = [];
    this.stdin = opts.stdin ?? null;           // 预读的 stdin 文本
    this.stdinPos = 0;
    this.stdinLoaded = false;
    this.maxSteps = opts.maxSteps ?? Infinity;
    this.steps = 0;
    this.depth = 0;
    this.callStack = []; // {name, span}
  }

  write(s) {
    if (this.capture) this.captured.push(s);
    else this.out.write(s);
  }
  writeErr(s) {
    if (this.capture) this.captured.push(s);
    else this.errOut.write(s);
  }

  flushCaptured() { const s = this.captured.join(''); this.captured = []; return s; }

  // 模块环境:全局为空(模块项按名字解析),每个模块一个根 env
  rootEnv(mod) { return { vars: new Map(), parent: null, mod }; }

  runMain(argv = []) {
    const entry = this.entry;
    const mainEntry = entry.items.get('main');
    if (!mainEntry || mainEntry.kind !== 'fn') {
      throw new Panic('M3023', `入口文件 ${entry.file} 缺少 main 函数`);
    }
    const sig = mainEntry.sig;
    const args = [];
    if (sig.params.length >= 1) {
      args.push(V.vec(argv.map(a => V.str(a))));
    }
    if (sig.params.length > 1) {
      throw new Panic('M3023', 'main 最多接受一个参数:args: Vec[str]');
    }
    const retV = this.callUser(entry, mainEntry, null, args, mainEntry.decl?.span ?? null);
    let code = 0;
    if (sig.ret && sig.ret.k === 'int' && retV.t === 'int') {
      code = Number((BigInt(retV.v) % 256n + 256n) % 256n);
    }
    return { value: retV, exitCode: code };
  }

  runTests(filter = null) {
    const results = [];
    const tests = [...this.entry.items.entries()].filter(([n, e]) => e.kind === 'test');
    for (const [name, entry] of tests) {
      const testName = name.slice(5);
      if (filter && !testName.includes(filter)) continue;
      const sub = new Interp(this.check, { out: this.out, errOut: this.errOut, capture: true, stdin: this.stdin, maxSteps: this.maxSteps });
      const r = { name: testName, ok: false, output: '', error: null, span: entry.decl.span };
      try {
        sub.callUser(this.entry, entry, null, [], null);
        r.ok = true;
      } catch (e) {
        if (e instanceof Panic) {
          r.error = `${e.code}[${e.message}]` + (e.stack.length ? '\n' + e.stack.map(f => `  at ${f.name} (${f.span?.file}:${f.span?.line}:${f.span?.col})`).join('\n') : '');
          r.span = e.span ?? entry.decl.span;
        } else { r.error = String(e?.message ?? e); }
      }
      r.output = sub.flushCaptured();
      results.push(r);
    }
    return results;
  }

  // ---------- 函数调用 ----------
  callUser(mod, entry, env, args, callSpan, noCopySelf = false) {
    const decl = entry.decl;
    const vars = new Map();
    const params = entry.sig?.params ?? [];
    for (let i = 0; i < params.length; i++) {
      vars.set(params[i].name, (noCopySelf && i === 0) ? args[i] : deepCopy(args[i]));
    }
    const fenv = { vars, parent: null, mod };
    this.depth++;
    if (this.depth > 250) {
      this.depth--;
      throw new Panic('M4005', `调用栈过深(>250 层递归);如需更深递归请改写为循环`, callSpan);
    }
    this.callStack.push({ name: decl.name, span: callSpan });
    try {
      this.step();
      const v = this.execBlock(decl.body, fenv, { fnRet: entry.sig?.ret ?? null });
      this.depth--;
      this.callStack.pop();
      return v ?? UNIT;
    } catch (e) {
      // v0.30 修复:callStack 一直存在但从未接到 Panic.stack——"panic 输出 Ming 层调用栈"的
      // 承诺实际从未生效。最深一帧收到 Panic 时填全链(最老在前,展示层负责反转),外层不覆盖。
      if (e instanceof Panic && !e.stack.length) {
        e.stack = this.callStack.slice();
      }
      this.depth--;
      this.callStack.pop();
      if (e instanceof RetSig) return e.value;
      throw e;
    }
  }

  callClosure(clo, args, callSpan) {
    if (clo.t === 'fnref') {
      return this.callUser(clo.mod, clo.entry, null, args, callSpan);
    }
    const vars = new Map();
    for (let i = 0; i < clo.params.length; i++) {
      vars.set(clo.params[i].name, deepCopy(args[i]));
    }
    const fenv = { vars, parent: clo.env, mod: clo.env.mod };
    this.depth++;
    if (this.depth > 250) {
      this.depth--;
      throw new Panic('M4005', `调用栈过深(>250 层递归)`, callSpan);
    }
    const fnType = clo.fnType;
    this.callStack.push({ name: '<闭包>', span: callSpan });
    try {
      this.step();
      let v;
      if (clo.body.nt === 'BlockExpr') v = this.execBlock(clo.body.block, fenv, { fnRet: fnType?.ret ?? null });
      else v = this.evalExpr(clo.body, fenv);
      this.depth--;
      this.callStack.pop();
      return v ?? UNIT;
    } catch (e) {
      this.depth--;
      this.callStack.pop();
      if (e instanceof RetSig) return e.value;
      throw e;
    }
  }

  step() {
    if (++this.steps > this.maxSteps) {
      throw new Panic('M4001', `执行步数超过上限 ${this.maxSteps}(可能是死循环;用 --max-steps 调整)`);
    }
    // v0.32:墙钟熔断(每 16384 步轮询一次,摊薄 Date.now 开销)
    if ((this.steps & 16383) === 0) this.checkTimeQuota(null);
  }

  // ---------- 语句 ----------
  execBlock(block, env, ctx) {
    for (const s of block.stmts) this.execStmt(s, env, ctx);
    if (block.tail) return this.evalExpr(block.tail, env);
    return UNIT;
  }

  execStmt(s, env, ctx) {
    switch (s.nt) {
      case 'Let': {
        if (s.init) {
          const v = this.evalExpr(s.init, env);
          this.bindPattern(s.pat, v, env);
        }
        return;
      }
      case 'Assign': {
        const val = this.evalExpr(s.value, env);
        this.assignTo(s.target, s.op, val, env);
        return;
      }
      case 'Return': {
        const v = s.value ? deepCopy(this.evalExpr(s.value, env)) : UNIT;
        throw new RetSig(v);
      }
      case 'Break': throw new BrkSig();
      case 'Continue': throw new ContSig();
      case 'While': {
        for (;;) {
          this.step();
          const c = this.evalExpr(s.cond, env);
          if (!c.v) break;
          try { this.execBlock(s.body, env, ctx); }
          catch (e) { if (e instanceof BrkSig) break; if (e instanceof ContSig) continue; throw e; }
        }
        return;
      }
      case 'WhileLet': {
        for (;;) {
          this.step();
          const v = this.evalExpr(s.expr, env);
          const binds = this.matchPattern(s.pat, v);
          if (!binds) break;
          for (const [k, val] of binds) env.vars.set(k, deepCopy(val));
          try { this.execBlock(s.body, env, ctx); }
          catch (e) { if (e instanceof BrkSig) break; if (e instanceof ContSig) continue; throw e; }
        }
        return;
      }
      case 'For': {
        const it = this.evalExpr(s.iter, env);
        for (const item of this.iterate(it, s.iter.span)) {
          this.step();
          this.bindPattern(s.pat, item, env);
          try { this.execBlock(s.body, env, ctx); }
          catch (e) { if (e instanceof BrkSig) break; if (e instanceof ContSig) continue; throw e; }
        }
        return;
      }
      case 'Loop': {
        for (;;) {
          this.step();
          try { this.execBlock(s.body, env, ctx); }
          catch (e) { if (e instanceof BrkSig) break; if (e instanceof ContSig) continue; throw e; }
        }
        return;
      }
      case 'SyncScopeBlock': {
        this.enterSyncScope();
        let unwinding = null;
        try {
          this.execBlock(s.body, env, ctx);
        } catch (e) {
          unwinding = e;
          throw e;
        } finally {
          // finally 在 rethrow 抛出前执行;此时 drain 子任务(展开中吞错)
          if (unwinding) this.drainAllSyncScopes();
        }
        if (!unwinding) this.exitSyncScope(false, s.span);
        return;
      }
      case 'ExprStmt': this.evalExpr(s.expr, env); return;
      case 'FnStmt': {
        // 本地函数注册到当前 env(可递归调用;不捕获外层局部变量)
        if (!env.localFns) env.localFns = new Map();
        env.localFns.set(s.decl.name, { name: s.decl.name, decl: s.decl, mod: env.mod });
        return;
      }
      default: throw new Error(`execStmt: ${s.nt}`);
    }
  }

  // 本地函数名解析:env.vars 找不到时查模块项与本地 fn
  // 本地 fn 注册到 env.localFns
  lookupVar(name, env) {
    let e = env;
    while (e) {
      if (e.vars.has(name)) return { kind: 'var', v: e.vars.get(name), owner: e };
      if (e.localFns?.has(name)) return { kind: 'localfn', sig: e.localFns.get(name) };
      e = e.parent;
    }
    return null;
  }

  assignTo(target, op, val, env) {
    let finalVal = deepCopy(val); // 值语义:任何存储都先拷贝,消除别名
    if (op !== '=') {
      const cur = this.evalExpr(target, env);
      finalVal = this.binopValues(op[0], cur, val, target.span);
    }
    switch (target.nt) {
      case 'Ident': {
        const found = this.lookupVar(target.name, env);
        if (!found || found.kind !== 'var') throw new Panic('M4001', `内部错误:赋值目标 ${target.name} 未找到`, target.span);
        found.owner.vars.set(target.name, finalVal);
        return;
      }
      case 'Field': {
        const base = this.evalExpr(target.base, env);
        if (base.t !== 'struct') throw new Panic('M4001', `内部错误:字段赋值目标不是结构体`, target.span);
        base.fields.set(target.name, finalVal);
        return;
      }
      case 'Index': {
        const base = this.evalExpr(target.base, env);
        const idx = this.evalExpr(target.index, env);
        if (base.t === 'vec') {
          const i = Number(idx.v);
          if (!Number.isInteger(i) || i < 0 || i >= base.a.length) {
            throw new Panic('M4003', `索引越界:长度 ${base.a.length},访问 ${i}`, target.span);
          }
          base.a[i] = finalVal;
          return;
        }
        if (base.t === 'map') {
          base.m.set(normKey(idx), finalVal);
          return;
        }
        throw new Panic('M4001', `内部错误:索引赋值目标类型错误`, target.span);
      }
      default:
        throw new Panic('M4001', `内部错误:无效赋值目标`, target.span);
    }
  }

  negSlow(v) {
    const r = 0n - BigInt(v.v);
    if (!fits(r, v.bits, v.signed)) {
      throw new Panic('M4002', '整数取负溢出:-' + v.v + ' 超出范围');
    }
    return V.int(r, v.bits, v.signed);
  }

  // ---------- 模式 ----------
  bindPattern(pat, v, env) {
    switch (pat.nt) {
      case 'PWild': return;
      case 'PIdent': env.vars.set(pat.name, deepCopy(v)); return; // 值语义:绑定即拷贝
      case 'PTuple': pat.pats.forEach((p, i) => this.bindPattern(p, v.a[i], env)); return;
      default: throw new Panic('M4001', '内部错误:无效的 let 模式');
    }
  }

  matchPattern(pat, v) {
    const binds = new Map();
    if (this.tryPattern(pat, v, binds)) return binds;
    return null;
  }

  tryPattern(pat, v, binds) {
    switch (pat.nt) {
      case 'PWild': return true;
      case 'PIdent': binds.set(pat.name, v); return true;
      case 'PLit': {
        const lit = pat.lit;
        if (lit.kind === 'int') {
          if (v.t !== 'int') return false;
          const lv = normInt(BigInt(lit.val) * (pat.neg ? -1n : 1n));
          return typeof v.v === typeof lv ? v.v === lv : BigInt(v.v) === BigInt(lv);
        }
        if (lit.kind === 'str') return v.t === 'str' && v.v === lit.val;
        return v.t === 'bool' && v.v === (lit.val === 'true');
      }
      case 'PEnum': return this.tryEnumPattern(pat, v, binds);
      case 'PTuple': {
        if (v.t !== 'tuple' || v.a.length !== pat.pats.length) return false;
        return pat.pats.every((p, i) => this.tryPattern(p, v.a[i], binds));
      }
      default: return false;
    }
  }

  tryEnumPattern(pat, v, binds) {
    // 内置 Option/Result
    if (v.t === 'enum' && v.def === 'builtin-opt') {
      if (pat.variant !== v.tag) return false;
      return pat.args.every((a, i) => this.tryPattern(a, v.vals[i], binds));
    }
    if (v.t !== 'enum') return false;
    // 名字核对:限定名必须一致;裸名(None 等)跳过核对
    if (pat.enumName !== null && pat.enumName !== v.def.name) return false;
    if (pat.variant !== v.tag) return false;
    if (pat.args.length !== v.vals.length) return false;
    return pat.args.every((a, i) => this.tryPattern(a, v.vals[i], binds));
  }

  // ---------- 迭代 ----------
  *iterate(it, span) {
    switch (it.t) {
      case 'vec': yield* it.a; return;
      case 'tuple': yield* it.a; return;
      case 'str': for (const ch of it.v) yield V.str(ch); return;
      case 'range': {
        if (typeof it.lo.v === 'number' && typeof it.hi.v === 'number') {
          for (let i = it.lo.v; i < it.hi.v; i++) {
            this.step();
            yield V.int(i, it.lo.bits, it.lo.signed);
          }
        } else {
          for (let i = BigInt(it.lo.v); i < BigInt(it.hi.v); i += 1n) {
            this.step();
            yield V.int(i, it.lo.bits, it.lo.signed);
          }
        }
        return;
      }
      case 'map': {
        for (const [k, v] of it.m) {
          yield V.tuple([keyValue(k), v]);
        }
        return;
      }
      default:
        throw new Panic('M3026', `${it.t} 不可迭代`, span);
    }
  }

  // ---------- 表达式 ----------
  evalExpr(e, env) {
    this.step();
    switch (e.nt) {
      case 'IntLit': return V.int(e.v, e.bits, e.signed);
      case 'FloatLit': return V.float(e.v, e.bits);
      case 'BoolLit': return V.bool(e.v);
      case 'StrLit': {
        if (e.parts.length === 1 && 'lit' in e.parts[0]) return V.str(e.parts[0].lit);
        let s = '';
        for (const p of e.parts) {
          if ('lit' in p) s += p.lit;
          else {
            const v = this.evalExpr(p.expr, env);
            s += displayStr(v);
          }
        }
        return V.str(s);
      }
      case 'Ident': {
        const found = this.lookupVar(e.name, env);
        if (found?.kind === 'var') return found.v;
        if (found?.kind === 'localfn') return { t: 'localfn', sig: found.sig };
        // prelude 变体 None
        if (e.name === 'None') return V.enumv('builtin-opt', 'None', []);
        if (e.name === 'std') return { t: 'stdmod', name: 'std' };
        // 模块项:常量 / 函数值
        const entry = env.mod.items.get(e.name);
        if (entry?.kind === 'const') {
          if (entry.cvalue === undefined) {
            entry.cvalue = this.evalExpr(entry.decl.init, { vars: new Map(), parent: null, mod: env.mod });
          }
          return entry.cvalue;
        }
        if (entry?.kind === 'fn') return V.fnref(env.mod, entry);
        throw new Panic('M4001', `内部错误:名字 ${e.name} 未在运行时解析`, e.span);
      }
      case 'Field': return this.evalField(e, env);
      case 'Call': return this.evalCall(e, env);
      case 'Index': {
        const base = this.evalExpr(e.base, env);
        const idx = this.evalExpr(e.index, env);
        if (base.t === 'vec') {
          const i = Number(idx.v);
          if (!Number.isInteger(i) || i < 0 || i >= base.a.length) {
            throw new Panic('M4003', `索引越界:长度 ${base.a.length},访问 ${i}(用 .get(i) 返回 Option)`, e.span);
          }
          return base.a[i];
        }
        if (base.t === 'map') {
          const k = normKey(idx);
          if (!base.m.has(k)) {
            throw new Panic('M4007', `map 中不存在键 ${debugStr(idx)}(用 .get(k) 返回 Option)`, e.span);
          }
          return base.m.get(k);
        }
        throw new Panic('M4001', `内部错误:索引目标类型错误`, e.span);
      }
      case 'Unary': {
        const v = this.evalExpr(e.expr, env);
        if (e.op === '!') return V.bool(!v.v);
        if (v.t === 'int') {
          if (typeof v.v === 'number') {
            const r = -v.v;
            if (!Number.isSafeInteger(r)) return this.negSlow(v);
            return V.int(r, v.bits, v.signed);
          }
          return this.negSlow(v);
        }
        return V.float(-v.v, v.bits);
      }
      case 'Binary': {
        if (e.op === '&&') {
          const l = this.evalExpr(e.l, env);
          if (!l.v) return V.bool(false);
          return V.bool(this.evalExpr(e.r, env).v);
        }
        if (e.op === '||') {
          const l = this.evalExpr(e.l, env);
          if (l.v) return V.bool(true);
          return V.bool(this.evalExpr(e.r, env).v);
        }
        const l = this.evalExpr(e.l, env);
        const r = this.evalExpr(e.r, env);
        return this.binopValues(e.op, l, r, e.span);
      }
      case 'Range': {
        const lo = this.evalExpr(e.lo, env);
        const hi = this.evalExpr(e.hi, env);
        return V.range(lo, hi);
      }
      case 'As': {
        const v = this.evalExpr(e.expr, env);
        return this.castValue(v, e.asType, e.span);
      }
      case 'PostQ': {
        const v = this.evalExpr(e.expr, env);
        if (v.t === 'enum') {
          if (v.def === 'builtin-opt' && v.tag === 'None') throw new RetSig(V.enumv('builtin-opt', 'None', []));
          if (v.def === 'builtin-res' && v.tag === 'Err') throw new RetSig(V.enumv('builtin-res', 'Err', v.vals));
          return v.vals[0];
        }
        throw new Panic('M4001', '内部错误:"?" 目标不是 Option/Result', e.span);
      }
      case 'If': {
        const c = this.evalExpr(e.cond, env);
        if (c.v) return this.execBlock(e.then, env, {});
        if (e.els) {
          return e.els.nt === 'If' ? this.evalExpr(e.els, env) : this.execBlock(e.els, env, {});
        }
        return UNIT;
      }
      case 'Match': {
        const v = this.evalExpr(e.scrutinee, env);
        for (const arm of e.arms) {
          const binds = this.matchPattern(arm.pat, v);
          if (!binds) continue;
          if (arm.guard) {
            const genv = { vars: binds, parent: env, mod: env.mod };
            if (!this.evalExpr(arm.guard, genv).v) continue;
          }
          // 值语义:分支绑定是 scrutinee 子值的拷贝
          const avars = new Map();
          for (const [k, val] of binds) avars.set(k, deepCopy(val));
          const aenv = { vars: avars, parent: env, mod: env.mod };
          return this.evalExpr(arm.expr, aenv);
        }
        throw new Panic('M4001', '内部错误:match 无分支命中(检查器应已拦截)', e.span);
      }
      case 'VecLit': {
        this.chargeAllocBytes(e.elems.length, e.span);
        return V.vec(e.elems.map(x => deepCopy(this.evalExpr(x, env))));
      }
      case 'MapLit': {
        this.chargeAllocBytes(e.entries.length, e.span);
        const m = new Map();
        for (const en of e.entries) {
          const k = this.evalExpr(en.k, env);
          const v = this.evalExpr(en.v, env);
          m.set(normKey(k), deepCopy(v));
        }
        return V.map(m);
      }
      case 'TupleLit': return e.elems.length === 0 ? UNIT : V.tuple(e.elems.map(x => deepCopy(this.evalExpr(x, env))));
      case 'StructLit': return this.evalStructLit(e, env);
      case 'Lambda': {
        // 值语义:创建闭包时对可见环境做深拷贝快照,捕获后与外部脱钩
        return V.closure(e.params, e.body, snapshotEnv(env), e.fnTypeHint ?? null);
      }
      case 'BlockExpr': return this.execBlock(e.block, env, {});
      case 'LoopExpr': {
        for (;;) {
          this.step();
          try { this.execBlock(e.body, env, {}); }
          catch (ex) { if (ex instanceof BrkSig) return UNIT; if (ex instanceof ContSig) continue; throw ex; }
        }
      }
      default:
        throw new Panic('M4001', `内部错误:未知表达式 ${e.nt}`, e.span);
    }
  }

  evalField(e, env) {
    // 类型级:Option.Some / Result.Ok / 用户枚举变体 / 模块函数
    if (e.base.nt === 'Ident') {
      const n = e.base.name;
      const found = this.lookupVar(n, env);
      if (!found) {
        if (n === 'Option') return { t: 'ctor', enumName: 'Option', variant: e.name };
        if (n === 'Result') return { t: 'ctor', enumName: 'Result', variant: e.name };
        if (n === 'std') return { t: 'stdmod', name: e.name };
        if (env.mod.imports.has(n)) {
          const imp = env.mod.imports.get(n);
          if (imp.std) return { t: 'stdfn', mod: imp.std, name: e.name };
          const entry2 = imp.local.items.get(e.name);
          if (entry2?.kind === 'fn') return V.fnref(imp.local, entry2);
          if (entry2?.kind === 'enum') {
            const vv = entry2.decl.variants.find(x => x.name === e.name);
            if (vv && vv.types.length === 0) return V.enumv(entry2.decl, e.name, []);
            return { t: 'ctor', def: entry2.decl, variant: e.name };
          }
        }
        if (PRIM_TYPES[n]) return { t: 'typeobj', prim: n };
      }
      // 当前模块的枚举变体
      if (!found) {
        const entry = env.mod.items.get(n);
        if (entry?.kind === 'enum') {
          const vv = entry.decl.variants.find(x => x.name === e.name);
          if (vv && vv.types.length === 0) return V.enumv(entry.decl, e.name, []);
          return { t: 'ctor', def: entry.decl, variant: e.name };
        }
      }
    }
    const base = this.evalExpr(e.base, env);
    if (base.t === 'struct' && base.fields.has(e.name)) {
      return base.fields.get(e.name);
    }
    // 方法调用的接收者:交回给 Call 处理(检查器已验证方法存在)
    return { t: 'methrecv', base, name: e.name };
  }

  evalStructLit(e, env) {
    // 解析结构体定义
    let def = null;
    if (e.path.length === 1) {
      const entry = env.mod.items.get(e.path[0]);
      def = entry?.decl ?? null;
    } else {
      const imp = env.mod.imports.get(e.path[0]);
      if (imp?.local) {
        const entry = imp.local.items.get(e.path[1]);
        def = entry?.decl ?? null;
      }
    }
    if (!def) throw new Panic('M4001', `内部错误:结构体 ${e.path.join('.')} 未找到`, e.span);
    const fields = new Map();
    for (const f of e.fields) {
      fields.set(f.name, deepCopy(this.evalExpr(f.value, env)));
    }
    return V.struct(def, fields);
  }

  evalCall(e, env) {
    const callee = e.callee;
    if (callee.nt === 'Ident') {
      const name = callee.name;
      const found = this.lookupVar(name, env);
      if (found?.kind === 'var') {
        const f = found.v;
        const args = e.args.map(a => deepCopy(this.evalExpr(a, env)));
        if (f.t === 'closure' || f.t === 'fnref') return this.callClosure(f, args, e.span);
        throw new Panic('M4001', `${name} 不是函数`, e.span);
      }
      if (found?.kind === 'localfn') {
        const args = e.args.map(a => deepCopy(this.evalExpr(a, env)));
        return this.callLocalFn(found.sig, args, e);
      }
      // prelude 变体构造
      if (name === 'Some') return V.enumv('builtin-opt', 'Some', e.args.map(a => deepCopy(this.evalExpr(a, env))));
      if (name === 'Ok' || name === 'Err') return V.enumv('builtin-res', name, e.args.map(a => deepCopy(this.evalExpr(a, env))));
      // 模块级函数
      const entry = env.mod.items.get(name);
      if (entry?.kind === 'fn') {
        const args = e.args.map(a => deepCopy(this.evalExpr(a, env)));
        return this.callUser(env.mod, entry, env, args, e.span);
      }
      if (BUILTIN_IMPLS[name]) {
        const args = e.args.map(a => deepCopy(this.evalExpr(a, env)));
        return BUILTIN_IMPLS[name](this, args, e.span);
      }
      throw new Panic('M4001', `内部错误:调用目标 ${name} 未解析`, e.span);
    }
    if (callee.nt === 'Field') {
      const f = this.evalExpr(callee, env);
      const args = e.args.map(a => deepCopy(this.evalExpr(a, env)));
      if (f.t === 'ctor') return this.constructVariant(f, args, e.span);
      if (f.t === 'stdmod') return this.callStd(f.name, callee.name, args, e.span);
      if (f.t === 'stdfn') return this.callStd(f.mod, f.name, args, e.span);
      if (f.t === 'closure' || f.t === 'fnref') return this.callClosure(f, args, e.span);
      if (f.t === 'localfn') return this.callLocalFn(f.sig, args, e);
      if (f.t === 'typeobj') return this.typeLevelValue(f.prim, callee.name, e.span);
      if (f.t === 'methrecv') {
        // 嵌套路径:std.math.pi() / geom.Shape.Circle(r)
        if (f.base.t === 'stdmod') return this.callStd(f.base.name, f.name, args, e.span);
        if (f.base.t === 'ctor' && f.base.variant === f.base.def?.name) {
          return this.constructVariant({ def: f.base.def, variant: f.name }, args, e.span);
        }
        return this.callMethod(f.base, f.name, args, callee, e, env);
      }
      // 方法调用
      return this.callMethod(f, callee.name, args, callee, e, env);
    }
    // 其他:先求值再调用
    const f = this.evalExpr(callee, env);
    const args = e.args.map(a => deepCopy(this.evalExpr(a, env)));
    if (f.t === 'closure' || f.t === 'fnref' || f.t === 'localfn') return this.callClosure(f, args, e.span);
    throw new Panic('M4001', '内部错误:调用目标不是函数', e.span);
  }

  callLocalFn(sig, args, e) {
    const decl = sig.decl;
    const vars = new Map();
    decl.params.forEach((p, i) => vars.set(p.name, deepCopy(args[i])));
    const fenv = { vars, parent: null, mod: sig.mod };
    this.depth++;
    if (this.depth > 250) { this.depth--; throw new Panic('M4005', `调用栈过深(>250 层递归)`, e.span); }
    this.callStack.push({ name: decl.name, span: e.span });
    try {
      const v = this.execBlock(decl.body, fenv, { fnRet: null });
      this.depth--; this.callStack.pop();
      return v ?? UNIT;
    } catch (ex) {
      this.depth--; this.callStack.pop();
      if (ex instanceof RetSig) return ex.value;
      throw ex;
    }
  }

  constructVariant(ctor, args, span) {
    if (ctor.def === 'builtin-opt' || ctor.enumName === 'Option') {
      if (ctor.variant === 'Some') return V.enumv('builtin-opt', 'Some', args);
      return V.enumv('builtin-opt', 'None', []);
    }
    if (ctor.def === 'builtin-res' || ctor.enumName === 'Result') {
      return V.enumv('builtin-res', ctor.variant, args);
    }
    const def = ctor.def;
    return V.enumv(def, ctor.variant, args);
  }

  typeLevelValue(prim, name, span) {
    if (prim.startsWith('i') || prim.startsWith('u')) {
      if (name === 'max_value') {
        const t = PRIM_TYPES[prim];
        return V.int(t.signed ? (1n << BigInt(t.bits - 1)) - 1n : (1n << BigInt(t.bits)) - 1n, t.bits, t.signed);
      }
      if (name === 'min_value') {
        const t = PRIM_TYPES[prim];
        return V.int(t.signed ? -(1n << BigInt(t.bits - 1)) : 0n, t.bits, t.signed);
      }
    } else {
      if (name === 'infinity') return V.float(Infinity, prim === 'f32' ? 32 : 64);
      if (name === 'neg_infinity') return V.float(-Infinity, prim === 'f32' ? 32 : 64);
      if (name === 'nan') return V.float(NaN, prim === 'f32' ? 32 : 64);
    }
    throw new Panic('M4001', `内部错误:类型级函数 ${prim}.${name}`, span);
  }

  callStd(modName, fnName, args, span) {
    switch (`${modName}.${fnName}`) {
      case 'math.sqrt': return V.float(Math.sqrt(asF64(args[0])), 64);
      case 'math.pow': return V.float(Math.pow(asF64(args[0]), asF64(args[1])), 64);
      case 'math.abs': return V.float(Math.abs(asF64(args[0])), 64);
      case 'math.floor': return V.float(Math.floor(asF64(args[0])), 64);
      case 'math.ceil': return V.float(Math.ceil(asF64(args[0])), 64);
      case 'math.round': return V.float(Math.round(asF64(args[0])), 64);
      case 'math.min': return V.float(Math.min(asF64(args[0]), asF64(args[1])), 64);
      case 'math.max': return V.float(Math.max(asF64(args[0]), asF64(args[1])), 64);
      case 'math.exp': return V.float(Math.exp(asF64(args[0])), 64);
      case 'math.ln': return V.float(Math.log(asF64(args[0])), 64);
      case 'math.sin': return V.float(Math.sin(asF64(args[0])), 64);
      case 'math.cos': return V.float(Math.cos(asF64(args[0])), 64);
      case 'math.tan': return V.float(Math.tan(asF64(args[0])), 64);
      // v0.29 数学补全
      case 'math.asin': return V.float(Math.asin(asF64(args[0])), 64);
      case 'math.acos': return V.float(Math.acos(asF64(args[0])), 64);
      case 'math.atan': return V.float(Math.atan(asF64(args[0])), 64);
      case 'math.atan2': return V.float(Math.atan2(asF64(args[0]), asF64(args[1])), 64);
      case 'math.sinh': return V.float(Math.sinh(asF64(args[0])), 64);
      case 'math.cosh': return V.float(Math.cosh(asF64(args[0])), 64);
      case 'math.tanh': return V.float(Math.tanh(asF64(args[0])), 64);
      case 'math.log2': return V.float(Math.log2(asF64(args[0])), 64);
      case 'math.log10': return V.float(Math.log10(asF64(args[0])), 64);
      case 'math.cbrt': return V.float(Math.cbrt(asF64(args[0])), 64);
      case 'math.hypot': return V.float(Math.hypot(asF64(args[0]), asF64(args[1])), 64);
      case 'math.pi': return V.float(Math.PI, 64);
      case 'math.e': return V.float(Math.E, 64);
      case 'io.read_line': return V.str(this.readLine());
      // 日志(v0.28):级别过滤,`[LEVEL] msg` 到 stderr;set_level 非法值 = 程序员错误 → panic
      case 'log.debug': return this.logEmit(0, 'DEBUG', args[0].v);
      case 'log.info': return this.logEmit(1, 'INFO', args[0].v);
      case 'log.warn': return this.logEmit(2, 'WARN', args[0].v);
      case 'log.error': return this.logEmit(3, 'ERROR', args[0].v);
      case 'log.set_level': {
        const lv = { debug: 0, info: 1, warn: 2, error: 3 }[args[0].v];
        if (lv === undefined) throw new Panic('M4001', '非法日志级别: ' + args[0].v + '(有效:debug/info/warn/error)', null);
        this.logLevel = lv;
        return UNIT;
      }
      case 'log.get_level': return V.str(['debug', 'info', 'warn', 'error'][this.logLevel]);
      case 'time.now_ms': return V.int(BigInt(Date.now()), 64, true);
      // ---- std.fs(capability:调用方必须声明 fs 效果,检查器强制)----
      case 'fs.read_file': {
        try {
          const content = nodeFs.readFileSync(args[0].v, 'utf8');
          return V.enumv('builtin-res', 'Ok', [V.str(content)]);
        } catch (e) {
          return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]);
        }
      }
      // v0.31 二进制 I/O 雏形:整文件 ↔ Vec[u8];单文件上限 8MB(无流式)
      case 'fs.read_bytes': {
        try {
          const st = nodeFs.statSync(args[0].v);
          if (st.size > 8 * 1024 * 1024) {
            return V.enumv('builtin-res', 'Err', [V.str('read_bytes:文件超过 8MB 上限(' + st.size + ' 字节): ' + args[0].v)]);
          }
          const buf = nodeFs.readFileSync(args[0].v);
          return V.enumv('builtin-res', 'Ok', [V.vec([...buf].map(b => V.int(BigInt(b), 8, false)))]);
        } catch (e) {
          return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]);
        }
      }
      case 'fs.write_bytes': {
        const r = this.u8VecToFile(args[0].v, args[1], 'write');
        if (r !== null) return V.enumv('builtin-res', 'Err', [V.str(r)]);
        return V.enumv('builtin-res', 'Ok', [V.bool(true)]);
      }
      case 'fs.append_bytes': {
        const r = this.u8VecToFile(args[0].v, args[1], 'append');
        if (r !== null) return V.enumv('builtin-res', 'Err', [V.str(r)]);
        return V.enumv('builtin-res', 'Ok', [V.bool(true)]);
      }
      case 'fs.write_file': {
        try {
          nodeFs.writeFileSync(args[0].v, args[1].v, 'utf8');
          return V.enumv('builtin-res', 'Ok', [V.bool(true)]);
        } catch (e) {
          return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]);
        }
      }
      case 'fs.append_file': {
        try {
          nodeFs.appendFileSync(args[0].v, args[1].v, 'utf8');
          return V.enumv('builtin-res', 'Ok', [V.bool(true)]);
        } catch (e) {
          return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]);
        }
      }
      case 'fs.exists': return V.bool(nodeFs.existsSync(args[0].v));
      case 'fs.is_dir': {
        try { return V.bool(nodeFs.statSync(args[0].v).isDirectory()); }
        catch { return V.bool(false); }
      }
      case 'fs.list_dir': {
        try {
          const names = nodeFs.readdirSync(args[0].v, 'utf8');
          return V.enumv('builtin-res', 'Ok', [V.vec(names.map(n => V.str(n)))]);
        } catch (e) {
          return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]);
        }
      }
      case 'fs.make_dir': {
        try {
          nodeFs.mkdirSync(args[0].v, { recursive: true });
          return V.enumv('builtin-res', 'Ok', [V.bool(true)]);
        } catch (e) {
          return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]);
        }
      }
      case 'fs.metadata': {
        try {
          const st = nodeFs.statSync(args[0].v);
          const meta = V.json('obj', new Map([
            ['size', V.json('num', st.size)],
            ['is_dir', V.json('bool', st.isDirectory())],
            ['is_file', V.json('bool', st.isFile())],
            ['modified_ms', V.json('num', st.mtimeMs)],
            ['name', V.json('str', nodePath.basename(args[0].v))],
          ]));
          return V.enumv('builtin-res', 'Ok', [meta]);
        } catch (e) {
          return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]);
        }
      }
      case 'fs.copy_file': {
        try { nodeFs.copyFileSync(args[0].v, args[1].v); return V.enumv('builtin-res', 'Ok', [V.bool(true)]); }
        catch (e) { return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]); }
      }
      case 'fs.rename': {
        try { nodeFs.renameSync(args[0].v, args[1].v); return V.enumv('builtin-res', 'Ok', [V.bool(true)]); }
        catch (e) { return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]); }
      }
      case 'fs.remove_dir': {
        try { nodeFs.rmdirSync(args[0].v, { recursive: false }); return V.enumv('builtin-res', 'Ok', [V.bool(true)]); }
        catch (e) { return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]); }
      }
      case 'fs.remove_dir_recursive': {
        try { nodeFs.rmSync(args[0].v, { recursive: true, force: true }); return V.enumv('builtin-res', 'Ok', [V.bool(true)]); }
        catch (e) { return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]); }
      }
      case 'proc.exec': return this.procExec(args[0].v, args[1], span);
      case 'env.get': {
        const v = process.env[args[0].v];
        return v === undefined ? V.enumv('builtin-opt', 'None', []) : V.enumv('builtin-opt', 'Some', [V.str(v)]);
      }
      case 'env.set': {
        try { process.env[args[0].v] = args[1].v; return V.enumv('builtin-res', 'Ok', [V.bool(true)]); }
        catch (e) { return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]); }
      }
      case 'env.remove': {
        const had = args[0].v in process.env;
        delete process.env[args[0].v];
        return V.bool(had);
      }
      case 'io.read_to_end': {
        if (!this.stdinLoaded) {
          if (this.stdin === null) { try { this.stdin = nodeFs.readFileSync(0, 'utf8'); } catch { this.stdin = ''; } }
          this.stdinLoaded = true;
        }
        const rest = this.stdin.slice(this.stdinPos);
        this.stdinPos = this.stdin.length;
        return V.str(rest);
      }
      case 'fs.remove_file': {
        try {
          nodeFs.unlinkSync(args[0].v);
          return V.enumv('builtin-res', 'Ok', [V.bool(true)]);
        } catch (e) {
          return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]);
        }
      }
      // ---- std.path(纯函数)----
      case 'net.http_get': return this.httpOpts({ method: 'GET', url: args[0].v, headers: {}, body: '', timeoutMs: 35000, redirect: 'follow', withHeaders: false }, span);
      case 'net.http_request': {
        const hs = {};
        if (args[2].t === 'map') for (const [k, v] of args[2].m) hs[String(k)] = String(v.v);
        return this.httpOpts({ method: args[0].v, url: args[1].v, headers: hs, body: args.length > 3 ? args[3].v : '', timeoutMs: 35000, redirect: 'follow', withHeaders: false }, span);
      }
      case 'net.http_request_opts': {
        const hs = {};
        if (args[2].t === 'map') for (const [k, v] of args[2].m) hs[String(k)] = String(v.v);
        return this.httpOpts({ method: args[0].v, url: args[1].v, headers: hs, body: args.length > 4 ? args[3].v : '', timeoutMs: Number(args[4].v), redirect: 'follow', withHeaders: true }, span);
      }
      // ---- std.sync(结构化并发)----
      case 'sync.spawn': return this.syncSpawn(args, span);
      case 'sync.spawn_all': return this.syncSpawnAll(args, span);
      case 'sync.join': return this.syncJoin(args, span);
      case 'sync.join_detailed': return this.syncJoinDetailed(args, span);
      case 'sync.cancel': return this.syncCancel(args, span);
      case 'path.join': return V.str(nodePath.join(args[0].v, args[1].v));
      case 'path.base_name': return V.str(nodePath.basename(args[0].v));
      case 'path.dir_name': return V.str(nodePath.dirname(args[0].v));
      case 'path.extension': return V.str(nodePath.extname(args[0].v));
      // ---- std.json(纯函数)----
      case 'json.stringify': {
        // 检查器已保证 JSON 兼容类型;这里把 Ming 值转为 Json 值再输出
        return V.str(jsonWrite(this.toMingJson(args[0])));
      }
      case 'json.parse': {
        try {
          return V.enumv('builtin-res', 'Ok', [parseJsonText(args[0].v)]);
        } catch (e) {
          return V.enumv('builtin-res', 'Err', [V.str(String(e.message))]);
        }
      }
      // ---- std.time.sleep(效果 time;Atomics 同步睡眠)----
      case 'fmt.fixed': return V.str(args[0].v.toFixed(Math.max(0, Math.min(100, Number(args[1].v)))));
      case 'fmt.hex': return V.str('0x' + BigInt.asUintN(64, BigInt(args[0].v)).toString(16));
      case 'fmt.bin': return V.str('0b' + BigInt.asUintN(64, BigInt(args[0].v)).toString(2));
      case 'fmt.exp': return V.str(args[0].v.toExponential(Math.max(0, Math.min(100, Number(args[1].v)))));
      case 'fmt.align': {
        // 宽度对齐(v0.28):字符数口径;不足补空格,超宽原样;center 左侧取 floor(补齐偏右)
        const s = args[0].v;
        const width = Number(args[1].v);
        const mode = args[2].v;
        const len = [...s].length;
        if (width <= len) return V.str(s);
        const pad = width - len;
        if (mode === 'left') return V.str(s + ' '.repeat(pad));
        if (mode === 'right') return V.str(' '.repeat(pad) + s);
        if (mode === 'center') {
          const l = Math.floor(pad / 2);
          return V.str(' '.repeat(l) + s + ' '.repeat(pad - l));
        }
        throw new Panic('M4001', '非法对齐模式: ' + mode + '(有效:left/right/center)', null);
      }
      case 're.is_match': return V.bool(this.reCompile(args[0].v, 'u').test(args[1].v));
      case 're.find': {
        const m = this.reCompile(args[0].v, 'u').exec(args[1].v);
        return m ? V.enumv('builtin-opt', 'Some', [V.str(m[0])]) : V.enumv('builtin-opt', 'None', []);
      }
      case 're.find_all': {
        const re = this.reCompile(args[0].v, 'gu');
        const out = [];
        for (const m of args[1].v.matchAll(re)) out.push(V.str(m[0]));
        return V.vec(out);
      }
      case 're.replace': {
        const re = this.reCompile(args[0].v, 'gu');
        return V.str(args[1].v.replace(re, args[2].v));
      }
      case 're.split': {
        const re = this.reCompile(args[0].v, 'gu');
        return V.vec(args[1].v.split(re).map(x => V.str(x)));
      }
      case 'time.monotonic_ms': {
        return V.int(BigInt(Math.floor(performance.now())), 64, true);
      }
      case 'time.date_parts': {
        const d = new Date(Number(args[0].v));
        const obj = new Map([
          ['year', V.json('num', d.getFullYear())],
          ['month', V.json('num', d.getMonth() + 1)],
          ['day', V.json('num', d.getDate())],
          ['hour', V.json('num', d.getHours())],
          ['min', V.json('num', d.getMinutes())],
          ['sec', V.json('num', d.getSeconds())],
          ['weekday', V.json('num', d.getDay() === 0 ? 7 : d.getDay())],
        ]);
        return V.json('obj', obj);
      }
      case 'time.format_iso': {
        const d = new Date(Number(args[0].v));
        const p2 = (x) => String(x).padStart(2, '0');
        return V.str(d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
          + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()));
      }
      case 'time.parse_iso': {
        const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(args[0].v.trim());
        if (!m) return V.enumv('builtin-res', 'Err', [V.str('不是有效的 ISO 日期时间: ' + args[0].v)]);
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
        if (Number.isNaN(d.getTime())) return V.enumv('builtin-res', 'Err', [V.str('日期超出范围: ' + args[0].v)]);
        return V.enumv('builtin-res', 'Ok', [V.int(BigInt(d.getTime()), 64, true)]);
      }
      case 'rand.u64': {
        this.randStep();
        const hi = this.randState;
        this.randStep();
        const lo = this.randState & 0xFFFFFFFFn;
        return V.int((hi << 32n) | lo, 64, false);
      }
      case 'rand.f64': {
        this.randStep();
        return V.float(Number(this.randState) / 4294967296, 64);
      }
      case 'rand.range': {
        const lo = BigInt(args[0].v), hi = BigInt(args[1].v);
        if (hi <= lo) throw new Panic('M4001', 'rand.range 要求 lo < hi', span);
        this.randStep();
        const r = this.randState & 0x7FFFFFFFFFFFFFFFn;
        return V.int(lo + (r % (hi - lo)), 64, true);
      }
      case 'rand.seed': {
        this.randState = BigInt(args[0].v) & 0xFFFFFFFFn;
        return UNIT;
      }
      case 'time.sleep': {
        const ms = Number(args[0].v);
        if (Number.isFinite(ms) && ms > 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 3_600_000));
        }
        return UNIT;
      }
      default:
        throw new Panic('M4001', `内部错误:std.${modName}.${fnName} 未实现`, span);
    }
  }

  // Ming JSON 兼容值 → Json 值(stringify 的输入;检查器已静态校验兼容)
  toMingJson(v) {
    switch (v.t) {
      case 'json': return v;
      case 'int': return V.json('num', Number(v.v));
      case 'float': return V.json('num', v.v);
      case 'bool': return V.json('bool', v.v);
      case 'str': return V.json('str', v.v);
      case 'vec': return V.json('arr', v.a.map(x => this.toMingJson(x)));
      case 'tuple': return V.json('arr', v.a.map(x => this.toMingJson(x)));
      case 'map': {
        const m = new Map();
        for (const [k, val] of v.m) m.set(String(k), this.toMingJson(val));
        return V.json('obj', m);
      }
      case 'enum': {
        // Option[T]:None → null,Some → 内值
        if (v.def === 'builtin-opt') {
          return v.tag === 'Some' ? this.toMingJson(v.vals[0]) : V.json('null', null);
        }
        return V.json('null', null);
      }
      default: return V.json('null', null);
    }
  }

  // Json 方法(recv.t === 'json')
  jsonMethodImpl(recv, name, args, span) {
    const j = recv;
    switch (name) {
      case 'is_null': return V.bool(j.kind === 'null');
      case 'is_bool': return V.bool(j.kind === 'bool');
      case 'is_num': return V.bool(j.kind === 'num');
      case 'is_str': return V.bool(j.kind === 'str');
      case 'is_arr': return V.bool(j.kind === 'arr');
      case 'is_obj': return V.bool(j.kind === 'obj');
      case 'as_bool': return j.kind === 'bool' ? V.enumv('builtin-opt', 'Some', [V.bool(j.v)]) : V.enumv('builtin-opt', 'None', []);
      case 'as_num': return j.kind === 'num' ? V.enumv('builtin-opt', 'Some', [V.float(j.v)]) : V.enumv('builtin-opt', 'None', []);
      case 'as_str': return j.kind === 'str' ? V.enumv('builtin-opt', 'Some', [V.str(j.v)]) : V.enumv('builtin-opt', 'None', []);
      case 'as_arr': return j.kind === 'arr' ? V.enumv('builtin-opt', 'Some', [V.vec(j.v.slice())]) : V.enumv('builtin-opt', 'None', []);
      case 'as_obj': {
        if (j.kind !== 'obj') return V.enumv('builtin-opt', 'None', []);
        const m = new Map();
        for (const [k, val] of j.v) m.set(V.str(k), val);
        return V.enumv('builtin-opt', 'Some', [V.map(m)]);
      }
      case 'get': {
        if (j.kind !== 'obj') return V.enumv('builtin-opt', 'None', []);
        const k = args[0].v;
        return j.v.has(k) ? V.enumv('builtin-opt', 'Some', [j.v.get(k)]) : V.enumv('builtin-opt', 'None', []);
      }
      case 'at': {
        if (j.kind !== 'arr') return V.enumv('builtin-opt', 'None', []);
        const i = Number(args[0].v);
        if (!Number.isInteger(i) || i < 0 || i >= j.v.length) return V.enumv('builtin-opt', 'None', []);
        return V.enumv('builtin-opt', 'Some', [j.v[i]]);
      }
      case 'eq': return V.bool(jsonEquals(j, args[0]));
      default:
        throw new Panic('M4001', `内部错误:Json.${name}`, span);
    }
  }

  readLine() {
    if (!this.stdinLoaded) {
      if (this.stdin === null) {
        try { this.stdin = nodeFs.readFileSync(0, 'utf8'); } catch { this.stdin = ''; }
      }
      this.stdinLoaded = true;
    }
    if (this.stdinPos >= this.stdin.length) return '';
    let nl = this.stdin.indexOf('\n', this.stdinPos);
    let line;
    if (nl === -1) { line = this.stdin.slice(this.stdinPos); this.stdinPos = this.stdin.length; }
    else { line = this.stdin.slice(this.stdinPos, nl); this.stdinPos = nl + 1; }
    return line.replace(/\r$/, '');
  }

  // ---------- 外部进程(v0.24):worker 同步化 ----------
  procExec(cmd, argsV, span) {
    const CAP = 10 * 1024 * 1024;
    const sab = new SharedArrayBuffer(8 + CAP);
    const argList = argsV.a.map(x => x.v);
    const workerCode = [
      "import { workerData, parentPort } from 'node:worker_threads';",
      "import * as cp from 'node:child_process';",
      'try {',
      "    cp.execFile(workerData.cmd, workerData.args, { timeout: 55000, maxBuffer: workerData.cap, encoding: 'utf8' }, (err, stdout, stderr) => {",
      '      const code = err && typeof err.code === "number" ? err.code : (err ? -1 : 0);',
      '      const payload = { ok: true, exit: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };',
      '      if (err && err.killed) payload.ok = false;',
      '      const bytes = Buffer.from(JSON.stringify(payload), "utf8").slice(0, workerData.cap);',
      '      Buffer.from(workerData.sab).set(bytes, 8);',
      '      const i32 = new Int32Array(workerData.sab);',
      '      Atomics.store(i32, 1, bytes.length);',
      '      Atomics.store(i32, 0, 1);',
      '      Atomics.notify(i32, 0);',
      '    });',
      '} catch (e) {',
      '    const bytes = Buffer.from(JSON.stringify({ ok: true, exit: -1, stdout: "", stderr: String(e.message) }), "utf8");',
      '    Buffer.from(workerData.sab).set(bytes, 8);',
      '    const i32 = new Int32Array(workerData.sab);',
      '    Atomics.store(i32, 1, bytes.length);',
      '    Atomics.store(i32, 0, 1);',
      '    Atomics.notify(i32, 0);',
      '}',
    ].join('\n');
    let worker;
    try {
      worker = new Worker(workerCode, { eval: true, workerData: { sab, cap: CAP, cmd, args: argList } });
    } catch (e) {
      return V.enumv('builtin-res', 'Err', [V.str('无法启动 exec worker: ' + e.message)]);
    }
    const int32 = new Int32Array(sab);
    const wr = Atomics.wait(int32, 0, 0, 60000);
    if (wr === 'timed-out') {
      worker.terminate();
      return V.enumv('builtin-res', 'Err', [V.str('exec 超时(60s): ' + cmd)]);
    }
    const len = Atomics.load(int32, 1);
    const text = len > 0 ? Buffer.from(sab, 8, len).toString('utf8') : '';
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      return V.enumv('builtin-res', 'Err', [V.str('exec:结果损坏')]);
    }
    if (parsed.exit === -1 && parsed.stderr) {
      return V.enumv('builtin-res', 'Err', [V.str('命令不存在或无法执行: ' + parsed.stderr)]);
    }
    return V.enumv('builtin-res', 'Ok', [V.tuple([
      V.int(BigInt(parsed.exit)),
      V.str(parsed.stdout),
      V.str(parsed.stderr),
    ])]);
  }

  // v0.32 发布期门禁:动态熔断
  // 内存配额:累计分配口径(估算,非 RSS)——Vec/Map 按元素、str 按字符计费;超限 M4011
  chargeAllocBytes(n, span) {
    if (n <= 0) return;
    this.allocBytes += n;
    if (this.allocBytes > this.maxAlloc) {
      throw new Panic('M4011', `内存配额超限:累计分配 ${this.allocBytes} 超过上限 ${this.maxAlloc}(用 --max-alloc 调整)`, span);
    }
  }

  // 时间熔断:墙钟超限 M4012(调用方按步数取模轮询,避免每步 Date.now 开销)
  checkTimeQuota(span) {
    if (this.maxMs !== Infinity && Date.now() - this.runStart > this.maxMs) {
      throw new Panic('M4012', `执行时间超过上限 ${this.maxMs}ms(用 --max-ms 调整)`, span);
    }
  }

  // std.log 输出(v0.28):达到阈值才写 stderr;日志只影响诊断流,不影响程序值
  logEmit(level, name, msg) {
    if (level >= this.logLevel) this.errOut.write('[' + name + '] ' + msg + '\n');
    return UNIT;
  }

  reCompile(pattern, flags) {
    const key = pattern + '\u0000' + flags;
    let re = this.reCache?.get(key);
    if (!re) {
      try { re = new RegExp(pattern, flags); }
      catch (e) { throw new Panic('M4001', '非法正则 pattern: ' + String(e.message), null); }
      this.reCache?.set(key, re);
    }
    return re;
  }

  cachedRe(pattern, flags) {
    const key = pattern + '\u0000' + flags;
    let re = this.reCache?.get(key);
    if (!re) {
      try { re = new RegExp(pattern, flags); }
      catch (e) { throw new Panic('M4001', '非法正则 pattern: ' + String(e.message), null); }
      this.reCache?.set(key, re);
    }
    return re;
  }

  randStep() {
    this.randState = (this.randState + 0x6D2B79F5n) & 0xFFFFFFFFn;
    let t = this.randState;
    t = ((t ^ (t >> 15n)) * (t | 1n)) & 0xFFFFFFFFn;
    t = (t ^ (t + ((t ^ (t >> 7n)) * (t | 61n)))) & 0xFFFFFFFFn;
    this.randState = (t ^ (t >> 14n)) & 0xFFFFFFFFn;
  }

  // ---------- 结构化并发(v0.14)----------
  // spawn(函数值, 参数?) → Join[T]:子任务在隔离子 VM(worker)中运行;
  // join(句柄) → Result[T, str]:Atomics 阻塞等待。深拷贝边界 = wire 序列化。
  syncSpawn(args, span) {
    const fnVal = args[0];
    // fnref(树引擎/模块函数值)与 vclose(VM 字节码 LDFN)两种形态;闭包拒绝
    let fnName, modFile;
    if (fnVal && fnVal.t === 'fnref') {
      fnName = fnVal.entry.decl.name;
      modFile = fnVal.mod.file;
    } else if (fnVal && fnVal.t === 'vclose' && this.compiled) {
      const wf = this.compiled.functions[fnVal.fnIdx];
      if (!wf || wf.local || wf.name === '<闭包>') throw new Panic('M4001', 'spawn 目标必须是模块级命名函数,不能是闭包', span);
      fnName = wf.entry.decl.name;
      modFile = wf.modFile;
    } else {
      throw new Panic('M4001', '内部错误:spawn 目标必须是模块命名函数值', span);
    }
    const entryPath = this.check.entry.absPath ?? this.check.entry.file;
    const argWires = args.slice(1).map(a => vToWire(a));
    const argWire = JSON.stringify(argWires); // JSON 数组(每参一个 wire)
    if (argWire.length > 32 * 1024 * 1024) {
      throw new Panic('M4001', 'spawn 参数序列化超过 32MB 上限', span);
    }
    const CAP = 32 * 1024 * 1024;
    const sab = new SharedArrayBuffer(8 + CAP);
    const workerCode = this.syncWorkerCode();
    let worker;
    try {
      worker = new Worker(workerCode, {
        eval: true,
        workerData: {
          sab, cap: CAP, argWire,
          fnName, modFile, entryPath,
          checkerUrl: SRC_URL('checker.js'),
          vmUrl: SRC_URL('vm.js'),
          interpUrl: SRC_URL('interp.js'),
          maxSteps: this.maxSteps === Infinity ? 500_000_000 : this.maxSteps,
          maxAlloc: this.maxAlloc,
          maxMs: this.maxMs === Infinity ? 3_600_000 : this.maxMs,
        },
      });
    } catch (e) {
      throw new Panic('M4001', '无法启动子任务 worker: ' + e.message, span);
    }
    const id = ++this.syncTaskSeq;
    this.syncTasks.set(id, { sab, worker });
    if (this.syncScopeStack.length) this.syncScopeStack[this.syncScopeStack.length - 1].tasks.push(id);
    return V.handle(id);
  }

  // spawn_all(fn, Vec[T]) -> Vec[Result[R, str]]:批量并行,接口不暴露句柄(与线性纪律自洽)
  syncSpawnAll(args, span) {
    const fnVal = args[0];
    const listV = args[1];
    let fnName, modFile;
    if (fnVal && fnVal.t === 'fnref') {
      fnName = fnVal.entry.decl.name;
      modFile = fnVal.mod.file;
    } else if (fnVal && fnVal.t === 'vclose' && this.compiled) {
      const wf = this.compiled.functions[fnVal.fnIdx];
      if (!wf || wf.local || wf.name === '<闭包>') throw new Panic('M4001', 'spawn_all 目标必须是模块级命名函数', span);
      fnName = wf.entry.decl.name;
      modFile = wf.modFile;
    } else {
      throw new Panic('M4001', '内部错误:spawn_all 目标必须是模块命名函数值', span);
    }
    const entryPath = this.check.entry.absPath ?? this.check.entry.file;
    const results = [];
    const tasks = [];
    for (const item of listV.a) {
      const argWire = JSON.stringify([vToWire(item)]);
      const CAP = 32 * 1024 * 1024;
      const sab = new SharedArrayBuffer(8 + CAP);
      const workerCode = this.syncWorkerCode();
      let worker;
      try {
        worker = new Worker(workerCode, {
          eval: true,
          workerData: {
            sab, cap: CAP, argWire, fnName, modFile, entryPath,
            checkerUrl: SRC_URL('checker.js'),
            vmUrl: SRC_URL('vm.js'),
            interpUrl: SRC_URL('interp.js'),
            maxSteps: this.maxSteps === Infinity ? 500_000_000 : this.maxSteps,
            maxAlloc: this.maxAlloc,
            maxMs: this.maxMs === Infinity ? 3_600_000 : this.maxMs,
          },
        });
      } catch (e) {
        tasks.push({ sab: null, worker: null, failed: e.message });
        continue;
      }
      tasks.push({ sab, worker });
    }
    // 启动完毕后逐个等待(后面的任务在等待前面时已并行运行)
    for (const task of tasks) {
      if (task.failed) { results.push(V.enumv('builtin-res', 'Err', [V.str('无法启动子任务 worker: ' + task.failed)])); continue; }
      const int32 = new Int32Array(task.sab);
      const wr = Atomics.wait(int32, 0, 0, 120000);
      if (wr === 'timed-out') {
        task.worker.terminate();
        results.push(V.enumv('builtin-res', 'Err', [V.str('join 超时(120s)')]));
        continue;
      }
      const len = Atomics.load(int32, 1);
      const text = len > 0 ? Buffer.from(task.sab, 8, len).toString('utf8') : '';
      try {
        const parsed = JSON.parse(text);
        if (!parsed.ok) results.push(V.enumv('builtin-res', 'Err', [V.str(String(parsed.error))]));
        else results.push(V.enumv('builtin-res', 'Ok', [wireToV(parsed.value)]));
      } catch {
        results.push(V.enumv('builtin-res', 'Err', [V.str('join:子任务结果损坏')]));
      }
      task.worker.terminate();
    }
    return V.vec(results);
  }

  // worker 启动代码抽出共用(spawn / spawn_all)
  syncWorkerCode() {
    return [
      "import { workerData, parentPort } from 'node:worker_threads';",
      "import * as nodeFs from 'node:fs';",
      'try {',
      "  const { Checker } = await import(workerData.checkerUrl);",
      "  const { VMInterp } = await import(workerData.vmUrl);",
      "  const { wireToV, vToWire } = await import(workerData.interpUrl);",
      "  const src = nodeFs.readFileSync(workerData.entryPath, 'utf8');",
      "  const checker = new Checker(workerData.entryPath, () => src);",
      '  const result = checker.run();',
      "  const errs = result.diags.filter(d => d.severity === 'error');",
      "  if (errs.length) throw new Error('子任务编译失败: ' + errs[0].message);",
      '  let target = null;',
      '  for (const m of result.modules) {',
      "    if (workerData.modFile && m.file !== workerData.modFile) continue;",
      "    const e = m.items.get(workerData.fnName);",
      "    if (e?.kind === 'fn') { target = { m, e }; break; }",
      '  }',
      '  if (!target) {',
      '    for (const m of result.modules) {',
      "      const e = m.items.get(workerData.fnName);",
      "      if (e?.kind === 'fn') { target = { m, e }; break; }",
      '    }',
      '  }',
      "  if (!target) throw new Error('子任务找不到函数 ' + workerData.fnName);",
      '  const interp = new VMInterp(result, { capture: true, maxSteps: workerData.maxSteps, maxAlloc: workerData.maxAlloc, maxMs: workerData.maxMs });',
      '  const argv = JSON.parse(workerData.argWire).map(wireToV);',
      '  const ret = interp.callUser(target.m, target.e, null, argv, target.e.decl?.span ?? null);',
      "  const out = JSON.stringify({ ok: true, value: vToWire(ret) });",
      '  flush(workerData, out);',
      '} catch (e) {',
      "  const isPanic = e && typeof e.code === 'string' && Array.isArray(e.stack);",
      '  const out = JSON.stringify({',
      '    ok: false,',
      '    error: String(e?.message ?? e),',
      "    code: isPanic ? e.code : 'M4001',",
      '    stack: isPanic ? e.stack.map(f => ({ name: f.name, file: f.span?.file ?? "?", line: f.span?.line ?? 0, col: f.span?.col ?? 0 })) : [],',
      '  });',
      '  try { flush(workerData, out); } catch { }',
      '}',
      'function flush(wd, text) {',
      '  const bytes = Buffer.from(text, "utf8");',
      '  const capped = bytes.slice(0, wd.cap);',
      '  Buffer.from(wd.sab).set(capped, 8);',
      '  const i32 = new Int32Array(wd.sab);',
      '  Atomics.store(i32, 1, capped.length);',
      '  Atomics.store(i32, 0, 1);',
      '  Atomics.notify(i32, 0);',
      "  parentPort.postMessage('done');",
      '}',
    ].join('\n');
  }

  syncJoin(args, span) {
    const h = args[0];
    if (!h || h.t !== 'handle') throw new Panic('M4001', '内部错误:join 目标必须是句柄', span);
    const task = this.syncTasks.get(h.id);
    if (!task) {
      return V.enumv('builtin-res', 'Err', [V.str('join:句柄 #' + h.id + ' 不存在或已 join 过')]);
    }
    if (task.cancelled) {
      this.syncTasks.delete(h.id);
      return V.enumv('builtin-res', 'Err', [V.str('任务已取消: #' + h.id)]);
    }
    this.syncTasks.delete(h.id);
    const int32 = new Int32Array(task.sab);
    const wr = Atomics.wait(int32, 0, 0, 120000);
    if (wr === 'timed-out') {
      task.worker.terminate();
      return V.enumv('builtin-res', 'Err', [V.str('join 超时(120s):任务 #' + h.id)]);
    }
    const len = Atomics.load(int32, 1);
    const text = len > 0 ? Buffer.from(task.sab, 8, len).toString('utf8') : '';
    let parsed;
    try { parsed = JSON.parse(text); } catch { return V.enumv('builtin-res', 'Err', [V.str('join:子任务结果损坏: ' + text.slice(0, 200))]); }
    if (!parsed.ok) return V.enumv('builtin-res', 'Err', [V.str(String(parsed.error))]);
    try {
      return V.enumv('builtin-res', 'Ok', [wireToV(parsed.value)]);
    } catch (e) {
      return V.enumv('builtin-res', 'Err', [V.str('join:结果反序列化失败 ' + e.message)]);
    }
  }

  // Vec[u8] → 写文件(v0.31 二进制雏形);返回 null = 成功,string = 错误消息
  u8VecToFile(path, val, mode) {
    if (!val || val.t !== 'vec') return 'write_bytes:第二个参数必须是 Vec[u8]';
    const buf = Buffer.alloc(val.a.length);
    for (let i = 0; i < val.a.length; i++) {
      const el = val.a[i];
      if (el.t !== 'int' || el.v < 0n || el.v > 255n) return 'write_bytes:元素 #' + i + ' 不在 u8 范围(0-255)';
      buf[i] = Number(el.v);
    }
    if (buf.length > 8 * 1024 * 1024) return 'write_bytes:超过 8MB 单文件上限';
    try {
      if (mode === 'append') nodeFs.appendFileSync(path, buf);
      else nodeFs.writeFileSync(path, buf);
      return null;
    } catch (e) {
      return String(e.message);
    }
  }

  // join_detailed(v0.30 错误链;v0.31 可选超时):Ok 与 join 相同;Err → Json {code, message, stack}——
  // 子任务 panic 的错误码与 Ming 层调用栈经 wire v2 保留,不再退化为纯消息字符串。
  // 超时:Err 码 M4010(任务超时),任务被硬杀(terminate)且句柄失效;cancel 后:Err M4010"任务已取消"。
  syncJoinDetailed(args, span) {
    const h = args[0];
    if (!h || h.t !== 'handle') throw new Panic('M4001', '内部错误:join_detailed 目标必须是句柄', span);
    let timeoutMs = 120000;
    if (args.length > 1) {
      timeoutMs = Number(args[1].v);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Panic('M4001', 'join_detailed 超时必须为正毫秒,得到: ' + String(args[1]?.v), span);
      }
      timeoutMs = Math.min(timeoutMs, 3_600_000);
    }
    const task = this.syncTasks.get(h.id);
    if (!task) {
      return V.enumv('builtin-res', 'Err', [this.panicInfoJson('M4001', 'join_detailed:句柄 #' + h.id + ' 不存在或已 join 过', [])]);
    }
    if (task.cancelled) {
      this.syncTasks.delete(h.id);
      return V.enumv('builtin-res', 'Err', [this.panicInfoJson('M4010', '任务已取消: #' + h.id, [])]);
    }
    this.syncTasks.delete(h.id);
    const int32 = new Int32Array(task.sab);
    const wr = Atomics.wait(int32, 0, 0, timeoutMs);
    if (wr === 'timed-out') {
      task.worker.terminate();
      return V.enumv('builtin-res', 'Err', [this.panicInfoJson('M4010', 'join_detailed 超时(' + timeoutMs + 'ms):任务 #' + h.id, [])]);
    }
    const len = Atomics.load(int32, 1);
    const text = len > 0 ? Buffer.from(task.sab, 8, len).toString('utf8') : '';
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      return V.enumv('builtin-res', 'Err', [this.panicInfoJson('M4001', 'join_detailed:子任务结果损坏: ' + text.slice(0, 200), [])]);
    }
    if (!parsed.ok) {
      const frames = Array.isArray(parsed.stack) ? parsed.stack : [];
      return V.enumv('builtin-res', 'Err', [this.panicInfoJson(String(parsed.code ?? 'M4001'), String(parsed.error), frames)]);
    }
    try {
      return V.enumv('builtin-res', 'Ok', [wireToV(parsed.value)]);
    } catch (e) {
      return V.enumv('builtin-res', 'Err', [this.panicInfoJson('M4001', 'join_detailed:结果反序列化失败 ' + e.message, [])]);
    }
  }

  // cancel(v0.31):硬杀子任务(terminate,不可捕获);句柄仍被跟踪 → join/join_detailed 得"任务已取消"
  syncCancel(args, span) {
    const h = args[0];
    if (!h || h.t !== 'handle') throw new Panic('M4001', '内部错误:cancel 目标必须是句柄', span);
    const task = this.syncTasks.get(h.id);
    if (!task) return V.bool(false);
    if (!task.cancelled) {
      task.cancelled = true;
      try { task.worker.terminate(); } catch { /* 已退出 */ }
    }
    return V.bool(true);
  }

  // 错误链 Json 形态:{code: str, message: str, stack: Vec[str]("at 名 (file:line:col)")}
  panicInfoJson(code, message, frames) {
    const m = new Map([
      ['code', V.json('str', code)],
      ['message', V.json('str', message)],
      ['stack', V.json('arr', frames.map(f => V.json('str', `at ${f.name} (${f.file}:${f.line}:${f.col})`)))],
    ]);
    return V.json('obj', m);
  }

  // ---------- scoped 并发块(v0.17)----------
  enterSyncScope() {
    const frame = { tasks: [] };
    this.syncScopeStack.push(frame);
    return frame;
  }

  // swallow=true:正在异常展开,子任务错误吞掉;false:正常退出,子任务 panic 向上抛
  exitSyncScope(swallow, span) {
    const frame = this.syncScopeStack.pop();
    if (!frame) return;
    for (const id of frame.tasks) {
      const task = this.syncTasks.get(id);
      if (!task) continue; // 已显式 join
      if (task.cancelled) { this.syncTasks.delete(id); continue; } // v0.31:已取消的任务不再等待(terminate 后 SAB 永不写)
      this.syncTasks.delete(id);
      const int32 = new Int32Array(task.sab);
      const wr = Atomics.wait(int32, 0, 0, 120000);
      if (wr === 'timed-out') {
        task.worker.terminate();
        if (!swallow) throw new Panic('M4001', 'scoped 子任务 join 超时(120s)', span);
        continue;
      }
      const len = Atomics.load(int32, 1);
      const text = len > 0 ? Buffer.from(task.sab, 8, len).toString('utf8') : '';
      let parsed;
      try { parsed = JSON.parse(text); } catch { continue; }
      if (!parsed.ok && !swallow) {
        // v0.30 错误链:子任务真实 panic 码透传(不再硬编码 M4001),原始栈作 cause
        const p = new Panic(String(parsed.code ?? 'M4001'), 'scoped 子任务失败: ' + String(parsed.error), span);
        p.cause = {
          code: String(parsed.code ?? 'M4001'),
          message: String(parsed.error),
          stack: Array.isArray(parsed.stack) ? parsed.stack : [],
        };
        throw p;
      }
    }
  }

  drainAllSyncScopes() {
    while (this.syncScopeStack.length) {
      try { this.exitSyncScope(true, null); } catch { /* 吞掉:正在展开 */ }
    }
  }

  // 同步 HTTP GET:worker 线程内 fetch,主线程 Atomics.wait 阻塞,响应经 SharedArrayBuffer 传回。
  // 限制:响应体上限 8MB(超出截断,utf8 断字以替换符容错);固定 35s 总超时。
  // http_get = httpRequest('GET', url, null, '')
  // 统一 HTTP 执行(v0.27):超时/重定向可配;响应头经 JS 对象直传(JS VM 路径)
  httpOpts(o, span) {
    const CAP = 8 * 1024 * 1024;
    const HCAP = 64 * 1024;
    const sab = new SharedArrayBuffer(8 + CAP + HCAP);
    const workerCode = [
      "import { workerData, parentPort } from 'node:worker_threads';",
      '(async () => {',
      '  try {',
      '    const ctrl = new AbortController();',
      '    const timer = setTimeout(() => ctrl.abort(), workerData.timeoutMs);',
      "    const init = { method: workerData.method, redirect: workerData.redirect, signal: ctrl.signal };",
      '    if (Object.keys(workerData.headers).length) init.headers = workerData.headers;',
      "    if (workerData.body !== '' && workerData.method !== 'GET' && workerData.method !== 'HEAD') init.body = workerData.body;",
      '    const resp = await fetch(workerData.url, init);',
      '    const status = resp.status;',
      '    const respHeaders = {};',
      "    resp.headers.forEach((v, k) => { respHeaders[k] = v; });",
      "    const bytes = Buffer.from(await resp.text(), 'utf8');",
      '    const capped = bytes.slice(0, workerData.cap);',
      '    const hb = Buffer.from(JSON.stringify(respHeaders), "utf8");',
      '    Buffer.from(workerData.sab).set(capped, 12);',
      '    Buffer.from(workerData.sab).set(hb.slice(0, workerData.hcap), 8 + workerData.cap);',
      '    const i32 = new Int32Array(workerData.sab);',
      '    Atomics.store(i32, 0, status);',
      '    Atomics.store(i32, 1, capped.length);',
      '    Atomics.store(i32, 2, Math.min(hb.length, workerData.hcap));',
      '    clearTimeout(timer);',
      '  } catch (e) {',
      '    const msg = Buffer.from("E:" + e.message, "utf8").slice(0, 500);',
      '    Buffer.from(workerData.sab).set(msg, 8);',
      '    const i32e = new Int32Array(workerData.sab);',
      '    Atomics.store(i32e, 0, -1);',
      '    Atomics.store(i32e, 1, msg.length);',
      '  }',
      '  Atomics.notify(new Int32Array(workerData.sab), 0);',
      "  parentPort.postMessage('done');",
      '})();',
    ].join('\n');
    let worker;
    try {
      worker = new Worker(workerCode, { eval: true, workerData: { sab, cap: CAP, hcap: HCAP, url: o.url, method: o.method, headers: o.headers, body: o.body, timeoutMs: o.timeoutMs, redirect: o.redirect } });
    } catch (e) {
      return V.enumv('builtin-res', 'Err', [V.str('无法启动 HTTP worker: ' + e.message)]);
    }
    const int32 = new Int32Array(sab);
    const waitMs = Math.max(1000, o.timeoutMs + 5000);
    const waitResult = Atomics.wait(int32, 0, 0, waitMs);
    if (waitResult === 'timed-out') {
      worker.terminate();
      return V.enumv('builtin-res', 'Err', [V.str('请求超时(' + Math.round(o.timeoutMs / 1000) + 's): ' + o.url)]);
    }
    const status = Atomics.load(int32, 0);
    if (status < 0) {
      const elen = Atomics.load(int32, 1);
      const emsg = elen > 0 ? Buffer.from(sab, 8, elen).toString('utf8').replace(/^E:/, '') : o.url;
      return V.enumv('builtin-res', 'Err', [V.str(emsg)]);
    }
    const len = Atomics.load(int32, 1);
    const hlen = Atomics.load(int32, 2);
    const body = Buffer.from(sab, 12, len).toString('utf8');
    const hdrJson = hlen > 0 ? Buffer.from(sab, 8 + CAP, hlen).toString('utf8') : '{}';
    const headersMap = new Map();
    for (const [k, v] of Object.entries(JSON.parse(hdrJson))) headersMap.set(k, V.str(v));
    if (o.withHeaders) {
      return V.enumv('builtin-res', 'Ok', [V.tuple([V.int(BigInt(status)), V.map(headersMap), V.str(body)])]);
    }
    return V.enumv('builtin-res', 'Ok', [V.tuple([V.int(BigInt(status)), V.str(body)])]);
  }

  httpRequest(method, url, headersVal, body, span) {
    const CAP = 8 * 1024 * 1024;
    const sab = new SharedArrayBuffer(8 + CAP);
    // headers: Map[str, str] → 普通对象传给 worker
    const headersObj = {};
    if (headersVal && headersVal.t === 'map') {
      for (const [k, v] of headersVal.m) headersObj[String(k)] = String(v.v);
    }
    const workerCode = [
      "import { workerData, parentPort } from 'node:worker_threads';",
      '(async () => {',
      '  try {',
      '    const ctrl = new AbortController();',
      '    const timer = setTimeout(() => ctrl.abort(), 30000);',
      '    const init = { method: workerData.method, redirect: \'follow\', signal: ctrl.signal };',
      '    if (Object.keys(workerData.headers).length) init.headers = workerData.headers;',
      "    if (workerData.body !== '' && workerData.method !== 'GET' && workerData.method !== 'HEAD') init.body = workerData.body;",
      '    const resp = await fetch(workerData.url, init);',
      '    const status = resp.status;',
      "    const bytes = Buffer.from(await resp.text(), 'utf8');",
      '    const capped = bytes.slice(0, workerData.cap);',
      '    Buffer.from(workerData.sab).set(capped, 8);',
      '    const i32 = new Int32Array(workerData.sab);',
      '    Atomics.store(i32, 0, status);',
      '    Atomics.store(i32, 1, capped.length);',
      '    clearTimeout(timer);',
      '  } catch (e) {',
      '    const msg = Buffer.from("E:" + e.message, "utf8").slice(0, 500);',
      '    Buffer.from(workerData.sab).set(msg, 8);',
      '    const i32e = new Int32Array(workerData.sab);',
      '    Atomics.store(i32e, 0, -1);',
      '    Atomics.store(i32e, 1, msg.length);',
      '  }',
      '  Atomics.notify(new Int32Array(workerData.sab), 0);',
      "  parentPort.postMessage('done');",
      '})();',
    ].join('\n');
    let worker;
    try {
      worker = new Worker(workerCode, { eval: true, workerData: { sab, url, cap: CAP, method, headers: headersObj, body } });
    } catch (e) {
      return V.enumv('builtin-res', 'Err', [V.str('无法启动 HTTP worker: ' + e.message)]);
    }
    const int32 = new Int32Array(sab);
    const waitResult = Atomics.wait(int32, 0, 0, 35000);
    if (waitResult === 'timed-out') {
      worker.terminate();
      return V.enumv('builtin-res', 'Err', [V.str('请求超时(35s): ' + url)]);
    }
    const status = Atomics.load(int32, 0);
    if (status < 0) {
      const elen = Atomics.load(int32, 1);
      const emsg = elen > 0 ? Buffer.from(sab, 8, elen).toString('utf8').replace(/^E:/, '') : url;
      return V.enumv('builtin-res', 'Err', [V.str(emsg)]);
    }
    const len = Atomics.load(int32, 1);
    const bodyOut = Buffer.from(sab, 8, len).toString('utf8');
    return V.enumv('builtin-res', 'Ok', [V.tuple([V.int(BigInt(status)), V.str(bodyOut)])]);
  }

  // ---------- 方法 ----------
  callMethod(recv, name, args, fieldCallee, callNode, env) {
    const span = callNode.span;
    switch (recv.t) {
      case 'vec': return this.vecMethodImpl(recv, name, args, span);
      case 'map': return this.mapMethodImpl(recv, name, args, span);
      case 'str': return this.strMethodImpl(recv, name, args, span);
      case 'json': return this.jsonMethodImpl(recv, name, args, span);
      case 'enum': {
        // 用户方法(trait impl):self 直接传入(mut self 的修改要生效)
        const mEntry = this.methodImpls?.get(recv.def)?.get(name);
        if (mEntry) return this.callUser(mEntry.mod, mEntry, null, [recv, ...args], span, true);
        return this.enumMethodImpl(recv, name, args, span);
      }
      case 'struct': {
        const mEntry = this.methodImpls?.get(recv.def)?.get(name);
        if (mEntry) return this.callUser(mEntry.mod, mEntry, null, [recv, ...args], span, true);
        throw new Panic('M4001', `内部错误:${recv.name} 没有方法 .${name}`, span);
      }
      case 'bool': return this.boolMethodImpl(recv, name, args, span);
      case 'int': case 'float': return this.numMethodImpl(recv, name, args, span);
      default:
        throw new Panic('M4001', `内部错误:${recv.t} 没有方法 .${name}`, span);
    }
  }

  vecMethodImpl(recv, name, args, span) {
    const a = recv.a;
    switch (name) {
      case 'len': return V.int(BigInt(a.length));
      case 'is_empty': return V.bool(a.length === 0);
      case 'push':
        this.chargeAllocBytes(1, span);
        a.push(args[0]);
        return UNIT;
      case 'pop': return a.length ? V.enumv('builtin-opt', 'Some', [a.pop()]) : V.enumv('builtin-opt', 'None', []);
      case 'get': {
        const i = Number(args[0].v);
        if (!Number.isInteger(i) || i < 0 || i >= a.length) return V.enumv('builtin-opt', 'None', []);
        return V.enumv('builtin-opt', 'Some', [a[i]]);
      }
      case 'first': return a.length ? V.enumv('builtin-opt', 'Some', [a[0]]) : V.enumv('builtin-opt', 'None', []);
      case 'last': return a.length ? V.enumv('builtin-opt', 'Some', [a[a.length - 1]]) : V.enumv('builtin-opt', 'None', []);
      case 'contains': return V.bool(a.some(x => valueEquals(x, args[0])));
      case 'index_of': {
        const i = a.findIndex(x => valueEquals(x, args[0]));
        return i === -1 ? V.enumv('builtin-opt', 'None', []) : V.enumv('builtin-opt', 'Some', [V.int(BigInt(i))]);
      }
      case 'reverse': a.reverse(); return UNIT;
      case 'clear': a.length = 0; return UNIT;
      // v0.31 二进制雏形:Vec[u8] → str(UTF-8 解码,无效序列 → U+FFFD;纯函数)
      case 'to_str': {
        const buf = Buffer.alloc(a.length);
        for (let i = 0; i < a.length; i++) {
          const el = a[i];
          if (el.t !== 'int' || el.v < 0n || el.v > 255n) {
            throw new Panic('M4001', `to_str:元素 #${i} 不在 u8 范围(0-255)`, span);
          }
          buf[i] = Number(el.v);
        }
        return V.str(buf.toString('utf8'));
      }
      case 'sort': {
        const first = a[0];
        if (first && (first.t === 'int' || first.t === 'float')) a.sort((x, y) => (x.v < y.v ? -1 : x.v > y.v ? 1 : 0));
        else if (first && first.t === 'str') a.sort((x, y) => (x.v < y.v ? -1 : x.v > y.v ? 1 : 0));
        else throw new Panic('M4001', 'sort:元素不支持排序', span);
        return UNIT;
      }
      case 'sort_by': {
        const cmp = args[0];
        a.sort((x, y) => Number(this.callClosure(cmp, [x, y], span).v));
        return UNIT;
      }
      case 'map': {
        const f = args[0];
        const out = a.map(x => this.callClosure(f, [x], span));
        this.chargeAllocBytes(out.length, span);
        return V.vec(out);
      }
      case 'filter': {
        const f = args[0];
        const out = a.filter(x => this.callClosure(f, [x], span).v);
        this.chargeAllocBytes(out.length, span);
        return V.vec(out);
      }
      case 'fold': {
        let acc = args[0];
        const f = args[1];
        for (const x of a) acc = this.callClosure(f, [acc, x], span);
        return acc;
      }
      case 'join': {
        const out = V.str(a.map(x => displayStr(x)).join(args[0].v));
        this.chargeAllocBytes(out.v.length, span);
        return out;
      }
      case 'slice': {
        const s = Number(args[0].v), e2 = Number(args[1].v);
        if (!Number.isInteger(s) || !Number.isInteger(e2) || s < 0 || e2 < s || e2 > a.length) {
          throw new Panic('M4003', `slice 越界:请求 [${s}, ${e2}),长度 ${a.length}`, span);
        }
        this.chargeAllocBytes(e2 - s, span);
        return V.vec(a.slice(s, e2));
      }
      case 'insert': {
        const i = Number(args[0].v);
        if (!Number.isInteger(i) || i < 0 || i > a.length) throw new Panic('M4003', `insert 索引越界:长度 ${a.length},插入点 ${i}`, span);
        a.splice(i, 0, args[1]);
        this.chargeAllocBytes(1, span);
        return UNIT;
      }
      case 'remove': {
        const i = Number(args[0].v);
        if (!Number.isInteger(i) || i < 0 || i >= a.length) throw new Panic('M4003', `remove 索引越界:长度 ${a.length},删除点 ${i}`, span);
        return a.splice(i, 1)[0];
      }
      case 'extend':
        this.chargeAllocBytes(args[0].a.length, span);
        for (const x of args[0].a) a.push(x);
        return UNIT;
      case 'clone':
        this.chargeAllocBytes(a.length, span);
        return deepCopy(recv);
      case 'min': case 'max': {
        if (a.length === 0) return V.enumv('builtin-opt', 'None', []);
        let best = a[0];
        for (let i = 1; i < a.length; i++) {
          const c = cmpScalar(a[i], best);
          if ((name === 'min' && c < 0) || (name === 'max' && c > 0)) best = a[i];
        }
        return V.enumv('builtin-opt', 'Some', [best]);
      }
      default: throw new Panic('M4001', `内部错误:Vec.${name}`, span);
    }
  }

  mapMethodImpl(recv, name, args, span) {
    const m = recv.m;
    switch (name) {
      case 'len': return V.int(BigInt(m.size));
      case 'is_empty': return V.bool(m.size === 0);
      case 'get': {
        const k = normKey(args[0]);
        return m.has(k) ? V.enumv('builtin-opt', 'Some', [m.get(k)]) : V.enumv('builtin-opt', 'None', []);
      }
      case 'set': {
        const k = normKey(args[0]);
        if (!m.has(k)) this.chargeAllocBytes(1, span);
        m.set(k, args[1]);
        return UNIT;
      }
      case 'has': return V.bool(m.has(normKey(args[0])));
      case 'delete': return V.bool(m.delete(normKey(args[0])));
      case 'keys': return V.vec([...m.keys()].map(keyValue));
      case 'values': return V.vec([...m.values()]);
      case 'items': return V.vec([...m.entries()].map(([k, v]) => V.tuple([keyValue(k), v])));
      case 'clear': m.clear(); return UNIT;
      case 'clone': return deepCopy(recv);
      default: throw new Panic('M4001', `内部错误:Map.${name}`, span);
    }
  }

  strMethodImpl(recv, name, args, span) {
    const s = recv.v;
    switch (name) {
      case 'eq': return V.bool(valueEquals(recv, args[0]));
      case 'cmp': return V.int(BigInt(cmpScalar(recv, args[0])));
      case 'to_str': return V.str(s);
      case 'char_len': return V.int(BigInt([...s].length));
      case 'byte_len': return V.int(BigInt(Buffer.byteLength(s, 'utf8')));
      case 'chars': return V.vec([...s].map(c => V.str(c)));
      case 'bytes': return V.vec([...Buffer.from(s, 'utf8')].map(b => V.int(BigInt(b), 8, false)));
      case 'split': return V.vec(s.split(args[0].v).map(x => V.str(x)));
      case 'trim': return V.str(s.trim());
      case 'trim_start': return V.str(s.replace(/^\s+/, ''));
      case 'trim_end': return V.str(s.replace(/\s+$/, ''));
      case 'to_upper': return V.str(s.toUpperCase());
      case 'to_lower': return V.str(s.toLowerCase());
      case 'starts_with': return V.bool(s.startsWith(args[0].v));
      case 'ends_with': return V.bool(s.endsWith(args[0].v));
      case 'contains': return V.bool(s.includes(args[0].v));
      case 'replace': {
        const out = V.str(s.split(args[0].v).join(args[1].v));
        this.chargeAllocBytes(out.v.length, span);
        return out;
      }
      case 'repeat': {
        const n = Number(args[0].v);
        if (n < 0 || s.length * n > 10_000_000) throw new Panic('M4001', 'repeat:次数非法或结果过大', span);
        this.chargeAllocBytes(s.length * n, span);
        return V.str(s.repeat(n));
      }
      case 'get': {
        const chars = [...s];
        const i = Number(args[0].v);
        if (!Number.isInteger(i) || i < 0 || i >= chars.length) return V.enumv('builtin-opt', 'None', []);
        return V.enumv('builtin-opt', 'Some', [V.str(chars[i])]);
      }
      case 'slice_chars': {
        const chars = [...s];
        const a0 = Number(args[0].v), b0 = Number(args[1].v);
        if (!Number.isInteger(a0) || !Number.isInteger(b0) || a0 < 0 || b0 < a0 || b0 > chars.length) {
          throw new Panic('M4003', `slice_chars 越界:请求 [${a0}, ${b0}),字符数 ${chars.length}`, span);
        }
        return V.str(chars.slice(a0, b0).join(''));
      }
      case 'parse_i64': {
        const t = s.trim();
        if (/^[+-]?\d+$/.test(t)) {
          const v = BigInt(t);
          if (v >= -(2n ** 63n) && v < 2n ** 63n) return V.enumv('builtin-res', 'Ok', [V.int(v)]);
          return V.enumv('builtin-res', 'Err', [V.str(`超出 i64 范围: ${t}`)]);
        }
        return V.enumv('builtin-res', 'Err', [V.str(`不是有效的整数: "${t}"`)]);
      }
      case 'parse_f64': {
        const x = Number(s.trim());
        if (s.trim() !== '' && !Number.isNaN(x)) return V.enumv('builtin-res', 'Ok', [V.float(x)]);
        return V.enumv('builtin-res', 'Err', [V.str(`不是有效的浮点数: "${s.trim()}"`)]);
      }
      case 'is_empty': return V.bool(s === '');
      case 'is_alpha': return V.bool(s.length > 0 && /^\p{L}+$/u.test(s));
      case 'is_digit': return V.bool(s.length > 0 && /^\p{Nd}+$/u.test(s));
      case 'is_space': return V.bool(s.length > 0 && /^\s+$/u.test(s));
      case 'is_upper': return V.bool(s.length > 0 && /\p{L}/u.test(s) && s === s.toUpperCase());
      case 'is_lower': return V.bool(s.length > 0 && /\p{L}/u.test(s) && s === s.toLowerCase());
      case 'pad_left': return V.str(s.padStart(Number(args[0].v), ' '));
      case 'pad_right': return V.str(s.padEnd(Number(args[0].v), ' '));
      // v0.31 二进制雏形:UTF-8 编码(纯函数;解码见 Vec[u8].to_str)
      case 'to_bytes': {
        const buf = Buffer.from(s, 'utf8');
        this.chargeAllocBytes(buf.length, span);
        return V.vec([...buf].map(b => V.int(BigInt(b), 8, false)));
      }
      default: throw new Panic('M4001', `内部错误:str.${name}`, span);
    }
  }

  enumMethodImpl(recv, name, args, span) {
    // Option / Result
    const isOpt = recv.def === 'builtin-opt';
    const isRes = recv.def === 'builtin-res';
    if (isOpt) {
      const some = recv.tag === 'Some';
      switch (name) {
        case 'is_some': return V.bool(some);
        case 'is_none': return V.bool(!some);
        case 'unwrap': case 'expect':
          if (!some) throw new Panic('M4006', name === 'expect' ? `expect 失败: ${args[0].v}` : '对 None 调用 unwrap()', span);
          return recv.vals[0];
        case 'unwrap_or': return some ? recv.vals[0] : args[0];
        default: throw new Panic('M4001', `内部错误:Option.${name}`, span);
      }
    }
    if (isRes) {
      const ok = recv.tag === 'Ok';
      switch (name) {
        case 'is_ok': return V.bool(ok);
        case 'is_err': return V.bool(!ok);
        case 'unwrap': case 'expect':
          if (!ok) throw new Panic('M4006', name === 'expect' ? `expect 失败: ${recv.vals[0].v}` : `对 Err(${displayStr(recv.vals[0])}) 调用 unwrap()`, span);
          return recv.vals[0];
        case 'unwrap_err':
          if (ok) throw new Panic('M4006', `对 Ok(${displayStr(recv.vals[0])}) 调用 unwrap_err()`, span);
          return recv.vals[0];
        case 'unwrap_or': return ok ? recv.vals[0] : args[0];
        default: throw new Panic('M4001', `内部错误:Result.${name}`, span);
      }
    }
    throw new Panic('M4001', `内部错误:枚举 ${recv.name} 没有方法 .${name}`, span);
  }

  boolMethodImpl(recv, name, args, span) {
    switch (name) {
      case 'eq': return V.bool(valueEquals(recv, args[0]));
      case 'to_str': return V.str(displayStr(recv));
      default: throw new Panic('M4001', `内部错误:bool.${name}`, span);
    }
  }

  numMethodImpl(recv, name, args, span) {
    if (recv.t === 'int') {
      switch (name) {
        case 'eq': return V.bool(valueEquals(recv, args[0]));
        case 'cmp': return V.int(BigInt(cmpScalar(recv, args[0])));
        case 'to_str': return V.str(displayStr(recv));
        case 'abs': return V.int(recv.v < 0n ? -recv.v : recv.v, recv.bits, recv.signed);
        case 'to_f32': return V.float(Number(recv.v), 32);
        case 'to_f64': return V.float(Number(recv.v), 64);
        default: return this.intToImpl(recv, name, span);
      }
    }
    switch (name) {
      case 'eq': return V.bool(valueEquals(recv, args[0]));
      case 'cmp': return V.int(BigInt(cmpScalar(recv, args[0])));
      case 'to_str': return V.str(displayStr(recv));
      case 'abs': return V.float(Math.abs(recv.v), recv.bits);
      case 'to_fixed': return V.str(recv.v.toFixed(Number(args[0].v)));
      case 'to_f32': return V.float(recv.v, 32);
      case 'to_f64': return V.float(recv.v, 64);
      case 'is_nan': return V.bool(Number.isNaN(recv.v));
      case 'is_infinite': return V.bool(!Number.isFinite(recv.v) && !Number.isNaN(recv.v));
      default: {
        // float → int 安全转换
        const targets = { to_i8: INT_TYPES.i8, to_i16: INT_TYPES.i16, to_i32: INT_TYPES.i32, to_i64: INT_TYPES.i64, to_u8: INT_TYPES.u8, to_u16: INT_TYPES.u16, to_u32: INT_TYPES.u32, to_u64: INT_TYPES.u64 };
        if (targets[name]) {
          const t = targets[name];
          if (Number.isNaN(recv.v) || !Number.isFinite(recv.v)) return V.enumv('builtin-opt', 'None', []);
          const trunc = BigInt(Math.trunc(recv.v));
          if (!fits(trunc, t.bits, t.signed)) return V.enumv('builtin-opt', 'None', []);
          return V.enumv('builtin-opt', 'Some', [V.int(trunc, t.bits, t.signed)]);
        }
        throw new Panic('M4001', `内部错误:float.${name}`, span);
      }
    }
  }

  intToImpl(recv, name, span) {
    const targets = { to_i8: INT_TYPES.i8, to_i16: INT_TYPES.i16, to_i32: INT_TYPES.i32, to_i64: INT_TYPES.i64, to_u8: INT_TYPES.u8, to_u16: INT_TYPES.u16, to_u32: INT_TYPES.u32, to_u64: INT_TYPES.u64 };
    if (targets[name]) {
      const t = targets[name];
      if (!fits(recv.v, t.bits, t.signed)) return V.enumv('builtin-opt', 'None', []);
      return V.enumv('builtin-opt', 'Some', [V.int(recv.v, t.bits, t.signed)]);
    }
    throw new Panic('M4001', `内部错误:int.${name}`, span);
  }

  // ---------- 运算 ----------
  binopValues(op, l, r, span) {
    switch (op) {
      case '+': case '-': case '*': case '/': case '%': case '<<': case '>>': case '&': case '|': case '^': {
        if (l.t === 'int' && r.t === 'int') return intBin(op, l, r, span);
        if (l.t === 'float' && r.t === 'float') {
          switch (op) {
            case '+': return V.float(l.v + r.v, l.bits);
            case '-': return V.float(l.v - r.v, l.bits);
            case '*': return V.float(l.v * r.v, l.bits);
            case '/': return V.float(l.v / r.v, l.bits);
          }
        }
        if (op === '+' && l.t === 'str' && r.t === 'str') {
          this.chargeAllocBytes(l.v.length + r.v.length, span);
          return V.str(l.v + r.v);
        }
        throw new Panic('M3008', `运算符 "${op}" 不支持 ${l.t} 与 ${r.t}`, span);
      }
      case '==': return V.bool(valueEquals(l, r));
      case '!=': return V.bool(!valueEquals(l, r));
      case '<': case '<=': case '>': case '>=': {
        const cmp = compareValues(l, r, span);
        switch (op) {
          case '<': return V.bool(cmp < 0);
          case '<=': return V.bool(cmp <= 0);
          case '>': return V.bool(cmp > 0);
          case '>=': return V.bool(cmp >= 0);
        }
        break;
      }
      default:
        throw new Panic('M4001', `内部错误:运算符 ${op}`, span);
    }
  }

  castValue(v, typeAst, span) {
    const tn = typeAst.nt === 'TName' ? typeAst.name.split('.').pop() : null;
    const target = tn ? PRIM_TYPES[tn] : null;
    if (!target) throw new Panic('M4001', '内部错误:as 目标类型', span);
    if (target.k === 'float') {
      if (v.t === 'int') return V.float(Number(v.v), target.bits);
      if (v.t === 'float') return V.float(v.v, target.bits);
    }
    if (target.k === 'int') {
      if (v.t === 'float') {
        if (!Number.isFinite(v.v)) {
          return V.int(target.signed ? (v.v > 0 ? (1n << BigInt(target.bits - 1)) - 1n : -(1n << BigInt(target.bits - 1))) : (v.v > 0 ? (1n << BigInt(target.bits)) - 1n : 0n), target.bits, target.signed);
        }
        const trunc = BigInt(Math.trunc(v.v));
        return clampInt(trunc, target);
      }
      if (v.t === 'int') {
        // 位截断(与 Rust as 语义一致)
        const src = BigInt(v.v);
        const mask = (1n << BigInt(target.bits)) - 1n;
        let bits = ((src % (mask + 1n)) + mask + 1n) % (mask + 1n);
        if (target.signed && bits >= (1n << BigInt(target.bits - 1))) bits -= (1n << BigInt(target.bits));
        return V.int(bits, target.bits, target.signed);
      }
    }
    throw new Panic('M3008', `"as" 不支持 ${v.t} → ${tn}`, span);
  }
}

function clampInt(v, t) {
  const min = t.signed ? -(1n << BigInt(t.bits - 1)) : 0n;
  const max = t.signed ? (1n << BigInt(t.bits - 1)) - 1n : (1n << BigInt(t.bits)) - 1n;
  if (v < min) v = min;
  if (v > max) v = max;
  return V.int(v, t.bits, t.signed);
}

function cmpScalar(l, r) {
  const c = compareValues(l, r, null);
  return c < 0 ? -1 : c > 0 ? 1 : 0;
}

function compareValues(l, r, span) {
  if (l.t === 'int' && r.t === 'int') return l.v < r.v ? -1 : l.v > r.v ? 1 : 0;
  if (l.t === 'float' && r.t === 'float') return l.v < r.v ? -1 : l.v > r.v ? 1 : 0;
  if (l.t === 'str' && r.t === 'str') return l.v < r.v ? -1 : l.v > r.v ? 1 : 0;
  throw new Panic('M3008', `不能比较 ${l.t} 与 ${r.t}`, span);
}

function asF64(v) {
  if (v.t === 'float') return v.v;
  if (v.t === 'int') return Number(v.v);
  throw new Panic('M3008', '需要浮点数参数');
}

// ===================== 内置函数实现(参数向量形式,树遍历与 VM 两引擎共用)=====================

export const BUILTIN_IMPLS = {
  print(host, args) {
    host.write(displayStr(args[0]) + '\n');
    return UNIT;
  },
  eprint(host, args) {
    host.writeErr(displayStr(args[0]) + '\n');
    return UNIT;
  },
  str(host, args) {
    return V.str(displayStr(args[0]));
  },
  debug(host, args) {
    return V.str(debugStr(args[0]));
  },
  assert(host, args, span) {
    if (!args[0].v) {
      throw new Panic('M4008', args[1] ? args[1].v : '断言失败', span);
    }
    return UNIT;
  },
  assert_eq(host, args, span) {
    if (!valueEquals(args[0], args[1])) {
      throw new Panic('M4008', `assert_eq 失败:左 = ${debugStr(args[0])},右 = ${debugStr(args[1])}`, span);
    }
    return UNIT;
  },
  panic(host, args, span) {
    throw new Panic('M4001', args[0].v, span);
  },
};

// 闭包创建时对环境链做深拷贝快照(值语义:捕获后与外部脱钩)
// ---------- 任务边界 wire 序列化(v0.14)----------
// 支持跨任务类型:int/u64/float/bool/str/unit/Json/Vec/Map(递归)、Option/Result(标量成分);
// 不支持:struct/enum(用户)/闭包/函数值/句柄(结构含 AST 引用,克隆后身份失效)。
export function vToWire(v) {
  switch (v.t) {
    case 'int': return { w: 'int', bits: v.bits, signed: v.signed, v: v.v.toString() };
    case 'float': return { w: 'float', v: v.v };
    case 'bool': return { w: 'bool', v: v.v };
    case 'str': return { w: 'str', v: v.v };
    case 'unit': return { w: 'unit' };
    case 'json': return { w: 'json', kind: v.kind, v: jsonWireOf(v) };
    case 'vec': return { w: 'vec', a: v.a.map(vToWire) };
    case 'map': return { w: 'map', e: [...v.m.entries()].map(([k, val]) => [wireKey(k), vToWire(val)]) };
    case 'enum': {
      if (v.def === 'builtin-opt') {
        return { w: 'opt', some: v.tag === 'Some', v: v.vals.length ? vToWire(v.vals[0]) : null };
      }
      if (v.def === 'builtin-res') {
        return { w: 'res', ok: v.tag === 'Ok', v: v.vals.length ? vToWire(v.vals[0]) : null };
      }
      throw new Error('用户枚举不能跨任务传递');
    }
    case 'tuple': return { w: 'tuple', a: v.a.map(vToWire) };
    default:
      throw new Error(v.t + ' 不能跨任务传递');
  }
}

function jsonWireOf(v) {
  switch (v.kind) {
    case 'null': return null;
    case 'bool': case 'num': case 'str': return v.v;
    case 'arr': return v.v.map(x => jsonWireOf(x));
    case 'obj': { const o = {}; for (const [k, val] of v.v) o[k] = jsonWireOf(val); return o; }
    default: return null;
  }
}

function wireKey(k) {
  if (typeof k === 'bigint') return { w: 'int', v: k.toString() };
  if (typeof k === 'boolean') return { w: 'bool', v: k };
  if (typeof k === 'number') return { w: 'float', v: k };
  return { w: 'str', v: k };
}

export function wireToV(w) {
  switch (w.w) {
    case 'int': return V.int(BigInt(w.v), w.bits, w.signed);
    case 'float': return V.float(w.v, 64);
    case 'bool': return V.bool(w.v);
    case 'str': return V.str(w.v);
    case 'unit': return UNIT;
    case 'json': return { t: 'json', kind: w.kind, v: jsonUnwire(w.kind, w.v) };
    case 'vec': return V.vec(w.a.map(wireToV));
    case 'map': {
      const m = new Map();
      for (const [k, val] of w.e) m.set(unwireKey(k), wireToV(val));
      return V.map(m);
    }
    case 'opt': return w.some ? V.enumv('builtin-opt', 'Some', [wireToV(w.v)]) : V.enumv('builtin-opt', 'None', []);
    case 'res': return w.ok ? V.enumv('builtin-res', 'Ok', [wireToV(w.v)]) : V.enumv('builtin-res', 'Err', [wireToV(w.v)]);
    case 'tuple': return V.tuple(w.a.map(wireToV));
    default: throw new Error('未知 wire 类型 ' + w.w);
  }
}

function jsonUnwire(kind, v) {
  switch (kind) {
    case 'null': return V.json('null', null);
    case 'bool': return V.json('bool', v);
    case 'num': return V.json('num', v);
    case 'str': return V.json('str', v);
    case 'arr': return V.json('arr', v.map(x => jsonUnwire(kindOfJson(x), x)));
    case 'obj': {
      const m = new Map();
      for (const [k, val] of Object.entries(v)) m.set(k, jsonUnwire(kindOfJson(val), val));
      return V.json('obj', m);
    }
    default: return V.json('null', null);
  }
}

function kindOfJson(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'arr';
  return 'obj';
}
function unwireKey(k) {
  if (k.w === 'int') return BigInt(k.v);
  if (k.w === 'bool') return k.v;
  if (k.w === 'float') return k.v;
  return k.v;
}

function snapshotEnv(env) {
  const vars = new Map();
  for (const [k, v] of env.vars) vars.set(k, deepCopy(v));
  const localFns = env.localFns ? new Map(env.localFns) : undefined;
  return { vars, parent: env.parent ? snapshotEnv(env.parent) : null, mod: env.mod, localFns };
}

// 给 Lambda 记录类型提示(调用闭包时需要 ret 类型)
export function annotateLambdas(program) {
  void program;
}

void T_STR; void T_BOOL; void T_UNIT; void unify; void typeStr; void mkOpt; void mkRes; void resolveT; void err;
