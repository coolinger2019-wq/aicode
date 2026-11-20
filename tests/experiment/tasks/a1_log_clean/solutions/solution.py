# A1 日志清洗 — 参考实现(Python 3.10)
import sys

LEVELS = ("INFO", "WARN", "ERROR", "DEBUG")


def main() -> int:
    if len(sys.argv) < 2:
        print("error: 需要日志文件路径", file=sys.stderr)
        return 1
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            content = f.read()
    except OSError:
        print("error: 无法读取 " + path, file=sys.stderr)
        return 1
    lines = content.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    counts = {"INFO": 0, "WARN": 0, "ERROR": 0, "DEBUG": 0}
    skipped = 0
    kept = []
    for line in lines:
        parts = line.split(" ")
        user = next((p.split("=", 1)[1] for p in parts if p.startswith("user=")), None)
        action = next((p.split("=", 1)[1] for p in parts if p.startswith("action=")), None)
        level = parts[1] if len(parts) > 1 else ""
        if len(parts) >= 5 and level in LEVELS and user is not None and action is not None:
            counts[level] += 1
            if level != "DEBUG":
                kept.append(user + " " + action)
        else:
            skipped += 1
    for k in kept:
        print(k)
    print(
        "summary INFO=%d WARN=%d ERROR=%d DEBUG=%d skipped=%d"
        % (counts["INFO"], counts["WARN"], counts["ERROR"], counts["DEBUG"], skipped)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
