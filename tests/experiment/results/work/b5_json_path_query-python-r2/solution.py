import json
import sys


def fail(msg):
    try:
        data = ("error: " + msg + "\n").encode("utf-8", "replace")
        sys.stderr.buffer.write(data)
        sys.stderr.buffer.flush()
    except Exception:
        pass
    raise SystemExit(1)


def is_digit_seg(seg):
    if not seg:
        return False
    for ch in seg:
        if ch < "0" or ch > "9":
            return False
    return True


def render(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return v
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return json.dumps(v, separators=(",", ":"))
    if isinstance(v, (list, dict)):
        return json.dumps(v, separators=(",", ":"))
    return json.dumps(v, separators=(",", ":"))


def main(argv):
    if len(argv) < 2:
        fail("需要 2 个参数: <json文档路径> <查询文件路径>")
    doc_path = argv[0]
    query_path = argv[1]

    try:
        with open(doc_path, "rb") as f:
            raw = f.read()
    except OSError as e:
        fail("无法读取文档: " + str(e))
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        fail("文档不是有效 UTF-8: " + str(e))
    try:
        doc = json.loads(text)
    except ValueError as e:
        fail("JSON 解析失败: " + str(e))
    if not isinstance(doc, dict):
        fail("文档顶层非对象")

    try:
        with open(query_path, "rb") as f:
            qraw = f.read()
    except OSError as e:
        fail("无法读取查询文件: " + str(e))
    try:
        qtext = qraw.decode("utf-8")
    except UnicodeDecodeError as e:
        fail("查询文件不是有效 UTF-8: " + str(e))

    lines = qtext.split("\n")
    while lines and lines[-1] == "":
        lines.pop()

    out = []
    found = 0
    missing = 0
    for line in lines:
        q = line[:-1] if line.endswith("\r") else line
        cur = doc
        ok = True
        for seg in q.split("."):
            if is_digit_seg(seg):
                if isinstance(cur, list):
                    idx = int(seg)
                    if 0 <= idx < len(cur):
                        cur = cur[idx]
                    else:
                        ok = False
                        break
                else:
                    ok = False
                    break
            else:
                if isinstance(cur, dict):
                    if seg in cur:
                        cur = cur[seg]
                    else:
                        ok = False
                        break
                else:
                    ok = False
                    break
        if ok:
            found += 1
            out.append(q + " = " + render(cur))
        else:
            missing += 1
            out.append(q + " = MISSING")

    out.append("found=" + str(found) + " missing=" + str(missing))
    data = ("\n".join(out) + "\n").encode("utf-8")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    code = main(sys.argv[1:])
    if code != 0:
        raise SystemExit(code)
