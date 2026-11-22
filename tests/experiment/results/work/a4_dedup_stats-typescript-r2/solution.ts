// a4_dedup_stats: 合并统计分块文本文件中每行出现次数,
// 输出 total/unique/repeated 与出现最多的前 3 行。

async function main(): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const fail = (message: string): never => {
    fs.writeSync(2, `error: ${message}\n`);
    process.exit(1);
  };

  // 字节序(UTF-8)比较,保证全序与确定性
  const byteCmp = (a: string, b: string): number => {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  };

  const argv: string[] = process.argv.slice(2);
  if (argv.length === 0) {
    fail('缺少参数: 分块目录路径');
  }
  const dir: string = argv[0]!;

  let entries: import('node:fs').Dirent[] | null = null;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = null;
  }
  if (entries === null) {
    fail(`无法读取目录: ${dir}`);
  }

  // 参与统计的文件 = 名称匹配 chunk_*.txt 的条目,按名称字节序升序;其余条目忽略
  const chunkNames: string[] = [];
  for (const entry of entries) {
    const name: string = entry.name;
    if (name.startsWith('chunk_') && name.endsWith('.txt')) {
      chunkNames.push(name);
    }
  }
  chunkNames.sort(byteCmp);

  const counts = new Map<string, number>();
  let total = 0;

  for (const name of chunkNames) {
    const full: string = path.join(dir, name);
    let content: string | null = null;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      content = null;
    }
    if (content === null) {
      fail(`无法读取文件: ${full}`);
    }
    // 末尾换行产生的空行不计为一行;空文件为 0 行
    let lines: string[];
    if (content.length === 0) {
      lines = [];
    } else {
      lines = content.split('\n');
      if (content.endsWith('\n')) {
        lines.pop();
      }
    }
    for (const line of lines) {
      total += 1;
      const prev: number | undefined = counts.get(line);
      counts.set(line, prev === undefined ? 1 : prev + 1);
    }
  }

  let repeated = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      repeated += 1;
    }
  }

  // 全序: 次数降序;次数并列时按行内容字节序升序
  const ranked: Array<[string, number]> = Array.from(counts.entries());
  ranked.sort((a: [string, number], b: [string, number]): number => {
    if (a[1] !== b[1]) {
      return b[1] - a[1];
    }
    return byteCmp(a[0], b[0]);
  });

  const parts: string[] = [];
  parts.push(`total=${total}`);
  parts.push(`unique=${counts.size}`);
  parts.push(`repeated=${repeated}`);
  let rank = 0;
  for (const pair of ranked) {
    if (rank >= 3) {
      break;
    }
    rank += 1;
    parts.push(`top${rank} ${pair[0]} ${pair[1]}`);
  }

  fs.writeSync(1, parts.join('\n') + '\n');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});
