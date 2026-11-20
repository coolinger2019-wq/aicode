// A3 黑盒验收(JS,ESM):运行被测 .ts 程序,stdout 与 expected 逐字节比对 + 退出码。
// 用法(从仓库根):node tests/experiment/tasks/a3_csv_to_json/verify.js [被测程序路径]
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
  const taskArgs = ["tests/experiment/tasks/a3_csv_to_json/input/input.csv"];
  const r = spawnSync("node", [prog, ...taskArgs], {
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
