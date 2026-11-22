// 嵌套 JSON 路径查询
// 用法: node solution.ts <doc.json> <queries.txt>

import { readFileSync } from "node:fs";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function isJsonObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type StepResult = { hit: true; value: JsonValue } | { hit: false };

// 按点路径逐段下钻;任何一步取不到都返回 miss。
function lookup(root: JsonValue, path: string): StepResult {
  let cur: JsonValue = root;
  for (const seg of path.split(".")) {
    if (/^[0-9]+$/.test(seg)) {
      // 数字段只对数组当下标,不会当对象键。
      if (!Array.isArray(cur)) {
        return { hit: false };
      }
      const idx: number = Number(seg);
      const next: JsonValue | undefined = cur[idx];
      if (next === undefined || idx < 0 || idx >= cur.length) {
        return { hit: false };
      }
      cur = next;
    } else {
      if (!isJsonObject(cur)) {
        return { hit: false };
      }
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
        return { hit: false };
      }
      const next: JsonValue | undefined = cur[seg];
      if (next === undefined) {
        return { hit: false };
      }
      cur = next;
    }
  }
  return { hit: true, value: cur };
}

function renderValue(v: JsonValue): string {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number") {
    return String(v);
  }
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  return JSON.stringify(v);
}

function fail(msg: string): void {
  process.stderr.write("error: " + msg + "\n");
  process.exitCode = 1;
}

function main(): void {
  const args: string[] = process.argv.slice(2);
  if (args.length < 2) {
    fail("usage: node solution.ts <doc.json> <queries.txt>");
    return;
  }
  const docPath: string = args[0];
  const queryPath: string = args[1];

  let docText: string;
  try {
    docText = readFileSync(docPath, "utf8");
  } catch (err) {
    fail("cannot read document file: " + docPath);
    return;
  }

  let doc: JsonValue;
  try {
    doc = JSON.parse(docText) as JsonValue;
  } catch (err) {
    fail("invalid JSON in document file: " + docPath);
    return;
  }

  if (!isJsonObject(doc)) {
    fail("top-level JSON value is not an object");
    return;
  }

  let queryText: string;
  try {
    queryText = readFileSync(queryPath, "utf8");
  } catch (err) {
    fail("cannot read query file: " + queryPath);
    return;
  }

  // 按 \n 分行;末尾空行不计;行尾可能的 \r 去掉(合法查询段不含 \r)。
  const rawLines: string[] = queryText.split("\n");
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  const queries: string[] = [];
  for (const line of rawLines) {
    queries.push(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  const outLines: string[] = [];
  let found: number = 0;
  let missing: number = 0;
  for (const q of queries) {
    const r: StepResult = lookup(doc, q);
    if (r.hit) {
      found += 1;
      outLines.push(q + " = " + renderValue(r.value));
    } else {
      missing += 1;
      outLines.push(q + " = MISSING");
    }
  }
  outLines.push("found=" + String(found) + " missing=" + String(missing));
  process.stdout.write(outLines.join("\n") + "\n");
}

main();
