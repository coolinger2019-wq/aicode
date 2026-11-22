// S4 服务生命周期 harness(单一实现;Ming 腿 verify 专用——Ming 无外部进程 kill 能力,
// B4 先例)。verify.js/verify.py 原生管理同语言服务生命周期,不经本文件。
// 用法(从仓库根):
//   node harness.mjs <base_port> <prog_cmd...>            transcript 编排(顺序 23 case + 并发 8×20)
//   node harness.mjs --occupy <base_port> <prog_cmd...>   占用端口参数级腿:持端口 → 起服务 → 等退出 → 转发 stderr
// prog_cmd = 启动服务程序的命令片段,harness 把实际端口作为最后一个参数追加(Ming 腿:
//   node bin/ming.js run <prog> --max-ms 86400000 -- ,N-62.1 长驻配额惯用法)。
// 行为(默认模式):端口 base 起 +7 重试(≤10);启动被测服务;轮询 GET /health 就绪
//   (150ms 间隔,≤15s——冷启动允许上调,spec §7);连续 5 次收到 /health 非 200 HTTP 响应
//   → 判"错服务"(交叉喂入腿:路由不同 → 就绪探针失败,exit 3);就绪后按
//   input/requests.json 执行顺序矩阵、input/concurrency.json 执行并发阶段(8 客户端
//   并行、客户端内按序、按客户端序聚合——并发 transcript 行序 = 客户端输入序,与服务端
//   完成序解耦,spec §4);transcript 逐行 stdout;关停服务。
// R19 超大体客户端形态(探针定案,GAP-S4-1):声明尺寸头-only 请求(node:http 显式
//   Content-Length: 9437184、不发送体字节)——全量体发送对 ming serve 早响应+destroy
//   存在 Windows RST 丢响应竞态(实测 17/18 干净 + 1 次 ECONNRESET),头-only 实测
//   20/20 干净 413;serve 层只看大小(体内容不参与判定,spec §2.2),判定事实
//   (声明 9437184 > 上限 → handler 不执行回 413)完整触达。
// 退出码:0 = transcript 完整;2 = 服务无法启动;3 = 就绪但 /health 非 200(错服务);
//   5 = occupy 模式异常(服务未按预期退出)。
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";

const REQUESTS_PATH = "tests/experiment/scenarios/agent_service/input/requests.json";
const CONCURRENCY_PATH = "tests/experiment/scenarios/agent_service/input/concurrency.json";
const BODY_LIMIT = 8388608; // 与 ming serve 现行值同形(参数值非承诺面,spec §3.3)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function payloadOf(c, status, body) {
  if (status === null) return `ERR ${body}`;
  if (c.normalize) {
    let code = "?";
    try { code = JSON.parse(body).code || "?"; } catch {}
    return `code=${code}`;
  }
  return body;
}

// 头-only 声明尺寸请求(R19):显式 Content-Length、不写体字节 → 服务前置检查回 413
function sendDeclaredSize(port, path, size) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "content-length": String(size) } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on("error", (e) => resolve({ status: null, body: e.code || e.message }));
    req.setTimeout(30000, () => {
      req.destroy(new Error("client timeout"));
    });
    req.end();
  });
}

async function sendFetch(port, method, path, body) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      body: method === "GET" || body === "" ? undefined : body,
      signal: AbortSignal.timeout(30000),
    });
    const t = await r.text();
    return { status: r.status, body: t };
  } catch (e) {
    const code = e && e.cause && e.cause.code ? e.cause.code : String(e && e.message || e);
    return { status: null, body: code };
  }
}

async function send(port, c) {
  if (c.body_size) return sendDeclaredSize(port, c.path, c.body_size);
  return sendFetch(port, c.method, c.path, c.body || "");
}

async function waitForHealth(port, child) {
  let exited = false;
  const onExit = () => { exited = true; };
  child.on("exit", onExit);
  let wrong = 0;
  const deadline = Date.now() + 15000;
  try {
    while (Date.now() < deadline) {
      await sleep(150);
      if (exited) return { up: false, wrongService: false };
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.status === 200) return { up: true, wrongService: false };
        wrong += 1;
        if (wrong >= 5) return { up: false, wrongService: true };
      } catch {}
    }
  } finally {
    child.off("exit", onExit);
  }
  return { up: false, wrongService: false };
}

async function runConcurrency(port, conc) {
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
  // 聚合 = 客户端序展开(每客户端内请求序)
  const lines = [];
  for (const block of perClient) lines.push(...block);
  return lines;
}

async function transcriptMode(base, cmd) {
  for (let i = 0; i < 10; i++) {
    const port = base + i * 7;
    const child = spawn(cmd[0], [...cmd.slice(1), String(port)], { stdio: "ignore" });
    const { up, wrongService } = await waitForHealth(port, child);
    if (!up) {
      child.kill();
      await sleep(200);
      if (wrongService) {
        console.error("harness: 错服务(/health 持续非 200——交叉喂入形态)");
        process.exitCode = 3;
        return;
      }
      continue;
    }
    let seqLines = [];
    let concLines = [];
    try {
      // fixture 读取也在 try 内(异常路径 finally 关停 child,不泄漏,N3)
      const cases = JSON.parse(readFileSync(REQUESTS_PATH, "utf8")).cases;
      const conc = JSON.parse(readFileSync(CONCURRENCY_PATH, "utf8"));
      seqLines = await (async () => {
        const lines = [];
        for (const c of cases) {
          const res = await send(port, c);
          lines.push(`${c.id} -> ${res.status} ${payloadOf(c, res.status, res.body)}`);
        }
        return lines;
      })();
      concLines = await runConcurrency(port, conc);
    } finally {
      child.kill(); // 异常路径也必须关停,防长驻服务泄漏占用漂移端口
      await sleep(200);
    }
    for (const l of [...seqLines, ...concLines]) console.log(l);
    process.exitCode = 0; // fetch 后自然退出(Node 24 win32:process.exit 会触发 libuv 断言崩)
    return;
  }
  console.error("harness: 服务无法启动");
  process.exitCode = 2;
}

// 占用端口腿:漂移找第一个可绑定端口 → 持住 → 起服务(端口被占)→ 等退出 → 转发 stderr
function occupyMode(base, cmd) {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= 10) {
        console.error("harness: occupy 无可绑定端口");
        process.exitCode = 5;
        resolve();
        return;
      }
      const port = base + i * 7;
      i += 1;
      const holder = net.createServer(() => {});
      holder.once("error", () => {
        try { holder.close(); } catch {}
        tryNext();
      });
      holder.listen(port, "127.0.0.1", () => {
        const child = spawn(cmd[0], [...cmd.slice(1), String(port)], { stdio: ["ignore", "ignore", "pipe"] });
        let errOut = "";
        child.stderr.on("data", (d) => (errOut += d));
        const guard = setTimeout(() => {
          child.kill();
          setTimeout(() => {
            try { holder.close(); } catch {}
            console.error("harness: occupy 服务未按预期退出");
            process.exitCode = 5;
            resolve();
          }, 200);
        }, 15000);
        child.on("exit", (code) => {
          clearTimeout(guard);
          try { holder.close(); } catch {}
          if (errOut) process.stderr.write(errOut);
          process.exitCode = code === 0 ? 5 : code; // 服务成功绑定 = 占用构造失效
          resolve();
        });
      });
    };
    tryNext();
  });
}

async function main() {
  const args = process.argv.slice(2);
  let occupy = false;
  if (args[0] === "--occupy") {
    occupy = true;
    args.shift();
  }
  const base = parseInt(args[0] || "0", 10);
  const cmd = args.slice(1);
  if (!Number.isFinite(base) || base <= 0 || cmd.length === 0) {
    console.error("harness: 需要 [--occupy] <base_port> <prog_cmd...> 参数");
    process.exitCode = 2;
    return;
  }
  if (occupy) {
    await occupyMode(base, cmd);
    return;
  }
  await transcriptMode(base, cmd);
}

main();
