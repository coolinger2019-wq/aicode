// S3 协议解析器 — 参考实现(TypeScript + Node 24)。
// 与 solution.ming 同一语义(spec §2.2/§3):字节层(statSync 门禁 65536 +
// readSync 4096 分段计数)→ 解析层(readFileSync utf8,无效字节 → U+FFFD 替换,
// 与 Ming readFileSync 同源)→ 逐行判定(首条命中即停)→ 逐帧状态行 + summary。
// 码点口径:Array.from 拆行(与 Ming char_len/slice_chars、Python len/切片一致);
// 大端组装与 Fletcher-16 在数值域手工完成。
// 参数级错误 → stderr `error:` 一行 + exit 1(stdout 空);bad > 0 → exit 1。
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

const MAX_PAYLOAD = 4096;
const MAX_INPUT = 65536;
const CHUNK = 4096;

function fail(msg: string): never {
  process.stderr.write("error: " + msg + "\n");
  process.exit(1);
}

const STATUS = ["", "BAD_MAGIC", "BAD_HEX", "BAD_TYPE", "BAD_LENGTH", "TRUNCATED", "TRAILING", "CRC_MISMATCH"];

function nibble(s: string): number {
  const code = s.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function byteAt(cps: string[], off: number): number {
  return (nibble(cps[off]) << 4) | nibble(cps[off + 1]);
}

function typeName(ty: number): string {
  if (ty === 1) return "DATA";
  if (ty === 2) return "CTRL";
  return "KEEPALIVE";
}

function flagsStr(f: number): string {
  const names: string[] = [];
  if ((f & 1) === 1) names.push("ACK_REQ");
  if ((f & 2) === 2) names.push("FRAG");
  if (names.length === 0) return "none";
  return names.join(",");
}

// 逐行判定:0 = OK,否则 STATUS[code];OK 时回填 ty/flags/len
function classify(cps: string[]): { code: number; ty: number; flags: number; len: number } {
  const clen = cps.length;
  const bad = (code: number) => ({ code, ty: 0, flags: 0, len: 0 });
  if (clen < 16) return bad(5);
  if (cps.slice(0, 4).join("") !== "4d47") return bad(1);
  for (let k = 4; k < clen; k++) {
    if (nibble(cps[k]) < 0) return bad(2);
  }
  const ty = byteAt(cps, 4);
  if (ty !== 1 && ty !== 2 && ty !== 3) return bad(3);
  const flags = byteAt(cps, 6);
  const b0 = byteAt(cps, 8);
  const b1 = byteAt(cps, 10);
  const b2 = byteAt(cps, 12);
  const b3 = byteAt(cps, 14);
  // 大端组装用乘法合成(JS 位运算 OR 是 32 位有符号,0xff<<24 会变负;
  // Ming i64/Python 大整数是数学值——长度值域 [0,0xFFFFFFFF] 必须按数学值判定)
  const length = b0 * 16777216 + b1 * 65536 + b2 * 256 + b3;
  if (length > MAX_PAYLOAD) return bad(4);
  const expected = 20 + length * 2;
  if (clen < expected) return bad(5);
  if (clen > expected) return bad(6);
  // 重建帧字节(校验和覆盖域 = type||flags||length||payload),Fletcher-16
  const fr: number[] = [ty, flags, b0, b1, b2, b3];
  for (let j = 0; j < length; j++) {
    fr.push(byteAt(cps, 16 + j * 2));
  }
  let s1 = 0;
  let s2 = 0;
  for (const x of fr) {
    s1 = (s1 + x) % 255;
    s2 = (s2 + s1) % 255;
  }
  const off = 16 + length * 2;
  const stored = (byteAt(cps, off) << 8) | byteAt(cps, off + 2);
  if (((s2 << 8) | s1) !== stored) return bad(7);
  return { code: 0, ty, flags, len: length };
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length < 1) fail("用法: prog <capture 文件>");
  const inPath = argv[0];
  let st: { isFile(): boolean; size: number } | null = null;
  try {
    st = statSync(inPath);
  } catch {
    st = null;
  }
  if (st === null) fail("无法读取输入 " + inPath);
  if (!st.isFile()) fail("输入不是普通文件 " + inPath);
  const size = st.size;
  if (size > MAX_INPUT) fail(`输入超过大小门禁 (${MAX_INPUT}): ${size}`);
  // 字节层:4096 分段循环(readSync;计数 = bytes 字段)
  let total = 0;
  const fd = openSync(inPath, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    while (total < size) {
      const got = readSync(fd, buf, 0, CHUNK, total);
      if (got <= 0) fail("分段读取失败 " + inPath);
      total += got;
    }
  } finally {
    closeSync(fd);
  }
  const content = readFileSync(inPath, "utf8");
  const linesAll = content.split("\n");
  let n = linesAll.length;
  if (n > 0 && linesAll[n - 1] === "") n -= 1;
  let okc = 0;
  let badc = 0;
  let blank = 0;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const cps = Array.from(linesAll[i]);
    const lineno = i + 1;
    if (cps.length === 0) {
      blank += 1;
      continue;
    }
    const v = classify(cps);
    if (v.code === 0) {
      okc += 1;
      out.push(`frame ${lineno} OK type=${typeName(v.ty)} flags=${flagsStr(v.flags)} len=${v.len}`);
    } else {
      badc += 1;
      out.push(`frame ${lineno} ${STATUS[v.code]}`);
    }
  }
  out.push(`summary lines=${n} ok=${okc} bad=${badc} blank=${blank} bytes=${total}`);
  process.stdout.write(out.join("\n") + "\n");
  process.exit(badc > 0 ? 1 : 0);
}

main();
