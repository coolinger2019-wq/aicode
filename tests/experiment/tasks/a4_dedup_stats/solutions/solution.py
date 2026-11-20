# A4 去重统计 — 参考实现(Python 3.10)
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("error: 需要分块目录", file=sys.stderr)
        return 1
    d = sys.argv[1]
    try:
        entries = os.listdir(d)
    except OSError:
        print("error: 无法读取目录 " + d, file=sys.stderr)
        return 1
    names = sorted(n for n in entries if n.startswith("chunk_") and n.endswith(".txt"))
    counts = {}
    total = 0
    for name in names:
        try:
            with open(os.path.join(d, name), "r", encoding="utf-8", newline="") as f:
                content = f.read()
        except OSError:
            print("error: 无法读取 " + name, file=sys.stderr)
            return 1
        lines = content.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        for line in lines:
            counts[line] = counts.get(line, 0) + 1
            total += 1
    items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    repeated = sum(1 for _, c in items if c > 1)
    print("total=%d" % total)
    print("unique=%d" % len(counts))
    print("repeated=%d" % repeated)
    for t in range(min(3, len(items))):
        print("top%d %s %d" % (t + 1, items[t][0], items[t][1]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
