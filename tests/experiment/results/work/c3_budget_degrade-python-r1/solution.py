"""Resource budget degrade: generate 30 records by fixed formula, process them
one by one under an in-program budget rule, stop before the first record that
would exceed the budget, print the degrade line and a summary."""

BUDGET = 95
TOTAL_RECORDS = 30


def main() -> int:
    kept = 0
    processed = 0
    for i in range(1, TOTAL_RECORDS + 1):
        name = "svc-" + str(i * 4 + 1)
        cost = len(name)
        if kept + cost > BUDGET:
            print(
                "quota exceeded at record "
                + str(i)
                + ": kept="
                + str(kept)
                + " need="
                + str(cost)
                + " budget=95"
            )
            break
        kept += cost
        processed += 1
        print("R" + str(i) + " " + name + " ok")
    print("summary processed=" + str(processed) + " kept_chars=" + str(kept))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
