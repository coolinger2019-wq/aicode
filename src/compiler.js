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

import { V, deepCopy, UNIT, displayStr, debugStr, valueEquals, normKey, keyValue, Panic, RetSig } from './interp.js';
import { Interp } from './interp.js';
import { resolveT, typeStr } from './checker.js';
import { tryCompileWasm } from './wasm.js';

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
  if (built.wasm && c.strConsts) built.wasm.strConsts = c.strConsts;
  return built;
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
    for (const p of entry.sig?.params ?? []) {
      st.scopes[0].set(p.name, st.nLocals++);
    }
    // 契约:requires/ensures(v0.45)
    let resultSlot = null;
    if (decl.ensures) {
      resultSlot = st.nLocals++;
      st.scopes[0].set('result', resultSlot);
    }
    st.resultSlot = resultSlot;
    // requires 入口检查
    if (decl.requires) {
      this.compileExpr(decl.requires.expr, st);
      this.compileContractFail(st, decl.requires.msg ? `契约违反: ${decl.requires.msg}` : '契约违反: requires', decl.requires.span ?? decl.span, (st) => { this.emit(st, OP.CONST, this.poolAdd(V.bool(false)), 0, decl.requires.span ?? decl.span); });
    }
    // 函数体的块值 = 返回值 → want=true
    this.pushScope(st);
    for (const s of decl.body.stmts) this.compileStmt(s, st);
    let produced = false;
    if (decl.body.tail) {
      this.compileExpr(decl.body.tail, st);
      produced = true;
      if (decl.ensures && resultSlot !== null) {
        this.emit(st, OP.DUP, 0, 0, decl.body.tail.span);
        this.emit(st, OP.ST, 0, resultSlot, decl.body.tail.span);
        this.compileExpr(decl.ensures.expr, st);
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

  // 名字解析:局部槽 | 捕获下标 | null(交由运行时全局解析)
  resolveName(st, name) {
    for (let i = st.scopes.length - 1; i >= 0; i--) {
      if (st.scopes[i].has(name)) {
        return { kind: 'local', slot: st.scopes[i].get(name) };
      }
    }
    if (st.captures?.has(name)) return { kind: 'cap', idx: st.captures.get(name) };
    return null;
  }

  compileBlock(block, st, wantValue) {
    this.pushScope(st);
    for (const s of block.stmts) this.compileStmt(s, st);
    let produced = false;
    if (block.tail) {
      this.compileExpr(block.tail, st);
      produced = true;
    }
    this.popScope(st);
    if (wantValue && !produced) this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, block.span);
    if (!wantValue && produced) this.emit(st, OP.POP, 0, 0, block.span);
  }

  compileStmt(s, st) {
    switch (s.nt) {
      case 'Let': {
        if (s.init) {
          this.compileExpr(s.init, st);
          // 模式绑定:ident → ST;元组 → PATMATCH+BIND
          this.compileLetPattern(s.pat, st);
        } else {
          // let x: T;(v0.2 允许?检查器要求初始化或标注;无 init 需要标注——声明即占位)编译为 CONST unit 绑定
          this.emit(st, OP.CONST, this.poolAdd(UNIT), 0, s.span);
          this.compileLetPattern(s.pat, st);
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
          // (A) x += 1 / x -= 1
          if ((s.op === '+=' || s.op === '-=') && s.value.nt === 'IntLit' && !s.value.suffix) {
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
          this.emit(st, OP.SETINDEX, 0, 0, s.span);
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
        if (ensures && st.resultSlot !== null) {
          this.emit(st, OP.DUP, 0, 0, s.span);
          this.emit(st, OP.ST, 0, st.resultSlot, s.span);
          this.compileExpr(ensures.expr, st);
          this.compileContractFail(st, ensures.msg ? `契约违反: ${ensures.msg}` : '契约违反: ensures', ensures.span ?? s.span, (st) => { this.emit(st, OP.LD, 0, st.resultSlot, ensures.span ?? s.span); });
        }
        this.emit(st, OP.RET, 0, 0, s.span);
        return;
      }
      case 'Break': case 'Continue': {
        // 由循环上下文回填(编译时通过 breakCtx 栈)
        const bctx = st.breakCtx?.[st.breakCtx.length - 1];
        if (!bctx) { this.emit(st, OP.POP, 0, 0, s.span); return; } // 检查器已拦截;防御
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
        const b = { breaks: [], continues: [] };
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
        const b = { breaks: [], continues: [] };
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
        const b = { breaks: [], continues: [] };
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
      case 'Loop': {
        const b = { breaks: [], continues: [] };
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
        // 本地函数:编译为独立函数,绑定 vclose(无捕获)
        const d = s.decl;
        const idx = this.functions.length;
        this.functions.push(null);
        const saved = { scopes: st.scopes, captures: st.captures, nLocals: st.nLocals, mod: st.mod, entry: st.entry, curFnIdx: this.curFnIdx };
        this.curFnIdx = idx;
        const sub = {
          code: [], nLocals: 0,
          scopes: [new Map()],
          captures: null, // 本地函数不捕获
          mod: st.mod,
          entry: st.entry,
        };
        const pseudoSig = { params: d.params.map(p => ({ name: p.name })) };
        void pseudoSig;
        for (const p of d.params) sub.scopes[0].set(p.name, sub.nLocals++);
        this.compileBlock(d.body, sub, false);
        this.emit(sub, OP.RET, 0, 0, d.body.span);
        this.functions[idx] = { name: d.name + '(local)', modFile: st.mod.file, nParams: d.params.length, nLocals: sub.nLocals, code: sub.code, local: true };
        this.curFnIdx = saved.curFnIdx;
        // 声明在当前作用域
        st.scopes[st.scopes.length - 1].set(d.name, 'fn:' + idx);
        return;
      }
      default:
        throw new Error('compileStmt: ' + s.nt);
    }
  }

  // let 的绑定模式:ident / _ / 元组
  compileLetPattern(pat, st) {
    switch (pat.nt) {
      case 'PIdent': {
        const slot = this.declareLocal(st, pat.name);
        this.emit(st, OP.ST, 0, slot, pat.span);
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
        this.emitBinds(pat, st);
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
  emitBinds(pat, st) {
    const names = [];
    collectPatNames(pat, names);
    const slots = names.map(n => this.declareLocal(st, n));
    this.emit(st, OP.BIND, this.parr(slots), 0, pat.span);
  }

  patternAdd(pat) {
    // 模式直接进常量池(VM 从 pool 读取)
    return this.poolAdd({ __tag: 'pat', v: pat });
  }

  // ---------- 左值 ----------
  compilePlaceRead(e, st) {
    switch (e.nt) {
      case 'Ident': {
        const r = this.resolveName(st, e.name);
        if (r) this.emit(st, OP.LD, r.kind === 'local' ? 0 : 1, r.kind === 'local' ? r.slot : r.idx, e.span);
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
        const r = this.resolveName(st, e.name);
        if (!r) throw new Error('编译错误:赋值目标未解析 ' + e.name);
        this.emit(st, OP.SET, r.kind === 'local' ? 0 : 1, r.kind === 'local' ? r.slot : r.idx, e.span);
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
        if (ensuresQ && st.resultSlot !== null) {
          this.emit(st, OP.DUP, 0, 0, e.span);
          this.emit(st, OP.ST, 0, st.resultSlot, e.span);
          this.compileExpr(ensuresQ.expr, st);
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
        if (!def) throw new Error('编译错误:结构体未找到 ' + e.path.join('.'));
        const names = e.fields.map(f => f.name);
        if ((def.invariants ?? []).length === 0) { for (const f of e.fields) this.compileExpr(f.value, st); } else { this.pushScope(st); const slots = new Map(); for (const f of e.fields) { this.compileExpr(f.value, st); const slot = this.declareLocal(st, f.name); this.emit(st, OP.ST, 0, slot, f.span); slots.set(f.name, slot); } for (const inv of def.invariants) { this.compileExpr(inv.expr, st); this.compileContractFail(st, '契约违反: invariant', inv.span ?? e.span, (st) => { this.emit(st, OP.CONST, this.poolAdd(V.bool(false)), 0, inv.span ?? e.span); }); } this.popScope(st); for (const f of e.fields) this.emit(st, OP.LD, 0, slots.get(f.name), f.span); }
        this.emit(st, OP.MAKESTRUCT, this.poolAdd({ __tag: 'structspec', v: { names, def } }), e.fields.length, e.span);
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
    const r = this.resolveName(st, name);
    if (r) {
      this.emit(st, OP.LD, r.kind === 'local' ? 0 : 1, r.kind === 'local' ? r.slot : r.idx, e.span);
      return;
    }
    // 本地函数绑定(fn:N)
    for (let i = st.scopes.length - 1; i >= 0; i--) {
      const v = st.scopes[i].get(name);
      if (typeof v === 'string' && v.startsWith('fn:')) {
        this.emit(st, OP.LDFN, Number(v.slice(3)), 0, e.span);
        return;
      }
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
    if (name === 'None') {
      this.emit(st, OP.CONST, this.noneIdx, 0, span);
      return;
    }
    if (name === 'std') {
      this.emit(st, OP.CONST, this.poolAdd({ __tag: 'stdmod', v: 'std' }), 0, span);
      return;
    }
    // 内置函数
    if (['print', 'eprint', 'print_raw', 'str', 'debug', 'assert', 'assert_eq', 'panic', 'contract_fail'].includes(name)) {
      this.emit(st, OP.CONST, this.poolAdd({ __tag: 'str', v: '__builtin:' + name }), 0, span);
      return;
    }
    // 基本类型名(类型级函数的 base)
    if (/^(i8|i16|i32|i64|u8|u16|u32|u64|f32|f64|bool|str)$/.test(name)) {
      this.emit(st, OP.CONST, this.poolAdd({ __tag: 'typeobj', v: name }), 0, span);
      return;
    }
    throw new Error('编译错误:名字未解析 ' + name);
  }

  // 字段访问(非调用):p.x / std.math / Option(类型名)
  compileField(e, st) {
    // base 为纯 ident 且是模块/类型/枚举名 → 常量形式
    if (e.base.nt === 'Ident') {
      const n = e.base.name;
      const local = this.resolveName(st, n);
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
            this.emit(st, OP.CONST, this.poolAdd({ __tag: 'str', v: '__stdmod:' + n }), 0, e.span);
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
              this.emit(st, OP.MAKEENUM, this.poolAdd({ __tag: 'enumspec', v: { def: mEntry.decl, tag: e.name } }), 0, e.span);
              return;
            }
            this.emit(st, OP.CONST, this.poolAdd({ __tag: 'enumspec', v: { def: mEntry.decl, tag: e.name } }), 0, e.span);
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
            this.emit(st, OP.MAKEENUM, this.poolAdd({ __tag: 'enumspec', v: { def: ent.decl, tag: e.name } }), 0, e.span);
            return;
          }
          this.emit(st, OP.CONST, this.poolAdd({ __tag: 'enumspec', v: { def: ent.decl, tag: e.name } }), 0, e.span);
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
    if (callee.nt === 'Ident' && ['Some', 'Ok', 'Err'].includes(callee.name)) {
      const spec = callee.name === 'Some' ? { def: 'builtin-opt', tag: 'Some' } : { def: 'builtin-res', tag: callee.name };
      for (const a of e.args) this.compileExpr(a, st);
      this.emit(st, OP.MAKEENUM, this.poolAdd({ __tag: 'enumspec', v: spec }), e.args.length, e.span);
      return;
    }

    // 构造器:Option.Some(x) / Shape.Circle(r) / geom.Shape.Circle(r)
    const ctorSpec = this.tryCtorSpec(callee, st);
    if (ctorSpec) {
      for (const a of e.args) this.compileExpr(a, st);
      this.emit(st, OP.MAKEENUM, this.poolAdd({ __tag: 'enumspec', v: ctorSpec }), e.args.length, e.span);
      return;
    }

    // 方法调用:recv.method(args)
    if (callee.nt === 'Field') {
      // 导入模块的成员调用:geom.dist(a, b) / utils.math.f(x)
      if (callee.base.nt === 'Ident' && !this.resolveName(st, callee.base.name)) {
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
            const spec = { def: mEntry.decl, tag: callee.name };
            for (const a of e.args) this.compileExpr(a, st);
            this.emit(st, OP.MAKEENUM, this.poolAdd({ __tag: 'enumspec', v: spec }), e.args.length, e.span);
            return;
          }
          if (mEntry?.kind === 'const') {
            // 跨模块常量(不能调用;检查器拦截)——按值处理
            this.emit(st, OP.CONST, this.constVals.get(mEntry) ?? this.poolAdd(UNIT), 0, e.span);
            return;
          }
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
    if (this.resolveName(st, n)) return null;
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
    const plan = [];
    const captureMap = new Map();
    for (const name of free) {
      const r = this.resolveName(st, name);
      if (!r) continue; // 全局名(const/fn/builtin)不需要捕获
      const idx = plan.length;
      plan.push(r.kind === 'local' ? { local: r.slot } : { cap: r.idx });
      captureMap.set(name, idx);
    }
    // 4) 编译 lambda 体
    const idx = this.functions.length;
    this.functions.push(null);
    const savedCur = this.curFnIdx;
    this.curFnIdx = idx;
    const sub = { code: [], nLocals: 0, scopes: [new Map()], captures: captureMap, mod: st.mod, entry: st.entry };
    for (const p of e.params) sub.scopes[0].set(p.name, sub.nLocals++);
    if (e.body.nt === 'BlockExpr') this.compileBlock(e.body.block, sub, true);
    else this.compileExpr(e.body, sub, true);
    this.emit(sub, OP.RET, 0, 0, e.span);
    this.functions[idx] = { name: '<闭包>', modFile: st.mod.file, nParams: e.params.length, nLocals: sub.nLocals, code: sub.code };
    this.curFnIdx = savedCur;
    this.emit(st, OP.CLOSURE, idx, this.poolAdd({ __tag: 'plan', v: plan }), e.span);
  }
}

// ---------- 自由变量分析 ----------
function collectFreeNames(node, bound, out, seen) {
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
function collectLambdaLocals(node, bound) {
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

function addPatNames(pat, bound) {
  if (!pat) return;
  switch (pat.nt) {
    case 'PIdent': bound.add(pat.name); return;
    case 'PTuple': for (const p of pat.pats) addPatNames(p, bound); return;
    case 'PEnum': for (const p of pat.args) addPatNames(p, bound); return;
    default: return;
  }
}

function collectPatNames(pat, out) {
  switch (pat.nt) {
    case 'PIdent': out.push(pat.name); return;
    case 'PTuple': for (const p of pat.pats) collectPatNames(p, out); return;
    case 'PEnum': for (const p of pat.args) collectPatNames(p, out); return;
    default: return;
  }
}
