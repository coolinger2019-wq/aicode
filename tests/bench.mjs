// tests/bench.mjs — Ming 引擎性能基准(信息性,不作为 CI 门槛)。
// 对比:树遍历解释器(--tree)vs 字节码 VM(默认,eligible 数值函数经 wasm)
//      vs C 后端原生(ming cc,需 gcc/clang;缺失时自动跳过 C 腿)。
//
// v0.57 基线对比(plan §4.3.8;仍信息性,不阻断):
// - tests/bench.baseline.json 存在时,每项输出 Δ 列(当前/基线倍率,>1 即比基线慢);
// - cc/vm 加速比回退 >20%(当前 < 基线 × 0.8)时打印 WARN,仍 exit 0;
// - `node tests/bench.mjs --write-baseline` 以本次结果重写基线(记录日期/Node 版本/Ming 版本);
// - 口径:同机 + 同 Node 主版本对比;跨机不承诺。基线数字必须可复现:同一命令重跑即可复核,
//   单次运行取 3 次最小值以降噪;数字有正常波动,只有越过阈值才告警。
//
// v0.59-P3(plan §4.4.4 任务 4;回应 Moltbook Starfish 的"mut-self 高频循环 invariant 重查"):
// - 第 5 项"契约 invariant 循环":实验组 struct 带 `invariant v >= 0`,对照组同形态无 invariant,
//   两者都是 trait impl 的 `mut self` set 方法;每轮 10,000 次 set,30 轮 = 300,000 次 mut-self
//   退出(单轮 N 即任务要求的 10,000 量级;放大轮数只为让 µs 级差异脱离进程启动噪声;
//   每退出开销是线性量,与放大倍数无关)。
// - 指标:每次 mut-self 退出的重查开销 µs = (T_on - T_off) / 300000;占比 = 差值 / T_on(含进程
//   启动的分母,故是热路径占比的保守下界)。headline 用 5 次取样中位差(抗单次噪声);
//   min 差同时记录(字段名不变,向后兼容),并注明 min 是单次取样敏感量、仅作参照。
// - cc 腿:资格分析在 trait 派发之前就拒绝结构体局部变量——`let c = Cell {...}` 实测为
//   `C1 不支持该程序形态:let 推导 null`;显式标注类型则 `C2 仅数值/str/Vec[i64]` 拒绝。
//   与 trait 方法派发无关;自动尝试后跳过并把真实原因记入基线 invariant.cc。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-bench-'));
const BASELINE_PATH = path.join(ROOT, 'tests', 'bench.baseline.json');
const WRITE_BASELINE = process.argv.includes('--write-baseline');
const WARN_RATIO = 0.8; // cc/vm 加速比回退阈值:当前 < 基线 × 0.8(即回退 >20%)

function loadBaseline() {
  if (WRITE_BASELINE || !fs.existsSync(BASELINE_PATH)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    return j && j.items && typeof j.items === 'object' ? j : null;
  } catch (e) {
    console.error(`✗ 基线文件解析失败,忽略对比(${e.message})`);
    return null;
  }
}
const BASELINE = loadBaseline();
const RESULTS = [];
let cmpCount = 0, warnCount = 0;

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

function mingVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '?';
  } catch { return '?'; }
}

function detectCC() {
  const candidates = [];
  if (process.env.MING_CC) candidates.push(process.env.MING_CC);
  candidates.push('gcc', 'clang', 'cc');
  for (const p of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
    if (fs.existsSync(p)) candidates.push(p);
  }
  for (const c of candidates) {
    try { const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15000 }); if (r.status === 0) return c; } catch { /* 试下一个 */ }
  }
  return null;
}
const CC = detectCC();

function benchFile(name, src) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, src, 'utf8');
  return p;
}

function runOnce(file, engine) {
  const args = ['run', file];
  if (engine === 'tree') args.push('--tree');
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [MING, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, ok: r.status === 0, out: r.stdout };
}

// C 腿:ming cc 编译一次,直接跑原生 exe(不含 ming 启动开销,纯产物时间)
function ccBuild(file, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(process.execPath, [MING, 'cc', file, '--out', outDir], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  if (r.status !== 0) return null;
  const exe = path.join(outDir, path.basename(file).replace(/\.ming$/, '') + (process.platform === 'win32' ? '.exe' : ''));
  return fs.existsSync(exe) ? exe : null;
}

// 同 ccBuild,但失败时带回首行原因(用于 invariant 项的"资格不支持则注明").
function ccBuildDetail(file, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(process.execPath, [MING, 'cc', file, '--out', outDir], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  if (r.status !== 0) {
    const line = (r.stderr || r.stdout || '').split('\n').find((l) => l.trim() !== '') ?? '未知原因';
    return { exe: null, reason: line.trim().slice(0, 100) };
  }
  const exe = path.join(outDir, path.basename(file).replace(/\.ming$/, '') + (process.platform === 'win32' ? '.exe' : ''));
  return fs.existsSync(exe) ? { exe, reason: '' } : { exe: null, reason: '产物缺失' };
}

function ccRunOnce(exe) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 120000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, ok: r.status === 0, out: r.stdout };
}

function bench(name, src, check, ccAble = false) {
  const p = benchFile(name.replace(/\s+/g, '-') + '.ming', src);
  const warm = runOnce(p, 'vm');
  if (!warm.ok || !warm.out.includes(check)) {
    console.log(`✗ ${name}:VM 输出异常 ${JSON.stringify(warm.out.slice(0, 60))}`);
    return;
  }
  const warmT = runOnce(p, 'tree');
  if (!warmT.ok || !warmT.out.includes(check)) {
    console.log(`✗ ${name}:tree 输出异常 ${JSON.stringify(warmT.out.slice(0, 60))}`);
    return;
  }
  // 取 3 次最小值(减少噪声)
  const vmTimes = [], treeTimes = [];
  for (let i = 0; i < 3; i++) vmTimes.push(runOnce(p, 'vm').ms);
  for (let i = 0; i < 3; i++) treeTimes.push(runOnce(p, 'tree').ms);
  const vm = Math.min(...vmTimes), tree = Math.min(...treeTimes);
  const speedup = tree / vm;
  let cc = null, ccPerVm = null, ccNote = '';
  if (ccAble && CC) {
    const exe = ccBuild(p, path.join(TMP, 'ccout-' + name.replace(/\s+/g, '-')));
    if (exe) {
      const warmC = ccRunOnce(exe);
      if (warmC.ok && warmC.out.includes(check)) {
        const ccTimes = [];
        for (let i = 0; i < 3; i++) ccTimes.push(ccRunOnce(exe).ms);
        cc = Math.min(...ccTimes);
        ccPerVm = vm / cc;
        ccNote = `  cc=${cc.toFixed(2).padStart(8)}ms  cc/vm ${ccPerVm.toFixed(1)}x`;
      } else {
        ccNote = '  cc=输出异常';
      }
    } else {
      ccNote = '  cc=编译失败';
    }
  } else if (ccAble) {
    ccNote = '  cc=跳过(无编译器)';
  }
  console.log(`${name.padEnd(22)} tree=${tree.toFixed(0).padStart(6)}ms  vm=${vm.toFixed(0).padStart(6)}ms  提速 ${speedup.toFixed(1)}x${ccNote}`);
  RESULTS.push({ name, tree, vm, speedup: round1(speedup), cc: cc === null ? null : round2(cc), ccPerVm: ccPerVm === null ? null : round1(ccPerVm) });
  reportBaseline(name, tree, vm, speedup, ccPerVm);
}

// v0.57 基线对比:Δ 列(当前/基线倍率)+ cc/vm 加速比回退告警(信息性)。
// extraMetrics(可选,invariant 记录)用于 invariant 专项:min 与中位两套 µs 倍率(附加列)。
function reportBaseline(name, tree, vm, speedup, ccPerVm, extraMetrics = null) {
  const base = BASELINE ? BASELINE.items[name] : null;
  if (!base) return;
  cmpCount++;
  const parts = [];
  if (base.treeMs > 0) parts.push(`tree ${round2(tree / base.treeMs)}x`);
  if (base.vmMs > 0) parts.push(`vm ${round2(vm / base.vmMs)}x`);
  if (base.speedup > 0) parts.push(`提速 ${round2(speedup / base.speedup)}x`);
  let warned = false;
  if (ccPerVm !== null && base.ccPerVm > 0) {
    parts.push(`cc/vm ${round2(ccPerVm / base.ccPerVm)}x`);
    if (ccPerVm < base.ccPerVm * WARN_RATIO) {
      warned = true;
      warnCount++;
    }
  }
  if (extraMetrics && base.invariant) {
    if (base.invariant.vmUs > 0) parts.push(`invariant vm ${round2(extraMetrics.vmUs / base.invariant.vmUs)}x`);
    if (base.invariant.treeUs > 0) parts.push(`invariant tree ${round2(extraMetrics.treeUs / base.invariant.treeUs)}x`);
    if (extraMetrics.vmUsMedian !== undefined && base.invariant.vmUsMedian > 0) {
      parts.push(`invariant vm 中位 ${round2(extraMetrics.vmUsMedian / base.invariant.vmUsMedian)}x`);
    }
    if (extraMetrics.treeUsMedian !== undefined && base.invariant.treeUsMedian > 0) {
      parts.push(`invariant tree 中位 ${round2(extraMetrics.treeUsMedian / base.invariant.treeUsMedian)}x`);
    }
  }
  if (parts.length > 0) console.log(`    Δ基线(${BASELINE.meta?.date ?? '?'}): ${parts.join('  ')}`);
  if (warned) {
    console.log(`    ⚠ WARN: cc/vm 加速比回退 >20%(基线 ${base.ccPerVm}x → 当前 ${ccPerVm.toFixed(1)}x);信息性,不阻断`);
  }
}

// v0.59-P3:契约 invariant 成本(mut-self 退出重查)。实验组/对照组同形态,
// 唯一差异是 struct 字段上的 `invariant v >= 0`;方法派发与循环完全一致。
function benchInvariant(name) {
  const N = 10000;      // 单轮 mut-self 退出次数(任务要求 10,000 量级)
  const ROUNDS = 30;    // 放大轮数:µs 级差异 × 300,000 次退出才脱离 ~50ms 启动噪声
  const EXITS = N * ROUNDS;
  const src = (withInv) => [
    'trait CellOps {',
    '    fn set(mut self, v: i64);',
    '    fn get(self) -> i64;',
    '}',
    'struct Cell {',
    '    v: i64,',
    withInv ? '    invariant v >= 0,' : '',
    '}',
    'impl CellOps for Cell {',
    '    fn set(mut self, v: i64) {',
    '        self.v = v;',
    '    }',
    '    fn get(self) -> i64 {',
    '        return self.v;',
    '    }',
    '}',
    'fn main() with io {',
    '    let mut c = Cell { v: 0 };',
    '    let mut r = 0;',
    '    while r < ' + ROUNDS + ' {',
    '        let mut i = 0;',
    '        while i < ' + N + ' {',
    '            c.set(i);',
    '            i += 1;',
    '        }',
    '        r += 1;',
    '    }',
    '    print(str(c.get()));',
    '}',
    '',
  ].filter((l) => l !== '').join('\n');
  const pOn = benchFile('invariant-on.ming', src(true));
  const pOff = benchFile('invariant-off.ming', src(false));
  const CHECK = String(N - 1);

  // 预热 + 输出校验(两腿、两程序都必须是同一结果;相等比较,避免 '9999' 子串误匹配)
  for (const [tag, p] of [['invariant', pOn], ['对照', pOff]]) {
    for (const engine of ['vm', 'tree']) {
      const w = runOnce(p, engine);
      if (!w.ok || w.out.trim() !== CHECK) {
        console.log(`✗ ${name}:${tag} ${engine} 输出异常 ${JSON.stringify(w.out.slice(0, 60))}`);
        return;
      }
    }
  }

  // 交错取样 5 次(on/off 相邻,降低机器漂移影响);headline 用中位差,min 差保留作参照
  const sample = { on: { vm: [], tree: [] }, off: { vm: [], tree: [] } };
  for (let i = 0; i < 5; i++) {
    for (const engine of ['vm', 'tree']) {
      sample.on[engine].push(runOnce(pOn, engine).ms);
      sample.off[engine].push(runOnce(pOff, engine).ms);
    }
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const min = (a) => Math.min(...a);
  const treeOn = min(sample.on.tree), treeOff = min(sample.off.tree);
  const vmOn = min(sample.on.vm), vmOff = min(sample.off.vm);
  const vmUs = (vmOn - vmOff) * 1000 / EXITS;
  const treeUs = (treeOn - treeOff) * 1000 / EXITS;
  const vmPct = (vmOn - vmOff) / vmOn * 100;
  const treePct = (treeOn - treeOff) / treeOn * 100;
  const vmOnMed = med(sample.on.vm), vmOffMed = med(sample.off.vm);
  const treeOnMed = med(sample.on.tree), treeOffMed = med(sample.off.tree);
  const vmUsMed = (vmOnMed - vmOffMed) * 1000 / EXITS;
  const treeUsMed = (treeOnMed - treeOffMed) * 1000 / EXITS;
  const vmPctMed = (vmOnMed - vmOffMed) / vmOnMed * 100;
  const treePctMed = (treeOnMed - treeOffMed) / treeOnMed * 100;
  const speedup = treeOn / vmOn;

  // cc 腿:资格分析先于 trait 派发拒绝结构体局部变量(let 推导 null / 显式标注 C2);
  // 自动尝试,失败则跳过并把真实原因存入基线 invariant.cc
  let cc = null, ccPerVm = null, ccNote, ccStatus;
  if (!CC) {
    ccNote = '  cc=跳过(无编译器)';
    ccStatus = 'skipped:no-cc';
  } else {
    const built = ccBuildDetail(pOn, path.join(TMP, 'ccout-invariant'));
    const exe = built.exe;
    if (!exe) {
      ccNote = `  cc=跳过(${built.reason})`;
      ccStatus = /^C[123]\b/.test(built.reason) ? `skipped:${built.reason}` : 'skipped:compile-failed';
    } else {
      const warmC = ccRunOnce(exe);
      if (!warmC.ok || warmC.out.trim() !== CHECK) {
        ccNote = '  cc=输出异常';
        ccStatus = 'failed:output';
      } else {
        const ccTimes = [];
        for (let i = 0; i < 3; i++) ccTimes.push(ccRunOnce(exe).ms);
        cc = Math.min(...ccTimes);
        ccPerVm = vmOn / cc;
        ccStatus = 'ok';
        ccNote = `  cc=${cc.toFixed(2).padStart(8)}ms  cc/vm ${ccPerVm.toFixed(1)}x`;
      }
    }
  }

  // headline 用中位差(主口径);min 差为单次取样敏感量,降为参照行
  console.log(`${name.padEnd(22)} tree=${treeOn.toFixed(0).padStart(6)}ms  vm=${vmOn.toFixed(0).padStart(6)}ms  提速 ${speedup.toFixed(1)}x  `
    + `invariant 重查(中位): vm ${vmUsMed.toFixed(2)}µs/次(占 ${vmPctMed.toFixed(1)}%)  tree ${treeUsMed.toFixed(2)}µs/次(占 ${treePctMed.toFixed(1)}%)${ccNote}`);
  console.log(`    对照 无 invariant: vm=${vmOff.toFixed(0)}ms  tree=${treeOff.toFixed(0)}ms;`
    + `N=${N}/轮 × ${ROUNDS} 轮 = ${EXITS} 次 mut-self 退出;5 次取样中位为主;min 口径(单次取样敏感,仅参照): vm ${vmUs.toFixed(2)}/tree ${treeUs.toFixed(2)}µs/次`);
  const record = {
    name, tree: treeOn, vm: vmOn, speedup: round1(speedup), cc: cc === null ? null : round2(cc), ccPerVm: ccPerVm === null ? null : round1(ccPerVm),
    invariant: {
      loopN: N, rounds: ROUNDS, exits: EXITS,
      vmUs: round2(vmUs), treeUs: round2(treeUs),
      vmPct: round1(vmPct), treePct: round1(treePct),
      vmUsMedian: round2(vmUsMed), treeUsMedian: round2(treeUsMed),
      vmPctMedian: round1(vmPctMed), treePctMedian: round1(treePctMed),
      controlVmMs: Math.round(vmOff), controlTreeMs: Math.round(treeOff),
      samples: 5,
      cc: ccStatus,
    },
  };
  RESULTS.push(record);
  reportBaseline(name, treeOn, vmOn, speedup, ccPerVm, record.invariant);
}

// 1) 递归:fib(24)
bench('fib(24) 递归', `
fn fib(n: i64) -> i64 {
    if n < 2 { return n; }
    return fib(n - 1) + fib(n - 2);
}
fn main() with io {
    print(str(fib(24)));
}
`, '46368', true);

// 2) 循环累加:1..100万
bench('循环累加 100 万', `
fn main() with io {
    let mut total = 0;
    for i in 1..1000001 {
        total += i;
    }
    print(str(total));
}
`, '500000500000', true);

// 3) 集合操作:map/filter/fold
bench('高阶方法 10 万元素', `
fn main() with io {
    let mut v: Vec[i64] = [];
    let mut i = 0;
    while i < 100000 {
        v.push(i);
        i += 1;
    }
    let sum = v.map((x) => x * 2).filter((x) => x % 3 == 0).fold(0, (acc, x) => acc + x);
    print(str(sum));
}
`, '3333366666');

// 4) 字符串与 Map:词频
bench('词频统计 2 万词', `
fn count_words(text: str) -> Map[str, i64] {
    let mut counts: Map[str, i64] = [:];
    for word in text.split(" ") {
        if word == "" { continue; }
        counts.set(word, counts.get(word).unwrap_or(0) + 1);
    }
    counts
}
fn main() with io {
    let mut text = "";
    let mut i = 0;
    while i < 2000 {
        text += "the quick brown fox jumps over the lazy dog ";
        i += 1;
    }
    let c = count_words(text);
    print(str(c.get("fox").unwrap_or(0)));
}
`, '2000');

// 5) 契约 invariant 成本(v0.59-P3;Starfish 回应):mut-self 退出重查的每次开销
benchInvariant('契约 invariant 循环');

fs.rmSync(TMP, { recursive: true, force: true });

if (WRITE_BASELINE) {
  const items = {};
  for (const rec of RESULTS) {
    items[rec.name] = {
      treeMs: Math.round(rec.tree),
      vmMs: Math.round(rec.vm),
      speedup: rec.speedup,
      ccMs: rec.cc,
      ccPerVm: rec.ccPerVm,
      ...(rec.invariant ? { invariant: rec.invariant } : {}),
    };
  }
  const payload = {
    meta: {
      date: new Date().toISOString().slice(0, 10),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      ming: mingVersion(),
      note: '同机 + 同 Node 主版本对比口径;跨机不承诺。信息性基线,不阻断 CI;每项为 3 次运行最小值(ms)'
        + '(契约 invariant 循环为 5 次交错取样:headline 用中位差 vmUsMedian/treeUsMedian,min 口径 vmUs/treeUs 保留作单次取样敏感参照;'
        + 'invariant.cc 记录 cc 腿跳过/失败的真实原因,如 skipped:C1 不支持该程序形态:let 推导 null);'
        + 'cc/vm 加速比回退 >20% 时 tests/bench.mjs 运行打印 WARN(仍 exit 0)。重写基线:node tests/bench.mjs --write-baseline。',
    },
    items,
  };
  try {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`基线已写入 tests/bench.baseline.json(${Object.keys(items).length} 项,${payload.meta.date},Node ${payload.meta.node},Ming v${payload.meta.ming})`);
  } catch (e) {
    console.error(`✗ 基线写入失败:${e.message}`);
    process.exitCode = 1;
  }
} else if (BASELINE) {
  console.log(`基线对比(${BASELINE.meta?.date ?? '?'}):对比 ${cmpCount} 项,WARN ${warnCount};口径:同机 + 同 Node 主版本,跨机不承诺;信息性,不阻断。`);
} else {
  console.log('(无基线 tests/bench.baseline.json;`node tests/bench.mjs --write-baseline` 可生成基线)');
}
