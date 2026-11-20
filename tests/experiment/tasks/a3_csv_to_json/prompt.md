# 任务:CSV→JSON 转换

## 任务描述

写一个程序:读取 CSV 文件,按固定方言解析,合法行转为 JSON 对象,字段数不符
的行作为错误条目,最后输出单行紧凑 JSON。

## 输入

- 程序接收 1 个命令行参数:CSV 文件路径。
- 文件为 UTF-8 文本,`\n` 分行;末尾换行产生的空行不计为一行。
- 方言(固定):逗号逐字节分隔;**无引号、无转义**;第 1 行为表头,列数 = 表头
  字段数;所有值都按字符串处理(不做类型转换);空字段 = 空串(合法)。
- 数据保证:值中不出现引号、反斜杠、逗号或换行(因此无需转义处理)。
- 示例(仅演示格式,非真实数据):

  ```
  a,b
  1,x
  2,y,z
  ```

## 规则

- 表头之后的每个数据行:按逗号切分;字段数与表头一致 → row 对象,键 = 表头
  列名(按表头顺序),值 = 对应字段字符串。
- 字段数与表头不一致 → error 对象:`{"line":<行号>,"got":<实际字段数>,"want":<表头字段数>}`;
  行号从 1 起计且**包含表头行**(即首条数据行是第 2 行)。
- 空行(除末尾外)按 1 个字段计。
- 输出为单行紧凑 JSON(键值之间无空格):
  `{"rows":[<row>,...],"errors":[<error>,...]}`;
  顶层键序固定为先 `rows` 后 `errors`;row 对象键序 = 表头顺序;error 对象
  键序 = line, got, want。
- 对上面示例的期望输出:`{"rows":[{"a":"1","b":"x"}],"errors":[{"line":3,"got":3,"want":2}]}`

## 验收方式

验收器运行你的程序(参数为真实 CSV 路径),stdout 与期望输出**逐字节**比对,
并检查退出码为 0。

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
- 效果声明必须与实际副作用一致。
- 提示:文件内容是外部输入(污值);污值可以直接拼进输出字符串并 `print`
  (stdout 是存储面,出向透传合法),但不能进 `std.json.stringify` 或插值。
  可用 `std.unstr.mark("")` 起始拼串。
- 输出必须确定。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 只允许使用 Node 标准库;禁止第三方依赖;禁止读取任何 `expected/` 或
  `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 输出必须确定(对象键序 = 构造顺序)。
- 交付物:单个 `solution.ts`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 输出必须确定(dict 键序 = 构造顺序;紧凑序列化)。
- 交付物:单个 `solution.py`。
