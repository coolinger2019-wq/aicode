# B1 JSON 深合并 — 参考实现(Python 3.10)
import json
import sys


def merge(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        out = {}
        for k in a:
            if k in b:
                out[k] = merge(a[k], b[k])
            else:
                out[k] = a[k]
        for k in b:
            if k not in a:
                out[k] = b[k]
        return out
    return b


def main() -> int:
    if len(sys.argv) < 3:
        print("error: 需要 <a.json> <b.json>", file=sys.stderr)
        return 1
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            ja = json.load(f)
        with open(sys.argv[2], "r", encoding="utf-8") as f:
            jb = json.load(f)
    except (OSError, ValueError):
        print("error: 文件不可读或 JSON 解析失败", file=sys.stderr)
        return 1
    if not isinstance(ja, dict) or not isinstance(jb, dict):
        print("error: 顶层必须是对象", file=sys.stderr)
        return 1
    print(json.dumps(merge(ja, jb), separators=(",", ":"), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
