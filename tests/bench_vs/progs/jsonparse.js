// bench_vs T5.1 任务 5:10MB JSON 解析(JS/Node,自测计时口径)
// 计时段 = 仅 JSON.parse(文件读取为 setup);验证 = meta.total 与 meta.n_items。
import * as fs from 'node:fs';
const s = fs.readFileSync('data_10mb.json', 'utf8');
const t0 = performance.now();
const doc = JSON.parse(s);
const t1 = performance.now();
console.log(`${doc.meta.total} ${doc.meta.n_items} ${(t1 - t0).toFixed(3)}`);
console.log(`MEM ${process.memoryUsage().rss}`);
