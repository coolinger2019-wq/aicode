// B3 HTTP GET 汇总 — 参考实现(TypeScript + Node 24)
// 注意(Windows/Node 24 已知问题):发起过 fetch 的程序不要调用 process.exit
// 强退——会触发 libuv 断言崩(退出码 127);用 process.exitCode + 自然退出。
type Doc = { total?: unknown; items?: unknown };

async function main(): Promise<void> {
  const urls = process.argv.slice(2);
  if (urls.length < 4) {
    console.error("error: 需要 4 个 URL 参数");
    process.exitCode = 1;
    return;
  }
  const results = await Promise.all(
    urls.slice(0, 4).map(async (url, i): Promise<[boolean, number, string]> => {
      try {
        const r = await fetch(url);
        if (r.status !== 200) {
          return [false, 0, `src${i + 1} failed code ${r.status}`];
        }
        let doc: Doc;
        try {
          doc = (await r.json()) as Doc;
        } catch {
          return [false, 0, `src${i + 1} failed code 200`];
        }
        const items = Array.isArray(doc.items) ? doc.items.length : 0;
        const total = typeof doc.total === "number" ? Math.trunc(doc.total) : 0;
        return [true, total, `src${i + 1} ok code 200 items ${items} total ${total}`];
      } catch {
        return [false, 0, `src${i + 1} failed code 0`];
      }
    })
  );
  let ok = 0;
  let failed = 0;
  let grand = 0;
  for (const [isOk, total, line] of results) {
    console.log(line);
    if (isOk) {
      ok += 1;
      grand += total;
    } else {
      failed += 1;
    }
  }
  console.log(`summary ok=${ok} failed=${failed} grand_total=${grand}`);
}

void main();
