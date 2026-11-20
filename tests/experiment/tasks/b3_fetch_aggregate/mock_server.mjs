// B3 本地模拟 HTTP 源(单一实现,三语言 verify 共用;不依赖外网)。
// 用法: node mock_server.mjs <base_port> <ready_file>
// 绑定 base_port(占用则 +3 重试,最多 10 次);三个端口 p1,p2,p3 = p1,p1+1,p1+2;
// 就绪后向 ready_file 写入一行 "<p1> <p2> <p3>"(无换行)。
// 路由(所有端口同构):GET /source1|/source2|/source3 → 200 固定 JSON;
// GET /missing → 404 {"code":"not_found"};GET /__shutdown → 200 后 100ms 退出(码 0);
// 其他 → 404。120s 生命期兜底自动退出(码 3)。
import http from "node:http";
import fs from "node:fs";

const base = parseInt(process.argv[2] || "21031", 10);
const readyFile = process.argv[3];
if (!readyFile) {
  console.error("mock: 需要 <base_port> <ready_file> 参数");
  process.exit(2);
}

const SOURCES = {
  source1: { source: "alpha", total: 87, items: [1, 2, 3, 4] },
  source2: { source: "beta", total: 30, items: [5, 6] },
  source3: { source: "gamma", total: 42, items: [7, 8, 9] },
};

function makeServer() {
  return http.createServer((req, res) => {
    const p = (req.url || "/").split("?")[0];
    const name = p.replace(/^\//, "");
    if (name === "__shutdown") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("bye");
      setTimeout(() => process.exit(0), 100);
      return;
    }
    if (name === "missing") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "not_found" }));
      return;
    }
    const body = SOURCES[name];
    if (body) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "not_found" }));
  });
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.close();
      reject(e);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

const servers = [makeServer(), makeServer(), makeServer()];

async function main() {
  let p1 = 0;
  for (let i = 0; i < 10 && p1 === 0; i++) {
    const cands = [base + i * 3, base + i * 3 + 1, base + i * 3 + 2];
    try {
      await Promise.all(servers.map((s, j) => tryListen(s, cands[j])));
      p1 = cands[0];
    } catch {
      for (const s of servers) {
        try {
          s.close();
        } catch {}
      }
    }
  }
  if (p1 === 0) {
    console.error("mock: 无法绑定端口段");
    process.exit(2);
  }
  fs.writeFileSync(readyFile, `${p1} ${p1 + 1} ${p1 + 2}`);
  const guard = setTimeout(() => process.exit(3), 120000);
  guard.unref();
}

main();
