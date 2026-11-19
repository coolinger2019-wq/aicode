# bench_vs T5.1 任务 1:fib(24) 递归(Python,自测计时口径)
# 输出协议:<结果> <自测毫秒>;内存采集:resource 模块 Windows 不可用 → 无 MEM 行(如实 N/A)。
import sys
import time

sys.setrecursionlimit(10000)


def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


t0 = time.perf_counter()
r = fib(24)
t1 = time.perf_counter()
print(f"{r} {(t1 - t0) * 1000.0:.3f}")
