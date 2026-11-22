"""HTTP GET 汇总:按参数顺序 GET 4 个 URL,解析响应 JSON,输出逐源状态行与汇总。"""

import json
import sys
import urllib.error
import urllib.request

FETCH_TIMEOUT = 10


def fetch_one(url):
    """GET 一个 URL,返回 (ok, items_len, total, code)。

    ok=True 时 items_len/total 有效;ok=False 时 code 为失败状态码
    (网络层失败/超时记 0)。
    """
    try:
        with urllib.request.urlopen(url, timeout=FETCH_TIMEOUT) as resp:
            status = resp.getcode()
            body = resp.read()
    except urllib.error.HTTPError as e:
        # HTTP 状态非 200(含 404)
        return False, 0, 0, e.code
    except Exception:
        # 连接失败/超时等网络层失败
        return False, 0, 0, 0
    if status != 200:
        return False, 0, 0, status
    try:
        data = json.loads(body.decode("utf-8"))
        items = data["items"]
        total = data["total"]
        if not isinstance(items, list):
            raise ValueError("items 不是数组")
        if isinstance(total, bool) or not isinstance(total, (int, float)):
            raise ValueError("total 不是数字")
        if isinstance(total, float):
            if not total.is_integer():
                raise ValueError("total 不是整数")
            total = int(total)
    except Exception:
        # 200 但响应体不是协议要求的合法 JSON:按失败处理(状态码 200)
        return False, 0, 0, 200
    return True, len(items), total, 200


def main(argv):
    if len(argv) < 5:
        sys.stderr.write("error: expected 4 URL arguments, got %d\n" % (len(argv) - 1 if len(argv) > 0 else 0))
        return 1
    ok_count = 0
    failed_count = 0
    grand_total = 0
    for i in range(1, 5):
        ok, items_len, total, code = fetch_one(argv[i])
        if ok:
            ok_count += 1
            grand_total += total
            print("src%d ok code 200 items %d total %d" % (i, items_len, total))
        else:
            failed_count += 1
            print("src%d failed code %d" % (i, code))
    print("summary ok=%d failed=%d grand_total=%d" % (ok_count, failed_count, grand_total))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
