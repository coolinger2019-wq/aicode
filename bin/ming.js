#!/usr/bin/env node
// ming.js — Ming 工具链命令行入口。
// 子命令:run / check / test / fmt / doc
// 所有命令支持 --json:结构化输出,供 AI / 工具消费。

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';
import { createHash } from 'node:crypto';
// child_process 仅 cc 用:实测内建导入 ~1.6ms,对 tools/version 是纯开销 → 按命令惰性加载。
let _spawnSync = null;
async function lazySpawnSync() {
  if (!_spawnSync) _spawnSync = (await import('node:child_process')).spawnSync;
  return _spawnSync;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.67.0';

// v0.57 tools AOT(usage-audit §4 行动1)配套:Node 编译缓存 + 全惰性模块加载。
// 实测(同窗口 A/B):全图 ESM 解析+编译 ≈ 28ms,占 ming tools 命中路径开销的大头;
// enableCompileCache 让 V8 跨进程复用代码缓存,second-run 起整个 CLI 提速 ~28ms。
// 必须在任何 src 模块加载前调用 —— 因此 bin 的 src 导入全部惰性化(loadCore/lazy*),
// 首个 await 之前模块体只有 builtin 导入。Node < 22.8 无此 API:跳过,行为不变。
// 尊重用户显式配置:已设 NODE_COMPILE_CACHE 时不覆盖。缓存目录在 .ming-cache(gitignored)。
try {
  if (typeof nodeModule.enableCompileCache === 'function' && !process.env.NODE_COMPILE_CACHE) {
    nodeModule.enableCompileCache(path.join(__dirname, '..', '.ming-cache', 'compile'));
  }
} catch { /* 编译缓存启用失败不影响任何功能(纯性能优化) */ }

// 核心模块图(checker/interp/vm/parser/diag/compiler/artifact/wasm)按命令加载:
// run/check/test/tools/build/cc 共用;doc/fmt 只需其中子集,但编译缓存命中后全图
// 加载仅数 ms,不再细拆。绑定全部走这些 let,调用面在 main() 之后必然已加载完成。
let Checker, Interp, Panic, VMInterp, parse, attachDocsImpl;
let Diagnostic, MingError, formatDiag, cacheSourceLines, SEVERITY;
let compile, CompileError, serializeArtifact, deserializeArtifact, makeCheckLike;
let Unsupported, wasmLayerStatus;
let _core = null;
async function loadCore() {
  if (_core) return _core;
  const [mChecker, mInterp, mVm, mParser, mDiag, mCompiler, mArtifact, mWasm] = await Promise.all([
    import('../src/checker.js'),
    import('../src/interp.js'),
    import('../src/vm.js'),
    import('../src/parser.js'),
    import('../src/diag.js'),
    import('../src/compiler.js'),
    import('../src/artifact.js'),
    import('../src/wasm.js'),
  ]);
  Checker = mChecker.Checker;
  ({ Interp, Panic } = mInterp);
  VMInterp = mVm.VMInterp;
  parse = mParser.parse;
  attachDocsImpl = mParser.attachDocs;
  ({ Diagnostic, MingError, formatDiag, cacheSourceLines, SEVERITY } = mDiag);
  ({ compile, CompileError } = mCompiler);
  ({ serializeArtifact, deserializeArtifact, makeCheckLike } = mArtifact);
  ({ Unsupported, wasmLayerStatus } = mWasm);
  _core = true;
  return _core;
}

// 命令特有模块按命令加载(fmt/cbackend/lsp/repl/manifest 对 tools/version/run/check/test
// 是纯开销;emitC/lsp/repl 另需自身模块)。
let _fmtMod = null, _manifestMod = null, _lspMod = null, _replMod = null, _cbackendMod = null;
async function lazyFmt() { if (!_fmtMod) _fmtMod = await import('../src/fmt.js'); return _fmtMod; }
async function lazyManifest() { if (!_manifestMod) _manifestMod = await import('../src/manifest.js'); return _manifestMod; }
async function lazyLsp() { if (!_lspMod) _lspMod = await import('../src/lsp.js'); return _lspMod; }
async function lazyRepl() { if (!_replMod) _replMod = await import('../src/repl.js'); return _replMod; }
async function lazyCbackend() { if (!_cbackendMod) _cbackendMod = await import('../src/cbackend.js'); return _cbackendMod; }

const usage = `
Ming(明)v${VERSION} — 为 AI 与人类协作设计的编程语言

用法:
  ming run   [file.ming] [--json] [--tree] [--no-wasm] [--strict-wasm] [--max-steps N] [--max-alloc N] [--max-ms N] [-- args...]
  ming check [file.ming...] [--json] [--proof-report] [--warn-unproven-index] [--strict-wasm]
  ming test  [file.ming...] [--json] [--filter 名称] [--tree] [--no-wasm] [--max-steps N] [--max-alloc N] [--max-ms N]  (--strict-wasm 仅做互斥仲裁)
  ming build [--json] [--clean-cache] [--with-source] [--no-dist]
  ming cc    <file.ming> [--emit-c] [--out 目录|-o 目录] [--json] [-- args...]
  ming tools [--list] <命令> [参数...]   (自举工具统一入口:patch/edit/diff/diag/wc/...)
  ming init  [项目名]
  ming fmt   <file.ming...> [--write | --check]
  ming doc   <file.ming...> [--json] [--index]
  ming lsp   (stdio JSON-RPC 语言服务:诊断推送/hover)
  ming repl  (交互式会话:表达式回显、声明持久化)
  ming version

说明:
  * 诊断同时输出人类可读格式与 --json 结构化格式,错误码稳定(见 docs/diagnostics.md)
  * doc --json schema:{ok,file,items:[{kind:fn|struct|enum|trait|const|impl,name,line,doc,signature}]};doc 为 /// 行去前缀原文(无文档为 []),signature 为 AST 重建(impl 方法含 with 效果与 requires/ensures);impl 的 name 为 "impl <trait> for <类型>"(v0.58)
  * doc --index:多文件聚合 {ok,files:N,items:[{file,...同上}]};单文件也可用;错误路径与 --json 协议一致(v0.58)
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

async function loadAndCheck(file, { json, silent = false } = {}) {
  await loadCore();
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
// v0.57 tools AOT:prebuilt 非空(缓存命中)时跳过 loadAndCheck 与 interp 构造,
// 直接用调用方装配好的 VMInterp 运行;其余 runMain/panic/RangeError/内部错误路径
// 与原逻辑完全共用 —— 输出与退出码逐字一致。
async function cmdRun(file, flags, opts, programArgs, prebuilt = null) {
  const json = flags.has('json');
  if (!file) return fail('run 需要一个 .ming 文件', json);
  if (strictWasmConflict(flags)) return fail(STRICT_WASM_CONFLICT_MSG, json);
  const c = prebuilt ? { ok: true, result: prebuilt.result, diags: [] } : await loadAndCheck(file, { json, silent: true });
  if (!c.ok) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, exit_code: 1, diagnostics: diagJson(c.diags) }, null, 2) + '\n');
    }
    return 1;
  }
  const result = c.result;

  // v0.53 strict:先判定 wasm 分层,回落 → 退出码 2(不运行);预编译产物传给 VM 避免双份 compile。
  // 非 strict 不进入此分支 —— 现状静默回落行为逐字不变。
  // (prebuilt 仅来自 tools 缓存路径,strict 旗标下缓存路径整体回退,此分支不会进入。)
  let strictStatus = null;
  let strictCompiled = null;
  if (strictWasmOn(flags) && !flags.has('tree') && !prebuilt) {
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

  let interp;
  if (prebuilt) {
    interp = prebuilt.interp;
  } else {
    const interpOpts = {
      capture: json,
      noWasm: flags.has('no-wasm'),
      maxSteps: opts['max-steps'] ? Number(opts['max-steps']) : Infinity,
      maxAlloc: opts['max-alloc'] ? Number(opts['max-alloc']) : 268_435_456,
      maxMs: opts['max-ms'] ? Number(opts['max-ms']) : 600_000,
    };
    if (strictStatus) interpOpts.precompiled = strictCompiled;
    interp = flags.has('tree') ? new Interp(result, interpOpts) : new VMInterp(result, interpOpts);
  }
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
async function cmdCheck(files, flags) {
  await loadCore();
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
  // v0.55 阶段 3:契约摘要行(additive;仅 --proof-report)。requires=无 只在没有
  // requires 子句时出现;有子句但含不可线性编码叶子 → 不完整;ensures 同理。
  // v0.56(#31):输出已去重的 proofs.summaries,多入口共享模块不再重复成行。
  for (const s of proofs.summaries) {
    const req = !s.requires_present ? '无' : s.requires_complete ? '完整' : '不完整';
    const ens = !s.ensures_present ? '无' : s.ensures_proven ? '已证' : '未证';
    process.stdout.write(`${s.file}:${s.fn}: 契约摘要 requires=${req} ensures=${ens} 调用点=${s.calls_proven} 可证, ${s.calls_violated} 违反\n`);
  }
}

// v0.52 --proof-report:聚合 checker 的逐义务证明记录(有 Vec 索引义务的函数;零义务语料为空)。
// v0.55:同份报告 additive 增加契约摘要(summaries)——数据来自 checker 阶段 1/2 已建立的摘要表
// 与调用点统计,不重复计算;无旗标时不构造、不输出。
// v0.56(#31):多入口共享模块按"解析后绝对路径 + 函数名"去重——同一模块被 N 个入口加载时
// 证明记录与摘要只报首次出现的一份(per-entry 调用点计数不再保留;可读性优先)。
// v0.56(B1):去重键直接取记录自带的 abs(checker 的 Module.absPath),不再用展示路径反查:
// 不同目录的 util.ming 在各自入口下展示路径同为 "util.ming",反查会跨目录误合并。
function collectProofs(checked) {
  const functions = [];
  const summaries = [];
  const seenProof = new Set();
  const seenSummary = new Set();
  const summary = { functions: 0, obligations: 0, proven: 0, violated: 0, unproven: 0 };
  const keyOf = (rec) => (rec.abs ?? path.resolve(rec.file)) + '\u0000' + rec.fn;
  for (const r of checked) {
    for (const rec of r.proofs ?? []) {
      const key = keyOf(rec);
      if (seenProof.has(key)) continue;
      seenProof.add(key);
      functions.push(rec);
      summary.functions += 1;
      summary.obligations += rec.total;
      summary.proven += rec.proven;
      summary.violated += rec.violated;
      summary.unproven += rec.unproven;
    }
    for (const s of r.summaries ?? []) {
      const key = keyOf(s);
      if (seenSummary.has(key)) continue;
      seenSummary.add(key);
      summaries.push({
        file: s.file, abs: s.abs, fn: s.fn,
        requires_present: s.requires_present,
        requires_complete: s.requires_complete,
        ensures_present: s.ensures_present,
        ensures_proven: s.ensures_proven,
        calls_proven: s.calls_proven,
        calls_violated: s.calls_violated,
      });
    }
  }
  return { summary, functions, summaries };
}

// ---------- test ----------
async function cmdTest(files, flags, opts) {
  await loadCore();
  const json = flags.has('json');
  const filter = opts.filter ?? null;
  if (!files.length) return fail('test 需要至少一个 .ming 文件', json);
  // v0.60(#54):strict-wasm 冲突仲裁与 run 同口径 —— strict 观测的正是 wasm 分层本身,
  // 与 --tree/--no-wasm 同时出现是命令行矛盾,exit 1(复用 run 的消息与 fail 协议)。
  if (strictWasmConflict(flags)) return fail(STRICT_WASM_CONFLICT_MSG, json);
  // v0.60 审查修复:strict 单独出现在 test 时无分层验证语义 —— 显式提示后忽略(退出码不变),
  // 不静默吞旗标(Ming 显式立场:旗标要么生效,要么说明为何不生效)。
  if (strictWasmOn(flags)) {
    process.stderr.write('ming test: --strict-wasm 无分层验证语义,已忽略(仅保留与 --tree/--no-wasm 的互斥仲裁)\n');
  }
  let totalPassed = 0, totalFailed = 0;
  const allResults = [];
  for (const f of files) {
    const c = await loadAndCheck(f, { json: false });
    if (!c.ok) { totalFailed++; continue; }
    // v0.60(#54):资源门禁旗标透传到 test 子实例(默认与 run 相同:Infinity / 268_435_456 / 600_000);
    // 子实例消费由 interp/vm 的 runTests 承接(同批 §64-A/B),此前 --max-alloc/--max-ms 对 test 不生效。
    const testOpts = {
      capture: true,
      noWasm: flags.has('no-wasm'),
      maxSteps: opts['max-steps'] ? Number(opts['max-steps']) : Infinity,
      maxAlloc: opts['max-alloc'] ? Number(opts['max-alloc']) : 268_435_456,
      maxMs: opts['max-ms'] ? Number(opts['max-ms']) : 600_000,
    };
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
async function cmdFmt(files, flags) {
  await loadCore();
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
    // v0.56(A3):格式化失败必须显式报错并跳过落盘——先完整产出字符串,成功后才写文件
    // (绝不输出占位符丢代码,也不会 --write 半写)。
    const { formatProgram, FmtError } = await lazyFmt();
    let formatted;
    try {
      formatted = formatProgram(program.items, comments);
    } catch (e) {
      if (e instanceof FmtError) {
        const sp = e.span;
        const loc = sp ? `${sp.file ?? f}:${sp.line}:${sp.col}: ` : `${f}: `;
        process.stderr.write(`${loc}error: fmt 失败: ${e.message}\n`);
        failed++;
        continue;
      }
      throw e;
    }
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
async function cmdDoc(files, flags) {
  await loadCore();
  const json = flags.has('json');
  const index = flags.has('index');
  if (!files.length || !files[0]) return fail('doc 需要一个 .ming 文件', json || index);
  // v0.58(C 审查 MINOR / plan §4.3.5 任务 3 另一半):--index 多文件聚合;
  // 无 --index 保持既有行为(单文件命令,只处理第一个文件)。
  if (index) return docIndex(files);
  const file = files[0];
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) {
    // v0.58:--json 错误路径走既有 fail 协议(stdout {ok:false,error});文本模式 stderr 逐字不变
    if (json) return fail(`无法读取 ${file}: ${e.message}`, json);
    process.stderr.write(`无法读取 ${file}: ${e.message}\n`);
    return 1;
  }
  const { program, comments, diags } = parse(file, src);
  if (diags.length) {
    // v0.58:--json 下解析诊断结构化输出(与 reportCompileError 的 {ok:false,diagnostics} 同形)
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, exit_code: 1, diagnostics: diags.map(d => d.toJson()) }, null, 2) + '\n');
      return 1;
    }
    for (const d of diags) process.stderr.write(formatDiag(d, process.stderr.isTTY) + '\n');
    return 1;
  }
  attachDocsImpl(program.items, comments);

  // v0.58(任务 3):--json 稳定 schema(additive;默认文本输出逐字不变):
  //   { "ok": true, "file": "<路径>", "items": [ { "kind": "fn|struct|enum|trait|const|impl",
  //     "name": "...", "line": N, "doc": ["/// 行原文(去前缀)"], "signature": "..." } ] }
  // 口径:
  //   - kind/name/line 以 AST 为准;默认单文件命令(多文件无 --index 只处理第一个);
  //   - doc:每个 /// 行去掉 `///` 前缀后的原文(保留其余字符;无 /// 文档时为 []);test/use/extern fn 不列入 items;
  //   - signature:AST 重建(规范化空白),非源码逐字摘录;trait/impl 方法只重建签名(不列方法体);
  //   - impl 方法签名补 effects 与 requires/ensures(C 审查 MINOR,与顶层 fn/fmt 口径一致:
  //     `fn n(...) -> ret with eff requires ... ensures ...`);trait 方法语法无 effects/契约,渲染不变;
  //   - impl 的 name 为 `impl <trait> for <类型>`(与 LSP 文档符号口径一致);kind trait/impl 仅 --json 新增,
  //     文本输出仍只含 fn/struct/enum/const(逐字不变)。
  const { expr: exprSrc } = await lazyFmt(); // 契约表达式规范化重建(fmt expr 与 contractSuffix 同口径)
  const items = collectDocItems(program.items, exprSrc);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, file, items }, null, 2) + '\n');
  } else {
    const textItems = items.filter(i => i.kind === 'fn' || i.kind === 'struct' || i.kind === 'enum' || i.kind === 'const');
    for (const it of textItems) {
      process.stdout.write(`## ${it.signature}\n`);
      if (it.doc.length) process.stdout.write(it.doc.map(d => d.replace(/^\/?\//, '').trim()).join('\n') + '\n');
      process.stdout.write(`    (${path.basename(file)}:${it.line})\n\n`);
    }
    if (!textItems.length) process.stdout.write('(没有可文档化的项;给声明加 /// 文档注释)\n');
  }
  return 0;
}

// v0.58(C 审查 MINOR / plan §4.3.5 任务 3):ming doc --index 多文件聚合。
//   { "ok": true, "files": N, "items": [ { "file": "<路径>", ...单文件 item 同形 } ] }
// 每项前置 file 字段(additive);单文件加 --index 输出同 schema(天然兼容);
// 文件顺序 = 命令行顺序,先到先停;错误路径与 --json 协议一致:
// 读失败 → fail 的 {ok:false,error}(exit 1);解析诊断 → {ok:false,exit_code,diagnostics}(exit 1)。
async function docIndex(files) {
  const { expr: exprSrc } = await lazyFmt();
  const items = [];
  for (const file of files) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (e) {
      return fail(`无法读取 ${file}: ${e.message}`, true);
    }
    const { program, comments, diags } = parse(file, src);
    if (diags.length) {
      process.stdout.write(JSON.stringify({ ok: false, exit_code: 1, diagnostics: diags.map(d => d.toJson()) }, null, 2) + '\n');
      return 1;
    }
    attachDocsImpl(program.items, comments);
    for (const it of collectDocItems(program.items, exprSrc)) items.push({ file, ...it });
  }
  process.stdout.write(JSON.stringify({ ok: true, files: files.length, items }, null, 2) + '\n');
  return 0;
}

// doc items 构建(单文件与 --index 共用;exprSrc 来自 fmt.js,契约表达式规范化重建)。
function collectDocItems(programItems, exprSrc) {
  // impl 方法签名的契约后缀(与 fmt.js contractSuffix 同序:requires 前、ensures 后;
  // else 消息优先 msgRaw 原样(v0.56 #39 口径),字面量退化 JSON 引号;trait 方法无此类,
  // 语法上无 effects/契约,渲染不变)。
  const contractSuffixDoc = (m) => {
    const parts = [];
    const add = (kw, cl) => {
      if (!cl) return;
      const msg = cl.msgRaw != null ? ' else ' + cl.msgRaw : (cl.msg == null ? '' : ' else ' + JSON.stringify(cl.msg));
      parts.push(`${kw} ${exprSrc(cl.expr)}${msg}`);
    };
    add('requires', m.requires);
    add('ensures', m.ensures);
    return parts.length ? ' ' + parts.join(' ') : '';
  };
  const methodSig = (m) => {
    const ps = m.params.map(p => p.self ? (p.mut ? 'mut self' : 'self') : `${p.name}: ${sigType(p.type)}`).join(', ');
    // v0.58(C 审查 MINOR):impl 方法补 effects 与 requires/ensures(顶层 fn 已有口径,对齐之)
    const eff = m.effects?.length ? ` with ${m.effects.map(e => e.name).join(', ')}` : '';
    return `fn ${m.name}(${ps})${m.ret ? ' -> ' + sigType(m.ret) : ''}${eff}${contractSuffixDoc(m)}`;
  };
  const items = [];
  for (const it of programItems) {
    if (it.nt === 'FnDecl') {
      const tps = it.tparams.length ? `[${it.tparams.join(', ')}]` : '';
      // v0.58:参数渲染逐字保留 v0.57 口径(顶层 fn 不含 self;self 只在 methodSig 处理)
      const params = it.params.map(p => `${p.name}: ${sigType(p.type)}`).join(', ');
      const eff = it.effects?.length ? ` with ${it.effects.map(e => e.name).join(', ')}` : '';
      items.push({ kind: 'fn', name: it.name, line: it.span.line, doc: it.docs ?? [], signature: `fn ${it.name}${tps}(${params})${it.ret ? ' -> ' + sigType(it.ret) : ''}${eff}` });
    } else if (it.nt === 'StructDecl') {
      items.push({ kind: 'struct', name: it.name, line: it.span.line, doc: it.docs ?? [], signature: `struct ${it.name}{ ${it.fields.map(f => `${f.name}: ${sigType(f.type)}`).join(', ')} }` });
    } else if (it.nt === 'EnumDecl') {
      items.push({ kind: 'enum', name: it.name, line: it.span.line, doc: it.docs ?? [], signature: `enum ${it.name} { ${it.variants.map(v => v.name + (v.types.length ? `(${v.types.map(sigType).join(', ')})` : '')).join(', ')} }` });
    } else if (it.nt === 'ConstDecl') {
      items.push({ kind: 'const', name: it.name, line: it.span.line, doc: it.docs ?? [], signature: `const ${it.name}${it.type ? ': ' + sigType(it.type) : ''} = ...` });
    } else if (it.nt === 'TraitDecl') {
      items.push({ kind: 'trait', name: it.name, line: it.span.line, doc: it.docs ?? [], signature: `trait ${it.name} { ${it.methods.map(methodSig).join('; ')} }` });
    } else if (it.nt === 'ImplDecl') {
      const tps = it.tparams.length ? `[${it.tparams.join(', ')}]` : '';
      const args = it.typeArgs.length ? `[${it.typeArgs.map(sigType).join(', ')}]` : '';
      items.push({ kind: 'impl', name: `impl ${it.trait} for ${it.typeName}`, line: it.span.line, doc: it.docs ?? [], signature: `impl${tps} ${it.trait} for ${it.typeName}${args} { ${it.methods.map(methodSig).join('; ')} }` });
    }
  }
  return items;
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

// v0.54 审查 B5:字节码编译器内部可预期错误(名字/结构体未解析)渲染为带位置的诊断,
// 而不是 Node 裸栈。M4001 是既有 panic 码(内部错误),这里只补位置与处理建议。
function compileErrorDiag(e) {
  return new Diagnostic('M4001', SEVERITY.ERROR,
    '内部错误(字节码编译器):' + e.message,
    e.span, '这是编译器缺陷(检查器已通过但字节码编译器无法降级);请附最小复现报告。');
}

// 输出编译错误诊断;返回 1(供 cc/build/run 的 catch 分支直接 return)。
function reportCompileError(e, json) {
  const d = compileErrorDiag(e);
  if (json) process.stdout.write(JSON.stringify({ ok: false, exit_code: 1, diagnostics: [d.toJson()] }, null, 2) + '\n');
  else process.stderr.write(formatDiag(d, process.stderr.isTTY) + '\n');
  return 1;
}

// ---------- 项目模式:无文件参数时,从 cwd 向上找 ming.toml ----------
async function projectEntry(cmd, rest, json) {
  if (rest.length > 0) return { files: rest, proj: null };
  const { findManifest } = await lazyManifest();
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
async function cmdInit(name, flags) {
  const json = flags.has('json');
  const { initProject } = await lazyManifest();
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
      // v0.56(A3):msgRaw 只是 fmt 用的原始文本(语义等价于 msg),不属于 ABI
      if (k === 'msgRaw') continue;
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

// v0.56(#26):编译器源码指纹 = 构建缓存键的组成部分。
// 版本号未变但编译器源码改动时,旧键必须失效(否则脏命中缓存继续用旧编译器产物)。
// v0.56(B2):范围含 src/*.js 与 bin/*.js——bin/ming.js 的 launcher/build 逻辑同样影响产物
// (本版 #29 正是它);只含 src 时改 bin 仍会脏命中。
// 实现:相对路径排序后拼 "name\0content\0" 流式喂给 sha256(不逐文件进 JSON 对象,避免键序问题),
// 取前 32 hex 与 build_key 风格一致。
function compilerSourceHash() {
  const root = path.join(__dirname, '..');
  const files = [];
  for (const dirName of ['bin', 'src']) {
    const dir = path.join(root, dirName);
    for (const n of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
      files.push(dirName + '/' + n);
    }
  }
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel + '\u0000');
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 32);
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

// ---------- v0.57 tools AOT 缓存(docs/usage-audit.md §4 行动1;plan §4.3.8)----------
// 动机:每次 ming tools 调用都重新 check+编译工具本体,超出 Node 启动基线约 57ms
// (audit 快照:107ms vs 基线 49.8ms)。把"版本 + Node 主版本 + 编译器源码指纹 +
// 工具文件名 + 工具源文本"寻址的字节码产物落盘到 .ming-cache/tools/<sha256>.json,
// 命中直接 VMInterp.fromArtifact 执行,跳过 Checker/字节码编译/wasm 编译。
// 行为合同(与未缓存路径逐字一致):
//   * stdout/stderr/退出码完全一致 —— panic 对齐靠 span 文件重写 + 预填源码行缓存;
//   * 任何不确定形态(受限旗标 / 读源失败 / check 失败或有诊断 / 多模块 / sync/unsafe /
//     缓存缺失或损坏 / AOT 序列化失败)一律回退原路径且不写缓存,绝不吞错误;
//   * 缓存键含 compilerSourceHash(编译器源码指纹)与 Node 主版本:工具链或运行时升级
//     → 键变化 → 旧缓存自然失效,不会脏命中。
// 并发说明:写缓存用临时文件 + rename 原子落盘,读端只会看到完整旧文件或完整新文件;
// 同键并发写竞态下双方产物内容一致(同键同源),最后 rename 者胜出,均可完整读取
// (单代理场景可接受)。缓存目录无淘汰:工具链升级产生新键,旧条目留待手工清理
// (.ming-cache/ 已 gitignore,体积为每工具数百 KB 量级)。
const TOOLS_CACHE_DIR = path.join(__dirname, '..', '.ming-cache', 'tools');
// 观测旗标:MING_TOOLS_DEBUG=1 时把每次缓存决策(命中/未命中/回退原因)打到 stderr。
// 默认关闭 —— 不影响任何命令的 stdout/stderr/退出码。
const TOOLS_DEBUG = process.env.MING_TOOLS_DEBUG === '1';
const toolsDbg = (msg) => { if (TOOLS_DEBUG) process.stderr.write(`[tools-cache] ${msg}\n`); };

// 缓存键 = sha256(JSON.stringify({v, node, compiler, tool, src}))。
// tool 取工具文件名(basename)而非命令别名:patch/patch-all/read/... 同源于 mingkit.ming,
// 别名间共享同一产物条目,键义更稳定(命令别名表可增删而不影响键)。
function toolCacheKey(toolFile, src) {
  return createHash('sha256').update(JSON.stringify({
    v: VERSION,
    node: process.versions.node.split('.')[0],
    compiler: compilerSourceHash(),
    tool: path.basename(toolFile),
    src,
  })).digest('hex');
}

function writeToolCache(cacheFile, artifact) {
  try {
    fs.mkdirSync(TOOLS_CACHE_DIR, { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(artifact));
    fs.renameSync(tmp, cacheFile);
  } catch { /* 缓存写失败不影响本次运行(下次未命中重试) */ }
}

// 产物 → { interp, result }:反序列化后做三件事 ——
//   1) 把 span 文件名(basename,序列化时剥离绝对路径)重写回工具绝对路径;
//   2) 回填 decl.span(serializeArtifact 只存 {nt,name},vm runMain 初始帧取
//      entry.decl.span 作 panic 调用栈首帧;declSpans 由探测期 checker 结果免费提取,
//      additive 存入缓存 JSON,键含 src+编译器指纹 → 命中必同源,不会有陈旧 span);
//   3) 预填源码行缓存 —— panic 诊断(文件:行:列 + 源码摘录 + 调用栈)与原路径逐字一致
//      (spanOf 返回 compiled.spans 元素引用,就地重写即覆盖全部出口)。
// result 是与 checker 结果同构的最小 panicDiag 依赖面(modules[{file,src}])。
function toolArtifactToPrebuilt(artifact, toolFile, src, flags, opts) {
  const compiled = deserializeArtifact(artifact);
  const relName = path.basename(toolFile);
  for (const sp of compiled.spans) {
    if (sp && sp.file === relName) sp.file = toolFile;
  }
  if (Array.isArray(artifact.declSpans)) {
    const byName = new Map(artifact.declSpans.map(d => [d.name, d.span]));
    for (const fn of compiled.functions) {
      const sp = byName.get(fn.name);
      if (sp) fn.entry.decl.span = { ...sp };
    }
  }
  cacheSourceLines(toolFile, src);
  const interp = new VMInterp(makeCheckLike(compiled), {
    capture: false, // json 旗标下缓存路径整体回退,此处恒非捕获
    noWasm: flags.has('no-wasm'),
    maxSteps: opts['max-steps'] ? Number(opts['max-steps']) : Infinity,
    maxAlloc: opts['max-alloc'] ? Number(opts['max-alloc']) : 268_435_456,
    maxMs: opts['max-ms'] ? Number(opts['max-ms']) : 600_000,
    precompiled: compiled,
  });
  const result = {
    entry: { file: toolFile, absPath: null, items: new Map() },
    modules: [{ file: toolFile, src }],
    diags: [],
    methodImpls: null,
  };
  return { interp, result };
}

// 探测期从 checker 结果提取全部声明的 span(vm 初始帧的 panic 调用栈首帧用它;
// serializeArtifact 不携带 decl,故 additive 存入缓存 JSON 由加载端回填)。
function toolDeclSpans(checkResult) {
  const out = [];
  for (const m of checkResult.modules) {
    for (const [name, e] of m.items) {
      const sp = e?.decl?.span;
      if (sp) out.push({ name, span: { file: sp.file, line: sp.line, col: sp.col, endLine: sp.endLine, endCol: sp.endCol } });
    }
  }
  return out;
}

// 未命中探测:check + 资格判定 + 编译。返回 null = 不可缓存(交回原路径,输出由
// 原路径逐字产生且不写缓存);返回 { compiled, checkResult } = 可缓存。
function toolCacheProbe(file, flags) {
  const checker = new Checker(file);
  let checkResult;
  try {
    checkResult = checker.run();
  } catch (e) {
    if (e instanceof MingError) return null; // check 失败:原路径输出诊断(逐字)
    throw e;
  }
  const diags = sortDiags(checkResult.diags);
  // 有任何诊断(含警告)即不缓存:原路径每次调用都会经 loadAndCheck 打印诊断,
  // 缓存路径无诊断可印 —— 为保逐字一致,只缓存零诊断工具。
  if (diags.length) return null;
  // 与 cmdBuild 相同的 AOT 资格判定:sync 子任务 worker 需源码编译;unsafe 仅 C 原生。
  const hasEff = (eff) => checkResult.modules.some(m => [...m.items.values()].some(e => {
    const s = e.sig?.effects ?? e.effects;
    return s instanceof Set && s.has(eff);
  }));
  if (hasEff('sync') || hasEff('unsafe')) return null;
  // 单模块假设:工具均为单文件(无本地 use)。产物 span 只保留 basename,
  // 多模块会有同名歧义 → 多模块工具一律回退原路径。
  if (checkResult.modules.length !== 1) return null;
  try {
    return { compiled: compile(checkResult), checkResult };
  } catch {
    return null; // 编译器拒绝:原路径按既有语义处理(含顶层 CompileError 报告)
  }
}

// ming tools 实际运行分支的缓存入口。返回 null = 回退原路径(cmdRun 全量逻辑)。
// 调用方(cmdTools)已 await loadCore():本函数与其下游同步函数可直接使用核心绑定。
async function tryToolRun(file, flags, opts, programArgs) {
  // 受限旗标回退原路径:--json(输出协议与计时在 cmdRun)、--tree(树引擎无产物形态)、
  // strict-wasm(strict 观测的正是源码编译的 wasm 分层本身)。
  if (flags.has('json') || flags.has('tree') || strictWasmOn(flags)) return null;
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return null; } // 读不到:原路径报诊断
  const cacheFile = path.join(TOOLS_CACHE_DIR, toolCacheKey(file, src) + '.json');
  // 命中:产物加载 + 直接运行。任何加载失败(损坏 JSON / 版本不符 / 反序列化拒绝)
  // 落入未命中自愈:重新 check+compile 并重写缓存。
  try {
    const artifact = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    toolsDbg(`hit ${path.basename(file)}`);
    return await cmdRun(file, flags, opts, programArgs, toolArtifactToPrebuilt(artifact, file, src, flags, opts));
  } catch (e) { toolsDbg(`miss ${path.basename(file)}: ${e?.message ?? e}`); }
  const probe = toolCacheProbe(file, flags);
  if (!probe) { toolsDbg(`fallback ${path.basename(file)}: probe 不可缓存(check 诊断/多模块/sync/unsafe)`); return null; }
  try {
    const artifact = serializeArtifact(probe.compiled, {}); // 无 baseDir:span 文件取 basename
    artifact.builtBy = VERSION;
    artifact.declSpans = toolDeclSpans(probe.checkResult); // panic 调用栈首帧对齐(见 toolArtifactToPrebuilt)
    writeToolCache(cacheFile, artifact);
    toolsDbg(`stored ${path.basename(file)} → ${path.basename(cacheFile)}`);
    return await cmdRun(file, flags, opts, programArgs, toolArtifactToPrebuilt(artifact, file, src, flags, opts));
  } catch (e) {
    toolsDbg(`fallback ${path.basename(file)}: AOT 序列化失败 ${e?.message ?? e}`);
    return null; // AOT 序列化失败:原路径运行,不缓存(与 build 的受限形态回退语义一致)
  }
}

async function cmdTools(rest, flags, opts, dashRest) {
  await loadCore();
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
  const programArgs = [...hit.prefix, ...rest.slice(1), ...(dashRest ?? [])];
  // v0.57 tools AOT:命中走产物加载(目标:超出 Node 基线额外开销 <20ms);
  // 未命中/不可缓存回退原路径,行为逐字一致(见 tryToolRun 注释)。
  const cached = await tryToolRun(file, flags, opts, programArgs);
  if (cached !== null) return cached;
  return cmdRun(file, flags, opts, programArgs);
}

async function cmdBuild(flags) {
  await loadCore();
  const json = flags.has('json');
  const { files, proj, error } = await projectEntry('build', [], json);
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
  // v0.56(#26/B2):加入编译器源码指纹 src/*.js + bin/*.js——版本号未变而编译器/launcher 改动时键必须变化。
  // 旧缓存键不含该字段 → 自然不命中并重建(不迁移旧缓存)。
  const sources = collectProjectSources(projectRoot);
  const compilerHash = compilerSourceHash();
  const buildKey = createHash('sha256').update(JSON.stringify({
    v: VERSION, node: process.versions.node.split('.')[0], compiler: compilerHash, manifest: proj.project ?? null, withSource: !!flags.has('with-source'), sources,
  })).digest('hex').slice(0, 32);
  let prevCache = null;
  try { prevCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { prevCache = null; }
  const distIntact = !!prevCache?.distHash && hashTree(distDir) === prevCache.distHash;
  if (!flags.has('no-dist') && !flags.has('clean-cache') && prevCache && prevCache.key === buildKey && distIntact) {
    // v0.53 --json additive:build_key/dist_hash/cache_hit/source_count/interface_hashes
    if (json) process.stdout.write(JSON.stringify({
      ok: true, project: proj.project.name, cache: 'hit', ms: Date.now() - t0,
      build_key: buildKey, compiler_hash: compilerHash, dist_hash: prevCache.distHash, cache_hit: true,
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
    let aotCompileErr = null; // v0.54 审查 B5:字节码编译器的内部错误不再静默回退
    try {
      // v0.43 修复:效果在 entry.sig.effects(entry 本身无 effects 字段)——此前恒 false,
      // spawn 程序误进 AOT,运行期 worker 读 '<artifact>' 源路径 → ENOENT
      const usesSync = checkResult.modules.some(m => [...m.items.values()].some(e => {
        const eff = e.sig?.effects ?? e.effects;
        return eff instanceof Set && eff.has('sync');
      }));
      if (usesSync) throw new Error('程序使用 sync 并发(spawn 子任务由源码编译)');
      // v0.54/C5:with unsafe 是 C 原生限定(tree/VM 以 M4016 拒绝)——AOT 字节码产物
      // 基于 VM,不能兑现指针语义,故显式回退源码模式并说明原因
      const usesUnsafe = checkResult.modules.some(m => [...m.items.values()].some(e => {
        const eff = e.sig?.effects ?? e.effects;
        return eff instanceof Set && eff.has('unsafe');
      }));
      if (usesUnsafe) throw new Error('程序使用 with unsafe 指针操作(C 原生限定,tree/VM 以 M4016 拒绝)');
      // v0.62(ADR-001 §5.2 任务 6):net 并入同一条效果回退检测——serve 的 accept 线程/
      // 请求 worker 需要源码编译,与 v0.43 修 spawn"worker 读 '<artifact>' 源路径 →
      // ENOENT"同款机制;运行时行为不变,net 程序 dist 一律源码模式(http_get 纯客户端
      // 程序也回退,conservative——失去无明文源 AOT)
      const usesNet = checkResult.modules.some(m => [...m.items.values()].some(e => {
        const eff = e.sig?.effects ?? e.effects;
        return eff instanceof Set && eff.has('net');
      }));
      if (usesNet) throw new Error('程序使用 net(serve 的 accept/worker 运行面由源码编译)');
      const compiled = compile(checkResult);
      const artifact = serializeArtifact(compiled, { baseDir: projectRoot });
      artifact.builtBy = VERSION;
      fs.writeFileSync(path.join(distDir, 'app.bytecode.json'), JSON.stringify(artifact));
    } catch (e) {
      // v0.54 审查 B5:Unsupported/已知形态 → 回退源码模式;CompileError 是编译器缺陷,
      // 用带文件/行的诊断显式失败,避免产出"看起来成功"的坏 dist。
      if (e instanceof CompileError) aotCompileErr = e;
      else aotErr = e.message;
    }
    if (aotCompileErr) return reportCompileError(aotCompileErr, json);
    const launcher = [
      '#!/usr/bin/env node',
      '// Ming 可移植产物(v0.39):Node >= 18,零依赖;用法:node ming-app.mjs [-- args]',
      "import { VMInterp } from './runtime/vm.js';",
      "import { Diagnostic, formatDiag, cacheSourceLines } from './runtime/diag.js';",
      "import * as fs from 'node:fs';",
      "import * as path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      '',
      'const here = path.dirname(fileURLToPath(import.meta.url));',
      "const bjson = path.join(here, 'app.bytecode.json');",
      "const mingFile = path.join(here, 'app.ming');",
      'let vm;',
      'let srcResult = null;',
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
      '  srcResult = result;',
      '  vm = new VMInterp(result, {});',
      '}',
      'try {',
      "  const pargs = process.argv.slice(2);",
      "  if (pargs[0] === '--') pargs.shift();",
      '  const { exitCode } = vm.runMain(pargs);',
      '  process.exit(exitCode);',
      '} catch (e) {',
      "  if (e && typeof e.code === 'string') {",
      '    // v0.56(#29):源码回退模式的 panic 与 ming run 同款诊断(file:line:col + 码 +',
      '    // 源码摘录);AOT 字节码模式的输出保持既有 `CODE: 消息` 逐字不变。',
      '    if (srcResult && e.span) {',
      '      const m = srcResult.modules.find(m => m.file === e.span.file) ?? srcResult.entry;',
      '      if (m) cacheSourceLines(m.file, m.src);',
      "      process.stderr.write(formatDiag(new Diagnostic(e.code, 'error', e.message, e.span), false) + '\\n');",
      '    } else {',
      "      process.stderr.write(e.code + ': ' + e.message + '\\n');",
      '    }',
      '    process.exit(101);',
      '  }',
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
      build_key: buildKey, compiler_hash: compilerHash, cache_hit: false, source_count: sources.length,
      dist_hash: distHashOut, interface_hashes: moduleHashes,
    }, null, 2) + '\n');
  }
  return ok ? 0 : 1;
}

// ---------- cc:C 后端 C1(eligible 数值函数 → C + GCC/Clang -O2)----------
// 探测顺序:MING_CC 环境变量 → PATH(gcc/clang/cc)→ 已知便携位置(w64devkit 等)
function detectCCompiler(json, spawnSync) {
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

async function cmdCC(file, flags, opts, programArgs) {
  await loadCore();
  const spawnSync = await lazySpawnSync();
  const json = flags.has('json');
  if (!file) return fail('cc 需要一个 .ming 文件', json);
  const c = await loadAndCheck(file, { json, silent: true });
  if (!c.ok) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, exit_code: 1, diagnostics: diagJson(c.diags) }, null, 2) + '\n');
    return 1;
  }
  const result = c.result;
  let emitted;
  try {
    const compiled = compile(result);
    // v0.54/C5:cc 路径显式开启 C 专用 unsafe 资格扩展(效果 ⊆ {ffi, unsafe};wasm 不传)
    const { emitC } = await lazyCbackend();
    emitted = emitC(result, compiled, { unsafe: true });
  } catch (e) {
    if (e instanceof Unsupported) {
      return fail('C1 不支持该程序形态:' + e.message, json);
    }
    if (e instanceof CompileError) return reportCompileError(e, json); // v0.54 审查 B5
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
  const ccPath = detectCCompiler(json, spawnSync);
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
async function main() {
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
      const { files, error } = await projectEntry('run', rest, flags.has('json'));
      if (error) return fail(error, flags.has('json'));
      const programArgs = [...(files.length > 1 ? files.slice(1) : []), ...dashRest];
      const file = files[0];
      return cmdRun(file, flags, opts, programArgs);
    }
    case 'check': {
      const { files, error } = await projectEntry('check', rest, flags.has('json'));
      if (error) return fail(error, flags.has('json'));
      return cmdCheck(files, flags);
    }
    case 'test': {
      const { files, error } = await projectEntry('test', rest, flags.has('json'));
      if (error) return fail(error, flags.has('json'));
      return cmdTest(files, flags, opts);
    }
    case 'build': return cmdBuild(flags);
    case 'tools': return await cmdTools(rest, flags, opts, dashRest);
    case 'cc': {
      const { files, error } = await projectEntry('cc', rest, flags.has('json'));
      if (error) return fail(error, flags.has('json'));
      const programArgs = [...(files.length > 1 ? files.slice(1) : []), ...dashRest];
      return cmdCC(files[0], flags, opts, programArgs);
    }
    case 'init': return cmdInit(rest[0], flags);
    case 'lsp': (await lazyLsp()).startLsp(); return null; // 常驻:不退出进程
    case 'repl': (await lazyRepl()).startRepl(); return null; // 常驻:不退出进程
    case 'fmt': return cmdFmt(rest, flags);
    case 'doc': return cmdDoc(rest, flags);
    default:
      process.stderr.write(`未知命令 "${cmd}"\n\n${usage}\n`);
      return 1;
  }
}

// lsp 常驻:main 返回 null 时不退出进程
// v0.54 审查 B5:编译器内部错误(run/test/check 路径)也按诊断格式输出,不裸栈。
// (CompileError 在核心模块加载前不可能发生;绑定未就绪时短路判定,避免 ReferenceError。)
let __code;
try {
  __code = await main();
} catch (e) {
  if (CompileError && e instanceof CompileError) process.exit(reportCompileError(e, process.argv.includes('--json')));
  throw e;
}
if (__code !== null) process.exit(__code);
