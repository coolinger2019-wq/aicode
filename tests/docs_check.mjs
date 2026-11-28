// tests/docs_check.mjs — 文档数字漂移防护(plan §4.15 T4.4;零依赖,轻量一致性,不跑套件)。
//
// 目的:文档里的数字与"单一事实来源"一致——说的和写的一样。任一不符 → exit 1,
// 输出"哪个文件哪个数字错了"(file:line + 期望值 + 实际值)。CI 每次推送都跑。
//
// 校验项(单一事实来源):
// 1. 版本三处一致:package.json version == bin/ming.js VERSION == GUIDE.md 头部 **版本:vX.Y.Z**;
// 2. README 三语版"最新版本号"一致(单一事实来源 = package.json):
//    a) 状态表"当前版本/Current version"行(2026-11-20 首跑即抓到 v0.89.0 预存漂移三处——
//       本检查存在的理由,架构师裁决维持强制);
//    b) 版本历史表首条 vN(README.md / README.en.md;README.plain.md 无历史表,如实跳过);
// 3. 自举工具数:tools/*.ming 实际文件数 vs README 状态表"**N 个**"断言
//    (README.md / README.plain.md;README.en.md 无工具计数行、GUIDE.md 只载历史修订
//    条目——历史条目如"共 12 个"是版本快照不是当前断言,校验会误报,故不纳入);
// 4. 能力矩阵计数:docs/capabilities.md 判定列 ✅/🟡/❌ 行数 == 42/11/3
//    (数字来源:2026-11-19 架构师复核,capabilities.md 尾注 2026-11-18 复算同口径;v1.2 契约桥行使 🟡 10→11;矩阵行变更必须同步此处);
// 5. README 版本历史表首行版本 == package.json version(README.md / README.en.md);
// 6. AGENTS.md 头部锚定(ADR-017 §5 配套;plan §4.26 观察四"人工提醒"机制化,维护者指令 2026-11-28):
//    a) §1 头部版本行「（当前 vX.Y.Z，1.0 已正式发布）」↔ package.json version;
//    b) §3 套件行「回归套件（N 项，含各版本分节 §1..§M；…）」的 N 与 §M ↔ README.md 回归测试行
//       「| 回归测试 | **N 项全绿**(§1–§M;每次全量运行) |」(两文件措辞不同——全角叙述 vs 表格、§1..§ vs §1–§,
//       数字必须一致)。窄范围纪律:只校验这三处数字,不扩展到整个头部(维护者明示"范围窄、误报低");
//       README.en.md/README.plain.md 的同义行不纳入。
//
// 明确不校验(轻量一致性边界):文档数字与实际套件数的一致(需 6 分钟套件,CI 全量回归另行保证——
// 第 6 项只保证 AGENTS/README 两处文档互一致)、coverage/bench 数字(随复测漂移,属 T5.1 口径)、
// 诊断码总数(随版本增长,无稳定断言)。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const errors = [];
let passCount = 0;

function pass(msg) {
  passCount++;
  console.log(`  ✓ ${msg}`);
}

// 失败:输出"哪个文件哪个数字错了"
function fail(file, line, what, expected, actual) {
  const at = line ? `${file}:${line}` : file;
  errors.push(`${at} ${what}:期望 ${expected},实际 ${actual}`);
  console.error(`  ✗ ${at} ${what}:期望 ${expected},实际 ${actual}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// 在文本中按行找第一个匹配,返回 { line(1 起), match } 或 null
function firstMatch(text, re) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) return { line: i + 1, match: m };
  }
  return null;
}

// ---------- 1. 版本三处一致 ----------
function checkVersions(pkgVersion) {
  console.log('[1] 版本三处一致(package.json == bin/ming.js VERSION == GUIDE 头部)');
  // bin/ming.js VERSION
  const bin = read(path.join('bin', 'ming.js'));
  const binM = bin.match(/^export const VERSION = '(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)';$/m);
  if (!binM) {
    fail('bin/ming.js', null, 'VERSION 声明', `export const VERSION = '${pkgVersion}';`, '未找到 VERSION 声明(或格式漂移)');
  } else if (binM[1] !== pkgVersion) {
    fail('bin/ming.js', firstMatch(bin, /^export const VERSION = /m).line, 'VERSION', pkgVersion, binM[1]);
  } else {
    pass(`bin/ming.js VERSION = ${binM[1]}`);
  }
  // GUIDE 头部 **版本:vX.Y.Z**
  const guide = read('GUIDE.md');
  const guideM = firstMatch(guide, /^\*\*版本:v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)\*\*/);
  if (!guideM) {
    fail('GUIDE.md', 1, '头部版本标注', `**版本:v${pkgVersion}**`, '未找到 `**版本:v…**`');
  } else if (guideM.match[1] !== pkgVersion) {
    fail('GUIDE.md', guideM.line, '头部版本标注', `v${pkgVersion}`, `v${guideM.match[1]}`);
  } else {
    pass(`GUIDE.md 头部 = v${guideM.match[1]}`);
  }
}

// ---------- 2 + 5. README 版本号一致性(状态表当前版本 + 历史表首条) ----------
function checkReadmeVersions(pkgVersion) {
  console.log('[2] README 三语版最新版本号一致(状态表当前版本 + 历史表首条 vs package.json)');
  const files = ['README.md', 'README.en.md', 'README.plain.md'];
  for (const f of files) {
    const text = read(f);
    // a) 状态表"当前版本/Current version"行
    const cur = firstMatch(text, /^\|\s*(?:当前版本|Current version)\s*\|\s*\*\*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)\*\*/);
    if (!cur) {
      fail(f, null, '状态表当前版本行', `**v${pkgVersion}**`, '未找到(表格行缺失或格式漂移)');
    } else if (cur.match[1] !== pkgVersion) {
      fail(f, cur.line, '状态表当前版本', `v${pkgVersion}`, `v${cur.match[1]}`);
    } else {
      pass(`${f}:${cur.line} 当前版本 = v${cur.match[1]}`);
    }
    // b) 版本历史表首条 vN(plain 版无历史表,如实跳过)
    const hist = firstMatch(text, /^\|\s*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)\s*\|/);
    if (hist) {
      if (hist.match[1] !== pkgVersion) {
        fail(f, hist.line, '版本历史表首条', `v${pkgVersion}`, `v${hist.match[1]}`);
      } else {
        pass(`${f}:${hist.line} 历史表首条 = v${hist.match[1]}`);
      }
    } else if (f === 'README.plain.md') {
      pass(`${f} 无版本历史表(人话版口径,跳过首条校验)`);
    } else {
      fail(f, null, '版本历史表首条', `| v${pkgVersion} | …`, '未找到版本历史表行');
    }
  }
}

// ---------- 3. 自举工具数 ----------
function checkToolCount() {
  console.log('[3] 自举工具数(tools/*.ming 实际文件数 vs README 断言)');
  const toolsDir = path.join(ROOT, 'tools');
  const count = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.ming')).length;
  pass(`tools/*.ming 实际 ${count} 个`);
  // README.md 状态表:| 自举工具 | **18 个**(Ming 自写;…) |
  const readme = read('README.md');
  const rm = firstMatch(readme, /^\|\s*自举工具\s*\|\s*\*\*(\d+)\s*个\*\*/);
  if (!rm) {
    fail('README.md', null, '状态表自举工具计数断言', `**${count} 个**`, '未找到(行缺失或格式漂移)');
  } else if (Number(rm.match[1]) !== count) {
    fail('README.md', rm.line, '自举工具数', count, rm.match[1]);
  } else {
    pass(`README.md:${rm.line} 断言 = ${rm.match[1]} 个`);
  }
  // README.plain.md:| 自举工具 | 18 个工具是用 Ming 自己写的… |
  const plain = read('README.plain.md');
  const pm = firstMatch(plain, /^\|\s*自举工具\s*\|\s*(\d+)\s*个工具/);
  if (!pm) {
    fail('README.plain.md', null, '状态表自举工具计数断言', `${count} 个工具`, '未找到(行缺失或格式漂移)');
  } else if (Number(pm.match[1]) !== count) {
    fail('README.plain.md', pm.line, '自举工具数', count, pm.match[1]);
  } else {
    pass(`README.plain.md:${pm.line} 断言 = ${pm.match[1]} 个`);
  }
  // README.en.md / GUIDE.md 无当前计数断言(见文件头注)——如实登记,不校验
  console.log('  · README.en.md / GUIDE.md 无"当前工具数"断言(载于文件头注):不校验');
}

// ---------- 4. 能力矩阵计数 ----------
const CAP_EXPECT = { ok: 42, partial: 11, missing: 3 }; // 来源:2026-11-19 架构师复核(capabilities 尾注 2026-11-18 复算同口径)+ v1.2 契约桥行(🟡,56 行口径)

function checkCapabilityCounts() {
  console.log(`[4] 能力矩阵判定列计数(docs/capabilities.md == ${CAP_EXPECT.ok}✅ ${CAP_EXPECT.partial}🟡 ${CAP_EXPECT.missing}❌)`);
  const text = read(path.join('docs', 'capabilities.md'));
  const counts = { '✅': 0, '🟡': 0, '❌': 0 };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue;
    const fields = lines[i].split('|');
    if (fields.length < 4) continue;
    const verdict = fields[2].trim();
    if (verdict === '判定' || /^-+$/.test(verdict)) continue; // 表头/分隔行
    if (verdict in counts) counts[verdict]++;
  }
  const pairs = [['✅', CAP_EXPECT.ok, counts['✅']], ['🟡', CAP_EXPECT.partial, counts['🟡']], ['❌', CAP_EXPECT.missing, counts['❌']]];
  for (const [sym, want, got] of pairs) {
    if (got !== want) {
      fail('docs/capabilities.md', null, `判定列 ${sym} 行数`, want, got);
    } else {
      pass(`${sym} = ${got}`);
    }
  }
}

// ---------- 6. AGENTS.md 头部锚定(ADR-017 §5;plan §4.26 观察四机制化) ----------
// 一条窄检查,三个子断言(a 版本 / b1 套件数 N / b2 分节上限 §M)。真值:package.json + README.md 回归测试行。
function checkAgentsHeader(pkgVersion) {
  console.log('[6] AGENTS.md 头部锚定(§1 版本行 ↔ package.json;§3 套件行 N/§M ↔ README.md 回归测试行;README.plain 测试数)');
  const readmePlain = read("README.plain.md");
  const SYNC = '版本发布时 AGENTS §1/§3 需同步(plan §4.26 观察四;ADR-017 §5)';
  const agents = read('AGENTS.md');
  // a) §1 头部版本行「（当前 vX.Y.Z，1.0 已正式发布）」——真值 = package.json version
  const vm = firstMatch(agents, /（当前 v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)，/);
  if (!vm) {
    fail('AGENTS.md', null, `§1 头部版本行未找到(${SYNC})`, `（当前 v${pkgVersion}，1.0 已正式发布）`, '行缺失或措辞漂移');
  } else if (vm.match[1] !== pkgVersion) {
    fail('AGENTS.md', vm.line, `头部版本 v${vm.match[1]} ≠ package.json v${pkgVersion}——${SYNC}`, `v${pkgVersion}`, `v${vm.match[1]}`);
  } else {
    pass(`AGENTS.md:${vm.line} §1 头部版本 = v${vm.match[1]}(package.json 锚定)`);
  }
  // b) §3 套件行「回归套件（N 项，含各版本分节 §1..§M；…）」——真值 = README.md 回归测试行(锚定源先取)
  const readme = read('README.md');
  const rm = firstMatch(readme, /^\|\s*回归测试\s*\|\s*\*\*(\d+) 项全绿\*\*\(§1[–—-]§?(\d+)/);
  if (!rm) {
    fail('README.md', null, '回归测试行未找到(AGENTS §3 套件行的锚定源;ADR-017 §5)', '| 回归测试 | **N 项全绿**(§1–§M;…) |', '行缺失或措辞漂移');
    return;
  }
  const am = firstMatch(agents, /回归套件（(\d+) 项，含各版本分节 §1\.\.§(\d+)/);
  if (!am) {
    fail('AGENTS.md', null, `§3 套件行未找到(锚定 README.md:${rm.line} 回归测试行;${SYNC})`, `回归套件（${rm.match[1]} 项，含各版本分节 §1..§${rm.match[2]}；…）`, '行缺失或措辞漂移');
    return;
  }
  // b1) 套件数 N
  if (Number(am.match[1]) !== Number(rm.match[1])) {
    fail('AGENTS.md', am.line, `套件数 N ${am.match[1]} ≠ README.md:${rm.line} 回归行 ${rm.match[1]}——套件扩容时 AGENTS §3 需同步(ADR-017 §5;plan §4.26 观察四)`, `${rm.match[1]} 项`, `${am.match[1]} 项`);
  } else {
    pass(`AGENTS.md:${am.line} §3 套件数 N = ${am.match[1]}(README.md:${rm.line} 回归测试行锚定)`);
  }
  // b2) 分节上限 §M
  if (Number(am.match[2]) !== Number(rm.match[2])) {
    fail('AGENTS.md', am.line, `分节上限 §${am.match[2]} ≠ README.md:${rm.line} 回归行 §${rm.match[2]}——新增分节时 AGENTS §3 需同步(ADR-017 §5;plan §4.26 观察四)`, `§1..§${rm.match[2]}`, `§1..§${am.match[2]}`);
  } else {
    pass(`AGENTS.md:${am.line} §3 分节上限 = §${am.match[2]}(README.md:${rm.line} 回归测试行锚定)`);

  // b3) README.plain.md「自动测试 | **N 项全部通过**」↔ README.md 回归测试行 N(复核 MINOR-2 盲区收口)
  const pm = firstMatch(readmePlain || '', /^\|\s*自动测试\s*\|\s*\*\*(\d+) 项全部通过\*\*/);
  if (!pm) {
    fail('README.plain.md', null, '自动测试行未找到(锚定 README.md 回归测试行)', '| 自动测试 | **N 项全部通过** |', '行缺失或措辞漂移');
  } else if (pm.match[1] !== rm.match[1]) {
    fail('README.plain.md', pm.line, `自动测试 ${pm.match[1]} ≠ README.md:${rm.line} 回归测试行 ${rm.match[1]}(${SYNC})`, `| 自动测试 | **${rm.match[1]} 项全部通过** |`, `实际 ${pm.match[1]}`);
  } else {
    pass(`README.plain.md:${pm.line} 自动测试 N = ${pm.match[1]}(README.md:${rm.line} 锚定)`);
  }
  }
}

// ---------- 主流程 ----------
const pkg = JSON.parse(read('package.json'));
const pkgVersion = pkg.version;
console.log(`docs_check — 文档数字漂移防护(单一事实来源:package.json v${pkgVersion})`);
console.log('');
checkVersions(pkgVersion);
console.log('');
checkReadmeVersions(pkgVersion);
console.log('');
checkToolCount();
console.log('');
checkCapabilityCounts();
console.log('');
checkAgentsHeader(pkgVersion);
console.log('');
if (errors.length > 0) {
  console.log(`docs_check: ${errors.length} 处数字漂移 ✗(见上;文档数字以脚本输出为唯一事实来源,修文档而不是改脚本)`);
  process.exitCode = 1;
} else {
  console.log(`docs_check: ${passCount} 项断言全部一致 ✓`);
}
