// tests/proof_fuzz.mjs — 静态证明模糊器(零依赖;plan §4.2.3 任务 6 + §4.2.6 任务 5)。
// 思路:prover 声称"proven"时,运行时必须真的安全;声称"violated"时,反例必须真的成立。
// 模式 1/2(v0.52 边界证明,默认运行):
//   模式 1(误报检测):生成"非 mut Vec[i64] 参数 + i64 参数 + 线性 requires + 直线体含 buf[i]"
//     的 .ming,生成器用自带求值器保证实参满足 requires。凡 check --json --proof-report 判
//     proven 的索引,断言 `run` 与 `run --tree` 退出 0 且无 M4003/M4015 —— 证明器说安全,
//     运行时就必须安全。可证类模板额外断言"必须 proven"(防止证明能力退化使模糊器空转);
//     不可证类(U)断言不判 violated(不可编码形态不得误报 M3045)。
//   模式 2(反例验证):生成可证违反形态,断言 M3045 必发;用本文件独立实现的小型线性求值器
//     (刻意不 import src/prover.js)验证反例:反例值满足全部 requires 且使索引越出义务侧。
//     每 8 例抽 1 例为负控(requires 含 buf[n] 的不可编码形态)——断言保持静默(不误报)。
// 模式 summaries(v0.55 跨函数契约摘要,--mode summaries):
//   每 12 例固定分布:6 ok / 2 callsite / 1 ensfalse / 2 静默 / 1 易误报语料。
//   随机生成 2-4 函数直线链 f0→f1→…(单条 requires + ensures result == a + C):
//     ok      全链 requires 可证满足且各 ensures 可证真 → check 必须 0 诊断(不误报);
//             负控:--proof-report summaries 必须 ensures_present/ensures_proven=true
//             (调用方 ensures 仅靠被调已证 ensures 才可证,摘要确实被采用);
//     callsite 某调用点实参可证违反被调 requires → check 必报 M3041,反例须满足调用方 requires;
//             随机含上界(`a <= U`)与下界(`a >= L`)两种调用方 requires 形态(M7);
//     ensfalse 某函数 ensures 声明可证假 → check 必报 M3042,反例须满足该函数 requires 且
//              独立求值器复算的实际返回值不等于声明值;
//     静默    递归/互递归/非线性/不可编码四类 → check 必须 0 诊断;
//     易误报  分支返回/分支内形参重赋值/match 重赋值/短路 &&/||(B1/B2 回归)→ 必须静默。
//   反例验证复用本文件独立线性求值器(不 import src/prover.js)。汇总
//   "可证 N / 违反 M / 静默 K / 易误报 T / 误报 0",失败退出 1。
// 模式 loops(v0.57 QF_LIA 第四片,--mode loops):范围 for 内的 buf[i] 义务。
//   每 8 例固定分布:4 proven(义务必须 proven + run/run --tree 无 M4003/M4015)/ 2 静默
//   (放弃形态:无上界 requires、嵌套 for、while、非线性上界 → 0 诊断)/ 2 可证违反
//   (M3045 必发;反例经独立求值器三重验证:满足 requires + 落在循环区间内 + 索引确实越出义务侧)。
//   循环区间符号(i$0)与 len$buf 同款'$ 命名空间';反例枚举含循环符号,验证器据此复核。
// 说明:M3045 语料无法用于运行时复核 —— `ming run` 先 check,M3045 直接拒绝执行(exit 1);
//   因此"violated → 运行时必 M4003"由 §56 的运行时测试与差分模糊承担,本文件只做静态一致性。
// 用法:node tests/proof_fuzz.mjs [--seed N] [--count N] [--mode default|1|2|summaries|loops|all]
//   默认 --mode default = 模式 1 + 模式 2(既有门禁口径不变);默认 --count 200(summaries 模式 300)。
//   末尾汇总各模式统计;任一失败退出 1。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1]) : d; };
const strOpt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const SEED = opt('seed', 20261112);
const MODE = strOpt('mode', 'default');
if (!['default', '1', '2', 'summaries', 'loops', 'all'].includes(MODE)) {
  process.stderr.write(`proof_fuzz:未知 --mode "${MODE}"(可用:default|1|2|summaries|loops|all)\n`);
  process.exit(1);
}
const RUN_M12 = MODE === 'default' || MODE === '1' || MODE === '2' || MODE === 'all';
const RUN_SUM = MODE === 'summaries' || MODE === 'all';
const RUN_LOOPS = MODE === 'loops'; // v0.57:范围 for 循环义务(独立模式;all 保持既有口径不变)
// 默认 count 按模式:summaries 验收规模 300,既有模式保持 200(CI 门禁口径不变)。
const COUNT = Math.max(1, opt('count', MODE === 'summaries' ? 300 : 200));

// mulberry32:确定性 rng(与 tests/fuzz.mjs 同款)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// ===================== 独立线性求值器(模式 2 反例验证;不 import src/prover.js) =====================
// "侧":{ v: 变量名 | null, mul: BigInt, off: BigInt };变量 ∈ {'i','n','len$buf'}。
// len$buf 的值:模式 1 来自调用点 Vec 字面量长度;模式 2 来自 checker 反例值。
const LEN = 'len$buf';
const V = (v, mul = 1n, off = 0n) => ({ v, mul, off });
const C = (off) => ({ v: null, mul: 1n, off });
const p = (name) => ({ name });
const pm = (name) => ({ name, mut: true });
const ge0 = (x) => [V(x), '>=', C(0n)];
const geC = (x, k) => [V(x), '>=', C(k)];
const ltLen = (x) => [V(x), '<', V(LEN)];
const leLen = (x) => [V(x), '<=', V(LEN)];

function sideText(s) {
  if (!s.v) return s.off.toString();
  const base = s.v === LEN ? 'buf.len()' : s.v;
  const m = s.mul === 1n ? '' : ` * ${s.mul}`;
  if (s.off === 0n) return base + m;
  const sign = s.off > 0n ? '+' : '-';
  const mag = s.off > 0n ? s.off : -s.off;
  return `${base}${m} ${sign} ${mag}`;
}
function sideEval(s, vals) {
  const base = s.v ? s.mul * (vals[s.v] ?? 0n) : 0n;
  return base + s.off;
}
function leafHolds(lf, op, rf, vals) {
  const l = sideEval(lf, vals), r = sideEval(rf, vals);
  switch (op) {
    case '==': return l === r; case '!=': return l !== r;
    case '<': return l < r; case '<=': return l <= r;
    case '>': return l > r; default: return l >= r; // '>='
  }
}
const reqText = (leaves) => leaves.map(([l, op, r]) => `${sideText(l)} ${op} ${sideText(r)}`).join(' && ');

// ===================== 程序生成 =====================

// 模式 1 模板。cls:'P'=可证类(义务必须 proven),'U'=不可证类(义务不得 violated)。
// leaves 即 requires(文本由 reqText 从叶子渲染,保证与求值器一致);body 为直线体。
const M1 = [
  { cls: 'P', params: [p('i')], leaves: [ge0('i'), ltLen('i')], body: ['return buf[i];'] },
  { cls: 'P', params: [p('i')], leaves: [[V(LEN), '>', V('i')], ge0('i')], body: ['return buf[i];'] }, // 换向:len > i
  { cls: 'P', params: [p('i')], leaves: [geC('i', 1n), leLen('i')], body: ['let j = i - 1;', 'return buf[j];'] }, // 移位索引
  { cls: 'P', params: [p('n')], leaves: [geC('n', 1n), leLen('n')], body: ['return buf[n - 1];'] },
  { cls: 'P', params: [pm('n')], leaves: [geC('n', 1n), leLen('n')], body: ['n = n - 1;', 'return buf[n];'] }, // mut i64 重赋值
  { cls: 'P', params: [], leaves: [[V(LEN), '>=', C(1n)]], body: ['return buf[buf.len() - 1];'] }, // 无 i64 参数
  { cls: 'P', params: [p('i'), p('n')], leaves: [ge0('i'), ltLen('i'), ge0('n')], body: ['return buf[i];'] }, // 无关合取子句
  { cls: 'P', params: [p('i'), p('n')], leaves: [[V('i'), '>=', V('n')], ge0('n'), ltLen('i')], body: ['return buf[i];'] }, // 链式推理 i>=n>=0
  { cls: 'U', params: [p('i')], leaves: [ge0('i'), leLen('i')], body: ['return buf[i];'] }, // <= 不蕴含严格 <
  { cls: 'U', params: [p('i')], leaves: [ge0('i')], body: ['return buf[i];'] }, // 无上界
  { cls: 'U', params: [p('i')], leaves: [ge0('i'), [V('i', 2n), '<', V(LEN)]], body: ['return buf[i * 2];'] }, // 非线性不可编码
];

// 模式 2 模板:全部为当前实现下可证违反的形态(义务侧 side 指明违反方向)。
// 换向模板(paren:true)requires 以裸 Ident 结尾时必须加括号 —— 否则 `n {` 会被 parser
// 当成结构体字面量(既有歧义,M2001),与静态证明无关。
const M2 = [
  { side: 'high', params: [p('n')], leaves: [[V('n'), '==', V(LEN)]], body: ['return buf[n];'], idx: V('n') },
  { side: 'high', params: [p('n')], leaves: [[V(LEN), '==', V('n')]], body: ['return buf[n];'], idx: V('n'), paren: true }, // 换向
  { side: 'high', params: [p('n')], leaves: [[V('n'), '>', V(LEN)]], body: ['return buf[n];'], idx: V('n') },
  { side: 'high', params: [p('n')], leaves: [[V(LEN), '<', V('n')]], body: ['return buf[n];'], idx: V('n'), paren: true }, // 换向
  { side: 'low', params: [p('n')], leaves: [[V('n'), '<', C(0n)]], body: ['return buf[n];'], idx: V('n') },
  { side: 'low', params: [p('n')], leaves: [[V('n'), '<', C(0n)], [V('n'), '<', V(LEN)]], body: ['return buf[n];'], idx: V('n') },
  { side: 'high', params: [p('n')], leaves: [ge0('n')], body: ['return buf[buf.len()];'], idx: V(LEN) },
  { side: 'high', params: [p('n')], leaves: [ge0('n')], body: ['return buf[buf.len() + 1];'], idx: V(LEN, 1n, 1n) },
];

// 负控(requires 含 buf[n] 的不可编码形态):义务不可证 → 必须静默(不误报 M3045/W3105)。
const M2CTRL = { params: [p('n')], body: ['return buf[n];'], req: 'n == buf.len() + buf[n]' };

// ===================== loops 模式(v0.57):范围 for 内的 buf[i] 义务 =====================
// cls:'P'=可证类(义务必须 proven,run/run --tree 必须安全);'S'=静默类(放弃形态,0 诊断);
// 'V'=可证违反类(M3045 必发 + 反例独立三重验证)。
// V 类模板另带:interval=[loSide, hiSide)(循环区间,独立求值器侧形式)、idx(索引侧形式,
// loopSym 为 checker 的循环区间符号名)、side(违反方向)—— 反例须满足 requires 且
// lo <= i$0 < hi 且索引确实越出义务侧(区间非空 = 违反不是空洞真)。
const L1 = [
  { cls: 'P', params: [], leaves: [geC(LEN, 1n)], body: ['for i in 0..buf.len() {', '    return buf[i];', '}', 'return 0;'] },
  { cls: 'P', params: [], leaves: [geC(LEN, 1n)], body: ['for i in 1..buf.len() {', '    return buf[i];', '}', 'return 0;'] }, // 下界 1:>= 0 由 lo 推出
  { cls: 'P', params: [p('n')], leaves: [ge0('n'), geC(LEN, 1n)], body: ['for i in n..buf.len() {', '    return buf[i];', '}', 'return 0;'] }, // requires n >= 0
  { cls: 'P', params: [p('n')], leaves: [leLen('n'), geC(LEN, 1n)], body: ['for i in 0..n {', '    return buf[i];', '}', 'return 0;'] }, // requires n <= buf.len()
  { cls: 'P', params: [], leaves: [geC(LEN, 1n)], body: ['for i in 0..buf.len() - 1 {', '    return buf[i + 1];', '}', 'return 0;'] }, // 边界严格性:i+1 < len
  { cls: 'P', params: [], leaves: [geC(LEN, 1n)], body: ['for i in 0..buf.len() {', '    let j = i + 1 - 1;', '    return buf[j];', '}', 'return 0;'] }, // 循环内 let 移位
  { cls: 'P', params: [], leaves: [geC(LEN, 1n)], body: ['for i in 0..buf.len() {', '    buf[i];', '    continue;', '}', 'return 0;'] }, // continue 不破坏不变式
  { cls: 'P', params: [], leaves: [geC(LEN, 1n)], body: ['for i in 0..buf.len() {', '    buf[i];', '}', 'for j in 0..buf.len() {', '    buf[j];', '}', 'return 0;'] }, // 两个顺序循环
  { cls: 'P', params: [p('n')], leaves: [ge0('n'), leLen('n'), geC(LEN, 1n)], prelude: ['fn g(x: i64) -> i64 requires x >= 0 { return x; }'], body: ['for i in 0..n {', '    buf[i];', '    let k = g(i);', '}', 'return 0;'] }, // 循环体内契约调用(摘要交互不回归)
];
const LS = [
  { cls: 'S', params: [p('n')], leaves: [ge0('n'), geC(LEN, 1n)], body: ['for i in 0..n {', '    return buf[i];', '}', 'return 0;'] }, // 无 n <= len → 未证明,静默
  { cls: 'S', params: [], leaves: [geC(LEN, 1n)], body: ['for i in 0..buf.len() {', '    for j in 0..buf.len() {', '        buf[i];', '    }', '}', 'return 0;'] }, // 嵌套 for → 放弃
  { cls: 'S', params: [], leaves: [geC(LEN, 1n)], body: ['let mut k = 0;', 'while k < buf.len() {', '    k = k + 1;', '    buf[0];', '}', 'return 0;'] }, // while → 放弃
  { cls: 'S', params: [p('n')], leaves: [ge0('n'), geC(LEN, 1n)], body: ['for i in 0..n * n {', '    return buf[i];', '}', 'return 0;'] }, // 非线性上界 → 放弃
];
const L2 = [
  { cls: 'V', side: 'high', params: [], leaves: [ge0(LEN)], body: ['for i in buf.len()..buf.len() + 1 {', '    return buf[i];', '}', 'return 0;'], interval: [V(LEN), V(LEN, 1n, 1n)], idx: V('i$0') },
  { cls: 'V', side: 'low', params: [], leaves: [ge0(LEN)], body: ['for i in 0 - 1..0 {', '    return buf[i];', '}', 'return 0;'], interval: [C(-1n), C(0n)], idx: V('i$0') },
  { cls: 'V', side: 'high', params: [p('n')], leaves: [[V('n'), '>=', V(LEN)]], body: ['for i in n..n + 1 {', '    return buf[i];', '}', 'return 0;'], interval: [V('n'), V('n', 1n, 1n)], idx: V('i$0') },
  { cls: 'V', side: 'low', params: [p('n')], leaves: [[V('n'), '==', C(0n)]], body: ['for i in n - 1..n {', '    return buf[i];', '}', 'return 0;'], interval: [V('n', 1n, -1n), V('n')], idx: V('i$0') },
];

function buildProgram(t, L, argVals, bufVals, reqOverride = null) {
  const req = reqOverride ?? (t.paren ? '(' + reqText(t.leaves) + ')' : reqText(t.leaves));
  const sig = ['buf: Vec[i64]', ...t.params.map((x) => (x.mut ? `mut ${x.name}: i64` : `${x.name}: i64`))].join(', ');
  const lines = [...(t.prelude ?? []), `fn f(${sig}) -> i64 requires ${req} {`]; // prelude:loops 模式的契约辅助函数(既有模板无此字段,零影响)
  for (const b of t.body) lines.push('    ' + b);
  lines.push('}');
  const args = ['[' + bufVals.join(', ') + ']', ...t.params.map((x) => String(argVals[x.name]))];
  lines.push(`fn main() with io { print(str(f(${args.join(', ')}))); }`);
  lines.push('');
  return lines.join('\n');
}

// 依序为各 i64 参数取"满足全部 requires"的值(候选区间 [-2, L+2],rng 决定起点保证多样性)。
// 可证类模板构造上保证可行域非空;找不到 = 生成器缺陷(按失败上报)。
function sampleArgs(t, L) {
  const vals = { [LEN]: BigInt(L) };
  for (const prm of t.params) {
    const lo = -2n, hi = BigInt(L + 2);
    const span = Number(hi - lo) + 1;
    const start = int(0, span - 1);
    let found = null;
    for (let k = 0; k < span && found === null; k++) {
      const cand = lo + BigInt((start + k) % span);
      vals[prm.name] = cand;
      if (t.leaves.every(([l, op, r]) => leafHolds(l, op, r, vals))) found = cand;
    }
    if (found === null) return null;
    vals[prm.name] = found;
  }
  return vals;
}

// 解析反例串 "len$buf = 0, n = 0" → { len$buf: 0n, n: 0n };无反例或格式异常返回 null。
function parseCex(s) {
  if (!s) return null;
  const vals = {};
  for (const part of s.split(', ')) {
    const eq = part.split(' = ');
    if (eq.length !== 2) return null;
    try { vals[eq[0].trim()] = BigInt(eq[1].trim()); } catch { return null; }
  }
  return Object.keys(vals).length ? vals : null;
}

// ===================== summaries 模式:v0.55 跨函数契约摘要 =====================
// 生成的链规格:{kind, n, reqs:[{op,n}], K, M, C(实际返回常数), declC(声明 ensures 常数),
//   violAt, falseAt, mainArg}。全部是 i64 单参数 a;契约 = 单条 requires(单侧线性界)
//   + ensures (result == a + C)。独立求值器只用规格里的常数与 op,不经过 prover。

function genSummaryChain(kind) {
  const n = int(2, 4);
  const K = new Array(n).fill(0);
  const M = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { K[i] = int(0, 3); M[i] = int(0, 3); }
  const reqs = new Array(n);
  let violAt = -1, falseAt = -1, lowShape = false;
  if (kind === 'callsite') {
    violAt = int(0, n - 2);
    K[violAt] = 0; // 违反点实参必须是裸 a:静态可证与反例同值可核
    lowShape = rng() < 0.5;
    if (lowShape) {
      // M7:下界 requires 形态(caller a >= L,callee a <= U < L)→ 反例须落在调用方合法输入集
      const L = int(2, 4);
      reqs[violAt] = { op: '>=', n: L };
      reqs[violAt + 1] = { op: '<=', n: L - 1 - int(0, 2) };
      for (let i = violAt - 1; i >= 0; i--) {
        // 上层下界链(自顶向下):R_i + K_i >= R_{i+1} ⇒ 调用点 requires 可证
        const lo = Math.max(0, reqs[i + 1].n - K[i]);
        reqs[i] = { op: '>=', n: lo + int(0, 3) };
      }
      for (let i = violAt + 2; i < n; i++) {
        // 下层上界链(自顶向下):U_i + K_{i-1} <= U_{i-1} ⇒ 调用点 requires 可证
        const lim = reqs[i - 1].n;
        if (K[i - 1] > lim) K[i - 1] = 0;
        reqs[i] = { op: '<=', n: Math.max(0, lim - K[i - 1]) };
      }
    } else {
      const U = int(2, 4); // 调用方上界 ≥ 2,保证小值反例(-2..2)满足调用方 requires
      reqs[violAt] = { op: '<=', n: U };
      reqs[violAt + 1] = { op: '>=', n: U + 1 + int(0, 2) }; // 被调下界高于可达上界
      for (let i = violAt - 1; i >= 0; i--) {
        // 上层上界链(自顶向下):U_i + K_i <= U_{i+1}(必要时把 K_i 归零)
        const lim = reqs[i + 1].n;
        if (K[i] > lim) K[i] = 0;
        reqs[i] = { op: '<=', n: int(0, lim - K[i]) };
      }
      for (let i = violAt + 2; i < n; i++) reqs[i] = { op: '>=', n: 0 }; // 下层可证下界链
    }
  } else {
    // 全下界可证链(自底向上):R_i + K_i >= R_{i+1} ⇒ 调用点 requires 可证
    reqs[n - 1] = { op: '>=', n: int(0, 3) };
    for (let i = n - 2; i >= 0; i--) {
      const lo = Math.max(0, reqs[i + 1].n - K[i]);
      reqs[i] = { op: '>=', n: lo + int(0, 3) };
    }
    if (kind === 'ensfalse') falseAt = int(0, n - 1);
  }
  // C 用最终 K/M 计算(上层上界链可能改过 K);实际返回 = a + C,声明值 = a + declC
  const C = new Array(n);
  C[n - 1] = int(0, 4);
  for (let i = n - 2; i >= 0; i--) C[i] = K[i] + C[i + 1] + M[i];
  const declC = C.slice();
  if (falseAt >= 0) declC[falseAt] = C[falseAt] + int(1, 3); // 可证假的声明值
  const mainArg = kind === 'callsite'
    ? (lowShape ? BigInt(reqs[0].n) : 0n) // 下界形态:main 实参须满足 f0.requires(否则多报一条字面量 M3041)
    : BigInt(reqs[0].n);
  return { kind, n, reqs, K, M, C, declC, violAt, falseAt, lowShape, mainArg };
}

function summaryProgram(spec) {
  const lines = [];
  for (let i = 0; i < spec.n; i++) {
    const req = `a ${spec.reqs[i].op} ${spec.reqs[i].n}`;
    lines.push(`fn f${i}(a: i64) -> i64 requires ${req} ensures (result == a + ${spec.declC[i]}) {`);
    if (i === spec.n - 1) {
      lines.push(`    return a + ${spec.C[i]};`);
    } else {
      lines.push(`    let r = f${i + 1}(a + ${spec.K[i]});`);
      lines.push(`    return r + ${spec.M[i]};`);
    }
    lines.push('}');
  }
  lines.push(`fn main() with io { print(str(f0(${spec.mainArg}))); }`);
  lines.push('');
  return lines.join('\n');
}

// 独立求值器:给定形参值,复算链上某函数的真实返回(不依赖 checker/prover)。
function summaryActual(spec, idx, aVal) {
  if (idx === spec.n - 1) return aVal + BigInt(spec.C[idx]);
  return summaryActual(spec, idx + 1, aVal + BigInt(spec.K[idx])) + BigInt(spec.M[idx]);
}
function summaryReqHolds(spec, idx, aVal) {
  const r = spec.reqs[idx];
  return r.op === '>=' ? aVal >= BigInt(r.n) : aVal <= BigInt(r.n);
}

// 静默形态:递归 / 互递归 / 非线性 ensures / 不可编码 requires。全部必须 check 0 诊断。
function genSilentSummaryProgram() {
  const k = int(0, 3);
  if (k === 0) {
    return {
      tag: '递归',
      src: [
        'fn rec(a: i64) -> i64 requires a >= 0 ensures (result == a + 1) { if a == 0 { return 1; } return rec(a - 1) + 1; }',
        'fn top(a: i64) -> i64 requires a >= 0 ensures (result == a + 2) { let r = rec(a); return r + 1; }',
        'fn main() with io { print(str(top(0))); }',
        '',
      ].join('\n'),
    };
  }
  if (k === 1) {
    return {
      tag: '互递归',
      src: [
        'fn p(a: i64) -> i64 requires a >= 0 ensures (result == a + 1) { if a == 0 { return 1; } return q(a - 1) + 1; }',
        'fn q(a: i64) -> i64 requires a >= 0 ensures (result == a + 2) { if a == 0 { return 2; } return p(a - 1) + 1; }',
        'fn top(a: i64) -> i64 requires a >= 0 ensures (result == a + 2) { let r = p(a); return r + 1; }',
        'fn main() with io { print(str(top(0))); }',
        '',
      ].join('\n'),
    };
  }
  if (k === 2) {
    return {
      tag: '非线性',
      src: [
        'fn sq(a: i64) -> i64 requires a >= 0 ensures (result == a * a) { return a * a; }',
        'fn top(a: i64) -> i64 requires a >= 0 ensures (result == a * a + 1) { let r = sq(a); return r + 1; }',
        'fn main() with io { print(str(top(0))); }',
        '',
      ].join('\n'),
    };
  }
  return {
    tag: '不可编码',
    src: [
      'fn even(a: i64) -> i64 requires a % 2 == 0 ensures (result == a + 1) { return a + 1; }',
      'fn top(a: i64) -> i64 requires a >= 0 ensures (result == a + 2) { let r = even(a); return r + 1; }',
      'fn main() with io { print(str(top(0))); }',
      '',
    ].join('\n'),
  };
}

// v0.55.0 审查修复(B1/B2)回归语料:分支返回 / 分支内形参重赋值 / match 重赋值 /
// 短路 guard。旧实现的直线遍历会"穿透"控制流,错误采用分支内的旧形参值或把短路
// 右侧调用当作无条件求值 → 误报 M3041/M3042。正确行为:控制流/短路右侧不参与线性
// 摘要与调用点证明,整份程序 check 0 诊断。
function genTrickySummaryProgram() {
  const k = int(0, 4);
  if (k === 0) {
    return {
      tag: '分支返回',
      src: [
        'fn f(a: i64) -> i64 requires a >= 0 ensures (result == a) { if a >= 0 { return a; } return 0 - 1; }',
        'fn main() with io { print(str(f(1))); }',
        '',
      ].join('\n'),
    };
  }
  if (k === 1) {
    return {
      tag: '分支重赋值',
      src: [
        'fn g(mut a: i64) -> i64 requires a == 0 ensures (result == a + 5) { if a == 0 { a = 10; return 15; } return 5; }',
        'fn caller(x: i64) -> i64 requires x == 0 ensures (result == x + 15) { return g(x); }',
        'fn main() with io { print(str(caller(0))); }',
        '',
      ].join('\n'),
    };
  }
  if (k === 2) {
    return {
      tag: 'match重赋值',
      src: [
        'fn g(mut a: i64) -> i64 requires a == 0 ensures (result == a + 5) { match a { _ => { a = 10; return 15; } } return 0; }',
        'fn main() with io { print(str(g(0))); }',
        '',
      ].join('\n'),
    };
  }
  if (k === 3) {
    return {
      tag: '短路与',
      src: [
        'fn limit(a: i64) -> i64 requires a > 0 { return a; }',
        'fn f(x: i64) -> i64 requires x <= 0 { let _b = (x > 100) && (limit(x) > 0); return 0; }',
        'fn main() with io { print(str(f(0))); }',
        '',
      ].join('\n'),
    };
  }
  return {
    tag: '短路或',
    src: [
      'fn limit(a: i64) -> i64 requires a > 0 { return a; }',
      'fn f(x: i64) -> i64 requires x <= 0 { let _b = (x <= 0) || (limit(x) > 0); return 0; }',
      'fn main() with io { print(str(f(0))); }',
      '',
    ].join('\n'),
  };
}

// 从 M3041/M3042 消息中取反例赋值(格式由 checker 固定:`(反例:a = -2)` / `a = 0, b = 1`)。
function cexOfMessage(msg) {
  const m = /\(反例:([^)]*)\)/.exec(msg ?? '');
  if (!m) return null;
  const vals = {};
  for (const part of m[1].split(', ')) {
    const eq = part.split(' = ');
    if (eq.length !== 2) return null;
    try { vals[eq[0].trim()] = BigInt(eq[1].trim()); } catch { return null; }
  }
  return Object.keys(vals).length ? vals : null;
}

function ming(args) {
  const r = spawnSync(process.execPath, [MING, ...args], { encoding: 'utf8', timeout: 30000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ===================== 主循环 =====================
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-proof-fuzz-'));
const failures = [];
const report = (mode, it, why, src) => {
  failures.push(`${mode} 第 ${it} 例(seed=${SEED})\n${why.map((w) => '  ! ' + w).join('\n')}\n--- 程序 ---\n${src}`);
};
let m1 = 0, m1Fail = 0, m1ProvenRuns = 0, m2ver = 0, m2ok = 0, m2ctrl = 0;
let sOk = 0, sViol = 0, sSilent = 0, sTricky = 0, sFail = 0, sFalsePos = 0, sCexOk = 0, sLowShape = 0;
let lpProv = 0, lpSilent = 0, lpViol = 0, lpViolOk = 0, lpFail = 0; // loops 模式(v0.57)
const sSilentTags = { '递归': 0, '互递归': 0, '非线性': 0, '不可编码': 0 };

try {
  const M2N_ALL = Math.max(6, Math.ceil(COUNT / 5));
  const modeDesc = {
    default: `模式 1 ${COUNT} 例 + 模式 2 ${M2N_ALL} 例`,
    1: `模式 1 ${COUNT} 例`,
    2: `模式 2 ${M2N_ALL} 例`,
    summaries: `模式 summaries ${COUNT} 例`,
    loops: `模式 loops ${COUNT} 例`,
    all: `模式 1 ${COUNT} 例 + 模式 2 ${M2N_ALL} 例 + 模式 summaries ${COUNT} 例`,
  }[MODE];
  process.stdout.write(`proof_fuzz:seed=${SEED} count=${COUNT}(${modeDesc})\n`);

  // ---- 模式 1:误报检测 ----
  if (MODE === 'default' || MODE === '1' || MODE === 'all')
  for (let it = 0; it < COUNT; it++) {
    const t = pick(M1);
    const L = int(1, 8);
    const argVals = sampleArgs(t, L);
    const bufVals = Array.from({ length: L }, () => BigInt(int(1, 99)));
    const why = [];
    if (!argVals) {
      why.push(`生成器缺陷:可证类模板找不到满足 requires 的实参(L=${L})`);
      const src = buildProgram(t, L, Object.fromEntries(t.params.map((x) => [x.name, '?'])), bufVals);
      report('模式1', it, why, src); m1++; m1Fail++; continue;
    }
    const src = buildProgram(t, L, argVals, bufVals);
    const f = path.join(TMPDIR, `m1_${it}.ming`);
    fs.writeFileSync(f, src);
    const c = ming(['check', f, '--json', '--proof-report']);
    if (c.code !== 0) why.push(`check 退出 ${c.code}(生成器只产非违反形态;M3045 即误报):${(c.stderr ?? '').slice(0, 200)}`);
    let proofs = null;
    try { proofs = JSON.parse(c.stdout).proofs; } catch { why.push(`check stdout 非 JSON:${c.stdout.slice(0, 120)}`); }
    const rec = proofs?.functions?.find((x) => x.fn === 'f');
    if (proofs && !rec) why.push(' proofs 无函数记录(应含 f 的索引义务)');
    if (rec) {
      if (rec.obligations.length !== 1) why.push(` 义务数 ${rec.obligations.length} ≠ 1`);
      for (const o of rec.obligations) {
        if (o.kind === 'violated') why.push(` 非违反形态被判 violated —— 误报:${o.obligation}`);
        else if (o.kind === 'proven') {
          m1ProvenRuns++;
          for (const eng of [['run'], ['run', '--tree']]) {
            const r = ming([...eng, f]);
            if (r.code !== 0 || /M4003|M4015/.test(r.stderr ?? '')) {
              why.push(` 义务 proven 但 ${eng.join(' ')} 退出 ${r.code}/stderr 含 M4003|M4015 —— 误报:${(r.stderr ?? '').slice(0, 200)}`);
            }
          }
        } else if (t.cls === 'P') {
          why.push(` 可证类模板未 proven(kind=${o.kind},obligation=${o.obligation})—— 证明能力回归`);
        }
      }
    }
    m1++;
    if (why.length) { m1Fail++; report('模式1', it, why, src); }
  }

  // ---- 模式 2:反例验证(每 8 例 1 例负控)----
  const M2N = Math.max(6, Math.ceil(COUNT / 5));
  if (MODE === 'default' || MODE === '2' || MODE === 'all')
  for (let it = 0; it < M2N; it++) {
    const isCtrl = it % 8 === 7;
    const t = isCtrl ? null : pick(M2);
    const L = int(0, 8); // 静态判定与调用点长度无关;反例值来自 checker 枚举
    const bufVals = Array.from({ length: L }, () => BigInt(int(1, 99)));
    const argVals = isCtrl ? { n: BigInt(int(0, L)) } : sampleArgs(t, L) ?? { [t.params[0].name]: 0n };
    const src = isCtrl
      ? buildProgram(M2CTRL, L, argVals, bufVals, M2CTRL.req)
      : buildProgram(t, L, argVals, bufVals);
    const f = path.join(TMPDIR, `m2_${it}.ming`);
    fs.writeFileSync(f, src);
    const why = [];
    if (isCtrl) {
      m2ctrl++;
      const c = ming(['check', f, '--json', '--proof-report']);
      if (c.code !== 0) why.push(`负控(不可编码 requires)被报错(退出 ${c.code})—— 误报:${(c.stderr ?? '').slice(0, 200)}`);
      if (/M3045|W3105/.test(c.stderr ?? '')) why.push('负控发 M3045/W3105 —— 误报');
    } else {
      m2ver++;
      const c = ming(['check', f, '--json', '--proof-report']);
      if (c.code !== 1) why.push(`可证违反形态 check 退出 ${c.code} ≠ 1(M3045 未发)`);
      let diags = null, proofs = null;
      try { const j = JSON.parse(c.stdout); diags = j.diagnostics; proofs = j.proofs; } catch { why.push(`check stdout 非 JSON:${c.stdout.slice(0, 120)}`); }
      if (diags && !diags.some((d) => d.code === 'M3045' && d.severity === 'error')) {
        why.push(` JSON 诊断无 error M3045:${JSON.stringify(diags).slice(0, 200)}`);
      }
      const rec = proofs?.functions?.find((x) => x.fn === 'f');
      const ob = rec?.obligations?.[0];
      if (!ob || ob.kind !== 'violated') why.push(` proofs 无 violated 义务(kind=${ob?.kind ?? '无记录'})`);
      const vals = ob ? parseCex(ob.counterexample) : null;
      if (!vals) why.push(` 反例缺失或不可解析:${JSON.stringify(ob?.counterexample ?? null)}`);
      if (vals) {
        // 独立求值器双验证:反例满足全部 requires,且使索引越出义务侧
        const holds = t.leaves.every(([l, op, r]) => leafHolds(l, op, r, vals));
        if (!holds) why.push(` 反例不满足 requires:${JSON.stringify(vals)}(生成器叶子:${reqText(t.leaves)})`);
        const iv = sideEval(t.idx, vals);
        const lenV = vals[LEN];
        const oob = t.side === 'low' ? iv < 0n : (lenV === undefined ? null : iv >= lenV);
        if (oob === null) why.push(` 反例缺 ${LEN},无法验证 ${t.side} 侧越界:${JSON.stringify(vals)}`);
        else if (!oob) why.push(` 反例未使索引越界(${t.side} 侧):idx=${iv},${JSON.stringify(vals)}`);
        if (oob) m2ok++;
      }
    }
    if (why.length) report(isCtrl ? '模式2负控' : '模式2', it, why, src);
  }

  // ---- 模式 summaries:跨函数契约摘要(v0.55)----
  // 每 12 例固定分布:6 可证(ok)/ 2 调用点违反(M3041)/ 1 ensures 可证假(M3042)/
  // 2 静默(递归等)/ 1 易误报语料(分支返回/分支重赋值/短路 guard;B1/B2 回归)。
  // ok 类负控:--proof-report 的 summaries 必须显示 ensures_present/ensures_proven=true,
  // 证明"调用方 ensures 仅靠被调已证 ensures 才可证"(摘要确实被采用,而非空转)。
  if (RUN_SUM) {
    for (let it = 0; it < COUNT; it++) {
      const slot = it % 12;
      const kind = slot <= 5 ? 'ok' : slot <= 7 ? 'callsite' : slot === 8 ? 'ensfalse' : slot <= 10 ? 'silent' : 'tricky';
      const why = [];
      let src, spec = null, silentTag = null;
      if (kind === 'silent') {
        const g = genSilentSummaryProgram();
        src = g.src; silentTag = g.tag;
      } else if (kind === 'tricky') {
        const g = genTrickySummaryProgram();
        src = g.src; silentTag = g.tag;
      } else {
        spec = genSummaryChain(kind);
        src = summaryProgram(spec);
      }
      const f = path.join(TMPDIR, `sum_${it}.ming`);
      fs.writeFileSync(f, src);
      const c = ming(['check', f, '--json', '--proof-report']);
      let j = null;
      try { j = JSON.parse(c.stdout); } catch { why.push(`check stdout 非 JSON:${(c.stdout ?? '').slice(0, 120)}`); }
      const diags = j?.diagnostics ?? [];
      const label = kind === 'silent' ? `summaries静默(${silentTag})`
        : kind === 'tricky' ? `summaries易误报(${silentTag})`
        : kind === 'ok' ? 'summaries可证' : kind === 'callsite' ? 'summaries调用点违反' : 'summaries-ensures违反';
      if (kind === 'ok' || kind === 'silent' || kind === 'tricky') {
        // 可证/静默/易误报:必须 0 诊断(任何诊断都是误报)
        if (c.code !== 0) why.push(`check 退出 ${c.code} ≠ 0(应静默):${JSON.stringify(diags).slice(0, 240)}`);
        if (diags.length !== 0) why.push(`check 诊断非空(误报):${JSON.stringify(diags).slice(0, 240)}`);
        if (kind === 'ok') {
          // 负控:摘要确实被采用(requires 完整且 ensures_present/ensures_proven=true)
          const sums = j?.proofs?.summaries ?? [];
          for (let i = 0; i < spec.n; i++) {
            const s = sums.find((x0) => x0.fn === `f${i}`);
            if (!s) why.push(`摘要缺失:f${i}`);
            else if (s.requires_complete !== true) why.push(`f${i}.requires 不完整(生成器缺陷)`);
            else if (s.ensures_present !== true || s.ensures_proven !== true) {
              why.push(`摘要未被采用:f${i} ensures_present=${s.ensures_present} ensures_proven=${s.ensures_proven}`);
            }
          }
        }
        if (why.length) { sFail++; sFalsePos++; report(label, it, why, src); }
        else if (kind === 'silent') { sSilent++; sSilentTags[silentTag] = (sSilentTags[silentTag] ?? 0) + 1; }
        else if (kind === 'tricky') { sTricky++; sSilentTags[silentTag] = (sSilentTags[silentTag] ?? 0) + 1; }
        else sOk++;
        continue;
      }
      // 可证违反:恰好一条期望诊断,且反例经独立求值器复核
      const want = kind === 'callsite' ? 'M3041' : 'M3042';
      const hit = diags.filter((d) => d.code === want);
      if (hit.length !== 1) why.push(`期望恰好 1 条 ${want},实际:${JSON.stringify(diags.map((d) => d.code))}`);
      if (diags.some((d) => d.code !== want)) why.push(`出现非期望诊断:${JSON.stringify(diags.map((d) => d.code))}`);
      const vals = hit.length === 1 ? cexOfMessage(hit[0].message) : null;
      if (!vals || vals.a === undefined) why.push(`反例缺失或不可解析:${JSON.stringify(hit[0]?.message ?? null)}`);
      else if (kind === 'callsite') {
        const ix = spec.violAt;
        const x = vals.a;
        if (spec.lowShape) sLowShape++;
        if (!summaryReqHolds(spec, ix, x)) why.push(`M3041 反例不满足调用方 f${ix} requires(a ${spec.reqs[ix].op} ${spec.reqs[ix].n}):a = ${x}`);
        const arg = x + BigInt(spec.K[ix]);
        if (summaryReqHolds(spec, ix + 1, arg)) why.push(`M3041 反例未违反被调 f${ix + 1} requires(a ${spec.reqs[ix + 1].op} ${spec.reqs[ix + 1].n}):a = ${arg}`);
        if (!why.length) sCexOk++;
      } else {
        const ix = spec.falseAt;
        const x = vals.a;
        if (!summaryReqHolds(spec, ix, x)) why.push(`M3042 反例不满足 f${ix} requires(a ${spec.reqs[ix].op} ${spec.reqs[ix].n}):a = ${x}`);
        const actual = summaryActual(spec, ix, x); // 独立复算真实返回
        const declared = x + BigInt(spec.declC[ix]);
        if (actual === declared) why.push(`M3042 反例下独立复算实际返回 ${actual} == 声明 ${declared}(反例不成立)`);
        if (!why.length) sCexOk++;
      }
      if (why.length) { sFail++; report(label, it, why, src); } else sViol++;
    }
  }

  // ---- 模式 loops:范围 for 循环义务(v0.57 QF_LIA 第四片)----
  // 每 8 例固定分布:0-3 可证(义务必须 proven + 双引擎运行安全)/ 4-5 静默(放弃形态,0 诊断)/
  // 6-7 可证违反(M3045 必发;反例独立求值器三重验证:requires 全满足、落在循环区间内(区间非空,
  // 违反不是空洞真)、索引确实越出义务侧)。
  if (RUN_LOOPS) {
    for (let it = 0; it < COUNT; it++) {
      const slot = it % 8;
      const t = slot <= 3 ? pick(L1) : slot <= 5 ? pick(LS) : pick(L2);
      const L = int(1, 8);
      const bufVals = Array.from({ length: L }, () => BigInt(int(1, 99)));
      const argVals = t.cls === 'V'
        ? Object.fromEntries(t.params.map((x) => [x.name, 0n]))
        : (sampleArgs(t, L) ?? Object.fromEntries(t.params.map((x) => [x.name, 0n])));
      const src = buildProgram(t, L, argVals, bufVals);
      const f = path.join(TMPDIR, `lp_${it}.ming`);
      fs.writeFileSync(f, src);
      const why = [];
      const c = ming(['check', f, '--json', '--proof-report']);
      if (t.cls === 'P') {
        lpProv++;
        if (c.code !== 0) why.push(`check 退出 ${c.code}(可证类不得 M3045 —— 误报):${(c.stderr ?? '').slice(0, 200)}`);
        let proofs = null;
        try { proofs = JSON.parse(c.stdout).proofs; } catch { why.push(`check stdout 非 JSON:${c.stdout.slice(0, 120)}`); }
        const rec = proofs?.functions?.find((x) => x.fn === 'f');
        if (proofs && !rec) why.push(' proofs 无函数记录(应含 f 的循环索引义务)');
        if (rec) {
          if (rec.obligations.length < 1) why.push(' 义务数为 0(可证类模板应采集到循环义务)');
          for (const o of rec.obligations) {
            if (o.kind === 'violated') why.push(` 可证类被判 violated —— 误报:${o.obligation}`);
            else if (o.kind === 'proven') {
              if (o.scope !== 'loop') why.push(` 义务 scope=${o.scope} ≠ loop(记录缺陷):${o.obligation}`);
              for (const eng of [['run'], ['run', '--tree']]) {
                const r = ming([...eng, f]);
                if (r.code !== 0 || /M4003|M4015/.test(r.stderr ?? '')) {
                  why.push(` 义务 proven 但 ${eng.join(' ')} 退出 ${r.code}/stderr 含 M4003|M4015 —— 误报:${(r.stderr ?? '').slice(0, 200)}`);
                }
              }
            } else why.push(` 可证类义务未 proven(kind=${o.kind},obligation=${o.obligation})—— 证明能力回归`);
          }
        }
      } else if (t.cls === 'S') {
        lpSilent++;
        if (c.code !== 0) why.push(`check 退出 ${c.code} ≠ 0(放弃形态不得报错):${(c.stderr ?? '').slice(0, 200)}`);
        let proofs = null;
        try { proofs = JSON.parse(c.stdout).proofs; } catch { /* 静默类只要求 0 诊断 */ }
        if (proofs?.functions?.find((x) => x.fn === 'f')?.obligations?.some((o) => o.kind === 'violated')) {
          why.push(' 静默类出现 violated 义务 —— 误报');
        }
      } else {
        lpViol++;
        if (c.code !== 1) why.push(`可证违反形态 check 退出 ${c.code} ≠ 1(M3045 未发)`);
        let diags = null, proofs = null;
        try { const j = JSON.parse(c.stdout); diags = j.diagnostics; proofs = j.proofs; } catch { why.push(`check stdout 非 JSON:${c.stdout.slice(0, 120)}`); }
        if (diags && !diags.some((d) => d.code === 'M3045' && d.severity === 'error')) {
          why.push(` JSON 诊断无 error M3045:${JSON.stringify(diags).slice(0, 200)}`);
        }
        const rec = proofs?.functions?.find((x) => x.fn === 'f');
        const ob = rec?.obligations?.find((o) => o.kind === 'violated');
        if (!ob) why.push(` proofs 无 violated 义务:${JSON.stringify(rec?.obligations?.map((o) => o.kind) ?? null)}`);
        const vals = ob ? parseCex(ob.counterexample) : null;
        if (!vals) why.push(` 反例缺失或不可解析:${JSON.stringify(ob?.counterexample ?? null)}`);
        if (vals) {
          // 独立求值器三重验证(不 import src/prover.js)
          if (!t.leaves.every(([l, op, r]) => leafHolds(l, op, r, vals))) {
            why.push(` 反例不满足 requires:${JSON.stringify(vals)}(叶子:${reqText(t.leaves)})`);
          }
          const iv = sideEval(t.idx, vals);
          const inLo = leafHolds(t.interval[0], '<=', t.idx, vals);
          const inHi = leafHolds(t.idx, '<', t.interval[1], vals);
          if (!inLo || !inHi) why.push(` 反例不落在循环区间 [${sideText(t.interval[0])}, ${sideText(t.interval[1])}):i = ${iv},${JSON.stringify(vals)}`);
          const lenV = vals[LEN];
          const oob = t.side === 'low' ? iv < 0n : (lenV === undefined ? null : iv >= lenV);
          if (oob === null) why.push(` 反例缺 ${LEN},无法验证 ${t.side} 侧越界:${JSON.stringify(vals)}`);
          else if (!oob) why.push(` 反例未使索引越界(${t.side} 侧):idx=${iv},${JSON.stringify(vals)}`);
          if (!why.length) lpViolOk++;
        }
      }
      if (why.length) {
        lpFail++;
        report(t.cls === 'V' ? 'loops违反' : t.cls === 'P' ? 'loops可证' : 'loops静默', it, why, src);
      }
    }
  }
} finally {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
}

// ===================== 汇总 =====================
if (RUN_M12) process.stdout.write(`\nproof_fuzz 汇总:模式 1 ${m1} 例,误报 ${m1Fail}(proven 运行验证 ${m1ProvenRuns} 例 × 双引擎);模式 2 反例验证 ${m2ok}/${m2ver},负控 ${m2ctrl} 例\n`);
if (RUN_SUM) process.stdout.write(`\nproof_fuzz summaries 汇总:可证 ${sOk} / 违反 ${sViol} / 静默 ${sSilent} / 易误报语料 ${sTricky} / 误报 ${sFalsePos}(反例独立验证 ${sCexOk}/${sViol};下界 requires 形态 ${sLowShape};静默分类:递归 ${sSilentTags['递归'] ?? 0} / 互递归 ${sSilentTags['互递归'] ?? 0} / 非线性 ${sSilentTags['非线性'] ?? 0} / 不可编码 ${sSilentTags['不可编码'] ?? 0} / 分支返回 ${sSilentTags['分支返回'] ?? 0} / 分支重赋值 ${sSilentTags['分支重赋值'] ?? 0} / match重赋值 ${sSilentTags['match重赋值'] ?? 0} / 短路与 ${sSilentTags['短路与'] ?? 0} / 短路或 ${sSilentTags['短路或'] ?? 0})\n`);
if (RUN_LOOPS) process.stdout.write(`\nproof_fuzz loops 汇总:可证 ${lpProv}(义务逐条双引擎运行验证)/ 静默 ${lpSilent} / 违反 ${lpViolOk}/${lpViol}(反例独立三重验证)/ 误报 ${lpFail}\n`);
if (failures.length) {
  process.stderr.write(`\n失败清单(${failures.length}):\n` + failures.join('\n---\n') + '\n');
  process.exit(1);
}
if (RUN_LOOPS) process.stdout.write('proof_fuzz loops:误报 0,反例独立验证全过 — 通过\n');
else if (RUN_SUM && !RUN_M12) process.stdout.write('proof_fuzz summaries:误报 0,反例独立验证全过 — 通过\n');
else if (RUN_SUM) process.stdout.write('proof_fuzz:模式 1/2 与 summaries 全过 — 通过\n');
else process.stdout.write('proof_fuzz:误报 0,反例验证全过 — 通过\n');
