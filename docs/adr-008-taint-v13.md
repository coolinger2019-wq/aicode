# ADR-008:污点 v1.3 窗口——argv 载体与响应头/metadata 扩面

> **状态**:**已立项并裁决(维护者指示 2026-11-17"先裁决 v0.82 污点窗口(argv/响应头)")——架构师默认立场先行落盘(§3 清单 12 项),维护者事后复核(ADR-004/005/006/007 同款模式)** · **日期**:2026-11-17 · **版本基线**:v0.79.0(HEAD 4304427,1260 项回归全绿)
> **立场声明**:本 ADR 关闭 v0.77 遗留的三项登记缺口(argv 载体 defer v1.3、http 响应头净源、fs.metadata 净源——ADR-007 审查 M2/§8.1 在案)。全部迁移面引用为仓库现状实测(2026-11-17 grep,见 §4);无一处来自想象。
> **结论先行**:**做——按四个裁决收窄**:① **argv 载体 = `Vec[Untrusted[str]]`**(元素级,与 list_dir 先例同构;main 签名一次翻转,12 工具 4 测试位迁移);② **响应头载体 = `Untrusted[Map[str,str]]` 第四载体**(键值同污——头名同样由对端控制,键净值污方案否决,理由见 §2.2);③ **fs.metadata → `Untrusted[Json]`**(Json 载体已存在,零新载体);④ **v0.82.0 一次窗口到期,不留 clean 旁路**(v0.61/v0.77 纪律)。
> **关联**:docs/adr-002-taint.md(窄源)/ docs/adr-004-taint-json.md(载体白名单与投影表先例)/ docs/adr-007-taint-content-sources.md(§8.1 argv defer 与 M2 登记)/ GUIDE §18 §19(污点节)/ docs/plan.md §4.12(第十轮规划)/ src/checker.js(载体白名单/投影表/签名表)。

---

## 1. 背景与登记窗口

v0.77 内容源扩面关闭了 fs/net/proc 的**内容**来源,但三项**元数据/参数**来源按裁决保持净并如实登记:

1. **argv**(`fn main(args: Vec[str])`):OS 提供的进程参数——与 env(stdin 同批已污)同属"调用方控制的外部输入",却类型上净。v0.61 起 arg 侧无门禁,工具靠 env fallback 侧的 sanitize_cli_path 兜底(且仅 env 路径)。
2. **http 响应头**(`http_request_opts` 返回三元组第二元 `Map[str,str]`):对端服务器完全控制头名与头值,类型上净——ADR-007 审查 M2 明确登记("翻转是更大迁移面,建议登记后按族扩展纪律另裁")。
3. **fs.metadata**(返回 `Result[Json, str]`):含路径/大小/时间等外部状态,身份等同内容源——ADR-007 审查 n2 登记。

## 2. 问题全景(crux 枚举)

### 2.1 argv 载体形态:元素级 vs 整容器
两案:(a) `Vec[Untrusted[str]]`——元素级,与 list_dir(清单 2,v0.77)同构,消费面 = 逐元素 sanitize_cli_path/代数;(b) `Untrusted[Vec[str]]`——整容器,需载体内操作面(索引/迭代)全保污化。
**裁决 (a)**:list_dir 先例直接套用;元素级让"路径 = 可机械净化"的既有分工成立(sanitize_cli_path 收 Untrusted[str] 产 clean str);(b) 让 Vec 的整个方法面都需污化包装,收益为零。

### 2.2 响应头载体形态:键净还是键污(核心裁决)
- 方案 a) `Map[str, Untrusted[str]]`:键净、值污。**最小载体变化**(无第四载体),但**头名(键)仍是净 str**——`headers.keys()` 直接产出攻击者可影响的内容,是登记在案的洗白通道;违背"来源必污"纪律。
- 方案 b) `Untrusted[Map[str,str]]`:**第四载体**,键值同污。投影表最小集:len/is_empty(clean)、get(净 str 键)→Option[Untrusted[str]]、contains_key(净 str)→bool(clean)、keys()→Vec[Untrusted[str]]、values()→Vec[Untrusted[str]];**mut 面(set/remove)M3050 排除**(v1.3 只读——污容器源自外部,不可变语义)。机制v0.68/v0.77 已泛化(载体白名单 {str,Json,Vec[u8]} 扩入 Map;投影表按载体分派)。
**裁决 (b)**:键名是攻击者可控内容,"键净值污"把洗白通道留给最常用的 `.keys()`;载体扩面的成本一次性(v0.61 Untrusted[str] → v0.68 Json → v0.77 Vec[u8] → 本版 Map,白名单演化第四次),而将错留键面的修复成本永久。**否决 a) 并归档**(复议需新 ADR)。

### 2.3 Untrusted[Map] 的 mut 面
污来源 Map 是外部快照(与 Untrusted[str] 不可逆同构)——set/remove 会给"污容器可变"引入别名/时序语义(值语义深拷贝下污点分裂面)。**v1.3 只读**:mut 方法 → M3050(白名单外);若将来需要可变污容器,另裁。

### 2.4 main 签名翻转的波及面
每个带 args 的 main 都要改标注(实测 16 位,§4)。**不留 wrap**:参数来自 OS 是恒真事实,wrap 只是把同一事实包一层(type-papering);工具要路径就 sanitize_cli_path(机械定义在案,v0.61 十二工具迁移先例)。REPL/test 模式无参 = 空 `Vec[Untrusted[str]]`。

### 2.5 fs.metadata
`Result[Untrusted[Json], str]`——Json 载体 v0.68 已存在,投影表(as_str/as_num/is_*/get...)直接适用;零新载体、零新机制。metadata 的消费面实测为 0(tests),迁移面近零。

### 2.6 引擎面(v0.61 机制自动覆盖,核验项)
wasm 资格:compiler tryWasm 顶层形参载体解包——`Vec[Untrusted[str]]` 形参(v0.61 已支持容器载体形参);`Untrusted[Map]` 形参解包需核验(第四载体穿透)。C 后端:mingTyNum/annoTarget 载体穿透核验(Untrusted[Map] 在 cc 的擦除表示)。均零新机制,实现期回归核验。

### 2.7 管线交互(实现期义务核验)
- **serve worker 管线**(v0.62 syncWorkerCode):worker 以源码重建编译单元,其 main 若有 args 从何处取——核验 worker 不传真实 argv(空参)或传服务端构造值(净);若传则需明确 taint 立场。
- **spawn/spawn_all/sync**:主进程传入的是 Ming 值 `Vec[str]`(净、程序构造),worker argv 侧同理核验。
- **tools AOT 缓存**:spawn 排除不变(eval/unsafe/sync 先例),无交互。
- **REPL/test**:空参。

### 2.8 窗口政策
v0.82.0 一次到位:破坏性 minor(签名翻转 ×3 族),不留 clean 变体/不设过渡版本;断言逐条理由化 + 良性路径逐字节(v0.61/v0.77 口径——本窗口迁移面小,工具冒烟逐字节应全保持)。

## 3. 评审清单(12 项——架构师默认立场,维护者逐项复核)

| # | 决策点 | 默认立场 | 理由/先例 |
|---|--------|---------|-----------|
| 1 | argv 载体 | **`Vec[Untrusted[str]]`**(元素级) | list_dir 清单 2 先例;逐元素可机械净化 |
| 2 | main 签名翻转 | **做**,一次到位,16 位实测 | §2.4;无 wrap |
| 3 | argv 消费面 | 逐元素 sanitize_cli_path(机械定义在案)/代数面直接可用 | v0.61 十二工具 env 迁移同款惯用法 |
| 4 | **响应头载体** | **`Untrusted[Map[str,str]]` 第四载体**(键值同污);方案 a(Map[str,Untrusted[str]])**否决归档** | §2.2:键名攻击者可控,`.keys()` 洗白通道不可留 |
| 5 | Untrusted[Map] 投影表 | len/is_empty clean;get(净键)→Option[Untrusted[str]];contains_key(净键)→bool;keys/values→Vec[Untrusted[str]];**mut 面 M3050(只读 v1.3)** | §2.2/§2.3;投影表 v0.68 机制 |
| 6 | fs.metadata | **`Result[Untrusted[Json], str]`**(零新载体) | Json 载体已存在;消费面实测 0 |
| 7 | 引擎面 | **零新机制**——wasm 容器载体形参解包(v0.61)/cc 载体穿透,实现期核验 | §2.6 |
| 8 | 管线交互 | serve worker/spawn argv 来源核验(§2.7 义务清单);REPL/test 空参不变 | v0.62 管线先例 |
| 9 | 窗口与迁移 | **v0.82.0 一次到位不留旁路**;断言逐条理由化 + 良性路径逐字节 | v0.61/v0.77 口径 |
| 10 | 不做 | clean argv 旁路 / 键级混合载体(`Map[Untrusted[str],T]` 不支持——键污只经整表载体表达)/ Untrusted[Map] mut 透传 / headers 多值合并语义变更(Node 语义照旧) | 纪律与最小面 |
| 11 | 规模预估 | src ~80–120 行(载体白名单+投影表+三族签名翻转)+ 迁移 ~20 位 + §83 8–12 条 | 规划口径非承诺 |
| 12 | 测试与文档义务 | §83:逐载体标污/投影表面/json 接缝回归/引擎回落/REPL·test 空参/serve·spawn 管线核验;GUIDE §18/§19 来源全景表更新 + capabilities 消项(argv/响应头/metadata 移出未覆盖清单) | 三件套纪律 |

## 4. 迁移面实测(2026-11-17 grep,立项时点)

| 面 | 实测 | 备注 |
|----|------|------|
| `fn main(args:` 签名位 | **16 位**(tools 12/12 + tests/run.mjs 4 + examples 0) | 全部 main(args) 工具:todo_scan/edit/log_analyzer/batch_rename/mingkit/diaghot/find_files/engdiff/tree/json_query/file_organizer/wc |
| http 响应头消费位 | tests 3 处 `http_request_opts` + 请求侧 headers 位若干(26 处 headers 相关行含请求侧) | 实现期逐一枚举消费形态(元组解构/取第二元) |
| fs.metadata 消费位 | **0**(tests/run.mjs) | 迁移面近零 |
| 引擎面 | wasm/cc 零改动预期(v0.61 机制) | 实现期核验 |

## 5. 验收草案

- §83 新增 8–12 条:argv 逐元素标污(for-in 元素类型)/main 签名正例负例/响应头投影表逐方法(含 keys 污)/metadata 载体/wasm 形参回落核验/REPL·test 空参/serve·spawn 管线核验;既有污点回归(§65/§66/§71/§80)零校准或逐条理由化
- 12 工具良性路径冒烟逐字节(参数解析侧全覆盖——args 全走 sanitize_cli_path 后行为与迁移前一致)
- 全量回归绿;fuzz 双种子 0 分歧;proof_fuzz 0 误报;独立审查 + 独立验证(git archive 锚定,既有惯例)
- 文档:GUIDE §18/§19 来源全景表(9 源 → 11 源:argv/响应头上屏,metadata 入内容源)+ capabilities 第 72 行消项 + README/plan/AGENTS 登记

## 6. 明确不做

clean argv 旁路 / 键级混合载体 / Untrusted[Map] mut 透传 / headers 多值合并语义变更 / 流敏感或跨函数推断(远期 capabilities 清单)/ argv 之外的更多 OS 元数据面(如 cwd/env 全量——按需另裁)。

## 7. 维护者复核位

清单 12 项逐项勾选 + §4 迁移面数字复核 + 窗口版本(v0.82.0)确认。复核通过即进入实现流水线(三 subagent 并发 → 独立审查 → 独立验证 → 提交,既有惯例)。
