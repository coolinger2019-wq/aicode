# S4 内网 agent 工具服务(spec,T3 场景扩面 R-5)

> 状态:**spec 先行,不含实现**——plan §4.20 P1 R-5(T3 场景扩面 3/5 → 5/5)的
> spec 批次,沿 T3-pre 先例(f901665:spec 入库、实现另批)。实现批次(fixture/
> 三语言 solutions/verify/gap-log)在 spec 审查通过后另排,本 spec 审查通过前
> 不动工。对应 plan §4.15.3 T3 场景清单 #3("内网 agent 工具服务:serve v1 +
> JSON 载荷 + 超时/资源门禁;验收含坏请求/超大 body/并发压力")。
> 承诺面口径:验收只依赖 docs/stability-contract.md §2 P1–P8 已交付能力,不依赖
> §3 N1–N7(不断言性能/引擎归属——"必须走 wasm"即违规,契约 §5.6 口径)。
> 与既有语料的关系:B4 任务(b4_serve_handler)是 T1 侧 6 请求固定路由冒烟;
> 本场景是 T3 场景 #3 的**压测向**——扩展到 serve 层事件码标签、9MB 超大体、
> handler panic 隔离与服务存活、8 客户端 × 20 请求并发,B4 不覆盖这些面。
> **实现登记(2026-11-22,T3-impl)**:本 spec 已实现——gen_fixtures + 三语言
> solutions + verify.{ming,js,py}(transcript 逐字节/参数级/占用/交叉喂入/变异
> 全腿绿);R19 客户端形态定案与探针记录见 gap-log.md(GAP-S4-1/2/3/4)。

## 1. 场景目标(真实场景,非玩具)

内网 LLM agent 的工具调用服务(tool-calling service):agent 通过 HTTP POST
调用一组受限工具(数值求和/文本计数/路径放行检查),服务返回结构化 JSON。
请求载荷不可信——agent 输入可被 prompt 注入污染:坏 JSON、缺失/类型不符
字段、未知工具名、路径穿越参数(`../`)、超大请求体(handler DoS 面)、
故意触发的 handler 故障。服务必须四层设防,且各层失败**具名可辨**:

1. **serve 层资源门禁**:超过体上限的请求在 handler 执行**之前**被拒
   (413 + `body_too_large`,ADR-001 检查点 D"拒绝优于截断"),handler 不接触
   超大体;
2. **应用层请求分类**:坏形请求(坏 JSON/缺字段/错类型/未知工具)分类为
   具名应用标签,不 panic、不静默;
3. **污点闸门**:工具参数中的路径类值必须过净化器(`sanitize_path` 拒绝
   绝对路径/`..` 段),穿越参数被具名拒绝——"忘了校验请求输入"在 Ming 是
   编译失败(M3049),对照语言是手工约定;
4. **请求级隔离与存活**:handler panic → 500 + `handler_panic`(M 码进
   message),其余请求不受影响,服务不死;并发下**每请求响应内容 = f(该请求)**
   (worker 零共享,ADR-001 确定性口径)——本场景用"并发阶段的逐字
   transcript"把它变成黑盒可验收事实。

参数级错误(端口非法/绑定失败)与请求级失败(应用标签/serve 层事件码)是
两类失败:前者进程报错退出,后者是正常服务响应。

## 2. 程序形状与输入数据形态

### 2.1 调用形状(三语言一致;长驻服务)

```
prog <port>
```

- argv[1] = 端口号(整数位,经数值位消费纪律解析;非法端口/绑定失败 →
  stderr 恰一行以 `error:` 开头,**退出码 1**——v0.69 #65 惯用法,main 返回
  i64,mini-hub §2.5"Err 后 exit 0"运维陷阱的规避形态)。
- 服务绑定 **127.0.0.1**(serve v1 固定回环,签名无 host 参数),长驻;
  由验收器关停(serve v1 无优雅停机,Ok 路径不可达——预留)。
- **路由与响应契约**(应用协议,三语言逐字一致;紧凑 JSON 无空格,键序 =
  构造序):

| 路由/方法 | 语义 |
|-----------|------|
| `GET /health` | 200,体 `{"ok":true}`(就绪探针同款) |
| `POST /tool` | 工具调用(§3 决策树) |
| `/tool` 非 POST / `/health` 非 GET | 405,体 `{"ok":false,"code":"method_not_allowed"}` |
| 其余路径 | 404,体 `{"ok":false,"code":"not_found"}` |

- 应用标签集(`bad_json`/`missing_field`/`bad_args`/`unknown_tool`/
  `method_not_allowed`/`not_found`)是**本场景应用协议**(handler 产出,
  fixture 定义),与 serve 层八个事件码标签(承诺面,见 §6)**不同层、不混用**。
- 响应体必须构造为 **str**(std.json.stringify 产物)——S11 兜底语义
  ("body 非 str → 空体"静默)是 mini-hub 第一手踩坑(serve-observation §2.5),
  写入判据防重蹈;响应头设 `Content-Type: application/json`(与 serve 错误体
  惯例一致;**验收不比对响应头**——宿主附加头跨语言不同,§4 粒度条款)。

### 2.2 fixture 设计(由 gen_fixtures.ming 确定性生成;重跑逐字节不变)

布局 `tests/experiment/scenarios/agent_service/`:

```
input/requests.json        顺序阶段请求矩阵(23 个 case 描述符,§4 R1–R23;
                           含 method/path/body 描述/期望状态码/期望载荷或
                           code 标签/是否 normalize 腿)
input/concurrency.json     并发阶段工作负载描述(clients=8, per_client=20,
                           pattern 四态轮转,§4)
expected/expected_transcript.txt  全量 transcript 期望(逐字节;由参考实现
                           产出,三语言腿全绿 + 交叉喂入 FAIL 后入库——S3 惯例)
harness.mjs                服务生命周期编排(Ming 腿 verify 专用——Ming 无
                           外部进程管理面;单一实现,B4 先例):端口 base
                           21531 起 +7 重试(≤10)、启动被测服务、轮询
                           GET /health 就绪(≤6s,冷启动允许上调至 15s)、
                           执行请求矩阵、关停服务、transcript 走 stdout
verify.{ming,js,py}        三语言黑盒验收(T-impl;语义等价——verify.js/
                           verify.py 原生管理同语言服务生命周期,verify.ming
                           经 harness.mjs 编排)
solutions/solution.{ming,ts,py}  参考实现(T-impl;Ming = std.net.serve handler,
                           TS = node:http,Python = ThreadingHTTPServer——
                           同语义实现,三语言职责对齐既有场景惯例)
gap-log.md                 实现期建档(spec 预登记候选见 §6/§7)
```

- **超大请求体不落盘**:9MB 体 = 9437184 字节 `'x'` 重复,由各验收腿按
  确定性公式即时构造(Node `"x".repeat(9437184)` / Python `b"x"*9437184`),
  requests.json 中只记录 `size: 9437184` 描述符。理由(如实登记):仓库体积
  纪律(S2 单文件 ≤512KB 量级)不允许提交 9MB 二进制;体内容不参与判定
  (serve 层只看大小,handler 不接触);确定性由公式保证(无随机源)。
- Ming 腿启动命令显式 `--max-ms 86400000`(长驻配额惯用法,N-62.1;
  CLI 缺省 600000ms 对长驻服务必显式调大)。
- `.ts` 经 Node 直接执行(类型剥离;实验语料既有惯例,环境 Node ≥ 24)。

## 3. 被测程序职责(三语言 Ming/TypeScript/Python 同一语义)

### 3.1 handler 决策树(语言中立;判定序 = 第 0 条(路由层)先于编号 1–6,
各编号内首条命中即停)

`POST /tool` 的判定(`u.*` = 污值代数方法,数值位/谓词位输出净):

0. 路由层:`/tool` 非 POST 或 `/health` 非 GET → 405
   `method_not_allowed`;未知路径 → 404 `not_found`。
1. 请求体为空串或 `json.parse` 失败 → 400 `bad_json`(载体感知:污 str →
   `Result[Untrusted[Json], str]`;Err 载荷可能内嵌输入预览,handler 不
   消费 Err 载荷——响应由字面量直接构造)。
2. 根非对象 → 400 `bad_json`。
3. `tool` 字段缺失 → 400 `missing_field`;`tool` 非 str → 400 `bad_args`。
4. `args` 字段缺失 → 400 `missing_field`;`args` 非对象 → 400 `bad_args`。
5. `tool` ∉ {sum, count, path_check, boom} → 404 `unknown_tool`。
6. 工具分派(工具级校验失败统一 400 `bad_args`,缺失参数统一 400
   `missing_field`):
   - **sum**:`a`/`b` 缺失 → missing_field;任一非数值 → bad_args;任一为
     非整值数值 → bad_args(整值判定 = 数值 round-trip:取整后回比不等);
     成功 → 200 `{"ok":true,"result":<a+b 整数>}`。**加法溢出形态不构造**
     (i64 checked 加法溢出 → M4002 → 500 `handler_panic`;矩阵数值域受限,
     报告不得外推溢出行为;`as i64` 取整对超范围 f64 为饱和不 panic——
     宿主实测口径,round-trip 整值判定本身无 panic 面)。
   - **count**:`text` 缺失 → missing_field;非 str → bad_args;成功 →
     200 `{"ok":true,"result":<码点数>}`(char_len 口径,含非 ASCII)。
   - **path_check**:`path` 缺失 → missing_field;非 str → bad_args;
     `sanitize_path` Err(绝对路径/`..` 段/内部空段/空串)→ 400 bad_args;
     Ok → 200 `{"ok":true,"result":"ok"}`(**不回显路径**——结果恒为常量,
     规避三语言复刻 sanitize_path 全量规范化语义的逐字节风险;放行/拒绝
     决策本身即工具语义,规范化细节不进验收触达面,§4 粒度条款)。
   - **boom**:无条件触发 handler 内 panic(Ming = 具名运行时 panic 如空
     容器下标;TS = throw;Python = raise)→ 由各语言服务层转 500 +
     `handler_panic`(见 3.3)。

### 3.2 Ming 侧污点工作流(语义即上述判定;TS/Python 无污点系统,实现等价
判定函数,三语言行为规则逐字一致)

- **handler 形参 `Untrusted[Json]`**(v0.68 ADR-004:请求
  `{method, path, headers, body}` 整树标污,签名即全部含义)。取值经投影表:
  `get(k)` → `Option[Untrusted[Json]]`、`as_str()` → `Option[Untrusted[str]]`
  (载体收窄接污值代数全套)、`as_num()` → `Option[f64]` 净值。
- **路由与工具名匹配**:`method`/`path`/`tool` 是路径/比较串位——经
  `std.unstr.sanitize_cli_path` 净化后净域精确等值(校验不改写,授权位 =
  CLI 匹配/比较串,GUIDE §18;净化 Err(控制符)→ 404 `not_found` 回落)。
  跨污界 `==` 不可用(M3002,S3 探针实测)——净化是文档授权的等值通道
  (同载体污值间 `==` 类型检查可通过,B4 verify.ming 先例;污/净混比仍
  M3002)。
- **body 解析**:`json.parse(污 str)` → `Result[Untrusted[Json], str]`
  (v0.77 载体分派,污进污出;**json.stringify(Untrusted[Json]) → M3049**,
  请求内容不可能整体洗白进响应——echo 透传被编译期拦截,本场景工具设计
  天然合规:结果只由净值构造)。
- **工具计算**:sum = `as_num()` → f64 → `as i64` 窄型 + 整值 round-trip
  判定(全净值域);count = `as_str()` → `char_len()`(计数输出净,S3 同款);
  path_check = `sanitize_path`(Err → bad_args,Ok → 常量响应)。
- **响应构造**:全部字段由净值/净字面量构造,沿 GUIDE §18 serve 示例的
  `Map[str, Json] → stringify → parse` 往返形态(注入安全;键序 = Map
  插入序,P7 确定性);body 为 stringify 产物 str(S11 口径,§2.1)。
- handler 无效果声明(纯函数 handler ⊆ 白名单);main `-> i64 with net, io`
  (#65 退出码惯用法)。

### 3.3 TS/Python 服务骨架的复刻面(实现归属差异,行为黑盒一致)

- Ming 的 serve 层事件(413 `body_too_large`、500 `handler_panic`)由
  `std.net.serve` 基建承担(ADR-001 检查点 D/请求级隔离);TS(node:http)与
  Python(ThreadingHTTPServer)在服务骨架中**显式复刻同一行为**:体上限
  前置检查(超限 → 413 + `{"code":"body_too_large","message":…}`,handler
  不执行)、handler 异常捕获(→ 500 + `{"code":"handler_panic","message":…}`)。
- **message 字段不参与验收**(M 码 Ming 独有;非承诺面 N5 口径)——验收只锚
  状态码 + `code` 标签(§4 normalize 腿)。
- TS/Python 复刻面以**fixture 触达行为**为准:体上限拒绝(9437184 > 上限)
  与 panic 隔离;体上限具体值本身是参数值非承诺面(§6)。

## 4. 黑盒验收标准(对齐 scenarios/<name> verify 惯例)

- **transcript 定义**(三语言 verify 产出形态逐字一致):
  - 顺序阶段:`R<i> -> <状态码> <载荷>`,i = 1..23 按矩阵序;
  - 并发阶段:`C<c>R<j> -> <状态码> <载荷>`,c = 1..8 客户端序,j = 1..20
    客户端内请求序——**并发阶段的行序 = 客户端输入序,与服务端完成序解耦**
    (客户端各自按序记录、按客户端序聚合;跨语言一致)。
  - `<载荷>` 两态:应用腿 = 响应体逐字节;**normalize 腿(serve 层事件)**
    = `code=<标签>`(解析响应体取 `code`;message 不记录)。
  - transcript 与 `expected/expected_transcript.txt` 逐字节相等 = PASS
    (expected 由参考实现产出后入库,S3 惯例)。
- **顺序矩阵**(23 腿;叙事序:就绪 → 合法 → 坏形 → panic → 超大体 → 存活):

| # | 请求 | 期望 |
|---|------|------|
| R1 | GET /health | 200 `{"ok":true}` |
| R2 | POST /tool `{"tool":"sum","args":{"a":20,"b":22}}` | 200 `{"ok":true,"result":42}` |
| R3 | POST /tool `{"tool":"count","args":{"text":"héllo"}}` | 200 `{"ok":true,"result":5}` |
| R4 | POST /tool `{"tool":"path_check","args":{"path":"report.txt"}}` | 200 `{"ok":true,"result":"ok"}` |
| R5 | POST /tool `{"tool":"sum","args":{"a":-1,"b":1}}` | 200 `{"ok":true,"result":0}` |
| R6 | POST /tool `{"tool":"sum","args":{"a":1.5,"b":1}}` | 400 `{"ok":false,"code":"bad_args"}` |
| R7 | POST /tool `{"tool":"sum","args":{"a":"x","b":1}}` | 400 `{"ok":false,"code":"bad_args"}` |
| R8 | POST /tool `{"tool":"sum","args":{}}` | 400 `{"ok":false,"code":"missing_field"}` |
| R9 | POST /tool `{"tool":"count","args":{}}` | 400 `{"ok":false,"code":"missing_field"}` |
| R10 | POST /tool `{"tool":"path_check","args":{"path":"../etc/passwd"}}` | 400 `{"ok":false,"code":"bad_args"}` |
| R11 | POST /tool `{"tool":"path_check","args":{"path":"C:/temp"}}` | 400 `{"ok":false,"code":"bad_args"}` |
| R12 | POST /tool `{"tool":"nope","args":{}}` | 404 `{"ok":false,"code":"unknown_tool"}` |
| R13 | POST /tool `{"args":{}}` | 400 `{"ok":false,"code":"missing_field"}` |
| R14 | POST /tool `{"tool":5,"args":{}}` | 400 `{"ok":false,"code":"bad_args"}` |
| R15 | POST /tool `{"tool":"sum","args":"x"}` | 400 `{"ok":false,"code":"bad_args"}` |
| R16 | POST /tool `notjson{{{` | 400 `{"ok":false,"code":"bad_json"}` |
| R17 | POST /tool 空体 | 400 `{"ok":false,"code":"bad_json"}` |
| R18 | POST /tool `{"tool":"boom","args":{}}` | 500,`code=handler_panic`(normalize) |
| R19 | POST /tool 体 = 9437184×'x' | 413,`code=body_too_large`(normalize;handler 不执行) |
| R20 | GET /tool | 405 `{"ok":false,"code":"method_not_allowed"}` |
| R21 | POST /health | 405 `{"ok":false,"code":"method_not_allowed"}` |
| R22 | GET /nope | 404 `{"ok":false,"code":"not_found"}` |
| R23 | POST /tool `{"tool":"sum","args":{"a":40,"b":2}}` | 200 `{"ok":true,"result":42}`(**panic + 413 后存活探针**) |

- **并发腿**(8 客户端 × 20 请求 = 160 腿;客户端 c ∈ 1..8,请求序 j ∈
  1..20,按 `(j-1) % 4` 轮转):
  1. `sum`:`{"tool":"sum","args":{"a":<c>,"b":2}}` → 200
     `{"ok":true,"result":<c+2>}`——**结果随客户端号变化 = 每请求响应内容
     = f(该请求) 的黑盒证据**(worker 零共享,跨请求无串扰);
  2. `health`:GET /health → 200 `{"ok":true}`;
  3. `count`:`{"tool":"count","args":{"text":"agent"}}` → 200
     `{"ok":true,"result":5}`;
  4. `unknown_tool`:`{"tool":"nope","args":{}}` → 404 `{"ok":false,"code":"unknown_tool"}`。
  并发腿预期 160 行全部命中期望;**压力数字不做硬验收**——吞吐/延迟/内存
  不断言(N1 非承诺面);"并发 8 × 20 全部命中期望状态与载荷"即验收
  (8 并发 ≪ 16 worker + 256 队列容量,queue_full 不在触达面)。
- **参数级腿**(各:exit 1、stderr 恰一行以 `error:` 开头):端口非法
  (0/65536/非数字);端口被占(漂移机制外——实现腿可选用占用探测构造,
  探针项)。
- **负例腿**(T-impl):①交叉喂入——用 B4 solution 充当被测服务(路由不同)
  → 就绪探针失败/矩阵不命中 → 腿 FAIL;②expected 变异样本(改一处标签)→
  mismatch FAIL(逐字节比对有齿,S3 惯例)。
- **验收粒度 = fixture 可观测行为逐字节一致,非全规格覆盖**(设计 §8 缺口 8
  口径)。已知不触达边界,报告不得过度解读:serve 层其余六事件码
  (queue_full/timeout/bad_request/response_too_large/worker_start_failed/
  internal_error)无确定性跨语言触发形态,不在矩阵;handler 30s 超时(504
  timeout)不触达——30s 是参数值非承诺面,不做硬验收;体上限"恰好 = 上限"
  边界不构造(只构造明确超限的 9437184);响应头集合不比对(宿主附加头);
  chunked 传输编码不触达(fixture 恒带 Content-Length);非 ASCII 路径/
  query 参数不触达;sum 加法溢出(M4002 → handler_panic)形态不构造
  (矩阵数值域受限,§3.1 声明,报告不得外推溢出行为);TLS/HTTPS 不触达
  (serve v1 固定回环 HTTP;契约冻结期后 additive 清单项)。
- **实现批次首项探针(定案后才冻结 expected)**:9MB 体对 ming serve 的
  客户端可见行为(响应 413 vs 连接重置)——以参考实现实测产出为准
  (S3 惯例:expected 由参考实现产出后入库);TS/Python 骨架若遇早响应
  连接重置,采用"读弃超限体后回 413"等价复刻,以三语言 transcript 一致
  为判据。

## 5. 触达的 Ming 能力面(设计锚定;不确定项标注"实现前探针")

- 效果声明:handler 无效果(纯函数 ⊆ 白名单 {io, time, fs, net, env, rand,
  crypto, proc});main `fn main(args: Vec[Untrusted[str]]) -> i64 with net, io`。
- serve 面(v0.62/v0.68,P3):`std.net.serve(port, handler) -> Result[i64, str]`;
  handler 同模块命名函数;载荷 `Untrusted[Json]`;固定 127.0.0.1。
- 污点(P8):handler 形参整树标污 → 投影表(get/as_str/as_num,载体收窄);
  `json.parse` 载体分派(污 str → 污 Json,v0.77);污值代数 clean 谓词与计数
  (`char_len`);净化族 `sanitize_cli_path`(比较串授权位)/`sanitize_path`
  (路径工具);跨污界 `==` 禁用(M3002)——净化后净域等值。
- 净域面:窄型 `as i64` + round-trip 整值判定;`str(x)`/插值拼装净串;
  `Map[str, Json]` 构造 + `json.stringify`(净值)+ `json.parse` 往返
  (GUIDE §18 serve 示例形态);`parse_i64`(端口数值位,ADR-008)。
- 出向:响应 Json(handler 返回值);`eprint`(error: 行);退出码 1(#65)。
- 确定性(P7):响应内容 = f(请求)(serve 零共享 + handler 纯函数);
  Map 插入序;无时间/随机/哈希序依赖。
- **实现前探针清单**:①9MB 体客户端可见行为(§4)——reset 形态的
  transcript 行表示(如 `R19 -> <reset>`)随探针定案一并冻结;②无体请求
  的 `body` 字段形态(空串假设);③端口被占参数级腿的构造方式(占用
  探测);④`spawn`/元组参数如用于 verify 内部并发(仅验收器内部,不在
  被测面)。

## 6. 与 T2.3 承诺面的依赖标注

- **验收锚定的承诺面核心 = serve 错误体事件码标签**(复核位 #3 已裁决,
  契约 §6 #3 ①):serve 运维参数值(并发 16/队列 256/体 8MB/超时 30s)
  **不承诺**;八个事件码标签(`body_too_large`/`queue_full`/`handler_panic`/
  `timeout`/`worker_start_failed`/`response_too_large`/`internal_error`/
  `bad_request`)是 ADR-001 §2.1 登记的对外协议,**属承诺面**。本场景硬
  验收只锚 `body_too_large`/`handler_panic` 两标签(矩阵触达的 serve 层
  事件);体上限具体值 8388608 仅作 fixture 触发值——若 serve 参数演进
  (契约允许,随 GUIDE §24 登记),requests.json 的 size 字段同步调整,
  判据不变。状态码取值(413/500)按 GUIDE §18 现行文档断言,若随演进
  变更(GUIDE §24 登记)则 expected 同步再生——**标签是硬锚,状态码是
  文档锚**,粒度条款如实声明。
- **P7 确定性 = 并发腿逐字 transcript 的语义依据**:serve worker 零共享 +
  handler 纯函数 → 每请求响应内容 = f(该请求)(ADR-001 §2.1 收窄口径:
  跨连接完成顺序/延迟不在合同内——本场景 transcript 按客户端输入序聚合,
  恰好只断言合同内事实,不断言完成序)。
- **不依赖未实现语言面**:全部核心流程只依赖已交付版本行(serve v0.62/
  载荷污点 v0.68/json 载体分派 v0.77/净化族 v0.61/v0.64/argv v0.82);
  T2.2 冻结令已确认(2026-11-22),本场景实现不触碰任何承诺面变更。
- **不依赖 N1–N7**:不断言吞吐/延迟/内存(N1);不断言 wasm(serve 永不
  eligible——本场景 Ming 腿只跑 VM 引擎,不测引擎归属,N2);C 后端不跑
  (`ming cc` 发射期拒绝 serve,具名拒绝面,N3);不依赖 16/256/8MB/30s
  参数值(契约 §6 #3 ①)。
- **已知能力面缺口(gap log 位,登记不实现——plan §4.15.6 场景不扩面)**:
  ①handler 无法回显未净化请求内容(`json.stringify(Untrusted[Json])` →
  M3049;`stringify_untrusted` 污进污出变体登记候选不预支)——本场景以
  "结果只由净值构造"的工具设计消化,echo 类工具不纳入;②serve v1 无
  优雅停机 → 服务关停依赖外部 kill(harness 职责,非语言缺口);③无访问
  日志(跨连接 stderr 交错违反确定性,宁缺)→ 诊断靠响应体与错误标签;
  ④serve 层六事件码无确定性跨语言触发形态(实现性验证属 §66 既有测试,
  不入本场景黑盒面);⑤TLS/HTTPS 不触达(serve v1 固定回环 HTTP;契约
  冻结期后 additive 清单项——ADR-001 §5.2"v1 明确不做"清单)。

## 7. 已知风险与 gap log 位

- **早响应连接重置(最大实现风险,探针先行)**:9MB 腿服务端在读取完
  请求体之前回 413,客户端(fetch/urllib)可能见到连接重置而非响应——
  以参考实现实测定案(§4 末条);TS/Python 复刻面采用读弃后回 413 等
  价形态。三语言 transcript 一致是唯一判据。
- **端口漂移与占用**:base 21531 + 7 × ≤10(B3/B4 惯例);跨腿并行运行
  时由漂移机制避让;Ming 腿绑定失败经 `--max-ms` 显式调大前置不复现
  N-62.1 缺省杀服务形态。
- **跨平台进程关停**:harness `child.kill()`(B4 win32 实证先例);
  Python 腿 stderr 忽略(BaseHTTPRequestHandler 逐请求日志不参与验收)。
- **CI 边界(承诺面依赖标注)**:全量回归不含实验语料;CI node18 冒烟
  抽样含 1 个 T1 任务 verify(ci.yml:68,a1_log_clean),不含 T3 场景;
  `.ts` 直执行依赖 Node ≥ 22 类型剥离——实验环境 Node ≥ 24,与既有语料
  一致。
- **Python http.server 语义**:ThreadingHTTPServer + 手工 Content-Length
  响应;HTTP/1.0 连接语义不进验收(客户端按响应体断言);超时参数不
  复刻(504 腿不存在)。
- **冷启动轮询上限**:ming 冷启动(编译 + bind)在 6s 轮询内(实测 ~1–3s);
  慢机允许上调至 15s(探针项,不影响判据)。
- **gap log 位**:`docs/gap-log.md` 追加本场景条目;场景内 gap-log.md 逐条
  明细(spec 条目/实测行为/影响/建议);本 spec 预登记候选 = §6 五项缺口 +
  §7 六项风险 + §4 探针定案记录 + 实现期发现的任何口径分歧。
