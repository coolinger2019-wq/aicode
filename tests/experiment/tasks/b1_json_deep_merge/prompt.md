# 任务:JSON 深合并

## 任务描述

写一个程序:读入两个 JSON 对象文档,按"深合并"规则合成一个对象,输出单行
紧凑 JSON。

## 输入

- 程序接收 2 个命令行参数:argv[1] = 文档 A 路径,argv[2] = 文档 B 路径。
- 两个文档顶层都必须是 JSON 对象,否则报错退出(见错误行为)。
- 数值全为整数;字符串值不含引号/反斜杠(无需转义处理)。
- 深合并规则:
  - 两边在同一键上**都是对象** → 递归深合并;
  - 其他任何情况(标量/数组/null/一边对象一边非对象/类型不同)→ **取 B**;
  - A 独有的键保留(A 的值);B 独有的键追加(B 的值)。
  - **键序**:A 的键按 A 中的出现顺序(独有键取 A 值,共有键取合并值),然后
    追加 B 独有键(按 B 中的出现顺序)。递归对象同样适用。
- 示例(仅演示,非真实数据):A = `{"x":{"p":1},"y":2}`,B = `{"x":{"q":9},"z":true}`
  → 输出 `{"x":{"p":1,"q":9},"y":2,"z":true}`

## 输出

- 单行紧凑 JSON(键值之间无空格),后随换行。

## 验收方式

验收器运行你的程序(参数为两个真实 JSON 文档路径),stdout 与期望输出
**逐字节**比对,并检查退出码为 0。

## 错误行为

- 参数少于 2、文件不可读、JSON 解析失败、顶层非对象:向 stderr 输出一行以
  `error:` 开头的消息,退出码 1,stdout 为空。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`)。
- 程序入口签名:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs`。
- 只允许使用标准库(`std.*`)与语言内建;禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 提示:文件内容是外部输入(污值)。`std.json.parse` 接受污字符串并返回
  `Untrusted[Json]`;其投影(`as_obj`/`as_arr`/`as_str`/`as_num`/`is_obj`…)
  全部可用。但 `std.json.stringify(污 Json)` 是编译错误,插值/`debug` 也不行——
  请手写序列化拼串(污值拼接合法),最后 `print` 出向透传。数值渲染:
  `as_num()` 后 `as i64` 再 `str(...)`。
- 输出必须确定(Map 迭代序 = 插入序,与 JSON 解析序一致)。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 只允许使用 Node 标准库;禁止第三方依赖;禁止读取任何 `expected/` 或
  `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`(可用联合类型建模 JSON)。
- 输出必须确定(对象键序 = 构造顺序;`JSON.stringify` 为紧凑格式)。
- 交付物:单个 `solution.ts`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 输出必须确定(dict 键序 = 构造顺序;`json.dumps(..., separators=(",", ":"))`
  为紧凑格式)。
- 交付物:单个 `solution.py`。
