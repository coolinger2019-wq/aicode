# 真实 serve 服务观察(v0.66 · mini-hub 有界观察)

> 数据快照:2026-11-14,基线 HEAD `6bf5513`(v0.65.0)。plan §4.5.3 任务 3。
> 诚实边界:**有界观察**——本会话内可观测约 **12.8 分钟**(18:41:41–18:54:26),不是 24h 长驻;RSS 与计数为该窗口内的实测,长期漂移(内存碎片/句柄/日志增长)未覆盖。
> 服务:`mini-hub.ming`(真实自用小服务,单文件,源码在 `C:\Users\COOLIN~1\AppData\Local\Temp\ming-v66-serve\`,不入仓)——/health 活性、/stats 请求计数(fs 持久)+运行时长、/echo 回显、/slow 3s 慢请求(停机观察用)、/panic 故意 panic(错误体观察用)、其余 404。命令:`node bin/ming.js run mini-hub.ming --max-ms 86400000`,端口 127.0.0.1:27890。

## 0. 环境

| 项 | 值 |
|----|----|
| 主机 | Windows 10.0.26200 x64,Git Bash,Node v24.11.0 |
| Ming | v0.65.0(`node bin/ming.js version`) |
| 服务形态 | `std.net.serve(27890, handler)`,handler 为同模块命名 fn,效果 `with fs, time`(白名单内);main `with io, net, fs, time` |
| 状态模型 | 无共享态(worker-per-request 隔离)→ 计数器走状态文件 `mini-hub-state.txt`(读-改-写,每请求一次;并发写未防护,单人使用可接受) |
| `check` | `ming check mini-hub.ming` 一次通过,0 诊断 |

## 1. 时间线(实测)

| 时刻 | 事件 | 实测结果 |
|------|------|----------|
| 18:39:49 | 第一次后台启动(日志重定向因 shell 细节未落盘,实例"孤儿"运行) | 服务正常绑定 27890(PID 2868) |
| 18:40:03 | 第二实例启动 → **绑定失败路径顺带实证** | `serve 失败: serve: 绑定失败(端口 27890): listen EADDRINUSE…` → Err 分支 eprint 后 **exit 0**(运维陷阱:服务没起来但退出码是成功,见 §4-4) |
| 18:41:41 | **正式 t0**:修复后重启(PID 15124) | stdout:`state 初始化完成` + 启动横幅;netstat LISTENING |
| 18:41:53 | /health | `{"ok":true,"service":"mini-hub"}` **200,72ms** |
| 18:41:53 | /stats ×2 | `requests_total: 1 → 2`,uptime 递增——**计数跨 worker 递增确认**(文件持久) |
| 18:42:06 | /panic(空 Vec 下标) | **500,65ms**,错误体 `{"code":"handler_panic","message":"M4003: 索引越界:长度 0,访问 0(用 .get(i) 返回 Option)"}`;随后 /health 200、/stats 继续计数——**服务存活,M 码完整可诊断** |
| 18:42:06 | /echo GET + POST(--data-binary UTF-8) | method/path/body/User-Agent 逐字回显,中文 body(`你好`)完整往返;404/405 分支均正确带 Json 错误体 |
| 18:42:15–19 | RSS 采样 + 30 请求 burst | 92,492K(9 请求)→ burst 后 **91,820K**(34 请求)——无堆积 |
| 18:46:26 | **5min 标记** | 健康 200;requests_total 35;RSS **91,876K** |
| 18:53:41 | **10min 标记(720s,已过 600s 缺省配额线)** | 健康 200;requests_total 36;RSS **92,996K**——**`--max-ms 86400000` 覆盖生效实证**(N-62.1:若旗标无效,600000ms 缺省会在 18:51:41 前杀掉服务) |
| 18:53:59 | /slow 在途(3s handler sleep) | 在途期间 RSS 峰值 **102,072K**(较稳态 +9MB,慢 worker 占用),完成后回落 93,008K |
| 18:54:26 | **停机实验**:/slow 在途 1.2s 时 `taskkill /F` | 进程立即终止;**在途请求 curl exit 56(connection reset)、http 000**——无 drain、无响应体;端口立即释放;状态文件完好;serve.log 无任何停机输出(serve 无返回路径,v1 无优雅停机) |
| 合计 | 有界观察 ≈ 12.8 分钟,56+ 次请求 | 200 全部正常,500 ×1(人为 panic),停机 RST ×1(实验制造) |

## 2. 五项观察记录

### 2.1 `--max-ms 86400000` 长驻配额(N-62.1)——**工作正常**

实测证据:服务在 720s(> 600s CLI 缺省线)时仍健康 200(18:53:41 采样),证明 86400000ms 覆盖真实生效;若旗标无效,M4012 会在 600s 整触发。缺省 600000ms 对长驻服务"必显式调大"的 GUIDE 口径与行为一致。24h 之外的漂移未观测(有界观察边界,如实声明)。

### 2.2 55MB/worker 与 RSS 实测——**无 per-worker 堆积**

稳态 RSS **92–93MB**(单 Node 进程,含 main VM + accept 层);30 请求 burst 前后 92,492K → 91,820K(不升反降 0.7%);10min 标记 92,996K;单个慢 worker 在途期间峰值 +9MB(102,072K),完成后即回落。**worker-per-request 的内存随请求销毁,RSS 不按 worker 数线性累积**——"55MB/worker"的静态估计未在进程 RSS 上兑现为堆积(线程共享进程内存,请求后销毁)。单人回环场景 55MB 级常驻开销无实际影响。

### 2.3 优雅停机需求是否真实出现——**未自然出现;硬杀行为已实测**

- 观察窗口内(12.8 分钟真实使用)无一次自然停机需求;/slow 3s 是实验制造的 drain 窗口。
- 硬杀实测(taskkill /F,等价 kill -9):**在途请求直接 RST**(curl exit 56,http 000),无 drain、无错误体、无日志;端口立即释放可重启;文件状态无损坏(每请求 read-modify-write,杀在两次写之间最多丢一次计数)。
- 附带:Git Bash 内 `kill`/`kill -INT` 对**其他会话启动的**服务进程不可达("No such process"——沙箱/会话隔离);跨会话杀进程只能 taskkill。运维上"停服 = OS 级杀",v1 无主动停服 API(serve 永不返回,Ok 路径预留)。
- 判断:127.0.0.1 单人自用、请求亚秒级、状态文件化的场景下,**drain 需求 ≈ 0**;RST 的真实代价是"重启瞬间正在处理的请求失败一次",当前无真实负载会撞上。

### 2.4 handler 效果白名单够用性——**够用,一次通过**

mini-hub handler 实际使用了 `fs`(状态文件读写)+ `time`(uptime);main 使用 `io, net, fs, time`——全部在白名单 `{io, time, fs, net, env, rand, crypto, proc}` 内,`check` 首跑 0 诊断。结构性限制如实登记:(1) handler 闭包/捕获禁用 + 无共享态 → **任何跨请求状态都必须走文件**(计数器即如此);(2) **无自省 API**(PID/RSS/内存)→ /stats 想返回进程内存做不到,本观察改用外部 `tasklist` 工作集列——若希望 /stats 自带 RSS,需要新 std 面(另立 ADR,不属 v1.1 优雅停机)。

### 2.5 错误体 Json 可诊断性——**好;但兜底语义有第一手踩坑**

- /panic → **500,65ms**,`{"code":"handler_panic","message":"M4003: 索引越界:长度 0,访问 0(用 .get(i) 返回 Option)"}`——M 码 + 消息 + 可行动后缀全在,服务不死,下一请求正常。可诊断性达标。
- **第一手踩坑(诚实登记)**:本服务首版把响应 `"body"` 构造成 Json 对象(而非 str)→ 200 + **空体**,无任何诊断——S11 兜底语义("body 非 str → 空体;handler bug 不会变成 500,排查靠自测")在真实使用的第一个响应就命中。修正 = `"body": jstr(std.json.stringify(obj))`(body 必须是 JSON 文本的 str)。对 AI 协作,这是 v0.66 快照同款问题的 serve 侧翻版:**静默兜底替代了诊断**——建议 serve 兜底至少在服务端 stderr 留一行(不改变 HTTP 行为,不属语义裁决)。
- 绑定失败路径(顺带实证):端口占用 → Err 分支 eprint 明确(EADDRINUSE 带端口),但 **main 正常退出 exit 0**——见 §4-4。

## 3. serve v1.1(优雅停机 + 可选 maxConnections)go/no-go

判据(plan §4.5.3 任务 3 / §4.5.4):go = 观察到**真实**停机需求或资源异常;no-go = 无此需求且行为可接受。

| 项 | 实测 | 是否构成 go 依据 |
|----|------|------------------|
| 真实停机需求 | 12.8 分钟真实使用零自然停机;RST 仅在实验制造的 3s drain 窗口出现 | 否(需求未自然出现) |
| 资源异常 | RSS 92–103MB 稳定,burst/慢请求均回落,无泄漏无堆积 | 否 |
| 硬杀行为 | 在途 RST、端口立即释放、状态文件完好、重启即恢复 | 可接受(单人回环) |
| 停服手段 | v1 无主动停服 API,"停服 = OS 杀" | 可接受但需文档(重启语义 = 杀进程) |

**裁决: no-go(推迟优雅停机实现)**——判据两项(go 条件)均未满足:无自然停机需求、无资源异常;硬杀行为在真实场景(单人、亚秒请求、文件状态)下可接受。本裁决为**有界观察**支撑(12.8 分钟 / 56 请求),若后续出现多客户端、长连接或状态升级(如需要 flush 的外部资源)需求,以新观察重开。**随裁决顺带登记两件小事(非 v1.1 范围,Backlog 级)**:(1) serve 失败分支 `Err(e)` 后 main exit 0——部署陷阱,建议文档明示"main 收到 serve Err 应自行非零退出(当前语言无直接退出码面,可用 panic 替代)";(2) S11 响应兜底建议补一行服务端 stderr 提示(诊断面增强,不改 HTTP 行为)。

## 4. 观察产物清单

| # | 观察点 | 结果 |
|---|--------|------|
| 1 | N-62.1 `--max-ms 86400000` | ✓ 生效(720s 存活 > 600s 缺省线) |
| 2 | 55MB/worker RSS 真实影响 | 稳态 92–93MB,无 per-worker 堆积;慢 worker 瞬时 +9MB |
| 3 | 优雅停机需求 | 未自然出现;硬杀在途 RST 已实测;no-go(推迟) |
| 4 | handler 白名单够用性 | 够用(fs+time 一次通过);跨请求状态必须文件化;无 PID/RSS 自省 API |
| 5 | 错误体 Json 可诊断性 | handler_panic 带 M4003 全文 65ms 返回,服务存活;S11 空体兜底有第一手踩坑 |
| 6 | (顺带)绑定失败 | EADDRINUSE → Err eprint 明确,但 exit 0(运维陷阱登记) |

## 5. 复现

```bash
cd "C:\Users\COOLIN~1\AppData\Local\Temp\ming-v66-serve"
node C:/code/aicode/bin/ming.js run mini-hub.ming --max-ms 86400000   # 长驻(另会话)
curl http://127.0.0.1:27890/health; curl http://127.0.0.1:27890/stats  # ×2 看计数递增
curl http://127.0.0.1:27890/panic                                       # 500 handler_panic + M4003
netstat -ano | grep :27890        # 取 PID → tasklist /FI "PID eq <pid>" 看 RSS
# 停机实验:curl /slow 后 1.2s 内 taskkill /F /PID <pid> → 在途请求 curl exit 56
```

服务源码、状态文件、serve.log 与本节时点数据均为会话工件(os.tmpdir,不入仓);本文件只登记实测数字与裁决,不携带源码全文。
