# bench_vs T5.1 任务 5:10MB JSON 解析(Python,自测计时口径)
# 计时段 = 仅 json.loads(文件读取为 setup);验证 = meta.total 与 meta.n_items。
import json
import time

with open("data_10mb.json", "r", encoding="utf-8") as f:
    s = f.read()
t0 = time.perf_counter()
doc = json.loads(s)
t1 = time.perf_counter()
print(f"{doc['meta']['total']} {doc['meta']['n_items']} {(t1 - t0) * 1000.0:.3f}")
