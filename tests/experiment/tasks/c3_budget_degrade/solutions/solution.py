# C3 资源配额降级 — 参考实现(Python 3.10)
import sys


def main() -> int:
    budget = 95
    kept = 0
    processed = 0
    for i in range(1, 31):
        name = "svc-" + str(i * 4 + 1)
        cost = len(name)
        if kept + cost > budget:
            print("quota exceeded at record %d: kept=%d need=%d budget=%d" % (i, kept, cost, budget))
            break
        kept += cost
        processed += 1
        print("R%d %s ok" % (i, name))
    print("summary processed=%d kept_chars=%d" % (processed, kept))
    return 0


if __name__ == "__main__":
    sys.exit(main())
