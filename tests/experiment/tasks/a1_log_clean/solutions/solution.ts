// A1 日志清洗 — 参考实现(TypeScript + Node 24)
import { readFileSync } from "node:fs";

const LEVELS = ["INFO", "WARN", "ERROR", "DEBUG"];

function main(): number {
  const arg = process.argv[2];
  if (arg === undefined) {
    console.error("error: 需要日志文件路径");
    return 1;
  }
  let content: string;
  try {
    content = readFileSync(arg, "utf8");
  } catch {
    console.error("error: 无法读取 " + arg);
    return 1;
  }
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const counts: Record<string, number> = { INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 };
  let skipped = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const parts = line.split(" ");
    const level: string = parts[1] ?? "";
    const user = parts.find((p) => p.startsWith("user="));
    const action = parts.find((p) => p.startsWith("action="));
    const isLog =
      parts.length >= 5 &&
      LEVELS.includes(level) &&
      user !== undefined &&
      action !== undefined;
    if (!isLog) {
      skipped += 1;
      continue;
    }
    counts[level] += 1;
    if (level !== "DEBUG") {
      kept.push((user!.split("=")[1] ?? "-") + " " + (action!.split("=")[1] ?? "-"));
    }
  }
  for (const k of kept) {
    console.log(k);
  }
  console.log(
    `summary INFO=${counts["INFO"]} WARN=${counts["WARN"]} ERROR=${counts["ERROR"]} DEBUG=${counts["DEBUG"]} skipped=${skipped}`
  );
  return 0;
}

process.exit(main());
