// C4 竞态防护:分片计数合并 — 参考实现(TypeScript + Node 24,worker_threads)
// 每分片本地计数后 postMessage 回传,父任务合并;不用共享计数器。
import { Worker } from "node:worker_threads";

const WORKER_CODE =
  "const { parentPort } = require('node:worker_threads'); parentPort.on('message', (s) => { let hits = 0; for (let j = 1; j <= 16; j++) { const v = (s * 13 + j * 7) % 6; if (v === 0) { hits += 1; } } parentPort.postMessage(hits); });";

function countHits(s: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_CODE, { eval: true });
    w.on("message", (v: unknown) => {
      void w.terminate();
      resolve(v as number);
    });
    w.on("error", (e) => {
      void w.terminate();
      reject(e);
    });
    w.postMessage(s);
  });
}

async function main(): Promise<void> {
  const shards = [1, 2, 3, 4];
  const results = await Promise.all(shards.map(countHits));
  let total = 0;
  results.forEach((v, i) => {
    console.log("shard" + (i + 1) + "=" + v);
    total += v;
  });
  console.log("total=" + total);
  process.exitCode = 0;
}

void main();
