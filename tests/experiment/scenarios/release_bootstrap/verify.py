# S5 黑盒验收(Python):内容腿(ok → stdout 逐字节 + exit 0 + notes 逐字节;
# mismatch_* / extra_file → stdout 逐字节 + exit 1 + 输出路径无文件)+ 参数级腿
# (缺参/目录不存在/argv[1] 指向普通文件/missing_version 案例)+ 负例腿(交叉喂入
# S2 参考实现预期 FAIL/expected 变异样本——检查行与 notes 各一字符——预期 mismatch)
# + 不 panic 专项(六快照 stderr 无引擎 panic 标记)。
# 采集 text=True + encoding="utf-8"(universal newlines 归一;期望文件统一 \n);
# 期望文件读取固定 newline=""。用法(从仓库根):
# python tests/experiment/scenarios/release_bootstrap/verify.py [被测程序路径]
import subprocess
import sys
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent
REPO_ROOT = TASK_DIR.parents[3]
BASE = "tests/experiment/scenarios/release_bootstrap"
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


def read_exact(p):
    with open(p, "r", encoding="utf-8", newline="") as f:
        return f.read()


def has_panic_marker(stderr):
    return any(m in (stderr or "") for m in PANIC_MARKERS)


def is_single_line_stderr(s):
    # stderr 恰一行(spec §4 字面):恰一个换行且在末尾(universal newlines 已归一 \r\n)
    return (s or "").count("\n") == 1 and s.endswith("\n")


def expect_param_error(tag, r):
    if r.returncode != 1:
        print("FAIL %s: exit=%d(预期 1)\n%s" % (tag, r.returncode, r.stderr or ""), file=sys.stderr)
        return 1
    if r.stdout != "":
        print("FAIL %s: stdout 非空(预期空)" % tag, file=sys.stderr)
        return 1
    if not (r.stderr or "").startswith("error:"):
        print("FAIL %s: stderr 未以 error: 开头" % tag, file=sys.stderr)
        return 1
    if has_panic_marker(r.stderr):
        print("FAIL %s: stderr 含引擎 panic 标记" % tag, file=sys.stderr)
        return 1
    if not is_single_line_stderr(r.stderr):
        print("FAIL %s: stderr 非恰一行" % tag, file=sys.stderr)
        return 1
    return 0


def main():
    prog = Path(sys.argv[1]) if len(sys.argv) > 1 else TASK_DIR / "solutions" / "solution.py"
    base = TASK_DIR
    ok_snap = f"{BASE}/input/snapshots/ok"
    out_dir = base / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    notes_out = f"{BASE}/output/notes_ok_py.md"
    (REPO_ROOT / notes_out).unlink(missing_ok=True)
    exp_ok = read_exact(base / "expected" / "expected_stdout_ok.txt")
    exp_notes = read_exact(base / "expected" / "expected_notes_ok.md")
    fail_cases = [
        ("mismatch_cli", f"{BASE}/input/snapshots/mismatch_cli", "expected_stdout_mismatch_cli.txt"),
        ("mismatch_changelog", f"{BASE}/input/snapshots/mismatch_changelog", "expected_stdout_mismatch_changelog.txt"),
        ("mismatch_tag", f"{BASE}/input/snapshots/mismatch_tag", "expected_stdout_mismatch_tag.txt"),
        ("extra_file", f"{BASE}/input/snapshots/extra_file", "expected_stdout_extra_file.txt"),
    ]

    # 内容腿 1:ok → exit 0 + stdout 逐字节 + notes 逐字节
    ok = run_prog(prog, [ok_snap, notes_out])
    if ok.returncode != 0:
        print("FAIL 内容-ok: exit=%d(预期 0)\n%s" % (ok.returncode, ok.stderr or ""), file=sys.stderr)
        return 1
    if ok.stdout != exp_ok:
        print("FAIL 内容-ok: stdout mismatch actual_len=%d expected_len=%d" % (len(ok.stdout), len(exp_ok)), file=sys.stderr)
        return 1
    if has_panic_marker(ok.stderr):
        print("FAIL 内容-ok: stderr 含引擎 panic 标记", file=sys.stderr)
        return 1
    got_notes = read_exact(REPO_ROOT / notes_out)
    if got_notes != exp_notes:
        print("FAIL 内容-ok: notes mismatch actual_len=%d expected_len=%d" % (len(got_notes), len(exp_notes)), file=sys.stderr)
        return 1

    # 内容腿 2–5:mismatch_* / extra_file → exit 1 + stdout 逐字节 + 无输出文件
    for tag, snap, exp_file in fail_cases:
        exp = read_exact(base / "expected" / exp_file)
        notes_i = f"{BASE}/output/notes_{tag}_py.md"
        (REPO_ROOT / notes_i).unlink(missing_ok=True)
        r = run_prog(prog, [snap, notes_i])
        if r.returncode != 1:
            print("FAIL 内容-%s: exit=%d(预期 1)\n%s" % (tag, r.returncode, r.stderr or ""), file=sys.stderr)
            return 1
        if r.stdout != exp:
            print("FAIL 内容-%s: stdout mismatch actual_len=%d expected_len=%d" % (tag, len(r.stdout), len(exp)), file=sys.stderr)
            return 1
        if has_panic_marker(r.stderr):
            print("FAIL 内容-%s: stderr 含引擎 panic 标记" % tag, file=sys.stderr)
            return 1
        if (REPO_ROOT / notes_i).exists():
            print("FAIL 内容-%s: FAIL 路径竟产出 notes 文件" % tag, file=sys.stderr)
            return 1

    # 参数级腿 1–5:缺参(0/1 个 argv)/目录不存在/argv[1] 指向普通文件/missing_version
    if expect_param_error("参数-缺参", run_prog(prog, [])) != 0:
        return 1
    if expect_param_error("参数-单参", run_prog(prog, [ok_snap])) != 0:
        return 1
    if expect_param_error("参数-目录不存在", run_prog(prog, [f"{BASE}/input/snapshots/no_such_dir", notes_out])) != 0:
        return 1
    if expect_param_error("参数-普通文件", run_prog(prog, [f"{BASE}/input/snapshots/extra_file/draft_notes.txt", notes_out])) != 0:
        return 1
    if expect_param_error("参数-missing_version", run_prog(prog, [f"{BASE}/input/snapshots/missing_version", notes_out])) != 0:
        return 1

    # 负例腿 1:交叉喂入 S2 参考实现(缺 key 参数)→ 必须按具体 FAIL 形态失败:
    # exit 1 + stderr error: 行(参数级拒绝;排除 no-start/ENOENT 形态静默通过,
    # 审查 MINOR-3 收口)
    s2 = REPO_ROOT / "tests/experiment/scenarios/file_integrity/solutions/solution.py"
    cross = run_prog(s2, [ok_snap, notes_out])
    if cross.returncode == 1 and (cross.stderr or "").startswith("error:") and cross.stdout == "":
        # 具体失败形态成立(S2 参数级拒绝)
        pass
    elif cross.returncode == 0 and cross.stdout == exp_ok:
        print("FAIL 负例-交叉喂入: S2 参考实现竟通过 S5 验收", file=sys.stderr)
        return 1
    else:
        print("FAIL 负例-交叉喂入: 未按参数级拒绝形态失败 exit=%d" % cross.returncode, file=sys.stderr)
        return 1

    # 负例腿 2:expected 变异样本 → mismatch FAIL(逐字节比对有齿,S3 惯例)
    # 2a:检查行改一处
    mutated_out = exp_ok.replace("check tag OK", "check tag OKX")
    notes_mut = f"{BASE}/output/notes_mut_py.md"
    rerun = run_prog(prog, [ok_snap, notes_mut])
    if rerun.returncode != 0:
        print("FAIL 负例-变异样本: exit=%d" % rerun.returncode, file=sys.stderr)
        return 1
    if rerun.stdout == mutated_out:
        print("FAIL 负例-变异样本: 变异期望竟与 stdout 一致(比对无齿)", file=sys.stderr)
        return 1
    # 2b:notes 改一字符(读盘 notes 与变异期望必须不一致)
    mutated_notes = exp_notes.replace("自举工具链冒烟", "自举工具链冒烟X")
    got_mut_notes = read_exact(REPO_ROOT / notes_mut)
    if got_mut_notes == mutated_notes:
        print("FAIL 负例-变异样本: notes 变异期望竟与实写一致(比对无齿)", file=sys.stderr)
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
