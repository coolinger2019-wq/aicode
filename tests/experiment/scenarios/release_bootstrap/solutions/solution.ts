// S5 发布打包自举 — 参考实现(TypeScript + Node 24 类型剥离直执行)
// 与 Ming 参考实现同一伪代码(spec §3.2/§3.3):结构门禁(argv/目录/五文件可读/提取)
// 先于一切检查行,任一失败 → stdout 空 + stderr 恰一行 error: 开头 + exit 1;四检查
// 全部执行不短路,FAIL 行 + summary 后 exit 1(不触碰 notes 输出路径);全 OK →
// 模板化 release-notes 写盘(CHANGELOG 首条目体逐字落盘)后 exit 0。
// fixture 域全 BMP 无代理对 → UTF-16 索引与 Ming 码点 index_of/slice_chars 等价
// (粒度条款,spec §4;非 BMP 不触达,gap-log 登记)。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

const EXPECTED_FILES = ["CHANGELOG.md", "cli_source.txt", "guide_head.txt", "package.json", "tag.txt"];

// std.unstr.sanitize_cli_path 校验面复刻(校验不改写):非空且不含 NUL/C0/DEL/C1/双向控制符
function cliPathOk(p: string): boolean {
  if (p === "") return false;
  for (const ch of p) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return false;
    if (c >= 0x202a && c <= 0x202e) return false;
  }
  return true;
}

function isInt(s: string): boolean {
  return /^-?\d+$/.test(s);
}

// 版本统一解析为 (major, minor, patch) 三元组;任一段非整数 → null(归结构门禁)
function versionTriple(v: string): number[] | null {
  const segs = v.split(".");
  if (segs.length !== 3) return null;
  const trip: number[] = [];
  for (const seg of segs) {
    if (!isInt(seg)) return null;
    trip.push(Number(seg));
  }
  return trip;
}

function pkgTriple(content: string): number[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const v = (doc as Record<string, unknown>).version;
  if (typeof v !== "string") return null;
  return versionTriple(v);
}

// 首个满足前缀谓词的行下标(首匹配语义;-1 = 无)
function firstLine(lines: string[], prefix: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(prefix)) return i;
  }
  return -1;
}

function cliTriple(content: string): number[] | null {
  const lines = content.split("\n");
  const idx = firstLine(lines, "const VERSION");
  if (idx < 0) return null;
  const line = lines[idx];
  const q1 = line.indexOf('"');
  if (q1 < 0) return null;
  const rest = line.slice(q1 + 1);
  const q2 = rest.indexOf('"');
  if (q2 < 0) return null;
  return versionTriple(rest.slice(0, q2));
}

function guideTriple(content: string): number[] | null {
  const lines = content.split("\n");
  const idx = firstLine(lines, "### v");
  if (idx < 0) return null;
  const tail = lines[idx].slice(5);
  const pos = tail.indexOf("(");
  if (pos < 0) return null;
  return versionTriple(tail.slice(0, pos));
}

function changelogTriple(content: string): number[] | null {
  const lines = content.split("\n");
  if (lines.length < 1) return null;
  const first = lines[0];
  if (!first.startsWith("## v")) return null;
  const tail = first.slice(4);
  const dash = tail.indexOf(" — ");
  if (dash < 0) return null;
  return versionTriple(tail.slice(0, dash));
}

// CHANGELOG 首条目体:首行之后、下一个 ## 行之前的全部行(保序;notes 体来源)
function changelogBody(content: string): string[] {
  const lines = content.split("\n");
  const body: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    body.push(lines[i]);
  }
  return body;
}

function tagTriple(content: string): number[] | null {
  const t = content.trim();
  if (!t.startsWith("v")) return null;
  return versionTriple(t.slice(1));
}

function tripEq(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null || a.length !== 3 || b.length !== 3) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function render(t: number[]): string {
  return `${t[0]}.${t[1]}.${t[2]}`;
}

function readOpt(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function fail(msg: string): number {
  console.error(msg);
  return 1;
}

function main(): number {
  const argv = process.argv.slice(2);
  // 结构门禁 1:argv 与路径净化(spec §3.1)
  if (argv.length < 2) return fail("error: 需要 <snapshot_dir> <notes_out> 两个参数");
  const snap = argv[0];
  if (!cliPathOk(snap)) return fail("error: 快照目录路径非法");
  const out = argv[1];
  if (!cliPathOk(out)) return fail("error: 输出路径非法");
  if (!existsSync(snap) || !statSync(snap).isDirectory()) {
    return fail(`error: 快照目录不存在或非目录: ${snap}`);
  }

  // 结构门禁 2:五文件逐一可读
  const pkgC = readOpt(snap + "/package.json");
  if (pkgC === null) return fail("error: 快照文件缺失或不可读: package.json");
  const cliC = readOpt(snap + "/cli_source.txt");
  if (cliC === null) return fail("error: 快照文件缺失或不可读: cli_source.txt");
  const guideC = readOpt(snap + "/guide_head.txt");
  if (guideC === null) return fail("error: 快照文件缺失或不可读: guide_head.txt");
  const chgC = readOpt(snap + "/CHANGELOG.md");
  if (chgC === null) return fail("error: 快照文件缺失或不可读: CHANGELOG.md");
  const tagC = readOpt(snap + "/tag.txt");
  if (tagC === null) return fail("error: 快照文件缺失或不可读: tag.txt");

  // 结构门禁 3:提取失败(package 非 JSON/无 version/version 非 str;cli 无 const
  // VERSION 行或无成对引号;guide 无 ### v 行或缺 ( 终止;CHANGELOG 首行非 ## v 形态
  // 或缺 — 分隔;tag 空/无 v 前缀/三段数字不全为整数)
  const pkgT = pkgTriple(pkgC);
  if (pkgT === null) return fail("error: 提取失败: package.json");
  const cliT = cliTriple(cliC);
  if (cliT === null) return fail("error: 提取失败: cli_source.txt");
  const guideT = guideTriple(guideC);
  if (guideT === null) return fail("error: 提取失败: guide_head.txt");
  const chgT = changelogTriple(chgC);
  if (chgT === null) return fail("error: 提取失败: CHANGELOG.md");
  const tagT = tagTriple(tagC);
  if (tagT === null) return fail("error: 提取失败: tag.txt");

  // 四检查(全部执行,不短路;检查行序固定;值全部净域重构)
  let failed = 0;
  const lines: string[] = [];
  if (tripEq(pkgT, cliT) && tripEq(pkgT, guideT)) {
    lines.push("check three_place OK");
  } else {
    failed += 1;
    lines.push(`check three_place FAIL package=${render(pkgT)} cli=${render(cliT)} guide=${render(guideT)}`);
  }
  if (tripEq(chgT, pkgT)) {
    lines.push("check changelog OK");
  } else {
    failed += 1;
    lines.push(`check changelog FAIL changelog=${render(chgT)} version=${render(pkgT)}`);
  }
  if (tripEq(tagT, pkgT)) {
    lines.push("check tag OK");
  } else {
    failed += 1;
    lines.push(`check tag FAIL tag=${render(tagT)} version=${render(pkgT)}`);
  }
  // snapshot_files:期望集之外的条目 → FAIL(extra 名按字节序升序、逗号连接;ASCII 名
  // 域 UTF-16 排序与字节序一致);无效条目名(控制符)跳过不计 extra——fixture 不触达
  const extra: string[] = [];
  for (const name of readdirSync(snap)) {
    if (!cliPathOk(name)) continue;
    if (!EXPECTED_FILES.includes(name)) extra.push(name);
  }
  extra.sort();
  if (extra.length === 0) {
    lines.push("check snapshot_files OK");
  } else {
    failed += 1;
    lines.push(`check snapshot_files FAIL extra=${extra.join(",")}`);
  }
  lines.push(`summary checks=4 failed=${failed} version=${render(pkgT)} tag=v${render(tagT)}`);
  for (const l of lines) console.log(l);
  if (failed !== 0) {
    // FAIL 不触碰输出路径(检查未通过不产出 notes,半成品防混入)
    return 1;
  }

  // release-notes 生成(仅全部检查 OK;LF;文件以单个 \n 结尾)
  let notes = `# Release v${render(pkgT)}\n\ntag: v${render(pkgT)}\nversion: ${render(pkgT)}\nchangelog: ${render(pkgT)}\n\n## Changes\n`;
  for (const b of changelogBody(chgC)) {
    notes += b + "\n";
  }
  try {
    writeFileSync(out, notes, "utf8");
  } catch {
    return fail("error: 无法写入 notes");
  }
  return 0;
}

process.exit(main());
