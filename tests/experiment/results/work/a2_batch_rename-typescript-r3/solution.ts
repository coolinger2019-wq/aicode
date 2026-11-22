// 批量改名:按规则把输入目录中的文件改名后写入输出目录(输入目录只读),
// 并按处理顺序向 stdout 打印改名计划。规则按序匹配(R1/R2/R3),目标占用
// 登记跨规则共享(键 = 相对路径),冲突项跳过且不登记。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// R1 正则:report_<digits>.txt(digits 为 1 位以上十进制数字)
const REPORT_RE: RegExp = /^report_([0-9]+)\.txt$/;
// 64 位有符号整数上限 2^63-1,用于超范围判定(等长数字串逐字比较即数值比较)
const I64_MAX_DIGITS: string = '9223372036854775807';

// R1 目标名:report-<NN>.txt;NN 为数字串数值,不足 2 位左补 0。
// 数值超出 64 位整数范围时返回 null(本条不匹配,落入 R3)。
function rule1Target(name: string): string | null {
  const match: RegExpExecArray | null = REPORT_RE.exec(name);
  if (match === null) {
    return null;
  }
  const digits: string = match[1] ?? '';
  const stripped: string = digits.replace(/^0+/, '');
  if (stripped.length > 19) {
    return null;
  }
  if (stripped.length === 19 && stripped > I64_MAX_DIGITS) {
    return null;
  }
  const valueStr: string = stripped === '' ? '0' : stripped;
  return 'report-' + valueStr.padStart(2, '0') + '.txt';
}

// R2:名称以 .log 结尾 → 写入输出目录的 logs/ 子目录,文件名不变
function isRule2(name: string): boolean {
  return name.endsWith('.log');
}

// 文件名字节序(ASCII)升序;输入文件名全 ASCII,按 UTF-16 码元逐字比较
// 与 ASCII 字节序一致。
function byteOrderCompare(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function writeLine(line: string): void {
  process.stdout.write(line + '\n');
}

function run(args: string[]): number {
  if (args.length < 2) {
    process.stderr.write('error: expected 2 arguments: <input-dir> <output-dir>\n');
    return 1;
  }
  const inputDir: string | undefined = args[0];
  const outputDir: string | undefined = args[1];
  if (inputDir === undefined || outputDir === undefined) {
    process.stderr.write('error: expected 2 arguments: <input-dir> <output-dir>\n');
    return 1;
  }

  let names: string[];
  try {
    names = readdirSync(inputDir);
  } catch {
    process.stderr.write('error: cannot read input directory: ' + inputDir + '\n');
    return 1;
  }

  // 输出目录不存在则创建(含 logs/ 父级);logs/ 本身仅在出现 R2 命中时创建
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch {
    process.stderr.write('error: cannot create output directory: ' + outputDir + '\n');
    return 1;
  }

  const ordered: string[] = names.sort(byteOrderCompare);
  const occupied: Set<string> = new Set<string>();

  for (const name of ordered) {
    const r1Target: string | null = rule1Target(name);
    if (r1Target !== null) {
      if (occupied.has(r1Target)) {
        writeLine('SKIP ' + name + ' conflict ' + r1Target);
      } else {
        const content: Buffer = readFileSync(join(inputDir, name));
        writeFileSync(join(outputDir, r1Target), content);
        occupied.add(r1Target);
        writeLine('OK ' + name + ' -> ' + r1Target);
      }
      continue;
    }
    if (isRule2(name)) {
      const r2Target: string = 'logs/' + name;
      if (occupied.has(r2Target)) {
        writeLine('SKIP ' + name + ' conflict ' + r2Target);
      } else {
        mkdirSync(join(outputDir, 'logs'), { recursive: true });
        const content: Buffer = readFileSync(join(inputDir, name));
        writeFileSync(join(outputDir, r2Target), content);
        occupied.add(r2Target);
        writeLine('DIR ' + name + ' -> ' + r2Target);
      }
      continue;
    }
    writeLine('SKIP ' + name + ' nomatch');
  }

  return 0;
}

process.exitCode = run(process.argv.slice(2));
