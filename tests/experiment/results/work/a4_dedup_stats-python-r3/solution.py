import os
import sys


def fail(msg):
    sys.stderr.write("error: " + msg + "\n")
    sys.stderr.flush()
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        fail("missing directory argument")
    root = sys.argv[1]
    try:
        names = os.listdir(root)
    except OSError:
        fail("cannot read directory: " + root)
    names = [n for n in names if n.startswith("chunk_") and n.endswith(".txt")]
    names.sort(key=lambda n: n.encode("utf-8", "surrogateescape"))
    counts = {}
    total = 0
    for name in names:
        path = os.path.join(root, name)
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            fail("cannot read file: " + path)
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            fail("cannot decode file: " + path)
        lines = text.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        for line in lines:
            total += 1
            counts[line] = counts.get(line, 0) + 1
    unique = len(counts)
    repeated = 0
    for c in counts.values():
        if c > 1:
            repeated += 1
    out = []
    out.append("total=" + str(total))
    out.append("unique=" + str(unique))
    out.append("repeated=" + str(repeated))
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].encode("utf-8")))
    i = 1
    for line, cnt in ranked:
        if i > 3:
            break
        out.append("top" + str(i) + " " + line + " " + str(cnt))
        i += 1
    sys.stdout.write("\n".join(out) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
