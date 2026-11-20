# B5 黑盒验收(Python):运行被测 .py 程序,stdout 与 expected 逐字节比对 + 退出码。
# 用法(从仓库根):python tests/experiment/tasks/b5_json_path_query/verify.py [被测程序路径]
import subprocess
import sys
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent
REPO_ROOT = TASK_DIR.parents[3]


def main() -> int:
    prog = Path(sys.argv[1]) if len(sys.argv) > 1 else TASK_DIR / "solutions" / "solution.py"
    expected = (TASK_DIR / "expected" / "expected.txt").read_text(encoding="utf-8")
    task_args = [
        "tests/experiment/tasks/b5_json_path_query/input/doc.json",
        "tests/experiment/tasks/b5_json_path_query/input/queries.txt",
    ]
    try:
        r = subprocess.run(
            [sys.executable, str(prog), *task_args],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        print("FAIL timeout", file=sys.stderr)
        return 1
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
