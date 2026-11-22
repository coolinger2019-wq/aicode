"""HTTP GET aggregate: fetch 4 URLs in order, report per-source status and summary."""

import json
import sys
import urllib.error
import urllib.request

TIMEOUT = 10


def fetch(url):
    """Fetch one URL. Returns (ok, code, items_len, total)."""
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
            code = resp.getcode()
            body = resp.read()
        if code != 200:
            return False, code, None, None
        data = json.loads(body.decode("utf-8"))
        return True, 200, len(data["items"]), data["total"]
    except urllib.error.HTTPError as e:
        # HTTPError is a subclass of URLError; must be caught first.
        return False, e.code, None, None
    except (urllib.error.URLError, OSError):
        # Connection failure / timeout: URLError and socket errors are OSError.
        return False, 0, None, None
    except Exception:
        # 200 but body not usable (invalid JSON / missing keys): not ok.
        return False, 200, None, None


def main():
    argv = sys.argv[1:]
    if len(argv) < 4:
        sys.stderr.write("error: expected 4 URL arguments, got %d\n" % len(argv))
        return 1
    ok_count = 0
    failed_count = 0
    grand_total = 0
    lines = []
    for i in range(1, 5):
        ok, code, items_len, total = fetch(argv[i - 1])
        if ok:
            lines.append(
                "src%d ok code 200 items %d total %d" % (i, items_len, total)
            )
            ok_count += 1
            grand_total += total
        else:
            lines.append("src%d failed code %d" % (i, code))
            failed_count += 1
    lines.append(
        "summary ok=%d failed=%d grand_total=%d" % (ok_count, failed_count, grand_total)
    )
    sys.stdout.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
