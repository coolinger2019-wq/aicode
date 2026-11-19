/* bench_vs T5.1 任务 3:HOF 链 10 万元素(C 腿)
 * C 标准库无高阶函数——手写循环等价(语义与 Ming map(+1)/filter(偶数)/fold(求和) 一致,
 * results 表注明"循环等价")。N 取自 argv——防 gcc -O2 常量折叠(诚实计时)。 */
#include <stdio.h>
#include <stdlib.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <time.h>
#endif

static double now_ms(void) {
#ifdef _WIN32
    LARGE_INTEGER f, c;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#endif
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: hof <n>\n");
        return 1;
    }
    long long n = atoll(argv[1]);
    double t0 = now_ms();
    long long sum = 0;
    for (long long i = 0; i < n; i++) {
        long long x = i + 1;
        if (x % 2 == 0) sum += x;
    }
    double t1 = now_ms();
    printf("%lld %.3f\n", sum, t1 - t0);
    return 0;
}
