"""HTTP GET aggregate: GET 4 URLs in argument order, print per-source
status lines and a final summary line.

Usage: python solution.py <url1> <url2> <url3> <url4>
"""

import json
import sys
import urllib.error
import urllib.request

_TIMEOUT_SECONDS = 5.0
_ARG_COUNT = 4

# Sentinel marking a JSON parse failure (json.loads may legitimately
# produce None for a "null" body, so None alone cannot mark failure).
_BAD = object()


def _to_int(value):
    """Coerce a JSON "total" value to int; fall back to 0."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def fetch(url):
    """GET one URL. Return (status, body_bytes).

    Network-level failure (connection refused / timeout / any transport
    problem) returns (0, None). A non-2xx HTTP status is reported via
    HTTPError.code (a non-200 status).
    """
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.getcode(), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except Exception:
        return 0, None


def process_source(index, url):
    """Handle source number `index`. Return (line, ok, total)."""
    status, body = fetch(url)
    if status == 200 and body is not None:
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = _BAD
        if parsed is not _BAD:
            items = parsed.get("items") if isinstance(parsed, dict) else None
            n_items = len(items) if isinstance(items, list) else 0
            total = _to_int(parsed.get("total", 0)) if isinstance(parsed, dict) else 0
            line = f"src{index} ok code 200 items {n_items} total {total}"
            return line, True, total
        # 200 but body is not valid JSON: unusable source, report code 0.
        status = 0
    if status:
        return f"src{index} failed code {status}", False, 0
    return f"src{index} failed code 0", False, 0


def main(argv):
    args = argv[1:]
    if len(args) < _ARG_COUNT:
        sys.stderr.write(f"error: expected 4 url arguments, got {len(args)}\n")
        sys.stderr.flush()
        return 1
    lines = []
    ok_count = 0
    failed_count = 0
    grand_total = 0
    for index, url in enumerate(args[:_ARG_COUNT], start=1):
        line, ok, total = process_source(index, url)
        lines.append(line)
        if ok:
            ok_count += 1
            grand_total += total
        else:
            failed_count += 1
    lines.append(f"summary ok={ok_count} failed={failed_count} grand_total={grand_total}")
    # Write raw bytes with LF endings so stdout is byte-exact regardless
    # of platform newline translation on redirected output.
    payload = ("\n".join(lines) + "\n").encode("ascii")
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
