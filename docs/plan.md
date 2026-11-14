# Ming 实施计划（v0.45 起）

> 本文件是唯一的计划落盘位置。已完成项在版本提交后移到「已完成」；新想法先进「Backlog」，
> 只有进入版本范围才细化到任务级。当前版本：**v0.63.0**（**v0.63 wasm 剩余守护收口 slice 2 已交付(2026-11-14)**：Vec 下标读/mut 元素写/Option unwrap/VecLit 数值/f64 复合赋值真实经 wasm——宿主 4 新导入（panic_m4003/panic_m4003w/panic_m4006/ming_alloc_elem）、计费对齐（VecLit 计元素数、copy_vec 派生不计费）、panic 栈单层补齐、B1 iscratch 五处专属槽修复；无新语言面/无新 M 码；独立审查 1 BLOCKER + 2 MAJOR 修复后测试 **995 项全绿**(§63 56 + §64 24 + §65 40 + §66 22 + §67 28)。v0.62 服务端 v1、v0.61 污点窄源 v1、v0.60 资源门禁一致性已交付）。
> **下一步规划见 §4.5（2026-11-14 架构第三轮 + 安全第二轮：v0.64 信任边界与诚实失败收口（#55/#56/#57 + S9/S12）→ v0.65 wasm 守护收口 slice 3 + #59 → v0.66 观测与反馈（纯校准版）；安全新登记 S9–S16 见 §4.5.7；§4.4.10 为 2026-11-13 三方评估记录）**。
> **§4.3 全部任务已清空（2026-11-13）**：v0.60 起以 ADR 条件交付——ADR-001（并发/服务端,方案 a 条件承诺实施,原型 190 req/s@40 连接）、ADR-002（污点采纳类型级 Untrusted[T],实现推迟）、ADR-003（mask 永久否决）；实现条件见各 ADR 评审清单与 §4.3.9。**三方评估后 serve 从 v0.60 移至 v0.62（独立条件版），v0.60 改为资源门禁一致性修复——理由与实测证据见 §4.4.10。**

---

## 0. 当前状态

| 项 | 状态 |
|----|------|
| 语言内核 | 显式类型/效果系统/值语义/确定性；树+VM+wasm+C 四后端 |
| C 后端 | C1 数值 → C2 str/Vec[i64] → C3 Map/Option/f64 打印 → C4 extern fn FFI（dlopen/dlsym）、`--static`；v0.53 `str` for-in 按 UTF-8 码点迭代；**v0.54 C5 `with unsafe`（Ptr[u8]/Ptr[mut u8] → unsigned char*/const unsigned char*、std.mem.alloc/free → malloc/free（失败 M4011）、extern 槽接受/返回 Ptr；tree/VM/wasm 回落 M4016）** |
| 构建 | `ming build` 真 AOT 字节码产物（无明文源）；`--with-source`；spawn/trait 自动回退；**v0.49 内容寻址缓存 + 接口哈希报告 + `--clean-cache`**；**v0.53 构建键 = 项目相对路径 + 内容 + Node 主版本，`--json` 带 build_key/dist_hash/cache_hit/source_count/interface_hashes（同 OS + 同 Node 主版本可复现 dist_hash）** |
| CI | **v0.53 GitHub Actions**：push/PR + nightly；`test` 九组合（ubuntu/macos/windows × Node 18/20/22）跑 run/fuzz/proof_fuzz；`c-backend` ubuntu/macos；nightly 三种子 120 程序 + proof_fuzz 300；官方 action、零 npm 依赖（`.github/workflows/ci.yml`） |
| 自举工具 | 12 个全部 Ming 自写（mingkit 文件补丁 / edit 行级编辑 / engdiff 引擎差分 / diaghot 诊断热力图 / wc·tree·find·json·todo·log·rename·organize 日用小工具）；v0.51.6 起统一错误纪律（stderr + 失败退出 1）并全部 fmt 规范；`ming tools` 统一入口 + `--` 透传 + **v0.57 工具 AOT 缓存**（12 工具全缓存零回退；`MING_TOOLS_DEBUG=1` 观测缓存决策） |
| 质量护栏 | 回归全绿（v0.63.0 起 **995 项**；§67 为 v0.63 wasm 守护收口 slice 2 **28 项**，§66 为 v0.62 服务端 v1 **22 项**，§65 为 v0.61 污点窄源 v1 **40 条**，§64 为 v0.60 资源门禁一致性 **24 项**（A 组 4 + B 组 9 + C 组 11），§63 为 v0.59 wasm 覆盖/本地函数/invariant bench + P1/P2 审查修复 **56 项**；§62 为 v0.58 LSP/join/doc/Release **34 项**；§61 为 v0.57 循环义务 19 + tools 缓存 6 + 观测冒烟 2 共 **27 项**；§60 为 v0.56 引擎一致性/契约保真/wasm 语义/独立审查 70 项；§59 为 v0.55 跨函数契约摘要 42 项；§58 为 v0.54 `with unsafe`/C5 + 独立审查 20 项；§57 为 v0.53 可信构建 31 项）+ 多后端差分模糊（四腿 + **v0.56 fuzz 真实 wasm 腿**:eligible helper 断言 `[wasm] fn OK` 并计数）+ proof_fuzz（边界证明模式 1/2 + v0.55 summaries 模式 + **v0.57 loops 模式** 0 误报/反例独立求值器三重验证）+ bench（cc 腿 + **v0.57 Δ基线对比** + **v0.59 invariant 项**）+ **v0.57 覆盖率基线 + v0.59 复测 + v0.60 全表**（tests/coverage.mjs；**94.0% 行 / 88.7% 函数**，vm.js 65.9%；信息性不设门槛） |
| 能力矩阵 | 55 行口径 ≈84%（docs/capabilities.md；v0.61 新增"数据流安全(污点标注)"行(✅,窄源 v1)、v0.62"TCP/UDP/服务端"行 ❌→🟡(serve v1):42✅ 8🟡 5❌，(42+8×0.5)/55=83.6%≈84%；"运行时资源熔断"经 2026-11-13 评估改判 🟡 后于 v0.60 修复恢复 ✅） |
| 下一步 | **§4.5（架构第三轮 + 安全第二轮，2026-11-14）：v0.64 信任边界与诚实失败收口（#55 裁决=文档+回归+前置义务/#56 校验/#57 回归批/S9 嵌套 serve 拒绝/S12 闸门扩展/#58 顺带；零新增 M 码）→ v0.65 wasm 守护收口 slice 3 + #59 → v0.66 观测与反馈（纯校准版）；eval ADR 为规划期任务** |

## 1. 已完成的规划项（v0.39–v0.44）

- v0.39 C 后端 C1 + wasm 层四项休眠 bug 修复 + ffi 设计
- v0.40 C2（str/Vec）+ engdiff 自举工具 + 模糊器 cc 族
- v0.41 C3（Map/Option/f64 打印）+ cc 差分腿覆盖 v0.41 声明形态（`str` for-in 于 v0.53 补齐）
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

## 4.2 v0.52+ 路线(software-architect 规划,2026-11-11)

> **状态(2026-11-12):v0.52–v0.56 路线已全部交付**(v0.52 QF_LIA 第二片 / v0.53 可信构建与跨平台验证基线 / v0.54 `with unsafe` C5 / v0.55 跨函数契约摘要 / v0.56 引擎一致性与缺陷清零)。本节已无待办计划任务;下一步方向见 §4.3.8 Backlog(v0.57+)与 §5.1 已知缺陷 #37–#49。

> 基线:v0.51.5,534 项测试全绿,四后端差分 0 分歧;§5.1 的 16 项审查缺陷已清零。
> 总原则:**先装安全带,再讲解开安全带的规则**——验证基础设施先于危险能力;一版一个语义面;
> 证明只报告、不先删检查;危险能力签名与块级双可见;每版可独立回退。

### 4.2.1 现状判断

- **强项**:四后端(树 / VM+wasm / VM-only / C)+ 差分模糊构成语义合同;效果门禁已闭合到函数值;
  契约有运行时检查与两片静态检查;诊断码稳定且带 span/hint/JSON;652 项回归是可信基线(v0.54 起)。
- **风险**:证明器只覆盖直线体 `ensures`,越界/调用链/循环仍空白,"证明 → 许可"闭环未建立;
  `unsafe` 已于 v0.54 交付(C5,effect-gated,tree/VM 诚实拒绝),`mask` 仍是设计稿(v0.56+ 评估)。**v0.53 已装第一道安全带**:CI 九组合矩阵 + nightly 深模糊,
  跨平台门禁不再依赖单机;strict wasm(`--strict-wasm`)让静默回落成为可见失败(exit 2)。
- **已知债务(本规划核实)**:
  - ✅ v0.53 已修复:`collectProjectSources` 共享累加器导致重复条目(旧实现 4 文件收 11 条,
    新实现 4 条:项目相对路径 + 内容去重);旧实现同 basename 不同目录交换内容后**构建键不变**
    (漏检/脏命中),现为"项目相对路径 + 内容"并注入 Node 主版本。
  - ✅ v0.53 已复核:文档漂移(GUIDE 头 v0.48 / capabilities 头 v0.38 / plan §0 471 项 / M3030 效果列表);
    本次收口再次对齐 GUIDE/capabilities/README/plan/AGENTS 的版本与数字。
  - ✅ v0.53 已改写:README "cc 差分腿 = 解释引擎全形态"属过度声明(C 缺 `str` for-in);
    现为"覆盖已声明 eligible 形态 + 未覆盖清单",且 `str` for-in 已按 UTF-8 码点补齐。
- **最短板**:不是语言表面不够多,而是"检查 → 可证明、可复现、可跨平台验证"的闭环尚未形成。
  **v0.53 已建立可复现与跨平台验证基线**(构建键/CI/env -i);剩余闭环是 v0.54–v0.55 的证明→许可链。

### 4.2.2 关键 ADR（v0.52 规划期裁决记录；编号已被 docs/adr-00N 文件系列取代——ADR-001 并发选型见 docs/adr-001-concurrency.md，污点/mask 裁决见 docs/adr-002-taint.md、docs/adr-003-mask.md，避免撞号混淆）

| ADR | 决策 | 理由 | 影响 |
|-----|------|------|------|
| ADR-001 | `unsafe` 仅在 C 原生后端执行;tree/VM 确定性拒绝(M4016);wasm 资格继续拒绝 | JS 引擎无法诚实模拟裸指针;伪指针会引入与 C 不一致的"安全兜底";与 extern ffi 的原生限定先例一致 | 四引擎合同出现**明示例外**:tree/VM 验证拒绝行为,C 验证执行行为;写入 GUIDE/design |
| ADR-002 | `mask [效果]` 本阶段不做(v0.56+ 评估) | 会让纯签名执行 IO,破坏"签名即效果真相";wasm/C 资格与契约纯性都读 `sig.effects`;且无资源句柄类型/逃逸分析 | 本阶段由 C 后端补全替代;mask 需独立 ADR 与审计报告 |
| ADR-003 | 边界证明不消除运行时检查 | 证明器尚未形式化验证;先积累 proof-vs-runtime 模糊证据;删检查属 codegen 语义变更 | v0.52/v0.55 冻结 `compiler/interp/vm/cbackend/artifact` |

### 4.2.3 v0.52 — QF_LIA 第二片:越界包含静态验证(只证明,不改 codegen)✅(2026-11-12 完成)

**目标**:从 `requires` 的线性边界证明每个 `Vec` 索引点在界内;可证违反 → M3045 + 反例;未证明不阻断、不误报。

**范围**:i64 参数、非 `mut` 的 `Vec` 参数、`requires` 中的 `buf.len()`、直线体(Let/Assign/Return/纯调用语句)、单个索引点。
**不做**:循环、分支路径敏感、局部别名、`mut Vec`(push/pop 改长度)、通用 SMT、非线性、消除 M4003、任何 codegen 修改。

**任务**(全部完成,三阶段由中断会话交接后收口):
1. ✅ 抽出 `src/prover.js`:线性形式(v0.48 原样迁出)/差分约束(Bellman-Ford 全 0 初始化负环检测,变量 ≤12,BigInt 权重,锚点 SRC 编码绝对约束);checker 只留 AST 适配与诊断。§43 的 M3042 行为逐字不变(§56 黄金锁定)。
2. ✅ 边界证明遍:`x.len()` → `len$x`(仅限被追踪的非 mut `Vec[i64]` 参数);比较归一化为差分约束(严格 `<` 转 `c-1`;`==` 拆双向;`!=`/`||`/非线性/系数非 ±1 保守跳过);索引点义务两向证明 `0 <= i` 与 `i < len$base`;假设集负环(requires 自相矛盾)整函数跳过。
3. ✅ 诊断与反例:M3045[index-bounds-violated](error,含义务与反例;i64 参数 ∈ {-2..2}、len$x ∈ 0..8 确定性枚举,仅枚举相关变量);未证明仅在 `--warn-unproven-index` 下发 W3105[index-bounds-unproven](warning,不改退出码)。
4. ✅ 证明报告:`ming check --proof-report` 文本摘要(逐函数 义务/proven/violated/unproven);`--json --proof-report` 增加 additive 的 `proofs` 字段(逐义务 {file,fn,index,kind,obligation,line,col,counterexample});不带旗标时 JSON 与 v0.51.6 逐字一致(HEAD CLI 对照 + 黄金快照双锁定)。
5. ✅ 测试 §56(26 项 ≥ 12:原 23 项 + 审查修复 3 项):可证真/边界严格性(`<=` 不蕴含 `<`)/可证违反+反例/mut Vec 与 mut i64 重赋值/循环/别名/非线性静默/警告旗标 W3105 逐字/无 requires 不警告/无旗标 JSON 不变(HEAD 对照 + 快照 + proofs 键缺失)/运行时仍 M4003(双引擎 101)/负环跳过/--proof-report 文本与 JSON/复合索引原文完整;审查修复 3 项(反例过滤最小奇数解逐字 + 反例满足被跳过叶子属性 + 已有 error 文件 W3105 门控)。
6. ✅ `tests/proof_fuzz.mjs`:模式 1(0 误报)——生成器保证实参满足 requires,凡 proven 义务断言 `run`/`run --tree` 退出 0 且无 M4003/M4015,可证类另断言必须 proven;模式 2(反例验证)——独立实现的线性求值器(不 import prover.js)验证 M3045 反例满足 requires 且越出义务侧;负控(不可编码 requires)必须静默。文档:GUIDE §6 契约与静态边界证明节 + 修订记录、diagnostics M3045/W3105、README 路线图/状态段。

**验收**(2026-11-12 实测,含审查修复后复测):`node tests/run.mjs` 597 项 0 失败(§56 26 项:23 项 + 审查修复 3 项);`proof_fuzz --count 200` 0 误报、反例验证 35/35(异种子抽查另过);`fuzz --seed 44044 --count 40` 0 分歧;`check --proof-report` 输出 proven/violated 逐函数统计;`git diff` 对 compiler/interp/vm/cbackend/artifact 为空;check 语料耗时 ≤1.2x v0.51.6 基线(信息性)。
**审查修复**(2026-11-12 独立审查 6 项,全部落实):M3045 反例按被跳过但可求值的 requires 叶子过滤(满足完整 requires;无候选退回无反例消息)·`--warn-unproven-index` 下文件已有 error 不叠加 W3105·lenSeen 死代码删除·prover.js 头注释改写当前职责·GOLDEN_DIAG 快照分隔符无关化·diagnostics.md CRLF → LF。
**风险/回退**:误报 M3045 —— 用"非 mut Vec + 直线体 + 假设一致 + 差分约束"四重门控;出问题关闭对应模式(保留 W3105 观测),运行时语义未动。

### 4.2.4 v0.53 — 可信构建与跨平台验证基线 ✅(2026-11-12 完成)

**目标**:让"通过"在 Linux/macOS/Windows × Node 18/20/22 可复现;wasm 静默回落成为 CI 可见失败;构建键真正由"路径 + 内容"决定。

**任务**(全部完成,2026-11-12 收口):
1. ✅ **CI 矩阵**:`.github/workflows/ci.yml`——`ubuntu/macos/windows × Node 18/20/22` **九组合**跑 `tests/run.mjs`、`fuzz --seed 44044 --count 25`、`proof_fuzz --count 100`;C 腿在 ubuntu/macos 单独 job(Node 20,先探测 gcc/clang,无编译器则自跳过);nightly 三种子 `fuzz --count 120` + `proof_fuzz --count 300`。只用官方 action(actions/checkout@v4、actions/setup-node@v4),零 npm 依赖;PR/push job 超时 20 分钟,nightly 40 分钟。workflow 以 PyYAML 做本地语法/结构静态校验(本机不代跑 Actions)。
2. ✅ **strict wasm**:`--strict-wasm` / `MING_WASM_STRICT=1`;`run --json` 增加 additive `wasm_status: none|ok|fallback`(check 仅在 strict 时输出聚合值);eligible>0 但编译/实例化回落 → 退出码 2 并点名函数与原因;与 `--tree`/`--no-wasm` 互斥(冲突 exit 1);判定抽成 `src/wasm.js` 的 `wasmLayerStatus` 纯函数,§57 直测三态并覆盖 fallback。
3. ✅ **`env -i` launcher 验收**(§57):最小环境 + 无关 cwd + 删除源目录后的 dist 异地拷贝;POSIX 用 `PATH`/`LANG=C.UTF-8`,Windows 只保留 `SystemRoot`;输出/退出码/panic 首行逐字一致,多字节 UTF-8 实参按字节透传。
4. ✅ **构建可信性**:修复 `collectProjectSources`(递归返回本次新增条目,条目 = 项目相对路径 + 内容,注入 Node 主版本);`ming build --json` 增加 `build_key/dist_hash/cache_hit/source_count/interface_hashes`;回归:同名不同目录交换内容 → 键变化;两次 `--clean-cache` 构建 `dist_hash` 相同;第三次 `cache_hit: true`。只承诺"同 OS + 同 Node 主版本可复现"。
5. ✅ **C 后端 `str` for-in**:按 UTF-8 码点迭代(非字节);ASCII/CJK/emoji 三组黄金测试逐字一致(tree / VM(该形态 wasm 回落)/ VM-only / cc);fuzz 增加 `for ch in s { v += ch.char_len() as i64; }`;Backlog 关闭 for-in 缺口(trim 族已于 v0.51.3 完成)。
6. ✅ **文档真实性审计**:GUIDE/capabilities/README/plan/AGENTS 数字与版本头;无法被测试证明的表述改为"已声明覆盖范围 + 未覆盖清单"(C 后端 diff 腿、能力矩阵覆盖率)。

**验收(2026-11-12 实测)**:`node tests/run.mjs` **628 项 0 失败**(§57 共 31 项 v53.*:strict wasm 7 + 构建可信性 6 + env -i 3 + C str for-in 3 + CI/版本收口 2 + 尾表达式 wasm 1 + 独立审查修复 9);`fuzz --seed 44044 --count 25` 0 分歧;`proof_fuzz --count 100` 0 误报;两次 clean build `dist_hash` 相同、第三次 `cache_hit: true`(§57 v53.10/11);`env -i` 输出逐字一致(v53.14-16);strict wasm 对 §57 eligible 语料 `ok`、零 eligible `none`、回落语料 exit 2(v53.1-7/v53.22;其他既有回落形态如 f64+while/if 表达式由 strict 如实报告,已登记 Backlog);CI workflow 结构静态校验通过(test 九组合 + 示例 fib strict 步 + c-backend 两组合 + nightly 三种子 / timeout 20/40 分钟;GitHub runner 实际矩阵结果以仓库 Actions 记录为准,本机无法代跑)。**审查追加**:strict 暴露既有 wasm 尾表达式模块校验回落(函数级补零多压栈),已修并加 v53.22 回归——`examples/fib.ming` 现 strict `ok` 且真实经 wasm 执行。**v0.53.0 独立审查修复(9 项阻断/次要,§57 F 节)**:B1 同名文件 fixture 真的能测出 basename 键缺陷;B2 check strict fallback 与正常路径共用 out(ok/diagnostics/proofs/wasm_status,文本先 printDiags 再报原因);B3 C 后端容器/区间 for-in 循环变量落入内层作用域(遮蔽程序不再发射非法 C);M1 `--no-wasm` 不输出 wasm_status;M2 Module 校验/实例化回落点名疑似函数 + eligible 表;M12 wasm `/` 守卫 opcode 与 if 位置修复(含 `/` 的 eligible 函数现 strict `ok`);M6 测试夹具默认剥离 MING_WASM_STRICT;M7 `build --json` stdout 纯 JSON;M9 CI 增加示例 fib strict 步。
**风险/回退**:CI 抖动 —— C 腿独立 job、nightly 独立 job;strict wasm 误判 —— `none` 白名单 + 纯函数单测;构建键修复使旧缓存全部失效(一次性成本,文档说明)。

### 4.2.5 v0.54 — `with unsafe` 最小实现(C 原生,效果门禁)✅(2026-11-12 完成)

**目标**:用最小 `Ptr` 面兑现"受控不安全":签名与块级双可见;C 真实执行;tree/VM 确定性拒绝。

**范围**:`unsafe { ... }` 块;`Ptr[mut u8]`/`Ptr[u8]`;`load/store/offset/is_null`;`std.mem.alloc/free`;extern 签名中的 Ptr;C5;tree/VM M4016;效果名 `unsafe`。
**不做**:Ptr 算术(除 offset)、Ptr↔整数、打印/相等、生命周期/逃逸分析、内联汇编、mmap、`unsafe(cond)`、JS 伪指针。

**任务**(全部完成,2026-11-12 收口):
1. ✅ 类型/语法:`{k:'ptr', el, mut}`;`Ptr[mut u8]` 解析;`typeStr`;unify 精确匹配;禁止索引/算术/==/插值/debug/JSON/Map 键;方法 `load/store/offset/is_null`(元素仅 u8,M3002 提示)。
2. ✅ 效果/检查器:`unsafe` 入 KNOWN_EFFECTS;`unsafe {}` 需函数声明 `with unsafe`(M3029);指针操作/Ptr 实参必须在块内,否则 M3046;块外只允许 let/赋值/return 传递与 is_null。
3. ✅ C5:资格增加 C 专用 unsafe 扩展(效果 ⊆ {ffi, unsafe},wasm 不传 `opts.unsafe`);Ptr → `unsigned char*`/`const unsigned char*`;alloc/free → malloc/free(失败 M4011);extern 槽位支持 Ptr;`--emit-c` 快照;`ming build` 遇 `with unsafe` 显式回退源码模式。
4. ✅ tree/VM 诚实拒绝:M4016[native-only-feature](panic,101),消息"unsafe 指针操作仅在 C 原生后端可用";tree/VM 逐字一致;wasm 继续拒绝 unsafe 函数,主程序回落 VM 得到同一 M4016。
5. ✅ 测试 §58(14 项):C 黄金程序(v58.7)/只读 Ptr 不可 store(v58.2)/块外 load → M3046(v58.5)/无 with unsafe → M3029(v58.4)/Ptr 实参传纯函数 → M3046(v58.5)/check 通过(v58.6)/tree/VM/wasm M4016(v58.6)/emit-c 含 `unsigned char*`/`malloc`(v58.8)/既有 C 差分零变化(v58.11)/**Ptr 别名面(v58.12)**/**offset 链式 C 黄金(v58.13)**/**unsafe 效果传播(v58.14)**。
6. ✅ 文档:design.md §6.10 改为块形式并说明不用 `unsafe(expr)` 的理由;GUIDE §14.1 unsafe/std.mem 节 + §18 std.mem + C5 工具链行;diagnostics M3046/M4016 措辞核对;README/AGENTS/capabilities/plan 数字与版本收口。

**验收(2026-11-12 实测)**:`node tests/run.mjs` **646 项 0 失败**(§58 共 14 项 v58.*);`check examples/unsafe_demo.ming` 0 诊断;`cc examples/unsafe_demo.ming` 输出 `65/66/false`;`run --tree`/`--no-wasm` exit 101 + M4016 首行逐字一致;`fuzz --seed 44044 --count 25` 0 分歧;`proof_fuzz --count 100` 0 误报;`fmt examples/unsafe_demo.ming --check` 通过;既有 C 差分零变化(v58.11 抽查 + 全量套件内 C 腿);`--strict-wasm` 对 unsafe 程序不误报 ok(未进 wasm 资格)。**Linux/Windows C 黄金一致**:本机 Windows(w64devkit gcc)实测;Linux 由 CI c-backend job 承载(本机无法代跑)。

**v0.54.0 独立审查修复(2026-11-12,§58 v58.15–v58.20)**:B1 `UnsafeBlock` 接入控制流分析(`stmtTerminates`/`hasBreak`;块内 return 为最后语句不再误报 M3017;`loop { unsafe { break; } }` 类型为 unit,装 i64/Ptr → M3002);B2 C 后端 unsafe 块发射独立 C 作用域(遮蔽写法 cc 输出 2/1 与 VM 一致);B3 M3046 覆盖容器/构造器载荷逃逸(`typeContainsPtr` 递归:Vec/Map/Option/Result/元组/结构体字段/枚举载荷;泛型调用点按实参类型判定,泛型体内擦除跳过);B4 unsafe 块内闭包函数类型携带 `unsafe` 效果(赋给纯函数类型 → M3029,块内直接调用允许);B5 #27 修复(`use std.x [as y]` 短名在字节码编译器可解析;compileNamedValue 读 imports → `__stdmod:<真实模块名>`;编译器未解析名 → 带 file:line:col 的 M4001 诊断)。M1 Ptr 方法防御 M4016;M4 固定非 unsafe 程序 C 渲染指纹逐字节回归;M6 示例比较退出码 + stderr 首行。新登记 #28/#29/#30 见 §5.1。**验收实测**:`node tests/run.mjs` **652 项 0 失败**;`fuzz --seed 44044 --count 25` 0 分歧(一致 25,其中 C 腿 7);`proof_fuzz --count 100` 0 误报(反例验证 18/18);`cc examples/unsafe_demo.ming` 输出 `65/66/false`;tree/VM/wasm 回落 M4016 首行逐字一致(exit 101);B1 三例/B2 遮蔽 2/1/B3 块外 7×M3046 与块内 0/B4 M3029 反例/B5 `use std.mem` 三路与 `use std.math` 5.0 均实测。
**风险/回退**:悬垂/越界解引用是进程级 UB,Ming 不捕获(GUIDE §14.1 诚实声明);v1 限定 u8、禁止算术/打印;特性 effect-gated,可整体回退。

### 4.2.6 v0.55 — QF_LIA 第三片:跨函数契约摘要 ✅(2026-11-12 完成)

**目标**:用"直线体 + 线性契约"的函数摘要,让调用链上的 ensures 可证明;绝不假设未证明的前置条件。

**范围**:i64 参数/返回、纯函数、直线体、无环调用图、单条 requires/ensures、摘要代入、调用点前置条件证明。
**不做**:循环/分支、递归/互递归、高阶函数、效果函数、堆/别名、通用 SMT、运行时语义变更。

**任务**(全部完成,2026-11-12 收口):
1. ✅ 摘要引擎(prover.js):`computeSummaries` 调用图 Tarjan SCC 环检测 + 被调方优先拓扑序;递归/互递归标记 `noSummary`;摘要 = {requires 声明, ensures 仅在已证明时作为后置条件};requires 不完整/环上 → ensures 一律不采用。
2. ✅ 调用点前置条件:实参线性形式代入被调 requires,用当前函数 requires 假设证明;可证违反 → M3041 + 反例;无法证明 → 放弃该路径,不得假设被调 ensures;字面量 M3041 路径逐字不变。
3. ✅ 调用后置条件:调用成功后 `result` 绑定每次调用独有的 `res$N` 符号,加入被调已证 ensures 作为假设;未知/无摘要/前置未证的调用使相关表达式 unknown。
4. ✅ 调用方 ensures 证明:M3042 直线体遍历使用"变量形式 + 差分约束假设集(requires + 已证调用后置)";可证假 → M3042 + 反例(须满足假设集);不可判定静默,运行时 M4015 保留;不新增诊断码。
5. ✅ 测试 §59(42 项 ≥10):f→g→h 链式 ensures;调用点违反 g.requires → M3041;g.requires 未证明时调用方 ensures 不得误判;递归/互递归/循环/分支/高阶/效果函数静默;§43/§54/§56 全绿;`proof_fuzz --mode summaries --count 300` 可证 150 / 违反 75 / 静默 50 / 易误报 25 / 误报 0(反例独立验证 75/75)。
6. ✅ 收口报告面:check `--proof-report` 文本为每个可摘要函数新增契约摘要行(`requires=<完整|不完整|无> ensures=<已证|未证|无> 调用点=<N 可证, M 违反>`);`--json --proof-report` 的 `proofs` 增加 additive `summaries: [{file, fn, requires_present, requires_complete, ensures_present, ensures_proven, calls_proven, calls_violated}]`;无旗标输出与 v0.54.0 逐字一致;数据复用 checker 摘要表与调用点统计。

**验收(2026-11-12 实测)**:`node tests/run.mjs` **694 项 0 失败**(§59 42 项);`proof_fuzz --mode summaries --count 300` 可证 150 / 违反 75 / 静默 50 / 易误报 25 / 误报 0,反例独立验证 75/75,退出 0;既有 `proof_fuzz --count 100` 两模式通过;`fuzz --seed 44044 --count 25` 0 分歧;`check <链式语料> --proof-report` 输出链式 proven 摘要;无旗标 JSON 与 HEAD(v0.54.0)逐字一致;compiler/interp/vm/cbackend/artifact 零改动;check 链式语料 10 次 797ms vs HEAD(v0.54) 875ms(同机信息性,无硬阈值)。
**v0.55.0 独立审查修复(2026-11-12)**:B1 直线体共享判定(`exprIsLinear`/`stmtIsLinear`)——If/Match/BlockExpr/Loop/Lambda 及含 Return/Assign/Break/Continue 的表达式不再被"穿透";`checkEnsuresStatically` 的 walkLinearBody、`buildCallSiteLinear`、v0.52 `checkIndexBoundsStatically` 三处统一,遇非直线语句停止后续线性分析(已收集保持);分支内形参重赋值不再产生错误摘要,if-return/match/裸块赋值后不再误报 M3041/M3042/M3045(§59.13 四项)。B2 短路 `&&`/`||` 只下钻左侧,右侧条件求值不作为无条件调用点(线性路径不再误报;左侧真实调用仍报 M3041;§59.14 两项)。B3 M3041 反例构造加入调用方上下文(枚举调用方形参、过滤调用方 requires/假设、按实参形式计算被调值;常量实参直接报常量值),反例必落在调用方合法输入集(§59.15 两项;§59.2 反例断言同步)。B4 `proof_fuzz --mode summaries` 改为 12 槽分布(6 ok / 2 callsite / 1 ensfalse / 2 静默 / 1 易误报),新增分支返回/分支重赋值/match 重赋值/短路 &&/|| 语料;ok 类用 `--proof-report summaries.ensures_present/ensures_proven` 负控"摘要确实被采用";callsite 增加下界 requires 形态(M7)。M5 JSON `summaries` 新增 `requires_present/ensures_present`(无契约函数不与 ensures_proven=true 混淆)。M6 `+=/-=/*=` i64 常量复合赋值线性转移(其余 op 放弃);§59.16 两例(HEAD 误报静默 + 线性确保 M3042)。N10 `prover.js` 校验注入 `toLinear/computePost` 的 op ∈ {==,<,<=,>,>=},非法视为不可编码。N8/N9 登记为 §5.1 #31/#32(P3,不改代码)。**实测**:`run.mjs` 694/0;summaries 300 例 0 误报;模式 1/2 100 例 0 误报;seed 777 summaries 120 例 0 误报;`fuzz --seed 44044 --count 25` 0 分歧;无旗标 JSON 快照全绿;冻结面零改动。
**风险/回退**:摘要不健全 → requires 未证明则不采用 ensures 的硬门控 + 拓扑序 + 环检测;出问题退回 v0.52 行为。

### 4.2.7 诊断码登记

| 版本 | 新码 | 名称 | 触发/严重度 |
|------|------|------|-------------|
| v0.52 | **M3045** | index-bounds-violated | 由 requires 可证索引越界;error |
| v0.52 | **W3105** | index-bounds-unproven | `--warn-unproven-index` 下未证明;warning |
| v0.54 | **M3046** | unsafe-context-required | 指针操作/Ptr 实参在 unsafe 块外;error |
| v0.54 | **M4016** | native-only-feature | tree/VM 执行指针操作/std.mem;panic 101 |
| v0.55 | 无 | — | 复用 M3041/M3042 |
| v0.56 | 无 | — | 无新码(引擎一致性/契约保真/wasm 语义修复均复用既有码) |
| v0.57 | 无 | — | 无新码(循环义务复用 M3045/W3105,码与消息不变;义务记录 additive `scope: body\|loop`) |
| v0.58 | 无 | — | 无新码(LSP 三查询为协议层无诊断码;std.str.join 复用 M3002/M3005/M3001/M4011 口径;doc --json 为工具输出非诊断) |

三处登记:`src/diag.js` CODES(+CODE_HINTS)、`docs/diagnostics.md`、`tests/run.mjs` 对应分节;GUIDE 修订记录同步;已发布码不改号。

### 4.2.8 Backlog 重排

| 项 | 处置 | 理由/前置 |
|----|------|-----------|
| `with unsafe` 实现 | **✅ 已交付 v0.54(C5)** | 北星支柱;与 ffi 共用门禁;双门禁 M3029/M3046;tree/VM/wasm 回落 M4016;Ptr 带长度/`unsafe(cond)` 见下 |
| `mask [效果]` | **❌ 永久否决（ADR-003，docs/adr-003-mask.md）** | 签名不再陈述真实效果,与第一原则结构性冲突;与 M3029 推导/契约纯性/资格面/函数值携带效果四机制逐项冲突;动机消失(无 File/Lib 句柄);design §6.11 存档为已否决设计 |
| 污点即效应(`untrusted`) | **✅ 已裁决采纳类型级方案（ADR-002，docs/adr-002-taint.md）；实现推迟** | "污点即效果"建模否决(机制错位/净化方向性不可表达/契约被切断);采纳 `Untrusted[T]` 编译期标签 + `std.unstr` 净化族;实现条件:ADR-002 评审清单 16 项逐项裁决 + 破坏性变更窗口 |
| ffi 面扩大 | 拆分:Ptr 交集进 v0.54;struct/array 保留;`lib.fn` 运行时 API 删除 | extern fn 已覆盖可审计路径;动态符号破坏 AOT/审计 |
| 约束解码生成模式 | 移出语言计划(工具侧研究) | 非语言/编译器能力 |
| 内容寻址代码 | 降级 | 项目级 ABI 缓存已交付;函数级 ROI 无数据 |
| C `str` for-in / trim 族 | **已关闭** | trim 族 v0.51.3;for-in v0.53(UTF-8 码点迭代,tree / VM / VM-only / cc 黄金一致;该形态 wasm 回落) |
| wasm 静默回落残留形态 | **✅ v0.59 已修**:#40–#43/#45/#46 + 本地函数 #44 + 记账 #48/#49(见 §4.4.3);剩余守护具名(VecLit/下标/mut 写/Option 链等) | v0.56 已修 W1/W2/F1/F2;v0.59 收口 wasm 覆盖与本地函数;保留守护不影响语义,strict 可见(§63 v63.19) |
| 泛型单态化缓存 | 降级 | 无 bench 证据 |
| async/eval/国密/交叉编译 | 保留远期 | 各自独立设计与安全评审 |
| 证明携带 unsafe(`unsafe(cond)`) | 新增 Backlog | 需带长度 Ptr/Slice 与证明令牌 |
| 循环/守卫敏感边界证明 | **✅ 已交付 v0.57(§4.3.4)** | `for i in 0..len { buf[i] }` 最高频;范围 for 体内义务两向证明(脏循环/嵌套/while 保守放弃;义务 `scope: body\|loop`) |
| Ptr 带长度 / Slice 只读视图 | 新增 Backlog | 零拷贝与证明联动先决条件 |
| v0.53.0 独立审查新登记缺陷 | **✅ 已清零(v0.56.0,§4.3.3)** | #23 tree for-in 遮蔽泄漏(P1)/ #24 VM 捕获闭包传 `v.map` TypeError(P1)/ #25 fuzz 恒 io、wasm 腿不真实执行(P2)/ #26 buildKey 不含编译器源码(P3);逐条见 §5.1 |
| v0.54 收口新登记缺陷 | **✅ #27 已修(v0.54.0);#28/#29/#30 已修(v0.56.0)** | #27 std 模块别名在字节码编译器解析失败 → v0.54.0 独立审查 B5 修复;新登记 #28 tree 块作用域泄漏(P1)/ #29 launcher 源码模式 panic 无位置(P3)/ #30 extern fn 值存局部变量后 C 后端不支持调用(P2)——均于 v0.56.0 修复;逐条见 §5.1 |
| v0.55.0 独立审查新登记缺陷 | **✅ #31/#32 已修(v0.56.0)** | #31 proof-report 多入口重复(P3)→ 按记录 `abs`(模块绝对路径)+函数名去重; #32 摘要无条件构建(P3)→ 无契约模块跳过;逐条见 §5.1 |
| mask / 污点即效应(untrusted) | **✅ ADR-002/003 已交付(2026-11-13,§4.3.7)** | mask 永久否决;taint 采纳类型级方案、实现推迟(条件见 ADR-002 §7) |

### 4.2.9 明确不做(v0.52–v0.55)

- 不做 `mask`;不引入"签名看不见的效果"。
- 不做通用 SMT / 完整 QF_LIA;只做线性形式 + 差分约束,超出即静默放弃。
- 不消除运行时边界检查;proven 只报告,不改变 M4003。
- 不在 tree/VM 模拟裸指针或分配器;unsafe 是 C 原生限定。
- 不做 Ptr 算术、Ptr↔整数、指针打印/相等、内联汇编、mmap、逃逸分析。
- 不做 `unsafe(cond)`;v0.54 只做 `unsafe {}`。
- 不承诺跨 OS 位级一致构建;只承诺同 OS + 同 Node 主版本的可复现 dist_hash。
- 不做 async/green-thread、eval、结构体/数组 FFI ABI、C 交叉编译。
- 不引入第三方运行时依赖或 npm 包;CI 只用官方 action。
- 不改已发布诊断码、不破坏既有 `--json` 字段;新增字段一律 additive。
- CI 不覆盖 Windows C 后端(runner 无 gcc);Windows C 由本机 w64devkit 验收并记录跳过原因。

### 4.2.10 成功度量

| 版本 | 完成判定(全部满足) | 量化门槛 |
|------|---------------------|----------|
| v0.52 | 三态稳定(proven/violated/silent);proof 报告 additive;codegen 零改动 | §56 ≥12(实测 26);proof fuzz 200 例 0 误报;fuzz 40 程序 0 分歧;无旗标 JSON 快照不变 |
| v0.53 | strict wasm 无静默回落;`env -i` 可跑;构建键无重复/路径化;C str for-in 三引擎一致;CI workflow 结构静态校验(实际矩阵以 GitHub Actions 记录为准) | §57 ≥10(实测 31);两次 clean build dist_hash 相同;文档数字与实现一致 |
| v0.54 | C unsafe 黄金通过;tree/VM 确定性 M4016;门禁闭合;无半开状态 | §58 ≥12(实测 20,含独立审查回归);Linux/Windows C 黄金逐字一致(本机 Windows 实测;Linux 由 CI c-backend job 承载);既有 C 差分 0 变化 |
| v0.55 | 跨函数 ensures 可证;前置条件不被跳过;无新码;codegen 零改动 | §59 ≥10(实测 42);proof_fuzz summaries 300 例 0 误报/0 假反例(反例独立验证 75/75;含分支/重赋值/短路与下界 requires 语料);fuzz 25 程序 0 分歧;链式 `--proof-report` 输出 proven 摘要;无旗标 JSON 与 v0.54.0 逐字一致 |

**跨版本共同门槛**:`node tests/run.mjs` 0 失败;`fuzz` 0 分歧;新增分节测试;GUIDE 修订记录 + README 路线图 + plan 已完成项移动;版本三处同步;诊断码三处登记;不留下未提交生成物;性能数字必须来自可复现命令(bench 仍为信息性)。

---

## 4.3 v0.56–v0.59 规划（含 ADR 研究槽位，software-architect 精读，2026-11-12；v0.60 号已重新分配给 §4.4.4）

> **规划基线(v0.56 规划时)**：v0.55.0；694 项回归全绿；四后端（tree / VM+wasm / VM-only / C）；CI 矩阵就位；能力矩阵 51 行 ≈81%。**v0.56 收口实测(2026-11-12)**:764 项回归全绿、§60 70 项、能力矩阵 52 行 ≈81%（新增 WASM 覆盖面行）。**v0.57 收口实测(2026-11-13)**:791 项全绿、§61 27 项、覆盖率基线 93.0% 行/86.1% 函数、能力矩阵 52 行 ≈81%(无新增行)。
> **规划立场**：本阶段的目标不是继续加语言面，而是**把已有能力做成可放心使用的工程品**——
> 先清零语义一致性缺陷，再把证明推进到最高频的真实形态，然后补开发者体验与分发，
> 最后才用 ADR 评估新的语义面（服务端/async、污点即效应、mask）。每版一个主题、可独立回退。

### 4.3.1 进度判断（精读结论）

**已兑现（v0.39–v0.55，测试可证）**

- **语言内核成熟**：显式类型/无 null/值语义/效果系统/确定性；契约三层（运行时 M4015 + 编译期 M3040–M3046 + 静态证明 M3042/M3045/摘要）。
- **四后端合同**：树/VM+wasm/VM-only/C 差分是语义合同；C1–C5（数值、str/Vec/Map/Option、FFI、unsafe）；wasm 分层 + strict 三态。
- **工程基线**：CI 九组合 + C 腿 + nightly；构建键可信（项目相对路径 + 内容 + Node 主版本）；env -i 产物验收；694 项回归 + 差分模糊 + 证明模糊。
- **自举生态**：12 个 Ming 自写工具日用（`ming tools`）；诊断码 71 个带 hint/fix；LSP 诊断+hover；REPL。
- **量化**：源码 16.8k 行 JS（checker 5.0k / interp 3.0k / cbackend 1.9k / wasm 1.8k / compiler 1.2k / parser 1.1k / vm 0.9k）；测试 6.0k 行；自举工具 1.8k 行 Ming。bench（本机）：fib(24) VM 86ms / cc 7.75ms（11x）；百万循环 163ms / 8.57ms（19x）。

**主要不足（按影响排序）**

| # | 类别 | 不足（证据） | 处置 |
|---|------|--------------|------|
| 1 | 语义一致性 | **#23/#28 tree 作用域泄漏**：块/for-in 的 `let` 遮蔽在 tree 引擎泄漏到外层（实测 `let i=100; for i in 0..3 {}` → tree 2 / VM 100；if/unsafe 块同根因）。违反硬规则 1（三引擎一致） | **v0.56 必修** |
| 2 | 默认引擎崩溃 | **#24 VM 捕获闭包 + HOF**：`v.map((x) => x * k)` 捕获外部变量 → `TypeError: Cannot read properties of null`，exit 2（tree 正常）。默认引擎受影响，AI 高频形态 | **v0.56 必修** |
| 3 | 解析歧义 | **#33 requires/ensures 以裸标识结尾**：`requires buf.len() == n {` 把 `n {` 当结构体字面量 → M2001「字段名不能是关键字 return」；加括号可绕过。自然契约写法被拒 | **v0.56 修** |
| 4 | 验证盲区 | **#25 fuzz 的 wasm 腿从不真实执行**：生成器 main 恒带 io，wasm 只覆盖 VM 回落路径；v0.53 尾表达式修复的“wasm 首次真实执行”无差分覆盖 | **v0.56 修** |
| 5 | 构建可信性 | **#26 buildKey 不含编译器 `src/*.js`**：版本号未变时改编译器会脏命中缓存 | **v0.56 修** |
| 6 | 工具链毛边 | #22 fmt else 头注释仍需两遍；#29 launcher 源码模式 panic 无位置；#30 extern fn 值局部调用 C 不支持；#31 proof-report 多入口重复；#32 摘要对所有 run 无条件计算 | v0.56 清 P2/P3 |
| 7 | 证明覆盖 | 只做直线体；**最高频形态 `for i in 0..len { buf[i] }` 未证明**（Backlog 已列） | **v0.57** |
| 8 | 日常体验 | LSP 只有诊断+hover（无补全/跳转/符号）；字符串拼接 O(n²)（无 Builder）；二进制 I/O 无流式/随机访问 | **v0.58** |
| 9 | 服务端/并发 | 无 TCP/UDP/HTTP server；async 未设计（北星支柱 3） | **v0.59 ADR 先行** |
| 10 | 安全工具面 | 污点即效应/mask 裁决完成（北星支柱 6） | **✅ ADR-002/003 已交付** |
| 11 | 工程观测 | 无行覆盖率指标；bench 仅信息性无基线；checker.js 5.0k 行单体 | §4.3.8 逐版处理 |
| 12 | 文档/编号 | 测试分节号重复（两个 34–38、缺 40）；plan §4.2.10 的 v0.52 引用误写 §54（实际 §56） | v0.56 清理（#34/#35） |

### 4.3.2 规划原则

1. **先一致性，后能力**：违反三引擎合同的缺陷（#23/#24/#28）优先级高于任何新语义面。
2. **证明只报告，不删检查**：静态证明永远不消除运行时 M4003/M4015（除经 ADR 与单独版本）。
3. **一个新语义面一个 ADR**：服务端/async、taint、mask 先设计文档与评审清单，再谈实现。
4. **零依赖与确定性不交换**：不引入 npm/包注册表；CI 只用官方 action；新能力不得依赖时间/随机/哈希序。
5. **每版可独立回退**：任务粒度的验收与风险表；沿用「实现 + 分节测试 + 文档三处 + 版本三处同步」纪律。

### 4.3.3 v0.56 — 引擎一致性与缺陷清零（质量版，无新语言面）✅(2026-11-12 完成)

**目标**：清零全部 P1/P2 已知缺陷，让“默认引擎”与“对照引擎”都可以放心日用；补上验证盲区。

**任务**(全部完成,2026-11-12 收口)
1. ✅ **tree 作用域模型统一（#23 + #28，同一根因）**：树引擎每次进入块（if/while/for/loop/match arm/unsafe/sync scope）建立子环境（父链查找），`let` 只写当前块；for-in 循环变量每迭代为内层绑定，循环结束恢复外层。范围：仅作用域语义修复，不改闭包捕获语义；C 后端已按块修复（v0.54 B2），补 tree/VM/cc 三方对照。**代价实测**:tree bench +5–32%(循环项最大,每迭代 env 分配;VM/cc 不受影响)。
2. ✅ **VM 捕获闭包 + HOF（#24）**：`vm.js` 的 `callClosure` 经 `vecMethodImpl` 调用捕获闭包时漏传 `captures` → 默认引擎 `TypeError: Cannot read properties of null`;一行修复后捕获/非捕获/多层闭包在 `map/filter` 类 HOF 上 tree/VM 逐字一致。
3. ✅ **契约尾部标识歧义（#33）**：`requires/ensures` 子句改用专用解析模式 + struct literal 前瞻(仅当表达式以裸标识结尾时判定 `{` 为函数体);普通表达式位置的 struct literal 与空结构体 `S {}` 用法不变;裸标识/加括号两写法等价 + fmt 不变。
4. ✅ **fuzz 真实 wasm 腿（#25）**：程序生成“纯 helper（eligible）+ 带 io 的 main 调用它”；wasm 腿对 eligible helper 断言 `MING_WASM_DEBUG=1` 下 `[wasm] fn <名> OK` 且无“实例化失败/REJECT”（§32 门禁同款），汇总新增“wasm 真实执行 N”计数(本机三种子实测 **20/16/18**)。
5. ✅ **buildKey 补编译器源（#26）**：键加入 `compilerSourceHash`(**src/*.js + bin/*.js** 排序内容 sha256;bin/ming.js 的 launcher/build 逻辑同样影响产物——本版 #29 正是它);`build --json` additive `compiler_hash`;`build_key` 语义不变。敏感性回归:复制编译器到临时目录改 src/bin → 键变化、恢复源 → 键恢复。
6. ✅ **工具链毛边**：#22（else 头行尾注释一遍到定点）、#29（launcher 源码模式 panic 带 `file:line:col` 与源码摘录;AOT 模式逐字不变）、#30（extern fn 值经局部变量:C 后端发射期**明确诊断**而非“let 推导 null”,选方案 b）、#31（proof-report 按记录自带绝对路径去重:同显示名不同目录不合并）、#32（无契约模块跳过摘要构建；有契约模块保持现行为）。
7. ✅ **编号与引用清理（#34/#35）**：tests/run.mjs 分节号唯一化(重复 34–38 → 34b–38b、补 §40,文件头索引说明),plan/GUIDE 引用同步;不改测试内容。
8. ✅ **本地函数显式拒绝（#37/#38 → #44）**：v0.56 由检查器在声明处统一报 **M3047[local-fn-unsupported]**(error)——VM/字节码编译器尚无本地函数编译路径(此前默认 VM 直接 TypeError、作值使 tree/VM 分歧、契约被 tree 静默忽略);`check`/`run`/`run --tree`/`cc` 同一门禁,本地函数作值与带契约形态由声明处同一诊断拦截。实现后移除拒绝并恢复 GUIDE 表述(plan §5.1 #44,v0.57 后)。

**验收(2026-11-12 实测)**：`node tests/run.mjs` **764 项 0 失败**(§60 共 **70 项** v60.*:tree 作用域 9 + VM 捕获闭包 3 + 契约歧义与 fmt 保真 13 + buildKey 3 + fuzz wasm 1 + wasm 语义修复 10 + 工具链 10 + 独立审查 A 组 12 + B1/B6 2 + cc 对照 1 + 复审 C1/C2 6);三引擎遮蔽/闭包/HOF/契约歧义用例全部一致;`fuzz --seed 44044 --count 40` 40 程序一致、0 分歧(C 腿 6),wasm 真实执行 20 程序(三种子记录 20/16/18);`proof_fuzz --mode all --count 100` 三模式 0 误报(模式 1 100 例误报 0、模式 2 反例验证 18/18、summaries 100 例误报 0/反例独立验证 24/24);tree bench 如实记录 +5–32%(循环项最大,语义修复代价);**存量 P1/P2 清零**(#23/#24/#25/#28/#30/#33 全修;#22/#29/#31/#32 修)。收口时新登记 #37–#43;独立审查后 #37/#38/#39 已收口,新登记 #44–#47(见 §5.1;wasm 回落形态不影响语义正确性,strict 模式可见)。

**v0.56.0 独立审查修复(A/B 组,2026-11-12)**:A 组——B3 契约作用域(body `let` 遮蔽不影响 ensures、形参名 `result` 与 body `let result` 语义、mut 形参最终值;三引擎 M4015 逐字一致)、u64 一元负号 M3008 类型层拒绝、u64 二元减法下溢四引擎 M4002、fmt 契约破坏三修(lambda 立即调用保括号/内联块未知语句失败不落盘/else 插值消息逐字保留;空结构体与转义规范化);B 组——**B1** proof/summary 记录携带 `abs`,报告按 `abs+fn` 去重(同显示名不同目录双模块各一份;文本/JSON 一致)、**B2** `compilerSourceHash` 纳入 `bin/*.js`(单独改 bin 键变/恢复键恢复;旧缓存自然失效)、**B6** 本地函数声明统一 **M3047** 显式拒绝(VM 不再 TypeError;作值/带契约形态同拦截;`check`/`run`/`--tree`/`--no-wasm`/`cc` 同一门禁)。MINOR:capabilities WASM 行移除 `match` 声明、GUIDE/moltbook §34b–§38b 引用校正、#40/#42 措辞按实测修正、v60.27a/v53.27 注释与断言更新、契约重复子句"后者生效"写入 GUIDE、§60 增加 cc 对照、新登记 #45/#46。验收:764/0;`fuzz --seed 44044 --count 40` 0 分歧且 wasm 真实执行 >0;`proof_fuzz --count 100` 0 误报。

**v0.56.0 复审修复(C1/C2,2026-11-12)**:C1——ensures 表达式自身作用域恢复可解析(VM 编译器 `compileContractExpr` 记录 `contractScopeBase`;解析顺序 `result` → 契约内部作用域(match 臂变量/if 块 let)→ 形参;函数体作用域与捕获仍不可见;契约内臂变量与形参同名按词法遮蔽优先,与 tree 一致);C2——闭包/本地函数子帧显式 `resultSlot=null` 且 Return/PostQ 判定改 `!= null`,其 `return` 不再把外层 ensures 编译进子帧(此前 VM 报 M4001)。§60 新增 v60.54–v60.59(v60.52 补 cc 入口断言);tree 契约表达式内嵌块尾值重入 checkEnsures(M4005)为 HEAD 既有缺陷,登记 §5.1 #47(P3)。

**风险/回退**：tree 作用域改动面覆盖全部树引擎测试，可能暴露依赖泄漏的既有用例（逐条审阅，修正用例而非掩盖）；VM 闭包修复涉及帧布局（保持字节码不变，仅运行时帧解析）；契约歧义修复必须保证普通 struct literal 无误伤（正反例双向锁定）。

**明确不做**：不新增语言关键字/语法；不改运行时检查；不做性能优化（除修复顺带）。

### 4.3.4 v0.57 — QF_LIA 第四片：循环/守卫敏感边界证明 ✅(2026-11-13 完成)

**目标**：把 v0.52 的直线体边界证明推进到**最高频真实形态**：范围 for 内的 `buf[i]`。

**范围**：i64 范围 for（上界为常量或非 mut Vec 参数 `len()`）；循环体为直线体；单个索引点；非 mut `Vec[i64]` 参数；`while i < len` 的单条件守卫作为第二子目标（可选，不承诺）。**不做**：任意循环不变式注解、嵌套循环、循环内改长度、分支敏感、通用 SMT。

**任务**(全部完成,2026-11-13 收口)

1. ✅ **prover 扩展区间约束**：实现落点为 checker 侧义务附加假设(extra)——循环变量绑定确定性符号 `i$<n>`,区间两条线性约束 `lo <= i$<n> < hi` 并入该义务假设集后与既有差分约束**同一求解器**合并求解;`prover.js` 求解器**零改动**(与"只报告不改 codegen"的 ADR-003 立场一致);超范围/非线性 → 放弃。
2. ✅ **checker 循环义务**：范围 for 的每次迭代假设 `lo <= i$<n> < hi`(半开);上界映射到 `len$buf` 时即得 `i < len$buf`;`0 <= i` 由 lo 推出;循环变量被重赋值(类型层 M3004)/体内改写外层变量/藏分支(脏循环)→ 该 for 之后保守放弃。规划中的"break 带值"在 Ming 无此形态(break 不携带值),实测 break/continue 不破坏不变式 → **允许存在**(其后语句不可达即停止收集,已收集义务保留)。
3. ✅ **诊断复用**：可证违反 → M3045(码/消息不变)+ 反例(枚举含循环符号 `i$N` ∈ {-2..10},≤2 个);未证明默认静默,`--warn-unproven-index` 下 W3105(循环义务同口径);proof-record 增加 additive `scope: 'body' | 'loop'` 义务统计。
4. ✅ **测试 §61**（实测 27 项 ≥12）：A 组 v57.1–v57.19 覆盖 `for i in 0..buf.len()` proven / `for i in 1..len` 下界 / `for i in n..len` / `for i in 0..n` + `requires n <= buf.len()` / 未证明静默 + W3105 / 上界 `n+1` 可证违反(反例 `len$buf = 0, i$0 = 0`) / 低侧越界(`i$0 = -1`) / 循环变量重赋值 M3004 / 嵌套 for 放弃 / while 守卫静默 / `buf[i+1]` 位移 / 改写外层 mut 变量 for 后放弃 / 双循环 / break-continue / 空洞区间 / 契约调用不回归 / 混合 scope(loop+body);B 组 v57.20–v57.25(tools AOT 缓存)+ C 组 v57.26–v57.27(观测冒烟)见 §4.3.8;`proof_fuzz --mode loops --count 200` 0 误报(可证 100 / 静默 50 / 违反 50;违反类反例独立求值器**三重验证**:满足 requires + 落在循环区间内(区间非空)+ 索引确实越出义务侧;可证类逐条双引擎运行验证)。
5. ✅ **文档**：GUIDE 静态边界证明节补循环形态与放弃路径、`ming tools` 行补 AOT 缓存、修订记录/路线图;能力矩阵契约/证明行补循环形态(随 2026-11-13 收口落盘)。

**验收(2026-11-13 实测)**：`node tests/run.mjs` **791 项 0 失败**（§61 共 27 项 ≥12）；`proof_fuzz --mode loops --count 200` 0 误报;codegen 零改动（compiler/interp/vm/cbackend/artifact 与 prover.js 求解器对 HEAD 无 diff）;性能:check examples 三文件语料 7 次中位 **132ms** vs HEAD(d438aff/v0.56.0)**137ms**(0.96x,≤1.3x 达标;同机 Node v24,信息性);既有 §56/§59 全绿。

**风险/回退**：循环上界含调用/别名/重赋值 → 保守放弃；若证明器复杂度失控，退回“只支持 `0..len` 直接形态”，其余静默。

### 4.3.5 v0.58 — AI 协作体验与文本工程（开发者体验版）✅（2026-11-13 交付）

**目标**：把“AI 生成 → 检查 → 修正”的循环摩擦再降一档，并补文本工具的实用性能面。

**任务**

1. ✅ **LSP 扩展**：补全（标识符/字段/方法/关键字）、跳转定义、文档符号；保持同步、零依赖、单文件协议实现；对泛型/多文件保守（宁可少补，不可错补）；§62 协议测试扩充（**实测 34 项**,A 组 16:LSP 直连 + 管道协议）。**A 审查修复**:坏 JSON 体存活(不再 ReferenceError 杀进程)、块注释内不补全(嵌套深度按 lexer 语义)、第三式中间态补全;既有 P1 修复(非 ASCII 字节分帧)回归锁定。
2. ✅ **`std.str.join`（Builder → join 架构调整,如实记录）**：原计划 `std.str.Builder`（push/append/to_str），实现改为 **`use std.str;` + `str.join(Vec[str]) -> str` 纯函数**——单次 O(n) 拼接达到同一目标（消除 `+` 循环的 O(n²)），不动语法面、无需 C 后端资格决策（`str.join` 所在函数非直接调用形态 wasm REJECT（`--strict-wasm` 可见回落）、C 后端 C1 发射期显式拒绝，不进资格面）；tree/VM 一致；10 万元素量级拼接 O(n)（§62 v58.19 以 1000 元素 + `byte_len` 断言覆盖语义与规模,bench 专项未单列——join 为单次调用,无累积状态）。**与 Vec 方法 `join` 的 API 不对称与分配记账差异如实登记**（§5.1 #49:`v.join(sep)` 计费 vs `str.join(v)` 不计费）。
3. ✅ **`ming doc --json` 稳定 schema + `ming doc --index`**：把 `///` 文档变成机器可消费的索引（AI 检索用）；additive，不改默认文本输出。**--index 已实现（v0.58）**：`ming doc f1.ming f2.ming ... --index` 聚合输出 `{ok, files: N, items: [...每项前置 file 字段,其余与单文件 item 同形...]}`；单文件加 `--index` 输出同 schema（天然兼容）；无 `--index` 保持单文件命令（只处理第一个）；读失败/解析诊断错误路径与 `--json` 协议一致（fail-fast）。**C 审查 MINOR 已修**:impl 方法签名补 `with` 效果与 requires/ensures。
4. ✅ **Release 分发**：tag 触发 GitHub Release 打包 zip（bin/src/tools/examples/docs/GUIDE/README；零 npm、官方 action）；不承诺安装器/包管理器。**实现口径**:release.yml 只产出 workflow artifact(`ming-<tag>` zip,无双 v)——**不自动创建 GitHub Release**(第三方 gh-release action 违反“只用官方 action”纪律,由维护者手动附 artifact);含版本三处一致性 + 零 npm 依赖校验步骤;`docs/release.md` 流程文档落地。
5. ✅ **测试 §62**（实测 **34 项** ≥15）：LSP 补全/跳转/符号（直连 + 管道协议双路径）；join 双引擎 + 大输入断言；doc JSON schema；Release workflow 结构静态校验。
6. ✅ **文档**：GUIDE 命令表 LSP 行（v0.58 三新查询 + 字节分帧 + 坏 JSON 存活）、doc 行（--json/--index）、新增 std.str 节（join 语义/API 不对称/#49 记账差异）、修订记录 v0.58.0、路线图 v0.58 行；能力矩阵更新（流式拼接行 Builder→join 口径、LSP 行细化）；README 路线图 v0.58.0 + 状态段。

**验收（2026-11-13 实测）**：`run.mjs` 0 失败（**825 项**全绿,§62 共 34 项）；LSP 会话测试通过（直连 16 + 管道 4 会话）；join 双引擎输出一致（O(n) 单次拼接）；doc JSON additive（无旗标输出与 v0.57 逐字一致,§62 v58.32 黄金锁定）；fuzz 40 程序 0 分歧;proof_fuzz 0 误报;零新依赖。

**风险/回退**：补全对泛型/模块解析易错 → 保守策略与开关（已按保守策略交付）；Builder → join 架构调整后为纯 std 函数,不动语法（可整体回退）。

### 4.3.6 规划槽位（原 v0.59）— 服务端与并发：ADR 先行（条件承诺）✅（2026-11-13 完成，实际随 v0.59.0 交付）

**目标**：在“确定性 + 效果门禁 + 零依赖 + 四后端”约束下，给出服务端/并发的可信设计，而不是先写实现。

**任务**

1. ✅ **ADR-001（async/服务端选型）**：`docs/adr-001-concurrency.md`(275 行)——三方案评分 a=28 / b=16 / c=14,选定 **方案 a(worker-per-connection 阻塞模型)**;确定性口径收窄(审查 MAJOR-1:响应内容=f(请求)+spawn_all 输入序聚合+逐 worker 配额隔离;time/rand 声明者除外);(c) 真实破绽改为共享配额/syncTasks/io 无捕获(审查 MAJOR-2);监听地址 v1 固定 127.0.0.1(审查 MAJOR-4);评审清单 **16 项**。
2. ✅ **原型实验**：§2.4 Node 原型实测(审查 MAJOR-3 补齐任务书义务)——10×100:162 req/s、16×100:**181 req/s**、40 连接超订阅:190 req/s;p50 61–207ms;错误率 0%;容量公式 16+256=272 逐字成立(503 恰 272/28 拒);504 硬杀 8/8 名额释放;内存 commit 421MB/WS 343MB(16 worker;32MB SAB 预留 ×16 解释差值)。
3. **实现推迟**：按 ADR 结论"条件承诺实施"——serve 实现待评审清单 16 项逐项裁决(其中监听地址/worker 启动失败为审查新增);此前不写实现。
4. ✅ **文档**：ADR 完成;plan §4.3.9/§4.3.10 与 Backlog 本收口回写;GUIDE 服务端节随实现交付(未实现,暂缓)。

**验收（2026-11-13 实测）**：ADR + 评审清单 16 项完成；审查 4 MAJOR 全修后通过；"若不实现,plan 明确记录结论"已满足(条件承诺+推迟条件)。

**风险/回退**：方案 b/c 否决理由归档于 ADR §2.2/§2.3;阻塞模型并发上限已量化(16 并发饱和、队列 256 最坏排空 1.4s)。

### 4.3.7 规划槽位（原 v0.60）— 安全工具面研究项（污点即效应 / mask）✅（2026-11-13 完成，实际随 v0.59.0 交付；v0.60 号已重新分配给 §4.4.4 资源门禁一致性）

**目标**：评估北星支柱 6 的下一块（数据流安全），保持“签名可见”的哲学底线。

**任务**

1. ✅ **ADR-002（taint-as-effect）**：`docs/adr-002-taint.md`——**结论:采纳类型级方案 `Untrusted[T]` + `std.unstr` 净化族;"污点即效果"建模否决(终局)**。机制依据:效果系统查"调了谁"不查"值流向";净化方向性在函数级对称效果集不可表达;效果建模下契约被切断(实测 M3029);类型方案运行时擦除、四后端零改动(唯一改动面 = checker sig/wasm.js numOk 解包)。13→16 项评审清单(独立审查补:资格裁定/工具联动/Err 载荷漏报窗口)。
2. ✅ **ADR-003（mask 决策）**：`docs/adr-003-mask.md`——**结论:永久否决**。与第一原则结构性冲突;与 M3029 推导/契约纯性/资格面/函数值携带效果四机制逐项冲突(实测支撑);动机消失(无 File/Lib 句柄;Join[T] 已被线性纪律解决);"仅入口 mask"变体一并否决;design §6.11 存档标注。9 项评审清单。
3. **原型**：taint 实现推迟(条件 = ADR-002 评审清单逐项裁决 + 破坏性变更窗口);mask 无原型(否决);§64 不成立(无实现)。

**验收（2026-11-13）**：两份 ADR + 评审清单(16/9 项)完成；审查对否决/采纳的对抗性质疑全部收敛；"不落地则 plan 记录结论与理由"已满足(本节即记录)。

**风险/回退**：taint 与值语义/深拷贝交互已论证自洽(拷贝保污点=类型恒等式;唯一洗衣通道 bytes.to_str 已入漏报窗口)；mask 否决永久生效。

### 4.3.8 跨版本技术债与观测

| 项 | 内容 | 版本 | 说明 |
|----|------|------|------|
| 覆盖率观测 | `tests/coverage.mjs`（`NODE_V8_COVERAGE`，零依赖）报告 `src/*.js` 行/函数覆盖 | **✅ v0.57 交付**(2026-11-13) | 首个基线 **93.0% 行 / 86.1% 函数**（15 文件;764 项插桩全绿 6.4 分钟,Node v24 win32-x64),写入 docs/coverage-baseline.md(含 range 近似口径说明);信息性指标，不设门槛；先建立基线再谈阈值。备注:工具"始终 exit 0"**非无条件**——`mkdtemp` 临时目录创建在 try 之外,失败会 exit 1(概率极低,信息性,不改代码,见 §5.1 备注登记) |
| wasm 剩余回落形态 | **✅ v0.59 已收口 #40/#41/#42/#43/#45/#46 + 6 潜伏 bug(A–F;见 §4.4.3);剩余守护具名**:VecLit 数值元素(容器表示未统一)、Vec 下标读 / mut 元素写(宿主 `panic_m4003` 导入待补)、Option 消费链(宿主 M4006/M4007 导入待补)、f64 复合赋值等 | **✅ v0.59 交付**(2026-11-13) | 已声明覆盖扩至 f64 局部/Map 形参/str 返回/值型 if/尾 if;strict 120 语料 fallback=0;保留守护在 strict 下 exit 2 且原因具名(§63 v63.19);P1 报告逐文件登记 15 个具名回落语料文件 |
| bench 基线 | `tests/bench.baseline.json` + 阈值告警（如 cc/vm 比值回退 >20% 告警） | **✅ v0.57 交付**(2026-11-13) | bench 输出 Δ基线列;cc/vm 加速比回退 >20% WARN 仍 exit 0(不阻断 CI);`--write-baseline` 刷新。备注:基线数字为**快照口径**(meta.date 标注时点,同机 + 同 Node 主版本对比;重跑 `--write-baseline` 刷新,见 §5.1 备注登记) |
| checker 拆分 | 契约/证明适配从 checker.js（5.0k 行）迁到 `src/contracts.js`（纯重构，零行为变化） | v0.57–v0.58 择机 | 以全量回归绿为唯一验收；不追求行数指标;v0.57 覆盖率基线(checker 93.4% 行/90.1% 函数)可作重构安全性参考线 |
| 文档结构 | GUIDE 1.1k 行补目录/交叉引用；不重写 | v0.58 | 降低 onboarding 摩擦 |
| 安全审计 | unsafe/ffi 的“已声明覆盖/不覆盖清单”每 4 版复核一次 | 随版（2026-11-13 三方评估已复核） | 与能力矩阵同步 |
| `ming tools` 调用开销 | 每次调用重新 check+编译工具本体,超出 Node 基线约 **57ms**(宿主 coreutils ~15ms);AOT 缓存(键 = 版本 + 工具源哈希)目标 **<20ms** 额外开销 | **✅ v0.57 交付**(2026-11-13) | 12 工具全缓存零回退(键 = VERSION + Node 主版本 + compilerSourceHash + 工具 basename + 源文本;原子写;span/declSpans 回填 panic 逐字对齐;旁路旗标不缓存;损坏自愈;`MING_TOOLS_DEBUG=1` 观测)。**实测净开销 ~25–30ms/次,目标 <20ms 未完全达标(如实注明)**;对无缓存路径净改进 12–19ms/次;剩余地板 = bin 顶层导入 ~9ms + 核心模块图 ~15ms,进一步需 src 级瘦身(另行登记);缓存落地后重跑审计对照**待办保留**(docs/usage-audit.md §4) |

### 4.3.9 明确不做（v0.56–v0.59）

- 不做包管理注册表/第三方依赖；不做跨 OS/跨架构交叉编译；不做 GUI；不做交互式调试器（留 Backlog）；不做 eval/热重载。
- 不做完整 SMT；证明只在线性/区间子集内推进，超出即静默放弃。
- 不删运行时边界/契约检查；proven 只报告。
- async 运行时与 HTTP server：ADR-001 已裁决方案 a（worker-per-connection）条件承诺实施——实现待评审清单 16 项逐项裁决，在此之前不写实现。
- mask 永久不做（ADR-003）；taint 效果建模不做、类型级 Untrusted[T] 方案已裁决采纳（ADR-002），实现推迟至评审清单 16 项裁决。
- 不改已发布诊断码；新增字段一律 additive；零 npm。

### 4.3.10 成功度量

| 版本 | 完成判定（全部满足） | 量化门槛 |
|------|---------------------|----------|
| v0.56 | **✅(2026-11-12 实测)**:三引擎作用域/闭包/HOF 一致；契约尾部歧义修复；fmt 契约保真；fuzz 真实 wasm 腿；buildKey 含编译器源(src+bin)；存量 P1/P2 清零；独立审查 A/B 组修复(契约作用域/u64/fmt/#31/#26/M3047)；复审 C1/C2 修复(ensures 内嵌作用域/闭包 return)；#37/#38/#39 收口，新登记 #44–#47 见 §5.1 | §60 实测 70 项(≥15)；回归 **764 项**全绿(≥715)；fuzz 40 程序 0 分歧、wasm 真实执行 20(三种子 20/16/18)；buildKey 敏感性覆盖 src 与 bin；proof_fuzz 三模式 0 误报(实测模式 1 100 例/模式 2 反例 18/18/summaries 100 例 0 误报) |
| v0.57 | **✅(2026-11-13 实测)**:范围 for 内 `buf[i]` 两向可证明(循环符号 + 区间假设;脏循环/嵌套/while 保守放弃);tools AOT 缓存 12 工具全缓存零回退(热缓存净 ~25–30ms,目标 <20ms 未完全达标如实注明);覆盖率基线 93.0% 行/86.1% 函数;bench Δ基线 + 回退 WARN;codegen 零改动 | §61 实测 27 项(≥12);**791 项**全绿;proof_fuzz loops 200 例 0 误报(反例独立求值器三重验证);check 语料 0.96x HEAD(≤1.3x 达标);既有 §56/§59 全绿 |
| v0.58 | **✅(2026-11-13 实测)**:LSP 补全/跳转/符号可用(保守策略,§62 直连+管道 16 项);`std.str.join` O(n)(Builder→join 架构调整,如实记录);doc JSON additive(文本黄金锁定逐字不变);Release 打包(artifact + 手动 Release 决策,docs/release.md) | §62 实测 **34 项**(≥15);回归 **825 项**全绿;fuzz 40 程序 0 分歧;proof_fuzz 0 误报;无旗标 doc 输出逐字不变;零新依赖 |
| 原 v0.59 槽位 | **✅(2026-11-13 实测,实际随 v0.59.0 交付)**:ADR-001 完成,方案 a(worker-per-connection)条件承诺实施;确定性口径收窄、(c) 真实破绽重写、监听地址 127.0.0.1、原型实测 190 req/s@40 连接 | ADR 评审清单 **16 项**(全有默认值);实现待清单逐项裁决;实现时 **§66** ≥12 + 三引擎拒绝一致(serve 已移至 v0.62 条件版,见 §4.4.6) |
| 原 v0.60 槽位 | **✅(2026-11-13 实测,实际随 v0.59.0 交付)**:ADR-002(taint 类型级方案采纳,效果建模否决终局)+ ADR-003(mask 永久否决)完成;实现推迟均有条件与理由 | ADR 评审清单 16/9 项全有默认值;实现时 **§65**(污点)/**§66**(serve) ≥12;v0.60 号已重新分配给资源门禁一致性(§4.4.4) |

**跨版本共同门槛**：`node tests/run.mjs` 0 失败；`fuzz` 0 分歧；新增分节测试；GUIDE 修订记录 + README 路线图 + plan 已完成项移动；版本三处同步；诊断码三处登记；不留下未提交生成物；性能数字来自可复现命令。

---

---

## 4.4 v0.59–v0.62+ 规划（software-architect 精读第二轮；2026-11-13 三方评估修订）

> **规划基线**：v0.59.0（HEAD 9251e08）；**881 项回归全绿**；四后端 + LSP 三查询 + 本地函数 + wasm 覆盖收口 + 契约三层证明（直线体 + 范围 for）；覆盖率实测 **93.5% 行 / 88.3% 函数**（2026-11-13 复测；vm.js 函数 **63.8%**——旧数字 43.8% 已作废，见 §4.4.10）；ADR-001/002/003 已交付（并发选型 / 污点 / mask 三项裁决完成）。
> **修订说明（2026-11-13）**：software-architect / security-engineer / minimal-change-engineer 三方独立评估后，v0.60 由"服务端条件交付 + 覆盖率补测 + checker 拆分"改为**资源门禁一致性**——安全侧实测 `--max-ms`/`--max-alloc` 的承诺可被阻塞内建与外部输入绕过（P1）；serve 独立为 v0.62 条件版；污点缩窄为 v0.61 窄源条件版（9 源全量会让 5 个自写工具直接不可写）；checker 拆分/覆盖率门槛/while 证明移出近三版。评估记录与实测证据见 §4.4.10，缺陷登记见 §5.1 #51–#57。
> **规划立场**：§4.3 清空后，最大的债不在"缺能力"，而在**默认引擎优化层的覆盖面**——真实程序形态（f64 局部、Map/str 签名、值型 if、块尾 if、str 返回）在 wasm 仍是回落；**文档化特性仍在被拒绝**（#44 本地函数）；**配额门禁仍有引擎分歧**（#48/#49 记账）。先把这三件事做成"默认引擎全面性"版本（v0.59），再走污点（v0.61 窄源条件）与服务端（v0.62 条件）的交付。

### 4.4.1 现状判断（精读结论）

**已兑现（v0.56–v0.58，测试可证）**

- **引擎一致性清零**：tree 作用域统一、VM 捕获闭包 HOF、契约作用域双引擎闭合、wasm 四个语义 P1、u64 一元负号/减法四引擎统一。
- **证明三层**：直线体 M3042 → 范围 for 循环义务 M3045（`--mode loops` 200 例 0 误报）→ 跨函数摘要 M3041 扩展；proof_fuzz 四模式。
- **可观测性**：覆盖率基线（93.0% 行 / 86.1% 函数，15 文件）、bench 基线（Δ列 + WARN）、fuzz 真实 wasm 腿（strict 存活断言）、strict-wasm 三态。
- **工具链**：`ming tools` AOT 缓存（净 25–30ms，原 57ms）、LSP 补全/跳转/符号 + 字节分帧修复、doc --json/--index、Release 打包。
- **ADR 三裁决**：并发方案 a 条件承诺（原型 190 req/s@40 连接）；污点类型级方案采纳（效果建模否决终局）；mask 永久否决（四机制冲突逐项实证）。

**主要不足（按影响排序）**

| # | 类别 | 不足（证据） | 处置 |
|---|------|--------------|------|
| 1 | wasm 覆盖面 | **#40 locals 索引偏移**（f64 局部/Map 字面量 → 违规函数 REJECT）/ **#42 Vec 形参组合 locals 错位** / **#45 值型 if blocktype 编码失败** / **#46 块尾 unit if 按值编译**——默认引擎对真实程序形态（f64 数值代码、`while { if c { break; } }` 尾形态）仍回落 JS | **v0.59 必修** |
| 2 | 本地函数 | **#44 VM 无本地函数编译路径**——文档化特性被 M3047 显式拒绝（v0.56 起）；契约被 tree 静默忽略（tree 支持、VM 崩溃的历史） | **v0.59 必修** |
| 3 | 分配记账 | **#48 wasm str_cat 不计费**（M4011 引擎分歧，#40–#46 修复后从潜伏变可达）/ **#49 std.str.join 不计费**（与 Vec join 计费不对称） | **v0.59 统一** |
| 4 | 资源门禁 | **S1/S2 实测**：`--max-ms` 被 sleep/join 绕过（3.2s @100ms）；`--max-alloc` 对 fs/stdin/proc/net 外部输入与 wasm 参数搬运不计费（#51/#52/#53） | **v0.60 必修** |
| 5 | CLI 门禁 | **#54**：`ming test`/`ming init` 零 CLI 回归且旗标不传播（`test --no-wasm` 仍走 wasm；`test --max-alloc 5` 通过而 `run` 触发 M4011） | **v0.60 必修** |
| 6 | 服务端 | ADR-001 方案 a 条件承诺——评审清单 16 项未裁决；原型数据已备（190 req/s@40、0.9GB@16） | **v0.62 条件（独立版）** |
| 7 | 污点 | ADR-002 类型级方案采纳；**9 源全量会让 5 个自写工具直接 M3002**；五处补丁未落 | **v0.60 文档补丁 / v0.61 窄源条件（先 spike）** |
| 8 | 证明覆盖 | while 守卫证明（v0.57 可选子目标）未做；tree 契约求值重入 #47（P3，M4005，活分歧） | **#47 v0.60 必修；while → Backlog** |
| 9 | 测试缺口 | **vm.js 函数覆盖实测 63.8%（51/80）**，非 43.8%；26/29 未覆盖为 wasm 宿主导入闭包，40 opcode 是 `execLoop` 内 case——"opcode 直测"前提不成立 | 信息性，不设门槛 |
| 10 | 工程债 | **checker.js 5.3k 单体**（5,273 行/310 函数/90.3% 函数覆盖）；GUIDE 1760+ 行（目录已有，交叉引用未补） | 背景项，不进入版本 |
| 11 | 社区/观测 | usage 审计缓存后未重跑；覆盖率/bench 快照口径；覆盖率"始终 exit 0"非无条件 | 随版附注，维持 N-57.1 |

### 4.4.2 规划原则（沿用 §4.3.2 + 原新增两条 + 三方评估三条）

1. 先一致性/全面性，后能力；2. 证明只报告不删检查；3. 新语义面先 ADR；4. 零依赖与确定性不交换；5. 每版可独立回退；6. **新增**：wasm 专项以 `--strict-wasm` 全语料存活为验收工具（回落清零可度量）。
7. **新增**：覆盖率基线短板（函数覆盖 <70% 的文件）作为补测线索，随版收敛。
8. **修订（三方评估）**：一版一主题且可独立回退——质量/安全修正版不夹带新语义面（v0.60 门禁；serve 独立 v0.62）。
9. **修订（三方评估）**：计费口径单一事实——值创建 + 外部输入边界计费；派生值（deepCopy/json.parse/re.*/wasm 参数搬运）不重复计费（详见 §4.4.4）。
10. **修订（三方评估）**：指标不升格为门槛——函数覆盖率是信息性线索，不是版本门槛（40 个 opcode 是 `execLoop` 内 case，不是函数）。

### 4.4.3 v0.59 — 默认引擎全面性（wasm 覆盖收口 + 本地函数恢复 + 记账统一）— ✅ 已交付（2026-11-13）

**目标**：strict 模式下已知回落形态清零；本地函数从"拒绝"变"支持"；分配记账四引擎统一。**无新语言面**（本地函数是恢复既有文档化特性）。

**任务（✅ 逐项验收）**

1. ✅ **wasm locals/签名专项（#40/#41/#42）**：locals 声明改从 `nParams` 起（消除形参槽重复计入的类型错位）；Map/Vec[str] 形参经 `paramSlotTy` 登记 `mi64/mf64/mstr`，`__kh/k/v` 槽位补型；Vec 多枚/与 f64 组合随索引模型一并修复。**宿主补丁**：`map_get_i64`/`vec_get_i64` 返回 `BigInt(...)`、`wasmWriteVecNum` 认 `'float'`；删除 Vec[f64] 形参 / Map i64 for-in / Map i64 下标三处守护。strict 全 fuzz 语料 120 程序 **ok=54 / none=66 / fallback=0**——**计数为快照口径**（受生成器种子与 CCBIN 影响；实测其他种子出现 61/59、ok=70/none=50 等变体，`fallback=0` 是实质结论，计数本身不构成门禁）。
2. ✅ **wasm 返回与块形态专项（#43/#45/#46）**：`retNumTy` 映射 str→i32 句柄；值型 if 按**单字节 valtype** 发射（修 `sleb(0x7e)` 两字节错误）；块尾 unit 上下文 if 按语句编译（while/for/void/嵌套块尾可达）。
3. ✅ **分配记账统一（#48/#49）**：wasm `str_cat` 经 `str_len(l)+str_len(r)` → `ming_alloc` 计费（嵌套 11+15=26；plan §5.1 复现三引擎 M4011 累计 120000）；**插值与 tree/VM 一致不计费**；**BMP 口径差异**（`str_len` 码点 vs interp UTF-16 长度,代理对每字符差 1）与 **`--max-alloc` 内存风险**（bump 堆不回收,配额放大时驻留随拼接总量增长）如实登记。`std.str.join` 按结果长度计费（#49 对称化;紧配额下 M4011 与 Vec.join 一致）——§62 v58.29 断言按翻转后实际输出改写。
4. ✅ **本地函数恢复（#44，M3047 移除）**：VM `precompileLocalFns`/`compileLocalFn`（块级条目 + 递归自引用 + 兄弟互递归 + 契约按模块函数同口径 + 作值 LDFN→vclose + AOT 最小 entry.sig）；tree `callLocalFn` 补齐契约/兄弟可见性/作值调用；**三条限制**（不捕获外层局部 M3001 / 块级可见 / 泛型 M3048 与 cc `语句 FnStmt` 不支持）写入 GUIDE；M3047 废弃不再发射（号段保留）。
5. ✅ **测试 §63**（36 项 ≥24；P1 审查追加 9 项 → 45；P2 审查追加 11 项 → **56 项**）：P1 21 + P2 13 + P3 2 + P1 审查修复 9 + P2 审查修复 11（B1 兄弟契约/自引用 M4005、B2 lambda 本地函数、B3 遮蔽语义、B4 导入遮蔽、M3048、M4 strict、Some/Ok）；更新三条陈旧断言（v53.25 值型 if strict ok；v60.52 本地函数三引擎支持 + cc 仍拒绝；v63.30 泛型本地函数 → M3048）。
6. ✅ **P3 invariant bench**（§4.4.4 任务 4 前移落地）：`tests/bench.mjs` 第 5 项"契约 invariant 循环"（10,000×30 = 300,000 次 mut-self 退出 vs 无 invariant 对照）——VM 0.19–0.28µs/次、tree 0.20–0.28µs/次；基线新增 `invariant.vmUs/treeUs`。

**保留守护（不扩展,strict 具名）**：VecLit 数值元素（容器表示未统一）、Vec 下标读 / mut 元素写（宿主 `panic_m4003` 导入待补）、Option 消费链（宿主 M4006/M4007 导入待补）、f64 复合赋值等——P1 报告逐文件登记 15 个具名回落语料文件。

**v0.59-P1 独立审查修复（2026-11-13 追加，§63 v63.37–v63.45）**：① `<<` 结果溢出检查（wasm 移位后算术/逻辑右移回检；C 后端临时量 + 回检）——此前 wasm/C 静默回绕、tree/VM M4002；消息口径沿用既有约定（eligible/wasm 内通用文案，C main 内具体文案与 tree 逐字），码/退出码/位置三引擎一致。② M4007 三引擎逐字：wasm `map_get_*` 导入增 span 实参，宿主以 `debugStr` 引号 + 后缀 + span 组 Panic（`<unknown>:0:0` 消除）；M4011 经 `ming_alloc` 第二参 span 同步定位。③ VecLit/MapLit wasm 记账：按元素数经 `ming_alloc` 计费（与 interp 同口径），`--max-alloc` 下默认引擎不再绕过 M4011。MINOR：mut Vec for-in 后缀剥离（`vi64ptrm`→`i64`）、Vec[f64] 元素记账、Option 消费链回落原因具名、compiler 死代码删除、u64 ≥2^63 字面量 `BigInt.asIntN(64)` 编码（修 `extra bits in varint`），并补 i64.min（`-9223372036854775808`）字面量特判与越界字面量显式回落（防 asIntN 静默回绕；C 同口径）。回归 **870 全绿**。

**v0.59-P2 独立审查修复（2026-11-13 追加，§63 v63.46–v63.56）**：B1 本地函数 ensures 引用同块兄弟（`positive(result)`）——VM `compileContractExpr` 契约域放行 `contractFnBinds`（同块兄弟含自身；模块函数契约仍不可见函数体本地 fn，v0.56 A1 语义不变）；自引用 ensures 与 tree 同行为（无限递归 → M4005，两引擎首行逐字一致）。B2 lambda 引用外层本地函数——lambda 体经 `fnBinds` 静态解析为 LDFN（本地函数是全局函数表条目，无需闭包捕获），并修 tree `deepCopy` closure 丢失 `mod`/`localFns`（`env.mod.items` TypeError 根因）。B3 遮蔽语义定案：**同块 `let` 与 `fn` 同名 → M3009**（消除顺序敏感；同块重名本地函数同报 M3009）；**跨块 → 词法最近块胜**（内层 fn 遮蔽外层 let/形参，反之亦然）；checker `Scope.lookupValue` 按层交错解析（vars/localFns），compiler `resolveName` 同口径返回 `{kind:'fn'}`，三引擎统一。B4 本地函数遮蔽导入模块/模块项（`use std.math` + `fn math`）——checker `baseShadowed` 纳入 localFns 并报用户级 M3015（不再落 tree "内部错误:localfn 没有方法"）；compiler 导入/构造器/字段守卫改用 `resolveLocalName`。MINOR：① 同块重名本地函数 M3009（原静默后者胜）；② 泛型本地函数新增专用码 **M3048[generic-local-fn-unsupported]**（不再复用 M3003），块内调用点按毒化 never 签名收敛并消除 `str(...实际是 T)` 级联；③ **静态证明面不含本地函数**（M3041/M3042/M3045/W3105/`--proof-report` 只覆盖模块级函数）与"本地函数签名/契约不引用外层泛型参数或 `Self`"写入 GUIDE 第 (4) 条限制（不强行接入证明面：本地函数是独立帧、契约在运行时由 M4015 执行，静态证明需为每块建立独立义务域且与块级条目/互递归语义交叉，成本高于收益）；④ **M4** wasm.js `analyze` 形状阶段直接拒绝函数体含 `FnStmt` 的函数（`bodyContainsFnStmt`）——未被调用的本地函数声明不再使 strict 出现 fallback（三态口径统一；cc 仍按发射期 `语句 FnStmt` 拒绝）；⑤ 测试缺口修补：v63.29 断言改查 `run.stderr`、v63.32 断言构建日志含 `app.bytecode.json` 且无"回退源码模式"；⑥ `Some/Ok/Err` 裸调用特例先于名字解析（本地 `fn Some`/`let Some`）——compiler 加 `resolveLocalName` 守卫，本地声明优先与 checker/tree 一致；⑦ pre-existing NOTE 收口：tree deepCopy closure 丢 mod/localFns **已修**（B2 附带）；tree ensures 块尾中间值重入并入 §5.1 #47 描述（P3 未修）；`Some/Ok` 特例已修（不再需保留名拒绝）。回归数字见验收行。

**验收（实测）**：12 工具 `check --strict-wasm` 10 none / 2 fallback（具名）;fuzz 120 语料 fallback=0；`node tests/run.mjs` **861 全绿**（≥860；P1 审查追加后 870、P2 审查追加后 **881 全绿**）；fuzz/proof_fuzz 全模式 0 分歧/0 误报；**codegen 冻结面**：interp 仅 #49 一行计费 + P2 本地函数帧（已登记）、vm 仅宿主补丁 + P2 调用路径、cbackend 零改动（P1 审查追加左移溢出检查与 M4007/M4011 span，见上段）；wasm.js 为 wasm 改动面。

**风险/回退**：locals 模型重构动 wasm 编译核心 → 分四步（#40→#42→#43→#45/#46）每步独立回归；任一步 strict 回归不绿即停下评估；不可行形态如实登记（v0.58 已有先例口径）。

### 4.4.4 v0.60 — 资源门禁一致性（质量/安全版，无新语言面）

> 主题唯一：让 `--max-ms` / `--max-alloc` 的承诺与实现、四引擎行为一致；不引入新能力。
> 背景：2026-11-13 三方评估。原 v0.60 方案（serve + 覆盖率补测 + checker 拆分）被裁决拆掉——三个主题、一个条件新运行时面、一个纯重构、一个指标门槛，无法独立回退（§4.4.10）。
> 基线：v0.59.0（HEAD 9251e08，881 项全绿；覆盖率实测 93.5% 行 / 88.3% 函数，vm.js 63.8% 函数）。

**必修（P1，全部有本机实测复现）**

1. **#51 wasm 参数搬运计费分歧 + `wasmParamTop` 未复位（P1）**：`sum(v: Vec[i64])` 传 `[1,2,3]` + `--max-alloc 20` → 默认引擎 exit 101（M4011，累计 43），`--no-wasm`/`--tree` exit 0 输出 6，违反四引擎语义合同。根因：`src/vm.js` 的 `wasmWriteVecNum` → `mingAllocRaw` 把 wasm 实参搬运计入配额；且 `wasmParamTopStack` 在分配之后才保存、调用后 pop 回同一值，线性内存不复用。**最小修法**：先修 param-top（分配前保存、调用后复位），再取消参数/值拷贝搬运计费（派生拷贝不是新值创建）。`ming_grow`/`ming_copy_vec` 的字节口径与 tree/VM 元素口径差异登记为 latent，不在本版扩修。
2. **#52 外部输入边界未计费（P1）**：`std.fs.read_file` 读 182,819 字节 + `--max-alloc 10` → exit 0（配额完全绕过）。**最小修法**：`read_file` 先 stat 再按 size 预记账；`read_bytes`/`read_line`/`read_to_end`/`list_dir` 按结果长度/条目数记账；`proc.exec` 的 stdout/stderr 与 `net.http_*` 的 body 按结果长度记账。**计费原则**：值创建（Vec/Map 字面量、push/extend、str 拼接/repeat/join）+ 外部输入边界计费；派生值（deepCopy、json.parse、re.*、wasm 参数搬运）不重复计费——关闭无界外部输入，不逐点重写全部调用。
3. **#53 `--max-ms` 阻塞内建不可抢占（P1）**：`std.time.sleep(3000)` + `--max-ms 100` → 3,213ms exit 0；`join` 子任务同形态 3,283ms exit 0。根因：`checkTimeQuota` 只在每 16,384 步轮询，阻塞内建根本不经过它。**最小修法**：新增 `remainingMs()`；sleep 的 `Atomics.wait`、join/join_detailed/spawn_all/sync scope 的等待钳到剩余预算；exec/http 把钳制后的 timeout 传给 worker（execFile timeout / AbortController），返回后立即 `checkTimeQuota` → M4012。**明确不修（文档化边界）**：`read_line`/`read_to_end` 的 stdin 阻塞与 RegExp 回溯在进程内不可抢占——GUIDE/capabilities 具名列出，不假装已修。复用 M4011/M4012，不新增 M 码。**实现注记（批次 1 审查定案）**：`checkTimeQuota` 的边界比较由严格 `>` 改为 `>=`——钳制等待恰在上限边界唤醒时 `Date.now()` 毫秒取整使 elapsed==maxMs 漏报（实测 30 次 1 漏），且 `rem<=0` 预检查规则本就要求 `>=` 口径才自洽；v0.32 自旋 M4012 用例复测逐字不变，`>` 严格语义无既有用例依赖。
4. **#54 `ming test` / `ming init` 旗标不传播 + 零 CLI 回归（P1）**：`test --no-wasm` 仍走 wasm；`test --max-alloc 5` 通过而 `run --max-alloc 5` 触发 M4011。**最小修法**：`ming test` 把 `--tree`/`--no-wasm`/`--strict-wasm`/`--max-steps`/`--max-alloc`/`--max-ms` 原样转发到测试执行路径（与 `run` 同一解析与仲裁，`--strict-wasm` 与解释器旗标互斥口径一致）；`test`/`init` 补 CLI 回归（§64）。
5. **#47 tree 契约求值重入（P3，必修）**：`ensures if a > 0 { true } else { true }` → tree M4005 exit 101 / VM 输出 5。**最小修法**：`execBlock` 只在函数体块尾检查 ensures（ctx 携带 `bodyBlock`），表达式内嵌块不检查；本地函数补传 `bodyBlock`。不改 VM/编译器。
6. **ADR-002 五处补丁（v0.61 启动门槛，仅文档）**：(a) 来源表补 `bytes.to_str` 桥接与 `read_bytes` 漏报窗口，裁定 v1 窄源边界（只标 `env.get`/`read_line`/extern 返回；fs/proc/net 内容源不标）——**评估落盘时已完成**（ADR-002 §1.2 修订注 + §3.1 窄源块 + §6.2 ②）；(b) `debug(any) -> str` 是洗白通道，进禁面（与 Ptr 同款，M3002/M3049）；(c) 纯消费者/白名单方法表（parse_i64/parse_f64/char_len/byte_len/is_empty）与自由函数边界；(d) 每个净化器登记"授权的 sink 位"（`sanitize_path` 只授权路径位，不授权 content/URL/exec），并裁决绝对路径/CLI 路径策略；(e) **码号修正**：M3048 已被 v0.59 泛型本地函数占用 → 改为 M3049/M3050；ADR-002 §8 的 §64 改为 §65——**评估落盘时已完成**。**不写实现代码。**
7. **文档与基线收口**（**评估落盘时已完成大半**：README/design/plan 数字、coverage-baseline v0.59 复测、capabilities 熔断行改判、ADR-001 §63→§66、ADR-002 码号/窄源/§65 已同步）：v0.60 剩余项为 GUIDE 门禁口径（计费原则 + read_line/RegExp 边界 + `std.rand` 非 CSPRNG 声明）与 `docs/plan.md` 验收行回填。

**验收（实测口径）**：`node tests/run.mjs` 881 + 新增 §64 ≥14 全绿；#51 三引擎 `--max-alloc 20` 均 exit 0、`--max-alloc 2` 均 M4011；#52 大文件 `--max-alloc 10` 三引擎 M4011、小文件通过；#53 sleep/join 在 `--max-ms 100` 下 <1.5s M4012（exec/http 视环境，失败则只用 sleep/join 并如实注明）；#54 `test --no-wasm` 的 wasm 状态为 none、`test --max-alloc 5` 触发 M4011；#47 tree/VM 均输出 5；`fuzz --seed 44044 --count 40` 0 分歧；`proof_fuzz` 0 误报；无新 M 码；S1/S2 核心代码 diff 目标 <100 行，#54 转发与回归另计（约 30–60 行）。

**验收（2026-11-13 实测）**：`node tests/run.mjs` **905 项 0 失败**（881 + §64 24 项：A 组 4 + B 组 9 + C 组 11）；#51 三引擎 max20 exit 0 输出 6 / max2 M4011（v64.A1）、计费边界 3000/2999 三引擎逐字（v64.A2）、10 万次调用 + wasm OK 冒烟（v64.A3）；#52 大文件三引擎 M4011、10 字节恰等配额 exit 0（v64.B3）、stdin/list_dir 计费（v64.B4/B5）；#53 sleep/join `--max-ms 100` 三引擎 M4012 且 <2s（v64.B6/B7）、无配额不回归（v64.B8）；#54 三引擎 test 门禁生效（v64.A4/B9/C1；tree 腿由 B9 锁定；`--strict-wasm` 单独出现提示忽略 v64.C6）；#47 三引擎输出 5 + 违约 M4015（v64.B1/B2）；`fuzz --seed 44044 --count 40` 40 程序 0 分歧（wasm 真实执行 20）；proof_fuzz 100 例 0 误报；无新 M 码。**独立审查（3 名 fresh code-reviewer）**：唯一阻塞项 = 基类 `Interp.runTests` 漏透传（`ming test --tree` 门禁静默失效、与 GUIDE 声明漂移）→ 修复 + v64.B9 锁定；MINOR 5 项落实（ADR parse_f64/copy_file、GUIDE S7 措辞、capabilities 头注、strict 忽略提示）；S1/S2 核心 diff <100 行达成（vm.js 27+/8-、interp.js 计费+钳制+契约重入），#54 CLI 转发另计；latent N-60.1–N-60.4 登记。

**明确不做**：serve、Untrusted 实现、checker 拆分、覆盖率门槛、while 证明、ASan/launcher 沙箱、FFI 扩大、产物签名。

**风险/回退**：取消 wasm 搬运计费前必须验证 param-top 复位（否则线性内存随调用次数增长）；#53 钳制只缩短等待、不改变程序语义（超限本应 M4012）；#52 记账改变大输入程序的配额行为（本应如此，GUIDE 如实说明）；read_line/RegExp 边界不修，文档具名。

### 4.4.5 v0.61 — 污点最小片（条件；安全能力版）

> 主题唯一：只做"外部输入 → 路径/命令"注入面的最小污点闭环。
> **启动门槛（三条全满足才写实现）**：① v0.60 任务 6 的五处 ADR-002 补丁评审通过（**已满足**，2026-11-13 批次 1 落盘 + 审查）；② 12 工具迁移 spike 完成（**满足**，2026-11-14，报告见 `docs/adr-002-spike.md`：12/12 工具内容处理逻辑零改动；迁移调用点共 **12 处**（估计区间 12–20 下限；全部为 `env.get` 解包位，`read_line`/`extern` 在工具与示例中 0 处，argv 直收不标零迁移）——8 处路径实参位走 `sanitize_cli_path` 授权位，4 处非路径位（FIND_NAME/JSON_FIELD/RENAME_PREFIX/RENAME_EXT）需一次授权位登记或等价改道，均不动内容处理；9 源全量断点 8/12 工具，窄源 v1 断点 0）；③ 净化器策略裁决（**已裁决，2026-11-14**：选项①——新增 `std.unstr.sanitize_cli_path`（校验不改写：拒绝 NUL/C0 控制字符，Ok 原样返回；允许绝对/相对/.. 段），授权位与 `sanitize_path` 相同；否决 argv 不标方案。见 ADR-002 §3.4）。**门槛全部满足（①②③），v0.61 可进入实现**；实现期登记：GUIDE 一行授权位文字 + 3 个调用点包一层净化 + 测试向量锁定（**ADR-002 §3.4 的"CLI 匹配/比较串"扩权登记已于 2026-11-14 裁决时完成**；4 处非路径实参位中 RENAME_PREFIX 属路径目的地边界情形，随扩权一并覆盖——spike §6）。

**最小范围（窄源 v1）**

- 来源仅 `std.env.get`、`std.io.read_line` + extern 返回强制标污；`fs.read_file`/`read_bytes`/`read_to_end`/`proc.exec` stdout/stderr/`net.http_*` body **明确不标**（v1 泄漏窗口，写入 GUIDE 与来源白名单测试）。
- 载体仅 `str`；`std.unstr.sanitize_path`（或裁决后的 CLI 变体）+ `mark`；白名单 5 个纯产出方法（parse_i64/parse_f64/char_len/byte_len/is_empty）；`debug` 拒绝；**无** concat、bytes/Json/argv 载体、流敏感分析。
- 运行时擦除：tree/VM/wasm/C 输出逐字一致；只改 checker/interp/diag/文档；wasm `analyze()` 保持单一事实来源（如资格解包确需，仅一行）。

**任务**：checker 100–200 行；interp ≤50 行；2–3 个签名变更 + 12–20 个调用点迁移；§65 15–20 项；GUIDE/design/capabilities/README。
**验收**：迁移清单逐项勾；env→write_file 路径静态拒绝、sanitize 后通过；`read_file` 内容仍可 `split/print`（证明窄源不破坏工具）；四引擎标注程序逐字一致；fuzz 0；proof_fuzz 0；check 语料 ≤1.3x。

**验收（2026-11-14 实测）**：`node tests/run.mjs` **945 项 0 失败**（905 + §65 40 条 check）；迁移 12 处完成（8 工具，良性 env 行为与迁移前**逐字一致**——git worktree 基线 SMOKE-IDENTICAL；控制字符 env 值 → stderr + exit 1，净化器既定收紧）；env→write_file 路径静态拒绝（M3049 + hint）+ sanitize 后通过；`read_file` 内容 `split/print` 零改动（SMOKE 证实窄源不破坏工具）；四引擎标注程序逐字一致（默认/--no-wasm/--tree + **cc 擦除一致腿 v65.23**）；`fuzz --seed 44044 --count 40` 0 分歧（C 腿 6）；proof_fuzz 0 误报；新码 M3049/M3050 三处登记。**独立审查（fresh code-reviewer）**：2 MAJOR（C 后端 Untrusted 标注缺口、`C:x` 盘符相对漏判）+ MINOR 4 项全部修复（v65.21–24 补契约 sanitize/`as`/载体禁面/cc 腿）；**顺带修复污点实现暴露的既有缺口**：变体构造器载荷 tvar 从不绑定（`Some(脏)` 曾逃禁面）→ variantCtorType 补 `ps` + callCtor deepResolveT；struct 字面量字段位静默通过 → M3049 前置；latent **N-61.1/N-61.2** 登记。

**若门槛不满足**：本版退化为"测试与观测版"（vm.js +5 个具名函数至 ≥70%、manifest 2 个函数、覆盖率基线刷新），Untrusted 顺延；**不承诺实现**。

**明确不做**：9 源全量、`Untrusted[Json]`/`Vec[u8]`/argv 载体、流敏感/跨函数推断、净化的形式化证明。

**诊断码**：M3049（未净化 Untrusted 值流入受保护 sink）/ M3050（Untrusted 用于不支持的位置或洗白尝试），实现时三处登记；M3048 已由 v0.59 泛型本地函数占用，不得复用。

### 4.4.6 v0.62 — 服务端 v1（条件；独立版）

> 启动条件：**ADR-001 评审清单 16/16 已裁决（2026-11-14，架构师按默认立场逐项确认，见 ADR-001「评审清单」节）**；v0.60 的 #53 已交付（per-request timeout 依赖钳制）；serve 与污点的载荷问题已裁决（ADR-002 v1 载体仅 str，serve 载荷是 Json——v1 **不声称**请求受污点保护；若需保护，先裁决 `Untrusted[Json]`，不得静默扩载体）。**条件满足，serve v1 进入实现。**

**范围**：ADR-001 §5.2 原样——127.0.0.1、16/256/8MB/30s、Json 载荷、错误体、零新 M 码、handler 效果白名单 8（io/time/fs/net/env/rand/crypto/proc；sync/unsafe/ffi 拒绝）、无 handler 内 spawn；checker ~60 行 + interp ~350 行 + §66 ≥12。
**验收**：16/16 决策记录；§66 ≥12；三段式拒绝（tree/VM 双引擎一致、wasm 资格拒绝、cc 发射期拒绝）；190 req/s 量级与 16 worker 内存（0.9GB@16、队列上界 2GB）如实报告；回归全绿。
**明确不做**：TLS/UDP/自定义 host/WebSocket/keep-alive 调优/流式/handler 内 spawn/`Untrusted[Json]`。
**风险/回退**：任一清单项不勾 → 只留决策记录，serve 不进版本。

**验收（2026-11-14 实测）**：ADR-001 清单 **16/16 裁决落盘**（2026-11-14，架构师按默认立场逐项确认——SAB 容量定 32MB/请求复用、超时固定 30s、worker 启动失败 500+名额释放+计数）；checker ~90 行（SERVE_HANDLER_EFFECTS + serve 特例，零新码 M3029/M3002/M3005）+ interp +313 行（netServe + accept 线程 + 请求 worker）+ bin 回退检测；**§66 22 项 check**（≥12）含三引擎一致（tree 起服真实执行）、wasm 资格（strict 具名）、cc 发射期拒绝、CRLF 头注入护栏、9MB 响应护栏；错误体事件码与 ADR §2.1 **同步**（审查 M1：queue_full/timeout/handler_panic，M 码进 message）；独立审查 1 BLOCKER（accept 异步回调无护栏 → CRLF 头僵尸服务，实测复现）三层修复 + M2（跨模块 handler 收紧 M3002）+ m1/m3 落实；**顺带修复 wire 顶层 Json 多包外壳潜伏 bug**（spawn 顶层 Json 载荷曾 `j.v.has is not a function`；非 Json 载荷 HEAD 逐字不变）；`node tests/run.mjs` **967 项 0 失败**；fuzz 双种子（44044/777）各 40 程序 0 分歧；性能/内存如实（~60ms 冷启动、饱和 ≈190 req/s@16、55MB/worker RSS——ADR §2.4）。

### 4.4.6b v0.63 — wasm 剩余守护收口 slice 2（引擎全面性续篇，无新语言面）

> 主题唯一：把 §4.4.6a 的优先候选落成 wasm 能力——剩余五类守护（**mut Vec 元素写、Vec 下标读、Option 消费链 unwrap/expect、VecLit 数值元素、f64 复合赋值**）在 wasm 内真实执行；新形态语料 strict **fallback=0**；语义不变（panic 码/消息/span 与 tree/VM 逐字一致）。
> **任务**：
> 1. **宿主导入**：vm.js 新增 `panic_m4003(spanIdx, idx, len)` / `panic_m4006(spanIdx)`（消息逐字 `索引越界:长度 N,访问 I` / `对 None 调用 unwrap()`；span 取下标表达式/调用点，与 interp.js:856/1009/3246 同源口径）；wasm.js 导入段登记（现仅 panic_m4002/m4004）。
> 2. **Vec 下标读**：界内读线性内存 `[len][cap][elems]`；越界 → panic_m4003。
> 3. **mut Vec 元素写**：界内写回线性内存（后续读可见）；越界 → panic_m4003。
> 4. **Option 消费链**：unwrap 的 None 分支 → panic_m4006；**expect(带自定义 msg) 与 Err unwrap 保持守护**（消息需 str 穿越导入边界/含载荷 display，具名登记留后续 slice）。
> 5. **VecLit 数值元素**：线性内存构造型（ming_alloc 16+8n + 元素写入，返回 ptr）——与 v0.23 的 let/返回容器表示统一。
> 6. **f64 复合赋值**：f64 局部的 `+=/-=/*=//=`。
>
> **验收**：新形态语料 strict fallback=0；§67 ≥12（五形态正例三引擎逐字 + 越界/None 的 panic 消息-span-退出码逐字 + strict 存活断言）；fuzz 双种子 0 分歧；Err unwrap 守护具名登记；回归全绿。
> **验收（2026-11-14 实测）**：宿主新增 **4 导入**（panic_m4003 读带 `.get(i)` 后缀/panic_m4003w 写无后缀/panic_m4006/ming_alloc_elem）——全部尾部追加，导入索引 69 个逐处核对（G1 开发期一次 off-by-one 当场修复，教训入注释）；五形态 + 组合函数 strict 存活（自造语料 20 程序 19 存活 1 具名回落，抽查口径）；**计费对齐**：VecLit 计费改 n 元素（ming_alloc_elem，计 n/分配 16+8n 分离）、ming_copy_vec 派生拷贝不计费（#51 口径）——`--max-alloc` 三引擎矩阵逐字（len3 max3=0/max2=M4011 累计 3）；**panic 栈填充保留**（callCompiled catch 补栈，M4003/M4006/M4002 wasm 完整 stderr 与 --no-wasm 逐字）；**审查 B1 修复**：iscratch 跨表达式复用 → 五处 base ptr 改专属 tempSlot（含审查未发现的跨变量嵌套/Map 读嵌套两类潜伏冲突），8 个复现程序三引擎逐字；fuzz 双种子 0 分歧；`node tests/run.mjs` **995 项 0 失败**（967 + §67 28 条）；独立审查 1 BLOCKER + 2 MAJOR + MINOR 全部修复；残留具名登记 #58/#59 + N-63 系列。
> **明确不做**：Result unwrap/expect 链（wasm）、Vec[str] 元素写（句柄容器）、守护面之外的 wasm 扩张、while 证明/checker 拆分（维持 Backlog/背景）。

### 4.4.6a 后续与 Backlog（v0.64 起，不承诺；**2026-11-14 第三轮评估已逐项处置——见 §4.5.4**）
- **walker 统一（择机）**：checker 内多处线性体遍历器（walkLinearBody/exprIsLinear/stmtIsLinear）收敛为单一实现——零行为变更，随契约改动顺带，不单独立版。
- **while 守卫证明（Backlog，不承诺）**：只做"循环条件作为体内假设、赋值即失效"的最小形态；**不做归纳不变式**。proven 不消除运行时 M4003，收益仅为少一条 W3105；无正收益证据前不进入版本。
- **checker 拆分（背景项，不进入版本）**：5,273 行 / 310 函数 / 90.3% 函数覆盖，纯重构零功能价值；如需结构，只允许"新增模块放新表"（污点表），不搬 5k 行。
- **其他**：覆盖率/bench 信息性刷新；usage audit 对照；安全审计窗口。

### 4.4.7 跨版本技术债与观测（延续 §4.3.8）

| 项 | 内容 | 版本 | 说明 |
|----|------|------|------|
| 资源门禁一致性 | #51/#52/#53 + #54 CLI 旗标 | **✅ v0.60 交付** | 三引擎配额矩阵（v64.A1/A2/B3–B5）+ tree 腿（v64.B9）；无新 M 码；S1/S2 核心 diff <100 行 |
| tree 契约重入 | #47 | **✅ v0.60 交付** | tree/VM 输出一致（v64.B1/B2）；仅 interp.js |
| ADR-002 五处补丁 | 来源/白名单/净化器/debug/码号 | **✅ 已落盘** | 评估期落 a/e + 批次 1 落 b/c/d + 审查修正 |
| 污点窄源 v1 | Untrusted[str] 最小闭环 | **✅ v0.61 交付** | 门槛①②③满足后实现；§65 40 条；迁移 12 处/零内容改动；M3049/M3050 |
| 服务端 v1 | ADR-001 清单裁决 + serve | **✅ v0.62 交付** | 16/16 裁决 + §66 22 项 + 三段式拒绝；错误体事件码与 ADR §2.1 同步 |
| wasm 守护 slice 2 | 下标/mut 写/Option 链/VecLit/f64 复合赋值 | **✅ v0.63 交付** | 宿主 4 新导入;strict 新语料 fallback=0;计费对齐(ming_alloc_elem/copy_vec 派生不计费);B1 iscratch 修复;残留 #58/#59 具名 |
| vm.js 覆盖率 | 实测 65.9%（54/82，v0.60 全表）；+4 具名函数即 70% | 信息性，不设门槛 | 40 opcode 是 case，不是函数；wasm 宿主导入 lambda 稀释函数计数 |
| checker 拆分 | 背景，不进入版本 | — | 纯重构零功能价值；并行会话冲突风险 |
| while 守卫证明 | Backlog | — | v0.57 可选子目标；proven 不减 M4003 |
| invariant bench 项 | mut-self 循环 + invariant 成本 | **✅ v0.59 交付** | 0.19–0.28µs/次（占循环墙钟 20–27%，按 5% 判据如实报告） |
| moltbook/usage | 缓存后审计对照 | 随版附注（不设版本） | 非代码、非门槛 |
| GUIDE 交叉引用 | 1760+ 行补强 | 随版附注 | 非代码、非门槛 |

### 4.4.8 明确不做（v0.59–v0.62+）

- 沿用 §4.3.9 全部条目（包注册表/第三方依赖/交叉编译/GUI/调试器/eval/完整 SMT/删除运行时检查/10 万级连接/WebSocket/流式/keep-alive 调优/TLS/UDP）。
- **新增**：mask 不复活（ADR-003 永久否决）；污点效果建模不做（ADR-002 终局）；wasm 不支持 `match` 的声明维持（C 行 match 正确性不受影响）；不做"删除运行时边界/契约检查以换性能"。
- **三方评估新增**：不做 serve + 门禁修复混版；不做 Untrusted 9 源全量 v1；不做 checker 拆分作为版本项；不做 vm 函数覆盖 ≥70% 版本门槛；不做 while 归纳证明（近三版）；不做 ASan 腿/OS 级沙箱/产物签名/Actions SHA 固定/第三方 action；不做 FFI struct/array ABI 扩大；不为 S1/S2 新增 M 码；不做效果 diff 工具（`doc --json` + interface_hashes 已覆盖）；不把 deepCopy/json.parse/re.* 全量计费作为任务（派生值不重复计费）。

### 4.4.9 成功度量

| 版本 | 完成判定（全部满足） | 量化门槛 |
|------|---------------------|----------|
| v0.59 | **✅(2026-11-13)**:strict 模式已知回落清零(保留守护逐条具名);本地函数恢复且三引擎一致;记账统一(#48/#49);P1/P2/P3 独立审查修复全落地(`<<` 溢出/M4007 对齐/字面量计费/兄弟 ensures/lambda 捕获/遮蔽语义/M3015/M3048) | **§63 56 项(≥24);回归 881 全绿(≥860);fuzz eligible 族 120 语料 fallback=0;proof_fuzz 0 误报** |
| v0.60 | **✅(2026-11-13 实测)**:资源门禁一致性交付(#51/#52/#53/#54 + #47 + ADR-002 五处补丁 + 文档/基线收口);无新语言面/无新诊断码;3 名 fresh reviewer 阻塞项(基类 runTests 透传)修复后全绿 | **§64 24 项(≥14);回归 905 全绿(≥895);三引擎配额矩阵逐字(v64.A1/A2/B3–B5);S1 sleep/join <2s M4012;fuzz 40 程序 0 分歧(wasm 真实执行 20);proof_fuzz 0 误报;无新 M 码** |
| v0.61 | **✅(2026-11-14 实测)**:窄源 Untrusted v1 交付（门槛①②③满足：五处补丁评审 + 12 工具迁移 spike + sanitize_cli_path 裁决）；迁移清单 12 处逐项勾、12/12 工具零内容改动；四引擎标注程序逐字一致；M3049/M3050 三处登记；独立审查 2 MAJOR + MINOR 全部修复 | **§65 40 条(≥15–20 上限)；回归 945 全绿；迁移 ≤20 处(实测 12)；fuzz 40 程序 0 分歧；proof_fuzz 0 误报** |
| v0.62 | **✅(2026-11-14 实测)**:ADR-001 16/16 裁决落盘 + serve v1 交付（worker-per-connection；127.0.0.1；16/256/8MB/30s；Json 载荷；零新码；accept 三层护栏）；独立审查 1 BLOCKER + 4 MAJOR 修复；wire 顶层 Json 潜伏 bug 顺带修复 | **§66 22 项(≥12)；回归 967 全绿；三段式拒绝锁定；fuzz 双种子 0 分歧；性能/内存如实报告** |
| v0.63 | **✅(2026-11-14 实测)**:wasm 守护收口 slice 2 交付（五形态 + 宿主 4 导入 + 计费对齐 + panic 栈单层补齐；审查 B1 iscratch 五处专属槽修复——含审查未发现的两类嵌套潜伏冲突）；无新语言面/无新 M 码 | **§67 28 项(≥12)；回归 995 全绿；strict 新形态 fallback=0（自造语料 19/20 抽查）；计费三引擎矩阵逐字；fuzz 双种子 0 分歧；残留 #58/#59 具名** |
| 持续 | 覆盖率/bench 信息性刷新；usage audit；安全审计窗口 | 不设门槛 |

**跨版本共同门槛**：沿用 §4.3.10 末行（全量绿/0 分歧/分节测试/文档三处/版本三处/诊断三处/不留生成物/性能可复现）。

### 4.4.10 三方评估记录（2026-11-13；software-architect / security-engineer / minimal-change-engineer）

> 基线：HEAD 9251e08（v0.59.0，881 项全绿，四后端）。三份独立报告 + 主会话复核；结论均有本机实测或源码路径。评估结论已落入 §4.4.4–§4.4.6a（版本重排）、§4.4.7–§4.4.9（范围与度量）与 §5.1（#51–#57）。

**安全审计（S1–S8）**

| # | 项 | 严重度 | 实测/证据 | 处置 |
|---|----|--------|-----------|------|
| S1 | `--max-ms` 被阻塞内建绕过 | P1 | `sleep(3000)` + `--max-ms 100` → 3,213ms exit 0；`join` → 3,283ms exit 0；根因 `checkTimeQuota` 每 16,384 步轮询，阻塞内建不经过 | **v0.60 #53**：`remainingMs` 钳制 sleep/join/exec/http；read_line/RegExp 文档化边界 |
| S2 | `--max-alloc` 记账缺口 | P1 | ① wasm Vec 实参按字节计费（16+8n）而 tree/VM 不计 → `sum([1,2,3])` max20 默认 M4011/`--no-wasm` 0；② `read_file` 182,819B + max10 → exit 0 | **v0.60 #51/#52**：param-top 复位 + 取消搬运计费；外部边界计费；派生不重复计费 |
| S3 | 污点 `Untrusted[T]` 未实现 | P1（能力） | ADR-002 采纳但 9 源全量会让 `mingkit`/`json_query`/`diaghot`/`log_analyzer`/`edit` 直接 M3002；`debug(any)->str` 是洗白通道；`bytes.to_str` 无桥接规则 | **v0.60 ADR 五处补丁 + v0.61 窄源 v1（条件）** |
| S4 | FFI str 内嵌 NUL 截断 | P2 | `strlen("ab\0cd")=2`，Ming 侧长度 5 → 静默截断；加载面（RTLD_GLOBAL/LoadLibraryA）未文档化 | 文档 + 回归（#55）；是否拒绝需语义裁决，不进入 v0.60 |
| S5 | AOT artifact 结构校验缺失 | P2 | 反序列化只验 format/version；损坏 `mainFnIdx`/表长 → raw TypeError | Backlog（#56）；低成本索引/表长校验 |
| S6 | 安全回归缺位 | P2 | FFI NUL、损坏 artifact、污点负例无测试；M4013 无专项回归 | 随 v0.61 补（#57） |
| S7 | `std.rand` 非 CSPRNG | P2（文档） | mulberry32 / 32 位状态，可用于非安全随机 | **v0.60 文档声明**：GUIDE 写明不得用于密钥/nonce；不新增 `std.crypto.random_bytes`（无消费方） |
| S8 | 效果 diff 工具 | P2（建议） | `doc --json --index` 已输出 `with` 效果；`build --json` 的 `interface_hashes` 已含效果 | **拒绝**：重复能力，无消费方 |

**架构评估的关键事实纠正**

1. **覆盖率数字过时**：v0.59 实测 93.5% 行 / 88.3% 函数；`vm.js` 函数覆盖 **63.8%（51/80）**，不是 43.8%。未覆盖的 26/29 是 **wasm 宿主导入闭包**，不是 opcode；40 个 opcode 是 `execLoop` 内的 case（不是函数）——"操作码直测"前提不成立。距 70% 只差 5 个具名函数 → 信息性，不设版本门槛。
2. **#47 是活分歧**：tree M4005 exit 101 / VM 正常 → 前移 v0.60（原 v0.61）。
3. **`ming test`/`ming init` 零 CLI 回归且旗标不传播** → 新缺陷 #54，v0.60。
4. **文档/编号漂移**：README 状态段 v0.57 / design 头 v0.54 / plan §4.4 基线 861；§63/§64/§65 分节分配冲突；ADR-002 拟用 M3048 已被 v0.59 占用 → M3049/M3050。

**版本重排裁决（原 v0.60 为什么拆掉）**

原 v0.60 = serve（条件新运行时面）+ 覆盖率补测（指标门槛）+ checker 拆分（纯重构）。最小变更工程师裁决：三个主题、一个条件大面、一个纯重构、一个指标门槛，无法独立回退——这是 v0.59 之前范围膨胀模式的复发。安全评估的 S1/S2 是**已实测的门禁承诺被绕过**，优先级高于新能力面。重排后：

- **v0.60 = 资源门禁一致性**（#51/#52/#53/#54 + #47 + ADR-002 文档补丁 + 基线收口）——无新语言面，S1/S2 核心 diff <100 行。
- **v0.61 = 污点窄源 v1（条件）**——先 spike 后实现；门槛不满足退化为测试版。
- **v0.62 = serve v1（条件，独立版）**——ADR-001 16/16 全勾才启动。
- **v0.63+ = 候选/Backlog**——wasm 守护 slice 2、walker 统一；while 证明、checker 拆分不承诺。

**明确不做（评估裁决）**

- 不把 serve/覆盖率/checker 拆分合并进任何单版；serve 不早于 v0.62。
- 不做 9 源全量 Untrusted v1；不做 `Untrusted[Json]`/`Vec[u8]`/argv 载体（v1.1 需载体设计）。
- 不做 vm 函数覆盖 ≥70% 版本门槛；不做 checker 拆分版本项；不做 while 归纳证明（近三版）。
- 不做 ASan 腿、OS 级 launcher 配额/沙箱、产物签名、Actions SHA 固定、第三方 action。
- 不做 FFI struct/array ABI 扩大；不做效果 diff 工具；不为 S1/S2 新增 M 码。
- 不把 deepCopy/json.parse/re.* 全量计费作为任务（派生值不重复计费）。

**证据（本机实测，2026-11-13，HEAD 9251e08）**

```text
# S2-a
sum([1,2,3]) --max-alloc 20: run exit 101 (M4011, 累计 43) / --no-wasm exit 0 (6) / --tree exit 0 (6)
# S2-b
fs.read_file("GUIDE.md") 182,819 bytes --max-alloc 10: exit 0, 输出 182819
# S1
std.time.sleep(3000) --max-ms 100: 3,213ms exit 0; join 子任务: 3,283ms exit 0
# #47
ensures if a > 0 { true } else { true }: --tree M4005 exit 101 / run 输出 5
# 覆盖率（tests/coverage.mjs --json；881 通过 0 失败，10.4 分钟）
总行 93.5% / 函数 88.3%; vm.js 行 95.3% / 函数 63.8% (51/80)
# 工具迁移阻塞（9 源全量污点）
mingkit / json_query / log_analyzer / edit 的 read_file 内容处理 + diaghot 的 proc.exec stdout 处理全部 M3002
```

---

## 4.5 v0.64+ 规划（software-architect 精读第三轮 + security-engineer 安全评估第二轮，2026-11-14）

> **规划基线**：v0.63.0（HEAD 18a21b0）；**995 项回归全绿**；fuzz/proof_fuzz 双种子 0 分歧/0 误报；能力矩阵 55 行 ≈84%；覆盖率基线 94.0% 行 / 88.7% 函数（v0.60 全表口径，v0.61–v0.63 未刷新）。
> **精读结论（架构）**：v0.60–v0.63 四版全部按"一版一主题、独立回退"交付，纪律执行为四轮规划以来最好的一段。当前最大的债不在能力面而在三处：① **P2 缺陷 #55/#56/#57 连续两版搁置，#57 已构成书面承诺漂移**（§5.1 写"随 v0.61 补"，实测 `M4013` 在 tests/run.mjs 出现 0 次）；② **观测面三处长期未跑**（usage audit 快照停 2026-11-12、moltbook 无新汇报、覆盖率基线落后三版）——serve v1.1 / Untrusted[Json] / eval 三个决策全部卡在"没有使用反馈"；③ **北星支柱 4（解释器即库）四轮规划零触碰**（连 ADR 都没有）。checker.js 实测 5,555 行（v0.61 污点面进主体，违反既定"新表进新模块"纪律的先例）。
> **安全结论（第二轮，全部实测）**：上轮 S1/S2 已修复测通过、S3 污点窄源交付且洗白禁面/sink 门禁/const 洗白拒绝全部实测成立（一次初测"死代码缺口"系测量假象已勘误）；serve 为首个常驻网络面（127.0.0.1 固定 = 本机攻击者前提），头注入已护栏、慢连接不占 worker、队列公平性 272 受理 8 拒逐字；新发现 **S9–S16** 八项（见 4.5.7），其中 S9（嵌套 serve 无 policing）与 S14（#56 失败形态不一致）为 P2。
> **第三轮裁决**：**先清债（v0.64 信任边界与诚实失败收口）→ 引擎面收尾（v0.65 wasm slice 3 + #59）→ 校准与反馈（v0.66 纯观测版）**——把"观测"从连续三版未执行的"随版附注"升格为版本主题，让 serve v1.1 / Untrusted[Json] / eval 在有证据而非有直觉的前提下进入后续版本。

### 4.5.1 v0.64 — 信任边界与诚实失败收口（质量/安全版，无新语言面；零新增 M 码）

> 主题唯一：FFI 入口、AOT 产物入口、serve 行为面三类"承诺与实现一致"的收口——与 v0.60"资源门禁一致性"同性质。核心 diff <100 行。
> **#55 语义裁决（架构 vs 安全分歧，采纳安全侧）**：架构主张"拒绝截断 + 新码 M4017"；安全实测**实参路径当前经 C 资格面不可达**（`Vec[u8]`/`Result[str,str]` 的 let 标注均被 C2 拒绝、无 NUL 字面量——S15/c2），M4017 是给不可达路径写代码。**裁决 = 文档 + 回归 + 前置义务**：GUIDE FFI 节写明"extern 返回按 strlen 语义，C 侧含内嵌 NUL 的数据静默变短（实测 `byte_len=2` 黄金）"；"FFI 面扩大（Vec[u8] 实参等）时必须先裁决 NUL 策略"登记为前置义务；架构侧第一原则论据存档（届时裁决的依据），不预支实现。

**任务**
1. **S14/#56 AOT artifact 结构校验 + 失败形态统一（P2）**：deserializeArtifact 后置索引/表长校验（`mainFnIdx` 越界/负值、`functions=[]`、非法 opcode → 稳定诊断；实测四种损坏形态现为 raw TypeError exit 1 / M3023 / M4001 三种不一致形态）；损坏样例入回归。
2. **S9 嵌套 serve 编译期拒绝（P2，回环内）**：checker 静态拒绝 handler 体内的 serve 调用（spawn 纪律复用，~20 行；实测 check 现放行、内层真实绑定、外层 30s 硬杀后内层连同在途连接被斩）。非 handler 位置的嵌套/多 serve 维持现状并文档化。
3. **S12 `sanitize_cli_path` 闸门扩展（裁决：修，1 行 + 向量）**：拒绝集从 `<0x20` 扩为 **NUL/C0/DEL(0x7F)/C1(0x80–0x9F)/Unicode 双向控制符(U+202A–202E)**——实测 DEL/C1/RTL 均放行（终端回显 RTL 视觉反转）；拒绝优于含糊；升级属净化器既定收紧，GUIDE 登记一行。
4. **#57 安全回归批（P2，承诺漂移兑现）**：本轮全部攻击向量入 `tests/run.mjs`——M4013 FFI 门禁专项（首破 0 次记录）、#55 NUL 返回路径黄金（`byte_len=2`）、#56 四损坏形态、S9 拒绝、S12 扩集向量、S11 兜底语义、S13 慢连接行为、污点正负例（§65 已有部分，查漏补缺）。
5. **文档收口（S10/S11/S15/S16）**：GUIDE serve 节加"**handler 收到的载荷全部不可信**，路径/命令必须过 sanitize_*"警告（S10）；serve 节补"非法 status/headers 值按缺省兜底（200/{}/\"\"）"句（S11）；GUIDE FFI 节 strlen 截断语义（S15）；`worker_start_failed` 标签拆分随本版触碰 accept 代码顺手做（S16）。
6. **#58 顺带（P3，若断言面可控）**：mut Vec 元素写越界 panic 位置 VM 与 tree 差 1 列——compiler SETINDEX span 调整；先 grep 全部既有 panic 位置断言，逐条校准不静默；**断言面超出预期则顺延并在报告注明**。
7. **文档漂移修正**：README「核心特性(v0.59)」头部版本、路线图四条目"(当前)"收敛为单条；capabilities.md「诊断协议 71 码」按 diag.js 现状改判；§5.1 #55/#56/#57/#58 状态行更新。

**验收（实测口径）**：`node tests/run.mjs` 995 + §68 ≥10 全绿；损坏 artifact 四形态 → 稳定诊断统一（非 raw TypeError）；handler 内 serve → check 编译期拒绝；DEL/C1/RTL 进 sanitize_cli_path → Err；`M4013` 在 tests/run.mjs ≥1 专项断言；fuzz 双种子 0 分歧；无新语言面、零新增 M 码。
**风险/回退**：S9 是新静态拒绝面——正反例双向锁定（跨模块 serve handler/同模块正例）；#58 动 panic 位置断言面——可控性优先，超预期即顺延；S12 扩集可能影响既有工具的怪路径回退——12 工具冒烟 + 迁移清单复核。

### 4.5.2 v0.65 — wasm 守护收口 slice 3（引擎全面性终章，无新语言面）

> 主题唯一：把 §4.4.6b 具名清单剩余五项落成 wasm 能力，守护面从"具名清单"收窄至"仅注释登记不可达项"（`?` 运算符——返回函数本就不 eligible）；此后守护类工作从 Backlog **永久移除**。

**任务**
1. **expect(带 msg)**：消息 `expect 失败: <msg>`——msg 为编译期常量，经 strConsts 表索引穿越导入边界（宿主 panic 导入带 str 槽；同 v0.63 panic_m4003/m4006 模式）。
2. **Map unwrap**：宿主新增 `map_has` 判定导入（map_get 语义拆分：先 has 后 get），None/缺键分支 → panic（消息逐字对齐 tree/VM 的 `对 None 调用 unwrap()` 口径——实测确认）。
3. **Err unwrap**：消息含载荷 display——str 载荷经 strTable 句柄、数值载荷直传，宿主拼装与 interp 同源消息（`对 Err(...) 调用 unwrap()`）。
4. **Vec[str] 下标读**：str 元素 = 句柄（i32），界内读返回句柄；越界 → panic_m4003（带 `.get(i)` 后缀）。
5. **下标复合赋值 `v[i] += x`**：读-改-写三步展开（wasm.js `Unsupported('下标复合赋值 +=')` 点位）。
6. **#59 顺带（P3）**：wasm→wasm 直调 panic 栈缺内层帧——调用点 span 透传 callStack；与本版 msg/载荷穿越机制同源，一次改齐；§67 v67.20 按现状的断言翻转锁定。

**验收（实测口径）**：守护具名清单五项全部解锁；自造语料 strict 残留 = 0（或仅具名不可达项 `?`）；§69 ≥12（五形态正例三引擎逐字 + panic 消息-span-退出码逐字 + strict 存活断言 + #59 栈帧逐字）；fuzz 双种子 0 分歧；回归全绿。
**风险/回退**：三类新导入（map_has / panic 带 str 槽 / Err 载荷 display）各独立登记与测试，任一项 strict 回归不绿即停下评估（§4.4.3 四步纪律）；导入表追加沿用 v0.63 教训（尾部追加 + 索引逐处核对 + `iscratch` 类跨表达式槽复用审查——v0.63 B1 教训入审查清单）。

### 4.5.3 v0.66 — 观测与反馈（校准版，零语义改动）

> 主题唯一：把连续三版未执行的观测纪律补齐，并为 serve v1.1 / Untrusted[Json] / eval 三个悬决项提供裁决依据。src 语义零改动。

**任务**
1. **usage audit 重跑**：`tests/usage_audit.mjs` 对新会话 rollout 重跑并刷新 docs/usage-audit.md 快照（现快照 2026-11-12，落后四个版本；工具缓存/污点迁移/serve 均在其后）。
2. **moltbook 汇报**：≥1 条新讨论记录（v0.60–v0.63 能力面、污点对工具生态的影响、serve 可用性），登记 docs/moltbook.md。
3. **真实 serve 服务观察**：用 `std.net.serve` 写一个真实自用小服务并长驻观察，记录：N-62.1 的 `--max-ms` 长驻配额实际操作、55MB/worker RSS 真实影响、优雅停机需求是否真实出现、handler 效果白名单是否够用、错误体 Json 可诊断性。产出 **serve v1.1（优雅停机）go/no-go 裁决**（实现路径已预留：interp.js 注释——i32[0] 置 2 唤醒，约 30–50 行）。
4. **覆盖率/bench 基线刷新**：`tests/coverage.mjs --json` 全表 + `bench --write-baseline`，标注时点（v0.61–v0.63 新增约 400 行 src 未入快照）。
5. **capabilities 全表复核**：诊断码计数类漂移清零（"71 码"已由 v0.64 修正，本版全面复核）；GUIDE 交叉引用补强（1760+ 行，§4.3.8 遗留）。
6. **Untrusted[Json] 载荷 ADR 落盘**（若任务 3 反馈支持）：serve 载荷（HTTP body）是网络内容源但完全在污点面之外（S10 实测 body→write_file 路径 check 直通）——ADR 裁决载体语义（Json 载荷的 sink 位与净化器语义），实现（taint v1.1）等 go 裁决，不在本版。

**验收**：三个报告文件均有新时点快照；moltbook.md ≥1 条新记录；serve 服务有可复现的观察记录与裁决结论；基线文件更新且标注时点；`node tests/run.mjs` 计数不变且全绿；src 零语义改动。
**明确不做**：serve v1.1 实现（等 go 裁决）、Untrusted[Json] 实现（等 ADR + 裁决）、任何新语言面。

### 4.5.4 对 §4.4.6a Backlog 的处置

| 项 | 处置 | 理由 |
|----|------|------|
| wasm slice 3 残留守护 | **升格 → v0.65** | 具名清单延续，三类导入设计路径明确；做完后守护类工作永久移出 Backlog |
| #55/#56/#57 | **升格 → v0.64**（#55 采纳安全侧：文档 + 回归 + 前置义务，不做 M4017） | 两版搁置 + #57 承诺漂移；信任边界主题统一 |
| #58 | **升格 → v0.64 顺带**（断言面可控性优先） | 错误可观察面一致性，与 #57 同批 |
| #59 | **升格 → v0.65 顺带** | 调用点 span 透传与 slice 3 机制同源，一次改齐 |
| S9/S12（本轮安全新发现） | **升格 → v0.64** | 嵌套 serve 静态拒绝 + sanitize 闸门扩展；实测支撑 |
| 观测（usage audit/moltbook/覆盖率/bench） | **升格 → v0.66 主题** | "随版附注"连续三版未执行；反馈缺失是下一步所有决策的瓶颈 |
| serve v1.1 优雅停机 | **条件升格**（触发 = v0.66 任务 3 确认需求） | 实现路径已预留、成本低，反馈真空期不做猜测性投入 |
| Untrusted[Json] 载荷 | **ADR 先行（v0.66 任务 6），实现条件承诺** | serve 载荷 = 真实威胁面；载体 ADR 是启动门槛（沿 v0.61 门槛制先例） |
| eval/热重载 ADR | **规划期任务（不占版本主题）** | 北星支柱 4 四轮零触碰；验收标准从"零触碰"提升为"有裁决记录"（四问：eval 来源与污点交互/效果声明与静态检查边界/引擎限制/与热重载范围切分）；不承诺实现时间 |
| walker 统一 | 继续搁置 | 零行为变更，维持"随契约改动顺带"（checker.js:2537/2563/2584 三套遍历实证存在） |
| checker 拆分 | 继续搁置，**纪律升级** | "新表进新模块"升级为硬纪律：今后 checker 内任何新分析表必须新建模块，主体只加引用（v0.61 污点面进主体是违例先例，不再重复） |
| while 守卫证明 | 继续搁置 | proven 不减 M4003，收益仅少一条 W3105，无正收益证据 |
| S13 连接级上限 | **接受并登记**；作为 serve 放开项 ADR（自定义 host）的前置义务 | 127.0.0.1 固定绑定是主防线；慢连接不占 worker（实测）；队尾等待上限 480s 由 node:http 默认超时兜底 |

### 4.5.5 明确不做（v0.64–v0.66）

- 沿用 §4.4.8 全部条目（包注册表/第三方依赖/交叉编译/GUI/调试器/完整 SMT/删除运行时检查/10 万级连接/WebSocket/流式/keep-alive 调优/TLS/UDP；mask 不复活；污点效果建模不做；ASan/OS 级沙箱/产物签名/Actions SHA 固定；FFI struct-array ABI 扩大；9 源全量污点）。
- **新增（第三轮）**：serve v1.1 与 Untrusted[Json] 不在反馈/裁决到位前实现；eval 只做 ADR 不承诺实现；自定义 host/TLS 另 ADR（S13 前置义务随该 ADR 评审）；checker 拆分不进版本（"新表进新模块"硬纪律）；while 归纳不变式不做；覆盖率函数 ≥70% 维持信息性；不为 S9–S16 新增 M 码（S14 复用既有诊断通道收紧）；不做 SAB 消息槽加锁（无实害，登记即可）。

### 4.5.6 成功度量

| 版本 | 完成判定（全部满足） | 量化门槛 |
|------|---------------------|----------|
| v0.64 | #55 裁决落盘（文档 + 前置义务 + NUL 黄金回归）；#56 校验 + 四损坏形态统一；#57 安全回归批落地（M4013 专项首破）；S9 编译期拒绝；S12 扩集；#58 顺带（可控性优先）；文档漂移四处修正 | §68 ≥10；回归 ≥1005 全绿；损坏 artifact → 稳定诊断统一；`M4013` 专项断言 ≥1；fuzz 双种子 0 分歧；无新语言面、零新增 M 码 |
| v0.65 | slice 3 五形态解锁 + #59 栈帧补齐；守护具名清单清零（仅剩注释登记不可达 `?`） | §69 ≥12；回归 ≥1017 全绿；strict 自造语料残留 = 0；panic 消息-span-退出码三引擎逐字；fuzz 双种子 0 分歧 |
| v0.66 | usage audit 重跑 + moltbook ≥1 条 + serve 真实服务观察 + 基线刷新四项全落地；Untrusted[Json] ADR 或 go/no-go 记录；eval ADR 落盘（规划期任务随 v0.64 完成） | 三报告新时点快照；src 零语义改动；回归计数不变全绿；产出 serve v1.1 与 taint v1.1 的裁决记录 |

### 4.5.7 安全评估第二轮登记（S9–S16；security-engineer，全部实测）

> 延续 §4.4.10 S1–S8。复核：S1/S2 已修（机制复测通过）、S3 污点窄源交付（洗白禁面/sink 门禁/const 洗白拒绝全部实测成立；一次初测"死代码缺口"系测量假象已勘误）、S7 已文档化；`--max-ms` 缺省 600s vs 长驻服务已由 GUIDE 文档化 + 机制实测，**降级为接受并登记**。serve 为首个常驻网络面——**全部 serve 侧定级以"本机攻击者"为前提**（127.0.0.1 固定）。

| # | 项 | 严重度 | 实测/证据 | 处置 |
|---|----|--------|-----------|------|
| S9 | 嵌套 serve 无 policing：checker 放行 handler 内 serve；内层服务真实绑定运行，外层 30s 硬杀后内层连同在途连接被斩；未文档化 | P2（回环内） | handler 内 serve(18191,inner)：check exit 0；t+10s 内层 200；外层 504@30.02s 后内层拒连 | **修（v0.64）**：checker 静态拒绝 handler 体内 serve 调用（spawn 纪律，~20 行） |
| S10 | serve 载荷不进污点面且无警告：请求 body→write_file 路径 check 直通；GUIDE serve 节无"handler 载荷全部不可信"警告 | P2（文档） | t12 check exit 0（实测） | **文档化（v0.64）**：GUIDE 警告；v1.1 Untrusted[Json] 时 serve 载荷列第一扩面候选 |
| S11 | handler 畸形响应静默兜底：status 700/"200"/99→200、headers 数组/嵌套值→静默丢弃、数值 body→空体，无诊断 | P3 | 6 形态实测全 200 | **文档化（v0.64）**：GUIDE 补兜底语义；改 500 属语义裁决，Backlog |
| S12 | sanitize_cli_path 闸门仅拒 <0x20：DEL(0x7F)/C1(0x80–0x9F)/Unicode 双向控制符（U+202A–202E）放行——实测 RTL 视觉反转（`exe‮txt‬`）；CLI 回显显示欺骗窗口 | P3 | 5 向量实测 | **修（v0.64，裁决：扩拒绝集）**：+DEL/C1/双向符 + 测试向量；不接受含糊 |
| S13 | accept 层连接级资源无 Ming 上限（无 maxConnections；在途体缓冲无并发上限；队列无超时，队尾上限 480s）；慢连接不占 worker（实测 50 挂起期间正常请求 8.1s 返回 200） | P3（回环内） | 慢连接实测 + 源码确认 | **接受并登记**；作为 serve 放开项 ADR（自定义 host）的前置义务 |
| S14 | #56 具象化：artifact 结构校验缺失且**失败形态不一致**——mainFnIdx 越界/functions=[]→raw TypeError（vm.js:283）exit 1；=-1→M3023 exit 101；坏 opcode→M4001 | P2（维持） | 4 损坏形态实测 | **修（v0.64）**：反序列化后置索引/表长校验 + 稳定诊断统一；损坏样例入回归 |
| S15 | #55 范围更新：FFI NUL **返回路径**实测确认（自编 DLL `char* nulstr()` 返回 "ab\0cd" → Ming byte_len=2 静默截断，cbackend.js strlen）；**实参路径当前经 C 资格面不可达**（Vec[u8]/Result let 均 C2 拒绝、无 NUL 字面量） | P2（维持，范围收窄） | 自编 DLL + ming cc 实测；资格拒绝形态实测 | **文档 + 回归（v0.64）**：GUIDE strlen 语义；FFI 扩面 NUL 裁决为前置义务；架构侧 M4017 提案存档（届时依据） |
| S16 | 观感类：handleRequest 同步异常误标 `worker_start_failed`（a12）；响应头无大小/数量上限（a13）；SAB 消息槽并发写可交错（无越界，flag 语义保持） | 信息 | 源码确认 | 标签拆分随 v0.64 触碰 accept 代码顺手做；头上限/SAB 加锁登记接受 |

**serve 安全面实测基线（供后续复核）**：CRLF/DEL 头注入 → 500 internal_error 服务存活；280 并发 → 恰 272 受理 8×503（≤102ms）；504 精确 30.03s 且 `/fast` 91ms（名额同步释放）；4000 字符 path 全量入 handler、20001 字符 → node:http 16KB 头上限 400 bad_request；50 挂起连接不占 worker。

---

## 5. Backlog

现行 Backlog 见 **§4.2.8(2026-11-11 重排)**;旧表已并入该表,避免双份漂移。


## 5.1 已知缺陷(2026-11-11 code-review + 2026-11-13 三方评估,已逐项复核)

> 来源:两个 code-reviewer 子智能体 + 主会话复现 + 2026-11-13 三方评估/安全审计。**状态:v0.50.1–v0.59.0 的已修复项逐行标注;#47/#51–#54 已于 v0.60.0 收口(资源门禁一致性:参数搬运计费/外部输入计费/--max-ms 钳制/test 旗标传播/tree 契约重入);#55–#57(P2)Backlog/随 v0.61。**`已验证` = 有可复现命令/输出;`源码确认` = 代码路径明确但未跑运行期。

### 已修复(v0.50.1–v0.51.6)

| # | 缺陷 | 严重度 | 修复版本 |
|---|------|--------|---------|
| 0 | wasm 比较操作码错误 + --no-wasm 选错引擎 | P0 | v0.50.1 |
| 1 | 函数值丢失效果集(绕过 M3029) | P0 | v0.51.0 |
| 2 | 契约内 mut 方法修改参数 | P1 | v0.51.1(M3043) |
| 3 | ensures 漏 ? 早退 / 树引擎嵌套 return | P1 | v0.51.1 |
| 4 | 容器访问器返回内部引用 | P1 | v0.51.4(deepCopy) |
| 5 | match 元组嵌套模式穷尽性漏检 | P1 | v0.51.4 |
| 6 | while let 被 M3028 拒绝 | P1 | v0.51.4 |
| 7 | 泛型 bound arity 的 ReferenceError | P1 | v0.51.4 |
| 8 | Map 非原始键通过检查 | P1 | v0.51.4(M3044) |
| 9 | C f64 ≥9.22e17 UB/错值 | P1 | v0.51.3 |
| 10 | C 有符号窄截断 UB | P1 | v0.51.3(ming_sext) |
| 11 | C str 空模式/pad/ZWSP 偏差 | P1 | v0.51.3 |
| 12 | AOT sig 内嵌 AST/绝对路径 | P1 | v0.51.2 |
| 13 | build 回退只拷入口 | P1 | v0.51.2 |
| 14 | 缓存命中不校验 dist | P1 | v0.51.2 |
| 15 | 接口哈希漏 enum payload/bounds/typeArgs | P2 | v0.51.2 |
| 16 | CLI 项目参数 / -o / 值旗标 | P2 | v0.51.5 |
| 17 | VM 复合赋值窥孔:`x += N`(N≠1)误融 ±1(自举工具 diaghot 暴露;模糊器不生成 `+=`) | P0 | v0.51.6 |
| 18 | fmt if 表达式崩溃(blockInline 收到裸块) | P1 | v0.51.6 |
| 19 | fmt else-if 悬挂 `} else ` 且非幂等 | P1 | v0.51.6 |

### 新登记(2026-11-12,tools 优化会话)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 20 | fmt 注释瀑布:部分文件需 `fmt --write` 两遍到定点(注释占行后 preserveBlank 按源行距二次判定) | P2 | 已修(v0.51.6 后续提交):preserveBlank 向前看待冲刷独立行注释,常规语句前注释一遍到定点、规范形态零漂移;残余形态见 #22;§55 补 3 项回归 |
| 21 | 模糊器表达式语法不生成 `+=`/`-=` 复合赋值(#17 因此漏网) | P2 | 已修(提交 eefac3a):genStmt 补 compound 臂 + while 内复合形态,五种子 0 分歧 |
| 22 | fmt 残余瀑布形态:`} else { // 注释`(else 头行尾注释)等仍需两遍到定点(else 头 `{` 源行号在两遍间漂移,在 preserveBlank 触达之外) | P3 | **已修(v0.56.0)**:else/else-if 头行尾注释一遍到定点(空行在注释前,二次 fmt 零输出;无头注释规范形态零漂移;§60 v60.33) |

### 新登记(2026-11-12,v0.53.0 独立审查;v0.56.0 已全部修复)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 23 | **tree 引擎 for-in 循环变量遮蔽泄漏**:`let i = 100; for i in 0..3 {}; return i` 类形态 tree 返回循环变量末值而非外层 100(实测 tree 2 / VM 100;审查报告样例 tree 5 / VM 103),违反"三引擎一致"硬规则。**同根因**:C 后端区间 for-in 遮蔽时此前发射非法 C(`v_i_2` 未声明),已随本版 B3 修复(容器/区间 for-in 循环变量落入内层作用域);tree 语义待统一 | P1 | **已修(v0.56.0)**:tree 作用域模型统一——块级子环境 + for-in/while-let 每迭代内层绑定,循环结束恢复外层;三引擎逐字一致(§60 v60.1/v60.2 等) |
| 24 | **VM 捕获闭包传入 `v.map` 触发 TypeError**(`Cannot read properties of null`);tree 正常;HEAD 可复现 | P1 | **已修(v0.56.0)**:`vm.js` `callClosure` 补传 `captures`(一行修复);捕获/非捕获/多层闭包 HOF 三引擎一致(§60 v60.10–v60.12) |
| 25 | **fuzz 生成的 main 恒带 io、wasm 腿从不真实执行**——差分实际只覆盖 VM 回落路径;建议生成纯 helper 由 main 调用,让 wasm 腿真正落地 | P2 | **已修(v0.56.0)**:生成器新增 eligible helper 族,wasm 腿断言 `MING_WASM_DEBUG=1` 下 `[wasm] fn OK` 且无回落,汇总"wasm 真实执行 N"(三种子 20/16/18;§60 v60.23) |
| 26 | **buildKey 不含编译器 `src/*.js`**,仅靠 VERSION 区分——编译器改动而版本号未变时可能脏命中(设计现状,记录在案) | P3 | **已修(v0.56.0 + 审查 B2)**:键加入 `compilerSourceHash`(**src/*.js + bin/*.js** 排序内容 sha256——只含 src 时改 bin/ming.js 仍脏命中),`build --json` additive `compiler_hash`;敏感性回归覆盖 src 与 bin 单独改动/恢复(§60 v60.21/v60.22/v60.22b) |

### 新登记(2026-11-12,v0.54 收口)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 27 | **std 模块别名在字节码编译器解析失败**:`use std.math;` 后写 `math.sqrt(9.0)`(GUIDE §16 声明支持的别名形态)——`ming check` 0 诊断(检查器解析别名),但 `ming run` 在编译期抛 `Error: 编译错误:名字未解析 math` + Node 栈,退出码 1;`run --tree` 正常输出 `3.0`。与 v0.54 C5 无关,实测存在。**最小复现**:`use std.math;` + `fn main() with io { print(str(math.sqrt(9.0))); }` → `check` exit 0,`run` exit 1(`名字未解析 math`),`run --tree` exit 0 输出 `3.0`。根因方向:`src/compiler.js` 的 `compileNamedValue/compileIdentValue` 未把 `use` 导入的 std 模块短名注册为模块别名(全限定 `std.math.sqrt` 正常) | P1 | 已修(v0.54.0 独立审查 B5):`compileNamedValue` 读 `mod.imports` 的 `{std}` 绑定 → `__stdmod:<真实模块名>`;别名 `use std.x as y` 同样生效;编译器未解析名改为 `CompileError` + `file:line:col` 诊断(cc/build/run 不再裸栈);§58 v58.20 锁定 |

### 新登记(2026-11-12,v0.54.0 独立审查;v0.56.0 已全部修复)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 28 | **tree 引擎块作用域泄漏(if/unsafe 块)**:`let x = 1; if c { let x = 2; }` / `unsafe { let x = 2; }` 之后,块外读到的仍是块内的新值(实测 `let x=1; unsafe { let x=2; print } print` → tree `2/2`,VM `2/1`;HEAD 可复现)——树引擎 execBlock 复用外层 env,块级 let 覆盖了外层绑定;违反"三引擎一致"硬规则。与 #23(for-in 遮蔽泄漏)同属 tree 作用域根因,待统一修复 | P1 | **已修(v0.56.0)**:与 #23 同根因一次修复(execBlock 子环境);if/while/for/loop/match arm/unsafe/sync 块遮蔽不再外泄(§60 v60.3–v60.9) |
| 29 | **launcher 源码模式 panic 仅裸码无位置**:`dist/ming-app.mjs` 在无 `app.bytecode.json`(源码回退模式)下 panic 时只打印 `M4xxx: 消息`,不含 `file:line:col` 与源码摘录;而直接 `ming run` 的 panic 首行带位置。诊断信息在回退产物中退化 | P3 | **已修(v0.56.0)**:源码回退 launcher panic 带 `file:line:col` + 源码摘录;AOT 字节码模式输出逐字不变(§60 v60.34) |
| 30 | **extern fn 值存局部变量后 C 后端不支持调用**:`let q = f; q(...)`(f 为 extern fn)在 C 后端 let 推导为 null,发射期拒绝/无法调用;直接 `f(...)` 正常。与 v0.54 无关,既有面 | P2 | **已修(v0.56.0)**:选方案 (b)——C 后端发射期明确诊断(不再"let 推导 null");VM 诚实 M4001(§60 v60.35) |

### 新登记(2026-11-12,v0.55.0 独立审查;v0.56.0 已修 #31/#32)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 31 | **多入口共享模块时 `--proof-report` 摘要行/JSON 重复**:同一模块被多个入口加载时,摘要按入口各输出一份(per-entry 语义;文本行重复、JSON `summaries` 数组重复)。仅影响报告可读性,不影响证明结论/诊断;应按绝对路径去重 | P3 | **已修(v0.56.0 + 审查 B1)**:proof/summary 记录携带 `abs`,按 `abs + fn` 去重(文本/JSON 摘要与义务各一份;单入口行为不变;§60 v60.36)。审查 B1 修正:不能按展示路径反查 abs——同显示名不同目录的 `util.ming` 会跨目录误合并;现双模块各一份(§60 v60.51) |
| 32 | **摘要/调用点遍历对所有 `Checker.run()` 无条件执行**:即使不消费摘要(无 `--proof-report`/无跨函数证明查询)也建立摘要表与调用点上下文;小语料约 1.06x(信息性),大项目/LSP 可做惰性化(按需构建) | P3 | **已修(v0.56.0)**:无契约模块跳过摘要构建;有契约模块报告不变(§60 v60.37) |

### 新登记(2026-11-12,software-architect 精读;v0.56.0 已修 #33/#34/#36)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 33 | **契约子句尾部裸标识歧义**:`fn f(buf: Vec[i64], n: i64) -> i64 requires buf.len() == n { return n; }` 把 `n {` 解析为结构体字面量 → M2001「字段名不能是关键字 "return"」;`requires (buf.len() == n)` 加括号可绕过。自然契约写法被拒,**最小复现已实测** | P2 | **已修(v0.56.0)**:requires/ensures 专用解析模式 + struct literal 前瞻(空结构体/普通字面量双向锁定;§60 v60.13–v60.16) |
| 34 | **测试分节号重复/断档**:tests/run.mjs 存在两个 34–38 序号(旧 §34–§38 与 v0.39–v0.44 重复)、缺 §40;分节号不是稳定索引,交叉引用易漂移 | P3 | **已修(v0.56.0)**:分节号唯一化(重复 34–38 → 34b–38b、补 §40),文件头索引说明;不改测试内容(§60 v60.38) |
| 35 | **plan §4.2.10 v0.52 行引用 §54**(实际 v0.52 测试在 §56;§54 是 v0.51.6 复合赋值) | P3 | 已修(本次规划修正) |
| 36 | **fmt 丢弃 `requires`/`ensures`/struct `invariant`**(v0.56 开发中发现的 P1 数据丢失:格式化即删除契约) | P1 | **已修(v0.56.0)**:契约子句与 else 消息、invariant 逐字保留;幂等;既有规范文件零改写(§60 v60.17–v60.20)。`else` 插值消息原文经 `msgRaw` 逐字保留(#39 已修;运行时消息语义不变) |

### 已修复(2026-11-12,v0.56.0 wasm 严格模式语义)

| 编号 | 缺陷 | 严重度 | 状态 |
|------|------|--------|------|
| W1 | **wasm 一元负号 `0 - x` 栈序反**(实际返回 `x`;`-a`/负字面量比较/`(-a)+b` 语义错误) | P1 | **已修(v0.56.0)**:栈序修正;§60 v60.24/v60.25 三引擎逐字一致 + strict 存活 |
| W2 | **循环内语句 if 的 break/continue `br` 深度未计入 if 块**(曾死循环;嵌套 while/if 内层 break 跳出层级错误) | P1 | **已修(v0.56.0)**:br 深度计入 if 块;§60 v60.26–v60.29 |
| F1 | **for 体内 continue 跳过 `__i` 自增**(条件为外层变量时曾挂起;含循环变量条件 + break 组合) | P1 | **已修(v0.56.0)**:continue 前发射自增;§60 v60.30/v60.31 |
| F2 | **`inferNumType` 重复 `case`**(含 `%` 的条件/运算类型推导错误,导致 wasm 回落) | — | **已修(v0.56.0)**:合并重复 case;`%`/`*`/`-`/`/` 条件真实经 wasm(§60 v60.32) |

### 新登记(2026-11-12,v0.56 收口 + 独立审查;状态逐行)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 37 | **VM 块内本地函数声明崩溃**:块内 `fn` 声明路径在 `vm.js` 触发 `TypeError`(callValue 相关);HEAD 可复现 | P2 | **已修(v0.56.0 审查修复)**:统一由 M3047 在检查器声明处显式拒绝本地函数,VM 不再进入崩溃路径(§60 v60.52);恢复本地函数实现见 #44 |
| 38 | **GUIDE 称本地函数可递归,但检查器报 M3001**:文档与检查器行为不一致;HEAD 可复现 | P3 | **已修(v0.56.0 审查修复)**:GUIDE 改为"本地函数暂不支持(M3047,v0.57 后恢复)",与检查器一致 |
| 39 | **契约 `else` 插值消息被 parser 丢弃**(`msg=null`):fmt 无法还原(语义不受影响;与 #36 的已知限制同源) | P3 | **已修(v0.56.0 审查 A3)**:parser 以 `msgRaw` 保存 `else` 字面量原文(含引号),fmt 原样回写;运行时消息语义不变(插值形态运行时仍为 null;§60 v60.49) |
| 40 | **wasm locals 声明索引偏移 `nParams`**:f64 局部/Map 字面量导致 locals 索引错位 → 违规函数 REJECT(实测其他函数仍可经 wasm 执行,非整模块回落) | P2 | **已修(v0.59.0)**:形参占用局部索引 `0..nParams-1` 不进 locals 声明,声明改从 `nParams` 起;f64 局部/混合槽序真实经 wasm(§63 v63.1–v63.3)。剩余:数值 VecLit 容器表示未统一,显式回落具名 |
| 41 | **Map 形参 `slotTypes` 记 `vi64`** → for-in Map 形态 wasm 回落 | P3 | **已修(v0.59.0)**:`paramSlotTy` 登记 `mi64/mf64/mstr`,`__kh/k/v` 槽位补型;宿主 `map_get_i64` 返回 `BigInt(...)` 解锁 i64 值读取;§63 v63.6/v63.7(strict ok) |
| 42 | **Vec 形参多枚/与 f64 形参组合时 locals 类型错位**(实测后位单个 Vec 形参 OK;旧表述"仅签名首位可用"不准确) | P2 | **已修(v0.59.0)**:随 #40 索引模型修复;Vec[i64]×2 + f64 + i64 / 后位 f64 形参均 strict ok(§63 v63.4/v63.5) |
| 43 | **str 返回函数 `retTy` 映射 `i64`** → str 返回形态 wasm 回落 | P3 | **已修(v0.59.0)**:`retNumTy` 映射 str→i32 句柄;字面量/形参透传/拼接/值型 if/块尾表达式均 strict ok(§63 v63.8/v63.9) |
| 44 | **本地函数在 VM 无编译支持**:VM/字节码编译器没有本地函数编译路径(本地函数作值使 tree/VM 分歧;契约被 tree 静默忽略) | P1 | **已修(v0.59.0)**:`precompileLocalFns`/`compileLocalFn`(块级条目 + 递归/互递归 + 契约同模块函数口径 + 作值 LDFN→vclose + AOT entry.sig);tree `callLocalFn` 补齐;M3047 废弃不再发射;三条限制写入 GUIDE(§63 v63.22–v63.34)。**v0.59-P2 审查追加**:B1 契约域放行同块兄弟(`contractFnBinds`;自引用 ensures 与 tree 同 M4005)、B2 lambda 经 `fnBinds` 解析本地函数、B3 遮蔽定案(M3009/词法最近块)、B4 导入遮蔽 M3015、泛型专用码 M3048、`Some/Ok` 本地声明优先(§63 v63.46–v63.56) |
| 45 | **wasm 值型 if 的 blocktype 编码失败**:表达式 `if`(值上下文)静默回落,`--strict-wasm` 可见——导致 W2 的 expr-if 声明不可达(未真实走 wasm) | P2 | **已修(v0.59.0)**:按单字节 valtype 发射(修 `sleb(0x7e)` 两字节 126);i64/f64/str 值型 if/else-if 链/`&&`/`||` strict ok(§63 v63.10/v63.11;v53.25 断言翻转) |
| 46 | **wasm 块尾 if(unit 上下文)按值编译** → `REJECT: if 无 else` 回落(常见 `while { …; if c { break; } }` 形态;导致 W2/F1 在尾 if 形态上未真实走 wasm) | P2 | **已修(v0.59.0)**:unit 上下文块尾 if/loop 按语句编译;while/for/void/嵌套块尾 break/continue/return 均 strict ok(§63 v63.12/v63.13) |
| 47 | **tree 引擎 ensures 求值内嵌块尾值重入 checkEnsures**:契约表达式含带尾值的块(`if` 分支、`match` 臂块等)时,块尾求值再次触发同一函数的 checkEnsures,递归至 M4005,或二次求值时 `result` 被错误替换为块尾 bool 而报 `内部错误:match 无分支命中`。HEAD 可复现;VM/VM-only 正常(与 C1 编译器修复无关)。**最小复现**:`fn f(a: i64) -> i64 ensures if a > 0 { true } else { true } { return a; }` + `fn main() with io { print(str(f(5))); }` → `run --tree` M4005(exit 101),`run`/`run --no-wasm` 输出 5。**v0.59-P2 审查补充**:同一机制覆盖"ensures 求值途中的块尾中间值"(含本地函数 ensures 的块尾值),即 #47 是 tree 契约求值域的单一根因 | P3 | **已修(v0.60.0)**:`execBlock` 仅在函数体块尾检查 ensures(ctx 携带 `bodyBlock`;callUser/callLocalFn 传入、嵌套块剥离),表达式内嵌块不检查;本地函数同口径;三引擎输出 5(v64.B1)且违约 M4015(v64.B2);不改 VM/编译器 |
| 48 | **wasm 路径 `str_cat` 不计入 allocBytes → M4011 配额门禁引擎分歧**:wasm 把 str `+`/插值编译为 `str_cat` 导入(wasm.js compileBinNum str 分支),而宿主绑定(vm.js `str_cat`)只拼 strTable、**不调 chargeAllocBytes/ming_alloc**;解释器与 VM 字节码路径对 str 拼接按结果长度计费(interp.js `chargeAllocBytes(l.v.length + r.v.length)`)→ 同一程序默认引擎不触发配额、`--no-wasm`/tree 触发 M4011。**已验证(v0.58 审查复现)**:`fn probe(a: str) -> i64 { if a + "<120000×A>" == "x" { return 1; } return 0; }` + `print(str(probe("")))`,`--max-alloc 50000` → 默认 exit 0(输出 1)/`--no-wasm` 与 tree M4011(exit 101,累计 120000)。注:B 审查原报告的"20,000 次 `+` 循环"形态**不复现分歧**——str 累积循环(main 内 mut str 局部/str 返回 helper/Vec.push 方法调用/str 实参递归)今日均不满足 wasm 资格或实例化失败而回落字节码(计费),分歧只在 wasm 真实执行的 str_cat 上;随 #40–#43/#45/#46 修复扩大 str 形态覆盖面,该分歧**从潜伏变可达** | P2 | **已修(v0.59.0)**:wasm `str_cat` 经 `str_len(l)+str_len(r)` → `ming_alloc` 计费(与 interp 同口径;嵌套拼接 11+15=26);插值不计费(与 tree/VM 一致);plan §5.1 复现三引擎 M4011 累计 120000(§63 v63.14–v63.16)。**BMP 口径差异**(`str_len` 码点数 vs interp UTF-16 长度,代理对每字符差 1)与 **`--max-alloc` 内存风险**(bump 堆不回收,配额放大时驻留随拼接总量增长)如实登记 |
| 49 | **`std.str.join` 结果不计入分配记账,与 Vec 方法 `join` 计费不对称**:Vec 方法 join 按结果长度计费(interp.js `case 'join'` chargeAllocBytes(out.v.length)),v0.58 新增的 `std.str.join`(单次 O(n) 拼接)不调 chargeAllocBytes → 同尺寸结果 std 函数侧不触发 M4011。**已验证(v0.58 审查复现)**:10,000 × "abcdefghij" 入 Vec(`--max-alloc 60000`)→ `str.join(v).byte_len()` exit 0(输出 100000,结果 100KB 未计费)/`v.join(",").byte_len()` M4011(exit 101,累计 119999)。文档须如实标注:"join 的配额优势部分来自不计费";**API 不对称同步登记**:`v.join(sep)`(Vec 方法,带分隔符,计费)与 `str.join(v)`(std 函数,无分隔符,不计费)——GUIDE v0.58 收口条目覆盖该说明 | P3 | **已修(v0.59.0)**:`std.str.join` 按结果长度 `chargeAllocBytes(out.length)`(与 Vec 方法 join / `+` 同口径);紧配额下两形态均 M4011(累计 110000 / 119999;§62 v58.29 断言按翻转后改写;§63 记账组覆盖)。GUIDE/API 不对称说明同步更新为"已对称化" |
| 50 | **tree `deepCopy` 的 closure 分支丢 `env.mod`/`env.localFns`(pre-existing)**:闭包经 let/实参深拷贝后 `env.mod` 丢失,lambda 体内模块项访问触发 `env.mod.items` TypeError;引用外层本地函数时 `localFns` 也丢失 | P2 | **已修(v0.59-P2 B2)**:`deepCopy` 的 closure 分支保留 `mod`/`localFns`(localFns 表浅拷贝,与 `snapshotEnv` 同口径);`[1,2,3].map((x) => inc(x))` 三引擎一致(§63 v63.48/v63.49) |
### 新登记(2026-11-13,三方评估/安全审计;状态逐行)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 51 | **wasm 参数搬运计入分配配额,且 `wasmParamTop` 未复位**:`sum(v: Vec[i64])` 传 `[1,2,3]` + `--max-alloc 20` → 默认引擎 M4011(累计 43),`--no-wasm`/tree exit 0;根因 `wasmWriteVecNum`→`mingAllocRaw` 计费 + `wasmParamTopStack` 在分配后才保存→线性内存不复用 | P1 | **已修(v0.60.0)**:`mingAllocRaw(n, charge=true)` 仅搬运不计费(派生拷贝不是值创建;ming_grow/copy_vec/str_cat 计费不变);`wasmParamTop` 调用前保存/finally 复位(panic/trap/编组回落三路径),线性内存随调用复用(`wasmParamTopStack` 删除);三引擎配额矩阵 v64.A1/A2 + 10 万次复用冒烟 v64.A3(§64) |
| 52 | **外部输入边界未计入 `--max-alloc`**:`fs.read_file` 182,819 字节 + `--max-alloc 10` → exit 0;`read_bytes`/`read_line`/`read_to_end`/`list_dir`/`proc`/`http` 同源 | P1 | **已修(v0.60.0)**:read_file 先 stat 按 size 预记账/read_bytes 按 size/read_line、read_to_end 按结果长度/list_dir 按条目数/proc.exec 按 stdout+stderr 长度/http body 按长度计费;Err 路径不计费且 Err 消息与 v0.59 逐字一致;派生值不重复计费;v64.B3–B5(§64) |
| 53 | **`--max-ms` 对阻塞内建不可抢占**:`sleep(3000)` + `--max-ms 100` → 3,213ms;`join` → 3,283ms;根因 `checkTimeQuota` 每 16,384 步轮询,阻塞内建不经过 | P1 | **已修(v0.60.0)**:`remainingMs()` 钳制 sleep/join_detailed/spawn_all/sync scope/exec/http 的等待(预算已尽不等待直接熔断 → M4012);`checkTimeQuota` 边界 `>`→`>=`(钳制等待边界唤醒取整漏报修复,v0.32 自旋用例逐字不变);read_line/RegExp 进程内不可抢占边界具名(GUIDE/capabilities/代码注释);v64.B6–B9(§64) |
| 54 | **`ming test`/`ming init` 零 CLI 回归且旗标不传播**:`test --no-wasm` 仍走 wasm;`test --max-alloc 5` 通过而 `run --max-alloc 5` 触发 M4011 | P1 | **已修(v0.60.0)**:test 旗标传播(`--tree/--no-wasm/--max-steps/--max-alloc/--max-ms` 与 run 同默认值;**VMInterp.runTests 与基类 Interp.runTests 双路径**透传——审查发现基类漏透传致 `--tree` 腿静默失效,修复 + v64.B9 锁定);`--strict-wasm` 仅互斥仲裁、单独出现 stderr 提示忽略(v64.C6);`ming init` CLI 回归(v64.C4/C5)(§64) |
| 55 | **FFI str 内嵌 NUL 静默截断**:`strlen("ab\0cd")=2` 而 Ming 侧长度 5;加载面(RTLD_GLOBAL/LoadLibraryA)未文档化 | P2 | 文档 + 回归(v0.60 文档声明);拒绝截断需语义裁决,不承诺 |
| 56 | **AOT artifact 结构校验缺失**:反序列化只验 format/version;损坏 `mainFnIdx`/表长 → raw TypeError 而非稳定诊断 | P2 | Backlog;低成本索引/表长校验 + 损坏样例回归 |
| 57 | **安全回归缺位**:FFI NUL、损坏 artifact、污点负例无测试;M4013 无专项回归 | P2 | 随 v0.61 补(与污点负例同批) |

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
### 新登记(2026-11-14,v0.63 wasm slice 2 审查)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 58 | **mut Vec 元素写越界的 panic 位置三引擎差 1 列**:wasm/tree 用 `target.span`(`[` 列,interp.js:856),字节码 VM 用 Assign 语句/base span——`w[10]=x` 越界时 VM 位置列号小 1。HEAD 预存(非 v0.63 引入);v0.63 wasm 按 interp 源码口径对齐 tree | P3 | **登记未修**(v0.63 审查预存发现 A;修复需 compiler SETINDEX span 调整,涉及既有 panic 位置断言面) |
| 59 | **wasm→wasm 直调 panic 栈缺内层帧**:main→f→g(g 内越界)wasm stderr 缺 `at g` 帧(2 帧 vs tree/VM 3 帧)——wasm 直调不经 callCompiled,深层 Ming 帧不入 callStack;首行/位置/exit 101 已对齐;v0.63 已把单层栈补齐(严格改善),嵌套残留登记 | P3 | **登记未修**(v0.63 审查 M2;修复需每个 wasm 调用点下发调用点 span 透传 callStack;§67 v67.20 按现状断言) |

### 备注登记(2026-11-13,v0.57 收口;信息性,非缺陷)

| # | 备注 | 级别 | 状态 |
|---|------|------|------|
| N-62.1 | serve 运维事实：`--max-ms` 对 serve 程序照常生效,CLI 缺省 600000ms——**长驻服务必须显式调大**(如 `--max-ms 86400000`),否则 10 分钟后被 M4012 熔断;GUIDE std.net 节已登记 | 信息 | 已登记(v0.62 收口) |
| N-62.2 | 嵌套 serve 边缘行为:handler 白名单含 net,handler 内调 serve 编译期不拒——嵌套 serve 会绑第二服务、外层请求 30s 后 504,嵌套服务继续存活;v1 不 policing,如实登记 | 信息 | 已登记(v0.62 S2 报告;放开/禁止待后续裁决) |
| N-62.3 | §66 v66.15(worker 启动失败)skip:`new Worker` 抛错难确定性构造;行为正确性由源码审查覆盖(五条释放路径 done/error/exit/timeout/启动失败均有 release 且 done 防双释放——审查确认) | 信息 | 已登记(v0.62 审查 n2) |
| N-61.1 | 嵌套位置污点诊断回落通用码:`Result[Untrusted[str],str]`→`Result[str,str]` 块尾、match/if 分支混型、spawn_all Vec 元素、用户变体载荷报 M3002(而非 M3049);`json.stringify` 的 M3033 hint 对污点值误导——全部**正确拒绝**,仅诊断质量非旁路 | 信息 | 已登记(审查 m3;后续可把判定改 `typeContainsUntrusted(actual) && !typeContainsUntrusted(expected)`) |
| N-61.2 | compiler `tryWasm` 的 Untrusted 解包为**原地修改** checker `entry.sig`(运行时擦除下语义自洽;doc/LSP 读 AST 不受影响;AOT 产物存载体签名正确)——卫生债:未来"compile 之后再读 sig 渲染"的功能会踩坑 | 信息 | 已登记(审查 n1;建议将来改 clone 喂 wasm.js,v1 不修) |
| N-60.1 | #53 钳制等待后的 `checkTimeQuota`（M4012）先于 `worker.terminate()` 抛出（syncSpawnAll/syncJoin/join_detailed/exitSyncScope 四处）——CLI 侧 `process.exit` 收割全部 worker 无碍；"解释器即库"（REPL/嵌入）场景会泄漏运行中 worker 至任务自然结束。修复前该位置无检查，非回归 | 信息 | 已登记（v0.60 批次 1 审查；后续可把 terminate 挪到检查前/finally） |
| N-60.2 | `read_file` stat 预记账的平台差异：Windows 目录 size 0 不多计（EISDIR Err 与 v0.59 逐字一致）；Linux 目录 size 4096 会多计 4096 后仍回 Err（注释已声明"偏保守"口径） | 信息 | 已登记（v0.60 批次 1 审查） |
| N-60.3 | `wasmWriteVecNum` 调用点传 3 参（含 mut 旗标）但定义只收 2 参——mut 旗标静默丢弃，`mut 参数预留容量(v0.20 push)` 注释名不副实；v0.59 既有代码，不在 v0.60 改动面 | 信息 | 已登记（latent；单独收口需评估 mut Vec 容量语义） |
| N-60.4 | test 模式 M4011 的栈行显示 `at test <名> (undefined:undefined:undefined)`——runTests 以 callSpan=null 调 callUser 的既有格式化行为（run 模式正常显示 file:line）；断言不依赖 | 信息 | 已登记（v0.60 批次 1 审查） |
| N-57.1 | `tests/coverage.mjs` 的"始终 exit 0"**非无条件**:`mkdtemp` 临时目录创建在 try 块之外,创建失败(权限/磁盘等)会以未捕获异常 exit 1——概率极低,信息性工具,本版不改代码 | 信息 | 已登记(§4.3.8 覆盖率行备注);docs/coverage-baseline.md 措辞已同步 |
| N-57.2 | bench/coverage 基线数字为**快照口径**:`tests/bench.baseline.json` 带 `meta.date`、docs/coverage-baseline.md 标注时点(2026-11-13,Node v24,win32-x64);只作同口径纵向趋势对比,`bench --write-baseline` / 重跑 coverage.mjs 刷新 | 信息 | 已登记(两文件均已标注时点) |


## 6. 过程纪律（所有版本适用）

1. 每个版本：实现 + `tests/run.mjs` 分节测试 + 模糊抽查（0 分歧）+ 文档三条（GUIDE 修订记录 / README 路线图 / 诊断·能力矩阵按需）+ 版本三处同步 + 提交。
2. 发现既有 bug：先最小复现 → 回归测试 → 修复 → 记录在修订记录（不静默修）。
3. 自举优先：能用 Ming 写的工具不写别处；工具使用中发现的 bug 与语言 bug 同等对待。
4. 只承诺测过的：任何性能/覆盖率数字必须来自可复现的命令。
