// A2 黑盒验收(JS,ESM):stdout 逐字节 + 输出目录集合 + 内容抽检。
// 用法(从仓库根):node tests/experiment/tasks/a2_batch_rename/verify.js [被测程序路径]
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, "..", "..", "..", "..");

function main() {
  const prog = process.argv[2]
    ? path.resolve(repoRoot, process.argv[2])
    : path.join(taskDir, "solutions", "solution.ts");
  const expected = readFileSync(path.join(taskDir, "expected", "expected.txt"), "utf8");
  const rels = readFileSync(path.join(taskDir, "expected", "expected_files.txt"), "utf8")
    .split("\n")
    .filter(Boolean);
  const outDir = mkdtempSync(path.join(os.tmpdir(), "exp-a2-"));
  try {
    const r = spawnSync(
      "node",
      [prog, "tests/experiment/tasks/a2_batch_rename/input", outDir],
      { cwd: repoRoot, encoding: "utf8", timeout: 60000 }
    );
    if (r.error) {
      console.error("FAIL spawn: " + r.error.message);
      return 1;
    }
    if (r.status !== 0) {
      console.error("FAIL exit=" + r.status + "\n" + (r.stderr || ""));
      return 1;
    }
    if (r.stdout !== expected) {
      console.error(
        "FAIL stdout mismatch actual_len=" + r.stdout.length + " expected_len=" + expected.length
      );
      return 1;
    }
    let topFiles = 0;
    const dirs = new Map();
    for (const rp of rels) {
      if (!existsSync(path.join(outDir, rp))) {
        console.error("FAIL 缺少输出文件 " + rp);
        return 1;
      }
      const segs = rp.split("/");
      if (segs.length === 1) {
        topFiles += 1;
      } else {
        dirs.set(segs[0], (dirs.get(segs[0]) || 0) + 1);
      }
    }
    const top = readdirSync(outDir);
    if (top.length !== topFiles + dirs.size) {
      console.error("FAIL 顶层条目数不符 actual=" + top.length + " want=" + (topFiles + dirs.size));
      return 1;
    }
    for (const [d, n] of dirs) {
      const sub = readdirSync(path.join(outDir, d));
      if (sub.length !== n) {
        console.error("FAIL 子目录条目数不符 " + d + " actual=" + sub.length + " want=" + n);
        return 1;
      }
    }
    const got = readFileSync(path.join(outDir, "report-01.txt"), "utf8");
    const orig = readFileSync(path.join(taskDir, "input", "report_1.txt"), "utf8");
    if (got !== orig) {
      console.error("FAIL 改名文件内容与原文件不一致");
      return 1;
    }
    console.log("PASS");
    return 0;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

process.exit(main());
