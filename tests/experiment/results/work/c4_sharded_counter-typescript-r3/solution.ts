// 分片计数合并：4 个分片并行统计各自数据片段的命中数，父任务按分片序合并输出。
// 竞态防护设计：每分片在独立 Worker 内做本地计数，结果经消息返回给父任务合并；
// 不使用 SharedArrayBuffer，不存在多线程对同一共享计数器的裸累加。

import { Worker } from "node:worker_threads";

interface ShardResult {
  shard: number;
  hits: number;
}

// Worker 内联代码（eval 模式）：读取 workerData.shard，按固定公式统计片内
// j = 1..16 中 (s*13 + j*7) % 6 == 0 的次数，本地计数后 postMessage 返回。
// 各分片只写自己的局部变量，彼此无共享状态。
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const shard = workerData.shard;
let hits = 0;
for (let j = 1; j <= 16; j++) {
  if ((shard * 13 + j * 7) % 6 === 0) {
    hits += 1;
  }
}
parentPort.postMessage({ shard: shard, hits: hits });
`;

function isShardResult(msg: unknown): msg is ShardResult {
  if (typeof msg !== "object" || msg === null) {
    return false;
  }
  const rec = msg as Record<string, unknown>;
  return typeof rec.shard === "number" && typeof rec.hits === "number";
}

function runShard(shard: number): Promise<ShardResult> {
  return new Promise<ShardResult>((resolve, reject) => {
    const worker = new Worker(WORKER_SRC, { eval: true, workerData: { shard } });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      void worker.terminate();
      fn();
    };
    worker.on("message", (msg: unknown): void => {
      if (!isShardResult(msg)) {
        finish(() => reject(new Error("worker returned malformed message")));
        return;
      }
      finish(() => resolve(msg));
    });
    worker.on("error", (err: Error): void => {
      finish(() => reject(err));
    });
    worker.on("exit", (code: number): void => {
      if (!settled) {
        settled = true;
        reject(new Error(`worker exited unexpectedly with code ${code}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const shards: number[] = [1, 2, 3, 4];
  const results: ShardResult[] = await Promise.all(shards.map((s) => runShard(s)));
  let total = 0;
  const lines: string[] = [];
  for (const [i, r] of results.entries()) {
    if (r.shard !== i + 1) {
      throw new Error(`shard order mismatch: expected shard${i + 1}, got shard${r.shard}`);
    }
    total += r.hits;
    lines.push(`shard${i + 1}=${r.hits}`);
  }
  lines.push(`total=${total}`);
  process.stdout.write(lines.join("\n") + "\n");
}

main().catch((err: unknown): void => {
  process.stderr.write(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
