# 词频 Top-K:读取文本文件,按空白切词,统计词频,输出次数最多的前 5 个词。
# 用法: python solution.py <文本文件路径>
# 规则: 次数降序;次数并列按词升序(字节序);不同词不足 5 个时输出实际数量。
# 错误: 参数缺失或文件不可读 -> 向 stderr 输出一行 error: 开头的消息,退出码 1。
import sys

K = 5


def fail(message: str) -> int:
    sys.stderr.write("error: " + message + "\n")
    return 1


def main() -> int:
    if len(sys.argv) < 2:
        return fail("missing file argument")
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return fail("cannot read file")
    except UnicodeDecodeError:
        return fail("file is not valid UTF-8")
    counts = {}
    for word in text.split():
        counts[word] = counts.get(word, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    lines = []
    for word, count in ranked[:K]:
        lines.append(word + " " + str(count))
    if lines:
        sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
