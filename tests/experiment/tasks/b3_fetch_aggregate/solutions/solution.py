# B3 HTTP GET 汇总 — 参考实现(Python 3.10)
import json
import sys
import urllib.error
import urllib.request


def fetch_one(url: str, idx: int):
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            status = resp.status
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        print("src%d failed code %d" % (idx, e.code))
        return False, 0
    except (urllib.error.URLError, OSError):
        print("src%d failed code 0" % idx)
        return False, 0
    if status != 200:
        print("src%d failed code %d" % (idx, status))
        return False, 0
    try:
        doc = json.loads(body)
    except ValueError:
        print("src%d failed code 200" % idx)
        return False, 0
    items = doc.get("items") if isinstance(doc, dict) else None
    items_n = len(items) if isinstance(items, list) else 0
    total_raw = doc.get("total") if isinstance(doc, dict) else None
    total = int(total_raw) if isinstance(total_raw, (int, float)) and not isinstance(total_raw, bool) else 0
    print("src%d ok code 200 items %d total %d" % (idx, items_n, total))
    return True, total


def main() -> int:
    urls = sys.argv[1:5]
    if len(urls) < 4:
        print("error: 需要 4 个 URL 参数", file=sys.stderr)
        return 1
    ok = 0
    failed = 0
    grand = 0
    for i, url in enumerate(urls):
        is_ok, total = fetch_one(url, i + 1)
        if is_ok:
            ok += 1
            grand += total
        else:
            failed += 1
    print("summary ok=%d failed=%d grand_total=%d" % (ok, failed, grand))
    return 0


if __name__ == "__main__":
    sys.exit(main())
