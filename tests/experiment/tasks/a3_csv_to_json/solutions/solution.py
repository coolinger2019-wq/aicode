# A3 CSV→JSON — 参考实现(Python 3.10)
import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("error: 需要 CSV 文件路径", file=sys.stderr)
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
    rows = []
    errors = []
    if lines:
        cols = lines[0].split(",")
        want = len(cols)
        for i in range(1, len(lines)):
            fields = lines[i].split(",")
            if len(fields) == want:
                row = {}
                for j in range(len(cols)):
                    row[cols[j]] = fields[j]
                rows.append(row)
            else:
                errors.append({"line": i + 1, "got": len(fields), "want": want})
    print(json.dumps({"rows": rows, "errors": errors}, separators=(",", ":"), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
