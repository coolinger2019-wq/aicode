import json
import sys


def fail(msg: str) -> int:
    try:
        sys.stderr.write("error: " + msg + "\n")
    except Exception:
        pass
    return 1


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(sys.argv) < 2:
        return fail("missing csv path argument")
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            text = f.read()
    except OSError:
        return fail("cannot read file: " + path)
    except UnicodeDecodeError:
        return fail("invalid utf-8 content: " + path)

    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()

    rows = []
    errors = []
    if lines:
        header = lines[0].split(",")
        want = len(header)
        for i in range(1, len(lines)):
            fields = lines[i].split(",")
            if len(fields) == want:
                row = {}
                for j in range(want):
                    row[header[j]] = fields[j]
                rows.append(row)
            else:
                errors.append({"line": i + 1, "got": len(fields), "want": want})
    out = {"rows": rows, "errors": errors}
    sys.stdout.write(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
