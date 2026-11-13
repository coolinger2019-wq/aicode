# ADR-002:污点即效果(untrusted)——裁决:数据级类型标注,否决效果建模

> **状态**:评审中(2026-11-13,plan §4.3.7 任务 1 交付)· **日期**:2026-11-13 · **版本基线**:v0.58.0(825 项回归全绿)
> **立场声明**:本 ADR 只交付设计裁决,**不写任何语言实现代码**。文中全部数字为仓库现状实测(标注"实测",附复现命令,环境 Node v24 / win32-x64 / 2026-11-13)或源码确认(标注文件:行号);无一处来自想象。
> **结论先行**:污点做——但**不是** `untrusted` 效果,而是**类型级污点标注 `Untrusted[T]`**(编译期标签,运行时擦除)。"污点即效果"在建模层面被否决:效果是函数级事实("这个函数会做什么"),污点是数据级事实("这份数据从哪来"),粒度错位导致净化不可表达、契约不可用、资格面全灭(§2.1)。
> **关联**:docs/adr-001-concurrency.md(同系列)、docs/adr-003-mask.md(mask 已另行裁决:不做)、docs/plan.md §4.3.7(任务书)与 §4.2.8 Backlog("污点即效应,保留 v0.57+;在 mask 之后")、docs/design.md §2.13(效果系统)、§2.16(三期门禁)、§6(北星)。

> **2026-11-13 三方评估修订(重要)**:本文的 9 源全量标注方案**不是 v1**。v1 定为**窄源**(仅 `env.get`、`read_line` + extern 返回强制;fs/net/proc 内容源为 v1 泄漏窗口),因为 9 源全量会让 `mingkit`/`json_query`/`diaghot`/`log_analyzer`/`edit` 五个自写工具直接 M3002(实测)。同时修正:诊断码由 M3048/M3049 改为 **M3049/M3050**(M3048 已被 v0.59 泛型本地函数占用);分节号由 §64 改为 **§65**。五处补丁(窄源边界/`debug` 洗白禁面/白名单表/净化器授权位/码号)的评审是 v0.61 启动门槛,见 plan §4.4.4 任务 6、§4.4.5、§4.4.10。以下正文保留 2026-11-13 初稿的完整分析(9 源全量属于 v1.1 目标),与窄源 v1 的差异以本注、§1.2 修订注与 §3.1 修订块为准。

---

## 1. 背景与威胁模型

### 1.1 为什么 Ming 需要污点

Ming 的定位是 **AI 协作语言**(design §1)与**安全工具语言**(§6 北星)。AI 生成代码的最高频安全缺陷不是写错算法,而是**忘了校验输入**:环境变量、网络响应、文件内容、外部进程输出被直接拼进命令、路径、请求体或 FFI 调用。这类缺陷的特点是:

- **每个局部都"看起来对"**——类型正确、运行不崩、测试里喂良性数据也过;
- **只有全局数据流才能发现**——"这个 str 的源头是 `env.get`,一路没净化,到了 `fs.write_file` 的路径参数"。

现有机制(效果系统 + 契约 + 证明)全部是**函数级**事实:效果回答"这个函数会做什么",契约回答"这个函数对输入的假设是什么",证明回答"索引是否在界内"。没有一个机制回答"**这份数据可信吗**"。污点标注把这个维度变成编译期事实,让"AI 忘了校验输入"从静默漏洞变成 `M3xxx` 编译错误——与 M3029 让"忘了声明副作用"变成编译错误同一性质。

### 1.2 攻击面:来源与 sink(实测签名,GUIDE §18)

**来源**(std 中产生不可信值的函数,全部带效果;污点只标值载体,效果与污点是两个维度):

| 来源 | 签名 | 载体 |
|------|------|------|
| `std.env.get` | `(str) -> Option[str]` | 环境变量值 |
| `std.io.read_line` | `() -> str` | stdin 整行 |
| `std.io.read_to_end` | `() -> str` | stdin 全量 |
| `std.fs.read_file` | `(str) -> Result[str, str]` | 文件内容 |
| `std.fs.read_bytes` | `(str) -> Result[Vec[u8], str]` | 文件字节 |
| `std.net.http_get` | `(str) -> Result[(i64, str), str]` | 响应体(状态码除外) |
| `std.net.http_request` / `_opts` | `... -> Result[(i64, ...str...), str]` | 响应体/响应头值 |
| `std.proc.exec` | `(str, Vec[str]) -> Result[(exit, stdout, stderr), str]` | stdout/stderr(exit 是 i64,无污点意义) |
| `extern "库" fn ...` | C 世界返回值(v0.42 起数值/str/Ptr) | 全部返回值 |

来源计数口径(完整攻击面):std 来源函数共 **9 个**(上表 `http_request`/`_opts` 折为一行但计两个;`extern` 行是检查器强制规则,不计入签名变更数,见 §3.1)。**v1 只标其中 3 个**(`env.get`/`read_line`/extern;见下注)。签名经 `src/checker.js` STD_MODULES 与 GUIDE §18 双向核对(2026-11-13;初稿 `read_to_end` 误作 `Vec[u8]`,实为 `str`,已更正)。

> **v1 范围修订(2026-11-13 三方评估)**:上表是**完整攻击面清单**,但 v1 只标其中三个来源——`std.env.get`、`std.io.read_line`、extern 返回(检查器强制)。`read_to_end`/`read_file`/`read_bytes`/`http_*` 响应体/`proc.exec` stdout/stderr 在 v1 **明确不标**,是 v1 泄漏窗口(理由:9 源全量会让 5 个自写工具直接 M3002;v1.1 需先设计 `Untrusted[u8]`/`Untrusted[Json]` 载体与净化器授权矩阵)。详见 §3.1 与 §6.2 ②。

**sink**(不可信值流入即成漏洞的位置,按实参位):

| sink | 敏感实参 | 攻击类别 |
|------|----------|----------|
| `std.fs.write_file` / `append_file` | path(实参 0)、content(实参 1) | 路径穿越 / 配置投毒 |
| `std.fs.write_bytes` / `append_bytes` | path、Vec[u8] | 同上 |
| `std.fs.make_dir` / `remove_file` / `remove_dir_recursive` | path | 路径穿越 |
| `std.proc.exec` | cmd、args | 命令注入(proc.exec 经 spawn 无 shell 解释,风险低于 shell 拼接,但路径注入为真) |
| `std.net.http_request` / `_opts` | url、headers、body | SSRF / 头注入 / 体投毒 |
| `extern fn` 调用 | 全部实参 | FFI 注入(C 侧无类型安全) |

**不进 v1 sink 面**(如实列出):`print`/`eprint`/`std.log`(日志注入低危且调试场景高频,见 §6.2 误报面①的取舍)、panic 消息(诊断输出,见 §4.4)。**补一句(2026-11-13 三方评估,补丁 b)**:`debug`/插值/`as` 属**禁面**(与 sink 同级,见 §3.2 白名单补丁条)——sink 是"值可流入但需净化",禁面是"通道根本不出现";Untrusted 走这三条通道一律静态拒绝,调试需求经白名单方法满足。

### 1.3 现状:零拦截(实测)

今天,来源到 sink 的全链路没有任何检查:

```ming
use std.env;
use std.fs;
fn main() with fs, env {
    // 环境变量直接当路径写盘——污点面零拦截:类型正确、效果齐备,check exit 0
    std.fs.write_file(std.env.get("USER_PROFILE").unwrap_or(""), "data");
}
```

**(实测 2026-11-13,复现:将上述程序存为 t.ming 后 `node bin/ming.js check t.ming`)**:效果声明齐备(`with fs, env`)时 `ming check` **exit 0**——来源到 sink 全链路零拦截;`read_line() -> write_file` 同款流(声明 `with io, fs`)亦 exit 0。对照:漏声明 env 时同一程序 check 即 `M3029[undeclared-effect]` exit 1——效果系统的检查终点是"调用链上每个带效果函数都声明齐备",从不追问"值从哪来到哪去"。

---

## 2. 建模候选与取舍(核心裁决)

plan §4.3.7 给出二选一:"`untrusted` 效果或 std 类型标注"。本节把候选扩为三个,逐一裁决。

### 2.1 候选 A:untrusted 效果(否决)

把 `untrusted` 加入 `KNOWN_EFFECTS`(src/checker.js:196,当前 11 个效果),污点以"效果"通道传播与检查。**否决**,理由四条,每条都有实测机制支撑:

1. **机制错位**。效果系统的检查是"调用带效果的函数,调用方必须声明超集"(checker `checkEffects`,src/checker.js:1354——**实测**:纯函数里调 `with env` 函数 → M3029)。它追问"你调了谁",从不追问"什么值流向哪"(§1.3 旗舰实测正是两副面孔:漏声明 env → M3029 exit 1;补齐 `with fs, env` → exit 0,值流向全程无人追问)。污点的核心恰是后者。要让效果系统表达污点,检查器必须新增"表达式污点传播 + sink 点校验"的独立遍——效果机制本身帮不上任何忙。等于借 `with` 的语法壳,做数据流的芯;`with untrusted` 在 M3029 的既有语义(缺声明报错)下陈述的还是"函数处理了污点",不是"这个参数/返回值是脏的"。
2. **净化不可表达**。净化函数的本质是"输入脏 → 输出净"——这是**参数与返回值之间**的污点差异。函数级效果集是对称集合:要么整个函数 `with untrusted`(输出仍被视为污点面),要么不声明(输入不合法)。要表达方向性就得把效果集从对称集合改成有向标注,`M3029` 的语义随之分裂为两种不同谓词——不再是"效果"而是另一套系统穿着效果的戏服。同因击沉方向反转的变体:把"标脏"换成"`trusted` 效果"(默认全污、净化函数打 trusted 标)也逃不掉——净化函数必带 trusted 效果,理由 ③ 的契约 M3029 原样复现,契约永远无法断言"实参已净化";评审时不必重提该变体。
3. **契约被切断**(实测)。契约表达式必须纯:contractMode 以空效果集检查 requires/ensures(src/checker.js:1259/1267)。**实测**:`requires s.len() > 0 && env_ok()`(env_ok 带 env 效果)→ `M3029[undeclared-effect]: 此调用需要效果 [env],但函数 "validated" 声明的是 [纯函数]`。效果建模下净化函数必然带 `untrusted` 效果 → **契约永远无法断言"实参已净化"**——恰好丢掉污点系统最有价值的静态断言。
4. **资格面全灭**(实测)。wasm/C 资格的效果门禁只放行 `ffi`/`unsafe`(各有 C 专用旗标;src/wasm.js:395-400)。任何带 `untrusted` 效果的函数自动不进 wasm/C eligible——污点面代码永远回落 JS VM。类型方案(运行时擦除)无此税(§4.3)。

一句话:**"污点即效果"名义上是效果,实现上必然是披着效果语法的数据流系统**,既稀释了"效果 = 函数做什么的静态陈述"的语义合同(design §2.13),又拿不到数据流方案的表达力。

### 2.2 候选 B:类型级污点标注 `Untrusted[T]`(推荐,采纳)

新增类型构造器 `Untrusted[T]`(暂定名,候选见 §9 清单 2):"未经校验的 T 载荷"。语义要点:

- **编译期标签,运行时擦除**:值表示与 `T` 完全相同(interp `deepCopy` 按 `t` 结构递归,src/interp.js:67,污点不进值表示),检查器在类型层区分。与效果系统"零运行时开销"同一立场(design §2.13)。
- **`unify` 精确匹配,无隐式转换**:`Untrusted[str]` 不是 `str`——`Ming 没有任何隐式转换` 的铁律直接生效。这一条**免费得到 sink 门禁**:任何期待 `str` 的位置(参数、方法接收者、插值、Map 键)对 `Untrusted[str]` 一律 M3002/M3008 拒绝。**不需要 sink 标注表——"未显式接受 Untrusted 的位置全是 sink"**,默认拒绝、显式放行,与"安全是默认"(design §1 原则 2)同构。
- **先例**:Ming 已有一个"禁面类型"——`Ptr[u8]`(v0.54):仅 u8、四方法、算术/相等/插值/打印/JSON/Map 键/as 全静态拒绝(design §6.10)。`Untrusted[T]` 走同款最小面,工程模式已被验证。

### 2.3 候选 C:检查器私有数据流标注(否决)

绑定级污点状态(Flow/DFA 风格):类型不变,检查器内部对流敏感地追踪每个绑定的污点性,签名不携带污点事实。**否决**:签名不携带 = 跨函数传播靠推断或注释约定,违背"显式优于简洁"(design §1);`ming fmt`/doc/LSP/契约/证明全部要感知一份**签名里看不见的**状态——这正是 ADR-003 否决 mask 的同款理由("签名看不见的效果/事实不可接受")。流敏感分析的实现与测试锁定面也远超 v1 合理规模。

### 2.4 裁决

**采纳候选 B**。决定性论据排序:净化可表达(§2.1 之 2 的反面)与契约可用 > sink 门禁免费(无新检查机制) > 四后端运行时零改动(§4.3;检查期改动面见该节与清单 14) > 值语义/深拷贝零交互成本(§3.2) > Ptr 先例可循。候选 A 的唯一优势(签名表改动小)不足抵偿。

---

## 3. 类型方案设计草案

### 3.1 来源标注:改 std 签名(升 minor,破坏性)

> **v1 窄源修订(2026-11-13 三方评估)**:v1 **只标以下来源**,不标 fs/net/proc 内容源。

```ming
// v1 窄源(2026-11-13 定案)
std.env.get(k: str) -> Option[Untrusted[str]]
std.io.read_line() -> Untrusted[str]
extern "c" fn f(...) -> str        // 检查器强制按 -> Untrusted[str] 处理(签名禁写裸 str 返回)

// v1 不标(如实登记的泄漏窗口;v1.1 需载体设计后再扩,不得静默扩载体):
//   std.io.read_to_end / std.fs.read_file / std.fs.read_bytes
//   std.net.http_get / http_request / http_request_opts 的响应体与响应头值
//   std.proc.exec 的 stdout / stderr
```

**为什么窄源**:9 源全量会让 `mingkit`(read_file→split/print)、`json_query`(read_file→json.parse)、`diaghot`(proc.exec stdout→json.parse)、`log_analyzer`(read_file→split)、`edit`(read_file→split)五个自写工具直接 M3002——v1 不可迁移,不是最小可行。窄源换来迁移可行性,代价是 fs/net/proc 的漏报窗口(§6.2 ②),如实写入 GUIDE 与来源白名单测试。

这是破坏性变更。v0.x 阶段升 minor 即可(design §5);调用处迁移是机械的(加 sanitize 或改声明 Untrusted 形参)。**v1 迁移口径**:2 个 std 签名(`env.get`/`read_line`)+ extern 强制,估计 12–20 处调用点;`read_bytes` 的 `Vec[u8]` 载荷与 fs/net/proc 内容源 v1 均不标(漏报窗口见 §6.2 ②)。**不做**"新旧入口并存"——两种写法违反"一种结构一个语法"(design §1 原则 5),警告方案(W3xxx "此处返回未标注污点")会制造持续噪音。

**extern 返回值自动标污**(防漏标):`extern "c" fn f(...) -> str` 一律按 `-> Untrusted[str]` 检查(检查器强制,extern 签名不允许写裸 str 返回)——C 世界的返回值没有可信的,让漏标成为语法错误而非纪律问题。

**来源清单用测试锁定**:新增来源函数忘标 = 漏报窗口。检查器维护来源函数白名单表,回归测试断言表内容(与诊断码三处登记同款纪律)。

### 3.2 传播规则(值语义下污点如何随值流动)

- **深拷贝保污点(免费)**:赋值/传参/返回/集合存入全部深拷贝(design §2.3),但类型不因拷贝改变——`let a = u;`(u: Untrusted[str])的 a 仍是 Untrusted[str]。运行时无污点位,拷贝无需任何改动。"拷贝是否保污点"(plan §4.3.7 风险项)的答案是:类型方案下拷贝保污点是类型系统的恒等式,不是需要实现的规则。
- **容器/struct/Option/Result 载荷传播(免费)**:`Vec[Untrusted[str]]`、`Map[str, Untrusted[str]]`、`Some(u)`、struct 字段声明为 `Untrusted[str]`——泛型载荷类型精确传播(unify 既有行为);反之把 Untrusted 值装进 `Vec[str]`/`str` 字段 → M3002 拒绝,无旁路。
- **拼接/插值:v1 拒绝**。`"a" + u` → M3008(操作数类型不匹配);`"\{u}"` → 拒绝(插值只接受原始类型,design §2.10,Untrusted 不在其列)。Ming 无运算符重载(design §2.12),污点拼接本来就无法走 `+`;v1 不提供 `concat` 类显式拼接——**脏串要么净化要么透传,不提供"拼脏串"的表达力**。若评审认为透传场景需要拼接,加 `std.unstr.concat(Untrusted[str], Untrusted[str]) -> Untrusted[str]`(污进污出,签名即传播规则)——列入 §9 清单 7 裁决,v1 默认不加。
- **跨函数传播:污点不自动跨函数,必须显式声明**。未声明 `Untrusted` 形参的函数对脏值是 M3002 拒绝(= 默认 sink 门禁);要处理脏数据必须写 `fn parse_port(u: Untrusted[str]) -> Option[i64]`。这正是威胁模型要的行为:**AI 忘了校验 = 编译错误**;处理脏数据的函数在签名里自报家门。
- **`Untrusted[T]` 的操作面:白名单**(checker 内置表,可审计)。零操作类型连 `char_len` 都不可调,处理脏数据的函数体将写不出任何东西——所以给最小只读白名单,**只产出非污点载体或同污点载体的方法**:
  - 产出纯值(污点在此终结,数值不是污点载体):`parse_i64() -> Option[i64]`、`parse_f64() -> Option[f64]`、`char_len() -> i64`、`byte_len() -> i64`、`is_empty() -> bool`;
  - 产出同污点载体:v1 不设(含 `get(i) -> Option[char]`——char 可重组为 str,char 不作为污点载体建模会开重组旁路;如实列为 v1.1 候选)。
  - 其余 str 方法(trim/slice/replace/…)全部 M3015 拒绝,hint 指向 sanitize。
  - **运行时分发**:Untrusted 值运行时就是载体值(擦除),方法调用按载体类型的既有实现走,interp 无需新增方法;白名单校验只在 checker。
  - **调试通道即洗白通道,v1 静态拒绝(2026-11-13 三方评估补丁 b)**:`debug(any) -> str`、字符串插值(`"\{u}"`)与 `as` 转换是类型层洗白的三个旁路,对 Untrusted 一律静态拒绝(与 Ptr 同款:`M3002` + 专用码 `M3050`,`M3019` 通道同样关闭,hint 指向净化)。调试需求经白名单方法(`parse_i64`/`parse_f64`/`char_len`/`byte_len`/`is_empty`)满足——它们产出可打印的纯值,污点在数值/长度上终结。
  - **白名单边界:仅限载体方法(2026-11-13 三方评估补丁 c)**:白名单只约束"Untrusted **值**能调用什么方法";`std.unstr.*`(`mark`/`sanitize_path`)是**模块自由函数**,不进白名单表——净化是唯一类型跃迁出口,可信根单点(§3.4)。方法白名单与净化函数族是两个维度,不得混表。
- **构造面**:`Untrusted` 无字面量(不能凭空造脏,也不允许"默认干净")。显式入口 `std.unstr.mark(s: str) -> Untrusted[str]`(把干净值标脏;标脏只会更严,公开无危害)——测试块与"已知干净的特定场景"需要它。

### 3.3 sink:免费门禁 + 文档表

机制上 sink 门禁免费(§2.2):`write_file(path: str, ...)` 对 Untrusted 实参 M3002。需要的不是语法,是**可审计的 sink 清单文档**(本 ADR §1.2 即初版)+ 来源清单测试同款的白名单测试,防"新增 sink 函数没被意识到"。**extern 实参**同理免费:extern 签名的 `str` 形参拒绝 Untrusted 实参(unify 精确匹配)——FFI 注入面在类型层闭合。

### 3.4 净化与审计根

净化 = `std.unstr` 模块的显式函数族,**设计为纯函数(无效果)**——这是整个方案的关键决定,直接决定契约可用性(§4.2)。v1 起 **`sanitize_path`** 单函数示范:

```ming
// std.unstr.sanitize_path(u: Untrusted[str]) -> Result[str, str]
// 语义:拒绝绝对路径、.. 段、空段等非法形态,Ok 为规范化相对路径;非法路径 → Err(消息说明原因)
```

**失败语义(定稿)**:非法路径 → `Err[str]`(错误消息说明原因,与 `read_file` 的 `Result[str, str]` 同风格);净化成功的唯一产出是 `Ok(规范化相对路径)`。返回 `Result` 而非裸 `str` 是刻意选择:净化失败必须被调用方显式处理(`?`/match),不允许"静默吞掉用空串"——若返回裸 `str`,失败只能 panic 或返回魔法值,两者都比 `Err` 差。初稿注释"不合法 → Err 经 Option/Result 表达"与正文按裸 `str` 使用自相矛盾,已按本节统一(独立审查 2026-11-13 指出)。

**净化逻辑谁审计**——三重答案:

1. **单点性**:v1 只此一个净化入口(族按需扩展),可信根集中;实现与 std 其他函数同审计面(code review + 回归锁定)。净化正确性**无法**被 Ming 静态证明(串谓词在 QF_LIA 线性子集之外),如实承认:审计靠测试向量集(黄金用例锁定已知攻击向量),不靠证明器。
2. **用户自定义净化 v1 拒绝**:一旦 `fn my_sanitize(s: Untrusted[str]) -> Result[str, str]` 自由定义,污点可信根从"std 单点实现"退化为"每个用户的正确性",且语言无法审计——污点系统整体失效。这是诚实的限制,不是缺陷(design §2.8 同款表述)。
3. **净化 = 类型跃迁的唯一出口**:`Untrusted[str] -> Result[str, str]`(Ok 载荷为净 `str`)在整个语言里只有 `std.unstr.*` 函数族;无 `as` 旁路(M3019 通道,同 Ptr),无隐式转换。

**净化器授权位(2026-11-13 三方评估补丁 d,只授权实参位)**:`sanitize_path` 只授权**路径实参位**——`write_file`/`append_file`/`make_dir`/`remove_file`/`remove_dir_recursive`/`metadata`/`copy_file`/`rename` 的 `path` 形参;**不授权** content 位(`write_file`/`append_file` 第 2 参)、URL 位(`http_request`/`_opts` 的 url/headers/body)、`proc.exec` 的 cmd/args 位、extern 实参位。净化器不是万能"洗白器"——每扩一个授权位 = 一次可信根扩权(与 §9 清单 5 的族扩展纪律同源)。

**绝对路径/CLI 策略(未裁决;v0.61 启动门槛③,plan §4.4.5)**:`sanitize_path` 语义为"拒绝绝对路径"(本节定稿),但 CLI 工具场景(自写工具把 `env.get` 结果作为**用户可传绝对路径**的命令行参数)与该语义冲突。二选一,评审裁决后实现:① 新增 `sanitize_cli_path`(允许绝对路径、拒绝 NUL/控制字符,与 `sanitize_path` 并列,净化族 +1);② 裁定 CLI 工具改用 argv 传参(argv 在 v1 不标污,如实登记漏报窗口)。未裁决前 `std.unstr` 不预实现任何一种。

---

## 4. 与现有机制的交互逐项分析

### 4.1 效果系统

`Untrusted[T]` 是类型,效果系统零改动:`KNOWN_EFFECTS` 不动、`checkEffects` 不动、M3029/M3030 不动。交互点两个,均无冲突:

- **带效果函数与污点正交**:`fn f(u: Untrusted[str]) with fs` 合法(处理脏数据 + 声明 fs 效果是两件事);来源函数(如 v1 的 `env.get`/`read_line`)同时带效果与 Untrusted 返回——效果陈述"读外部输入",类型陈述"读来的不可信";fs/net/proc 内容源在 v1 不标(泄漏窗口,见 §3.1/§6.2 ②)。
- **闭包**:创建处继承效果(effectSink,src/checker.js:1356);污点随参数/返回类型照常传播。**存入数据结构的闭包不追踪调用点效果**(design §2.13 已知限制)对污点无影响——污点是类型事实,不经调用点追踪。

### 4.2 契约系统(任务书问:"requires 纯函数吃 untrusted 实参会怎样")

- **requires/ensures 引用 Untrusted 形参:允许,但受白名单约束**。契约表达式纯(M3029 通道,实测 §2.1 之 3);`Untrusted[str]` 形参在 requires 里只能用白名单方法或经净化函数。`sanitize_path` 返回 `Result[str, str]`(§3.4),契约断言需经 Result 处理,最简可行形态:

  ```ming
  requires std.unstr.sanitize_path(u).is_ok()
        && std.unstr.sanitize_path(u).unwrap().char_len() < 256
  ```

  **可写**——因为 `sanitize_path` 是纯函数(**机制实测 2026-11-13**:同形态纯函数契约——`fn sanitize_like(u: str) -> Result[str, str]` + `requires sanitize_like(u).is_ok() && sanitize_like(u).unwrap().char_len() < 256`——check exit 0;运行期违反时 M4015[contract-violation] exit 101,且 `&&` 短路保证 `unwrap` 不见 Err,报 M4015 而非 M4006 unwrap panic)。如实登记两处取舍:① 契约表达式无 let 绑定,同一纯函数须调用两次,这是最简可行表述(若 v1 给 Result 加 `map` 类方法可单调用,列入实现期裁量,非阻塞);② `unwrap_or("")` 的单调用形态被否——Err → "" 长度恒过,断言对非法路径失效,是虚假的"已净化"。**这是类型方案相对效果建模的第二个决定性优势**(效果建模下净化函数带 untrusted 效果,契约 M3029,无法断言"已净化")。
- **静态证明交互(实测机制,无冲突)**:prover 摘要只覆盖"纯函数 + 全 i64 参数/返回 + 直线体"(GUIDE §6;src/checker.js:2451 `sig.effects?.size > 0` 即跳过)——`Untrusted[str]` 形参不是 i64,自然在摘要范围外,静默放弃;M3041/M3042/M3045 的线性形式与反例枚举只处理 i64 空间,Untrusted 不进入。唯一要求:实现时确认 Untrusted 类型不破坏 `exprIsLinear`/`toLinear` 的叶子分类(字符串叶子本就保守跳过,预期零改动)。
- **契约函数与 wasm 资格**:带 requires/ensures 的函数已不进 wasm eligible(src/wasm.js:318)——与污点无关,既有行为。

### 4.3 四后端一致性(任务书问:"污点标注在 tree/VM/wasm/C 的语义一致性")

**运行时零改动,一致性免费**——因为运行时擦除;检查期的唯一改动面是 checker sig 层与 wasm.js `numOk` 对 Untrusted 的解包(按载体判定资格,见下)。**该裁定触及 wasm 资格的单一事实来源 `src/wasm.js` `analyze()`(AGENTS 硬规则 6),是实质决策而非"零改动"**——实现必须保持 `analyze()` 单一事实来源不裂化(裁决登记 §9 清单 14):

- tree/VM:值表示与载体相同,运行时无新形态;
- wasm 资格:`sig.effects` 门禁不涉及类型;`Untrusted[str]` 形参按什么资格判定?v1 裁定:**资格按载体类型判定**——checker 在喂入资格分析前按载体解包,或 wasm.js `numOk`(src/wasm.js:359/383)同步解包 Untrusted,实现期二选一,单一事实来源仍在 `analyze()`——`fn len_of(u: Untrusted[str]) -> i64 { return u.char_len(); }` 与同名 `fn len_of(s: str)` 资格相同。wasm/C 后端编译时按载体发射,无感知;
- C 后端:同上;extern 槽位按载体类型(`Untrusted[str]` 实参/返回按 `ming_str` 处理;返回侧强制 Untrusted 见 §3.1);
- 差分模糊器:生成器不生成 Untrusted 形态(与 Ptr 同款,§58 先例),四腿差分基线不变;
- **语义合同不含污点**:污点是检查期属性,四引擎的执行行为(输出/退出码/panic)与污点标注完全无关——同一程序标注与否运行时逐字一致(与 mask 的"仅类型检查差异"声称同形,但污点没有 mask 的签名撒谎问题,见 adr-003-mask.md §2)。

### 4.4 panic 与 Result 的污点保留

- **Result/Option/`?`:天然保留**。`Result[Untrusted[str], str]` 载荷类型即污点;`?` 传播不改类型;`unwrap_or` 的 fallback 实参类型必须与载荷一致(干净 fallback + 脏载荷不匹配,免费拒绝)。
- **panic 路径**:panic 不是效果、不携带类型(design §6.11 条件 2);panic 消息由诊断层构造(M4002/M4003 等含操作数值,**实测**:越界 panic 首行含下标值)。污点值进入 panic 消息 = 脏内容写 stderr——v1 裁定:**拒绝 Untrusted 直接插值/转换进 panic 面的消息构造**(与禁打印同通道:M3012/M3002),panic 消息里的值本来就只来自 i64 等纯载体,类型方案下 Untrusted 根本进不了插值,免费成立。
- **污点不会"洗进"panic**:不存在"经 panic 绕过净化"的路径——panic 是终止,不是值流。

---

## 5. 最小 v1 语法草案(2 个新概念,均在既有模式内)

### 概念 1:类型 `Untrusted[T]`(编译期标签,运行时擦除;载体 v1 仅 `str`)

```ming
use std.env;
use std.unstr;

fn main() with io {
    let raw = std.env.get("HOME");              // Option[Untrusted[str]](v1 起签名变更)
    match raw {
        Some(u) => {
            //  print(u);                        // M3002:Untrusted[str] 不能当 str 用(hint:先净化)
            //  print("\{u}");                   // 拒绝:插值禁面
            match std.unstr.sanitize_path(u) {   // 唯一出口:净化 Untrusted[str] -> Result[str, str](纯)
                Ok(home) => print(home),         // 干净值,自由使用
                Err(e)   => print("HOME 非法: \{e}"),   // 非法路径必须显式处理(§3.4 失败语义)
            }
        },
        None => print("HOME 未设置"),
    }
}
```

### 概念 2:净化函数族 `std.unstr.*`(纯函数;可信根单点化)

```ming
use std.fs;
use std.unstr;

fn dump_config(u: Untrusted[str]) -> Result[bool, str] with fs {
    //  std.fs.write_file("cfg.txt", u);        // M3002:write_file 第 2 参期待 str——sink 免费门禁
    let path = std.unstr.sanitize_path(u)?;     // 非法路径 Err 向上传播;Ok 的 str 是净化唯一出口(§3.4)
    return std.fs.write_file("cfg.txt", path);
}

fn port_of(u: Untrusted[str]) -> Option[i64] {
    return u.parse_i64();                        // 白名单方法:产出纯值,污点在数值上终结
}
```

**没有第 3 个概念**:来源标注是 std 签名变更(§3.1),sink 门禁是 unify 免费行为(§3.3),`mark` 是 std.unstr 的普通函数——语法面只有"一个类型 + 一个函数族"。对照先例:Ptr(v0.54)引入了类型 + 4 方法 + 块语法(3 面),Untrusted 更小。

---

## 6. 成本与风险

### 6.1 实现规模估计(以两个先例为参照)

| 先例 | 规模 | 涉及面 |
|------|------|--------|
| prover(v0.48 第一片→v0.52 抽出) | `src/prover.js` 422 行独立模块 + checker 适配 | 纯检查器,零 codegen |
| unsafe(v0.54 C5) | checker + parser + cbackend + interp 多点,§58 20 项(含独立审查) | 有 codegen(C 发射)与运行时拒绝(M4016) |

Untrusted 面比两者都小:**无 codegen、无运行时新形态、无资格旗标**。主体:

- checker:类型构造器注册 + unify(unify 对新 `k: 'untrusted'` 分支)+ 白名单方法表 + extern 返回强制 + 诊断发射,估 **100–200 行**(checker 5.3k 行的局部增量);
- interp:std 来源函数返回值不变(擦除)、std.unstr 净化族实现、`mark`;估 **50 行以内**;
- diag:新码 **2 个**(M3049/M3050,见 §8)三处登记;
- 文档:GUIDE 效果/污点节 + 修订记录、diagnostics、capabilities;
- **最大成本不在代码在迁移**:v1 窄源(2 个 std 签名 + extern 强制,见 §3.1)波及现有测试/示例/自举工具的调用点——机械但面窄,估计 12–20 处调用点修改 + 新分节测试 §65 约 15–20 项。

### 6.2 误报/漏报风险

**漏报窗口(诚实清单)**:① std 新增来源函数忘标——来源白名单测试锁定;② **v1 窄源之外的内容来源不标**——`fs.read_file`/`read_bytes`/`read_to_end`/`net.http_*` 响应体/`proc.exec` stdout/stderr 在 v1 明确不标,这是 **v1 的主要漏报窗口**(换来的迁移可行性:9 源全量会让 5 个自写工具直接 M3002);v1.1 需先设计 `Untrusted[u8]`/`Untrusted[Json]` 载体与净化器授权矩阵,不得静默扩载体;③ 白名单方法若误纳产出载体值的方法——白名单表测试锁定;④ 来源函数的 **Err 载荷不标污**——`read_file`/`http_get` 的 Err 串可含路径回显、`proc.exec` 的 Err 串可含命令回显,错误消息本身可能是不可信内容的载体。v1 接受该窗口(Err 通路典型归宿是日志/诊断面,与"不进 sink 面"的 print 取舍同源,见误报面①),如实登记;v1.1 与清单 9 的字节载荷一并裁决。

**误报面(可修,方向是收敛而非发散)**:① 合法低危流(打印脏数据调试)被迫净化——净化损耗内容,调试不便;诚实取舍:print 拒绝 Untrusted 是对的(日志注入正是威胁面之一),不便写进 GUIDE "给 AI 的使用建议";② 透传场景(把 header 原样传给日志函数)需要目标函数显式声明 Untrusted 形参——传播税,design §2.13 明说接受。

**无旁路声明**:unify 精确匹配 + 无隐式转换 + 无 `as` + 无字面量构造 = 类型系统内不存在"洗白"路径;唯一出口 std.unstr 单点受审计。这是与"lint 式污点"(候选 C)的本质区别——lint 可被忽略,类型不能。

### 6.3 与 static proof 的冲突点

逐项(均实测机制):① 摘要范围外(Untrusted 形参非 i64)——静默,无冲突;② 边界证明只看 `Vec[i64]` 形参——无交集;③ 契约表达式可含白名单方法与净化调用——净化是纯函数,契约纯性保持(M3029 通道实测为证);④ 反例枚举(i64 空间)不涉及 Untrusted——零交集。**结论:无结构性冲突**;实现验收里加一条"既有 proof_fuzz 三模式 0 误报不回退"。

---

## 7. 结论与触发条件

**结论:做——按类型级方案(`Untrusted[T]` + `std.unstr` 净化族)推进设计;效果建模(untrusted ∈ KNOWN_EFFECTS)否决,不再作为备选登记。**

**推迟条件(先于实现必须满足,不承诺版本)**:

1. v0.60 资源门禁一致性交付 + 本 ADR 五处补丁评审通过(窄源边界/`debug` 洗白禁面/白名单表/净化器授权位/码号 M3049/M3050),见 plan §4.4.4 任务 6;
2. 评审清单(§9)逐项裁决,尤其清单 1(类型名)、5(净化族范围)、6(extern 强制标污)、9(v1 窄源与载荷窗口是否可接受);
3. 12 工具迁移 spike:证明窄源方案下 `mingkit`/`json_query`/`diaghot`/`log_analyzer`/`edit` 不改内容处理逻辑;不通过则不实现(退化为测试与观测版,见 plan §4.4.5);
4. 一次破坏性变更窗口:v1 窄源标注(2 个 std 签名 + extern 强制,见 §3.1 迁移口径)+ 迁移,适合与下一个 minor 一起做,不做孤立的破坏版。

**不做的理由(如果最终否决,应基于以下事实而非成本)**:若评审认为"污点值连 `trim` 都不能调"的操作面过严导致采用率归零,则污点系统没有存在价值——宁可不建一个没人用的门禁,也不放宽到 lint。触发重开条件:出现真实用户/AI 工作流数据表明输入校验缺陷是 Ming 程序的主要缺陷类别(目前无使用数据,如实承认威胁模型是推断不是统计)。

## 8. v1 任务草案(v0.61 条件;启动门槛见 plan §4.4.5)

1. **checker**:Untrusted 类型构造器 + unify 分支 + 白名单方法表 + extern 返回强制 + 诊断(新码:`M3049[untrusted-mismatch]`(Untrusted 实参进非 Untrusted 槽,含 hint"先 std.unstr.* 净化")、`M3050[untrusted-method-forbidden]`(白名单外方法或洗白尝试,含 `debug` 禁面);与既有 M3002/M3008/M3012 的分工在实现时按"专用码优先、通用码兜底"裁定);三处登记。
2. **std 面**:v1 窄源标注(仅 `env.get`、`read_line` + extern 返回强制;fs/net/proc 内容源不标,见 §3.1);`std.unstr.sanitize_path -> Result[str, str]` + `std.unstr.mark`;GUIDE §18 各节同步。
3. **测试**:§65 新分节 15–20 项(来源标注正/负例、sink 免费门禁、载荷传播、白名单正/负例、契约内 sanitize、extern 强制、`?`/Result 保留、四引擎运行时一致(擦除验证:同程序标注与否输出逐字同)、来源/白名单/净化测试向量锁定、`debug` 拒绝)。
4. **文档**:GUIDE 新节(污点标注)+ 修订记录、design.md 新 §6.12(或并入本 ADR 引用)、capabilities "数据流安全(污点标注)" 行 ❌ → ✅(视交付)、README 路线图。
5. **验证门槛**:`run.mjs` 全绿;`fuzz` 0 分歧;`proof_fuzz` 三模式 0 误报;四引擎对标注程序逐字一致;check 语料耗时 ≤1.3x。

## 9. 评审清单(16 项;14–16 为 2026-11-13 独立审查补登)

| # | 决策点 | 本 ADR 立场 |
|---|--------|-------------|
| 1 | 类型名:`Untrusted[T]` / `Taint[T]` / `Raw[T]` / `Dirty[T]`? | 暂定 `Untrusted[T]`;要求:与 Vec/Option/Ptr 同风格、含义无歧义 |
| 2 | 建模:效果(候选 A)vs 类型(候选 B)vs 检查器私有数据流(候选 C) | **B**;A/C 否决理由见 §2,否决应视为终局(不许"先 A 后 B"混合) |
| 3 | 运行时擦除 vs 值携带污点位 | **擦除**;携带位 = 值表示变更 + 四引擎深拷贝/比较/序列化全链路改造,成本不成比例 |
| 4 | 来源迁移:改签名(破坏)vs 并行 unstr 入口 | **改签名,升 minor**;并行入口违反"一种结构一个语法" |
| 5 | 净化族范围:v1 仅 `sanitize_path`,还是加 `sanitize_log`/`sanitize_url`? | **仅 sanitize_path**;族按真实 sink 用例扩展,每加一个 = 一次可信根扩权。失败语义已定为 `Result[str, str]`(非法路径 Err,§3.4),族内新函数沿用同一签名风格 |
| 6 | extern 返回值强制标污(签名禁写裸 str 返回) | **强制**;漏标是语法错误而非纪律。ffi struct 面扩大时(Backlog "ffi 面扩大"条目)另行评估污点规则——struct 返回值的字段级标注是新的裁决面,本 ADR 不预支结论 |
| 7 | 拼接/插值传播:v1 拒绝,还是提供 `std.unstr.concat`(污进污出)? | **拒绝**;若透传场景证明需要,concat 作为族函数加入(签名即传播规则) |
| 8 | Untrusted 操作面:零操作 vs 白名单(parse_i64/char_len 等产出纯值的方法) | **白名单**;零操作使处理函数不可写;白名单表测试锁定,"产出同污点载体"的方法 v1 不设 |
| 9 | v1 载荷仅 str 的漏报窗口(`Vec[u8]` 来源不标) | v1 窄源(仅 `env.get`/`read_line` + extern)已把 fs/net/proc 内容源列入泄漏窗口,见 §3.1/§6.2 ②;v1.1 按载体设计扩(`Untrusted[u8]`/`Untrusted[Json]`),不得静默扩载体 |
| 10 | `std.unstr.mark`(标脏)公开 or 仅 test 块 | **公开**;标脏只会更严,公开无危害且简化测试 |
| 11 | 契约内净化(`requires sanitize_path(u)...`) | **允许**(净化纯函数是关键设计约束,实现必须保持 sanitize 零效果);契约形态经 Result 处理,见 §4.2(`is_ok` 前置 + `unwrap`,双调用为最简可行表述) |
| 12 | 诊断码:专用码(M3049/M3050)vs 复用 M3002 | **专用码**;hint 可携带"先净化"处方,修复处方(fix)指向 sanitize 调用;M3048 已被 v0.59 泛型本地函数占用,不得复用 |
| 13 | 实现时序:v0.61 条件 vs 让位 serve 落地后 | **v0.61 条件实现**;启动门槛见 plan §4.4.5(五处补丁评审 + 工具迁移 spike + 净化器策略裁决),不满足则退化为测试与观测版 |
| 14 | wasm/C 资格裁定:Untrusted 形参的资格按载体判定;改动面 = checker sig 层/wasm.js `numOk` 解包 Untrusted,运行时擦除 | **按载体判定**;该裁定触及 wasm 资格单一事实来源 `src/wasm.js` `analyze()`(AGENTS 硬规则 6),是实质决策——实现必须保持 `analyze()` 不裂化(§4.3);运行时四后端仍零改动 |
| 15 | 工具链联动:`ming doc --json`、LSP hover/补全、typeStr 渲染、接口哈希对 `Untrusted[T]` 的处理 | typeStr 渲染为 `Untrusted[T]` 字面串(与 `Vec[str]` 同规则),doc/LSP 随 typeStr 自动覆盖;接口哈希按渲染串计算——污点标注变化即接口变化(显式);v1 实现期逐点核验并补测试,属文档/工具面,非语义面 |
| 16 | plan 落地同步(评审通过后):§4.4.5/§4.4.10、§4.2.8 污点行处置文字、§4.2.2 编号撞号 | plan §4.4.4 任务 6/§4.4.5/§4.4.10 已记录五处补丁与窄源 v1;§4.2.8 "污点即效应"行处置文字改为"类型级方案已通过(ADR-002),v0.61 窄源条件实现";plan §4.2.2 内联 ADR 表标题已注明"编号已被 docs/adr-00N 文件系列取代"(撞号已处理) |
