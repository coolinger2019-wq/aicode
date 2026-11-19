# bench_vs T5.1 任务 2:循环累加 1..1000000(Python,自测计时口径)
import time

N = 1000000
t0 = time.perf_counter()
s = 0
for i in range(1, N + 1):
    s += i
t1 = time.perf_counter()
print(f"{s} {(t1 - t0) * 1000.0:.3f}")
