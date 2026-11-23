// proofsmt.js — Ming 证明义务 → SMT-LIB 2.0 文本编码(v1.1 首批 S-1,plan §4.21)。
//
// 职责:纯格式转换,零依赖、零 IO、无全局状态——同样的 VC 记录输入恒产出逐字节相同的脚本
//       (无时间戳、无绝对路径、无随机顺序;变量序 = 采集序,Map 插入序即遍历序)。
//       本模块不做任何求解或判定:每条义务两方向的内部判定结论(proven/refuted/unknown)
//       由 checker 以 src/prover.js 的 proveImplication 预先算好、随 VC 记录传入,
//       原样写入脚本注释;外部求解器对 (check-sat) 的回答由外部环境得出,与本模块无关。
//
// 选择本模块而非扩展 prover.js 的理由:prover.js 是"线性代数 + 差分约束求解"的判定后端
//       (纯函数,不做输出格式);SMT-LIB 文本是展示/导出层,判定与编码分离才能各自独立回归
//       (判定面由 §56/§57 锁定,编码面由 §113 锁定,互不牵连)。
//
// 编码面(如实声明,规范见 docs/proof-protocol.md):
//   - 理论 = QF_LIA(无量词线性整数算术):变量一律 Int;谓词只含 + - *(常量×变量)与
//     = < <= > >=;常量与系数为 BigInt 精确十进制,负数用一元 (- n)(SMT-LIB 数字字面量无符号)。
//   - 每个义务两方向(low:0 <= 索引 / high:索引 < len$x)各一个 (push)…(check-sat)(pop) 块:
//     断言 = 假设集(requires 线性叶子 + 范围 for 的循环区间约束)+ 取反后的方向目标;
//     取反后不可满足(unsat)= 该方向成立——与内部 proveImplication 的判定口径同构。
//   - 索引表达式不可线性化的义务(form 为 null)只留注释,不发射 check-sat(无可检目标,
//     也不在顶层遗留 assert 污染后续块)。
//   - 标识符与 SMT-LIB 保留字/内建符号冲突时整脚本统一重写(追加 _v,再撞顺延 _v2/_v3…),
//     重写为双射:同一名字全脚本恒同一符号,不重写恒原样(len$x / i$N 的 `$` 是 SMT-LIB
//     简单符号合法字符,无需改写)。
//
// VC 记录形状(checker.checkIndexBoundsStatically 采集;本模块不做防御性改名之外的加工):
//   { file, abs, fn, index, scope, line, col, idxText,
//     form: {coeffs: Map<名, BigInt>, c: BigInt} | null,   // 索引表达式线性形式
//     lenVar: string,                                      // 上界符号(len$x)
//     assumptions: [{lhs, op, rhs}...],                    // requires 线性叶子 + 循环区间约束
//     low: 'proven'|'refuted'|'unknown', high: 同 }        // 内部逐方向判定(不得虚构)

// SMT-LIB 保留字 + 内建排序/内建函数符号(简单符号禁用集;保守并集——
// 命中的 Ming 标识符一律重写,重写只影响脚本符号名,不影响义务语义)。
// 保留词取自官方规范 §3.1(BINARY DECIMAL HEXADECIMAL NUMERAL STRING _ ! as let exists
// forall match par;`!` 与 `match` 在 Ming 词法/关键字下不可作标识符,仍入列防漂移)。
export const SMT_RESERVED = new Set([
  // §3.1 预留词(不可作简单符号)
  'as', 'exists', 'forall', 'let', 'par', 'match', '!', '_', 'NUMERAL', 'DECIMAL', 'STRING', 'BINARY', 'HEXADECIMAL',
  // 布尔/排序内建
  'and', 'or', 'xor', 'not', 'ite', 'true', 'false', 'Int', 'Real', 'Bool',
  // 命令(declare/set/assert/check/交互族)
  'assert', 'check-sat', 'check-sat-assuming', 'declare-const', 'declare-datatype',
  'declare-datatypes', 'declare-fun', 'declare-sort', 'define-const', 'define-fun',
  'define-sort', 'echo', 'exit', 'get-assertions', 'get-assignment', 'get-info',
  'get-model', 'get-option', 'get-proof', 'get-unsat-assumptions', 'get-unsat-core',
  'get-value', 'pop', 'push', 'reset', 'reset-assertions', 'set-info', 'set-logic',
  'set-option', 'simplify', 'apply', 'expand',
  // Int/Real 理论内建函数符号(重定义即脚本非法)
  'div', 'divisible', 'abs', 'mod', 'rem', 'is_int', 'is_real', 'to_int', 'to_real',
  'plus', 'minus', 'times', 'distinct', 'map', 'forall', 'leq', 'geq', 'lt', 'gt', 'eq',
]);

// 整脚本双射重写:非保留字且不与已分配符号冲突 → 原样;否则追加 _v,再撞顺延 _v2/_v3…。
// names 按首次出现序(确定性);返回 Map<原名, SMT 符号>。
export function smtRenameAll(names) {
  const out = new Map();
  const taken = new Set();
  for (const n of names) {
    if (out.has(n)) continue;
    let s = SMT_RESERVED.has(n) ? n + '_v' : n;
    let k = 1;
    while (SMT_RESERVED.has(s) || taken.has(s)) { k += 1; s = n + '_v' + k; }
    taken.add(s);
    out.set(n, s);
  }
  return out;
}

// BigInt → SMT 整数字面量(负数用一元减;数字字面量本身无符号)。
function bigConst(v) { return v < 0n ? `(- ${-v})` : String(v); }

// 线性形式 → SMT 项。系数 0 不出现(prover.js 规范形);变量按 coeffs 插入序(采集序),
// 常数项最后;系数 ±1 省略乘法,其余常量×变量;全零形式渲染为 '0'。
export function smtLinear(f, ren) {
  const parts = [];
  for (const [k, cf] of f.coeffs) {
    const sym = ren.get(k) ?? k;
    if (cf === 1n) parts.push(sym);
    else if (cf === -1n) parts.push(`(- ${sym})`);
    else if (cf > 1n) parts.push(`(* ${cf} ${sym})`);
    else parts.push(`(* (- ${-cf}) ${sym})`);
  }
  if (f.c !== 0n) parts.push(bigConst(f.c));
  if (parts.length === 0) return '0';
  if (parts.length === 1) return parts[0];
  return `(+ ${parts.join(' ')})`;
}

// 约束 {lhs, op, rhs} → SMT 谓词项(不带 assert)。op 只允许线性五比较符(== 映射为 =);
// 表外 op 返回 null(防御:checker 采集面只产生这五种,表外说明上游违约,不得编造)。
export function smtPredicate(c, ren) {
  if (!c || !['==', '<', '<=', '>', '>='].includes(c.op)) return null;
  const op = c.op === '==' ? '=' : c.op;
  return `(${op} ${smtLinear(c.lhs, ren)} ${smtLinear(c.rhs, ren)})`;
}

// 内部判定 → 注释与期望结果文本(逐字面;不许把 unknown 说成 sat/unsat,
// 也不许把"无反例"说成"有反例"——refuted = 违反方向被内部判定强制,当假设集自身
// 不可满足时外部必答 unsat 而非 sat(差分编码可漏检 requires 矛盾),注记如实携带豁免口径)。
function verdictText(v) {
  if (v === 'proven') return 'proven(期望 unsat)';
  if (v === 'refuted') return 'refuted(内部判定违反方向被假设集强制;期望 sat——若外部 unsat,先核对假设集自身可满足性,见协议 §6.3)';
  return 'unknown(内部未判定;外部结论不设期望)';
}

// 一个方向块:注释 + (push)/declare/assert 假设/assert 取反目标/(check-sat)/(pop)。
// 变量 = 假设集 ∪ 方向目标中出现的名字(high 方向另含 lenVar),声明前置(块内)。
function renderDirection(vc, ren, dir, isHigh) {
  const lines = [];
  lines.push(`; 方向 ${dir} — ming 内部判定: ${verdictText(vc[dir])}`);
  const names = [];
  const seen = new Set();
  const addName = (n) => { if (!seen.has(n)) { seen.add(n); names.push(n); } };
  for (const a of vc.assumptions) {
    for (const k of a.lhs.coeffs.keys()) addName(k);
    for (const k of a.rhs.coeffs.keys()) addName(k);
  }
  for (const k of vc.form.coeffs.keys()) addName(k);
  if (isHigh) addName(vc.lenVar);
  lines.push('(push)');
  for (const n of names) lines.push(`(declare-const ${ren.get(n) ?? n} Int)`);
  for (const a of vc.assumptions) {
    const p = smtPredicate(a, ren);
    if (p !== null) lines.push(`(assert ${p})`);
  }
  // 取反目标:low = not (form >= 0);high = not (form < lenVar)。
  const goal = isHigh
    ? `(< ${smtLinear(vc.form, ren)} ${ren.get(vc.lenVar) ?? vc.lenVar})`
    : `(>= ${smtLinear(vc.form, ren)} 0)`;
  lines.push(`(assert (not ${goal}))`);
  lines.push('(check-sat)');
  lines.push('(pop)');
  return lines;
}

// 单个义务的脚本段(头注释;form 为 null 时只留说明注释,不发射任何命令)。
// 索引原文按源文切出,可含换行/缩进(跨行索引表达式是合法 Ming)——注释以 `;` 起行、
// 行尾终止,故空白一律折叠为单空格,防裸 token 行破坏脚本结构。
function renderObligation(vc, ren) {
  const idxText = String(vc.idxText).replace(/\s+/g, ' ').trim();
  const head = `; ---- vc:${vc.fn}:${vc.index} — 索引 ${idxText}(scope: ${vc.scope})----`;
  if (!vc.form) {
    return [head, '; 索引表达式不可线性化:义务目标未编码(内部未证明;无 (check-sat) 可发射)'];
  }
  return [
    head,
    ...renderDirection(vc, ren, 'low', false),
    ...renderDirection(vc, ren, 'high', true),
  ];
}

// VC 列表 → 完整 SMT-LIB 2.0 脚本(末尾换行)。文件按首次出现顺序分节注释;零义务输出
// "头 + 无义务注释 + (exit)"(诚实:空脚本不伪装成可检事实)。
export function renderProofScript(vcs) {
  const lines = ['(set-logic QF_LIA)', '(set-info :source "Ming 证明义务导出(QF_LIA 子集;规范见 docs/proof-protocol.md)")'];
  if (!vcs || vcs.length === 0) {
    lines.push('; 无证明义务');
    lines.push('(exit)');
    return lines.join('\n') + '\n';
  }
  // 第一遍:收集全部变量名(按出现序)→ 整脚本单次双射重写。
  const names = [];
  const seen = new Set();
  const addName = (n) => { if (n && !seen.has(n)) { seen.add(n); names.push(n); } };
  for (const vc of vcs) {
    if (!vc.form) continue; // 目标不可编码的义务不发射命令,名字不进入重写域
    for (const a of vc.assumptions) {
      for (const k of a.lhs.coeffs.keys()) addName(k);
      for (const k of a.rhs.coeffs.keys()) addName(k);
    }
    for (const k of vc.form.coeffs.keys()) addName(k);
    addName(vc.lenVar);
  }
  const ren = smtRenameAll(names);
  // 第二遍:渲染(文件分节按首次出现序;curFile 只在此遍使用)。
  let curFile = null;
  for (const vc of vcs) {
    if (vc.file !== curFile) {
      curFile = vc.file;
      lines.push('');
      lines.push(`; ===== 文件:${curFile} =====`);
    }
    lines.push(...renderObligation(vc, ren));
  }
  lines.push('');
  lines.push('(exit)');
  return lines.join('\n') + '\n';
}
