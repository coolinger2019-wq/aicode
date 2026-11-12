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
import { compile } from '../src/compiler.js';
import { serializeArtifact } from '../src/artifact.js';
import { emitC } from '../src/cbackend.js';
import { Unsupported, wasmLayerStatus } from '../src/wasm.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.53.0';

const usage = `
Ming(明)v${VERSION} — 为 AI 与人类协作设计的编程语言

用法:
  ming run   [file.ming] [--json] [--tree] [--no-wasm] [--strict-wasm] [--max-steps N] [--max-alloc N] [--max-ms N] [-- args...]
  ming check [file.ming...] [--json] [--proof-report] [--warn-unproven-index] [--strict-wasm]
  ming test  [file.ming...] [--json] [--filter 名称]
  ming build [--json] [--clean-cache] [--with-source] [--no-dist]
  ming cc    <file.ming> [--emit-c] [--out 目录|-o 目录] [--json] [-- args...]
  ming tools [--list] <命令> [参数...]   (自举工具统一入口:patch/edit/diff/diag/wc/...)
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
  const dashRest = []; // v0.52:'--' 之后的程序参数,不再混入文件位置参数
  const errors = [];
  let afterDoubleDash = false;
  const VALUE_FLAGS = new Set(['max-steps', 'max-alloc', 'max-ms', 'out']); // 空格分隔取值的参数
  const NUMERIC_FLAGS = new Set(['max-steps', 'max-alloc', 'max-ms']);
  const takeValue = (name, i) => {
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt === '--' || /^--/.test(nxt) || /^-[A-Za-z]/.test(nxt)) {
      errors.push(`--${name} 需要一个值`);
      return null;
    }
    if (NUMERIC_FLAGS.has(name) && !/^\d+$/.test(nxt)) {
      errors.push(`--${name} 需要非负整数,得到 "${nxt}"`);
      return null;
    }
    return nxt;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (afterDoubleDash) { dashRest.push(a); continue; }
    if (a === '--') { afterDoubleDash = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags.add(k);
      if (v !== undefined) {
        if (NUMERIC_FLAGS.has(k) && !/^\d+$/.test(v)) errors.push(`--${k} 需要非负整数,得到 "${v}"`);
        else opts[k] = v;
      } else if (VALUE_FLAGS.has(k)) {
        const val = takeValue(k, i);
        if (val !== null) { i += 1; opts[k] = val; }
      }
    } else if (a === '-o') {
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt === '--' || nxt.startsWith('-')) errors.push('-o 需要一个目录');
      else { i += 1; opts.out = nxt; }
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      flags.add(a.slice(1));
    } else {
      rest.push(a);
    }
  }
  return { flags, opts, rest, dashRest, errors };
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

// ---------- v0.53 阶段1:strict wasm(--strict-wasm / MING_WASM_STRICT=1)----------
// strict 模式把"静默回落"变成可见失败:eligible>0 但编译/实例化回落 → 退出码 2 并点名原因。
// 判定本体在 src/wasm.js 的 wasmLayerStatus(纯函数);此处只做旗标仲裁与输出。
function strictWasmOn(flags) {
  return flags.has('strict-wasm') || process.env.MING_WASM_STRICT === '1';
}
function strictWasmConflict(flags) {
  return strictWasmOn(flags) && (flags.has('tree') || flags.has('no-wasm'));
}
const STRICT_WASM_CONFLICT_MSG = '--strict-wasm 与 --tree/--no-wasm 互斥(strict 模式观测的正是 wasm 分层本身;先去掉 --tree/--no-wasm)';

// ---------- run ----------
function cmdRun(file, flags, opts, programArgs) {
  const json = flags.has('json');
  if (!file) return fail('run 需要一个 .ming 文件', json);
  if (strictWasmConflict(flags)) return fail(STRICT_WASM_CONFLICT_MSG, json);
  const c = loadAndCheck(file, { json, silent: true });
  if (!c.ok) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, exit_code: 1, diagnostics: diagJson(c.diags) }, null, 2) + '\n');
    }
    return 1;
  }
  const result = c.result;

  // v0.53 strict:先判定 wasm 分层,回落 → 退出码 2(不运行);预编译产物传给 VM 避免双份 compile。
  // 非 strict 不进入此分支 —— 现状静默回落行为逐字不变。
  let strictStatus = null;
  let strictCompiled = null;
  if (strictWasmOn(flags) && !flags.has('tree')) {
    strictCompiled = compile(result);
    strictStatus = wasmLayerStatus(result, strictCompiled);
    if (strictStatus.status === 'fallback') {
      const why = strictStatus.reason ?? '未知原因';
      if (json) {
        process.stdout.write(JSON.stringify({ ok: false, exit_code: 2, wasm_status: 'fallback', error: why }, null, 2) + '\n');
      } else {
        process.stderr.write(`strict-wasm: ${why}\n`);
      }
      return 2;
    }
  }

  const interpOpts = {
    capture: json,
    noWasm: flags.has('no-wasm'),
    maxSteps: opts['max-steps'] ? Number(opts['max-steps']) : Infinity,
    maxAlloc: opts['max-alloc'] ? Number(opts['max-alloc']) : 268_435_456,
    maxMs: opts['max-ms'] ? Number(opts['max-ms']) : 600_000,
  };
  if (strictStatus) interpOpts.precompiled = strictCompiled;
  const interp = flags.has('tree') ? new Interp(result, interpOpts) : new VMInterp(result, interpOpts);
  // v0.53 additive:run --json 的 wasm_status(vm 模式;tree 无 wasm 分层,键集保持不变)。
  // 非 strict 时仅 --json 输出才判定(惰性);strict 时复用运行前的判定(字符串化)。
  // --no-wasm:wasm 层未参与执行,不输出该字段(否则会被误读为"wasm 已跑过")。
  let statusCache = strictStatus ? strictStatus.status : null;
  const wasmStatusField = () => {
    if (flags.has('tree') || flags.has('no-wasm')) return undefined;
    if (statusCache === null) statusCache = wasmLayerStatus(result, interp.compiled).status;
    return statusCache;
  };
  const t0 = Date.now();
  try {
    const { exitCode } = interp.runMain(programArgs);
    if (json) {
      const out = {
        ok: true, engine: flags.has('tree') ? 'tree' : 'vm', wasm: !flags.has('tree') && !flags.has('no-wasm'), exit_code: exitCode, ms: Date.now() - t0,
        stdout: interp.flushCaptured(), stderr: '',
      };
      const ws = wasmStatusField();
      if (ws) out.wasm_status = ws;
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
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
        const pout = {
          ok: false, engine: flags.has('tree') ? 'tree' : 'vm', wasm: !flags.has('tree') && !flags.has('no-wasm'), exit_code: 101, ms: Date.now() - t0,
          stdout: interp.flushCaptured(), stderr: '',
          diagnostics: [dj],
        };
        const pws = wasmStatusField();
        if (pws) pout.wasm_status = pws;
        process.stdout.write(JSON.stringify(pout, null, 2) + '\n');
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
        const rout = {
          ok: false, engine: flags.has('tree') ? 'tree' : 'vm', wasm: !flags.has('tree') && !flags.has('no-wasm'), exit_code: 101, ms: Date.now() - t0,
          stdout: interp.flushCaptured(), stderr: '',
          diagnostics: [{ code: 'M4005', name: 'stack-overflow', severity: 'error', message: '调用栈过深(递归或嵌套过深)' }],
        };
        const rws = wasmStatusField();
        if (rws) rout.wasm_status = rws;
        process.stdout.write(JSON.stringify(rout, null, 2) + '\n');
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
  // v0.52 阶段 3:--proof-report 证明报告 + --warn-unproven-index W3105 观测旗标。
  // 两旗标仅 check 消费;其他命令按既有风格忽略未知旗标(命令只读取自己认识的旗标)。
  const proofReport = flags.has('proof-report');
  const warnUnprovenIndex = flags.has('warn-unproven-index');
  // v0.53:--strict-wasm 仅在 check 通过后做 wasm 分层存活验证(fallback → 退出码 2);
  // 与 --tree/--no-wasm 互斥;非 strict 时 check 不编译,JSON 也不带 wasm_status。
  if (strictWasmConflict(flags)) return fail(STRICT_WASM_CONFLICT_MSG, json);
  if (!files.length) return fail('check 需要至少一个 .ming 文件', json);
  let allOk = true;
  const allDiags = [];
  const checked = [];
  for (const f of files) {
    const checker = new Checker(f, null, { warnUnprovenIndex });
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
  // --proof-report:证明摘要(additive;不带旗标时 JSON 与文本输出逐字不变)。
  // 违反诊断(M3045)仍走既有诊断通道,proofs 字段与之共存不冲突。
  const proofs = proofReport ? collectProofs(checked) : null;
  // v0.53:strict wasm —— check 通过后逐文件验证分层存活;任一 fallback → 退出码 2 并点名原因。
  // 聚合语义:有 fallback → 'fallback';否则有 ok → 'ok';否则 'none'。仅 strict 时计算与输出。
  // 审查修复:fallback 不再走独立输出路径——与正常路径共用同一 out 构造(ok/diagnostics/proofs/
  // wasm_status),否则 --proof-report 的 proofs 与 warnings 会被吞掉;fallback 时 ok:false(与 run 一致)。
  let wasmAgg = null;
  let wasmFallback = false;
  const strictReasons = [];
  if (strictWasmOn(flags) && allOk) {
    let anyFallback = false, anyOk = false;
    for (const r of checked) {
      const st = wasmLayerStatus(r, compile(r));
      if (st.status === 'fallback') {
        anyFallback = true;
        strictReasons.push(`${r.entry?.file ?? '?'}: ${st.reason ?? '未知原因'}`);
      }
      if (st.status === 'ok') anyOk = true;
    }
    wasmAgg = anyFallback ? 'fallback' : (anyOk ? 'ok' : 'none');
    wasmFallback = anyFallback;
  }
  // 单一输出出口(正常路径与 strict fallback 共用;文本模式先 printDiags/proofs,再报 strict 原因)
  if (json) {
    const out = { ok: wasmFallback ? false : allOk, diagnostics: diagJson(diags) };
    if (proofs) out.proofs = proofs;
    if (wasmAgg) out.wasm_status = wasmAgg;
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    printDiags(diags, false);
    if (proofs) printProofs(proofs);
  }
  for (const why of strictReasons) process.stderr.write(`strict-wasm: ${why}\n`);
  if (wasmFallback) return 2;
  return allOk ? 0 : 1;
}

function printProofs(proofs) {
  for (const fn of proofs.functions) {
    process.stdout.write(`${fn.file}:${fn.fn}: 义务 ${fn.total},proven ${fn.proven},violated ${fn.violated},unproven ${fn.unproven}\n`);
  }
}

// v0.52 --proof-report:聚合 checker 的逐义务证明记录(有 Vec 索引义务的函数;零义务语料为空)。
function collectProofs(checked) {
  const functions = [];
  const summary = { functions: 0, obligations: 0, proven: 0, violated: 0, unproven: 0 };
  for (const r of checked) {
    for (const rec of r.proofs ?? []) {
      functions.push(rec);
      summary.functions += 1;
      summary.obligations += rec.total;
      summary.proven += rec.proven;
      summary.violated += rec.violated;
      summary.unproven += rec.unproven;
    }
  }
  return { summary, functions };
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
    const testOpts = { capture: true, noWasm: flags.has('no-wasm') };
    const interp = flags.has('tree') ? new Interp(c.result, testOpts) : new VMInterp(c.result, testOpts);
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

// v0.49:decl 的规范化接口对象(排除函数体/位置信息;含契约与字段默认值——
// 它们属于 ABI:下游行为与 M3042/M4015 检查依赖它们)
function stripAst(node) {
  if (Array.isArray(node)) return node.map(stripAst);
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) {
      if (k === 'span' || k === 'docs' || k === 'nameSpan') continue;
      out[k] = stripAst(node[k]);
    }
    return out;
  }
  return node;
}

function fnIface(d) {
  return {
    nt: 'fn', name: d.name, tparams: d.tparams ?? [], bounds: (d.bounds ?? []).map(b => b.name + ':' + b.trait), pub: !!d.pub, local: !!d.local,
    params: (d.params ?? []).map(p => ({ name: p.name, mut: !!p.mut, self: !!p.self, type: p.type ? stripAst(p.type) : null })),
    ret: d.ret ? stripAst(d.ret) : null,
    effects: (d.effects ?? []).map(x => x.name),
    requires: d.requires ? stripAst(d.requires) : null,
    ensures: d.ensures ? stripAst(d.ensures) : null,
  };
}

// 模块接口哈希:decl 的规范化序列化(排除函数体),sha256 前 16 位
function moduleIfaceHash(mod) {
  const canon = [];
  for (const [name, entry] of mod.items) {
    const d = entry.decl;
    switch (entry.kind) {
      case 'fn': canon.push(['fn', name, fnIface(d)]); break;
      case 'struct': canon.push(['struct', name, {
        tparams: d.tparams ?? [],
        fields: (d.fields ?? []).map(f => ({ name: f.name, type: f.type ? stripAst(f.type) : null, dflt: f.dflt ? stripAst(f.dflt) : null, mut: !!f.mut, pub: !!f.pub })),
        invariants: (d.invariants ?? []).map(i => stripAst(i.expr)),
        pub: !!entry.pub,
      }]); break;
      case 'enum': canon.push(['enum', name, { variants: (d.variants ?? []).map(v => ({ name: v.name, types: (v.types ?? []).map(t => stripAst(t)) })), pub: !!entry.pub }]); break;
      case 'const': canon.push(['const', name, { type: d.type ? stripAst(d.type) : null, value: stripAst(d.value ?? null), pub: !!entry.pub }]); break;
      case 'trait': canon.push(['trait', name, {
        tparams: d.tparams ?? [],
        methods: (d.methods ?? []).map(m => fnIface(m)),
        pub: !!entry.pub,
      }]); break;
      case 'impl': canon.push(['impl', d.trait, d.typeName, { tparams: d.tparams ?? [], bounds: (d.bounds ?? []).map(b => b.name + ':' + b.trait), typeArgs: (d.typeArgs ?? []).map(t => stripAst(t)), methods: (d.methods ?? []).map(m => fnIface(m)) }]); break;
      default: break;
    }
  }
  canon.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

// v0.51.2:目录内容哈希(相对路径 + 文件 sha256),用于缓存命中的 dist 完整性校验
function hashTree(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(path.relative(dir, p).split(path.sep).join('/') + '|' + createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  files.sort();
  return createHash('sha256').update(files.join(String.fromCharCode(10))).digest('hex');
}

// 项目根目录下全部 .ming 与 ming.toml(排除隐藏/dist/.ming-cache/node_modules)。
// v0.53 修复:旧实现目录分支 `out.push(...walk(p))` 把共享闭包数组 push 进自身 ——
// 嵌套目录条目成倍重复(两层项目 4 文件收出 11 条),且条目只用 basename,
// 同名不同目录交换内容构建键不变(漏检)。修复:每层返回本次新增条目,
// 条目 = 项目相对路径(unix 斜杠)+ \0 + 文件内容;调用方拿到排序后的列表。
function collectProjectSources(root) {
  const walk = (d, prefix) => {
    const out = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === '.ming-cache') continue;
      const p = path.join(d, e.name);
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) out.push(...walk(p, rel));
      else if (e.name.endsWith('.ming') || e.name === 'ming.toml') out.push(rel + '\u0000' + fs.readFileSync(p, 'utf8'));
    }
    return out;
  };
  return walk(root, '').sort();
}

// ---------- tools:自举工具统一入口(v0.50;工具本体仍是 tools/*.ming,Ming 自写) ----------
// 目的:去掉 `node bin/ming.js run tools/xxx.ming -- ...` 的长命令行摩擦。
const TOOL_CMDS = {
  patch: { file: 'mingkit.ming', prefix: ['replace'] },
  'patch-all': { file: 'mingkit.ming', prefix: ['replace-all'] },
  read: { file: 'mingkit.ming', prefix: ['read'] },
  write: { file: 'mingkit.ming', prefix: ['write'] },
  append: { file: 'mingkit.ming', prefix: ['append'] },
  insert: { file: 'mingkit.ming', prefix: ['insert-after'] },
  'insert-before': { file: 'mingkit.ming', prefix: ['insert-before'] },
  del: { file: 'mingkit.ming', prefix: ['delete-lines'] },
  count: { file: 'mingkit.ming', prefix: ['count'] },
  edit: { file: 'edit.ming', prefix: [] },
  diff: { file: 'engdiff.ming', prefix: [] },
  diag: { file: 'diaghot.ming', prefix: [] },
  wc: { file: 'wc.ming', prefix: [] },
  tree: { file: 'tree.ming', prefix: [] },
  find: { file: 'find_files.ming', prefix: [] },
  json: { file: 'json_query.ming', prefix: [] },
  todo: { file: 'todo_scan.ming', prefix: [] },
  log: { file: 'log_analyzer.ming', prefix: [] },
  rename: { file: 'batch_rename.ming', prefix: [] },
  organize: { file: 'file_organizer.ming', prefix: [] },
};

const toolsUsage = `
ming tools — 自举工具统一入口(工具均为 tools/*.ming,用 Ming 自写)

用法: ming tools <命令> [参数...] [-- <工具自有选项...>]
  patch <file> <old> <new>        精确替换恰好 1 处(0/多处拒绝)
  patch-all <file> <old> <new>    替换全部
  read <file> [start] [end]       读文件/行区间(1-based 含端点)
  write <file>                    用 stdin 全量覆盖写入
  append <file>                   用 stdin 全量追加
  insert <file> <pat> <text>      在第一个含 pat 的行后插入
  insert-before <file> <pat> <text>
  del <file> <start> [end]        删行区间(缺 end = 删到文件尾)
  count <file>                    行/字符/字节统计
  edit <子命令> ...               行级编辑(show/get/set/ins/del/sub/append/count)
  diff <file.ming>                多引擎差分(engdiff)
  diag <文件或目录...> [--top N]  诊断热力图(diaghot;目录递归收 .ming,默认 Top-10)
  wc <file...>                    行/词/字节(多文件附 total 行)
  json <file> <点路径>            取字段,支持 a.b.0.c;字符串裸输出,其余 JSON 原貌
  tree <目录> [深度]              目录树(深度缺省不限)
  find <目录> <子串>              按名查找文件(递归)
  todo <目录>                     扫描 TODO/FIXME/XXX/HACK
  log <文件>                      ERROR/WARN/INFO 行计数
  rename <目录> <前缀> [扩展名]   批量改名(幂等:已带前缀的跳过)
  organize <目录>                 按扩展名移动进子目录
  任意已有文件也可直接: ming tools <名> [参数...](对应 tools/<名>.ming)
纪律:所有工具错误走 stderr,失败退出码 1;破坏性操作(rename/organize)目录必须显式给出。
示例: ming tools patch src/x.js "旧串" "新串"
      ming tools diag examples -- --top 5
`.trim();

function resolveTool(cmd) {
  if (TOOL_CMDS[cmd]) return TOOL_CMDS[cmd];
  const f = path.join(__dirname, '..', 'tools', cmd + '.ming');
  if (/^[a-z0-9_-]+$/i.test(cmd) && fs.existsSync(f)) return { file: cmd + '.ming', prefix: [] };
  return null;
}

function cmdTools(rest, flags, opts, dashRest) {
  if (!rest.length || rest[0] === 'list' || flags.has('list')) {
    process.stdout.write(toolsUsage + '\n');
    return (flags.has('list') || rest.length) ? 0 : 1;
  }
  const cmd = rest[0];
  const hit = resolveTool(cmd);
  if (!hit) {
    process.stderr.write(`未知工具 "${cmd}"\n\n${toolsUsage}\n`);
    return 1;
  }
  const file = path.join(__dirname, '..', 'tools', hit.file);
  // v0.51.6:`--` 之后的参数透传给工具(与 run/cc 一致),工具才能收到 --top 等自有选项
  return cmdRun(file, flags, opts, [...hit.prefix, ...rest.slice(1), ...(dashRest ?? [])]);
}

function cmdBuild(flags) {
  const json = flags.has('json');
  const { files, proj, error } = projectEntry('build', [], json);
  if (error) return fail(error, json);
  if (!files) return 1;
  if (!proj) return fail('build 需要 ming.toml(在项目目录运行,或 ming init)', json);
  const t0 = Date.now();
  const projectRoot = path.dirname(files[0]);
  const distDir = path.join(projectRoot, 'dist');
  const cacheDir = path.join(projectRoot, '.ming-cache');
  const cacheFile = path.join(cacheDir, 'build-cache.json');
  // v0.49:--clean-cache 删除缓存与 dist,强制全量重建
  if (flags.has('clean-cache')) {
    fs.rmSync(cacheFile, { force: true });
    if (fs.existsSync(distDir)) {
      const marker = path.join(distDir, '.ming-dist.json');
      if (fs.existsSync(marker) || fs.existsSync(path.join(distDir, 'ming-app.mjs'))) {
        fs.rmSync(distDir, { recursive: true, force: true });
      } else if (!json) {
        process.stderr.write('dist/ 不是 Ming 产物(缺少 .ming-dist.json),已跳过删除' + String.fromCharCode(10));
      }
    }
    if (!json) process.stdout.write('已清理构建缓存与 dist\n');
  }
  // v0.51.2:拒绝覆盖非产物 dist(避免递归删除用户源码目录)
  if (fs.existsSync(distDir)) {
    const marker = path.join(distDir, '.ming-dist.json');
    if (!fs.existsSync(marker) && !fs.existsSync(path.join(distDir, 'ming-app.mjs'))) {
      return fail('dist 目录已存在且不是 Ming 产物(缺少 .ming-dist.json);拒绝覆盖', json);
    }
  }
  // v0.49:构建缓存——键 = 规范化哈希(编译器版本 + 项目全部 .ming 源 + ming.toml)
  // 过包含保健全:任何源变化 → 键变化 → 重建;命中 → 跳过 check+compile(dist 已有效)
  // v0.53:注入 Node 主版本(同内容跨 Node 大版本不再假命中);sources 由修复后的
  // collectProjectSources 提供(相对路径 + 内容,无重复)
  const sources = collectProjectSources(projectRoot);
  const buildKey = createHash('sha256').update(JSON.stringify({
    v: VERSION, node: process.versions.node.split('.')[0], manifest: proj.project ?? null, withSource: !!flags.has('with-source'), sources,
  })).digest('hex').slice(0, 32);
  let prevCache = null;
  try { prevCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { prevCache = null; }
  const distIntact = !!prevCache?.distHash && hashTree(distDir) === prevCache.distHash;
  if (!flags.has('no-dist') && !flags.has('clean-cache') && prevCache && prevCache.key === buildKey && distIntact) {
    // v0.53 --json additive:build_key/dist_hash/cache_hit/source_count/interface_hashes
    if (json) process.stdout.write(JSON.stringify({
      ok: true, project: proj.project.name, cache: 'hit', ms: Date.now() - t0,
      build_key: buildKey, dist_hash: prevCache.distHash, cache_hit: true,
      source_count: sources.length, interface_hashes: Array.isArray(prevCache.modules) ? prevCache.modules : [],
    }, null, 2) + '\n');
    else process.stdout.write('缓存命中(键未变,跳过检查与编译;--clean-cache 清除)\n');
    return 0;
  }
  const checker = new Checker(files[0]);
  let ok = true;
  let checkResult = null;
  const diags = [];
  try {
    checkResult = checker.run();
    for (const m of checkResult.modules) cacheSourceLines(m.file, m.src);
    diags.push(...checkResult.diags);
  } catch (e) {
    if (e instanceof MingError) { diags.push(...e.diags); ok = false; }
    else throw e;
  }
  const sorted = sortDiags(diags);
  const hasError = sorted.some(d => d.severity === SEVERITY.ERROR);
  if (hasError) ok = false;
  // v0.53 --json:JSON 块延后到 dist 产出之后打印 —— dist_hash/interface_hashes 需要产物落地;
  // ms 保持与 HEAD 相同的计时点(检查+诊断,不含产物生成)。文本模式逐字不变。
  const msElapsed = Date.now() - t0;
  // v0.53:接口哈希在 check 通过后即可计算(no-dist/构建失败路径也要进 JSON;文本报告仍在 dist 块)
  const moduleHashes = ok ? checkResult.modules.map(m => ({ file: path.basename(m.file), interfaceHash: moduleIfaceHash(m) })) : [];
  let distHashOut = null; // dist 产出后由 hashTree 填充;未产 dist(null)进 JSON
  if (!json) {
    printDiags(sorted, false);
    const errs = sorted.filter(d => d.severity === SEVERITY.ERROR).length;
    const warns = sorted.filter(d => d.severity === SEVERITY.WARNING).length;
    process.stdout.write(`${proj.project.name} v${proj.project.version}:${ok ? '构建通过' : '构建失败'}(${errs} 错误,${warns} 警告,${Date.now() - t0}ms)\n`);
  }
  // v0.39 真 AOT:字节码 JSON 产物(加载端跳过 Checker 与编译器);受限形态回退源码模式
  if (ok && !flags.has('no-dist')) {
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(distDir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(distDir, '.ming-dist.json'), JSON.stringify({ tool: 'ming', version: VERSION }) + String.fromCharCode(10));
    for (const m of ['checker.js', 'compiler.js', 'interp.js', 'vm.js', 'wasm.js', 'lexer.js', 'parser.js', 'diag.js', 'artifact.js', 'prover.js']) {
      fs.copyFileSync(path.join(__dirname, '..', 'src', m), path.join(distDir, 'runtime', m));
    }
    // AOT 资格:无 sync(spawn 子任务需源码编译)、无用户 trait/impl 方法分发
    let aotErr = null;
    try {
      // v0.43 修复:效果在 entry.sig.effects(entry 本身无 effects 字段)——此前恒 false,
      // spawn 程序误进 AOT,运行期 worker 读 '<artifact>' 源路径 → ENOENT
      const usesSync = checkResult.modules.some(m => [...m.items.values()].some(e => {
        const eff = e.sig?.effects ?? e.effects;
        return eff instanceof Set && eff.has('sync');
      }));
      if (usesSync) throw new Error('程序使用 sync 并发(spawn 子任务由源码编译)');
      const compiled = compile(checkResult);
      const artifact = serializeArtifact(compiled, { baseDir: projectRoot });
      artifact.builtBy = VERSION;
      fs.writeFileSync(path.join(distDir, 'app.bytecode.json'), JSON.stringify(artifact));
    } catch (e) {
      aotErr = e.message;
    }
    const launcher = [
      '#!/usr/bin/env node',
      '// Ming 可移植产物(v0.39):Node >= 18,零依赖;用法:node ming-app.mjs [-- args]',
      "import { VMInterp } from './runtime/vm.js';",
      "import * as fs from 'node:fs';",
      "import * as path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      '',
      'const here = path.dirname(fileURLToPath(import.meta.url));',
      "const bjson = path.join(here, 'app.bytecode.json');",
      "const mingFile = path.join(here, 'app.ming');",
      'let vm;',
      'if (fs.existsSync(bjson)) {',
      '  const artifact = JSON.parse(fs.readFileSync(bjson, "utf8"));',
      '  vm = VMInterp.fromArtifact(artifact, {});',
      '} else {',
      "  const { Checker } = await import('./runtime/checker.js');",
      '  const checker = new Checker(mingFile);',
      '  const result = checker.run();',
      "  const errs = result.diags.filter(d => d.severity === 'error');",
      '  if (errs.length) {',
      "    process.stderr.write(errs.map(d => d.code + ': ' + d.message).join('\\n') + '\\n');",
      '    process.exit(1);',
      '  }',
      '  vm = new VMInterp(result, {});',
      '}',
      'try {',
      "  const pargs = process.argv.slice(2);",
      "  if (pargs[0] === '--') pargs.shift();",
      '  const { exitCode } = vm.runMain(pargs);',
      '  process.exit(exitCode);',
      '} catch (e) {',
      "  if (e && typeof e.code === 'string') { process.stderr.write(e.code + ': ' + e.message + '\\n'); process.exit(101); }",
      '  throw e;',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(distDir, 'ming-app.mjs'), launcher);
    if (aotErr) {
      fs.copyFileSync(files[0], path.join(distDir, 'app.ming'));
      // v0.51.2:回退时复制全部已加载模块(保留相对路径),否则多模块 dist 不可运行
      const entryAbs = path.resolve(files[0]);
      for (const m of checkResult.modules) {
        const mAbs = path.resolve(m.file);
        if (mAbs === entryAbs) continue;
        const rel = path.relative(path.dirname(entryAbs), mAbs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        if (!fs.existsSync(mAbs)) continue;
        const dest = path.join(distDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(mAbs, dest);
      }
      process.stderr.write(`AOT 不可用:${aotErr};已回退源码模式(产物含明文源)\n`);
      // --json:人读行改走 stderr,stdout 只留 JSON(可被 JSON.parse 直接消费)
      (json ? process.stderr : process.stdout).write('产物:dist/(app.ming 源码模式 + runtime + ming-app.mjs)\n');
    } else {
      if (flags.has('with-source')) {
        fs.copyFileSync(files[0], path.join(distDir, 'app.ming'));
        (json ? process.stderr : process.stdout).write('产物:dist/(app.bytecode.json 字节码 + runtime + ming-app.mjs;--with-source 附源码)\n');
      } else {
        (json ? process.stderr : process.stdout).write('产物:dist/(app.bytecode.json 字节码,无明文源 + runtime + ming-app.mjs;用法:node dist/ming-app.mjs)\n');
      }
    }
    // v0.49:写构建缓存(键 + 每模块接口哈希)并报告接口变更(ABI 防火墙可观测)
    // v0.53:distHash 提取为 distHashOut(--json 的 dist_hash 复用同一值)
    distHashOut = hashTree(distDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      key: buildKey, builtAt: new Date().toISOString(), compilerVersion: VERSION, distHash: distHashOut, modules: moduleHashes,
    }, null, 1));
    if (prevCache && Array.isArray(prevCache.modules)) {
      const prevByFile = new Map(prevCache.modules.map(x => [x.file, x.interfaceHash]));
      const unchanged = moduleHashes.filter(x => prevByFile.get(x.file) === x.interfaceHash);
      const changed = moduleHashes.filter(x => prevByFile.get(x.file) !== x.interfaceHash);
      if (!json) {
        process.stdout.write(`接口哈希:未变 ${unchanged.length} 个${changed.length ? ',变更 ' + changed.map(x => x.file).join(', ') : ''}\n`);
      }
    }
  }
  // v0.53 --json:块尾打印(既有字段与 HEAD 逐字一致;新增字段全部 additive)
  if (json) {
    process.stdout.write(JSON.stringify({
      ok, project: proj.project.name, version: proj.project.version,
      entry: proj.project.entry, ms: msElapsed,
      diagnostics: diagJson(sorted),
      build_key: buildKey, cache_hit: false, source_count: sources.length,
      dist_hash: distHashOut, interface_hashes: moduleHashes,
    }, null, 2) + '\n');
  }
  return ok ? 0 : 1;
}

// ---------- cc:C 后端 C1(eligible 数值函数 → C + GCC/Clang -O2)----------
// 探测顺序:MING_CC 环境变量 → PATH(gcc/clang/cc)→ 已知便携位置(w64devkit 等)
function detectCCompiler(json) {
  const candidates = [];
  if (process.env.MING_CC) candidates.push(process.env.MING_CC);
  candidates.push('gcc', 'clang', 'cc');
  for (const p of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
    if (fs.existsSync(p)) candidates.push(p);
  }
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) return c;
    } catch { /* ENOENT 等:试下一个 */ }
  }
  return null;
}

function cmdCC(file, flags, opts, programArgs) {
  const json = flags.has('json');
  if (!file) return fail('cc 需要一个 .ming 文件', json);
  const c = loadAndCheck(file, { json, silent: true });
  if (!c.ok) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, exit_code: 1, diagnostics: diagJson(c.diags) }, null, 2) + '\n');
    return 1;
  }
  const result = c.result;
  let emitted;
  try {
    const compiled = compile(result);
    emitted = emitC(result, compiled);
  } catch (e) {
    if (e instanceof Unsupported) {
      return fail('C1 不支持该程序形态:' + e.message, json);
    }
    throw e;
  }
  const outDir = opts['out'] ?? 'ming-cc-out';
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(file).replace(/\.ming$/i, '');
  const cFile = path.join(outDir, base + '.c');
  const exeFile = path.join(outDir, base + (process.platform === 'win32' ? '.exe' : ''));
  fs.writeFileSync(cFile, emitted.code, 'utf8');
  if (flags.has('emit-c')) {
    if (json) process.stdout.write(JSON.stringify({ ok: true, c_file: cFile, eligible: emitted.eligible.size }, null, 2) + '\n');
    else process.stdout.write(`已发射 C 源:${cFile}(eligible ${emitted.eligible.size} 个函数;--emit-c 不编译)\n`);
    return 0;
  }
  const ccPath = detectCCompiler(json);
  if (!ccPath) return fail('未找到 C 编译器(需要 gcc 或 clang;可设 MING_CC 指向编译器路径)', json);
  // v0.42:--static 静态链接(部署形态;工具链不支持时 gcc 报错透传)
  const build = spawnSync(ccPath, ['-O2', ...(flags.has('static') ? ['-static'] : []), cFile, '-o', exeFile], { encoding: 'utf8', timeout: 120000 });
  if (build.status !== 0) {
    process.stderr.write((build.stderr || build.stdout || 'C 编译失败') + '\n');
    return 1;
  }
  if (flags.has('no-run')) {
    // v0.41:只构建不运行 —— cc 的运行退出码 = 程序退出码(panic → 101),差分工具据此分离构建与运行
    if (json) process.stdout.write(JSON.stringify({ ok: true, c_file: cFile, exe: exeFile, eligible: emitted.eligible.size }, null, 2) + '\n');
    else process.stdout.write(`已构建:${exeFile}(--no-run 不运行)\n`);
    return 0;
  }
  const run = spawnSync(exeFile, programArgs, { stdio: 'inherit', timeout: 600000 });
  return run.status ?? 1;
}

// ---------- main ----------
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { flags, opts, rest, dashRest, errors } = parseArgs(argv.slice(1));
  if (errors.length) {
    for (const e of errors) process.stderr.write(e + String.fromCharCode(10));
    return 1;
  }

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
      const programArgs = [...(files.length > 1 ? files.slice(1) : []), ...dashRest];
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
    case 'tools': return cmdTools(rest, flags, opts, dashRest);
    case 'cc': {
      const { files, error } = projectEntry('cc', rest, flags.has('json'));
      if (error) return fail(error, flags.has('json'));
      const programArgs = [...(files.length > 1 ? files.slice(1) : []), ...dashRest];
      return cmdCC(files[0], flags, opts, programArgs);
    }
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
