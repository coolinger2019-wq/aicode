// 任务 b1_json_deep_merge — JSON 深合并
// 用法: node solution.ts <文档A路径> <文档B路径>
// 读入两个 JSON 对象文档, 按深合并规则合成一个对象, 向 stdout 输出单行紧凑 JSON(后随换行)。
// 错误(参数不足/文件不可读/JSON 解析失败/顶层非对象)向 stderr 输出一行以 error: 开头的消息, 退出码 1。

import { readFileSync } from "fs";

// JSON 值用联合类型建模(不使用 any)
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

// 把 JSON.parse 的 unknown 结果收窄为 JsonValue
function isJsonValue(v: unknown): v is JsonValue {
  if (v === null) return true;
  if (
    typeof v === "boolean" ||
    typeof v === "number" ||
    typeof v === "string"
  ) {
    return true;
  }
  if (typeof v !== "object") return false;
  if (Array.isArray(v)) {
    const arr: unknown[] = v as unknown[];
    for (const item of arr) {
      if (!isJsonValue(item)) return false;
    }
    return true;
  }
  const rec = v as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const item: unknown = rec[key];
    if (!isJsonValue(item)) return false;
  }
  return true;
}

function isJsonObject(v: JsonValue): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOwnKey(obj: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 统一错误出口: stderr 一行(以 error: 开头), 退出码 1, stdout 保持为空
function errorExit(message: string): never {
  process.stderr.write("error: " + message + "\n");
  process.exit(1);
}

// 读取并解析一个文档; 顶层必须是 JSON 对象
function readObjectDoc(path: string, label: string): JsonObject {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    errorExit("cannot read file " + label + ": " + path);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1); // 去掉可能存在的 BOM
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    errorExit("invalid JSON in file " + label + ": " + path);
  }
  if (!isJsonValue(raw)) {
    errorExit("invalid JSON in file " + label + ": " + path);
  }
  if (!isJsonObject(raw)) {
    errorExit("top level is not a JSON object in file " + label + ": " + path);
  }
  return raw;
}

// 用 defineProperty 写键, 避免 __proto__ 等键触发原型 setter
function setKey(obj: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(obj, key, {
    value: value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// 深合并: 键序 = A 的键序(共有键取合并值, A 独有键取 A 值) + B 独有键(按 B 中出现顺序)
function deepMerge(a: JsonObject, b: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(a)) {
    const aVal: JsonValue | undefined = a[key];
    if (aVal === undefined) continue;
    if (hasOwnKey(b, key)) {
      const bVal: JsonValue | undefined = b[key];
      if (bVal !== undefined && isJsonObject(aVal) && isJsonObject(bVal)) {
        setKey(out, key, deepMerge(aVal, bVal));
      } else if (bVal !== undefined) {
        setKey(out, key, bVal); // 其他任何情况取 B
      } else {
        setKey(out, key, aVal);
      }
    } else {
      setKey(out, key, aVal); // A 独有键保留 A 的值
    }
  }
  for (const key of Object.keys(b)) {
    if (!hasOwnKey(a, key)) {
      const bVal: JsonValue | undefined = b[key];
      if (bVal !== undefined) {
        setKey(out, key, bVal); // B 独有键追加 B 的值
      }
    }
  }
  return out;
}

function main(): void {
  const args: string[] = process.argv.slice(2);
  const pathA: string | undefined = args[0];
  const pathB: string | undefined = args[1];
  if (pathA === undefined || pathB === undefined) {
    errorExit("usage: node solution.ts <docA> <docB>");
  }
  const docA: JsonObject = readObjectDoc(pathA, "A");
  const docB: JsonObject = readObjectDoc(pathB, "B");
  const merged: JsonObject = deepMerge(docA, docB);
  process.stdout.write(JSON.stringify(merged) + "\n");
}

main();
