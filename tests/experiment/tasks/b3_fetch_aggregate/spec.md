# B3 HTTP GET 汇总(spec)

## 任务

程序作为 HTTP 客户端,按参数顺序 GET 4 个本地 URL,解析响应 JSON,输出逐源
状态行与汇总;不依赖外网(模拟源由验收器在本机启动)。

## 模拟源协议(验收器保证,程序只需当客户端)

- 3 个数据源 + 1 个 404 端点,全部 127.0.0.1:
  - `GET <p1>/source1` → 200,体 `{"source":"alpha","total":87,"items":[1,2,3,4]}`
  - `GET <p2>/source2` → 200,体 `{"source":"beta","total":30,"items":[5,6]}`
  - `GET <p3>/source3` → 200,体 `{"source":"gamma","total":42,"items":[7,8,9]}`
  - `GET <p1>/missing` → 404,体 `{"code":"not_found"}`
- 端口每次运行可能不同;**程序不得硬编码端口**,只使用参数传入的 URL。
- 响应体中的 `total` 与 `items` 长度是唯一被消费的字段(`source` 字段不输出)。

## 程序行为

- argv[1..4] = 4 个 URL,按参数顺序逐个 GET。
- 对每个 URL(按序号 i = 1..4):
  - HTTP 200 且响应体为合法 JSON → `src<i> ok code 200 items <items 长度> total <total>`
    (total 为整数)。
  - HTTP 状态非 200 → `src<i> failed code <状态码>`。
  - 网络层失败(连接失败/超时等)→ `src<i> failed code 0`。
- 末行汇总:`summary ok=<ok 数> failed=<failed 数> grand_total=<ok 源的 total 之和>`。

## 输出示例(演示格式,非真实数据)

两个源 ok(items 2/1,total 10/5)、一个 404、一个连接失败:

```
src1 ok code 200 items 2 total 10
src2 failed code 404
src3 ok code 200 items 1 total 5
src4 failed code 0
summary ok=2 failed=2 grand_total=15
```

## 验收

验收器启动模拟源,把 4 个真实 URL 作为参数运行被测程序;stdout 与
`expected/expected.txt` 逐字节相等,退出码 0。

## 错误行为

- 参数少于 4 个:stderr 一行以 `error:` 开头,退出码 1,stdout 空。
- 单个源失败**不是**程序级错误(照常输出 failed 行,退出码仍 0)。
