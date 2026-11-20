# A2 批量改名 — 参考实现(Python 3.10)
import os
import re
import sys


def zero_pad2(v: int) -> str:
    return ("0" + str(v)) if v < 10 else str(v)


def rule1_target(name: str):
    m = re.fullmatch(r"report_([0-9]+)\.txt", name)
    if not m:
        return None
    digits = m.group(1)
    if len(digits) > 18:
        return None  # 超出整数范围,按不匹配处理
    return "report-" + zero_pad2(int(digits)) + ".txt"


def main() -> int:
    if len(sys.argv) < 3:
        print("error: 需要 <输入目录> <输出目录>", file=sys.stderr)
        return 1
    input_dir, output_dir = sys.argv[1], sys.argv[2]
    try:
        entries = sorted(os.listdir(input_dir))
    except OSError:
        print("error: 无法读取输入目录 " + input_dir, file=sys.stderr)
        return 1
    os.makedirs(output_dir, exist_ok=True)
    claimed = set()
    for name in entries:
        r1 = rule1_target(name)
        target = r1 if r1 is not None else ("logs/" + name if name.endswith(".log") else None)
        if target is None:
            print("SKIP " + name + " nomatch")
            continue
        if target in claimed:
            print("SKIP " + name + " conflict " + target)
            continue
        try:
            with open(os.path.join(input_dir, name), "rb") as f:
                content = f.read()
            dst = os.path.join(output_dir, target)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as f:
                f.write(content)
        except OSError:
            print("SKIP " + name + " nomatch")
            continue
        claimed.add(target)
        print(("OK " if r1 is not None else "DIR ") + name + " -> " + target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
