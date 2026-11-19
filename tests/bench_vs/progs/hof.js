// bench_vs T5.1 任务 3:HOF 链 10 万元素(map + filter 各一道,reduce 聚合;JS/Node,自测计时口径)
const N = 100000;
const v = [];
for (let i = 0; i < N; i++) {
  v.push(i);
}
const t0 = performance.now();
const sum = v.map((x) => x + 1).filter((x) => x % 2 === 0).reduce((a, x) => a + x, 0);
const t1 = performance.now();
console.log(`${sum} ${(t1 - t0).toFixed(3)}`);
console.log(`MEM ${process.memoryUsage().rss}`);
