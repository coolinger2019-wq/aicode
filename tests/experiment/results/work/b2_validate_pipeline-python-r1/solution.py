"""数据校验管线：读取 JSON 记录数组，按固定 schema 逐条校验并输出结果。"""

import json
import sys

ROLES = {"admin", "user", "guest"}


def fail(msg):
    # 单行 error: 前缀消息到 stderr，退出码 1，stdout 保持为空
    line = "error: " + str(msg).replace("\r", " ").replace("\n", " ")
    sys.stderr.write(line + "\n")
    sys.exit(1)


def is_number(v):
    # JSON 数值 = int/float；bool 是 int 的子类但不是 JSON 数值
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def invalid_fields(rec):
    # 按 schema 检查顺序 id -> email -> age -> role，全字段检查、不短路
    obj = rec if isinstance(rec, dict) else {}
    bad = []
    if "id" not in obj or not is_number(obj["id"]) or obj["id"] < 1:
        bad.append("id")
    if "email" not in obj or not isinstance(obj["email"], str) or "@" not in obj["email"]:
        bad.append("email")
    if "age" not in obj or not is_number(obj["age"]) or not (0 <= obj["age"] <= 150):
        bad.append("age")
    if "role" not in obj or not isinstance(obj["role"], str) or obj["role"] not in ROLES:
        bad.append("role")
    return bad


def main():
    if len(sys.argv) < 2:
        fail("missing argument: records file path")
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            raw = f.read()
    except (OSError, ValueError) as e:
        fail("cannot read file: " + str(e))
    try:
        data = json.loads(raw)
    except ValueError as e:
        fail("JSON parse failed: " + str(e))
    if not isinstance(data, list):
        fail("top-level JSON value is not an array")

    lines = []
    ok = 0
    failed = 0
    for i, rec in enumerate(data, start=1):
        bad = invalid_fields(rec)
        if bad:
            failed += 1
            lines.append("record %d %s" % (i, "; ".join(f + " invalid" for f in bad)))
        else:
            ok += 1
            lines.append("record %d ok" % i)
    lines.append("ok=%d failed=%d" % (ok, failed))
    sys.stdout.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
