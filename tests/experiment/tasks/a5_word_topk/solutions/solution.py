# A5 词频 Top-K — 参考实现(Python 3.10)
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("error: 需要词频文件", file=sys.stderr)
        return 1
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError:
        print("error: 无法读取 " + path, file=sys.stderr)
        return 1
    tokens = content.split()
    counts = {}
    for w in tokens:
        counts[w] = counts.get(w, 0) + 1
    items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    for t in range(min(5, len(items))):
        print("%s %d" % (items[t][0], items[t][1]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
