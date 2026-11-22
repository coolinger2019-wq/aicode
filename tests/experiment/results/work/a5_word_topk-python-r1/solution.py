import sys


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 1:
        sys.stderr.write("error: missing input file path\n")
        return 1
    path = args[0]
    try:
        with open(path, "rb") as f:
            data = f.read()
        text = data.decode("utf-8-sig")
    except (OSError, UnicodeDecodeError):
        sys.stderr.write("error: cannot read input file\n")
        return 1
    counts: dict[str, int] = {}
    for w in text.split():
        counts[w] = counts.get(w, 0) + 1
    items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    lines = [w + " " + str(n) for (w, n) in items[:5]]
    if lines:
        sys.stdout.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
