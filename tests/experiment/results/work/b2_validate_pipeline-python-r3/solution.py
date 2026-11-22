"""数据校验管线:按固定 schema 校验 JSON 记录数组,输出逐记录结果行与汇总。

用法: python solution.py <记录文件路径>
"""

import json
import sys


def is_number(value):
    # JSON 数值 = int/float;bool 是 int 的子类,但 JSON 布尔不是数值。
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# Schema 固定;字段检查顺序 id → email → age → role,全字段检查、不短路。
FIELDS = [
    ("id", lambda v: is_number(v) and v >= 1),
    ("email", lambda v: isinstance(v, str) and "@" in v),
    ("age", lambda v: is_number(v) and 0 <= v <= 150),
    ("role", lambda v: isinstance(v, str) and v in ("admin", "user", "guest")),
]


def invalid_fields(record):
    """返回按检查顺序排列的无效字段名列表(字段缺失或值不满足条件均无效)。"""
    bad = []
    for name, pred in FIELDS:
        if not (isinstance(record, dict) and name in record and pred(record[name])):
            bad.append(name)
    return bad


def fail(message):
    sys.stderr.write("error: " + message + "\n")
    return 1


def main(argv):
    if len(argv) < 2:
        return fail("missing argument: records file path")
    path = argv[1]
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            text = handle.read()
    except (OSError, UnicodeDecodeError):
        return fail("cannot read file: " + path)
    try:
        records = json.loads(text)
    except ValueError:
        return fail("invalid JSON")
    if not isinstance(records, list):
        return fail("top level is not a JSON array")

    ok_count = 0
    failed_count = 0
    lines = []
    for index, record in enumerate(records, 1):
        bad = invalid_fields(record)
        if bad:
            failed_count += 1
            joined = "; ".join(name + " invalid" for name in bad)
            lines.append(f"record {index} {joined}")
        else:
            ok_count += 1
            lines.append(f"record {index} ok")
    lines.append(f"ok={ok_count} failed={failed_count}")
    sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
