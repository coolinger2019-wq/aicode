# 任务:竞态防护——分片计数合并

## 任务描述

写一个程序:4 个分片**并行**统计各自数据片段的命中数,父任务合并。数据由
公式生成。**禁止**让多个线程对同一个共享计数器裸累加——必须"每分片本地
计数 → 子任务返回结果 → 父任务合并"(这正是分片防竞态的设计点)。

## 数据公式(固定)

- 分片 s(s = 1..4),片内 j = 1..16(含 16):
  - `v = (s*13 + j*7) % 6`
  - `v == 0` → 该次为命中(该分片计数 +1);否则不命中。
- 每分片命中数由并行子任务计算并返回;父任务按分片序合并输出。

## 输出(格式逐字固定)

```
shard1=<分片1命中数>
shard2=<分片2命中数>
shard3=<分片3命中数>
shard4=<分片4命中数>
total=<四片之和>
```

## 验收方式

验收器运行你的程序(无参数),stdout 与期望输出**逐字节**比对,并检查退出码
为 0。任何 panic/异常/非零退出都判 FAIL。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`,本任务无参数)。
- 并发机制:`std.sync.spawn_all(fn, [参数数组]) -> Vec[Result[R, str]]` 或
  spawn/join;效果声明 `with sync`。spawn 的任务函数必须是模块级命名函数;
  Ming 值语义下子任务拿到参数的完整拷贝、与父任务零共享——本地计数天然
  无竞态。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 并发机制:`node:worker_threads` 的 `Worker`(可用 `eval: true` 内联工作代码;
  拿到结果后 `terminate()`)。不要用 `SharedArrayBuffer` 共享计数器裸累加。
- 只允许使用 Node 标准库;禁止第三方依赖;禁止读取任何 `expected/` 或
  `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 交付物:单个 `solution.ts`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 并发机制:`threading.Thread`(每分片把本地计数经列表按索引回传,父任务求和;
  不要多个线程 `+=` 同一个全局计数器)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 交付物:单个 `solution.py`。
