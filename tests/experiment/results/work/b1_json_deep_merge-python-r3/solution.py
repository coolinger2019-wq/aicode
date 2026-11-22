import sys
import json


def fail(msg):
    sys.stderr.write("error: " + msg + "\n")
    sys.exit(1)


def load_doc(path):
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        fail("cannot read file: " + path)
    try:
        doc = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        fail("invalid JSON: " + path)
    if not isinstance(doc, dict):
        fail("top level is not a JSON object: " + path)
    return doc


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


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        fail("missing arguments: need paths of document A and document B")
    a = load_doc(args[0])
    b = load_doc(args[1])
    merged = deep_merge(a, b)
    out = json.dumps(merged, separators=(",", ":")).encode("utf-8") + b"\n"
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
