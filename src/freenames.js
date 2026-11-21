// freenames.js — 自由变量分析(collectFreeNames / collectLambdaLocals / addPatNames)。
//
// VM capture plan 与 tree captureEnvFor 的单一事实来源;改语法必须同步两消费者
// (compiler plan / ADR-011 未来 captureEnvFor)。
//
// v0.98 ADR-011 P0(纯移动,零逻辑变化):自 src/compiler.js(HEAD 37c5d3a :1536-1597)
// 逐字节移入;本模块为零依赖叶模块(不 import 任何同仓模块),规避 interp→compiler
// ESM 循环导入(ADR-011 §3.1)。现役消费者 = src/compiler.js compileLambda 捕获计划;
// ADR-011 P1 的 tree captureEnvFor 落地后必须消费本模块,保证两引擎选出同一自由集。

export function collectFreeNames(node, bound, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectFreeNames(x, bound, out, seen); return; }
  switch (node.nt) {
    case 'Ident': {
      if (!bound.has(node.name) && !seen.has(node.name)) {
        seen.add(node.name);
        out.push(node.name);
      }
      return;
    }
    case 'Lambda': {
      // 子 lambda:它自己的参数与局部绑定不算,但它的自由变量传递为当前层的自由变量
      const innerBound = new Set(bound);
      for (const p of node.params) innerBound.add(p.name);
      collectLambdaLocals(node.body, innerBound);
      collectFreeNames(node.body, innerBound, out, seen);
      return;
    }
    case 'FnStmt': return; // 本地函数不捕获,体内名字不外泄
    default: break;
  }
  for (const k of Object.keys(node)) {
    if (k === 'span' || k === 'docs') continue;
    const v = node[k];
    if (v && typeof v === 'object') collectFreeNames(v, bound, out, seen);
  }
}

// 把 lambda 体中 let/for/while-let/match 绑定的名字加入 bound(供 collectFreeNames 区分)
//
// ADR-011 M1 禁令(v0.97 审查实证;P0 移动时函数体逐字节保留,严禁"顺手修复"):
// case 'BlockExpr' 读 node.stmts,而 BlockExpr 的语句在 node.block.stmts——该分支对
// 真实 lambda 体从不下钻(裸 Block 节点只作 Loop/UnsafeBlock/SyncScopeBlock 等的 body
// 字段,不进 lambda 体位),从未向 bound 添加过名字 = 死代码。但该死代码承重:内层
// `let g = g+1` 的 init 引用外层 g 因此被收进自由集,恰是 rv1/rv7 双引擎正确行为
// (纯过近似捕获;探针 .zcode/review-adr011/rv1_shadow_init_nested.ming /
// rv7_nested_local_let.ming)。修复本函数即翻转 rv1/rv7 锚(捕获计划丢 g)。
export function collectLambdaLocals(node, bound) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectLambdaLocals(x, bound); return; }
  switch (node.nt) {
    case 'Let': addPatNames(node.pat, bound); if (node.init) collectLambdaLocals(node.init, bound); return;
    case 'For': addPatNames(node.pat, bound); return;
    case 'WhileLet': addPatNames(node.pat, bound); return;
    case 'FnStmt': return;
    case 'BlockExpr': case 'Block': {
      for (const s of node.stmts ?? []) collectLambdaLocals(s, bound);
      if (node.tail) collectLambdaLocals(node.tail, bound);
      return;
    }
    default: {
      for (const k of Object.keys(node)) {
        if (k === 'span' || k === 'docs') continue;
        const v = node[k];
        if (v && typeof v === 'object') collectLambdaLocals(v, bound);
      }
    }
  }
}

export function addPatNames(pat, bound) {
  if (!pat) return;
  switch (pat.nt) {
    case 'PIdent': bound.add(pat.name); return;
    case 'PTuple': for (const p of pat.pats) addPatNames(p, bound); return;
    case 'PEnum': for (const p of pat.args) addPatNames(p, bound); return;
    default: return;
  }
}
