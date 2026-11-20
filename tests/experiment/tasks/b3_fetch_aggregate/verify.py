# B3 黑盒验收(Python):启动 mock 源,轮询 ready 文件取端口,运行被测 .py 程序,
# 关停 mock,stdout 逐字节比对。
# 用法(从仓库根):python tests/experiment/tasks/b3_fetch_aggregate/verify.py [被测程序路径]
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent
REPO_ROOT = TASK_DIR.parents[3]


def main() -> int:
    prog = Path(sys.argv[1]) if len(sys.argv) > 1 else TASK_DIR / "solutions" / "solution.py"
    expected = (TASK_DIR / "expected" / "expected.txt").read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="exp-b3-") as tmp:
        ready_path = Path(tmp) / "ready.txt"
        mock = subprocess.Popen(
            ["node", str(TASK_DIR / "mock_server.mjs"), "21031", str(ready_path)],
            cwd=str(REPO_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            ports = None
            for _ in range(60):
                time.sleep(0.1)
                if ready_path.exists():
                    parts = [int(x) for x in ready_path.read_text(encoding="utf-8").split()]
                    if len(parts) == 3:
                        ports = parts
                        break
            if ports is None:
                print("FAIL mock 服务器未就绪", file=sys.stderr)
                return 1
            urls = [
                "http://127.0.0.1:%d/source1" % ports[0],
                "http://127.0.0.1:%d/source2" % ports[1],
                "http://127.0.0.1:%d/source3" % ports[2],
                "http://127.0.0.1:%d/missing" % ports[0],
            ]
            try:
                r = subprocess.run(
                    [sys.executable, str(prog), *urls],
                    cwd=str(REPO_ROOT),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=60,
                )
            except subprocess.TimeoutExpired:
                print("FAIL timeout", file=sys.stderr)
                return 1
        finally:
            mock.terminate()
        if r.returncode != 0:
            print("FAIL exit=%d\n%s" % (r.returncode, r.stderr or ""), file=sys.stderr)
            return 1
        if r.stdout != expected:
            print(
                "FAIL stdout mismatch actual_len=%d expected_len=%d"
                % (len(r.stdout), len(expected)),
                file=sys.stderr,
            )
            return 1
        print("PASS")
        return 0


if __name__ == "__main__":
    sys.exit(main())
