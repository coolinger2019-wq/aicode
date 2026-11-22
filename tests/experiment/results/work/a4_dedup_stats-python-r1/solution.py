"""去重统计：合并统计分块文本目录中 chunk_*.txt 的行出现次数。

用法: python solution.py <chunk_dir>
"""

import fnmatch
import os
import sys
from collections import Counter


def fail(msg):
    # 错误行为: stderr 一行以 error: 开头, 退出码 1, stdout 保持为空。
    sys.stderr.buffer.write(("error: " + msg + "\n").encode("utf-8", "replace"))
    sys.stderr.buffer.flush()
    sys.exit(1)


def split_lines(text):
    # \n 分行; 末尾换行产生的空行不计为一行。
    if text.endswith("\n"):
        text = text[:-1]
    if text == "":
        return []
    return text.split("\n")


def main(argv):
    if len(argv) < 2:
        fail("missing directory argument")
    d = argv[1]
    if not os.path.isdir(d):
        fail("directory not readable: " + d)
    try:
        entries = os.listdir(d)
    except OSError:
        fail("directory not readable: " + d)
    names = [n for n in entries if fnmatch.fnmatchcase(n, "chunk_*.txt")]
    # 按名称字节序(ASCII)升序处理。
    names.sort(key=lambda s: s.encode("utf-8", "surrogateescape"))
    counts = Counter()
    for name in names:
        path = os.path.join(d, name)
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            fail("file not readable: " + name)
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            fail("file not readable: " + name)
        counts.update(split_lines(text))
    total = sum(counts.values())
    unique = len(counts)
    repeated = sum(1 for c in counts.values() if c > 1)
    # Top-3: 次数降序; 并列按行内容升序(字节序)。
    top = sorted(
        counts.items(),
        key=lambda kv: (-kv[1], kv[0].encode("utf-8", "surrogateescape")),
    )[:3]
    out = []
    out.append("total=" + str(total))
    out.append("unique=" + str(unique))
    out.append("repeated=" + str(repeated))
    for i, (line, cnt) in enumerate(top, 1):
        out.append("top" + str(i) + " " + line + " " + str(cnt))
    sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main(sys.argv)
