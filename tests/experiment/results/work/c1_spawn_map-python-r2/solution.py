"""spawn 并行汇总:4 个分片并行计算平方和,父任务按序合并。"""

import threading


def shard_square_sum(lo, hi, results, idx):
    """计算区间 [lo, hi] 内全部整数的平方和,写入 results[idx]。"""
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
        t = threading.Thread(target=shard_square_sum, args=(lo, hi, results, i - 1))
        threads.append(t)
        t.start()
    for t in threads:
        t.join()
    total = results[0] + results[1] + results[2] + results[3]
    print("shard1=%d" % results[0])
    print("shard2=%d" % results[1])
    print("shard3=%d" % results[2])
    print("shard4=%d" % results[3])
    print("total=%d" % total)


if __name__ == "__main__":
    main()
