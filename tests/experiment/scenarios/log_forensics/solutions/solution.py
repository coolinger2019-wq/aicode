# S1 日志取证 — 参考实现(Python 3.10)。
# 与 solution.ming 同一语义:行分类顺序 空行→overlong→ctrl-char→JSON/文本;
# 控制符集合 C0(含 \t)/DEL/C1/双向控制符;值域 [A-Za-z0-9_.-]+;级别整段等值。
# 越值域判定用 fullmatch(不用 $ 后缀——Python $ 会在尾随换行前匹配,与 TS/Ming 不同)。
import json
import re
import sys

LEVELS = ("INFO", "WARN", "ERROR", "DEBUG")
DOMAIN = re.compile(r"[A-Za-z0-9_.-]+")
OVERLONG = 4096


def malformed():
    return (0, "", "", "")


def is_ctrl_char(s):
    for ch in s:
        c = ord(ch)
        if c <= 0x1F or c == 0x7F or 0x80 <= c <= 0x9F or 0x202A <= c <= 0x202E:
            return True
    return False


def classify_json(line):
    try:
        doc = json.loads(line)
    except ValueError:
        return malformed()
    if not isinstance(doc, dict):
        return malformed()
    lvl = doc.get("level")
    act = doc.get("actor")
    evt = doc.get("event")
    if not (isinstance(lvl, str) and isinstance(act, str) and isinstance(evt, str)):
        return malformed()
    if lvl not in LEVELS or DOMAIN.fullmatch(act) is None or DOMAIN.fullmatch(evt) is None:
        return malformed()
    if lvl in ("WARN", "ERROR"):
        return (1, lvl, act, evt)
    return (2, lvl, act, evt)


def classify_text(clean):
    parts = clean.split(" ")
    if len(parts) < 5:
        return malformed()
    lvl, act, evt = parts[1], parts[2], parts[3]
    if lvl not in LEVELS or DOMAIN.fullmatch(act) is None or DOMAIN.fullmatch(evt) is None:
        return malformed()
    if lvl in ("WARN", "ERROR"):
        return (1, lvl, act, evt)
    return (2, lvl, act, evt)


def main():
    if len(sys.argv) < 3:
        print("error: 需要 <input.log> <report.txt> 两个参数", file=sys.stderr)
        return 1
    in_path, out_path = sys.argv[1], sys.argv[2]
    try:
        with open(in_path, "r", encoding="utf-8", newline="") as f:
            content = f.read()
    except OSError:
        print("error: 无法读取 " + in_path, file=sys.stderr)
        return 1
    lines = content.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    events = rejected = info = skipped = 0
    ereport, rreport = [], []
    for i, line in enumerate(lines):
        lineno = i + 1
        if line == "":
            skipped += 1
            continue
        if len(line) > OVERLONG:
            rejected += 1
            rreport.append("R %d overlong" % lineno)
            continue
        if is_ctrl_char(line):
            rejected += 1
            rreport.append("R %d ctrl-char" % lineno)
            continue
        if line.startswith("{"):
            oc = classify_json(line)
        else:
            oc = classify_text(line)
        if oc[0] == 1:
            events += 1
            ereport.append("E %d %s %s %s" % (lineno, oc[1], oc[2], oc[3]))
        elif oc[0] == 2:
            info += 1
        else:
            rejected += 1
            rreport.append("R %d malformed" % lineno)
    report = "report " + in_path + "\n"
    for e in ereport:
        report += e + "\n"
    for r in rreport:
        report += r + "\n"
    try:
        with open(out_path, "w", encoding="utf-8", newline="") as f:
            f.write(report)
    except OSError:
        print("error: 无法写入报告 " + out_path, file=sys.stderr)
        return 1
    print(
        "summary events=%d rejected=%d info=%d skipped=%d total=%d"
        % (events, rejected, info, skipped, len(lines))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
