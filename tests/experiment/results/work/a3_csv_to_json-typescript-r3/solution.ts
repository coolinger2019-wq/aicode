// a3_csv_to_json — CSV→JSON 转换(固定方言: 逗号逐字节分隔, 无引号无转义)。
// 用法: node solution.ts <csv路径>
// stdout: 单行紧凑 JSON {"rows":[...],"errors":[...]}, 末尾带换行。
// 参数缺失/文件不可读 → stderr 一行 "error: ..." 且退出码 1。

import { readFileSync } from "node:fs";

interface CsvError {
  line: number;
  got: number;
  want: number;
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function jsonStr(s: string): string {
  return JSON.stringify(s);
}

function main(): void {
  const arg: string | undefined = process.argv[2];
  if (arg === undefined) {
    fail("usage: node solution.ts <csv-path>");
  }

  let content: string;
  try {
    content = readFileSync(arg, "utf8");
  } catch (e: unknown) {
    const detail: string = e instanceof Error ? e.message : String(e);
    fail(`cannot read file: ${detail}`);
  }

  // 末尾换行产生的空行不计为一行: 恰剥掉一个结尾 \n。
  const body: string = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines: string[] = body === "" ? [] : body.split("\n");

  const rowParts: string[] = [];
  const errParts: string[] = [];

  if (lines.length > 0) {
    const header: string[] = lines[0].split(",");
    const want: number = header.length;
    for (let i = 1; i < lines.length; i++) {
      const fields: string[] = lines[i].split(",");
      if (fields.length === want) {
        const cells: string[] = [];
        for (let j = 0; j < header.length; j++) {
          cells.push(`${jsonStr(header[j])}:${jsonStr(fields[j])}`);
        }
        rowParts.push(`{${cells.join(",")}}`);
      } else {
        const entry: CsvError = { line: i + 1, got: fields.length, want: want };
        errParts.push(
          `{"line":${entry.line},"got":${entry.got},"want":${entry.want}}`,
        );
      }
    }
  }

  process.stdout.write(
    `{"rows":[${rowParts.join(",")}],"errors":[${errParts.join(",")}]}\n`,
  );
}

main();
