# S3 协议解析器 — 参考实现(Python 3 标准库)。
# 与 solution.ming 同一语义(spec §2.2/§3):字节层(os.stat 门禁 65536 +
# rb 4096 分段计数)→ 解析层(errors="replace" 解码,无效字节 → U+FFFD,
# 与 Ming/Node 探针对齐)→ 逐行判定(首条命中即停)→ 逐帧状态行 + summary。
# 码点口径:Python str 索引/切片即码点(与 Ming char_len/slice_chars 一致);
# 大端组装与 Fletcher-16 在整数域手工完成。
# 参数级错误 → stderr `error:` 一行 + exit 1(stdout 空);bad > 0 → exit 1。
import os
import sys

MAX_PAYLOAD = 4096
MAX_INPUT = 65536
CHUNK = 4096
NIB = {c: i for i, c in enumerate("0123456789abcdef")}
STATUS = ["", "BAD_MAGIC", "BAD_HEX", "BAD_TYPE", "BAD_LENGTH", "TRUNCATED", "TRAILING", "CRC_MISMATCH"]


def fail(msg):
    sys.stderr.write("error: " + msg + "\n")
    sys.exit(1)


def nibble(ch):
    return NIB.get(ch, -1)


def byte_at(line, off):
    return (nibble(line[off]) << 4) | nibble(line[off + 1])


def type_name(ty):
    if ty == 1:
        return "DATA"
    if ty == 2:
        return "CTRL"
    return "KEEPALIVE"


def flags_str(f):
    names = []
    if (f & 1) == 1:
        names.append("ACK_REQ")
    if (f & 2) == 2:
        names.append("FRAG")
    if len(names) == 0:
        return "none"
    return ",".join(names)


def classify(line):
    """逐行判定:0 = OK,否则 STATUS[code];OK 时回填 ty/flags/len。"""
    clen = len(line)

    def bad(code):
        return (code, 0, 0, 0)

    if clen < 16:
        return bad(5)
    if line[0:4] != "4d47":
        return bad(1)
    for k in range(4, clen):
        if nibble(line[k]) < 0:
            return bad(2)
    ty = byte_at(line, 4)
    if ty not in (1, 2, 3):
        return bad(3)
    flags = byte_at(line, 6)
    b = [byte_at(line, 8 + 2 * j) for j in range(4)]
    length = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]
    if length > MAX_PAYLOAD:
        return bad(4)
    expected = 20 + length * 2
    if clen < expected:
        return bad(5)
    if clen > expected:
        return bad(6)
    # 重建帧字节(校验和覆盖域 = type||flags||length||payload),Fletcher-16
    fr = [ty, flags] + b + [byte_at(line, 16 + 2 * j) for j in range(length)]
    s1 = 0
    s2 = 0
    for x in fr:
        s1 = (s1 + x) % 255
        s2 = (s2 + s1) % 255
    off = 16 + length * 2
    stored = (byte_at(line, off) << 8) | byte_at(line, off + 2)
    if ((s2 << 8) | s1) != stored:
        return bad(7)
    return (0, ty, flags, length)


def main():
    argv = sys.argv[1:]
    if len(argv) < 1:
        fail("用法: prog <capture 文件>")
    in_path = argv[0]
    try:
        st = os.stat(in_path)
    except OSError:
        fail("无法读取输入 " + in_path)
    if not os.path.isfile(in_path):
        fail("输入不是普通文件 " + in_path)
    size = st.st_size
    if size > MAX_INPUT:
        fail("输入超过大小门禁 (%d): %d" % (MAX_INPUT, size))
    # 字节层:4096 分段循环(rb;计数 = bytes 字段)
    total = 0
    with open(in_path, "rb") as f:
        while total < size:
            chunk = f.read(CHUNK)
            if len(chunk) == 0:
                fail("分段读取失败 " + in_path)
            total += len(chunk)
    with open(in_path, "r", encoding="utf-8", errors="replace", newline="") as f:
        content = f.read()
    lines_all = content.split("\n")
    n = len(lines_all)
    if n > 0 and lines_all[-1] == "":
        n -= 1
    okc = 0
    badc = 0
    blank = 0
    for i in range(n):
        line = lines_all[i]
        lineno = i + 1
        if len(line) == 0:
            blank += 1
            continue
        code, ty, flags, length = classify(line)
        if code == 0:
            okc += 1
            sys.stdout.write("frame %d OK type=%s flags=%s len=%d\n" % (lineno, type_name(ty), flags_str(flags), length))
        else:
            badc += 1
            sys.stdout.write("frame %d %s\n" % (lineno, STATUS[code]))
    sys.stdout.write("summary lines=%d ok=%d bad=%d blank=%d bytes=%d\n" % (n, okc, badc, blank, total))
    sys.exit(1 if badc > 0 else 0)


main()
