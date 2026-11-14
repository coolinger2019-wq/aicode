// repl.js — Ming 交互式会话(v0.8)。
// 模型:声明(use/fn/struct/…)持久追加到会话源;表达式包进临时函数求值并打印 repr。
// 每次输入全量重编译(会话源很小,毫秒级);失败的输入自动回滚,不污染会话。

import * as readline from 'node:readline';
import { Checker } from './checker.js';
import { VMInterp } from './vm.js';
import { Panic, debugStr } from './interp.js';
import { formatDiag, cacheSourceLines } from './diag.js';

const ALL_EFFECTS = 'io, time, fs, net';

function bracketBalance(text) {
  let depth = 0;
  let inStr = false;
  let inLineComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') { inLineComment = true; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === ')' || ch === ']') depth--;
  }
  return depth;
}

export function startRepl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'ming> ' });
  let decls = '';
  let counter = 0;
  let pending = '';

  // 横幅版本与 bin/ming.js 的 VERSION 手工同步(曾漂移 v0.8.0→v0.63.0;动态导入会造 src→bin 环,故硬编码)
  process.stdout.write('Ming v0.63.0 REPL — 输入表达式或声明;:help 帮助,:quit 退出\n');
  rl.prompt();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (pending === '' && trimmed === '') { rl.prompt(); return; }
    if (pending === '' && (trimmed === ':quit' || trimmed === ':exit' || trimmed === ':q')) {
      rl.close();
      return;
    }
    if (pending === '' && (trimmed === ':clear' || trimmed === ':reset')) {
      decls = '';
      counter = 0;
      process.stdout.write('(会话已清空)\n');
      rl.prompt();
      return;
    }
    if (pending === '' && trimmed === ':help') {
      process.stdout.write('输入 Ming 表达式(回显 = repr)或顶层声明(持久保留)。\n:clear 重置会话;:quit 退出。多行输入:括号未平衡时自动继续(提示 ....> )。\n');
      rl.prompt();
      return;
    }

    pending += (pending ? '\n' : '') + line;
    if (bracketBalance(pending) > 0) {
      rl.setPrompt('....> ');
      rl.prompt();
      return;
    }

    const input0 = pending;
    pending = '';
    rl.setPrompt('ming> ');
    counter++;

    const isDecl = /^(pub\s+)?(fn|struct|enum|trait|impl|use|const)\b/.test(input0);
    // let 输入自动补分号(表达式不补——块尾值即回显内容)
    const input = (!isDecl && /^let\b/.test(input0) && !input0.endsWith(';') && !input0.endsWith('}')) ? input0 + ';' : input0;
    const fnName = '__repl_' + counter;
    const src = isDecl
      ? decls + (decls ? '\n' : '') + input + '\n'
      : decls + (decls ? '\n' : '') + `fn ${fnName}() with ${ALL_EFFECTS} {\n${input}\n}\n`;

    try {
      const checker = new Checker('<repl>.ming', () => src);
      const result = checker.run();
      cacheSourceLines('<repl>.ming', src);
      const errors = result.diags.filter(d => d.severity === 'error');
      if (errors.length) {
        for (const d of errors) process.stderr.write(formatDiag(d, process.stderr.isTTY) + '\n');
        counter--; // 回滚:失败的输入不进入会话
        rl.prompt();
        return;
      }
      if (isDecl) {
        decls = src;
        rl.prompt();
        return;
      }
      // 求值表达式
      const entry = result.entry.items.get(fnName);
      const interp = new VMInterp(result, { capture: false, maxSteps: 50_000_000 });
      const v = interp.callUser(result.entry, entry, null, [], null);
      decls = src;
      if (v && v.t !== 'unit') process.stdout.write('= ' + (v.t === 'str' ? debugRepr(v.v) : debugValue(v)) + '\n');
    } catch (e) {
      if (e instanceof Panic) process.stderr.write(`panic ${e.code}: ${e.message}\n`);
      else process.stderr.write('内部错误: ' + (e?.message ?? e) + '\n');
      counter--; // 回滚
    }
    rl.prompt();
  });

  rl.on('close', () => {
    process.stdout.write('再见\n');
    process.exit(0);
  });
}

function debugRepr(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function debugValue(v) {
  // 复用 interp 的 debugStr(经 builtin debug 语义)
  return debugStr(v);
}
