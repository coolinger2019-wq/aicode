"""b4_serve_handler: tiny fixed-route HTTP server on 127.0.0.1:<port>.

Routes (compact JSON bodies, no spaces):
  GET  /ping          -> 200 {"pong":true}
  POST /sum           -> 200 {"sum":<int>}   when body is a JSON object whose
                                              "nums" is a list of numbers only
                      -> 400 {"code":"bad_request"} otherwise
  anything else       -> 404 {"code":"not_found"}

Bind failure: one stderr line starting with "error:", exit code 1.
Runs forever; the verifier kills the process.
"""

import json
import sys
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

MAX_BODY = 8 * 1024 * 1024

BODY_PONG = '{"pong":true}'
BODY_SUM = '{"sum":%d}'
BODY_BAD = '{"code":"bad_request"}'
BODY_NOT_FOUND = '{"code":"not_found"}'


class Server(ThreadingHTTPServer):
    # HTTPServer sets allow_reuse_address = 1; on Windows SO_REUSEADDR lets a
    # second bind succeed even while another process is listening, which would
    # silently swallow the required "port occupied -> error:" branch. Turn it
    # off so an occupied port fails the bind as specified.
    allow_reuse_address = False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "b4"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    def __getattr__(self, name):
        # Catch-all for any HTTP method without an explicit do_<METHOD>
        # (PUT/DELETE/PATCH/OPTIONS/TRACE/...): rule 4 says any other
        # method + path is 404 {"code":"not_found"}.
        if name.startswith("do_"):
            return self._other_method
        raise AttributeError(name)

    def _route_path(self):
        # Match on the part before "?" (query string is ignored).
        return self.path.split("?", 1)[0]

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            return b""
        if length > MAX_BODY:
            length = MAX_BODY
        try:
            return self.rfile.read(length)
        except Exception:
            return b""

    def _reply(self, code, body):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _bad_request(self):
        self._reply(400, BODY_BAD)

    def _not_found(self):
        self._reply(404, BODY_NOT_FOUND)

    def _other_method(self):
        self._read_body()
        self._not_found()

    def do_GET(self):
        path = self._route_path()
        self._read_body()
        if path == "/ping":
            self._reply(200, BODY_PONG)
        else:
            self._not_found()

    def do_HEAD(self):
        path = self._route_path()
        self._read_body()
        if path == "/ping":
            code, body = 200, BODY_PONG
        else:
            code, body = 404, BODY_NOT_FOUND
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()

    def do_POST(self):
        path = self._route_path()
        raw = self._read_body()
        if path != "/sum":
            self._not_found()
            return
        try:
            obj = json.loads(raw.decode("utf-8"))
        except Exception:
            self._bad_request()
            return
        if not isinstance(obj, dict):
            self._bad_request()
            return
        nums = obj.get("nums")
        if not isinstance(nums, list):
            self._bad_request()
            return
        total = 0
        for item in nums:
            # bool is a subclass of int in Python, but JSON true/false is
            # not a number, so exclude it explicitly.
            if isinstance(item, bool) or not isinstance(item, (int, float)):
                self._bad_request()
                return
            total += item
        self._reply(200, BODY_SUM % int(total))


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("error: missing port argument\n")
        return 1
    try:
        port = int(sys.argv[1], 10)
    except ValueError:
        sys.stderr.write("error: invalid port argument\n")
        return 1
    if not (0 <= port <= 65535):
        sys.stderr.write("error: port out of range\n")
        return 1
    try:
        server = Server(("127.0.0.1", port), Handler)
    except (OSError, OverflowError) as exc:
        sys.stderr.write("error: cannot bind 127.0.0.1:%d (%s)\n" % (port, exc))
        return 1
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
