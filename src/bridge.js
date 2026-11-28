// bridge.js — 契约桥 MVP(v1.2 S-4,plan §4.21.2 / roadmap-infrastructure §5.2;
// v1.2.3 R-18 增补效果/污点签名,plan §4.20 P2;v1.6 ADR-018 增补 --from py)。
// 范围(架构师 MVP 合同,边界固定):源语言 = TypeScript(JSDoc)+ Python(PEP 484 注解
// + docstring 不等式,ADR-018,桥 1);边界形态 = Ming `extern fn` ↔ 对端导出函数。
// 不做 WASM component / 运行时插桩;Python 类方法/Sphinx 风格/自然语言登记候选不预支。
//
// 本模块是纯 Node 侧工具域(与 ming doc/build 同类,零依赖):
//   1. extractTs   —— 逐行扫描 TS 源(轻量正则/行扫描,不做完整 AST;限制见规范 §9),
//                     把导出函数的 Ming 类型签名 + JSDoc 算术不等式候选契约 +
//                     桥接元数据(@effects 效果面 / @taint 污点面,R-18)提取为数据;
//   1b. extractPy  —— 逐行扫描 Python 源(ADR-018):顶层 def 签名注解类型映射 +
//                     docstring 数学不等式(Google Args:/Returns: 分节优先,散行兜底);
//                     与 TS 共用不等式文法(len(名)/`**` 幂折叠两处 Python 适配);
//   2. renderMingi —— 确定性渲染 .mingi 契约桩(无时间戳/无随机序,逐字节可复现);
//   3. parseMingi  —— 解析 .mingi(格式定义见 docs/bridge-protocol.md,单一定义处;
//                     v1 与 v2 都接受——v1 桩零改动可读);
//   4. loadStubs   —— 目录/单文件桩装载(目录递归,路径码元序排序,确定性);
//   5. checkExternsAgainstStubs —— 同名 extern fn 签名逐位核对(参数个数/映射类型),
//                     失配 → M3052[bridge-signature-mismatch](诊断码三处登记之一:diag.js CODES);
//   6. checkContractSatisfaction —— 调用点契约满足性(v1.4 S-5 / ADR-015,MVP = b-lite):
//                     对指向有桩 extern fn 的 Call 节点,实参全为字面量时机械求值桩
//                     requires → 违反 M3053[bridge-contract-violated];不可判只计数
//                     (`stub_contract.contracts`,不猜)。**纯报告**:不注入任何推导。
// 诚实边界:提取只认 docs/bridge-protocol.md 登记的类型映射表与 JSDoc 不等式模式
// (Python 侧另认 ADR-018 登记的 PEP 484 映射与 docstring 载体);表外类型 → 该函数
// 跳过并在桩头具名注记;解析不了的文本 → 桩只含签名,不发明语义。
// 效果面(R-18)是**元数据**:extern fn 在 Ming 语言面隐含 ffi、无法再声明效果,
// 因此 check --stub 只把它如实注记进 `stub_contract.checked[]`(下游工具/Agent 消费),
// 不做语言层核对;污点面映射为既有 `Untrusted[str]` 载体,参与既有载体等价比对。
// Python 侧(ADR-018)不抽效果/污点注解(无 @effects 对应物)——桩不带 effects 行。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, SEVERITY } from './diag.js';
// 效果名单一事实来源:v0.54+ 的 Ming 已知效果集(io/time/fs/net/sync/proc/env/
// rand/crypto/ffi/unsafe/eval/asm)。桥接提取期只用它做名字校验,不复制一份表。
import { KNOWN_EFFECTS } from './checker.js';

// .mingi 格式版本(头部注记 `// mingi <N>`;改格式必须改版本号并同步规范文档)。
// v1.2.3(R-18):版本 2 —— 函数条目新增可选 `effects <名, ...>` 行(效果面元数据)。
// 解析器同时接受 1 与 2:v1 桩(无 effects 行)零报错可读,旧黄金继续有效;
// 渲染器只发 2(新格式信号)。其余版本拒绝。
export const MINGI_VERSION = 2;
export const MINGI_SUPPORTED_VERSIONS = Object.freeze([1, 2]);

// 污点载体白名单(桥接面):仅 str。Ming 侧 Untrusted 载体白名单 =
// str/Json/Vec[u8]/Map[str,str]/i64(checker M3050),但 TS 映射表只把 string 映射为
// 可作为 extern 边界载体的 str(ADR-012 §8:extern 返回污标量不预支);Vec[u8]/Json/
// Map[str,str] 无 TS 映射来源。其余映射的 @taint 标注 → 忽略 + 桩头 note 具名。
export const BRIDGE_TAINT_CARRIERS = Object.freeze(['str']);

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
// `x > y.z` 截成 `x > y`,静默发明候选,违反规范 §5.2/§9.2"不发明语义"承诺)。
// token 化同时消除旧正则对超长描述的指数级回溯(实测 100k 字符 22–37s)。
const TOKEN_CH = /[A-Za-z0-9_$.\[\]]/;
const NUM_LIT = /^-?\d+(?:\.\d+)?$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const ARITH_CH = '+-*/%';

// 把 JSDoc 文本拆成 tag 描述:Map<tag 名, 描述文本>。@param 按参数名区分(首个生效);
// 描述行跨行累积,直到下一个 @tag。自由描述段(首个 tag 之前)按规范忽略。
// v1.2.3(R-18):额外收集桥接元数据标签的**原始**内容(校验/语义映射在 extractTs 侧):
//   · `@effects <名, 名, ...>` —— 逗号分隔;只取标签行本身(描述续行不参与,行扫描风格)。
//   · `@taint return|returns|param <名>` —— 形状不认识的按 kind:'bad' 原样带回,由调用方注记。
// lineOf(可选)把文本行下标映射回源文件 1 起行号,用于 note 注记的精确行号。
function parseJsDocTags(text, lineOf) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*\*?\s?/, ''));
  const params = new Map();
  const effects = []; // [{name, line}] —— 出现序,同名保留首个
  const taints = []; // [{kind:'return'|'param'|'bad', name?, raw, line}]
  const tagNotes = []; // [{line, message}] —— 元数据标签的丢弃/截断注记(并入桩头 note)
  let returnsDesc = null;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const desc = cur.buf.join(' ').trim();
    if (cur.tag === 'meta') {
      if (desc !== '') tagNotes.push({ line: cur.line, message: `@${cur.metaKind} 标签续行不参与解析(仅取标签行本身)` });
      cur = null;
      return;
    }
    if (cur.tag === 'param') {
      const m = cur.rest.match(/^([A-Za-z_$][\w$]*)\s*(.*)$/);
      if (m && !params.has(m[1])) params.set(m[1], (m[2] + ' ' + desc).trim());
    } else if (cur.tag === 'returns' || cur.tag === 'return') {
      if (returnsDesc === null) returnsDesc = desc;
    }
    cur = null;
  };
  const lineAt = (idx) => (Array.isArray(lineOf) && lineOf[idx] != null ? lineOf[idx] : null);
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
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
      } else if (tag === 'effects') {
        const line = lineAt(idx);
        let sawName = false;
        for (const piece of m[2].split(',')) {
          const pt = piece.trim();
          if (pt === '') continue;
          // 审查 MINOR-1:项内取首个标识符为效果名——`fs - 文字` 不再整体丢弃,剩余文字具名注记。
          const nm = pt.match(/^([a-z][a-z0-9_]*)\b/);
          if (!nm) { tagNotes.push({ line, message: `@effects 项不可解析(\"${pt.slice(0, 40)}\"),已忽略` }); continue; }
          sawName = true;
          if (nm[1].length < pt.length) {
            tagNotes.push({ line, message: `@effects 项 \"${pt.slice(0, 40)}\" 仅取名字 \"${nm[1]}\",其余文字忽略` });
          }
          if (!effects.some((e) => e.name === nm[1])) effects.push({ name: nm[1], line });
        }
        if (!sawName) tagNotes.push({ line, message: '@effects 标签没有效果名' });
        // 审查 MINOR-1:续行不参与解析,但须具名提示(不静默吞掉第二行)。
        cur = { tag: 'meta', metaKind: 'effects', line, buf: [] };
      } else if (tag === 'taint') {
        const line = lineAt(idx);
        const rest = m[2].trim();
        const rm = rest.match(/^returns?\b\s*(.*)$/i);
        const pm = rest.match(/^param\s+([A-Za-z_$][\w$]*)\s*(.*)$/);
        if (rm) taints.push({ kind: 'return', raw: rest, line });
        else if (pm) taints.push({ kind: 'param', name: pm[1], raw: rest, line });
        else taints.push({ kind: 'bad', raw: rest, line });
        cur = { tag: 'meta', metaKind: 'taint', line, buf: [] };
      } else {
        cur = { tag: 'ignore', rest: '', buf: [] };
      }
      continue;
    }
    if (cur) cur.buf.push(raw);
  }
  flush();
  return { params, returnsDesc, effects, taints, tagNotes };
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

// 提取单个 TS 源文本。返回 {source, entries, skipped, notes};entries 按源码顺序,
// skipped 同样按源码顺序(诚实跳过:表外类型/不支持的函数形态/重载)。
// notes = 函数**保留**但其桥接元数据标注被丢弃的具名注记(R-18:未知效果名/不支持的
// @taint 形态/载体白名单外的污点映射)——与 skipped 分开,避免"函数被跳过"的误读。
// 输出确定性:不读取环境/时间,只依赖 source 文本。
export function extractTs(source, sourceName) {
  const lines = source.split(/\r?\n/);
  const entries = [];
  const skipped = [];
  const notes = [];
  const seenNames = new Set();
  let pendingDoc = null; // {text, lineOf}

  const skip = (name, line, reason) => {
    skipped.push({ name, line, reason });
  };
  const note = (name, line, reason) => {
    notes.push({ name, line, reason });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // JSDoc 块(支持多行闭合;与函数声明同行的形态不关联,规范 §5.4 已登记)
    const docStart = line.indexOf('/**');
    if (docStart >= 0) {
      let text = line.slice(docStart + 3);
      let j = i;
      // lineOf:文本行下标 → 源文件 1 起行号(多行块逐行登记;单行块只一行)。
      const lineOf = [i + 1];
      const end = text.indexOf('*/');
      if (end >= 0) {
        text = text.slice(0, end);
      } else {
        const parts = [text];
        j = i + 1;
        for (; j < lines.length; j++) {
          const e = lines[j].indexOf('*/');
          lineOf.push(j + 1);
          if (e >= 0) { parts.push(lines[j].slice(0, e)); break; }
          parts.push(lines[j]);
        }
        text = parts.join('\n');
      }
      pendingDoc = { text, lineOf };
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
    let mappedRet = mapTsType(retText);
    if (mappedRet === null) { skip(name, i + 1, `返回类型 "${normalizeTypeText(retText)}" 不在映射表(MVP)`); pendingDoc = null; continue; }

    // JSDoc 不等式候选:参数描述 → requires;@returns 描述中含 result → ensures。
    // v1.2.3(R-18):同一遍收集桥接元数据——效果面(@effects)与污点面(@taint)。
    const paramNames = params.map((p) => p.name);
    const vecParams = new Set(params.filter((p) => p.type.startsWith('Vec[')).map((p) => p.name));
    const allowed = { params: new Set(paramNames), vecParams, allowResult: false };
    const requires = [];
    const ensures = [];
    const effects = [];
    const taintParams = new Set();
    let taintReturn = false;
    if (pendingDoc) {
      const tags = parseJsDocTags(pendingDoc.text, pendingDoc.lineOf);
      // ---- 效果面(metadata,不新增 Ming 语言面):合法名字保序去重保留;
      // 未知/非法名字**逐名丢弃**并注记具名(诚实,不猜;合法名字照常保留)。
      for (const tn of tags.tagNotes) note(name, tn.line, tn.message);
      for (const ef of tags.effects) {
        if (KNOWN_EFFECTS.has(ef.name)) {
          if (!effects.includes(ef.name)) effects.push(ef.name);
        } else {
          note(name, ef.line, `@effects 未知效果 "${ef.name.slice(0, 40)}" 已丢弃(已知效果名见 src/checker.js KNOWN_EFFECTS)`);
        }
      }
      // ---- 污点面:@taint return → Untrusted[str];@taint param <名> → 该参数 Untrusted[str]。
      // 载体白名单(桥接面)= str;形态不认识/参数不存在/载体不支持 → 忽略该标注 + 注记。
      for (const tt of tags.taints) {
        if (tt.kind === 'bad') {
          note(name, tt.line, `@taint 形态不支持("${tt.raw.slice(0, 40)}");只支持 @taint return 或 @taint param <名>`);
          continue;
        }
        if (tt.kind === 'return') {
          if (!BRIDGE_TAINT_CARRIERS.includes(mappedRet)) {
            note(name, tt.line, `@taint return 的返回类型 ${mappedRet} 不在污点载体白名单(桥接面仅 ${BRIDGE_TAINT_CARRIERS.join('/')}),标注已忽略`);
            continue;
          }
          taintReturn = true;
          continue;
        }
        const p = params.find((q) => q.name === tt.name);
        if (!p) {
          note(name, tt.line, `@taint param "${tt.name}" 不是本函数参数,标注已忽略`);
          continue;
        }
        if (!BRIDGE_TAINT_CARRIERS.includes(p.type)) {
          note(name, tt.line, `@taint param "${tt.name}" 的类型 ${p.type} 不在污点载体白名单(桥接面仅 ${BRIDGE_TAINT_CARRIERS.join('/')}),标注已忽略`);
          continue;
        }
        taintParams.add(p.name);
      }
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
    // 污点标注落进类型文本(载体等价比对自然生效):return 侧整体替换;参数侧逐名替换。
    if (taintReturn) mappedRet = `Untrusted[${mappedRet}]`;
    for (const p of params) if (taintParams.has(p.name)) p.type = `Untrusted[${p.type}]`;
    entries.push({ name, line: i + 1, params, ret: mappedRet, requires, ensures, effects, taint: { return: taintReturn, params: params.filter((p) => taintParams.has(p.name)).map((p) => p.name) } });
    seenNames.add(name);
    pendingDoc = null;
  }
  // 注记按源行号升序(稳定排序,同行保持产生序)——与"节点顺序 = 源码出现序"一致。
  notes.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { source: sourceName, entries, skipped, notes };
}

// ---------- Python 提取(ADR-018;--from py,桥 1)----------
//
// 输入面:.py 文件;只取**顶层 def**(列 0 起行)。缩进行(类方法/函数体)静默不扫、
// 不产条目也不产注记(ADR-018 §1:方法抽取登记候选)——与 TS 版对 class 方法的
// "不扫描"口径一致。docstring = 签名冒号行后的第一个语句级三引号块("""/''';
// r/f 前缀形态不算);契约候选只从 docstring 提取(装饰器不预支;类型注解只从
// def 签名行读,跨行签名按括号配对状态机支持,上限 100 行)。
//
// 约定载体(ADR-018 §1 优先级):
//   1. Google 分节:`Args:` 段 `名: 描述` 行(+更深缩进的续行)→ 该参数的描述;
//      `Returns:` 段内容 → 返回值描述。只认这两个节名(大小写敏感;Parameters:/Raises:
//      等其他 Google 节名按"其他分节"处理——其缩进内容既不参与契约、也不参与散行兜底,
//      登记口径:结构化分节内容不重释为契约);
//   2. 散行兜底:不属于任何节内容区的自由行,逐行过数学不等式文法,提取出的子句归入
//      requires(必须涉及 ≥1 个参数;只含 result/无参数 → 丢弃 v1,ADR-018 §1);
//   3. 不做的(登记候选):自然语言、Sphinx :param: 风格、Google `名 (类型): 描述`
//      括注形态、`\"""` 转义三引号(按首个同级三引号闭合)、装饰器约定。解析不了的
//      行静默跳过,不影响产出确定性(与 TS 版同口径)。
//
// 数学不等式文法 = TS 版共用一套(bridge-protocol.md §5.1;实现复用 extractInequalities),
// Python 侧两处文法适配(其余规则——词边界最大 token/链式相邻对/算术邻接整条丢弃/
// requires 禁 result——逐字同 TS):
//   · `len(名)` → `名.length` 预改写:随后走既有 .length → len$ 通道(含"必须 Vec 参数"
//     守卫);词边界守卫防 xlen(/lengthen( 误改;改写不了/嵌套形态留给既有规则丢弃;
//   · `**` 幂:整数底**整数指数(指数 0..64)提取期求值折叠为十进制字面量——结果仍须
//     落在 i64 范围内,否则保持原文(随后被"算术邻接整条丢弃"规则淘汰,不发明不降级)。
//     负底数不折叠:Python 语义 `-2**2 == -(2**2)`,直接求值会写出语义相反的候选。
//
// 类型映射(PEP 484 → Ming;ADR-018 §1 表):int→i64 / float→f64 / str→str / bool→bool /
// list[T]·List[T]→Vec[T] / dict[str,T]·Dict[str,T]→Map[str,T](键限 str) /
// Optional[T]·T|None→Option[T](两侧均可,恰两支);typing. 前缀剥离(纯名义)。
// 递归映射,任一层不可映射 → 整体 null。**无注解/不可映射参数 → 该参数跳过不进桩**
// (桩头 note 具名;M3052 按桩内参数集对齐——extern 只声明已映射参数,ADR-018 §1
// 登记口径)。返回注解只进类型映射、不生成 ensures;未标注/不可映射(None 与 TS 的
// void 同地位)→ 整个函数跳过(具名)。*args/**kwargs 具名跳过;`*`/`/` 裸标记位忽略;
// 默认值不进桩(ADR-018);keyword-only 形参按普通形参转录(桩只描述类型文本)。

// 引号感知的行内 `#` 注释剥离(签名行用;字符串字面量内的 # 不剥)。三引号形态按
// 三个单引号/双引号序列近似处理——签名里出现三引号默认值属病态,解析失败 → 具名跳过。
function pyStripComment(line) {
  let q = null;
  for (let c = 0; c < line.length; c++) {
    const ch = line[c];
    if (q) {
      if (ch === '\\') { c += 1; continue; }
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '#') return line.slice(0, c);
  }
  return line;
}

// 顶层分隔切分(括号感知):sep 为单字符;`(`/`[`/`{` 加深、配对符减深,深度 0 处的
// sep 才切分——`dict[str, int]`/默认值 `[1, 2]` 内的分隔符不切。
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(s)) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// PEP 484 注解 → Ming 类型(ADR-018 §1 表;递归;空白全剥后解析)。不可映射 → null。
function parsePyType(s) {
  const parts = splitTopLevel(s, '|');
  if (parts.length > 1) {
    // 联合:T | None / None | T → Option[T](恰两支且一支为 None);多支/双实型 → null。
    if (parts.length !== 2) return null;
    const other = parts[0] === 'None' ? parts[1] : (parts[1] === 'None' ? parts[0] : null);
    if (!other || other === 'None') return null;
    const t = parsePyType(other);
    return t ? `Option[${t}]` : null;
  }
  if (s === 'int') return 'i64';
  if (s === 'float') return 'f64';
  if (s === 'str') return 'str';
  if (s === 'bool') return 'bool';
  const m = s.match(/^([A-Za-z_][\w.]*)\[(.*)\]$/);
  if (!m) return null;
  let head = m[1];
  if (head.startsWith('typing.')) head = head.slice('typing.'.length);
  const args = splitTopLevel(m[2], ',');
  if (head === 'list' || head === 'List') {
    if (args.length !== 1) return null;
    const t = parsePyType(args[0]);
    return t ? `Vec[${t}]` : null;
  }
  if (head === 'dict' || head === 'Dict') {
    if (args.length !== 2 || args[0] !== 'str') return null;
    const t = parsePyType(args[1]);
    return t ? `Map[str,${t}]` : null;
  }
  if (head === 'Optional') {
    if (args.length !== 1) return null;
    const t = parsePyType(args[0]);
    return t ? `Option[${t}]` : null;
  }
  return null;
}

function mapPyType(raw) {
  return parsePyType(String(raw).replace(/\s+/g, ''));
}

// `len(名)` → `名.length` 预改写(词边界:`len` 左侧不得是 token 字符;名须为简单标识符;
// 单遍,不递归——嵌套 len 留给既有规则丢弃)。
const PY_LEN_RE = /(^|[^A-Za-z0-9_$.\[\]])len\s*\(\s*([A-Za-z_]\w*)\s*\)/g;

function pyRewriteLenCalls(text) {
  return String(text).replace(PY_LEN_RE, (m, pre, nm) => `${pre}${nm}.length`);
}

// `**` 幂折叠(见 Python 提取头注):整数底**整数指数(0..64)→ 十进制字面量;
// 结果超 i64 → 不折叠;底数/指数紧贴 token 字符或 `*` → 不折叠(防 x2**3 / 2**3x / 2**3*4);
// 底数紧邻 `-` 不折叠(减法语境)。
const PY_POW_MAX_EXP = 64;
const PY_POW_I64_MAX = 9223372036854775807n;

function pyFoldPowers(text) {
  const t = String(text);
  const isTokCh = (c) => /[A-Za-z0-9_$.\[\]]/.test(c);
  const isDigit = (c) => c >= '0' && c <= '9';
  let out = '';
  let i = 0;
  while (i < t.length) {
    const star = t.indexOf('**', i);
    if (star < 0) { out += t.slice(i); break; }
    // 指数:** 之后(可隔空白)的十进制整数字面量
    let rs = star + 2;
    while (rs < t.length && /\s/.test(t[rs])) rs += 1;
    let re = rs;
    while (re < t.length && isDigit(t[re])) re += 1;
    // 底数:** 之前(可隔空白)的十进制整数字面量
    let le = star;
    while (le > 0 && /\s/.test(t[le - 1])) le -= 1;
    let ls = le;
    while (ls > 0 && isDigit(t[ls - 1])) ls -= 1;
    const okShape = re > rs && le > ls
      && (ls === 0 || (!isTokCh(t[ls - 1]) && t[ls - 1] !== '-'))
      && (re >= t.length || (!isTokCh(t[re]) && t[re] !== '*'));
    if (!okShape) { out += t.slice(i, star + 2); i = star + 2; continue; }
    const exp = Number(t.slice(rs, re));
    if (!Number.isInteger(exp) || exp < 0 || exp > PY_POW_MAX_EXP) { out += t.slice(i, star + 2); i = star + 2; continue; }
    const v = BigInt(t.slice(ls, le)) ** BigInt(exp);
    if (v > PY_POW_I64_MAX) { out += t.slice(i, star + 2); i = star + 2; continue; }
    out += t.slice(i, ls) + v.toString();
    i = re;
  }
  return out;
}

// docstring → 分节结构(确定性;缩进 = 行首空白字符数,tab 计 1):
//   · `Args:`/`Returns:`(大小写敏感,节名后不得有其他文本)开节;其他 `\w+:` 形态行
//     开"其他节"(缩进内容忽略——Raises:/Example: 等不参与契约,也不落散行);
//   · 节内容 = 缩进严格大于节头缩进的非空行;缩退(≤ 节头缩进)的非头行结束该节并落散行;
//   · Args 段:更深层的 `名: 描述` 开条目(同名取首个,后续同名条目连同其续行丢弃——
//     TS @param 同口径);不匹配条目形态的行 = 上一条目的续行(无条目 → 落散行);
//   · Returns 段:全部内容行累积为返回值描述(与 TS @returns 同口径:不引用 result 的
//     不等式按规则丢弃,不落散行重释);
//   · 散行 = 不属于任何节内容区的自由行(含 docstring 首行摘要)。
function parsePyDocSections(text) {
  const docLines = String(text).split(/\r?\n/);
  const argsEntries = [];
  const returnsBuf = [];
  const scatter = [];
  let section = null;
  let sectionIndent = -1;
  let lastEntry = null;
  const indentOf = (s) => {
    let n = 0;
    while (n < s.length && (s[n] === ' ' || s[n] === '\t')) n += 1;
    return n;
  };
  for (const raw of docLines) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const indent = indentOf(raw);
    const headerM = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*):\s*$/);
    if (headerM && (section === null || indent <= sectionIndent)) {
      section = headerM[1] === 'Args' ? 'args' : (headerM[1] === 'Returns' ? 'returns' : 'other');
      sectionIndent = indent;
      lastEntry = null;
      continue;
    }
    if (section === 'args' && indent > sectionIndent) {
      const em = trimmed.match(/^([A-Za-z_]\w*)\s*:\s*(.*)$/);
      if (em) {
        if (argsEntries.some((e) => e.name === em[1])) {
          lastEntry = { name: em[1], buf: [], dead: true }; // 同名后续条目:连同续行丢弃(首个生效)
          continue;
        }
        const ne = { name: em[1], buf: em[2] ? [em[2]] : [] };
        argsEntries.push(ne);
        lastEntry = ne;
      } else if (lastEntry && !lastEntry.dead) {
        lastEntry.buf.push(trimmed);
      } else if (!lastEntry) {
        scatter.push(trimmed);
      }
      continue;
    }
    if (section === 'returns' && indent > sectionIndent) { returnsBuf.push(trimmed); continue; }
    if (section === 'other' && indent > sectionIndent) continue;
    // 缩退/自由行:节结束(若在节内),该行落散行。
    section = null;
    sectionIndent = -1;
    lastEntry = null;
    scatter.push(trimmed);
  }
  return { argsEntries, returnsText: returnsBuf.join(' ').trim(), scatter };
}

const PY_SIG_MAX_LINES = 100; // 跨行签名括号配对扫描上限(防失控;超限具名跳过)
const PY_NAME_RE = /^[A-Za-z_]\w*$/;

// 提取单个 Python 源文本。返回 {source, entries, skipped, notes}(与 extractTs 同形,
// 渲染/--json 字段零改动复用)。entries 按源码顺序;skipped/notes 同序(notes 再按行号
// 稳定排序)。输出确定性:不读取环境/时间,只依赖 source 文本。
export function extractPy(source, sourceName) {
  const lines = source.split(/\r?\n/);
  const entries = [];
  const skipped = [];
  const notes = [];
  const seenNames = new Set();
  const skip = (name, line, reason) => skipped.push({ name, line, reason });
  const note = (name, line, reason) => notes.push({ name, line, reason });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 只取顶层 def:缩进行(类方法/函数体)与空行静默不扫(ADR-018 §1:方法登记候选)。
    if (line === '' || line.startsWith(' ') || line.startsWith('\t')) continue;
    const t = line.trim();
    const asyncM = t.match(/^async\s+def\s+([A-Za-z_]\w*)/);
    if (asyncM) { skip(asyncM[1], i + 1, 'async 函数不在 MVP 范围(桥接只支持同步函数)'); continue; }
    const defM = t.match(/^def\s+([A-Za-z_]\w*)\s*\(/);
    if (!defM) continue;
    const name = defM[1];

    // ---- 签名收集:def 行 "(" 起,跨行括号配对(逐行剥 # 注释,引号感知)。
    let depth = 0;
    let paramText = '';
    let closeLineIdx = -1;
    let afterClose = '';
    let kk = i;
    let inside = false;
    for (; kk < lines.length && kk - i < PY_SIG_MAX_LINES; kk++) {
      const cur = kk === i ? t : lines[kk];
      const clean = pyStripComment(cur);
      const from = kk === i ? t.indexOf('(') : 0;
      let seg = '';
      let closedHere = false;
      for (let c = from; c < clean.length; c++) {
        const ch = clean[c];
        if (!inside) {
          if (ch === '(') { inside = true; depth = 1; }
          continue;
        }
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) { closedHere = true; afterClose = clean.slice(c + 1); break; }
        }
        seg += ch;
      }
      paramText += seg;
      if (closedHere) { closeLineIdx = kk; break; }
    }
    if (closeLineIdx < 0) {
      skip(name, i + 1, '签名括号不配对或跨行过长(MVP 只支持括号配对的签名)');
      // 未闭合签名不越过扫描窗(v1.6.0 复核 MINOR-1):其后的顶层 def 正常恢复扫描——
      // 坏签名体内的缩进行被顶层过滤器静默忽略,不会误扫。
      continue;
    }

    // ---- 右括号同行余部:可选 `-> 返回标注` + `:`(返回标注与冒号须与右括号同行;
    // `)` 后换行再写 `->` 的罕见形态 MVP 不支持,具名跳过)。
    const ac = afterClose.trim();
    const colonIdx = ac.indexOf(':');
    if (colonIdx < 0) { skip(name, i + 1, 'def 签名缺少冒号(形态不支持)'); i = closeLineIdx; continue; }
    const beforeColon = ac.slice(0, colonIdx).trim();
    let mappedRet = null;
    if (beforeColon === '') {
      skip(name, i + 1, '返回类型未显式标注(MVP 要求显式标注且可映射)');
      i = closeLineIdx;
      continue;
    }
    const arrowM = beforeColon.match(/^->\s*(.+)$/);
    if (!arrowM) {
      skip(name, i + 1, `右括号与冒号之间存在非返回标注文本("${beforeColon.slice(0, 40)}")`);
      i = closeLineIdx;
      continue;
    }
    mappedRet = mapPyType(arrowM[1]);
    if (mappedRet === null) {
      skip(name, i + 1, `返回类型 "${arrowM[1].replace(/\s+/g, ' ').trim().slice(0, 60)}" 不在映射表(MVP)`);
      i = closeLineIdx;
      continue;
    }

    if (seenNames.has(name)) {
      skip(name, i + 1, '重载/重复声明不在 MVP 范围(同名函数取首个)');
      i = closeLineIdx;
      continue;
    }

    // ---- 参数切分:顶层逗号;每片剥默认值(顶层 = 右侧丢弃,ADR-018);无注解/不可映射
    // 参数 → note 具名 + 不进桩(ADR-018 §1 口径:M3052 按桩内参数集对齐)。
    // 尾逗号容忍(剥一个):Python 多行签名/单行尾逗号是惯用法,与 TS 单行签名的
    // "尾逗号参数跳过"不同——这里按简单状态机口径吞掉,中段空参数位仍具名跳过。
    const params = [];
    let badParam = null;
    const trimmedParams = paramText.trim().replace(/,\s*$/, '');
    const pieces = trimmedParams === '' ? [] : splitTopLevel(trimmedParams, ',');
    for (const pieceRaw of pieces) {
      const piece = pieceRaw.trim();
      if (piece === '') { badParam = '参数形态不支持(空参数位)'; break; }
      if (piece === '*' || piece === '/') continue; // 位置/关键字标记位:仅标记,不是参数
      if (piece.startsWith('*')) { badParam = 'var-positional/var-keyword 参数(*args/**kwargs)不在 MVP 范围'; break; }
      const head = splitTopLevel(piece, '=')[0].trim();
      const pm = head.match(/^([A-Za-z_]\w*)\s*:\s*(.+)$/);
      if (!pm) {
        if (PY_NAME_RE.test(head)) {
          note(name, i + 1, `参数 "${head}" 无类型注解,该参数不进桩(MVP:未映射参数不进桩)`);
          continue;
        }
        badParam = `参数形态不支持("${piece.slice(0, 40)}")`;
        break;
      }
      const mapped = mapPyType(pm[2]);
      if (mapped === null) {
        note(name, i + 1, `参数 "${pm[1]}" 的类型 "${pm[2].replace(/\s+/g, ' ').trim().slice(0, 60)}" 不在映射表,该参数不进桩(MVP)`);
        continue;
      }
      params.push({ name: pm[1], type: mapped });
    }
    if (badParam) { skip(name, i + 1, badParam); i = closeLineIdx; continue; }

    // ---- docstring 捕获:签名结束行后的第一个非空/非注释行,以三引号起头才算
    // (r/f 前缀不算;docstring 之后的内容不参与)。闭合扫描直达文件尾:未闭合 → 具名
    // note(函数保留、契约放弃)并就此结束扫描——未闭合三引号在 Python 语义下吞掉
    // 其后全部源码,继续扫描只会产出假条目。
    let docText = null;
    let resumeLine = closeLineIdx;
    for (let di = closeLineIdx + 1; di < lines.length; di++) {
      const dt = lines[di].trim();
      if (dt === '' || dt.startsWith('#')) continue;
      if (!dt.startsWith('"""') && !dt.startsWith("'''")) { resumeLine = di - 1; break; }
      const delim = dt.slice(0, 3);
      const first = dt.slice(3);
      const endInFirst = first.indexOf(delim);
      if (endInFirst >= 0) { docText = first.slice(0, endInFirst); resumeLine = di; break; }
      const parts = [first];
      let closed = false;
      let mj = di + 1;
      for (; mj < lines.length; mj++) {
        const e2 = lines[mj].indexOf(delim);
        if (e2 >= 0) { parts.push(lines[mj].slice(0, e2)); resumeLine = mj; closed = true; break; }
        parts.push(lines[mj]);
      }
      if (closed) docText = parts.join('\n');
      else { note(name, i + 1, 'docstring 未闭合(至文件结束),该函数契约提取放弃'); resumeLine = lines.length - 1; }
      break;
    }

    // ---- 契约候选(ADR-018 §1):Args 各参数描述 → requires(协议 §3.2 顺序口径:
    // 参数声明序 × 描述内出现序);Returns 描述 → ensures(必须引用 result);
    // 散行 → requires(行序兜底;涉及 ≥1 参数才保留)。文本预改写:len(名) → 名.length、
    // `**` 幂折叠;随后逐字复用 TS 文法(extractInequalities)。
    const paramNames = params.map((p) => p.name);
    const vecParams = new Set(params.filter((p) => p.type.startsWith('Vec[')).map((p) => p.name));
    const allowed = { params: new Set(paramNames), vecParams, allowResult: false };
    const requires = [];
    const ensures = [];
    const seenReq = new Set();
    const pushReq = (clauses) => {
      for (const c of clauses) {
        if (seenReq.has(c)) continue;
        seenReq.add(c);
        requires.push(c);
      }
    };
    if (docText !== null) {
      const secs = parsePyDocSections(docText);
      const prep = (s) => pyFoldPowers(pyRewriteLenCalls(s));
      for (const p of params) {
        const entry = secs.argsEntries.find((e) => e.name === p.name);
        if (!entry) continue;
        const desc = entry.buf.join(' ').trim();
        if (desc === '') continue;
        pushReq(extractInequalities(prep(desc), allowed).clauses);
      }
      if (secs.returnsText !== '') {
        ensures.push(...extractInequalities(prep(secs.returnsText), { ...allowed, allowResult: true }).clauses);
      }
      for (const lineText of secs.scatter) {
        pushReq(extractInequalities(prep(lineText), allowed).clauses);
      }
    }
    entries.push({ name, line: i + 1, params, ret: mappedRet, requires, ensures, effects: [], taint: { return: false, params: [] } });
    seenNames.add(name);
    i = resumeLine;
  }
  // 注记按源行号升序(稳定排序,同行保持产生序)——与 TS 版口径一致。
  notes.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { source: sourceName, entries, skipped, notes };
}

// ---------- .mingi 渲染(确定性) ----------

// generator 文本由调用方给:TS 默认值逐字保持既有黄金;Python 侧传 --from py 变体
// (解析器把头部其余 // 行当注释忽略,消费侧零改动)。
export function renderMingi(fileResult, generator = '// generated by: ming bridge extract --from ts(MVP;格式规范见 docs/bridge-protocol.md)') {
  const out = [];
  out.push(`// mingi ${MINGI_VERSION}`);
  out.push(`// source: ${fileResult.source}`);
  out.push(generator);
  for (const s of fileResult.skipped) out.push(`// skipped: ${s.name} (line ${s.line}): ${s.reason}`);
  // note = 函数保留、但某个桥接元数据标注被丢弃(R-18;与 skipped 区分,不误读为函数跳过)。
  for (const n of fileResult.notes ?? []) out.push(`// note: ${n.name} (line ${n.line}): ${n.reason}`);
  for (const e of fileResult.entries) {
    out.push('');
    out.push(`fn ${e.name}(${e.params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${e.ret}`);
    out.push(`  // from ${fileResult.source}:${e.line}`);
    // 效果面(可选行;无效果声明的条目零输出——v1 形态与旧黄金逐字不变的来源)。
    if (e.effects?.length) out.push(`  effects ${e.effects.join(', ')}`);
    for (const c of e.requires) out.push(`  requires ${c}`);
    for (const c of e.ensures) out.push(`  ensures ${c}`);
  }
  out.push('');
  return out.join('\n');
}

// ---------- .mingi 解析(格式单一定义处:docs/bridge-protocol.md) ----------

// 解析 .mingi 文本。返回 {version, source, entries, errors};errors 非空 = 桩不可用
// (调用方按工具输入错误 exit 1 具名报告,不静默跳过)。
// v1.2.3(R-18):接受版本 1 与 2 —— v1 桩(无 effects 行)零改动可读;`effects` 行
// 只属于版本 2(出现在 v1 文件里按解析错误报告,不静默接受错版本形态)。
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
        // 参数切分括号感知(ADR-018 --from py 起,桩类型可含顶层逗号:Map[str,T] /
        // Option[Map[str,T]] / 元组形态——naive split 会把嵌套逗号误切为参数位)。
        // 无嵌套逗号的既有桩(TS 侧全形态)切分结果逐字不变。
        for (const piece of splitTopLevel(fnM[2], ',')) {
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
        requires: [], ensures: [], effects: [], from: null,
        line: i + 1, stub: displayName,
      };
      entries.push(cur);
      continue;
    }
    const ef = t.match(/^effects(?:\s+(.*))?$/);
    if (ef) {
      if (!cur) { errors.push({ line: i + 1, message: 'effects 行不属于任何函数条目' }); continue; }
      // 审查 NOTE-2:仅 v1 报"effects 行是 mingi 2 起"——不支持的版本(0/3+)交给版本错误单点报告。
      if (version === 1) {
        errors.push({ line: i + 1, message: 'effects 行是 mingi 2 起的格式,当前文件版本为 1' });
        continue;
      }
      if (!ef[1]) { errors.push({ line: i + 1, message: 'effects 行没有效果名' }); continue; }
      const names = [];
      let bad = null;
      for (const piece of ef[1].split(',')) {
        const nm = piece.trim();
        if (nm === '') continue;
        // 语法形态校验(小写字母起头 + 小写/数字/下划线);名字是否在 Ming 已知效果集内
        // 由 extract 侧校验,解析器不复制效果表(手工桩的未知名字如实透传到 stub_contract)。
        if (!/^[a-z][a-z0-9_]*$/.test(nm)) { bad = `effects 行的效果名不合法 "${nm.slice(0, 40)}"`; break; }
        if (!names.includes(nm)) names.push(nm);
      }
      if (bad) { errors.push({ line: i + 1, message: bad }); continue; }
      if (!names.length) { errors.push({ line: i + 1, message: 'effects 行没有效果名' }); continue; }
      // 多行合并(手工桩);出现序去重——与 extract 侧产物(0..1 行)口径一致。
      for (const nm of names) if (!cur.effects.includes(nm)) cur.effects.push(nm);
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
  else if (!MINGI_SUPPORTED_VERSIONS.includes(version)) errors.push({ line: 1, message: `不支持的 mingi 版本 ${version}(本工具支持 ${MINGI_SUPPORTED_VERSIONS.join('、')})` });
  return { version, source, entries, errors };
}

// 桩条目的污点标注(信息面):类型文本里的 `Untrusted[...]` 就是桩侧污点声明
// (extract 把 @taint 落进类型,载体等价比对自然生效;这里只把它投影成注记字段)。
export function entryTaint(entry) {
  const isU = (s) => /^Untrusted\[/.test(String(s));
  return {
    return: isU(entry.ret),
    params: entry.params.filter((p) => isU(p.type)).map((p) => p.name),
  };
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

// 收集提取输入(extract 侧):单文件 → [{abs, source=basename}];目录 → 递归收集指定
// 扩展名(跳过隐藏项与 SKIP_DIRS,相对路径码元序;source 用 '/' 分隔的相对路径,
// 输出目录内保留同一子目录结构——确定性且避免同名文件互相覆盖)。
// 注意 .d.ts 同样以 .ts 结尾,按 TS 文件处理(声明文件是契约提取的理想输入)。
// Python 侧(.py)额外跳过 venv/__pycache__:venv 内 site-packages 动辄数千 .py,
// 误吸入会产出海量无意义桩(与 TS 跳 node_modules 同理;登记于 ADR-018 口径)。
function walkFiles(dir, ext, out, extraSkip) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || (extraSkip && extraSkip.has(ent.name))) continue;
      walkFiles(full, ext, out, extraSkip);
    } else if (ent.isFile() && ent.name.endsWith(ext)) {
      out.push(full);
    }
  }
}

const PY_SKIP_DIRS = new Set(['node_modules', 'venv', '__pycache__']);

export function collectTsFiles(target) {
  const st = fs.statSync(target);
  if (st.isFile()) {
    return [{ abs: target, source: path.basename(target) }];
  }
  const out = [];
  walkFiles(target, '.ts', out, null);
  const list = out.map((abs) => ({ abs, source: displayPath(path.relative(target, abs)) }));
  return list.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

export function collectPyFiles(target) {
  const st = fs.statSync(target);
  if (st.isFile()) {
    return [{ abs: target, source: path.basename(target) }];
  }
  const out = [];
  walkFiles(target, '.py', out, PY_SKIP_DIRS);
  const list = out.map((abs) => ({ abs, source: displayPath(path.relative(target, abs)) }));
  return list.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

// 装载桩索引:Map<函数名, 条目>。目录内同名条目按路径码元序首个生效(规范 §9 第 9 条登记)。
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
          // v1.2.3(R-18)additive 注记:桩侧效果声明(元数据——extern fn 在 Ming 面隐含
          // ffi、无法再声明效果,受检查面在语言设计里不存在,故不做语言层核对:本字段
          // 供下游工具/Agent 消费)与桩侧污点标注(载体等价比对已覆盖判定,这里只如实呈现)。
          effects: (stubEntry.effects ?? []).slice(),
          taint: entryTaint(stubEntry),
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

// ---------- 契约满足性检查(S-5,ADR-015;MVP = b-lite) ----------
//
// 触发面(`ming check --stub`,消费点在 bin/ming.js):
//   每个 checked 模块内**指向同名 extern fn(且有桩)**的 Call 节点逐调用审查——
//   · 裸调用 `f(...)`:callee 为 Ident;模块级 items 命中 extern fn(词法遮蔽见下);
//   · `use` 引入的模块内调用 `m.f(...)`:callee 为 Field(Ident m),m 是本地模块绑定。
//   同一调用点至多 1 条 M3053。
//
// 可判条件(ADR-015 §3.2):桩 requires 的**每一条**子句都可解析且全部操作数可赋值。
//   操作数 = 调用实参字面量(IntLit/FloatLit/StrLit/BoolLit/一元负号字面量),
//   或 `len$x`(仅当实参是字面量 Vec——check 层实测可达,如 sz([1.0, 2.0]);
//   变量/表达式实参 → 长度不可得)。实参含变量/表达式/调用、子句不可解析、未知操作数、
//   实参个数与桩不符 → 整个调用点 unchecked(绝不猜)。
//
// 调用点归属:用 checker 真实解析结果做**节点身份扫描**(v0.64 嵌套 serve 两遍式先例的
//   只读变体——本模块不修改 checker,而是沿它的 Module/items/imports 与 AST 复刻
//   checker 的名字解析优先级:局部绑定(词法最近)> 模块 items > 内建。遮蔽判定取
//   保守口径:函数体内**任何位置**出现同名绑定(形参 / let / 本地 fn / match·for·
//   while-let 模式 / lambda 形参)→ 该名字在本函数内一律不归属模块级 extern,
//   不审查、不计数(只漏不误报;ADR-015 §5 风险表"误报优先防御")。
//
// 语义零变化:纯 check 面(不碰 tree/VM/wasm/cc),不把桩 requires 注入任何推导;
//   不带 --stub 时本函数不被调用。确定性:模块按 checked 顺序 × 加载序,函数体按源码序,
//   调用节点按固定子节点序遍历;同一物理模块(绝对路径)只扫描一次。

// requires 子句求值器只认本协议 §4.3/§5.1 文档化文法:
//   clause := operand (<|<=|>|>=) operand (same-op chain 允许,按相邻对求值)
//   operand := 十进制整数/小数字面量(可负,禁止 1_000/0x10/1e9 等非十进制形态)
//            | <桩参数名> | len$<桩参数名>
// 其他任何字符/形态 → null(整行不可解析 → 调用点 unchecked,不猜)。
const CLAUSE_IDENT = /^[A-Za-z_$][\w$]*$/;
const CLAUSE_INT = /^-?\d+$/;
const CLAUSE_FLOAT = /^-?\d+\.\d+$/;
const CLAUSE_OP_CH = '<>';

function tokenizeClause(text) {
  const toks = [];
  const isDigit = (c) => c >= '0' && c <= '9';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') { i += 1; continue; }
    if (CLAUSE_OP_CH.includes(c)) {
      if (text[i + 1] === '=') { toks.push({ t: 'op', v: c + '=' }); i += 2; }
      else { toks.push({ t: 'op', v: c }); i += 1; }
      continue;
    }
    // 负字面量:仅当 '-' 紧跟数字时并入 token(其余 '-' 是未知字符 → 不可解析)。
    let j = i;
    if (c === '-' && isDigit(text[i + 1] ?? '')) j += 1;
    if (isDigit(text[j] ?? '')) {
      let k = j;
      while (k < text.length && (isDigit(text[k]) || text[k] === '.' || text[k] === '_')) k += 1;
      toks.push({ t: 'num', v: text.slice(i, k) });
      i = k;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let k = i;
      while (k < text.length && /[A-Za-z0-9_$]/.test(text[k])) k += 1;
      toks.push({ t: 'id', v: text.slice(i, k) });
      i = k;
      continue;
    }
    return null; // 未知字符(含 `.` `[` `]` `+` `/` 等)→ 整行不可解析
  }
  return toks;
}

function parseClauseOperand(tok, paramSet) {
  if (tok.t === 'num') {
    if (CLAUSE_INT.test(tok.v)) return { kind: 'int', v: BigInt(tok.v), text: tok.v };
    if (CLAUSE_FLOAT.test(tok.v)) return { kind: 'float', v: Number(tok.v), text: tok.v };
    return null;
  }
  if (tok.t !== 'id') return null;
  const name = tok.v;
  if (name.startsWith('len$')) {
    const base = name.slice('len$'.length);
    if (!CLAUSE_IDENT.test(base) || !paramSet.has(base)) return null;
    return { kind: 'len', name: base, text: name };
  }
  // `result` 不是 requires 的合法操作数(入口处尚不存在;协议 §5.2)→ 不可判。
  if (name === 'result') return null;
  if (!paramSet.has(name)) return null;
  return { kind: 'param', name, text: name };
}

// 解析一条 requires 行 → {text, operands, ops} 或 null(不可解析)。
function parseRequiresClause(text, paramSet) {
  const toks = tokenizeClause(String(text));
  if (!toks || toks.length === 0) return null;
  const operands = [];
  const ops = [];
  let expectOperand = true;
  for (const tok of toks) {
    if (expectOperand) {
      if (tok.t === 'op') return null;
      const opd = parseClauseOperand(tok, paramSet);
      if (!opd) return null;
      operands.push(opd);
      expectOperand = false;
    } else {
      if (tok.t !== 'op') return null;
      ops.push(tok.v);
      expectOperand = true;
    }
  }
  if (expectOperand || ops.length === 0) return null; // 悬空操作符 / 无比较符
  return { text: String(text), operands, ops };
}

// 调用实参 → 字面量值(见 §3.2 可判条件)。非字面量/插值串/多级负号 → null。
function argLiteral(e) {
  if (!e) return null;
  switch (e.nt) {
    case 'IntLit': return { kind: 'int', v: e.v };
    case 'FloatLit': return { kind: 'float', v: e.v };
    case 'StrLit':
      // 纯字面量串:恰一个 lit 片段(`\{expr}` 插值串的 parts 含 expr,不是字面量)。
      if (e.parts?.length === 1 && Object.prototype.hasOwnProperty.call(e.parts[0], 'lit')) {
        return { kind: 'str', v: e.parts[0].lit };
      }
      return null;
    case 'BoolLit': return { kind: 'bool', v: e.v };
    case 'VecLit': return { kind: 'vec', len: e.elems?.length ?? 0 };
    case 'Unary': {
      if (e.op !== '-' || !e.expr) return null;
      const inner = argLiteral(e.expr);
      if (inner?.kind === 'int') return { kind: 'int', v: -inner.v };
      if (inner?.kind === 'float') return { kind: 'float', v: -inner.v };
      return null;
    }
    default: return null;
  }
}

function clauseValueText(v) {
  if (v.kind === 'int') return v.v.toString();
  if (v.kind === 'float') return String(v.v);
  if (v.kind === 'str') return JSON.stringify(v.v);
  if (v.kind === 'bool') return v.v ? 'true' : 'false';
  return `Vec(长度 ${v.len})`;
}

// 子句操作数 → 具体值。param/len 从调用点实参取;不可得 → null(调用点 unchecked)。
// subst:参数/长度符号 → 代入值文本(消息用;首个出现序,确定性)。
function evalClauseOperand(opd, stubEntry, args, subst) {
  if (opd.kind === 'int') return { kind: 'int', v: opd.v };
  if (opd.kind === 'float') return { kind: 'float', v: opd.v };
  const idx = stubEntry.params.findIndex((p) => p.name === opd.name);
  if (idx < 0 || idx >= args.length) return null;
  const lit = argLiteral(args[idx]);
  if (!lit) return null;
  let val;
  if (opd.kind === 'len') {
    // len$x 仅当对应实参是字面量 Vec(变量/表达式实参 → 长度不可得 → unchecked)。
    if (lit.kind !== 'vec') return null;
    val = { kind: 'int', v: BigInt(lit.len) };
  } else {
    val = lit;
  }
  if (!subst.has(opd.text)) subst.set(opd.text, clauseValueText(val));
  return val;
}

// 数值比较:两侧整数 → BigInt 精确;含 f64 → 仅当整数侧在 ±(2^53-1) 内可精确表示时
// 转 Number(其余不可判——精度取舍就是猜测)。str/bool/vec 不参与不等式 → null。
const SAFE_INT = 9007199254740991n;
function compareValues(l, op, r) {
  if (!l || !r) return null;
  const num = (x) => {
    if (x.kind === 'int') return x.v >= -SAFE_INT && x.v <= SAFE_INT ? Number(x.v) : null;
    if (x.kind === 'float') return x.v;
    return null;
  };
  if (l.kind === 'int' && r.kind === 'int') {
    const a = l.v, b = r.v;
    switch (op) {
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
      default: return null;
    }
  }
  const a = num(l), b = num(r);
  if (a === null || b === null) return null;
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return null;
  }
}

// 一条子句的求值:先解析全部操作数(任一不可得 → unchecked),再逐对比较。
// 返回 {status:'ok'} | {status:'violated', text, subst} | {status:'unchecked'}。
function evalRequiresClause(clause, stubEntry, args) {
  const subst = new Map();
  const vals = [];
  for (const opd of clause.operands) {
    const v = evalClauseOperand(opd, stubEntry, args, subst);
    if (v === null) return { status: 'unchecked' };
    vals.push(v);
  }
  for (let i = 0; i < clause.ops.length; i++) {
    const ok = compareValues(vals[i], clause.ops[i], vals[i + 1]);
    if (ok === null) return { status: 'unchecked' };
    if (!ok) return { status: 'violated', text: clause.text, subst };
  }
  return { status: 'ok' };
}

// 一个调用点的判定:桩带 ≥1 条 requires 才进入计数;任一行不可解析/不可判 → 整个
// 调用点 unchecked(MVP 只报告全可判的事实,不猜)。
function evaluateCallSite(args, stubEntry) {
  if (args.length !== stubEntry.params.length) return { status: 'unchecked' };
  const paramSet = new Set(stubEntry.params.map((p) => p.name));
  const violations = [];
  const seen = new Set();
  for (const text of stubEntry.requires) {
    if (seen.has(text)) continue;
    seen.add(text);
    const clause = parseRequiresClause(text, paramSet);
    if (!clause) return { status: 'unchecked' };
    const res = evalRequiresClause(clause, stubEntry, args);
    if (res.status === 'unchecked') return { status: 'unchecked' };
    if (res.status === 'violated') violations.push(res);
  }
  if (violations.length) return { status: 'violated', violations };
  return { status: 'ok' };
}

// ---- AST 行走(只读;节点形态以 src/parser.js 为准)----
// v 接口:{ onExpr(node), onName(name) }——绑定名收集与调用点收集复用同一遍历。
//
// v1.4 S-5 审查 MAJOR-1(裸崩面收口):遍历自带深度守卫——Binary/调用链是
// parseBinLevel 的**循环**产物(AST 深度 = 项数),parser 的 exprDepth 守卫管不到;
// 实测 3200 项左结合链在无守卫遍历下裸栈 RangeError(v0.73/0.75/0.76 裸崩面纪律同款)。
// 三重防御(方向一致:只漏不误报):
//   ① 调用方跳过 checker 的 depthBailed 声明(checker 已报 M4005;与 buildSummaryReport/
//      静态证明的 depthBailed 门槛同源,v0.75 纪律);
//   ② 本遍历器 depth 计数超限(WALK_DEPTH_LIMIT)即返回 false(对称放弃)——调用方把
//      整个函数视为不可审查:不审查、不计数;
//   ③ 调用方 try/catch RangeError 兜底(理论不可达;不让裸栈穿出工具)。
const WALK_DEPTH_LIMIT = 500; // 合法语料实测最大嵌套 12 层;checker 表达式守卫 450 同量级

function walkScopedBlock(block, v, depth = 0) {
  if (!block) return true;
  if (depth > WALK_DEPTH_LIMIT) return false;
  for (const s of block.stmts ?? []) {
    if (!walkScopedStmt(s, v, depth + 1)) return false;
  }
  if (block.tail) return walkScopedExpr(block.tail, v, depth + 1);
  return true;
}

function bindPatternNames(p, v, depth = 0) {
  if (!p) return true;
  if (depth > WALK_DEPTH_LIMIT) return false;
  if (p.nt === 'PIdent') { v.onName(p.name); return true; }
  if (p.nt === 'PTuple') {
    for (const q of p.pats ?? []) if (!bindPatternNames(q, v, depth + 1)) return false;
    return true;
  }
  if (p.nt === 'PEnum') {
    for (const q of p.args ?? []) if (!bindPatternNames(q, v, depth + 1)) return false;
    return true;
  }
  // PWild / PLit:无绑定
  return true;
}

function walkScopedStmt(s, v, depth = 0) {
  if (!s) return true;
  if (depth > WALK_DEPTH_LIMIT) return false;
  switch (s.nt) {
    case 'Let':
      if (!bindPatternNames(s.pat, v, depth + 1)) return false;
      return s.init ? walkScopedExpr(s.init, v, depth + 1) : true;
    case 'ExprStmt': return walkScopedExpr(s.expr, v, depth + 1);
    case 'Return': return s.value ? walkScopedExpr(s.value, v, depth + 1) : true;
    case 'Assign':
      return walkScopedExpr(s.target, v, depth + 1) && walkScopedExpr(s.value, v, depth + 1);
    case 'While':
      return walkScopedExpr(s.cond, v, depth + 1) && walkScopedBlock(s.body, v, depth + 1);
    case 'WhileLet':
      return bindPatternNames(s.pat, v, depth + 1)
        && walkScopedExpr(s.expr, v, depth + 1)
        && walkScopedBlock(s.body, v, depth + 1);
    case 'For':
      return bindPatternNames(s.pat, v, depth + 1)
        && walkScopedExpr(s.iter, v, depth + 1)
        && walkScopedBlock(s.body, v, depth + 1);
    case 'Loop':
    case 'UnsafeBlock':
    case 'SyncScopeBlock':
      return walkScopedBlock(s.body, v, depth + 1);
    case 'FnStmt':
      v.onName(s.decl?.name);
      for (const p of s.decl?.params ?? []) v.onName(p.name);
      return walkScopedBlock(s.decl?.body, v, depth + 1);
    case 'AsmBlock':
      // asm 的 out/in 只含名字或完整表达式;模板/clobber 是字面量(无绑定/无调用点)。
      for (const x of s.ins ?? []) if (!walkScopedExpr(x.value, v, depth + 1)) return false;
      return true;
    case 'Break':
    case 'Continue':
      return true;
    default:
      // If/Match/BlockExpr/LoopExpr 作语句时由 finishExprStmt 包成 ExprStmt;
      // 其余未知节点按无子节点处理(保守:不深入 → 只可能漏报,不会误报)。
      return true;
  }
}

function walkScopedExpr(e, v, depth = 0) {
  if (!e) return true;
  if (depth > WALK_DEPTH_LIMIT) return false;
  v.onExpr(e);
  switch (e.nt) {
    case 'Call':
      if (!walkScopedExpr(e.callee, v, depth + 1)) return false;
      for (const a of e.args ?? []) if (!walkScopedExpr(a, v, depth + 1)) return false;
      return true;
    case 'Field': return walkScopedExpr(e.base, v, depth + 1);
    case 'Index':
      return walkScopedExpr(e.base, v, depth + 1) && walkScopedExpr(e.index, v, depth + 1);
    case 'Binary':
      return walkScopedExpr(e.l, v, depth + 1) && walkScopedExpr(e.r, v, depth + 1);
    case 'Unary':
    case 'PostQ':
    case 'As':
      return walkScopedExpr(e.expr, v, depth + 1);
    case 'Range':
      return walkScopedExpr(e.lo, v, depth + 1) && walkScopedExpr(e.hi, v, depth + 1);
    case 'TupleLit':
    case 'VecLit':
      for (const x of e.elems ?? []) if (!walkScopedExpr(x, v, depth + 1)) return false;
      return true;
    case 'MapLit':
      for (const en of e.entries ?? []) {
        if (!walkScopedExpr(en.k, v, depth + 1) || !walkScopedExpr(en.v, v, depth + 1)) return false;
      }
      return true;
    case 'StructLit':
      for (const f of e.fields ?? []) if (!walkScopedExpr(f.value, v, depth + 1)) return false;
      return true;
    case 'StrLit':
      for (const p of e.parts ?? []) if (p.expr && !walkScopedExpr(p.expr, v, depth + 1)) return false;
      return true;
    case 'If':
      if (!walkScopedExpr(e.cond, v, depth + 1)) return false;
      if (!walkScopedBlock(e.then, v, depth + 1)) return false;
      if (!e.els) return true;
      return e.els.nt === 'If' ? walkScopedExpr(e.els, v, depth + 1) : walkScopedBlock(e.els, v, depth + 1);
    case 'Match':
      if (!walkScopedExpr(e.scrutinee, v, depth + 1)) return false;
      for (const arm of e.arms ?? []) {
        if (!bindPatternNames(arm.pat, v, depth + 1)) return false;
        if (arm.guard && !walkScopedExpr(arm.guard, v, depth + 1)) return false;
        if (!walkScopedExpr(arm.expr, v, depth + 1)) return false;
      }
      return true;
    case 'BlockExpr':
      return walkScopedBlock(e.block, v, depth + 1);
    case 'LoopExpr':
      return walkScopedBlock(e.body, v, depth + 1);
    case 'Lambda':
      for (const p of e.params ?? []) v.onName(p.name);
      return walkScopedExpr(e.body, v, depth + 1);
    default:
      // Ident / IntLit / FloatLit / BoolLit 等叶子
      return true;
  }
}

// 调用点归属:复刻 checker.checkCall 的名字解析优先级(局部 > 模块 items > 内建)。
// `m.f(...)`(Field + 本地模块绑定)分支是**防御性保留**:extern fn 永非 pub(parser
// `pub` 白名单只允许 fn/struct/enum/const;checker 注册 extern 时 pub:false),跨模块
// 访问必先 M3001,其 span 为 callee(止于 "(")与 Call span 起点相接 → 毒化跳过;
// 该分支只在未来可见性口径变化时才有活路(当前不可达,文档 §7.1 如实登记)。
function resolveExternStub(call, mod, bound, stubIndex) {
  const callee = call.callee;
  if (!callee) return null;
  if (callee.nt === 'Ident') {
    if (bound.has(callee.name)) return null; // 词法遮蔽 → 不是该 extern 的调用点
    const entry = mod.items.get(callee.name);
    if (!entry || entry.kind !== 'fn' || !entry.extern) return null;
    return { name: callee.name, stub: stubIndex.get(callee.name) ?? null };
  }
  if (callee.nt === 'Field' && callee.base?.nt === 'Ident') {
    const base = callee.base.name;
    if (bound.has(base)) return null; // 局部值遮蔽导入绑定 → 方法调用
    const imp = mod.imports.get(base);
    if (!imp || !imp.local) return null; // std 模块 / 非导入基名 → 非 extern 调用点
    const entry = imp.local.items.get(callee.name);
    if (!entry || entry.kind !== 'fn' || !entry.extern) return null;
    return { name: callee.name, stub: stubIndex.get(callee.name) ?? null };
  }
  return null;
}

// 对全部 checked 模块做调用点扫描(每物理模块只扫一次;多入口共享模块不重复计数)。
// 返回 {diags, contracts:{checked, violated, unchecked}};contracts 是 `--json` 的
// additive 计数(ADR-015 §3.3):checked = 判定满足的调用点数,violated = 违反数,
// unchecked = 不可判数——三者互斥,和 = 审查覆盖的调用点总数(仅桩带 ≥1 条 requires)。
export function checkContractSatisfaction(checked, stubIndex) {
  const diags = [];
  const contracts = { checked: 0, violated: 0, unchecked: 0 };
  // 毒化跳过(v0.67 诊断纪律;与 M3052 的 skipped_poisoned 同源):调用表达式与既有
  // error 级诊断 overlap 时表达式不可信——不审查、不计数,根因诊断优先。
  const errorSpans = [];
  for (const result of checked) {
    for (const d of result.diags ?? []) if (d.severity === SEVERITY.ERROR && d.span) errorSpans.push(d.span);
  }
  const seenModules = new Set();
  const seenSites = new Set(); // 绝对路径 + 调用 span + 目标名(双保险;跨入口去重)

  // 单个调用点审查(modKey 用于站点去重键;errorSpans/seenSites/契约计数共享)。
  const reviewCall = (mod, modKey, call, bound) => {
    const target = resolveExternStub(call, mod, bound, stubIndex);
    if (!target?.stub || !(target.stub.requires?.length)) return; // 无桩/无 requires → 无契约可判
    if (errorSpans.some((sp) => spanOverlaps(call.span, sp))) return; // 毒化跳过
    const siteKey = `${modKey}\u0000${call.span?.line ?? 0}:${call.span?.col ?? 0}\u0000${target.name}`;
    if (seenSites.has(siteKey)) return;
    seenSites.add(siteKey);
    const res = evaluateCallSite(call.args ?? [], target.stub);
    if (res.status === 'unchecked') { contracts.unchecked += 1; return; }
    if (res.status === 'ok') { contracts.checked += 1; return; }
    contracts.violated += 1;
    // 同一调用点至多 1 条 M3053:全部违反子句列入 message(顺序 = 桩 requires 序)。
    const detail = res.violations.map((v) => {
      const sub = [...v.subst.entries()].map(([n, val]) => `${n} = ${val}`).join(', ');
      return sub ? `"${v.text}" 代入 ${sub}` : `"${v.text}"`;
    }).join(';');
    diags.push(err('M3053',
      `桥接契约违例:extern 函数 "${target.name}" 的调用不满足契约桩 ${target.stub.stub}:${target.stub.line} 的 requires——${detail}`,
      call.span));
  };

  for (const result of checked) {
    const bailed = result.depthBailed ?? new Set(); // ① 已报 M4005 的顶层声明不碰
    for (const mod of result.modules ?? []) {
      const modKey = mod.absPath ?? mod.file;
      if (seenModules.has(modKey)) continue;
      seenModules.add(modKey);
      for (const item of mod.program?.items ?? []) {
        let bodies;
        if (item.nt === 'FnDecl' || item.nt === 'TestDecl') bodies = [{ params: item.params ?? [], body: item.body, decl: item }];
        else if (item.nt === 'ImplDecl') bodies = (item.methods ?? []).map((m) => ({ params: m.params ?? [], body: m.body, decl: m }));
        else continue;
        for (const { params, body, decl } of bodies) {
          if (!body || bailed.has(decl)) continue;
          // 第一遍:保守收集函数体内任何位置的绑定名(遮蔽 → 不归属模块级 extern)。
          // ② 深度超限 → 整个函数不审查、不计数(只漏不误报)。
          const bound = new Set();
          for (const p of params) bound.add(p.name);
          try {
            const bindOk = walkScopedBlock(body, { onExpr: () => {}, onName: (n) => { if (n) bound.add(n); } });
            if (!bindOk) continue;
            // 第二遍:按源码序审查调用点(同树同限深,bindOk 已保证不会超限)。
            walkScopedBlock(body, {
              onName: () => {},
              onExpr: (e) => { if (e.nt === 'Call') reviewCall(mod, modKey, e, bound); },
            });
          } catch (e) {
            // ③ 纵深防御:遍历器/求值器内部 RangeError → 具名跳过该函数,不让裸栈穿出。
            if (!(e instanceof RangeError)) throw e;
          }
        }
      }
    }
  }
  return { diags, contracts };
}
