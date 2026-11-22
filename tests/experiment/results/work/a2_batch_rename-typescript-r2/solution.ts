// 批量改名:按规则把输入目录的文件改名/归档写入输出目录(输入目录只读),
// 并按处理顺序向 stdout 打印改名计划。
// 用法:node solution.ts <input-dir> <output-dir>

import { mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const R1_RE = /^report_[0-9]+\.txt$/;
// 有符号 64 位整数上限,用于 R1 数值范围判定(数值超出则 R1 不匹配,落入 R3)
const I64_MAX = '9223372036854775807';

// 去掉前导 0,得到规范十进制串(全 0 则为 "0")
function canonDigits(digits: string): string {
  const stripped = digits.replace(/^0+/, '');
  return stripped.length === 0 ? '0' : stripped;
}

// 规范十进制串(非负)的数值是否在有符号 64 位整数范围内
function withinI64(canon: string): boolean {
  if (canon.length > I64_MAX.length) return false;
  if (canon.length < I64_MAX.length) return true;
  return canon <= I64_MAX;
}

// 文件名按字节序(ASCII)升序比较
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// 同步写满 fd(防管道部分写)
function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    off += writeSync(fd, buf, off, buf.length - off);
  }
}

// 列出输入目录下的文件名(仅常规文件);目录不可读则报错
function listFileNames(inDir: string): string[] {
  try {
    const dirents = readdirSync(inDir, { withFileTypes: true });
    return dirents.filter((d) => d.isFile()).map((d) => d.name);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error('cannot read input directory: ' + inDir + ' (' + why + ')');
  }
}

function run(): number {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    throw new Error('expected 2 arguments (input-dir output-dir), got ' + String(args.length));
  }
  const inDir = args[0] ?? '';
  const outDir = args[1] ?? '';

  const names = listFileNames(inDir);
  names.sort(byteCompare);

  // 目标占用登记(键 = 相对路径,正斜杠),以"成功写入的计划项"为准
  const occupied = new Set<string>();
  const plan: string[] = [];

  for (const name of names) {
    let matched: 'R1' | 'R2' | 'R3' = 'R3';
    let target = '';
    if (R1_RE.test(name)) {
      const canon = canonDigits(name.slice(7, name.length - 4)); // 去掉 "report_" 与 ".txt"
      if (withinI64(canon)) {
        const nn = canon.length < 2 ? '0' + canon : canon;
        matched = 'R1';
        target = 'report-' + nn + '.txt';
      }
    }
    if (matched === 'R3' && name.endsWith('.log')) {
      matched = 'R2';
      target = 'logs/' + name;
    }
    if (matched === 'R3') {
      plan.push('SKIP ' + name + ' nomatch');
      continue;
    }
    if (occupied.has(target)) {
      plan.push('SKIP ' + name + ' conflict ' + target);
      continue;
    }
    const content = readFileSync(join(inDir, name));
    const abs = matched === 'R2' ? join(outDir, 'logs', name) : join(outDir, target);
    mkdirSync(dirname(abs), { recursive: true }); // 输出目录与 logs/ 不存在则创建
    writeFileSync(abs, content); // 原文件内容字节不变
    occupied.add(target);
    plan.push((matched === 'R1' ? 'OK ' : 'DIR ') + name + ' -> ' + target);
  }

  if (plan.length > 0) {
    writeAll(1, plan.join('\n') + '\n');
  }
  return 0;
}

try {
  process.exit(run());
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  writeAll(2, 'error: ' + msg + '\n');
  process.exit(1);
}
