// vm.js — Ming 栈式字节码虚拟机(v0.3)。
// 继承树遍历引擎(Interp)以复用:输出/stdin/内置方法表/std 调用/panic 语义;
// 覆盖:runMain(走字节码)、callUser/callClosure(执行编译函数帧)。
// --tree 可切换回树引擎对照(两引擎必须通过同一黄金测试)。
//
// 栈布局:操作数在 valueStack;每帧 {fn, ip, locals[], captures[]}。
// 值语义:ST/SET/BIND/调用实参/集合构造全部 deepCopy;mut self 的 self 不拷贝。

import { Interp, BUILTIN_IMPLS, V, deepCopy, UNIT, displayStr, debugStr, valueEquals, normKey, keyValue, Panic, RetSig, normInt, fits } from './interp.js';
import { compile, OP, BIN } from './compiler.js';
import { tint, tfloat, T_STR, T_BOOL, INT_TYPES, typeStr, resolveT } from './checker.js';

export function resolveConst(c) {
  if (c && c.__tag === 'str') {
    if (c.v.startsWith('__builtin:')) return { t: 'builtin', name: c.v.slice(10) };
    if (c.v.startsWith('__stdmod:')) return { t: 'stdmod', name: c.v.slice(9) };
    return V.str(c.v);
  }
  if (c && c.__tag === 'typeobj') return { t: 'typeobj', prim: c.v };
  if (c && c.__tag === 'stdmod') return { t: 'stdmod', name: c.v };
  if (c && c.__tag === 'enumspec') return { t: 'ctor', enumName: typeof c.v.def === 'string' ? (c.v.def === 'builtin-opt' ? 'Option' : 'Result') : undefined, def: typeof c.v.def === 'string' ? c.v.def : c.v.def, variant: c.v.tag };
  return c;
}

const BIN2OP = Object.entries(BIN).reduce((m, [k, v]) => (m[v] = k, m), {});
const TRACE = process.env.MING_TRACE === '1';
const ITER_VAL = { done: false, value: null }; // 迭代器复用的结果对象(同步执行安全)
const ITER_DONE = { done: true }; // 启动时读一次:每指令访问 process.env 是性能陷阱

export class VMInterp extends Interp {
  constructor(checkResult, opts = {}) {
    super(checkResult, opts);
    this.tree = opts.tree ?? false; // 对照模式:仍用树引擎
    this.noWasm = opts.noWasm ?? false;
    if (this.tree) { this.compiled = null; return; }
    this.compiled = compile(checkResult);
    // 预解析常量池:避免每条 CONST 都做 __tag 解包
    this.resolvedPool = this.compiled.pool.map(resolveConst);
    this.valueStack = [];
    this.frames = [];
    // WASM 分层(v0.11):纯整数函数编译为 wasm i64;失败静默回落 JS VM
    this.wasmExports = null;
    this.wasmEligible = null;
    if (!this.noWasm && this.compiled.wasm && typeof WebAssembly !== 'undefined') {
      try {
        const module_ = new WebAssembly.Module(this.compiled.wasm.bytes);
        const spans = this.compiled.spans;
        const callStack = this.callStack;
        // 字符串句柄表(v0.15):wasm 内 str = i32 句柄;JS 侧持真实串
        this.wasmStrTable = [];
        if (this.compiled.wasm?.strConsts) {
          for (const text of this.compiled.wasm.strConsts) this.wasmStrTable.push(text);
        }
        const strTable = this.wasmStrTable;
        const floatStrOf = (x) => (Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : (Number.isInteger(x) && Math.abs(x) < 1e21 ? x.toFixed(1) : String(x)));
        // 容器句柄表(v0.18):wasm 内 Vec/Map = i32 句柄;JS 侧持 V 对象
        this.wasmObjTable = [];
        const objTable = this.wasmObjTable;
        const keyStr = (kh) => strTable[kh] ?? '';
        const imports = {
          ming: {
            tick: () => {
              this.steps += 500;
              if (this.steps > this.maxSteps) {
                throw new Panic('M4001', `执行步数超过上限 ${this.maxSteps}(可能是死循环;用 --max-steps 调整)`, callStack[callStack.length - 1]?.span ?? null);
              }
            },
            panic_m4002: (spanIdx) => {
              throw new Panic('M4002', '整数运算溢出/移位越界', spans[spanIdx] ?? null);
            },
            panic_m4004: (spanIdx) => {
              throw new Panic('M4004', '整数除零', spans[spanIdx] ?? null);
            },
            str_const: (off) => {
              const h = strTable.length;
              strTable.push(strTable[off] ?? '');
              return h;
            },
            str_cat: (a, b) => {
              const h = strTable.length;
              strTable.push((strTable[a] ?? '') + (strTable[b] ?? ''));
              return h;
            },
            str_eq: (a, b) => (strTable[a] === strTable[b] ? 1 : 0),
            str_len: (h) => BigInt([...(strTable[h] ?? '')].length),
            vec_new: () => { const h = objTable.length; objTable.push(V.vec([])); return h; },
            vec_len: (h) => BigInt((objTable[h]?.a ?? []).length),
            vec_get_i64: (h, i) => {
              const a = objTable[h]?.a ?? [];
              const idx = Number(i);
              if (!Number.isInteger(idx) || idx < 0 || idx >= a.length) throw new Panic('M4003', `索引越界:长度 \${a.length},访问 \${idx}(用 .get(i) 返回 Option)`);
              const el = a[idx];
              if (el.t !== 'int') throw new Panic('M4001', '内部错误:vec 元素类型', null);
              return el.v;
            },
            vec_get_f64: (h, i) => {
              const a = objTable[h]?.a ?? [];
              const idx = Number(i);
              if (!Number.isInteger(idx) || idx < 0 || idx >= a.length) throw new Panic('M4003', `索引越界:长度 \${a.length},访问 \${idx}`);
              const el = a[idx];
              if (el.t !== 'float') throw new Panic('M4001', '内部错误:vec 元素类型', null);
              return el.v;
            },
            vec_get_str: (h, i) => {
              const a = objTable[h]?.a ?? [];
              const idx = Number(i);
              if (!Number.isInteger(idx) || idx < 0 || idx >= a.length) throw new Panic('M4003', `索引越界:长度 \${a.length},访问 \${idx}`);
              const el = a[idx];
              if (el.t !== 'str') throw new Panic('M4001', '内部错误:vec 元素类型', null);
              strTable.push(el.v);
              return strTable.length - 1;
            },
            vec_push_i64: (h, v) => { objTable[h]?.a.push(V.int(v, 64, true)); },
            vec_push_f64: (h, v) => { objTable[h]?.a.push(V.float(v, 64)); },
            vec_push_str: (h, sh) => { objTable[h]?.a.push(V.str(strTable[sh] ?? '')); },
            map_new: () => { const h = objTable.length; objTable.push(V.map(new Map())); return h; },
            map_len: (h) => BigInt((objTable[h]?.m ?? new Map()).size),
            map_get_i64: (h, kh) => {
              const m = objTable[h]?.m ?? new Map();
              const k = keyStr(kh);
              if (!m.has(k)) throw new Panic('M4007', 'map 中不存在键 ' + k + '(用 .get(k) 返回 Option)');
              const el = m.get(k);
              return el.v;
            },
            map_get_f64: (h, kh) => {
              const m = objTable[h]?.m ?? new Map();
              const k = keyStr(kh);
              if (!m.has(k)) throw new Panic('M4007', 'map 中不存在键 ' + k);
              return m.get(k).v;
            },
            map_get_str: (h, kh) => {
              const m = objTable[h]?.m ?? new Map();
              const k = keyStr(kh);
              if (!m.has(k)) throw new Panic('M4007', 'map 中不存在键 ' + k);
              strTable.push(m.get(k).v);
              return strTable.length - 1;
            },
            map_set_i64: (h, kh, v) => { objTable[h]?.m.set(keyStr(kh), V.int(v, 64, true)); },
            map_set_f64: (h, kh, v) => { objTable[h]?.m.set(keyStr(kh), V.float(v, 64)); },
            map_set_str: (h, kh, sh) => { objTable[h]?.m.set(keyStr(kh), V.str(strTable[sh] ?? '')); },
            str_from_i64: (v) => { strTable.push(v.toString()); return strTable.length - 1; },
            str_from_f64: (v) => { strTable.push(floatStrOf(v)); return strTable.length - 1; },
            str_from_bool: (v) => { strTable.push(v ? 'true' : 'false'); return strTable.length - 1; },
            str_lt: (a, b) => ((strTable[a] ?? '') < (strTable[b] ?? '') ? 1 : 0),
            str_le: (a, b) => ((strTable[a] ?? '') <= (strTable[b] ?? '') ? 1 : 0),
            str_gt: (a, b) => ((strTable[a] ?? '') > (strTable[b] ?? '') ? 1 : 0),
            str_ge: (a, b) => ((strTable[a] ?? '') >= (strTable[b] ?? '') ? 1 : 0),
            str_trim: (h) => { strTable.push((strTable[h] ?? '').trim()); return strTable.length - 1; },
            str_trim_start: (h) => { strTable.push((strTable[h] ?? '').replace(/^\s+/, '')); return strTable.length - 1; },
            str_trim_end: (h) => { strTable.push((strTable[h] ?? '').replace(/\s+$/, '')); return strTable.length - 1; },
            str_upper: (h) => { strTable.push((strTable[h] ?? '').toUpperCase()); return strTable.length - 1; },
            str_lower: (h) => { strTable.push((strTable[h] ?? '').toLowerCase()); return strTable.length - 1; },
            str_replace: (h, a, b) => { strTable.push((strTable[h] ?? '').split(strTable[a] ?? '').join(strTable[b] ?? '')); return strTable.length - 1; },
            str_contains: (h, a) => ((strTable[h] ?? '').includes(strTable[a] ?? '') ? 1 : 0),
            str_starts: (h, a) => ((strTable[h] ?? '').startsWith(strTable[a] ?? '') ? 1 : 0),
            str_ends: (h, a) => ((strTable[h] ?? '').endsWith(strTable[a] ?? '') ? 1 : 0),
          },
        };
        const inst = new WebAssembly.Instance(module_, imports);
        this.wasmExports = inst.exports;
        this.wasmEligible = this.compiled.wasm.eligible;
      } catch {
        this.wasmExports = null;
      }
    }
  }

  runMain(argv = []) {
    if (this.tree) return super.runMain(argv);
    const bc = this.compiled;
    if (bc.mainFnIdx < 0) {
      throw new Panic('M3023', `入口文件 ${this.entry.file} 缺少 main 函数`);
    }
    const mainFn = bc.functions[bc.mainFnIdx];
    const args = [];
    if (mainFn.nParams >= 1) args.push(V.vec(argv.map(a => V.str(a))));
    if (mainFn.nParams > 1) {
      throw new Panic('M3023', 'main 最多接受一个参数:args: Vec[str]');
    }
    const retV = this.callCompiled(bc.mainFnIdx, args, null, false);
    let code = 0;
    const sig = this.check.entry.items.get('main')?.sig;
    if (sig?.ret?.k === 'int' && retV?.t === 'int') {
      code = Number((BigInt(retV.v) % 256n + 256n) % 256n);
    }
    return { value: retV, exitCode: code };
  }

  runTests(filter = null) {
    if (this.tree) return super.runTests(filter);
    const results = [];
    const tests = [...this.entry.items.entries()].filter(([n, e]) => e.kind === 'test');
    for (const [name, entry] of tests) {
      const testName = name.slice(5);
      if (filter && !testName.includes(filter)) continue;
      const sub = new VMInterp(this.check, { out: this.out, errOut: this.errOut, capture: true, stdin: this.stdin, maxSteps: this.maxSteps });
      const r = { name: testName, ok: false, output: '', error: null, span: entry.decl.span };
      try {
        const idx = sub.compiled.fnIndexOfGet ? sub.compiled.fnIndexOfGet(entry) : sub.indexOfEntry(entry);
        if (idx === undefined || idx < 0) throw new Panic('M4001', `内部错误:测试函数未编译 ${testName}`);
        sub.callCompiled(idx, [], null, false);
        r.ok = true;
      } catch (e) {
        if (e instanceof Panic) {
          r.error = `${e.code}[${e.message}]` + (e.stack.length ? '\n' + e.stack.map(f => `  at ${f.name} (${f.span?.file}:${f.span?.line}:${f.span?.col})`).join('\n') : '');
          r.span = e.span ?? entry.decl.span;
        } else { r.error = String(e?.message ?? e); }
      }
      r.output = sub.flushCaptured();
      results.push(r);
    }
    return results;
  }

  // checker entry → 编译函数下标
  indexOfEntry(entry) {
    // 编译时以 entry 对象为键;compiled 里保存映射
    return this.compiled.entryFnIdx?.get(entry) ?? -1;
  }

  // ---------- 字节码执行 ----------

  // 调用编译函数:返回返回值;参数按值语义深拷贝(noCopySelf 时首参除外)
  callCompiled(fnIdx, args, span, noCopySelf = false, captures = null) {
    const bc = this.compiled;
    const fn = bc.functions[fnIdx];
    if (!fn) throw new Panic('M4001', `内部错误:函数未编译 #${fnIdx}`, span);
    if (this.frames.length > 250) {
      throw new Panic('M4005', `调用栈过深(>250 层递归);如需更深递归请改写为循环`, span);
    }
    // WASM 分层:纯数值函数走 wasm(参数/结果 i64 位型,i64/u64/f64;panic 经导入边界还原为 Ming Panic)
    if (this.wasmExports && this.wasmEligible?.has(fnIdx) && captures === null) {
      const info = this.wasmEligible.get(fnIdx);
      const sig = fn.entry.sig;
      const isVoid = sig.ret.k === 'unit';
      const retSigned = sig.ret.k === 'int' ? sig.ret.signed : true;
      const wasmArgs = [];
      let ok = true;
      for (let i = 0; i < info.nParams; i++) {
        const a = args[i];
        const pt = sig.params[i]?.type;
        if (!a) { ok = false; break; }
        if (pt?.k === 'float') {
          if (a.t !== 'float' || a.bits !== 64) { ok = false; break; }
          wasmArgs.push(a.v);
          continue;
        }
        if (pt?.k === 'str') {
          if (a.t !== 'str') { ok = false; break; }
          this.wasmStrTable.push(a.v);
          wasmArgs.push(this.wasmStrTable.length - 1);
          continue;
        }
        if (pt?.k === 'vec' && (pt.el?.k === 'int' || pt.el?.k === 'float') && pt.el?.bits === 64) {
          // 线性内存 ptr 路径(v0.19):批量拷贝,零句柄;mut 参数预留容量(v0.20 push)
          if (a.t !== 'vec') { ok = false; break; }
          const ptr = this.wasmWriteVecNum(a, pt.el.k, !!sig.params[i]?.mut);
          this.wasmParamTopStack.push(this.wasmParamTop);
          wasmArgs.push(ptr);
          continue;
        }
        if (pt?.k === 'vec' || pt?.k === 'map') {
          if (a.t !== pt.k) { ok = false; break; }
          this.wasmObjTable.push(a);
          wasmArgs.push(this.wasmObjTable.length - 1);
          continue;
        }
        if (a.t !== 'int' || a.bits !== 64) { ok = false; break; }
        wasmArgs.push(BigInt(a.v));
      }
      if (ok) {
        this.depth++;
        this.callStack.push({ name: fn.name, span });
        try {
          const exported = this.wasmExports['m' + fnIdx];
          const raw = exported(...wasmArgs);
          this.depth--;
          this.callStack.pop();
          if (this.wasmParamTopStack.length) this.wasmParamTop = this.wasmParamTopStack.pop();
          if (isVoid) return UNIT;
          if (sig.ret.k === 'str') return V.str(this.wasmStrTable[raw] ?? '');
          if (sig.ret.k === 'vec') {
            const el = sig.ret.el;
            if (el?.k === 'str') return deepCopy(this.wasmObjTable[raw] ?? V.vec([]));
            // 线性内存读回(v0.23):[len][cap][elems]
            const dv = new DataView(this.wasmMemory.buffer);
            const len = Number(dv.getBigInt64(raw, true));
            const out = [];
            for (let i = 0; i < len; i++) {
              if (el?.k === 'float') out.push(V.float(dv.getFloat64(raw + 16 + 8 * i, true), 64));
              else out.push(V.int(dv.getBigInt64(raw + 16 + 8 * i, true), 64, true));
            }
            return V.vec(out);
          }
          if (sig.ret.k === 'map') return deepCopy(this.wasmObjTable[raw] ?? V.map(new Map()));
          return sig.ret.k === 'float' ? V.float(raw, 64) : V.int(raw, 64, retSigned);
        } catch (e) {
          this.depth--;
          this.callStack.pop();
          if (e instanceof Panic) throw e;
          // wasm trap(RuntimeError:栈耗尽等)
          throw new Panic('M4005', `wasm 执行异常:${e?.message ?? e}`, span);
        }
      }
    }
    const beforeLen = this.frames.length;
    const scopeBase = this.syncScopeStack?.length ?? 0;
    const locals = new Array(fn.nLocals);
    for (let i = 0; i < fn.nParams; i++) {
      locals[i] = (noCopySelf && i === 0) ? args[i] : deepCopy(args[i]);
    }
    this.depth++;
    this.callStack.push({ name: fn.name, span });
    this.frames.push({ fn, ip: 0, locals, captures });
    try {
      const ret = this.execLoop();
      this.depth--;
      this.callStack.pop();
      return ret;
    } catch (e) {
      this.depth--;
      this.callStack.pop();
      this.frames.length = beforeLen; // 恢复调用方帧
      // 异常展开:drain 本帧(及更深)未退出的 scoped 块,吞掉子任务错误
      while ((this.syncScopeStack?.length ?? 0) > scopeBase) {
        try { this.exitSyncScope(true, null); } catch { break; }
      }
      throw e;
    }
  }

  // 核心执行循环:直到当前帧 RET
  execLoop() {
    const bc = this.compiled;
    const stack = this.valueStack;
    let frame = this.frames[this.frames.length - 1];
    const pool = bc.pool;
    const resolvedPool = this.resolvedPool;
    const spans = bc.spans;
    let code = frame.fn.code;

    for (;;) {
      if (++this.steps > this.maxSteps) {
        throw new Panic('M4001', `执行步数超过上限 ${this.maxSteps}(可能是死循环;用 --max-steps 调整)`);
      }
      const ins = code[frame.ip++];
      const op = ins[0];
      if (TRACE) {
        console.error(`[trace] ${frame.fn.name} ip=${frame.ip - 1} op=${op} a=${ins[1]} b=${ins[2]} stack=${stack.length} frames=${this.frames.length}`);
      }
      switch (op) {
        case OP.CONST: stack.push(resolvedPool[ins[1]]); break;
        case OP.POP: stack.pop(); break;
        case OP.DUP: stack.push(stack[stack.length - 1]); break;
        case OP.SWAP: {
          const n = stack.length;
          const t = stack[n - 1]; stack[n - 1] = stack[n - 2]; stack[n - 2] = t;
          break;
        }
        case OP.JUMP: frame.ip = ins[1]; break;
        case OP.JUMPFALSE: { if (!stack.pop().v) frame.ip = ins[1]; break; }
        case OP.LD: {
          if (ins[1] === 0) stack.push(frame.locals[ins[2]]);
          else stack.push(frame.captures[ins[2]]);
          break;
        }
        case OP.ST: {
          const v = deepCopy(stack.pop());
          if (ins[1] === 0) frame.locals[ins[2]] = v;
          else frame.captures[ins[2]] = v;
          break;
        }
        case OP.SET: {
          const v = deepCopy(stack.pop());
          if (ins[1] === 0) frame.locals[ins[2]] = v;
          else frame.captures[ins[2]] = v;
          break;
        }
        case OP.LDFN: {
          stack.push({ t: 'vclose', fnIdx: ins[1], captures: [] });
          break;
        }
        case OP.CLOSURE: {
          const plan = pool[ins[2]].v;
          const captures = plan.map(p => deepCopy('local' in p ? frame.locals[p.local] : frame.captures[p.cap]));
          stack.push({ t: 'vclose', fnIdx: ins[1], captures });
          break;
        }
        case OP.BIN: {
          const r = stack.pop(), l = stack.pop();
          stack.push(this.binOp(ins[1], l, r, this.spanOf(frame, ins)));
          break;
        }
        case OP.UN: {
          const v = stack.pop();
          if (ins[1] === 1) {
            if (v.t === 'int') {
              if (typeof v.v === 'number') {
                const r = -v.v;
                if (Number.isSafeInteger(r) && fits(r, v.bits, v.signed)) {
                  stack.push(V.int(r, v.bits, v.signed));
                  break;
                }
                const fixed = this.negSlow(v);
                stack.push(fixed);
              } else {
                const r = 0n - v.v;
                if (!(r >= -(1n << BigInt(v.bits - 1)) && r < (1n << BigInt(v.bits - 1)))) {
                  throw new Panic('M4002', `整数取负溢出:-${v.v} 超出范围`, this.spanOf(frame, ins));
                }
                stack.push(V.int(r, v.bits, v.signed));
              }
            } else stack.push(V.float(-v.v, v.bits));
          } else stack.push(V.bool(!v.v));
          break;
        }
        case OP.GETFIELD: {
          const name = pool[ins[1]].v;
          const base = stack.pop();
          stack.push(this.getFieldValue(base, name, this.spanOf(frame, ins)));
          break;
        }
        case OP.SETFIELD: {
          const name = pool[ins[1]].v;
          const val = stack.pop();
          const base = stack.pop();
          if (base.t !== 'struct') throw new Panic('M4001', '内部错误:字段赋值目标不是结构体', this.spanOf(frame, ins));
          base.fields.set(name, deepCopy(val));
          break;
        }
        case OP.INDEX: {
          const idx = stack.pop(), base = stack.pop();
          stack.push(this.indexValue(base, idx, this.spanOf(frame, ins)));
          break;
        }
        case OP.SETINDEX: {
          const val = stack.pop(), idx = stack.pop(), base = stack.pop();
          this.setIndexValue(base, idx, deepCopy(val), this.spanOf(frame, ins));
          break;
        }
        case OP.CALL: {
          const argc = ins[1];
          const args = stack.splice(stack.length - argc, argc);
          const callee = stack.pop();
          stack.push(this.callValue(callee, args, this.spanOf(frame, ins)));
          break;
        }
        case OP.CALLMETHOD: {
          const argc = ins[2];
          const name = pool[ins[1]].v;
          const args = argc ? stack.splice(stack.length - argc, argc) : [];
          let recv = stack.pop();
          // 前置分派:模块/类型接收者(树引擎在 evalCall Field 分支处理,这里等价)
          if (recv && recv.t === 'stdmod') {
            stack.push(this.callStd(recv.name, name, args, this.spanOf(frame, ins)));
            break;
          }
          if (recv && recv.t === 'typeobj') {
            stack.push(this.typeLevelValue(recv.prim, name, this.spanOf(frame, ins)));
            break;
          }
          if (recv && recv.t === 'ctor') {
            stack.push(this.constructVariant(recv, args, this.spanOf(frame, ins)));
            break;
          }
          stack.push(this.callMethod(recv, name, args, null, { span: this.spanOf(frame, ins) }, null));
          break;
        }
        case OP.RET: {
          // 单帧语义:execLoop 只执行当前函数帧,RET 弹帧并返回值
          // (调用方由 CALL 的 callValue 返回后接住返回值)
          const v = stack.pop();
          this.frames.pop();
          return v;
        }
        case OP.QMARK: {
          const v = stack.pop();
          if (v.t === 'enum') {
            if (v.def === 'builtin-opt' && v.tag === 'None') {
              this.frames.pop();
              return V.enumv('builtin-opt', 'None', []);
            }
            if (v.def === 'builtin-res' && v.tag === 'Err') {
              this.frames.pop();
              return V.enumv('builtin-res', 'Err', v.vals);
            }
            stack.push(v.vals[0]);
            break;
          }
          throw new Panic('M4001', '内部错误:"?" 目标不是 Option/Result', this.spanOf(frame, ins));
        }
        case OP.MAKEVEC: {
          const n = ins[1];
          const items = stack.splice(stack.length - n, n).map(deepCopy);
          stack.push(V.vec(items));
          break;
        }
        case OP.MAKEMAP: {
          const n = ins[1];
          const flat = stack.splice(stack.length - 2 * n, 2 * n);
          const m = new Map();
          for (let i = 0; i < n; i++) {
            const k = flat[i * 2], v = deepCopy(flat[i * 2 + 1]);
            m.set(normKey(k), v);
          }
          stack.push(V.map(m));
          break;
        }
        case OP.MAKETUPLE: {
          const n = ins[1];
          const items = stack.splice(stack.length - n, n).map(deepCopy);
          stack.push({ t: 'tuple', a: items });
          break;
        }
        case OP.MAKESTRUCT: {
          const spec = pool[ins[1]].v;
          const n = ins[2];
          const vals = stack.splice(stack.length - n, n);
          const fields = new Map();
          for (let i = 0; i < n; i++) fields.set(spec.names[i], deepCopy(vals[i]));
          stack.push({ t: 'struct', def: spec.def, name: spec.def.name, fields });
          break;
        }
        case OP.MAKEENUM: {
          const spec = pool[ins[1]].v;
          const n = ins[2];
          const vals = n ? stack.splice(stack.length - n, n).map(deepCopy) : [];
          const def = spec.def === 'builtin-opt' || spec.def === 'builtin-res' ? spec.def : spec.def;
          stack.push(V.enumv(def, spec.tag, vals));
          break;
        }
        case OP.CAST: {
          const v = stack.pop();
          const tn = pool[ins[1]].v;
          stack.push(this.castValue(v, { nt: 'TName', name: tn }, this.spanOf(frame, ins)));
          break;
        }
        case OP.CONCAT: {
          const n = ins[1];
          const parts = stack.splice(stack.length - n, n);
          let s = '';
          for (let i = 0; i < n; i++) s += displayStr(parts[i]);
          stack.push(V.str(s));
          break;
        }
        case OP.RANGE: {
          const hi = stack.pop(), lo = stack.pop();
          stack.push(V.range(lo, hi));
          break;
        }
        case OP.PATMATCH: {
          const v = stack.pop();
          const binds = this.matchPatternOrdered(pool[ins[1]].v, v);
          stack.push(binds === null ? null : binds); // null 用 JS null
          break;
        }
        case OP.JUMPNONE: {
          if (stack[stack.length - 1] === null) { stack.pop(); frame.ip = ins[1]; }
          break;
        }
        case OP.BIND: {
          const slots = pool[ins[1]].v;
          const binds = stack.pop();
          for (let i = 0; i < slots.length; i++) {
            frame.locals[slots[i]] = deepCopy(binds[i]);
          }
          break;
        }
        case OP.ITERNEW: {
          const it = stack.pop();
          stack.push(this.makeIterator(it));
          break;
        }
        case OP.ITERNEXT: {
          const iter = stack[stack.length - 1];
          const nx = iter.next();
          if (nx.done) frame.ip = ins[1];
          else stack.push(nx.value);
          break;
        }
        case OP.SYNC_ENTER: {
          this.enterSyncScope();
          break;
        }
        case OP.SYNC_EXIT: {
          this.exitSyncScope(false, this.spanOf(frame, ins));
          break;
        }
        case OP.PANICX: {
          const msg = stack.pop();
          throw new Panic('M4001', msg.v, this.spanOf(frame, ins));
        }
        // ---- 融合指令(v0.9):局部槽上的算术直存,免栈操作与中间对象 ----
        case OP.ADDI: {
          // a=槽,c=±1:等价 intBin('+', old, ±1) 全语义(含溢出检查)
          const old = frame.locals[ins[1]];
          const span = this.spanOf(frame, ins);
          let r;
          if (typeof old.v === 'number') {
            r = old.v + ins[2];
            if (!Number.isSafeInteger(r)) r = null;
          } else {
            r = BigInt(old.v) + BigInt(ins[2]);
          }
          if (r === null || !fits(r, old.bits, old.signed)) {
            throw new Panic('M4002', `整数+溢出:${old.v} + ${ins[2]} 超出 i${old.bits}${old.signed ? '' : 'u'} 范围`, span);
          }
          frame.locals[ins[1]] = V.int(r, old.bits, old.signed);
          break;
        }
        case OP.BINSETI: {
          // a=槽,b=字面量池下标,c=BIN 码:等价 intBin/binopValues(local, lit)
          const old = frame.locals[ins[1]];
          const lit = resolvedPool[ins[2]];
          frame.locals[ins[1]] = this.binOp(ins[3], old, lit, this.spanOf(frame, ins));
          break;
        }
        case OP.BINSET2: {
          // a=dst 槽,b=打包(s1<<8|s2),c=BIN 码:先读后写(dst 可与 s1/s2 重合)
          const s1 = (ins[2] >> 8) & 0xFF;
          const s2 = ins[2] & 0xFF;
          const r = this.binOp(ins[3], frame.locals[s1], frame.locals[s2], this.spanOf(frame, ins));
          frame.locals[ins[1]] = r;
          break;
        }
        default:
          throw new Panic('M4001', `内部错误:未知指令 ${op}`, this.spanOf(frame, ins));
      }
    }
  }

  spanOf(frame, ins) {
    const s = this.compiled.spans[ins[4]];
    return s ?? null;
  }

  binOp(code, l, r, span) {
    const op = BIN2OP[code];
    switch (op) {
      case '&&': case '||': return V.bool(op === '&&' ? (l.v && r.v) : (l.v || r.v));
      default: return this.binopValues(op, l, r, span);
    }
  }

  getFieldValue(base, name, span) {
    // 读取字段;非字段情况 = 方法接收者/类型对象等(检查器保证只读字段会到这里)
    if (base.t === 'struct' && base.fields.has(name)) return base.fields.get(name);
    // 其余(方法调用接收者等)不会以 GETFIELD 形式出现:CALLMETHOD 直接压 recv。
    // 唯一可能:Field 表达式作为值(枚举值字段?检查器禁止)。
    throw new Panic('M4001', `内部错误:字段 ${name} 未找到`, span);
  }

  indexValue(base, idx, span) {
    if (base.t === 'vec') {
      const i = Number(idx.v);
      if (!Number.isInteger(i) || i < 0 || i >= base.a.length) {
        throw new Panic('M4003', `索引越界:长度 ${base.a.length},访问 ${i}(用 .get(i) 返回 Option)`, span);
      }
      return base.a[i];
    }
    if (base.t === 'map') {
      const k = normKey(idx);
      if (!base.m.has(k)) {
        throw new Panic('M4007', `map 中不存在键 ${debugStr(idx)}(用 .get(k) 返回 Option)`, span);
      }
      return base.m.get(k);
    }
    throw new Panic('M4001', `内部错误:索引目标类型错误`, span);
  }

  setIndexValue(base, idx, val, span) {
    if (base.t === 'vec') {
      const i = Number(idx.v);
      if (!Number.isInteger(i) || i < 0 || i >= base.a.length) {
        throw new Panic('M4003', `索引越界:长度 ${base.a.length},访问 ${i}`, span);
      }
      base.a[i] = val;
      return;
    }
    if (base.t === 'map') {
      base.m.set(normKey(idx), val);
      return;
    }
    throw new Panic('M4001', '内部错误:索引赋值目标类型错误', span);
  }

  // 调用值:vclose / fnref / builtin / stdfn / typeobj / ctor
  callValue(callee, args, span) {
    switch (callee.t) {
      case 'vclose':
        return this.callCompiled(callee.fnIdx, args, span, false, callee.captures ?? []);
      case 'fnref': {
        const idx = this.indexOfEntry(callee.entry);
        if (idx >= 0) return this.callCompiled(idx, args, span, false);
        return this.callUser(callee.mod, callee.entry, null, args, span, false); // 防御
      }
      case 'builtin': {
        const impl = this.builtinImpl(callee.name);
        return impl(this, args, span);
      }
      case 'stdfn':
        return this.callStd(callee.mod, callee.name, args, span);
      case 'typeobj':
        return this.typeLevelValue(callee.prim, callee.name ?? '', span);
      case 'ctor':
        return this.constructVariant(callee, args, span);
      default:
        throw new Panic('M4001', '内部错误:调用目标不是函数', span);
    }
  }

  builtinImpl(name) {
    return BUILTIN_IMPLS[name];
  }

  makeIterator(it) {
    switch (it.t) {
      case 'vec': {
        let i = 0;
        return { next() { if (i < it.a.length) { ITER_VAL.value = it.a[i++]; return ITER_VAL; } return ITER_DONE; } };
      }
      case 'tuple': {
        let i = 0;
        return { next() { if (i < it.a.length) { ITER_VAL.value = it.a[i++]; return ITER_VAL; } return ITER_DONE; } };
      }
      case 'str': {
        const chars = [...it.v].map(c => V.str(c));
        let i = 0;
        return { next() { if (i < chars.length) { ITER_VAL.value = chars[i++]; return ITER_VAL; } return ITER_DONE; } };
      }
      case 'range': {
        // 双型区间迭代:number 快路径 | BigInt 慢路径
        const useNum = typeof it.lo.v === 'number' && typeof it.hi.v === 'number';
        let cur = it.lo.v;
        const hi = useNum ? it.hi.v : BigInt(it.hi.v);
        return {
          next: () => {
            this.step();
            if (useNum) {
              if (cur < hi) { const v = V.int(cur, it.lo.bits, it.lo.signed); cur = cur + 1; return { done: false, value: v }; }
              return { done: true };
            }
            let c = BigInt(cur);
            if (c < hi) { const v = V.int(c, it.lo.bits, it.lo.signed); cur = c + 1n; return { done: false, value: v }; }
            return { done: true };
          },
        };
      }
      case 'map': {
        const entries = [...it.m.entries()].map(([k, v]) => V.tuple([keyValue(k), v]));
        let i = 0;
        return { next() { if (i < entries.length) { ITER_VAL.value = entries[i++]; return ITER_VAL; } return ITER_DONE; } };
      }
      default:
        throw new Panic('M3026', `${it.t} 不可迭代`);
    }
  }

  // 顺序模式匹配(与树引擎 tryPattern 同语义;绑定按遍历序成数组)
  matchPatternOrdered(pat, v) {
    const binds = [];
    if (this.tryPatternO(pat, v, binds)) return binds;
    return null;
  }

  tryPatternO(pat, v, binds) {
    switch (pat.nt) {
      case 'PWild': return true;
      case 'PIdent': binds.push(v); return true;
      case 'PLit': {
        const lit = pat.lit;
        if (lit.kind === 'int') {
          if (v.t !== 'int') return false;
          const lv = normInt(BigInt(lit.val) * (pat.neg ? -1n : 1n));
          return typeof v.v === typeof lv ? v.v === lv : BigInt(v.v) === BigInt(lv);
        }
        if (lit.kind === 'str') return v.t === 'str' && v.v === lit.val;
        return v.t === 'bool' && v.v === (lit.val === 'true');
      }
      case 'PEnum': {
        if (v.t === 'enum') {
          if (v.def === 'builtin-opt' || v.def === 'builtin-res') {
            if (pat.variant !== v.tag) return false;
          } else {
            if (pat.enumName !== null && pat.enumName !== v.def.name) return false;
            if (pat.variant !== v.tag) return false;
          }
          if (pat.args.length !== v.vals.length) return false;
          return pat.args.every((a, i) => this.tryPatternO(a, v.vals[i], binds));
        }
        return false;
      }
      case 'PTuple': {
        if (v.t !== 'tuple' || v.a.length !== pat.pats.length) return false;
        return pat.pats.every((p, i) => this.tryPatternO(p, v.a[i], binds));
      }
      default: return false;
    }
  }

  // ---------- 引擎统一入口:树引擎的调用点在 VM 模式下走字节码 ----------

  callUser(mod, entry, env, args, callSpan, noCopySelf = false) {
    if (this.tree) return super.callUser(mod, entry, env, args, callSpan, noCopySelf);
    const idx = this.indexOfEntry(entry);
    if (idx >= 0) return this.callCompiled(idx, args, callSpan, noCopySelf);
    return super.callUser(mod, entry, env, args, callSpan, noCopySelf);
  }

  callClosure(clo, args, callSpan) {
    if (this.tree) return super.callClosure(clo, args, callSpan);
    if (clo.t === 'vclose') return this.callCompiled(clo.fnIdx, args, callSpan, false);
    return super.callClosure(clo, args, callSpan);
  }
}
