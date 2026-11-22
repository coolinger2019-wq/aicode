import threading


def main():
    # 每分片本地计数, 经列表按索引回传, 父任务合并(无共享计数器裸累加)
    results = [0, 0, 0, 0]

    def shard_worker(s, slot):
        local_count = 0
        for j in range(1, 17):  # j = 1..16 含 16
            v = (s * 13 + j * 7) % 6
            if v == 0:
                local_count += 1
        results[slot] = local_count

    threads = []
    for s in range(1, 5):
        t = threading.Thread(target=shard_worker, args=(s, s - 1))
        threads.append(t)
        t.start()
    for t in threads:
        t.join()

    total = sum(results)
    lines = []
    for i in range(4):
        lines.append("shard%d=%d" % (i + 1, results[i]))
    lines.append("total=%d" % total)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
