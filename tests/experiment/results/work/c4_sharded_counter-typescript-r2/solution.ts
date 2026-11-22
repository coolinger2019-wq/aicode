// 任务: 竞态防护——分片计数合并
// 4 个分片并行统计各自片段的命中数(每分片线程本地计数, 不共享计数器),
// 子任务把结果消息返回父线程, 父任务按分片序合并输出。
// 运行方式: node solution.ts

const SHARD_COUNT: number = 4;
const ITEM_COUNT: number = 16;

// 内联工作线程代码(Worker eval 模式, CommonJS 上下文):
// 每个分片线程只读自己的 workerData, 本地累加命中数, 完成后 postMessage 返回。
const WORKER_SOURCE: string = [
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const shard = workerData.shard;",
  "let hits = 0;",
  "for (let j = 1; j <= " + String(ITEM_COUNT) + "; j += 1) {",
  "  const v = (shard * 13 + j * 7) % 6;",
  "  if (v === 0) { hits += 1; }",
  "}",
  "parentPort.postMessage(hits);",
].join("\n");

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function main(): void {
  import("node:worker_threads")
    .then((wt) => {
      const runOne = (shard: number): Promise<number> => {
        return new Promise<number>((resolve, reject) => {
          let settled: boolean = false;
          const worker = new wt.Worker(WORKER_SOURCE, {
            eval: true,
            workerData: { shard: shard },
          });
          const settle = (action: () => void): void => {
            if (settled) {
              return;
            }
            settled = true;
            action();
            void worker.terminate().catch(() => undefined);
          };
          worker.on("message", (raw: unknown) => {
            settle(() => {
              if (isNonNegativeInt(raw)) {
                resolve(raw);
              } else {
                reject(new Error("分片线程返回了意外的结果类型"));
              }
            });
          });
          worker.on("error", (err: Error) => {
            settle(() => {
              reject(err);
            });
          });
          worker.on("exit", (code: number) => {
            settle(() => {
              reject(new Error("分片线程在返回结果前退出, 退出码 " + String(code)));
            });
          });
        });
      };
      const promises: Promise<number>[] = [];
      for (let s = 1; s <= SHARD_COUNT; s += 1) {
        promises.push(runOne(s));
      }
      return Promise.all<number>(promises);
    })
    .then((hits: number[]) => {
      const lines: string[] = [];
      let total: number = 0;
      for (let i = 0; i < hits.length; i += 1) {
        const n: number = hits[i];
        total += n;
        lines.push("shard" + String(i + 1) + "=" + String(n));
      }
      lines.push("total=" + String(total));
      process.stdout.write(lines.join("\n") + "\n");
    })
    .catch((err: unknown) => {
      process.stderr.write("error: " + String(err) + "\n");
      process.exitCode = 1;
    });
}

main();
