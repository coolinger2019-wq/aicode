# S1 黑盒验收(Python):运行被测 .py 程序,stdout 与 report 逐字节比对 + 退出码
# + 负例腿(缺参/不存在路径/交叉喂入 S2 参考实现预期 FAIL,spec §4)。
# 用法(从仓库根):python tests/experiment/scenarios/log_forensics/verify.py [被测程序路径]
import subprocess
import sys
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent
REPO_ROOT = TASK_DIR.parents[3]


def run_prog(prog, args):
    return subprocess.run(
        [sys.executable, str(prog), *args],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )


def read_exact(path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def expect_param_error(tag, r):
    if r.returncode != 1:
        print("FAIL %s: exit=%d(预期 1)\n%s" % (tag, r.returncode, r.stderr or ""), file=sys.stderr)
        return 1
    if r.stdout != "":
        print("FAIL %s: stdout 非空(预期空)" % tag, file=sys.stderr)
        return 1
    if not r.stderr.startswith("error:"):
        print("FAIL %s: stderr 未以 error: 开头" % tag, file=sys.stderr)
        return 1
    return 0


def main():
    prog = Path(sys.argv[1]) if len(sys.argv) > 1 else TASK_DIR / "solutions" / "solution.py"
    in_path = "tests/experiment/scenarios/log_forensics/input/main.log"
    report_out = ".zcode/exp-s1-verify/report-py.txt"
    (REPO_ROOT / ".zcode" / "exp-s1-verify").mkdir(parents=True, exist_ok=True)
    report_path = REPO_ROOT / report_out
    if report_path.exists():
        report_path.unlink()
    expected_stdout = read_exact(TASK_DIR / "expected" / "expected_stdout.txt")
    expected_report = read_exact(TASK_DIR / "expected" / "expected_report.txt")
    r = run_prog(prog, [in_path, report_out])
    if r.returncode != 0:
        print("FAIL 正例腿 exit=%d\n%s" % (r.returncode, r.stderr or ""), file=sys.stderr)
        return 1
    if r.stdout != expected_stdout:
        print(
            "FAIL 正例腿 stdout mismatch actual_len=%d expected_len=%d"
            % (len(r.stdout), len(expected_stdout)),
            file=sys.stderr,
        )
        return 1
    report = read_exact(report_path)
    if report != expected_report:
        print(
            "FAIL 正例腿 report mismatch actual_len=%d expected_len=%d"
            % (len(report), len(expected_report)),
            file=sys.stderr,
        )
        return 1
    if expect_param_error("负例-缺参", run_prog(prog, [])) != 0:
        return 1
    if (
        expect_param_error(
            "负例-路径不存在",
            run_prog(prog, ["tests/experiment/scenarios/log_forensics/input/no_such.log", report_out]),
        )
        != 0
    ):
        return 1
    cross = run_prog(
        REPO_ROOT / "tests/experiment/scenarios/file_integrity/solutions/solution.py",
        [in_path, report_out],
    )
    if cross.returncode == 0 and cross.stdout == expected_stdout:
        print("FAIL 负例-交叉喂入: S2 参考实现竟通过 S1 验收", file=sys.stderr)
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
