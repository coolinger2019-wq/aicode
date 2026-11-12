// fmt.js — Ming 规范格式化器。
// 原则:全语言只有一种风格(4 空格缩进、;与 {} 显式、运算符两侧空格)。
// 注释通过"瀑布"策略保留:位于节点之前的注释按原相对行位输出。

const IND = '  '; // 两级结构:每层 = 4 空格 = IND+IND?这里 IND 定义为 4 空格
const INDENT = '    ';

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
    this.line(`${pub}fn ${it.name}${tps}(${params})${ret}${eff} {`, it.span.line);
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
    if (it.fields.length === 0) { this.line(`${pub}struct ${it.name}${tps} {}`); return; }
    this.line(`${pub}struct ${it.name}${tps} {`, it.span.line);
    this.indent++;
    for (const f of it.fields) {
      this.flushComments(f.span.line, false);
      this.line(`${f.name}: ${typeAst(f.type)},`, f.span.line);
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
        this.indent++; this.blockBody(els.then); this.indent--;
        els = els.els;
      } else {
        this.lineEnd('} else {');
        this.indent++; this.blockBody(els); this.indent--;
        els = null;
      }
    }
    this.line('}');
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
      return `(${ps}) => ${body}`;
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
    case 'StructLit': return `${e.path.join('.')} { ${e.fields.map(f => `${f.name}: ${expr(f.value)}`).join(', ')} }`;
    case 'LoopExpr': return `loop ${blockInline({ block: e.body })}`;
    default: return '?';
  }
}

function wrap(e, myPrec, minPrec, s) {
  return myPrec < minPrec ? `(${s})` : s;
}

function strLit(e) {
  let s = (e.raw ? 'r' : '') + '"';
  for (const p of e.parts) {
    if ('lit' in p) {
      s += p.lit.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
    } else {
      s += '\\{' + expr(p.expr) + '}';
    }
  }
  return s + '"';
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
    else parts.push('/* ? */');
  }
  if (be.block.tail) parts.push(expr(be.block.tail));
  if (parts.length === 0) return '{}';
  return '{ ' + parts.join(' ') + ' }';
}

void IND;
