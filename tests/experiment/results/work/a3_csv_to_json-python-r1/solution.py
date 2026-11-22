import sys
import json


def main() -> int:
    args = sys.argv[1:]
    if len(args) != 1:
        sys.stderr.write("error: expected exactly 1 argument (csv path)\n")
        return 1
    path = args[0]
    try:
        with open(path, "rb") as f:
            raw = f.read()
        text = raw.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        sys.stderr.write("error: cannot read file: " + path + "\n")
        return 1
    if text == "":
        lines = []
    else:
        lines = text.split("\n")
        if lines[-1] == "":
            lines.pop()
    rows = []
    errors = []
    if lines:
        header = lines[0].split(",")
        want = len(header)
        for i, line in enumerate(lines[1:], start=2):
            fields = line.split(",")
            if len(fields) == want:
                row = {}
                for k, v in zip(header, fields):
                    row[k] = v
                rows.append(row)
            else:
                errors.append({"line": i, "got": len(fields), "want": want})
    out = {"rows": rows, "errors": errors}
    payload = json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n"
    sys.stdout.buffer.write(payload.encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
