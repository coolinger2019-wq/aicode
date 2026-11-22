import { readFileSync } from "node:fs";

function isLevel(seg: string): boolean {
  return seg === "INFO" || seg === "WARN" || seg === "ERROR" || seg === "DEBUG";
}

function main(): number {
  const args: string[] = process.argv.slice(2);
  if (args.length < 1) {
    process.stderr.write("error: missing log file argument\n");
    return 1;
  }
  const filePath: string = args[0]!;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    process.stderr.write("error: cannot read log file: " + filePath + "\n");
    return 1;
  }

  const rawLines: string[] = content.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  let nInfo = 0;
  let nWarn = 0;
  let nError = 0;
  let nDebug = 0;
  let skipped = 0;
  const keptLines: string[] = [];

  for (const line of rawLines) {
    const segs: string[] = line.split(" ");
    const levelSeg: string | undefined = segs[1];
    if (segs.length < 5 || levelSeg === undefined || !isLevel(levelSeg)) {
      skipped += 1;
      continue;
    }
    let userVal: string | undefined;
    let actionVal: string | undefined;
    for (const seg of segs) {
      if (userVal === undefined && seg.startsWith("user=")) {
        userVal = seg.slice(5);
      } else if (actionVal === undefined && seg.startsWith("action=")) {
        actionVal = seg.slice(7);
      }
    }
    if (userVal === undefined || actionVal === undefined) {
      skipped += 1;
      continue;
    }
    if (levelSeg === "INFO") {
      nInfo += 1;
    } else if (levelSeg === "WARN") {
      nWarn += 1;
    } else if (levelSeg === "ERROR") {
      nError += 1;
    } else {
      nDebug += 1;
    }
    if (levelSeg !== "DEBUG") {
      keptLines.push(userVal + " " + actionVal);
    }
  }

  const outLines: string[] = keptLines.slice();
  outLines.push(
    "summary INFO=" + nInfo +
    " WARN=" + nWarn +
    " ERROR=" + nError +
    " DEBUG=" + nDebug +
    " skipped=" + skipped
  );
  process.stdout.write(outLines.join("\n") + "\n");
  return 0;
}

process.exit(main());
