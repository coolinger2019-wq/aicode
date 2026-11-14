# AGENTS.md — Ming 项目 AI 协作指南

> 任何 AI 代理在本仓库工作前必读。人类维护者同样适用。
> **Ming（明）**——程序的含义必须和它写出来的一模一样。

---

## 1. 项目是什么

Ming 是一门为 **AI 与人类协作** 设计的编程语言（当前 v0.64.0），目标是让生成式 AI 更难写出错的代码、更容易被验证。核心立场：

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
tests/run.mjs        回归套件（1035 项，含各版本分节 §1..§69；每次运行全量，无分节过滤）
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

- **v0.65.0**（2026-11-14，wasm 守护收口 slice 3 终章/引擎全面性，无新语言面）：**1035 项测试全绿**（§69 共 **19 项** check）。**五形态解锁**：expect(字面量 msg 经 strConsts 索引穿越导入边界；变量/插值 msg 仍具名守护)、Map unwrap(map_has 导入先判定，缺键 → panic_m4006)、Err unwrap/expect(objTable 句柄表示 + res_new/res_unwrap 导入族；Err(str/数值标量) display 逐字；容器/结构体/bool 载荷仍具名守护)、Vec[str] 下标读(vecstr_get 宿主界检查；元素写登记不做)、下标复合赋值(interp assignTo 双重求值口径；标量 &= |= ^= 顺带)。**#59 嵌套直调栈帧兑现**(Route E 调用点帧透传 frame_push/frame_pop——panic 穿透时 wasmCallFrames 并入 e.stack 后清空；main→f→g 三引擎完整 stderr 逐字；代价 wasm 直调 +18% 信息性)。**strict 自造语料 18 程序残留 0**——守护具名清单清零(余项 unwrap_or/is_some/is_none shape-eligible 具名回落/非字面量 msg/非标量载荷/Vec[str] 元素写/Map 下标复合赋值 全部 strict 具名——**修正既往 is_some·is_none "不 eligible" 口径**)。新导入 11 条(69→80 尾部追加零错位)。**独立审查 2 MAJOR 修复**：M1 无标注 Result let 的 resCtorSlotTy ReferenceError(非具名回落)→ 签名补 ctx + 标注非标量具名守护；M2 Result.expect 求值序 msg 先于接收者(span 差分)→ recv→args 恢复。遗留登记：Result 句柄池无回收(pre-existing 模式)/直调 +18%/M4002 wasm 消息口径(HEAD 预存)。fuzz 双种子 0 分歧。
- **v0.64.0**（2026-11-14，信任边界与诚实失败收口/质量安全版，零新增 M 码）：**1016 项测试全绿**（§68 共 **21 项** check）。**#56 AOT artifact 结构校验**：validateArtifact 在 format/version 后校验函数/索引/池/跳转面（functions 非空、mainFnIdx ∈ [0,len)、每指令 op ∈ OP(compiler 单一事实来源)、池下标/函数下标/wasm.eligible 键/跳转目标逐界检查）——**四损坏形态统一稳定诊断**"不是 Ming 字节码产物: <原因>"（raw TypeError 消除；33 opcode 全特性探针 + 21 损坏变体 + 工具 AOT 缓存自愈兼容）。**S9 嵌套 serve 编译期拒绝**：handler 体内 serve → M3002；**两遍式实现**（审查 M1 修复）——serveCallNodes 以 checker 真实解析为单一事实来源（解析失败不登记），run 收尾对 handler 体做节点身份扫描；**遮蔽误伤修复**（`let net: S` 后 trait 方法调用不再误判）；间接封装（helper 内 serve）v1 不扫描如实登记。**S12 sanitize_cli_path 闸门扩展**：+DEL(0x7F)/C1(0x80–0x9F)/双向控制符(U+202A–202E)——关闭 RTL 显示欺骗；代理对不误拒（😀 Ok）。**#57 安全回归批兑现**（§68 21 项）：M4013 专项**首破 0 次记录**、NUL 返回黄金（byte_len=2）、四损坏形态、S11 兜底语义、S13 慢连接行为。**#58 mut 写 panic 位置三引擎逐字**：compiler SETINDEX span → target.span（翻转 0；**cc 侧残留登记**——cbackend.js:986 语句列 + ming_vec_set 消息带读后缀）。**M5001 补登记** diag.js CODES（manifest.js 实际发射，单一事实来源缺口——第四轮发现，78 码）；M3012 hint 改现行 ToStr trait 口径（删"计划 v0.2"）；REPL 横幅对齐；S10"handler 载荷全部不可信"/S11 响应兜底语义/S15 strlen 截断语义写入 GUIDE；worker_start_failed 标签拆分（同步异常 → internal_error）。**独立审查**：通过（遮蔽误伤 M1 两遍式修复 + S12 向量补齐 + 残留登记）；fuzz 双种子 0 分歧。

- **v0.63.0**（2026-11-14，wasm 剩余守护收口 slice 2/引擎全面性续篇，无新语言面）：**995 项测试全绿**（§67 共 **28 项** check）。**五形态真实经 wasm**：Vec 下标读（线性内存 [len][cap][elems]，越界 → 宿主 `panic_m4003`，消息逐字含 `(用 .get(i) 返回 Option)` 后缀）、mut Vec 元素写（写穿可见，越界 → `panic_m4003w` 无后缀消息）、Option 数值 Vec `get(i).unwrap()` None 分支（`panic_m4006`）、VecLit 数值元素（线性内存构造型 ming_alloc 16+8n，与 v0.23 表示统一；修复 v0.23 memarg sleb ≥64 编码与 ming_alloc 缺 spanIdx 两处潜伏缺陷）、f64 复合赋值（除零 = IEEE ±Inf/NaN 不 panic，对照 interp）。**计费对齐**：新导入 `ming_alloc_elem`——VecLit 计 **元素数**（与 interp.js:1091 对齐）/分配 16+8n 分离；`ming_copy_vec` 改派生拷贝不计费（#51 口径）——`--max-alloc` 三引擎矩阵逐字（len3 max3=0/max2=M4011 累计 3）。**panic 栈单层补齐**：callCompiled catch 补 e.stack——M4003/M4006/M4002 wasm 完整 stderr 与 --no-wasm **逐字**。**值语义配套**：VecLit 局部化后 `let w = v`/`w = v`/mut 实参发射 ming_copy_vec 深拷贝（别名防线）；空 Vec 类型标注构造补位（resolveVecAnnTy，预存缺口）。**审查 B1 修复（BLOCKER）**：iscratch 跨表达式复用 → 五处 base ptr 改语句级专属 tempSlot（下标读/Map 下标读/VecLit/mut 写/Option unwrap），连带修复审查未发现的**跨变量嵌套读 `w[0]=a[b[0]]`** 与 **Map 读嵌套 `v[m["k"]]`** 两类潜伏冲突——8 复现程序三引擎逐字。**残留具名**：#58（mut 写越界 panic 位置 VM 与 tree 差 1 列，HEAD 预存，wasm 对齐 tree）/#59（wasm→wasm 直调 panic 栈缺内层帧，修复需调用点 span 透传）；守护收窄清单具名（expect 带 msg/Map unwrap/Err unwrap/Vec[str] 下标/下标复合赋值/is_some·is_none 精化——全部 strict exit 2 可见）。**导入纪律**：4 新导入全部尾部追加（导入表 69 个），G1 开发期一次 off-by-one 当场修复并写入注释教训。**独立审查**：1 BLOCKER + 2 MAJOR + MINOR 全部修复；fuzz 双种子 0 分歧。

- **v0.62.0**（2026-11-14，服务端 v1/条件交付兑现）：**967 项测试全绿**（§66 共 **22 项** check）。**`std.net.serve(port, handler) -> Result[i64, str]`**（net 效果；ADR-001 16/16 裁决后按 §5.2 实现）：**worker-per-connection**——accept 线程（node:http）+ 每请求隔离子 worker（复用 syncWorkerCode 管线，print 捕获丢弃；连接只是传输、按请求分派）；固定 **127.0.0.1** 回环（清单 15）；**16 worker/FIFO 256 队列/8MB 体/30s 超时**（terminate 硬杀）；绑定失败/端口非法 → Err（不 panic）；成功后永不返回（v1 无优雅停机，Ok 预留）。**载荷 Json**：请求 `{method,path,headers(小写),body}`/响应 `{status,headers,body}`（缺省 200/`{}`/`""`）。**错误体统一 `Json{code,message}`**：413 body_too_large / 503 queue_full（到达即拒）/ 500 handler_panic·worker_start_failed（名额同步释放 + 计数）·response_too_large（关连接）·internal_error / 504 timeout / 400 bad_request；**accept 线程三层护栏**（uncaughtException→reportFatal；safeWrite 全写路径 try + header 键值白名单拒绝 CR/LF；主线程 error/exit 监听置致命标记 → 驻留循环 ≤60s 返回 Err）——杜绝"死服务 = 悬挂"（审查 B1 实测复现后修复）。**checker serve 特例**（spawn 先例，零新码）：M3029/M3002/M3005；handler 效果白名单 8（`SERVE_HANDLER_EFFECTS`），sync/unsafe/ffi 拒绝；闭包/本地函数/变量持函数值/**跨模块引用**拒绝（worker 管线限制）。**三段式拒绝**：tree/VM 真实执行一致（共享 callStd）；wasm 永不 eligible（strict 具名不误报）；`ming cc` 发射期拒绝。**运维**：`--max-ms` 照常生效（**CLI 缺省 600000ms，长驻服务必须显式调大**）；`ming build` net 程序一律源码模式（http_get 纯客户端也回退，conservative）。**顺带修复 wire 顶层 Json 多包外壳潜伏 bug**（spawn 顶层 Json/Vec[Json]/Map[str,Json] 载荷曾 `j.v.has is not a function`；fuzz 双种子 0 分歧确认非 Json 载荷逐字不变）。**独立审查**：1 BLOCKER + 4 MAJOR（ADR §2.1 错误表同步/跨模块收紧/§66 tree 腿/文档）+ MINOR 全部修复（v66.10 三引擎、v66.16 CRLF 注入护栏、v66.17 9MB 响应、v66.18 跨模块）。ADR §2.1 错误表事件码命名同步（queue_full/timeout/handler_panic，M 码进 message）。

- **v0.61.0**（2026-11-14，污点最小片/窄源 v1，安全能力版）：**945 项测试全绿**（§65 共 **40 条** check）。**`Untrusted[str]` 类型标注**（编译期标签/运行时擦除；载体仅 str，`Untrusted[X]` X≠str → M3050；深拷贝保污点 = 类型恒等式；容器/struct/`?` 载荷精确传播）。**来源窄源**（破坏性签名变更）：`env.get -> Option[Untrusted[str]]`、`io.read_line -> Untrusted[str]`、**extern 返回强制**（声明裸 `-> str` → M3049；fs/net/proc 内容源 v1 不标 = 泄漏窗口如实登记）。**sink 门禁免费**：M3049[untrusted-mismatch] 统一机制 **21 槽位** + struct 字面量字段前置；反向裸 str 进 Untrusted 槽 → M3002。**操作面白名单 5 方法**（parse_i64/parse_f64/char_len/byte_len/is_empty，checker 导出 `UNTRUSTED_METHODS`）；白名单外 → **M3050[untrusted-method-forbidden]**；**禁面**：`debug(u)`/插值/`as` → M3050，`"a"+u` → M3008。**`std.unstr` 净化族**（纯函数、契约内可调用）：`mark`/`sanitize_path`（拒绝绝对路径**含 `C:x` 盘符相对**、`..` 段、内部空段、空串；Ok 规范化相对路径）/`sanitize_cli_path`（校验不改写：拒 NUL/C0，Ok 原样；授权位 = 路径实参位 + **CLI 匹配/比较串**，2026-11-14 裁决）。**wasm/C 按载体判定**（清单 14）：compiler `tryWasm` 解包顶层形参（`wasm.js analyze()` 零改动）；C 后端 `mingTyNum`/`annoTarget` 载体穿透；嵌套容器形参资格拒绝回落（输出三引擎一致）。**12 自举工具迁移**（8 工具 12 处 env.get 解包位包 sanitize_cli_path + 显式 Err；良性 env 行为与迁移前逐字一致）。**顺带修复**（污点实现暴露的既有缺口）：Option/Result 变体构造器载荷 tvar 从不绑定（`Some(脏)` 曾逃禁面）→ variantCtorType 补 `ps` + callCtor deepResolveT；struct 字面量字段位静默通过 → M3049 前置。**新码 M3049/M3050** 三处登记。**独立审查**：2 MAJOR（C 后端 Untrusted 标注缺口、`C:x` 漏判）+ MINOR 全部修复（v65.21–24 补契约 sanitize/`as`/载体禁面/cc 擦除一致腿）；latent N-61.1/N-61.2 登记。fuzz 双种子 0 分歧、proof_fuzz 0 误报。

- **v0.60.0**（2026-11-13，资源门禁一致性/质量版，无新语言面）：**905 项测试全绿**（§64 共 **24 项**：A 组 4 + B 组 9 + C 组 11）。**#51**：wasm Vec 实参搬运（派生拷贝）不再计入 `--max-alloc`（`mingAllocRaw(n, charge=true)` 开关，仅搬运传 false；ming_grow/copy_vec/str_cat 计费不变），`wasmParamTop` 调用前保存/finally 复位（panic/trap/编组回落三路径），线性内存随调用复用（`wasmParamTopStack` 删除）。**#52**：外部输入边界计费——read_file 先 stat 按 size 预记账、read_bytes 按 size、read_line/read_to_end 按结果长度、list_dir 按条目数、proc.exec 按 stdout+stderr 长度、http body 按长度；**计费 = 值创建 + 外部输入边界，派生值（deepCopy/json.parse/re.*/wasm 搬运）不重复计费**；Err 路径不计费且 Err 消息与 v0.59 逐字一致。**#53**：新增 `remainingMs()`；time.sleep/proc.exec/join/join_detailed/spawn_all/sync scope/http 等待钳到剩余预算，预算已尽不等待直接 `checkTimeQuota` → M4012；**`checkTimeQuota` 边界 `>` → `>=`**（钳制等待边界唤醒毫秒取整漏报修复；v0.32 自旋用例逐字不变）；**read_line/RegExp 进程内不可抢占边界具名**（不修，GUIDE/capabilities 声明）。**#47**：`execBlock` 仅在函数体块尾检查 ensures（ctx `bodyBlock`，callUser/callLocalFn 传入、嵌套块剥离）；return/`?` 处不变；`ensures if a>0 {true} else {true}` 三引擎输出 5（修复前 tree M4005 exit 101）。**#54**：`ming test` 旗标传播——`--tree/--no-wasm/--max-steps/--max-alloc/--max-ms` 与 run 同默认值（VMInterp.runTests 与基类 Interp.runTests **双路径**透传），`--strict-wasm` 仅做互斥仲裁、单独出现 stderr 提示忽略；`ming init` CLI 回归。无新诊断码（复用 M4011/M4012）。**3 名 fresh code-reviewer 独立审查**：唯一阻塞项（基类 runTests 漏透传 → `ming test --tree` 门禁静默失效、与 GUIDE 声明漂移）修复 + v64.B9 锁定；MINOR 5 项落实（ADR 白名单补 parse_f64、copy_file 正名、S7 措辞对齐、capabilities 头注翻转、strict 忽略提示）；latent **N-60.1–N-60.4** 登记（worker terminate 时序/stat 预记账平台差异/wasmWriteVecNum mut 旗标丢弃/test 模式 M4011 栈行 span）。fuzz 40 程序 0 分歧（wasm 真实执行 20）、proof_fuzz 100 例 0 误报。

- **v0.59.0**（2026-11-13，默认引擎全面性/质量版，无新语言面）：**881 项测试全绿**（§63 共 **56 项**：P1 21 + P2 13 + P3 2 + 审查修复 20）。**P1 wasm 覆盖收口**：修 #40 locals 索引偏移（声明从 `nParams` 起）、#41 Map 形参槽类型（`paramSlotTy` + `__kh/k/v`）、#42 Vec 多形参组合、#43 str 返回 `retTy`（含 strConsts 随产物返回）、#45 值型 if 单字节 valtype、#46 块尾 unit if 按语句编译；**6 个潜伏 bug**（strConsts 空串 / VECMAP VOID 导入 / alloc 导入索引 / map_get 实参顺序 / 移位 64 边界 / 守护口径）；**宿主补丁**（`map_get_i64`/`vec_get_i64` 返回 BigInt、`wasmWriteVecNum` 认 float）解锁 `Map[str,i64]` 与 `Vec[f64]` 形参；strict 语料 **fallback=0**（快照口径），剩余守护（VecLit/下标/mut 写/Option 链）显式回落具名。**P1 审查修复**：`<<` 结果溢出 wasm/C 四引擎 M4002、M4007 消息+位置三引擎逐字（span 实参）、VecLit/MapLit 计费、u64 字面量编码回归。**P2 本地函数恢复（#44）**：VM `precompileLocalFns`/`compileLocalFn`（块级条目 + 递归/互递归 + 契约同模块函数口径 + 作值 LDFN + AOT entry.sig）、tree `callLocalFn` 补齐；**M3047 废弃**；**四条限制**（不捕获外层局部 M3001 / 块级可见 / 泛型 M3048 与 cc 不支持 / 静态证明面不含本地函数）。**P2 审查修复**：兄弟 ensures、lambda 引用本地 fn、遮蔽语义定案（同块 let/fn M3009、跨块词法最近胜）、导入遮蔽 M3015。**P3 invariant bench**：`tests/bench.mjs` 新项"契约 invariant 循环"（300,000 次退出 vs 对照）VM 0.19–0.28µs/次、tree 0.20–0.28µs/次（占循环墙钟 20–27%，按 Starfish 5% 判据如实报告），基线含 `invariant.vmUs/treeUs`。**记账统一**：#48 wasm `str_cat` 计费（嵌套 11+15=26）、#49 `std.str.join` 对称化（§62 v58.29 断言翻转）。fuzz 三种子 0 分歧、proof_fuzz 0 误报。
- **v0.58.0**（2026-11-13，AI 协作体验与文本工程/开发者体验版）：825 项测试全绿（§62 共 34 项：A LSP 16 + B join/解析 13 + C doc/Release 5）。**A 包 LSP 扩展**：补全（标识符/字段方法/模块成员/枚举变体/关键字；保守策略——类型推不出 → 空列表、语法不可修复 → null、注释与字符串内不补全；打字中间态占位修复 + 第三式吞残余补括号）、跳转定义（模块项/局部绑定/跨文件 use；std 与内置 → null）、文档符号（fn/struct/enum/trait/const + impl 层级）；**非 ASCII 消息体按 Content-Length 字节分帧**（既有 P1 修复回归锁定）；审查修复：坏 JSON 体/空体帧存活（不再 ReferenceError 杀进程）、块注释内不补全（嵌套深度按 lexer 语义）；`completionFor/definitionFor/documentSymbolsFor` 导出供测试/工具直连。**B 包 std.str.join + 编译器名字解析**：`use std.str;` 纯函数 `str.join(Vec[str]) -> str` 单次 O(n) 拼接（**Builder→join 架构调整如实记录**，plan §4.3.5）；`use std.str` 下四形态名字解析三引擎逐字（裸 `str(42)` 内建 / `str.join(v)` 模块 / `as` 别名 / 模块级 `fn str` 遮蔽模块 fn 赢）+ **遮蔽守卫**（基名被局部遮蔽 → 按局部值方法调用，checker 与引擎不再分歧）；wasm：join 所在函数非直接调用 REJECT（`--strict-wasm` 可见回落）；cc C1 发射期显式拒绝；**#49 分配记账差异与 API 不对称如实登记**（`v.join(sep)` 计费 vs `str.join(v)` 不计费）。**C 包 doc --json + Release**：`ming doc --json` 稳定 schema（六种 kind 含 trait/impl；signature 为 AST 重建,impl 方法含 `with` 效果与 requires/ensures）+ `--index` 多文件聚合（默认文本逐字不变）；release.yml（tags `v*` + workflow_dispatch,官方 action,零 npm 校验,artifact `ming-<tag>`,**不自动创建 Release**——维护者手动附 artifact）+ `docs/release.md`。无新诊断码。v0.52–v0.57 路线已全部交付。
- **plan §4.5 进度**：**v0.64 信任边界与诚实失败收口、v0.65 wasm 守护收口 slice 3 终章、v0.66 观测与反馈（2026-11-14）已交付**——§4.5 全部兑现。下一步 **v0.67 候选（走查数据裁决）**：诊断协议校准（GO：误导 7 种/fix 错误 4/级联 1.75，三最小切口 <100 行）vs AI onboarding 打磨（REPL let #60/examples 补例 N-64）；Backlog：Untrusted[Json] 实现（ADR-004 四条件 go/no-go）、serve v1.1（no-go 推迟）、walker 统一/while 证明/checker 拆分（不承诺）。已知缺陷 #60/#61/#62（登记不修）；#40–#59 全部收口（见 `docs/plan.md §5.1`）；观测三文档 ai-loop-snapshot/serve-observation/adr-004。
