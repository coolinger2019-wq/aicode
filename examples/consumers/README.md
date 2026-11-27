# examples/consumers — 证明工件的第二语言消费示例

本目录演示**用另一门语言（Python 3，仅标准库、零依赖）**独立复核 Ming 的自产线性不可满足证书
（`ming check f.ming --proof-format cert`）。判据是**冻结面**：`docs/proof-protocol.md` §10.2 的
三条整数算术判据，第三方不需要 Ming、不需要 SMT 求解器、不需要网络即可复核。

面向外部消费者的完整说明见 **[docs/consuming-proof-artifacts.md](../../docs/consuming-proof-artifacts.md)**。

## 它是什么（以及不是什么）

- **是**：判据的**第二语言实现示例**——证明"判据自包含整数算术、数十行可复核"这一说法可以兑现。
  它不 import、不调用任何 Ming / Node 代码，只读两件纯文本工件（证书 + 可选 SMT-LIB 脚本）。
- **不是外部消费者**：本文件与 `verify_cert.py` 仍由 Ming 仓库自己维护。按 `docs/plan.md` §4.21.6
  的计数口径，**外部消费者 = 至少一个非仓库所有的项目/Agent 实际消费 Ming 输出**——本仓库自证不算。
  这份示例的作用是降低外部消费的摩擦，不替代那一次真实的外部消费。
- **不证明"程序正确"**：证书只证"该义务**按本协议编码后**的约束集在整数域不可满足"
  （`docs/proof-protocol.md` §10.7）。AST→约束的忠实性、运行时安全（`proven` 不消除 M4003 边界 panic）
  都不在证书检验面内。

## 与 `tests/cert_check.mjs` 的关系（独立性口径）

`tests/cert_check.mjs`（JS，仓库参考检查器）与本脚本做同一件事，但两者**互不调用**。如实说明：

- **刻意对齐面**：错误措辞、`文件节|vc/方向` 的 tag 形态、无证书原因清单——刻意与参考检查器保持接近，
  好让两边输出可逐条对照（这是**对齐**，不是独立性的证据）。
- **实质独立面**：语言与运行时（Python int vs BigInt）、S-表达式/命令行/正则解析全部另写、
  **仅自洽模式**（cert_check 没有）、**反向覆盖检查**（每个 SMT 方向块必须有证书方向节，cert_check 没有）、
  更严的结构校验（方向节位置、λ/序号/`identity` 形态）与独立的输入边界处理（编码、行尾、深嵌套、数字原子）。
- 两者都**不**证明编码忠实于源码；两者都是**本仓库自有代码**，不计入外部消费者。

## 快速上手

需要 Python 3（实测环境：Python 3.10.11 / Windows 11；代码只用 `re`/`sys` 与 `%` 格式化，
没有版本特有语法，但**未在其它版本实测**）。

**输出编码**：脚本启动即把 stdout/stderr 固定为 UTF-8，因此 `PYTHONIOENCODING=cp1252`/`ascii`/`gbk`
等环境下同样 exit 0 且输出字节一致（非 UTF-8 终端可能把中文显示成转义/乱码，但不会失败）；
读入按 UTF-8 解码，CRLF / 孤立 CR 行尾归一为 LF（Windows 编辑器改过的证书可直接读）。

```bash
# ① 仅自洽模式：只给证书（无 SMT 脚本）
python examples/consumers/verify_cert.py tests/cert_fixtures/proven.cert
```

预期输出（节选）：

```
模式:仅自洽——只校验证书声明行的内部恒等式;系数篡改与引用序号越界(块外引用)无法发现

[文件:proven.ming]
  vc:get:1 — 索引 i(scope: body)
    low: proven(2 引用, uses_goal)
    high: proven(2 引用, uses_goal)

汇总:义务 1 · 方向 2 · 证书方向 2 · 具名无证书 0 · 引用 4 · 恒等式 2
结论:通过 — 仅自洽,未与脚本对照(成立的是"证书自述恒等式自洽",不是"编码后的约束集不可满足")
```

```bash
# ② 对照模式：证书 + 同一份输入的 SMT-LIB 脚本（推荐——这才检验系数）
#    仓内**直接可配对**的只有两组（同一语料、逐字节同源）：
#      tests/cert_fixtures/proven.cert  + tests/proof_fixtures/proven.smt2
#      tests/cert_fixtures/loop.cert    + tests/proof_fixtures/loop.smt2
python examples/consumers/verify_cert.py tests/cert_fixtures/proven.cert --smt tests/proof_fixtures/proven.smt2
#    其余五个证书（vacuous/const/eqsplit/chain/multifile）没有仓内配对脚本，须自己生成：
ming check f.ming --proof-format cert      > f.cert
ming check f.ming --proof-format smt-lib   > f.smt2
python examples/consumers/verify_cert.py f.cert --smt f.smt2
```

> **配对陷阱（实测红，务必看）**：`tests/proof_fixtures/multifile.smt2` 与
> `tests/cert_fixtures/multifile.cert` **不是同一语料**——前者是 `multifile-a/b.ming`（`vc:pick:1`），
> 后者是 `a/b.ming`（`vc:get:1`）。硬配会因"找不到对应方向块/块在证书里没有对应方向节"而 exit 1，
> **那是配对错，不是证书错**。任何跨来源配对都必须确认语料同源（同一份 `.ming` 输入、同一工具版本）。

预期输出（节选）：

```
模式:对照——按 §10.3 从 SMT 断言重算归一与 Σλc/ΣλK;不信任证书声明的系数

[文件:proven.ming]
  vc:get:1 — 索引 i(scope: body)
    low: proven(2 引用, uses_goal)
    high: proven(2 引用, uses_goal)

汇总:义务 1 · 方向 2 · 证书方向 2 · 具名无证书 0 · 引用 4 · 恒等式 2
结论:通过 — 对照模式:引用系数、归一值、恒等式均由 SMT 脚本独立重算
```

**退出码**：`0` = 通过；`1` = 任一判据/结构失败、输入不可读、用法错误（错误逐条具名走 stderr）。

**两模式的区别（重要）**：

| | 仅自洽（无 `--smt`） | 对照（`--smt <脚本>`） |
|---|---|---|
| 逐变量恒等式 `Σλc = 0` | ✅ 按证书**声明**的行重算 | ✅ 按 SMT 断言**重算归一后**的行 |
| `ΣλK < 0` | ✅ | ✅ |
| 系数是否被篡改 | 🟡 单点篡改通常会被 `Σλc` **间接**拦下；**保持恒等式的伪造可静默通过** | ✅ 声明 vs 重算逐项对照 |
| 引用序号 ↔ 断言 | 🟡 只查形状（连续性/升序/λ）；序号是否落在块内、指向哪条断言**都无法核** | ✅ 断言序号界内 + 逐条重算对应 |
| `uses_goal` 机械核验 | ❌ | ✅（引用了块内末条断言 ⟺ 取反目标被用到） |
| `verdict` 与 SMT 块注释一致 | ❌ | ✅ |

`λ` 是**正整数**（≥1）字段：格式允许多重引用，判据 §10.2 的 ℕ 包含 0 以上，但生产者**恒为 1**
（负环是简单环；协议 §10.2 末段），本验证器按"≥1"校验并如实标注。

`tests/cert_fixtures/` 的七个证书（`proven` / `loop` / `vacuous` / `const` / `eqsplit` / `chain` /
`multifile`）在两模式下**全部通过**；`tests/cert_check.mjs` 的三负例（篡改系数 / 漏引用 /
块外引用）在对照模式下**全部被拒**——其中"块外引用"若仍保持引用序号升序（如把末条引用改成 `#999`），
在仅自洽模式下会**静默通过**；这正是必须拿 SMT 脚本对照的理由。

## 实现规模（诚实）

- 判据核心（§10.3 归一 + §10.2 两条求和）≈ 90 行非空行（含注释与错误措辞）；
  整个工具 ≈ 825 行——多出的部分是严格结构校验（文件节/义务节/方向节/引用行文法）、
  两模式、逐条具名错误、输入边界处理（编码/行尾/深嵌套/数字原子）与帮助文本。
- 只用 `re` / `sys` 两个标准库模块；没有 `__pycache__` 入库，没有临时文件。
- 输出确定性：同一输入恒产出逐字节相同的文本（无时间戳/无随机序）；输出恒 UTF-8。
- 输入边界（实测）：任意 `PYTHONIOENCODING` 不崩；CRLF / 孤立 CR 行尾可读；
  S-表达式嵌套 >120 层 → 具名失败（不栈溢出）；非 ASCII 数字原子按符号处理（不抛 `ValueError`）；
  `--smt` 重复给出 → 具名拒绝（不静默取最后一个）。

## 解析严格性的边界（登记，不影响健全性）

本脚本**不**复刻 §10.1 的全部结构约束，以下情况会被容忍（都不会让错误证书变成"通过"，
但会让"格式不合格"的输入不被点名）：

- 非 `proven` 方向若多带 `uses_goal`/`vacuous`/`refs: <n>` 行，只要没有任何 `; ref` 行且
  "无证书"原因已登记即可通过（多余字段不被点名）；
- 证书里同时出现 `; 无证明义务` 与真实义务节（本工具只置标记，不判矛盾）；
- SMT 块内不强制"至少一条 `(declare-const)`"或"恰好一条 `(check-sat)`"，也不校验 declare 先于 assert
  （这些是 §3.1 不变式，属**生产者**的黄金/结构测试面，`tests/z3_check.mjs` 与 §113 已锁定）；
- 文件节的路径正确性不核（只作配对键）；`vacuous` 不重算（无独立来源）。

## 用法

```
python examples/consumers/verify_cert.py <证书> [--smt <smt-lib 脚本>]
python examples/consumers/verify_cert.py --help
```
