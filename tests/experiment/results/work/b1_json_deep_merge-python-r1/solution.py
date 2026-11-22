import json
import sys

sys.setrecursionlimit(10000)


def fail(msg):
    line = "error: " + msg + "\n"
    try:
        sys.stderr.buffer.write(line.encode("utf-8", "replace"))
        sys.stderr.buffer.flush()
    except Exception:
        pass
    sys.exit(1)


def load_doc(path):
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as exc:
        fail("cannot read file <" + str(path) + ">: " + str(exc))
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        fail("file is not valid UTF-8 text <" + str(path) + ">")
    try:
        doc = json.loads(text)
    except ValueError as exc:
        fail("JSON parse failed in <" + str(path) + ">: " + str(exc))
    if not isinstance(doc, dict):
        fail("top level is not a JSON object in <" + str(path) + ">")
    return doc


def deep_merge(a, b):
    out = {}
    for key, av in a.items():
        if key in b:
            bv = b[key]
            if isinstance(av, dict) and isinstance(bv, dict):
                out[key] = deep_merge(av, bv)
            else:
                out[key] = bv
        else:
            out[key] = av
    for key, bv in b.items():
        if key not in a:
            out[key] = bv
    return out


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        fail("missing arguments: need 2 JSON document paths (A B)")
    doc_a = load_doc(args[0])
    doc_b = load_doc(args[1])
    merged = deep_merge(doc_a, doc_b)
    line = json.dumps(merged, separators=(",", ":")) + "\n"
    out = sys.stdout.buffer
    out.write(line.encode("utf-8"))
    out.flush()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except RecursionError:
        fail("input nested too deep")
    except Exception as exc:
        fail("internal error: " + str(exc))
