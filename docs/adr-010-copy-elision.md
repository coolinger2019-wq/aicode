# ADR-010:O2 拷贝消除设计——fresh 值免拷贝 / 不可变读取 / 实参临时

> **状态**:**设计提案(未实施)**——维护者 v0.97 裁决:**O2 降级为"待真实容器拷贝 workload 再启动"**(GUIDE v0.97.0 记录,2026-11-20),本 ADR 不排期、不预支实现。 · **日期**:2026-11-20(v0.97.0 工作树刷新;#79/#81 落地后复跑关键计数) · **版本基线**:v0.97.0 工作树(HEAD `3d8a0b8` + #79/#81 修复;1603 项回归全绿;O1 四 pass 已交付;opt_gate 374 断言)
> **立场声明**:本 ADR 是**纯设计文档**——本 ADR 自身零 codegen/运行时改动,不碰 src/、tests/、其他 docs。文中引用的 **#79/#81 是 v0.97 独立 P1 缺陷修复(不是 O2 实现)**,其对拷贝边界与计数的影响已回填本文。O2a/b/c 给出可证条件与评估门槛;O2d 仅登记。**Agent B 的调研数据已就绪**(`docs/copy-elision-research.md`,2026-11-20 采集 + v0.97 复跑;原始逐作业数据 `.zcode/o2r/stats.tsv`,gitignored),本文 §1.2.1 已按 B 表回填;设计期自采探针(§1.3)仅作交叉核对。**B 的关键结论**:现有 bench_vs/examples/tools 语料的热路径中 O2a/O2b/O2c 可命中的容器拷贝上界≈4 次(启动期),因此**新增 O2 专用基准是立项的前置条件**(§7/§9 决策 11)。
> **结论先行**:① **O2a(fresh 值 ST/SET 免拷贝)原建议立即实施**(v0.97 裁决后未排期)——证明只需"新分配 + 单引用 + 单消费"三件套,把字面量绑定的"第二次整树拷贝"降为一次分配;v0.97 #81 后**闭包绑定(`let f = <带捕获闭包>`)也落入本规则**(ST vclose 不再是恒等,§4.1.2 R1.1);② **O2c(实参临时免拷贝)可独立评估**——安全性只依赖**调用方侧**单引用;不需要被调方逃逸摘要(与常见直觉相反,§4.3.3 给论证),但必须与 VM 参数拷贝点协同(§4.3.4);**v0.97 #79 新增的 CALLMETHOD 内建实参拷贝是独立同构机会 O2c-M(§4.4.7),不在 CALL 掩码 v1 范围**;③ **O2b(不可变 let 读取免拷贝)暂缓**——它依赖槽级别名/逃逸分析;原 VM 在 CALLMETHOD 实参位违反"集合元素存入=深拷贝"的分歧已由 **v0.97 #79 修复**(§2.4),剩余前置是**闭包/env 链 #82(开放 P1)**与槽级 provenance 分析;④ **三条规则都不能降低 O0 的拷贝密集锚点**(2,700,035 次 / 10 万迭代)——该锚点由 mut 槽读回与重赋值主导,需要另一个规则(O2d,仅登记,§4.4.3);⑤ 编码上 O2a 新增两个字节码 opcode(`STNC`/`SETNC`)+ 产物版本 v4(版本检查改区间,§2.3);O2c 用 CALL 的空字段位掩码(**旧运行时忽略掩码即回落拷贝**,天然向后兼容——仅限 CALL;O2c-M 的 CALLMETHOD 掩码兼容门禁不同,见 §4.4.7)。
> **关联**:plan §4.16.3 第 6–8 条 / §4.16.4 风险登记;docs/opt-baseline.md(O0/O1 基线);O1 三批交付(§104/§105/§106);design.md §2.3(值语义);GUIDE §10(值语义提醒);ADR-009 §7(维护者复核位先例)。

---

## 1. 背景、问题与机会量化

### 1.1 值语义现状(执行模型,已逐点核实)

Ming 的值语义承诺(design.md §2.3):"赋值、传参、返回、闭包捕获、集合元素存入——**全部深拷贝**;程序里不存在两个名字共享同一可变结构"。当前实现把该承诺落实在下列边界:

| 边界 | 实现点(v0.97.0) | 行为 |
|------|--------|------|
| `let` 绑定(ST) | `src/vm.js:726-735` | 弹栈 → `deepCopy` → 窄型归一并写槽 |
| 重赋值(SET) | `src/vm.js:737-749` | 弹栈 → `deepCopy` → 规格归一/值标签归一 → 写槽 |
| 元组解构(BIND) | `src/vm.js:976-987` | 每个绑定值 `deepCopy` 后写槽 |
| 调用实参(VM) | `src/vm.js:653-660` | 帧建立时逐形参 `deepCopy`(mut self 的 self 除外) |
| 调用实参(tree) | `src/interp.js:948`(callUser 帧绑定)、`src/interp.js:1705/1715/1724/1728/1735`(调用点) | 调用点先拷一次 + 帧建立再拷一次 |
| **内建方法实参(VM)** | `src/vm.js:842-858`(CALLMETHOD builtin 分派) | **v0.97 #79 新增边界**:非接收者实参逐参 `deepCopy`(恒等类型 int/float/bool/str/json/handle/fnref 走 m1 快路径跳过);用户方法不重复拷(帧绑定已有);接收者永不拷(mut self) |
| 集合构造 | `src/vm.js:888-940`(MAKEVEC/MAKEMAP/MAKETUPLE/MAKESTRUCT/MAKEENUM) | 逐元素/逐字段 `deepCopy` 后装入新对象 |
| 闭包捕获 | `src/vm.js:755-760`(CLOSURE) | 捕获计划逐槽 `deepCopy`;构造 vclose |
| **闭包值复制** | `src/interp.js:141-146`(deepCopy `vclose`) | **v0.97 #81 新增边界**:captures 逐项 `deepCopy`(空捕获归一为新 vclose(新对象 + 空 captures 数组,计 1 entry));`let f2 = f`/HOF 传参不再共享捕获数组 |
| 容器访问器 | `src/interp.js:3694/3699/3700/3803/3818/3819/3918/3921/3930/3936` | get/first/last/values/items/unwrap/unwrap_or 返回副本 |
| tree `let`/赋值 | `src/interp.js:1130-1144`(Let)、`src/interp.js:1338`(`bindPattern`)、`src/interp.js:1268-1269`(`assignTo`) | 同口径深拷贝 |

`deepCopy` 本体(`src/interp.js:83-150`):`int/float/bool/str/unit/range/json/handle/fnref` 恒等返回;`vec/map/tuple/struct/enum/closure/vclose` 深拷贝(闭包 env 逐变量拷贝;**vclose captures 自 #81 起逐项深拷贝**);`slice` 复制视图引用(ADR-009 §2.2)。

> **已知缺口(#82,开放 P1)**:tree 的 `deepCopy(closure)` 复制 `env.vars` 但 **`env.parent` 仍共享**(`src/interp.js:125-137`)——递归 `snapshotEnv` 实现呈 2^n 复制(22 层嵌套块 4GB OOM exit 134;1M 次 let 复制 tree +55%),已回退。因此"闭包复制 = 完整快照"在 tree 腿**尚不成立**;VM vclose 侧已由 #81 修复。该缺口对 O2a/O2c 的前提影响见 §2.2 末尾。

### 1.2 O0 观测数据(来自 docs/opt-baseline.md,v0.92 采集)

| 程序 | 腿 | instr | steps | deepCopy | alloc |
|---|---|---|---|---|---|
| 拷贝密集 10 万绑定 | vm-only | 46 | 2,000,030 | **2,700,035** | 8 |
| 拷贝密集 10 万绑定 | tree | N/A | 1,600,023 | 2,800,037 | N/A |
| Map 更新 2 万混合 | vm-only | 57 | 500,922 | 80,005 | 310 |
| HOF 链 10 万元素 | vm-only | 59 | 2,540,029 | 320,003 | 310,000 |
| 闭包调用 10 万次 | vm-only | 32 | 1,600,020 | 200,005 | 0 |
| 字符串构造 1 万次 | vm-only | 36 | 100,030 | 10,010 | 100,010,025 |

> 注:本节 O0 行采集于 v0.92(`docs/opt-baseline.md`),未随 v0.97 #79/#81 重采;"闭包调用"行若含循环内闭包绑定,其计数会因 #81 变化——本次刷新未确认该基准源,引用时以 §1.2.1 的 t5 与 bench_vs 复跑数据为准。

**拷贝密集锚点的逐点分解(B 数据,`docs/copy-elision-research.md` §4.1 t10,与本节 O0 行逐字对上:2,700,035 entry / 8 alloc / 2,000,030 steps)**:每次迭代 = `ST struct 13`(`let copy = r`)+ `SET struct 13`(`r = copy`)+ `SET acc 1` = 27。**两次 13 的源都是已绑定变量(LD 前驱),不是 Maker**——这是 O2a 不命中的直接原因。

### 1.2.1 Agent B 语料级分解(回填;`docs/copy-elision-research.md` §2–§5)

| 语料 | 作业数 | v0.96 基线(HEAD `3d8a0b8`) | v0.97 工作树(#79/#81) | 主要构成(B 逐项归属 + v0.97 变化) |
|---|---:|---:|---:|---|
| `tests/bench_vs/progs` 8 程序 | 8 | **700,208** | **700,211** | hof 300,005→**300,008**(300,005 为 i64 闭包形参 no-op;+3 = map/filter/fold 的闭包值实参各一次深拷贝——#79)/ fib 150,052(i64 形参 no-op)/ fib_cc 150,049 / wordfreq 80,075(str+i64 no-op;m1 恒等快路径使 #79 不增计数)/ filescan 20,006(约 1,000 次 Result enum ST 为真实分配)/ 其余容器拷贝≈0 |
| examples 7(含 geom 驱动) | 7 | 371 | **376** | struct/enum/闭包小对象,一次性启动量级(31–110/程序);closures 105→110(+5 = 4 个 HOF 闭包实参 + 1 次带捕获闭包 ST,#79/#81) |
| tools 14(无参/help) | 14 | 66 | 66 | help 路径基本不触容器 |
| **合计** | **29** | **700,645** | **700,653** | — |

> **数据口径(重要,对应 v0.97 审查 M1)**:上表 v0.97 列采集于 `MING_STATS=1 ... --no-wasm`,工作树含 #79/#81,2026-11-20。**审查报告另有一组 m1 前口径**:hof 400,009 / wordfreq 180,079 / bench_vs 总量 900,216——彼时 `v.push(i)`、`map.set(w,n)`、`get(w)`、`unwrap_or(0)` 的**标量实参也逐个计 deepCopy**(+100,004/程序)。落地实现保留了 m1 恒等类型快路径(int/float/bool/str/json/handle/fnref 不进 `deepCopy`),故标量实参不增计数;但 **#79 新增的实参拷贝边界对容器/闭包实参仍然真实存在**(hof 的 +3 即闭包实参;容器实参见合成靶点 t11/t12,§4.3.4)。引用数据时必须带口径标签,不得把 400,009 当作当前实现值,也不得用 300,008 否认该边界存在。

**B 的靶点差分(每迭代,`--no-wasm`,N=100,000;t 编号沿用 B 文)**:

| 靶点 | 形态 | deepCopy/迭代 | 构成 | 命中规则 |
|---|---|---:|---|---|
| t6 | `let v=[1,2,3]`(循环内) | 8 | MAKEVEC 3 + **ST 4** + SET acc 1 | O2a 可省 4(50% entry;1 个数组) |
| t7 | `v=[1,2,3]`(循环内,重赋值) | 8 | MAKEVEC 3 + **SET 4** + acc 1 | O2a 可省 4 |
| t3 | `let b=Box{items:[1,2,3]}` | 13 | MAKEVEC 3 + MAKESTRUCT 4 + **ST 5** + acc 1 | O2a 可省 5(38%;2 个对象) |
| t8 | `peek([1,2,3])`(fresh 实参) | 8 | MAKEVEC 3 + **形参 4** + acc 1 | O2c 可省 4(50%) |
| t8b | `let a=[…]; peek(a)`(最后使用) | 12 | MAKEVEC 3 + ST 4 + **形参 4** + acc 1 | O2a+O2c 合计可省 8(67%) |
| t1 / t1_imm | `let b=a`(a 为 Vec[3];t1 = mut 源,t1_imm = 不可变源) | 5 / 5 | **ST 4** + acc 1 | t1_imm:O2b 可省 4(80% entry;循环内 100% 数组);t1(mut 源)按保守规则 **0**(放弃清单 #3) |
| t10b | `let r` 不可变 + `let copy=r`(Rec+Vec[8]) | 14 | **ST 13** + acc 1 | O2b 可省 13(93%;2 对象/迭代) |
| t10 | `let mut r; let copy=r; r=copy`(O0 原形) | 27 | ST 13 + SET 13 + acc 1 | O2a/b/c **0**(保守证明);O2d 才能触及第一个 13 |
| t5 | `let f = () => a[0]`(循环内创建+绑定) | 6→**10**(#81) | CLOSURE 捕获 vec 4 + **ST vclose 5**(vclose 头 1 + captures vec 4)+ SET 1 | O2a 可省 5(50%,R1.1 纳入 CLOSURE);O2e 可省 4(40%,仅当捕获值 fresh——t5 的 `a` 是已绑定变量,故 t5 实省 0) |

**B 的三条口径修正(已并入本文)**:
1. **`LD`/`INDEX` 读不拷贝**(VM `src/vm.js:721-725/808-816`;tree `src/interp.js:1476`),所以 **O2b 的语义不是"读拷贝消除",而是"绑定处共享 RHS 容器"**(`let b=a` 的拷贝在 ST b,不在读 a)——本文 §4.2.1 已按此措辞。
2. **`deepCopy` entry ≠ 真实容器分配**:int/str/json/空捕获 vclose 恒等但每次计 1;**#81 后带捕获 vclose 不再恒等**(captures 逐项拷贝,§1.2.1);bench_vs 的 700,211 entry 中大量是 no-op(hof/fib/wordfreq 的 i64/str 形参)。任何收益评估必须同时报 entry 与对象数。
3. **默认腿(VM+wasm)会漏计 wasm 热函数**(fib 3 vs `--no-wasm` 150,052)。**O2 的所有 deepCopy 断言必须在 `--no-wasm` 腿采集**;三腿 stdout 仍逐字比对。

**B 的语料结论**:bench_vs 热循环内**没有** fresh 容器 ST/SET、没有容器实参、没有 `let b=a` 形式别名;O2a/O2c 对 bench_vs 的动态上界≈4 次启动期容器拷贝(容器口径未变——#79 新增的是**闭包/标量实参**拷贝,不改变容器计数),O2b 仅 t10b 一个目标形态。**因此 O2 的验收不能复用现有 bench_vs 语料**,必须新增 t6/t7/t8/t1_imm/t10b/t5 形态基准(§7 前置)。

### 1.3 设计期探针(自采,与 B 数据交叉核对;非独立交付)

采集方式:`MING_STATS=1 node bin/ming.js run <prog> --no-wasm`(每程序两次一致;O1 优化开/关同值——这些形态不在 O1 的靶点上)。所有程序 deterministic、无 IO(除最终 print)。本节与 B 的 t6/t3/t8/t1/t10 在**同一构成算术**上逐项吻合(例:本节字面量循环 = MAKEVEC 8 + MAKESTRUCT 12 + ST 13 + SET 1;B 的 t6 = MAKEVEC 3 + ST 4 + SET 1 是同一族更浅的形态),保留作锚程序设计依据;权威数据以 B 文与 §1.2.1 为准。

| 探针程序 | instr | steps | deepCopy | 识别出的拷贝点(每迭代) | 命中规则与预估 |
|---|---|---|---|---|---|
| `let v = [1,2,3];`(单次) | 13 | 13 | 7 | MAKEVEC 3 + ST 4 | O2a 后 3(拷 ST 的 vec 头+3 元素) |
| `let r = R{a:7,v:[4,5]};`(单次) | 14 | 14 | 11 | MAKEVEC 2 + MAKESTRUCT 4 + ST 5 | O2a 后 6 |
| `let m={"k":[1,2]}; let e=Some([9]);` | 24 | 24 | 15 | Map:2+3+4;Enum:1+2+3 | O2a 后 8 |
| 字面量循环 10 万次(`let r=Rec{...}` 在循环体内) | 42 | 3,000,016 | **3,400,002**(34/迭代) | MAKEVEC 8 + MAKESTRUCT 12 + **ST 13** = 33 + SET acc 1(标量 no-op) | O2a:−13/迭代(−38.2% 计数) |
| 实参临时循环 10 万次(`f(Rec{...})`) | 44 | 3,200,016 | **3,400,002**(34/迭代) | 构造 20 + **被调方形参 13** = 33 + SET acc 1(标量 no-op) | O2c:−13/迭代(−38.2% 计数) |
| 不可变快照循环 10 万次(`let b=src; b[7]`) | 36 | 1,400,026 | **1,000,019**(10/迭代) | **ST 9**(vec 1 + 8 元素)+ SET acc 1(标量 no-op) | O2b:−9/迭代(−90% 计数) |
| O0 拷贝密集(重跑复核) | 46 | 2,000,030 | **2,700,035**(27/迭代) | `let copy=r` ST 13 + `r=copy` SET 13 + SET acc 1(B 的 t10 同解) | **无规则命中**(见 §1.4) |

字节码形态(同批 `MING_TRACE=1` 实测;`op` 编号见 `src/compiler.js:28-69`):

```
let v = [1, 2, 3];             → CONST x3 ; MAKEVEC 3 ; ST 0 v
let r = R { a: 7, v: [4, 5] }; → CONST 7 ; CONST 4 ; CONST 5 ; MAKEVEC 2 ; MAKESTRUCT ; ST 0 r
let m = { "k": [1, 2] };       → CONST "k" ; CONST 1 ; CONST 2 ; MAKEVEC 2 ; MAKEMAP 1 ; ST 0 m
let e = Some([9]);             → CONST 9 ; MAKEVEC 1 ; MAKEENUM ; ST 0 e
let n = take(R{...}, [3,4]);   → LDFN take ; <R 构造> ; MAKEVEC 2 ; CALL 2
let copy = r;                  → LD 0 r ; ST 0 copy
r = copy;                      → LD 0 copy ; SET 0 r
let z = if c { [1] } else { [2] };  (--no-opt/不可裁剪 c) → … MAKEVEC ; JUMP ; ST   ← ST 是合流跳转目标
```

### 1.4 机会矩阵(诚实结论先行)

| 规则 | 拷贝密集 O0 锚点 | 字面量循环 | 实参临时 | 不可变快照 | 主要受益面 |
|---|---|---|---|---|---|
| O2a fresh ST/SET | **≈0**(仅程序开头一次构造 −13) | **−13/迭代** | 不适用 | 一次性 −9(`let src=[…]` 那一次构造;循环内无 Maker) | 字面量/构造器密集 |
| O2a + CLOSURE/LDFN 生产者(#81 后新增) | 0 | 不适用 | 不适用 | 不适用 | **闭包绑定循环 t5:−5/迭代(50%)**;空捕获 LDFN 仅 −1 entry/0 对象 |
| O2b 不可变读取 | **0**(源是 `let mut r`) | 不适用 | 不适用 | **−9/迭代** | 只读快照/配置读取 |
| O2c 实参临时 | 0(循环内无调用) | 不适用 | **−13/迭代** | 0 | 构造后立即传参 |
| O2d(仅登记,§4.4.3) | **−13/迭代**(27→14) | — | — | — | mut 槽读回/重赋值 |

**结论**:O2a 是"机制型"收益(把构造路径的第二次整树拷贝消掉,受益面广但单点小);**v0.97 #81 后闭包绑定也纳入该机制**(ST vclose 有真实拷贝成本,t5 占 50%)。O0 的拷贝密集锚点由 **mut 槽读回 + 重赋值** 主导(`let copy = r; r = copy;`),O2a/O2b/O2c 按定义都不可命中——这是本 ADR 最重要的量化事实,**防止"O2 落地后 O0 数字不动"被误读为失败**。若目标是移动 O0 数字,需要 O2d(读后即覆盖的移动语义),它不在本 ADR 实施范围。

---

## 2. 执行模型事实清单(设计前置核实)

### 2.1 拷贝边界与值语义合同

见 §1.1 表。要点:**VM 的每次槽写入(ST/SET/BIND)、帧建立(形参)与内建方法实参(v0.97 #79)都拷贝**;`deepCopy` 对不可变标量是恒等,对容器是整树新建。因此“槽持有私有对象”是当前引擎的不变式(每个槽一个所有者),O2 的规则本质是在**不破坏该不变式**的前提下省掉“已经私有、且马上要成为唯一持有者”的那一次拷贝。

### 2.2 身份不可观察性审计(三件套之 (c))

| 通道 | 结论 | 证据 |
|---|---|---|
| `==` / `!=` | **结构相等,不看身份** | `src/interp.js:363-412` `valueEquals`:vec/tuple 逐元素、map 逐键值、struct 逐字段、enum 逐载荷;struct/enum 的同类型判定已在 #73(v0.90)改为 name+字段集,不含对象身份 |
| `debug` / `display` / 插值 | 结构化文本 | `src/interp.js:152-199`;无地址/无 `<object>` 输出 |
| Map 键 | **不允许容器键**(无身份键面) | checker **M3044**:`src/checker.js:6413`——"结构/Vec 键没有值语义相等" |
| Slice 相等 | 静态拒绝 | `src/checker.js:330`(Slice 无值相等面,ADR-009 S2 审查 MINOR-1) |
| 弱引用/终结器/GC 观测 | 语言内不存在 | 无 `WeakRef`/finalizer 暴露面;tree/VM 无地址 API |
| **闭包捕获状态(VM vclose)** | **v0.97 #81 修复**:`deepCopy(vclose)` 深拷贝 captures;两个闭包值的捕获变量互写不可见 | `src/interp.js:141-146`;§108 8 check;t5/t5d 计数(§1.2.1) |
| **闭包环境链(tree closure)** | **#82 开放 P1**:`deepCopy(closure)` 复制 `env.vars` 但**共享 `env.parent`**——外层块变量的写可经 parent 链穿透到复制体 | `src/interp.js:125-137`;递归 `snapshotEnv` 实现 2^n 复制(22 层嵌套 4GB OOM)、已回退;待 free-variable 捕获计划/持久化 env |
| `std.mem`/Ptr | 仅 C 原生后端(VM/tree M4016),且不属于本管线 | `src/interp.js:2175-2178/3636`;ADR-006 |

**核实结论:`valueEquals` 对容器不做身份比较(关键前提成立)。** 因此"同一内容、不同对象"与"同一对象"在所有语言可观察面上不可区分——**除非存在第二条可变引用**,这正是三件套 (a)(b) 要排除的。

**闭包/env 链是本审计的补充通道,也是 O2 的显式前提**:闭包值不是普通容器,但复制闭包 = 复制其捕获状态,同样可能制造第二条可变引用。
- VM `vclose`:#81 已修(捕获快照完整)——`let f2 = f`/HOF 传参不再共享 captures。
- tree `closure`:**#82 仍开放**——`env.parent` 共享,闭包复制体与原件在外层块变量上仍是同一根。这是 `let f2 = f` 在 tree 腿的值语义缺口,不是 O2 引入的,但 O2 的证明不能假设它不存在。
- **对 O2 的推论**:O2a 的 `F` 分类(Maker/CLOSURE 产物)与 O2c 的 fresh 实参证明都建立在"收到的值已是完整私有副本"之上。VM 腿由 #81 保证;tree 腿 #82 未闭合前,**v1 规则必须把"值可能含闭包(含嵌套容器内闭包)"的形态排除**,否则三腿逐字验收没有共同语义基础(§8)。#82 修复后该排除可解除。

### 2.3 计费与观测面(用户要求核实的关键前提)

| 面 | 结论 | 证据 |
|---|---|---|
| `--max-alloc` | **`deepCopy` 不计费**;计费点 = 值创建(MAKEVEC/MAKEMAP 按元素、str 拼接/repeat/join 按字符、外部输入边界) | `src/interp.js:2599` 注释与实现;`src/vm.js:497` "派生值(deepCopy、json.parse、re.*、wasm 参数搬运)不重复计费" |
| 推论 | **消除 deepCopy 不改变任何腿的 `--max-alloc` 观测** | MAKEVEC/MAKEMAP 的 `chargeAllocBytes(n)` 仍在(`src/vm.js:891/901`);ST 拷贝本就不计费。**B 已做配额边界实证**:t1 `--max-alloc 3` exit 0 / `2` → M4011(启动 MAKEVEC 第 3 元素);t10 `--max-alloc 8` exit 0 / `7` → M4011——2,700,035 次 deepCopy 照跑不影响触发点(`docs/copy-elision-research.md` §6.1) |
| `MING_STATS` | `deepCopy` 相对**同版本基线**会**下降**(观测量,同 O1 的 instr/steps 先例);跨版本比较无意义(v0.97 #81 已抬高闭包绑定基线) | `bin/ming.js:218-240`;计数口径 = `deepCopy` 入口调用次数(**含标量恒等调用与容器递归内层**) |
| `instr` / `steps` | **不变**——O2a/O2c 是同长度指令替换/置位,不增删指令、不改执行路径 | O2a 的 ST→STNC 为 1:1;O2c 只改 CALL 的 c 字段 |
| `alloc` / `concat` / `callMethod` | **不变** | 三者与 deepCopy 无耦合 |
| panic | 消息/位置/退出码不变——STNC 仍执行窄型归一,`spanOf` 仍取 `ins[4]` | `src/vm.js:732/746` |
| AOT wire | O2a 新 opcode → `ARTIFACT_VERSION` 3→4;**版本检查必须同步改为区间**(见下"v4 兼容口径");O2c 的掩码在空字段,旧运行时忽略即拷贝 | `src/artifact.js:18/261` |
| **v4 兼容口径(审查 M2)** | 现检查为 `a.version !== 2 && a.version !== ARTIFACT_VERSION`(`src/artifact.js:261`)——**当前实际接受集 {2,3}**。若只把常量改 4,接受集变 **{2,4}**,v3 被拒,与"v2/v3 仍可读"矛盾。O2a 实现必须把该行改为区间检查:版本 `< 2` 或 `> ARTIFACT_VERSION` 即拒绝(接受集 {2,3,4}),并补 v3 产物 fixture | 实现前置;§6.5 |

### 2.4 CALLMETHOD 实参拷贝边界:v0.97 #79(原 #77 候选)已修复 + 新增机会

**状态**:v0.97 已作为**独立 P1 缺陷**修复(不是 O2 实现,不改变本 ADR 的"未实施"定位)。

**原缺陷(v0.96 及以前,优化开/关同结果)**:

```ming
fn main() with io {
    let mut w: Vec[i64] = [1];
    let mut v: Vec[Vec[i64]] = [];
    v.push(w);            // 规范:存入的是 w 的副本(design.md §2.3 "集合元素存入…全部深拷贝")
    w.push(2);
    print(str(v[0].len()));   // 修复前 VM: 2   tree: 1;修复后三腿: 1
}
```

- VM(修复前):`CALLMETHOD` 把操作数栈上的实参**原样**交给内建方法(旧 `src/vm.js:825-845`),`vecMethodImpl.push` 直接 `a.push(args[0])`,于是 `v[0]` 与 `w` 共享同一 vec 对象 → 就地变异互相可见。
- tree:`evalCall` 在方法分派前对实参 `deepCopy`(`src/interp.js:1735`),`push` 收到副本 → 隔离。
- 同族面:`insert`(`src/interp.js:3766-3772`)、`extend`(`3778-3782`)、`map.set`(`3807-3813`)。

**修复(v0.97 #79;`src/vm.js:842-858`)**:
- CALLMETHOD builtin 分派前,对非接收者实参逐参 `deepCopy`;`methodArgsNeedCopy` 区分内建实现(拷)与 struct/enum 用户方法(不重复拷——帧绑定已有,避免双拷);接收者永不拷(mut self 原地修改语义)。
- **m1 恒等类型快路径**:`int/float/bool/str/json/handle/fnref` 跳过 `deepCopy`(`deepCopy` 对这些本就原样返回;`push` 热路径约 20% 开销)。
- 验证:§107 9 check;21 探针 × 四腿(默认/`--no-wasm`/`--no-opt`/`--tree`);配额矩阵不变(`deepCopy` 不计费)。

**对 O2 的三个影响**:
1. **O2b 前提恢复**:VM 与 tree 在"存入容器 = 拷贝"上一致(§4.2.5 的原"规范前提被破坏"解除)。
2. **新增拷贝边界 = 新机会**:`v.push(<fresh 容器>)`、`m.set(k, <fresh 值>)` 现在各多一次实参 `deepCopy`——这是 O2 可消除的实参临时的新形态 **O2c-M**(§4.3.4 / §4.4.7);CALL 掩码不覆盖 CALLMETHOD。
3. **观测口径分裂**:`MING_STATS` 下容器/闭包实参计数上升(§1.2.1:hof +3、t11 +4/迭代);标量实参因 m1 快路径不增——审查报告的 400,009/180,079 是 m1 前口径,落地值为 300,008/80,075。引用计数必须标口径。

**剩余前提(未闭合)**:闭包值的绑定/传参复制仍受 **#82**(tree closure 的 `env.parent` 共享)约束——#79 只关闭了"方法实参存入容器"这一条通道;见 §2.2 与 §8。

---

## 3. 新鲜度格(freshness lattice)设计

### 3.1 域、序与合并

抽象状态 `A = ⊥ | F | B(P) | S`,其中 `P ⊆ Prov` 是有限所有权来源集(`Prov = {loc:<slot>, cap:<idx>, pool, iter, unknown}`)。

- `⊥`:该栈位/路径不存在(不可达)。
- `F`(fresh):**唯一引用就在操作数栈上的单消费临时**——当前路径新分配,栈外无任何引用(无槽/容器/池/闭包/迭代器引用)。
- `B(P)`(borrowed):值被 `P` 中的根持有;栈上只是借用。`P` 是有限上近似(槽号/捕获下标/池/迭代器)。
- `S`(shared):**多根或来源不可分析**(调用结果、CALLMETHOD 结果、捕获快照、池容器、DUP 之后的双方……)。永不消除。

序:`⊥ ⊑ F ⊑ B(P) ⊑ B(Q)(P ⊆ Q) ⊑ S`。合并(路径合流)取最小上界:

```
⊥ ⊔ x = x          F ⊔ F = F
F ⊔ B(P) = B(P)    B(P) ⊔ B(Q) = B(P ∪ Q)    x ⊔ S = S
```

**保守原则**:任何不确定 → 升到 `S`。`F ⊔ F = F` 是健全的:两条路径各自新分配、各自单引用,合流后活下来的是其中一条路径的对象,仍单引用(未走的分支从未分配)。

### 3.2 每条字节码产出的初始状态(transfer 表)

| 产出指令 | 状态 | 理由 |
|---|---|---|
| `CONST` 池项为 `int/float/bool/str/unit/range/json/handle` | `F` | `deepCopy` 恒等;无拷贝收益,但也无风险 |
| `CONST` 池项为 `vec/map/tuple/struct/enum/closure` | `S(pool)` | **池容器是跨执行复用的可变对象**(见下"池常量实证"),绝不能当 fresh |
| `LD` local/capture | `B({loc:s})` / `B({cap:i})` | 槽持有,栈上借用 |
| `ST` / `SET` / `BIND` | 无栈产出 | 写入即拷贝(现状);O2a/O2b 只改 ST/SET 的**拷贝动作**,不改栈效果;**#81 后若值是 vclose,写入拷贝包含 captures 快照** |
| `BIN` / `UN` / `CONCAT` / `RANGE` / `CAST` | `F` | 结果类型只可能是标量/str/range/数值(`castValue` 仅数值,`src/interp.js:castValue`),`deepCopy` 恒等 |
| `MAKEVEC` / `MAKEMAP` / `MAKETUPLE` / `MAKESTRUCT` / `MAKEENUM` | **`F`** | 新分配;操作数已被逐元素 `deepCopy`,结果不别名任何外部可达对象 |
| `CLOSURE` / `LDFN` | `F` | 新 `vclose` 对象;CLOSURE 按计划深拷贝捕获,产物栈上唯一。**v0.97 #81 起 `deepCopy(vclose)` 非恒等**(captures 逐项深拷贝),因此 `[CLOSURE][ST]` 的第二次拷贝是**真实成本**——O2a 可覆盖(R1.1);LDFN 空捕获的 deepCopy 复用原对象(计 1 entry、零分配) |
| `DUP` | 源 `F` → 两个 `S`;源 `B(P)`/`S` 不变 | 出现第二条栈引用,单所有权失效 |
| `SWAP` | 两个栈位状态互换 | 栈重排 |
| `GETFIELD` / `INDEX` | 基 `F` → `F`;基 `B(P)` → `B(P ∪ {path})`;基 `S` → `S` | 投影不复制;基被弹出后,`F` 的子对象是"父死子存"的唯一引用 |
| `PATMATCH` | `S`(内部 binds 数组,元素借用自宗量) | 宗量仍在栈上;元素不可当 fresh |
| `ITERNEW` / `ITERNEXT` | `S` / `B({iter})` | 迭代器持有集合;元素借用 |
| `CALL` / `CALLMETHOD` / ctor 分发结果 | `S` | 无跨函数摘要;保守 unknown |
| `RET` / `QMARK` / `PANICX` / `ASM` | — | 离开本帧/终止 |
| 跳转(进入/离开基本块) | 合流按 §3.1 join | 见 §3.3 |

**#79/#81 的 transfer 影响**:CALLMETHOD 的内建实参深拷贝发生在指令内部(不改变操作数栈状态),但它把"实参位上的 fresh 值"从 `F` 消费为被调方容器内的私有副本——**O2c 的 CALL 掩码不覆盖该点**(§4.4.7)。ST/SET 对 CLOSURE 产物(仍为 `F`)的第二次整树拷贝自 #81 起非恒等,O2a 按 R1.1 纳入 CLOSURE/LDFN 生产者。

**措辞对齐**:任务口径的 "CONST = immutable-shared" 在本格中分两类落位——CONST 标量/str/unit/range/json/handle 是**不可变共享**(`deepCopy` 恒等,记 `F` 只为格内一致性;它们本就不产生拷贝);CONST **容器**是**可变共享**(编译期池对象,跨执行复用,记 `S(pool)`,永不消除)。

**池常量实证**(为什么 CONST 容器必须是 `S` 而不是 `F`):

```ming
const C: Vec[i64] = [1, 2, 3];
fn main() with io {
    let mut v = C;     // ST 深拷贝;若误把 CONST 当 fresh 并消拷贝,v 将直接持有池对象
    v.push(9);
    print(str(C.len()));   // 正确:3(现值);错消除:4(池污染,跨执行可见)
}
```

`const` 初始化器在编译期由树引擎求值并**以可变容器对象入池**(`src/compiler.js:175-185`),同一次运行内多处读取共享该对象——这与 O1c 拒绝容器常量传播是同一裁决理由(`src/opt.js:18` 注释 + `619` `constCellOf` 标量白名单)。

### 3.3 基本块与合流

- **leader**:地址 0、所有跳转目标、所有跳转/终结指令的后继。
- 每个基本块内正向传播栈状态数组(高度 + 每位的 `A`)+ 槽表(§3.4);块间在 leader 处按 §3.1 join。
- **高度不一致 → 整个函数放弃**(理论上是编译器 bug;按"不确定即拷贝"处理,与 O1c `nParams` 缺失整体放弃同一纪律,`src/opt.js:560-562`)。
- 任何跨块传播的状态只要来源含"不可分析",即 `S`。
- **O2a 只用局部信息**(前一条指令),不依赖块传播;O2c 依赖块内切片(实参求值区间);O2b 依赖全函数 provenance 正扫描(块内切片是其构件,另需写入/逃逸封闭);全量格是 O2a′/O2c 精化(跨合流 fresh)的基础。

**worked example(嵌套字面量)**:`let r = R { a: 7, v: [[1], [2]] };` 在单块内的操作数栈状态(自左向右为栈底→栈顶,只列 `A`):

```
CONST 7        → [F]
CONST 1        → [F, F]
MAKEVEC 1      → [F, F]            // 弹 1 个 F,压 1 个 F(新 vec)
CONST 2        → [F, F, F]
MAKEVEC 1      → [F, F, F]
MAKEVEC 2      → [F, F]            // 弹两个内层 vec(各 F),压外层 vec F
MAKESTRUCT 2   → [F]                // 弹 int + vec,压 struct F
ST 0 r         → []                 // O2a:改为 STNC;r 槽 owned
```

对照:`let b = a;` 为 `[LD 0 a] → [B({loc:a})] → ST 0 b`——ST 的源是 `B`,O2a 不适用;若走 O2b,需先证明 `a` 无第二引用、无就地变异/逃逸(§3.4),再把 ST 改为 STNC 并把 b 登记为 `borrowedFrom(a)`。

### 3.4 槽所有权/逃逸表(供 O2b)

`slot → owned | borrowedFrom(s) | mutated | escaped | unknown`:

| 事件 | 转移 |
|---|---|
| 形参建立 / ST/SET/BIND 写入(拷贝版) | `owned`(帧私有副本) |
| O2a 的 STNC/SETNC 写入 | `owned`(Maker 新对象,仍独占——O2a 不引入第二根) |
| O2b 消除的 ST 写入 | `borrowedFrom(s)`(与 s 共享) |
| `SET/ADDI/BINSETI/BINSET2` 命中槽 | `mutated`(放弃) |
| `LD s`(或其 `GETFIELD/INDEX` 投影)流入 `SETFIELD/SETINDEX` 的**基** | `mutated(s)`(就地改) |
| `LD s`(或投影)流入 `CALLMETHOD` 的**接收者** | `mutated(s)`(mut self 原地修改;**#79 只拷实参,不拷接收者**) |
| `LD s`(或投影)流入 `CALLMETHOD` 的**实参** | **安全**(v0.97 #79 后:内建分派 `args.map(deepCopy)`、用户方法帧绑定深拷贝;见 §2.4) |
| `LD s`(或投影)流入 `CALL` 且被调方非 `LDFN/CLOSURE` | `escaped(s)`(内建 `callValue` 仍可能存参;保守——#79 未覆盖 CALL) |
| `LD s`(或投影)流入 `CALL`(用户函数/闭包) | 安全(帧建立深拷贝) |
| `LD s` 流入 MAKER 操作数 | 安全(Maker 深拷贝操作数) |
| `LD s/d` 处于 `SETFIELD/SETINDEX` 的**值**位 | 安全(写入前 `deepCopy`,`src/vm.js:795-817`) |
| `RET` 返回 s/d 的值 | 安全(本帧死亡,无存活第二根;s/d 不是捕获槽,v1 限制) |
| `CLOSURE` 捕获 s | 安全(捕获即拷贝);v1 仍可整体放弃以求简 |
| **s/d 的值是闭包**(vclose/closure) | **VM 腿安全(#81);tree 腿受 #82 约束**——`deepCopy(closure)` 共享 `env.parent`,复制体可经外层块变量互写。v1 若无法证明"不在 parent 链上"→ 放弃 |

### 3.5 可证条件模板(三件套)

任何消除点必须同时给出:
- **(a) 无别名**:值是新分配(`F`)且无第二引用(无 DUP、无槽/容器/池/捕获/迭代器引用)。
- **(b) 消除后原对象不可达**:消费点弹出后,唯一存活引用是接受方(槽或被调方形参)。
- **(c) 身份差异不可观察**:由 §2.2 审计保证;同时接受方后续任何写路径仍按正常拷贝语义(读-存仍拷贝、写入容器仍拷贝)——即消除只影响"这一个存储动作"。

---

## 4. 消除规则候选

### 4.1 O2a:fresh 值 ST/SET 免拷贝(原 v0.97 实施候选;v0.97 裁决后未排期)

#### 4.1.1 形态

`[MAKEVEC|MAKEMAP|MAKETUPLE|MAKESTRUCT|MAKEENUM|CLOSURE|LDFN @ i-1][ST|SET @ i]` 相邻(§1.3 实测形态)。语义上:Maker 先把自己的操作数逐元素 `deepCopy` 进新对象,ST/SET 又把这个新对象整树 `deepCopy` 一次——**第二次拷贝的源对象在 ST 弹出后立即不可达**,拷贝纯属浪费。**B 靶点实测上界**:t6/t7 8→4 entry(50%,省 1 个数组对象)、t3 13→8(38%,省 struct Map + 内层数组 2 个对象);**t5(#81 后)10→5(50%,省 vclose 头 + 捕获数组 2 个对象)**;N 越大绝对节省线性增长。

#### 4.1.2 可证条件(全部满足才消除;任一不满足保留拷贝)

- **R1.0 闭包/env 链前置(#82)**:若被存储的值**可能含闭包**(自身是 vclose/closure,或嵌套在 Maker 构造的容器里),本规则依赖"deepCopy 的闭包快照完整"。VM 腿由 **#81**(v0.97)保证;tree 腿 **#82 仍开放**(`env.parent` 共享)——v1 必须排除该形态(§2.2/§8),否则三腿验收无共同语义基础。
- **R1.1 生产者白名单**:`code[i-1][0] ∈ {MAKEVEC, MAKEMAP, MAKETUPLE, MAKESTRUCT, MAKEENUM, CLOSURE, LDFN}`。**排除** `CONST`(池容器,§3.2)、`LD`(借用)、`CALL/CALLMETHOD`(unknown)、`GETFIELD/INDEX/PATMATCH/ITERNEXT`(借用/内部)。**v0.97 #81 修正**:旧版以"`deepCopy(vclose)` 恒等、无收益"排除 `CLOSURE/LDFN`——该理由已反转:ST vclose 现在深拷贝 captures(t5 全量 5/10 entry,其中新增的捕获二次拷贝 4/10)。该形态与 Maker 同构(产物栈上唯一、无第二引用),R1.2–R1.6 逐条适用,故纳入白名单;空捕获 LDFN 仅省 1 entry/0 分配,收益小但无风险。实现分期可先交付 MAKE* 生产者,但**不得再以"无收益"为由排除 CLOSURE/LDFN**(A6/t5 为验收锚)。
- **R1.2 写入局部槽**:`ins[1] === 0`(kind=local)。捕获槽(kind=1)、`resultSlot` 的 `[DUP][ST]` 形态(生产者是 DUP)都不在规则内。
- **R1.3 `i` 不是跳转目标**:任何 `JUMP/JUMPFALSE/JUMPNONE/ITERNEXT` 的 target ≠ i(否则入边可绕过 `i-1`,弹的不是 maker 产出)。`i-1` 是跳转目标无害(maker 仍会执行并产出 fresh)。扫描口径与 O1 各 pass 同源(`src/opt.js:187-191/281-286`),在**最终指令流**上重算。
- **R1.4 保留全部非拷贝行为**:`ins[3]`(窄型规格池下标)归一、SET 的 `normBySlotTag`、`spanIdx`(ins[4])全部原样执行——只跳过 `deepCopy(stack.pop())`,不跳过 `normBindValue`。
- **R1.5 单消费由构造保证**:`[maker][store]` 相邻且 R1.3 成立 ⇒ 该栈值唯一消费者就是 store(栈纪律:每个值恰一消费者;中间无指令,无 DUP/SWAP 空间)。
- **R1.6 不做额外推断**:不把 `CONST`、调用结果、字段/下标投影当 fresh(v1 的 `GETFIELD/INDEX` 在基为 fresh 时可推出 fresh,但列入 O2a′ 延后,§4.4.1)。

#### 4.1.3 不可观察性证明(三件套)

- **(a) 无别名**:本规则不动 Maker——Maker 对操作数的 `deepCopy` 逐字保留;CLOSURE 对捕获计划的 `deepCopy` 同样逐字保留(产物 vclose 的 captures 已是私有快照,#81)。新对象自身的叶级共享关系与"再拷一次"的世界**逐项相同**(`deepCopy` 对容器新建、对标量/str/json/handle/range 恒等);差别只是新世界的槽持有 `C`,拷贝世界的槽持有 `deepCopy(C)`,而 `C` 在拷贝世界随即成为垃圾。新对象本身是栈上唯一引用(R1.5)。
- **(b) 不可达**:ST/SET 弹出后,栈上引用消失;对象此前从未写入槽/容器/池/闭包(R1.2/R1.5);故箱外唯一引用 = 目标槽。
- **(c) 身份不可观察**:§2.2——所有读操作按值;没有第二条可变引用可制造"写一侧、读另一侧"的差异。后续任何 `let w = v` 仍走拷贝(ST 未标记时),任何 `v.push` 仍要求 mut 且作用于唯一所有者,任何传参仍由帧建立拷贝。**元数据面**亦无差:`deepCopy` 对 vec 保留 `a/__elemTy`、map 保留 `m/__valTy`、struct 保留 `def/name/fields/__spec`、enum 保留 `def/name/tag/vals`、vclose 保留 `fnIdx/__retSpec` 并重建 `captures`(#81),与 Maker/CLOSURE 产物字段集逐项一致(拷贝不引入新字段、不丢构造已设字段)。
- **输入等价**:设原世界存的是 `C' = deepCopy(C)`(ST 后 C 立即垃圾),新世界存 `C`。对槽的任意后续读得到结构相等值;对槽的任意后续写只影响自己;不存在与 `C` 或 `C'` 的第二引用。故任何程序状态与输出相同。

#### 4.1.4 编码

- 新 opcode:**`STNC = 48`**、**`SETNC = 49`**(`ST`/`SET` 的 No-Copy 变体;`OP` 表尾部追加,`src/compiler.js:28-69`;34–39 空号段不用,遵守 plan §4.16.4 "新指令尾部追加")。
- VM:`src/vm.js` 两个 case 与 ST/SET 共用实现,唯一差异是 `const v = stack.pop()`(不 `deepCopy`),其余归一/写槽逐字相同。**不得**复制粘贴出第二套归一逻辑(防止 v0.88 边界修复漂移)。
- `src/artifact.js`:`ARTIFACT_VERSION = 4`;`validateArtifact` 的 `opSet` 自动含新 op(取 `Object.values(OP)`),但需把 `STNC/SETNC` 加入 `poolSlot` 的 `[OP.STNC, 3]/[OP.SETNC, 3]` 界检查。**旧产物(v2/v3)可读**;新产物在旧运行时按版本号**响亮拒绝**(不做静默降级)。**版本检查必须同步改区间**:当前 `src/artifact.js:261` 是 `a.version !== 2 && a.version !== ARTIFACT_VERSION`(实际接受 {2,3});只改常量会让接受集变 {2,4} 而拒 v3——实现时必须改为 `if (a.version < 2 || a.version > ARTIFACT_VERSION)`(接受 {2,3,4}),并以 v3 fixture 锁定(§6.5)。
- 其它 pass:`constPropPass` 的 `case OP.ST`/`case OP.SET`(`src/opt.js:571-593`)必须显式排除/并列处理 STNC/SETNC。**当前管线顺序下 constProp 永远看不到 STNC/SETNC**(O2 在 fixpoint 之后、只改最终指令流;下次编译从 AST 重新发射 SET)。**纵深防御**:一旦未来把 O2 移进 fixpoint、或对 AOT 产物做二次优化,`SETNC` 必须计入 `written` 集合,且 `STNC` 不得进入 ST 候选。类型系统当前使"SETNC 隐蔽导致误传播"不可构造(constProp 只传播 `int/float/bool/str` 的 `[CONST][ST]`,而 Maker 不产出这四类;容器赋值在 checker 层已类型拦截),故这是**结构性守卫而非活跃缺陷**——但移动 O2 位置时必须同时复核该条。`dcePass` 的终结表无需改(非终结指令);`rebuild` 按 5 字段原样拷贝,自动携带新 op。
- **管线位置**:O2 作为 `o2Pass` 在 fixpoint **之后**执行一次(`src/opt.js:632-660` 的 `optimizeFunction` 末尾、`f.code = code` 之前)。理由:需要最终地址域的跳转目标;O1 的 constProp/prune 可能把 `if` 形态折成 `MAKEVEC→ST`(§1.3 末行;`--no-opt` 下同一源是合流目标,不得消除),放在最后吃到全部机会;消除本身不产生新的 O1 机会(只换 op,不删指令),故无需回到 fixpoint。
- 替代方案与否决理由:(i) `kind=2/3` 编码——旧运行时把 `kind!==0` 当 captures 读,**静默错误**,否决;(ii) 函数级 side table(`f.noCopySt` 按地址位图)——旧运行时忽略字段会安全回落,但每次 ST 多一次查表分支、且 wire 仍要加字段,收益低于新 opcode 的自描述/零开销,否决(留作 AOT 兼容性极端要求时的备选)。

#### 4.1.5 锚程序(4 正 2 负)

```ming
// A1 正:Vec 字面量(deepCopy 7 → 3;stdout 逐字)
fn main() with io {
    let v = [1, 2, 3];
    print(debug(v));
}

// A2 正:struct + 嵌套 Vec(deepCopy 11 → 6;值语义隔离仍生效)
struct R { a: i64, v: Vec[i64] }
fn main() with io {
    let r = R { a: 7, v: [4, 5] };
    let mut w = r;          // ST(非 Maker 前驱)仍拷贝 → r 不被 w.push 影响
    w.v.push(9);
    print(debug(r.v));      // [4, 5]
}

// A3 正:Map 与 enum 载荷(deepCopy 15 → 8)
fn main() with io {
    let m = { "k": [1, 2] };
    let e = Some([9]);
    print(debug(m));
    print(debug(e));
}

// A4 负:池常量(生产者 CONST → 不消除;断言 C.len()==3)
const C: Vec[i64] = [1, 2, 3];
fn main() with io {
    let mut v = C;
    v.push(9);
    print(str(C.len()));
}

// A5 负:合流目标(不可裁剪条件的 if 表达式;ST 是跳转目标 → 不消除)
fn pick(c: bool) -> Vec[i64] {
    let z = if c { [1, 2] } else { [3] };
    z
}
fn main() with io {
    let mut i = 0;
    let mut acc = 0;
    while i < 1000 { acc += pick(i % 2 == 0).len(); i += 1; }
    print(str(acc));    // 1500;opt/no-opt deepCopy 相等(未消除)
}
```

**A6 正(v0.97 #81 后新增):CLOSURE 产物绑定**——`[CLOSURE][ST]` 与 Maker 同构,ST 改为 STNC 后 `f` 的 captures 与构造时逐项一致(调用/重复调用/捕获变量后续外写均不可见 O2a):

```ming
// A6 正:闭包绑定(deepCopy 10/迭代 → 5;stdout 逐字)
fn main() with io {
    let mut a: Vec[i64] = [1, 2, 3];
    let mut acc: i64 = 0;
    let mut i: i64 = 0;
    while i < 100000 {
        let f = () => a[0];
        acc += f();
        i += 1;
    }
    print(str(acc));    // 100000
}
```

另需**窄型归一保留锚**(STNC 仍执行 `normBindValue`;两引擎 panic 首行逐字):

```ming
fn main() with io {
    let v: Vec[u8] = [250, 1];
    let mut w = v;
    w[0] = w[0] + 10u8;     // M4002:整数+溢出:250 + 10 超出 i8u 范围(exit 101)
    print(str(w[0]));
}
```

#### 4.1.6 风险

- 跳转目标守卫必须在**最终**指令流上计算;若未来把 O2 移进 fixpoint,每轮都要重算(当前"最后执行一次"回避)。
- 新 opcode 让旧运行时拒绝新产物(预期);`ming build`/tools 缓存键含 VERSION + 编译器源码指纹(`bin/ming.js:1037-1046` toolCacheKey、`bin/ming.js:1243-1256` buildKey),不会命中旧产物,但**发布说明必须写"dist 需重建/旧运行时不能读新 dist"**。
- `MING_STATS` 的 `deepCopy` 计数下降是**观测变化**,不是语义变化;计数含标量恒等调用(9/13 是 int 拷贝),计数降幅 ≠ 墙钟降幅——bench 报时间,MING_STATS 报方向,不得互相替代。B 数据进一步证明:v0.97 工作树 bench_vs 的 700,211 entry 大量是 i64/str no-op(其中 #79 的标量实参已被 m1 快路径跳过;容器/闭包实参仍计),不能把计数当"容器拷贝量"。**反向警告**:#81 使带捕获闭包绑定从 1 entry 升到 1+captures(§1.2.1 t5),因此"O2 前后计数对比"必须用同一基线版本重新采集,不能拿 v0.96 基线直接减。
- **深嵌套值的 M4005 路径**(B 风险表登记):`deepCopy` 递归可触发 JS `RangeError`,CLI 兜底转 M4005(`bin/ming.js:355-368`)。O2a/O2c 省掉的是一次"构造之后"的全深度递归,而 Maker 的操作数拷贝已先走过同深度递归;对"按迭代加深的嵌套结构",溢出点至多推迟一轮、不会消失。极端边界(构建深度恰在阈值、ST 拷贝恰好压垮)下 M4005 可能变为不触发——属资源类兜底而非语言合同,闸门不覆盖该病态形态,在发布说明中登记为已知观测边界。
- wasm/C 均从 **AST** 编译(`src/wasm.js:166` tryCompileWasm、`src/cbackend.js:2068` emitC),新 opcode 不进 `analyze()`/C 发射器;`--strict-wasm` 三态不变(AST 形状不变)。这一点与 plan §4.16.4 "新指令在 analyze() 中显式处理"的泛化表述不同,**以 ADR 实测口径为准**。

### 4.2 O2b:不可变 `let` 读取免拷贝(暂缓;条件与放弃清单定稿)

#### 4.2.1 形态

`[LD 0 s][ST 0 d]` 相邻:`let d = s;`(d 为非 mut `let`)。把 d 绑定为 s 的**共享引用**,跳过整树拷贝。这是"读一个不可变快照"的常见形态(§1.3 快照循环 10/迭代;B 的 t1_imm/t10b 实证 ST 是唯一拷贝点)。

**措辞校准(B §4.3.1)**:`LD`/`INDEX`/`GETFIELD` 本身**不拷贝**(VM `src/vm.js:721-725/808-816`);所谓"读取免拷贝"在现有实现里没有可省的读拷贝——O2b 的实际语义只能是"**绑定处共享 RHS 容器**"(`let d = s` 的拷贝发生在 ST d)。本 ADR 全文按此口径;名称沿用任务口径"不可变 let 读取免拷贝",但实现与证明均以 ST 为落点,不得表述为"消除了 LD 拷贝"。

#### 4.2.2 可证条件

- **R2.1 形态**:`[LD 0 s][ST 0 d]` 相邻;s≠d;ST 不是跳转目标(同 R1.3);d 的 ST 唯一(声明一次)。
- **R2.2 目的不可变**:d 是 `let`(非 `let mut`),checker 的 M3004 保证 `d.push/d[i]=.../d.f=...` 不可达(`src/checker.js` M3004;GUIDE §10)。
- **R2.3 源不可写**:s 在**整个函数**内无 `SET/ADDI/BINSETI/BINSET2`(kind=0 目标 s)、无 `BIND` 写 s(复用 O1c 的 `written` 扫描,`src/opt.js:565-583`)。
- **R2.4 源/目的不可就地变异**:按 §3.4 槽表的正扫描,`LD s`/`LD d` 及其 `GETFIELD/INDEX` 投影**不得**流入 `SETFIELD/SETINDEX` 的基、`CALLMETHOD` 的接收者。
- **R2.5 无逃逸**:**CALLMETHOD 实参自 v0.97 #79 起由被调方拷贝**(内建 `args.map(deepCopy)`;用户方法帧绑定),不再是逃逸面;剩余禁止面 = `LD s/d`(或投影)**流入 CALLMETHOD 接收者**(就地变异)、**流入非 `LDFN/CLOSURE` 的 `CALL`**(内建 `callValue` 仍可能存参,保守)、**存入容器/捕获/返回**(§3.4)。若值是闭包,复制语义受 **#82**(tree `env.parent` 共享)约束——未闭合前 v1 排除闭包值(§2.2)。
- **R2.6 支配性**:ST 支配 d 的全部后续 LD(与 O1c 同口径 CFG BFS,`src/opt.js:537-554`);语言保证 + 防御检查。
- **R2.7 v1 限制**:s/d 均为 `kind=0` 局部槽;s 不是形参、不是捕获槽;函数内无 `CLOSURE` 捕获 s/d(捕获虽拷贝,先求简)。
- **R2.8 单引用前提**:s 的槽状态必须是 `owned`(§3.4),即 s 自身不是另一条 O2b 共享链的接受者(不链式消除)。

#### 4.2.3 放弃清单(任一命中 → 该槽全部读取保留拷贝)

1. 任何 `SETFIELD/SETINDEX` 的基可达 s/d(含 `s.tag[0]=...`、`s.tag.push(...)`)。
2. 任何 `CALLMETHOD` 的**接收者**可达 s/d(实参自 #79 后安全;但仍受下方闭包/逃逸复查约束)。
3. s 是 `let mut`(即使当前扫描未见写——保守,防未来语法/内建面变化)。
4. s/d 是形参、捕获槽、循环绑定或元组解构绑定(v1 只认 `let` 单绑定)。
5. 函数含 `CLOSURE` 捕获 s/d(本可证明安全,但引入闭包生命周期维度,放弃)。
6. 值类型涉及 `Ptr`/`Slice`/unsafe 面(不在本管线)。
7. 函数内存在 `ASM`/`SYNC_*`(不在本 ADR 的语义模型内)。

#### 4.2.4 锚程序

```ming
// B1 正:不可变快照循环(deepCopy 10/迭代 → 1/迭代)
fn main() with io {
    let src = [1, 2, 3, 4, 5, 6, 7, 8];
    let mut acc = 0;
    let mut i = 0;
    while i < 100000 {
        let b = src;
        acc += b[7];
        i += 1;
    }
    print(str(acc));
}

// B2 负:源被就地变异(须保留拷贝 → src 仍是 [1,2])
fn main() with io {
    let mut src = [1, 2];
    let b = src;
    src.push(3);
    print(str(b.len()));
}

// B3 负:目的逃逸进容器并遭就地变异(v0.97 #79 后 push 拷贝实参 → 三腿一致;仍须放弃 O2b)
// 断言 src.len()==2;b/v[0] 的隔离已由 #79 保证(§107 回归),此锚保留为"容器存入 = 逃逸"面
fn main() with io {
    let src = [1, 2];
    let b = src;
    let mut v: Vec[Vec[i64]] = [];
    v.push(b);
    v[0].push(9);
    print(str(src.len()));   // 值语义应为 2(#79 前三腿中 VM 曾打印 3)
}
```

#### 4.2.5 为什么暂缓

- **证明面缺失**:R2.4/R2.5 需要槽级 provenance 正扫描(§3.3/§3.4),现有 O1c 只有 written/captured/dominance 骨架,没有"LD 的消费者切片";实现量估计 150–250 行,且正确性依赖对**所有**变异 sink 的枚举完整——这是最容易随新内建/新语法漂移的面。
- **规范前提已修复,但剩余前置仍在**:§2.4 的 VM/tree 分歧("存入容器 = 拷贝")已由 **v0.97 #79** 修复,B3 之类的 CALLMETHOD 实参形态三腿一致;**但 #82(tree 闭包 `env.parent` 共享)仍开放**,值可能含闭包时三腿仍无共同语义基础。结论维持:O2b 暂缓;**前置 = #82 修复 + 槽级 provenance 分析(§4.2)**;不再以 #79 为阻塞项。
- **收益面窄**:R2.2/R2.3 把 `let mut` 源全部排除,O0 拷贝密集锚点不命中。B 实测上界:t1_imm `let b=a` 5→1 entry(80%,循环内 100% 数组)、t10b(不可变 Rec)14→1(93%,2 对象/迭代);t10(O0 原形,mut 源+回写)保守证明为 **0**(激进证明才能触及第一个 13)。建议先用 O2a/O2c 的数据决定是否值得投入 provenance 分析。

### 4.3 O2c:实参临时免拷贝(独立评估;原 v0.98 候选,v0.97 裁决后未排期)

#### 4.3.1 形态

`[LDFN/CLOSURE/…][<fresh 实参表达式>…][CALL argc]`:实参位上的值若为 `F`(§3.2),VM 在 `callCompiled` 帧建立时对该形参的 `deepCopy`(`src/vm.js:653-660`)可跳过。**B 靶点实测**:t8 `peek([1,2,3])` 8→4 entry(50%,省 1 个数组);t8b `let a=[…]; peek(a)` 12→8(O2c 4/12),与 O2a 的 ST 消除合计 12→4(67%)。B 的 t2(`peek(a)` 只读形参、a 非最后使用,5→1 entry)是**超出 plan 第 8 条**的扩展,列入 §4.4.4 候选,不在 v1 范围。

#### 4.3.2 可证条件

- **R3.0 闭包/env 链前置(#82)**:实参值可能含闭包时,本规则依赖"被调方收到的闭包已是完整快照"。VM 腿由 #81 保证;tree 腿 #82 开放(`env.parent` 共享)——v1 将含闭包值的实参排除(§2.2/§8)。
- **R3.1 实参 fresh**:对 CALL 顶部 `argc` 个栈位做块内反向切片:第 i 个实参的产出必须是白名单 Maker,且该值的状态在块内传播为 `F`(无 DUP/SWAP 制造第二引用;实参求值区间内无跳转目标/无跨块)。
- **R3.2 掩码边界**:`argc ≤ 30`;只对 `i < argc` 置位;掩码放 `CALL.ins[3]`(c 字段,现恒 0)。
- **R3.3 实参之间/与其它栈位不共享**:由 `F` 状态保证(每个 Maker 新分配);同一字面量源写两次是两个独立 Maker(`f([1],[1])` 安全),`f(v, v)` 是 `LD` → `B` → 不置位。
- **R3.4 被调方不需要摘要**:掩码只被 `callCompiled` 消费(用户函数/闭包/本地函数);内建/std/ctor 分支忽略掩码(`src/vm.js:1142-1170`)——它们本来就有自己的口径,行为零变化。
- **R3.5 归一保留**:`callCompiled` 的 `pspecs[i]` 归一(`src/vm.js:652-660`)照常执行;只跳过 `deepCopy(args[i])`。
- **R3.6 调用方不再可达**:CALL 弹出实参后,调用方无任何引用(CALL 是唯一消费者;`F` 状态 + R3.1)。

#### 4.3.3 为什么不需要"被调方未捕获该实参"的摘要(与常见直觉相反)

常见直觉要求"被调方未捕获该实参引用"才传引用。**这个条件可以不要求**,理由:

- 传引用的前提是调用方**放弃**该临时(它已被 CALL 弹出且无其它引用)。被调方拿到后就是**唯一所有者**,它可以就地变异、存进自己的容器、返回、或捕获——这些行为都只影响一个无其他持有者的对象,调用方观察不到。
- 唯一会打破它的是"调用方仍持有第二引用"——由 R3.1 的 `F` 状态(单消费、无 DUP)排除。
- 因此 O2c 是**调用方侧规则**,不需要跨函数逃逸/纯度摘要(这也是它比 O2b 更容易立项的原因)。若未来要实现"传参后再用"的形态(实参不是临时),才需要摘要——列入不做清单(§8)。

#### 4.3.4 编码与协同

- `CALL` 的 `ins[3]` 存掩码:bit i = 第 i 个实参 move-safe。编译器现恒发 0(`src/compiler.js:1415`),**旧运行时读不到掩码 → 按原路径拷贝**,天然向后兼容(不需要靠版本拒绝)。
- `callValue(callee, args, span, noCopyMask = 0)` → `callCompiled(..., noCopyMask)`;参数循环:

```js
let a = (noCopySelf && i === 0) || ((noCopyMask >>> i) & 1) ? args[i] : deepCopy(args[i]);
```

- `src/artifact.js`:CALL 的 c 字段不进 `poolSlot` 校验(不是池下标);可加 `mask < (1 << argc)` 防御校验(可选)。
- **CALLMETHOD 不在 O2c v1 范围内——独立同构机会(O2c-M)**:v0.97 #79 起 CALLMETHOD 内建分派对实参 `deepCopy`(`src/vm.js:852`),这是**新的实参拷贝边界**;`CALLMETHOD.ins[3]` 当前恒 0(`src/compiler.js:1401/1408`),可按与 CALL 相同的**调用方侧单所有权**证明置位。合成靶点(本次刷新实测,`.zcode/o2r/t11/t12`):
  - t11 `v.push([1,2,3])`(fresh 实参):7 entry/迭代(MAKEVEC 3 + 实参拷贝 4),O2c-M 可省 4 = **57%**;
  - t12 `let a=[1,2,3]; v.push(a)`(最后使用):11 entry/迭代(MAKEVEC 3 + ST a 4 + 实参 4),可省 4 = **36%**;
  - 与 CALL 的关键差异:内建实现必须消费掩码(用户方法走帧绑定、不得双拷;接收者永不 move)。掩码编码、`argc≤30`、旧运行时"/c 字段非 0 不安全"等约束与 CALL 同款,但**需要独立的 artifact 防御检查**。**登记 §4.4.7,不并入 O2c v1**。
- **wasm 协同**:wasm eligible 的被调方走线性内存编组(`src/vm.js` wasm 分支),掩码不参与——编组本身就是拷贝,语义不变;`--strict-wasm` 三态不变。
- **tree 协同**:tree 不执行字节码;`--tree` 腿保持"调用点拷 + 帧建立拷"的现状,输出必须与 VM 腿逐字一致(值语义相同,拷贝次数不同)。

#### 4.3.5 锚程序

```ming
// C1 正:构造后立即传参(deepCopy 34/迭代 → 21/迭代)
struct R { a: i64, v: Vec[i64] }
fn f(r: R) -> i64 { r.a + r.v[7] }
fn main() with io {
    let mut acc = 0;
    let mut i = 0;
    while i < 100000 {
        acc += f(R { a: 1, v: [1, 2, 3, 4, 5, 6, 7, 8] });
        i += 1;
    }
    print(str(acc));
}

// C2 正:闭包接收 fresh Vec 实参(掩码经 CALL → vclose → callCompiled;deepCopy 8 → 4)
fn main() with io {
    let g = (v: Vec[i64]) => v.len();
    print(str(g([1, 2, 3])));
}

// C3 负:借用实参(LD → B,不置位;行为与计数都不变)
fn main() with io {
    let a = [1, 2, 3];
    print(str(len_of(a)));
}
fn len_of(v: Vec[i64]) -> i64 { v.len() }
```

#### 4.3.6 风险

- 掩码位与形参下标必须一一对应;argc 与 nParams 不一致时以 nParams 为界读取(`(mask >>> i) & 1`,i ≥ argc 的位恒 0)。
- 若未来支持"部分实参求值跨基本块"或 `SWAP` 参与实参排布,块内切片必须给出 `S`(保守);不得用"线性相邻"近似替代栈状态。
- 与 O2a 组合:`f(Rec{...})` 只命中 O2c(生产者 CALL 的实参是 MAKE*),`let r = Rec{...}` 只命中 O2a;两者不重叠、可独立提交。

### 4.4 后续候选(登记不预支)

#### 4.4.1 O2a′:Maker 操作数免拷贝

`let v = [[1], [2]]` 中,外层 MAKEVEC 对两个内层 fresh vec 的 `deepCopy` 也是冗余(§1.3 形态)。条件与 O2a 同构,但需要**逐操作数** freshness(栈位切片),且要处理"同一 Maker 的多操作数"索引。收益:嵌套字面量再省一层。等 O2a 落地后按数据评估。

#### 4.4.2 O2a-M:已知纯方法结果

`v.clone()`、`m.get(k)`、`Option.unwrap()` 等在实现里已返回副本,`let x = v.clone()` 的 ST 又拷一次。可按方法名白名单 + 接收者类型静态已知来标记 `F`。**风险**:用户 trait 方法可同名;`cbackend`/`wasm` 的类型面;方法是未来扩展面。不预支。

#### 4.4.3 O2d:死源读取/移动(唯一能移动 O0 锚点的规则)

`let copy = r; r = copy;`:第一次 ST 的源槽 r 在之后只被**整体覆盖**(SET,不就地变异),旧对象不再被 r 观察——可把第一次读取当作"移动"。需要活跃性 + "覆盖前无就地变异"证明。**收益(B t10):O0 拷贝密集 27→14/迭代(第一个 13 可省,≤48% entry / ≤50% 对象;保守证明为 0)。** 本 ADR 只登记,不设计(超出本次范围,且需要 O2b 的 provenance 基础)。

#### 4.4.4 O2c-2:只读形参共享(B t2 上界)

`peek(a)` 中 a **不是最后使用**、但被调方只读(不 mut 形参、不存储、不捕获)时,实参也可共享。B 实测 t2 5→1 entry(80%,循环内约 100% 数组)。它超出 plan 第 8 条("fresh 临时 + mut 形参最后使用"),且需要被调方摘要(与 O2c 的"无需摘要"相反);**不预支**,等 O2c 数据与被调方效果/纯度面评估后再议。

#### 4.4.5 O2e:闭包捕获免拷贝(B t5/t5c)

`CLOSURE` 按捕获计划逐项 `deepCopy`(`src/vm.js:755-760`);若被捕获值是 fresh 临时且闭包是唯一消费者,可省。**v0.97 重算**:t5(#81 后)每迭代 10 entry——捕获创建 4(vm 的 vec + 3 元素)占 **40%**,t5c 立即调用仍为 5 entry、捕获 4 占 **80%**;但 t5 捕获的 `a` 是已绑定变量(非 fresh),故 O2e 对 t5 实省 **0**,只对"捕获 fresh 临时"形态成立。hof/wordfreq 的 lambda 不捕获容器,语料热路径 0。**登记不排期**。
**注意**:`deepCopy(vclose)` 自 #81 起**非恒等**——闭包绑定 ST 的捕获二次拷贝(t5 的另 5/10)**由 O2a 覆盖**(R1.1 已纳入 CLOSURE),不要与 O2e 的"构造期捕获拷贝"重复计算;两者可叠加,但同一份捕获不会被同一条规则消除两次。

#### 4.4.6 O2f:CALL 结果 / 死绑定(相邻机会,B §5.6-4)

filescan 的 `let _w = write_file(...)` 产生约 1,000 次 Result enum 拷贝/运行:结果是 CALL(unknown),但绑定从未被读(`_` 前缀/未使用)。可做"未使用绑定的 ST 直接 POP"或"已知返回 fresh 的内建摘要"。既不是 fresh MAKE*,也不是别名/实参,属第四条规则;**登记不预支**(死绑定消除可先独立评估,风险最低)。

#### 4.4.7 O2c-M:CALLMETHOD 实参临时免拷贝(v0.97 #79 后的新边界)

`[<fresh 实参>…][CALLMETHOD name argc]`:v0.97 #79 起内建方法分派对实参逐参 `deepCopy`(`src/vm.js:852`)。调用方侧单所有权证明与 O2c **同构**(实参位 `F` 状态 + 无 DUP/跨块;被调方无需摘要),差别只在编码与消费方:

- **编码与兼容**:`CALLMETHOD.ins[3]` 当前恒 0(`src/compiler.js:1401/1408`,可用于掩码);需与 CALL 同款 `argc ≤ 30`。**与 CALL 的兼容差异必须写清**:CALL 的旧运行时忽略掩码 → 按原路径**拷贝**(安全回落);CALLMETHOD 在 #79 之前的旧运行时**根本不拷贝实参**——忽略掩码会退回别名语义,不安全。因此 CALLMETHOD 掩码必须与 O2 的产物版本门禁绑定(v4+ 运行时;旧运行时按版本号拒绝整个产物),不能宣称"天然向后兼容"。
- **消费方**:仅内建实现消费掩码(args 已是 move-safe);用户方法走帧绑定、不得双拷;接收者永不 move(mut self 原地改)。
- **实测上界**(本次刷新合成靶点;前值为构造推算):t11 `v.push([1,2,3])` 7 entry/迭代(MAKEVEC 3 + 实参 4;前值应 3),O2c-M 可省 4(-57%);t12 `let a=[1,2,3]; v.push(a)`(最后使用)11 entry/迭代(前值应 7),可省 4(-36%)。
- **不做预支**:独立于 O2c v1;若 O2c 立项,建议复用同一块内切片/掩码基础设施,但单独评审(消费方不同、artifact 防御检查不同)。

---

## 5. 安全不变量与观测面

### 5.1 三件套矩阵

| 规则 | (a) 无别名 | (b) 原对象不可达 | (c) 身份不可观察 | 结论 |
|---|---|---|---|---|
| O2a | Maker/CLOSURE 新分配;栈上唯一引用(相邻单消费) | ST/SET 弹出即无栈引用;无槽/池/捕获引用 | §2.2 全通道;后续写仍拷贝;**闭包值受 #82 前置约束(R1.0)** | 可证(v1 排除含闭包值形态) |
| O2b | **需证明**:s 槽 owned、无第二引用(§3.4) | d 获得共享引用;s 仍可达(共享是设计) | 需要"无就地变异"证明(§3.4);**#79 已修复 CALLMETHOD 实参漏洞,#82(闭包 env 链)仍开放** | 暂缓 |
| O2c | 实参 `F` 单引用(块内切片) | CALL 弹出后调用方无引用;所有权转移给被调方 | 被调方是唯一所有者,变异/存储/返回均不可见回调用方;**含闭包值的实参受 #82 约束(R3.0)** | 可证(v1 排除含闭包值形态) |

### 5.2 观测面变化登记

| 观测 | 变化 | 口径 |
|---|---|---|
| stdout / exit code | **不变**(硬门槛) | 三腿逐字 |
| panic 消息/位置 | **不变** | 首行逐字 + exit 101 |
| `instr` / `steps` | **不变**(O2a/O2c 同长度) | MING_STATS |
| `alloc` | **不变**(deepCopy 不计费;MAKE 计费不变) | MING_STATS/`--max-alloc` |
| `concat` / `callMethod` | 不变 | MING_STATS |
| `deepCopy` | **下降**(观测量;O2 只改 VM 字节码,tree 计数不因 O2 变化——与 #81 引起的基线变化是两回事) | MING_STATS;闸门断言"正锚严格下降、负锚相等";基线须用同版本重采 |
| AOT 产物 | v4;旧产物(v2/v3)可读——**版本检查必须改区间**(§2.3),新产物旧运行时拒绝 | `src/artifact.js` |
| strict-wasm | 不变(AST 形状不变) | `--strict-wasm` exit 0/2 口径照旧 |

---

## 6. 验证策略(沿 O1 模板)

### 6.1 三态逐字 + panic 锚

- 每个 O2 锚程序 × **优化开 / `--no-opt` / `--tree`** 三态 stdout 逐字一致;panic 锚 exit 101 且 stderr 首行逐字。
- 闸门就绪判定沿用 O1b/O1c 三级探测(`src/opt.js` 含 O2 迹象 + `--no-opt` 已注册 + 行为探测:正锚 deepCopy 严格下降);未就绪 → pending(0 断言、退出码不因此失败),逐次重跑轮询。
- 全量 `node tests/run.mjs` 0 失败;既有 1603 项**零校准**(O2 不改任何既有输出;1603 = v0.97 工作树:1586 + §107 9 + §108 8)。

### 6.2 `deepCopy` 计数断言(MING_STATS)

- **采集腿必须是 `--no-wasm`**:默认腿的 wasm eligible 函数不经过 JS 执行循环、不计 deepCopy(B 实测 fib 默认 3 vs `--no-wasm` 150,052)。三腿 stdout 仍逐字比对,但计数断言只在 VM-only 腿做。
- 正锚:opt 腿 `deepCopy < no-opt` 腿(严格);负锚(池常量/合流目标/借用实参)两态**相等**。
- 同时断言 `instr/steps/alloc/concat/callMethod` 两态**相等**(O2 的强不变量;任何不等都说明实现越界)。
- 注意 attribution:**DCE 也可能删掉不可达的 ST/SET**;锚程序不得含死代码,否则 deepCopy 差值不能归因于 O2。
- 同时报 **entry 与对象数**:B 已证明 700,211 entry 中大量是 no-op;闸门断言 entry 方向,bench/opt-baseline 报对象数与耗时。

### 6.3 每规则独立锚 + 值语义专项

- 规则锚:§4.1.5/§4.2.4/§4.3.5 全部入库(opt_gate 新 O2 节)。
- 值语义专项:同一实例连跑(循环 3 轮/1000 轮)、变体隔离(`let mut w = r; w.v.push` 后 r 不变)、闭包捕获 fresh 值后外层再读、enum/Map 载荷、`Vec[Vec]` 嵌套、元组模式、返回值边界。
- **struct 字面量 + invariant 专测**:带 invariant 的构造走"字段值先 ST 到临时槽 → 求 invariant(LD 临时槽)→ LD 字段 → MAKESTRUCT"(`src/compiler.js:1196`);O2a 会消除这些临时槽的拷贝,必须断言 invariant 读到的值与构造结果不变(若实现期发现该形态风险,可用 R1.2 的 `resultSlot` 同款排除法按槽名/形态放弃)。
- 计数锚 + 行为锚必须同时存在:计数下降证明"消除了",行为一致证明"消对了"(O1c 教训:只有计数断言会放过错误消除,只有行为断言会放过"没生效")。

### 6.4 fuzz 扩展(必须做,不许只跑旧种子)

新增 **opt-diff 轴**:每个生成程序跑两次(`--no-wasm` 优化开/关),比较 stdout/exit/panic 首行;任何分歧即失败。生成器新增 6 类形态(O1c 教训:fuzz 对"推断面"结构性失明,必须**定向**生成):

1. fresh 值绑定后经 mut 副本变异:`let a=[1,2]; let mut b=a; b.push(9);`(断言 a 不变)。
2. fresh 值传参后被调方就地变异形参(mut 形参/容器方法)。
3. fresh 值存入容器,再对容器元素就地变异(`let mut v: Vec[Vec[i64]] = []; v.push([1]); v[0].push(2);`)。
4. struct/enum 嵌套 Vec/Map 载荷的构造 → 绑定 → 拷贝 → 变异链。
5. 合流形态:`if/else` 两支各产出字面量,汇合后绑定/传参。
6. 池常量容器读取 + 变异尝试(必须不污染 `const`)。
- 每种子 ×40;至少双种子(44044/777);与既有三后端差分并行跑。
- 变异实验(手工,不入库):(i) 移除 R1.3 跳转目标守卫 → A5/合流 fuzz 必须抓到;(ii) 把 CONST 容器当 fresh → A4 必须抓到(池污染);(iii) 把 `LD` 实参当 move-safe → C3/借用 fuzz 必须抓到。每个实验记录"抓到的断言/程序",证明检测器非纸面。
- **位置移动的复核项(不是变异实验)**:若把 O2 移进 fixpoint,`constPropPass` 的 `written` 必须纳入 SETNC;类型系统使误传播当前不可构造(§4.1.4),该项以代码评审 + 全量套件守护。

### 6.5 AOT / strict / tools

- `ming build`(含 `--with-source`)→ 运行 dist,与源码腿逐字;`--clean-cache` 重建;**新增 v3 产物兼容 fixture(并同时保留 v2)**——旧产物无 STNC/SETNC、加载后照旧拷贝。现有版本检查是 `!== 2 && !== ARTIFACT_VERSION`,直接改 4 会拒 v3;fixture 必须锁定"v2/v3/v4 三版并存可读"(§2.3/§4.1.4 的区间检查)。
- `ming check --strict-wasm` 与 `ming run --strict-wasm` 对 O2 锚程序 exit 0(无回落),证明 wasm 资格未变。
- `ming tools` 抽样(path/wc/json)行为逐字、缓存键因 VERSION/编译器指纹变化而重建。
- `ming cc` 对可编译形态(hello/fib)输出不变(AST 路径,新 opcode 不进入)。

### 6.6 覆盖率与文档

- coverage 复测(信息性):`vm.js` 的 STNC/SETNC case 必须被值语义专项覆盖。
- 文档:GUIDE 修订记录(新 opcode/观测口径/dist 重建提示)、plan §4.16.3 O2 状态、opt-baseline 新增 O2 前后对照表(实施者按 B 的 t6/t7/t8/t1_imm/t10b/t5/t11/t12 基线刷新;注意 **opt-baseline 的 hof 300,005 等行仍是 v0.92/v0.96 口径**,v0.97 #79/#81 后需重采)、README 路线图。

---

## 7. 分期与提交

> **状态**:本 ADR **未实施**。维护者 v0.97 裁决(2026-11-20):**O2 降级为"待真实容器拷贝 workload 再启动"**——下表保留立项时的候选标注与规模预估,不代表已排期;重新启动需真实 workload 证据 + 新增 O2 专用基准 + 维护者重新裁决。

| 阶段 | 内容 | 前置/门槛 | 版本 | 规模预估 |
|---|---|---|---|---|
| **O2 基准** | 把 B 的 t6/t7/t8/t1_imm/t10b/t5 形态正式入 `tests/bench.mjs`(或 opt_gate 内嵌)+ 采 O2 前基线(deepCopy entry/对象数/耗时) | **B 数据已就绪**(`docs/copy-elision-research.md`);基准代码确定性;**降级后未排期** | 未排期(原 v0.97 同批) | tests ~120 行 + opt-baseline 一节 |
| **O2a** | `STNC/SETNC` + o2Pass(fresh 绑定;生产者含 CLOSURE/LDFN)+ artifact v4(版本检查改区间)+ opt_gate O2 节 + fuzz opt-diff 轴 + docs | 复核位通过;O1 管线稳定(v0.96 已交付);**O2 基准先行**(否则收益不可测,B 结论);**降级后未排期** | 未排期(原 v0.97 候选) | src ~180–250 行(opt.js ~70 / vm.js ~12 / compiler.js 2 / artifact.js ~8)+ 测试 ~250 行 |
| **O2c** | CALL 掩码 + callCompiled noCopyMask + 块内切片 | O2a 交付 + 其数据(实际 deepCopy 降幅/耗时)+ 独立评审 | 未排期(原 v0.98 候选) | src ~100–150 行 + 测试 ~150 行 |
| **O2c-M** | CALLMETHOD 掩码(内建方法实参)+ methodArgsNeedCopy 协同 | O2c 交付 + 独立评审(消费方不同、兼容门禁不同,§4.4.7) | 未排期(仅登记) | src ~60–90 行 + 测试 ~80 行 |
| **O2b** | 槽 provenance + 逃逸表 + STNC(共享模式) | **前置:#82 修复**(tree 闭包 env.parent 共享,开放 P1)+ 槽级 provenance + 方法面审计;**#79 已于 v0.97 修复**(不再阻塞) | 未排期 | src ~250–350 行(风险最高) |
| **O2d** | 死源读取/移动 | O2b 的 provenance 基础 + 活跃性分析 | 仅登记 | 未估 |

- **每期独立提交**,提交消息按既有规范(`Ming vX.Y.Z — ...`),含测试数量与关键裁决。
- **开关**:沿用 `--no-opt`/`MING_NO_OPT=1` 作为唯一公开关闭面(O2 与 O1 同开关);开发期可加 `MING_OPT_TRACE=1`(stderr 逐条打印 `[opt] O2a stnc fn=<名> addr=<n> spanIdx=<n>`,默认零输出)供闸门断言"规则确已触发",不进入公开 CLI。
- **回退**:O2a 可整段移除(新 opcode 不被发射即回到 v0.97 行为;artifact v4 的读取兼容保留);O2c 掩码全零即回退;O2c-M 掩码全零即回退(依赖 v0.97+ 运行时,#79)。

---

## 8. 明确不做(本 ADR 范围之外,维持登记)

- **池常量传播 / 池容器当 fresh**:O1c 已拒绝(`src/opt.js:18/619`);O2 明确 CONST 容器 = shared。
- **跨调用逃逸分析 / 被调方摘要**:O2c 用调用方单所有权回避;真正的跨函数逃逸/纯度分析不做。
- **需要堆别名分析的形态**:BIND/PATMATCH 绑定、CALLMETHOD 接收者、SETFIELD/SETINDEX 的共享基、字段/元素投影上的消除——全部不做。**CALLMETHOD 实参自 #79 后由被调方拷贝,是"安全"面而非逃逸面**;对它的消除机会独立登记为 O2c-M(§4.4.7),不并入 O2b/O2c v1。
- **返回值 RET 的显式拷贝消除**:VM 的 RET 本就不拷贝(`src/vm.js:861-870`);tree 的返回拷贝是树引擎内部口径,不属字节码管线。
- **std 方法内部 deepCopy**(访问器返回副本):契约内行为,不是字节码 pass 的对象;动它属于 API 语义变更,另裁。
- **COW/引用计数运行时**:design.md §2.3 的长期方向;本 ADR 只做静态可证子集,不引入运行时 refcount。
- **wasm/C 后端改动**:两者 AST 编译,不消费字节码;O2 不触达。
- **内联/尾调用**:会改 panic 调用栈首行,既有合同明确否决(plan §4.16.3 第 16 条)。
- **Slice/unsafe/asm 面**:不在本管线。
- **跨帧/闭包生命周期消除**:不做。
- **在 #82 修复前对含闭包/环境链的形态实施 O2b/O2c/O2a**:不做(v1 显式排除"值可能含闭包"的形态;§2.2/§4.2.5)。#79 已修复,不再是 O2b 的阻塞项。

---

## 9. 维护者复核位(沿 ADR-009 §7 先例)

| # | 决策点 | 默认立场 | 理由/先例 |
|---|---|---|---|
| 1 | O2a 是否立项 v0.97 | 原默认**立项**;**v0.97 实际裁决:未立项(降级待真实 workload)** | 证明最简、零语义面,但现有语料热路径收益≈0(B 结论);需真实 workload 证据 |
| 2 | 新 opcode `STNC/SETNC` + artifact v4 | **采用**(重启后) | 旧产物可读;新产物旧运行时响亮拒绝;side table 备选已否决(§4.1.4);版本检查必须改区间(§2.3) |
| 3 | O2 跑在 fixpoint 之后一次 | **采用** | 最终地址域 + 吃 O1 折叠后的机会 + 消除不产生新 O1 机会 |
| 4 | O2c 是否紧随 O2a | **单独评估**(默认不并批) | 需 O2a 数据回答"实参临时占比值不值得";掩码实现独立 |
| 5 | O2b 是否暂缓 | **暂缓**(默认) | #79 已修(v0.97);剩余前置 = **#82**(tree 闭包 env.parent 共享,开放 P1)+ 槽级 provenance;当前规则近似空集 |
| 6 | #77 候选(VM CALLMETHOD 实参不拷贝)是否单独立项 | **已立项并修复:v0.97 #79**(不再是待决项) | 规范 + tree 一致 = VM 偏离;本身是值语义洞;留给本 ADR 的遗产 = 新边界 O2c-M(§4.4.7) |
| 7 | O2d(死源移动)是否登记 | **登记不排期** | 唯一能移动 O0 锚点的规则,但需活跃性分析 |
| 8 | `MING_OPT_TRACE` 调试通道 | **接受**(默认零输出) | 闸门需要"规则已触发"的观测,避免纯计数归因歧义 |
| 9 | fuzz opt-diff 轴是否作为硬门槛 | **是** | O1c/O1b 教训:推断面需要定向生成 + 变异实验 |
| 10 | `deepCopy` 计数口径是否接受"含标量恒等" | **接受并登记** | 口径既有(`src/interp.js:83-84`);计数只做方向断言,不做时间代理 |
| 11 | 是否先补 O2 专用基准再排期 | **是**(B 结论) | 现有 bench_vs 热路径可命中容器拷贝≈0;t6/t7/t8/t1_imm/t10b 不入库则 O2a 收益不可测 |
| 12 | O2c 的 t2 只读形参共享是否扩围 | **不扩围**(仅登记 §4.4.4) | 需要被调方摘要,超出 plan 第 8 条;等 O2c 数据 |

**复核记录(2026-11-20,v0.97)**:维护者裁决 = **O2 降级为"待真实容器拷贝 workload 再启动"**(GUIDE v0.97.0 修订记录);**本 ADR 未实施**,上述 12 项复核位保留为重新启动时的检查单。v0.97 实际落地的两个 P1 修复(#79 CALLMETHOD 实参拷贝、#81 vclose deepCopy)独立于本 ADR,但已改变基线计数与部分前提(§1.2.1/§2.4/§4.2.5)。重新启动流程:真实 workload 证据 → O2 专用基准入库(§7 第一行)→ 12 项复核位逐项确认 → 实现流水线;不因 ADR 存在而自动启动。

---

## 附录 A:O2 锚的实测计数与形态(设计期 2026-11-20;采集于 HEAD `3d8a0b8`,t5 行在 v0.97 #81 后复跑)

| 锚 | instr | steps | deepCopy(优化开=关) | 构成 | O2a 后预期 |
|---|---|---|---|---|---|
| `let v=[1,2,3]` | 13 | 13 | 7 | MAKEVEC 3 + ST 4 | 3 |
| `let r=R{a:7,v:[4,5]}` | 14 | 14 | 11 | MAKEVEC 2 + MAKESTRUCT 4 + ST 5 | 6 |
| `let m={"k":[1,2]}; let e=Some([9])` | 24 | 24 | 15 | 2+3+4 / 1+2+3 | 8 |
| 字面量循环 10 万 | 42 | 3,000,016 | 3,400,002 | 8+12+13+1/迭代(1 = SET acc 标量) | ~2,100,002 |
| 实参临时循环 10 万 | 44 | 3,200,016 | 3,400,002 | 20+13+1/迭代(1 = SET acc 标量) | ~2,100,002(O2c) |
| 不可变快照循环 10 万 | 36 | 1,400,026 | 1,000,019 | 9+1/迭代(1 = SET acc 标量) | ~100,019(O2b) |
| 闭包绑定循环 10 万(t5,#81 后) | 34 | 1,700,021 | **1,000,009** | CLOSURE 捕获 4 + ST vclose 5 + SET 1/迭代 | ~500,009(O2a 纳入 CLOSURE) |
| O0 拷贝密集 10 万 | 46 | 2,000,030 | 2,700,035 | 13+13+1/迭代(B t10 同解) | 无规则命中;O2a 仅一次性 −13 |

**计数口径提醒**:`deepCopy` 计数含标量恒等调用(如 int 的 1 次),故"−13/迭代"中约 9 次是 int 恒等;#81 后 t5 的 ST vclose 5 中也有 3 次是 int 捕获元素恒等。真实收益是**每迭代少分配容器对象**(O2a:struct+Vec / vclose+捕获数组),墙钟收益需 bench 实测,不能按计数比例外推。
