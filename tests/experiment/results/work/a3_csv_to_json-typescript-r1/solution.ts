// a3_csv_to_json — CSV→JSON 转换器
// 用法: node solution.ts <csv 文件路径>
// 方言(固定): 逗号逐字节分隔,无引号无转义;第 1 行为表头;所有值按字符串处理;空字段 = 空串。
// 输出: 单行紧凑 JSON {"rows":[...],"errors":[...]},行尾带换行。

import { readFileSync } from 'node:fs';

function fail(message: string): never {
  process.stderr.write('error: ' + message + '\n');
  process.exit(1);
}

function main(): void {
  const args: string[] = process.argv.slice(2);
  const pathArg: string | undefined = args[0];
  if (pathArg === undefined) {
    fail('missing csv file path argument');
  }

  let text: string | undefined;
  try {
    text = readFileSync(pathArg, 'utf8');
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    fail('cannot read file: ' + pathArg);
  }

  const lines: string[] = text.split('\n');
  // 末尾换行产生的空行不计为一行
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const rowParts: string[] = [];
  const errorParts: string[] = [];
  const headerLine: string | undefined = lines[0];

  if (headerLine !== undefined) {
    const header: string[] = headerLine.split(',');
    const want: number = header.length;
    for (let i = 1; i < lines.length; i++) {
      const line: string = lines[i] ?? '';
      const fields: string[] = line.split(',');
      const got: number = fields.length;
      if (got === want) {
        const cells: string[] = [];
        for (let j = 0; j < want; j++) {
          const key: string = header[j] ?? '';
          const value: string = fields[j] ?? '';
          cells.push(JSON.stringify(key) + ':' + JSON.stringify(value));
        }
        rowParts.push('{' + cells.join(',') + '}');
      } else {
        errorParts.push('{"line":' + String(i + 1) + ',"got":' + String(got) + ',"want":' + String(want) + '}');
      }
    }
  }

  const out: string = '{"rows":[' + rowParts.join(',') + '],"errors":[' + errorParts.join(',') + ']}';
  process.stdout.write(out + '\n');
}

main();
