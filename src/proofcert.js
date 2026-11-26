// proofcert.js — Ming 线性不可满足证书(负环 / Farkas 型)渲染(v1.3.0 S-3a,ADR-014 §6.2)。
//
// 职责:纯格式转换,零依赖、零 IO、无全局状态——同样的证书数据恒产出逐字节相同的文本
//       (无时间戳、无绝对路径、无随机顺序;引用按**假设采集序** (断言序号, 归一方向) 排序;
//        变量符号与 `--proof-format smt-lib` 同一重写面,两件工件可互相对照)。
//       本模块**不重算归一、不做判定**:证书数据由 src/prover.js 在**同一次** Bellman-Ford
//       求解中顺带产出(edge → {ai, dir, row}),checker 只做搬运与真空二次求解。这样
//       "证书说不可满足"与"判定说 proven"在构造上不可能不一致——两者是同一个计算的两个视图;
//       也避免在渲染层二次实现编码规则(duplicated encoding = drift = 假证书)。
//
// 判据(冻结面;规范 docs/proof-protocol.md §10):
//   每条引用约束规范为 `Σ c_i x_i <= K_i`;存在非负整数 λ 使 `Σ λ_i c_i = 0`(逐变量恒等)
//   且 `Σ λ_i K_i < 0` ⇒ 编码后的约束集在整数域不可满足。(健全方向只走"不可行 ⇒ 不可行";
//   整数域完全性不在承诺面 —— 见协议 §10 覆盖边界。)
//   本实现产出的 λ 恒为 1:负环是**简单环**,同一断言在一个负环中至多引用一次。
//   `(= a b)` 拆出的两条边互为反向、且常数项恰互为相反数(权 0 的二环),因此
//   **不可能同处一个负环**(那是 λ=1 的依据,不是"不可能同处一个环"——它们当然可以构成二环)。
//   判据允许多重引用(λ > 1),格式已显式携带 λ。
//
// 数据形状(checker 的 VC 记录;本模块只读不改):
//   { file, abs, fn, index, scope, idxText, form, lenVar, assumptions,
//     low: 'proven'|'refuted'|'unknown', high: 同,
//     vacuous?: bool,                                   // 仅 --proof-format cert 时挂载
//     lowCert?/highCert?: { refs: [{ai, dir, row:{coeffs: Map, K: BigInt}}], usesGoal }
//                       | { refs: [], usesGoal: false, unavailable: '<原因>' } }
//   ai  = 该方向块 assumptions 数组的下标(0 起;取反目标恒为末条 = assumptions.length-1);
//   dir = toLePairs 的第几条归一('==' 拆双向时 1 = 反向,否则恒 0);
//   row = 归一后的 `Σ c_i x_i <= K`(coeffs = 变量系数,K = 右端常数;锚点不是变量)。
//
// 渲染纪律:证书文本全部以 `;` 起行(纯注释面,不是 SMT-LIB、不冒充 Alethe);
//   引用列表的顺序由假设采集序决定,环的遍历序只作内部中间量(ADR-014 §5.2 确定性);
//   字节确定性由 tests/cert_fixtures/ 逐字节黄金锁定(更新即审查信号)。

import { smtRenameAll } from './proofsmt.js';

const HEADER = [
  '; ===== Ming 线性不可满足证书(cert v1)=====',
  '; spec: ming-proof-protocol/1 · cert v1——判据与归一规则见 docs/proof-protocol.md §10;渲染面为实验性(消费者应解析结构,不应比较排版)。',
  '; 判据:每条引用约束规范为 Σ c_i x_i <= K_i;存在非负整数 λ 使 Σ λ_i c_i = 0(逐变量恒等)且 Σ λ_i K_i < 0 ⇒ 编码后的约束集在整数域不可满足。',
  '; 归一:(< a b) ⇒ a-b <= -1(整数语义);(<= a b) ⇒ a-b <= 0;(>= a b)/(> a b) ⇒ 取反对称;(= a b) ⇒ 拆双向(ref 行的 d0/d1);(not P) ⇒ 取 P 的对偶比较符再归一。',
  '; 覆盖边界:只覆盖已采集义务中判定来源为单一负环的 proven 方向;无证书的 proven 具名标注(常量矛盾/无单一负环),覆盖率不承诺(证明面扩面后可能出现无证书的 proven)。',
  '; 有效性:只证"该义务按本协议编码后的约束集不可满足";不证编码忠实于源码、不证运行时安全(proven 不消除 M4003 边界 panic)。',
  '; 引用序号 = 该方向块内 (assert ...) 的 1 起序(取反目标为末条),与 --proof-format smt-lib 同块同序;变量符号与 smt-lib 输出同一重写面。',
];

// 无证书原因 → 诚实文本(逐字面固定;新增原因必须同时登记协议覆盖边界与测试)。
const REASON_TEXT = new Map([
  ['refuted', 'refuted 方向无不可满足性证书(内部判定:违反方向被假设集强制)'],
  ['unknown', '内部未判定(unknown;目标未编码或超出差分片段)'],
  ['const-false', '常量矛盾(constFalse;LHS 为空的单条矛盾断言,v1 不渲染该形态)'],
  ['no-cycle', '判定来源无单一负环(防御路径;cycle 为空)'],
  ['goal-split', '目标为 == 双向拆分证明(两向各自成立,无单一负环)'],
  ['goal-conjunction', '目标取反为合取(!=;无单一负环)'],
  ['unrenderable-assumption', '该方向的假设集含不可渲染为 SMT 断言的形态(!= 等),断言序号无法与 smt-lib 块对齐(v1 不产证书)'],
  ['missing', '证书数据缺失(内部一致性缺口——不应出现,请报告)'],
]);

// 变量名序:码位序(不依赖 locale;确定性口径与 reset 无关)。
function cmpName(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// 归一后的行 → `{var: coef, ...} <= K`(变量按码位序;符号已重写)。
function rowText(row, ren) {
  const parts = [];
  for (const [k, cf] of [...row.coeffs.entries()].sort((a, b) => cmpName(a[0], b[0]))) {
    parts.push(`${ren.get(k) ?? k}: ${cf}`);
  }
  return `{${parts.join(', ')}} <= ${row.K}`;
}

// 整脚本符号重写面(与 src/proofsmt.js renderProofScript 的采集算法同序:VC 采集序、
// 假设逐条 (lhs, rhs) 系数 Map 插入序、form、lenVar;目标不可编码的 VC 不进入重写域)。
// 独立实现而非共享函数:proofsmt.js 的采集在渲染函数内部(不改既有模块),本模块
// 按同一算法复算;两件工件符号一致性由 tests/cert_check.mjs 阶段 C 逐块对照钉住。
function collectRename(vcs) {
  const names = [];
  const seen = new Set();
  const add = (n) => { if (n && !seen.has(n)) { seen.add(n); names.push(n); } };
  for (const vc of vcs) {
    if (!vc.form) continue;
    for (const a of vc.assumptions) {
      for (const k of a.lhs.coeffs.keys()) add(k);
      for (const k of a.rhs.coeffs.keys()) add(k);
    }
    for (const k of vc.form.coeffs.keys()) add(k);
    add(vc.lenVar);
  }
  return smtRenameAll(names);
}

// 一个方向的证书数据(view 层;不重算任何归一)。
function buildDir(vc, dir, ren) {
  const verdict = vc[dir] ?? 'unknown';
  const vacuous = vc.vacuous === true;
  if (verdict !== 'proven') {
    return { verdict, vacuous: null, usesGoal: null, refs: null, reason: verdict === 'refuted' ? 'refuted' : 'unknown' };
  }
  const cert = (dir === 'low' ? vc.lowCert : vc.highCert) ?? null;
  if (!cert) return { verdict, vacuous, usesGoal: null, refs: null, reason: 'missing' };
  if (cert.unavailable) return { verdict, vacuous, usesGoal: null, refs: null, reason: cert.unavailable };
  const refs = cert.refs.map((r) => ({
    ai: r.ai + 1, // 输出口径 = 1 起断言序号(该方向块内 (assert ...) 序)
    dir: r.dir,
    lambda: 1,
    norm: rowText(r.row, ren),
    row: r.row,
  }));
  // 引用序 = 假设采集序(prover 已按 (ai, dir) 排好序;此处再排一次为防御,保持幂等)。
  refs.sort((a, b) => a.ai - b.ai || a.dir - b.dir);
  refs.forEach((r, i) => { r.n = i + 1; });
  // 恒等式的自述值(纯信息;复核者必须自行重算,不信任本行 —— 见协议 §10)。
  const sum = new Map();
  let sumK = 0n;
  for (const r of refs) {
    for (const [k, cf] of r.row.coeffs) sum.set(k, (sum.get(k) ?? 0n) + cf);
    sumK += r.row.K;
  }
  let coeffZero = true;
  for (const v of sum.values()) if (v !== 0n) coeffZero = false;
  return { verdict, vacuous, usesGoal: cert.usesGoal === true, refs, reason: null, coeffZero, sumK };
}

// checker 结果集(或已聚合的 VC 列表)→ 证书数据。bin 传入与 SMT 导出**同一份** collectVcs
// 结果(单源,避免两处去重回退键分叉);也接受 checker 结果数组(取 `.vcs`),便于直连调用。
// 去重键与 bin/ming.js 的 collectVcs 同源:abs+fn+index(多入口共享模块只取首次出现的一份,
// 展示路径原样)。
export function buildCerts(checkResults) {
  const flat = (checkResults ?? []).flatMap((x) => (x && Array.isArray(x.vcs) ? x.vcs : [x]));
  const vcs = [];
  const seen = new Set();
  for (const vc of flat) {
    if (!vc || typeof vc.fn !== 'string') continue;
    const key = (vc.abs ?? vc.file) + '\u0000' + vc.fn + '\u0000' + vc.index;
    if (seen.has(key)) continue;
    seen.add(key);
    vcs.push(vc);
  }
  const ren = collectRename(vcs);
  return vcs.map((vc) => ({
    file: vc.file,
    fn: vc.fn,
    index: vc.index,
    scope: vc.scope ?? 'body',
    // 索引原文按源文切出,可含换行/缩进 —— 注释以 ; 起行、行尾终止,空白折叠为单空格
    // (与 proofsmt.js 同款防裸 token 行纪律)。
    idxText: String(vc.idxText ?? '?').replace(/\s+/g, ' ').trim(),
    low: buildDir(vc, 'low', ren),
    high: buildDir(vc, 'high', ren),
  }));
}

function renderDir(dir, d) {
  const out = [`; dir: ${dir}`, `; verdict: ${d.verdict}`];
  // 未登记的原因键**不**静默回落成别的说法(直接具名未知原因,由参考检查器判失败)。
  // buildDir 恒给出非 null 的 reason(refs 为 null 的三个分支分别取 refuted/unknown/
  // 'missing'/'<unavailable 原因>'),故这里不需要 null 兜底分支。
  const reasonText = REASON_TEXT.get(d.reason) ?? `未知原因(${d.reason};内部一致性缺口——请报告)`;
  if (d.refs === null) {
    if (d.verdict === 'proven') {
      out.push(`; uses_goal: n/a`);
      out.push(`; vacuous: ${d.vacuous === true}`);
    }
    out.push(`; 无证书:${reasonText}`);
    return out;
  }
  out.push(`; uses_goal: ${d.usesGoal}`);
  out.push(`; vacuous: ${d.vacuous === true}`);
  out.push(`; refs: ${d.refs.length}`);
  for (const r of d.refs) out.push(`; ref ${r.n}: #${r.ai} d${r.dir} | norm: ${r.norm} | λ=${r.lambda}`);
  const idZero = d.coeffZero ? '0(逐变量恒等)' : '非零(无效——请报告)';
  const idK = d.sumK < 0n ? `${d.sumK} (< 0)` : `${d.sumK} (≥ 0——无效,请报告)`;
  out.push(`; identity: Σc = ${idZero} | ΣK = ${idK}`);
  return out;
}

// 证书数据 → 完整证书文本(末尾换行)。文件按首次出现顺序分节注释;零义务输出
// "头 + ; 无证明义务"(诚实:空证书不伪装成有结论)。
export function renderCertScript(certs) {
  const lines = [...HEADER];
  if (!certs || certs.length === 0) {
    lines.push('; 无证明义务');
    return lines.join('\n') + '\n';
  }
  let curFile = null;
  for (const c of certs) {
    if (c.file !== curFile) {
      curFile = c.file;
      lines.push('');
      lines.push(`; ===== 文件:${curFile} =====`);
    }
    lines.push(`; ---- vc:${c.fn}:${c.index} — 索引 ${c.idxText}(scope: ${c.scope})----`);
    lines.push(...renderDir('low', c.low));
    lines.push(...renderDir('high', c.high));
  }
  return lines.join('\n') + '\n';
}
