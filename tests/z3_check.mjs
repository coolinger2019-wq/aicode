// tests/z3_check.mjs — Z3 外部消费验证(plan §4.20 R-15 剩余子项 / roadmap §5.1 交付物)。
//
// 职责:把 docs/proof-protocol.md §6.1/§6.2 的外部消费流程自动化为一条命令——
//   1. 探测 z3(PATH;`z3 --version`)。不可用 → 打印跳过原因 + exit 0(本机开发环境常态;
//      外部环境由 CI 的 z3-verify job 提供:ubuntu runner apt 装 z3 后本脚本必须真跑)。
//   2. 内联生成语料到临时目录(确定性,不依赖仓库文件)→ `ming check <f> --proof-format smt-lib`
//      取 stdout 脚本 → 写 .smt2 → `z3 <file>` → 逐行解析回答(每行 sat/unsat/unknown,
//      顺序 = 脚本块序)→ 与脚本注释中的内部判定逐块对照。
//   3. 断言口径(协议 §3.4 判定注释表 + §6.2 结果解读):
//      - proven  → z3 必须 unsat(严格断言);
//      - refuted → z3 必须 sat。若 z3 答 unsat,按 §6.2 规则 4 先核对"假设集自身可满足性"
//        (去掉取反目标后的假设块单独求解):假设集自身 unsat → 豁免通过("反例声明在
//        不可满足假设集上无意义");假设集 sat → 真实分歧候选,失败;
//      - unknown → 不做断言,仅记录回答。
//      每个语料同时断言内部判定注释与语料设计一致(proven/refuted/unknown 逐块、块数、
//      check-sat 数)——守住"语料确实走到了预期路径",而不是只看 z3 是否接受脚本。
//   4. 零义务脚本:z3 接受(exit 0)且零 check-sat 回答(协议 §3.1 不变式 5:空脚本诚实声明)。
//
// 语料矩阵(与 tests/run.mjs §113 的 §113.1/§113.2/§113.19 语义同源,但源码内联独立):
//   proven          全 proven(body 作用域)                       z3: unsat/unsat
//   refuted-sat     违反语料,假设集可满足                         z3: low=sat(仅记录)/high=sat
//   refuted-unsat   违反语料,假设集自身不可满足                   z3: 豁免 unsat(§6.2 规则 4)
//   unknown         内部未判定                                    z3 回答任意(仅记录)
//   zero            零义务脚本                                    z3 接受 + 零回答
//   loop            loop 作用域 proven(i$<n> 符号/区间约束)         z3: unsat/unsat
//
// 用法:node tests/z3_check.mjs [--help]
// 退出码:0 = 全部断言通过,或 z3 不可用(跳过);1 = 断言失败 / 求解器异常 / 管线错误。
// 纪律:零第三方依赖;错误走 stderr;失败 exit 1;失败时临时目录留档(路径打印到 stderr),
//       成功即清理。本脚本不修改任何仓库状态。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const SPAWN_TIMEOUT_MS = 120000;
const SKIP_LINE = 'z3 不可用,跳过(本机开发环境常态)';

const USAGE = [
  '用法:node tests/z3_check.mjs [--help]',
  '',
  'Z3 外部消费验证(协议 docs/proof-protocol.md §6):',
  '  ming check <语料> --proof-format smt-lib → z3 <脚本> → 逐块对照内部判定。',
  '  z3 不在 PATH 时打印跳过原因并 exit 0;断言失败/求解器异常 exit 1。',
].join('\n');

// ---- 语料矩阵 -------------------------------------------------------------------------------
// 每项:slug/name/source/expectVerdicts(逐块内部判定,顺序 = 逐义务 low→high)/expectViolated
// (ming check 退出码:有 M3045 错误诊断 → 1,否则 0——协议 §4.4 退出码语义零变化)。
const CORPORA = [
  {
    slug: 'proven',
    name: 'proven 语料(requires 蕴含两方向;期望 z3 unsat)',
    source: [
      'fn get(buf: Vec[i64], i: i64) -> i64 requires i >= 0 && i < buf.len() {',
      '    return buf[i];',
      '}',
      'fn main() with io { print(str(get([1, 2], 1))); }',
    ].join('\n'),
    expectVerdicts: ['proven', 'proven'],
    expectViolated: false,
  },
  {
    slug: 'refuted-sat',
    name: 'refuted 语料(requires n == buf.len();假设集可满足——豁免不适用)',
    source: [
      'fn f(buf: Vec[i64], n: i64) -> i64 requires n == buf.len() {',
      '    return buf[n];',
      '}',
      'fn main() with io { print(str(f([1, 2], 2))); }',
    ].join('\n'),
    expectVerdicts: ['unknown', 'refuted'],
    expectViolated: true,
  },
  {
    slug: 'refuted-unsat',
    name: 'refuted 语料(requires 自身矛盾 n>=1 && m>=1 && n+m<=len && len<=1;§6.2 规则 4 豁免)',
    source: [
      'fn ls(buf: Vec[i64], n: i64, m: i64) -> i64 requires n >= 1 && m >= 1 && n + m <= buf.len() && buf.len() <= 1 {',
      '    return buf[n];',
      '}',
      'fn main() with io { print(str(ls([1], 1, 1))); }',
    ].join('\n'),
    expectVerdicts: ['proven', 'refuted'],
    expectViolated: true,
    expectExempt: 1, // §6.2 规则 4 豁免必须真实发生(审查 MINOR-1:守预期路径,防语料静默退化)
  },
  {
    slug: 'unknown',
    name: 'unknown 语料(requires n <= buf.len();外部结论不设期望,仅记录)',
    source: [
      'fn g(buf: Vec[i64], n: i64) -> i64 requires n <= buf.len() {',
      '    return buf[n];',
      '}',
      'fn main() with io { print(str(g([1, 2], 0))); }',
    ].join('\n'),
    expectVerdicts: ['unknown', 'unknown'],
    expectViolated: false,
  },
  {
    slug: 'zero',
    name: '零义务语料(有契约无索引点;empty script 诚实声明)',
    source: [
      'fn h(buf: Vec[i64], n: i64) -> i64 requires n >= 0 { return n + 1; }',
      'fn main() with io { print(str(h([1], 0))); }',
    ].join('\n'),
    expectVerdicts: [],
    expectViolated: false,
  },
  {
    slug: 'loop',
    name: 'loop 作用域 proven(范围 for 区间约束入假设集;i$<n> 符号)',
    source: [
      'fn sum(buf: Vec[i64], n: i64) -> i64 requires n == buf.len() {',
      '    let mut s = 0;',
      '    for i in 0..n { s += buf[i]; }',
      '    return s;',
      '}',
      'fn main() with io { print(str(sum([1, 2, 3], 3))); }',
    ].join('\n'),
    expectVerdicts: ['proven', 'proven'],
    expectViolated: false,
  },
];

// ---- 工具函数 -------------------------------------------------------------------------------
function probeZ3() {
  const r = spawnSync('z3', ['--version'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.error) return { ok: false, reason: `无法执行 z3 --version:${r.error.message}` };
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
    return { ok: false, reason: `z3 --version 退出码 ${r.status}${tail ? `:${tail}` : ''}` };
  }
  const first = `${r.stdout ?? ''}`.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return { ok: true, version: first ?? '(版本输出为空)' };
}

// 解析脚本结构:逐行扫描,按 (push)…(pop) 收集每个方向块(顺序 = 块序),并记录块前的
// 内部判定注释(协议 §3.4 逐字面:`; 方向 <low|high> — ming 内部判定: <verdict>`);
// check-sat 计数按全文行口径(结构不变式由 §113 自检器守护,本节只消费)。
function parseScript(script) {
  const lines = script.split('\n');
  const blocks = [];
  let cur = null;
  let pending = null; // 最近一条方向判定注释(块头)
  let checkSats = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '(check-sat)') { checkSats += 1; if (cur) cur.checkSat = true; continue; }
    if (line.startsWith('; ---- vc:')) { pending = null; continue; } // 新义务头:清掉上一条残留
    const vm = line.match(/^; 方向 (low|high) .*?内部判定: (proven|refuted|unknown)[(（]/);
    if (vm) { pending = { dir: vm[1], verdict: vm[2] }; continue; }
    if (line === '(push)') {
      cur = { dir: pending?.dir ?? null, verdict: pending?.verdict ?? null, declares: [], asserts: [], checkSat: false };
      blocks.push(cur);
      pending = null;
      continue;
    }
    if (line === '(pop)') { cur = null; continue; }
    if (cur) {
      if (/^\(declare-const \S+ Int\)$/.test(line)) cur.declares.push(line);
      else if (line.startsWith('(assert ')) cur.asserts.push(line);
    }
  }
  return { blocks, checkSats };
}

// z3 stdout → 回答序列(每行一个 sat/unsat/unknown;其他行——如 (error ...)——不计数,
// 由"回答行数 ≠ check-sat 数"的断言暴露并打印原始输出)。
function answersOf(stdout) {
  const out = [];
  for (const raw of stdout.split('\n')) {
    const t = raw.trim();
    if (t === 'sat' || t === 'unsat' || t === 'unknown') out.push(t);
  }
  return out;
}

// 假设集自身可满足性核验脚本(协议 §6.2 规则 4 的"先核对")。
// 块结构不变式:假设 assert 在前、取反目标 `(assert (not ...))` 恒为块内最后一条 assert
// (§3.1 结构不变式 2)。去掉它即只剩假设集 H;结构不符 → null(不构造,交给断言具名失败)。
function assumptionsOnlyScript(block) {
  const negAsserts = block.asserts.filter((l) => l.startsWith('(assert (not '));
  const last = block.asserts[block.asserts.length - 1];
  if (negAsserts.length !== 1 || !last || !last.startsWith('(assert (not ')) return null; // 审查 NOTE-1:每块恰一条取反目标且为最后一条
  return [
    '(set-logic QF_LIA)',
    ...block.declares,
    ...block.asserts.slice(0, -1),
    '(check-sat)',
    '(exit)',
  ].join('\n') + '\n';
}

function runZ3(file) {
  return spawnSync('z3', [file], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, windowsHide: true });
}

function brief(r) {
  const out = `${r.stdout ?? ''}`.trim();
  const err = `${r.stderr ?? ''}`.trim();
  return `stdout=${JSON.stringify(out.slice(0, 400))} stderr=${JSON.stringify(err.slice(0, 400))}`;
}

// ---- 主流程 ---------------------------------------------------------------------------------
function main() {
  const probe = probeZ3();
  if (!probe.ok) {
    process.stdout.write(`${SKIP_LINE}\n`);
    process.stdout.write(`原因:${probe.reason}\n`);
    process.stdout.write('提示:CI 的 z3-verify job(ubuntu-latest,apt install z3)会真跑本脚本。\n');
    return; // exitCode 默认 0
  }

  process.stdout.write('z3-check — Z3 外部消费验证(协议 docs/proof-protocol.md §6)\n');
  process.stdout.write(`z3 版本:${probe.version}\n`);

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-z3-check-'));
  const failures = [];
  const failLine = (msg) => {
    failures.push(msg);
    process.stderr.write(`✗ ${msg}\n`);
  };

  let corpusCount = 0;
  let assertedBlocks = 0;
  let unknownBlocks = 0;
  let exemptedBlocks = 0;

  for (const c of CORPORA) {
    corpusCount += 1;
    const before = failures.length;
    const exemptedBefore = exemptedBlocks;
    const mingFile = path.join(TMP, `${c.slug}.ming`);
    const smtFile = path.join(TMP, `${c.slug}.smt2`);
    fs.writeFileSync(mingFile, c.source.endsWith('\n') ? c.source : `${c.source}\n`, 'utf8');

    // 1) ming check → SMT-LIB 脚本(stdout 纯脚本;违反语料 exit 1 是协议 §4.4 的既有口径)
    const r = spawnSync(process.execPath, [MING, 'check', mingFile, '--proof-format', 'smt-lib'], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: SPAWN_TIMEOUT_MS,
      windowsHide: true,
    });
    const expectExit = c.expectViolated ? 1 : 0;
    if (r.error || r.status === null) { failLine(`[${c.slug}] ming check 未能执行:${r.error?.message ?? 'status=null'}`); continue; }
    if (r.status !== expectExit) failLine(`[${c.slug}] ming check 退出码 ${r.status} ≠ 预期 ${expectExit}(协议 §4.4 退出码语义)`);
    const script = r.stdout;
    if (!script.startsWith('(set-logic QF_LIA)\n') || !script.endsWith('(exit)\n')) {
      failLine(`[${c.slug}] ming check stdout 不是完整 SMT 脚本(首行/末行不符):${JSON.stringify(script.slice(0, 160))}`);
      continue;
    }

    // 2) 脚本结构与语料设计对照(块数/逐块判定/check-sat 数)
    const parsed = parseScript(script);
    if (parsed.blocks.length !== c.expectVerdicts.length) {
      failLine(`[${c.slug}] 方向块数 ${parsed.blocks.length} ≠ 预期 ${c.expectVerdicts.length}(语料形态或脚本结构漂移)`);
    }
    if (parsed.checkSats !== parsed.blocks.length) {
      failLine(`[${c.slug}] check-sat 数 ${parsed.checkSats} ≠ 方向块数 ${parsed.blocks.length}(协议 §3.1 不变式 2:每块恰一个)`);
    }
    if (parsed.blocks.some((b) => !b.checkSat)) failLine(`[${c.slug}] 存在缺 (check-sat) 的方向块`);
    c.expectVerdicts.forEach((want, i) => {
      if (parsed.blocks[i] && parsed.blocks[i].verdict !== want) {
        failLine(`[${c.slug}] 块 ${i + 1} 内部判定 ${JSON.stringify(parsed.blocks[i].verdict)} ≠ 预期 ${JSON.stringify(want)}(内部证明器口径漂移)`);
      }
    });

    // 3) z3 消费脚本
    fs.writeFileSync(smtFile, script, 'utf8');
    const z = runZ3(smtFile);
    if (z.error || z.status !== 0) {
      failLine(`[${c.slug}] z3 执行失败(status=${z.status ?? 'null'})${z.error ? `:${z.error.message}` : ''};${brief(z)}`);
      continue;
    }
    if (/(^|\n)\s*\(error/.test(z.stdout)) {
      failLine(`[${c.slug}] z3 输出含 (error ...) 行(审查 MINOR-3);${brief(z)}`);
      continue;
    }
    if (parsed.checkSats === 0 && z.stdout.trim() !== '') {
      failLine(`[${c.slug}] 零 check-sat 脚本 z3 应输出为空,实际:${brief(z)}`);
      continue;
    }
    const answers = answersOf(z.stdout);
    if (answers.length !== parsed.checkSats) {
      failLine(`[${c.slug}] z3 回答行数 ${answers.length} ≠ check-sat 数 ${parsed.checkSats};${brief(z)}`);
      continue;
    }

    // 4) 逐块对照内部判定(协议 §3.4 注释 ↔ §6.2 解读规则)
    const cols = [];
    for (let i = 0; i < parsed.blocks.length; i += 1) {
      const b = parsed.blocks[i];
      const a = answers[i];
      const tag = `${b.dir ?? '?'}=${b.verdict ?? '?'}→${a}`;
      if (b.verdict === 'proven') {
        assertedBlocks += 1;
        cols.push(tag);
        if (a !== 'unsat') failLine(`[${c.slug}] 块 ${i + 1} (${b.dir}) 内部 proven,z3 应答 ${a}(期望 unsat)`);
      } else if (b.verdict === 'refuted') {
        assertedBlocks += 1;
        if (a === 'sat') { cols.push(tag); continue; }
        if (a === 'unknown') { cols.push(tag); failLine(`[${c.slug}] 块 ${i + 1} (${b.dir}) 内部 refuted,z3 应答 unknown(期望 sat 或豁免 unsat)`); continue; }
        // a === 'unsat':§6.2 规则 4——先核对假设集自身可满足性再下分歧结论
        const hScript = assumptionsOnlyScript(b);
        if (hScript === null) { cols.push(tag); failLine(`[${c.slug}] 块 ${i + 1} (${b.dir}) refuted→unsat,但无法构造假设集核验脚本(结构守卫)`); continue; }
        const hFile = path.join(TMP, `${c.slug}-h${i + 1}.smt2`);
        fs.writeFileSync(hFile, hScript, 'utf8');
        const h = runZ3(hFile);
        const hAns = h.status === 0 ? answersOf(h.stdout) : [];
        if (hAns.length === 1 && hAns[0] === 'unsat') {
          exemptedBlocks += 1;
          cols.push(`${tag}(豁免:假设集自身 unsat)`);
        } else {
          cols.push(`${tag}(假设集核验=${JSON.stringify(hAns)}/status=${h.status})`);
          failLine(`[${c.slug}] 块 ${i + 1} (${b.dir}) refuted→unsat 且假设集自身可满足性核验未得 unsat——真实分歧候选(协议 §6.2 规则 4);${brief(h)}`);
        }
      } else {
        unknownBlocks += 1;
        cols.push(`${tag}(仅记录)`);
      }
    }

    // 审查 MINOR-1:豁免路径必须被真实走到(§6.2 规则 4)——期望值逐语料登记,偏差即失败
    const exemptDelta = exemptedBlocks - exemptedBefore;
    const expectExempt = c.expectExempt ?? 0;
    if (exemptDelta !== expectExempt) {
      failLine(`[${c.slug}] §6.2 规则 4 豁免块数 ${exemptDelta} ≠ 预期 ${expectExempt}(豁免路径未被真实走到或意外触发)`);
    }
    const ok = failures.length === before;
    const detail = cols.length > 0 ? cols.join(',') : '零 check-sat';
    process.stdout.write(`${ok ? '[ok]' : '[fail]'} ${c.name} — ${parsed.blocks.length} 块(${detail})\n`);
  }

  // ---- 汇总 ---------------------------------------------------------------------------------
  const pass = failures.length === 0;
  process.stdout.write(`\nz3-check: ${corpusCount} 语料,${assertedBlocks} 块断言,${pass ? 'pass' : 'fail'}\n`);
  if (unknownBlocks > 0 || exemptedBlocks > 0) {
    process.stdout.write(`  (unknown 仅记录 ${unknownBlocks} 块;§6.2 规则 4 豁免 ${exemptedBlocks} 块)\n`);
  }
  if (!pass) {
    process.stderr.write(`\n共 ${failures.length} 项失败;临时目录留档:${TMP}\n`);
    process.exitCode = 1;
    return;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
} else {
  main();
}
