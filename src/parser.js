// parser.js — Ming 语法分析器(递归下降 + 局部回溯 + 错误恢复收集多个诊断)。
// 语法原则:显式分隔(`;`/`{}` 必需)、关键字驱动、无悬垂歧义。
// 唯一的上下文规则(在 docs/design.md 中说明):
//   1. 语句开头的 `{` 是块;表达式位置的 `{` 是 Map 字面量。
//   2. if/while/match 头部与 for 的迭代式里,结构体字面量被禁用(那里的 `{` 是块/分支)。

import { err, MingError } from './diag.js';
import { Token, lex } from './lexer.js';

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=']);

// v0.73(§5.1 NOTE 极端嵌套收口):解析递归深度上限——裸栈 RangeError → 稳定 M2001 诊断。
// 阈值依据(2026-11-15 本机实测,Node v24/win32-x64;合同原拟 300 基于抽测深度 1200-2000,
// 实测最小崩点远低于此,300 落在崩区内——maplit@300 实测裸崩,故下调):
//   经 parsePrimary 的表达式形态裸崩点:lambda ~221 层(最低)/括号 ~234/Vec/struct 字面量 ~237/
//   if-expr ~291/match ~293/Map 字面量 ~296;
//   不经 parsePrimary 的直接递归形态裸崩点:裸块 ~1137、一元链 ~2050、else-if 链 ~4150
//   (后三者由同一计数器在各自递归点配对登记,见 parseUnary/parseIf/parseBlock)。
// v0.76(§5.1 RED FLAG 第五崩面收口):调用实参/下标/postfix 结构体字面量链三个 parseExpr
// 重入点此前被误归入"经 parsePrimary"——实参重入发生在 parsePrimary 返回之后,深度不累积,
// 守卫对之盲视(实测裸崩:调用 253/下标 253/postfix 字面量链 243,2026-11-17 二分校准)。
// 现于 parsePostfix 三个重入点配对登记(见 parsePostfix 注释),阈值 120 不变。
// 守卫须低于全部崩点并留跨机余量(V8 栈限 ~984KB 机器无关,帧大小随 V8 版本浮动 ±30% 量级):
// 120 层时守卫触达点栈深约为最低崩点的 55%。合法程序实测(2026-11-15,32 文件:20 examples +
// 12 自举工具)最大下降深度 12 层(tools/diaghot.ming),fuzz 生成器表达式预算 ≤3 层(解析下降
// ≤~15)——阈值留 10 倍余量,正常程序绝不触发(§76 v76.2/v76.4 锁定"合法深层表达式不误伤")。
const PARSE_DEPTH_LIMIT = 120;

// v0.75(plan §4.10 残留裸栈崩溃面清零):类型/模式解析递归深度上限——裸栈 RangeError →
// 稳定 M4005[stack-overflow] 诊断("栈溢出"语义本名,复用零新增码;先例 = v0.73 exprDepth
// 守卫的变体模式)。与表达式域(exprDepth)分域计数:类型与模式互不嵌套(模式不含类型
// 标注,类型不含模式),各自独立成域。
// 阈值依据(2026-11-16 本机实测,Node v24/win32-x64,直连 parse API 二分校准):
//   类型域:parseType 自身崩点 5674(Vec[Vec[…]];5673 存活),但全管线下 checker 类型树
//     遍历(resolveTypeAst/checkJoinNotStored 族)更低——2700 存活/2701 崩——是真实约束;
//   模式域:parsePattern 崩点 3761(Some(Some[…]);3760 存活),checker 模式遍历未先崩。
// 取值:TYPE 1450 ≈ 2701 的 54%(跨机余量照 v0.73 审查口径);PAT 2000 ≈ 3761 的 53%。
// 合法程序实测(examples+tools 32 文件)类型/模式嵌套深度个位数,fuzz 不生成深类型——
// 正常程序绝不触发(§78 v78.6 锁定)。
const TYPE_DEPTH_LIMIT = 1450;
const PAT_DEPTH_LIMIT = 2000;

// v1.9.0(ADR-021 §2):效果参数文法校验(单一事实来源;解析层具名拒绝,返回错误消息/null=合法)。
// 三形态:精确路径(无通配)/ 目录前缀(尾 `/`,授其下全部含子目录)/ 显式通配尾(尾 `/**` ≡ 目录前缀;
// 尾 `/*` 仅直接子项)。中段 `*`、任何位置的 `?`、空串一律拒绝;仅 fs 允许带参(§1,net/exec 登记
// 候选)。路径匹配 = 逐字符前缀比较,按字面处理,不做 `..`/符号链接解析——`..` 逃逸由
// std.unstr.sanitize_path 处理(既有分工,ADR-021 §2 如实登记)。
function validateEffectParam(name, s) {
  if (name !== 'fs') {
    return `效果 "${name}" 不支持参数:当前仅 fs 支持参数(ADR-021 §1);net/exec 带参为登记候选`;
  }
  if (s === '') {
    return '效果参数不能为空字符串(ADR-021 §2;合法形态:精确路径 / 目录前缀尾 "/" / 尾 "/*" 或 "/**")';
  }
  if (s.includes('?')) {
    return '效果参数不支持通配符 "?"(ADR-021 §2;通配仅允许尾段 "/*" 与 "/**")';
  }
  const tail = s.endsWith('/**') ? '/**' : (s.endsWith('/*') ? '/*' : null);
  if (tail === null) {
    if (s.includes('*')) {
      return '效果参数不支持中段通配 "*"(ADR-021 §2;通配仅允许尾段 "/*" 与 "/**")';
    }
    return null; // 精确路径或目录前缀(尾 "/")
  }
  const rest = s.slice(0, s.length - tail.length);
  if (rest.includes('*')) {
    return '效果参数不支持中段通配 "*"(ADR-021 §2;通配仅允许尾段 "/*" 与 "/**")';
  }
  return null;
}

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
  constructor(tokens, file, baseDepth = 0) {
    this.toks = tokens; this.file = file; this.pos = 0;
    this.diags = [];
    this.noStructLit = 0; // 上下文标志深度
    this.contractClause = 0; // v0.56(#33):requires/ensures 子句表达式深度(该处 `{` 优先判为函数体)
    // v0.73(审查 MAJOR-1):嵌套插值每层 new Parser 新实例——exprDepth 是实例字段,新实例
    // 从 0 起计,守卫对跨实例递归盲视(实测插值嵌套 212 层裸崩,低于其余形态最低崩点 221)。
    // 父深度经第三参跨实例传递(插值分支传入 this.exprDepth)。
    this.exprDepth = baseDepth;
    // v0.70(#63):值构造(struct/map 字面量、match 体)已消费但尚未闭合的 `{` 数。
    // 这些构造失败时会穿越自己的 `}` 向上抛,recover 看不到已消费的开括号——不登记的话,
    // 字面量自己的 `}` 会被当成当前块的收尾 brace 提前闭合函数体(级联雪崩的另一半根因)。
    this.valBrace = 0;
    // v0.73:解析递归深度计数器(当前活跃的守卫挂点层数)。挂点四处,进出必须配对:
    // parsePrimary(全部表达式叶子入口,主闸)+ parseUnary(`-`/`!` 自递归)+
    // parseIf(else-if 链直接递归)+ parseBlock(嵌套块直接递归)——后三处不经 parsePrimary。
    // 全部 try/finally 包住: bail/异常抛出穿透时计数必然递减,恢复路径零残留
    // (§76 v76.3 锁定;残留会让后续深嵌套语句误触 M2001)。
    // 初始化在本构造器上方(exprDepth = baseDepth,默认 0)——此处不得再置 0,
    // 否则跨实例传递的父深度被覆盖(v0.73 审查 MAJOR-1 修复的合并教训)。
    // v0.75(plan §4.10):类型域/模式域深度计数器,同 try/finally 配对纪律。挂点两处:
    // parseType(mut/泛型实参/括号元组/fn 类型直接自递归)+ parsePattern(parsePatternArgs
    // 直接自递归)——均不经 parsePrimary,exprDepth 罩不到。插值子解析器(parseInterpExpr
    // 的 new Parser)不传这两个域:插值表达式内可有 `as` 类型(各实例独立计满阈值,组合
    // 深度 expr≤120×帧 + type≤1450×帧 仍低于裸崩点,见常量注释)。
    this.typeDepth = 0;
    this.patDepth = 0;
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
  // v0.70(#63 诊断校准二期):语句层恢复改为深度感知 panic-mode。
  // 根因:旧语句停机表含顶层关键字 `test`(test 只能顶层,不是语句)——语句解析失败落在
  // `test` 上时 recover 立即返回(未消费),catch 强进 1 token 到 `ident {`,下一轮被误解析为
  // 结构体字面量(字段名路径 → M2002"期望 :"+错误 fix),函数体提前闭合 → 顶层级联雪崩
  // (锚定语料实测 1 根因 → 4 条诊断)。现在失败语句的 {...} 区域整体吞掉(depth>0 丢弃一切,
  // 包括其中的关键字字面量),depth===0 时按语句边界停机,顶层级联消除。
  // 预期副作用(记录):失败语句到下一个 `;`/语句关键字之间的好语句会被 panic-mode 吞掉
  // (如锚定语料的 `print("bye");`)——程序反正编译失败,诊断正确性优先于语句 salvage。
  // v0.71(#67 构造级登记所有权 + #68 salvage 精化):
  //   blockVB = 调用块(parseBlock)入口时登记数与本块 catch 时登记数之差(块内构造余量)。
  //   登记所有权分层:本块内失败的值构造,其收尾 `}` 由本块 recover 消费结清;外层活构造
  //   (如 `Json{ a: if true { 失败 } }` 的 Json{)的登记**不属于本块**——它的收尾 `}`
  //   交还外层构造的收尾 expectOp 消费,不被本块当块收尾误吞(p21 伪 M2002@2:43 的根源:
  //   旧全局种子让内层块吞掉 if 收尾、外层收尾被块错位消费,字段循环 expectOp 撞 `;`)。
  //   blockVB 未提供的调用点(finishExprStmt 的 inline 恢复/parseProgram 顶层强进续扫):
  //   沿用全局登记(终态与 v0.70 入口清账同——到达 depth 0 恰递减种子次;实测逐字一致,
  //   v0.71 审查 NOTE-1:活构造内触发的 inline 恢复种子可 >0,此为正确种子而非残留)。
  //   同步递减(方案 a 要素):扫描每消费一个"种子层"的 `}`(递减前 depth ≤ 种子)同步
  //   `valBrace = max(0, valBrace-1)`——登记随消费结清,不再入口一次性清零;种子之上的
  //   嵌套块收尾(递减前 depth > 种子)不动登记。不变量:任意 recover 退出时,valBrace
  //   恰等于"已消费未匹配的 `{` 数"中仍活着的部分——无负数(递减钳 0)、无陈旧(随消费
  //   结清;唯一例外 eof 退出,随后 parseBlock 的 eof bail 抛到顶层由 recover(true) 清零)、
  //   无双重递减(成功路径 `--` 有 >0 守卫,同步递减只在种子层消费处执行)。
  //   #68 深度 0 `id(` 停机启发式:当前 token 是标识符且下一个 token 是 `(` → 停机不消费
  //   (疑似新调用语句起始,交还块循环按语句解析抢救——合法调用救回,未知名由 checker 报
  //   M3001,真实错误恢复报出而非静默)。仅 depth===0;depth>0(被吞 {} 区域内)不受影响。
  //   终止性核实(启发式不得引入不停机路径,链路推演):
  //     启发式停机**不消费**,cur 仍是该 `id`。此后块循环 mark=pos 重新记录,parseStmtOrTail
  //     二分:(i) 解析成功 → 必然消费若干 token(pos 前进);(ii) 解析再失败 → catch 再进
  //     recover:若失败点已越过该 `id`(pos 前进),扫描正常推进;若失败点恰仍是该 `id(`,
  //     启发式立即停机返回(未消费)→ catch 强进路径 `pos === mark` 成立 → `next()` 消费
  //     1 token + 继续 recover(false)——强进保证每轮循环至少前进 1 token。token 流有限、
  //     pos 单调不减且卡点时每轮 +1,必达 eof(parseBlock eof → bail 块未闭合;parseProgram
  //     eof → 循环结束),无挂起。毒汤语料实测收敛(§74 v74.3)。
  recover(topLevel, blockVB = null) {
    if (topLevel) {
      // 顶层恢复:行为逐字不变(v0.70 仅改语句层;v0.71 语句层改动不回传顶层)。
      // v0.70 审查 MAJOR-1(陈旧正值路径):顶层失败点若是值构造(如顶层 const 初始化器
      // 内的 `S{ a 1 }`),登记未被语句层结清——残余 +1 会污染后续任何语句层 recover 的
      // 深度种子,使停机表失效吞掉后续根因。失败构造已死亡,残余登记必然陈旧:入口清零。
      this.valBrace = 0;
      for (;;) {
        const t = this.cur();
        if (t.kind === 'eof') return;
        if (t.kind === 'kw' && ['fn', 'struct', 'enum', 'use', 'test', 'pub'].includes(t.val)) return;
        if (t.kind === 'op' && t.val === '}') return;
        if (t.kind === 'op' && t.val === ';') { this.next(); return; }
        this.next();
      }
    }
    // 语句层:深度感知 panic-mode(test 已从停机表移除——它只能顶层)。
    // 深度 = 恢复扫描自身计数 + 种子(失败语句已消费未闭合的值构造 brace 的**块内余量**)——
    // 后者让 `Json{ ... }` 类失败语句被整句吞到匹配 `}`,字面量的 `}` 不会被误当块收尾。
    // v0.70 审查 MAJOR-1(负数路径):下限钳 0(Math.max)防负种子;同步递减也钳 0,双保险。
    const seed = Math.max(0, blockVB != null ? blockVB : this.valBrace);
    let depth = seed;
    for (;;) {
      const t = this.cur();
      if (t.kind === 'eof') return;
      if (t.kind === 'op' && t.val === '{') { depth++; this.next(); continue; }
      if (t.kind === 'op' && t.val === '}') {
        if (depth > 0) {
          // 种子层收尾消费 → 登记随消费同步结清(仅种子层;种子之上的嵌套块收尾不动)。
          if (depth <= seed) this.valBrace = Math.max(0, this.valBrace - 1);
          depth--;
          this.next();
          continue;
        }
        return; // depth===0:这是当前块的收尾 brace,不消费,交还块循环闭合
      }
      if (depth === 0) {
        if (t.kind === 'kw' && ['fn', 'let', 'return', 'while', 'for', 'loop', 'if', 'match', 'unsafe'].includes(t.val)) return;
        if (t.kind === 'op' && t.val === ';') { this.next(); return; }
        // v0.71(#68):深度 0 `id(` 停机——疑似调用语句起始,抢救(见函数头终止性推演)。
        if (t.kind === 'id' && this.peek(1).kind === 'op' && this.peek(1).val === '(') return;
      }
      this.next(); // depth>0:丢弃一切(含关键字);depth===0:丢弃非停机 token
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
          // v0.70(#63):recover 未前进(cur 是顶层停机关键字/`}` 但解析它失败)时,
          // 强进 1 token 后继续 recover(false) 推进到下一个语句边界——避免 +1 后
          // `ident {` 被误解析为结构体字面量产生级联。recover 已前进时不强进。
          if (this.pos === mark) { this.next(); this.recover(false); }
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
    // v1.9.0(ADR-021 §1/§2):参数化效果 MVP——带参效果与裸名自由混列(`with io, fs("/data/**")`)。
    // 仅 fs 带参合法;参数必须是纯字符串字面量(expectStrLit 禁插值,注入卫生同 asm 先例);
    // 模式文法三形态(精确路径/目录前缀尾 `/`/尾 `/*` 或 `/**`)由 validateEffectParam 在本处
    // 校验(单一事实来源,解析层具名拒绝 M2008)。同一声明内多个 fs(模式) = 授权集并集,
    // parser 保留全部节点。AST 节点形状 {name, span, param?}:裸名节点无 param 键,既有程序
    // AST 零字节变化(零破坏锚)。文法校验选定在 parser(而非 checker)一处完成:纯词法判定、
    // span 精确到声明、非法模式不流入 lsp/fmt/运行时可见的 AST。
    let effects = [];
    if (this.atKw('with')) {
      this.next();
      for (;;) {
        // v0.54:unsafe 是关键字也可作效果名(with unsafe);其余效果名保持标识符
        const eTok = this.atKw('unsafe') ? this.next() : this.expectId('效果名');
        const effItem = { name: eTok.val, span: eTok.span };
        if (this.atOp('(')) {
          this.next();
          const argTok = this.expectStrLit(`效果 "${eTok.val}" 的参数`);
          this.expectOp(')');
          const badParam = validateEffectParam(eTok.val, argTok.val);
          if (badParam) this.fail('M2008', badParam, this.spanFrom(eTok));
          effItem.param = argTok.val; // 文法非法也保留(解析诊断已入账,管线不会带错执行)
        }
        effects.push(effItem);
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
      // v0.56(#33):契约子句内 `裸标识 {` 的 `{` 默认是函数体(见 parseContractExpr)
      const expr = this.parseContractExpr();
      let msg = null;
      let msgRaw = null; // v0.56(A3):else 字面量原始源文本(含引号),fmt 原样回写
      if (this.atKw('else')) {
        this.next();
        if (this.at('str')) {
          const t = this.next();
          // str token 可能是插值;msg 只取字面量文本(插值消息运行时仍为 null,语义不变)
          msg = (t.extra && t.extra.parts) ? null : t.val;
          msgRaw = t.extra?.raw ?? null;
        } else {
          this.bail('M2002', '契约 else 后期望字符串字面量', this.cur().span);
        }
      }
      const c = { expr, msg, msgRaw, span: this.spanFrom(cStart) };
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
    // v0.73:嵌套块递归守卫——裸块 `{ { … } }`/深层块结构是 parseBlock 直接递归,不经
    // parsePrimary(实测裸块裸崩点 ~1137 层)——同一计数器在此配对登记。检查必须在挂点
    // 本处:纯块下降途中没有任何表达式叶子,等 parsePrimary 过闸就晚了(裸崩先行)。
    // 函数体/if 体等常规块深度远低于阈值,只付一次计数开销(§76 v76.4 全量回归证明零影响)。
    this.exprDepth++;
    try {
      if (this.exprDepth > PARSE_DEPTH_LIMIT) {
        this.bail('M2001', `表达式嵌套过深(>${PARSE_DEPTH_LIMIT} 层);提示:拆分嵌套结构或引入中间绑定`, this.cur().span);
      }
      return this.parseBlockInner();
    } finally {
      this.exprDepth--;
    }
  }

  parseBlockInner() {
    const startTok = this.cur();
    if (!this.atOp('{')) {
      const hint = this.atOp('=') ? '条件比较要用 "==";单个 "=" 是赋值' : null;
      this.bail('M2002', `期望 "{"(块),实际是 ${tokDesc(this.cur())}`, this.cur().span, hint);
    }
    this.next();
    const start = startTok;
    // v0.71(#67):块入口登记快照——登记所有权分层。块内 catch 时种子 = 当前登记 - 快照
    // = 本块内新增的值构造登记;外层活构造的登记不属于本块,其收尾 `}` 由 recover 交还
    // 给外层构造的收尾 expectOp(见 recover 注释)。`{` 是块不是值构造,登记数此刻不变。
    const enterVB = this.valBrace;
    const stmts = [];
    let tail = null;
    for (;;) {
      if (this.atOp('}')) { this.next(); break; }
      if (this.at('eof')) {
        // v0.76:结构化修复处方(v0.44 fix 协议零新协议)——块未闭合的收尾 "}" 机械定位于
        // eof 插入:诊断 span 已精确指向未闭合块的 "{",缺失的收尾大括号在 eof 补一个即
        // 语法闭合(多重未闭合时逐轮收敛,每轮补一个,fix 迭代应用面)。控制流与诊断计数
        // 不变(仅挂 fix 字段;v73.5 恰 1 条断言不受影响)。
        const eofTok = this.cur();
        const d = err('M2002', '块未闭合(缺少 "}")', start.span);
        d.fix = { start: { line: eofTok.span.line, col: eofTok.span.col }, end: { line: eofTok.span.line, col: eofTok.span.col }, replacement: '}' };
        throw { mingParse: true, diag: d };
      }
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
          this.recover(false, Math.max(0, this.valBrace - enterVB));
          // v0.70(#63):recover 未前进(cur 是语句停机关键字/启发式停机点但解析它失败)时,
          // 强进 1 token 后继续 recover(false) 推进到下一个语句边界——避免 +1 后 `ident {` 被误解析为
          // 结构体字面量(锚定语料的 M2002 级联)。recover 已前进时不强进。
          // v0.71(#68):启发式停机不消费——失败点本身即 `id(` 时走此强进路径保证前进
          // (终止性链路见 recover 注释);强进后续扫同样带块种子,所有权口径一致。
          if (this.pos === mark) { this.next(); this.recover(false, Math.max(0, this.valBrace - enterVB)); }
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

    if (t.kind === 'id' && t.val === 'asm' && this.peek(1).kind === 'op' && this.peek(1).val === '{') {
      // v0.74(ADR-006):asm { ... } 内联汇编块(仅语句位;上下文关键字,同 sync scope
      // 先例——不保留 asm 词,避免破坏既有程序)。函数须声明 with asm(checker M3029 门禁)。
      return this.parseAsmBlock();
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

  // ---- v0.74(ADR-006 §1):内联汇编块 ----
  //
  //   asm {
  //       "模板行"                       // 1+ 个纯字符串字面量,逐字拼接为 GCC 扩展 asm 模板
  //       out ( "约束" , mut <变量> )*    // 0+;asm 写入该 mut 变量(GCC "=..." 约束)
  //       in  ( "约束" , <表达式> )*      // 0+;值经 gcc 约束机制传入(完整 i64 表达式)
  //       clobber ( "寄存器" )+?          // 可选;1+ 组,每组内逗号分隔(单组多寄存器为常用形)
  //   }
  //
  // 注入卫生(ADR-006 §3):模板/约束/clobber 必须是纯字符串字面量(禁止插值/变量/表达式)
  // ——运行时拼接在语法层面不存在,注入面在解析层闭合。out 目标只存名字,mut/i64 合法性
  // 由 checker 校验(不存在 → M3001;非 mut → M3004;非 i64 → M3002)。操作数占位符沿
  // GCC 约定 %0/%1…(编号 = out 先 in 后)写在模板里,cbackend 逐字透传。
  // asm 块 = 语句、无值;仅语句位(本方法只被 parseStmtOrTail 调用),块后不需要分号。
  parseAsmBlock() {
    const start = this.next(); // 消费 asm(上下文关键字;调用方已确认下一个 token 是 "{")
    this.expectOp('{', 'asm');
    const templates = [];
    const outs = [];
    const ins = [];
    const clobbers = [];
    // 模板:1+ 个纯字符串字面量
    while (this.at('str')) {
      const tk = this.next();
      if (tk.val === null) this.bail('M2001', 'asm 模板必须是纯字符串字面量,不允许插值', tk.span,
        '模板由 ming cc 逐字透传给 GCC;动态内容请用 in 操作数经约束机制传入,不要拼接字符串。');
      templates.push(tk.val);
    }
    if (!templates.length) {
      this.bail('M2001', `asm 块必须以模板字符串字面量开始(模板/约束/clobber 只能是字符串字面量,不允许变量或表达式),实际是 ${tokDesc(this.cur())}`, this.cur().span,
        '写法:asm { "指令" out("=r", mut x) }');
    }
    // 子句:out* → in* → clobber?(grammar 顺序;每种子句可重复出现)
    let phase = 0; // 0=out 1=in 2=clobber
    for (;;) {
      if (this.atOp('}')) break;
      if (this.at('eof')) this.bail('M2002', 'asm 块未闭合(缺少 "}")', start.span);
      const t = this.cur();
      const clause = (t.kind === 'id' && t.val === 'out') ? 'out'
        : (t.kind === 'kw' && t.val === 'in') ? 'in'
        : (t.kind === 'id' && t.val === 'clobber') ? 'clobber' : null;
      if (!clause) {
        this.bail('M2001', `asm 块内只允许 模板字符串 / out / in / clobber 子句,实际是 ${tokDesc(t)}`, t.span);
      }
      const ord = clause === 'out' ? 0 : clause === 'in' ? 1 : 2;
      if (ord < phase) {
        this.bail('M2001', `asm 块子句顺序必须是 模板 → out → in → clobber,这里 "${clause}" 出现在其后的子句类型之后`, t.span);
      }
      phase = ord;
      this.next();
      this.expectOp('(', `"${clause}" 子句`);
      if (clause === 'out') {
        const cTok = this.expectStrLit('asm out 约束');
        this.expectOp(',', 'out 约束');
        this.expectKw('mut');
        const nameTok = this.expectId('asm out 目标变量名');
        this.expectOp(')');
        outs.push({ constraint: cTok.val, target: nameTok.val, span: this.spanFrom(t) });
      } else if (clause === 'in') {
        const cTok = this.expectStrLit('asm in 约束');
        this.expectOp(',', 'in 约束');
        const value = this.parseExpr();
        this.expectOp(')');
        ins.push({ constraint: cTok.val, value, span: this.spanFrom(t) });
      } else {
        // 首组 "(" 已由上方共用的 expectOp('(') 消费;每组内逗号分隔 1+ 个寄存器字面量,
        // 关闭后若紧跟 "(" 则继续解析后续组(clobber("a")("b") 亦为合法形态)
        for (;;) {
          const cTok = this.expectStrLit('asm clobber 寄存器');
          clobbers.push(cTok.val);
          if (this.atOp(',')) { this.next(); continue; }
          this.expectOp(')');
          break;
        }
        while (this.atOp('(')) {
          this.next();
          for (;;) {
            const cTok = this.expectStrLit('asm clobber 寄存器');
            clobbers.push(cTok.val);
            if (this.atOp(',')) { this.next(); continue; }
            this.expectOp(')');
            break;
          }
        }
      }
    }
    this.expectOp('}');
    return { nt: 'AsmBlock', templates, outs, ins, clobbers, span: this.spanFrom(start) };
  }

  // v0.74(ADR-006):asm 模板/约束/clobber 专用——必须是纯字符串字面量(禁止插值)。
  expectStrLit(what) {
    if (this.at('str') && this.cur().val !== null) return this.next();
    if (this.at('str')) this.bail('M2001', `${what}必须是纯字符串字面量,不允许插值`, this.cur().span);
    this.bail('M2001', `${what}必须是字符串字面量,实际是 ${tokDesc(this.cur())}`, this.cur().span);
  }

  // ---- 模式 ----

  // v0.75:模式递归深度守卫——Some(Some[…])/(a,(b,(…))) 经 parsePatternArgs 直接自递归,
  // 不经 parsePrimary(exprDepth 罩不到),实测裸崩点 3761 层(2026-11-16 直连 parse API
  // 二分)。超限 bail 稳定 M4005 替代裸栈 RangeError;try/finally 配对,bail 抛出路径
  // 计数必然递减,恢复路径零残留(§76 v76.3 口径)。
  parsePattern() {
    if (this.patDepth >= PAT_DEPTH_LIMIT) {
      this.bail('M4005', `模式嵌套过深(>${PAT_DEPTH_LIMIT} 层);提示:拆分嵌套结构或引入中间绑定`, this.cur().span);
    }
    this.patDepth++;
    try {
      return this.parsePatternInner();
    } finally {
      this.patDepth--;
    }
  }

  parsePatternInner() {
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

  // v0.75:类型递归深度守卫——Vec[Vec[…]]/mut Ptr[…]/(…,(…))/fn 类型经泛型实参等
  // 位直接自递归,不经 parsePrimary(exprDepth 罩不到)。parseType 自身实测裸崩点 5674 层,
  // 但全管线下 checker 类型树遍历(resolveTypeAst/checkJoinNotStored 族)在 2701 层先崩
  // (2026-11-16 直连 API 二分)——守卫 1450 层同时保护两侧(≈2701 的 54%,跨机余量照
  // v0.73 审查口径)。超限 bail 稳定 M4005 替代裸栈 RangeError;try/finally 配对,bail
  // 抛出路径计数必然递减,恢复路径零残留(§76 v76.3 口径)。
  parseType() {
    if (this.typeDepth >= TYPE_DEPTH_LIMIT) {
      this.bail('M4005', `类型嵌套过深(>${TYPE_DEPTH_LIMIT} 层);提示:拆分嵌套结构或引入中间绑定`, this.cur().span);
    }
    this.typeDepth++;
    try {
      return this.parseTypeInner();
    } finally {
      this.typeDepth--;
    }
  }

  parseTypeInner() {
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

  // v0.56(#33):requires/ensures 子句的表达式以裸标识结尾时,后面的 `{` 是函数体起点,
  // 不是结构体字面量。有字段的字面量在 `{` 之后必有 `字段名 :`,空字面量 S {} 另行前瞻
  // (见 bodyBraceAhead);其余形态一律按函数体处理。普通表达式位置的 S { x: 1 } 语义不变。
  parseContractExpr() {
    this.contractClause++;
    try {
      return this.parseExpr();
    } finally {
      this.contractClause--;
    }
  }

  // 当前 `{`(已确认 atOp('{'))是否应判为函数体而非结构体字面量
  bodyBraceAhead() {
    if (this.contractClause === 0) return false;
    const a = this.peek(1), b = this.peek(2);
    if (a.kind === 'id' && b.kind === 'op' && b.val === ':') return false; // S { x: ... }
    // 空结构体字面量 S {} 与空函数体同形:仅当 `}` 之后是"函数/块结束"
    // (eof、外层 `}`、顶层声明关键字)时才判为函数体,其余按字面量(如 S {} 后接 { 体)。
    if (a.kind === 'op' && a.val === '}') {
      if (b.kind === 'eof') return true;
      if (b.kind === 'op' && b.val === '}') return true;
      if (b.kind === 'kw' && ['fn', 'extern', 'struct', 'enum', 'use', 'test', 'const', 'trait', 'impl', 'pub'].includes(b.val)) return true;
      return false;
    }
    return true;
  }

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
      // v0.73:一元链 `!!!!!…`/`-----…` 是 parseUnary 直接自递归,不经 parsePrimary——
      // 同一计数器在此配对登记(实测一元链裸崩点 ~2050 层)。检查必须在挂点本处:
      // 链下降途中直到叶子才有表达式叶子,等 parsePrimary 过闸就晚了(裸崩先行)。
      this.exprDepth++;
      try {
        if (this.exprDepth > PARSE_DEPTH_LIMIT) {
          this.bail('M2001', `表达式嵌套过深(>${PARSE_DEPTH_LIMIT} 层);提示:拆分嵌套结构或引入中间绑定`, this.cur().span);
        }
        const e = this.parseUnary();
        return { nt: 'Unary', op: t.val, expr: e, span: this.spanFrom(t) };
      } finally {
        this.exprDepth--;
      }
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
          // v0.76(§5.1 RED FLAG 第五崩面收口):调用实参是 parsePostfix 循环内的 parseExpr
          // 完整重入——此时 parsePrimary 已返回(exprDepth 已递减),重入不经过任何活跃守卫区,
          // 嵌套调用 f(f(f(…))) 的深度不累积而 JS 栈照常增长(v0.73 注释把"调用嵌套"归入
          // "经 parsePrimary 的形态"是误判——实测 253 层裸 RangeError,120 阈值形同虚设)。
          // 在重入点配对登记(同 parseUnary/parseIf/parseBlock 挂点纪律,try/finally 保证
          // bail 穿透时计数递减,恢复路径零残留)。实测裸崩点 253(2026-11-17 本机
          // Node v24/win32-x64,二分校准:252 存活/253 崩);阈值 120 时守卫触达点栈深
          // 约为裸崩点的 48%,与 v0.73 校准口径一致且留跨机余量。
          this.exprDepth++;
          try {
            if (this.exprDepth > PARSE_DEPTH_LIMIT) {
              this.bail('M2001', `表达式嵌套过深(>${PARSE_DEPTH_LIMIT} 层);提示:拆分嵌套结构或引入中间绑定`, this.cur().span);
            }
            args.push(this.parseExpr());
          } finally {
            this.exprDepth--;
          }
          if (this.atOp(',')) { this.next(); continue; }
          break;
        }
        this.expectOp(')');
        e = { nt: 'Call', callee: e, args, span: this.spanFrom(t) };
        continue;
      }
      if (t.kind === 'op' && t.val === '[') {
        this.next();
        // v0.76:下标表达式与调用实参同栈形同盲点(重入在 parsePrimary 返回之后;实测裸崩点
        // 253 层,二分校准:252 存活/253 崩)——同挂点配对登记,消息/code 与 v0.73 逐字一致。
        this.exprDepth++;
        let idx;
        try {
          if (this.exprDepth > PARSE_DEPTH_LIMIT) {
            this.bail('M2001', `表达式嵌套过深(>${PARSE_DEPTH_LIMIT} 层);提示:拆分嵌套结构或引入中间绑定`, this.cur().span);
          }
          idx = this.parseExpr();
        } finally {
          this.exprDepth--;
        }
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
        if (this.atOp('{') && this.noStructLit === 0 && !this.bodyBraceAhead()) {
          const path = collectPath(e);
          if (path === null) {
            this.bail('M2001', `"{" 不能跟在字段访问之后;结构体字面量只能跟在类型名后`, this.cur().span);
          }
          path.push(nameTok.val);
          // v0.76:postfix `.` 进入的结构体字面量(a.b { … })与调用实参同盲点——字段值
          // parseExpr 重入在 parsePrimary 返回之后,嵌套链深度不累积(实测裸崩点 243 层,
          // 二分校准:242 存活/243 崩)。parsePrimaryInner 直入路径(`S { … }`)本就在守卫区内,
          // 不经此挂点,行为不变。同挂点纪律:try/finally 配对,消息/code 逐字。
          this.exprDepth++;
          try {
            if (this.exprDepth > PARSE_DEPTH_LIMIT) {
              this.bail('M2001', `表达式嵌套过深(>${PARSE_DEPTH_LIMIT} 层);提示:拆分嵌套结构或引入中间绑定`, this.cur().span);
            }
            e = this.parseStructLitFrom(path, t);
          } finally {
            this.exprDepth--;
          }
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
    this.valBrace++; // v0.70(#63):登记已消费的 `{`,失败穿越时 recover 深度感知吞到匹配的 `}`
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
    if (this.valBrace > 0) this.valBrace--; // 收尾 `}` 即将消费,撤回登记(仅登记仍在时;负数路径见 recover 注释,v0.70 审查 MAJOR-1)
    this.expectOp('}');
    return { nt: 'StructLit', path, fields, span: this.spanFrom(startTok) };
  }

  parsePrimary() {
    // v0.73:解析递归深度守卫主闸——全部表达式叶子入口在此过闸,一处 try/finally 进出配对。
    // 超限 bail(稳定 M2001)替代裸栈 RangeError;异常路径(bail 抛出)由 finally 保证递减,
    // 恢复路径零残留(§76 v76.3)。一元链/else-if 链/嵌套块不经此处,各自递归点另行配对登记。
    this.exprDepth++;
    try {
      if (this.exprDepth > PARSE_DEPTH_LIMIT) {
        this.bail('M2001', `表达式嵌套过深(>${PARSE_DEPTH_LIMIT} 层);提示:拆分嵌套结构或引入中间绑定`, this.cur().span);
      }
      return this.parsePrimaryInner();
    } finally {
      this.exprDepth--;
    }
  }

  parsePrimaryInner() {
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
        : { expr: new Parser(p.tokens, this.file, this.exprDepth).parseInterpExpr() });
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
      if (this.atOp('{') && this.noStructLit === 0 && !this.bodyBraceAhead()) {
        // v0.75(v0.74 审查 NOTE-2):asm 块出现在表达式位(`let x = asm { … }`)——
        // 此前回落结构体字面量路径,报误导的 M2002"期望字段名"+ 使用点级联。asm 是
        // 上下文关键字(仅语句位,ADR-006),表达式位点名给稳定 hint。
        if (t.val === 'asm') {
          this.bail('M2001', 'asm 块仅能作为语句使用(不能作表达式);把 asm 块移到语句位', t.span,
            '写法:asm { "指令" out("=r", mut x) } —— 块后不需要分号,结果经 out 子句写入 mut 变量。');
        }
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
      if (this.atKw('if')) {
        // v0.73:else-if 链是 parseIf→parseIf 直接递归,不经 parsePrimary——
        // 同一计数器在此配对登记(实测 else-if 链裸崩点 ~4150 层)。
        this.exprDepth++;
        try {
          els = this.parseIf();
        } finally {
          this.exprDepth--;
        }
      } else {
        els = this.parseBlock();
      }
    }
    return { nt: 'If', cond, then, els, span: this.spanFrom(start) };
  }

  parseMatch() {
    const start = this.expectKw('match');
    this.noStructLit++;
    const scrutinee = this.parseExpr();
    this.noStructLit--;
    this.expectOp('{');
    this.valBrace++; // v0.70(#63):登记已消费的 `{`,失败穿越时 recover 深度感知吞到匹配的 `}`
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
    if (this.valBrace > 0) this.valBrace--; // 收尾 `}` 即将消费,撤回登记(仅登记仍在时;负数路径见 recover 注释,v0.70 审查 MAJOR-1)
    this.expectOp('}');
    return { nt: 'Match', scrutinee, arms, span: this.spanFrom(start) };
  }

  parseMapLit() {
    const start = this.expectOp('{');
    this.valBrace++; // v0.70(#63):登记已消费的 `{`,失败穿越时 recover 深度感知吞到匹配的 `}`
    const entries = [];
    while (!this.atOp('}')) {
      const k = this.parseExpr();
      this.expectOp(':', 'map 键');
      const v = this.parseExpr();
      entries.push({ k, v, span: k.span });
      if (this.atOp(',')) { this.next(); continue; }
      break;
    }
    if (this.valBrace > 0) this.valBrace--; // 收尾 `}` 即将消费,撤回登记(仅登记仍在时;负数路径见 recover 注释,v0.70 审查 MAJOR-1)
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
