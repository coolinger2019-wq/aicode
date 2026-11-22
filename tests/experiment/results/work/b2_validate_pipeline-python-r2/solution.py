import json
import math
import sys

FIELD_ORDER = ("id", "email", "age", "role")
ROLES = ("admin", "user", "guest")


def is_number(v):
    # JSON 数值 = int/float；排除 bool（JSON true/false 不是数值）与非有限值。
    return (
        isinstance(v, (int, float))
        and not isinstance(v, bool)
        and math.isfinite(v)
    )


def fail(msg):
    sys.stderr.write("error: " + msg + "\n")
    sys.exit(1)


def field_valid(name, rec):
    if name not in rec:
        return False
    v = rec[name]
    if name == "id":
        return is_number(v) and v >= 1
    if name == "email":
        return isinstance(v, str) and "@" in v
    if name == "age":
        return is_number(v) and 0 <= v <= 150
    if name == "role":
        return isinstance(v, str) and v in ROLES
    return False


def check_record(rec):
    # 非 dict 记录：四个字段均视为不存在 → 全部 invalid（不短路）。
    if not isinstance(rec, dict):
        return False, list(FIELD_ORDER)
    bad = [name for name in FIELD_ORDER if not field_valid(name, rec)]
    return (not bad), bad


def main():
    args = sys.argv[1:]
    if not args:
        fail("missing argument: records file path")
    path = args[0]
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            text = f.read()
    except OSError as e:
        fail("cannot read file: " + str(e))
    except UnicodeDecodeError as e:
        fail("cannot decode file: " + str(e))
    try:
        data = json.loads(text)
    except ValueError as e:
        fail("invalid JSON: " + str(e))
    if not isinstance(data, list):
        fail("top-level value is not an array")

    ok_count = 0
    failed_count = 0
    lines = []
    for i, rec in enumerate(data, start=1):
        ok, bad = check_record(rec)
        if ok:
            ok_count += 1
            lines.append("record %d ok" % i)
        else:
            failed_count += 1
            parts = ["%s invalid" % name for name in bad]
            lines.append("record %d %s" % (i, "; ".join(parts)))
    lines.append("ok=%d failed=%d" % (ok_count, failed_count))

    # 直接写字节，避免 Windows 文本模式把 \n 翻译成 \r\n（验收逐字节比对）。
    sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
