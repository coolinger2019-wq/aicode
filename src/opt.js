// src/opt.js — 字节码优化管线(O1,plan §4.16.3)。
//
// 职责:在 BytecodeCompiler.run() 产出 built 之后(compiler.js compile() 单点钩子)对
// **字节码**做语义保持优化。三个 pass,fixpoint 迭代上限 10,每 pass 独立函数:
//   P1 foldPass   常量折叠 —— 相邻纯常量模式就地折叠:[CONST a, CONST b, BIN] →
//                 [CONST a+b](操作数 CONST 删除,结果 CONST 落在原 BIN 地址);
//                 [CONST e, UN] → [CONST 结果]。收集-重建制(操作数删除经统一
//                 重建+跳转重映射落地),级联链由外层 fixpoint 收敛;
//   P2 prunePass  分支裁剪 —— 常量条件 JUMPFALSE 裁剪死分支;&& / || 两侧全字面量
//                 的编译器 5 指令形态折叠为单 CONST;一次重建+跳转重映射;
//      threadPass 跳转线程 —— JUMP→JUMP 链归一、条件跳转穿透单层 JUMP、
//                 恒跳 JUMPFALSE(target=下一条)→ POP、无操作 JUMP 删除;
//   P3 dcePass    死代码消除 —— 从函数入口做可达性分析,删除不可达指令
//                 (有副作用也删:已被证明不可达,删除不改任何可观察行为)。
//
// 语义保真合同(硬规则 1:三引擎输出必须一致):
//   * 整数折叠复用运行时 intBin(interp.js 单一事实来源)——溢出/除零/模零/移位越界
//     会 throw Panic,折叠层捕获后**不折叠**,BIN 原样保留,运行时 M4002/M4004 的
//     存在性/位置(spanIdx 原样)/消息逐字不变。
//   * f64 只折叠 + - * 与"除数非零的 /"(bits=64;JS 双精度 IEEE 与运行时同式,
//     NaN/±Inf 结果可折叠,displayStr 输出路径不变)。
//   * 字符串比较可折叠(==/!= 复用 valueEquals,与运行时同一调用);字符串拼接
//     ("a" + "b")**不折叠**——运行时拼接计入 --max-alloc(M4011 资源门禁),
//     提前折叠会让同程序在不同腿间产生配额行为分歧(O1 审查 M1:v0.94 移除)。
//   * && / || 短路保真:两侧全字面量才整体折叠(P2 模式);常量左操作数的 JUMPFALSE
//     裁剪(P2.b)恰为短路语义本身——被跳过的段正是运行时会跳过的段,副作用永不丢失
//     (树引擎短路求值与优化后字节码逐字同输出,§104 短路保真用例锁定)。
//   * spans 数组只读不写:指令 spanIdx 原样保留(结果 CONST 继承被替换指令的
//     spanIdx),panic 位置逐字不变;wasm 层引用的 span 下标永不失效。
//   * 只用既有 opcode(wire 不变);pool 只追加不移动,既有池下标零位移。
//   * 确定性:扫描序 = 地址序,池追加序 = 首次折叠序,无时间/随机/哈希序依赖。
//
// 折叠健全性(为什么"相邻 + 跳转目标守卫"足够):
//   栈式字节码中 [CONST a][CONST b][BIN] 相邻意味着线性执行下 BIN 弹出的恰是 a、b
//   (中间无任何指令,栈形由构造保证)。守卫要求三个地址都**不是跳转目标**——
//   跳入表达式中部会破坏该对应(编译器从不发射该形态,守卫使其成为可证明性质,
//   例如 && 的 false 结果标签 CONST 正是跳转目标,其后接比较时必须放弃折叠)。
//   被删操作数 CONST 的唯一消费者就是被替换的 BIN/UN(栈纪律:每值恰一消费者),
//   删除后压栈深度守恒(2 压 1 弹 1 压 → 1 压)。
//
// ESM 循环导入说明:compiler.js(→opt.js)与 opt.js(→compiler.js)构成环——本模块
// 顶层**不得**解引用 compiler 的导出绑定(OP/BIN 在 compiler.js 体内才初始化,vm.js
// 先加载 compiler.js 的正常路径下,opt.js 体求值时它们尚在 TDZ);全部经 lazy memo
// 在首次调用时读取(live binding)。
//
// 开关:默认开;`MING_NO_OPT=1` 或 `--no-opt`(bin/ming.js 置 env)或显式
// `optimize(built, { enabled: false })` 时逐字节原样返回。

import { V, fits, intBin, valueEquals } from './interp.js';
import { OP, BIN } from './compiler.js';

// ---------- lazy memo(见文件头 ESM 循环导入说明;顶层不读 OP/BIN)----------

let BIN2OP_ = null;
function bin2op() {
  if (BIN2OP_) return BIN2OP_;
  const m = {};
  for (const [k, v] of Object.entries(BIN)) m[v] = k;
  BIN2OP_ = m;
  return m;
}

function isJumpOp(op) {
  return op === OP.JUMP || op === OP.JUMPFALSE || op === OP.JUMPNONE || op === OP.ITERNEXT;
}

// ---------- 池值折叠判据 ----------

// 池条目 → 纯常量 V 值(int/float/bool/str)或 null。只认"原始 V"(自带 .t、无 __tag):
// pstr/builtin/stdmod 等包装条目是调用目标与内部约定,不是可折叠的值面(误认会把
// '__builtin:print' 当字符串折叠进表达式)。
function constCellOf(c) {
  if (c && typeof c === 'object' && !c.__tag && typeof c.t === 'string') {
    if (c.t === 'int' || c.t === 'float' || c.t === 'bool' || c.t === 'str') return c;
  }
  return null;
}

// 折叠结果入池(带值去重;-0 与 0 分键——1.0 / -0.0 < 0.0 的位型语义不可被合并抹掉;
// V 构造器归一保证同值同表示,Number/BigInt 同键无碰撞)。
function makePoolAdder(pool) {
  const seen = new Map();
  return (v) => {
    let key;
    if (v.t === 'int') key = 'i' + v.bits + (v.signed ? 's' : 'u') + ':' + String(v.v);
    else if (v.t === 'float') key = 'f' + v.bits + ':' + (Object.is(v.v, -0) ? '-0' : String(v.v));
    else key = v.t + ':' + String(v.v);
    const hit = seen.get(key);
    if (hit !== undefined) return hit;
    const idx = pool.length;
    pool.push(v);
    seen.set(key, idx);
    return idx;
  };
}

// ---------- P1:常量折叠 ----------

// 二元折叠:复用运行时实现(intBin/valueEquals),折叠失败(null)= 运行时会 panic
// 或语义不可静态复算 → BIN 原样保留。l/r 为 constCellOf 判定的纯常量。
function foldBin(l, r, binCode) {
  const op = bin2op()[binCode];
  if (op === undefined) return null;
  if (op === '==' || op === '!=') {
    // 运行时 binopValues '==' 恰为 valueEquals(l, r)——同一调用,零语义差
    return V.bool(op === '==' ? valueEquals(l, r) : !valueEquals(l, r));
  }
  if (op === '<' || op === '<=' || op === '>' || op === '>=') {
    // 运行时 compareValues 同式(v 直接关系比较;NaN 全 false 逐字保留)
    if (l.t === 'int') {
      if (r.t !== 'int' || l.bits !== r.bits || l.signed !== r.signed) return null;
    } else if (l.t === 'float') {
      if (r.t !== 'float' || l.bits !== 64 || r.bits !== 64) return null;
    } else if (l.t === 'str') {
      if (r.t !== 'str') return null;
    } else return null;
    const cmp = l.v < r.v ? -1 : l.v > r.v ? 1 : 0;
    return V.bool(op === '<' ? cmp < 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : cmp >= 0);
  }
  // 算术:整数走 intBin(运行时同一函数;throw = 运行时 panic 原样保留,不折叠)
  if (l.t === 'int' && r.t === 'int') {
    if (l.bits !== r.bits || l.signed !== r.signed) return null;
    try { return intBin(op, l, r, null); } catch { return null; }
  }
  // f64:JS 双精度 IEEE 与运行时同式;/ 仅除数非零(规格合同);NaN/±Inf 可折叠
  if (l.t === 'float' && r.t === 'float' && l.bits === 64 && r.bits === 64) {
    if (op === '+') return V.float(l.v + r.v, 64);
    if (op === '-') return V.float(l.v - r.v, 64);
    if (op === '*') return V.float(l.v * r.v, 64);
    if (op === '/' && r.v !== 0) return V.float(l.v / r.v, 64);
    return null;
  }
  // 字符串拼接不折叠(v0.94 审查 M1):运行时字符串 `+`(OP.BIN/binopValues)计入 --max-alloc(每字符 1,OP.CONCAT 插值不计费);
  // 折叠后该计费消失 → 默认腿 exit 0 而 tree/wasm/--no-opt 腿 M4011(exit 101),
  // 违反"三腿一致"。折叠收益不值得引入资源门禁面的语义分歧,整类移除。
  // 字符串相等/比较仍可折叠(无计费、无 panic 面)。
  return null;
}

// 一元折叠:1 = '-'(有符号整数 fits 门 / float 任意位精确变号),2 = '!'(bool)
function foldUn(e, unOp) {
  if (unOp === 1) {
    if (e.t === 'int') {
      // 无符号取负 checker 已拒(M3008);防御不折叠(两引擎该路径口径不一致,永不触达)
      if (!e.signed) return null;
      const r = -(BigInt(e.v));
      if (!fits(r, e.bits, true)) return null; // i64::MIN 取负等 → 运行时 M4002 原样保留
      return V.int(r, e.bits, true);
    }
    if (e.t === 'float') return V.float(-e.v, e.bits); // 变号精确(任意位;两引擎同式)
    return null;
  }
  if (unOp === 2) {
    if (e.t === 'bool') return V.bool(!e.v);
    return null;
  }
  return null;
}

// P1 扫描:相邻模式收集(不做任何就地改写),一次重建落地。
//   BIN:[CONST a][CONST b][BIN] 三地址均非跳转目标 → 删 i-2/i-1,CONST(结果)@i;
//   UN: [CONST e][UN] 两地址均非跳转目标 → 删 i-1,CONST(结果)@i。
// 同一扫描内模式两两不相交(模式对 claimed 槽位的 op 形状要求互斥);
// 级联链((1+2)+(3+4) 等)由外层 fixpoint 逐层收敛。
function foldPass(code, pool, addConst) {
  const n = code.length;
  const targets = new Set();
  for (let i = 0; i < n; i++) {
    if (isJumpOp(code[i][0])) targets.add(code[i][1]);
  }
  const deleted = new Set();
  const replace = new Map();
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const op = code[i][0];
    if (op === OP.BIN) {
      if (i < 2) continue;
      if (code[i - 2][0] !== OP.CONST || code[i - 1][0] !== OP.CONST) continue;
      if (targets.has(i - 2) || targets.has(i - 1) || targets.has(i)) continue;
      const l = constCellOf(pool[code[i - 2][1]]);
      const r = constCellOf(pool[code[i - 1][1]]);
      if (!l || !r) continue;
      const folded = foldBin(l, r, code[i][1]);
      if (!folded) continue; // 溢出/除零/移位越界/类型不可静态复算 → 运行时 panic 原样
      deleted.add(i - 2);
      deleted.add(i - 1);
      replace.set(i, [OP.CONST, addConst(folded), 0, 0, code[i][4]]); // spanIdx 继承
      changed++;
    } else if (op === OP.UN) {
      if (i < 1) continue;
      if (code[i - 1][0] !== OP.CONST) continue;
      if (targets.has(i - 1) || targets.has(i)) continue;
      const e = constCellOf(pool[code[i - 1][1]]);
      if (!e) continue;
      const folded = foldUn(e, code[i][1]);
      if (!folded) continue;
      deleted.add(i - 1);
      replace.set(i, [OP.CONST, addConst(folded), 0, 0, code[i][4]]);
      changed++;
    }
  }
  if (!changed) return { code, count: 0 };
  const r = rebuild(code, deleted, replace);
  return { code: r.newCode, count: changed };
}

// ---------- 重建 + 跳转重映射(P1/P2/P3 共用)----------

// deleted = 删除地址集;replace = 地址 → 原位替换指令(携带**旧地址域**的跳转目标,
// 统一在重映射步换算)。被删地址的映射 = 线性后继(向后第一个存活地址的新址)。
// 本管线的删除仅两类——(1)与替换点绑定、压栈深度守恒的求值对/操作数(P1 操作数、
// P2 恒真条件对):其入边(如 while true 回边指向条件起点)线性后继恰为原语义落点;
// (2)证明不可达区域(P2 死分支 / P3 不可达):无入边。P2.a 的 5 指令形态区域由
// 外部跳转守卫保证无入边。
function rebuild(code, deleted, replace) {
  const newCode = [];
  const newIdx = new Array(code.length).fill(-1);
  for (let i = 0; i < code.length; i++) {
    if (deleted.has(i)) continue;
    newIdx[i] = newCode.length;
    const rep = replace.get(i);
    if (rep) newCode.push(rep);
    else {
      const ins = code[i];
      newCode.push([ins[0], ins[1], ins[2], ins[3], ins[4]]);
    }
  }
  const addrMap = new Array(code.length + 1);
  let next = newCode.length;
  for (let i = code.length - 1; i >= 0; i--) {
    if (newIdx[i] >= 0) next = newIdx[i];
    addrMap[i] = next;
  }
  addrMap[code.length] = newCode.length;
  for (const ins of newCode) {
    if (isJumpOp(ins[0])) {
      const t = ins[1];
      ins[1] = (t >= 0 && t < code.length) ? addrMap[t] : newCode.length;
    }
  }
  return { newCode, addrMap };
}

// ---------- P2:分支裁剪 ----------

// 扫描两类变换(先模式后条件,互斥认领),一次重建落地:
//   P2.a && / || 两侧全字面量 —— 编译器 5 指令形态折叠为单 CONST:
//     &&: [CONST l][JUMPFALSE→i+4][CONST r][JUMP→i+5][CONST false](false 为结果标签)
//     ||: [CONST l][JUMPFALSE→i+4][CONST true][JUMP→i+5][CONST r](true 为短路标签)
//     &&: 结果 = l && c2(短路语义 l ? r : false);||: 结果 = l || c4(c2 是短路标签
//     true,真实右操作数在 i+4)。形状重叠区(c2=true 且 c4=false:`l && true` ≡
//     `l || false`)两式同为 l,无歧义。该形态亦可匹配"两分支皆 bool 字面量的 if"
//     (语义恒等:if l {r} else {false} ≡ l && r;if l {true} else {r} ≡ l || r;
//     if l {false} else {true} ≡ !l 不属两式,守卫跳过)。
//     守卫:除模式自身 JUMPFALSE(→i+4)外不得有其他跳转进入 [i+1..i+4]。
//   P2.b 常量条件分支裁剪 —— JUMPFALSE 前一条恰为 CONST bool(纯字面量构造,含 P1
//     折叠产物):true → 求值对删除直落;false → 替换为 JUMP(死分支交 P3 删除)。
//     守卫:不得有跳转指向该 JUMPFALSE 本身(形状局部性;编译器从不发射该形态)。
function prunePass(code, pool, addConst) {
  const n = code.length;
  const jumpSrc = new Map();
  for (let i = 0; i < n; i++) {
    if (isJumpOp(code[i][0])) jumpSrc.set(code[i][1], (jumpSrc.get(code[i][1]) ?? 0) + 1);
  }
  const deleted = new Set();
  const replace = new Map();
  const claimed = new Set(); // 被 P2.a 认领的 JUMPFALSE 地址(P2.b 让位,避免双重变换)
  let count = 0;

  // P2.a
  for (let i = 0; i + 4 < n; i++) {
    const c0 = code[i];
    const c1 = code[i + 1];
    const c2 = code[i + 2];
    const c3 = code[i + 3];
    const c4 = code[i + 4];
    if (c0[0] !== OP.CONST || c1[0] !== OP.JUMPFALSE || c2[0] !== OP.CONST || c3[0] !== OP.JUMP || c4[0] !== OP.CONST) continue;
    if (c1[1] !== i + 4 || c3[1] !== i + 5) continue;
    const l = constCellOf(pool[c0[1]]);
    const r = constCellOf(pool[c2[1]]);
    const t4 = constCellOf(pool[c4[1]]);
    if (!l || !r || !t4 || l.t !== 'bool' || r.t !== 'bool' || t4.t !== 'bool') continue;
    const isAnd = t4.v === false;
    const isOr = r.v === true;
    if (!isAnd && !isOr) continue;
    // 外部跳转守卫:target i+4 允许恰 1 个来源(模式自身的 c1);i+1..i+3 必须 0
    let external = false;
    for (let t = i + 1; t <= i + 4; t++) {
      const cnt = jumpSrc.get(t) ?? 0;
      if (t === i + 4 ? cnt > 1 : cnt > 0) { external = true; break; }
    }
    if (external) continue;
    const result = V.bool(isAnd ? !!(l.v && r.v) : !!(l.v || t4.v));
    replace.set(i, [OP.CONST, addConst(result), 0, 0, c0[4]]); // span 继承字面量 l 的位置
    for (let t = i + 1; t <= i + 4; t++) deleted.add(t);
    claimed.add(i + 1);
    count++;
  }

  // P2.b
  for (let i = 1; i < n; i++) {
    if (code[i][0] !== OP.JUMPFALSE) continue;
    if (claimed.has(i)) continue;
    const prev = code[i - 1];
    if (prev[0] !== OP.CONST) continue;
    const v = constCellOf(pool[prev[1]]);
    if (!v || v.t !== 'bool') continue;
    if ((jumpSrc.get(i) ?? 0) > 0) continue; // 有跳转指向本 JUMPFALSE:形状局部性不成立
    const target = code[i][1];
    if (v.v === false) {
      // 恒假 → 无条件跳 false 落点([i+1, target) 死分支由 P3 可达性删除);
      // 栈效果守恒:原 CONST 压/JUMPFALSE 弹(净 0)→ JUMP 净 0,任意入边路径栈形不变
      replace.set(i - 1, [OP.JUMP, target, 0, 0, prev[4]]);
      deleted.add(i);
      count++;
    } else {
      // 恒真 → 求值对删除直落;指向被删 CONST 的入边(如 while true 回边指向条件起点)
      // 经线性后继映射落到下一存活指令 = 原语义落点(CONST+JUMPFALSE 净栈效果为 0)
      deleted.add(i - 1);
      deleted.add(i);
      count++;
    }
  }

  if (!count) return { code, count: 0 };
  const r = rebuild(code, deleted, replace);
  return { code: r.newCode, count };
}

// ---------- P2:跳转线程 ----------

// JUMP→JUMP 链归一(环守卫);JUMPFALSE/JUMPNONE/ITERNEXT 穿透单层 JUMP;
// 恒跳 JUMPFALSE(target = 下一条)→ POP(栈效果同:弹条件,两路同址);
// 无操作 JUMP(target = 下一条)删除(净栈效果 0,删除后目标重映射 = 原落点)。
function threadPass(code) {
  const n = code.length;
  let changed = 0;
  for (let round = 0; round < 8; round++) {
    let roundChanged = 0;
    for (let i = 0; i < n; i++) {
      const ins = code[i];
      const op = ins[0];
      if (op === OP.JUMP) {
        let t = ins[1];
        const seen = new Set([i]);
        while (t >= 0 && t < n && code[t][0] === OP.JUMP && !seen.has(t)) {
          seen.add(t);
          t = code[t][1];
        }
        if (t !== ins[1]) { ins[1] = t; roundChanged++; }
      } else if (op === OP.JUMPFALSE || op === OP.JUMPNONE || op === OP.ITERNEXT) {
        const t = ins[1];
        if (t >= 0 && t < n && code[t][0] === OP.JUMP) {
          const nt = code[t][1];
          if (nt !== t && nt !== ins[1]) { ins[1] = nt; roundChanged++; }
        }
      }
    }
    changed += roundChanged;
    if (!roundChanged) break;
  }
  for (let i = 0; i < n; i++) {
    const ins = code[i];
    if (ins[0] === OP.JUMPFALSE && ins[1] === i + 1) {
      code[i] = [OP.POP, 0, 0, 0, ins[4]];
      changed++;
    }
  }
  const deleted = new Set();
  for (let i = 0; i < n; i++) {
    if (code[i][0] === OP.JUMP && code[i][1] === i + 1) deleted.add(i);
  }
  if (deleted.size) {
    const r = rebuild(code, deleted, new Map());
    return { code: r.newCode, count: changed + deleted.size };
  }
  return { code, count: changed };
}

// ---------- P3:死代码消除 ----------

// 从入口(地址 0)可达性分析。边 = fallthrough(非终结指令)+ 跳转目标;
// 终结指令 = RET / JUMP / PANICX / ASM(VM 执行到即离开本帧或 panic,永不 fallthrough)。
// JUMP 无 fallthrough 是 v0.94 审查 m1 的修复:break/continue 的 JUMP 之后、常量假
// 分支替换出的 JUMP 之后,原实现把下一条标为可达 → 死代码永不删除(DCE pass 形同
// 虚设);JUMP 目标自身仍按跳转边标可达,另一跳转指向"下一条"时也按目标边可达。
// QMARK 早退路径退出本帧(不产生新的可达指令),按 fallthrough 计,完备。
// 不可达指令删除(含副作用指令:已证明不可达);可达跳转的目标恒可达,重映射零歧义。
function dcePass(code) {
  const n = code.length;
  if (n === 0) return { code, count: 0 };
  const reach = new Uint8Array(n);
  reach[0] = 1;
  const work = [0];
  while (work.length) {
    const i = work.pop();
    const op = code[i][0];
    if (isJumpOp(op)) {
      const t = code[i][1];
      if (t >= 0 && t < n && !reach[t]) { reach[t] = 1; work.push(t); }
    }
    const term = op === OP.RET || op === OP.JUMP || op === OP.PANICX || op === OP.ASM;
    if (!term && i + 1 < n && !reach[i + 1]) { reach[i + 1] = 1; work.push(i + 1); }
  }
  const deleted = new Set();
  for (let i = 0; i < n; i++) if (!reach[i]) deleted.add(i);
  if (!deleted.size) return { code, count: 0 };
  const r = rebuild(code, deleted, new Map());
  return { code: r.newCode, count: deleted.size };
}

// ---------- 单函数管线(fold → prune → thread → dce,fixpoint ≤ 10)----------

function optimizeFunction(f, pool, addConst) {
  let code = f.code;
  let total = 0;
  for (let iter = 0; iter < 10; iter++) {
    void iter;
    const c1 = foldPass(code, pool, addConst);
    const c2 = c1.count;
    if (c1.code !== code) code = c1.code;
    const p = prunePass(code, pool, addConst);
    const c3 = p.count;
    if (p.code !== code) code = p.code;
    const t = threadPass(code);
    const c4 = t.count;
    if (t.code !== code) code = t.code;
    const d = dcePass(code);
    const c5 = d.count;
    if (d.code !== code) code = d.code;
    total += c2 + c3 + c4 + c5;
    if (!(c2 || c3 || c4 || c5)) break;
  }
  f.code = code;
  return total;
}

// ---------- 管线入口(compiler.js compile() 单点钩子调用)----------

export function optimize(built, opts = {}) {
  const enabled = opts.enabled !== undefined ? !!opts.enabled : process.env.MING_NO_OPT !== '1';
  if (!enabled) return built;
  if (!built || !Array.isArray(built.functions) || !Array.isArray(built.pool)) return built;
  const addConst = makePoolAdder(built.pool);
  for (const f of built.functions) {
    if (!f || !Array.isArray(f.code) || f.code.length === 0) continue;
    optimizeFunction(f, built.pool, addConst);
  }
  return built;
}
