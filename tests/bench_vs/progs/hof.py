# bench_vs T5.1 任务 3:HOF 链 10 万元素(map + filter 各一道,functools.reduce 聚合;
# Python,自测计时口径)——与 Ming map/filter/fold、JS map/filter/reduce 语义等价。
import time
from functools import reduce

N = 100000
v = list(range(N))
t0 = time.perf_counter()
total = reduce(lambda acc, x: acc + x, filter(lambda x: x % 2 == 0, map(lambda x: x + 1, v)), 0)
t1 = time.perf_counter()
print(f"{total} {(t1 - t0) * 1000.0:.3f}")
