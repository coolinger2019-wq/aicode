# S5 发布打包自举 — 参考实现(Python 3.10)
# 与 Ming 参考实现同一伪代码(spec §3.2/§3.3):结构门禁(argv/目录/五文件可读/提取)
# 先于一切检查行,任一失败 → stdout 空 + stderr 恰一行 error: 开头 + exit 1;四检查
# 全部执行不短路,FAIL 行 + summary 后 exit 1(不触碰 notes 输出路径);全 OK →
# 模板化 release-notes 写盘(CHANGELOG 首条目体逐字落盘)后 exit 0。
# 读写固定 encoding="utf-8" + newline=""(禁平台翻译,三语言逐字节前提,spec §7);
# Python str 下标 = 码点口径,与 Ming index_of/slice_chars 等价。
import json
import os
import re
import sys

EXPECTED_FILES = ["CHANGELOG.md", "cli_source.txt", "guide_head.txt", "package.json", "tag.txt"]


def cli_path_ok(p):
    # std.unstr.sanitize_cli_path 校验面复刻(校验不改写):非空且不含 NUL/C0/DEL/C1/双向控制符
    if p == "":
        return False
    for ch in p:
        c = ord(ch)
        if c < 0x20 or c == 0x7F or 0x80 <= c <= 0x9F:
            return False
        if 0x202A <= c <= 0x202E:
            return False
    return True


def version_triple(v):
    # 版本统一解析为 (major, minor, patch) 三元组;任一段非整数 → None(归结构门禁)
    segs = v.split(".")
    if len(segs) != 3:
        return None
    trip = []
    for seg in segs:
        if not re.fullmatch(r"-?\d+", seg):
            return None
        trip.append(int(seg))
    return trip


def pkg_triple(content):
    try:
        doc = json.loads(content)
    except ValueError:
        return None
    if not isinstance(doc, dict):
        return None
    v = doc.get("version")
    if not isinstance(v, str):
        return None
    return version_triple(v)


def first_line(lines, prefix):
    # 首个满足前缀谓词的行下标(首匹配语义;-1 = 无)
    for i, line in enumerate(lines):
        if line.startswith(prefix):
            return i
    return -1


def cli_triple(content):
    lines = content.split("\n")
    idx = first_line(lines, "const VERSION")
    if idx < 0:
        return None
    line = lines[idx]
    q1 = line.find('"')
    if q1 < 0:
        return None
    rest = line[q1 + 1:]
    q2 = rest.find('"')
    if q2 < 0:
        return None
    return version_triple(rest[:q2])


def guide_triple(content):
    lines = content.split("\n")
    idx = first_line(lines, "### v")
    if idx < 0:
        return None
    tail = lines[idx][5:]
    pos = tail.find("(")
    if pos < 0:
        return None
    return version_triple(tail[:pos])


def changelog_triple(content):
    lines = content.split("\n")
    if len(lines) < 1:
        return None
    first = lines[0]
    if not first.startswith("## v"):
        return None
    tail = first[4:]
    dash = tail.find(" — ")
    if dash < 0:
        return None
    return version_triple(tail[:dash])


def changelog_body(content):
    # CHANGELOG 首条目体:首行之后、下一个 ## 行之前的全部行(保序;notes 体来源)
    lines = content.split("\n")
    body = []
    for line in lines[1:]:
        if line.startswith("## "):
            break
        body.append(line)
    return body


def tag_triple(content):
    t = content.strip()
    if not t.startswith("v"):
        return None
    return version_triple(t[1:])


def trip_eq(a, b):
    if a is None or b is None or len(a) != 3 or len(b) != 3:
        return False
    return a[0] == b[0] and a[1] == b[1] and a[2] == b[2]


def render(t):
    return "%d.%d.%d" % (t[0], t[1], t[2])


def read_opt(path):
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            return f.read()
    except OSError:
        return None


def fail(msg):
    print(msg, file=sys.stderr)
    return 1


def main():
    argv = sys.argv[1:]
    # 结构门禁 1:argv 与路径净化(spec §3.1)
    if len(argv) < 2:
        return fail("error: 需要 <snapshot_dir> <notes_out> 两个参数")
    snap = argv[0]
    if not cli_path_ok(snap):
        return fail("error: 快照目录路径非法")
    out = argv[1]
    if not cli_path_ok(out):
        return fail("error: 输出路径非法")
    if not os.path.isdir(snap):
        return fail("error: 快照目录不存在或非目录: " + snap)

    # 结构门禁 2:五文件逐一可读
    pkg_c = read_opt(os.path.join(snap, "package.json"))
    if pkg_c is None:
        return fail("error: 快照文件缺失或不可读: package.json")
    cli_c = read_opt(os.path.join(snap, "cli_source.txt"))
    if cli_c is None:
        return fail("error: 快照文件缺失或不可读: cli_source.txt")
    guide_c = read_opt(os.path.join(snap, "guide_head.txt"))
    if guide_c is None:
        return fail("error: 快照文件缺失或不可读: guide_head.txt")
    chg_c = read_opt(os.path.join(snap, "CHANGELOG.md"))
    if chg_c is None:
        return fail("error: 快照文件缺失或不可读: CHANGELOG.md")
    tag_c = read_opt(os.path.join(snap, "tag.txt"))
    if tag_c is None:
        return fail("error: 快照文件缺失或不可读: tag.txt")

    # 结构门禁 3:提取失败(package 非 JSON/无 version/version 非 str;cli 无 const
    # VERSION 行或无成对引号;guide 无 ### v 行或缺 ( 终止;CHANGELOG 首行非 ## v 形态
    # 或缺 — 分隔;tag 空/无 v 前缀/三段数字不全为整数)
    pkg_t = pkg_triple(pkg_c)
    if pkg_t is None:
        return fail("error: 提取失败: package.json")
    cli_t = cli_triple(cli_c)
    if cli_t is None:
        return fail("error: 提取失败: cli_source.txt")
    guide_t = guide_triple(guide_c)
    if guide_t is None:
        return fail("error: 提取失败: guide_head.txt")
    chg_t = changelog_triple(chg_c)
    if chg_t is None:
        return fail("error: 提取失败: CHANGELOG.md")
    tag_t = tag_triple(tag_c)
    if tag_t is None:
        return fail("error: 提取失败: tag.txt")

    # 四检查(全部执行,不短路;检查行序固定;值全部净域重构)
    failed = 0
    lines = []
    if trip_eq(pkg_t, cli_t) and trip_eq(pkg_t, guide_t):
        lines.append("check three_place OK")
    else:
        failed += 1
        lines.append("check three_place FAIL package=%s cli=%s guide=%s" % (render(pkg_t), render(cli_t), render(guide_t)))
    if trip_eq(chg_t, pkg_t):
        lines.append("check changelog OK")
    else:
        failed += 1
        lines.append("check changelog FAIL changelog=%s version=%s" % (render(chg_t), render(pkg_t)))
    if trip_eq(tag_t, pkg_t):
        lines.append("check tag OK")
    else:
        failed += 1
        lines.append("check tag FAIL tag=%s version=%s" % (render(tag_t), render(pkg_t)))
    # snapshot_files:期望集之外的条目 → FAIL(extra 名按字节序升序、逗号连接;ASCII 名
    # 域码点排序与字节序一致);无效条目名(控制符)跳过不计 extra——fixture 不触达
    extra = []
    for name in sorted(os.listdir(snap)):
        if not cli_path_ok(name):
            continue
        if name not in EXPECTED_FILES:
            extra.append(name)
    extra.sort()
    if len(extra) == 0:
        lines.append("check snapshot_files OK")
    else:
        failed += 1
        lines.append("check snapshot_files FAIL extra=" + ",".join(extra))
    lines.append("summary checks=4 failed=%d version=%s tag=v%s" % (failed, render(pkg_t), render(tag_t)))
    for l in lines:
        print(l)
    if failed != 0:
        # FAIL 不触碰输出路径(检查未通过不产出 notes,半成品防混入)
        return 1

    # release-notes 生成(仅全部检查 OK;LF;文件以单个 \n 结尾;newline="" 禁翻译)
    notes = "# Release v%s\n\ntag: v%s\nversion: %s\nchangelog: %s\n\n## Changes\n" % (
        render(pkg_t), render(pkg_t), render(pkg_t), render(pkg_t))
    for b in changelog_body(chg_c):
        notes += b + "\n"
    try:
        with open(out, "w", encoding="utf-8", newline="") as f:
            f.write(notes)
    except OSError:
        return fail("error: 无法写入 notes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
