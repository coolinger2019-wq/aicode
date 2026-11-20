# 任务:serve handler

## 任务描述

写一个 HTTP 服务程序(长驻):监听 127.0.0.1 上的指定端口,按固定规则把请求
映射到响应。验收器会发送 6 条固定请求并逐字比对响应。

## 输入

- 程序接收 1 个命令行参数:端口号(整数)。绑定 `127.0.0.1:<端口>` 后长驻
  (由验收器关停;你不需要实现退出)。
- 绑定失败(端口被占):向 stderr 输出一行以 `error:` 开头的消息,退出码 1。

## 路由规则(响应体逐字固定,紧凑 JSON、无空格)

1. `GET /ping` → 200,体 `{"pong":true}`
2. `POST /sum`,body 为 JSON 对象且含 `nums` 且 `nums` 为数组且**全部元素为
   数值** → 200,体 `{"sum":<整数和>}`(元素按整数语义累加;空数组 → 0;
   例如 `{"nums":[1,2,3,4]}` → `{"sum":10}`)
3. `POST /sum` 的其他形态(nums 缺失 / nums 非数组 / 含非数值元素 / body 非
   JSON / body 为空)→ 400,体 `{"code":"bad_request"}`
4. 其余任何方法与路径(含 `GET /sum`、`POST /ping`、`/deep/path`、根路径)
   → 404,体 `{"code":"not_found"}`

- 不检查 Content-Type;路径含 query 时按 `?` 前的部分匹配(请求矩阵中无 query)。

## 请求矩阵(验收器按序发送)

```
R1  GET  /ping            (无体)         → 200 {"pong":true}
R2  POST /sum {"nums":[1,2,3,4]}         → 200 {"sum":10}
R3  POST /sum {"nums":[]}                → 200 {"sum":0}
R4  POST /sum {"nums":"x"}               → 400 {"code":"bad_request"}
R5  POST /sum notjson                    → 400 {"code":"bad_request"}
R6  GET  /deep/path       (无体)         → 404 {"code":"not_found"}
```

## 验收方式

验收器选一个空闲端口 → 启动你的程序 → 轮询 `/ping` 直到就绪 → 按矩阵发送
请求 → 把每条响应组成 transcript(`R<i> -> <状态码> <响应体>`)与期望逐字节
比对 → 关停你的程序。你不需要输出任何 stdout 内容。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`)。
- 服务端:`std.net.serve(port: i64, handler: fn(Untrusted[Json]) -> Json)
  -> Result[i64, str]`(效果 `net`;固定绑 127.0.0.1;绑定失败 → Err,
  成功后永不返回)。handler 必须是**同模块命名函数**;请求载荷
  `{method, path, headers, body}` 整树标污(`get`/`as_str` 投影取值,
  `method`/`path` 作比较前需过 `std.unstr.sanitize_cli_path`;body 字符串可
  直接交给 `std.json.parse`,得到 `Untrusted[Json]` 再投影)。
- 响应构造:返回 `Json`;惯用形态 = 先建 `Map[str, Json]`(键 status/headers/body),
  经 `std.json.stringify` → `std.json.parse` 往返得到 Json(GUIDE serve 示例
  同款);`status` 为 i64,`headers` 为空对象 `{}`,`body` 为响应体字符串。
- 程序入口:`fn main(args: Vec[Untrusted[str]]) -> i64 with net, io`;
  端口 = `args[0]`(`parse_i64` 解析)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 只允许使用 Node 标准库(`node:http`);禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 交付物:单个 `solution.ts`。注意 Windows/Node 24 下服务程序被验收器硬杀,
  无退出要求。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 只允许使用标准库(`http.server`);禁止第三方依赖;禁止读取任何
  `expected/` 或 `solutions/` 目录。
- 交付物:单个 `solution.py`。服务程序被验收器硬杀,无退出要求。
