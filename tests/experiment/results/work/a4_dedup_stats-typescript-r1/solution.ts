// 去重统计:合并统计分块文本中每行的出现次数,输出总量/去重统计与 Top-3。
// 用法: node solution.ts <chunk_dir>
// 参与统计的文件 = 目录中名称匹配 chunk_*.txt 的条目(仅常规文件),
// 按名称字节序(ASCII)升序处理;其余条目忽略。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { Dirent } from 'node:fs';

/** 按字节序(UTF-8 编码字节逐字节)比较两个字符串,返回 -1/0/1。 */
function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 文件名是否匹配 chunk_*.txt(* 匹配零个或多个字符)。 */
function isChunkName(name: string): boolean {
  return name.startsWith('chunk_') && name.endsWith('.txt');
}

/** 向 stderr 输出一行以 error: 开头的消息并以退出码 1 终止;stdout 保持为空。 */
function fail(msg: string): never {
  process.stderr.write('error: ' + msg + '\n');
  process.exit(1);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 列出目录条目;路径不存在、不是目录或读取失败时以 error 终止。 */
function listDir(dir: string): Dirent[] {
  try {
    if (!statSync(dir).isDirectory()) {
      fail('cannot read directory ' + dir);
    }
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    fail('cannot read directory ' + dir + ' (' + describe(err) + ')');
  }
}

/** 读取一个分块文件并返回行数组;末尾换行产生的空行不计为一行。 */
function readChunkLines(dir: string, name: string): string[] {
  const file: string = joinPath(dir, name);
  try {
    let body: string = readFileSync(file, 'utf8');
    if (body.endsWith('\n')) {
      body = body.slice(0, -1);
    }
    if (body.length === 0) {
      return [];
    }
    return body.split('\n');
  } catch (err) {
    fail('cannot read file ' + file + ' (' + describe(err) + ')');
  }
}

function main(): void {
  const args: string[] = process.argv.slice(2);
  const dirArg: string | undefined = args[0];
  if (dirArg === undefined) {
    fail('missing directory argument');
  }
  const dir: string = dirArg;

  const dirents: Dirent[] = listDir(dir);
  const chunks: Dirent[] = dirents.filter((d: Dirent) => isChunkName(d.name) && d.isFile());
  chunks.sort((a: Dirent, b: Dirent) => cmpBytes(a.name, b.name));

  const counts: Map<string, number> = new Map<string, number>();
  let total: number = 0;
  for (const chunk of chunks) {
    const lines: string[] = readChunkLines(dir, chunk.name);
    for (const line of lines) {
      total += 1;
      const prev: number | undefined = counts.get(line);
      counts.set(line, prev === undefined ? 1 : prev + 1);
    }
  }

  let repeated: number = 0;
  counts.forEach((c: number) => {
    if (c > 1) {
      repeated += 1;
    }
  });

  // 全序比较器:次数降序,次数并列时行内容字节序升序。
  const ranked: Array<[string, number]> = Array.from(counts.entries());
  ranked.sort((a: [string, number], b: [string, number]) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return cmpBytes(a[0], b[0]);
  });
  const top: Array<[string, number]> = ranked.slice(0, 3);

  let out: string = 'total=' + String(total) + '\n';
  out += 'unique=' + String(counts.size) + '\n';
  out += 'repeated=' + String(repeated) + '\n';
  for (let i = 0; i < top.length; i += 1) {
    out += 'top' + String(i + 1) + ' ' + top[i][0] + ' ' + String(top[i][1]) + '\n';
  }
  process.stdout.write(out);
}

main();
