// 日志清洗 — a1_log_clean
// 用法: node solution.ts <log-file>

import { readFileSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";

type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

const LEVELS: readonly Level[] = ["INFO", "WARN", "ERROR", "DEBUG"];

function asLevel(seg: string): Level | null {
  for (const lv of LEVELS) {
    if (seg === lv) {
      return lv;
    }
  }
  return null;
}

function fieldValue(segs: readonly string[], prefix: string): string | null {
  for (const seg of segs) {
    if (seg.startsWith(prefix)) {
      return seg.slice(prefix.length);
    }
  }
  return null;
}

function fail(msg: string): number {
  stderr.write(`error: ${msg}\n`);
  return 1;
}

function main(): number {
  if (argv.length < 3) {
    return fail("missing log file argument");
  }
  const path: string = argv[2] as string;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return fail(`cannot read file: ${path}`);
  }

  // 末尾换行产生的空行不计为一行
  let text = content;
  if (text.endsWith("\n")) {
    text = text.slice(0, -1);
  }
  const lines: readonly string[] = text === "" ? [] : text.split("\n");

  const counts: Record<Level, number> = { INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 };
  let skipped = 0;
  const kept: string[] = [];

  for (const line of lines) {
    const segs: string[] = line.split(" ");
    const level: Level | null = segs.length >= 5 ? asLevel(segs[1] as string) : null;
    const user: string | null = level === null ? null : fieldValue(segs, "user=");
    const action: string | null = level === null ? null : fieldValue(segs, "action=");
    if (level === null || user === null || action === null) {
      skipped += 1;
      continue;
    }
    counts[level] += 1;
    if (level === "DEBUG") {
      continue;
    }
    kept.push(`${user} ${action}`);
  }

  let out = "";
  for (const row of kept) {
    out += `${row}\n`;
  }
  const parts: string[] = LEVELS.map((lv) => `${lv}=${String(counts[lv])}`);
  out += `summary ${parts.join(" ")} skipped=${String(skipped)}\n`;
  stdout.write(out);
  return 0;
}

exit(main());
