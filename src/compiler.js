// compiler.js — Ming 字节码编译器(v0.3)。
// 输入 Checker 结果(模块项已带 sig / methodEntries),输出扁平函数表 + 常量池 + 模式池。
//
// 语义保真要点(与树遍历引擎逐条对应):
//   * 值语义:ST/SET/BIND/调用实参/集合元素/闭包捕获全部 deepCopy
//   * mut self 方法:self 不拷贝(修改要生效),其余实参拷贝
//   * 闭包捕获 = 创建时快照;闭包内对捕获变量的赋值只影响自己的副本
//   * panic 携带指令级 span;调用栈同树引擎
//
// 指令编码:[op, a, b, spanIdx](数组);操作码见 OP。

import { V, deepCopy, UNIT, displayStr, debugStr, valueEquals, normKey, keyValue, Panic, RetSig, declaredSpecOfTyAst, declaredSpecOfPatAst, declaredSpecOfTy } from './interp.js';
import { Interp } from './interp.js';
import { resolveT, typeStr } from './checker.js';
import { tryCompileWasm } from './wasm.js';
import { optimize } from './opt.js';
// v0.98 ADR-011 P0:自由变量分析单源化(VM capture plan 与 tree captureEnvFor 的单一事实来源)
import { collectFreeNames, collectLambdaLocals, addPatNames } from './freenames.js';

// v0.54 审查 B5:编译器内部可预期的"名字/结构体未解析"错误携带源码位置,
// 由 CLI 渲染为 file:line:col 诊断(而不是 Node 裸栈)。其余异常仍按 bug 上抛。
export class CompileError extends Error {
  constructor(message, span) {
    super(message);
    this.name = 'CompileError';
    this.span = span ?? null;
  }
}

export const OP = {
  CONST: 1,        // a=池下标                     → push pool[a]
  POP: 2,          //                              → 弹出
  JUMP: 3,         // a=目标
  JUMPFALSE: 4,    // a=目标                       → 弹出 bool
  LD: 5,           // a=kind(0=local,1=cap), b=idx → push
  ST: 6,           // a=kind, b=idx                → 弹值 deepCopy 存储(let 绑定)
  SET: 7,          // a=kind, b=idx                → 弹值 deepCopy 存储(赋值)
  BIN: 8,          // a=二元运算码                  → 弹 r,l push 结果
  UN: 9,           // a=1 '-' / 2 '!'              → 弹 e push
  GETFIELD: 10,    // a=name 池下标
  SETFIELD: 11,    // a=name 池下标                → 弹 value, base
  INDEX: 12,       //
  SETINDEX: 13,    //                              → 弹 value, index, base
  CALL: 14,        // a=argc                       → 弹 args, callee
  CALLMETHOD: 15,  // a=name 池下标, b=argc        → 弹 args, recv
  RET: 16,         //                              → 弹值返回
  QMARK: 17,       //                              → 弹 opt/res;失败转早退
  MAKEVEC: 18,     // a=n                          → 弹 n 个(深拷贝)
  MAKEMAP: 19,     // a=n(键值对 2n)
  MAKETUPLE: 20,   // a=n
  MAKESTRUCT: 21,  // a=字段名数组池下标, b=n
  MAKEENUM: 22,    // a=spec 池下标, b=n
  CLOSURE: 23,     // a=函数下标, b=捕获计划池下标
  LDFN: 24,        // a=函数下标                   → push vclose(无捕获)
  PATMATCH: 25,    // a=模式池下标                 → peek 值,push binds 数组或 null
  JUMPNONE: 26,    // a=目标                       → 栈顶 null 则弹出并跳
  BIND: 27,        // a=槽位数组池下标             → 弹 binds 数组,逐个 deepCopy 存槽
  CONCAT: 28,      // a=n                          → 弹 n 段插值
  ITERNEW: 29,     //                              → 弹集合 push 迭代器
  ITERNEXT: 30,    // a=耗尽跳转目标               → peek 迭代器;push 下一值或跳
  RANGE: 31,       //                              → 弹 hi, lo
  DUP: 32,         //                              → 复制栈顶
  SWAP: 33,        //                              → 交换栈顶两个
  CAST: 40,        // a=目标类型名池下标            → 弹 v push 转换值
  PANICX: 41,      // 不可达/内部错误:弹出消息并 panic
  // ---- 融合指令(v0.9:c 槽存子操作码)----
  ADDI: 42,        // a=槽,c=±1                    → 局部 ± 1 并存(含溢出检查)
  BINSETI: 43,     // a=槽,b=字面量池下标,c=BIN 码  → 局部 OP 字面量 并存
  BINSET2: 44,     // a=dst 槽,b=打包(s1<<8|s2),c=BIN 码 → 局部 OP 局部 并存
  SYNC_ENTER: 45,  // 进入 scoped 并发块
  SYNC_EXIT: 46,   // 退出 scoped 并发块(自动 join 未完成子任务;子 panic 上抛)
  ASM: 47,         // v0.74(ADR-006):asm 块——仅 C 后端真实执行;VM 执行到即 M4017 具名回落
};

// 约定:compileExpr 恰好在栈上留下 1 个值(Ret/Break/Continue 等不产值的语句在 compileStmt 层处理)。
// PATMATCH 消费栈顶(被匹配值),push binds 数组或 null。

export const BIN = {
  '+': 1, '-': 2, '*': 3, '/': 4, '%': 5,
  '<<': 6, '>>': 7, '&': 8, '|': 9, '^': 10,
  '==': 11, '!=': 12, '<': 13, '<=': 14, '>': 15, '>=': 16,
  '&&': 17, '||': 18,
};

// 常量池条目类型:V 值 | {str} | {array} | {capture plan} | {enum spec} | {slots}
// 以下列 tag 区分:V 对象自带 .t;包装对象用 {__tag:'str'|'array'|'plan'|'enumspec'|'slots', v}

export function compile(checkResult) {
  const c = new BytecodeCompiler(checkResult);
  const built = c.run();
  built.wasm = c.tryWasm(); // v0.11:纯数值/字符串函数分层编译(失败静默回落 JS VM)
  // O1(plan §4.16.3):字节码优化管线 —— 常量折叠(P1)→ 分支裁剪+跳转线程(P2)→
  // 死代码消除(P3),fixpoint ≤ 10,语义保持(合同见 src/opt.js 文件头)。
  // 集成位置在 tryWasm 之后:wasm 层从 AST 独立发射、不经字节码管线,本钩子对其
  // 零影响;wasm 导入引用的 spans 数组本管线只读不写(spanIdx 原样保留),panic
  // 位置逐字不变。--no-opt / MING_NO_OPT=1 时逐字节原样返回(optimize 内判定)。
  optimize(built);
  // v0.59 P1 审查 MINOR:删除死代码 `if (built.wasm && c.strConsts) ...`——
  // BytecodeCompiler 无 strConsts 字段;strConsts 已由 WasmCompiler.run() 随产物返回。
  return built;
}

// v0.87(§4.13.7)/v0.88(§4.13.7 四边界):函数体是否含"携带归一规格的标注 let"(递归
// 遍历;WeakSet 防环 + 深度限防御)。v0.87 只认 PIdent 模式的裸窄型标注;v0.88 扩展为
// 规格树判据 declaredSpecOfTyAst——Vec[窄] 标注({el})/元组标注({ts},PIdent 或
// PTuple 模式)一并命中:let 绑定处 tree/VM 归一(元素/分量标签收窄),wasm 执行该
// 函数(裸 i64,无 fits 门)即三腿分歧 → 必须排除出 wasm 分层(v0.87 同理由)。
// 用途 = tryWasm 窄型 let 门禁(见其内注释)。struct 字段 ctor 归一形态(StructLit)
// 不在此列:含 StructLit 的函数 wasm shape 阶段即 REJECT("表达式 StructLit"),
// 元组/Vec 窄值经传参/返回进 wasm 的入口也已被 shape 拒绝(实测见 v0.88 报告)。
function declHasNarrowLet(node, seen = new WeakSet(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 500) return false;
  if (seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const x of node) if (declHasNarrowLet(x, seen, depth + 1)) return true;
    return false;
  }
  if (node.nt === 'Let'
      && (node.pat?.nt === 'PIdent' || node.pat?.nt === 'PTuple')
      && declaredSpecOfTyAst(node.type)) return true;
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === 'object') {
      if (declHasNarrowLet(v, seen, depth + 1)) return true;
    }
  }
  return false;
}

class BytecodeCompiler {
  constructor(check) {
    this.check = check;
    this.pool = [];           // 常量池
    this.poolIdx = new Map(); // 结构化缓存(str 值等)
    this.spans = [];
    this.functions = [];      // {name, modFile, nParams, nLocals, code, entry}
    this.fnIndexOf = new Map(); // fnEntry/decl → 函数下标
    this.patterns = [];
    this.constEval = new Interp(check, { capture: true }); // 仅用于编译期常量求值
  }

  sp(span) {
    const key = span ? `${span.line}:${span.col}` : '0';
    let idx = this.spanIdx?.get(key);
    if (idx === undefined) {
      idx = this.spans.length;
      (this.spanIdx ??= new Map()).set(key, idx);
      this.spans.push(span ?? null);
    }
    return idx;
  }

  poolAdd(v) {
    // 对 V 值直接入池;包装对象带 __tag(仅 str/array 可安全 JSON 缓存,其余直接入池)
    if (v !== null && typeof v === 'object' && '__tag' in v) {
      if (v.__tag === 'str' || v.__tag === 'array') {
        const key = '__tag:' + v.__tag + ':' + JSON.stringify(v.v, (k, x) => typeof x === 'bigint' ? x.toString() + 'n' : x);
        if (this.poolIdx.has(key)) return this.poolIdx.get(key);
        const idx = this.pool.length;
        this.pool.push(v);
        this.poolIdx.set(key, idx);
        return idx;
      }
      const idx = this.pool.length;
      this.pool.push(v);
      return idx;
    }
    const idx = this.pool.length;
    this.pool.push(v);
    return idx;
  }

  pstr(s) { return this.poolAdd({ __tag: 'str', v: s }); }
  parr(a) { return this.poolAdd({ __tag: 'array', v: a }); }

  run() {
    // 1) 常量池:模级 const 求值(用临时树引擎,init 中引用其他 const 由 cvalue 缓存支持)
    const constVals = new Map(); // entry → poolIdx
    for (const mod of this.check.modules) {
      for (const [, entry] of mod.items) {
        if (entry.kind !== 'const') continue;
        const v = this.constEval.evalExpr(entry.decl.init, { vars: new Map(), parent: null, mod });
        constVals.set(entry, this.poolAdd(v));
      }
    }
    this.constVals = constVals;
    this.constEntryVals = constVals;

    // 2) prelude None
    this.noneIdx = this.poolAdd(V.enumv('builtin-opt', 'None', []));    // 3) 收集所有函数:模块函数 + impl 方法 + test 块
    const fnEntries = [];
    for (const mod of this.check.modules) {
      for (const [, entry] of mod.items) {
        if ((entry.kind === 'fn' || entry.kind === 'test') && entry.decl.body && !entry.poisoned) fnEntries.push({ entry, mod });
      }
      for (const mEntry of this.check.methodEntries ?? []) {
        if (mEntry.mod === mod) fnEntries.push({ entry: mEntry, mod });
      }
    }
    // 预分配函数下标(递归/LDFN 需要引用)
    const entryFnIdx = new Map();
    for (const { entry, mod } of fnEntries) {
      entryFnIdx.set(entry, this.functions.length);
      this.functions.push(null); // 占位
      void mod;
    }
    this.entryFnIdx = entryFnIdx;
    for (const { entry, mod } of fnEntries) {
      const idx = entryFnIdx.get(entry);
      const name = entry.methodName ? `${entry.decl.name}(${mod.file})` : (entry.kind === 'test' ? `test ${entry.decl.name}` : entry.decl.name);
      this.curFnIdx = idx;
      const body = this.compileFunctionBody(entry, mod);
      this.functions[idx] = {
        name,
        modFile: mod.file,
        nParams: entry.sig?.params?.length ?? 0,
        nLocals: body.nLocals,
        code: body.code,
        entry,
      };
    }

    // 4) main
    const mainEntry = this.check.entry.items.get('main');
    let mainFnIdx = -1;
    if (mainEntry && mainEntry.kind === 'fn') mainFnIdx = entryFnIdx.get(mainEntry) ?? -1;

    return {
      functions: this.functions,
      pool: this.pool,
      patterns: this.patterns,
      spans: this.spans,
      mainFnIdx,
      entryFnIdx,
      methodImpls: this.check.methodImpls,
    };
  }

  // ---------- WASM 后端(v0.11):纯整数函数分层编译,失败静默回落 JS VM ----------
  tryWasm() {
    if (process.env.MING_WASM_DEBUG) console.error('[tryWasm] functions=' + this.functions.length + ' spans=' + this.spans.length + ' entryFnIdx=' + this.entryFnIdx?.size);
    // v0.61(ADR-002 清单 14):污点资格按载体判定——喂入 wasm.js analyze()(单一事实
    // 来源,不改动)前,把 sig 中的 Untrusted[T] 形参/返回解包为载体 T。编译期标签运行时
    // 擦除:此时全部函数体已编译完毕,就地解包不影响已生成字节码;wasm/C 按载体发射,无感知。
    // v0.82(ADR-008 清单 7 核验,零改动定案):顶层解包已覆盖本窗口全部形态——
    //   · Untrusted[Map[str,str]] 形参:顶层 Untrusted → Map[str,str]('mstr' 句柄槽,v0.59 #41);
    //   · Vec[Untrusted[str]] 形参(argv 元素级):顶层是 Vec 不解包 → typeToNumTy 对 untrusted
    //     元素返回 null → paramSlotTy 回落 'vi64' 句柄槽(v0.80 v80.17(a) 锁定的资格形态)。
    //     实测不可改为元素级解包:解出 'vstr' 槽会改变 objTable 操作面资格(vs.len() 非直接
    //     调用回落),翻转 v80.17(a) 的锁定行为——元素级保持 vi64 句柄口径即"零新机制"。
    for (const f of this.functions) {
      if (!f?.entry?.sig) continue;
      const carrier = (t) => (t && t.k === 'untrusted') ? t.el : t;
      // N-61.2(v0.83 卫生件):解包前 clone entry/sig——checker 的原始 entry.sig 结构
      // 不再被原地改写(compile 之后再读 checker 签名的功能不会踩到解包后形状;原 sig
      // 对象原样保留)。compiled.functions[].entry 指向浅拷贝 clone(其 sig 已解包),
      // AOT 序列化/v88.11a 白盒/wasm 编组读的都是 clone——形状与 v0.61–v0.82 的
      // 原地解包结果逐字相同,行为零变化。entryFnIdx 仍以 checker 原始 entry 对象为键
      // (resolveMingFn/vm indexOfEntry 按原始 entry 查找,不受 clone 影响)。
      f.entry = {
        ...f.entry,
        sig: {
          ...f.entry.sig,
          params: (f.entry.sig.params ?? []).map((p) => ({ ...p, type: carrier(p.type) })),
          ret: carrier(f.entry.sig.ret),
        },
      };
      // v0.87(§4.13.7):窄型 let 门禁——含窄型标注 let 的函数排除出 wasm 分层。
      // 缘由(实测):wasm 槽是裸 i64,窄型算术无 fits 门(emitCheckedOp 仅 i64/u64
      // 两型;窄型字面量/`as`/窄型形参各有既有拒绝路径,唯窄型 let 标注静默通过——
      // 修复前 tree/VM 同样静默,三腿一致;本版归一后 tree/VM 在算术处 M4002,wasm
      // 若仍执行该函数即三腿分歧,违反硬规则 1)。处理 = 让该函数按既有资格不动点
      // 回落字节码(VM 归一 + intBin 窄型 fits 门 → 与 tree 逐字)。机制:analyze()
      // 对 decl.requires/ensures 真值的函数跳过资格(clone decl 置标记,不影响 checker
      // 原始 decl 与 tree 引擎;调用方经资格不动点同步回落)。**已内化(v0.87 审查 MINOR-3 架构师落实)**:
      // wasm.js analyze() 资格循环新增 declHasNarrowLet 具名条款(独立副本避免循环导入,
      // 两处注释互指);本 clone 标记保留作纵深防御(条款不达时兜底)。
      // 覆盖面说明:窄型值进入 eligible 函数仅余此通道——窄型形参/返回被 isEligibleShape
      // numOk(bits===64) 拒绝,窄型字面量被发射期 Unsupported('非 64 位字面量') 拒绝,
      // `as` 被Unsupported('表达式 As') 拒绝;无窄型 let 的函数不受影响。
      if (!f.entry.decl?.requires && !f.entry.decl?.ensures && declHasNarrowLet(f.entry.decl?.body)) {
        f.entry = {
          ...f.entry,
          decl: { ...f.entry.decl, requires: { __v87NarrowGate: true, expr: null, span: null } },
        };
      }
    }
    try {
      return tryCompileWasm(this.check, {
        functions: this.functions,
        spans: this.spans,
        entryFnIdx: this.entryFnIdx,
      });
    } catch (e) {
      if (process.env.MING_WASM_DEBUG) console.error('[tryWasm] THREW: ' + e.message);
      return null;
    }
  }

  // ---------- 函数体 ----------
  compileFunctionBody(entry, mod) {
    const decl = entry.decl;
    const code = [];
    const st = {
      code,
      nLocals: 0,
      scopes: [new Map()], // 层级名→槽(函数内扁平:嵌套块分配新槽)
      captures: null,      // 仅 lambda:Map<name, capIdx>
      mod,
      entry,
    };
    // 参数槽
    const paramSlots = new Map();
    for (const p of entry.sig?.params ?? []) {
      const slot = st.nLocals++;
      st.scopes[0].set(p.name, slot);
      paramSlots.set(p.name, slot);
    }
    // 契约:requires/ensures(v0.45)
    let resultSlot = null;
    if (decl.ensures) {
      resultSlot = st.nLocals++;
      // v0.56(A1):内部 result 槽不再写进名字映射——形参同名 result 时不会互相覆盖;
      // ensures 由 compileContractExpr 的专用解析读取该槽。
    }
    st.resultSlot = resultSlot;
    // v0.56(A1):合约名字解析白名单 = 形参 + result。函数体 let/本地 fn 不参与。
    st.contractParams = paramSlots;
    st.inContract = false;
    // requires 入口检查
    if (decl.requires) {
      this.compileExpr(decl.requires.expr, st);
      this.compileContractFail(st, decl.requires.msg ? `契约违反: ${decl.requires.msg}` : '契约违反: requires', decl.requires.span ?? decl.span, (st) => { this.emit(st, OP.CONST, this.poolAdd(V.bool(false)), 0, decl.requires.span ?? decl.span); });
    }
    // 函数体的块值 = 返回值 → want=true
    this.pushScope(st);
    // v0.59(#44):函数体顶层的本地函数同样预编译(块级条目;compileBlock 不经过这里)
    this.precompileLocalFns(decl.body.stmts, st);
    for (const s of decl.body.stmts) {
      if (s.nt === 'FnStmt') continue;
      this.compileStmt(s, st);
    }
    let produced = false;
    if (decl.body.tail) {
      this.compileExpr(decl.body.tail, st);
      produced = true;
      if (decl.ensures && resultSlot !== null) {
        this.emit(st, OP.DUP, 0, 0, decl.body.tail.span);
        this.emit(st, OP.ST, 0, resultSlot, decl.body.tail.span);
        this.compileContractExpr(decl.ensures.expr, st);
        this.compileContractFail(st, decl.ensures.msg ? `契约违反: ${decl.ensures.msg}` : '契约违反: ensures', decl.ensures.span ?? decl.span, (st) => { this.emit(st, OP.LD, 0, resultSlot, decl.ensures.span ?? decl.span); });
      }
    }
    this.popScope(st);
    if (!produced) this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, decl.body.span);
    this.emit(st, OP.RET, 0, 0, decl.body.span ?? null);
    return { code, nLocals: st.nLocals };
  }

  emit(st, op, a, b, span, c = 0) {
    st.code.push([op, a, b, c, this.sp(span)]);
  }

  // v0.56(A1):编译 ensures 表达式——专用解析域:只有形参槽与 result 槽可见。
  // (body 的 let/捕获/本地 fn 不得遮蔽契约中的同名名字;模块级 const/fn 仍经
  //  compileNamedValue 解析,保持契约里调用纯函数的能力。)
  compileContractExpr(expr, st) {
    const saved = st.inContract;
    const savedBase = st.contractScopeBase;
    st.inContract = true;
    // v0.56(C1):契约表达式自身压入的作用域(match 臂变量、if 块内 let)从当前
    // 作用域栈深度起算;resolveName 只搜索该基线之上的槽,函数体作用域仍不可见。
    st.contractScopeBase = st.scopes.length;
    try { this.compileExpr(expr, st); }
    finally { st.inContract = saved; st.contractScopeBase = savedBase; }
  }
  compileContractFail(st, msg, span, loadActual) {
    const jFalse = st.code.length;
    this.emit(st, OP.JUMPFALSE, 0, 0, span);
    const jSkip = st.code.length;
    this.emit(st, OP.JUMP, 0, 0, span);
    this.patch(st, jFalse, st.code.length);
    this.emit(st, OP.CONST, this.poolAdd({ __tag: 'str', v: '__builtin:contract_fail' }), 0, span);
    this.emit(st, OP.CONST, this.pstr(msg), 0, span);
    if (loadActual) loadActual(st); else this.emit(st, OP.CONST, this.poolAdd(V.bool(false)), 0, span);
    this.emit(st, OP.CALL, 2, 0, span);
    this.patch(st, jSkip, st.code.length);
  }

  here(st) { return st.code.length; }
  patch(st, at, a) { st.code[at][1] = a; }

  declareLocal(st, name) {
    const slot = st.nLocals++;
    st.scopes[st.scopes.length - 1].set(name, slot);
    return slot;
  }

  pushScope(st) { st.scopes.push(new Map()); }
  popScope(st) { st.scopes.pop(); }

  // 名字解析:局部槽 | 捕获下标 | 本地函数(函数表下标) | null(交由运行时全局解析)
  // v0.59-B3:同层内 let 槽(数字)与本地函数绑定('fn:N')都参与解析,按"词法最近层"胜出
  // (同块同名已由 checker M3009 拒绝,层内先后不敏感);此前只认数字槽,外层变量会
  // 越过内层本地函数导致 tree/VM 解析优先级相反。
  resolveName(st, name) {
    // v0.56(A1):契约表达式只解析形参槽与 result 槽(函数体局部/捕获不可见)。
    // `result` 恒指返回值槽,即使形参也叫 result(形参槽仍用于函数体)。
    // v0.59-B1:本地函数自身的契约额外可见同块兄弟(contractFnBinds,含自身——
    // 自引用 requires/ensures 在 tree 侧即无限递归 M4005,VM 对齐同一行为)。
    if (st.inContract) {
      if (name === 'result' && st.resultSlot != null) return { kind: 'local', slot: st.resultSlot };
      // v0.56(C1):契约表达式自身的作用域(match 臂模式变量、if 块内 let 等)按词法
      // 遮蔽优先于形参;基线以下(函数体/形参作用域)与 captures 一律不可见。
      const base = st.contractScopeBase ?? st.scopes.length;
      for (let i = st.scopes.length - 1; i >= base; i--) {
        const v = st.scopes[i].get(name);
        if (typeof v === 'number') return { kind: 'local', slot: v };
        if (typeof v === 'string' && v.startsWith('fn:')) return { kind: 'fn', idx: Number(v.slice(3)) };
      }
      if (st.contractParams?.has(name)) return { kind: 'local', slot: st.contractParams.get(name) };
      if (st.contractFnBinds?.has(name)) return { kind: 'fn', idx: Number(String(st.contractFnBinds.get(name)).slice(3)) };
      return null;
    }
    for (let i = st.scopes.length - 1; i >= 0; i--) {
      // v0.59(#44):本地 fn 登记的 'fn:N' 字符串值(独立函数下标)——按 LDFN 解析,
      // 不得当作槽号发射 LD。
      const v = st.scopes[i].get(name);
      if (v !== undefined && typeof v === 'number') {
        return { kind: 'local', slot: v };
      }
      if (typeof v === 'string' && v.startsWith('fn:')) {
        return { kind: 'fn', idx: Number(v.slice(3)) };
      }
    }
    if (st.captures?.has(name)) return { kind: 'cap', idx: st.captures.get(name) };
    return null;
  }

  // v0.59-B2:当前帧可见的本地名字(含 lambda 的 fnBinds——lambda 闭包帧只带形参与
  // 捕获,外层本地函数经 fnBinds 表静态解析为 LDFN,无需捕获)。
  resolveLocalName(st, name) {
    const r = this.resolveName(st, name);
    if (r) return r;
    if (!st.inContract && st.fnBinds?.has(name)) return { kind: 'fn', idx: st.fnBinds.get(name) };
    return null;
  }

  compileBlock(block, st, wantValue) {
    this.pushScope(st);
    // v0.59(#44):同块本地函数预编译——块级条目语义(与 checker checkBlock 预登记、
    // tree execBlock 提升同口径):体内可见同块全部本地 fn(含自身/后声明者),
    // 互递归不要求声明序。函数体先编译(独立帧,无栈序依赖),名字登记进当前作用域。
    this.precompileLocalFns(block.stmts, st);
    for (const s of block.stmts) {
      if (s.nt === 'FnStmt') continue; // 已由预编译处理
      this.compileStmt(s, st);
    }
    let produced = false;
    if (block.tail) {
      this.compileExpr(block.tail, st);
      produced = true;
    }
    this.popScope(st);
    if (wantValue && !produced) this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, block.span);
    if (!wantValue && produced) this.emit(st, OP.POP, 0, 0, block.span);
  }

  // v0.59(#44):预编译 stmts 中的本地函数声明,把 名字 → 'fn:idx' 登记进当前顶层
  // 作用域;返回兄弟绑定表(供子函数帧播种,体内按名解析兄弟/自身)。
  precompileLocalFns(stmts, st) {
    const sibs = new Map();
    for (const s of stmts) {
      if (s.nt !== 'FnStmt') continue;
      const idx = this.functions.length;
      this.functions.push(null); // 占位(LDFN 自引用需要先定下标)
      sibs.set(s.decl.name, 'fn:' + idx);
      st.scopes[st.scopes.length - 1].set(s.decl.name, 'fn:' + idx);
    }
    for (const s of stmts) {
      if (s.nt === 'FnStmt') this.compileLocalFn(s.decl, st, sibs);
    }
    return sibs;
  }

  // v0.59(#44):本地函数编译——独立函数帧(与模块函数同机制):
  //   * 递归方案:LDFN(与模块函数递归/LDFN 引用同源)——自引用与兄弟引用在子帧
  //     作用域播种为 'fn:idx' 字符串,体内按名调用经 compileIdentValue → LDFN 解析;
  //   * 捕获:不支持(与 tree callLocalFn 帧 parent:null、checker 隔离体作用域同口径;
  //     引用外层局部在 check 阶段已被拒绝,这里无需捕获计划);
  //   * 契约:requires/ensures 按模块函数同口径发射(resultSlot 机制);
  //   * 作值:名字引用发射 LDFN → vclose(空捕获),callValue/HOF 直接可调。
  compileLocalFn(d, st, siblingBinds) {
    const idx = Number(siblingBinds.get(d.name).slice(3));
    const saved = { scopes: st.scopes, captures: st.captures, nLocals: st.nLocals, mod: st.mod, entry: st.entry, curFnIdx: this.curFnIdx, contractParams: st.contractParams, inContract: st.inContract, contractScopeBase: st.contractScopeBase, resultSlot: st.resultSlot };
    this.curFnIdx = idx;
    const checked = d.checkedSig;
    const sub = {
      code: [], nLocals: 0,
      // 作用域布局:[兄弟 fn 绑定(fn:N 字符串), 形参数字槽]——resolveName 从栈顶
      // 向下扫描,形参(数字)优先命中,fn 绑定仅被 compileIdentValue 的 LDFN 路径消费
      scopes: [new Map(siblingBinds), new Map()],
      captures: null,
      mod: st.mod,
      // 伪 entry:Return/PostQ 的 ensures 出口检查读取 sub.entry.decl.ensures 与
      // sub.entry.sig.ret.k(checkedSig 为 checker 解析后的真类型)
      entry: { kind: 'fn', decl: d, sig: { params: checked?.params ?? [], ret: checked?.ret ?? null, tparams: checked?.tparams ?? [], effects: checked?.effects ?? new Set() } },
      resultSlot: null,
      inContract: false,
      // v0.59-B1:契约域可见同块兄弟本地函数(含自身)——requires/ensures 里
      // `positive(result)` 经 LDFN 解析;模块函数契约仍不暴露函数体本地 fn
      // (compileFunctionBody 不设此表,v0.56 A1 语义不变)。
      contractFnBinds: siblingBinds,
    };
    const paramSlots = new Map();
    for (const p of d.params) {
      const slot = sub.nLocals++;
      sub.scopes[1].set(p.name, slot);
      paramSlots.set(p.name, slot);
    }
    sub.contractParams = paramSlots;
    // 契约:ensures 存在时分配内部 result 槽(不进名字映射;合约解析专用——模块函数同口径)
    if (d.ensures) {
      sub.resultSlot = sub.nLocals++;
    }
    // 契约:requires 入口检查(模块函数同口径)
    if (d.requires) {
      this.compileExpr(d.requires.expr, sub);
      this.compileContractFail(sub, d.requires.msg ? `契约违反: ${d.requires.msg}` : '契约违反: requires', d.requires.span ?? d.span, (st2) => { this.emit(st2, OP.CONST, this.poolAdd(V.bool(false)), 0, d.requires.span ?? d.span); });
    }
    // 函数体:块尾值 = 返回值;ensures 在尾值/return/? 出口检查(经 sub.entry.decl.ensures)
    this.pushScope(sub);
    this.precompileLocalFns(d.body.stmts, sub);
    for (const s of d.body.stmts) {
      if (s.nt === 'FnStmt') continue;
      this.compileStmt(s, sub);
    }
    let produced = false;
    if (d.body.tail) {
      this.compileExpr(d.body.tail, sub);
      produced = true;
      const ensures = d.ensures;
      if (ensures && sub.resultSlot !== null) {
        this.emit(sub, OP.DUP, 0, 0, d.body.tail.span);
        this.emit(sub, OP.ST, 0, sub.resultSlot, d.body.tail.span);
        this.compileContractExpr(ensures.expr, sub);
        this.compileContractFail(sub, ensures.msg ? `契约违反: ${ensures.msg}` : '契约违反: ensures', ensures.span ?? d.span, (st2) => { this.emit(st2, OP.LD, 0, sub.resultSlot, ensures.span ?? d.span); });
      }
    }
    this.popScope(sub);
    if (!produced) this.emit(sub, OP.CONST, this.poolAdd(UNIT), 0, d.body.span);
    this.emit(sub, OP.RET, 0, 0, d.body.span ?? null);
    // name 用裸 decl 名(与 tree callStack 显示一致;此前 '(local)' 后缀会造成
    // panic 调用链 tree/VM 首行后的帧名分歧)。
    // v0.59(#44):附带最小 entry(仅签名、无 decl.body)——AOT artifact 序列化契约要求
    // 每个函数有 entry.sig(此前本地函数缺签名使 ming build 回退源码模式);无 body 使
    // wasm 资格判定(isEligibleShape 要求 entry.decl.body)保持保守拒绝,不影响 wasm 覆盖。
    this.functions[idx] = {
      name: d.name, modFile: st.mod.file, nParams: d.params.length, nLocals: sub.nLocals, code: sub.code, local: true,
      entry: {
        kind: 'fn',
        decl: { name: d.name, span: d.span ?? null },
        sig: { params: checked?.params ?? [], ret: checked?.ret ?? { k: 'unit' }, tparams: checked?.tparams ?? [], effects: checked?.effects ?? new Set() },
      },
    };
    this.curFnIdx = saved.curFnIdx;
    return idx;
  }

  compileStmt(s, st) {
    switch (s.nt) {
      case 'Let': {
        // v0.87(§4.13.7)/v0.88(§4.13.7 四边界):绑定归一规格——按"模式位置 × 标注"
        // 构建规格树。PIdent 叶沿用 V.int(0,bits,signed) 池载体(v0.87 产物/池布局
        // 兼容);规格树(Vec[窄] {el} / 元组 {ts})入池 __tag 'spec'(artifact 纯数据
        // 透传)。PTuple 模式把规格传给 compileLetPattern:逐绑定槽 BIND specarr +
        // narrowSlots 登记(SET 归一)。ST/BIND c 操作数携带池下标,VM 绑定处归一;
        // tree 引擎同口径(declaredSpecOfPatAst + normBindValue)。池 0 号位被 run()
        // 预置的 None 常量占用,specIdx 恒 ≥1,c=0 编码"无规格"无歧义。
        const spec = s.pat.nt === 'PWild' ? null : declaredSpecOfPatAst(s.pat, s.type);
        if (s.pat.nt === 'PTuple') {
          if (s.init) this.compileExpr(s.init, st);
          else this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, s.span);
          this.compileLetPattern(s.pat, st, 0, spec);
        } else {
          const specIdx = spec ? this.poolAddSpec(spec) : 0;
          if (s.init) this.compileExpr(s.init, st);
          else this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, s.span);
          this.compileLetPattern(s.pat, st, specIdx);
        }
        return;
      }
      case 'Assign': {
        // ---- 窥孔融合(v0.9):局部槽上的高频赋值模式(仅纯运算;&&/|| 有短路不融合)----
        const pureOp = (op) => op !== '&&' && op !== '||';
        const localSlotOf = (name) => {
          const r = this.resolveName(st, name);
          return r && r.kind === 'local' ? r.slot : null;
        };
        const fused = (() => {
          if (s.target.nt !== 'Ident' || !pureOp(s.op[0])) return false;
          const dst = localSlotOf(s.target.name);
          if (dst === null) return false;
          // (A) x += 1 / x -= 1(仅当字面量恰为 1;v0.51.6 修复:此前只判 IntLit 不判值,
          // x += 2 也被融成 ADDI +1——树引擎一致通过而 VM 静默算错,违反三引擎合同)
          if ((s.op === '+=' || s.op === '-=') && s.value.nt === 'IntLit' && !s.value.suffix && s.value.v === 1n) {
            this.emit(st, OP.ADDI, dst, s.op === '+=' ? 1 : -1, s.span);
            return true;
          }
          // (B) x OP= 字面量
          if (s.op !== '=' && (s.value.nt === 'IntLit' || s.value.nt === 'FloatLit')) {
            const lit = s.value.nt === 'IntLit' ? V.int(s.value.v, s.value.bits, s.value.signed) : V.float(s.value.v, s.value.bits);
            this.emit(st, OP.BINSETI, dst, this.poolAdd(lit), s.span, BIN[s.op[0]]);
            return true;
          }
          // (C) x OP= 局部 → BINSET2(dst, x, src)
          if (s.op !== '=' && s.value.nt === 'Ident') {
            const src = localSlotOf(s.value.name);
            if (src !== null) {
              this.emit(st, OP.BINSET2, dst, (dst << 8) | src, s.span, BIN[s.op[0]]);
              return true;
            }
          }
          // (D) x = 局部 OP 局部
          if (s.op === '=' && s.value.nt === 'Binary' && s.value.l.nt === 'Ident' && s.value.r.nt === 'Ident') {
            const s1 = localSlotOf(s.value.l.name);
            const s2 = localSlotOf(s.value.r.name);
            if (s1 !== null && s2 !== null) {
              this.emit(st, OP.BINSET2, dst, (s1 << 8) | s2, s.span, BIN[s.value.op]);
              return true;
            }
          }
          return false;
        })();
        if (fused) return;
        // ---- 通用路径 ----
        // 栈序约定:SETINDEX/SETFIELD 弹出 (val, [idx,] base)
        // 因此 Field/Index 目标必须先编译 target 组件,再编译值;复合赋值重读旧值不影响正确性
        if (s.target.nt === 'Index') {
          this.compileExpr(s.target.base, st);
          this.compileExpr(s.target.index, st);
          if (s.op !== '=') {
            // 旧值:重读一遍 base[idx](栈:base idx base idx old → BIN → base idx new)
            this.compileExpr(s.target, st);
            this.compileExpr(s.value, st);
            this.emit(st, OP.BIN, BIN[s.op[0]], 0, s.span);
          } else {
            this.compileExpr(s.value, st);
          }
          // v0.64 #58:SETINDEX span 用 target.span(Index 节点,`[` 起)对齐 tree(interp.js:856)
          // 与 wasm(wasm.js Assign 元素写,span = target.span)——越界写 M4003 位置三引擎一致
          this.emit(st, OP.SETINDEX, 0, 0, s.target.span);
          return;
        }
        if (s.target.nt === 'Field') {
          this.compileExpr(s.target.base, st);
          if (s.op !== '=') {
            this.compileExpr(s.target, st);
            this.compileExpr(s.value, st);
            this.emit(st, OP.BIN, BIN[s.op[0]], 0, s.span);
          } else {
            this.compileExpr(s.value, st);
          }
          this.emit(st, OP.SETFIELD, this.pstr(s.target.name), 0, this.sp(s.span));
          return;
        }
        if (s.op !== '=') {
          // Ident 复合:读旧值 → 值 → BIN → SET
          this.compilePlaceRead(s.target, st);
          this.compileExpr(s.value, st);
          this.emit(st, OP.BIN, BIN[s.op[0]], 0, s.span);
          this.compilePlaceStore(s.target, st);
        } else {
          this.compileExpr(s.value, st);
          this.compilePlaceStore(s.target, st);
        }
        return;
      }
      case 'Return': {
        if (s.value) this.compileExpr(s.value, st);
        else this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, s.span);
        const ensures = st.entry?.decl?.ensures;
        // v0.56(C2):用 != null 判定——lambda/本地函数子状态的 resultSlot 为
        // undefined/null 时不得把外层 ensures 编译进子帧。
        if (ensures && st.resultSlot != null) {
          this.emit(st, OP.DUP, 0, 0, s.span);
          this.emit(st, OP.ST, 0, st.resultSlot, s.span);
          this.compileContractExpr(ensures.expr, st);
          this.compileContractFail(st, ensures.msg ? `契约违反: ${ensures.msg}` : '契约违反: ensures', ensures.span ?? s.span, (st) => { this.emit(st, OP.LD, 0, st.resultSlot, ensures.span ?? s.span); });
        }
        this.emit(st, OP.RET, 0, 0, s.span);
        return;
      }
      case 'Break': case 'Continue': {
        // 由循环上下文回填(编译时通过 breakCtx 栈)
        const bctx = st.breakCtx?.[st.breakCtx.length - 1];
        // v0.79(#71):lambda/本地函数体是新函数边界——compileLambda/compileLocalFn 子状态
        // 不含 breakCtx(不继承外层循环上下文),裸 continue/break 已由 checker 在函数边界
        // 拒绝(M3010/M3011;checkLambda 自 v0.79 起重置 inLoop)。此处为纵深防御断言:
        // 此前发射裸 POP(无 JUMP 落点)会弹穿全帧共享的操作数栈,静默破坏栈平衡直至
        // 内部错误崩溃——改为具名 CompileError(经 reportCompileError 以
        // "内部错误(字节码编译器):" 诊断形态输出),修复后不可达;若到达即为
        // checker 与编译器边界不一致的工具链 bug,请附最小复现报告。
        if (!bctx) throw new CompileError('lambda/本地函数体内的 break/continue 缺少循环上下文(checker 已拦截,不应到达)', s.span);
        // v0.78 #70:match 臂内的 break/continue 跳出时,先弹掉本循环内仍活着的
        // match 宗量临时值。match 编译把宗量留在操作数栈上跨越整个臂体——continue
        // 直跳循环头会让 for 的 ITERNEXT 把栈顶宗量误当迭代器(iter.next 崩溃,
        // tree 引擎因递归求值无此问题);while 虽不崩但每轮泄漏一个宗量值。
        // popN = 循环登记之后新开的 match 宗量层数;循环之前(外层 match)的宗量
        // 位于迭代器之下、仍被外层 match 使用,必须保留。
        const popN = (st.matchTemps ?? 0) - (bctx.matchTemps ?? 0);
        for (let i = 0; i < popN; i++) this.emit(st, OP.POP, 0, 0, s.span);
        if (s.nt === 'Break') {
          this.emit(st, OP.JUMP, 0, 0, s.span);
          bctx.breaks.push(this.here(st) - 1);
        } else {
          this.emit(st, OP.JUMP, 0, 0, s.span);
          bctx.continues.push(this.here(st) - 1);
        }
        return;
      }
      case 'While': {
        const b = { breaks: [], continues: [], matchTemps: st.matchTemps ?? 0 };
        (st.breakCtx ??= []).push(b);
        const top = this.here(st);
        this.compileExpr(s.cond, st);           // [cond]
        this.emit(st, OP.JUMPFALSE, 0, 0, s.span); // 弹 cond
        const jEnd = this.here(st) - 1;
        this.compileBlock(s.body, st, false);
        this.emit(st, OP.JUMP, top, 0, s.span);
        this.patch(st, jEnd, this.here(st));
        st.breakCtx.pop();
        for (const j of b.breaks) this.patch(st, j, this.here(st));
        for (const j of b.continues) this.patch(st, j, top);
        return;
      }
      case 'WhileLet': {
        const b = { breaks: [], continues: [], matchTemps: st.matchTemps ?? 0 };
        (st.breakCtx ??= []).push(b);
        const top = this.here(st);
        this.compileExpr(s.expr, st);                    // [v]
        const simple = s.pat.nt === 'PIdent' ? 'ident' : (s.pat.nt === 'PWild' ? 'wild' : null);
        if (simple === 'ident') {
          // 窥孔:直接绑定(while let 通常就是 Option 解包)
          const slot = this.declareLocal(st, s.pat.name);
          this.emit(st, OP.ST, 0, slot, s.pat.span);
          // 直接绑定没有"未命中退出"路径,除非模式可反驳——while let 只允许 ident/wild/元组,
          // ident/wild 恒命中 → 无退出条件,此处不会到达(检查器要求 Option 等可反驳模式用 PATMATCH 路径)
          // 防御:恒真循环体由 body 内 break/return 退出
          this.pushScope(st);
          this.compileBlock(s.body, st, false);
          this.popScope(st);
          this.emit(st, OP.JUMP, top, 0, s.span);
          st.breakCtx.pop();
          for (const j of b.breaks) this.patch(st, j, this.here(st));
          for (const j of b.continues) this.patch(st, j, top);
          return;
        }
        this.emit(st, OP.PATMATCH, this.patternAdd(s.pat), 0, s.span); // 弹 v → binds|null
        this.emit(st, OP.JUMPNONE, 0, 0, s.span);        // null → 弹出并跳
        const jEnd = this.here(st) - 1;
        this.pushScope(st);
        this.emitBinds(s.pat, st);
        this.compileBlock(s.body, st, false);
        this.popScope(st);
        this.emit(st, OP.JUMP, top, 0, s.span);
        this.patch(st, jEnd, this.here(st));
        st.breakCtx.pop();
        for (const j of b.breaks) this.patch(st, j, this.here(st));
        for (const j of b.continues) this.patch(st, j, top);
        return;
      }
      case 'For': {
        this.compileExpr(s.iter, st);                    // [iter]
        this.emit(st, OP.ITERNEW, 0, 0, s.span);
        const b = { breaks: [], continues: [], matchTemps: st.matchTemps ?? 0 };
        (st.breakCtx ??= []).push(b);
        const top = this.here(st);
        this.emit(st, OP.ITERNEXT, 0, 0, s.span);        // peek 迭代器;push 值或跳
        const jEnd = this.here(st) - 1;
        // 窥孔:简单绑定模式(i/_)不经模式机器,直接 ST/POP
        const simple = s.pat.nt === 'PIdent' ? 'ident' : (s.pat.nt === 'PWild' ? 'wild' : null);
        let jNo = -1;
        this.pushScope(st);
        if (simple === 'ident') {
          const slot = this.declareLocal(st, s.pat.name);
          this.emit(st, OP.ST, 0, slot, s.pat.span);     // 弹值(深拷贝)存槽
        } else if (simple === 'wild') {
          this.emit(st, OP.POP, 0, 0, s.pat.span);
        } else {
          this.emit(st, OP.PATMATCH, this.patternAdd(s.pat), 0, s.pat.span); // 弹值 → binds
          this.emit(st, OP.JUMPNONE, 0, 0, s.span);      // 防御(检查器保证可反驳不出现)
          jNo = this.here(st) - 1;
          this.emitBinds(s.pat, st);
        }
        this.compileBlock(s.body, st, false);
        this.emit(st, OP.JUMP, top, 0, s.span);
        // 耗尽 / 防御 / break 落点:弹出迭代器
        this.patch(st, jEnd, this.here(st));
        if (!simple) this.patch(st, jNo, this.here(st));
        st.breakCtx.pop();
        for (const j of b.breaks) this.patch(st, j, this.here(st));
        for (const j of b.continues) this.patch(st, j, top);
        this.emit(st, OP.POP, 0, 0, s.span);             // 弹迭代器
        this.popScope(st);
        return;
      }
      case 'SyncScopeBlock': {
        // scoped 块:SYNC_ENTER + 块体 + SYNC_EXIT;异常展开由 callCompiled 兜底 drain
        this.emit(st, OP.SYNC_ENTER, 0, 0, s.span);
        this.compileBlock(s.body, st, false);
        this.emit(st, OP.SYNC_EXIT, 0, 0, s.span);
        return;
      }
      case 'UnsafeBlock': {
        // v0.54:unsafe 块只是类型层门禁;VM 执行指针操作时由 callStd / callMethod
        // 以 M4016 诚实拒绝(C 后端阶段 2 兑现真实内存语义)
        this.compileBlock(s.body, st, false);
        return;
      }
      case 'AsmBlock': {
        // v0.74(ADR-006 §2):asm 块仅由 C 原生后端真实执行——编译为单条 ASM 指令,
        // VM 执行到即 M4017 具名回落(与 tree 引擎 execStmt 消息逐字一致)。
        // 含 asm 函数的效果集含 'asm' → wasm effectOk 拒绝 → 永不 wasm eligible,无分叉。
        this.emit(st, OP.ASM, 0, 0, s.span);
        return;
      }
      case 'Loop': {
        const b = { breaks: [], continues: [], matchTemps: st.matchTemps ?? 0 };
        (st.breakCtx ??= []).push(b);
        const top = this.here(st);
        this.compileBlock(s.body, st, false);
        this.emit(st, OP.JUMP, top, 0, s.span);
        st.breakCtx.pop();
        for (const j of b.breaks) this.patch(st, j, this.here(st));
        for (const j of b.continues) this.patch(st, j, top);
        // break 落点:loop 表达式值 = unit(语句位置会被 POP)
        this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, s.span);
        return;
      }
      case 'ExprStmt': {
        this.compileExpr(s.expr, st, true); // 恒 1 值
        this.emit(st, OP.POP, 0, 0, s.span);
        return;
      }
      case 'FnStmt': {
        // v0.59(#44):本地函数由 precompileLocalFns(compileBlock/compileFunctionBody
        // 的预编译 pass)统一处理——块级条目语义,语句遍历到此处时必然已被编译过。
        // 此分支仅为防御:直连 compileStmt 的未知路径不再崩溃(静默跳过,名字未登记
        // 时调用点会得到明确的"名字未解析"编译错误)。
        return;
      }
      default:
        throw new Error('compileStmt: ' + s.nt);
    }
  }

  // v0.88(§4.13.7):规格入池——叶沿用 V.int(0,bits,signed) 载体(v0.87 池条目形态
  // 不变);规格树走 __tag 'spec'(artifact 纯数据透传,resolveConst 解包)。
  poolAddSpec(spec) {
    if (spec.bits !== undefined) return this.poolAdd(V.int(0, spec.bits, spec.signed));
    return this.poolAdd({ __tag: 'spec', v: spec });
  }

  // let 的绑定模式:ident / _ / 元组
  // v0.87(§4.13.7)/v0.88(§4.13.7 四边界):specIdx = 归一规格池下标(PIdent;ST c
  // 操作数携带 → VM 绑定处归一,旧产物 c=0 additive 兼容);patSpec = 元组模式规格树
  // (PTuple;逐绑定槽 BIND specarr + narrowSlots 登记,重赋值 SET 归一)。
  compileLetPattern(pat, st, specIdx = 0, patSpec = null) {
    switch (pat.nt) {
      case 'PIdent': {
        const slot = this.declareLocal(st, pat.name);
        if (specIdx) {
          (st.narrowSlots ??= new Map()).set(slot, specIdx); // 重赋值(SET)归一登记
        }
        this.emit(st, OP.ST, 0, slot, pat.span, specIdx);
        return;
      }
      case 'PWild': {
        this.emit(st, OP.POP, 0, 0, pat.span);
        return;
      }
      case 'PTuple': {
        this.emit(st, OP.PATMATCH, this.patternAdd(pat), 0, pat.span);
        this.emit(st, OP.JUMPNONE, 0, 0, pat.span);
        const j = this.here(st) - 1;
        // v0.88(§4.13.7):逐绑定槽规格——collectPatSpecs 与 collectPatNames 同一 DFS
        // 序(PWild/字面量位跳过,与 slots 对齐);各槽规格入池后 BIND c 携带下标数组
        // (specarr);无规格形态 c=0 与 v0.87 字节相同。
        let specArrIdx = 0;
        if (patSpec?.ts) {
          const specs = [];
          collectPatSpecs(pat, patSpec, specs);
          const idxs = specs.map((sp) => (sp ? this.poolAddSpec(sp) : 0));
          if (idxs.some((x) => x !== 0)) specArrIdx = this.poolAdd({ __tag: 'specarr', v: idxs });
        }
        this.emitBinds(pat, st, specArrIdx);
        this.emit(st, OP.JUMP, 0, 0, pat.span);      // 正常路径跳过防御
        const jSkip = this.here(st) - 1;
        // 防御落点(检查器保证不可达)
        this.emit(st, OP.CONST, this.poolAdd(V.str('内部错误:let 元组模式未命中')), 0, pat.span);
        this.emit(st, OP.PANICX, 0, 0, pat.span);
        this.patch(st, j, this.here(st));
        this.patch(st, jSkip, this.here(st));
        return;
      }
      default:
        throw new Error('let pattern: ' + pat.nt);
    }
  }

  // 发射绑定:栈顶 binds 数组 → 各绑定槽(顺序 = 模式遍历序)
  // v0.88(§4.13.7):specArrIdx 非零时逐槽 narrowSlots 登记(该槽 SET 归一)。
  emitBinds(pat, st, specArrIdx = 0) {
    const names = [];
    collectPatNames(pat, names);
    const slots = names.map(n => this.declareLocal(st, n));
    if (specArrIdx) {
      const idxs = this.pool[specArrIdx].v;
      slots.forEach((slot, i) => {
        if (idxs[i]) (st.narrowSlots ??= new Map()).set(slot, idxs[i]);
      });
    }
    this.emit(st, OP.BIND, this.parr(slots), 0, pat.span, specArrIdx);
  }

  patternAdd(pat) {
    // 模式直接进常量池(VM 从 pool 读取)
    return this.poolAdd({ __tag: 'pat', v: pat });
  }

  // ---------- 左值 ----------
  compilePlaceRead(e, st) {
    switch (e.nt) {
      case 'Ident': {
        const r = this.resolveLocalName(st, e.name);
        if (r?.kind === 'fn') this.emit(st, OP.LDFN, r.idx, 0, e.span);
        else if (r) this.emit(st, OP.LD, r.kind === 'local' ? 0 : 1, r.kind === 'local' ? r.slot : r.idx, e.span);
        else this.compileNamedValue(e.name, st, e.span);
        return;
      }
      case 'Field':
        this.compileExpr(e.base, st);
        return;
      case 'Index':
        this.compileExpr(e.base, st);
        this.compileExpr(e.index, st);
        return;
      default:
        throw new Error('place read: ' + e.nt);
    }
  }

  compilePlaceStore(e, st) {
    switch (e.nt) {
      case 'Ident': {
        const r = this.resolveLocalName(st, e.name);
        if (!r) throw new CompileError('名字未解析:' + e.name + '(赋值目标)', e.span);
        if (r.kind === 'fn') throw new CompileError('不能给本地函数 "' + e.name + '" 赋值', e.span);
        // v0.87(§4.13.7):窄型槽重赋值 → SET c 操作数携带归一规格(let 登记的
        // narrowSlots;捕获槽随审查 MAJOR-2 透传进入子状态 narrowSlots——键为捕获
        // 下标;无标注局部槽/无透传捕获 c=0 不归一)。
        let specIdx = 0;
        specIdx = st.narrowSlots?.get(r.kind === 'local' ? r.slot : r.idx) ?? 0;
        this.emit(st, OP.SET, r.kind === 'local' ? 0 : 1, r.kind === 'local' ? r.slot : r.idx, e.span, specIdx);
        return;
      }
      case 'Field':
        // 栈:base, value(读时已压 base;值在 ST 前压)→ SETFIELD name
        this.emit(st, OP.SETFIELD, this.pstr(e.name), 0, e.span);
        return;
      case 'Index':
        this.emit(st, OP.SETINDEX, 0, 0, e.span);
        return;
      default:
        throw new Error('place store: ' + e.nt);
    }
  }

  // ---------- 表达式 ----------
  // want=false:语句位置,不留值(控制流表达式)
  compileExpr(e, st, want = true) {
    switch (e.nt) {
      case 'IntLit': {
        const v = V.int(e.v, e.bits, e.signed);
        this.emit(st, OP.CONST, this.poolAdd(v), 0, e.span);
        return;
      }
      case 'FloatLit': {
        this.emit(st, OP.CONST, this.poolAdd(V.float(e.v, e.bits)), 0, e.span);
        return;
      }
      case 'BoolLit': {
        this.emit(st, OP.CONST, this.poolAdd(V.bool(e.v)), 0, e.span);
        return;
      }
      case 'StrLit': {
        if (e.parts.length === 1 && 'lit' in e.parts[0]) {
          this.emit(st, OP.CONST, this.poolAdd(V.str(e.parts[0].lit)), 0, e.span);
          return;
        }
        let n = 0;
        for (const p of e.parts) {
          if ('lit' in p) this.emit(st, OP.CONST, this.poolAdd(V.str(p.lit)), 0, e.span);
          else this.compileExpr(p.expr, st);
          n++;
        }
        this.emit(st, OP.CONCAT, n, 0, e.span);
        return;
      }
      case 'Ident': {
        this.compileIdentValue(e, st);
        return;
      }
      case 'Field': {
        // 类型级/模块/构造器路径在 Call 中特判;此处是普通字段访问
        this.compileField(e, st);
        return;
      }
      case 'Call': {
        this.compileCall(e, st, want);
        return;
      }
      case 'Index': {
        this.compileExpr(e.base, st);
        this.compileExpr(e.index, st);
        this.emit(st, OP.INDEX, 0, 0, e.span);
        return;
      }
      case 'Unary': {
        this.compileExpr(e.expr, st);
        this.emit(st, OP.UN, e.op === '-' ? 1 : 2, 0, e.span);
        return;
      }
      case 'Binary': {
        if (e.op === '&&') {
          // 短路:左 → DUP?标准:l;JUMPFALSE keep=false-pushed?
          this.compileExpr(e.l, st);
          this.emit(st, OP.JUMPFALSE, 0, 0, e.span); // 弹 l;false 时跳
          const j = this.here(st) - 1;
          this.compileExpr(e.r, st);   // push bool
          this.emit(st, OP.JUMP, 0, 0, e.span);
          const j2 = this.here(st) - 1;
          this.patch(st, j, this.here(st));
          this.emit(st, OP.CONST, this.poolAdd(V.bool(false)), 0, e.span);
          this.patch(st, j2, this.here(st));
          return;
        }
        if (e.op === '||') {
          // 短路或:l true → 结果 true(跳过 r);l false → 结果 = r
          this.compileExpr(e.l, st);
          this.emit(st, OP.JUMPFALSE, 0, 0, e.span); // 弹 l;false 时跳到 r
          const jR = this.here(st) - 1;
          this.emit(st, OP.CONST, this.poolAdd(V.bool(true)), 0, e.span); // l true → true
          this.emit(st, OP.JUMP, 0, 0, e.span);
          const jE = this.here(st) - 1;
          this.patch(st, jR, this.here(st));
          this.compileExpr(e.r, st);                  // push r
          this.patch(st, jE, this.here(st));
          return;
        }
        this.compileExpr(e.l, st);
        this.compileExpr(e.r, st);
        this.emit(st, OP.BIN, BIN[e.op] ?? 0, 0, e.span);
        return;
      }
      case 'Range': {
        this.compileExpr(e.lo, st);
        this.compileExpr(e.hi, st);
        this.emit(st, OP.RANGE, 0, 0, e.span);
        return;
      }
      case 'As': {
        // as 语义 = castValue:编码为 BIN 特殊?加指令 CAST。
        this.compileExpr(e.expr, st);
        this.emit(st, 40 /* CAST */, this.castTargetId(e.type), 0, e.span);
        return;
      }
      case 'PostQ': {
        // v0.51:? 早退也是返回出口——展开为 match 形字节码,早退前执行 ensures
        const retK = st.entry?.sig?.ret?.k;
        const pat = { nt: 'PEnum', enumName: null, variant: retK === 'opt' ? 'Some' : 'Ok', args: [{ nt: 'PIdent', name: '__q', span: e.span }], span: e.span };
        this.compileExpr(e.expr, st);
        this.emit(st, OP.DUP, 0, 0, e.span);
        this.emit(st, OP.PATMATCH, this.patternAdd(pat), 0, e.span);
        this.emit(st, OP.JUMPNONE, 0, 0, e.span);
        const jNone = this.here(st) - 1;
        this.pushScope(st);
        const names = [];
        collectPatNames(pat, names);
        const slots = names.map(n => this.declareLocal(st, n));
        this.emit(st, OP.BIND, this.parr(slots), 0, e.span);
        this.emit(st, OP.LD, 0, slots[0], e.span);
        this.popScope(st);
        this.emit(st, OP.SWAP, 0, 0, e.span);
        this.emit(st, OP.POP, 0, 0, e.span);
        this.emit(st, OP.JUMP, 0, 0, e.span);
        const jEnd = this.here(st) - 1;
        this.patch(st, jNone, this.here(st));
        const ensuresQ = st.entry?.decl?.ensures;
        // v0.56(C2):同 Return——子帧(resultSlot 为 undefined/null)不执行外层 ensures。
        if (ensuresQ && st.resultSlot != null) {
          this.emit(st, OP.DUP, 0, 0, e.span);
          this.emit(st, OP.ST, 0, st.resultSlot, e.span);
          this.compileContractExpr(ensuresQ.expr, st);
          this.compileContractFail(st, ensuresQ.msg ? `契约违反: ${ensuresQ.msg}` : '契约违反: ensures', ensuresQ.span ?? e.span, (st) => { this.emit(st, OP.LD, 0, st.resultSlot, ensuresQ.span ?? e.span); });
        }
        this.emit(st, OP.RET, 0, 0, e.span);
        this.patch(st, jEnd, this.here(st));
        return;
      }
      case 'If': {
        // 恒产 1 值:无 else 时 false 路径补 unit(与树的"语句形式丢弃值"语义等价)
        this.compileExpr(e.cond, st);
        this.emit(st, OP.JUMPFALSE, 0, 0, e.span);
        const jFalse = this.here(st) - 1;
        this.compileBlock(e.then, st, true);
        this.emit(st, OP.JUMP, 0, 0, e.span);
        const jEnd = this.here(st) - 1;
        this.patch(st, jFalse, this.here(st));
        if (e.els) {
          if (e.els.nt === 'If') this.compileExpr(e.els, st, true);
          else this.compileBlock(e.els, st, true);
        } else {
          this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, e.span);
        }
        this.patch(st, jEnd, this.here(st));
        return;
      }
      case 'Match': {
        this.compileExpr(e.scrutinee, st);              // [scrut]
        // v0.78 #70:宗量是跨越臂体的栈上临时——登记活临时层数,break/continue
        // 从臂体跳出时按层数弹栈(见 Break/Continue 分支注释)。
        st.matchTemps = (st.matchTemps ?? 0) + 1;
        const jEnds = [];
        for (const arm of e.arms) {
          this.emit(st, OP.DUP, 0, 0, arm.span);        // [scrut, 副本]
          this.emit(st, OP.PATMATCH, this.patternAdd(arm.pat), 0, arm.span); // 弹副本 → binds|null
          this.emit(st, OP.JUMPNONE, 0, 0, arm.span);   // null → 弹出并跳
          const jNext = this.here(st) - 1;
          this.pushScope(st);
          this.emitBinds(arm.pat, st);
          let guardFail = null;
          if (arm.guard) {
            this.compileExpr(arm.guard, st);
            this.emit(st, OP.JUMPFALSE, 0, 0, arm.guard.span); // 弹 bool
            guardFail = this.here(st) - 1;
          }
          this.compileExprOrBlock(arm.expr, st, true);
          this.popScope(st);
          // 栈 [scrut, result] → SWAP;POP → [result](弹掉 scrut,留下分支值)
          this.emit(st, OP.SWAP, 0, 0, arm.span);
          this.emit(st, OP.POP, 0, 0, arm.span);
          this.emit(st, OP.JUMP, 0, 0, arm.span);
          jEnds.push(this.here(st) - 1);
          // 下一 arm 落点(模式未命中或 guard 失败):栈上只剩 scrut
          this.patch(st, jNext, this.here(st));
          if (guardFail !== null) this.patch(st, guardFail, this.here(st));
        }
        // 检查器保证穷尽;防御:落空 → panic
        this.emit(st, OP.CONST, this.poolAdd(V.str('内部错误:match 未命中')), 0, e.span);
        this.emit(st, OP.PANICX, 0, 0, e.span);
        for (const j of jEnds) this.patch(st, j, this.here(st));
        st.matchTemps = (st.matchTemps ?? 0) - 1;       // 宗量临时已消费,撤销登记
        return;
      }
      case 'VecLit': {
        for (const el of e.elems) this.compileExpr(el, st);
        this.emit(st, OP.MAKEVEC, e.elems.length, 0, e.span);
        return;
      }
      case 'MapLit': {
        for (const en of e.entries) {
          this.compileExpr(en.k, st);
          this.compileExpr(en.v, st);
        }
        this.emit(st, OP.MAKEMAP, e.entries.length, 0, e.span);
        return;
      }
      case 'TupleLit': {
        if (e.elems.length === 0) { this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, e.span); return; }
        for (const el of e.elems) this.compileExpr(el, st);
        this.emit(st, OP.MAKETUPLE, e.elems.length, 0, e.span);
        return;
      }
      case 'StructLit': {
        // 解析 def(与树引擎同规则),字段名 + def 一起入池
        let def = null;
        if (e.path.length === 1) {
          def = st.mod.items.get(e.path[0])?.decl ?? null;
        } else {
          const imp = st.mod.imports.get(e.path[0]);
          if (imp?.local) def = imp.local.items.get(e.path[1])?.decl ?? null;
        }
        if (!def) throw new CompileError('结构体未解析:' + e.path.join('.'), e.span);
        const names = e.fields.map(f => f.name);
        if ((def.invariants ?? []).length === 0) { for (const f of e.fields) this.compileExpr(f.value, st); } else { this.pushScope(st); const slots = new Map(); for (const f of e.fields) { this.compileExpr(f.value, st); const slot = this.declareLocal(st, f.name); this.emit(st, OP.ST, 0, slot, f.span); slots.set(f.name, slot); } for (const inv of def.invariants) { this.compileExpr(inv.expr, st); this.compileContractFail(st, '契约违反: invariant', inv.span ?? e.span, (st) => { this.emit(st, OP.CONST, this.poolAdd(V.bool(false)), 0, inv.span ?? e.span); }); } this.popScope(st); for (const f of e.fields) this.emit(st, OP.LD, 0, slots.get(f.name), f.span); }
        // v0.88(§4.13.7 四边界):structspec 附带字段规格树(normSpec)——VM MAKESTRUCT
        // ctor 归一(tree evalStructLit 同口径)。artifact 序列化 normSpec 为纯数据透传;
        // 无窄型字段 → null(旧产物兼容)。
        const normSpec = declaredSpecOfTy({ k: 'struct', def });
        this.emit(st, OP.MAKESTRUCT, this.poolAdd({ __tag: 'structspec', v: { names, def, normSpec } }), e.fields.length, e.span);
        return;
      }
      case 'Lambda': {
        this.compileLambda(e, st);
        return;
      }
      case 'BlockExpr': {
        this.compileBlock(e.block, st, want);
        return;
      }
      case 'LoopExpr': {
        // loop 作为表达式:类型 never;编译为语句循环 + 不可达 CONST(保持栈平衡)
        this.compileStmt({ nt: 'Loop', body: e.body, span: e.span }, st);
        this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, e.span); // 不可达
        return;
      }
      default:
        throw new Error('compileExpr: ' + e.nt);
    }
  }

  compileExprOrBlock(e, st, want) {
    if (e.nt === 'BlockExpr') this.compileBlock(e.block, st, want);
    else this.compileExpr(e, st, want);
  }

  compileIdentValue(e, st) {
    const name = e.name;
    const r = this.resolveLocalName(st, name);
    if (r) {
      if (r.kind === 'fn') {
        // v0.59-B1/B2:本地函数引用发射 LDFN(独立函数表条目;契约域仅限同块兄弟)
        this.emit(st, OP.LDFN, r.idx, 0, e.span);
        return;
      }
      this.emit(st, OP.LD, r.kind === 'local' ? 0 : 1, r.kind === 'local' ? r.slot : r.idx, e.span);
      return;
    }
    this.compileNamedValue(name, st, e.span);
  }

  // 模块级名字:const / fn / prelude / std
  compileNamedValue(name, st, span) {
    const entry = st.mod.items.get(name);
    if (entry?.kind === 'const' && this.constVals.has(entry)) {
      this.emit(st, OP.CONST, this.constVals.get(entry), 0, span);
      return;
    }
    if (entry?.kind === 'fn') {
      this.emit(st, OP.LDFN, this.entryFnIdx.get(entry), 0, span);
      return;
    }
    // 内置函数(v0.58 起先于 use 导入分支:与 checker/tree 的"裸名调用内置优先"对齐——
    // `use std.str;` 后裸 `str(42)` 曾被编译成 stdmod 值,VM M4001 而 tree 正常)
    // v0.69(ADR-005):eval 加入裸 builtin 名单(VM 常量 __builtin:eval;执行器
    // BUILTIN_IMPLS 两引擎共享,实现只在 src/interp.js 一处)
    if (['print', 'eprint', 'print_raw', 'str', 'debug', 'assert', 'assert_eq', 'panic', 'contract_fail', 'eval'].includes(name)) {
      this.emit(st, OP.CONST, this.poolAdd({ __tag: 'str', v: '__builtin:' + name }), 0, span);
      return;
    }
    // v0.54 审查 B5:use std.x [as y] 的短名/别名是模块值(与树引擎 evalField 的
    // import 分支对齐)。此前只有全限定 std.x.f 能编译,`use std.math; math.sqrt(...)`
    // 在 run(VM)下抛 "名字未解析 math" —— check 通过但运行崩溃(#27)。
    const imp = st.mod.imports.get(name);
    if (imp?.std) {
      this.emit(st, OP.CONST, this.pstr('__stdmod:' + imp.std), 0, span);
      return;
    }
    if (name === 'None') {
      this.emit(st, OP.CONST, this.noneIdx, 0, span);
      return;
    }
    if (name === 'std') {
      this.emit(st, OP.CONST, this.poolAdd({ __tag: 'stdmod', v: 'std' }), 0, span);
      return;
    }
    // 基本类型名(类型级函数的 base)
    if (/^(i8|i16|i32|i64|u8|u16|u32|u64|f32|f64|bool|str)$/.test(name)) {
      this.emit(st, OP.CONST, this.poolAdd({ __tag: 'typeobj', v: name }), 0, span);
      return;
    }
    throw new CompileError('名字未解析:' + name, span);
  }

  // 字段访问(非调用):p.x / std.math / Option(类型名)
  compileField(e, st) {
    // base 为纯 ident 且是模块/类型/枚举名 → 常量形式
    if (e.base.nt === 'Ident') {
      const n = e.base.name;
      const local = this.resolveLocalName(st, n);
      if (!local) {
        if (n === 'Option' || n === 'Result') {
          // 限定名作为构造器(仅当紧随 Call;此处单独出现:检查器不允许裸 ctor 作为值,防御)
          this.emit(st, OP.CONST, this.poolAdd({ __tag: 'enumspec', v: { def: n === 'Option' ? 'builtin-opt' : 'builtin-res', tag: e.name } }), 0, e.span);
          return;
        }
        if (n === 'std') {
          this.emit(st, OP.CONST, this.poolAdd({ __tag: 'str', v: '__stdmod:' + e.name }), 0, e.span);
          return;
        }
        // 本地导入模块的成员:fn / enum 变体
        const imp = st.mod.imports.get(n);
        if (imp) {
          if (imp.std) {
            // v0.54 审查 B5:按真实模块名映射(use std.math as m 时别名不是模块名)
            this.emit(st, OP.CONST, this.pstr('__stdmod:' + imp.std), 0, e.span);
            return;
          }
          const mEntry = imp.local.items.get(e.name);
          if (mEntry?.kind === 'fn') {
            this.emit(st, OP.LDFN, this.entryFnIdx.get(mEntry), 0, e.span);
            return;
          }
          if (mEntry?.kind === 'enum') {
            const vv = mEntry.decl.variants.find(x => x.name === e.name);
            if (vv && vv.rtypes.length === 0) {
              this.emit(st, OP.MAKEENUM, this.poolAdd({ __tag: 'enumspec', v: this.enumSpecV(mEntry.decl, e.name) }), 0, e.span);
              return;
            }
            this.emit(st, OP.CONST, this.poolAdd({ __tag: 'enumspec', v: this.enumSpecV(mEntry.decl, e.name) }), 0, e.span);
            return;
          }
          if (mEntry?.kind === 'const') {
            this.emit(st, OP.CONST, this.constVals.get(mEntry) ?? this.poolAdd(UNIT), 0, e.span);
            return;
          }
        }
        const ent = st.mod.items.get(n);
        if (ent?.kind === 'enum') {
          const v = ent.decl.variants.find(x => x.name === e.name);
          if (v && v.rtypes?.length === 0) {
            // 零参变体是完整值:直接构造
            this.emit(st, OP.MAKEENUM, this.poolAdd({ __tag: 'enumspec', v: this.enumSpecV(ent.decl, e.name) }), 0, e.span);
            return;
          }
          this.emit(st, OP.CONST, this.poolAdd({ __tag: 'enumspec', v: this.enumSpecV(ent.decl, e.name) }), 0, e.span);
          return;
        }
        // 本模块枚举之外:Option/Result 名已在上方处理
      }
    }
    this.compileExpr(e.base, st);
    this.emit(st, OP.GETFIELD, this.pstr(e.name), 0, e.span);
  }

  compileCall(e, st, want) {
    const callee = e.callee;

    // 裸 prelude 变体构造:Some(x) / Ok(v) / Err(e)
    // v0.59-B4/MINOR7:本地名字(变量/本地函数)优先于 prelude 构造器——checker/tree
    // 均按"本地声明 > prelude"解析;此前该特例无条件生效,`fn Some(x)`/`let Some = ...`
    // 在 VM 走构造器而 tree 调用本地值,静默分歧。
    if (callee.nt === 'Ident' && ['Some', 'Ok', 'Err'].includes(callee.name) && !this.resolveLocalName(st, callee.name)) {
      const spec = callee.name === 'Some' ? { def: 'builtin-opt', tag: 'Some' } : { def: 'builtin-res', tag: callee.name };
      for (const a of e.args) this.compileExpr(a, st);
      this.emit(st, OP.MAKEENUM, this.poolAdd({ __tag: 'enumspec', v: spec }), e.args.length, e.span);
      return;
    }

    // 构造器:Option.Some(x) / Shape.Circle(r) / geom.Shape.Circle(r)
    const ctorSpec = this.tryCtorSpec(callee, st);
    if (ctorSpec) {
      for (const a of e.args) this.compileExpr(a, st);
      this.emit(st, OP.MAKEENUM, this.poolAdd({ __tag: 'enumspec', v: this.enumSpecV(ctorSpec.def, ctorSpec.tag) }), e.args.length, e.span);
      return;
    }

    // 方法调用:recv.method(args)
    if (callee.nt === 'Field') {
      // 导入模块的成员调用:geom.dist(a, b) / utils.math.f(x)
      // v0.58 守卫 + v0.59-B4:基名被局部变量/形参/本地函数遮蔽时,按值的方法调用解析
      if (callee.base.nt === 'Ident' && !this.resolveLocalName(st, callee.base.name)) {
        const imp = st.mod.imports.get(callee.base.name);
        if (imp?.local) {
          const mEntry = imp.local.items.get(callee.name);
          if (mEntry?.kind === 'fn') {
            this.emit(st, OP.LDFN, this.entryFnIdx.get(mEntry), 0, e.span); // callee 先压
            for (const a of e.args) this.compileExpr(a, st);
            this.emit(st, OP.CALL, e.args.length, 0, e.span);
            return;
          }
          if (mEntry?.kind === 'enum') {
            for (const a of e.args) this.compileExpr(a, st);
            this.emit(st, OP.MAKEENUM, this.poolAdd({ __tag: 'enumspec', v: this.enumSpecV(mEntry.decl, callee.name) }), e.args.length, e.span);
            return;
          }
          if (mEntry?.kind === 'const') {
            // 跨模块常量(不能调用;检查器拦截)——按值处理
            this.emit(st, OP.CONST, this.constVals.get(mEntry) ?? this.poolAdd(UNIT), 0, e.span);
            return;
          }
        }
        // v0.58:std 导入的方法形式(str.join(x) / math.sqrt(x))→ stdmod 接收者 +
        // CALLMETHOD 携带方法名(callStd 分派)。内建名与导入同名时(如 use std.str
        // 后的 str),方法形式按导入解析——与树引擎 evalCall 的 Field 分支一致;
        // 调用形式 str(42) 仍是内建(compileNamedValue 内建分支已先于导入)。
        if (imp?.std) {
          this.emit(st, OP.CONST, this.pstr('__stdmod:' + imp.std), 0, e.span);
          for (const a of e.args) this.compileExpr(a, st);
          this.emit(st, OP.CALLMETHOD, this.pstr(callee.name), e.args.length, e.span);
          return;
        }
      }
      // recv 在栈 = callee.base 的值;直接编译 base(方法名给 CALLMETHOD)
      this.compileExpr(callee.base, st);
      for (const a of e.args) this.compileExpr(a, st);
      this.emit(st, OP.CALLMETHOD, this.pstr(callee.name), e.args.length, e.span);
      return;
    }

    // 普通调用:callee 先压栈
    this.compileExpr(callee, st);
    for (const a of e.args) this.compileExpr(a, st);
    this.emit(st, OP.CALL, e.args.length, 0, e.span);
    void want;
  }

  // v0.89(§4.13.7):enumspec 附带逐 payload 归一规格(normSpecs 纯数据,VM MAKEENUM
  // 构造归一;tree constructVariant 同口径)。优先 checker 解析后的 rtypes,缺省回退
  // AST types;泛型 payload(规格 null)/builtin-opt·res(def 为字符串)不归一;
  // 无窄型 payload → normSpecs 不挂(旧产物/既有池布局逐字节兼容)。
  enumSpecV(def, tag) {
    const v = { def, tag };
    if (def && typeof def === 'object' && Array.isArray(def.variants)) {
      const variant = def.variants.find((x) => x.name === tag);
      const ts = variant ? (variant.rtypes ?? variant.types) : null;
      if (Array.isArray(ts)) {
        const specs = ts.map((t) => declaredSpecOfTy(t) ?? declaredSpecOfTyAst(t));
        if (specs.some(Boolean)) v.normSpecs = specs;
      }
    }
    return v;
  }

  // 识别 枚举.变体(含三段路径)作为构造器调用
  tryCtorSpec(callee, st) {
    if (callee.nt !== 'Field') return null;
    const variant = callee.name;
    // 三段:mod.Enum.Variant → callee.base 是 Field(Enum, Variant)?不——
    // geom.Shape.Circle:callee = Field(Field(geom, Shape), Circle);base = Field(geom,Shape)
    if (callee.base.nt === 'Field') {
      const inner = callee.base;
      if (inner.base.nt === 'Ident') {
        const bind = inner.base.name;
        const imp = st.mod.imports.get(bind);
        if (imp?.local) {
          const enumEntry = imp.local.items.get(inner.name);
          if (enumEntry?.kind === 'enum') {
            const v = enumEntry.decl.variants.find(x => x.name === variant);
            if (v) return { def: enumEntry.decl, tag: variant };
          }
        }
      }
      return null;
    }
    if (callee.base.nt !== 'Ident') return null;
    const n = callee.base.name;
    if (this.resolveLocalName(st, n)) return null;
    if (n === 'Option') return { def: 'builtin-opt', tag: variant };
    if (n === 'Result') return { def: 'builtin-res', tag: variant };
    const ent = st.mod.items.get(n);
    if (ent?.kind === 'enum') {
      const v = ent.decl.variants.find(x => x.name === variant);
      if (v) return { def: ent.decl, tag: variant };
    }
    return null;
  }

  castTargetId(typeAst) {
    const tn = typeAst?.nt === 'TName' ? typeAst.name.split('.').pop() : 'i64';
    return this.pstr(tn);
  }

  // ---------- lambda ----------
  compileLambda(e, st) {
    // 1) 收集 lambda 自己绑定的名字
    const localNames = new Set(e.params.map(p => p.name));
    // 2) 收集自由变量(递归)
    const free = [];
    const seenFree = new Set();
    collectFreeNames(e.body, localNames, free, seenFree);
    // 3) 捕获计划:free 名字在当前函数帧的坐标
    // v0.59-B2:自由名字若是外层本地函数(fn:N),不进入捕获计划——本地函数是函数表
    // 全局条目,lambda 体直接 LDFN 即可(闭包帧无需运行时携带;值语义无差)。
    const plan = [];
    const captureMap = new Map();
    // v0.87(审查 MAJOR-2):捕获槽的窄型归一规格透传——外层 narrowSlots 中被捕获的
    // 局部槽,其规格随捕获下标进入子状态(capture 赋值 SET c=specIdx 归一不断档;
    // 缺失面 = 闭包捕获的窄型绑定重赋值静默回绕,v0.85 M1 族漏网面)。
    const capNarrow = new Map();
    const fnBinds = new Map(st.fnBinds ?? []); // 继承外层 lambda 的本地函数绑定
    for (const name of free) {
      const r = this.resolveName(st, name);
      if (!r) continue; // 全局名(const/fn/builtin)不需要捕获
      if (r.kind === 'fn') { fnBinds.set(name, r.idx); continue; }
      const idx = plan.length;
      plan.push(r.kind === 'local' ? { local: r.slot } : { cap: r.idx });
      captureMap.set(name, idx);
      if (r.kind === 'local') {
        const sp = st.narrowSlots?.get(r.slot);
        if (sp) capNarrow.set(idx, sp);
      }
    }
    // 4) 编译 lambda 体
    const idx = this.functions.length;
    this.functions.push(null);
    const savedCur = this.curFnIdx;
    this.curFnIdx = idx;
    // v0.79(#71):子状态刻意不含 breakCtx/matchTemps——lambda 体是新函数边界,
    // 裸 break/continue 由 checker M3010/M3011 拦截;编译层防御断言见 compileStmt
    // Break/Continue(此前裸 POP 会弹穿共享操作数栈)。外层循环的 breakCtx 留在
    // st 上不被子状态携带,continue/break 不穿透 lambda。
    const sub = { code: [], nLocals: 0, scopes: [new Map()], captures: captureMap, mod: st.mod, entry: st.entry, resultSlot: null, fnBinds, narrowSlots: capNarrow.size ? capNarrow : undefined }; // v0.56(C2):闭包是独立帧,不得执行外层 ensures;v0.87(审查 MAJOR-2):narrowSlots 随捕获下标透传
    for (const p of e.params) sub.scopes[0].set(p.name, sub.nLocals++);
    if (e.body.nt === 'BlockExpr') this.compileBlock(e.body.block, sub, true);
    else this.compileExpr(e.body, sub, true);
    this.emit(sub, OP.RET, 0, 0, e.span);
    // v0.87(§4.13.7)/v0.88(§4.13.7 四边界)/v0.89(§4.13.7):lambda 形参/返回归一规格
    // ——编译函数对象携带 narrowSpecs(非序列化字段:AOT 对含 lambda 程序维持既有源码
    // 模式回退,<闭包> 缺 entry.sig 的拒绝不变)。形参优先级:AST 标注(标注形参,v0.87
    // 叶形态;declaredSpecOfTyAst 覆盖 Vec[窄]/Map[*,窄] 标注)→ checker 统一后回写的
    // e.narrowParamTypes(无标注形参经期望 fn 类型统一;类型经单一事实来源 declared
    // SpecOfTy 构建规格树)。返回位(v0.89):checker 统一后回写的 e.narrowRetSpec——
    // 内联 HOF 实参经 fn(ret 窄) 期望统一/体尾推断窄型时非 null;callCompiled RET 归一
    // (narrowSpecsOfFn)据此重标。闭包在别处创建后传入的形态由传参边界 __retSpec 打标
    // 通道覆盖(tree callClosure);lambda 返回非窄型 → null(推断 i64 = 原生死)。
    const lamNarrowSpecs = { params: e.params.map((p, i) => declaredSpecOfTyAst(p.type) ?? declaredSpecOfTy(e.narrowParamTypes?.[i]) ?? null), ret: declaredSpecOfTy(e.narrowRetSpec) ?? null };
    this.functions[idx] = { name: '<闭包>', modFile: st.mod.file, nParams: e.params.length, nLocals: sub.nLocals, code: sub.code, narrowSpecs: lamNarrowSpecs };
    this.curFnIdx = savedCur;
    this.emit(st, OP.CLOSURE, idx, this.poolAdd({ __tag: 'plan', v: plan }), e.span);
  }
}

// ---------- 自由变量分析(已单源化)----------
// v0.98 ADR-011 P0:collectFreeNames/collectLambdaLocals/addPatNames 移至 src/freenames.js
// (VM capture plan 与 tree captureEnvFor 的单一事实来源,零依赖叶模块,规避 interp→compiler
// ESM 循环导入)。语义铁律:collectLambdaLocals 的 BlockExpr 分支为承重死代码(ADR-011 M1
// 禁令,严禁顺手修复——修则 rv1/rv7 翻转),详见 src/freenames.js 函数注释。

function collectPatNames(pat, out) {
  switch (pat.nt) {
    case 'PIdent': out.push(pat.name); return;
    case 'PTuple': for (const p of pat.pats) collectPatNames(p, out); return;
    case 'PEnum': for (const p of pat.args) collectPatNames(p, out); return;
    default: return;
  }
}

// v0.88(§4.13.7):模式位置的规格树提取——与 collectPatNames 严格同一 DFS 序与跳过
// 规则(PWild/PLit 跳过、PEnum 参数位下推但 let 模式不出现枚举形态),保证 specs[i]
// 与 BIND 槽位一一对应。PIdent 位携带该位置的规格(无规格 → null)。
function collectPatSpecs(pat, spec, out) {
  switch (pat.nt) {
    case 'PIdent': out.push(spec ?? null); return;
    case 'PTuple': for (let i = 0; i < pat.pats.length; i++) collectPatSpecs(pat.pats[i], spec?.ts?.[i] ?? null, out); return;
    case 'PEnum': for (const p of pat.args) collectPatSpecs(p, null, out); return;
    default: return;
  }
}
