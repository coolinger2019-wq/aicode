import threading


def shard_sum_of_squares(lo, hi, results, idx):
    acc = 0
    for n in range(lo, hi + 1):
        acc += n * n
    results[idx] = acc


def main():
    results = [0, 0, 0, 0]
    threads = []
    for i in range(1, 5):
        lo = 25 * (i - 1) + 1
        hi = 25 * i
        t = threading.Thread(target=shard_sum_of_squares, args=(lo, hi, results, i - 1))
        t.start()
        threads.append(t)
    for t in threads:
        t.join()
    for i in range(1, 5):
        print("shard%d=%d" % (i, results[i - 1]))
    print("total=%d" % sum(results))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
