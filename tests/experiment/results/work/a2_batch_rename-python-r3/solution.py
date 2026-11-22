# 批量改名:输入目录 -> 输出目录,按文件名字节序(ASCII)升序处理并打印改名计划。
# 规则(按序匹配,一条命中即止):
#   R1 report_<digits>.txt -> report-<NN>.txt(数值不足 2 位左补 0;超 64 位有符号整数范围则落 R3)
#   R2 *.log -> logs/<名>(logs/ 仅在存在 R2 命中时创建)
#   R3 其他 -> 不写文件
# 冲突:目标相对路径已被更早处理的项占用 -> 跳过不写;占用登记只登记成功写入项。
import os
import re
import sys

I64_MAX = 2 ** 63 - 1
R1_RE = re.compile(r"^report_([0-9]+)\.txt$")


def fail(msg):
    sys.stderr.write("error: " + msg + "\n")
    sys.exit(1)


def main():
    if len(sys.argv) < 3:
        fail("usage: solution.py <input-dir> <output-dir>")
    indir = sys.argv[1]
    outdir = sys.argv[2]

    if not os.path.isdir(indir):
        fail("cannot read input directory: " + indir)
    try:
        names = os.listdir(indir)
    except OSError:
        fail("cannot read input directory: " + indir)

    # 输入条目全为文件(防御性过滤);按文件名字节序升序,保证输出顺序确定
    names = [n for n in names if os.path.isfile(os.path.join(indir, n))]
    names.sort(key=lambda s: s.encode("utf-8", "surrogateescape"))

    try:
        os.makedirs(outdir, exist_ok=True)
    except OSError:
        fail("cannot create output directory: " + outdir)

    occupied = set()
    lines = []
    for name in names:
        target = None
        kind = None
        m = R1_RE.match(name)
        if m:
            digits = m.group(1)
            stripped = digits.lstrip("0")
            val = None
            if stripped == "":
                val = 0
            elif len(stripped) <= 19:
                # 去前导零后 >19 位必超 64 位;<=19 位再按数值比较
                v = int(stripped)
                if v <= I64_MAX:
                    val = v
            if val is not None:
                target = "report-" + str(val).zfill(2) + ".txt"
                kind = "R1"
        if kind is None and name.endswith(".log"):
            target = "logs/" + name
            kind = "R2"
        if kind is None:
            lines.append("SKIP " + name + " nomatch")
            continue
        if target in occupied:
            lines.append("SKIP " + name + " conflict " + target)
            continue
        parts = target.split("/")
        dest = os.path.join(outdir, *parts)
        try:
            if kind == "R2":
                os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(os.path.join(indir, name), "rb") as f:
                data = f.read()
            with open(dest, "wb") as f:
                f.write(data)
        except OSError:
            fail("cannot copy file to: " + dest)
        occupied.add(target)
        if kind == "R1":
            lines.append("OK " + name + " -> " + target)
        else:
            lines.append("DIR " + name + " -> " + target)

    out = "".join(line + "\n" for line in lines)
    sys.stdout.buffer.write(out.encode("utf-8"))
    sys.stdout.buffer.flush()
    sys.exit(0)


if __name__ == "__main__":
    main()
