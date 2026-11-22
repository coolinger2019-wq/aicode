import json
import sys

_MISSING = object()


def fail(msg):
    line = ("error: " + msg).replace("\r", " ").replace("\n", " ")
    sys.stderr.buffer.write((line + "\n").encode("utf-8", "replace"))
    sys.stderr.buffer.flush()
    raise SystemExit(1)


def is_digit_seg(seg):
    if seg == "":
        return False
    for ch in seg:
        if ch < "0" or ch > "9":
            return False
    return True


def render_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return v
    return json.dumps(v, separators=(",", ":"))


def lookup(doc, query):
    cur = doc
    for seg in query.split("."):
        if is_digit_seg(seg):
            # 数字段只对数组当下标, 不会当对象键
            if not isinstance(cur, list):
                return _MISSING
            idx = int(seg)
            if idx >= len(cur):
                return _MISSING
            cur = cur[idx]
        else:
            if not isinstance(cur, dict) or seg not in cur:
                return _MISSING
            cur = cur[seg]
    return cur


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        fail("expected 2 arguments: <doc.json> <queries.txt>")
    doc_path = args[0]
    query_path = args[1]

    try:
        with open(doc_path, "rb") as f:
            doc_bytes = f.read()
    except OSError:
        fail("cannot read document file: " + doc_path)
    try:
        doc = json.loads(doc_bytes)
    except ValueError:
        fail("invalid JSON document: " + doc_path)
    if not isinstance(doc, dict):
        fail("document top-level is not an object")

    try:
        with open(query_path, "rb") as f:
            query_bytes = f.read()
    except OSError:
        fail("cannot read query file: " + query_path)
    try:
        query_text = query_bytes.decode("utf-8-sig")
    except ValueError:
        fail("query file is not valid UTF-8: " + query_path)

    # 每行一条查询; 末尾空行不计
    lines = query_text.split("\n")
    while lines and lines[-1].strip() == "":
        lines.pop()

    out = []
    found = 0
    missing = 0
    for raw in lines:
        q = raw.strip()
        v = lookup(doc, q)
        if v is _MISSING:
            missing += 1
            out.append(q + " = MISSING")
        else:
            found += 1
            out.append(q + " = " + render_value(v))

    out.append("found=" + str(found) + " missing=" + str(missing))
    sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()
    sys.exit(0)


main()
