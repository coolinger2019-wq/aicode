# Ming(明)编程语言

> **明**——程序的含义必须和它写出来的一模一样。没有隐式转换,没有 null,没有静默溢出,没有隐藏的控制流。

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

## 核心特性(v0.59)

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

- **[AGENTS.md](AGENTS.md)** — AI 代理与本仓库协作的指南(硬规则、命令、提交规范、已知陷阱)
- **[docs/plan.md](docs/plan.md)** — 实施计划(v0.52–v0.59 已交付;Backlog 与已知缺陷跟踪:v0.59 已收口 #40–#46/#48/#49,仅余 #47(tree 契约求值重入,P3))
- **[docs/references.md](docs/references.md)** — 参考语言跟踪(Jenny / Blood 的地址、要点与进度查看方式)
- **[GUIDE.md](GUIDE.md)** — 使用指南(语法、类型、标准库、工具链、AI 使用建议)
- **[docs/design.md](docs/design.md)** — 设计哲学与语言规范要点
- **[docs/diagnostics.md](docs/diagnostics.md)** — 稳定诊断码表
- **[examples/](examples/)** — 可运行的示例程序

## 路线图

- **v0.43** — **ffi 字符串桥(str ↔ C 串)+ Result[i64,str] 进 C 面 + ffi 效果函数参与 C 编译**(资格基线修正:opt/res 形参入形状面;prelude 构造器不再误降级不动点)+ `with unsafe` 受限指针块设计定稿(design.md §6.10)
*（本版同时并入另一窗口成果:真 AOT 字节码产物——ming build 默认纯字节码 dist,无明文源;--with-source 附源码;spawn/trait 自动回退源码模式）*
- **v0.44** — **AI 协作护栏**(W3104 测试字面量过拟合检查 + `--json` 结构化修复处方 fix + tools/diaghot.ming 诊断热力图)+ **mask 效果屏蔽设计定稿**(design.md §6.11)——受 Jenny/Blood 调研启发;连带修复 unify 缺 json 分支、VM match-return 栈残留两项真实 bug
- **v0.45** — **契约系统阶段 1**(requires/ensures 运行时检查,VM+树引擎一致,M4015;invariant 语法支持)
- **v0.46** — **契约阶段 2 第一步**:M3040 invariant 字段封装 + M3041 调用点静态契约校验(字面量实参编译期反例)+ 修复 invariant struct + impl 的检查器崩溃;AGENTS.md 协作指南 + 12 个自举工具
- **v0.47** — **契约阶段 2 完成:mut 方法退出时的 invariant 重查**(树/VM 一致)——invariant 在每个可观测状态变更点都被检查(构造/外部写/方法退出)
- **v0.48** — **QF_LIA 证明子集第一片:M3042 ensures 直线体静态验证**(可证假 → 编译期反例;不可判定静默,运行时 M4015 保留)——决策依据 bench 实测(plan.md §4.1)
- **v0.49** — **ABI 哈希构建缓存**:`ming build` 内容寻址缓存(键未变且 dist 完整 → 跳过检查+编译)+ 每模块**接口哈希**报告(改实现不改接口 → 哈希稳定,ABI 防火墙可观测)+ `--clean-cache`——CI 与 AI 自愈循环提速(plan.md §4b 兑现)
- **v0.49.1** — **GCM 最小帧修复**(28B 而非 44B:短/空明文往返恢复;27B/12B 截断拒绝)+ nonce 唯一性回归 + nonce 管理指引——社区反馈(diviner)触发的边界测试
- **v0.50** — **自举工具统一入口 `ming tools`**:patch/edit/diff/diag/wc/tree/... 缩短为一条命令(进程内路由,工具本体仍是 Ming);`--list` 命令表——把自举工具从"验证用"变成日用
- **v0.50.1** — **wasm 比较操作码修复(P0)**:i64/f64 的 `<=`/`>=` 静默算错与 f64 模块整体回落修复;`--no-wasm` 恢复真 VM 路由——代码审查触发
- **v0.51** — **效果门禁闭合**:函数类型携带 effects,`let g = noisy; g()` / 传参 / lambda 不再绕过 M3029(M3002 显示 `with io`)
- **v0.51.1** — **契约纯性 + ensures 全路径**:M3043 禁止契约内 mut 方法;`?` 早退/嵌套 return 双引擎都执行 ensures;`--json` 增加 engine/wasm 字段
- **v0.51.2** — **构建可信性**:AOT 产物纯 wire 化(无 AST/绝对路径泄漏)+ 源码回退复制全部模块 + 缓存内容哈希校验 + 接口哈希修正 + 非产物 dist 守卫
- **v0.51.3** — **C 后端 UB 修复**:f64 大整数打印(%.1f)、符号扩展窄截断(ming_sext)、空模式 replace/pad 码点语义、trim 移除 ZWSP
- **v0.51.4** — **检查器小缺陷**:访问器返回值语义副本、while let 恢复、元组穷尽性、泛型 arity 的 ReferenceError、Map 键类型 M3044
- **v0.51.5** — **CLI 边界**:项目模式 `--` 参数透传、`-o` 短旗标、值旗标缺值/非整数硬报错——代码审查 16 项全部修复
- **v0.51.6** — **自举工具优化 + 两个语言/工具链 P0**:9 个工具错误走 stderr、失败退出 1;wc 多文件、json_query 点路径、diaghot 目录展开+`--top`、batch_rename 幂等、tree 深度、`ming tools --` 透传;修复 VM 复合赋值窥孔(`x += N`(N≠1)误融 ±1,自举工具暴露)与 fmt 两处缺陷(if 表达式崩溃、else-if 悬挂非幂等),12 个工具全部 fmt 规范
- **v0.52.0** — **QF_LIA 第二片:越界包含静态验证(只证明,不改 codegen)**:prover.js 抽出(线性形式代数 + 差分约束 Bellman-Ford 负环求解);requires 线性边界下对每个 `buf[i]` 义务两向证明 `0 <= i && i < len$buf`——可证违反 → **M3045**(含小值反例),未证明默认静默(`--warn-unproven-index` 下 W3105);`--proof-report` 逐函数证明统计(文本/additive proofs JSON);循环/别名/非线性/mut Vec/无 requires 一律静默;**proven 不消除运行时 M4003**;tests/proof_fuzz.mjs(0 误报 + 反例独立求值器验证)
- **v0.53.0** — **可信构建与跨平台验证基线**:GitHub Actions CI 矩阵(Linux/macOS/Windows × Node 18/20/22 九组合 + C 腿 ubuntu/macos + nightly 三种子深模糊;只用官方 action,零 npm 依赖);**strict-wasm 三态**(`--strict-wasm` / `MING_WASM_STRICT=1`;`run --json` additive `wasm_status: none|ok|fallback`;fallback → exit 2 并点名原因,与 `--tree`/`--no-wasm` 互斥);**构建键修复**(`collectProjectSources` 项目相对路径 + 内容 + Node 主版本;`build --json` 带 `build_key/dist_hash/cache_hit/source_count/interface_hashes`;承诺同 OS + 同 Node 主版本可复现 dist_hash);**env -i launcher 验收**(最小环境/异地 dist/参数与 panic 首行逐字一致);**C 后端 `str` for-in 按 UTF-8 码点迭代**(ASCII/CJK/emoji:tree / VM / VM-only / cc 一致;该形态 wasm 回落);**修复尾表达式函数的 wasm 模块校验回落**(strict 暴露:函数级补零多压栈导致整模块无效);**独立审查修复**(check strict fallback 保留 diagnostics/proofs 且 ok:false、C 后端 for-in 遮蔽作用域、wasm `/` 守卫 opcode、`--no-wasm` 不报 wasm_status、回落点名函数、`build --json` stdout 纯 JSON、CI 示例 fib strict 步)
- **v0.54.0** — **`with unsafe` 最小实现(C5):受控不安全**。效果名 `unsafe` + 双门禁(签名 `with unsafe` → M3029 逐层传播;指针读写/`std.mem`/Ptr 实参/含 Ptr 的容器载荷必须在 `unsafe { ... }` 块内 → M3046);**Ptr[mut u8]/Ptr[u8]**(元素仅 u8、mut 精确匹配、无隐式转换;load/store/offset/is_null 四方法;索引/算术/==/插值/打印/debug/JSON/Map 键/as 全部静态拒绝);**std.mem.alloc/free**(malloc 失败 **M4011** 不伪装 null);**C5 后端**(Ptr → `unsigned char*`/`const unsigned char*`、alloc/free → malloc/free、extern 槽接受/返回 Ptr、非 unsafe 程序 C 输出逐字不变);tree/VM 在 std.mem/Ptr 面以 **M4016** panic(消息"unsafe 指针操作仅在 C 原生后端可用",exit 101;wasm 回落 VM 同码);`ming build` 遇 `with unsafe` 显式回退源码模式;Ptr 值语义例外(拷贝地址本身,别名可见)与悬垂/越界 UB 不捕获(GUIDE §14.1 诚实声明);§58 共 20 项(含独立审查 B1–B5 回归:unsafe 控制流、C 作用域、载荷逃逸、闭包效果、`use std.x` 短名)
- **v0.55.0** — **跨函数契约摘要(QF_LIA 第三片)**:摘要引擎(`src/prover.js` `computeSummaries`:Tarjan SCC 环检测 + 被调方优先拓扑序 + 硬门控——requires 不完整或函数在环上则 ensures 不采用);**调用点线性前置证明**(实参线性形式代入被调 requires,可证违反 → M3041 + 小值反例;反例按调用方 requires 上下文枚举;字面量路径逐字不变);**调用后置条件假设**(被调 requires 完整且当前路径可证才采用其已证 ensures,`result` 绑定每次调用独有 `res$N` 符号;未证明前置条件绝不假设);**M3042 假设集扩展**(本函数 requires + 已验证调用后置,可证假 → M3042 + 反例须满足假设集;不可判定静默,运行时 M4015 保留);`--proof-report` 新增契约摘要(文本 `requires=<完整|不完整|无> ensures=<已证|未证|无> 调用点=<N 可证, M 违反>` + additive `proofs.summaries`(含 `requires_present/ensures_present`);无旗标输出与 v0.54.0 逐字一致);**无新诊断码、codegen 零改动**;`proof_fuzz --mode summaries --count 300` 0 误报/0 假反例;**v0.55.0 独立审查修复 B1–B4/M5–M7/N10**(直线体共享判定阻断分支穿透、短路右侧不作无条件调用点、反例调用方上下文、复合赋值线性转移、摘要 JSON present 字段、下界 requires 反例形态、注入 op 校验)
- **v0.56.0** — **引擎一致性与缺陷清零(质量版,无新语言面)**:tree 作用域模型统一(#23 for-in 遮蔽泄漏 / #28 块作用域泄漏:execBlock 子环境 + for-in/while-let 每迭代内层绑定,tree/VM 逐字一致;tree bench +5–32%,循环项最大——语义修复代价);**VM 捕获闭包 + HOF**(#24 `callClosure` 漏传 `captures` 一行修复);**契约尾部裸标识歧义**(#33 专用解析模式 + struct literal 前瞻);**fmt 契约保真**(#36 P1 数据丢失:requires/ensures/invariant 不再被格式化丢弃,幂等,既有文件零改写;else 插值消息经 `msgRaw` 逐字保留,#39 已修);**wasm 四个严格模式语义修复**(W1 一元负号栈序 / W2 循环内 if 的 break/continue br 深度 / F1 for 体内 continue 跳过自增 / F2 `inferNumType` 重复 case;均 `--strict-wasm` 存活);**fuzz 真实 wasm 腿**(#25 eligible helper + `[wasm] fn OK` 断言,wasm 真实执行计数 20/16/18);**buildKey 编译器源指纹**(#26 `compilerSourceHash` 含 src+bin;敏感性回归覆盖改 `bin/ming.js` → 键变 → 恢复;additive `compiler_hash`);**v0.56 独立审查修复**:契约作用域(B3:body 遮蔽/`result` 绑定/嵌套块)、u64 一元负号 M3008、u64 减法四引擎 M4002、fmt 契约破坏三修(lambda callee 括号/内联块失败不落盘/else 插值消息/空结构体与转义)、#31 按模块身份(abs)去重、**M3047 本地函数显式拒绝**(VM 不再 TypeError);**复审阻塞回归 C1/C2**(ensures 自身作用域基线:match 臂变量/if 块 let 可解析、臂变量词法遮蔽形参;闭包/本地函数 return 不再编译外层 ensures);工具链 #22/#29/#30/#31/#32/#34;§60 共 70 项、**764 项全绿**
- **v0.57.0** — **循环/守卫敏感边界证明(QF_LIA 第四片)+ tools AOT 缓存 + 覆盖率/bench 观测**:范围 for(`for i in lo..hi`)体内 `buf[i]` 义务两向证明——循环变量绑定确定性符号 `i$<n>`,半开区间假设 `lo <= i$<n> < hi` 并入义务假设集(`0 <= i` 由 lo 推出;`buf[i+k]` 位移同口径;空洞区间按假言成立);脏循环(体内重赋值循环变量/改写外层变量/藏分支)、嵌套 for、`while`/`loop`、区间不可线性化一律**保守放弃**;break/continue 不破坏不变式;反例枚举含循环符号(`i$0 = -1`);义务记录 additive `scope: body|loop`;M3045/W3105 码与消息不变,**proven 不消除运行时 M4003**;proof_fuzz 新增 `--mode loops`(200 例 0 误报:可证 100/静默 50/违反 50,反例独立求值器三重验证);**ming tools 工具 AOT 缓存**(12 工具全缓存零回退;键 = VERSION + Node 主版本 + 编译器源指纹 + 工具 basename + 源文本,原子写;span/declSpans 回填 panic 首行/摘录/栈帧逐字对齐;`--json`/`--tree`/strict-wasm 旁路不缓存;损坏自愈;`MING_TOOLS_DEBUG=1` 观测;bin 惰性导入 + enableCompileCache;**热缓存净 ~25–30ms/次——目标 <20ms 未完全达标如实注明**,对无缓存净改进 12–19ms/次);**观测基线**(tests/coverage.mjs 零依赖覆盖率:首个基线 93.0% 行/86.1% 函数 + docs/coverage-baseline.md;bench 基线 tests/bench.baseline.json + Δ基线列 + cc/vm 比值回退 >20% WARN 仍 exit 0 + `--write-baseline`);§61 共 27 项、**791 项全绿**;prover.js 求解器与 codegen 零改动
- **v0.58.0** — **AI 协作体验与文本工程(开发者体验版)**:**LSP 三新查询**(补全:标识符/字段方法/模块成员/枚举变体/关键字,保守策略——类型推不出 → 空列表、语法不可修复 → null、注释与字符串内不补全,打字中间态占位修复;跳转定义:模块项/局部绑定/跨文件 use,std 与内置保守 null;文档符号:fn/struct/enum/trait/const + impl 层级;**非 ASCII 消息体按 Content-Length 字节分帧**,坏 JSON 体/空体帧存活不杀会话,块注释内不补全——审查修复回归锁定);**`std.str.join`**(`use std.str;` 纯函数,单次 O(n) 拼接,Builder 方案的最小替代如实记录;`use std.str` 下内建/模块/别名/模块级遮蔽四形态名字解析三引擎逐字 + 遮蔽守卫;**API 不对称与 #49 分配记账差异如实登记**:Vec 方法 join 计费、std join 不计费);**`ming doc --json` 稳定 schema**(六种 kind 含 trait/impl,impl 方法签名含 `with` 效果与 requires/ensures)+ **`--index`** 多文件聚合(默认文本输出逐字不变);**Release 打包**(release.yml:tags `v*` + workflow_dispatch,官方 action,零 npm 依赖校验,artifact `ming-<tag>`,维护者手动创建 Release + docs/release.md);审查修复:坏 JSON 存活/块注释补全/第三式中间态/遮蔽守卫/impl 方法签名契约;§62 共 34 项、**825 项全绿**
- **v0.59.0** — **默认引擎全面性:wasm 覆盖收口 + 本地函数恢复 + 记账统一(无新语言面)**:wasm 修复 **#40 locals 索引偏移、#41 Map 形参槽类型、#42 Vec 多形参组合、#43 str 返回 retTy、#45 值型 if blocktype、#46 块尾 unit if**,并收口 **6 个潜伏 bug**(strConsts 空串 / VECMAP VOID 导入 / alloc 导入索引 / map_get 实参顺序 / 移位 64 边界 / 守护回落口径);**宿主补丁**(`map_get_i64`/`vec_get_i64` 返回 BigInt、`wasmWriteVecNum` 认 float)解锁 `Map[str,i64]` 与 `Vec[f64]` 形参;strict 120 语料 **fallback=0**,剩余守护(VecLit/下标/mut/Option)显式回落具名。**本地函数恢复 #44**(M3047 移除):块级条目 + 递归/互递归 + 契约同模块函数口径(M4015)+ 作值 HOF + AOT 产物;三条限制(不捕获外层局部/块级可见/泛型与 cc 不支持)如实写入 GUIDE。**记账统一**:wasm `str_cat` 与 `std.str.join`(#49)按结果长度计费(嵌套 11+15;BMP 口径差异与 `--max-alloc` 内存风险如实登记),插值与 tree/VM 一致不计费。**P3 invariant bench**:`tests/bench.mjs` 新项"契约 invariant 循环"(300,000 次 mut-self 退出 vs 无 invariant 对照)——VM 0.19–0.28µs/次、tree 0.20–0.28µs/次(占循环墙钟 20–27%,高于 5% free 阈值,如实报告),基线含 `invariant.vmUs/treeUs`。**独立审查修复**:P1(`<<` 结果溢出 wasm/C 四引擎 M4002、M4007 消息+位置三引擎逐字、VecLit/MapLit 计费、u64 字面量编码回归)、P2(B1 兄弟 ensures/B2 lambda 引用本地 fn/B3 遮蔽语义定案/B4 导入遮蔽 M3015 + M3009/M3048)、P3(invariant 结论按 5% 判据如实、bench 中位口径)。**§63 共 56 项、881 项全绿**;fuzz 三种子 0 分歧、proof_fuzz 0 误报。
- **v0.60.0(当前)** — **资源门禁一致性(质量/安全版,无新语言面;2026-11-13 三方评估后范围)**:**#51** wasm 参数搬运计费分歧(`mingAllocRaw` 计费开关;`wasmParamTop` 调用前保存/finally 复位,panic/trap/回落三路径,线性内存随调用复用)、**#52** 外部输入边界计费(read_file 先 stat 按 size 预记账/read_bytes/read_line/read_to_end/list_dir 条目/proc.exec stdout+stderr/http body;**计费 = 值创建 + 外部输入边界,派生值(deepCopy/json.parse/re.*/wasm 搬运)不重复计费**)、**#53** `--max-ms` 阻塞内建钳制(`remainingMs()` + sleep/join/join_detailed/spawn_all/sync scope/exec/http 等待钳制,预算已尽直接 M4012;**read_line/RegExp 进程内不可抢占边界具名**;checkTimeQuota 边界 `>`→`>=`)、**#47** tree 契约求值重入(`execBlock` 仅函数体块尾检查 ensures,ctx `bodyBlock`;`ensures if a>0 {true} else {true}` 三引擎输出 5)、**#54** `ming test` 旗标传播(--tree/--no-wasm/--max-* 与 run 同默认值,双 runTests 路径透传;--strict-wasm 仅互斥仲裁并提示忽略)+ `ming init` CLI 回归。**§64 共 24 项、905 项全绿**;fuzz 40 程序 0 分歧(wasm 真实执行 20)、proof_fuzz 100 例 0 误报;无新诊断码(复用 M4011/M4012);3 名 fresh code-reviewer 独立审查,阻塞项(基类 runTests 漏透传)修复 + v64.B9 锁定,MINOR 5 项落实,latent N-60.1–4 登记。
- **计划状态** — `docs/plan.md §4.4`:**v0.60 资源门禁一致性已交付**(2026-11-13;三方评估修订范围,#51–#54 + #47);下一步 **v0.61 污点窄源条件交付**（ADR-002 五处补丁已落;启动门槛 = 12 工具迁移 spike + 净化器策略裁决;9 源全量为 v1.1）→ **v0.62 serve 条件交付**（ADR-001 16/16）。ADR-001 并发/服务端选型（worker-per-connection 条件承诺，原型 190 req/s@40 连接）、ADR-002 污点（类型级 `Untrusted[T]`，v1 窄源）、ADR-003 mask（永久否决）。已知缺陷 #55–#57（P2,Backlog/随 v0.61）;#51–#54/#47 已于 v0.60 收口（见 plan §5.1）。

## 设计原则(全文见 design.md)

1. **明确优于简洁** —— 写出来的就是全部含义。
2. **安全是默认,不是选项** —— 危险操作要么被检查,要么 panic,绝不静默。
3. **副作用可见** —— 效果签名说明一切:没标 `io` 的函数不可能打印,编译器保证。
4. **确定性** —— 同样的代码永远产生同样的行为(包括迭代顺序)。
5. **为验证循环优化** —— AI 的核心工作方式是"生成 → 检查 → 修正",工具链必须为这个循环服务。
6. **没有第二种写法** —— 一种结构一个语法,`ming fmt` 是唯一风格。

## 状态

v0.60.0(2026-11-13):**资源门禁一致性(v0.60:#51 wasm 搬运计费分歧 + wasmParamTop 复位、#52 外部输入边界计费、#53 --max-ms 阻塞内建钳制(M4012)、#47 tree 契约重入、#54 ming test 旗标传播;read_line/RegExp 不可抢占边界具名) + 默认引擎全面性(v0.59:wasm 覆盖收口 #40–#43/#45/#46 + 本地函数恢复 #44 + 记账统一 #48/#49,strict 语料 fallback=0)+ AI 协作体验(v0.58:LSP 补全/跳转/符号、std.str.join、doc --json/--index、Release 打包)** + 字节码 VM + **WASM 分层 + strict-wasm 三态(`--strict-wasm`/`MING_WASM_STRICT=1`,fallback → exit 2)+ v0.56 严格模式语义修复(一元负号/break-continue 分支深度/for-in continue 自增/`%` 条件类型推导)** + **CI 矩阵(Linux/macOS/Windows × Node 18/20/22 + C 腿 + nightly 三种子深模糊;官方 action,零 npm 依赖)** + **C 后端 C1–C5(ming cc:数值/str/Vec/Map/Option/f64 + extern fn FFI;`str` for-in 按 UTF-8 码点迭代;`with unsafe` 受限指针 Ptr[mut u8]/Ptr[u8] + std.mem.alloc/free(C5);tree/VM/wasm 回落 M4016;差分腿覆盖已声明 eligible 形态;--static)** + **受控不安全(`with unsafe` 双门禁:M3029 签名 + M3046 块级;仅 C 原生;悬垂/越界 UB 不捕获)** + **引擎一致性(tree 作用域统一 + VM 捕获闭包 HOF 修复;三引擎逐字一致)** + **构建可信性(collectProjectSources 项目相对路径 + 内容 + Node 主版本;v0.56 buildKey 加入编译器源码指纹;build --json 带 build_key/dist_hash/cache_hit/source_count/interface_hashes/compiler_hash;同 OS + 同 Node 主版本可复现)** + **ABI 哈希构建缓存(ming build:命中跳过检查+编译;接口哈希 ABI 防火墙;--clean-cache)** + **契约系统(requires/ensures/invariant:运行时 M4015 + 编译期 M3040/M3041/M3042 + 静态边界证明 M3045/W3105 + v0.55 跨函数契约摘要 + v0.57 循环/守卫敏感边界证明:范围 for 内 `buf[i]` 义务两向证明(脏循环/嵌套/while 保守放弃,义务 additive `scope: body|loop`;proven 不消除运行时 M4003)+ --proof-report;v0.56 fmt 契约保真)** + **静态证明器(QF_LIA 限定子集:prover.js 线性形式 + 差分约束 + 函数摘要 + 范围 for 循环义务;proof_fuzz 0 误报)** + **自举工具 12 个(Ming 自写;v0.50 ming tools 统一入口;v0.57 工具 AOT 缓存,热缓存净 ~25–30ms/次,MING_TOOLS_DEBUG 观测)** + 正则 + 结构化并发 + **错误链(cause)** + **二进制 I/O + 任务超时/取消 + 资源熔断(--max-alloc/--max-ms;v0.60 门禁一致性:外部输入计费+阻塞内建钳制,#51–#53;read_line/RegExp 不可抢占边界具名)** + JSON + capability fs/net/sync/proc/env/rand/io + HTTP(响应头/超时可配)+ std.fmt(进制/精度/对齐)+ std.log + std.math 全函数(wasm 桥接)+ std.crypto(Hash/HMAC)+ std.bin(显式字节序)+ 字节流正则 + AES-CBC/GCM(最小帧 28B + nonce 唯一性回归)+ ming build 可移植产物 + 时间日期 + 线性句柄 + 泛型 impl + REPL + 项目管理 + LSP。能力矩阵见 docs/capabilities.md(54 行口径 ≈82%;#51–#53 已于 v0.60 修复(边界具名))。模糊基线:tests/fuzz.mjs(多后端差分,v0.56 起 wasm 腿真实执行并计数)+ tests/proof_fuzz.mjs(静态边界证明 + v0.55 跨函数摘要模式 + v0.57 loops 模式:0 误报 + 反例独立求值器验证)。观测:覆盖率基线 **94.0% 行 / 88.7% 函数**(tests/coverage.mjs,信息性不设门槛;v0.60 全表 2026-11-14,vm.js 函数 65.9%;历史 43.8%→63.8%→65.9%,旧 43.8% 口径作废)+ bench 基线(Δ基线对比,cc/vm 比值回退 >20% WARN)。回归:**905 项全绿(§63 56 项 + §64 24 项)**。
