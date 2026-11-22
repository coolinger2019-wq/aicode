"""固定路由 HTTP 服务(长驻):GET /ping、POST /sum,其余一律 404。

用法: python solution.py <端口>
绑定失败(端口被占)时向 stderr 输出以 error: 开头的一行消息并以退出码 1 结束;
绑定成功后长驻服务,由验收器关停。
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BODY_PONG = '{"pong":true}'
BODY_BAD_REQUEST = '{"code":"bad_request"}'
BODY_NOT_FOUND = '{"code":"not_found"}'


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "exp-serve/1"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    def _reply(self, code, body):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _is_number(self, value):
        # JSON 数值语义:排除 bool(True/False 在 Python 里是 int 的子类)。
        return isinstance(value, (int, float)) and not isinstance(value, bool)

    def _reply_sum(self, raw):
        try:
            obj = json.loads(raw)
        except ValueError:
            # body 非 JSON 或为空 → 400
            self._reply(400, BODY_BAD_REQUEST)
            return
        nums = obj.get("nums") if isinstance(obj, dict) else None
        if not isinstance(nums, list) or not all(self._is_number(v) for v in nums):
            # nums 缺失 / 非数组 / 含非数值元素 → 400
            self._reply(400, BODY_BAD_REQUEST)
            return
        try:
            # 元素按整数语义累加;空数组 → 0
            total = sum(int(v) for v in nums)
        except (ValueError, OverflowError):
            self._reply(400, BODY_BAD_REQUEST)
            return
        self._reply(200, '{"sum":%d}' % total)

    def _route(self):
        # 先按 Content-Length 完整消费请求体,保证 keep-alive 连接的分帧干净。
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        # 路径含 query 时按 ? 前的部分匹配
        path = self.path.split("?", 1)[0]
        if self.command == "GET" and path == "/ping":
            self._reply(200, BODY_PONG)
        elif self.command == "POST" and path == "/sum":
            self._reply_sum(raw)
        else:
            # 其余任何方法与路径 → 404
            self._reply(404, BODY_NOT_FOUND)

    def do_GET(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_PUT(self):
        self._route()

    def do_DELETE(self):
        self._route()

    def do_PATCH(self):
        self._route()

    def do_OPTIONS(self):
        self._route()


class Server(ThreadingHTTPServer):
    # 关闭 SO_REUSEADDR:Windows 下开启会允许绑定到已被占用的端口,
    # 满足不了"端口被占 → 绑定失败 → error:/退出码 1"的要求。
    allow_reuse_address = False
    daemon_threads = True

    def handle_error(self, request, client_address):
        # 客户端异常断开等不往 stderr 打堆栈,保持错误输出只承载绑定失败。
        pass


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("error: missing port argument\n")
        return 1
    try:
        port = int(argv[1])
    except ValueError:
        sys.stderr.write("error: invalid port: %s\n" % argv[1])
        return 1
    try:
        server = Server(("127.0.0.1", port), Handler)
    except OSError as exc:
        sys.stderr.write("error: bind 127.0.0.1:%d failed: %s\n" % (port, exc))
        return 1
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
