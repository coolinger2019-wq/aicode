// B1 JSON 深合并 — 参考实现(TypeScript + Node 24)
import { readFileSync } from "node:fs";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: Json): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge(a: Json, b: Json): Json {
  if (isObj(a) && isObj(b)) {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(a)) {
      if (k in b) {
        out[k] = merge(a[k], b[k]);
      } else {
        out[k] = a[k];
      }
    }
    for (const k of Object.keys(b)) {
      if (!(k in a)) {
        out[k] = b[k];
      }
    }
    return out;
  }
  return b;
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("error: 需要 <a.json> <b.json>");
    return 1;
  }
  let ca: string;
  let cb: string;
  try {
    ca = readFileSync(args[0], "utf8");
    cb = readFileSync(args[1], "utf8");
  } catch {
    console.error("error: 无法读取输入文件");
    return 1;
  }
  let ja: Json;
  let jb: Json;
  try {
    ja = JSON.parse(ca) as Json;
    jb = JSON.parse(cb) as Json;
  } catch {
    console.error("error: JSON 解析失败");
    return 1;
  }
  if (!isObj(ja) || !isObj(jb)) {
    console.error("error: 顶层必须是对象");
    return 1;
  }
  console.log(JSON.stringify(merge(ja, jb)));
  return 0;
}

process.exit(main());
