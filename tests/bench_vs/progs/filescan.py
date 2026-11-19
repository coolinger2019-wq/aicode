# bench_vs T5.1 任务 6:1k 文件扫描(Python,自测计时口径)
# 程序启动时在 cwd 生成 1000 个小文件(确定性内容,与其它语言逐式同源),生成不计时;
# 计时段 = 逐个读取并累计行数(按 b'\n' 计)与字节数(二进制读,各语言口径一致)。
import time

for i in range(1000):
    s = "".join(f"file {i} line {j} v{(i + j) % 97}\n" for j in range(10))
    with open(f"f{i}.txt", "wb") as f:
        f.write(s.encode("ascii"))
t0 = time.perf_counter()
lines = 0
total = 0
for i in range(1000):
    with open(f"f{i}.txt", "rb") as f:
        data = f.read()
    total += len(data)
    lines += data.count(b"\n")
t1 = time.perf_counter()
print(f"{lines} {total} {(t1 - t0) * 1000.0:.3f}")
