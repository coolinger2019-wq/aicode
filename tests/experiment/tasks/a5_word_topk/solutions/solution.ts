// A5 词频 Top-K — 参考实现(TypeScript + Node 24)
import { readFileSync } from "node:fs";

function main(): number {
  const arg = process.argv[2];
  if (arg === undefined) {
    console.error("error: 需要词频文件");
    return 1;
  }
  let content: string;
  try {
    content = readFileSync(arg, "utf8");
  } catch {
    console.error("error: 无法读取 " + arg);
    return 1;
  }
  const tokens = content.split(/\s+/).filter(Boolean);
  const counts = new Map<string, number>();
  for (const w of tokens) {
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const items = [...counts.entries()].sort((a, b) => {
    if (a[1] !== b[1]) {
      return b[1] - a[1];
    }
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  for (let t = 0; t < 5 && t < items.length; t++) {
    console.log(items[t][0] + " " + items[t][1]);
  }
  return 0;
}

process.exit(main());
