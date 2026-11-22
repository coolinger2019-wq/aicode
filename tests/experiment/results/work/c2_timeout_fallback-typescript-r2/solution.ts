// 任务:超时与降级 —— 两个子任务,父任务带超时等待(Promise.race)。

function childProduce(delayMs: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, delayMs);
  });
}

function timeoutSignal(limitMs: number): Promise<"timeout"> {
  return new Promise<"timeout">((resolve) => {
    setTimeout(() => {
      resolve("timeout");
    }, limitMs);
  });
}

function raceWithTimeout(
  child: Promise<number>,
  limitMs: number,
): Promise<number | "timeout"> {
  return Promise.race([child, timeoutSignal(limitMs)]);
}

async function main(): Promise<void> {
  // 慢子任务:400ms 后产出 99,父最多等 100ms -> 超时,采用默认值 0。
  const slowOutcome = await raceWithTimeout(childProduce(400, 99), 100);
  if (slowOutcome === "timeout") {
    process.stdout.write("slow_child=timeout fallback=0\n");
  } else {
    process.stdout.write(`slow_child=${slowOutcome}\n`);
  }

  // 快子任务:50ms 后产出 99,父最多等 2000ms -> 正常取到 99。
  const fastOutcome = await raceWithTimeout(childProduce(50, 99), 2000);
  if (fastOutcome === "timeout") {
    process.stdout.write("fast_child=timeout fallback=0\n");
  } else {
    process.stdout.write(`fast_child=${fastOutcome}\n`);
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch(() => {
    process.exitCode = 1;
  });
