// B4 serve handler — 参考实现(TypeScript + Node 24)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const BAD = '{"code":"bad_request"}';
const NOT_FOUND = '{"code":"not_found"}';

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function handleSum(body: string, res: ServerResponse): void {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    send(res, 400, BAD);
    return;
  }
  if (typeof doc !== "object" || doc === null) {
    send(res, 400, BAD);
    return;
  }
  const nums = (doc as { nums?: unknown }).nums;
  if (!Array.isArray(nums) || !nums.every((x) => typeof x === "number")) {
    send(res, 400, BAD);
    return;
  }
  const total = nums.reduce((acc: number, x) => acc + (x as number), 0);
  send(res, 200, `{"sum":${total}}`);
}

function route(req: IncomingMessage, res: ServerResponse, body: string): void {
  const method = (req.method || "GET").toUpperCase();
  const urlPath = (req.url || "/").split("?")[0];
  if (method === "GET" && urlPath === "/ping") {
    send(res, 200, '{"pong":true}');
    return;
  }
  if (method === "POST" && urlPath === "/sum") {
    handleSum(body, res);
    return;
  }
  send(res, 404, NOT_FOUND);
}

function main(): number {
  const port = parseInt(process.argv[2] || "", 10);
  if (!Number.isFinite(port)) {
    console.error("error: 需要端口参数");
    return 1;
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      route(req, res, Buffer.concat(chunks).toString("utf8"));
    });
  });
  server.on("error", () => {
    console.error("error: 端口绑定失败");
    process.exit(1);
  });
  server.listen(port, "127.0.0.1");
  return 0;
}

const code = main();
if (code !== 0) {
  // 错误路径(未启动监听):立即退出;正常路径由 listen 持住事件循环,进程长驻
  process.exit(code);
}
