// CSV -> single-line compact JSON converter.
// Fixed dialect: comma-separated bytes, no quotes/escapes, "\n" line breaks;
// first line is the header, column count = header field count; all values are
// strings (no type conversion); empty field = empty string (legal).

import { readFileSync } from "node:fs";

function die(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function readCsv(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    die(`cannot read file: ${path}`);
  }
}

const args: string[] = process.argv.slice(2);
if (args.length < 1) {
  die("missing csv file path argument");
}
const csvPath: string = args[0]!;

const content: string = readCsv(csvPath);

// Split on "\n"; a trailing newline yields one trailing "" element produced by
// the final newline itself, which does not count as a line.
const lines: string[] = content.split("\n");
if (content.endsWith("\n")) {
  lines.pop();
}

const header: string[] = (lines[0] ?? "").split(",");

// Strings are emitted via JSON.stringify for safe escaping; row objects are
// assembled manually so key order always follows header order (JS objects
// would reorder integer-like keys).
function quote(s: string): string {
  return JSON.stringify(s);
}

const rowChunks: string[] = [];
const errorChunks: string[] = [];

for (let i = 1; i < lines.length; i++) {
  const fields: string[] = lines[i]!.split(",");
  if (fields.length === header.length) {
    const kvs: string[] = [];
    for (let j = 0; j < header.length; j++) {
      kvs.push(`${quote(header[j]!)}:${quote(fields[j]!)}`);
    }
    rowChunks.push(`{${kvs.join(",")}}`);
  } else {
    // Line numbers start at 1 and count the header line (first data row = 2).
    errorChunks.push(
      `{"line":${i + 1},"got":${fields.length},"want":${header.length}}`,
    );
  }
}

// Single line of compact JSON, terminated by a trailing newline.
process.stdout.write(
  `{"rows":[${rowChunks.join(",")}],"errors":[${errorChunks.join(",")}]}\n`
);
