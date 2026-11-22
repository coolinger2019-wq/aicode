import sys
import threading


def shard_square_sum(lo, hi, results, idx):
    total = 0
    for k in range(lo, hi + 1):
        total += k * k
    results[idx] = total


def main():
    results = [0, 0, 0, 0]
    threads = []
    for i in range(1, 5):
        lo = 25 * (i - 1) + 1
        hi = 25 * i
        t = threading.Thread(target=shard_square_sum, args=(lo, hi, results, i - 1))
        threads.append(t)
        t.start()
    for t in threads:
        t.join()
    total = results[0] + results[1] + results[2] + results[3]
    lines = []
    for i in range(4):
        lines.append("shard%d=%d" % (i + 1, results[i]))
    lines.append("total=%d" % total)
    sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
