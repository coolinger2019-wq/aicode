// B4 服务生命周期 harness(单一实现;Ming 腿 verify 专用——Ming 无外部进程 kill 能力)。
// 用法: node harness.mjs <base_port> <prog_cmd...>
//   prog_cmd = 启动服务程序的命令片段,harness 把实际端口作为最后一个参数追加。
// 行为:端口从 base_port 起 +7 重试(≤10);启动服务;轮询 GET /ping 直到 200(≤6s);
// 发送固定请求矩阵;打印 transcript(R1..R6)到 stdout;硬杀服务进程。
// 退出码:0 = transcript 完整;2 = 服务无法启动(harness 失败)。
import { spawn } from "node:child_process";

const base = parseInt(process.argv[2] || "21241", 10);
const cmd = process.argv.slice(3);
if (cmd.length === 0) {
  console.error("harness: 需要 <base_port> <prog_cmd...> 参数");
  process.exit(2);
}

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
  for (let i = 0; i < 10; i++) {
    const port = base + i * 7;
    const child = spawn(cmd[0], [...cmd.slice(1), String(port)], {
      cwd: process.cwd(),
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
    for (const l of lines) {
      console.log(l);
    }
    process.exitCode = 0; // v0.97 审查 m-3:自然退出——管道异步写 + 强退可能截断 transcript(被测 TS 程序同规)
    return; // v0.97 审查 B-2:成功路径显式返回——此前无 return,落到失败路径输出"服务无法启动"+exit 2(b4 ming 验收腿因此 FAIL)
  }
  console.error("harness: 服务无法启动");
  process.exitCode = 2;
}

main();
