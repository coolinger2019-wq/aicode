// B4 黑盒验收(JS,ESM):启动被测 .ts 服务,轮询就绪,发送固定请求矩阵,
// transcript 与 expected 逐字节比对,关停服务。
// 用法(从仓库根):node tests/experiment/tasks/b4_serve_handler/verify.js [被测程序路径]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, "..", "..", "..", "..");

const MATRIX = [
  { method: "GET", path: "/ping", body: "" },
  { method: "POST", path: "/sum", body: JSON.stringify({ nums: [1, 2, 3, 4] }) },
  { method: "POST", path: "/sum", body: JSON.stringify({ nums: [] }) },
  { method: "POST", path: "/sum", body: JSON.stringify({ nums: "x" }) },
  { method: "POST", path: "/sum", body: "notjson" },
  { method: "GET", path: "/deep/path", body: "" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const prog = process.argv[2]
    ? path.resolve(repoRoot, process.argv[2])
    : path.join(taskDir, "solutions", "solution.ts");
  const expected = readFileSync(path.join(taskDir, "expected", "expected.txt"), "utf8");
  for (let i = 0; i < 10; i++) {
    const port = 21241 + i * 7;
    const child = spawn("node", [prog, String(port)], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    const deadline = Date.now() + 6000;
    let up = false;
    while (Date.now() < deadline) {
      await sleep(150);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/ping`);
        if (r.status === 200) {
          up = true;
          break;
        }
      } catch {}
    }
    if (!up) {
      child.kill();
      await sleep(200);
      continue;
    }
    const lines = [];
    for (let k = 0; k < MATRIX.length; k++) {
      const m = MATRIX[k];
      try {
        const r = await fetch(`http://127.0.0.1:${port}${m.path}`, {
          method: m.method,
          body: m.body === "" ? undefined : m.body,
        });
        const t = await r.text();
        lines.push(`R${k + 1} -> ${r.status} ${t}`);
      } catch (e) {
        const code = e && e.cause && e.cause.code ? e.cause.code : String(e);
        lines.push(`R${k + 1} -> ERR ${code}`);
      }
    }
    child.kill();
    const actual = lines.join("\n") + "\n";
    if (actual !== expected) {
      console.error(
        "FAIL transcript mismatch actual_len=" + actual.length + " expected_len=" + expected.length
      );
      process.exitCode = 1;
      return 1;
    }
    console.log("PASS");
    process.exitCode = 0;
    return 0;
  }
  console.error("FAIL 服务无法启动");
  process.exitCode = 1;
  return 1;
}

void main();
