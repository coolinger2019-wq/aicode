# 优化基线(O0.3,plan §4.16)

**优化前基线——未来 pass 的对照锚。**(采集于 v0.92 工作树;对本表程序零语义变化,审查 NOTE-3)

由 `node tests/opt_gate.mjs --write-doc` 机械生成(采集日期 2026-11-19;手工编辑会被下次刷新覆盖——`O1:BASELINE-START`/`O1:BASELINE-END` HTML 注释标记区除外,刷新时原样保留)。
配套耗时锚点见 `tests/bench.baseline.json`(2026-11-20 刷新,含 O0.2 第 7–11 项;3 次取最小口径)。

## MING_STATS=1 统计面

字段口径(O0.1;`ming run` 结束后 stderr 一行 JSON):

- `instr`:编译器函数表指令总数(字节码;tree 引擎无字节码 → N/A)
- `steps`:引擎执行步数(tree/VM 同口径;wasm 循环头/调用按 +50 计)
- `deepCopy`:interp.js deepCopy 入口计数(双引擎共用同一实现;含容器递归内层调用)
- `alloc`:引擎累计分配终值(Vec/Map 按元素、str 按字符;tree 引擎口径 N/A)
- `concat` / `callMethod`:VM CONCAT / CALLMETHOD opcode case 计数(tree 恒 0)
- wasm 真实执行段不计入:eligible 函数在 wasm 内原生执行,不经过 JS 执行循环与 case 臂

| 程序 | 腿 | instr | steps | deepCopy | alloc | concat | callMethod |
|---|---|---|---|---|---|---|---|
| 拷贝密集 10 万绑定 | tree | N/A | 1600023 | 2800037 | N/A | 0 | 0 |
| 拷贝密集 10 万绑定 | vm-only | 46 | 2000030 | 2700035 | 8 | 0 | 0 |
| 拷贝密集 10 万绑定 | vm+wasm | 46 | 2000030 | 2700035 | 8 | 0 | 0 |
| Map 更新 2 万混合 | tree | N/A | 480849 | 180199 | N/A | 0 | 0 |
| Map 更新 2 万混合 | vm-only | 57 | 500922 | 80005 | 310 | 0 | 60064 |
| Map 更新 2 万混合 | vm+wasm | 57 | 500922 | 80005 | 310 | 0 | 60064 |
| HOF 链 10 万元素 | tree | N/A | 2540027 | 1520031 | N/A | 0 | 0 |
| HOF 链 10 万元素 | vm-only | 59 | 2540029 | 320003 | 310000 | 0 | 100005 |
| HOF 链 10 万元素 | vm+wasm | 59 | 2540029 | 320003 | 310000 | 0 | 100005 |
| 字符串构造 1 万次 | tree | N/A | 80024 | 20013 | N/A | 0 | 0 |
| 字符串构造 1 万次 | vm-only | 36 | 100030 | 10010 | 100010025 | 0 | 2 |
| 字符串构造 1 万次 | vm+wasm | 36 | 100030 | 10010 | 100010025 | 0 | 2 |
| 闭包调用 10 万次 | tree | N/A | 1300012 | 400008 | N/A | 0 | 0 |
| 闭包调用 10 万次 | vm-only | 32 | 1600020 | 200005 | 0 | 0 | 0 |
| 闭包调用 10 万次 | vm+wasm | 32 | 1600020 | 200005 | 0 | 0 | 0 |
| hello(example) | tree | N/A | 52 | 24 | N/A | 0 | 0 |
| hello(example) | vm-only | 28 | 76 | 12 | 0 | 2 | 0 |
| hello(example) | vm+wasm | 28 | 76 | 12 | 0 | 2 | 0 |
| fib(example) | tree | N/A | 4567 | 1381 | N/A | 0 | 0 |
| fib(example) | vm-only | 96 | 5533 | 464 | 0 | 11 | 0 |
| fib(example) | vm+wasm | 96 | 22813 | 11 | 0 | 11 | 0 |

## cc 腿记录

| 程序 | 结果 |
|---|---|
| 拷贝密集 10 万绑定 | 跳过(不达 cc 资格(C1/C2,见 tests/bench.mjs 第 7–11 项注释)) |
| Map 更新 2 万混合 | 跳过(不达 cc 资格(C1/C2,见 tests/bench.mjs 第 7–11 项注释)) |
| HOF 链 10 万元素 | 跳过(不达 cc 资格(C1/C2,见 tests/bench.mjs 第 7–11 项注释)) |
| 字符串构造 1 万次 | 跳过(不达 cc 资格(C1/C2,见 tests/bench.mjs 第 7–11 项注释)) |
| 闭包调用 10 万次 | 跳过(不达 cc 资格(C1/C2,见 tests/bench.mjs 第 7–11 项注释)) |
| hello(example) | 通过(产物输出与 vm+wasm 逐字一致) |
| fib(example) | 通过(产物输出与 vm+wasm 逐字一致) |

## 三腿一致断言

全部程序 tree / VM-only(--no-wasm) / VM+wasm(默认) 三腿 stdout 逐字一致:**通过**。

## --opt-off(预留挂点)

O1 首批(常量折叠/分支裁剪/DCE)已落地(关闭形态 = `--no-opt`),两态语义由 opt_gate O1 优化语义闸门锁定;两态差值与"O1 优化前基线"的对照见下方 O1:BASELINE 标记区(--write-doc 刷新时原样保留)。

<!-- O1:BASELINE-START(Agent B 维护区;tests/opt_gate.mjs --write-doc 刷新时原样保留) -->

## O1 优化前指令数基线(HEAD 3887511,git worktree 纯净副本)

plan §4.16 O1 前置锚点(Agent B,2026-11-20 采集)。口径:

- **纯净副本**:`git worktree add .zcode/v94-baseline HEAD`(HEAD 3887511 = v0.93.0;该副本无 `src/opt.js`——"优化前"的唯一定义),采集完成后 worktree 已移除;
- **程序**:tests/bench_vs/progs 全部 8 个 .ming(6 主程序 + 2 个 cc 变体)+ examples/hello + examples/fib,共 10 个(任务口径"7 个 bench_vs 程序"按目录实情覆盖为 8——progs/ 实有 8 个 .ming,全数纳入不裁剪);
- **采集**:`MING_STATS=1 node <worktree>/bin/ming.js run <prog>`(vm-only 腿加 `--no-wasm`),stderr 末行 JSON;
- **确定性核对**:每程序 × 每腿跑两次,两次 stats 逐字段一致、stdout(计时程序剥离末位自测 ms token 后)逐字一致才采信——20/20 行全部通过;
- **特例 cwd**:filescan 在专用 scratch 目录运行(程序自建 1000 文件);jsonparse 在 10MB fixture 目录运行(与 tests/bench_vs/run.mjs 同一 fixture,meta.total = 2311966000);
- **默认腿 steps 偏高非异常**:wasm 计费口径(循环头/调用 +50,见上文字段口径),如 loopsum 默认 50,000,126 vs vm-only 7,000,036;jsonparse steps = 67 = 热点全在 wasm eligible 段执行(不计步),alloc 反映解析值分配量级。

| 程序 | 腿 | instr | steps | deepCopy | alloc | concat | callMethod |
|---|---|---|---|---|---|---|---|
| bench_vs fib | vm-only | 50 | 1800608 | 150052 | 14 | 0 | 2 |
| bench_vs fib | 默认 | 50 | 7502476 | 3 | 13 | 0 | 2 |
| bench_vs fib_cc | vm-only | 34 | 1800592 | 150049 | 0 | 0 | 0 |
| bench_vs fib_cc | 默认 | 34 | 7502460 | 0 | 0 | 0 | 0 |
| bench_vs loopsum | vm-only | 39 | 7000036 | 6 | 29 | 0 | 2 |
| bench_vs loopsum | 默认 | 39 | 50000126 | 3 | 27 | 0 | 2 |
| bench_vs loopsum_cc | vm-only | 23 | 7000020 | 3 | 0 | 0 | 0 |
| bench_vs loopsum_cc | 默认 | 23 | 50000110 | 0 | 0 | 0 | 0 |
| bench_vs hof | vm-only | 59 | 2200039 | 300005 | 250024 | 0 | 100005 |
| bench_vs hof | 默认 | 59 | 2200039 | 300005 | 250024 | 0 | 100005 |
| bench_vs wordfreq | vm-only | 166 | 760136 | 80075 | 20228 | 0 | 100009 |
| bench_vs wordfreq | 默认 | 166 | 760136 | 80075 | 20228 | 0 | 100009 |
| bench_vs jsonparse | vm-only | 95 | 67 | 12 | 10469427 | 0 | 14 |
| bench_vs jsonparse | 默认 | 95 | 67 | 12 | 10469427 | 0 | 14 |
| bench_vs filescan | vm-only | 153 | 395044 | 20006 | 7424282 | 0 | 5002 |
| bench_vs filescan | 默认 | 153 | 395044 | 20006 | 7424282 | 0 | 5002 |
| examples hello | vm-only | 28 | 76 | 12 | 0 | 2 | 0 |
| examples hello | 默认 | 28 | 76 | 12 | 0 | 2 | 0 |
| examples fib | vm-only | 96 | 5533 | 464 | 0 | 11 | 0 |
| examples fib | 默认 | 96 | 22813 | 11 | 0 | 11 | 0 |

## O1 后对照(2026-11-20 采集:主树优化开,src/opt.js + --no-opt 已落地)

对照口径:主树(优化开,默认)对同批程序同腿采集 MING_STATS;Δ% = (后 − 前) / 前 × 100。闸门已断言 instr(后) ≤ instr(前) 优化不增指令(tests/opt_gate.mjs O1 节 ②),Δ% 为负即优化收益。

采集时点说明:src/opt.js + `--no-opt`(CLI)/`MING_NO_OPT`(env,经 bin/ming.js 单点传 compile())由 Agent A 落地,采集时为工作树态(src/opt.js untracked、bin/ming.js 与 src/compiler.js 已修改、未提交)。**本表 10 程序 steps 逐值一致(一般命题不成立:折叠可减少执行步——配额类观测随指令数变化,如 `--max-steps`)**——本表程序的实际执行路径未变,与闸门 stdout 逐字一致断言相符。instr 下降集中在含可折叠常量/死分支的程序(fib −8.0%、fib_cc −11.8%、filescan −5.2%、examples fib −4.2%);其余程序字节码无可削减点,0 变化(闸门 ② 的"不增"口径下 0 是合法值)。**v0.94 审查修复后复核(2026-11-20)**:移除 str `+` 折叠(审查 M1)与 DCE 补 JUMP 终结(审查 m1)后对同批程序再采集两遍(确定性核对通过),本表 instr/steps 全部复现原值——本批程序无纯字面量 str 拼接,死代码形态已由 RET 终结;§104 死分支用例的 instr 进一步下降(P3 现真删 JUMP 后的不可达段:v104.5 形态优化态 36 → 18 条指令,v104.6 扩展形态优化态 58 → 47（no-opt 态 41/68）)。

| 程序 | 腿 | instr(前) | instr(后) | instr Δ% | steps(前) | steps(后) | steps Δ% |
|---|---|---|---|---|---|---|---|
| bench_vs fib | vm-only | 50 | 46 | -8.0% | 1800608 | 1800608 | 0.0% |
| bench_vs fib | 默认 | 50 | 46 | -8.0% | 7502476 | 7502476 | 0.0% |
| bench_vs fib_cc | vm-only | 34 | 30 | -11.8% | 1800592 | 1800592 | 0.0% |
| bench_vs fib_cc | 默认 | 34 | 30 | -11.8% | 7502460 | 7502460 | 0.0% |
| bench_vs loopsum | vm-only | 39 | 39 | 0.0% | 7000036 | 7000036 | 0.0% |
| bench_vs loopsum | 默认 | 39 | 39 | 0.0% | 50000126 | 50000126 | 0.0% |
| bench_vs loopsum_cc | vm-only | 23 | 23 | 0.0% | 7000020 | 7000020 | 0.0% |
| bench_vs loopsum_cc | 默认 | 23 | 23 | 0.0% | 50000110 | 50000110 | 0.0% |
| bench_vs hof | vm-only | 59 | 59 | 0.0% | 2200039 | 2200039 | 0.0% |
| bench_vs hof | 默认 | 59 | 59 | 0.0% | 2200039 | 2200039 | 0.0% |
| bench_vs wordfreq | vm-only | 166 | 166 | 0.0% | 760136 | 760136 | 0.0% |
| bench_vs wordfreq | 默认 | 166 | 166 | 0.0% | 760136 | 760136 | 0.0% |
| bench_vs jsonparse | vm-only | 95 | 95 | 0.0% | 67 | 67 | 0.0% |
| bench_vs jsonparse | 默认 | 95 | 95 | 0.0% | 67 | 67 | 0.0% |
| bench_vs filescan | vm-only | 153 | 145 | -5.2% | 395044 | 395044 | 0.0% |
| bench_vs filescan | 默认 | 153 | 145 | -5.2% | 395044 | 395044 | 0.0% |
| examples hello | vm-only | 28 | 28 | 0.0% | 76 | 76 | 0.0% |
| examples hello | 默认 | 28 | 28 | 0.0% | 76 | 76 | 0.0% |
| examples fib | vm-only | 96 | 92 | -4.2% | 5533 | 5533 | 0.0% |
| examples fib | 默认 | 96 | 92 | -4.2% | 22813 | 22813 | 0.0% |

## O1b 窥孔前基线(HEAD 6d861e4,git worktree 纯净副本)

plan §4.16 O1b 前置锚点(Agent B2,2026-11-20 采集)。口径:

- **纯净副本**:`git worktree add .zcode/v95-baseline HEAD`(HEAD 6d861e4 = v0.94.0;**含 O1a 折叠/裁剪/线程/DCE、无 P4 peephole**,即 O1b 的"前"态),采集完成后 worktree 已移除;
- **程序**:与上方 "O1 优化前指令数基线" 同批 10 个(tests/bench_vs/progs 全部 8 个 .ming + examples/hello + examples/fib)+ §104 死分支形态(v104.5 源码逐字)与 §104 DCE 形态(v104.6 源码逐字)各 1,共 **12 程序 × 2 腿 = 24 行**;
- **采集**:`MING_STATS=1 node <worktree>/bin/ming.js run <prog>`(vm-only 腿加 `--no-wasm`),stderr 末行 JSON;filescan 每次运行用全新 cwd(程序自建 1000 文件),jsonparse 在 10MB fixture 目录运行;
- **确定性核对**:每程序 × 每腿跑两次,`instr`/`steps`/`deepCopy`/`concat`/`callMethod` 与 stdout(计时程序剥离末位自测 ms token)逐字段一致才采信——**24/24 行通过**。**NOTE**:filescan 的 `alloc` 在文件系统边界有 ±1 抖动(实测同一份 HEAD 代码下 7424281/7424282 两值交替出现,与优化无关;本表只以 instr 为对照锚,alloc 记单次值);
- **§104 DCE 形态按设计 exit 101**(panic "boom",M4001):stats 仍在 panic 前输出,instr 可采;stdout `a1\n1\n2\n` 两态一致;
- **前态值即 v0.94 已交付的 O1a 后值**(fib 46/fib_cc 30/filescan 145/examples fib 92 …),与上方 "O1 后对照" 表逐值一致——O1b 的 Δ 由此单列。

| 程序 | 腿 | instr | steps | deepCopy | alloc | concat | callMethod |
|---|---|---|---|---|---|---|---|
| bench_vs fib | vm-only | 46 | 1800608 | 150052 | 14 | 0 | 2 |
| bench_vs fib | 默认 | 46 | 7502476 | 3 | 13 | 0 | 2 |
| bench_vs fib_cc | vm-only | 30 | 1800592 | 150049 | 0 | 0 | 0 |
| bench_vs fib_cc | 默认 | 30 | 7502460 | 0 | 0 | 0 | 0 |
| bench_vs loopsum | vm-only | 39 | 7000036 | 6 | 29 | 0 | 2 |
| bench_vs loopsum | 默认 | 39 | 50000126 | 3 | 27 | 0 | 2 |
| bench_vs loopsum_cc | vm-only | 23 | 7000020 | 3 | 0 | 0 | 0 |
| bench_vs loopsum_cc | 默认 | 23 | 50000110 | 0 | 0 | 0 | 0 |
| bench_vs hof | vm-only | 59 | 2200039 | 300005 | 250024 | 0 | 100005 |
| bench_vs hof | 默认 | 59 | 2200039 | 300005 | 250024 | 0 | 100005 |
| bench_vs wordfreq | vm-only | 166 | 760136 | 80075 | 20228 | 0 | 100009 |
| bench_vs wordfreq | 默认 | 166 | 760136 | 80075 | 20228 | 0 | 100009 |
| bench_vs jsonparse | vm-only | 95 | 67 | 12 | 10469427 | 0 | 14 |
| bench_vs jsonparse | 默认 | 95 | 67 | 12 | 10469427 | 0 | 14 |
| bench_vs filescan | vm-only | 145 | 395044 | 20006 | 7424282 | 0 | 5002 |
| bench_vs filescan | 默认 | 145 | 395044 | 20006 | 7424282 | 0 | 5002 |
| examples hello | vm-only | 28 | 76 | 12 | 0 | 2 | 0 |
| examples hello | 默认 | 28 | 76 | 12 | 0 | 2 | 0 |
| examples fib | vm-only | 92 | 5533 | 464 | 0 | 11 | 0 |
| examples fib | 默认 | 92 | 22813 | 11 | 0 | 11 | 0 |
| §104 死分支形态 | vm-only | 18 | 18 | 0 | 0 | 0 | 0 |
| §104 死分支形态 | 默认 | 18 | 18 | 0 | 0 | 0 | 0 |
| §104 DCE 形态 | vm-only | 47 | 44 | 3 | 2 | 0 | 0 |
| §104 DCE 形态 | 默认 | 47 | 44 | 3 | 2 | 0 | 0 |

## O1b 后对照(2026-11-20 采集:主树优化开,src/opt.js 含 P4 peepholePass)

对照口径:主树(默认优化开)对**同批 12 程序同腿**采集 MING_STATS;Δ% = (后 − 前) / 前 × 100。前值 = 上方 "O1b 窥孔前基线"(HEAD 6d861e4 = O1a 已交付态)。采集时 A2 的 P4 已落地于工作树(src/opt.js 未提交),闸门 `tests/opt_gate.mjs` O1b 节已转硬断言并全绿(10 形态 × 两态 × 三腿 + panic 值语句 + 确定性,共 104 项)。

**本批结果**:12 程序中仅 §104 死分支形态 instr 18 → 14(−22.2%,steps 18 → 14)——P4 的语句值 POP 消除删掉了 `if true` 裁剪后遗留的纯值压栈对;其余 11 程序 instr/steps 全部不变。**诚实解释**:bench_vs 六任务与 examples 的字节码里没有 `[CONST|LD][POP]` 语句值对、也没有全字面量 CONCAT 段(O1a 已折叠其算术),本批对 P4 结构性无靶点;O1b 的收益集中在下方"窥孔形态程序"表(纯值语句 −22.2%、全字面量 CONCAT −42.9%)。**P4 不改任何程序的可观察语义**:闸门 ①/④ 已锁两态 × 三腿 stdout 与 panic 首行逐字,⑤ 锁两次 opt 逐字节。

| 程序 | 腿 | instr(前) | instr(后) | instr Δ% |
|---|---|---|---|---|
| bench_vs fib | vm-only | 46 | 46 | 0.0% |
| bench_vs fib | 默认 | 46 | 46 | 0.0% |
| bench_vs fib_cc | vm-only | 30 | 30 | 0.0% |
| bench_vs fib_cc | 默认 | 30 | 30 | 0.0% |
| bench_vs loopsum | vm-only | 39 | 39 | 0.0% |
| bench_vs loopsum | 默认 | 39 | 39 | 0.0% |
| bench_vs loopsum_cc | vm-only | 23 | 23 | 0.0% |
| bench_vs loopsum_cc | 默认 | 23 | 23 | 0.0% |
| bench_vs hof | vm-only | 59 | 59 | 0.0% |
| bench_vs hof | 默认 | 59 | 59 | 0.0% |
| bench_vs wordfreq | vm-only | 166 | 166 | 0.0% |
| bench_vs wordfreq | 默认 | 166 | 166 | 0.0% |
| bench_vs jsonparse | vm-only | 95 | 95 | 0.0% |
| bench_vs jsonparse | 默认 | 95 | 95 | 0.0% |
| bench_vs filescan | vm-only | 145 | 145 | 0.0% |
| bench_vs filescan | 默认 | 145 | 145 | 0.0% |
| examples hello | vm-only | 28 | 28 | 0.0% |
| examples hello | 默认 | 28 | 28 | 0.0% |
| examples fib | vm-only | 92 | 92 | 0.0% |
| examples fib | 默认 | 92 | 92 | 0.0% |
| §104 死分支形态 | vm-only | 18 | 14 | **−22.2%** |
| §104 死分支形态 | 默认 | 18 | 14 | **−22.2%** |
| §104 DCE 形态 | vm-only | 47 | 47 | 0.0% |
| §104 DCE 形态 | 默认 | 47 | 47 | 0.0% |

**合计**:12 程序单腿 instr 前 788 / 后 784(−0.5%;24 行合计 1576/1568,两腿同值故按单腿表述);steps 仅 §104 死分支 18 → 14,其余 11 程序两腿全等(前基线表逐腿原值)。§104 DCE 形态按设计 exit 101(M4001),两态 stdout `a1\n1\n2\n` 与 panic 首行逐字一致。

### 窥孔形态程序(O1a 基线 → O1a+P4,主树/纯净副本同源)

为把 O1b 的贡献与 O1a 隔离,同一批 10 个闸门形态程序分别在 **HEAD 6d861e4 worktree(O1a only)** 与 **主树(O1a+P4)** 以 MING_STATS=1 默认腿采集(每态两次,instr 一致;`--no-opt` 原值一并列出作未优化参照)。P4 本身对混合 CONCAT/LD+SET 自赋值/短路跳转目标三形态按设计不动(A2 头注跳过候选),表中 0 变化即"守卫生效"的非空证据。

| 形态程序 | instr(--no-opt 未优化) | instr(O1a,HEAD) | instr(O1a+P4,主树) | O1b Δ |
|---|---|---|---|---|
| 纯值语句 | 20 | 18 | 14 | **−22.2%** |
| panic 值语句 `1/0;` | 14 | 14 | 14 | 0.0%(panic 保留) |
| panic 值语句 `1%0;` | 14 | 14 | 14 | 0.0%(panic 保留) |
| 全字面量 CONCAT | 16 | 14 | 8 | **−42.9%** |
| 混合 CONCAT | 22 | 20 | 20 | 0.0%(不折叠) |
| LD+ST 自赋值 | 16 | 16 | 16 | 0.0%(跳过候选) |
| 嵌套折叠链 | 34 | 14 | 14 | 0.0%(O1a 已折尽) |
| CONCAT 值语句循环 | 24 | 24 | 20 | **−16.7%** |
| 循环内纯值语句 + 块值 | 43 | 41 | 35 | **−14.6%** |
| 短路语句跳转目标守卫 | 36 | 36 | 36 | 0.0%(POP 为跳转目标,跳过) |

闸门 O1b 节 ③ 仅对纯值语句、全字面量 CONCAT 两形态断言严格下降(effective),循环两形态只受"instr 不增"约束;panic 值语句两态 exit 101 且首行逐字(闸门 ④),混合 CONCAT/自赋值/短路守卫的 0 变化是守卫正确性证据而非无效。

<!-- O1:BASELINE-END -->

