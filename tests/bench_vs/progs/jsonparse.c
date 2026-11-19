/* bench_vs T5.1 任务 5:10MB JSON 解析——C 腿 N/A
 * 理由:C 标准库无 JSON 解析器;本 harness 零第三方依赖纪律(仓库硬规则 3)不引入
 * json-c 等外部库,故 C 腿对本任务如实标注 N/A(见 results.json notes)。 */
#include <stdio.h>
int main(void) {
    printf("N/A: C 标准库无 JSON 解析,零依赖纪律不引入第三方库\n");
    return 0;
}
