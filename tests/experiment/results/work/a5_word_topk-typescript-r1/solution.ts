import { readFileSync } from "node:fs";

const K: number = 5;

function fail(message: string): number {
  process.stderr.write("error: " + message + "\n");
  return 1;
}

function main(): number {
  const args: string[] = process.argv.slice(2);
  if (args.length < 1) {
    return fail("missing file argument");
  }
  const path: string = args[0];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return fail("cannot read file: " + path);
  }

  const words: string[] = text
    .split(/\s+/)
    .filter((w: string): boolean => w.length > 0);

  const counts: Map<string, number> = new Map<string, number>();
  for (const w of words) {
    const prev: number | undefined = counts.get(w);
    counts.set(w, prev === undefined ? 1 : prev + 1);
  }

  const entries: Array<[string, number]> = Array.from(counts.entries());
  entries.sort((a: [string, number], b: [string, number]): number => {
    if (a[1] !== b[1]) {
      return b[1] - a[1];
    }
    if (a[0] < b[0]) {
      return -1;
    }
    if (a[0] > b[0]) {
      return 1;
    }
    return 0;
  });

  const top: Array<[string, number]> = entries.slice(0, K);
  const lines: string[] = top.map(
    (e: [string, number]): string => e[0] + " " + String(e[1]),
  );
  const out: string = lines.length === 0 ? "" : lines.join("\n") + "\n";
  process.stdout.write(out);
  return 0;
}

process.exitCode = main();
