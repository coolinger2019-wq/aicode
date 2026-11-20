// A2 批量改名 — 参考实现(TypeScript + Node 24)
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function zeroPad2(v: number): string {
  return v < 10 ? "0" + String(v) : String(v);
}

function rule1Target(name: string): string | null {
  const m = /^report_([0-9]+)\.txt$/.exec(name);
  if (!m) {
    return null;
  }
  const digits = m[1];
  if (digits.length > 18) {
    return null; // 超出安全整数范围,按不匹配处理
  }
  return "report-" + zeroPad2(Number(digits)) + ".txt";
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("error: 需要 <输入目录> <输出目录>");
    return 1;
  }
  const inputDir = args[0];
  const outputDir = args[1];
  let entries: string[];
  try {
    entries = readdirSync(inputDir);
  } catch {
    console.error("error: 无法读取输入目录 " + inputDir);
    return 1;
  }
  entries.sort();
  mkdirSync(outputDir, { recursive: true });
  const claimed = new Set<string>();
  for (const name of entries) {
    const r1 = rule1Target(name);
    const target = r1 !== null ? r1 : name.endsWith(".log") ? "logs/" + name : null;
    if (target === null) {
      console.log("SKIP " + name + " nomatch");
      continue;
    }
    if (claimed.has(target)) {
      console.log("SKIP " + name + " conflict " + target);
      continue;
    }
    try {
      const content = readFileSync(path.join(inputDir, name));
      const dst = path.join(outputDir, target);
      if (target.startsWith("logs/")) {
        mkdirSync(path.dirname(dst), { recursive: true });
      }
      writeFileSync(dst, content);
      claimed.add(target);
      console.log((r1 !== null ? "OK " : "DIR ") + name + " -> " + target);
    } catch {
      console.log("SKIP " + name + " nomatch");
    }
  }
  return 0;
}

process.exit(main());
