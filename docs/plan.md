# Ming 实施计划（v0.45 起）

> 本文件是唯一的计划落盘位置。已完成项在版本提交后移到「已完成」；新想法先进「Backlog」，
> 只有进入版本范围才细化到任务级。当前版本：**v0.51.5**（下一阶段 v0.52–v0.55 见 §4.2;代码审查 16 项全部修复；C 后端 UB 修复；构建可信性；契约纯性 + ensures 全路径；效果门禁函数值闭合；wasm 比较操作码修复；自举工具统一入口 ming tools；ABI 哈希构建缓存 + GCM 最小帧修复已交付；契约阶段 2 + QF_LIA 第一片 M3042 已完成；测试 534 项全绿）。

---

## 0. 当前状态

| 项 | 状态 |
|----|------|
| 语言内核 | 显式类型/效果系统/值语义/确定性；树+VM+wasm+C 四后端 |
| C 后端 | C1 数值 → C2 str/Vec[i64] → C3 Map/Option/f64 打印 → C4 extern fn FFI（dlopen/dlsym）、`--static` |
| 构建 | `ming build` 真 AOT 字节码产物（无明文源）；`--with-source`；spawn/trait 自动回退；**v0.49 内容寻址缓存 + 接口哈希报告 + `--clean-cache`** |
| 自举工具 | 12 个全部 Ming 自写（mingkit 文件补丁 / edit 行级编辑 / engdiff 引擎差分 / diaghot 诊断热力图 / wc·tree·find·json·todo·log·rename·organize 日用小工具）；v0.51.6 起统一错误纪律（stderr + 失败退出 1）并全部 fmt 规范；`ming tools` 统一入口 + `--` 透传 |
| 质量护栏 | 回归全绿（v0.51.6 起 568 项，§54/§55 为复合赋值窥孔与工具纪律）+ 多后端差分模糊（四腿）+ bench（cc 腿） |
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

## 4.2 v0.52+ 路线(software-architect 规划,2026-11-11)

> 基线:v0.51.5,534 项测试全绿,四后端差分 0 分歧;§5.1 的 16 项审查缺陷已清零。
> 总原则:**先装安全带,再讲解开安全带的规则**——验证基础设施先于危险能力;一版一个语义面;
> 证明只报告、不先删检查;危险能力签名与块级双可见;每版可独立回退。

### 4.2.1 现状判断

- **强项**:四后端(树 / VM+wasm / VM-only / C)+ 差分模糊构成语义合同;效果门禁已闭合到函数值;
  契约有运行时检查与两片静态检查;诊断码稳定且带 span/hint/JSON;534 项回归是可信基线。
- **风险**:证明器只覆盖直线体 `ensures`,越界/调用链/循环仍空白,"证明 → 许可"闭环未建立;
  `unsafe`/`mask` 仍是设计稿;无 CI,跨平台门禁依赖单机;wasm 静默回落只有 `MING_WASM_DEBUG` 可见。
- **已知债务(本规划核实)**:
  - `collectProjectSources` 共享累加器导致重复条目(4 文件 → 8 条),且同 basename 不同目录交换内容
    会改变构建键(过度重建,非脏命中);v0.53 修复为"项目相对路径 + 内容"并加 Node 主版本。
  - 文档漂移(GUIDE 头 v0.48 / capabilities 头 v0.38 / plan §0 471 项 / M3030 效果列表):
    本次落盘已同步修正,余下覆盖率表述在 v0.53 审计。
  - README "cc 差分腿 = 解释引擎全形态"属过度声明(C 缺 `str` for-in);v0.53 补齐或改写。
- **最短板**:不是语言表面不够多,而是"检查 → 可证明、可复现、可跨平台验证"的闭环尚未形成。

### 4.2.2 关键 ADR

| ADR | 决策 | 理由 | 影响 |
|-----|------|------|------|
| ADR-001 | `unsafe` 仅在 C 原生后端执行;tree/VM 确定性拒绝(M4016);wasm 资格继续拒绝 | JS 引擎无法诚实模拟裸指针;伪指针会引入与 C 不一致的"安全兜底";与 extern ffi 的原生限定先例一致 | 四引擎合同出现**明示例外**:tree/VM 验证拒绝行为,C 验证执行行为;写入 GUIDE/design |
| ADR-002 | `mask [效果]` 本阶段不做(v0.56+ 评估) | 会让纯签名执行 IO,破坏"签名即效果真相";wasm/C 资格与契约纯性都读 `sig.effects`;且无资源句柄类型/逃逸分析 | 本阶段由 C 后端补全替代;mask 需独立 ADR 与审计报告 |
| ADR-003 | 边界证明不消除运行时检查 | 证明器尚未形式化验证;先积累 proof-vs-runtime 模糊证据;删检查属 codegen 语义变更 | v0.52/v0.55 冻结 `compiler/interp/vm/cbackend/artifact` |

### 4.2.3 v0.52 — QF_LIA 第二片:越界包含静态验证(只证明,不改 codegen)

**目标**:从 `requires` 的线性边界证明每个 `Vec` 索引点在界内;可证违反 → M3045 + 反例;未证明不阻断、不误报。

**范围**:i64 参数、非 `mut` 的 `Vec` 参数、`requires` 中的 `buf.len()`、直线体(Let/Assign/Return/纯调用语句)、单个索引点。
**不做**:循环、分支路径敏感、局部别名、`mut Vec`(push/pop 改长度)、通用 SMT、非线性、消除 M4003、任何 codegen 修改。

**任务**:
1. 抽出 `src/prover.js`:线性形式/差分约束(Floyd-Warshall 或 Bellman-Ford,变量 ≤12,BigInt 权重);checker 只留 AST 适配与诊断。先保证 §43 的 M3042 行为逐字不变。
2. 边界证明遍:`x.len()` → `len$x`;比较归一化为 `x - y <= c`(严格 `<` 转 `c-1`;`==` 拆双向;`!=`/`||`/非线性跳过);索引点证明 `0 <= i` 与 `i < len$base`;假设集负环(不可达)时跳过。
3. 诊断与反例:M3045[index-bounds-violated](error,含义务与反例;参数小值 + 长度 0..8 枚举);未证明仅在 `--warn-unproven-index` 下发 W3105[index-bounds-unproven]。
4. 证明报告:`ming check --proof-report` 文本摘要;`--json --proof-report` 增加 additive 的 `proofs` 字段;不带旗标时 JSON 与 v0.51.5 逐字一致(快照测试)。
5. 测试 §54(≥12 项):可证真/边界严格性/可证违反+反例/mut/循环/别名/非线性静默/警告旗标/无 requires 不警告/无旗标 JSON 不变/运行时仍 M4003。
6. `tests/proof_fuzz.mjs`:对 proven 索引随机生成满足 requires 的实参并运行 tree/VM,断言无 M4003;对 violated 用独立线性求值器验证反例。文档:GUIDE 静态边界证明节、diagnostics M3045/W3105。

**验收**:`node tests/run.mjs`(§54 ≥12);`proof_fuzz --count 200` 0 误报;`fuzz --count 40` 0 分歧;`check --proof-report` 输出 proven;`git diff` 对 compiler/interp/vm/cbackend/artifact 为空;check 语料 ≤1.2x v0.51.5 基线(信息性)。
**风险/回退**:误报 M3045 —— 用"非 mut Vec + 直线体 + 假设一致 + 差分约束"四重门控;出问题关闭对应模式(保留 W3105 观测),运行时语义未动。

### 4.2.4 v0.53 — 可信构建与跨平台验证基线

**目标**:让"通过"在 Linux/macOS/Windows × Node 18/20/22 可复现;wasm 静默回落成为 CI 可见失败;构建键真正由"路径 + 内容"决定。

**任务**:
1. **CI 矩阵**:GitHub Actions,`ubuntu/macos/windows × Node 18/20/22` 跑 `tests/run.mjs`、`fuzz --count 25`、`proof_fuzz --count 100`;C 腿在 ubuntu/macos 单独 job(gcc/clang);nightly 三种子 `--count 120`。只用官方 action,零 npm 依赖;PR 超时 20 分钟。
2. **strict wasm**:`--strict-wasm` / `MING_WASM_STRICT=1`;`--json` 增加 additive `wasm_status: none|ok|fallback`;eligible>0 但未实例化或发生回落 → 退出码 2 并打印原因;与 `--tree`/`--no-wasm` 互斥(冲突 exit 1);判定抽成纯函数,单测覆盖 fallback。
3. **`env -i` launcher 验收**(§55):最小环境 + 无关 cwd + dist 异地拷贝;POSIX 用 `env -i PATH=... LANG=C.UTF-8`,Windows 只保留 `SystemRoot`;断言输出/退出码逐字一致。
4. **构建可信性**:修复 `collectProjectSources`(递归返回本次新增条目,条目 = 项目相对路径 + 内容,注入 Node 主版本);`ming build --json` 增加 `build_key/dist_hash/cache_hit/source_count/interface_hashes`;回归:同名不同目录交换内容 → 键变化;两次 `--clean-cache` 构建 `dist_hash` 相同;第三次 `cache_hit: true`。只承诺"同 OS + 同 Node 主版本可复现"。
5. **C 后端 `str` for-in**:按 UTF-8 码点迭代(非字节);ASCII/CJK/emoji 三组三引擎黄金测试;fuzz 增加 `for ch in s { v += ch.char_len() as i64; }`;Backlog 移除 trim 族(已于 v0.51.3 完成)。
6. **文档真实性审计**:GUIDE/capabilities/README/plan 数字与版本头;无法被测试证明的表述改为"已声明覆盖范围 + 未覆盖清单"。

**验收**:`run.mjs` 0 失败(§55 ≥10);fuzz 0 分歧;两次 clean build `dist_hash` 相同;`cache_hit: true`;`env -i` 输出逐字一致;CI 矩阵绿(Windows 无 gcc 记录跳过,不失败);strict wasm 对 eligible 语料 `ok`、零 eligible `none`。
**风险/回退**:CI 抖动 —— C 腿/bench 独立 job;strict wasm 误判 —— `none` 白名单;构建键修复使旧缓存全部失效(一次性成本,文档说明)。

### 4.2.5 v0.54 — `with unsafe` 最小实现(C 原生,效果门禁)

**目标**:用最小 `Ptr` 面兑现"受控不安全":签名与块级双可见;C 真实执行;tree/VM 确定性拒绝。

**范围**:`unsafe { ... }` 块;`Ptr[mut u8]`/`Ptr[u8]`;`load/store/offset/is_null`;`std.mem.alloc/free`;extern 签名中的 Ptr;C5;tree/VM M4016;效果名 `unsafe`。
**不做**:Ptr 算术(除 offset)、Ptr↔整数、打印/相等、生命周期/逃逸分析、内联汇编、mmap、`unsafe(cond)`、JS 伪指针。

**任务**:
1. 类型/语法:`{k:'ptr', el, mut}`;`Ptr[mut u8]` 解析;`typeStr`;unify 精确匹配;禁止索引/算术/==/插值/debug/JSON/Map 键;方法 `load/store/offset/is_null`。
2. 效果/检查器:`unsafe` 入 KNOWN_EFFECTS;`unsafe {}` 需函数声明 `with unsafe`(M3029);指针操作/Ptr 实参必须在块内,否则 M3046[unsafe-context-required];块外只允许 let/assign/return 传递与 is_null。
3. C5:资格增加 C 专用 unsafe 扩展(效果 ⊆ {ffi, unsafe},wasm 不传);Ptr → `unsigned char*`/`const unsigned char*`;alloc/free → malloc/free;extern 槽位支持 Ptr;`--emit-c` 快照;`ming build` 遇 `with unsafe` 显式回退源码模式。
4. tree/VM 诚实拒绝:M4016[native-only-feature](panic,101),消息"unsafe 指针操作仅在 C 原生后端可用";tree/VM 逐字一致;wasm 继续拒绝 unsafe 函数,主程序回落 VM 得到同一 M4016。
5. 测试 §56(≥12):C 黄金程序;只读 Ptr 不可 store;块外 load → M3046;无 with unsafe → M3029;Ptr 实参传纯函数 → M3046;check 通过;tree/VM M4016;emit-c 含 `unsigned char*`/`malloc`;既有 C 差分零变化。
6. 文档:design.md §6.10 改为块形式并说明不用 `unsafe(expr)` 的理由;GUIDE unsafe/std.mem 节与安全/unsafe 对照;diagnostics M3046/M4016。

**验收**:`run.mjs`;`check examples/unsafe_demo.ming` 0 诊断;`cc` 输出黄金;`run --tree`/`--no-wasm` exit 101 + M4016;fuzz 0 分歧;Linux/Windows C 黄金一致;既有 C 差分零变化;`--strict-wasm` 不误报 ok。
**风险/回退**:悬垂/越界解引用是进程级 UB,Ming 不捕获(GUIDE 诚实声明);v1 限定 u8、禁止算术/打印;特性 effect-gated,可整体回退。

### 4.2.6 v0.55 — QF_LIA 第三片:跨函数契约摘要

**目标**:用"直线体 + 线性契约"的函数摘要,让调用链上的 ensures 可证明;绝不假设未证明的前置条件。

**范围**:i64 参数/返回、纯函数、直线体、无环调用图、单条 requires/ensures、摘要代入、调用点前置条件证明。
**不做**:循环/分支、递归/互递归、高阶函数、效果函数、堆/别名、通用 SMT、运行时语义变更。

**任务**:
1. 摘要引擎(prover.js):调用图拓扑序;DFS 检测环,递归函数标记"无摘要";摘要 = {requires 声明, ensures 仅在已证明时作为后置条件}。
2. 调用点前置条件:实参线性形式代入被调 requires,用当前假设证明;可证违反 → M3041 + 反例;无法证明 → 放弃该路径,不得假设被调 ensures。
3. 调用后置条件:调用成功后 `result` 绑定为新符号变量,加入被调 ensures 作为假设;未知/无摘要调用使相关表达式 unknown。
4. 调用方 ensures 证明:扩展 M3042 直线体遍历,使用"变量形式 + 差分约束假设集";可证假 → M3042 + 反例;不可判定静默,运行时 M4015 保留。不新增诊断码。
5. 测试 §57(≥10):f→g→h 链式 ensures;调用点违反 g.requires → M3041;g.requires 未证明时调用方 ensures 不得误判;递归/互递归/循环/分支静默;高阶/效果函数跳过;§43/§54 全绿;`proof_fuzz --mode summaries` 300 例。

**验收**:run.mjs;proof_fuzz 300 例 0 误报/0 假反例;fuzz 0 分歧;check --proof-report 链式 proven;check 语料 ≤1.25x v0.52 基线;codegen 零 diff。
**风险/回退**:摘要不健全 → requires 未证明则不采用 ensures 的硬门控 + 拓扑序 + 环检测;出问题退回 v0.52 行为。

### 4.2.7 诊断码登记

| 版本 | 新码 | 名称 | 触发/严重度 |
|------|------|------|-------------|
| v0.52 | **M3045** | index-bounds-violated | 由 requires 可证索引越界;error |
| v0.52 | **W3105** | index-bounds-unproven | `--warn-unproven-index` 下未证明;warning |
| v0.54 | **M3046** | unsafe-context-required | 指针操作/Ptr 实参在 unsafe 块外;error |
| v0.54 | **M4016** | native-only-feature | tree/VM 执行指针操作/std.mem;panic 101 |
| v0.55 | 无 | — | 复用 M3041/M3042 |

三处登记:`src/diag.js` CODES(+CODE_HINTS)、`docs/diagnostics.md`、`tests/run.mjs` 对应分节;GUIDE 修订记录同步;已发布码不改号。

### 4.2.8 Backlog 重排

| 项 | 处置 | 理由/前置 |
|----|------|-----------|
| `with unsafe` 实现 | **提升 v0.54** | 北星支柱;与 ffi 共用门禁;先有 v0.53 CI |
| `mask [效果]` | **降级 v0.56+** | 签名不再陈述真实效果;与资格/契约纯性冲突;需独立 ADR/审计 |
| 污点即效应(`untrusted`) | 保留 v0.57+ | 安全工具高价值;需净化/传播规则;在 mask 之后 |
| ffi 面扩大 | 拆分:Ptr 交集进 v0.54;struct/array 保留;`lib.fn` 运行时 API 删除 | extern fn 已覆盖可审计路径;动态符号破坏 AOT/审计 |
| 约束解码生成模式 | 移出语言计划(工具侧研究) | 非语言/编译器能力 |
| 内容寻址代码 | 降级 | 项目级 ABI 缓存已交付;函数级 ROI 无数据 |
| C `str` for-in / trim 族 | trim 已 v0.51.3;for-in 进 v0.53 | 关闭 C 差分最后已知形态缺口 |
| 泛型单态化缓存 | 降级 | 无 bench 证据 |
| async/eval/国密/交叉编译 | 保留远期 | 各自独立设计与安全评审 |
| 证明携带 unsafe(`unsafe(cond)`) | 新增 Backlog | 需带长度 Ptr/Slice 与证明令牌 |
| 循环/守卫敏感边界证明 | 新增 Backlog | `for i in 0..len { buf[i] }` 最高频;v0.52 只做直线体 |
| Ptr 带长度 / Slice 只读视图 | 新增 Backlog | 零拷贝与证明联动先决条件 |

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
| v0.52 | 三态稳定(proven/violated/silent);proof 报告 additive;codegen 零改动 | §54 ≥12;proof fuzz 200 例 0 误报;fuzz 40 程序 0 分歧;无旗标 JSON 快照不变 |
| v0.53 | CI 矩阵绿;strict wasm 无静默回落;`env -i` 可跑;构建键无重复/路径化;C str for-in 三引擎一致 | §55 ≥10;两次 clean build dist_hash 相同;文档数字与实现一致 |
| v0.54 | C unsafe 黄金通过;tree/VM 确定性 M4016;门禁闭合;无半开状态 | §56 ≥12;Linux/Windows C 黄金逐字一致;既有 C 差分 0 变化 |
| v0.55 | 跨函数 ensures 可证;前置条件不被跳过;无新码;codegen 零改动 | §57 ≥10;proof fuzz 300 例 0 误报/0 假反例;check ≤1.25x v0.52 |

**跨版本共同门槛**:`node tests/run.mjs` 0 失败;`fuzz` 0 分歧;新增分节测试;GUIDE 修订记录 + README 路线图 + plan 已完成项移动;版本三处同步;诊断码三处登记;不留下未提交生成物;性能数字必须来自可复现命令(bench 仍为信息性)。

---

## 5. Backlog

现行 Backlog 见 **§4.2.8(2026-11-11 重排)**;旧表已并入该表,避免双份漂移。


## 5.1 已知缺陷(2026-11-11 code-review,已逐项复核)

> 来源:两个 code-reviewer 子智能体 + 主会话复现。**状态:v0.50.1–v0.51.6 已全部修复。**`已验证` = 有可复现命令/输出;`源码确认` = 代码路径明确但未跑运行期。

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
| 22 | fmt 残余瀑布形态:`} else { // 注释`(else 头行尾注释)等仍需两遍到定点(else 头 `{` 源行号在两遍间漂移,在 preserveBlank 触达之外) | P3 | 待修(行为与修复前一致且幂等,非劣化;审查发现的残余面) |

## 6. 过程纪律（所有版本适用）

1. 每个版本：实现 + `tests/run.mjs` 分节测试 + 模糊抽查（0 分歧）+ 文档三条（GUIDE 修订记录 / README 路线图 / 诊断·能力矩阵按需）+ 版本三处同步 + 提交。
2. 发现既有 bug：先最小复现 → 回归测试 → 修复 → 记录在修订记录（不静默修）。
3. 自举优先：能用 Ming 写的工具不写别处；工具使用中发现的 bug 与语言 bug 同等对待。
4. 只承诺测过的：任何性能/覆盖率数字必须来自可复现的命令。
