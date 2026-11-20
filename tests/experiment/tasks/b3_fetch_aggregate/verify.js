// B3 黑盒验收(JS,ESM):启动 mock 源,轮询 ready 文件取端口,运行被测 .ts 程序,
// 关停 mock,stdout 逐字节比对。
// 用法(从仓库根):node tests/experiment/tasks/b3_fetch_aggregate/verify.js [被测程序路径]
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, "..", "..", "..", "..");
const readyPath = path.join(os.tmpdir(), "exp-b3-ready-js.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const prog = process.argv[2]
    ? path.resolve(repoRoot, process.argv[2])
    : path.join(taskDir, "solutions", "solution.ts");
  const expected = readFileSync(path.join(taskDir, "expected", "expected.txt"), "utf8");
  rmSync(readyPath, { force: true });
  const mock = spawn("node", [path.join(taskDir, "mock_server.mjs"), "21031", readyPath], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  let ports = null;
  for (let i = 0; i < 60 && !ports; i++) {
    await sleep(100);
    if (existsSync(readyPath)) {
      const parts = readFileSync(readyPath, "utf8")
        .trim()
        .split(/\s+/)
        .map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)) {
        ports = parts;
      }
    }
  }
  if (!ports) {
    mock.kill();
    console.error("FAIL mock 服务器未就绪");
    return 1;
  }
  const urls = [
    `http://127.0.0.1:${ports[0]}/source1`,
    `http://127.0.0.1:${ports[1]}/source2`,
    `http://127.0.0.1:${ports[2]}/source3`,
    `http://127.0.0.1:${ports[0]}/missing`,
  ];
  const r = spawnSync("node", [prog, ...urls], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
  });
  mock.kill();
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

main().then((c) => process.exit(c));
