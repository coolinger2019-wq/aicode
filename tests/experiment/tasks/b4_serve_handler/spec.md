# B4 serve handler(spec)

## 任务

写一个 HTTP 服务程序(长驻):监听 127.0.0.1 上的指定端口,按固定规则映射
请求到响应;验收器发送 6 条固定请求矩阵并逐字比对响应。

## 输入

- argv[1] = 端口号(整数)。程序绑定 `127.0.0.1:<port>` 并长驻(由验收器关停)。
- 绑定失败(端口被占):stderr 一行以 `error:` 开头,退出码 1。

## 路由规则(响应体逐字固定,紧凑 JSON 无空格)

1. `GET /ping` → 200,体 `{"pong":true}`
2. `POST /sum`,body 为 JSON 对象且含 `nums` 且 `nums` 为数组且**全部元素为
   数值** → 200,体 `{"sum":<整数和>}`(元素按整数语义累加;空数组 → 0)
3. `POST /sum` 的其他形态(nums 缺失/nums 非数组/含非数值元素/body 非 JSON/
   body 为空)→ 400,体 `{"code":"bad_request"}`
4. 其余任何方法与路径(含 GET /sum、POST /ping、/deep/path、根路径)→ 404,
   体 `{"code":"not_found"}`

- 不检查 Content-Type;GET /ping 的 body 忽略;路径含 query 时按 `?` 前的
  部分匹配(矩阵中无 query)。

## 请求矩阵(验收器固定,按序发送)

| # | 请求 | 期望 |
|---|------|------|
| R1 | GET /ping(无体) | 200 `{"pong":true}` |
| R2 | POST /sum `{"nums":[1,2,3,4]}` | 200 `{"sum":10}` |
| R3 | POST /sum `{"nums":[]}` | 200 `{"sum":0}` |
| R4 | POST /sum `{"nums":"x"}` | 400 `{"code":"bad_request"}` |
| R5 | POST /sum `notjson` | 400 `{"code":"bad_request"}` |
| R6 | GET /deep/path(无体) | 404 `{"code":"not_found"}` |

## Transcript(验收比对对象)

每请求一行:`R<i> -> <状态码> <响应体>`;与 `expected/expected.txt` 逐字节相等。

## 验收

验收器(三语言各自)选端口 → 启动被测服务 → 轮询就绪 → 发送矩阵 → 比对
transcript → 关停服务。transcript 逐字节相等即 PASS(Ming 腿经任务自带
`harness.mjs` 编排——单一实现,见设计文档 §5.3)。
