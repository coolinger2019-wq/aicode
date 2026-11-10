// lexer.js — Ming 词法分析器。
// 设计要点:显式分隔(`;` 与 `{}` 必需)、字符串插值 `\{expr}`、嵌套块注释、
// 数字字面量带宽度后缀(i64/u8/f32...)、`..` 与浮点数消歧。

import { err, MingError } from './diag.js';

export const KEYWORDS = new Set([
  'let', 'mut', 'fn', 'return', 'if', 'else', 'while', 'for', 'in', 'loop',
  'break', 'continue', 'match', 'use', 'pub', 'struct', 'enum', 'test',
  'true', 'false', 'as', 'const', 'with', 'trait', 'impl', 'self', 'extern',
]);

// 保留字:v0.2 不使用,但禁止作为标识符,避免 AI 生成与未来版本冲突的代码。
export const RESERVED = new Set([
  'super', 'static', 'where', 'unsafe',
  'async', 'await', 'yield', 'defer', 'null', 'nil', 'var', 'class', 'interface',
  'try', 'catch', 'throw', 'switch', 'case', 'default', 'do', 'type', 'new',
  'macro', 'then', 'elif', 'foreach',
]);

export const INT_SUFFIXES = new Set(['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'f32', 'f64']);

// 按 token 种类:'id' 'kw' 'int' 'float' 'str' 'op' 'eof'
// str token 的 parts: [{lit: "..."} | {tokens: [Token]}](插值表达式)
export class Token {
  constructor(kind, val, span, extra = null) {
    this.kind = kind; this.val = val; this.span = span; this.extra = extra;
  }
}

const OPS2 = ['->', '=>', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '..'];
const OPS1 = '+-*/%<>=!&|^?:;,(){}[].';

function isIdentStart(ch) { return /[A-Za-z_]/.test(ch); }
function isIdentChar(ch) { return /[A-Za-z0-9_]/.test(ch); }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }

export class Lexer {
  constructor(file, src) {
    this.file = file; this.src = src;
    this.i = 0; this.line = 1; this.col = 1;
    this.tokens = [];
    this.comments = []; // {span, text, doc}
  }

  peek(o = 0) { return this.src[this.i + o] ?? ''; }
  mark() { return { i: this.i, line: this.line, col: this.col }; }
  resetTo(m) { this.i = m.i; this.line = m.line; this.col = m.col; }

  adv() {
    const ch = this.src[this.i];
    this.i++;
    if (ch === '\n') { this.line++; this.col = 1; } else { this.col++; }
    return ch;
  }

  spanFrom(m) {
    return { file: this.file, line: m.line, col: m.col, endLine: this.line, endCol: this.col };
  }

  error(code, msg, m) { throw new MingError([err(code, msg, this.spanFrom(m ?? this.mark()))]); }

  skipWsAndComments() {
    for (;;) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { this.adv(); continue; }
      if (ch === '/' && this.peek(1) === '/') {
        const m = this.mark();
        let doc = false;
        this.adv(); this.adv();
        if (this.peek() === '/') { doc = true; this.adv(); }
        let text = '';
        while (this.i < this.src.length && this.peek() !== '\n') text += this.adv();
        // 去掉尾部 \r
        text = text.replace(/\r$/, '');
        this.comments.push({ span: this.spanFrom(m), text, doc });
        continue;
      }
      if (ch === '/' && this.peek(1) === '*') {
        const m = this.mark();
        this.adv(); this.adv();
        let depth = 1;
        while (depth > 0) {
          if (this.i >= this.src.length) this.error('M1005', '块注释未闭合', m);
          if (this.peek() === '/' && this.peek(1) === '*') { this.adv(); this.adv(); depth++; continue; }
          if (this.peek() === '*' && this.peek(1) === '/') { this.adv(); this.adv(); depth--; continue; }
          this.adv();
        }
        continue;
      }
      break;
    }
  }

  run() {
    for (;;) {
      this.skipWsAndComments();
      if (this.i >= this.src.length) { this.tokens.push(new Token('eof', '', this.spanFrom(this.mark()))); break; }
      this.lexToken();
    }
    return this;
  }

  lexToken() {
    const m = this.mark();
    const ch = this.peek();

    if (ch === 'r' && this.peek(1) === '"') {
      // 原始字符串 r"...":无转义、无插值(正则 pattern 用;v0.26)
      this.adv();
      this.lexString(m, true);
      const tok = this.tokens[this.tokens.length - 1];
      tok.raw = true;
      return;
    }
    if (isIdentStart(ch)) { this.lexIdent(m); return; }
    if (isDigit(ch)) { this.lexNumber(m); return; }
    if (ch === '"') { this.lexString(m, false); return; }

    // 运算符:三/两/一字符
    const three = this.src.slice(this.i, this.i + 3);
    void three;
    const two = this.src.slice(this.i, this.i + 2);
    if (OPS2.includes(two)) { this.adv(); this.adv(); this.tokens.push(new Token('op', two, this.spanFrom(m))); return; }
    if (OPS1.includes(ch)) { this.adv(); this.tokens.push(new Token('op', ch, this.spanFrom(m))); return; }

    this.error('M1001', `无法识别的字符 ${JSON.stringify(ch)}`, m);
  }

  lexIdent(m) {
    let name = '';
    while (isIdentChar(this.peek())) name += this.adv();
    if (KEYWORDS.has(name)) { this.tokens.push(new Token('kw', name, this.spanFrom(m))); return; }
    if (RESERVED.has(name)) {
      this.error('M1006', `"${name}" 是 Ming 的保留字(v0.1 未使用,为未来版本预留),不能作为标识符`, m);
    }
    this.tokens.push(new Token('id', name, this.spanFrom(m)));
  }

  lexNumber(m) {
    let text = '';
    let isFloat = false;
    if (this.peek() === '0' && 'xob'.includes(this.peek(1))) {
      const baseCh = this.peek(1);
      this.adv(); this.adv();
      const digits = baseCh === 'x' ? /[0-9a-fA-F_]/ : /[0-9_]/;
      let body = '';
      while (digits.test(this.peek()) && this.peek() !== '') body += this.adv();
      if (body.replace(/_/g, '') === '') this.error('M1003', `${baseCh} 进制数字缺少有效位`, m);
      text = '0' + baseCh + body;
    } else {
      while (isDigit(this.peek()) || this.peek() === '_') text += this.adv();
      // 浮点:. 后必须是数字,且不能是 `..`(区间运算符)
      if (this.peek() === '.' && isDigit(this.peek(1))) {
        isFloat = true;
        text += this.adv(); // '.'
        while (isDigit(this.peek()) || this.peek() === '_') text += this.adv();
        if (this.peek() === 'e' || this.peek() === 'E') {
          isFloat = true;
          text += this.adv();
          if (this.peek() === '+' || this.peek() === '-') text += this.adv();
          if (!isDigit(this.peek())) this.error('M1003', '指数缺少数字', m);
          while (isDigit(this.peek())) text += this.adv();
        }
      }
      if (!isFloat && (this.peek() === '.' && isIdentStart(this.peek(1) || ''))) {
        // `1.foo` 之类:数字后面的点不是合法组成
        this.error('M1003', `数字字面量 "${text}" 后紧跟 ".":浮点数小数点后必须有数字;若是方法调用请先加括号`, m);
      }
    }
    // 宽度后缀
    let suffix = null;
    const sm = this.mark();
    let suf = '';
    while (isIdentChar(this.peek())) suf += this.adv();
    if (suf !== '') {
      if (!INT_SUFFIXES.has(suf)) this.error('M1003', `未知的数字后缀 "${suf}"(可用:${[...INT_SUFFIXES].join(' ')})`, sm);
      suffix = suf;
    }
    const clean = text.replace(/_/g, '');
    if (suffix && suffix[0] === 'f') {
      const v = Number(clean);
      if (!Number.isFinite(v) && !/e/i.test(clean)) this.error('M1003', `浮点字面量 "${text}" 无效`, m);
      this.tokens.push(new Token('float', v, this.spanFrom(m), { bits: suffix === 'f32' ? 32 : 64, suffix }));
    } else if (suffix) {
      const bits = Number(suffix.slice(1));
      this.tokens.push(new Token('int', clean, this.spanFrom(m), { bits, signed: suffix[0] === 'i', suffix }));
    } else if (isFloat) {
      this.tokens.push(new Token('float', Number(clean), this.spanFrom(m), { bits: 64, suffix: null }));
    } else {
      this.tokens.push(new Token('int', clean, this.spanFrom(m), { bits: 64, signed: true, suffix: null }));
    }
  }

  lexString(m, raw) {
    this.adv(); // 开头引号
    const parts = [];
    let buf = '';
    const flush = () => { if (buf !== '') { parts.push({ lit: buf }); buf = ''; } };

    for (;;) {
      if (this.i >= this.src.length) this.error('M1002', '字符串未闭合(缺少收尾的 ")', m);
      const ch = this.peek();
      if (ch === '"') { this.adv(); break; }
      if (ch === '\n' && !raw) this.error('M1002', '字符串中不能直接换行;用 \\n 或多段拼接', m);
      if (raw) { buf += this.adv(); continue; }
      if (ch === '\\') {
        this.adv();
        const e = this.peek();
        if (e === '{') { // 插值 \{expr}
          this.adv();
          flush();
          const toks = this.lexInterpExpr();
          parts.push({ tokens: toks });
          continue;
        }
        this.adv();
        switch (e) {
          case 'n': buf += '\n'; break;
          case 't': buf += '\t'; break;
          case 'r': buf += '\r'; break;
          case '0': buf += '\0'; break;
          case '\\': buf += '\\'; break;
          case '"': buf += '"'; break;
          case 'u': {
            if (this.peek() !== '{') this.error('M1004', '\\u 后必须是 {码位},例如 \\u{1F600}', m);
            this.adv();
            let hex = '';
            while (this.peek() !== '}') {
              if (this.i >= this.src.length) this.error('M1004', '\\u{...} 未闭合', m);
              hex += this.adv();
            }
            this.adv();
            const cp = Number.parseInt(hex, 16);
            if (!hex || Number.isNaN(cp) || cp > 0x10FFFF) this.error('M1004', `无效的 Unicode 码位 "\\u{${hex}}"`, m);
            buf += String.fromCodePoint(cp);
            break;
          }
          default:
            this.error('M1004', `未知的转义 "\\${e}"(可用:\\n \\t \\r \\0 \\\\ \\" \\u{...} \\{插值})`, m);
        }
        continue;
      }
      buf += this.adv();
    }
    flush(); // 冲刷插值之后的尾部字面量
    if (parts.length === 0 || (parts.length === 1 && 'lit' in parts[0])) {
      this.tokens.push(new Token('str', parts.map(p => p.lit ?? '').join(''), this.spanFrom(m)));
    } else {
      this.tokens.push(new Token('str', null, this.spanFrom(m), { parts }));
    }
  }

  // 已消费 `\{`,读取插值表达式直到配对的 `}`(深度计数;字符串/注释内的括号由正常 token 流处理)
  lexInterpExpr() {
    const toks = [];
    let depth = 0;
    for (;;) {
      this.skipWsAndComments();
      if (this.i >= this.src.length) this.error('M1002', '插值表达式 \\{...} 未闭合', this.mark());
      const ch = this.peek();
      if (depth === 0 && ch === '}') { this.adv(); toks.push(new Token('eof', '', this.spanFrom(this.mark()))); return toks; }
      this.lexToken();
      const t = this.tokens.pop();
      if (t.kind === 'op') {
        if (t.val === '{') depth++;
        else if (t.val === '}') depth--;
      }
      toks.push(t);
    }
  }
}

export function lex(file, src) {
  return new Lexer(file, src).run();
}
