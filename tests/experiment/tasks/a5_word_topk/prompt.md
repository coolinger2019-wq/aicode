# 任务:词频 Top-K

## 任务描述

写一个程序:读取文本文件,按空白切词,统计词频,输出次数最多的前 5 个词。

## 输入

- 程序接收 1 个命令行参数:文本文件路径。
- 文件为 UTF-8 文本;词 = 空白字符(空格与换行;数据不含制表符)切分出的
  非空片段;大小写敏感;词只含小写字母。
- 示例(仅演示,非真实数据):文件内容 `b a b a c c` → 词计数
  `a:2 b:2 c:2`。

## 规则

- 全文统一计数;K = 5(固定)。
- 排序:次数降序;次数并列时按词升序(字节序)。
- 输出前 5 行,每行格式 `word count`(单个空格);不同词不足 5 个时只输出
  实际数量。
- 对上面示例的输出:

  ```
  a 2
  b 2
  c 2
  ```

## 验收方式

验收器运行你的程序(参数为真实文本文件路径),stdout 与期望输出**逐字节**
比对,并检查退出码为 0。

## 错误行为

- 参数缺失或文件不可读:向 stderr 输出一行以 `error:` 开头的消息,退出码 1,
  stdout 为空。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`)。
- 程序入口签名:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs`。
- 只允许使用标准库(`std.*`)与语言内建;禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 提示:文件内容是外部输入(污值);词要作为 `Map` 键聚合前,需逐词过
  `std.unstr.sanitize_cli_path`(校验不改写,聚合键授权位)取净值。
- 输出必须确定(Map 迭代序 = 插入序;排序比较器必须全序)。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 只允许使用 Node 标准库;禁止第三方依赖;禁止读取任何 `expected/` 或
  `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 输出必须确定。
- 交付物:单个 `solution.ts`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 输出必须确定。
- 交付物:单个 `solution.py`。
