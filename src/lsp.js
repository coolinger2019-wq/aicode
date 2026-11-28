// lsp.js — Ming 语言服务器(v0.5,stdio JSON-RPC)。
// 能力:诊断推送(didOpen/didChange → publishDiagnostics)、hover(签名 + /// 文档)、
//       completion(标识符/字段方法/关键字 + use 上下文/本地模块成员)、definition(模块项/局部变量/跨文件 use)、
//       documentSymbol(模块级 fn/struct/trait/const/enum + impl 层级)。
// 简洁优先:每次变更全量重查文件(含其本地导入),对几十 KB 源文件足够快。
// v0.58-A 约定:三个新查询纯解析(不跑 Checker),保守策略——类型推不出 → 空列表,
// 语法错误/未知符号 → null;宁可少补不可错补;现有 hover/诊断路径逐字未动。
// v0.80(多文件符号补全第一切片):use 关键字上下文不再回落通用列表(关键字/内置在
// use 行是错补)——只给 std.X 全名(STD_MODULES)与本地同目录 .ming 模块名(checker.load
// 同口径;目录不可枚举 → 仅 std 面)。本地模块成员补全与跨文件解析 machinery 沿用
// v0.58(parseModuleFile/useImportsOf),不另起炉灶;既有单文件补全路径逐字未动(§85 锚)。
// v1.8(ADR-020,roadmap §6.1):Agent 原生协议四方法(ming/agent/*)——queryTypeContext /
// getContractSummary / submitCandidate / requestProofObligation。schema 钉死见
// docs/agent-protocol.md;纪律(ADR-020 §3):一切失败 ok:false + 具名 reason 绝不静默,
// 纯读 + 既有 check 管线,零新增 M 码,语言语义零变化,确定性 = 同请求同响应。
// 既有 hover/completion/definition/documentSymbol/诊断推送路径逐字未动(§62 锚)。

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { Checker, STD_MODULES, BUILTIN_FNS, PRELUDE_VARIANTS } from './checker.js';
import { KEYWORDS } from './lexer.js';
import { parse, attachDocs } from './parser.js';
import { diagJson, MingError } from './diag.js';
import { renderProofScript } from './proofsmt.js';

function sigType(t) {
  switch (t?.nt) {
    case 'TName': return t.name + (t.args.length ? `[${t.args.map(sigType).join(', ')}]` : '');
    case 'TTuple': return `(${t.ts.map(sigType).join(', ')})`;
    case 'TFn': return `(${t.ps.map(sigType).join(', ')}) -> ${sigType(t.ret)}`;
    default: return '?';
  }
}

function itemSignature(it) {
  switch (it.nt) {
    case 'FnDecl': {
      const tps = it.tparams?.length ? `[${it.tparams.join(', ')}]` : '';
      const params = it.params.map(p => p.self ? (p.mut ? 'mut self' : 'self') : `${p.name}: ${sigType(p.type)}`).join(', ');
      const eff = it.effects?.length ? ` with ${it.effects.map(e => e.name).join(', ')}` : '';
      return `fn ${it.name}${tps}(${params})${it.ret ? ' -> ' + sigType(it.ret) : ''}${eff}`;
    }
    case 'StructDecl': return `struct ${it.name} { ${it.fields.map(f => `${f.name}: ${sigType(f.type)}`).join(', ')} }`;
    case 'EnumDecl': return `enum ${it.name} { ${it.variants.map(v => v.name + (v.types.length ? `(${v.types.map(sigType).join(', ')})` : '')).join(', ')} }`;
    case 'ConstDecl': return `const ${it.name}${it.type ? ': ' + sigType(it.type) : ''}`;
    default: return null;
  }
}

function collectHoverables(file, src) {
  const { program, comments, diags } = parse(file, src);
  if (diags.length) return [];
  attachDocs(program.items, comments);
  const out = [];
  for (const it of program.items) {
    const sig = itemSignature(it);
    if (!sig) continue;
    out.push({ span: it.span, sig, docs: it.docs ?? [] });
    if (it.nt === 'StructDecl') {
      for (const f of it.fields) out.push({ span: f.span, sig: `${f.name}: ${sigType(f.type)}`, docs: [] });
    }
  }
  return out;
}

function posInSpan(span, line0, col0) {
  if (!span) return false;
  const line = line0 + 1, col = col0 + 1;
  if (line < span.line || line > span.endLine) return false;
  if (line === span.line && col < span.col) return false;
  if (line === span.endLine && col > span.endCol) return false;
  return true;
}

function diagnosticsFor(uri, text) {
  const file = uriToFile(uri);
  const normFile = nodePath.normalize(nodePath.resolve(file));
  // 缓冲区内容优先(编辑器未保存状态);其他文件读磁盘。
  // 注意 Checker 会把入口 resolve 成绝对路径(Windows 反斜杠),必须规范化比较。
  const readFile = (p) => (nodePath.normalize(nodePath.resolve(p)) === normFile ? text : nodeFs.readFileSync(p, 'utf8'));
  const checker = new Checker(file, readFile);
  let result;
  try {
    result = checker.run();
  } catch (e) {
    return (e.diags ?? []).map(d => diagToLsp(d, file));
  }
  const normSpanFile = (f) => nodePath.normalize(nodePath.resolve(f ?? file));
  return result.diags
    .filter(d => normSpanFile(d.span?.file) === normFile)
    .map(d => diagToLsp(d, file));
}

function diagToLsp(d, file) {
  const line = Math.max(0, (d.span?.line ?? 1) - 1);
  const col = Math.max(0, (d.span?.col ?? 1) - 1);
  const endLine = Math.max(0, (d.span?.endLine ?? d.span?.line ?? 1) - 1);
  const endCol = Math.max(0, (d.span?.endCol ?? d.span?.col ?? 1) - 1);
  return {
    range: { start: { line, character: col }, end: { line: endLine, character: endCol } },
    severity: d.severity === 'warning' ? 2 : 1,
    code: d.code,
    source: 'ming',
    message: d.message + (d.hint ? `\nhint: ${d.hint}` : ''),
  };
}

function uriToFile(uri) {
  if (uri.startsWith('file:///')) return decodeURIComponent(uri.slice('file:///'.length));
  if (uri.startsWith('file://')) return decodeURIComponent(uri.slice('file://'.length));
  return uri;
}

// ===================== v0.58-A:补全 / 跳转定义 / 文档符号 =====================
// 信息面:parse() 的 AST + checker.js 的 STD_MODULES/BUILTIN_FNS/PRELUDE_VARIANTS 表。
// 局部作用域按 AST 词法近似(祖先块链 + 声明在光标前),不做数据流;泛型/方法解析从保守。

// ---- 通用:位置 / 名字 / 遍历 ----

function spanToRange(span) {
  return {
    start: { line: Math.max(0, span.line - 1), character: Math.max(0, span.col - 1) },
    end: { line: Math.max(0, span.endLine - 1), character: Math.max(0, span.endCol - 1) },
  };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 在声明 span 的首行内定位名字(词边界匹配,从 span 起点开始);失败回退整个 span。
// 用于没有 nameSpan 的声明(struct/enum/trait/const)与名字起始于 span 起点的参数/字段。
function nameRangeInSrc(src, span, name) {
  if (!span || !name) return spanToRange(span ?? { line: 1, col: 1, endLine: 1, endCol: 1 });
  const lineText = (src.split('\n')[span.line - 1] ?? '').replace(/\r$/, '');
  const from = Math.max(0, span.col - 1);
  let m = null;
  try {
    m = new RegExp('(?<![A-Za-z0-9_])' + escapeRe(name) + '(?![A-Za-z0-9_])').exec(lineText.slice(from));
  } catch { m = null; }
  if (m) {
    const idx = from + m.index;
    return { start: { line: span.line - 1, character: idx }, end: { line: span.line - 1, character: idx + name.length } };
  }
  return spanToRange(span);
}

function fileToUri(absPath) {
  return encodeURI('file:///' + String(absPath).replace(/\\/g, '/'));
}

// 光标处的标识符(词内 / 紧贴词尾);不在词上 → null
function wordAt(lineText, character) {
  const isIdChar = (ch) => /[A-Za-z0-9_]/.test(ch);
  let start = character;
  if (!(start < lineText.length && isIdChar(lineText[start]))) {
    if (!(start > 0 && isIdChar(lineText[start - 1]))) return null;
    start -= 1;
  }
  while (start > 0 && isIdChar(lineText[start - 1])) start -= 1;
  let end = start;
  while (end < lineText.length && isIdChar(lineText[end])) end += 1;
  if (end === start) return null;
  return { name: lineText.slice(start, end), startCol0: start };
}

// text 以 "." 结尾 → 返回紧邻的 a.b.c 路径段;否则 null
function dottedPathBefore(text) {
  const m = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/.exec(text);
  return m ? m[1].split('.') : null;
}

function* walkAst(node) {
  if (Array.isArray(node)) { for (const x of node) yield* walkAst(x); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.nt === 'string') yield node;
  for (const k of Object.keys(node)) {
    if (k === 'span' || k === 'docs') continue;
    const v = node[k];
    if (v && typeof v === 'object') yield* walkAst(v);
  }
}

// 模式里的绑定名(PIdent / 元组解构 / 枚举载荷解构)
function patBinds(pat) {
  const out = [];
  const go = (p) => {
    if (!p || typeof p.nt !== 'string') return;
    if (p.nt === 'PIdent') out.push({ name: p.name, span: p.span });
    else if (p.nt === 'PTuple') for (const q of p.pats ?? []) go(q);
    else if (p.nt === 'PEnum') for (const a of p.args ?? []) go(a);
  };
  go(pat);
  return out;
}

// ---- 模块信息面(当前文件项 + use 导入) ----

function itemsOf(program) {
  const items = new Map(); // name → { kind, decl, pub }
  const put = (name, kind, decl, pub) => { if (!items.has(name)) items.set(name, { kind, decl, pub: !!pub }); };
  for (const it of program.items) {
    switch (it.nt) {
      case 'FnDecl': put(it.name, 'fn', it, it.pub); break;
      case 'ExternFnDecl': put(it.name, 'fn', it, false); break;
      case 'StructDecl': put(it.name, 'struct', it, it.pub); break;
      case 'EnumDecl': put(it.name, 'enum', it, it.pub); break;
      case 'ConstDecl': put(it.name, 'const', it, it.pub); break;
      case 'TraitDecl': put(it.name, 'trait', it, it.pub); break;
      default: break;
    }
  }
  return items;
}

// use 解析与 checker.load 同口径:std.X 需命中 STD_MODULES;本地按 相对目录/段/段.ming
function useImportsOf(program, absFile) {
  const imports = new Map(); // bind → { std } | { local: absPath }
  for (const it of program.items) {
    if (it.nt !== 'UseDecl') continue;
    const bind = it.alias ?? it.segs[it.segs.length - 1];
    if (it.segs[0] === 'std') {
      if (it.segs.length === 2 && STD_MODULES[it.segs[1]]) imports.set(bind, { std: it.segs[1] });
    } else {
      const target = nodePath.resolve(nodePath.dirname(absFile), it.segs.join('/') + '.ming');
      try { if (nodeFs.existsSync(target)) imports.set(bind, { local: target }); } catch { /* 磁盘不可用 → 忽略 */ }
    }
  }
  return imports;
}

// 读盘解析本地模块(跨文件补全/跳转用);文件不存在或自身有语法错误 → null
function parseModuleFile(absPath) {
  try {
    const src = nodeFs.readFileSync(absPath, 'utf8');
    const { program, diags } = parse(absPath, src);
    if (diags.length) return null;
    return { src, program, items: itemsOf(program) };
  } catch { return null; }
}

// ---- 局部绑定收集(词法可见:祖先块链 + 声明在光标前) ----
// 返回 { locals: [{ name, span, kind, decl }], fnLike, implTypeName }
// kind: param/let/for/whilelet/match/lambda/self;decl 用于类型推断(Let/参数)或 self 的 impl 类型。

function collectLocals(program, line0, col0) {
  const L = line0 + 1, C = col0 + 1;
  const contains = (sp) => posInSpan(sp, line0, col0);

  // 最内层包含光标的函数体(签名/契约上不算,必须在 body 内)
  let best = null;
  const consider = (fnLike, implTypeName) => {
    if (!fnLike?.span || !fnLike?.body?.span) return;
    if (!contains(fnLike.span) || !contains(fnLike.body.span)) return;
    const size = (fnLike.span.endLine - fnLike.span.line) * 4096 + (fnLike.span.endCol - fnLike.span.col);
    if (!best || size < best.size) best = { fnLike, implTypeName, size };
  };
  const scanNested = (fnLike, implTypeName) => {
    consider(fnLike, implTypeName);
    for (const n of walkAst(fnLike.body ?? {})) {
      if (n.nt === 'FnDecl' && n !== fnLike) consider(n, null); // 局部 fn(解析存在,checker 拒绝;保守只看自身参数)
    }
  };
  for (const it of program.items) {
    if (it.nt === 'FnDecl') scanNested(it, null);
    else if (it.nt === 'ImplDecl') for (const m of it.methods ?? []) scanNested(m, it.typeName);
    else if (it.nt === 'TestDecl') scanNested(it, null);
  }
  if (!best) return { locals: [], fnLike: null, implTypeName: null };
  const { fnLike, implTypeName } = best;

  const locals = [];
  const push = (name, span, kind, decl) => { if (name && span) locals.push({ name, span, kind, decl }); };

  if (fnLike.nt === 'FnDecl') {
    for (const p of fnLike.params ?? []) {
      if (p.self) push('self', p.span, 'self', { implTypeName });
      else push(p.name, p.span, 'param', p);
    }
  }

  // 已完整在光标之前的语句:其 let 绑定可见(for/while-let 绑定作用域限于循环体,不算)
  const recordCompleted = (s) => {
    if (s.nt !== 'Let') return;
    for (const b of patBinds(s.pat)) push(b.name, b.span, 'let', s);
  };

  let visitExprFn; // 前置声明(visitBlock/visitMatch 与 visitExprFn 相互递归)
  const visitBlock = (block, preBinds) => {
    if (!block || !contains(block.span)) return;
    for (const b of preBinds ?? []) push(b.name, b.span, b.kind, b.decl);
    for (const s of block.stmts ?? []) {
      const sp = s?.span;
      if (!sp) continue;
      if (sp.endLine < L || (sp.endLine === L && sp.endCol <= C)) { recordCompleted(s); continue; }
      if (contains(sp)) visitStmt(s);
      else break; // 起点在光标之后 → 后续都不可见
    }
    if (block.tail?.span && contains(block.tail.span)) visitExprFn(block.tail);
  };
  const visitIfElse = (els) => {
    if (!els) return;
    if (els.nt === 'If') visitExprFn(els);
    else visitBlock(els);
  };
  const visitMatch = (m) => {
    if (m.scrutinee?.span && contains(m.scrutinee.span)) visitExprFn(m.scrutinee);
    for (const arm of m.arms ?? []) {
      const binds = patBinds(arm.pat).map(b => ({ ...b, kind: 'match', decl: null }));
      if (arm.guard?.span && contains(arm.guard.span)) { for (const b of binds) push(b.name, b.span, b.kind, b.decl); visitExprFn(arm.guard); }
      if (arm.expr?.span && contains(arm.expr.span)) { for (const b of binds) push(b.name, b.span, b.kind, b.decl); visitExprFn(arm.expr); }
    }
  };
  visitExprFn = (e) => {
    if (!e || typeof e.nt !== 'string' || !e.span || !contains(e.span)) return;
    switch (e.nt) {
      case 'BlockExpr': visitBlock(e.block); return;
      case 'Lambda': {
        const binds = (e.params ?? []).map(p => ({ name: p.name, span: p.span, kind: 'lambda', decl: p }));
        if (e.body?.nt === 'Block') visitBlock(e.body, binds);
        else { for (const b of binds) push(b.name, b.span, b.kind, b.decl); visitExprFn(e.body); }
        return;
      }
      case 'Match': visitMatch(e); return;
      case 'If': {
        if (e.cond?.span && contains(e.cond.span)) visitExprFn(e.cond);
        visitBlock(e.then);
        visitIfElse(e.els);
        return;
      }
      case 'LoopExpr': visitBlock(e.body); return;
      case 'StructLit': for (const f of e.fields ?? []) { if (f.value?.span && contains(f.value.span)) visitExprFn(f.value); } return;
      case 'MapLit': for (const en of e.entries ?? []) { if (en.value?.span && contains(en.value.span)) visitExprFn(en.value); } return;
      default:
        for (const k of Object.keys(e)) {
          if (k === 'span') continue;
          const v = e[k];
          if (Array.isArray(v)) {
            for (const x of v) if (x && typeof x.nt === 'string') visitExprFn(x);
          } else if (v && typeof v.nt === 'string') {
            if (v.nt === 'Block') visitBlock(v); else visitExprFn(v);
          }
        }
    }
  };
  const visitStmt = (s) => {
    switch (s.nt) {
      case 'Let': if (s.init?.span && contains(s.init.span)) visitExprFn(s.init); break; // 光标在本 let 内 → 绑定尚不可见(保守)
      case 'ExprStmt': visitExprFn(s.expr); break;
      case 'Assign':
        if (s.target?.span && contains(s.target.span)) visitExprFn(s.target);
        if (s.value?.span && contains(s.value.span)) visitExprFn(s.value);
        break;
      case 'Return': if (s.value?.span && contains(s.value.span)) visitExprFn(s.value); break;
      case 'While':
        if (s.cond?.span && contains(s.cond.span)) visitExprFn(s.cond);
        visitBlock(s.body);
        break;
      case 'WhileLet':
        if (s.expr?.span && contains(s.expr.span)) visitExprFn(s.expr);
        visitBlock(s.body, patBinds(s.pat).map(b => ({ ...b, kind: 'whilelet', decl: null })));
        break;
      case 'For':
        if (s.iter?.span && contains(s.iter.span)) visitExprFn(s.iter);
        visitBlock(s.body, patBinds(s.pat).map(b => ({ ...b, kind: 'for', decl: null })));
        break;
      case 'Loop': case 'UnsafeBlock': case 'SyncScopeBlock': visitBlock(s.body); break;
      case 'AsmBlock':
        // v0.74(ADR-006):asm 块内 in 表达式下钻(模板/约束是纯字面量、out 目标是纯名字,
        // 无定义可跳);visitExprFn 自带 span 守卫,下钻零崩溃面。
        for (const iv of s.ins ?? []) if (iv.value?.span && contains(iv.value.span)) visitExprFn(iv.value);
        break;
      case 'If':
        if (s.cond?.span && contains(s.cond.span)) visitExprFn(s.cond);
        visitBlock(s.then);
        visitIfElse(s.els);
        break;
      case 'Match': visitMatch(s); break;
      case 'BlockExpr': visitBlock(s.block); break;
      case 'FnStmt': { // 局部 fn:体内只见其参数(不继承外层绑定)
        const d = s.decl;
        if (d?.body) {
          const binds = (d.params ?? []).filter(p => !p.self).map(p => ({ name: p.name, span: p.span, kind: 'param', decl: p }));
          visitBlock(d.body, binds);
        }
        break;
      }
      default: break;
    }
  };

  if (fnLike.body) visitBlock(fnLike.body);

  // 后声明遮蔽先声明(收集顺序即源顺序):同名取最后一个(当前生效绑定)
  const visible = new Map();
  for (const b of locals) visible.set(b.name, b);
  return { locals: [...visible.values()], fnLike, implTypeName };
}

// ---- 类型推断(保守:仅当前/导入模块的 struct;注解 > 结构体字面量 > self) ----

function structRefFromPath(path, ctx) {
  if (!Array.isArray(path) || path.length === 0 || path.length > 2) return null;
  if (path.length === 1) {
    const en = ctx.items.get(path[0]);
    if (en?.kind === 'struct') return { name: path[0], decl: en.decl, src: ctx.src, file: ctx.absFile };
    return null;
  }
  const imp = ctx.imports.get(path[0]);
  if (!imp?.local) return null;
  const mod = parseModuleFile(imp.local);
  const en = mod?.items.get(path[1]);
  if (en?.kind === 'struct') return { name: path[1], decl: en.decl, src: mod.src, file: imp.local };
  return null;
}

function typeOfLocal(bind, ctx) {
  const d = bind?.decl;
  if (bind?.kind === 'self') {
    const en = d?.implTypeName ? ctx.items.get(d.implTypeName) : null;
    return en?.kind === 'struct' ? { name: d.implTypeName, decl: en.decl, src: ctx.src, file: ctx.absFile } : null;
  }
  if (!d) return null;
  if (d.type) {
    if (d.type.nt !== 'TName') return null;
    return structRefFromPath(d.type.name.split('.'), ctx);
  }
  if (d.nt === 'Let' && d.init?.nt === 'StructLit') return structRefFromPath(d.init.path ?? [], ctx);
  return null;
}

// struct 字段 + 当前文件 impl 块给出的方法(跨文件 impl 不解析 —— 保守)
function structMembers(ref, ctx) {
  const fields = (ref.decl.fields ?? []).map(f => ({ name: f.name, kind: 5, detail: `${f.name}: ${sigType(f.type)}` }));
  const methods = [];
  const seen = new Set();
  for (const it of ctx.program.items) {
    if (it.nt !== 'ImplDecl' || it.typeName !== ref.name) continue;
    for (const m of it.methods ?? []) {
      if (seen.has(m.name)) continue;
      seen.add(m.name);
      methods.push({ name: m.name, kind: 2, detail: itemSignature(m) ?? `fn ${m.name}` });
    }
  }
  return [...fields, ...methods];
}

function enumVariants(name, decl) {
  return (decl.variants ?? []).map(v => ({ name: v.name, kind: 20, detail: `${name}.${v.name}` }));
}

function stdFns(modName) {
  const m = STD_MODULES[modName];
  if (!m) return [];
  const names = [...new Set(m.fns.map(f => f.name))];
  return names.map(n => ({ name: n, kind: 3, detail: `std.${modName}.${n}` }));
}

// v0.80(多文件符号补全第一切片,切片②):use 关键字上下文的候选面。
// 与 checker.load 的 use 分支同口径(checker.js:779-803):use std.X → std 模块;
// use X → 当前文件同目录 X.ming;use a.b → a/b.ming。保守边界(宁可少补不可错补):
//  - std 模块以 'std.X' 全名形式候选。裸 'std' 不给(`use std;` 是 checker M3022:段数≠2);
//    裸模块名也不给(单段按本地文件解析,`use str;` 会去找 str.ming → M3022)——两种裸
//    形态都是错补;'std.X' 插入即合法代码,`use std.` 的成员路径(既有)仍给裸模块名。
//  - 本地候选仅在当前文件目录可枚举时给出(readdir 失败 → 只给 std 面——"确定不了位置
//    → 只给 std 模块名"的落点);子目录首段不列(下一跳 `D.` 无成员补全支撑,列了即误导;
//    登记 v0.80+ 候选不预支)。
//  - 文件名必须是合法 use 段(标识符口径,解析器 expectId);当前文件自身不候选(自导入
//    = M3025 循环导入,永不成立)。只要求文件存在,不预解析(use 行合法性由 checker 验证)。
function useCandidates(absFile) {
  const out = [];
  for (const name of Object.keys(STD_MODULES)) {
    out.push({ name: `std.${name}`, kind: 9, detail: `std.${name}` });
  }
  let entries = null;
  try { entries = nodeFs.readdirSync(nodePath.dirname(absFile), { withFileTypes: true }); } catch { entries = null; }
  if (entries) {
    const selfBase = nodePath.basename(absFile).replace(/\.ming$/i, '');
    const locals = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.ming')) continue;
      const base = e.name.slice(0, -'.ming'.length);
      if (base === selfBase || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) continue;
      locals.push({ name: base, kind: 9, detail: `本地模块 ${e.name}` });
    }
    // readdir 枚举序由文件系统决定(NTFS/ext4 不同)——按名排序保证跨平台补全顺序确定。
    locals.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const c of locals) out.push(c);
  }
  return out;
}

// ---- 上下文构造 ----

function makeContext(file, src, program) {
  const absFile = nodePath.normalize(nodePath.resolve(file));
  return { program, items: itemsOf(program), imports: useImportsOf(program, absFile), absFile, src };
}

// 光标前源码前缀的词法状态(与 lexer.js 语义对齐的保守近似),走到 (line0, col0) 处:
// - 块注释 /* */ 支持嵌套(lexer 按深度计数),且可跨行;
// - 行注释 // 至行尾(块注释内 // 只是普通文本);
// - 普通字符串 "..." 不可跨行(M1002),\" 转义;原始字符串 r"..." 可跨行、无转义;
// - 字符串/注释内的引号、括号、注释符均不参与状态。
// 返回 { blockDepth, inStr, inRaw, openParens }。
function scanPrefixState(src, line0, col0) {
  const lines = src.split('\n');
  let blockDepth = 0, inStr = false, inRaw = false, openParens = 0;
  for (let i = 0; i <= line0; i++) {
    const line = lines[i] ?? '';
    const end = i === line0 ? Math.min(col0, line.length) : line.length;
    for (let j = 0; j < end; j++) {
      const ch = line[j];
      const next = line[j + 1] ?? '';
      if (blockDepth > 0) {
        if (ch === '/' && next === '*') { blockDepth++; j++; }
        else if (ch === '*' && next === '/') { blockDepth--; j++; }
        continue;
      }
      if (inStr || inRaw) {
        if (!inRaw && ch === '\\') { j++; continue; } // 转义(含 \" 与插值 \{)
        if (ch === '"') { inStr = false; inRaw = false; }
        continue;
      }
      if (ch === '"') {
        // r" 开原始字符串:r 紧贴引号且 r 前不是标识符字符(否则是 for 等标识符的尾字母)
        if (j > 0 && line[j - 1] === 'r' && !(j > 1 && /[A-Za-z0-9_]/.test(line[j - 2]))) inRaw = true;
        else inStr = true;
        continue;
      }
      if (ch === '/' && next === '/') break; // 行注释:本行余下不参与
      if (ch === '/' && next === '*') { blockDepth++; j++; continue; }
      if (ch === '(') openParens++;
      else if (ch === ')') openParens = Math.max(0, openParens - 1);
    }
    if (inStr) inStr = false; // 普通字符串不可跨行;未闭合按行重置(坏源文保守处理)
  }
  return { blockDepth, inStr, inRaw, openParens };
}

// 补全解析:先原文;语法错误则在光标处插入占位文本重试(补全是打字中间态,常见未闭合)。
// 前两种占位覆盖主要形态:' mingLspPlaceholder0 ;' 修 `p.` / `let x = ` 类(缺成员/缺操作数),
// ';' 修 `let x: Po` 类(类型名后直接缺分号)。
// 第三式:光标紧贴 `.` 且同行有后续文本(`let c = Color.;`、`print(pt.);`)或处于未闭合调用内
// (`print(std.`)——残留的 `;`/`)` 让前两式必然失败(`;;` 重复终止 / `;` 落进括号)。
// 吞掉光标之后的同行剩余文本(含首个 `;` 或 `)`,其间未打完的文本一并丢弃),按文档级词法
// 状态补齐未闭合的 `(` 并加语句终止 `;` 后重试;仍失败 → null(宁可少补)。
function parseForCompletion(file, src, line0, col0) {
  const first = parse(file, src);
  if (!first.diags.length) return first;
  const base = src.split('\n');
  while (base.length <= line0) base.push('');
  const line = base[line0] ?? '';
  for (const ph of [' mingLspPlaceholder0 ;', ';']) {
    const lines = base.slice();
    lines[line0] = line.slice(0, col0) + ph + line.slice(col0);
    const retry = parse(file, lines.join('\n'));
    if (!retry.diags.length) return retry;
  }
  const st = scanPrefixState(src, line0, col0);
  if (st.blockDepth === 0 && !st.inStr && !st.inRaw) {
    const lines = base.slice();
    lines[line0] = line.slice(0, col0) + ' mingLspPlaceholder0 ' + ')'.repeat(st.openParens) + ';';
    const retry = parse(file, lines.join('\n'));
    if (!retry.diags.length) return retry;
  }
  return null;
}

// ---- completion ----

const KEYWORDS_SORTED = [...KEYWORDS].sort();

// 成员上下文(X. / X.fo):按 X 的身份给字段/方法/模块成员/变体;推不出 → []
function membersOfBase(baseName, ctx, line0, col0) {
  const { locals } = collectLocals(ctx.program, line0, col0);
  const bind = locals.find(b => b.name === baseName);
  if (bind) {
    const t = typeOfLocal(bind, ctx);
    return t ? structMembers(t, ctx) : []; // 类型未知 → 空列表(宁可少补)
  }
  if (baseName === 'std') {
    return Object.keys(STD_MODULES).map(n => ({ name: n, kind: 9, detail: `std.${n}` }));
  }
  const imp = ctx.imports.get(baseName);
  if (imp) {
    if (imp.std) return stdFns(imp.std);
    const mod = parseModuleFile(imp.local);
    if (!mod) return [];
    const kindMap = { fn: 3, struct: 22, enum: 13, const: 21, trait: 8 };
    const out = [];
    for (const [name, en] of mod.items) {
      if (!en.pub) continue; // 跨模块可见性与 checker 一致:只补 pub
      out.push({ name, kind: kindMap[en.kind] ?? 12, detail: itemSignature(en.decl) ?? en.kind });
    }
    return out;
  }
  if (baseName === 'Option' || baseName === 'Result') {
    return Object.entries(PRELUDE_VARIANTS)
      .filter(([, v]) => v.enumName === baseName)
      .map(([vn, v]) => ({ name: vn, kind: 20, detail: `${baseName}.${v.variant}` }));
  }
  const en = ctx.items.get(baseName);
  if (en?.kind === 'enum') return enumVariants(baseName, en.decl);
  return [];
}

function completionFor(file, src, line0, col0) {
  const lineText = (src.split('\n')[line0] ?? '').replace(/\r$/, '');
  const before = lineText.slice(0, col0);
  // 保守:块注释内不补全(状态扫描:可跨行、支持嵌套——Ming 块注释按 lexer 语义允许
  // /* /* */ 嵌套,与 lexer.js 的 depth 计数一致)
  if (scanPrefixState(src, line0, col0).blockDepth > 0) return { isIncomplete: false, items: [] };
  // 保守:注释 / 字符串内不补全(引号计数奇数 → 在字符串字面量内)
  if (before.includes('//')) return { isIncomplete: false, items: [] };
  if ((before.match(/"/g) ?? []).length % 2 === 1) return { isIncomplete: false, items: [] };

  const memberM = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/.exec(before);
  const prefixM = memberM ? null : /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
  const prefix = memberM ? memberM[2] : (prefixM ? prefixM[1] : '');
  // 数字字面量小数点(如 `3.`)不是成员访问 → 空列表
  if (!memberM && before.endsWith('.')) return { isIncomplete: false, items: [] };

  const parsed = parseForCompletion(file, src, line0, col0);
  if (!parsed) return null; // 语法错误且占位修复无效 → null(与 hover 同口径)
  attachDocs(parsed.program.items, parsed.comments ?? []);
  const ctx = makeContext(file, src, parsed.program);

  // v0.80(切片②):use 关键字上下文(use 之后、路径首段或其前缀)——此前该上下文回落
  // 通用列表,关键字/内置/局部绑定在 use 行都是错补;现只给模块入口面(std.X 全名 +
  // 本地同目录模块名)。memberM 优先:`use std.s` 类以成员路径走既有 std 模块成员补全,
  // 不受本分支影响;解析仍经 parseForCompletion 门(占位修复把 `use st` 补成 `use st;`),
  // 不可修复 → null(与既有保守口径一致)。别名段(`use geom as `)不匹配本形态 → 保持
  // 通用列表(别名补全不在本切片范围)。
  const useCtxM = memberM ? null : /^[ \t]*use[ \t]+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);

  let list;
  if (memberM) {
    list = membersOfBase(memberM[1], ctx, line0, col0);
  } else if (useCtxM) {
    list = useCandidates(ctx.absFile);
  } else {
    list = [];
    // 局部绑定(Variable;self 略过——上下文里很少需要,且容易与关键字混淆)
    const { locals } = collectLocals(ctx.program, line0, col0);
    for (const b of locals) {
      if (b.kind === 'self') continue;
      list.push({ name: b.name, kind: 6, detail: b.kind });
    }
    // 当前模块项(fn/struct/enum/const/trait)
    const kindMap = { fn: 3, struct: 22, enum: 13, const: 21, trait: 8 };
    for (const [name, en] of ctx.items) {
      list.push({ name, kind: kindMap[en.kind] ?? 12, detail: itemSignature(en.decl) ?? en.kind, docs: en.decl.docs });
    }
    // use 绑定(模块别名)
    for (const [bind, imp] of ctx.imports) {
      list.push({ name: bind, kind: 9, detail: imp.std ? `std.${imp.std}` : '本地模块' });
    }
    list.push({ name: 'std', kind: 9, detail: 'std 根命名空间' });
    // 内置函数
    for (const [n, f] of Object.entries(BUILTIN_FNS)) {
      list.push({ name: n, kind: 3, detail: `fn ${n}(${(f.params ?? []).join(', ')})${f.effect ? ` with ${f.effect}` : ''}` });
    }
    // prelude 变体
    for (const [vn, v] of Object.entries(PRELUDE_VARIANTS)) {
      list.push({ name: vn, kind: 20, detail: `${v.enumName}.${v.variant}` });
    }
    // 关键字(仅非成员上下文;字段/方法处补关键字是错补)
    for (const kw of KEYWORDS_SORTED) list.push({ name: kw, kind: 14 });
  }

  const filtered = prefix ? list.filter(it => it.name.startsWith(prefix)) : list;
  const seen = new Set();
  const items = [];
  for (const it of filtered) {
    if (seen.has(it.name)) continue;
    // v0.83:占位符出口过滤(v0.80 审查 NOTE-2)——parseForCompletion 的占位修复文本
    // `mingLspPlaceholder0` 经 `use x as ` 别名位被解析成 UseDecl.alias,再经 useImportsOf
    // 登记进 ctx.imports,在通用列表泄漏为模块候选(kind 9)。在唯一出口(所有列表路径
    // 汇合的去重循环)统一拦掉内部前缀候选;入口(parseForCompletion 占位机制)不动。
    if (it.name.startsWith('mingLspPlaceholder')) continue;
    seen.add(it.name);
    const ci = { label: it.name, kind: it.kind };
    if (it.detail) ci.detail = it.detail;
    if (it.docs?.length) ci.documentation = { kind: 'markdown', value: it.docs.map(d => d.replace(/^\/+/, '').trim()).join('\n') };
    items.push(ci);
  }
  return { isIncomplete: false, items };
}

// ---- definition ----

function declLocation(decl, name, absPath, src) {
  const range = decl.nameSpan ? spanToRange(decl.nameSpan) : nameRangeInSrc(src, decl.span, name);
  return { uri: fileToUri(absPath), range };
}

// 成员跳转:segs 是末个点之前的路径,word 是成员名;内置(std/Option/Result)无源文件 → null
function memberDefinition(segs, word, ctx, line0, col0) {
  if (segs[0] === 'std') return null;
  if (segs.length === 1) {
    const s0 = segs[0];
    const imp = ctx.imports.get(s0);
    if (imp) {
      if (imp.std) return null;
      const mod = parseModuleFile(imp.local);
      const en = mod?.items.get(word);
      if (en) return declLocation(en.decl, word, imp.local, mod.src);
      return null;
    }
    const en = ctx.items.get(s0);
    if (en?.kind === 'enum') {
      const v = en.decl.variants?.find(x => x.name === word);
      if (v) return { uri: fileToUri(ctx.absFile), range: spanToRange(v.span) };
      return null;
    }
    // X 为局部绑定且类型可推 → impl 方法 / struct 字段的声明位置(尽力而为)
    const { locals } = collectLocals(ctx.program, line0, col0);
    const bind = locals.find(b => b.name === s0);
    if (bind) {
      const t = typeOfLocal(bind, ctx);
      if (!t) return null;
      const impl = ctx.program.items.find(it => it.nt === 'ImplDecl' && it.typeName === t.name && (it.methods ?? []).some(mm => mm.name === word));
      if (impl) return declLocation(impl.methods.find(x => x.name === word), word, ctx.absFile, ctx.src);
      const f = t.decl.fields?.find(x => x.name === word);
      if (f) return { uri: fileToUri(t.file), range: nameRangeInSrc(t.src, f.span, word) };
      return null;
    }
    return null;
  }
  if (segs.length === 2) {
    const imp = ctx.imports.get(segs[0]);
    if (!imp?.local) return null;
    const mod = parseModuleFile(imp.local);
    const en = mod?.items.get(segs[1]);
    if (en?.kind === 'enum') {
      const v = en.decl.variants?.find(x => x.name === word);
      if (v) return { uri: fileToUri(imp.local), range: spanToRange(v.span) };
    }
    return null;
  }
  return null;
}

function definitionFor(uri, file, src, line0, col0) {
  const lineText = (src.split('\n')[line0] ?? '').replace(/\r$/, '');
  const w = wordAt(lineText, col0);
  if (!w) return null;
  const parsed = parse(file, src);
  if (parsed.diags.length) return null; // 语法错误 → null(保守;definition 不做占位重试)
  const ctx = makeContext(file, src, parsed.program);
  const before = lineText.slice(0, w.startCol0);

  if (before.endsWith('.')) {
    const segs = dottedPathBefore(before);
    if (!segs) return null;
    return memberDefinition(segs, w.name, ctx, line0, col0);
  }

  // 裸标识符:局部绑定 → 当前模块项 → use 绑定名 → null
  const { locals } = collectLocals(ctx.program, line0, col0);
  const bind = locals.find(b => b.name === w.name);
  if (bind) return { uri, range: nameRangeInSrc(src, bind.span, w.name) };
  const en = ctx.items.get(w.name);
  if (en) return { ...declLocation(en.decl, w.name, ctx.absFile, src), uri };
  for (const it of ctx.program.items) {
    if (it.nt !== 'UseDecl') continue;
    const ub = it.alias ?? it.segs[it.segs.length - 1];
    if (ub === w.name) return { uri, range: nameRangeInSrc(src, it.span, ub) };
  }
  return null;
}

// ---- documentSymbol ----

function documentSymbolsFor(file, src) {
  const { program, diags } = parse(file, src);
  if (diags.length) return null;
  const syms = [];
  const fnChild = (fn) => ({
    name: fn.name,
    kind: 6,
    range: spanToRange(fn.span),
    selectionRange: fn.nameSpan ? spanToRange(fn.nameSpan) : nameRangeInSrc(src, fn.span, fn.name),
  });
  for (const it of program.items) {
    switch (it.nt) {
      case 'FnDecl':
        syms.push({ name: it.name, kind: 12, detail: itemSignature(it) ?? undefined, range: spanToRange(it.span), selectionRange: spanToRange(it.nameSpan) });
        break;
      case 'ExternFnDecl':
        syms.push({ name: it.name, kind: 12, detail: `extern fn ${it.name}`, range: spanToRange(it.span), selectionRange: nameRangeInSrc(src, it.span, it.name) });
        break;
      case 'StructDecl':
        syms.push({
          name: it.name, kind: 23, detail: itemSignature(it) ?? undefined,
          range: spanToRange(it.span), selectionRange: nameRangeInSrc(src, it.span, it.name),
          children: (it.fields ?? []).map(f => ({ name: f.name, kind: 8, range: spanToRange(f.span), selectionRange: nameRangeInSrc(src, f.span, f.name) })),
        });
        break;
      case 'EnumDecl':
        syms.push({
          name: it.name, kind: 10, detail: itemSignature(it) ?? undefined,
          range: spanToRange(it.span), selectionRange: nameRangeInSrc(src, it.span, it.name),
          children: (it.variants ?? []).map(v => ({ name: v.name, kind: 22, range: spanToRange(v.span), selectionRange: spanToRange(v.span) })),
        });
        break;
      case 'TraitDecl':
        syms.push({
          name: it.name, kind: 11, detail: `trait ${it.name}`,
          range: spanToRange(it.span), selectionRange: nameRangeInSrc(src, it.span, it.name),
          children: (it.methods ?? []).map(m => ({ name: m.name, kind: 6, range: spanToRange(m.span), selectionRange: nameRangeInSrc(src, m.span, m.name) })),
        });
        break;
      case 'ConstDecl':
        syms.push({ name: it.name, kind: 14, detail: itemSignature(it) ?? undefined, range: spanToRange(it.span), selectionRange: nameRangeInSrc(src, it.span, it.name) });
        break;
      case 'ImplDecl':
        syms.push({
          name: `impl ${it.trait} for ${it.typeName}`, kind: 5,
          detail: `impl ${it.trait} for ${it.typeName}`,
          range: spanToRange(it.span), selectionRange: nameRangeInSrc(src, it.span, it.typeName),
          children: (it.methods ?? []).map(fnChild),
        });
        break;
      default: break; // test/use 等不列(按任务清单保守)
    }
  }
  return syms;
}

// ===================== v1.8(ADR-020):Agent 原生协议(ming/agent/*)====================
// 面向 AI 代理的结构化消费面:类型上下文定位 / 契约摘要 / 候选提交(只读检查)/ 证明义务原始工件。
// 数据源单一事实(与 CLI 旗标同源,不另起炉灶):
//   - 诊断对象 = src/diag.js diagJson(--json 协议同形:{code,name,severity,message,file,line,col,endLine,endCol,…});
//   - 义务记录 = checker.proofRecords(--proof-report 同源);义务 id 语法 `vc:<fn>:<n>`
//     (n = 采集序 1 起)与 bin/ming.js collectProofs 的 proof_obligation_id 同一口径;
//   - SMT-LIB 文本 = src/proofsmt.js renderProofScript(--proof-format smt-lib 同源,进程内直调,不 spawn)。
// 磁盘口径:四方法一律读盘(编辑器缓冲区不参与)——与 `ming check` 同权,确定性最简形态;
// 活缓冲诊断走既有 didOpen/publishDiagnostics 通道。安全边界(ADR-020 §2):协议只触发
// "读该文件并走既有 check 管线"——不执行候选代码,不做网络,无写盘,无新效果面。

// ---- 共用:读盘 / 校验 / 源文切片 ----

function agentReadSrc(p) {
  try {
    return { ok: true, src: nodeFs.readFileSync(p, 'utf8') };
  } catch (e) {
    const reason = e?.code === 'ENOENT' ? `文件不存在: ${p}` : `无法读取文件 "${p}": ${e.message ?? e}`;
    return { ok: false, reason };
  }
}

// 入口文件用调用方读到的 src(读检同源,消除双读漂移);其 use 导入照常读盘。
function agentChecker(file, src) {
  const normFile = nodePath.normalize(nodePath.resolve(file));
  const readFile = (p) => (nodePath.normalize(nodePath.resolve(p)) === normFile ? src : nodeFs.readFileSync(p, 'utf8'));
  return new Checker(file, readFile);
}

// checker.run() 统一入口:MingError(模块不可读等)→ 具名 ok:false;其他内部错误上抛
// (dispatch 层转 JSON-RPC -32603 具名)。
function agentRunChecker(file, src) {
  try {
    return { ok: true, result: agentChecker(file, src).run() };
  } catch (e) {
    if (e instanceof MingError) {
      return { ok: false, reason: `检查管线失败:${e.diags?.[0]?.message ?? e.message}` };
    }
    throw e;
  }
}

// 方法参数校验:specs = [名, 形态];形态 'string'(必填非空串)/'optString'(可空缺,给则非空串,
// null 视为缺省)/'index'(非负整数,LSP 坐标 0 起)。返回具名错误串或 null。
function agentValidateParams(p, specs) {
  for (const [name, kind] of specs) {
    const v = p[name];
    if (kind === 'string') {
      if (typeof v !== 'string' || v.length === 0) return `缺少必填参数 "${name}"(非空字符串)`;
    } else if (kind === 'optString') {
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string' || v.length === 0) return `参数 "${name}" 必须是非空字符串(缺省 = 全函数)`;
    } else {
      if (!Number.isInteger(v) || v < 0) return `参数 "${name}" 必须是非负整数(LSP 坐标,0 起)`;
    }
  }
  return null;
}

// 源文按 1-based Ming span 切片(多行 span 跨行拼接;行尾 \r 剥除)。
function srcText(src, span) {
  if (!span) return null;
  const lines = src.split('\n');
  if (span.line === span.endLine) {
    const l = (lines[span.line - 1] ?? '').replace(/\r$/, '');
    return l.slice(Math.max(0, span.col - 1), Math.max(0, span.endCol - 1));
  }
  const parts = [];
  for (let ln = span.line; ln <= span.endLine; ln++) {
    const l = (lines[ln - 1] ?? '').replace(/\r$/, '');
    if (ln === span.line) parts.push(l.slice(Math.max(0, span.col - 1)));
    else if (ln === span.endLine) parts.push(l.slice(0, Math.max(0, span.endCol - 1)));
    else parts.push(l);
  }
  return parts.join('\n');
}

function spanArea(span) {
  return (span.endLine - span.line) * 4096 + (span.endCol - span.col);
}

// 契约子句源文:子句 span 以 requires/ensures 关键字起锚(spanFrom(关键字 token)),切片后剥掉
// 前导关键字;其余(表达式与可选的 else "消息"后缀)逐字保留。不使用 expr.span——Binary 节点
// span 从运算符起锚是解析器既有口径(如 `i >= 0 && i < buf.len()` 的顶层 span 起于 &&),
// 用它会截掉最左操作数。
function agentClauseText(src, clause, kw) {
  const t = srcText(src, clause.span) ?? '';
  return t.replace(new RegExp('^' + kw + '\\b\\s*'), '');
}

// ---- ming/agent/queryTypeContext(file, line, col) ----
// 定位 = hover 同款(collectHoverables + posInSpan);多处命中取最小 span(内层优先——比
// hover 的首个命中更精确:字段位置报字段签名而非外层结构体)。fn/effects = 所在 fn 的
// 签名与 with 声明(体内位置:局部 fn 体内 → fn = 该局部 fn、type = 外层声明;
// impl 方法体内与 test 块内 → ok:false——collectHoverables 不收 impl,与 hover 同款(扩收取候选);
// 签名/契约行位置回退到模块级 fn 的最小包含 span)。找不到类型化声明 → ok:false 具名(宁可少报)。
// 位置越界(行超出文件)在定位里自然落空,与"不落在声明上"同因具名。

function agentContainingFn(program, line0, col0) {
  const { fnLike } = collectLocals(program, line0, col0); // 体内位置:内层 fnLike(impl 方法/局部 fn/test)
  if (fnLike) return fnLike.nt === 'FnDecl' ? fnLike : null; // test 块内无 fn 签名可报(如实 → fn:null)
  let best = null; // 签名/契约行位置:模块级 fn / impl 方法的最小包含 span
  const consider = (d) => {
    if (!d || d.nt !== 'FnDecl' || !d.span) return;
    if (!posInSpan(d.span, line0, col0)) return;
    const size = spanArea(d.span);
    if (!best || size < best.size) best = { d, size };
  };
  for (const it of program.items) {
    if (it.nt === 'FnDecl') consider(it);
    else if (it.nt === 'ImplDecl') for (const m of it.methods ?? []) consider(m);
  }
  return best?.d ?? null;
}

function agentQueryTypeContext(file, line0, col0) {
  const r = agentReadSrc(file);
  if (!r.ok) return r;
  const { program, diags } = parse(file, r.src);
  if (diags.length) return { ok: false, reason: `文件存在语法错误,无法定位类型上下文:${diags[0].message}` };
  const items = collectHoverables(file, r.src);
  let hit = null;
  for (const it of items) {
    if (!posInSpan(it.span, line0, col0)) continue;
    if (!hit || spanArea(it.span) < spanArea(hit.span)) hit = it;
  }
  if (!hit) return { ok: false, reason: '指定位置不落在任何类型化声明上(宁可不报)' };
  const fnLike = agentContainingFn(program, line0, col0);
  return {
    ok: true,
    type: hit.sig,
    effects: fnLike?.effects?.map((e) => e.name) ?? [],
    fn: fnLike ? itemSignature(fnLike) : null,
    span: { line: hit.span.line, col: hit.span.col, endLine: hit.span.endLine, endCol: hit.span.endCol },
  };
}

// ---- 契约函数列表(getContractSummary 与 submitCandidate.proofs 共用) ----
// 入口文件的顶层 fn(声明序);义务记录按 abs 匹配入口模块(--proof-report 同源;义务
// id `vc:<fn>:<n>` 与 collectProofs 的 proof_obligation_id 同口径)。requires/ensures =
// 子句源文切片剥关键字(至多一条:语法上可重复但后者覆盖;else "消息"后缀逐字保留)。
// fn 过滤名不存在 → null(上层具名)。

function agentContractFunctions(file, src, program, result, fnFilter) {
  if (fnFilter !== null) {
    const names = new Set(program.items.filter((it) => it.nt === 'FnDecl').map((it) => it.name));
    if (!names.has(fnFilter)) return null;
  }
  const entryAbs = nodePath.normalize(nodePath.resolve(file));
  const recByFn = new Map();
  for (const rec of result?.proofs ?? []) {
    if (nodePath.normalize(nodePath.resolve(rec.abs ?? rec.file)) !== entryAbs) continue;
    if (!recByFn.has(rec.fn)) recByFn.set(rec.fn, rec);
  }
  const out = [];
  for (const it of program.items) {
    if (it.nt !== 'FnDecl') continue;
    if (fnFilter !== null && it.name !== fnFilter) continue;
    const rec = recByFn.get(it.name) ?? null;
    const obligations = (rec?.obligations ?? []).map((o, i) => {
      const ob = { id: `vc:${it.name}:${i + 1}`, kind: o.kind, scope: o.scope ?? 'body' };
      if (o.counterexample) ob.counterexample = o.counterexample;
      return ob;
    });
    out.push({
      name: it.name,
      requires: it.requires ? [agentClauseText(src, it.requires, 'requires')] : [],
      ensures: it.ensures ? [agentClauseText(src, it.ensures, 'ensures')] : [],
      obligations,
    });
  }
  return out;
}

// --proof-report 同构 summary 统计(给定已去重的记录列表)。
function agentProofSummary(recs) {
  const summary = { functions: 0, obligations: 0, proven: 0, violated: 0, unproven: 0 };
  for (const rec of recs ?? []) {
    summary.functions += 1;
    summary.obligations += rec.total;
    summary.proven += rec.proven;
    summary.violated += rec.violated;
    summary.unproven += rec.unproven;
  }
  return summary;
}

// ---- ming/agent/getContractSummary(file, fn?) ----
// ok 只表示"摘要生成成功":文件不可读/语法错误/fn 不存在 → ok:false 具名;语义违反
// (M3045 等)如实以 obligations kind: 'violated' 呈现,不算方法失败。

function agentContractSummary(file, fnFilter = null) {
  const r = agentReadSrc(file);
  if (!r.ok) return r;
  const { program, diags } = parse(file, r.src);
  if (diags.length) return { ok: false, reason: `文件存在语法错误,无法生成契约摘要:${diags[0].message}` };
  if (fnFilter !== null) {
    const names = new Set(program.items.filter((it) => it.nt === 'FnDecl').map((it) => it.name));
    if (!names.has(fnFilter)) return { ok: false, reason: `函数 "${fnFilter}" 不存在于该文件` };
  }
  const c = agentRunChecker(file, r.src);
  if (!c.ok) return c;
  return { ok: true, functions: agentContractFunctions(file, r.src, program, c.result, fnFilter) };
}

// checker 反例字符串("名 = 值"逗号分隔;值 = BigInt 十进制,可负)→ 结构化对象。
// 值保持字符串(i64 超出 JSON 安全整数范围,十进制原样)。不可解析的对整体放弃(宁可少报不错报)。
function agentParseCexValues(cex) {
  const values = {};
  for (const part of String(cex).split(', ')) {
    const m = /^(.+?) = (-?\d+)$/.exec(part);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

// ---- ming/agent/submitCandidate(candidate) ----
// 安全边界(ADR-020 §2):candidate 是本地文件路径,协议只触发"读该文件并走既有 check
// 管线"——不执行候选代码,不做网络,无写盘,无新效果面(与 `ming check` 同权)。
// ok 只表示"检查完成";候选自身的检查结论在 pass/diagnostics。语法错误的候选照跑管线
// (诊断是权威),契约函数列表按可解析部分尽力而为(如实,不虚构)。

function agentSubmitCandidate(candidate) {
  const r = agentReadSrc(candidate);
  if (!r.ok) return r;
  let diags;
  let result = null;
  try {
    result = agentChecker(candidate, r.src).run();
    diags = result.diags;
  } catch (e) {
    if (e instanceof MingError) { diags = e.diags ?? []; } else { throw e; }
  }
  const pass = !diags.some((d) => d.severity === 'error');
  const parsed = parse(candidate, r.src);
  const functions = parsed.diags.length
    ? []
    : agentContractFunctions(candidate, r.src, parsed.program, result, null) ?? [];
  const proofs = { summary: agentProofSummary(result?.proofs ?? []), functions };
  const counterexamples = [];
  for (const f of functions) {
    for (const o of f.obligations) {
      if (o.kind === 'violated' && o.counterexample) {
        counterexamples.push({ obligationId: o.id, values: agentParseCexValues(o.counterexample) });
      }
    }
  }
  return { ok: true, pass, diagnostics: diagJson(diags), proofs, counterexamples };
}

// ---- ming/agent/requestProofObligation(file, fn?) ----
// report = --proof-report --json 同构(collectProofs 单文件形态:{summary, functions, summaries};
// 覆盖该文件连同其本地导入模块,与 --proof-report 同口径)。fn 过滤作用于全部三个数据源
// (functions/summaries/vcs),summary 为过滤后子集的统计。smtLib = --proof-format smt-lib
// 同源文本(src/proofsmt.js 进程内直调,不 spawn 子进程)。

function agentProofObligation(file, fnFilter = null) {
  const r = agentReadSrc(file);
  if (!r.ok) return r;
  const { program, diags } = parse(file, r.src);
  if (diags.length) return { ok: false, reason: `文件存在语法错误,无法导出证明义务:${diags[0].message}` };
  if (fnFilter !== null) {
    const names = new Set(program.items.filter((it) => it.nt === 'FnDecl').map((it) => it.name));
    if (!names.has(fnFilter)) return { ok: false, reason: `函数 "${fnFilter}" 不存在于该文件` };
  }
  const c = agentRunChecker(file, r.src);
  if (!c.ok) return c;
  const result = c.result;
  const seenRec = new Set();
  const functions = [];
  for (const rec of result.proofs ?? []) {
    const key = (rec.abs ?? nodePath.resolve(rec.file)) + '\u0000' + rec.fn;
    if (seenRec.has(key)) continue;
    seenRec.add(key);
    if (fnFilter !== null && rec.fn !== fnFilter) continue;
    functions.push(rec);
  }
  const seenSum = new Set();
  const summaries = [];
  for (const s of result.summaries ?? []) {
    const key = (s.abs ?? nodePath.resolve(s.file)) + '\u0000' + s.fn;
    if (seenSum.has(key)) continue;
    seenSum.add(key);
    if (fnFilter !== null && s.fn !== fnFilter) continue;
    summaries.push(s);
  }
  const vcs = [];
  const seenVc = new Set();
  for (const vc of result.vcs ?? []) {
    const key = (vc.abs ?? nodePath.resolve(vc.file)) + '\u0000' + vc.fn + '\u0000' + vc.index;
    if (seenVc.has(key)) continue;
    seenVc.add(key);
    if (fnFilter !== null && vc.fn !== fnFilter) continue;
    vcs.push(vc);
  }
  return { ok: true, report: { summary: agentProofSummary(functions), functions, summaries }, smtLib: renderProofScript(vcs) };
}

class LspServer {
  constructor(input = process.stdin, output = process.stdout) {
    this.input = input;
    this.output = output;
    this.buffer = Buffer.alloc(0); // 字节缓冲:Content-Length 按字节计,非 ASCII 消息体不能按字符累计
    this.docs = new Map(); // uri → text
    this.shutdown = false;
  }

  send(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  reply(id, result) {
    const body = JSON.stringify({ jsonrpc: '2.0', id, result });
    this.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  handleError(id, code, message) {
    const body = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    this.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  publishDiagnostics(uri) {
    const text = this.docs.get(uri);
    if (text === undefined) return;
    let diags = [];
    try {
      diags = diagnosticsFor(uri, text);
    } catch {
      diags = [];
    }
    this.send('textDocument/publishDiagnostics', { uri, diagnostics: diags });
  }

  onMessage(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize':
        this.reply(id, {
          capabilities: {
            textDocumentSync: 1,
            hoverProvider: true,
            completionProvider: { resolveProvider: false, triggerCharacters: ['.'] },
            definitionProvider: true,
            documentSymbolProvider: true,
          },
          serverInfo: { name: 'ming-lsp', version: '0.4.0' },
        });
        return;
      case 'initialized': return;
      case 'shutdown':
        this.shutdown = true;
        this.reply(id, null);
        return;
      case 'exit':
        process.exit(this.shutdown ? 0 : 1);
        return;
      case 'textDocument/didOpen': {
        const { uri, text } = params.textDocument;
        this.docs.set(uri, text);
        this.publishDiagnostics(uri);
        return;
      }
      case 'textDocument/didChange': {
        const { uri } = params.textDocument;
        const last = params.contentChanges[params.contentChanges.length - 1];
        if (last?.text !== undefined) {
          this.docs.set(uri, last.text);
          this.publishDiagnostics(uri);
        }
        return;
      }
      case 'textDocument/didClose':
        this.docs.delete(params.textDocument.uri);
        return;
      case 'textDocument/hover': {
        const { uri } = params.textDocument;
        const text = this.docs.get(uri) ?? '';
        const { line, character } = params.position;
        try {
          const items = collectHoverables(uriToFile(uri), text);
          const hit = items.find(it => posInSpan(it.span, line, character));
          if (hit) {
            const value = ['```ming', hit.sig, '```', ...(hit.docs.length ? ['', hit.docs.map(d => d.replace(/^\/+/, '').trim()).join('\n')] : [])].join('\n');
            this.reply(id, { contents: { kind: 'markdown', value } });
            return;
          }
        } catch { /* 语法错误时无 hover */ }
        this.reply(id, null);
        return;
      }
      case 'textDocument/completion': {
        const { uri } = params.textDocument ?? {};
        const text = this.docs.get(uri);
        if (text === undefined || !params.position) { this.reply(id, null); return; }
        try {
          this.reply(id, completionFor(uriToFile(uri), text, params.position.line, params.position.character));
        } catch { this.reply(id, null); }
        return;
      }
      case 'textDocument/definition': {
        const { uri } = params.textDocument ?? {};
        const text = this.docs.get(uri);
        if (text === undefined || !params.position) { this.reply(id, null); return; }
        try {
          this.reply(id, definitionFor(uri, uriToFile(uri), text, params.position.line, params.position.character));
        } catch { this.reply(id, null); }
        return;
      }
      case 'textDocument/documentSymbol': {
        const { uri } = params.textDocument ?? {};
        const text = this.docs.get(uri);
        if (text === undefined) { this.reply(id, null); return; }
        try {
          this.reply(id, documentSymbolsFor(uriToFile(uri), text));
        } catch { this.reply(id, null); }
        return;
      }
      // v1.8(ADR-020):Agent 原生协议四方法。失败面纪律:参数/文件/定位问题 → 方法内
      // ok:false 具名 reason;实现内部意外异常 → JSON-RPC error -32603 具名 message
      // (stderr 留痕)。未知 ming/agent/* 方法走既有 default → -32601 MethodNotFound。
      case 'ming/agent/queryTypeContext':
      case 'ming/agent/getContractSummary':
      case 'ming/agent/submitCandidate':
      case 'ming/agent/requestProofObligation':
        this.agentRequest(id, method, params ?? {});
        return;
      default:
        if (id !== undefined) this.handleError(id, -32601, `method not found: ${method}`);
        return;
    }
  }

  agentRequest(id, method, p) {
    let result;
    try {
      switch (method) {
        case 'ming/agent/queryTypeContext': {
          const bad = agentValidateParams(p, [['file', 'string'], ['line', 'index'], ['col', 'index']]);
          if (bad) result = { ok: false, reason: bad };
          else result = agentQueryTypeContext(p.file, p.line, p.col);
          break;
        }
        case 'ming/agent/getContractSummary': {
          const bad = agentValidateParams(p, [['file', 'string'], ['fn', 'optString']]);
          if (bad) result = { ok: false, reason: bad };
          else result = agentContractSummary(p.file, p.fn ?? null);
          break;
        }
        case 'ming/agent/submitCandidate': {
          const bad = agentValidateParams(p, [['candidate', 'string']]);
          if (bad) result = { ok: false, reason: bad };
          else result = agentSubmitCandidate(p.candidate);
          break;
        }
        default: { // requestProofObligation
          const bad = agentValidateParams(p, [['file', 'string'], ['fn', 'optString']]);
          if (bad) result = { ok: false, reason: bad };
          else result = agentProofObligation(p.file, p.fn ?? null);
          break;
        }
      }
    } catch (e) {
      process.stderr.write('LSP handler error: ' + (e?.stack ?? e) + '\n');
      if (id !== undefined) this.handleError(id, -32603, `internal error: ${method}: ${e?.message ?? String(e)}`);
      return;
    }
    if (id !== undefined) this.reply(id, result);
  }

  start() {
    this.input.on('data', (chunk) => {
      // 字节精确分帧:头部与长度都是字节数,消息体(可含中文)必须按字节切,再整体解码
      this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (process.env.MING_LSP_TRACE === '1') {
        process.stderr.write('[lsp] chunk=' + JSON.stringify(chunk.toString('utf8')).slice(0, 120) + ' bufLen=' + this.buffer.length + '\n');
      }
      for (;;) {
        const sep = this.buffer.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const head = this.buffer.slice(0, sep).toString('utf8');
        const m = head.match(/Content-Length:\s*(\d+)/i);
        if (!m) { this.buffer = this.buffer.slice(sep + 4); continue; }
        const len = Number(m[1]);
        const total = sep + 4 + len;
        if (this.buffer.length < total) return;
        const body = this.buffer.slice(sep + 4, total).toString('utf8');
        this.buffer = this.buffer.slice(total);
        // msg 必须声明在 try 外:JSON.parse 失败时 catch 内引用 try 块内的 const msg
        // 会抛 ReferenceError 直接杀死进程(坏 JSON 体 ≠ 可放弃连接)。parse 失败 →
        // msg 为 undefined,不发错误响应;onMessage 抛出 → msg 已定义,照常回 -32603。
        let msg;
        try {
          msg = JSON.parse(body);
          this.onMessage(msg);
        } catch (e) {
          process.stderr.write('LSP handler error: ' + (e?.stack ?? e) + '\n');
          if (msg) this.handleError(msg.id, -32603, 'internal error');
        }
      }
    });
    // stdin EOF 后短暂存活,确保未冲刷的响应写出(管道场景)
    this.input.on('end', () => setTimeout(() => process.exit(this.shutdown ? 0 : 1), 100));
    this.input.resume();
  }
}

export function startLsp() {
  new LspServer().start();
}

// 供测试/工具直连(协议层之外的可测入口;§62 用;§122 四 agent 方法直连同款)
export { completionFor, definitionFor, documentSymbolsFor, agentQueryTypeContext, agentContractSummary, agentSubmitCandidate, agentProofObligation };
