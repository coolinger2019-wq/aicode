// spawn 并行汇总 —— 4 个分片在并行 Worker 中计算平方和,父任务按序合并输出。
// 运行方式: node solution.ts (Node 24 原生类型剥离,无参数)

type WorkerCtor = typeof import('node:worker_threads').Worker;

interface ShardSpec {
  readonly lo: number;
  readonly hi: number;
}

// eval 模式下的 Worker 源码(纯 JS,CommonJS 形态,显式 \n 拼接避免换行差异)。
const WORKER_SRC: string = [
  "'use strict';",
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const lo = Number(workerData.lo);",
  "const hi = Number(workerData.hi);",
  "let sum = 0;",
  "for (let k = lo; k <= hi; k++) { sum += k * k; }",
  "parentPort.postMessage(sum);",
].join('\n');

function shardSpecs(): ShardSpec[] {
  const specs: ShardSpec[] = [];
  for (let i = 1; i <= 4; i++) {
    specs.push({ lo: 25 * (i - 1) + 1, hi: 25 * i });
  }
  return specs;
}

// 单个分片:派生一个并行 Worker,拿到结果后立即 terminate。
function runShard(Worker: WorkerCtor, spec: ShardSpec): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const w = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { lo: spec.lo, hi: spec.hi },
    });
    let settled = false;
    w.once('message', (value: unknown) => {
      settled = true;
      void w
        .terminate()
        .then(() => {
          if (typeof value === 'number' && Number.isFinite(value)) {
            resolve(value);
          } else {
            reject(new Error('worker returned a non-number result'));
          }
        })
        .catch((termErr: unknown) => {
          reject(termErr instanceof Error ? termErr : new Error(String(termErr)));
        });
    });
    w.once('error', (err: Error) => {
      settled = true;
      void w.terminate().catch(() => {
        // 忽略 terminate 本身的失败
      });
      reject(err);
    });
    w.once('exit', (code: number) => {
      if (!settled) {
        settled = true;
        reject(new Error('worker exited before posting a result (code=' + String(code) + ')'));
      }
    });
  });
}

async function main(): Promise<void> {
  const { Worker } = await import('node:worker_threads');
  const values: number[] = await Promise.all(shardSpecs().map((s: ShardSpec) => runShard(Worker, s)));
  const total: number = values.reduce((acc: number, v: number) => acc + v, 0);
  const lines: string[] = [];
  for (let i = 0; i < values.length; i++) {
    lines.push('shard' + String(i + 1) + '=' + String(values[i]));
  }
  lines.push('total=' + String(total));
  console.log(lines.join('\n'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
