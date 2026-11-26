// tests/z3_check.mjs — Z3 外部消费验证(plan §4.20 R-15 剩余子项 / roadmap §5.1 交付物)
//   + R-19 SMT-LIB 逐义务 golden fixtures(plan §4.20 P2;来源 moltbook 外部评审 Klara 2026-11-26:
//     "commit one SMT-LIB script per obligation as a fixture, so validation becomes a file diff
//      instead of a re-run")。
//
// 三层职责(顺序固定——fixture 比对先于 z3 执行,本机无 z3 也校验确定性黄金):
//   A. 生成 + 结构断言(不依赖 z3):内联语料写临时目录 → `ming check <f> --proof-format smt-lib`
//      → 逐块结构/内部判定注释/check-sat 数断言(原逻辑)。脚本以**相对路径**调用(cwd = 临时目录),
//      文件分节注释因此稳定为 `; ===== 文件:<slug>.ming =====`——这是 fixtures 可逐字节入库的
//      前提(绝对临时路径带随机后缀,不可入库)。
//   B. fixture 黄金比对(不依赖 z3):生成脚本 vs `tests/proof_fixtures/<slug>.smt2`。
//      - 缺失 fixture = **失败**(不静默);
//      - 不一致 = 失败并打印**首处差异行**(两侧各截断至 200 字符);
//      - 默认**严格逐字节**;
//      - `--no-comments`:比较前剥离 `;` 注释行、空行与行尾空白,只看"纯命令面"
//        (协议 §5 把注释措辞/分节格式定为实验面;该模式用于查看命令面差异,不改变入库内容);
//      - `--update-fixtures`:显式更新通道,重新生成并写入 fixtures 目录(逐文件打印
//        新增/变更/未变;更新即审查信号——git diff 可逐字节审阅)。
//   C. z3 消费验证(需要 z3):探测 z3;不可用 → 打印跳过原因 + exit 0(本机开发环境常态,
//      此时 A/B 已执行);可用 → 逐语料消费脚本并逐块对照内部判定(原逻辑)。
//
// 语料矩阵(与 tests/run.mjs §113 的 §113.1/§113.2/§113.19 语义同源,但源码内联独立):
//   proven          全 proven(body 作用域)                       z3: unsat/unsat
//   refuted-sat     违反语料,假设集可满足                         z3: low=sat(仅记录)/high=sat
//   refuted-unsat   违反语料,假设集自身不可满足                   z3: 豁免 unsat(§6.2 规则 4)
//   unknown         内部未判定                                    z3 回答任意(仅记录)
//   zero            零义务脚本                                    z3 接受 + 零回答
//   loop            loop 作用域 proven(i$<n> 符号/区间约束)         z3: unsat/unsat
//   reserved        保留字重写(参数 div → 脚本符号 div_v;§3.2)     z3: unsat/unsat
//   nonlinear       不可线性化索引(buf[n * n];目标不编码、零命令)   z3: 接受 + 零回答
//   multifile       两文件一次 check(分节按命令行顺序)              z3: unsat×4
//
// 用法:node tests/z3_check.mjs [--update-fixtures] [--no-comments] [--help]
// 退出码:0 = 全部断言与 fixture 比对通过(z3 不可用时跳过 z3 层);1 = 断言失败 /
//        fixture 缺失或不一致 / 求解器异常 / 管线错误。
// 纪律:零第三方依赖;确定性;fixture 用 LF(仓库 .gitattributes `eol=lf` 先例);错误走 stderr;
//       失败 exit 1;失败时临时目录留档(路径打印到 stderr),成功即清理。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'proof_fixtures');
const SPAWN_TIMEOUT_MS = 120000;
const SKIP_LINE = 'z3 不可用,跳过(本机开发环境常态)';
const DIFF_CLIP = 200; // 差异行截断长度(字符)

const USAGE = [
  '用法:node tests/z3_check.mjs [--update-fixtures] [--no-comments] [--help]',
  '',
  'Z3 外部消费验证(协议 docs/proof-protocol.md §6)+ SMT-LIB golden fixtures(R-19):',
  '  A. ming check <语料> --proof-format smt-lib 生成脚本 + 逐块结构断言(不依赖 z3);',
  '  B. 生成脚本 vs tests/proof_fixtures/<slug>.smt2(缺失/不一致 = 失败;默认严格逐字节);',
  '  C. z3 <脚本> 逐块对照内部判定(z3 不在 PATH 时打印跳过原因并 exit 0)。',
  '',
  '  --update-fixtures  重新生成并写入 fixtures 目录(显式更新通道;逐文件打印)',
  '  --no-comments      比较前剥离 ; 注释行 / 空行 / 行尾空白(只看纯命令面;',
  '                     默认严格逐字节——协议 §5 注释措辞属实验面)',
  '                     注意 (set-info ...) 是命令、不随注释剥离)',
].join('\n');

// ---- 语料矩阵 -------------------------------------------------------------------------------
// 每项:slug / name / 源(单文件 `source` 字符串;多文件用 `files:[{name,content}]`——文件按
// 数组序传给 `ming check`,分节注释因此按命令行顺序出现)/ expectVerdicts(逐块内部判定,
// 顺序 = 逐义务 low→high)/ expectCheckSats(脚本 check-sat 数,逐语料显式登记;不可线性化
// 语料为 0)/ expectSections(文件分节注释里的展示文件名,顺序与数量敏感;零义务脚本无分节 →
// [])/ expectMentions / expectAbsent(脚本必含 / 必不含的子串——覆盖保留字重写与诚实注释
// 形态;**注**:expectAbsent 扫全文含注释,若未来注释回显源码原名且与某 absent 子串相撞会
// 误红——届时把该断言收窄到命令面,审查 n6 登记)/ expectViolated(ming check 退出码:有 M3045
// 错误诊断 → 1,否则 0——协议 §4.4 退出码语义零变化)/ expectExempt(§6.2 规则 4 豁免块数;缺省 0)。
const CORPORA = [
  {
    slug: 'proven',
    name: 'proven 语料(requires 蕴含两方向;期望 z3 unsat)',
    source: [
      'fn get(buf: Vec[i64], i: i64) -> i64 requires i >= 0 && i < buf.len() {',
      '    return buf[i];',
      '}',
      'fn main() with io { print(str(get([1, 2], 1))); }',
    ].join('\n'),
    expectVerdicts: ['proven', 'proven'],
    expectCheckSats: 2,
    expectSections: ['proven.ming'],
    expectViolated: false,
  },
  {
    slug: 'refuted-sat',
    name: 'refuted 语料(requires n == buf.len();假设集可满足——豁免不适用)',
    source: [
      'fn f(buf: Vec[i64], n: i64) -> i64 requires n == buf.len() {',
      '    return buf[n];',
      '}',
      'fn main() with io { print(str(f([1, 2], 2))); }',
    ].join('\n'),
    expectVerdicts: ['unknown', 'refuted'],
    expectCheckSats: 2,
    expectSections: ['refuted-sat.ming'],
    expectViolated: true,
  },
  {
    slug: 'refuted-unsat',
    name: 'refuted 语料(requires 自身矛盾 n>=1 && m>=1 && n+m<=len && len<=1;§6.2 规则 4 豁免)',
    source: [
      'fn ls(buf: Vec[i64], n: i64, m: i64) -> i64 requires n >= 1 && m >= 1 && n + m <= buf.len() && buf.len() <= 1 {',
      '    return buf[n];',
      '}',
      'fn main() with io { print(str(ls([1], 1, 1))); }',
    ].join('\n'),
    expectVerdicts: ['proven', 'refuted'],
    expectCheckSats: 2,
    expectSections: ['refuted-unsat.ming'],
    expectViolated: true,
    expectExempt: 1, // §6.2 规则 4 豁免必须真实发生(审查 MINOR-1:守预期路径,防语料静默退化)
  },
  {
    slug: 'unknown',
    name: 'unknown 语料(requires n <= buf.len();外部结论不设期望,仅记录)',
    source: [
      'fn g(buf: Vec[i64], n: i64) -> i64 requires n <= buf.len() {',
      '    return buf[n];',
      '}',
      'fn main() with io { print(str(g([1, 2], 0))); }',
    ].join('\n'),
    expectVerdicts: ['unknown', 'unknown'],
    expectCheckSats: 2,
    expectSections: ['unknown.ming'],
    expectViolated: false,
  },
  {
    slug: 'zero',
    name: '零义务语料(有契约无索引点;empty script 诚实声明)',
    source: [
      'fn h(buf: Vec[i64], n: i64) -> i64 requires n >= 0 { return n + 1; }',
      'fn main() with io { print(str(h([1], 0))); }',
    ].join('\n'),
    expectVerdicts: [],
    expectCheckSats: 0,
    expectSections: [], // 零义务脚本"头两行 + ; 无证明义务 + (exit)"——无文件分节(§3.1 不变式 5)
    expectViolated: false,
  },
  {
    slug: 'loop',
    name: 'loop 作用域 proven(范围 for 区间约束入假设集;i$<n> 符号)',
    source: [
      'fn sum(buf: Vec[i64], n: i64) -> i64 requires n == buf.len() {',
      '    let mut s = 0;',
      '    for i in 0..n { s += buf[i]; }',
      '    return s;',
      '}',
      'fn main() with io { print(str(sum([1, 2, 3], 3))); }',
    ].join('\n'),
    expectVerdicts: ['proven', 'proven'],
    expectCheckSats: 2,
    expectSections: ['loop.ming'],
    expectViolated: false,
  },
  {
    slug: 'reserved',
    name: '保留字重写语料(参数 div → 脚本符号 div_v;§3.2 双射;期望 z3 unsat)',
    source: [
      'fn r(div: i64, buf: Vec[i64]) -> i64 requires div >= 0 && div < buf.len() {',
      '    return buf[div];',
      '}',
      'fn main() with io { print(str(r(0, [1]))); }',
    ].join('\n'),
    expectVerdicts: ['proven', 'proven'],
    expectCheckSats: 2,
    expectSections: ['reserved.ming'],
    // 符号面重写(div_v),注释里的索引原文与义务 id 保持用户源码口径(div)——只改脚本符号名。
    expectMentions: ['(declare-const div_v Int)', '(>= div_v 0)', '(not (>= div_v 0))', '索引 div(scope: body)'],
    expectAbsent: ['(declare-const div Int)', '(>= div 0)', '(< div len$buf)'],
    expectViolated: false,
  },
  {
    slug: 'nonlinear',
    name: '不可线性化索引语料(buf[n * n];义务目标不编码——零命令/零 check-sat,§3.4 诚实形态)',
    source: [
      'fn nl(buf: Vec[i64], n: i64) -> i64 requires n >= 0 {',
      '    return buf[n * n];',
      '}',
      'fn main() with io { print(str(nl([1], 1))); }',
    ].join('\n'),
    expectVerdicts: [],
    expectCheckSats: 0,
    expectSections: ['nonlinear.ming'], // 有义务头(未编码),故仍有文件分节
    expectMentions: ['索引 n * n(scope: body)', '索引表达式不可线性化:义务目标未编码(内部未证明;无 (check-sat) 可发射)'],
    expectViolated: false,
  },
  {
    slug: 'multifile',
    name: '多文件分节语料(两 .ming 一次 check;分节顺序 = 命令行顺序,故意非字典序)',
    // 两文件各一条 proven 义务(不同 fn 名),一次 check 产出两节——fixture 锁定分节顺序与内容。
    // 命令行序故意 = 字典逆序(b 在前、a 在后):若实现退化为按文件名排序,分节断言立即红——
    // §3.1 冻结的"按命令行顺序"由此获得判别性守卫(审查 M1:字典升序素材无法区分两者)。
    files: [
      {
        name: 'multifile-b.ming',
        content: [
          'fn pick(buf: Vec[i64], j: i64) -> i64 requires j >= 0 && j < buf.len() {',
          '    return buf[j];',
          '}',
          'fn main() with io { print(str(pick([1, 2], 0))); }',
        ].join('\n'),
      },
      {
        name: 'multifile-a.ming',
        content: [
          'fn get(buf: Vec[i64], i: i64) -> i64 requires i >= 0 && i < buf.len() {',
          '    return buf[i];',
          '}',
          'fn main() with io { print(str(get([1, 2], 1))); }',
        ].join('\n'),
      },
    ],
    expectVerdicts: ['proven', 'proven', 'proven', 'proven'],
    expectCheckSats: 4,
    expectSections: ['multifile-b.ming', 'multifile-a.ming'], // CLI 序(非字典序);按名排序即红
    expectMentions: ['; ---- vc:pick:1 — 索引 j(scope: body)----', '; ---- vc:get:1 — 索引 i(scope: body)----'],
    expectViolated: false,
  },
];

// ---- 工具函数 -------------------------------------------------------------------------------
function probeZ3() {
  const r = spawnSync('z3', ['--version'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.error) return { ok: false, reason: `无法执行 z3 --version:${r.error.message}` };
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
    return { ok: false, reason: `z3 --version 退出码 ${r.status}${tail ? `:${tail}` : ''}` };
  }
  const first = `${r.stdout ?? ''}`.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return { ok: true, version: first ?? '(版本输出为空)' };
}

// 解析脚本结构:逐行扫描,按 (push)…(pop) 收集每个方向块(顺序 = 块序),并记录块前的
// 内部判定注释(协议 §3.4 逐字面:`; 方向 <low|high> — ming 内部判定: <verdict>`);
// check-sat 计数按全文行口径(结构不变式由 §113 自检器守护,本节只消费)。
function parseScript(script) {
  const lines = script.split('\n');
  const blocks = [];
  let cur = null;
  let pending = null; // 最近一条方向判定注释(块头)
  let checkSats = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '(check-sat)') { checkSats += 1; if (cur) cur.checkSat = true; continue; }
    if (line.startsWith('; ---- vc:')) { pending = null; continue; } // 新义务头:清掉上一条残留
    const vm = line.match(/^; 方向 (low|high) .*?内部判定: (proven|refuted|unknown)[(（]/);
    if (vm) { pending = { dir: vm[1], verdict: vm[2] }; continue; }
    if (line === '(push)') {
      cur = { dir: pending?.dir ?? null, verdict: pending?.verdict ?? null, declares: [], asserts: [], checkSat: false };
      blocks.push(cur);
      pending = null;
      continue;
    }
    if (line === '(pop)') { cur = null; continue; }
    if (cur) {
      if (/^\(declare-const \S+ Int\)$/.test(line)) cur.declares.push(line);
      else if (line.startsWith('(assert ')) cur.asserts.push(line);
    }
  }
  return { blocks, checkSats };
}

// 单文件语料简写 → 文件列表(文件名 = <slug>.ming,与既有 fixture 的分节注释逐字兼容);
// 多文件语料按 `files` 数组序写盘并传给 `ming check`(分节顺序 = 命令行顺序,§3.3)。
function corpusFiles(c) {
  return c.files ?? [{ name: `${c.slug}.ming`, content: c.source }];
}

// 文件分节注释(`; ===== 文件:<展示路径> =====`)按出现顺序提取(§3.1 脚本结构 / §3.3 路径口径)。
// 零义务脚本无分节(§3.1 不变式 5)——由语料矩阵的 expectSections:[] 显式登记。
function sectionNamesOf(script) {
  return [...script.matchAll(/^; ===== 文件:(.+) =====$/gm)].map((m) => m[1]);
}

// z3 stdout → 回答序列(每行一个 sat/unsat/unknown;其他行——如 (error ...)——不计数,
// 由"回答行数 ≠ check-sat 数"的断言暴露并打印原始输出)。
function answersOf(stdout) {
  const out = [];
  for (const raw of stdout.split('\n')) {
    const t = raw.trim();
    if (t === 'sat' || t === 'unsat' || t === 'unknown') out.push(t);
  }
  return out;
}

// 假设集自身可满足性核验脚本(协议 §6.2 规则 4 的"先核对")。
// 块结构不变式:假设 assert 在前、取反目标 `(assert (not ...))` 恒为块内最后一条 assert
// (§3.1 结构不变式 2)。去掉它即只剩假设集 H;结构不符 → null(不构造,交给断言具名失败)。
function assumptionsOnlyScript(block) {
  const negAsserts = block.asserts.filter((l) => l.startsWith('(assert (not '));
  const last = block.asserts[block.asserts.length - 1];
  if (negAsserts.length !== 1 || !last || !last.startsWith('(assert (not ')) return null; // 审查 NOTE-1:每块恰一条取反目标且为最后一条
  return [
    '(set-logic QF_LIA)',
    ...block.declares,
    ...block.asserts.slice(0, -1),
    '(check-sat)',
    '(exit)',
  ].join('\n') + '\n';
}

function runZ3(file) {
  return spawnSync('z3', [file], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, windowsHide: true });
}

function brief(r) {
  const out = `${r.stdout ?? ''}`.trim();
  const err = `${r.stderr ?? ''}`.trim();
  return `stdout=${JSON.stringify(out.slice(0, 400))} stderr=${JSON.stringify(err.slice(0, 400))}`;
}

// ---- fixture 层(R-19)------------------------------------------------------------------------
function fixturePath(slug) {
  return path.join(FIXTURE_DIR, `${slug}.smt2`);
}

// 仓库相对展示路径(统一正斜杠:失败消息跨平台逐字可比)。
function relPath(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function fixtureRel(slug) {
  return relPath(fixturePath(slug));
}

// `--no-comments` 比较口径:剥离 `;` 注释行、空行与行尾空白 → 只剩纯命令面。
// 默认(strict)不做任何归一化——逐字节比较。
function normalizeForCompare(text, noComments) {
  if (!noComments) return text;
  const lines = text
    .split(/\r?\n/) // 审查 MINOR-1:CRLF checkout 下命令面模式不因 \r 误红
    .filter((l) => !/^\s*;/.test(l))
    .map((l) => l.replace(/[ \t\r]+$/, ''))
    .filter((l) => l.trim() !== '');
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

// 首处差异(expected = fixture 基准,actual = 本次生成)。行号 1 起;一侧在 EOF 前结束 →
// 对应字段 undefined(由 clip 如实标注),绝不静默判等。
function firstDiff(expected, actual) {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i += 1) {
    if (e[i] === a[i]) continue;
    return { line: i + 1, expected: e[i], actual: a[i] };
  }
  return null;
}

// 差异行截断(截断后文本 ≤ 200 字符,含末尾省略号;EOF 侧具名)。
function clip(line) {
  if (line === undefined) return '(EOF:该行不存在)';
  return line.length > DIFF_CLIP ? `${line.slice(0, DIFF_CLIP - 1)}…` : line;
}

// fixture 阶段:update → 重写并逐文件打印;否则 compare(缺失/不一致 = failLine)。
// 只处理生成成功(scriptOk)的语料:生成失败已具名上报,跳过以免噪声双报。
function verifyFixtures(generated, opts) {
  const { update, noComments, failLine } = opts;
  const eligible = generated.filter((g) => g.scriptOk);
  // 审查 MAJOR-1:更新通道只写"生成阶段全部通过"的语料——结构断言已失败的输出
  // 不得覆盖黄金(否则能把好 fixture 洗成已知异常输出,fixture 门槛自我失效)。
  const writable = generated.filter((g) => g.scriptOk && !g.genFailed);
  let matched = 0;
  let written = 0;
  if (update) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  // 审查 MINOR-3:孤儿 fixture(目录里有、语料里没有)= 失败;slug 改名/删语料会遗留
  // 永不校验的黄金,更新通道也不清理它。
  if (fs.existsSync(FIXTURE_DIR)) {
    const slugs = new Set(CORPORA.map((c) => c.slug));
    for (const f of fs.readdirSync(FIXTURE_DIR).sort()) {
      if (!f.endsWith('.smt2')) continue;
      if (!slugs.has(f.slice(0, -'.smt2'.length))) {
        failLine(`[fixture] 孤儿 fixture ${relPath(path.join(FIXTURE_DIR, f))}(没有同名语料;删除该文件或恢复语料)`);
      }
    }
  }
  // 审查 MAJOR-1:生成阶段失败的语料拒绝写盘,逐条打印跳过原因。
  if (update) {
    for (const g of generated) {
      if (!writable.includes(g)) process.stdout.write(`[fixture] 跳过 ${g.c.slug}(生成阶段失败,拒绝写盘)
`);
    }
  }
  for (const g of (update ? writable : eligible)) {
    const slug = g.c.slug;
    const file = fixturePath(slug);
    const rel = fixtureRel(slug);
    if (update) {
      let prev = null;
      try { prev = fs.readFileSync(file, 'utf8'); } catch { prev = null; }
      fs.writeFileSync(file, g.script, 'utf8'); // 恒写严格全文(LF,无归一化)
      const tag = prev === null ? '新增' : prev === g.script ? '未变' : '变更';
      process.stdout.write(`[fixture] ${tag} ${rel}\n`);
      written += 1;
      continue;
    }
    let fixture = null;
    try {
      fixture = fs.readFileSync(file, 'utf8');
    } catch {
      failLine(`[${slug}] 缺失 fixture ${rel}(运行 node tests/z3_check.mjs --update-fixtures 生成并入库)`);
      continue;
    }
    const want = normalizeForCompare(fixture, noComments);
    const got = normalizeForCompare(g.script, noComments);
    if (want === got) { matched += 1; continue; }
    const d = firstDiff(want, got);
    const mode = noComments ? '--no-comments 命令面已剥离 ; 注释/空行/行尾空白' : '严格逐字节';
    failLine(
      `[${slug}] fixture 不一致 ${rel}(${mode});首处差异第 ${d.line} 行:fixture=${JSON.stringify(clip(d.expected))} 生成=${JSON.stringify(clip(d.actual))}`,
    );
  }
  const all = CORPORA.length;
  if (update) {
    const skippedUpdate = all - writable.length;
    process.stdout.write(`fixture 更新:${written}/${writable.length} 个文件写入 ${relPath(FIXTURE_DIR)}/${skippedUpdate > 0 ? ';' + skippedUpdate + ' 语料因生成阶段失败拒绝写盘' : ''}(更新即审查信号——git diff 逐字节可审)
`);
  } else {
    const scope = eligible.length < all ? `;仅统计生成成功的 ${eligible.length}/${all} 语料` : '';
    if (noComments) {
      process.stdout.write(`fixture 黄金(命令面):${matched}/${eligible.length} 一致(--no-comments;默认模式为严格逐字节)${scope}\n`);
    } else {
      process.stdout.write(`fixture 黄金:${matched}/${eligible.length} 逐字节一致(${relPath(FIXTURE_DIR)}/,严格模式)${scope}\n`);
    }
  }
  return { matched, written, eligible: eligible.length };
}

// ---- 主流程 ---------------------------------------------------------------------------------
function main() {
  // 审查 MINOR-2:拼写错误不得静默降级(如 --no-comment 按严格模式静默跑)。
  const KNOWN_FLAGS = new Set(['--update-fixtures', '--no-comments', '--help', '-h']);
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    process.stderr.write(`未知旗标:${unknown.join(' ')}(用法见 --help)\n`);
    process.exitCode = 1;
    return;
  }
  const updateFixtures = process.argv.includes('--update-fixtures');
  const noComments = process.argv.includes('--no-comments');
  if (updateFixtures && noComments) {
    process.stderr.write('--update-fixtures 与 --no-comments 不能同时使用(更新恒写入严格全文;--no-comments 只影响比较)\n');
    process.exitCode = 1;
    return;
  }

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-z3-check-'));
  const failures = [];
  const failLine = (msg) => {
    failures.push(msg);
    process.stderr.write(`✗ ${msg}\n`);
  };

  // 审查 n5:所有语料共写同一临时目录——跨语料文件重名会互相覆盖,生成前先自检(一行防御)。
  const allNames = CORPORA.flatMap((c) => corpusFiles(c).map((f) => f.name));
  const dupNames = [...new Set(allNames.filter((n, i) => allNames.indexOf(n) !== i))];
  if (dupNames.length > 0) failLine(`语料矩阵文件名跨语料重复:${JSON.stringify(dupNames)}(共享临时目录会互相覆盖)`);

  process.stdout.write('z3-check — Z3 外部消费验证(协议 docs/proof-protocol.md §6)+ SMT-LIB golden fixtures\n');

  // ---- 阶段 A:生成脚本 + 结构断言(不依赖 z3)-----------------------------------------------
  // 相对路径 + cwd=TMP 调用:脚本内 `; ===== 文件:<文件名> =====` 稳定(单文件 = <slug>.ming;
  // 多文件 = files[].name),可与 fixtures 逐字节比对。
  const generated = [];
  for (const c of CORPORA) {
    const files = corpusFiles(c); // 单文件 = <slug>.ming;多文件按 files 数组序(命令行顺序)
    for (const f of files) {
      fs.writeFileSync(path.join(TMP, f.name), f.content.endsWith('\n') ? f.content : `${f.content}\n`, 'utf8');
    }
    const entry = { c, script: null, parsed: null, scriptOk: false, genFailed: false };
    generated.push(entry);
    const before = failures.length;

    // 1) ming check → SMT-LIB 脚本(stdout 纯脚本;违反语料 exit 1 是协议 §4.4 的既有口径)
    const r = spawnSync(process.execPath, [MING, 'check', ...files.map((f) => f.name), '--proof-format', 'smt-lib'], {
      encoding: 'utf8',
      cwd: TMP,
      timeout: SPAWN_TIMEOUT_MS,
      windowsHide: true,
    });
    const expectExit = c.expectViolated ? 1 : 0;
    if (r.error || r.status === null) { failLine(`[${c.slug}] ming check 未能执行:${r.error?.message ?? 'status=null'}`); continue; }
    if (r.status !== expectExit) failLine(`[${c.slug}] ming check 退出码 ${r.status} ≠ 预期 ${expectExit}(协议 §4.4 退出码语义)`);
    const script = r.stdout;
    if (!script.startsWith('(set-logic QF_LIA)\n') || !script.endsWith('(exit)\n')) {
      failLine(`[${c.slug}] ming check stdout 不是完整 SMT 脚本(首行/末行不符):${JSON.stringify(script.slice(0, 160))}`);
      continue;
    }

    // 2) 脚本结构与语料设计对照(文件分节/块数/逐块判定/check-sat 数/形态子串)
    const parsed = parseScript(script);
    const sections = sectionNamesOf(script);
    if (JSON.stringify(sections) !== JSON.stringify(c.expectSections)) {
      failLine(`[${c.slug}] 文件分节 ${JSON.stringify(sections)} ≠ 预期 ${JSON.stringify(c.expectSections)}(§3.3 分节按命令行顺序)`);
    }
    if (c.expectVerdicts.length === 0) {
      // §3.1 不变式 5 / §3.4:无可检目标时不发射任何义务命令(零义务与不可线性化两种诚实形态)。
      // 审查 M2:用**允许列表**(非命令黑名单)——非注释非空行只允许脚本框架的
      // (set-logic QF_LIA) / (set-info :source …) / (exit);(echo)/(set-option)/(declare-fun)/
      // (get-model) 等未列举命令一律红,杜绝"零 check-sat 即静默"路径被 --update-fixtures 洗成黄金。
      const frameworkLine = /^(\(set-logic QF_LIA\)|\(set-info :source .*\)|\(exit\))$/;
      const illegal = script.split('\n').map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith(';') && !frameworkLine.test(l));
      if (illegal.length > 0) {
        failLine(`[${c.slug}] 零义务/未编码脚本只允许框架命令(set-logic/set-info/exit),实际 ${illegal.length} 行:${JSON.stringify(illegal.slice(0, 3))}`);
      }
    }
    if (parsed.blocks.length !== c.expectVerdicts.length) {
      failLine(`[${c.slug}] 方向块数 ${parsed.blocks.length} ≠ 预期 ${c.expectVerdicts.length}(语料形态或脚本结构漂移)`);
    }
    if (parsed.checkSats !== c.expectCheckSats) {
      failLine(`[${c.slug}] check-sat 数 ${parsed.checkSats} ≠ 预期 ${c.expectCheckSats}(语料矩阵显式登记)`);
    }
    if (parsed.checkSats !== parsed.blocks.length) {
      failLine(`[${c.slug}] check-sat 数 ${parsed.checkSats} ≠ 方向块数 ${parsed.blocks.length}(协议 §3.1 不变式 2:每块恰一个)`);
    }
    if (parsed.blocks.some((b) => !b.checkSat)) failLine(`[${c.slug}] 存在缺 (check-sat) 的方向块`);
    c.expectVerdicts.forEach((want, i) => {
      if (parsed.blocks[i] && parsed.blocks[i].verdict !== want) {
        failLine(`[${c.slug}] 块 ${i + 1} 内部判定 ${JSON.stringify(parsed.blocks[i].verdict)} ≠ 预期 ${JSON.stringify(want)}(内部证明器口径漂移)`);
      }
    });
    for (const m of c.expectMentions ?? []) {
      if (!script.includes(m)) failLine(`[${c.slug}] 脚本缺少预期形态子串 ${JSON.stringify(m)}(语料名实不符)`);
    }
    for (const a of c.expectAbsent ?? []) {
      if (script.includes(a)) failLine(`[${c.slug}] 脚本出现禁止形态子串 ${JSON.stringify(a)}(重写/编码面漂移)`);
    }

    entry.script = script;
    entry.parsed = parsed;
    entry.scriptOk = true;
    entry.genFailed = failures.length > before; // 结构断言也计入本语料的生成阶段结论
  }

  // ---- 阶段 B:fixture 黄金(不依赖 z3——本机无 z3 也把确定性门槛带进开发环境)-----------------
  verifyFixtures(generated, { update: updateFixtures, noComments, failLine });

  // ---- 阶段 C:z3 消费验证 ------------------------------------------------------------------
  const probe = probeZ3();
  if (!probe.ok) {
    process.stdout.write(`${SKIP_LINE}\n`);
    process.stdout.write(`原因:${probe.reason}\n`);
    process.stdout.write('提示:CI 的 z3-verify job(ubuntu-latest,apt install z3)会真跑本脚本。\n');
    if (failures.length > 0) {
      process.stderr.write(`\n共 ${failures.length} 项失败(z3 层跳过,fixture/结构层已执行);临时目录留档:${TMP}\n`);
      process.exitCode = 1;
      return;
    }
    fs.rmSync(TMP, { recursive: true, force: true });
    return; // exitCode 默认 0
  }

  process.stdout.write(`z3 版本:${probe.version}\n`);

  let corpusCount = 0;
  let assertedBlocks = 0;
  let unknownBlocks = 0;
  let exemptedBlocks = 0;

  for (const g of generated) {
    const c = g.c;
    corpusCount += 1;
    if (!g.scriptOk) {
      process.stdout.write(`[fail] ${c.name} — 生成阶段失败(见上;跳过 z3)\n`);
      continue;
    }
    const before = failures.length; // 本语料 z3 阶段基线(生成阶段失败另由 g.genFailed 记录)
    const exemptedBefore = exemptedBlocks;
    const parsed = g.parsed;
    const smtFile = path.join(TMP, `${c.slug}.smt2`);

    // 3) z3 消费脚本
    fs.writeFileSync(smtFile, g.script, 'utf8');
    const z = runZ3(smtFile);
    if (z.error || z.status !== 0) {
      failLine(`[${c.slug}] z3 执行失败(status=${z.status ?? 'null'})${z.error ? `:${z.error.message}` : ''};${brief(z)}`);
      process.stdout.write(`[fail] ${c.name} — z3 执行失败\n`);
      continue;
    }
    if (/(^|\n)\s*\(error/.test(z.stdout)) {
      failLine(`[${c.slug}] z3 输出含 (error ...) 行(审查 MINOR-3);${brief(z)}`);
      process.stdout.write(`[fail] ${c.name} — z3 输出含 (error ...)\n`);
      continue;
    }
    if (parsed.checkSats === 0 && z.stdout.trim() !== '') {
      failLine(`[${c.slug}] 零 check-sat 脚本 z3 应输出为空,实际:${brief(z)}`);
      process.stdout.write(`[fail] ${c.name} — 零 check-sat 脚本有输出\n`);
      continue;
    }
    const answers = answersOf(z.stdout);
    if (answers.length !== parsed.checkSats) {
      failLine(`[${c.slug}] z3 回答行数 ${answers.length} ≠ check-sat 数 ${parsed.checkSats};${brief(z)}`);
      process.stdout.write(`[fail] ${c.name} — z3 回答行数不符\n`);
      continue;
    }

    // 4) 逐块对照内部判定(协议 §3.4 注释 ↔ §6.2 解读规则)
    const cols = [];
    for (let i = 0; i < parsed.blocks.length; i += 1) {
      const b = parsed.blocks[i];
      const a = answers[i];
      const tag = `${b.dir ?? '?'}=${b.verdict ?? '?'}→${a}`;
      if (b.verdict === 'proven') {
        assertedBlocks += 1;
        cols.push(tag);
        if (a !== 'unsat') failLine(`[${c.slug}] 块 ${i + 1} (${b.dir}) 内部 proven,z3 应答 ${a}(期望 unsat)`);
      } else if (b.verdict === 'refuted') {
        assertedBlocks += 1;
        if (a === 'sat') { cols.push(tag); continue; }
        if (a === 'unknown') { cols.push(tag); failLine(`[${c.slug}] 块 ${i + 1} (${b.dir}) 内部 refuted,z3 应答 unknown(期望 sat 或豁免 unsat)`); continue; }
        // a === 'unsat':§6.2 规则 4——先核对假设集自身可满足性再下分歧结论
        const hScript = assumptionsOnlyScript(b);
        if (hScript === null) { cols.push(tag); failLine(`[${c.slug}] 块 ${i + 1} (${b.dir}) refuted→unsat,但无法构造假设集核验脚本(结构守卫)`); continue; }
        const hFile = path.join(TMP, `${c.slug}-h${i + 1}.smt2`);
        fs.writeFileSync(hFile, hScript, 'utf8');
        const h = runZ3(hFile);
        const hAns = h.status === 0 ? answersOf(h.stdout) : [];
        if (hAns.length === 1 && hAns[0] === 'unsat') {
          exemptedBlocks += 1;
          cols.push(`${tag}(豁免:假设集自身 unsat)`);
        } else {
          cols.push(`${tag}(假设集核验=${JSON.stringify(hAns)}/status=${h.status})`);
          failLine(`[${c.slug}] 块 ${i + 1} (${b.dir}) refuted→unsat 且假设集自身可满足性核验未得 unsat——真实分歧候选(协议 §6.2 规则 4);${brief(h)}`);
        }
      } else {
        unknownBlocks += 1;
        cols.push(`${tag}(仅记录)`);
      }
    }

    // 审查 MINOR-1:豁免路径必须被真实走到(§6.2 规则 4)——期望值逐语料登记,偏差即失败
    const exemptDelta = exemptedBlocks - exemptedBefore;
    const expectExempt = c.expectExempt ?? 0;
    if (exemptDelta !== expectExempt) {
      failLine(`[${c.slug}] §6.2 规则 4 豁免块数 ${exemptDelta} ≠ 预期 ${expectExempt}(豁免路径未被真实走到或意外触发)`);
    }
    const ok = failures.length === before && !g.genFailed;
    const detail = cols.length > 0 ? cols.join(',') : '零 check-sat';
    process.stdout.write(`${ok ? '[ok]' : '[fail]'} ${c.name} — ${parsed.blocks.length} 块(${detail})\n`);
  }

  // ---- 汇总 ---------------------------------------------------------------------------------
  const pass = failures.length === 0;
  process.stdout.write(`\nz3-check: ${corpusCount} 语料,${assertedBlocks} 块断言,${pass ? 'pass' : 'fail'}\n`);
  if (unknownBlocks > 0 || exemptedBlocks > 0) {
    process.stdout.write(`  (unknown 仅记录 ${unknownBlocks} 块;§6.2 规则 4 豁免 ${exemptedBlocks} 块)\n`);
  }
  if (!pass) {
    process.stderr.write(`\n共 ${failures.length} 项失败;临时目录留档:${TMP}\n`);
    process.exitCode = 1;
    return;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
} else {
  main();
}
