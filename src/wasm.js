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
  ['map_get_i64', ['i32', 'i32', 'i32'], 'i64'],
  ['map_get_f64', ['i32', 'i32', 'i32'], 'f64'],
  ['map_get_str', ['i32', 'i32', 'i32'], 'i32'],
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
// v0.32:ming_alloc / ming_copy_vec 声明在 VECMAP 之后(TOTAL_IMPORTS/+1)
// v0.63 §4.4.6b slice 2:panic_m4003(下标读,消息带 Option 提示后缀)/panic_m4003w(元素写,
// 消息不带后缀)/panic_m4006(None unwrap)声明在 ming_copy_vec 之后(TOTAL_IMPORTS+2/+3/+4);
// v0.63 G2:ming_alloc_elem(数值 VecLit:n 元素计费 + 16+8n 字节 bump)声明在 panic 之后
// (TOTAL_IMPORTS+5);导入共 TI+6 个(索引 0..TI+5),函数索引基址随之 +6。
// v0.65 §4.5.2 slice 3(守护具名清单收口):再追加 11 个(TI+6..TI+16),DEFINED_BASE = TI+17:
//   panic_expect(spanIdx,strIdx)                    TI+6  expect(字面量 msg)失败(msg 经 strConsts 表索引)
//   map_has(h,kh)->i32                              TI+7  Map get 消费链缺键判定(map_get 语义拆分:先 has 后 get)
//   vecstr_get(h,i,spanIdx)->i32                    TI+8  Vec[str] 下标读(宿主界检查,读 flavor 消息+span)
//   res_new_i64(isErr,isU64,v)->i32                 TI+9  Ok/Err 构造(数值载荷;isU64 保真 u64 display)
//   res_new_f64(isErr,v)->i32                       TI+10
//   res_new_str(isErr,sh)->i32                      TI+11
//   res_unwrap_i64(h,spanIdx,isExpect)->i64         TI+12 Result unwrap/expect(Err → panic_m4006,消息 interp.js:3258)
//   res_unwrap_f64(同型)->f64                       TI+13
//   res_unwrap_str(同型)->i32                       TI+14
//   frame_push(fnIdx,spanIdx) / frame_pop()         TI+15/16  #59 wasm→wasm 直调调用点帧透传
// 新增导入一律追加在尾部,既有索引不变——v0.59 ming_alloc 错位/v0.63 G1 off-by-one 教训。
const DEFINED_BASE = TOTAL_IMPORTS + 17;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;

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

// v0.53 阶段1(strict wasm):分层三态判定纯函数 —— run/check 的 wasm_status 与 --strict-wasm 共用。
// 三态:none = 零 eligible;ok = eligible>0 且编译出字节 + WebAssembly 校验 + 桩导入实例化成功;
// fallback = eligible>0 但编译回落/校验失败/实例化失败(即旧静默回落的全部形态)。
// 复用既有存活信号而不另起炉灶:资格分析走同一 WasmCompiler.analyze(单一事实来源),
// 逐函数拒绝定位与 MING_WASM_DEBUG 的 emitBody 探测同一路径;实例化桩按模块自报的
// WebAssembly.Module.imports 生成——不复制 vm.js 的导入实现(名字/数量由产物自证,不会漂移)。
// 纯函数:不读环境、不落盘、不改动 check/compiled 的既有语义(compiled.spans 只追加重复项,
// 字节码索引不受影响)。返回 { status, eligible, reason }。
export function wasmLayerStatus(check, compiled) {
  if (!compiled || !Array.isArray(compiled.functions)) {
    return { status: 'fallback', eligible: 0, reason: '无编译产物' };
  }
  const c = new WasmCompiler(check, compiled);
  let order;
  try {
    const eligible = c.analyze(); // wasm 路径:不传扩展旗标(严格,与 tryWasm 一致)
    if (eligible.size === 0) return { status: 'none', eligible: 0, reason: null };
    order = [...eligible.keys()].sort((a, b) => a - b);
  } catch (e) {
    return { status: 'fallback', eligible: 0, reason: 'wasm 资格分析失败:' + (e?.message ?? e) };
  }
  const fns = compiled.functions;
  let bytes = null;
  try {
    const wasmIdxOf = new Map(order.map((fi, ord) => [fi, ord]));
    c.wasmOrder = order; // 与 run() 相同:emitBody 解析 eligible 调用索引依赖它
    bytes = c.emitModule(fns, order, wasmIdxOf);
  } catch (e) {
    const msg = e instanceof Unsupported ? e.message : (e?.message ?? String(e));
    // 逐函数探测定位回落函数(与 MING_WASM_DEBUG 的 '[wasm] fn … REJECT' 探测同一路径)
    let bad = null;
    for (const fi of order) {
      try { c.emitBody(fns[fi], 3); }
      catch (pe) { if (pe instanceof Unsupported) { bad = fns[fi].name ?? ('m' + fi); break; } }
    }
    return { status: 'fallback', eligible: order.length, reason: `wasm 编译回落(${bad ?? '未知函数'}):${msg}` };
  }
  if (typeof WebAssembly === 'undefined') {
    return { status: 'fallback', eligible: order.length, reason: 'wasm 编译成功但宿主无 WebAssembly(实例化回落)' };
  }
  // 审查修复:模块校验/实例化回落此前不点名 Ming 函数(emit 期路径才点名)。V8 的
  // "function #N" 用模块函数索引空间(导入在前,DEFINED_BASE 起是编译产物函数),
  // 借此映射回 order[ord] → compiled.functions 名。校验失败时该索引未必可靠,
  // 因此消息同时给出 eligible 全表(ord:name)与首个候选函数名,便于定位。
  const eligibleDesc = order.map((fi, ord) => `${ord}:${fns[fi]?.name ?? ('m' + fi)}`).join(',');
  const firstCandidate = fns[order[0]]?.name ?? ('m' + order[0]);
  const suspectOf = (msg) => {
    const m = /function #(\d+)/.exec(msg ?? '');
    if (m) {
      const ord = Number(m[1]) - DEFINED_BASE;
      if (ord >= 0 && ord < order.length) return fns[order[ord]]?.name ?? ('m' + order[ord]);
    }
    return firstCandidate;
  };
  let mod = null;
  try {
    mod = new WebAssembly.Module(new Uint8Array(bytes));
  } catch (e) {
    const msg = e?.message ?? String(e);
    return { status: 'fallback', eligible: order.length, reason: `WebAssembly.Module 校验失败(疑似函数 ${suspectOf(msg)};eligible=[${eligibleDesc}]):` + msg };
  }
  try {
    const stub = {};
    for (const imp of WebAssembly.Module.imports(mod)) {
      (stub[imp.module] ??= {})[imp.name] = () => 0;
    }
    new WebAssembly.Instance(mod, stub);
  } catch (e) {
    return { status: 'fallback', eligible: order.length, reason: `wasm 实例化失败(首个候选 ${firstCandidate};eligible=[${eligibleDesc}]):` + (e?.message ?? e) };
  }
  return { status: 'ok', eligible: order.length, reason: null };
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
      // v0.65 §4.5.2 任务 3:Result 槽型标记 'r'+Ok 载荷型(句柄表示,值随运行时 V 对象携带
      // 自身类型;槽型仅作 i32 位型与消费链推导来源)。Err 侧类型不进槽型(display 宿主通用)。
      case 'res': {
        const ok = this.typeToNumTy(t.ok);
        if (!ok) return null;
        return 'r' + ok;
      }
      default: return null;
    }
  }

  // v0.59(#41/#42):形参槽类型。数值 Vec 形参 = 线性内存指针(vi64ptr/vf64ptr,mut 加 m 后缀);
  // Vec[str]/Map 形参 = objTable 句柄(i32):vstr / mi64 / mf64 / mstr(此前统一记 vi64,
  // 导致 Map 形参 for-in 以"for 容器 vi64"回落);其余为 f64/str/u64/i64。
  paramSlotTy(pt, mut) {
    if (pt?.k === 'vec' && pt.el?.k === 'int' && pt.el.bits === 64 && pt.el.signed) return mut ? 'vi64ptrm' : 'vi64ptr';
    if (pt?.k === 'vec' && pt.el?.k === 'float' && pt.el.bits === 64) return mut ? 'vf64ptrm' : 'vf64ptr';
    if (pt?.k === 'vec' || pt?.k === 'map') return this.typeToNumTy(pt) ?? 'vi64';
    if (pt?.k === 'float') return 'f64';
    if (pt?.k === 'str') return 'str';
    if (pt?.k === 'int' && pt.signed === false) return 'u64';
    return 'i64';
  }

  // v0.59(#43):返回类型映射。str 返回此前落为 i64,`return "…"` 在 Return 处类型不符 → 回落;
  // 宿主 callCompiled 已按 sig.ret 做 str/vec/map 封送,故只要 retTy 正确即可走 wasm。
  // Vec/Map 返回值维持回落(未验证面):保留 i64 使 Return 显式 Unsupported。
  retNumTy(t) {
    if (t?.k === 'float' && t.bits === 64) return 'f64';
    if (t?.k === 'str') return 'str';
    if (t?.k === 'int' && t.bits === 64 && t.signed === false) return 'u64';
    return 'i64';
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
    // v0.59(#43/#48 连带):strConsts 必须随产物返回——vm.js 用 compiled.wasm.strConsts
    // 预填 wasmStrTable,str_const(off) 从该表取常量。此前 run() 只返回 {bytes,eligible},
    // compiler.js 的 `c.strConsts` 又不是 WasmCompiler 实例上的字段 → 常量表恒空,
    // wasm 内**所有字符串常量都变成空串**("a" == "b" 也会为真)。AOT(artifact.js)同源修复。
    return { bytes: new Uint8Array(bytes), eligible: this.eligible, strConsts: this.strConsts ?? [] };
  }

  // 资格分析:形状 pass + 调用图不动点回退(单一事实来源,wasm 与 C 后端共用)。
  // opts.numericOnly:额外拒绝 str/Vec/Map 形态 —— C 后端 C1 只收 i64/u64/f64 签名。
  analyze(opts = {}) {
    const fns = this.compiled.functions;
    const numericOnly = !!opts.numericOnly;
    this.ffiEffectsAllowed = !!opts.ffi; // v0.43:C 后端允许效果 ⊆ {ffi} 的函数
    // v0.54/C5:C 后端专用 unsafe 扩展(效果 ⊆ {ffi, unsafe} + Ptr 签名);
    // wasm 路径不传该旗标 → 严格拒绝(不得改 wasm 资格语义)
    this.unsafeEffectsAllowed = !!opts.unsafe;
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
      // v0.54/C5:Ptr[u8]/Ptr[mut u8] 仅 C unsafe 扩展面(wasm 不传 opts.unsafe)
      if (this.unsafeEffectsAllowed && t?.k === 'ptr' && t.el?.k === 'int' && t.el.bits === 8 && t.el.signed === false) return true;
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
    // v0.59 P2 审查 M4:函数体含本地函数声明(FnStmt)直接判 ineligible——wasm/C
    // 发射器均无本地函数路径(此前靠调用图巧合:未被调用的 FnStmt 仍使整模块
    // emit 失败 → strict fallback;现在形状阶段即排除,strict 三态一致)。
    if (this.bodyContainsFnStmt(f.entry.decl.body)) return false;
    // 基线 = wasm 既有形状(数值/str/Vec/Map);opt(ext2)/Result(ext3)为 C 后端扩展面
    const numOk = (t) => (t?.k === 'int' && t.bits === 64) || (t?.k === 'float' && t.bits === 64) || t?.k === 'str' // u64/i64/f64/str(v0.15)
      || (t?.k === 'vec' && numOkElem(t.el))
      || (t?.k === 'map' && t.kt?.k === 'str' && numOkElem(t.vt)) // v0.18
      || (ext2 && t?.k === 'opt' && numOkElem(t.el)) // v0.41(C 形参)
      || (ext3 && t?.k === 'res' && t.ok?.k === 'int' && t.ok?.bits === 64 && t.ok?.signed && t.err?.k === 'str') // v0.43(C 形参)
      || (this.unsafeEffectsAllowed && t?.k === 'ptr' && t.el?.k === 'int' && t.el.bits === 8 && t.el.signed === false); // v0.54/C5
    for (const p of sig.params) {
      if (!numOk(p.type)) return false;
    }
    if (numOk(sig.ret)) { /* ok */ }
    else if (sig.ret?.k === 'unit') { /* ok */ }
    else return false;
    if (sig.effects?.size) {
      // v0.43:C 后端 opts.ffi 允许效果 ⊆ {ffi}(extern 调用;wasm 路径仍严格拒绝)
      // v0.54/C5:opts.unsafe 额外允许 unsafe(ffi/unsafe 各自独立放行,不互相隐含)
      const effectOk = (e) => (e === 'ffi' && this.ffiEffectsAllowed)
        || (e === 'unsafe' && this.unsafeEffectsAllowed);
      if (![...sig.effects].every(effectOk)) return false;
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

  // v0.59 P2 审查 M4:函数体内是否含本地函数声明(任意嵌套块/lambda 体)。
  // 命中即 shape ineligible —— wasm/C 发射器不支持 FnStmt。
  bodyContainsFnStmt(node) {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(x => this.bodyContainsFnStmt(x));
    if (node.nt === 'FnStmt') return true;
    for (const k of Object.keys(node)) {
      if (k === 'span' || k === 'docs' || k === 'lit') continue;
      const v = node[k];
      if (v && typeof v === 'object' && this.bodyContainsFnStmt(v)) return true;
    }
    return false;
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
        // v0.59 修复:VOID(0x40)条目(vec_push_*/map_set_*)此前被兜底映射成 I64 结果 →
        // 导入声明"返回 i64",宿主返回 undefined → 运行期 TypeError("Cannot convert
        // undefined to a BigInt")。VOID 必须编码为空结果列表;此前只因这些导入不可达
        // (容器方法未发射)而潜伏。Map 字面量(map_set_*)经 #40/#41 修复后首次可达。
        const rt = results === VOID ? [] : (Array.isArray(results) ? results : [results]).map(x => x === 'i32' ? I32 : x === 'f64' ? F64 : I64);
        return [...nameBytes('ming'), ...nameBytes(n), 0x00, ...ulebBytes(typeOf(pt, rt))];
      }),
      // v0.32 修复:ming_alloc / ming_copy_vec 被生成代码调用(allocImportIdx/copyVecImportIdx)
      // 却从未在导入节声明 → 实例化校验失败 → 静默回落。声明补齐,索引与既有算式一致。
      // v0.59 P1 审查阻塞 2/3:ming_alloc 增第二参 span 索引(i32)——M4011 的
      // `<unknown>:0:0` 位置由此对齐 tree/VM(错误行位置 = 记账点表达式 span)。
      // v0.63 G2:ming_alloc_elem(nElems:i32, spanIdx:i32)->i32 追加在 panic 导入之后
      // (索引 TI+5,不改既有 68 个导入 0..TI+4 的索引)。数值 VecLit 专用:宿主按 n
      // 元素计费(interp.js:1102 口径)+ 按 16+8n 字节 bump 分配(不重复计费)——消除
      // ming_alloc 字节口径(16+8n)与 interp 元素口径的 --max-alloc 计费分歧。
      // 新导入一律放表尾(G1 首改曾插在 ming_copy_vec 数组内 → panic 索引整体 +1,
      // panic_m4003 调到 ming_alloc_elem 签名上 → V8 校验 "call[0] expected i32";
      // 教训同 v0.59 ming_alloc 错位:导入表顺序与 panicReadIdx 等算式必须逐项对齐)。
      ...[['ming_alloc', ['i32', 'i32'], ['i32']], ['ming_copy_vec', ['i32'], ['i32']]].map(([n, params, results]) => {
        const pt = params.map(x => x === 'i32' ? I32 : I64);
        const rt = results.map(x => x === 'i32' ? I32 : I64);
        return [...nameBytes('ming'), ...nameBytes(n), 0x00, ...ulebBytes(typeOf(pt, rt))];
      }),
      // v0.63 §4.4.6b slice 2:三个新 panic 导入(vm.js 导入对象同名字段)。签名:
      //   panic_m4003(spanIdx:i32, idx:i64, len:i64) —— 下标读越界(interp.js:1009 口径)
      //   panic_m4003w(spanIdx:i32, idx:i64, len:i64) —— 元素写越界(interp.js:856 口径)
      //   panic_m4006(spanIdx:i32)                    —— Option None unwrap(interp.js:3246 口径)
      // idx/len 用 i64 与元素运算口径一致;追加在尾部,既有导入索引不变。
      ...[
        ['panic_m4003', [I32, I64, I64]],
        ['panic_m4003w', [I32, I64, I64]],
        ['panic_m4006', [I32]],
      ].map(([n, pt]) => [...nameBytes('ming'), ...nameBytes(n), 0x00, ...ulebBytes(typeOf(pt, []))]),
      ...[['ming_alloc_elem', ['i32', 'i32'], ['i32']]].map(([n, params, results]) => {
        const pt = params.map(x => x === 'i32' ? I32 : I64);
        const rt = results.map(x => x === 'i32' ? I32 : I64);
        return [...nameBytes('ming'), ...nameBytes(n), 0x00, ...ulebBytes(typeOf(pt, rt))];
      }),
      // v0.65 §4.5.2 slice 3:11 个新导入,尾部追加(索引 TI+6..TI+16,见 DEFINED_BASE 注释)。
      // 宿主实现见 vm.js 同名条目;签名与 vm.js 实参顺序逐项对齐(v0.63 教训:导入表顺序、
      // 算式与宿主实现三处必须逐项核对)。
      ...[
        ['panic_expect', ['i32', 'i32'], []],              // TI+6  expect 失败(spanIdx, msg 常量 strIdx)
        ['map_has', ['i32', 'i32'], ['i32']],              // TI+7  (h, key 句柄) -> 0/1
        ['vecstr_get', ['i32', 'i64', 'i32'], ['i32']],    // TI+8  (h, idx, spanIdx) -> str 句柄
        ['res_new_i64', ['i32', 'i32', 'i64'], ['i32']],   // TI+9  (isErr, isU64, v) -> res 句柄
        ['res_new_f64', ['i32', 'f64'], ['i32']],          // TI+10 (isErr, v) -> res 句柄
        ['res_new_str', ['i32', 'i32'], ['i32']],          // TI+11 (isErr, str 句柄) -> res 句柄
        ['res_unwrap_i64', ['i32', 'i32', 'i32'], ['i64']],// TI+12 (h, spanIdx, isExpect)
        ['res_unwrap_f64', ['i32', 'i32', 'i32'], ['f64']],// TI+13
        ['res_unwrap_str', ['i32', 'i32', 'i32'], ['i32']],// TI+14
        ['frame_push', ['i32', 'i32'], []],                // TI+15 #59:(mingFnIdx, 调用点 spanIdx)
        ['frame_pop', [], []],                             // TI+16 #59:调用点正常返回配对弹出
      ].map(([n, params, results]) => {
        const pt = params.map(x => x === 'i32' ? I32 : x === 'f64' ? F64 : I64);
        const rt = results.map(x => x === 'i32' ? I32 : x === 'f64' ? F64 : I64);
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
      retTy: this.retNumTy(sig.ret),
      modFile: f.modFile,
    };
    for (let i = 0; i < sig.params.length; i++) {
      const pt = sig.params[i].type;
      ctx.scopes[0].set(sig.params[i].name, i);
      ctx.slotTypes[i] = this.paramSlotTy(pt, !!sig.params[i].mut);
    }

    // 函数入口 tick(maxSteps)
    this.callImport(ctx, 0, []);

    this.compileBlockW(f.entry.decl.body, ctx, isVoid ? null : ctx.retTy, /* noTailFallback */ true);
    if (!isVoid && !f.entry.decl.body.tail) {
      // 检查器保证数值函数必然产生值;函数级兜底(块内不再重复)。
      // v0.53 修复:仅当块无尾表达式时补零——有尾表达式时 compileBlockW 已压入返回值,
      // 再补一个 0 会使函数末尾栈上留 2 个值 → WebAssembly.Module 校验失败("expected 1
      // elements on the stack for fallthru, found 2")→ 整个 wasm 模块静默回落。
      this.compileZero(ctx, ctx.retTy);
    }
    instr.push(0x0b); // 函数 end

    // scratch 追加到槽类型表尾部,再按连续同型分组(表内是 'i64'/'f64' 字符串 → 转操作码)
    while (slotTypes.length < scratchBase) slotTypes.push('i64');
    const opcodeOf = (t) => (t === 'f64' ? F64 : (t === 'str' || t === 'i32' || t === 'vi64ptr' || t === 'vf64ptr' || t.startsWith('v') || t.startsWith('m') || t.startsWith('r') ? I32 : I64));
    // v0.59(#40/#42 根因):wasm 形参由函数签名占用局部索引 0..nParams-1,**不进入 locals 声明**。
    // 此前从槽 0 起声明(slotTypes.slice(0, scratchBase))把形参槽重复计入,声明的第 j 个局部
    // 实际索引是 nParams+j,而函数体按槽号直接 local.get/local.set → 所有槽位类型错位一位
    // (nParams=0 的纯 i64 函数因类型全同而侥幸正确;f64 局部/Vec 形参组合触发类型不符或
    // 模块校验失败)。声明必须从 nParams 起,使"声明项 j ↔ 局部索引 nParams+j ↔ 槽 nParams+j"。
    const nP = sig.params.length;
    const all = [...slotTypes.slice(nP, scratchBase), 'i64', 'i64', 'i64', 'f64', 'f64', 'i32', 'i32', 'i32'].map(opcodeOf);
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
  // v0.59(#45):值型 if 的 blocktype 必须是**单字节 valtype**(0x7e i64 / 0x7c f64 / 0x7f i32),
  // 或合法的有符号 LEB 类型索引。此前把 valtype 交给 sleb():sleb(0x7e) 生成 [0xfe,0x00]
  // = 正数 126 → "block type index 126 is not a signature definition"(f64 是 124),
  // 整模块校验失败 → 任何值型 if 的 eligible 函数全部静默回落。
  valTypeOf(ty) {
    if (ty === 'f64') return F64;
    // 'r*' = Result 句柄槽(v0.65 slice 3;值型 if 中不可达,防御性归类 i32)
    if (typeof ty === 'string' && (ty === 'str' || ty.startsWith('v') || ty.startsWith('m') || ty.startsWith('r') || ty.endsWith('ptr'))) return I32;
    return I64;
  }
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
        this.localGet(ctx, s1); this.pushI64(ctx, -1n); b.push(0x51); // b == -1
        this.localGet(ctx, s0); this.pushI64(ctx, I64_MIN); b.push(0x51); // a == i64.min
        b.push(0x71);                    // i32.and(v0.53 审查修复:此前此处两处错误——
                                         // ① opcode 误发 0x83 i64.and;② `if` 开在第二个比较
                                         // 之前,块内只剩 1 个 i32。任一都会让整模块校验失败
                                         // ("not enough arguments on the stack")→ 含 / 的
                                         // eligible 函数全部静默回落 JS VM)
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
        // v0.59 修复:此前写成 s1 > 64(gt_s),漏掉恰好 64 —— wasm 移位按 64 取模,
        // `1 << 64` 静默变 1,而 tree/VM 报 M4002(移位位数越界)。应为 >= 64(ge_s)。
        this.localGet(ctx, s1); this.pushI64(ctx, 64n); b.push(0x59);
        b.push(0x72);                    // i32.or
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);
        this.localGet(ctx, s0); this.localGet(ctx, s1);
        b.push(op === '<<' ? 0x86 : 0x87);
        this.localSet(ctx, s2);
        // v0.59 P1 审查阻塞 1:i64.shl 是位运算,左移丢位会静默回绕(3 << 62 →
        // -4611686018427387904 且 exit 0),而 tree/VM 报 M4002。移位后算术右移回检:
        // 丢位时 (r >> b) !== a(符号位一致性由 shr_s 保证);b ∈ 0..63 已在上方守卫。
        if (op === '<<') {
          this.localGet(ctx, s2); this.localGet(ctx, s1); b.push(0x87); // shr_s
          this.localGet(ctx, s0); b.push(0x52);                          // i64.ne
          b.push(0x04); b.push(0x40);
          this.emitPanic(ctx, 'M4002', span);
          b.push(0x0b);
        }
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
    // v0.56 F2 附带:槽类型表必须稠密。For 会在 declareLocal 之后按需改型(模式变量),
    // 若中间槽未预填,数组出现空洞 → 展开成 undefined → locals 分组 opcodeOf 抛 TypeError。
    // 缺省 'i64' 与原组装期 `?? 'i64'` 的既有行为一致。
    while (ctx.slotTypes.length <= slot) ctx.slotTypes.push('i64');
    ctx.scopes[ctx.scopes.length - 1].set(name, slot);
    return slot;
  }

  // v0.59(#48):临时槽(不进入名字作用域,避免与用户标识符/嵌套表达式互相覆盖)。
  // 用于二元 str 拼接的左右操作数暂存——先求值 l、再求值 r(r 内可能含嵌套 str_cat,
  // 会复用 scratch 槽,故不能用 scratch)。
  tempSlot(ctx, ty) {
    const slot = ctx.slots++;
    while (ctx.slotTypes.length <= slot) ctx.slotTypes.push('i64');
    ctx.slotTypes[slot] = ty;
    return slot;
  }

  // v0.32 修复:三个"被调用但从未定义"的方法——自 v0.23 起任何走到它们的 eligible 函数
  // 都让整模块 emit 抛错 → tryWasm 静默回落,wasm 层从未真正实例化。
  pushScope(ctx) { ctx.scopes.push(new Map()); }
  popScope(ctx) { ctx.scopes.pop(); }
  // v0.56 W2 修复:进入 wasm 结构化块(语句/表达式 if)时,把 loopStack 中所有循环目标的
  // br 相对深度 +1;离开时 -1。break/continue 的 br 深度此前只按循环自身的 block/loop
  // 位置计算,漏掉了循环体内 if 的块——`while { if c { break; } }` 的 br 实际跳到 if 末尾,
  // 循环继续 → 死循环;continue 则少跳过一段循环体。嵌套循环不受影响(新条目从自身的
  // { brk: 1, cont: 0 } 起算,外层已累计的偏移只作用于外层条目)。
  enterNestedBlock(ctx) { for (const t of ctx.loopStack) { t.brk += 1; t.cont += 1; } }
  leaveNestedBlock(ctx) { for (const t of ctx.loopStack) { t.brk -= 1; t.cont -= 1; } }
  emitStore(ctx, op, align, off) { ctx.bytes.push(op); sleb(ctx.bytes, align); sleb(ctx.bytes, off); }

  // ---------- 语句 ----------

  compileBlockW(block, ctx, wantTy, noTailFallback = false) {
    ctx.scopes.push(new Map());
    // v0.59(#46):wantTy === false/null 是 unit 上下文(语句 if/循环体/void 函数体)。
    // 块尾 if/loop 在该上下文里是**语句**(parser 把无分号的块尾表达式放进 tail;
    // `while { …; if c { break; } }`、void 函数体尾 if 即此形态)。此前一律按值编译 →
    // 值型 if 要求 else 且压值 → `REJECT: if 无 else`(无 else 的 unit if)/函数尾多压值。
    const unitCtx = wantTy === false || wantTy === null;
    for (const s of block.stmts) this.compileStmtW(s, ctx);
    if (block.tail) {
      if (unitCtx && (block.tail.nt === 'If' || block.tail.nt === 'Loop')) this.compileStmtW(block.tail, ctx);
      else this.compileNum(block.tail, ctx, wantTy ?? this.inferNumType(block.tail, ctx) ?? 'i64');
    } else if (wantTy && !noTailFallback) this.compileZero(ctx, wantTy);
    ctx.scopes.pop();
  }

  compileZero(ctx, ty) {
    if (ty === 'f64') { ctx.bytes.push(0x44); const buf = Buffer.alloc(8); buf.writeDoubleLE(0); for (const x of buf) ctx.bytes.push(x); }
    // v0.59(#43):str 返回值是 i32 句柄(函数签名 wasmTypeOf(str)=I32);此前按 i64 压 0
    // 会使函数尾栈类型与签名不符 → 整模块校验失败。句柄/容器/Result 位型同样补 i32 零。
    else if (typeof ty === 'string' && (ty === 'str' || ty.startsWith('v') || ty.startsWith('m') || ty.startsWith('r'))) this.pushI32(ctx, 0);
    else this.pushI64(ctx, 0n);
  }

  compileStmtW(s, ctx) {
    switch (s.nt) {
      case 'Let': {
        if (!s.init || s.pat.nt !== 'PIdent') throw new Unsupported('let 形式');
        // v0.65 §4.5.2 任务 3:Ok/Err 构造的 Result 局部 —— 槽型取标注(Result[T,E] → 'r'+T;
        // 无标注取构造载荷型,Err 的 ok 型由 checker 按消费点绑定,槽型仅作位型/推导标记)。
        // 构造载荷限标量(i64/u64/f64/str),容器/结构体载荷登记守护(compileResCtor 具名)。
        if (s.init.nt === 'Call' && s.init.callee?.nt === 'Ident'
          && ['Ok', 'Err'].includes(s.init.callee.name) && s.init.args.length === 1) {
          const annTy = s.type ? this.resolveResAnnTy(s.type) : null;
          // M1(v0.65 审查):标注 ok 侧非标量(Vec/结构体/bool)时 resolveResAnnTy 为 null——
          // 此前落到 resCtorSlotTy(签名缺 ctx)→ ReferenceError 非具名回落。具名守护:
          // 标注存在而解析不出标量槽型 = 载荷非标量(与 compileResCtor 守护同口径);
          // 无标注且构造载荷推不出标量才落"槽型不可推导"。
          if (s.type && !annTy) throw new Unsupported('Result 载荷非标量(容器/结构体/bool 待解锁)');
          const rty = annTy ?? this.resCtorSlotTy(s.init, ctx);
          if (!rty) throw new Unsupported('Result let 槽型不可推导');
          this.compileResCtor(s.init, ctx);
          const rslot = this.declareLocal(ctx, s.pat.name);
          ctx.slotTypes[rslot] = rty;
          this.localSet(ctx, rslot);
          return;
        }
        // v0.63 §4.4.6b slice 2:s.type 是语法型节点(nt=TName),typeToNumTy(按 t.k)对其
        // 恒 null——空 VecLit 推导同为 null → `let v: Vec[i64] = []` 此前落 'i64' 回落。
        // 仅在 init 推导为 null 时经 resolveVecAnnTy 补位,非空字面量的既有口径不变。
        let ty = this.inferNumType(s.init, ctx) ?? this.resolveVecAnnTy(s.type) ?? this.resolveResAnnTy(s.type) ?? (s.type ? this.typeToNumTy(s.type) : null) ?? 'i64';
        if (s.type) {
          const want = this.typeToNumTy(s.type);
          if (want) {
            if (want === 'u64' && ty === 'i64') ty = 'u64'; // 字面量按标注解释
            if (ty !== want) throw new Unsupported('let 标注与推导不符');
          }
        }
        // v0.63 §4.4.6b slice 2:数值 Vec 局部(VecLit 构造线性内存 ptr,槽型 vi64/vf64)。
        // Ident 初始化必须深拷贝(值语义,tree/VM bindPattern deepCopy 同口径)——
        // localGet 直传会与源别名(后续元素写互见)→ ming_copy_vec 快照。
        if (this.isNumVecTy(ty) && s.init.nt === 'Ident') {
          const srcSlot = this.slotOf(ctx, s.init.name);
          if (srcSlot === null || !this.isNumVecTy(ctx.slotTypes[srcSlot] ?? '')) {
            throw new Unsupported('Vec let 源 ' + s.init.name + '(槽型 ' + (ctx.slotTypes[srcSlot] ?? '?') + ')');
          }
          this.localGet(ctx, srcSlot);
          ctx.bytes.push(0x10); uleb(ctx.bytes, this.copyVecImportIdx());
        } else {
          this.compileNum(s.init, ctx, ty);
        }
        const slot = this.declareLocal(ctx, s.pat.name);
        ctx.slotTypes[slot] = ty;
        this.localSet(ctx, slot);
        return;
      }
      case 'Assign': {
        // 数值 Vec 元素写 v[i] = x(v 槽 = 线性内存 ptr)
        // v0.63 §4.4.6b slice 2:此前宿主无 panic_m4003 导入(越界会错报 M4002)→ 整体回落。
        // 现按 interp.js:856 发射:求值序 value → base → index → 界检查 → store,
        // 越界调 panic_m4003w(消息无 "(用 .get(i) 返回 Option)" 后缀,span = target.span)。
        if (s.target.nt === 'Index' && s.target.base.nt === 'Ident') {
          const bt2 = this.inferNumType(s.target.base, ctx);
          if (this.isNumVecTy(bt2)) {
            if (s.op !== '=') {
              // v0.65 §4.5.2 任务 5:下标复合赋值(v[i] += x 等)解锁。interp assignTo 口径
              // (interp.js:831/835):rhs 先求值 → **读**(target 按表达式求值:base+index
              // 各一次 + 读 flavor 界检查 + 元素读)→ binopValues(cur op val,检查型,
              // span = target.span)→ **写**(base+index **再次求值** + 写 flavor 界检查 +
              // store)。base/index 的双重求值是 interp 语义(副作用执行两次),逐字对齐。
              const elemTy = this.numVecElemTy(bt2);
              if (elemTy === 'f64' && !['+=', '-=', '*=', '/='].includes(s.op)) {
                throw new Unsupported('f64 下标复合赋值 ' + s.op); // interp float 无 %(M3008);wasm 无 frem
              }
              const vtmp = this.tempSlot(ctx, elemTy); // rhs 暂存(index 再求值会复用 scratch0/1/2)
              // 1. value 先求值(interp execStmt:const val = this.evalExpr(s.value))
              this.compileNum(s.value, ctx, elemTy);
              this.localSet(ctx, vtmp);
              // 2. 读:base ptr 专属槽(v0.63 审查 B1:嵌套下标读会写共享 iscratch)+ 读界检查 + 元素读
              const rslot = this.tempSlot(ctx, 'i32');
              this.compileNum(s.target.base, ctx, bt2);
              this.localSet(ctx, rslot);
              this.compileNum(s.target.index, ctx, 'i64');
              this.localSet(ctx, ctx.scratch1);
              this.emitIndexBoundsPanic(ctx, this.panicReadIdx(), s.target.span, true, rslot);
              this.emitElemLoad(ctx, elemTy, rslot);
              const ctmp = this.tempSlot(ctx, elemTy); // cur 暂存
              this.localSet(ctx, ctmp);
              // 3. cur op val:i64 检查型(M4002/M4004,span = target.span);f64 IEEE 直译
              const rslt = this.tempSlot(ctx, elemTy);
              if (elemTy === 'f64') {
                this.localGet(ctx, ctmp); this.localSet(ctx, ctx.fscratch0);
                this.localGet(ctx, vtmp); this.localSet(ctx, ctx.fscratch1);
                this.localGet(ctx, ctx.fscratch0);
                this.localGet(ctx, ctx.fscratch1);
                ctx.bytes.push({ '+=': 0xa0, '-=': 0xa1, '*=': 0xa2, '/=': 0xa3 }[s.op]);
                this.localSet(ctx, rslt);
              } else {
                this.localGet(ctx, ctmp); this.localSet(ctx, ctx.scratch0);
                this.localGet(ctx, vtmp); this.localSet(ctx, ctx.scratch1);
                this.emitCheckedOp(ctx, s.op.slice(0, -1), s.target.span);
                this.localGet(ctx, ctx.scratch2);
                this.localSet(ctx, rslt); // index 再求值会复用 scratch2 → 结果先移专属槽
              }
              // 4. 写:base/index 再次求值(interp 双重求值语义)+ 写界检查 + store
              const wslot = this.tempSlot(ctx, 'i32');
              this.compileNum(s.target.base, ctx, bt2);
              this.localSet(ctx, wslot);
              this.compileNum(s.target.index, ctx, 'i64');
              this.localSet(ctx, ctx.scratch1);
              this.emitIndexBoundsPanic(ctx, this.panicWriteIdx(), s.target.span, true, wslot);
              const b = ctx.bytes;
              this.localGet(ctx, wslot);
              this.pushI32(ctx, 16);
              b.push(0x6a);                            // i32.add:ptr+16
              this.localGet(ctx, ctx.scratch1);
              b.push(0xa7);                            // i32.wrap_i64
              this.pushI32(ctx, 8);
              b.push(0x6c);                            // i32.mul:8*idx
              b.push(0x6a);                            // i32.add:addr
              this.localGet(ctx, rslt);
              b.push(elemTy === 'f64' ? 0x39 : 0x37);  // f64.store / i64.store
              sleb(b, elemTy === 'f64' ? 3 : 0); sleb(b, 0);
              return;
            }
            const elemTy = this.numVecElemTy(bt2);
            const vtmp = this.tempSlot(ctx, elemTy); // 值暂存(index 求值会复用 scratch0/1/2)
            // v0.63 审查 B1:base ptr 存专属 tempSlot——index 子表达式可以是下标读
            // (w[v[0]] = 9 / w[v[v[1]]] = 9),其编译会写共享 iscratch → 界检查与 store
            // 用错 ptr(实测 wasm 0/222 vs tree 9/9)。
            const wslot = this.tempSlot(ctx, 'i32'); // 外层 base ptr 专属槽
            this.compileNum(s.value, ctx, elemTy);   // 1. value 先求值(interp execStmt 求值序)
            this.localSet(ctx, vtmp);
            this.compileNum(s.target.base, ctx, bt2); // 2. base ptr → wslot
            this.localSet(ctx, wslot);
            this.compileNum(s.target.index, ctx, 'i64'); // 3. index → scratch1
            this.localSet(ctx, ctx.scratch1);
            this.emitIndexBoundsPanic(ctx, this.panicWriteIdx(), s.target.span, true, wslot);
            // 4. store:addr = ptr+16+8*idx ← vtmp(后续下标读同块可见)
            const b = ctx.bytes;
            this.localGet(ctx, wslot);
            this.pushI32(ctx, 16);
            b.push(0x6a);                            // i32.add:ptr+16
            this.localGet(ctx, ctx.scratch1);
            b.push(0xa7);                            // i32.wrap_i64
            this.pushI32(ctx, 8);
            b.push(0x6c);                            // i32.mul:8*idx
            b.push(0x6a);                            // i32.add:addr
            this.localGet(ctx, vtmp);
            b.push(elemTy === 'f64' ? 0x39 : 0x37);  // f64.store / i64.store
            sleb(b, elemTy === 'f64' ? 3 : 0); sleb(b, 0);
            return;
          }
          // v0.65:s.name Vec[str] 元素写维持登记不做(v0.63 口径,句柄容器)——具名,
          // 不再落通用"赋值目标"文本。
          if (bt2 === 'vstr') throw new Unsupported('Vec[str] 元素写(句柄容器,登记不做)');
        }
        if (s.target.nt !== 'Ident') throw new Unsupported('赋值目标');
        const dst = this.slotOf(ctx, s.target.name);
        if (dst === null) throw new Unsupported('赋值目标非局部');
        const dstTy = ctx.slotTypes[dst] ?? 'i64';
        if (s.op === '=') {
          // v0.63 §4.4.6b slice 2:数值 Vec 槽整体赋值 = 深拷贝(值语义,与 tree/VM 的
          // assignTo deepCopy 同口径)。直传 ptr 会与源别名(元素写互见)→ ming_copy_vec 快照。
          // VecLit 右值走 compileNum 构造新块,天然无别名。
          if (this.isNumVecTy(dstTy) && s.value.nt === 'Ident') {
            const srcSlot = this.slotOf(ctx, s.value.name);
            if (srcSlot === null || !this.isNumVecTy(ctx.slotTypes[srcSlot] ?? '')) {
              throw new Unsupported('Vec 赋值源 ' + s.value.name + '(槽型 ' + (ctx.slotTypes[srcSlot] ?? '?') + ')');
            }
            this.localGet(ctx, srcSlot);
            ctx.bytes.push(0x10); uleb(ctx.bytes, this.copyVecImportIdx());
            this.localSet(ctx, dst);
            return;
          }
          this.compileNum(s.value, ctx, dstTy); this.localSet(ctx, dst); return;
        }
        // v0.63 §4.4.6b slice 2:f64 复合赋值(interp assignTo:cur op val;f64 四则 IEEE 直译,
        // 除零 = ±Inf/NaN 不 panic——与 interp.js binopValues 的 l.v / r.v 逐点一致)。
        // 求值序:rhs 先(interp execStmt),再读旧 dst;wasm 栈序 [dst_old, rhs] 同 cur op val。
        if (dstTy === 'f64' && (s.op === '+=' || s.op === '-=' || s.op === '*=' || s.op === '/=')) {
          this.compileNum(s.value, ctx, 'f64');
          this.localSet(ctx, ctx.fscratch0);
          this.localGet(ctx, dst);
          this.localGet(ctx, ctx.fscratch0);
          ctx.bytes.push({ '+=': 0xa0, '-=': 0xa1, '*=': 0xa2, '/=': 0xa3 }[s.op]);
          this.localSet(ctx, dst);
          return;
        }
        if (dstTy !== 'i64') throw new Unsupported('f64 复合赋值 ' + s.op);
        // v0.65 §4.5.2 顺带对齐:&=/|=/^= 与下标复合赋值同批解锁(interp binopValues 支持
        // & | ^;词法无 <<= >>=,既有两分支为死代码保留不动)。
        if (s.op === '+=' || s.op === '-=' || s.op === '*=' || s.op === '/=' || s.op === '%='
          || s.op === '&=' || s.op === '|=' || s.op === '^=' || s.op === '<<=' || s.op === '>>=') {
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
        // v0.56 W2:if 块是 br 深度的一层(break/continue 在分支内编译)
        this.enterNestedBlock(ctx);
        this.compileBlockW(s.then, ctx, false);
        if (s.els) {
          ctx.bytes.push(0x05);
          if (s.els.nt === 'If') this.compileStmtW(s.els, ctx);
          else this.compileBlockW(s.els, ctx, false);
        }
        this.leaveNestedBlock(ctx);
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
        // v0.59 P1 审查 MINOR:mut 指针槽后缀是 'ptrm'(vi64ptrm),旧写法
        // slice(1).replace('ptr','') 得 'i64m' → mut Vec for-in 永远 REJECT。
        // 先剥 'm' 再剥 'ptr'(或一次正则),得到元素型 i64/f64。
        const elem = isVecPtr ? hTy.slice(1).replace(/ptrm?$/, '') : hTy.slice(1);
        // (v0.33 根因实验进行中:摘除 v0.32 的整体回落,变体矩阵定位后按结论固化)
        const b = ctx.bytes;
        this.pushScope(ctx);
        const iSlot = this.declareLocal(ctx, '__i');
        const lenSlot = this.declareLocal(ctx, '__len');
        // __i = -1;__len = len(h)
        // v0.56 F1:自增移到 loop 头,故初值 -1(第一轮头部 +1 后从 0 开始)。此前初值 0
        // 且自增在循环尾,`continue` 的 br 0 直达 loop 头 → 跳过 __i += 1 → 死循环。
        this.pushI64(ctx, -1n);
        this.localSet(ctx, iSlot);
        this.localGet(ctx, hSlot);
        if (isMapTy) { b.push(0x10); uleb(b, this.extraImportIdx('map_len')); }
        else { b.push(0x29); sleb(b, 3); sleb(b, 0); }
        this.localSet(ctx, lenSlot);
        // 循环头:__i += 1;__i >= __len → break
        // v0.56 F1:自增位于 loop 头,continue 的 br 0(cont=0)回到头部先自增再判界,
        // 不再跳过自增;brk 仍为 1(循环体内层 if 由 enterNestedBlock 递增),break 语义不变。
        ctx.loopStack.push({ brk: 1, cont: 0 });
        b.push(0x02); b.push(0x40);      // block
        b.push(0x03); b.push(0x40);      // loop
        this.localGet(ctx, iSlot);
        this.pushI64(ctx, 1n);
        b.push(0x7c);                    // i64.add
        this.localSet(ctx, iSlot);
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
          // v0.56 F2 附带:模式变量补 slot 类型(此前缺省 i64)→ 条件里出现循环变量
          // (如 `if e % 2 == 0`)可推导。
          // v0.59 P1 审查 MINOR:原注释"f64 保持不记型"已过时——#40 修复后 f64 局部
          // 记账安全;按 elem 全量记账,f64 元素 for-in(累加/比较)可进 wasm。
          ctx.slotTypes[xSlot] = elem;
        } else {
          // (k, v):__kh = map_key_at(h, i);k = __kh(str);v = map_get(h, __kh)
          this.localGet(ctx, iSlot);       // map_key_at(h, i) 的第二参
          b.push(0x10); uleb(b, this.extraImportIdx('map_key_at'));
          const khSlot = this.declareLocal(ctx, '__kh');
          // v0.59(#41):__kh 是 str 句柄(i32)。此前槽类型缺省 i64 → 作为 map_get_*/map_key_at
          // 的 i32 实参会在模块校验期类型不符;for-in Map 形态自 v0.22 起从未真正发射成功。
          ctx.slotTypes[khSlot] = 'str';
          this.localSet(ctx, khSlot);
          if (s.pat.nt !== 'PTuple' || s.pat.pats.length !== 2) throw new Unsupported('map 迭代模式');
          const kSlot = this.declareLocal(ctx, s.pat.pats[0].nt === 'PIdent' ? s.pat.pats[0].name : '__k');
          ctx.slotTypes[kSlot] = 'str';    // Map 键恒为 str(#41)
          this.localGet(ctx, khSlot);
          this.localSet(ctx, kSlot);
          const vSlot = this.declareLocal(ctx, s.pat.pats[1].nt === 'PIdent' ? s.pat.pats[1].name : '__v');
          ctx.slotTypes[vSlot] = elem === 'str' ? 'str' : elem; // i64/f64/str(map_get_ 已按 elem 选择)
          this.localGet(ctx, hSlot);
          this.localGet(ctx, khSlot);
          // v0.59 P1 审查阻塞 2:map_get_* 第三参 span(宿主 panic 定位与 tree/VM 对齐)。
          this.pushI32(ctx, this.spanId(s.span));
          b.push(0x10); uleb(b, this.extraImportIdx('map_get_' + elem));
          this.localSet(ctx, vSlot);
        }
        this.compileBlockW(s.body, ctx, false);
        // v0.56 F1:此处不再自增(已移到 loop 头);直接回 loop 头
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
        // v0.59 P1 审查 MINOR:u64 字面量 ≥ 2^63 直接交 sleb 会编出 10 字节
        // "extra bits in varint"(i64.const 不允许非符号扩展的 64 位正向值) →
        // 整模块校验失败。wasm i64.const 是位型,先归约到有符号 64 位再编码。
        // 范围守卫必须保留:超过位宽的字面量(如 2^64)归约会静默回绕;此前这类
        // 形态靠 varint 校验失败回落 VM——现在显式回落,语义不变。
        // i64.min 字面量(-9223372036854775808 = Unary(-, 2^63))由 Unary 分支特判。
        if (ty === 'u64') {
          if (e.v < 0n || e.v > U64_MAX) throw new Unsupported('u64 字面量越界');
          this.pushI64(ctx, BigInt.asIntN(64, e.v));
          return;
        }
        if (e.v < I64_MIN || e.v > I64_MAX) throw new Unsupported('i64 字面量越界');
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
          // v0.59 P1 审查阻塞 3:容器字面量记账与 interp/VM 对齐(VecLit 按元素数计费,
          // interp.js:1091)。此前 wasm 只构造不计费 → `--max-alloc 1` 下默认引擎
          // exit 0 而 tree/VM 报 M4011。经既有 ming_alloc 导入记账(第二参 span)。
          if (e.elems.length > 0) {
            this.pushI32(ctx, e.elems.length);
            this.pushI32(ctx, this.spanId(e.span));
            ctx.bytes.push(0x10); uleb(ctx.bytes, this.allocImportIdx());
            ctx.bytes.push(0x1a);            // drop(仅记账,返回指针不保留)
          }
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
        // v0.63 §4.4.6b slice 2:数值 Vec 字面量在 wasm 内构造为**线性内存块**
        // (v0.23 容器表示统一恢复;[len@0][cap@8][elems@16],槽型 vi64/vf64 持 ptr):
        //   ming_alloc_elem(n, span) 计费+分配 → len/cap 写入 → 逐元素按源序写入。
        // v0.63 G2 计费口径裁决:经 ming_alloc_elem 按 **n 元素**计费(interp.js:1102
        // chargeAllocBytes(e.elems.length) 同口径),16+8n 字节 bump 分配由宿主完成且
        // 不重复计费——消除 ming_alloc 字节口径与 interp 元素口径的 --max-alloc 分歧
        // (此前 len3 → wasm 累计 40 vs tree/VM 3,wasm 面更早触 M4011)。
        // str/Map 字面量仍走 ming_alloc(count, span):与 interp 的字符/条目口径一致,不动。
        // 此前守护原因(局部槽按 objTable 句柄解释的表示分裂)随下标读/写的 ptr 化消除。
        // 元素偏移动态计算(静态 memarg offset 经 sleb 编码 ≥64 时字节错误,v0.23 旧码缺陷)。
        const elemTy2 = ty.slice(1).replace(/ptrm?$/, '');
        if (elemTy2 !== 'i64' && elemTy2 !== 'f64') throw new Unsupported('VecLit 元素 ' + elemTy2);
        const n2 = e.elems.length;
        // v0.63 审查 B1:块 ptr 存专属 tempSlot(不再用共享 iscratch)——元素表达式可以是
        // 下标读([v[2], v[1], v[0]],甚至双层 v[v[0]]),其编译会写 iscratch → 第 2+ 个
        // 元素的 addr 与最终返回值用错 ptr(实测 wasm 121/222 vs tree 321/120)。
        const blkSlot = this.tempSlot(ctx, 'i32'); // 新块 ptr 专属槽
        this.pushI32(ctx, n2);
        this.pushI32(ctx, this.spanId(e.span)); // v0.59 P1:记账点 span(M4011 定位对齐)
        ctx.bytes.push(0x10); uleb(ctx.bytes, this.allocElemImportIdx());
        this.localSet(ctx, blkSlot);
        // len @0、cap @8(与 wasmWriteVecNum/ming_copy_vec 布局一致)
        this.localGet(ctx, blkSlot);
        this.pushI64(ctx, BigInt(n2));
        this.emitStore(ctx, 0x37, 0, 0);
        this.localGet(ctx, blkSlot);
        this.pushI64(ctx, BigInt(n2));
        this.emitStore(ctx, 0x37, 0, 8);
        e.elems.forEach((el, i) => {
          // addr = ptr+16+8*i(动态);元素表达式按既有求值序逐个编译(wasm 值栈跨调用保留)
          this.localGet(ctx, blkSlot);
          this.pushI32(ctx, 16 + 8 * i);
          ctx.bytes.push(0x6a); // i32.add
          this.compileNum(el, ctx, elemTy2);
          this.emitStore(ctx, elemTy2 === 'f64' ? 0x39 : 0x37, elemTy2 === 'f64' ? 3 : 0, 0);
        });
        this.localGet(ctx, blkSlot);
        return;
      }
      case 'MapLit': {
        if (!ty || !ty.startsWith('m')) throw new Unsupported('MapLit 类型 ' + ty);
        const valTy = ty.slice(1); // 'i64' | 'f64' | 'str'
        // v0.59 P1 审查阻塞 3:同 VecLit——Map 字面量按条目数记账(interp.js:1095),
        // 经 ming_alloc 计入累计配额;否则 wasm 路径绕过 --max-alloc。
        if (e.entries.length > 0) {
          this.pushI32(ctx, e.entries.length);
          this.pushI32(ctx, this.spanId(e.span));
          ctx.bytes.push(0x10); uleb(ctx.bytes, this.allocImportIdx());
          ctx.bytes.push(0x1a);            // drop
        }
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
        // v0.59 P1 审查 MINOR 6 回归修复:-9223372036854775808 的字面量操作数是 2^63
        // (单独越 i64 上界,IntLit 守卫会回落),但取负恰为 i64.min——tree/VM 的
        // negSlow(0 - 2^63)在范围内。特判直出 I64_MIN(通用分支的 == MIN 检查针对
        // 运行时值取负,不适用于此字面量形态)。
        if (ty === 'i64' && e.expr.nt === 'IntLit' && e.expr.bits === 64
          && e.expr.v === 9223372036854775808n) {
          this.pushI64(ctx, I64_MIN);
          return;
        }
        if (ty === 'f64') {
          this.compileNum(e.expr, ctx, 'f64');
          b.push(0x9a); // f64.neg(IEEE,无溢出概念)
          return;
        }
        if (ty === 'u64') {
          // 无符号取负:0 - x 位型,无溢出概念
          // v0.56 W1 修复:wasm i64.sub 的栈序是 [a, b] → a - b;此前先压 x 后压 0
          // 实际执行 x - 0 = x(取负完全失效)。必须先压 0 再压 x。
          this.pushI64(ctx, 0n);
          this.compileNum(e.expr, ctx, 'u64');
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
        // v0.56 W1 修复:同上——i64.sub 需要 [0, x] 才是 0 - x;此前栈序反了
        // (实测 `return -a;` 经 wasm 返回 a,负字面量比较同样失真)。
        this.pushI64(ctx, 0n);
        this.localGet(ctx, ctx.scratch0);
        b.push(0x7d);
        return;
      }
      case 'Binary': return this.compileBinNum(e, ctx, ty);
      case 'Call': return this.compileCallNum(e, ctx, ty);
      case 'If': {
        this.compileCond(e.cond, ctx);
        b.push(0x04); b.push(this.valTypeOf(ty));
        // v0.56 W2:表达式 if 的分支块同样是 br 深度的一层
        this.enterNestedBlock(ctx);
        this.compileBlockW(e.then, ctx, ty);
        b.push(0x05);
        if (!e.els) throw new Unsupported('if 无 else');
        if (e.els.nt === 'If') this.compileNum(e.els, ctx, ty);
        else this.compileBlockW(e.els, ctx, ty);
        this.leaveNestedBlock(ctx);
        b.push(0x0b);
        return;
      }
      case 'Index': {
        const bt = this.inferNumType(e.base, ctx);
        if (!bt || !(bt.startsWith('v') || bt.startsWith('m'))) throw new Unsupported('下标目标 ' + bt);
        // 数值 Vec 下标读(vi64/vf64 槽 + vi64ptr/vi64ptrm/vf64ptr/vf64ptrm 形参槽):
        // 线性内存 [len@0][cap@8][elems@16],界内读 elems[i](i64→BigInt 包回由 wasm 边界承担)。
        // v0.63 §4.4.6b slice 2:此前宿主无 panic_m4003 导入(vm.js 导入集合固定),越界会
        // 错落 panic_m4002 → 显式回落。现按 interp.js:1009 发射:越界调 panic_m4003
        // (读 flavor,消息带 "(用 .get(i) 返回 Option)" 后缀,span = 下标表达式 span)。
        // Vec[str](vstr 句柄)维持守护(具名)。
        // v0.63 审查 B1:base ptr 存专属 tempSlot(不再用共享 iscratch)——index 子表达式
        // 本身可以是下标读(a[b[0]] 双层嵌套,内外 base 不同变量),其编译会写 iscratch,
        // 共享槽静默错值(r7/r8 实测:值位/let 位嵌套读 wasm 2/110 vs tree 202/10)。
        if (this.isNumVecTy(bt)) {
          const ptrSlot = this.tempSlot(ctx, 'i32'); // 外层 base ptr 专属槽(嵌套读各用各的)
          this.compileNum(e.base, ctx, bt);          // ptr → ptrSlot
          this.localSet(ctx, ptrSlot);
          this.compileNum(e.index, ctx, 'i64');      // idx → scratch1(每次界检查前重设,嵌套安全)
          this.localSet(ctx, ctx.scratch1);
          this.emitIndexBoundsPanic(ctx, this.panicReadIdx(), e.span, true, ptrSlot);
          this.emitElemLoad(ctx, this.numVecElemTy(bt), ptrSlot);
          return;
        }
        // v0.65 §4.5.2 任务 4:Vec[str] 下标读解锁 —— 句柄容器(vstr 槽 = objTable 句柄 i32):
        // 界检查/读 flavor 消息/span 全在宿主 vecstr_get(interp.js:1009 口径,与数值读的
        // panic_m4003 消息逐字同源),界内返回 str 句柄(strTable 新条目)。base 句柄存专属
        // tempSlot(B1 同款:index 子表达式可以是嵌套下标读)。
        if (bt === 'vstr') {
          const hSlot = this.tempSlot(ctx, 'i32');
          this.compileNum(e.base, ctx, bt);          // 句柄 → hSlot
          this.localSet(ctx, hSlot);
          this.compileNum(e.index, ctx, 'i64');      // idx → scratch1
          this.localSet(ctx, ctx.scratch1);
          this.localGet(ctx, hSlot);
          this.localGet(ctx, ctx.scratch1);
          this.pushI32(ctx, this.spanId(e.span));
          ctx.bytes.push(0x10); uleb(ctx.bytes, this.vecstrGetIdx());
          return;
        }
        if (!bt.startsWith('m')) throw new Unsupported('Vec 下标读 ' + bt + '(非句柄/数值容器)');
        const elemTy = bt.slice(1);
        const b = ctx.bytes;
        // map[key]:缺键由 JS 导入 panic(M4007,宿主抛 Panic,码与消息同 tree/VM)
        // v0.63 审查 B1:同数值读——base ptr 存专属 tempSlot(key 子表达式可能内嵌读)。
        const mapSlot = this.tempSlot(ctx, 'i32');
        this.compileNum(e.base, ctx, bt);
        this.localSet(ctx, mapSlot);
        // v0.59 修复:map_get_*(h, key) 的实参顺序此前是 (key, h)——宿主按 h 取表、
        // 按 keyStr 取键,等于用句柄当键 → M4007 或错值(该路径此前整体不可达)。
        this.compileNum(e.index, ctx, 'str');
        this.localSet(ctx, ctx.iscratch2);
        this.localGet(ctx, mapSlot);
        this.localGet(ctx, ctx.iscratch2);
        // v0.59 P1 审查阻塞 2:第三参 = span 索引。宿主据此抛带位置的 Panic
        // (此前缺键 panic 是 `<unknown>:0:0`,与 tree/VM 的 file:line:col 不一致)。
        this.pushI32(ctx, this.spanId(e.span));
        b.push(0x10); uleb(b, this.extraImportIdx('map_get_' + elemTy));
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
        // v0.56 F2:此前本 switch 有两个 'Binary' case——首个只处理 str `+` 后 break,
        // 通用分支不可达 → 非 `+` 二元表达式(如 `i % 2`)推导 undefined,`if i % 2 == 0`
        // 报"条件操作数 undefined"整模块回落。合并后规则:
        //   - 比较/逻辑 → null(不能作为数值值)
        //   - str + str → 'str'(拼接)
        //   - i64/u64 二元运算 → 沿用左侧类型;f64 四则(#40 修复后局部/形参记账安全)→ 'f64';
        //     其余(容器/未知)→ null 回落。
        if (['&&', '||', '==', '!=', '<', '<=', '>', '>='].includes(e.op)) return null;
        const l = this.inferNumType(e.l, ctx);
        if (e.op === '+' && l === 'str') return 'str';
        if (l === 'i64' || l === 'u64') return l;
        // v0.59(#40):此前 f64 刻意不推导(原注释:locals 声明索引偏移未修,f64 局部会让整模块
        // 校验失败)。#40 已修,恢复 f64 四则推导,`let z = y * 2.0` 一类真实形态可进 wasm。
        if (l === 'f64' && ['+', '-', '*', '/'].includes(e.op)) return 'f64';
        return null;
      }
      case 'Call': {
        const mn1 = this.mathNameOf(e.callee, ctx);
        if (mn1) return MATH_IDX.has(mn1) ? 'f64' : null;
        // v0.65 §4.5.2 slice 3:消费链/Result 构造的类型推导(let 无标注位需要):
        //   X.get(i).unwrap()/expect(msg) → 元素型;m.get(k).unwrap()/expect(msg) → 值型;
        //   r.unwrap()/expect(msg) → res 槽载荷型('ri64'.slice(1) = 'i64');
        //   Ok(x)/Err(x) 构造 → 'r'+载荷型。
        const cn0 = e.callee;
        if (cn0?.nt === 'Field' && ['unwrap', 'expect'].includes(cn0.name)) {
          const base0 = cn0.base;
          if (base0?.nt === 'Call' && base0.callee?.nt === 'Field' && base0.callee.name === 'get'
            && base0.callee.base?.nt === 'Ident' && base0.args.length === 1) {
            const rt0 = this.inferNumType(base0.callee.base, ctx);
            if (this.isNumVecTy(rt0)) return this.numVecElemTy(rt0);
            if (rt0 && rt0.startsWith('m')) return rt0.slice(1);
          }
          if (base0 && (base0.nt === 'Ident'
            || (base0.nt === 'Call' && base0.callee?.nt === 'Ident' && ['Ok', 'Err'].includes(base0.callee.name)))) {
            const rt0 = this.inferNumType(base0, ctx);
            if (rt0 && ['ri64', 'ru64', 'rf64', 'rstr'].includes(rt0)) return rt0.slice(1);
          }
        }
        if (cn0?.nt === 'Ident' && ['Ok', 'Err'].includes(cn0.name) && e.args.length === 1) {
          const pt0 = this.inferNumType(e.args[0], ctx);
          if (pt0 && ['i64', 'u64', 'f64', 'str'].includes(pt0)) return 'r' + pt0;
        }
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
        // v0.63 §4.4.6b slice 2:数值 Vec ptr 槽(形参/VecLit 局部)下标读 → 元素型
        if (bt === 'vi64' || bt === 'vi64ptr' || bt === 'vi64ptrm') return 'i64';
        if (bt === 'vf64' || bt === 'vf64ptr' || bt === 'vf64ptrm') return 'f64';
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
        // v0.59(#48):分配记账与 interp/VM 对齐——`l + r` 计费 len(l)+len(r)
        // (interp.js binopValues 的 chargeAllocBytes(l.v.length + r.v.length))。
        // 此前 wasm 的 str_cat 只拼句柄表、不计费 → 同程序默认引擎不触发 M4011,
        // 而 --no-wasm/tree 触发。经既有导入记账,不新增导入名:
        //   str_len(l)+str_len(r) → ming_alloc(n)(宿主 chargeAllocBytes + bump 分配)→ drop 指针
        // 注:str_len 为 Unicode 码点数(与 interp 的 UTF-16 长度在 BMP 内一致;星面
        // 代理对字符差 1/字符,记账门禁量级相同)。插值(StrLit 多段)在 tree/VM 均不计费,
        // 故此处只覆盖二元 `+`,与 interp 口径一致。
        const lSlot = this.tempSlot(ctx, 'str');
        const rSlot = this.tempSlot(ctx, 'str');
        this.compileNum(e.l, ctx, 'str');
        this.localSet(ctx, lSlot);
        this.compileNum(e.r, ctx, 'str');
        this.localSet(ctx, rSlot);
        this.localGet(ctx, lSlot);
        ctx.bytes.push(0x10); uleb(ctx.bytes, this.strImportIdx('len'));
        this.localGet(ctx, rSlot);
        ctx.bytes.push(0x10); uleb(ctx.bytes, this.strImportIdx('len'));
        ctx.bytes.push(0x7c);            // i64.add
        ctx.bytes.push(0xa7);            // i32.wrap_i64(ming_alloc 参数为 i32)
        this.pushI32(ctx, this.spanId(e.span)); // v0.59 P1:记账点 span(M4011 定位对齐)
        ctx.bytes.push(0x10); uleb(ctx.bytes, this.allocImportIdx());
        ctx.bytes.push(0x1a);            // drop(仅记账,返回指针不保留)
        this.localGet(ctx, lSlot);
        this.localGet(ctx, rSlot);
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
        // v0.59 修复:同 signed 分支,64 必须落入越界(ge_u 0x5a,此前 gt_u 0x56 漏 64)。
        this.localGet(ctx, s1); this.pushI64(ctx, 0n); b.push(0x53);
        this.localGet(ctx, s1); this.pushI64(ctx, 64n); b.push(0x5a);
        b.push(0x72);
        b.push(0x04); b.push(0x40);
        this.emitPanic(ctx, 'M4002', span);
        b.push(0x0b);
        this.localGet(ctx, s0); this.localGet(ctx, s1);
        b.push(op === '<<' ? 0x86 : 0x88); // shl / shr_u
        this.localSet(ctx, s2);
        // v0.59 P1 审查阻塞 1(u64):同 signed 分支,shl 丢位静默回绕(3u64 << 63 →
        // 2^63 且 exit 0),tree/VM M4002(`超出 i64u 范围`)。逻辑右移回检:
        // 丢位时 (r >>u b) !== a;b ∈ 0..63 已在上方守卫。
        if (op === '<<') {
          this.localGet(ctx, s2); this.localGet(ctx, s1); b.push(0x88); // shr_u
          this.localGet(ctx, s0); b.push(0x52);                          // i64.ne
          b.push(0x04); b.push(0x40);
          this.emitPanic(ctx, 'M4002', span);
          b.push(0x0b);
        }
        return;
      }
      case '&': { this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x83); this.localSet(ctx, s2); return; }
      case '|': { this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x84); this.localSet(ctx, s2); return; }
      case '^': { this.localGet(ctx, s0); this.localGet(ctx, s1); b.push(0x85); this.localSet(ctx, s2); return; }
      default:
        throw new Unsupported('u64 运算 ' + op);
    }
  }

  // Option/Result 消费链编译(v0.22;v0.63 slice 2 数值 Vec unwrap;v0.65 §4.5.2 slice 3 收口):
  //   X.get(i).unwrap()/expect(字面量 msg)      —— 越界 → panic_m4006 / panic_expect
  //   m.get(k).unwrap()/expect(字面量 msg)      —— map_has 判定在先,缺键 → panic_m4006 / panic_expect
  //   r.unwrap()/expect(msg)                     —— Result 句柄:Ok 载荷直通,Err → panic_m4006
  //                                                 (unwrap 消息 = `对 Err(<display>) 调用 unwrap()`,
  //                                                 expect 消息 = `expect 失败: <载荷.v>`,interp.js:3258 口径——
  //                                                 msg 实参求值后丢弃,副作用保留)
  // 语义直译(零 Option 表示):unwrap ≡ 越界/缺键 panic。
  // 裸 Option 值(存储/match 解构/跨任务)不支持 → Unsupported 回落 JS VM(语义不变)。
  // 仍登记守护(具名):unwrap_or / is_some / is_none(bool 局部/let 绑定表示缺失)、
  // expect 的非字面量 msg、非局部接收者、Vec[str].get 消费链。
  tryCompileGetConsumed(e, ctx, ty) {
    const callee = e?.callee;
    if (callee?.nt === 'Field' && ['unwrap', 'unwrap_or', 'is_some', 'is_none', 'expect'].includes(callee.name)) {
      const getCall = callee.base;
      const isExpect = callee.name === 'expect';
      const unwrapArityOk = isExpect ? e.args.length === 1 : e.args.length === 0;
      // expect 的 msg 须为编译期字面量(经 strConsts 表索引穿越导入边界;变量/插值 msg 登记守护)
      const expectMsgLit = () => {
        const m = isExpect ? e.args[0] : null;
        if (!m || m.nt !== 'StrLit' || m.parts.length !== 1 || !('lit' in m.parts[0])) {
          throw new Unsupported('expect msg 非编译期字面量(待解锁)');
        }
        return m.parts[0].lit;
      };
      // ---- Result 消费链(v0.65 slice 3):接收者 = res 槽(Ident)或 Ok/Err 构造 ----
      // unwrap/expect 的宿主导入按**上下文型**选(i64/u64→res_unwrap_i64,f64→_f64,str→_str):
      // checker 把 ok 载荷型绑定到消费点上下文,运行时 V 对象携带自身类型,槽型仅是标记。
      if ((callee.name === 'unwrap' || isExpect) && unwrapArityOk) {
        const rty = getCall ? this.inferNumType(getCall, ctx) : null;
        if (rty && ['ri64', 'ru64', 'rf64', 'rstr'].includes(rty)) {
          // M2(v0.65 审查):求值序必须 recv → args(interp 方法调用先接收者后实参)。
          // 此前 msg(e.args[0])先编入共享栈再 drop、接收者后编——`Err(<溢出>).expect(mk())`
          // 双溢出对照中 tree panic span 在 Err 载荷、wasm 在 mk 内(span 差分)。接收者句柄
          // 存专属 tempSlot(msg 求值会复用 scratch/共享栈),再编 msg 并 drop,最后取回句柄。
          const hslot = this.tempSlot(ctx, 'i32');       // res 句柄专属槽(i32)
          this.compileNum(getCall, ctx, rty);            // 接收者先求值 → 句柄 → hslot
          this.localSet(ctx, hslot);
          if (isExpect) {
            // Result.expect 消息 = Err 载荷 display(interp 忽略 msg,但先求值 args[0]——副作用保留)
            this.compileNum(e.args[0], ctx, 'str');
            ctx.bytes.push(0x1a); // drop(msg 值不进消息)
          }
          this.localGet(ctx, hslot);                     // res 句柄 → 栈
          this.pushI32(ctx, this.spanId(e.span));
          this.pushI32(ctx, isExpect ? 1 : 0);
          ctx.bytes.push(0x10); uleb(ctx.bytes, this.resUnwrapIdx(ty));
          return { ty };
        }
      }
      // ---- 数值 Vec / Map 的 get 消费链(v0.63 数值 Vec unwrap;v0.65 expect/Map 解锁)----
      if (getCall?.nt === 'Call' && getCall.callee?.nt === 'Field' && getCall.callee.name === 'get'
        && (callee.name === 'unwrap' || isExpect) && unwrapArityOk
        && getCall.callee.base.nt === 'Ident' && getCall.args.length === 1) {
        const recvTy = this.inferNumType(getCall.callee.base, ctx);
        if (this.isNumVecTy(recvTy)) {
          // v0.63 审查 B1:recv ptr 存专属 tempSlot——idx 实参可以是下标读
          // (w.get(v[0]).unwrap()),其编译会写共享 iscratch → 界检查/加载用错 ptr
          // (实测 wasm 2 vs tree 8)。
          const uslot = this.tempSlot(ctx, 'i32'); // recv ptr 专属槽
          this.compileNum(getCall.callee.base, ctx, recvTy); // recv ptr → uslot
          this.localSet(ctx, uslot);
          this.compileNum(getCall.args[0], ctx, 'i64');      // idx → scratch1
          this.localSet(ctx, ctx.scratch1);
          if (isExpect) {
            // v0.65 §4.5.2 任务 1:expect(字面量 msg)——越界 → panic_expect(spanIdx, strIdx),
            // 消息 `expect 失败: <msg>`(interp.js:3246);msg 经 strConsts 偏移直读宿主预填区。
            const lit = expectMsgLit();
            this.emitIndexBoundsPanic(ctx, this.expectPanicIdx(), e.span, false, uslot, () => {
              this.pushI32(ctx, this.spanId(e.span));
              this.pushI32(ctx, this.strConstOffset(lit));
            });
          } else {
            this.emitIndexBoundsPanic(ctx, this.panicNoneIdx(), e.span, false, uslot); // M4006 只带 spanIdx
          }
          this.emitElemLoad(ctx, this.numVecElemTy(recvTy), uslot);
          return { ty: this.numVecElemTy(recvTy) };
        }
        // v0.65 §4.5.2 任务 2:Map get 消费链 —— map_has 判定在先(map_get 语义拆分),
        // 缺键 → panic_m4006(`对 None 调用 unwrap()`)/ panic_expect,消息与 span 同
        // tree/VM(interp 经 Option 包装,实测 m.get(缺键).unwrap() 报 M4006 对 None)。
        if (recvTy && recvTy.startsWith('m')) {
          const elemTy = recvTy.slice(1);
          const lit = isExpect ? expectMsgLit() : null;
          const mslot = this.tempSlot(ctx, 'i32');   // recv 句柄专属槽(B1 同款)
          this.compileNum(getCall.callee.base, ctx, recvTy);
          this.localSet(ctx, mslot);
          this.compileNum(getCall.args[0], ctx, 'str'); // key 句柄 → iscratch2(嵌套读在 localSet 前完成)
          this.localSet(ctx, ctx.iscratch2);
          this.localGet(ctx, mslot);
          this.localGet(ctx, ctx.iscratch2);
          ctx.bytes.push(0x10); uleb(ctx.bytes, this.mapHasIdx());
          ctx.bytes.push(0x45);                       // i32.eqz:缺键
          ctx.bytes.push(0x04); ctx.bytes.push(0x40);
          this.pushI32(ctx, this.spanId(e.span));
          if (isExpect) this.pushI32(ctx, this.strConstOffset(lit));
          ctx.bytes.push(0x10); uleb(ctx.bytes, isExpect ? this.expectPanicIdx() : this.panicNoneIdx());
          ctx.bytes.push(0x0b);
          // 键存在 → map_get_ty(缺键 panic 分支不可达,span 实参仍传齐)
          this.localGet(ctx, mslot);
          this.localGet(ctx, ctx.iscratch2);
          this.pushI32(ctx, this.spanId(e.span));
          ctx.bytes.push(0x10); uleb(ctx.bytes, this.extraImportIdx('map_get_' + elemTy));
          return { ty: elemTy };
        }
      }
      throw new Unsupported('Option 消费链 ' + callee.name + '(unwrap_or/is_*/非局部接收者/Vec[str].get 侧待解锁)');
    }
    return null;
  }
    compileCallNum(e, ctx, ty) {
    // v0.65 §4.5.2 任务 3:Ok/Err 构造器 → res_new_*(句柄)。载荷限标量(i64/u64/f64/str,
    // 与 compileNum 可编译面一致);容器/结构体载荷登记守护(display 复杂度超界)。
    // Some/None 不构造(零 Option 表示,落下方具名回落)。
    if (e.callee?.nt === 'Ident' && ['Ok', 'Err'].includes(e.callee.name) && e.args.length === 1) {
      this.compileResCtor(e, ctx);
      return;
    }
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
    const mingIdx = this.resolveEligibleMingIdx(ctx, callee.name);
    if (mingIdx === null) throw new Unsupported('调用 ' + callee.name);
    const widx = DEFINED_BASE + (this.wasmOrder ? this.wasmOrder.indexOf(mingIdx) : -1);
    const mod = this.modulesByFile.get(ctx.modFile);
    const entry = mod?.items.get(callee.name);
    const calleeSig = entry?.sig;
    e.args.forEach((a, i) => {
      const pt = calleeSig?.params[i]?.type;
      const argTy = pt?.k === 'float' ? 'f64' : (pt?.k === 'str' ? 'str' : 'i64');
      // mut Vec 实参:值语义拷贝(被调 push/set 不影响调用方)
      // v0.63 §4.4.6b slice 2:槽型判定放宽到全部数值 Vec ptr 槽(vi64/vf64 = VecLit 局部,
      // *ptr/*ptrm = 形参再传递)——此前仅 'vi64'/'vf64'(彼时不可达),形参再传递恒 REJECT。
      if (pt?.k === 'vec' && pt.el?.k !== 'str' && a.nt === 'Ident') {
        const srcSlot = this.slotOf(ctx, a.name);
        if (srcSlot !== null && this.isNumVecTy(ctx.slotTypes[srcSlot] ?? '')) {
          this.localGet(ctx, srcSlot);
          ctx.bytes.push(0x10); uleb(ctx.bytes, this.copyVecImportIdx());
          return;
        }
      }
      this.compileNum(a, ctx, argTy);
    });
    // v0.65 §4.5.2 #59:wasm→wasm 直调的调用点帧透传——frame_push(fnIdx, callSpan) →
    // call → frame_pop(每调用点配对,正常返回即弹出;panic 穿透时帧留在宿主
    // wasmFrameStack,callCompiled catch 合并进 e.stack,与 tree/VM 三帧逐字)。
    // 实参求值在前(与 interp 一致),帧名/调用点 span 与 interp callUser 同口径。
    this.pushI32(ctx, mingIdx);
    this.pushI32(ctx, this.spanId(e.span));
    ctx.bytes.push(0x10); uleb(ctx.bytes, this.framePushIdx());
    ctx.bytes.push(0x10);
    uleb(ctx.bytes, widx);
    ctx.bytes.push(0x10); uleb(ctx.bytes, this.framePopIdx());
    void ty;
  }

  // v0.65 §4.5.2 任务 3:Ok/Err 构造编译(载荷限标量)。isU64 保真 u64 载荷的
  // Err display 位型(wasm i64 有符号出栈,宿主 asUintN 还原)。
  compileResCtor(e, ctx) {
    const isErr = e.callee.name === 'Err' ? 1 : 0;
    const arg = e.args[0];
    const pty = this.inferNumType(arg, ctx);
    if (pty === 'str') {
      this.pushI32(ctx, isErr);
      this.compileNum(arg, ctx, 'str');
      ctx.bytes.push(0x10); uleb(ctx.bytes, this.resNewIdx('str'));
      return;
    }
    if (pty === 'f64') {
      this.pushI32(ctx, isErr);
      this.compileNum(arg, ctx, 'f64');
      ctx.bytes.push(0x10); uleb(ctx.bytes, this.resNewIdx('f64'));
      return;
    }
    if (pty === 'i64' || pty === 'u64') {
      this.pushI32(ctx, isErr);
      this.pushI32(ctx, pty === 'u64' ? 1 : 0);
      this.compileNum(arg, ctx, pty);
      ctx.bytes.push(0x10); uleb(ctx.bytes, this.resNewIdx('i64'));
      return;
    }
    throw new Unsupported('Result 载荷非标量(容器/结构体/bool 待解锁)');
  }

  // Ok/Err 构造的槽型标记(无标注 let 位推导):'r'+载荷型
  // M1(v0.65 审查):签名必须带 ctx——此前方法体引用 ctx 但形参缺失/不在闭包作用域,
  // 无标注 `let r = Ok(7)` 直接 ReferenceError: ctx is not defined(非具名回落)。
  resCtorSlotTy(e, ctx) {
    const pty = this.inferNumType(e.args[0], ctx);
    if (pty && ['i64', 'u64', 'f64', 'str'].includes(pty)) return 'r' + pty;
    return null;
  }

  allocImportIdx() {
    // v0.59(#48 连带):此前 +1 指向 **ming_copy_vec**(导入表尾是 ming_alloc@TOTAL_IMPORTS、
    // ming_copy_vec@TOTAL_IMPORTS+1)——VecLit/str 计费调到了错误宿主函数(静默错行为)。
    // 与 emitModule 的导入序严格对齐:3(宿主)+ math + str + vecmap。
    return 3 + MATH_IMPORTS.length + STR_IMPORTS.length + VECMAP_IMPORTS.length; // ming_alloc
  }

  copyVecImportIdx() {
    return 3 + MATH_IMPORTS.length + STR_IMPORTS.length + VECMAP_IMPORTS.length + 1; // ming_copy_vec
  }

  // v0.63 §4.4.6b slice 2:三个新 panic 导入的索引(与 emitModule 导入序严格对齐,追加在尾)
  panicReadIdx() {
    return TOTAL_IMPORTS + 2; // panic_m4003(下标读;消息带 "(用 .get(i) 返回 Option)" 后缀)
  }

  panicWriteIdx() {
    return TOTAL_IMPORTS + 3; // panic_m4003w(元素写;消息无后缀,interp.js:856)
  }

  panicNoneIdx() {
    return TOTAL_IMPORTS + 4; // panic_m4006(Option None unwrap,interp.js:3246)
  }

  // v0.63 G2:ming_alloc_elem 导入索引(与 emitModule 导入序严格对齐,追加在 panic 之后)
  allocElemImportIdx() {
    return TOTAL_IMPORTS + 5; // ming_alloc_elem(数值 VecLit:元素计费 + ptr 块分配)
  }

  // v0.65 §4.5.2 slice 3:新导入索引(TI+6..TI+16,与 emitModule 尾部追加序逐项对齐)
  expectPanicIdx() {
    return TOTAL_IMPORTS + 6; // panic_expect(spanIdx, strIdx)
  }

  mapHasIdx() {
    return TOTAL_IMPORTS + 7; // map_has(h, kh) -> i32
  }

  vecstrGetIdx() {
    return TOTAL_IMPORTS + 8; // vecstr_get(h, i, spanIdx) -> str 句柄
  }

  resNewIdx(pty) {
    if (pty === 'f64') return TOTAL_IMPORTS + 10; // res_new_f64(isErr, v)
    if (pty === 'str') return TOTAL_IMPORTS + 11; // res_new_str(isErr, sh)
    return TOTAL_IMPORTS + 9; // res_new_i64(isErr, isU64, v) —— i64/u64 载荷共用
  }

  // Result unwrap/expect 导入按**上下文型**选(ty = 消费点期望型;checker 把 ok 载荷型
  // 绑定到上下文):i64/u64 位型共用 _i64,f64/_f64,str/_str。h/spanIdx/isExpect 同型。
  resUnwrapIdx(ty) {
    if (ty === 'f64') return TOTAL_IMPORTS + 13; // res_unwrap_f64
    if (ty === 'str') return TOTAL_IMPORTS + 14; // res_unwrap_str
    return TOTAL_IMPORTS + 12; // res_unwrap_i64(i64/u64)
  }

  framePushIdx() {
    return TOTAL_IMPORTS + 15; // frame_push(fnIdx, spanIdx) —— #59
  }

  framePopIdx() {
    return TOTAL_IMPORTS + 16; // frame_pop() —— #59
  }

  // v0.63 §4.4.6b slice 2:数值 Vec 槽型判定(线性内存 ptr 表示,[len@0][cap@8][elems@16])。
  // vi64/vf64 = VecLit 局部;*ptr/*ptrm = 数值 Vec 形参(非 mut/mut)。
  isNumVecTy(t) {
    return t === 'vi64' || t === 'vf64' || t === 'vi64ptr' || t === 'vi64ptrm' || t === 'vf64ptr' || t === 'vf64ptrm';
  }

  // 槽型 → 元素型('i64' | 'f64';剥 ptr/ptrm 后缀)
  numVecElemTy(t) {
    return t.slice(1).replace(/ptrm?$/, '');
  }

  // v0.63 §4.4.6b slice 2:let 标注语法型(只认 Vec[i64]/Vec[f64] TName 形态)→ 槽型。
  resolveVecAnnTy(t) {
    if (!t || t.nt !== 'TName' || t.name !== 'Vec' || !t.args || t.args.length !== 1) return null;
    const el = t.args[0];
    if (el?.nt === 'TName' && el.name === 'i64' && (!el.args || el.args.length === 0)) return 'vi64';
    if (el?.nt === 'TName' && el.name === 'f64' && (!el.args || el.args.length === 0)) return 'vf64';
    return null;
  }

  // v0.65 §4.5.2 任务 3:Result 标注语法型(Result[T, E] TName 形态)→ 槽型标记 'r'+T。
  // T = 标量(i64/u64/f64/str);容器/结构体载荷不构造(compileResCtor 具名守护),标注
  // 位返回 null 落下方具名回落。E(Err 侧类型)不进槽型——display 由宿主按运行时值通用处理。
  resolveResAnnTy(t) {
    if (!t || t.nt !== 'TName' || t.name !== 'Result' || !t.args || t.args.length !== 2) return null;
    const ok = t.args[0];
    if (ok?.nt !== 'TName' || (ok.args && ok.args.length !== 0)) return null;
    if (['i64', 'u64', 'f64', 'str'].includes(ok.name)) return 'r' + ok.name;
    return null;
  }

  // 下标界检查(0 <= idx < len)→ 越界调 panicIdx 指定的导入。前置:ptr 在 ptrSlot,
  // idx(i64)在 scratch1;span = Ming 侧 panic 位置(读=e.span,写=s.target.span)。
  // withIdxLen=false 用于 panic_m4006(签名只有 spanIdx——None unwrap 消息不含 idx/len)。
  // v0.63 审查 B1:ptrSlot 由调用方传入(专属 tempSlot)——共享 iscratch 会被嵌套
  // 下标读/Map 读子表达式覆盖(外层 base ptr 跨表达式复用冲突,静默错值),废除该用法。
  // v0.65 §4.5.2:emitArgs 回调用于 panic_expect(签名 (spanIdx, strIdx)——msg 经
  // strConsts 表索引穿越;回调内不得编译子表达式,只压常量/既有槽值)。
  emitIndexBoundsPanic(ctx, panicIdx, span, withIdxLen = true, ptrSlot, emitArgs = null) {
    const b = ctx.bytes;
    this.localGet(ctx, ctx.scratch1);
    this.pushI64(ctx, 0n);
    b.push(0x53);                            // i64.lt_s:idx < 0
    this.localGet(ctx, ctx.scratch1);
    this.localGet(ctx, ptrSlot);
    b.push(0x29); sleb(b, 3); sleb(b, 0);    // len = i64.load(ptr+0)
    b.push(0x5a);                            // i64.ge_s:idx >= len
    b.push(0x72);                            // i32.or
    b.push(0x04); b.push(0x40);
    if (emitArgs) {
      emitArgs();
    } else {
      this.pushI32(ctx, this.spanId(span));    // spanIdx
      if (withIdxLen) {
        this.localGet(ctx, ctx.scratch1);      // idx(i64)
        this.localGet(ctx, ptrSlot);
        b.push(0x29); sleb(b, 3); sleb(b, 0);  // len(i64)
      }
    }
    b.push(0x10); uleb(b, panicIdx);
    b.push(0x0b);
  }

  // 界内元素加载:addr = ptr+16+8*idx → elemTy 值压栈(ptr 在 ptrSlot,idx 在 scratch1)。
  // 偏移动态计算(v0.23 静态 offset 经 sleb 编码 ≥64 时字节错误,本次不用)。
  emitElemLoad(ctx, elemTy, ptrSlot) {
    const b = ctx.bytes;
    this.localGet(ctx, ptrSlot);
    this.pushI32(ctx, 16);
    b.push(0x6a);                            // i32.add:ptr+16
    this.localGet(ctx, ctx.scratch1);
    b.push(0xa7);                            // i32.wrap_i64
    this.pushI32(ctx, 8);
    b.push(0x6c);                            // i32.mul:8*idx
    b.push(0x6a);                            // i32.add:addr
    b.push(elemTy === 'f64' ? 0x2b : 0x29);  // f64.load / i64.load
    sleb(b, 3); sleb(b, 0);
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
          b.push(0x04); b.push(I32);
          this.compileCond(e.r, ctx);
          b.push(0x05); b.push(0x41); sleb(b, 0);
          b.push(0x0b);
          return;
        }
        if (e.op === '||') {
          this.compileCond(e.l, ctx);
          b.push(0x04); b.push(I32);
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


  // v0.65 §4.5.2 #59:直调需要 ming 层函数下标(frame_push 实参)+ wasm 函数索引两个值,
  // 拆出 resolveEligibleMingIdx 供 compileCallNum 双取(既有 resolveWasmCallIdx 口径不变)。
  resolveEligibleMingIdx(ctx, name) {
    const mod = this.modulesByFile.get(ctx.modFile);
    if (!mod) return null;
    const entry = mod.items.get(name);
    if (entry?.kind !== 'fn') return null;
    const mingIdx = this.compiled.entryFnIdx?.get(entry);
    if (mingIdx === undefined || !this.eligible.has(mingIdx)) return null;
    return mingIdx;
  }

  resolveWasmCallIdx(ctx, name) {
    const mingIdx = this.resolveEligibleMingIdx(ctx, name);
    if (mingIdx === null) return null;
    return DEFINED_BASE + (this.wasmOrder ? this.wasmOrder.indexOf(mingIdx) : -1);
  }
}

// wasmOrder 在 emitModule 中构建,resolve 阶段需要 → 存到实例
// (emitModule 在 run 中调用,先于 code 生成)
