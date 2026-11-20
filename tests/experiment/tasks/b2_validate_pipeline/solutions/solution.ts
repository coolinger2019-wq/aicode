// B2 数据校验管线 — 参考实现(TypeScript + Node 24)
import { readFileSync } from "node:fs";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: Json): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validId(rec: { [k: string]: Json }): boolean {
  const v = rec["id"];
  return typeof v === "number" && v >= 1;
}

function validEmail(rec: { [k: string]: Json }): boolean {
  const v = rec["email"];
  return typeof v === "string" && v.includes("@");
}

function validAge(rec: { [k: string]: Json }): boolean {
  const v = rec["age"];
  return typeof v === "number" && v >= 0 && v <= 150;
}

const ROLES = ["admin", "user", "guest"];

function validRole(rec: { [k: string]: Json }): boolean {
  const v = rec["role"];
  return typeof v === "string" && ROLES.includes(v);
}

function main(): number {
  const arg = process.argv[2];
  if (arg === undefined) {
    console.error("error: 需要记录文件路径");
    return 1;
  }
  let content: string;
  try {
    content = readFileSync(arg, "utf8");
  } catch {
    console.error("error: 无法读取 " + arg);
    return 1;
  }
  let doc: Json;
  try {
    doc = JSON.parse(content) as Json;
  } catch {
    console.error("error: JSON 解析失败");
    return 1;
  }
  if (!Array.isArray(doc)) {
    console.error("error: 顶层必须是数组");
    return 1;
  }
  let ok = 0;
  let failed = 0;
  doc.forEach((item, i) => {
    if (!isObj(item)) {
      console.log(`record ${i + 1} id invalid; email invalid; age invalid; role invalid`);
      failed += 1;
      return;
    }
    const parts: string[] = [];
    if (!validId(item)) {
      parts.push("id invalid");
    }
    if (!validEmail(item)) {
      parts.push("email invalid");
    }
    if (!validAge(item)) {
      parts.push("age invalid");
    }
    if (!validRole(item)) {
      parts.push("role invalid");
    }
    if (parts.length === 0) {
      console.log(`record ${i + 1} ok`);
      ok += 1;
    } else {
      console.log(`record ${i + 1} ` + parts.join("; "));
      failed += 1;
    }
  });
  console.log(`ok=${ok} failed=${failed}`);
  return 0;
}

process.exit(main());
