// A3 CSV→JSON — 参考实现(TypeScript + Node 24)
import { readFileSync } from "node:fs";

function main(): number {
  const arg = process.argv[2];
  if (arg === undefined) {
    console.error("error: 需要 CSV 文件路径");
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
  const rows: Record<string, string>[] = [];
  const errors: { line: number; got: number; want: number }[] = [];
  if (lines.length > 0) {
    const cols = lines[0].split(",");
    const want = cols.length;
    for (let i = 1; i < lines.length; i++) {
      const fields = lines[i].split(",");
      if (fields.length === want) {
        const row: Record<string, string> = {};
        for (let j = 0; j < cols.length; j++) {
          row[cols[j]] = fields[j];
        }
        rows.push(row);
      } else {
        errors.push({ line: i + 1, got: fields.length, want });
      }
    }
  }
  console.log(JSON.stringify({ rows, errors }));
  return 0;
}

process.exit(main());
