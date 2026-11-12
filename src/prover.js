// prover.js — Ming 静态证明器(QF_LIA 限定子集,v0.52 起)。
//
// 职责:线性形式代数 + 差分约束求解(Bellman-Ford,BigInt 权重,变量 ≤ 12)+ 蕴含判定。
//       纯函数模块:零依赖、不 import checker;AST 适配(表达式 → 线性形式)与诊断留在 checker。
//
// v0.52 阶段 1(v0.48 迁出 + 求解器新增):
//   - linFromInt / linAdd / linMulConst / linIsConst / linEvalAt:自 checker.js 原样迁出,
//     代数逐字不变(线性形式 {coeffs: Map<变量名, BigInt>, c: BigInt})。
//   - solveDiffConstraints / proveImplication:差分约束求解与蕴含判定(v0.48 无此能力)。
//     checker 的 M3042 叶判定已改为:常量差直接整数判定(与 v0.48 逐字等价),
//     非常量差经 proveImplication(本阶段假设集为空 → 与 v0.48 "非常量 → unknown" 严格一致)。
//
// v0.52 已交付:checker.js 的边界证明遍(checkIndexBoundsStatically,M3045/W3105)以本模块为求解后端 —
//   `x.len()` 引入 `len$x` 符号变量作为普通变量参与差分约束;requires 归一化为假设集
//   (只允许 == / < / <= / > / >=,!= / || / 非线性叶子跳过 = 不作为假设);索引义务 0 <= i 与
//   i < len$base 经 proveImplication(assumptions, goal) 两向判定;假设集 unsat(负环,含 cycle 证据)
//   = requires 自相矛盾 → 整函数跳过报告。反例枚举与诊断留在 checker(本模块只管证明判定)。
//
// 保守性合同(全模块):任何不可编码/超限/未证明的情况一律返回"不证明",
//       只会漏证(放弃判定),绝不会在不可证明时声称 proven —— 证明只报告,不改运行时语义。
//
// v0.55(QF_LIA 第三片):跨函数契约摘要 computeSummaries —— 纯数据接口,
//       AST 不透明(toLinear 由 checker 注入);调用图 Tarjan SCC 环检测 + 被调方优先拓扑序;
//       requires 不完整(含不可编码叶子)→ 摘要 ensures 不采用;环上函数标记 noSummary。
//       阶段 1 只建立摘要表;阶段 2 增加第三参 computePost:按拓扑序现算 post,证明时
//       可假设已证被调 ensures(调用后置条件注入),未提供时回退 fn.post。
//
// v0.57(QF_LIA 第四片):范围 for 的循环区间约束无需本模块改动 —— 循环变量符号 i$<n>
//       ('$' 非合法标识符字符,不撞名)与区间两条线性约束 lo <= i$<n> < hi 只是普通变量与
//       假设集条目,经 proveImplication 与既有 requires 假设合并求解;变量总数仍受
//       MAX_PROVER_VARS 上限保护(超限 → too-many-vars → checker 侧静默,只会漏证)。

// ===================== 线性形式代数(v0.48 原样迁出) =====================
// 线性形式:{ coeffs: Map<变量名, BigInt 系数>, c: BigInt 常数项 };系数 0 必须删除(规范形)。

export function linFromInt(n) { return { coeffs: new Map(), c: n }; }

export function linAdd(a, b, sign) {
  const out = { coeffs: new Map(a.coeffs), c: a.c + sign * b.c };
  for (const [k, v] of b.coeffs) {
    const nv = (out.coeffs.get(k) ?? 0n) + sign * v;
    if (nv === 0n) out.coeffs.delete(k); else out.coeffs.set(k, nv);
  }
  return out;
}

export function linMulConst(a, k) {
  const out = { coeffs: new Map(), c: a.c * k };
  for (const [kk, v] of a.coeffs) out.coeffs.set(kk, v * k);
  return out;
}

export function linIsConst(f) { return f.coeffs.size === 0; }

// 在候选参数值下求线性形式的具体值(用于反例)
export function linEvalAt(f, vals) {
  let v = f.c;
  for (const [k, cf] of f.coeffs) v += cf * (vals.get(k) ?? 0n);
  return v;
}

// ===================== 差分约束求解器 =====================

// 变量数上限:超出即放弃判定(静默,不报错)
export const MAX_PROVER_VARS = 12;

// 锚点节点键(代表常量 0):Ming 标识符不含 \u0000,不会与变量名冲突。
// 绝对约束(x <= c / x >= c)借助锚点改写为差分:x <= c ⟺ x - z <= c;x >= c ⟺ z - x <= -c。
// 差分约束系统平移不变:相对系统有解 ⟺ 把解平移使 z = 0 后满足全部绝对约束,
// 因此"含锚点边的相对系统不可满足 ⟺ 绝对语义不可满足",负环判定对两种读法一致。
const SRC = '\u0000src';

// {lhs, op, rhs} → `D <= c` 形式数组(D: 线性形式,c: BigInt;全 BigInt 整数语义)。
//   '<=' → [D <= 0];'<' → [D <= -1](a < b ⟺ a - b <= -1);'>=' / '>' 取反对称;
//   '==' 拆双向;'!=' 是析取,不可编码为差分约束 → 返回 null(保守跳过:只会漏证不会误证)。
function toLePairs(lhs, op, rhs) {
  const d = linAdd(lhs, rhs, -1n); // D = lhs - rhs
  switch (op) {
    case '<=': return [{ d, c: 0n }];
    case '<': return [{ d, c: -1n }];
    case '>=': return [{ d: linMulConst(d, -1n), c: 0n }];
    case '>': return [{ d: linMulConst(d, -1n), c: -1n }];
    case '==': return [{ d, c: 0n }, { d: linMulConst(d, -1n), c: 0n }];
    default: return null; // '!=' 等 → 不可编码
  }
}

// `D <= c`(D = 变量部分 + 常数 dc;即 Σcf·v <= K,c = K + dc)→ 边列表。
// 返回 'ok'(edges 已追加)| 'drop'(恒真,丢弃)| 'constFalse'(常量矛盾)| 'skip'(不可编码)。
// 可编码性:系数全为 ±1,且变量数 ≤ 2(2 变量时必须一正一负,即 x - y 形态):
//   0 变量:常量事实 dc <= c —— 成立丢弃;不成立 → 系统矛盾
//   1 变量:+1 → x <= K 边 SRC→x 权 K;-1 → -x <= K 边 x→SRC 权 K(⟺ x >= -K)
//   2 变量:+1/-1 各一 → x - y <= K 边 y→x 权 K(边 u→v 权 w 编码 d_v - d_u <= w)
// 系数非 ±1(如 2a)或同号双变量(如 a + b)不可编码 → 跳过(削弱系统只会漏证不会误证)。
function encodeLe(d, c, edges) {
  const K = c - d.c; // 变量部分右端常数
  const vars = [...d.coeffs.entries()];
  for (const [, cf] of vars) {
    if (cf !== 1n && cf !== -1n) return 'skip';
  }
  if (vars.length === 0) {
    return d.c <= c ? 'drop' : 'constFalse'; // 常量事实
  }
  if (vars.length === 1) {
    const [x, cf] = vars[0];
    if (cf === 1n) edges.push({ u: SRC, v: x, w: K }); // x - z <= K
    else edges.push({ u: x, v: SRC, w: K }); // -x - z <= K ⟺ x >= z - K
    return 'ok';
  }
  if (vars.length === 2) {
    const [a, b] = vars;
    if (a[1] === 1n && b[1] === -1n) edges.push({ u: b[0], v: a[0], w: K }); // x - y <= K
    else if (a[1] === -1n && b[1] === 1n) edges.push({ u: a[0], v: b[0], w: K });
    else return 'skip'; // 同号(如 x + y <= K)不可编码
    return 'ok';
  }
  return 'skip'; // ≥3 变量不可编码
}

// 差分约束求解(Bellman-Ford,BigInt 权重,变量 ≤ MAX_PROVER_VARS)。
// assumptions: [{lhs: 线性形式, op: '<='|'<'|'=='|'>='|'>', rhs: 线性形式}](绝对 BigInt 语义)
// 启动:全 0 初始化等价于虚节点源点到每个变量权 0(plan.md §4.2.3)—— 该虚节点只服务于
//       检测(不可达负环也能检出),不是约束系统的锚点;锚点是上面的 SRC(z)。
// 返回:
//   {kind:'sat'}                        —— 可满足(存在各变量赋值满足全部可编码约束)
//   {kind:'unsat', cycle: [变量名...]}  —— 不可满足(负环;cycle 为环上变量,锚点不入列;
//                                          常量事实矛盾时 cycle 为 [])
//   {kind:'too-many-vars'}              —— 变量总数超 MAX_PROVER_VARS(按全部约束的并集计,
//                                          含不可编码约束中的变量 —— 超限一律放弃,保守)
// 跳过不可编码约束(如系数 2a、a+b、!=)会削弱系统 → 可能漏证,绝不会误证(保守方向)。
export function solveDiffConstraints(assumptions) {
  // 变量收集(确定性:按首次出现序)
  const varNames = [];
  const seenVars = new Set();
  for (const a of assumptions) {
    for (const side of [a.lhs, a.rhs]) {
      for (const k of side.coeffs.keys()) {
        if (!seenVars.has(k)) { seenVars.add(k); varNames.push(k); }
      }
    }
  }
  if (varNames.length > MAX_PROVER_VARS) return { kind: "too-many-vars" };

  const nodes = [...varNames, SRC];
  const nodeIdx = new Map(nodes.map((nm, i) => [nm, i]));
  const edges = [];
  let constFalse = false;
  for (const a of assumptions) {
    const pairs = toLePairs(a.lhs, a.op, a.rhs);
    if (!pairs) continue; // '!=' 等不可编码 → 保守跳过
    for (const { d, c } of pairs) {
      if (encodeLe(d, c, edges) === 'constFalse') constFalse = true;
    }
  }
  if (constFalse) return { kind: 'unsat', cycle: [] }; // 常量事实矛盾(无变量负环)

  const n = nodes.length;
  // 全 0 初始化 Bellman-Ford:n 轮内收敛 ⟺ 无负环;第 n 轮仍可松弛 ⟺ 负环 → 不可满足。
  const dist = new Array(n).fill(0n);
  const pred = new Array(n).fill(-1); // 前驱节点下标(负环提取用)
  const relaxAll = () => {
    const updated = [];
    for (const e of edges) {
      const nd = dist[nodeIdx.get(e.u)] + e.w;
      const vi = nodeIdx.get(e.v);
      if (nd < dist[vi]) {
        dist[vi] = nd;
        pred[vi] = nodeIdx.get(e.u);
        updated.push(vi);
      }
    }
    return updated;
  };
  for (let iter = 0; iter < n - 1; iter++) {
    if (relaxAll().length === 0) break; // 本轮无松弛 → 已收敛,不可能有负环
  }
  // 终检轮:仍可松弛 → 负环 → 不可满足
  const updated = relaxAll();
  if (updated.length === 0) return { kind: 'sat' };

  // 负环提取(信息性,供阶段 2 M3045 反例参考):从终检轮被更新的节点沿前驱回退,
  // 首个重现节点即环入口;锚点 SRC 可能在环上但不入输出。
  // 防御:链条异常中断(理论不可达)→ 返回 [](unsat 判定不受影响)。
  const cycle = [];
  for (let t = updated.length - 1; t >= 0 && cycle.length === 0; t--) {
    const order = new Map();
    let x = updated[t];
    while (x >= 0 && pred[x] >= 0 && !order.has(x)) {
      order.set(x, order.size);
      x = pred[x];
    }
    if (x < 0 || !order.has(x)) continue; // 链条中断或未成环 → 换下一个起点
    const start = x;
    const ring = [start];
    let y = pred[start];
    while (y !== start && y >= 0 && ring.length <= n) {
      ring.push(y);
      y = pred[y];
    }
    if (y === start && ring.length <= n) {
      for (const ni of ring) {
        if (nodes[ni] !== SRC) cycle.push(nodes[ni]);
      }
      cycle.reverse(); // 沿前驱回退得到逆序,翻转为环的正向
    }
  }
  return { kind: 'unsat', cycle };
}

// ===================== 蕴含判定 =====================

// 判定 assumptions ⊨ goal 是否成立(供 checker M3042 叶判定与阶段 2 边界证明遍共用)。
// 方法:goal 取反并入假设,求解;不可满足(负环/常量矛盾)⇒ goal 成立。
// 取反规则(全 BigInt 整数语义):
//   a <= b → 并入 a >= b + 1;a < b → 并入 a >= b;
//   a != b → 取反是合取 a == b → 双向并入;a == b → 取反是析取,不可单次并入,
//            而 goal 本身是合取(a <= b 且 a >= b)→ 逐向递归证明;
//   a >= b / a > b:与 <= / < 对偶(交换两侧)。
// 返回:
//   {kind:'proven', cycle}  —— goal 在 assumptions 下成立(cycle 为不可满足性证据,信息性)
//   {kind:'not-proven'}     —— 不成立或无法判定(保守:不证明就不放行)
//   {kind:'too-many-vars'}  —— 变量超上限,放弃
export function proveImplication(assumptions, goal) {
  const verdict = (r) => {
    if (r.kind === 'unsat') return { kind: 'proven', cycle: r.cycle };
    if (r.kind === 'too-many-vars') return r;
    return { kind: 'not-proven' };
  };
  switch (goal.op) {
    case '==': {
      const r1 = proveImplication(assumptions, { lhs: goal.lhs, op: '<=', rhs: goal.rhs });
      if (r1.kind !== 'proven') return r1;
      const r2 = proveImplication(assumptions, { lhs: goal.lhs, op: '>=', rhs: goal.rhs });
      if (r2.kind !== 'proven') return r2;
      return { kind: 'proven', cycle: [] }; // 双向各自成立,无单一负环证据
    }
    case '!=': {
      return verdict(solveDiffConstraints([...assumptions,
        { lhs: goal.lhs, op: '<=', rhs: goal.rhs },
        { lhs: goal.lhs, op: '>=', rhs: goal.rhs },
      ]));
    }
    case '<=': {
      return verdict(solveDiffConstraints([...assumptions,
        { lhs: goal.lhs, op: '>=', rhs: linAdd(goal.rhs, linFromInt(1n), 1n) },
      ]));
    }
    case '<': {
      return verdict(solveDiffConstraints([...assumptions,
        { lhs: goal.lhs, op: '>=', rhs: goal.rhs },
      ]));
    }
    case '>=': return proveImplication(assumptions, { lhs: goal.rhs, op: '<=', rhs: goal.lhs });
    case '>': return proveImplication(assumptions, { lhs: goal.rhs, op: '<', rhs: goal.lhs });
    default: return { kind: 'not-proven' }; // 未知 op:保守不证明
  }
}

// ===================== v0.55:跨函数契约摘要 =====================

// 线性约束的变量集合 ⊆ allowed(防御:摘要只允许形参名 + 'result' 符号)
function constraintsVarsOk(cs, allowed) {
  if (!Array.isArray(cs)) return false;
  for (const c of cs) {
    if (!c || !c.lhs || !c.rhs || typeof c.op !== 'string') return false;
    for (const side of [c.lhs, c.rhs]) {
      for (const k of side.coeffs.keys()) if (!allowed.has(k)) return false;
    }
  }
  return true;
}

// N10(防御):注入的 toLinear / computePost 结果只允许差分约束可编码的比较 op;
// 非法 op 视为不可编码(requires → 不完整门控,ensures → 不采用),不得进入求解器。
const LINEAR_OPS = new Set(['==', '<', '<=', '>', '>=']);
function constraintsOpsOk(cs) {
  if (!Array.isArray(cs)) return false;
  for (const c of cs) {
    if (!c || typeof c.op !== 'string' || !LINEAR_OPS.has(c.op)) return false;
  }
  return true;
}

// 跨函数契约摘要(v0.55)。
//
// 输入 fns(纯数据;AST 对 prover 不透明):
//   { name, params: [{name, ...}], requires: ast|null, ensures: ast|null,
//     calls: [calleeName...],          // 直接调用边(声明序去重;表外名字忽略)
//     post: [{lhs,op,rhs}]|null }      // 阶段 1 兼容字段:checker 预证的 ensures 线性合取
//                                      // (变量 = 形参名 + 'result');提供 computePost 时忽略
// toLinear(ast, varMap) 由 checker 注入:varMap = Map<形参名, 线性形式>;
//   返回 [{lhs,op,rhs}] | null —— null 表示该契约表达式不能完整编码为线性约束合取
//   (==/</<=/>/>= 的 && 合取;`true` 视为空合取;|| / != / ! / 非线性叶子一律 null)。
// computePost(fn, summariesSoFar) 为 v0.55 阶段 2 的第三个可选回调:
//   按拓扑序逐函数证明 post —— summariesSoFar 是已算出的摘要表(Map<name, summary>),
//   因 Tarjan SCC 输出序为"被调方先于调用方",此时被调函数的 ensures 已在表中,
//   checker 可把「本函数 requires + 已证被调 ensures(代入实参)」作为直线体证明的假设集。
//   返回 [{lhs,op,rhs}] | null(变量仅允许形参名 + 'result';null = 未证明/不可编码)。
//   仅对非环、requires 完整、声明了 ensures 的函数调用;未提供该回调时回退到 fn.post
//   (阶段 1 行为,§59.1 直测用)。
//
// 返回 Map<name, {name, requires, ensures, noSummary, params}>:
//   requires:  [线性约束] | null   null = requires 不完整(含不可编码叶子)
//   ensures:   [线性约束] | null   null = 不可采用(调用方不得假设);[] = 无 ensures/空合取
//   noSummary: true                该函数在环上(自递归/互递归)→ ensures 不采用
//   params:    [形参名]            调用点把 ensures 的形参代入实参所需的形参序
//
// 硬门控(保守合同):
//   1) requires 不完整 → ensures 必为 null(未编码的前置条件不能作为摘要的证明前提);
//   2) ensures 仅在 checker 已静态证明(post 非 null)且变量仅含形参 + 'result' 时采用;
//   3) 环上函数 ensures 必为 null(递归体的直线体结论不可外推)。
// 拓扑序:Tarjan SCC 输出即"被调方先于调用方"的逆拓扑序;SCC 内按声明序,FNS 表内按
//   声明序索引 —— 全程确定性,不依赖 Map 迭代顺序的偶然性。
export function computeSummaries(fns, toLinear, computePost) {
  // 1) 建表(声明序;重复名字保留首个 —— 与 checker 的重复声明诊断口径一致)
  const byName = new Map();
  const declOrder = [];
  for (const fn of fns ?? []) {
    if (!fn || typeof fn.name !== 'string' || byName.has(fn.name)) continue;
    byName.set(fn.name, fn);
    declOrder.push(fn.name);
  }
  const declIdx = new Map(declOrder.map((n, i) => [n, i]));

  // 2) 调用边(只保留表内函数;去重保序 → 枚举确定性)
  const edges = new Map();
  for (const name of declOrder) {
    const seen = new Set();
    const es = [];
    for (const c of byName.get(name).calls ?? []) {
      if (typeof c !== 'string' || !byName.has(c) || seen.has(c)) continue;
      seen.add(c);
      es.push(c);
    }
    edges.set(name, es);
  }

  // 3) Tarjan SCC(迭代版;避免深调用链爆栈)。自环与 >1 节点的 SCC 即在环上。
  const index = new Map(), low = new Map(), onStack = new Set(), sccStack = [];
  const sccs = [];
  let counter = 0;
  for (const root of declOrder) {
    if (index.has(root)) continue;
    const callStack = [{ name: root, i: 0 }];
    index.set(root, counter); low.set(root, counter); counter++;
    sccStack.push(root); onStack.add(root);
    while (callStack.length) {
      const top = callStack[callStack.length - 1];
      const es = edges.get(top.name);
      if (top.i < es.length) {
        const w = es[top.i++];
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter++;
          sccStack.push(w); onStack.add(w);
          callStack.push({ name: w, i: 0 });
        } else if (onStack.has(w) && index.get(w) < low.get(top.name)) {
          low.set(top.name, index.get(w));
        }
      } else {
        callStack.pop();
        if (callStack.length) {
          const p = callStack[callStack.length - 1];
          if (low.get(top.name) < low.get(p.name)) low.set(p.name, low.get(top.name));
        }
        if (low.get(top.name) === index.get(top.name)) {
          const comp = [];
          for (;;) {
            const w = sccStack.pop();
            onStack.delete(w);
            comp.push(w);
            if (w === top.name) break;
          }
          comp.sort((a, b) => declIdx.get(a) - declIdx.get(b));
          sccs.push(comp);
        }
      }
    }
  }

  // 4) 按 SCC 输出序(被调方先)构造摘要。Tarjan 的 SCC 输出序是凝缩图逆拓扑序:
  //    若 u → v,则 v 的 SCC 先于 u 的 SCC 输出 —— 正是依赖优先顺序。
  const out = new Map();
  for (const comp of sccs) {
    const cyclic = comp.length > 1 || edges.get(comp[0]).includes(comp[0]);
    for (const name of comp) {
      const fn = byName.get(name);
      const paramNames = new Set();
      for (const p of fn.params ?? []) if (p && typeof p.name === 'string') paramNames.add(p.name);
      // requires:全部叶子可编码才非 null;null = 不完整(调用方不得假设 ensures)
      let requires = null;
      if (fn.requires == null) {
        requires = [];
      } else if (typeof toLinear === 'function') {
        const varMap = new Map();
        for (const pn of paramNames) varMap.set(pn, { coeffs: new Map([[pn, 1n]]), c: 0n });
        const cs = toLinear(fn.requires, varMap);
        // N10:非法 op(注入器缺陷/Bug)→ 视为不可编码,摘要 requires 不完整
        if (constraintsVarsOk(cs, paramNames) && constraintsOpsOk(cs)) requires = cs;
      }
      // ensures:requires 完整 + 非环 + checker 已证 → 采用;否则 null(静默,不误证)
      // v0.55 阶段 2:post 由 computePost(fn, out) 在拓扑序上现算 —— out 已含被调摘要,
      // 于是 ensures 的证明可以假设"已证被调 ensures";回调未提供时回退 fn.post(阶段 1)。
      let post = null;
      if (!cyclic && requires !== null && fn.ensures != null) {
        if (typeof computePost === 'function') post = computePost(fn, out);
        else post = fn.post ?? null;
      }
      let ensures = null;
      if (!cyclic && requires !== null) {
        if (fn.ensures == null) {
          ensures = []; // 无 ensures = 空后置条件(可采用,无约束)
        } else if (!paramNames.has('result')) {
          const allowed = new Set(paramNames);
          allowed.add('result');
          if (constraintsVarsOk(post, allowed) && constraintsOpsOk(post)) ensures = post;
        }
      }
      out.set(name, { name, requires, ensures, noSummary: cyclic, params: [...paramNames] });
    }
  }
  return out;
}
