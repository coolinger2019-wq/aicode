# B5 嵌套 JSON 路径查询 — 参考实现(Python 3.10)
import json
import re
import sys


def render_value(v):
    if isinstance(v, str):
        return v
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def step(cur, seg):
    if isinstance(cur, list):
        if re.fullmatch(r"[0-9]+", seg):
            idx = int(seg)
            if 0 <= idx < len(cur):
                return cur[idx]
        return None
    if isinstance(cur, dict):
        return cur.get(seg)
    return None


def main() -> int:
    if len(sys.argv) < 3:
        print("error: 需要 <doc.json> <queries.txt>", file=sys.stderr)
        return 1
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            doc = json.load(f)
        with open(sys.argv[2], "r", encoding="utf-8", newline="") as f:
            q_content = f.read()
    except (OSError, ValueError):
        print("error: 文件不可读或 JSON 解析失败", file=sys.stderr)
        return 1
    if not isinstance(doc, dict):
        print("error: 顶层必须是对象", file=sys.stderr)
        return 1
    queries = q_content.split("\n")
    if queries and queries[-1] == "":
        queries.pop()
    found = 0
    missing = 0
    for query in queries:
        cur = doc
        for seg in query.split("."):
            if cur is not None:
                cur = step(cur, seg)
            if cur is None:
                break
        if cur is None:
            print(query + " = MISSING")
            missing += 1
        else:
            print(query + " = " + render_value(cur))
            found += 1
    print("found=%d missing=%d" % (found, missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
