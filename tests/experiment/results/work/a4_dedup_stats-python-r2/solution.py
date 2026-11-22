#!/usr/bin/env python3
"""去重统计:合并统计分块目录中 chunk_*.txt 每行出现次数,输出去重统计与 Top-3。

用法: python solution.py <分块目录>
"""

import fnmatch
import os
import sys

PATTERN = "chunk_*.txt"


def one_line(text):
    # 保证错误消息严格单行(意外换行折叠为空格)。
    return " ".join(text.split())


def fail(msg):
    # 错误协议:stderr 输出一行以 "error:" 开头的消息,退出码 1,stdout 保持为空。
    try:
        payload = ("error: " + one_line(msg) + "\n").encode("utf-8", "backslashreplace")
        sys.stderr.buffer.write(payload)
        sys.stderr.buffer.flush()
    except Exception:
        pass
    raise SystemExit(1)


def byte_key(text):
    # 字节序(UTF-8 字节)比较键;ASCII 名称/行内容下与 ASCII 序一致。
    return text.encode("utf-8", "surrogateescape")


def main(argv):
    if len(argv) < 1:
        fail("missing argument: chunk directory")
    directory = argv[0]
    try:
        names = os.listdir(directory)
    except OSError as exc:
        fail("cannot read directory: " + str(exc))

    # 参与统计的文件 = 名称匹配 chunk_*.txt 的条目,按名称字节序升序处理。
    targets = [n for n in names if fnmatch.fnmatchcase(n, PATTERN)]
    targets.sort(key=byte_key)

    counts = {}
    for name in targets:
        path = os.path.join(directory, name)
        try:
            with open(path, "rb") as handle:
                raw = handle.read()
        except OSError as exc:
            fail("cannot read file " + name + ": " + str(exc))
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            fail("cannot read file " + name + ": invalid utf-8")
        lines = text.split("\n")
        if lines and lines[-1] == "":
            # 末尾换行产生的空行不计为一行。
            lines.pop()
        for line in lines:
            counts[line] = counts.get(line, 0) + 1

    total = sum(counts.values())
    unique = len(counts)
    repeated = 0
    for cnt in counts.values():
        if cnt > 1:
            repeated += 1

    # Top-3:次数降序;次数并列按行内容字节序升序。
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], byte_key(kv[0])))

    out_lines = [
        "total=" + str(total),
        "unique=" + str(unique),
        "repeated=" + str(repeated),
    ]
    for idx, (line, cnt) in enumerate(ranked[:3]):
        out_lines.append("top" + str(idx + 1) + " " + line + " " + str(cnt))

    payload = ("\n".join(out_lines) + "\n").encode("utf-8")
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # 兜底:意外异常仍走错误协议且 stdout 为空
        fail("internal error: " + str(exc))
