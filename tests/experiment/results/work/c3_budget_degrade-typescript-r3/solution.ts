const BUDGET: number = 95;
const TOTAL_RECORDS: number = 30;

function recordName(i: number): string {
  return "svc-" + String(i * 4 + 1);
}

function main(): void {
  const lines: string[] = [];
  let kept: number = 0;
  let processed: number = 0;

  for (let i = 1; i <= TOTAL_RECORDS; i++) {
    const name: string = recordName(i);
    const cost: number = name.length;
    if (kept + cost > BUDGET) {
      lines.push(
        "quota exceeded at record " + String(i) +
        ": kept=" + String(kept) +
        " need=" + String(cost) +
        " budget=" + String(BUDGET)
      );
      break;
    }
    kept += cost;
    processed = i;
    lines.push("R" + String(i) + " " + name + " ok");
  }

  lines.push(
    "summary processed=" + String(processed) + " kept_chars=" + String(kept)
  );

  process.stdout.write(lines.join("\n") + "\n");
}

main();
