"""超时与降级:两个子任务,父任务带超时等待。

慢子任务 400ms 后产出 99,父最多等 100ms -> 超时,采用默认值 0;
快子任务 50ms 后产出 99,父最多等 2000ms -> 正常取到 99。
"""

import threading
import time


def main() -> None:
    # --- 慢子任务:睡 400ms 后产出 99;父最多等 100ms ---
    slow_result = 0  # 默认值(超时降级用)

    def slow_child() -> None:
        nonlocal slow_result
        time.sleep(0.4)
        slow_result = 99  # 超时后被放弃,不读取

    t_slow = threading.Thread(target=slow_child, daemon=True)
    t_slow.start()
    t_slow.join(0.1)  # 最多等 100ms
    if t_slow.is_alive():
        print("slow_child=timeout fallback=0")
    else:
        # 不会走到这里(400ms > 100ms),仅为完整分支
        print("slow_child=%d" % slow_result)

    # --- 快子任务:睡 50ms 后产出 99;父最多等 2000ms ---
    fast_result = 0  # 默认值

    def fast_child() -> None:
        nonlocal fast_result
        time.sleep(0.05)
        fast_result = 99

    t_fast = threading.Thread(target=fast_child, daemon=True)
    t_fast.start()
    t_fast.join(2.0)  # 最多等 2000ms
    if t_fast.is_alive():
        # 不会走到这里(50ms < 2000ms),仅为完整分支
        print("fast_child=timeout fallback=0")
    else:
        print("fast_child=%d" % fast_result)


if __name__ == "__main__":
    main()
