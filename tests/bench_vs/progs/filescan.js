// bench_vs T5.1 任务 6:1k 文件扫描(JS/Node,自测计时口径)
// 程序启动时在 cwd 生成 1000 个小文件(确定性内容,与其它语言逐式同源),生成不计时;
// 计时段 = 逐个读取并累计行数(按 0x0A 计)与字节数(二进制读,各语言口径一致)。
import * as fs from 'node:fs';
for (let i = 0; i < 1000; i++) {
  let s = '';
  for (let j = 0; j < 10; j++) {
    s += `file ${i} line ${j} v${(i + j) % 97}\n`;
  }
  fs.writeFileSync(`f${i}.txt`, s, 'utf8');
}
const t0 = performance.now();
let lines = 0;
let bytes = 0;
for (let i = 0; i < 1000; i++) {
  const buf = fs.readFileSync(`f${i}.txt`);
  bytes += buf.length;
  for (let k = 0; k < buf.length; k++) {
    if (buf[k] === 10) lines++;
  }
}
const t1 = performance.now();
console.log(`${lines} ${bytes} ${(t1 - t0).toFixed(3)}`);
console.log(`MEM ${process.memoryUsage().rss}`);
