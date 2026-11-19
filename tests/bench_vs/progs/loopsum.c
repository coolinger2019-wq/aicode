/* bench_vs T5.1 任务 2:循环累加 1..N(C,自测计时口径)
 * 计时:Windows QueryPerformanceCounter;N 取自 argv——防 gcc -O2 常量折叠(诚实计时)。 */
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
        fprintf(stderr, "usage: loopsum <n>\n");
        return 1;
    }
    long long n = atoll(argv[1]);
    double t0 = now_ms();
    long long s = 0;
    for (long long i = 1; i <= n; i++) s += i;
    double t1 = now_ms();
    printf("%lld %.3f\n", s, t1 - t0);
    return 0;
}
