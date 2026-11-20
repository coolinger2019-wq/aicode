# O2.1 拷贝消除数据调研（ADR-010 输入）

> 状态：**只测量、只文档，零代码改动**（本调研未改 `src/`、`tests/`，未提交）；**v0.97 刷新**：#79/#81 已由实现批次落地（独立于本调研），本文对受影响作业复跑并保留 v0.96 基线列。
> 采集对象：**v0.96.0 基线**（HEAD `3d8a0b8`）+ **v0.97.0 工作树**（#79/#81），Node v24.11.0 / win32，2026-11-20。
> 唯一统计入口：`MING_STATS=1`（stderr 一行 JSON）；其余结论来自 `src/interp.js` / `src/vm.js` / `src/compiler.js` 静态阅读与靶点差分。
> 原始逐程序数据：`.zcode/o2r/stats.tsv`（v0.96 基线，gitignored，见 §7 复现）；v0.97 复跑命令同 §7。
>
> **v0.97 刷新摘要（读本文先看这四条）**：
> 1. **#79（VM CALLMETHOD 内建实参不深拷贝）已修复**——新增"内建方法实参拷贝"边界；容器/闭包实参现在计数上升，标量实参因 m1 恒等快路径不增。审查报告在 m1 前测得 hof 400,009 / wordfreq 180,079 / bench_vs 900,216；**落地值**为 hof 300,008 / wordfreq 80,075 / bench_vs 700,211（§2.1/§4.4）。
> 2. **#81（deepCopy 缺 vclose 分支）已修复**——闭包绑定不再是 O(1)：t5 6→10 entry/迭代、t5d 6→10；带捕获闭包绑定的 ST 现在深拷贝 captures（§4.1/§4.3）。
> 3. **#82（tree 闭包复制 parent 链共享）仍开放 P1**——tree 腿的闭包复制不是完整快照；O2 的闭包相关形态须以此为前置或 v1 排除（ADR-010 §2.2）。
> 4. **主结论不变**：现有 bench_vs/examples/tools 热路径的**容器**拷贝≈0，O2a/b/c 收益需专用基准才可测；#79/#81 改变的是计数与边界，不改变该结论（§5.5）。

---

## §1 目的与口径

### 1.1 目的

为 ADR-010（拷贝消除）回答四个问题：

1. 现有语料里 `deepCopy` 到底落在哪里、量级多大；
2. `deepCopy` 的调用点按 VM 指令如何分类，能否从 `MING_STATS` 总数反推类别占比；
3. 计划中的三条规则 O2a（fresh ST/SET）/ O2b（不可变 let 共享）/ O2c（fresh/最后使用实参）各自能消除多少——用靶点实测给出**上界估计**，不实现；
4. 拷贝消除是否改变 `--max-alloc`（M4011）等可观测配额语义。

### 1.2 字段口径（与 `bin/ming.js` `emitRunStats` 注释一致）

| 字段 | 口径 | 对本文的含义 |
|---|---|---|
| `instr` | 编译结果函数表指令总数 | VM 字节码规模；tree 为 `null` |
| `steps` | 引擎执行步数（wasm 循环头/调用按 +50 计） | 运行时观测 |
| `deepCopy` | `interp.js:deepCopy` **函数入口计数**，**含容器元素/闭包捕获的递归内层调用** | **不是**“拷贝次数”，也**不是**字节数；标量/str 也计 1 次（原样返回、零分配） |
| `alloc` | `chargeAllocBytes` 累计值（Vec/Map 按元素、str 按字符） | 配额口径，**不含 deepCopy**（§6 核实）；tree 为 `null` |
| `concat` / `callMethod` | VM opcode case 计数 | 可用于交叉核对方法/拼接流量 |

**关键口径警告**：`deepCopy(int/str/json)`、`deepCopy(空捕获 vclose)` 都是**原样返回、零分配**，但每次都计数。**v0.97 #81 起，带捕获的 `vclose` 不再是恒等**——`deepCopy(vclose)` 逐项深拷贝 captures（新建 vclose 头 + 捕获数组），同时计 1 + 各捕获元素的 entry。因此 `deepCopy` 总数是"拷贝入口热度"，不等于"真实容器拷贝分配数"。本文把两者分开：**entry**（入口计数）与 **real copy / allocation**（真正新建容器对象：Vec/Map/tuple/struct/enum/closure 对象或数组）。

### 1.3 两条腿：默认 VM+wasm 与 VM-only

默认 `ming run` 会把 wasm eligible 的函数放进 wasm 原生执行，**不经过 JS 执行循环，也不计 `deepCopy`**（`bin/ming.js` 注释明示）。对本调研（O2 的目标是 VM 字节码）这会造成严重低估：

| 程序 | 默认 `deepCopy` | `--no-wasm` `deepCopy` | 原因 |
|---|---:|---:|---|
| `fib` | 3 | 150,052 | `fib` 全程在 wasm 内递归，VM 只跑 `main` 包装 |
| `loopsum` | 3 | 6 | `sum_to` 在 wasm 内循环 |
| `modules`（例） | 50 | 54 | 部分几何函数进 wasm |
| `geom_driver`（例） | 53 | 57 | 同上 |

因此：**§2 同时登记两条腿；§3–§5 的占比与上界一律用 VM-only（`--no-wasm`）数据**，默认腿只作“wasm 覆盖会遮蔽多少”的记录。C 后端与 wasm 的拷贝另有独立机制（`ming_vec_copy` / `ming_copy_vec`），不在本文范围。

### 1.4 确定性协议

每个作业连续跑两次，比较 `instr/steps/deepCopy/alloc/concat/callMethod` 六个字段（stdout 中的自测毫秒 token 不参与比较）：

- 63 个程序/工具/靶点作业（§2 的 29 个语料作业 + 15 个 VM-only 镜像 + §4 的 19 个靶点；采集器逐作业两跑）全部完成两跑；除下条 filescan 的 alloc 外，六个字段两次一致；
- **v0.97 刷新**：受影响作业（hof/wordfreq/t5/t5b/t5c/t5d、examples/closures）按同一命令复跑，`instr/steps/deepCopy/alloc/concat/callMethod` 两次一致；新增的设计期补充探针 t11/t12（§4.4）为单次采集（合成算术自洽，不进入统计基线）；
- 唯一例外：`filescan` 的 `alloc` 出现 `7424281 / 7424282` 两值交替（±1，文件系统边界抖动）——与 `docs/opt-baseline.md` 已登记的既有 NOTE 一致，与优化/拷贝无关。`deepCopy`、`instr`、`steps` 仍两次一致。

### 1.5 语料边界

- `tests/bench_vs/progs/` 的 8 个 `.ming` 是：`fib`、`fib_cc`、`loopsum`、`loopsum_cc`、`hof`、`wordfreq`、`jsonparse`、`filescan`（**没有 `filescan_cc.ming`**）。
- `examples/geom.ming` 是模块，**没有 `main`**：`ming run` 报 M3023，`ming test` 不发射 `MING_STATS`。本文用 `.zcode/o2r/geommod/` 下的**同内容副本 + `use geom;` 驱动**测量（驱动代码只调用 `dist/midpoint/line_len` 并打印），数值包含驱动本身的开销，不能与其它 example 逐字横比；`geom` 原始文件未改动。
- tools 一律跑“无参/help 形态”，cwd 为空的 `.zcode/o2r/toolcwd`。`batch_rename` / `file_organizer` 在目录为空时打印用法并退出 1，未触碰任何真实目录；`tree` / `todo_scan` 无参时扫描空目录（exit 0）。14 个工具 = `tools/*.ming` 的 14 个文件（`mingkit` 经 `patch` 入口跑一次）。
- 所有靶点放在 `.zcode/o2r/`（gitignored），未进入仓库。

---

## §2 语料总表

### 2.1 `tests/bench_vs/progs/` 8 程序

默认腿 = `MING_STATS=1 node bin/ming.js run <prog>`；VM-only = 加 `--no-wasm`。
`jsonparse` 的 cwd 为 `.zcode/o2r/json`（10,469,349 B 的同一生成器 fixture）；`filescan` 的 cwd 为 `.zcode/o2r/fs1`（1000 个 170B 文件）。

| 程序 | 默认 instr | 默认 steps | 默认 deepCopy | 默认 alloc | VM-only instr | VM-only steps | VM-only deepCopy | VM-only alloc |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| fib | 46 | 7,502,476 | 3 | 13 | 46 | 1,800,608 | **150,052** | 14 |
| fib_cc | 30 | 7,502,460 | 0 | 0 | 30 | 1,800,592 | **150,049** | 0 |
| loopsum | 39 | 50,000,126 | 3 | 27 | 39 | 7,000,036 | 6 | 29 |
| loopsum_cc | 23 | 50,000,110 | 0 | 0 | 23 | 7,000,020 | 3 | 0 |
| hof | 59 | 2,200,039 | **300,008** | 250,024 | 59 | 2,200,039 | **300,008** | 250,024 |
| wordfreq | 166 | 760,136 | **80,075** | 20,228 | 166 | 760,136 | **80,075** | 20,228 |
| jsonparse | 95 | 67 | 12 | 10,469,427 | 95 | 67 | 12 | 10,469,427 |
| filescan | 145 | 395,044 | **20,006** | 7,424,281¹ | 145 | 395,044 | **20,006** | 7,424,281¹ |

¹ `filescan.alloc` 两跑 ±1（7,424,281 / 7,424,282）；`deepCopy/steps/instr` 确定。

**VM-only 总量（v0.97）：700,211 entries。Top 5：`hof` 300,008 → `fib` 150,052 → `fib_cc` 150,049 → `wordfreq` 80,075 → `filescan` 20,006。**

**v0.97 受影响作业对照（复跑，`--no-wasm`）**：

| 作业 | v0.96 基线（HEAD `3d8a0b8`） | v0.97 落地（#79/#81） | 审查报告口径（#79 m1 前） | 变化来源 |
|---|---:|---:|---:|---|
| hof | 300,005 | **300,008** | 400,009 | +3 = map/filter/fold 的闭包值实参各一次深拷贝；审查数的 +100,004 = `v.push(i)` 等标量实参也被逐个拷贝（m1 恒等快路径已跳过） |
| wordfreq | 80,075 | **80,075** | 180,079 | 审查数的 +100,004 = `push(w)`/`get(w)`/`set(w,n)`/`unwrap_or(0)` 的标量实参（m1 后跳过）；str/i64 均属恒等类型 |
| bench_vs 8 合计 | 700,208 | **700,211** | 900,216 | 仅 hof +3；其余 7 程序不变 |
| examples/closures | 105 | **110** | — | 4 个 HOF 闭包实参（map/filter/fold/sort_by）+ 1 次带捕获闭包 ST（#81） |
| examples 7 合计 | 371 | **376** | — | closures +5，其余不变 |
| t5（循环内闭包绑定） | 600,009 | **1,000,009** | — | #81：ST vclose 5/迭代（vclose 头 + 捕获 Vec 4） |
| t5d（只绑定不调用） | 600,010 | **1,000,010** | — | 同上 |
| t5b（无捕获）/ t5c（立即调用） | 200,002 / 500,009 | **200,002 / 500,009** | — | 无 ST vclose（空捕获 ST 归一为新 vclose(新对象+空数组)计 1；t5c 无绑定） |

> **口径纪律**：审查报告的 400,009/180,079/900,216 是 **#79 m1 恒等类型快路径之前**的实测（所有实参(含标量)逐个 deepCopy）；同批实现随后加了 m1 快路径，落地计数回到 300,008/80,075/700,211。两者都不是错数，但**不能混用**：引用时必须带"m1 前/后"标签。**#79 的边界仍然真实**——容器/闭包实参照样拷贝；容器实参见 §4.4 的 t11/t12（`v.push([1,2,3])` +4 entry/迭代）。

### 2.2 examples（有容器语义的代表集）

| 程序 | 默认 instr | 默认 steps | 默认 deepCopy | 默认 alloc | VM-only deepCopy | VM-only steps |
|---|---:|---:|---:|---:|---:|---:|
| closures | 113 | 227 | 110 | 47 | 110 | 227 |
| results | 189 | 220 | 50 | 2 | 50 | 220 |
| shapes | 108 | 118 | 41 | 3 | 41 | 118 |
| traits | 158 | 108 | 31 | 3 | 31 | 108 |
| json_demo | 165 | 142 | 33 | 4 | 33 | 142 |
| modules | 116 | 301 | 50 | 0 | 54 | 117 |
| geom_driver（替代 geom） | 124 | 309 | 53 | 57 | 57 | 125 |

**VM-only 总量（v0.97）：376 entries（含 geom 驱动 57）。** 这些程序的 `deepCopy` 绝对值很小（31–110），且以 struct/enum/闭包小对象为主——与 bench 的大循环不同，属“一次性启动/少量数据”量级。closures 的 +5 全部来自 #79/#81（4 个闭包实参 + 1 次带捕获闭包 ST）。

### 2.3 tools 14 个自举工具（无参/help 形态）

| 工具 | exit | instr | steps | deepCopy | alloc |
|---|---:|---:|---:|---:|---:|
| mingkit（`patch` 无参） | 1 | 1,242 | 81 | 7 | 68 |
| edit | 1 | 1,375 | 54 | 1 | 0 |
| engdiff | 1 | 311 | 21 | 2 | 0 |
| diaghot | 1 | 1,008 | 25 | 2 | 0 |
| xnopen | 1 | 613 | 20 | 2 | 0 |
| xnsni | 1 | 380 | 20 | 2 | 0 |
| wc | 1 | 308 | 39 | 3 | 0 |
| tree | 0 | 378 | 93 | 17 | 0 |
| find_files | 1 | 349 | 59 | 4 | 0 |
| json_query | 1 | 1,101 | 79 | 4 | 0 |
| todo_scan | 0 | 395 | 70 | 11 | 0 |
| log_analyzer | 1 | 264 | 44 | 3 | 0 |
| batch_rename | 1 | 477 | 111 | 5 | 0 |
| file_organizer | 1 | 349 | 52 | 3 | 0 |

**合计：66 entries / 68 alloc。** help 路径基本不触达容器逻辑；exit 1 是工具自身的用法错误约定（错误走 stderr、退出 1），不是崩溃。`ming tools` 的两次运行统计一致——AOT 缓存只跳过 check/compile，不改变执行期 `deepCopy` 计数（`resetDeepCopyCount` 在 `cmdRun` 起始、执行前调用）。

### 2.4 语料合并

| 语料 | 作业数 | VM-only deepCopy（v0.97） | 占全语料 |
|---|---:|---:|---:|
| bench_vs 8 | 8 | 700,211 | 99.94% |
| examples 7（含 geom 驱动） | 7 | 376 | 0.05% |
| tools 14 | 14 | 66 | <0.01% |
| **合计** | **29** | **700,653** | 100% |

注：`alloc` 列不可相加比较——它是配额计费元素数，`jsonparse` 的 10.4M 主要来自 10MB 文件输入边界（`fs.read_file` 按 size 计费），不是拷贝。v0.96 基线合计为 700,645；v0.97 增加 8 = bench_vs +3（hof 闭包实参）+ examples +5（closures）。

---

## §3 静态分解表

### 3.1 `deepCopy` 调用点全清单（按 VM 指令分类）

`interp.js` 是 tree/VM 共享的基类；VM 的字节码绑定边界在 `vm.js`。下表“VM 点”是默认引擎实际执行的热点，“tree 对应点”用于对照与静态证明。

| # | 类别 | VM 调用点 | tree 对应点 | 触发条件（发射端） | 每次调用的 entry 数 |
|---|---|---|---|---|---|
| 1 | **ST** | `vm.js:731` | `interp.js:1338`（`bindPattern` PIdent；Let `1130→1144`） | `let` PIdent（`compiler.js:875`）；`for`/`while-let` 简单 ident（`compiler.js:745/786`）；ensures resultSlot（`compiler.js:686/1103`） | 1 + 容器逐元素递归；**#81 起 vclose 值另含 captures 逐项拷贝** |
| 2 | **SET** | `vm.js:745` | `interp.js:1268-1269`（`assignTo`） | 非融合 Ident 赋值（`compiler.js:964`）；复合赋值 general path（`compiler.js:660–690`）；fused ADDI/BINSETI/BINSET2 不经过 | 1 + 递归 |
| 3 | **BIND** | `vm.js:981` | `interp.js:1192`（while-let）、`1551`（match 臂）、`1338`（tuple 递归） | `let` 元组模式、非简单 for/while-let 模式、match 绑定（`compiler.js:923/1091`） | 每槽 1 + 递归 |
| 4 | **MAKEVEC** | `vm.js:877` | `interp.js:1559` | 每个 Vec 字面量 | 每元素 1 + 递归 |
| 5 | **MAKEMAP** | `vm.js:892` | `interp.js:1571` | 每个 Map 字面量（键不拷贝，`normKey`） | 每值 1 + 递归 |
| 6 | **MAKETUPLE** | `vm.js:904` | `interp.js:1580` | 每个 tuple 字面量 | 每元素 1 |
| 7 | **MAKESTRUCT** | `vm.js:913` | `interp.js:1659`（`evalStructLit` 字段） | 每个 struct 字面量（ctor） | 每字段 1 + 递归 |
| 8 | **MAKEENUM** | `vm.js:924` | `interp.js:1699/1700/1704/1708/1715/1735`（args 先拷，`constructVariant 1797`） | enum 变体构造 / `Some` / `Ok` / `Err` | 每 payload 1 + 递归 |
| 9 | **调用实参** | `vm.js:658`（`callCompiled` 形参装载）；`842`（CALLMETHOD ctor）、`1161`（callValue ctor） | `interp.js:948`（callUser）、`1050`（callClosure）、`1771`（callLocalFn）、`1735`（方法调用点） | 每次字节码函数调用/闭包调用/本地函数调用；ctor 作值调用；**内建方法调用（v0.97 #79）** | 每实参 1 + 递归 |
| 10 | **闭包捕获 / CLOSURE 计划** | `vm.js:757`（`OP.CLOSURE` 按 capture plan 逐项拷） | `interp.js:4330`（`snapshotEnv`：tree 对可见环境整体拷） | 每次 lambda 创建；plan = 自由变量表（`compiler.js:1531`） | 每个捕获值 1 + 递归（VM 只拷 plan；tree 拷可见环境） |
| 11 | **其他写边界** | `vm.js:795`（SETFIELD）、`813`（SETINDEX） | `interp.js:1268`（assignTo Field/Index） | `s.f = v`、`v[i] = x`、`m[k] = x` | 1 + 递归 |
| 12 | **wasm 返回编组** | `vm.js:598`（Vec[str]）、`609`（Map） | — | wasm eligible 函数返回对象表值 | 1 + 递归（仅该返回形态） |
| 13 | **内置访问器返回副本** | 共享 `interp.js` 实现 | `3650`（Slice get/at）、`3694/3699/3700`（Vec get/first/last）、`3764`（Vec.clone）、`3803`（Map.get）、`3818/3819`（values/items）、`3801`（Map.clone）、`3918/3921/3930/3936`（Option/Result unwrap/unwrap_or） | 内置方法调用 | 1 + 递归；values/items 每元素 |
| 14 | **tree 函数边界（VM 不存在）** | — | `interp.js:948/1050/1771`（形参）、`989`（ensures result）、`1134`（Return 值） | tree 引擎专用 | 1 + 递归 |
| 15 | **CALLMETHOD 内建实参（v0.97 #79）** | `vm.js:852`（`methodArgsNeedCopy` 路径） | `interp.js:1735`（tree 调用点） | 每次内建方法调用（Vec/Map/str/Slice/...）；用户方法走帧绑定；标量恒等类型快路径跳过 | 每个非恒等实参 1 + 递归 |

补充：

- `deepCopy` 内部的 `90/95/100/107/110/113` 是 vec/map/struct/enum/closure 的**递归元素调用**，不是独立类别。
- `interp.js:732` 是 `normBindValue` 规格外字段的**防御性** deepCopy（正常路径传入值已是私有副本，注释明示“防御性冗余”）。
- **VM `vclose`（闭包值）：v0.97 #81 前**在 `deepCopy` 的 `default` 分支原样返回——绑定闭包只计 1 entry、不复制捕获数组（旧 t5/t5d 6/迭代）；**#81 后**新增 `case 'vclose'`，captures 逐项深拷贝（空捕获归一为新 vclose(新对象+空数组)），绑定带捕获闭包 = 1 + captures 递归（t5/t5d 10/迭代）。tree 的 `closure` 分支重建 `env.vars` 但**共享 `env.parent`**（#82 开放 P1）——两引擎计数仍不可直接横比，且闭包复制的值语义在 tree 腿尚不完整。

### 3.2 能否从 `MING_STATS.deepCopy` 总数反推类别占比？

**不能。** 原因：

1. 只有一个全局入口计数器，没有 per-opcode 归属；
2. 递归内层调用与顶层调用不可区分（一个 `ST` 拷贝 8 元素 Vec 记 9 entry）；
3. 标量/str/Json 的 no-op 与真实容器拷贝同权计数；
4. `alloc` 不记录 deepCopy，无法交叉归属。

因此本文用**靶点差分法**（§4）：构造只命中单类的程序，用“总计数 − 同类基线”隔离每个类别的每迭代成本。`callMethod` 可作为辅助交叉核对（§4.4）。

---

## §4 靶点差分结果

全部靶点在 `.zcode/o2r/`，`--no-wasm`，循环 N = 100,000。总计数 = N × 每迭代 + 固定开销；“/iter”列已用总数对 N 取整并用余数核对。

### 4.1 六个规定靶点（+ 差分变体）

| 靶点 | 形态 | 总 deepCopy | /iter | 每迭代分解（entry） | 总 alloc |
|---|---|---:|---:|---|---:|
| t1_vec_bind | `let b = a;`（a 为 mut Vec[3]） | 500,009 | 5 | ST vec 4（vec 1 + 3 元素）+ SET acc 1 | 3 |
| t1b_vec_read | `acc += a[0];`（只读） | 100,009 | 1 | SET acc 1；**INDEX/LD 零拷贝** | 3 |
| t1_imm_vec_bind | `let a` 不可变 + `let b = a;` | 500,009 | 5 | 同 t1（constProp 不传播容器） | 3 |
| t2_vec_arg | `acc += peek(a);`（只读形参） | 500,009 | 5 | 形参拷贝 vec 4 + SET acc 1 | 3 |
| t3_struct_field | `let b = Box { items: [1,2,3] };` | 1,300,002 | 13 | MAKEVEC 3 + MAKESTRUCT 字段 4（vec 1+3；struct 对象由 MAKESTRUCT 自身新建，不另计 entry）+ ST struct 5（struct 1 + 字段 vec 1+3）+ SET 1 | 300,000 |
| t4_map_bind | `let n = m;`（Map[str,i64] 3 键） | 700,009 | 7 | ST map 4（map 1 + 3 值）+ `get("a")` 实参 str 1 + `unwrap_or(0)` 实参 int 1 + SET 1 | 3 |
| t5_closure_capture | `let f = () => a[0];` 循环内创建+绑定 | 1,000,009 | 10 | CLOSURE 捕获 vec 4 + **ST vclose 5**（vclose 头 1 + 捕获 vec 4）+ SET 1（#81 后；v0.96 为 600,009/6） | 3 |
| t6_fresh_st | `let v = [1,2,3];` 循环内 | 800,002 | 8 | **MAKEVEC 3 + ST vec 4** + SET 1 | 300,000 |
| t6b_fresh_nobind | `acc += [1,2,3][0];`（不绑定） | 400,002 | 4 | MAKEVEC 3 + SET 1 | 300,000 |
| t7_fresh_set | `v = [1,2,3];` 循环内 | 800,009 | 8 | MAKEVEC 3 + **SET vec 4** + SET acc 1 | 300,003 |
| t8_fresh_arg | `peek([1,2,3]);`（fresh 实参） | 800,002 | 8 | MAKEVEC 3 + **实参拷贝 vec 4** + SET 1 | 300,000 |
| t8b_lastuse_arg | `let a=[1,2,3]; peek(a);`（a 最后使用） | 1,200,002 | 12 | MAKEVEC 3 + ST a 4 + 实参 4 + SET 1 | 300,000 |
| t8c_mut_param | `let a=[…]; consume(a);`（mut 形参，callee push） | 1,200,002 | 12 | MAKEVEC 3 + ST a 4 + 实参 4 + SET 1（push 只计 alloc，不 deepCopy） | 400,000 |
| t9_scalar_st | `let x = i;` 循环内 | 100,002 | 1 | ST 标量 1（no-op；`acc += x` 走 BINSET2 融合，0） | 0 |
| t10_copy_dense | O0 拷贝密集原形：`let copy=r; r=copy;`（Rec{3×i64, Vec[8]}） | **2,700,035** | 27 | ST struct 13 + SET struct 13 + SET acc 1 | 8 |
| t10b_imm_struct_bind | 同 t10 但 `let r` 不可变、无回写 | 1,400,035 | 14 | ST struct 13 + SET acc 1 | 8 |
| t5b_closure_nocap | `let f = () => 7;` | 200,002 | 2 | ST vclose 1 + SET 1 | 0 |
| t5c_closure_imm | `(() => a[0])()` 立即调用 | 500,009 | 5 | CLOSURE 捕获 vec 4 + SET 1 | 3 |
| t5d_closure_store_only | 只创建并绑定闭包，不调用 | 1,000,010 | 10 | CLOSURE 捕获 4 + ST vclose 5 + SET last 1（#81 后；v0.96 为 600,010/6） | 3 |

`t10` 与 `docs/opt-baseline.md` 的“拷贝密集 10 万绑定”**逐字对上：deepCopy 2,700,035 / alloc 8 / steps 2,000,030**，说明本调研的采集口径与 O0 基线一致。**t5/t5d 已按 v0.97 #81 复跑**（表中新值；v0.96 基线 600,009/600,010 保留在构成列），其余靶点不受 #81 影响（无 vclose 绑定）。

另抽查 `--no-opt` 对照（t1/t3/t6/t8/t10/t10b）：`deepCopy/alloc/steps` 全部相同；仅 t8 的 `instr` 从 33 变 31（peephole 删了 2 条指令，不触碰拷贝边界）。O1 的四个 pass 不会改变本调研的拷贝口径。

### 4.2 差分隔离（每迭代）

| 差分 | 差值 / 100k | 归属 |
|---|---:|---|
| t6 − t6b | 4 | **ST vec 4**（fresh ST 的拷贝恰好 1+3） |
| t1 − t1b | 4 | **ST vec 4**（`let b = a`；读路径零拷贝） |
| t2 − t1b | 4 | **形参拷贝 vec 4** |
| t8 − t6b | 4 | **fresh 实参拷贝 4** |
| t8b − t6 | 4 | **最后使用实参拷贝 4**（t8b 在 t6 的 ST 之外多一次调用拷贝） |
| t5c − t1b | 4 | **CLOSURE 捕获 vec 4**（`a` 被捕获时拷 1+3；立即调用无 ST vclose，故不受 #81 影响） |
| t5 − t5b | 8 | **CLOSURE 捕获 4 + ST vclose 增量 4**（#81 后 t5=10、t5b=2；ST vclose 全量 5 中 1 是 vclose 头、4 是捕获二次拷贝） |
| t10 − t10b | 13 | **SET struct 13**（`r = copy` 的回写拷贝） |

### 4.3 关键结论（靶点层）

1. **读不拷贝**：`LD`（`vm.js:721–725`）直接压栈；VM/tree 的 `INDEX`（`vm.js:1072`、`interp.js:1456`）直接返回元素引用。真正拷贝发生在**写边界**（ST/SET/BIND/MAKE*/实参/捕获/SETFIELD/SETINDEX）。所以“不可变 let 读取免拷贝”在现有实现里**没有可省的读拷贝**——O2b 的实际语义必须是“绑定处共享 RHS 容器”（§5.2）。
2. **ST 是拷贝大户，但“是否 fresh”决定可省性**：t1 的 ST 占 80% entry；t10 的单次 ST 占 48%、ST+SET 合计 96%——但源都是已绑定变量，不能免；t6/t7 的 ST/SET 占 50%，源是紧邻的 MAKE*，可免。
3. **闭包绑定不是 O(1)（v0.97 #81 修正）**：旧实现 `deepCopy(vclose)` 走 default 恒等，ST vclose 只计 1 entry（捕获拷贝只发生在 `CLOSURE` 创建时）——**该口径已作废**。现 `deepCopy(vclose)` 深拷贝 captures：t5 从 6→10 entry/迭代、t5d 6→10；其中 CLOSURE 捕获创建 4、ST vclose 5（头 1 + 捕获 4）、SET 1。**tree 腿另有 #82**：`deepCopy(closure)` 复制 `env.vars` 但共享 `env.parent`，所以"闭包复制 = 完整快照"在 tree 尚不成立（不能把 VM 的 #81 修复当作双引擎已完成）。
4. **标量 ST 全是 no-op**：t9 100,000 次 `let x = i` 产生 100,002 entry、0 alloc；fib 的 150,052 也全部是形参 i64 的 no-op。用 `deepCopy` 总数衡量“拷贝成本”会把这些算进去，必须区分。
5. **构造内部拷贝是独立类别**：t3 的 13 entry 中，MAKEVEC 3 + MAKESTRUCT 4 = 7（54%）发生在“构造”而非“入槽”；O2a（fresh ST/SET）只能省 ST 的 5/13（38%）。

### 4.4 `callMethod` 交叉核对

`MING_STATS.callMethod` 能佐证分解：

- `hof`：100,005 = 100,000 次 `v.push` + `map/filter` 各 1 + `fold` 1 + 收尾 2；`deepCopy` **300,008**（v0.97）= map 100,000 ×1 + filter 100,000 ×1 + fold 50,000 ×2（闭包形参）+ 收尾 5 + **3 次闭包值实参拷贝（map/filter/fold 各 1，#79）**。**i64 形参/绑定仍全部 no-op，零容器拷贝**。审查报告 m1 前为 400,009（含 `v.push(i)` 100,000 次标量实参 + map/filter/fold 的 int/closure 实参 4 次）。
- `wordfreq`：100,009 = 生成段 `std.rand.range` 20,000 + `words.push` 20,000 + 计数段 `set/get/unwrap_or` 各 20,000 + 收尾 9；`deepCopy` **80,075** = 生成段 `let idx` 20,000 ×1 + 计数段 `let w`/`get`/`unwrap_or` 20,000 ×3 + 收尾 75。**全部 str/i64 no-op**。审查报告 m1 前为 180,079（`words.push(w)`/`counts.get(w)`/`counts.set(w,n)`/`unwrap_or(0)` 的标量实参各计一次 = +100,004）；m1 恒等快路径落地后回到 80,075。
- `filescan`：5,002 次方法调用（`split/len/byte_len` 等）与 20,006 entry 的量级吻合；20,006 entry 中约 1,000 次是 `let _w = write_file(...)` 的 Result enum ST（真实 enum 对象分配），其余是 str/Result 的 no-op 或标量。

**v0.97 #79 新增边界：内建方法实参**（本调研补充实测，`.zcode/o2r/t11/t12`，`--no-wasm`，N=100,000）：

| 靶点 | 形态 | 每迭代 entry | 构成 | 与 #79 前对比（前值为构造推算） |
|---|---|---:|---|---|
| t11_method_fresh_arg | `vv.push([1,2,3])`（fresh 实参） | **7** | MAKEVEC 3 + **内建实参拷贝 4** | #79 前应为 3（MAKEVEC 3；别名语义错误）；+4/迭代 = +133% |
| t12_method_bound_arg | `let a=[1,2,3]; vv.push(a)`（绑定后传入） | **11** | MAKEVEC 3 + ST a 4 + **内建实参拷贝 4** | #79 前应为 7（3+4）；+4/迭代 |

两个靶点三腿输出一致（`vv.len()`），`--no-opt` 同值。t11 说明：**fresh 容器实参的拷贝在 #79 后是纯冗余**（调用方弹栈后无第二引用）——这是 O2c 在 CALLMETHOD 上的同构机会（ADR-010 §4.4.7 O2c-M），CALL 掩码不覆盖该指令。t12 的 `a` 是最后使用，O2c-M 可省 4/11（36%）；t11 可省 4/7（57%）。**现有语料热循环没有容器方法实参**（hof/wordfreq 的方法实参全是标量/闭包），故该边界不改变 §5.5 的语料结论，但**是 O2 立项后必须计入的新拷贝源**。

---

## §5 O2a / O2b / O2c 可消除上界估算

### 5.0 计量单位与估算方法

- **entry 口径**：`deepCopy` 入口计数；用于对照 `MING_STATS`。
- **real copy 口径**：真正新建容器/闭包对象的次数（Vec 数组、Map、tuple/struct/enum 对象、closure/vclose 对象及其捕获数组）；由静态类型与靶点分解推算。entry 与 real copy 的比值随容器元素数变化（t10：27 entry / 4 real copy / iter；t5：#81 后 10 entry / 3 real copy / iter）。
- **allocation 口径**：real copy 的对象数；不含 MAKE* 自身的构造分配。O2 消除的是“拷贝分配”，构造分配仍在。
- 靶点数字是**精确**的（同一程序两次一致，分解与总数余数逐项对上）；外推到语料带**中等不确定性**（源程序静态可读、逐项对账；但语料本身缺少目标形态，见 §5.5）。

### 5.1 O2a：fresh 值 ST/SET 免拷贝

**静态论据（栈序 + 发射顺序）**

1. `compileStmt Let`（`compiler.js:571`）先 `compileExpr(s.init)`，再 `compileLetPattern`；`PIdent` 分支（`compiler.js:875`）**紧接**发射 `OP.ST`，两者之间无任何指令。
2. 若 init 是字面量/构造器/闭包，其发射的**最后一条**指令是 `MAKEVEC/MAKEMAP/MAKETUPLE/MAKESTRUCT/MAKEENUM`（`compiler.js:1168/1176/1182/1201/1318+`）或 `CLOSURE/LDFN`，该指令新建对象并 push 到本帧操作数栈顶。
3. `ST` 的语义是 `deepCopy(stack.pop())`（`vm.js:731`）；弹出的正是刚 push 的私有临时值。该值除栈槽外无其它引用（MAKE*/CLOSURE 新建后未写入任何槽；操作数栈是帧私有），因此 `ST` 的深拷贝是**可证明冗余**的。`SET` 的 fresh 形态同理（`compilePlaceStore` 在 `compileExpr(value)` 后紧接 `OP.SET`，`compiler.js:964`）。**v0.97 #81 后 CLOSURE 也落入该论证**：`deepCopy(vclose)` 不再恒等，ST vclose 会二次拷贝 captures——与 Maker 的第二次整树拷贝同构。
4. 守卫：ST 不得是跳转目标（O1 pass 已有 jump-target 检查基础设施）；`PWild` 走 `POP`（无拷贝）；`PTuple` 走 `BIND`（多目标共享，不属于 O2a 的简单形态）；窄型规格 `c≠0` 时仍需 `normBindValue`，但值私有、归一不会外溢。
5. 反例边界：`let b = a`（LD 后 ST）、`let b = f()`（CALL 后 ST）、`let b = a[0]`（INDEX 后 ST）、`if/match` 表达式（分支汇合处不是 MAKE*/CLOSURE 紧邻）——这些**不能**用 O2a，必须走 O2b/O2c 或保留拷贝。

**靶点实测上界**

| 形态 | 每迭代总 entry | 可省 ST/SET | entry 占比 | real copy 占比（对象数） |
|---|---:|---:|---:|---:|
| t6 `let v=[1,2,3]` | 8 | 4 | **50%** | 1/2 = **50%**（ST 的 vec 数组） |
| t7 `v=[1,2,3]` | 8 | 4 | **50%** | 1/2 = **50%** |
| t3 `let b=Box{items:[1,2,3]}` | 13 | 5 | **38%** | 2/5 = **40%**（ST 的 struct Map + vec 数组） |
| t5 `let f=()=>a[0]`（循环内绑定，#81 后） | 10 | 5 | **50%** | 2/3 = **67%**（ST 的 vclose 头 + 捕获数组） |

说明：t6/t7 的 4 entry 中 3 个是 int 元素 no-op，只有外层 vec 是真实分配；O2a 省的是“1 个数组对象 + 4 entry”。t3 的 ST 拷贝 5 entry 对应 2 个对象（struct Map + 内层 vec 数组）；MAKEVEC 与 MAKESTRUCT 自身的拷贝仍在。**t5 是 v0.97 #81 带来的新形态**：旧版 `deepCopy(vclose)` 恒等，ST 只计 1 entry、O2a 无可省；新版 ST vclose 深拷贝 captures，5 entry / 2 个对象可省——CLOSURE 作为生产者与 MAKE* 同构（产物栈上唯一），故 ADR-010 R1.1 已将其纳入白名单。

**循环放大**：上述节省是**每迭代常数**；N 越大，绝对节省线性增长。t6/t7/t3/t5 在 N=100,000 时分别省 400,000 / 400,000 / 500,000 / 500,000 entry，以及 100,000 / 100,000 / 200,000 / 200,000 个容器对象。

**语料外推（bench_vs）**：8 个程序的**热循环内没有 fresh 容器 ST/SET**：

- fib/fib_cc/loopsum/loopsum_cc/jsonparse：无容器字面量；
- hof：`let mut v: Vec[i64] = []` 在循环外（1 次）；
- wordfreq：`vocab`/`words`/`counts` 均在循环外（约 3 次容器 ST）；
- filescan：循环内无 MAKE*；`let _w = write_file(...)` 是 CALL 结果（不是 fresh MAKE*，O2a 不覆盖）。

因此 **O2a 对 bench_vs 的动态上界 ≈ 4 次容器拷贝（启动期）**，约占 700,211 entry 的 0.01%；热路径上为 0（#79 新增的 hof 闭包实参 +3 是**闭包值**，不是容器；且那 3 次发生在 HOF 内置方法分派，不是 `let f=<闭包>` 的 ST）。examples/tools 同理是“一次性字面量”（约十几处），绝对量可忽略。**闭包绑定形态（t5）在现有语料也不在热路径**：hof/wordfreq 的 lambda 不捕获容器，closures 示例只有 1 次带捕获绑定（+5 中 1 次）。**结论**：O2a 的正确性证明是局部且强的（现在多一个 t5 形态），但现存语料无法验证其收益；要证明 O2a 有价值，ADR 需要新增“循环内 fresh 容器/带捕获闭包”基准（本调研的 t6/t7/t3/t5 即候选）。

**不确定性**：低。fresh-ST 是“发射相邻 + 栈顶私有”的局部证明，靶点数字精确；唯一风险是语料代表性——0 收益不等于规则无价值，而是现有门槛测不出，ADR 需要自带基准。

### 5.2 O2b：不可变 let 绑定共享（不是“读拷贝”）

**口径修正**：`LD`/`INDEX`/`GETFIELD` 都不拷贝（§4.3）。`let b = a` 的拷贝发生在 **ST b**，不是“读 a”。所以 O2b 只能是“**不可变绑定共享 RHS 容器**”：在证明 a、b 都不会被元素级修改、也不会逃逸到 mut/捕获面之后，`ST b` 直接存引用。

**证明需要的条件（保守版）**

- 源 `a` 与目标 `b` 都是不可变绑定（无 `mut`）；
- 容器及其子容器从未出现在 `SETINDEX/SETFIELD/SET` 目标、从未传给 mut 形参、从未被闭包捕获、从未 return/存入可逃逸容器；
- 任何一条不满足 → 保留拷贝。

**靶点实测上界**

| 形态 | 每迭代总 entry | 可省 ST | entry 占比 | real copy / 分配占比 |
|---|---:|---:|---:|---:|
| t1_imm `let a` 不可变 + `let b=a` | 5 | 4 | **80%**（400k/500k） | 循环内 **100%**（100,000/100,001 个数组；仅启动 MAKEVEC 保留） |
| t10b `let r` 不可变 + `let copy=r`（Rec 3i64+Vec8） | 14 | 13 | **93%**（1.3M/1.4M） | 循环内 **100%**（2 对象/迭代：struct Map + tag 数组） |
| t10 `let mut r` + `let copy=r; r=copy` | 27 | ≤13（`let copy` 这一半） | **≤48%**（1.3M/2.7M） | **≤50%**（200k/400k 对象） |

t10 的 0–48% 取决于分析强度：`r` 是 `mut`，但循环里只做整体 `r = copy`，没有元素写；若分析能证明“r 从不元素级修改/逃逸、copy 生命周期止于迭代内”，则可共享；保守的“mut 即放弃”会得到 **0**。ADR 应把 t10 的期望值记为 **0（保守证明）～48% entry / 50% 对象（激进证明）**，并把 t10b 作为 O2b 的明确目标形态。

**语料外推**：bench_vs **没有** `let b = a` 形式的容器别名（hof 的 HOF 链是 CALLMETHOD 接收者，不经过 ST；fold 累加器是 i64）；examples 的 `let m = midpoint(...)` 等是 CALL 结果、不是别名；tools 中 `let mut files = args`（wc）与 `let mut out = files`（diaghot）是冷路径一次性 Vec[str] 拷贝，且目标为 mut、源不再使用——更像 O2c 的“最后使用转移”，不是 O2b 的共享。**O2b 对 bench_vs 的上界 = 0。**

**不确定性**：高。收益完全取决于 alias/逃逸分析的证明强度：t10 在保守“mut 即放弃”下是 0，在能证明“r 从不元素级修改/逃逸且 copy 不逃逸”时是 ≤48% entry / 50% 对象。t1_imm/t10b 是保守分析可达的明确形态，建议作为 O2b 的验收基准。

### 5.3 O2c：实参 fresh / 最后使用免拷贝

**靶点实测**

| 形态 | 每迭代总 entry | 可省实参拷贝 | entry 占比 | real copy 占比 |
|---|---:|---:|---:|---:|
| t8 `peek([1,2,3])`（fresh 临时） | 8 | 4 | **50%** | 1/2 = **50%**（实参数组） |
| t8b `let a=[1,2,3]; peek(a)`（a 最后使用） | 12 | 4 | **33%**；与 O2a 合计 8/12 = **67%** | O2c 单独 3→2 = **33%**；叠加 O2a 后 3→1 = **67%** |
| t8c `consume(a)`（mut 形参 + callee push，a 最后使用） | 12 | 4 | **33%**（同 t8b；push 只增 alloc） | 3 个 deepCopy 对象/迭代（MAKEVEC/ST a/实参）→ O2c 省 1（33%），O2a+O2c 省 2（67%） |
| t2 `peek(a)`（只读形参，a 非最后使用） | 5 | 4 | **80%** | 循环内 100,000/100,001 个数组 ≈ **100%** |

t2 是“只读形参共享”的上界，**超出** plan 第 8 条承诺的“fresh 临时 + mut 形参最后使用”；ADR 若只实现 plan 原文，应使用 t8/t8b 的 50%/33%，把 t2 作为扩展候选。

**语料外推**：bench_vs 热循环内的调用实参是 i64/str（hof 闭包参数、fib 形参、wordfreq 的 `set(w, n)`、filescan 的路径串），**没有容器实参**；`deepCopy` 计数里的形参拷贝全部是 no-op。#79 后 hof 的 map/filter/fold 多 3 次**闭包值**实参拷贝（不是容器，也不构成 O2c 的容器收益）。**O2c 对 bench_vs 的上界 = 0（容器口径）**；#79 新增的**方法**实参拷贝是独立机会（O2c-M），见 §4.4 的 t11/t12——现有语料同样没有容器方法实参，故语料上界仍为 0。

**不确定性**：中。plan 第 8 条只承诺 fresh 临时（t8：50%）与 mut 形参最后使用（t8b：33%）；只读形参共享（t2：80% entry、循环内 100% 对象）需要跨函数的“只读/不逃逸”签名，属于扩展，ADR 不应把 t2 的数字算进基线承诺。

### 5.4 相邻但不在 O2a–O2c 的机会（供 ADR 决定是否扩围）

| 类别 | 靶点证据 | 每迭代账 | 备注 |
|---|---|---|---|
| **闭包捕获创建**（CLOSURE 计划） | t5/t5c：捕获 Vec[3] = 4 entry + 1 数组 | **t5（#81 后）10 entry 中占 40%**（旧口径 67%）；t5c 仍 80%；t5 实省 0（捕获源 `a` 非 fresh） | 计划未列；由 O2e 登记（ADR-010 §4.4.5） |
| **内建方法实参（v0.97 #79 新边界）** | t11 `push([1,2,3])`：4/7 entry；t12 `push(a)` 最后使用：4/11 | t11 省 4（**57%**）/ t12 省 4（**36%**） | 与 O2c 同构但消费方不同；CALL 掩码不覆盖——O2c-M 登记（ADR-010 §4.4.7） |
| **构造内部拷贝**（MAKEVEC 元素 / MAKESTRUCT 字段） | t3：MAKEVEC 3 + MAKESTRUCT 4 = 7/13 = 54%；对象 3/5 = 60% | 嵌套 fresh 值可继续省 | 不属于“ST/SET 入槽”；需要构造器内部的 freshness 传播 |
| **标量 ST 快路径** | t9：100k 次 `let x=i` = 100,002 entry、0 分配 | 100% entry，0 内存 | 只省函数调用/计数开销，不改分配；需另测耗时 |

### 5.5 语料级上界汇总与结论

| 规则 | bench_vs 8 程序（热路径） | bench_vs 启动期 | examples/tools | 合成靶点（每迭代） |
|---|---:|---:|---:|---:|
| O2a fresh ST/SET（含 #81 后的 CLOSURE 生产者） | **0 个容器拷贝** | ≈4 个容器拷贝 | 约十几处一次性字面量 | 38%–50% entry / 40%–67% 对象（t6/t7/t3/t5） |
| O2b 不可变绑定共享 | **0** | 0 | 冷路径 ≤2 处（且目标 mut，保守证不出） | 80%–93% entry / 100% 循环对象（t1_imm/t10b）；t10 保守 0、激进 ≤48%/50% |
| O2c fresh/最后使用实参 | **0 个容器实参** | 0 | 0 | 50%（fresh）entry/对象；33% entry、33% 对象（最后使用，O2c 单独） |
| （相邻）闭包捕获创建 | 0 | 0 | 少量 | 40%–80% entry（t5/t5c）；仅当捕获值 fresh 才可省（t5 实省 0） |
| （相邻）#79 方法实参（O2c-M） | 0 | 0 | 0 | 57%（t11 fresh）/ 36%（t12 最后使用） |
| （相邻）构造内部拷贝 | 0 | 少量 | 少量 | 54% entry / 60% 对象 |

**最重要的结论**：`deepCopy` 总数（含 O0 的 270 万）是“入口热度”，不是“容器拷贝分配量”。在 bench_vs 的 **700,211** entry 中，**O2a/O2b/O2c 可命中的容器拷贝上界约为 4 次（全部在启动期），热路径为 0**；真实容器拷贝主要集中在：

- O0 拷贝密集基准（t10，2.7M entry、400k 对象）——它是 **ST/SET 已绑定变量**，O2a 不适用，只有 O2b 的激进证明能触及 ≤50%，保守证明为 0；
- examples 的 struct/enum/闭包小对象（绝对量几十次）；
- filescan 的 `let _w = write_file(...)` Result enum（约 1,000 次/运行，但属 CALL 结果 + 未使用绑定，不在三条规则内）。

因此 ADR-010 若以“bench_vs + examples + tools + O0 拷贝密集”为验收语料，**O2a/O2c 的收益无法被测出，O2b 只有 t10 一个候选且证明强度决定 0→50%**。建议 ADR 明确：先补“循环内 fresh 容器 / 带捕获闭包绑定 / 不可变别名 / 容器实参 / 内建方法容器实参”五类基准（t6/t7/t8/t1_imm/t10b/t5/t11/t12 可直接复用），再决定实现顺序；否则 O2 可能投入后无法用现有门槛证明价值。

### 5.6 意外发现与口径修正

1. **默认 MING_STATS 会漏掉 wasm 热函数**（fib 3 vs 150,052）。任何后续拷贝工作必须用 `--no-wasm` 或同时登记两腿，否则会把 wasm 遮蔽误读为“拷贝很少”。
2. **hof/wordfreq 是 entry 密集、分配稀疏**：v0.97 落地值 300,008 与 80,075 几乎全是 i64/str 的 no-op 形参/绑定拷贝（hof 另有 3 次闭包值实参），容器拷贝为 0。审查报告 m1 前的 400,009/180,079 同样以标量 no-op 为主（+/100,004 是标量实参被逐个拷贝）。把它们当“拷贝密集主项”会高估 O2 收益。
3. **VM 闭包绑定自 #81 起不再 O(1)**：`deepCopy(vclose)` 深拷贝 captures（t5 6→10 entry/迭代）；tree 的 `deepCopy(closure)` 复制 `env.vars` 但**共享 `env.parent`**（#82 开放）——两引擎计数不可直接横比，且 tree 腿的闭包复制语义仍不完整。
4. **`let _w = write_file(...)` 这类“CALL 结果 + 未使用绑定”** 在 filescan 里产生约 1,000 个 Result enum 拷贝；它是真实分配，但既不是 fresh MAKE*，也不是别名/实参，属于 O2 三条之外的另一类候选（fresh 调用结果或死绑定消除）——plan 未覆盖。
5. **t10 与 O0 基线逐字一致**（2,700,035 / 8 / 2,000,030），证明本调研没有引入任何测量偏差。
6. **#79 新增了“内建方法实参”拷贝边界**（v0.97）：`v.push([1,2,3])` 从 3→7 entry/迭代（t11），`v.push(a)` 从 7→11（t12）；标量实参因 m1 恒等快路径不增。该边界是 O2c 在 CALLMETHOD 上的同构机会（O2c-M），**CALL 掩码不覆盖**，且 CALLMETHOD 掩码与 CALL 的向后兼容性不同（#79 之前的运行时不拷贝，不能"忽略掩码即安全"）。

---

## §6 计费核实与风险

### 6.1 `deepCopy` 是否计入 `--max-alloc`？

**不计入。** 证据有三层：

1. **源码**：`deepCopy`（`interp.js:83–150`）不调用 `chargeAllocBytes`；`chargeAllocBytes`（`interp.js:2599`）只在值创建（Vec/Map 字面量、push/extend、str 拼接等）与外部输入边界调用。`vm.js:497` 的注释明确列“派生值（deepCopy、json.parse、re.*、wasm 参数搬运）不重复计费”。
2. **计数实证**：

| 程序 | deepCopy | alloc | 说明 |
|---|---:|---:|---|
| t1（100k 次 Vec[3] 绑定） | 500,009 | **3** | 只有启动 MAKEVEC 的 3 个元素计费；100k 次 ST vec 拷贝（400k entry、100k 数组）全部不计费 |
| t10（100k 次 struct 双向拷贝） | 2,700,035 | **8** | 只有启动 MAKEVEC 8 元素计费；400k 个容器对象不计费 |
| t5（100k 次闭包捕获 vec） | 1,000,009 | **3** | 捕获数组的构造拷贝与 ST vclose 的捕获快照均不计费；#81 后计数变化不影响 alloc |

3. **配额边界实证**：

| 程序 | `--max-alloc` | 结果 |
|---|---:|---|
| t1 | 3 | exit 0（alloc=3，500,009 deepCopy 照跑） |
| t1 | 2 | exit 101 M4011（启动 MAKEVEC 一次计 3 > 2，即时触发） |
| t10 | 8 | exit 0（2,700,035 deepCopy 照跑） |
| t10 | 7 | exit 101 M4011（启动 MAKEVEC 一次计 8 > 7，即时触发） |
| t5 | 3 | exit 0（1,000,009 deepCopy 照跑） |

**结论：O2a/O2b/O2c 消除 deepCopy 不会改变 M4011 的触发点或 `alloc` 观测值。** 风险等级：**无**（配额面）。

### 6.2 其它可观测面与风险

| 面 | 影响 | 风险等级 / 处置 |
|---|---|---|
| `M4001` 步数上限 | 若用“1 换 1”指令（ST→STF / SET→SETF 或 c 操作数标志），`steps` 不变；若融合 MAKE*+ST 成一条新指令，`steps` 会少 1/次，`--max-steps` 边界移动 | **中**：ADR 应选择不改指令数的编码，或把“步数边界移动”列为 opt 可观测面并重定基线 |
| `M4012` 墙钟 | 拷贝变少 → 更快 → 触发更晚 | 低（与所有 O1 pass 同类） |
| `M4005` 深递归 | O2a 的 fresh 字面量受 parser 嵌套上限 120 约束，`deepCopy` 递归深度不会超；O2b/O2c 若对**深嵌套值**省略拷贝，可能移除原本由 `deepCopy` 递归触发的 RangeError→M4005 路径 | **低–中**：需确认 Ming 是否可构造递归类型/深层容器；ADR 可要求“仅对证明为浅层或 fresh 的值省略”，或接受该 panic 存在性变化并登记 |
| 值语义 / 输出 | 在 freshness/alias 证明成立时不可观测（无指针相等、`==` 结构比较）；证明不成立时会产生别名 bug | **高（若证明错误）**：必须“不确定即拷贝”；每条规则单测 + 四引擎差分。**闭包值另有 #82 前置**（tree `env.parent` 共享）——未闭合前 v1 排除含闭包值的形态 |
| wasm 资格 | 新 opcode/标志需在 `wasm.js:analyze()` 显式处理或具名排除；strict 三态不变 | 中：实现期约束 |
| AOT wire | 新 opcode 需尾部追加 + format 版本 + `validateArtifact` 界检查；旧产物可读；构建/工具缓存键已含 opt 开关。**版本检查须改区间**（当前 `artifact.js:261` 接受 {2,3}；直接改 4 会拒 v3） | 中：实现期约束 |
| C 后端 | C 侧拷贝走 `ming_vec_copy/ming_map_copy`，与 VM 不共享实现；O2 只做字节码，C 侧另属 O4 | 低（不混入本 ADR） |
| 确定性 | 拷贝计数确定（两次一致）；filescan alloc ±1 是既有文件系统抖动，与本优化无关 | 无 |
| 内存峰值 | 共享减少分配但延长对象生命周期；拷贝则可能让旧对象更早被 GC | 低–中：需在真实程序上观测 RSS（本调研未采集 RSS） |

---

## §7 复现命令

> 全部命令在 `C:/code/aicode` 下执行；临时目录 `.zcode/o2r/` 已被 `.gitignore` 忽略。若重跑，先确认 `git status --porcelain` 为空。

### 7.1 语料（bench_vs）

```bash
MING_STATS=1 node bin/ming.js run tests/bench_vs/progs/fib.ming
MING_STATS=1 node bin/ming.js run tests/bench_vs/progs/fib_cc.ming
MING_STATS=1 node bin/ming.js run tests/bench_vs/progs/loopsum.ming
MING_STATS=1 node bin/ming.js run tests/bench_vs/progs/loopsum_cc.ming
MING_STATS=1 node bin/ming.js run tests/bench_vs/progs/hof.ming
MING_STATS=1 node bin/ming.js run tests/bench_vs/progs/wordfreq.ming
# jsonparse 需要 10MB fixture 在 cwd（生成器见 .zcode/o2r/genjson.mjs）
(cd .zcode/o2r/json && MING_STATS=1 node ../../../bin/ming.js run ../../../tests/bench_vs/progs/jsonparse.ming)
# filescan 在空目录生成 1000 个 170B 文件
(cd .zcode/o2r/fs1 && MING_STATS=1 node ../../../bin/ming.js run ../../../tests/bench_vs/progs/filescan.ming)
```

VM-only 腿：每条命令加 `--no-wasm`。两次确定性核对：同一条命令跑两次，比较 stderr JSON 的 `instr/steps/deepCopy/alloc/concat/callMethod`。

### 7.2 examples

```bash
for f in closures results shapes traits json_demo modules; do
  MING_STATS=1 node bin/ming.js run examples/$f.ming
  MING_STATS=1 node bin/ming.js run examples/$f.ming --no-wasm
done
# geom 无 main：用 .zcode/o2r/geommod/ 下的同内容 geom.ming + geom_driver.ming
MING_STATS=1 node bin/ming.js run .zcode/o2r/geommod/geom_driver.ming --no-wasm
```

### 7.3 tools（14 个）

```bash
cd .zcode/o2r/toolcwd
for c in patch edit diff diag xnopen xnsni wc tree find json todo log rename organize; do
  MING_STATS=1 node ../../../bin/ming.js tools $c
done
```

（`patch` 路由到 `mingkit.ming`；其余命令与 `tools/*.ming` 一一对应。无参形态打印用法并退出 1，除 `tree`/`todo` 扫描空目录退出 0。）

### 7.4 靶点

靶点源文件在 `.zcode/o2r/`：`t1_vec_bind`、`t1b_vec_read`、`t1_imm_vec_bind`、`t2_vec_arg`、`t3_struct_field`、`t4_map_bind`、`t5_closure_capture`、`t5b_closure_nocap`、`t5c_closure_imm`、`t5d_closure_store_only`、`t6_fresh_st`、`t6b_fresh_nobind`、`t7_fresh_set`、`t8_fresh_arg`、`t8b_lastuse_arg`、`t8c_mut_param`、`t9_scalar_st`、`t10_copy_dense`、`t10b_imm_struct_bind`；**v0.97 补充**：`t11_method_fresh_arg`、`t12_method_bound_arg`（与前者同目录，均为本次刷新新增、gitignored）。

```bash
for f in .zcode/o2r/t*.ming; do
  MING_STATS=1 node bin/ming.js run "$f" --no-wasm >/dev/null
done
```

### 7.5 配额边界实验

```bash
MING_STATS=1 node bin/ming.js run .zcode/o2r/t1_vec_bind.ming --no-wasm --max-alloc 3   # exit 0
MING_STATS=1 node bin/ming.js run .zcode/o2r/t1_vec_bind.ming --no-wasm --max-alloc 2   # M4011
MING_STATS=1 node bin/ming.js run .zcode/o2r/t10_copy_dense.ming --no-wasm --max-alloc 8 # exit 0
MING_STATS=1 node bin/ming.js run .zcode/o2r/t10_copy_dense.ming --no-wasm --max-alloc 7 # M4011
```

### 7.6 原始数据

- `.zcode/o2r/stats.tsv`：§2/§4 的 v0.96 逐作业两跑记录（63 行，含 `diff` 列标明两次不一致的字段）。
- `.zcode/o2r/collect.mjs`：采集器（只读运行 `bin/ming.js`，不修改仓库）。
- `.zcode/o2r/genjson.mjs`：10MB JSON fixture 生成器（与 `tests/bench_vs/run.mjs` 同算法）。
- `.zcode/o2r/geommod/`：`examples/geom.ming` 的同内容副本 + 驱动。
- **v0.97 复跑**：无独立归档文件；受影响作业（hof/wordfreq/t5/t5b/t5c/t5d/closures）按 §7.1–§7.4 命令在含 #79/#81 的工作树重跑，结果已回填 §2.1/§2.2/§4.1/§4.4；t11/t12 源文件在 `.zcode/o2r/`。

---

## 附：一句话给 ADR-010

> O2a/O2b/O2c 的**局部正确性**可证（fresh ST 紧邻 MAKE*；读不拷贝；实参/别名需 alias 证明）；**v0.97 #81 后闭包绑定也进入 O2a 的收益面**（ST vclose 深拷贝 captures，t5 10→5 entry/迭代），**#79 新增了内建方法实参拷贝边界**（t11 7 entry/迭代、前值推算 3；O2c-M 候选）。但**现有语料几乎不包含可命中的热路径**——bench_vs 700,211 entry 中可消除的容器拷贝约 4 次（启动期），O0 的 270 万 entry 主要是标量 no-op + 一个 O2a 不适用的 mut 绑定回写模式。建议 ADR 先补 t6/t7/t8/t1_imm/t10b/t5/t11/t12 形态的基准再排期，并把 `--max-alloc` 无影响（已实证）、AOT 版本检查区间、#82 闭包 env 链前置与 `--max-steps`/深递归 panic 的口径写入风险表。
