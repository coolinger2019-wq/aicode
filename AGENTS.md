# AGENTS.md — Ming 项目 AI 协作指南

> 任何 AI 代理在本仓库工作前必读。人类维护者同样适用。
> **Ming（明）**——程序的含义必须和它写出来的一模一样。

---

## 1. 项目是什么

Ming 是一门为 **AI 与人类协作** 设计的编程语言（当前 v0.59.0），目标是让生成式 AI 更难写出错的代码、更容易被验证。核心立场：

- **显式**：无隐式转换、无 null、无真值化、无操作符重载、`mut` 显式声明
- **效果系统**：副作用必须声明并逐层传播（`with io, fs, ffi`），门禁即安全边界
- **值语义**：赋值/传参深拷贝，无别名 bug；确定性（Map 插入序、求值序、溢出必 panic）
- **机器友好**：所有工具支持 `--json`；稳定诊断码 M1xxx–M4xxx / W3xxx 带 hint
- **多后端**：树引擎 / 字节码 VM（含 WASM 分层）/ C 原生后端（`ming cc`）；三/四引擎差分是语义合同

## 2. 第一原则

1. **先读文档再动手**：`GUIDE.md`（使用指南）、`docs/design.md`（设计哲学与北星）、`docs/diagnostics.md`（诊断码表）、`README.md`（状态与路线图）、`docs/plan.md`（计划）、`docs/references.md`（参考语言缺口与进度跟踪）。
2. **计划落盘**：长期工作在 `docs/plan.md` 登记；已完成项移出。
3. **用 Ming 写 Ming 工具**（维护者明确要求）：遇到不便的工具缺口，优先用 Ming 编写（见 `tools/`），工具的真实使用即语言验证——使用时发现的 bug 必须修复并补测试。
4. **只承诺测过的**：设计文档 ≠ 已交付；任何声明必须能被 `node tests/run.mjs` 或差分模糊器证明。

## 3. 仓库结构

```
bin/ming.js          CLI 入口（run/check/test/fmt/doc/build/cc/lsp/repl/version）
src/                 lexer → parser → checker → compiler → interp/vm/wasm/cbackend
                     diag（诊断码与格式化）· artifact（AOT 字节码产物）· fmt · lsp · repl · manifest
tests/run.mjs        回归套件（881 项，含各版本分节 §1..§63；每次运行全量，无分节过滤）
tests/fuzz.mjs       多后端差分模糊器（树 / VM+wasm / VM-only / C 腿）
tests/proof_fuzz.mjs 静态证明模糊器（边界证明 1/2 + summaries + v0.57 loops 模式；反例独立求值器）
tests/bench.mjs      性能基准（tree vs vm(wasm) vs cc；v0.57 基线对比 --write-baseline）
tests/coverage.mjs   覆盖率观测（NODE_V8_COVERAGE；信息性不设门槛；基线见 docs/coverage-baseline.md）
tools/               自举工具（12 个，Ming 自写）：mingkit 文件补丁（read/write/replace 恰好 1 处/insert/del/count）·
                     edit 行级编辑（按行号，与 mingkit 按模式互补）· engdiff 三引擎差分 · diaghot 诊断热力图（目录展开 + --top）·
                     wc 行词字节（多文件 + total）· tree 目录树（深度可选）· find_files 按名查找 · json_query JSON 点路径（a.b.0.c）·
                     todo_scan 待办扫描 · log_analyzer 日志计数 · batch_rename 批量改名（幂等）· file_organizer 按扩展名归档。
                     纪律：错误走 stderr、失败退出码 1；破坏性操作目录必须显式给出；全部 `ming fmt --check` 规范
examples/            可运行示例
docs/                design.md 设计 · diagnostics.md 诊断码 · capabilities.md 能力矩阵 · plan.md 计划
GUIDE.md             使用指南 + 修订记录（每次改动必须登记）
```

## 4. 常用命令

```bash
node bin/ming.js run   examples/hello.ming        # 运行（默认 VM+wasm）
node bin/ming.js run   f.ming --tree              # 树引擎对照
node bin/ming.js run   f.ming --no-wasm           # VM 关闭 wasm
node bin/ming.js run   f.ming --strict-wasm       # wasm 回落可见失败（exit 2；与 --tree/--no-wasm 互斥）
node bin/ming.js check f.ming --json              # 类型检查（JSON 协议，含 fix 处方）
node bin/ming.js check f.ming --strict-wasm       # 检查 + wasm 分层存活验证（eligible 回落 → exit 2）
node bin/ming.js test  f.ming                     # test 块
node bin/ming.js fmt   f.ming --write             # 唯一风格
node bin/ming.js build                            # 项目模式：dist 字节码产物（AOT；v0.49 内容寻址缓存，命中即跳过）
node bin/ming.js build --with-source              # 附带源码
node bin/ming.js build --clean-cache              # 清理缓存与 dist 并全量重建
node bin/ming.js tools --list                     # 自举工具统一入口（工具本体仍是 Ming）
node bin/ming.js tools patch f.ming 旧串 新串      # 精确替换恰好 1 处（0/多处拒绝）
node bin/ming.js tools diff f.ming                # 多引擎差分（engdiff 路由）
node bin/ming.js cc    f.ming                     # C 原生后端（需 gcc/clang）
node bin/ming.js cc    f.ming --emit-c|--no-run|--static
node bin/ming.js repl|lsp|doc|version
```

自举工具（推荐一律走 `ming tools` 统一入口；`--` 之后的参数透传给工具本体）：

```bash
node bin/ming.js tools patch f.ming 旧串 新串        # 精确补丁恰好 1 处（0/多处拒绝）
node bin/ming.js tools edit show f.ming 1 20         # 行级编辑（show/get/set/ins/del/sub/append）
node bin/ming.js tools diff f.ming                   # 三引擎差分一条命令
node bin/ming.js tools diag src -- --top 5           # 诊断热力图（目录递归 + Top-N）
node bin/ming.js tools json pkg.json deps.0.name     # JSON 点路径（obj 键 + arr 下标）
node bin/ming.js tools wc a.txt b.txt                # 行/词/字节（多文件附 total）
node bin/ming.js tools tree . 2 | todo .             # 目录树限深 / 待办扫描
```

## 5. 测试与验证（提交前硬门槛）

```bash
node tests/run.mjs                    # 全量回归，必须 0 失败（每次全量运行,无分节过滤;约 6 分钟）
node tests/fuzz.mjs --seed 44044 --count 40   # 差分模糊（多后端必须 0 分歧）
node tests/bench.mjs                 # 基准（信息性；无编译器时 C 腿自动跳过）
```

- C 腿/编译器相关：本机 gcc 在 `C:/w64devkit/bin/gcc.exe`，探测顺序 `MING_CC` → PATH → 已知便携位置；无编译器时相关测试自动跳过（保持绿）。
- 新增功能必须同时：实现 + 分节测试 + 文档（GUIDE 修订记录、诊断码表、能力矩阵按需）。

## 6. 硬规则

1. **语言语义不可静默改变**。三引擎输出必须一致；panic 的消息与退出码 101 必须逐字对齐（含 M4002/M4003/M4004/M4006/M4007/M4013）。
2. **诊断码稳定**：新增用空号段（M5xxx 之外的 M4xxx 余量、W3xxx 余量）；已发布码不得改号。新码三处登记：`src/diag.js` CODES、`docs/diagnostics.md`、测试。
3. **不引入第三方依赖**：工具链与运行时保持 Node ≥ 18 零依赖。
4. **效果门禁**：碰 io/fs/net/ffi 等能力的代码必须在签名声明；extern fn 隐含 `ffi`。无门禁代码在类型层不得触达危险面。
5. **值语义**：Vec/Map 赋值/传参深拷贝；C 后端用 `ming_vec_copy`/`ming_map_copy`，wasm 用 `ming_copy_vec`。
6. **wasm/C 资格**：资格分析单一事实来源在 `src/wasm.js`（`analyze(opts)`）；wasm 路径不传扩展旗标（严格），C 后端按 C1/C2/C3 旗标放行；extern fn 预标记并跳过桩体。
7. **确定性**：不得引入依赖时间/随机/哈希序的行为；测试与基准的输出必须可复现。

## 7. 提交规范

- 消息：`Ming vX.Y.Z — <一句话摘要>`，正文用中文列要点（含测试数量与关键修复）。
- 版本三处同步：`package.json`、`bin/ming.js` 的 `VERSION`、GUIDE 修订记录新增条目；**每次版本发布必须同步更新 README.md 路线图与 docs/plan.md（已完成项移出、新版本条目登记）**，避免文档与实现漂移。
- 提交前：`node tests/run.mjs` 全绿；模糊器抽查 0 分歧。
- 已知环境事项：本机 Git 推送需 `GIT_CREDENTIAL_HELPER=false`（Windows 凭证管理器缓存了 gitee 凭证）；远程是 GitHub `coolinger2019-wq/aicode`。
- 会话工件（`.zcode/`）不入库（已在 .gitignore）。

## 8. 常见任务速查

| 任务 | 步骤 |
|------|------|
| 加一条静态检查/警告 | `src/checker.js` 发射点 → `src/diag.js` CODES → `docs/diagnostics.md` → `tests/run.mjs` 分节测试（正/负例） |
| 加 std 函数 | `src/interp.js` 效果函数 switch → checker 签名表 → GUIDE 文档 → 双引擎测试（tree/vm 一致） |
| 改 C 后端 | `src/cbackend.js`（资格经 wasm.js）；跑 `ming cc --emit-c` 快照 + 四方一致 + panic 首行对齐测试 |
| 改 wasm | `MING_WASM_DEBUG=1` 验证编译/实例化存活（§32 门禁）；保持三引擎差分绿 |
| 修语义 bug | 先写最小复现 → `tests/run.mjs` 回归（双引擎/四后端）→ 再改实现 |
| 加自举工具 | `tools/<name>.ming`，入口 `fn main(args: Vec[str]) -> i64 with io, ...`；**错误走 stderr、失败退出 1**；`ming fmt <文件> --write` 到规范（可能需两遍到定点）；`bin/ming.js` TOOL_CMDS 登记路由 + GUIDE 工具链表 + 测试 |

## 9. 已知陷阱

- **wasm 静默回落**：`tryCompileWasm` 失败返回 null 不报错；排查用 `MING_WASM_DEBUG=1`，并要求 `[wasm] fn <名字> OK` 且无 `REJECT`；或加 `--strict-wasm`（回落 → exit 2 并点名函数/原因）。v0.56 已修 W1 一元负号 / W2 循环内 if 的 break-continue br 深度 / F1 for-in continue 自增 / F2 `inferNumType`；**v0.59 已收口 #40 f64 局部/混合槽序、#41 Map 形参、#42 Vec 多形参、#43 str 返回、#45 值型 if、#46 块尾 unit if**，并修 6 个潜伏 bug（strConsts 空串 / VECMAP VOID / alloc 导入索引 / map_get 顺序 / 移位 64 / 守护口径）。**剩余守护**（不影响语义，strict 可见且原因具名）：VecLit 数值元素（容器表示未统一）、Vec 下标读/mut 元素写（宿主 `panic_m4003` 导入待补）、Option 消费链（宿主 M4006/M4007 导入待补）、f64 复合赋值等——见 plan §4.3.8/§5.1；改 wasm 签名/槽位/locals 时先跑 §63 P1 组（21 项）。
- **本地函数四条限制（v0.59 #44）**：函数体内 `fn` 是**块级条目**（同块可见、递归/互递归、契约同模块函数口径），但 (1) **不捕获外层局部**（引用 → check M3001；tree 帧 parent=null / VM 独立子函数帧同口径）；(2) **块级可见**（离开声明块即不可见）；(3) **泛型不支持**（**M3048**，专用码）且 **C 后端不支持**（`C1 不支持该程序形态: 语句 FnStmt`）；(4) **静态证明面不含本地函数**（M3041/M3042/M3045/W3105/proof-report 不遍历；运行时契约 M4015 仍执行）。同块 `let` 与 `fn` 同名、同块重名 `fn` → **M3009**；跨块遮蔽按词法最近块胜。M3047 已废弃不再发射——看到 M3047 即文档/实现漂移。
- **C 后端 panic 对齐**：`ming run` 的 panic stderr 含源码摘录与调用栈；C 侧只复刻**首行**（差分与测试均按首行比对）。
- **CRLF**：C 产物用 `_setmode(_O_BINARY)` 关闭 CRLF 翻译；`.gitignore` 与会话工件保持干净。
- **mingkit 转义**：只认 `\n \t \\` 一层；透明转义不存在，未知转义原样保留——嵌套 shell 时注意层数。
- **`Json` 类型**：unify 曾有 json 缺失分支 bug（v0.44 修）；Json 值可赋值/传参，但结构体不自动序列化（M3033）。
- **VM 操作数栈**：全帧共享 `valueStack`；`RET`/`?` 提前返回会截断到帧 `stackBase`（v0.44 修复 match-arm-return 残留）。
- **fmt 需两遍到定点**：注释瀑布按源行距保留空行,一次 `--write` 后注释占行可能触发再排;跑到 `fmt --check` 全绿为止(2026-11-12 已登记 plan.md #20)。v0.56 起 else/else-if 头行尾注释已一遍到定点(#22),且 `requires`/`ensures`/`invariant` 不再被 fmt 丢弃(#36);契约 `else` 插值消息已由 `msgRaw` 原样保留(v0.56.0 修,#39;运行时消息语义不变)。
- **strict-wasm 与解释器旗标互斥**：`--strict-wasm`（或 `MING_WASM_STRICT=1`）观测的正是 wasm 分层本身，与 `--tree`/`--no-wasm` 同时出现 → exit 1；strict 下 eligible>0 回落 → exit 2，非 strict 仍静默回落 exit 0（§57 v53.1-7 锁定）。
- **模糊器覆盖不等于语义证明**：v0.51.6 起生成器已含 `+=/-=/*=`（含 while 内）；VM 复合赋值窥孔 bug 曾因早期生成器不生成 `+=` 漏网。语义可疑时仍要写最小 .ming 复现跑 `--tree` 对照，别只信模糊绿。
- **unsafe 仅 C 原生可用**：`with unsafe`/`Ptr`/`std.mem` 在 tree/VM（以及 wasm 回落 VM）以 **M4016** panic（exit 101，消息逐字）；`ming cc` 是唯一真实执行者（C5 旗标仅 cc 路径传入）。`std.mem.alloc` 的 malloc 失败复用 **M4011**（不返回空指针）。悬垂/越界解引用是进程级 UB，Ming 不捕获——写 unsafe 测试时不要制造越界访问（§58 黄金均用 1–3 字节分配且界内）。
- **契约循环义务（v0.57）**：静态边界证明覆盖范围 for（`for i in lo..hi`，循环变量确定性符号 `i$<n>` + 半开区间假设入义务假设集）；**proven 不消除运行时 M4003**，`--warn-unproven-index` 对循环义务同口径（W3105）。脏循环（体内重赋值循环变量/改写外层可见变量/藏分支）、嵌套 for、`while`/`loop`、区间不可线性化一律静默放弃——"义务未采集"不等于"义务已证明"，别在文档或结论里混用。
- **LSP 分帧是字节口径（v0.58）**：stdio JSON-RPC 的 `Content-Length` 按 **UTF-8 字节**计,消息体含中文/emoji 时按字符累计会截断会话——服务端与测试两侧都必须 Buffer 分帧（lsp.js LspServer 与 §62 lspParse 同款）;坏 JSON 体/空体帧不杀会话（parse 失败 → msg undefined,不发错误响应照常续读），排查用 `MING_LSP_TRACE=1` 观测 chunk 与缓冲。
- **`use std.str` 下调用/方法双形式解析口径（v0.58）**：裸调用形式 `str(42)` 永远是内建（编译器 compileNamedValue 内建分支先于 use 导入），方法形式 `str.join(v)` 按导入解析为 std 模块;模块级 `fn str` 遮蔽时模块 fn 赢;**局部变量遮蔽基名**（`let str: Vec[str]` 后 `str.join(",")`）按局部值的方法调用解析（checker/compiler/interp 三处同口径的遮蔽守卫）——改这三处任何一处都要跑 §62 v58.26/v58.27 三引擎断言。wasm 侧 `str.join` 所在函数非直接调用 REJECT（strict 可见回落,exit 2）,cc C1 发射期拒绝,均不影响语义正确性。

## 10. 当前状态与下一步

- **v0.59.0**（2026-11-13，默认引擎全面性/质量版，无新语言面）：**881 项测试全绿**（§63 共 **56 项**：P1 21 + P2 13 + P3 2 + 审查修复 20）。**P1 wasm 覆盖收口**：修 #40 locals 索引偏移（声明从 `nParams` 起）、#41 Map 形参槽类型（`paramSlotTy` + `__kh/k/v`）、#42 Vec 多形参组合、#43 str 返回 `retTy`（含 strConsts 随产物返回）、#45 值型 if 单字节 valtype、#46 块尾 unit if 按语句编译；**6 个潜伏 bug**（strConsts 空串 / VECMAP VOID 导入 / alloc 导入索引 / map_get 实参顺序 / 移位 64 边界 / 守护口径）；**宿主补丁**（`map_get_i64`/`vec_get_i64` 返回 BigInt、`wasmWriteVecNum` 认 float）解锁 `Map[str,i64]` 与 `Vec[f64]` 形参；strict 语料 **fallback=0**（快照口径），剩余守护（VecLit/下标/mut 写/Option 链）显式回落具名。**P1 审查修复**：`<<` 结果溢出 wasm/C 四引擎 M4002、M4007 消息+位置三引擎逐字（span 实参）、VecLit/MapLit 计费、u64 字面量编码回归。**P2 本地函数恢复（#44）**：VM `precompileLocalFns`/`compileLocalFn`（块级条目 + 递归/互递归 + 契约同模块函数口径 + 作值 LDFN + AOT entry.sig）、tree `callLocalFn` 补齐；**M3047 废弃**；**四条限制**（不捕获外层局部 M3001 / 块级可见 / 泛型 M3048 与 cc 不支持 / 静态证明面不含本地函数）。**P2 审查修复**：兄弟 ensures、lambda 引用本地 fn、遮蔽语义定案（同块 let/fn M3009、跨块词法最近胜）、导入遮蔽 M3015。**P3 invariant bench**：`tests/bench.mjs` 新项"契约 invariant 循环"（300,000 次退出 vs 对照）VM 0.19–0.28µs/次、tree 0.20–0.28µs/次（占循环墙钟 20–27%，按 Starfish 5% 判据如实报告），基线含 `invariant.vmUs/treeUs`。**记账统一**：#48 wasm `str_cat` 计费（嵌套 11+15=26）、#49 `std.str.join` 对称化（§62 v58.29 断言翻转）。fuzz 三种子 0 分歧、proof_fuzz 0 误报。
- **v0.58.0**（2026-11-13，AI 协作体验与文本工程/开发者体验版）：825 项测试全绿（§62 共 34 项：A LSP 16 + B join/解析 13 + C doc/Release 5）。**A 包 LSP 扩展**：补全（标识符/字段方法/模块成员/枚举变体/关键字；保守策略——类型推不出 → 空列表、语法不可修复 → null、注释与字符串内不补全；打字中间态占位修复 + 第三式吞残余补括号）、跳转定义（模块项/局部绑定/跨文件 use；std 与内置 → null）、文档符号（fn/struct/enum/trait/const + impl 层级）；**非 ASCII 消息体按 Content-Length 字节分帧**（既有 P1 修复回归锁定）；审查修复：坏 JSON 体/空体帧存活（不再 ReferenceError 杀进程）、块注释内不补全（嵌套深度按 lexer 语义）；`completionFor/definitionFor/documentSymbolsFor` 导出供测试/工具直连。**B 包 std.str.join + 编译器名字解析**：`use std.str;` 纯函数 `str.join(Vec[str]) -> str` 单次 O(n) 拼接（**Builder→join 架构调整如实记录**，plan §4.3.5）；`use std.str` 下四形态名字解析三引擎逐字（裸 `str(42)` 内建 / `str.join(v)` 模块 / `as` 别名 / 模块级 `fn str` 遮蔽模块 fn 赢）+ **遮蔽守卫**（基名被局部遮蔽 → 按局部值方法调用，checker 与引擎不再分歧）；wasm：join 所在函数非直接调用 REJECT（`--strict-wasm` 可见回落）；cc C1 发射期显式拒绝；**#49 分配记账差异与 API 不对称如实登记**（`v.join(sep)` 计费 vs `str.join(v)` 不计费）。**C 包 doc --json + Release**：`ming doc --json` 稳定 schema（六种 kind 含 trait/impl；signature 为 AST 重建,impl 方法含 `with` 效果与 requires/ensures）+ `--index` 多文件聚合（默认文本逐字不变）；release.yml（tags `v*` + workflow_dispatch,官方 action,零 npm 校验,artifact `ming-<tag>`,**不自动创建 Release**——维护者手动附 artifact）+ `docs/release.md`。无新诊断码。v0.52–v0.57 路线已全部交付。
- **plan §4.3 任务已全部清空**（v0.56–v0.59 交付）；**2026-11-13 三方评估（架构/安全/最小变更）修订 plan §4.4**：v0.60 **资源门禁一致性**（#51 wasm 参数搬运计费分歧 + `wasmParamTop` 复位、#52 外部输入边界计费、#53 `--max-ms` 阻塞内建钳制、#54 `ming test`/`init` 旗标传播、#47 tree 契约重入；无新语言面）→ v0.61 **污点窄源条件交付**（ADR-002 五处补丁 + 12 工具迁移 spike；9 源全量为 v1.1）→ v0.62 **serve 条件交付**（ADR-001 16/16；独立版）。已知缺陷 #51–#57 见 `docs/plan.md §5.1`；#40–#46/#48/#49 已于 v0.59 收口。评估记录与实测证据见 `docs/plan.md §4.4.10`。覆盖率旧口径 `vm.js` 43.8% 已作废（实测 63.8%，51/80）。
