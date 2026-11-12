// tests/fuzz.mjs — 差分模糊测试基线(v0.33 立项,v0.39 加深)。
// 思路:不依赖预言(oracle)——同一随机程序必须在多后端产出完全一致的结果
// (stdout + 退出码 + 错误码);任何分歧 = 分层 bug。
//   v0.33-v0.38:三后端(树引擎 / 字节码 VM+wasm / VM --no-wasm),i64+str 形态逐步加深
//   v0.39:形态池加深(f64+math / match / loop / Option / Vec 方法 / str 方法 / for-range)
//         + "纯数值族"程序接入 C 后端第 4 腿(检测到 gcc/clang 时;C1 拒绝 = 发射器回归)
//   v0.51.6:生成器补复合赋值形态(+=/-=/*=,含 while 循环内)——覆盖 VM 窥孔融合路径(#17 P0 bug 曾因从不生成 += 而漏网)
//   v0.53:str 臂偶发 for ch in s { v += ch.char_len() as i64; }(UTF-8 码点迭代,C 腿自动覆盖)
//   v0.56(#25):新增 wasm eligible 族——纯 i64 helper(无 io/无效果)+ 带 io 的 main 调用它,
//               使 "VM+wasm" 腿真正执行 wasm(此前 main 恒带 io → main 永不 eligible,wasm 只在 VM 回落路径)。
//               每次 wasm 族另起默认引擎子进程(MING_WASM_DEBUG=1 --strict-wasm)断言
//               "[wasm] fn <helper> OK"、"[wasm 参数]"(实际调用)且无 REJECT/实例化失败。
//   v0.56(3d):helper 增首参 Vec[i64](wasm 仅支持 Vec 形参在首位),新增 for-in 体内
//               continue/break(F1)与 `%` 条件/while 内 `%` continue(F2)——两种形态修复前
//               分别会挂起/整模块回落,现均应真实经 wasm 执行。
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
// v0.56(#25):同样剥离 MING_WASM_DEBUG——调试输出只在 wasm 存活断言子进程显式注入。
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.MING_WASM_STRICT;
delete CHILD_ENV.MING_WASM_DEBUG;

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

// ---- v0.56(#25):wasm eligible 族 ----
// 纯 i64 helper(无 io/无效果;首参 Vec[i64],wasm 仅支持 Vec 形参在首位)+ 带 io 的 main
// 构造 Vec 并调用、打印结果。形态池限制在 wasm 发射器**已实测可编译且可正确执行**的集合:
//   数值运算(+ - * / % & | ^ << >>)、局部 let、复合赋值、语句 if/else-if、
//   while(含体内语句 if)、一元负号/负字面量(v0.56 W1 修复后恢复)、
//   循环体内 if 的 break/continue 与嵌套 while(v0.56 W2 修复后恢复)、
//   for-in 体内 if 的 continue/break + `%` 条件(v0.56 3d F1/F2 修复后恢复)。
// 实测剔除的形态(不修,仅记录;#25 要的是可编译族而不是扩大 wasm 面):
//   - as 转换:emitBody 直接 REJECT("表达式 As");
//   - if 表达式:plan §4.2.8 记录的已知回落形态(块类型索引);
//   - f64 + while / Vec / Map / str:plan §4.2.8 记录的其他回落形态
//     (f64 局部在既有 locals 声明索引偏移下无法安全记账,保持回落)。
// 参数与常量刻意取小值,所有程序必终止且不溢出(wasm 族也要参与三腿逐字比对)。
function genWasmStmt(s, lines) {
  const kind = pick(['arith', 'arith', 'compound', 'bit', 'if', 'while', 'whileif', 'neg', 'wbreak', 'wcontinue', 'wnest', 'wmod', 'forcont']);
  if (kind === 'arith') {
    const form = pick([
      `z = z + (a * ${int(1, 3)} - b);`,
      `z = (z - a) * ${int(1, 3)} + b;`,
      `z = z + (a + b * ${int(1, 3)});`,
      `z = z - (a - b) * ${int(1, 2)};`,
    ]);
    lines.push('    ' + form);
  } else if (kind === 'compound') {
    lines.push(`    z ${pick(['+=', '-='])} ${pick(['a', 'b'])};`);
    lines.push(`    z ${pick(['*= 2;', '*= 3;', '/= 3;', '/= 5;', '%= 97;'])}`);
  } else if (kind === 'bit') {
    lines.push(`    z = z ^ (a << ${int(1, 4)});`);
    lines.push(`    z = z | (b & ${int(3, 15)});`);
    if (rng() < 0.5) lines.push(`    z = z >> ${int(1, 3)};`);
  } else if (kind === 'if') {
    // v0.56 W1:负字面量阈值恢复(修复前 wasm 把 -c 编译成 c),两侧形态都生成
    const c = int(-10, 20);
    if (rng() < 0.4) {
      lines.push(`    if z > ${c} { z = z - ${int(1, 5)}; } else if z > ${int(-10, c)} { z = z + ${int(1, 5)}; } else { z = z + ${int(1, 5)}; }`);
    } else if (rng() < 0.3) {
      lines.push(`    if -${int(1, 9)} < z { z = z - ${int(1, 5)}; } else { z = z + ${int(1, 5)}; }`);
    } else {
      lines.push(`    if z > ${c} { z = z - ${int(1, 5)}; } else { z = z + ${int(1, 5)}; }`);
    }
  } else if (kind === 'neg') {
    // v0.56 W1:一元负号(此前 wasm 栈序反了 → 返回原值/负字面量比较失真;已修复)
    const form = pick([
      `z = z + (-a);`,
      `z = (-b) + z;`,
      `z = z - (-${int(1, 9)});`,
      `z = z + (-${int(1, 9)});`,
    ]);
    lines.push('    ' + form);
    lines.push(`    if z < -${int(1, 9)} { z = -z; }`);
  } else if (kind === 'while') {
    // 无 break/continue:while 体顶层语句发射正确
    lines.push(`    let mut w${s} = 0;`);
    lines.push(`    while w${s} < ${int(1, 4)} { z = z + (a % 3); z = z - ${int(0, 2)}; w${s} += 1; }`);
  } else if (kind === 'whileif') {
    lines.push(`    let mut w${s} = 0;`);
    lines.push(`    while w${s} < ${int(1, 3)} { if w${s} > 1 { z = z - ${int(1, 4)}; } else { z = z + ${int(1, 4)}; } z = z + b; w${s} += 1; }`);
  } else if (kind === 'wbreak') {
    // v0.56 W2:循环体内 if 中的 break(br 深度此前未计入 if 块 → 死循环;已修复)
    const k = int(2, 4);
    lines.push(`    let mut wb${s} = 0;`);
    lines.push(`    while wb${s} < ${k + int(1, 3)} { wb${s} += 1; if wb${s} == ${k} { break; } z = z + ${int(1, 4)}; }`);
    lines.push(`    z = z + wb${s};`);
  } else if (kind === 'wcontinue') {
    // v0.56 W2:循环体内 if 中的 continue(此前 br 只到 if 末尾,循环体剩余部分未跳过;已修复)
    const hi = int(4, 7);
    const k = int(2, hi - 1);
    lines.push(`    let mut wc${s} = 0;`);
    lines.push(`    while wc${s} < ${hi} { wc${s} += 1; if wc${s} == ${k} { continue; } z = z + ${int(1, 3)}; }`);
  } else if (kind === 'wnest') {
    // v0.56 W2:嵌套 while/if——内层 break 只跳出内层,外层继续
    const k = int(1, 3);
    lines.push(`    let mut wi${s} = 0;`);
    lines.push(`    while wi${s} < 3 { wi${s} += 1; if wi${s} == 2 { let mut wj${s} = 0; while wj${s} < ${k + 2} { if wj${s} >= ${k} { break; } wj${s} += 1; } z = z + wj${s}; } z = z + wi${s}; }`);
  } else if (kind === 'wmod') {
    // v0.56 3d F2:while 体内 `%` 条件 continue(修复前 inferNumType 非 + 二元推导
    // undefined → "条件操作数 undefined" 整模块回落;合并 Binary case 后应真实经 wasm)
    lines.push(`    let mut wm${s} = 0;`);
    lines.push(`    while wm${s} < ${int(4, 7)} { wm${s} += 1; if wm${s} % 2 == 0 { continue; } z = z + wm${s}; }`);
  } else if (kind === 'forcont') {
    // v0.56 3d F1:for-in(Vec 形参)体内 continue/break——条件含循环变量,同时覆盖 F2。
    // 修复前 continue 的 br 0 跳过循环尾 __i += 1 → 死循环;现应正常终止且三腿一致。
    const lim = int(2, 4);
    lines.push('    for e in vv {');
    lines.push(`      if e % 2 == 0 { continue; }`);
    lines.push(`      if e > ${lim} { break; }`);
    lines.push(`      z = z + e * ${int(1, 2)};`);
    lines.push('    }');
  }
}

function genWasmProgram() {
  const helper = 'wf';
  // v0.56 3d:Vec 形参必须在首位(wasm 导出/桥接对 Vec 句柄位置敏感;放后位模块校验失败)。
  const lines = [`fn ${helper}(vv: Vec[i64], a: i64, b: i64) -> i64 {`, '    let mut z = a + b;'];
  const n = int(3, 6);
  for (let s = 0; s < n; s++) genWasmStmt(s, lines);
  lines.push('    return z;');
  lines.push('}');
  // 两次调用:重复经 wasm 导出执行为一次程序,同时覆盖不同实参
  lines.push('fn main() with io {');
  const vecLit = (cnt) => '[' + Array.from({ length: cnt }, () => int(1, 6)).join(', ') + ']';
  lines.push(`    let v1 = ${vecLit(int(2, 5))};`);
  lines.push(`    let v2 = ${vecLit(int(2, 5))};`);
  lines.push(`    print(str(${helper}(v1, ${int(-9, 9)}, ${int(-9, 9)}) + ${helper}(v2, ${int(-9, 9)}, ${int(-9, 9)})));`);
  lines.push('}');
  return { src: lines.join('\n'), helper };
}

const norm = (r) => JSON.stringify([r.code, r.stdout, (r.stderr.match(/M\d{4}/) ?? [null])[0]]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-fuzz-'));
const prog = path.join(TMP, 'fuzz.ming');
const ccDir = CCBIN ? path.join(TMP, 'ccout') : null;
if (ccDir) fs.mkdirSync(ccDir, { recursive: true });
const ccSrc = path.join(TMP, 'ccfuzz.ming');

let passed = 0, diverged = 0, skipped = 0, ccLegs = 0, wasmLive = 0;
for (let i = 0; i < COUNT; i++) {
  // v0.56(#25):每轮先定族。首轮固定 wasm 族(COUNT>=1 必有真实 wasm 覆盖);
  // 其余约一半按种子决定 → "wasm 真实执行"计数随种子变化且可复现。
  const wasmFam = i === 0 || rng() < 0.5;
  let mode = null, src = null, helper = null;
  if (wasmFam) {
    const g = genWasmProgram();
    src = g.src;
    helper = g.helper;
    mode = 'wasm';
  } else {
    // v0.39:约 40% 生成 cc 族(纯数值,C 后端 C1 面内)——有编译器时跑第 4 腿
    mode = CCBIN && rng() < 0.4 ? 'cc' : 'wide';
    src = genProgram(mode);
  }
  if (i === DUMP) { console.log(src); process.exit(0); }
  fs.writeFileSync(prog, src);
  const run = (extra) => spawnSync(process.execPath, [MING, 'run', prog, ...extra], { encoding: 'utf8', cwd: ROOT, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024, env: CHILD_ENV });
  // v0.56(#25):eligible 族存活断言——默认引擎 + MING_WASM_DEBUG=1(--strict-wasm 把
  // 静默回落变成 exit 2)。必须看到 helper 编译 OK 且真正被调用([wasm 参数]);
  // 出现 REJECT/实例化失败即判分歧(生成器形态回退到不可编译集合)。
  if (wasmFam) {
    const dbg = spawnSync(process.execPath, [MING, 'run', prog, '--strict-wasm'], {
      encoding: 'utf8', cwd: ROOT, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024,
      env: { ...CHILD_ENV, MING_WASM_DEBUG: '1' },
    });
    const derr = dbg.stderr ?? '';
    const live = dbg.status === 0
      && derr.includes(`[wasm] fn ${helper} OK`)
      && derr.includes('[wasm 参数]')
      && !derr.includes('REJECT')
      && !derr.includes('实例化失败');
    if (!live) {
      diverged++;
      console.error(`\n=== 分歧 #${i} (seed=${SEED}, mode=wasm) —— wasm 存活断言失败 ===`);
      console.error(src);
      console.error('stderr:', derr.slice(0, 600));
      break;
    }
    wasmLive++;
  }
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
console.log(`模糊基线:种子 ${SEED},${COUNT} 程序,一致 ${passed}${CCBIN ? `(其中 C 腿 ${ccLegs})` : '(无编译器,C 腿未启用)'},wasm 真实执行 ${wasmLive} 程序,分歧 ${diverged},跳过 ${skipped}`);
process.exit(diverged ? 1 : 0);
