/* bench_vs T5.1 任务 1:fib(24) 递归(C,自测计时口径)
 * 计时:Windows QueryPerformanceCounter(非 Windows 用 clock_gettime);
 * N 取自 argv——防 gcc -O2 把递归/循环整体常量折叠(诚实计时)。
 * 输出协议:<结果> <自测毫秒> */
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

static long long fib(long long n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: fib <n>\n");
        return 1;
    }
    long long n = atoll(argv[1]);
    double t0 = now_ms();
    long long r = fib(n);
    double t1 = now_ms();
    printf("%lld %.3f\n", r, t1 - t0);
    return 0;
}
