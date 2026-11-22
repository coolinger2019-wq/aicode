// 去重统计：合并统计分块文本文件中每行的出现次数。
// 用法: node solution.ts <chunk_dir>

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

const CHUNK_FILE_RE = /^chunk_.*\.txt$/;

function fail(message: string): never {
  const singleLine = message.replace(/[\r\n]+/g, ' ');
  process.stderr.write(`error: ${singleLine}\n`);
  process.exit(1);
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 按名称/行内容的字节序（UTF-8 字节）比较。
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function listChunkDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    fail(`cannot read directory: ${dir} (${reasonOf(err)})`);
  }
}

function readChunkFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read file: ${path} (${reasonOf(err)})`);
  }
}

// 按 \n 切行；末尾换行产生的空行不计为一行；空文件为 0 行。
function splitLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

function main(argv: readonly string[]): void {
  if (argv.length < 1) {
    fail('missing argument: expected 1 chunk directory path');
  }
  const dir = argv[0] as string;
  const entries: Dirent[] = listChunkDir(dir);
  const matched: string[] = [];
  for (const entry of entries) {
    if (CHUNK_FILE_RE.test(entry.name)) {
      matched.push(entry.name);
    }
  }
  matched.sort(byteCompare);
  const counts = new Map<string, number>();
  let total = 0;
  for (const name of matched) {
    const text = readChunkFile(join(dir, name));
    for (const line of splitLines(text)) {
      total += 1;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
  let repeated = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      repeated += 1;
    }
  }
  const ranked = Array.from(counts.entries());
  ranked.sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return byteCompare(a[0], b[0]);
  });
  const outLines: string[] = [
    `total=${total}`,
    `unique=${counts.size}`,
    `repeated=${repeated}`,
  ];
  let rank = 0;
  for (const pair of ranked) {
    if (rank >= 3) {
      break;
    }
    rank += 1;
    outLines.push(`top${rank} ${pair[0]} ${pair[1]}`);
  }
  process.stdout.write(outLines.join('\n') + '\n');
}

main(process.argv.slice(2));
