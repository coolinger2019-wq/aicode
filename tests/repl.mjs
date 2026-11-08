// tests/repl.mjs — REPL 会话测试(管道输入,断言输出)
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const session = [
  '1 + 2',                                                    // = 3
  'fn add(a: i64, b: i64) -> i64 { a + b }',                  // 声明持久
  'add(3, 4)',                                                // = 7(调用持久声明)
  '"hello"',                                                  // = "hello"(str repr)
  'let bad: i64 = "x"',                                       // 诊断 + 会话继续
  '[1, 2, 3]',                                                // = [1, 2, 3]
  ':quit',
].join('\n');

const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ming.js'), 'repl'], {
  input: session,
  encoding: 'utf8',
  cwd: ROOT,
  timeout: 120000,
});

const out = (r.stdout ?? '');
const err = (r.stderr ?? '');
let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('✓', name); }
  else { failed++; console.log('✗', name, detail.slice(0, 200)); }
};

check('repl:表达式回显 = 3', out.includes('= 3'), JSON.stringify(out.slice(0, 200)));
check('repl:声明持久后可调用 = 7', out.includes('= 7'), JSON.stringify(out));
check('repl:字符串 repr = "hello"', out.includes('= "hello"'), JSON.stringify(out));
check('repl:向量 repr = [1, 2, 3]', out.includes('= [1, 2, 3]'), JSON.stringify(out));
check('repl:类型错误诊断且会话继续', err.includes('M3002') && out.includes('= [1, 2, 3]'), err.slice(0, 200));
check('repl:正常退出', r.status === 0, 'status=' + r.status);

process.stderr.write(`\n${passed} 通过,${failed} 失败\n`);
process.exit(failed ? 1 : 0);
