/* bench_vs T5.1 任务 4:词频统计 2 万词(C 腿)
 * C 标准库无哈希映射——手写开放寻址哈希表(标准 C 零第三方依赖,results 注明)。
 * 文本生成器:mulberry32(Ming std.rand 同源逐式复刻,种子 20261120)从 64 词表抽 N 词;
 * 计时段 = 仅哈希表计数(生成词数组为 setup,不计时)。N 取自 argv——防常量折叠。 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <time.h>
#endif

#define TBLSZ 256 /* 2 的幂;64 词表 → 装载率上限 25% */
#define WORDS_N 20000

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

static const char* VOCAB[64] = {
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
    "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
    "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray",
    "yankee", "zulu", "apple", "banana", "cherry", "date", "elder", "fig",
    "grape", "honey", "kiwi", "lemon", "mango", "nutmeg", "olive", "peach",
    "quince", "raspberry", "strawberry", "tomato", "ugli", "vanilla", "walnut", "xigua",
    "yuzu", "zucchini", "amber", "bright", "crisp", "dawn", "ember", "frost",
    "gleam", "haven", "ivory", "jade", "karma", "lumen", "meadow", "nimbus",
};

/* mulberry32:与 src/interp.js randStep 逐式对齐(无符号 32 位自然回绕) */
static unsigned int rng_state;

static void rng_step(void) {
    rng_state = (rng_state + 0x6D2B79F5u) & 0xFFFFFFFFu;
    unsigned int t = rng_state;
    t = ((t ^ (t >> 15)) * (t | 1u)) & 0xFFFFFFFFu;
    t = (t ^ (t + ((t ^ (t >> 7)) * (t | 61u)))) & 0xFFFFFFFFu;
    rng_state = (t ^ (t >> 14)) & 0xFFFFFFFFu;
}

static long long rng_range(long long lo, long long hi) {
    rng_step();
    return lo + (long long)(rng_state % (unsigned int)(hi - lo));
}

/* 手写开放寻址哈希表(FNV-1a) */
typedef struct {
    const char* key; /* NULL = 空槽 */
    long long val;
} Slot;

static Slot table[TBLSZ];

static unsigned int fnv1a(const char* s) {
    unsigned int h = 2166136261u;
    while (*s) {
        h ^= (unsigned char)*s++;
        h *= 16777619u;
    }
    return h;
}

static Slot* find_slot(const char* s) {
    unsigned int idx = fnv1a(s) & (TBLSZ - 1);
    while (table[idx].key != NULL && strcmp(table[idx].key, s) != 0) {
        idx = (idx + 1) & (TBLSZ - 1);
    }
    return &table[idx];
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: wordfreq <n_words>\n");
        return 1;
    }
    long long n_words = atoll(argv[1]);
    rng_state = 20261120u;
    const char** words = (const char**)malloc((size_t)n_words * sizeof(const char*));
    if (!words) {
        fprintf(stderr, "malloc failed\n");
        return 1;
    }
    for (long long i = 0; i < n_words; i++) {
        words[i] = VOCAB[rng_range(0, 64)];
    }
    double t0 = now_ms();
    for (long long i = 0; i < n_words; i++) {
        Slot* s = find_slot(words[i]);
        s->key = words[i];
        s->val += 1;
    }
    double t1 = now_ms();
    long long distinct = 0;
    for (int k = 0; k < TBLSZ; k++) {
        if (table[k].key != NULL) distinct++;
    }
    Slot* a = find_slot("alpha");
    Slot* b = find_slot("nimbus");
    printf("%lld %lld %lld %lld %.3f\n", n_words, distinct, a->key ? a->val : 0, b->key ? b->val : 0, t1 - t0);
    free(words);
    return 0;
}
