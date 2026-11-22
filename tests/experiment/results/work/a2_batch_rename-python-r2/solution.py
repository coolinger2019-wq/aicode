# Batch rename: copy files from an input directory into an output directory
# under fixed rename rules, printing the plan to stdout (see task prompt).
# Python 3.10, standard library only, deterministic output.
import os
import re
import sys

REPORT_RE = re.compile(r"report_[0-9]+\.txt")
I64_MAX = (1 << 63) - 1


def fail(msg):
    sys.stderr.write("error: " + msg + "\n")
    sys.exit(1)


def sort_names_ascii(names):
    # ASCII byte order, ascending (names are guaranteed ASCII; be exact anyway).
    return sorted(names, key=lambda n: n.encode("utf-8", "surrogateescape"))


def main():
    if len(sys.argv) < 3:
        fail("usage: python solution.py <input_dir> <output_dir>")
    in_dir = sys.argv[1]
    out_dir = sys.argv[2]

    try:
        names = sort_names_ascii(os.listdir(in_dir))
    except OSError as e:
        fail("cannot read input directory '%s': %s" % (in_dir, e))

    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as e:
        fail("cannot create output directory '%s': %s" % (out_dir, e))

    plan = []
    occupied = set()

    for name in names:
        rule = None
        target = None

        m = REPORT_RE.fullmatch(name)
        if m:
            try:
                value = int(name[7:-4])
            except ValueError:
                value = None
            if value is not None and value <= I64_MAX:
                rule = 1
                target = "report-" + str(value).zfill(2) + ".txt"
        if rule is None and name.endswith(".log"):
            rule = 2
            target = "logs/" + name

        if rule is None:
            plan.append("SKIP " + name + " nomatch")
            continue

        if target in occupied:
            plan.append("SKIP " + name + " conflict " + target)
            continue

        src = os.path.join(in_dir, name)
        dst = os.path.join(out_dir, *target.split("/"))
        try:
            parent = os.path.dirname(dst)
            if parent and not os.path.isdir(parent):
                os.makedirs(parent, exist_ok=True)
            with open(src, "rb") as fin:
                data = fin.read()
            with open(dst, "wb") as fout:
                fout.write(data)
        except OSError as e:
            fail("cannot write '%s': %s" % (target, e))

        occupied.add(target)
        if rule == 1:
            plan.append("OK " + name + " -> " + target)
        else:
            plan.append("DIR " + name + " -> " + target)

    out_bytes = "".join(line + "\n" for line in plan).encode("utf-8")
    sys.stdout.buffer.write(out_bytes)
    sys.stdout.buffer.flush()
    sys.exit(0)


main()
