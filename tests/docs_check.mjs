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
// 5. README 版本历史表首行版本 == package.json version(README.md / README.en.md)。
//
// 明确不校验(轻量一致性边界):测试总数(1539 类——需 6 分钟套件,CI 全量回归另行保证)、
// coverage/bench 数字(随复测漂移,属 T5.1 口径)、诊断码总数(随版本增长,无稳定断言)。

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
  // README.md 状态表:| 自举工具 | **17 个**(Ming 自写;…) |
  const readme = read('README.md');
  const rm = firstMatch(readme, /^\|\s*自举工具\s*\|\s*\*\*(\d+)\s*个\*\*/);
  if (!rm) {
    fail('README.md', null, '状态表自举工具计数断言', `**${count} 个**`, '未找到(行缺失或格式漂移)');
  } else if (Number(rm.match[1]) !== count) {
    fail('README.md', rm.line, '自举工具数', count, rm.match[1]);
  } else {
    pass(`README.md:${rm.line} 断言 = ${rm.match[1]} 个`);
  }
  // README.plain.md:| 自举工具 | 17 个工具是用 Ming 自己写的… |
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
if (errors.length > 0) {
  console.log(`docs_check: ${errors.length} 处数字漂移 ✗(见上;文档数字以脚本输出为唯一事实来源,修文档而不是改脚本)`);
  process.exitCode = 1;
} else {
  console.log(`docs_check: ${passCount} 项断言全部一致 ✓`);
}
