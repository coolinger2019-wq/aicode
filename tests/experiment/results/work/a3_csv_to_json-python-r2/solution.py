"""CSV -> JSON 转换。

用法: python solution.py <csv-path>
方言固定: 逗号逐字节分隔, 无引号无转义; 第 1 行为表头; 所有值按字符串处理。
输出单行紧凑 JSON: {"rows":[...],"errors":[...]}, 退出码 0。
参数缺失或文件不可读: 向 stderr 输出一行以 error: 开头的消息, 退出码 1, stdout 为空。
"""

import json
import sys


def fail(msg: str) -> int:
    sys.stderr.buffer.write(("error: " + msg + "\n").encode("utf-8", "replace"))
    return 1


def main() -> int:
    argv = sys.argv[1:]
    if len(argv) < 1:
        return fail("missing csv file path argument")
    path = argv[0]
    try:
        with open(path, "r", encoding="utf-8", newline=None) as fh:
            content = fh.read()
    except (OSError, ValueError) as exc:
        return fail("cannot read csv file: " + str(exc))

    lines = content.split("\n")
    if lines and lines[-1] == "":
        lines.pop()  # 末尾换行产生的空行不计为一行

    rows = []
    errors = []
    if lines:
        header = lines[0].split(",")
        want = len(header)
        for idx in range(1, len(lines)):
            fields = lines[idx].split(",")
            if len(fields) == want:
                rows.append(dict(zip(header, fields)))
            else:
                errors.append({"line": idx + 1, "got": len(fields), "want": want})

    result = {"rows": rows, "errors": errors}
    out = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.buffer.write(out.encode("utf-8") + b"\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
