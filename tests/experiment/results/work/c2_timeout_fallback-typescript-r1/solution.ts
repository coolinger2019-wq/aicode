// 任务:超时与降级——两个子任务,父任务带超时等待(Promise.race)。
// 慢子任务 400ms 后产出 99,父最多等 100ms → 超时,采用默认值 0;
// 快子任务 50ms 后产出 99,父最多等 2000ms → 正常取到 99。

type Outcome =
  | { kind: "value"; value: number }
  | { kind: "timeout"; fallback: number };

// 子任务:delayMs 后产出 result。background=true 时定时器 unref,
// 超时被放弃后不会阻止进程自然退出(留在后台)。
function spawnChild(delayMs: number, result: number, background: boolean): Promise<number> {
  return new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(result), delayMs);
    if (background) timer.unref();
  });
}

// 父任务等待:子任务 Promise 与超时 Promise 竞速(Promise.race)。
function withTimeout(child: Promise<number>, limitMs: number, fallback: number): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout", fallback }), limitMs);
  });
  const valuePromise = child.then((value): Outcome => ({ kind: "value", value }));
  return Promise.race([valuePromise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function main(): Promise<void> {
  const slowChild = spawnChild(400, 99, true);
  const fastChild = spawnChild(50, 99, false);

  const slow = await withTimeout(slowChild, 100, 0);
  const fast = await withTimeout(fastChild, 2000, 0);

  if (slow.kind === "timeout") {
    console.log(`slow_child=timeout fallback=${slow.fallback}`);
  } else {
    console.log(`slow_child=${slow.value}`);
  }
  if (fast.kind === "value") {
    console.log(`fast_child=${fast.value}`);
  } else {
    console.log(`fast_child=timeout fallback=${fast.fallback}`);
  }
  process.exitCode = 0;
}

void main();
