# Ming 实施计划（v0.45 起）

> 本文件是唯一的计划落盘位置。已完成项在版本提交后移到「已完成」；新想法先进「Backlog」，
> 只有进入版本范围才细化到任务级。当前版本：**v0.51.4**（检查器小缺陷；C 后端 UB 修复；构建可信性；契约纯性 + ensures 全路径；效果门禁函数值闭合；wasm 比较操作码修复；自举工具统一入口 ming tools；ABI 哈希构建缓存 + GCM 最小帧修复已交付；契约阶段 2 + QF_LIA 第一片 M3042 已完成；测试 527 项全绿）。

---

## 0. 当前状态

| 项 | 状态 |
|----|------|
| 语言内核 | 显式类型/效果系统/值语义/确定性；树+VM+wasm+C 四后端 |
| C 后端 | C1 数值 → C2 str/Vec[i64] → C3 Map/Option/f64 打印 → C4 extern fn FFI（dlopen/dlsym）、`--static` |
| 构建 | `ming build` 真 AOT 字节码产物（无明文源）；`--with-source`；spawn/trait 自动回退；**v0.49 内容寻址缓存 + 接口哈希报告 + `--clean-cache`** |
| 自举工具 | mingkit（文件补丁）/ engdiff（引擎差分）/ diaghot（诊断热力图），全部 Ming 自写 |
| 质量护栏 | 471 项回归 + 多后端差分模糊（四腿）+ bench（cc 腿） |
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

## 3. v0.46 — 契约阶段 2 第一片（已完成，2026-11-11）

- **M3040 invariant 字段封装**：带 invariant 的 struct，字段只能在自身 impl 方法内修改（外部字段写 → 编译错误；通过 implTypeName 比对放行）。无 impl 的 invariant struct 字段构造后即封装。
- **M3041 调用点静态契约校验**：全部实参为整数字面量时，代入 requires 求值（线性子集：IntLit/Ident/一元 - !/+-*/%/比较/&& || 短路；除零与 i64 溢出放弃判定）；可判定为假 → 编译错误 M3041 + 反例（`amount = -5`）与 else 消息。字面量违反从运行时 M4015 前移到编译期。
- **P0 修复**：invariant struct + 缺 for 的 impl → 解析恢复把 `fn (mut self)` 注册为顶层函数（裸 self type=null）→ 检查器崩溃；修复 = resolveSigs 标记 poisoned + checkBodies/compiler 跳过。

## 4. v0.47 — 契约阶段 2 完成（2026-11-11）✅

### 4a. 契约阶段 2 剩余
- **mut 方法退出时的 invariant 重查**：✅ 已完成（v0.47）——实现取派发点重查方案（callMethod struct 分支，mut-self 方法返回后以接收者字段重查；比合成隐藏函数更简单且树/VM 共用同一份代码）。
- **QF_LIA 边界证明子集**：对 `requires offset >= 0 && offset + 4 <= buf.len` 形态的线性整数算术做编译期证明，
  证明成立时允许块内免检访问（配合未来 `with unsafe`）；证伪时给出**具体反例**（Jenny 风格）。
- 交付：`src/prover.js`（限定子集）+ 新诊断码（证明失败/未证明）+ 示例 + 测试。
- 风险：证明器工程量大；先做 1-2 个模式（越界包含、非负性），不做通用求解。
- 前置：M4015/M3040/M3041 已落地（v0.45/v0.46）。

### 4b. 构建缓存：接口哈希 ABI 防火墙（✅ v0.49 已交付，2026-11-11）
- 交付（v0.49）：`ming build` 内容寻址缓存——键 = 编译器版本 + 项目全部 .ming 源 + ming.toml + `--with-source`（过包含保健全）；命中且 dist 完整 → 跳过检查与编译。
- 接口哈希：每模块 decl 规范化序列化（签名/参数名/效果/requires/ensures/字段/invariant/变体/trait 方法/impl；排除函数体与 span），sha256 前 16 位；构建输出报告 `接口哈希:未变 N 个,变更 <文件>`；§44 测试锁定"改实现不改接口 → 哈希稳定 / 改签名 → 变更"。
- `--clean-cache` 清理缓存与 dist 并全量重建；缓存文件 `.ming-cache/build-cache.json`（入 .gitignore）。
- 说明：本版为**项目级**缓存（命中即整体跳过）；函数级模块化缓存（内容寻址代码，Backlog）留待项目规模增长后。

---

## 4.1 v0.48 — QF_LIA 证明子集第一片：ensures 直线体静态验证（✅ 已完成，2026-11-11）

- **决策依据**：bench 实测 cc/vm 6–11x（运行期健康）；`ming check` 全程 126ms（当前规模编译非瓶颈）→ 3b 构建缓存当下收益微弱；3a 在契约关键路径上补"编译期保证"能力,且复用 v0.46 的 evalContractExpr 基建。
- **范围（模式 1）**：M3042[ensures-statically-false]——对含 ensures 的函数做**直线体符号执行**（Let/Assign/Return；遇 If/While/For/Match/调用/非 i64 参数静默放弃）,变量追踪为参数的线性形式;返回点将 `result` 绑定为返回值形式,对 ensures 求值：可证明为假 → 编译错误 + 反例（requires 满足的小值搜索,复用 evalContractExpr）；可证明为真/无法判定 → 静默（运行时 M4015 保留,语义不变）。
- 交付：checker 符号执行 + 诊断码 M3042 三处登记 + §43 测试 + 文档。

## 5. Backlog（不进当前两版）

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

## 5.1 已知缺陷(2026-11-11 code-review,已逐项复核)

> 来源:两个 code-reviewer 子智能体 + 主会话复现。`已验证` = 有可复现命令/输出;`源码确认` = 代码路径明确但未跑运行期。

### 已修复(v0.50.1)

| 缺陷 | 严重度 | 证据 |
|------|--------|------|
| wasm i64 `<=`/`>=` 操作码错位(0x56/0x57 → 应为 0x57/0x59),默认引擎静默算错 | P0 | default `123400` vs tree `123456` |
| 两处 f64 比较表用 f32 操作码 → 模块校验失败、wasm 静默整体回落 | P0 | `MING_WASM_DEBUG=1` 输出 `实例化失败: f32.ge expected f32` |
| `--no-wasm` 实际选中树引擎(模糊器 VM-only 腿名不副实) | P1 | ensures 嵌套 return 程序:--tree 输出 2,--no-wasm 旧行为也输出 2 |

### 待修(建议顺序)

| # | 缺陷 | 严重度 | 证据/位置 |
|---|------|--------|-----------|
| ~~1~~ | ~~**函数值丢失效果集**~~ ✅ v0.51.0:`let g = noisy; g();`、`apply(noisy)`、`v.map(noisy)` 均绕过 M3029;`main()` 无 `with io` 也能打印 | **P0** | checker.js mkFn/callFnType/lambda;实测 check exit 0 且 run 输出两行 |
| ~~2~~ | ~~契约表达式可调用 mut 方法,requires 修改参数~~ ✅ v0.51.1(M3043) | P1 | `requires (v.pop() != None)` 后 len 从 3→2(tree/VM 一致) |
| ~~3~~ | ~~ensures 未覆盖 `?` 早退;树引擎嵌套 return 漏检~~ ✅ v0.51.1 | P1 | `f(None)` 无 M4015;嵌套 return 树输出 2、VM M4015 |
| ~~4~~ | ~~容器访问器返回内部引用~~ ✅ v0.51.4 deepCopy |:`v.get(0).unwrap().push(9)` 修改非 mut 的 v | P1 | 输出 `[[1, 9], [2]]` |
| ~~5~~ | ~~match 元组嵌套模式穷尽性漏检~~ ✅ v0.51.4 | → 运行期内部 panic;树/VM 文案不一致 | P1 | `(E.A, _)` 单臂匹配 `(E.B,0)`:check 通过,运行期 M4001 |
| ~~6~~ | ~~`while let` 被 M3028 无条件拒绝~~ ✅ v0.51.4 |(GUIDE 示例不可用) | P1 | checker.js:1292/1431 |
| ~~7~~ | ~~泛型 bound 方法 arity 错误~~ ✅ v0.51.4 | → `ReferenceError: span is not defined` | P1 | checker.js:2607 |
| ~~8~~ | ~~Map 非原始键通过检查~~ ✅ v0.51.4 M3044 |:get 静默 None,debug/keys 抛 TypeError | P1 | `Map[Vec[i64],i64]` 实测 |
| ~~9~~ | ~~C f64 打印 ≥9.22e17~~ ✅ v0.51.3 |:浮点→long long 越界 UB,输出错值 | P1 | cc 对 1e18 输出 922337203685477580.0 |
| ~~10~~ | ~~C 有符号窄截断~~ ✅ v0.51.3 ming_sext | `(long long)(x) << (64-N)` 负数 UB | P1 | cbackend.js:630;源码确认 |
| ~~11~~ | ~~C str 语义偏差~~ ✅ v0.51.3 |:replace("")/pad 按字节宽度/ZWSP trim 产生非法 UTF-8 | P1 | JS `a-b`/`  中`/4 vs C `ab`/`中`/2 |
| ~~12~~ | ~~AOT sig 直写 mod 引用~~ ✅ v0.51.2 纯 wire 化 |:struct 形参 BigInt 失败回退;成功产物含 StructDecl AST(与"无明文源"冲突) | P1 | build 输出 BigInt 回退;产物 grep 到 `"nt":"StructDecl"` |
| ~~13~~ | ~~build 源码回退只拷入口~~ ✅ v0.51.2 |:多模块 dist 不可运行,exit 0 且缓存命中破损 dist | P1 | `use util;` + sync:launcher M3022,二次 build 缓存命中 |
| ~~14~~ | ~~缓存命中只验存在~~ ✅ v0.51.2 内容哈希 |:runtime 删除 / bytecode 损坏仍"缓存命中" | P1 | 删除 runtime → 命中;写入 garbage → 命中 |
| ~~15~~ | ~~接口哈希 enum 读 `v.args`~~ ✅ v0.51.2 |(parser 为 `v.types`):payload 类型变化哈希不变;bounds/typeArgs 未纳入 | P2 | i64→str payload 两次哈希均 9861fc34 |
| 16 | CLI 边界:项目模式 `--` 参数被当文件;`-o` 被忽略;值旗标吞下一旗标(`--max-steps --json`) | P2 | 三项实测 |

```

## 6. 过程纪律（所有版本适用）

1. 每个版本：实现 + `tests/run.mjs` 分节测试 + 模糊抽查（0 分歧）+ 文档三条（GUIDE 修订记录 / README 路线图 / 诊断·能力矩阵按需）+ 版本三处同步 + 提交。
2. 发现既有 bug：先最小复现 → 回归测试 → 修复 → 记录在修订记录（不静默修）。
3. 自举优先：能用 Ming 写的工具不写别处；工具使用中发现的 bug 与语言 bug 同等对待。
4. 只承诺测过的：任何性能/覆盖率数字必须来自可复现的命令。
