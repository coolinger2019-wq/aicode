// 日志清洗:读取日志文件,判定日志行,提取 user/action,过滤 DEBUG,输出保留行与汇总。

type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

const { readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");

function isLevelTag(seg: string): seg is Level {
  return seg === "INFO" || seg === "WARN" || seg === "ERROR" || seg === "DEBUG";
}

function stripPrefix(seg: string, prefix: string): string {
  return seg.slice(prefix.length);
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function extractField(segs: readonly string[], prefix: string): string {
  const hit: string | undefined = segs.find((s: string): boolean => s.startsWith(prefix));
  if (hit === undefined) {
    return "-";
  }
  return stripPrefix(hit, prefix);
}

function main(): void {
  const pathArg: string | undefined = process.argv[2];
  if (pathArg === undefined || pathArg.length === 0) {
    fail("missing log file path argument");
  }
  let content: string;
  try {
    content = readFileSync(pathArg, "utf8");
  } catch {
    fail(`cannot read log file: ${pathArg}`);
  }
  const lines: string[] = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const counts: Record<Level, number> = { INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 };
  let skipped: number = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const segs: string[] = line.split(" ");
    let level: Level | undefined;
    if (segs.length >= 5) {
      const cand: string | undefined = segs[1];
      if (cand !== undefined && isLevelTag(cand)) {
        level = cand;
      }
    }
    const hasUser: boolean = segs.some((s: string): boolean => s.startsWith("user="));
    const hasAction: boolean = segs.some((s: string): boolean => s.startsWith("action="));
    if (level === undefined || !hasUser || !hasAction) {
      skipped += 1;
      continue;
    }
    counts[level] += 1;
    if (level === "DEBUG") {
      continue;
    }
    const userVal: string = extractField(segs, "user=");
    const actionVal: string = extractField(segs, "action=");
    kept.push(`${userVal} ${actionVal}`);
  }
  const summary: string =
    `summary INFO=${counts.INFO} WARN=${counts.WARN} ERROR=${counts.ERROR} DEBUG=${counts.DEBUG} skipped=${skipped}`;
  const outLines: string[] = [...kept, summary];
  process.stdout.write(outLines.join("\n") + "\n");
  process.exit(0);
}

main();
