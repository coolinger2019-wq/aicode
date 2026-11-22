// 超时与降级:Promise.race(子任务 vs 超时)。
// 慢子任务 400ms 产出 99,父最多等 100ms → 超时,采用默认值 0;
// 快子任务 50ms 产出 99,父最多等 2000ms → 正常取到 99。

type TimerHandle = ReturnType<typeof setTimeout>;

interface ChildTask {
  promise: Promise<number>;
  /** 超时后放弃子任务:清掉它的定时器,不再产出(留在后台/放弃均可)。 */
  abandon: () => void;
}

function spawnChild(value: number, delayMs: number): ChildTask {
  let timer: TimerHandle | null = null;
  const promise = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      timer = null;
      resolve(value);
    }, delayMs);
  });
  return {
    promise,
    abandon: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** 与超时赛跑:子任务先到返回其值,超时先到返回 null(默认值的信号)。 */
function raceWithTimeout(childPromise: Promise<number>, limitMs: number): Promise<number | null> {
  let timer: TimerHandle | null = null;
  const timeoutPromise = new Promise<number | null>((resolve) => {
    timer = setTimeout(() => {
      timer = null;
      resolve(null);
    }, limitMs);
  });
  return Promise.race([childPromise, timeoutPromise]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  });
}

async function waitForChild(value: number, delayMs: number, limitMs: number): Promise<number | null> {
  const child = spawnChild(value, delayMs);
  const result = await raceWithTimeout(child.promise, limitMs);
  if (result === null) {
    child.abandon();
  }
  return result;
}

async function main(): Promise<void> {
  // 慢子任务:睡 400ms,上限 100ms → 必超时,取默认值 0。
  const slowResult: number | null = await waitForChild(99, 400, 100);
  if (slowResult === null) {
    process.stdout.write("slow_child=timeout fallback=0\n");
  } else {
    process.stdout.write(`slow_child=${String(slowResult)}\n`);
  }

  // 快子任务:睡 50ms,上限 2000ms → 取到 99。
  const fastResult: number | null = await waitForChild(99, 50, 2000);
  if (fastResult === null) {
    process.stdout.write("fast_child=timeout fallback=0\n");
  } else {
    process.stdout.write(`fast_child=${String(fastResult)}\n`);
  }

  process.exitCode = 0; // 自然退出,不调用 process.exit
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${String(err)}\n`);
  process.exitCode = 1;
});
