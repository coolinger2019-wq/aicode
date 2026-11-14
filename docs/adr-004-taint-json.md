# ADR-004:Untrusted[Json]——serve 载荷的污点标注(改签名接入 + 整树递归标注;出口标注否决)

> **状态**:评审中(提案;plan §4.5.3 任务 6 交付,v0.66 规划期任务——实现走 go/no-go 条件承诺,不在 v0.66)· **日期**:2026-11-14 · **版本基线**:v0.65.0(1035 项回归全绿)
> **立场声明**:本 ADR 只交付设计裁决,**不写任何语言实现代码**。文中全部数字为仓库现状实测(标注"实测",附复现命令,环境 Node v24 / win32-x64 / 2026-11-14)或源码确认(标注文件:行号);无一处来自想象。
> **结论先行**:做——但按四个裁决收窄:**① 接入面改 serve 签名**(handler 形参 `Json` → `Untrusted[Json]`,升 minor,破坏窗口一次用完);**② 粒度整树递归标注**(`Untrusted[Json]` 的访问器族污进污出、载体随投影收窄——`as_str` → `Untrusted[str]` 接 v1 str 全套面);**③ 净化器族不扩**(投影 + 既有 `std.unstr.sanitize_*` 复用即最小闭环,`sanitize_json` 不预支);**④ 零新增 M 码**(M3049/M3050 机制载体无关自动覆盖,hint 文本载体感知)。"出口标注"(handler 保持 `Json`、把污点标在 `json.get` 取值口)否决:它要么全局重打访问器签名误伤整个 Json 面,要么退化为检查器私有流状态(ADR-002 候选 C,已否决)——不存在第三种温和形态。若提议"检查器在 get 分发处按接收者载体决定返回类型",该做法预设签名已改标——那正是候选 A 本身,三分归二。
> **关联**:docs/adr-002-taint.md(v1 窄源全部裁决与风格,本文沿其口径)· docs/adr-001-concurrency.md(serve 错误表与检查点)· docs/adr-003-mask.md(mask 否决,"签名看不见的事实不可接受"立场同源)· docs/plan.md §4.5.3 任务 6 / §4.5.4(处置行)/ §4.5.7 S10 / §4.4.10 · GUIDE §16(Json)/ §18(std.unstr)/ §19(serve)· docs/capabilities.md 污点行(未覆盖清单具名 `Untrusted[Json]`)。

---

## 1. 背景与威胁模型

### 1.1 serve 载荷是网络内容源,却在污点面之外(S10,实测)

v0.62 交付的 `std.net.serve`(ADR-001)是 Ming 首个常驻网络面。handler 收到的请求载荷 `{method, path, headers, body}` 是**网络内容源**——攻击者(本机攻击者前提,127.0.0.1 固定)完全控制这四个字段的字节。而 v0.61 污点窄源 v1(ADR-002)的来源仅 `env.get`/`read_line`/extern 返回——serve 载荷不标、无编译期警告、检查直通:

**(实测,plan §4.5.7 S10 原始证据)**:handler 内请求 body 内容直接拼进 `fs.write_file` 路径,`ming check` **exit 0**——类型正确、效果齐备(`with net, fs`)、污点面零拦截。GUIDE 警告已随 v0.64 文档化(GUIDE §19 serve 节"安全事实"行):"handler 收到的载荷全部不可信……把它们拼进路径/命令前必须先过 `std.unstr.sanitize_path` / `sanitize_cli_path` 净化"——但这是**人工纪律**,不是编译期事实。S10 处置行明确:"v1.1 Untrusted[Json] 时 serve 载荷列第一扩面候选"。

与 ADR-002 §1.1 同一论式:AI 生成 handler 的最高频缺陷不是写错逻辑,而是忘了校验请求输入;"这份数据可信吗"今天没有任何机制回答(效果回答"函数会做什么",契约回答"对输入的假设是什么",证明回答"索引是否越界")。

### 1.2 既有面盘点(实测签名)

- **serve 签名**(src/checker.js:390;GUIDE §19):`serve(port: i64, handler: fn(Json) -> Json) -> Result[i64, str]`,效果 `net`;handler 特例检查在 checker.js:4064–4130(端口 i64 / 命名模块函数引用 / 单参数 / **形参 Json**(:4119–4124)/ 返回 Json(:4125–4129));handler 效果白名单 8、sync/unsafe/ffi 拒绝;S9 嵌套 serve 编译期拒绝(v0.64 两遍式,serveCallNodes 以 checker 真实解析为单一事实来源)。
- **请求/响应键集**(GUIDE §19):请求 `{method, path(含 query 原样), headers(键小写), body}`;响应 `{status, headers, body}`,缺省 200/`{}`/`""`,响应 body 直传 HTTP 体;键集固定 additive,v1 只检类型不深检键集。
- **Json 类型面**(GUIDE §16;checker.js:4254 jsonMethod 分发,4762–4795 方法签名):`json.parse(str) -> Result[Json, str]`(纯)/ `json.stringify(JSON 兼容) -> str`(纯)/ 访问器族精确 13 个:`is_null is_bool is_num is_str is_arr is_obj`(→ bool)、`as_str -> Option[str]`、`as_num -> Option[f64]`、`as_bool -> Option[bool]`、`as_arr -> Option[Vec[Json]]`、`as_obj -> Option[Map[str, Json]]`(**副本**,Json 不可变)、`get(str) -> Option[Json]`、`at(i64) -> Option[Json]`、`eq(Json) -> bool`;struct/枚举不自动序列化(M3033)。
- **污点 v1 面**(checker.js):类型构造 `{k:'untrusted', el}`(:43);载体强制仅 str(:705–719,`Untrusted[X]` X≠str → M3050,**消息具名"扩载体需先设计 Untrusted[u8]/Untrusted[Json] 与净化器授权矩阵"**——本次扩面的指针 v0.61 已预留);unify 精确匹配(:125–127);白名单 5 方法(:512 `UNTRUSTED_METHODS`);M3049 专用码判定载体无关(:809–815,checker 内 32 处引用,GUIDE 口径"21 处槽位 + struct 字段前置");extern 返回强制(:885–891);禁面 debug/插值/`as`(M3050)。运行时擦除:interp 无污点位,GUIDE §18"四引擎输出与标注无关"。

### 1.3 为什么文档化不够

S10 的文档化处置(v0.64)覆盖了"不知道要净化"的场景,但威胁模型的主体恰恰是**知道却忘了/写错**:AI 生成的 handler 在业务逻辑里对 `req.path` 拼一次路径,review 与 GUIDE 警告都拦不住一次性失误——这正是 M3029 对效果、M4003 对索引已经做到的事:让失误成为编译错误。serve 是常驻面(进程不退出),一次注入 = 持续可复现的攻击窗口,暴露面高于一次性 CLI 工具。

---

## 2. 决策点 1:接入面——三个候选逐一裁决(核心决策)

问题:污点事实标在哪?候选 A 改 serve 签名(handler 形参变 `Untrusted[Json]`);候选 B 新增 `serve_untrusted` 变体;候选 C 保持 handler 形参 `Json`,把污点标在取值出口(`json.get()` 等访问器返回 `Untrusted[...]`)。

### 2.1 候选 A:改 serve 签名(handler: fn(Untrusted[Json]) -> Json)(采纳)

handler 形参类型改 `Untrusted[Json]`,checker 特例(:4119–4124)与签名表(:390)同步。请求对象**整树**以 `Untrusted[Json]` 进入 handler——污点在入口,签名即全部含义(design §1"显式";ADR-002 §2.2 同款):任何拿到请求值的代码,类型系统立刻知道它未经校验;期待 `Json` 的一切位置(赋值/传参/Map 构造/stringify/透传/struct 字段)自动 M3049——sink 门禁免费,与 v1 str 口径逐字同构。

响应方向不变:handler 返回 `Json` 不标(裁决与论证见 §4.3)。

### 2.2 候选 B:serve_untrusted 变体(否决)

handler 形参保持 `Json`,新增 `serve_untrusted(port, handler: fn(Untrusted[Json]) -> Json)`。**否决**,一条即致命:违反"一种结构一个语法"(design §1 原则 5)。ADR-002 清单 4 对同构问题("改签名 vs 并行 unstr 入口")已裁决"**改签名,升 minor**;并行入口违反一种结构一个语法"——serve_untrusted 是同一错误的重演:两个 serve 并存,文档、测试、GUIDE、AI 训练语料全部要维护"什么时候用哪个";且"不标污的 serve"从此永远合法,等于给威胁面保留一个常备干净入口。

### 2.3 候选 C:出口标注(json.get 返回 Untrusted)(否决——不存在温和形态)

handler 形参保持 `Json`,把污点标在取值出口:handler 体内的 `.get(k)`/`.as_str()` 等访问器返回 `Untrusted[...]`。表面温和(不动 serve 签名),细查**只有两种可实现形态,各自致命**:

1. **全局重打访问器签名**:`.get(k) -> Option[Untrusted[Json]]` 对**一切** Json 接收者生效——类型上无法区分"来自 serve 的 Json"与"来自 `json.parse` 字面量的 Json"(两者类型相同,这正是入口标注缺失的后果)。误伤面实测:**tools/json_query.ming 的下钻主循环就是 `cur.get(seg)` / `cur.at(idx)`**(tools/json_query.ming:24/37),改签名后工具的每次取值都产出污值,进一步 `.get`/stringify/print 全部 M3049——工具直接不可写;tests/GUIDE/examples 全部 Json 访问代码同批破坏。为避免改一个 serve 签名而破坏整个 Json 访问面——代价倒挂,方向性错误。
2. **检查器私有流状态**:只对"来自 serve 的 Json 接收者"让访问器返回 Untrusted——同一类型两种行为,污点事实不在签名里,`ming fmt`/doc/LSP/契约/证明全部要感知一份签名看不见的状态。这是 ADR-002 §2.3 否决候选 C 的同款理由("签名看不见的效果/事实不可接受"),不再复议。

**结论:候选 C 要么比候选 A 破坏面大一个数量级,要么退化为已否决的模型——不存在第三种温和的出口标注。**

### 2.4 裁决与迁移面(实测)

**采纳候选 A。** 决定性论据排序:签名即全部含义(污点在入口,类型事实可审计)> sink 门禁免费(M3049 机制载体无关,零新发射点)> 迁移面实测极小(下表)> "一种结构一个语法"纪律(候选 B 否决)> 候选 C 的两难无第三态。

**迁移面实测(2026-11-14,复现:`grep -rln "net\.serve" examples/ tools/`)**:

| 范围 | serve 用例 | 性质 |
|------|-----------|------|
| examples/*.ming | **0** | grep 零命中 |
| tools/*.ming(12 个自举工具) | **0** | grep 零命中——工具不用 serve,**迁移面为零**(go 条件的书面依据) |
| GUIDE §19 示例 | 1 处(`fn handler(req: Json) -> Json`) | 机械改签名 + 投影 |
| tests/run.mjs §66 | handler 签名 `req: Json` **29 处**;`net.serve` 引用 33 处(含注释与错误用例);约 22 条 check(GUIDE v0.62 记录) | 多数 handler 不触载荷(改签名行即可),触载荷用例改投影形态 |

合计约 **30 处机械迁移**,与 v0.61 的 12 工具 12 处 `sanitize_cli_path` 迁移先例同量级(GUIDE v0.61 记录"良性 env 行为逐字不变")。serve 是 v0.62 新 API,破坏窗口现在最便宜、越晚越贵——**这是本 ADR 的时效论证:迁移面只会增长**。

---

## 3. 决策点 2:粒度——整树递归标注(核心决策)

问题:`Untrusted[Json]` 的内部结构如何传播?`.get(key)` 返回什么?三个候选:(a) 递归整树标注;(b) 叶子/一层标注;(c) 取出即净值。

### 3.1 (b) 是伪选项,(c) 有结构性旁路

- **(c) 取出即净**:污点只盖一层——`req.get("body")` 出来就是净 `Json`,再 `get`/`as_str`/装 Map 全部自由,整树标注的意义被第一次取值清零;更糟:先 `as_obj` 拿 `Map[str, Json]` 副本再当普通 Json 用,污点在副本上消失(副本类型是净 Map)——**净化出口旁路**。
- **(b) 叶子标污**:类型上不成立——`get(k)` 的结果可以是对象/数组/数字,静态类型只能是 `Json` 或 `Untrusted[Json]`,不存在"知道叶子是 str"的静态形态;若重定义为"`get/at` 出净 `Json`、仅 `as_str` 出污",则对象子树取出来就是净的,污点只盖一层——退化为 (c)。
- **粒度问题的真实形态是二选一:整树标注 vs 只标一层(= c)。后者有结构性旁路,故 (a)。**
- **实现面对照(诚实评估)**:整树标注的 checker 面 = 载体白名单放宽 + 投影表(单向,约 70 行),wasm/C 资格零改动(json 载体本就在非 eligible 面);出口标注的实现面 = 全局形态需每访问器 × 净/污两套签名(jsonMethod 13 个方法全改,且与"净化后重建 Json"的正常流互相打架)或私有流形态(流敏感遍历 + fmt/doc/LSP/契约四工具链感知,规模不可控)。整树标注在两个维度都更小。

### 3.2 裁决:(a) 递归整树标注——载体投影保污

`Untrusted[Json]` 的访问器族按**污进污出、载体随投影收窄**返回(checker `jsonMethod`(:4254)按接收者载体分派的投影表;运行时擦除,方法实现零新增):

| 访问器(接收者 `Untrusted[Json]`) | 返回类型 | 污点语义 |
|---|---|---|
| `.get(k) / .at(i)` | `Option[Untrusted[Json]]` | 子树整树污(递归) |
| `.as_str()` | `Option[Untrusted[str]]` | **载体收窄为 str——接 v1 str 全套面**(白名单 5 方法 + `sanitize_path`/`sanitize_cli_path`/mark),污点不因投影消失 |
| `.as_num()` | `Option[f64]` | 净值(污点在数值上终结,沿 ADR-002 白名单原则;as_num 即 f64,checker.js:4771 既有) |
| `.as_bool()` | `Option[bool]` | 净值 |
| `.as_arr()` | `Option[Vec[Untrusted[Json]]]` | 容器载荷保污(泛型精确传播,免费) |
| `.as_obj()` | `Option[Map[str, Untrusted[Json]]]` | 同上(副本语义不变) |
| `.is_null/.is_bool/.is_num/.is_str/.is_arr/.is_obj` | `bool` | 净值(谓词同 `is_empty` 口径,ADR-002 §3.2) |
| `.eq(other)` | `bool` | 净值(比较不外流载荷,污点在布尔上终结;实参载体放宽为净或污均可——否则两个污子树无法比较) |

**表外一律 M3050/M3049 拒绝**:白名单表测试锁定(沿 ADR-002 清单 8),`UNTRUSTED_METHODS`(:512)从单载体 Set 改载体键控表(`str` → 5 方法 / `json` → 上表)。禁面(debug/插值/`as`)按 `k==='untrusted'` 泛化——`Untrusted[Json]` 做插值/`debug` 实参/`as` 目标自动拒绝,实现期核验既有禁面分支无载体硬编码(预期零改动)。

### 3.3 载体语义:泛型标注,不做别名;Json 不可变性使恒等式更简单

- **标注方式 = 既有 `Untrusted[T]` 构造器载体集合 +1**(`resolveTypeAst` 白名单 str → {str, json},checker.js:705–719):`Untrusted[Json]` 复用 `{k:'untrusted', el:{k:'json'}}`,unify/typeStr/接口哈希/doc/LSP 渲染全部自动覆盖(typeStr :162 渲染 `Untrusted[Json]` 字面串,与 `Vec[str]` 同规则,ADR-002 清单 15 口径)。**不做别名**(如 `TaintedJson`):Ming 无类型别名机制,引入别名 = 新语言面;`Untrusted[Json]` 与 v1 的 `Untrusted[str]` 同构、自解释。
- **深拷贝保污点 = 类型恒等式**(照搬 ADR-002 §3.2):赋值/传参/返回/集合存入深拷贝(design §2.3 值语义),类型不因拷贝改变,运行时无污点位、拷贝无需任何改动。**Json 不可变**(GUIDE §16:`as_obj` 返回副本)使该恒等式更简单——不存在"经 mut 引用改写内层值"的第三通道;访问器副本(`as_arr`/`as_obj`)的元素类型即投影表类型,污点精确传播。
- **跨任务/边界**:wire 序列化按值深拷贝(Json 可跨,GUIDE §20),运行时擦除使 wire 层无感知;`spawn` 形参声明 `Untrusted[Json]` → 泛型载荷精确传播,污点跨任务保持(类型事实)。无窗口。
- **构造面**:`Untrusted[Json]` 无字面量(沿 ADR-002"不能凭空造脏,也不允许默认干净")。**新增 `std.unstr.mark_json(j: Json) -> Untrusted[Json]`**(+1 标脏入口):测试块与 `Option[Untrusted[Json]]` 的 `unwrap_or` fallback 需要它——没有它,污点类型不可构造、测试写不出。**裁决:mark 族是"标脏入口"不是"净化出口",不触发净化器族扩展纪律**(§4.4;标脏只会更严,公开无危害,沿 ADR-002 清单 10 同款论证)。`mark(str)` 保持不动。

### 3.4 传播规则数量与误报/漏报面

- **传播规则零新增**:整树标注下,"污点如何随 Json 内部流动"不是需要实现的规则,是类型系统恒等式(泛型载荷精确传播,unify 既有行为)——Untrusted 值装进期待 Json 的一切槽 → M3049,无旁路。需要写的只有投影表(§3.2)与载体白名单。
- **误报面(可修,方向收敛)**:① handler 校验过的字段仍是污——**校验 ≠ 净化**,唯一出口是净化函数,与 v1 str 口径一致(特性不是缺陷);② echo/透传类 handler 被拦(§4.3,缓解 = 投影 + 净化 + 重建);③ 纯路由 handler(只取 `method`/`path` 分发)每个取值多一层投影——机械税,GUIDE 给标准形态(`req.get("path").as_str()` → 净化)。
- **漏报面**:见 §5 诚实清单。

---

## 4. sink 位与净化器

### 4.1 Json 的 sink/出口位盘点

| 位 | 签名 | Untrusted[Json] 语义 |
|---|---|---|
| `std.json.stringify` | `(JSON 兼容) -> str`(纯) | **M3049 拒绝**——Json→str 的唯一整体出口在类型层闭合(§4.2) |
| `fs.write_file/append_file` content 位 | `content: str` | content 是 str 不是 Json;Untrusted[Json] → content 的路径必经 stringify → **链路在 stringify 处闭合**,fs 侧零新检查 |
| `fs.*` path 位 | `path: str` | 请求内容拼路径:投影 `as_str` → `Untrusted[str]` → 既有 `sanitize_path`/`sanitize_cli_path`(v1 面,**零新增**) |
| serve 响应 body 位 | handler 返回 `Json{status, headers, body}` | 透传请求子值进 `Map[str, Json]` 构造 → M3049 免费拦截(§4.3) |
| `json.parse` 入口 | `(str) -> Result[Json, str]` | `Untrusted[str]` 实参 → M3049(v1 既有,零改动)——污点内容必须净化后才能重建 Json,parse 不开旁路 |
| extern 实参位 | C ABI 无 Json | 不适用 |

### 4.2 stringify 拒绝:最小闭环的支点

`stringify(Untrusted[Json]) → M3049` 是本方案唯一"新增语义"的 sink 裁决,理由:① stringify 是 Json → str 的**唯一整体出口**,拒绝它 = 污点树无法整体变成字符串流进任何 str sink(文件/日志/HTTP 体)——链路在一处闭合;② 不设"污进污出 stringify"(`stringify_untrusted(u) -> Untrusted[str]`):JSON 转义不覆盖内容级注入(§5 ②),标污 stringify 会诱导"标污即安全"的错觉,且字段级出口已由投影 `as_str` 覆盖(语义更准:取的是字段值,不是序列化产物)。若评审认为序列化透传场景确需,`std.unstr.stringify_untrusted` 作为族函数列入评审清单 5 裁决——v1.1 默认不加(沿 ADR-002 清单 7 concat 的同款纪律:签名即传播规则,按真实用例扩展)。

### 4.3 响应方向:handler 返回 Json 不标;回显透传免费拦截

- **响应是 Ming 产出,非外部输入**:handler 构造的响应里的净值(字面量、计算结果、常量)不是污点源;给返回类型标 `Untrusted[Json]` 会把"服务端自己产出的每个响应"卷进污点面,却没有威胁对应物(serve 的返回值只送 socket,不回流 Ming 值域;响应内容污染调用方属下游消费问题,Ming 无 DOM)。**不标**。
- **回显(reflection)透传被免费拦截**:handler 把 `req` 或其子值直接放进响应构造 → `Map[str, Json]` 字面量期待 Json、实际 Untrusted[Json] → M3049。echo 类合法用例的迁移形态 = 投影 + 净化 + 重建(`as_str` → sanitize → str 进 Map)。**不做"响应位授权"**(给回显开窗):回显是反射面,Ming 无 DOM 下的真实威胁是"攻击者内容进调用方文件/日志"——那走文件/日志 sink,类型层已闭;响应位放行与禁面纪律冲突。
- **响应头位**:头值白名单运行时护栏已有(非法字符 → 500 internal_error,ADR-001 错误表;实测基线"CRLF/DEL 头注入 → 500 服务存活")——类型门禁 + 运行时护栏双层(类型层缺口见 §5 ④)。

### 4.4 净化器族不扩(裁决)

**v1.1 不新增任何 sanitize_* 函数;`sanitize_json` 不设。** 理由四条:

1. **净化器 = 可信根扩权**(ADR-002 §3.4/清单 5 纪律):每加一个 = 一次扩权,须真实 sink 用例驱动;v1.1 尚无一个真实用户用例要求"JSON 内容净化"——只有威胁模型推断。
2. **"净化的 Json"语义不明**:JSON 结构安全性已由 `stringify→parse` 往返保证(GUIDE §19 示例注"注入安全");剩余威胁是**内容级**(script 标签、方向符、伪造行),净化目标因 sink 而异(写日志 = 拒行分隔符、下游 HTML 渲染 = Ming 无 DOM、写配置 = 结构校验)——单一 `sanitize_json` 无法定义"净"是什么,定义不清的可信根比没有更危险。
3. **投影 + v1 str 面已是最小闭环**:handler 拿到 `Untrusted[Json]` → `as_str` 出 `Untrusted[str]` → 既有 `sanitize_path`/`sanitize_cli_path`/白名单 parse → 净值 → 重建 Json(**经净化才能过 parse**,§4.1)。**净化复用,零新增出口**——可信根不扩。
4. **族扩展留待真实用例**:若 serve 真实服务观察(plan §4.5.3 任务 3)或用户反馈证明需要"拒绝含换行/控制字符的字符串字段"类语义,按族扩展纪律另裁决(授权位逐个登记、测试向量锁定)——登记为候选,不预支。

---

## 5. 泄漏窗口诚实清单(落地后仍漏的路径,如实登记)

> 即使 Untrusted[Json] 按本 ADR 落地,以下窗口仍然存在。污点系统的承诺边界 = "未经净化不进 sink",不承诺"内容对下游格式安全"。

1. **`json.parse` 接缝(v1.2 前不闭)**:v1 不标的 str 源(`fs.read_file`/`read_bytes`/`read_to_end`/`net.http_*` 响应体/`proc.exec` stdout)→ `json.parse` → **净 Json**——"下载配置文件 → parse → 当干净 Json 用"的同构流完全在污点面外。serve 域内不触发(载荷直接以 Json 进 handler,不经 parse),且污点 str 进 parse 已被 M3049 拒;但跨域窗口 v1.1 不扩大也不缩小——fs/net/proc 内容源标污是 v1.2 裁决(§6.1),两域以 parse 为接缝,边界如实写进 GUIDE。
2. **JSON.stringify 转义不覆盖内容级注入**:JSON 转义覆盖引号/反斜杠/控制字符(<0x20),**不转义 `<` `>` `&` 与 Unicode 方向符(U+202A–202E,S12 同族)**——HTML/脚本注入面在 Ming 无 DOM 的前提下受限,真实威胁 = 写入文件/日志后被下游按 HTML/渲染语义消费。伪造行窗口是双保险:compact stringify 无裸换行(结构层)+ `as_str` 后经 `sanitize_cli_path` 拒 C0(内容层)——但**下游格式安全不属污点承诺**(净化器族不扩的直接后果,§4.4)。
3. **经净化器的回显不受二次追责**:`sanitize_cli_path` 是"校验不改写"语义——除控制字符外的请求内容可经净化闸回填响应 body 或文件。净化 Ok = 已过闸,污点系统不评价净化器选择是否恰当(选错净化器 = 语言层合法、安全层欠妥)。"选对净化器"的责任留在审计面与 GUIDE 使用建议。
4. **响应头位的类型层缺口**:请求 headers 值经 `as_str` + 净化后回填响应 headers——类型层对"净化后头值"无语义约束,CRLF 注入由 accept 层白名单护栏运行时拦截(500 internal_error,ADR-001 错误表)。双层防护中的类型层缺口如实登记(危害受护栏兜底)。
5. **ADR 落盘 ≠ 窗口关闭**:实现走 go/no-go 条件承诺(plan §4.5.4),go 之前 serve 载荷仍完全在污点面外(S10 现状),GUIDE 警告(人工纪律)是唯一防线。本 ADR 只裁决,不改现状。

**免费闭合确认(写清楚,防止评审误以为需要额外机制)**:① panic/错误消息面——Untrusted 插值/`debug`/`as` 禁面(M3050)使污点内容进不了 panic 消息构造;② helper 间接封装——污点是类型事实,helper 形参声明 Json 则传污即 M3049、声明 Untrusted[Json] 则签名自报家门,不存在 S9 式的扫描面逃逸(S9 是运行时行为问题,污点不是);③ Err 载荷口径沿 ADR-002 §6.2 ④ 既有取舍(`join_detailed` 的 Err Json 不标,v1.1 不变)。

---

## 6. 与 v1 窄源的边界;与 serve v1.1 的关系

### 6.1 fs/net/proc 内容源:v1.1 不扩(裁决)

`fs.read_file`/`read_bytes`/`read_to_end`/`net.http_*` 响应体/`proc.exec` stdout/stderr 的 str 污点**不随本载体一并扩**。理由:① plan §4.5.4 处置行把 v1.1 单主题定为 serve 载荷——fs/net/proc 扩面是另一轮迁移(ADR-002 实测:9 源全量会让 `mingkit`/`json_query`/`diaghot`/`log_analyzer`/`edit` 五个工具直接 M3002),两次破坏混进一个 minor 违反"一版一主题、独立回退"(plan §4.4.10 纪律);② 载体纪律:扩面不得静默(ADR-002 §6.2 ②、checker.js:715 消息同款),`Untrusted[u8]`/argv 载体仍留 v1.2+ 另裁决。**`json.parse` 是两域接缝**:serve 载荷 v1.1 标,内容源流 v1.2 裁决——GUIDE 双处登记边界。

### 6.2 与 serve v1.1(优雅停机)的关系:独立,可同版不绑定

裁决建议:**go/no-go 独立评审,可同版但不绑定**。两者都是 serve 面小增量,若同版可共享一次"serve 面变更"的文档与测试语境;但触发条件不同——优雅停机取决于任务 3 真实服务观察(需求是否真实出现),Untrusted[Json] 取决于本 ADR 评审 + 迁移面确认(§7.3)。任一 no-go 不阻塞另一个。若同版,**顺序建议:先签名变更(破坏面)后优雅停机(additive,实现路径已预留,约 30–50 行)**——破坏窗口一次用完,additive 不占破坏配额。

---

## 7. 成本与 go/no-go 条件

### 7.1 实现规模估计(对照 v0.61 实际先例)

v0.61 污点最小片实际交付:checker 主体增量 + interp unstr 三函数(interp.js:1514–1540)+ 12 工具 12 处迁移 + §65 40 条 check(GUIDE v0.61 记录)。Untrusted[Json] 增量面:

| 面 | 内容 | 估计 |
|---|---|---|
| checker | `resolveTypeAst` 载体白名单 str→{str,json}(:705–719,约 5 行);白名单表载体键控(str 5 方法/json 投影表,约 15 行);`jsonMethod` 投影分派(§3.2 表,约 50 行);serve 特例签名与形参检查翻转(:390/:4119–4124,约 15 行);`mark_json` 签名(约 3 行);M3049/M3050 hint 载体感知(约 5 行) | **约 90–120 行** |
| interp | `mark_json` builtin(擦除直返,约 5 行);serve 请求载荷运行时**零改动**(擦除——handler 收到的值就是 Json) | **约 5–10 行** |
| wasm/C | **零改动**:json 形参本就不在 `numOk` 面(wasm.js:411–427 无 json 分支),`Untrusted[Json]` 资格分析前解包(沿 v0.61 compiler tryWasm 侧解包先例,`analyze()` 单一事实来源零改动,ADR-002 清单 14 口径)→ 与裸 Json 形参同款资格拒绝回落;C 后端 `mingTyNum` 载体穿透(cbackend.js:57)后走 json 既有拒绝路径。实现期核验一条:解包后 json 分支拒绝行为与裸 Json 形参逐字一致 | 0 |
| diag | **零新增 M 码**(§7.2);hint 文本扩载体感知 | 0 |
| 文档 | GUIDE §16/§18/§19 + 修订记录;diagnostics hint 行;capabilities 污点行(未覆盖清单移除 `Untrusted[Json]`);plan 收口(§4.5.4 处置行、§4.5.7 S10 行状态更新) | — |
| 测试 | 新分节 12–18 条:签名破坏正负例 / 投影表逐条(get·at·as_arr·as_obj 保污,as_num·as_bool·is_*·eq 净值,as_str 收窄)/ stringify 拒绝 / 响应回显拦截 / mark_json / 深拷贝保污 / 擦除一致三引擎 / 契约内投影 / `as` 目标拒 / 工具零影响冒烟 | 12–18 条 |
| 迁移 | tests §66 约 29 处 handler 签名 + GUIDE 示例 1 处;examples/tools **0** | 约 30 处机械 |

**总量估:src 约 100–130 行 + 迁移约 30 处 + 测试 12–18 条——低于 v0.61 污点最小片总量**;wasm/C/运行时三面零改动(运行时擦除的第三次兑现)。

### 7.2 诊断码建议:零新增

沿 ADR-002"专用码优先":M3049(untrusted-mismatch)的判定按 `actual.k==='untrusted'` 泛化(checker.js:809–815,载体无关),Untrusted[Json] 自动覆盖,32 处发射点全部复用;M3050(untrusted-method-forbidden)同理。零新增码的理由:两个码的语义("污进净槽"/"禁面方法")在载体扩面后不变,变的只是 hint 文本("先净化,或经 as_str 投影后净化")。实现期若 hint 需要区分载体导致消息模板分裂,仍不新码——消息内嵌载体名;若发现确需新码(如投影表外专用拒绝),按三处登记纪律(`src/diag.js` CODES / `docs/diagnostics.md` / 测试)补登,不预支。

### 7.3 go/no-go 条件(全部满足才进入实现;任一不满足 → 保持 ADR 状态,plan 记录未满足项与理由,沿 ADR-001 §5.1 口径)

1. **本 ADR 评审清单(§8)14 项逐项裁决**(沿 ADR-001/002 门槛制:架构师默认立场先行落盘,维护者事后复核;复议需新 ADR);
2. **12 工具迁移面为零的书面确认**(本 ADR 已实测 grep = 0,§2.4;go 前复核一次并存档命令与输出);
3. **v0.66 任务 3 serve 真实服务观察反馈**:handler 实际消费载荷的形态(只取 method/path 做路由?echo?)——若观察显示投影税在真实用例不可承受,裁决缩小范围(如仅 body 字段标注)或推迟,不以本 ADR 默认值硬上;
4. **破坏窗口落位**:升 minor;与 serve v1.1 同版(先破坏后 additive)或紧随的 minor——不做孤立破坏版,不做并行入口与过渡警告期(沿 ADR-002 清单 4)。

### 7.4 v1.1 任务草案(仅当 §7.3 全勾)

1. checker:§7.1 六项(载体白名单 / 键控白名单表 / jsonMethod 投影 / serve 特例翻转 / mark_json / hint);
2. interp:mark_json;serve 擦除核验(handler 收值 = Json,§66 既有回环测试三引擎逐字);
3. 测试:新分节 12–18 条(§7.1 清单)+ §66 迁移全绿;
4. 文档:GUIDE 三节 + 修订记录 + capabilities 行 + plan 收口;
5. 验证门槛:`run.mjs` 全绿;`fuzz` 双种子 0 分歧;`proof_fuzz` 三模式 0 误报;四引擎对标注程序逐字一致;12 工具 `--check` 直通且行为逐字不变。

---

## 8. 评审清单(14 项)

| # | 决策点 | 本 ADR 立场 |
|---|--------|-------------|
| 1 | 接入面:改 serve 签名(A)/ serve_untrusted 变体(B)/ 出口标注(C) | **A**;B 违反一种结构一个语法(ADR-002 清单 4 同款否决);C 两难无第三态(§2.3) |
| 2 | 粒度:整树递归 / 一层 / 净值 | **整树递归**;(c) 有净化出口旁路,(b) 类型上不成立(§3.1);实现面整树更小(§3.1 末条) |
| 3 | 载体登记:泛型标注 `Untrusted[Json]` vs 别名 | **泛型标注**(载体集合 +1,复用 mkUntrusted);别名 = 新语言面,Ming 无此机制 |
| 4 | `Untrusted[Json]` 方法面(投影表)与 `mark_json` | **白名单投影表**(§3.2,表测试锁定,沿 ADR-002 清单 8 口径);**mark_json +1**(标脏入口非净化器,测试块与 unwrap_or fallback 需要;族扩展纪律只约束 sanitize 出口) |
| 5 | `stringify(Untrusted[Json])`:拒绝 vs 污进污出 stringify | **拒绝(M3049)**;污进污出变体(`stringify_untrusted`)列候选不预支(沿 ADR-002 清单 7 concat 纪律) |
| 6 | 响应方向:handler 返回 Json 不标 vs 标;回显位授权 | **不标**(响应是 Ming 产出,无威胁对应物);回显透传 M3049 免费拦截;**不做响应位授权** |
| 7 | 净化器族:v1.1 不扩 vs `sanitize_json` | **不扩**(§4.4 四条理由);投影 + v1 str 净化族即最小闭环;候选登记不预支 |
| 8 | `as_str` 投影返回 `Option[Untrusted[str]]` | **确认**(载体收窄保污,接 v1 str 全套面——白名单 5 方法 + sanitize 族,零新增净化出口) |
| 9 | 数值/布尔/谓词投影净值(as_num/as_bool/is_*/eq) | **确认**(污点在数值/布尔上终结,沿 ADR-002 白名单原则;as_num 即 f64,checker.js:4771 既有;eq 实参载体放宽为净或污均可) |
| 10 | fs/net/proc 内容源 str 污点是否随载体一并扩 | **不扩**(v1.1 单主题 = serve 载荷;内容源 v1.2 另裁决;json.parse 是接缝,GUIDE 双处登记边界) |
| 11 | 诊断码:零新增 vs 新码 | **零新增**(M3049/M3050 机制载体无关自动覆盖,hint 文本载体感知;新码须三处登记,不预支) |
| 12 | wasm/C 资格 | **零改动**(json 载体本就不在 numOk/C 面;解包路径沿 v0.61 compiler tryWasm 先例;`analyze()` 单一事实来源不裂化——ADR-002 清单 14 口径);实现期核验解包后拒绝行为逐字一致 |
| 13 | 与 serve v1.1(优雅停机)的关系 | **独立 go/no-go,可同版不绑定**;同版时先签名变更(破坏)后停机(additive) |
| 14 | 迁移窗口与口径 | **升 minor**;约 30 处机械迁移(§2.4 实测:examples/tools 0、tests §66 约 29 处、GUIDE 1 处);不做并行入口、不做过渡警告期;破坏窗口一次用完(时效论证:serve 用户面只会增长) |

---

## 9. 结论

**做——按"改 serve 签名(handler: fn(Untrusted[Json]) -> Json,升 minor)+ 整树递归标注(载体投影保污)+ 净化器族不扩(投影复用 v1 str 面)+ 零新增 M 码"推进;出口标注与 serve_untrusted 变体否决归档。实现走 go/no-go 条件承诺:§8 清单 14 项逐项裁决 + 工具迁移面为零书面确认 + v0.66 任务 3 serve 观察反馈 + 破坏窗口落位,四者全勾才进入实现(§7.4 草案);任一不勾,本 ADR 保持设计文档状态。**

否决归档,不再复议(复议需新 ADR):候选 B(serve_untrusted)、候选 C(出口标注)、净化器族 v1.1 扩(`sanitize_json`)、fs/net/proc 内容源随载体同版扩。

**一句话**:serve 载荷是 Ming 首个常驻网络面的第一扩面候选(S10 具名)——入口标注、整树递归、投影复用 v1 面、零新码,四条裁决把破坏面压到约 30 处机械迁移与约 130 行 checker 增量,而把"忘了校验请求输入"从 S10 的人工警告变成 M3049 编译错误;诚实清单(§5)五条窗口如实登记,其中两条(v1.2 接缝、内容级注入)是窄源纪律的延续而非本方案的缺口。
