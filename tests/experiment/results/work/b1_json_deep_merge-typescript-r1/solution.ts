// JSON 深合并 —— node solution.ts <文档A路径> <文档B路径>
// 读入两个顶层为 JSON 对象的文档,按深合并规则输出单行紧凑 JSON(后随换行)。
// 错误(参数不足/文件不可读/解析失败/顶层非对象)时向 stderr 输出一行以
// error: 开头的消息,退出码 1,stdout 保持为空。

import { readFileSync } from "node:fs";

type JsonArray = JsonValue[];

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue = null | boolean | number | string | JsonArray | JsonObject;

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[\r\n]+/g, " ");
}

// 深合并规则:共有键两边都是对象 → 递归深合并;其他任何情况 → 取 B。
// A 独有键保留 A 值;B 独有键追加 B 值。
// 键序 = A 的键按 A 中出现顺序(独有键取 A 值,共有键取合并值),
// 然后追加 B 独有键(按 B 中出现顺序)。递归对象同样适用。
function deepMerge(a: JsonObject, b: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(a)) {
    if (Object.prototype.hasOwnProperty.call(b, key)) {
      const av = a[key] as JsonValue;
      const bv = b[key] as JsonValue;
      if (isJsonObject(av) && isJsonObject(bv)) {
        out[key] = deepMerge(av, bv);
      } else {
        out[key] = bv;
      }
    } else {
      out[key] = a[key] as JsonValue;
    }
  }
  for (const key of Object.keys(b)) {
    if (!Object.prototype.hasOwnProperty.call(a, key)) {
      out[key] = b[key] as JsonValue;
    }
  }
  return out;
}

function loadJsonObject(path: string, label: string): JsonObject {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err: unknown) {
    throw new Error(`无法读取${label}文档(${path}): ${errText(err)}`);
  }
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch (err: unknown) {
    throw new Error(`${label}文档 JSON 解析失败(${path}): ${errText(err)}`);
  }
  if (!isJsonObject(value)) {
    throw new Error(`${label}文档顶层不是 JSON 对象(${path})`);
  }
  return value;
}

function run(): string {
  const args: string[] = process.argv.slice(2);
  if (args.length < 2) {
    throw new Error("参数不足:需要 2 个命令行参数(文档A路径 文档B路径)");
  }
  const docA = loadJsonObject(args[0] as string, "A");
  const docB = loadJsonObject(args[1] as string, "B");
  return JSON.stringify(deepMerge(docA, docB));
}

try {
  process.stdout.write(run() + "\n");
} catch (err: unknown) {
  process.stderr.write(`error: ${errText(err)}\n`);
  process.exit(1);
}
