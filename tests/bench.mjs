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

  // v0.57 基线对比:Δ 列(当前/基线倍率)+ cc/vm 加速比回退告警(信息性)
  const base = BASELINE ? BASELINE.items[name] : null;
  if (base) {
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
    if (parts.length > 0) console.log(`    Δ基线(${BASELINE.meta?.date ?? '?'}): ${parts.join('  ')}`);
    if (warned) {
      console.log(`    ⚠ WARN: cc/vm 加速比回退 >20%(基线 ${base.ccPerVm}x → 当前 ${ccPerVm.toFixed(1)}x);信息性,不阻断`);
    }
  }
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
    };
  }
  const payload = {
    meta: {
      date: new Date().toISOString().slice(0, 10),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      ming: mingVersion(),
      note: '同机 + 同 Node 主版本对比口径;跨机不承诺。信息性基线,不阻断 CI;每项为 3 次运行最小值(ms),'
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
