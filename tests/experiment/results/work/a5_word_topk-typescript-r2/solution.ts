import { readFileSync } from "node:fs";

function main(args: string[]): number {
  if (args.length < 1) {
    process.stderr.write("error: missing file argument\n");
    return 1;
  }
  const filePath: string = args[0];
  let data: Buffer;
  try {
    data = readFileSync(filePath);
  } catch {
    process.stderr.write(`error: cannot read file: ${filePath}\n`);
    return 1;
  }
  const text: string = data.toString("utf8");
  const words: string[] = text.split(/\s+/).filter((w: string): boolean => w.length > 0);
  const counts = new Map<string, number>();
  for (const w of words) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const entries: [string, number][] = Array.from(counts.entries());
  entries.sort((a: [string, number], b: [string, number]): number => {
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
  });
  const top: [string, number][] = entries.slice(0, 5);
  let out = "";
  for (const [w, c] of top) {
    out += `${w} ${c}\n`;
  }
  process.stdout.write(out);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
