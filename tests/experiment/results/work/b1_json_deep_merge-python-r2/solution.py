import json
import sys


def fail(msg):
    sys.stderr.write("error: " + msg + "\n")
    sys.exit(1)


def deep_merge(a, b):
    out = {}
    for k, v in a.items():
        if k in b:
            bv = b[k]
            if isinstance(v, dict) and isinstance(bv, dict):
                out[k] = deep_merge(v, bv)
            else:
                out[k] = bv
        else:
            out[k] = v
    for k, v in b.items():
        if k not in a:
            out[k] = v
    return out


def load_doc(path, label):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except OSError as e:
        fail(label + " 文件不可读: " + str(e))
    except ValueError as e:
        fail(label + " JSON 解析失败: " + str(e))


def main():
    sys.setrecursionlimit(10000)
    if len(sys.argv) < 3:
        fail("参数少于 2: 需要 文档A路径 文档B路径")
    a = load_doc(sys.argv[1], "文档A")
    b = load_doc(sys.argv[2], "文档B")
    if not isinstance(a, dict):
        fail("文档A 顶层不是 JSON 对象")
    if not isinstance(b, dict):
        fail("文档B 顶层不是 JSON 对象")
    merged = deep_merge(a, b)
    text = json.dumps(merged, separators=(",", ":"))
    sys.stdout.buffer.write((text + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
