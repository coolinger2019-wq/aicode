# S4 内网 agent 工具服务 — 实现期 gap log(T3-impl,2026-11-22)

> 逐条格式:spec 条目 / 实测行为 / 影响 / 建议。spec 本体不改(仅头注下方加实现登记行)。
> 能力面核对结论:本场景全部核心流程在 T2.3 承诺面(P1–P8)既有能力内实现成功
> (serve handler `Untrusted[Json]` 整树标污 → 投影表 + `sanitize_cli_path` 比较串位 +
> `json.parse` 载体分派 + 工具结果全净值构造),未遇到不可绕过的 M3049/M3050 拒绝。
> 三语言(ming/ts/py)transcript 逐字节一致(23 顺序 + 160 并发,sha256 cfb63412…一致)。

## GAP-S4-1 9MB 全量体发送对 ming serve = 客户端可见竞态(spec 字面实现不稳定)

- **spec 条目**:§2.2 "9MB 体 = 9437184 字节 'x' 重复,由各验收腿按确定性公式即时构造
  (Node "x".repeat(9437184) / Python b"x"*9437184)";§4 末条探针 "9MB 体对 ming serve
  的客户端可见行为(响应 413 vs 连接重置)——以参考实现实测产出为准"。
- **实测行为**:ming serve 对带 Content-Length 头的超限体在 handler 执行**之前**回
  413 并 destroy 连接(ADR-001 检查点 D"拒绝优于截断");全量体发送下客户端可见
  形态为**竞态**——隔离变体探针 12/12 + 显式头 5/5 干净 413,但全矩阵冒烟出现
  1 次 ECONNRESET(约 5% 失败率;机理 = 服务端早响应 + destroy 的 RST 在 Windows
  上丢弃客户端尚未读取的缓冲响应)。单一形态无法冻结,逐字节 expected 不可达成。
- **保守裁决(实现形态)**:R19 客户端 = **头-only 声明尺寸请求**(node:http /
  http.client 显式 `Content-Length: 9437184`、不发送体字节,实测 20/20 干净 413)。
  判定事实(声明尺寸 > 上限 → handler 不执行回 413)完整触达;体内容不参与判定
  (spec §2.2 自有理由:"serve 层只看大小,handler 不接触");TS/Python 服务端 =
  **体上限前置检查**(spec §3.3 首选复刻形态;"读弃超限体后回 413" 回退形态因
  头-only 客户端永不触发早响应竞态而无需启用);transcript 行冻结为
  `R19 -> 413 code=body_too_large`,三语言 transcript 一致(§7 唯一判据)保持。
- **影响**:验收判据零放宽——normalize 腿锚定的状态码与 code 标签不变;仅客户端
  构造形态从"全量体发送"收窄为"声明尺寸头-only"(9MB 二进制本就不落盘)。
- **建议**:spec 后续修订时把 §2.2 的客户端构造公式改写为"声明尺寸描述符经
  Content-Length 头传输(头-only)"并注明竞态理由;或 serve 层后续版本把早响应
  destroy 改为读弃后响应(语言面变更,不在场景域)。

## GAP-S4-2 端口被占参数级腿:占用探测构造(spec §4 探针项)定案

- **spec 条目**:§4 参数级腿 "端口被占(漂移机制外——实现腿可选用占用探测构造,
  探针项)";§5 探针清单 ③。
- **实测行为**:ming 无端口持有面(无 bind/listen 内建)→ 占用持有人放 harness.mjs
  `--occupy` 模式(漂移找第一个可绑定端口 → 持住 → 起服务 → 等退出 → stderr 转发);
  ming serve 绑定失败实测 = `error: serve 失败: serve: 绑定失败(端口 N): listen
  EADDRINUSE…` exit 1(stderr 恰一行)。verify.js/verify.py 原生持有(net.createServer /
  socket 模块),三语言腿全实现该腿。
- **影响**:探针项落为三语言一致的可验收腿(非必选→已实现);判据不变。
- **建议**:无。

## GAP-S4-3 交叉喂入腿的"错服务"判定协议(spec §7 交叉喂入形态的效率定案)

- **spec 条目**:§4 负例腿 ① "交叉喂入——用 B4 solution 充当被测服务(路由不同)
  → 就绪探针失败/矩阵不命中 → 腿 FAIL";§7 端口漂移 base 21531 + 7 × ≤10。
- **实测行为**:B4 solution 对 /health 回 404(服务启动成功但路由不同)——若按
  "就绪超时"判定,漂移 10 候选 × 15s 就绪窗 = ~150s/腿。实现:就绪轮询中**连续
  5 次 /health HTTP 非 200 响应** → 判"错服务"立即失败(harness exit 3;verify.js/py
  同口径);冷启动的连接拒绝不计入(服务未就绪 ≠ 错服务)。交叉喂入腿实测 ~3s。
- **影响**:负例腿语义不变(预期 FAIL 仍成立),执行时间从 150s 收敛到 3s。
- **建议**:无。

## GAP-S4-4 实现期环境地雷两则(客户端/服务端骨架,非 spec 分歧)

- **spec 条目**:§7 "Python http.server 语义"/§2.1 三语言一致。
- **实测行为**:① Python http.client 对 str 体按 latin-1 编码("héllo" = 39 字节)
  与显式 UTF-8 Content-Length(40)失配 → 服务端按 CL 读挂(R3 timeout)——客户端
  必须显式 `body.encode("utf-8")` 字节发送;② Python ThreadingHTTPServer 缺省
  request_queue_size=5,8 客户端并发连接溢出 → ECONNREFUSED(实测并发腿 C8R1 一次
  失败)——Server 子类 request_queue_size=64。两者均已内置,三语言 transcript
  逐字节一致后入库。
- **影响**:零(实现内置);登记为后续 T3 执行者的环境地雷(与设计文档 §8 同性质)。
- **建议**:如后续采集器覆盖 T3 场景,可并入设计文档 §8 地雷清单。

## 探针定案记录(spec §5 四项,实现批次首项)

1. **9MB 早响应形态**:全量体发送 = 竞态(GAP-S4-1);头-only 声明尺寸 = 干净 413
   (20/20);transcript 行表示冻结为 `R19 -> 413 code=body_too_large`(无 reset 形态)。
2. **serve 启动就绪协议**:serve 无内置就绪信号(永不返回)→ 就绪 = 外部轮询
   GET /health 至 200(150ms 间隔,≤15s 冷启动窗);GET 无体请求的 `body` 字段 =
   空串(源码 + 运行时双确认:is_str=true、byte_len=0);boom panic 实测 =
   500 `{"code":"handler_panic","message":"M4003: 索引越界:…"}`(M 码进 message,
   与 §66 v66.6 断言一致),panic 后 /health 200(请求级隔离)。
3. **并发腿 harness 端口段**:base 21531 + 7i(i=0..9);三 verify 并发运行由漂移
   避让(transcript 腿绑定失败 → 次候选;占用腿同样漂移);ming 腿启动命令显式
   `--max-ms 86400000`(N-62.1 惯用法;旗标在 `--` 之前实测可用)。
4. **非法端口参数级腿**:0/65536/-1 → serve Err `端口非法(需 1..65535 的 i64)`
   exit 1;非数字 → parse_i64 Err exit 1;stderr 恰一行 error: 开头(三语言同形)。

## GAP-S4-5 验收断言收紧(2026-11-23 独立审查 MINOR-2/3 收口)

- **spec 条目**:§4 参数级腿 "stderr 恰一行以 error: 开头"(M2);§4 负例腿 ①
  "交叉喂入……就绪探针失败/矩阵不命中 → 腿 FAIL"(M3)。
- **实测行为**:M2——六份 verify(S4/S5 × ming/js/py)的参数级腿(含 S4 端口被占
  腿)补"stderr 恰一行"断言:ming `split("\n")` 段数 == 2 且末段空 / js·py `\n`
  计数 == 1 且以 \n 结尾(py 侧 universal newlines 已归一 \r\n);三份 solution 的
  stderr 恒一行(读码确认),断言零假红。M3——交叉喂入负例腿收紧为**具体 FAIL
  形态**:S4 = harness exit 3(错服务;ming 实测 B4 喂入恒 exit 3)/ verify.js·py
  `error === "wrong-service"`,排除 no-start(exit 2)静默通过;S5 = S2 solution
  exit 1 + stderr error: 行 + stdout 空(实测三语言恒此形态"需要 <dir>
  <manifest.txt> <key> 三个参数")。
- **影响**:判据收紧方向(更严),零放宽;复验六 verify 全 PASS。
- **建议**:无。
