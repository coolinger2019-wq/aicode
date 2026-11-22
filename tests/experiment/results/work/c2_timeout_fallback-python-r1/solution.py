"""超时与降级:父任务带超时等待两个子任务。

慢子任务 400ms 后产出 99,父最多等 100ms -> 超时,采用默认值 0;
快子任务 50ms 后产出 99,父最多等 2000ms -> 正常取到 99。
"""

import threading

DEFAULT_VALUE = 0


def slow_child(result):
    # 慢子任务:睡 400ms 后产出 99
    threading.Event().wait(0.4)
    result["value"] = 99


def fast_child(result):
    # 快子任务:睡 50ms 后产出 99
    threading.Event().wait(0.05)
    result["value"] = 99


def run_with_timeout(target, wait_seconds):
    """启动子线程,最多等 wait_seconds;超时返回 (默认值, True),否则 (产出值, False)。"""
    result = {"value": DEFAULT_VALUE}
    t = threading.Thread(target=target, args=(result,), daemon=True)
    t.start()
    t.join(wait_seconds)
    if t.is_alive():
        # 超时:不取其结果,留在后台(daemon 线程),采用默认值
        return DEFAULT_VALUE, True
    return result["value"], False


def main():
    slow_value, slow_timed_out = run_with_timeout(slow_child, 0.1)
    fast_value, fast_timed_out = run_with_timeout(fast_child, 2.0)

    if slow_timed_out:
        print("slow_child=timeout fallback=0")
    else:
        print("slow_child=%d" % slow_value)

    if fast_timed_out:
        print("fast_child=timeout fallback=%d" % DEFAULT_VALUE)
    else:
        print("fast_child=%d" % fast_value)


if __name__ == "__main__":
    main()
