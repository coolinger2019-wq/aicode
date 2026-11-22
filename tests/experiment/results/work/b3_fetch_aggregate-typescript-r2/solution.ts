// HTTP GET 汇总 —— 按参数顺序 GET 4 个 URL,输出逐源状态行与汇总。
// 用法: node solution.ts <url1> <url2> <url3> <url4>

interface SourceData {
  total: number;
  items: unknown[];
}

interface SourceOutcome {
  ok: boolean;
  line: string;
  total: number;
}

const TIMEOUT_MS = 10000;

// 校验 200 响应体:要求 JSON 对象且含数值 total 与数组 items。
function parseSource(data: unknown): SourceData | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const obj = data as Record<string, unknown>;
  const total: unknown = obj['total'];
  const items: unknown = obj['items'];
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    return null;
  }
  if (!Array.isArray(items)) {
    return null;
  }
  return { total: total, items: items };
}

async function fetchOne(url: string, index: number): Promise<SourceOutcome> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (res.status !== 200) {
      return { ok: false, line: `src${index} failed code ${res.status}`, total: 0 };
    }
    try {
      const parsed = parseSource(JSON.parse(text));
      if (parsed === null) {
        return { ok: false, line: `src${index} failed code 200`, total: 0 };
      }
      return {
        ok: true,
        line: `src${index} ok code 200 items ${parsed.items.length} total ${parsed.total}`,
        total: parsed.total,
      };
    } catch {
      return { ok: false, line: `src${index} failed code 200`, total: 0 };
    }
  } catch {
    // 网络层失败(连接失败/超时)。
    return { ok: false, line: `src${index} failed code 0`, total: 0 };
  }
}

async function run(): Promise<void> {
  const args: string[] = process.argv.slice(2);
  if (args.length < 4) {
    console.error(`error: 需要 4 个 URL 参数,实际收到 ${args.length} 个`);
    process.exitCode = 1;
    return;
  }
  const urls: string[] = args.slice(0, 4);
  const outcomes: SourceOutcome[] = [];
  let index = 1;
  for (const url of urls) {
    const outcome = await fetchOne(url, index);
    outcomes.push(outcome);
    console.log(outcome.line);
    index += 1;
  }
  let okCount = 0;
  let failedCount = 0;
  let grandTotal = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      okCount += 1;
      grandTotal += outcome.total;
    } else {
      failedCount += 1;
    }
  }
  console.log(`summary ok=${okCount} failed=${failedCount} grand_total=${grandTotal}`);
}

// 不用 process.exit(libuv 断言崩溃),用 exitCode + 自然退出。
run().catch(() => {
  process.exitCode = 1;
});
