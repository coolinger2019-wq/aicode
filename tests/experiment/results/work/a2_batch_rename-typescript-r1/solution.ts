// 批量改名:把输入目录中的文件按规则改名后写入输出目录(输入目录只读),
// 向 stdout 打印改名计划。运行: node solution.ts <输入目录> <输出目录>

import { copyFileSync, mkdirSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";

// 有符号 64 位整数上限(2^63 - 1)的十进制书写;等长数字串的字典序即数值序。
const I64_MAX_DEC = "9223372036854775807";

// 用 writeSync 同步写 stdout/stderr,避免 process.exit 截断管道缓冲。
function out(line: string): void {
  writeSync(1, line + "\n");
}

function fail(message: string): never {
  writeSync(2, message + "\n");
  process.exit(1);
  // process.exit 不返回;此 throw 保证 TS 的 never 返回类型成立。
  throw new Error(message);
}

// 去掉前导零,全零返回 "0"。
function stripLeadingZeros(digits: string): string {
  const stripped: string = digits.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

// 去前导零后的十进制串是否落在 64 位有符号整数范围内(数字串无负号,只判上界)。
function fitsI64(stripped: string): boolean {
  if (stripped.length < 19) return true;
  if (stripped.length > 19) return false;
  return stripped <= I64_MAX_DEC;
}

// NN:数值的十进制书写,不足 2 位左补 0,>=2 位原样。
function formatNN(stripped: string): string {
  if (stripped.length < 2) return "0" + stripped;
  return stripped;
}

const R1 = /^report_([0-9]+)\.txt$/;

function main(): void {
  const argv: readonly string[] = process.argv.slice(2);
  const inputDir: string | undefined = argv[0];
  const outputDir: string | undefined = argv[1];
  if (inputDir === undefined || outputDir === undefined) {
    fail("error: 用法: node solution.ts <输入目录> <输出目录>");
  }

  let names: string[];
  try {
    names = readdirSync(inputDir);
  } catch {
    fail("error: 无法读取输入目录: " + inputDir);
  }

  // 文件名全 ASCII:按码元比较即字节序(ASCII)升序。
  names.sort((a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0));

  // 目标占用登记跨规则共享,键 = 目标相对路径(正斜杠);以成功写入的计划项为准。
  const occupied: Set<string> = new Set<string>();
  let outRootReady = false;
  let logsReady = false;

  for (const name of names) {
    const m: RegExpExecArray | null = R1.exec(name);
    if (m !== null) {
      const digits: string = m[1] ?? "";
      const stripped: string = stripLeadingZeros(digits);
      if (!fitsI64(stripped)) {
        // 数值超出 64 位整数范围:R1 不匹配,落入 R3。
        out("SKIP " + name + " nomatch");
        continue;
      }
      const target: string = "report-" + formatNN(stripped) + ".txt";
      if (occupied.has(target)) {
        out("SKIP " + name + " conflict " + target);
        continue;
      }
      if (!outRootReady) {
        mkdirSync(outputDir, { recursive: true });
        outRootReady = true;
      }
      copyFileSync(join(inputDir, name), join(outputDir, target));
      occupied.add(target);
      out("OK " + name + " -> " + target);
      continue;
    }
    if (name.endsWith(".log")) {
      const target: string = "logs/" + name;
      if (occupied.has(target)) {
        out("SKIP " + name + " conflict " + target);
        continue;
      }
      if (!logsReady) {
        mkdirSync(join(outputDir, "logs"), { recursive: true });
        logsReady = true;
        outRootReady = true;
      }
      copyFileSync(join(inputDir, name), join(outputDir, "logs", name));
      occupied.add(target);
      out("DIR " + name + " -> " + target);
      continue;
    }
    out("SKIP " + name + " nomatch");
  }
}

main();
process.exit(0);
