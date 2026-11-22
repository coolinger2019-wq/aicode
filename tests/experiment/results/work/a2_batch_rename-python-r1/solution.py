import os
import re
import sys

INT64_MAX = 9223372036854775807


def fail(msg):
    sys.stderr.buffer.write(("error: " + msg + "\n").encode("utf-8"))
    sys.stderr.buffer.flush()
    sys.exit(1)


def read_file(path):
    with open(path, "rb") as f:
        return f.read()


def write_file(path, data):
    with open(path, "wb") as f:
        f.write(data)


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        fail("missing arguments: <input_dir> <output_dir>")
    in_dir = args[0]
    out_dir = args[1]
    try:
        names = os.listdir(in_dir)
    except OSError:
        fail("cannot read input directory: " + in_dir)
    names.sort()
    out = sys.stdout.buffer
    claimed = set()
    out_made = False
    logs_made = False
    lines = []
    for name in names:
        target = None
        m = re.fullmatch(r"report_([0-9]+)\.txt", name)
        if m is not None:
            n = int(m.group(1))
            if n <= INT64_MAX:
                target = "report-" + format(n, "02d") + ".txt"
        if target is not None:
            if target in claimed:
                lines.append("SKIP " + name + " conflict " + target)
            else:
                if not out_made:
                    os.makedirs(out_dir, exist_ok=True)
                    out_made = True
                write_file(os.path.join(out_dir, target), read_file(os.path.join(in_dir, name)))
                claimed.add(target)
                lines.append("OK " + name + " -> " + target)
        elif name.endswith(".log"):
            rel = "logs/" + name
            if rel in claimed:
                lines.append("SKIP " + name + " conflict " + rel)
            else:
                if not logs_made:
                    os.makedirs(os.path.join(out_dir, "logs"), exist_ok=True)
                    logs_made = True
                    out_made = True
                write_file(os.path.join(out_dir, "logs", name), read_file(os.path.join(in_dir, name)))
                claimed.add(rel)
                lines.append("DIR " + name + " -> " + rel)
        else:
            lines.append("SKIP " + name + " nomatch")
    out.write("".join(ln + "\n" for ln in lines).encode("utf-8"))
    out.flush()
    sys.exit(0)


main()
