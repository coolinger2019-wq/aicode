# C2 超时与降级 — 参考实现(Python 3.10,threading + join 超时)
import sys
import threading
import time


def child(ms: int, out: list) -> None:
    time.sleep(ms / 1000.0)
    out.append(99)


def run(idx: str, delay_ms: int, limit_ms: int) -> None:
    out = []
    t = threading.Thread(target=child, args=(delay_ms, out), daemon=True)
    t.start()
    t.join(limit_ms / 1000.0)
    if t.is_alive():
        print(idx + "=timeout fallback=0")
    else:
        print(idx + "=" + str(out[0]))


def main() -> int:
    run("slow_child", 400, 100)
    run("fast_child", 50, 2000)
    return 0


if __name__ == "__main__":
    sys.exit(main())
