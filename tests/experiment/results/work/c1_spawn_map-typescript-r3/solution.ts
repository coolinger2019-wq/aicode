import { Worker } from "node:worker_threads";

interface ShardOutcome {
  readonly index: number;
  readonly sum: number;
}

const WORKER_SOURCE: string = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { lo, hi } = workerData;
  let sum = 0;
  for (let k = lo; k <= hi; k += 1) {
    sum += k * k;
  }
  parentPort.postMessage(sum);
`;

function runShard(index: number, lo: number, hi: number): Promise<ShardOutcome> {
  return new Promise<ShardOutcome>((resolve, reject) => {
    const worker: Worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { lo, hi },
    });
    let settled: boolean = false;
    const finish = (outcome: ShardOutcome | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      const done = (): void => {
        if (outcome instanceof Error) {
          reject(outcome);
        } else {
          resolve(outcome);
        }
      };
      void worker.terminate().then(done, done);
    };
    worker.on("message", (msg: unknown): void => {
      if (typeof msg !== "number") {
        finish(new Error(`shard${index} returned a non-number result`));
        return;
      }
      finish({ index, sum: msg });
    });
    worker.on("error", (err: Error): void => {
      finish(err);
    });
    worker.on("exit", (code: number): void => {
      if (!settled && code !== 0) {
        finish(new Error(`shard${index} worker exited abnormally, code=${code}`));
      }
    });
  });
}

function main(): void {
  const jobs: Array<Promise<ShardOutcome>> = [];
  for (let i: number = 1; i <= 4; i += 1) {
    const lo: number = 25 * (i - 1) + 1;
    const hi: number = 25 * i;
    jobs.push(runShard(i, lo, hi));
  }
  Promise.all(jobs)
    .then((outcomes: Array<ShardOutcome>): void => {
      const lines: string[] = [];
      let total: number = 0;
      for (let i: number = 1; i <= 4; i += 1) {
        const o: ShardOutcome | undefined = outcomes[i - 1];
        if (o === undefined || o.index !== i) {
          process.stderr.write("internal error: shard order mismatch\n");
          process.exit(1);
        }
        total += o.sum;
        lines.push(`shard${i}=${o.sum}`);
      }
      lines.push(`total=${total}`);
      process.stdout.write(lines.join("\n") + "\n");
    })
    .catch((err: unknown): void => {
      process.stderr.write(`error: ${String(err)}\n`);
      process.exit(1);
    });
}

main();
