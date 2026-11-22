// S3 黑盒验收(JS,ESM):运行被测 .ts 程序,stdout 逐字节比对 + 退出码 + 参数级
// 腿(缺参/不存在/目录/oversize 门禁)+ 负例腿(交叉喂入 S1/S2 参考实现预期 FAIL)
// + 不 panic 专项(spec §4:input/ 全部文件 stderr 无引擎 panic 标记,exit ∈ {0,1})。
// 用法(从仓库根):node tests/experiment/scenarios/protocol_parser/verify.js [被测程序路径]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, "..", "..", "..", "..");
const base = "tests/experiment/scenarios/protocol_parser";

const PANIC_MARKERS = ["panic", "内部错误", "RangeError", "TypeError", "Traceback"];

function runProg(prog, args) {
  return spawnSync("node", [prog, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
  });
}

function noPanicMarkers(stderr) {
  return !PANIC_MARKERS.some((m) => stderr.includes(m));
}

function expectRun(tag, prog, arg, wantExit, expected) {
  const r = runProg(prog, [arg]);
  if (r.error) {
    console.error(`FAIL ${tag}: spawn: ${r.error.message}`);
    return 1;
  }
  if (r.status !== wantExit) {
    console.error(`FAIL ${tag}: exit=${r.status}(预期 ${wantExit})\n${r.stderr || ""}`);
    return 1;
  }
  if (r.stdout !== expected) {
    console.error(
      `FAIL ${tag}: stdout mismatch actual_len=${r.stdout.length} expected_len=${expected.length}`
    );
    return 1;
  }
  if (!noPanicMarkers(r.stderr || "")) {
    console.error(`FAIL ${tag}: stderr 含引擎 panic 标记`);
    return 1;
  }
  return 0;
}

function expectParamError(tag, r) {
  if (r.error) {
    console.error(`FAIL ${tag}: spawn: ${r.error.message}`);
    return 1;
  }
  if (r.status !== 1) {
    console.error(`FAIL ${tag}: exit=${r.status}(预期 1)\n${r.stderr || ""}`);
    return 1;
  }
  if (r.stdout !== "") {
    console.error(`FAIL ${tag}: stdout 非空(预期空)`);
    return 1;
  }
  if (!r.stderr.startsWith("error:")) {
    console.error(`FAIL ${tag}: stderr 未以 error: 开头`);
    return 1;
  }
  if (!noPanicMarkers(r.stderr || "")) {
    console.error(`FAIL ${tag}: stderr 含引擎 panic 标记`);
    return 1;
  }
  return 0;
}

function noPanicSweep(tag, prog, files) {
  for (const f of files) {
    const r = runProg(prog, [f]);
    if (r.error) {
      console.error(`FAIL ${tag}: ${f} spawn: ${r.error.message}`);
      return 1;
    }
    if (r.status !== 0 && r.status !== 1) {
      console.error(`FAIL ${tag}: ${f} exit=${r.status}(预期 0/1)\n${r.stderr || ""}`);
      return 1;
    }
    if (!noPanicMarkers(r.stderr || "")) {
      console.error(`FAIL ${tag}: ${f} stderr 含引擎 panic 标记`);
      return 1;
    }
  }
  return 0;
}

function main() {
  const prog = process.argv[2]
    ? path.resolve(repoRoot, process.argv[2])
    : path.join(taskDir, "solutions", "solution.ts");
  const exp = (name) => readFileSync(path.join(taskDir, "expected", name), "utf8");
  const eFrames = exp("expected_frames_stdout.txt");
  const eClean = exp("expected_clean_stdout.txt");
  const eEmpty = exp("expected_empty_stdout.txt");
  const eBadutf8 = exp("expected_badutf8_stdout.txt");

  // 正例腿 1–4:逐字节 + 退出码
  if (expectRun("正例-frames", prog, `${base}/input/frames.hex`, 1, eFrames) !== 0) return 1;
  if (expectRun("正例-clean", prog, `${base}/input/clean.hex`, 0, eClean) !== 0) return 1;
  if (expectRun("正例-empty", prog, `${base}/input/empty.hex`, 0, eEmpty) !== 0) return 1;
  if (expectRun("正例-badutf8", prog, `${base}/input/bad_utf8.bin`, 1, eBadutf8) !== 0) return 1;

  // 参数级腿 5–8
  mkdirSync(path.join(repoRoot, ".zcode", "exp-s3-verify"), { recursive: true });
  if (expectParamError("参数-oversize", runProg(prog, [`${base}/input/oversize.hex`])) !== 0) return 1;
  if (expectParamError("参数-缺参", runProg(prog, [])) !== 0) return 1;
  if (expectParamError("参数-路径不存在", runProg(prog, [`${base}/input/no_such.bin`])) !== 0) return 1;
  if (expectParamError("参数-目录输入", runProg(prog, [`${base}/input`])) !== 0) return 1;

  // 负例腿 9:交叉喂入 S1/S2 参考实现 → 不得以期望输出成功
  const crossTargets = [
    "tests/experiment/scenarios/log_forensics/solutions/solution.ts",
    "tests/experiment/scenarios/file_integrity/solutions/solution.ts",
  ];
  for (const ct of crossTargets) {
    const cross = runProg(path.join(repoRoot, ct), [`${base}/input/frames.hex`, ".zcode/exp-s3-verify/cross_report_js.txt"]);
    if (cross.error) {
      console.error(`FAIL 负例-交叉喂入 spawn(${ct}): ${cross.error.message}`);
      return 1;
    }
    if (cross.status === 0 && cross.stdout === eFrames) {
      console.error(`FAIL 负例-交叉喂入: ${ct} 竟通过 S3 验收`);
      return 1;
    }
  }

  // 不 panic 专项(硬验收):input/ 全部 5 文件
  const sweep = [
    `${base}/input/frames.hex`,
    `${base}/input/clean.hex`,
    `${base}/input/empty.hex`,
    `${base}/input/bad_utf8.bin`,
    `${base}/input/oversize.hex`,
  ];
  if (noPanicSweep("不panic专项", prog, sweep) !== 0) return 1;
  console.log("PASS");
  return 0;
}

process.exit(main());
