// 资源配额降级:按固定公式生成 30 条记录,以程序内预算规则逐条处理。
// 运行:node solution.ts(无参数)。stdout 格式逐字固定;退出码 0。

const BUDGET: number = 95;
const TOTAL_RECORDS: number = 30;

interface Rec {
  index: number;
  name: string;
  cost: number;
}

function makeRecord(i: number): Rec {
  const name: string = `svc-${i * 4 + 1}`;
  const cost: number = name.length;
  return { index: i, name: name, cost: cost };
}

function main(): void {
  let kept: number = 0;
  let processed: number = 0;

  for (let i = 1; i <= TOTAL_RECORDS; i++) {
    const rec: Rec = makeRecord(i);
    if (kept + rec.cost > BUDGET) {
      console.log(
        `quota exceeded at record ${rec.index}: kept=${kept} need=${rec.cost} budget=${BUDGET}`
      );
      break;
    }
    kept += rec.cost;
    processed += 1;
    console.log(`R${rec.index} ${rec.name} ok`);
  }

  console.log(`summary processed=${processed} kept_chars=${kept}`);
}

main();
