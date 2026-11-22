// S4 内网 agent 工具服务 — 参考实现(TypeScript + Node 24 类型剥离直执行)
// node:http 骨架显式复刻 ming serve 的服务层行为(spec §3.3,行为黑盒一致):
// 体上限前置检查(声明 Content-Length > 上限 → 413 {"code":"body_too_large",…},
// handler 不执行)、handler 异常捕获(→ 500 {"code":"handler_panic",…},M 码等价面
// 不复刻——message 不参与验收)。应用判定序 = 路由层(第 0 条)先于编号 1–6,首条命中
// 即停(spec §3.1);应用标签集与响应体字节形与 Ming 逐字一致(紧凑 JSON,键序构造序)。
// 长驻服务不得在 listen 后调用 process.exit(环境地雷:Node 24 win32 fetch/exit 崩);
// 发起过 fetch 的程序以 process.exitCode + 自然退出收尾。
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

const BODY_LIMIT = 8388608; // 与 ming serve 现行值同形(参数值非承诺面)
const OVERSIZE = JSON.stringify({ code: "body_too_large", message: "请求体超过 8MB 上限" });
const PANIC = JSON.stringify({ code: "handler_panic", message: "handler 异常" });

function appErr(label: string): string {
  return JSON.stringify({ ok: false, code: label });
}

function appResultNum(n: number): string {
  return JSON.stringify({ ok: true, result: n });
}

function appResultStr(s: string): string {
  return JSON.stringify({ ok: true, result: s });
}

// 码点计数(char_len 口径,含非 ASCII;surrogate pair 计 1)——ES5 兼容形态,
// 不用字符串展开(tsc --strict 缺省 target 下 TS2802)
function codePointLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 1;
        i += 1;
        continue;
      }
    }
    n += 1;
  }
  return n;
}

function send(res: ServerResponse, status: number, body: string, close: boolean): void {
  res.writeHead(status, { "content-type": "application/json", ...(close ? { connection: "close" } : {}) });
  res.end(body);
}

function toolSum(args: Record<string, unknown>, res: ServerResponse): void {
  if (!("a" in args) || !("b" in args)) {
    send(res, 400, appErr("missing_field"), false);
    return;
  }
  const af = args.a;
  const bf = args.b;
  if (typeof af !== "number" || typeof bf !== "number") {
    send(res, 400, appErr("bad_args"), false);
    return;
  }
  const ai = Math.trunc(af);
  if (ai !== af) {
    send(res, 400, appErr("bad_args"), false);
    return;
  }
  const bi = Math.trunc(bf);
  if (bi !== bf) {
    send(res, 400, appErr("bad_args"), false);
    return;
  }
  send(res, 200, appResultNum(ai + bi), false);
}

function toolCount(args: Record<string, unknown>, res: ServerResponse): void {
  if (!("text" in args)) {
    send(res, 400, appErr("missing_field"), false);
    return;
  }
  const text = args.text;
  if (typeof text !== "string") {
    send(res, 400, appErr("bad_args"), false);
    return;
  }
  send(res, 200, appResultNum(codePointLen(text)), false);
}

function toolPath(args: Record<string, unknown>, res: ServerResponse): void {
  if (!("path" in args)) {
    send(res, 400, appErr("missing_field"), false);
    return;
  }
  const p = args.path;
  if (typeof p !== "string") {
    send(res, 400, appErr("bad_args"), false);
    return;
  }
  // sanitize_path 等价判定:拒绝空串/绝对路径(含盘符)/.. 段/内部空段;判定结果恒 "ok"
  if (isRelativeCleanPath(p)) {
    send(res, 200, appResultStr("ok"), false);
  } else {
    send(res, 400, appErr("bad_args"), false);
  }
}

// std.unstr.sanitize_path 判定面复刻(fixture 触达形态:report.txt 放行;
// ../etc/passwd 与 C:/temp 拒绝;规范化细节不进验收触达面,spec §3.1 粒度条款)
function isRelativeCleanPath(p: string): boolean {
  if (p === "") return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(p)) return false; // 盘符(含 C:x 形态)即绝对
  const segs = p.split(/[\\/]/);
  for (const seg of segs) {
    if (seg === "..") return false;
    if (segs.length > 1 && seg === "") return false; // 内部空段(尾随分隔符容忍剥除)
  }
  return true;
}

function handleTool(body: string, res: ServerResponse): void {
  // 1. 空体/坏 JSON → bad_json
  if (body === "") {
    send(res, 400, appErr("bad_json"), false);
    return;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    send(res, 400, appErr("bad_json"), false);
    return;
  }
  // 2. 根非对象 → bad_json
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    send(res, 400, appErr("bad_json"), false);
    return;
  }
  const obj = doc as Record<string, unknown>;
  // 3. tool 缺失 → missing_field;非 str → bad_args
  if (!("tool" in obj)) {
    send(res, 400, appErr("missing_field"), false);
    return;
  }
  const tool = obj.tool;
  if (typeof tool !== "string") {
    send(res, 400, appErr("bad_args"), false);
    return;
  }
  // 4. args 缺失 → missing_field;非对象 → bad_args
  if (!("args" in obj)) {
    send(res, 400, appErr("missing_field"), false);
    return;
  }
  const args = obj.args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    send(res, 400, appErr("bad_args"), false);
    return;
  }
  const argObj = args as Record<string, unknown>;
  // 5. 工具名 ∈ 已知集;否则 404 unknown_tool
  if (tool === "sum") {
    toolSum(argObj, res);
    return;
  }
  if (tool === "count") {
    toolCount(argObj, res);
    return;
  }
  if (tool === "path_check") {
    toolPath(argObj, res);
    return;
  }
  if (tool === "boom") {
    // 6. boom:无条件 handler 内异常 → 500 handler_panic(服务层捕获,服务不死)
    throw new Error("boom");
  }
  send(res, 404, appErr("unknown_tool"), false);
}

function route(req: IncomingMessage, res: ServerResponse, body: string): void {
  const method = (req.method || "GET").toUpperCase();
  const path = (req.url || "/").split("?")[0];
  // 0. 路由层:/tool 非 POST 或 /health 非 GET → 405;其余路径 → 404 not_found
  if (path === "/tool") {
    if (method === "POST") {
      handleTool(body, res);
      return;
    }
    send(res, 405, appErr("method_not_allowed"), false);
    return;
  }
  if (path === "/health") {
    if (method === "GET") {
      send(res, 200, JSON.stringify({ ok: true }), false);
      return;
    }
    send(res, 405, appErr("method_not_allowed"), false);
    return;
  }
  send(res, 404, appErr("not_found"), false);
}

function main(): number {
  const raw = process.argv[2] || "";
  const port = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    console.error("error: 端口参数非法(需 1..65535)");
    return 1;
  }
  const server = createServer((req, res) => {
    // 体上限前置检查(声明尺寸;handler 不执行)——ming serve 同款早响应形态;
    // 头-only 客户端(GAP-S4-1)无未消费体,连接干净关闭
    const cl = Number(req.headers["content-length"]);
    if (Number.isFinite(cl) && cl > BODY_LIMIT) {
      send(res, 413, OVERSIZE, true);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        route(req, res, Buffer.concat(chunks).toString("utf8"));
      } catch {
        if (!res.headersSent) send(res, 500, PANIC, true);
        else res.destroy();
      }
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
