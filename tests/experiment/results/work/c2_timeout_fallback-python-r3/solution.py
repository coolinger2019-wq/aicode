"""超时与降级：两个子任务，父任务带超时等待。

慢子任务 400ms 后产出 99，父最多等 100ms -> 超时，采用默认值 0；
快子任务 50ms 后产出 99，父最多等 2000ms -> 正常取到 99。
"""

import sys
import threading
import time


def slow_worker(result):
    """慢子任务：睡 400ms 后产出 99。"""
    time.sleep(0.4)
    result["value"] = 99


def fast_worker(result):
    """快子任务：睡 50ms 后产出 99。"""
    time.sleep(0.05)
    result["value"] = 99


def wait_for_child(worker, timeout_ms, fallback):
    """启动子任务线程，最多等 timeout_ms 毫秒。

    超时则放弃（daemon 线程留在后台/随进程退出被硬杀），返回 (True, fallback)；
    未超时则取子任务产出，返回 (False, value)。
    """
    result = {"value": fallback}
    t = threading.Thread(target=worker, args=(result,), daemon=True)
    t.start()
    t.join(timeout_ms / 1000.0)
    if t.is_alive():
        return True, fallback
    return False, result["value"]


def main():
    # 慢子任务：等待上限 100ms，必超时 -> fallback 0
    timed_out, value = wait_for_child(slow_worker, 100, 0)
    if timed_out:
        print("slow_child=timeout fallback=0")
    else:
        print("slow_child=" + str(value))

    # 快子任务：等待上限 2000ms，正常取到 99
    timed_out, value = wait_for_child(fast_worker, 2000, 0)
    if timed_out:
        print("fast_child=timeout fallback=0")
    else:
        print("fast_child=" + str(value))

    return 0


if __name__ == "__main__":
    sys.exit(main())
