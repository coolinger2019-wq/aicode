// 任务 c1_spawn_map：4 个分片在并行 worker 线程中计算平方和，父任务按分片序合并输出。
// 运行方式：node solution.ts（Node 24 原生类型剥离）。

import { Worker } from "node:worker_threads";

interface ShardTask {
  lo: number;
  hi: number;
}

interface ShardReply {
  sum: number;
}

function isShardReply(value: unknown): value is ShardReply {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sum === "number" && Number.isFinite(record.sum);
}

// eval:true 内联工作代码；eval 模式下 require 可用（等同 node -e 语境）。
const workerScript = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  const lo = msg.lo;
  const hi = msg.hi;
  let sum = 0;
  for (let i = lo; i <= hi; i += 1) {
    sum += i * i;
  }
  parentPort.postMessage({ sum });
});
`;

// 单个分片：spawn 一个 worker，拿到结果后立即 terminate()（否则进程可能不退出）。
function runShard(shard: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const task: ShardTask = {
      lo: 25 * (shard - 1) + 1,
      hi: 25 * shard,
    };
    const worker = new Worker(workerScript, { eval: true });
    let settled = false;

    const settle = (outcome: (worker: Worker) => Promise<void>): void => {
      if (settled) {
        return;
      }
      settled = true;
      outcome(worker).catch((err: Error) => {
        reject(err);
      });
    };

    worker.on("message", (value: unknown) => {
      if (!isShardReply(value)) {
        settle(async () => {
          await worker.terminate();
          throw new Error("分片返回了意外消息");
        });
        return;
      }
      const reply = value;
      settle(async () => {
        await worker.terminate();
        resolve(reply.sum);
      });
    });
    worker.on("error", (err: Error) => {
      settle(async () => {
        await worker.terminate();
        throw err;
      });
    });
    worker.on("messageerror", (err: Error) => {
      settle(async () => {
        await worker.terminate();
        throw err;
      });
    });

    worker.postMessage(task);
  });
}

async function main(): Promise<void> {
  // 四个分片同时 spawn 并行计算；Promise.all 保序合并，与完成顺序无关。
  const shardIds = [1, 2, 3, 4];
  const shardPromises = shardIds.map((shard) => runShard(shard));
  const results: number[] = await Promise.all(shardPromises);

  for (let i = 0; i < results.length; i += 1) {
    process.stdout.write(`shard${i + 1}=${results[i]}\n`);
  }
  let total = 0;
  for (const value of results) {
    total += value;
  }
  process.stdout.write(`total=${total}\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
