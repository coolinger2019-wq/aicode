// A4 去重统计 — 参考实现(TypeScript + Node 24)
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function main(): number {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("error: 需要分块目录");
    return 1;
  }
  const dir = args[0];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    console.error("error: 无法读取目录 " + dir);
    return 1;
  }
  const names = entries
    .filter((n) => /^chunk_.*\.txt$/.test(n))
    .sort();
  const counts = new Map<string, number>();
  let total = 0;
  for (const name of names) {
    let content: string;
    try {
      content = readFileSync(path.join(dir, name), "utf8");
    } catch {
      console.error("error: 无法读取 " + name);
      return 1;
    }
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    for (const line of lines) {
      counts.set(line, (counts.get(line) || 0) + 1);
      total += 1;
    }
  }
  const items = [...counts.entries()].sort((a, b) => {
    if (a[1] !== b[1]) {
      return b[1] - a[1];
    }
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  let repeated = 0;
  for (const [, c] of items) {
    if (c > 1) {
      repeated += 1;
    }
  }
  console.log("total=" + total);
  console.log("unique=" + counts.size);
  console.log("repeated=" + repeated);
  for (let t = 0; t < 3 && t < items.length; t++) {
    console.log("top" + (t + 1) + " " + items[t][0] + " " + items[t][1]);
  }
  return 0;
}

process.exit(main());
