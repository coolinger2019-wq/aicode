/* bench_vs T5.1 任务 6:1k 文件扫描(C stdio,自测计时口径)
 * 程序启动时在 cwd 生成 N 个小文件(确定性内容,与其它语言逐式同源),生成不计时;
 * 计时段 = 逐个读取并累计行数(按 '\n' 计)与字节数(二进制读,各语言口径一致)。
 * N 取自 argv——防 gcc -O2 常量折叠(诚实计时)。 */
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
        fprintf(stderr, "usage: filescan <n_files>\n");
        return 1;
    }
    int n_files = atoi(argv[1]);
    char path[64];
    char content[512];
    /* 生成(不计时) */
    for (int i = 0; i < n_files; i++) {
        sprintf(path, "f%d.txt", i);
        FILE* f = fopen(path, "wb");
        if (!f) {
            fprintf(stderr, "GEN_ERR %s\n", path);
            return 1;
        }
        int pos = 0;
        for (int j = 0; j < 10; j++) {
            pos += sprintf(content + pos, "file %d line %d v%d\n", i, j, (i + j) % 97);
        }
        fwrite(content, 1, (size_t)pos, f);
        fclose(f);
    }
    double t0 = now_ms();
    long long lines = 0;
    long long bytes = 0;
    for (int i = 0; i < n_files; i++) {
        sprintf(path, "f%d.txt", i);
        FILE* f = fopen(path, "rb");
        if (!f) {
            fprintf(stderr, "READ_ERR %d\n", i);
            return 1;
        }
        size_t n;
        while ((n = fread(content, 1, sizeof(content), f)) > 0) {
            bytes += (long long)n;
            for (size_t k = 0; k < n; k++) {
                if (content[k] == '\n') lines++;
            }
        }
        fclose(f);
    }
    double t1 = now_ms();
    printf("%lld %lld %.3f\n", lines, bytes, t1 - t0);
    return 0;
}
