# 参考语言跟踪（Jenny / Blood）

> 本文件记录两门参考 AI 编程语言的**地址、核心信息与进度查看方式**，供随时对照。
> 最后更新：**2026-11-10**（快照见 §3）。

---

## 1. Jenny（Spinning Jenny）— AI 原生系统语言

### 地址

| 项 | URL |
|----|-----|
| 仓库 | https://github.com/Jenny-RSI/Jenny-lang |
| 中文介绍文章 | https://github.com/Jenny-RSI/Jenny-lang/blob/main/docs/zh/articles/introducing_spinning_jenny_zh.md |
| 技术论文（中） | https://github.com/Jenny-RSI/Jenny-lang/blob/main/docs/paper/spinning_jenny_paper_zh.md |
| 技术论文（英） | https://github.com/Jenny-RSI/Jenny-lang/blob/main/docs/paper/spinning_jenny_paper_en.md |
| 路线图 | https://github.com/Jenny-RSI/Jenny-lang/blob/main/ROADMAP.md |
| 设计总纲索引 | https://github.com/Jenny-RSI/Jenny-lang/blob/main/docs/design/specs/00_index_and_overview.md |

### 核心主张

- **双平面分离**：人类只写 `.jni` 文学化契约蓝图（Markdown + `jenny_decl` 霍尔契约 + `jenny_test`），AI 小模型写 `.jn` 实现；编译器做零信任裁判。
- **AI 友好语法**：无 `&T`/`<'a>` 生命周期传染；三态参数（默认只读借用 / `mut` / `own`）；三态存储（栈值 / 独占堆 / 托管句柄）。
- **效果与证明**：`mask [...]` 受控副作用阻断 + `QF_LIA` 边界证明器（漏写下界会给出数学反例）；错误 16 字节 ABI + 因果调用栈。
- **工程化**：`.jni` ABI 哈希防火墙（接口不变零重编）、亚秒级增量构建、`Spindle` 白盒包管理与契约 SemVer。
- **实证**：3B 本地模型 Zero-Shot + 390 token 语法卡，`Pass@1=50%`、`Heal@2=100%`；契约 Fuzzing 33,380 次 0 泄漏。

### 对 Ming 的落点

| Jenny 的思想 | Ming 的对应 |
|--------------|-------------|
| `E0905` 测试字面量过拟合检测 | **W3104**（v0.44，`ming check` 内置） |
| 结构化自愈处方（`--ai-json`） | **诊断 `fix` 字段**（v0.44，M2002/M3029/M3001 三类） |
| 错误码热力图驱动语言进化 | **tools/diaghot.ming**（v0.44，Ming 自写） |
| `mask [...]` 效果屏蔽 | **design.md §6.11 设计定稿**（实现待定） |
| 契约（requires/ensures/invariant） | **v0.45 计划**（见 docs/plan.md） |
| 单向因果友好五原则 | 已自然满足（无引用/无隐式 move/显式效果/机器诊断） |

### 不采纳

`.jni/.jn` 物理分离（与 Ming 单文件+test 块+模糊器路线冲突）、三态参数（动摇值语义简洁性）、borrow 默认。

---

## 2. Blood — 安全关键系统研究语言

### 地址

| 项 | URL |
|----|-----|
| 实际仓库 | https://github.com/jkindrix/blood |
| 规范 | https://github.com/jkindrix/blood/blob/main/docs/spec/SPECIFICATION.md |
| 内存模型 | https://github.com/jkindrix/blood/blob/main/docs/spec/MEMORY_MODEL.md |
| 设计空间审计 | https://github.com/jkindrix/blood/blob/main/docs/design/DESIGN_SPACE_AUDIT.md |
| AI 提案（含污点即效应） | https://github.com/jkindrix/blood/blob/main/docs/proposals/EXTRAORDINARY_FEATURES_II.md |
| AI 提案（含约束解码） | https://github.com/jkindrix/blood/blob/main/docs/proposals/EXTRAORDINARY_FEATURES_III.md |
| 已知限制 | https://github.com/jkindrix/blood/blob/main/docs/KNOWN_LIMITATIONS.md |
| 路线图 | https://github.com/jkindrix/blood/blob/main/docs/planning/ROADMAP.md |
| 官网（仅 "Soon" 占位） | https://blood-lang.org/ |
| 作者主页 | https://jkindrix.dev/ |

> 注意：文档中写的 `github.com/blood-lang/blood` 当前 404；有效仓库在作者个人名下 `jkindrix/blood`。

### 核心主张

- **可变值语义（MVS）+ 无 borrow checker**：赋值/传参复制值；用 **128 位代际指针**（地址 + generation + tier/linearity/type fingerprint）做"僵尸化陷阱"替代借用检查。
- **行多态代数效应**：`/ {IO, Error<E>}` 效果行；deep/shallow handler、`perform`/`resume`；线性值不得跨效果挂起点存活。
- **多重分派 + type stability**；内容寻址 AST（BLAKE3）+ 运行期热替换；C FFI 一等。
- **AI 提案（均为 Proposed，未实现）**：类型/效应约束的 token 解码、**污点即效应**（`UntrustedInput`）、WCET 分析、session types、proof-carrying code。

### 对 Ming 的落点

| Blood 的思想 | Ming 的对应 |
|--------------|-------------|
| MVS + 无 borrow checker | **对 Ming 值语义路线的独立背书**（两条路线同源 Hylo/Val） |
| 污点即效应 | **Backlog**（docs/plan.md §4，北星与 AI 协作的交点） |
| 代际引用替代借用检查 | 远期参考：`with unsafe` 的 Ptr 设计可借鉴 |
| 线性类型跨效应挂起点 | 远期参考（Ming 的 Join 句柄已是线性） |
| 内容寻址 AST | 远期参考：与 ABI 哈希构建缓存（v0.46 候选）同向 |

> 诚实提示：Blood 为单人维护、无 release/版本 tag，提案 ≠ 已交付；引用其设计时按"研究构想"而非"成熟实现"对待。

---

## 3. 进度快照（2026-11-10）

| 仓库 | stars | 最近推送 | 最新提交 | releases |
|------|-------|----------|----------|----------|
| `Jenny-RSI/Jenny-lang` | 2 | 2026-10-21 | `update compiler` | 0 |
| `jkindrix/blood` | 9 | 2026-09-16 | `feat(tools): health reports the last CI result` | 0 |

---

## 4. 如何随时查看进度

GitHub API（无需 token，限流 60 次/小时；本机代理不稳定时用 `HTTP_PROXY=` 直连）：

```bash
# 最近 5 条提交（Jenny）
HTTP_PROXY= HTTPS_PROXY= curl -s "https://api.github.com/repos/Jenny-RSI/Jenny-lang/commits?per_page=5" | grep -E '"date"|"message"' | head -12

# 最近 5 条提交（Blood）
HTTP_PROXY= HTTPS_PROXY= curl -s "https://api.github.com/repos/jkindrix/blood/commits?per_page=5" | grep -E '"date"|"message"' | head -12

# Atom feed（更稳，不限流）
HTTP_PROXY= HTTPS_PROXY= curl -sL "https://github.com/Jenny-RSI/Jenny-lang/commits/main.atom" | grep -E '<title>|<updated>' | head -12
HTTP_PROXY= HTTPS_PROXY= curl -sL "https://github.com/jkindrix/blood/commits/main.atom" | grep -E '<title>|<updated>' | head -12
```

要点：Jenny 的 `ROADMAP.md`（v0.1 → v0.2 → v0.3 → v0.4 → v1.0 自举）与 Blood 的 `docs/planning/ROADMAP.md` 是判断其阶段的第一入口；两者的 release/tag 均为空，进度以提交与文档为准。

---

## 5. 与 Ming 的关系定性

- 三者同处"**值语义（Hylo/Val 路线）+ 代数/行多态效应（Koka 路线）**"的思想谱系；Jenny 与 Blood 之间**无互相引用**（双方仓库全文检索 0 命中，2026-11-10 验证）。
- Ming 的差异化：单文件 + test 块 + 多后端差分 + 自举工具链，以**可验证的确定性**替代契约证明器的重工程（契约证明列为 v0.45/v0.46 逐步引入）。
