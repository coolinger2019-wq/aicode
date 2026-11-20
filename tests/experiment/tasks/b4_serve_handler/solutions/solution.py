# B4 serve handler — 参考实现(Python 3.10)
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BAD = '{"code":"bad_request"}'
NOT_FOUND = '{"code":"not_found"}'


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: str) -> None:
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def _route(self, body: str) -> None:
        method = self.command.upper()
        path = self.path.split("?")[0]
        if method == "GET" and path == "/ping":
            self._send(200, '{"pong":true}')
            return
        if method == "POST" and path == "/sum":
            try:
                doc = json.loads(body)
            except ValueError:
                self._send(400, BAD)
                return
            nums = doc.get("nums") if isinstance(doc, dict) else None
            if isinstance(nums, list) and all(is_num(x) for x in nums):
                total = sum(int(x) for x in nums)
                self._send(200, '{"sum":%d}' % total)
            else:
                self._send(400, BAD)
            return
        self._send(404, NOT_FOUND)

    def do_GET(self) -> None:
        self._route("")

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        self._route(body)

    def log_message(self, *args) -> None:
        pass


def main() -> int:
    if len(sys.argv) < 2:
        print("error: 需要端口参数", file=sys.stderr)
        return 1
    try:
        port = int(sys.argv[1])
    except ValueError:
        print("error: 端口参数非法", file=sys.stderr)
        return 1
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        print("error: 端口绑定失败", file=sys.stderr)
        return 1
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
