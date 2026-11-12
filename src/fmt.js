// fmt.js — Ming 规范格式化器。
// 原则:全语言只有一种风格(4 空格缩进、;与 {} 显式、运算符两侧空格)。
// 注释通过"瀑布"策略保留:位于节点之前的注释按原相对行位输出。

const IND = '  '; // 两级结构:每层 = 4 空格 = IND+IND?这里 IND 定义为 4 空格
const INDENT = '    ';

// v0.56(A3):格式化器遇到无法无损表达的 AST 时必须失败,不得输出占位符删代码。
// cmdFmt 捕获后按 file:line:col 打印错误、退出 1,并保证不落盘。
export class FmtError extends Error {
  constructor(message, span = null) {
    super(message);
    this.name = 'FmtError';
    this.span = span;
  }
}

export function formatProgram(items, comments) {
  const w = new Writer(comments ?? []);
  let first = true;
  for (const item of items) {
    if (!first) w.blank();
    first = false;
    w.item(item);
  }
  w.flushTail();
  return w.out.join('\n') + '\n';
}

class Writer {
  constructor(comments) {
    this.out = [];
    this.comments = comments.slice().sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col);
    this.ci = 0;
    this.lastLine = 0; // 最近输出内容所在源行(用于同行尾注释)
    this.lastEndLine = 0; // 最近输出的源结束行(用于保留空行)
    this.indent = 0;
  }

  line(s, srcLine = null) {
    this.flushComments(srcLine, false);
    this.out.push(INDENT.repeat(this.indent) + s);
    if (srcLine) { this.lastLine = srcLine; this.lastEndLine = Math.max(this.lastEndLine, srcLine); }
  }

  // 若源码中两段之间有空行,则保留一个空行。
  // v0.51.6 修复(plan #20):行尾注释经"瀑布"冲刷成独立行后,在第二遍里
  // 占用一行源码,把其后语句的源行号往后推——第一遍按原行距判"不留空行"、
  // 第二遍按新行距判"留空行",导致部分文件需 fmt 两遍才定点。这里向前看:
  // 凡本语句之前还将冲刷成独立行的注释,与"行距 ≥ 2"同等触发空行保留,
  // 使第一遍即得到第二遍的判定结果(一次到位)。
  preserveBlank(beforeLine) {
    if (this.lastEndLine === 0) return;
    if (beforeLine - this.lastEndLine >= 2) { this.blank(); return; }
    // 注释已按行号排序:首个待冲刷注释是否落在本语句之前,首元素即可判定
    if (this.ci < this.comments.length && this.comments[this.ci].span.line <= beforeLine) {
      this.blank();
      return;
    }
  }

  noteEnd(endLine) { this.lastEndLine = Math.max(this.lastEndLine, endLine); }

  blank() { this.out.push(''); }

  // 输出某节点前,先冲刷其位置之前的注释
  flushComments(before, inline) {
    while (this.ci < this.comments.length) {
      const c = this.comments[this.ci];
      if (c.span.line > before) break;
      this.ci++;
      this.emitComment(c, before);
    }
  }

  emitComment(c, before) {
    const sameLine = c.span.line === this.lastLine && this.out.length > 0;
    if (sameLine && !c.text.startsWith('#')) {
      // 同行尾注释:附加到最后输出行
      this.out[this.out.length - 1] += '  ' + (c.doc ? '/// ' : '// ') + c.text.trim();
      return;
    }
    // 独立行注释(保持缩进;规范化为恰好一个空格;空注释不带尾随空格)
    const prefix = c.doc ? '///' : '//';
    const text = c.text.replace(/^ /, '');
    const lines = text.split('\n');
    for (const ln of lines) {
      const body = ln.trimEnd();
      this.out.push(INDENT.repeat(this.indent) + (body ? prefix + ' ' + body : prefix));
    }
    void before;
  }

  flushTail() {
    while (this.ci < this.comments.length) {
      const c = this.comments[this.ci++];
      this.emitComment(c, Infinity);
    }
  }

  // ---------- items ----------
  item(it) {
    this.flushComments(it.span.line, false);
    switch (it.nt) {
      case 'FnDecl': return this.fn(it);
      case 'StructDecl': return this.struct(it);
      case 'EnumDecl': return this.enumDecl(it);
      case 'UseDecl': return this.use(it);
      case 'TestDecl': return this.test(it);
      case 'ConstDecl': return this.constDecl(it);
      case 'TraitDecl': return this.traitDecl(it);
      case 'ImplDecl': return this.implDecl(it);
      default: return;
    }
  }

  docs(it) {
    for (const d of it.docs ?? []) this.line('/// ' + d, it.span.line);
  }

  fn(it) {
    this.docs(it);
    const pub = it.pub ? 'pub ' : '';
    const tps = it.tparams?.length ? '[' + it.tparams.map(n => {
      const b = it.bounds?.find(x => x.name === n);
      return b ? `${n}: ${b.trait}` : n;
    }).join(', ') + ']' : '';
    const params = it.params.map(p => p.self ? (p.mut ? 'mut self' : 'self') : (p.mut ? 'mut ' : '') + p.name + ': ' + typeAst(p.type)).join(', ');
    const ret = it.ret ? ' -> ' + typeAst(it.ret) : '';
    const eff = it.effects?.length ? ' with ' + it.effects.map(e => e.name).join(', ') : '';
    // v0.56(#36):契约保真——requires/ensures 此前被 fmt 静默丢弃(语义数据丢失)。
    const ctr = contractSuffix(it);
    // v0.56(#36):签名可能因契约多行;尾行取函数体 `{` 所在行,避免块首被误判为
    // "源码空行"而多出一个空行(单行签名与旧行为逐字一致)。
    this.line(`${pub}fn ${it.name}${tps}(${params})${ret}${eff}${ctr} {`, it.body?.span?.line ?? it.span.line);
    this.indent++;
    this.blockBody(it.body);
    this.indent--;
    this.line('}');
  }

  traitDecl(it) {
    this.docs(it);
    const pub = it.pub ? 'pub ' : '';
    this.line(`${pub}trait ${it.name} {`, it.span.line);
    this.indent++;
    for (const m of it.methods) {
      const params = m.params.map(p => p.self ? (p.mut ? 'mut self' : 'self') : p.name + ': ' + typeAst(p.type)).join(', ');
      const ret = m.ret ? ' -> ' + typeAst(m.ret) : '';
      this.line(`fn ${m.name}(${params})${ret};`, m.span.line);
    }
    this.indent--;
    this.line('}');
  }

  implDecl(it) {
    const tps = it.tparams?.length
      ? '[' + it.tparams.map(n => {
        const b = it.bounds?.find(x => x.name === n);
        return b ? `${n}: ${b.trait}` : n;
      }).join(', ') + ']'
      : '';
    const targs = it.typeArgs.length ? '[' + it.typeArgs.map(typeAst).join(', ') + ']' : '';
    this.line(`impl${tps} ${it.trait} for ${it.typeName}${targs} {`, it.span.line);
    this.indent++;
    for (const m of it.methods) this.fn(m);
    this.indent--;
    this.line('}');
  }

  constDecl(it) {
    this.docs(it);
    const pub = it.pub ? 'pub ' : '';
    const t = it.type ? ': ' + typeAst(it.type) : '';
    this.line(`${pub}const ${it.name}${t} = ${expr(it.init)};`, it.span.line);
  }

  test(it) {
    this.docs(it);
    this.line(`test ${it.name} {`, it.span.line);
    this.indent++;
    this.blockBody(it.body);
    this.indent--;
    this.line('}');
  }

  struct(it) {
    this.docs(it);
    const pub = it.pub ? 'pub ' : '';
    const tps = it.tparams.length ? '[' + it.tparams.join(', ') + ']' : '';
    const invs = it.invariants ?? [];
    if (it.fields.length === 0 && invs.length === 0) { this.line(`${pub}struct ${it.name}${tps} {}`); return; }
    this.line(`${pub}struct ${it.name}${tps} {`, it.span.line);
    this.indent++;
    // v0.56(#36):invariant 此前被 fmt 静默丢弃(数据丢失)。字段与 invariant 按源顺序
    // 各占一行输出,逗号规范与字段一致(尾随逗号 parser 接受,保证一次到定点)。
    const members = it.fields.map(f => ({ inv: false, node: f }))
      .concat(invs.map(v => ({ inv: true, node: v })))
      .sort((a, b) => a.node.span.line - b.node.span.line || a.node.span.col - b.node.span.col);
    for (const m of members) {
      const n = m.node;
      this.flushComments(n.span.line, false);
      this.line(m.inv ? `invariant ${expr(n.expr)},` : `${n.name}: ${typeAst(n.type)},`, n.span.line);
    }
    this.indent--;
    this.line('}');
  }

  enumDecl(it) {
    this.docs(it);
    const pub = it.pub ? 'pub ' : '';
    const tps = it.tparams.length ? '[' + it.tparams.join(', ') + ']' : '';
    if (it.variants.length === 0) { this.line(`${pub}enum ${it.name}${tps} {}`); return; }
    this.line(`${pub}enum ${it.name}${tps} {`, it.span.line);
    this.indent++;
    for (const v of it.variants) {
      this.flushComments(v.span.line, false);
      const ts = v.types.length ? '(' + v.types.map(typeAst).join(', ') + ')' : '';
      this.line(`${v.name}${ts},`, v.span.line);
    }
    this.indent--;
    this.line('}');
  }

  use(it) {
    this.docs(it);
    const alias = it.alias ? ` as ${it.alias}` : '';
    this.line(`use ${it.segs.join('.')}${alias};`, it.span.line);
  }

  // ---------- 块与语句 ----------
  blockBody(block) {
    this.flushComments(block.span.line, false);
    let prevEnd = block.span.line;
    for (const s of block.stmts) {
      this.preserveBlank(s.span.line);
      this.stmt(s, false);
      this.noteEnd(s.span.endLine);
      prevEnd = s.span.endLine;
    }
    if (block.tail) {
      this.preserveBlank(block.tail.span.line);
      this.stmt({ nt: 'ExprStmt', expr: block.tail, semi: false, span: block.tail.span }, true);
      this.noteEnd(block.tail.span.endLine);
    }
  }

  stmt(s, isTail) {
    this.flushComments(s.span.line, false);
    switch (s.nt) {
      case 'Let': {
        const pat = patAst(s.pat);
        const mut = s.mutable ? 'mut ' : '';
        const t = s.type ? ': ' + typeAst(s.type) : '';
        this.line(`let ${mut}${pat}${t} = ${expr(s.init)};`, s.span.line);
        return;
      }
      case 'Return':
        this.line(s.value ? `return ${expr(s.value)};` : 'return;', s.span.line);
        return;
      case 'Break': this.line('break;', s.span.line); return;
      case 'Continue': this.line('continue;', s.span.line); return;
      case 'While':
        this.line(`while ${expr(s.cond)} {`, s.span.line);
        this.indent++; this.blockBody(s.body); this.indent--;
        this.line('}');
        return;
      case 'WhileLet':
        this.line(`while let ${patAst(s.pat)} = ${expr(s.expr)} {`, s.span.line);
        this.indent++; this.blockBody(s.body); this.indent--;
        this.line('}');
        return;
      case 'For':
        this.line(`for ${patAst(s.pat)} in ${expr(s.iter)} {`, s.span.line);
        this.indent++; this.blockBody(s.body); this.indent--;
        this.line('}');
        return;
      case 'Loop':
        this.line('loop {', s.span.line);
        this.indent++; this.blockBody(s.body); this.indent--;
        this.line('}');
        return;
      case 'SyncScopeBlock':
        this.line('sync scope {', s.span.line);
        this.indent++; this.blockBody(s.body); this.indent--;
        this.line('}');
        return;
      case 'UnsafeBlock': // v0.54
        this.line('unsafe {', s.span.line);
        this.indent++; this.blockBody(s.body); this.indent--;
        this.line('}');
        return;
      case 'ExprStmt': {
        // 控制流表达式作为语句:match/块 后接 ";"(保留原样);尾表达式无 ";"
        if (s.expr.nt === 'If') { this.ifStmt(s.expr); return; }
        if (s.expr.nt === 'Match') { this.matchExpr(s.expr, isTail ? '' : (s.semi ? ';' : '')); return; }
        if (s.expr.nt === 'BlockExpr') { this.blockExpr(s.expr); return; }
        this.line(expr(s.expr) + (s.semi ? ';' : ''), s.span.line);
        return;
      }
      case 'Assign':
        this.line(`${expr(s.target)} ${s.op} ${expr(s.value)};`, s.span.line);
        return;
      case 'FnStmt':
        this.item(s.decl);
        return;
      default:
        this.line('// ? ' + s.nt);
    }
  }

  ifStmt(e) {
    this.line(`if ${expr(e.cond)} {`, e.span.line);
    this.indent++; this.blockBody(e.then); this.indent--;
    // v0.51.6 修复:else-if 链此前输出悬挂的 "} else " 后另起一行 if(非幂等且难看),
    // 现把 "else if 头" 整体并回上一行
    let els = e.els;
    while (els) {
      if (els.nt === 'If') {
        this.lineEnd(`} else if ${expr(els.cond)} {`);
        this.indent++;
        // v0.56(#22):else/else-if 头行尾注释按块首独立注释规范输出(一遍到定点)
        this.elseHeaderComment(els.span?.line);
        this.blockBody(els.then); this.indent--;
        els = els.els;
      } else {
        this.lineEnd('} else {');
        this.indent++;
        this.elseHeaderComment(els.span?.line);
        this.blockBody(els); this.indent--;
        els = null;
      }
    }
    this.line('}');
  }

  // v0.56(#22):`} else { // 注释` 形态。HEAD 第一遍把注释冲成 else 块首独立行时,
  // 空行落在注释之后、语句之前;第二遍才把空行移到注释之前(注释占行使源行距从 1 变 2,
  // preserveBlank 翻转)。这里在输出 else 头后直接把该行尾注释按"块首注释"的规范形态
  // 输出:头行 → 空行 → 注释 → 语句(不空行),第一遍即得到 HEAD 两遍后的定点。
  // 无头行注释时零动作(既有 else 输出逐字不变)。
  elseHeaderComment(headerLine) {
    if (headerLine == null || this.ci >= this.comments.length) return;
    const c = this.comments[this.ci];
    if (c.span.line !== headerLine) return;
    this.blank();
    this.flushComments(headerLine, false);
    // 注释已被消费;把结束行推进到 else 头行,下一语句不再被 preserveBlank 判为跨两行
    this.lastEndLine = Math.max(this.lastEndLine, headerLine);
  }

  // 不换行地接在上一行(else 链)
  lineEnd(s) {
    const last = this.out.pop();
    this.out.push(last + s);
  }

  blockExpr(e) {
    this.lineEnd('{');
    this.indent++;
    this.blockBody(e.block);
    this.indent--;
    this.line('}');
  }

  matchExpr(e, suffix) {
    this.line(`match ${expr(e.scrutinee)} {`, e.span.line);
    this.indent++;
    for (const arm of e.arms) {
      this.flushComments(arm.span.line, false);
      const g = arm.guard ? ` if ${expr(arm.guard)}` : '';
      if (arm.expr.nt === 'BlockExpr') {
        this.line(`${patAst(arm.pat)}${g} => {`, arm.span.line);
        this.indent++; this.blockBody(arm.expr.block); this.indent--;
        this.line('},');
      } else {
        this.line(`${patAst(arm.pat)}${g} => ${expr(arm.expr)},`, arm.span.line);
      }
    }
    this.indent--;
    this.line('}' + suffix);
  }
}

// ---------- 类型 / 模式 ----------
export function typeAst(t) {
  switch (t.nt) {
    case 'TName': {
      const args = t.args.length ? '[' + t.args.map(typeAst).join(', ') + ']' : '';
      return t.name + args;
    }
    case 'TTuple': return `(${t.ts.map(typeAst).join(', ')})`;
    case 'TFn': return `(${t.ps.map(typeAst).join(', ')}) -> ${typeAst(t.ret)}`;
    case 'TMut': return 'mut ' + typeAst(t.type); // v0.54:Ptr[mut u8]
    default: return '?';
  }
}

export function patAst(p) {
  switch (p.nt) {
    case 'PWild': return '_';
    case 'PIdent': return p.name;
    case 'PLit': {
      const v = p.lit.kind === 'str' ? JSON.stringify(p.lit.val) : p.lit.val;
      return (p.neg ? '-' : '') + v;
    }
    case 'PTuple': return `(${p.pats.map(patAst).join(', ')})`;
    case 'PEnum': {
      const name = p.enumName ? p.enumName + '.' : '';
      return `${name}${p.variant}${p.args.length ? '(' + p.args.map(patAst).join(', ') + ')' : ''}`;
    }
    default: return '_';
  }
}

// ---------- 表达式(带最小括号)----------
// 优先级表(数值越大绑定越紧)
const PREC = {
  '..': 1,
  '||': 2,
  '&&': 3,
  '|': 4, '^': 5, '&': 6,
  '==': 7, '!=': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8,
  '<<': 9, '>>': 9,
  '+': 10, '-': 10,
  '*': 11, '/': 11, '%': 11,
  as: 12,
  unary: 13,
  postfix: 14,
};

export function expr(e, minPrec = 0) {
  switch (e.nt) {
    case 'IntLit': return e.v.toString() + (e.suffix ?? '');
    case 'FloatLit': {
      let s = String(e.v);
      if (!/[.eE]/.test(s) && !e.suffix) s += '.0';
      return s + (e.suffix ?? '');
    }
    case 'StrLit': return strLit(e);
    case 'BoolLit': return e.v ? 'true' : 'false';
    case 'Ident': return e.name;
    case 'TupleLit': return e.elems.length ? `(${e.elems.map(x => expr(x)).join(', ')})` : '()';
    case 'VecLit': return `[${e.elems.map(x => expr(x)).join(', ')}]`;
    case 'MapLit': {
      if (e.entries.length === 0) return '{}';
      return `{ ${e.entries.map(en => `${expr(en.k)}: ${expr(en.v)}`).join(', ')} }`;
    }
    case 'Field': return `${expr(e.base, PREC.postfix)}.${e.name}`;
    case 'Index': return `${expr(e.base, PREC.postfix)}[${expr(e.index)}]`;
    case 'PostQ': return `${expr(e.expr, PREC.postfix)}?`;
    case 'Call': return `${expr(e.callee, PREC.postfix)}(${e.args.map(a => expr(a)).join(', ')})`;
    case 'Unary': return `${e.op}${expr(e.expr, PREC.unary)}`;
    case 'As': return wrap(e, PREC.as, minPrec, `${expr(e.expr, PREC.as + 1)} as ${typeAst(e.type)}`);
    case 'Binary': {
      const p = PREC[e.op] ?? 10;
      const left = expr(e.l, p);
      const right = expr(e.r, p + 1); // 左结合
      return wrap(e, p, minPrec, `${left} ${e.op} ${right}`);
    }
    case 'Range': return wrap(e, PREC['..'], minPrec, `${expr(e.lo, PREC['..'] + 1)}..${expr(e.hi, PREC['..'] + 1)}`);
    case 'Lambda': {
      const ps = e.params.map(p => p.type ? `${p.name}: ${typeAst(p.type)}` : p.name).join(', ');
      const body = e.body.nt === 'BlockExpr' ? blockInline(e.body) : expr(e.body);
      // v0.56(A3):lambda 优先级最低;作为后缀调用 callee 等 minPrec>0 的位置必须加括号。
      // 修复前 `((x: i64) => x + 1)(0)` 被输出为 `(x: i64) => x + 1(0)`(合法变非法)。
      return wrap(e, 0, minPrec, `(${ps}) => ${body}`);
    }
    case 'If': {
      // v0.51.6 修复:e.then / e.els(块分支)是裸块 {stmts,tail},须包 {block} 再交给 blockInline——
      // 此前 let x = if … {} 形态会让 fmt 直接 TypeError 崩溃(自举工具 mingkit/edit 均触发)
      let s = `if ${expr(e.cond)} ${blockInline({ block: e.then })}`;
      if (e.els) {
        if (e.els.nt === 'If') s += ' else ' + expr(e.els);
        else s += ' else ' + blockInline({ block: e.els });
      }
      return s;
    }
    case 'Match': {
      const arms = e.arms.map(a => {
        const g = a.guard ? ` if ${expr(a.guard)}` : '';
        const body = a.expr.nt === 'BlockExpr' ? blockInline(a.expr) : expr(a.expr);
        return `${patAst(a.pat)}${g} => ${body}`;
      });
      return `match ${expr(e.scrutinee)} { ${arms.join(', ')} }`;
    }
    case 'BlockExpr': return blockInline(e);
    case 'StructLit': return e.fields.length
      ? `${e.path.join('.')} { ${e.fields.map(f => `${f.name}: ${expr(f.value)}`).join(', ')} }`
      : `${e.path.join('.')} {}`; // v0.56(A3):空结构体字面量 `E {}`(旧输出 `E {  }` 双空格)
    case 'LoopExpr': return `loop ${blockInline({ block: e.body })}`;
    default:
      // v0.56(A3):未知表达式一律失败(绝不输出 `?` 丢语义)
      throw new FmtError(`fmt 不支持表达式节点 ${e?.nt ?? String(e)}`, e?.span ?? null);
  }
}

function wrap(e, myPrec, minPrec, s) {
  return myPrec < minPrec ? `(${s})` : s;
}

// v0.56(A3):控制字符补转义(仅格式化输出,不改语义)——\r/\0 用具名转义,
// 其余 C0/DEL 用 \u{..}(lexer 支持)。原始字符串 r"..." 不转义(其内容按字面保留)。
const STR_ESCAPES = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r', '\0': '\\0' };
function escapeStrLit(text) {
  return text
    .replace(/[\\"\n\t\r\0]/g, ch => STR_ESCAPES[ch])
    .replace(/[\x00-\x1f\x7f]/g, ch => '\\u{' + ch.codePointAt(0).toString(16) + '}');
}
function strLit(e) {
  let s = (e.raw ? 'r' : '') + '"';
  for (const p of e.parts) {
    if ('lit' in p) {
      s += e.raw ? p.lit : escapeStrLit(p.lit);
    } else {
      s += '\\{' + expr(p.expr) + '}';
    }
  }
  return s + '"';
}

// v0.56(#36):函数契约的规范后缀(requires 在前、ensures 在后,与 parser 语义一致)。
// AST 形态:decl.requires/decl.ensures = { expr, msg, msgRaw, span } | null(parser 只保留
// 每类最后一条,后者覆盖);msg 是已解码字符串(插值形态为 null)。v0.56(A3):msgRaw 保存
// else 字面量的原始源文本(含引号,插值 `\{...}` 原样),fmt 优先原样输出——插值消息不再被丢。
function contractSuffix(it) {
  const parts = [];
  const add = (kw, cl) => {
    if (!cl) return;
    const msg = cl.msgRaw != null
      ? ' else ' + cl.msgRaw
      : (cl.msg == null ? '' : ' else ' + strLit({ parts: [{ lit: cl.msg }] }));
    parts.push(`${kw} ${expr(cl.expr)}${msg}`);
  };
  add('requires', it.requires);
  add('ensures', it.ensures);
  return parts.length ? ' ' + parts.join(' ') : '';
}

// 语句上下文里的块表达式(if/match 分支)由 stmt 处理;此处是表达式内联(闭包体等)
function blockInline(be) {
  const parts = [];
  for (const s of be.block.stmts) {
    if (s.nt === 'Let') parts.push(`let ${s.mutable ? 'mut ' : ''}${patAst(s.pat)}${s.type ? ': ' + typeAst(s.type) : ''} = ${expr(s.init)};`);
    else if (s.nt === 'ExprStmt') parts.push(expr(s.expr) + (s.semi ? ';' : ''));
    else if (s.nt === 'Return') parts.push(s.value ? `return ${expr(s.value)};` : 'return;');
    else if (s.nt === 'Break') parts.push('break;');
    else if (s.nt === 'Continue') parts.push('continue;');
    else if (s.nt === 'Assign') parts.push(`${expr(s.target)} ${s.op} ${expr(s.value)};`);
    else if (s.nt === 'While') { parts.push(`while ${expr(s.cond)} ${blockInline({ block: s.body })}`); }
    else if (s.nt === 'For') { parts.push(`for ${patAst(s.pat)} in ${expr(s.iter)} ${blockInline({ block: s.body })}`); }
    else if (s.nt === 'UnsafeBlock') { parts.push(`unsafe ${blockInline({ block: s.body })}`); } // v0.54
    // v0.56(A3):不支持内联的语句必须报错(带 span),旧实现输出 `/* ? */` 静默丢代码。
    else throw new FmtError(`fmt 不支持表达式内联块中的语句 ${s.nt}(可改写为普通函数体或其他形态)`, s.span ?? be.block.span);
  }
  if (be.block.tail) parts.push(expr(be.block.tail));
  if (parts.length === 0) return '{}';
  return '{ ' + parts.join(' ') + ' }';
}

void IND;
