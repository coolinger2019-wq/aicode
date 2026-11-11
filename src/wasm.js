// wasm.js — Ming WASM 后端探索(v0.11)。
// 分层执行:纯整数(签名 i64)函数从 AST 直接编译为 WebAssembly(i64 局部/算术/控制流),
// 溢出/除零/移位检查通过导入的 panic 函数回抛 Ming Panic(带 span);其余函数回落 JS VM。
// 手写二进制编码:LEB128 + 标准节(type/import/function/export/code),无外部依赖。
//
// 语义等价要点(与 JS 引擎逐点对照):
//   * i64 加/减/乘在 wasm 中静默回绕 → 每次运算做溢出检查,溢出调导入 panic(M4002)
//   * 除零显式检查(M4004);i64 min / -1 的除法(div_s 会 trap)先查(M4002)
//   * 移位位数越界显式检查(M4002);wasm 移位自动按 64 取模,必须先拦
//   * 循环回边与函数入口注入 ming_tick,保持 --max-steps 语义
//   * 仅签名 i64;浮点/无符号/字符串/集合/闭包/效果函数不 eligible → 自动回落
//   * eligible 函数的调用在 wasm 内直接 call(递归安全,无 JS 栈增长)

export class Unsupported extends Error { }

// ---------- LEB128 ----------

function uleb(bytes, v) {
  v = v >>> 0;
  for (;;) {
    const b = v & 0x7f;
    v >>>= 7;
    if (v === 0) { bytes.push(b); return; }
    bytes.push(b | 0x80);
  }
}

function sleb(bytes, v) {
  v = BigInt(v);
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    const signBit = (byte & 0x40) !== 0;
    if ((v === 0n && !signBit) || (v === -1n && signBit)) { bytes.push(byte); return; }
    bytes.push(byte | 0x80);
  }
}

function section(id, content) {
  return [id, ...ulebBytes(content.length), ...content];
}

function ulebBytes(v) {
  const out = [];
  uleb(out, v);
  return out;
}

function nameBytes(s) {
  const b = Array.from(Buffer.from(s, 'utf8'));
  return [...ulebBytes(b.length), ...b];
}

function vec(items) {
  const out = [...ulebBytes(items.length)];
  for (const it of items) out.push(...it);
  return out;
}

// ---------- 类型 ----------

const I64 = 0x7e, I32 = 0x7f, F64 = 0x7c, VOID = 0x40;

// std.math 导入表(v0.12):名字 → 参数型/结果型/JS 实现;顺序即导入序(3 起算)
export const MATH_IMPORTS = [
  ['sqrt', Math.sqrt], ['pow', Math.pow], ['abs', Math.abs], ['floor', Math.floor],
  ['ceil', Math.ceil], ['round', Math.round], ['exp', Math.exp], ['ln', Math.log],
  ['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan],
  // v0.29 数学补全(追加在尾部,索引动态推导)
  ['asin', Math.asin], ['acos', Math.acos], ['atan', Math.atan], ['atan2', Math.atan2],
  ['sinh', Math.sinh], ['cosh', Math.cosh], ['tanh', Math.tanh],
  ['log2', Math.log2], ['log10', Math.log10], ['cbrt', Math.cbrt], ['hypot', Math.hypot],
];
const MATH_IDX = new Map(MATH_IMPORTS.map(([n], i) => [n, 3 + i]));

// std.str 导入表(v0.15):字符串以 i32 句柄穿越 wasm;JS 侧持表
// 序号在 ming tick/panic 之后、math 之前?不——追加到尾部,统一由 STR_BASE 计算
const STR_IMPORTS = ['str_const', 'str_cat', 'str_eq', 'str_len'];

// Vec/Map 导入(v0.18):容器以 i32 句柄穿越;JS 侧 objTable 持 V 对象
const VECMAP_IMPORTS = [
  ['vec_new', [], 'i32'],
  ['vec_len', ['i32'], 'i64'],
  ['vec_get_i64', ['i32', 'i64'], 'i64'],
  ['vec_get_f64', ['i32', 'i64'], 'f64'],
  ['vec_get_str', ['i32', 'i64'], 'i32'],
  ['vec_push_i64', ['i32', 'i64'], VOID],
  ['vec_push_f64', ['i32', 'f64'], VOID],
  ['vec_push_str', ['i32', 'i32'], VOID],
  ['map_new', [], 'i32'],
  ['map_len', ['i32'], 'i64'],
  ['map_get_i64', ['i32', 'i32'], 'i64'],
  ['map_get_f64', ['i32', 'i32'], 'f64'],
  ['map_get_str', ['i32', 'i32'], 'i32'],
  ['map_set_i64', ['i32', 'i32', 'i64'], VOID],
  ['map_set_f64', ['i32', 'i32', 'f64'], VOID],
  ['map_set_str', ['i32', 'i32', 'i32'], VOID],
  ['ming_grow', ['i32', 'i32'], 'i32'], // (ptr, newCap) -> newPtr:满容量时 JS 侧搬迁布局
  ['str_from_i64', ['i64'], 'i32'],
  ['str_from_f64', ['f64'], 'i32'],
  ['str_from_bool', ['i32'], 'i32'],
  ['str_lt', ['i32', 'i32'], 'i32'],
  ['str_le', ['i32', 'i32'], 'i32'],
  ['str_gt', ['i32', 'i32'], 'i32'],
  ['str_ge', ['i32', 'i32'], 'i32'],
  ['str_trim', ['i32'], 'i32'],
  ['str_trim_start', ['i32'], 'i32'],
  ['str_trim_end', ['i32'], 'i32'],
  ['str_upper', ['i32'], 'i32'],
  ['str_lower', ['i32'], 'i32'],
  ['str_replace', ['i32', 'i32', 'i32'], 'i32'],
  ['str_contains', ['i32', 'i32'], 'i32'],
  ['str_starts', ['i32', 'i32'], 'i32'],
  ['str_ends', ['i32', 'i32'], 'i32'],
  ['map_key_at', ['i32', 'i64'], 'i32'], // v0.32 补:map for-in 的键枚举(此前调用但未声明,实例化即失败)
];
const EXTRA_IDX = new Map(VECMAP_IMPORTS.map(([n], i) => [n, i]));
const TOTAL_IMPORTS = 3 + MATH_IMPORTS.length + STR_IMPORTS.length + VECMAP_IMPORTS.length;
// v0.32:ming_alloc / ming_copy_vec 声明在 VECMAP 之后(TOTAL_IMPORTS+1/+2);函数索引基址随之 +2
const DEFINED_BASE = TOTAL_IMPORTS + 2;
const I64_MIN = -(2n ** 63n);

const SCALARS = new Set(['int', 'float', 'str']);
const numOkElem = (t) => (t?.k === 'int' && t.bits === 64) || (t?.k === 'float' && t.bits === 64) || t?.k === 'str';

function functype(params, results) {
  return [0x60, ...vec(params.map(p => [p])), ...vec(results.map(r => [r]))];
}

// ---------- 编译入口 ----------

export function tryCompileWasm(check, compiled) {
  try {
    const c = new WasmCompiler(check, compiled);
    return c.run();
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

// 资格分析独立入口(C 后端复用;单一事实来源 = WasmCompiler.analyze)
// 返回 Map<mingFnIdx, { exportName, nParams }>
export function analyzeEligibility(check, compiled, opts = {}) {
  const c = new WasmCompiler(check, compiled);
  return c.analyze(opts);
}

export class WasmCompiler {
  constructor(check, compiled) {
    this.check = check;
    this.compiled = compiled;
    this.spans = compiled.spans;
    this.spanCache = new Map();
    this.eligible = new Map(); // mingFnIdx → { exportName, nParams }
    this.modulesByFile = new Map(check.modules.map(m => [m.file, m]));
  }

  // checker 类型 → num-ty('i64'|'u64'|'f64'|'str'|'vi64'|'vf64'|'vstr'|'mi64'|'mf64'|'mstr'|null)
  typeToNumTy(t) {
    if (!t) return null;
    switch (t.k) {
      case 'int': return t.bits === 64 ? (t.signed ? 'i64' : 'u64') : null;
      case 'float': return t.bits === 64 ? 'f64' : null;
      case 'str': return 'str';
      case 'vec': {
        const el = this.typeToNumTy(t.el);
        if (!el || el === 'u64') return null;
        return 'v' + el;
      }
      case 'map': {
        if (t.kt?.k !== 'str') return null;
        const vt = this.typeToNumTy(t.vt);
        if (!vt || vt === 'u64') return null;
        return 'm' + vt;
      }
      default: return null;
    }
  }

  // 字符串常量表:偏移 → 字符串(实例化时 JS 侧注册为句柄表)
  strConstOffset(text) {
    if (!this.strConsts) { this.strConsts = []; this.strConstIdx = new Map(); }
    let off = this.strConstIdx.get(text);
    if (off === undefined) {
      off = this.strConsts.length;
      this.strConsts.push(text);
      this.strConstIdx.set(text, off);
    }
    return off;
  }

  strFromIdx(kind) {
    // v0.32 修复:此前按旧表布局写死偏移,str_from_* 移入 VECMAP_IMPORTS 后指向错行
    return 3 + MATH_IMPORTS.length + STR_IMPORTS.length + EXTRA_IDX.get('str_from_' + kind);
  }

  strImportIdx(name) {
    // 导入序:tick(0) + panic×2(1,2) + math(3..3+M-1) + str(其后)
    return 3 + MATH_IMPORTS.length + STR_IMPORTS.indexOf('str_' + name);
  }

  spanId(span) {
    const key = span ? `${span.line}:${span.col}` : '0';
    let idx = this.spanCache.get(key);
    if (idx === undefined) {
      idx = this.spans.length;
      this.spanCache.set(key, idx);
      this.spans.push(span ?? null);
    }
    return idx;
  }

  run() {
    const fns = this.compiled.functions;
    if (process.env.MING_WASM_DEBUG) console.error('[wasm run] fns=' + fns.length);
    this.analyze();
    if (this.eligible.size === 0) return null;

    const order = [...this.eligible.keys()].sort((a, b) => a - b);
    const wasmIdxOf = new Map(order.map((fi, ord) => [fi, ord]));
    this.wasmOrder = order;
    if (process.env.MING_WASM_DEBUG) {
      for (const fi of order) {
        try { this.emitBody(fns[fi], 3); console.error('[wasm] fn', fns[fi].name, 'OK'); }
        catch (e) { console.error('[wasm] fn', fns[fi].name, e instanceof Unsupported ? ('REJECT: ' + e.message) : ('THROW: ' + e.message)); }
      }
    }
    const bytes = this.emitModule(fns, order, wasmIdxOf);
    return { bytes: new Uint8Array(bytes), eligible: this.eligible };
  }

  // 资格分析:形状 pass + 调用图不动点回退(单一事实来源,wasm 与 C 后端共用)。
  // opts.numericOnly:额外拒绝 str/Vec/Map 形态 —— C 后端 C1 只收 i64/u64/f64 签名。
  analyze(opts = {}) {
    const fns = this.compiled.functions;
    const numericOnly = !!opts.numericOnly;
    this.ffiEffectsAllowed = !!opts.ffi; // v0.43:C 后端允许效果 ⊆ {ffi} 的函数
    // 资格分析(形状)
    for (let i = 0; i < fns.length; i++) {
      const f = fns[i];
      if (f && !(f.entry?.decl?.requires || f.entry?.decl?.ensures) && this.isEligibleShape(f, !!opts.sigExt, !!opts.sigExt2, !!opts.sigExt3) && (!numericOnly || this.isNumericSig(f, !!opts.sigExt, !!opts.sigExt2, !!opts.sigExt3))) {
        this.eligible.set(i, { exportName: 'm' + i, nParams: f.nParams });
      }
    }
    // v0.43:extern fn(FFI 声明)预标记为 eligible(体为合成桩,C 后端用 dlsym 槽替代)
    if (this.ffiEffectsAllowed) {
      for (let i = 0; i < fns.length; i++) {
        const f = fns[i];
        if (f?.entry?.decl?.nt === 'ExternFnDecl' && this.isNumericSig(f, !!opts.sigExt, !!opts.sigExt2, !!opts.sigExt3)) {
          this.eligible.set(i, { exportName: 'm' + i, nParams: f.nParams });
        }
      }
    }
    // 资格不动点:被调方回落则调用方回落(extern fn 跳过桩体遍历——其"调用"由 dlsym 承担)
    let changed = true;
    while (changed) {
      changed = false;
      for (const [idx] of [...this.eligible]) {
        if (fns[idx]?.entry?.decl?.nt === 'ExternFnDecl') continue;
        try {
          this.walkCalls(fns[idx].entry.decl.body, (name) => {
            // v0.43:prelude 变体构造器(Some/None/Ok/Err)不是函数调用——此前被当作
            // 未解析调用,带构造器的函数在不动点被整批降级(C 后端 ffi 函数即此遭遇)
            if (name === 'Some' || name === 'None' || name === 'Ok' || name === 'Err') return;
            const called = this.resolveMingFn(fns[idx], name);
            if (called === null || !this.eligible.has(called)) throw new Unsupported('call ' + name);
          });
        } catch (e) {
          if (e instanceof Unsupported) { this.eligible.delete(idx); changed = true; }
          else throw e;
        }
      }
    }
    return this.eligible;
  }

  // 数值签名:C1 = 仅 i64/u64/f64(返回可为 unit);ext(C2)= + str/Vec[i64];
  // ext2(C3)= + Map[str,i64]/Option[i64];ext3(v0.43)= + Result[i64,str](C 后端全消费面)
  isNumericSig(f, ext = false, ext2 = false, ext3 = false) {
    const sig = f.entry?.sig;
    if (!sig) return false;
    const numOk = (t) => {
      if ((t?.k === 'int' && t.bits === 64) || (t?.k === 'float' && t.bits === 64)) return true;
      if (ext && t?.k === 'str') return true;
      if (ext && t?.k === 'vec' && t.el?.k === 'int' && t.el?.bits === 64 && t.el?.signed) return true;
      if (ext2 && t?.k === 'map' && t.kt?.k === 'str' && t.vt?.k === 'int' && t.vt?.bits === 64 && t.vt?.signed) return true;
      if (ext2 && t?.k === 'opt' && t.el?.k === 'int' && t.el?.bits === 64 && t.el?.signed) return true;
      if (ext3 && t?.k === 'res' && t.ok?.k === 'int' && t.ok?.bits === 64 && t.ok?.signed && t.err?.k === 'str') return true;
      return false;
    };
    if (sig.ret?.k !== 'unit' && !numOk(sig.ret)) return false;
    for (const p of sig.params) {
      if (!numOk(p.type)) return false;
    }
    return true;
  }

  // v0.43:ext/ext2/ext3 贯穿形状检查(wasm 不传 → 严格;C 后端按 opts 放行)
  isEligibleShape(f, ext = false, ext2 = false, ext3 = false) {
    const sig = f.entry?.sig;
    if (!sig || !f.entry.decl.body) return false;
    if (f.entry.decl.name.startsWith('__repl_')) return false;
    // 基线 = wasm 既有形状(数值/str/Vec/Map);opt(ext2)/Result(ext3)为 C 后端扩展面
    const numOk = (t) => (t?.k === 'int' && t.bits === 64) || (t?.k === 'float' && t.bits === 64) || t?.k === 'str' // u64/i64/f64/str(v0.15)
      || (t?.k === 'vec' && numOkElem(t.el))
      || (t?.k === 'map' && t.kt?.k === 'str' && numOkElem(t.vt)) // v0.18
      || (ext2 && t?.k === 'opt' && numOkElem(t.el)) // v0.41(C 形参)
      || (ext3 && t?.k === 'res' && t.ok?.k === 'int' && t.ok?.bits === 64 && t.ok?.signed && t.err?.k === 'str'); // v0.43(C 形参)
    for (const p of sig.params) {
      if (!numOk(p.type)) return false;
    }
    if (numOk(sig.ret)) { /* ok */ }
    else if (sig.ret?.k === 'unit') { /* ok */ }
    else return false;
    if (sig.effects?.size) {
      // v0.43:C 后端 opts.ffi 允许效果 ⊆ {ffi}(extern 调用;wasm 路径仍严格拒绝)
      if (!this.ffiEffectsAllowed || ![...sig.effects].every(e => e === 'ffi')) return false;
    }
    return true;
  }

  resolveMingFn(callerFn, name) {
    const mod = this.modulesByFile.get(callerFn.modFile);
    if (!mod) return null;
    const entry = mod.items.get(name);
    if (entry?.kind !== 'fn') return null;
    const idx = this.compiled.entryFnIdx?.get(entry);
    return idx === undefined ? null : idx;
  }

  walkCalls(node, fn) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) this.walkCalls(x, fn); return; }
    if (node.nt === 'Call' && node.callee.nt === 'Ident') fn(node.callee.name);
    if (node.nt === 'Lambda' || node.nt === 'FnStmt') return;
    for (const k of Object.keys(node)) {
      if (k === 'span' || k === 'docs' || k === 'lit') continue;
      const v = node[k];
      if (v && typeof v === 'object') this.walkCalls(v, fn);
    }
  }

  // ---------- 模块生成 ----------

  emitModule(fns, order, wasmIdxOf) {
    const types = [];
    const typeKey = new Map();
    const typeOf = (params, results) => {
      const key = params.join(',') + '->' + results.join(',');
      if (typeKey.has(key)) return typeKey.get(key);
      const idx = types.length;
      types.push(functype(params, results));
      typeKey.set(key, idx);
      return idx;
    };
    const T_VOID = typeOf([], []);
    const T_PANIC = typeOf([I32], []);
    const T_MATH1 = typeOf([F64], [F64]);
    const T_MATH2 = typeOf([F64, F64], [F64]);

    // 导入:tick + panic×2 + std.math(每个函数一个导入,JS 侧实现)
    const imports = [
      [...nameBytes('ming'), ...nameBytes('tick'), 0x00, ...ulebBytes(T_VOID)],
      [...nameBytes('ming'), ...nameBytes('panic_m4002'), 0x00, ...ulebBytes(T_PANIC)],
      [...nameBytes('ming'), ...nameBytes('panic_m4004'), 0x00, ...ulebBytes(T_PANIC)],
      ...MATH_IMPORTS.map(([n]) => {
        // v0.39 修复:双参清单此前漏了 atan2/hypot(v0.29 补函数)——它们被声明为
        // 单参导入,调用只消费栈顶一个实参,其余留在栈上参与后续运算 → 静默错值
        const two = ['pow', 'min', 'max', 'atan2', 'hypot'].includes(n);
        return [...nameBytes('ming'), ...nameBytes('math_' + n), 0x00, ...ulebBytes(two ? T_MATH2 : T_MATH1)];
      }),
      ...STR_IMPORTS.map((n, i) => {
        // str_const(I32)->I32, str_cat(I32,I32)->I32, str_eq(I32,I32)->I32, str_len(I32)->I64
        let params, results;
        if (n === 'str_const') { params = [I32]; results = [I32]; }
        else if (n === 'str_len') { params = [I32]; results = [I64]; }
        else { params = [I32, I32]; results = [I32]; }
        return [...nameBytes('ming'), ...nameBytes('str_' + n.slice(4)), 0x00, ...ulebBytes(typeOf(params, results))];
      }),
      ...VECMAP_IMPORTS.map(([n, params, results]) => {
        // v0.32 修复:表里 results 可能是标量串('i32');此前 results.map 直接 TypeError →
        // 整模块 emit 抛错 → tryWasm 静默回落——wasm 层自 v0.23 起从未实例化成功。
        const pt = (Array.isArray(params) ? params : [params]).map(x => x === 'i32' ? I32 : x === 'f64' ? F64 : I64);
        const rt = (Array.isArray(results) ? results : [results]).map(x => x === 'i32' ? I32 : x === 'f64' ? F64 : I64);
        return [...nameBytes('ming'), ...nameBytes(n), 0x00, ...ulebBytes(typeOf(pt, rt))];
      }),
      // v0.32 修复:ming_alloc / ming_copy_vec 被生成代码调用(allocImportIdx/copyVecImportIdx)
      // 却从未在导入节声明 → 实例化校验失败 → 静默回落。声明补齐,索引与既有算式一致。
      ...[['ming_alloc', ['i32'], ['i32']], ['ming_copy_vec', ['i32'], ['i32']]].map(([n, params, results]) => {
        const pt = params.map(x => x === 'i32' ? I32 : I64);
        const rt = results.map(x => x === 'i32' ? I32 : I64);
        return [...nameBytes('ming'), ...nameBytes(n), 0x00, ...ulebBytes(typeOf(pt, rt))];
      }),
    ];
    // (N_IMPORTS 曾被引用但从未定义——整模块 ReferenceError 的元凶之一;参数已废弃)

    const wasmTypeOf = (t) => t.k === 'float' ? F64 : (t.k === 'str' || t.k === 'vec' || t.k === 'map' ? I32 : I64);
    const sigTypes = order.map(fi => {
      const sig = fns[fi].entry.sig;
      const isVoid = sig.ret.k === 'unit';
      return typeOf(sig.params.map(p => wasmTypeOf(p.type)), isVoid ? [] : [wasmTypeOf(sig.ret)]);
    });

    const exportSection = order.map((fi, ord) =>
      [...nameBytes('m' + fi), 0x00, ...ulebBytes(DEFINED_BASE + ord)]);

    const bodies = order.map((fi) => {
      const body = this.emitBody(fns[fi], 0);
      return [...ulebBytes(body.length), ...body];
    });

    const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    bytes.push(...section(1, vec(types)));
    bytes.push(...section(2, vec(imports)));
    bytes.push(...section(3, vec(sigTypes.map(t => ulebBytes(t)))));
    // v0.32 修复:此前 ulebBytes(4) 声明了 4 个 memory(wasm 上限 1 个)→ 实例化必败;
    // 正确:1 个 memory,min 4 页;并导出为 "mem" 供 JS 侧读写(v0.23 线性内存传递)
    bytes.push(...section(5, vec([[0x00, 0x04]])));
    bytes.push(...section(7, vec([[...nameBytes('mem'), 0x02, 0x00], ...exportSection])));
    bytes.push(...section(10, vec(bodies)));
    return bytes;
  }

  // ---------- 函数体 ----------

  emitBody(f, N_IMPORTS) {
    // v0.32 修复(两遍发射):scratch 槽基址此前 = f.nLocals,与 wasm 侧 declareLocal 分配的
    // 用户 let 槽完全重叠(用户局部变量被 scratch 冲掉,静默错值)。第一遍探测用户槽位上限,
    // 第二遍把 scratch 基址放到其上重发。
    const probe = this.emitBodyOnce(f, f.nLocals);
    return this.emitBodyOnce(f, probe.slots).bytes;
  }

  emitBodyOnce(f, scratchBase) {
    const sig = f.entry.sig;
    const isVoid = sig.ret.k === 'unit';
    const instr = [];
    // locals:Ming 槽位(按类型)+ i64 scratch×3 + f64 scratch×2(编译后按最终类型分组声明)
    const slotTypes = [];
    for (let i = 0; i < sig.params.length; i++) {
      slotTypes.push(sig.params[i].type.k === 'float' ? 'f64' : 'i64');
    }
    while (slotTypes.length < f.nLocals) slotTypes.push('i64'); // 预留(编译中按需改型)
    const ctx = {
      bytes: instr,
      nParams: f.nParams,
      slots: f.nLocals,
      slotTypes,                   // slot → 'i64' | 'f64'
      scratch0: scratchBase,       // i64 scratch
      scratch1: scratchBase + 1,
      scratch2: scratchBase + 2,
      fscratch0: scratchBase + 3,  // f64 scratch
      fscratch1: scratchBase + 4,
      iscratch: scratchBase + 5,   // i32 scratch(容器句柄)
      iscratch2: scratchBase + 6,  // i32 scratch2(str 键句柄/str 默认值)
      iscratch3: scratchBase + 7,  // i32 scratch3(len 存取)
      scopes: [new Map()],
      loopStack: [],
      isVoid,
      retTy: sig.ret.k === 'float' ? 'f64' : (sig.ret.k === 'int' && !sig.ret.signed ? 'u64' : 'i64'),
      modFile: f.modFile,
    };
    for (let i = 0; i < sig.params.length; i++) {
      ctx.scopes[0].set(sig.params[i].name, i);
      const pt = sig.params[i].type;
      if (pt.k === 'vec' && (pt.el?.k === 'int' && pt.el.bits === 64 && pt.el.signed)) {
        ctx.slotTypes[i] = sig.params[i].mut ? 'vi64ptrm' : 'vi64ptr'; // m = 可写(push/set)
      } else if (pt.k === 'vec' && (pt.el?.k === 'float' && pt.el.bits === 64)) {
        ctx.slotTypes[i] = sig.params[i].mut ? 'vf64ptrm' : 'vf64ptr';
      } else {
        ctx.slotTypes[i] = pt.k === 'float' ? 'f64' : (pt.signed === false && pt.k === 'int' ? 'u64' : (pt.k === 'str' ? 'str' : (pt.k === 'vec' || pt.k === 'map' ? 'vi64' : 'i64')));
      }
    }

    // 函数入口 tick(maxSteps)
    this.callImport(ctx, 0, []);

    this.compileBlockW(f.entry.decl.body, ctx, isVoid ? null : ctx.retTy, /* noTailFallback */ true);
    if (!isVoid) {
      // 检查器保证数值函数必然产生值;函数级兜底(块内不再重复)
      this.compileZero(ctx, ctx.retTy);
    }
    instr.push(0x0b); // 函数 end

    // scratch 追加到槽类型表尾部,再按连续同型分组(表内是 'i64'/'f64' 字符串 → 转操作码)
    while (slotTypes.length < scratchBase) slotTypes.push('i64');
    const opcodeOf = (t) => (t === 'f64' ? F64 : (t === 'str' || t === 'i32' || t === 'vi64ptr' || t === 'vf64ptr' || t.startsWith('v') || t.startsWith('m') ? I32 : I64));
    const all = [...slotTypes.slice(0, scratchBase), 'i64', 'i64', 'i64', 'f64', 'f64', 'i32', 'i32', 'i32'].map(opcodeOf);
    const groups = [];
    let groupCount = 0;
    let run = null;
    for (const t of all) {
      if (run && run[1] === t) run[0]++;
      else { if (run) { groups.push(...ulebBytes(run[0]), ...ulebBytes(run[1])); groupCount++; } run = [1, t]; }
    }
    if (run) { groups.push(...ulebBytes(run[0]), ...ulebBytes(run[1])); groupCount++; }
    // locals 声明 = 组数前缀 + 各组(count,type)——不是字节数前缀
    const body = [...ulebBytes(groupCount), ...groups, ...instr];
    return { bytes: body, slots: ctx.slots };
  }

  callImport(ctx, importIdx, args) {
    const b = ctx.bytes;
    for (const a of args) b.push(...a);
    b.push(0x10);
    uleb(b, importIdx);
  }

  pushI32(ctx, v) { ctx.bytes.push(0x41); sleb(ctx.bytes, v); }
  pushI64(ctx, v) { ctx.bytes.push(0x42); sleb(ctx.bytes, v); }
  localGet(ctx, i) { ctx.bytes.push(0x20); uleb(ctx.bytes, i); }
  localSet(ctx, i) { ctx.bytes.push(0x21); uleb(ctx.bytes, i); }
  emitPanic(ctx, code, span) {
    // wasm 内永不返回:JS 导入函数直接 throw Ming Panic
    this.pushI32(ctx, this.spanId(span));
    this.callImport(ctx, code === 'M4004' ? 2 : 1, []);
  }

  // math 调用识别:math.sqrt(x) 与 std.math.sqrt(x) 两种形式 → math 名或 null
  mathNameOf(callee, ctx) {
    if (callee.nt !== 'Field') return null;
    if (callee.base.nt === 'Ident' && callee.base.name === 'math' && !this.slotOf(ctx, 'math')) return callee.name;
    if (callee.base.nt === 'Field' && callee.base.base.nt === 'Ident' && callee.base.base.name === 'std'
      && callee.base.name === 'math' && !this.slotOf(ctx, 'std')) return callee.name;
    return null;
  }

  // 检查型二元运算:a = scratch0, b = scratch1 → 结果写 scratch2(i64;溢出/除零语义逐点等价)
  emitCheckedOp(ctx, op, span) {
    const b = ctx.bytes;
    const s0 = ctx.scratch0, s1 = ctx.scratch1, s2 = ctx.scratch2;
    switch (op) {
      case '+': {
        this.localGet(ctx, s0); this.localGet(ctx, s1);
        b.push(0x7c);                    // add(回绕)
        this.localSet(ctx, s2);
        // overflow iff ((a ^ r) & (b ^ r)) < 0
        this.localGet(ctx, s0); this.localGet(ctx, s2); b.push(0x85);
        this.localGet(ctx, s1); this.localGet(ctx, s2); b.push(0x85);
        b.push(0x83);
        this.pushI64(ctx, 0n); b.push(0x53);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);
        return;
      }
      case '-': {
        this.localGet(ctx, s0); this.localGet(ctx, s1);
        b.push(0x7d);
        this.localSet(ctx, s2);
        // overflow iff (a ^ b) & (a ^ r) < 0
        this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x85);
        this.localGet(ctx, s0); this.localGet(ctx, s2); b.push(0x85);
        b.push(0x83);
        this.pushI64(ctx, 0n); b.push(0x53);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);
        return;
      }
      case '*': {
        this.localGet(ctx, s0); this.localGet(ctx, s1);
        b.push(0x7e);
        this.localSet(ctx, s2);
        // b==0 → 无溢出;b==-1 → a==min;否则 r/b != a
        b.push(0x02); b.push(0x40);     // block
        this.localGet(ctx, s1); this.pushI64(ctx, 0n); b.push(0x51); b.push(0x0d); uleb(b, 0);
        this.localGet(ctx, s1); this.pushI64(ctx, -1n); b.push(0x51);
        b.push(0x04); b.push(0x40);
        this.localGet(ctx, s0); this.pushI64(ctx, I64_MIN); b.push(0x51);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);                    // end if
        b.push(0x05);                    // else(b != -1)
        this.localGet(ctx, s2); this.localGet(ctx, s1); b.push(0x7f); // div_s(r, b)
        this.localGet(ctx, s0); b.push(0x52);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);                    // end if D(else 分支内的除法检查)
        b.push(0x0b);                    // end if B(b == -1 检查,if/else)
        b.push(0x0b);                    // end block A(v0.39 修复:缺此 end——自 v0.23 起
                                         // 任何含 * 的 eligible 函数都让整模块校验失败 →
                                         // wasm 层静默失守,乘法程序全部回落 JS VM)
        return;
      }
      case '/': {
        this.localGet(ctx, s1); this.pushI64(ctx, 0n); b.push(0x51);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4004', span);
        b.push(0x0b);
        this.localGet(ctx, s1); this.pushI64(ctx, -1n); b.push(0x51);
        b.push(0x04); b.push(0x40);
        this.localGet(ctx, s0); this.pushI64(ctx, I64_MIN); b.push(0x51);
        b.push(0x83);                    // i64.and
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);
        this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x7f); // div_s
        this.localSet(ctx, s2);
        return;
      }
      case '%': {
        this.localGet(ctx, s1); this.pushI64(ctx, 0n); b.push(0x51);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4004', span);
        b.push(0x0b);
        this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x81); // rem_s
        this.localSet(ctx, s2);
        return;
      }
      case '<<': case '>>': {
        this.localGet(ctx, s1); this.pushI64(ctx, 0n); b.push(0x53);
        this.localGet(ctx, s1); this.pushI64(ctx, 64n); b.push(0x56);
        b.push(0x72);                    // i32.or
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);
        this.localGet(ctx, s0); this.localGet(ctx, s1);
        b.push(op === '<<' ? 0x86 : 0x87);
        this.localSet(ctx, s2);
        return;
      }
      case '&': { this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x83); this.localSet(ctx, s2); return; }
      case '|': { this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x84); this.localSet(ctx, s2); return; }
      case '^': { this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x85); this.localSet(ctx, s2); return; }
      default:
        throw new Unsupported('运算 ' + op);
    }
  }

  slotOf(ctx, name) {
    for (let i = ctx.scopes.length - 1; i >= 0; i--) {
      if (ctx.scopes[i].has(name)) return ctx.scopes[i].get(name);
    }
    return null;
  }

  declareLocal(ctx, name) {
    const slot = ctx.slots++;
    ctx.scopes[ctx.scopes.length - 1].set(name, slot);
    return slot;
  }

  // v0.32 修复:三个"被调用但从未定义"的方法——自 v0.23 起任何走到它们的 eligible 函数
  // 都让整模块 emit 抛错 → tryWasm 静默回落,wasm 层从未真正实例化。
  pushScope(ctx) { ctx.scopes.push(new Map()); }
  popScope(ctx) { ctx.scopes.pop(); }
  emitStore(ctx, op, align, off) { ctx.bytes.push(op); sleb(ctx.bytes, align); sleb(ctx.bytes, off); }

  // ---------- 语句 ----------

  compileBlockW(block, ctx, wantTy, noTailFallback = false) {
    ctx.scopes.push(new Map());
    for (const s of block.stmts) this.compileStmtW(s, ctx);
    if (block.tail) this.compileNum(block.tail, ctx, wantTy ?? this.inferNumType(block.tail, ctx) ?? 'i64');
    else if (wantTy && !noTailFallback) this.compileZero(ctx, wantTy);
    ctx.scopes.pop();
  }

  compileZero(ctx, ty) {
    if (ty === 'f64') { ctx.bytes.push(0x44); const buf = Buffer.alloc(8); buf.writeDoubleLE(0); for (const x of buf) ctx.bytes.push(x); }
    else this.pushI64(ctx, 0n);
  }

  compileStmtW(s, ctx) {
    switch (s.nt) {
      case 'Let': {
        if (!s.init || s.pat.nt !== 'PIdent') throw new Unsupported('let 形式');
        let ty = this.inferNumType(s.init, ctx) ?? (s.type ? this.typeToNumTy(s.type) : null) ?? 'i64';
        if (s.type) {
          const want = this.typeToNumTy(s.type);
          if (want) {
            if (want === 'u64' && ty === 'i64') ty = 'u64'; // 字面量按标注解释
            if (ty !== want) throw new Unsupported('let 标注与推导不符');
          }
        }
        this.compileNum(s.init, ctx, ty);
        const slot = this.declareLocal(ctx, s.pat.name);
        ctx.slotTypes[slot] = ty;
        this.localSet(ctx, slot);
        return;
      }
      case 'Assign': {
        // mut ptr 参数的 v[i] = x(下标 store)
        if (s.target.nt === 'Index' && s.op === '=' && s.target.base.nt === 'Ident') {
          const bt2 = this.inferNumType(s.target.base, ctx);
          if (bt2 === 'vi64ptrm' || bt2 === 'vf64ptrm') {
            const elemTy = bt2 === 'vf64ptrm' ? 'f64' : 'i64';
            const b = ctx.bytes;
            this.compileNum(s.target.base, ctx, bt2);
            this.localSet(ctx, ctx.iscratch);
            this.compileNum(s.target.index, ctx, 'i64');
            this.localSet(ctx, ctx.scratch1);
            this.compileNum(s.value, ctx, elemTy);
            this.localSet(ctx, ctx.scratch2); // value(i64 位型/f64)
            // len → fscratch1;越界检查 idx>=len → M4003
            this.localGet(ctx, ctx.iscratch);
            b.push(0x29); sleb(b, 3); sleb(b, 0);
            this.localSet(ctx, ctx.fscratch1);
            this.localGet(ctx, ctx.scratch1);
            this.localGet(ctx, ctx.fscratch1);
            b.push(0x59); // idx >= len
            b.push(0x04); b.push(0x40);
            this.emitPanic(ctx, 'M4003', s.span);
            b.push(0x0b);
            // store
            this.localGet(ctx, ctx.iscratch);
            b.push(0x41); sleb(b, 16);
            this.localGet(ctx, ctx.scratch1);
            b.push(0xa7);
            b.push(0x41); sleb(b, 8);
            b.push(0x6c);
            b.push(0x6a);
            if (elemTy === 'i64') { this.localGet(ctx, ctx.scratch2); b.push(0x37); sleb(b, 0); sleb(b, 0); }
            else { this.localGet(ctx, ctx.scratch2); b.push(0x39); sleb(b, 3); sleb(b, 0); }
            return;
          }
        }
        if (s.target.nt !== 'Ident') throw new Unsupported('赋值目标');
        const dst = this.slotOf(ctx, s.target.name);
        if (dst === null) throw new Unsupported('赋值目标非局部');
        const dstTy = ctx.slotTypes[dst] ?? 'i64';
        if (s.op === '=') { this.compileNum(s.value, ctx, dstTy); this.localSet(ctx, dst); return; }
        if (dstTy !== 'i64') throw new Unsupported('f64 复合赋值');
        if (s.op === '+=' || s.op === '-=' || s.op === '*=' || s.op === '/=' || s.op === '%=' || s.op === '<<=' || s.op === '>>=') {
          // b 先求值存 scratch1(表达式可能含调用,只求值一次);a=旧 dst 存 scratch0
          this.compileI64(s.value, ctx);
          this.localSet(ctx, ctx.scratch1);
          this.localGet(ctx, dst);
          this.localSet(ctx, ctx.scratch0);
          // 检查型运算(a=s0, b=s1 → 结果写 s2)
          this.emitCheckedOp(ctx, s.op[0], s.span);
          this.localGet(ctx, ctx.scratch2);
          this.localSet(ctx, dst);
          return;
        }
        throw new Unsupported('复合 ' + s.op);
      }
      case 'Return': {
        if (ctx.isVoid) {
          if (s.value) throw new Unsupported('void 返回值');
        } else {
          if (!s.value) throw new Unsupported('缺返回值');
          this.compileNum(s.value, ctx, ctx.retTy ?? 'i64'); // retTy 含 v*/m* 时 compileNum 分派
        }
        ctx.bytes.push(0x0f);
        return;
      }
      case 'ExprStmt': {
        const e = s.expr;
        if (e.nt === 'Call') { this.compileCallNum(e, ctx, this.inferNumType(e, ctx) ?? 'i64'); ctx.bytes.push(0x1a); return; } // 丢弃值
        if (e.nt === 'If' || e.nt === 'Loop') { this.compileStmtW(e, ctx); return; }
        if (e.nt === 'Return') { this.compileStmtW(e, ctx); return; }
        throw new Unsupported('表达式语句 ' + e.nt);
      }
      case 'If': {
        // 语句形式(分支为 unit)
        this.compileCond(s.cond, ctx);
        ctx.bytes.push(0x04); ctx.bytes.push(0x40);
        this.compileBlockW(s.then, ctx, false);
        if (s.els) {
          ctx.bytes.push(0x05);
          if (s.els.nt === 'If') this.compileStmtW(s.els, ctx);
          else this.compileBlockW(s.els, ctx, false);
        }
        ctx.bytes.push(0x0b);
        return;
      }
      case 'While': {
        ctx.bytes.push(0x02, 0x40);          // block
        ctx.bytes.push(0x03, 0x40);          // loop
        ctx.loopStack.push({ brk: 1, cont: 0 });
        this.callImport(ctx, 0, []);          // tick
        this.compileCond(s.cond, ctx);
        ctx.bytes.push(0x45);                // i32.eqz
        ctx.bytes.push(0x0d); uleb(ctx.bytes, 1); // br_if 1 → 退出
        this.compileBlockW(s.body, ctx, false);
        ctx.bytes.push(0x0c); uleb(ctx.bytes, 0); // br 0 → 回 loop
        ctx.bytes.push(0x0b);                // end loop
        ctx.bytes.push(0x0b);                // end block
        ctx.loopStack.pop();
        return;
      }
      case 'Loop': {
        ctx.bytes.push(0x02, 0x40);
        ctx.bytes.push(0x03, 0x40);
        ctx.loopStack.push({ brk: 1, cont: 0 });
        this.callImport(ctx, 0, []);          // tick
        this.compileBlockW(s.body, ctx, false);
        ctx.bytes.push(0x0c); uleb(ctx.bytes, 0);
        ctx.bytes.push(0x0b);
        ctx.bytes.push(0x0b);
        ctx.loopStack.pop();
        return;
      }
      case 'Break': {
        const t = ctx.loopStack[ctx.loopStack.length - 1];
        if (!t) throw new Unsupported('break');
        ctx.bytes.push(0x0c); uleb(ctx.bytes, t.brk);
        return;
      }
      case 'For': {
        // 容器迭代降级(v0.20 vec / v0.22 map):len + 下标/键 循环,零拷贝直访
        if (s.iter.nt !== 'Ident') throw new Unsupported('for 迭代目标非局部');
        const hSlot = this.slotOf(ctx, s.iter.name);
        if (hSlot === null) throw new Unsupported('for 迭代目标非局部');
        const hTy = ctx.slotTypes[hSlot] ?? '';
        const isVecPtr = hTy === 'vi64ptr' || hTy === 'vi64ptrm' || hTy === 'vf64ptr' || hTy === 'vf64ptrm';
        const isMapTy = hTy === 'mi64' || hTy === 'mf64' || hTy === 'mstr';
        if (!isVecPtr && !isMapTy) throw new Unsupported('for 容器 ' + hTy);
        const elem = isVecPtr ? hTy.slice(1).replace('ptr', '') : hTy.slice(1);
        // (v0.33 根因实验进行中:摘除 v0.32 的整体回落,变体矩阵定位后按结论固化)
        const b = ctx.bytes;
        this.pushScope(ctx);
        const iSlot = this.declareLocal(ctx, '__i');
        const lenSlot = this.declareLocal(ctx, '__len');
        // __i = 0;__len = len(h)
        this.pushI64(ctx, 0n);
        this.localSet(ctx, iSlot);
        this.localGet(ctx, hSlot);
        if (isMapTy) { b.push(0x10); uleb(b, this.extraImportIdx('map_len')); }
        else { b.push(0x29); sleb(b, 3); sleb(b, 0); }
        this.localSet(ctx, lenSlot);
        // 循环头:__i >= __len → break
        ctx.loopStack.push({ brk: 1, cont: 0 });
        b.push(0x02); b.push(0x40);      // block
        b.push(0x03); b.push(0x40);      // loop
        this.localGet(ctx, iSlot);
        this.localGet(ctx, lenSlot);
        b.push(0x59);                    // i >= len(i64 ge_s;len 非负等价无符号)
        b.push(0x0d); uleb(b, 1);        // br_if 1 → 退出 block
        // 元素/键值绑定
        this.localGet(ctx, hSlot);
        if (isVecPtr) {
          // x = load(ptr + 16 + 8*i)——地址 = ptr + 16 + 8i(v0.32 修复:此前多压一个 i 且少一次
          // 加法,load 地址变成绝对 16+8i 且操作数栈失衡,元素值全错)
          this.localGet(ctx, iSlot);
          b.push(0xa7);                    // i32.wrap_i64
          b.push(0x41); sleb(b, 8);
          b.push(0x6c);                    // i32.mul(×8)
          b.push(0x41); sleb(b, 16);
          b.push(0x6a);                    // 16 + 8i
          b.push(0x6a);                    // ptr + (16 + 8i)
          const xSlot = this.declareLocal(ctx, s.pat.nt === 'PIdent' ? s.pat.name : '__x');
          if (elem === 'i64') { b.push(0x29); sleb(b, 0); sleb(b, 0); }
          else { b.push(0x2b); sleb(b, 3); sleb(b, 0); }
          this.localSet(ctx, xSlot);
        } else {
          // (k, v):__kh = map_key_at(h, i);k = __kh(str);v = map_get(h, __kh)
          this.localGet(ctx, iSlot);       // map_key_at(h, i) 的第二参
          b.push(0x10); uleb(b, this.extraImportIdx('map_key_at'));
          const khSlot = this.declareLocal(ctx, '__kh');
          this.localSet(ctx, khSlot);
          if (s.pat.nt !== 'PTuple' || s.pat.pats.length !== 2) throw new Unsupported('map 迭代模式');
          const kSlot = this.declareLocal(ctx, s.pat.pats[0].nt === 'PIdent' ? s.pat.pats[0].name : '__k');
          this.localGet(ctx, khSlot);
          this.localSet(ctx, kSlot);
          const vSlot = this.declareLocal(ctx, s.pat.pats[1].nt === 'PIdent' ? s.pat.pats[1].name : '__v');
          this.localGet(ctx, hSlot);
          this.localGet(ctx, khSlot);
          b.push(0x10); uleb(b, this.extraImportIdx('map_get_' + elem));
          this.localSet(ctx, vSlot);
        }
        this.compileBlockW(s.body, ctx, false);
        // __i += 1
        this.localGet(ctx, iSlot);
        this.pushI64(ctx, 1n);
        b.push(0x7c);
        this.localSet(ctx, iSlot);
        b.push(0x0c); uleb(b, 0);        // br 0 → loop
        b.push(0x0b);                    // end loop
        b.push(0x0b);                    // end block
        ctx.loopStack.pop();
        this.popScope(ctx);
        return;
      }
      case 'SyncScopeBlock': throw new Unsupported('sync scope(wasm;sync 函数不 eligible,防御)');
      case 'Continue': {
        const t = ctx.loopStack[ctx.loopStack.length - 1];
        if (!t) throw new Unsupported('continue');
        ctx.bytes.push(0x0c); uleb(ctx.bytes, t.cont);
        return;
      }
      default:
        throw new Unsupported('语句 ' + s.nt);
    }
  }

  // ---------- i64 表达式 ----------

  // 双类型表达式编译:ty = 'i64' | 'f64'(类型由调用方推导;不匹配即回落)
  compileNum(e, ctx, ty) {
    const b = ctx.bytes;
    switch (e.nt) {
      case 'IntLit': {
        if (ty !== 'i64' && ty !== 'u64') throw new Unsupported('类型不符 int 字面量');
        if (e.bits !== 64) throw new Unsupported('非 64 位字面量');
        if (ty === 'u64' && (e.signed === true ? e.v < 0n : false)) throw new Unsupported('u64 负字面量');
        this.pushI64(ctx, e.v);
        return;
      }
      case 'StrLit': {
        if (ty !== 'str') throw new Unsupported('类型不符 str 字面量');
        if (e.parts.length === 1 && 'lit' in e.parts[0]) {
          const off = this.strConstOffset(e.parts[0].lit);
          this.pushI32(ctx, off);
          ctx.bytes.push(0x10); uleb(ctx.bytes, this.strImportIdx('const'));
          return;
        }
        // 插值:每段 → str 句柄,str_cat 链式拼接(v0.21)
        const b = ctx.bytes;
        let first = true;
        for (const part of e.parts) {
          // 段 → str 句柄压栈
          if ('lit' in part) {
            const off = this.strConstOffset(part.lit);
            this.pushI32(ctx, off);
            b.push(0x10); uleb(b, this.strImportIdx('const'));
          } else {
            const segTy = this.inferNumType(part.expr, ctx);
            if (segTy === 'str') {
              this.compileNum(part.expr, ctx, 'str');
            } else if (segTy === 'i64' || segTy === 'u64') {
              this.compileNum(part.expr, ctx, 'i64');
              b.push(0x10); uleb(b, this.strFromIdx('i64'));
            } else if (segTy === 'f64') {
              this.compileNum(part.expr, ctx, 'f64');
              b.push(0x10); uleb(b, this.strFromIdx('f64'));
            } else if (segTy === 'bool') {
              this.compileCond(part.expr, ctx);
              b.push(0x10); uleb(b, this.strFromIdx('bool'));
            } else {
              throw new Unsupported('插值段类型 ' + segTy);
            }
          }
          if (first) { first = false; continue; }
          // acc = str_cat(acc, seg):acc 在栈底,seg 在栈顶——str_cat(a, b) 顺序正确
          b.push(0x10); uleb(b, this.strImportIdx('cat'));
        }
        return;
      }
      case 'VecLit': {
        if (!ty || !ty.startsWith('v')) throw new Unsupported('VecLit 类型 ' + ty);
        const elemTy = ty.slice(1); // 'i64' | 'f64' | 'str'
        if (elemTy === 'str') {
          // str 元素:句柄路径(v0.18)
          this.callImport(ctx, this.extraImportIdx('vec_new'), []);
          this.localSet(ctx, ctx.iscratch);
          for (const el of e.elems) {
            this.localGet(ctx, ctx.iscratch);
            this.compileNum(el, ctx, 'str');
            ctx.bytes.push(0x10); uleb(ctx.bytes, this.extraImportIdx('vec_push_str'));
          }
          this.localGet(ctx, ctx.iscratch);
          return;
        }
        // 数值元素:线性内存构造(v0.23)——alloc(16+8n) + [len][cap][elems]
        const n = e.elems.length;
        this.pushI32(ctx, 16 + 8 * n);
        ctx.bytes.push(0x10); uleb(ctx.bytes, this.allocImportIdx());
        this.localSet(ctx, ctx.iscratch);
        // len @0、cap @8
        this.localGet(ctx, ctx.iscratch);
        this.pushI64(ctx, BigInt(n));
        this.emitStore(ctx, 0x37, 0, 0);
        this.localGet(ctx, ctx.iscratch);
        this.pushI64(ctx, BigInt(n));
        this.emitStore(ctx, 0x37, 0, 8);
        e.elems.forEach((el, i) => {
          this.localGet(ctx, ctx.iscratch);
          this.compileNum(el, ctx, elemTy);
          this.emitStore(ctx, elemTy === 'f64' ? 0x39 : 0x37, elemTy === 'f64' ? 3 : 0, 16 + 8 * i);
        });
        this.localGet(ctx, ctx.iscratch);
        return;
      }
      case 'MapLit': {
        if (!ty || !ty.startsWith('m')) throw new Unsupported('MapLit 类型 ' + ty);
        const valTy = ty.slice(1); // 'i64' | 'f64' | 'str'
        this.callImport(ctx, this.extraImportIdx('map_new'), []);
        this.localSet(ctx, ctx.iscratch);
        for (const en of e.entries) {
          this.localGet(ctx, ctx.iscratch);
          this.compileNum(en.k, ctx, 'str');
          this.compileNum(en.v, ctx, valTy);
          ctx.bytes.push(0x10); uleb(ctx.bytes, this.extraImportIdx('map_set_' + valTy));
        }
        this.localGet(ctx, ctx.iscratch);
        return;
      }
      case 'FloatLit': {
        if (ty !== 'f64' || e.bits !== 64) throw new Unsupported('类型不符 float 字面量');
        b.push(0x44);
        const buf = Buffer.alloc(8);
        buf.writeDoubleLE(e.v);
        for (const x of buf) b.push(x);
        return;
      }
      case 'Ident': {
        const slot = this.slotOf(ctx, e.name);
        if (slot !== null) {
          const st = ctx.slotTypes[slot] ?? 'i64';
          if (st !== ty) throw new Unsupported('局部类型不符 ' + e.name);
          this.localGet(ctx, slot);
          return;
        }
        const mod = this.modulesByFile.get(ctx.modFile);
        const entry = mod?.items.get(e.name);
        if (entry?.kind === 'const') {
          const cval = this.compiled.constEntryVals?.get(entry);
          if (cval?.t === 'int' && ty === 'i64' && cval.bits === 64 && cval.signed) { this.pushI64(ctx, cval.v); return; }
          if (cval?.t === 'float' && ty === 'f64') { b.push(0x44); const buf = Buffer.alloc(8); buf.writeDoubleLE(cval.v); for (const x of buf) b.push(x); return; }
        }
        throw new Unsupported('标识符 ' + e.name);
      }
      case 'Unary': {
        if (e.op !== '-') throw new Unsupported('一元 ' + e.op);
        if (ty === 'f64') {
          this.compileNum(e.expr, ctx, 'f64');
          b.push(0x9a); // f64.neg(IEEE,无溢出概念)
          return;
        }
        if (ty === 'u64') {
          // 无符号取负:0 - x 位型,无溢出概念
          this.compileNum(e.expr, ctx, 'u64');
          this.pushI64(ctx, 0n);
          b.push(0x7d);
          return;
        }
        this.compileNum(e.expr, ctx, 'i64');
        this.localSet(ctx, ctx.scratch0);
        this.localGet(ctx, ctx.scratch0);
        this.pushI64(ctx, I64_MIN);
        b.push(0x51);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', e.span);
        b.push(0x0b);
        this.localGet(ctx, ctx.scratch0);
        this.pushI64(ctx, 0n);
        b.push(0x7d);
        return;
      }
      case 'Binary': return this.compileBinNum(e, ctx, ty);
      case 'Call': return this.compileCallNum(e, ctx, ty);
      case 'If': {
        this.compileCond(e.cond, ctx);
        b.push(0x04); sleb(b, ty === 'f64' ? F64 : I64);
        this.compileBlockW(e.then, ctx, ty);
        b.push(0x05);
        if (!e.els) throw new Unsupported('if 无 else');
        if (e.els.nt === 'If') this.compileNum(e.els, ctx, ty);
        else this.compileBlockW(e.els, ctx, ty);
        b.push(0x0b);
        return;
      }
      case 'Index': {
        const bt = this.inferNumType(e.base, ctx);
        if (!bt || !(bt.startsWith('v') || bt.startsWith('m'))) throw new Unsupported('下标目标 ' + bt);
        const isMap = bt.startsWith('m');
        const elemTy = bt.slice(1);
        const b = ctx.bytes;
        // ptr 型(vi64ptr/vf64ptr):len = load(ptr);元素 = load(ptr + 8 + 8*idx);越界检查同语义
        if (bt === 'vi64ptr' || bt === 'vf64ptr') {
          const b = ctx.bytes;
          this.compileNum(e.base, ctx, bt);      // [ptr]
          this.localSet(ctx, ctx.iscratch);
          this.compileNum(e.index, ctx, 'i64');  // [idx]
          this.localSet(ctx, ctx.scratch1);      // idx → scratch1
          // len = i64.load(ptr)
          this.localGet(ctx, ctx.iscratch);
          b.push(0x29); sleb(b, 3); sleb(b, 0);
          this.localSet(ctx, ctx.scratch2);
          // idx < 0 || idx >= len → M4003
          this.localGet(ctx, ctx.scratch1);
          this.pushI64(ctx, 0n);
          b.push(0x53);
          this.localGet(ctx, ctx.scratch1);
          this.localGet(ctx, ctx.scratch2);
          b.push(0x59);
          b.push(0x72);
          b.push(0x04); b.push(0x40);
          this.emitPanic(ctx, 'M4003', e.span);
          b.push(0x0b);
          // addr = ptr + 8 + idx*8(i32 运算)
          this.localGet(ctx, ctx.iscratch);
          b.push(0x41); sleb(b, 8);
          this.localGet(ctx, ctx.scratch1);
          b.push(0xa7);              // i32.wrap_i64
          b.push(0x41); sleb(b, 8);
          b.push(0x6c);              // i32.shl
          b.push(0x6a);              // i32.add
          // load:vi64ptr → i64.load;vf64ptr → f64.load(结果压栈)
          if (bt === 'vi64ptr') { b.push(0x29); sleb(b, 0); sleb(b, 0); }
          else { b.push(0x2b); sleb(b, 3); sleb(b, 0); }
          return;
        }
        // base → iscratch;下标/键 → scratch1(数值)或直接 str 句柄压栈
        this.compileNum(e.base, ctx, bt);
        this.localSet(ctx, ctx.iscratch);
        if (isMap) {
          // map[key]:缺键由 JS 导入 panic(M4007),与树引擎语义一致
          this.compileNum(e.index, ctx, 'str');
          this.localGet(ctx, ctx.iscratch);
          b.push(0x10); uleb(b, this.extraImportIdx('map_get_' + elemTy));
          return;
        }
        // vec[i]:i<0 || i>=len → M4003(与树引擎 panic 语义一致)
        this.compileNum(e.index, ctx, 'i64');
        this.localSet(ctx, ctx.scratch1);
        this.localGet(ctx, ctx.iscratch);
        b.push(0x10); uleb(b, this.extraImportIdx('vec_len'));
        this.localSet(ctx, ctx.scratch2);
        this.localGet(ctx, ctx.scratch1);
        this.pushI64(ctx, 0n);
        b.push(0x53);                     // idx < 0
        this.localGet(ctx, ctx.scratch1);
        this.localGet(ctx, ctx.scratch2);
        b.push(0x59);                     // idx >= len(ge_s)
        b.push(0x72);                     // or
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4003', e.span);
        b.push(0x0b);
        this.localGet(ctx, ctx.iscratch);
        this.localGet(ctx, ctx.scratch1);
        b.push(0x10); uleb(b, this.extraImportIdx('vec_get_' + elemTy));
        return;
      }
      default:
        throw new Unsupported('表达式 ' + e.nt);
    }
  }

  compileI64(e, ctx) { return this.compileNum(e, ctx, 'i64'); }

  // 表达式类型推导(i64 | f64 | null)
  inferNumType(e, ctx) {
    switch (e.nt) {
      case 'IntLit': {
        if (e.bits !== 64) return null;
        if (e.suffix === 'u64') return 'u64';
        return e.signed ? 'i64' : 'u64'; // 无符号后缀或显式 u64 字面量
      }
      case 'FloatLit': return e.bits === 64 ? 'f64' : null;
      case 'Ident': {
        const slot = this.slotOf(ctx, e.name);
        if (slot !== null) return ctx.slotTypes[slot] ?? null; // 含 vi64ptr/vf64ptr
        const mod = this.modulesByFile.get(ctx.modFile);
        const entry = mod?.items.get(e.name);
        if (entry?.kind === 'const') {
          const cval = this.compiled.constEntryVals?.get(entry);
          if (cval?.t === 'int') return 'i64';
          if (cval?.t === 'float') return 'f64';
        }
        return null;
      }
      case 'Unary': return e.op === '-' ? this.inferNumType(e.expr, ctx) : null;
      case 'StrLit': return 'str';
      case 'VecLit': {
        if (e.elems.length === 0) return null;
        const first = this.inferNumType(e.elems[0], ctx);
        if (!first || first === 'u64') return null;
        return 'v' + first;
      }
      case 'MapLit': {
        if (e.entries.length === 0) return null;
        const k = this.inferNumType(e.entries[0].k, ctx);
        const v = this.inferNumType(e.entries[0].v, ctx);
        if (k !== 'str' || !v || v === 'u64') return null;
        return 'm' + v;
      }
      case 'Binary': {
        if (e.op === '+' ) { // str 拼接或数值
          const l = this.inferNumType(e.l, ctx);
          if (l === 'str') return 'str';
        }
        break;
      }
      case 'Binary': return ['&&', '||', '==', '!=', '<', '<=', '>', '>='].includes(e.op) ? null : this.inferNumType(e.l, ctx);
      case 'Call': {
        const mn1 = this.mathNameOf(e.callee, ctx);
        if (mn1) return MATH_IDX.has(mn1) ? 'f64' : null;
        if (e.callee.nt !== 'Ident') return null;
        const mod = this.modulesByFile.get(ctx.modFile);
        const entry = mod?.items.get(e.callee.name);
        if (entry?.kind !== 'fn') return null;
        const ret = entry.sig?.ret;
        if (ret?.k === 'int' && ret.bits === 64 && ret.signed) return 'i64';
        if (ret?.k === 'float' && ret.bits === 64) return 'f64';
        return null;
      }
      case 'If': return e.els ? (this.inferNumType(e.then?.tail ?? e.then, ctx) ?? this.inferNumType(e.els, ctx)) : null;
      case 'Index': {
        const bt = this.inferNumType(e.base, ctx);
        if (bt === 'vi64') return 'i64';
        if (bt === 'vf64') return 'f64';
        if (bt === 'vstr') return 'str';
        if (bt === 'mi64') return 'i64';
        if (bt === 'mf64') return 'f64';
        if (bt === 'mstr') return 'str';
        return null;
      }
      case 'BlockExpr': return e.block.tail ? this.inferNumType(e.block.tail, ctx) : null;
      default: return null;
    }
  }

  compileBinNum(e, ctx, ty) {
    const op = e.op;
    if (op === '&&' || op === '||') throw new Unsupported('逻辑作为值');
    if (ty === 'str') {
      if (op === '+') {
        this.compileNum(e.l, ctx, 'str');
        this.compileNum(e.r, ctx, 'str');
        ctx.bytes.push(0x10); uleb(ctx.bytes, this.strImportIdx('cat'));
        return;
      }
      if (op === '==' || op === '!=') {
        this.compileNum(e.l, ctx, 'str');
        this.compileNum(e.r, ctx, 'str');
        ctx.bytes.push(0x10); uleb(ctx.bytes, this.strImportIdx('eq'));
        if (op === '!=') ctx.bytes.push(0x45); // i32.eqz
        return;
      }
      throw new Unsupported('str 运算 ' + op);
    }
    if (ty === 'f64') {
      const ops = { '+': 0xa0, '-': 0xa1, '*': 0xa2, '/': 0xa3 };
      const cmps = { '==': 0x61, '!=': 0x62, '<': 0x63, '>': 0x64, '<=': 0x65, '>=': 0x66 };
      if (cmps[op]) {
        this.compileNum(e.l, ctx, 'f64');
        this.compileNum(e.r, ctx, 'f64');
        ctx.bytes.push(cmps[op]);
        return;
      }
      if (!ops[op]) throw new Unsupported('f64 运算 ' + op);
      this.compileNum(e.l, ctx, 'f64');
      this.compileNum(e.r, ctx, 'f64');
      ctx.bytes.push(ops[op]);
      return;
    }
    if (['==', '!=', '<', '<=', '>', '>='].includes(op)) throw new Unsupported('i64 比较作为值');
    const signedOps = ty === 'u64' ? false : true;
    // v0.32 修复:lhs 结果保留在 wasm 值栈上横跨 RHS 求值——此前 lhs 先入 scratch0,
    // RHS 子表达式复用 scratch0/1/2 会把它冲掉(fib(n)=n+fib(n-2) 一类静默错值)。
    this.compileNum(e.l, ctx, ty);
    this.compileNum(e.r, ctx, ty);
    this.localSet(ctx, ctx.scratch1);
    this.localSet(ctx, ctx.scratch0);
    if (signedOps) this.emitCheckedOp(ctx, op, e.span);
    else this.emitCheckedOpU(ctx, op, e.span);
    this.localGet(ctx, ctx.scratch2);
    return;
  }

  // 无符号检查型运算:a = scratch0, b = scratch1 → 结果写 scratch2(u64 位型 = i64)
  emitCheckedOpU(ctx, op, span) {
    const b = ctx.bytes;
    const s0 = ctx.scratch0, s1 = ctx.scratch1, s2 = ctx.scratch2;
    switch (op) {
      case '+': {
        this.localGet(ctx, s0); this.localGet(ctx, s1);
        b.push(0x7c);
        this.localSet(ctx, s2);
        // u64 add 溢出 iff r < a(无符号)
        this.localGet(ctx, s2); this.localGet(ctx, s0); b.push(0x54); // lt_u
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);
        return;
      }
      case '-': {
        this.localGet(ctx, s0); this.localGet(ctx, s1);
        b.push(0x7d);
        this.localSet(ctx, s2);
        // u64 sub 溢出 iff r > a(无符号)
        this.localGet(ctx, s2); this.localGet(ctx, s0); b.push(0x56); // gt_u
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);
        return;
      }
      case '*': {
        this.localGet(ctx, s0); this.localGet(ctx, s1);
        b.push(0x7e);
        this.localSet(ctx, s2);
        // u64 mul 溢出:b != 0 && r / b != a(div_u 无 trap)
        b.push(0x02); b.push(0x40);
        this.localGet(ctx, s1); this.pushI64(ctx, 0n); b.push(0x51); b.push(0x0d); uleb(b, 0);
        this.localGet(ctx, s2); this.localGet(ctx, s1); b.push(0x80); // div_u
        this.localGet(ctx, s0); b.push(0x52); // ne
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);                    // end if
        b.push(0x0b);                    // end block
        return;
      }
      case '/': {
        // u64 除法:仅除零(div_u 无溢出 trap)
        this.localGet(ctx, s1); this.pushI64(ctx, 0n); b.push(0x51);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4004', span);
        b.push(0x0b);
        this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x80); // div_u
        this.localSet(ctx, s2);
        return;
      }
      case '%': {
        this.localGet(ctx, s1); this.pushI64(ctx, 0n); b.push(0x51);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4004', span);
        b.push(0x0b);
        this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x82); // rem_u
        this.localSet(ctx, s2);
        return;
      }
      case '<<': case '>>': {
        // 位数检查同(0..63);>> 对 u64 是 shr_u(0x88)
        this.localGet(ctx, s1); this.pushI64(ctx, 0n); b.push(0x53);
        this.localGet(ctx, s1); this.pushI64(ctx, 64n); b.push(0x56);
        b.push(0x72);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);
        this.localGet(ctx, s0); this.localGet(ctx, s1);
        b.push(op === '<<' ? 0x86 : 0x88); // shl / shr_u
        this.localSet(ctx, s2);
        return;
      }
      case '&': { this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x83); this.localSet(ctx, s2); return; }
      case '|': { this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x84); this.localSet(ctx, s2); return; }
      case '^': { this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x85); this.localSet(ctx, s2); return; }
      default:
        throw new Unsupported('u64 运算 ' + op);
    }
  }

  // Option 消费链编译(v0.22):X.get(k).unwrap() / .unwrap_or(d) / .is_some() / .is_none()
  // 语义直译(零 Option 表示):unwrap ≡ 越界/缺键 panic;unwrap_or ≡ 界外取默认;is_some ≡ 界内判定。
  // 裸 Option 值(存储/match 解构/跨任务)不支持 → Unsupported 回落 JS VM(语义不变)。
  tryCompileGetConsumed(e, ctx, ty) {
    if (e.callee.nt !== 'Field') return null;
    const consumer = e.callee.name;
    if (!['unwrap', 'unwrap_or', 'is_some', 'is_none'].includes(consumer)) return null;
    const getCall = e.callee.base;
    if (!getCall || getCall.nt !== 'Call' || getCall.callee.nt !== 'Field' || getCall.callee.name !== 'get') return null;
    if (getCall.callee.base.nt !== 'Ident' && getCall.callee.base.nt !== 'Field') return null;
    const recvTy = this.inferNumType(getCall.callee.base, ctx);
    if (!recvTy || !(recvTy.startsWith('v') || recvTy.startsWith('m'))) return null;
    if (consumer === 'unwrap_or' && e.args.length !== 1) return null;
    if (consumer !== 'unwrap_or' && e.args.length !== 0) return null;
    const isMap = recvTy.startsWith('m');
    const elemTy = recvTy.slice(1);
    const resTy = elemTy === 'u64' ? 'i64' : elemTy;
    const b = ctx.bytes;
    // recv → iscratch;键/下标 → scratch1(数值)或 iscratch2(str 句柄)
    this.compileNum(getCall.callee.base, ctx, recvTy);
    this.localSet(ctx, ctx.iscratch);
    if (isMap) {
      this.compileNum(getCall.args[0], ctx, 'str');
      this.localSet(ctx, ctx.iscratch2);
    } else {
      this.compileNum(getCall.args[0], ctx, 'i64');
      this.localSet(ctx, ctx.scratch1);
    }
    // len(vec) → iscratch3
    if (!isMap) {
      this.localGet(ctx, ctx.iscratch);
      b.push(0x10); uleb(b, this.extraImportIdx('vec_len'));
      this.localSet(ctx, ctx.iscratch3);
    }
    // 界内判定 → 栈(i32)
    if (isMap) {
      this.localGet(ctx, ctx.iscratch);
      this.localGet(ctx, ctx.iscratch2);
      b.push(0x10); uleb(b, this.extraImportIdx('map_has'));
    } else {
      this.localGet(ctx, ctx.scratch1);
      this.pushI64(ctx, 0n);
      b.push(0x53);                       // idx < 0
      this.localGet(ctx, ctx.scratch1);
      this.localGet(ctx, ctx.iscratch3);
      b.push(0xa7);                       // wrap len
      b.push(0x59);                       // idx >= len(无符号比较 i32)
      b.push(0x72);
    }
    const hasOnStack = true;

    if (consumer === 'is_some' || consumer === 'is_none') {
      if (consumer === 'is_none') b.push(0x45);
      return { ty: 'i32' };
    }

    if (consumer === 'unwrap') {
      // 无界 → M4006(与树引擎 unwrap 消息一致)
      b.push(0x04); b.push(0x40);
      this.emitPanic(ctx, 'M4006', e.span);
      b.push(0x0b);
      // 有界 → get
      this.localGet(ctx, ctx.iscratch);
      if (isMap) this.localGet(ctx, ctx.iscratch2);
      else this.localGet(ctx, ctx.scratch1);
      b.push(0x10); uleb(b, this.extraImportIdx((isMap ? 'map' : 'vec') + '_get_' + elemTy));
      return { ty: resTy };
    }

    // unwrap_or(d):d 先求值 → scratch2(i64/f64)或 fscratch0(str 句柄借用 f64?不——str 默认值句柄存 iscratch3)
    if (consumer === 'unwrap_or') {
      if (elemTy === 'str') {
        this.compileNum(e.args[0], ctx, 'str');
        this.localSet(ctx, ctx.iscratch3);
        b.push(0x04); sleb(b, I32);
        this.localGet(ctx, ctx.iscratch);
        this.localGet(ctx, ctx.iscratch2);
        b.push(0x10); uleb(b, this.extraImportIdx('map_get_str'));
        if (!isMap) throw new Unsupported('vec str unwrap_or');
        b.push(0x05);
        this.localGet(ctx, ctx.iscratch3);
        b.push(0x0b);
        return { ty: 'str' };
      }
      this.compileNum(e.args[0], ctx, elemTy);
      this.localSet(ctx, ctx.scratch2);
      b.push(0x04); sleb(b, elemTy === 'f64' ? F64 : I64);
      this.localGet(ctx, ctx.iscratch);
      if (isMap) this.localGet(ctx, ctx.iscratch2);
      else this.localGet(ctx, ctx.scratch1);
      b.push(0x10); uleb(b, this.extraImportIdx((isMap ? 'map' : 'vec') + '_get_' + elemTy));
      b.push(0x05);
      this.localGet(ctx, ctx.scratch2);
      b.push(0x0b);
      return { ty: resTy };
    }

    throw new Unsupported('consumer ' + consumer);
  }

    compileCallNum(e, ctx, ty) {
    // Option 消费链优先
    const consumed = this.tryCompileGetConsumed(e, ctx, ty);
    if (consumed) return;
    const callee = e.callee;
    const mn = this.mathNameOf(callee, ctx);
    if (mn) {
      const widx = MATH_IDX.get(mn);
      if (widx === undefined) throw new Unsupported('math.' + mn);
      for (const a of e.args) this.compileNum(a, ctx, 'f64');
      ctx.bytes.push(0x10);
      uleb(ctx.bytes, widx);
      return;
    }
    if (callee.nt !== 'Ident') throw new Unsupported('非直接调用');
    const widx = this.resolveWasmCallIdx(ctx, callee.name);
    if (widx === null) throw new Unsupported('调用 ' + callee.name);
    const mod = this.modulesByFile.get(ctx.modFile);
    const entry = mod?.items.get(callee.name);
    const calleeSig = entry?.sig;
    e.args.forEach((a, i) => {
      const pt = calleeSig?.params[i]?.type;
      const argTy = pt?.k === 'float' ? 'f64' : (pt?.k === 'str' ? 'str' : 'i64');
      // mut Vec 实参:值语义拷贝(被调 push/set 不影响调用方)
      if (pt?.k === 'vec' && pt.el?.k !== 'str' && a.nt === 'Ident') {
        const srcSlot = this.slotOf(ctx, a.name);
        if (srcSlot !== null && (ctx.slotTypes[srcSlot] === 'vi64' || ctx.slotTypes[srcSlot] === 'vf64')) {
          this.localGet(ctx, srcSlot);
          ctx.bytes.push(0x10); uleb(ctx.bytes, this.copyVecImportIdx());
          return;
        }
      }
      this.compileNum(a, ctx, argTy);
    });
    ctx.bytes.push(0x10);
    uleb(ctx.bytes, widx);
    void ty;
  }

  allocImportIdx() {
    return 3 + MATH_IMPORTS.length + STR_IMPORTS.length + VECMAP_IMPORTS.length + 1; // ming_alloc(ming_grow 之后)
  }

  copyVecImportIdx() {
    return 3 + MATH_IMPORTS.length + STR_IMPORTS.length + VECMAP_IMPORTS.length + 2; // ming_copy_vec
  }

  // mut ptr push:布局 [len][cap][elems];len>=cap → ming_grow 搬迁并更新 ptr local
  compilePtrPush(callee, ctx, recvTy, valueNode, span) {
    const elemTy = recvTy === 'vf64ptrm' ? 'f64' : 'i64';
    const b = ctx.bytes;
    const slot = this.slotOf(ctx, callee.base.name);
    if (slot === null) throw new Unsupported('push 目标非局部');
    // value → scratch1;ptr → iscratch
    this.compileNum(valueNode, ctx, elemTy);
    this.localSet(ctx, ctx.scratch1);
    this.localGet(ctx, slot);
    this.localSet(ctx, ctx.iscratch);
    // len → scratch2;cap → fscratch1(i64 位型借用)
    this.localGet(ctx, ctx.iscratch);
    b.push(0x29); sleb(b, 3); sleb(b, 0);
    this.localSet(ctx, ctx.scratch2);
    this.localGet(ctx, ctx.iscratch);
    b.push(0x29); sleb(b, 3); sleb(b, 8);
    this.localSet(ctx, ctx.fscratch1);
    // if len >= cap → iscratch = ming_grow(iscratch, 新块字节数 = cap*8+24);cap 重读
    // (v0.32 修复:此前传 cap+16 字节,容量换算成 cap/8+1,反而缩容)
    this.localGet(ctx, ctx.scratch2);
    this.localGet(ctx, ctx.fscratch1);
    b.push(0x60);                            // i64.ge_s
    b.push(0x04); b.push(0x40);
    this.localGet(ctx, ctx.iscratch);
    this.localGet(ctx, ctx.fscratch1);
    b.push(0xa7);                            // i32.wrap_i64
    b.push(0x41); sleb(b, 8);
    b.push(0x6c);                            // i32.mul(×8)
    b.push(0x41); sleb(b, 24);
    b.push(0x6a);                            // i32.add
    b.push(0x10); uleb(b, this.growImportIdx());
    this.localSet(ctx, ctx.iscratch);
    this.localGet(ctx, ctx.iscratch);
    b.push(0x29); sleb(b, 3); sleb(b, 8);    // cap = load(new+8)
    this.localSet(ctx, ctx.fscratch1);
    b.push(0x0b);                            // end if
    // elems[len] = value
    this.localGet(ctx, ctx.iscratch);
    b.push(0x41); sleb(b, 16);
    this.localGet(ctx, ctx.scratch2);
    b.push(0xa7);
    b.push(0x41); sleb(b, 8);
    b.push(0x6c);
    b.push(0x6a);
    if (elemTy === 'i64') {
      this.localGet(ctx, ctx.scratch1);
      b.push(0x37); sleb(b, 0); sleb(b, 0);  // i64.store
    } else {
      this.localGet(ctx, ctx.scratch1);
      b.push(0x39); sleb(b, 3); sleb(b, 0);  // f64.store
    }
    // len += 1
    this.localGet(ctx, ctx.iscratch);
    this.localGet(ctx, ctx.scratch2);
    this.pushI64(ctx, 1n);
    b.push(0x7c);
    b.push(0x37); sleb(b, 0); sleb(b, 0);
    return;
  }

  growImportIdx() {
    // v0.32 修复:此前 -1 指向表尾(str_ends),并非 ming_grow
    return 3 + MATH_IMPORTS.length + STR_IMPORTS.length + EXTRA_IDX.get('ming_grow');
  }

  extraImportIdx(name) {
    return 3 + MATH_IMPORTS.length + STR_IMPORTS.length + EXTRA_IDX.get(name);
  }

  // 容器方法:仅 len(值形式);get/at → 用下标表达式;push/set → void 语句
  compileContainerMethod(callee, ctx, recvTy, name) {
    const isVec = recvTy.startsWith('v');
    if (name === 'len') {
      // ptr 型(vi64ptr/vf64ptr):len = i64.load(ptr+0)
      if (recvTy === 'vi64ptr' || recvTy === 'vf64ptr') {
        const b = ctx.bytes;
        this.compileNum(callee.base, ctx, recvTy);
        b.push(0x29); sleb(b, 3); sleb(b, 0); // i64.load align=8 offset=0
        return;
      }
      this.compileNum(callee.base, ctx, recvTy);
      ctx.bytes.push(0x10); uleb(ctx.bytes, this.extraImportIdx((isVec ? 'vec' : 'map') + '_len'));
      return;
    }
    throw new Unsupported('容器方法 ' + (isVec ? 'Vec.' : 'Map.') + name + '(值形式)');
  }

  // void 容器方法语句:push/set
  compileContainerVoidStmt(callee, ctx, recvTy, name, argNodes, span) {
    const isVec = recvTy.startsWith('v');
    const elemTy = recvTy.slice(1);
    const b = ctx.bytes;
    if (isVec && name === 'push') {
      if (argNodes.length !== 1) throw new Unsupported('push 参数');
      this.compileNum(callee.base, ctx, recvTy);
      this.compileNum(argNodes[0], ctx, elemTy);
      b.push(0x10); uleb(b, this.extraImportIdx('vec_push_' + elemTy));
      return;
    }
    if (!isVec && name === 'set') {
      if (argNodes.length !== 2) throw new Unsupported('set 参数');
      this.compileNum(callee.base, ctx, recvTy);
      this.compileNum(argNodes[0], ctx, 'str');
      this.compileNum(argNodes[1], ctx, elemTy);
      b.push(0x10); uleb(b, this.extraImportIdx('map_set_' + elemTy));
      return;
    }
    throw new Unsupported('void 容器方法 ' + name);
  }

  compileCond(e, ctx) {
    const b = ctx.bytes;
    switch (e.nt) {
      case 'Binary': {
        if (e.op === '&&') {
          this.compileCond(e.l, ctx);
          b.push(0x04); sleb(b, I32);
          this.compileCond(e.r, ctx);
          b.push(0x05); b.push(0x41); sleb(b, 0);
          b.push(0x0b);
          return;
        }
        if (e.op === '||') {
          this.compileCond(e.l, ctx);
          b.push(0x04); sleb(b, I32);
          b.push(0x41); sleb(b, 1);
          b.push(0x05);
          this.compileCond(e.r, ctx);
          b.push(0x0b);
          return;
        }
        const t = this.inferNumType(e.l, ctx);
        if (t === 'f64') {
          const ops = { '==': 0x61, '!=': 0x62, '<': 0x63, '>': 0x64, '<=': 0x65, '>=': 0x66 };
          this.compileNum(e.l, ctx, 'f64');
          this.compileNum(e.r, ctx, 'f64');
          b.push(ops[e.op]);
          return;
        }
        if (t === 'str') {
          const orderOps = { '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
          if (e.op === '==' || e.op === '!=') {
            this.compileNum(e.l, ctx, 'str');
            this.compileNum(e.r, ctx, 'str');
            b.push(0x10); uleb(b, this.strImportIdx('eq'));
            if (e.op === '!=') b.push(0x45);
            return;
          }
          if (orderOps[e.op]) {
            this.compileNum(e.l, ctx, 'str');
            this.compileNum(e.r, ctx, 'str');
            b.push(0x10); uleb(b, this.strImportIdx(orderOps[e.op]));
            return;
          }
          throw new Unsupported('str 条件 ' + e.op);
        }
        if (t === 'i64' || t === 'u64') {
          const ops = t === 'i64'
            ? { '==': 0x51, '!=': 0x52, '<': 0x53, '>': 0x55, '<=': 0x57, '>=': 0x59 }
            : { '==': 0x51, '!=': 0x52, '<': 0x54, '>': 0x56, '<=': 0x58, '>=': 0x5a }; // 无符号
          this.compileNum(e.l, ctx, t);
          this.compileNum(e.r, ctx, t);
          b.push(ops[e.op]);
          return;
        }
        throw new Unsupported('条件操作数 ' + t);
      }
      case 'Unary': {
        if (e.op !== '!') throw new Unsupported('条件一元');
        this.compileCond(e.expr, ctx);
        b.push(0x45);
        return;
      }
      default:
        throw new Unsupported('条件 ' + e.nt);
    }
  }


  resolveWasmCallIdx(ctx, name) {
    const mod = this.modulesByFile.get(ctx.modFile);
    if (!mod) return null;
    const entry = mod.items.get(name);
    if (entry?.kind !== 'fn') return null;
    const mingIdx = this.compiled.entryFnIdx?.get(entry);
    if (mingIdx === undefined || !this.eligible.has(mingIdx)) return null;
    return DEFINED_BASE + (this.wasmOrder ? this.wasmOrder.indexOf(mingIdx) : -1);
  }
}

// wasmOrder 在 emitModule 中构建,resolve 阶段需要 → 存到实例
// (emitModule 在 run 中调用,先于 code 生成)
