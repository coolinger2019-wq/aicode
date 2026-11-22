"""分片计数合并:每分片线程本地计数,经列表按索引回传,父任务合并。

设计点:各线程只写 results 中属于自己的索引(每分片本地计数),
不存在多个线程对同一个共享计数器裸累加的竞态面。
"""

import threading

SHARDS = 4
PER_SHARD = 16


def shard_hits(shard: int, results: list, idx: int) -> None:
    """统计单个分片的命中数(本地变量累加),写回 results[idx]。"""
    hits = 0
    for j in range(1, PER_SHARD + 1):
        v = (shard * 13 + j * 7) % 6
        if v == 0:
            hits += 1
    results[idx] = hits


def main() -> None:
    results = [0] * SHARDS
    threads = []
    for i in range(SHARDS):
        t = threading.Thread(target=shard_hits, args=(i + 1, results, i))
        t.start()
        threads.append(t)
    for t in threads:
        t.join()

    total = sum(results)
    print(f"shard1={results[0]}")
    print(f"shard2={results[1]}")
    print(f"shard3={results[2]}")
    print(f"shard4={results[3]}")
    print(f"total={total}")


if __name__ == "__main__":
    main()
