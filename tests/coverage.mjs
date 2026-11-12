// tests/coverage.mjs — v0.57 覆盖率观测(§4.3.8;信息性指标,不设门槛,始终 exit 0)。
// 零依赖:用 NODE_V8_COVERAGE 让 Node/V8 原生写覆盖 JSON,再离线聚合 src/*.js 的行/函数覆盖。
// 用法:node tests/coverage.mjs [--json](--json 输出结构化结果;进度信息一律走 stderr)
//
// 口径(重要):
// - 行覆盖为 range 近似口径,非精确语句覆盖:一行被覆盖 = 存在 count>0 的函数 range 覆盖该行。
//   range 以函数体为单位,已执行函数体内未走到的分支行同样被计入(range 粒度所限);
//   模块顶层代码不属于任何真实函数,不计入。两者方向相反,相抵后仍是近似值——只用于同口径纵向趋势对比,
//   不要与其他工具(istanbul/nyc/c8 的语句覆盖)横向比较。
// - 行覆盖分母为"可覆盖行":trim 后非空、且非纯注释行(trim 后以 //、/*、* 开头),空行与纯注释行不计入。
// - 函数覆盖 = ranges[0].count > 0 的真实函数;排除 V8 顶层包装条目(functionName === '' 且
//   ranges[0].startOffset === 0——其 range 覆盖整个文件,纳入会把整文件误标为已覆盖)。
// - 同一脚本被主进程与多个子进程重复加载:行覆盖取并集,函数按首 range startOffset 合并、计数取最大。
// - 单个 coverage JSON 解析失败(进程被杀/写入中断)跳过并计数,不影响其余聚合。
// - 首个基线数字见 docs/coverage-baseline.md;先有基线,再谈阈值(plan §4.3.8)。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const RUN_TIMEOUT_MS = 30 * 60 * 1000; // 任务要求 ≥25 分钟,留余量到 30 分钟;超时则按已写文件聚合并注明

// ---------- 阶段 1:插桩跑全量回归(spawnSync;子进程经 env 继承 NODE_V8_COVERAGE) ----------
function instrumentedRun(covDir) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run.mjs')], {
    env: { ...process.env, NODE_V8_COVERAGE: covDir },
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  return {
    ms: Date.now() - t0,
    exitCode: r.status,
    timedOut: (r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM',
    summary: /(\d+) 通过,(\d+) 失败/.exec(((r.stdout ?? '') + (r.stderr ?? '')))?.[0] ?? null,
    tailErr: (r.stderr ?? '').split('\n').filter((l) => l.trim() !== '').slice(-60),
  };
}

// ---------- 阶段 2:聚合 V8 coverage JSON ----------
function isCoverableLine(line) {
  const t = line.trim();
  if (t === '') return false;
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return false;
  return true;
}

function srcInfo(abs, cache) {
  if (cache.has(abs)) return cache.get(abs);
  let info = null;
  try {
    const text = fs.readFileSync(abs, 'utf8');
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
    const lines = text.split('\n'); // lines.length === lineStarts.length
    const coverable = lines.map(isCoverableLine);
    let coverableCount = 0;
    for (const c of coverable) if (c) coverableCount++;
    info = { lineStarts, coverable, coverableCount };
  } catch { /* 源文件读不到(瞬时改动)→ 该条目跳过 */ }
  cache.set(abs, info);
  return info;
}

function lineOf(info, off) {
  let lo = 0, hi = info.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (info.lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function aggregateCoverage(covDir) {
  const files = new Map(); // absPath -> { abs, covered: Uint8Array, fns: Map<startOffset, maxCount> }
  const srcCache = new Map();
  let jsonCount = 0, parseFailures = 0, entrySkips = 0;

  for (const name of fs.readdirSync(covDir).sort()) {
    if (!/^coverage-.*\.json$/.test(name)) continue;
    jsonCount++;
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(path.join(covDir, name), 'utf8'));
    } catch {
      parseFailures++;
      continue;
    }
    for (const entry of Array.isArray(obj?.result) ? obj.result : []) {
      if (typeof entry.url !== 'string' || !entry.url.startsWith('file://')) continue;
      let abs;
      try { abs = fileURLToPath(entry.url); } catch { entrySkips++; continue; }
      if (!abs.startsWith(SRC_DIR + path.sep) || !abs.endsWith('.js')) continue;
      const info = srcInfo(abs, srcCache);
      if (!info) { entrySkips++; continue; }
      let rec = files.get(abs);
      if (!rec) {
        rec = { abs, covered: new Uint8Array(info.lineStarts.length), fns: new Map() };
        files.set(abs, rec);
      }
      for (const fn of Array.isArray(entry.functions) ? entry.functions : []) {
        const rs = Array.isArray(fn.ranges) ? fn.ranges : [];
        if (rs.length === 0) continue;
        // 顶层包装条目:整体排除(行覆盖会误标全文件;函数覆盖会虚增 1 个必中函数)
        if (fn.functionName === '' && rs[0].startOffset === 0) continue;
        const prev = rec.fns.get(rs[0].startOffset);
        if (prev === undefined || rs[0].count > prev) rec.fns.set(rs[0].startOffset, rs[0].count);
        for (const rg of rs) {
          if (!(rg.count > 0)) continue;
          const s = lineOf(info, rg.startOffset);
          const e = lineOf(info, Math.max(rg.startOffset, rg.endOffset - 1));
          for (let l = s; l <= e && l < rec.covered.length; l++) rec.covered[l] = 1;
        }
      }
    }
  }

  const rows = [...files.values()]
    .map((rec) => {
      const info = srcInfo(rec.abs, srcCache);
      let lineCovered = 0, fnCovered = 0;
      for (let i = 0; i < rec.covered.length; i++) {
        if (rec.covered[i] && info.coverable[i]) lineCovered++;
      }
      for (const c of rec.fns.values()) if (c > 0) fnCovered++;
      const fnTotal = rec.fns.size;
      const pct = (cov, tot) => (tot === 0 ? 0 : Math.round((cov / tot) * 1000) / 10);
      return {
        file: path.basename(rec.abs),
        lines: { covered: lineCovered, total: info.coverableCount, pct: pct(lineCovered, info.coverableCount) },
        functions: { covered: fnCovered, total: fnTotal, pct: pct(fnCovered, fnTotal) },
      };
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const sum = (key) => rows.reduce(
    (acc, r) => ({ covered: acc.covered + r[key].covered, total: acc.total + r[key].total }),
    { covered: 0, total: 0 },
  );
  const lineSum = sum('lines'), fnSum = sum('functions');
  const summary = {
    files: rows.length,
    lines: { ...lineSum, pct: lineSum.total === 0 ? 0 : Math.round((lineSum.covered / lineSum.total) * 1000) / 10 },
    functions: { ...fnSum, pct: fnSum.total === 0 ? 0 : Math.round((fnSum.covered / fnSum.total) * 1000) / 10 },
  };
  return { rows, summary, jsonCount, parseFailures, entrySkips };
}

// ---------- 主流程 ----------
async function main() {
  const wantJson = process.argv.includes('--json');
  const note = (s) => process.stderr.write(s + '\n');

  note('[1/2] 插桩运行 tests/run.mjs(NODE_V8_COVERAGE;全量套件预计 15–25 分钟,并行负载下更慢)…');
  const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-coverage-'));
  let run = null, agg = null, aggErr = null;
  try {
    run = instrumentedRun(covDir);
    note(`      插桩运行完成:用时 ${(run.ms / 60000).toFixed(1)} 分钟,退出码 ${run.exitCode}${run.timedOut ? '(超时被杀,按已写文件聚合)' : ''}${run.summary ? `,回归:${run.summary}` : ''}`);
    if (run.tailErr.length > 0) note(`      stderr 末尾: ${run.tailErr.join(' | ').slice(0, 200)}`);
    note('[2/2] 聚合 coverage JSON…');
    agg = aggregateCoverage(covDir);
  } catch (e) {
    aggErr = e;
  } finally {
    try { fs.rmSync(covDir, { recursive: true, force: true }); } catch { /* 清理失败不影响报告 */ }
  }

  const payload = {
    meta: {
      tool: 'tests/coverage.mjs (v0.57,信息性)',
      date: new Date().toISOString().slice(0, 10),
      node: process.version,
      scope: 'src/*.js',
      caliber: '行覆盖为 range 近似口径,非精确语句覆盖;分母为可覆盖行(非空且非纯注释);详见文件头注释',
      runMs: run ? run.ms : null,
      runExitCode: run ? run.exitCode : null,
      runTimedOut: run ? run.timedOut : null,
      runSummary: run ? run.summary : null,
      ...(agg
        ? { coverageJsonFiles: agg.jsonCount, parseFailures: agg.parseFailures, entrySkips: agg.entrySkips }
        : { coverageJsonFiles: 0, parseFailures: 0, entrySkips: 0 }),
      error: aggErr ? String(aggErr && aggErr.stack ? aggErr.stack : aggErr).slice(0, 500) : null,
    },
    ...(agg ? { files: agg.rows, summary: agg.summary } : {}),
  };

  if (wantJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (agg) {
    note('');
    console.log('== Ming 覆盖率观测 v0.57(信息性,不设门槛)==');
    console.log(`coverage JSON: ${agg.jsonCount} 个(解析失败 ${agg.parseFailures},条目跳过 ${agg.entrySkips})`);
    console.log('');
    console.log(`${'文件'.padEnd(14)} ${'行覆盖(可覆盖行)'.padEnd(18)} ${'函数覆盖'.padEnd(18)}`);
    for (const r of agg.rows) {
      console.log(
        `${r.file.padEnd(14)} ${`${r.lines.pct.toFixed(1)}%`.padStart(6)} ${`${r.lines.covered}/${r.lines.total}`.padStart(11)}   ${`${r.functions.pct.toFixed(1)}%`.padStart(6)} ${`${r.functions.covered}/${r.functions.total}`.padStart(11)}`,
      );
    }
    console.log('-'.repeat(64));
    console.log(
      `合计(${agg.summary.files} 文件)  ${`${agg.summary.lines.pct.toFixed(1)}%`.padStart(6)} ${`${agg.summary.lines.covered}/${agg.summary.lines.total}`.padStart(11)}   ${`${agg.summary.functions.pct.toFixed(1)}%`.padStart(6)} ${`${agg.summary.functions.covered}/${agg.summary.functions.total}`.padStart(11)}`,
    );
    console.log('');
    console.log('口径:行覆盖为 range 近似口径,非精确语句覆盖(详见 tests/coverage.mjs 头注释与 docs/coverage-baseline.md)。');
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
  // 信息性:聚合成功与否都 exit 0;错误已在 payload.error 注明
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
