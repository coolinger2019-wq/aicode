#!/usr/bin/env node
// T1.2-a 对照实验采集器(零依赖 Node)——plan §4.17 T1.2-a/b。
// 预注册合同 = docs/experiment-design.md(单一事实来源);本采集器只做采集与验证编排,
// 不写被测程序、不改判据与指标(作者-执行者分离,设计 §5.4)。语料 tests/experiment/tasks/**
// 只读;本采集器自身不改 docs/** src/** tests/run.mjs。
//
// 落地缺口(设计 §8):
//   缺口 5  修复轮反馈模板 —— --feedback(静态检查输出原文 + verify 输出原文,三语言同形)。
//   缺口 6  prompt 裁剪     —— --prompt 与 --pilot 内置:按 "## 语言约束" 节标题定位,
//                             只发送"正文 + 对应语言小节",禁止整文件发送(结构违规即报错)。
//   缺口 4  端口段预检+env_blocked —— **已实现(2026-11-22)**:--record/--pilot 对任务
//        b3_fetch_aggregate/b4_serve_handler 先做端口预检(node:net 绑定探测经同步子进程;
//        b3 候选段 21031–21060 连续 30 个——基址 21031、需连续 3 端口组、+3 漂移 ×10;
//        b4 候选 10 个——基址 21241、+7 漂移 ×10;口径与语料 mock_server.mjs/harness.mjs
//        及 README"约定"节一致)。段内**任一**候选端口不可绑定 → 该格记 env_blocked:
//        JSONL 行带 env_blocked:true + blocked_ports 明细,跳过静态检查与 verify;
//        --matrix 单列(blk)且不计入样本统计(首过/轮次/静态检查口径全排除);退出码遵循
//        "偏差 = 1"口径。已知局限维持登记:预检释放到 harness 真实绑定之间的抢注窗口
//        (TOCTOU);并发跑多格时端口互占会让判定收紧——建议串行执行服务型任务两格
//        (设计 §8 缺口 4 原口径;"外来服务恰在漂移端口应答 200"的静态占用面已由预检关闭)。
//        预检覆盖 = 手工验证(占用/健康双向实测)+ T1.2-c 首采;tests/run.mjs §111 回归测试
//        待并行化合并后补登记。
//   缺口 7  env 指纹        —— 每 run JSONL 记录 env:{os,node,python,ming_head,tsc}
//                             (附加 ming_version),逐 run 嵌入。
//   缺口 8  工具口径        —— Python 静态检查 = python -m py_compile;Ming = ming check --json
//                             (error 计数);TS = tsc --noEmit --strict(缺省 npx -p typescript,
//                             正式采集建议 --tsenv 固定布局,@types/node 缺失时的 TS2591 环境噪音
//                             与方案缺陷不可区分——已在试点实测确认)。静态检查不是通过门槛(§5.1.3)。
//
// 用法(采集器以自身路径锚定仓库根,子进程一律 cwd=仓库根;相对路径均按仓库根解析):
//   node tests/experiment/run.mjs --pilot [--root DIR] [--tsenv DIR] [--tsc-cmd "CMD"]
//       T1.2-b 试点:a1_log_clean + c2_timeout_fallback × 3 语言 × 3 run
//       (被测提交 = 各任务 solutions/ 参考实现,source=solutions-pilot,不冒充模型生成,
//        JSONL 全部 pilot:true,输出 .zcode/exp-pilot/ 不进正式样本)。
//       附:每任务×语言 1 条负例腿(交叉喂入另一任务参考实现,预期 FAIL,验证 FAIL 记录与反馈回路)。
//   node tests/experiment/run.mjs --record --task <id> --language ming|typescript|python
//       --run N [--round N] --program <预落盘程序路径> [--run-id ID] [--source S]
//       [--expect pass|fail] [--model M] [--temperature T] [--prompt-tokens N]
//       [--completion-tokens N] [--note S] [--root DIR]
//       T1.2-a 生成者接口(单次 verify 事件):落盘工作副本 → 静态检查 → verify →
//       追加 <root>/results.jsonl(缺省 tests/experiment/results/results.jsonl)。
//       修复轮由生成批按同一 --run 不同 --round 多次调用;轮次/首过聚合在 --matrix。
//   node tests/experiment/run.mjs --prompt <task> <language> [--out FILE]
//       组装裁剪 prompt 到 stdout 或 --out 文件。
//   node tests/experiment/run.mjs --matrix [--root DIR]
//       按 任务×语言 聚合 results.jsonl → matrix.json + 控制台表
//       (首次通过/最终通过/轮次口径按 run_no×round 聚合;负例腿单独列,不入样本统计)。
//   node tests/experiment/run.mjs --feedback <run_id> [--root DIR] [--out FILE]
//   node tests/experiment/run.mjs --env [--tsenv DIR] [--tsc-cmd "CMD"]
//
// 退出码:0 = 本模式全部按预期;1 = 存在偏差/参数错误/结构违规;明细走 stderr。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // tests/experiment
const REPO_ROOT = path.resolve(HERE, "..", ".."); // 仓库根
const TASKS_DIR = "tests/experiment/tasks";
const FORMAL_ROOT = "tests/experiment/results";
const PILOT_ROOT = ".zcode/exp-pilot";
const PILOT_TASKS = ["a1_log_clean", "c2_timeout_fallback"];
const PILOT_RUNS = [1, 2, 3];
const VERIFY_TIMEOUT_MS = 180000; // verify 脚本内部对被测程序另有 60s 超时
const TSC_DEFAULT = "npx -p typescript tsc --noEmit --strict"; // 设计 §8 缺口 1 缺省;建议 --tsenv 固定布局

// 语言注册:ext = 交付物扩展名;sec = prompt.md 语言约束小节标题(### 之后);verifyFile = 验收脚本。
const LANGS = {
  ming: { ext: "ming", sec: "ming", verifyFile: "verify.ming", staticTool: "ming check --json" },
  typescript: { ext: "ts", sec: "typescript", verifyFile: "verify.js", staticTool: "tsc --noEmit --strict" },
  python: { ext: "py", sec: "python", verifyFile: "verify.py", staticTool: "python -m py_compile" },
};
const LANG_ALIASES = { ming: "ming", ts: "typescript", typescript: "typescript", py: "python", python: "python" };

// ---------- 基础工具 ----------

function relToRepo(p) {
  return path.relative(REPO_ROOT, path.resolve(REPO_ROOT, p)).split(path.sep).join("/");
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

// 子进程封装:全部 cwd=仓库根;win32 下 .cmd/.bat(如 npx)必须经 shell 生成(Node ≥20.12 直接生成 .cmd 抛 EINVAL)。
// shell 模式按空格拼串——路径含空格不支持(登记局限);直接生成模式走参数数组,无引号问题。
function runCmd(cmd, args, { timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const needsShell = process.platform === "win32" && (cmd === "npx" || /\.(cmd|bat)$/i.test(cmd));
  let r;
  if (needsShell) {
    const joined = [cmd, ...args]
      .map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a))
      .join(" ");
    r = spawnSync(joined, {
      shell: true,
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } else {
    r = spawnSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  }
  return {
    code: r.status, // null = 信号终止/生成失败
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ? String(r.error.message || r.error) : null,
    timedOut: r.signal !== null,
    durationMs: Date.now() - t0,
  };
}

function exitCodeDesc(r) {
  if (r.timedOut) return "timeout";
  if (r.code === null && r.error) return "spawn-error: " + r.error;
  if (r.code === null) return "signal: " + (r.signal ?? "unknown");
  return r.code;
}

// ---------- §8 缺口 6:prompt 裁剪 ----------

// 裁出"正文 + 对应语言小节":按 "## 语言约束" 节标题定位,语言小节按 "### <sec>" 定位;
// 兄弟语言小节必须被剔除(整文件发送 = 三语言约束泄漏,违背控制变量)。返回对象并在结构违规时抛错。
function cropPrompt(task, langKey) {
  const lang = LANGS[langKey];
  const fullPath = path.join(REPO_ROOT, TASKS_DIR, task, "prompt.md");
  if (!existsSync(fullPath)) throw new Error(`任务不存在: ${TASKS_DIR}/${task}/prompt.md`);
  const raw = readFileSync(fullPath, "utf8");
  const lines = raw.split("\n");
  const secIdx = lines.findIndex((l) => l.startsWith("## 语言约束"));
  if (secIdx < 0) throw new Error(`${task}: prompt.md 缺少 "## 语言约束" 节标题(§8 缺口 6 裁剪不可行)`);
  const bodyLines = lines.slice(0, secIdx);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
  const want = "### " + lang.sec;
  let langIdx = -1;
  for (let i = secIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("### ")) {
      const head = lines[i].trimEnd();
      if (head === want || head.startsWith(want + " ") || head.startsWith(want + "(")) {
        langIdx = i;
        break;
      }
    } else if (lines[i].startsWith("## ")) {
      break; // 语言约束节提前结束
    }
  }
  if (langIdx < 0) throw new Error(`${task}: prompt.md 语言约束节缺少 "### ${lang.sec}" 小节`);
  let end = lines.length;
  for (let i = langIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("### ") || lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const langSection = lines.slice(langIdx, end);
  while (langSection.length > 0 && langSection[langSection.length - 1].trim() === "") langSection.pop();
  if (langSection[0].trimEnd() !== want) throw new Error(`${task}: 语言小节首行不是 "${want}"`);
  for (let i = 1; i < langSection.length; i++) {
    if (langSection[i].startsWith("### ")) {
      throw new Error(`${task}: 语言小节 "${want}" 内混入其他小节标题 "${langSection[i].trimEnd()}"`);
    }
  }
  const text = [...bodyLines, "", lines[secIdx], "", ...langSection].join("\n");
  return {
    text: text.endsWith("\n") ? text : text + "\n",
    body: bodyLines.join("\n"),
    full: raw,
    langHeader: want,
    secHeading: lines[secIdx].trimEnd(),
  };
}

// 裁剪结果自检(§8 缺口 6 冒烟判据):只含本语言小节头;正文跨语言逐字一致;
// crop 必须短于全文(禁止整文件发送);含语言约束节标题。
function checkCrop(task, langKey, crop, bodies) {
  const errs = [];
  const others = Object.keys(LANGS)
    .filter((k) => k !== langKey)
    .map((k) => "### " + LANGS[k].sec);
  const ownCount = crop.text.split(crop.langHeader).length - 1;
  if (ownCount !== 1) errs.push(`本语言小节头 "${crop.langHeader}" 出现 ${ownCount} 次(应为 1)`);
  for (const oh of others) {
    if (crop.text.includes(oh)) errs.push(`混入其他语言小节头 "${oh}"`);
  }
  if (!crop.text.includes("## 语言约束")) errs.push('缺 "## 语言约束" 节标题');
  if (crop.text.length >= crop.full.length) errs.push("crop 长度 ≥ 全文长度(疑似整文件发送)");
  const prev = bodies.get(task);
  if (prev !== undefined && prev !== crop.body) errs.push("正文与其他语言不一致(违背'其余部分逐字相同')");
  bodies.set(task, crop.body);
  return errs;
}

// ---------- §8 缺口 7:环境指纹 ----------

function tscParts(opts) {
  // 优先级:--tsc-cmd(可含 {prog} 占位) > --tsenv > 缺省 npx
  if (opts.tscCmd) {
    const tokens = opts.tscCmd.trim().split(/\s+/);
    const pi = tokens.indexOf("{prog}");
    if (pi >= 0) {
      return { cmd: tokens[0], pre: tokens.slice(1, pi), post: tokens.slice(pi + 1) };
    }
    return { cmd: tokens[0], pre: tokens.slice(1), post: [] };
  }
  if (opts.tsenv) {
    const tsBin = relToRepo(path.join(opts.tsenv, "node_modules", "typescript", "bin", "tsc"));
    const typeRoots = relToRepo(path.join(opts.tsenv, "node_modules", "@types"));
    return {
      cmd: "node",
      pre: [tsBin, "--noEmit", "--strict", "--typeRoots", typeRoots, "--types", "node"],
      post: [],
    };
  }
  const tokens = TSC_DEFAULT.trim().split(/\s+/);
  return { cmd: tokens[0], pre: tokens.slice(1), post: [] };
}

function probeEnv(opts) {
  const env = {};
  env.os = `${os.type()} ${os.release()} ${os.arch()} (${process.platform})`;
  env.node = process.version;
  const py = runCmd("python", ["--version"], { timeoutMs: 30000 });
  env.python = py.error
    ? "unavailable(" + py.error + ")"
    : (py.stdout.trim() || py.stderr.trim() || "unknown");
  const head = runCmd("git", ["rev-parse", "HEAD"], { timeoutMs: 30000 });
  env.ming_head = head.error ? "unavailable" : head.stdout.trim() || "unknown";
  const mv = runCmd("node", ["bin/ming.js", "version"], { timeoutMs: 60000 });
  env.ming_version = mv.error ? "unavailable" : mv.stdout.trim().replace(/^Ming /, "");
  const tsc = tscParts(opts);
  const tv = runCmd(tsc.cmd, [...tsc.pre, ...tsc.post, "--version"], { timeoutMs: 120000 });
  const verText = (tv.stdout.trim() + " " + tv.stderr.trim()).trim();
  env.tsc = tv.error ? "unavailable(" + tv.error + ")" : verText || "unknown";
  env.tsc += opts.tscCmd ? " (--tsc-cmd)" : opts.tsenv ? ` (tsenv: ${relToRepo(opts.tsenv)})` : " (npx -p typescript)";
  return env;
}

// ---------- §8 缺口 4:服务型任务端口预检(env_blocked) ----------

// 端口探测子进程脚本(node:net 绑定探测;主进程保持同步风格,经 spawnSync 调用):
//   输出单行 JSON {ok, group, probed:[{port,bindable}]}。
// 判定口径(设计 §8 缺口 4"占用检查步骤"):所需端口段内**任一**候选端口不可绑定
// → ok:false(env_blocked);全部可绑定 → ok:true。预检确认环境干净后由 harness
// 自行绑定基址——这正是并发多格会互占端口而建议串行的原因;外来服务在段内任意
// 端口的静态占用被预检拦在门外(残余 TOCTOU 窗口登记为已知局限)。
// 绑定探测口径:127.0.0.1 + exclusive;绑定成功即 close 释放。
const PORT_PROBE_SCRIPT = `
const net = require("node:net");
const task = process.argv[1];
const isB4 = task === "b4_serve_handler";
const base = isB4 ? 21241 : 21031;
function probe(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    let done = false;
    const fin = (ok) => {
      if (done) return;
      done = true;
      try { s.close(() => resolve(ok)); } catch { resolve(ok); }
    };
    s.once("error", () => fin(false));
    s.listen({ port, host: "127.0.0.1", exclusive: true }, () => fin(true));
    setTimeout(() => fin(false), 800);
  });
}
(async () => {
  // 所需端口集合: b3 = 21031..21060 连续 30 个(mock_server 需连续 3 端口组,+3 漂移 ×10 无间隙);
  //              b4 = 21241 + i*7 ×10(harness 漂移候选,+7 间隔)。
  const ports = [];
  for (let i = 0; i < 10; i++) {
    if (isB4) {
      ports.push(base + i * 7);
    } else {
      ports.push(base + i * 3, base + i * 3 + 1, base + i * 3 + 2);
    }
  }
  const probed = [];
  for (const p of ports) {
    probed.push({ port: p, bindable: await probe(p) });
  }
  const ok = probed.every((x) => x.bindable);
  process.stdout.write(JSON.stringify({ ok, group: ok ? [base] : null, probed }));
})().catch((e) => { console.error(String(e && e.message || e)); process.exit(2); });
`;

// 服务型任务端口集合(语料漂移口径 = mock_server.mjs/harness.mjs + README"约定"节):
//   b3_fetch_aggregate:mock_server 绑定 base=21031、占用 +3 重试 ×10,每次需连续 3 端口组
//                      (候选段 21031–21060 连续 30 个);
//   b4_serve_handler:  harness 从 base=21241 起 +7 重试 ×10(候选 10 个)。
// 返回 {needed:false}(非服务型任务)或 {needed, ok, detail};任一候选端口不可绑定
// → ok:false(env_blocked)。探测自身失败按 env_blocked 保守处理(明细注明 probe_error
// ——无法确认端口可用性时不得让 harness 半途挂起)。
function probeServicePorts(task) {
  if (task !== "b3_fetch_aggregate" && task !== "b4_serve_handler") return { needed: false };
  const r = spawnSync(process.execPath, ["-e", PORT_PROBE_SCRIPT, task], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    return {
      needed: true,
      ok: false,
      detail: {
        ok: false,
        group: null,
        probed: [],
        probe_error: r.error ? String(r.error.message || r.error) : "exit " + r.status + ": " + String(r.stderr || "").slice(0, 400),
      },
    };
  }
  try {
    const j = JSON.parse(r.stdout);
    return { needed: true, ok: !!j.ok, detail: j };
  } catch {
    return {
      needed: true,
      ok: false,
      detail: { ok: false, group: null, probed: [], probe_error: "探测输出解析失败: " + String(r.stdout || "").slice(0, 200) },
    };
  }
}

// ---------- 静态检查(§5.1.3;不是通过门槛,错误计数入 M2 槽位) ----------

function staticCheck(langKey, progAbs, opts) {
  const lang = LANGS[langKey];
  const progRel = relToRepo(progAbs);
  const base = { tool: lang.staticTool, program: progRel };
  if (langKey === "ming") {
    const r = runCmd("node", ["bin/ming.js", "check", progRel, "--json"], { timeoutMs: 90000 });
    if (r.error && r.code === null) return { ...base, status: "unavailable", exit: exitCodeDesc(r), errors: null, warnings: null, output: r.stderr, duration_ms: r.durationMs };
    let errors = null;
    let warnings = null;
    let output = (r.stdout || "") + (r.stderr || "");
    try {
      const j = JSON.parse(r.stdout);
      errors = (j.diagnostics || []).filter((d) => d.severity === "error").length;
      warnings = (j.diagnostics || []).filter((d) => d.severity !== "error").length;
      output = r.stdout;
    } catch {
      // JSON 解析失败 = 非预期输出形态,如实记录原文
    }
    return { ...base, status: "ok", exit: r.code, errors, warnings, output, duration_ms: r.durationMs };
  }
  if (langKey === "typescript") {
    const tsc = tscParts(opts);
    const r = runCmd(tsc.cmd, [...tsc.pre, progRel, ...tsc.post], { timeoutMs: 180000 });
    if (r.error && r.code === null) return { ...base, status: "unavailable", exit: exitCodeDesc(r), errors: null, warnings: null, output: r.stderr, duration_ms: r.durationMs };
    const text = (r.stdout || "") + (r.stderr || "");
    const errors = (text.match(/error TS\d+/g) || []).length;
    return { ...base, status: "ok", exit: r.code, errors, warnings: null, output: text, duration_ms: r.durationMs };
  }
  // python:§8 缺口 8 —— python -m py_compile
  const r = runCmd("python", ["-m", "py_compile", progRel], { timeoutMs: 60000 });
  if (r.error && r.code === null) return { ...base, status: "unavailable", exit: exitCodeDesc(r), errors: null, warnings: null, output: r.stderr, duration_ms: r.durationMs };
  return {
    ...base,
    status: "ok",
    exit: r.code,
    errors: r.code === 0 ? 0 : 1, // py_compile 二值口径
    warnings: null,
    output: (r.stdout || "") + (r.stderr || ""),
    duration_ms: r.durationMs,
  };
}

// ---------- verify(黑盒验收;退出码 0 = PASS,1 = FAIL) ----------

function verifyLeg(langKey, task, progAbs) {
  const lang = LANGS[langKey];
  const tdir = `${TASKS_DIR}/${task}`;
  const progRel = relToRepo(progAbs);
  let cmd;
  let args;
  if (langKey === "ming") {
    cmd = "node";
    args = ["bin/ming.js", "run", `${tdir}/verify.ming`, "--", progRel];
  } else if (langKey === "typescript") {
    cmd = "node";
    args = [`${tdir}/${lang.verifyFile}`, progRel];
  } else {
    cmd = "python";
    args = [`${tdir}/${lang.verifyFile}`, progRel];
  }
  const r = runCmd(cmd, args, { timeoutMs: VERIFY_TIMEOUT_MS });
  let result;
  if (r.timedOut || (r.code === null && r.error)) result = "ERROR";
  else if (r.code === 0) result = "PASS";
  else if (r.code === 1) result = "FAIL";
  else result = "ERROR";
  return { ...r, result, command: [cmd, ...args].join(" ") };
}

// ---------- 记录与 JSONL(§5.1.7 + §8 缺口 7) ----------

function buildDefects(sc, verify) {
  const d = [];
  if (sc && sc.status === "ok" && typeof sc.errors === "number" && sc.errors > 0) {
    d.push({ kind: "static", tool: sc.tool, count: sc.errors });
  }
  if (verify.result === "FAIL") d.push({ kind: "verify", result: "FAIL", exit: verify.code });
  if (verify.result === "ERROR") {
    d.push({ kind: "verify", result: "ERROR", exit: verify.timedOut ? "timeout" : verify.error ?? verify.signal });
  }
  return d;
}

function makeRecord(o) {
  // o: {runId, task, langKey, runNo, round, source, expect, pilot, progAbs, progSrcRel, env, sc, verify, model, temperature, tokensP, tokensC, note}
  const pass = o.verify.result === "PASS";
  const fail = o.verify.result === "FAIL";
  const asExpected = o.expect === "pass" ? pass : o.expect === "fail" ? fail : false;
  return {
    run_id: o.runId,
    pilot: !!o.pilot,
    source: o.source,
    expect: o.expect,
    as_expected: asExpected,
    task: o.task,
    language: o.langKey,
    run_no: o.runNo,
    repeat: o.runNo, // 预注册 §5.1 字段名;run_no 同值别名
    round: o.round,
    env: o.env,
    program: {
      path: relToRepo(o.progAbs),
      source_path: relToRepo(o.progSrcRel),
      sha256: sha256File(o.progAbs),
      bytes: statSync(o.progAbs).size,
    },
    static_check: o.sc,
    verify_result: o.verify.result,
    exit: exitCodeDesc(o.verify),
    verify_command: o.verify.command,
    duration_ms: o.verify.durationMs,
    verify_output: { stdout: o.verify.stdout, stderr: o.verify.stderr },
    model: o.model ?? null,
    temperature: o.temperature ?? null,
    rounds: null, // 全 run 轮次总数——生成批收口/T1.3 聚合槽位
    first_pass: o.round === 1 ? (pass ? true : fail ? false : null) : null,
    defects: buildDefects(o.sc, o.verify),
    tokens: { prompt: o.tokensP ?? null, completion: o.tokensC ?? null },
    wall_ms: null, // M5 槽位(整 run 墙钟,生成批记录);本事件时长见 duration_ms
    verdict: pass ? "pass" : fail ? "fail" : "error",
    notes: o.note ?? "",
    ts: new Date().toISOString(),
  };
}

// env_blocked 记录(§8 缺口 4):端口预检失败格——跳过静态检查与 verify,不计入样本统计。
// 字段与 makeRecord 同名对齐,verify_result = "ENV_BLOCKED" 可区分;blocked_ports = 探测明细。
function makeEnvBlockedRecord(o, probe) {
  // o: 与 makeRecord 入参同形;probe: probeServicePorts 返回 {needed, ok, detail}
  return {
    run_id: o.runId,
    pilot: !!o.pilot,
    source: o.source,
    expect: o.expect,
    as_expected: false,
    task: o.task,
    language: o.langKey,
    run_no: o.runNo,
    repeat: o.runNo,
    round: o.round,
    env: o.env,
    env_blocked: true,
    blocked_ports: probe.detail.probed,
    port_group_found: probe.detail.group ?? null,
    probe_error: probe.detail.probe_error ?? null,
    program: null,
    static_check: null,
    verify_result: "ENV_BLOCKED",
    exit: "env-blocked",
    verify_command: null,
    duration_ms: null,
    verify_output: null,
    model: o.model ?? null,
    temperature: o.temperature ?? null,
    rounds: null,
    first_pass: null,
    defects: [],
    tokens: { prompt: o.tokensP ?? null, completion: o.tokensC ?? null },
    wall_ms: null,
    verdict: "env_blocked",
    notes:
      (o.note ? o.note + "; " : "") +
      "端口预检失败(env_blocked,设计 §8 缺口 4):所需端口段内存在不可绑定端口,该格不计入样本统计",
    ts: new Date().toISOString(),
  };
}

function appendJsonl(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj) + "\n", { flag: "a" });
}

// ---------- §8 缺口 5:修复轮反馈模板(三语言同形,只有原文,无人类解释) ----------

function renderFeedback(rec) {
  const scOut = rec.static_check && rec.static_check.output && rec.static_check.output.trim() !== "" ? rec.static_check.output : "(空)";
  const vOut = rec.verify_output ? rec.verify_output.stdout + rec.verify_output.stderr : "";
  const vText = vOut.trim() !== "" ? vOut : "(空)";
  return [
    `=== 修复轮反馈 | run_id=${rec.run_id} | round=${rec.round} | task=${rec.task} | language=${rec.language} ===`,
    "--- 静态检查输出(原文) ---",
    scOut,
    "--- 验收输出(原文) ---",
    vText,
    "",
  ].join("\n");
}

// ---------- 汇总矩阵(任务×语言;负例腿单列不入样本统计) ----------

function buildMatrix(records) {
  const cells = new Map();
  for (const r of records) {
    const k = `${r.task}|${r.language}`;
    if (!cells.has(k)) {
      cells.set(k, {
        task: r.task,
        language: r.language,
        legs: 0,
        pass_legs: 0,
        fail_legs: 0,
        error_legs: 0,
        blocked_legs: 0,
        neg_legs: 0,
        neg_ok: 0,
        static_errors_sample: 0,
        static_unavailable: 0,
        pass_durations: [],
        repeats: new Map(),
      });
    }
    const c = cells.get(k);
    if (r.env_blocked) {
      // §8 缺口 4:env_blocked 腿单列,不计入样本统计(legs/首过/轮次/静态检查全排除)
      c.blocked_legs++;
      continue;
    }
    c.legs++;
    if (r.verify_result === "PASS") c.pass_legs++;
    else if (r.verify_result === "FAIL") c.fail_legs++;
    else c.error_legs++;
    if (r.expect === "fail") {
      c.neg_legs++;
      if (r.as_expected) c.neg_ok++;
      continue; // 负例腿不入 run 级统计
    }
    if (r.static_check) {
      if (r.static_check.status === "ok" && typeof r.static_check.errors === "number") c.static_errors_sample += r.static_check.errors;
      if (r.static_check.status === "unavailable") c.static_unavailable++;
    }
    if (r.verify_result === "PASS") c.pass_durations.push(r.duration_ms);
    if (!c.repeats.has(r.repeat)) c.repeats.set(r.repeat, { first_round_pass: null, max_round: 0, last_pass: false });
    const s = c.repeats.get(r.repeat);
    if (r.round > s.max_round) {
      s.max_round = r.round;
      s.last_pass = r.verify_result === "PASS";
    }
    if (r.round === 1) s.first_round_pass = r.verify_result === "PASS";
  }
  return [...cells.values()].map((c) => {
    const reps = [...c.repeats.values()];
    const passedReps = reps.filter((s) => s.last_pass);
    const avg = (arr) => (arr.length === 0 ? null : Math.round(arr.reduce((a, b) => a + b, 0) / arr.length));
    return {
      task: c.task,
      language: c.language,
      runs: c.repeats.size,
      legs: c.legs,
      pass_legs: c.pass_legs,
      fail_legs: c.fail_legs,
      error_legs: c.error_legs,
      blocked_legs: c.blocked_legs,
      first_pass_runs: reps.filter((s) => s.first_round_pass === true).length,
      final_pass_runs: passedReps.length,
      avg_rounds: passedReps.length === 0 ? null : Math.round((passedReps.reduce((a, s) => a + s.max_round, 0) / passedReps.length) * 10) / 10,
      avg_pass_ms: avg(c.pass_durations),
      static_errors_total: c.static_errors_sample,
      static_unavailable: c.static_unavailable,
      neg_legs: c.neg_legs,
      neg_ok: c.neg_ok,
    };
  });
}

function printMatrix(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log("");
  console.log(
    pad("task", 21) +
      pad("language", 11) +
      pad("runs", 5) +
      pad("legs", 5) +
      pad("pass", 5) +
      pad("fail", 5) +
      pad("err", 4) +
      pad("blk", 5) +
      pad("fp", 4) +
      pad("fin", 4) +
      pad("avgRd", 6) +
      pad("avgMs", 8) +
      pad("stErr", 6) +
      pad("neg", 8)
  );
  for (const c of rows) {
    console.log(
      pad(c.task, 21) +
        pad(c.language, 11) +
        pad(c.runs, 5) +
        pad(c.legs, 5) +
        pad(c.pass_legs, 5) +
        pad(c.fail_legs, 5) +
        pad(c.error_legs, 4) +
        pad(c.blocked_legs, 5) +
        pad(c.first_pass_runs, 4) +
        pad(c.final_pass_runs, 4) +
        pad(c.avg_rounds ?? "-", 6) +
        pad(c.avg_pass_ms ?? "-", 8) +
        pad(c.static_errors_total, 6) +
        pad(`${c.neg_ok}/${c.neg_legs}`, 8)
    );
  }
  console.log("(fp=首轮通过 run 数;fin=最终通过 run 数;blk=env_blocked 腿数(端口预检失败,§8 缺口 4,不计入样本统计);stErr=样本腿静态检查错误合计;neg=负例腿按预期失败数/总数)");
}

// ---------- 单腿执行 ----------

function stageProgram(root, runId, srcAbs, langKey) {
  const workDir = path.join(root, "work", runId);
  mkdirSync(workDir, { recursive: true });
  const dst = path.join(workDir, `solution.${LANGS[langKey].ext}`);
  copyFileSync(srcAbs, dst);
  return dst;
}

function runOneLeg(o) {
  // o: {root, task, langKey, runNo, round, runId, progSrcRel, source, expect, pilot, env, opts, model, temperature, tokensP, tokensC, note}
  const lang = LANGS[o.langKey];
  const ext = o.progSrcRel.split(".").pop().toLowerCase();
  if (ext !== lang.ext) throw new Error(`程序扩展名 .${ext} 与语言 ${o.langKey}(.${lang.ext}) 不符: ${o.progSrcRel}`);
  // §8 缺口 4:服务型任务(b3/b4)先做端口预检;失败 → env_blocked 行(跳过落盘/静态检查/verify)
  const probe = probeServicePorts(o.task);
  if (probe.needed && !probe.ok) {
    const rec = makeEnvBlockedRecord(o, probe);
    appendJsonl(path.join(o.root, "results.jsonl"), rec);
    return rec;
  }
  // resolve(非 join):--program 可传绝对路径(套件 mkdtemp stub;CI Windows 仓库盘 ≠ tmp 盘时
  // path.relative 跨盘返回绝对路径,join 会拼成 "仓库盘:\<C:\...>" 垃圾路径 → ENOENT——2026-11-22 CI win22 实测)
  const progAbs = stageProgram(o.root, o.runId, path.resolve(REPO_ROOT, o.progSrcRel), o.langKey);
  const sc = staticCheck(o.langKey, progAbs, o.opts);
  const verify = verifyLeg(o.langKey, o.task, progAbs);
  const rec = makeRecord({
    runId: o.runId,
    task: o.task,
    langKey: o.langKey,
    runNo: o.runNo,
    round: o.round,
    source: o.source,
    expect: o.expect,
    pilot: o.pilot,
    progAbs,
    progSrcRel: o.progSrcRel,
    env: o.env,
    sc,
    verify,
    model: o.model,
    temperature: o.temperature,
    tokensP: o.tokensP,
    tokensC: o.tokensC,
    note: o.note,
  });
  appendJsonl(path.join(o.root, "results.jsonl"), rec);
  return rec;
}

function printLeg(rec) {
  if (rec.env_blocked) {
    const tag = rec.expect === "fail" ? "neg " : "leg ";
    console.log(`ENV ${tag}${rec.task}/${rec.language}  ENV_BLOCKED  (端口预检失败,该格不计入样本统计)`);
    const probed = (rec.blocked_ports || []).map((p) => `${p.port}:${p.bindable ? "free" : "busy"}`).join(" ");
    console.error(`  env_blocked: 所需端口段存在不可绑定端口;探测明细 ${probed || "(探测未执行" + (rec.probe_error ? ": " + rec.probe_error + ")" : ")")}`);
    return;
  }
  const tag = rec.expect === "fail" ? "neg " : "leg ";
  const mark = rec.as_expected ? "OK  " : "BAD ";
  const sc = rec.static_check;
  const scText =
    sc.status === "ok"
      ? `${sc.tool} errors=${sc.errors ?? "?"}`
      : `${sc.tool} ${sc.status}(${sc.exit})`;
  console.log(
    `${mark}${tag}${rec.task}/${rec.language}  ${rec.verify_result}  exit=${rec.exit}  ${String(rec.duration_ms).padStart(6)}ms  static: ${scText}`
  );
  if (!rec.as_expected) {
    console.error(`  偏差: expect=${rec.expect} 但 verify_result=${rec.verify_result}`);
    const v = rec.verify_output ? rec.verify_output.stdout + rec.verify_output.stderr : "";
    if (v.trim() !== "") console.error("  verify 输出(截断 800 字符): " + v.slice(0, 800).replace(/\n/g, " | "));
  }
}

// ---------- 模式实现 ----------

function resolveRoot(args, dflt) {
  const root = args.root ? path.resolve(REPO_ROOT, args.root) : path.resolve(REPO_ROOT, dflt);
  mkdirSync(root, { recursive: true });
  return root;
}

function optsFrom(args) {
  return {
    tsenv: args.tsenv ? path.resolve(REPO_ROOT, args.tsenv) : null,
    tscCmd: typeof args["tsc-cmd"] === "string" ? args["tsc-cmd"] : null,
  };
}

function cmdPilot(args) {
  const root = resolveRoot(args, PILOT_ROOT);
  const opts = optsFrom(args);
  if (opts.tsenv && !existsSync(path.join(opts.tsenv, "node_modules", "typescript", "bin", "tsc"))) {
    console.error(`警告: --tsenv 布局未就绪(${relToRepo(opts.tsenv)}),TS 静态检查将记 unavailable`);
  }
  console.log("== T1.2-b 试点采集(预注册 docs/experiment-design.md §5;被测提交 = solutions 参考实现,source=solutions-pilot,不进正式样本) ==");
  console.log(`root: ${relToRepo(root)}`);
  writeFileSync(path.join(root, "results.jsonl"), ""); // 试点重跑幂等:每次清空重写

  // 1. prompt 裁剪冒烟(§8 缺口 6)
  mkdirSync(path.join(root, "prompts"), { recursive: true });
  const bodies = new Map();
  let cropBad = 0;
  for (const task of PILOT_TASKS) {
    for (const langKey of Object.keys(LANGS)) {
      const crop = cropPrompt(task, langKey); // 结构违规直接抛错
      const errs = checkCrop(task, langKey, crop, bodies);
      const out = path.join(root, "prompts", `${task}.${langKey}.md`);
      writeFileSync(out, crop.text);
      if (errs.length === 0) {
        console.log(
          `OK  crop ${task}.${langKey}  ${(Buffer.byteLength(crop.text) / 1024).toFixed(1)}KB  body=${Buffer.byteLength(crop.body)}B  全文=${Buffer.byteLength(crop.full)}B  (crop<全文 ✓ 单语言节 ✓)`
        );
      } else {
        cropBad++;
        console.error(`BAD crop ${task}.${langKey}: ${errs.join("; ")}`);
      }
    }
  }

  // 2. 环境指纹(§8 缺口 7)
  mkdirSync(path.join(root, "feedback"), { recursive: true }); // B-1: 修复轮反馈目录预建(P2-B 实测缺则 ENOENT 崩)
  const env = probeEnv(opts);
  console.log(
    `env: os=${env.os} node=${env.node} python=${env.python} ming_head=${env.ming_head.slice(0, 8)} ming=${env.ming_version} tsc=${env.tsc}`
  );

  // 3. 正例腿:2 任务 × 3 语言 × 3 run(solutions 为被测提交)
  const records = [];
  for (const task of PILOT_TASKS) {
    for (const langKey of Object.keys(LANGS)) {
      for (const runNo of PILOT_RUNS) {
        const runId = `${task}-${langKey}-r${runNo}`;
        const rec = runOneLeg({
          root,
          task,
          langKey,
          runNo,
          round: 1,
          runId,
          progSrcRel: `${TASKS_DIR}/${task}/solutions/solution.${LANGS[langKey].ext}`,
          source: "solutions-pilot",
          expect: "pass",
          pilot: true,
          env,
          opts,
          note: "试点正例腿:被测提交 = 语料参考实现(流程验证,非生成质量样本)",
        });
        records.push(rec);
        printLeg(rec);
      }
    }
  }

  // 4. 负例腿:交叉喂入另一任务参考实现,预期 FAIL(验证 FAIL 记录与反馈回路;非样本)
  for (const task of PILOT_TASKS) {
    for (const langKey of Object.keys(LANGS)) {
      const other = task === "a1_log_clean" ? "c2_timeout_fallback" : "a1_log_clean";
      const runId = `${task}-${langKey}-neg`;
      const rec = runOneLeg({
        root,
        task,
        langKey,
        runNo: 0,
        round: 1,
        runId,
        progSrcRel: `${TASKS_DIR}/${other}/solutions/solution.${LANGS[langKey].ext}`,
        source: "solutions-pilot-negative-control",
        expect: "fail",
        pilot: true,
        env,
        opts,
        note: `负例腿:交叉喂入 ${other} 参考实现(设计 §8 验收有效性抽查形态),预期 FAIL;非样本`,
      });
      records.push(rec);
      printLeg(rec);
    }
  }

  // 5. 反馈回路(§8 缺口 5):全部非 PASS 腿渲染反馈文件(PASS 腿无反馈轮)。
  //    登记:env_blocked 腿(verify_result === "ENV_BLOCKED")今日不可达——PILOT_TASKS 固定
  //    a1/c2 不涉端口;若未来进入 pilot 任务集,需与 cmdRecord 同口径跳过反馈渲染。
  mkdirSync(path.join(root, "feedback"), { recursive: true });
  let fbCount = 0;
  for (const rec of records) {
    if (rec.verify_result !== "PASS") {
      writeFileSync(path.join(root, "feedback", `${rec.run_id}.round${rec.round}.txt`), renderFeedback(rec));
      fbCount++;
    }
  }

  // 6. 汇总矩阵
  const rows = buildMatrix(records);
  writeFileSync(
    path.join(root, "matrix.json"),
    JSON.stringify({ mode: "pilot", generated_at: new Date().toISOString(), root: relToRepo(root), env, rows }, null, 2) + "\n"
  );
  printMatrix(rows);

  // 7. 总结与退出码
  const pos = records.filter((r) => r.expect === "pass");
  const neg = records.filter((r) => r.expect === "fail");
  const posOk = pos.filter((r) => r.as_expected).length;
  const negOk = neg.filter((r) => r.as_expected).length;
  const scUnavail = records.filter((r) => r.static_check && r.static_check.status === "unavailable").length;
  const envBlocked = records.filter((r) => r.env_blocked).length;
  console.log("");
  console.log(`== 试点汇总 ==`);
  console.log(`crops: ${PILOT_TASKS.length * 3 - cropBad}/${PILOT_TASKS.length * 3} OK`);
  console.log(`正例腿(预期 PASS): ${posOk}/${pos.length}`);
  console.log(`负例腿(预期 FAIL): ${negOk}/${neg.length}`);
  console.log(`env_blocked 腿: ${envBlocked}(端口预检失败,不计入样本统计)`);
  console.log(`静态检查 unavailable 腿: ${scUnavail}(非门槛,如实记录)`);
  console.log(`反馈文件: ${fbCount} 个 -> ${relToRepo(path.join(root, "feedback"))}/`);
  const green = cropBad === 0 && posOk === pos.length && negOk === neg.length;
  console.log(green ? "PILOT GREEN" : "PILOT NOT GREEN(存在偏差,见上方 BAD 行与 results.jsonl)");
  return green ? 0 : 1;
}

function cmdRecord(args) {
  // m-3:参数校验先于目录创建(无效调用不建 results/)
  const taskPre = typeof args.task === "string" ? args.task : null;
  const langPre = typeof args.language === "string" ? LANG_ALIASES[args.language] : null;
  const runPre = Number.parseInt(String(args.run ?? ""), 10);
  const roundPre = Number.parseInt(String(args.round ?? "1"), 10);
  const progPre = typeof args.program === "string" ? args.program : null;
  if (!taskPre || !langPre || !Number.isInteger(runPre) || !Number.isInteger(roundPre) || !progPre) {
    throw new Error("--record 需要 --task <id> --language ming|typescript|python --run N --program <路径>(--round 缺省 1)");
  }
  const root = resolveRoot(args, FORMAL_ROOT);
  const opts = optsFrom(args);
  const task = typeof args.task === "string" ? args.task : null;
  const langKey = typeof args.language === "string" ? LANG_ALIASES[args.language] : null;
  const runNo = Number.parseInt(String(args.run ?? ""), 10);
  const round = Number.parseInt(String(args.round ?? "1"), 10);
  const program = typeof args.program === "string" ? args.program : null;
  if (!task || !langKey || !Number.isInteger(runNo) || !Number.isInteger(round) || !program) {
    throw new Error("--record 需要 --task <id> --language ming|typescript|python --run N --program <路径>(--round 缺省 1)");
  }
  if (!existsSync(path.join(REPO_ROOT, TASKS_DIR, task, "prompt.md"))) throw new Error(`任务不存在: ${task}`);
  const progAbs = path.resolve(REPO_ROOT, program);
  if (!existsSync(progAbs)) throw new Error(`被测程序不存在: ${program}`);
  const expectRaw = typeof args.expect === "string" ? args.expect : "pass";
  if (expectRaw !== "pass" && expectRaw !== "fail") throw new Error(`--expect 仅接受 pass|fail,got: ${expectRaw}`); // m-3:拼写错静默当 pass
  const expect = expectRaw;
  const env = probeEnv(opts);
  const rec = runOneLeg({
    root,
    task,
    langKey,
    runNo,
    round,
    runId: typeof args["run-id"] === "string" ? args["run-id"] : `${task}-${langKey}-r${runNo}`,
    progSrcRel: relToRepo(progAbs),
    source: typeof args.source === "string" ? args.source : "generation",
    expect,
    pilot: false,
    env,
    opts,
    model: typeof args.model === "string" ? args.model : null,
    temperature: args.temperature !== undefined ? Number(args.temperature) : null,
    tokensP: args["prompt-tokens"] !== undefined ? Number(args["prompt-tokens"]) : null,
    tokensC: args["completion-tokens"] !== undefined ? Number(args["completion-tokens"]) : null,
    note: typeof args.note === "string" ? args.note : "",
  });
  printLeg(rec);
  if (rec.env_blocked) {
    console.error(`env_blocked: 该格未进入 verify(端口预检拦截),无反馈文件;不计入样本统计`);
  } else if (rec.verify_result !== "PASS") {
    mkdirSync(path.join(root, "feedback"), { recursive: true }); // B-1 同款:record 路径反馈目录预建(实测 b3 交叉腿 FAIL 时 ENOENT 崩——HEAD 预存缺陷,cmdPilot 有预建而 cmdRecord 漏,顺手收口)
    writeFileSync(path.join(root, "feedback", `${rec.run_id}.round${rec.round}.txt`), renderFeedback(rec));
    console.log(`反馈文件: ${relToRepo(path.join(root, "feedback", `${rec.run_id}.round${rec.round}.txt`))}`);
  }
  console.log(`JSONL: ${relToRepo(path.join(root, "results.jsonl"))}`);
  return rec.as_expected ? 0 : 1;
}

function cmdPrompt(args) {
  const pos = args._;
  if (pos.length < 2) throw new Error("--prompt 需要 <task> <language>(language 可用 ming|ts|typescript|py|python)");
  const task = pos[0];
  const langKey = LANG_ALIASES[pos[1]];
  if (!langKey) throw new Error(`未知语言: ${pos[1]}`);
  const crop = cropPrompt(task, langKey);
  const errs = checkCrop(task, langKey, crop, new Map());
  if (errs.length > 0) throw new Error(`裁剪自检失败: ${errs.join("; ")}`);
  if (typeof args.out === "string") {
    const outAbs = path.resolve(REPO_ROOT, args.out);
    mkdirSync(path.dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, crop.text);
    console.log(`prompt -> ${relToRepo(outAbs)} (${Buffer.byteLength(crop.text)} B;正文 ${Buffer.byteLength(crop.body)} B;全文 ${Buffer.byteLength(crop.full)} B)`);
  } else {
    process.stdout.write(crop.text);
  }
  return 0;
}

function readRoot(args, dflt) {
  // 只读模式(matrix/feedback):不建目录;结果文件不存在即报错
  const root = args.root ? path.resolve(REPO_ROOT, args.root) : path.resolve(REPO_ROOT, dflt);
  const jsonl = path.join(root, "results.jsonl");
  if (!existsSync(jsonl)) throw new Error(`无结果文件: ${relToRepo(jsonl)}`);
  return root;
}

function cmdMatrix(args) {
  const root = readRoot(args, args.pilot ? PILOT_ROOT : FORMAL_ROOT);
  const jsonl = path.join(root, "results.jsonl");
  const records = readFileSync(jsonl, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
  if (records.length === 0) throw new Error(`结果文件为空: ${relToRepo(jsonl)}`);
  const rows = buildMatrix(records);
  writeFileSync(
    path.join(root, "matrix.json"),
    JSON.stringify({ mode: "matrix", generated_at: new Date().toISOString(), root: relToRepo(root), records: records.length, rows }, null, 2) + "\n"
  );
  printMatrix(rows);
  console.log(`matrix.json -> ${relToRepo(path.join(root, "matrix.json"))} (${records.length} 条记录)`);
  return 0;
}

function cmdFeedback(args) {
  const runId = args._[0];
  if (!runId) throw new Error("--feedback 需要 <run_id>");
  const root = readRoot(args, args.pilot ? PILOT_ROOT : FORMAL_ROOT);
  const jsonl = path.join(root, "results.jsonl");
  const lines = readFileSync(jsonl, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const hits = lines.filter((r) => r.run_id === runId);
  if (hits.length === 0) throw new Error(`run_id 不存在: ${runId}`);
  const rec = hits[hits.length - 1]; // 同 run_id 多轮时取最后一轮
  const text = renderFeedback(rec);
  if (typeof args.out === "string") {
    const outAbs = path.resolve(REPO_ROOT, args.out);
    mkdirSync(path.dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, text);
    console.log(`feedback -> ${relToRepo(outAbs)}`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

function cmdEnv(args) {
  const env = probeEnv(optsFrom(args));
  console.log(JSON.stringify(env, null, 2));
  return 0;
}

// ---------- 入口 ----------

function usage() {
  console.log(
    [
      "用法: node tests/experiment/run.mjs <模式> [选项]",
      "  --pilot     T1.2-b 试点(a1+c2 × 3 语言 × 3 run;输出 .zcode/exp-pilot)",
      "  --record    单次 verify 事件采集(生成批接口;详见文件头注释)",
      "  --prompt    <task> <language> 组装裁剪 prompt(§8 缺口 6)",
      "  --matrix    任务×语言汇总矩阵",
      "  --feedback  <run_id> 修复轮反馈模板(§8 缺口 5)",
      "  --env       环境指纹(§8 缺口 7)",
    ].join("\n")
  );
}

export function main(argv) {
  const mode = argv[0];
  const rest = argv.slice(1);
  // 位置参数解析:--flag value / --flag=value / 裸位置入 _;布尔模式旗标后随值需显式
  const args = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          args[key] = next;
          i++;
        } else {
          args[key] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  switch (mode) {
    case "--pilot":
      return cmdPilot(args);
    case "--record":
      return cmdRecord(args);
    case "--prompt":
      return cmdPrompt(args);
    case "--matrix":
      return cmdMatrix(args);
    case "--feedback":
      return cmdFeedback(args);
    case "--env":
      return cmdEnv(args);
    default:
      usage();
      return mode === "--help" || mode === "-h" ? 0 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error("错误: " + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  }
}
