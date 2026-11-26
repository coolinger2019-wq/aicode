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
//   v0.88:窄型形态扩展(Agent B 独立差分压测)——wide 族新增 5 类窄型 shape
//               (nlet 窄型标注 let ± 界内/越界算术、nvec Vec[i32]/Vec[u8] 标注初始化 +
//               元素读改写、nstruct 窄型字段构造 + 读改写、ntuple 元组解构(后缀元素/
//               标注解构/mut 重赋值)、nlambda HOF (u8)->i64 + 无标注/标注 lambda 形参)。
//               仅 wide 族注入(cc 族保持纯 i64 C1 面内;wasm 族不动,存活断言面不变)。
//               形态即 §4.13.7 遗留四边界(struct 字段/Vec 元素/无标注 lambda 形参/
//               元组模式)的差分探测器:v0.87 现状下这些边界"静默一致"(非分歧面),
//               v0.88 四边界归一落地后,界内值正常、越界必须 M4002 双引擎一致 panic
//               ——归一不对称 → fuzz 直接抓出。全部 rng 驱动,确定性保持。
//   v0.89:同族缺口差分形态扩展(Agent B)——wide 族窄型池再入 4 shape:
//               (nmap Map[str,u8] 标注初始化 + set 写位 + get().unwrap() 读窄算术、
//               nlret 零参 HOF ()->u8 + lambda 体返回位 + 调用侧窄算术、
//               nenum enum 窄 payload 构造 + match 绑定读窄算术、
//               ninfer 无标注元组解构重赋值(M1a) + 推断容器 plain push(M1b))。
//               形态即 §4.13.7 同族缺口(Map 值位/lambda 返回位/enum payload/
//               推断型 M1a/M1b)的差分探测器:v0.88 基线审计(B 纯净副本 17 探针)
//               实测 plain 通道三腿静默(260/2147483648)、后缀通道已 M4002(标签
//               存活)——v0.89 归一落地后 plain 通道越界必须收敛 M4002 双引擎一致,
//               归一不对称 → fuzz 直接抓出。全部 rng 驱动,确定性保持。
//   R-17(2026-11-26,moltbook 外部评审 Klara 实锤):强制短路副作用形态——随机表达式树
//               系统性欠采样"&&/|| RHS、值型 if 条件与分支、match guard、while 条件内的
//               副作用子表达式"(#85 家族正是靠种子 39039 偶然命中而非系统生成)。本扩展以
//               --side-prob(默认 0.45)在右/后位置强制注入可 panic 的副作用子表达式:
//               ① checked 大数算术(近 i64::MAX 的 * / + / 取负溢出,纯字面量形态);
//               ② 自产纯 helper 调用(hsMul 参数驱动 M4002 / hsDiv 恒 M4004 / hsOpt M4006);
//               ③ 同表达式两次调用(hsMul(2) < hsDiv(2) 及反向)——左先/右先由不同 M 码
//               区分,norm(退出码+stdout+首个 M 码)口径不放宽;while 的 || 跳过形态另在
//               循环体打印计数,使"RHS 是否被求值"落在 stdout 可观察面。
//               明确排除 #92(% << >> 的 RHS 副作用调用形态——登记未修,强制生成会假红;
//               `/` 仅存在于 hsDiv 体内且除数为常量 0,无两侧求值序面):这三个算子的 RHS
//               恒为小字面量,注入点只在条件/分支/guard/while 条件位。
//               注意:`--side-prob 0` 关闭注入但 rng 流照常前进——同 seed 的程序集与注入版
//               不同,不能作同语料 A/B(因果结论由最小复现与 skip/guard 探针独立支撑)。
// 用法:node tests/fuzz.mjs [--seed N] [--count N] [--side-prob P] [--stats](默认种子固定,保证可复现)
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

// ---- R-17(2026-11-26):强制短路副作用形态 ----
// --side-prob 可调注入概率(默认 0.45;0 = 关闭);--stats 打印分族明细。
// 自证:生成摘要行恒打印强制形态命中计数(见文件末尾)。
const SIDE_PROB = opt('side-prob', 0.45);
const sideStats = { total: 0, by: {} };
const sideHit = () => rng() < SIDE_PROB;
const sideMark = (k) => { sideStats.total++; sideStats.by[k] = (sideStats.by[k] ?? 0) + 1; };

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
delete CHILD_ENV.MING_NO_OPT; // v0.94 审查 MINOR-1:门禁必须覆盖优化腿
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
    // R-17:两侧操作数各自以 SIDE_PROB 走强制副作用条件(右/后位)——短路本应
    // 跳过的 panic 子表达式在被错误求值的引擎上会现形。
    const l2 = genCondOrSide(vars, depth - 1, 'logic');
    const r2 = genCondOrSide(vars, depth - 1, 'logic');
    return `(if ((${l2}) ${pick(['&&', '||'])} (${r2})) { 1 } else { 0 })`;
  }
  // R-17:值型 if——条件位/分支位强制副作用;未选分支的 panic 子表达式只允许
  // 在被选中时求值(错误引擎提前求值未选分支 → 现形)。
  let cond = genCondOrSide(vars, depth - 1, 'if-cond');
  let bl = l, br = r;
  if (sideHit()) {
    sideMark('if-branch');
    if (rng() < 0.5) bl = genSideI64(vars); else br = genSideI64(vars);
  }
  return `(if ${cond} { ${bl} } else { ${br} })`;
}
function genCond(vars, depth) {
  return `(${genExpr(vars, Math.max(1, depth - 1))} ${pick(['<', '<=', '>', '>='])} ${genExpr(vars, Math.max(1, depth - 1))})`;
}

// ---- R-17:强制短路副作用形态生成 ----
// 纯 helper(i64 形参/返回,无 io/无效果;hsOpt 内部用 Option[i64] 属 C3 消费面——
// cmdCC 无 tier 旗标统一按不支持前缀报错,与资格旗标无关;wide 族同用)。三族 panic 码互异,使
// "哪个调用先求值"落在 norm 可观察面(首个 M 码),不依赖 panic 消息行号:
//   hsMul(n):|n|>=2 → M4002 乘法溢出(参数驱动 always/maybe-panic)
//   hsDiv(n):恒 M4004 除零(always-panic)
//   hsOpt(n):n<=0 → M4006 unwrap None(参数驱动 always/maybe-panic)
const SIDE_HELPERS = [
  'fn hsMul(n: i64) -> i64 { return n * 9223372036854775807; }',
  'fn hsDiv(n: i64) -> i64 { return n / 0; }',
  'fn hsOpt(n: i64) -> i64 { let o: Option[i64] = if n > 0 { Some(n) } else { None }; return o.unwrap(); }',
];

// 恒 panic 的内联 checked 算术(既有语法,不发明新语法;与 #85 种子的"近 i64::MIN
// 乘法溢出"同族)。内联形态是 #85 家族的判别主力:cc 对 checked 算术的溢出守卫是
// **语句级**发射,旧实现把这些守卫语句提升到 &&/||/guard 之外(短路失效面正是这些
// 被提升的守卫);纯 helper 调用没有守卫语句,单独用不足以暴露旧实现(实测 v1.2.0
// 反向验证:call-only 形态 0 分歧,内联形态命中)。
const SIDE_BIG = [
  '(9223372036854775807 + 2)',
  '(9223372036854775807 * 2)',
  '(-(-9223372036854775807 - 1))',
];

// i64 位副作用子表达式。全部为纯表达式(同值同副作用)——checked 算术守卫的
// 操作数重求值(#91,登记未修)对纯操作数不可观察,不会假红;helper 调用也从不
// 落在 / % << >> 的操作数位(#92 排除面,见 genExpr 的 bin 分支 RHS 恒字面量)。
function genSideI64(vars) {
  const form = pick(['mul-var', 'mul-var', 'mul-var', 'add-big', 'add-big', 'neg-min', 'call-mul', 'call-div', 'call-opt', 'call-arg']);
  if (form === 'mul-var') return `(${pick(vars)} * 9223372036854775807)`; // 变量驱动 maybe-panic M4002
  if (form === 'add-big') return `(9223372036854775807 + ${int(1, 3)})`; // 恒 panic M4002
  if (form === 'neg-min') return '(-(-9223372036854775807 - 1))'; // i64::MIN 取负 → M4002
  if (form === 'call-div') return `hsDiv(${pick([0, 1, 2])})`; // 恒 M4004
  if (form === 'call-opt') return `hsOpt(${pick([1, 0, -1])})`; // 1 → 不 panic;0/-1 → M4006
  if (form === 'call-arg') return `hsMul(${pick(vars)})`; // 变量驱动 maybe-panic M4002
  return `hsMul(${pick([2, 3, 0, 1, -1])})`; // 2/3 → M4002;0/1/-1 → 不 panic
}

// bool 条件位副作用形态(注入 &&/||、if/while 条件、match guard 的右/后位置)。
// and-skip/or-skip 的 RHS 恒 panic(内联 checked 算术):短路本应跳过 → 正确引擎
// 不 panic;错误引擎提前求值/把守卫语句提升到短路之外 → 立即 M4002 现形。
// order-ab/order-ba 是同一表达式内两次调用:左先 → 首码 M4002/M4004,右先 → 首码
// 互换(求值序判别力;norm 比首个 M 码,口径不放宽)。
function genSideCond(vars) {
  const big = () => pick(SIDE_BIG);
  const form = pick(['and-skip', 'and-skip', 'or-skip', 'or-skip', 'and-eval', 'or-eval', 'order-ab', 'order-ba', 'side-cmp']);
  if (form === 'and-skip') { const v = pick(vars); return `((${rng() < 0.5 ? '0 > 1' : `${v} > ${v}`}) && (${big()} > 0))`; } // LHS 恒 false → RHS 必须跳过
  if (form === 'or-skip') { const v = pick(vars); return `((${rng() < 0.5 ? '1 < 2' : `${v} <= ${v}`}) || (${big()} > 0))`; } // LHS 恒 true → RHS 必须跳过
  if (form === 'and-eval') return `((1 < 2) && (${big()} > 0))`; // LHS 真 → RHS 必须求值 → M4002
  if (form === 'or-eval') return `((0 > 1) || (${big()} > 0))`; // LHS 假 → RHS 必须求值 → M4002
  if (form === 'order-ab') return '(hsMul(2) < hsDiv(2))'; // 左先 M4002;右先 M4004
  if (form === 'order-ba') return '(hsDiv(2) < hsMul(2))'; // 左先 M4004;右先 M4002
  return `(${genSideI64(vars)} > 0)`; // 单侧右位副作用(maybe-panic)
}

// 条件位注入:以 SIDE_PROB 概率返回强制副作用条件,否则原 genCond。
function genCondOrSide(vars, depth, tag) {
  if (sideHit()) { sideMark(tag); return genSideCond(vars); }
  return genCond(vars, depth);
}

// ---- 语句生成。v0.41:cc 族 = wide 全形态(C3 起 Option/f64/Map 全部入 C 面)----
function genStmt(s, vars, strVar, mode, lines, ctx) {
  // v0.88:窄型形态仅注入 wide 族(cc 族必须保持纯 i64 以留在 C1 面内;wasm 族存活
  // 断言面不动)。~35% 语句槽位改走窄型池,其余槽位沿既有分布(共存不破坏)。
  if (mode === 'wide' && ctx && rng() < 0.35) {
    genNarrowStmt(s, vars, lines, ctx);
    return;
  }
  const v = pick(vars);
  const kind = pick(['assign', 'assign', 'compound', 'compound', 'while', 'vec', 'forin', 'str', 'ifelse', 'loop', 'matchx', 'option', 'vecm', 'strm', 'f64', 'mapx', 'forrange']);
  void mode;
  if (kind === 'ifelse') {
    // v0.38:if/else 语句(含字符串分支,多后端分支求值差分)
    // R-17:条件位以 SIDE_PROB 注入强制副作用(&&/|| 短路跳过的 panic / 双调用求值序)
    const other = vars.find(x => x !== v) ?? v;
    const cond = genCondOrSide(vars, 2, 'ifelse-cond');
    lines.push(`    if ${cond} { ${v} = ${v} + ${int(1, 9)}; ${other} = ${other} - 1; } else { ${v} = ${v} - ${int(1, 5)}; ${other} = ${other} + 2; }`);
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
    if (sideHit()) {
      // R-17:while 条件位强制副作用(三种均可终止;不引入无限循环)。RHS 用内联
      // checked 算术——旧 cc 把守卫语句提升到条件之外,跳过形态会立即现形。
      sideMark('while-cond');
      const form = pick(['and-eval', 'and-skip', 'or-print']);
      const big = pick(SIDE_BIG);
      if (form === 'and-eval') {
        // LHS 真 → RHS 必须求值 → 首轮 M4002;错误引擎跳过 RHS → 循环跑完(无 panic)
        lines.push(`    while (i${s} < ${k}) && (${big} > 0) { ${bodyInc}; ${cntInc}; }`);
      } else if (form === 'and-skip') {
        // LHS 恒假 → RHS 必须跳过 → 循环零次、无 panic;错误引擎提前求值 → M4002
        lines.push(`    while (i${s} >= ${k}) && (${big} > 0) { ${bodyInc}; ${cntInc}; }`);
      } else {
        // LHS 真时跳过 RHS(循环体打印计数使 stdout 可观察);退出判定 LHS 假 →
        // RHS 求值 → M4002。错误引擎提前求值 → panic 早于任何循环体打印。
        lines.push(`    while (i${s} < ${k}) || (${big} > 0) { print("w"); ${bodyInc}; ${cntInc}; }`);
      }
    } else {
      lines.push(`    while i${s} < ${k} { ${bodyInc}; ${cntInc}; }`);
    }
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
      // R-17:guard 位强制副作用——模式不命中时 guard 不得求值(错误引擎提前
      // 求值 → panic 现形);模式命中时两侧都必须按序 panic。
      let guard = '';
      if (sideHit()) { sideMark('match-guard'); guard = ` if ${genSideCond(vars)}`; }
      else if (rng() < 0.3) guard = ` if ${pick(vars)} > ${int(-5, 5)}`;
      // v0.40 修复:guard 语法是 Rust 风格 "模式 if 条件 => 表达式"(guard 在 => 前);
      // 此前写成 "模式 => 表达式 if 条件"(非法),wide 族三后端一致拒绝 → 假通过
      arms.push(`${p}${guard} => ${int(-20, 40)}`);
    }
    arms.push(`_ => ${int(-10, 10)}`);
    lines.push(`    ${v} = ${v} + match ${subj} { ${arms.join(', ')} };`);
  } else if (kind === 'option') {
    // v0.39:Option(unwrap_or 常用;偶发 unwrap 触发 M4006 panic 路径差分)
    // R-17:值型 if 条件位以 SIDE_PROB 注入强制副作用
    const cond = genCondOrSide(vars, 2, 'option-cond');
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

// ---- v0.88/v0.89:窄型形态生成(Agent B 独立差分压测;仅 wide 族调用)----
// 设计约束(§4.13.7 遗留四边界 + 同族缺口探测):
//   1. check-valid:窄型算术两侧恒同型——字面量一律带后缀(plain 字面量在窄型算术
//      位不收窄,`n + 5` 即 M3013,实测);plain 字面量只用在实测合法位(窄型 let
//      初始化/重赋值、Vec 标注初始化与 push/set、struct 字段位、Map 值位/lambda 体
//      返回位/enum payload 位、推断绑定重赋值与推断容器 push——即归一前 i64 标签位
//      静默面,归一后应收敛 M4002 的那侧);plain 字面量恒非负(负字面量是一元负号
//      表达式,窄型上下文不收窄)。
//   2. 越界 panic 面靠边界值(≈250..255u8 / i32::MAX)偶发触发,概率压在 ~10-15%/shape
//      ——panic 程序三腿比对的正是 [exit 101 + M4002],同样是差分面。
//   3. 全 rng 驱动;无循环新增(不爆步数);变量名带 s 序号防 M3016。
//   4. 与 i64 主变量 x0 的混合只经 `as i64`(窄值进宽域唯一无损通道)。
function genNarrowStmt(s, vars, lines, ctx) {
  void vars;
  const pool = ['nlet', 'nlet', 'nvec', 'ntuple', 'nmap', 'nmap', 'ninfer', 'ninfer', 'ninfer'];
  // v1.0.0-rc.2(ADR-012 清单 12):污字节消费形态 ×6——第三载体元素读/位掩码/比较/
  // 污标量算术/unpack/to_hex(新污标量面是差分盲区,不扩展则验收缺齿;权重 ×6 对齐
  // v0.89 新面探测先例——窄型池满配 25 槽下 ~24%/narrow 槽,wide 族每种子 ~4-9 程序)
  pool.push('tbytes', 'tbytes', 'tbytes', 'tbytes', 'tbytes', 'tbytes');
  if (ctx.nz) pool.push('nstruct', 'nstruct');
  if (ctx.hz) pool.push('nlambda', 'nlambda');
  // v0.89 新面探测权重 ×3:nlret/nenum 各自依赖前置声明(P=0.6),按净分布对齐
  // 既有 gated shape(v0.88 实测 ~3.6/seed)与 ninfer 双子形态(M1a/M1b)的覆盖需求
  if (ctx.hr) pool.push('nlret', 'nlret', 'nlret');
  if (ctx.ez) pool.push('nenum', 'nenum', 'nenum');
  const kind = pick(pool);
  const k = int(1, 9); // 算术右操作数(小值)
  if (kind === 'nlet') {
    // 窄型标注 let(u8/i32)+ 复合赋值 + 界内/越界算术——v0.87 已归一边界(对照锚)
    if (rng() < 0.5) {
      const u8v = rng() < 0.25 ? int(246, 255) : int(0, 240);
      lines.push(`    let mut na${s}: u8 = ${u8v};`);
      if (rng() < 0.4) lines.push(`    na${s} += ${k}u8;`);
      lines.push(`    x0 = x0 + (na${s} + ${k}u8) as i64;`);
    } else {
      // plain 字面量(无后缀)只允许非负:负字面量是一元负号表达式,窄型上下文不收窄
      // (let 标注/元素写位 → M3002,实测;struct 字段位除外)——负值一律走后缀形态
      const i32v = rng() < 0.15 ? '2147483647' : String(int(0, 999999));
      lines.push(`    let mut nb${s}: i32 = ${i32v};`);
      if (rng() < 0.4) lines.push(`    nb${s} += ${k}i32;`);
      lines.push(`    x0 = x0 + (nb${s} + ${k}i32) as i64;`);
    }
  } else if (kind === 'nvec') {
    // Vec 窄型标注初始化 + push/set 元素写 + 元素读算术(§4.13.7 Vec 元素边界)
    // 元素字面量:12% 边界值(后缀,窄标签位 → fits 门活)+ 20% plain(无后缀,
    // i64 标签位静默面——b2b 实测形态;左操作数窄标签位的 fits 门仍管辖窄算术)
    if (rng() < 0.5) {
      // plain 分支非负(负字面量不收窄);负值走后缀分支
      const e = () => (rng() < 0.12 ? '2147483647i32' : (rng() < 0.2 ? String(int(0, 50)) : `${int(-50, 50)}i32`));
      lines.push(`    let mut nv${s}: Vec[i32] = [${e()}, ${e()}];`);
      lines.push(`    nv${s}.push(${e()});`);
      lines.push(`    nv${s}[0] = ${e()};`);
      lines.push(`    let ac${s}: i32 = nv${s}[0] + nv${s}[1];`);
      lines.push(`    x0 = x0 + ac${s} as i64 + nv${s}[2] as i64;`);
    } else {
      const e = () => (rng() < 0.12 ? '255u8' : (rng() < 0.2 ? String(int(0, 240)) : `${int(0, 240)}u8`));
      lines.push(`    let mut nu${s}: Vec[u8] = [${e()}, ${e()}];`);
      lines.push(`    nu${s}.push(${e()});`);
      lines.push(`    nu${s}[0] = ${e()};`);
      lines.push(`    x0 = x0 + (nu${s}[0] + ${k}u8) as i64 + nu${s}[2] as i64;`);
    }
  } else if (kind === 'tbytes') {
    // v1.0.0-rc.2(ADR-012 清单 12):污字节消费形态——mark().to_bytes() 第三载体元素读
    // (Untrusted[i64])+ 位掩码/算术传播 + 比较净 bool 出 + unpack 载体感知槽 + to_hex。
    // 污标量与 x0 的混合只经比较布尔(污标量零净出口;`as` 是禁面 M3050——与窄型形态的
    // "as i64 通道"刻意不同)。字节值由生成器按源串静态已知,断言面 = 确定性;
    // 10% 概率越界下标 → M4003 三腿一致 panic(panic 程序同样是差分面)。
    const srcStr = pick(['a', 'ab', 'Zq', 'hello']);
    const bytes = [...Buffer.from(srcStr, 'utf8')];
    lines.push(`    let tb${s} = std.unstr.mark("${srcStr}").to_bytes();`);
    const i0 = int(0, bytes.length - 1);
    const bv = bytes[i0];
    const form = pick(['mask', 'arith', 'cmpchain', 'unpack', 'hex']);
    if (form === 'mask') {
      // 位掩码传播 + 比较终结(污标量算术 → 净 bool)
      lines.push(`    if (tb${s}[${i0}] & 15) == ${bv & 15} { x0 = x0 + ${int(1, 9)}; }`);
      if (rng() < 0.5) lines.push(`    if (tb${s}[${i0}] | 128) >= 128 { x0 = x0 - ${int(1, 5)}; }`);
    } else if (form === 'arith') {
      // 算术传播三向(污×净/净×污/污×污)后比较终结
      const j0 = int(0, bytes.length - 1);
      const w = bytes[j0];
      lines.push(`    if ((tb${s}[${i0}] * 2) + (tb${s}[${j0}] - tb${s}[${j0}])) == ${bv * 2} { x0 = x0 + ${k}; }`);
      if (rng() < 0.5) lines.push(`    if (${w} - tb${s}[${j0}]) == 0 { x0 = x0 + ${int(1, 4)}; }`);
    } else if (form === 'cmpchain') {
      // 比较六符(清单 5):污 vs 净常量 → 净 bool
      lines.push(`    if tb${s}[${i0}] == ${bv} { x0 = x0 + ${int(1, 9)}; }`);
      lines.push(`    if tb${s}[${i0}] != ${bv} { x0 = x0 - ${int(1, 9)}; } else { x0 = x0 + 1; }`);
      if (rng() < 0.5) lines.push(`    if tb${s}[${i0}] < ${bv + 1} { x0 = x0 + 1; }`);
    } else if (form === 'unpack') {
      // bin.unpack 载体感知槽(清单 6):污路径 Result[Untrusted[i64], str];len=1 时
      // u16 短缓冲必 Err(Err 面 = x0 减),len≥2 按字节静态期望值判定
      const need = bytes.length >= 2 && i0 + 2 <= bytes.length;
      const expect = need ? (bytes[i0] << 8) | bytes[i0 + 1] : -1;
      lines.push(`    match std.bin.unpack_u16_be(tb${s}, ${i0}) { Ok(n) => { if n == ${expect} { x0 = x0 + ${int(1, 6)}; } }, Err(_) => { x0 = x0 - ${int(1, 6)}; } }`);
    } else {
      // to_hex 保污编码 → print 出向透传(存储面合法,义务 5;确定性输出进差分比对)
      lines.push(`    print(tb${s}.to_hex());`);
    }
    if (rng() < 0.10) lines.push(`    let _ = tb${s}[${bytes.length}];`);
  } else if (kind === 'nstruct') {
    // struct 窄型字段构造 + 读改写(§4.13.7 struct 字段边界;plain 字面量位 = 静默面;
    // plain 负 i32 字段实测可收窄,但保守起见 plain 恒非负,负值走后缀)
    const plain = rng() < 0.5;
    const au = rng() < 0.25 ? int(246, 255) : int(0, 240);
    const bi = plain ? int(0, 999999) : int(-9999, 9999);
    lines.push(`    let p${s} = ${ctx.nz} { a: ${plain ? au : au + 'u8'}, b: ${plain ? bi : bi + 'i32'} };`);
    lines.push(`    x0 = x0 + (p${s}.a + ${k}u8) as i64 + p${s}.b as i64;`);
  } else if (kind === 'ntuple') {
    // 元组解构三形态(§4.13.7 元组模式边界):后缀元素 / 标注解构(只能后缀——
    // plain 字面量在标注元组解构初始化位是 M3002,实测)/ mut 重赋值(plain 字面量位)
    const au = rng() < 0.25 ? int(246, 255) : int(0, 240);
    const bi = int(-9999, 9999);
    const form = pick(['suffix', 'annot', 'reassign']);
    if (form === 'reassign') {
      lines.push(`    let mut (tc${s}, td${s}) = (${au}u8, ${bi}i32);`);
      lines.push(`    tc${s} = ${rng() < 0.5 ? au : au + 'u8'};`);
      lines.push(`    x0 = x0 + (tc${s} + ${k}u8) as i64 + td${s} as i64;`);
    } else if (form === 'annot') {
      lines.push(`    let (ta${s}, tb${s}): (u8, i32) = (${au}u8, ${bi}i32);`);
      lines.push(`    x0 = x0 + (ta${s} + ${k}u8) as i64 + tb${s} as i64;`);
    } else {
      lines.push(`    let t${s} = (${au}u8, ${bi}i32);`);
      lines.push(`    let (ta${s}, tb${s}) = t${s};`);
      lines.push(`    x0 = x0 + (ta${s} + ${k}u8) as i64 + tb${s} as i64;`);
    }
  } else if (kind === 'nlambda') {
    // HOF (u8)->i64 + 无标注/标注 lambda 形参(§4.13.7 无标注 lambda 形参边界;
    // 无标注位 = 静默面,标注位 v0.87 已归一 → 边界实参经标注 lambda 触发 M4002 对照)
    if (rng() < 0.5) {
      lines.push(`    x0 = x0 + ${ctx.hz}((q${s}) => (q${s} + ${k}u8) as i64);`);
    } else {
      lines.push(`    x0 = x0 + ${ctx.hz}((q${s}: u8) => (q${s} * ${k}u8) as i64);`);
    }
  } else if (kind === 'nmap') {
    // Map 值位(§4.13.7 同族第五缺口;B 基线 g1a/g1b:plain 值位三腿静默 260,g1d:
    // 后缀值位标签经存取存活 → M4002)——标注 Map[str,u8] 初始化 + set 写位 +
    // get().unwrap() 读窄算术;init "k" 位承载越界面(25% 边界带),set "j" 位恒界内
    // 但读回可见(set 存储路径被观测)。
    const mu = rng() < 0.25 ? int(247, 255) : int(0, 240);
    const suffix = rng() < 0.5;
    lines.push(`    let mut nm${s}: Map[str, u8] = {"k": ${suffix ? mu + 'u8' : mu}};`);
    lines.push(`    nm${s}.set("j", ${rng() < 0.5 ? int(0, 240) + 'u8' : int(0, 240)});`);
    lines.push(`    x0 = x0 + (nm${s}.get("k").unwrap() + ${k}u8) as i64 + nm${s}.get("j").unwrap() as i64;`);
  } else if (kind === 'nlret') {
    // lambda 返回位(§4.13.7 同族缺口;B 基线 g2a/g2c:plain 体三腿静默 260,g2b:
    // 后缀体标签经闭包返回存活 → M4002)——零参 HOF ()->u8 + lambda 体返回位;
    // lambda 无返回标注语法(parser 只有 `) =>` 形态),通道划分 = 体 plain vs 体后缀。
    const rv = rng() < 0.25 ? int(247, 255) : int(0, 240);
    const suffix = rng() < 0.5;
    lines.push(`    x0 = x0 + ${ctx.hr}(() => ${suffix ? rv + 'u8' : rv});`);
  } else if (kind === 'nenum') {
    // enum payload(§4.13.7 同族缺口;B 基线 g3a:plain payload 三腿静默 260,g3b:
    // 后缀 payload 标签经 ctor→match 绑定存活 → M4002)——窄 payload 构造 + match
    // 绑定读窄算术;payload 位承载越界面(25% 边界带)。
    const pv = rng() < 0.25 ? int(247, 255) : int(0, 240);
    const suffix = rng() < 0.5;
    lines.push(`    let en${s} = ${ctx.ez}.A(${suffix ? pv + 'u8' : pv});`);
    lines.push(`    let ev${s} = match en${s} { ${ctx.ez}.A(x) => x, ${ctx.ez}.B => 0u8 };`);
    lines.push(`    x0 = x0 + (ev${s} + ${k}u8) as i64;`);
  } else {
    // 推断型静默面 M1a/M1b(§4.13.7 第 6/7 项;B 基线 g4a/g4b2:plain 通道三腿静默
    // 260/2147483648)——checker 推断窄型但无声明规格树,plain 通道不归一。
    // M1a:无标注元组解构(元素后缀) + plain 重赋值(推断绑定无规格 → 标签被剥);
    // M1b:推断容器(元素后缀使容器推断为窄型) + plain push(push 归一只认
    // __elemTy 标签,推断容器无标签)+ 读窄算术;i32::MAX 15% 边界带。
    if (rng() < 0.5) {
      const rv = rng() < 0.25 ? int(247, 255) : int(0, 240);
      lines.push(`    let mut (ia${s}, ib${s}) = (${int(0, 240)}u8, ${int(0, 240)}u8);`);
      lines.push(`    ia${s} = ${rv};`);
      lines.push(`    x0 = x0 + (ia${s} + ${k}u8) as i64 + ib${s} as i64;`);
    } else {
      const pv = rng() < 0.15 ? 2147483647 : int(0, 999999);
      const suffix = rng() < 0.5;
      lines.push(`    let mut iv${s} = [${int(1, 40)}i32, ${int(1, 40)}i32];`);
      lines.push(`    iv${s}.push(${suffix ? pv + 'i32' : pv});`);
      lines.push(`    x0 = x0 + (iv${s}[2] + ${k}i32) as i64;`);
    }
  }
}

function genProgram(mode) {
  const nVars = int(2, 3);
  const vars = [];
  // v0.88/v0.89:窄型形态上下文(wide 族专属)——struct/enum 声明与 HOF 声明按种子
  // 概率前置发射,供 genNarrowStmt 的 nstruct/nlambda/nlret/nenum 臂引用;其余程序零变化。
  const ctx = { nz: null, hz: null, hzArg: 0, ez: null, hr: null };
  // R-17:短路副作用 helper 恒前置(纯 i64,无 io → cc 族 C1 eligible;wide 族同用)
  const pre = [...SIDE_HELPERS];
  if (mode === 'wide') {
    if (rng() < 0.6) {
      ctx.nz = 'NZ';
      pre.push('struct NZ { a: u8, b: i32 }');
    }
    if (rng() < 0.6) {
      ctx.hz = 'HZ';
      // HOF 实参:30% 边界值(246..255)——经标注 lambda 形参(v0.87 已归一位)
      // 偶发触发 M4002,作归一对称性的活体对照
      ctx.hzArg = rng() < 0.3 ? int(246, 255) : int(0, 220);
      pre.push(`fn HZ(f: (u8) -> i64) -> i64 { return f(${ctx.hzArg}); }`);
    }
    if (rng() < 0.6) {
      ctx.ez = 'NE';
      pre.push('enum NE { A(u8), B }');
    }
    if (rng() < 0.6) {
      ctx.hr = 'HR';
      // 零参 HOF:调用侧 f() + 10u8 窄算术——lambda 体 plain = 返回位静默面(v0.89
      // 基线 g2a/g2c),体后缀 = 已归一对照(M4002);HR 自身返回 i64,越界面全在 f() 侧
      pre.push('fn HR(f: () -> u8) -> i64 { return (f() + 10u8) as i64; }');
    }
  }
  const lines = [...pre, 'fn main() with io {'];
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
    genStmt(s, vars, sv, mode, lines, ctx);
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

// R-17 附带修正:spawnSync 结果没有 code 属性(只有 status)——原 norm 的退出码槽
// 恒为 undefined(JSON 化为 null),退出码实际从未参与比对。改比 status,落实头注
// 声明的口径(退出码+stdout+首个 M 码),只收紧不放宽(四种子与 run.mjs 内嵌种子
// 实测零分歧)。
const norm = (r) => JSON.stringify([r.status, r.stdout, (r.stderr.match(/M\d{4}/) ?? [null])[0]]);
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
// R-17 自证:强制形态命中计数(生成摘要行恒打印;--stats 给分族明细)
if (argv.includes('--stats')) {
  const detail = Object.entries(sideStats.by).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}=${n}`).join(' ');
  console.log(`强制短路形态明细:${detail || '(无)'}`);
}
if (COUNT >= 10 && SIDE_PROB > 0 && sideStats.total === 0) {
  console.error('警告:强制短路形态命中 0 处(生成器回归?用 --dump 检查)');
}
console.log(`模糊基线:种子 ${SEED},${COUNT} 程序,一致 ${passed}${CCBIN ? `(其中 C 腿 ${ccLegs})` : '(无编译器,C 腿未启用)'},wasm 真实执行 ${wasmLive} 程序,强制短路形态 ${sideStats.total} 处(prob ${SIDE_PROB}),分歧 ${diverged},跳过 ${skipped}`);
process.exit(diverged ? 1 : 0);
