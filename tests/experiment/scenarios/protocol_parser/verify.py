# S3 黑盒验收(Python):运行被测 .py 程序,stdout 逐字节比对 + 退出码 + 参数级
# 腿(缺参/不存在/目录/oversize 门禁)+ 负例腿(交叉喂入 S1/S2 参考实现预期 FAIL)
# + 不 panic 专项(spec §4:input/ 全部文件 stderr 无引擎 panic 标记,exit ∈ {0,1})。
# 用法(从仓库根):python tests/experiment/scenarios/protocol_parser/verify.py [被测程序路径]
import subprocess
import sys
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent
REPO_ROOT = TASK_DIR.parents[3]
BASE = "tests/experiment/scenarios/protocol_parser"
PANIC_MARKERS = ["panic", "内部错误", "RangeError", "TypeError", "Traceback"]


def run_prog(prog, args):
    return subprocess.run(
        [sys.executable, str(prog), *args],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )


def no_panic_markers(stderr):
    return not any(m in (stderr or "") for m in PANIC_MARKERS)


def read_exact(path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def expect_run(tag, prog, arg, want_exit, expected):
    r = run_prog(prog, [arg])
    if r.returncode != want_exit:
        print("FAIL %s: exit=%d(预期 %d)\n%s" % (tag, r.returncode, want_exit, r.stderr or ""), file=sys.stderr)
        return 1
    if r.stdout != expected:
        print(
            "FAIL %s: stdout mismatch actual_len=%d expected_len=%d"
            % (tag, len(r.stdout), len(expected)),
            file=sys.stderr,
        )
        return 1
    if not no_panic_markers(r.stderr):
        print("FAIL %s: stderr 含引擎 panic 标记" % tag, file=sys.stderr)
        return 1
    return 0


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
    if not no_panic_markers(r.stderr):
        print("FAIL %s: stderr 含引擎 panic 标记" % tag, file=sys.stderr)
        return 1
    return 0


def no_panic_sweep(tag, prog, files):
    for f in files:
        r = run_prog(prog, [f])
        if r.returncode not in (0, 1):
            print("FAIL %s: %s exit=%d(预期 0/1)\n%s" % (tag, f, r.returncode, r.stderr or ""), file=sys.stderr)
            return 1
        if not no_panic_markers(r.stderr):
            print("FAIL %s: %s stderr 含引擎 panic 标记" % (tag, f), file=sys.stderr)
            return 1
    return 0


def main():
    prog = Path(sys.argv[1]) if len(sys.argv) > 1 else TASK_DIR / "solutions" / "solution.py"
    e_frames = read_exact(TASK_DIR / "expected" / "expected_frames_stdout.txt")
    e_clean = read_exact(TASK_DIR / "expected" / "expected_clean_stdout.txt")
    e_empty = read_exact(TASK_DIR / "expected" / "expected_empty_stdout.txt")
    e_badutf8 = read_exact(TASK_DIR / "expected" / "expected_badutf8_stdout.txt")

    # 正例腿 1–4:逐字节 + 退出码
    if expect_run("正例-frames", prog, f"{BASE}/input/frames.hex", 1, e_frames) != 0:
        return 1
    if expect_run("正例-clean", prog, f"{BASE}/input/clean.hex", 0, e_clean) != 0:
        return 1
    if expect_run("正例-empty", prog, f"{BASE}/input/empty.hex", 0, e_empty) != 0:
        return 1
    if expect_run("正例-badutf8", prog, f"{BASE}/input/bad_utf8.bin", 1, e_badutf8) != 0:
        return 1

    # 参数级腿 5–8
    (REPO_ROOT / ".zcode" / "exp-s3-verify").mkdir(parents=True, exist_ok=True)
    if expect_param_error("参数-oversize", run_prog(prog, [f"{BASE}/input/oversize.hex"])) != 0:
        return 1
    if expect_param_error("参数-缺参", run_prog(prog, [])) != 0:
        return 1
    if expect_param_error("参数-路径不存在", run_prog(prog, [f"{BASE}/input/no_such.bin"])) != 0:
        return 1
    if expect_param_error("参数-目录输入", run_prog(prog, [f"{BASE}/input"])) != 0:
        return 1

    # 负例腿 9:交叉喂入 S1/S2 参考实现 → 不得以期望输出成功
    cross_targets = [
        "tests/experiment/scenarios/log_forensics/solutions/solution.py",
        "tests/experiment/scenarios/file_integrity/solutions/solution.py",
    ]
    for ct in cross_targets:
        cross = run_prog(REPO_ROOT / ct, [f"{BASE}/input/frames.hex", ".zcode/exp-s3-verify/cross_report_py.txt"])
        if cross.returncode == 0 and cross.stdout == e_frames:
            print("FAIL 负例-交叉喂入: %s 竟通过 S3 验收" % ct, file=sys.stderr)
            return 1

    # 不 panic 专项(硬验收):input/ 全部 5 文件
    sweep = [
        f"{BASE}/input/frames.hex",
        f"{BASE}/input/clean.hex",
        f"{BASE}/input/empty.hex",
        f"{BASE}/input/bad_utf8.bin",
        f"{BASE}/input/oversize.hex",
    ]
    if no_panic_sweep("不panic专项", prog, sweep) != 0:
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
