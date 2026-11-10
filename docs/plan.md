# Ming 实施计划（v0.45 起）

> 本文件是唯一的计划落盘位置。已完成项在版本提交后移到「已完成」；新想法先进「Backlog」，
> 只有进入版本范围才细化到任务级。当前版本：**v0.45.0**（契约系统阶段 1：requires/ensures 运行时检查已落地，树/VM/C-wasm 资格对齐；invariant 语法/类型检查进行中；测试 428+ 全绿）。

---

## 0. 当前状态

| 项 | 状态 |
|----|------|
| 语言内核 | 显式类型/效果系统/值语义/确定性；树+VM+wasm+C 四后端 |
| C 后端 | C1 数值 → C2 str/Vec[i64] → C3 Map/Option/f64 打印；`extern fn` FFI（dlopen/dlsym）、`--static` |
| 构建 | `ming build` 真 AOT 字节码产物（无明文源）；`--with-source`；spawn/trait 自动回退 |
| 自举工具 | mingkit（文件补丁）/ engdiff（引擎差分）/ diaghot（诊断热力图），全部 Ming 自写 |
| 质量护栏 | 422 项回归 + 多后端差分模糊（四腿）+ bench（cc 腿） |
| 能力矩阵 | 49 行口径 ≈82%（docs/capabilities.md） |

## 1. 已完成的规划项（v0.39–v0.44）

- v0.39 C 后端 C1 + wasm 层四项休眠 bug 修复 + ffi 设计
- v0.40 C2（str/Vec）+ engdiff 自举工具 + 模糊器 cc 族
- v0.41 C3（Map/Option/f64 打印）+ cc 差分腿全形态
- v0.42 `with ffi` 兑现（extern fn + 效果门禁 + M4013）+ `--static`
- v0.43 ffi 字符串桥 + Result 进 C 面 + 真 AOT 字节码产物 + `with unsafe` 设计
- v0.44 W3104 过拟合检查 + 结构化修复处方（fix）+ diaghot + `mask` 设计定稿；
  连带修复 unify 缺 json 分支、VM match-return 栈残留

---

## 2. v0.45 — 契约系统阶段 1（requires / ensures / invariant，运行时检查）

**目标**：把"安全是默认"从运行时 panic 前移到**签名里的可检查契约**；为阶段 2 的静态证明打语法与语义基础。

**设计要点（Ming 风格）**

- 语法：
  - `fn f(a: i64) -> i64 requires a > 0 else "a 必须为正" { ... }`
  - `fn f(a: i64) -> i64 ensures result >= a else "结果不小于输入" { ... }`（`result` 在 ensures 中绑定返回值）
  - `struct S { x: i64, invariant x >= 0 }`（构造后与 `mut self` 方法返回后检查）
- 语义：
  - 契约表达式必须是**纯表达式**（无效果；checker 用现有效果机制禁止 io/fs/... 调用）；
  - 违反契约 → **panic 新码 M4015[contract-violation]**，消息含条件文本与操作数值（与 M4002 风格一致），退出码 101；
  - 检查时机：requires 在函数入口；ensures 在每个 `return` 前（含尾表达式返回值）；invariant 在构造字面量与 `mut self` 方法退出时；
  - 契约不改变求值语义，只增加检查点。
- 边界（v1 不做）：不写静态证明（阶段 2）；不写跨函数契约推导；不写 panic 恢复。

**任务拆分**

1. `src/parser.js`：`requires`/`ensures` 子句 + struct `invariant` 解析（保留字升级注意：`requires`/`ensures`/`invariant` 目前是否保留字需查 `RESERVED`）。
2. `src/checker.js`：契约表达式类型检查（bool、纯）+ 错误定位；`result` 绑定仅在 ensures 作用域。
3. `src/compiler.js` + `src/interp.js`/`src/vm.js`：入口/返回/构造检查点发射与执行（双引擎一致）。
4. `src/diag.js` + `docs/diagnostics.md`：M4015 登记（消息格式：`契约违反: <条件> (实际: <绑定值>)`）。
5. `tests/run.mjs` §40：正例（满足契约）、反例（M4015 消息/退出码/双引擎一致）、纯性检查（契约内调 print → M3029 类错误）、`result` 绑定。
6. 文档：GUIDE 语法节 + 修订记录 v0.45.0；README 路线图。

**验收**：契约程序在三引擎（tree/VM/wasm 不适用则双引擎）行为一致；M4015 逐字稳定；套件全绿。

---

## 3. v0.46 — 二选一（按实测收益决定）

### 3a. 契约阶段 2：QF_LIA 边界证明子集
- 对 `requires offset >= 0 && offset + 4 <= buf.len` 形态的**线性整数算术**做编译期证明，
  证明成立时允许块内免检访问（配合未来 `with unsafe`）；证伪时给出**具体反例**（Jenny 风格）。
- 交付：`src/prover.js`（限定子集）+ 新诊断码（证明失败/未证明）+ 示例 + 测试。
- 风险：证明器工程量大；先做 1-2 个模式（越界包含、非负性），不做通用求解。

### 3b. 构建缓存：接口哈希 ABI 防火墙
- `ming build` 按**接口哈希**（签名/效果/契约的规范化哈希）跳过未变模块；
  内容寻址缓存（函数级 AST 哈希）与 AOT 产物结合（另一窗口的 `src/artifact.js` 已具备基础）。
- 交付：`ming build` 增量缓存 + `--clean-cache` + 哈希稳定性测试（改实现不改接口 → 命中）。
- 收益：CI 与 AI 自愈循环的速度。

---

## 4. Backlog（不进本两版）

| 项 | 说明 | 前置 |
|----|------|------|
| `mask [效果] { ... }` 实现 | 效果屏蔽（design.md §6.11 已定稿）：效果承载值不逃逸 | v0.45 契约/逃逸分析基础 |
| `with unsafe` 实现 | `Ptr[mut u8]` 块、load/store/offset（design.md §6.10 已定稿） | 逃逸分析；与 mask 同批 |
| 污点即效应（Blood 提案 9） | `untrusted` 效果：无此效果函数不可能消费未净化数据 | 效果系统扩展评审 |
| ffi 面扩大 | 结构体/数组参数、Ptr 返回、`lib.fn` 运行时 API | C2/C3 面稳定 |
| 约束解码生成模式 | 语法/类型/效果约束的 LLM token mask（工具侧） | 工具链协议 |
| 内容寻址代码 | Unison/Blood 风格定义哈希（热替换、可复现构建） | 3b 哈希基建 |
| str for-in / trim 族 C 后端 | C 面继续对齐解释引擎 | C3.5 |
| 泛型单态化缓存 | 开发态字典多态 / 发布态单态化（Jenny 思路） | 性能数据 |

---

## 5. 过程纪律（所有版本适用）

1. 每个版本：实现 + `tests/run.mjs` 分节测试 + 模糊抽查（0 分歧）+ 文档三条（GUIDE 修订记录 / README 路线图 / 诊断·能力矩阵按需）+ 版本三处同步 + 提交。
2. 发现既有 bug：先最小复现 → 回归测试 → 修复 → 记录在修订记录（不静默修）。
3. 自举优先：能用 Ming 写的工具不写别处；工具使用中发现的 bug 与语言 bug 同等对待。
4. 只承诺测过的：任何性能/覆盖率数字必须来自可复现的命令。
