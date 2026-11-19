# bench_vs T5.1 任务 4:词频统计 2 万词(Python,自测计时口径)
# 文本生成器:mulberry32(Ming std.rand 同源,种子 20261120,逐式复刻)从 64 词表抽 2 万词;
# 计时段 = 仅 dict 计数(生成词列表为 setup,不计时)。
import time

VOCAB = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
    "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
    "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray",
    "yankee", "zulu", "apple", "banana", "cherry", "date", "elder", "fig",
    "grape", "honey", "kiwi", "lemon", "mango", "nutmeg", "olive", "peach",
    "quince", "raspberry", "strawberry", "tomato", "ugli", "vanilla", "walnut", "xigua",
    "yuzu", "zucchini", "amber", "bright", "crisp", "dawn", "ember", "frost",
    "gleam", "haven", "ivory", "jade", "karma", "lumen", "meadow", "nimbus",
]


def make_rng(seed):
    state = seed & 0xFFFFFFFF

    def rng_range(lo, hi):
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = (t ^ (t + ((t ^ (t >> 7)) * (t | 61)))) & 0xFFFFFFFF
        state = (t ^ (t >> 14)) & 0xFFFFFFFF
        return lo + (state % (hi - lo))

    return rng_range


rng = make_rng(20261120)
words = []
for _ in range(20000):
    words.append(VOCAB[rng(0, 64)])
t0 = time.perf_counter()
counts = {}
for w in words:
    counts[w] = counts.get(w, 0) + 1
t1 = time.perf_counter()
print(f"{len(words)} {len(counts)} {counts.get('alpha', 0)} {counts.get('nimbus', 0)} {(t1 - t0) * 1000.0:.3f}")
