// S4 黑盒验收(JS,ESM):原生管理同语言(TS)服务生命周期——启动(端口漂移)/就绪轮询/
// 顺序 23 case + 并发 8×20 请求/关停,transcript 与 expected 逐字节比对 + 参数级腿
// (端口 0/65536/非数字)+ 端口被占腿 + 负例腿(交叉喂入 B4 参考实现预期 FAIL/
// expected 变异样本预期 mismatch)。R19 超大体 = 头-only 声明尺寸请求(GAP-S4-1,
// 与 harness.mjs 同形)。
// 用法(从仓库根):node tests/experiment/scenarios/agent_service/verify.js [被测程序路径]
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, "..", "..", "..", "..");
const BASE = "tests/experiment/scenarios/agent_service";
const BASE_PORT = 21531;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cases = JSON.parse(readFileSync(path.join(repoRoot, BASE, "input", "requests.json"), "utf8")).cases;
const conc = JSON.parse(readFileSync(path.join(repoRoot, BASE, "input", "concurrency.json"), "utf8"));
const expected = readFileSync(path.join(repoRoot, BASE, "expected", "expected_transcript.txt"), "utf8");

function payloadOf(desc, status, body) {
  if (status === null) return `ERR ${body}`;
  if (desc.normalize) {
    let code = "?";
    try { code = JSON.parse(body).code || "?"; } catch {}
    return `code=${code}`;
  }
  return body;
}

function sendDeclaredSize(port, reqPath, size) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: reqPath, headers: { "content-length": String(size) } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on("error", (e) => resolve({ status: null, body: e.code || e.message }));
    req.setTimeout(30000, () => req.destroy(new Error("client timeout")));
    req.end();
  });
}

async function send(port, desc) {
  if (desc.body_size) return sendDeclaredSize(port, desc.path, desc.body_size);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${desc.path}`, {
      method: desc.method,
      body: desc.method === "GET" || (desc.body || "") === "" ? undefined : desc.body,
      signal: AbortSignal.timeout(30000),
    });
    const t = await r.text();
    return { status: r.status, body: t };
  } catch (e) {
    const code = e && e.cause && e.cause.code ? e.cause.code : String(e && e.message || e);
    return { status: null, body: code };
  }
}

// 启动被测服务(端口漂移 base+7i ≤10;就绪 = GET /health 200;连续 5 次 HTTP 非 200
// → 错服务,交叉喂入形态)
async function startService(cmdPrefix) {
  for (let i = 0; i < 10; i++) {
    const port = BASE_PORT + i * 7;
    const child = spawn(cmdPrefix[0], [...cmdPrefix.slice(1), String(port)], { stdio: "ignore" });
    let exited = false;
    child.on("exit", () => { exited = true; });
    let wrong = 0;
    const deadline = Date.now() + 15000;
    let up = false;
    while (Date.now() < deadline) {
      await sleep(150);
      if (exited) break;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.status === 200) { up = true; break; }
        wrong += 1;
        if (wrong >= 5) break;
      } catch {}
    }
    if (up) return { child, port };
    child.kill();
    await sleep(200);
    if (wrong >= 5) return { error: "wrong-service" };
  }
  return { error: "no-start" };
}

async function runPhases(port) {
  const seqLines = [];
  for (const c of cases) {
    const res = await send(port, c);
    seqLines.push(`${c.id} -> ${res.status} ${payloadOf(c, res.status, res.body)}`);
  }
  const perClient = [];
  for (let c = 1; c <= conc.clients; c++) perClient.push(new Array(conc.per_client).fill(""));
  await Promise.all(
    Array.from({ length: conc.clients }, (_, ci) =>
      (async () => {
        const client = ci + 1;
        for (let j = 1; j <= conc.per_client; j++) {
          const pat = conc.pattern[(j - 1) % conc.pattern.length];
          const body = (pat.body || "").replace(/<c>/g, String(client));
          const res = await send(port, { method: pat.method, path: pat.path, body });
          perClient[ci][j - 1] = `C${client}R${j} -> ${res.status} ${payloadOf(pat, res.status, res.body)}`;
        }
      })()
    )
  );
  const concLines = [];
  for (const block of perClient) concLines.push(...block);
  return [...seqLines, ...concLines].join("\n") + "\n";
}

async function transcriptOf(cmdPrefix) {
  const started = await startService(cmdPrefix);
  if (started.error) return { error: started.error };
  const { child, port } = started;
  try {
    const transcript = await runPhases(port);
    return { transcript };
  } finally {
    child.kill(); // 异常路径也必须关停,防长驻服务泄漏占用漂移端口
    await sleep(200);
  }
}

// stderr 恰一行(spec §4 字面):恰一个换行且在末尾
function isSingleLineStderr(s) {
  const n = (s.match(/\n/g) || []).length;
  return n === 1 && s.endsWith("\n");
}

function expectParamError(tag, prog, arg) {
  const r = spawnSync("node", [prog, arg], { cwd: repoRoot, encoding: "utf8", timeout: 60000 });
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
  if (!isSingleLineStderr(r.stderr)) {
    console.error(`FAIL ${tag}: stderr 非恰一行`);
    return 1;
  }
  return 0;
}

// 端口被占腿:持住漂移段第一个可绑定端口 → 起服务 → 绑定失败 exit 1 + stderr error:
function expectOccupied(tag, prog) {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= 10) {
        console.error(`FAIL ${tag}: 无可绑定端口`);
        resolve(1);
        return;
      }
      const port = BASE_PORT + i * 7;
      i += 1;
      const holder = net.createServer(() => {});
      holder.once("error", () => {
        try { holder.close(); } catch {}
        tryNext();
      });
      holder.listen(port, "127.0.0.1", () => {
        const r = spawnSync("node", [prog, String(port)], { cwd: repoRoot, encoding: "utf8", timeout: 60000 });
        try { holder.close(); } catch {}
        if (r.error || r.status !== 1) {
          console.error(`FAIL ${tag}: exit=${r.status}(预期 1)`);
          resolve(1);
          return;
        }
        if (!(r.stderr || "").startsWith("error:")) {
          console.error(`FAIL ${tag}: stderr 未以 error: 开头`);
          resolve(1);
          return;
        }
        if (!isSingleLineStderr(r.stderr)) {
          console.error(`FAIL ${tag}: stderr 非恰一行`);
          resolve(1);
          return;
        }
        resolve(0);
      });
    };
    tryNext();
  });
}

async function main() {
  const prog = process.argv[2]
    ? path.resolve(repoRoot, process.argv[2])
    : path.join(taskDir, "solutions", "solution.ts");
  const tsArgs = [prog];

  // 腿 1:transcript(顺序 + 并发)逐字节
  const t1 = await transcriptOf(["node", ...tsArgs]);
  if (t1.error) {
    console.error(`FAIL transcript 腿: ${t1.error}`);
    process.exitCode = 1;
    return;
  }
  if (t1.transcript !== expected) {
    console.error(`FAIL transcript 腿 mismatch actual_len=${t1.transcript.length} expected_len=${expected.length}`);
    process.exitCode = 1;
    return;
  }

  // 腿 2–4:参数级(端口 0/65536/非数字)
  if (expectParamError("参数-端口0", prog, "0") !== 0) { process.exitCode = 1; return; }
  if (expectParamError("参数-端口65536", prog, "65536") !== 0) { process.exitCode = 1; return; }
  if (expectParamError("参数-端口非数字", prog, "abc") !== 0) { process.exitCode = 1; return; }

  // 腿 5:端口被占
  if ((await expectOccupied("参数-端口被占", prog)) !== 0) { process.exitCode = 1; return; }

  // 腿 6:负例-交叉喂入 B4 参考实现(路由不同 → 错服务)→ 必须按具体 FAIL 形态失败:
  // wrong-service(排除 no-start 静默通过,审查 MINOR-3 收口)
  const cross = await transcriptOf(["node", path.join(repoRoot, "tests/experiment/tasks/b4_serve_handler/solutions/solution.ts")]);
  if (cross.error !== "wrong-service") {
    if (!cross.error) {
      console.error("FAIL 负例-交叉喂入: B4 参考实现竟通过 S4 验收");
    } else {
      console.error(`FAIL 负例-交叉喂入: 未按错服务形态失败(${cross.error})`);
    }
    process.exitCode = 1;
    return;
  }

  // 腿 7:负例-expected 变异样本(改一处标签)→ mismatch FAIL(逐字节比对有齿,S3 惯例)
  const t2 = await transcriptOf(["node", ...tsArgs]);
  if (t2.error) {
    console.error(`FAIL 负例-变异样本: ${t2.error}`);
    process.exitCode = 1;
    return;
  }
  const mutated = expected.replace("code=handler_panic", "code=handler_panicX");
  if (t2.transcript !== mutated) {
    console.log("PASS");
    process.exitCode = 0; // fetch 后自然退出(Node 24 win32:process.exit 会触发 libuv 断言崩)
    return;
  }
  console.error("FAIL 负例-变异样本: 变异期望竟与 transcript 一致(比对无齿)");
  process.exitCode = 1;
}

main();
