#!/usr/bin/env node
// tests/bench_vs/run.mjs — 跨语言基准对比采集 harness(plan §4.15 T5.1;零依赖 Node 脚本)。
//
// 目标:Ming(tree / VM / cc)vs JS(Node)vs Python vs C 手写程序,7 项语义等价任务的
//      耗时对比采集。信息性观测,不作 CI 门槛;Agent B 的 docs/bench-vs-baselines.md
//      消费本脚本的 results.json 输出。
//
// 计时口径(plan §4.15):
// - 任务 1–6:统一"程序内部自测主任务耗时"——Ming = std.time.monotonic_ms,JS =
//   performance.now,Python = time.perf_counter,C = QueryPerformanceCounter(clock_gettime
//   兜底);预热 1 + 正式 5 取 min。启动项(任务 7)为整进程墙钟(harness 计)。
// - Ming cc 腿:C 后端不支持 time 效果(实测 C1 拒绝,见各任务 cc 资格记录)→ 无法程序内
//   自测,计时 = harness 测 exe 进程墙钟(与自测口径差 ≈ 进程启动,个位数 ms;leg 上注记)。
// - 内存:尽力而为——JS 自报 process.memoryUsage().rss;Python 的 resource 模块 Windows
//   不可用 → N/A;C/Ming 无标准口径 → N/A。采集不到的格子如实标 N/A,不编造。
//
// 语义等价与诚实纪律:
// - 每次运行输出行 = "验证 token... 自测毫秒";harness 逐 token 数值比对(与 harness 自算
//   参考值),任何不一致该腿标 fail,不进入 min 统计。
// - 词频任务的生成器 = mulberry32(Ming std.rand 同源,harness 用 BigInt 逐式复刻,
//   见 src/interp.js randStep)——四语言验证 token 一致即生成器序列一致的实证。
// - C 计算程序(任务 1–3/6)的规模参数取自 argv,防 gcc -O2 常量折叠掏空计时段。
// - 跑不了的格子标 N/A + 真实原因(cc 资格拒绝原因 = ming cc 实际 stderr 首行)。
//
// 用法:node tests/bench_vs/run.mjs [--write] [--json]
//   --write  结果写入 tests/bench_vs/results.json(另打印控制台表格)
//   --json   结果 JSON 打到 stdout(不打印表格)
// 退出码:全部腿 ok 或 na → 0;出现 fail(验证不一致/运行失败)→ 1(错误走 stderr)。
//
// 环境实测(2026-11-20):Node v24.11.0;Python 3.10.11(plan 写 3.12——实用 3.10.11,
// 版本偏差已在 meta.python 记录);gcc = C:/w64devkit/bin/gcc.exe(不在 PATH,绝对路径探测)。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = path.join(ROOT, 'tests', 'bench_vs');
const PROGS = path.join(HERE, 'progs');
const MING = path.join(ROOT, 'bin', 'ming.js');
const RESULTS_PATH = path.join(HERE, 'results.json');
const WRITE = process.argv.includes('--write');
const JSON_MODE = process.argv.includes('--json');

const SCRATCH = path.join(os.tmpdir(), 'ming-bench-vs');
const JSON_DIR = path.join(SCRATCH, 'json');
const FILESCAN_DIR = path.join(SCRATCH, 'filescan');
const CBIN_DIR = path.join(SCRATCH, 'cbin');
const CC_DIR = path.join(SCRATCH, 'cc');

const SEED = 20261120;
const JSON_ITEMS = 68000; // 实测 9.98MB(plan 目标约 10MB)
const WARMUP = 1;
const RUNS = 5;

let exitCode = 0;
const globalNotes = [];

// ---------- 工具 ----------
function fmtMs(v) {
  if (v === null || v === undefined) return 'N/A';
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function numEq(a, b) {
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9);
}

// mulberry32 复刻(与 src/interp.js randStep 逐式对齐;BigInt 精确,防 2^53 丢精度)
function makeRng(seed) {
  let state = BigInt(seed) & 0xFFFFFFFFn;
  return {
    range(lo, hi) {
      state = (state + 0x6D2B79F5n) & 0xFFFFFFFFn;
      let t = state;
      t = ((t ^ (t >> 15n)) * (t | 1n)) & 0xFFFFFFFFn;
      t = (t ^ (t + ((t ^ (t >> 7n)) * (t | 61n)))) & 0xFFFFFFFFn;
      state = (t ^ (t >> 14n)) & 0xFFFFFFFFn;
      return lo + Number(state % BigInt(hi - lo));
    },
  };
}

const VOCAB = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
  'yankee', 'zulu', 'apple', 'banana', 'cherry', 'date', 'elder', 'fig',
  'grape', 'honey', 'kiwi', 'lemon', 'mango', 'nutmeg', 'olive', 'peach',
  'quince', 'raspberry', 'strawberry', 'tomato', 'ugli', 'vanilla', 'walnut', 'xigua',
  'yuzu', 'zucchini', 'amber', 'bright', 'crisp', 'dawn', 'ember', 'frost',
  'gleam', 'haven', 'ivory', 'jade', 'karma', 'lumen', 'meadow', 'nimbus',
];

// ---------- 参考期望值(harness 自算,不手抄) ----------
const EXPECT = {};
{
  let a = 0, b = 1;
  for (let i = 0; i < 24; i++) { const t = a + b; a = b; b = t; }
  EXPECT.fib = [a]; // fib(24) = 46368(迭代参照,避免手抄错)
}
{
  let s = 0;
  for (let i = 1; i <= 1000000; i++) s += i;
  EXPECT.loopsum = [s];
}
{
  let sum = 0;
  for (let i = 0; i < 100000; i++) { const x = i + 1; if (x % 2 === 0) sum += x; }
  EXPECT.hof = [sum];
}
{
  const rng = makeRng(SEED);
  const counts = new Map();
  for (let i = 0; i < 20000; i++) {
    const w = VOCAB[rng.range(0, 64)];
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  EXPECT.wordfreq = [20000, counts.size, counts.get('alpha'), counts.get('nimbus')];
}
{
  let total = 0;
  for (let i = 0; i < JSON_ITEMS; i++) total += i;
  EXPECT.jsonparse = [total, JSON_ITEMS];
}
{
  let lines = 0, bytes = 0;
  for (let i = 0; i < 1000; i++) {
    for (let j = 0; j < 10; j++) {
      const s = `file ${i} line ${j} v${(i + j) % 97}\n`;
      bytes += Buffer.byteLength(s);
      lines += 1;
    }
  }
  EXPECT.filescan = [lines, bytes];
}

// ---------- 环境指纹 ----------
function detectCC() {
  const candidates = [];
  if (process.env.MING_CC) candidates.push(process.env.MING_CC);
  candidates.push('gcc', 'clang', 'cc');
  for (const p of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe']) {
    if (fs.existsSync(p)) candidates.push(p);
  }
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) return { exe: c, version: (r.stdout || '').split('\n')[0].trim() };
    } catch { /* 试下一个 */ }
  }
  return null;
}

function detectPython() {
  for (const exe of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) return { exe, version: (r.stdout || r.stderr || '').trim().split('\n')[0] };
    } catch { /* 试下一个 */ }
  }
  return null;
}

const CC = detectCC();
const PY = detectPython();
const cpus = os.cpus();

// 内存自报能力探测:Python resource 模块 Windows 不可用
let pyHasResource = false;
if (PY) {
  const r = spawnSync(PY.exe, ['-c', 'import resource'], { encoding: 'utf8', timeout: 15000 });
  pyHasResource = r.status === 0;
}

function mingVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '?';
  } catch { return '?'; }
}

// ---------- fixture(确定性,缺了才生成) ----------
function ensureJsonFixture() {
  fs.mkdirSync(JSON_DIR, { recursive: true });
  const file = path.join(JSON_DIR, 'data_10mb.json');
  if (fs.existsSync(file)) {
    const sz = fs.statSync(file).size;
    if (sz > 9 * 1024 * 1024 && sz < 11 * 1024 * 1024) {
      return { file, sizeBytes: sz, regenerated: false };
    }
  }
  const pad6 = (n) => String(n).padStart(6, '0');
  const parts = [];
  parts.push(`{"meta":{"total":${EXPECT.jsonparse[0]},"n_items":${JSON_ITEMS},"seed":${SEED},"generator":"ming-bench-vs"},"items":[`);
  const itemStrs = new Array(JSON_ITEMS);
  for (let i = 0; i < JSON_ITEMS; i++) {
    const desc = ('d' + String.fromCharCode(97 + (i % 26))).repeat(20);
    itemStrs[i] = `{"id":${i},"name":"item-${pad6(i)}","active":${i % 3 !== 0}`
      + `,"score":${((i % 1000) / 8).toFixed(2)}`
      + `,"tags":["t${i % 8}","cat${i % 4}"]`
      + `,"nums":[${i % 1000},${(i * 7) % 1000},${(i * 13) % 997}]`
      + `,"desc":"${desc}"}`;
  }
  parts.push(itemStrs.join(','));
  parts.push(']}');
  fs.writeFileSync(file, parts.join(''), 'utf8');
  return { file, sizeBytes: fs.statSync(file).size, regenerated: true };
}

function scratchDir(leg) {
  const d = path.join(FILESCAN_DIR, leg);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---------- 通用执行 ----------
function spawnOnce(cmd, args, cwd) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: cwd ?? ROOT, timeout: 300000 });
  const wallMs = performance.now() - t0;
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', wallMs };
}

// 解析程序输出行:"验证 token... 自测毫秒"(结果行 = 首个非空行,末 token = ms;
// JS 程序另有第二行 MEM <rss>,由 extractMem 单独取)。返回 { tokens, ms } 或 null
function parseOut(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const first = lines[0];
  if (!first) return null;
  const tokens = first.split(/\s+/).map(Number);
  if (tokens.some((t) => !Number.isFinite(t))) return null;
  return { tokens, ms: tokens[tokens.length - 1] };
}

function verifyTokens(parsed, expectTokens) {
  if (!parsed) return '输出不可解析';
  if (parsed.tokens.length !== expectTokens.length + 1) {
    return `token 数不符 got=${parsed.tokens.length} want=${expectTokens.length + 1}`;
  }
  for (let i = 0; i < expectTokens.length; i++) {
    if (!numEq(parsed.tokens[i], expectTokens[i])) {
      return `验证 token[${i}] 不符 got=${parsed.tokens[i]} want=${expectTokens[i]}`;
    }
  }
  return null;
}

function extractMem(stdout) {
  const m = stdout.match(/^MEM (\d+)$/m);
  return m ? Number(m[1]) : null;
}

// 程序腿采样:预热 1 + 正式 5 取 min;每次都验证
function sampleProgramLeg(cmd, args, cwd, expectTokens) {
  const warm = spawnOnce(cmd, args, cwd);
  if (!warm.ok) {
    return { ok: false, reason: `预热运行失败 exit=${warm.status} stderr=${(warm.stderr || '').split('\n')[0]?.slice(0, 140)}` };
  }
  const parsed = parseOut(warm.stdout);
  const bad = verifyTokens(parsed, expectTokens);
  if (bad) return { ok: false, reason: `预热验证失败:${bad};stdout=${JSON.stringify(warm.stdout.slice(0, 80))}` };
  const runs = [];
  let mem = null;
  for (let i = 0; i < RUNS; i++) {
    const r = spawnOnce(cmd, args, cwd);
    if (!r.ok) return { ok: false, reason: `第 ${i + 1} 次运行失败 exit=${r.status} stderr=${(r.stderr || '').split('\n')[0]?.slice(0, 140)}` };
    const p = parseOut(r.stdout);
    const v = verifyTokens(p, expectTokens);
    if (v) return { ok: false, reason: `第 ${i + 1} 次验证失败:${v}` };
    runs.push(p.ms);
    mem = extractMem(r.stdout) ?? mem;
  }
  return { ok: true, runs, minMs: Math.min(...runs), mem };
}

// 启动时间腿:整进程墙钟,预热 1 + 正式 5 取 min;verify(stdout) 做格式断言
function sampleStartupLeg(cmd, args, cwd, verify) {
  const warm = spawnOnce(cmd, args, cwd);
  if (!warm.ok) {
    return { ok: false, reason: `预热运行失败 exit=${warm.status} stderr=${(warm.stderr || '').split('\n')[0]?.slice(0, 140)}` };
  }
  const bad = verify(warm.stdout, warm);
  if (bad) return { ok: false, reason: `预热验证失败:${bad};stdout=${JSON.stringify(warm.stdout.slice(0, 80))}` };
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const r = spawnOnce(cmd, args, cwd);
    if (!r.ok) return { ok: false, reason: `第 ${i + 1} 次运行失败 exit=${r.status}` };
    const v = verify(r.stdout, r);
    if (v) return { ok: false, reason: `第 ${i + 1} 次验证失败:${v}` };
    runs.push(r.wallMs);
  }
  return { ok: true, runs, minMs: Math.min(...runs), mem: null };
}

// ---------- Ming 腿 ----------
function mingLeg(file, cwd, expectTokens, engineArgs = []) {
  return sampleProgramLeg(process.execPath, [MING, 'run', file, ...engineArgs], cwd, expectTokens);
}

// Ming cc 腿:编译一次(--no-run)+ 运行 exe;计时 = 进程墙钟(口径注记)。
// cc 变体程序只输出结果 token(无自测 ms token)——专用采样,验证 token 数恰为 expect。
function sampleWallProgramLeg(cmd, args, cwd, expectTokens) {
  const verify = (stdout) => {
    const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    const tokens = (lines[lines.length - 1] ?? '').split(/\s+/).map(Number);
    if (tokens.some((t) => !Number.isFinite(t)) || tokens.length !== expectTokens.length) {
      return `输出 token 不符 got=${JSON.stringify(stdout.slice(0, 60))}`;
    }
    for (let i = 0; i < expectTokens.length; i++) {
      if (!numEq(tokens[i], expectTokens[i])) return `验证 token[${i}] 不符 got=${tokens[i]} want=${expectTokens[i]}`;
    }
    return null;
  };
  const warm = spawnOnce(cmd, args, cwd);
  if (!warm.ok) return { ok: false, reason: `预热运行失败 exit=${warm.status} stderr=${(warm.stderr || '').split('\n')[0]?.slice(0, 140)}` };
  const bad = verify(warm.stdout);
  if (bad) return { ok: false, reason: `预热验证失败:${bad}` };
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const r = spawnOnce(cmd, args, cwd);
    if (!r.ok) return { ok: false, reason: `第 ${i + 1} 次运行失败 exit=${r.status}` };
    const v = verify(r.stdout);
    if (v) return { ok: false, reason: `第 ${i + 1} 次验证失败:${v}` };
    runs.push(r.wallMs);
  }
  return { ok: true, runs, minMs: Math.min(...runs), mem: null };
}

// cc 资格拒绝的任务:mingCcLeg 首次 build 即返回 { ok:false, na:true, reason:<真实 stderr 首行> }。

function mingCcLeg(mingFile, outDirName, expectTokens, cwd) {
  const outDir = path.join(CC_DIR, outDirName);
  fs.mkdirSync(outDir, { recursive: true });
  const build = spawnOnce(process.execPath, [MING, 'cc', mingFile, '--out', outDir, '--no-run']);
  if (!build.ok) {
    const line = (build.stderr || build.stdout || '').split('\n').find((l) => l.trim() !== '') ?? '未知原因';
    return { ok: false, na: true, reason: line.trim().slice(0, 160) };
  }
  const exeName = path.basename(mingFile).replace(/\.ming$/, '') + (process.platform === 'win32' ? '.exe' : '');
  const exe = path.join(outDir, exeName);
  if (!fs.existsSync(exe)) return { ok: false, na: true, reason: '产物缺失' };
  const res = sampleWallProgramLeg(exe, [], cwd ?? ROOT, expectTokens);
  if (!res.ok) return res;
  return { ok: true, runs: res.runs, minMs: res.minMs, mem: null, timingNote: '墙钟口径(进程内无时钟,C 后端不支持 time 效果)' };
}

// cc 资格探测(预期拒绝的任务):跑一次 ming cc --no-run 采集真实拒绝原因
function mingCcRejectReason(mingFile) {
  const outDir = path.join(CC_DIR, 'probe-' + path.basename(mingFile, '.ming'));
  fs.mkdirSync(outDir, { recursive: true });
  const build = spawnOnce(process.execPath, [MING, 'cc', mingFile, '--out', outDir, '--no-run']);
  const line = (build.stderr || build.stdout || '').split('\n').find((l) => l.trim() !== '') ?? '未知原因';
  return line.trim().slice(0, 160);
}

// ---------- C 腿编译 ----------
function compileCProgs() {
  if (!CC) return { ok: false, reason: '无 C 编译器(MING_CC → PATH → 已知便携位置均未命中)' };
  fs.mkdirSync(CBIN_DIR, { recursive: true });
  const progs = ['fib', 'loopsum', 'hof', 'wordfreq', 'filescan', 'empty'];
  for (const name of progs) {
    const src = path.join(PROGS, name + '.c');
    const out = path.join(CBIN_DIR, name + (process.platform === 'win32' ? '.exe' : ''));
    const r = spawnSync(CC.exe, ['-O2', '-o', out, src], { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) return { ok: false, reason: `编译 ${name}.c 失败:${(r.stderr || '').split('\n')[0]?.slice(0, 140)}` };
  }
  return { ok: true };
}

// ---------- 任务定义 ----------
const TASKS = [];
const failures = [];

function recordTask(task) {
  TASKS.push(task);
  for (const [leg, entry] of Object.entries(task.legs)) {
    if (entry && entry.ok === false && !entry.na) failures.push(`${task.key}[${leg}]: ${entry.reason}`);
  }
}

function buildTask(key, title, legDefs, expectTokens, notes) {
  const legs = {};
  for (const [legName, fn] of Object.entries(legDefs)) {
    legs[legName] = fn();
  }
  recordTask({ key, title, expect: expectTokens.map(String).join(' '), legs, notes: notes ?? [] });
}

function legWrapper(res, extraNote) {
  if (!res.ok) return res;
  return extraNote ? { ...res, notes: [extraNote] } : res;
}

// ---------- 执行准备 ----------
const fixture = ensureJsonFixture();
const ccCompile = compileCProgs();
fs.mkdirSync(CC_DIR, { recursive: true });

// ============================================================
// 任务 1–6(程序腿;每腿:预热 1 + 正式 5 取 min,全次验证)
// ============================================================

// 任务 1:fib(24) 递归
buildTask('fib24', 'fib(24) 递归', {
  'ming-tree': () => mingLeg(path.join(PROGS, 'fib.ming'), ROOT, EXPECT.fib, ['--tree']),
  'ming-vm': () => mingLeg(path.join(PROGS, 'fib.ming'), ROOT, EXPECT.fib),
  'ming-cc': () => mingCcLeg(path.join(PROGS, 'fib_cc.ming'), 'fib', EXPECT.fib),
  js: () => sampleProgramLeg(process.execPath, [path.join(PROGS, 'fib.js')], ROOT, EXPECT.fib),
  py: () => PY ? sampleProgramLeg(PY.exe, [path.join(PROGS, 'fib.py')], ROOT, EXPECT.fib)
    : { ok: false, na: true, reason: '无 Python 解释器' },
  c: () => ccCompile.ok
    ? sampleProgramLeg(path.join(CBIN_DIR, 'fib.exe'), ['24'], ROOT, EXPECT.fib)
    : { ok: false, na: true, reason: ccCompile.reason },
}, EXPECT.fib, [
  'Ming 主腿:fib 为独立纯函数,wasm 资格(MING_WASM_DEBUG=1 实测 [wasm] fn fib OK)',
  'C 腿 N 从 argv 取(防 gcc -O2 常量折叠)',
]);

// 任务 2:循环累加 100 万
buildTask('loopsum', '循环累加 100 万', {
  'ming-tree': () => mingLeg(path.join(PROGS, 'loopsum.ming'), ROOT, EXPECT.loopsum, ['--tree']),
  'ming-vm': () => mingLeg(path.join(PROGS, 'loopsum.ming'), ROOT, EXPECT.loopsum),
  'ming-cc': () => mingCcLeg(path.join(PROGS, 'loopsum_cc.ming'), 'loopsum', EXPECT.loopsum),
  js: () => sampleProgramLeg(process.execPath, [path.join(PROGS, 'loopsum.js')], ROOT, EXPECT.loopsum),
  py: () => PY ? sampleProgramLeg(PY.exe, [path.join(PROGS, 'loopsum.py')], ROOT, EXPECT.loopsum)
    : { ok: false, na: true, reason: '无 Python 解释器' },
  c: () => ccCompile.ok
    ? sampleProgramLeg(path.join(CBIN_DIR, 'loopsum.exe'), ['1000000'], ROOT, EXPECT.loopsum)
    : { ok: false, na: true, reason: ccCompile.reason },
}, EXPECT.loopsum, [
  'Ming:累加放纯函数助手 sum_to,wasm 资格实测 OK(主循环真实经 wasm)',
  'C 腿 N 从 argv 取(防 gcc -O2 常量折叠)',
]);

// 任务 3:HOF 链 10 万元素(map+filter 各一道;C 无 HOF → 手写循环等价)
const hofNotes = [
  'C 腿为手写循环等价(C 标准库无 HOF;语义与 map(+1)/filter(偶数)/fold(求和) 一致)',
  'C 腿 N 从 argv 取(防 gcc -O2 常量折叠)',
];
{
  const hofLegs = {
    'ming-tree': () => mingLeg(path.join(PROGS, 'hof.ming'), ROOT, EXPECT.hof, ['--tree']),
    'ming-vm': () => mingLeg(path.join(PROGS, 'hof.ming'), ROOT, EXPECT.hof),
    'ming-cc': () => mingCcLeg(path.join(PROGS, 'hof.ming'), 'hof', EXPECT.hof),
    js: () => sampleProgramLeg(process.execPath, [path.join(PROGS, 'hof.js')], ROOT, EXPECT.hof),
    py: () => PY ? sampleProgramLeg(PY.exe, [path.join(PROGS, 'hof.py')], ROOT, EXPECT.hof)
      : { ok: false, na: true, reason: '无 Python 解释器' },
    c: () => ccCompile.ok
      ? legWrapper(sampleProgramLeg(path.join(CBIN_DIR, 'hof.exe'), ['100000'], ROOT, EXPECT.hof), '循环等价(C 无 HOF)')
      : { ok: false, na: true, reason: ccCompile.reason },
  };
  buildTask('hof', 'HOF 链 10 万元素', hofLegs, EXPECT.hof, hofNotes);
}

// 任务 4:词频统计 2 万词(hash map 计数;四语言同源 mulberry32 生成器)
{
  const wfLegs = {
    'ming-tree': () => mingLeg(path.join(PROGS, 'wordfreq.ming'), ROOT, EXPECT.wordfreq, ['--tree']),
    'ming-vm': () => mingLeg(path.join(PROGS, 'wordfreq.ming'), ROOT, EXPECT.wordfreq),
    'ming-cc': () => mingCcLeg(path.join(PROGS, 'wordfreq.ming'), 'wordfreq', EXPECT.wordfreq),
    js: () => sampleProgramLeg(process.execPath, [path.join(PROGS, 'wordfreq.js')], ROOT, EXPECT.wordfreq),
    py: () => PY ? sampleProgramLeg(PY.exe, [path.join(PROGS, 'wordfreq.py')], ROOT, EXPECT.wordfreq)
      : { ok: false, na: true, reason: '无 Python 解释器' },
    c: () => ccCompile.ok
      ? legWrapper(sampleProgramLeg(path.join(CBIN_DIR, 'wordfreq.exe'), ['20000'], ROOT, EXPECT.wordfreq),
        '哈希映射为手写开放寻址表(FNV-1a,标准 C 零第三方)')
      : { ok: false, na: true, reason: ccCompile.reason },
  };
  buildTask('wordfreq', '词频统计 2 万词', wfLegs, EXPECT.wordfreq, [
    '生成器 = mulberry32(Ming std.rand 同源,harness BigInt 复刻 src/interp.js randStep);'
    + '四语言验证 token(总数/去重数/alpha/nimbus 计数)一致即序列同源实证',
    '计时段 = 仅哈希映射计数(生成 2 万词数组为 setup,不计时)',
    'C 腿 N 从 argv 取(防 gcc -O2 常量折叠)',
  ]);
}

// 任务 5:10MB JSON 解析(C 腿 N/A:标准库无 JSON,零依赖纪律不引入第三方)
{
  const jpLegs = {
    'ming-tree': () => mingLeg(path.join(PROGS, 'jsonparse.ming'), JSON_DIR, EXPECT.jsonparse, ['--tree']),
    'ming-vm': () => mingLeg(path.join(PROGS, 'jsonparse.ming'), JSON_DIR, EXPECT.jsonparse),
    'ming-cc': () => mingCcLeg(path.join(PROGS, 'jsonparse.ming'), 'jsonparse', EXPECT.jsonparse),
    js: () => sampleProgramLeg(process.execPath, [path.join(PROGS, 'jsonparse.js')], JSON_DIR, EXPECT.jsonparse),
    py: () => PY ? sampleProgramLeg(PY.exe, [path.join(PROGS, 'jsonparse.py')], JSON_DIR, EXPECT.jsonparse)
      : { ok: false, na: true, reason: '无 Python 解释器' },
    c: () => ({ ok: false, na: true, reason: 'C 标准库无 JSON 解析;零第三方依赖纪律(仓库硬规则 3)不引入 json-c 等外部库' }),
  };
  buildTask('jsonparse', '10MB JSON 解析', jpLegs, EXPECT.jsonparse, [
    `fixture = ${fixture.file}(嵌套对象/数组/字符串/数字,${(fixture.sizeBytes / 1048576).toFixed(2)}MB,${JSON_ITEMS} items;${fixture.regenerated ? '本次生成' : '复用既有'});确定性与可复现`,
    '计时段 = 仅解析(文件读取为 setup);验证 token = meta.total 与 meta.n_items',
    'Ming 走污值路径:read_file → Untrusted[str] → parse → Untrusted[Json] → 投影表消费',
  ]);
}

// 任务 6:1k 文件扫描(各语言程序自带生成到 cwd;生成不计时)
{
  const fsLegs = {
    'ming-tree': () => mingLeg(path.join(PROGS, 'filescan.ming'), scratchDir('ming'), EXPECT.filescan, ['--tree']),
    'ming-vm': () => mingLeg(path.join(PROGS, 'filescan.ming'), scratchDir('ming'), EXPECT.filescan),
    'ming-cc': () => mingCcLeg(path.join(PROGS, 'filescan.ming'), 'filescan', EXPECT.filescan, scratchDir('ming')),
    js: () => sampleProgramLeg(process.execPath, [path.join(PROGS, 'filescan.js')], scratchDir('js'), EXPECT.filescan),
    py: () => PY ? sampleProgramLeg(PY.exe, [path.join(PROGS, 'filescan.py')], scratchDir('py'), EXPECT.filescan)
      : { ok: false, na: true, reason: '无 Python 解释器' },
    c: () => ccCompile.ok
      ? sampleProgramLeg(path.join(CBIN_DIR, 'filescan.exe'), ['1000'], scratchDir('c'), EXPECT.filescan)
      : { ok: false, na: true, reason: ccCompile.reason },
  };
  buildTask('filescan', '1k 文件扫描', fsLegs, EXPECT.filescan, [
    '程序启动时在各自 scratch 目录生成 1000 个 ~210B 确定性文件(内容逐式同源),生成不计时',
    '计时段 = 逐个读取并累计行数(按 \\n 计)与字节数(二进制读)',
    'C 腿 N 从 argv 取(防 gcc -O2 常量折叠)',
  ]);
}

// ============================================================
// 任务 7:启动时间(整进程墙钟,harness 计;预热 1 + 正式 5 取 min)
// ============================================================
{
  const SU_EXPECT = [];
  const suLegs = {
    js: () => sampleStartupLeg(process.execPath, ['-e', ''], ROOT, (out, r) => (r.ok ? null : 'exit 非 0')),
    py: () => PY ? sampleStartupLeg(PY.exe, ['-c', 'pass'], ROOT, (out, r) => (r.ok ? null : 'exit 非 0'))
      : { ok: false, na: true, reason: '无 Python 解释器' },
    c: () => ccCompile.ok
      ? sampleStartupLeg(path.join(CBIN_DIR, 'empty.exe'), [], ROOT, (out, r) => (r.ok ? null : 'exit 非 0'))
      : { ok: false, na: true, reason: ccCompile.reason },
    'ming-version': () => sampleStartupLeg(process.execPath, [MING, 'version'], ROOT,
      (out) => (out.startsWith('Ming v') ? null : `输出非版本行 got=${JSON.stringify(out.slice(0, 40))}`)),
    'ming-tools-wc': () => sampleStartupLeg(process.execPath, [MING, 'tools', 'wc', 'examples/hello.ming'], ROOT,
      (out) => (/^\d+ \d+ \d+ examples[\\/]hello\.ming$/m.test(out.trim()) ? null
        : `输出非 wc 行 got=${JSON.stringify(out.slice(0, 60))}`)),
  };
  buildTask('startup', '启动时间(整进程墙钟)', suLegs, SU_EXPECT, [
    '口径 = 整进程墙钟(harness performance.now 包住 spawn),与任务 1–6 的程序内自测口径不同',
    'ming-tools-wc = AOT 缓存命中路径(.ming-cache/tools,预热运行保证缓存已建);wc 对象 examples/hello.ming',
    'ming-version / ming-tools-wc 均为 node bin/ming.js 入口——含 Node 启动(诚实口径,ming 的真实入口如此)',
  ]);
}

// ---------- 控制台表格 ----------
const LEG_COLS = ['ming-tree', 'ming-vm', 'ming-cc', 'js', 'py', 'c'];
const SU_COLS = ['js', 'py', 'c', 'ming-version', 'ming-tools-wc'];

function cellFor(leg) {
  if (!leg) return '—';
  if (leg.ok) return fmtMs(leg.minMs);
  if (leg.na) return 'N/A';
  return 'FAIL';
}

function printTable(title, tasks, cols) {
  console.log('');
  console.log(`== ${title}(预热 1 + 正式 5 取 min;单位 ms)`);
  const widths = cols.map((c) => Math.max(c.length, 8));
  console.log(['任务'.padEnd(20), ...cols.map((c, i) => c.padStart(widths[i]))].join('  '));
  for (const t of tasks) {
    const cells = cols.map((c, i) => cellFor(t.legs[c]).padStart(widths[i]));
    console.log([t.title.slice(0, 20).padEnd(20), ...cells].join('  '));
  }
}

if (!JSON_MODE) {
  console.log('Ming vs JS/Python/C 基准对比(plan §4.15 T5.1;信息性观测,不作 CI 门槛)');
  console.log(`环境:Node ${process.version};${PY ? PY.version : '无 Python'};${CC ? CC.version : '无 C 编译器'};Ming v${mingVersion()}`);
  printTable('任务 1–6(程序内自测主任务耗时;ming-cc 为墙钟口径)', TASKS.filter((t) => t.key !== 'startup'), LEG_COLS);
  printTable('任务 7 启动时间(整进程墙钟)', TASKS.filter((t) => t.key === 'startup'), SU_COLS);
  console.log('');
  console.log('腿说明:ming-cc 仅 fib/loopsum 达资格(hof/wordfreq/jsonparse/filescan 实测拒绝,原因见 results.json);'
    + 'C 腿 jsonparse N/A(标准库无 JSON);内存采集仅 JS(rss),Py/C/Ming N/A(见 meta.memNote)。');
}

// ---------- results.json ----------
function buildResults() {
  const tasks = {};
  for (const t of TASKS) {
    tasks[t.key] = {
      title: t.title,
      expect: t.expect,
      legs: {},
      notes: t.notes,
    };
    for (const [leg, entry] of Object.entries(t.legs)) {
      if (entry === undefined || entry === null) {
        tasks[t.key].legs[leg] = { ok: false, na: true, reason: '腿未定义' };
        continue;
      }
      if (!entry.ok) {
        tasks[t.key].legs[leg] = {
          ok: false,
          ...(entry.na ? { na: true } : {}),
          reason: entry.reason ?? '未知原因',
        };
        continue;
      }
      tasks[t.key].legs[leg] = {
        ok: true,
        minMs: Math.round(entry.minMs * 1000) / 1000,
        runs: entry.runs.map((r) => Math.round(r * 1000) / 1000),
        ...(entry.mem !== null && entry.mem !== undefined ? { memBytes: entry.mem } : {}),
        ...(entry.timingNote ? { timingNote: entry.timingNote } : {}),
        ...(entry.notes ? { notes: entry.notes } : {}),
      };
    }
  }
  return {
    meta: {
      task: 'plan §4.15 T5.1 基准对比采集(信息性观测,不作 CI 门槛)',
      date: new Date().toISOString(),
      ming: mingVersion(),
      node: process.version,
      python: PY ? `${PY.version}${PY.version.includes('3.10') ? '(plan 写 3.12——实用 3.10.11,版本偏差如实记录)' : ''}` : '无',
      gcc: CC ? `${CC.version}(${CC.exe})` : '无',
      os: `${os.type()} ${os.release()} ${process.platform}-${process.arch}`,
      cpu: cpus.length ? `${cpus[0].model} × ${cpus.length}` : '未知',
      loadavg: os.loadavg(),
      loadNote: 'harness 单线程顺序执行,采集期间无并行重活;Windows loadavg 无真实口径(恒 0),以本注记为准',
      protocol: '任务 1–6:预热 1 + 正式 5 取 min,统一"程序内部自测主任务耗时"口径'
        + '(Ming=std.time.monotonic_ms,JS=performance.now,Py=time.perf_counter,C=QueryPerformanceCounter);'
        + '任务 7 启动时间 = 整进程墙钟(harness 计)。每次运行都做验证 token 数值比对,不一致即 fail',
      mingCcNote: 'Ming cc 腿计时 = exe 进程墙钟(cc 后端不支持 time 效果,无法程序内自测;实测 C1 拒绝);'
        + '与自测口径差 ≈ 进程启动(个位数 ms)',
      memNote: `内存尽力而为:仅 JS 自报 process.memoryUsage().rss(memBytes);`
        + `Python resource 模块 Windows 不可用(${pyHasResource ? '本机可用' : '本机不可用,skip'});C/Ming 无标准口径 → N/A,不编造`,
      fixture: {
        json: { file: fixture.file, sizeBytes: fixture.sizeBytes, items: JSON_ITEMS, seed: SEED },
      },
      cCompile: '-O2;计算程序规模参数取自 argv(防 gcc -O2 常量折叠掏空计时段)',
    },
    tasks,
  };
}

if (WRITE) {
  try {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(buildResults(), null, 2) + '\n', 'utf8');
    if (!JSON_MODE) console.log(`结果已写入 ${RESULTS_PATH}`);
  } catch (e) {
    console.error(`✗ results.json 写入失败:${e.message}`);
    exitCode = 1;
  }
}

if (JSON_MODE) {
  console.log(JSON.stringify(buildResults(), null, 2));
}

if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`✗ ${f}`);
  console.error(`bench_vs: ${failures.length} 条腿 FAIL(验证不一致或运行失败;N/A 不计入)`);
  exitCode = 1;
} else if (!JSON_MODE) {
  console.log('bench_vs: 全部腿 ok 或 N/A(0 FAIL)。');
}

process.exitCode = exitCode;
