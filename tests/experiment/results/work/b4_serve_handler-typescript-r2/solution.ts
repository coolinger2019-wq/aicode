// serve handler —— 固定路由 HTTP 服务（Node 24 + node:http，零依赖，单文件）
// 路由：
//   GET  /ping -> 200 {"pong":true}
//   POST /sum  （body 为 JSON 对象且 nums 为数组且全为数值）-> 200 {"sum":<整数和>}
//   POST /sum  其他形态 -> 400 {"code":"bad_request"}
//   其余任何方法与路径 -> 404 {"code":"not_found"}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PONG_BODY = '{"pong":true}';
const BAD_REQUEST_BODY = '{"code":"bad_request"}';
const NOT_FOUND_BODY = '{"code":"not_found"}';

function sendJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => {
      resolve(data);
    });
    req.on("error", (err: Error) => {
      reject(err);
    });
  });
}

// 校验 body 形态并返回整数数组（元素按整数语义截断）；不满足规则返回 null。
function extractNums(raw: string): number[] | null {
  if (raw.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const numsValue = obj["nums"];
  if (!Array.isArray(numsValue)) {
    return null;
  }
  const list: unknown[] = numsValue;
  const nums: number[] = [];
  for (const element of list) {
    if (typeof element !== "number" || !Number.isFinite(element)) {
      return null;
    }
    nums.push(Math.trunc(element));
  }
  return nums;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method: string = req.method ?? "";
  const url: string = req.url ?? "/";
  const qIndex: number = url.indexOf("?");
  const path: string = qIndex >= 0 ? url.slice(0, qIndex) : url;

  if (method === "GET" && path === "/ping") {
    req.resume();
    sendJson(res, 200, PONG_BODY);
    return;
  }

  if (method === "POST" && path === "/sum") {
    let nums: number[] | null = null;
    try {
      nums = extractNums(await readBody(req));
    } catch {
      nums = null;
    }
    if (nums === null) {
      sendJson(res, 400, BAD_REQUEST_BODY);
      return;
    }
    let total = 0;
    for (const n of nums) {
      total += n;
    }
    sendJson(res, 200, `{"sum":${total}}`);
    return;
  }

  req.resume();
  sendJson(res, 404, NOT_FOUND_BODY);
}

function parsePortArg(raw: string | undefined): number | null {
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

function startServer(port: number): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    res.on("error", () => {
      // 客户端提前断开等写错误：忽略，不让进程崩溃
    });
    handle(req, res).catch(() => {
      res.destroy();
    });
  });
  server.on("error", (err: Error): void => {
    process.stderr.write(`error: ${err.message}\n`, () => {
      process.exit(1);
    });
  });
  server.listen(port, "127.0.0.1");
}

const port = parsePortArg(process.argv[2]);
if (port === null) {
  process.stderr.write("error: invalid or missing port argument\n", () => {
    process.exit(1);
  });
} else {
  startServer(port);
}
