# B4 黑盒验收(Python):启动被测 .py 服务,轮询就绪,发送固定请求矩阵,
# transcript 与 expected 逐字节比对,关停服务。
# 用法(从仓库根):python tests/experiment/tasks/b4_serve_handler/verify.py [被测程序路径]
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent
REPO_ROOT = TASK_DIR.parents[3]

MATRIX = [
    ("GET", "/ping", ""),
    ("POST", "/sum", '{"nums":[1,2,3,4]}'),
    ("POST", "/sum", '{"nums":[]}'),
    ("POST", "/sum", '{"nums":"x"}'),
    ("POST", "/sum", "notjson"),
    ("GET", "/deep/path", ""),
]


def http_once(port: int, method: str, path: str, body: str):
    url = "http://127.0.0.1:%d%s" % (port, path)
    data = body.encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def main() -> int:
    prog = Path(sys.argv[1]) if len(sys.argv) > 1 else TASK_DIR / "solutions" / "solution.py"
    expected = (TASK_DIR / "expected" / "expected.txt").read_text(encoding="utf-8")
    for i in range(10):
        port = 21241 + i * 7
        child = subprocess.Popen(
            [sys.executable, str(prog), str(port)],
            cwd=str(REPO_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.time() + 6
            up = False
            while time.time() < deadline:
                time.sleep(0.15)
                try:
                    status, _ = http_once(port, "GET", "/ping", "")
                    if status == 200:
                        up = True
                        break
                except (urllib.error.URLError, OSError):
                    pass
            if not up:
                child.terminate()
                time.sleep(0.2)
                continue
            lines = []
            for k, (method, path, body) in enumerate(MATRIX):
                try:
                    status, text = http_once(port, method, path, body)
                    lines.append("R%d -> %d %s" % (k + 1, status, text))
                except (urllib.error.URLError, OSError) as e:
                    lines.append("R%d -> ERR %s" % (k + 1, e))
        finally:
            child.terminate()
        actual = "\n".join(lines) + "\n"
        if actual != expected:
            print(
                "FAIL transcript mismatch actual_len=%d expected_len=%d"
                % (len(actual), len(expected)),
                file=sys.stderr,
            )
            return 1
        print("PASS")
        return 0
    print("FAIL 服务无法启动", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
