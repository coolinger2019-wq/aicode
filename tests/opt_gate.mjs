// tests/opt_gate.mjs — O0.3 优化闸门骨架(plan §4.16;零依赖,只观测不改语义)。
//
// 职责:
//   1. 三腿 stdout 逐字一致:tree(--tree) / VM-only(--no-wasm) / VM+wasm(默认),
//      覆盖 5 个 O0.2 基准程序(与 tests/bench.mjs 第 7–11 项同源,源码内嵌,改动需两处同步)
//      + examples/hello.ming + examples/fib.ming;生成程序同时做精确期望输出断言
//      (防"三腿一致但全错"的静默破坏);
//   2. cc 腿:hello/fib 实测可编译(2026-11-20),加入对照——exe stdout 与 vm+wasm 腿逐字一致;
//      5 个生成程序实测不达 C1/C2 资格(逐项 ming cc 实测原因见 bench.mjs 各项注释),
//      如实记录跳过,不尝试;
//   3. MING_STATS=1 统计采集:三腿各一行 JSON(stderr;stdout 与不带 env 逐字一致,见 O0.1),
//      --write-doc 时汇总写入 docs/opt-baseline.md(表:程序 × 指标;
//      "v0.91.0 优化前基线——未来 pass 的对照锚");
//   4. --opt-off 预留挂点:【现在恒 default】——当前语言没有任何优化 pass,本旗标解析后
//      不改变任何行为(两态输出逐字相同)。未来 pass 接入点:当 O1 起的 pass 以旗标/env
//      开关落地(如 ming run --opt-off 或 MING_OPT_LEVEL=0)后,本文件在此处
//      (见 OPT_OFF 消费点注释)用同一批程序跑 pass 开/关两态,差值即 pass 贡献,
//      与 docs/opt-baseline.md 的"优化前基线"直接对照。
//
// 用法:node tests/opt_gate.mjs [--write-doc] [--opt-off]
// 退出码:全部断言通过 → 0;任何三腿不一致/cc 失败/期望输出不符 → 1(错误走 stderr)。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const DOC_PATH = path.join(ROOT, 'docs', 'opt-baseline.md');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-optgate-'));
const WRITE_DOC = process.argv.includes('--write-doc');
// --opt-off(O0.3 预留挂点):解析保留;当前无优化 pass,恒 default 行为(见文件头注释 4)。
const OPT_OFF = process.argv.includes('--opt-off');

// ---------- 程序集 ----------
// 生成程序:与 tests/bench.mjs 第 7–11 项同源(拷贝,改动需两处同步;bench 负责耗时,
// 本文件负责三腿一致 + 统计)。全部确定性(无时间/随机依赖),期望输出为定值。
const GENERATED = [
  {
    name: '拷贝密集 10 万绑定',
    expect: '900000\n',
    src: `
struct Rec {
    a: i64,
    b: i64,
    c: i64,
    tag: Vec[i64],
}
fn main() with io {
    let mut r = Rec { a: 1, b: 2, c: 3, tag: [1, 2, 3, 4, 5, 6, 7, 8] };
    let mut acc = 0;
    let mut i = 0;
    while i < 100000 {
        let copy = r;
        r = copy;
        acc += copy.a + copy.tag[7];
        i += 1;
    }
    print(str(acc));
}
`,
  },
  {
    name: 'Map 更新 2 万混合',
    expect: '199990000\n',
    src: `
fn main() with io {
    let mut keys: Vec[str] = [];
    let mut j = 0;
    while j < 64 {
        keys.push("k" + str(j));
        j += 1;
    }
    let mut m: Map[str, i64] = [:];
    let mut acc = 0;
    let mut i = 0;
    while i < 20000 {
        let key = keys[i % 64];
        m.set(key, i);
        acc += m.get(key).unwrap_or(0);
        i += 1;
    }
    print(str(acc));
}
`,
  },
  {
    name: 'HOF 链 10 万元素',
    expect: '1500150000\n',
    src: `
fn main() with io {
    let mut v: Vec[i64] = [];
    let mut i = 0;
    while i < 100000 {
        v.push(i);
        i += 1;
    }
    let sum = v.map((x) => x + 1).filter((x) => x % 2 == 0).map((x) => x * 3).filter((x) => x % 5 == 0).fold(0, (acc, x) => acc + x);
    print(str(sum));
}
`,
  },
  {
    name: '字符串构造 1 万次',
    expect: '20000:a-b-c\n',
    src: `
fn main() with io {
    let mut s = "";
    let mut i = 0;
    while i < 10000 {
        s += "ab";
        i += 1;
    }
    let parts: Vec[str] = ["a", "b", "c"];
    let joined = parts.join("-");
    print(str(s.byte_len()) + ":" + joined);
}
`,
  },
  {
    name: '闭包调用 10 万次',
    expect: '5000650000\n',
    src: `
fn main() with io {
    let d = 7;
    let f = (x: i64) => x + d;
    let mut acc = 0;
    let mut i = 0;
    while i < 100000 {
        acc += f(i);
        i += 1;
    }
    print(str(acc));
}
`,
  },
];

// examples 程序:hello(io 打印;cc 可编译)与 fib(数值递归;cc 可编译)。
// 期望输出精确构造(fib 用 JS 同式计算,防手抄错)。
function fibRef(n) { let a = 0, b = 1; for (let i = 0; i < n; i++) { const t = a + b; a = b; b = t; } return a; }
const EXAMPLES = [
  {
    name: 'hello(example)',
    file: path.join(ROOT, 'examples', 'hello.ming'),
    expect: '你好, 世界!\n1..11 的和是 55\n',
    ccAble: true,
  },
  {
    name: 'fib(example)',
    file: path.join(ROOT, 'examples', 'fib.ming'),
    expect: Array.from({ length: 11 }, (_, i) => `fib(${i}) = ${fibRef(i)}\n`).join(''),
    ccAble: true,
  },
];

// ---------- 执行 ----------
const LEGS = [
  { key: 'tree', args: ['--tree'] },
  { key: 'vm-only', args: ['--no-wasm'] },
  { key: 'vm+wasm', args: [] },
];

function writeProgram(name, src) {
  const p = path.join(TMP, name.replace(/\s+/g, '-') + '.ming');
  fs.writeFileSync(p, src, 'utf8');
  return p;
}

// 单腿运行(恒带 MING_STATS=1;O0.1 已验证 stdout 与不带 env 逐字一致,
// 并在 default 腿额外做一次不带 env 的逐字复核,见 runProgram 的 noEnvCheck)。
// 返回 { ok, stdout, stats, ms }。
function runLeg(file, args) {
  const env = { ...process.env, MING_STATS: '1' };
  const r = spawnSync(process.execPath, [MING, 'run', file, ...args], { encoding: 'utf8', cwd: ROOT, env, timeout: 120000 });
  let stats = null;
  const lines = (r.stderr || '').split('\n').filter((l) => l.trim() !== '');
  const last = lines[lines.length - 1];
  if (last && last.startsWith('{')) {
    try { stats = JSON.parse(last); } catch { stats = null; }
  }
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', stats };
}

// cc 腿:编译一次 → 跑产物,stdout 与 vm+wasm 腿逐字一致(纯产物时间不测,那是 bench 的职责)。
function runCc(file, name) {
  const outDir = path.join(TMP, 'cc-' + name.replace(/\s+/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });
  const b = spawnSync(process.execPath, [MING, 'cc', file, '--out', outDir], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  if (b.status !== 0) {
    const reason = (b.stderr || b.stdout || '').split('\n').find((l) => l.trim() !== '') ?? '未知原因';
    return { ok: false, skipped: true, reason: reason.trim().slice(0, 120) };
  }
  const exe = path.join(outDir, path.basename(file).replace(/\.ming$/, '') + (process.platform === 'win32' ? '.exe' : ''));
  if (!fs.existsSync(exe)) return { ok: false, skipped: true, reason: '产物缺失' };
  const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 120000 });
  return { ok: r.status === 0, skipped: false, stdout: r.stdout ?? '' };
}

const results = [];   // { name, file, legs: {key: {stdout, stats}}, cc }
const failures = [];
let checks = 0;

for (const prog of GENERATED) {
  const file = writeProgram(prog.name, prog.src);
  results.push(await gateProgram({ ...prog, file }));
}
for (const prog of EXAMPLES) {
  results.push(await gateProgram(prog));
}

async function gateProgram(prog) {
  const legs = {};
  for (const leg of LEGS) {
    const r = runLeg(prog.file, leg.args);
    legs[leg.key] = r;
    checks++;
    if (!r.ok) {
      failures.push(`${prog.name}[${leg.key}]: 退出码非 0,stderr=${(r.stderr || '').split('\n')[0]?.slice(0, 120)}`);
    }
  }
  // 期望输出(生成程序与 examples 都做精确断言;防三腿一致但全错)
  checks++;
  if (legs['vm+wasm'].stdout !== prog.expect) {
    failures.push(`${prog.name}[vm+wasm]: 输出与期望不符 got=${JSON.stringify(legs['vm+wasm'].stdout.slice(0, 60))}`);
  }
  // 三腿逐字一致(tree vs vm-only vs vm+wasm)
  checks++;
  const same = legs.tree.stdout === legs['vm-only'].stdout && legs['vm-only'].stdout === legs['vm+wasm'].stdout;
  if (!same) {
    failures.push(`${prog.name}: 三腿 stdout 不一致 tree=${JSON.stringify(legs.tree.stdout.slice(0, 40))} vm-only=${JSON.stringify(legs['vm-only'].stdout.slice(0, 40))} vm+wasm=${JSON.stringify(legs['vm+wasm'].stdout.slice(0, 40))}`);
  }
  // MING_STATS=1 零 stdout 偏差复核(default 腿,不带 env 再跑一次)
  checks++;
  const plain = spawnSync(process.execPath, [MING, 'run', prog.file], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  if (plain.status !== 0 || plain.stdout !== legs['vm+wasm'].stdout) {
    failures.push(`${prog.name}: MING_STATS=1 与不带 env 的 stdout 不一致(或退出码非 0)`);
  }
  // cc 腿(资格者:编译 + 产物输出逐字;无资格者:如实记录跳过)
  let cc = null;
  if (prog.ccAble) {
    cc = runCc(prog.file, prog.name);
    checks++;
    if (!cc.ok) {
      failures.push(`${prog.name}[cc]: ${cc.skipped ? '跳过(' + cc.reason + ')' : '产物输出与 vm+wasm 不一致 got=' + JSON.stringify((cc.stdout ?? '').slice(0, 40))}`);
    } else if (cc.stdout !== legs['vm+wasm'].stdout) {
      failures.push(`${prog.name}[cc]: 产物输出与 vm+wasm 腿不一致 got=${JSON.stringify(cc.stdout.slice(0, 60))}`);
    }
  } else {
    // O0.2 已逐项 ming cc 实测:5 个生成程序均不达 C1/C2 资格(原因见 bench.mjs 各项注释)。
    cc = { ok: false, skipped: true, reason: '不达 cc 资格(C1/C2,见 tests/bench.mjs 第 7–11 项注释)' };
  }
  return { name: prog.name, legs, cc };
}

// --opt-off 消费点(预留):未来优化 pass 落地后,在此处按 OPT_OFF 分叉——
// 例如 pass 开关经 ming run 旗标/env 传入时,对同批程序追加一组 OPT_OFF 腿,
// 断言两态 stdout 逐字一致(优化不改语义)并采集两态 MING_STATS 差值。
// 当前:无任何 pass,OPT_OFF 恒等 default,不产生额外腿(见文件头注释 4)。

// ---------- 文档(--write-doc 时刷新 docs/opt-baseline.md) ----------
function fmtStat(v) { return v === null || v === undefined ? 'N/A' : String(v); }

function buildDoc() {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('# 优化基线(O0.3,plan §4.16)');
  lines.push('');
  lines.push('**优化前基线——未来 pass 的对照锚。**(采集于 v0.92 工作树;对本表程序零语义变化,审查 NOTE-3)');
  lines.push('');
  lines.push(`由 \`node tests/opt_gate.mjs --write-doc\` 机械生成(采集日期 ${date};手工编辑会被下次刷新覆盖)。`);
  lines.push('配套耗时锚点见 `tests/bench.baseline.json`(2026-11-20 刷新,含 O0.2 第 7–11 项;3 次取最小口径)。');
  lines.push('');
  lines.push('## MING_STATS=1 统计面');
  lines.push('');
  lines.push('字段口径(O0.1;`ming run` 结束后 stderr 一行 JSON):');
  lines.push('');
  lines.push('- `instr`:编译器函数表指令总数(字节码;tree 引擎无字节码 → N/A)');
  lines.push('- `steps`:引擎执行步数(tree/VM 同口径;wasm 循环头/调用按 +50 计)');
  lines.push('- `deepCopy`:interp.js deepCopy 入口计数(双引擎共用同一实现;含容器递归内层调用)');
  lines.push('- `alloc`:引擎累计分配终值(Vec/Map 按元素、str 按字符;tree 引擎口径 N/A)');
  lines.push('- `concat` / `callMethod`:VM CONCAT / CALLMETHOD opcode case 计数(tree 恒 0)');
  lines.push('- wasm 真实执行段不计入:eligible 函数在 wasm 内原生执行,不经过 JS 执行循环与 case 臂');
  lines.push('');
  lines.push('| 程序 | 腿 | instr | steps | deepCopy | alloc | concat | callMethod |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    for (const leg of LEGS) {
      const s = r.legs[leg.key].stats ?? {};
      lines.push(`| ${r.name} | ${leg.key} | ${fmtStat(s.instr)} | ${fmtStat(s.steps)} | ${fmtStat(s.deepCopy)} | ${fmtStat(s.alloc)} | ${fmtStat(s.concat)} | ${fmtStat(s.callMethod)} |`);
    }
  }
  lines.push('');
  lines.push('## cc 腿记录');
  lines.push('');
  lines.push('| 程序 | 结果 |');
  lines.push('|---|---|');
  for (const r of results) {
    const cell = r.cc.skipped ? `跳过(${r.cc.reason})` : '通过(产物输出与 vm+wasm 逐字一致)';
    lines.push(`| ${r.name} | ${cell} |`);
  }
  lines.push('');
  lines.push('## 三腿一致断言');
  lines.push('');
  lines.push('全部程序 tree / VM-only(--no-wasm) / VM+wasm(默认) 三腿 stdout 逐字一致'
    + (failures.length === 0 ? ':**通过**。' : `:**失败 ${failures.length} 项**(见下)。`));
  lines.push('');
  lines.push('## --opt-off(预留挂点)');
  lines.push('');
  lines.push('当前语言没有任何优化 pass,`--opt-off` 恒 default 行为(两态输出逐字相同)。'
    + '未来 O1 起的 pass 落地后,由 `tests/opt_gate.mjs` 在同批程序上跑 pass 开/关两态,'
    + '差值与本文件的"优化前基线"直接对照(接入点见 opt_gate.mjs OPT_OFF 消费点注释)。');
  lines.push('');
  return lines.join('\n') + '\n';
}

// ---------- 汇总 ----------
fs.rmSync(TMP, { recursive: true, force: true });

if (WRITE_DOC) {
  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, buildDoc(), 'utf8');
  console.log(`opt-baseline 文档已写入 docs/opt-baseline.md(${results.length} 程序 × ${LEGS.length} 腿)`);
}

console.log(`opt_gate: ${results.length} 程序,${checks} 项断言,失败 ${failures.length}${OPT_OFF ? '(--opt-off: 预留挂点,当前恒 default 行为)' : ''}`);
if (failures.length) {
  for (const f of failures) process.stderr.write(`✗ ${f}\n`);
  process.exitCode = 1;
} else {
  console.log('全部通过:三腿 stdout 逐字一致,期望输出符合,cc 腿(资格者)逐字一致。');
}
