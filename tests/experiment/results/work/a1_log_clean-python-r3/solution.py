import sys

LEVELS = ("INFO", "WARN", "ERROR", "DEBUG")


def fail(msg):
    try:
        sys.stderr.buffer.write(("error: " + msg + "\n").encode("utf-8", "replace"))
        sys.stderr.buffer.flush()
    except Exception:
        pass
    sys.exit(1)


def main():
    argv = sys.argv[1:]
    if len(argv) < 1:
        fail("missing log file path argument")
    path = argv[0]
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as e:
        fail("cannot read file: " + path + " (" + str(e) + ")")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        fail("file is not valid utf-8: " + str(e))

    lines = text.split("\n")
    if len(lines) > 0 and lines[-1] == "":
        lines.pop()

    counts = {"INFO": 0, "WARN": 0, "ERROR": 0, "DEBUG": 0}
    skipped = 0
    kept = []
    for line in lines:
        parts = line.split(" ")
        if len(parts) < 5 or parts[1] not in LEVELS:
            skipped += 1
            continue
        user_val = None
        action_val = None
        for p in parts:
            if user_val is None and p.startswith("user="):
                user_val = p[5:]
            elif action_val is None and p.startswith("action="):
                action_val = p[7:]
        if user_val is None or action_val is None:
            skipped += 1
            continue
        counts[parts[1]] += 1
        if parts[1] == "DEBUG":
            continue
        kept.append(user_val + " " + action_val)

    out_lines = list(kept)
    out_lines.append(
        "summary INFO=" + str(counts["INFO"])
        + " WARN=" + str(counts["WARN"])
        + " ERROR=" + str(counts["ERROR"])
        + " DEBUG=" + str(counts["DEBUG"])
        + " skipped=" + str(skipped)
    )
    sys.stdout.buffer.write(("\n".join(out_lines) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()
    sys.exit(0)


main()
