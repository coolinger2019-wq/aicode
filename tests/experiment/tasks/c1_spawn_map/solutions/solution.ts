// C1 spawn 并行汇总 — 参考实现(TypeScript + Node 24,worker_threads)
import { Worker } from "node:worker_threads";

const WORKER_CODE =
  "const { parentPort } = require('node:worker_threads'); parentPort.on('message', (lo) => { let s = 0; for (let i = lo; i < lo + 25; i++) { s += i * i; } parentPort.postMessage(s); });";

function runShard(lo: number): Promise<number> {
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
    w.postMessage(lo);
  });
}

async function main(): Promise<void> {
  const los = [1, 26, 51, 76];
  const results = await Promise.all(los.map(runShard));
  let total = 0;
  results.forEach((v, i) => {
    console.log("shard" + (i + 1) + "=" + v);
    total += v;
  });
  console.log("total=" + total);
  process.exitCode = 0;
}

void main();
