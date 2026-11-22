// 任务:竞态防护——分片计数合并(typescript)
// 4 个分片并行统计:每分片一个 Worker 线程本地计数,结果回传父线程按分片序合并。
// 数据公式(固定):s = 1..4, j = 1..16;v = (s*13 + j*7) % 6;v == 0 记一次命中。
// 设计约束:不使用 SharedArrayBuffer,不做共享计数器裸累加——分片本地计数,父任务合并。

async function main(): Promise<void> {
  const { Worker } = await import('node:worker_threads');

  // worker 内联脚本(plain JS,eval 求值):兼容 CJS/ESM 两种上下文取到 worker_threads,
  // 读取 workerData.s,本地完成 1..16 的命中统计后把计数回传父线程。
  const workerSource = `(async () => {
    const wt = typeof require === 'function'
      ? require('node:worker_threads')
      : await import('node:worker_threads');
    const { parentPort, workerData } = wt;
    if (!parentPort) {
      return;
    }
    const s = workerData && typeof workerData === 'object' ? Number(workerData.s) : 0;
    let hits = 0;
    for (let j = 1; j <= 16; j += 1) {
      if ((s * 13 + j * 7) % 6 === 0) {
        hits += 1;
      }
    }
    parentPort.postMessage(hits);
  })();`;

  const spawnShard = async (s: number): Promise<number> => {
    const worker = new Worker(workerSource, { eval: true, workerData: { s } });
    try {
      return await new Promise<number>((resolve, reject) => {
        worker.on('message', (msg: unknown) => {
          if (typeof msg === 'number') {
            resolve(msg);
          } else {
            reject(new Error('shard ' + s + ': worker returned a non-number result'));
          }
        });
        worker.on('messageerror', () => {
          reject(new Error('shard ' + s + ': message serialization failed'));
        });
        worker.on('error', (err: Error) => {
          reject(err);
        });
        worker.on('exit', (code: number) => {
          reject(new Error('shard ' + s + ': worker exited before reporting, exitCode=' + code));
        });
      });
    } finally {
      // 拿到结果后显式终止 worker;对已结算的 promise 重复 resolve/reject 是无害空操作
      await worker.terminate().catch(() => undefined);
    }
  };

  // 四个分片同时派生、并行执行;Promise.all 对元组输入按数组顺序合并 = 分片序
  const [c1, c2, c3, c4] = await Promise.all([
    spawnShard(1),
    spawnShard(2),
    spawnShard(3),
    spawnShard(4),
  ]);
  const total = c1 + c2 + c3 + c4;

  const lines: string[] = [
    'shard1=' + String(c1),
    'shard2=' + String(c2),
    'shard3=' + String(c3),
    'shard4=' + String(c4),
    'total=' + String(total),
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

main().catch((err: unknown) => {
  const text = err instanceof Error ? err.message : String(err);
  process.stderr.write('fatal: ' + text + '\n');
  process.exit(1);
});
