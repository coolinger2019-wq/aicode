// 数据校验管线:读取 JSON 记录数组,按固定 schema 校验,输出逐记录结果与汇总。
// 用法: node solution.ts <记录文件路径>
// Schema(检查顺序固定为 id → email → age → role,全字段检查、不短路):
//   id    必须存在、为数值、且 >= 1
//   email 必须存在、为字符串、且包含 @
//   age   必须存在、为数值、且 0 <= age <= 150
//   role  必须存在、为字符串、且取值 ∈ {admin, user, guest}(整串等值)

import { readFileSync } from 'fs';

interface FieldCheck {
  readonly name: string;
  readonly valid: (v: unknown) => boolean;
}

const CHECKS: readonly FieldCheck[] = [
  { name: 'id', valid: (v: unknown): boolean => typeof v === 'number' && v >= 1 },
  {
    name: 'email',
    valid: (v: unknown): boolean => typeof v === 'string' && v.includes('@'),
  },
  {
    name: 'age',
    valid: (v: unknown): boolean => typeof v === 'number' && v >= 0 && v <= 150,
  },
  {
    name: 'role',
    valid: (v: unknown): boolean => v === 'admin' || v === 'user' || v === 'guest',
  },
];

function fail(msg: string): void {
  process.stderr.write(`error: ${msg}\n`);
}

function fieldValue(rec: unknown, key: string): unknown {
  if (typeof rec !== 'object' || rec === null) {
    return undefined;
  }
  const obj = rec as Record<string, unknown>;
  return obj[key];
}

function main(): number {
  const argv: string[] = process.argv.slice(2);
  const path: string | undefined = argv[0];
  if (path === undefined) {
    fail('缺少参数: 需要记录文件路径');
    return 1;
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    fail(`文件不可读: ${path}`);
    return 1;
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    fail('JSON 解析失败');
    return 1;
  }
  if (!Array.isArray(parsed)) {
    fail('顶层不是 JSON 数组');
    return 1;
  }
  const records: readonly unknown[] = parsed;
  const lines: string[] = [];
  let okCount = 0;
  let failedCount = 0;
  for (let i = 0; i < records.length; i++) {
    const num: number = i + 1;
    const rec: unknown = records[i];
    const bad: string[] = [];
    for (const c of CHECKS) {
      if (!c.valid(fieldValue(rec, c.name))) {
        bad.push(`${c.name} invalid`);
      }
    }
    if (bad.length === 0) {
      lines.push(`record ${num} ok`);
      okCount += 1;
    } else {
      lines.push(`record ${num} ${bad.join('; ')}`);
      failedCount += 1;
    }
  }
  lines.push(`ok=${okCount} failed=${failedCount}`);
  let out = '';
  for (const line of lines) {
    out += `${line}\n`;
  }
  process.stdout.write(out);
  return 0;
}

process.exitCode = main();
