# AGENTS.md — Ming 项目 AI 协作指南

> 任何 AI 代理在本仓库工作前必读。人类维护者同样适用。
> **Ming（明）**——程序的含义必须和它写出来的一模一样。

---

## 1. 项目是什么

Ming 是一门为 **AI 与人类协作** 设计的编程语言（当前 v0.53.0），目标是让生成式 AI 更难写出错的代码、更容易被验证。核心立场：

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
tests/run.mjs        回归套件（628 项，含各版本分节 §1..§57；每次运行全量，无分节过滤）
tests/fuzz.mjs       多后端差分模糊器（树 / VM+wasm / VM-only / C 腿）
tests/bench.mjs      性能基准（tree vs vm(wasm) vs cc）
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

- **wasm 静默回落**：`tryCompileWasm` 失败返回 null 不报错；排查用 `MING_WASM_DEBUG=1`，并要求 `[wasm] fn <名字> OK` 且无 `REJECT`；或加 `--strict-wasm`（回落 → exit 2 并点名函数/原因）。已知残留形态（f64+while、if 表达式块类型）见 plan §4.2.8 Backlog。
- **C 后端 panic 对齐**：`ming run` 的 panic stderr 含源码摘录与调用栈；C 侧只复刻**首行**（差分与测试均按首行比对）。
- **CRLF**：C 产物用 `_setmode(_O_BINARY)` 关闭 CRLF 翻译；`.gitignore` 与会话工件保持干净。
- **mingkit 转义**：只认 `\n \t \\` 一层；透明转义不存在，未知转义原样保留——嵌套 shell 时注意层数。
- **`Json` 类型**：unify 曾有 json 缺失分支 bug（v0.44 修）；Json 值可赋值/传参，但结构体不自动序列化（M3033）。
- **VM 操作数栈**：全帧共享 `valueStack`；`RET`/`?` 提前返回会截断到帧 `stackBase`（v0.44 修复 match-arm-return 残留）。
- **fmt 需两遍到定点**：注释瀑布按源行距保留空行,一次 `--write` 后注释占行可能触发再排;跑到 `fmt --check` 全绿为止(2026-11-12 已登记 plan.md #20)。
- **strict-wasm 与解释器旗标互斥**：`--strict-wasm`（或 `MING_WASM_STRICT=1`）观测的正是 wasm 分层本身，与 `--tree`/`--no-wasm` 同时出现 → exit 1；strict 下 eligible>0 回落 → exit 2，非 strict 仍静默回落 exit 0（§57 v53.1-7 锁定）。
- **模糊器覆盖不等于语义证明**：v0.51.6 起生成器已含 `+=/-=/*=`（含 while 内）；VM 复合赋值窥孔 bug 曾因早期生成器不生成 `+=` 漏网。语义可疑时仍要写最小 .ming 复现跑 `--tree` 对照，别只信模糊绿。

## 10. 当前状态与下一步

- **v0.53.0**：628 项测试全绿；CI 矩阵（九组合 + C 腿 + nightly + 示例 fib strict 步）workflow 结构静态校验通过（实际矩阵以 GitHub Actions 记录为准，本机不代跑）；strict-wasm 三态（none/ok/fallback，回落 exit 2）；构建键修复（项目相对路径 + 内容 + Node 主版本；`build --json` 带 build_key/dist_hash/cache_hit/source_count/interface_hashes）；env -i launcher 验收；C 后端 `str` for-in 按 UTF-8 码点迭代；修复尾表达式函数的 wasm 模块校验回落（strict 暴露：函数级补零多压栈）；**v0.53.0 独立审查修复**（B1 同名文件构建键 fixture / B2 check strict fallback 保留 ok:false+diagnostics+proofs / B3 C 后端 for-in 遮蔽作用域 / M1 no-wasm 不报 wasm_status / M2 回落点名函数 / M12 wasm `/` 守卫 opcode 与 if 位置 / M6 env 剥离 / M7 build --json 纯 JSON / M9 CI 示例 strict）；ABI 哈希构建缓存、契约阶段 2 + QF_LIA 第一/二片此前已完成。
- 下一步见 `docs/plan.md §4.2`：v0.54 `with unsafe` → v0.55 跨函数契约摘要。
