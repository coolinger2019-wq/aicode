// S1 日志取证 — 参考实现(TypeScript + Node 24)。
// 与 solution.ming 同一语义:行分类顺序 空行→overlong→ctrl-char→JSON/文本;
// 控制符集合 C0(含 \t)/DEL/C1/双向控制符;值域 [A-Za-z0-9_.-]+;级别整段等值。
import { readFileSync, writeFileSync } from "node:fs";

const LEVELS = new Set(["INFO", "WARN", "ERROR", "DEBUG"]);
const DOMAIN = /^[A-Za-z0-9_.-]+$/;
const OVERLONG = 4096;

interface Outcome {
  kind: 0 | 1 | 2;
  level: string;
  actor: string;
  event: string;
}

function malformed(): Outcome {
  return { kind: 0, level: "", actor: "", event: "" };
}

// 码点口径(char_len 对齐):按代理对步进,不用 for..of/展开(采集器 tsc 缺省 target 无 downlevelIteration)。
function charLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    n += 1;
    i += c >= 0xd800 && c < 0xdc00 ? 2 : 1;
  }
  return n;
}

function isCtrlChar(s: string): boolean {
  for (let i = 0; i < s.length; ) {
    const c = s.codePointAt(i)!;
    if (c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f) || (c >= 0x202a && c <= 0x202e)) {
      return true;
    }
    i += c >= 0x10000 ? 2 : 1;
  }
  return false;
}

function classifyJson(line: string): Outcome {
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    return malformed();
  }
  if (typeof doc !== "object" || doc === null) {
    return malformed();
  }
  const rec = doc as Record<string, unknown>;
  const lvl = rec["level"];
  const act = rec["actor"];
  const evt = rec["event"];
  if (typeof lvl !== "string" || typeof act !== "string" || typeof evt !== "string") {
    return malformed();
  }
  if (!LEVELS.has(lvl) || !DOMAIN.test(act) || !DOMAIN.test(evt)) {
    return malformed();
  }
  if (lvl === "WARN" || lvl === "ERROR") {
    return { kind: 1, level: lvl, actor: act, event: evt };
  }
  return { kind: 2, level: lvl, actor: act, event: evt };
}

function classifyText(clean: string): Outcome {
  const parts = clean.split(" ");
  if (parts.length < 5) {
    return malformed();
  }
  const lvl = parts[1]!;
  const act = parts[2]!;
  const evt = parts[3]!;
  if (!LEVELS.has(lvl) || !DOMAIN.test(act) || !DOMAIN.test(evt)) {
    return malformed();
  }
  if (lvl === "WARN" || lvl === "ERROR") {
    return { kind: 1, level: lvl, actor: act, event: evt };
  }
  return { kind: 2, level: lvl, actor: act, event: evt };
}

function main(): number {
  if (process.argv.length < 4) {
    console.error("error: 需要 <input.log> <report.txt> 两个参数");
    return 1;
  }
  const inPath = process.argv[2]!;
  const outPath = process.argv[3]!;
  let content: string;
  try {
    content = readFileSync(inPath, "utf8");
  } catch {
    console.error("error: 无法读取 " + inPath);
    return 1;
  }
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  let events = 0;
  let rejected = 0;
  let info = 0;
  let skipped = 0;
  const ereport: string[] = [];
  const rreport: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineno = i + 1;
    if (line === "") {
      skipped += 1;
      continue;
    }
    if (charLen(line) > OVERLONG) {
      rejected += 1;
      rreport.push(`R ${lineno} overlong`);
      continue;
    }
    if (isCtrlChar(line)) {
      rejected += 1;
      rreport.push(`R ${lineno} ctrl-char`);
      continue;
    }
    const oc: Outcome = line.startsWith("{") ? classifyJson(line) : classifyText(line);
    if (oc.kind === 1) {
      events += 1;
      ereport.push(`E ${lineno} ${oc.level} ${oc.actor} ${oc.event}`);
    } else if (oc.kind === 2) {
      info += 1;
    } else {
      rejected += 1;
      rreport.push(`R ${lineno} malformed`);
    }
  }
  let report = "report " + inPath + "\n";
  for (const e of ereport) {
    report += e + "\n";
  }
  for (const r of rreport) {
    report += r + "\n";
  }
  try {
    writeFileSync(outPath, report, "utf8");
  } catch {
    console.error("error: 无法写入报告 " + outPath);
    return 1;
  }
  console.log(`summary events=${events} rejected=${rejected} info=${info} skipped=${skipped} total=${lines.length}`);
  return 0;
}

process.exit(main());
