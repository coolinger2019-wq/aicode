// HTTP GET 汇总:按参数顺序 GET 4 个 URL,输出逐源状态行与汇总行。

interface SourceResult {
  ok: boolean;
  code: number;
  itemsLen: number;
  total: number;
}

const FETCH_TIMEOUT_MS = 10000;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function drainBody(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // 读体失败不影响按状态码分类。
  }
}

async function fetchOne(url: string): Promise<SourceResult> {
  try {
    const res: Response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status !== 200) {
      await drainBody(res);
      return { ok: false, code: res.status, itemsLen: 0, total: 0 };
    }
    const text: string = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, code: res.status, itemsLen: 0, total: 0 };
    }
    if (!isJsonObject(parsed)) {
      return { ok: false, code: res.status, itemsLen: 0, total: 0 };
    }
    const rawItems: unknown = parsed["items"];
    const rawTotal: unknown = parsed["total"];
    if (!Array.isArray(rawItems) || typeof rawTotal !== "number" || !Number.isFinite(rawTotal)) {
      return { ok: false, code: res.status, itemsLen: 0, total: 0 };
    }
    return { ok: true, code: res.status, itemsLen: rawItems.length, total: rawTotal };
  } catch {
    return { ok: false, code: 0, itemsLen: 0, total: 0 };
  }
}

async function main(): Promise<void> {
  const args: string[] = process.argv.slice(2);
  if (args.length < 4) {
    process.stderr.write("error: expected 4 URL arguments\n");
    process.exitCode = 1;
    return;
  }
  let okCount = 0;
  let failedCount = 0;
  let grandTotal = 0;
  for (let i = 0; i < 4; i += 1) {
    const url = args[i] as string;
    const r = await fetchOne(url);
    const n = i + 1;
    if (r.ok) {
      okCount += 1;
      grandTotal += r.total;
      process.stdout.write(`src${n} ok code 200 items ${r.itemsLen} total ${r.total}\n`);
    } else {
      failedCount += 1;
      process.stdout.write(`src${n} failed code ${r.code}\n`);
    }
  }
  process.stdout.write(`summary ok=${okCount} failed=${failedCount} grand_total=${grandTotal}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
