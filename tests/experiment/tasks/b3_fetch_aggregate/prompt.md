# 任务:HTTP GET 汇总

## 任务描述

写一个程序:作为 HTTP 客户端,按参数顺序 GET 4 个 URL,解析响应 JSON,
输出逐源状态行与汇总。模拟源已由验收器在本机(127.0.0.1)启动,不依赖外网。

## 输入

- 程序接收 4 个命令行参数:argv[1..4] = 4 个 URL,形如
  `http://127.0.0.1:<端口>/<路径>`。端口每次运行可能不同,**不得硬编码**,
  只使用参数传入的 URL。
- 按参数顺序逐个 GET;每个 URL 对应一个源。

## 源协议

- 数据源返回 200,体为 JSON 对象,形如
  `{"source":"demo","total":12,"items":[7,8]}`(仅演示——**与真实源数据无关,禁止据此硬编码**)。
  你的程序只消费 `items`(数组长度)与 `total`(整数);`source` 字段不输出。
- 第 4 个参数指向的端点会返回 404(体为 `{"code":"not_found"}`)。

## 程序行为与输出(格式逐字固定)

- 对第 i 个 URL(i = 1..4):
  - HTTP 200 且响应体为合法 JSON → 输出
    `src<i> ok code 200 items <items 数组长度> total <total>`
  - HTTP 状态非 200 → 输出 `src<i> failed code <状态码>`
  - 网络层失败(连接失败/超时)→ 输出 `src<i> failed code 0`
- 末行汇总:`summary ok=<ok 数> failed=<failed 数> grand_total=<ok 源的 total 之和>`
- 单个源失败不是程序级错误(照常输出 failed 行,正常退出码 0)。
- 演示(非真实数据):两个源 ok(items 2/1,total 10/5)、一个 404、一个
  连接失败 →
  `src1 ok code 200 items 2 total 10`
  `src2 failed code 404`
  `src3 ok code 200 items 1 total 5`
  `src4 failed code 0`
  `summary ok=2 failed=2 grand_total=15`

## 验收方式

验收器启动本地模拟源,把 4 个真实 URL 作为参数运行你的程序,stdout 与期望
输出**逐字节**比对,并检查退出码为 0。

## 错误行为

- 参数少于 4 个:向 stderr 输出一行以 `error:` 开头的消息,退出码 1,stdout
  为空。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`)。
- 程序入口签名:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, net`。
- HTTP 客户端:`std.net.http_get(url) -> Result[(i64, Untrusted[str]), str]`
  (Ok = (状态码, 响应体);Err = 网络层失败)。
- 提示:响应体是污值;`std.json.parse(污 str)` 返回 `Result[Untrusted[Json], str]`;
  `get`/`as_arr`(取 `Vec`,`.len()` 计数)/`as_num`(净 f64)投影可用;数值输出
  `as i64` 后 `str(...)`。URL 参数是污值,作 `http_get` 实参前需过
  `std.unstr.sanitize_cli_path`。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 只允许使用 Node 标准库(可用全局 `fetch`);禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 注意(Windows/Node 24 已知问题):发起过 fetch 的程序**不要调用
  `process.exit` 强退**——会触发 libuv 断言崩溃(退出码 127);用
  `process.exitCode = <码>` + 自然退出。
- 交付物:单个 `solution.ts`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 只允许使用标准库(`urllib.request`);禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 提示:`urlopen` 对 4xx 会抛 `HTTPError`(其 `.code` 是状态码),对连接失败抛
  `URLError`。
- 交付物:单个 `solution.py`。
