# 任务:超时与降级

## 任务描述

写一个程序:两个子任务,父任务带**超时等待**。慢子任务 400ms 后产出 99,父
最多等 100ms → 超时,采用默认值 0;快子任务 50ms 后产出 99,父最多等 2000ms
→ 正常取到 99。

## 要求

- 慢子任务:子任务睡 400ms 后产出 99;父任务等待上限 100ms;超时后不取其
  结果,采用默认值 0。
- 快子任务:子任务睡 50ms 后产出 99;父任务等待上限 2000ms;取到 99。
- 超时的子任务被硬杀/放弃/留在后台均可(语言机制差异不验收);输出必须按
  固定格式恰好两行。

## 输出(格式逐字固定)

```
slow_child=timeout fallback=0
fast_child=99
```

## 验收方式

验收器运行你的程序(无参数),stdout 与期望输出**逐字节**比对,并检查退出码
为 0。任何 panic/异常/非零退出都判 FAIL。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`,本任务无参数)。
- 并发机制:`std.sync.spawn(fn, 参数) -> Join[R]`;带超时等待用
  `std.sync.join_detailed(handle, 超时毫秒) -> Result[R, Json]`——超时返回
  Err(错误码 M4010,子任务被硬杀);效果声明 `with sync, time`
  (子任务内 `std.time.sleep` 需要 `with time`)。spawn 的任务函数必须是
  模块级命名函数。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 并发机制:`Promise.race`(子任务 Promise vs 超时 Promise)。
- 只允许使用 Node 标准库;禁止第三方依赖;禁止读取任何 `expected/` 或
  `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 交付物:单个 `solution.ts`。正常结束用 `process.exitCode` + 自然退出
  (有挂起定时器时不要调用 `process.exit`)。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 并发机制:`threading.Thread` + `join(超时秒)` + `is_alive()` 判定。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 交付物:单个 `solution.py`。
