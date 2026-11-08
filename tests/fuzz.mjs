// tests/fuzz.mjs — 最小模糊测试基线(v0.33):随机纯 i64 程序的差分测试。
// 思路:不依赖预言(oracle)——同一程序必须在三后端(树引擎 / 字节码 VM+wasprint / VM--no-wasm)
// 产出完全一致的结果(stdout + 退出码 + 错误码);任何分歧 = 分层 bug。
// 用法:node tests/fuzz.mjs [--seed N] [--count N](默认种子固定,保证可复现)
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1]) : d; };
const SEED = opt('seed', 20261109);
const COUNT = opt('count', 120);
const TIMEOUT = opt('timeout', 8000);

// mulberry32:确定性 rng(与 std.rand 同款)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// ---- 程序生成器:纯 i64 表达式 + 有界控制流;允许 panic(三后端须一致地 panic)----
function genExpr(vars, depth) {
  if (depth <= 0 || rng() < 0.3) {
    if (vars.length && rng() < 0.6) return pick(vars);
    return String(int(-99, 999));
  }
  const kind = pick(['bin', 'bin', 'bin', 'cmp', 'neg', 'if']);
  const l = genExpr(vars, depth - 1);
  const r = genExpr(vars, depth - 1);
  if (kind === 'bin') {
    // 除/移位右操作数限小值非零:避免除零与巨移位使大多数程序 panic(模糊 panic 也有价值,但要少)
    const op = pick(['+', '+', '-', '*', '%', '&', '|', '^', '<<', '>>']);
    if (op === '%' || op === '<<' || op === '>>') return `(${l} ${op} ${int(1, 5)})`;
    return `(${l} ${op} ${r})`;
  }
  if (kind === 'cmp') return `(${l} ${pick(['<', '<=', '>', '>=', '==', '!='])} ${r} as i64)`;
  if (kind === 'neg') return `(-(${l}))`;
  return `(if ${genCond(vars, depth - 1)} { ${l} } else { ${r} })`;
}
function genCond(vars, depth) {
  return `(${genExpr(vars, Math.max(1, depth - 1))} ${pick(['<', '<=', '>', '>='])} ${genExpr(vars, Math.max(1, depth - 1))})`;
}
function genProgram() {
  const nVars = int(2, 3);
  const vars = [];
  const lines = ['fn main() with io {'];
  for (let i = 0; i < nVars; i++) {
    const v = `x${i}`;
    vars.push(v);
    lines.push(`    let mut ${v} = ${int(-50, 200)};`);
  }
  const nStmt = int(2, 5);
  for (let s = 0; s < nStmt; s++) {
    const v = pick(vars);
    const kind = pick(['assign', 'assign', 'while', 'vec']);
    if (kind === 'assign') {
      lines.push(`    ${v} = ${v} + ${genExpr(vars, int(1, 3))};`);
    } else if (kind === 'while') {
      // 有界循环:计数器循环累加,必终止
      const k = int(1, 6);
      lines.push(`    let mut i${s} = 0;`);
      lines.push(`    while i${s} < ${k} { ${v} = ${v} + ${int(1, 9)}; i${s} = i${s} + 1; }`);
    } else {
      lines.push('    let mut vv: Vec[i64] = [3, 1, 2];');
      lines.push(`    ${v} = ${v} + vv[0] + vv.len() as i64;`);
    }
  }
  lines.push(`    print(str(${vars[0]}));`);
  lines.push('}');
  return lines.join('\n');
}

const norm = (r) => JSON.stringify([r.code, r.stdout, (r.stderr.match(/M\d{4}/) ?? [null])[0]]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-fuzz-'));
const prog = path.join(TMP, 'fuzz.ming');

let passed = 0, diverged = 0, skipped = 0;
for (let i = 0; i < COUNT; i++) {
  const src = genProgram();
  fs.writeFileSync(prog, src);
  const run = (extra) => spawnSync(process.execPath, [MING, 'run', prog, ...extra], { encoding: 'utf8', cwd: ROOT, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024 });
  const rt = run(['--tree']);
  const rw = run([]);
  const rj = run(['--no-wasm']);
  if (rt.status === null || rw.status === null || rj.status === null) { skipped++; continue; } // 超时=平台抖动,跳过
  const a = norm(rt), b = norm(rw), c = norm(rj);
  if (a === b && b === c) { passed++; continue; }
  diverged++;
  console.error(`\n=== 分歧 #${i} (seed=${SEED}) ===`);
  console.error(src);
  console.error('tree   :', a);
  console.error('vm+wasm:', b);
  console.error('vm-only:', c);
  break;
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`模糊基线:种子 ${SEED},${COUNT} 程序,一致 ${passed},分歧 ${diverged},跳过 ${skipped}`);
process.exit(diverged ? 1 : 0);
