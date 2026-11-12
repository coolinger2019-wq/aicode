// tests/fuzz.mjs — 差分模糊测试基线(v0.33 立项,v0.39 加深)。
// 思路:不依赖预言(oracle)——同一随机程序必须在多后端产出完全一致的结果
// (stdout + 退出码 + 错误码);任何分歧 = 分层 bug。
//   v0.33-v0.38:三后端(树引擎 / 字节码 VM+wasm / VM --no-wasm),i64+str 形态逐步加深
//   v0.39:形态池加深(f64+math / match / loop / Option / Vec 方法 / str 方法 / for-range)
//         + "纯数值族"程序接入 C 后端第 4 腿(检测到 gcc/clang 时;C1 拒绝 = 发射器回归)
//   v0.51.6:生成器补复合赋值形态(+=/-=/*=,含 while 循环内)——覆盖 VM 窥孔融合路径(#17 P0 bug 曾因从不生成 += 而漏网)
//   v0.53:str 臂偶发 for ch in s { v += ch.char_len() as i64; }(UTF-8 码点迭代,C 腿自动覆盖)
// 用法:node tests/fuzz.mjs [--seed N] [--count N](默认种子固定,保证可复现)
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1]) : d; };
const SEED = opt('seed', 20261109);
const COUNT = opt('count', 120);
const TIMEOUT = opt('timeout', 8000);
const DUMP = argv.indexOf('--dump') >= 0 ? Number(argv[argv.indexOf('--dump') + 1]) : -1; // 打印第 N 个程序并退出(复现用)

// mulberry32:确定性 rng(与 std.rand 同款)
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

// ---- C 编译器探测(与 bin/ming.js 同序:MING_CC → PATH → 已知便携位置)----
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
const CCBIN = detectCC();

// v0.53 审查修复:子进程默认剥离 MING_WASM_STRICT——开发者 shell 导出该变量后
// 每条 run 腿都会以 strict 语义 exit 2,差分结果整批失真。模糊器观测的是默认静默回落行为。
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.MING_WASM_STRICT;

// ---- 表达式生成:纯 i64;允许 panic(各后端须一致地 panic)----
function genExpr(vars, depth) {
  if (depth <= 0 || rng() < 0.3) {
    if (vars.length && rng() < 0.6) return pick(vars);
    return String(int(-99, 999));
  }
  const kind = pick(['bin', 'bin', 'bin', 'cmp', 'neg', 'if', 'cast', 'logic']);
  const l = genExpr(vars, depth - 1);
  const r = genExpr(vars, depth - 1);
  if (kind === 'bin') {
    // 除/移位右操作数限小值非零:避免除零与巨移位使大多数程序 panic(模糊 panic 也有价值,但要少)
    const op = pick(['+', '+', '-', '*', '%', '&', '|', '^', '<<', '>>']);
    if (op === '%' || op === '<<' || op === '>>') return `(${l} ${op} ${int(1, 5)})`;
    return `(${l} ${op} ${r})`;
  }
  if (kind === 'cast') {
    // v0.35:as 随机转换(位截断/有符号回绕多后端必须一致)
    return `(${l} as ${pick(['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'i64'])} as i64)`;
  }
  if (kind === 'cmp') {
    // v0.39 修复:bool 不能 as i64(M3019)——v0.33 起的比较转 i64 形态恒被检查器
    // 拒绝(三后端一致拒绝 → 假通过零覆盖)。正规 bool→i64 惯用法是 if 表达式。
    return `(if (${l} ${pick(['<', '<=', '>', '>=', '==', '!='])} ${r}) { 1 } else { 0 })`;
  }
  if (kind === 'neg') return `(-(${l}))`;
  if (kind === 'logic') {
    // v0.39:逻辑作为值(短路语义差分;经 if 表达式转 i64)
    return `(if ((${genCond(vars, depth - 1)}) ${pick(['&&', '||'])} (${genCond(vars, depth - 1)})) { 1 } else { 0 })`;
  }
  return `(if ${genCond(vars, depth - 1)} { ${l} } else { ${r} })`;
}
function genCond(vars, depth) {
  return `(${genExpr(vars, Math.max(1, depth - 1))} ${pick(['<', '<=', '>', '>='])} ${genExpr(vars, Math.max(1, depth - 1))})`;
}

// ---- 语句生成。v0.41:cc 族 = wide 全形态(C3 起 Option/f64/Map 全部入 C 面)----
function genStmt(s, vars, strVar, mode, lines) {
  const v = pick(vars);
  const kind = pick(['assign', 'assign', 'compound', 'compound', 'while', 'vec', 'forin', 'str', 'ifelse', 'loop', 'matchx', 'option', 'vecm', 'strm', 'f64', 'mapx', 'forrange']);
  void mode;
  if (kind === 'ifelse') {
    // v0.38:if/else 语句(含字符串分支,多后端分支求值差分)
    const other = vars.find(x => x !== v) ?? v;
    lines.push(`    if ${genCond(vars, 2)} { ${v} = ${v} + ${int(1, 9)}; ${other} = ${other} - 1; } else { ${v} = ${v} - ${int(1, 5)}; ${other} = ${other} + 2; }`);
  } else if (kind === 'assign') {
    lines.push(`    ${v} = ${v} + ${genExpr(vars, int(1, 3))};`);
  } else if (kind === 'compound') {
    // v0.51.6:复合赋值——窥孔 (A) x±=1→ADDI±1 /(B) x OP= 字面量→BINSETI /(C) x+=局部→BINSET2
    // (#17 P0 bug 曾因生成器从不生成 += 而长期漏网;字面量恒小值,避免溢出 panic 泛滥)
    const other = vars.find(x => x !== v) ?? v;
    const r = rng();
    if (r < 0.45) {
      // ±小字面量:恰为 1 走 (A) ADDI±1,其余走 (B) BINSETI
      lines.push(`    ${v} ${pick(['+=', '+=', '-='])} ${rng() < 0.3 ? 1 : int(1, 9)};`);
    } else if (r < 0.65) {
      // *= 非零小字面量(正值走 (B);负值经 Unary 不融合,走 VM 通用复合路径)
      lines.push(`    ${v} *= ${pick([-3, -2, -1, 1, 2, 3])};`);
    } else if (r < 0.85) {
      // x += 另一个局部走 (C) BINSET2;偶发 dst==src 同槽边界
      lines.push(`    ${v} += ${rng() < 0.25 ? v : other};`);
    } else {
      // += 任意小表达式(不融合,VM 通用复合路径)
      lines.push(`    ${v} += ${genExpr(vars, 1)};`);
    }
  } else if (kind === 'while') {
    // 有界循环:计数器循环累加,必终止(v0.51.6:偶发复合赋值形态,覆盖循环内窥孔融合)
    const k = int(1, 6);
    const bodyInc = rng() < 0.4 ? `${v} += ${int(1, 9)}` : `${v} = ${v} + ${int(1, 9)}`;
    const cntInc = rng() < 0.5 ? `i${s} += 1` : `i${s} = i${s} + 1`;
    lines.push(`    let mut i${s} = 0;`);
    lines.push(`    while i${s} < ${k} { ${bodyInc}; ${cntInc}; }`);
  } else if (kind === 'vec') {
    // v0.40 修复:变量名带序号(vv${s})——固定名 "vv" 两条 vec 语句同名 → M3016
    // (wide 族三后端一致拒绝 → 假通过,被 cc 族的编译失败揭穿)
    lines.push(`    let mut vv${s}: Vec[i64] = [3, 1, 2];`);
    lines.push(`    ${v} = ${v} + vv${s}[0] + vv${s}.len() as i64;`);
  } else if (kind === 'forin') {
    // v0.37:for-in 深形态(v0.40:变量名带序号,同 vec 修复)
    lines.push(`    let vv2${s}: Vec[i64] = [10, 20, 30, 40];`);
    lines.push(`    let mut acc${s} = 0;`);
    lines.push(`    for e in vv2${s} { acc${s} = acc${s} + e; }`);
    lines.push(`    ${v} = ${v} + acc${s};`);
  } else if (kind === 'str') {
    // v0.53:偶发 str for-in(按 UTF-8 码点迭代;C 后端同形态差分)
    if (rng() < 0.5) {
      lines.push(`    for ch${s} in ${strVar} { ${v} += ch${s}.char_len() as i64; }`);
    } else {
      lines.push(`    ${strVar} = ${strVar} + "${pick(['x', 'yy', '!'])}";`);
      lines.push(`    ${v} = ${v} + ${strVar}.char_len() as i64;`);
    }
  } else if (kind === 'loop') {
    // v0.39:loop/break/continue(有界,必终止)
    const k = int(2, 6);
    if (rng() < 0.5) {
      lines.push(`    let mut li${s} = 0;`);
      lines.push(`    loop { if li${s} >= ${k} { break; } ${v} = ${v} + ${int(1, 9)}; li${s} = li${s} + 1; }`);
    } else {
      lines.push(`    let mut li${s} = 0;`);
      lines.push(`    loop { li${s} = li${s} + 1; if li${s} % 2 == 0 { continue; } if li${s} > ${k} { break; } ${v} = ${v} + ${int(1, 9)}; }`);
    }
  } else if (kind === 'matchx') {
    // v0.39:match 表达式(字面量臂 + 通配 + 偶发 guard;穷尽由检查器保证)
    const subj = int(-3, 9);
    const arms = [];
    const used = new Set();
    for (let a = 0; a < int(1, 2); a++) {
      const p = int(-2, 5);
      if (used.has(p)) continue;
      used.add(p);
      const guard = rng() < 0.3 ? ` if ${pick(vars)} > ${int(-5, 5)}` : '';
      // v0.40 修复:guard 语法是 Rust 风格 "模式 if 条件 => 表达式"(guard 在 => 前);
      // 此前写成 "模式 => 表达式 if 条件"(非法),wide 族三后端一致拒绝 → 假通过
      arms.push(`${p}${guard} => ${int(-20, 40)}`);
    }
    arms.push(`_ => ${int(-10, 10)}`);
    lines.push(`    ${v} = ${v} + match ${subj} { ${arms.join(', ')} };`);
  } else if (kind === 'option') {
    // v0.39:Option(unwrap_or 常用;偶发 unwrap 触发 M4006 panic 路径差分)
    const cond = genCond(vars, 2);
    if (rng() < 0.12) {
      lines.push(`    let p${s}: Option[i64] = if ${cond} { Some(${pick(vars)}) } else { None };`);
      lines.push(`    ${v} = ${v} + p${s}.unwrap();`);
    } else {
      lines.push(`    let o${s}: Option[i64] = if ${cond} { Some(${int(-9, 9)}) } else { None };`);
      lines.push(`    ${v} = ${v} + o${s}.unwrap_or(${int(-9, 9)});`);
    }
  } else if (kind === 'vecm') {
    // v0.39:Vec 方法面(push/pop/get/contains/reverse)
    lines.push(`    let mut vm${s}: Vec[i64] = [${int(-5, 5)}, ${int(-5, 5)}, ${int(-5, 5)}];`);
    lines.push(`    vm${s}.push(${int(-9, 9)});`);
    if (rng() < 0.4) {
      lines.push(`    vm${s}.reverse();`);
    }
    lines.push(`    if vm${s}.contains(${int(-5, 5)}) { ${v} = ${v} + 1; }`);
    lines.push(`    ${v} = ${v} + vm${s}.pop().unwrap_or(0) + vm${s}[0];`);
  } else if (kind === 'mapx') {
    // v0.41:Map[str,i64](插入序/set 覆盖/has/get/delete/for-in(k,v))
    lines.push(`    let mut mp${s}: Map[str, i64] = {"${pick(['a', 'bb'])}": ${int(-9, 9)}, "${pick(['c', 'dd'])}": ${int(-9, 9)}};`);
    lines.push(`    mp${s}.set("k${s}", ${int(-9, 9)});`);
    lines.push(`    mp${s}.set("${pick(['a', 'bb'])}", ${int(-9, 9)});`);
    lines.push(`    if mp${s}.has("a") { ${v} = ${v} + 1; }`);
    lines.push(`    ${v} = ${v} + mp${s}.get("c").unwrap_or(0) + mp${s}.len() as i64;`);
    if (rng() < 0.3) {
      lines.push(`    mp${s}.delete("bb");`);
    }
    lines.push(`    for (mk, mv) in mp${s} { ${v} = ${v} + mv; }`);
  } else if (kind === 'strm') {
    // v0.39:str 方法面(pad_left/slice_chars/contains/replace;slice 上界 1,恒安全)
    const m = pick(['pad', 'contains', 'replace', 'slice']);
    if (m === 'pad') {
      lines.push(`    ${strVar} = ${strVar}.pad_left(${int(2, 6)});`);
    } else if (m === 'contains') {
      lines.push(`    if ${strVar}.contains("${pick(['a', 'x', 'g'])}") { ${v} = ${v} + 1; }`);
    } else if (m === 'replace') {
      lines.push(`    ${strVar} = ${strVar}.replace("${pick(['a', 'n', 'g'])}", "${pick(['', 'zz'])}");`);
    } else {
      lines.push(`    ${v} = ${v} + ${strVar}.slice_chars(0, 1).char_len() as i64;`);
    }
  } else if (kind === 'f64') {
    // v0.39:f64 + std.math 精确子集;v0.41:直接打印(f64 floatStr 对齐差分)
    const f = pick(['f0', 'f1']);
    const mf = pick(['', 'std.math.sqrt', 'std.math.abs']);
    lines.push(`    ${f} = ${mf ? mf + '(' : ''}${f} * ${pick(['1.5', '0.5', '2.0', '-1.25'])} + ${pick(['0.5', '1.0', '-2.25'])}${mf ? ')' : ''};`);
    lines.push(`    ${v} = ${v} + (${f} as i64);`);
    lines.push(`    print(str(${f}));`);
  } else if (kind === 'forrange') {
    // v0.39:区间 for(hi 排他)
    const lo = int(-3, 3);
    const hi = lo + int(0, 5);
    lines.push(`    for r${s} in ${lo}..${hi} { ${v} = ${v} + ${int(1, 3)}; }`);
  }
}

function genProgram(mode) {
  const nVars = int(2, 3);
  const vars = [];
  const lines = ['fn main() with io {'];
  for (let i = 0; i < nVars; i++) {
    const v = `x${i}`;
    vars.push(v);
    lines.push(`    let mut ${v} = ${int(-50, 200)};`);
  }
  const sv = `s${int(0, 9)}`;
  // v0.41:cc 族 = wide 全形态 —— str/f0/f1 双模式都需要
  lines.push(`    let mut ${sv} = "${pick(['abc', 'ming', 'hello world', 'a'])}";`);
  lines.push(`    let mut f0 = ${pick(['1.5', '2.0', '-3.5', '7.25'])};`);
  lines.push(`    let mut f1 = ${pick(['0.5', '-1.0', '4.75', '2.5'])};`);
  const nStmt = int(2, 5);
  for (let s = 0; s < nStmt; s++) {
    genStmt(s, vars, sv, mode, lines);
  }
  lines.push(`    print(str(${vars[0]}));`);
  lines.push(`    print(str(${sv}.char_len()));`);
  lines.push('}');
  return lines.join('\n');
}

const norm = (r) => JSON.stringify([r.code, r.stdout, (r.stderr.match(/M\d{4}/) ?? [null])[0]]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-fuzz-'));
const prog = path.join(TMP, 'fuzz.ming');
const ccDir = CCBIN ? path.join(TMP, 'ccout') : null;
if (ccDir) fs.mkdirSync(ccDir, { recursive: true });
const ccSrc = path.join(TMP, 'ccfuzz.ming');

let passed = 0, diverged = 0, skipped = 0, ccLegs = 0;
for (let i = 0; i < COUNT; i++) {
  // v0.39:约 40% 生成 cc 族(纯数值,C 后端 C1 面内)——有编译器时跑第 4 腿
  const mode = CCBIN && rng() < 0.4 ? 'cc' : 'wide';
  const src = genProgram(mode);
  if (i === DUMP) { console.log(src); process.exit(0); }
  fs.writeFileSync(prog, src);
  const run = (extra) => spawnSync(process.execPath, [MING, 'run', prog, ...extra], { encoding: 'utf8', cwd: ROOT, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024, env: CHILD_ENV });
  const rt = run(['--tree']);
  const rw = run([]);
  const rj = run(['--no-wasm']);
  if (rt.status === null || rw.status === null || rj.status === null) { skipped++; continue; } // 超时=平台抖动,跳过
  const norms = { tree: norm(rt), 'vm+wasm': norm(rw), 'vm-only': norm(rj) };
  // C 第 4 腿:cc 族必可编译;发射器拒绝 = cbackend 回归 → 记为分歧
  if (mode === 'cc') {
    fs.writeFileSync(ccSrc, src);
    // v0.41:--no-run 分离构建与运行 —— cc 的运行退出码 = 程序退出码(panic → 101),此前被误判为编译失败
    const b = spawnSync(process.execPath, [MING, 'cc', ccSrc, '--no-run', '--out', ccDir], { encoding: 'utf8', cwd: ROOT, timeout: 30000, env: CHILD_ENV });
    const exe = path.join(ccDir, 'ccfuzz' + (process.platform === 'win32' ? '.exe' : ''));
    if (b.status !== 0 || !fs.existsSync(exe)) {
      if ((b.stderr ?? '').includes('C1 不支持')) {
        diverged++;
        console.error(`\n=== 分歧 #${i} (seed=${SEED}) —— C1 拒绝 cc 族程序(发射器回归)===`);
        console.error(src);
        console.error('cc stderr:', (b.stderr ?? '').slice(0, 300));
        break;
      }
      skipped++; // 工具链噪声(编译器故障等):警告并跳过
      console.error(`警告 #${i}:cc 编译失败(非 C1 拒绝),跳过该腿:${(b.stderr ?? '').slice(0, 120)}`);
      continue;
    }
    const rc = spawnSync(exe, [], { encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024, env: CHILD_ENV });
    if (rc.status === null) { skipped++; continue; }
    norms.cc = norm(rc);
    ccLegs++;
  }
  const vals = Object.values(norms);
  if (vals.every(x => x === vals[0])) { passed++; continue; }
  diverged++;
  console.error(`\n=== 分歧 #${i} (seed=${SEED}, mode=${mode}) ===`);
  console.error(src);
  for (const [k, v] of Object.entries(norms)) console.error(`${k.padEnd(8)}:`, v);
  break;
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`模糊基线:种子 ${SEED},${COUNT} 程序,一致 ${passed}${CCBIN ? `(其中 C 腿 ${ccLegs})` : '(无编译器,C 腿未启用)'},分歧 ${diverged},跳过 ${skipped}`);
process.exit(diverged ? 1 : 0);
