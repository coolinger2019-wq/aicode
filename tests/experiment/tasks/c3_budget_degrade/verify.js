// C3 黑盒验收(JS,ESM):运行被测 .ts 程序(无参数),stdout 与 expected 逐字节比对。
// 用法(从仓库根):node tests/experiment/tasks/c3_budget_degrade/verify.js [被测程序路径]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, "..", "..", "..", "..");

function main() {
  const prog = process.argv[2]
    ? path.resolve(repoRoot, process.argv[2])
    : path.join(taskDir, "solutions", "solution.ts");
  const expected = readFileSync(path.join(taskDir, "expected", "expected.txt"), "utf8");
  const r = spawnSync("node", [prog], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
  });
  if (r.error) {
    console.error("FAIL spawn: " + r.error.message);
    return 1;
  }
  if (r.status !== 0) {
    console.error("FAIL exit=" + r.status + "\n" + (r.stderr || ""));
    return 1;
  }
  if (r.stdout !== expected) {
    console.error(
      "FAIL stdout mismatch actual_len=" + r.stdout.length + " expected_len=" + expected.length
    );
    return 1;
  }
  console.log("PASS");
  return 0;
}

process.exit(main());
