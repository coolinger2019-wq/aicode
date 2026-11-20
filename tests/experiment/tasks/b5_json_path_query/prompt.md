# 任务:嵌套 JSON 路径查询

## 任务描述

写一个程序:读入一个 JSON 文档与一组点路径查询,逐段下钻取值,按固定渲染
规则输出每条查询的结果与汇总;取不到 → MISSING。

## 输入

- 程序接收 2 个命令行参数:argv[1] = JSON 文档路径(顶层对象),argv[2] =
  查询文件路径(每行一条点路径;`\n` 分行;末尾空行不计)。
- 文档数值全为整数;字符串值不含引号/反斜杠;查询段只含小写字母/数字。

## 路径语义

- 查询按 `.` 切段,从文档根逐段下钻:
  - 段为纯数字且当前值为数组 → 数组下标(0 起;越界 → MISSING);
  - 否则当前值为对象 → 按键取(缺键 → MISSING);
  - 当前值既非数组也非对象(标量上继续下钻)→ MISSING;
  - 数字段只对数组当下标,不会当对象键。
- 示例(仅演示,非真实数据):文档 `{"a":{"b":[10,20]}}`,查询 `a.b.1` →
  下钻对象 a → 数组 b → 下标 1 → 值 `20`;查询 `a.x` → MISSING。

## 值渲染(输出行 `<查询> = <渲染值>`,单个空格包围 `=`)

- 字符串 → 原样(不加引号);
- 数值 → 整数十进制;
- 布尔 → `true` / `false`;
- 数组/对象 → 紧凑 JSON(无空格,如 `["a","b"]`);
- 取不到 → `MISSING`。

## 汇总

- 末行:`found=<取到条数> missing=<MISSING 条数>`。
- 对上面演示文档与查询 `a.b.1`、`a.x` 的完整输出:
  `a.b.1 = 20`
  `a.x = MISSING`
  `found=1 missing=1`

## 验收方式

验收器运行你的程序(参数为真实文档与查询文件路径),stdout 与期望输出
**逐字节**比对,并检查退出码为 0。

## 错误行为

- 参数少于 2、文件不可读、JSON 解析失败、文档顶层非对象:向 stderr 输出一行
  以 `error:` 开头的消息,退出码 1,stdout 为空。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`)。
- 程序入口签名:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs`。
- 只允许使用标准库(`std.*`)与语言内建;禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 提示:文档内容是污值;`std.json.parse(污 str)` → `Untrusted[Json]`;下钻用
  `is_arr`/`at`/`is_obj`/`get` 投影;查询段作对象键前过
  `std.unstr.sanitize_cli_path`(校验不改写,比较/聚合键授权位)。数组/对象的
  紧凑 JSON 渲染需手写序列化拼串(污+污 拼接合法,最后 `print` 出向透传;
  `std.json.stringify(污)` 与插值/`debug` 都不行);数值 `as_num()` 后
  `as i64` 再 `str(...)`;布尔 `str(bool)` 即 `true`/`false`。
- 输出必须确定。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 只允许使用 Node 标准库;禁止第三方依赖;禁止读取任何 `expected/` 或
  `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 输出必须确定(数组/对象渲染用 `JSON.stringify`,键序 = 构造/解析序)。
- 交付物:单个 `solution.ts`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 输出必须确定(布尔渲染为 `true`/`false`,不是 Python 的 `True`/`False`;
  容器渲染用 `json.dumps(..., separators=(",", ":"))`)。
- 交付物:单个 `solution.py`。
