# -*- coding: utf-8 -*-
"""日志清洗:判定日志行,提取 user/action,过滤 DEBUG,输出保留行与一行汇总。"""

import sys

LEVELS = ("INFO", "WARN", "ERROR", "DEBUG")

USER_PREFIX = "user="
ACTION_PREFIX = "action="


def fail(message):
    sys.stderr.buffer.write(("error: " + message + "\n").encode("utf-8"))
    sys.stderr.buffer.flush()
    return 1


def classify(line):
    """返回 (level, user, action) 或 None(非日志行)。"""
    parts = line.split(" ")
    if len(parts) < 5 or parts[1] not in LEVELS:
        return None
    user = None
    action = None
    for part in parts:
        if user is None and part.startswith(USER_PREFIX):
            user = part[len(USER_PREFIX):]
        if action is None and part.startswith(ACTION_PREFIX):
            action = part[len(ACTION_PREFIX):]
    if user is None or action is None:
        return None
    return parts[1], user, action


def main(argv):
    if len(argv) < 2:
        return fail("missing log file argument")
    path = argv[1]
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError:
        return fail("cannot read file: " + path)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return fail("file is not valid UTF-8: " + path)

    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()

    counts = {"INFO": 0, "WARN": 0, "ERROR": 0, "DEBUG": 0}
    skipped = 0
    kept_lines = []
    for line in lines:
        if line.endswith("\r"):
            line = line[:-1]
        verdict = classify(line)
        if verdict is None:
            skipped += 1
            continue
        level, user, action = verdict
        counts[level] += 1
        if level == "DEBUG":
            continue
        kept_lines.append(
            (user if user is not None else "-")
            + " "
            + (action if action is not None else "-")
        )

    output = []
    for row in kept_lines:
        output.append(row + "\n")
    output.append(
        "summary INFO=%d WARN=%d ERROR=%d DEBUG=%d skipped=%d\n"
        % (counts["INFO"], counts["WARN"], counts["ERROR"], counts["DEBUG"], skipped)
    )
    sys.stdout.buffer.write("".join(output).encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
