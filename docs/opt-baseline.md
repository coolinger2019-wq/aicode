# 优化基线(O0.3,plan §4.16)

**优化前基线——未来 pass 的对照锚。**(采集于 v0.92 工作树;对本表程序零语义变化,审查 NOTE-3)

由 `node tests/opt_gate.mjs --write-doc` 机械生成(采集日期 2026-11-19;手工编辑会被下次刷新覆盖)。
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

当前语言没有任何优化 pass,`--opt-off` 恒 default 行为(两态输出逐字相同)。未来 O1 起的 pass 落地后,由 `tests/opt_gate.mjs` 在同批程序上跑 pass 开/关两态,差值与本文件的"优化前基线"直接对照(接入点见 opt_gate.mjs OPT_OFF 消费点注释)。

