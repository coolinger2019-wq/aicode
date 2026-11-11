// src/artifact.js — 字节码产物序列化(v0.39 真 AOT 第一块)
//
// 背景:v0.38 的 dist 只含明文源码 + launcher(运行时才编译)——那不是编译产物。
// 本模块把编译好的字节码(函数指令流/常量池/span 表/wasm 分层)序列化为 JSON,
// 加载端跳过 Checker 与编译器直接执行。
//
// 适用范围(明确边界,超出即拒绝而非静默降级):
//   - 单模块、无 spawn/spawn_all(子任务 worker 从源码编译)
//   - 无用户 trait/impl 方法分发(methodImpls 为空)
//   - 树引擎(--tree)不支持产物加载(树引擎需要完整 AST)
import * as path from 'node:path';
import { vToWire, wireToV } from './interp.js';

export const ARTIFACT_FORMAT = 'ming-bytecode';
export const ARTIFACT_VERSION = 2; // v0.51.2:sig 改为纯 wire 类型(不再内嵌 AST/mod)

// 常量池条目可能是带 __tag 的编译器内部包装(str 键/匹配模式/数组等),
// vToWire 只认 V 值 → 包装层单独编码为 {w:'tag',k,v}(v 本身为 JSON 安全的普通数据)
function minimalDef(d) {
  if (!d || typeof d !== 'object') return d;
  return { nt: d.nt, name: d.name };
}
function stripWireAst(x) {
  if (Array.isArray(x)) return x.map(stripWireAst);
  if (x && typeof x === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(x)) {
      if (k === 'span' || k === 'docs' || k === 'nameSpan' || k === 'mod' || k === 'entry') continue;
      if (k === 'def') { o.def = minimalDef(val); continue; }
      o[k] = stripWireAst(val);
    }
    return o;
  }
  return x;
}
function taggedToWire(kind, v) {
  if (kind === 'structspec' && v && typeof v === 'object') return { names: v.names, def: minimalDef(v.def) };
  if (kind === 'enumspec' && v && typeof v === 'object') return { def: typeof v.def === 'string' ? v.def : minimalDef(v.def), tag: v.tag };
  return stripWireAst(v);
}
function poolItemToWire(v) {
  if (v && typeof v === 'object' && v.__tag) return { w: 'tag', k: v.__tag, v: taggedToWire(v.__tag, v.v) };
  return vToWire(v);
}
function poolItemFromWire(w) {
  if (w && typeof w === 'object' && w.w === 'tag') return { __tag: w.k, v: w.v };
  return wireToV(w);
}

// v0.51.2:类型 -> 纯 wire 描述(只保留运行时需要的判别字段;剥离 mod/entry/decl 反向引用,
// 避免 BigInt 序列化失败与源码 AST 泄漏)
function typeToWire(t) {
  if (!t || typeof t !== 'object') return null;
  switch (t.k) {
    case 'int': return { k: 'int', bits: t.bits, signed: !!t.signed };
    case 'float': return { k: 'float', bits: t.bits };
    case 'bool': case 'str': case 'unit': case 'never': case 'selftype': return { k: t.k };
    case 'param': return { k: 'param', name: t.name };
    case 'vec': return { k: 'vec', el: typeToWire(t.el) };
    case 'map': return { k: 'map', kt: typeToWire(t.kt), vt: typeToWire(t.vt) };
    case 'opt': return { k: 'opt', el: typeToWire(t.el) };
    case 'res': return { k: 'res', ok: typeToWire(t.ok), err: typeToWire(t.err) };
    case 'tuple': return { k: 'tuple', ts: (t.ts ?? []).map(typeToWire) };
    case 'fn': return { k: 'fn', ps: (t.ps ?? []).map(typeToWire), ret: typeToWire(t.ret), effects: [...(t.effects ?? [])] };
    case 'range': return { k: 'range', el: typeToWire(t.el) };
    case 'join': return { k: 'join', el: typeToWire(t.el) };
    case 'struct': case 'enum': return { k: t.k, name: t.name, ...(Array.isArray(t.targs) && t.targs.length ? { targs: t.targs.map(typeToWire) } : {}) };
    default: return { k: t.k, ...(t.name ? { name: t.name } : {}) };
  }
}
function sigToWire(sig) {
  return {
    params: (sig.params ?? []).map(p => ({ name: p.name, mut: !!p.mut, type: typeToWire(p.type) })),
    ret: typeToWire(sig.ret),
    effects: [...(sig.effects ?? [])],
  };
}
function sigFromWire(w) {
  return {
    params: (w?.params ?? []).map(p => ({ name: p.name, mut: !!p.mut, type: p.type })),
    ret: w?.ret ?? { k: 'unit' },
    effects: new Set(w?.effects ?? []),
  };
}

// 编译产物 → JSON 可序列化对象
export function serializeArtifact(compiled, opts = {}) {
  const relFile = (f) => {
    if (!f) return f;
    if (opts.baseDir) {
      const r = path.relative(opts.baseDir, f);
      return r.startsWith('..') ? path.basename(f) : r.split(path.sep).join('/');
    }
    return path.basename(f);
  };
  if (compiled.methodImpls && compiled.methodImpls.size > 0) {
    throw new Error('AOT 产物暂不支持用户 trait/impl 方法分发(请用 --with-source 源码模式)');
  }
  const functions = compiled.functions.map((f, i) => {
    if (!f) throw new Error(`AOT 序列化:函数 #${i} 为空`);
    if (!f.entry?.sig) throw new Error(`AOT 序列化:函数 ${f.name} 缺少签名`);
    return {
      name: f.name,
      nParams: f.nParams,
      nLocals: f.nLocals,
      local: !!f.local,
      modFile: relFile(f.modFile), // 项目内相对路径:不泄漏绝对路径
      code: f.code.flat(), // [op,a,b,c,spanIdx] × n → 扁平数字数组
      sig: sigToWire(f.entry.sig),
    };
  });
  return {
    format: ARTIFACT_FORMAT,
    version: ARTIFACT_VERSION,
    builtBy: null, // bin/ming.js 填充版本号
    functions,
    pool: compiled.pool.map(poolItemToWire),
    spans: compiled.spans.map(sp => sp ? { ...sp, file: relFile(sp.file) } : sp),
    mainFnIdx: compiled.mainFnIdx,
    wasm: compiled.wasm
      ? {
          bytes: Buffer.from(compiled.wasm.bytes).toString('base64'),
          eligible: [...compiled.wasm.eligible.entries()], // [[fnIdx, {exportName,nParams}], ...]
          strConsts: compiled.wasm.strConsts ?? [],
        }
      : null,
  };
}

// JSON 对象 → 运行时 compiled 形态(含最小 entry 对象)
export function deserializeArtifact(a) {
  if (!a || a.format !== ARTIFACT_FORMAT) throw new Error('不是 Ming 字节码产物');
  if (a.version !== ARTIFACT_VERSION) throw new Error(`产物版本不支持: ${a.version}(本工具链支持 ${ARTIFACT_VERSION})`);
  const functions = a.functions.map((f) => {
    const code = [];
    for (let k = 0; k + 4 < f.code.length; k += 5) {
      code.push([f.code[k], f.code[k + 1], f.code[k + 2], f.code[k + 3], f.code[k + 4]]);
    }
    return {
      name: f.name,
      nParams: f.nParams,
      nLocals: f.nLocals,
      local: !!f.local,
      modFile: f.modFile,
      code,
      entry: { kind: 'fn', sig: sigFromWire(f.sig), decl: { name: f.name, span: null }, mod: null },
    };
  });
  const entryFnIdx = new Map(functions.map((f, i) => [f.entry, i]));
  return {
    functions,
    pool: a.pool.map(poolItemFromWire),
    spans: a.spans,
    mainFnIdx: a.mainFnIdx,
    entryFnIdx,
    methodImpls: null,
    patterns: null,
    wasm: a.wasm
      ? {
          bytes: new Uint8Array(Buffer.from(a.wasm.bytes, 'base64')),
          eligible: new Map(a.wasm.eligible),
          strConsts: a.wasm.strConsts,
        }
      : null,
  };
}

// 加载端的最小 check 兼容对象(仅满足运行时读取面:entry.items / modules / methodImpls)
export function makeCheckLike(compiled) {
  const items = new Map();
  for (const fn of compiled.functions) {
    if (!fn.local) items.set(fn.name, fn.entry);
  }
  return {
    entry: { file: '<artifact>', absPath: null, items },
    modules: [],
    diags: [],
    methodImpls: null,
  };
}
