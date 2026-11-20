# C4 竞态防护:分片计数合并 — 参考实现(Python 3.10,threading)
# 每分片本地计数后经列表按索引回传,父任务合并;不用共享计数器裸累加。
import sys
import threading


def count_hits(s: int, out: list, idx: int) -> None:
    hits = 0
    for j in range(1, 17):
        v = (s * 13 + j * 7) % 6
        if v == 0:
            hits += 1
    out[idx] = hits


def main() -> int:
    shards = [1, 2, 3, 4]
    out = [0] * 4
    threads = [
        threading.Thread(target=count_hits, args=(s, out, i))
        for i, s in enumerate(shards)
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
