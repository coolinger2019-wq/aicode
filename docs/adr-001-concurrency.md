# ADR-001:并发与服务端选型(worker-per-connection vs green-thread vs Node async 桥)

> **状态**:提案(条件承诺——评审清单全勾后才进入实现)· **日期**:2026-11-13 · **版本基线**:v0.58.0(825 项回归全绿)
> **关联**:docs/plan.md §4.3.6(v0.59 条件承诺)· docs/design.md §6.3(北星支柱 3:海量并发网络)· docs/capabilities.md(TCP/UDP/服务端 ❌、10 万级连接 ❌)
> **立场声明**:本 ADR 只交付设计文档,**不写任何语言实现代码**。文中全部数字为仓库现状实测(标注〔实测〕,环境 Node v24.11.0 / win32-x64 / 2026-11-13)、源码确认(标注〔源码确认〕)或 Node 原型实测(标注〔原型实测〕,脚本放系统临时目录不入仓,见 §2.4);无一处来自想象。

> **2026-11-13 三方评估修订**:serve 实现从计划 v0.60 移至 **v0.62 独立条件版**;启动条件仍为评审清单 16 项全勾 + v0.60 资源门禁一致性已交付(per-request timeout 依赖 #53 的 `--max-ms` 钳制)。测试分节号由 §63 改为 **§66**(§63 已被 v0.59 占用)。见 plan §4.4.6/§4.4.10。

---

## 1. 背景与问题

### 1.1 现状

- **北星支柱 3**(design.md §6.3)如实记录:"现状 worker-per-task 不适合几十万连接。远期:async/green-thread 运行时(与确定性语义的调和是设计难点)"。capabilities.md 对应两行 ❌:TCP/UDP/服务端、海量并发网络(10 万级连接)。
- **已有基建**〔源码确认,src/interp.js〕:
  - `std.sync`(v0.14):`spawn` / `spawn_all` / `join` / `join_detailed` / `cancel` / `sync scope`——每任务一个**隔离子 VM**(worker_threads),参数/结果经 **wire 序列化**(vToWire/wireToV)深拷贝跨越边界;panic 经 wire v2 还原为 `{code, message, stack}`;SAB + Atomics 阻塞等待;join_detailed 支持**超时硬杀(M4010)**。
  - `std.net` 客户端(v0.27):`http_get` / `http_request` / `http_request_opts`——worker 线程内 fetch + 主线程 Atomics.wait 阻塞,响应经 SAB 传回(体上限 8MB、默认 35s 超时、头 Map 可读)。
  - **v0.27 已登记的死锁教训**(GUIDE std.net 节):测试服务器必须放独立进程——同进程的 HTTP 服务器会因主线程被 Atomics 阻塞而无法 accept。这条教训是本 ADR 方案 a 架构的直接输入(§2.1)。
- **wire 类型面**〔源码确认,src/interp.js `vToWire`〕:int / u64 / float / bool / str / unit / **Json** / Vec / Map / Option / Result / **tuple** 可跨;struct / 用户枚举 / 闭包拒绝。这决定了 handler 的载荷形态(§2.1)。
- **效果集**〔源码确认,src/checker.js〕:`io, time, fs, net, sync, proc, env, rand, crypto, ffi, unsafe` 共 11 个;`net` 已存在(http_get 三入口使用)。

### 1.2 实测基线(2026-11-13,Node v24.11.0 / win32-x64)

| 量测 | 结果 |
|------|------|
| `spawn`+`join` 单任务全管线(worker 启动 + 导入 checker/vm/interp + check+compile + 执行 + wire 回传)〔实测〕 | **~50ms**(三次 49/50/51ms) |
| `spawn_all` N=8 / 32 / 64 / 128 总耗时〔实测〕 | ~83 / 230 / 445 / **947ms** |
| 边际 worker 成本(主线程 `new Worker` 调用序列化;worker 内模块导入与编译并行)〔实测,由上两行差分推算〕 | **~6.5–7ms/worker** |
| 纯 Node worker_threads(不含 Ming 运行时导入)创建+启动+往返〔实测〕 | ~16.7ms/worker |
| 纯 Node worker RSS / heapUsed〔实测〕 | **52–55MB / ~6MB**(大头是预留地址空间) |
| `ming run` 空程序进程总时长〔实测〕 | ~105ms |
| 嵌套 spawn(worker 内再 spawn worker)〔实测〕 | **成功**(`outer` 内 `spawn(inner)` 返回 42,exit 0) |
| 128 个 worker 同时存活 | 全部成功〔实测〕——机械上限远超语义上限,内存才是真约束 |

**基线结论**:worker-per-connection 的真实成本是**内存**(55MB/worker → 16 并发 ≈ 0.9GB、100 并发 ≈ 5.5GB;RSS 口径,commit 区分见 §2.3 备注),不是 CPU。该模型的诚实上限是**数十级连接**,与北星支柱 3 的"10 万级"差约三个数量级(§4 诚实边界)。

### 1.3 约束(不可交换,来自 AGENTS.md 硬规则与 plan §4.3.2)

1. **确定性**:同输入同输出;调度序可复现;不得引入依赖时间/随机/哈希序的可观测行为。
2. **效果门禁**:碰 net 的代码必须在签名声明,M3029 逐层传播;签名即全部含义。
3. **零依赖**:不引入 npm/包注册表;**Node 内建模块允许**(worker_threads / node:crypto 已有同款先例)。
4. **四后端语义合同**:tree / VM+wasm / VM-only / C 的行为边界必须诚实——真实执行与显式拒绝都算一致,静默错误行为不算。

### 1.4 要回答的问题

服务端/并发的下一个语义面以什么形态进入语言面?三个候选:(a) worker-per-connection 阻塞模型;(b) 解释器内 green-thread 调度;(c) Node async 桥。评分维度六项:确定性 / 效果系统表达 / 零依赖 / 四后端一致性 / 实现成本(以现有 sync/proc 基建为基准)/ 可回退性。每维 1–5 分。

---

## 2. 三方案

### 2.1 方案 a:worker-per-connection 阻塞模型(复用 spawn/wire 基建)

**架构草图**

```
Ming 主线程(VM,同步 JS 形态不变)         宿主线程(worker_threads)
│ std.net.serve(port, handler)  with net
│   ├─ 主线程 Atomics.wait 阻塞协调(与 join/http_get 同款纪律)
│   └─ accept 线程(1 个宿主 worker,自带事件循环)
│         ├─ node:http server.listen(port, '127.0.0.1')
│         │   ← v1 固定本机回环(签名无 host 参数 = 隐式 127.0.0.1,见要点/清单 15);
│         │     同时是 v0.27 死锁教训的镜像:服务器必须在"不被 Atomics 阻塞的线程"上 accept
│         ├─ [accept] 连接到达 → node:http 解析请求行/头(宿主职责,Ming 不可见)
│         ├─ 背压:活跃 worker ≥ 上限 → FIFO 等待队列(到达序 = 确定序);
│         │        队列也满 → 立即 503
│         ├─ [wire] 请求 → Json{method, path, headers, body} 深拷贝(vToWire 同款)
│         ├─ 请求 worker(每请求 1 个,复用 syncWorkerCode 管线;连接只是传输——
│         │     keep-alive 空闲连接不占 worker,见要点)
│         │     重建 checker + VMInterp(capture:true)→ 调 handler(模块级命名函数)
│         ├─ [wire] 响应 Json{status, headers, body} 经 SAB 回 accept 线程写 socket
│         └─ [close] worker terminate(spawn_all 同款);请求计数 +1
└─ serve 不返回(v1 无优雅停机;Ctrl+C 杀进程)
```

要点:**worker 按请求分派,连接只是传输**——node:http 默认 keep-alive,若按连接占用 worker,空闲长连接即可平凡占满全部并发名额(平凡 DoS);worker 是"请求 Json → 响应 Json"的纯函数(与 spawn 的"参数进、结果出"完全同构),accept 线程独占 socket 读写,主线程只做协调,不跑 accept(否则重演 v0.27 死锁)。**监听地址**:v1 固定 `127.0.0.1`——`serve(port, handler)` 签名无 host 参数 = 隐式回环,绝不绑外网接口(node:http 缺省绑全部接口,与"面向安全工具语言"冲突);放开自定义 host/内网监听属后续 ADR(需显式 host 参数 + 文档警告,评审清单第 15 项)。handler 的候选形态因 wire 类型面而受约束:struct/用户枚举不能跨任务,所以 v1 载荷选 **Json**(一等类型,全部字段 wire 安全);tuple 也可跨,作为备选形态(评审清单第 3 项二选一)。

**确定性口径(收窄后的准确主张)**:零共享保证的是响应**内容**与 OS 调度无关——handler 不声明 `time` / `rand`(白名单含二者,声明者本身即非确定)时,**每请求响应内容 = f(该请求)**;accept 序/入队序按到达序,确定。两个既有机制佐证:spawn_all 结果**按输入序**聚合、与完成序解耦(src/interp.js:2007-2026);每 worker 独立配额 maxSteps/maxAlloc/maxMs(src/interp.js:1948-1950),单请求响应内容不受其他连接资源消耗影响。**不在语义合同内的**:跨连接完成顺序、单请求延迟、超时/队列触发时刻——这些天然依赖 OS 调度,语言层不承诺、也无法承诺(访问日志因此宁缺,§4)。

**生命周期与效果检查点**

| 检查点 | 位置 | 内容 |
|--------|------|------|
| A 编译期·签名 | checker | `serve` 登记 `net` 效果(与 http_get 同表);调用方未声明 net → M3029 逐层传播 |
| A 编译期·handler | checker | handler 必须是模块级命名函数(闭包/本地 fn → 静态拒绝,与 spawn 的 M4001 纪律同源);**效果白名单** = `{io, time, fs, net, env, rand, crypto, proc}`;含 `sync` / `unsafe` / `ffi` → 编译期拒绝(v1) |
| B 运行期·形态 | serve builtin | handler 值形态复查(M4001,与 syncSpawn 同款);端口参数校验 |
| C accept | accept 线程 | node:http 解析(宿主语义,不进 Ming 合同) |
| D 体上限 | accept 线程 | 请求体 > 8MB → 直接 413,handler 不执行("拒绝优于截断"是仓库既有口径:fs.read_bytes 对超限文件返回 Err 而非截断,src/interp.js:1341-1342;wire 32MB 上限不触) |
| E 背压 | accept 线程 | 并发 worker 上限(建议 16)+ FIFO 等待队列(建议 256),超额 503;队列按到达序,确定;排队缓冲上界 = 256 × 8MB = **2GB**(背压参数的内存代价;§2.4 原型佐证参数量级) |
| F wire 边界 | accept 线程 ↔ worker | 请求/响应 Json 深拷贝;**请求间零共享**(值语义在任务边界已保证) |
| G 响应写出 | accept 线程 | 响应体 > 8MB → 500 并关闭(不截断——截断会破坏 Content-Length,诚实失败优于静默破坏) |

**错误处理(M 码语义)**:v1 目标**零新增诊断码**——网络级故障走 Err 值(数据驱动,与 http 客户端同款),API 误用走既有静态/运行时码,handler 故障走请求级隔离(服务端不死)。

| 故障 | 语义 | 码/响应 |
|------|------|---------|
| 端口绑定失败(EADDRINUSE/权限) | Err 值,不 panic | `Err[str]` |
| 端口参数非法(负数 / >65535) | Err 值 | `Err[str]` |
| 调用方未声明 net / handler 签名不符 | 编译期拒绝 | M3029 / M3002·M3005 |
| handler 非模块级命名函数 | 静态拒绝 + 运行期复查 | M4001(与 spawn 同款) |
| 请求 worker 启动失败(new Worker 抛错) | 先例:spawn_all 对启动失败的任务记 Err、不影响其余任务(src/interp.js:2001/2008) | 500,响应体 Json{code:'worker_start_failed', message};并发名额同步释放——降级/重试策略与名额语义 = 评审清单第 16 项 |
| handler panic | 请求级隔离:500 响应,其余请求不受影响(spawn_all 独立 Err 同款) | panic 码透传(M4002 等),响应体 Json{code, message}(join_detailed wire v2 同款) |
| handler 超时(建议 30s) | terminate 硬杀(与 join_detailed M4010 同款纪律);注意 handler 内 http_get 默认 35s 超时(src/interp.js:1460)> 30s——handler 内慢外呼必先撞 serve 层硬杀,http_get 自身超时在 handler 内不可达 | 504,响应体 Json{code:'M4010', message} |
| 请求体 > 8MB | handler 不执行 | 413,响应体 Json{code:'body_too_large', message} |
| 等待队列满 | 到达即拒(按到达序,确定) | 503,响应体 Json{code:'overloaded', message} |
| 响应体 > 8MB | 拒绝发送,连接关闭(不截断) | 500,响应体 Json{code:'response_too_large', message} |

非 2xx 响应体统一为 `Json{code, message}`:code 为透传 M 码(panic / 超时)或事件码字符串(`body_too_large` / `overloaded` / `response_too_large` / `worker_start_failed`——响应载荷,非诊断码,不进 M 码登记)。

**与结构化并发的交互(serve 里能 spawn 吗)**:v1 **编译期拒绝**(handler 效果白名单不含 sync)。机械层面嵌套 spawn 实测可行〔实测:worker 内 spawn 返回 42,exit 0〕,但 serve 场景下 `sync scope` 的"块退出自动 join"缺少自然的块边界(handler 由服务端调用,不是被外层作用域框住),放开需要先定义 scoped 语义在 handler 内的形态并实测深度-2 全管线——登记为评审清单第 11 项,不属于 v1。

**四后端行为边界**:tree / VM 真实执行(worker 基建双引擎已一致——测试 §15"spawn_all 双引擎一致"既有);wasm **资格自动拒绝**(net 效果函数永不进 eligible——机制现成,effectful 函数在 sig.effects 处拒绝,与 http_get 现状同构);C 后端**发射期显式拒绝**("C1 不支持该程序形态" exit 1,现成路径)。拒绝不是分歧:三处行为均已登记、可测(§66 会锁定)。

### 2.2 方案 b:解释器内 green-thread 调度

**架构草图**:单线程解释器内,每个连接绑定一个独立执行体(Interp 实例或可暂停帧链),调度器按 FIFO 事件队列交错步进——socket 数据到达 → 事件入队(到达序 = 确定序)→ 调度器恢复对应连接的执行体 → 步进至下一阻塞点(read/write/sleep)或预算耗尽。

**生命周期**:accept/read/write/close 全部在解释器内完成;"阻塞读"的实现 = 执行体暂停在该 read 上,宿主 socket 事件到达后由调度器恢复。效果检查点与方案 a 同源(net 签名 + handler 白名单),但**每个阻塞点同时是切换点**——效果与调度耦合。

**关键困难(诚实列出)**:

1. **(b) 包含 (c)**:green thread 的 IO 就绪仍需宿主事件循环唤醒——"阻塞读"不存在于 Node 的单线程 socket API(同步 socket API 不存在,busy-wait 违背资源哲学)。即方案 b 的底座就是方案 c 的事件循环桥,再加上一层确定性调度器。评分上 (b) 的实现成本不可能优于 (a),也不可能显著优于 (c)。
2. **确定性与公平性的真实代价**(精确表述:二者并非逻辑上不可兼得——固定抢占预算可以同时拿到公平与版本内"同输入同输出";真实代价在两处):(i) **跨版本稳定性**:抢占按指令计数,指令数因此成为可观测交错的一部分——为性能调预算 = 改变并发程序的可观测交错序,"同输入同输出"只对单一版本成立,每个版本都在悄悄变更并发可见行为(违反硬规则 1 的精神);(ii) **按指令计价的公平失真**:不同指令的真实成本差数量级(外呼/分配 vs 算术),指令数 ≠ 资源占用,按指令抢占对 IO 密集任务系统性偏苛,公平承诺名不副实。只用显式 yield 则退回另一极:一个 CPU 密集 handler 独占线程(慢速连接 DoS)。结论不变:(b) 要么接受无公平,要么接受这两个真实代价。
3. **解释器可重入/多实例**:tree 引擎是递归求值器,不可暂停(生成器化/CPS = 对 3.0k 行语义心脏的大手术);VM 全帧共享 valueStack(AGENTS.md §9 / GUIDE 修订记录已登记的已知陷阱),切换需保存/恢复整条帧链;wasm 分层状态、maxSteps/maxAlloc 配额按连接还是全局,全部需要新定义。
4. **共享堆 = 交错可观测**:同进程内所有连接共享解释器堆,调度序一有偏差即输出分歧——确定性负担落在运行时**每一行代码**上,而不是像方案 a 那样由"零共享"一次性保证。

**错误处理/背压/spawn 交互**:handler panic 需要定义"杀单线程内的一个 green thread"(帧链展开,穿过共享栈——高危);背压 = 调度器队列参数(同 (a) 可做);handler 内 spawn = green thread 嵌套 worker,概念上可行但配额/隔离语义全部未定义。

**四后端行为边界**:调度器是 JS 引擎专属机制;C/wasm 的拒绝面从"函数资格"扩大到"整个调度语义"——一致性证明面暴涨,这是与"差分是语义合同"的直接冲突。

### 2.3 方案 c:Node async 桥

**架构草图**:node:http 的连接/数据回调在**主线程**事件循环内直接重入调用 Ming handler(`callUser` 嵌套调用)——Ming 程序的主帧停在 serve builtin 的 await 上,回调到达时在同一解释器堆上执行 handler。

**生命周期**:accept/read/write 全部由宿主回调驱动;效果检查点与 (a) 同源——serve 的调用点即静态检查点,checker 可检查 handler 值效果 ⊆ 白名单(与 (a) 检查点 A 同款);真正的问题见下三个致命问题。

**三个致命问题**:

1. **确定性破产**:回调交错 + 同一解释器堆(连接间共享状态)→ 响应取决于回调到达顺序,不可复现。方案 a 用"零共享"使 OS 调度影响不了响应**内容**(收窄口径:跨连接完成顺序仍可观测,但不在语义合同内,§2.1);(c) 恰好把共享和交错同时最大化——共享堆使响应内容本身依赖交错,连"内容 = f(请求)"都无法主张。
2. **共享运行时状态**(原稿"handler 没有静态调用方、效果传播链断裂"的批评**不成立,予以更正**:v0.51 起函数值携带效果集合并参与 unify——GUIDE.md 修订记录 v0.51.0;serve(port, handler) 的调用点就是静态检查点,checker 可在调用点检查 handler 值的效果集 ⊆ 白名单,与方案 a 检查点 A、spawn 的 checkStdCall 泛型特例(src/checker.js:3628)同款)。(c) 的真实破绽在别处:handler 与主程序**共享同一运行时状态**——syncTasks / syncScopeStack / maxSteps 配额 / wasm 分层状态全在主线程解释器实例上(src/interp.js:1956-1958),响应内容依赖跨请求调度交错(谁先耗配额、scope 栈处于何深度),方案 a 的"每 worker 独立配额"(src/interp.js:1948-1950)在 (c) 下不存在;主线程重入也无法提供 spawn 管线的 print 捕获纪律(handler 的 io 输出直接打进程序 stdout,跨请求交错不可复现);跨 await 边界的效果检查与 panic 展开是效果系统从未定义过的形态。
3. **VM 重入高危**:CALL 指令的 builtin 内重入 callUser——全帧共享 valueStack、syncScopeStack、wasm 状态、Panic 展开穿越 await 边界,每一处都是核心运行时的高危改动(实现成本数字小、风险数字大)。

**错误处理/背压/spawn**:handler panic 在主线程展开 = 可能撕碎主帧(需要"服务器级 panic 屏障",未定义);背压靠 node:http 自带(不可控细节进 Ming 行为);handler 内 spawn = 主线程 syncSpawn,机械可行但与回调交错叠加后不可推理。

**四后端行为边界**:事件循环语义进入语言,四后端合同要新增"宿主事件循环仅存在于 JS 引擎"的例外;拒绝面模糊(C 后端要不要模拟事件循环?诚实答案是不,但拒绝理由从"形态不支持"退化成"整个方案不支持")。

**内存口径备注**(独立审查实测):worker 内存必须区分 **commit(PrivateMB)与 WorkingSet**——16 个存活 worker 实测 Private ≈ 1001MB / WorkingSet ≈ 407MB;§1.2 的 52–55MB 是 RSS(≈ 工作集)口径,容量规划(§4 第 1 条的 0.9GB / 5.5GB 推算、Windows 提交上限)应按 commit 口径复核。§2.4 原型对差值主因(每任务 32MB SAB 预留)给出了量化解释。

### 2.4 Node 原型实测:accept 线程 + 每请求 worker 隔离(新增面拿数据)

§2.1 架构中既有 sync 基建之外的全部新增面(accept 线程、请求 worker 分派、队列/上限/413/503/504)此前零数据。本节为 **Node 原型实测**(2026-11-13,Node v24.11.0 / win32-x64,脚本在系统临时目录、不入仓):node:http accept 线程(worker_threads 宿主 worker,`listen(port, '127.0.0.1')`)+ **每请求一个请求 worker**(嵌套 worker)+ FIFO 队列(256)/ 并发上限(16)/ 体上限 8MB / 逐请求超时;请求/响应走结构化克隆(JSON 深拷贝,与 wire 深拷贝同思路,简化实现)。handler 轮廓 `mingimport`:每请求 worker 顺序导入 checker/vm/interp 三模块(镜像 syncWorkerCode,即 v1 每请求固定成本主体;不含编译 Ming 模块本身的成本)。原型目的是拿数据验证参数量级,不是产线代码。

**吞吐与延迟**(各相全 200,socket 错误 0):

| 相 | 并发连接 × 请求数 | 吞吐(req/s) | p50 | p90 | p99 | max | 错误率 |
|----|----|----|----|----|----|----|----|
| 预热 | 4 × 10 | 92 | 42.6ms | 51.7 | 54.1 | 54.1 | 0% |
| A | 10 × 100(=1000) | **162** | 61.4ms | 65.9 | 71.2 | 73.9 | 0% |
| B | 16 × 100(=1600) | **181** | 85.2ms | 103.1 | 122.0 | 154.1 | 0% |
| C(超订阅 40 连接 > 16 上限,队列介入) | 40 × 25(=1000) | **190** | 207.6ms | 240.6 | 258.2 | 270.5 | 0% |

**错误路径冒烟**:413(POST 9MB)→ `413` + `body_too_large`〔原型实测〕;503(300 并发慢请求,容量 16+256=272)→ 恰好 **272 受理 / 28 拒 503**,队列峰值 256——容量算术逐字成立〔原型实测〕;504(超时 500ms,handler 3s)→ 8/8 全 504,terminate 后名额同步释放(第二批随即调度)〔原型实测〕;worker 启动失败未在原型触发(静态先例 spawn_all,src/interp.js:2001/2008)。

**内存**(B 相 16 worker 存活期间,整进程 PowerShell 采样 8 次):commit(Private)max **421MB** / avg 389MB;WorkingSet max **343MB** / avg 328MB〔原型实测〕。与 §2.3 审查实测(16 worker Private ≈ 1001MB / WS ≈ 407MB)的差值主因:本原型请求/响应走结构化克隆通道,**未含** spawn 管线每任务 32MB SAB 预留(src/interp.js:1935-1936)——16 × 32MB = 512MB commit 预留,恰好解释大部分差值。

**每请求成本分解**:worker 内三模块导入平均 **37.8ms**(3640 次采样,max 88.9ms),加 worker 启动/克隆/HTTP ≈ 23ms,合计 ≈ 61ms(与 §1.2 spawn 全管线 ~50ms 同量级)。

**对 §2.1 默认值的校准结论**:
1. **并发上限 16 = 吞吐饱和点**:10 → 16 并发吞吐只从 162 升到 181(+12%),16 → 40(超订阅)不再升(190)——继续加并发只抬延迟不抬吞吐(A/B/C p50 = 61/85/208ms)。**16 是合理默认**;吞吐上限 ~190 req/s 把 §4 第 2 条的"每秒数百请求级"精确定位到其下沿。
2. **队列 256 量级可接受**:饱和吞吐下 256 队列最坏排空 ≈ 1.4s(503 冒烟中排队 p50 ≈ 2.1s 与此一致);但排队缓冲上界 256 × 8MB = 2GB 偏大(§2.1 检查点 E 已登记),实现时可按部署配额化(清单 6)。
3. **超时 30s 与原型延迟相距 3 个量级**(p99 122ms),对"handler 内外呼"场景 30s 仍是对的目标(瓶颈在 handler 自身,不在分发层)。
4. **新风险(如实登记)**:serve 通道若照搬 spawn 的每任务 32MB SAB,commit 预留按并发线性放大(16 × 32MB = 512MB)——建议 serve 通道按需定容(请求/响应各以 8MB 体上限 + 头为界,而非 32MB 通用预留),实现时确认,清单 6 已并入此项。

---

## 3. 评分

| 维度 | (a) worker-per-connection | (b) green-thread | (c) Node async 桥 |
|------|:---:|:---:|:---:|
| ① 确定性 | **5** | 3 | 1 |
| ② 效果系统表达 | **5** | 3 | 2 |
| ③ 零依赖 | 5 | 5 | 5 |
| ④ 四后端一致性 | **4** | 2 | 2 |
| ⑤ 实现成本 | **4** | 1 | 2 |
| ⑥ 可回退性 | **5** | 2 | 2 |
| **合计(30)** | **28** | **16** | **14** |

**逐维论证**

- **① 确定性**:(a)=5——请求 worker 之间**零共享**(wire 深拷贝 + 隔离子 VM,值语义在任务边界已保证),handler 不声明 time/rand 时**每请求响应内容 = f(该请求)**;OS 调度影响不了内容,只能影响何时完成(跨连接完成顺序/延迟不在语义合同内,收窄口径见 §2.1)。佐证为既有机制:spawn_all 按输入序聚合结果(src/interp.js:2007-2026)、每 worker 独立配额(src/interp.js:1948-1950)。这一点是 Ming 既有语义免费赠送的:Go/Java 有共享内存所以调度序可观测,Ming 恰好没有。(b)=3——可行但昂贵:必须 FIFO 严格调度 + 抢占预算,预算把指令数变成可观测交错(跨版本稳定性代价,§2.2 死结 2),调度器任何偏差即语义 bug。(c)=1——共享堆 + 回调交错,响应内容本身依赖到达顺序,不可复现。
- **② 效果系统表达**:(a)=5——serve 以 net 效果声明(与 http_get 同表),handler 效果白名单编译期检查(调用点检查 handler 值效果 ⊆ 白名单),服务端成为**效果边界**(net 在 serve 进入、在响应退出),与"效果即泛化 unsafe 块"哲学同构。(b)=3——效果照常静态,但阻塞点=切换点把效果与调度耦合,效果函数在 green thread 中的配额/超时语义需全新定义。(c)=2——调用点静态检查同样可用(传播链并不断裂,§2.3),但 handler 与主程序共享运行时状态、io 无捕获纪律、跨 await 效果传播未定义,效果边界不再干净。
- **③ 零依赖**:三者同分——node:http / node:net / worker_threads 皆内建(先例:worker_threads 自 v0.14、node:crypto 自 v0.34)。(b) 的"纯 JS"没有额外优势,因为 (b) 的底座仍需 Node socket 事件。
- **④ 四后端一致性**:(a)=4——行为边界与现状完全同构:tree/VM 真实执行、wasm 资格自动拒绝、C 发射期显式拒绝;拒绝面三处已登记可测。扣 1 分是诚实代价:worker 内的执行只发生在 JS 侧,C 后端用户拿不到服务端能力(显式拒绝,不是伪装)。(b)=2、(c)=2——两者的机制都让"拒绝面"从函数资格扩大到整个运行时模型,一致性证明面暴涨。
- **⑤ 实现成本(以 sync/proc 基建为基准)**:(a)=4——**复用清单**:worker 管线(syncWorkerCode)、wire 序列化(Json/tuple 可跨)、SAB 传输协议(http 三入口同款)、Atomics 阻塞纪律、错误链 wire v2(join_detailed)、worker 启动/终止/上限(spawn_all)、独立进程回环测试模式(tests/net_e2e.mjs)。新增:accept 线程(node:http 封装 + 队列/上限 ≈ 250 行)+ serve builtin + checker 签名特例(参照 spawn 的 checkStdCall)+ §66 测试——**数百行量级,不触碰 interp/vm 语义心脏**。(b)=1——解释器可重入/多实例 + 全部阻塞点(read_line/http_get/exec/sleep)异步化 + 调度器 + wasm 交互:千行级,触碰语义心脏。(c)=2——数百行但全部落在 VM 重入高危区。
- **⑥ 可回退性**:(a)=5——独立 std.net 面(新签名 + 新 builtin + 新宿主线程),不改既有语义,整体回退 = 删增量;fuzz 生成器不含 net,不受影响。(b)/(c)=2——动 interp/vm 心脏,回退 = 大手术。

---

## 4. 诚实边界

1. **内存是硬上限**〔实测〕:55MB RSS/worker → 16 并发 ≈ 0.9GB、100 并发 ≈ 5.5GB(RSS ≈ 工作集口径;commit 口径的区分与量化见 §2.3 内存口径备注、§2.4)。方案 a 的语义上限是**数十级连接**(上限默认值建议 16,可配;§2.4 佐证 16 = 吞吐饱和点)。它与北星支柱 3 的"10 万级"差约三个数量级——**本 ADR 不承诺也不伪装接近它**。10 万级需要事件驱动的 async 运行时,而 async 与确定性的调和正是方案 b 的全部困难(§2.2),当前无解,维持远期;若 Ming 的真实场景(安全工具/agent 胶水/自举工具)永远不需要,"永不做"也是诚实答案——由后续 ADR 复核,不在此承诺。
2. **每请求 ~60ms 冷启动**〔实测:§1.2 spawn 全管线 ~50ms;§2.4 原型 p50 61ms@10 并发 / 85ms@16 并发,其中模块导入 ≈ 38ms〕:v1 无 AOT 快路径(注意口径:build 的 AOT 回退目前**只查 sync/unsafe**——bin/ming.js:1215-1232,net 不触发;实现 serve 时必须把 serve 所在程序并入同一条 sig.effects 回退检测,与 v0.43 修 spawn 的机制同款,否则重演"worker 读 '<artifact>' 源路径 → ENOENT";artifact 快路径 = 后续优化,不在 v1)。吞吐定位 ≈ **内网/工具/agent 服务**(§2.4 原型实测吞吐饱和 ≈ **190 req/s**:16 并发 181、40 并发超订阅仍 190——加并发只抬延迟不抬吞吐),不是生产 Web 服务。
3. **HTTP 解析委托 node:http**:解析细节(头合并、大小写、分块编码)是宿主语义,不在 Ming 合同内;Ming 唯一承诺的形态是请求 Json。
4. **单维护者的真实成本**:accept 线程是新的宿主并发面(线程间 SAB 协议 + 队列),§66 必须覆盖并发上限/队列溢出/handler panic/超时/双引擎一致/三引擎拒绝一致(草案见 §5.2 任务 4)。
5. **v1 明确不做**(逐项给出理由,不是"以后再说"):
   - **WebSocket**:协议升级是流式双向,与"worker = 请求→响应纯函数"模型冲突;且 v1 不做任何流式。
   - **流式请求/响应(chunked 透传)**:流式需要请求 worker 持有 socket 并多次进出(要么 handle 转移要么回调),打破"响应 = 纯函数"的确定性结构。
   - **keep-alive / pipelining 调优**:node:http 默认行为即够用;Ming 级连接复用控制 = 新语义面,无收益。
   - **HTTPS/TLS**:反代职责(caddy/nginx 终结 TLS,Ming 只听明文);v1 监听面固定 `127.0.0.1`(签名无 host 参数,§2.1)——正因为监听面锁定回环,明文 HTTP 才是可接受的默认;"内网明文"依赖放开 host 参数,与监听地址放开属同一后续 ADR。node:https 本身可行,但证书管理不是 Ming 的战场。
   - **UDP**:无连接语义与 worker-per-connection 不同构,单独设计。
   - **优雅停机(信号处理)**:Ctrl+C 杀进程即停机;信号语义进 Ming = 新效果面。
   - **访问日志**:跨连接 stderr 交错 = 不可复现输出,直接违反确定性纪律(宁缺);排障用 500/504 响应体 + 请求计数。
   - **handler 内 spawn(sync)/ unsafe / ffi**:白名单拒绝(§2.1);放开路径见评审清单第 11 项。
   - **Unix domain socket / HTTP/2 / 10 万级连接**:同上,各自需要独立 ADR。

---

## 5. 结论与条件承诺

### 5.1 结论

**选定方案 a(worker-per-connection 阻塞模型),条件承诺实施**。决定性论据有两条:

1. **确定性的免费午餐(口径收窄后)**:Ming 的值语义 + 隔离子 VM 使请求间零共享——handler 不声明 time/rand 时,每请求响应内容 = f(该请求),OS 线程调度影响不了内容,不需要任何调度器努力;跨连接完成顺序与延迟不在语义合同内(§2.1)。佐证为既有机制:spawn_all 按输入序聚合(src/interp.js:2007-2026)、每 worker 独立配额(src/interp.js:1948-1950)。方案 b/c 都要把确定性变成运行时每一行代码的持续负担。
2. **基建复用率接近 100%**:worker 管线、wire、SAB、Atomics 纪律、错误链、回环测试模式全部现成;新增面只有 accept 线程与 serve builtin,数百行量级,不触碰语义心脏,可整体回退。

方案 b/c 否决归档:(b) = (c) 的底座 + 确定性调度器,而抢占预算把指令数变成可观测交错、按指令计价公平失真(§2.2 死结 2);(c) 共享堆使响应内容依赖交错(确定性破产),叠加共享运行时状态与未定义的跨 await 效果语义(§2.3),且落在 VM 重入高危区。

**条件承诺**:以下评审清单 **16 项全勾**后,才按 §5.2 草案实施;任何一项不勾,本 ADR 保持"设计文档"状态,plan 记录"清单未全勾"的具体项与理由(§6 第 4 条)。

**评审清单**(可勾选,维护者逐一确认):

- [ ] **1. 方案采纳**:确认方案 a 为 v0.59 服务端唯一路径;(b)/(c) 按 §5.1 否决理由归档,不再复议(复议需新 ADR)。
- [ ] **2. 效果语义**:确认 serve 以 `net` 效果声明;handler 效果白名单 = `{io, time, fs, net, env, rand, crypto, proc}`;`sync` / `unsafe` / `ffi` 在 handler 内编译期拒绝(v1)。
- [ ] **3. handler 载荷形态**:确认请求/响应 = Json(`{method, path, headers, body}` / `{status, headers, body}`,键集固定、additive);若改用 tuple 形态需给出对等论证。
- [ ] **4. 诊断码**:确认 v1 **零新增 M 码**(绑定失败/端口非法 = Err 值;handler panic = 500 + 捕获码透传;超时 = 504 + M4010)。若改为新增码(M4017 起空闲,M4014 已预留),需按三处登记纪律执行。
- [ ] **5. serve 返回类型**:确认 `serve(port, handler) -> Result[i64, str]`——Err 为绑定/参数失败;**Ok 路径 v1 不可达**(无优雅停机),返回值为将来 shutdown API 预留。
- [ ] **6. 背压参数**:确认默认并发 worker 上限(建议 16,§2.4 佐证 = 吞吐饱和点)、FIFO 等待队列上限(建议 256;排队缓冲上界 256 × 8MB = 2GB)、超额响应(队列满 503);并确认 serve 请求/响应通道容量——若沿用 spawn 的每任务 32MB SAB 预留,16 并发即 512MB commit(§2.4 新风险 4),建议按需定容。
- [ ] **7. 体上限**:确认请求/响应体 8MB(与 http 客户端同款);请求超限 413、响应超限 500 并关闭(不截断)。
- [ ] **8. handler 超时**:确认缺省 30s(可配与否在实现时定)、terminate 硬杀、504 + M4010;注意与 http_get 默认 35s 超时(src/interp.js:1460)的交互——handler 内慢外呼必先撞 30s 硬杀(504),http_get 自身超时在 handler 内不可达。
- [ ] **9. io 纪律**:确认请求 worker 内 print 捕获丢弃(spawn 同款纪律),v1 无服务端访问日志(§4 第 5 条)。
- [ ] **10. 四后端边界**:确认 wasm 资格拒绝(net 效果自动拒绝)+ C 发射期显式拒绝("C1 不支持该程序形态" exit 1)+ tree/VM 真实执行;§66 锁定三引擎拒绝一致。
- [ ] **11. serve 内 spawn**:确认 v1 拒绝(handler 白名单无 sync);将来放开前需先实测深度-2 全管线并定义 scoped 在 handler 内的形态(§2.1)。
- [ ] **12. 性能预算**:确认 v1 定位 = "接受 ~60ms/请求冷启动〔实测:§1.2 全管线 ~50ms,§2.4 原型 p50 61ms@10 并发 / 85ms@16 并发〕、并发上限 16〔§2.4 原型实测 = 吞吐饱和点,饱和 ≈ 190 req/s〕、内存 55MB/worker(RSS 口径,§2.3 备注)"的内网/工具/agent 服务,不承诺生产吞吐,不承诺 10 万级连接(北星支柱 3 维持远期)。
- [ ] **13. 测试形态**:确认 §66 用独立进程回环测试(沿用 tests/net_e2e.mjs 模式),CI 仅 localhost;含并发/panic/超时/上限冒烟。
- [ ] **14. 文档面**:确认 GUIDE 新增 std.net 服务端节 + capabilities"TCP/UDP/服务端"行 ❌ → 🟡(worker-per-connection、数十级上限如实登记)+ design.md §6.3 补"分阶段"说明(阶段 1 = worker-per-connection,阶段 2 = async 运行时另 ADR)。
- [ ] **15. 监听地址**:确认 v1 `serve(port, handler)` 固定绑 `127.0.0.1`(签名无 host 参数 = 隐式回环,零配置默认安全;node:http 缺省绑全部接口,必须显式收窄);放开自定义 host/内网监听属后续 ADR(需显式 host 参数与文档警告)。
- [ ] **16. 请求 worker 启动失败处理**:确认降级策略(先例:spawn_all 对启动失败任务记 Err、不影响其余,src/interp.js:2001/2008;建议 500 + Json{code:'worker_start_failed'} 响应)、并发名额是否同步释放、是否计入请求计数。

### 5.2 v1 最小 HTTP server 任务草案(仅当上表全勾)

1. **checker**(~60 行,参照 spawn 的 checkStdCall 特例):serve 签名登记(net 效果)+ handler 白名单与形态检查 + 静态拒绝面(M3029/M3002/M3005);零新增码。
2. **interp**(~350 行):serve builtin(主线程 Atomics.wait 协调)+ accept 线程(node:http 封装,`listen(port, '127.0.0.1')` 固定回环 + FIFO 队列/上限/体上限/超时 + worker 启动失败降级,清单 16)+ 请求 worker(复用 syncWorkerCode,capture:true,print 捕获;**按请求分派**,连接只是传输)。
3. **载荷**:请求/响应 Json,键集固定、additive;错误响应体统一 Json{code, message}(413 / 503 / 500 / 504 全部,见 §2.1 错误表)。
4. **测试 §66 ≥12**:效果强制(M3029)/ handler 白名单拒绝(sync·unsafe·ffi 三向)/ handler 形态拒绝(闭包)/ 回环 GET·POST / panic → 500 / 超时 → 504 / 体超限 → 413 / 队列满 → 503 / 双引擎一致 / wasm 资格拒绝(构造说明:程序内放置一个**无 net 效果的纯函数**处于 wasm 候选位置,断言 `[wasm] fn <名> OK`;serve 所在入口函数因 net 效果永不进 eligible——无 REJECT 噪声,证明拒绝是资格层的静态事实而非运行失败)/ cc 发射期拒绝(exit 1)/ 16 并发冒烟。
5. **文档**:GUIDE std.net 服务端节(含生命周期与检查点表)· capabilities 行 ❌ → 🟡 · design.md §6.3 分阶段说明 · 修订记录。
6. **回退**:删增量即可(不改既有语义);fuzz 生成器不含 net,模糊器零影响;`ming build` 的 AOT 回退目前只查 sync/unsafe(bin/ming.js:1215-1232),net 不触发——实现时须把 serve 所在程序并入同一条 sig.effects 回退检测(与 v0.43 修 spawn 的机制同款,§4 第 2 条),避免重演"worker 读 '<artifact>' 源路径 → ENOENT"。

---

## 6. 对 plan.md 的建议改动清单(收口阶段统一执行;本 ADR 不直接改 plan.md)

1. **§4.3.6 任务 1**:标注 ✅(2026-11-13,ADR-001 交付;结论:方案 a 条件承诺,文档 docs/adr-001-concurrency.md)。
2. **§4.3.6 任务 2(原型实验)**:改写为"以实测替代原型"——spawn 全管线 ~50ms/worker、边际 ~6.5–7ms、纯 worker RSS 52–55MB、嵌套 spawn 机械可行、128 worker 全部成功(数据在 ADR §1.2);实现阶段不再另做原型。
3. **§4.3.6 任务 3(条件承诺)**:细化为"ADR-001 §5.1 评审清单 16 项全勾后才实现",并固化 v1 参数(并发 16 / 队列 256 / 体 8MB / 超时 30s → 504 / 绑定失败 Err 化 / 零新增 M 码 / 载荷 Json / 固定 127.0.0.1)。
4. **§4.3.6 验收行**:补"实现时 §66 ≥12 + 三引擎拒绝一致(三段式:① tree/VM 真实执行一致——双引擎差分逐字一致;② wasm 资格拒绝锁定——net 效果函数永不进 eligible,strict-wasm/调试旗标可观测,§5.2 任务 4 构造;③ cc 发射期拒绝锁定——exit 1;定义见 §2.1/§5.2)+ 评审清单全勾留档;不实现时 plan 记录'清单未全勾'的具体项与理由"。
5. **§4.3.6 风险/回退行**:补方案 b/c 否决理由归档(评分表见 ADR §3);并发上限风险已量化(内存 55MB/worker → 数十级)。
6. **§4.3.9 明确不做**:补"服务端不做 WebSocket / 流式 / keep-alive 调优 / TLS / UDP / 优雅停机 / 访问日志 / handler 内 sync·unsafe·ffi;10 万级连接维持北星远期(另 ADR 复核)"。
7. **§4.3.10 v0.59 行**:完成判定改为"ADR-001 完成(方案 a + 条件承诺);若实现:评审清单 16 项全勾 + §66 ≥12 + 三引擎拒绝一致(三段式,见 §6 第 4 条)";量化门槛同步。
8. **§0 状态表「下一步」行与 README 路线图**:随 v0.59 收口同步 ADR 交付事实(收口阶段统一)。

---

## 7. 一句话结论

**服务端进入 Ming 语言面的唯一可行路径是方案 a——worker-per-connection(按请求分派 worker,连接只是传输),复用 spawn/wire 基建,固定 127.0.0.1,靠"请求间零共享"守住"响应内容 = f(请求)"的确定性契约(完成顺序/延迟不在合同内),诚实服务"数十级并发"(原型实测吞吐饱和 ≈ 190 req/s,§2.4)而非北星的"10 万级";通过评审清单 16 项后按条件承诺实现,否则只保留本 ADR。**
