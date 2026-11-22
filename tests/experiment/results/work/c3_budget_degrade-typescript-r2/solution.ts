// 资源配额降级：按公式生成 30 条记录，逐条处理，程序内预算规则决定停止点。
// 输出逐字固定：R<i> <name> ok / quota exceeded ... / summary ...

const BUDGET: number = 95;
const TOTAL_RECORDS: number = 30;

function main(): void {
  let kept: number = 0;
  let processed: number = 0;

  for (let i: number = 1; i <= TOTAL_RECORDS; i++) {
    const name: string = "svc-" + String(i * 4 + 1);
    const cost: number = name.length;

    if (kept + cost > BUDGET) {
      console.log(
        "quota exceeded at record " + String(i) +
        ": kept=" + String(kept) +
        " need=" + String(cost) +
        " budget=95",
      );
      break;
    }

    kept += cost;
    processed += 1;
    console.log("R" + String(i) + " " + name + " ok");
  }

  console.log(
    "summary processed=" + String(processed) +
    " kept_chars=" + String(kept),
  );
}

main();
