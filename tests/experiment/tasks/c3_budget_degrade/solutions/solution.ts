// C3 资源配额降级 — 参考实现(TypeScript + Node 24)
function main(): number {
  const budget = 95;
  let kept = 0;
  let processed = 0;
  for (let i = 1; i <= 30; i++) {
    const name = "svc-" + String(i * 4 + 1);
    const cost = name.length;
    if (kept + cost > budget) {
      console.log(
        `quota exceeded at record ${i}: kept=${kept} need=${cost} budget=${budget}`
      );
      break;
    }
    kept += cost;
    processed += 1;
    console.log(`R${i} ${name} ok`);
  }
  console.log(`summary processed=${processed} kept_chars=${kept}`);
  return 0;
}

process.exit(main());
