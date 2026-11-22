// S2 黑盒验收(JS,ESM):gen 腿(stdout + 清单逐字节)+ verify 腿(stdout 逐字节 +
// 预期 exit 1)+ 负例腿(缺参/key 越值域/dir 不存在/清单行被改动/交叉喂入 S1 参考实现)。
// 用法(从仓库根):node tests/experiment/scenarios/file_integrity/verify.js [被测程序路径]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const genDir = "tests/experiment/scenarios/file_integrity/input/gen/files";
  const verifyDir = "tests/experiment/scenarios/file_integrity/input/verify/files";
  const manifest = "tests/experiment/scenarios/file_integrity/input/verify/manifest.txt";
  const key = "integkey2026";
  const genOut = ".zcode/exp-s2-verify/gen_manifest_js.txt";
  mkdirSync(path.join(repoRoot, ".zcode", "exp-s2-verify"), { recursive: true });
  rmSync(path.join(repoRoot, genOut), { force: true });
  const expectedGenStdout = readFileSync(path.join(taskDir, "expected", "expected_gen_stdout.txt"), "utf8");
  const expectedManifest = readFileSync(path.join(taskDir, "expected", "gen_manifest.txt"), "utf8");
  const expectedVerifyStdout = readFileSync(path.join(taskDir, "expected", "expected_verify_stdout.txt"), "utf8");
  // gen 腿:exit 0 + stdout 逐字节 + 清单逐字节
  const g = runProg(prog, ["gen", genDir, genOut, key]);
  if (g.error) {
    console.error("FAIL gen 腿 spawn: " + g.error.message);
    return 1;
  }
  if (g.status !== 0) {
    console.error("FAIL gen 腿 exit=" + g.status + "\n" + (g.stderr || ""));
    return 1;
  }
  if (g.stdout !== expectedGenStdout) {
    console.error(
      `FAIL gen 腿 stdout mismatch actual_len=${g.stdout.length} expected_len=${expectedGenStdout.length}`
    );
    return 1;
  }
  const gotManifest = readFileSync(path.join(repoRoot, genOut), "utf8");
  if (gotManifest !== expectedManifest) {
    console.error(
      `FAIL gen 腿 manifest mismatch actual_len=${gotManifest.length} expected_len=${expectedManifest.length}`
    );
    return 1;
  }
  // all-OK 腿(审查 MINOR-1):gen/files + gen 腿刚产出的清单 → 全 OK → 预期 exit 0,
  // 状态行(每清单名一行 "<name> OK")+ 汇总逐字节。期望输出由期望清单行名推导
  // (fixture 保证清单名合法)。
  const mlinesAllOk = expectedManifest.split("\n");
  if (mlinesAllOk.length > 0 && mlinesAllOk[mlinesAllOk.length - 1] === "") mlinesAllOk.pop();
  const expectedAllOk =
    mlinesAllOk.map((l) => l.split(" ")[0] + " OK").join("\n") +
    "\n" +
    `summary ok=${mlinesAllOk.length} tampered=0 missing=0 rejected=0 extra=0` +
    "\n";
  const ao = runProg(prog, ["verify", genDir, genOut, key]);
  if (ao.error) {
    console.error("FAIL all-OK 腿 spawn: " + ao.error.message);
    return 1;
  }
  if (ao.status !== 0) {
    console.error("FAIL all-OK 腿 exit=" + ao.status + "(预期 0——gen/files 全净且清单吻合)\n" + (ao.stderr || ""));
    return 1;
  }
  if (ao.stdout !== expectedAllOk) {
    console.error(
      `FAIL all-OK 腿 stdout mismatch actual_len=${ao.stdout.length} expected_len=${expectedAllOk.length}`
    );
    return 1;
  }
  // verify 腿:存在篡改 → 预期 exit 1,stdout 逐字节
  const v = runProg(prog, ["verify", verifyDir, manifest, key]);
  if (v.error) {
    console.error("FAIL verify 腿 spawn: " + v.error.message);
    return 1;
  }
  if (v.status !== 1) {
    console.error(`FAIL verify 腿 exit=${v.status}(预期 1——fixture 含篡改)\n` + (v.stderr || ""));
    return 1;
  }
  if (v.stdout !== expectedVerifyStdout) {
    console.error(
      `FAIL verify 腿 stdout mismatch actual_len=${v.stdout.length} expected_len=${expectedVerifyStdout.length}`
    );
    return 1;
  }
  // 负例腿 1:缺参(仅子命令)
  if (expectParamError("负例-缺参", runProg(prog, ["gen"])) !== 0) {
    return 1;
  }
  // 负例腿 2:key 越值域
  if (expectParamError("负例-key越值域", runProg(prog, ["gen", genDir, genOut, "bad_key!"])) !== 0) {
    return 1;
  }
  // 负例腿 3:dir 不存在
  if (
    expectParamError(
      "负例-dir不存在",
      runProg(prog, ["gen", "tests/experiment/scenarios/file_integrity/input/no_such_dir", genOut, key])
    ) !== 0
  ) {
    return 1;
  }
  // 负例腿 4:清单行被改动(合法 hex64,值 ≠ 原)→ exit 1 且 stdout 含 TAMPERED
  const rawManifest = readFileSync(path.join(repoRoot, manifest), "utf8");
  const lines = rawManifest.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const zeros = "0".repeat(64);
  const fakeHex = lines[0].split(" ")[1] === zeros ? "1".repeat(64) : zeros;
  lines[0] = lines[0].split(" ")[0] + " " + fakeHex;
  const tamperedPath = path.join(repoRoot, ".zcode", "exp-s2-verify", "manifest_tampered_js.txt");
  writeFileSync(tamperedPath, lines.join("\n") + "\n", "utf8");
  const t = runProg(prog, ["verify", verifyDir, ".zcode/exp-s2-verify/manifest_tampered_js.txt", key]);
  if (t.error) {
    console.error("FAIL 负例-清单行被改动 spawn: " + t.error.message);
    return 1;
  }
  if (t.status !== 1 || t.stdout === "" || !t.stdout.includes("TAMPERED")) {
    console.error(
      `FAIL 负例-清单行被改动: exit=${t.status}(预期 1 且 stdout 含 TAMPERED)`
    );
    return 1;
  }
  // 负例腿 4b:清单结构损坏(首行只剩文件名,行格式非法)→ exit 1,stdout 空,stderr error:
  const brokenLines = rawManifest.split("\n");
  if (brokenLines.length > 0 && brokenLines[brokenLines.length - 1] === "") brokenLines.pop();
  brokenLines[0] = brokenLines[0].split(" ")[0];
  const brokenPath = path.join(repoRoot, ".zcode", "exp-s2-verify", "manifest_broken_js.txt");
  writeFileSync(brokenPath, brokenLines.join("\n") + "\n", "utf8");
  if (
    expectParamError(
      "负例-清单损坏",
      runProg(prog, ["verify", verifyDir, ".zcode/exp-s2-verify/manifest_broken_js.txt", key])
    ) !== 0
  ) {
    return 1;
  }
  // 负例腿 5:交叉喂入 S1 参考实现 → 预期 FAIL
  const cross = runProg(path.join(repoRoot, "tests/experiment/scenarios/log_forensics/solutions/solution.ts"), [
    "gen",
    genDir,
    genOut,
    key,
  ]);
  if (cross.error) {
    console.error("FAIL 负例-交叉喂入 spawn: " + cross.error.message);
    return 1;
  }
  if (cross.status === 0 && cross.stdout === expectedGenStdout) {
    console.error("FAIL 负例-交叉喂入: S1 参考实现竟通过 S2 gen 验收");
    return 1;
  }
  console.log("PASS");
  return 0;
}

process.exit(main());
