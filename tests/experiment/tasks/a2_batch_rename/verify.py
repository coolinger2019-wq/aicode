# A2 黑盒验收(Python):stdout 逐字节 + 输出目录集合 + 内容抽检。
# 用法(从仓库根):python tests/experiment/tasks/a2_batch_rename/verify.py [被测程序路径]
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent
REPO_ROOT = TASK_DIR.parents[3]


def main() -> int:
    prog = Path(sys.argv[1]) if len(sys.argv) > 1 else TASK_DIR / "solutions" / "solution.py"
    expected = (TASK_DIR / "expected" / "expected.txt").read_text(encoding="utf-8")
    rels = [
        ln
        for ln in (TASK_DIR / "expected" / "expected_files.txt")
        .read_text(encoding="utf-8")
        .split("\n")
        if ln
    ]
    out_dir = tempfile.mkdtemp(prefix="exp-a2-")
    try:
        try:
            r = subprocess.run(
                [sys.executable, str(prog), "tests/experiment/tasks/a2_batch_rename/input", out_dir],
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
        top_files = 0
        dirs = {}
        for rp in rels:
            if not (Path(out_dir) / rp).exists():
                print("FAIL 缺少输出文件 " + rp, file=sys.stderr)
                return 1
            segs = rp.split("/")
            if len(segs) == 1:
                top_files += 1
            else:
                dirs[segs[0]] = dirs.get(segs[0], 0) + 1
        top = os.listdir(out_dir)
        if len(top) != top_files + len(dirs):
            print(
                "FAIL 顶层条目数不符 actual=%d want=%d" % (len(top), top_files + len(dirs)),
                file=sys.stderr,
            )
            return 1
        for d, n in dirs.items():
            sub = os.listdir(os.path.join(out_dir, d))
            if len(sub) != n:
                print("FAIL 子目录条目数不符 %s actual=%d want=%d" % (d, len(sub), n), file=sys.stderr)
                return 1
        got = (Path(out_dir) / "report-01.txt").read_bytes()
        orig = (TASK_DIR / "input" / "report_1.txt").read_bytes()
        if got != orig:
            print("FAIL 改名文件内容与原文件不一致", file=sys.stderr)
            return 1
        print("PASS")
        return 0
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
