// parser.js — Ming 语法分析器(递归下降 + 局部回溯 + 错误恢复收集多个诊断)。
// 语法原则:显式分隔(`;`/`{}` 必需)、关键字驱动、无悬垂歧义。
// 唯一的上下文规则(在 docs/design.md 中说明):
//   1. 语句开头的 `{` 是块;表达式位置的 `{` 是 Map 字面量。
//   2. if/while/match 头部与 for 的迭代式里,结构体字面量被禁用(那里的 `{` 是块/分支)。

import { err, MingError } from './diag.js';
import { Token, lex } from './lexer.js';

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=']);

export function parse(file, src) {
  const { tokens, comments } = lex(file, src);
  const p = new Parser(tokens, file);
  const program = p.parseProgram();
  attachDocs(program.items, comments);
  return { program, comments, diags: p.diags };
}

export function parseExprSource(file, tokens) {
  const p = new Parser(tokens, file);
  const e = p.parseExpr();
  if (!p.at('eof')) p.bail('M2001', `表达式后有多余内容 ${tokDesc(p.cur())}`, p.cur().span);
  return e;
}

// 把 /// 文档注释挂到紧随其后的 item 上
export function attachDocs(items, comments) {
  if (!comments.length) return;
  const docs = comments.filter(c => c.doc);
  for (const item of items) {
    const s = item.span;
    item.docs = docs.filter(d =>
      d.span.endLine < s.line && (s.line - d.span.endLine) <= 2 &&
      (d.span.file === s.file)
    ).map(d => d.text);
  }
}

export class Parser {
  constructor(tokens, file) {
    this.toks = tokens; this.file = file; this.pos = 0;
    this.diags = [];
    this.noStructLit = 0; // 上下文标志深度
  }

  peek(o = 0) { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  cur() { return this.peek(0); }
  at(kind, val = null) {
    const t = this.cur();
    return t.kind === kind && (val === null || t.val === val);
  }
  atOp(v) { return this.at('op', v); }
  atKw(v) { return this.at('kw', v); }
  next() { return this.toks[this.pos++]; }
  mark() { return this.pos; }
  resetTo(p) { this.pos = p; }

  spanFrom(startTok, endTok = null) {
    const s = startTok.span, e = (endTok ?? this.peek(-1)).span;
    return { file: this.file, line: s.line, col: s.col, endLine: e.endLine, endCol: e.endCol };
  }

  bail(code, msg, span, hint) { throw { mingParse: true, diag: err(code, msg, span, hint) }; }

  fail(code, msg, span, hint) {
    const d = err(code, msg, span ?? this.cur().span, hint);
    this.diags.push(d);
    return d;
  }

  expectOp(v, what = null) {
    if (this.atOp(v)) return this.next();
    const d = err('M2002', `期望 "${v}"${what ? `(在${what}之后)` : ''},实际是 ${tokDesc(this.cur())}`, this.cur().span,
      this.cur().kind === 'kw' ? `"${this.cur().val}" 是关键字,可能用错了位置` : null);
    // v0.44:结构化修复处方——在当前位置插入期望的 token
    const p = { line: this.cur().span.line, col: this.cur().span.col };
    d.fix = { start: p, end: p, replacement: v };
    throw { mingParse: true, diag: d };
  }
  expectKw(v) {
    if (this.atKw(v)) return this.next();
    const d = err('M2002', `期望关键字 "${v}",实际是 ${tokDesc(this.cur())}`, this.cur().span);
    const p = { line: this.cur().span.line, col: this.cur().span.col };
    d.fix = { start: p, end: p, replacement: v + ' ' };
    throw { mingParse: true, diag: d };
  }
  expectId(what = '标识符') {
    if (this.at('id')) return this.next();
    if (this.at('kw')) this.bail('M2001', `${what}不能是关键字 "${this.cur().val}"`, this.cur().span);
    this.bail('M2002', `期望${what},实际是 ${tokDesc(this.cur())}`, this.cur().span);
  }

  // ---- 错误恢复:收集多个诊断而不是遇错即停 ----
  recover(topLevel) {
    for (;;) {
      const t = this.cur();
      if (t.kind === 'eof') return;
      if (topLevel && t.kind === 'kw' && ['fn', 'struct', 'enum', 'use', 'test', 'pub'].includes(t.val)) return;
      if (!topLevel && t.kind === 'kw' && ['fn', 'let', 'return', 'while', 'for', 'loop', 'if', 'match', 'test', 'unsafe'].includes(t.val)) return;
      if (t.kind === 'op' && t.val === '}') return;
      if (t.kind === 'op' && t.val === ';') { this.next(); return; }
      this.next();
    }
  }

  parseProgram() {
    const items = [];
    while (!this.at('eof')) {
      const mark = this.pos;
      try {
        const item = this.parseItem();
        if (item) items.push(item);
      } catch (e) {
        if (e && e.mingParse) {
          this.diags.push(e.diag);
          this.recover(true);
          if (this.pos === mark) this.next(); // 保证前进
          continue;
        }
        throw e;
      }
    }
    return { nt: 'Program', items, span: { file: this.file, line: 1, col: 1, endLine: 1, endCol: 1 } };
  }

  parseItem() {
    let pub = false;
    if (this.atKw('pub')) { this.next(); pub = true; if (!this.atKw('fn', ) && !this.atKw('struct') && !this.atKw('enum') && !this.atKw('const')) {
      this.bail('M2002', `"pub" 之后必须是 fn/struct/enum/const`, this.cur().span);
    } }
    if (this.atKw('fn')) return this.parseFn(pub);
    if (this.atKw('extern')) return this.parseExternFn();
    if (this.atKw('struct')) return this.parseStruct(pub);
    if (this.atKw('enum')) return this.parseEnum(pub);
    if (this.atKw('use')) return this.parseUse();
    if (this.atKw('test')) return this.parseTest();
    if (this.atKw('const')) return this.parseConst(pub);
    if (this.atKw('trait')) return this.parseTrait(pub);
    if (this.atKw('impl')) return this.parseImpl();
    this.bail('M2001', `顶层只能是 fn / struct / enum / use / test / const / trait / impl 声明(可加 pub),实际是 ${tokDesc(this.cur())}`, this.cur().span,
      '顶层不能写 let 或可执行语句;把逻辑放进 fn main() 里。');
  }

  // extern [lib] fn 名(参数) -> 返回;(v0.42 FFI 声明:隐含 ffi 效果,调用方须 with ffi;
  // C 后端 dlsym 兑现,JS 引擎运行时以 M4001 拒绝)
  parseExternFn() {
    const start = this.expectKw('extern');
    let lib = null;
    if (this.cur().kind === 'str') { lib = this.cur().val; this.next(); }
    this.expectKw('fn');
    const nameTok = this.expectId('extern 函数名');
    this.expectOp('(');
    const params = [];
    while (!this.atOp(')')) {
      const pName = this.expectId('参数名');
      this.expectOp(':', '参数名');
      const type = this.parseType();
      params.push({ name: pName.val, type, mut: false, span: this.spanFrom(pName) });
      if (this.atOp(',')) { this.next(); continue; }
      break;
    }
    this.expectOp(')');
    let ret = null;
    if (this.atOp('->')) { this.next(); ret = this.parseType(); }
    this.expectOp(';', 'extern fn 声明以 ";" 结束');
    return { nt: 'ExternFnDecl', name: nameTok.val, lib, params, ret, effects: [{ name: 'ffi', span: start }], tparams: [], bounds: [], span: this.spanFrom(start) };
  }

  parseTrait(pub) {
    const start = this.expectKw('trait');
    const nameTok = this.expectId('trait 名');
    this.expectOp('{');
    const methods = [];
    while (!this.atOp('}')) {
      const m = this.parseTraitMethod();
      methods.push(m);
    }
    this.expectOp('}');
    return { nt: 'TraitDecl', name: nameTok.val, methods, pub, span: this.spanFrom(start) };
  }

  // trait 方法声明:fn eq(self, other: Self) -> bool;  (v0.2 无默认实现)
  parseTraitMethod() {
    const start = this.expectKw('fn');
    const nameTok = this.expectId('方法名');
    this.expectOp('(');
    const params = [];
    let selfMut = false;
    // 第一个参数必须是 self
    if (this.atKw('mut')) { this.next(); selfMut = true; }
    this.expectKw('self');
    params.push({ name: 'self', self: true, mut: selfMut, type: null, span: this.spanFrom(start) });
    if (this.atOp(',')) { this.next(); }
    while (!this.atOp(')')) {
      const pName = this.expectId('参数名');
      this.expectOp(':', '参数名');
      const type = this.parseType();
      params.push({ name: pName.val, type, span: this.spanFrom(pName) });
      if (this.atOp(',')) { this.next(); continue; }
      break;
    }
    this.expectOp(')');
    let ret = null;
    if (this.atOp('->')) { this.next(); ret = this.parseType(); }
    this.expectOp(';', 'trait 方法声明');
    return { name: nameTok.val, params, ret, selfMut, span: this.spanFrom(start) };
  }

  // impl 块:impl Eq for Point { fn eq(self, other: Self) -> bool { ... } }
  // impl[T: Eq, U] Eq for Pair[T, U] { ... }
  parseImpl() {
    const start = this.expectKw('impl');
    const { names: tparams, bounds } = this.parseTParams();
    const traitTok = this.expectId('trait 名');
    this.expectKw('for');
    const typeTok = this.expectId('类型名');
    const typeArgs = [];
    if (this.atOp('[')) {
      this.next();
      while (!this.atOp(']')) {
        typeArgs.push(this.parseType());
        if (this.atOp(',')) { this.next(); continue; }
        break;
      }
      this.expectOp(']');
    }
    this.expectOp('{');
    const methods = [];
    while (!this.atOp('}')) {
      if (this.atKw('fn')) {
        const m = this.parseFn(false, true);
        methods.push(m);
      } else {
        this.bail('M2002', `impl 块内只能是方法声明 fn`, this.cur().span);
      }
    }
    this.expectOp('}');
    return { nt: 'ImplDecl', tparams, bounds, trait: traitTok.val, typeName: typeTok.val, typeArgs, methods, span: this.spanFrom(start) };
  }

  parseConst(pub) {
    const start = this.expectKw('const');
    const nameTok = this.expectId('常量名');
    let type = null;
    if (this.atOp(':')) { this.next(); type = this.parseType(); }
    this.expectOp('=', '常量名');
    const init = this.parseExpr();
    this.expectOp(';', 'const');
    return { nt: 'ConstDecl', name: nameTok.val, type, init, pub, span: this.spanFrom(start) };
  }

  parseTParams() {
    const names = [];
    const bounds = [];
    if (this.atOp('[')) {
      this.next();
      for (;;) {
        const nTok = this.expectId('类型参数名');
        names.push(nTok.val);
        if (this.atOp(':')) {
          this.next();
          const bTok = this.expectId('trait 名');
          bounds.push({ name: nTok.val, trait: bTok.val, span: nTok.span });
        }
        if (this.atOp(',')) { this.next(); continue; }
        break;
      }
      this.expectOp(']');
    }
    return { names, bounds };
  }

  parseFn(pub, asLocal = false) {
    const start = this.expectKw('fn');
    const nameTok = this.expectId('函数名');
    const { names: tparams, bounds } = this.parseTParams();
    this.expectOp('(');
    const params = [];
    const seen = new Set();
    while (!this.atOp(')')) {
      let pMut = false;
      if (this.atKw('mut')) { this.next(); pMut = true; }
      if (this.atKw('self')) {
        const sTok = this.next();
        if (params.length > 0) this.bail('M2006', 'self 必须是第一个参数', sTok.span);
        params.push({ name: 'self', self: true, mut: pMut, type: null, span: sTok.span });
        if (this.atOp(',')) { this.next(); continue; }
        break;
      }
      const pName = this.expectId('参数名');
      if (seen.has(pName.val)) this.fail('M2006', `重复的参数名 "${pName.val}"`, pName.span);
      seen.add(pName.val);
      this.expectOp(':', '参数名');
      const type = this.parseType();
      params.push({ name: pName.val, type, mut: pMut, span: this.spanFrom(pName) });
      if (this.atOp(',')) { this.next(); continue; }
      break;
    }
    this.expectOp(')');
    let ret = null;
    if (this.atOp('->')) { this.next(); ret = this.parseType(); }
    // 效果声明:with io, time(副作用必须显式声明)
    let effects = [];
    if (this.atKw('with')) {
      this.next();
      for (;;) {
        // v0.54:unsafe 是关键字也可作效果名(with unsafe);其余效果名保持标识符
        const eTok = this.atKw('unsafe') ? this.next() : this.expectId('效果名');
        effects.push({ name: eTok.val, span: eTok.span });
        if (this.atOp(',')) { this.next(); continue; }
        break;
      }
    }
    // 契约声明(v0.45):requires/ensures(可重复,后者覆盖;msg 为可选 else 字符串)
    let requires = null;
    let ensures = null;
    while (this.atKw('requires') || this.atKw('ensures')) {
      const kind = this.cur().val;
      const cStart = this.next();
      const expr = this.parseExpr();
      let msg = null;
      if (this.atKw('else')) {
        this.next();
        if (this.at('str')) {
          const t = this.next();
          // str token 可能是插值;这里只取字面量文本
          msg = (t.extra && t.extra.parts) ? null : t.val;
        } else {
          this.bail('M2002', '契约 else 后期望字符串字面量', this.cur().span);
        }
      }
      const c = { expr, msg, span: this.spanFrom(cStart) };
      if (kind === 'requires') requires = c; else ensures = c;
    }
    const body = this.parseBlock();
    return { nt: 'FnDecl', name: nameTok.val, nameSpan: nameTok.span, tparams, bounds, params, ret, effects, requires, ensures, body, pub, local: asLocal, span: this.spanFrom(start) };
  }

  parseStruct(pub) {
    const start = this.expectKw('struct');
    const nameTok = this.expectId('结构体名');
    const { names: tparams } = this.parseTParams();
    this.expectOp('{');
    const fields = [];
    const seen = new Set();
    const invariants = [];
    while (!this.atOp('}')) {
      if (this.atKw('invariant')) {
        const iStart = this.next();
        const expr = this.parseExpr();
        invariants.push({ expr, span: this.spanFrom(iStart) });
        if (this.atOp(',')) { this.next(); continue; }
        break;
      }
      const fTok = this.expectId('字段名');
      if (seen.has(fTok.val)) this.fail('M3009', `结构体 ${nameTok.val} 中重复的字段 "${fTok.val}"`, fTok.span);
      seen.add(fTok.val);
      this.expectOp(':', '字段名');
      const type = this.parseType();
      fields.push({ name: fTok.val, type, span: this.spanFrom(fTok) });
      if (this.atOp(',')) { this.next(); continue; }
      break;
    }
    this.expectOp('}');
    return { nt: 'StructDecl', name: nameTok.val, tparams, fields, invariants, pub, span: this.spanFrom(start) };
  }

  parseEnum(pub) {
    const start = this.expectKw('enum');
    const nameTok = this.expectId('枚举名');
    const { names: tparams } = this.parseTParams();
    this.expectOp('{');
    const variants = [];
    const seen = new Set();
    while (!this.atOp('}')) {
      const vTok = this.expectId('变体名');
      if (seen.has(vTok.val)) this.fail('M3009', `枚举 ${nameTok.val} 中重复的变体 "${vTok.val}"`, vTok.span);
      seen.add(vTok.val);
      const types = [];
      if (this.atOp('(')) {
        this.next();
        while (!this.atOp(')')) {
          types.push(this.parseType());
          if (this.atOp(',')) { this.next(); continue; }
          break;
        }
        this.expectOp(')');
      }
      variants.push({ name: vTok.val, types, span: vTok.span });
      if (this.atOp(',')) { this.next(); continue; }
      break;
    }
    this.expectOp('}');
    return { nt: 'EnumDecl', name: nameTok.val, tparams, variants, pub, span: this.spanFrom(start) };
  }

  parseUse() {
    const start = this.expectKw('use');
    const segs = [this.expectId('模块路径段').val];
    while (this.atOp('.')) { this.next(); segs.push(this.expectId('模块路径段').val); }
    let alias = null;
    if (this.atKw('as')) { this.next(); alias = this.expectId('模块别名').val; }
    this.expectOp(';');
    return { nt: 'UseDecl', segs, alias, span: this.spanFrom(start) };
  }

  parseTest() {
    const start = this.expectKw('test');
    const nameTok = this.expectId('测试名');
    const body = this.parseBlock();
    return { nt: 'TestDecl', name: nameTok.val, body, span: this.spanFrom(start) };
  }

  // ---- 语句 ----

  parseBlock() {
    const startTok = this.cur();
    if (!this.atOp('{')) {
      const hint = this.atOp('=') ? '条件比较要用 "==";单个 "=" 是赋值' : null;
      this.bail('M2002', `期望 "{"(块),实际是 ${tokDesc(this.cur())}`, this.cur().span, hint);
    }
    this.next();
    const start = startTok;
    const stmts = [];
    let tail = null;
    for (;;) {
      if (this.atOp('}')) { this.next(); break; }
      if (this.at('eof')) this.bail('M2002', '块未闭合(缺少 "}")', start.span);
      if (tail !== null) this.bail('M2001', '尾表达式(无分号的表达式)必须是块的最后一个元素', this.cur().span,
        '给它后面的语句补上前置的 ";",或把这个表达式移到块尾。');
      const mark = this.pos;
      try {
        const r = this.parseStmtOrTail();
        if (r && r.__tail) { tail = r.__tail; continue; }
        if (r) stmts.push(r);
      } catch (e) {
        if (e && e.mingParse) {
          this.diags.push(e.diag);
          this.recover(false);
          if (this.pos === mark) this.next();
          continue;
        }
        throw e;
      }
    }
    return { nt: 'Block', stmts, tail, span: this.spanFrom(start) };
  }

  // 返回 stmt 节点;'tail' 表示尾表达式(写入 this._tail)
  parseStmtOrTail() {
    const t = this.cur();

    if (t.kind === 'kw') {
      switch (t.val) {
        case 'let': return this.parseLet();
        case 'return': {
          this.next();
          let value = null;
          if (!this.atOp(';')) value = this.parseExpr();
          const sp = this.spanFrom(t);
          this.expectOp(';', 'return');
          return { nt: 'Return', value, span: sp };
        }
        case 'break': { this.next(); const sp = this.spanFrom(t); this.expectOp(';', 'break'); return { nt: 'Break', span: sp }; }
        case 'continue': { this.next(); const sp = this.spanFrom(t); this.expectOp(';', 'continue'); return { nt: 'Continue', span: sp }; }
        case 'while': return this.parseWhile();
        case 'for': return this.parseFor();
        case 'loop': {
          this.next();
          const body = this.parseBlock();
          return { nt: 'Loop', body, span: this.spanFrom(t) };
        }
        case 'unsafe': {
          // v0.54:unsafe { ... } 是块语句(不是表达式值;不做 unsafe(expr) 形态)
          this.next();
          const body = this.parseBlock();
          return { nt: 'UnsafeBlock', body, span: this.spanFrom(t) };
        }
        case 'fn': {
          const decl = this.parseFn(false, true);
          return { nt: 'FnStmt', decl, span: decl.span };
        }
        case 'if': case 'match': {
          const e = this.parseExpr();
          return this.finishExprStmt(e, t);
        }
      }
    }

    if (t.kind === 'id' && t.val === 'sync' && this.peek(1).kind === 'id' && this.peek(1).val === 'scope'
      && this.peek(2).kind === 'op' && this.peek(2).val === '{') {
      // sync scope { ... }:结构化并发作用域块(v0.17)——块内 spawn 的句柄在块退出时自动 join
      this.next(); this.next(); // sync scope
      const body = this.parseBlock();
      return { nt: 'SyncScopeBlock', body, span: this.spanFrom(t) };
    }

    if (t.kind === 'op' && t.val === '{') {
      const b = this.parseBlock();
      const e = { nt: 'BlockExpr', block: b, span: b.span };
      return this.finishExprStmt(e, t);
    }

    const e = this.parseExpr();
    // 赋值是语句,不是表达式:`x = 1;` `v[0] += 2;`
    const t2 = this.cur();
    if (t2.kind === 'op' && ASSIGN_OPS.has(t2.val)) {
      this.next();
      const value = this.parseExpr();
      const sp = this.spanFrom(t);
      this.expectOp(';', '赋值');
      return { nt: 'Assign', target: e, op: t2.val, value, span: sp };
    }
    return this.finishExprStmt(e, t);
  }

  finishExprStmt(e, startTok) {
    const span = this.spanFrom(startTok);
    if (this.atOp(';')) { this.next(); return { nt: 'ExprStmt', expr: e, semi: true, span }; }
    // 无分号:块尾 → 尾表达式;否则只有控制流/块表达式能作为语句
    if (this.atOp('}')) return { __tail: e };
    const ctrl = e.nt === 'If' || e.nt === 'Match' || e.nt === 'BlockExpr' || e.nt === 'Loop';
    if (ctrl) return { nt: 'ExprStmt', expr: e, semi: false, span };
    this.fail('M2002', `语句后缺少 ";"(当前是 ${tokDesc(this.cur())})`, this.cur().span,
      'Ming 要求每条语句以分号结束;只有块尾的最后一个表达式可以省略分号作为返回值。');
    this.recover(false);
    return { nt: 'ExprStmt', expr: e, semi: true, span };
  }

  parseLet() {
    const start = this.expectKw('let');
    let mutable = false;
    if (this.atKw('mut')) { this.next(); mutable = true; }
    const pat = this.parseLetPattern();
    let type = null;
    if (this.atOp(':')) { this.next(); type = this.parseType(); }
    let init = null;
    if (this.atOp('=')) { this.next(); init = this.parseExpr(); }
    this.expectOp(';', 'let');
    return { nt: 'Let', pat, mutable, type, init, span: this.spanFrom(start) };
  }

  parseWhile() {
    const start = this.expectKw('while');
    if (this.atKw('let')) {
      this.next();
      const pat = this.parsePattern();
      this.expectOp('=', 'while let 模式');
      this.noStructLit++;
      const expr = this.parseExpr();
      this.noStructLit--;
      const body = this.parseBlock();
      return { nt: 'WhileLet', pat, expr, body, span: this.spanFrom(start) };
    }
    this.noStructLit++;
    const cond = this.parseExpr();
    this.noStructLit--;
    const body = this.parseBlock();
    return { nt: 'While', cond, body, span: this.spanFrom(start) };
  }

  parseFor() {
    const start = this.expectKw('for');
    const pat = this.parsePattern();
    this.expectKw('in');
    this.noStructLit++;
    const iter = this.parseExpr();
    this.noStructLit--;
    const body = this.parseBlock();
    return { nt: 'For', pat, iter, body, span: this.spanFrom(start) };
  }

  // ---- 模式 ----

  parsePattern() {
    const t = this.cur();
    if (t.kind === 'op' && t.val === '_') { this.next(); return { nt: 'PWild', span: t.span }; }
    if (t.kind === 'op' && t.val === '(') {
      this.next();
      const pats = [];
      while (!this.atOp(')')) {
        pats.push(this.parsePattern());
        if (this.atOp(',')) { this.next(); continue; }
        break;
      }
      this.expectOp(')');
      return { nt: 'PTuple', pats, span: this.spanFrom(t) };
    }
    if (t.kind === 'op' && t.val === '-') {
      this.next();
      const lit = this.cur();
      if (lit.kind !== 'int') this.bail('M2003', `"-" 只能修饰整数字面量模式`, lit.span);
      this.next();
      return { nt: 'PLit', neg: true, lit, span: this.spanFrom(t) };
    }
    if (t.kind === 'int' || t.kind === 'str' || (t.kind === 'kw' && (t.val === 'true' || t.val === 'false'))) {
      this.next();
      return { nt: 'PLit', neg: false, lit: t, span: t.span };
    }
    if (t.kind === 'id') {
      this.next();
      if (this.atOp('.')) {
        const segs = [t.val];
        while (this.atOp('.')) { this.next(); segs.push(this.expectId('变体名').val); }
        if (segs.length !== 2) this.bail('M2003', `枚举模式必须是 "枚举名.变体名",收到 ${segs.length} 段路径`, t.span);
        const args = this.parsePatternArgs();
        return { nt: 'PEnum', enumName: segs[0], variant: segs[1], args, span: this.spanFrom(t) };
      }
      // 裸变体名(仅 prelude:Some/None/Ok/Err)
      if (['Some', 'None', 'Ok', 'Err'].includes(t.val)) {
        const args = this.parsePatternArgs();
        return { nt: 'PEnum', enumName: null, variant: t.val, args, span: this.spanFrom(t) };
      }
      if (this.atOp('(')) {
        this.bail('M2003', `"${t.val}(...)" 不是合法模式:裸变体名只支持 Some/None/Ok/Err;用户枚举要写 "枚举名.变体名(子模式)"`, t.span);
      }
      return { nt: 'PIdent', name: t.val, span: t.span };
    }
    this.bail('M2003', `无效的模式: ${tokDesc(t)}(支持:字面量、_、绑定名、(元组模式)、枚举名.变体名(子模式))`, t.span);
  }

  parsePatternArgs() {
    const args = [];
    if (this.atOp('(')) {
      this.next();
      while (!this.atOp(')')) {
        args.push(this.parsePattern());
        if (this.atOp(',')) { this.next(); continue; }
        break;
      }
      this.expectOp(')');
    }
    return args;
  }

  parseLetPattern() {
    const t = this.cur();
    if (t.kind === 'id') { this.next(); return { nt: 'PIdent', name: t.val, span: t.span }; }
    if (t.kind === 'op' && t.val === '_') { this.next(); return { nt: 'PWild', span: t.span }; }
    if (t.kind === 'op' && t.val === '(') {
      const p = this.parsePattern();
      return p;
    }
    this.bail('M2003', `let 绑定只支持 名字 / _ / (元组模式),实际是 ${tokDesc(t)}`, t.span,
      '可反驳的模式(如枚举解构)请用 match 或 while let。');
  }

  // ---- 类型 ----

  parseType() {
    const t = this.cur();
    let base = null;
    let wasParen = false;
    // v0.54:Ptr[mut u8] 的可写性标记;解析器只负责语法,合法性由检查器判定
    // (TMut 出现在 Ptr 之外 → resolveTypeAst 报 M3002)
    if (t.kind === 'kw' && t.val === 'mut') {
      this.next();
      const inner = this.parseType();
      return { nt: 'TMut', type: inner, span: t.span };
    }
    if (t.kind === 'kw' && t.val === 'self') {
      this.next();
      if (this.atOp('[')) this.bail('M2002', 'Self 不带类型参数', this.cur().span);
      base = { nt: 'TName', name: 'Self', args: [], span: t.span };
    } else if (t.kind === 'id') {
      this.next();
      // 类型路径:geom.Point / utils.math.Vec2
      let name = t.val;
      while (this.atOp('.')) {
        this.next();
        name += '.' + this.expectId('类型路径段').val;
      }
      const args = [];
      if (this.atOp('[')) {
        this.next();
        while (!this.atOp(']')) {
          args.push(this.parseType());
          if (this.atOp(',')) { this.next(); continue; }
          break;
        }
        this.expectOp(']');
      }
      base = { nt: 'TName', name, args, span: t.span };
    } else if (t.kind === 'op' && t.val === '(') {
      this.next();
      const ts = [];
      while (!this.atOp(')')) {
        ts.push(this.parseType());
        if (this.atOp(',')) { this.next(); continue; }
        break;
      }
      this.expectOp(')');
      if (ts.length === 1) { base = ts[0]; } else { base = { nt: 'TTuple', ts, span: t.span }; }
      wasParen = true;
    } else {
      this.bail('M2002', `期望类型,实际是 ${tokDesc(t)}`, t.span);
    }
    if (this.atOp('->')) {
      if (!wasParen) this.bail('M2002', '函数类型必须写成 "(参数类型) -> 返回类型"', this.cur().span);
      this.next();
      const ret = this.parseType();
      return { nt: 'TFn', ps: base.nt === 'TTuple' ? base.ts : [base], ret, span: t.span };
    }
    return base;
  }

  // ---- 表达式(优先级从低到高)----
  // range < || < && < | < ^ < & < ==/!= < 关系 < 移位 < +- < */% < as < 一元 < 后缀

  parseExpr() { return this.parseRange(); }

  parseRange() {
    const l = this.parseOr();
    if (this.atOp('..')) {
      const op = this.next();
      const r = this.parseOr();
      if (this.atOp('..')) this.bail('M2001', '区间是非结合的,不能写 a..b..c', this.cur().span);
      return { nt: 'Range', lo: l, hi: r, span: this.spanFrom(op) };
    }
    return l;
  }

  parseBinLevel(ops, sub, chainError = null) {
    let l = sub.call(this);
    for (;;) {
      const t = this.cur();
      if (t.kind === 'op' && ops.includes(t.val)) {
        // v0.39 修复:链式比较检查此前是 l.nt === 'Binary'(任何二元运算),
        // 把 "a + b <= c" 这类合法的算术左操作数也误报;只拦同级比较链
        if (chainError && l.nt === 'Binary' && ops.includes(l.op)) {
          this.fail('M2005', `比较运算符不能连续使用(如 a ${l.op} b ${t.val} c)`, this.spanFrom(t),
            `用 && 显式连接:${chainError.replace('%s', `${l.op} ${t.val}`)}`);
        }
        this.next();
        const r = sub.call(this);
        l = { nt: 'Binary', op: t.val, l, r, span: this.spanFrom(t) };
        continue;
      }
      return l;
    }
  }

  parseOr() { return this.parseBinLevel(['||'], this.parseAnd); }
  parseAnd() { return this.parseBinLevel(['&&'], this.parseBitOr); }
  parseBitOr() { return this.parseBinLevel(['|'], this.parseBitXor); }
  parseBitXor() { return this.parseBinLevel(['^'], this.parseBitAnd); }
  parseBitAnd() { return this.parseBinLevel(['&'], this.parseEquality); }
  parseEquality() { return this.parseBinLevel(['==', '!='], this.parseRel); }
  parseRel() { return this.parseBinLevel(['<', '>', '<=', '>='], this.parseShift, 'a %s b'); }
  parseShift() { return this.parseBinLevel(['<<', '>>'], this.parseAdd); }
  parseAdd() { return this.parseBinLevel(['+', '-'], this.parseMul); }
  parseMul() { return this.parseBinLevel(['*', '/', '%'], this.parseAs); }

  parseAs() {
    let e = this.parseUnary();
    while (this.atKw('as')) {
      const kw = this.next();
      const type = this.parseType();
      e = { nt: 'As', expr: e, type, span: this.spanFrom(kw) };
    }
    return e;
  }

  parseUnary() {
    const t = this.cur();
    if (t.kind === 'op' && (t.val === '-' || t.val === '!')) {
      this.next();
      const e = this.parseUnary();
      return { nt: 'Unary', op: t.val, expr: e, span: this.spanFrom(t) };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.cur();
      if (t.kind === 'op' && t.val === '(') {
        this.next();
        const args = [];
        while (!this.atOp(')')) {
          args.push(this.parseExpr());
          if (this.atOp(',')) { this.next(); continue; }
          break;
        }
        this.expectOp(')');
        e = { nt: 'Call', callee: e, args, span: this.spanFrom(t) };
        continue;
      }
      if (t.kind === 'op' && t.val === '[') {
        this.next();
        const idx = this.parseExpr();
        this.expectOp(']');
        e = { nt: 'Index', base: e, index: idx, span: this.spanFrom(t) };
        continue;
      }
      if (t.kind === 'op' && t.val === '?') {
        this.next();
        e = { nt: 'PostQ', expr: e, span: this.spanFrom(t) };
        continue;
      }
      if (t.kind === 'op' && t.val === '.') {
        this.next();
        const nameTok = this.expectId('字段或方法名');
        // 类型名后跟 `{` → 结构体字面量(路径形式 geom.Point { ... })
        if (this.atOp('{') && this.noStructLit === 0) {
          const path = collectPath(e);
          if (path === null) {
            this.bail('M2001', `"{" 不能跟在字段访问之后;结构体字面量只能跟在类型名后`, this.cur().span);
          }
          path.push(nameTok.val);
          e = this.parseStructLitFrom(path, t);
          continue;
        }
        e = { nt: 'Field', base: e, name: nameTok.val, nameSpan: nameTok.span, span: this.spanFrom(t) };
        continue;
      }
      return e;
    }
  }

  parseStructLitFrom(path, startTok) {
    this.expectOp('{');
    const fields = [];
    const seen = new Set();
    while (!this.atOp('}')) {
      const fTok = this.expectId('字段名');
      if (seen.has(fTok.val)) this.fail('M3009', `重复的字段 "${fTok.val}"`, fTok.span);
      seen.add(fTok.val);
      this.expectOp(':', '字段名');
      const value = this.parseExpr();
      fields.push({ name: fTok.val, value, span: fTok.span });
      if (this.atOp(',')) { this.next(); continue; }
      break;
    }
    this.expectOp('}');
    return { nt: 'StructLit', path, fields, span: this.spanFrom(startTok) };
  }

  parsePrimary() {
    const t = this.cur();

    // self:方法体内引用接收者(检查器保证只在方法里可用)
    if (t.kind === 'kw' && t.val === 'self') {
      this.next();
      return { nt: 'Ident', name: 'self', span: t.span };
    }
    if (t.kind === 'int') { this.next(); return { nt: 'IntLit', v: BigInt(t.val), bits: t.extra.bits, signed: t.extra.signed, suffix: t.extra.suffix, span: t.span }; }
    if (t.kind === 'float') { this.next(); return { nt: 'FloatLit', v: t.val, bits: t.extra.bits, suffix: t.extra.suffix, span: t.span }; }
    if (t.kind === 'str') {
      this.next();
      if (t.val !== null) return { nt: 'StrLit', parts: [{ lit: t.val }], span: t.span };
      const parts = t.extra.parts.map(p => 'lit' in p
        ? { lit: p.lit }
        : { expr: new Parser(p.tokens, this.file).parseInterpExpr() });
      return { nt: 'StrLit', parts, span: t.span };
    }
    if (t.kind === 'kw' && t.val === 'true') { this.next(); return { nt: 'BoolLit', v: true, span: t.span }; }
    if (t.kind === 'kw' && t.val === 'false') { this.next(); return { nt: 'BoolLit', v: false, span: t.span }; }
    if (t.kind === 'kw' && t.val === 'if') return this.parseIf();
    if (t.kind === 'kw' && t.val === 'match') return this.parseMatch();
    if (t.kind === 'kw' && t.val === 'loop') {
      this.next();
      const body = this.parseBlock();
      return { nt: 'LoopExpr', body, span: this.spanFrom(t) };
    }
    if (t.kind === 'id') {
      this.next();
      if (this.atOp('{') && this.noStructLit === 0) {
        return this.parseStructLitFrom([t.val], t);
      }
      return { nt: 'Ident', name: t.val, span: t.span };
    }
    if (t.kind === 'op' && t.val === '(') return this.parseParenOrLambda();
    if (t.kind === 'op' && t.val === '[') {
      this.next();
      // [:] → 空 Map 字面量(显式的空 map 写法)
      if (this.atOp(':')) {
        this.next();
        this.expectOp(']');
        return { nt: 'MapLit', entries: [], span: this.spanFrom(t) };
      }
      const elems = [];
      while (!this.atOp(']')) {
        elems.push(this.parseExpr());
        if (this.atOp(',')) { this.next(); continue; }
        break;
      }
      this.expectOp(']');
      return { nt: 'VecLit', elems, span: this.spanFrom(t) };
    }
    if (t.kind === 'op' && t.val === '{') {
      if (this.noStructLit > 0) this.bail('M2001', '这里的 "{" 是块,不能作为表达式使用', t.span);
      return this.parseMapLit();
    }
    this.bail('M2001', `无法解析的表达式: ${tokDesc(t)}`, t.span);
  }

  parseInterpExpr() {
    const e = this.parseExpr();
    if (!this.at('eof')) this.bail('M2001', `插值表达式后有多余内容 ${tokDesc(this.cur())}`, this.cur().span);
    return e;
  }

  parseParenOrLambda() {
    const open = this.cur();
    // 尝试 lambda:(x) / (x: T, y) / () 后跟 =>
    const mark = this.mark();
    this.next(); // 消费 '('
    if (this.atOp(')')) {
      this.next();
      if (this.atOp('=>')) {
        this.next();
        const body = this.parseLambdaBody();
        return { nt: 'Lambda', params: [], body, span: this.spanFrom(open) };
      }
      return { nt: 'TupleLit', elems: [], span: this.spanFrom(open) }; // ()
    }
    const params = [];
    let ok = true;
    const seen = new Set();
    while (!this.atOp(')')) {
      if (!this.at('id')) { ok = false; break; }
      const nTok = this.next();
      if (seen.has(nTok.val)) { ok = false; break; }
      seen.add(nTok.val);
      let type = null;
      if (this.atOp(':')) { this.next(); try { type = this.parseType(); } catch { ok = false; break; } }
      params.push({ name: nTok.val, type, span: nTok.span });
      if (this.atOp(',')) { this.next(); continue; }
      break;
    }
    if (ok && this.atOp(')')) {
      this.next();
      if (this.atOp('=>')) {
        this.next();
        const body = this.parseLambdaBody();
        return { nt: 'Lambda', params, body, span: this.spanFrom(open) };
      }
    }
    // 不是 lambda → 回溯,按普通括号表达式/元组解析
    this.resetTo(mark);
    this.next(); // (
    const elems = [];
    while (!this.atOp(')')) {
      elems.push(this.parseExpr());
      if (this.atOp(',')) { this.next(); continue; }
      break;
    }
    this.expectOp(')');
    if (elems.length === 1) return elems[0];
    return { nt: 'TupleLit', elems, span: this.spanFrom(open) };
  }

  parseLambdaBody() {
    if (this.atOp('{')) {
      const b = this.parseBlock();
      return { nt: 'BlockExpr', block: b, span: b.span };
    }
    return this.parseExpr();
  }

  parseIf() {
    const start = this.expectKw('if');
    this.noStructLit++;
    const cond = this.parseExpr();
    this.noStructLit--;
    const then = this.parseBlock();
    let els = null;
    if (this.atKw('else')) {
      this.next();
      if (this.atKw('if')) els = this.parseIf();
      else els = this.parseBlock();
    }
    return { nt: 'If', cond, then, els, span: this.spanFrom(start) };
  }

  parseMatch() {
    const start = this.expectKw('match');
    this.noStructLit++;
    const scrutinee = this.parseExpr();
    this.noStructLit--;
    this.expectOp('{');
    const arms = [];
    while (!this.atOp('}')) {
      if (this.at('eof')) this.bail('M2002', 'match 未闭合(缺少 "}")', start.span);
      const pat = this.parsePattern();
      let guard = null;
      if (this.atKw('if')) { this.next(); guard = this.parseExpr(); }
      this.expectOp('=>', 'match 模式');
      let expr;
      if (this.atOp('{')) {
        const b = this.parseBlock();
        expr = { nt: 'BlockExpr', block: b, span: b.span };
      } else {
        expr = this.parseExpr();
      }
      const armSpan = { file: this.file, line: pat.span.line, col: pat.span.col, endLine: expr.span.endLine, endCol: expr.span.endCol };
      arms.push({ pat, guard, expr, span: armSpan });
      if (this.atOp(',')) { this.next(); continue; }
      if (this.atOp('}')) break;
      // 非 block 分支必须有逗号
      if (expr.nt !== 'BlockExpr') {
        this.bail('M2002', `match 分支之间需要 ","(分支 "${patternBrief(pat)}" 之后)`, this.cur().span);
      }
    }
    this.expectOp('}');
    return { nt: 'Match', scrutinee, arms, span: this.spanFrom(start) };
  }

  parseMapLit() {
    const start = this.expectOp('{');
    const entries = [];
    while (!this.atOp('}')) {
      const k = this.parseExpr();
      this.expectOp(':', 'map 键');
      const v = this.parseExpr();
      entries.push({ k, v, span: k.span });
      if (this.atOp(',')) { this.next(); continue; }
      break;
    }
    this.expectOp('}');
    return { nt: 'MapLit', entries, span: this.spanFrom(start) };
  }
}

function collectPath(e) {
  if (e.nt === 'Ident') return [e.name];
  if (e.nt === 'Field' && e.base) {
    const p = collectPath(e.base);
    if (p) return [...p, e.name];
  }
  return null;
}

export function patternBrief(pat) {
  switch (pat.nt) {
    case 'PWild': return '_';
    case 'PIdent': return pat.name;
    case 'PLit': return (pat.neg ? '-' : '') + (pat.lit.kind === 'str' ? `"${pat.lit.val}"` : pat.lit.val);
    case 'PTuple': return `(${pat.pats.map(patternBrief).join(', ')})`;
    case 'PEnum': return `${pat.enumName ? pat.enumName + '.' : ''}${pat.variant}(${pat.args.map(patternBrief).join(', ')})`;
    default: return '?';
  }
}

export function tokDesc(t) {
  if (t.kind === 'eof') return '文件结尾';
  if (t.kind === 'str') return '字符串字面量';
  if (t.kind === 'id') return `标识符 "${t.val}"`;
  if (t.kind === 'int') return `整数 ${t.val}`;
  if (t.kind === 'float') return `浮点数 ${t.val}`;
  return `"${t.val}"`;
}

void Token;
