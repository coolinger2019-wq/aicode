# 任务:数据校验管线

## 任务描述

写一个程序:读取 JSON 记录数组,按手写 schema 校验每条记录,输出逐记录
结果行与汇总。

## 输入

- 程序接收 1 个命令行参数:记录文件路径。
- 文件顶层为 JSON 数组,每条记录为 JSON 对象;记录可能缺字段、字段类型可能
  不对。
- Schema(固定;字段检查顺序 id → email → age → role,**全字段检查、不短路**):
  - `id`:必须存在、为数值、且 ≥ 1;
  - `email`:必须存在、为字符串、且包含 `@`;
  - `age`:必须存在、为数值、且 0 ≤ age ≤ 150;
  - `role`:必须存在、为字符串、且取值 ∈ {`admin`, `user`, `guest`}(整串等值)。

## 输出(格式逐字固定)

- 每条记录一行:全部字段有效 → `record <序号> ok`;否则
  `record <序号> <field1> invalid; <field2> invalid; ...`
  (无效字段按检查顺序排列,以 `; ` 连接;序号 = 数组中 1 起序)。
- 末行汇总:`ok=<全有效条数> failed=<其余条数>`。
- 演示(非真实数据):记录 `[{"id":0},{"id":7,"email":"e@x.com","age":1,"role":"user"}]` →
  输出两行:
  `record 1 id invalid`
  `record 2 ok`
  再加汇总 `ok=1 failed=1`。

## 验收方式

验收器运行你的程序(参数为真实记录文件路径),stdout 与期望输出**逐字节**
比对,并检查退出码为 0。

## 错误行为

- 参数缺失、文件不可读、JSON 解析失败、顶层非数组:向 stderr 输出一行以
  `error:` 开头的消息,退出码 1,stdout 为空。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`)。
- 程序入口签名:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs`。
- 只允许使用标准库(`std.*`)与语言内建;禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 提示:文件内容是外部输入(污值);`std.json.parse` 接受污字符串返回
  `Untrusted[Json]`;投影可用:`is_num`/`as_num`(净 f64)、`is_str`/`as_str`
  (返回 `Untrusted[str]`,可用 `contains`/`starts_with`/`char_len` 谓词)。
  输出全部是净值(序号与固定字符串),直接 `print`。
- 输出必须确定。
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
