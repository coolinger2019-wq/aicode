// bench_vs T5.1 任务 2:循环累加 1..1000000(JS/Node,自测计时口径)
const N = 1000000;
const t0 = performance.now();
let s = 0;
for (let i = 1; i <= N; i++) {
  s += i;
}
const t1 = performance.now();
console.log(`${s} ${(t1 - t0).toFixed(3)}`);
console.log(`MEM ${process.memoryUsage().rss}`);
