import sys
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _reply(self, code, body):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return b""
        try:
            return self.rfile.read(n)
        except OSError:
            return b""

    def _handle(self):
        method = self.command
        path = self.path.split("?", 1)[0]
        body = self._read_body()
        if method == "GET" and path == "/ping":
            self._reply(200, '{"pong":true}')
            return
        if method == "POST" and path == "/sum":
            ok = False
            total = 0
            try:
                data = json.loads(body.decode("utf-8"))
                if isinstance(data, dict) and "nums" in data:
                    nums = data["nums"]
                    if isinstance(nums, list):
                        bad = False
                        for e in nums:
                            if isinstance(e, bool) or not isinstance(e, (int, float)):
                                bad = True
                                break
                        if not bad:
                            total = 0
                            for e in nums:
                                total += int(e)
                            ok = True
            except Exception:
                ok = False
            if ok:
                self._reply(200, '{"sum":' + str(total) + '}')
            else:
                self._reply(400, '{"code":"bad_request"}')
            return
        self._reply(404, '{"code":"not_found"}')

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_DELETE = _handle
    do_PATCH = _handle
    do_OPTIONS = _handle
    do_HEAD = _handle


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("error: missing port argument\n")
        sys.exit(1)
    try:
        port = int(sys.argv[1])
    except ValueError:
        sys.stderr.write("error: invalid port argument\n")
        sys.exit(1)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        sys.stderr.write("error: bind failed: " + str(e) + "\n")
        sys.exit(1)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
