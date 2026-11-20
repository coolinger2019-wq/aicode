# B2 数据校验管线 — 参考实现(Python 3.10)
import json
import sys

ROLES = ("admin", "user", "guest")


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def valid_id(rec) -> bool:
    return is_num(rec.get("id")) and rec.get("id") >= 1


def valid_email(rec) -> bool:
    v = rec.get("email")
    return isinstance(v, str) and "@" in v


def valid_age(rec) -> bool:
    v = rec.get("age")
    return is_num(v) and 0 <= v <= 150


def valid_role(rec) -> bool:
    return rec.get("role") in ROLES


def main() -> int:
    if len(sys.argv) < 2:
        print("error: 需要记录文件路径", file=sys.stderr)
        return 1
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        print("error: 文件不可读或 JSON 解析失败", file=sys.stderr)
        return 1
    if not isinstance(doc, list):
        print("error: 顶层必须是数组", file=sys.stderr)
        return 1
    ok = 0
    failed = 0
    for i, item in enumerate(doc):
        if not isinstance(item, dict):
            print("record %d id invalid; email invalid; age invalid; role invalid" % (i + 1))
            failed += 1
            continue
        parts = []
        if not valid_id(item):
            parts.append("id invalid")
        if not valid_email(item):
            parts.append("email invalid")
        if not valid_age(item):
            parts.append("age invalid")
        if not valid_role(item):
            parts.append("role invalid")
        if not parts:
            print("record %d ok" % (i + 1))
            ok += 1
        else:
            print("record %d %s" % (i + 1, "; ".join(parts)))
            failed += 1
    print("ok=%d failed=%d" % (ok, failed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
