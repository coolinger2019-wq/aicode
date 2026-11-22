# S2 文件完整性 — 参考实现(Python 3.10)。
# 与 solution.ming 同一语义:gen 扫描单层目录 .txt 普通文件(字节序升序),内容逐行
# 控制符闸(C0 含 \t/DEL/C1/双向,空行不含控制符直接过),净行 join("\n") 重建 →
# hmac_sha256;verify 清单结构损坏 → exit 1,hex 不符 → TAMPERED,状态行按 name
# 字节序混排 + 汇总行,非全 OK exit 1。
import hashlib
import hmac
import os
import re
import sys

NAME_RE = re.compile(r"[a-z0-9_-]+\.txt")
HEX64_RE = re.compile(r"[0-9a-f]{64}")
KEY_RE = re.compile(r"[A-Za-z0-9]+")


def is_ctrl_line(s):
    for ch in s:
        c = ord(ch)
        if c <= 0x1F or c == 0x7F or 0x80 <= c <= 0x9F or 0x202A <= c <= 0x202E:
            return True
    return False


def ctrl_gate(content):
    # 任一行含控制符 → None(REJECTED);否则净行重建(LF 无损)。
    lines = content.split("\n")
    clean = []
    for ln in lines:
        if ln != "" and is_ctrl_line(ln):
            return None
        clean.append(ln)
    return "\n".join(clean)


def hmac_hex(key, content):
    return hmac.new(key.encode("utf-8"), content.encode("utf-8"), hashlib.sha256).hexdigest()


def txt_files(directory):
    names = [
        n
        for n in os.listdir(directory)
        if n.endswith(".txt") and os.path.isfile(os.path.join(directory, n))
    ]
    return sorted(names)


def run_gen(directory, manifest_path, key):
    try:
        names = txt_files(directory)
    except OSError:
        print("error: 无法读取目录 " + directory, file=sys.stderr)
        return 1
    lines = []
    rejected = 0
    for name in names:
        try:
            with open(os.path.join(directory, name), "r", encoding="utf-8", newline="") as f:
                content = f.read()
        except OSError:
            print("error: 文件不可读 " + os.path.join(directory, name), file=sys.stderr)
            return 1
        clean = ctrl_gate(content)
        if clean is None:
            rejected += 1
        else:
            lines.append(name + " " + hmac_hex(key, clean))
    try:
        with open(manifest_path, "w", encoding="utf-8", newline="") as f:
            f.write("\n".join(lines) + "\n")
    except OSError:
        print("error: 无法写入清单 " + manifest_path, file=sys.stderr)
        return 1
    print("manifest %d files rejected=%d" % (len(lines), rejected))
    return 0


def parse_manifest(manifest_path):
    # 结构损坏 → Err 原因(str);hex 与重算不符不在此列(统一归 TAMPERED)。
    try:
        with open(manifest_path, "r", encoding="utf-8", newline="") as f:
            content = f.read()
    except OSError:
        return "无法读取清单"
    lines = content.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    manifest = {}
    for raw in lines:
        if is_ctrl_line(raw):
            return "行含控制字符"
        segs = raw.split(" ")
        if len(segs) != 2 or NAME_RE.fullmatch(segs[0]) is None or HEX64_RE.fullmatch(segs[1]) is None:
            return "行格式非法"
        if segs[0] in manifest:
            return "重复名 " + segs[0]
        manifest[segs[0]] = segs[1]
    return manifest


def run_verify(directory, manifest_path, key):
    parsed = parse_manifest(manifest_path)
    if isinstance(parsed, str):
        print("error: 清单损坏: " + parsed, file=sys.stderr)
        return 1
    ok = tampered = missing = rejected = extra = 0
    out_lines = []
    for name in sorted(parsed):
        full = os.path.join(directory, name)
        if not os.path.exists(full):
            missing += 1
            out_lines.append(name + " MISSING")
            continue
        try:
            with open(full, "r", encoding="utf-8", newline="") as f:
                content = f.read()
        except OSError:
            print("error: 文件不可读 " + full, file=sys.stderr)
            return 1
        clean = ctrl_gate(content)
        if clean is None:
            rejected += 1
            out_lines.append(name + " REJECTED")
        elif hmac_hex(key, clean) == parsed[name]:
            ok += 1
            out_lines.append(name + " OK")
        else:
            tampered += 1
            out_lines.append(name + " TAMPERED")
    try:
        names = txt_files(directory)
    except OSError:
        print("error: 无法读取目录 " + directory, file=sys.stderr)
        return 1
    for name in names:
        if name not in parsed:
            extra += 1
            out_lines.append(name + " EXTRA")
    out_lines.sort()
    for ln in out_lines:
        print(ln)
    print(
        "summary ok=%d tampered=%d missing=%d rejected=%d extra=%d"
        % (ok, tampered, missing, rejected, extra)
    )
    return 0 if (tampered + missing + rejected + extra) == 0 else 1


def main():
    args = sys.argv[1:]
    if len(args) < 1:
        print("error: 需要 gen|verify 子命令", file=sys.stderr)
        return 1
    sub = args[0]
    if len(args) < 4:
        print("error: 需要 <dir> <manifest.txt> <key> 三个参数", file=sys.stderr)
        return 1
    directory, manifest_path, key = args[1], args[2], args[3]
    if KEY_RE.fullmatch(key) is None:
        print("error: key 越值域(仅 [A-Za-z0-9]+)", file=sys.stderr)
        return 1
    if sub == "gen":
        return run_gen(directory, manifest_path, key)
    if sub == "verify":
        return run_verify(directory, manifest_path, key)
    print("error: 未知子命令 " + sub, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
