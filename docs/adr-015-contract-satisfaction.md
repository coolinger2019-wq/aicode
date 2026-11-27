# ADR-015:契约满足性检查（S-5）——桩契约在调用点的静态满足性

> **状态**:**已裁决 go（架构师，2026-11-27）**——MVP = 调用点**字面量可判**的 requires 满足性检查（选项 b 的 b-lite 形态）;选项 c（桩 ensures 注入证明假设集）**否决于本批**（改变证明基座语义,须独立 ADR）;M3053 三处登记。前置 = §4.22.3 裁决 1（Tier-1 残项,无外部消费者门禁）。
> **来源**:docs/roadmap-infrastructure.md §5.2 交付物"Ming 能报告契约是否被满足"（签名一致性 v1.2.0 已交付;满足性为深半部）;docs/bridge-protocol.md（.mingi 契约桩格式）;§4.21.2 S-5 行。
> **关联**:bin/ming.js `check --stub`（M3052 消费侧）、src/bridge.js、docs/proof-protocol.md §7（证明只报告不改语义）、plan §4.20 P2 R-16/S-5。

---

## 1. 决策问题

`.mingi` 桩携带 `requires`/`ensures` 候选（v1.2.3 起另有效果/污点签名）。今天 `ming check --stub` 只核对**签名**（M3052）。"契约是否被满足"至少可指三件事：

1. extern 声明与桩的签名/载体一致性——**已交付**（M3052,含双侧载体等价）。
2. Ming **调用点**传入的实参是否满足桩的 requires（前置条件是否被调用方兑现）。
3. extern 的**返回值**是否满足桩的 ensures（后置条件）——静态不可判（无实现体）,只能运行时采样或信任。

本 ADR 裁决 MVP 只做 **2 的静态可判子集**;3 不承诺（见 §4）。

## 2. 选项与裁决

| 选项 | 语义 | 裁决 |
|---|---|---|
| **a. 仅一致性报告** | 把桩契约原样暴露在 stub_contract JSON（现状已有）,不做任何判定 | 不足（roadmap 字面"报告是否被满足"未兑现） |
| **b-lite（采纳）** | 对每个 Ming 调用点,**当实参全部为字面量**时机械求值桩 requires 的每条子句——违反 → **M3053[bridge-contract-violated]**（error）;无法判定 → 计为 unchecked（JSON 计数,不静默） | **✅ MVP** |
| b-full | 调用点 requires 经区间/bounds 传播证明（非字面量实参） | 不做（等价于新的过程间边界分析,预支证明扩面——R-21 同族风险） |
| **c. ensures 注入假设集** | 桩 ensures 作为调用结果假设进入后续证明 | **否决于本批**（未验证假设污染证明基座,须独立 ADR + 假设来源标注设计） |
| d. 运行时采样 | 运行时对调用结果断言 ensures | 不做（改变运行时语义,违反"证明只报告"；且 FFI 无桩执行环境） |

## 3. MVP 规格（实现合同）

1. **触发面**：`ming check <files> --stub <dir|file>` 且存在同名 extern fn 桩;对**每个 checked 模块内**指向该 extern 的 Call 节点（含 `use` 引入的模块）逐调用审查;同一调用点至多 1 条 M3053。
2. **可判条件**：桩 requires 的每一条子句形如 `x >= 0` / `n < len$buf` / `0 <= n <= 10`（v1.2.3 已文档化的候选文法）;求值要求**该子句全部操作数可赋值**——操作数为调用实参字面量（i64/f64/str/bool/Vec 字面量,含一元负号字面量）;`len$x` 仅当对应实参是**字面量 Vec**（**实现期修正,2026-11-27 审查 M4**：本 ADR 起草时假设"extern 实参不可能为 Vec 字面量"经实测**证伪**——`sz([1.0, 2.0])` 在 check 层可达;实现按本句规范支持该路径,`tests/run.mjs` v114.39/41 锁定,`docs/bridge-protocol.md` §7.2 同步）。实参含变量/表达式/调用的调用点 → unchecked。
3. **诊断**：违反 → **M3053[bridge-contract-violated]**（error;message 含子句原文、代入值、桩文件:行;span = 调用表达式;hint 指向 bridge-protocol 契约规则）;**三处登记**：src/diag.js CODES+CODE_HINTS、docs/diagnostics.md、tests。无法判定 → 不发诊断,仅在 `--json` 的 `stub_contract` 增 additive 计数（`contracts: {checked, violated, unchecked}`）。
4. **语义零变化**：不带 `--stub` 输出逐字节不变;M3052 行为不变;树/VM/wasm/cc 运行时零接触（纯 check 面）;M3053 不改变任何证明结论（它只报告调用点事实,与 requires 注入无关——**不把桩 requires 注入任何推导**）。
5. **确定性**：调用点按模块加载序 × 源码序;JSON 键序固定。

## 4. 明确不做（登记）

- **ensures 满足性**（静态/运行时均不做;选项 c/d 否决,重开设门：独立 ADR + 假设标注设计 + 用户显式开启）。
- 非字面量实参的证明（b-full,预支证明扩面）。
- 跨语言执行/TS 侧行为验证（无执行环境,信任边界如实）。
- 效果面满足性（效果是元数据,R-18 已登记语言无比较位）。

## 5. 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| 字面量覆盖极窄→"报告满足"叙事夸大 | 中 | JSON 计数强制暴露 checked/unchecked 比例;文档措辞"字面量可判子集";GUIDE 如实 |
| M3053 误报（桩子句解释偏差） | 中 | 求值器只认 v1.2.3 文档化文法;不可解析子句 → unchecked（绝不猜）;负例测试锁定"不可解析不报" |
| 调用点归属错误（遮蔽/use 重名） | 中 | 复用 checker 的真实解析结果做节点身份扫描（v0.64 嵌套 serve 两遍式先例）;测试覆盖 use 引入与同名遮蔽 |

## 6. 裁决请求（已裁决）

1. MVP = b-lite ✅ 2. M3053 命名/三处登记 ✅ 3. ensures/假设注入否决并设重开设门 ✅ 4. JSON 计数 additive ✅
