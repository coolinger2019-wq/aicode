# 资源配额降级：按公式生成 30 条记录，逐条按程序内预算规则处理。
# 名称 = "svc-" + str(i*4+1)，成本 = 名称字符数，预算 = 95。
# 超预算时停止在该记录之前，输出 quota 行与 summary。

BUDGET = 95


def main():
    kept = 0
    processed = 0
    for i in range(1, 31):
        name = "svc-" + str(i * 4 + 1)
        cost = len(name)
        if kept + cost > BUDGET:
            print("quota exceeded at record {}: kept={} need={} budget={}".format(i, kept, cost, BUDGET))
            break
        kept += cost
        processed += 1
        print("R{} {} ok".format(i, name))
    print("summary processed={} kept_chars={}".format(processed, kept))


if __name__ == "__main__":
    main()
