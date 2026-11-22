// b3_fetch_aggregate — HTTP GET 汇总
// 运行: node solution.ts <url1> <url2> <url3> <url4>
// 按参数顺序逐个 GET,逐源输出状态行,末行输出汇总;正常完成退出码 0。
// 注意:发起过 fetch 后不调用 process.exit(Windows/Node libuv 断言崩溃),
// 一律用 process.exitCode + 自然退出。

type SourceOutcome =
  | { kind: "ok"; itemCount: number; total: number }
  | { kind: "failed"; code: number };

const REQUEST_TIMEOUT_MS = 10000;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 仅当响应体是合法 JSON 且含 items 数组与 total 数值时视为 ok;
// 其余视为协议失败(HTTP 状态仍为 200)。
function parseSuccessBody(text: string): SourceOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "failed", code: 200 };
  }
  if (!isJsonObject(parsed)) {
    return { kind: "failed", code: 200 };
  }
  const items = parsed["items"];
  const total = parsed["total"];
  if (!Array.isArray(items) || typeof total !== "number") {
    return { kind: "failed", code: 200 };
  }
  return { kind: "ok", itemCount: items.length, total };
}

// 非成功响应也把体读完,避免未消费的响应体把事件循环挂住。
async function drainBody(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    // 读体失败不影响按状态码上报
  }
}

async function fetchSource(url: string): Promise<SourceOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status !== 200) {
      await drainBody(res);
      return { kind: "failed", code: res.status };
    }
    const text = await res.text();
    return parseSuccessBody(text);
  } catch {
    // 连接失败/超时 → code 0
    return { kind: "failed", code: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function run(): Promise<void> {
  const args: string[] = process.argv.slice(2);
  if (args.length < 4) {
    console.error("error: expected 4 URL arguments, got " + args.length);
    process.exitCode = 1;
    return;
  }
  const urls: string[] = args.slice(0, 4);
  let okCount = 0;
  let failedCount = 0;
  let grandTotal = 0;
  let index = 0;
  for (const url of urls) {
    index += 1;
    const outcome: SourceOutcome = await fetchSource(url);
    if (outcome.kind === "ok") {
      okCount += 1;
      grandTotal += outcome.total;
      console.log(
        "src" + index + " ok code 200 items " + outcome.itemCount + " total " + outcome.total,
      );
    } else {
      failedCount += 1;
      console.log("src" + index + " failed code " + outcome.code);
    }
  }
  console.log(
    "summary ok=" + okCount + " failed=" + failedCount + " grand_total=" + grandTotal,
  );
}

run().catch((err: unknown): void => {
  console.error("error: " + (err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
