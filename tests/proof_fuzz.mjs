// tests/proof_fuzz.mjs — v0.52 静态边界证明模糊器(零依赖;plan §4.2.3 任务 6)。
// 思路:prover 声称"proven"时,运行时必须真的安全;声称"violated"时,反例必须真的成立。
// 两个模式,各查一个方向的谎言:
//   模式 1(误报检测):生成"非 mut Vec[i64] 参数 + i64 参数 + 线性 requires + 直线体含 buf[i]"
//     的 .ming,生成器用自带求值器保证实参满足 requires。凡 check --json --proof-report 判
//     proven 的索引,断言 `run` 与 `run --tree` 退出 0 且无 M4003/M4015 —— 证明器说安全,
//     运行时就必须安全。可证类模板额外断言"必须 proven"(防止证明能力退化使模糊器空转);
//     不可证类(U)断言不判 violated(不可编码形态不得误报 M3045)。
//   模式 2(反例验证):生成可证违反形态,断言 M3045 必发;用本文件独立实现的小型线性求值器
//     (刻意不 import src/prover.js)验证反例:反例值满足全部 requires 且使索引越出义务侧。
//     每 8 例抽 1 例为负控(requires 含 buf[n] 的不可编码形态)——断言保持静默(不误报)。
// 说明:M3045 语料无法用于运行时复核 —— `ming run` 先 check,M3045 直接拒绝执行(exit 1);
//   因此"violated → 运行时必 M4003"由 §56 的运行时测试与差分模糊承担,本文件只做静态一致性。
// 用法:node tests/proof_fuzz.mjs [--seed N] [--count N](默认种子固定,保证可复现)
//   默认 --count 200:模式 1 跑 200 例,模式 2 跑 ceil(count/5) 例(200 → 40)。
// 末尾汇总"误报 F / 反例验证 ok/N";任一失败退出 1。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1]) : d; };
const SEED = opt('seed', 20261112);
const COUNT = Math.max(1, opt('count', 200));

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

function buildProgram(t, L, argVals, bufVals, reqOverride = null) {
  const req = reqOverride ?? (t.paren ? '(' + reqText(t.leaves) + ')' : reqText(t.leaves));
  const sig = ['buf: Vec[i64]', ...t.params.map((x) => (x.mut ? `mut ${x.name}: i64` : `${x.name}: i64`))].join(', ');
  const lines = [`fn f(${sig}) -> i64 requires ${req} {`];
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

try {
  process.stdout.write(`proof_fuzz:seed=${SEED} count=${COUNT}(模式 1 ${COUNT} 例 + 模式 2 ${Math.max(6, Math.ceil(COUNT / 5))} 例)\n`);

  // ---- 模式 1:误报检测 ----
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
} finally {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
}

// ===================== 汇总 =====================
process.stdout.write(`\nproof_fuzz 汇总:模式 1 ${m1} 例,误报 ${m1Fail}(proven 运行验证 ${m1ProvenRuns} 例 × 双引擎);模式 2 反例验证 ${m2ok}/${m2ver},负控 ${m2ctrl} 例\n`);
if (failures.length) {
  process.stderr.write(`\n失败清单(${failures.length}):\n` + failures.join('\n---\n') + '\n');
  process.exit(1);
}
process.stdout.write('proof_fuzz:误报 0,反例验证全过 — 通过\n');
