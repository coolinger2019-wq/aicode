# Ming(明)编程语言

> **明**——程序的含义必须和它写出来的一模一样。没有隐式转换,没有 null,没有静默溢出,没有隐藏的控制流。

**语言 / Language:** **中文** · [English](README.en.md) · [中文 · 人话版](README.plain.md)

Ming 是一门为 **AI 与人类协作** 设计的编程语言。它的每一个设计决定都在回答一个问题:*怎样让生成式 AI 更难写出错的代码,更容易被验证?*

## 为什么要有 Ming

AI 写代码的失败模式高度集中:隐式类型转换、真值化、null 传播、静默溢出、别名共享可变状态、忘不掉的分号歧义。人类语言的历史包袱把这些坑全部留给了 AI。Ming 从零开始,把这一整类问题**在语言层面消灭**,并把验证反馈做成机器可消费的协议:

```ming
fn main() with io {
    let name = "世界";
    let mut total = 0;
    for i in 1..11 {
        total += i;
    }
    print("你好, \{name}! 1..11 的和是 \{total}");
}
```

```bash
$ node bin/ming.js run examples/hello.ming
你好, 世界! 1..11 的和是 55

$ node bin/ming.js check examples/hello.ming --json
{ "ok": true, "diagnostics": [] }
```

## 核心特性

| 特性 | 说明 |
|------|------|
| **明确** | 无隐式转换、无 null(用 `Option[T]`)、无真值化、无操作符重载、`mut` 显式声明 |
| **效果系统** | 副作用必须显式声明并逐层传播:`fn f() with io, time { ... }`;纯函数是编译期可证明的 |
| **跨函数契约摘要** | v0.55:纯函数 + 直线体 + 无环调用图上的 `requires`/`ensures` 摘要(被调方优先拓扑序 + 环检测);调用点 requires 可证违反 → M3041,已证后置条件才被调用方假设,链式 ensures 可静态证明;`--proof-report` 输出每函数契约状态与调用点统计(未证明绝不假设)。**v0.57 循环/守卫敏感边界证明**:范围 for 内 `buf[i]` 义务两向证明(半开区间假设入集;脏循环/嵌套/while 保守放弃;义务 additive `scope: body\|loop`;proven 不消除运行时 M4003) |
| **安全** | 整数溢出/除零/越界/缺键全部 panic(可预期、有位置、有错误码);危险能力默认不可达——碰磁盘/网络的代码必须在签名声明 `fs`/`net` 效果 |
| **值语义** | 赋值/传参/捕获都是深拷贝,结构共享不可能发生——没有别名 bug,没有数据竞争 |
| **trait + impl** | 用户类型的方法必须定义在 trait 中;prelude 内置 `Eq` / `ToStr`;泛型 bound `[T: Eq]` 调用处校验 |
| **确定性** | Map 保持插入序、求值顺序从左到右、溢出行为有定义、`ming fmt` 唯一风格 |
| **机器友好** | 所有工具支持 `--json`;稳定诊断码(M1xxx–M4xxx / W3xxx)带 hint;`ming doc` 提取文档 |
| **快速反馈** | `check` 秒级类型检查;内置 `test` 块;`?` 错误传播;模式匹配穷尽性检查 |
| **多引擎** | 默认字节码 VM(含 WASM 分层;**v0.59 覆盖收口**:f64 局部/Map 形参/str 返回/值型 if/块尾 if 真实经 wasm,剩余回落具名;P1 审查修复 `<<` 溢出/M4007 对齐/字面量计费);`--tree` 树遍历对照;`--no-wasm` 纯 VM;同一测试套锁定语义一致;v0.56 起 tree/VM 作用域与捕获闭包一致(881 项全量) |
| **本地函数** | **v0.59 恢复(#44)**:函数体内 `fn` 为块级条目(声明前可调用、递归/互递归、requires/ensures 同模块函数口径、可作值传给 HOF);**四条限制**:不捕获外层局部(M3001)、块级可见、泛型不支持(**M3048**)、C 后端不支持(`语句 FnStmt`);另静态证明面不含本地函数(运行时 M4015 仍执行) |
| **工程化** | ming.toml 项目模式(init/run/build/test)、LSP 服务器(诊断/hover + **v0.58 补全/跳转定义/文档符号**,非 ASCII 字节分帧)、number 快路径、`std.str.join` 单次 O(n) 拼接(v0.58;v0.59 起按结果长度计入 `--max-alloc`) |
| **泛型 impl** | `impl[A: Eq, B: Eq] Eq for Pair[A, B]`;bound 递归校验;Compare trait + Vec.min/max |
| **capability fs** | `std.fs` 文件系统以 fs 效果开放——碰磁盘的代码在签名上自首 |
| **capability net** | `std.net.http_get` / `http_request` 以 net 效果开放;同步 HTTP(worker + Atomics 桥接) |
| **REPL** | `ming repl`:表达式回显、声明持久化、失败回滚、多行续行 |
| **指令融合** | 高频赋值单指令化(读-算-存),溢出检查逐点保留 |
| **FFI(extern fn,`with ffi`)** | `extern "库" fn 符号(...) -> T;` 声明;调用方必须声明 ffi 效果(M3029 门禁);JS 引擎 M4001 诚实拒绝,C 后端 dlopen/dlsym 真调用(失败 M4013);`ming cc --static` 静态链接 |
| **JSON** | 动态 `Json` 类型 + 编译期序列化兼容性检查;parse 错误带位置 |
| **WASM 分层** | i64/u64/f64/str/Vec/Map 编译为 WebAssembly;线性内存统一语义(构造/拷贝/读写/返回);纯 sum ~4x |
| **C 后端 C1/C2/C3/C4/C5** | `ming cc`:eligible 函数 → C(GCC/Clang -O2),资格分析与 wasm 同源;panic 逐字对齐;C2 str/Vec[i64] 值语义;C3 Map/Option/f64 打印(floatStr 对齐);C4 extern fn FFI;**C5 `with unsafe` 受限指针**(Ptr[mut u8]/Ptr[u8] → `unsigned char*`/`const unsigned char*`;std.mem.alloc/free → malloc/free,失败 M4011;extern 槽接受/返回 Ptr);v0.53 `str` for-in 按 **UTF-8 码点**迭代(ASCII/CJK/emoji 与 tree/VM 一致);C 差分腿覆盖已声明 eligible 形态(不支持的语句形态在 C 发射期显式拒绝:报 `C1 不支持该程序形态` 并 exit 1,需另用 JS 引擎运行);纯 sum/fib 场景比 wasm 再快 ~10x |
| **受控不安全(`with unsafe`)** | 效果名 `unsafe` 双门禁:函数签名声明 `with unsafe`(M3029 逐层传播)+ 指针读写/实参/含 Ptr 的容器载荷在 `unsafe { ... }` 块内(M3046);Ptr 仅 u8、方法 load/store/offset/is_null、无索引/算术/打印;仅 C 原生后端执行,tree/VM/wasm 回落以 **M4016** 诚实拒绝(exit 101);悬垂/越界 UB 不捕获(诚实声明) |
| **结构化并发** | `spawn`(多参数)/`spawn_all`(批量)/`join`/`sync scope`(作用域自动 join):确定性并行 |
| **线性句柄** | Join 句柄禁入集合/struct(M3034);trait 方法调用点校验 impl bound |

## 快速开始

需要 Node.js ≥ 18(任何平台:Windows / macOS / Linux)。

```bash
node bin/ming.js run examples/fizzbuzz.ming   # 运行
node bin/ming.js check your.ming --json       # 类型检查(JSON 协议)
node bin/ming.js test your.ming               # 运行 test 块
node bin/ming.js fmt your.ming --write        # 规范格式化
node bin/ming.js doc your.ming                # 提取 /// 文档
node bin/ming.js cc your.ming                 # C 后端:编译为原生可执行(需 gcc/clang)
```

Windows 下也可以用 `bin\ming.cmd`。

编辑器集成:`node bin/ming.js lsp` 启动语言服务器(stdio JSON-RPC;诊断/hover + v0.58 补全/跳转定义/文档符号,消息按 Content-Length 字节分帧)。

## 文档

- **[GUIDE.md](GUIDE.md)** — 使用指南(语法、类型、标准库、工具链、AI 使用建议 + 修订记录)
- **[docs/design.md](docs/design.md)** — 设计哲学与语言规范要点
- **[docs/diagnostics.md](docs/diagnostics.md)** — 稳定诊断码表(M1xxx–M4xxx / W3xxx)
- **[docs/plan.md](docs/plan.md)** — 实施计划(当前 **§4.14 第十二轮**;v0.90–v0.93 候选与 Backlog/已知缺陷跟踪)
- **[docs/capabilities.md](docs/capabilities.md)** — 能力矩阵(55 行口径 ≈85%)
- **[docs/moltbook.md](docs/moltbook.md)** — 社区接入与讨论记录(Moltbook)
- **[AGENTS.md](AGENTS.md)** — AI 代理与本仓库协作的指南(硬规则、命令、提交规范、已知陷阱)
- **[docs/references.md](docs/references.md)** — 参考语言跟踪(Jenny / Blood)
- **[examples/](examples/)** — 可运行的示例程序
- **[README.en.md](README.en.md) / [README.plain.md](README.plain.md)** — 英文版 / 中文人话版(本文件为中文主版)

## 版本历史

> 严格按版本号倒序(最新在前),与 [GUIDE.md](GUIDE.md) 修订记录互为详略:GUIDE 记语言面变化,本表记版本主题。
> 逐版详情默认折叠;完整语言面变更见 GUIDE 修订记录。

| 版本 | 日期 | 主题 | 测试 |
|------|------|------|------|
| v0.98.0 | 2026-11-20 | ADR-011 P0 分析单源化(freenames.js) | 1612 |
| v0.97.0 | 2026-11-20 | P1 #79 修复 + O2.1 设计预研(ADR-010) | 1603 |
| v0.96.0 | 2026-11-20 | O1c 常量传播(pass 4/4;O1 完成) | 1586 |
| v0.95.0 | 2026-11-20 | O1b 通用窥孔(pass 2/4) | 1575 |
| v0.94.0 | 2026-11-20 | O1 字节码优化首批(折叠/裁剪/线程/DCE) | 1566 |
| v0.93.0 | 2026-11-20 | T5.1 跨语言基准对比报告 | 1551 |
| v0.92.0 | 2026-11-20 | C 后端 I/O 面 + O0 优化观测基线 | 1551 |
| v0.91.0 | 2026-11-20 | 工程收口:套件超时隔离 + 支持矩阵 + 文档校验 | 1541 |
| v0.90.0 | 2026-11-19 | 引擎一致性第三波 | 1539 |
| v0.89.0 | 2026-11-19 | 窄型归一同族收口 | 1524 |
| v0.88.0 | 2026-11-19 | 窄型注解遗留边界四项归一扩展 | 1506 |
| v0.87.0 | 2026-11-19 | ADR-009 S2:Slice[u8] 只读视图 + 窄型注解宽度归一 | 1488 |
| v0.86.0 | 2026-11-19 | ADR-009 S1:read_bytes_range 最小流式 | 1456 |
| v0.85.0 | 2026-11-18 | 窄型算术一致性收口 + AI 协作面第三波裁量 | 1441 |
| v0.84.0 | 2026-11-18 | 观测与诚实性复批 | 1405 |
| v0.83.0 | 2026-11-18 | 引擎一致性收尾 | 1398 |
| v0.82.0 | 2026-11-18 | 污点 v1.3 窗口:argv/响应头/metadata 三族翻转 | 1373 |
| v0.81.0 | 2026-11-18 | 引擎一致性小项清账 | 1333 |
| v0.80.0 | 2026-11-18 | AI 协作面第二波:fix 结构化处方扩面 + LSP 多文件补全第一切片 | 1300 |
| v0.79.0 | 2026-11-17 | 健壮性补刀第三刀:缺陷 #71 修复 | 1260 |
| v0.78.0 | 2026-11-17 | 健壮性补刀第二刀:缺陷 #70 修复 | 1251 |
| v0.77.0 | 2026-11-17 | v1.2 内容源扩面 | 1231 |
| v0.76.0 | 2026-11-17 | 健壮性补刀 + fix 处方扩面 | 1186 |
| v0.75.0 | 2026-11-16 | 健壮性收尾:残留裸栈崩溃面全面清零 | 1173 |
| v0.74.0 | 2026-11-16 | 内联汇编 | 1164 |
| v0.73.0 | 2026-11-15 | 技术债与观测收口 | 1141 |
| v0.72.0 | 2026-11-15 | 诊断质量补刀小批 | 1132 |
| v0.71.0 | 2026-11-15 | 诊断残留收口 | 1124 |
| v0.70.0 | 2026-11-15 | 诊断校准二期:#63 parser 级联雪崩抑制 | 1103 |
| v0.69.0 | 2026-11-15 | eval 运行时编译执行 | 1091 |
| v0.68.0 | 2026-11-15 | Untrusted[Json] 载体扩面 | 1066 |
| v0.67.0 | 2026-11-15 | 诊断协议校准/AI 修正回路"自信但错误"收口 | 1049 |
| v0.66.0 | 2026-11-14 | 观测与反馈纯校准版 | 1035 |
| v0.65.0 | 2026-11-14 | wasm 守护收口 slice 3 终章 | 1035 |
| v0.64.0 | 2026-11-14 | 信任边界与诚实失败收口 | 1016 |
| v0.63.0 | 2026-11-14 | wasm 剩余守护收口 slice 2 | 995 |
| v0.62.0 | 2026-11-14 | 服务端 v1 | 967 |
| v0.61.0 | 2026-11-14 | 污点最小片 | 945 |
| v0.60.0 | 2026-11-14 | 资源门禁一致性 | 905 |
| v0.59.0 | 2026-11-13 | 默认引擎全面性:wasm 覆盖收口 + 本地函数恢复 + 记账统一 | 881 |
| v0.58.0 | 2026-11-13 | AI 协作体验与文本工程 | 825 |
| v0.57.0 | 2026-11-13 | 循环/守卫敏感边界证明 | 791 |
| v0.56.0 | 2026-11-12 | 引擎一致性与缺陷清零 | 764 |
| v0.55.0 | 2026-11-12 | 跨函数契约摘要 | — |
| v0.54.0 | 2026-11-12 | `with unsafe` 最小实现 | — |
| v0.53.0 | 2026-11-12 | 可信构建与跨平台验证基线 | — |
| v0.52.0 | 2026-11-12 | QF_LIA 第二片:越界包含静态验证 | — |
| v0.51.6 | 2026-11-12 | 自举工具优化 + 两个语言/工具链 P0 | — |
| v0.51.5 | 2026-11-11 | CLI 边界 | — |
| v0.51.4 | 2026-11-11 | 检查器小缺陷 | — |
| v0.51.3 | 2026-11-11 | C 后端 UB 修复 | — |
| v0.51.2 | 2026-11-11 | 构建可信性 | — |
| v0.51.1 | 2026-11-11 | 契约纯性 + ensures 全路径 | — |
| v0.51 | 2026-11-11 | 效果门禁闭合 | — |
| v0.50.1 | 2026-11-11 | wasm 比较操作码修复 | — |
| v0.50 | 2026-11-11 | 自举工具统一入口 `ming tools` | — |
| v0.49.1 | 2026-11-11 | GCM 最小帧修复 | — |
| v0.49 | 2026-11-11 | ABI 哈希构建缓存 | — |
| v0.48 | 2026-11-11 | QF_LIA 证明子集第一片:M3042 ensures 直线体静态验证 | — |
| v0.47 | 2026-11-11 | 契约阶段 2 完成:mut 方法退出时的 invariant 重查 | — |
| v0.46 | 2026-11-11 | 契约阶段 2 第一步 | — |
| v0.45.1 | 2026-11-11 | tools 检视 | — |
| v0.45 | 2026-11-10 | 契约系统阶段 1 | — |
| v0.44.1 | 2026-11-10 | AI 协作指南 AGENTS.md + 实施计划 + 参考语言跟踪 | — |
| v0.44 | 2026-11-10 | AI 协作护栏 | — |
| v0.43 | 2026-11-10 | ffi 字符串桥 | — |

<details>
<summary><b>展开:逐版详细修订记录(v0.91 → v0.43)</b></summary>

- **v0.98.0** — **ADR-011 P0 分析单源化(零行为;#82 修复第一期)**:collectFreeNames/collectLambdaLocals/addPatNames → src/freenames.js 叶模块(VM plan 与 tree captureEnvFor 单一事实来源);字节码 10 程序×两态逐字节等价;M1 禁令合规(死代码承重勿修,sha256 机械证明);§109 9 check;独立验证 PASS。
- **v0.97.0** — **P1 修复 #79(VM builtin 方法实参不深拷贝;双引擎值语义分歧,HEAD 预存)**+ **O2.1 设计预研**:`v.push(w); w.push(2)` tree 1/2 vs VM 2/2 → 修复=builtin 分派 args.map(deepCopy)(用户方法零双重拷贝);独立验证 21 探针×四腿全绿。ADR-010 拷贝消除设计(freshness 格/O2a·b·c)+ 调研(**270 万 deepCopy 几乎全为标量 no-op;O2 热路径收益≈0;deepCopy 不计 --max-alloc**)——O2 降级待真实 workload;新登记 #80(Vec.slice/filter 返回值浅拷贝)与 #82(树引擎闭包复制 parent 链不完整——递归快照 2^n OOM,审查回退后登记开放 P1;同源 p_flat_80 在 HEAD 亦 OOM)。**并修复第二个 P1 #81**(deepCopy 缺 vclose 分支——闭包绑定/传参别名:tree 1/2/1/0 vs VM 1/2/3/0;修=captures 逐项深拷贝+__retSpec 保真;§108 8 check:绑定/HOF/传参/工厂/容器捕获/__retSpec 窄型/AOT)。**§107 9 + §108 8 check;1603 项 0 失败;fuzz 三种子 ×40 0 分歧**。
- **v0.96.0** — **O1c 常量传播(constPropPass;零新语言面;O1 四 pass 全部交付)**:不可变 let 标量/str 常量 LD→CONST(spanIdx 继承)使下游折叠成链;六放弃锚(SET/ADDI·复合赋值/闭包捕获/形参/窄型归一 ST/容器——`x[0]=99` 不发射 SET 的陷阱靠类型白名单拦截);ST 支配 CFG BFS 证明;实测 cp1 −16.7%/cp2 −27.3%/hello −10.7%(传播后触发全字面量 CONCAT 折叠);§105 两处校准理由化。**§106 11 check;1586 项 0 失败;opt_gate 374 断言;fuzz 三种子 ×40 0 分歧**。
- **v0.95.0** — **O1b 通用窥孔(peepholePass;零新语言面)**:纯值语句 `[CONST|LD][POP]` 双删(跳转目标守卫防 `a && b;` 假标签漏弹)+ 全字面量 CONCAT 折叠(插值不计 --max-alloc 已核实);LD+ST/DUP+ST/`!`反转/相邻 CONST 四项裁决不做并登记;实测纯值语句 −22.2%/全字面量 CONCAT −42.9%/§104 死分支形态 −22.2%;panic 值语句 `1/0;` 两态逐字保留。**§105 9 check;1575 项 0 失败;opt_gate 291 断言;fuzz 三种子 ×40 0 分歧**。
- **v0.94.0** — **O1 字节码优化首批(常量折叠/分支裁剪/跳转线程/DCE;语义保持;默认开,--no-opt/MING_NO_OPT 关)**:编译器在字节码上做常量折叠(不溢出才折:溢出/除零/模零/移位越界保留运行时 panic 逐字)、常量分支裁剪+跳转线程、DCE(JUMP terminal 后死代码真删);**审查 REQUEST_CHANGES 修复后通过**——B1 浮点常量 AOT wire 无损编码(-0.0/NaN/±Inf/1.0e400/const 浮点表达式 dist 与源码逐字;顺带治愈 HEAD 预存 AOT 缺陷)+ M1 str `+` 不折叠(保 --max-alloc 三腿一致)+ m1/m2(构建/工具缓存键含 opt 状态、build --no-opt);opt_gate 187 断言;instr 实测 fib −8.0%/fib_cc −11.8%/filescan −5.2%。**§104 15 check;1566 项 0 失败;fuzz 三种子 ×40 0 分歧**。
- **v0.93.0** — **T5.1 跨语言基准对比(纯测量)**:tests/bench_vs/ 采集 harness(7 任务 × Node 24/Python 3.10.11/C -O2/Ming tree·VM·cc,语义等价四语言实证)+ docs/bench-vs-baselines.md(诚实含输项:HOF/词频慢 Node 21–31×;循环累加快 Python 6.5×;wasm 数值热点与 CPython 同档;启动 ≈ Node;cc 资格面 5/7 N/A 如实)。零语义改动;1551 项 0 失败不变。
- **v0.92.0** — **C 后端 I/O 面 + O0 优化观测**:**T5.2**(print 插值串放行——段类型 str/i64/u64/f64/bool 与 displayStr 逐字节、先求值后输出保序;函数体块尾表达式放行;契约+块尾具名拒绝;C 指纹零变化;hello/fib 三腿逐字;wordcount 三缺口如实具名拒绝)+ **O0 优化观测**(MING_STATS 统计面/bench 扩 5 项基线刷新/opt_gate 44 断言/opt-baseline 优化前基线——拷贝密集 deepCopy 270 万次/10 万迭代实证 O2 靶点)。独立审查 REQUEST_CHANGES(1 MAJOR——f64 负零 -0.0 三腿分歧,ming_float_str 空体死代码已修归一 +0.0;m2 main→i64 块尾退出码 wrapper 丢弃已修;#76 登记)修复后通过。**§103 10 check;1551 项 0 失败;fuzz 三种子 ×40 0 分歧**。
- **v0.91.0** — **工程收口(纯工具/文档面;零语义改动)**:**T4.1 套件超时/隔离**(spawnT 统一出口默认 120s 超时杀树/唯一无界 spawn 补界/102 处分节计时/挂起未复现如实记录;§101 机制自测)+ **T4.3 支持矩阵**(21 形态×5 后端=105 格机器可验证表,harness 即真相源,期望≠实际 exit 1;cc 腿参与)+ **T4.4 docs_check**(5 项 14 断言,首跑即抓三语 README 当前版本漂移并修复)+ **CI docs-and-matrix job**(v53.20 校准理由化:uses 计数→官方白名单)。**§101 2 check;1541 项 0 失败;fuzz 三种子 ×40 0 分歧**。
- **v0.90.0** — **引擎一致性第三波(预存分歧清账;零新增 M 码;无新语言面)**:**#73 AOT struct 相等分歧修复**(valueEquals 同类型判定;wire 不变)+ **tree ctor 作值对齐 VM**(p1_ctor 形态三腿一致)+ **BIND 归一 panic 位置列统一**(tree 向 VM 对齐 3:5→3:9;PIdent 口径;i32/u8 同族)+ **u64 字面量消息未达活复现登记关闭**(架构师 15 探针 + 实现 q1–q24 四腿统一,§100 v100.9–v100.13 锁定)。独立基线审计:纯净副本 31 探针 × 三腿(+AOT)逐字基线(审计脚本一键复跑,集成后对照零漂移)。独立审查 REQUEST_CHANGES（1 MAJOR——VM ctor 分发缺深拷贝：callValue/CALLMETHOD 两处裸引用传 constructVariant，同表达式后置变异形态静默双引擎值分歧——修复 = vm.js 两处 args.map(deepCopy) 对齐 MAKEENUM 先例 + §100 v100.14/15 回归锚（构造点快照 1/2/2、2/3 三腿逐字）；NOTE-1/2 登记 #74/#75、NOTE-3 v100.9 措辞收窄）修复后通过。**§100 15 check;1539 项 0 失败;fuzz 三种子 ×40 0 分歧;proof_fuzz 0 误报**。
- **v0.89.0** — **窄型归一同族收口(零新增 M 码;双引擎对称)**:**Map 值位**(第五同族缺口:规格树 `{kt,vt}`/MapLit 递归/`__valTy` 打标/set·下标写归一;键位守门在 checker,kt-only 资格排除取舍登记)+ **lambda 返回位**(双通道正交:checker 统一回写 `narrowRetSpec`/`narrowParamTypes` + 值标签 `__retSpec` 打标——通道①独立面 checker 合法程序内不可达,纵深防御口径如实)+ **enum payload**(def 驱动构造位归一,VM MAKEENUM 全 6 发射点 normSpecs,artifact wire 兼容)+ **推断型静默面 M1a/M1b**(值标签驱动:bindPattern 窄标签登记/uniformNarrowSpec 统一打标——**fuzz 对该面结构性失明,以定向断言补覆盖**)。审查 APPROVE-with-minor(2 MAJOR 预存登记级:tree ctor 作值 M4001 分歧/绑定归一位置列分歧;5 MINOR 全落实)。**§99 18 check;1524 项 0 失败;fuzz 三种子 ×40 0 分歧;proof_fuzz 0 误报**。
- **v0.88.0** — **窄型注解遗留边界四项归一扩展(规格树声明驱动;零新增 M 码)**:**规格树**(declaredSpecOfTyAst/PatAst/Ty/StructDef + normBindValue 递归 + `__elemTy`/`__spec` 打标)——① struct ctor+字段写 ② Vec 标注初始化/push/元素写 ③ 无标注 lambda 形参(checkLambda 统一回写 `narrowParamTypes`)④ 元组模式绑定——四边界静默回绕收敛 M4002 双引擎对称;**AOT 兼容方案 a**(wire normSpec 序列化 + validateArtifact BIND/ST/SET 界检查);**wasm 资格面扩展**(declHasNarrowLet 匹配 Vec[窄]/元组标注);**独立基线审计**(16 探针纯净副本三腿逐字 0 分歧——标签位驱动异质面) + **fuzz 5 窄型 shape 差分探测器**(突变实验实证抓分歧)。审查 APPROVE-with-minor(放行条件:M1a/M1b 推断型静默面登记 + **#73 预存 AOT struct 相等分歧登记**——poolAdd structspec 不去重→跨构造点 dist 恒 false,worktree 实锤归属 HEAD,均落实)。**§98 18 check;1506 项 0 失败;fuzz 三种子 ×40 0 分歧;proof_fuzz 0 误报**。
- **v0.87.0** — **ADR-009 S2:Slice[u8] 只读视图 + 窄型注解宽度归一(零破坏窗口;零新增 M 码——M3051 新登记)**:**`Slice[u8]`**(ADR-009 §2.2:`v.view(start, len)` 仅非 mut Vec[u8] 绑定;越界 M4003 视图变体三引擎逐字;方法面 len/get/at;**块内线性**——return/容器/传参/再绑定/lambda 块尾与捕获 → M3051[slice-escape] 编译期拒绝;运行时零拷贝 base 同一性白盒;wasm 具名不资格/cc C1;证明面接入延后)+ **窄型注解宽度归一**(let/重赋值/传参/返回四边界按声明类型重标 V.int,tree/VM 双引擎对称——M1 预存语义缺口收口:`let a: i32 = 2147483647; a + 1i32` 从静默收敛为 M4002;wasm 窄型 let 门禁 analyze 具名条款 + clone 纵深防御;**闭包捕获归一三层断裂闭合**——snapshotEnv/deepCopy closure/compileLambda 透传,审查 MAJOR-2 追踪修复)。审查 REQUEST_CHANGES(2 MAJOR 定向修复;事故复核通过)后通过。**§96 18 check + §97 14 check;1488 项 0 失败;fuzz 双种子 0 分歧;proof_fuzz 0 误报**。
- **v0.86.0** — **ADR-009 S1:read_bytes_range 最小流式(零新增 M 码)**:**`std.fs.read_bytes_range(path, start, len) -> Result[Untrusted[Vec[u8]], str]`**——范围读(短读截断合法/负参与越界 Err/`len=0` 短路 Ok 空/校验优先级锁定)、**单次 8MB 上限保留、总量用户循环分段**(rossum 30 帧形态)、计费按实读、同源同污第三载体、仅普通文件;tree/VM 一致、wasm strict none、cc C1 不变;**>8MB 机器证明**(v95.13:12MB+123 两段拼接逐字节;v95.15 短读计费);文档诚实性修正(read_file 无 8MB 上限/write_bytes 单次写入量/内存 780MB 诚实注记/来源全景 9→12 源)。**ADR-009 已落盘**(维护者复核位 §7;S2 Slice v0.87+)。审查 REQUEST_CHANGES(1 MAJOR——补 >8MB 证明;实现零缺陷)修复后通过。**§95 15 check;1456 项 0 失败;fuzz 双种子 0 分歧;proof_fuzz 0 误报**。
- **v0.85.0** — **窄型算术一致性收口 + AI 协作面第三波裁量(零新增 M 码)**:**intBin 窄型 fits 门**(运行时携带窄 bits 值的 `+`/`*`/`/` 快路径补 fits——`127i8+1i8`/`i32::MIN/-1`/u32 溢出从静默回绕收敛为 M4002 三腿逐字;零校准;表述边界=注解不产生窄型运行时值,预存缺口登记 v0.86+)+ **M3013 无损拓宽 fix 族**(快照数据唯一有据族:窄侧 Ident/字面量包 `(x as i64)`,f-probe 0 error,镜像分支锁定,窄结果位边界记录)+ **VM ADDI 两件**(>2^53 合法和 BigInt 回落 / `-=` 消息模板按符号选择,与 tree 逐字)。审查 APPROVE-with-minor(0 BLOCKER;1 预存 MAJOR 登记+表述收窄;3 MINOR/5 NOTE 全落实)。**§93 23 check + §94 13 check;1441 项 0 失败;fuzz 双种子 0 分歧;proof_fuzz 0 误报**。
- **v0.84.0** — **观测与诚实性复批(纯测量/文档为主;零新增 M 码)**:**coverage 复测** 95.0% 行/90.3% 函数(纯净副本插桩 1398 项全绿;vm.js 99.0%/76.2%;死导入裁决不删登记)+ **bench 第 6 项「契约 invariant 字段遍历」**(4 字段/单字段 vm 1.65x、tree 2.08x——亚线性,基线刷新 WARN 0)+ **AI 修正回路快照复测**(24 形态重建,语料入库 tests/ai_loop_corpus/;捕获 91.3% 不变/级联 1.75→1.29/误导 7→0——v0.85 数据链可复跑)+ **fits bits=32 修复**(`1<<(bits-1)`→`2**(bits-1)`:to_i32 恒 None 修复、VM i32 ±1 假 M4002 双引擎分歧同宗收口)+ 文档诚实性批(references 5 处/capabilities 复算/N-66 口径)。审查 REQUEST_CHANGES(2 MAJOR 表述面)修复后通过;新登记 3 项窄型算术预存分歧转 v0.85。**§92 7 check;1405 项 0 失败;fuzz 双种子 0 分歧;proof_fuzz 0 误报**。
- **v0.83.0** — **引擎一致性收尾(无新语言面;零新增 M 码)**:**M4004 消息四引擎统一**(wasm panic_m4004_op TI+18 尾部追加/泛化导入保留;kind 0/1=i64、2/3=u64;cc PZ 去 ctx.specific 门——除零/取模零 × i64/u64 × main/eligible 四引擎首行逐字)+ **#58 cc 残留**(vec_set 表达式级 span + 写 flavor 去读后缀,零校准)+ **#72 缺陷收口**(i32::MIN 取负 tree 曾静默回绕 vs VM M4002——interp number 路径补 signed fits 门覆盖 i8/i16/i32 + vm UN 补 span;v91.9 三腿锁定)+ **取负 tree 位置缺口**(negSlow 补 span,§87 承诺兑现)+ **LSP 占位符过滤**(use x as 回落泄漏 mingLspPlaceholder → 出口过滤)+ **N-60.1/N-61.2 卫生件**(terminate 先于熔断 finally 收割;tryWasm clone 保护 checker sig)。校准:v87.22/v87 neg 解锁/v58.11 三校(c18cc21f…→d60e3c89…)/v91.9 行号(审查 B1)。**§90 16 check + §91 9 check;1398 项 0 失败;fuzz 双种子 ×40 0 分歧;proof_fuzz 0 误报;独立审查 REQUEST_CHANGES(1 BLOCKER——测试断言行号,实现面零问题)修复后通过**。
- **v0.82.0** — **污点 v1.3 窗口:argv/响应头/metadata 三族翻转(ADR-008 清单 12 项;破坏性 minor 一次到位;零新增 M 码)**:**argv = `Vec[Untrusted[str]]`**(元素级;main 净声明 → M3049,不留 clean 旁路;消费 = sanitize_cli_path/parse_i64/内容位保污透传;REPL/test 空参)/ **响应头第四载体 `Untrusted[Map[str,str]]`**(键值同污;投影表 len/is_empty/get/has/keys/values,mut 面 M3050 只读;contains_key→has 偏差登记)/ **fs.metadata = `Untrusted[Json]`**;引擎面零新机制(v80.17(a) 形态保持——元素级解包实测会翻 strict 语义已回滚);**迁移 20 位**(14 工具 + 4 tests + 2 net_e2e parse_i64 端口惯用法;良性路径冒烟逐字节;edit.ming 内容位真实换行缺陷集成期实测修复——esc 污进污出);M3049 remedy 载体感知扩 Map + M3050 白名单第四载体 + M3023 消息翻转。**§88 17 check + §89 23 check;1373 项 0 失败;fuzz 双种子 ×40 0 分歧;proof_fuzz 0 误报;独立审查 APPROVE-with-minor(2 MINOR 全落实 + 8 项架构师登记全收口)**。
- **v0.81.0** — **引擎一致性小项清账(无新语言面;零新增 M 码)**:**M4002 消息四引擎统一(N-65.4 收口,分支 a)**——wasm 溢出检查经新导入 `panic_m4002_op`(TI+17 尾部追加,泛化导入保留旧 AOT 兼容)携带操作数,宿主按 tree/VM 同款模板组消息;架构师顺带收口 cc eligible 泛化残留(cbackend ctx.specific 门拆除)+ 修正 cc main 除法溢出预存偏差(tree 专属模板 `整数除法溢出:a / b`);**tree ContSig/BrkSig 纵深防御**(interp.js brkContGuard → 具名 M4001,v0.79 审查 NOTE-1);**json_query C0 序列化收敛**(27 条 C0 replace 与引擎 jsonWrite 逐字节对齐,良性路径零回归;孤立代理对分歧登记)。校准理由化:v63.37/v39 fn-ovf/v58.11 C 指纹(c62b5c0d…→c18cc21f…);登记不预支:M4004 eligible 泛化分叉/取负 tree 位置缺口/Vec 复合赋值 VM 1 列差。**§86 11 条 + §87 22 条;1333 项 0 失败;fuzz 双种子 ×40 0 分歧;proof_fuzz 0 误报;独立审查 APPROVE-with-minor(4 MINOR 全落实)**。
- **v0.80.0** — **AI 协作面第二波:fix 结构化处方扩面 + LSP 多文件补全第一切片(无新语言面;零新增 M 码——复用既有码面;快照数据驱动 docs/ai-loop-snapshot.md)**:fix 发射族 **4 → 9**(M3015 方法名 nearest 改写——与消息后缀单一来源 methodNearFix/M3006 Json 点字段 → `x.get("f")`/M3004 声明处补 `mut `/M3008 str 拼接标量包 `str(...)`——整值浮点补 `.0` 保值等价/M3012 插值包 `debug(...)`;守卫 = Untrusted 一律拒发(洗白禁令)+ 每族替换域与排除面锚定 + f-probe"应用后必消除"机器证明);LSP 多文件补全第一切片(本地 use 导入成员补全/`use ` 行上下文补全——此前回落通用列表系错补,现仅 `std.<mod>` 全名 + 本地同目录模块名/std as 别名成员验证;保守原则不变,宁可空列表不可错补)。**§84 26 条 + §85 9 条;1300 项 0 失败;fuzz seed 44044×40 0 分歧;proof_fuzz 100 例 0 误报**。独立审查 REQUEST_CHANGES(1 MAJOR + 3 MINOR)修复后通过(MAJOR-1 M3008 整值浮点 fix 值不等价,修复 + v84.26 锁定)。
- **v0.79.0** — **健壮性补刀第三刀:缺陷 #71 修复——lambda 体内 continue/break checker 漏洞(无新语言面;零新增 M 码——M3010/M3011 复用)**:checkLambda 重置 inLoop(lambda 体 = 新函数边界,循环外 continue/break → M3010/M3011;体内自带循环合法)+ compiler 防御分支裸 POP 改具名 CompileError(纵深防御);修复前三态(过拦/tree 吞迭代/VM 崩溃)全部消除。**§82 8 条目 9 check;1260 项 0 失败;fuzz 0 分歧**。
- **v0.78.0** — **健壮性补刀第二刀:缺陷 #70 修复——VM for 内 match 臂 continue 双引擎分歧崩溃(无新语言面)**:for 循环体内 match 臂 `continue` 曾致 VM 引擎 TypeError 进程崩溃(tree 正常——双引擎分歧 P1;plan §5.1 缺陷 #70,v0.77 迁移期发现并登记 v0.78 候选首位;v0.77 自举工具迁移已避开该形态);根因实测定案——match 宗量贯穿臂体留在操作数栈上、Break/Continue 的 JUMP 不清理栈上活临时（for 崩溃/while 每轮泄漏/break 静默泄漏三形态）；修复 = 纯编译器层 matchTemps 词法计数 + 四循环点 breakCtx 快照 + 前置 POP × popN（无 match 形态字节码与 v0.77 逐字节相同）；§81 16 条目 18 check；**1251 项全绿**；fuzz 双种子 0 分歧。**独立审查 APPROVE-with-minor（0 BLOCKER/0 MAJOR——纯净副本逐指令字节码对照：无 match break/continue 逐字节相同）**。
- **v0.77.0** — **v1.2 内容源扩面(fs/net/proc 污点来源 + 污值代数 + 两域接缝;ADR-007 清单 14 项;零新增 M 码——M3049/M3050 复用)**:**来源必污一次到位(签名翻转不留 clean 变体)**——`fs.read_file → Untrusted[str]`、`fs.read_bytes → Untrusted[Vec[u8]]`(**第三载体**,操作面 len/is_empty)、`fs.list_dir → Vec[Untrusted[str]]`、`proc.exec` stdout/stderr → 污 + **cmd/args 命令注入 sink**、`net.http_*` body → 污 + headers sink;env/stdin/extern/serve 不动;**argv 载体 defer v1.3**、assume_clean 不做、`io.read_to_end` 维持净 str(口径差异如实登记)。**污值代数(ADR-007 清单 4,THE CRUX)**:`Untrusted[str]` 操作面 5 → **28 方法**(clean 13 标量/布尔净 + keep 10 保污 + keepVec 2/keepOpt 1 载荷保污 + keepBytes 2;逐函数裁决表 checker `UNTRUSTED_STR_ALGEBRA`)+ `+` 拼接传播(污+净→污)+ 净目标 `+=` 污值 → M3049。**两域接缝闭合(清单 5)**:`json.parse` 载体感知——污 str → `Untrusted[Json]` 污进污出,净 str → 净 Json 逐字不变;污内容直入 eval 的窗口机械关闭(清单 11 零新机制)。**出向透传(清单 6 + 实现期裁决)**:write 家族内容/数据、print/print_raw/eprint 内容参数——污值合法写盘/回显(存储非边界穿越;debug/插值/as/str() 维持禁面);**`std.str.index_of(hay, needle) -> Option[i64]` 新函数**(字符下标含增补平面)。**净化器族不扩**(清单 10)、wasm/C 零新机制(清单 11)。**迁移面**:12 自举工具 23 源/汇位(tools agent:污值代数保污链/路径条目 sanitize_cli_path/回显与落盘透传/engdiff 污 stderr Err 保污)+ examples fs_demo;**验收 = 良性路径逐字节不变**(v0.61 口径):12 工具 52 命令冒烟基线对照 155/156 文件逐字节一致 + 1(ENOENT 系统消息根路径绝对路径差,消息同构);tests §80 21 条 37 check（逐源标污/代数逐类别/接缝双向/透传/exec 双向/eval 关闭/资格中性）；全量 1231 项 0 失败；fuzz 双种子 0 分歧；审查 REQUEST_CHANGES（1 BLOCKER + 2 MAJOR）修复后通过。
- **v0.76.0** — **健壮性补刀 + fix 处方扩面(无新语言面;零新增 M 码——复用既有码面)**:第五崩面收口——**call-arg(调用实参)嵌套纳入深度守卫**(v0.75 RED FLAG 登记项兑现;此前不在 v0.73 表达式深度守卫覆盖内,超限报稳定 M2001"表达式嵌套过深(>120 层)"口径——parsePostfix 三重入点(实参/下标/postfix 字面量链)计入 exprDepth,阈值 120 复用,崩点实测 call/index 253、postfix 链 243,合法边界 118 层存活/119 触发);**fix 结构化处方扩面**——M3002(类型不匹配)族新增 fix 处方(沿 M3049 remedy 先例措辞纪律;污点摘标注旁路守卫),79 码中发射 fix 的族数从 3 → 4(新增 M3002;M2002 另增 eof 收尾发射点)。**1186 项全绿**(§79 13 条);fuzz seed 44044×25 0 分歧、proof_fuzz 0 误报。
- **v0.75.0** — **健壮性收尾:残留裸栈崩溃面全面清零(无新语言面;零新增 M 码,复用 M4005[stack-overflow] 作 check-time 诊断变体——"栈溢出"语义本名,消息分层;plan §4.10)**:四残留崩面收口为稳定诊断——**checker 递归守卫**(checkExpr 单点 try/finally 配对,先例 v0.73 exprDepth;二元/调用/成员/下标链全覆盖,消息"表达式嵌套过深(>N 层);提示:拆分嵌套结构或引入中间绑定")、**lexer 插值嵌套守卫**(scanString 深度计数,超限稳定诊断)、**parseType/parsePattern 深嵌套守卫**(挂点模式同 v0.73 exprDepth，复用 M4005；崩点深一个量级,阈值相应更高)——阈值全部二分实测校准,合法深嵌套不误伤、恢复路径零残留(finally 配对);**深度守卫五域总述**(parser 表达式 120/lexer 插值/checker 递归/parseType/parsePattern;跨机不承诺守卫先于裸崩——GUIDE §22 一处总述)**——健壮性弧线彻底关闭**;顺带 asm 表达式位 hint(v0.74 审查 NOTE-2:`let x = asm {…}` 诊断加专用提示,不再回落 struct 字面量路径误导)。**1173 项全绿(§78 健壮性 9 条——六挂点阈值 450/950/1450/2000/1200 实测二分校准+合法面 32 文件+零残留+asm hint);fuzz 双种子(44044/777)0 分歧。
- **v0.74.0** — **内联汇编——显式能力 `with asm`(北星支柱 2 兑现;ADR-006 12/12 go,维护者需求在案;新码 M4017)**:语法 `asm { 模板字面量+ out/in/clobber }` 仅语句位、全 i64 操作数、out 必须 mut(类型化操作数 GCC 约束模型——不暴露裸寄存器直写);**注入卫生=模板/约束/clobber 字面量强制**(解析层拒绝拼接,值走 gcc 约束机制);**仅 ming cc 真实执行**(C6 旗标)——tree/VM/wasm → M4017[asm-cc-only] panic exit 101 消息逐字(号段复用登记);build 具名回退 + tools probe 排除;syscall 桩形态限 Linux x86-64;可执行内存/ROP/块外跳转明确不做(范围边界);fmt/lsp AsmBlock 配套收口(修复前 fmt --write 静默删块——P1);fuzz 合同不含 asm(§77 专项锁定)。**1164 项全绿**(§77 asm 专项 28 位点 + §76 9 条 + …);fuzz 双种子 0 分歧;proof_fuzz 60 例 0 误报。
- **v0.73.0** — **技术债与观测收口(§4.9 三任务;无新语言面;零新增 M 码)**:解析深嵌套守卫(表达式递归计数器 + 四挂点 try/finally——裸栈 RangeError → 稳定 M2001"表达式嵌套过深(>120 层)",阈值二分实测校准,合法面 10 倍余量)/coverage 基线复测刷新(**94.8% 行 / 89.7% 函数**,vm.js 74.2% 短板分析 + 补测 3 项落地)/GUIDE 交叉引用 15 行 29 引用 + 3 处历史漂移修正。checker 拆分维持 defer、ADR-006 不做(理由 §4.9.2)。**1141 项全绿**(§76 9 条);fuzz 三种子 0 分歧;proof_fuzz 0 误报。
- **v0.72.0** — **诊断质量补刀小批(v0.71 审查 2 MINOR 收口;无新语言面;零新增 M 码)**:if 分支混型 M3049 对称化(checkIf 仿 match 双向接入——混型位接 untrustedMismatchDiag,不再维持 M3002 与 match 不对称,统一净化 hint;直传/双侧污逐字不变)/M3049 remedy 分流(直传位文案逐字不变;复合载体位中性措辞,去"整体改声明"误导)。诊断校准弧线彻底关闭(v0.67→v0.70→v0.71→v0.72);**1132 项全绿**(§75 补刀 8 项);fuzz 双种子 0 分歧。
- **v0.71.0** — **诊断残留收口(§4.8 五任务;无新语言面;零新增 M 码)**:salvage 精化(深度 0 `id(` 停机启发式——被吞区域疑似调用行救回,真实错误恢复报出;锚定语料仍恰 1 条)/valBrace 构造级登记所有权(块入口快照 + 种子层同步递减——伪诊断→真实诊断,s1 伪清零)/嵌套污点 M3049 化五形态(判定翻转 typeContainsUntrusted + callCtor 前置——统一净化 hint;直传/双侧污逐字不变;§65/§66/§71 零校准)/#61 ming test 失败栈位置接线(callSpan 双路径透传 + tree 帧名 `test <名>` 对齐——undefined → file:line:col 三引擎逐字,N-60.4 一并解决)/DX 顺带(N-68 fmt --write 回执、N-67 元组行如实登记无 t.0 下标、N-64 examples/unstr_demo.ming)。独立审查通过(2 MINOR 登记 → v0.72 候选);独立验证 7 项判定零 RED FLAG;**1124 项全绿**(§74 17 项);fuzz 双种子 0 分歧。
- **v0.70.0** — **诊断校准二期:#63 parser 级联雪崩抑制(无新语言面;零新增 M 码)**:语句层 `recover(false)` 改**深度感知 panic-mode 恢复**(`{}` 深度跟踪——失败语句的 `{...}` 区域整体吞掉;`;` 仅深度 0 停机;`}` 深度 0 返回不消费、交还块循环;语句停机表**移除 `test`**——它不是语句关键字而是顶层项关键字,原停机导致同位停住 → 强进 1 token → `ident {` 误解析为结构体字面量引发级联);parseBlock/parseProgram 的 catch 强进路径修复(recover 未前进时强进后继续 recover 到下一语句边界);**1 根因 → 1 条诊断**——锚定语料实测基线 4 条 → 目标 1 条、级联比 11x → 1x,错误 fix"建议加冒号"与顶层级联("顶层不能写 let…"误导)随结构体字面量误解析路径消失;**诚实边界**:失败语句之后到下一语句边界的合法语句一并吞掉(诊断正确性优先于语句 salvage),顶层 recover 行为不变,M2001/M2002 码与消息文本不变、首条 M2001 指向性保留;与 v0.67 的关系——v0.67 收 checker 层毒化收敛,本版收 parser 层级联,诊断校准二期收口;测试 §73(计数收口回填)。
- **v0.69.0** — **eval 运行时编译执行(显式能力 `with eval`,第 12 个效果门禁面;ADR-005 12/12 裁决 go,2026-11-15)+ #65 serve 退出码惯用法文档化**:裸 builtin `eval(src: str) -> Result[str, str]`(效果 `eval`,M3029 逐层传播;零新增 M 码);内层 = 独立编译单元恒 tree 参考实现,全部 M 检查零降级(诊断 `file='<eval>'`,内层缺 main → Err 含 M3023),编译失败/内层 panic/熔断一律 Err 化(`{"ok":false,"diagnostics":[...]}` `--json` 协议同构载荷,外层存活);eval 实参 = 污点 sink(M3049,v1 无授权净化器——"外部输入永不动态执行"由类型系统机械保证);serve handler 内 eval → M3002、契约内 → M3029;配额全量继承按调用重置(循环内 eval 总预算按调用次数放大,GUIDE 窗口登记);per-call 编译无缓存;内层永不 wasm/cc,`ming build` 显式回退源码模式、`ming cc` 发射期拒绝;嵌套 eval 允许;fuzz 合同不含 eval(专项测试 §72)。#65:行为变更否决、采文档化方案——serve 绑定失败返回 Err,是否致命由调用方决定,main 返回 i64 即进程退出码(GUIDE std.net 节运维惯用法 + examples/serve_demo.ming 示范)。
- **v0.68.0** — **Untrusted[Json] 载体扩面(serve 载荷污点保护;ADR-004 14/14 裁决 go;零新增 M 码)**:serve 签名翻转(`handler: fn(Untrusted[Json]) -> Json`)/投影表 14 方法(get·at→Option[Untrusted[Json]] 递归污、as_str→Option[Untrusted[str]]、as_num·as_bool·is_*·eq 净值、as_arr·as_obj 载荷保污)/stringify 拒绝(M3049)/mark_json 标脏入口(净化器族不扩)/hint 载体感知;顺带修复 pre-existing as_obj 键缺陷(#66,双包装——§71.17 三形态回归);迁移 31 处;wasm/C 零改动。审查通过(1 MAJOR 已修 + §71.18 锁定)。
- **v0.67.0** — **诊断协议校准/AI 修正回路"自信但错误"收口(无新语言面;零新增 M 码)**:三切口——毒化收敛双路径(let 初始化器/match 臂绑定值含未解析名→never 收敛,不吞诊断)、M3012 语境化(插值含未解析名时 hint 中性化,探针栈不串味)、M3015 nearest(levenshtein ≤2 建议,排除内置构造器);REPL let 回显 + 横幅版本读 package.json 单一事实来源;顺带修复基线双崩溃(`let x;` 与 patternBrief)。快照复测三判据全达标(误导 7→1/fix 错误 4→0/级联 3.8→1.4)。
- **v0.66.0** — **观测与反馈纯校准版(src 零语义改动;回归 1035 项不变)**:基线刷新 + AI 修正回路快照(docs/ai-loop-snapshot.md)+ serve v1.1 真实服务观察(no-go 推迟)+ Untrusted[Json] ADR 起草——纯测量/文档版本。
- **v0.65.0** — **wasm 守护收口 slice 3 终章(无新语言面;plan §4.5.2)**:五形态真实经 wasm——**expect(字面量 msg)**(msg 经 strConsts 索引穿越导入边界,变量/插值 msg 仍具名守护)、**Map unwrap**(map_has 导入先判定,缺键 → panic_m4006)、**Err unwrap/expect**(objTable 句柄表示 + res_new/res_unwrap 导入族;Err(str/数值标量) display 逐字 `对 Err(...) 调用 unwrap()`/expect 用载荷 .v 插值;容器/结构体/bool 载荷仍具名守护)、**Vec[str] 下标读**(vecstr_get 宿主界检查,越界 M4003 带后缀;元素写登记不做)、**下标复合赋值**(interp assignTo 双重求值口径;标量 &= |= ^= 顺带);**#59 嵌套直调栈帧兑现**(Route E 调用点帧透传 frame_push/pop——main→f→g 三引擎完整 stderr 逐字含 at g 帧回归;代价 wasm 直调 +18% 信息性);**strict 自造语料 18 程序残留 0**(守护具名清单清零,余项 unwrap_or/is_some/is_none shape-eligible 具名回落等全部 strict 具名);新导入 11 条(69→80 尾部追加零错位);**§69 19 项 check、1035 项全绿**;fuzz 双种子 0 分歧;独立审查通过(遮蔽/求值序两 MAJOR 修复:M1 无标注 Result let ReferenceError、M2 expect 求值序 span 差分)。
- **v0.64.0** — **信任边界与诚实失败收口(质量/安全版;plan §4.5.1;零新增 M 码)**:**#56 AOT artifact 结构校验**(validateArtifact:函数/索引/池/跳转面全验——mainFnIdx 越界/functions=[]/负值/坏 opcode 四损坏形态统一稳定诊断"不是 Ming 字节码产物",raw TypeError 消除;33 opcode 全特性探针 + 21 损坏变体 + 工具 AOT 缓存自愈兼容);**S9 嵌套 serve 编译期拒绝**(handler 体内 serve → M3002,两遍式——serveCallNodes 以 checker 真实解析为单一事实来源,遮蔽误伤审查修复);**S12 sanitize_cli_path 闸门扩展**(+DEL/C1/双向控制符,实测关闭 RTL 显示欺骗,代理对不误拒);**#57 安全回归批兑现**(§68 21 项:M4013 专项**首破 0 次记录**/NUL 返回黄金 byte_len=2/四损坏形态/S11 兜底/S13 慢连接);**#58 mut 写 panic 位置三引擎逐字**(compiler SETINDEX span 对齐;cc 侧残留登记);**M5001 补登记**(diag.js 单一事实来源缺口);M3012 hint 现行 ToStr 口径;REPL 横幅对齐;S10"handler 载荷全部不可信"/S11 响应兜底/S15 strlen 截断语义写入 GUIDE;**§68 21 项、1016 项全绿**;fuzz 双种子 0 分歧;独立审查通过(遮蔽误伤 M1 两遍式修复 + S12 向量补齐)。
- **v0.63.0** — **wasm 剩余守护收口 slice 2(五形态真实经 wasm;计费对齐;无新语言面/零新增 M 码)**:Vec 下标读(线性内存 [len][cap][elems],越界→宿主 panic_m4003)/mut Vec 元素写/数值 Vec `get(i).unwrap()` 的 None 分支(panic_m4006)/VecLit 数值元素(与 v0.23 表示统一)/f64 复合赋值(IEEE ±Inf/NaN 不 panic);ming_alloc_elem 计费对齐元素数;panic 栈单层补齐;审查 1 BLOCKER(iscratch 跨表达式复用→五处语句级 tempSlot)修复。
- **v0.62.0** — **服务端 v1(条件交付兑现;ADR-001 16/16 裁决)**:**`std.net.serve(port, handler) -> Result[i64, str]`**(net 效果;worker-per-connection——accept 线程 node:http + 每请求隔离子 worker 复用 syncWorkerCode 管线,连接只是传输;固定 **127.0.0.1** 回环;并发 **16**/FIFO 队列 **256**/体 **8MB**/超时 **30s** terminate 硬杀;请求/响应 Json 载荷 `{method,path,headers,body}`/`{status,headers,body}`;错误体统一 `Json{code,message}`:413 body_too_large/503 queue_full/500 handler_panic·worker_start_failed·response_too_large·internal_error/504 timeout;**accept 线程三层异常护栏**——uncaughtException + safeWrite 写路径包 try + header 键值白名单,杜绝"死服务 = 悬挂");**handler 效果白名单 8**(sync/unsafe/ffi 编译期拒绝;闭包/本地函数/跨模块引用拒绝 M3002;零新增 M 码 = spawn 先例 M3029/M3002/M3005);**三段式拒绝**:tree/VM 真实执行一致、wasm 永不 eligible(strict 具名)、`ming cc` 发射期拒绝;`ming build` net 程序一律源码模式;`--max-ms` 照常生效(长驻服务须显式调大);**顺带修复 wire 顶层 Json 多包外壳潜伏 bug**(spawn 顶层 Json 载荷曾 `j.v.has is not a function`);**§66 22 项 check、967 项全绿**;fuzz 双种子 0 分歧;独立审查 1 BLOCKER(僵尸服务) + 4 MAJOR 全部修复。
- **v0.61.0** — **污点最小片(窄源 v1,安全能力版;ADR-002)**:`Untrusted[str]` 编译期标签/运行时擦除(载体仅 str,四引擎输出与标注无关);来源 = `env.get -> Option[Untrusted[str]]`、`read_line -> Untrusted[str]`、extern 返回强制(裸 `-> str` 声明处 M3049;fs/net/proc 内容源 v1 不标,泄漏窗口如实登记);**sink 门禁免费**(M3049 统一机制 21 槽位 + struct 字段前置);**操作面白名单 5 方法**(parse_i64/parse_f64/char_len/byte_len/is_empty),其余 M3050;**`debug`/插值/`as` 洗白禁面 M3050**;**`std.unstr` 净化族**(`mark`/`sanitize_path`——拒绝绝对路径含 `C:x` 盘符相对、`..` 段、空段,Ok 规范化相对路径/`sanitize_cli_path`——校验不改写:拒 NUL/C0 控制字符,授权位 = 路径实参位 + CLI 匹配串,2026-11-14 裁决);wasm 资格按载体解包(`wasm.js analyze()` 零改动)、C 后端载体穿透(`mingTyNum`/`annoTarget`);**12 自举工具迁移**(8 工具 12 处 env.get 解包位包净化,良性 env 行为与迁移前逐字一致);顺带修复变体构造器 tvar 绑定缺口(`Some(脏)` 曾逃过禁面);新码 **M3049/M3050** 三处登记;**§65 40 条 check、945 项全绿**;fuzz 40 程序 0 分歧、proof_fuzz 0 误报;独立审查 2 MAJOR(C 后端载体穿透缺失、`C:x` 漏判)+ MINOR 全部修复。
- **v0.60.0** — **资源门禁一致性(质量/安全版,无新语言面;2026-11-13 三方评估后范围)**:**#51** wasm 参数搬运计费分歧(`mingAllocRaw` 计费开关;`wasmParamTop` 调用前保存/finally 复位,panic/trap/回落三路径,线性内存随调用复用)、**#52** 外部输入边界计费(read_file 先 stat 按 size 预记账/read_bytes/read_line/read_to_end/list_dir 条目/proc.exec stdout+stderr/http body;**计费 = 值创建 + 外部输入边界,派生值(deepCopy/json.parse/re.*/wasm 搬运)不重复计费**)、**#53** `--max-ms` 阻塞内建钳制(`remainingMs()` + sleep/join/join_detailed/spawn_all/sync scope/exec/http 等待钳制,预算已尽直接 M4012;**read_line/RegExp 进程内不可抢占边界具名**;checkTimeQuota 边界 `>`→`>=`)、**#47** tree 契约求值重入(`execBlock` 仅函数体块尾检查 ensures,ctx `bodyBlock`;`ensures if a>0 {true} else {true}` 三引擎输出 5)、**#54** `ming test` 旗标传播(--tree/--no-wasm/--max-* 与 run 同默认值,双 runTests 路径透传;--strict-wasm 仅互斥仲裁并提示忽略)+ `ming init` CLI 回归。**§64 共 24 项、905 项全绿**;fuzz 40 程序 0 分歧(wasm 真实执行 20)、proof_fuzz 100 例 0 误报;无新诊断码(复用 M4011/M4012);3 名 fresh code-reviewer 独立审查,阻塞项(基类 runTests 漏透传)修复 + v64.B9 锁定,MINOR 5 项落实,latent N-60.1–4 登记。
- **v0.59.0** — **默认引擎全面性:wasm 覆盖收口 + 本地函数恢复 + 记账统一(无新语言面)**:wasm 修复 **#40 locals 索引偏移、#41 Map 形参槽类型、#42 Vec 多形参组合、#43 str 返回 retTy、#45 值型 if blocktype、#46 块尾 unit if**,并收口 **6 个潜伏 bug**(strConsts 空串 / VECMAP VOID 导入 / alloc 导入索引 / map_get 实参顺序 / 移位 64 边界 / 守护回落口径);**宿主补丁**(`map_get_i64`/`vec_get_i64` 返回 BigInt、`wasmWriteVecNum` 认 float)解锁 `Map[str,i64]` 与 `Vec[f64]` 形参;strict 120 语料 **fallback=0**,剩余守护(VecLit/下标/mut/Option)显式回落具名。**本地函数恢复 #44**(M3047 移除):块级条目 + 递归/互递归 + 契约同模块函数口径(M4015)+ 作值 HOF + AOT 产物;三条限制(不捕获外层局部/块级可见/泛型与 cc 不支持)如实写入 GUIDE。**记账统一**:wasm `str_cat` 与 `std.str.join`(#49)按结果长度计费(嵌套 11+15;BMP 口径差异与 `--max-alloc` 内存风险如实登记),插值与 tree/VM 一致不计费。**P3 invariant bench**:`tests/bench.mjs` 新项"契约 invariant 循环"(300,000 次 mut-self 退出 vs 无 invariant 对照)——VM 0.19–0.28µs/次、tree 0.20–0.28µs/次(占循环墙钟 20–27%,高于 5% free 阈值,如实报告),基线含 `invariant.vmUs/treeUs`。**独立审查修复**:P1(`<<` 结果溢出 wasm/C 四引擎 M4002、M4007 消息+位置三引擎逐字、VecLit/MapLit 计费、u64 字面量编码回归)、P2(B1 兄弟 ensures/B2 lambda 引用本地 fn/B3 遮蔽语义定案/B4 导入遮蔽 M3015 + M3009/M3048)、P3(invariant 结论按 5% 判据如实、bench 中位口径)。**§63 共 56 项、881 项全绿**;fuzz 三种子 0 分歧、proof_fuzz 0 误报。
- **v0.58.0** — **AI 协作体验与文本工程(开发者体验版)**:**LSP 三新查询**(补全:标识符/字段方法/模块成员/枚举变体/关键字,保守策略——类型推不出 → 空列表、语法不可修复 → null、注释与字符串内不补全,打字中间态占位修复;跳转定义:模块项/局部绑定/跨文件 use,std 与内置保守 null;文档符号:fn/struct/enum/trait/const + impl 层级;**非 ASCII 消息体按 Content-Length 字节分帧**,坏 JSON 体/空体帧存活不杀会话,块注释内不补全——审查修复回归锁定);**`std.str.join`**(`use std.str;` 纯函数,单次 O(n) 拼接,Builder 方案的最小替代如实记录;`use std.str` 下内建/模块/别名/模块级遮蔽四形态名字解析三引擎逐字 + 遮蔽守卫;**API 不对称与 #49 分配记账差异如实登记**:Vec 方法 join 计费、std join 不计费);**`ming doc --json` 稳定 schema**(六种 kind 含 trait/impl,impl 方法签名含 `with` 效果与 requires/ensures)+ **`--index`** 多文件聚合(默认文本输出逐字不变);**Release 打包**(release.yml:tags `v*` + workflow_dispatch,官方 action,零 npm 依赖校验,artifact `ming-<tag>`,维护者手动创建 Release + docs/release.md);审查修复:坏 JSON 存活/块注释补全/第三式中间态/遮蔽守卫/impl 方法签名契约;§62 共 34 项、**825 项全绿**
- **v0.57.0** — **循环/守卫敏感边界证明(QF_LIA 第四片)+ tools AOT 缓存 + 覆盖率/bench 观测**:范围 for(`for i in lo..hi`)体内 `buf[i]` 义务两向证明——循环变量绑定确定性符号 `i$<n>`,半开区间假设 `lo <= i$<n> < hi` 并入义务假设集(`0 <= i` 由 lo 推出;`buf[i+k]` 位移同口径;空洞区间按假言成立);脏循环(体内重赋值循环变量/改写外层变量/藏分支)、嵌套 for、`while`/`loop`、区间不可线性化一律**保守放弃**;break/continue 不破坏不变式;反例枚举含循环符号(`i$0 = -1`);义务记录 additive `scope: body|loop`;M3045/W3105 码与消息不变,**proven 不消除运行时 M4003**;proof_fuzz 新增 `--mode loops`(200 例 0 误报:可证 100/静默 50/违反 50,反例独立求值器三重验证);**ming tools 工具 AOT 缓存**(12 工具全缓存零回退;键 = VERSION + Node 主版本 + 编译器源指纹 + 工具 basename + 源文本,原子写;span/declSpans 回填 panic 首行/摘录/栈帧逐字对齐;`--json`/`--tree`/strict-wasm 旁路不缓存;损坏自愈;`MING_TOOLS_DEBUG=1` 观测;bin 惰性导入 + enableCompileCache;**热缓存净 ~25–30ms/次——目标 <20ms 未完全达标如实注明**,对无缓存净改进 12–19ms/次);**观测基线**(tests/coverage.mjs 零依赖覆盖率:首个基线 93.0% 行/86.1% 函数 + docs/coverage-baseline.md;bench 基线 tests/bench.baseline.json + Δ基线列 + cc/vm 比值回退 >20% WARN 仍 exit 0 + `--write-baseline`);§61 共 27 项、**791 项全绿**;prover.js 求解器与 codegen 零改动
- **v0.56.0** — **引擎一致性与缺陷清零(质量版,无新语言面)**:tree 作用域模型统一(#23 for-in 遮蔽泄漏 / #28 块作用域泄漏:execBlock 子环境 + for-in/while-let 每迭代内层绑定,tree/VM 逐字一致;tree bench +5–32%,循环项最大——语义修复代价);**VM 捕获闭包 + HOF**(#24 `callClosure` 漏传 `captures` 一行修复);**契约尾部裸标识歧义**(#33 专用解析模式 + struct literal 前瞻);**fmt 契约保真**(#36 P1 数据丢失:requires/ensures/invariant 不再被格式化丢弃,幂等,既有文件零改写;else 插值消息经 `msgRaw` 逐字保留,#39 已修);**wasm 四个严格模式语义修复**(W1 一元负号栈序 / W2 循环内 if 的 break/continue br 深度 / F1 for 体内 continue 跳过自增 / F2 `inferNumType` 重复 case;均 `--strict-wasm` 存活);**fuzz 真实 wasm 腿**(#25 eligible helper + `[wasm] fn OK` 断言,wasm 真实执行计数 20/16/18);**buildKey 编译器源指纹**(#26 `compilerSourceHash` 含 src+bin;敏感性回归覆盖改 `bin/ming.js` → 键变 → 恢复;additive `compiler_hash`);**v0.56 独立审查修复**:契约作用域(B3:body 遮蔽/`result` 绑定/嵌套块)、u64 一元负号 M3008、u64 减法四引擎 M4002、fmt 契约破坏三修(lambda callee 括号/内联块失败不落盘/else 插值消息/空结构体与转义)、#31 按模块身份(abs)去重、**M3047 本地函数显式拒绝**(VM 不再 TypeError);**复审阻塞回归 C1/C2**(ensures 自身作用域基线:match 臂变量/if 块 let 可解析、臂变量词法遮蔽形参;闭包/本地函数 return 不再编译外层 ensures);工具链 #22/#29/#30/#31/#32/#34;§60 共 70 项、**764 项全绿**
- **v0.55.0** — **跨函数契约摘要(QF_LIA 第三片)**:摘要引擎(`src/prover.js` `computeSummaries`:Tarjan SCC 环检测 + 被调方优先拓扑序 + 硬门控——requires 不完整或函数在环上则 ensures 不采用);**调用点线性前置证明**(实参线性形式代入被调 requires,可证违反 → M3041 + 小值反例;反例按调用方 requires 上下文枚举;字面量路径逐字不变);**调用后置条件假设**(被调 requires 完整且当前路径可证才采用其已证 ensures,`result` 绑定每次调用独有 `res$N` 符号;未证明前置条件绝不假设);**M3042 假设集扩展**(本函数 requires + 已验证调用后置,可证假 → M3042 + 反例须满足假设集;不可判定静默,运行时 M4015 保留);`--proof-report` 新增契约摘要(文本 `requires=<完整|不完整|无> ensures=<已证|未证|无> 调用点=<N 可证, M 违反>` + additive `proofs.summaries`(含 `requires_present/ensures_present`);无旗标输出与 v0.54.0 逐字一致);**无新诊断码、codegen 零改动**;`proof_fuzz --mode summaries --count 300` 0 误报/0 假反例;**v0.55.0 独立审查修复 B1–B4/M5–M7/N10**(直线体共享判定阻断分支穿透、短路右侧不作无条件调用点、反例调用方上下文、复合赋值线性转移、摘要 JSON present 字段、下界 requires 反例形态、注入 op 校验)
- **v0.54.0** — **`with unsafe` 最小实现(C5):受控不安全**。效果名 `unsafe` + 双门禁(签名 `with unsafe` → M3029 逐层传播;指针读写/`std.mem`/Ptr 实参/含 Ptr 的容器载荷必须在 `unsafe { ... }` 块内 → M3046);**Ptr[mut u8]/Ptr[u8]**(元素仅 u8、mut 精确匹配、无隐式转换;load/store/offset/is_null 四方法;索引/算术/==/插值/打印/debug/JSON/Map 键/as 全部静态拒绝);**std.mem.alloc/free**(malloc 失败 **M4011** 不伪装 null);**C5 后端**(Ptr → `unsigned char*`/`const unsigned char*`、alloc/free → malloc/free、extern 槽接受/返回 Ptr、非 unsafe 程序 C 输出逐字不变);tree/VM 在 std.mem/Ptr 面以 **M4016** panic(消息"unsafe 指针操作仅在 C 原生后端可用",exit 101;wasm 回落 VM 同码);`ming build` 遇 `with unsafe` 显式回退源码模式;Ptr 值语义例外(拷贝地址本身,别名可见)与悬垂/越界 UB 不捕获(GUIDE §14.1 诚实声明);§58 共 20 项(含独立审查 B1–B5 回归:unsafe 控制流、C 作用域、载荷逃逸、闭包效果、`use std.x` 短名)
- **v0.53.0** — **可信构建与跨平台验证基线**:GitHub Actions CI 矩阵(Linux/macOS/Windows × Node 18/20/22 九组合 + C 腿 ubuntu/macos + nightly 三种子深模糊;只用官方 action,零 npm 依赖);**strict-wasm 三态**(`--strict-wasm` / `MING_WASM_STRICT=1`;`run --json` additive `wasm_status: none|ok|fallback`;fallback → exit 2 并点名原因,与 `--tree`/`--no-wasm` 互斥);**构建键修复**(`collectProjectSources` 项目相对路径 + 内容 + Node 主版本;`build --json` 带 `build_key/dist_hash/cache_hit/source_count/interface_hashes`;承诺同 OS + 同 Node 主版本可复现 dist_hash);**env -i launcher 验收**(最小环境/异地 dist/参数与 panic 首行逐字一致);**C 后端 `str` for-in 按 UTF-8 码点迭代**(ASCII/CJK/emoji:tree / VM / VM-only / cc 一致;该形态 wasm 回落);**修复尾表达式函数的 wasm 模块校验回落**(strict 暴露:函数级补零多压栈导致整模块无效);**独立审查修复**(check strict fallback 保留 diagnostics/proofs 且 ok:false、C 后端 for-in 遮蔽作用域、wasm `/` 守卫 opcode、`--no-wasm` 不报 wasm_status、回落点名函数、`build --json` stdout 纯 JSON、CI 示例 fib strict 步)
- **v0.52.0** — **QF_LIA 第二片:越界包含静态验证(只证明,不改 codegen)**:prover.js 抽出(线性形式代数 + 差分约束 Bellman-Ford 负环求解);requires 线性边界下对每个 `buf[i]` 义务两向证明 `0 <= i && i < len$buf`——可证违反 → **M3045**(含小值反例),未证明默认静默(`--warn-unproven-index` 下 W3105);`--proof-report` 逐函数证明统计(文本/additive proofs JSON);循环/别名/非线性/mut Vec/无 requires 一律静默;**proven 不消除运行时 M4003**;tests/proof_fuzz.mjs(0 误报 + 反例独立求值器验证)
- **v0.51.6** — **自举工具优化 + 两个语言/工具链 P0**:9 个工具错误走 stderr、失败退出 1;wc 多文件、json_query 点路径、diaghot 目录展开+`--top`、batch_rename 幂等、tree 深度、`ming tools --` 透传;修复 VM 复合赋值窥孔(`x += N`(N≠1)误融 ±1,自举工具暴露)与 fmt 两处缺陷(if 表达式崩溃、else-if 悬挂非幂等),12 个工具全部 fmt 规范
- **v0.51.5** — **CLI 边界**:项目模式 `--` 参数透传、`-o` 短旗标、值旗标缺值/非整数硬报错——代码审查 16 项全部修复
- **v0.51.4** — **检查器小缺陷**:访问器返回值语义副本、while let 恢复、元组穷尽性、泛型 arity 的 ReferenceError、Map 键类型 M3044
- **v0.51.3** — **C 后端 UB 修复**:f64 大整数打印(%.1f)、符号扩展窄截断(ming_sext)、空模式 replace/pad 码点语义、trim 移除 ZWSP
- **v0.51.2** — **构建可信性**:AOT 产物纯 wire 化(无 AST/绝对路径泄漏)+ 源码回退复制全部模块 + 缓存内容哈希校验 + 接口哈希修正 + 非产物 dist 守卫
- **v0.51.1** — **契约纯性 + ensures 全路径**:M3043 禁止契约内 mut 方法;`?` 早退/嵌套 return 双引擎都执行 ensures;`--json` 增加 engine/wasm 字段
- **v0.51** — **效果门禁闭合**:函数类型携带 effects,`let g = noisy; g()` / 传参 / lambda 不再绕过 M3029(M3002 显示 `with io`)
- **v0.50.1** — **wasm 比较操作码修复(P0)**:i64/f64 的 `<=`/`>=` 静默算错与 f64 模块整体回落修复;`--no-wasm` 恢复真 VM 路由——代码审查触发
- **v0.50** — **自举工具统一入口 `ming tools`**:patch/edit/diff/diag/wc/tree/... 缩短为一条命令(进程内路由,工具本体仍是 Ming);`--list` 命令表——把自举工具从"验证用"变成日用
- **v0.49.1** — **GCM 最小帧修复**(28B 而非 44B:短/空明文往返恢复;27B/12B 截断拒绝)+ nonce 唯一性回归 + nonce 管理指引——社区反馈(diviner)触发的边界测试
- **v0.49** — **ABI 哈希构建缓存**:`ming build` 内容寻址缓存(键未变且 dist 完整 → 跳过检查+编译)+ 每模块**接口哈希**报告(改实现不改接口 → 哈希稳定,ABI 防火墙可观测)+ `--clean-cache`——CI 与 AI 自愈循环提速(plan.md §4b 兑现)
- **v0.48** — **QF_LIA 证明子集第一片:M3042 ensures 直线体静态验证**(可证假 → 编译期反例;不可判定静默,运行时 M4015 保留)——决策依据 bench 实测(plan.md §4.1)
- **v0.47** — **契约阶段 2 完成:mut 方法退出时的 invariant 重查**(树/VM 一致)——invariant 在每个可观测状态变更点都被检查(构造/外部写/方法退出)
- **v0.46** — **契约阶段 2 第一步**:M3040 invariant 字段封装 + M3041 调用点静态契约校验(字面量实参编译期反例)+ 修复 invariant struct + impl 的检查器崩溃;AGENTS.md 协作指南 + 12 个自举工具
- **v0.45.1** — **tools 检视(工具全实测 + edit 新工具)+ 修复 v0.45.0 交付缺陷**
- **v0.45** — **契约系统阶段 1**(requires/ensures 运行时检查,VM+树引擎一致,M4015;invariant 语法支持)
- **v0.44.1** — **AI 协作指南 AGENTS.md + 实施计划 + 参考语言跟踪**
- **v0.44** — **AI 协作护栏**(W3104 测试字面量过拟合检查 + `--json` 结构化修复处方 fix + tools/diaghot.ming 诊断热力图)+ **mask 效果屏蔽设计定稿**(design.md §6.11)——受 Jenny/Blood 调研启发;连带修复 unify 缺 json 分支、VM match-return 栈残留两项真实 bug
- **v0.43** — **ffi 字符串桥(str ↔ C 串)+ Result[i64,str] 进 C 面 + ffi 效果函数参与 C 编译**(资格基线修正:opt/res 形参入形状面;prelude 构造器不再误降级不动点)+ `with unsafe` 受限指针块设计定稿(design.md §6.10)
*（本版同时并入另一窗口成果:真 AOT 字节码产物——ming build 默认纯字节码 dist,无明文源;--with-source 附源码;spawn/trait 自动回退源码模式。**源码回退面如实登记**:含 `test` 块的程序也回退源码模式(dist 含明文源),AOT test 块支持待评估——plan §5.1 N-66）*

</details>

## 计划状态

当前规划:**§4.15 第十三轮(2026-11-19)**——评估驱动的收口任务单(全文见 [docs/plan.md](docs/plan.md));§4.14 的 v0.90 内容并入 T2.1,§4.14.5 版本路线被 §4.15.5 取代。

- **T1 核心命题对照实验**(P1,独立并行):12–16 任务 × Ming/TypeScript/Python——预注册指标(首次通过率/缺陷数/修复轮次/token),三态结论(不支持也发布)
- **T2 冻结语言面 → 1.0-rc**(P1):v0.90 引擎一致性第三波(#73 AOT struct 相等 / tree ctor 作值 / 位置列 / u64 消息)→ 冻结令 → 稳定性契约 → 1.0-rc 准入清单;LSP 第二切片 / Option·Result / 窄型 DX 转入冻结期后
- **T3 真实场景试点**(P2):日志取证 / 协议解析 / 内网 agent 服务 / 文件完整性(3–5 个,无先验用户验收)
- **T4 工程收口**(P1/P2):测试套件超时隔离 / 支持矩阵 + CI 抽查 / 文档数字漂移校验;checker 拆分冻结期后
- **T5 性能与分发**(P2):基准对比诚实发布(含输的项)/ C 后端 I/O 面 hello 级完整 / 分发决策
- **T6 编译器级优化**(§4.16,独立并行):先测量(O0 统计面 + bench 扩面 + opt on/off 闸门)→ O1 常量折叠/DCE/窥孔 → O2 拷贝消除 → O3 VM 内联缓存 → O4 C 后端;O5 内联/强度削减默认不做(panic 栈合同);**自举编译器维持门控 G1–G6**
- **版本路线**:v0.90 T2.1 → v0.91 T4.1/T4.3/T4.4 → v0.92 T5.1/T5.2 → v0.93 T2.3/T2.4;O0 即启,O1 v0.94+;自举编译器门控见 plan §4.16.6
- **不做(维持)**:热重载 / 可执行内存·ROP / 净化器族扩张 / 归一架构合并重构(三通道判定等价已实测,GUIDE 文档化替代)

ADR 索引:ADR-001 serve · ADR-002 污点 · ADR-004 Untrusted[Json] · ADR-005 eval · ADR-006 内联汇编 · ADR-007 内容源扩面 · ADR-008 污点 v1.3 · ADR-009 流式·Slice(见 `docs/adr-*.md`)。

## 设计原则(全文见 design.md)

1. **明确优于简洁** —— 写出来的就是全部含义。
2. **安全是默认,不是选项** —— 危险操作要么被检查,要么 panic,绝不静默。
3. **副作用可见** —— 效果签名说明一切:没标 `io` 的函数不可能打印,编译器保证。
4. **确定性** —— 同样的代码永远产生同样的行为(包括迭代顺序)。
5. **为验证循环优化** —— AI 的核心工作方式是"生成 → 检查 → 修正",工具链必须为这个循环服务。
6. **没有第二种写法** —— 一种结构一个语法,`ming fmt` 是唯一风格。

## 状态

| 项 | 值 |
|----|----|
| 当前版本 | **v0.98.0**(2026-11-20) |
| 回归测试 | **1612 项全绿**(§1–§109;每次全量运行) |
| 差分模糊 | fuzz 三种子(44044/777/20261)×40——0 分歧;proof_fuzz 100 例 0 误报 |
| 覆盖率 | **95.1% 行 / 90.9% 函数**(v0.96 复测 2026-11-20;16 文件含 opt.js 99.3%/100%;vm.js 函数 76.6%) |
| 自举工具 | **14 个**(Ming 自写;`ming tools` 统一入口) |
| 能力矩阵 | 55 行 ≈85%([docs/capabilities.md](docs/capabilities.md)) |
| 运行要求 | Node.js ≥ 18,零第三方依赖;C 后端需 gcc/clang |
| 构建产物 | `ming build` AOT 字节码(内容寻址缓存);`ming cc` C 原生可执行 |

下一步:**v0.90 引擎一致性第三波(T2.1)**,随后按 §4.15 收口任务单推进(见 [docs/plan.md](docs/plan.md))。
