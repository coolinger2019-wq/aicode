// b4_serve_handler — TypeScript / Node 24（仅 node:http 标准库）
// 监听 127.0.0.1:<端口>，长驻；路由与响应体逐字固定（紧凑 JSON，无空格）。
// 绑定失败：stderr 输出一行以 error: 开头的消息，退出码 1。

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const PONG_BODY = '{"pong":true}';
const BAD_REQUEST_BODY = '{"code":"bad_request"}';
const NOT_FOUND_BODY = '{"code":"not_found"}';

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// POST /sum：合法 → 返回 200 响应体；任何不合法形态 → null（400）。
function sumReply(bodyText: string): string | null {
  if (bodyText === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (!("nums" in obj)) {
    return null;
  }
  const numsValue: unknown = obj["nums"];
  if (!Array.isArray(numsValue)) {
    return null;
  }
  const nums: unknown[] = numsValue;
  let sum = 0;
  for (let i = 0; i < nums.length; i += 1) {
    const el: unknown = nums[i];
    if (typeof el !== "number") {
      return null;
    }
    sum += el;
  }
  return '{"sum":' + String(sum) + "}";
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer): void => {
    chunks.push(chunk);
  });
  req.on("end", (): void => {
    const bodyText: string = Buffer.concat(chunks).toString("utf8");
    const method: string = typeof req.method === "string" ? req.method : "";
    const rawUrl: string = typeof req.url === "string" ? req.url : "";
    const qIndex: number = rawUrl.indexOf("?");
    const path: string = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    if (method === "GET" && path === "/ping") {
      send(res, 200, PONG_BODY);
      return;
    }
    if (method === "POST" && path === "/sum") {
      const reply: string | null = sumReply(bodyText);
      if (reply !== null) {
        send(res, 200, reply);
      } else {
        send(res, 400, BAD_REQUEST_BODY);
      }
      return;
    }
    send(res, 404, NOT_FOUND_BODY);
  });
}

const args: string[] = process.argv.slice(2);
const portRaw: string | undefined = args[0];
if (typeof portRaw !== "string" || !/^\d+$/.test(portRaw)) {
  process.stderr.write("error: expected one numeric port argument\n");
  process.exit(1);
}
const port: number = parseInt(portRaw, 10);
if (port < 1 || port > 65535) {
  process.stderr.write("error: port out of range: " + portRaw + "\n");
  process.exit(1);
}

const server = createServer(handle);
server.on("error", (err: Error): void => {
  process.stderr.write("error: " + err.message + "\n");
  process.exit(1);
});
server.listen(port, "127.0.0.1");
