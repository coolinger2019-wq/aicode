import { readFileSync } from "node:fs";

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e: unknown) {
    const detail: string = e instanceof Error ? e.message : String(e);
    return fail(`cannot read file: ${detail}`);
  }
}

function compareEntries(a: [string, number], b: [string, number]): number {
  if (b[1] !== a[1]) {
    return b[1] - a[1];
  }
  if (a[0] < b[0]) {
    return -1;
  }
  if (a[0] > b[0]) {
    return 1;
  }
  return 0;
}

function main(): void {
  const path: string | undefined = process.argv[2];
  if (path === undefined) {
    fail("missing file argument");
    return;
  }
  const content: string = readText(path);
  const words: string[] = content
    .split(/\s+/)
    .filter((w: string): boolean => w.length > 0);
  const counts = new Map<string, number>();
  for (const w of words) {
    const prev: number | undefined = counts.get(w);
    counts.set(w, prev === undefined ? 1 : prev + 1);
  }
  const entries: [string, number][] = Array.from(counts.entries());
  entries.sort(compareEntries);
  let out = "";
  const top: [string, number][] = entries.slice(0, 5);
  for (const [w, c] of top) {
    out += `${w} ${String(c)}\n`;
  }
  process.stdout.write(out);
}

main();
