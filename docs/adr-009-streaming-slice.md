# ADR-009:流式·Slice 设计簇——read_bytes_range 最小流式 / Slice 只读视图 / 带长度 Ptr / unsafe(cond) 证明携带

> **状态**:**架构师裁决先行落盘(2026-11-19),维护者事后复核(ADR-004/005/006/007/008 同款模式)** · **日期**:2026-11-19 · **版本基线**:v0.85.0(HEAD e1be7e7,1441 项回归全绿)
> **立场声明**:本 ADR 关闭 plan §4.13.2「数据面」与 §4.12.2 簇 A 的立项缺口(流式/零拷贝/8MB 上限,capabilities:16/22/71;moltbook rossum 真实用例)。四件(范围读取/Slice/带长度 Ptr/unsafe(cond))是**同一设计簇**——单做任一件都是半成品:Slice 无证明携带 = 新 unsafe 逃逸口;证明无 Slice = 无对象可证;范围读取不依赖 Slice 但它是簇里唯一有独立价值的第一片。**一次设计到位,分阶段实现**(每阶段独立可回退)。
> **结论先行**:① **v0.86 第一片 = `read_bytes_range(path, start, len)` 最小流式**(安全面,污点纪律对齐 read_bytes——外部输入必污;单次 8MB 上限保留,总分段由用户循环;零依赖零新引擎机制);② **Slice 只读视图** v1 仅 `Slice[u8]`、**块内线性视图**(不可逃逸:不可 return/存容器/跨函数传参;仅可由**非 mut** Vec 创建——值语义世界无别名写面)、越界读 M4003 同口径、**证明义务同 Vec len 符号**;③ **带长度 Ptr 延迟**——其独特价值是 unsafe 写面与 C FFI buffer ABI,等 C ABI 用例(簇 D),v1 不做;④ **unsafe(cond) 证明携带延迟**——本 ADR 定义语法与语义草案、设实现门槛(证明器形式化评估 + Slice/带长度 Ptr 就位),**ADR-003"证明不消除运行时检查"的例外仅在本 ADR §6 门槛全部满足后生效**;⑤ v0.86 起实现,全 additive 无破坏窗口。
> **关联**:plan §4.13.2/§4.13.5/§4.13.6;moltbook:74/75/137(rossum 6.3MB 单帧可/30 帧缓冲不可);capabilities:16/22/71;ADR-003(证明不消除检查)/ADR-002(污点载体白名单);docs/adr-008-taint-v13.md(载体演化先例)。

---

## 1. 背景与登记窗口

v0.31 起二进制 I/O 只有全量读写(`fs.read_bytes` / `write_bytes`),**8MB 单文件上限 + 无流式/随机访问**如实登记为能力边界(capabilities:16)。moltbook(v0.31 帖)rossum 给出真实反例:**2048×1536×16bit 深度帧 = 6.3MB,单帧可读,30 帧捕获缓冲(189MB)不可**——"整文件读写无流式"从设计妥协变成机器人场景的硬限制。v0.84 快照与 plan §4.13.2 将其登记为簇 A(v0.83+ 候选),本轮以 ADR 裁决落地。

关键约束(来自既有体系,不重新发明):

- **值语义/深拷贝**(design §2):`let w = v` 深拷贝。**Slice 是值语义世界里的显式视图例外**——必须约束别名面,否则"无别名 bug"的承诺被洞穿。
- **污点纪律**(v0.61–v0.82):外部输入必污;`read_bytes → Untrusted[Vec[u8]]`(第三载体,v0.77)。范围读取同源同污,**不留净旁路**。
- **证明只报告不消除**(ADR-003):`proven` 不删运行时 M4003。unsafe(cond) 若成为例外,必须经本 ADR 的门槛评审。
- **四引擎合同**:tree/VM 一致为硬门槛;wasm 不资格形态具名回落(strict 可见);cc 拒绝面明确。
- **零依赖/确定性/零 npm**:Node `fs.readSync` 的 position 参数即可实现范围读,无需新机制。

## 2. 问题全景(crux 枚举)

### 2.1 read_bytes_range 最小流式——签名与污点面(第一片,立即实现)

`std.fs.read_bytes_range(path: str, start: i64, len: i64) -> Result[Untrusted[Vec[u8]], str]`(效果 `fs`;与 `read_bytes` 同型返回)。

- **污点**:外部内容源,返回 `Untrusted[Vec[u8]]`(第三载体,不引入新载体)。`std.unstr` 净化族不扩(用户按既有载体面消费:len/is_empty/投影到 debug 洗白需 sanitize——本片不新增净化器,登记不预支)。
- **边界语义**:`start < 0` 或 `len < 0` → `Err`(消息 `read_bytes_range: start/len 不能为负: <start>/<len>`);`len == 0` → `Ok(空 Vec)`;读越文件尾 → 截断到文件尾返回实际读取量(短读合法——流式语义);`start >= 文件大小` → `Err`(消息 `read_bytes_range: start 超出文件大小: <start> >= <size>`);文件不存在/IO 错 → `Err`(既有 ENOENT 口径)。**校验优先级(实现定案,v95.6/v95.14 锁定)**:负参 → 8MB → `len=0`(短路:不触盘、不校验 start/存在性——零字节读不构成存在性探针,错误面确定且平台无关)→ open → `start>=size`;**仅大小可 stat 的普通文件**(FIFO/procfs 的 size=0 → 定位读 Err,属合理边界)。
- **8MB 上限**:单次 `len > 8MB` → `Err`(消息 `read_bytes_range: 单次读取上限 8MB(len = <len>)`)——**上限保留在单次调用**;总量无限制(用户循环分段,这正是 30 帧缓冲的解法)。运行时实现用分段 `readSync` 循环(每段 ≤ 1MB)避免一次性大分配。
- **计费与 `--max-alloc`**:按**实际返回字节数**计费(与 read_bytes 的"外部输入边界计费"一致,v0.60 #52 口径);不重复计费派生值。
- **跨平台**:Node `fs.openSync/readSync(fd, buf, offset, length, position)`;Windows/Linux/macOS 同语义;文件句柄在 finally 关闭。
- **四引擎**:tree/VM 共享 builtin 实现;wasm 不资格(fs 效果函数不 eligible——既有口径,strict `none`);cc 对 fs builtin 现状拒绝(C1)——**本片不改 C 后端**(范围读在 cc 的资格面另裁)。

### 2.2 Slice 只读视图(第二片,设计定稿;实现门槛见 §6)

**形态**:`Slice[u8]`(v1 仅字节;`Slice[str]`/泛型 Slice 不做——登记另裁)。

- **构造**:唯一入口 = 非 mut `Vec[u8]` 绑定的 `v.view(start, len) -> Slice[u8]`(界检查运行时;越界 → M4003 同 Vec 口径:`索引越界:长度 <n>,访问 <i>` 变体 `视图越界:长度 <n>,start+len <s+l>`;start/len 为负 → M3005 类静态拒绝或 M4003,实现期定,三引擎逐字)。
- **值语义例外(核心裁决)**:Slice 是"底层存储的只读视图",**复制 Slice = 复制视图(地址+偏移+长度),非数据拷贝**——与深拷贝世界冲突,故施加三条硬约束(v1):
  1. **仅非 mut Vec 可创建视图**——值语义的 mut 写入只发生在 mut 绑定;非 mut 绑定在作用域内存储不可变 → 视图无别名写面(无"视图看到变值"的时序语义)。
  2. **块内线性(slice-escape 静态拒绝)**:Slice 不可 `return`、不可存入 Vec/Map/结构体/枚举载荷、不可作非 `Slice[u8]` 形参实参、不可赋给外层绑定——逃逸即拒(新诊断码候选 **M3051[slice-escape]**,号段登记三处,实现期落)。**理由**:无借用检查器的语言里,视图逃逸=悬垂风险(底层 Vec 先死);线性约束把生命周期钉在词法块内。
  3. **Slice 方法面白名单**:`len() -> i64`、`get(i) -> Option[u8]`、`at(i) -> u8`(越界 M4003 同口径)、`starts_with`/`ends_with`(u8 序列形态? v1 不做——最小面 len/get/at)。无 mut 方法(只读)。
- **零拷贝承诺的边界**:Slice 本身零拷贝;消费方 `v.view(...).at(i)` 逐字节读;转回 Vec 需显式 `to_vec()`(拷贝,登记可做但 v1 不做)。**诚实注记**:v1 Slice 的价值是"免整块拷贝地顺序处理大缓冲"(如逐帧扫描 6.3MB 帧头),不是通用 mmap——mmap 不做。
- **与污点面**:`Untrusted[Slice[u8]]` **不做**(载体白名单不扩——第五载体需另轮窗口);Slice 创建仅接受净 Vec;污 `Untrusted[Vec[u8]]` 需先按既有面消费或净化后才能接入视图(不预支净化器)。
- **证明面**:`Slice.len()` 在静态证明面复用 Vec 的 len 符号机制(源码位置义务 `0<=i<len`);**proven 仍不消除运行时检查**(ADR-003 维持;消除通道仅 unsafe(cond),见 §2.4)。

### 2.3 带长度 Ptr(第三片,设计定稿;实现延迟)

**形态**:`Ptr[u8]` + 显式长度**值对**(`(Ptr[u8], i64)` 元组),不新增类型;unsafe 面新增 `load_at(p, len, i)` / `store_at(p, len, i, v)`(界检查运行时报 M4003/越界 UB 不捕获的边界照旧,文档化)。

- 独特价值 = unsafe **写**面与 C FFI buffer ABI(簇 D:struct/array ABI 的 buffer 参数需要 ptr+len)。Slice 已覆盖安全只读面。
- **实现延迟条件**:C FFI ABI 真实用例出现(簇 D 用例驱动纪律)+ #55 NUL 策略前置义务解决(plan:682)。v1 不做。

### 2.4 unsafe(cond) 证明携带(第四片,语法草案 + 实现门槛)

**语法草案**:`unsafe(proven) { ... }`——块入口要求当前函数的证明义务集在该点**全部 proven**(静态证明器结论),不满足 → 编译错误(M3045 族扩展或新码,实现期定)。块内:

- 对**携带证明令牌的对象面(Slice/带长度 Ptr)**的访问**可**免运行时界检查(证明器结论作为令牌)——这是 ADR-003 的**唯一例外**,且仅当 §6 全部门槛满足+维护者复核通过后生效。
- 块内仍禁止逃逸/悬垂形态(线性不变);无令牌对象(普通 Vec/Ptr)照旧运行时检查(checker 静态验证"免检面 ⊆ proven 对象")。

**实现门槛(全部满足才开工)**:
1. 静态证明器对 Slice 形态的覆盖率评估(证明器形式化投入产出——ADR-003 §5 遗留议题);
2. Slice(§2.2)与带长度 Ptr(§2.3)实现就位;
3. 独立评审:证明器结论不可被反例击穿(proof_fuzz 扩展模式);
4. 维护者复核。**本 ADR 只定义,不实现。**

### 2.5 与既有体系交互矩阵

| 面 | read_bytes_range | Slice | 带长度 Ptr | unsafe(cond) |
|----|------------------|-------|-----------|--------------|
| 效果 | fs(既有) | 纯 | unsafe(既有) | unsafe + 证明 |
| 污点 | Untrusted[Vec[u8]](既有载体) | 净 only(载体不扩) | unsafe 面(污点面外) | 同左 |
| 值语义 | 深拷贝(返回值) | **视图例外**(三条硬约束) | 复制地址(既有先例) | 复制地址 |
| 证明 | 无 | len 符号复用 | 显式 len 参数 | 令牌=proven 义务 |
| wasm | strict none(eligible=0,非回落) | v1 不资格(具名) | 不资格 | 不资格 |
| cc | 现状拒绝(C1) | v2 评估 | 目标面(延迟) | 延迟 |
| 破坏性 | 无(additive) | 无(新类型) | 无 | 无 |

### 2.6 窗口政策

`read_bytes_range` additive;**Slice 是新类型面**(不改变既有语义);unsafe(cond) 的"免检"是显式声明例外(ADR-003 纪律)——**全簇无破坏性迁移面**,逐片交付、逐片可回退。

## 3. 评审清单(12 项——架构师默认立场,维护者逐项复核)

| # | 决策点 | 默认立场 | 理由/先例 |
|---|--------|---------|-----------|
| 1 | read_bytes_range 签名 | `Result[Untrusted[Vec[u8]], str]`,效果 fs | 同源同污纪律(v0.77);不留净旁路 |
| 2 | 单次上限 | **8MB/次保留,total 无限制**(用户循环) | 内存/计费模型不变;30 帧缓冲 = 循环分段 |
| 3 | 边界语义 | 负参 Err/短读截断合法/start≥size Err/len=0 Ok(空) | 流式语义标准形态;Err 不 panic(读写既有口径) |
| 4 | Slice 载体 | **v1 仅 `Slice[u8]`**;Slice[str]/泛型另裁 | 最小面;避免第二次设计 |
| 5 | Slice 值语义 | **视图例外 + 三硬约束**(非 mut 源/块内线性/白名单方法) | 值语义承诺不被洞穿;无借用检查器的唯一诚实解 |
| 6 | slice-escape 诊断 | **新码候选 M3051**(实现期三处登记);不改既有码 | 诊断码稳定纪律 |
| 7 | Slice 越界 | M4003 同族消息(视图变体),三引擎逐字 | 复用既有码与消息纪律 |
| 8 | 带长度 Ptr | **延迟**(C ABI 用例 + #55 NUL 前置) | 簇 D 用例驱动;Slice 已覆盖安全只读 |
| 9 | unsafe(cond) | **延迟**;本 ADR 语法草案 + 四门槛 | ADR-003 例外需独立 ADR + 评审;不预支 |
| 10 | 污点面 | 载体白名单**不扩**(无 Untrusted[Slice]);净化器族不扩 | v0.68/v0.77 纪律;第五载体需另轮窗口 |
| 11 | 引擎面 | tree/VM 实现;wasm 具名不资格;cc 延迟 | 四引擎合同逐片核验 |
| 12 | 规模预估 | v0.86 read_bytes_range ~80–120 行 + §95 8–10 条;Slice 片 ~300–500 行 + §96 15+ 条 | 规划口径非承诺 |

## 4. 分阶段实现路线(每片独立可回退)

| 阶段 | 内容 | 门槛 | 版本 |
|------|------|------|------|
| S1 | **read_bytes_range**(checker 签名/interp 实现/计费/§95 测试/GUIDE) | 本 ADR 落盘 + 维护者复核位(事后) | v0.86 |
| S2 | **Slice[u8]**(解析/checker 线性约束/M3051/interp 视图对象/§96) | S1 交付 + ADR 复核确认 | v0.87+ |
| S3 | 带长度 Ptr + C FFI buffer ABI | 簇 D 真实用例 + #55 NUL 策略 | 条件驱动 |
| S4 | unsafe(cond) | §2.4 四门槛 | 远期 |

## 5. 验收草案(S1)

- §95(8–10 条):单段黄金逐字节(跨 2 段与跨段边界读取)、短读截断、负参 Err、start≥size Err、len=0 空、>8MB Err、ENOENT Err、计费(`--max-alloc` 按返回长度)、污点流(Untrusted[Vec[u8]] 承载面 len/is_empty + sink M3049)、三腿一致。
- 大文件分段处理演示:examples/fs_demo.ming 扩展 1 段(6.3MB 帧头扫描形态,生成临时文件实测)。
- 全量回归绿;fuzz 双种子 0 分歧;proof_fuzz 0 误报;独立审查 + 修正。
- 文档:GUIDE std.fs 节(read_bytes_range 语义/上限/短读/Err 面)+ capabilities 二进制 I/O 行更新(流式第一片解锁,Slice/Reader 仍未见)+ plan 回填。

## 6. 明确不做(本 ADR 范围之外,维持登记)

- mmap / 内存映射;可执行内存(ADR-006 边界)。
- 回调式流式 Reader/Writer API(Reader 抽象需 trait 对象/闭包生命周期设计,另 ADR)。
- `Slice[str]`/泛型 Slice/可写 Slice(切分写面);`Untrusted[Slice]`(第五载体)。
- 带长度 Ptr 的 v1 实现与 C FFI buffer ABI(簇 D 条件)。
- unsafe(cond) 实现(四门槛未满足前不做)。
- 网络流式(chunked)/HTTP 客户端取消(capabilities:22,另裁)。
- 现有 `read_bytes`/`write_bytes` 的 8MB 上限调整(维持)。

## 7. 维护者复核位

清单 12 项逐项勾选 + 分阶段路线确认(S1 立即开工;S2 待 S1 交付后确认;S3/S4 维持门槛)。复核通过即按 S1 进入实现流水线(2 subagent → 独立审查 → 门禁 → 提交,既有惯例);事后复核模式下 S1 先行(架构师默认立场,复核否决则仅回退 S1)。
