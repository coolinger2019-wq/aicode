// bridge.js — 契约桥 MVP(v1.2 S-4,plan §4.21.2 / roadmap-infrastructure §5.2)。
// 范围(架构师 MVP 合同,边界固定):源语言 = TypeScript(JSDoc);边界形态 =
// Ming `extern fn` ↔ TS 导出函数。不做 Python / WASM component / 运行时插桩。
//
// 本模块是纯 Node 侧工具域(与 ming doc/build 同类,零依赖):
//   1. extractTs   —— 逐行扫描 TS 源(轻量正则/行扫描,不做完整 AST;限制见规范 §7),
//                     把导出函数的 Ming 类型签名 + JSDoc 算术不等式候选契约提取为数据;
//   2. renderMingi —— 确定性渲染 .mingi 契约桩(无时间戳/无随机序,逐字节可复现);
//   3. parseMingi  —— 解析 .mingi(格式定义见 docs/bridge-protocol.md,单一定义处);
//   4. loadStubs   —— 目录/单文件桩装载(目录递归,路径码元序排序,确定性);
//   5. checkExternsAgainstStubs —— 同名 extern fn 签名逐位核对(参数个数/映射类型),
//                     失配 → M3052[bridge-signature-mismatch](诊断码三处登记之一:diag.js CODES)。
// 诚实边界:提取只认 docs/bridge-protocol.md 登记的类型映射表与 JSDoc 不等式模式;
// 表外类型 → 该函数跳过并在桩头具名注记;解析不了的文本 → 桩只含签名,不发明语义。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, SEVERITY } from './diag.js';

// .mingi 格式版本(头部注记 `// mingi <N>`;改格式必须改版本号并同步规范文档)。
export const MINGI_VERSION = 1;

// TypeScript → Ming 类型映射表(MVP;规范文档 §4 单一定义处;测试经 CLI 端到端比对)。
// 表外一律跳过(诚实跳过,不猜)。注意:可变 string[](string[])不在 MVP 表内。
export const TS_TYPE_MAP = Object.freeze({
  number: 'f64',
  bigint: 'i64',
  string: 'str',
  boolean: 'bool',
  'number[]': 'Vec[f64]',
  'readonly number[]': 'Vec[f64]',
  'readonly string[]': 'Vec[str]',
});

// 类型文本规范化:折叠空白 + 归一 `[ ]` 为 `[]`(只用于表查找/比较,不改写进桩的语义)。
function normalizeTypeText(s) {
  return String(s).replace(/\s+/g, ' ').replace(/\s*\[\s*\]/g, '[]').trim();
}

function mapTsType(raw) {
  const norm = normalizeTypeText(raw);
  return Object.prototype.hasOwnProperty.call(TS_TYPE_MAP, norm) ? TS_TYPE_MAP[norm] : null;
}

// ---------- JSDoc 契约提取(确定性模式;禁 NLP/LLM) ----------

// 单遍 token 扫描(2026-11-23 审查 M1/m5 修复):先定位比较操作符,再向两侧取
// **最大连续 token**(字符集 [A-Za-z0-9_$.\[\]]),token 必须整体匹配操作数文法,
// 否则该条不等式整条丢弃——不做子串截断(旧前瞻正则会把 `max >= 0` 截成 `x >= 0`、
// `x > y.z` 截成 `x > y`,静默发明候选,违反规范 §5.2/§8.2"不发明语义"承诺)。
// token 化同时消除旧正则对超长描述的指数级回溯(实测 100k 字符 22–37s)。
const TOKEN_CH = /[A-Za-z0-9_$.\[\]]/;
const NUM_LIT = /^-?\d+(?:\.\d+)?$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const ARITH_CH = '+-*/%';

// 把 JSDoc 文本拆成 tag 描述:Map<tag 名, 描述文本>。@param 按参数名区分(首个生效);
// 描述行跨行累积,直到下一个 @tag。自由描述段(首个 tag 之前)按规范忽略。
function parseJsDocTags(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*\*?\s?/, ''));
  const params = new Map();
  let returnsDesc = null;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const desc = cur.buf.join(' ').trim();
    if (cur.tag === 'param') {
      const m = cur.rest.match(/^([A-Za-z_$][\w$]*)\s*(.*)$/);
      if (m && !params.has(m[1])) params.set(m[1], (m[2] + ' ' + desc).trim());
    } else if (cur.tag === 'returns' || cur.tag === 'return') {
      if (returnsDesc === null) returnsDesc = desc;
    }
    cur = null;
  };
  for (const raw of lines) {
    const m = raw.match(/^@(\w+)\b\s*(.*)$/);
    if (m) {
      flush();
      const tag = m[1].toLowerCase();
      if (tag === 'param' || tag === 'arg' || tag === 'argument') {
        // `@param {number} n 描述` 的 JSDoc 类型花括号形式也接受(描述里的类型注释不参与映射)。
        let rest = m[2].trim();
        const brace = rest.match(/^\{[^}]*\}\s*(.*)$/);
        if (brace) rest = brace[1];
        // 可选参数标注 `[n]` / `[n=1]` 形态不属于 MVP 支持的导出函数(签名侧也会跳过)。
        if (/^\[/.test(rest)) { cur = { tag: 'ignore', rest: '', buf: [] }; continue; }
        cur = { tag: 'param', rest, buf: [] };
      } else if (tag === 'returns' || tag === 'return') {
        cur = { tag, rest: '', buf: [m[2]] };
        if (returnsDesc !== null) cur = { tag: 'ignore', rest: '', buf: [] };
      } else {
        cur = { tag: 'ignore', rest: '', buf: [] };
      }
      continue;
    }
    if (cur) cur.buf.push(raw);
  }
  flush();
  return { params, returnsDesc };
}

// 从一段描述中提取二元算术不等式。返回 {clauses, rawCount}(rawCount = 发现的操作符候选数,
// 用于测试/诊断区分"没写"与"写了但不可映射");子句按出现序去重。
// allowed = {params: Set<参数名>, vecParams: Set<Vec 参数名>, allowResult: boolean}
// 操作数文法(规范 §5.1):标识符 | 标识符.length | result | 十进制整数/小数字面量(可负)。
// 整体匹配,任何成员访问/下标/非十进制数字形态 → 整条不等式丢弃(不截断,不发明)。
function extractInequalities(desc, allowed) {
  const clauses = [];
  const seen = new Set();
  let rawCount = 0;
  if (!desc) return { clauses, rawCount };
  const mapOperand = (o) => {
    // kind:'literal'(字面量) | 'param'(参数) | 'len'(Vec 参数长度符号) | 'result'(返回值)
    if (!o) return null;
    if (NUM_LIT.test(o)) return { text: o, kind: 'literal' };
    if (o.endsWith('.length')) {
      const base = o.slice(0, -'.length'.length);
      if (!IDENT.test(base) || !allowed.vecParams.has(base)) return null;
      return { text: `len$${base}`, kind: 'len' };
    }
    if (!IDENT.test(o)) return null; // `y.z`/`zs[0]` 等:token 不是简单标识符 → 整条丢弃
    if (o === 'result') return allowed.allowResult ? { text: 'result', kind: 'result' } : null;
    if (allowed.params.has(o)) return { text: o, kind: 'param' };
    return null;
  };
  const isSpace = (ch) => /\s/.test(ch);
  // 从 start(含)向反向/正向收集最大 token;返回 [tokenStart, tokenEnd](半开)。
  const scanLeft = (end) => {
    let p = end;
    while (p >= 0 && isSpace(desc[p])) p--;
    const tokEnd = p;
    while (p >= 0 && TOKEN_CH.test(desc[p])) p--;
    return [p + 1, tokEnd + 1];
  };
  const scanRight = (start) => {
    let p = start;
    while (p < desc.length && isSpace(desc[p])) p++;
    const tokStart = p;
    while (p < desc.length && TOKEN_CH.test(desc[p])) p++;
    return [tokStart, p];
  };
  const ops = ['<=', '>=', '>', '<'];
  for (let i = 0; i < desc.length; i++) {
    let op = null;
    for (const cand of ops) if (desc.startsWith(cand, i)) { op = cand; break; }
    if (!op) continue;
    rawCount += 1;
    // 左操作数(= 与操作符间可无空白;词边界由"最大 token"天然保证:`max` 不会被截成 `x`)
    let [ls, le] = scanLeft(i - 1);
    let leftTok = le > ls ? desc.slice(ls, le) : '';
    // 可选负号字面量:`-5`(负号不在 token 字符集,前探一格补入)
    if (leftTok && ls - 1 >= 0 && desc[ls - 1] === '-' && NUM_LIT.test('-' + leftTok)) {
      leftTok = '-' + leftTok;
      ls -= 1;
    }
    // 左界外为算术运算符 → 操作数是更大表达式的一部分(n - 1 <= x 不是简单二元式)→ 整条丢弃
    let lp = ls - 1;
    while (lp >= 0 && isSpace(desc[lp])) lp--;
    if (leftTok && lp >= 0 && ARITH_CH.includes(desc[lp])) continue;
    // 右操作数
    let [rs, re] = scanRight(i + op.length);
    let rightTok = re > rs ? desc.slice(rs, re) : '';
    if (rightTok === '' && desc[rs] === '-' && /\d/.test(desc[rs + 1] ?? '')) {
      // 负号起头的字面量(`-5`):负号不在 token 字符集,向后再扫数字 token
      const [rs2, re2] = scanRight(rs + 1);
      if (re2 > rs2) { rightTok = '-' + desc.slice(rs2, re2); rs = rs2; re = re2; }
    }
    // 右界外为算术运算符 → 同上,整条丢弃(如 `0 <= n - 1`)
    let rp = re;
    while (rp < desc.length && isSpace(desc[rp])) rp++;
    if (rightTok && rp < desc.length && ARITH_CH.includes(desc[rp])) continue;
    const lhs = mapOperand(leftTok);
    const rhs = mapOperand(rightTok);
    if (!lhs || !rhs) continue;
    const kinds = [lhs.kind, rhs.kind];
    // requires 不得引用 result(requires 在入口检查,result 尚不存在)且至少约束一个参数
    // (含 Vec 长度符号;纯常量子句如 `0 < 5` 不是契约候选);
    // ensures 必须引用 result(其余操作数仍须是参数/长度符号/字面量)。
    if (allowed.allowResult) {
      if (!kinds.includes('result')) continue;
    } else {
      if (kinds.includes('result')) continue;
      if (!kinds.some((k) => k === 'param' || k === 'len')) continue;
    }
    const clause = `${lhs.text} ${op} ${rhs.text}`;
    if (seen.has(clause)) continue;
    seen.add(clause);
    clauses.push(clause);
  }
  return { clauses, rawCount };
}

// ---------- TS 提取 ----------

// 从 `(` 起找配对的 `)`(行内深度扫描)。参数列表内出现 `{`/`;` 视为未闭合:
// 单行函数体里的调用括号(`function f(): number { return g(x); }`)不会被误当参数列表末尾。
function matchParenAt(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    } else if (ch === '{' || ch === ';') return -1;
  }
  return -1;
}

// 提取单个 TS 源文本。返回 {source, entries, skipped};entries 按源码顺序,
// skipped 同样按源码顺序(诚实跳过:表外类型/不支持的函数形态/重载)。
// 输出确定性:不读取环境/时间,只依赖 source 文本。
export function extractTs(source, sourceName) {
  const lines = source.split(/\r?\n/);
  const entries = [];
  const skipped = [];
  const seenNames = new Set();
  let pendingDoc = null; // {text}

  const skip = (name, line, reason) => {
    skipped.push({ name, line, reason });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // JSDoc 块(支持多行闭合;与函数声明同行的形态不关联,规范 §7 已登记)
    const docStart = line.indexOf('/**');
    if (docStart >= 0) {
      let text = line.slice(docStart + 3);
      let j = i;
      const end = text.indexOf('*/');
      if (end >= 0) {
        text = text.slice(0, end);
      } else {
        const parts = [text];
        j = i + 1;
        for (; j < lines.length; j++) {
          const e = lines[j].indexOf('*/');
          if (e >= 0) { parts.push(lines[j].slice(0, e)); break; }
          parts.push(lines[j]);
        }
        text = parts.join('\n');
      }
      pendingDoc = { text };
      i = j;
      continue;
    }
    const t = line.trim();
    if (t === '' || t.startsWith('//')) continue;
    // 只认顶层 `export function`(MVP);其余行打断 JSDoc 关联(保守,防止张冠李戴)。
    const asyncM = t.match(/^export\s+async\s+function\s+([A-Za-z_$][\w$]*)/);
    if (asyncM) {
      skip(asyncM[1], i + 1, 'async 函数不在 MVP 范围(桥接只支持同步导出函数)');
      pendingDoc = null;
      continue;
    }
    if (/^export\s+default\s+function/.test(t)) {
      const nm = t.match(/^export\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
      skip(nm ? nm[1] : '<default>', i + 1, 'export default 函数不在 MVP 范围');
      pendingDoc = null;
      continue;
    }
    // `export function` 与 `.d.ts` 的 `export declare function` 两种形态(同为单行签名)。
    const fnM = t.match(/^export\s+(?:declare\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (!fnM) { pendingDoc = null; continue; }
    const name = fnM[1];
    const afterName = t.slice(fnM.index + fnM[0].length);
    // 泛型导出函数 / 跨行签名 / 非函数声明形态一律诚实跳过(具名原因)。
    if (/^\s*</.test(afterName)) { skip(name, i + 1, '泛型导出函数不在 MVP 范围'); pendingDoc = null; continue; }
    if (!/^\s*\(/.test(afterName)) { skip(name, i + 1, '签名跨行或不是标准函数声明(MVP 只支持单行签名)'); pendingDoc = null; continue; }
    if (seenNames.has(name)) { skip(name, i + 1, '重载/重复声明不在 MVP 范围(同名导出函数取首个)'); pendingDoc = null; continue; }

    const open = t.indexOf('(');
    const close = matchParenAt(t, open);
    if (close <= open) { skip(name, i + 1, '签名跨行、括号不配对或参数解构(MVP 只支持单行签名与简单参数)'); pendingDoc = null; continue; }
    const head = t.slice(open + 1, close);
    const tail = t.slice(close + 1).trim();

    // 参数列表(显式类型必需;解构/默认值/可选/rest 一律跳过)。
    const params = [];
    let badParam = null;
    if (head.trim() !== '') {
      if (/[(){}]/.test(head)) { badParam = '参数形态不支持(嵌套括号/解构/默认值表达式)'; }
      if (!badParam) {
        for (const piece of head.split(',')) {
          const raw = piece.trim();
          if (raw === '') { badParam = '参数形态不支持(空参数位)'; break; }
          if (raw.includes('...')) { badParam = 'rest 参数不在 MVP 范围'; break; }
          if (raw.includes('?')) { badParam = '可选参数不在 MVP 范围(签名须显式必填)'; break; }
          if (raw.includes('=')) { badParam = '参数默认值不在 MVP 范围'; break; }
          const pm = raw.match(/^([A-Za-z_$][\w$]*)\s*:\s*(.+)$/);
          if (!pm) { badParam = `参数形态不支持("${raw.slice(0, 40)}")`; break; }
          const mapped = mapTsType(pm[2]);
          if (mapped === null) { badParam = `参数 "${pm[1]}" 的类型 "${normalizeTypeText(pm[2])}" 不在映射表(MVP)`; break; }
          params.push({ name: pm[1], type: mapped });
        }
      }
    }
    if (badParam) { skip(name, i + 1, badParam); pendingDoc = null; continue; }

    // 返回类型(必须显式标注且可映射;void 不在表内 → 跳过)。
    let ret = null;
    if (!tail.startsWith(':')) {
      skip(name, i + 1, '返回类型未显式标注(MVP 要求显式标注且可映射)');
      pendingDoc = null;
      continue;
    }
    let retText = tail.slice(1).trim();
    const cut = retText.search(/[;{]/);
    if (cut >= 0) retText = retText.slice(0, cut).trim();
    if (retText === '') { skip(name, i + 1, '返回类型为空或形态不支持'); pendingDoc = null; continue; }
    const mappedRet = mapTsType(retText);
    if (mappedRet === null) { skip(name, i + 1, `返回类型 "${normalizeTypeText(retText)}" 不在映射表(MVP)`); pendingDoc = null; continue; }

    // JSDoc 不等式候选:参数描述 → requires;@returns 描述中含 result → ensures。
    const paramNames = params.map((p) => p.name);
    const vecParams = new Set(params.filter((p) => p.type.startsWith('Vec[')).map((p) => p.name));
    const allowed = { params: new Set(paramNames), vecParams, allowResult: false };
    const requires = [];
    const ensures = [];
    if (pendingDoc) {
      const tags = parseJsDocTags(pendingDoc.text);
      const seenReq = new Set();
      for (const p of params) {
        const desc = tags.params.get(p.name);
        if (!desc) continue;
        for (const c of extractInequalities(desc, allowed).clauses) {
          if (seenReq.has(c)) continue;
          seenReq.add(c);
          requires.push(c);
        }
      }
      if (tags.returnsDesc) {
        const ens = extractInequalities(tags.returnsDesc, { ...allowed, allowResult: true }).clauses;
        ensures.push(...ens);
      }
    }
    entries.push({ name, line: i + 1, params, ret: mappedRet, requires, ensures });
    seenNames.add(name);
    pendingDoc = null;
  }
  return { source: sourceName, entries, skipped };
}

// ---------- .mingi 渲染(确定性) ----------

export function renderMingi(fileResult) {
  const out = [];
  out.push(`// mingi ${MINGI_VERSION}`);
  out.push(`// source: ${fileResult.source}`);
  out.push('// generated by: ming bridge extract --from ts(MVP;格式规范见 docs/bridge-protocol.md)');
  for (const s of fileResult.skipped) out.push(`// skipped: ${s.name} (line ${s.line}): ${s.reason}`);
  for (const e of fileResult.entries) {
    out.push('');
    out.push(`fn ${e.name}(${e.params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${e.ret}`);
    out.push(`  // from ${fileResult.source}:${e.line}`);
    for (const c of e.requires) out.push(`  requires ${c}`);
    for (const c of e.ensures) out.push(`  ensures ${c}`);
  }
  out.push('');
  return out.join('\n');
}

// ---------- .mingi 解析(格式单一定义处:docs/bridge-protocol.md) ----------

// 解析 .mingi 文本。返回 {version, source, entries, errors};errors 非空 = 桩不可用
// (调用方按工具输入错误 exit 1 具名报告,不静默跳过)。
export function parseMingi(text, displayName) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  const errors = [];
  const seen = new Set();
  let version = null;
  let source = null;
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') continue;
    if (t.startsWith('//')) {
      if (cur) {
        const from = t.match(/^\/\/ from (.+):(\d+)$/);
        if (from) cur.from = { file: from[1], line: Number(from[2]) };
        continue;
      }
      const v = t.match(/^\/\/ mingi (\d+)$/);
      if (v && version === null) { version = Number(v[1]); continue; }
      const s = t.match(/^\/\/ source: (.+)$/);
      if (s && source === null) { source = s[1]; continue; }
      continue;
    }
    const fnM = t.match(/^fn ([A-Za-z_$][\w$]*)\((.*)\) -> (.+)$/);
    if (fnM) {
      if (version === null) errors.push({ line: i + 1, message: '函数条目出现在头部 `// mingi <版本>` 之前' });
      const params = [];
      let bad = null;
      if (fnM[2].trim() !== '') {
        for (const piece of fnM[2].split(',')) {
          const pm = piece.trim().match(/^([A-Za-z_$][\w$]*):\s*(.+)$/);
          if (!pm) { bad = `无法解析参数 "${piece.trim()}"`; break; }
          params.push({ name: pm[1], type: pm[2].replace(/\s+/g, '') });
        }
      }
      if (bad) { errors.push({ line: i + 1, message: bad }); cur = null; continue; }
      if (seen.has(fnM[1])) errors.push({ line: i + 1, message: `同文件重复的函数条目 "${fnM[1]}"` });
      seen.add(fnM[1]);
      cur = {
        name: fnM[1], params, ret: fnM[3].replace(/\s+/g, ''),
        requires: [], ensures: [], from: null,
        line: i + 1, stub: displayName,
      };
      entries.push(cur);
      continue;
    }
    const rq = t.match(/^requires\s+(.+)$/);
    if (rq) {
      if (!cur) { errors.push({ line: i + 1, message: 'requires 子句不属于任何函数条目' }); continue; }
      cur.requires.push(rq[1].trim());
      continue;
    }
    const en = t.match(/^ensures\s+(.+)$/);
    if (en) {
      if (!cur) { errors.push({ line: i + 1, message: 'ensures 子句不属于任何函数条目' }); continue; }
      cur.ensures.push(en[1].trim());
      continue;
    }
    errors.push({ line: i + 1, message: `无法识别的行: ${t.slice(0, 60)}` });
    cur = null;
  }
  if (version === null) errors.push({ line: 1, message: '缺少头部 `// mingi <版本>`' });
  else if (version !== MINGI_VERSION) errors.push({ line: 1, message: `不支持的 mingi 版本 ${version}(本工具支持 ${MINGI_VERSION})` });
  return { version, source, entries, errors };
}

// ---------- 桩装载(目录/单文件;确定性路径排序) ----------

function displayPath(p) {
  return p.split(path.sep).join('/');
}

const SKIP_DIRS = new Set(['node_modules']);

function walkMingi(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walkMingi(full, out);
    } else if (ent.isFile() && ent.name.endsWith('.mingi')) {
      out.push(full);
    }
  }
}

// 收集桩文件:目录递归(跳过隐藏目录/node_modules,码元序排序)+ 单文件原样。
export function collectStubFiles(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return [target];
  const out = [];
  walkMingi(target, out);
  return out.sort((a, b) => (displayPath(a) < displayPath(b) ? -1 : displayPath(a) > displayPath(b) ? 1 : 0));
}

// 收集 TS 输入(extract 侧):单文件 → [{abs, source=basename}];目录 → 递归 .ts
// (跳过隐藏项/node_modules,相对路径码元序;source 用 '/' 分隔的相对路径,
// 输出目录内保留同一子目录结构——确定性且避免同名文件互相覆盖)。
// 注意 .d.ts 同样以 .ts 结尾,按 TS 文件处理(声明文件是契约提取的理想输入)。
function walkTs(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walkTs(full, out);
    } else if (ent.isFile() && ent.name.endsWith('.ts')) {
      out.push(full);
    }
  }
}

export function collectTsFiles(target) {
  const st = fs.statSync(target);
  if (st.isFile()) {
    return [{ abs: target, source: path.basename(target) }];
  }
  const out = [];
  walkTs(target, out);
  const list = out.map((abs) => ({ abs, source: displayPath(path.relative(target, abs)) }));
  return list.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

// 装载桩索引:Map<函数名, 条目>。目录内同名条目按路径码元序首个生效(规范 §6.3 登记)。
// 解析错误汇总返回;调用方必须失败退出而不是丢弃错误。
export function loadStubs(target) {
  const files = collectStubFiles(target);
  const index = new Map();
  const errors = [];
  let total = 0;
  for (const f of files) {
    const parsed = parseMingi(fs.readFileSync(f, 'utf8'), displayPath(f));
    for (const e of parsed.errors) errors.push({ file: displayPath(f), line: e.line, message: e.message });
    for (const e of parsed.entries) {
      total += 1;
      if (!index.has(e.name)) index.set(e.name, e);
    }
  }
  return { files, index, errors, total };
}

// ---------- extern ↔ 桩签名核对(M3052) ----------

function canonAst(t) {
  if (!t) return 'unit';
  if (t.nt === 'TName') return t.args?.length ? `${t.name}[${t.args.map(canonAst).join(', ')}]` : t.name;
  if (t.nt === 'TTuple') return `(${t.ts.map(canonAst).join(', ')})`;
  if (t.nt === 'TFn') return `(${t.ps.map(canonAst).join(', ')}) -> ${canonAst(t.ret)}`;
  if (t.nt === 'TMut') return `mut ${canonAst(t.type)}`;
  return '?';
}

const normTy = (s) => s.replace(/\s+/g, '');
// 载体一致即视为映射命中:污点标注(Untrusted[...])是 Ming 侧安全细化,不参与桥接核对
// (v0.61 强制 extern 返回 Untrusted[str] → 与桩的 str 自然一致;规范 §6.2 规则 3)。
function carrierOf(s) {
  const m = s.match(/^Untrusted\[(.*)\]$/);
  return m ? m[1] : s;
}

export function externSignature(decl) {
  return `fn ${decl.name}(${decl.params.map((p) => `${p.name}: ${canonAst(p.type)}`).join(', ')}) -> ${canonAst(decl.ret)}`;
}

export function stubSignature(entry) {
  return `fn ${entry.name}(${entry.params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${entry.ret}`;
}

// 返回差异描述数组(空 = 一致)。逐位口径:参数个数 → 逐参数类型(按位置)→ 返回类型;
// 参数名不参与(跨语言名字无约束,规范 §6.2 规则 4)。
export function compareSignature(stubEntry, decl) {
  const diffs = [];
  if (stubEntry.params.length !== decl.params.length) {
    diffs.push(`参数个数 桩=${stubEntry.params.length}、extern=${decl.params.length}`);
  } else {
    for (let i = 0; i < stubEntry.params.length; i++) {
      // 载体口径两侧对称(审查 m1):桩侧与 extern 侧都剥最外层 Untrusted 再比——
      // 规范 §4.4/§6.2 规则 3 的"Untrusted[T] ≡ T"承诺对两侧一致成立。
      const want = normTy(carrierOf(stubEntry.params[i].type));
      const got = normTy(carrierOf(canonAst(decl.params[i].type)));
      if (want !== got) diffs.push(`参数 #${i + 1} 类型 桩=${stubEntry.params[i].type}、extern=${canonAst(decl.params[i].type)}`);
    }
  }
  const wantRet = normTy(carrierOf(stubEntry.ret));
  const gotRet = normTy(carrierOf(canonAst(decl.ret)));
  if (wantRet !== gotRet) diffs.push(`返回类型 桩=${stubEntry.ret}、extern=${canonAst(decl.ret)}`);
  return diffs;
}

// 行/列区间重叠(用于"extern 声明 span 上有错误诊断"的毒化判定;同文件才可能重叠)。
function spanOverlaps(a, b) {
  if (!a || !b) return false;
  if ((a.file ?? '') !== (b.file ?? '')) return false;
  const s = (x) => [x.line ?? 0, x.col ?? 0];
  const e = (x) => [x.endLine ?? x.line ?? 0, x.endCol ?? x.col ?? 0];
  const cmp = (x, y) => (x[0] !== y[0] ? x[0] - y[0] : x[1] - y[1]);
  return cmp(s(a), e(b)) <= 0 && cmp(s(b), e(a)) <= 0;
}

// 对全部 checker 结果里的 extern fn 做同名桩核对。无桩 extern → 零报告(MVP 只核对有桩的)。
// 毒化跳过(审查 m2):extern 声明 span 上已有 error 级诊断(如类型名未解析 M3001)时,
// 签名本身不可信,跳过 M3052 以免抢在根因前误导修正回路(v0.67 诊断纪律)。
// 返回 {diags, summary};summary 是 `--json` 的 additive `stub_contract` 概要(仅带 --stub 时输出)。
export function checkExternsAgainstStubs(checked, stubIndex, stubDisplay) {
  const diags = [];
  const entries = [];
  let mismatched = 0;
  let skippedPoisoned = 0;
  const errorSpans = [];
  for (const result of checked) {
    // Diagnostic 的坐标在 d.span 上(顶层 file/line 是 toJson/文本渲染时才物化的,勿取错层)。
    for (const d of result.diags ?? []) if (d.severity === SEVERITY.ERROR && d.span) errorSpans.push(d.span);
  }
  const seen = new Set(); // 多入口共享模块去重:abs+函数名
  for (const result of checked) {
    for (const mod of result.modules) {
      for (const [, entry] of mod.items) {
        if (!entry.extern || entry.kind !== 'fn') continue;
        const decl = entry.decl;
        const stubEntry = stubIndex.get(decl.name);
        if (!stubEntry) continue;
        if (errorSpans.some((sp) => spanOverlaps(decl.span, sp))) { skippedPoisoned += 1; continue; }
        const key = (mod.absPath ?? mod.file) + '\u0000' + decl.name;
        if (seen.has(key)) continue;
        seen.add(key);
        const diffs = compareSignature(stubEntry, decl);
        entries.push({
          fn: decl.name,
          file: decl.span?.file ?? mod.file,
          line: decl.span?.line ?? 0,
          stub: stubEntry.stub,
          stub_line: stubEntry.line,
          signature: externSignature(decl),
          stub_signature: stubSignature(stubEntry),
          requires: stubEntry.requires.slice(),
          ensures: stubEntry.ensures.slice(),
          matched: diffs.length === 0,
        });
        if (diffs.length) {
          mismatched += 1;
          diags.push(err('M3052',
            `桥接签名失配:extern 函数 "${decl.name}" 与契约桩 ${stubEntry.stub}:${stubEntry.line} 不一致——${diffs.join(';')}`,
            decl.span));
        }
      }
    }
  }
  return {
    diags,
    summary: {
      stub: stubDisplay,
      entries_loaded: stubIndex.size,
      checked: entries,
      mismatched,
      skipped_poisoned: skippedPoisoned,
    },
  };
}
