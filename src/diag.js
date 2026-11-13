// diag.js — Ming 诊断系统:稳定错误码 + 结构化(JSON)与人类可读两种输出。
// Ming 的工具链输出是 AI 反馈闭环的一部分:每个诊断都有稳定 code、精确 span、hint。

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

// 稳定错误码表。新增诊断必须在此注册,并同步更新 docs/diagnostics.md。
export const CODES = {
  // ---- 词法 M1xxx ----
  M1001: 'unexpected-character',
  M1002: 'unterminated-string',
  M1003: 'invalid-number',
  M1004: 'invalid-escape',
  M1005: 'unterminated-comment',
  M1006: 'reserved-word',
  // ---- 语法 M2xxx ----
  M2001: 'unexpected-token',
  M2002: 'expected-token',
  M2003: 'invalid-pattern',
  M2004: 'invalid-lambda-params',
  M2005: 'chained-comparison',
  M2006: 'duplicate-parameter',
  M2007: 'invalid-assignment-target',
  // ---- 类型/语义 M3xxx ----
  M3001: 'cannot-find-name',
  M3002: 'mismatched-types',
  M3003: 'cannot-infer-type',
  M3004: 'assignment-to-immutable',
  M3005: 'wrong-arg-count',
  M3006: 'unknown-field',
  M3007: 'non-exhaustive-match',
  M3008: 'invalid-operands',
  M3009: 'duplicate-definition',
  M3010: 'break-outside-loop',
  M3011: 'continue-outside-loop',
  M3012: 'cannot-interpolate-type',
  M3013: 'int-width-mismatch',
  M3014: 'condition-not-bool',
  M3015: 'unknown-method',
  M3016: 'shadowed-binding',
  M3017: 'missing-return',
  M3018: 'generic-op-unavailable',
  M3019: 'invalid-cast',
  M3020: 'cannot-index',
  M3021: 'not-callable',
  M3022: 'unknown-import',
  M3023: 'missing-main',
  M3024: 'unknown-variant',
  M3025: 'import-cycle',
  M3026: 'cannot-iterate',
  M3027: 'missing-field',
  M3028: 'refutable-let-pattern',
  M3029: 'undeclared-effect',
  M3030: 'unknown-effect',
  M3031: 'const-not-constant',
  M3032: 'trait-impl-mismatch',
  M3033: 'not-json-serializable',
  M3034: 'join-handle-escapes',
  M3040: 'invariant-field-protected',
  M3041: 'contract-violated-at-call',
  M3042: 'ensures-statically-false',
  M3043: 'contract-not-pure',
  M3044: 'invalid-map-key',
  M3045: 'index-bounds-violated',
  M3046: 'unsafe-context-required', // v0.54:指针操作/Ptr 实参在 unsafe 块外
  M3047: 'local-fn-unsupported', // v0.59(#44):已废弃——本地函数恢复(VM 编译路径落地),此码不再发射;号段按"已发布码不改号"保留
  M3048: 'generic-local-fn-unsupported', // v0.59 P2 审查 MINOR:本地函数不支持类型参数(区别于 M3003 推断失败)
  // ---- 警告 ----
  W3101: 'unused-variable',
  W3102: 'float-equality',
  W3103: 'unreachable-code',
  W3104: 'test-literal-overfit',
  W3105: 'index-bounds-unproven',
  // ---- 运行时 M4xxx ----
  M4001: 'panic',
  M4002: 'integer-overflow',
  M4003: 'index-out-of-bounds',
  M4004: 'division-by-zero',
  M4005: 'stack-overflow',
  M4006: 'unwrap-failed',
  M4007: 'missing-key',
  M4008: 'assertion-failed',
  M4010: 'task-timeout',
  M4011: 'alloc-quota-exceeded',
  M4012: 'time-quota-exceeded',
  M4013: 'ffi-load-failed',
  M4015: 'contract-violation',
  M4016: 'native-only-feature', // v0.54:tree/VM 执行指针操作/std.mem
};

export const CODE_HINTS = {
  M3013: 'Ming 不做隐式宽度转换:运算/比较要求两侧整数宽度一致。用 `as` 显式转换,或用 `to_i64()` 等安全转换方法。',
  M3002: '检查两处的类型标注;Ming 没有任何隐式转换。',
  M3003: '为表达式添加类型标注,例如 `let v: Vec[i64] = [];` 或为闭包参数标注类型 `(x: i64) => ...`。',
  M3007: 'match 必须穷尽所有情况:补齐分支,或添加 `_ =>` 兜底分支。',
  M3029: '给函数签名添加效果声明:fn f() with io, time { ... }(效果必须显式写出并逐层传播)。',
  M4003: '用 `get(i)` 会返回 Option[T] 而不是 panic。',
  M4007: '用 `get(k)` 会返回 Option[V] 而不是 panic。',
  M3045: '调整 requires 边界或索引表达式,使 0 <= i 且 i < len$buf 对所有满足 requires 的调用成立;或改用 buf.get(i) 返回 Option 而不是 panic。',
  M3046: '给函数签名加 "with unsafe",并把指针读写/传递放进 unsafe { ... } 块;块外只允许 let/赋值/return 传递与 p.is_null()。',
  // M3047 已废弃(v0.59 #44 本地函数恢复):不再发射,hint 一并移除。号段保留不改号。
  M3048: '本地函数编译为独立函数帧、不做单态化:把泛型函数声明在模块级(顶层),或去掉本地函数的类型参数。',
  M4016: 'unsafe 指针操作仅由 C 原生后端(ming cc)执行;tree/VM 不伪装内存语义。',
  W3105: '这是"无法证明"而非"确定越界":证明器只处理 requires 线性边界下的直线体。可补充线性 requires(如 i < buf.len() && i >= 0),或改用 buf.get(i)。',
};

export class Diagnostic {
  constructor(code, severity, message, span, hint = null, notes = []) {
    this.code = code;            // 稳定码,如 "M3002"
    this.severity = severity;    // 'error' | 'warning'
    this.message = message;      // 中文主消息
    this.span = span;            // {file,line,col,endLine,endCol}
    this.hint = hint;
    this.notes = notes;          // [{span,message}]
  }
  get name() { return CODES[this.code] || 'unknown'; }
  toJson() {
    const j = {
      code: this.code, name: this.name, severity: this.severity,
      message: this.message,
      file: this.span?.file ?? null, line: this.span?.line ?? 0, col: this.span?.col ?? 0,
      endLine: this.span?.endLine ?? this.span?.line ?? 0, endCol: this.span?.endCol ?? this.span?.col ?? 0,
    };
    if (this.hint) j.hint = this.hint;
    if (this.fix) j.fix = this.fix;
    if (this.notes.length) j.notes = this.notes.map(n => ({ message: n.message, file: n.span?.file, line: n.span?.line, col: n.span?.col }));
    return j;
  }
}

export class MingError extends Error {
  constructor(diags) {
    super(diags[0]?.message ?? 'unknown error');
    this.diags = diags;
  }
}

const RESET = '\x1b[0m', BOLD = '\x1b[1m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', DIM = '\x1b[2m';

function colorize(enable, s, c) { return enable ? c + s + RESET : s; }

// 人类可读渲染:file:line:col: severity code[name]: message + 源码行 + 脱字符
export function formatDiag(d, color = false) {
  const out = [];
  const sev = d.severity === 'error'
    ? colorize(color, 'error', RED)
    : colorize(color, 'warning', YELLOW);
  const head = `${d.span?.file ?? '<unknown>'}:${d.span?.line ?? 0}:${d.span?.col ?? 0}: ${sev} ${colorize(color, d.code + '[' + d.name + ']', BOLD)}: ${d.message}`;
  out.push(head);
  if (d.span && d.span.file && sourceLineCache.has(d.span.file)) {
    const lines = sourceLineCache.get(d.span.file);
    const ln = d.span.line;
    if (ln >= 1 && ln <= lines.length) {
      const text = lines[ln - 1];
      const gutter = String(ln).padStart(4);
      out.push(colorize(color, `    ${gutter} | `, DIM) + text.replace(/\t/g, '    '));
      const width = Math.max(1, (d.span.endLine === ln ? d.span.endCol : d.span.col + 1) - d.span.col);
      const pad = ' '.repeat(gutter.length + 4 + Math.max(0, d.span.col - 1));
      out.push(colorize(color, pad + '^'.repeat(Math.min(width, 40)), d.severity === 'error' ? RED : YELLOW));
    }
  }
  if (d.hint) out.push(colorize(color, '  hint: ' + d.hint, CYAN));
  for (const n of d.notes) out.push(colorize(color, `  note: ${n.message} (${n.span?.file}:${n.span?.line}:${n.span?.col})`, DIM));
  return out.join('\n');
}

const sourceLineCache = new Map();
export function cacheSourceLines(file, src) {
  if (!sourceLineCache.has(file)) sourceLineCache.set(file, src.split(/\r?\n/));
}
export function clearSourceCache() { sourceLineCache.clear(); }

export function err(code, message, span, hint, notes) {
  return new Diagnostic(code, SEVERITY.ERROR, message, span, hint ?? CODE_HINTS[code] ?? null, notes ?? []);
}
export function warn(code, message, span, hint, notes) {
  return new Diagnostic(code, SEVERITY.WARNING, message, span, hint ?? CODE_HINTS[code] ?? null, notes ?? []);
}
