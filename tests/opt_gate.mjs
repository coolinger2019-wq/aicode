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
//   5. O1 优化语义闸门(plan §4.16 O1;Agent B):程序集 = docs/opt-baseline.md
//      "O1 优化前指令数基线"同批(bench_vs 全部 8 个 .ming + examples/hello + fib)。
//      断言四类:① --no-opt 与优化开两态 × 三腿(tree/vm-only/vm+wasm)stdout 归一化后
//      逐字一致(计时程序剥离末位自测 ms token——该 token 逐次运行漂移,归一化口径即
//      bench_vs 验证 token 口径);② 优化不增指令(优化开 vm-only 腿 instr ≤ --no-opt 腿);
//      ③ 溢出/除零形态(2147483647i32 + 1i32、1/0)两态都 panic(101)且 stderr 首行逐字
//      (防"常量折叠吃掉 panic");④ 确定性(优化开默认腿跑两次归一化 stdout 一致)。
//      旗标规格:CLI --no-opt(首选)或 env MING_NO_OPT=1(Agent A 实现)。就绪判定两级:
//      ① 注册探测(bin/ming.js 源含 --no-opt/MING_NO_OPT——当前 CLI 静默忽略未知旗标,
//      纯行为探测无法区分"已实现"与"被忽略",以注册为就绪口径)+ ② 行为探测(hello 该
//      形态 exit 0 且输出符合)。就绪判定不过 → 本节 pending(0 项断言执行、退出码不因此
//      失败,旧断言不受影响),逐次重跑本脚本即轮询。--write-doc 刷新 docs/opt-baseline.md
//      时,O1:BASELINE 标记区(Agent B 维护:优化前基线 + O1 后对照)原样保留不覆盖。
//   6. O1 审查修复回归锚(Agent D;B1/M1/m1/m2):四类断言,与 5 互补——
//      D1(B1)AOT 端到端浮点无损(ming build → dist stdout 与 source/--tree 逐字);
//      D2(M1)str 拼接配额四腿一致(默认/--no-wasm/--tree/--no-opt × --max-alloc 4);
//      D3(m2)build --no-opt(--no-opt 与 MING_NO_OPT=1 产物逐字节一致 + build_key 含
//      opt 状态、缓存不得跨态命中);D4(m1)JUMP 终结 DCE(break/continue 后死代码删除)。
//      四类均为硬断言(修复已落地并经独立验证);仅 --no-opt 未注册时 D2/D3/D4 pending。
//   7. O1b 通用窥孔闸门(Agent B2):10 个窥孔形态程序(纯值语句/panic 值语句 × 2/
//      全字面量 CONCAT/混合 CONCAT/LD+ST 自赋值/嵌套折叠链/CONCAT 值语句循环/
//      循环内纯值+块值/短路跳转目标守卫)× 优化开/--no-opt 两态 × 三腿。断言:
//      ① 语义闸门(stdout 逐字 + panic 首行逐字);② instr 不增(opt ≤ no-opt);
//      ③ 有效性(纯值语句/全字面量 CONCAT 两形态 opt instr 严格下降);
//      ④ panic 值语句保留(1/0; 与 1%0; 两态 101 + 首行逐字);⑤ 确定性(两次 opt
//      逐字节)。就绪判定三级:src/opt.js 含 peephole 迹象 + --no-opt 已注册 +
//      行为探测(O1a 中性的 LD;POP 语句 instr 严格下降)。未就绪 → pending(0 项
//      执行、退出码不因此失败),逐次重跑本脚本即轮询。
//   8. O1c 常量传播闸门(Agent B3):8 个自建靶点(有效性链 × 2 / 放弃锚 mut·捕获·
//      形参 / 值语义 Vec·循环 let·str)+ panic 保留锚。断言:传播+折叠严格下降、
//      放弃锚两态 instr 相等、值语义精确输出(按 A3 裁决校准容器/str 两态关系)、
//      四腿 stdout(优化开/--no-opt × 三腿 + HEAD golden)逐字、确定性。就绪判定
//      三级:src/opt.js 含 constProp 迹象 + --no-opt 注册 + 行为探测(cp1 链下降)。
//      未就绪 → pending(0 项执行),逐次重跑即轮询。基线见 docs/opt-baseline.md
//      "O1c 常量传播前基线"(HEAD 6758123)。
//
// 用法:node tests/opt_gate.mjs [--write-doc] [--opt-off]
// 退出码:全部断言通过 → 0;任何三腿不一致/cc 失败/期望输出不符/O1 断言失败 → 1(错误走 stderr)。

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

// 洁净基线 env(v0.94 审查 MINOR-1;v0.95 O1b 修为**模块级单一事实来源**——
// 旧版误把声明放在 runLeg 体内,runO1/dSpawn/O1b 在模块级解引用时 ReferenceError):
// 开发者 shell 导出的 MING_NO_OPT / MING_WASM_STRICT 不得污染"优化开"腿;所有
// spawn 统一走 BASE_ENV_O1(需注入开关的腿显式展开覆盖)。
const BASE_ENV_O1 = { ...process.env };
delete BASE_ENV_O1.MING_NO_OPT;
delete BASE_ENV_O1.MING_WASM_STRICT;
delete BASE_ENV_O1.MING_STATS;

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
  const env = { ...BASE_ENV_O1, MING_STATS: '1' };
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
// O1 pass 的两态闸门已在下方"O1 优化语义闸门"节实现(--no-opt/MING_NO_OPT 规格)。

// ============================================================
// O1 优化语义闸门(plan §4.16 O1;Agent B 维护,见文件头注释 5)
// ============================================================
// 程序集 = docs/opt-baseline.md "O1 优化前指令数基线"(HEAD 3887511 worktree 纯净副本)
// 同批:tests/bench_vs/progs 全部 8 个 .ming + examples/hello + examples/fib。
// 期望 token 与 tests/bench_vs/run.mjs EXPECT 同源(公式复算,非手抄;改动需两处同步):
//   fib=46368 / loopsum=500000500000 / hof=2500050000(偶数和 2·Σ1..50000) /
//   jsonparse=meta.total(meta.n_items) / filescan=(行数,字节数)逐式复算;
//   wordfreq 的 64 词 VOCAB 表过重不复制,token [20000,64,309,298] 按 seed=20261120
//   定值登记(bench_vs 变更 seed/生成器/VOCAB 时两处同步)。
const O1_BENCH_PROGS = path.join(ROOT, 'tests', 'bench_vs', 'progs');
const O1_FIXTURE_DIR = path.join(os.tmpdir(), 'ming-bench-vs', 'json');
const O1_FILESCAN_DIR = path.join(TMP, 'o1-filescan');
fs.mkdirSync(O1_FILESCAN_DIR, { recursive: true });

// 10MB JSON fixture(与 tests/bench_vs/run.mjs ensureJsonFixture 逐式同源,缺了才生成;
// 改动需两处同步)。jsonparse.ming 只消费 meta.total / meta.n_items。
const O1_JSON_ITEMS = 68000;
const O1_JSON_TOTAL = (() => { let s = 0; for (let i = 0; i < O1_JSON_ITEMS; i++) s += i; return s; })();
function ensureO1JsonFixture() {
  fs.mkdirSync(O1_FIXTURE_DIR, { recursive: true });
  const file = path.join(O1_FIXTURE_DIR, 'data_10mb.json');
  if (fs.existsSync(file)) {
    const sz = fs.statSync(file).size;
    if (sz > 9 * 1024 * 1024 && sz < 11 * 1024 * 1024) return file;
  }
  const pad6 = (n) => String(n).padStart(6, '0');
  const parts = [];
  parts.push(`{"meta":{"total":${O1_JSON_TOTAL},"n_items":${O1_JSON_ITEMS},"seed":20261120,"generator":"ming-bench-vs"},"items":[`);
  const itemStrs = new Array(O1_JSON_ITEMS);
  for (let i = 0; i < O1_JSON_ITEMS; i++) {
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
  return file;
}
ensureO1JsonFixture();

// filescan 期望 token(bench_vs/run.mjs EXPECT.filescan 同源复算:行数按 \n 计,字节按 UTF-8)
const O1_FILESCAN_TOKENS = (() => {
  let lines = 0, bytes = 0;
  for (let i = 0; i < 1000; i++) {
    for (let j = 0; j < 10; j++) {
      bytes += Buffer.byteLength(`file ${i} line ${j} v${(i + j) % 97}\n`);
      lines++;
    }
  }
  return [lines, bytes];
})();

// timing=true → 输出首行末 token 为程序自测 ms(逐次运行漂移):比较前剥离,
// 验证 token = 其余 token(数值比对);timing=false → stdout 全确定,整串精确比对。
const O1_PROGS = [
  { name: 'bench_vs fib', file: path.join(O1_BENCH_PROGS, 'fib.ming'), cwd: ROOT, timing: true, tokens: [46368] },
  { name: 'bench_vs fib_cc', file: path.join(O1_BENCH_PROGS, 'fib_cc.ming'), cwd: ROOT, timing: false, expect: '46368\n' },
  { name: 'bench_vs loopsum', file: path.join(O1_BENCH_PROGS, 'loopsum.ming'), cwd: ROOT, timing: true, tokens: [500000500000] },
  { name: 'bench_vs loopsum_cc', file: path.join(O1_BENCH_PROGS, 'loopsum_cc.ming'), cwd: ROOT, timing: false, expect: '500000500000\n' },
  { name: 'bench_vs hof', file: path.join(O1_BENCH_PROGS, 'hof.ming'), cwd: ROOT, timing: true, tokens: [2500050000] },
  { name: 'bench_vs wordfreq', file: path.join(O1_BENCH_PROGS, 'wordfreq.ming'), cwd: ROOT, timing: true, tokens: [20000, 64, 309, 298] },
  { name: 'bench_vs jsonparse', file: path.join(O1_BENCH_PROGS, 'jsonparse.ming'), cwd: O1_FIXTURE_DIR, timing: true, tokens: [O1_JSON_TOTAL, O1_JSON_ITEMS] },
  { name: 'bench_vs filescan', file: path.join(O1_BENCH_PROGS, 'filescan.ming'), cwd: O1_FILESCAN_DIR, timing: true, tokens: O1_FILESCAN_TOKENS },
  { name: 'hello(example)', file: EXAMPLES[0].file, cwd: ROOT, timing: false, expect: EXAMPLES[0].expect },
  { name: 'fib(example)', file: EXAMPLES[1].file, cwd: ROOT, timing: false, expect: EXAMPLES[1].expect },
];

// 计时程序归一化:剥离首行末 token(自测 ms);非计时程序原样(裁空行/首尾空白后拼接)。
function normO1Stdout(prog, stdout) {
  const ls = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (prog.timing && ls.length > 0) {
    const tk = ls[0].split(/\s+/).filter((t) => t !== '');
    tk.pop();
    ls[0] = tk.join(' ');
  }
  return ls.join('\n');
}

// O1 单次运行:noOpt=true 按探测到的旗标形态关闭优化。恒带 MING_STATS=1(instr 断言用)。
function runO1(file, args, cwd, noOpt) {
  const env = { ...BASE_ENV_O1, MING_STATS: '1', ...(noOpt && O1_NOOPT.env ? O1_NOOPT.env : {}) };
  const r = spawnSync(process.execPath, [MING, 'run', file, ...(noOpt ? O1_NOOPT.args : []), ...args], { encoding: 'utf8', cwd, env, timeout: 300000 });
  let stats = null;
  const lines = (r.stderr || '').split('\n').filter((l) => l.trim() !== '');
  const last = lines[lines.length - 1];
  if (last && last.startsWith('{')) {
    try { stats = JSON.parse(last); } catch { stats = null; }
  }
  return { ok: r.status === 0, exit: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', stats };
}

// 旗标就绪判定(两级,缺一 pending):
// a) 注册探测:bin/ming.js 源含 '--no-opt' 或 'MING_NO_OPT'。必需——实测(2026-11-20)
//    当前 CLI 对未知旗标静默忽略(exit 0)、env 是普通变量,纯行为探测无法区分
//    "已实现"与"被忽略";以注册为就绪口径,不改 bin/ming.js(归 Agent A)。
// b) 行为探测:注册后,hello 以该形态跑一遍 exit 0 且 stdout 与期望一致 → 该形态可用。
// 都过 → O1 节执行断言;否则 pending(0 项断言,退出码不因此失败),逐次重跑本脚本即轮询,
// 本文件不 sleep 等待。
function probeNoOpt() {
  let registered = false;
  try {
    const src = fs.readFileSync(MING, 'utf8');
    registered = src.includes('--no-opt') || src.includes('MING_NO_OPT');
  } catch { registered = false; }
  if (!registered) return null;
  const hello = EXAMPLES[0].file;
  const want = EXAMPLES[0].expect;
  const cli = spawnSync(process.execPath, [MING, 'run', hello, '--no-opt'], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  if (cli.status === 0 && cli.stdout === want) return { args: ['--no-opt'], env: null, label: '--no-opt' };
  const envRun = spawnSync(process.execPath, [MING, 'run', hello], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, MING_NO_OPT: '1' }, timeout: 120000 });
  if (envRun.status === 0 && envRun.stdout === want) return { args: [], env: { MING_NO_OPT: '1' }, label: 'MING_NO_OPT=1' };
  return null;
}
const O1_NOOPT = probeNoOpt();

let o1Checks = 0;
const o1Failures = [];
let o1Status = O1_NOOPT
  ? `旗标=${O1_NOOPT.label}`
  : 'pending(--no-opt/MING_NO_OPT 尚未在 bin/ming.js 注册;当前 CLI 静默忽略未知旗标、env 为普通变量,行为探测不可判;0 项 O1 断言执行,旧断言不受影响)';

if (O1_NOOPT) {
  // ①②④:同批程序两态 × 三腿 + 默认腿复跑
  for (const prog of O1_PROGS) {
    const on = {}, off = {};
    for (const leg of LEGS) {
      on[leg.key] = runO1(prog.file, leg.args, prog.cwd, false);
      off[leg.key] = runO1(prog.file, leg.args, prog.cwd, true);
    }
    for (const leg of LEGS) {
      o1Checks++;
      if (!on[leg.key].ok) o1Failures.push(`O1 ${prog.name}[${leg.key}] 优化开:退出码 ${on[leg.key].exit}(stderr=${(on[leg.key].stderr || '').split('\n')[0]?.slice(0, 100)})`);
      o1Checks++;
      if (!off[leg.key].ok) o1Failures.push(`O1 ${prog.name}[${leg.key}] --no-opt:退出码 ${off[leg.key].exit}(stderr=${(off[leg.key].stderr || '').split('\n')[0]?.slice(0, 100)})`);
    }
    // ① 优化不改变行为(主断言):优化开/关 × 三腿,归一化 stdout 逐字一致
    o1Checks++;
    const outs = [...LEGS.map((l) => normO1Stdout(prog, on[l.key].stdout)), ...LEGS.map((l) => normO1Stdout(prog, off[l.key].stdout))];
    if (new Set(outs).size !== 1) {
      o1Failures.push(`O1 ${prog.name}: 优化开/关 × 三腿 stdout 不一致(归一化后)=${JSON.stringify(outs.map((o) => o.slice(0, 40)))}`);
    }
    // 输出内容正确性(防"两态一致但全错";token 与 tests/bench_vs/run.mjs EXPECT 同源)
    o1Checks++;
    const norm0 = outs[0];
    if (prog.timing) {
      const tk = norm0.split(/\s+/).map(Number);
      const bad = tk.length !== prog.tokens.length
        || tk.some((t, i) => !Number.isFinite(t) || Math.abs(t - prog.tokens[i]) > Math.max(1e-6, Math.abs(prog.tokens[i]) * 1e-9));
      if (bad) o1Failures.push(`O1 ${prog.name}: 验证 token 不符 got=${JSON.stringify(norm0.slice(0, 60))} want=${JSON.stringify(prog.tokens)}`);
    } else if (norm0 !== normO1Stdout(prog, prog.expect)) {
      // 期望串含尾 \n 而归一化裁空行 → 两侧同口径归一化后再比
      o1Failures.push(`O1 ${prog.name}: 输出与期望不符 got=${JSON.stringify(norm0.slice(0, 60))}`);
    }
    // ② 优化不增指令:优化开 vm-only 腿 instr ≤ --no-opt 腿 instr
    //    (instr 为编译期指标,vm-only 与 vm+wasm 同值;取 vm-only 腿免 wasm 计费干扰)
    o1Checks++;
    const iOn = on['vm-only'].stats ? on['vm-only'].stats.instr : null;
    const iOff = off['vm-only'].stats ? off['vm-only'].stats.instr : null;
    if (typeof iOn !== 'number' || typeof iOff !== 'number') {
      o1Failures.push(`O1 ${prog.name}: instr 缺失(优化开=${iOn}, --no-opt=${iOff})`);
    } else if (iOn > iOff) {
      o1Failures.push(`O1 ${prog.name}: 优化增指令 instr 优化开=${iOn} > --no-opt=${iOff}`);
    }
    // ④ 确定性:优化开默认腿(vm+wasm)再跑一次,归一化 stdout 一致
    o1Checks++;
    const again = runO1(prog.file, [], prog.cwd, false);
    if (!again.ok || normO1Stdout(prog, again.stdout) !== normO1Stdout(prog, on['vm+wasm'].stdout)) {
      o1Failures.push(`O1 ${prog.name}: 优化开默认腿两次运行不一致(确定性;再跑退出码=${again.exit})`);
    }
  }
  // ③ 溢出/除零形态:两种模式下都 panic(exit 101)且 stderr 首行逐字(防"折叠吃掉 panic")
  const O1_PANICS = [
    { name: 'i32-溢出', src: 'fn main() with io { print(str(2147483647i32 + 1i32)); }', code: 'M4002' },
    { name: '除零', src: 'fn main() with io { print(str(1 / 0)); }', code: 'M4004' },
  ];
  for (const pz of O1_PANICS) {
    const f = path.join(TMP, 'o1-panic-' + pz.name + '.ming');
    fs.writeFileSync(f, pz.src, 'utf8');
    const a = runO1(f, [], ROOT, false);
    const b = runO1(f, [], ROOT, true);
    o1Checks++;
    if (a.exit !== 101) o1Failures.push(`O1 panic ${pz.name}: 优化开退出码 ${a.exit} ≠ 101(stderr 首=${(a.stderr || '').split('\n')[0]?.slice(0, 100)})`);
    o1Checks++;
    if (b.exit !== 101) o1Failures.push(`O1 panic ${pz.name}: --no-opt 退出码 ${b.exit} ≠ 101(stderr 首=${(b.stderr || '').split('\n')[0]?.slice(0, 100)})`);
    o1Checks++;
    const fa = (a.stderr || '').split('\n')[0] ?? '';
    const fb = (b.stderr || '').split('\n')[0] ?? '';
    if (fa === '' || fa !== fb || !fa.includes(pz.code)) {
      o1Failures.push(`O1 panic ${pz.name}: 首行不逐字或缺 ${pz.code}(开=${JSON.stringify(fa.slice(0, 100))} 关=${JSON.stringify(fb.slice(0, 100))})`);
    }
  }
}

// ============================================================
// O1 审查修复回归锚(B1/M1/m1/m2;Agent D 独立验证维护,见文件头注释 6)
// ============================================================
// 与上方"O1 优化语义闸门"互补:该节锁两态语义等价,本节锁审查 REQUEST_CHANGES
// 四项修复的永久回归面。四类断言均为**硬断言**(修复已落地并经独立验证 2026-11-20;
// 失败 = 门禁红)。唯一 pending 面 = --no-opt 未注册(整节 O1 未交付——D2/D3/D4):
//   D1(B1 BLOCKER)AOT 端到端浮点无损:折叠/字面量产生的 Inf/NaN/-0.0 经
//      ming build 的 wire(JSON)编码不得丢失 → dist stdout 与 source/--tree 逐字。
//      四程序:-0.0 除零 / 1.0e308*10 / NaN(0.0/0.0 + Inf-Inf 折叠)/ 模块级 const 浮点。
//      断言 dist/app.bytecode.json 存在(AOT 路径——防"回退源码模式"把回归锚弄空)。
//   D2(M1 MAJOR)str 拼接配额四腿一致:'"aaaa"+"bbbb"' × --max-alloc 4 → 默认/
//      --no-wasm/--tree/--no-opt 全部 exit 101、M4011 首行逐字一致
//      (str+ 折叠曾被移除:折叠抹掉运行时 alloc 记账 → 腿分裂)。
//   D3(m2)build --no-opt 覆盖构建:--no-opt build 与 MING_NO_OPT=1 build 的
//      dist/app.bytecode.json 逐字节一致(且与优化开产物不同——证明程序确实可折叠)
//      + build_key 含 opt 状态:opt build 后 --no-opt build 不得缓存命中,再切回
//      opt 同样不得命中(键随 opt 态变化)。
//   D4(m1)DCE 终结指令含 JUMP:break/continue 后死代码删除(instr 下降;
//      与"本就无死代码"版本 instr 相等;stdout 三腿逐字)。
let dChecks = 0;
const dFailures = [];
const dStatus = [];
const dFail = (msg) => dFailures.push(msg);

function dSpawn(args, cwd, env = null) {
  return spawnSync(process.execPath, [MING, ...args], {
    encoding: 'utf8', cwd, timeout: 120000,
    env: env ? { ...BASE_ENV_O1, ...env } : BASE_ENV_O1,
  });
}

// 临时 Ming 项目(ming.toml + main.ming);目录名仅 ASCII。
function dProject(name, src) {
  const dir = path.join(TMP, 'o1d-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ming.toml'),
    `[project]\nname = "${name}"\nversion = "0.1.0"\nentry = "main.ming"\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'main.ming'), src, 'utf8');
  return dir;
}

// ming build --json:stdout 为纯 JSON(人读行在 json 模式走 stderr)。
function dBuild(dir, extraArgs = [], env = null) {
  const r = dSpawn(['build', '--json', ...(extraArgs ?? [])], dir, env);
  let info = null;
  try { info = JSON.parse(r.stdout); } catch { info = null; }
  return { r, info };
}

function dRunDist(dir) {
  const exe = path.join(dir, 'dist', 'ming-app.mjs');
  if (!fs.existsSync(exe)) return { status: -1, stdout: '', stderr: '产物缺失 dist/ming-app.mjs' };
  return spawnSync(process.execPath, [exe], { encoding: 'utf8', cwd: dir, timeout: 120000 });
}

const dHasAot = (dir) => fs.existsSync(path.join(dir, 'dist', 'app.bytecode.json'));
const dArtPath = (dir) => path.join(dir, 'dist', 'app.bytecode.json');

// ---------- D1(B1):AOT 端到端浮点无损 ----------
const D1_PROGS = [
  {
    name: 'negzero',
    src: 'fn main() with io {\n    let z = -0.0;\n    print(1.0 / z);\n}\n',
    expect: '-Infinity\n',
  },
  {
    name: 'infmul',
    src: 'fn main() with io {\n    print(1.0e308 * 10.0);\n}\n',
    expect: 'Infinity\n',
  },
  {
    name: 'nan',
    src: 'fn main() with io {\n    print(0.0 / 0.0);\n    print((1.0e308 * 10.0) - (1.0e308 * 10.0));\n}\n',
    expect: 'NaN\nNaN\n',
  },
  {
    name: 'const',
    src: 'const BIG: f64 = 1.0e308 * 10.0;\nconst NEG: f64 = -0.0;\n\nfn main() with io {\n    print(BIG);\n    print(1.0 / NEG);\n}\n',
    expect: 'Infinity\n-Infinity\n',
  },
];
{
  // 硬断言(B1 修复已落地并经独立验证 2026-11-20):浮点 wire 无损是 AOT 合同,
  // dist 与 source/--tree 逐字。四程序覆盖 -0.0/±Inf/NaN/模块级 const 浮点。
  for (const prog of D1_PROGS) {
      const dir = dProject('d1-' + prog.name, prog.src);
      const b = dBuild(dir);
      dChecks++;
      if (b.r.status !== 0 || !b.info || !b.info.ok) {
        dFail(`D1 ${prog.name}: ming build 失败 exit=${b.r.status}(stderr 首=${(b.r.stderr || '').split('\n')[0]?.slice(0, 120)})`);
      }
      dChecks++;
      if (!dHasAot(dir)) dFail(`D1 ${prog.name}: 产物无 app.bytecode.json(非 AOT 路径,回归锚失效)`);
      const src = dSpawn(['run', 'main.ming'], dir);
      const tree = dSpawn(['run', 'main.ming', '--tree'], dir);
      const dist = dRunDist(dir);
      dChecks++;
      if (src.status !== 0 || src.stdout !== prog.expect) {
        dFail(`D1 ${prog.name}: source 输出不符 exit=${src.status} got=${JSON.stringify(src.stdout.slice(0, 60))} want=${JSON.stringify(prog.expect)}`);
      }
      dChecks++;
      if (dist.status !== 0 || dist.stdout !== prog.expect) {
        dFail(`D1 ${prog.name}: dist 输出不符(浮点 wire 丢信息)exit=${dist.status} got=${JSON.stringify(dist.stdout.slice(0, 60))} want=${JSON.stringify(prog.expect)}`);
      }
      dChecks++;
      if (dist.stdout !== src.stdout || dist.stdout !== tree.stdout) {
        dFail(`D1 ${prog.name}: dist/source/--tree 不逐字 dist=${JSON.stringify(dist.stdout.slice(0, 40))} src=${JSON.stringify(src.stdout.slice(0, 40))} tree=${JSON.stringify(tree.stdout.slice(0, 40))}`);
      }
  }
  dStatus.push(`D1(B1) 硬断言(${D1_PROGS.length} 程序 AOT)`);
}

// ---------- D2(M1):str 拼接配额四腿一致 ----------
const D2_SRC = 'fn main() with io {\n    let s = "aaaa" + "bbbb";\n    print(s);\n}\n';
{
  const dir = dProject('d2quota', D2_SRC);
  const runQuota = (args) => {
    const r = spawnSync(process.execPath, [MING, 'run', 'main.ming', ...args, '--max-alloc', '4'],
      { encoding: 'utf8', cwd: dir, timeout: 120000 });
    const first = (r.stderr || '').split('\n')[0] ?? '';
    return { exit: r.status, stdout: r.stdout ?? '', first };
  };
  const legs = [
    { key: '默认', args: [] },
    { key: '--no-wasm', args: ['--no-wasm'] },
    { key: '--tree', args: ['--tree'] },
    { key: '--no-opt', args: ['--no-opt'] },
  ];
  const runs = legs.map((l) => ({ ...l, r: runQuota(l.args) }));
  // 硬断言(M1 修复已落地并经独立验证 2026-11-20):str+ 不折叠 → 四腿配额一致。
  // 唯一 pending 面 = --no-opt 旗标未注册(整节 O1 尚未交付,O1_NOOPT=null)。
  if (!O1_NOOPT) {
    dStatus.push('D2(M1) pending:--no-opt 未注册(O1 未交付);四腿断言未执行');
  } else {
    for (const l of runs) {
      dChecks++;
      if (l.r.exit !== 101 || l.r.stdout !== '' || !l.r.first.includes('M4011')) {
        dFail(`D2 ${l.key}: 期望 exit 101 + 空 stdout + M4011 首行,got exit=${l.r.exit} stdout=${JSON.stringify(l.r.stdout.slice(0, 40))} 首行=${JSON.stringify(l.r.first.slice(0, 120))}`);
      }
    }
    dChecks++;
    const firsts = runs.map((l) => l.r.first);
    if (new Set(firsts).size !== 1) {
      dFail(`D2: 四腿 M4011 首行不逐字 ${JSON.stringify(firsts.map((f) => f.slice(0, 80)))}`);
    }
    dStatus.push(`D2(M1) 硬断言(${runs.length} 腿)`);
  }
}

// ---------- D3(m2):build --no-opt + 构建键含 opt 状态 ----------
const D3_SRC = 'fn main() with io {\n    print(1 + 2 * 3);\n    print("aaaa" + "bbbb");\n}\n';
{
  const dirFlag = dProject('d3flag', D3_SRC);
  const dirEnv = dProject('d3env', D3_SRC);
  const dirOpt = dProject('d3opt', D3_SRC);
  const bFlag = dBuild(dirFlag, ['--no-opt']);
  const bEnv = dBuild(dirEnv, [], { MING_NO_OPT: '1' });
  const bOpt = dBuild(dirOpt);
  const readArt = (d) => { try { return fs.readFileSync(dArtPath(d), 'utf8'); } catch { return null; } };
  const artFlag = readArt(dirFlag);
  const artEnv = readArt(dirEnv);
  const artOpt = readArt(dirOpt);
  const sameFlagEnv = artFlag !== null && artFlag === artEnv;
  // 硬断言(m2 修复已落地并经独立验证 2026-11-20):--no-opt build 必须与
  // MING_NO_OPT=1 build 同产物 + 构建键含 opt 态(不跨态假命中)。
  if (!O1_NOOPT) {
    dStatus.push('D3(m2) pending:--no-opt 未注册(O1 未交付);断言未执行');
  } else {
    dChecks++;
    if (bFlag.r.status !== 0 || bEnv.r.status !== 0 || bOpt.r.status !== 0) dFail(`D3: 三次 build 非全 0 退出(${bFlag.r.status}/${bEnv.r.status}/${bOpt.r.status})`);
    dChecks++;
    if (!sameFlagEnv) dFail(`D3: --no-opt build 与 MING_NO_OPT=1 build 产物不逐字节一致(artFlag ${artFlag === null ? '缺失' : artFlag.length + 'B'}/artEnv ${artEnv === null ? '缺失' : artEnv.length + 'B'})`);
    dChecks++;
    if (artOpt === null || artOpt === artFlag) dFail('D3: 优化开产物与 --no-opt 产物相同(程序未触发折叠,回归锚失效)');
    dChecks++;
    const outs = [dRunDist(dirFlag), dRunDist(dirEnv), dRunDist(dirOpt)].map((r) => `${r.status}:${r.stdout}`);
    if (new Set(outs).size !== 1 || outs[0] !== '0:7\naaaabbbb\n') {
      dFail(`D3: 三种构建 dist 输出不一致/不符 ${JSON.stringify(outs)}`);
    }
    // 构建键含 opt 状态:同一项目 opt → --no-opt → opt,三次都不得缓存命中,键随态变化。
    const dirCache = dProject('d3cache', D3_SRC);
    const c1 = dBuild(dirCache);
    const c2 = dBuild(dirCache, ['--no-opt']);
    const c3 = dBuild(dirCache);
    dChecks++;
    if (!c1.info || c1.info.cache_hit !== false) dFail(`D3: 首次 opt build 期望 cache_hit=false,got=${JSON.stringify(c1.info && c1.info.cache_hit)}`);
    dChecks++;
    if (!c2.info || c2.info.cache_hit !== false) dFail(`D3: opt→--no-opt build 缓存命中(构建键不含 opt 状态)cache_hit=${JSON.stringify(c2.info && c2.info.cache_hit)}`);
    dChecks++;
    if (!c2.info || !c1.info || c2.info.build_key === c1.info.build_key) dFail(`D3: opt 与 --no-opt 的 build_key 相同(${c1.info && c1.info.build_key})=构建键未纳入 opt 状态`);
    dChecks++;
    if (!c3.info || c3.info.cache_hit !== false) dFail(`D3: --no-opt→opt build 缓存命中(键未随态切换)cache_hit=${JSON.stringify(c3.info && c3.info.cache_hit)}`);
    dChecks++;
    if (!c3.info || !c1.info || c3.info.build_key !== c1.info.build_key) dFail(`D3: 回到 opt 的 build_key 与首次不同(${c1.info && c1.info.build_key}/${c3.info && c3.info.build_key})=键不确定`);
    dStatus.push('D3(m2) 硬断言');
  }
}

// ---------- D4(m1):JUMP 终结指令 + DCE ----------
{
  // withDead = break/continue 之后各跟一段死代码;withoutDead = 同语义去掉死代码。
  // m1 未修时两者 instr 差 = 死代码体积(42 vs 34);修复后 DCE 删净 → 相等。
  const withDead = [
    'fn main() with io {',
    '    let mut i = 0;',
    '    while i < 5 {',
    '        i += 1;',
    '        if i == 2 {',
    '            break;',
    '            print("dead-break");',
    '        }',
    '        if i == 0 {',
    '            continue;',
    '            print("dead-continue");',
    '        }',
    '        print(str(i));',
    '    }',
    '}',
    '',
  ].join('\n');
  const withoutDead = [
    'fn main() with io {',
    '    let mut i = 0;',
    '    while i < 5 {',
    '        i += 1;',
    '        if i == 2 {',
    '            break;',
    '        }',
    '        if i == 0 {',
    '            continue;',
    '        }',
    '        print(str(i));',
    '    }',
    '}',
    '',
  ].join('\n');
  const fDead = path.join(TMP, 'o1d-dce-withdead.ming');
  const fClean = path.join(TMP, 'o1d-dce-withoutdead.ming');
  fs.writeFileSync(fDead, withDead, 'utf8');
  fs.writeFileSync(fClean, withoutDead, 'utf8');
  const statsOf = (file, extra = []) => {
    const r = spawnSync(process.execPath, [MING, 'run', file, ...extra],
      { encoding: 'utf8', cwd: ROOT, env: { ...BASE_ENV_O1, MING_STATS: '1' }, timeout: 120000 });
    const lines = (r.stderr || '').split('\n').filter((l) => l.trim() !== '');
    const last = lines[lines.length - 1];
    let st = null;
    if (last && last.startsWith('{')) { try { st = JSON.parse(last); } catch { st = null; } }
    return { r, st };
  };
  const optDead = statsOf(fDead);
  const nooptDead = statsOf(fDead, ['--no-opt']);
  const optClean = statsOf(fClean);
  const treeDead = spawnSync(process.execPath, [MING, 'run', fDead, '--tree'], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  const iOpt = optDead.st ? optDead.st.instr : null;
  const iNoopt = nooptDead.st ? nooptDead.st.instr : null;
  const iClean = optClean.st ? optClean.st.instr : null;
  // 硬断言(m1 修复已落地并经独立验证 2026-11-20):JUMP 是终结指令 → break/continue
  // 后死代码被 DCE 删净。唯一 pending 面 = --no-opt 未注册(O1 未交付)。
  if (!O1_NOOPT) {
    dStatus.push('D4(m1) pending:--no-opt 未注册(O1 未交付);断言未执行');
  } else {
    dChecks++;
    const outs = [optDead.r.stdout, nooptDead.r.stdout, treeDead.stdout];
    if (new Set(outs).size !== 1 || outs[0] !== '1\n') {
      dFail(`D4: 输出三腿不一致/不符 ${JSON.stringify(outs)}`);
    }
    dChecks++;
    if (!(iOpt < iNoopt)) dFail(`D4: instr 未下降(优化开=${iOpt} ≥ --no-opt=${iNoopt})`);
    dChecks++;
    if (typeof iClean !== 'number' || iOpt !== iClean) {
      dFail(`D4: 死代码版本 instr=${iOpt} ≠ 无死代码版本 instr=${iClean}(死代码未删净或被误删活代码)`);
    }
    dStatus.push(`D4(m1) 硬断言(instr ${iNoopt}→${iOpt})`);
  }
}

// ============================================================
// O1b 通用窥孔闸门(v0.95;Agent B2 维护,plan §4.16.3 第 4 项)
// ============================================================
// 程序集 = 10 个窥孔形态程序,每个都只依赖确定性求值(无时间/随机/文件系统)。
// 设计依据(v0.94 HEAD 字节码实测):
//   纯值语句 = [CONST|LD][POP] 对(P4.a 目标);panic 值语句 = CONST/CONST/BIN/POP
//   (BIN 必须保留,窥孔不得吃掉 panic);全字面量 CONCAT = [CONST×n][CONCAT n]
//   (P4.b 目标;O1a 不折叠 CONCAT);混合 CONCAT = 含 LD/CALL 段(不可折叠);
//   LD+ST 自赋值 = [LD][SET] 同槽(A2 头注登记跳过——语义/归一面保留,只锁不增);
//   嵌套折叠链 = O1a fixpoint 多层级联;短路语句 = `a && b;` 的假标签 CONST 是
//   跳转目标(P4.a 守卫必须跳过,否则漏弹栈值)。
// 就绪判定三级(缺一 pending):(a) src/opt.js 含 peephole 迹象(`peephole|窥孔`
//   或第 5 个 `*Pass(` 函数);(b) O1_NOOPT 已注册(O1 节探测);(c) 行为探测——
//   O1a 中性的 LD;POP 语句程序优化后 instr 严格下降。未就绪 → 本节 0 项执行、
//   退出码不因此失败;逐次重跑本脚本即轮询(A2 交付后自动转硬断言)。
const O1B_PROGS = [
  {
    key: 'pure-value',
    name: '纯值语句',
    effective: true,
    src: [
      'fn main() with io {',
      '    let mut a = 3;',
      '    a;',
      '    a + 0;',
      '    1 + 2;',
      '    print(str(a));',
      '}',
      '',
    ].join('\n'),
    expect: '3\n',
  },
  {
    key: 'panic-div',
    name: 'panic 值语句 1/0',
    panic: 'M4004',
    src: [
      'fn main() with io {',
      '    let a = 1;',
      '    1 / 0;',
      '    print(str(a));',
      '}',
      '',
    ].join('\n'),
  },
  {
    key: 'panic-mod',
    name: 'panic 值语句 1%0',
    panic: 'M4004',
    src: [
      'fn main() with io {',
      '    let a = 1;',
      '    1 % 0;',
      '    print(str(a));',
      '}',
      '',
    ].join('\n'),
  },
  {
    key: 'concat-all',
    name: '全字面量 CONCAT',
    effective: true,
    src: [
      'fn main() with io {',
      '    let s = "\\{"ab"}\\{"cd"}";',
      '    print(s);',
      '    "\\{"x"}\\{1 + 2}";',
      '}',
      '',
    ].join('\n'),
    expect: 'abcd\n',
  },
  {
    key: 'concat-mixed',
    name: '混合 CONCAT',
    src: [
      'fn main() with io {',
      '    let b = "cd";',
      '    let s = "\\{"ab"}\\{b}";',
      '    print(s);',
      '    print("\\{"x"}\\{str(1 + 2)}");',
      '}',
      '',
    ].join('\n'),
    expect: 'abcd\nx3\n',
  },
  {
    key: 'self-assign',
    name: 'LD+ST 自赋值',
    src: [
      'fn main() with io {',
      '    let mut a = 41;',
      '    a = a;',
      '    a = a;',
      '    print(str(a + 1));',
      '}',
      '',
    ].join('\n'),
    expect: '42\n',
  },
  {
    key: 'fold-chain',
    name: '嵌套折叠链',
    src: [
      'fn main() with io {',
      '    print(str(((1 + 2) * (3 + 4)) - (5 + 6)));',
      '    print(str((((10 - 2) * (3 + 1)) / 4) % 7));',
      '}',
      '',
    ].join('\n'),
    expect: '10\n1\n',
  },
  {
    key: 'concat-stmt-loop',
    name: 'CONCAT 值语句循环',
    src: [
      'fn main() with io {',
      '    "\\{"a"}\\{"b"}";',
      '    let mut i = 0;',
      '    while i < 3 {',
      '        "\\{"x"}\\{str(i)}";',
      '        i += 1;',
      '    }',
      '    print("ok");',
      '}',
      '',
    ].join('\n'),
    expect: 'ok\n',
  },
  {
    key: 'pure-loop-block',
    name: '循环内纯值语句 + 块值',
    src: [
      'fn main() with io {',
      '    let mut i = 0;',
      '    let mut acc = 0;',
      '    while i < 1000 {',
      '        i;',
      '        1 + 2;',
      '        i + 0;',
      '        if i % 2 == 0 { i; } else { 0; }',
      '        acc += i;',
      '        i += 1;',
      '    }',
      '    print(str(acc));',
      '}',
      '',
    ].join('\n'),
    expect: '499500\n',
  },
  {
    key: 'shortcircuit-guard',
    name: '短路语句跳转目标守卫',
    src: [
      'fn side() -> bool with io {',
      '    print("side");',
      '    true',
      '}',
      'fn main() with io {',
      '    let a = false;',
      '    let b = true;',
      '    a && b;',
      '    a || side();',
      '    b && side();',
      '    print("done");',
      '}',
      '',
    ].join('\n'),
    expect: 'side\nside\ndone\n',
  },
];

function probePeephole() {
  let src = '';
  try { src = fs.readFileSync(path.join(ROOT, 'src', 'opt.js'), 'utf8'); } catch {
    return { ready: false, reason: 'src/opt.js 不可读' };
  }
  const passCount = (src.match(/function\s+\w*Pass\s*\(/g) ?? []).length;
  const sign = /peephole|窥孔/i.test(src) || passCount >= 5;
  if (!sign) return { ready: false, reason: 'src/opt.js 尚无 peephole 迹象(A2 未就绪)' };
  if (!O1_NOOPT) return { ready: false, reason: '--no-opt/MING_NO_OPT 未注册(O1 未交付)' };
  // 行为探测:O1a 中性的形态——`a;` 编译为 LD;POP(O1a 折叠/裁剪/DCE 均不动),
  // 只有窥孔的语句值 POP 消除会让 instr 严格下降(且与 O1a 收益可区分)。
  const probeFile = path.join(TMP, 'o1b-probe-pop.ming');
  fs.writeFileSync(probeFile, 'fn main() with io {\n    let mut a = 1;\n    a;\n    print(str(a));\n}\n', 'utf8');
  const on = runO1(probeFile, ['--no-wasm'], ROOT, false);
  const off = runO1(probeFile, ['--no-wasm'], ROOT, true);
  const iOn = on.stats ? on.stats.instr : null;
  const iOff = off.stats ? off.stats.instr : null;
  if (on.ok && off.ok && typeof iOn === 'number' && typeof iOff === 'number' && iOn < iOff) {
    return { ready: true, reason: `行为探测 LD;POP instr ${iOff}→${iOn}` };
  }
  return { ready: false, reason: `源码有窥孔迹象但行为探测未观察到 instr 下降(opt=${iOn} no-opt=${iOff};A2 可能仍在编辑)` };
}

const O1B_READY = probePeephole();
let o1bChecks = 0;
const o1bFailures = [];
let o1bStatus = O1B_READY.ready
  ? 'ready'
  : `pending(${O1B_READY.reason};0 项 O1b 断言执行,旧断言不受影响)`;

if (O1B_READY.ready) {
  const firstLine = (r) => (r.stderr || '').split('\n')[0] ?? '';
  for (const prog of O1B_PROGS) {
    const f = path.join(TMP, 'o1b-' + prog.key + '.ming');
    fs.writeFileSync(f, prog.src, 'utf8');
    const on = {}, off = {};
    for (const leg of LEGS) {
      on[leg.key] = runO1(f, leg.args, ROOT, false);
      off[leg.key] = runO1(f, leg.args, ROOT, true);
    }
    const wantExit = prog.panic ? 101 : 0;
    // ① 两态 × 三腿:退出码符合(panic 程序恒 101)+ stats 存在(instr 断言用)
    for (const leg of LEGS) {
      for (const [label, r] of [['优化开', on[leg.key]], ['--no-opt', off[leg.key]]]) {
        o1bChecks++;
        if (r.exit !== wantExit) {
          o1bFailures.push(`O1b ${prog.name}[${leg.key}] ${label}: 退出码 ${r.exit} ≠ ${wantExit}(stderr 首=${firstLine(r).slice(0, 100)})`);
        }
      }
    }
    // ① 两态 × 三腿 stdout 归一化(此处程序无计时 token,直接逐字)一致
    o1bChecks++;
    const outs = [...LEGS.map((l) => on[l.key].stdout), ...LEGS.map((l) => off[l.key].stdout)];
    if (new Set(outs).size !== 1) {
      o1bFailures.push(`O1b ${prog.name}: 优化开/--no-opt × 三腿 stdout 不一致=${JSON.stringify(outs.map((o) => o.slice(0, 40)))}`);
    }
    if (prog.panic) {
      // ④ panic 值语句保留:stdout 必须为空 + 六腿 stderr 首行逐字且含期望码
      o1bChecks++;
      if (outs[0] !== '') o1bFailures.push(`O1b ${prog.name}: panic 前 stdout 非空 ${JSON.stringify(outs[0].slice(0, 60))}(窥孔吞掉了求值/panic 顺序)`);
      o1bChecks++;
      const firsts = [...LEGS.map((l) => firstLine(on[l.key])), ...LEGS.map((l) => firstLine(off[l.key]))];
      if (new Set(firsts).size !== 1 || !firsts[0].includes(prog.panic)) {
        o1bFailures.push(`O1b ${prog.name}: panic 首行不逐字/缺 ${prog.panic}(${JSON.stringify(firsts.map((s) => s.slice(0, 80)))})`);
      }
    } else {
      // 期望输出精确断言(防"两态一致但全错")
      o1bChecks++;
      if (outs[0] !== prog.expect) {
        o1bFailures.push(`O1b ${prog.name}: 输出与期望不符 got=${JSON.stringify(outs[0].slice(0, 60))} want=${JSON.stringify(prog.expect)}`);
      }
    }
    // ② instr 不增(优化开 vm-only ≤ --no-opt vm-only;instr 为编译期指标,两 VM 腿同值)
    const iOn = on['vm-only'].stats ? on['vm-only'].stats.instr : null;
    const iOff = off['vm-only'].stats ? off['vm-only'].stats.instr : null;
    o1bChecks++;
    if (typeof iOn !== 'number' || typeof iOff !== 'number') {
      o1bFailures.push(`O1b ${prog.name}: instr 缺失(优化开=${iOn}, --no-opt=${iOff})`);
    } else if (iOn > iOff) {
      o1bFailures.push(`O1b ${prog.name}: 窥孔增指令 instr 优化开=${iOn} > --no-opt=${iOff}`);
    }
    // ③ 窥孔有效性(至少两形态):纯值语句 / 全字面量 CONCAT opt instr 严格下降
    if (prog.effective) {
      o1bChecks++;
      if (!(typeof iOn === 'number' && typeof iOff === 'number' && iOn < iOff)) {
        o1bFailures.push(`O1b ${prog.name}: 窥孔未生效 instr 优化开=${iOn} 未严格小于 --no-opt=${iOff}`);
      }
    }
    // ⑤ 确定性:优化开默认腿再跑一次,stdout/panic 首行/instr 逐字节一致
    o1bChecks++;
    const again = runO1(f, [], ROOT, false);
    const sameOut = again.stdout === on['vm+wasm'].stdout;
    const sameFirst = firstLine(again) === firstLine(on['vm+wasm']);
    const sameInstr = again.stats && on['vm+wasm'].stats ? again.stats.instr === on['vm+wasm'].stats.instr : false;
    if (again.exit !== wantExit || !sameOut || !sameFirst || !sameInstr) {
      o1bFailures.push(`O1b ${prog.name}: 优化开默认腿两次运行不一致(确定性;exit=${again.exit} out=${sameOut} first=${sameFirst} instr=${sameInstr})`);
    }
  }
  o1bStatus = `ready(${O1B_READY.reason})`;
}

// ============================================================
// O1c 常量传播闸门(v0.96;Agent B3 维护,plan §4.16 O1c)
// ============================================================
// 程序集 = 8 个自建靶点(确定性输出;HEAD 6758123 纯净副本采集 golden 见
// docs/opt-baseline.md "O1c 常量传播前基线"),按裁决面分组:
//   有效性 cp1 链(let a=2; b=a+3)/cp2 深链(a*3+4-1 多级);
//   放弃锚 cp3 mut 重赋值 / cp4 闭包捕获 / cp5 形参(三形态两态 instr 必须相等——
//          "宁少勿错"硬锚:传播越过边界即 instr 不等);
//   值语义 cp6 Vec 常量 → let mut 深拷贝后 push × 3 次调用(变异隔离/重复执行)/
//          cp7 循环体内 let 每轮重绑定 / cp8 str 常量 + mut 拼接(不可变源不被改写);
//   附加 panic 保留锚:let z = 0; 1 / z —— 传播后 CONST 0 仍不得折叠,运行时 M4004。
// 断言:
//   ① 传播+下游折叠有效性:cp1/cp2 优化开 vm-only instr 严格 < --no-opt;
//   ② 放弃锚:cp3/cp4/cp5 两态 instr 相等(不得传播);
//   ③ 值语义(与 A3 裁决对齐):cp6/cp7/cp8 stdout 精确 + 重复执行/变异隔离正确;
//      标量-only 裁决下 cp6/cp8(容器/str 形态)额外断言两态 instr 相等,容器也传播
//      的裁决下由值语义断言接管(见 O1C_CONTAINER_PROP,已按 A3 P5 实测校准);
//   ④ 四腿 stdout 逐字:优化开/--no-opt × 三腿(tree/vm-only/vm+wasm)+ HEAD golden
//      (HEAD 6758123 实跑记录,8 程序 16 行)全同——HEAD 腿以采集时点 golden 落地
//      (当前 CLI 无法内嵌旧版二进制),防"两态一致但相对基线漂移";
//   ⑤ 确定性:优化开默认腿两次 stdout/instr 一致。
// 就绪判定三级(缺一 pending):(a) src/opt.js 含 constProp/常量传播/propagat 迹象;
//   (b) --no-opt/MING_NO_OPT 已注册(O1_NOOPT);(c) 行为探测 cp1 链 opt instr < no-opt。
//   未就绪 → 本节 0 项执行、退出码不因此失败;逐次重跑本脚本即轮询(A3 交付后自动转
//   硬断言)。
const O1C_PROGS = [
  {
    key: 'cp1-chain',
    name: 'cp1 链(有效性)',
    group: 'effective',
    src: [
      'fn main() with io {',
      '    let a = 2;',
      '    let b = a + 3;',
      '    print(str(b));',
      '}',
      '',
    ].join('\n'),
    expect: '5\n',
    headExpect: '5\n',
  },
  {
    key: 'cp2-deep',
    name: 'cp2 深链(有效性)',
    group: 'effective',
    src: [
      'fn main() with io {',
      '    let a = 2;',
      '    let b = a * 3;',
      '    let c = b + 4;',
      '    let d = c - 1;',
      '    print(str(d));',
      '}',
      '',
    ].join('\n'),
    expect: '9\n',
    headExpect: '9\n',
  },
  {
    key: 'cp3-mut',
    name: 'cp3 mut 重赋值(放弃锚)',
    group: 'anchor',
    src: [
      'fn main() with io {',
      '    let mut a = 2;',
      '    a = 7;',
      '    print(str(a + 3));',
      '}',
      '',
    ].join('\n'),
    expect: '10\n',
    headExpect: '10\n',
  },
  {
    key: 'cp4-capture',
    name: 'cp4 闭包捕获(放弃锚)',
    group: 'anchor',
    // 捕获发生在外层绑定 a 上,且外层另有可折叠读 a + 3:若捕获计划扫描失败、
    // 传播误入该槽,main 的 LD a 会变 CONST 并折掉 a+3 → instr 下降(锚可观测)。
    src: [
      'fn main() with io {',
      '    let a = 2;',
      '    let f = () => a;',
      '    print(str(a + 3));',
      '    print(str(f()));',
      '}',
      '',
    ].join('\n'),
    expect: '5\n2\n',
    headExpect: '5\n2\n',
  },
  {
    key: 'cp5-param',
    name: 'cp5 形参(放弃锚)',
    group: 'anchor',
    src: [
      'fn g(a: i64) -> i64 {',
      '    a + 3',
      '}',
      '',
      'fn main() with io {',
      '    print(str(g(2)));',
      '}',
      '',
    ].join('\n'),
    expect: '5\n',
    headExpect: '5\n',
  },
  {
    key: 'cp6-vec',
    name: 'cp6 Vec 常量值语义',
    group: 'value',
    container: true,
    src: [
      'fn mk() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let mut w = v;',
      '    w.push(4);',
      '    v.len() * 10 + w.len()',
      '}',
      '',
      'fn main() with io {',
      '    print(str(mk()));',
      '    print(str(mk()));',
      '    print(str(mk()));',
      '}',
      '',
    ].join('\n'),
    expect: '34\n34\n34\n',
    headExpect: '34\n34\n34\n',
  },
  {
    key: 'cp7-loop-let',
    name: 'cp7 循环 let 值语义',
    group: 'value',
    container: false,
    src: [
      'fn main() with io {',
      '    let mut i = 0;',
      '    while i < 3 {',
      '        let k = 4;',
      '        print(str(k * i));',
      '        i += 1;',
      '    }',
      '}',
      '',
    ].join('\n'),
    expect: '0\n4\n8\n',
    headExpect: '0\n4\n8\n',
  },
  {
    key: 'cp8-str',
    name: 'cp8 str 常量值语义',
    group: 'value',
    container: true,
    src: [
      'fn main() with io {',
      '    let s = "ab";',
      '    let mut t = s;',
      '    t += "cd";',
      '    print(s);',
      '    print(t);',
      '}',
      '',
    ].join('\n'),
    expect: 'ab\nabcd\n',
    headExpect: 'ab\nabcd\n',
  },
];

// A3 裁决(src/opt.js P5 constPropPass 实测校准,2026-11-20):false = 只传标量
// (类型白名单 int/float/bool/str;Vec/Map/tuple/struct/enum 的 ST 是真实深拷贝,
// 传播会让池对象被变异面改写 → 一律放弃)。cp6(Vec)/cp8(str 载体)两态 instr 必须
// 相等;若未来裁决翻转为容器也传播,置 true 后由值语义断言接管。
const O1C_CONTAINER_PROP = false;

function probeConstProp() {
  let src = '';
  try {
    src = fs.readFileSync(path.join(ROOT, 'src', 'opt.js'), 'utf8');
  } catch {
    return { ready: false, reason: 'src/opt.js 不可读' };
  }
  if (!/constProp|常量传播|propagat/i.test(src)) {
    return { ready: false, reason: 'src/opt.js 尚无 constProp 迹象(A3 未就绪)' };
  }
  if (!O1_NOOPT) return { ready: false, reason: '--no-opt/MING_NO_OPT 未注册(O1 未交付)' };
  // 行为探测:cp1 链在传播前两态 instr 相等(HEAD 基线 14/14),传播 + 下游折叠
  // 必须让优化态严格下降;仅源码迹象不足以防"已接线但未生效"。
  const probeFile = path.join(TMP, 'o1c-probe-chain.ming');
  fs.writeFileSync(probeFile, O1C_PROGS[0].src, 'utf8');
  const on = runO1(probeFile, ['--no-wasm'], ROOT, false);
  const off = runO1(probeFile, ['--no-wasm'], ROOT, true);
  const iOn = on.stats ? on.stats.instr : null;
  const iOff = off.stats ? off.stats.instr : null;
  if (on.ok && off.ok && typeof iOn === 'number' && typeof iOff === 'number' && iOn < iOff) {
    return { ready: true, reason: `行为探测 cp1 链 instr ${iOff}→${iOn}` };
  }
  return { ready: false, reason: `源码有 constProp 迹象但行为探测未见 instr 下降(opt=${iOn} no-opt=${iOff};A3 可能仍在编辑)` };
}

const O1C_READY = probeConstProp();
let o1cChecks = 0;
const o1cFailures = [];
let o1cStatus = O1C_READY.ready
  ? 'ready'
  : `pending(${O1C_READY.reason};0 项 O1c 断言执行,旧断言不受影响)`;

if (O1C_READY.ready) {
  const firstLine = (r) => (r.stderr || '').split('\n')[0] ?? '';
  for (const prog of O1C_PROGS) {
    const f = path.join(TMP, 'o1c-' + prog.key + '.ming');
    fs.writeFileSync(f, prog.src, 'utf8');
    const on = {}, off = {};
    for (const leg of LEGS) {
      on[leg.key] = runO1(f, leg.args, ROOT, false);
      off[leg.key] = runO1(f, leg.args, ROOT, true);
    }
    // ① 两态 × 三腿:退出码 0(靶点均无 panic 面;panic 保留锚单列)
    for (const leg of LEGS) {
      for (const [label, r] of [['优化开', on[leg.key]], ['--no-opt', off[leg.key]]]) {
        o1cChecks++;
        if (r.exit !== 0) {
          o1cFailures.push(`O1c ${prog.name}[${leg.key}] ${label}: 退出码 ${r.exit} ≠ 0(stderr 首=${firstLine(r).slice(0, 100)})`);
        }
      }
    }
    // ② 四腿逐字:优化开 × 三腿 + --no-opt × 三腿 + HEAD golden 全同
    o1cChecks++;
    const outs = [...LEGS.map((l) => on[l.key].stdout), ...LEGS.map((l) => off[l.key].stdout)];
    const four = new Set([...outs, prog.headExpect]);
    if (four.size !== 1) {
      o1cFailures.push(`O1c ${prog.name}: 四腿 stdout 不一致(含 HEAD golden)=${JSON.stringify([...four].map((o) => o.slice(0, 40)))}`);
    }
    // ③ 期望输出精确(防"所有腿一致但全错")
    o1cChecks++;
    if (outs[0] !== prog.expect) {
      o1cFailures.push(`O1c ${prog.name}: 输出与期望不符 got=${JSON.stringify(outs[0].slice(0, 60))} want=${JSON.stringify(prog.expect)}`);
    }
    // ④ 裁决面:有效性严格下降 / 放弃锚两态相等 / 值语义不增 + 标量-only 相等
    const iOn = on['vm-only'].stats ? on['vm-only'].stats.instr : null;
    const iOff = off['vm-only'].stats ? off['vm-only'].stats.instr : null;
    o1cChecks++;
    if (typeof iOn !== 'number' || typeof iOff !== 'number') {
      o1cFailures.push(`O1c ${prog.name}: instr 缺失(优化开=${iOn}, --no-opt=${iOff})`);
    } else if (prog.group === 'effective') {
      if (!(iOn < iOff)) o1cFailures.push(`O1c ${prog.name}: 传播+折叠未生效 instr 优化开=${iOn} 未严格小于 --no-opt=${iOff}`);
    } else if (prog.group === 'anchor') {
      if (iOn !== iOff) o1cFailures.push(`O1c ${prog.name}: 放弃锚被传播越过 instr 优化开=${iOn} ≠ --no-opt=${iOff}(mut/捕获/形参必须放弃)`);
    } else {
      if (iOn > iOff) o1cFailures.push(`O1c ${prog.name}: 常量传播增指令 instr 优化开=${iOn} > --no-opt=${iOff}`);
      else if (!O1C_CONTAINER_PROP && prog.container && iOn !== iOff) {
        o1cFailures.push(`O1c ${prog.name}: 标量-only 裁决下容器/str 形态两态 instr 应相等(开=${iOn} 关=${iOff})`);
      }
    }
    // ⑤ 确定性:优化开默认腿再跑一次,stdout/instr 逐字节一致
    o1cChecks++;
    const again = runO1(f, [], ROOT, false);
    const sameOut = again.stdout === on['vm+wasm'].stdout;
    const sameInstr = again.stats && on['vm+wasm'].stats ? again.stats.instr === on['vm+wasm'].stats.instr : false;
    if (again.exit !== 0 || !sameOut || !sameInstr) {
      o1cFailures.push(`O1c ${prog.name}: 优化开默认腿两次运行不一致(确定性;exit=${again.exit} out=${sameOut} instr=${sameInstr})`);
    }
  }
  // 附加 panic 保留锚:传播把 LD z 换成 CONST 0 后,折叠不得吃掉除零 panic
  const panicFile = path.join(TMP, 'o1c-panic-propagated-div.ming');
  fs.writeFileSync(panicFile, 'fn main() with io {\n    let z = 0;\n    print(str(1 / z));\n}\n', 'utf8');
  const pa = runO1(panicFile, [], ROOT, false);
  const pb = runO1(panicFile, [], ROOT, true);
  o1cChecks++;
  if (pa.exit !== 101 || pa.stdout !== '') {
    o1cFailures.push(`O1c panic 保留:优化开期望 exit 101 + 空 stdout,got exit=${pa.exit} stdout=${JSON.stringify(pa.stdout.slice(0, 40))}`);
  }
  o1cChecks++;
  if (pb.exit !== 101 || pb.stdout !== '') {
    o1cFailures.push(`O1c panic 保留:--no-opt 期望 exit 101 + 空 stdout,got exit=${pb.exit} stdout=${JSON.stringify(pb.stdout.slice(0, 40))}`);
  }
  o1cChecks++;
  const fa = firstLine(pa), fb = firstLine(pb);
  if (fa === '' || fa !== fb || !fa.includes('M4004')) {
    o1cFailures.push(`O1c panic 保留:首行不逐字或缺 M4004(开=${JSON.stringify(fa.slice(0, 100))} 关=${JSON.stringify(fb.slice(0, 100))})`);
  }
  o1cStatus = `ready(${O1C_READY.reason};裁决=${O1C_CONTAINER_PROP ? '容器/str 也传播(值语义断言接管)' : '标量-only(cp6/cp8 两态 instr 相等)'})`;
}


// ---------- 文档(--write-doc 时刷新 docs/opt-baseline.md) ----------
// O1 标记区保留(Agent B 维护:O1 优化前基线 + O1 后对照两节)。
// --write-doc 只重写生成区;标记区按"整行锚定"定位(标记必须是独立行——防文档其他
// 位置提及 marker 字样被误匹配)、原样搬回;找不到则写入占位提示(可见,不静默)。
function preserveO1DocSection() {
  try {
    const cur = fs.readFileSync(DOC_PATH, 'utf8');
    const lines = cur.split('\n');
    const si = lines.findIndex((l) => l.startsWith('<!-- O1:BASELINE-START'));
    const ei = lines.findIndex((l) => l === '<!-- O1:BASELINE-END -->');
    if (si !== -1 && ei > si) return lines.slice(si, ei + 1).join('\n');
  } catch { /* 首次生成:doc 尚不存在 */ }
  return '<!-- O1:BASELINE-START(Agent B 维护区) -->\n(O1 区尚未生成——由 Agent B 交付:O1 优化前指令数基线 + O1 后对照两节)\n<!-- O1:BASELINE-END -->';
}
function fmtStat(v) { return v === null || v === undefined ? 'N/A' : String(v); }

function buildDoc() {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('# 优化基线(O0.3,plan §4.16)');
  lines.push('');
  lines.push('**优化前基线——未来 pass 的对照锚。**(采集于 v0.92 工作树;对本表程序零语义变化,审查 NOTE-3)');
  lines.push('');
  lines.push(`由 \`node tests/opt_gate.mjs --write-doc\` 机械生成(采集日期 ${date};手工编辑会被下次刷新覆盖——O1:BASELINE-START/O1:BASELINE-END HTML 注释标记区除外,刷新时原样保留)。`);
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
  if (O1_NOOPT) {
    lines.push(`O1 优化 pass 已落地(关闭形态 = \`${O1_NOOPT.label}\`),两态语义由 opt_gate O1 优化语义闸门锁定;`
      + '两态差值与"O1 优化前基线"的对照见下方 O1:BASELINE 标记区(--write-doc 刷新时原样保留)。');
  } else {
    lines.push('当前语言没有任何优化 pass,`--opt-off` 恒 default 行为(两态输出逐字相同)。'
      + '未来 O1 起的 pass 落地后,由 `tests/opt_gate.mjs` 在同批程序上跑 pass 开/关两态,'
      + '差值与本文件的"优化前基线"直接对照(接入点见 opt_gate.mjs OPT_OFF 消费点注释)。');
  }
  lines.push('');
  lines.push(preserveO1DocSection());
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
console.log(`O1 优化语义闸门: ${o1Status};${O1_NOOPT ? `${o1Checks} 项断言,失败 ${o1Failures.length}` : '0 项执行(逐次重跑本脚本即轮询)'}`);
console.log(`O1 修复回归锚(B1/M1/m2/m1): ${dStatus.join(';')};${dChecks} 项断言,失败 ${dFailures.length}`);
console.log(`O1b 通用窥孔闸门: ${o1bStatus};${O1B_READY.ready ? `${o1bChecks} 项断言,失败 ${o1bFailures.length}` : '0 项执行(逐次重跑本脚本即轮询)'}`);
console.log(`O1c 常量传播闸门: ${o1cStatus};${O1C_READY.ready ? `${o1cChecks} 项断言,失败 ${o1cFailures.length}` : '0 项执行(逐次重跑本脚本即轮询)'}`);
const allFailures = failures.concat(o1Failures, dFailures, o1bFailures, o1cFailures);
if (allFailures.length) {
  for (const f of allFailures) process.stderr.write(`✗ ${f}\n`);
  process.exitCode = 1;
} else if (O1_NOOPT) {
  console.log(`全部通过:三腿 stdout 逐字一致,期望输出符合,cc 腿(资格者)逐字一致;O1 两态(stdout/instr/panic 首行/确定性)断言全绿;B1/M1/m2/m1 修复回归锚全绿;O1b 通用窥孔闸门全绿(10 形态 × 两态 × 三腿 + panic 值语句 + 确定性);O1c ${O1C_READY.ready ? '常量传播闸门全绿(8 靶点 + panic 保留锚 × 两态 × 四腿 + 确定性)' : '节 pending(A3 未就绪)'}。`);
} else {
  console.log('全部通过:三腿 stdout 逐字一致,期望输出符合,cc 腿(资格者)逐字一致;O1/O1b/O1c 节 pending(旗标未就绪)。');
}
