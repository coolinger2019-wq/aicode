// S2 文件完整性 — 参考实现(TypeScript + Node 24)。
// 与 solution.ming 同一语义:gen 扫描单层目录 .txt 普通文件(字节序升序),内容逐行
// 控制符闸(C0 含 \t/DEL/C1/双向,空行不含控制符直接过),净行 join("\n") 重建 →
// hmac_sha256;verify 清单结构损坏 → exit 1,hex 不符 → TAMPERED,状态行按 name
// 字节序混排 + 汇总行,非全 OK exit 1。
import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

// 采集器 tsc 缺省调用(--noEmit --strict,无 esModuleInterop)下不用默认导入;
// 路径一律字符串拼接(Node 接受正斜杠,win32 等价)。
const NAME_RE = /^[a-z0-9_-]+\.txt$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[A-Za-z0-9]+$/;

function isCtrlLine(s: string): boolean {
  for (let i = 0; i < s.length; ) {
    const c = s.codePointAt(i)!;
    if (c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f) || (c >= 0x202a && c <= 0x202e)) {
      return true;
    }
    i += c >= 0x10000 ? 2 : 1;
  }
  return false;
}

// 内容控制符闸:任一行含控制符 → Err(REJECTED);否则净行重建(LF 无损)。
function ctrlGate(content: string): string | null {
  const lines = content.split("\n");
  const clean: string[] = [];
  for (const ln of lines) {
    if (ln !== "" && isCtrlLine(ln)) {
      return null;
    }
    clean.push(ln);
  }
  return clean.join("\n");
}

function hmacHex(key: string, content: string): string {
  return createHmac("sha256", key).update(content, "utf8").digest("hex");
}

function txtFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith(".txt") && statSync(dir + "/" + n).isFile())
    .sort();
}

function runGen(dir: string, manifestPath: string, key: string): number {
  let names: string[];
  try {
    names = txtFiles(dir);
  } catch {
    console.error("error: 无法读取目录 " + dir);
    return 1;
  }
  const lines: string[] = [];
  let rejected = 0;
  for (const name of names) {
    let content: string;
    try {
      content = readFileSync(dir + "/" + name, "utf8");
    } catch {
      console.error("error: 文件不可读 " + dir + "/" + name);
      return 1;
    }
    const clean = ctrlGate(content);
    if (clean === null) {
      rejected += 1;
    } else {
      lines.push(name + " " + hmacHex(key, clean));
    }
  }
  try {
    writeFileSync(manifestPath, lines.join("\n") + "\n", "utf8");
  } catch {
    console.error("error: 无法写入清单 " + manifestPath);
    return 1;
  }
  console.log(`manifest ${lines.length} files rejected=${rejected}`);
  return 0;
}

// 清单解析:结构损坏 → Err 原因;hex 与重算不符不在此列(统一归 TAMPERED)。
function parseManifest(manifestPath: string): Record<string, string> | string {
  let content: string;
  try {
    content = readFileSync(manifestPath, "utf8");
  } catch {
    return "无法读取清单";
  }
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const map: Record<string, string> = {};
  for (const raw of lines) {
    if (isCtrlLine(raw)) {
      return "行含控制字符";
    }
    const segs = raw.split(" ");
    if (segs.length !== 2 || !NAME_RE.test(segs[0]!) || !HEX64_RE.test(segs[1]!)) {
      return "行格式非法";
    }
    if (segs[0]! in map) {
      return "重复名 " + segs[0];
    }
    map[segs[0]!] = segs[1]!;
  }
  return map;
}

function runVerify(dir: string, manifestPath: string, key: string): number {
  const parsed = parseManifest(manifestPath);
  if (typeof parsed === "string") {
    console.error("error: 清单损坏: " + parsed);
    return 1;
  }
  const map = parsed;
  let ok = 0;
  let tampered = 0;
  let missing = 0;
  let rejected = 0;
  let extra = 0;
  const outLines: string[] = [];
  const mnames = Object.keys(map).sort();
  for (const name of mnames) {
    const full = dir + "/" + name;
    if (!existsSync(full)) {
      missing += 1;
      outLines.push(name + " MISSING");
      continue;
    }
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      console.error("error: 文件不可读 " + full);
      return 1;
    }
    const clean = ctrlGate(content);
    if (clean === null) {
      rejected += 1;
      outLines.push(name + " REJECTED");
    } else if (hmacHex(key, clean) === map[name]) {
      ok += 1;
      outLines.push(name + " OK");
    } else {
      tampered += 1;
      outLines.push(name + " TAMPERED");
    }
  }
  let names: string[];
  try {
    names = txtFiles(dir);
  } catch {
    console.error("error: 无法读取目录 " + dir);
    return 1;
  }
  for (const name of names) {
    if (!(name in map)) {
      extra += 1;
      outLines.push(name + " EXTRA");
    }
  }
  outLines.sort();
  for (const ln of outLines) {
    console.log(ln);
  }
  console.log(`summary ok=${ok} tampered=${tampered} missing=${missing} rejected=${rejected} extra=${extra}`);
  return tampered + missing + rejected + extra === 0 ? 0 : 1;
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("error: 需要 gen|verify 子命令");
    return 1;
  }
  const sub = args[0]!;
  if (args.length < 4) {
    console.error("error: 需要 <dir> <manifest.txt> <key> 三个参数");
    return 1;
  }
  const dir = args[1]!;
  const manifestPath = args[2]!;
  const key = args[3]!;
  if (!KEY_RE.test(key)) {
    console.error("error: key 越值域(仅 [A-Za-z0-9]+)");
    return 1;
  }
  if (sub === "gen") {
    return runGen(dir, manifestPath, key);
  }
  if (sub === "verify") {
    return runVerify(dir, manifestPath, key);
  }
  console.error("error: 未知子命令 " + sub);
  return 1;
}

process.exit(main());
