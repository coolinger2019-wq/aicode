# 竞态防护——分片计数合并
# 每分片由独立线程本地计数（只写自己的槽位），父任务合并。无共享裸累加。

import threading


def shard_hits(s: int) -> int:
    """分片 s 的本地命中计数（s = 1..4，j = 1..16 含 16）。"""
    hits = 0
    for j in range(1, 17):
        v = (s * 13 + j * 7) % 6
        if v == 0:
            hits += 1
    return hits


def main() -> None:
    results = [0, 0, 0, 0]  # 每线程只写自己的索引槽，父任务读

    def worker(idx: int, s: int) -> None:
        results[idx] = shard_hits(s)

    threads = []
    for i in range(4):
        t = threading.Thread(target=worker, args=(i, i + 1))
        threads.append(t)
        t.start()
    for t in threads:
        t.join()

    total = sum(results)
    lines = []
    for i in range(4):
        lines.append("shard" + str(i + 1) + "=" + str(results[i]))
    lines.append("total=" + str(total))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
