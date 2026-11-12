// lsp.js — Ming 语言服务器(v0.5,stdio JSON-RPC)。
// 能力:诊断推送(didOpen/didChange → publishDiagnostics)、hover(签名 + /// 文档)、
//       completion(标识符/字段方法/关键字)、definition(模块项/局部变量/跨文件 use)、
//       documentSymbol(模块级 fn/struct/trait/const/enum + impl 层级)。
// 简洁优先:每次变更全量重查文件(含其本地导入),对几十 KB 源文件足够快。
// v0.58-A 约定:三个新查询纯解析(不跑 Checker),保守策略——类型推不出 → 空列表,
// 语法错误/未知符号 → null;宁可少补不可错补;现有 hover/诊断路径逐字未动。

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { Checker, STD_MODULES, BUILTIN_FNS, PRELUDE_VARIANTS } from './checker.js';
import { KEYWORDS } from './lexer.js';
import { parse, attachDocs } from './parser.js';

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

  let list;
  if (memberM) {
    list = membersOfBase(memberM[1], ctx, line0, col0);
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
      default:
        if (id !== undefined) this.handleError(id, -32601, `method not found: ${method}`);
        return;
    }
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

// 供测试/工具直连(协议层之外的可测入口;§62 用)
export { completionFor, definitionFor, documentSymbolsFor };
