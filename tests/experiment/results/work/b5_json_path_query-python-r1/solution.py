# 任务 b5_json_path_query:嵌套 JSON 路径查询
# 读入 JSON 文档与点路径查询文件,逐段下钻取值,按固定规则渲染并汇总。
import sys
import json


def render_value(value):
    # 布尔必须在整数之前判断(bool 是 int 的子类)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return json.dumps(value)
    return json.dumps(value, separators=(",", ":"))


def is_pure_digits(seg):
    if seg == "":
        return False
    for ch in seg:
        if ch < "0" or ch > "9":
            return False
    return True


def fail(message):
    sys.stderr.write("error: " + message + "\n")
    sys.exit(1)


def read_text(path):
    with open(path, "rb") as handle:
        data = handle.read()
    return data.decode("utf-8-sig")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    argv = sys.argv
    if len(argv) < 3:
        fail("need 2 arguments: <json doc> <query file>")
    try:
        doc_text = read_text(argv[1])
    except (OSError, UnicodeDecodeError):
        fail("cannot read json document")
    try:
        doc = json.loads(doc_text)
    except ValueError:
        fail("json parse failed")
    if not isinstance(doc, dict):
        fail("document top level is not an object")
    try:
        query_text = read_text(argv[2])
    except (OSError, UnicodeDecodeError):
        fail("cannot read query file")

    lines = query_text.split("\n")
    lines = [line[:-1] if line.endswith("\r") else line for line in lines]
    while lines and lines[-1] == "":
        lines.pop()

    out_lines = []
    found = 0
    missing = 0
    for line in lines:
        cur = doc
        ok = True
        for seg in line.split("."):
            if is_pure_digits(seg) and isinstance(cur, list):
                idx = int(seg)
                if idx < len(cur):
                    cur = cur[idx]
                else:
                    ok = False
                    break
            elif isinstance(cur, dict) and not is_pure_digits(seg):
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
            out_lines.append(line + " = " + render_value(cur))
        else:
            missing += 1
            out_lines.append(line + " = MISSING")
    out_lines.append("found=" + str(found) + " missing=" + str(missing))
    sys.stdout.write("\n".join(out_lines) + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
