// bench_vs T5.1 任务 1:fib(24) 递归(JS/Node,自测计时口径)
// 输出协议:<结果> <自测毫秒>;第二行 MEM <rss>(尽力而为内存采集)。
function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
const t0 = performance.now();
const r = fib(24);
const t1 = performance.now();
console.log(`${r} ${(t1 - t0).toFixed(3)}`);
console.log(`MEM ${process.memoryUsage().rss}`);
