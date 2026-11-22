// b5_json_path_query:嵌套 JSON 路径查询(TypeScript 5 + Node 24,仅标准库)
// 用法:node solution.ts <JSON文档路径> <查询文件路径>

import { readFileSync } from 'fs';

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

function isObj(v: JsonValue): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isDigits(seg: string): boolean {
  return /^[0-9]+$/.test(seg);
}

function render(v: JsonValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  return JSON.stringify(v);
}

// 从根逐段下钻;取不到 → undefined(JSON 值域中不含 undefined,可作哨兵)
function lookup(root: JsonObject, query: string): JsonValue | undefined {
  let cur: JsonValue = root;
  const segs: string[] = query.split('.');
  for (const seg of segs) {
    if (Array.isArray(cur)) {
      // 段为纯数字且当前值为数组 → 下标(0 起);数字段只对数组当下标
      if (!isDigits(seg)) return undefined;
      const idx: number = Number(seg);
      if (!(idx >= 0 && idx < cur.length)) return undefined;
      const next: JsonValue | undefined = cur[idx];
      if (next === undefined) return undefined;
      cur = next;
    } else if (isObj(cur)) {
      // 数字段不会当对象键
      if (isDigits(seg)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      const next: JsonValue | undefined = cur[seg];
      if (next === undefined) return undefined;
      cur = next;
    } else {
      // 标量上继续下钻 → MISSING
      return undefined;
    }
  }
  return cur;
}

function main(): void {
  const args: string[] = process.argv.slice(2);
  const docPath: string | undefined = args[0];
  const queryPath: string | undefined = args[1];
  if (docPath === undefined || queryPath === undefined) {
    throw new Error('参数少于 2:需要 <JSON文档路径> <查询文件路径>');
  }

  const docText: string = readFileSync(docPath, 'utf8');
  const doc: JsonValue = JSON.parse(docText);
  if (!isObj(doc)) {
    throw new Error('文档顶层不是对象');
  }

  const queryText: string = readFileSync(queryPath, 'utf8');
  const lines: string[] = queryText.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop(); // 末尾空行不计
  }

  const out: string[] = [];
  let found = 0;
  let missing = 0;
  for (const q of lines) {
    const res: JsonValue | undefined = lookup(doc, q);
    if (res === undefined) {
      out.push(q + ' = MISSING');
      missing += 1;
    } else {
      out.push(q + ' = ' + render(res));
      found += 1;
    }
  }
  out.push('found=' + String(found) + ' missing=' + String(missing));
  process.stdout.write(out.join('\n') + '\n');
}

try {
  main();
} catch (e) {
  const raw: string = e instanceof Error && e.message.length > 0 ? e.message : String(e);
  const msg: string = raw.replace(/[\r\n]+/g, ' ').trim();
  process.stderr.write('error: ' + (msg.length > 0 ? msg : '未知错误') + '\n');
  process.exitCode = 1;
}
