#!/usr/bin/env node
// ming.js — Ming 工具链命令行入口。
// 子命令:run / check / test / fmt / doc
// 所有命令支持 --json:结构化输出,供 AI / 工具消费。

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Checker } from '../src/checker.js';
import { Interp, Panic } from '../src/interp.js';
import { VMInterp } from '../src/vm.js';
import { parse, attachDocs as attachDocsImpl } from '../src/parser.js';
import { formatProgram } from '../src/fmt.js';
import { Diagnostic, MingError, formatDiag, cacheSourceLines, SEVERITY } from '../src/diag.js';
import { findManifest, initProject } from '../src/manifest.js';
import { startLsp } from '../src/lsp.js';
import { startRepl } from '../src/repl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.37.0';

const usage = `
Ming(明)v${VERSION} — 为 AI 与人类协作设计的编程语言

用法:
  ming run   [file.ming] [--json] [--tree] [--no-wasm] [--max-steps N] [--max-alloc N] [--max-ms N] [-- args...]
  ming check [file.ming...] [--json]
  ming test  [file.ming...] [--json] [--filter 名称]
  ming build [--json]
  ming init  [项目名]
  ming fmt   <file.ming...> [--write | --check]
  ming doc   <file.ming> [--json]
  ming lsp   (stdio JSON-RPC 语言服务:诊断推送/hover)
  ming repl  (交互式会话:表达式回显、声明持久化)
  ming version

说明:
  * 诊断同时输出人类可读格式与 --json 结构化格式,错误码稳定(见 docs/diagnostics.md)
  * 副作用必须显式声明:fn main() with io { ... };v0.4 无文件系统/网络能力(io/time 之外)
  * 顶层声明:fn / struct / enum / use / test / const / trait / impl
  * 项目模式:run/check/test/build 不带文件参数时,自动向上查找 ming.toml
`.trim();

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  const rest = [];
  let afterDoubleDash = false;
  const VALUE_FLAGS = new Set(['max-steps', 'max-alloc', 'max-ms']); // 空格分隔取值的参数(v0.32)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (afterDoubleDash) { rest.push(a); continue; }
    if (a === '--') { afterDoubleDash = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags.add(k);
      if (v !== undefined) opts[k] = v;
      else if (VALUE_FLAGS.has(k)) { i += 1; opts[k] = argv[i]; } // --max-alloc N 形式
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      flags.add(a.slice(1));
    } else {
      rest.push(a);
    }
  }
  return { flags, opts, rest };
}

function printDiags(diags, json) {
  if (json) return;
  for (const d of diags) {
    process.stderr.write(formatDiag(d, process.stderr.isTTY) + '\n');
  }
}

function diagJson(diags) {
  return diags.map(d => d.toJson());
}

function sortDiags(diags) {
  return diags.slice().sort((a, b) =>
    (a.span?.file ?? '').localeCompare(b.span?.file ?? '') ||
    (a.span?.line ?? 0) - (b.span?.line ?? 0) ||
    (a.span?.col ?? 0) - (b.span?.col ?? 0));
}

function loadAndCheck(file, { json, silent = false } = {}) {
  const checker = new Checker(file);
  let result;
  try {
    result = checker.run();
  } catch (e) {
    if (e instanceof MingError) {
      printDiags(e.diags, json);
      if (json && !silent) process.stdout.write(JSON.stringify({ ok: false, diagnostics: diagJson(e.diags) }, null, 2) + '\n');
      return { ok: false, result: null, diags: e.diags };
    }
    throw e;
  }
  for (const m of result.modules) cacheSourceLines(m.file, m.src);
  const diags = sortDiags(result.diags);
  const errors = diags.filter(d => d.severity === SEVERITY.ERROR);
  printDiags(diags, json);
  if (json && !silent) {
    process.stdout.write(JSON.stringify({
      ok: errors.length === 0,
      files: result.modules.map(m => m.file),
      diagnostics: diagJson(diags),
    }, null, 2) + '\n');
  }
  return { ok: errors.length === 0, result, diags };
}

// ---------- run ----------
function cmdRun(file, flags, opts, programArgs) {
  const json = flags.has('json');
  if (!file) return fail('run 需要一个 .ming 文件', json);
  const c = loadAndCheck(file, { json, silent: true });
  if (!c.ok) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, exit_code: 1, diagnostics: diagJson(c.diags) }, null, 2) + '\n');
    }
    return 1;
  }
  const result = c.result;

  const Engine = (flags.has('tree') ? Interp : VMInterp) ?? null;
  const interp = new (flags.has('no-wasm') ? Interp : Engine)(result, {
    capture: json,
    maxSteps: opts['max-steps'] ? Number(opts['max-steps']) : Infinity,
    maxAlloc: opts['max-alloc'] ? Number(opts['max-alloc']) : 268_435_456,
    maxMs: opts['max-ms'] ? Number(opts['max-ms']) : 600_000,
  });
  const t0 = Date.now();
  try {
    const { exitCode } = interp.runMain(programArgs);
    if (json) {
      process.stdout.write(JSON.stringify({
        ok: true, exit_code: exitCode, ms: Date.now() - t0,
        stdout: interp.flushCaptured(), stderr: '',
      }, null, 2) + '\n');
    }
    return exitCode;
  } catch (e) {
    if (e instanceof Panic) {
      const d = panicDiag(e, result);
      if (json) {
        const dj = d.toJson();
        if (e.cause) {
          dj.cause = {
            code: e.cause.code, message: e.cause.message,
            stack: (e.cause.stack ?? []).map(f => `at ${f.name} (${f.file}:${f.line}:${f.col})`),
          };
        }
        process.stdout.write(JSON.stringify({
          ok: false, exit_code: 101, ms: Date.now() - t0,
          stdout: interp.flushCaptured(), stderr: '',
          diagnostics: [dj],
        }, null, 2) + '\n');
      } else {
        process.stderr.write(formatDiag(d, process.stderr.isTTY) + '\n');
        if (e.stack.length) {
          process.stderr.write('调用栈(Ming 层,最新在前):\n');
          for (const f of e.stack.slice().reverse()) {
            process.stderr.write(`  at ${f.name} (${f.span?.file ?? '?'}:${f.span?.line ?? 0}:${f.span?.col ?? 0})\n`);
          }
        }
        // v0.30 错误链:panic 携带的下级错误(scoped 子任务的真实码与栈)
        if (e.cause) {
          process.stderr.write(`Caused by ${e.cause.code}[${e.cause.message}]\n`);
          for (const f of e.cause.stack ?? []) {
            process.stderr.write(`  at ${f.name} (${f.file}:${f.line}:${f.col})\n`);
          }
        }
      }
      return 101;
    }
    if (e instanceof RangeError) {
      // JS 栈溢出兜底(深嵌套表达式等),按 M4005 报告而不是内部错误
      if (json) {
        process.stdout.write(JSON.stringify({
          ok: false, exit_code: 101, ms: Date.now() - t0,
          stdout: interp.flushCaptured(), stderr: '',
          diagnostics: [{ code: 'M4005', name: 'stack-overflow', severity: 'error', message: '调用栈过深(递归或嵌套过深)' }],
        }, null, 2) + '\n');
      } else {
        process.stderr.write('M4005[stack-overflow]: 调用栈过深(递归或嵌套过深);提示:改写为循环\n');
      }
      return 101;
    }
    if (json) {
      process.stdout.write(JSON.stringify({
        ok: false, exit_code: 2, ms: Date.now() - t0,
        stdout: interp.flushCaptured(), stderr: '',
        internal_error: String(e?.stack ?? e),
      }, null, 2) + '\n');
    } else {
      process.stderr.write(`内部错误(这是 Ming 工具链的 bug,请报告):${e?.stack ?? e}\n`);
    }
    return 2;
  }
}

function panicDiag(p, result) {
  const mod = result.modules.find(m => m.file === p.span?.file) ?? result.entry;
  if (mod) cacheSourceLines(mod.file, mod.src);
  return new Diagnostic(p.code, SEVERITY.ERROR, p.message, p.span ?? null);
}

// ---------- check ----------
function cmdCheck(files, flags) {
  const json = flags.has('json');
  if (!files.length) return fail('check 需要至少一个 .ming 文件', json);
  let allOk = true;
  const allDiags = [];
  const checked = [];
  for (const f of files) {
    const checker = new Checker(f);
    try {
      const result = checker.run();
      for (const m of result.modules) cacheSourceLines(m.file, m.src);
      checked.push(result);
      allDiags.push(...result.diags);
    } catch (e) {
      if (e instanceof MingError) { allDiags.push(...e.diags); allOk = false; continue; }
      throw e;
    }
  }
  const diags = sortDiags(allDiags);
  const hasError = diags.some(d => d.severity === SEVERITY.ERROR);
  if (hasError) allOk = false;
  if (json) {
    process.stdout.write(JSON.stringify({ ok: allOk, diagnostics: diagJson(diags) }, null, 2) + '\n');
  } else {
    printDiags(diags, false);
  }
  return allOk ? 0 : 1;
}

// ---------- test ----------
function cmdTest(files, flags, opts) {
  const json = flags.has('json');
  const filter = opts.filter ?? null;
  if (!files.length) return fail('test 需要至少一个 .ming 文件', json);
  let totalPassed = 0, totalFailed = 0;
  const allResults = [];
  for (const f of files) {
    const c = loadAndCheck(f, { json: false });
    if (!c.ok) { totalFailed++; continue; }
    const Engine = (flags.has('tree') ? Interp : VMInterp) ?? null;
    const interp = new (flags.has('no-wasm') ? Interp : Engine)(c.result, { capture: true });
    const results = interp.runTests(filter);
    for (const r of results) {
      r.file = f;
      allResults.push(r);
      if (r.ok) totalPassed++; else totalFailed++;
    }
  }
  if (json) {
    process.stdout.write(JSON.stringify({
      ok: totalFailed === 0,
      passed: totalPassed, failed: totalFailed,
      results: allResults.map(r => ({
        file: r.file, name: r.name, ok: r.ok,
        error: r.error ?? undefined,
        output: r.output || undefined,
        line: r.span?.line,
      })),
    }, null, 2) + '\n');
  } else {
    for (const r of allResults) {
      const mark = r.ok ? '✓' : '✗';
      process.stdout.write(`${mark} ${r.file}::${r.name}\n`);
      if (!r.ok) {
        if (r.error) process.stderr.write('    ' + r.error.split('\n').join('\n    ') + '\n');
        if (r.output) process.stderr.write('    输出: ' + JSON.stringify(r.output) + '\n');
      } else if (r.output) {
        process.stdout.write('    输出: ' + JSON.stringify(r.output) + '\n');
      }
    }
    process.stdout.write(`\n${totalPassed} 通过,${totalFailed} 失败\n`);
  }
  return totalFailed === 0 ? 0 : 1;
}

// ---------- fmt ----------
function cmdFmt(files, flags) {
  const write = flags.has('write');
  const check = flags.has('check');
  if (!files.length) return fail('fmt 需要至少一个 .ming 文件', false);
  let changed = 0, failed = 0;
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (e) {
      process.stderr.write(`无法读取 ${f}: ${e.message}\n`);
      failed++;
      continue;
    }
    const { program, comments, diags } = parse(f, src);
    if (diags.length) {
      for (const d of diags) process.stderr.write(formatDiag(d, process.stderr.isTTY) + '\n');
      failed++;
      continue;
    }
    const formatted = formatProgram(program.items, comments);
    if (formatted !== src) {
      changed++;
      if (write) fs.writeFileSync(f, formatted, 'utf8');
      else if (!check) process.stdout.write(formatted);
      else process.stdout.write(`${f}: 需要格式化\n`);
    } else if (check) {
      process.stdout.write(`${f}: 已是规范格式\n`);
    }
  }
  if (check) return changed === 0 && failed === 0 ? 0 : 1;
  return failed === 0 ? 0 : 1;
}

// ---------- doc ----------
function cmdDoc(file, flags) {
  const json = flags.has('json');
  if (!file) return fail('doc 需要一个 .ming 文件', json);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) {
    process.stderr.write(`无法读取 ${file}: ${e.message}\n`);
    return 1;
  }
  const { program, comments, diags } = parse(file, src);
  if (diags.length) {
    for (const d of diags) process.stderr.write(formatDiag(d, process.stderr.isTTY) + '\n');
    return 1;
  }
  attachDocsImpl(program.items, comments);

  const items = [];
  for (const it of program.items) {
    if (it.nt === 'FnDecl') {
      const tps = it.tparams.length ? `[${it.tparams.join(', ')}]` : '';
      const params = it.params.map(p => `${p.name}: ${sigType(p.type)}`).join(', ');
      const eff = it.effects?.length ? ` with ${it.effects.map(e => e.name).join(', ')}` : '';
      items.push({ kind: 'fn', name: it.name, signature: `fn ${it.name}${tps}(${params})${it.ret ? ' -> ' + sigType(it.ret) : ''}${eff}`, docs: it.docs ?? [], line: it.span.line });
    } else if (it.nt === 'StructDecl') {
      items.push({ kind: 'struct', name: it.name, signature: `struct ${it.name}{ ${it.fields.map(f => `${f.name}: ${sigType(f.type)}`).join(', ')} }`, docs: it.docs ?? [], line: it.span.line });
    } else if (it.nt === 'EnumDecl') {
      items.push({ kind: 'enum', name: it.name, signature: `enum ${it.name} { ${it.variants.map(v => v.name + (v.types.length ? `(${v.types.map(sigType).join(', ')})` : '')).join(', ')} }`, docs: it.docs ?? [], line: it.span.line });
    } else if (it.nt === 'ConstDecl') {
      items.push({ kind: 'const', name: it.name, signature: `const ${it.name}${it.type ? ': ' + sigType(it.type) : ''} = ...`, docs: it.docs ?? [], line: it.span.line });
    }
  }
  if (json) {
    process.stdout.write(JSON.stringify({ file, items }, null, 2) + '\n');
  } else {
    for (const it of items) {
      process.stdout.write(`## ${it.signature}\n`);
      if (it.docs.length) process.stdout.write(it.docs.map(d => d.replace(/^\/?\//, '').trim()).join('\n') + '\n');
      process.stdout.write(`    (${path.basename(file)}:${it.line})\n\n`);
    }
    if (!items.length) process.stdout.write('(没有可文档化的项;给声明加 /// 文档注释)\n');
  }
  return 0;
}

function sigType(t) {
  switch (t.nt) {
    case 'TName': return t.name + (t.args.length ? `[${t.args.map(sigType).join(', ')}]` : '');
    case 'TTuple': return `(${t.ts.map(sigType).join(', ')})`;
    case 'TFn': return `(${t.ps.map(sigType).join(', ')}) -> ${sigType(t.ret)}`;
    default: return '?';
  }
}

function fail(msg, json) {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  else process.stderr.write(msg + '\n');
  return 1;
}

// ---------- 项目模式:无文件参数时,从 cwd 向上找 ming.toml ----------
function projectEntry(cmd, rest, json) {
  if (rest.length > 0) return { files: rest, proj: null };
  const found = findManifest(process.cwd());
  if (!found) return { files: [], proj: null };
  if (found.diags.length) {
    for (const d of found.diags) process.stderr.write(formatDiag(d, process.stderr.isTTY) + '\n');
    if (json) process.stdout.write(JSON.stringify({ ok: false, diagnostics: found.diags.map(d => d.toJson()) }, null, 2) + '\n');
    return { files: null, proj: found };
  }
  const entry = path.resolve(found.dir, found.project.entry || "main.ming");
  if (!fs.existsSync(entry)) {
    return { files: null, proj: found, error: `清单的入口文件不存在:${found.project.entry}(清单:${found.path})` };
  }
  return { files: [entry], proj: found };
}

// ---------- init ----------
function cmdInit(name, flags) {
  const json = flags.has('json');
  const r = initProject(process.cwd(), name);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: r.ok, ...(r.ok ? { manifest: r.manifestPath, entry: r.entryPath } : { error: r.message }) }, null, 2) + '\n');
  } else if (r.ok) {
    process.stdout.write(`已创建 ${r.manifestPath}\n已创建 ${r.entryPath}\n运行:ming run\n`);
  } else {
    return fail(r.message, json);
  }
  return 0;
}

// ---------- build:项目级全量检查 ----------
function cmdBuild(flags) {
  const json = flags.has('json');
  const { files, proj, error } = projectEntry('build', [], json);
  if (error) return fail(error, json);
  if (!files) return 1;
  if (!proj) return fail('build 需要 ming.toml(在项目目录运行,或 ming init)', json);
  const t0 = Date.now();
  const checker = new Checker(files[0]);
  let ok = true;
  const diags = [];
  try {
    const result = checker.run();
    for (const m of result.modules) cacheSourceLines(m.file, m.src);
    diags.push(...result.diags);
  } catch (e) {
    if (e instanceof MingError) { diags.push(...e.diags); ok = false; }
    else throw e;
  }
  const sorted = sortDiags(diags);
  const hasError = sorted.some(d => d.severity === SEVERITY.ERROR);
  if (hasError) ok = false;
  if (json) {
    process.stdout.write(JSON.stringify({
      ok, project: proj.project.name, version: proj.project.version,
      entry: proj.project.entry, ms: Date.now() - t0,
      diagnostics: diagJson(sorted),
    }, null, 2) + '\n');
  } else {
    printDiags(sorted, false);
    const errs = sorted.filter(d => d.severity === SEVERITY.ERROR).length;
    const warns = sorted.filter(d => d.severity === SEVERITY.WARNING).length;
    process.stdout.write(`${proj.project.name} v${proj.project.version}:${ok ? '构建通过' : '构建失败'}(${errs} 错误,${warns} 警告,${Date.now() - t0}ms)\n`);
  }
  return ok ? 0 : 1;
}

// ---------- main ----------
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { flags, opts, rest } = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(usage + '\n');
    return cmd ? 0 : 1;
  }
  if (cmd === 'version' || cmd === '--version') {
    process.stdout.write(`Ming v${VERSION}\n`);
    return 0;
  }

  switch (cmd) {
    case 'run': {
      const { files, error } = projectEntry('run', rest, flags.has('json'));
      if (error) return fail(error, flags.has('json'));
      const programArgs = files.length > 1 ? files.slice(1) : [];
      const file = files[0];
      return cmdRun(file, flags, opts, programArgs);
    }
    case 'check': {
      const { files, error } = projectEntry('check', rest, flags.has('json'));
      if (error) return fail(error, flags.has('json'));
      return cmdCheck(files, flags);
    }
    case 'test': {
      const { files, error } = projectEntry('test', rest, flags.has('json'));
      if (error) return fail(error, flags.has('json'));
      return cmdTest(files, flags, opts);
    }
    case 'build': return cmdBuild(flags);
    case 'init': return cmdInit(rest[0], flags);
    case 'lsp': startLsp(); return null; // 常驻:不退出进程
    case 'repl': startRepl(); return null; // 常驻:不退出进程
    case 'fmt': return cmdFmt(rest, flags);
    case 'doc': return cmdDoc(rest[0], flags);
    default:
      process.stderr.write(`未知命令 "${cmd}"\n\n${usage}\n`);
      return 1;
  }
}

// lsp 常驻:main 返回 null 时不退出进程
const __code = main();
if (__code !== null) process.exit(__code);
