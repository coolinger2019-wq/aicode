# 任务:日志清洗

## 任务描述

写一个程序:读取一个日志文件,按固定格式判定日志行,提取 user/action 字段,
过滤 DEBUG 级别,输出保留行与一行汇总。

## 输入

- 程序接收 1 个命令行参数:日志文件路径。程序以当前目录为基准打开该路径。
- 文件为 UTF-8 文本,以 `\n` 分行;末尾换行产生的空行不计为一行。
- 日志行格式:`<timestamp> <LEVEL> <module> <k=v>...`,以单空格分隔;
  `<LEVEL>` 恰好是 `INFO`、`WARN`、`ERROR`、`DEBUG` 之一(整段等值,无后缀)。
  示例(仅演示格式,非真实数据):

  ```
  2027-03-01T10:00:00Z INFO web user=zoe action=click target=btn3
  2027-03-01T10:00:02Z DEBUG web user=zoe action=hover
  not a log line at all
  ```

## 行判定规则

一行是**日志行**,当且仅当按单空格切分后:

1. 段数 ≥ 5;
2. 第 2 段恰好等于四个级别之一(整段等值,不是"以 INFO 开头"这种前缀匹配);
3. 存在以 `user=` 开头的段,且存在以 `action=` 开头的段。

不满足以上任一条 → 非日志行。时间戳的具体格式不参与判定。

## 处理规则

- 只保留 `INFO`/`WARN`/`ERROR` 级别的日志行;`DEBUG` 丢弃但计数。
- 字段提取:将 `user=` / `action=` 段去掉前缀后作为值(值只含字母/数字/下划线)。
  保留行若缺某字段,该字段以 `-` 代替。
- 保留行按原文件顺序输出,每行格式:`<user> <action>`(单个空格分隔)。
- 最后一行输出汇总,格式逐字固定(四个级别全部列出,按 INFO/WARN/ERROR/DEBUG 序):

  ```
  summary INFO=<n> WARN=<n> ERROR=<n> DEBUG=<n> skipped=<n>
  ```

  其中四个计数 = 全部日志行按级别计数(DEBUG 也计),`skipped` = 非日志行数。
  汇总示例(对应上面的演示数据):`summary INFO=1 WARN=0 ERROR=0 DEBUG=1 skipped=1`。

## 输出与错误行为

- 结果只写 stdout,每行一条;正常结束退出码 0。
- 命令行参数缺失或文件不可读:向 stderr 输出一行以 `error:` 开头的消息,
  退出码 1,stdout 为空。除此之外不得向 stdout 输出任何多余内容。

## 验收方式

验收器运行你的程序(参数为真实日志文件路径),将 stdout 与期望输出**逐字节**
比对,并检查退出码。期望内容不随语言变化。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`)。
- 程序入口签名:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs`,
  命令行参数在 `args` 中(第一个参数 = args[0]);正常结束 `return 0`,错误 `return 1`。
- 只允许使用标准库(`std.*`)与语言内建;禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 效果声明必须与实际副作用一致(读文件 `fs`、打印 `io`)。
- 输出必须确定:不得依赖时间、随机数或哈希顺序。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming`
  自查类型/效果错误。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 只允许使用 Node 标准库(`node:` 前缀导入);禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 输出必须确定:不得依赖时间、随机数或对象键序以外的顺序来源。
- 交付物:单个 `solution.ts`。正常结束 `process.exit(0)`,错误 `process.exit(1)`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 输出必须确定:不得依赖时间、随机数或哈希顺序。
- 交付物:单个 `solution.py`。正常结束 `sys.exit(0)`,错误 `sys.exit(1)`。
