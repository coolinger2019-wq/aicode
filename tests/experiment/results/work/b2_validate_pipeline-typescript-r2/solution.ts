// 数据校验管线:读取 JSON 记录数组,按固定 schema 逐条校验,输出逐记录结果行与汇总。
// 运行: node solution.ts <记录文件路径>
// 规则:字段检查顺序 id → email → age → role,全字段检查、不短路;
//       无效字段按检查顺序以 "; " 连接;汇总 "ok=<n> failed=<n>"。
// 错误:参数缺失/文件不可读/JSON 解析失败/顶层非数组 → stderr 一行 "error: ..." 且退出码 1。

import { readFileSync } from "node:fs";
// process 用 @types/node 的全局声明(默认导入在无 esModuleInterop 的 strict 配置下不通过)。

/** 应用级错误:由顶层 catch 输出 "error: <消息>" 并以退出码 1 结束。 */
class AppError extends Error {}

/** 是否为普通 JSON 对象(非 null、非数组)。 */
function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function main(): void {
  const args: string[] = process.argv.slice(2);
  if (args.length < 1) {
    throw new AppError("missing argument: record file path");
  }
  const filePath: string = args[0] as string;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new AppError(`cannot read file: ${filePath}`);
  }
  // 容错:去掉 UTF-8 BOM(JSON.parse 不接受 BOM)。
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError("invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new AppError("top-level JSON value is not an array");
  }
  const records: unknown[] = parsed;

  const lines: string[] = [];
  let okCount: number = 0;
  let failedCount: number = 0;

  for (let i: number = 0; i < records.length; i += 1) {
    const idx: number = i + 1;
    const rec: unknown = records[i];
    const obj: Record<string, unknown> | null = isJsonObject(rec) ? rec : null;
    const get = (name: string): unknown => (obj === null ? undefined : obj[name]);

    const invalid: string[] = [];

    // 检查顺序固定:id → email → age → role;全字段检查、不短路。
    const idVal: unknown = get("id");
    if (typeof idVal !== "number" || !(idVal >= 1)) {
      invalid.push("id");
    }

    const emailVal: unknown = get("email");
    if (typeof emailVal !== "string" || !emailVal.includes("@")) {
      invalid.push("email");
    }

    const ageVal: unknown = get("age");
    if (typeof ageVal !== "number" || !(ageVal >= 0 && ageVal <= 150)) {
      invalid.push("age");
    }

    const roleVal: unknown = get("role");
    if (
      typeof roleVal !== "string" ||
      (roleVal !== "admin" && roleVal !== "user" && roleVal !== "guest")
    ) {
      invalid.push("role");
    }

    if (invalid.length === 0) {
      lines.push(`record ${idx} ok`);
      okCount += 1;
    } else {
      const parts: string[] = invalid.map((name: string): string => `${name} invalid`);
      lines.push(`record ${idx} ${parts.join("; ")}`);
      failedCount += 1;
    }
  }

  lines.push(`ok=${okCount} failed=${failedCount}`);
  process.stdout.write(lines.join("\n") + "\n");
}

try {
  main();
} catch (err: unknown) {
  const msg: string = err instanceof AppError ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exitCode = 1;
}
