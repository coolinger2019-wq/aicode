// b4_serve_handler —— TypeScript + Node 标准库(node:http)实现
// 长驻 HTTP 服务:按固定规则把请求映射到响应;绑定失败时向 stderr 输出 error: 开头消息并以退出码 1 结束。
import * as http from "node:http";

function send(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req: http.IncomingMessage, cb: (body: string) => void): void {
  const chunks: Buffer[] = [];
  let done = false;
  const finish = (s: string): void => {
    if (!done) {
      done = true;
      cb(s);
    }
  };
  req.on("data", (chunk: Buffer | string): void => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  });
  req.on("end", (): void => {
    finish(Buffer.concat(chunks).toString("utf8"));
  });
  req.on("error", (): void => {
    finish("");
  });
}

function truncInt(x: number): number {
  return x < 0 ? Math.ceil(x) : Math.floor(x);
}

// 返回整数和;形态不合法(非 JSON / 非对象 / nums 缺失或非数组 / 含非数值元素)返回 null
function sumFromBody(body: string): number | null {
  if (body.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  if (!("nums" in rec)) {
    return null;
  }
  const numsValue: unknown = rec["nums"];
  if (!Array.isArray(numsValue)) {
    return null;
  }
  const nums: unknown[] = numsValue;
  let total = 0;
  for (let i = 0; i < nums.length; i += 1) {
    const el: unknown = nums[i];
    if (typeof el !== "number" || !isFinite(el)) {
      return null;
    }
    total += truncInt(el);
  }
  return total;
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
  const method: string = req.method ?? "";
  const rawUrl: string = req.url ?? "/";
  const qIdx: number = rawUrl.indexOf("?");
  const path: string = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;

  if (method === "GET" && path === "/ping") {
    send(res, 200, '{"pong":true}');
    return;
  }
  if (method === "POST" && path === "/sum") {
    const sum: number | null = sumFromBody(body);
    if (sum === null) {
      send(res, 400, '{"code":"bad_request"}');
    } else {
      send(res, 200, '{"sum":' + String(sum) + "}");
    }
    return;
  }
  send(res, 404, '{"code":"not_found"}');
}

function failWith(message: string): void {
  process.stderr.write("error: " + message + "\n");
  process.exit(1);
}

const portArg: string | undefined = process.argv[2];
if (portArg === undefined || !/^-?\d+$/.test(portArg)) {
  failWith("invalid port argument");
}
const port: number = Number(portArg);

const server: http.Server = http.createServer(
  (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.on("error", (): void => {});
    readBody(req, (body: string): void => {
      handle(req, res, body);
    });
  }
);

server.on("error", (err: Error): void => {
  failWith(err.message);
});

try {
  server.listen(port, "127.0.0.1");
} catch (err: unknown) {
  failWith(err instanceof Error ? err.message : String(err));
}
