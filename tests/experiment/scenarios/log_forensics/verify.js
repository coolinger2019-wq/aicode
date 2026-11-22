// S1 黑盒验收(JS,ESM):运行被测 .ts 程序,stdout 与 report 逐字节比对 + 退出码
// + 负例腿(缺参/不存在路径/交叉喂入 S2 参考实现预期 FAIL,spec §4)。
// 用法(从仓库根):node tests/experiment/scenarios/log_forensics/verify.js [被测程序路径]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, "..", "..", "..", "..");

function runProg(prog, args) {
  return spawnSync("node", [prog, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
  });
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
  return 0;
}

function main() {
  const prog = process.argv[2]
    ? path.resolve(repoRoot, process.argv[2])
    : path.join(taskDir, "solutions", "solution.ts");
  const inPath = "tests/experiment/scenarios/log_forensics/input/main.log";
  const reportOut = ".zcode/exp-s1-verify/report-js.txt";
  mkdirSync(path.join(repoRoot, ".zcode", "exp-s1-verify"), { recursive: true });
  rmSync(path.join(repoRoot, reportOut), { force: true });
  const expectedStdout = readFileSync(path.join(taskDir, "expected", "expected_stdout.txt"), "utf8");
  const expectedReport = readFileSync(path.join(taskDir, "expected", "expected_report.txt"), "utf8");
  const r = runProg(prog, [inPath, reportOut]);
  if (r.error) {
    console.error("FAIL 正例腿 spawn: " + r.error.message);
    return 1;
  }
  if (r.status !== 0) {
    console.error("FAIL 正例腿 exit=" + r.status + "\n" + (r.stderr || ""));
    return 1;
  }
  if (r.stdout !== expectedStdout) {
    console.error(
      `FAIL 正例腿 stdout mismatch actual_len=${r.stdout.length} expected_len=${expectedStdout.length}`
    );
    return 1;
  }
  const report = readFileSync(path.join(repoRoot, reportOut), "utf8");
  if (report !== expectedReport) {
    console.error(
      `FAIL 正例腿 report mismatch actual_len=${report.length} expected_len=${expectedReport.length}`
    );
    return 1;
  }
  if (expectParamError("负例-缺参", runProg(prog, [])) !== 0) {
    return 1;
  }
  if (
    expectParamError(
      "负例-路径不存在",
      runProg(prog, ["tests/experiment/scenarios/log_forensics/input/no_such.log", reportOut])
    ) !== 0
  ) {
    return 1;
  }
  const cross = runProg(path.join(repoRoot, "tests/experiment/scenarios/file_integrity/solutions/solution.ts"), [
    inPath,
    reportOut,
  ]);
  if (cross.error) {
    console.error("FAIL 负例-交叉喂入 spawn: " + cross.error.message);
    return 1;
  }
  if (cross.status === 0 && cross.stdout === expectedStdout) {
    console.error("FAIL 负例-交叉喂入: S2 参考实现竟通过 S1 验收");
    return 1;
  }
  console.log("PASS");
  return 0;
}

process.exit(main());
