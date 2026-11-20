# 任务:spawn 并行汇总

## 任务描述

写一个程序:4 个分片**并行**计算,父任务按序合并。分片 i(i = 1..4)负责区间
`[25*(i-1)+1, 25*i]`(即 1..25 / 26..50 / 51..75 / 76..100),计算区间内全部
整数的**平方和**;父任务输出各分片值与总和。

## 要求

- 分片计算必须在**并行子任务**中完成(spawn / worker 线程 / 线程);父任务
  不得自己串行算分片。
- 输出按分片序固定(与并行完成顺序无关)。

## 输出(格式逐字固定)

```
shard1=<分片1平方和>
shard2=<分片2平方和>
shard3=<分片3平方和>
shard4=<分片4平方和>
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
  `std.sync.spawn(fn, 参数) -> Join[R]` + `join`;效果声明 `with sync`。
  注意:spawn 的任务函数必须是**模块级命名函数**;返回类型需可跨任务
  (i64 可以)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 输出必须确定。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 并发机制:`node:worker_threads` 的 `Worker`(可用 `eval: true` 内联工作代码;
  记得在拿到结果后 `terminate()`,否则进程可能不退出)。
- 只允许使用 Node 标准库;禁止第三方依赖;禁止读取任何 `expected/` 或
  `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 交付物:单个 `solution.ts`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 并发机制:`threading.Thread`(结果经列表按索引回传)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 交付物:单个 `solution.py`。
