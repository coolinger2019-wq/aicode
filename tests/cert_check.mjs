// tests/cert_check.mjs — 自产线性证书的**独立参考检查器**(v1.3.0 S-3a,ADR-014 §6.2)。
//
// 职责:不信任证书里声明的任何数字——从**另一件工件**(同语料的 `--proof-format smt-lib` 脚本)
// 重新解析每个方向块的断言、**重算归一**、重算恒等式,再与证书声明的 `norm:` 行对照。
// 判据(规范 docs/proof-protocol.md §10):
//   每条引用约束规范为 `Σ c_i x_i <= K_i`;存在非负整数 λ 使 `Σ λ_i c_i = 0`(逐变量恒等)
//   且 `Σ λ_i K_i < 0` ⇒ 编码后的约束集在整数域不可满足。
//
// 三阶段(z3_check.mjs 同款风格;本脚本**不需要外部求解器**,阶段 C 恒执行):
//   A. 生成 + 结构断言:内联语料写临时目录 → `ming check <语料...> --proof-format cert`
//      (相对路径 + cwd=TMP,使文件分节注释稳定为 `; ===== 文件:<name>.ming =====`)
//      → 逐义务逐方向断言(verdict / refs 数 / uses_goal / vacuous / 无证书具名)。
//   B. fixture 黄金:生成文本 vs tests/cert_fixtures/<slug>.cert(缺失/不一致 = 失败;
//      默认**严格逐字节**;`--update-fixtures` 为唯一更新通道;孤儿 fixture 判失败)。
//   C. 独立复核 + 三负例:
//      C1 逐引用:按(文件节, vc, dir)定位 SMT 方向块;断言序号在块内、归一方向在 0..1、
//         **按 SMT 断言重算**归一后的行、与证书声明逐项相等(声明系数被篡改 → 失败);
//      C2 恒等式:重算 Σc(逐变量为 0)与 ΣK(< 0),并与证书自述 identity 的 ΣK 对照;
//         uses_goal 由引用与末条断言(`#<块内断言数>`)的机械对应核验;
//      C3 三负例(篡改系数 / 引用块外约束 / 漏引用)必须全部**因对应判据**被判失败——
//         负例若被"通过"或"因无关原因被拒",说明检查器失去判别力,本身即失败。
//
// 明确不校验(能力边界,协议 §9/§10.4 登记):**vacuous 不重算**(无独立来源,只核字段存在);
//   **文件节的路径正确性不核**(文件节只作配对键);源码 → 约束的忠实性不在本脚本(§7 受信基座)。
//
// 用法:node tests/cert_check.mjs [--update-fixtures] [--help]
// 退出码:0 = 全部通过;1 = 断言/黄金/复核/负例任一失败,或管线错误。
// 纪律:零第三方依赖;确定性;fixture 用 LF;错误走 stderr;失败 exit 1;成功即清理临时目录。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'cert_fixtures');
const SPAWN_TIMEOUT_MS = 120000;
const DIFF_CLIP = 220;

const USAGE = [
  '用法:node tests/cert_check.mjs [--update-fixtures] [--help]',
  '',
  '自产线性证书的独立参考检查器(规范 docs/proof-protocol.md §10):',
  '  A. ming check <语料> --proof-format cert 生成证书 + 逐方向结构断言;',
  '  B. 生成文本 vs tests/cert_fixtures/<slug>.cert(缺失/不一致 = 失败,严格逐字节);',
  '  C. 独立复核:从同语料的 smt-lib 脚本重算归一与恒等式,并跑三负例',
  '     (篡改系数 / 引用块外约束 / 漏引用——必须全部因对应判据被判失败)。',
  '',
  '  --update-fixtures  重新生成并写入 fixtures 目录(显式更新通道;逐文件打印 新增/变更/未变)',
  '',
  '说明:证书文本是纯注释面(所有行以 ; 起行),因此不提供 --no-comments 模式。',
].join('\n');

// ---- 语料矩阵 -------------------------------------------------------------------------------
// files = 参与一次 check 的源文件(命令行序);obligations = 期望的义务节(与证书文本同序):
//   { file: 文件节展示路径, vc: 'vc:<fn>:<n>', dirs: [low, high] }
//   dirs 每项 = [verdict, refs 数|null, uses_goal|null, vacuous|null]
//   refs 为 null 表示该方向无证书(proven 时具名标注;非 proven 时如实 unknown/refuted)。
// 语料都从既有四证语料(proven / refuted / unknown / loop)派生,不引入新语言面。
const OK_SRC = [
  'fn get(buf: Vec[i64], i: i64) -> i64 requires i >= 0 && i < buf.len() {',
  '    return buf[i];',
  '}',
  'fn main() with io { print(str(get([1, 2], 1))); }',
].join('\n');

const CORPORA = [
  {
    slug: 'proven',
    name: 'proven 语料(requires 双向蕴含;两条 2 引用证书)',
    files: [{ name: 'proven.ming', source: OK_SRC }],
    expectExit: 0,
    obligations: [{ file: 'proven.ming', vc: 'vc:get:1', dirs: [['proven', 2, true, false], ['proven', 2, true, false]] }],
  },
  {
    slug: 'loop',
    name: 'loop 作用域 proven(n == len 拆双向 + 区间约束;high 3 引用)',
    files: [{
      name: 'loop.ming',
      source: [
        'fn sum(buf: Vec[i64], n: i64) -> i64 requires n == buf.len() {',
        '    let mut s = 0;',
        '    for i in 0..n { s += buf[i]; }',
        '    return s;',
        '}',
        'fn main() with io { print(str(sum([1, 2, 3], 3))); }',
      ].join('\n'),
    }],
    expectExit: 0,
    obligations: [{ file: 'loop.ming', vc: 'vc:sum:1', dirs: [['proven', 2, true, false], ['proven', 3, true, false]] }],
  },
  {
    slug: 'vacuous',
    name: 'vacuous 语料(空区间 0..0;eff 自身矛盾 ⇒ vacuous:true,uses_goal:false)',
    files: [{
      name: 'vacuous.ming',
      source: [
        'fn f(buf: Vec[i64], n: i64) -> i64 requires n >= 0 {',
        '    let mut s = 0;',
        '    for k in 0..0 { s += buf[k]; }',
        '    return s;',
        '}',
        'fn main() with io { print(str(f([1, 2], 2))); }',
      ].join('\n'),
    }],
    expectExit: 0,
    obligations: [{ file: 'vacuous.ming', vc: 'vc:f:1', dirs: [['proven', 2, false, true], ['proven', 2, false, true]] }],
  },
  {
    slug: 'const',
    name: '常量索引语料(proven 但无单一负环 ⇒ 具名"无证书";high unknown)',
    files: [{
      name: 'const.ming',
      source: [
        'fn c(buf: Vec[i64], n: i64) -> i64 requires n >= 0 {',
        '    return buf[0];',
        '}',
        'fn main() with io { print(str(c([1, 2], 2))); }',
      ].join('\n'),
    }],
    expectExit: 0,
    obligations: [{ file: 'const.ming', vc: 'vc:c:1', dirs: [['proven', null, null, false], ['unknown', null, null, null]] }],
  },
  {
    slug: 'eqsplit',
    name: '== 拆分语料(i >= 0 && n == i;证书引用 == 的 d1 方向 = 反向归一)',
    files: [{
      name: 'eqsplit.ming',
      source: [
        'fn eq(buf: Vec[i64], n: i64, i: i64) -> i64 requires i >= 0 && n == i {',
        '    return buf[n];',
        '}',
        'fn main() with io { print(str(eq([1, 2], 0, 0))); }',
      ].join('\n'),
    }],
    expectExit: 0,
    obligations: [{ file: 'eqsplit.ming', vc: 'vc:eq:1', dirs: [['proven', 3, true, false], ['unknown', null, null, null]] }],
  },
  {
    slug: 'chain',
    name: '链式语料(4 引用证书;两次 == 拆分各取一方向)',
    files: [{
      name: 'chain.ming',
      source: [
        'fn ch(buf: Vec<i64>, n: i64, i: i64, m: i64) -> i64 requires i >= 0 && m == n && n == i {',
        '    return buf[m];',
        '}',
        'fn main() with io { print(str(ch([1, 2], 2, 0, 0))); }',
      ].join('\n').replace('Vec<i64>', 'Vec[i64]'),
    }],
    expectExit: 0,
    obligations: [{ file: 'chain.ming', vc: 'vc:ch:1', dirs: [['proven', 4, true, false], ['unknown', null, null, null]] }],
  },
  {
    // 多文件(审查 m5):两个文件同名 fn 同序号 → 证书与 SMT 脚本里都出现两个 `vc:get:1`,
    // 只能按**文件节**配对;按 (vc, dir) 配对会把第二个误判为"块重复"。
    slug: 'multifile',
    name: '多文件语料(两文件同名 fn 同序号 vc:get:1;按文件节配对而非 (vc,dir))',
    files: [{ name: 'a.ming', source: OK_SRC }, { name: 'b.ming', source: OK_SRC }],
    expectExit: 0,
    obligations: [
      { file: 'a.ming', vc: 'vc:get:1', dirs: [['proven', 2, true, false], ['proven', 2, true, false]] },
      { file: 'b.ming', vc: 'vc:get:1', dirs: [['proven', 2, true, false], ['proven', 2, true, false]] },
    ],
  },
];

// ---- 工具函数 -------------------------------------------------------------------------------
function relPath(abs) { return path.relative(ROOT, abs).split(path.sep).join('/'); }
function fixturePath(slug) { return path.join(FIXTURE_DIR, `${slug}.cert`); }
function fixtureRel(slug) { return relPath(fixturePath(slug)); }
function clip(line) {
  if (line === undefined) return '(EOF:该行不存在)';
  return line.length > DIFF_CLIP ? `${line.slice(0, DIFF_CLIP - 1)}…` : line;
}
function firstDiff(expected, actual) {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i += 1) if (e[i] !== a[i]) return { line: i + 1, expected: e[i], actual: a[i] };
  return null;
}

// ---- SMT-LIB 最小解析(只消费 proofsmt.js 的输出面:文件节/push/declare/assert/check-sat/pop)--
// 解析为逐方向块:{file, vc, dir, verdict, asserts: [pred 文本...]},顺序 = 脚本块序。
// file = 该块所属的 `; ===== 文件:... =====` 节(多文件工件里 (vc, dir) 会重复,必须带上它)。
export function parseSmtBlocks(text) {
  const blocks = [];
  let curFile = null;
  let curVc = null;
  let pendingDir = null;
  let pendingVerdict = null;
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const fm = line.match(/^; ===== 文件:(.+) =====$/);
    if (fm) { curFile = fm[1]; curVc = null; continue; }
    const vm = line.match(/^; ---- vc:([^:]+):(\d+) —/);
    if (vm) { curVc = `vc:${vm[1]}:${vm[2]}`; pendingDir = null; continue; }
    const dm = line.match(/^; 方向 (low|high) — ming 内部判定: (proven|refuted|unknown)/);
    if (dm) { pendingDir = dm[1]; pendingVerdict = dm[2]; continue; }
    if (line === '(push)') { cur = { file: curFile, vc: curVc, dir: pendingDir, verdict: pendingVerdict, asserts: [] }; blocks.push(cur); pendingDir = null; continue; }
    if (line === '(pop)') { cur = null; continue; }
    if (cur && line.startsWith('(assert ')) cur.asserts.push(line.slice('(assert '.length, -1).trim());
  }
  return blocks;
}

// S-表达式 → 嵌套数组/原子(字符串字面量不在断言面出现;proofsmt 的断言只有符号与数字)。
function sexpParse(text) {
  const toks = [];
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '(' || ch === ')') { toks.push(ch); i += 1; continue; }
    let j = i;
    while (j < text.length && !/[\s()]/.test(text[j])) j += 1;
    toks.push(text.slice(i, j));
    i = j;
  }
  let p = 0;
  const parse = () => {
    if (toks[p] === '(') {
      p += 1;
      const out = [];
      while (p < toks.length && toks[p] !== ')') out.push(parse());
      if (toks[p] !== ')') throw new Error('S-表达式括号不配平');
      p += 1;
      return out;
    }
    const t = toks[p];
    p += 1;
    if (t === undefined || t === ')') throw new Error('S-表达式意外结束');
    return t;
  };
  const out = [];
  while (p < toks.length) out.push(parse());
  return out;
}

const ZERO = { coeffs: new Map(), c: 0n };
function linAddRow(a, b, sign) {
  const out = { coeffs: new Map(a.coeffs), c: a.c + sign * b.c };
  for (const [k, v] of b.coeffs) {
    const nv = (out.coeffs.get(k) ?? 0n) + sign * v;
    if (nv === 0n) out.coeffs.delete(k); else out.coeffs.set(k, nv);
  }
  return out;
}
function linScale(a, k) {
  const out = { coeffs: new Map(), c: a.c * k };
  for (const [kk, v] of a.coeffs) out.coeffs.set(kk, v * k);
  return out;
}
function linNeg(a) { return linScale(a, -1n); }

// 线性项 → {coeffs: Map, c}(+ - *(常量×变量);数字字面量按十进制整数;负数用 (- n) 一元减)。
function linOfTerm(t) {
  if (Array.isArray(t)) {
    const [head, ...args] = t;
    if (head === '+') {
      let acc = ZERO;
      for (const a of args) acc = linAddRow(acc, linOfTerm(a), 1n);
      return acc;
    }
    if (head === '-') {
      if (args.length === 1) return linNeg(linOfTerm(args[0]));
      if (args.length === 2) return linAddRow(linOfTerm(args[0]), linOfTerm(args[1]), -1n);
      throw new Error(`不支持的 '-' 元数:${args.length}`);
    }
    if (head === '*') {
      if (args.length !== 2) throw new Error(`不支持的 '*' 元数:${args.length}`);
      const a = args[0];
      const b = args[1];
      const isNum = (x) => typeof x === 'string' && /^\d+$/.test(x);
      if (isNum(a)) return linScale(linOfTerm(b), BigInt(a));
      if (isNum(b)) return linScale(linOfTerm(a), BigInt(b));
      throw new Error('乘法只支持常量×变量');
    }
    throw new Error(`未知运算:${head}`);
  }
  if (/^\d+$/.test(t)) return { coeffs: new Map(), c: BigInt(t) };
  if (/^-?\d+$/.test(t)) throw new Error(`数字字面量带符号(协议只发 (- n)):${t}`);
  return { coeffs: new Map([[t, 1n]]), c: 0n };
}

// 比较谓词 → 归一后的行数组(独立实现,不 import src/prover.js —— 这正是"复核"的意义)。
//   (<= a b) → a-b <= 0 ;(< a b) → a-b <= -1 ;(>= a b)/(> a b) 取反对称 ;(= a b) 拆双向。
const DUAL = { '>=': '<', '<': '>=', '<=': '>', '>': '<=' };
function rowsOfPredicate(pred) {
  let node = pred;
  let negated = false;
  while (Array.isArray(node) && node[0] === 'not') { negated = !negated; node = node[1]; }
  if (!Array.isArray(node) || node.length !== 3) throw new Error('谓词形状不是 (op a b)');
  let [op, lhsT, rhsT] = node;
  if (negated) {
    if (op === '=') throw new Error('not (= a b) 不可归一为单个线性约束');
    op = DUAL[op];
    if (!op) throw new Error(`未知比较符:${node[0]}`);
  }
  if (!['=', '<', '<=', '>', '>='].includes(op)) throw new Error(`未知比较符:${op}`);
  const d = linAddRow(linOfTerm(lhsT), linOfTerm(rhsT), -1n); // d = lhs - rhs
  switch (op) {
    case '<=': return [{ coeffs: new Map(d.coeffs), K: -d.c }];
    case '<': return [{ coeffs: new Map(d.coeffs), K: -d.c - 1n }];
    case '>=': return [{ coeffs: new Map([...d.coeffs].map(([k, v]) => [k, -v])), K: d.c }];
    case '>': return [{ coeffs: new Map([...d.coeffs].map(([k, v]) => [k, -v])), K: d.c - 1n }];
    case '=': return [
      { coeffs: new Map(d.coeffs), K: -d.c },
      { coeffs: new Map([...d.coeffs].map(([k, v]) => [k, -v])), K: d.c },
    ];
    default: throw new Error(`未知比较符:${op}`);
  }
}

// ---- 证书文本解析(纯注释面;严格前缀文法,未知行 = 错误)------------------------------------
const CERT_HEAD = '; ===== Ming 线性不可满足证书(cert v1)=====';
const NO_CERT_PREFIX = '; 无证书:';
export const NO_CERT_REASONS = new Set([
  'refuted 方向无不可满足性证书(内部判定:违反方向被假设集强制)',
  '内部未判定(unknown;目标未编码或超出差分片段)',
  '常量矛盾(constFalse;LHS 为空的单条矛盾断言,v1 不渲染该形态)',
  '判定来源无单一负环(防御路径;cycle 为空)',
  '目标为 == 双向拆分证明(两向各自成立,无单一负环)',
  '目标取反为合取(!=;无单一负环)',
  '该方向的假设集含不可渲染为 SMT 断言的形态(!= 等),断言序号无法与 smt-lib 块对齐(v1 不产证书)',
  '证书数据缺失(内部一致性缺口——不应出现,请报告)',
]);

function parseRowText(body) {
  // body = "{i: 1, len$buf: -1} <= -1" 的右半部分已切出:{...} 部分 + K
  const m = body.match(/^\{(.*)\} <= (-?\d+)$/);
  if (!m) throw new Error(`norm 行形状不符:${body}`);
  const coeffs = new Map();
  const inner = m[1].trim();
  if (inner !== '') {
    for (const part of inner.split(',')) {
      const pm = part.trim().match(/^(\S+): (-?\d+)$/);
      if (!pm) throw new Error(`norm 系数项形状不符:${part}`);
      coeffs.set(pm[1], BigInt(pm[2]));
    }
  }
  return { coeffs, K: BigInt(m[2]) };
}

export function parseCertText(text) {
  const lines = text.split('\n');
  if (lines[0] !== CERT_HEAD) throw new Error(`首行不是证书头(得到 ${JSON.stringify(lines[0])})`);
  const out = []; // [{file, vc, scope, idxText, dirs: [...]}]
  let curFile = null;
  let curOb = null;
  let curDir = null;
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === '') continue;
    if (!raw.startsWith(';')) throw new Error(`第 ${i + 1} 行不是注释面(证书全部以 ; 起行):${JSON.stringify(clip(raw))}`);
    if (raw === '; 无证明义务') continue; // 零义务(无 dir 上下文时合法)
    let m;
    if ((m = raw.match(/^; ===== 文件:(.+) =====$/))) { curFile = m[1]; curOb = null; curDir = null; continue; }
    if ((m = raw.match(/^; ---- vc:([^:]+):(\d+) — 索引 (.*)\(scope: (body|loop)\)----$/))) {
      curOb = { file: curFile, vc: `vc:${m[1]}:${m[2]}`, idxText: m[3], scope: m[4], dirs: [] };
      out.push(curOb);
      curDir = null;
      continue;
    }
    if ((m = raw.match(/^; dir: (low|high)$/))) {
      if (curOb === null) throw new Error(`第 ${i + 1} 行 dir 不在任何义务节内`);
      curDir = { dir: m[1], verdict: null, usesGoal: null, vacuous: null, refs: null, refLines: [], identityK: null, identityCoeffText: null, noCert: null };
      curOb.dirs.push(curDir);
      continue;
    }
    if (raw.startsWith('; spec:') || raw.startsWith('; 判据:') || raw.startsWith('; 归一:') || raw.startsWith('; 覆盖边界:')
      || raw.startsWith('; 有效性:') || raw.startsWith('; 引用序号')) continue; // 头注(文件节之前)
    if (curDir === null) throw new Error(`第 ${i + 1} 行不属于任何方向节:${JSON.stringify(clip(raw))}`);
    if ((m = raw.match(/^; verdict: (proven|refuted|unknown)$/))) { curDir.verdict = m[1]; continue; }
    if ((m = raw.match(/^; uses_goal: (true|false|n\/a)$/))) { curDir.usesGoal = m[1] === 'n/a' ? null : m[1] === 'true'; continue; }
    if ((m = raw.match(/^; vacuous: (true|false)$/))) { curDir.vacuous = m[1] === 'true'; continue; }
    if ((m = raw.match(/^; refs: (\d+)$/))) { curDir.refs = Number(m[1]); continue; }
    if ((m = raw.match(/^; ref (\d+): #(\d+) d(\d) \| norm: (.*) \| λ=(\d+)$/))) {
      curDir.refLines.push({ n: Number(m[1]), ai: Number(m[2]), dir: Number(m[3]), body: m[4], lambda: Number(m[5]) });
      continue;
    }
    if (raw.startsWith('; identity: ')) {
      const im = raw.match(/^; identity: Σc = (.*) \| ΣK = (-?\d+) \(/);
      if (!im) throw new Error(`第 ${i + 1} 行 identity 形状不符:${JSON.stringify(clip(raw))}`);
      curDir.identityCoeffText = im[1];
      curDir.identityK = BigInt(im[2]);
      continue;
    }
    if (raw.startsWith(NO_CERT_PREFIX)) { curDir.noCert = raw.slice(NO_CERT_PREFIX.length); continue; }
    throw new Error(`第 ${i + 1} 行未识别:${JSON.stringify(clip(raw))}`);
  }
  return out;
}

// ---- 独立复核(阶段 C1/C2)-------------------------------------------------------------------
// verifyCertificate(certText, smtText) → {ok, checks, errors}
//   checks = {refs, identities, namedNoCert}(实际走过的面);errors = [具名失败...]
// 配对键 = (文件节, vc, dir)——多文件工件里 (vc, dir) 会重复(不同模块可有同名 fn 同序号)。
export function verifyCertificate(certText, smtText) {
  const errors = [];
  const checks = { refs: 0, identities: 0, namedNoCert: 0 };
  const keyOf = (file, vc, dir) => `${file}\u0000${vc}\u0000${dir}`;
  let obs;
  let blocks;
  try { obs = parseCertText(certText); } catch (e) { return { ok: false, checks, errors: [`证书解析失败:${e.message}`] }; }
  try { blocks = parseSmtBlocks(smtText); } catch (e) { return { ok: false, checks, errors: [`SMT 脚本解析失败:${e.message}`] }; }
  const byKey = new Map();
  for (const b of blocks) {
    const key = keyOf(b.file, b.vc, b.dir);
    if (byKey.has(key)) return { ok: false, checks, errors: [`SMT 方向块重复(同一文件节内):${b.file}|${b.vc}|${b.dir}`] };
    byKey.set(key, b);
  }
  const seenCert = new Set();
  for (const ob of obs) {
    if (ob.file === null) errors.push(`${ob.vc}: 义务节不在任何文件节内`);
    for (const d of ob.dirs) {
      const tag = `${ob.file ?? '?'}|${ob.vc}/${d.dir}`;
      const ckey = keyOf(ob.file, ob.vc, d.dir);
      if (seenCert.has(ckey)) errors.push(`${tag}: 证书方向节重复`);
      seenCert.add(ckey);
      const block = byKey.get(ckey);
      if (d.verdict === null) { errors.push(`${tag}: 缺 verdict 行`); continue; }
      if (block && block.verdict !== d.verdict) {
        errors.push(`${tag}: 证书 verdict=${d.verdict} 与 SMT 块注释 verdict=${block.verdict} 不一致`);
      }
      if (d.verdict !== 'proven') {
        // 非 proven 方向:必须无引用,且"无证书"行必须属于登记集(不静默、不发明措辞)。
        if (d.refLines.length !== 0) errors.push(`${tag}: 非 proven 方向必须无引用`);
        else if (d.noCert === null) errors.push(`${tag}: 非 proven 方向必须携带"无证书"具名行`);
        else if (!NO_CERT_REASONS.has(d.noCert)) errors.push(`${tag}: 未登记的无证书原因:${JSON.stringify(clip(d.noCert))}`);
        else checks.namedNoCert += 1;
        continue;
      }
      if (d.noCert !== null) {
        // proven 但无证书:原因必须属于已登记的具名原因(不静默、不伪装)。
        if (!NO_CERT_REASONS.has(d.noCert)) errors.push(`${tag}: 未登记的无证书原因:${JSON.stringify(clip(d.noCert))}`);
        else if (d.refLines.length !== 0) errors.push(`${tag}: 无证书方向不得携带引用行`);
        else checks.namedNoCert += 1;
        continue;
      }
      if (d.refs === null || d.refs !== d.refLines.length) { errors.push(`${tag}: refs 计数 ${d.refs} ≠ 引用行数 ${d.refLines.length}`); continue; }
      if (!block) { errors.push(`${tag}: 找不到对应的 SMT 方向块(引用无法落到块内断言——块外引用)`); continue; }
      if (d.usesGoal === null || d.vacuous === null) errors.push(`${tag}: proven 证书缺 uses_goal/vacuous 字段`);
      // 引用行结构:序号 1..n、假设采集序(ai, dir 非降)、λ ≥ 1
      let prevAi = -1, prevDir = -1;
      for (let k = 0; k < d.refLines.length; k += 1) {
        const r = d.refLines[k];
        if (r.n !== k + 1) errors.push(`${tag}: 引用序号不连续(ref ${r.n} 出现在第 ${k + 1} 位)`);
        if (r.ai < prevAi || (r.ai === prevAi && r.dir < prevDir)) errors.push(`${tag}: 引用未按假设采集序输出(#${r.ai} d${r.dir})`);
        prevAi = r.ai; prevDir = r.dir;
        if (r.lambda < 1) errors.push(`${tag}: λ 必须为非负整数且 ≥1(见 ${r.lambda})`);
      }
      // C1/C2:按 SMT 断言重算归一 + 恒等式(不信任证书声明的系数)
      const sum = new Map();
      let sumK = 0n;
      let bad = false;
      for (const r of d.refLines) {
        if (r.ai < 1 || r.ai > block.asserts.length) {
          errors.push(`${tag}: 引用 #${r.ai} 越界(该方向块只有 ${block.asserts.length} 条断言——块外引用)`);
          bad = true;
          continue;
        }
        let rows;
        try { rows = rowsOfPredicate(sexpParse(block.asserts[r.ai - 1])[0]); } catch (e) {
          errors.push(`${tag}: 断言 #${r.ai} 归一失败:${e.message}`); bad = true; continue;
        }
        if (r.dir >= rows.length) { errors.push(`${tag}: 引用 #${r.ai} 的归一方向 d${r.dir} 越界(该断言有 ${rows.length} 条归一)`); bad = true; continue; }
        const recomputed = rows[r.dir];
        let declared;
        try { declared = parseRowText(r.body); } catch (e) { errors.push(`${tag}: 引用 #${r.ai} 声明行不可解析:${e.message}`); bad = true; continue; }
        // 声明值 vs 独立重算值(逐变量 + K)
        const keys = new Set([...declared.coeffs.keys(), ...recomputed.coeffs.keys()]);
        for (const k of keys) {
          const dv = declared.coeffs.get(k) ?? 0n;
          const rv = recomputed.coeffs.get(k) ?? 0n;
          if (dv !== rv) { errors.push(`${tag}: 引用 #${r.ai} 声明系数 ${k}:${dv} ≠ 重算 ${rv}(篡改系数)`); bad = true; }
        }
        if (declared.K !== recomputed.K) { errors.push(`${tag}: 引用 #${r.ai} 声明 K=${declared.K} ≠ 重算 K=${recomputed.K}(篡改常数项)`); bad = true; }
        // λ 权重(当前实现恒 1;判据允许 λ>1,故按 λ 累加以保持判据通用)
        for (const [k, v] of recomputed.coeffs) sum.set(k, (sum.get(k) ?? 0n) + v * BigInt(r.lambda));
        sumK += recomputed.K * BigInt(r.lambda);
        checks.refs += 1;
      }
      if (bad) continue;
      let coeffOk = true;
      for (const [k, v] of sum) if (v !== 0n) { coeffOk = false; errors.push(`${tag}: Σλc 在变量 ${k} 上为 ${v} ≠ 0(漏引用/引用不足)`); }
      if (!coeffOk) continue;
      if (!(sumK < 0n)) { errors.push(`${tag}: ΣλK = ${sumK} ≥ 0(不构成不可满足证书)`); continue; }
      if (d.identityK !== sumK) errors.push(`${tag}: 证书自述 ΣK=${d.identityK} ≠ 重算 ΣK=${sumK}`);
      if (d.identityCoeffText !== '0(逐变量恒等)') errors.push(`${tag}: 证书自述 Σc 形态异常:${JSON.stringify(clip(d.identityCoeffText))}`);
      // uses_goal 的机械核验(放在引用/恒等式之后:篡改系数、块外引用、漏引用应先命中各自判据,
      // 不被派生不一致抢先):引用了取反目标 ⟺ 某条引用指向块内末条断言(`#<asserts.length>`)。
      const expectUses = d.refLines.some((r) => r.ai === block.asserts.length);
      if (d.usesGoal !== null && d.usesGoal !== expectUses) {
        errors.push(`${tag}: uses_goal=${d.usesGoal} 与引用面不符(取反目标 = #${block.asserts.length};期望 ${expectUses})`);
      }
      checks.identities += 1;
    }
  }
  return { ok: errors.length === 0, checks, errors };
}

// ---- 三负例(必须全部被判失败)---------------------------------------------------------------
// 每个 mutation:输入好证书 → 输出被篡改的证书(仍可解析);返回 null 表示未命中(语料形态不够)。
// 每个负例登记**期望命中的检查面**(篡改系数 / 块外引用 / 恒等式),只判"被拒"不够——
// 必须是因该负例对应的判据被拒,否则负例名义与实测不符。
function linesOf(text) { return text.split('\n'); }

// 方向节扫描:每节的行区间 [dir 行, 下一个 dir/义务/文件/头注],供按节变异(不同义务的
// 引用序号各自从 1 起,跨节删除会串味)。
function dirSections(lines) {
  const secs = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^; dir: (low|high)$/.test(lines[i])) {
      cur = { dirLine: i, refsLine: -1, refLines: [] };
      secs.push(cur);
      continue;
    }
    if (/^; ---- vc:/.test(lines[i]) || /^; ===== 文件:/.test(lines[i])) { cur = null; continue; }
    if (cur === null) continue;
    if (/^; refs: \d+$/.test(lines[i])) cur.refsLine = i;
    if (/^; ref \d+: #/.test(lines[i])) cur.refLines.push(i);
  }
  return secs;
}

export function mutateCoefficient(text) {
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(; ref \d+: #\d+ d\d+ \| norm: \{)(.*)(\} <= -?\d+ \| λ=\d+)$/);
    if (!m) continue;
    const fm = m[2].match(/^([^:]+: )(-?\d+)(.*)$/);
    if (!fm) continue;
    lines[i] = m[1] + fm[1] + String(BigInt(fm[2]) + 1n) + fm[3] + m[3]; // 系数 +1(声明值必与重算不符)
    return lines.join('\n');
  }
  return null;
}

// 引用块外:把某个方向的**最后一条**引用改成超出块内断言数的断言序号(保持采集序,
// 让失败只归因于"块外引用"而不是顺序)。
export function mutateOutOfBlock(text) {
  const lines = linesOf(text);
  const sec = dirSections(lines).find((s) => s.refLines.length >= 1);
  if (!sec) return null;
  const i = sec.refLines[sec.refLines.length - 1];
  lines[i] = lines[i].replace(/^; ref (\d+): #(\d+) /, '; ref $1: #999 ');
  return lines.join('\n');
}

// 漏引用:删掉某个方向(≥2 引用)的最后一条引用 + 该方向 refs 计数减一 + 该方向重编号,
// 使失败只归因于恒等式(Σλc ≠ 0)。
export function mutateMissingRef(text) {
  const lines = linesOf(text);
  const sec = dirSections(lines).find((s) => s.refLines.length >= 2);
  if (!sec) return null;
  const del = sec.refLines[sec.refLines.length - 1];
  lines.splice(del, 1);
  if (sec.refsLine >= 0 && sec.refsLine > del) sec.refsLine -= 1;
  if (sec.refsLine >= 0) {
    const m = lines[sec.refsLine].match(/^; refs: (\d+)$/);
    if (m) lines[sec.refsLine] = `; refs: ${Number(m[1]) - 1}`;
  }
  let n = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^; ref \d+: #/.test(lines[i])) continue;
    n += 1;
    lines[i] = lines[i].replace(/^; ref \d+:/, `; ref ${n}:`);
  }
  return lines.join('\n');
}

// ---- fixture 层 -----------------------------------------------------------------------------
function verifyFixtures(generated, { update, failLine }) {
  const eligible = generated.filter((g) => g.certOk);
  const writable = generated.filter((g) => g.certOk && !g.genFailed);
  let matched = 0;
  let written = 0;
  if (update) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  if (fs.existsSync(FIXTURE_DIR)) {
    const slugs = new Set(CORPORA.map((c) => c.slug));
    for (const f of fs.readdirSync(FIXTURE_DIR).sort()) {
      if (!f.endsWith('.cert')) continue;
      if (!slugs.has(f.slice(0, -'.cert'.length))) {
        failLine(`[fixture] 孤儿 fixture ${relPath(path.join(FIXTURE_DIR, f))}(没有同名语料;删除该文件或恢复语料)`);
      }
    }
  }
  if (update) {
    for (const g of generated) {
      if (!writable.includes(g)) process.stdout.write(`[fixture] 跳过 ${g.c.slug}(生成阶段失败,拒绝写盘)\n`);
    }
  }
  for (const g of (update ? writable : eligible)) {
    const slug = g.c.slug;
    const file = fixturePath(slug);
    if (update) {
      let prev = null;
      try { prev = fs.readFileSync(file, 'utf8'); } catch { prev = null; }
      fs.writeFileSync(file, g.cert, 'utf8');
      const tag = prev === null ? '新增' : prev === g.cert ? '未变' : '变更';
      process.stdout.write(`[fixture] ${tag} ${fixtureRel(slug)}\n`);
      written += 1;
      continue;
    }
    let fixture = null;
    try { fixture = fs.readFileSync(file, 'utf8'); } catch {
      failLine(`[${slug}] 缺失 fixture ${fixtureRel(slug)}(运行 node tests/cert_check.mjs --update-fixtures 生成并入库)`);
      continue;
    }
    if (fixture === g.cert) { matched += 1; continue; }
    const d = firstDiff(fixture, g.cert);
    failLine(`[${slug}] fixture 不一致 ${fixtureRel(slug)}(严格逐字节);首处差异第 ${d.line} 行:fixture=${JSON.stringify(clip(d.expected))} 生成=${JSON.stringify(clip(d.actual))}`);
  }
  if (update) {
    process.stdout.write(`fixture 更新:${written}/${writable.length} 个文件写入 ${relPath(FIXTURE_DIR)}/(更新即审查信号——git diff 逐字节可审)\n`);
  } else {
    process.stdout.write(`fixture 黄金:${matched}/${eligible.length} 逐字节一致(${relPath(FIXTURE_DIR)}/,严格模式)\n`);
  }
  return { matched, written, eligible: eligible.length };
}

// ---- 主流程 ---------------------------------------------------------------------------------
function main() {
  const KNOWN_FLAGS = new Set(['--update-fixtures', '--help', '-h']);
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    process.stderr.write(`未知旗标:${unknown.join(' ')}(用法见 --help)\n`);
    process.exitCode = 1;
    return;
  }
  const updateFixtures = process.argv.includes('--update-fixtures');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-cert-check-'));
  const failures = [];
  const failLine = (msg) => {
    failures.push(msg);
    process.stderr.write(`✗ ${msg}\n`);
  };

  process.stdout.write('cert-check — 自产线性证书的独立参考检查器(规范 docs/proof-protocol.md §10)\n');

  // ---- 阶段 A:生成 + 结构断言 --------------------------------------------------------------
  const generated = [];
  for (const c of CORPORA) {
    const names = c.files.map((f) => f.name);
    for (const f of c.files) {
      fs.writeFileSync(path.join(TMP, f.name), f.source.endsWith('\n') ? f.source : `${f.source}\n`, 'utf8');
    }
    const entry = { c, cert: null, smt: null, certOk: false, genFailed: false };
    generated.push(entry);
    const before = failures.length;
    const runCheck = (fmt) => spawnSync(process.execPath, [MING, 'check', ...names, '--proof-format', fmt], {
      encoding: 'utf8', cwd: TMP, timeout: SPAWN_TIMEOUT_MS, windowsHide: true,
    });
    const rc = runCheck('cert');
    const rs = runCheck('smt-lib');
    if (rc.error || rc.status === null) { failLine(`[${c.slug}] ming check --proof-format cert 未能执行:${rc.error?.message ?? 'status=null'}`); continue; }
    if (rs.error || rs.status === null) { failLine(`[${c.slug}] ming check --proof-format smt-lib 未能执行:${rs.error?.message ?? 'status=null'}`); continue; }
    if (rc.status !== c.expectExit) failLine(`[${c.slug}] cert 退出码 ${rc.status} ≠ 预期 ${c.expectExit}(退出码语义零变化)`);
    if (rs.status !== c.expectExit) failLine(`[${c.slug}] smt-lib 退出码 ${rs.status} ≠ 预期 ${c.expectExit}`);
    const cert = rc.stdout;
    if (!cert.startsWith(CERT_HEAD + '\n')) { failLine(`[${c.slug}] stdout 不是证书文本(首行不符):${JSON.stringify(cert.slice(0, 160))}`); continue; }
    if (!cert.endsWith('\n')) { failLine(`[${c.slug}] 证书文本末尾缺换行`); continue; }
    if (rc.stderr !== '') failLine(`[${c.slug}] 无诊断语料 stderr 应为空:${JSON.stringify(rc.stderr.slice(0, 200))}`);

    // 结构断言:义务节(文件名节 + vc id)与逐方向 verdict / refs / uses_goal / vacuous
    let obs = null;
    try { obs = parseCertText(cert); } catch (e) { failLine(`[${c.slug}] 证书不可解析:${e.message}`); continue; }
    if (obs.length !== c.obligations.length) {
      failLine(`[${c.slug}] 义务节数 ${obs.length} ≠ 预期 ${c.obligations.length}`);
      continue;
    }
    c.obligations.forEach((want, k) => {
      const ob = obs[k];
      if (ob.file !== want.file) failLine(`[${c.slug}] 义务 ${k + 1} 文件节=${JSON.stringify(ob.file)} ≠ 预期 ${JSON.stringify(want.file)}(命令行序)`);
      if (ob.vc !== want.vc) failLine(`[${c.slug}] 义务 ${k + 1} id=${ob.vc} ≠ 预期 ${want.vc}`);
      if (ob.dirs.length !== want.dirs.length) { failLine(`[${c.slug}/${ob.vc}] 方向节数 ${ob.dirs.length} ≠ 预期 ${want.dirs.length}`); return; }
      want.dirs.forEach(([verdict, refs, usesGoal, vacuous], i) => {
        const d = ob.dirs[i];
        const wantDir = i === 0 ? 'low' : 'high';
        if (d.dir !== wantDir) failLine(`[${c.slug}/${ob.vc}] 方向 ${i + 1} 是 ${d.dir} ≠ 预期 ${wantDir}(low 在前)`);
        if (d.verdict !== verdict) failLine(`[${c.slug}/${ob.vc}/${d.dir}] verdict=${d.verdict} ≠ 预期 ${verdict}`);
        if (refs === null) {
          if (d.refLines.length !== 0) failLine(`[${c.slug}/${ob.vc}/${d.dir}] 预期无证书,实际 ${d.refLines.length} 条引用`);
          if (d.verdict === 'proven' && d.noCert === null) failLine(`[${c.slug}/${ob.vc}/${d.dir}] proven 无证书必须具名(; 无证书:...)`);
        } else {
          if (d.refLines.length !== refs) failLine(`[${c.slug}/${ob.vc}/${d.dir}] 引用数 ${d.refLines.length} ≠ 预期 ${refs}`);
          if (d.usesGoal !== usesGoal) failLine(`[${c.slug}/${ob.vc}/${d.dir}] uses_goal=${d.usesGoal} ≠ 预期 ${usesGoal}`);
          if (d.vacuous !== vacuous) failLine(`[${c.slug}/${ob.vc}/${d.dir}] vacuous=${d.vacuous} ≠ 预期 ${vacuous}`);
        }
      });
    });

    entry.cert = cert;
    entry.smt = rs.stdout;
    entry.certOk = true;
    entry.genFailed = failures.length > before;
    const tags = obs.map((ob) => `${ob.file}/${ob.vc}[${ob.dirs.map((d) => `${d.dir}=${d.verdict}${d.refLines.length ? `(${d.refLines.length}ref)` : d.noCert ? '(无证书)' : ''}`).join(',')}]`).join(' ');
    process.stdout.write(`${entry.genFailed ? '[fail]' : '[ok]'} ${c.name} — ${tags}\n`);
  }

  // ---- 阶段 B:fixture 黄金 ------------------------------------------------------------------
  verifyFixtures(generated, { update: updateFixtures, failLine });

  // ---- 阶段 C:独立复核 + 三负例 -------------------------------------------------------------
  let refTotal = 0;
  let identTotal = 0;
  let namedTotal = 0;
  for (const g of generated) {
    if (!g.certOk) { process.stdout.write(`[fail] ${g.c.name} — 生成阶段失败(跳过复核)\n`); continue; }
    const before = failures.length;
    const v = verifyCertificate(g.cert, g.smt);
    for (const e of v.errors) failLine(`[${g.c.slug}] 复核失败:${e}`);
    refTotal += v.checks.refs;
    identTotal += v.checks.identities;
    namedTotal += v.checks.namedNoCert;
    process.stdout.write(`${v.ok ? '[ok]' : '[fail]'} ${g.c.slug} 独立复核 — ${v.checks.refs} 引用,${v.checks.identities} 恒等式,${v.checks.namedNoCert} 具名无证书\n`);
    if (failures.length === before && v.ok) continue;
  }

  // 三负例:取第一个"至少 2 引用"的语料作基底;每次篡改都必须因**对应的判据**被拒
  // (只判"被拒"不够——负例名义与实测必须一致,否则检查器可能因无关原因失明)。
  const base = generated.find((g) => g.certOk && (g.cert.match(/^; ref \d+: #/gm) ?? []).length >= 2);
  const NEGATIVES = [
    ['篡改系数', mutateCoefficient, '篡改系数'],
    ['引用块外约束', mutateOutOfBlock, '块外引用'],
    ['漏引用', mutateMissingRef, 'Σλc'],
  ];
  let negOk = 0;
  for (const [name, mutate, expectIn] of (base ? NEGATIVES : [])) {
    const mutated = mutate(base.cert);
    if (mutated === null) { failLine(`[负例:${name}] 篡改未命中(语料形态不足以构造该负例——负例门槛失效)`); continue; }
    if (mutated === base.cert) { failLine(`[负例:${name}] 篡改未改变文本(负例门槛失效)`); continue; }
    const v = verifyCertificate(mutated, base.smt);
    if (v.ok) { failLine(`[负例:${name}] 篡改后的证书被**接受**——检查器失去判别力`); continue; }
    if (!v.errors.some((e) => e.includes(expectIn))) {
      failLine(`[负例:${name}] 被拒但未命中对应判据(期望错误含 ${JSON.stringify(expectIn)};实际:${clip(v.errors[0])})`);
      continue;
    }
    negOk += 1;
    process.stdout.write(`[ok] 负例:${name} 判失败(${expectIn}) — ${clip(v.errors[0])}\n`);
  }
  if (!base) failLine('[负例] 找不到 ≥2 引用的好证书作基底,三负例无法构造');
  if (base && negOk !== NEGATIVES.length) failLine(`[负例] 三负例仅 ${negOk}/${NEGATIVES.length} 按序判失败`);

  const pass = failures.length === 0;
  process.stdout.write(`\ncert-check: ${CORPORA.length} 语料,${refTotal} 引用复核,${identTotal} 恒等式,${namedTotal} 具名无证书,三负例 ${negOk}/3 判失败——${pass ? 'pass' : 'fail'}\n`);
  if (!pass) {
    process.stderr.write(`\n共 ${failures.length} 项失败;临时目录留档:${TMP}\n`);
    process.exitCode = 1;
    return;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

// 直接运行 = 主流程;被 import(§117 复用 verifyCertificate/变异器)时无副作用。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
  } else {
    main();
  }
}
