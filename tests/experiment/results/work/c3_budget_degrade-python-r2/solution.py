BUDGET = 95

def main():
    kept = 0
    processed = 0
    stopped = False
    for i in range(1, 31):
        name = "svc-" + str(i * 4 + 1)
        cost = len(name)
        if kept + cost > BUDGET:
            print("quota exceeded at record {}: kept={} need={} budget={}".format(i, kept, cost, BUDGET))
            stopped = True
            break
        kept += cost
        processed += 1
        print("R{} {} ok".format(i, name))
    print("summary processed={} kept_chars={}".format(processed, kept))

if __name__ == "__main__":
    main()
