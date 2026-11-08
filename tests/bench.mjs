// tests/bench.mjs — Ming 双引擎性能基准(信息性,不作为 CI 门槛)。
// 对比:树遍历解释器(--tree)vs 字节码 VM(默认)。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-bench-'));

function benchFile(name, src) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, src, 'utf8');
  return p;
}

function runOnce(file, engine) {
  const args = ['run', file];
  if (engine === 'tree') args.push('--tree');
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [MING, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, ok: r.status === 0, out: r.stdout };
}

function bench(name, src, check) {
  const p = benchFile(name, src);
  const warm = runOnce(p, 'vm');
  if (!warm.ok || !warm.out.includes(check)) {
    console.log(`✗ ${name}:VM 输出异常 ${JSON.stringify(warm.out.slice(0, 60))}`);
    return;
  }
  const warmT = runOnce(p, 'tree');
  if (!warmT.ok || !warmT.out.includes(check)) {
    console.log(`✗ ${name}:tree 输出异常 ${JSON.stringify(warmT.out.slice(0, 60))}`);
    return;
  }
  // 取 3 次最小值(减少噪声)
  const vmTimes = [], treeTimes = [];
  for (let i = 0; i < 3; i++) vmTimes.push(runOnce(p, 'vm').ms);
  for (let i = 0; i < 3; i++) treeTimes.push(runOnce(p, 'tree').ms);
  const vm = Math.min(...vmTimes), tree = Math.min(...treeTimes);
  const speedup = tree / vm;
  console.log(`${name.padEnd(22)} tree=${tree.toFixed(0).padStart(6)}ms  vm=${vm.toFixed(0).padStart(6)}ms  提速 ${speedup.toFixed(1)}x`);
}

// 1) 递归:fib(24)
bench('fib(24) 递归', `
fn fib(n: i64) -> i64 {
    if n < 2 { return n; }
    return fib(n - 1) + fib(n - 2);
}
fn main() with io {
    print(str(fib(24)));
}
`, '46368');

// 2) 循环累加:1..100万
bench('循环累加 100 万', `
fn main() with io {
    let mut total = 0;
    for i in 1..1000001 {
        total += i;
    }
    print(str(total));
}
`, '500000500000');

// 3) 集合操作:map/filter/fold
bench('高阶方法 10 万元素', `
fn main() with io {
    let mut v: Vec[i64] = [];
    let mut i = 0;
    while i < 100000 {
        v.push(i);
        i += 1;
    }
    let sum = v.map((x) => x * 2).filter((x) => x % 3 == 0).fold(0, (acc, x) => acc + x);
    print(str(sum));
}
`, '3333366666');

// 4) 字符串与 Map:词频
bench('词频统计 2 万词', `
fn count_words(text: str) -> Map[str, i64] {
    let mut counts: Map[str, i64] = [:];
    for word in text.split(" ") {
        if word == "" { continue; }
        counts.set(word, counts.get(word).unwrap_or(0) + 1);
    }
    counts
}
fn main() with io {
    let mut text = "";
    let mut i = 0;
    while i < 2000 {
        text += "the quick brown fox jumps over the lazy dog ";
        i += 1;
    }
    let c = count_words(text);
    print(str(c.get("fox").unwrap_or(0)));
}
`, '2000');

fs.rmSync(TMP, { recursive: true, force: true });
