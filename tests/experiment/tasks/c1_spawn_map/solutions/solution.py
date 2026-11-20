# C1 spawn 并行汇总 — 参考实现(Python 3.10,threading)
import sys
import threading


def shard_sum(lo: int, out: list, idx: int) -> None:
    s = 0
    for i in range(lo, lo + 25):
        s += i * i
    out[idx] = s


def main() -> int:
    los = [1, 26, 51, 76]
    out = [0] * 4
    threads = [
        threading.Thread(target=shard_sum, args=(lo, out, i))
        for i, lo in enumerate(los)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    total = 0
    for i, v in enumerate(out):
        print("shard%d=%d" % (i + 1, v))
        total += v
    print("total=%d" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
