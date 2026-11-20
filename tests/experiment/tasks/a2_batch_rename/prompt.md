# 任务:批量改名

## 任务描述

写一个程序:把输入目录中的文件按规则改名后写入输出目录(输入目录只读不动),
并向 stdout 打印改名计划;要求处理目标名冲突。

## 输入

- 程序接收 2 个命令行参数:argv[1] = 输入目录,argv[2] = 输出目录(初始为空)。
- 输入目录中的条目全为文件;文件名全为 ASCII。
- 程序按文件名**字节序(ASCII)升序**处理(先排序再处理,保证输出顺序确定)。

## 改名规则(按序匹配,一条命中即止;目标占用登记跨规则共享,键 = 相对路径)

- **R1**:名称形如 `report_<digits>.txt`(`<digits>` 为 1 位以上十进制数字,
  即正则 `^report_[0-9]+\.txt$`)→ 新名 `report-<NN>.txt`;`NN` 为数字串的
  十进制数值,不足 2 位左补 0,≥2 位原样(`007` 按 7 处理得 `07`);数值超出
  64 位整数范围时本条不匹配(落入 R3)。
- **R2**:名称以 `.log` 结尾 → 写入输出目录的 `logs/` 子目录,文件名不变;
  `logs/` 仅在存在 R2 命中时创建。
- **R3**:其他 → 不写文件。
- **冲突**:目标相对路径已被更早处理的项占用 → 跳过该文件、不写;
  占用登记以"成功写入的计划项"为准(冲突跳过的项不登记)。

## 输出

按处理顺序向 stdout 逐行输出计划(示例数据仅演示格式):

```
DIR err.log -> logs/err.log
SKIP readme.md nomatch
OK report_5.txt -> report-05.txt
OK report_23.txt -> report-23.txt
SKIP report_9.txt conflict report-09.txt
```

- R1 命中行:`OK <old> -> <new>`
- R2 命中行:`DIR <old> -> logs/<old>`
- R3 行:`SKIP <name> nomatch`
- 冲突行:`SKIP <name> conflict <target>`(`<target>` 为被占用的目标相对路径)
- 输出目录不存在则创建(含 `logs/` 父级)。
- 写文件 = 原文件内容(字节不变)写到目标相对路径。

## 验收方式

验收器把你的程序指向真实的输入目录与一个全新空输出目录,断言:
1. stdout 与期望输出逐字节相等且退出码 0;
2. 输出目录中的文件集合与期望一致(存在性 + 顶层与 `logs/` 条目数);
3. 抽检一个改名文件的内容与原文件字节一致。
期望内容不随语言变化。

## 错误行为

- 参数少于 2 个、输入目录不可读:向 stderr 输出一行以 `error:` 开头的消息,
  退出码 1,stdout 为空。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`)。
- 程序入口签名:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs`。
- 只允许使用标准库(`std.*`)与语言内建;禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 效果声明必须与实际副作用一致(读文件/写文件/建目录 `fs`,打印 `io`)。
- 输出必须确定:不得依赖时间、随机数或哈希顺序(目录列表必须先排序再处理)。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 只允许使用 Node 标准库(`node:` 前缀导入);禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 输出必须确定:不得依赖时间、随机数或哈希顺序(目录列表必须先排序再处理)。
- 交付物:单个 `solution.ts`。正常结束 `process.exit(0)`,错误 `process.exit(1)`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 输出必须确定:不得依赖时间、随机数或哈希顺序(目录列表必须先排序再处理)。
- 交付物:单个 `solution.py`。正常结束 `sys.exit(0)`,错误 `sys.exit(1)`。
