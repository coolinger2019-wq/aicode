// B5 嵌套 JSON 路径查询 — 参考实现(TypeScript + Node 24)
import { readFileSync } from "node:fs";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: Json): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function renderValue(v: Json): string {
  if (typeof v === "string") {
    return v;
  }
  return JSON.stringify(v);
}

function step(cur: Json, seg: string): Json | undefined {
  if (Array.isArray(cur)) {
    if (/^[0-9]+$/.test(seg)) {
      const idx = Number(seg);
      return idx >= 0 && idx < cur.length ? cur[idx] : undefined;
    }
    return undefined;
  }
  if (isObj(cur)) {
    return cur[seg];
  }
  return undefined;
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("error: 需要 <doc.json> <queries.txt>");
    return 1;
  }
  let docContent: string;
  let qContent: string;
  try {
    docContent = readFileSync(args[0], "utf8");
    qContent = readFileSync(args[1], "utf8");
  } catch {
    console.error("error: 无法读取输入文件");
    return 1;
  }
  let doc: Json;
  try {
    doc = JSON.parse(docContent) as Json;
  } catch {
    console.error("error: JSON 解析失败");
    return 1;
  }
  if (!isObj(doc)) {
    console.error("error: 顶层必须是对象");
    return 1;
  }
  const queries = qContent.split("\n");
  if (queries.length > 0 && queries[queries.length - 1] === "") {
    queries.pop();
  }
  let found = 0;
  let missing = 0;
  for (const query of queries) {
    let cur: Json | undefined = doc;
    for (const seg of query.split(".")) {
      if (cur !== undefined) {
        cur = step(cur, seg);
      }
    }
    if (cur !== undefined) {
      console.log(query + " = " + renderValue(cur));
      found += 1;
    } else {
      console.log(query + " = MISSING");
      missing += 1;
    }
  }
  console.log(`found=${found} missing=${missing}`);
  return 0;
}

process.exit(main());
