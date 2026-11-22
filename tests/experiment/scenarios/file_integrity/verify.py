# S2 黑盒验收(Python):gen 腿(stdout + 清单逐字节)+ verify 腿(stdout 逐字节 +
# 预期 exit 1)+ 负例腿(缺参/key 越值域/dir 不存在/清单行被改动/交叉喂入 S1 参考实现)。
# 用法(从仓库根):python tests/experiment/scenarios/file_integrity/verify.py [被测程序路径]
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
    gen_dir = "tests/experiment/scenarios/file_integrity/input/gen/files"
    verify_dir = "tests/experiment/scenarios/file_integrity/input/verify/files"
    manifest = "tests/experiment/scenarios/file_integrity/input/verify/manifest.txt"
    key = "integkey2026"
    gen_out = ".zcode/exp-s2-verify/gen_manifest_py.txt"
    (REPO_ROOT / ".zcode" / "exp-s2-verify").mkdir(parents=True, exist_ok=True)
    gen_out_path = REPO_ROOT / gen_out
    if gen_out_path.exists():
        gen_out_path.unlink()
    expected_gen_stdout = read_exact(TASK_DIR / "expected" / "expected_gen_stdout.txt")
    expected_manifest = read_exact(TASK_DIR / "expected" / "gen_manifest.txt")
    expected_verify_stdout = read_exact(TASK_DIR / "expected" / "expected_verify_stdout.txt")
    # gen 腿:exit 0 + stdout 逐字节 + 清单逐字节
    g = run_prog(prog, ["gen", gen_dir, gen_out, key])
    if g.returncode != 0:
        print("FAIL gen 腿 exit=%d\n%s" % (g.returncode, g.stderr or ""), file=sys.stderr)
        return 1
    if g.stdout != expected_gen_stdout:
        print(
            "FAIL gen 腿 stdout mismatch actual_len=%d expected_len=%d"
            % (len(g.stdout), len(expected_gen_stdout)),
            file=sys.stderr,
        )
        return 1
    got_manifest = read_exact(gen_out_path)
    if got_manifest != expected_manifest:
        print(
            "FAIL gen 腿 manifest mismatch actual_len=%d expected_len=%d"
            % (len(got_manifest), len(expected_manifest)),
            file=sys.stderr,
        )
        return 1
    # all-OK 腿(审查 MINOR-1):gen/files + gen 腿刚产出的清单 → 全 OK → 预期 exit 0,
    # 状态行(每清单名一行 "<name> OK")+ 汇总逐字节。期望输出由期望清单行名推导
    # (fixture 保证清单名合法)。
    mlines_all_ok = expected_manifest.split("\n")
    if mlines_all_ok and mlines_all_ok[-1] == "":
        mlines_all_ok.pop()
    expected_all_ok = (
        "\n".join(line.split(" ")[0] + " OK" for line in mlines_all_ok)
        + "\n"
        + "summary ok=%d tampered=0 missing=0 rejected=0 extra=0" % len(mlines_all_ok)
        + "\n"
    )
    ao = run_prog(prog, ["verify", gen_dir, gen_out, key])
    if ao.returncode != 0:
        print(
            "FAIL all-OK 腿 exit=%d(预期 0——gen/files 全净且清单吻合)\n%s"
            % (ao.returncode, ao.stderr or ""),
            file=sys.stderr,
        )
        return 1
    if ao.stdout != expected_all_ok:
        print(
            "FAIL all-OK 腿 stdout mismatch actual_len=%d expected_len=%d"
            % (len(ao.stdout), len(expected_all_ok)),
            file=sys.stderr,
        )
        return 1
    # verify 腿:存在篡改 → 预期 exit 1,stdout 逐字节
    v = run_prog(prog, ["verify", verify_dir, manifest, key])
    if v.returncode != 1:
        print(
            "FAIL verify 腿 exit=%d(预期 1——fixture 含篡改)\n%s" % (v.returncode, v.stderr or ""),
            file=sys.stderr,
        )
        return 1
    if v.stdout != expected_verify_stdout:
        print(
            "FAIL verify 腿 stdout mismatch actual_len=%d expected_len=%d"
            % (len(v.stdout), len(expected_verify_stdout)),
            file=sys.stderr,
        )
        return 1
    # 负例腿 1:缺参(仅子命令)
    if expect_param_error("负例-缺参", run_prog(prog, ["gen"])) != 0:
        return 1
    # 负例腿 2:key 越值域
    if expect_param_error("负例-key越值域", run_prog(prog, ["gen", gen_dir, gen_out, "bad_key!"])) != 0:
        return 1
    # 负例腿 3:dir 不存在
    if (
        expect_param_error(
            "负例-dir不存在",
            run_prog(prog, ["gen", "tests/experiment/scenarios/file_integrity/input/no_such_dir", gen_out, key]),
        )
        != 0
    ):
        return 1
    # 负例腿 4:清单行被改动(合法 hex64,值 ≠ 原)→ exit 1 且 stdout 含 TAMPERED
    raw_lines = read_exact(REPO_ROOT / manifest).split("\n")
    if raw_lines and raw_lines[-1] == "":
        raw_lines.pop()
    zeros = "0" * 64
    fake_hex = "1" * 64 if raw_lines[0].split(" ")[1] == zeros else zeros
    raw_lines[0] = raw_lines[0].split(" ")[0] + " " + fake_hex
    tampered_rel = ".zcode/exp-s2-verify/manifest_tampered_py.txt"
    with open(REPO_ROOT / tampered_rel, "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(raw_lines) + "\n")
    t = run_prog(prog, ["verify", verify_dir, tampered_rel, key])
    if t.returncode != 1 or t.stdout == "" or "TAMPERED" not in t.stdout:
        print(
            "FAIL 负例-清单行被改动: exit=%d(预期 1 且 stdout 含 TAMPERED)" % t.returncode,
            file=sys.stderr,
        )
        return 1
    # 负例腿 4b:清单结构损坏(首行只剩文件名,行格式非法)→ exit 1,stdout 空,stderr error:
    broken_lines = read_exact(REPO_ROOT / manifest).split("\n")
    if broken_lines and broken_lines[-1] == "":
        broken_lines.pop()
    broken_lines[0] = broken_lines[0].split(" ")[0]
    broken_rel = ".zcode/exp-s2-verify/manifest_broken_py.txt"
    with open(REPO_ROOT / broken_rel, "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(broken_lines) + "\n")
    if expect_param_error("负例-清单损坏", run_prog(prog, ["verify", verify_dir, broken_rel, key])) != 0:
        return 1
    # 负例腿 5:交叉喂入 S1 参考实现 → 预期 FAIL
    cross = run_prog(
        REPO_ROOT / "tests/experiment/scenarios/log_forensics/solutions/solution.py",
        ["gen", gen_dir, gen_out, key],
    )
    if cross.returncode == 0 and cross.stdout == expected_gen_stdout:
        print("FAIL 负例-交叉喂入: S1 参考实现竟通过 S2 gen 验收", file=sys.stderr)
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
