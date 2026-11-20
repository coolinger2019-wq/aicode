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

<!-- O1:BASELINE-END -->

