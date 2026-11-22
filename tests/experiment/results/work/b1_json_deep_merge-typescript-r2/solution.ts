// JSON deep merge.
// Usage: node solution.ts <documentA> <documentB>
// Reads two JSON object documents, deep-merges them, prints one compact JSON
// line to stdout. On any failure prints a single "error: ..." line to stderr
// and exits with code 1 (stdout stays empty).

import { readFileSync } from "node:fs";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

function isObject(v: JsonValue): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Convert the result of JSON.parse (typed as unknown) into the JsonValue model,
// preserving the key insertion order of plain objects.
function toJsonValue(raw: unknown): JsonValue {
  if (raw === null) return null;
  const ty: string = typeof raw;
  if (ty === "boolean" || ty === "number" || ty === "string") {
    return raw as boolean | number | string;
  }
  if (Array.isArray(raw)) {
    const items: unknown[] = raw as unknown[];
    const arr: JsonValue[] = [];
    for (const item of items) {
      arr.push(toJsonValue(item));
    }
    return arr;
  }
  if (ty === "object") {
    const entries: [string, unknown][] = Object.entries(raw as Record<string, unknown>);
    const obj: JsonObject = {};
    for (const entry of entries) {
      const key: string = entry[0];
      obj[key] = toJsonValue(entry[1]);
    }
    return obj;
  }
  throw new Error("unsupported JSON value");
}

// Deep merge: same key that is an object on both sides merges recursively;
// anything else takes B's value. Key order: A's keys in A's order (unique keys
// keep A's value, shared keys take the merged value), then B's unique keys in
// B's order. Applies recursively to nested objects.
function deepMerge(a: JsonObject, b: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(a)) {
    if (Object.prototype.hasOwnProperty.call(b, key)) {
      const av: JsonValue = a[key];
      const bv: JsonValue = b[key];
      if (isObject(av) && isObject(bv)) {
        out[key] = deepMerge(av, bv);
      } else {
        out[key] = bv;
      }
    } else {
      out[key] = a[key];
    }
  }
  for (const key of Object.keys(b)) {
    if (!Object.prototype.hasOwnProperty.call(a, key)) {
      out[key] = b[key];
    }
  }
  return out;
}

// Read one document, parse it, and require a top-level JSON object.
// Throws Error with a human-readable message on any failure.
function readJsonDocument(path: string): JsonObject {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read file: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON in file: ${path}`);
  }
  const value: JsonValue = toJsonValue(raw);
  if (!isObject(value)) {
    throw new Error(`top level of file is not a JSON object: ${path}`);
  }
  return value;
}

function run(): number {
  const args: string[] = process.argv.slice(2);
  if (args.length < 2) {
    process.stderr.write("error: expected 2 arguments: <documentA> <documentB>\n");
    return 1;
  }
  const pathA: string = args[0];
  const pathB: string = args[1];
  try {
    const a: JsonObject = readJsonDocument(pathA);
    const b: JsonObject = readJsonDocument(pathB);
    const merged: JsonObject = deepMerge(a, b);
    process.stdout.write(JSON.stringify(merged) + "\n");
  } catch (err) {
    const message: string = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = run();
