// S5 黑盒验收(JS,ESM):内容腿(ok → stdout 逐字节 + exit 0 + notes 逐字节;
// mismatch_* / extra_file → stdout 逐字节 + exit 1 + 输出路径无文件)+ 参数级腿
// (缺参/目录不存在/argv[1] 指向普通文件/missing_version 案例)+ 负例腿(交叉喂入
// S2 参考实现预期 FAIL/expected 变异样本——检查行与 notes 各一字符——预期 mismatch)
// + 不 panic 专项(六快照 stderr 无引擎 panic 标记)。
// 用法(从仓库根):node tests/experiment/scenarios/release_bootstrap/verify.js [被测程序路径]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, "..", "..", "..", "..");
const BASE = "tests/experiment/scenarios/release_bootstrap";
const PANIC_MARKERS = ["panic", "内部错误", "RangeError", "TypeError", "Traceback"];

function readExact(p) {
  return readFileSync(p, "utf8");
}

function runProg(prog, args) {
  return spawnSync("node", [prog, ...args], { cwd: repoRoot, encoding: "utf8", timeout: 60000 });
}

function hasPanicMarker(stderr) {
  return PANIC_MARKERS.some((m) => (stderr || "").includes(m));
}

// stderr 恰一行(spec §4 字面):恰一个换行且在末尾
function isSingleLineStderr(s) {
  const n = (s.match(/\n/g) || []).length;
  return n === 1 && s.endsWith("\n");
}

function expectParamError(tag, r) {
  if (r.error) {
    console.error(`FAIL ${tag}: spawn: ${r.error.message}`);
    return 1;
  }
  if (r.status !== 1) {
    console.error(`FAIL ${tag}: exit=${r.status}(预期 1)\n${r.stderr || ""}`);
    return 1;
  }
  if (r.stdout !== "") {
    console.error(`FAIL ${tag}: stdout 非空(预期空)`);
    return 1;
  }
  if (!(r.stderr || "").startsWith("error:")) {
    console.error(`FAIL ${tag}: stderr 未以 error: 开头`);
    return 1;
  }
  if (hasPanicMarker(r.stderr)) {
    console.error(`FAIL ${tag}: stderr 含引擎 panic 标记`);
    return 1;
  }
  if (!isSingleLineStderr(r.stderr)) {
    console.error(`FAIL ${tag}: stderr 非恰一行`);
    return 1;
  }
  return 0;
}

function main() {
  const prog = process.argv[2]
    ? path.resolve(repoRoot, process.argv[2])
    : path.join(taskDir, "solutions", "solution.ts");
  const base = path.join(repoRoot, BASE);
  const okSnap = `${BASE}/input/snapshots/ok`;
  const outDir = path.join(base, "output");
  mkdirSync(outDir, { recursive: true });
  const notesOut = `${BASE}/output/notes_ok_js.md`;
  rmSync(path.join(repoRoot, notesOut), { force: true });
  const expOk = readExact(path.join(base, "expected", "expected_stdout_ok.txt"));
  const expNotes = readExact(path.join(base, "expected", "expected_notes_ok.md"));
  const failCases = [
    ["mismatch_cli", `${BASE}/input/snapshots/mismatch_cli`, "expected_stdout_mismatch_cli.txt"],
    ["mismatch_changelog", `${BASE}/input/snapshots/mismatch_changelog`, "expected_stdout_mismatch_changelog.txt"],
    ["mismatch_tag", `${BASE}/input/snapshots/mismatch_tag`, "expected_stdout_mismatch_tag.txt"],
    ["extra_file", `${BASE}/input/snapshots/extra_file`, "expected_stdout_extra_file.txt"],
  ];

  // 内容腿 1:ok → exit 0 + stdout 逐字节 + notes 逐字节
  const ok = runProg(prog, [okSnap, notesOut]);
  if (ok.error) {
    console.error(`FAIL 内容-ok: spawn: ${ok.error.message}`);
    return 1;
  }
  if (ok.status !== 0) {
    console.error(`FAIL 内容-ok: exit=${ok.status}(预期 0)\n${ok.stderr || ""}`);
    return 1;
  }
  if (ok.stdout !== expOk) {
    console.error(`FAIL 内容-ok: stdout mismatch actual_len=${ok.stdout.length} expected_len=${expOk.length}`);
    return 1;
  }
  if (hasPanicMarker(ok.stderr)) {
    console.error("FAIL 内容-ok: stderr 含引擎 panic 标记");
    return 1;
  }
  const gotNotes = readExact(path.join(repoRoot, notesOut));
  if (gotNotes !== expNotes) {
    console.error(`FAIL 内容-ok: notes mismatch actual_len=${gotNotes.length} expected_len=${expNotes.length}`);
    return 1;
  }

  // 内容腿 2–5:mismatch_* / extra_file → exit 1 + stdout 逐字节 + 无输出文件
  for (const [tag, snap, expFile] of failCases) {
    const exp = readExact(path.join(base, "expected", expFile));
    const notesI = `${BASE}/output/notes_${tag}_js.md`;
    rmSync(path.join(repoRoot, notesI), { force: true });
    const r = runProg(prog, [snap, notesI]);
    if (r.error) {
      console.error(`FAIL 内容-${tag}: spawn: ${r.error.message}`);
      return 1;
    }
    if (r.status !== 1) {
      console.error(`FAIL 内容-${tag}: exit=${r.status}(预期 1)\n${r.stderr || ""}`);
      return 1;
    }
    if (r.stdout !== exp) {
      console.error(`FAIL 内容-${tag}: stdout mismatch actual_len=${r.stdout.length} expected_len=${exp.length}`);
      return 1;
    }
    if (hasPanicMarker(r.stderr)) {
      console.error(`FAIL 内容-${tag}: stderr 含引擎 panic 标记`);
      return 1;
    }
    if (existsSync(path.join(repoRoot, notesI))) {
      console.error(`FAIL 内容-${tag}: FAIL 路径竟产出 notes 文件`);
      return 1;
    }
  }

  // 参数级腿 1–5:缺参(0/1 个 argv)/目录不存在/argv[1] 指向普通文件/missing_version
  if (expectParamError("参数-缺参", runProg(prog, [])) !== 0) return 1;
  if (expectParamError("参数-单参", runProg(prog, [okSnap])) !== 0) return 1;
  if (expectParamError("参数-目录不存在", runProg(prog, [`${BASE}/input/snapshots/no_such_dir`, notesOut])) !== 0) return 1;
  if (expectParamError("参数-普通文件", runProg(prog, [`${BASE}/input/snapshots/extra_file/draft_notes.txt`, notesOut])) !== 0) return 1;
  if (expectParamError("参数-missing_version", runProg(prog, [`${BASE}/input/snapshots/missing_version`, notesOut])) !== 0) return 1;

  // 负例腿 1:交叉喂入 S2 参考实现(缺 key 参数)→ 必须按具体 FAIL 形态失败:
  // exit 1 + stderr error: 行(参数级拒绝;排除 no-start/ENOENT 形态静默通过,
  // 审查 MINOR-3 收口)
  const s2 = path.join(repoRoot, "tests/experiment/scenarios/file_integrity/solutions/solution.ts");
  const cross = runProg(s2, [okSnap, notesOut]);
  if (cross.status === 1 && (cross.stderr || "").startsWith("error:") && cross.stdout === "") {
    // 具体失败形态成立(S2 参数级拒绝)
  } else if (cross.status === 0 && cross.stdout === expOk) {
    console.error("FAIL 负例-交叉喂入: S2 参考实现竟通过 S5 验收");
    return 1;
  } else {
    console.error(`FAIL 负例-交叉喂入: 未按参数级拒绝形态失败 exit=${cross.status}`);
    return 1;
  }

  // 负例腿 2:expected 变异样本 → mismatch FAIL(逐字节比对有齿,S3 惯例)
  // 2a:检查行改一处
  const mutatedOut = expOk.replace("check tag OK", "check tag OKX");
  const notesMut = `${BASE}/output/notes_mut_js.md`;
  const rerun = runProg(prog, [okSnap, notesMut]);
  if (rerun.status !== 0) {
    console.error(`FAIL 负例-变异样本: exit=${rerun.status}`);
    return 1;
  }
  if (rerun.stdout === mutatedOut) {
    console.error("FAIL 负例-变异样本: 变异期望竟与 stdout 一致(比对无齿)");
    return 1;
  }
  // 2b:notes 改一字符(读盘 notes 与变异期望必须不一致)
  const mutatedNotes = expNotes.replace("自举工具链冒烟", "自举工具链冒烟X");
  const gotMutNotes = readExact(path.join(repoRoot, notesMut));
  if (gotMutNotes === mutatedNotes) {
    console.error("FAIL 负例-变异样本: notes 变异期望竟与实写一致(比对无齿)");
    return 1;
  }
  console.log("PASS");
  return 0;
}

process.exit(main());
