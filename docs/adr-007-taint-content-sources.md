# ADR-007:v1.2 内容源扩面——fs/net/proc 污点来源、两域接缝与污值代数

> **状态**:**已立项(维护者指示 2026-11-17)——架构师默认立场先行落盘(§3 清单 14 项),维护者逐项复核后进入实现**;实现版本号 = v0.77.0 候选(v0.76 留给第五崩面+fix 处方小批,一版一主题) · **日期**:2026-11-17 · **版本基线**:v0.75.0(HEAD d62c9c3,1173 项回归全绿)
> **立场声明**:本 ADR 是 v0.61 污点窄源 v1(ADR-002)与 v0.68 载体扩面(ADR-004)之后的第三块污点拼图,关闭自 v0.61 起如实登记的"fs/net/proc 内容源不标污"泄漏窗口。文中全部源码/计数引用为仓库现状实测(2026-11-17 grep,见 §4);无一处来自想象。
> **结论先行**:**做——按四个裁决收窄**:① **来源必污纪律一次到位**(fs.read_file / proc.exec stdout+stderr / net.http body 全部翻转签名,不留 clean 变体——v0.61 extern 先例);② **污值代数是本 ADR 的真正核心**(没有保污纯函数集,文件内容在语言里不可处理——自举工具 mingkit/edit/json_query/log_analyzer 将集体失能,实测证据 §4);③ **两域接缝用载体泛化闭合**(json.parse 按接收者载体分派:污 str → 污 Json,与 v0.68 投影表同机制,净 str → 净 Json 逐字不变);④ **净化器族继续不扩**(文本内容无机械净化定义——sanitize_json 四条理由全文适用;路径类已有 sanitize_cli_path 机械定义,照用)。
> **关联**:docs/adr-002-taint.md(污点采纳与窄源裁决)/ docs/adr-004-taint-json.md(载体白名单与投影表/净化器族不扩)/ docs/adr-005-eval.md(污点 sink——污内容永不动态执行)/ GUIDE §19(污点节)/ docs/capabilities.md 第 72 行(未覆盖项清单)/ docs/plan.md §4.11(立项登记)。

---

## 1. 背景与登记窗口

v0.61 窄源 v1 只标污了三个来源(env.get / io.read_line / extern 返回强制);v0.68 补上 serve 载荷。**fs.read_file / read_bytes / proc.exec stdout+stderr / net.http body 至今返回净值**——自 v0.61 起以"泄漏窗口如实登记"的口径写入 GUIDE 与 capabilities(第 72 行未覆盖清单),v0.69 审查 MAJOR-2 将表述收窄为:"标污外部输入(env/stdin/extern)永不动态执行;fs/net/proc 内容源 v1 不标 = 既有窗口"。

窗口的实际含义:攻击者影响的字节(磁盘上被篡改的配置、网络响应、进程输出)进入 Ming 程序后与程序自产字符串**类型不可区分**——M3049 sink 门禁(21 槽位)对它们全部失效。污点系统"来源必污 → sink 拒绝"的构造性保证只对已标污的一半世界成立。

json.parse 接缝(v0.68 登记"污进污出变体候选不预支")让窗口更立体:即便未来 fs 内容标污,`json.parse(污 str) → 净 Json` 仍会在两域边界洗白——除非 parse 本身载体感知。

## 2. 问题全景(crux 枚举——把问题考虑全面)

### 2.1 范围面:哪些源要翻转
fs.read_file(str)/fs.read_bytes(Vec[u8])/proc.exec(stdout+stderr,含 sync spawn)/net.http(body)四族;list_dir 条目(路径);io.read_line 与 env/extern 已污不动。**逐一裁决见 §3 清单 1–2/7–8。**

### 2.2 载体面:Vec[u8] 是第三个载体
载体白名单现值 {str, Json}(ADR-004)。read_bytes 返回 Vec[u8]——标污即引入 **Untrusted[Vec[u8]]** 第三载体。v0.68 的载体机制(载体键控分派)已泛化,机制上无障碍;操作面 = 既有白名单(byte_len/is_empty)在 Vec[u8] 上的对应物。**裁决见 §3 清单 3。**

### 2.3 污值代数(THE CRUX):没有保污纯函数集,内容处理在语言里不可能
v0.61 白名单 5 方法(parse_i64/parse_f64/char_len/byte_len/is_empty)只够"读个数/验路径"——**不够"处理文本"**。实测证据(§4):自举工具 mingkit(文件补丁需要 contains/index_of 定位唯一匹配)、edit(行级切片)、json_query(读文件→parse)、log_analyzer(split/逐行)全部依赖内容处理原语;wc 虽可用 char_len/byte_len,但逐行统计需要 split。**若代数不扩,这 11 个工具 23 个调用位在标污后集体失能**——保污代数不是锦上添花,是本 ADR 成立的先决条件。
设计原则:**纯函数保污**(效果系统已对"纯"有机械定义——无效果即纯;复用它,不发明新判定)。输出规则:str→str 纯函数输出保污;标量输出(i64/bool)净——与 parse_i64/char_len 先例一致(位置与计数不携带内容)。逐函数豁免表(若有)留实现期对照 std.str 实际清单裁决。**裁决见 §3 清单 4。**

### 2.4 两域接缝:json.parse 载体泛化
`json.parse` 按接收者实参载体分派:污 str → **Untrusted[Json]**(投影表 v0.68 全套消费面直接适用);净 str → 净 Json(既有 80 处测试调用位逐字不变)。与 json.stringify 拒绝污值(M3049)v0.68 裁决对称——**读侧污进污出、写侧整体出口闭合,两域接缝就此关闭**。机制先例 = v0.68 投影表"按接收者载体分派",checker 分派点 +1。**裁决见 §3 清单 5。**

### 2.5 出向透传:write 家族必须接受污值
write_file/append 的内容参数若保持 str-only,污内容无法写回文件——而"把读到的数据原样落盘"是存储不是边界穿越,拒绝它等于逼程序洗白(违 Sterile 原则)。需要新的参数类别:**出向透传位**(污值合法流入文件,机制 = 编译器参数槽载体感知多一类,21 sink 槽先例同源)。替代方案(另造 write_raw 变体)否决:API 不对称 + 诱导双份漂移。**裁决见 §3 清单 6。**

### 2.6 双向函数:proc.exec 一函数两向
cmd 参数是**命令注入 sink**(污值进 cmd → M3049,新槽位);stdout/stderr 是**source**(返回 Untrusted[str])。sync.spawn 同口径。一个函数同时加 sink 槽与翻转返回,是本 ADR 唯一双向点,测试要双向各锁。**裁决见 §3 清单 7。**

### 2.7 http_get:body 污、headers sink
响应 body → Untrusted[str](外部内容);请求 headers 参数加 sink 位(污值进 header = 头注入面);URL 保持净(由程序常量构造;若拼污值——拼接本身 M3049 洗白禁面已拦)。**裁决见 §3 清单 8。**

### 2.8 argv 载体:defer v1.3
`fn main(args: Vec[str])` 的 args 来自 OS——按来源纪律也应污。但签名翻转波及**每一个 main**,与本版 fs/net/proc 主题混在一起违反一版一主题。**defer v1.3,本 ADR 只登记不做**(清单 13)。

### 2.9 引擎面:v0.61 机制自动覆盖
wasm 资格(compiler tryWasm 顶层形参载体解包)/C 后端(mingTyNum/annoTarget 载体穿透)/eval 交互(M3049 sink——**污文件内容永不动态执行,eval 泄漏窗口就此机械关闭,零新码**)/cc 测试腿——全部走 v0.61 已验证机制,实现期只需回归核验,不需新机制。**清单 11。**

### 2.10 版本与变更政策
"v1.2"是路线阶段名非版本号;实现落 **v0.77.0 候选**(v0.76 = 第五崩面 + fix 处方小批)。源签名翻转是破坏性变更,一次到位不留 clean 变体;**既有断言"零校准"口径在此不适用**(v0.71 先例),逐条理由化 + 良性路径逐字节对比(v0.61 口径)。**清单 14。**

## 3. 评审清单(14 项——架构师默认立场,维护者逐项复核)

| # | 决策点 | 默认立场 | 理由/先例 |
|---|--------|---------|-----------|
| 1 | 范围:read_file/proc.stdout+stderr/http body 标污 | **做**——来源必污纪律一次到位,不留 clean 变体 | v0.61 extern 先例;窗口自 v0.61 登记在案 |
| 2 | list_dir 条目标污 | **做**——Vec[Untrusted[str]],路径类有机械净化器 sanitize_cli_path 直接适用 | v0.61 路径先例;find_files/tree/file_organizer 迁移面依赖它 |
| 3 | Untrusted[Vec[u8]] 第三载体 | **做**(read_bytes 标污)——载体机制 v0.68 已泛化;操作面 = byte_len/is_empty 白名单对应物 | read_bytes tools 使用为 0、tests 5 位——迁移面最小;纪律完整性优先 |
| 4 | **污值代数**(保污纯函数集) | **做,最小集先行**——规则:无效果 str 纯函数在污接收者上输出保污;标量输出净(位置/计数/布尔不携带内容,parse_i64/char_len 先例);逐函数豁免表实现期对照 std.str 清单裁决 | §2.3 实测证据:无代数则 11 工具 23 位集体失能;保污 ≠ 洗白,洗白禁面(M3050)不变 |
| 5 | json.parse 载体泛化 | **做**——污 str → Untrusted[Json];净 str 路径逐字不变 | v0.68 投影表机制;与 stringify 拒绝对称;接缝就此闭合 |
| 6 | write 家族出向透传 | **做**——新增"出向透传参数"类别(污值合法写盘);不造 write_raw 变体 | §2.5;21 sink 槽机制同源;存储非边界穿越 |
| 7 | proc.exec 双向 | **做**——cmd 加 M3049 sink 槽(命令注入);stdout/stderr 翻转 Untrusted[str];sync.spawn 同口径 | 唯一双向点,测试双向各锁 |
| 8 | http_get | **做**——body → Untrusted[str];headers 参数加 sink 位;URL 保持净 | 头注入面;URL 拼污已被 M3049 洗白禁面拦截 |
| 9 | env/stdin/extern | **不动**(已污) | v0.61 交付 |
| 10 | 净化器族 | **不扩**——文本内容无机械净化定义;路径类 sanitize_cli_path/sanitize_path 照用 | ADR-004 sanitize_json 四条理由全文适用;原则第三次兑现 |
| 11 | 引擎面 | **零新机制**——wasm tryWasm 解包/C mingTyNum/eval M3049 sink 全走 v0.61 已验证机制,回归核验即可 | §2.9;污内容永不动态执行窗口机械关闭 |
| 12 | assume_clean 逃逸舱 | **不做**——显式信任断言可审计但破坏"来源必污"构造性保证;处理能力由清单 4 代数承担 | v0.61"污点值无类型出口"纪律延续 |
| 13 | argv 载体 | **defer v1.3**(本 ADR 只登记) | main 签名翻转是独立迁移面;一版一主题 |
| 14 | 版本与变更政策 | 实现 = **v0.77.0 候选**;签名翻转一次到位;断言逐条理由化 + 良性路径逐字节(v0.61 口径) | §2.10;"v1.2"系路线阶段名 |

## 4. 迁移面实测(2026-11-17 grep,立项时点)

| 面 | read_file | read_bytes | read_line | list_dir | write_file | proc.exec | http_get | 小计 |
|----|-----------|------------|-----------|----------|------------|-----------|----------|------|
| tools/*.ming(11 文件) | 10 | 0 | 0 | 6 | 5 | 2 | 0 | **23** |
| tests/run.mjs | 5 | 5 | 10 | 4 | 7 | 0 | 1 | **32** |
| examples/*.ming | — | — | — | — | — | — | — | **3** |

- **工具影响分级**(实测文件清单):内容处理型(依赖清单 4 代数)——mingkit/edit/json_query/log_analyzer/wc;路径处理型(sanitize_cli_path 直接适用)——find_files/tree/file_organizer/batch_rename;出向型(清单 6)——write_file 5 位;进程型(清单 7)——proc.exec 2 位。
- **tests 迁移纪律**:32 源/汇位 + 80 处 json.parse(仅其中解析外部内容者受接缝影响,实现期逐一枚举);断言校准逐条理由化。
- **预估规模**:src ~200–300 行(源翻转 + 代数 + 载体泛化 + 出向透传机制)+ 迁移 ~60 位;**零新增 M 码**(M3049/M3050 复用;exec cmd 新 sink 槽走既有 M3049)。

## 5. 验收草案

- §79 新增 12–18 条:新源标污逐源/保污代数逐函数抽测/json 接缝双向/write 透传/exec 双向/引擎回落(M4016-M4017 族核验)/eval 污内容拒绝回归
- 全量回归绿;fuzz 双种子 0 分歧;proof_fuzz 0 误报
- **12 自举工具良性路径逐字节不变**(v0.61 口径——污点语义不影响未触 sink 的既有输出)
- GUIDE §19 污点节重写(来源全景表);capabilities 第 72 行未覆盖清单消项(argv 除外);README 路线图
- 独立审查 + 独立验证(git archive 纯净副本锚定,既有惯例)

## 6. 明确不做

argv 载体(v1.3)/Untrusted[u8] 原始字节载体之外的更多载体/净化器族扩张/assume_clean 逃逸舱/流敏感与跨函数污点推断(capabilities 远期登记)/污点形式化证明。

## 7. 维护者复核位

清单 14 项逐项勾选 + §4 迁移面数字复核 + 实现版本窗口(v0.77)确认。**复核通过即进入实现流水线**(三 subagent 并发 → 独立审查 → 独立验证 → 提交,既有惯例)。

## 8. 裁决记录(2026-11-17,维护者 goal 指令"持续完成所有任务不要我再次确认"——沿 ADR-005/006 模式:架构师默认立场先行落盘,维护者事后复核)

§3 清单 14 项**全部采纳默认立场**,逐项勾选如下(实现期义务见第 14 项;测试 §80 锁定):

| # | 决策点 | 裁决 | 裁决依据 |
|---|--------|------|---------|
| 1 | read_file/proc.stdout+stderr/http body 标污 | ✅ **做**——签名翻转,不留 clean 变体 | 来源必污纪律(v0.61 extern 先例);窗口自 v0.61 登记在案 |
| 2 | list_dir 条目标污 | ✅ **做**——Vec[Untrusted[str]] | 路径类有机械净化器 sanitize_cli_path(v0.61 先例) |
| 3 | Untrusted[Vec[u8]] 第三载体 | ✅ **做** | 载体机制 v0.68 已泛化;read_bytes tools 使用为 0、tests 5 位——迁移面最小 |
| 4 | 污值代数 | ✅ **做,最小集先行**——规则:无效果 str 纯函数在污接收者上输出保污(str→str 输出污;标量输出净,parse_i64/char_len 先例);逐函数豁免表实现期对照 std.str 清单裁决 | §2.3 实测:无代数则 11 工具 23 位集体失能;保污 ≠ 洗白(M3050 禁面不变) |
| 5 | json.parse 载体泛化 | ✅ **做**——污 str → Untrusted[Json];净路径逐字不变 | v0.68 投影表机制;与 stringify 拒绝对称 |
| 6 | write 家族出向透传 | ✅ **做**——新增出向透传参数类别 | §2.5;存储非边界穿越;不造 write_raw 变体 |
| 7 | proc.exec 双向 | ✅ **做**——cmd = M3049 sink 槽;stdout/stderr = Untrusted[str];sync.spawn 同口径 | 唯一双向点,测试双向各锁 |
| 8 | http_get | ✅ **做**——body → Untrusted[str];headers 加 sink 位;URL 保持净 | 头注入面;URL 拼污已被 M3049 洗白禁面拦截 |
| 9 | env/stdin/extern | ✅ **不动** | v0.61 交付 |
| 10 | 净化器族 | ✅ **不扩** | ADR-004 sanitize_json 四条理由第三次适用 |
| 11 | 引擎面 | ✅ **零新机制**——wasm/C/eval 全走 v0.61 已验证机制,回归核验即可 | 污内容永不动态执行窗口机械关闭 |
| 12 | assume_clean 逃逸舱 | ✅ **不做** | "来源必污"构造性保证;处理能力由清单 4 承担 |
| 13 | argv 载体 | ✅ **defer v1.3**(只登记) | main 签名翻转独立迁移面;一版一主题 |
| 14 | 版本与变更政策 | ✅ 实现 = **v0.77.0**;签名翻转一次到位;断言逐条理由化 + 良性路径逐字节(v0.61 口径) | §2.10;既有断言"零校准"口径不适用于签名翻转 |

**实现期义务核验**(进 tests §80):新源逐源标污断言/保污代数逐函数抽测/json 接缝双向/write 透传/exec 双向(含 cmd sink M3049)/引擎回落回归/eval 污内容拒绝回归/12 工具良性路径逐字节。

### 8.1 实现期裁决与微调(2026-11-17,实现 agent 提请、架构师裁决——ADR-005/006 微调先例同模式)

- **清单 6 面延伸——print/print_raw/eprint 出向透传**(实现期发现:echo 型工具 mingkit read/edit show/json_query show 的回显子命令在标污后无净出口——print 家族是 v0.61 注册 sink,而净化器族不扩、sanitize_cli_path 拒 C0,多行内容无出口)。裁决:**采纳出向透传**(方案 a)——stdout/stderr 是 CLI 工具的存储面,污值写出 = 存储非边界穿越(write_file 同判);非 assume_clean(语言内无净 str 出口,只是流出);debug() 维持 sink 拒绝(非存储面)。方案 b(回显子命令失能)违反"12 工具良性路径逐字节不变"验收;方案 c(专用回显出口)API 不对称。
- **微调 ①:`+` 拼接传播**(污+净→污)——v0.61 的 M3008 拦截面后移到消费 sink。理由:v0.61 禁它的前提是当时无传播(结果净 = 洗白);有传播后禁令理由消失,拦截移到唯一危险点(sink)。
- **微调 ②:净目标 += 污值 → M3049**——否则复合赋值是洗白旁路。
- **微调 ③:Untrusted[Vec[u8]] 接收者白名单 len/is_empty;bytes()/to_bytes() 输出 Untrusted[Vec[u8]]**——与 read_bytes 对称;re/bin/crypto 消费面维持净槽(M3049 实测)。
- **新增 std.str 函数:index_of(hay, needle) -> Option[i64]**(字符下标口径,含增补平面;双引擎逐字验证)——代数最小集实现载体(清单 4"逐函数豁免表实现期对照 std.str 清单裁决"范畴)。
