# Ming 实施计划（v0.45 起）

> 本文件是唯一的计划落盘位置。已完成项在版本提交后移到「已完成」；新想法先进「Backlog」，
> 只有进入版本范围才细化到任务级。当前版本：**v0.56.0**（v0.52–v0.55 路线已全部交付；v0.53 可信构建基线:CI 矩阵、strict-wasm 三态、构建键修复、env -i 验收、C `str` for-in 码点迭代；v0.54 `with unsafe` 最小实现(C5)；v0.55 跨函数契约摘要；**v0.56 引擎一致性与缺陷清零已交付(2026-11-12)**：tree 作用域统一、VM 捕获闭包、契约解析/fmt 保真、wasm 四个语义修复、fuzz 真实 wasm 腿、buildKey 编译器源指纹(含 bin)；独立审查修复：契约作用域/u64 语义/fmt 契约破坏三修、#31 按模块身份去重、M3047 本地函数显式拒绝；复审 C1/C2（契约内嵌作用域基线/闭包 return）；测试 764 项全绿）。
> **下一步规划见 §4.3（v0.57–v0.60,software-architect 精读,2026-11-12;v0.56 已收口）**。

---

## 0. 当前状态

| 项 | 状态 |
|----|------|
| 语言内核 | 显式类型/效果系统/值语义/确定性；树+VM+wasm+C 四后端 |
| C 后端 | C1 数值 → C2 str/Vec[i64] → C3 Map/Option/f64 打印 → C4 extern fn FFI（dlopen/dlsym）、`--static`；v0.53 `str` for-in 按 UTF-8 码点迭代；**v0.54 C5 `with unsafe`（Ptr[u8]/Ptr[mut u8] → unsigned char*/const unsigned char*、std.mem.alloc/free → malloc/free（失败 M4011）、extern 槽接受/返回 Ptr；tree/VM/wasm 回落 M4016）** |
| 构建 | `ming build` 真 AOT 字节码产物（无明文源）；`--with-source`；spawn/trait 自动回退；**v0.49 内容寻址缓存 + 接口哈希报告 + `--clean-cache`**；**v0.53 构建键 = 项目相对路径 + 内容 + Node 主版本，`--json` 带 build_key/dist_hash/cache_hit/source_count/interface_hashes（同 OS + 同 Node 主版本可复现 dist_hash）** |
| CI | **v0.53 GitHub Actions**：push/PR + nightly；`test` 九组合（ubuntu/macos/windows × Node 18/20/22）跑 run/fuzz/proof_fuzz；`c-backend` ubuntu/macos；nightly 三种子 120 程序 + proof_fuzz 300；官方 action、零 npm 依赖（`.github/workflows/ci.yml`） |
| 自举工具 | 12 个全部 Ming 自写（mingkit 文件补丁 / edit 行级编辑 / engdiff 引擎差分 / diaghot 诊断热力图 / wc·tree·find·json·todo·log·rename·organize 日用小工具）；v0.51.6 起统一错误纪律（stderr + 失败退出 1）并全部 fmt 规范；`ming tools` 统一入口 + `--` 透传 |
| 质量护栏 | 回归全绿（v0.56.0 起 764 项，§60 为 v0.56 引擎一致性/契约保真/wasm 语义/独立审查 70 项；§59 为 v0.55 跨函数契约摘要 42 项；§58 为 v0.54 `with unsafe`/C5 + 独立审查 20 项；§57 为 v0.53 可信构建 31 项）+ 多后端差分模糊（四腿 + **v0.56 fuzz 真实 wasm 腿**:eligible helper 断言 `[wasm] fn OK` 并计数）+ proof_fuzz（边界证明模式 1/2 + v0.55 summaries 模式 300 例 0 误报/0 假反例）+ bench（cc 腿） |
| 能力矩阵 | 52 行口径 ≈81%（docs/capabilities.md；v0.56 新增 WASM 分层覆盖面行并重算：39✅ 6🟡 7❌，(39+6×0.5)/52=80.8%） |
| 下一步 | **§4.3 v0.57：QF_LIA 第四片——循环/守卫敏感边界证明**（`for i in 0..buf.len() { buf[i] }` 最高频形态；v0.56 已清零 P1/P2 一致性缺陷） |

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

> **状态(2026-11-12):v0.52–v0.56 路线已全部交付**(v0.52 QF_LIA 第二片 / v0.53 可信构建与跨平台验证基线 / v0.54 `with unsafe` C5 / v0.55 跨函数契约摘要 / v0.56 引擎一致性与缺陷清零)。本节已无待办计划任务;下一步方向见 §4.3.8 Backlog(v0.57+)与 §5.1 已知缺陷 #37–#47。

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

### 4.2.2 关键 ADR

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

三处登记:`src/diag.js` CODES(+CODE_HINTS)、`docs/diagnostics.md`、`tests/run.mjs` 对应分节;GUIDE 修订记录同步;已发布码不改号。

### 4.2.8 Backlog 重排

| 项 | 处置 | 理由/前置 |
|----|------|-----------|
| `with unsafe` 实现 | **✅ 已交付 v0.54(C5)** | 北星支柱;与 ffi 共用门禁;双门禁 M3029/M3046;tree/VM/wasm 回落 M4016;Ptr 带长度/`unsafe(cond)` 见下 |
| `mask [效果]` | **降级 v0.56+** | 签名不再陈述真实效果;与资格/契约纯性冲突;需独立 ADR/审计 |
| 污点即效应(`untrusted`) | 保留 v0.57+ | 安全工具高价值;需净化/传播规则;在 mask 之后 |
| ffi 面扩大 | 拆分:Ptr 交集进 v0.54;struct/array 保留;`lib.fn` 运行时 API 删除 | extern fn 已覆盖可审计路径;动态符号破坏 AOT/审计 |
| 约束解码生成模式 | 移出语言计划(工具侧研究) | 非语言/编译器能力 |
| 内容寻址代码 | 降级 | 项目级 ABI 缓存已交付;函数级 ROI 无数据 |
| C `str` for-in / trim 族 | **已关闭** | trim 族 v0.51.3;for-in v0.53(UTF-8 码点迭代,tree / VM / VM-only / cc 黄金一致;该形态 wasm 回落) |
| wasm 静默回落残留形态 | **v0.56 已修 W1/W2/F1/F2;剩余 #40–#43/#45/#46 单列 v0.57+;本地函数恢复见 #44** | v0.53 strict-wasm 观测与 v0.56 收口:一元负号栈序(W1)、循环内 if 的 break/continue br 深度(W2)、for 体内 continue 跳过自增(F1)、inferNumType 重复 case(F2)已修;剩余回落形态(f64/Map 局部索引偏移、Map 形参 slotTypes、多 Vec/f64 形参组合、str 返回 retTy、值型 if blocktype、块尾 unit if)不影响语义,strict 可见,见 §4.3.8/§5.1 |
| 泛型单态化缓存 | 降级 | 无 bench 证据 |
| async/eval/国密/交叉编译 | 保留远期 | 各自独立设计与安全评审 |
| 证明携带 unsafe(`unsafe(cond)`) | 新增 Backlog | 需带长度 Ptr/Slice 与证明令牌 |
| 循环/守卫敏感边界证明 | **v0.57 规划(§4.3.4)** | `for i in 0..len { buf[i] }` 最高频;v0.52 只做直线体 |
| Ptr 带长度 / Slice 只读视图 | 新增 Backlog | 零拷贝与证明联动先决条件 |
| v0.53.0 独立审查新登记缺陷 | **✅ 已清零(v0.56.0,§4.3.3)** | #23 tree for-in 遮蔽泄漏(P1)/ #24 VM 捕获闭包传 `v.map` TypeError(P1)/ #25 fuzz 恒 io、wasm 腿不真实执行(P2)/ #26 buildKey 不含编译器源码(P3);逐条见 §5.1 |
| v0.54 收口新登记缺陷 | **✅ #27 已修(v0.54.0);#28/#29/#30 已修(v0.56.0)** | #27 std 模块别名在字节码编译器解析失败 → v0.54.0 独立审查 B5 修复;新登记 #28 tree 块作用域泄漏(P1)/ #29 launcher 源码模式 panic 无位置(P3)/ #30 extern fn 值存局部变量后 C 后端不支持调用(P2)——均于 v0.56.0 修复;逐条见 §5.1 |
| v0.55.0 独立审查新登记缺陷 | **✅ #31/#32 已修(v0.56.0)** | #31 proof-report 多入口重复(P3)→ 按记录 `abs`(模块绝对路径)+函数名去重; #32 摘要无条件构建(P3)→ 无契约模块跳过;逐条见 §5.1 |
| mask / 污点即效应(untrusted) | **v0.60 研究项(ADR 先行,§4.3.7)** | 与资格/契约纯性冲突需独立 ADR;不默认承诺实现 |

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

## 4.3 v0.56–v0.60 规划（software-architect 精读，2026-11-12）

> **规划基线(v0.56 规划时)**：v0.55.0；694 项回归全绿；四后端（tree / VM+wasm / VM-only / C）；CI 矩阵就位；能力矩阵 51 行 ≈81%。**v0.56 收口实测(2026-11-12)**:764 项回归全绿、§60 70 项、能力矩阵 52 行 ≈81%（新增 WASM 覆盖面行）。
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
| 10 | 安全工具面 | 污点即效应/mask 未定（北星支柱 6） | **v0.60 研究项** |
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

### 4.3.4 v0.57 — QF_LIA 第四片：循环/守卫敏感边界证明

**目标**：把 v0.52 的直线体边界证明推进到**最高频真实形态**：范围 for 内的 `buf[i]`。

**范围**：i64 范围 for（上界为常量或非 mut Vec 参数 `len()`）；循环体为直线体；单个索引点；非 mut `Vec[i64]` 参数；`while i < len` 的单条件守卫作为第二子目标（可选，不承诺）。**不做**：任意循环不变式注解、嵌套循环、循环内改长度、分支敏感、通用 SMT。

**任务**

1. **prover 扩展区间约束**：归纳变量 `i ∈ [lo, hi)`（lo/hi 为线性形式）；与既有差分约束合并求解；超范围/非线性 → 放弃。
2. **checker 循环义务**：范围 for 的每次迭代假设 `i >= lo && i < hi`；上界能映射到 `len$buf` 时证明 `i < len$buf`；`0 <= i` 由 lo 决定；循环变量被重赋值/break 带值 → 保守放弃。
3. **诊断复用**：可证违反 → M3045（不新增码）+ 反例；未证明默认静默，`--warn-unproven-index` 下 W3105；proof-report 增加 loop 义务统计（additive）。
4. **测试 §61**（≥12）：`for i in 0..buf.len() { buf[i] }` proven；`for i in 0..n` + `requires n <= buf.len()` proven；`for i in 1..buf.len()` 边界严格性；上界 `n+1` 可证违反；循环内 `+=` 放弃；嵌套循环放弃；while 守卫静默/可证；proof_fuzz 增加 `--mode loops`（200 例 0 误报，独立求值器验证反例）。
5. **文档**：GUIDE 静态边界证明节补循环形态与放弃条件；能力矩阵契约行更新。

**验收**：`run.mjs` 0 失败（§61 ≥12）；`proof_fuzz --mode loops --count 200` 0 误报；codegen 零改动（compiler/interp/vm/cbackend/artifact）；性能 ≤1.3x v0.55 基线（可复现命令）；既有 §56/§59 全绿。

**风险/回退**：循环上界含调用/别名/重赋值 → 保守放弃；若证明器复杂度失控，退回“只支持 `0..len` 直接形态”，其余静默。

### 4.3.5 v0.58 — AI 协作体验与文本工程（开发者体验版）

**目标**：把“AI 生成 → 检查 → 修正”的循环摩擦再降一档，并补文本工具的实用性能面。

**任务**

1. **LSP 扩展**：补全（标识符/字段/方法/关键字）、跳转定义、文档符号；保持同步、零依赖、单文件协议实现；对泛型/多文件保守（宁可少补，不可错补）；§62 协议测试扩充（≥6 项）。
2. **`std.str.Builder`**：`push/append/to_str`，值语义；10 万次拼接 O(n)（附可复现 bench 对比 `+` 的 O(n²)）；tree/VM 一致；C 后端若不支持则发射期显式拒绝（`C1 不支持`），不进资格面。
3. **`ming doc --json` 稳定 schema + `ming doc --index`**：把 `///` 文档变成机器可消费的索引（AI 检索用）；additive，不改默认文本输出。
4. **Release 分发**：tag 触发 GitHub Release 打包 zip（bin/src/tools/examples/docs/GUIDE/README；零 npm、官方 action）；不承诺安装器/包管理器。
5. **测试 §62**（≥15）：LSP 补全/跳转/符号；Builder 双引擎 + 大输入性能断言（宽松阈值）；doc JSON schema；Release workflow 结构静态校验。
6. **文档**：GUIDE LSP/doc/Builder 节；能力矩阵更新（Builder ✅、LSP 行细化）；README 快速开始补 LSP 用法。

**验收**：`run.mjs` 0 失败；LSP 会话测试通过；Builder 双引擎输出一致且 10 万次拼接 < 1s（本机，信息性）；doc JSON additive（无旗标输出与 v0.57 逐字一致）；CI 保持绿色；零新依赖。

**风险/回退**：补全对泛型/模块解析易错 → 保守策略与开关；Builder 是 std 方法，不动语法（可整体回退）。

### 4.3.6 v0.59 — 服务端与并发：ADR 先行（条件承诺）

**目标**：在“确定性 + 效果门禁 + 零依赖 + 四后端”约束下，给出服务端/并发的可信设计，而不是先写实现。

**任务**

1. **ADR-001（async/服务端选型）**：对比三方案——(a) worker-per-connection 阻塞模型（复用现有 sync/wire 基础）；(b) 解释器内 green-thread 调度（确定性调度序）；(c) Node async 桥（非确定性风险）。评分维度：确定性、效果系统表达、零依赖、四后端一致性、实现成本、可回退性。产出 `docs/adr-001-concurrency.md` + 评审清单。
2. **原型实验（不入语言面）**：对胜出方案做最小原型（仅 `std.net.serve` 语义草图 + 10 连接压力测试数据），验证可行性与风险。
3. **仅当 ADR 通过**：最小 HTTP server（`std.net.serve`，net 效果；请求方法/路径/头/体；8MB 体上限；显式拒绝流式/WebSocket/keep-alive 调优）；JS 引擎唯一执行，C/wasm 以资格拒绝或 M4016 诚实声明；§63 ≥12（本地回环测试）。
4. **文档**：ADR、GUIDE 服务端节（若实现）、能力矩阵 TCP/UDP 行更新（服务端从 ❌ → 🟡/✅ 视交付）。

**验收**：ADR 文档 + 评审清单完成；若实现，§63 ≥12、`run.mjs` 0 失败、CI 局域网测试、三引擎拒绝一致；若不实现，plan 明确记录“ADR 结论：暂不进入语言面”及理由。

**风险/回退**：ADR 不通过 → 本版只交付设计文档（不写代码）；实现阶段的风险（阻塞模型并发上限）在 ADR 中量化。

### 4.3.7 v0.60 — 安全工具面研究项（污点即效应 / mask）

**目标**：评估北星支柱 6 的下一块（数据流安全），保持“签名可见”的哲学底线。

**任务**

1. **ADR-002（taint-as-effect）**：来源（env/net/fs 读入）→ 传播（值语义下的显式标注）→ sink（exec/ffi/fs 写）→ 净化（显式函数）；评估与现有契约纯性、效果传播、四后端的兼容性；给出最小语法面草案（`untrusted` 效果或 std 类型标注，二选一）。
2. **ADR-003（mask 决策）**：复核 v0.44 的 mask 设计定稿与后续资格/契约纯性冲突，明确“做/不做/降级”的结论；若不做，给出替代（显式 wrapper 类型）。
3. **原型（仅分支/实验，不入主干）**：若 ADR 通过，最小 `untrusted` 实现（来源标注 + sink 拒绝 + 净化函数）+ §64 草案测试；否则只交付 ADR 与 Backlog 更新。

**验收**：两份 ADR + 评审清单；若落地，§64 ≥12 与全量门禁；不落地则 plan 记录结论与理由。

**风险/回退**：taint 与值语义/深拷贝的交互复杂（拷贝是否保污点）；mask 可能永久降级为“不做”（ADR 明确）。

### 4.3.8 跨版本技术债与观测

| 项 | 内容 | 版本 | 说明 |
|----|------|------|------|
| 覆盖率观测 | `tests/coverage.mjs`（`NODE_V8_COVERAGE`，零依赖）报告 `src/*.js` 行覆盖 | ~~v0.56~~ **v0.57+** | v0.56 收口主题为缺陷清零,本项未交付(顺延);信息性指标，不设门槛；先建立基线再谈阈值 |
| wasm 剩余回落形态 | #40 locals 声明索引偏移 nParams(f64 局部/Map 字面量致违规函数 REJECT,同模块其他函数仍可经 wasm 执行)/ #41 Map 形参 slotTypes 记 vi64 致 for-in Map 回落 / #42 Vec 形参多枚/与 f64 形参组合时 locals 类型错位(后位单个 Vec 形参实测 OK)/ #43 str 返回函数 retTy 映射 i64 致 str 返回回落 / #45 值型 if 的 blocktype 编码失败 / #46 块尾 unit 上下文 if 按值编译致 `REJECT: if 无 else` | **v0.57+**(单列 wasm 覆盖面) | 均不影响语义正确性(回落 JS VM;`--strict-wasm` 可见);修复需 wasm 局部/签名专项审查;逐条见 §5.1 |
| bench 基线 | `tests/bench.baseline.json` + 阈值告警（如 cc/vm 比值回退 >20% 告警） | v0.57 | 仍不阻断 CI；数字必须可复现 |
| checker 拆分 | 契约/证明适配从 checker.js（5.0k 行）迁到 `src/contracts.js`（纯重构，零行为变化） | v0.57–v0.58 择机 | 以全量回归绿为唯一验收；不追求行数指标 |
| 文档结构 | GUIDE 1.1k 行补目录/交叉引用；不重写 | v0.58 | 降低 onboarding 摩擦 |
| 安全审计 | unsafe/ffi 的“已声明覆盖/不覆盖清单”每 4 版复核一次 | v0.59/v0.60 | 与能力矩阵同步 |

### 4.3.9 明确不做（v0.56–v0.60）

- 不做包管理注册表/第三方依赖；不做跨 OS/跨架构交叉编译；不做 GUI；不做交互式调试器（留 Backlog）；不做 eval/热重载。
- 不做完整 SMT；证明只在线性/区间子集内推进，超出即静默放弃。
- 不删运行时边界/契约检查；proven 只报告。
- 不提前承诺 async 运行时与 HTTP server（ADR 通过前不写实现）。
- 不默认实现 mask/taint（ADR 决策；不通过则明确记录）。
- 不改已发布诊断码；新增字段一律 additive；零 npm。

### 4.3.10 成功度量

| 版本 | 完成判定（全部满足） | 量化门槛 |
|------|---------------------|----------|
| v0.56 | **✅(2026-11-12 实测)**:三引擎作用域/闭包/HOF 一致；契约尾部歧义修复；fmt 契约保真；fuzz 真实 wasm 腿；buildKey 含编译器源(src+bin)；存量 P1/P2 清零；独立审查 A/B 组修复(契约作用域/u64/fmt/#31/#26/M3047)；复审 C1/C2 修复(ensures 内嵌作用域/闭包 return)；#37/#38/#39 收口，新登记 #44–#47 见 §5.1 | §60 实测 70 项(≥15)；回归 **764 项**全绿(≥715)；fuzz 40 程序 0 分歧、wasm 真实执行 20(三种子 20/16/18)；buildKey 敏感性覆盖 src 与 bin；proof_fuzz 三模式 0 误报(实测模式 1 100 例/模式 2 反例 18/18/summaries 100 例 0 误报) |
| v0.57 | 范围 for 内 `buf[i]` 可证明；codegen 零改动 | §61 ≥12；proof_fuzz loops 200 例 0 误报；性能 ≤1.3x v0.55 |
| v0.58 | LSP 补全/跳转/符号可用；Builder O(n)；doc JSON additive；Release 打包 | §62 ≥15；10 万次拼接 <1s（本机）；无旗标 doc 输出逐字不变；CI 绿 |
| v0.59 | ADR-001 完成；若实现则最小 HTTP server 通过 | ADR 评审清单全勾；实现时 §63 ≥12 + 三引擎拒绝一致 |
| v0.60 | ADR-002/003 完成；实现与否均有结论与理由 | ADR 评审清单全勾；实现时 §64 ≥12 |

**跨版本共同门槛**：`node tests/run.mjs` 0 失败；`fuzz` 0 分歧；新增分节测试；GUIDE 修订记录 + README 路线图 + plan 已完成项移动；版本三处同步；诊断码三处登记；不留下未提交生成物；性能数字来自可复现命令。

---

## 5. Backlog

现行 Backlog 见 **§4.2.8(2026-11-11 重排)**;旧表已并入该表,避免双份漂移。


## 5.1 已知缺陷(2026-11-11 code-review,已逐项复核)

> 来源:两个 code-reviewer 子智能体 + 主会话复现。**状态:v0.50.1–v0.56.0 的已修复项逐行标注;#37–#43 中 #37/#38/#39 已于 v0.56.0 收口;新增 #44(待实现);#45–#47 未修。**`已验证` = 有可复现命令/输出;`源码确认` = 代码路径明确但未跑运行期。

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
| 40 | **wasm locals 声明索引偏移 `nParams`**:f64 局部/Map 字面量导致 locals 索引错位 → 违规函数 REJECT(实测其他函数仍可经 wasm 执行,非整模块回落) | P2 | 未修(wasm 局部专项;strict 可见,语义正确) |
| 41 | **Map 形参 `slotTypes` 记 `vi64`** → for-in Map 形态 wasm 回落 | P3 | 未修(wasm 签名/槽类型专项) |
| 42 | **Vec 形参多枚/与 f64 形参组合时 locals 类型错位**(实测后位单个 Vec 形参 OK;旧表述"仅签名首位可用"不准确) | P2 | 未修(wasm 签名/locals 专项) |
| 43 | **str 返回函数 `retTy` 映射 `i64`** → str 返回形态 wasm 回落 | P3 | 未修(wasm 返回类型映射专项) |
| 44 | **本地函数在 VM 无编译支持**:VM/字节码编译器没有本地函数编译路径(本地函数作值使 tree/VM 分歧;契约被 tree 静默忽略) | P1 | 待实现(v0.56 起由 **M3047[local-fn-unsupported]** 显式拒绝;实现后移除拒绝并恢复 GUIDE 表述,计划 v0.57 后) |
| 45 | **wasm 值型 if 的 blocktype 编码失败**:表达式 `if`(值上下文)静默回落,`--strict-wasm` 可见——导致 W2 的 expr-if 声明不可达(未真实走 wasm) | P2 | 未修(wasm 块类型编码专项) |
| 46 | **wasm 块尾 if(unit 上下文)按值编译** → `REJECT: if 无 else` 回落(常见 `while { …; if c { break; } }` 形态;导致 W2/F1 在尾 if 形态上未真实走 wasm) | P2 | 未修(wasm 语句/块尾判别专项) |
| 47 | **tree 引擎 ensures 求值内嵌块尾值重入 checkEnsures**:契约表达式含带尾值的块(`if` 分支、`match` 臂块等)时,块尾求值再次触发同一函数的 checkEnsures,递归至 M4005,或二次求值时 `result` 被错误替换为块尾 bool 而报 `内部错误:match 无分支命中`。HEAD 可复现;VM/VM-only 正常(与本次 C1 编译器修复无关)。**最小复现**:`fn f(a: i64) -> i64 ensures if a > 0 { true } else { true } { return a; }` + `fn main() with io { print(str(f(5))); }` → `run --tree` M4005(exit 101),`run`/`run --no-wasm` 输出 5 | P3 | 未修(tree 契约求值重入专项;§60 v60.55/v60.57 记录已知行为,修复前不锁定 M4005 断言) |


## 6. 过程纪律（所有版本适用）

1. 每个版本：实现 + `tests/run.mjs` 分节测试 + 模糊抽查（0 分歧）+ 文档三条（GUIDE 修订记录 / README 路线图 / 诊断·能力矩阵按需）+ 版本三处同步 + 提交。
2. 发现既有 bug：先最小复现 → 回归测试 → 修复 → 记录在修订记录（不静默修）。
3. 自举优先：能用 Ming 写的工具不写别处；工具使用中发现的 bug 与语言 bug 同等对待。
4. 只承诺测过的：任何性能/覆盖率数字必须来自可复现的命令。
