import sys


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 1:
        sys.stderr.write("error: missing file argument\n")
        return 1
    path = args[0]
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        sys.stderr.write("error: cannot read file\n")
        return 1
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        sys.stderr.write("error: file is not valid UTF-8\n")
        return 1
    words = text.split()
    counts = {}
    for w in words:
        counts[w] = counts.get(w, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].encode("utf-8")))
    lines = [w + " " + str(c) + "\n" for w, c in ranked[:5]]
    sys.stdout.buffer.write("".join(lines).encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
