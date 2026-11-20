# 任务:去重统计

## 任务描述

写一个程序:输入目录下有若干分块文本文件,按块依次处理,合并统计每行的
出现次数,输出总量/去重统计与出现最多的前 3 行。

## 输入

- 程序接收 1 个命令行参数:分块目录路径。
- 参与统计的文件 = 目录中名称匹配 `chunk_*.txt` 的条目,按名称**字节序
  (ASCII)升序**处理;其余条目忽略。
- 每文件 UTF-8,`\n` 分行;末尾换行产生的空行不计为一行;行内容只含
  小写字母/数字/连字符(示例仅演示格式):

  ```
  evt-aaa-001
  evt-bbb-002
  evt-aaa-001
  ```

## 统计口径

- 全部块合并计数(跨块累计,不是每块独立统计)。
- `total` = 处理的行总数;`unique` = 不同行数;`repeated` = 出现次数大于 1
  的不同行数。

## 输出(格式逐字固定)

```
total=<n>
unique=<n>
repeated=<n>
top1 <line> <count>
top2 <line> <count>
top3 <line> <count>
```

- Top-3 = 出现次数最多的前 3 行:次数降序;次数并列时按行内容升序
  (字节序)。不同行不足 3 个时只输出实际数量。
- `top<i>`、行内容、次数之间均为单个空格。
- 对上面演示数据(单块 3 行)的输出:
  `total=3`、`unique=2`、`repeated=1`、`top1 evt-aaa-001 2`、`top2 evt-bbb-002 1`。

## 验收方式

验收器运行你的程序(参数为真实分块目录),stdout 与期望输出**逐字节**比对,
并检查退出码为 0。

## 错误行为

- 参数缺失、目录不可读、文件不可读:向 stderr 输出一行以 `error:` 开头的
  消息,退出码 1,stdout 为空。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`)。
- 程序入口签名:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs`。
- 只允许使用标准库(`std.*`)与语言内建;禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 提示:文件内容是外部输入(污值);行名要作为 `Map` 键聚合前,需逐行过
  `std.unstr.sanitize_cli_path`(校验不改写,聚合键授权位)取净值。
- 输出必须确定:排序结果不得依赖哈希序(Map 迭代序 = 插入序,可依赖)。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 只允许使用 Node 标准库;禁止第三方依赖;禁止读取任何 `expected/` 或
  `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 输出必须确定(排序比较器必须写成全序:次数降序 + 行内容升序)。
- 交付物:单个 `solution.ts`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 输出必须确定。
- 交付物:单个 `solution.py`。
