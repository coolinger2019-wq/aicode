import sys

LEVELS = ("INFO", "WARN", "ERROR", "DEBUG")


def is_log_line(parts):
    if len(parts) < 5:
        return False
    if parts[1] not in LEVELS:
        return False
    has_user = False
    has_action = False
    for p in parts:
        if p.startswith("user="):
            has_user = True
        if p.startswith("action="):
            has_action = True
    return has_user and has_action


def field_value(parts, prefix):
    for p in parts:
        if p.startswith(prefix):
            return p[len(prefix):]
    return "-"


def strip_cr(line):
    if line.endswith("\r"):
        return line[:-1]
    return line


def fail(msg):
    sys.stderr.buffer.write(("error: " + msg + "\n").encode("utf-8", "replace"))
    sys.stderr.buffer.flush()
    return 1


def main():
    if len(sys.argv) < 2:
        return fail("missing log file argument")
    path = sys.argv[1]
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as exc:
        return fail("cannot read file: " + str(exc))
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return fail("file is not valid UTF-8 text")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    kept = []
    counts = {"INFO": 0, "WARN": 0, "ERROR": 0, "DEBUG": 0}
    skipped = 0
    for raw in lines:
        line = strip_cr(raw)
        parts = line.split(" ")
        if is_log_line(parts):
            counts[parts[1]] += 1
            if parts[1] != "DEBUG":
                user = field_value(parts, "user=")
                action = field_value(parts, "action=")
                kept.append(user + " " + action)
        else:
            skipped += 1
    out = []
    for row in kept:
        out.append(row)
    out.append(
        "summary INFO=%d WARN=%d ERROR=%d DEBUG=%d skipped=%d"
        % (counts["INFO"], counts["WARN"], counts["ERROR"], counts["DEBUG"], skipped)
    )
    payload = "".join(s + "\n" for s in out)
    sys.stdout.buffer.write(payload.encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
