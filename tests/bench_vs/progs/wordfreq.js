// bench_vs T5.1 任务 4:词频统计 2 万词(JS/Node,自测计时口径)
// 文本生成器:mulberry32(Ming std.rand 同源,种子 20261120)从 64 词表抽 2 万词;
// 计时段 = 仅 Map 计数(生成词数组为 setup,不计时)。
const VOCAB = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
  'yankee', 'zulu', 'apple', 'banana', 'cherry', 'date', 'elder', 'fig',
  'grape', 'honey', 'kiwi', 'lemon', 'mango', 'nutmeg', 'olive', 'peach',
  'quince', 'raspberry', 'strawberry', 'tomato', 'ugli', 'vanilla', 'walnut', 'xigua',
  'yuzu', 'zucchini', 'amber', 'bright', 'crisp', 'dawn', 'ember', 'frost',
  'gleam', 'haven', 'ivory', 'jade', 'karma', 'lumen', 'meadow', 'nimbus',
];
// 与 src/interp.js randStep 逐式对齐(BigInt 精确,防 2^53 精度丢失)
function makeRng(seed) {
  let state = BigInt(seed) & 0xFFFFFFFFn;
  return {
    step() {
      state = (state + 0x6D2B79F5n) & 0xFFFFFFFFn;
      let t = state;
      t = ((t ^ (t >> 15n)) * (t | 1n)) & 0xFFFFFFFFn;
      t = (t ^ (t + ((t ^ (t >> 7n)) * (t | 61n)))) & 0xFFFFFFFFn;
      state = (t ^ (t >> 14n)) & 0xFFFFFFFFn;
    },
    range(lo, hi) {
      this.step();
      return lo + Number(state % BigInt(hi - lo));
    },
  };
}
const rng = makeRng(20261120);
const words = [];
for (let i = 0; i < 20000; i++) {
  words.push(VOCAB[rng.range(0, 64)]);
}
const t0 = performance.now();
const counts = new Map();
for (const w of words) {
  counts.set(w, (counts.get(w) ?? 0) + 1);
}
const t1 = performance.now();
console.log(`${words.length} ${counts.size} ${counts.get('alpha') ?? 0} ${counts.get('nimbus') ?? 0} ${(t1 - t0).toFixed(3)}`);
console.log(`MEM ${process.memoryUsage().rss}`);
