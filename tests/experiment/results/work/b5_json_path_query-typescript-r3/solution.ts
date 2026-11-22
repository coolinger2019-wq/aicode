// b5_json_path_query — TypeScript 5 / Node 24(仅标准库,单文件)
// 读入 JSON 文档与点路径查询,逐段下钻,按固定规则渲染每条结果并输出汇总。
import { readFileSync } from "node:fs";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const ALL_DIGITS: RegExp = /^[0-9]+$/;

function isRecord(v: unknown): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Outcome = { ok: true; value: JsonValue } | { ok: false };

// 逐段下钻:纯数字段只对数组当下标;其余段只对对象按键取;
// 数字段不当对象键、非数字段不进数组、标量上继续下钻均 → MISSING。
function drill(
  root: { [key: string]: JsonValue },
  query: string,
): Outcome {
  let cur: JsonValue = root;
  const segs: string[] = query.split(".");
  for (let i = 0; i < segs.length; i++) {
    const seg: string = segs[i];
    if (ALL_DIGITS.test(seg)) {
      if (Array.isArray(cur)) {
        const idx: number = Number(seg);
        if (idx < cur.length) {
          cur = cur[idx];
          continue;
        }
      }
      return { ok: false };
    }
    if (isRecord(cur)) {
      if (Object.prototype.hasOwnProperty.call(cur, seg)) {
        cur = cur[seg];
        continue;
      }
    }
    return { ok: false };
  }
  return { ok: true, value: cur };
}

function render(v: JsonValue): string {
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

function readTextFile(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

function fail(msg: string): number {
  process.stderr.write("error: " + msg + "\n");
  return 1;
}

function run(): number {
  const docPath: string | undefined = process.argv[2];
  const queryPath: string | undefined = process.argv[3];
  if (docPath === undefined || queryPath === undefined) {
    return fail("missing arguments (need document path and query file path)");
  }
  const docText: string | undefined = readTextFile(docPath);
  if (docText === undefined) {
    return fail("cannot read document file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(docText);
  } catch {
    return fail("JSON parse failed");
  }
  if (!isRecord(parsed)) {
    return fail("document top level is not an object");
  }
  const root: { [key: string]: JsonValue } = parsed;
  const queryText: string | undefined = readTextFile(queryPath);
  if (queryText === undefined) {
    return fail("cannot read query file");
  }
  const queries: string[] = queryText.split("\n");
  if (queries.length > 0 && queries[queries.length - 1] === "") {
    queries.pop();
  }
  const outLines: string[] = [];
  let found = 0;
  let missing = 0;
  for (let i = 0; i < queries.length; i++) {
    const q: string = queries[i];
    const oc: Outcome = drill(root, q);
    if (oc.ok) {
      found++;
      outLines.push(q + " = " + render(oc.value));
    } else {
      missing++;
      outLines.push(q + " = MISSING");
    }
  }
  outLines.push("found=" + String(found) + " missing=" + String(missing));
  process.stdout.write(outLines.join("\n") + "\n");
  return 0;
}

process.exitCode = run();
