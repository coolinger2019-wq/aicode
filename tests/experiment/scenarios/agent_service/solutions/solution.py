# S4 内网 agent 工具服务 — 参考实现(Python 3.10)
# http.server 骨架显式复刻 ming serve 的服务层行为(spec §3.3,行为黑盒一致):
# 体上限前置检查(声明 Content-Length > 上限 → 413 {"code":"body_too_large",…},
# handler 不执行)、handler 异常捕获(→ 500 {"code":"handler_panic",…},M 码等价面
# 不复刻——message 不参与验收)。应用判定序 = 路由层(第 0 条)先于编号 1–6,首条命中
# 即停(spec §3.1);应用标签集与响应体字节形与 Ming 逐字一致(紧凑 JSON,键序构造序;
# json.dumps separators=(",",":") + dict 插入序)。逐请求 stderr 日志不参与验收(静默)。
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BODY_LIMIT = 8388608  # 与 ming serve 现行值同形(参数值非承诺面)


def app_err(label):
    return json.dumps({"ok": False, "code": label}, separators=(",", ":"), ensure_ascii=False)


def app_result_num(n):
    return json.dumps({"ok": True, "result": n}, separators=(",", ":"), ensure_ascii=False)


def app_result_str(s):
    return json.dumps({"ok": True, "result": s}, separators=(",", ":"), ensure_ascii=False)


def is_relative_clean_path(p):
    # std.unstr.sanitize_path 判定面复刻(fixture 触达形态:report.txt 放行;
    # ../etc/passwd 与 C:/temp 拒绝;规范化细节不进验收触达面,spec §3.1 粒度条款)
    if p == "":
        return False
    if "\0" in p:
        return False
    if p.startswith("/") or p.startswith("\\"):
        return False
    if re.match(r"^[A-Za-z]:", p):
        return False  # 盘符(含 C:x 形态)即绝对
    segs = re.split(r"[\\/]", p)
    for i, seg in enumerate(segs):
        if seg == "..":
            return False
        if len(segs) > 1 and seg == "":
            return False  # 内部空段(尾随分隔符容忍剥除)
    return True


def is_int_valued(v):
    # round-trip 整值判定(spec §3.1:取整后回比不等 → 非整值)
    return float(int(v)) == v


class Server(ThreadingHTTPServer):
    # listen backlog:默认 request_queue_size=5,8 客户端并发连接会溢出(ECONNREFUSED)
    request_queue_size = 64
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, close=False):
        self.send_response(code)
        self.send_header("content-type", "application/json")
        if close:
            self.send_header("connection", "close")
        self.send_header("content-length", str(len(body.encode("utf-8"))))
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))
        if close:
            self.close_connection = True

    def _tool_sum(self, args):
        if "a" not in args or "b" not in args:
            self._send(400, app_err("missing_field"))
            return
        af = args["a"]
        bf = args["b"]
        if not isinstance(af, (int, float)) or isinstance(af, bool) or not isinstance(bf, (int, float)) or isinstance(bf, bool):
            self._send(400, app_err("bad_args"))
            return
        ai = int(af)  # 取整(round-trip 判定;矩阵数值域受限,饱和/溢出形态不构造)
        if not is_int_valued(af):
            self._send(400, app_err("bad_args"))
            return
        bi = int(bf)
        if not is_int_valued(bf):
            self._send(400, app_err("bad_args"))
            return
        self._send(200, app_result_num(ai + bi))

    def _tool_count(self, args):
        if "text" not in args:
            self._send(400, app_err("missing_field"))
            return
        text = args["text"]
        if not isinstance(text, str):
            self._send(400, app_err("bad_args"))
            return
        self._send(200, app_result_num(len(text)))  # 码点口径(含非 ASCII)

    def _tool_path(self, args):
        if "path" not in args:
            self._send(400, app_err("missing_field"))
            return
        p = args["path"]
        if not isinstance(p, str):
            self._send(400, app_err("bad_args"))
            return
        if is_relative_clean_path(p):
            self._send(200, app_result_str("ok"))  # 恒 "ok",不回显路径
        else:
            self._send(400, app_err("bad_args"))

    def _handle_tool(self, body):
        # 1. 空体/坏 JSON → bad_json
        if body == "":
            self._send(400, app_err("bad_json"))
            return
        try:
            doc = json.loads(body)
        except ValueError:
            self._send(400, app_err("bad_json"))
            return
        # 2. 根非对象 → bad_json
        if not isinstance(doc, dict):
            self._send(400, app_err("bad_json"))
            return
        # 3. tool 缺失 → missing_field;非 str → bad_args
        if "tool" not in doc:
            self._send(400, app_err("missing_field"))
            return
        tool = doc["tool"]
        if not isinstance(tool, str):
            self._send(400, app_err("bad_args"))
            return
        # 4. args 缺失 → missing_field;非对象 → bad_args
        if "args" not in doc:
            self._send(400, app_err("missing_field"))
            return
        args = doc["args"]
        if not isinstance(args, dict):
            self._send(400, app_err("bad_args"))
            return
        # 5. 工具名 ∈ 已知集;否则 404 unknown_tool
        if tool == "sum":
            self._tool_sum(args)
        elif tool == "count":
            self._tool_count(args)
        elif tool == "path_check":
            self._tool_path(args)
        elif tool == "boom":
            # 6. boom:无条件 handler 内异常 → 500 handler_panic(服务层捕获,服务不死)
            raise RuntimeError("boom")
        else:
            self._send(404, app_err("unknown_tool"))

    def _route(self, body):
        method = (self.command or "GET").upper()
        path = self.path.split("?")[0]
        # 0. 路由层:/tool 非 POST 或 /health 非 GET → 405;其余路径 → 404 not_found
        if path == "/tool":
            if method == "POST":
                self._handle_tool(body)
                return
            self._send(405, app_err("method_not_allowed"))
            return
        if path == "/health":
            if method == "GET":
                self._send(200, json.dumps({"ok": True}, separators=(",", ":")))
                return
            self._send(405, app_err("method_not_allowed"))
            return
        self._send(404, app_err("not_found"))

    def do_GET(self):
        self._route("")

    def do_POST(self):
        # 体上限前置检查(声明尺寸;handler 不执行)——ming serve 同款早响应形态;
        # 头-only 客户端(GAP-S4-1)无未消费体,连接干净关闭
        try:
            cl = int(self.headers.get("content-length") or 0)
        except ValueError:
            cl = 0
        if cl > BODY_LIMIT:
            oversize = json.dumps({"code": "body_too_large", "message": "请求体超过 8MB 上限"}, separators=(",", ":"), ensure_ascii=False)
            self._send(413, oversize, close=True)
            return
        body = self.rfile.read(cl).decode("utf-8", "replace")
        try:
            self._route(body)
        except Exception:
            panic = json.dumps({"code": "handler_panic", "message": "handler 异常"}, separators=(",", ":"), ensure_ascii=False)
            self._send(500, panic, close=True)

    def log_message(self, *args):
        pass


def main():
    if len(sys.argv) < 2:
        print("error: 需要端口参数", file=sys.stderr)
        return 1
    raw = sys.argv[1]
    if not re.fullmatch(r"\d+", raw):
        print("error: 端口参数非法(需 1..65535)", file=sys.stderr)
        return 1
    port = int(raw)
    if port < 1 or port > 65535:
        print("error: 端口参数非法(需 1..65535)", file=sys.stderr)
        return 1
    try:
        server = Server(("127.0.0.1", port), Handler)
    except OSError:
        print("error: 端口绑定失败", file=sys.stderr)
        return 1
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
