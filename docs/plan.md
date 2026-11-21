# Ming 实施计划（v0.45 起）

> 本文件是唯一的计划落盘位置。已完成项在版本提交后移到「已完成」；新想法先进「Backlog」，
> 只有进入版本范围才细化到任务级。当前版本：**v0.99.0**（**v0.99 已实现(2026-11-21)**：ADR-011 P1 创建点过滤（captureEnvFor 三步：collectFreeNames 纯过近似 → owner 沿链解析 → 深度保持过滤重建，tys 子集/localFns 命中浅拷/mod 共享）——**92/92 探针·腿零行为漂移**（P1-B 独立验证 0 阻碍项）；性能门槛全达成（p_chain_22 deepCopy 435→181、p_big_parent 36,009→**26,006** −10,003、p_bind_closure_hot 5,000,004 逐字不变）；f8a 深链×pad 创建级联消除（575,039→66,254 −88%）；变异实验 (i) owner 恒外层→抓住（v110.10 锚）/(ii) 漏 localfn→抓住/(iii) tys 子集标量面幂等定案（预判偏差如实）；**1627 项全绿**(§110 15 check)；fuzz 三种子 ×40 0 分歧。原 v0.98 行：**v0.98 已实现(2026-11-20)**：ADR-011 P0 分析单源化（collectFreeNames/collectLambdaLocals/addPatNames → src/freenames.js 叶模块；零行为变化——字节码 10 程序×两态逐字节等价；M1 禁令合规 sha256 机械证明——collectLambdaLocals 死代码承重勿修；bin dist runtime 清单补登记；§109 9 check 含 rv1 过近似锁定与死代码承重锚；独立验证 P0-B PASS 差异清单零）；**1612 项全绿**；fuzz 0 分歧。原 v0.97 行(2026-11-20)**：P1 修复 #79（VM builtin 方法实参不深拷贝——双引擎值语义分歧，HEAD 预存；修=V CALLMETHOD builtin 路径 args.map(deepCopy)，用户方法零双重拷贝；独立验证 21 探针×四腿全绿）+ O2.1 设计预研（ADR-010 753 行 + 调研 509 行：freshness 格/O2a·b·c 可证条件；关键发现——270 万 deepCopy 几乎全为标量 no-op（v0.97 复测:hof 300,008/wordfreq 80,075 基本不变;闭包复制 t5 600,009→1,000,009 为 #81 真实增量）、O2 热路径收益≈0、deepCopy 不计 --max-alloc；ADR 已更新 #79/#81 事实与 v4 版本区间检查）；新登记 #80（Vec.slice/filter 返回值浅拷贝）与 **#82（树引擎闭包复制 parent 链不完整——递归快照实现 2^n 复制 4GB OOM，审查 B1 回退后登记开放 P1，修法待 free-variable 捕获计划设计）**；**并修复 P1 #81**（deepCopy 缺 vclose 分支——闭包绑定/传参别名，tree 1/2/1/0 vs VM 1/2/3/0；修=captures 逐项深拷贝 + __retSpec 保真；§108 8 check）；**1603 项全绿**(§107 9 + §108 8 check)；fuzz 0 分歧。原 v0.96 行(2026-11-20)**：O1c 常量传播（constPropPass → 管线 fold→prune→thread→dce→peephole→constProp）——不可变 let 标量/str 常量 LD→CONST 使下游折叠成链；六放弃锚（SET/ADDI·复合赋值/闭包捕获/形参/窄型归一 ST/容器值语义陷阱）；ST 支配 CFG BFS 证明；实测 cp1 −16.7%/cp2 −27.3%/hello −10.7%；§105 两处校准理由化；**1586 项全绿**(§106 11 check)；opt_gate 374 断言；fuzz 0 分歧。**O1 四 pass 全部交付**。原 v0.95 行(2026-11-20)**：O1b 通用窥孔（peepholePass + 六候选逐项裁决——POP 消除/全字面量 CONCAT 做；LD+ST/DUP+ST/!反转/相邻 CONST 不做并登记；跳转目标守卫；panic 值语句两态逐字保留）+ 独立基线（12 程序 24/24 确定性）与窥孔有效性实证（纯值语句/全字面量 CONCAT −22.2%/−42.9%）；**1575 项全绿**(§105 9 check)；opt_gate 291 断言；fuzz 0 分歧。原 v0.94 行(2026-11-20)**：O1 字节码优化首批（折叠/分支裁剪/跳转线程/DCE；默认开，--no-opt/MING_NO_OPT 关；优化开关进构建键与工具缓存键）——独立审查 REQUEST_CHANGES（B1 浮点常量 AOT wire 损坏——全修无损编码 + validateArtifact 类型校验，顺带治愈 HEAD 预存 1.0e400/const 浮点 AOT 缺陷；M1 str `+` 折叠破坏 --max-alloc 三腿一致——移除；m1 JUMP terminal；m2 build/tools 旗标与缓存键；m3 措辞）修复后通过；独立验证 Agent D 判定 B1/M1/m1/m2/正向抽查全 PASS（opt_gate 187 断言 0 失败；--no-opt 对 HEAD code 数组 42/42 逐字节一致,artifact 仅 float bits 差异（B1 预期））；instr 实测 fib −8.0%/fib_cc −11.8%/filescan −5.2%；**1566 项全绿**(§104 15 check)；fuzz 三种子 ×40 0 分歧。原 v0.93 行(2026-11-20)**：T5.1 跨语言基准对比（纯测量/文档，零语义改动）——tests/bench_vs/ 采集 harness（27 程序：Ming 8/JS 6/Python 6/C 7；7 任务 × Node 24/Python 3.10.11/C -O2/Ming tree·VM·cc，min-of-5，语义等价四语言实证 token 硬断言）+ docs/bench-vs-baselines.md（10 节；赢——循环累加快 Python 6.5×/fib ≈ Python 同档/wasm 数值热点；输同权重——HOF 慢 Node 31×、词频 21×、JSON 5.9×；cc 资格面 5/7 N/A 逐项实测；汇总——性能在北星 CLI 安全工具场景不构成主要障碍，主要代价在容器/闭包/哈希密集纯计算段；Python 3.10.11 vs plan 3.12 偏差如实）；独立审查 APPROVE-with-minor（M1 plan 台账补登记/M2 §8.1 数字重算/m1 1ms 分辨率披露/m2 机制标注修正/m3 fmt/m4 --write 保护）修复后通过；1551 项 0 失败不变。原 v0.92 行：**v0.92 已实现(2026-11-20)**：T5.2 C 后端 I/O 面（print 插值串放行——段类型五类与 displayStr 逐字节、先求值后输出保序；函数体块尾表达式放行；契约+块尾具名拒绝；C 指纹零变化——BASE_C_SHA 双向复核；hello/fib 三腿逐字；wordcount 三缺口如实具名拒绝；§103 10 check——含审查 M1/m2 回归锚 §103.9 负零/§103.10 退出码）+ §4.16 O0 优化观测面（MING_STATS 统计面/bench 扩 5 项基线刷新/opt_gate 44 断言/opt-baseline.md——O2 靶点实证：拷贝密集 deepCopy 270 万次/10 万迭代）；**1551 项全绿**(§103 10 check)；fuzz 三种子 ×40 0 分歧；独立审查 REQUEST_CHANGES——M1 f64 负零三腿分歧（pre-existing，插值/块尾解锁面使其可见；ming_float_str 负零检测空体死代码）已修（归一 +0.0 对齐 JS toFixed，§103.9）+ m2 main→i64 块尾退出码 wrapper 丢弃返回值恒 0 已修（return ming_main()，§103.10——两者均 pre-existing，解锁面使其可见）；m1 覆盖声明同步/m3 登记 #76/m4 登记 O1 前补；修复后通过。原 v0.91 行：**v0.91 已实现(2026-11-20)**：工程收口（纯工具/文档面，零语义改动）——T4.1 套件超时/隔离（spawnT 统一出口 120s 杀树/102 处分节计时/唯一无界 spawn 补界/挂起未复现如实记录/§101 机制自测）+ T4.3 支持矩阵（21 形态×5 后端=105 格机器可验证，harness 生成 docs/support-matrix.md）+ T4.4 docs_check（5 项 14 断言，首跑抓三语 README 当前版本漂移并修复）+ CI docs-and-matrix job（v53.20 校准理由化：uses 计数→官方白名单）；**1541 项全绿**(§101 2 check)；fuzz 三种子 ×40 0 分歧。原 v0.90 行：**v0.90 已实现(2026-11-19)**：引擎一致性第三波（预存分歧清账；零新增 M 码）——#73 AOT struct 相等分歧修复（valueEquals 同类型判定，wire 不变）+ tree ctor 作值对齐 VM + BIND 归一 panic 位置列统一（tree 向 VM 对齐 3:5→3:9，PIdent 口径）+ u64 字面量消息 未达活复现登记关闭（架构师 15 探针 + 实现 q1–q24 四腿全部统一，§100 v100.9–v100.13 锁定统一行为）+ 独立审查 REQUEST_CHANGES（**1 MAJOR——VM ctor 分发缺深拷贝**：callValue/CALLMETHOD 'ctor' 两处传操作数栈裸引用，同表达式后置变异形态静默双引擎值分歧——修复 = vm.js 两处 args.map(deepCopy) 对齐 MAKEENUM 先例 + §100 v100.14/15 回归锚（构造点快照 1/2/2、2/3 三腿逐字）；NOTE-1/2 登记 #74/#75、NOTE-3 v100.9 措辞收窄）**修复后通过**；**1539 项全绿**(§100 15 check)；fuzz 三种子 ×40 0 分歧、proof_fuzz 0 误报。原 v0.89 行：**v0.89 同族归一收口已交付(2026-11-19)**：Map 值位第五缺口（规格树 `{kt,vt}`/MapLit 递归/`__valTy` 打标/set·下标写归一；键位守门在 checker M3002——审查 m2 注释口径修正；kt-only 资格排除取舍登记）+ lambda 返回位（双通道正交：checker 统一回写 narrowRetSpec/narrowParamTypes + 值标签 `__retSpec` 打标；**通道①独立面 checker 合法程序内不可达——纵深防御口径如实**）+ enum payload（def 驱动构造位归一，VM MAKEENUM 全 6 发射点 normSpecs，artifact wire 兼容）+ 推断型静默面 M1a/M1b（值标签驱动：bindPattern 窄标签登记/uniformNarrowSpec 统一打标——**fuzz 对该面结构性失明,以 §99 定向断言补覆盖**）+ 独立审查 APPROVE-with-minor（0 BLOCKER;2 MAJOR 预存登记级——M1 tree ctor 作值 M4001 vs VM 分歧/M2 绑定归一 panic 位置列分歧,实测归属 HEAD 登记 §4.13.7;5 MINOR 全落实——M1b 混合标签残留面登记/Slice == 拒绝/捕获归一/注释口径/kt-only 取舍）；**1524 项全绿**(§99 18 check)；fuzz 三种子(44044/777/20261)×40 0 分歧、proof_fuzz 0 误报。原 v0.88 行：**v0.88 窄型注解遗留边界四项归一扩展已交付(2026-11-19)**：规格树声明驱动（declaredSpecOfTyAst/PatAst/Ty/StructDef 单一事实来源 + specEq 幂等）——① struct ctor+字段写 ② Vec 标注初始化/push/元素写 ③ 无标注 lambda 形参（checkLambda 统一回写 narrowParamTypes——**偏差登记:合同写规格树,实现回写 checker 类型避免 interp→checker 循环导入,规格树由引擎侧 declaredSpecOfTy 构建**）④ 元组模式绑定——四边界静默回绕收敛 M4002 双引擎对称 + **AOT 兼容方案 a**（wire normSpec 序列化 + validateArtifact ST/SET/BIND c 界检查;弃 AOT 回退方案 b——高频形态失 AOT 代价大）+ wasm declHasNarrowLet 扩展（Vec[窄]/元组标注;Vec[i64] 控制组保持 eligible）+ **独立基线审计**（B 纯净副本 16 探针×三腿逐字 0 分歧——标签位驱动异质面:plain 通道静默/后缀·as 通道已 panic）+ **fuzz 5 窄型 shape 差分探测器**（突变实验实证抓分歧——B 的「归一不对称直接抓分歧」非纸面声称）+ 独立审查 APPROVE-with-minor（差分探测器有效性实验通过;放行条件 M1a/M1b 推断型静默面登记 + **#73 预存 AOT struct 相等分歧登记**——poolAdd structspec 不去重→跨构造点 dist 恒 false,worktree 实锤归属 HEAD;MINOR m1 BIND c 界检查/m2 fields 双拷贝注记/m3 缓存 depth 注记/m5 fuzz check-valid 门候选 全落实/登记）；**1506 项全绿**(§98 18 check)；fuzz 三种子(44044/777/20261)×40 0 分歧、proof_fuzz 0 误报。原 v0.87 行：**v0.87 Slice[u8] + 窄型注解归一已交付(2026-11-19)**：ADR-009 S2——Slice[u8] 只读视图（`v.view(start,len)` 仅非 mut Vec[u8] 绑定；越界 M4003 视图变体三引擎逐字；方法面 len/get/at；**块内线性**——return/容器/传参/再绑定/lambda 块尾与捕获 → M3051[slice-escape] 编译期拒绝，零拷贝 base 同一性白盒；wasm 具名不资格/cc C1；证明面接入延后）+ **窄型注解宽度归一**（let/重赋值/传参/返回四边界按声明类型重标 V.int，tree 五边界 + VM ST/SET 规格 c/RET/帧建立双引擎对称——M1 预存语义缺口收口：`let a: i32 = 2147483647; a + 1i32` 静默收敛 M4002；wasm 窄型 let 门禁 analyze 具名条款 + clone 纵深防御）+ **闭包捕获归一三层断裂闭合**（snapshotEnv 补 tys/deepCopy closure 保留 tys/compileLambda 捕获规格透传——审查 MAJOR-2 追踪修复，v97.13）+ Slice == 静态拒绝（v96.18）+ 零校准审计；**独立审查 REQUEST_CHANGES（2 MAJOR 定向修复；tests/run.mjs 截断事故复核通过——恢复真实 26 行纯新增）修复后通过**；遗留边界四项登记（struct 字段/Vec 元素/无标注 lambda 形参/元组模式——值经 i64 标签位三腿一致静默，非分歧面）；**1488 项全绿**(§96 18 check + §97 14 check)；fuzz 双种子 ×40 0 分歧、proof_fuzz 0 误报。原 v0.86 行：**v0.86 流式第一片已交付(2026-11-19)**：**ADR-009 落盘**（流式·Slice 设计簇：read_bytes_range/Slice[u8]/带长度 Ptr/unsafe(cond) 一次设计分阶段；§7 维护者复核位）+ S1 最小流式 `std.fs.read_bytes_range(path, start, len) -> Result[Untrusted[Vec[u8]], str]`——范围读/短读截断合法/负参与 start≥size Err/`len=0` 短路 Ok 空（校验优先级锁定 v95.6/v95.14）/单次 8MB 上限保留（总量用户循环分段）/计费按实读（M4011 不被 Err 吞）/同源同污第三载体/仅普通文件；**>8MB 核心宣称机器证明 v95.13**（12MB+123 两段读拼接逐字节相等）+ v95.15 短读计费；文档诚实性修正（read_file 本无 8MB 上限、write_bytes 单次写入量口径、内存诚实注记 780MB、来源全景 9→12 源）；**独立审查 REQUEST_CHANGES（1 MAJOR——缺 >8MB 证明，实现面零缺陷）修复后通过**；**1456 项全绿**(§95 15 check)；fuzz 双种子 ×40 0 分歧、proof_fuzz 0 误报。原 v0.85 行：**v0.85 窄型算术一致性收口已交付(2026-11-18)**：intBin 窄型 fits 门——`+`/`*` number 快路径补 `!fits`、`/` 精确商后补 fits，**运行时携带窄 bits 的值**（后缀/as/to_*）溢出从静默回绕收敛为 M4002（`127i8+1i8`/`i32::MIN/-1`/u32 溢出三腿首行逐字；零校准审计；VM 经共享 intBin 单点覆盖）；**表述边界（审查 M1 登记）**：注解不产生窄型运行时值——`let a: i32 = 2147483647; a + 1i32` 仍静默，预存缺陷入 §4.13.7（v0.86+ 候选，修法=绑定/返回/传参按声明类型归一）+ M3013 无损拓宽 fix 族（快照 §6.4 唯一数据支撑：宽侧 i64/窄侧 bits≤32 的 Ident/字面量包 `(x as i64)`；u64 混算/复杂表达式/位移/按位/%/== 不发射；镜像分支 v93.22 锁定；窄结果位新报 M3002 边界 v93.23 记录）+ VM ADDI 两件（>2^53 合法和 BigInt 精确重算消除假 M4002；`-=` 消息按符号选模板与 tree 逐字）+ 独立审查 APPROVE-with-minor（0 BLOCKER；1 预存 MAJOR 登记+表述收窄，3 MINOR/5 NOTE 全落实）；**1441 项全绿**(§93 23 check + §94 13 check)；fuzz 双种子 ×40 0 分歧、proof_fuzz 0 误报。原 v0.84 行：**v0.84 观测与诚实性复批已交付(2026-11-18)**：coverage v0.84 复测（纯净副本插桩 1398 项全绿，**95.0% 行 / 90.3% 函数**，vm.js 99.0%/76.2%；死导入 `vec_get_i64/f64/str` 裁决不删登记 + 2 个 compat panic 导入登记）+ bench 第 6 项「契约 invariant 字段遍历」（4 字段/单字段 vm 1.65x、tree 2.08x——亚线性，刷新基线 WARN 0）+ AI 修正回路快照复测（24 形态重建；捕获 91.3% 不变 / 级联 **1.75→1.29**（最大 4x→2x）/ fix 发射 6 族 10 条=32.3% / **误导 7 种 9 实例→0**；语料入库 `tests/ai_loop_corpus/` 35 文件）+ **fits number 路径 bits=32 修复**（`1<<(bits-1)`→`2**(bits-1)`；to_i32 恒 None→正常、VM i32 ±1 假 M4002 消除——预存双引擎分歧同宗收口，§92 7 check 含回退红/绿验证）+ 文档诚实性批（references 5 处状态词 / capabilities 复算 55 行 42✅10🟡3❌ 无变 / N-66 实测口径限定：含 test 块回退源码模式 dist 含明文源）+ wasm 死导入注释；**独立审查 REQUEST_CHANGES（2 MAJOR 表述/登记面、代码实现面零缺陷）修复后通过**——新登记 3 项窄型算术预存分歧转 **v0.85 收口**；**1405 项全绿**(§92 7 check)；fuzz 双种子 ×40 0 分歧、proof_fuzz 0 误报。原 v0.83 行：**v0.83 引擎一致性收尾已交付(2026-11-18)**：M4004 消息四引擎统一——panic_m4004_op(TI+18 尾部追加,泛化 panic_m4004 索引 2 保留)kind 0/1=i64、2/3=u64 + cc PZ 去 specific 门,除零/取模零 × 两型 × main/eligible 四引擎首行逐字（§90 矩阵）；#58 cc 残留收口（vec_set 表达式级 span + 写 flavor 去读后缀，零校准）；**#72 缺陷收口**（i32::MIN 取负 tree 曾静默回绕 vs VM M4002——interp number 路径补 signed fits 门覆盖 i8/i16/i32 + vm UN 补 span，v91.9 三腿锁定）；取负 tree 位置缺口收口（negSlow 补 span，§87 承诺兑现）；LSP 占位符泄漏过滤；N-60.1 四位点 terminate 先于熔断 finally 收割 + N-61.2 tryWasm clone（实落 compiler.js——登记笔误，架构师复核成立）；校准 v87.22/v87 neg 解锁/v58.11 三校（#58 SET 后缀去除）/v91.9 行号（审查 B1）；**独立审查 REQUEST_CHANGES（1 BLOCKER——测试断言行号，实现面零问题）修复后通过**；审查 M1 登记 fits bits=32 number 怪癖（良性慢路，v0.84 候选）、M2 修正 §90 REJECT 配方措辞；**1398 项全绿**(§90 16 check + §91 9 check)；fuzz 双种子 ×40 0 分歧、proof_fuzz 0 误报。原 v0.82 行：**v0.82 污点 v1.3 窗口已交付(2026-11-18)**：ADR-008 清单 12 项全落地——argv = `Vec[Untrusted[str]]`（元素级，main 签名一次翻转不留 clean 旁路：净声明 → M3049，extern 返回强制先例；REPL/test 空参）/ 响应头 = `Untrusted[Map[str,str]]` **第四载体**（键值同污——键净方案否决归档；投影表 len/is_empty/get(净键)/has(净键)/keys/values，mut 面 M3050 只读；**实现偏差登记：ADR 写 contains_key，语言内净值谓词名为 has——同槽同名先例**）/ fs.metadata = `Result[Untrusted[Json], str]`；引擎面零新机制（Untrusted[Map] 形参 v0.61 顶层解包已覆盖；Vec[Untrusted[str]] 形参维持 vi64 句柄槽 = v80.17(a) 形态，元素级解包实测会翻 strict 语义已回滚——compiler.js 定案注释）；管线核验全过（serve worker 无 argv/spawn 构造净值/eval 内层空参/test 不调 main）；迁移实测 **20 位**（ADR 计 16 过时——xnsni/xnopen v0.81 落地 +2、net_e2e 2 位 ADR 漏计）：14 工具签名翻转 + args 消费面逐位处置（路径位 sanitize_cli_path/数值位 parse_i64/内容位保污透传）+ tests 4 位 + net_e2e parse_i64 端口惯用法（架构师裁决：URL 含 // 内部空段不可 sanitize，污点在数值校验上终结）；**edit.ming 内容位迁移缺陷实测修复**（审查后套件暴露：文本位误 sanitize 拒真实换行 → esc 改污进污出 + starts_with 净 bool 分类，v45.1 黄金恢复逐字）；M3049 remedy 载体感知扩 Map（审查 MINOR-1）+ CODE_HINTS.M3050 第四载体（审查 MINOR-2）；**独立审查 APPROVE-with-minor（0 BLOCKER/0 MAJOR/2 MINOR 全落实/8 项架构师登记全收口）**；**1373 项全绿**(§88 17 check + §89 23 check)；fuzz 双种子 ×40 0 分歧、proof_fuzz 0 误报。原 v0.81 行：**v0.81 引擎一致性小项清账已交付(2026-11-18)**：M4002 消息四引擎统一——N-65.4 分支 a：wasm 溢出检查经 panic_m4002_op(TI+17 尾部追加，泛化导入保留旧 AOT 逐字兼容)携带操作数，宿主按 tree/VM 同款模板组消息（6 kind 对齐 intBinSlow/negSlow，u64 asUintN 重解释）+ 架构师顺带收口 cc eligible 泛化残留（cbackend ctx.specific 门拆除）+ 修正 cc main 除法溢出预存偏差（tree 专属模板 `整数除法溢出:a / b`）——四引擎首行逐字（18 形态矩阵）；tree ContSig/BrkSig 纵深防御（v0.79 NOTE-1：brkContGuard → 具名 M4001，纯防御不可达）；json_query C0 序列化收敛（27 条 replace 与引擎逐字节对齐，良性路径零回归；孤立代理对分歧登记）；校准理由化 v63.37/v39 fn-ovf/v58.11 C 指纹（c62b5c0d…→c18cc21f…）；登记不预支 M4004 eligible 泛化分叉（含取模零）/取负 tree 位置缺口/Vec 复合赋值 VM 1 列差；**独立审查 APPROVE-with-minor（0 BLOCKER/0 MAJOR，4 MINOR 全落实）**；**1333 项全绿**(§86 11 条 + §87 22 条)；fuzz 双种子 ×40 0 分歧、proof_fuzz 0 误报。原 v0.80 行：**v0.80 AI 协作面第二波已交付(2026-11-18)**：fix 结构化处方扩面——发射族 4→9（M3015 nearest 改写·与消息后缀单一来源 methodNearFix/M3006 Json 点字段 → x.get("f")/M3004 声明处补 mut/M3008 str 拼接标量包 str(...)·整值浮点补 .0 保值等价——审查 MAJOR-1/M3012 插值包 debug(...)）；守卫面 = Untrusted 一律拒发（洗白禁令）+ 每族替换域与排除面锚定 + f-probe「应用后必消除」机器证明（快照 §0.6 方法学）；LSP 多文件补全第一切片——本地 use 导入成员补全/`use ` 行上下文补全（此前回落通用列表系错补，现仅 std.<mod> 全名 + 本地同目录模块名，按名排序）/std as 别名成员验证——保守原则不变；v70.8 重校准 = e14 语料 M3004 新 fix 为真实根因合法处方（v0.76 先例同型，审查 NOTE-1 复核诚实）；**独立审查 REQUEST_CHANGES（1 MAJOR + 3 MINOR）修复后通过**；**1300 项全绿**(§84 26 条 + §85 9 条)；fuzz seed 44044×40 0 分歧（C 腿 6，wasm 真实执行 20）、proof_fuzz 100 例 0 误报（反例 18/18）。原 v0.79 行：**v0.79 健壮性补刀第三刀已交付(2026-11-17)**：缺陷 #71 修复——lambda 体内 continue/break checker 漏洞（checkLambda 重置 inLoop + compiler 防御分支裸 POP 改具名 CompileError）；1260 项全绿(§82 8 条目)。原 v0.78 行：**v0.78 健壮性补刀第二刀已交付(2026-11-17)**：缺陷 #70 修复——VM for 内 match 臂 continue 双引擎分歧崩溃；根因 = match 宗量贯穿臂体留栈、Break/Continue JUMP 不清理活临时（for 崩溃/while 泄漏/break 静默泄漏三形态）；修复 = 纯编译器层 matchTemps 计数 + breakCtx 快照 + 前置 POP；无 match 形态字节码逐字节不变；**1251 项全绿**(§81 16 条目 18 check);fuzz 双种子 0 分歧。原 v0.77 行：**v0.77 内容源扩面已交付(2026-11-17)**：ADR-007 清单 14 项全落地——fs/net/proc 源翻转（read_file/read_bytes/list_dir/proc.stdout+stderr/http body）/污值代数 28 方法/json.parse 两域接缝闭合/write·print 出向透传/exec 双向（cmd sink）/第三载体 Untrusted[Vec[u8]]；审查 REQUEST_CHANGES（1 BLOCKER + 2 MAJOR）修复后通过——B1 parse_* Err 载荷 keepResErr 保污/M1 read_to_end 补裁翻转/M2 响应头登记不预支；**1225 项全绿**(§80 21 条 37 check);fuzz 双种子 0 分歧。原 v0.76 行：**v0.76 健壮性补刀 + fix 处方扩面已交付(2026-11-17)**：第五崩面 call-arg 嵌套收口（parsePostfix 三重入点计入 exprDepth，崩点实测 253）+ M3002 fix 族（3→4）+ M2002 eof 发射点；审查 REQUEST_CHANGES（2 MAJOR：M3002 Set.effects 死检查 / 六操作符起始 span 右界）修复后通过；**1186 项全绿**(§79 16 条);fuzz 双种子 0 分歧。原 v0.75 行：**v0.75 健壮性收尾已交付(2026-11-16)**：四残留裸栈崩溃面全面清零（checker 450/lexer 950/type 1450/pattern 2000/const 1200——阈值二分实测校准）+ 顺带 asm 表达式位 hint；独立审查通过+独立验证四判定全 PASS+RED FLAG 第五面登记 v0.76；**1173 项全绿**(§78 9 条);fuzz 双种子 0 分歧。**v0.74 内联汇编已交付(2026-11-16)**：with asm 第 13 效果门禁面（ADR-006 12/12 go，cc 独占+M4017 具名回落，fmt/lsp 配套，§77 28 位点）。**v0.73 技术债与观测收口已交付(2026-11-15)**：解析深嵌套守卫（裸栈 RangeError → 稳定 M2001,四挂点 try/finally,阈值二分实测校准 120——NOTE 收口）/coverage 复测刷新 94.8% 行·89.7% 函数（vm.js 74.2% 短板分析 + 补测 3 项）/GUIDE 交叉引用 15 行 29 引用 + 3 处漂移修正；checker 拆分维持 defer、ADR-006 不做（§4.9.2）；**1141 项全绿**(§76 9 条);fuzz 三种子 0 分歧。原 v0.72 行：**v0.72 诊断质量补刀已交付(2026-11-15)**：v0.71 审查 2 MINOR 收口——if 分支混型 M3049 对称化（checkIf 仿 match 双向接入,无双报经短路守卫实测）/M3049 remedy 复合载体精确化（直传位逐字不变,复合位中性措辞;struct 复合 actual 可产生经独立验证活反例证实）+ hint 位置中性化（审查 MINOR-1 就地修）;**独立审查通过（0 BLOCKER/0 MAJOR;2 NOTE 落实）+ 独立验证 5 项判定零 RED FLAG**;**1132 项全绿**(§75 8 项);fuzz 0 分歧;proof_fuzz 0 误报。原 v0.71 行：**v0.71 诊断残留收口已交付(2026-11-15)**：§4.8 五任务全兑现——salvage 精化（深度 0 `id(` 启发式，probe_anchor 真实 M3001 复活 1→2）/valBrace 块入口快照所有权（p21/p05/p06 伪诊断→真实诊断,s1 伪 M2002 清零）/嵌套污点 M3049 化五形态（m2b 等 M3002→M3049 统一净化 hint,直传与双侧污逐字不变）/#61 test 栈位置接线（undefined → file:line:col 三引擎逐字 + 预存 tree/VM 帧名前缀分歧一并修复）+ DX 顺带（N-68 fmt 回执/N-67 元组行/N-64 unstr_demo）；**独立审查通过（0 BLOCKER/0 MAJOR；2 MINOR 登记级）+ 独立验证 7 项判定全达成零 RED FLAG**；**1124 项全绿**(§74 17 项)；fuzz 双种子 0 分歧。原 v0.70 行：**v0.70 诊断校准二期已交付(2026-11-15)**：#63 parser 级联雪崩抑制——recover(false) 深度感知 panic-mode（`{}` 深度跟踪/停机表移除 test/强进路径修复）+ valBrace 污染钳制（独立审查 1 MAJOR 修复后通过）；独立验证 10 语料 44 条 4.4x → 18 条 1.8x，根因 10/10 逐字保留、干净形态逐字节不变、既有测试零校准；YELLOW 裁决（被吞区域不报 = panic-mode 固有代价）+ 残留 2 项登记 v0.71；**1103 项全绿**(§73 12 项)；fuzz 双种子 0 分歧。**v0.69 eval 已交付(2026-11-15)**：第 12 效果门禁面（ADR-005 §9 12/12 go——裸 builtin `eval(src) -> Result[str, str]`/内层恒 tree 裁决微调/Err 化 --json 同构载荷/M3049 sink 无净化器/配额按调用重置/build 具名回退/64 层嵌套守卫 + RangeError 兜底；独立审查 2 MAJOR 修复后通过；§72 20 项）+ #65 文档化处置（GUIDE 惯用法 + examples/serve_demo.ming 兑现 N-64 serve 示例）。**v0.68 Untrusted[Json]**（投影表/stringify 拒绝/as_obj 顺带修复）、**v0.67 诊断协议校准**（快照三判据 7→1/4→0/3.8→1.4）已交付——**诊断校准弧线收口**（v0.67 checker 层毒化收敛 + v0.70 parser 层级联抑制）；GUIDE 修订记录整段重复截断（2766→2002 行，审查 n1，v0.68 预存）。
> **下一步规划见 §4.15（第十三轮：评估驱动的收口任务单，2026-11-19，基线 v0.89.0/1524 项全绿）**：T1 核心命题对照实验（预注册）/ T2 冻结语言面→1.0-rc / T3 真实场景试点 / T4 工程收口 / T5 性能与分发 / **T6 编译器级优化（§4.16，O0 观测即启、O1+ 数据驱动）**；§4.14.5 版本路线被 §4.15.5 取代（v0.90 内容不变，LSP 第二切片/Option·Result/窄型 DX 转入冻结期后）。
> **前轮规划见 §4.13（第十一轮评估，2026-11-18，基线 v0.82.0/1373 项全绿：§4.12 P1/P2 清空后全面复扫——**v0.83 已交付**（引擎一致性收尾 + #72 缺陷收口——审查通过）+ **v0.84 已交付** + **v0.85 已交付** + **v0.86 已交付** + **v0.87 已交付** + **v0.88 已交付** + **v0.89 已交付**（同族归一收口：Map 值位/lambda 返回位/enum payload/M1a·M1b——审查通过）+ 同族遗留登记：Option·Result 载荷位(下一缺口)/#73 AOT struct 相等分歧+ v0.86 流式第一片（ADR-009 + rossum 数据在案）+ 污点微窗（read_to_end）/ P3 条件驱动（TLS/C ABI/asm 多架构/泛型缓存/证明扩大/serve 扩展族）/ P4 远期（async 确定性语义 ADR/流敏感污点/形式化）；前轮 §4.12 记录保留**。
> **前轮规划见 §4.12（第十轮评估，2026-11-17：能力缺口全面立项——P1 v0.80/v0.81 已交付（AI 协作面第二波 + 引擎一致性小项清账）/ P2 v0.82 候选（污点 v1.3 窗口：argv + 响应头·metadata——**ADR-008 已裁决落盘（2026-11-17，清单 12 项，响应头 = Untrusted[Map] 第四载体）**，待实现）/ P3 条件驱动（流式·Slice 设计簇 ADR-008 / serve TLS / C ABI 扩展 / asm 多架构）/ P4 远期（async-greenthread ADR-001 阶段 2 / 流敏感污点 / 证明面扩大）；v0.79 已交付——§4.11/§4.10）**。
> **§4.3 全部任务已清空（2026-11-13）**：v0.60 起以 ADR 条件交付——ADR-001（并发/服务端,方案 a 条件承诺实施,原型 190 req/s@40 连接）、ADR-002（污点采纳类型级 Untrusted[T],实现推迟）、ADR-003（mask 永久否决）；实现条件见各 ADR 评审清单与 §4.3.9。**三方评估后 serve 从 v0.60 移至 v0.62（独立条件版），v0.60 改为资源门禁一致性修复——理由与实测证据见 §4.4.10。**

---

## 0. 当前状态

| 项 | 状态 |
|----|------|
| 语言内核 | 显式类型/效果系统/值语义/确定性；树+VM+wasm+C 四后端 |
| C 后端 | C1 数值 → C2 str/Vec[i64] → C3 Map/Option/f64 打印 → C4 extern fn FFI（dlopen/dlsym）、`--static`；v0.53 `str` for-in 按 UTF-8 码点迭代；**v0.54 C5 `with unsafe`（Ptr[u8]/Ptr[mut u8] → unsigned char*/const unsigned char*、std.mem.alloc/free → malloc/free（失败 M4011）、extern 槽接受/返回 Ptr；tree/VM/wasm 回落 M4016）** |
| 构建 | `ming build` 真 AOT 字节码产物（无明文源）；`--with-source`；spawn/trait 自动回退；**v0.49 内容寻址缓存 + 接口哈希报告 + `--clean-cache`**；**v0.53 构建键 = 项目相对路径 + 内容 + Node 主版本，`--json` 带 build_key/dist_hash/cache_hit/source_count/interface_hashes（同 OS + 同 Node 主版本可复现 dist_hash）** |
| CI | **v0.53 GitHub Actions**：push/PR + nightly；`test` 九组合（ubuntu/macos/windows × Node 18/20/22）跑 run/fuzz/proof_fuzz；`c-backend` ubuntu/macos；nightly 三种子 120 程序 + proof_fuzz 300；官方 action、零 npm 依赖（`.github/workflows/ci.yml`） |
| 自举工具 | 14 个全部 Ming 自写（mingkit 文件补丁 / edit 行级编辑 / engdiff 引擎差分 / diaghot 诊断热力图 / wc·tree·find·json·todo·log·rename·organize 日用小工具）；v0.51.6 起统一错误纪律（stderr + 失败退出 1）并全部 fmt 规范；`ming tools` 统一入口 + `--` 透传 + **v0.57 工具 AOT 缓存**（14 工具全缓存零回退；`MING_TOOLS_DEBUG=1` 观测缓存决策） |
| 质量护栏 | 回归全绿（v0.99.0 起 **1627 项**，§110 P1 创建点过滤 15 check；v0.98.0 **1612 项**/§109 9 check；v0.97.0 **1603 项**/§107 9 + §108 8 check；v0.96.0 **1586 项**/§106 11 check；v0.95.0 **1575 项**/§105 9 check；v0.94.0 **1566 项**/§104 15 check；历史：v0.89.0 **1524 项**；§99 为 v0.89 同族收口 **18 check**；v0.88.0 时为 **1506 项**（§98 **18 check**）；v0.87.0 时为 **1488 项**（§96 **18 check** + §97 **14 check**）；v0.86.0 时为 **1456 项**（§95 **15 check**）；v0.85.0 时为 **1441 项**（§93 **23 check** + §94 **13 check**）；v0.84.0 时为 **1405 项**（§92 **7 check**）；v0.83.0 时为 **1398 项**（§90 **16 check** + §91 **9 check**）；§90 为 v0.83 M4004 统一 **16 check** + §91 为 v0.83 位置/占位符/卫生 **9 check**；v0.82.0 时为 **1373 项**（§88 **17 check** + §89 **23 check**）；§88 为 v0.82 污点 v1.3 **17 check** + §89 为 v0.82 迁移纪律 **23 check**；v0.81.0 时为 **1333 项**（§86 **11 条** + §87 **22 条**）；v0.80.0 时为 **1300 项**（§84 fix 处方 **26 条** + §85 LSP 切片 **9 条**）；v0.73.0 时为 **1141 项**，§76 为 v0.73 深嵌套守卫与覆盖补测 **9 条**，§75 为 v0.72 补刀 **8 项**，§74 为 v0.71 残留收口 **17 项**，§73 为 v0.70 parser 级联抑制 **12 项**，§72 为 v0.69 eval **20 项**，§71 为 v0.68 Untrusted[Json] **18 项**，§70 为 v0.67 诊断协议校准 **14 项**，§69 为 v0.65 wasm slice 3 **19 项**，§68 为 v0.64 信任边界 **21 项**；§67 为 v0.63 wasm 守护收口 slice 2 **28 项**；§66 为 v0.62 服务端 v1 **22 项**，§65 为 v0.61 污点窄源 v1 **40 条**，§64 为 v0.60 资源门禁一致性 **24 项**（A 组 4 + B 组 9 + C 组 11），§63 为 v0.59 wasm 覆盖/本地函数/invariant bench + P1/P2 审查修复 **56 项**；§62 为 v0.58 LSP/join/doc/Release **34 项**；§61 为 v0.57 循环义务 19 + tools 缓存 6 + 观测冒烟 2 共 **27 项**；§60 为 v0.56 引擎一致性/契约保真/wasm 语义/独立审查 70 项；§59 为 v0.55 跨函数契约摘要 42 项；§58 为 v0.54 `with unsafe`/C5 + 独立审查 20 项；§57 为 v0.53 可信构建 31 项）+ 多后端差分模糊（四腿 + **v0.56 fuzz 真实 wasm 腿**:eligible helper 断言 `[wasm] fn OK` 并计数）+ proof_fuzz（边界证明模式 1/2 + v0.55 summaries 模式 + **v0.57 loops 模式** 0 误报/反例独立求值器三重验证）+ bench（cc 腿 + **v0.57 Δ基线对比** + **v0.59 invariant 项**）+ **v0.57 覆盖率基线 + v0.59 复测 + v0.60 全表 + v0.73 复测刷新**（tests/coverage.mjs；**94.8% 行 / 89.7% 函数**，vm.js 74.2%；2026-11-15 快照,信息性不设门槛） |
| 能力矩阵 | 55 行口径 ≈85%（docs/capabilities.md；v0.69 eval 行 ❌→🟡(ADR-005 12/12 go + 随版交付):42✅ 10🟡 3❌（约 85%；T4.4 校验器锁定）；历史：v0.61 新增"数据流安全(污点标注)"行(✅,窄源 v1)、v0.62"TCP/UDP/服务端"行 ❌→🟡(serve v1)、v0.68 污点行载体扩面(保持 ✅)；"运行时资源熔断"经 2026-11-13 评估改判 🟡 后于 v0.60 修复恢复 ✅） |
| 下一步 | **当前 v0.96.0**(2026-11-20,1586 项全绿,本地=GitHub 同步)。**§4.15/§4.16 交付态**:v0.90 T2.1 ✅ / v0.91 T4.1·T4.3·T4.4 ✅ / v0.92 T5.2 ✅ / v0.93 T5.1 ✅ / v0.94 O1 首批 ✅ / v0.95 O1b 窥孔 ✅ / **v0.96 O1c 常量传播 ✅（审查 APPROVE-with-minor；opt_gate 374）——O1 四 pass 全部交付**。下一步候选（待维护者裁决）：O2 拷贝消除（O0 实证最大热点）或 T2.3/T2.4 稳定性契约+1.0-rc（前置 T2.2 冻结令确认）。**待维护者裁决**:T2.2 语言面冻结令(确认后 v0.94 = T2.3 稳定性契约 + T2.4 1.0-rc 准入清单 + 英文 GUIDE 关键章节)。**独立并行未开工**:T1.* 对照实验(核心命题证据)/ T3.* 场景试点(前置 T2.3)。**T6 优化线**:O0 ✅ / O1(v0.94 候选,常量折叠/DCE/窥孔/常量传播逐 pass)/ O2 拷贝消除(v0.95 候选,O0 实证最大热点)。**冻结期后**:§4.15.7(LSP 第二切片/Option·Result 载荷位/窄型 DX/checker 拆分/S3·S4 等)。**登记未修 P3**:#74/#75/#76 + bench WARN 口径。孤儿小项已清:plan §0 行/GUIDE 归一机制节(§3)/coverage 复测登记。 |


## 1. 已完成的规划项（v0.39–v0.44）

- v0.39 C 后端 C1 + wasm 层四项休眠 bug 修复 + ffi 设计
- v0.40 C2（str/Vec）+ engdiff 自举工具 + 模糊器 cc 族
- v0.41 C3（Map/Option/f64 打印）+ cc 差分腿覆盖 v0.41 声明形态（`str` for-in 于 v0.53 补齐）
- v0.42 `with ffi` 兑现（extern fn + 效果门禁 + M4013）+ `--static`
- v0.43 ffi 字符串桥 + Result 进 C 面 + 真 AOT 字节码产物 + `with unsafe` 设计
- v0.44 W3104 过拟合检查 + 结构化修复处方（fix）+ diaghot + `mask` 设计定稿；
  连带修复 unify 缺 json 分支、VM match-return 栈残留

---

## 2. v0.45 — 契约系统阶段 1（requires / ensures / invariant，运行时检查）

**目标**：把"安全是默认"从运行时 panic 前移到**签名里的可检查契约**；为阶段 2 的静态证明打语法与语义基础。

**设计要点（Ming 风格）**

- 语法：
  - `fn f(a: i64) -> i64 requires a > 0 else "a 必须为正" { ... }`
  - `fn f(a: i64) -> i64 ensures result >= a else "结果不小于输入" { ... }`（`result` 在 ensures 中绑定返回值）
  - `struct S { x: i64, invariant x >= 0 }`（构造后与 `mut self` 方法返回后检查）
- 语义：
  - 契约表达式必须是**纯表达式**（无效果；checker 用现有效果机制禁止 io/fs/... 调用）；
  - 违反契约 → **panic 新码 M4015[contract-violation]**，消息含条件文本与操作数值（与 M4002 风格一致），退出码 101；
  - 检查时机：requires 在函数入口；ensures 在每个 `return` 前（含尾表达式返回值）；invariant 在构造字面量与 `mut self` 方法退出时；
  - 契约不改变求值语义，只增加检查点。
- 边界（v1 不做）：不写静态证明（阶段 2）；不写跨函数契约推导；不写 panic 恢复。

**任务拆分**

1. `src/parser.js`：`requires`/`ensures` 子句 + struct `invariant` 解析（保留字升级注意：`requires`/`ensures`/`invariant` 目前是否保留字需查 `RESERVED`）。
2. `src/checker.js`：契约表达式类型检查（bool、纯）+ 错误定位；`result` 绑定仅在 ensures 作用域。
3. `src/compiler.js` + `src/interp.js`/`src/vm.js`：入口/返回/构造检查点发射与执行（双引擎一致）。
4. `src/diag.js` + `docs/diagnostics.md`：M4015 登记（消息格式：`契约违反: <条件> (实际: <绑定值>)`）。
5. `tests/run.mjs` §40：正例（满足契约）、反例（M4015 消息/退出码/双引擎一致）、纯性检查（契约内调 print → M3029 类错误）、`result` 绑定。
6. 文档：GUIDE 语法节 + 修订记录 v0.45.0；README 路线图。

**验收**：契约程序在三引擎（tree/VM/wasm 不适用则双引擎）行为一致；M4015 逐字稳定；套件全绿。

---

## 3. v0.46 — 契约阶段 2 第一片（已完成，2026-11-11）

- **M3040 invariant 字段封装**：带 invariant 的 struct，字段只能在自身 impl 方法内修改（外部字段写 → 编译错误；通过 implTypeName 比对放行）。无 impl 的 invariant struct 字段构造后即封装。
- **M3041 调用点静态契约校验**：全部实参为整数字面量时，代入 requires 求值（线性子集：IntLit/Ident/一元 - !/+-*/%/比较/&& || 短路；除零与 i64 溢出放弃判定）；可判定为假 → 编译错误 M3041 + 反例（`amount = -5`）与 else 消息。字面量违反从运行时 M4015 前移到编译期。
- **P0 修复**：invariant struct + 缺 for 的 impl → 解析恢复把 `fn (mut self)` 注册为顶层函数（裸 self type=null）→ 检查器崩溃；修复 = resolveSigs 标记 poisoned + checkBodies/compiler 跳过。

## 4. v0.47 — 契约阶段 2 完成（2026-11-11）✅

### 4a. 契约阶段 2 剩余
- **mut 方法退出时的 invariant 重查**：✅ 已完成（v0.47）——实现取派发点重查方案（callMethod struct 分支，mut-self 方法返回后以接收者字段重查；比合成隐藏函数更简单且树/VM 共用同一份代码）。
- **QF_LIA 边界证明子集**：对 `requires offset >= 0 && offset + 4 <= buf.len` 形态的线性整数算术做编译期证明，
  证明成立时允许块内免检访问（配合未来 `with unsafe`）；证伪时给出**具体反例**（Jenny 风格）。
- 交付：`src/prover.js`（限定子集）+ 新诊断码（证明失败/未证明）+ 示例 + 测试。
- 风险：证明器工程量大；先做 1-2 个模式（越界包含、非负性），不做通用求解。
- 前置：M4015/M3040/M3041 已落地（v0.45/v0.46）。

### 4b. 构建缓存：接口哈希 ABI 防火墙（✅ v0.49 已交付，2026-11-11）
- 交付（v0.49）：`ming build` 内容寻址缓存——键 = 编译器版本 + 项目全部 .ming 源 + ming.toml + `--with-source`（过包含保健全）；命中且 dist 完整 → 跳过检查与编译。
- 接口哈希：每模块 decl 规范化序列化（签名/参数名/效果/requires/ensures/字段/invariant/变体/trait 方法/impl；排除函数体与 span），sha256 前 16 位；构建输出报告 `接口哈希:未变 N 个,变更 <文件>`；§44 测试锁定"改实现不改接口 → 哈希稳定 / 改签名 → 变更"。
- `--clean-cache` 清理缓存与 dist 并全量重建；缓存文件 `.ming-cache/build-cache.json`（入 .gitignore）。
- 说明：本版为**项目级**缓存（命中即整体跳过）；函数级模块化缓存（内容寻址代码，Backlog）留待项目规模增长后。

---

## 4.1 v0.48 — QF_LIA 证明子集第一片：ensures 直线体静态验证（✅ 已完成，2026-11-11）

- **决策依据**：bench 实测 cc/vm 6–11x（运行期健康）；`ming check` 全程 126ms（当前规模编译非瓶颈）→ 3b 构建缓存当下收益微弱；3a 在契约关键路径上补"编译期保证"能力,且复用 v0.46 的 evalContractExpr 基建。
- **范围（模式 1）**：M3042[ensures-statically-false]——对含 ensures 的函数做**直线体符号执行**（Let/Assign/Return；遇 If/While/For/Match/调用/非 i64 参数静默放弃）,变量追踪为参数的线性形式;返回点将 `result` 绑定为返回值形式,对 ensures 求值：可证明为假 → 编译错误 + 反例（requires 满足的小值搜索,复用 evalContractExpr）；可证明为真/无法判定 → 静默（运行时 M4015 保留,语义不变）。
- 交付：checker 符号执行 + 诊断码 M3042 三处登记 + §43 测试 + 文档。

## 4.2 v0.52+ 路线(software-architect 规划,2026-11-11)

> **状态(2026-11-12):v0.52–v0.56 路线已全部交付**(v0.52 QF_LIA 第二片 / v0.53 可信构建与跨平台验证基线 / v0.54 `with unsafe` C5 / v0.55 跨函数契约摘要 / v0.56 引擎一致性与缺陷清零)。本节已无待办计划任务;下一步方向见 §4.3.8 Backlog(v0.57+)与 §5.1 已知缺陷 #37–#49。

> 基线:v0.51.5,534 项测试全绿,四后端差分 0 分歧;§5.1 的 16 项审查缺陷已清零。
> 总原则:**先装安全带,再讲解开安全带的规则**——验证基础设施先于危险能力;一版一个语义面;
> 证明只报告、不先删检查;危险能力签名与块级双可见;每版可独立回退。

### 4.2.1 现状判断

- **强项**:四后端(树 / VM+wasm / VM-only / C)+ 差分模糊构成语义合同;效果门禁已闭合到函数值;
  契约有运行时检查与两片静态检查;诊断码稳定且带 span/hint/JSON;652 项回归是可信基线(v0.54 起)。
- **风险**:证明器只覆盖直线体 `ensures`,越界/调用链/循环仍空白,"证明 → 许可"闭环未建立;
  `unsafe` 已于 v0.54 交付(C5,effect-gated,tree/VM 诚实拒绝),`mask` 仍是设计稿(v0.56+ 评估)。**v0.53 已装第一道安全带**:CI 九组合矩阵 + nightly 深模糊,
  跨平台门禁不再依赖单机;strict wasm(`--strict-wasm`)让静默回落成为可见失败(exit 2)。
- **已知债务(本规划核实)**:
  - ✅ v0.53 已修复:`collectProjectSources` 共享累加器导致重复条目(旧实现 4 文件收 11 条,
    新实现 4 条:项目相对路径 + 内容去重);旧实现同 basename 不同目录交换内容后**构建键不变**
    (漏检/脏命中),现为"项目相对路径 + 内容"并注入 Node 主版本。
  - ✅ v0.53 已复核:文档漂移(GUIDE 头 v0.48 / capabilities 头 v0.38 / plan §0 471 项 / M3030 效果列表);
    本次收口再次对齐 GUIDE/capabilities/README/plan/AGENTS 的版本与数字。
  - ✅ v0.53 已改写:README "cc 差分腿 = 解释引擎全形态"属过度声明(C 缺 `str` for-in);
    现为"覆盖已声明 eligible 形态 + 未覆盖清单",且 `str` for-in 已按 UTF-8 码点补齐。
- **最短板**:不是语言表面不够多,而是"检查 → 可证明、可复现、可跨平台验证"的闭环尚未形成。
  **v0.53 已建立可复现与跨平台验证基线**(构建键/CI/env -i);剩余闭环是 v0.54–v0.55 的证明→许可链。

### 4.2.2 关键 ADR（v0.52 规划期裁决记录；编号已被 docs/adr-00N 文件系列取代——ADR-001 并发选型见 docs/adr-001-concurrency.md，污点/mask 裁决见 docs/adr-002-taint.md、docs/adr-003-mask.md，避免撞号混淆）

| ADR | 决策 | 理由 | 影响 |
|-----|------|------|------|
| ADR-001 | `unsafe` 仅在 C 原生后端执行;tree/VM 确定性拒绝(M4016);wasm 资格继续拒绝 | JS 引擎无法诚实模拟裸指针;伪指针会引入与 C 不一致的"安全兜底";与 extern ffi 的原生限定先例一致 | 四引擎合同出现**明示例外**:tree/VM 验证拒绝行为,C 验证执行行为;写入 GUIDE/design |
| ADR-002 | `mask [效果]` 本阶段不做(v0.56+ 评估) | 会让纯签名执行 IO,破坏"签名即效果真相";wasm/C 资格与契约纯性都读 `sig.effects`;且无资源句柄类型/逃逸分析 | 本阶段由 C 后端补全替代;mask 需独立 ADR 与审计报告 |
| ADR-003 | 边界证明不消除运行时检查 | 证明器尚未形式化验证;先积累 proof-vs-runtime 模糊证据;删检查属 codegen 语义变更 | v0.52/v0.55 冻结 `compiler/interp/vm/cbackend/artifact` |

### 4.2.3 v0.52 — QF_LIA 第二片:越界包含静态验证(只证明,不改 codegen)✅(2026-11-12 完成)

**目标**:从 `requires` 的线性边界证明每个 `Vec` 索引点在界内;可证违反 → M3045 + 反例;未证明不阻断、不误报。

**范围**:i64 参数、非 `mut` 的 `Vec` 参数、`requires` 中的 `buf.len()`、直线体(Let/Assign/Return/纯调用语句)、单个索引点。
**不做**:循环、分支路径敏感、局部别名、`mut Vec`(push/pop 改长度)、通用 SMT、非线性、消除 M4003、任何 codegen 修改。

**任务**(全部完成,三阶段由中断会话交接后收口):
1. ✅ 抽出 `src/prover.js`:线性形式(v0.48 原样迁出)/差分约束(Bellman-Ford 全 0 初始化负环检测,变量 ≤12,BigInt 权重,锚点 SRC 编码绝对约束);checker 只留 AST 适配与诊断。§43 的 M3042 行为逐字不变(§56 黄金锁定)。
2. ✅ 边界证明遍:`x.len()` → `len$x`(仅限被追踪的非 mut `Vec[i64]` 参数);比较归一化为差分约束(严格 `<` 转 `c-1`;`==` 拆双向;`!=`/`||`/非线性/系数非 ±1 保守跳过);索引点义务两向证明 `0 <= i` 与 `i < len$base`;假设集负环(requires 自相矛盾)整函数跳过。
3. ✅ 诊断与反例:M3045[index-bounds-violated](error,含义务与反例;i64 参数 ∈ {-2..2}、len$x ∈ 0..8 确定性枚举,仅枚举相关变量);未证明仅在 `--warn-unproven-index` 下发 W3105[index-bounds-unproven](warning,不改退出码)。
4. ✅ 证明报告:`ming check --proof-report` 文本摘要(逐函数 义务/proven/violated/unproven);`--json --proof-report` 增加 additive 的 `proofs` 字段(逐义务 {file,fn,index,kind,obligation,line,col,counterexample});不带旗标时 JSON 与 v0.51.6 逐字一致(HEAD CLI 对照 + 黄金快照双锁定)。
5. ✅ 测试 §56(26 项 ≥ 12:原 23 项 + 审查修复 3 项):可证真/边界严格性(`<=` 不蕴含 `<`)/可证违反+反例/mut Vec 与 mut i64 重赋值/循环/别名/非线性静默/警告旗标 W3105 逐字/无 requires 不警告/无旗标 JSON 不变(HEAD 对照 + 快照 + proofs 键缺失)/运行时仍 M4003(双引擎 101)/负环跳过/--proof-report 文本与 JSON/复合索引原文完整;审查修复 3 项(反例过滤最小奇数解逐字 + 反例满足被跳过叶子属性 + 已有 error 文件 W3105 门控)。
6. ✅ `tests/proof_fuzz.mjs`:模式 1(0 误报)——生成器保证实参满足 requires,凡 proven 义务断言 `run`/`run --tree` 退出 0 且无 M4003/M4015,可证类另断言必须 proven;模式 2(反例验证)——独立实现的线性求值器(不 import prover.js)验证 M3045 反例满足 requires 且越出义务侧;负控(不可编码 requires)必须静默。文档:GUIDE §6 契约与静态边界证明节 + 修订记录、diagnostics M3045/W3105、README 路线图/状态段。

**验收**(2026-11-12 实测,含审查修复后复测):`node tests/run.mjs` 597 项 0 失败(§56 26 项:23 项 + 审查修复 3 项);`proof_fuzz --count 200` 0 误报、反例验证 35/35(异种子抽查另过);`fuzz --seed 44044 --count 40` 0 分歧;`check --proof-report` 输出 proven/violated 逐函数统计;`git diff` 对 compiler/interp/vm/cbackend/artifact 为空;check 语料耗时 ≤1.2x v0.51.6 基线(信息性)。
**审查修复**(2026-11-12 独立审查 6 项,全部落实):M3045 反例按被跳过但可求值的 requires 叶子过滤(满足完整 requires;无候选退回无反例消息)·`--warn-unproven-index` 下文件已有 error 不叠加 W3105·lenSeen 死代码删除·prover.js 头注释改写当前职责·GOLDEN_DIAG 快照分隔符无关化·diagnostics.md CRLF → LF。
**风险/回退**:误报 M3045 —— 用"非 mut Vec + 直线体 + 假设一致 + 差分约束"四重门控;出问题关闭对应模式(保留 W3105 观测),运行时语义未动。

### 4.2.4 v0.53 — 可信构建与跨平台验证基线 ✅(2026-11-12 完成)

**目标**:让"通过"在 Linux/macOS/Windows × Node 18/20/22 可复现;wasm 静默回落成为 CI 可见失败;构建键真正由"路径 + 内容"决定。

**任务**(全部完成,2026-11-12 收口):
1. ✅ **CI 矩阵**:`.github/workflows/ci.yml`——`ubuntu/macos/windows × Node 18/20/22` **九组合**跑 `tests/run.mjs`、`fuzz --seed 44044 --count 25`、`proof_fuzz --count 100`;C 腿在 ubuntu/macos 单独 job(Node 20,先探测 gcc/clang,无编译器则自跳过);nightly 三种子 `fuzz --count 120` + `proof_fuzz --count 300`。只用官方 action(actions/checkout@v4、actions/setup-node@v4),零 npm 依赖;PR/push job 超时 20 分钟,nightly 40 分钟。workflow 以 PyYAML 做本地语法/结构静态校验(本机不代跑 Actions)。
2. ✅ **strict wasm**:`--strict-wasm` / `MING_WASM_STRICT=1`;`run --json` 增加 additive `wasm_status: none|ok|fallback`(check 仅在 strict 时输出聚合值);eligible>0 但编译/实例化回落 → 退出码 2 并点名函数与原因;与 `--tree`/`--no-wasm` 互斥(冲突 exit 1);判定抽成 `src/wasm.js` 的 `wasmLayerStatus` 纯函数,§57 直测三态并覆盖 fallback。
3. ✅ **`env -i` launcher 验收**(§57):最小环境 + 无关 cwd + 删除源目录后的 dist 异地拷贝;POSIX 用 `PATH`/`LANG=C.UTF-8`,Windows 只保留 `SystemRoot`;输出/退出码/panic 首行逐字一致,多字节 UTF-8 实参按字节透传。
4. ✅ **构建可信性**:修复 `collectProjectSources`(递归返回本次新增条目,条目 = 项目相对路径 + 内容,注入 Node 主版本);`ming build --json` 增加 `build_key/dist_hash/cache_hit/source_count/interface_hashes`;回归:同名不同目录交换内容 → 键变化;两次 `--clean-cache` 构建 `dist_hash` 相同;第三次 `cache_hit: true`。只承诺"同 OS + 同 Node 主版本可复现"。
5. ✅ **C 后端 `str` for-in**:按 UTF-8 码点迭代(非字节);ASCII/CJK/emoji 三组黄金测试逐字一致(tree / VM(该形态 wasm 回落)/ VM-only / cc);fuzz 增加 `for ch in s { v += ch.char_len() as i64; }`;Backlog 关闭 for-in 缺口(trim 族已于 v0.51.3 完成)。
6. ✅ **文档真实性审计**:GUIDE/capabilities/README/plan/AGENTS 数字与版本头;无法被测试证明的表述改为"已声明覆盖范围 + 未覆盖清单"(C 后端 diff 腿、能力矩阵覆盖率)。

**验收(2026-11-12 实测)**:`node tests/run.mjs` **628 项 0 失败**(§57 共 31 项 v53.*:strict wasm 7 + 构建可信性 6 + env -i 3 + C str for-in 3 + CI/版本收口 2 + 尾表达式 wasm 1 + 独立审查修复 9);`fuzz --seed 44044 --count 25` 0 分歧;`proof_fuzz --count 100` 0 误报;两次 clean build `dist_hash` 相同、第三次 `cache_hit: true`(§57 v53.10/11);`env -i` 输出逐字一致(v53.14-16);strict wasm 对 §57 eligible 语料 `ok`、零 eligible `none`、回落语料 exit 2(v53.1-7/v53.22;其他既有回落形态如 f64+while/if 表达式由 strict 如实报告,已登记 Backlog);CI workflow 结构静态校验通过(test 九组合 + 示例 fib strict 步 + c-backend 两组合 + nightly 三种子 / timeout 20/40 分钟;GitHub runner 实际矩阵结果以仓库 Actions 记录为准,本机无法代跑)。**审查追加**:strict 暴露既有 wasm 尾表达式模块校验回落(函数级补零多压栈),已修并加 v53.22 回归——`examples/fib.ming` 现 strict `ok` 且真实经 wasm 执行。**v0.53.0 独立审查修复(9 项阻断/次要,§57 F 节)**:B1 同名文件 fixture 真的能测出 basename 键缺陷;B2 check strict fallback 与正常路径共用 out(ok/diagnostics/proofs/wasm_status,文本先 printDiags 再报原因);B3 C 后端容器/区间 for-in 循环变量落入内层作用域(遮蔽程序不再发射非法 C);M1 `--no-wasm` 不输出 wasm_status;M2 Module 校验/实例化回落点名疑似函数 + eligible 表;M12 wasm `/` 守卫 opcode 与 if 位置修复(含 `/` 的 eligible 函数现 strict `ok`);M6 测试夹具默认剥离 MING_WASM_STRICT;M7 `build --json` stdout 纯 JSON;M9 CI 增加示例 fib strict 步。
**风险/回退**:CI 抖动 —— C 腿独立 job、nightly 独立 job;strict wasm 误判 —— `none` 白名单 + 纯函数单测;构建键修复使旧缓存全部失效(一次性成本,文档说明)。

### 4.2.5 v0.54 — `with unsafe` 最小实现(C 原生,效果门禁)✅(2026-11-12 完成)

**目标**:用最小 `Ptr` 面兑现"受控不安全":签名与块级双可见;C 真实执行;tree/VM 确定性拒绝。

**范围**:`unsafe { ... }` 块;`Ptr[mut u8]`/`Ptr[u8]`;`load/store/offset/is_null`;`std.mem.alloc/free`;extern 签名中的 Ptr;C5;tree/VM M4016;效果名 `unsafe`。
**不做**:Ptr 算术(除 offset)、Ptr↔整数、打印/相等、生命周期/逃逸分析、内联汇编、mmap、`unsafe(cond)`、JS 伪指针。

**任务**(全部完成,2026-11-12 收口):
1. ✅ 类型/语法:`{k:'ptr', el, mut}`;`Ptr[mut u8]` 解析;`typeStr`;unify 精确匹配;禁止索引/算术/==/插值/debug/JSON/Map 键;方法 `load/store/offset/is_null`(元素仅 u8,M3002 提示)。
2. ✅ 效果/检查器:`unsafe` 入 KNOWN_EFFECTS;`unsafe {}` 需函数声明 `with unsafe`(M3029);指针操作/Ptr 实参必须在块内,否则 M3046;块外只允许 let/赋值/return 传递与 is_null。
3. ✅ C5:资格增加 C 专用 unsafe 扩展(效果 ⊆ {ffi, unsafe},wasm 不传 `opts.unsafe`);Ptr → `unsigned char*`/`const unsigned char*`;alloc/free → malloc/free(失败 M4011);extern 槽位支持 Ptr;`--emit-c` 快照;`ming build` 遇 `with unsafe` 显式回退源码模式。
4. ✅ tree/VM 诚实拒绝:M4016[native-only-feature](panic,101),消息"unsafe 指针操作仅在 C 原生后端可用";tree/VM 逐字一致;wasm 继续拒绝 unsafe 函数,主程序回落 VM 得到同一 M4016。
5. ✅ 测试 §58(14 项):C 黄金程序(v58.7)/只读 Ptr 不可 store(v58.2)/块外 load → M3046(v58.5)/无 with unsafe → M3029(v58.4)/Ptr 实参传纯函数 → M3046(v58.5)/check 通过(v58.6)/tree/VM/wasm M4016(v58.6)/emit-c 含 `unsigned char*`/`malloc`(v58.8)/既有 C 差分零变化(v58.11)/**Ptr 别名面(v58.12)**/**offset 链式 C 黄金(v58.13)**/**unsafe 效果传播(v58.14)**。
6. ✅ 文档:design.md §6.10 改为块形式并说明不用 `unsafe(expr)` 的理由;GUIDE §14.1 unsafe/std.mem 节 + §18 std.mem + C5 工具链行;diagnostics M3046/M4016 措辞核对;README/AGENTS/capabilities/plan 数字与版本收口。

**验收(2026-11-12 实测)**:`node tests/run.mjs` **646 项 0 失败**(§58 共 14 项 v58.*);`check examples/unsafe_demo.ming` 0 诊断;`cc examples/unsafe_demo.ming` 输出 `65/66/false`;`run --tree`/`--no-wasm` exit 101 + M4016 首行逐字一致;`fuzz --seed 44044 --count 25` 0 分歧;`proof_fuzz --count 100` 0 误报;`fmt examples/unsafe_demo.ming --check` 通过;既有 C 差分零变化(v58.11 抽查 + 全量套件内 C 腿);`--strict-wasm` 对 unsafe 程序不误报 ok(未进 wasm 资格)。**Linux/Windows C 黄金一致**:本机 Windows(w64devkit gcc)实测;Linux 由 CI c-backend job 承载(本机无法代跑)。

**v0.54.0 独立审查修复(2026-11-12,§58 v58.15–v58.20)**:B1 `UnsafeBlock` 接入控制流分析(`stmtTerminates`/`hasBreak`;块内 return 为最后语句不再误报 M3017;`loop { unsafe { break; } }` 类型为 unit,装 i64/Ptr → M3002);B2 C 后端 unsafe 块发射独立 C 作用域(遮蔽写法 cc 输出 2/1 与 VM 一致);B3 M3046 覆盖容器/构造器载荷逃逸(`typeContainsPtr` 递归:Vec/Map/Option/Result/元组/结构体字段/枚举载荷;泛型调用点按实参类型判定,泛型体内擦除跳过);B4 unsafe 块内闭包函数类型携带 `unsafe` 效果(赋给纯函数类型 → M3029,块内直接调用允许);B5 #27 修复(`use std.x [as y]` 短名在字节码编译器可解析;compileNamedValue 读 imports → `__stdmod:<真实模块名>`;编译器未解析名 → 带 file:line:col 的 M4001 诊断)。M1 Ptr 方法防御 M4016;M4 固定非 unsafe 程序 C 渲染指纹逐字节回归;M6 示例比较退出码 + stderr 首行。新登记 #28/#29/#30 见 §5.1。**验收实测**:`node tests/run.mjs` **652 项 0 失败**;`fuzz --seed 44044 --count 25` 0 分歧(一致 25,其中 C 腿 7);`proof_fuzz --count 100` 0 误报(反例验证 18/18);`cc examples/unsafe_demo.ming` 输出 `65/66/false`;tree/VM/wasm 回落 M4016 首行逐字一致(exit 101);B1 三例/B2 遮蔽 2/1/B3 块外 7×M3046 与块内 0/B4 M3029 反例/B5 `use std.mem` 三路与 `use std.math` 5.0 均实测。
**风险/回退**:悬垂/越界解引用是进程级 UB,Ming 不捕获(GUIDE §14.1 诚实声明);v1 限定 u8、禁止算术/打印;特性 effect-gated,可整体回退。

### 4.2.6 v0.55 — QF_LIA 第三片:跨函数契约摘要 ✅(2026-11-12 完成)

**目标**:用"直线体 + 线性契约"的函数摘要,让调用链上的 ensures 可证明;绝不假设未证明的前置条件。

**范围**:i64 参数/返回、纯函数、直线体、无环调用图、单条 requires/ensures、摘要代入、调用点前置条件证明。
**不做**:循环/分支、递归/互递归、高阶函数、效果函数、堆/别名、通用 SMT、运行时语义变更。

**任务**(全部完成,2026-11-12 收口):
1. ✅ 摘要引擎(prover.js):`computeSummaries` 调用图 Tarjan SCC 环检测 + 被调方优先拓扑序;递归/互递归标记 `noSummary`;摘要 = {requires 声明, ensures 仅在已证明时作为后置条件};requires 不完整/环上 → ensures 一律不采用。
2. ✅ 调用点前置条件:实参线性形式代入被调 requires,用当前函数 requires 假设证明;可证违反 → M3041 + 反例;无法证明 → 放弃该路径,不得假设被调 ensures;字面量 M3041 路径逐字不变。
3. ✅ 调用后置条件:调用成功后 `result` 绑定每次调用独有的 `res$N` 符号,加入被调已证 ensures 作为假设;未知/无摘要/前置未证的调用使相关表达式 unknown。
4. ✅ 调用方 ensures 证明:M3042 直线体遍历使用"变量形式 + 差分约束假设集(requires + 已证调用后置)";可证假 → M3042 + 反例(须满足假设集);不可判定静默,运行时 M4015 保留;不新增诊断码。
5. ✅ 测试 §59(42 项 ≥10):f→g→h 链式 ensures;调用点违反 g.requires → M3041;g.requires 未证明时调用方 ensures 不得误判;递归/互递归/循环/分支/高阶/效果函数静默;§43/§54/§56 全绿;`proof_fuzz --mode summaries --count 300` 可证 150 / 违反 75 / 静默 50 / 易误报 25 / 误报 0(反例独立验证 75/75)。
6. ✅ 收口报告面:check `--proof-report` 文本为每个可摘要函数新增契约摘要行(`requires=<完整|不完整|无> ensures=<已证|未证|无> 调用点=<N 可证, M 违反>`);`--json --proof-report` 的 `proofs` 增加 additive `summaries: [{file, fn, requires_present, requires_complete, ensures_present, ensures_proven, calls_proven, calls_violated}]`;无旗标输出与 v0.54.0 逐字一致;数据复用 checker 摘要表与调用点统计。

**验收(2026-11-12 实测)**:`node tests/run.mjs` **694 项 0 失败**(§59 42 项);`proof_fuzz --mode summaries --count 300` 可证 150 / 违反 75 / 静默 50 / 易误报 25 / 误报 0,反例独立验证 75/75,退出 0;既有 `proof_fuzz --count 100` 两模式通过;`fuzz --seed 44044 --count 25` 0 分歧;`check <链式语料> --proof-report` 输出链式 proven 摘要;无旗标 JSON 与 HEAD(v0.54.0)逐字一致;compiler/interp/vm/cbackend/artifact 零改动;check 链式语料 10 次 797ms vs HEAD(v0.54) 875ms(同机信息性,无硬阈值)。
**v0.55.0 独立审查修复(2026-11-12)**:B1 直线体共享判定(`exprIsLinear`/`stmtIsLinear`)——If/Match/BlockExpr/Loop/Lambda 及含 Return/Assign/Break/Continue 的表达式不再被"穿透";`checkEnsuresStatically` 的 walkLinearBody、`buildCallSiteLinear`、v0.52 `checkIndexBoundsStatically` 三处统一,遇非直线语句停止后续线性分析(已收集保持);分支内形参重赋值不再产生错误摘要,if-return/match/裸块赋值后不再误报 M3041/M3042/M3045(§59.13 四项)。B2 短路 `&&`/`||` 只下钻左侧,右侧条件求值不作为无条件调用点(线性路径不再误报;左侧真实调用仍报 M3041;§59.14 两项)。B3 M3041 反例构造加入调用方上下文(枚举调用方形参、过滤调用方 requires/假设、按实参形式计算被调值;常量实参直接报常量值),反例必落在调用方合法输入集(§59.15 两项;§59.2 反例断言同步)。B4 `proof_fuzz --mode summaries` 改为 12 槽分布(6 ok / 2 callsite / 1 ensfalse / 2 静默 / 1 易误报),新增分支返回/分支重赋值/match 重赋值/短路 &&/|| 语料;ok 类用 `--proof-report summaries.ensures_present/ensures_proven` 负控"摘要确实被采用";callsite 增加下界 requires 形态(M7)。M5 JSON `summaries` 新增 `requires_present/ensures_present`(无契约函数不与 ensures_proven=true 混淆)。M6 `+=/-=/*=` i64 常量复合赋值线性转移(其余 op 放弃);§59.16 两例(HEAD 误报静默 + 线性确保 M3042)。N10 `prover.js` 校验注入 `toLinear/computePost` 的 op ∈ {==,<,<=,>,>=},非法视为不可编码。N8/N9 登记为 §5.1 #31/#32(P3,不改代码)。**实测**:`run.mjs` 694/0;summaries 300 例 0 误报;模式 1/2 100 例 0 误报;seed 777 summaries 120 例 0 误报;`fuzz --seed 44044 --count 25` 0 分歧;无旗标 JSON 快照全绿;冻结面零改动。
**风险/回退**:摘要不健全 → requires 未证明则不采用 ensures 的硬门控 + 拓扑序 + 环检测;出问题退回 v0.52 行为。

### 4.2.7 诊断码登记

| 版本 | 新码 | 名称 | 触发/严重度 |
|------|------|------|-------------|
| v0.52 | **M3045** | index-bounds-violated | 由 requires 可证索引越界;error |
| v0.52 | **W3105** | index-bounds-unproven | `--warn-unproven-index` 下未证明;warning |
| v0.54 | **M3046** | unsafe-context-required | 指针操作/Ptr 实参在 unsafe 块外;error |
| v0.54 | **M4016** | native-only-feature | tree/VM 执行指针操作/std.mem;panic 101 |
| v0.55 | 无 | — | 复用 M3041/M3042 |
| v0.56 | 无 | — | 无新码(引擎一致性/契约保真/wasm 语义修复均复用既有码) |
| v0.57 | 无 | — | 无新码(循环义务复用 M3045/W3105,码与消息不变;义务记录 additive `scope: body\|loop`) |
| v0.58 | 无 | — | 无新码(LSP 三查询为协议层无诊断码;std.str.join 复用 M3002/M3005/M3001/M4011 口径;doc --json 为工具输出非诊断) |

三处登记:`src/diag.js` CODES(+CODE_HINTS)、`docs/diagnostics.md`、`tests/run.mjs` 对应分节;GUIDE 修订记录同步;已发布码不改号。

### 4.2.8 Backlog 重排

| 项 | 处置 | 理由/前置 |
|----|------|-----------|
| `with unsafe` 实现 | **✅ 已交付 v0.54(C5)** | 北星支柱;与 ffi 共用门禁;双门禁 M3029/M3046;tree/VM/wasm 回落 M4016;Ptr 带长度/`unsafe(cond)` 见下 |
| `mask [效果]` | **❌ 永久否决（ADR-003，docs/adr-003-mask.md）** | 签名不再陈述真实效果,与第一原则结构性冲突;与 M3029 推导/契约纯性/资格面/函数值携带效果四机制逐项冲突;动机消失(无 File/Lib 句柄);design §6.11 存档为已否决设计 |
| 污点即效应(`untrusted`) | **✅ 已裁决采纳类型级方案（ADR-002，docs/adr-002-taint.md）；实现推迟** | "污点即效果"建模否决(机制错位/净化方向性不可表达/契约被切断);采纳 `Untrusted[T]` 编译期标签 + `std.unstr` 净化族;实现条件:ADR-002 评审清单 16 项逐项裁决 + 破坏性变更窗口 |
| ffi 面扩大 | 拆分:Ptr 交集进 v0.54;struct/array 保留;`lib.fn` 运行时 API 删除 | extern fn 已覆盖可审计路径;动态符号破坏 AOT/审计 |
| 约束解码生成模式 | 移出语言计划(工具侧研究) | 非语言/编译器能力 |
| 内容寻址代码 | 降级 | 项目级 ABI 缓存已交付;函数级 ROI 无数据 |
| C `str` for-in / trim 族 | **已关闭** | trim 族 v0.51.3;for-in v0.53(UTF-8 码点迭代,tree / VM / VM-only / cc 黄金一致;该形态 wasm 回落) |
| wasm 静默回落残留形态 | **✅ v0.59 已修**:#40–#43/#45/#46 + 本地函数 #44 + 记账 #48/#49(见 §4.4.3);剩余守护具名(VecLit/下标/mut 写/Option 链等) | v0.56 已修 W1/W2/F1/F2;v0.59 收口 wasm 覆盖与本地函数;保留守护不影响语义,strict 可见(§63 v63.19) |
| 泛型单态化缓存 | 降级 | 无 bench 证据 |
| async/eval/国密/交叉编译 | 保留远期 | 各自独立设计与安全评审 |
| 证明携带 unsafe(`unsafe(cond)`) | 新增 Backlog | 需带长度 Ptr/Slice 与证明令牌 |
| 循环/守卫敏感边界证明 | **✅ 已交付 v0.57(§4.3.4)** | `for i in 0..len { buf[i] }` 最高频;范围 for 体内义务两向证明(脏循环/嵌套/while 保守放弃;义务 `scope: body\|loop`) |
| Ptr 带长度 / Slice 只读视图 | 新增 Backlog | 零拷贝与证明联动先决条件 |
| v0.53.0 独立审查新登记缺陷 | **✅ 已清零(v0.56.0,§4.3.3)** | #23 tree for-in 遮蔽泄漏(P1)/ #24 VM 捕获闭包传 `v.map` TypeError(P1)/ #25 fuzz 恒 io、wasm 腿不真实执行(P2)/ #26 buildKey 不含编译器源码(P3);逐条见 §5.1 |
| v0.54 收口新登记缺陷 | **✅ #27 已修(v0.54.0);#28/#29/#30 已修(v0.56.0)** | #27 std 模块别名在字节码编译器解析失败 → v0.54.0 独立审查 B5 修复;新登记 #28 tree 块作用域泄漏(P1)/ #29 launcher 源码模式 panic 无位置(P3)/ #30 extern fn 值存局部变量后 C 后端不支持调用(P2)——均于 v0.56.0 修复;逐条见 §5.1 |
| v0.55.0 独立审查新登记缺陷 | **✅ #31/#32 已修(v0.56.0)** | #31 proof-report 多入口重复(P3)→ 按记录 `abs`(模块绝对路径)+函数名去重; #32 摘要无条件构建(P3)→ 无契约模块跳过;逐条见 §5.1 |
| mask / 污点即效应(untrusted) | **✅ ADR-002/003 已交付(2026-11-13,§4.3.7)** | mask 永久否决;taint 采纳类型级方案、实现推迟(条件见 ADR-002 §7) |

### 4.2.9 明确不做(v0.52–v0.55)

- 不做 `mask`;不引入"签名看不见的效果"。
- 不做通用 SMT / 完整 QF_LIA;只做线性形式 + 差分约束,超出即静默放弃。
- 不消除运行时边界检查;proven 只报告,不改变 M4003。
- 不在 tree/VM 模拟裸指针或分配器;unsafe 是 C 原生限定。
- 不做 Ptr 算术、Ptr↔整数、指针打印/相等、内联汇编、mmap、逃逸分析。
- 不做 `unsafe(cond)`;v0.54 只做 `unsafe {}`。
- 不承诺跨 OS 位级一致构建;只承诺同 OS + 同 Node 主版本的可复现 dist_hash。
- 不做 async/green-thread、eval、结构体/数组 FFI ABI、C 交叉编译。
- 不引入第三方运行时依赖或 npm 包;CI 只用官方 action。
- 不改已发布诊断码、不破坏既有 `--json` 字段;新增字段一律 additive。
- CI 不覆盖 Windows C 后端(runner 无 gcc);Windows C 由本机 w64devkit 验收并记录跳过原因。

### 4.2.10 成功度量

| 版本 | 完成判定(全部满足) | 量化门槛 |
|------|---------------------|----------|
| v0.52 | 三态稳定(proven/violated/silent);proof 报告 additive;codegen 零改动 | §56 ≥12(实测 26);proof fuzz 200 例 0 误报;fuzz 40 程序 0 分歧;无旗标 JSON 快照不变 |
| v0.53 | strict wasm 无静默回落;`env -i` 可跑;构建键无重复/路径化;C str for-in 三引擎一致;CI workflow 结构静态校验(实际矩阵以 GitHub Actions 记录为准) | §57 ≥10(实测 31);两次 clean build dist_hash 相同;文档数字与实现一致 |
| v0.54 | C unsafe 黄金通过;tree/VM 确定性 M4016;门禁闭合;无半开状态 | §58 ≥12(实测 20,含独立审查回归);Linux/Windows C 黄金逐字一致(本机 Windows 实测;Linux 由 CI c-backend job 承载);既有 C 差分 0 变化 |
| v0.55 | 跨函数 ensures 可证;前置条件不被跳过;无新码;codegen 零改动 | §59 ≥10(实测 42);proof_fuzz summaries 300 例 0 误报/0 假反例(反例独立验证 75/75;含分支/重赋值/短路与下界 requires 语料);fuzz 25 程序 0 分歧;链式 `--proof-report` 输出 proven 摘要;无旗标 JSON 与 v0.54.0 逐字一致 |

**跨版本共同门槛**:`node tests/run.mjs` 0 失败;`fuzz` 0 分歧;新增分节测试;GUIDE 修订记录 + README 路线图 + plan 已完成项移动;版本三处同步;诊断码三处登记;不留下未提交生成物;性能数字必须来自可复现命令(bench 仍为信息性)。

---

## 4.3 v0.56–v0.59 规划（含 ADR 研究槽位，software-architect 精读，2026-11-12；v0.60 号已重新分配给 §4.4.4）

> **规划基线(v0.56 规划时)**：v0.55.0；694 项回归全绿；四后端（tree / VM+wasm / VM-only / C）；CI 矩阵就位；能力矩阵 51 行 ≈81%。**v0.56 收口实测(2026-11-12)**:764 项回归全绿、§60 70 项、能力矩阵 52 行 ≈81%（新增 WASM 覆盖面行）。**v0.57 收口实测(2026-11-13)**:791 项全绿、§61 27 项、覆盖率基线 93.0% 行/86.1% 函数、能力矩阵 52 行 ≈81%(无新增行)。
> **规划立场**：本阶段的目标不是继续加语言面，而是**把已有能力做成可放心使用的工程品**——
> 先清零语义一致性缺陷，再把证明推进到最高频的真实形态，然后补开发者体验与分发，
> 最后才用 ADR 评估新的语义面（服务端/async、污点即效应、mask）。每版一个主题、可独立回退。

### 4.3.1 进度判断（精读结论）

**已兑现（v0.39–v0.55，测试可证）**

- **语言内核成熟**：显式类型/无 null/值语义/效果系统/确定性；契约三层（运行时 M4015 + 编译期 M3040–M3046 + 静态证明 M3042/M3045/摘要）。
- **四后端合同**：树/VM+wasm/VM-only/C 差分是语义合同；C1–C5（数值、str/Vec/Map/Option、FFI、unsafe）；wasm 分层 + strict 三态。
- **工程基线**：CI 九组合 + C 腿 + nightly；构建键可信（项目相对路径 + 内容 + Node 主版本）；env -i 产物验收；694 项回归 + 差分模糊 + 证明模糊。
- **自举生态**：12 个 Ming 自写工具日用（`ming tools`）；诊断码 71 个带 hint/fix；LSP 诊断+hover；REPL。
- **量化**：源码 16.8k 行 JS（checker 5.0k / interp 3.0k / cbackend 1.9k / wasm 1.8k / compiler 1.2k / parser 1.1k / vm 0.9k）；测试 6.0k 行；自举工具 1.8k 行 Ming。bench（本机）：fib(24) VM 86ms / cc 7.75ms（11x）；百万循环 163ms / 8.57ms（19x）。

**主要不足（按影响排序）**

| # | 类别 | 不足（证据） | 处置 |
|---|------|--------------|------|
| 1 | 语义一致性 | **#23/#28 tree 作用域泄漏**：块/for-in 的 `let` 遮蔽在 tree 引擎泄漏到外层（实测 `let i=100; for i in 0..3 {}` → tree 2 / VM 100；if/unsafe 块同根因）。违反硬规则 1（三引擎一致） | **v0.56 必修** |
| 2 | 默认引擎崩溃 | **#24 VM 捕获闭包 + HOF**：`v.map((x) => x * k)` 捕获外部变量 → `TypeError: Cannot read properties of null`，exit 2（tree 正常）。默认引擎受影响，AI 高频形态 | **v0.56 必修** |
| 3 | 解析歧义 | **#33 requires/ensures 以裸标识结尾**：`requires buf.len() == n {` 把 `n {` 当结构体字面量 → M2001「字段名不能是关键字 return」；加括号可绕过。自然契约写法被拒 | **v0.56 修** |
| 4 | 验证盲区 | **#25 fuzz 的 wasm 腿从不真实执行**：生成器 main 恒带 io，wasm 只覆盖 VM 回落路径；v0.53 尾表达式修复的“wasm 首次真实执行”无差分覆盖 | **v0.56 修** |
| 5 | 构建可信性 | **#26 buildKey 不含编译器 `src/*.js`**：版本号未变时改编译器会脏命中缓存 | **v0.56 修** |
| 6 | 工具链毛边 | #22 fmt else 头注释仍需两遍；#29 launcher 源码模式 panic 无位置；#30 extern fn 值局部调用 C 不支持；#31 proof-report 多入口重复；#32 摘要对所有 run 无条件计算 | v0.56 清 P2/P3 |
| 7 | 证明覆盖 | 只做直线体；**最高频形态 `for i in 0..len { buf[i] }` 未证明**（Backlog 已列） | **v0.57** |
| 8 | 日常体验 | LSP 只有诊断+hover（无补全/跳转/符号）；字符串拼接 O(n²)（无 Builder）；二进制 I/O 无流式/随机访问 | **v0.58** |
| 9 | 服务端/并发 | 无 TCP/UDP/HTTP server；async 未设计（北星支柱 3） | **v0.59 ADR 先行** |
| 10 | 安全工具面 | 污点即效应/mask 裁决完成（北星支柱 6） | **✅ ADR-002/003 已交付** |
| 11 | 工程观测 | 无行覆盖率指标；bench 仅信息性无基线；checker.js 5.0k 行单体 | §4.3.8 逐版处理 |
| 12 | 文档/编号 | 测试分节号重复（两个 34–38、缺 40）；plan §4.2.10 的 v0.52 引用误写 §54（实际 §56） | v0.56 清理（#34/#35） |

### 4.3.2 规划原则

1. **先一致性，后能力**：违反三引擎合同的缺陷（#23/#24/#28）优先级高于任何新语义面。
2. **证明只报告，不删检查**：静态证明永远不消除运行时 M4003/M4015（除经 ADR 与单独版本）。
3. **一个新语义面一个 ADR**：服务端/async、taint、mask 先设计文档与评审清单，再谈实现。
4. **零依赖与确定性不交换**：不引入 npm/包注册表；CI 只用官方 action；新能力不得依赖时间/随机/哈希序。
5. **每版可独立回退**：任务粒度的验收与风险表；沿用「实现 + 分节测试 + 文档三处 + 版本三处同步」纪律。

### 4.3.3 v0.56 — 引擎一致性与缺陷清零（质量版，无新语言面）✅(2026-11-12 完成)

**目标**：清零全部 P1/P2 已知缺陷，让“默认引擎”与“对照引擎”都可以放心日用；补上验证盲区。

**任务**(全部完成,2026-11-12 收口)
1. ✅ **tree 作用域模型统一（#23 + #28，同一根因）**：树引擎每次进入块（if/while/for/loop/match arm/unsafe/sync scope）建立子环境（父链查找），`let` 只写当前块；for-in 循环变量每迭代为内层绑定，循环结束恢复外层。范围：仅作用域语义修复，不改闭包捕获语义；C 后端已按块修复（v0.54 B2），补 tree/VM/cc 三方对照。**代价实测**:tree bench +5–32%(循环项最大,每迭代 env 分配;VM/cc 不受影响)。
2. ✅ **VM 捕获闭包 + HOF（#24）**：`vm.js` 的 `callClosure` 经 `vecMethodImpl` 调用捕获闭包时漏传 `captures` → 默认引擎 `TypeError: Cannot read properties of null`;一行修复后捕获/非捕获/多层闭包在 `map/filter` 类 HOF 上 tree/VM 逐字一致。
3. ✅ **契约尾部标识歧义（#33）**：`requires/ensures` 子句改用专用解析模式 + struct literal 前瞻(仅当表达式以裸标识结尾时判定 `{` 为函数体);普通表达式位置的 struct literal 与空结构体 `S {}` 用法不变;裸标识/加括号两写法等价 + fmt 不变。
4. ✅ **fuzz 真实 wasm 腿（#25）**：程序生成“纯 helper（eligible）+ 带 io 的 main 调用它”；wasm 腿对 eligible helper 断言 `MING_WASM_DEBUG=1` 下 `[wasm] fn <名> OK` 且无“实例化失败/REJECT”（§32 门禁同款），汇总新增“wasm 真实执行 N”计数(本机三种子实测 **20/16/18**)。
5. ✅ **buildKey 补编译器源（#26）**：键加入 `compilerSourceHash`(**src/*.js + bin/*.js** 排序内容 sha256;bin/ming.js 的 launcher/build 逻辑同样影响产物——本版 #29 正是它);`build --json` additive `compiler_hash`;`build_key` 语义不变。敏感性回归:复制编译器到临时目录改 src/bin → 键变化、恢复源 → 键恢复。
6. ✅ **工具链毛边**：#22（else 头行尾注释一遍到定点）、#29（launcher 源码模式 panic 带 `file:line:col` 与源码摘录;AOT 模式逐字不变）、#30（extern fn 值经局部变量:C 后端发射期**明确诊断**而非“let 推导 null”,选方案 b）、#31（proof-report 按记录自带绝对路径去重:同显示名不同目录不合并）、#32（无契约模块跳过摘要构建；有契约模块保持现行为）。
7. ✅ **编号与引用清理（#34/#35）**：tests/run.mjs 分节号唯一化(重复 34–38 → 34b–38b、补 §40,文件头索引说明),plan/GUIDE 引用同步;不改测试内容。
8. ✅ **本地函数显式拒绝（#37/#38 → #44）**：v0.56 由检查器在声明处统一报 **M3047[local-fn-unsupported]**(error)——VM/字节码编译器尚无本地函数编译路径(此前默认 VM 直接 TypeError、作值使 tree/VM 分歧、契约被 tree 静默忽略);`check`/`run`/`run --tree`/`cc` 同一门禁,本地函数作值与带契约形态由声明处同一诊断拦截。实现后移除拒绝并恢复 GUIDE 表述(plan §5.1 #44,v0.57 后)。

**验收(2026-11-12 实测)**：`node tests/run.mjs` **764 项 0 失败**(§60 共 **70 项** v60.*:tree 作用域 9 + VM 捕获闭包 3 + 契约歧义与 fmt 保真 13 + buildKey 3 + fuzz wasm 1 + wasm 语义修复 10 + 工具链 10 + 独立审查 A 组 12 + B1/B6 2 + cc 对照 1 + 复审 C1/C2 6);三引擎遮蔽/闭包/HOF/契约歧义用例全部一致;`fuzz --seed 44044 --count 40` 40 程序一致、0 分歧(C 腿 6),wasm 真实执行 20 程序(三种子记录 20/16/18);`proof_fuzz --mode all --count 100` 三模式 0 误报(模式 1 100 例误报 0、模式 2 反例验证 18/18、summaries 100 例误报 0/反例独立验证 24/24);tree bench 如实记录 +5–32%(循环项最大,语义修复代价);**存量 P1/P2 清零**(#23/#24/#25/#28/#30/#33 全修;#22/#29/#31/#32 修)。收口时新登记 #37–#43;独立审查后 #37/#38/#39 已收口,新登记 #44–#47(见 §5.1;wasm 回落形态不影响语义正确性,strict 模式可见)。

**v0.56.0 独立审查修复(A/B 组,2026-11-12)**:A 组——B3 契约作用域(body `let` 遮蔽不影响 ensures、形参名 `result` 与 body `let result` 语义、mut 形参最终值;三引擎 M4015 逐字一致)、u64 一元负号 M3008 类型层拒绝、u64 二元减法下溢四引擎 M4002、fmt 契约破坏三修(lambda 立即调用保括号/内联块未知语句失败不落盘/else 插值消息逐字保留;空结构体与转义规范化);B 组——**B1** proof/summary 记录携带 `abs`,报告按 `abs+fn` 去重(同显示名不同目录双模块各一份;文本/JSON 一致)、**B2** `compilerSourceHash` 纳入 `bin/*.js`(单独改 bin 键变/恢复键恢复;旧缓存自然失效)、**B6** 本地函数声明统一 **M3047** 显式拒绝(VM 不再 TypeError;作值/带契约形态同拦截;`check`/`run`/`--tree`/`--no-wasm`/`cc` 同一门禁)。MINOR:capabilities WASM 行移除 `match` 声明、GUIDE/moltbook §34b–§38b 引用校正、#40/#42 措辞按实测修正、v60.27a/v53.27 注释与断言更新、契约重复子句"后者生效"写入 GUIDE、§60 增加 cc 对照、新登记 #45/#46。验收:764/0;`fuzz --seed 44044 --count 40` 0 分歧且 wasm 真实执行 >0;`proof_fuzz --count 100` 0 误报。

**v0.56.0 复审修复(C1/C2,2026-11-12)**:C1——ensures 表达式自身作用域恢复可解析(VM 编译器 `compileContractExpr` 记录 `contractScopeBase`;解析顺序 `result` → 契约内部作用域(match 臂变量/if 块 let)→ 形参;函数体作用域与捕获仍不可见;契约内臂变量与形参同名按词法遮蔽优先,与 tree 一致);C2——闭包/本地函数子帧显式 `resultSlot=null` 且 Return/PostQ 判定改 `!= null`,其 `return` 不再把外层 ensures 编译进子帧(此前 VM 报 M4001)。§60 新增 v60.54–v60.59(v60.52 补 cc 入口断言);tree 契约表达式内嵌块尾值重入 checkEnsures(M4005)为 HEAD 既有缺陷,登记 §5.1 #47(P3)。

**风险/回退**：tree 作用域改动面覆盖全部树引擎测试，可能暴露依赖泄漏的既有用例（逐条审阅，修正用例而非掩盖）；VM 闭包修复涉及帧布局（保持字节码不变，仅运行时帧解析）；契约歧义修复必须保证普通 struct literal 无误伤（正反例双向锁定）。

**明确不做**：不新增语言关键字/语法；不改运行时检查；不做性能优化（除修复顺带）。

### 4.3.4 v0.57 — QF_LIA 第四片：循环/守卫敏感边界证明 ✅(2026-11-13 完成)

**目标**：把 v0.52 的直线体边界证明推进到**最高频真实形态**：范围 for 内的 `buf[i]`。

**范围**：i64 范围 for（上界为常量或非 mut Vec 参数 `len()`）；循环体为直线体；单个索引点；非 mut `Vec[i64]` 参数；`while i < len` 的单条件守卫作为第二子目标（可选，不承诺）。**不做**：任意循环不变式注解、嵌套循环、循环内改长度、分支敏感、通用 SMT。

**任务**(全部完成,2026-11-13 收口)

1. ✅ **prover 扩展区间约束**：实现落点为 checker 侧义务附加假设(extra)——循环变量绑定确定性符号 `i$<n>`,区间两条线性约束 `lo <= i$<n> < hi` 并入该义务假设集后与既有差分约束**同一求解器**合并求解;`prover.js` 求解器**零改动**(与"只报告不改 codegen"的 ADR-003 立场一致);超范围/非线性 → 放弃。
2. ✅ **checker 循环义务**：范围 for 的每次迭代假设 `lo <= i$<n> < hi`(半开);上界映射到 `len$buf` 时即得 `i < len$buf`;`0 <= i` 由 lo 推出;循环变量被重赋值(类型层 M3004)/体内改写外层变量/藏分支(脏循环)→ 该 for 之后保守放弃。规划中的"break 带值"在 Ming 无此形态(break 不携带值),实测 break/continue 不破坏不变式 → **允许存在**(其后语句不可达即停止收集,已收集义务保留)。
3. ✅ **诊断复用**：可证违反 → M3045(码/消息不变)+ 反例(枚举含循环符号 `i$N` ∈ {-2..10},≤2 个);未证明默认静默,`--warn-unproven-index` 下 W3105(循环义务同口径);proof-record 增加 additive `scope: 'body' | 'loop'` 义务统计。
4. ✅ **测试 §61**（实测 27 项 ≥12）：A 组 v57.1–v57.19 覆盖 `for i in 0..buf.len()` proven / `for i in 1..len` 下界 / `for i in n..len` / `for i in 0..n` + `requires n <= buf.len()` / 未证明静默 + W3105 / 上界 `n+1` 可证违反(反例 `len$buf = 0, i$0 = 0`) / 低侧越界(`i$0 = -1`) / 循环变量重赋值 M3004 / 嵌套 for 放弃 / while 守卫静默 / `buf[i+1]` 位移 / 改写外层 mut 变量 for 后放弃 / 双循环 / break-continue / 空洞区间 / 契约调用不回归 / 混合 scope(loop+body);B 组 v57.20–v57.25(tools AOT 缓存)+ C 组 v57.26–v57.27(观测冒烟)见 §4.3.8;`proof_fuzz --mode loops --count 200` 0 误报(可证 100 / 静默 50 / 违反 50;违反类反例独立求值器**三重验证**:满足 requires + 落在循环区间内(区间非空)+ 索引确实越出义务侧;可证类逐条双引擎运行验证)。
5. ✅ **文档**：GUIDE 静态边界证明节补循环形态与放弃路径、`ming tools` 行补 AOT 缓存、修订记录/路线图;能力矩阵契约/证明行补循环形态(随 2026-11-13 收口落盘)。

**验收(2026-11-13 实测)**：`node tests/run.mjs` **791 项 0 失败**（§61 共 27 项 ≥12）；`proof_fuzz --mode loops --count 200` 0 误报;codegen 零改动（compiler/interp/vm/cbackend/artifact 与 prover.js 求解器对 HEAD 无 diff）;性能:check examples 三文件语料 7 次中位 **132ms** vs HEAD(d438aff/v0.56.0)**137ms**(0.96x,≤1.3x 达标;同机 Node v24,信息性);既有 §56/§59 全绿。

**风险/回退**：循环上界含调用/别名/重赋值 → 保守放弃；若证明器复杂度失控，退回“只支持 `0..len` 直接形态”，其余静默。

### 4.3.5 v0.58 — AI 协作体验与文本工程（开发者体验版）✅（2026-11-13 交付）

**目标**：把“AI 生成 → 检查 → 修正”的循环摩擦再降一档，并补文本工具的实用性能面。

**任务**

1. ✅ **LSP 扩展**：补全（标识符/字段/方法/关键字）、跳转定义、文档符号；保持同步、零依赖、单文件协议实现；对泛型/多文件保守（宁可少补，不可错补）；§62 协议测试扩充（**实测 34 项**,A 组 16:LSP 直连 + 管道协议）。**A 审查修复**:坏 JSON 体存活(不再 ReferenceError 杀进程)、块注释内不补全(嵌套深度按 lexer 语义)、第三式中间态补全;既有 P1 修复(非 ASCII 字节分帧)回归锁定。
2. ✅ **`std.str.join`（Builder → join 架构调整,如实记录）**：原计划 `std.str.Builder`（push/append/to_str），实现改为 **`use std.str;` + `str.join(Vec[str]) -> str` 纯函数**——单次 O(n) 拼接达到同一目标（消除 `+` 循环的 O(n²)），不动语法面、无需 C 后端资格决策（`str.join` 所在函数非直接调用形态 wasm REJECT（`--strict-wasm` 可见回落）、C 后端 C1 发射期显式拒绝，不进资格面）；tree/VM 一致；10 万元素量级拼接 O(n)（§62 v58.19 以 1000 元素 + `byte_len` 断言覆盖语义与规模,bench 专项未单列——join 为单次调用,无累积状态）。**与 Vec 方法 `join` 的 API 不对称与分配记账差异如实登记**（§5.1 #49:`v.join(sep)` 计费 vs `str.join(v)` 不计费）。
3. ✅ **`ming doc --json` 稳定 schema + `ming doc --index`**：把 `///` 文档变成机器可消费的索引（AI 检索用）；additive，不改默认文本输出。**--index 已实现（v0.58）**：`ming doc f1.ming f2.ming ... --index` 聚合输出 `{ok, files: N, items: [...每项前置 file 字段,其余与单文件 item 同形...]}`；单文件加 `--index` 输出同 schema（天然兼容）；无 `--index` 保持单文件命令（只处理第一个）；读失败/解析诊断错误路径与 `--json` 协议一致（fail-fast）。**C 审查 MINOR 已修**:impl 方法签名补 `with` 效果与 requires/ensures。
4. ✅ **Release 分发**：tag 触发 GitHub Release 打包 zip（bin/src/tools/examples/docs/GUIDE/README；零 npm、官方 action）；不承诺安装器/包管理器。**实现口径**:release.yml 只产出 workflow artifact(`ming-<tag>` zip,无双 v)——**不自动创建 GitHub Release**(第三方 gh-release action 违反“只用官方 action”纪律,由维护者手动附 artifact);含版本三处一致性 + 零 npm 依赖校验步骤;`docs/release.md` 流程文档落地。
5. ✅ **测试 §62**（实测 **34 项** ≥15）：LSP 补全/跳转/符号（直连 + 管道协议双路径）；join 双引擎 + 大输入断言；doc JSON schema；Release workflow 结构静态校验。
6. ✅ **文档**：GUIDE 命令表 LSP 行（v0.58 三新查询 + 字节分帧 + 坏 JSON 存活）、doc 行（--json/--index）、新增 std.str 节（join 语义/API 不对称/#49 记账差异）、修订记录 v0.58.0、路线图 v0.58 行；能力矩阵更新（流式拼接行 Builder→join 口径、LSP 行细化）；README 路线图 v0.58.0 + 状态段。

**验收（2026-11-13 实测）**：`run.mjs` 0 失败（**825 项**全绿,§62 共 34 项）；LSP 会话测试通过（直连 16 + 管道 4 会话）；join 双引擎输出一致（O(n) 单次拼接）；doc JSON additive（无旗标输出与 v0.57 逐字一致,§62 v58.32 黄金锁定）；fuzz 40 程序 0 分歧;proof_fuzz 0 误报;零新依赖。

**风险/回退**：补全对泛型/模块解析易错 → 保守策略与开关（已按保守策略交付）；Builder → join 架构调整后为纯 std 函数,不动语法（可整体回退）。

### 4.3.6 规划槽位（原 v0.59）— 服务端与并发：ADR 先行（条件承诺）✅（2026-11-13 完成，实际随 v0.59.0 交付）

**目标**：在“确定性 + 效果门禁 + 零依赖 + 四后端”约束下，给出服务端/并发的可信设计，而不是先写实现。

**任务**

1. ✅ **ADR-001（async/服务端选型）**：`docs/adr-001-concurrency.md`(275 行)——三方案评分 a=28 / b=16 / c=14,选定 **方案 a(worker-per-connection 阻塞模型)**;确定性口径收窄(审查 MAJOR-1:响应内容=f(请求)+spawn_all 输入序聚合+逐 worker 配额隔离;time/rand 声明者除外);(c) 真实破绽改为共享配额/syncTasks/io 无捕获(审查 MAJOR-2);监听地址 v1 固定 127.0.0.1(审查 MAJOR-4);评审清单 **16 项**。
2. ✅ **原型实验**：§2.4 Node 原型实测(审查 MAJOR-3 补齐任务书义务)——10×100:162 req/s、16×100:**181 req/s**、40 连接超订阅:190 req/s;p50 61–207ms;错误率 0%;容量公式 16+256=272 逐字成立(503 恰 272/28 拒);504 硬杀 8/8 名额释放;内存 commit 421MB/WS 343MB(16 worker;32MB SAB 预留 ×16 解释差值)。
3. **实现推迟**：按 ADR 结论"条件承诺实施"——serve 实现待评审清单 16 项逐项裁决(其中监听地址/worker 启动失败为审查新增);此前不写实现。
4. ✅ **文档**：ADR 完成;plan §4.3.9/§4.3.10 与 Backlog 本收口回写;GUIDE 服务端节随实现交付(未实现,暂缓)。

**验收（2026-11-13 实测）**：ADR + 评审清单 16 项完成；审查 4 MAJOR 全修后通过；"若不实现,plan 明确记录结论"已满足(条件承诺+推迟条件)。

**风险/回退**：方案 b/c 否决理由归档于 ADR §2.2/§2.3;阻塞模型并发上限已量化(16 并发饱和、队列 256 最坏排空 1.4s)。

### 4.3.7 规划槽位（原 v0.60）— 安全工具面研究项（污点即效应 / mask）✅（2026-11-13 完成，实际随 v0.59.0 交付；v0.60 号已重新分配给 §4.4.4 资源门禁一致性）

**目标**：评估北星支柱 6 的下一块（数据流安全），保持“签名可见”的哲学底线。

**任务**

1. ✅ **ADR-002（taint-as-effect）**：`docs/adr-002-taint.md`——**结论:采纳类型级方案 `Untrusted[T]` + `std.unstr` 净化族;"污点即效果"建模否决(终局)**。机制依据:效果系统查"调了谁"不查"值流向";净化方向性在函数级对称效果集不可表达;效果建模下契约被切断(实测 M3029);类型方案运行时擦除、四后端零改动(唯一改动面 = checker sig/wasm.js numOk 解包)。13→16 项评审清单(独立审查补:资格裁定/工具联动/Err 载荷漏报窗口)。
2. ✅ **ADR-003（mask 决策）**：`docs/adr-003-mask.md`——**结论:永久否决**。与第一原则结构性冲突;与 M3029 推导/契约纯性/资格面/函数值携带效果四机制逐项冲突(实测支撑);动机消失(无 File/Lib 句柄;Join[T] 已被线性纪律解决);"仅入口 mask"变体一并否决;design §6.11 存档标注。9 项评审清单。
3. **原型**：taint 实现推迟(条件 = ADR-002 评审清单逐项裁决 + 破坏性变更窗口);mask 无原型(否决);§64 不成立(无实现)。

**验收（2026-11-13）**：两份 ADR + 评审清单(16/9 项)完成；审查对否决/采纳的对抗性质疑全部收敛；"不落地则 plan 记录结论与理由"已满足(本节即记录)。

**风险/回退**：taint 与值语义/深拷贝交互已论证自洽(拷贝保污点=类型恒等式;唯一洗衣通道 bytes.to_str 已入漏报窗口)；mask 否决永久生效。

### 4.3.8 跨版本技术债与观测

| 项 | 内容 | 版本 | 说明 |
|----|------|------|------|
| 覆盖率观测 | `tests/coverage.mjs`（`NODE_V8_COVERAGE`，零依赖）报告 `src/*.js` 行/函数覆盖 | **✅ v0.57 交付**(2026-11-13) | 首个基线 **93.0% 行 / 86.1% 函数**（15 文件;764 项插桩全绿 6.4 分钟,Node v24 win32-x64),写入 docs/coverage-baseline.md(含 range 近似口径说明);信息性指标，不设门槛；先建立基线再谈阈值。备注:工具"始终 exit 0"**非无条件**——`mkdtemp` 临时目录创建在 try 之外,失败会 exit 1(概率极低,信息性,不改代码,见 §5.1 备注登记) |
| wasm 剩余回落形态 | **✅ v0.59 已收口 #40/#41/#42/#43/#45/#46 + 6 潜伏 bug(A–F;见 §4.4.3);剩余守护具名**:VecLit 数值元素(容器表示未统一)、Vec 下标读 / mut 元素写(宿主 `panic_m4003` 导入待补)、Option 消费链(宿主 M4006/M4007 导入待补)、f64 复合赋值等 | **✅ v0.59 交付**(2026-11-13) | 已声明覆盖扩至 f64 局部/Map 形参/str 返回/值型 if/尾 if;strict 120 语料 fallback=0;保留守护在 strict 下 exit 2 且原因具名(§63 v63.19);P1 报告逐文件登记 15 个具名回落语料文件 |
| bench 基线 | `tests/bench.baseline.json` + 阈值告警（如 cc/vm 比值回退 >20% 告警） | **✅ v0.57 交付**(2026-11-13) | bench 输出 Δ基线列;cc/vm 加速比回退 >20% WARN 仍 exit 0(不阻断 CI);`--write-baseline` 刷新。备注:基线数字为**快照口径**(meta.date 标注时点,同机 + 同 Node 主版本对比;重跑 `--write-baseline` 刷新,见 §5.1 备注登记) |
| checker 拆分 | 契约/证明适配从 checker.js（5.0k 行）迁到 `src/contracts.js`（纯重构，零行为变化） | v0.57–v0.58 择机 | 以全量回归绿为唯一验收；不追求行数指标;v0.57 覆盖率基线(checker 93.4% 行/90.1% 函数)可作重构安全性参考线 |
| 文档结构 | GUIDE 1.1k 行补目录/交叉引用；不重写 | v0.58 | 降低 onboarding 摩擦 |
| 安全审计 | unsafe/ffi 的“已声明覆盖/不覆盖清单”每 4 版复核一次 | 随版（2026-11-13 三方评估已复核） | 与能力矩阵同步 |
| `ming tools` 调用开销 | 每次调用重新 check+编译工具本体,超出 Node 基线约 **57ms**(宿主 coreutils ~15ms);AOT 缓存(键 = 版本 + 工具源哈希)目标 **<20ms** 额外开销 | **✅ v0.57 交付**(2026-11-13) | 12 工具全缓存零回退(键 = VERSION + Node 主版本 + compilerSourceHash + 工具 basename + 源文本;原子写;span/declSpans 回填 panic 逐字对齐;旁路旗标不缓存;损坏自愈;`MING_TOOLS_DEBUG=1` 观测)。**实测净开销 ~25–30ms/次,目标 <20ms 未完全达标(如实注明)**;对无缓存路径净改进 12–19ms/次;剩余地板 = bin 顶层导入 ~9ms + 核心模块图 ~15ms,进一步需 src 级瘦身(另行登记);缓存落地后重跑审计对照**待办保留**(docs/usage-audit.md §4) |

### 4.3.9 明确不做（v0.56–v0.59）

- 不做包管理注册表/第三方依赖；不做跨 OS/跨架构交叉编译；不做 GUI；不做交互式调试器（留 Backlog）；不做 eval/热重载。
- 不做完整 SMT；证明只在线性/区间子集内推进，超出即静默放弃。
- 不删运行时边界/契约检查；proven 只报告。
- async 运行时与 HTTP server：ADR-001 已裁决方案 a（worker-per-connection）条件承诺实施——实现待评审清单 16 项逐项裁决，在此之前不写实现。
- mask 永久不做（ADR-003）；taint 效果建模不做、类型级 Untrusted[T] 方案已裁决采纳（ADR-002），实现推迟至评审清单 16 项裁决。
- 不改已发布诊断码；新增字段一律 additive；零 npm。

### 4.3.10 成功度量

| 版本 | 完成判定（全部满足） | 量化门槛 |
|------|---------------------|----------|
| v0.56 | **✅(2026-11-12 实测)**:三引擎作用域/闭包/HOF 一致；契约尾部歧义修复；fmt 契约保真；fuzz 真实 wasm 腿；buildKey 含编译器源(src+bin)；存量 P1/P2 清零；独立审查 A/B 组修复(契约作用域/u64/fmt/#31/#26/M3047)；复审 C1/C2 修复(ensures 内嵌作用域/闭包 return)；#37/#38/#39 收口，新登记 #44–#47 见 §5.1 | §60 实测 70 项(≥15)；回归 **764 项**全绿(≥715)；fuzz 40 程序 0 分歧、wasm 真实执行 20(三种子 20/16/18)；buildKey 敏感性覆盖 src 与 bin；proof_fuzz 三模式 0 误报(实测模式 1 100 例/模式 2 反例 18/18/summaries 100 例 0 误报) |
| v0.57 | **✅(2026-11-13 实测)**:范围 for 内 `buf[i]` 两向可证明(循环符号 + 区间假设;脏循环/嵌套/while 保守放弃);tools AOT 缓存 12 工具全缓存零回退(热缓存净 ~25–30ms,目标 <20ms 未完全达标如实注明);覆盖率基线 93.0% 行/86.1% 函数;bench Δ基线 + 回退 WARN;codegen 零改动 | §61 实测 27 项(≥12);**791 项**全绿;proof_fuzz loops 200 例 0 误报(反例独立求值器三重验证);check 语料 0.96x HEAD(≤1.3x 达标);既有 §56/§59 全绿 |
| v0.58 | **✅(2026-11-13 实测)**:LSP 补全/跳转/符号可用(保守策略,§62 直连+管道 16 项);`std.str.join` O(n)(Builder→join 架构调整,如实记录);doc JSON additive(文本黄金锁定逐字不变);Release 打包(artifact + 手动 Release 决策,docs/release.md) | §62 实测 **34 项**(≥15);回归 **825 项**全绿;fuzz 40 程序 0 分歧;proof_fuzz 0 误报;无旗标 doc 输出逐字不变;零新依赖 |
| 原 v0.59 槽位 | **✅(2026-11-13 实测,实际随 v0.59.0 交付)**:ADR-001 完成,方案 a(worker-per-connection)条件承诺实施;确定性口径收窄、(c) 真实破绽重写、监听地址 127.0.0.1、原型实测 190 req/s@40 连接 | ADR 评审清单 **16 项**(全有默认值);实现待清单逐项裁决;实现时 **§66** ≥12 + 三引擎拒绝一致(serve 已移至 v0.62 条件版,见 §4.4.6) |
| 原 v0.60 槽位 | **✅(2026-11-13 实测,实际随 v0.59.0 交付)**:ADR-002(taint 类型级方案采纳,效果建模否决终局)+ ADR-003(mask 永久否决)完成;实现推迟均有条件与理由 | ADR 评审清单 16/9 项全有默认值;实现时 **§65**(污点)/**§66**(serve) ≥12;v0.60 号已重新分配给资源门禁一致性(§4.4.4) |

**跨版本共同门槛**：`node tests/run.mjs` 0 失败；`fuzz` 0 分歧；新增分节测试；GUIDE 修订记录 + README 路线图 + plan 已完成项移动；版本三处同步；诊断码三处登记；不留下未提交生成物；性能数字来自可复现命令。

---

---

## 4.4 v0.59–v0.62+ 规划（software-architect 精读第二轮；2026-11-13 三方评估修订）

> **规划基线**：v0.59.0（HEAD 9251e08）；**881 项回归全绿**；四后端 + LSP 三查询 + 本地函数 + wasm 覆盖收口 + 契约三层证明（直线体 + 范围 for）；覆盖率实测 **93.5% 行 / 88.3% 函数**（2026-11-13 复测；vm.js 函数 **63.8%**——旧数字 43.8% 已作废，见 §4.4.10）；ADR-001/002/003 已交付（并发选型 / 污点 / mask 三项裁决完成）。
> **修订说明（2026-11-13）**：software-architect / security-engineer / minimal-change-engineer 三方独立评估后，v0.60 由"服务端条件交付 + 覆盖率补测 + checker 拆分"改为**资源门禁一致性**——安全侧实测 `--max-ms`/`--max-alloc` 的承诺可被阻塞内建与外部输入绕过（P1）；serve 独立为 v0.62 条件版；污点缩窄为 v0.61 窄源条件版（9 源全量会让 5 个自写工具直接不可写）；checker 拆分/覆盖率门槛/while 证明移出近三版。评估记录与实测证据见 §4.4.10，缺陷登记见 §5.1 #51–#57。
> **规划立场**：§4.3 清空后，最大的债不在"缺能力"，而在**默认引擎优化层的覆盖面**——真实程序形态（f64 局部、Map/str 签名、值型 if、块尾 if、str 返回）在 wasm 仍是回落；**文档化特性仍在被拒绝**（#44 本地函数）；**配额门禁仍有引擎分歧**（#48/#49 记账）。先把这三件事做成"默认引擎全面性"版本（v0.59），再走污点（v0.61 窄源条件）与服务端（v0.62 条件）的交付。

### 4.4.1 现状判断（精读结论）

**已兑现（v0.56–v0.58，测试可证）**

- **引擎一致性清零**：tree 作用域统一、VM 捕获闭包 HOF、契约作用域双引擎闭合、wasm 四个语义 P1、u64 一元负号/减法四引擎统一。
- **证明三层**：直线体 M3042 → 范围 for 循环义务 M3045（`--mode loops` 200 例 0 误报）→ 跨函数摘要 M3041 扩展；proof_fuzz 四模式。
- **可观测性**：覆盖率基线（93.0% 行 / 86.1% 函数，15 文件）、bench 基线（Δ列 + WARN）、fuzz 真实 wasm 腿（strict 存活断言）、strict-wasm 三态。
- **工具链**：`ming tools` AOT 缓存（净 25–30ms，原 57ms）、LSP 补全/跳转/符号 + 字节分帧修复、doc --json/--index、Release 打包。
- **ADR 三裁决**：并发方案 a 条件承诺（原型 190 req/s@40 连接）；污点类型级方案采纳（效果建模否决终局）；mask 永久否决（四机制冲突逐项实证）。

**主要不足（按影响排序）**

| # | 类别 | 不足（证据） | 处置 |
|---|------|--------------|------|
| 1 | wasm 覆盖面 | **#40 locals 索引偏移**（f64 局部/Map 字面量 → 违规函数 REJECT）/ **#42 Vec 形参组合 locals 错位** / **#45 值型 if blocktype 编码失败** / **#46 块尾 unit if 按值编译**——默认引擎对真实程序形态（f64 数值代码、`while { if c { break; } }` 尾形态）仍回落 JS | **v0.59 必修** |
| 2 | 本地函数 | **#44 VM 无本地函数编译路径**——文档化特性被 M3047 显式拒绝（v0.56 起）；契约被 tree 静默忽略（tree 支持、VM 崩溃的历史） | **v0.59 必修** |
| 3 | 分配记账 | **#48 wasm str_cat 不计费**（M4011 引擎分歧，#40–#46 修复后从潜伏变可达）/ **#49 std.str.join 不计费**（与 Vec join 计费不对称） | **v0.59 统一** |
| 4 | 资源门禁 | **S1/S2 实测**：`--max-ms` 被 sleep/join 绕过（3.2s @100ms）；`--max-alloc` 对 fs/stdin/proc/net 外部输入与 wasm 参数搬运不计费（#51/#52/#53） | **v0.60 必修** |
| 5 | CLI 门禁 | **#54**：`ming test`/`ming init` 零 CLI 回归且旗标不传播（`test --no-wasm` 仍走 wasm；`test --max-alloc 5` 通过而 `run` 触发 M4011） | **v0.60 必修** |
| 6 | 服务端 | ADR-001 方案 a 条件承诺——评审清单 16 项未裁决；原型数据已备（190 req/s@40、0.9GB@16） | **v0.62 条件（独立版）** |
| 7 | 污点 | ADR-002 类型级方案采纳；**9 源全量会让 5 个自写工具直接 M3002**；五处补丁未落 | **v0.60 文档补丁 / v0.61 窄源条件（先 spike）** |
| 8 | 证明覆盖 | while 守卫证明（v0.57 可选子目标）未做；tree 契约求值重入 #47（P3，M4005，活分歧） | **#47 v0.60 必修；while → Backlog** |
| 9 | 测试缺口 | **vm.js 函数覆盖实测 63.8%（51/80）**，非 43.8%；26/29 未覆盖为 wasm 宿主导入闭包，40 opcode 是 `execLoop` 内 case——"opcode 直测"前提不成立 | 信息性，不设门槛 |
| 10 | 工程债 | **checker.js 5.3k 单体**（5,273 行/310 函数/90.3% 函数覆盖）；GUIDE 1760+ 行（目录已有，交叉引用未补） | 背景项，不进入版本 |
| 11 | 社区/观测 | usage 审计缓存后未重跑；覆盖率/bench 快照口径；覆盖率"始终 exit 0"非无条件 | 随版附注，维持 N-57.1 |

### 4.4.2 规划原则（沿用 §4.3.2 + 原新增两条 + 三方评估三条）

1. 先一致性/全面性，后能力；2. 证明只报告不删检查；3. 新语义面先 ADR；4. 零依赖与确定性不交换；5. 每版可独立回退；6. **新增**：wasm 专项以 `--strict-wasm` 全语料存活为验收工具（回落清零可度量）。
7. **新增**：覆盖率基线短板（函数覆盖 <70% 的文件）作为补测线索，随版收敛。
8. **修订（三方评估）**：一版一主题且可独立回退——质量/安全修正版不夹带新语义面（v0.60 门禁；serve 独立 v0.62）。
9. **修订（三方评估）**：计费口径单一事实——值创建 + 外部输入边界计费；派生值（deepCopy/json.parse/re.*/wasm 参数搬运）不重复计费（详见 §4.4.4）。
10. **修订（三方评估）**：指标不升格为门槛——函数覆盖率是信息性线索，不是版本门槛（40 个 opcode 是 `execLoop` 内 case，不是函数）。

### 4.4.3 v0.59 — 默认引擎全面性（wasm 覆盖收口 + 本地函数恢复 + 记账统一）— ✅ 已交付（2026-11-13）

**目标**：strict 模式下已知回落形态清零；本地函数从"拒绝"变"支持"；分配记账四引擎统一。**无新语言面**（本地函数是恢复既有文档化特性）。

**任务（✅ 逐项验收）**

1. ✅ **wasm locals/签名专项（#40/#41/#42）**：locals 声明改从 `nParams` 起（消除形参槽重复计入的类型错位）；Map/Vec[str] 形参经 `paramSlotTy` 登记 `mi64/mf64/mstr`，`__kh/k/v` 槽位补型；Vec 多枚/与 f64 组合随索引模型一并修复。**宿主补丁**：`map_get_i64`/`vec_get_i64` 返回 `BigInt(...)`、`wasmWriteVecNum` 认 `'float'`；删除 Vec[f64] 形参 / Map i64 for-in / Map i64 下标三处守护。strict 全 fuzz 语料 120 程序 **ok=54 / none=66 / fallback=0**——**计数为快照口径**（受生成器种子与 CCBIN 影响；实测其他种子出现 61/59、ok=70/none=50 等变体，`fallback=0` 是实质结论，计数本身不构成门禁）。
2. ✅ **wasm 返回与块形态专项（#43/#45/#46）**：`retNumTy` 映射 str→i32 句柄；值型 if 按**单字节 valtype** 发射（修 `sleb(0x7e)` 两字节错误）；块尾 unit 上下文 if 按语句编译（while/for/void/嵌套块尾可达）。
3. ✅ **分配记账统一（#48/#49）**：wasm `str_cat` 经 `str_len(l)+str_len(r)` → `ming_alloc` 计费（嵌套 11+15=26；plan §5.1 复现三引擎 M4011 累计 120000）；**插值与 tree/VM 一致不计费**；**BMP 口径差异**（`str_len` 码点 vs interp UTF-16 长度,代理对每字符差 1）与 **`--max-alloc` 内存风险**（bump 堆不回收,配额放大时驻留随拼接总量增长）如实登记。`std.str.join` 按结果长度计费（#49 对称化;紧配额下 M4011 与 Vec.join 一致）——§62 v58.29 断言按翻转后实际输出改写。
4. ✅ **本地函数恢复（#44，M3047 移除）**：VM `precompileLocalFns`/`compileLocalFn`（块级条目 + 递归自引用 + 兄弟互递归 + 契约按模块函数同口径 + 作值 LDFN→vclose + AOT 最小 entry.sig）；tree `callLocalFn` 补齐契约/兄弟可见性/作值调用；**三条限制**（不捕获外层局部 M3001 / 块级可见 / 泛型 M3048 与 cc `语句 FnStmt` 不支持）写入 GUIDE；M3047 废弃不再发射（号段保留）。
5. ✅ **测试 §63**（36 项 ≥24；P1 审查追加 9 项 → 45；P2 审查追加 11 项 → **56 项**）：P1 21 + P2 13 + P3 2 + P1 审查修复 9 + P2 审查修复 11（B1 兄弟契约/自引用 M4005、B2 lambda 本地函数、B3 遮蔽语义、B4 导入遮蔽、M3048、M4 strict、Some/Ok）；更新三条陈旧断言（v53.25 值型 if strict ok；v60.52 本地函数三引擎支持 + cc 仍拒绝；v63.30 泛型本地函数 → M3048）。
6. ✅ **P3 invariant bench**（§4.4.4 任务 4 前移落地）：`tests/bench.mjs` 第 5 项"契约 invariant 循环"（10,000×30 = 300,000 次 mut-self 退出 vs 无 invariant 对照）——VM 0.19–0.28µs/次、tree 0.20–0.28µs/次；基线新增 `invariant.vmUs/treeUs`。

**保留守护（不扩展,strict 具名）**：VecLit 数值元素（容器表示未统一）、Vec 下标读 / mut 元素写（宿主 `panic_m4003` 导入待补）、Option 消费链（宿主 M4006/M4007 导入待补）、f64 复合赋值等——P1 报告逐文件登记 15 个具名回落语料文件。

**v0.59-P1 独立审查修复（2026-11-13 追加，§63 v63.37–v63.45）**：① `<<` 结果溢出检查（wasm 移位后算术/逻辑右移回检；C 后端临时量 + 回检）——此前 wasm/C 静默回绕、tree/VM M4002；消息口径沿用既有约定（eligible/wasm 内通用文案，C main 内具体文案与 tree 逐字），码/退出码/位置三引擎一致。② M4007 三引擎逐字：wasm `map_get_*` 导入增 span 实参，宿主以 `debugStr` 引号 + 后缀 + span 组 Panic（`<unknown>:0:0` 消除）；M4011 经 `ming_alloc` 第二参 span 同步定位。③ VecLit/MapLit wasm 记账：按元素数经 `ming_alloc` 计费（与 interp 同口径），`--max-alloc` 下默认引擎不再绕过 M4011。MINOR：mut Vec for-in 后缀剥离（`vi64ptrm`→`i64`）、Vec[f64] 元素记账、Option 消费链回落原因具名、compiler 死代码删除、u64 ≥2^63 字面量 `BigInt.asIntN(64)` 编码（修 `extra bits in varint`），并补 i64.min（`-9223372036854775808`）字面量特判与越界字面量显式回落（防 asIntN 静默回绕；C 同口径）。回归 **870 全绿**。

**v0.59-P2 独立审查修复（2026-11-13 追加，§63 v63.46–v63.56）**：B1 本地函数 ensures 引用同块兄弟（`positive(result)`）——VM `compileContractExpr` 契约域放行 `contractFnBinds`（同块兄弟含自身；模块函数契约仍不可见函数体本地 fn，v0.56 A1 语义不变）；自引用 ensures 与 tree 同行为（无限递归 → M4005，两引擎首行逐字一致）。B2 lambda 引用外层本地函数——lambda 体经 `fnBinds` 静态解析为 LDFN（本地函数是全局函数表条目，无需闭包捕获），并修 tree `deepCopy` closure 丢失 `mod`/`localFns`（`env.mod.items` TypeError 根因）。B3 遮蔽语义定案：**同块 `let` 与 `fn` 同名 → M3009**（消除顺序敏感；同块重名本地函数同报 M3009）；**跨块 → 词法最近块胜**（内层 fn 遮蔽外层 let/形参，反之亦然）；checker `Scope.lookupValue` 按层交错解析（vars/localFns），compiler `resolveName` 同口径返回 `{kind:'fn'}`，三引擎统一。B4 本地函数遮蔽导入模块/模块项（`use std.math` + `fn math`）——checker `baseShadowed` 纳入 localFns 并报用户级 M3015（不再落 tree "内部错误:localfn 没有方法"）；compiler 导入/构造器/字段守卫改用 `resolveLocalName`。MINOR：① 同块重名本地函数 M3009（原静默后者胜）；② 泛型本地函数新增专用码 **M3048[generic-local-fn-unsupported]**（不再复用 M3003），块内调用点按毒化 never 签名收敛并消除 `str(...实际是 T)` 级联；③ **静态证明面不含本地函数**（M3041/M3042/M3045/W3105/`--proof-report` 只覆盖模块级函数）与"本地函数签名/契约不引用外层泛型参数或 `Self`"写入 GUIDE 第 (4) 条限制（不强行接入证明面：本地函数是独立帧、契约在运行时由 M4015 执行，静态证明需为每块建立独立义务域且与块级条目/互递归语义交叉，成本高于收益）；④ **M4** wasm.js `analyze` 形状阶段直接拒绝函数体含 `FnStmt` 的函数（`bodyContainsFnStmt`）——未被调用的本地函数声明不再使 strict 出现 fallback（三态口径统一；cc 仍按发射期 `语句 FnStmt` 拒绝）；⑤ 测试缺口修补：v63.29 断言改查 `run.stderr`、v63.32 断言构建日志含 `app.bytecode.json` 且无"回退源码模式"；⑥ `Some/Ok/Err` 裸调用特例先于名字解析（本地 `fn Some`/`let Some`）——compiler 加 `resolveLocalName` 守卫，本地声明优先与 checker/tree 一致；⑦ pre-existing NOTE 收口：tree deepCopy closure 丢 mod/localFns **已修**（B2 附带）；tree ensures 块尾中间值重入并入 §5.1 #47 描述（P3 未修）；`Some/Ok` 特例已修（不再需保留名拒绝）。回归数字见验收行。

**验收（实测）**：12 工具 `check --strict-wasm` 10 none / 2 fallback（具名）;fuzz 120 语料 fallback=0；`node tests/run.mjs` **861 全绿**（≥860；P1 审查追加后 870、P2 审查追加后 **881 全绿**）；fuzz/proof_fuzz 全模式 0 分歧/0 误报；**codegen 冻结面**：interp 仅 #49 一行计费 + P2 本地函数帧（已登记）、vm 仅宿主补丁 + P2 调用路径、cbackend 零改动（P1 审查追加左移溢出检查与 M4007/M4011 span，见上段）；wasm.js 为 wasm 改动面。

**风险/回退**：locals 模型重构动 wasm 编译核心 → 分四步（#40→#42→#43→#45/#46）每步独立回归；任一步 strict 回归不绿即停下评估；不可行形态如实登记（v0.58 已有先例口径）。

### 4.4.4 v0.60 — 资源门禁一致性（质量/安全版，无新语言面）

> 主题唯一：让 `--max-ms` / `--max-alloc` 的承诺与实现、四引擎行为一致；不引入新能力。
> 背景：2026-11-13 三方评估。原 v0.60 方案（serve + 覆盖率补测 + checker 拆分）被裁决拆掉——三个主题、一个条件新运行时面、一个纯重构、一个指标门槛，无法独立回退（§4.4.10）。
> 基线：v0.59.0（HEAD 9251e08，881 项全绿；覆盖率实测 93.5% 行 / 88.3% 函数，vm.js 63.8% 函数）。

**必修（P1，全部有本机实测复现）**

1. **#51 wasm 参数搬运计费分歧 + `wasmParamTop` 未复位（P1）**：`sum(v: Vec[i64])` 传 `[1,2,3]` + `--max-alloc 20` → 默认引擎 exit 101（M4011，累计 43），`--no-wasm`/`--tree` exit 0 输出 6，违反四引擎语义合同。根因：`src/vm.js` 的 `wasmWriteVecNum` → `mingAllocRaw` 把 wasm 实参搬运计入配额；且 `wasmParamTopStack` 在分配之后才保存、调用后 pop 回同一值，线性内存不复用。**最小修法**：先修 param-top（分配前保存、调用后复位），再取消参数/值拷贝搬运计费（派生拷贝不是新值创建）。`ming_grow`/`ming_copy_vec` 的字节口径与 tree/VM 元素口径差异登记为 latent，不在本版扩修。
2. **#52 外部输入边界未计费（P1）**：`std.fs.read_file` 读 182,819 字节 + `--max-alloc 10` → exit 0（配额完全绕过）。**最小修法**：`read_file` 先 stat 再按 size 预记账；`read_bytes`/`read_line`/`read_to_end`/`list_dir` 按结果长度/条目数记账；`proc.exec` 的 stdout/stderr 与 `net.http_*` 的 body 按结果长度记账。**计费原则**：值创建（Vec/Map 字面量、push/extend、str 拼接/repeat/join）+ 外部输入边界计费；派生值（deepCopy、json.parse、re.*、wasm 参数搬运）不重复计费——关闭无界外部输入，不逐点重写全部调用。
3. **#53 `--max-ms` 阻塞内建不可抢占（P1）**：`std.time.sleep(3000)` + `--max-ms 100` → 3,213ms exit 0；`join` 子任务同形态 3,283ms exit 0。根因：`checkTimeQuota` 只在每 16,384 步轮询，阻塞内建根本不经过它。**最小修法**：新增 `remainingMs()`；sleep 的 `Atomics.wait`、join/join_detailed/spawn_all/sync scope 的等待钳到剩余预算；exec/http 把钳制后的 timeout 传给 worker（execFile timeout / AbortController），返回后立即 `checkTimeQuota` → M4012。**明确不修（文档化边界）**：`read_line`/`read_to_end` 的 stdin 阻塞与 RegExp 回溯在进程内不可抢占——GUIDE/capabilities 具名列出，不假装已修。复用 M4011/M4012，不新增 M 码。**实现注记（批次 1 审查定案）**：`checkTimeQuota` 的边界比较由严格 `>` 改为 `>=`——钳制等待恰在上限边界唤醒时 `Date.now()` 毫秒取整使 elapsed==maxMs 漏报（实测 30 次 1 漏），且 `rem<=0` 预检查规则本就要求 `>=` 口径才自洽；v0.32 自旋 M4012 用例复测逐字不变，`>` 严格语义无既有用例依赖。
4. **#54 `ming test` / `ming init` 旗标不传播 + 零 CLI 回归（P1）**：`test --no-wasm` 仍走 wasm；`test --max-alloc 5` 通过而 `run --max-alloc 5` 触发 M4011。**最小修法**：`ming test` 把 `--tree`/`--no-wasm`/`--strict-wasm`/`--max-steps`/`--max-alloc`/`--max-ms` 原样转发到测试执行路径（与 `run` 同一解析与仲裁，`--strict-wasm` 与解释器旗标互斥口径一致）；`test`/`init` 补 CLI 回归（§64）。
5. **#47 tree 契约求值重入（P3，必修）**：`ensures if a > 0 { true } else { true }` → tree M4005 exit 101 / VM 输出 5。**最小修法**：`execBlock` 只在函数体块尾检查 ensures（ctx 携带 `bodyBlock`），表达式内嵌块不检查；本地函数补传 `bodyBlock`。不改 VM/编译器。
6. **ADR-002 五处补丁（v0.61 启动门槛，仅文档）**：(a) 来源表补 `bytes.to_str` 桥接与 `read_bytes` 漏报窗口，裁定 v1 窄源边界（只标 `env.get`/`read_line`/extern 返回；fs/proc/net 内容源不标）——**评估落盘时已完成**（ADR-002 §1.2 修订注 + §3.1 窄源块 + §6.2 ②）；(b) `debug(any) -> str` 是洗白通道，进禁面（与 Ptr 同款，M3002/M3049）；(c) 纯消费者/白名单方法表（parse_i64/parse_f64/char_len/byte_len/is_empty）与自由函数边界；(d) 每个净化器登记"授权的 sink 位"（`sanitize_path` 只授权路径位，不授权 content/URL/exec），并裁决绝对路径/CLI 路径策略；(e) **码号修正**：M3048 已被 v0.59 泛型本地函数占用 → 改为 M3049/M3050；ADR-002 §8 的 §64 改为 §65——**评估落盘时已完成**。**不写实现代码。**
7. **文档与基线收口**（**评估落盘时已完成大半**：README/design/plan 数字、coverage-baseline v0.59 复测、capabilities 熔断行改判、ADR-001 §63→§66、ADR-002 码号/窄源/§65 已同步）：v0.60 剩余项为 GUIDE 门禁口径（计费原则 + read_line/RegExp 边界 + `std.rand` 非 CSPRNG 声明）与 `docs/plan.md` 验收行回填。

**验收（实测口径）**：`node tests/run.mjs` 881 + 新增 §64 ≥14 全绿；#51 三引擎 `--max-alloc 20` 均 exit 0、`--max-alloc 2` 均 M4011；#52 大文件 `--max-alloc 10` 三引擎 M4011、小文件通过；#53 sleep/join 在 `--max-ms 100` 下 <1.5s M4012（exec/http 视环境，失败则只用 sleep/join 并如实注明）；#54 `test --no-wasm` 的 wasm 状态为 none、`test --max-alloc 5` 触发 M4011；#47 tree/VM 均输出 5；`fuzz --seed 44044 --count 40` 0 分歧；`proof_fuzz` 0 误报；无新 M 码；S1/S2 核心代码 diff 目标 <100 行，#54 转发与回归另计（约 30–60 行）。

**验收（2026-11-13 实测）**：`node tests/run.mjs` **905 项 0 失败**（881 + §64 24 项：A 组 4 + B 组 9 + C 组 11）；#51 三引擎 max20 exit 0 输出 6 / max2 M4011（v64.A1）、计费边界 3000/2999 三引擎逐字（v64.A2）、10 万次调用 + wasm OK 冒烟（v64.A3）；#52 大文件三引擎 M4011、10 字节恰等配额 exit 0（v64.B3）、stdin/list_dir 计费（v64.B4/B5）；#53 sleep/join `--max-ms 100` 三引擎 M4012 且 <2s（v64.B6/B7）、无配额不回归（v64.B8）；#54 三引擎 test 门禁生效（v64.A4/B9/C1；tree 腿由 B9 锁定；`--strict-wasm` 单独出现提示忽略 v64.C6）；#47 三引擎输出 5 + 违约 M4015（v64.B1/B2）；`fuzz --seed 44044 --count 40` 40 程序 0 分歧（wasm 真实执行 20）；proof_fuzz 100 例 0 误报；无新 M 码。**独立审查（3 名 fresh code-reviewer）**：唯一阻塞项 = 基类 `Interp.runTests` 漏透传（`ming test --tree` 门禁静默失效、与 GUIDE 声明漂移）→ 修复 + v64.B9 锁定；MINOR 5 项落实（ADR parse_f64/copy_file、GUIDE S7 措辞、capabilities 头注、strict 忽略提示）；S1/S2 核心 diff <100 行达成（vm.js 27+/8-、interp.js 计费+钳制+契约重入），#54 CLI 转发另计；latent N-60.1–N-60.4 登记。

**明确不做**：serve、Untrusted 实现、checker 拆分、覆盖率门槛、while 证明、ASan/launcher 沙箱、FFI 扩大、产物签名。

**风险/回退**：取消 wasm 搬运计费前必须验证 param-top 复位（否则线性内存随调用次数增长）；#53 钳制只缩短等待、不改变程序语义（超限本应 M4012）；#52 记账改变大输入程序的配额行为（本应如此，GUIDE 如实说明）；read_line/RegExp 边界不修，文档具名。

### 4.4.5 v0.61 — 污点最小片（条件；安全能力版）

> 主题唯一：只做"外部输入 → 路径/命令"注入面的最小污点闭环。
> **启动门槛（三条全满足才写实现）**：① v0.60 任务 6 的五处 ADR-002 补丁评审通过（**已满足**，2026-11-13 批次 1 落盘 + 审查）；② 12 工具迁移 spike 完成（**满足**，2026-11-14，报告见 `docs/adr-002-spike.md`：12/12 工具内容处理逻辑零改动；迁移调用点共 **12 处**（估计区间 12–20 下限；全部为 `env.get` 解包位，`read_line`/`extern` 在工具与示例中 0 处，argv 直收不标零迁移）——8 处路径实参位走 `sanitize_cli_path` 授权位，4 处非路径位（FIND_NAME/JSON_FIELD/RENAME_PREFIX/RENAME_EXT）需一次授权位登记或等价改道，均不动内容处理；9 源全量断点 8/12 工具，窄源 v1 断点 0）；③ 净化器策略裁决（**已裁决，2026-11-14**：选项①——新增 `std.unstr.sanitize_cli_path`（校验不改写：拒绝 NUL/C0 控制字符，Ok 原样返回；允许绝对/相对/.. 段），授权位与 `sanitize_path` 相同；否决 argv 不标方案。见 ADR-002 §3.4）。**门槛全部满足（①②③），v0.61 可进入实现**；实现期登记：GUIDE 一行授权位文字 + 3 个调用点包一层净化 + 测试向量锁定（**ADR-002 §3.4 的"CLI 匹配/比较串"扩权登记已于 2026-11-14 裁决时完成**；4 处非路径实参位中 RENAME_PREFIX 属路径目的地边界情形，随扩权一并覆盖——spike §6）。

**最小范围（窄源 v1）**

- 来源仅 `std.env.get`、`std.io.read_line` + extern 返回强制标污；`fs.read_file`/`read_bytes`/`read_to_end`/`proc.exec` stdout/stderr/`net.http_*` body **明确不标**（v1 泄漏窗口，写入 GUIDE 与来源白名单测试）。
- 载体仅 `str`；`std.unstr.sanitize_path`（或裁决后的 CLI 变体）+ `mark`；白名单 5 个纯产出方法（parse_i64/parse_f64/char_len/byte_len/is_empty）；`debug` 拒绝；**无** concat、bytes/Json/argv 载体、流敏感分析。
- 运行时擦除：tree/VM/wasm/C 输出逐字一致；只改 checker/interp/diag/文档；wasm `analyze()` 保持单一事实来源（如资格解包确需，仅一行）。

**任务**：checker 100–200 行；interp ≤50 行；2–3 个签名变更 + 12–20 个调用点迁移；§65 15–20 项；GUIDE/design/capabilities/README。
**验收**：迁移清单逐项勾；env→write_file 路径静态拒绝、sanitize 后通过；`read_file` 内容仍可 `split/print`（证明窄源不破坏工具）；四引擎标注程序逐字一致；fuzz 0；proof_fuzz 0；check 语料 ≤1.3x。

**验收（2026-11-14 实测）**：`node tests/run.mjs` **945 项 0 失败**（905 + §65 40 条 check）；迁移 12 处完成（8 工具，良性 env 行为与迁移前**逐字一致**——git worktree 基线 SMOKE-IDENTICAL；控制字符 env 值 → stderr + exit 1，净化器既定收紧）；env→write_file 路径静态拒绝（M3049 + hint）+ sanitize 后通过；`read_file` 内容 `split/print` 零改动（SMOKE 证实窄源不破坏工具）；四引擎标注程序逐字一致（默认/--no-wasm/--tree + **cc 擦除一致腿 v65.23**）；`fuzz --seed 44044 --count 40` 0 分歧（C 腿 6）；proof_fuzz 0 误报；新码 M3049/M3050 三处登记。**独立审查（fresh code-reviewer）**：2 MAJOR（C 后端 Untrusted 标注缺口、`C:x` 盘符相对漏判）+ MINOR 4 项全部修复（v65.21–24 补契约 sanitize/`as`/载体禁面/cc 腿）；**顺带修复污点实现暴露的既有缺口**：变体构造器载荷 tvar 从不绑定（`Some(脏)` 曾逃禁面）→ variantCtorType 补 `ps` + callCtor deepResolveT；struct 字面量字段位静默通过 → M3049 前置；latent **N-61.1/N-61.2** 登记。

**若门槛不满足**：本版退化为"测试与观测版"（vm.js +5 个具名函数至 ≥70%、manifest 2 个函数、覆盖率基线刷新），Untrusted 顺延；**不承诺实现**。

**明确不做**：9 源全量、`Untrusted[Json]`/`Vec[u8]`/argv 载体、流敏感/跨函数推断、净化的形式化证明。

**诊断码**：M3049（未净化 Untrusted 值流入受保护 sink）/ M3050（Untrusted 用于不支持的位置或洗白尝试），实现时三处登记；M3048 已由 v0.59 泛型本地函数占用，不得复用。

### 4.4.6 v0.62 — 服务端 v1（条件；独立版）

> 启动条件：**ADR-001 评审清单 16/16 已裁决（2026-11-14，架构师按默认立场逐项确认，见 ADR-001「评审清单」节）**；v0.60 的 #53 已交付（per-request timeout 依赖钳制）；serve 与污点的载荷问题已裁决（ADR-002 v1 载体仅 str，serve 载荷是 Json——v1 **不声称**请求受污点保护；若需保护，先裁决 `Untrusted[Json]`，不得静默扩载体）。**条件满足，serve v1 进入实现。**

**范围**：ADR-001 §5.2 原样——127.0.0.1、16/256/8MB/30s、Json 载荷、错误体、零新 M 码、handler 效果白名单 8（io/time/fs/net/env/rand/crypto/proc；sync/unsafe/ffi 拒绝）、无 handler 内 spawn；checker ~60 行 + interp ~350 行 + §66 ≥12。
**验收**：16/16 决策记录；§66 ≥12；三段式拒绝（tree/VM 双引擎一致、wasm 资格拒绝、cc 发射期拒绝）；190 req/s 量级与 16 worker 内存（0.9GB@16、队列上界 2GB）如实报告；回归全绿。
**明确不做**：TLS/UDP/自定义 host/WebSocket/keep-alive 调优/流式/handler 内 spawn/`Untrusted[Json]`。
**风险/回退**：任一清单项不勾 → 只留决策记录，serve 不进版本。

**验收（2026-11-14 实测）**：ADR-001 清单 **16/16 裁决落盘**（2026-11-14，架构师按默认立场逐项确认——SAB 容量定 32MB/请求复用、超时固定 30s、worker 启动失败 500+名额释放+计数）；checker ~90 行（SERVE_HANDLER_EFFECTS + serve 特例，零新码 M3029/M3002/M3005）+ interp +313 行（netServe + accept 线程 + 请求 worker）+ bin 回退检测；**§66 22 项 check**（≥12）含三引擎一致（tree 起服真实执行）、wasm 资格（strict 具名）、cc 发射期拒绝、CRLF 头注入护栏、9MB 响应护栏；错误体事件码与 ADR §2.1 **同步**（审查 M1：queue_full/timeout/handler_panic，M 码进 message）；独立审查 1 BLOCKER（accept 异步回调无护栏 → CRLF 头僵尸服务，实测复现）三层修复 + M2（跨模块 handler 收紧 M3002）+ m1/m3 落实；**顺带修复 wire 顶层 Json 多包外壳潜伏 bug**（spawn 顶层 Json 载荷曾 `j.v.has is not a function`；非 Json 载荷 HEAD 逐字不变）；`node tests/run.mjs` **967 项 0 失败**；fuzz 双种子（44044/777）各 40 程序 0 分歧；性能/内存如实（~60ms 冷启动、饱和 ≈190 req/s@16、55MB/worker RSS——ADR §2.4）。

### 4.4.6b v0.63 — wasm 剩余守护收口 slice 2（引擎全面性续篇，无新语言面）

> 主题唯一：把 §4.4.6a 的优先候选落成 wasm 能力——剩余五类守护（**mut Vec 元素写、Vec 下标读、Option 消费链 unwrap/expect、VecLit 数值元素、f64 复合赋值**）在 wasm 内真实执行；新形态语料 strict **fallback=0**；语义不变（panic 码/消息/span 与 tree/VM 逐字一致）。
> **任务**：
> 1. **宿主导入**：vm.js 新增 `panic_m4003(spanIdx, idx, len)` / `panic_m4006(spanIdx)`（消息逐字 `索引越界:长度 N,访问 I` / `对 None 调用 unwrap()`；span 取下标表达式/调用点，与 interp.js:856/1009/3246 同源口径）；wasm.js 导入段登记（现仅 panic_m4002/m4004）。
> 2. **Vec 下标读**：界内读线性内存 `[len][cap][elems]`；越界 → panic_m4003。
> 3. **mut Vec 元素写**：界内写回线性内存（后续读可见）；越界 → panic_m4003。
> 4. **Option 消费链**：unwrap 的 None 分支 → panic_m4006；**expect(带自定义 msg) 与 Err unwrap 保持守护**（消息需 str 穿越导入边界/含载荷 display，具名登记留后续 slice）。
> 5. **VecLit 数值元素**：线性内存构造型（ming_alloc 16+8n + 元素写入，返回 ptr）——与 v0.23 的 let/返回容器表示统一。
> 6. **f64 复合赋值**：f64 局部的 `+=/-=/*=//=`。
>
> **验收**：新形态语料 strict fallback=0；§67 ≥12（五形态正例三引擎逐字 + 越界/None 的 panic 消息-span-退出码逐字 + strict 存活断言）；fuzz 双种子 0 分歧；Err unwrap 守护具名登记；回归全绿。
> **验收（2026-11-14 实测）**：宿主新增 **4 导入**（panic_m4003 读带 `.get(i)` 后缀/panic_m4003w 写无后缀/panic_m4006/ming_alloc_elem）——全部尾部追加，导入索引 69 个逐处核对（G1 开发期一次 off-by-one 当场修复，教训入注释）；五形态 + 组合函数 strict 存活（自造语料 20 程序 19 存活 1 具名回落，抽查口径）；**计费对齐**：VecLit 计费改 n 元素（ming_alloc_elem，计 n/分配 16+8n 分离）、ming_copy_vec 派生拷贝不计费（#51 口径）——`--max-alloc` 三引擎矩阵逐字（len3 max3=0/max2=M4011 累计 3）；**panic 栈填充保留**（callCompiled catch 补栈，M4003/M4006/M4002 wasm 完整 stderr 与 --no-wasm 逐字）；**审查 B1 修复**：iscratch 跨表达式复用 → 五处 base ptr 改专属 tempSlot（含审查未发现的跨变量嵌套/Map 读嵌套两类潜伏冲突），8 个复现程序三引擎逐字；fuzz 双种子 0 分歧；`node tests/run.mjs` **995 项 0 失败**（967 + §67 28 条）；独立审查 1 BLOCKER + 2 MAJOR + MINOR 全部修复；残留具名登记 #58/#59 + N-63 系列。
> **明确不做**：Result unwrap/expect 链（wasm）、Vec[str] 元素写（句柄容器）、守护面之外的 wasm 扩张、while 证明/checker 拆分（维持 Backlog/背景）。

### 4.4.6a 后续与 Backlog（v0.64 起，不承诺；**2026-11-14 第三轮评估已逐项处置——见 §4.5.4**）
- **walker 统一（择机）**：checker 内多处线性体遍历器（walkLinearBody/exprIsLinear/stmtIsLinear）收敛为单一实现——零行为变更，随契约改动顺带，不单独立版。
- **while 守卫证明（Backlog，不承诺）**：只做"循环条件作为体内假设、赋值即失效"的最小形态；**不做归纳不变式**。proven 不消除运行时 M4003，收益仅为少一条 W3105；无正收益证据前不进入版本。
- **checker 拆分（背景项，不进入版本）**：5,273 行 / 310 函数 / 90.3% 函数覆盖，纯重构零功能价值；如需结构，只允许"新增模块放新表"（污点表），不搬 5k 行。
- **其他**：覆盖率/bench 信息性刷新；usage audit 对照；安全审计窗口。

### 4.4.7 跨版本技术债与观测（延续 §4.3.8）

| 项 | 内容 | 版本 | 说明 |
|----|------|------|------|
| 资源门禁一致性 | #51/#52/#53 + #54 CLI 旗标 | **✅ v0.60 交付** | 三引擎配额矩阵（v64.A1/A2/B3–B5）+ tree 腿（v64.B9）；无新 M 码；S1/S2 核心 diff <100 行 |
| tree 契约重入 | #47 | **✅ v0.60 交付** | tree/VM 输出一致（v64.B1/B2）；仅 interp.js |
| ADR-002 五处补丁 | 来源/白名单/净化器/debug/码号 | **✅ 已落盘** | 评估期落 a/e + 批次 1 落 b/c/d + 审查修正 |
| 污点窄源 v1 | Untrusted[str] 最小闭环 | **✅ v0.61 交付** | 门槛①②③满足后实现；§65 40 条；迁移 12 处/零内容改动；M3049/M3050 |
| 服务端 v1 | ADR-001 清单裁决 + serve | **✅ v0.62 交付** | 16/16 裁决 + §66 22 项 + 三段式拒绝；错误体事件码与 ADR §2.1 同步 |
| wasm 守护 slice 2 | 下标/mut 写/Option 链/VecLit/f64 复合赋值 | **✅ v0.63 交付** | 宿主 4 新导入;strict 新语料 fallback=0;计费对齐(ming_alloc_elem/copy_vec 派生不计费);B1 iscratch 修复;残留 #58/#59 具名 |
| vm.js 覆盖率 | 实测 65.9%（54/82，v0.60 全表）；+4 具名函数即 70% | 信息性，不设门槛 | 40 opcode 是 case，不是函数；wasm 宿主导入 lambda 稀释函数计数 |
| checker 拆分 | 背景，不进入版本 | — | 纯重构零功能价值；并行会话冲突风险 |
| while 守卫证明 | Backlog | — | v0.57 可选子目标；proven 不减 M4003 |
| invariant bench 项 | mut-self 循环 + invariant 成本 | **✅ v0.59 交付** | 0.19–0.28µs/次（占循环墙钟 20–27%，按 5% 判据如实报告） |
| moltbook/usage | 缓存后审计对照 | 随版附注（不设版本） | 非代码、非门槛 |
| GUIDE 交叉引用 | 1760+ 行补强 | 随版附注 | 非代码、非门槛 |

### 4.4.8 明确不做（v0.59–v0.62+）

- 沿用 §4.3.9 全部条目（包注册表/第三方依赖/交叉编译/GUI/调试器/eval/完整 SMT/删除运行时检查/10 万级连接/WebSocket/流式/keep-alive 调优/TLS/UDP）。
- **新增**：mask 不复活（ADR-003 永久否决）；污点效果建模不做（ADR-002 终局）；wasm 不支持 `match` 的声明维持（C 行 match 正确性不受影响）；不做"删除运行时边界/契约检查以换性能"。
- **三方评估新增**：不做 serve + 门禁修复混版；不做 Untrusted 9 源全量 v1；不做 checker 拆分作为版本项；不做 vm 函数覆盖 ≥70% 版本门槛；不做 while 归纳证明（近三版）；不做 ASan 腿/OS 级沙箱/产物签名/Actions SHA 固定/第三方 action；不做 FFI struct/array ABI 扩大；不为 S1/S2 新增 M 码；不做效果 diff 工具（`doc --json` + interface_hashes 已覆盖）；不把 deepCopy/json.parse/re.* 全量计费作为任务（派生值不重复计费）。

### 4.4.9 成功度量

| 版本 | 完成判定（全部满足） | 量化门槛 |
|------|---------------------|----------|
| v0.59 | **✅(2026-11-13)**:strict 模式已知回落清零(保留守护逐条具名);本地函数恢复且三引擎一致;记账统一(#48/#49);P1/P2/P3 独立审查修复全落地(`<<` 溢出/M4007 对齐/字面量计费/兄弟 ensures/lambda 捕获/遮蔽语义/M3015/M3048) | **§63 56 项(≥24);回归 881 全绿(≥860);fuzz eligible 族 120 语料 fallback=0;proof_fuzz 0 误报** |
| v0.60 | **✅(2026-11-13 实测)**:资源门禁一致性交付(#51/#52/#53/#54 + #47 + ADR-002 五处补丁 + 文档/基线收口);无新语言面/无新诊断码;3 名 fresh reviewer 阻塞项(基类 runTests 透传)修复后全绿 | **§64 24 项(≥14);回归 905 全绿(≥895);三引擎配额矩阵逐字(v64.A1/A2/B3–B5);S1 sleep/join <2s M4012;fuzz 40 程序 0 分歧(wasm 真实执行 20);proof_fuzz 0 误报;无新 M 码** |
| v0.61 | **✅(2026-11-14 实测)**:窄源 Untrusted v1 交付（门槛①②③满足：五处补丁评审 + 12 工具迁移 spike + sanitize_cli_path 裁决）；迁移清单 12 处逐项勾、12/12 工具零内容改动；四引擎标注程序逐字一致；M3049/M3050 三处登记；独立审查 2 MAJOR + MINOR 全部修复 | **§65 40 条(≥15–20 上限)；回归 945 全绿；迁移 ≤20 处(实测 12)；fuzz 40 程序 0 分歧；proof_fuzz 0 误报** |
| v0.62 | **✅(2026-11-14 实测)**:ADR-001 16/16 裁决落盘 + serve v1 交付（worker-per-connection；127.0.0.1；16/256/8MB/30s；Json 载荷；零新码；accept 三层护栏）；独立审查 1 BLOCKER + 4 MAJOR 修复；wire 顶层 Json 潜伏 bug 顺带修复 | **§66 22 项(≥12)；回归 967 全绿；三段式拒绝锁定；fuzz 双种子 0 分歧；性能/内存如实报告** |
| v0.63 | **✅(2026-11-14 实测)**:wasm 守护收口 slice 2 交付（五形态 + 宿主 4 导入 + 计费对齐 + panic 栈单层补齐；审查 B1 iscratch 五处专属槽修复——含审查未发现的两类嵌套潜伏冲突）；无新语言面/无新 M 码 | **§67 28 项(≥12)；回归 995 全绿；strict 新形态 fallback=0（自造语料 19/20 抽查）；计费三引擎矩阵逐字；fuzz 双种子 0 分歧；残留 #58/#59 具名** |
| 持续 | 覆盖率/bench 信息性刷新；usage audit；安全审计窗口 | 不设门槛 |

**跨版本共同门槛**：沿用 §4.3.10 末行（全量绿/0 分歧/分节测试/文档三处/版本三处/诊断三处/不留生成物/性能可复现）。

### 4.4.10 三方评估记录（2026-11-13；software-architect / security-engineer / minimal-change-engineer）

> 基线：HEAD 9251e08（v0.59.0，881 项全绿，四后端）。三份独立报告 + 主会话复核；结论均有本机实测或源码路径。评估结论已落入 §4.4.4–§4.4.6a（版本重排）、§4.4.7–§4.4.9（范围与度量）与 §5.1（#51–#57）。

**安全审计（S1–S8）**

| # | 项 | 严重度 | 实测/证据 | 处置 |
|---|----|--------|-----------|------|
| S1 | `--max-ms` 被阻塞内建绕过 | P1 | `sleep(3000)` + `--max-ms 100` → 3,213ms exit 0；`join` → 3,283ms exit 0；根因 `checkTimeQuota` 每 16,384 步轮询，阻塞内建不经过 | **v0.60 #53**：`remainingMs` 钳制 sleep/join/exec/http；read_line/RegExp 文档化边界 |
| S2 | `--max-alloc` 记账缺口 | P1 | ① wasm Vec 实参按字节计费（16+8n）而 tree/VM 不计 → `sum([1,2,3])` max20 默认 M4011/`--no-wasm` 0；② `read_file` 182,819B + max10 → exit 0 | **v0.60 #51/#52**：param-top 复位 + 取消搬运计费；外部边界计费；派生不重复计费 |
| S3 | 污点 `Untrusted[T]` 未实现 | P1（能力） | ADR-002 采纳但 9 源全量会让 `mingkit`/`json_query`/`diaghot`/`log_analyzer`/`edit` 直接 M3002；`debug(any)->str` 是洗白通道；`bytes.to_str` 无桥接规则 | **v0.60 ADR 五处补丁 + v0.61 窄源 v1（条件）** |
| S4 | FFI str 内嵌 NUL 截断 | P2 | `strlen("ab\0cd")=2`，Ming 侧长度 5 → 静默截断；加载面（RTLD_GLOBAL/LoadLibraryA）未文档化 | 文档 + 回归（#55）；是否拒绝需语义裁决，不进入 v0.60 |
| S5 | AOT artifact 结构校验缺失 | P2 | 反序列化只验 format/version；损坏 `mainFnIdx`/表长 → raw TypeError | Backlog（#56）；低成本索引/表长校验 |
| S6 | 安全回归缺位 | P2 | FFI NUL、损坏 artifact、污点负例无测试；M4013 无专项回归 | 随 v0.61 补（#57） |
| S7 | `std.rand` 非 CSPRNG | P2（文档） | mulberry32 / 32 位状态，可用于非安全随机 | **v0.60 文档声明**：GUIDE 写明不得用于密钥/nonce；不新增 `std.crypto.random_bytes`（无消费方） |
| S8 | 效果 diff 工具 | P2（建议） | `doc --json --index` 已输出 `with` 效果；`build --json` 的 `interface_hashes` 已含效果 | **拒绝**：重复能力，无消费方 |

**架构评估的关键事实纠正**

1. **覆盖率数字过时**：v0.59 实测 93.5% 行 / 88.3% 函数；`vm.js` 函数覆盖 **63.8%（51/80）**，不是 43.8%。未覆盖的 26/29 是 **wasm 宿主导入闭包**，不是 opcode；40 个 opcode 是 `execLoop` 内的 case（不是函数）——"操作码直测"前提不成立。距 70% 只差 5 个具名函数 → 信息性，不设版本门槛。
2. **#47 是活分歧**：tree M4005 exit 101 / VM 正常 → 前移 v0.60（原 v0.61）。
3. **`ming test`/`ming init` 零 CLI 回归且旗标不传播** → 新缺陷 #54，v0.60。
4. **文档/编号漂移**：README 状态段 v0.57 / design 头 v0.54 / plan §4.4 基线 861；§63/§64/§65 分节分配冲突；ADR-002 拟用 M3048 已被 v0.59 占用 → M3049/M3050。

**版本重排裁决（原 v0.60 为什么拆掉）**

原 v0.60 = serve（条件新运行时面）+ 覆盖率补测（指标门槛）+ checker 拆分（纯重构）。最小变更工程师裁决：三个主题、一个条件大面、一个纯重构、一个指标门槛，无法独立回退——这是 v0.59 之前范围膨胀模式的复发。安全评估的 S1/S2 是**已实测的门禁承诺被绕过**，优先级高于新能力面。重排后：

- **v0.60 = 资源门禁一致性**（#51/#52/#53/#54 + #47 + ADR-002 文档补丁 + 基线收口）——无新语言面，S1/S2 核心 diff <100 行。
- **v0.61 = 污点窄源 v1（条件）**——先 spike 后实现；门槛不满足退化为测试版。
- **v0.62 = serve v1（条件，独立版）**——ADR-001 16/16 全勾才启动。
- **v0.63+ = 候选/Backlog**——wasm 守护 slice 2、walker 统一；while 证明、checker 拆分不承诺。

**明确不做（评估裁决）**

- 不把 serve/覆盖率/checker 拆分合并进任何单版；serve 不早于 v0.62。
- 不做 9 源全量 Untrusted v1；不做 `Untrusted[Json]`/`Vec[u8]`/argv 载体（v1.1 需载体设计）。
- 不做 vm 函数覆盖 ≥70% 版本门槛；不做 checker 拆分版本项；不做 while 归纳证明（近三版）。
- 不做 ASan 腿、OS 级 launcher 配额/沙箱、产物签名、Actions SHA 固定、第三方 action。
- 不做 FFI struct/array ABI 扩大；不做效果 diff 工具；不为 S1/S2 新增 M 码。
- 不把 deepCopy/json.parse/re.* 全量计费作为任务（派生值不重复计费）。

**证据（本机实测，2026-11-13，HEAD 9251e08）**

```text
# S2-a
sum([1,2,3]) --max-alloc 20: run exit 101 (M4011, 累计 43) / --no-wasm exit 0 (6) / --tree exit 0 (6)
# S2-b
fs.read_file("GUIDE.md") 182,819 bytes --max-alloc 10: exit 0, 输出 182819
# S1
std.time.sleep(3000) --max-ms 100: 3,213ms exit 0; join 子任务: 3,283ms exit 0
# #47
ensures if a > 0 { true } else { true }: --tree M4005 exit 101 / run 输出 5
# 覆盖率（tests/coverage.mjs --json；881 通过 0 失败，10.4 分钟）
总行 93.5% / 函数 88.3%; vm.js 行 95.3% / 函数 63.8% (51/80)
# 工具迁移阻塞（9 源全量污点）
mingkit / json_query / log_analyzer / edit 的 read_file 内容处理 + diaghot 的 proc.exec stdout 处理全部 M3002
```

---

## 4.5 v0.64+ 规划（software-architect 精读第三轮 + security-engineer 安全评估第二轮，2026-11-14）

> **规划基线**：v0.63.0（HEAD 18a21b0）；**995 项回归全绿**；fuzz/proof_fuzz 双种子 0 分歧/0 误报；能力矩阵 55 行 ≈84%；覆盖率基线 94.0% 行 / 88.7% 函数（v0.60 全表口径，v0.61–v0.63 未刷新）。
> **精读结论（架构）**：v0.60–v0.63 四版全部按"一版一主题、独立回退"交付，纪律执行为四轮规划以来最好的一段。当前最大的债不在能力面而在三处：① **P2 缺陷 #55/#56/#57 连续两版搁置，#57 已构成书面承诺漂移**（§5.1 写"随 v0.61 补"，实测 `M4013` 在 tests/run.mjs 出现 0 次）；② **观测面三处长期未跑**（usage audit 快照停 2026-11-12、moltbook 无新汇报、覆盖率基线落后三版）——serve v1.1 / Untrusted[Json] / eval 三个决策全部卡在"没有使用反馈"；③ **北星支柱 4（解释器即库）四轮规划零触碰**（连 ADR 都没有）。checker.js 实测 5,555 行（v0.61 污点面进主体，违反既定"新表进新模块"纪律的先例）。
> **安全结论（第二轮，全部实测）**：上轮 S1/S2 已修复测通过、S3 污点窄源交付且洗白禁面/sink 门禁/const 洗白拒绝全部实测成立（一次初测"死代码缺口"系测量假象已勘误）；serve 为首个常驻网络面（127.0.0.1 固定 = 本机攻击者前提），头注入已护栏、慢连接不占 worker、队列公平性 272 受理 8 拒逐字；新发现 **S9–S16** 八项（见 4.5.7），其中 S9（嵌套 serve 无 policing）与 S14（#56 失败形态不一致）为 P2。
> **第三轮裁决**：**先清债（v0.64 信任边界与诚实失败收口）→ 引擎面收尾（v0.65 wasm slice 3 + #59）→ 校准与反馈（v0.66 纯观测版）**——把"观测"从连续三版未执行的"随版附注"升格为版本主题，让 serve v1.1 / Untrusted[Json] / eval 在有证据而非有直觉的前提下进入后续版本。

### 4.5.1 v0.64 — 信任边界与诚实失败收口（质量/安全版，无新语言面；零新增 M 码）

> 主题唯一：FFI 入口、AOT 产物入口、serve 行为面三类"承诺与实现一致"的收口——与 v0.60"资源门禁一致性"同性质。核心 diff <100 行。
> **#55 语义裁决（架构 vs 安全分歧，采纳安全侧）**：架构主张"拒绝截断 + 新码 M4017"；安全实测**实参路径当前经 C 资格面不可达**（`Vec[u8]`/`Result[str,str]` 的 let 标注均被 C2 拒绝、无 NUL 字面量——S15/c2），M4017 是给不可达路径写代码。**裁决 = 文档 + 回归 + 前置义务**：GUIDE FFI 节写明"extern 返回按 strlen 语义，C 侧含内嵌 NUL 的数据静默变短（实测 `byte_len=2` 黄金）"；"FFI 面扩大（Vec[u8] 实参等）时必须先裁决 NUL 策略"登记为前置义务；架构侧第一原则论据存档（届时裁决的依据），不预支实现。

**任务**
1. **S14/#56 AOT artifact 结构校验 + 失败形态统一（P2）**：deserializeArtifact 后置索引/表长校验（`mainFnIdx` 越界/负值、`functions=[]`、非法 opcode → 稳定诊断；实测四种损坏形态现为 raw TypeError exit 1 / M3023 / M4001 三种不一致形态）；损坏样例入回归。
2. **S9 嵌套 serve 编译期拒绝（P2，回环内）**：checker 静态拒绝 handler 体内的 serve 调用（spawn 纪律复用，~20 行；实测 check 现放行、内层真实绑定、外层 30s 硬杀后内层连同在途连接被斩）。非 handler 位置的嵌套/多 serve 维持现状并文档化。
3. **S12 `sanitize_cli_path` 闸门扩展（裁决：修，1 行 + 向量）**：拒绝集从 `<0x20` 扩为 **NUL/C0/DEL(0x7F)/C1(0x80–0x9F)/Unicode 双向控制符(U+202A–202E)**——实测 DEL/C1/RTL 均放行（终端回显 RTL 视觉反转）；拒绝优于含糊；升级属净化器既定收紧，GUIDE 登记一行。
4. **#57 安全回归批（P2，承诺漂移兑现）**：本轮全部攻击向量入 `tests/run.mjs`——M4013 FFI 门禁专项（首破 0 次记录）、#55 NUL 返回路径黄金（`byte_len=2`）、#56 四损坏形态、S9 拒绝、S12 扩集向量、S11 兜底语义、S13 慢连接行为、污点正负例（§65 已有部分，查漏补缺）。
5. **文档收口（S10/S11/S15/S16）**：GUIDE serve 节加"**handler 收到的载荷全部不可信**，路径/命令必须过 sanitize_*"警告（S10）；serve 节补"非法 status/headers 值按缺省兜底（200/{}/\"\"）"句（S11）；GUIDE FFI 节 strlen 截断语义（S15）；`worker_start_failed` 标签拆分随本版触碰 accept 代码顺手做（S16）。
6. **#58 顺带（P3，若断言面可控）**：mut Vec 元素写越界 panic 位置 VM 与 tree 差 1 列——compiler SETINDEX span 调整；先 grep 全部既有 panic 位置断言，逐条校准不静默；**断言面超出预期则顺延并在报告注明**。
7. **文档漂移清扫（第四轮复核范围扩大）**：原四处（README「核心特性(v0.59)」头部版本、路线图四条目"(当前)"收敛为单条、capabilities.md 诊断码计数按 diag.js 现状改判、§5.1 状态行更新）之外追加——(a) M3012 hint 文本"实现 to_str(计划 v0.2)"改为 ToStr trait impl 现行口径（诊断消息属发布面，改文案不改码号）；(b) REPL 横幅"Ming v0.8.0"（src/repl.js）与实际版本对齐；(c) docs/diagnostics.md 与 diag.js CODES（实测 **77** 码）计数核对（含 M3047 废弃标注一致性）。

**验收（实测口径）**：`node tests/run.mjs` 995 + §68 ≥10 全绿；损坏 artifact 四形态 → 稳定诊断统一（非 raw TypeError）；handler 内 serve → check 编译期拒绝；DEL/C1/RTL 进 sanitize_cli_path → Err；`M4013` 在 tests/run.mjs ≥1 专项断言；fuzz 双种子 0 分歧；无新语言面、零新增 M 码。

**验收（2026-11-14 实测）**：`node tests/run.mjs` **1016 项 0 失败**（995 + §68 21 项）；#56 四损坏形态 → 统一稳定诊断"不是 Ming 字节码产物: <原因>"（raw TypeError 消除；33 opcode 全特性探针 + 21 损坏变体 + 工具 AOT 缓存自愈兼容）；S9 → 编译期拒绝（**两遍式**；审查 M1 遮蔽误伤修复——serveCallNodes 以 checker 真实解析为单一事实来源）；S12 → DEL/C1/RTL 全 Err（代理对不误拒）；M4013 专项**首破 0 次记录**（v68.9b cc 腿 + v68.9a M3029 门禁）；NUL 黄金 byte_len=2（自编 DLL 实测）；#58 → 三引擎 panic 位置逐字（SETINDEX span 对齐，翻转 0；**cc 侧残留登记**——cbackend.js:986 语句列 + ming_vec_set 消息带读后缀）；M5001 补登记 diag.js（78 码）；M3012 hint/REPL 横幅/README/capabilities/diagnostics 漂移清扫；`fuzz --seed 44044 --count 40` 0 分歧。**独立审查**：通过（validateArtifact 校验面与 VM 取数面逐点吻合、S9 两遍式修复遮蔽误伤、S12 向量补齐、M5001 三点闭环）。
**风险/回退**：S9 是新静态拒绝面——正反例双向锁定（跨模块 serve handler/同模块正例）；#58 动 panic 位置断言面——可控性优先，超预期即顺延；S12 扩集可能影响既有工具的怪路径回退——12 工具冒烟 + 迁移清单复核。

### 4.5.2 v0.65 — wasm 守护收口 slice 3（引擎全面性终章，无新语言面）

> 主题唯一：把 §4.4.6b 具名清单剩余五项落成 wasm 能力，守护面从"具名清单"收窄至"仅注释登记不可达项"（`?` 运算符——返回函数本就不 eligible）；此后守护类工作从 Backlog **永久移除**。

**任务**
1. **expect(带 msg)**：消息 `expect 失败: <msg>`——msg 为编译期常量，经 strConsts 表索引穿越导入边界（宿主 panic 导入带 str 槽；同 v0.63 panic_m4003/m4006 模式）。
2. **Map unwrap**：宿主新增 `map_has` 判定导入（map_get 语义拆分：先 has 后 get），None/缺键分支 → panic（消息逐字对齐 tree/VM 的 `对 None 调用 unwrap()` 口径——实测确认）。
3. **Err unwrap**：消息含载荷 display——str 载荷经 strTable 句柄、数值载荷直传，宿主拼装与 interp 同源消息（`对 Err(...) 调用 unwrap()`）。
4. **Vec[str] 下标读**：str 元素 = 句柄（i32），界内读返回句柄；越界 → panic_m4003（带 `.get(i)` 后缀）。
5. **下标复合赋值 `v[i] += x`**：读-改-写三步展开（wasm.js `Unsupported('下标复合赋值 +=')` 点位）。
6. **#59 顺带（P3）**：wasm→wasm 直调 panic 栈缺内层帧——调用点 span 透传 callStack；与本版 msg/载荷穿越机制同源，一次改齐；§67 v67.20 按现状的断言翻转锁定。

**验收（实测口径）**：守护具名清单五项全部解锁；自造语料 strict 残留 = 0（或仅具名不可达项 `?`）；§69 ≥12（五形态正例三引擎逐字 + panic 消息-span-退出码逐字 + strict 存活断言 + #59 栈帧逐字）；fuzz 双种子 0 分歧；回归全绿。

**验收（2026-11-14 实测）**：`node tests/run.mjs` **1035 项 0 失败**（1016 + §69 19 项）；五形态 + 组合函数 strict exit 0（自造语料 c01–c18 残留 0）；panic 三条（Map 缺键/Err(str) unwrap/expect msg）三引擎 stderr 首行+位置+exit 101 逐字；#59 嵌套栈帧三引擎完整 stderr 逐字（at g 回归）；Err display 三型（i64/u64 位型保真/f64）逐字；下标复合赋值全操作矩阵 + 双重求值副作用锁定（VM 路径）+ wasm 步数可观测对照（v69.10c）；守护余项全部 strict 具名（v69.14/15）；计费回归三引擎一致；`fuzz --seed 44044 --count 40` 0 分歧。**独立审查**：通过——2 MAJOR 修复（M1 无标注 Result let 的 resCtorSlotTy ReferenceError 非具名回落 → 签名补 ctx + 标注非标量具名守护；M2 Result.expect 求值序 msg 先于接收者 → recv→args 恢复，双 panic span 三引擎逐字）；**导入 69→80 尾部追加零错位**（WebAssembly.Module.imports 枚举核对）；遗留登记 N-65.1–65.4（句柄池无回收/直调 +18%/is_some 口径修正/M4002 消息口径 HEAD 预存）。
**风险/回退**：三类新导入（map_has / panic 带 str 槽 / Err 载荷 display）各独立登记与测试，任一项 strict 回归不绿即停下评估（§4.4.3 四步纪律）；导入表追加沿用 v0.63 教训（尾部追加 + 索引逐处核对 + `iscratch` 类跨表达式槽复用审查——v0.63 B1 教训入审查清单）。

### 4.5.3 v0.66 — 观测与反馈（校准版，零语义改动）

> 主题唯一：把连续三版未执行的观测纪律补齐，并为 serve v1.1 / Untrusted[Json] / eval 三个悬决项提供裁决依据。src 语义零改动。

**任务**
1. **usage audit 重跑**：`tests/usage_audit.mjs` 对新会话 rollout 重跑并刷新 docs/usage-audit.md 快照（现快照 2026-11-12，落后四个版本；工具缓存/污点迁移/serve 均在其后）。
2. **moltbook 汇报**：≥1 条新讨论记录（v0.60–v0.63 能力面、污点对工具生态的影响、serve 可用性），登记 docs/moltbook.md。
3. **真实 serve 服务观察**：用 `std.net.serve` 写一个真实自用小服务并长驻观察，记录：N-62.1 的 `--max-ms` 长驻配额实际操作、55MB/worker RSS 真实影响、优雅停机需求是否真实出现、handler 效果白名单是否够用、错误体 Json 可诊断性。产出 **serve v1.1（优雅停机）go/no-go 裁决**（实现路径已预留：interp.js 注释——i32[0] 置 2 唤醒，约 30–50 行）。
4. **覆盖率/bench 基线刷新**：`tests/coverage.mjs --json` 全表 + `bench --write-baseline`，标注时点（v0.61–v0.63 新增约 400 行 src 未入快照）。
5. **capabilities 全表复核**：诊断码计数类漂移清零（"71 码"已由 v0.64 修正，本版全面复核）；GUIDE 交叉引用补强（1760+ 行，§4.3.8 遗留）。
6. **Untrusted[Json] 载荷 ADR 落盘**（若任务 3 反馈支持）：serve 载荷（HTTP body）是网络内容源但完全在污点面之外（S10 实测 body→write_file 路径 check 直通）——ADR 裁决载体语义（Json 载荷的 sink 位与净化器语义），实现（taint v1.1）等 go 裁决，不在本版。
7. **AI 修正回路快照（第四轮增补；仅测量与登记，src 零语义改动）**：以固定错误语料（≥15 形态）统计 `check --json` 的 fix 处方覆盖率与正确率、级联诊断数（根因 1 → 报告 N 的放大比）、误导 hint 命中数（实测先行证据：#62 级联 4 诊断 + M3001 误导处方 `r`→`str`）；为 v0.67 候选主题"诊断协议校准"提供 go/no-go 证据。**采用判据阈值（v0.66 批次正式化，审查 MINOR-2 归属修正）：go = 误导 hint ≥3 或 级联比 ≥2 或 fix 错误 ≥1；否则 no-go 转其它主题**。不改任何诊断发射行为。

**验收**：三个报告文件均有新时点快照；moltbook.md ≥1 条新记录；serve 服务有可复现的观察记录与裁决结论；基线文件更新且标注时点；`node tests/run.mjs` 计数不变且全绿；src 零语义改动。

**验收（2026-11-14 实测）**：三报告落盘（ai-loop-snapshot.md / serve-observation.md / coverage-baseline.md v0.65 全表）+ usage-audit.md 限制节 + **moltbook 评论 b28bbcac**（v0.60–v0.65 进度，/home activity 0 无社区回复项）；coverage 插桩 1035 全绿（10.8 分钟，JSON 4042 个解析失败 0）——**94.6% 行/89.2% 函数，vm.js 函数 74.2% 跨过 70% 信息线**；bench --write-baseline（**双项 WARN 复测注记落盘**）；AI 快照 GO（判据阈值已正式化入任务 7）；serve v1.1 **no-go 推迟**（有界观察支撑）；ADR-004 落盘（14 项清单）；**src 零语义改动**（git diff 核实）；独立审查通过（1 MAJOR bench 注记落盘 + 4 MINOR 全修——含 plan 判据阈值正式化与 #62 口径回写）。
**明确不做**：serve v1.1 实现（等 go 裁决）、Untrusted[Json] 实现（等 ADR + 裁决）、任何新语言面。

### 4.5.4 对 §4.4.6a Backlog 的处置

| 项 | 处置 | 理由 |
|----|------|------|
| wasm slice 3 残留守护 | **升格 → v0.65** | 具名清单延续，三类导入设计路径明确；做完后守护类工作永久移出 Backlog |
| #55/#56/#57 | **升格 → v0.64**（#55 采纳安全侧：文档 + 回归 + 前置义务，不做 M4017） | 两版搁置 + #57 承诺漂移；信任边界主题统一 |
| #58 | **升格 → v0.64 顺带**（断言面可控性优先） | 错误可观察面一致性，与 #57 同批 |
| #59 | **升格 → v0.65 顺带** | 调用点 span 透传与 slice 3 机制同源，一次改齐 |
| S9/S12（本轮安全新发现） | **升格 → v0.64** | 嵌套 serve 静态拒绝 + sanitize 闸门扩展；实测支撑 |
| 观测（usage audit/moltbook/覆盖率/bench） | **升格 → v0.66 主题** | "随版附注"连续三版未执行；反馈缺失是下一步所有决策的瓶颈 |
| serve v1.1 优雅停机 | **条件升格**（触发 = v0.66 任务 3 确认需求） | 实现路径已预留、成本低，反馈真空期不做猜测性投入 |
| Untrusted[Json] 载荷 | **ADR 先行（v0.66 任务 6），实现条件承诺** | serve 载荷 = 真实威胁面；载体 ADR 是启动门槛（沿 v0.61 门槛制先例） |
| eval/热重载 ADR | **规划期任务（不占版本主题）** | 北星支柱 4 四轮零触碰；验收标准从"零触碰"提升为"有裁决记录"（四问：eval 来源与污点交互/效果声明与静态检查边界/引擎限制/与热重载范围切分）；不承诺实现时间 |
| walker 统一 | 继续搁置 | 零行为变更，维持"随契约改动顺带"（checker.js:2537/2563/2584 三套遍历实证存在） |
| checker 拆分 | 继续搁置，**纪律升级** | "新表进新模块"升级为硬纪律：今后 checker 内任何新分析表必须新建模块，主体只加引用（v0.61 污点面进主体是违例先例，不再重复） |
| while 守卫证明 | 继续搁置 | proven 不减 M4003，收益仅少一条 W3105，无正收益证据 |
| S13 连接级上限 | **接受并登记**；作为 serve 放开项 ADR（自定义 host）的前置义务 | 127.0.0.1 固定绑定是主防线；慢连接不占 worker（实测）；队尾等待上限 480s 由 node:http 默认超时兜底 |

### 4.5.5 明确不做（v0.64–v0.66）

- 沿用 §4.4.8 全部条目（包注册表/第三方依赖/交叉编译/GUI/调试器/完整 SMT/删除运行时检查/10 万级连接/WebSocket/流式/keep-alive 调优/TLS/UDP；mask 不复活；污点效果建模不做；ASan/OS 级沙箱/产物签名/Actions SHA 固定；FFI struct-array ABI 扩大；9 源全量污点）。
- **新增（第三轮）**：serve v1.1 与 Untrusted[Json] 不在反馈/裁决到位前实现；eval 只做 ADR 不承诺实现；自定义 host/TLS 另 ADR（S13 前置义务随该 ADR 评审）；checker 拆分不进版本（"新表进新模块"硬纪律）；while 归纳不变式不做；覆盖率函数 ≥70% 维持信息性；不为 S9–S16 新增 M 码（S14 复用既有诊断通道收紧）；不做 SAB 消息槽加锁（无实害，登记即可）。

### 4.5.6 成功度量

| 版本 | 完成判定（全部满足） | 量化门槛 |
|------|---------------------|----------|
| v0.64 | **✅(2026-11-14 实测)**:#55 裁决落盘（文档 + 前置义务 + NUL 黄金回归，M4017 提案经安全实测否决存档）；#56 校验 + 四损坏形态统一（validateArtifact，21 变体）；#57 安全回归批落地（M4013 专项首破）；S9 编译期拒绝（两遍式）；S12 扩集；#58 顺带（三引擎逐字）；文档漂移清扫（77→78 码对齐/M3012/REPL 横幅） | **§68 21 项(≥10)；回归 1016 全绿；损坏 artifact → 稳定诊断统一；`M4013` 专项断言 ≥1（首破）；fuzz 双种子 0 分歧；无新语言面、零新增 M 码** |
| v0.65 | **✅(2026-11-14 实测)**:slice 3 五形态解锁（expect 字面量 msg/Map unwrap/Err unwrap·expect/Vec[str] 读/下标复合赋值+标量 &=|=^=）+ #59 栈帧兑现（Route E 帧透传）；守护具名清单清零（余项全部 strict 具名）；导入 69→80 尾部追加零错位；独立审查 2 MAJOR 修复 | **§69 19 项(≥12)；回归 1035 全绿；strict 自造语料残留 0；panic 消息-span-退出码三引擎逐字；fuzz 双种子 0 分歧** |
| v0.66 | **✅(2026-11-14 实测)**:观测与反馈纯校准版交付——覆盖率/bench 基线刷新、AI 修正回路快照（诊断协议校准 GO）、真实 serve 服务观察（v1.1 no-go 推迟）、Untrusted[Json] ADR-004 落盘、usage audit 限制登记、moltbook b28bbcac；**src 零语义改动** | 三报告新时点快照 + moltbook ≥1 条 + serve 观察裁决 + 基线时点标注；回归计数 1035 不变全绿 |

### 4.5.7 安全评估第二轮登记（S9–S16；security-engineer，全部实测）

> 延续 §4.4.10 S1–S8。复核：S1/S2 已修（机制复测通过）、S3 污点窄源交付（洗白禁面/sink 门禁/const 洗白拒绝全部实测成立；一次初测"死代码缺口"系测量假象已勘误）、S7 已文档化；`--max-ms` 缺省 600s vs 长驻服务已由 GUIDE 文档化 + 机制实测，**降级为接受并登记**。serve 为首个常驻网络面——**全部 serve 侧定级以"本机攻击者"为前提**（127.0.0.1 固定）。

| # | 项 | 严重度 | 实测/证据 | 处置 |
|---|----|--------|-----------|------|
| S9 | 嵌套 serve 无 policing：checker 放行 handler 内 serve；内层服务真实绑定运行，外层 30s 硬杀后内层连同在途连接被斩；未文档化 | P2（回环内） | handler 内 serve(18191,inner)：check exit 0；t+10s 内层 200；外层 504@30.02s 后内层拒连 | **修（v0.64）**：checker 静态拒绝 handler 体内 serve 调用（spawn 纪律，~20 行） |
| S10 | serve 载荷不进污点面且无警告：请求 body→write_file 路径 check 直通；GUIDE serve 节无"handler 载荷全部不可信"警告 | P2（文档） | t12 check exit 0（实测） | **✅ 已收口(v0.68)**：GUIDE 警告升级为编译期强制（M3049 整树标污）；Untrusted[Json] 已实现（ADR-004） |
| S11 | handler 畸形响应静默兜底：status 700/"200"/99→200、headers 数组/嵌套值→静默丢弃、数值 body→空体，无诊断 | P3 | 6 形态实测全 200 | **文档化（v0.64）**：GUIDE 补兜底语义；改 500 属语义裁决，Backlog |
| S12 | sanitize_cli_path 闸门仅拒 <0x20：DEL(0x7F)/C1(0x80–0x9F)/Unicode 双向控制符（U+202A–202E）放行——实测 RTL 视觉反转（`exe‮txt‬`）；CLI 回显显示欺骗窗口 | P3 | 5 向量实测 | **修（v0.64，裁决：扩拒绝集）**：+DEL/C1/双向符 + 测试向量；不接受含糊 |
| S13 | accept 层连接级资源无 Ming 上限（无 maxConnections；在途体缓冲无并发上限；队列无超时，队尾上限 480s）；慢连接不占 worker（实测 50 挂起期间正常请求 8.1s 返回 200） | P3（回环内） | 慢连接实测 + 源码确认 | **接受并登记**；作为 serve 放开项 ADR（自定义 host）的前置义务 |
| S14 | #56 具象化：artifact 结构校验缺失且**失败形态不一致**——mainFnIdx 越界/functions=[]→raw TypeError（vm.js:283）exit 1；=-1→M3023 exit 101；坏 opcode→M4001 | P2（维持） | 4 损坏形态实测 | **修（v0.64）**：反序列化后置索引/表长校验 + 稳定诊断统一；损坏样例入回归 |
| S15 | #55 范围更新：FFI NUL **返回路径**实测确认（自编 DLL `char* nulstr()` 返回 "ab\0cd" → Ming byte_len=2 静默截断，cbackend.js strlen）；**实参路径当前经 C 资格面不可达**（Vec[u8]/Result let 均 C2 拒绝、无 NUL 字面量） | P2（维持，范围收窄） | 自编 DLL + ming cc 实测；资格拒绝形态实测 | **文档 + 回归（v0.64）**：GUIDE strlen 语义；FFI 扩面 NUL 裁决为前置义务；架构侧 M4017 提案存档（届时依据） |
| S16 | 观感类：handleRequest 同步异常误标 `worker_start_failed`（a12）；响应头无大小/数量上限（a13）；SAB 消息槽并发写可交错（无越界，flag 语义保持） | 信息 | 源码确认 | 标签拆分随 v0.64 触碰 accept 代码顺手做；头上限/SAB 加锁登记接受 |

**serve 安全面实测基线（供后续复核）**：CRLF/DEL 头注入 → 500 internal_error 服务存活；280 并发 → 恰 272 受理 8×503（≤102ms）；504 精确 30.03s 且 `/fast` 91ms（名额同步释放）；4000 字符 path 全量入 handler、20001 字符 → node:http 16KB 头上限 400 bad_request；50 挂起连接不占 worker。

### 4.5.8 第四轮复核（2026-11-14；software-architect，基线 ed4f483）

> **裁决：§4.5.1–4.5.7 整体维持**（主题排序 v0.64→v0.65→v0.66 不变；无任务移除；无范围错配）。
> 复核方法：逐任务裁决 + 使命层端到端实测（17 错误程序 × `check --json`、运行时 panic、test/fmt/doc/init/REPL/LSP 冒烟；程序在 os.tmpdir，未入仓）。关键复核证据：`M4013` 在 tests/run.mjs 实测 **0 次**（#57 漂移证实）；README 四条"(当前)"与「核心特性(v0.59)」头证实；`src/diag.js CODES` 实测 **77 码**（capabilities"71 码"漂移证实）；checker.js 实测 5,555 行；**AI 修正回路主干健康**——17 错误程序 100% 捕获、码/位置/消息全准、panic 形态（码+源摘录+可行动后缀+Ming 栈）三引擎一致；多错误一次报告（单例 5 条）减少往返；warning-only 正确 `ok:true` exit 0；LSP/REPL/test/fmt/doc/init 冒烟正常；GUIDE quickstart/§20 AI 建议/§21 错误码迁移表对 onboarding 路径是通的。

**修正（2 处，已落 §4.5 既有条目）**

1. §4.5.1 任务 7 范围扩大为"文档漂移清扫"：追加 M3012 hint 文本（"计划 v0.2"措辞 → ToStr trait 现行口径）、REPL 横幅 v0.8.0、diagnostics.md 与 diag.js 77 码计数核对。
2. §4.5.6 v0.66 度量行措辞修正：eval ADR 为"规划期任务，规划落盘时完成，不占版本主题"（消除与 §4.5.4 的自相矛盾）。

**增补（1 项，已落 §4.5.3 任务 7）**

3. v0.66 新增任务 7——AI 修正回路快照（仅测量与登记）：fix 处方覆盖率/正确率、级联诊断放大比、误导 hint 命中数；为 v0.67 候选主题"诊断协议校准"提供 go/no-go 证据。

**新登记缺陷（§5.1 已同步；全部本轮实测）**

| # | 缺陷 | 严重度 | 处置方向 |
|---|------|--------|---------|
| #60 | REPL let 绑定陷阱：`let x = 1;` 静默成功（被包进临时 fn，不入 decls，src/repl.js:74–80），下一行"找不到值 x"且 hint"最接近的名字是 Ok"；GUIDE §19"声明持久化"对 AI 预期错配；横幅 v0.8.0 | P3（AI 协作） | 修：let 行回显"绑定仅当前输入生效"或 let 纳入 decls；随 v0.64 文档清扫顺带或 Backlog |
| #61 | test 断言失败栈位置 `undefined:undefined:undefined`（M4008 消息与左右值正确，位置未接线） | P3（诚实失败） | 修：接线 test 块位置；小 diff |
| #62 | fix 处方"自信但错误"：未声明函数初始化（`let r = foobar(3)`）级联 4 诊断，M3003"无法推断 r 的类型"先于真实根因 M3001，且 M3001 处方建议 `r`→`str` 替换（应用后更糟）；级联 M3002 hint"用 debug(x)"在根因是拼错名时误导（三形态实测）。M3048 已有"毒化 never 签名收敛"先例未应用到此形态 | P2（AI 修正回路） | v0.66 任务 7 测量 + v0.67 候选主题"诊断协议校准"裁决；先登记不修 |
| N-64 | examples 零覆盖 v0.61/v0.62 能力面（Untrusted/std.unstr、std.net.serve 各 0 示例；18 文件 grep 证实）——AI 靠 examples 学惯用法，两个新能力面"文档化但不可见" | P3 | Backlog：各补 1 个 ≤30 行示例（模板 fs_demo/unsafe_demo） |

**使命层总评**：AI 修正回路（check --json → 诊断码 → fix）是 Ming 当前最强的协作面，主干无需大动；剩余缺口集中在三处小修（REPL let/失败位置/漂移清扫）与一个待测量决策（诊断协议校准是否成为 v0.67 主题）。分发与文档 onboarding 路径完整（release zip/REPL/LSP/doc --json/fmt 幂等），无新增版本级主题。

**第五轮建议（一句话）**：……（**已执行：见 §4.6**，走查裁决 v0.67 = 诊断协议校准三切口 + REPL 顺带；onboarding 其余归 v0.68 候选）。

---

## 4.6 第五轮评估（2026-11-14）：端到端走查数据裁决 v0.67（software-architect，基线 da843be v0.66.0）

> **方法**：应 §4.5.8 第五轮建议——不做新一轮架构评审，做一次端到端 AI 任务走查：模拟真实 AI agent 从零在 os.tmpdir 完成真实小任务（wordfreq 词频工具：init → 写 → check 修正循环 5 轮 → test → run → build AOT → REPL 冒烟），逐环记录摩擦与耗时；bench WARN 复测 2 次；ADR/缺陷逐项复核。程序与项目全部在 os.tmpdir（mingwalk-aPqK），未入仓，未 commit。

### 4.6.1 走查记录（约 8 分钟墙钟，7 次 check 往返）

| 轮次 | 形态 | 结果 | 评价 |
|------|------|------|------|
| 1 | Option→i64 类型错 + Rust lambda 猜错 | M3002 精确（类型两侧+行列）；M2001 "无法解析: |" **无 hint** | M3002 优；M2001 差（AI 查 GUIDE 一轮） |
| 2 | 效果缺失（fs 未声明）+ 元组 `.1` 试探 | **M3029 命中 + 可机器应用 fix**（` with fs `，应用即成功）；M2002 无 hint | M3029 fix 族实测兑现；**元组字段访问语法 GUIDE 无示例（文档缺口 N-67）** |
| 3 | test 块误置函数体内 | **1 根因 → 11 条 M2001 级联 + unused 误报 + 1 条错误 fix（建议加冒号）** | **parser 层级联 11x**（快照 checker 层 1.75）；首条有指向性但噪音淹没 |
| 4 | 定稿 | check 0 / test 通过 / run 暴露**真实运行时 bug**（换行未分词） | **静态全绿 + 行为错误**实证；多行 test 用例早写即可抓（TDD 惯用法价值） |
| 4.5 | tools patch 修 bug | M1002（诊断准确） | **patch 双层转义坑实测触发**（mingkit 只认 
 	 \；
 未定义致 
 提前解码写断行源码） |
| 5 | 三引擎验证 | run 正确；**tree/vm/no-wasm 输出 diff 逐字一致** | 途中实证**静默降级双反模式**：`--tree` 误置 `--` 后被当程序参数 + `unwrap_or("")` 吞 read_file 失败 → 空输出 exit 0 静默 |
| 收尾 | fmt/build/AOT/REPL | fmt 一次到定点；build 11ms | AOT 对含 test 块文件**回退源码模式**（具名提示，非静默）；entry 摩擦（不改 toml 产物静默跑旧骨架）；REPL **#60 逐字复现 + 横幅 v0.63.0 漂移复发（v0.65/66 落后两版）** |
| 专项 | 方法拼错 setx | M3015 内嵌全方法表，**无 nearest** | 快照 e06 在真实流中第二次独立复现（支撑 v0.67 切口 3） |

### 4.6.2 与第四轮 AI 快照对照
主干复核成立：故意错误捕获 4/4；M3029 fix 可应用；误导 hint（nearest→Ok、M3012 debug）真实流复现。**新增四维度**：(1) parser 层级联 11x；(2) **静默降级类**（unwrap_or 吞错/旗标误置）——静态全绿但行为静默错，真实任务流最大摩擦源，快照语料未覆盖；(3) 元组语法文档缺口；(4) 运行时行为 bug 靠 run 抓（check/test 不可见属预期）。GO 判据不推翻，GO 维持。

### 4.6.3 bench WARN 复测裁决（§4.5.7/coverage-baseline 待决项收口）
复测 2 次（不 --write-baseline）：fib cc/vm 6.9x/7.3x（基线 8.1x，**WARN 未复现**）；循环 9.5x/11.6x（基线 14x，**2 跑 1 次 WARN**，阈值边缘抖动）；cc 绝对值两次均偏慢 +20%~66%（方向可复现）；词频比值翻转项恢复 1.0x。**裁决：混合成因（计费对齐真实开销 + 机器状态），方向真实、幅度含噪声；基线数字维持不修饰**；维护者闲置时段复测后再定是否刷新。coverage-baseline.md 注记补一行"2026-11-14 第五轮复测 2 次：循环项 1/2、fib 0/2"。

### 4.6.4 v0.67 主题裁决
**诊断协议校准（#62 三最小切口）= 主主题，GO 维持；#60（REPL let 回显）+ REPL 横幅机制化升格顺带（同属 AI 反馈面，#58/#59 先例，总量 <150 行）。** onboarding 其余（N-64 examples / N-67 元组文档 / unwrap_or 与旗标惯用法 / init 骨架提示）归 v0.68 候选；parser 级联抑制（#63）归 v0.68 诊断校准二期；serve Err exit 0（#65）归 v0.68 诚实失败批（exit 语义属行为变更不混入）。

### 4.6.5 §4.5 其余项复核
- **eval ADR 未落盘**（docs/ 无文件；第四轮修正条目 2 未兑现）→ 列入 v0.67 规划期任务（ADR-004 模式：立场先行落盘 + 维护者复核，四问沿 §4.5.4）。
- **ADR-004 四条件**：③ serve 观察已出且支持 go（投影税可承受）；② 工具迁移面 grep=0 已实测、go 时复核存档；① 维护者 14 项复核未做；④ 窗口待规划（serve v1.1 no-go 后可独立 minor）。go 决策在维护者；走查无反对证据；**v0.68 候选，不抢 v0.67 主题**。
- **维持**：walker/while/checker 拆分/serve v1.1 no-go 均维持（走查无新证据）。
- 对 §4.5.8 建议的回应：建议已执行；走查数据与第四轮预测一致且增强（诊断主干强、缺口集中）；REPL 项从 Backlog 升格顺带是唯一排序变更。

### 4.6.6 新登记（§5.1 增补；全部本轮实测）

| # | 项 | 严重度 | 处置 |
|---|----|--------|------|
| 63 | parser 级联雪崩：test 块置函数体内 → 1 根因 11 条 M2001 + unused 误报 + 错误 fix（建议加冒号）；parser 层级联比 11x（checker 层 1.75 对照） | P3 | 登记；v0.68 诊断校准二期候选（parser 错误恢复/级联抑制） |
| 64 | REPL 横幅版本漂移复发：src/repl.js:39-40 硬编码手工同步（注释自认"曾漂移"），v0.64 修 v0.8.0→v0.63.0 后 v0.65/66 又落后两版——修文案不修机制的机制性复发 | P3 | 修（v0.67 顺带）：横幅改从单一事实来源读（manifest/package.json，不引 src→bin 环） |
| 65 | serve 绑定失败 Err 后 exit 0（serve-observation §4-4：服务没起来但退出码成功，运维陷阱） | P3 | 登记；v0.68 候选（main/serve Err → exit 非 0 属行为变更，需独立裁决）或文档化 |
| N-66 | AOT 对含 test 块文件回退源码模式（"缺少签名"具名提示质量好，非静默；但产物"含明文源"与 build 宣传面"无明文源"不一致） | 信息 | 登记；AOT 面 test 块支持待评估 |
| N-67 | GUIDE 缺元组字段访问语法示例（.0/.1 仅解构出现；走查实测 AI 猜 `.1` 被 M2002 拒且无 hint） | P3 | onboarding 包：GUIDE §2 类型表补一行 + examples |
| N-68 | fmt --write 写入后文案"已是规范格式"（实际已写文件，文案含糊像"没写"） | 信息 | 顺手改文案"已格式化" |
| — | 惯用法观察（非缺陷）：unwrap_or("") 吞 read_file 失败 → 静默 exit 0；CLI `--tree` 误置 `--` 后被当程序参数——AI 高频反模式 | — | 归 N-64 examples/GUIDE 惯用法节（read_file 用 ? 传播示范 + 旗标位置说明） |

### 4.6.7 v0.67 任务与验收草案（诊断协议校准 + REPL 顺带）

> 主题唯一：AI 修正回路的"自信但错误"收口 + REPL 反馈诚实化。src 预期 <150 行。

**任务**
1. **切口 1 毒化收敛（#62 主修法）**：初始化器含未声明名时绑定毒化 never 收敛（M3048 先例技术），消除 M3001 假 fix（r→str）与 M3003 先于根因排序；快照 e13/e19/e16/e04 形态为验收语料。
2. **切口 2 M3012 hint 语境化**：根因含未绑定名/拼错名时不发"其他类型用 debug(x)"建议（快照 e19/e16 双复现 + REPL M3008 级联形态）。
3. **切口 3 M3015 最接近方法名**：全方法表之外给 nearest suggestion（快照 e06 + 走查 setx 双复现；对齐 M3001 的 nearest 口径）。
4. **顺带 #60+#64**：REPL let 行回显"绑定仅当前输入生效"（或 let 纳入 decls，实现时实测择一，GUIDE §19 口径同步）；横幅从单一事实来源读版本。
5. **测试 §70 ≥10**：毒化收敛正负例（r→str 处方消失 + M3003 不再先行）/M3012 抑制双形态/M3015 nearest 逐字/REPL let 回显 + x 可引用（或明确回显）/横幅 = ming version 逐字；AI 快照语料（ming-v66-corpus e01–e24）复测登记对比数字。

**验收（实测口径）**：`node tests/run.mjs` 1035 + §70 ≥10 全绿；`fuzz --seed 44044 --count 40` 0 分歧；AI 快照语料复测：**误导模式 7 → ≤2、fix 错误 4 → ≤1、级联（checker 层）1.75 → ≤1.5**（parser 层 #63 不在本版口径）；REPL let 陷阱不复现（复现脚本：`printf 'let x = 1;
x + 1;
' | ming repl` 不再报 M3001+Ok hint）；横幅与 `ming version` 逐字一致；f01–f05 探针复测 5/5 不再"应用后更糟"；无新语言面、零新增 M 码。

**验收（2026-11-15 实测）**：`node tests/run.mjs` **1049 项 0 失败**（1035 + §70 14 项）；快照复测**三判据全达标**——误导 7→**1**（模式 1–6 假 fix 与 debug hint 全消除；残留 1 = parser 级联 Ok-nearest，#63/v0.70 范围）、fix 错误 4→**0**（五条旧处方无应用面）、级联 3.8→**1.4**（#62 族五形态 BEFORE→AFTER：e13 4→1/e19 4→2/e16 3→2/e04 4→1/e06 4→1）；REPL let 回显落地（**静默成功消失**；M3001 引用报错属方案 a 预期语义，nearest-Ok hint 已随内置构造器排除消除）；横幅与 ming version 逐字；f01–f05 探针 5/5 无应用面；`fuzz --seed 44044 --count 40` 0 分歧。**独立审查**：通过（0 BLOCKER/0 MAJOR——毒化零发射/合法 never 逐字/探针栈不串味/基线对照全数核实；3 MINOR = 注释精度两处 + e23 直测补强，已落实；顺带修复基线双崩溃 `let x;`）。
**明确不做**：parser 级联抑制（#63）、serve Err exit 码（#65）、eval ADR 实现（只落盘 ADR 文档）、Untrusted[Json] 实现（ADR-004 条件未全勾）、examples 扩面（N-64）。


## 4.7 第六轮评估（2026-11-14）：eval ADR 落盘 + v0.67 就绪确认 + v0.68+ 路线（software-architect，基线 d2b2a2e v0.66.0）

> **方法**：兑现第四轮 §4.5.8 修正条目 2 的唯一未落盘承诺（eval ADR）——四问沿 §4.5.4，源码引用逐条 grep/逐行实测（管线复用面/效果注册表/污点 sink/资格面/REPL 先例）；随后对 §4.6.7 就绪检查逐任务核对落点文件。

### 4.7.1 ADR-005 落盘（交付物：docs/adr-005-eval.md，144 行 8 节）

- **四问裁决**：① eval = 显式能力 `with eval`（新效果名入 KNOWN_EFFECTS checker.js:206；M3029/M3030/契约纯性/资格面零新机制自动覆盖）；② eval 产物 = 独立编译单元，全部 M 检查内层零降级（REPL 同款管线 repl.js:83–110 先例），编译失败/panic/熔断一律 Err 化（载荷 = `--json` 协议同构 JSON，diagJson 同源）；③ 来源必须是净 str——eval 实参登记为污点 sink 位（M3049），**v1 无授权净化器**（"净化的代码"无机械定义），污点值无类型出口进入 eval——"外部输入永不动态执行"由类型系统机械保证，eval 不是逃逸舱口而是第 12 个门禁面；④ 热重载不进 v1、不预留、另 ADR（唯一现实宿主是常驻 serve，而优雅停机 no-go 推迟——需求未实证）。
- **引擎限制诚实评估**：内层恒走 VM 字节码，不提供引擎旗标；外层 with eval 永不 wasm/cc eligible（wasm.js:451–456 效果闸自动）、build 显式回退源码模式（design §6.10 unsafe 先例）、cc 发射期拒绝；内层 wasm 运行时编译"技术上可行、成本/复杂度不划算"——范围裁决非能力边界，如实登记。
- **成本估计**：src 约 60–90 行（checker 3–5 行：KNOWN_EFFECTS/裸 builtin 表 :236/sink 位；interp 50–80 行：case 'eval' 组装，导入方向无环 interp.js:9 已 import checker）；零新码；测试 10–15 条。**安全面诚实清单 6 条**（同进程无沙箱/serve 白名单不含 eval M3002/污点类型级保证/panic Err 化双面性/**配额按调用重置的放大窗口（沿 sync 先例 interp.js:562 全量继承）**/确定性表述）+ **局限诚实清单 6 条**（per-call 编译无缓存/诊断 file='<eval>'/无值交换 Ok=str 的根因/main 无实参/永不 wasm 加速/fuzz 合同不含 eval）+ **评审清单 12 项**（逐项默认立场，全部裁决才实现——沿 ADR-004 条件承诺模式，不承诺实现时间）。
- **北星支柱 4 状态更新**：从"六支柱唯一零触碰"变"有裁决"（实现待 go）；capabilities.md:79 eval 行说明注记同步，判定符 ❌ 维持至实现。

### 4.7.2 §4.6.7 就绪确认（逐任务落点实测，GO 可开工）

| 任务 | 实测落点 | 就绪判定 |
|------|----------|----------|
| 切口 1 毒化收敛 | checker.js checkLet :1737 + 丢弃路径 :1752/:1766；M3048 先例 :1714–1718/:2280 | ✅ 就绪；**范围修正：毒化需覆盖 let 初始化器 + match 臂绑定两路径**（e16 语料 f02 处方源自 match 臂失绑，仅改 checkLet f02 不消失、"fix 错误 4→≤1"不达标） |
| 切口 2 M3012 语境化 | checker.js 插值分支 M3012 :1962；:1957 已有语境化抑制先例注释 | ✅ 就绪（抑制模式现成，风险最低） |
| 切口 3 M3015 nearest | checker.js 发射点 9+ 处；主发射点 vecMethod :4428/mapMethod/strMethod（:4576/:4628/:4676，消息内嵌 METHOD_NAMES :489 全表）+ 通用 checkMethodCall :4184；nearest() :5595 与 M3001 :821–823 同源 | ✅ 就绪；**范围界定：三主发射点 + checkMethodCall 四处**，opt/res/ptr 方法集小后置 |
| 顺带 #60+#64 | repl.js :75–81（let 包临时 fn）/：39–40（横幅硬编码） | ✅ 就绪；**修法定案：方案 a（let 行回显"绑定仅当前输入生效"）**——方案 b（let 纳入 decls）与顶层项模型冲突（isDecl 白名单 :75 即顶层项集，顶层 let 非模块项）；横幅改读 package.json version（实测 0.66.0；fs 读 JSON 不引 src→bin 环），GUIDE §19:1892 同步 |
| §70 ≥10 | tests/run.mjs 现至 §69，§70 空闲 | ✅ |
| 快照复测 | ming-v66-corpus 在 os.tmpdir 不入仓（ai-loop-snapshot.md:5） | ⚠️ 建议实现期把 24 形态固化为套件内语料，tmpdir 复测仅作登记性对照 |

**第六轮收口注记（2026-11-15）**：v0.67 已实现交付——三切口全部落地（快照复测三判据全达标：误导 7→1/fix 错误 4→0/级联 3.8→1.4）；注意点全部落实：切口 1 双路径覆盖、切口 3 四发射点、REPL 方案 a 定案、快照关键形态固化进 §70（e13/e19/e16/e04/e06）；基线双崩溃（let x;）顺带修复。

### 4.7.3 复核修正（§4.5.8/§4.6 既有裁决，3 处）

1. repl.js 引用 74–80 → 实测 75–81（1 行漂移，结论不变）；2. §4.6.4 REPL 修法二选一 → 定案方案 a（§4.7.2）；3. §4.6.7 任务 1/3 范围细化（切口 1 双路径、切口 3 四发射点）。其余全部维持（三切口 GO/bench 混合成因/walker·while·checker 拆分搁置/serve v1.1 no-go/ADR-004 四条件状态）。

### 4.7.4 v0.68+ 候选主题表（一版一主题）

| 版本 | 主题 | 条件/规模 |
|------|------|-----------|
| v0.68 | **✅ Untrusted[Json] 交付**（14/14 裁决 go 后实现；约 130 行 + 迁移 31 处 + §71 18 项；顺带修复 pre-existing as_obj 键缺陷；AI onboarding 包未触发——条件全齐） | ADR-004 四条件 2026-11-15 全核销 |
| v0.69 | **✅ 已交付（2026-11-15）**：eval 实现（ADR-005 §9 12/12 go——裸 builtin/内层恒 tree 裁决微调/Err 化 --json 同构/M3049 sink/配额按调用重置 500M 兜底/build 回退/cc 拒绝/wasm strict 'none' 核验；src 约 90 行；§72 共 20 项）+ #65 文档化处置（行为变更否决；GUIDE 惯用法 + examples/serve_demo.ming 兑现 N-64）。**独立审查**：2 MAJOR 修复后通过（MAJOR-1 自递归逃逸 → evalDepth 64 层确定性守卫 + RangeError 最外层兜底；MAJOR-2 泄漏窗口表述收窄），0 BLOCKER——ADR §9.1 | 1091 项全绿；fuzz 双种子 0 分歧 |
| v0.70 | **✅ 已交付（2026-11-15）**：诊断校准二期——#63 parser 级联抑制（recover(false) 深度感知 panic-mode + 停机表移除 test + 强进路径修复 + valBrace 登记;零新增 M 码;既有测试零校准;§73 共 12 项;**独立审查 1 MAJOR 修复后通过**(valBrace 负数/陈旧正值污染 → Math.max(0) 钳 + 条件撤回 + 顶层入口清账,p21/p24 根因恢复、s1 复利 599→400 消除;残留 1 条有界伪诊断登记 v0.71);独立验证 10 语料基线 44 条 4.4x → 改后根因保留/级联消除;既有 1091 全绿 + §73 12 = 1103） | 与 v0.67 收口诊断校准（v0.67 checker 层毒化收敛 + 本版 parser 层级联） |
| 随时 | bench WARN 维护者复测（§4.6.3 裁决：闲置时段 2 次复测后再定刷新）；热重载不排期（ADR-005 §2.4：需求实证后另 ADR） | — |
| v0.71 | **✅ 已交付（2026-11-15）**：诊断残留收口五任务全兑现（① salvage 精化——probe_anchor 1→2 真实复活 ② valBrace 块入口快照所有权——伪→真 ③ M3049 化五形态 ④ #61 接线+帧名统一 ⑤ DX 三项） | **1124 项全绿**（§74 17 项）；独立审查通过（2 MINOR 登记级 → v0.72 候选）；独立验证 7 项判定零 RED FLAG |
| v0.72 | **✅ 已交付（2026-11-15）**：诊断质量补刀（v0.71 审查 2 MINOR——if 分支混型 M3049 对称化/remedy 复合载体精确化 + 审查 MINOR-1 hint 位置中性化就地修；NOTE-2 if 位 what 前缀对齐；NOTE-3 §19 sink 列举补分支混型） | **1132 项全绿**（§75 8 项）；审查通过（0 BLOCKER/0 MAJOR）；验证 5 项判定零 RED FLAG |
| v0.74 | **✅ 已交付（2026-11-16）**：内联汇编——显式能力 `with asm`（北星支柱 2 兑现，ADR-006 12/12 go；新码 M4017；§77 28 位点；**1164 项全绿**；审查 0 BLOCKER/0 MAJOR——fmt 静默删块 P1 收口、注入面 10 形态全拒实测） | abc7387；ADR-006 docs/adr-006-inline-asm.md |
| v0.75 | **✅ 已交付（2026-11-16）**：健壮性收尾——四残留裸栈崩溃面全面清零（checker 450/lexer 950/type 1450/pattern 2000/const 1200，阈值二分实测校准；M4005 check-time 变体复用；§78 9 条；**1173 项全绿**；审查 0 BLOCKER/0 MAJOR；独立验证四判定 PASS + RED FLAG 第五面登记 v0.76） | d62c9c3；§4.10 |
| v0.76 | **✅ 已交付（2026-11-17）**：健壮性补刀 + fix 处方扩面——第五崩面 call-arg 收口（parsePostfix 三重入点计入 exprDepth，崩点实测 253，阈值 120 复用）+ M3002 fix 族 3→4（annotationFixType 守卫 + 审查 MAJOR 修复：Set.effects 死检查 / exprFirstSpan 右界下钻六操作符形态）+ M2002 eof 发射点；§79 16 条含 MAJOR-2 回归 3 条；**1186 项全绿**；审查 REQUEST_CHANGES（0 BLOCKER/2 MAJOR/2 MINOR/5 NOTE）修复后通过 | 集成提交；独立验证 C 改后对照 |
| v0.77 | **✅ 已交付（2026-11-17）**：v1.2 内容源扩面——ADR-007 清单 14 项全落地（源翻转 fs/net/proc/污值代数 28 方法逐函数裁决表/json.parse 两域接缝闭合/write·print 出向透传/exec 双向 cmd sink/第三载体 Untrusted[Vec[u8]]/argv defer v1.3）；审查 REQUEST_CHANGES（1 BLOCKER + 2 MAJOR）修复后通过——**B1 parse_* Err 载荷 keepResErr 保污**（实测 Err 回显污内容且可击穿 eval 承诺）/M1 read_to_end 补裁翻转/M2 响应头+metadata 登记不预支；§80 21 条 37 check；**1225 项全绿**；fuzz 双种子 0 分歧；12 工具良性路径 155/156 逐字节（唯一差异 = ENOENT 消息内嵌 CWD 结构性） | 实现 + 迁移 60+ 位；ADR §8/§8.1 裁决与微调记录；#70（VM match-in-for continue 崩溃）登记 v0.78 候选 |
| v0.78 | **✅ 已交付（2026-11-17）**：健壮性补刀第二刀——缺陷 #70 修复（VM for 内 match 臂 continue 双引擎分歧崩溃；根因 = match 宗量贯穿臂体留栈、Break/Continue JUMP 不清理活临时，三形态：for 崩溃/while 泄漏/break 静默泄漏；修复 = 纯编译器层 matchTemps 计数 + 四循环点 breakCtx 快照 + 前置 POP；无 match 形态字节码逐字节不变；§81 20 check；**1251 项全绿**；审查 APPROVE-with-minor——纯净副本逐指令字节码对照） | 677424f；同族 #71 登记 v0.79 候选 |
| v0.79 | **✅ 已交付（2026-11-17）**：健壮性补刀第三刀——缺陷 #71 修复（lambda 体内 continue/break checker 漏洞：checkLambda 重置 inLoop → M3010/M3011 循环外拒绝；compiler 防御分支裸 POP 改具名内部错误纵深防御；§82 8 条目 9 check；**1260 项全绿**；审查 APPROVE-with-minor——语义边界完整性白盒核对/零校准独立对账 1251+9=1260 精确成立） | edce69d |
| v0.80 候选 | **AI 协作面第二波**：fix 结构化处方扩面（4→更多高频族，快照数据驱动）+ LSP 多文件符号补全第一切片（保守原则） | 无新语言面；§4.12.5 有任务草案 |
| v0.81 候选 | **引擎一致性小项清账**：wasm 消息口径统一（N-65.4）+ tree ContSig 硬化（v0.79 审查 NOTE-1）+ json_query C0 序列化分歧 | strict 可见面；三项均登记在案 |
| v0.82 候选 | **污点 v1.3 窗口**（argv 载体 + http 响应头/metadata 翻转——破坏性签扩展一次窗口）——**ADR-008 已裁决落盘（2026-11-17，清单 12 项待维护者复核后实现）**：argv = Vec[Untrusted[str]] / 响应头 = Untrusted[Map[str,str]] 第四载体（键值同污，键净方案否决归档）/ metadata = Untrusted[Json] | 实现待派发；迁移面 16 签名位实测在案 |
| v0.83+ 候选 | **流式·Slice 设计簇（ADR-009）**：read_bytes_range 最小流式 + Slice 只读视图 + 带长度 Ptr + unsafe(cond) 证明携带 | ADR 落盘 + 真实用例（rossum 数据在案）；§4.12.2 簇 A |
| v0.84+ 候选 | **serve 传输扩展最小片**（TLS；keep-alive/优雅停机/UDP/WS 各自另裁） | 部署证据门槛（serve v1.1 no-go 先例）；§4.12.5 |
| 远期 | **async/green-thread（ADR-001 阶段 2）**；流敏感/跨函数污点推断；净化形式化证明；证明面扩大（while/分支敏感） | 均需独立 ADR 或 SMT 成本评估 |

### 4.7.5 Backlog 处置表增补

| 项 | 处置 | 理由 |
|----|------|------|
| eval/热重载 ADR | **✅ 已落盘（ADR-005）**；实现 = v0.69 候选 | 12 项清单条件承诺；北星支柱 4 变"有裁决" |
| Untrusted[Json] 实现 | **✅ v0.68 交付** | ADR-004 14/14 裁决 + 四条件核销（2026-11-15 go）；投影表/stringify 拒绝/mark_json/迁移 31 处 |
| #65 serve Err exit 0 | v0.69 顺带候选（原 v0.68 候选顺延） | 行为变更独立裁决；与 eval 同属"运行时诚实面"，同版评估 |
| N-64/N-67/N-68/惯用法节 | v0.68 备选主题（AI onboarding 包） | Untrusted[Json] 条件不齐时先行，不空转 |
| #63 parser 级联抑制 | v0.70 候选 | 需 parser 错误恢复设计；一版一主题 |
| REPL 方案 b（let 纳入 decls） | **否决** | 顶层 let 非模块项，拼接破坏解析；方案 a 定案 |
| 热重载 | 不排期 | serve 需求实证后另 ADR（ADR-005 §2.4） |


## 4.8 第七轮评估（2026-11-15）：v0.67–v0.70 四版连发后残面盘点 + v0.71 主题裁决（software-architect，基线 157aa75 v0.70.0，1103 项全绿）

> 立场声明：本节为**架构师裁决先行落盘，维护者事后复核**（ADR-004/005 同款模式）。全部开口清单均引自既有登记（GUIDE 修订记录/§5.1/各版审查记录），无一处新实测声明；行数预估为规划口径非承诺。

### 4.8.1 现状盘点（开口清单，全部既有登记引用）

**已收口弧线**：诊断校准（v0.67 checker 层毒化收敛 + v0.70 parser 层级联抑制——快照误导 7→1 中最后一项"parser 级联 Ok-nearest"已随 #63 修复关闭）；北星支柱 4（eval）随 v0.69 从"无裁决"变"有裁决 + 已交付"；污点面载体扩面（v0.68 Untrusted[Json]）收口了 serve 载荷窗口。

**v0.70 残留（GUIDE 修订记录登记在案，本版不预支）**：
1. **语句级 salvage 精化**——recover(false) 深度 0 停机把失败语句区域整体吞掉，区域内"疑似函数调用行"（如 `id(`）可抢救而未抢救；启发式 = 深度 0 `id(` 停机。
2. **1 条有界伪诊断**——"嵌套块在值构造内失败"形态，valBrace 结清后 salvage 所有权缺失；根治 = 构造级登记所有权。YELLOW 裁决维持：被吞区域不报属 panic-mode 固有代价（误导 + 错误 fix 比静默更伤 AI 修正回路）。

**污点诊断精确化（既有登记，修法已具名）**：N-63.1 嵌套位置污点诊断回落 M3002（块尾/match 分支混型/spawn_all 元素/用户变体载荷等五形态——全部**正确拒绝**，仅诊断质量非旁路）；同族 v0.68 审查 m2（`Some(污)` 变体构造载荷位报 M3002 非 M3049——struct 字面量字段前置先例未覆盖变体构造器；原登记于 AGENTS.md §10 v0.68 行，本版补登 §5.1）。修法已在登记中具名：判定改 `typeContainsUntrusted(actual) && !typeContainsUntrusted(expected)`（checker.js:5716 已导出该函数；污点发射点 checker.js:3966）。

**零散小项（登记在先）**：#61 test 断言失败栈位置 undefined（runTests 以 callSpan=null 调 callUser，interp.js:557；接线即修，小 diff；与 N-60.4 同源现象一并核对）；NOTE 极端嵌套裸栈溢出（v0.70 审查 NOTE，两版本一致预存，非回归）。

**Backlog 大项不变**：v1.2 内容源扩面（fs/net/proc 内容源标污 + 净 str 经 json.parse 重建净 Json 接缝——"哪些内容源默认标污"是信任边界裁决，需新 ADR 或 ADR-002 修订）；stringify_untrusted（真实用例驱动）；Slice/流式（零拷贝与证明联动先决；社区驱动项：rossum read_bytes_range 最小流式方案待回应，moltbook 待办 3）；bench WARN 维护者复测（随时，§4.6.3 裁决）；热重载不排期（ADR-005 §2.4）。

### 4.8.2 v0.71 主题裁决

**主候选：诊断残留收口小批（go）**——一版一主题。理由：
1. **全部登记在先**（v0.70 GUIDE 修订记录 2 项 + N-63.1/m2 + 第四轮 #61），无新调查成本，开口清单即任务清单；
2. **同属"诊断质量"弧线的余尾**——v0.67/v0.70 已收口主体，本版清尾巴即弧线彻底关闭，不与弧线外新面混合；
3. **规模与风险小**——预估 src <120 行（salvage 停机启发式 + valBrace 所有权 + untrustedMismatchDiag 判定一处 + callSpan 接线）；**零新增 M 码**（M3049 化是既有码的修正、salvage 是 parser 行为精化、#61 是输出接线，与 v0.67/v0.70 零新码口径一致）。

**否决/顺延**：
- **v1.2 内容源扩面 → v0.72 候选**：信任边界裁决（哪些内容源默认标污）必须走独立 ADR；与诊断小批混版违反一版一主题，且 ADR 评审周期不适合"清尾巴"版。
- **DX/示例小批（N-67 GUIDE 元组行/N-68 fmt 文案/N-64 Untrusted 示例）→ v0.71 顺带裁量**：全部为文档/示例级、不碰语义，可随 v0.71 顺带；**超出裁量即移出**，不扩任务面。
- **stringify_untrusted/Slice·流式 → 维持待驱动**：真实用例数据不足（stringify_untrusted 待污进污出变体真实需求；Slice 待 unsafe 使用数据 + rossum 方案回应）。

### 4.8.3 v0.71 任务与验收草案

| # | 任务 | 落点 | 验收 |
|---|------|------|------|
| 1 | parser salvage 精化：深度 0 `id(` 停机启发式（被吞区域内疑似调用行抢救） | src/parser.js recover(false) 停机表 | GUIDE 1259 登记形态语料：根因保留 + salvage 生效；§73 锚定语料/长体/干净形态回归逐字不变；终止性核实（启发式不得引入不停机路径） |
| 2 | 有界伪诊断：构造级登记所有权（根治）或具名收紧（若根治牵连过大，裁决记录取舍） | src/parser.js valBrace/salvage 所有权 | p21/p24 形态不复发、s1 压力复利不回升；既有 §73 回归零校准 |
| 3 | 嵌套污点位置 M3049 化（N-63.1 五形态 + m2 变体构造载荷位）：判定改 `typeContainsUntrusted(actual) && !typeContainsUntrusted(expected)` | src/checker.js 污点 mismatch 判定（3966 发射点族） | Some(污)/嵌套容器/块尾/match 分支/spawn_all 元素报 M3049 非 M3002；M3049 码与消息不变；既有 §65/§66/§71 污点回归**零校准** |
| 4 | #61 test 断言失败栈位置接线：runTests callSpan 透传（N-60.4 同源一并核对） | src/interp.js runTests(:557) / src/vm.js VMInterp.runTests **双路径**（#54 先例——漏一条即门禁口径漂移） | `ming test` 失败输出 `at test <名> (file:line:col)`；tree/VM 双路径逐字 |
| 5 | 顺带 DX 裁量（不预支逐项）：N-68 fmt --write 文案 / N-67 GUIDE 元组字段访问行 / N-64 Untrusted ≤30 行示例 | GUIDE / examples / src/fmt.js 文案 | 登记于 GUIDE 修订记录；任一项牵连语义即移出本版 |

**验收门槛**：`node tests/run.mjs` 全绿（1103 + §74 预估 8–12 项）；`tests/fuzz.mjs` 双种子 0 分歧；proof_fuzz 0 误报；独立审查按惯例（重点：salvage 启发式的终止性、M3049 判定翻转的误伤面——净值方法不受影响的回归核验）；文档三条（GUIDE 修订记录/README 路线图/§5.1 状态行）+ 版本三处同步。

### 4.8.4 Backlog 处置表增补

| 项 | 处置 | 理由 |
|----|------|------|
| v0.70 salvage 精化 + 有界伪诊断 | **v0.71 主题（§4.8.2 go）** | GUIDE 1259/1261 登记在先；诊断弧线清尾 |
| N-63.1 嵌套污点 M3049 化 + v0.68 审查 m2/n2 | v0.71 任务 3（并入；m2/n2 本版补登 §5.1） | 修法已具名（typeContainsUntrusted 判定），同属诊断质量 |
| #61 test 栈位置 | v0.71 任务 4（并入） | 小 diff；第四轮 #61 登记；与 N-60.4 同源 |
| N-67/N-68/N-64-Untrusted | v0.71 顺带裁量 | 文档/示例级；超范围即移出 |
| v1.2 内容源扩面（fs/net/proc 标污 + json.parse 接缝） | **v0.72 候选（需 ADR/ADR-002 修订）** | 信任边界裁决；v0.61 既有窗口正式收口；不与 v0.71 混版 |
| stringify_untrusted / Slice·流式 | 维持待真实用例驱动 | rossum read_bytes_range 方案回应随社区检查（moltbook 待办 3） |
| 极端嵌套裸栈溢出（NOTE） | backlog 登记 | 两版本一致预存；非回归 |


## 4.9 第八轮评估（2026-11-15）：内联汇编/直接 syscall 规划（北星支柱 2 兑现；software-architect，基线 8e6bb46 v0.72.0，1132 项全绿）

> 立场声明：本节为**架构师裁决先行落盘，维护者事后复核**（ADR-004/005 同款模式）。实现 = **v0.74（编号消歧:0.73 已被技术债收口占用），ADR-006 门槛**——沿 ADR-005 模式（评审清单逐项裁决后实现），不与已收口的诊断弧线混版。

### 4.9.1 现状盘点（2026-11-15 实测）

- **零内联汇编面**：grep 全 src（compiler/cbackend/interp/vm/wasm）无任何 asm 发射点；capabilities.md 第 76 行「内联汇编/直接 syscall」**❌**（北星支柱 2：原生后端之后；经 `with unsafe` 门禁——效果系统即泛化 unsafe 块）。需求由维护者提出（2026-11-15）：高级代码中直接嵌入汇编指令 + 直接读写特定寄存器（EAX/RSP 等）。
- **最近接面**：`with unsafe`（C5）——内存级 Ptr load/store/offset + malloc/free，**无寄存器概念、无指令编码**；`extern fn` FFI（cc 独占，M4013/M4001）——当前唯一"逃逸到机器层"通道。
- **用例事实澄清（登记为范围边界依据）**：① ROP 利用链是**运行期**构造（gadget 地址依赖二进制布局与 ASLR），编译器内联汇编不服务"组链"；内联 asm 的真实用途 = 手写指令序列（syscall 桩、cpuid/rdtsc 等编译器无内建场景）。② "把 shellcode 嵌进高级代码"需要可执行内存 + 跳转执行——超出 v1 能力面，**明确不做**（见 4.9.2⑥）。③ 本后端为 x86-64 gcc：寄存器按 64 位命名（RAX/RSP；EAX 为 32 位别名）。

### 4.9.2 设计裁决草案（ADR-006 门槛条件——默认立场先行落盘，实现前逐项复核）

| # | 决策点 | 默认立场 |
|---|--------|---------|
| 1 | 效果门禁 | 新效果名 **`asm`**（第 13 效果）入 KNOWN_EFFECTS；M3029 逐层传播；契约内 asm → M3029（非纯） |
| 2 | 语法与寄存器读写 | **类型化操作数模型**（GCC 扩展内联 asm 同构）：`asm { "指令模板" in(约束, i64 值) out(约束, mut i64 位) clobber(...) }`——值按 i64 进出、寄存器由约束分配，**不暴露裸寄存器名字符串直写**；64 位命名。具体语法 ADR 裁决定型 |
| 3 | 引擎口径 | **仅 `ming cc` 真实执行**（cbackend 发射 `__asm__` 块）；tree/VM/wasm 回落具名 panic（沿 M4016 先例：exit 101、消息逐字；新码 M4xxx 余量或复用——ADR 裁决）；四引擎差分合同 = "C 侧逐字透传 vs 其余侧具名拒绝"（unsafe 先例口径：asm 天然单架构单后端） |
| 4 | AOT/build | `with asm` 程序 `ming build` 显式回退源码模式并具名原因（`usesEval`/`usesUnsafe` 先例，bin/ming.js `hasEff` 排除）；tools AOT probe 同步排除；C 资格新增 **C6 旗标**（仅 cc 路径） |
| 5 | 资格与证明面 | wasm 资格自动拒绝（effectOk）；含 asm 块的函数效果签名非纯 → 静态证明面排除（本地函数先例口径） |
| 6 | **范围边界（v1 明确不做）** | ① 可执行内存分配/跳转执行（mmap+exec 面——shellcode 嵌入的前提，超出语言能力哲学）；② 运行期 gadget 组链（ROP）；③ asm 块内跳转出块/长跳转。内联 asm v1 用途 = **手写指令序列 + 寄存器级进出口** |
| 7 | 安全评估 | asm 是语言最大逃逸舱口——签名可见性是唯一防线（M3029 逐层传播 + 具名回落 + build 回退全部强制）；污点面不受影响（指令模板 = 字面量串；污点值进操作数位按 M3049 常规处理——ADR 裁决是否 sink 位） |

### 4.9.3 v0.74 任务与验收草案

| # | 任务 | 落点 | 验收 |
|---|------|------|------|
| 1 | ADR-006 落盘（12 项清单，沿 ADR-005 模式） | docs/adr-006-inline-asm.md | 清单逐项裁决 + 范围边界成文 + 维护者复核位 |
| 2 | 实现：parser 块语句 + checker 效果 + cbackend `__asm__` 发射 + interp/vm 具名回落 + diag 新码三处登记 + bin build 回退 | src/parser.js / checker.js / cbackend.js / interp.js / vm.js / diag.js / bin/ming.js | C6 资格冒烟：cc 产物运行结果与手写 C 内联 asm 语义一致；tree/VM/wasm 回落消息逐字；`ming build` 具名回退 |
| 3 | 测试 §76（10–15 项） | tests/run.mjs | 正例（寄存器进出/syscall 桩形态）+ 负例（无 asm 效果 → M3029、JS 引擎 → 具名 panic、wasm 资格拒绝） |
| 4 | 文档 | GUIDE asm 节 + capabilities 第 76 行 ❌→🟡 + README 路线图 | 三处同步 + ADR 交叉引用 |

**验收门槛**：`node tests/run.mjs` 全绿（1132 + §76）；fuzz 双种子 0 分歧；proof_fuzz 0 误报；独立审查（重点：操作数约束的注入面——指令模板与操作数的拼接卫生、clobber 完整性）；文档三条 + 版本三处同步。

### 4.9.5 v0.74 收口注记（2026-11-16 实测）
- **编号消歧**：内联汇编原列 v0.73 候选——0.73 已被技术债收口（§4.9 原三任务）占用，重编号 v0.74（本节任务表同步）。
- **实现**（9 文件 +251 行 + fmt/lsp 配套）：parser asm 块（模板字面量+/out/in/clobber，expectStrLit 注入卫生强制）/checker 'asm' 第 13 效果+checkAsmBlock（out mut·i64 校验；静态证明面排除零改动——stmtIsLinear 机制）/compiler OP.ASM:47/vm+interp M4017 具名回落（消息逐字）/cbackend `__asm__ volatile` 发射+C6 旗标（asmEffectsAllowed，C5 同构；%N 范围防御）/wasm.js asmEffectsAllowed（审查批准——C6 消费点在 wasm.js，资格单一事实来源）/bin usesAsm 具名回退+tools probe 排除；**fmt.js/lsp.js AsmBlock 配套**（审查实测发现 fmt --write 静默删块 P1——修复+幂等锁定 §77.16；lsp visitBlock 下钻）。
- **独立验证要点**：cc 正例（rdtsc 单调/bswap 往返/lea 双 in 值）实测；三引擎 M4017 逐字；M3029/契约内/serve M3002 全自动触发；syscall 形态限 Linux x86-64（Windows PE 无稳定直接 syscall 面——用例句已注记）；REPL M3029 点名 [asm]。
- **ADR §1 grammar 两处实现期精确化**（已按实现口径修正 GUIDE/capabilities；ADR 记法维持历史）：clobber 实现为"每组括号内逗号分隔 1+ 寄存器，多组亦可"；out 缺 mut 关键字=解析层 M2002（非 mut 绑定才是 M3004）。

### 4.9.4 Backlog 处置表增补

| 项 | 处置 | 理由 |
|----|------|------|
| 内联汇编/直接 syscall（北星支柱 2） | **v0.73 候选（ADR-006 门槛，§4.9.2）** | capabilities 行 76 ❌ 在案；cc 路径可行；范围边界成文（可执行内存/组链不做） |
| v1.2 内容源扩面 | 维持 Backlog（维护者裁决） | b4a6f25 裁决单列 ADR 门槛 |
| stringify_untrusted / Slice·流式 | 维持待真实用例驱动 | 无新增证据 |



---

## 4.9 第八轮规划：v0.73 技术债与观测收口（software-architect，2026-11-15，基线 8e6bb46 v0.72.0，1132 项全绿）

> **方法**：v0.72 后剩余登记项盘点——版本路线与 §5.1 台账已清零；剩余 = NOTE 登记（极端嵌套裸栈溢出）+ §4.3.8 两项技术债（GUIDE 交叉引用/checker 拆分）+ N-57.2 观测口径（coverage 快照刷新）。

### 4.9.1 v0.73 任务（一版一主题：技术债与观测收口；零新增 M 码，无语义面）

1. **解析深嵌套守卫（§5.1 NOTE 收口）**：表达式级递归（parseBinLevel 优先级梯）在 ~2000 if-expr/~1200 括号处裸 `RangeError`（实测复现，架构师 2026-11-15；语句级嵌套 3000 层不崩——NOTE 原表述"if 链"实为表达式形态）。修法 = parser 表达式递归深度计数器（try/finally 进出配对），超限（建议 300，跨机安全余量）→ `bail('M2001', '表达式嵌套过深(>N 层);提示:拆分嵌套结构')` 稳定诊断——裸 JS 栈崩溃变为可消费诊断；零新增 M 码。配对守卫防失控（嵌套块/构造的同型递归一并覆盖或具名登记不覆盖形态）。
2. **coverage 基线复测刷新（N-57.2 快照口径收口）**：`node tests/coverage.mjs` 全量重跑（基线 94.0% 行/88.7% 函数为 2026-11-13/14 快照,v0.63–v0.72 十版 src 变更未刷新）→ `docs/coverage-baseline.md` 更新（新数字 + 日期 + 与旧基线偏差注记）;vm.js 函数覆盖短板（基线 65.9%）现状分析 + 是否需补测的裁决（wasm panic 黄金测试 v0.63/65 落地后宿主导入可能已覆盖——以实测为准）。
3. **GUIDE 交叉引用补全（§4.3.8 文档结构项收口）**：目录已有,补关键章节交叉引用（§14 效果 ↔ §18 std 节 ↔ §19 serve/eval 节的"见 §N"链接;不重写正文）。

### 4.9.2 持续 defer 裁决（登记理由,非搁置）
- **checker 拆分 contracts.js**（§4.3.8 择机）:**维持 defer**——5.3k 行文件每版持续增长,纯重构 churn 高;覆盖率已高（93%+ 行,重构安全线具备但无触发条件）;无 ROI 数据;若未来 checker.js 增速恢复或出现契约子系统独立演进需求再启动。
- **ADR-006:已落盘为内联汇编**（2026-11-15,维护者需求在案——"内容源扩面 ADR"原设想由本 ADR-006 占号替代,内容源扩面维持 v1.2 Backlog 门槛不变）。**本节早前"ADR-006 不做"裁决作废**——维护者需求落场后非猜测性投入。

### 4.9.3 收口注记（2026-11-15 实测）
- **任务 1**：**审查 MAJOR-1 修复**——嵌套字符串插值每层 new Parser 新实例,exprDepth 实例字段跨实例盲视（实测插值嵌套 212 层裸崩,新最低崩点低于普查最低 221）→ 构造器第三参 baseDepth 跨实例传递 + §76.9 锁定（150 层 M2001/100 层合法）+ **实现期教训**:构造器双处 exprDepth 初始化的合并覆盖使首修失效（:62 baseDepth 被 :72 置 0 覆盖——已删后置,注释登记）。阈值二分实测校准——合同拟 300 落在崩区内（Map@300/ifexpr@300 实测裸崩）,agent 实测最小崩点 lambda ~221 → 阈值 120（合法面 10 倍余量:examples+tools 最大深度 12）;四挂点（parsePrimary 主闸 + 一元链/else-if/裸块三个直接自递归补挂——纯下降途中无表达式叶子）;开销 0.5%;恢复路径计数零残留;域外具名登记 parseType/parsePattern（崩点深一个量级）;**审查补笔**——残留裸崩面完整清单:链式 AST（成员/下标/二元/调用 ≥~3000）为 checker 侧裸崩（合法表达式,parser 循环构建不崩,§4.9.3"解析器为全管线第一崩点"对链式形态不成立）、lexer 插值嵌套 ~2974;NOTE"极端嵌套裸栈溢出"表达式域收口。**跨机口径**:守卫阈值 120 按本机（Node v24/win32）实测,帧大小随 V8 浮动 ±30% 论证留 55% 余量,其他环境不承诺守卫先于裸崩。
- **任务 2**：新快照 94.8% 行/89.7% 函数（纯净副本插桩,首跑 1131+环境失败已登记,复跑 1132 全绿）;vm.js 74.2%（旧 65.9% 为 v0.60 口径）;panic 族已覆盖判定（v0.63/65 黄金测试兑现）;补测 3 项落地（v76.6–v76.8,含 fromArtifact 进程内直调——实测发现 tools 缓存命中走 toolArtifactToPrebuilt,bin/ming.js:970 注释失准已登记）;18 具名不补 + 3 死导入 + 2 防御分支。
- **任务 3**：15 行 29 引用全效 + 3 处历史漂移修正（L56/L714/L1050）。
- **审查**：独立 code-reviewer 通过后提交。

### 4.9.3 验收门槛（原）
`node tests/run.mjs` 0 失败（§76 预估 4–6 条）;fuzz 双种子 0 分歧;docs/coverage-baseline.md 新快照带日期;GUIDE 交叉引用抽查可达;版本三处同步（v0.73.0）+ 文档三条。


现行 Backlog 见 **§4.2.8(2026-11-11 重排)**;旧表已并入该表,避免双份漂移。


## 4.10 第九轮规划：v0.75 健壮性收尾——残留裸栈崩溃面全面清零（software-architect，2026-11-16，基线 abc7387 v0.74.0，1164 项全绿）

> **方法**：v0.73 收口表达式域后，§4.9.3 审查补笔登记的残留裸崩面（链式 AST checker 侧/lexer 插值/parseType/parsePattern）经架构师 2026-11-16 全部复现实测。本版把全部裸 JS 栈崩溃收口为稳定诊断——健壮性弧线彻底关闭。

### 4.10.1 基线复现（2026-11-16，架构师实测，.zcode/v75/）
| 崩面 | 语料 | 崩点 |
|------|------|------|
| checker 二元链 | `1 + 1 + …` ×3001 项 | checkExpr 递归裸 RangeError |
| checker 调用/成员链 | `.replace(...)` ×2000 | checker 递归裸 RangeError |
| checker 类型嵌套 | `Vec[Vec[…]]` ×3500 | checkJoinNotStored 附近裸 RangeError |
| lexer 插值嵌套 | `"\{ "\{ … }" }"` ×2900 | lexer 递归裸 RangeError（parseType/parsePattern 崩点 ~3200–6400 深一个量级） |
| parsePattern 嵌套 | `Some(Some(…))` ×1200 未崩（更高待测） | — |

### 4.10.2 任务（零新增 M 码；复用 M4005[stack-overflow] 作 check-time 诊断变体——"栈溢出"语义本名，消息分层）

1. **checker 递归守卫**（checkExpr 入口 try/finally 配对，先例 = v0.73 parser exprDepth）：超限 → 稳定诊断（复用 M4005，消息"表达式嵌套过深(>N 层);提示:拆分嵌套结构或引入中间绑定"）——二元/调用/成员/下标链全部覆盖（checkExpr 单点）。阈值二分实测校准。
2. **lexer 插值嵌套守卫**：scanString 插值深度计数 → 超限稳定诊断（M4005 变体或 M1004 族——agent 按码表实测裁决，零新增码优先）。
3. **parseType/parsePattern 深嵌套守卫**：同 v0.73 exprDepth 模式挂点；阈值二分校准（崩点深一个量级，阈值相应更高）。
4. **顺带（v0.74 审查 NOTE-2）**：asm 块出现在表达式位（`let x = asm {…}`）的诊断消息加专用 hint（现回落 struct 字面量路径误导）——解析层一处。
5. **测试 §78**（6–10 条）：四崩面改后逐字稳定诊断 + 合法深嵌套不误伤 + 恢复路径零残留。

### 4.10.3a 收口注记（2026-11-16 实测）
- **阈值全部被二分实测修正**（架构师合同拟值落在崩区内）：checker 合同 ~1500 → 实测最低崩点调用链 **814** → 阈值 **450**；lexer 合同 ~1500 → 最浅入口崩点 **1762** → **950**；type 合同 1500–2000 → checker 类型树 **2701** 是真实约束 → **1450**；pattern → **2000**（崩点 3761）；**合同外 const 域**（constExprType 崩点 2200）顺带收口 → **1200**。全部占崩点 53–57%（v0.73 审查 55% 口径）。
- **毒化纪律配套**：守卫诊断入账后 depthBailed 登记——只读遍历（摘要/契约证明/索引边界/serve 扫描/const 交叉引用）跳过已报告声明；后续语句正常检查零级联（审查实测三粒度成立）。
- **独立审查通过（0 BLOCKER/0 MAJOR）**——4 MINOR 落实（M4005 码表五变体登记/README M2001 族勘误/函数级诊断缺口 GUIDE 登记/asm-struct 表达式位例外登记）；NOTE：崩点数字直连 API vs 全管线口径差（余量结论不变）；"二分到个位"软化。
- **独立验证四判定全 PASS**（四崩面清零/根因指向含阈值整点/合法面 32 文件逐字节/恢复零残留）+ **RED FLAG**：第五面 call-arg 嵌套 ~240/250 层 Parser 裸崩（pre-existing 两版本一致）→ 登记 v0.76 候选。
- **审查 MAJOR-1（GUIDE 条目错位）架构师已修**（v0.74/v0.73 测试行交换回正）。

### 4.10.3 验收门槛
全量 0 失败；fuzz 双种子 0 分歧；四崩面裸 RangeError 清零（稳定诊断逐字）；既有断言零校准或逐条理由化；版本三处同步（v0.75.0）+ 文档三条。

### 4.10.4 终态登记（本版交付后）
Backlog 全部剩余项均为外部门槛：v1.2 内容源扩面（ADR-002 修订 + 维护者窗口）/stringify_untrusted、Slice·流式（真实用例）/checker 拆分（defer 理由在案）。**健壮性弧线（parser/lexer/checker/type/pattern 五域深度守卫）就此关闭。**


## 4.11 v1.2 内容源扩面立项（2026-11-17，维护者指示；software-architect 落盘）

**交付物：docs/adr-007-taint-content-sources.md（已落盘）**——v0.61 登记窗口（fs/net/proc 内容源不标污）的正式收口裁决。

- **四个结论先行**：① 来源必污纪律一次到位（read_file/proc.stdout+stderr/http body 翻转签名，不留 clean 变体）；② **污值代数是本 ADR 真正核心**——无保污纯函数集则文件内容在语言里不可处理（mingkit/edit/json_query/log_analyzer 集体失能，迁移面实测证据 ADR §4）；③ 两域接缝用载体泛化闭合（json.parse 污 str → 污 Json，净路径逐字不变，与 stringify 拒绝对称）；④ 净化器族继续不扩（文本无机械净化定义，路径类照用 sanitize_cli_path）。
- **清单 14 项**（架构师默认立场，待维护者逐项复核）：范围翻转/第三载体 Untrusted[Vec[u8]]/保污代数/parse 接缝/write 出向透传/proc.exec 双向（cmd sink + stdout source）/http body+headers sink/引擎面零新机制/净化器不扩/无 assume_clean/argv defer v1.3/版本 v0.77 候选。
- **迁移面实测（立项时点 grep）**：tools 23 位（11 文件）/tests 32 位/examples 3 位；json.parse 测试内 80 处（仅解析外部内容者受接缝影响）；预估 src ~200–300 行 + 迁移 ~60 位；**零新增 M 码**。
- **门槛**：维护者清单复核通过 → 实现流水线（三 subagent 并发 → 独立审查 → 独立验证 → 提交，既有惯例）。近期小批 v0.76（第五崩面 + fix 处方扩面）不受影响、可先行。


## 4.12 第十轮规划：能力缺口立项（2026-11-17，software-architect，基线 edce69d v0.79.0，1260 项全绿）

> 立场声明：架构师裁决先行落盘，维护者事后复核（ADR-004/005/006/007 同款模式）。**缺口全景逐项引用既有登记点**（capabilities 未覆盖清单 / plan §5.1 / ADR 范围边界 / 历轮审查 NOTE），无一处新实测声明；规模为规划口径非承诺。前置纪律：**每项必须先满足其门槛再开工**（真实用例/部署证据/维护者裁决/ADR 落盘），不猜测性投入（v0.73 反猜测先例）。

### 4.12.1 缺口全景（按域，逐项引用登记点）

| 域 | 缺口 | 登记出处 | 现状 |
|----|------|---------|------|
| 数据面 | 流式/零拷贝：read_bytes_range 最小流式；Slice 只读视图；带长度 Ptr；8MB 单文件上限 | capabilities 流式拼接行 🟡 / Backlog "Slice·流式（待真实用例）" / rossum read_bytes_range（moltbook 待办 3） | 未做 |
| 数据面 | stringify_untrusted（污进污出变体） | ADR-004 裁决（"变体登记候选不预支"） | 等真实用例 |
| 污点面 | argv 载体（`fn main(args: Vec[str])` 未标污） | ADR-007 清单 13（defer v1.3）→ **✅ v0.82 收口（ADR-008）** | 已交付 |
| 污点面 | http 响应头 `Map[str,str]` + fs.metadata 净源 | ADR-007 审查 M2 登记不预支；plan §5.1 信息行 → **✅ v0.82 收口（ADR-008）** | 已交付 |
| 污点面 | 流敏感/跨函数推断；净化形式化证明 | capabilities 第 72 行未覆盖清单（远期） | 未做 |
| 并发面 | async/green-thread 运行时（服务端阶段 2；10 万级连接） | ADR-001（阶段 2 另 ADR；确定性调和是设计难点） | 未做 |
| 网络面 | serve 传输扩展：TLS/UDP/WebSocket/优雅停机/keep-alive/自定义 host | capabilities 第 23 行未覆盖清单；ADR-001；v1.1 no-go 先例 | 登记（证据门槛） |
| C 后端 | 插值串 / struct·array FFI ABI / 交叉编译 | capabilities 第 75 行未覆盖清单 | 未做 |
| wasm | 消息口径差（N-65.4）；剩余具名回落（is_some/is_none shape-eligible 等）；直调 +18% 栈帧代价（N-65.2） | plan §5.1 / capabilities WASM 行 / v0.65 W1 | 登记 |
| 引擎域外 | tree 引擎 ContSig/BrkSig 穿透 lambda 调用帧（防御不对称） | v0.79 审查 NOTE-1 | 硬化候选 |
| 工具链 | json_query C0 控制字符序列化分歧 | plan §5.1 信息行（v0.77 登记） | 登记 |
| AI 协作面 | fix 处方族继续扩面（4 族/79 码 ≈5%+）；LSP 泛型/多文件补全、语义 token、重命名、incremental sync | v0.66 快照数据 / capabilities LSP 行未覆盖清单 | 数据驱动 |
| 性能面 | 解释器性能天花板；泛型单态化缓存（未立项） | Backlog（无 bench 证据降级） | 待证据 |
| 证明面 | while/loop/分支敏感/递归证明；SMT 成本 | capabilities 静态契约行未覆盖清单；§4.3.8 | 保守放弃现状 |
| 生态面 | examples/onboarding 扩面（N-64/N-67 部分已兑现） | plan §5.1 N 项 | 小项 |

### 4.12.2 设计耦合簇（问题全面性的核心——簇内单做任何一个都是半成品）

- **簇 A 零拷贝与证明联动**：Slice 只读视图 ↔ 带长度 Ptr ↔ unsafe(cond) 证明携带 ↔ read_bytes_range——四件同一设计簇（Backlog 原文"零拷贝与证明联动先决条件"）。Slice 无证明携带 = 新的 unsafe 逃逸口；证明无 Slice = 无对象可证。**必须 ADR-008 一次设计到位**。
- **簇 B 污点窗口制**：argv v1.3 + http 响应头/metadata 翻转同属破坏性签扩展——一次窗口裁决、一次迁移（**ADR-008 已落盘**）（v0.61→v0.77 同模式：族扩展按窗口走）。argv 波及每个 main；响应头 `Map[str,Untrusted[str]]` 波及 net 消费面。
- **簇 C 并发与传输**：async/green-thread（ADR-001 阶段 2）是并发天花板；但 **TLS 可独立于并发模型**（传输层，Node tls 可承载）；keep-alive/优雅停机依赖连接生命周期设计（与并发模型耦合）；UDP/WS 各自另裁。**禁止混合形态**（ADR-001 原判）。
- **簇 D 后端 ABI**：C 后端 struct/array FFI ABI + 交叉编译 + asm 多架构——同一"跨语言/跨平台"主题，用例驱动（asm 使用数据 / FFI 真实需求）。
- **簇 E AI 协作面**：fix 处方扩面 + LSP 补全 + 语义 token——全部数据驱动（快照高频族 / 实际补全需求），无数据不开工。

### 4.12.3 优先级裁决（架构师立场）

**P1——无外部门槛、规模可控、数据驱动（v0.80/v0.81 候选）**
1. fix 处方扩面第二波（数据驱动：v0.66 快照高频族 M3008/M3012 等；纪律 = 应用后必消除错误，宁缺毋滥）
2. LSP 多文件符号补全第一切片（保守原则不变：推不出 → 空）
3. 小项清账：tree ContSig 硬化（NOTE-1）+ json_query C0（登记转修复）+ wasm 消息口径（N-65.4 统一）

**P2——需维护者裁决（窗口制）**
4. 污点 v1.3 窗口（argv + 响应头/metadata）——**ADR-008 已裁决落盘（2026-11-17，清单 12 项：argv = Vec[Untrusted[str]] / 响应头 = Untrusted[Map[str,str]] 第四载体 / metadata = Untrusted[Json]；迁移面实测 16 签名位 + tests 3 位 + metadata 0 位）**，实现 = v0.82.0

**P3——需外部条件（真实用例/部署证据/使用数据）**
5. 流式·Slice 簇（ADR-008 落盘 + rossum 数据）→ v0.83+ 候选
6. serve TLS 最小片（部署证据门槛）→ v0.84+ 候选
7. stringify_untrusted（真实用例）
8. C ABI 扩展（FFI 真实需求）
9. asm 多架构（使用数据）
10. 泛型单态化缓存（bench 证据）
11. 证明面扩大（SMT 成本评估）

**P4——远期/另议**
12. async/green-thread（ADR-001 阶段 2，独立 ADR——**语义定义先于实现**："确定性并发"本身需裁决）
13. 流敏感/跨函数污点推断；净化形式化证明

**不做（维持否决/不排期）**：热重载（ADR-005 §2.4）、可执行内存/ROP/攻击工具面（ADR-006 §3）、assume_clean（ADR-007）、checker 拆分（§4.3.8 defer）、read_line/RegExp 进程内抢占（已具名登记不修）。

### 4.12.4 版本路线（v0.80+ 候选；一版一主题）

> **注（2026-11-18）**：本表 v0.83+ 候选行已被第十一轮 §4.13.5 重排取代（流式·Slice → v0.86、TLS → P3 条件驱动、新增 v0.83 引擎一致性收尾/v0.84 观测复批/v0.85 AI 第三波）——本表保留作历史记录。

| 版本 | 主题 | 门槛/规模 |
|------|------|-----------|
| v0.80 | ✅ 已交付（2026-11-18）：AI 协作面第二波（fix 扩面发射族 4→9 + LSP 切片；审查 REQUEST_CHANGES（1 MAJOR + 3 MINOR）修复后通过） | 无新语言面；快照数据驱动；§84 26 条 + §85 9 条 |
| v0.81 | ✅ 已交付（2026-11-18）：引擎一致性小项清账（M4002 四引擎统一含 cc 收口/tree ContSig 硬化/json_query C0 收敛；审查 APPROVE-with-minor 修复后通过） | strict 可见面；§86 11 条 + §87 22 条 |
| v0.82 | ✅ 已交付（2026-11-18）：污点 v1.3 窗口（argv = Vec[Untrusted[str]] / 响应头 = Untrusted[Map[str,str]] 第四载体 / metadata = Untrusted[Json]；迁移实测 20 位——14 工具 + 4 tests + 2 net_e2e；审查 APPROVE-with-minor 修复后通过） | ADR-008 清单 12 项；§88 17 check + §89 23 check |
| v0.83+ 候选 | 流式·Slice 设计簇（ADR-009） | ADR + 真实数据 |
| v0.84+ 候选 | serve TLS 最小片 | 部署证据 |
| 远期 | async/green-thread；流敏感污点；证明面扩大 | 独立 ADR / SMT 评估 |
| 随时 | bench WARN 复测 | — |

### 4.12.5 重点立项的问题定义（每项：问题/前置/规模/验收/风险）

- **v0.80 fix 处方扩面（✅ 已交付 2026-11-18，发射族 4→9）**：问题 = 79 码中仅 4 族发射结构化 fix（M2002/M3029/M3001/M3002），AI 修正回路最有效杠杆仍是"可机器应用的处方"。前置 = v0.66 快照数据选族（高频且机械可判）。规模 = 每族 ~30–60 行 + 回归。验收 = 应用后必消除错误（v44 纪律）+ 负例"宁缺毋滥"。风险 = 误伤面（v0.76 两 MAJOR 先例——每族必须锚定替换域计算与守卫排除面）。
- **v0.80 LSP 多文件补全切片（✅ 已交付 2026-11-18）**：问题 = 现保守策略"类型推不出 → 空列表"在多文件场景断供。前置 = 跨文件符号表（LspServer 全量重查已具备——incremental sync 不做）。切片 = 多文件模块项补全（use 导入名/模块路径内符号）+ 保守回退。验收 = 现有单文件补全零回归 + 多文件正例。风险 = 保守性失守（宁可空列表不可错补）。
- **v0.81 wasm 消息口径（N-65.4）（✅ 已交付 2026-11-18，分支 a 统一 + 架构师 cc 收口）**：问题 = M4002 wasm 侧泛化文案 vs tree 操作数逐字——差分仅消息文本。裁决 = **统一或具名不统一**（若宿主侧无法取得操作数，则登记"消息口径分叉"为正式合同条款并收敛测试断言口径）。风险 = 触及宿主边界（操作数需穿越导入——成本评估先行）。
- **v0.81 tree ContSig 硬化（NOTE-1）（✅ 已交付 2026-11-18）**：问题 = 拦截仅在编译器层；tree callClosure 只捕获 RetSig。修复 = tree 侧捕获 BrkSig/ContSig → 具名内部错误（纵深防御对称化，与 compiler.js:622 同模式）。规模 = ~10 行 + 测试。风险 = 无（checker 已拦，纯防御）。
- **v0.81 json_query C0（✅ 已交付 2026-11-18，工具内修复）**：问题 = 污 Json 重建路径对控制字符原样透出（jsonWrite 是 \uXXXX）。前置 = 语言面码点分类能力（或工具内 char 遍历——已部分存在）。验收 = 控制字符逐字节与 debug(Json) 一致（或登记分歧收敛）。风险 = 需码点级字符串能力（checker 白名单外）。
- **v0.82 污点 v1.3 窗口（✅ 已交付 2026-11-18，ADR-008 清单 12 项全落地）**：问题 = argv 是 OS 来源却净（main 签名波及每个程序）；http 响应头/ metadata 是外部内容却净。裁决点 = ① argv 载体形态（`Vec[Untrusted[str]]` vs 包装）② 响应头载体（`Map[str, Untrusted[str]]`）③ 迁移面（全部 main 签名 + net 消费面 + tools/examples/tests）④ 窗口版本号。风险 = 破坏性面全语言——必须窗口制一次到位（v0.77 先例：源必污纪律）。
- **v0.83+ 流式·Slice（ADR-008）**：问题 = 8MB 上限 + 无零拷贝（rossum 机器人真实反例在案）。设计约束 = Slice 只读视图/带长度/生命周期逃逸分析 + 与 unsafe(cond) 证明携带联动 + read_bytes_range 的最小独立价值（不依赖 Slice 的纯流式 I/O）。验收 = 大文件分段处理 + 黄金逐字节；风险 = 证明系统复杂度（簇 A 一次到位）。
- **v0.84+ serve TLS**：问题 = serve 仅明文 HTTP/127.0.0.1。最小片 = TLS 监听（自签/证书加载）+ 既有 worker 管线不变。前置 = 部署证据（谁是第一个 TLS 用户）。风险 = 证书材料管理（文件来源 → 污点面联动）。
- **远期 async/green-thread**：问题 = 10 万级并发与确定性合同的语义冲突（ADR-001 原判"确定性调和是设计难点"）。前置 = **"确定性并发"语义定义 ADR**（调度点确定性/结果确定性/四引擎差分口径三选一或组合）。禁止以性能为由降低确定性合同。
- **远期 证明面扩大**：while/loop/分支敏感/递归——SMT 成本与放弃面权衡（当前保守放弃是有意设计，非缺陷）。

### 4.12.6 Backlog 处置表增补

| 项 | 处置 | 理由 |
|----|------|------|
| fix 处方扩面 / LSP 切片 | **✅ 已交付 v0.80（2026-11-18）** | 数据驱动；无新语言面；审查 REQUEST_CHANGES（1 MAJOR + 3 MINOR）修复后通过；零回归锚点 + f-probe 方法学沿用 |
| LSP 通用列表 mingLspPlaceholder 占位符泄漏（`use x as ` 回落上下文候选含内部占位符，kind 9；v0.58 既有行为，v0.80 审查 NOTE-2 实测登记） | **Backlog 候选（P1 小项；v0.81 未收口——批内所有权归 lsp.js，两批均未涉）** | 通用列表过滤 `mingLspPlaceholder` 前缀即可；不阻塞 |
| wasm 口径 / tree ContSig / json_query C0 | **✅ 已交付 v0.81（2026-11-18）** | 小项清账；登记转修复；M4002 四引擎逐字，审查 APPROVE-with-minor |
| M4004 除零/取模零 eligible 泛化分叉（v0.81 审查 MINOR-3 登记：取模零为 tree 专属模板 `整数取模零:<a> % 0`，cc main 已同口径，eligible 泛化连措辞都不同） | **Backlog 候选（P1 小项）** | 形态与 N-65.4 完全同构，panic_m4002_op 扩面模式可复用；未来统一时 `/` 零与 `%` 零两模板都要做 |
| 取负溢出 tree 位置缺口（negSlow 无 span → tree 报 `<unknown>:0:0`，VM/wasm/cc 带位置） | **Backlog 候选（P1 一行级）** | interp.js negSlow 补 span 实参即可；§87 对 neg 形态只锁消息不锁位置（将来修复零校准） |
| json_query 孤立代理对分歧（`\ud800`：引擎输出 ASCII 转义 vs 工具输出 U+FFFD 替换字节；语言面 bytes 不可区分 U+FFFD 与被换码代理） | **Backlog 候选（需语言面码点能力）** | 工具内不可修；需 bytes 级诊断能力或引擎 debug 口径联动，另裁 |
| 污点 v1.3（argv + 响应头/metadata） | **✅ 已交付 v0.82（2026-11-18）** | ADR-008 落地；破坏性窗口一次到位；迁移 20 位良性路径逐字节 |
| 流式·Slice 簇 | **v0.83+ 候选（P3，ADR-008）** | rossum 数据在案；簇 A 一次设计 |
| serve TLS（最小片） | **v0.84+ 候选（P3，部署证据）** | v1.1 no-go 先例：证据驱动 |
| stringify_untrusted / C ABI / asm 多架构 / 泛型缓存 / 证明扩大 | **P3 条件驱动** | 各自门槛未满足 |
| async/green-thread / 流敏感污点 / 形式化证明 | **P4 远期** | 需独立 ADR 或语义定义先行 |
| 热重载 / 攻击面 / assume_clean / checker 拆分 | **不做（维持）** | 既有否决/不排期决定 |

## 4.13 第十一轮规划：能力缺口立项（2026-11-18，software-architect，基线 6b2aed6 v0.82.0，1373 项全绿）

> 立场声明（沿 §4.12）：架构师裁决先行落盘，维护者事后复核。**缺口全景逐项引用既有登记点**（capabilities 未覆盖清单 / plan §5.1 与 §4.12.6 / ADR-001–008 范围边界 / 历轮审查 NOTE·MINOR / moltbook 真实用例 / serve-observation no-go / coverage-baseline / ai-loop-snapshot），无一处新实测声明；规模为规划口径非承诺。前置纪律不变：**每项必须先满足其门槛再开工**（真实用例/部署证据/使用数据/维护者复核/ADR 落盘），不猜测性投入。
> 本轮起点 = **§4.12 P1/P2 全部清空**（v0.80 AI 协作面第二波 / v0.81 引擎一致性小项清账 / v0.82 污点 v1.3 窗口——三版连发 2026-11-18，审查全部通过后提交）。侦察由两个只读 agent 扫全登记点完成（能力面 25 条 + 未决登记 40 余条，含本轮新发现：capabilities 头注版本错位〔本会话编辑遗留，已就地修正〕、references.md 5 处过时行文、bench WARN 混合成因消退复测 WARN 0）。

### 4.13.1 基线（2026-11-18 实测）

| 项 | 状态 |
|----|------|
| 版本/测试 | v0.82.0（6b2aed6）；**1373 项全绿**（§88 17 check + §89 23 check）；fuzz 双种子 ×40 0 分歧；proof_fuzz 0 误报 |
| 能力矩阵 | 55 行 ≈85%（42✅ 10🟡 3❌，最后一次重算 v0.74 口径——**v0.80–v0.82 扩面后待重算**，入 v0.84 观测批） |
| 覆盖率 | 94.8% 行 / 89.7% 函数（2026-11-15 v0.72 快照——**v0.81/v0.82 大改 checker/wasm/cbackend 后待复测**，入 v0.84） |
| bench | 2026-11-18 复测 **WARN 0**（五项对比；开发期 WARN 混合成因消退；invariant 项 vm 0.25µs/次 占 24.0%；**字段遍历形态未测**——moltbook:147，入 v0.84 测量项） |
| 诊断 | 78 码；fix 发射族 9/79 ≈11%（v0.80 后）；M4002 四引擎逐字（v0.81），M4004 eligible 泛化分叉为剩余同族 |

### 4.13.2 缺口全景（按域，逐项引用登记点）

| 域 | 缺口 | 登记出处 | 现状/门槛 |
|----|------|---------|----------|
| panic 消息面 | **M4004 同族**（除零/取模零 eligible 泛化分叉——取模零为 tree 专属模板 `整数取模零:<a> % 0`，cc main 已同口径，eligible 连措辞都不同） | §4.12.6 登记行（v0.81 审查 MINOR-3）；capabilities:74 | 无门槛；panic_m4004_op 复用 v0.81 模式 |
| panic 消息面 | 取负溢出 tree 位置缺口（negSlow 无 span → `<unknown>:0:0`） | §4.12.6 登记行；§87 neg 形态"将来修复零校准"承诺 | 无门槛；一行级 |
| panic 消息面 | #58 cc 侧残留（cbackend.js:986 语句列差 1 + ming_vec_set 消息带读后缀） | plan §5.1 #58 | 无门槛；cc panic 面顺带 |
| 工具链 | LSP 通用列表 mingLspPlaceholder 占位符泄漏（`use x as ` 回落上下文） | §4.12.6 登记行（v0.80 审查 NOTE-2） | 无门槛；一行级 |
| 卫生 | N-60.1 M4012 先于 worker.terminate（库场景泄漏）；N-61.2 tryWasm 原地改 sig（卫生债） | plan §5.1 N-60.1/N-61.2 | 无门槛；评估后随 v0.83 |
| 数据面 | **流式/零拷贝**：read_bytes_range 最小流式；Slice 只读视图；带长度 Ptr；8MB 单文件上限；HTTP 体 8MB 无流式/取消 | capabilities:16/22/71；moltbook:74/75/137（**rossum 真实用例在案**：6.3MB 单帧可、30 帧缓冲不可——流式"不做"改判的真实反例） | **ADR-009 落盘 + 维护者复核** |
| 污点面 | `io.read_to_end` 维持净 str（同源 read_line 已标——口径差异）；stringify_untrusted；`Untrusted[u8]` 原始字节载体 | capabilities:72；plan:1127；ADR-004:131/244 | read_to_end = 破坏性微窗（维护者裁决）；后两项 = 真实用例 |
| 诊断面 | e05 越界写/e24 无 requires 越界读**静态静默**（check 通过 + 运行时 M4003 兜底） | ai-loop-snapshot:70/71（仍开放） | warn 化需误报率数据（P3）；维持静默属文档化口径 |
| 诊断面 | json_query 孤立代理对分歧（`\ud800`：引擎 ASCII 转义 vs 工具 U+FFFD 替换字节） | §4.12.6 登记行 | 需语言面 bytes 级能力（另裁） |
| AI 协作面 | fix 处方 9/79 ≈11%——第三波（数据选族）；LSP 第二切片（别名位/子目录首段 use/泛型推洞/语义 token/重命名/incremental sync） | capabilities:59；§4.12.5 方法论 | **前置 = AI 快照复测数据**（v0.84） |
| 观测面 | coverage v0.82 复测；vm.js 74.2% 短板（2 补测 + 3 死导入 + 18 资格面挡住）；repl.js 89.7% 回落；AI 快照复测；bench 字段遍历测量；capabilities 口径重算 | coverage-baseline:139-145；moltbook:147；capabilities:1/82 | 无门槛（纯测量） |
| 文档诚实性 | references.md 5 处过时行文（mask"实现待定"→实为永久否决、契约/污点/缓存行文）；moltbook 注记过时（v0.82 已兑现三项）；N-66 AOT 含 test 块回退源码模式与"无明文源"表述不一致 | references:36/37/77/80/118；moltbook:54；plan §5.1 N-66 | 无门槛（v0.84 文档批） |
| 服务端 | TLS/UDP/WS/keep-alive/优雅停机/自定义 host/访问日志/自省 API（PID·RSS）；handler 内 spawn scoped 语义 | capabilities:23；ADR-001:208-217/77/113；serve-observation:54 | TLS = 部署证据；其余 = 需求证据/各自另裁；v1.1 no-go 维持 |
| 并发面 | async/green-thread（10 万级连接）；AOT worker 快路径；协作取消/子任务自检 | capabilities:64/77；ADR-001:204-205 | 语义 ADR 先行（P4）；取消面另裁 |
| C 后端 | 插值串；struct/array FFI ABI；交叉编译 | capabilities:75/80；§4.12.1 | FFI = 真实需求 + **#55 NUL 策略前置义务**（plan:682）；其余 = 用例 |
| asm | 多架构模板；asm 作表达式有值形态 | capabilities:76；ADR-006:44 | 使用数据 |
| wasm | 数值 VecLit 容器表示未统一（#40 残留）；match 不支持；剩余守护具名（is_some/is_none 等）；直调 +18%（N-65.2）；Result 句柄池无回收（N-65.1）；N-60.3 wasmWriteVecNum mut 旗标丢弃 | plan §5.1；capabilities:74 | 各自具名；扩面属语义工作 |
| 证明面 | while/loop/分支敏感/递归/高阶；SMT 成本 | capabilities:60 | 维持保守放弃（有意设计）；扩大需 SMT 成本评估 |
| 密码学 | RSA/国密/字节流接口"随后"悬置 | capabilities:66 | 悬置（无需求登记） |
| 生态面 | N-64 examples 覆盖不足残项（serve_demo/unstr_demo 已兑现部分） | plan §5.1 N-64 | 小项随版 |
| 远期参考 | Blood 代际引用/线性类型跨效应挂起；get(i)→Option[char] 载体建模 | references:78/79；ADR-002:140 | 远期参考（研究构想口径） |

### 4.13.3 设计耦合簇（更新）

- **簇 A 零拷贝与证明联动（ADR-009 ✅ 已落盘 2026-11-19，docs/adr-009-streaming-slice.md）**：Slice 只读视图 ↔ 带长度 Ptr ↔ unsafe(cond) 证明携带 ↔ read_bytes_range——四件同一设计簇一次设计、**分阶段实现**（S1 read_bytes_range v0.86 / S2 Slice[u8] v0.87+ / S3 带长度 Ptr+C ABB 条件 / S4 unsafe(cond) 远期四门槛）。**rossum 数据在案**（moltbook:74/75/137）为首个真实用例锚点；Slice 无证明携带 = 新 unsafe 逃逸口，证明无 Slice = 无对象可证——裁决见 ADR-009 §2（Slice 值语义例外三硬约束/8MB 单次上限保留/污点载体不扩/证明不消除检查维持）。
- **簇 B 污点窗口**——**v0.82 已关闭**（argv/响应头/metadata 三族落地）。残项各自门槛：read_to_end 翻转（破坏性微窗）、stringify_untrusted/Untrusted[u8]（真实用例）、流敏感/形式化（远期）。
- **簇 C 并发与传输**：TLS 可独立于并发模型（传输层）；keep-alive/优雅停机/自省 API 耦合连接生命周期设计；UDP/WS 各自另裁；async 挂"确定性并发"语义 ADR（ADR-001:204 原判维持）。**禁止混合形态**。
- **簇 D 后端 ABI**：C FFI struct/array + 交叉编译 + asm 多架构——用例驱动；FFI 扩面**必须先裁决 #55 NUL 策略**（plan:682 前置义务）。
- **簇 E AI 协作面数据链**：AI 快照复测（v0.84）→ fix 第三波 + LSP 第二切片（v0.85）——**数据先行，无数据不开工**（§4.12.5 方法论延续）。
- **簇 F（新）panic/诊断面剩余**：M4004 同族 + 取负 span + #58 cc 残留 + LSP 占位符——全无门槛、同构模式已验证（v0.81 panic_m4002_op），一次清账。
- **簇 G（新）观测-文档诚实性**：coverage/bench/AI 快照/capabilities 口径/references/moltbook——纯测量批，产出同时为簇 E 供数据。

### 4.13.4 优先级裁决（架构师立场）

**P1——无外部门槛（v0.83/v0.84 候选）**
1. **引擎一致性收尾三件 + 卫生件**（v0.83）：M4004 同族统一（panic_m4004_op 复用模式；除零/取模零两模板 + cc main/eligible 同模板）+ 取负 tree span 一行（解锁 §87 neg 位置断言）+ #58 cc 残留（列差 + ming_vec_set 消息后缀）+ LSP 占位符过滤一行 + N-60.1/N-61.2 卫生件（评估后随版）。无新语言面，零新增 M 码。
2. **观测与诚实性复批**（v0.84，纯测量/文档，零语义改动——v0.66 纯测量先例）：coverage v0.82 复测刷新 + vm.js 短板处置（2 补测 + 3 死导入清理裁决）+ bench 字段遍历新测量项 + **AI 修正回路快照复测**（fix 9 族后的误导/级联/fix 覆盖率重测——为 v0.85 供数据）+ capabilities 口径重算 + references.md 审计 + moltbook 注记 + N-66 口径裁决。

**P2——需 ADR 落盘/维护者复核/前置数据**
3. **AI 协作面第三波**（v0.85 候选）：fix 处方第三波 + LSP 第二切片——**前置 = v0.84 快照数据**，宁缺毋滥纪律不变。
4. **流式·Slice 第一片**（v0.86 候选）：**ADR-009 落盘**（簇 A 一次设计）+ 维护者复核 → read_bytes_range 最小流式（独立价值，不依赖 Slice；与 8MB 上限关系裁决）。
5. **污点破坏性微窗**（下一窗口，需维护者裁决）：read_to_end 翻转（对齐 read_line 同源纪律）；stringify_untrusted 若真实用例出现则并窗。

**P3——外部条件（各自门槛原文）**：serve TLS（部署证据——v1.1 no-go 先例）；C FFI ABI（真实需求 + #55 NUL 前置）；交叉编译（用例）；asm 多架构/表达式位（使用数据）；泛型单态化缓存（bench 证据）；证明面扩大/while（SMT 成本评估）；WS/UDP/keep-alive/优雅停机/自定义 host/自省 API（需求证据 + 各自另裁，ADR-001 §4.5 清单）；N-65.1 Result 句柄回收（长驻进程数据）；N-60.3 mut 旗标（容量语义评估）；ADR-002 get(i) char 载体（设计）；密码学 RSA/国密（悬置——需求出现前不排期）；e05/e24 越界静态 warn 化（误报率数据）；孤立代理对（bytes 级能力设计）；HTTP 客户端流式/取消（用例）。

**P4——远期/另议**：async/green-thread **"确定性并发"语义定义 ADR**（语义先于实现——调度点确定性/结果确定性/四引擎差分口径三选一或组合；ADR-001:204"当前无解"维持）；流敏感/跨函数污点推断；净化形式化证明；mask 重开（ADR-003 三门槛）；Blood 远期参考（代际引用/线性跨效应——研究构想口径）；L2/L3 原始包（原生后端之后）。

**不做（维持否决/不排期）**：热重载（ADR-005 §2.4）、可执行内存/ROP/块外跳转（ADR-006 §5）、assume_clean/净化器族扩张（ADR-007 §6）、checker 拆分（§4.3.8 defer）、read_line/RegExp 进程内抢占（具名登记）、键级混合载体（ADR-008 §6）、响应位授权（ADR-004:136）、eval 沙箱承诺、跨 OS 位级一致构建、格式化本地化（宿主委托策略）。

### 4.13.5 版本路线（v0.83+；一版一主题）

| 版本 | 主题 | 门槛/规模 |
|------|------|-----------|
| v0.83 | ✅ 已交付（2026-11-18）：引擎一致性收尾（M4004 同族统一 + 取负 span + #58 + LSP 占位符 + N-60.1/N-61.2 + **#72 收口**——审查 REQUEST_CHANGES 1 BLOCKER 修复后通过） | 无新语言面；零新增 M 码；§90 16 check + §91 9 check |
| v0.84 | ✅ 已交付（2026-11-18）：观测与诚实性复批（coverage 95.0%/90.3%、bench 字段遍历亚线性 1.65–2.08x、AI 快照级联 1.75→1.29/误导 7→0 + capabilities 复算/references 5 处/N-66 口径）+ **fits bits=32 修复**（v0.83 审查 M1；顺带消除 VM i32 ±1 假 M4002）——审查 REQUEST_CHANGES（2 MAJOR 表述/登记面）修复后通过 | 纯测量/文档为主；审查新登记 3 项窄型算术分歧转 v0.85 |
| v0.85 | ✅ 已交付（2026-11-18）：窄型算术一致性收口（intBin `+`/`*`/`/` 运行时窄 bits fits 门——静默回绕收敛 M4002，零校准）+ M3013 无损拓宽 fix 族（快照数据唯一有据族，f-probe 0 error）+ VM ADDI 两件（>2^53 BigInt 回落 / `-=` 消息模板）——审查 APPROVE-with-minor（1 预存 MAJOR 登记+表述收窄，3 MINOR 全落实） | 零新增 M 码；§93 23 check + §94 13 check |
| v0.85 审查登记（v0.84 审查落盘） | ① 窄型 `+`/`*`/`/` number 快路径无 fits 门（tree/VM 一致但静默溢出——`127i8+1i8=128`、`i32::MIN/-1=2147483648`，违约"溢出必 panic"；补门 = 语义变更需理由化）② VM ADDI 对 >2^53 合法 i64 和假报 M4002（isSafeInteger 失败置 null 直 panic，未回落 BigInt——tree 正确，硬规则 1 分歧）③ ADDI `-=` 越界消息 tree「整数-溢出:a - 1」vs VM「整数+溢出:a + -1」（i8/i32/i64 全宽度，同码同 exit，仅消息文本） | **v0.85 候选（P1）**——①②为语义分歧/违约，③为消息面；均 pre-existing（HEAD 纯净副本复现），无既有测试锁定 |
| v0.86 | ✅ 已交付（2026-11-19）：流式第一片（read_bytes_range 最小流式，ADR-009 S1）——范围读/短读合法/8MB 单次上限保留/总量分段/计费按实读/同源同污；**>8MB 机器证明 v95.13**；审查 REQUEST_CHANGES（1 MAJOR 补证明）修复后通过 | **ADR-009 已落盘；维护者复核位 = ADR-009 §7（12 项清单；S1 先行，否决仅回退 S1）**；§95 15 check |
| v0.87 | ✅ 已交付（2026-11-19）：ADR-009 S2 Slice[u8] 只读视图（块内线性/M3051/零拷贝白盒/wasm 具名不资格）+ 窄型注解宽度归一（四边界重标双引擎对称——v0.85 审查 M1 缺口收口；闭包捕获归一三层断裂闭合，审查 MAJOR-2 追踪修复）+ Slice == 静态拒绝——审查 REQUEST_CHANGES（2 MAJOR 定向修复+事故复核通过）后通过 | 零破坏窗口；零新增 M 码——M3051 新登记三处；§96 18 check + §97 14 check |
| v0.88 | ✅ 已交付（2026-11-19）：窄型注解遗留边界四项归一扩展（规格树声明驱动：struct ctor+字段写/Vec 标注初始化+push+元素写/无标注 lambda 形参回写/元组模式绑定——双引擎对称静默→M4002）+ AOT 兼容方案 a（wire normSpec 序列化）+ wasm 资格面扩展 + 独立基线审计（16 探针）+ fuzz 5 窄型 shape 差分探测器（突变实验实证）——审查 APPROVE-with-minor（放行条件 M1a/M1b 登记+#73 登记均落实） | 零新增 M 码；§98 18 check |
| v0.89 | ✅ 已交付（2026-11-19）：同族归一收口（Map 值位第五缺口/lambda 返回位双通道/enum payload def 驱动/推断型 M1a·M1b 值标签驱动——双引擎对称静默→M4002）——审查 APPROVE-with-minor（2 MAJOR 预存登记级，5 MINOR 全落实） | 零新增 M 码；§99 18 check |
| v0.87+ | Slice/带长度 Ptr/unsafe(cond) 联动（簇 A 续）；污点微窗（read_to_end）；条件驱动簇（TLS/C ABI/asm 多架构/泛型缓存） | 各自门槛 |
| 远期 | async 语义 ADR；流敏感污点；形式化；mask 重开三门槛 | 独立 ADR |
| 随时 | bench WARN 复测（本轮回测 WARN 0 已登记）；S11 stderr 提示一行（serve-observation Backlog 级） | — |

### 4.13.6 重点立项的问题定义（每项：问题/前置/规模/验收/风险）

- **v0.83 M4004 同族统一**：问题 = 除零/取模零在 wasm/cc eligible 泛化（"整数除零"连措辞都与 tree 的"整数取模零"不同），与 v0.81 M4002 统一前的形态同构。前置 = 无（panic_m4002_op 模式/导入纪律/矩阵测试方法学全部现成）。规模 = 导入尾部追加 1 条（panic_m4004_op）+ 宿主模板 + 全部调用点同款切换 + cc 同模板 + §90 矩阵。验收 = 四引擎首行逐字（除零/取模零 × i64/u64 × main/eligible）+ fuzz 双种子 0 分歧 + 既有 M4004 断言逐字存活（除理由化校准）。风险 = 低（模式已验证；旧 AOT 兼容按 panic_m4002 保留先例）。
- **v0.83 取负 span + #58**：问题 = tree 取负报 `<unknown>:0:0`、cc 语句列差 1/消息带读后缀——panic 面最后的位置残差。前置 = 无。规模 = 各一行级 + §87 neg 断言解锁 + #58 校准。验收 = 取负四腿位置逐字；#58 三引擎逐字。风险 = 无（位置补齐单向收紧）。
- **v0.83 LSP 占位符过滤**：问题 = `use x as ` 回落通用列表泄漏内部占位符 mingLspPlaceholder0（kind 9）——补全面唯一已知错补残留。前置 = 无。规模 = lsp.js 过滤一行 + §89 补断言。验收 = 回落列表不含占位符前缀；既有补全零回归。风险 = 无。
- **v0.84 观测复批**：问题 = v0.80–v0.82 三版大改 checker/wasm/cbackend/lsp 后，coverage/bench/AI 快照/capabilities 口径全部停在旧时点；references.md 5 处过时行文与 N-66 口径漂移损害"文档=实现"承诺。前置 = 无（纯测量）。规模 = coverage 复测 1 次插桩全量 + bench 1 次 + 快照语料重跑（v0.66 方法学复用）+ 文档批。验收 = 全部数字来自可复现命令并回填文档；零 src 语义改动（补测 3 条除外）。风险 = coverage 数字回落（大改后正常波动——如实登记不设门槛）。
- **v0.85 fix 第三波 + LSP 第二切片**：问题 = fix 9/79 ≈11%、LSP 别名位/子目录 use 仍断供——但**选族与选件必须由新快照数据驱动**（v0.66 数据已被 v0.67–v0.80 消化完毕）。前置 = v0.84 快照复测。规模 = 每族 30–60 行 + f-probe（fix）/每件保守切片（LSP）。验收 = 应用后必消除（fix）/宁可空列表不可错补（LSP）+ 既有锚点零校准。风险 = 误伤面（v0.80 MAJOR-1 先例——每族锚定替换域与守卫）；数据不足则如实缩项。
- **ADR-009 流式·Slice 簇（✅ 已落盘 2026-11-19，docs/adr-009-streaming-slice.md）**：问题 = 8MB 上限 + 无零拷贝（rossum：30 帧缓冲不可）——read_bytes_range 最小流式有独立价值，但 Slice/带长度 Ptr/unsafe(cond) 是同一设计簇（单做任一件都是半成品）。**裁决**：S1 read_bytes_range 立即实现（`Result[Untrusted[Vec[u8]], str]`/8MB 单次上限保留/短读截断合法/负数与越界 Err/计费按返回长度）；S2 Slice[u8]（视图例外三硬约束：非 mut 源/块内线性/M3051 逃逸拒绝；证明义务复用 len 符号；proven 不消除运行时检查）；S3 带长度 Ptr 延迟（C ABI 用例 + #55 NUL 前置）；S4 unsafe(cond) 延迟（四门槛：证明器覆盖率评估/Slice+带长度 Ptr 就位/proof_fuzz 扩展反例验证/维护者复核——ADR-003 唯一例外仅门槛全满足后生效）。**风险 = 证明系统复杂度（S4 不达则 S1/S2 独立交付不受阻）**。
- **污点微窗（read_to_end）**：问题 = io.read_to_end 维持净 str——同源 read_line 已标，口径差异是 v0.77 登记的诚实边界。前置 = 维护者裁决窗口（破坏性小面——消费方需改污值代数处理）。规模 = 签名翻转 1 处 + 消费面迁移。验收 = 同源同污纪律闭合；良性路径逐字节。风险 = 低（消费面小）；与 stringify_untrusted 并窗裁决。

### 4.13.7 Backlog 处置表增补（沿 §4.12.6 编制）

| 项 | 处置 | 理由 |
|----|------|------|
| M4004 同族 / 取负 span / #58 cc / LSP 占位符 / N-60.1 / N-61.2 | **✅ 已交付 v0.83（2026-11-18）** | 无门槛；同构模式已验证（v0.81 先例）；审查通过 |
| **#72**（v0.83 实现期发现）：i32::MIN 取负 tree number 路径无 fits 门静默回绕 vs VM/wasm M4002——双引擎语义分歧 | **✅ 已修复 v0.83（架构师集成）** | interp signed fits 门 + vm UN span；v91.9 锁定；cc C1 拒绝该形态如实注记 |
| fits number 路径 bits=32 怪癖（`1 << 31` 负值——i32 to_i32 恒 None/窄型快路径恒绕行；良性慢不错，v0.83 审查 M1 登记） | **✅ 已修复 v0.84**（`2 ** (bits-1)`；to_i32 正常、VM i32 ±1 假 M4002 同宗收口；§92 7 check） | — |
| **窄型注解宽度缺口**（v0.85 审查 M1 新登记，预存）：注解不产生窄型运行时值——`let a: i32 = 2147483647; a + 1i32` 三腿静默 2147483648（`intBin` 宽度取左操作数运行时 bits；注解/let/返回/传参均不归一）；方向性不一致（`250u8 + a` panic vs `a + 250u8` 静默）；窄型门只对"运行时携带窄 bits 的值"（后缀/as/to_*）成立 | **✅ 已修复 v0.87**（四边界+注解绑定归一，规格树；v0.88 扩展四遗留边界） | 归一=标注/声明驱动;推断型面见下两行 |
| **推断型绑定逃逸归一**（v0.88 审查 M1a 新登记，checker 合法 checker 合法静默面）：无标注元组解构 + plain 重赋值（`let mut (a,b) = (5u8,6u8); a = 250; a + 10u8` 三腿静默 260） | **同族候选（下一切片）** | 修法方向 = checker 推断类型驱动的规格树（推断窄型绑定处回写复用 narrowParamTypes 通道） |
| **推断型窄容器 + plain push**（v0.88 审查 M1b 新登记）：`let v = [1i32, 2i32]; v.push(2147483647); v[2] + 1i32` 三腿静默 2147483648（push 归一只认 `__elemTy` 标签,推断容器无标签——B fuzz ntuple reassign 形态对该面结构性失明） | **同族候选（下一切片）** | 修法方向 = checker 推断类型回写/构造位打标;**fuzz 0 分歧不背书此面**(差分对此结构性失明——审查实证) |
| **#73 预存 AOT struct 相等分歧**（v0.88 审查 M2 实锤归属 HEAD）：跨构造点 struct 相等在 dist 下恒 false（poolAdd structspec 不去重 → 每 ctor 独立池条目 → 反序列化 spec.def 各自独立 → valueEquals `a.def !== b.def` 恒 false;源码三腿=1,dist=0——`ming build` 用户可踩） | **v0.88+ 候选（P1）** | 修法方向 = wire 层按结构体名合并 def 引用(单一 def 池条目)或 valueEquals struct 分支按 (def.name, fields) 判等;git worktree 45ad04e 实锤归属 HEAD |
| **fuzz harness check-valid 门**（v0.88 审查 m5）：三腿输出一致即计通过,check 失败程序三腿同诊断静默空转 | **候选（P2 小件）** | harness 加 `ming check` 门:非 0 诊断即跳过/计数;B 的后缀字面量纪律 + 120 dump 审计为现行缓解 |
| M3013 fix 窄结果位边界（v0.85 审查 m1 记录）：处方入窄上下文可能新报 M3002（精确类型面接住，非静默——v93.23 锁定） | 登记（行为边界，非缺陷） | v0.80 f-probe 口径的适用边界已写入 intWidenFix 头注 |
| coverage/bench/AI 快照复测 + capabilities 口径 + references/moltbook 审计 + N-66 | **v0.84 候选（P1）** | 纯测量/文档；为 v0.85 供数据 |
| fix 第三波 / LSP 第二切片 | **v0.85 候选（P2）** | 数据驱动；前置 = v0.84 快照 |
| 流式·Slice 簇（ADR-009） | **✅ ADR-009 已落盘（2026-11-19）；S1 v0.86 开工，S2 v0.87+，S3/S4 维持门槛** | rossum 数据在案；维护者复核位 = ADR-009 §7 |
| read_to_end 翻转 / stringify_untrusted | **下一污点微窗（P2，维护者裁决）** | 破坏性窗口制；同源纪律闭合 |
| serve TLS / C FFI ABI / 交叉编译 / asm 多架构 / 泛型缓存 / 证明扩大 / WS·UDP·keep-alive·自省 API / N-65.1 / N-60.3 / get(i) 载体 / 密码学 / e05·e24 warn 化 / 孤立代理对 / HTTP 流式 | **P3 条件驱动** | 各自门槛未满足（证据/用例/数据/设计） |
| async 语义 ADR / 流敏感污点 / 形式化 / mask 重开 / Blood 远期参考 / L2-L3 | **P4 远期** | 语义定义或研究构想先行 |
| 热重载 / 可执行内存·ROP / assume_clean / 净化器族扩张 / checker 拆分 / read_line·RegExp 抢占 / 键级混合载体 / 响应位授权 / eval 沙箱 / 本地化格式化 | **不做（维持）** | 既有否决/策略不排期 |

## 4.14 第十二轮规划：能力缺口复扫与归一弧线收尾（2026-11-19，software-architect，基线 5d4cfeb v0.89.0，1524 项全绿）

> 立场声明（沿 §4.13）：架构师裁决先行落盘，维护者事后复核；缺口逐项引用登记点；每项先满足门槛再开工；不猜测性投入。
> 本轮起点 = **§4.13 路线的实际交付与登记错位修正 + 窄型归一弧线收尾盘点**。v0.87–v0.89 三版（Slice S2 / 四边界规格树 / 同族收口）交付后，窄型归一同族仅余 Option/Result 载荷位与两处登记面；同时本会话审查与实现期**新登记了一批预存缺陷**（全部实测归属 HEAD，逐项带复现），构成 v0.90 的主体。

### 4.14.1 基线（2026-11-19 实测）

| 项 | 状态 |
|----|------|
| 版本/测试 | v0.89.0（5d4cfeb）；**1524 项全绿**（§99 18 check）；fuzz 三种子（44044/777/20261）×40 含窄型形态 0 分歧；proof_fuzz 0 误报 |
| 归一弧线 | 声明驱动（规格树 declaredSpecOf* 家族）+ 值标签驱动（bindPattern 登记/uniformNarrowSpec）+ checker 回写（narrowParamTypes/narrowRetSpec）**三通道并存**；已收口：注解 let/重赋值/传参/返回/struct ctor+字段写/Vec 标注初始化+push+元素写/Map 值位/lambda 返回位/enum payload/元组绑定/无标注 lambda 形参（narrowParamTypes 回写） |
| 归一残余 | **Option/Result 泛型载荷位**（需 {opt}/{res} 规格形状，下一缺口）/ Map 键位（no-op 文档性）/ 嵌套 struct AST 侧 / PWild 丢弃位 / **推断型静默面 M1a/M1b**（v0.88 审查登记第 6/7 项——fuzz 对该面结构性失明） |
| 观测面 | coverage/bench/AI 快照停在 v0.84 复测点——**v0.85–v0.89 五版大改（intBin 门/规格树/MAKEENUM/ADDI）后再度过时**，需周期性复测 |
| 能力矩阵 | 55 行 ≈85%（口径复核 v0.88 不变）；新增能力：Slice[u8]/read_bytes_range/M3051——矩阵行状态待复算 |
| 文档 | GUIDE §14.2 Slice 节已立（v0.87）；**窄型归一机制（三通道/规格树/值标签）无系统 GUIDE 节**——散落修订记录，文档缺口 |

### 4.14.2 缺口全景（按域，逐项引用登记点）

| 域 | 缺口 | 登记出处 | 现状/门槛 |
|----|------|---------|----------|
| 引擎一致性 | **#73 预存 AOT struct 相等分歧**：poolAdd structspec 不去重 → 跨构造点 `x == y` 在 dist 恒 false（源码三腿 = 1）——`ming build` 用户可踩 | v0.88 审查 M2（worktree 45ad04e 实锤归属 HEAD） | 无门槛；修法 = wire 层按结构体名合并 def 引用或 valueEquals 按 (def.name, fields) 判等 |
| 引擎一致性 | **tree ctor 作值分歧**：`let c = E.A; c(250)` tree M4001 vs VM 正常构造（v0.89 审查 M1，实测归属 HEAD） | v0.89 审查 M1；§4.13.7 | 无门槛；修法 = tree Call 名字解析对 ctor 值分发 constructVariant（与 VM callValue 同构）或 checker 显式拒绝 |
| panic 位置面 | **绑定归一 panic 位置列分歧**：`let y: i32 = v[2] + 1i32`（经 BIND 归一 panic）tree 4:5（Let span）vs VM 4:9（BIND PIdent span）——消息逐字、仅列差 | v0.89 审查 M2（HEAD 同可达） | 无门槛；修法 = 统一 span 口径（值表达式 span 或 let 语句 span 二选一，三腿对齐） |
| panic 消息面 | **u64 无后缀字面量溢出消息** tree `i64` vs wasm `i64u`（字面量标签域，Agent B 预存发现） | v0.89 B 报告 | 无门槛；窄型算术消息面收尾 |
| 归一同族 | **Option/Result 泛型载荷位**：`let r: Result[u8,str] = Ok(250)` 构造位无 def 类型 → 需 {opt}/{res} 规格形状 | v0.89 A 报告登记不预支 | 下一同族切片；**先给活复现**（审查 m4 纪律：登记的可达性比描述窄） |
| 归一架构 | **三通道并存**（声明规格树/值标签/checker 回写）——判定等价已实测（w5/w6/z4 逐字），但机制分散于 normBindValue/bindPattern/narrowParamTypes/__elemTy/__valTy/__spec/__retSpec 多载体 | v0.89 A 报告（设计决策）+ 审查 n1/n2 | 架构审视候选：GUIDE 系统节 + 通道分工文档化（合并属重构， ROI 另裁） |
| DX 面 | **plain 负字面量窄型上下文不收窄**（`let a: i32 = -5` → M3002——一元负号表达式逃逸上下文窄化）+ **标注元组解构 + plain 元组字面量 M3002**（元组字面量无上下文收窄）+ **`a += 10` 上下文窄化允许越界字面量**（运行时 panic 收口，静态放行） | v0.89 B 审计新发现 + 审查 n1 | DX 缺口；修复 = checker 上下文窄化扩展（负字面量/元组字面量）——语义面小、理由化清晰（上下文窄化既有机制的自然延伸） |
| Slice S2 遗留 | 六项边界注记：trait 声明签名禁面未含/lambda 形参 Slice 标注未禁/Vec[Slice] 惰性/mut 切片绑定/json.parse 特殊路径走 M3002/wasm view 具名误指 | v0.87 A 报告未尽事项 | 全部惰性面（不可构造/不可达），登记不预支； Slice 证明面接入延后（ADR-009 §2.2） |
| 观测面 | **coverage/bench/AI 快照第三次复测**：v0.85–v0.89 五版大改（intBin fits 门/规格树/MAKEENUM normSpecs/ADDI BigInt 回落/窄型绑定归一）后，coverage（95.0%→?）、vm.js 短板（76.2%→?）、bench 基线（invariant 字段遍历项已入）、AI 快照（归一后 fix 面变化）全部过时 | v0.84 复批先例（周期性：大改后复测） | 无门槛（纯测量）；**归一弧线已收口——本轮复测是弧线终点快照** |
| 文档面 | **窄型归一机制 GUIDE 系统节缺失**（三通道/规格树/值标签/边界登记散落修订记录）+ capabilities 矩阵行状态复算（Slice[u8]/read_bytes_range/M3051 新能力）+ fuzz harness check-valid 门（m5）+ stale §4.13.7 行清理 | v0.89 审查 m5/本会话登记 | 无门槛（文档批） |
| LSP | **第二切片仍 pending**（别名位 `use x as `/子目录首段 use/泛型推洞）——v0.85 裁量延后至今 | §4.13.5/plan 登记 | 数据驱动门槛维持；v0.84 AI 快照复测（未跑——被 v0.85–89 插队）后按数据裁量 |
| 大件（维持门槛） | S3 带长度 Ptr（C ABI + #55 NUL 前置）/ S4 unsafe(cond)（四门槛）/ 污点微窗 read_to_end / serve TLS / C FFI ABI / 交叉编译 / async 语义 ADR / Option·Result 之外的载体系（Untrusted[u8] 等） | ADR-009 §2.3/§6、§4.13.4 P3/P4 | 各自门槛未满足，维持登记 |
| Map 归一 perf | 窄值 Map 每次 normalize 重建（无幂等快路径——窄值 map 调用面小） | v0.89 A 报告登记 | perf 另裁（bench 数据驱动） |

### 4.14.3 耦合簇（更新）

- **簇 A（流式·Slice）**：S1/S2 已交付（v0.86/v0.87）；**S3 带长度 Ptr 与 C FFI ABI（簇 D）联动维持门槛**；S4 unsafe(cond) 四门槛维持。Slice 六项遗留边界 = 惰性面登记不预支。
- **簇 B（污点窗口）**：read_to_end 微窗维持（P2 维护者裁决）；同族第五缺口之后**不再有已知污点缺口**（Option/Result 是宽度归一域非污点域）。
- **簇 E（AI 协作面）**：fix 第三波已部分兑现（M3013 v0.85）；LSP 第二切片仍 pending——**数据前置（AI 快照复测）被 v0.85–89 插队，本轮纳入 v0.91 观测批**后按数据裁量。
- **簇 F（panic 消息/位置面）**：M4002/M4004 消息已四引擎逐字（v0.81/v0.83）；**残余 = 位置列分歧（M2）+ u64 字面量消息 + #73 AOT struct 相等**——三者同为"跨引擎合同"域，合并为 v0.90 主体。
- **簇 G（观测-文档诚实性）**：v0.84 复批后五版大改——**复测周期化**（大改后必复测）写入本轮纪律；窄型归一机制 GUIDE 系统节 = 本轮文档批主体。
- **簇 H（新）归一架构**：三通道并存的判定等价已实测；GUIDE 系统节先立（文档），**合并重构维持 defer**（ROI 无数据，v0.73 反猜测先例）。

### 4.14.4 优先级裁决（架构师立场）

**P1——无外部门槛**
1. **引擎一致性第三波**（v0.90 候选）：#73 AOT struct 相等分歧（wire def 合并或 valueEquals 判等）+ tree ctor 作值分歧（constructVariant 分发或 checker 拒绝）+ 绑定归一位置列统一 + u64 字面量溢出消息口径——四件同为"跨引擎合同"实测分歧/违约，全部预存（worktree/HEAD 实锤）。
2. **观测复测批 + 文档诚实性**（v0.91 候选，纯测量/文档）：coverage 第三次复测 + bench 基线刷新（含字段遍历项）+ AI 快照复测（归一弧线终点快照，为 LSP/fix 裁量供数据）+ **窄型归一机制 GUIDE 系统节**（三通道/规格树/值标签/边界登记）+ capabilities 行状态复算（Slice/read_bytes_range/M3051）+ stale §4.13.7 行清理 + fuzz harness check-valid 门（m5）+ references/moltbook 增量审计。

**P2——需设计/数据/前置**
3. **同族归一最后切片**（v0.91+ 候选）：Option/Result 载荷位（{opt}/{res} 规格）——**前置 = 活复现**（审查 m4 纪律：登记可达性比描述窄）；Map 键位/嵌套 struct AST 侧维持登记。
4. **LSP 第二切片**（别名位/子目录 use）：前置 = AI 快照复测数据（v0.91 产出）；保守原则不变。
5. **窄型 DX 批**：plain 负字面量窄型上下文收窄（checker 上下文窄化扩展——`let a: i32 = -5` 应合法，负字面量按目标型收窄）+ 标注元组解构 plain 字面量收窄——**语义面小但属类型系统行为变更**，需理由化 + 零校准审计；与既有上下文窄化（正字面量已收窄）同机制对称。

**P3——外部条件（维持）**：S3 带长度 Ptr（C ABI 真实用例 + #55 NUL 前置）/ S4 unsafe(cond)（四门槛）/ 污点微窗 read_to_end（维护者裁决）/ serve TLS / C FFI ABI / 交叉编译 / Map 归一 perf（bench 数据）/ LSP 泛型推洞。

**P4——远期**：async 确定性语义 ADR / 流敏感污点 / 形式化 / mask 重开三门槛。

**不做（维持）**：热重载 / 可执行内存·ROP / assume_clean / 净化器族扩张 / checker 拆分 / read_line·RegExp 抢占 / 键级混合载体 / 响应位授权 / eval 沙箱 / 本地化格式化 / **归一架构合并重构**（三通道判定等价已实测，GUIDE 文档化替代重构——v0.73 反猜测先例）。

### 4.14.5 版本路线（v0.90+；一版一主题）

> **已被 §4.15.5 取代（2026-11-19，评估驱动收口）**：v0.90 内容不变（并入 T2.1）；原 v0.91 观测并入 T4/T5；原 v0.92 LSP 第二切片 / v0.93 Option·Result 载荷位 / 窄型 DX 批转入 §4.15.7 冻结期后。

| 版本 | 主题 | 门槛/规模 |
|------|------|-----------|
| v0.90 | 引擎一致性第三波：#73 AOT struct 相等 + tree ctor 作值 + 绑定归一位置列 + u64 字面量消息 | 全部预存实测归属 HEAD；§100 矩阵测试；零新增 M 码预期 |
| v0.91 | 观测复测批 + 归一机制文档节 + stale 行清理（纯测量/文档） | 无门槛；弧线终点快照 |
| v0.92 | LSP 第二切片（数据驱动裁量；前置 = v0.91 AI 快照） | 保守原则；数据不足则如实缩项 |
| v0.93 | 同族最后切片：Option/Result 载荷位（{opt}/{res} 规格） | **前置 = 活复现**（审查 m4 纪律） |
| v0.94+ | S3/S4 维持门槛；污点微窗（维护者裁决）；条件项 | 各自门槛 |
| 随时 | fuzz harness check-valid 门（m5）/ 窄型 DX 批（P2 语义面，需理由化+窗口） | 小件随版 |

### 4.14.6 重点立项问题定义

- **v0.90 #73 AOT struct 相等**：问题 = poolAdd structspec 每构造点独立池条目 → AOT 反序列化后 spec.def 各自独立 → valueEquals `a.def !== b.def` 恒 false（跨构造点 `S{a:1} == S{a:1}` dist=0 源码=1）。前置 = 无（实锤归属 HEAD）。规模 = wire 层 def 合并（按结构体名单例）或 valueEquals struct 分支按 (name, fields) 判等（后者不动 wire，更小）。验收 = dist 跨构造点相等三腿逐字 + 既有 AOT 断言零校准。风险 = wire 格式变更（旧产物兼容——def 合并仅在序列化侧，validateArtifact 不受影响）。
- **v0.90 tree ctor 作值**：问题 = `let c = E.A; c(250)` tree M4001 vs VM 正常（checker 合法——v0.89 审查 M1 实测）。前置 = 无。规模 = interp Call 名字解析 ctor 值分发（与 VM callValue 同构，~10 行）或 checker 拒绝（M 码语义面）。验收 = 三腿一致（构造成功或统一拒绝）。风险 = 低（VM 路径已存在）。
- **v0.90 绑定归一位置列**：问题 = BIND 归一 panic tree 4:5（Let span）vs VM 4:9（PIdent span）。前置 = 无。规模 = 统一 span 口径（建议：树向 VM 对齐——值表达式 span 更精确）+ §100 三腿逐字。风险 = 无（单向收紧；既有断言若锁定旧列则理由化）。
- **v0.91 观测复测批**：问题 = v0.85–v0.89 五版大改后观测全部过时（coverage/bench/AI 快照/矩阵口径）。前置 = 无（纯测量）。规模 = coverage 插桩全量 + bench（含字段遍历项复核）+ AI 快照（归一弧线终点：fix 面在窄型归一后的形态变化——**归一让部分 M3013/M4002 形态消失，快照语料需按新语义重建**）+ 文档批。验收 = 数字全部可复现命令产出；零 src 语义改动。风险 = coverage 回落如实登记。
- **v0.92 LSP 第二切片**：问题 = 别名位/子目录 use 补全断供。前置 = v0.91 AI 快照 + LSP 需求确认。规模 = 保守切片。验收 = 既有补全零回归 + 新形态正例。风险 = 保守性失守（宁可空列表）。
- **v0.93 Option/Result 载荷位**：问题 = `let r: Result[u8,str] = Ok(250)` 构造位归一缺 {opt}/{res} 规格。前置 = **活复现**（审查 m4：`let o: Option[u8] = Some(250)` 实测 M3002 静态拒绝——plain 位不可达；后缀位标签天然存活。**活复现形态待找**——若 checker 全面拒绝则该缺口不可达，登记关闭而非实现）。规模 = {opt}/{res} 规格形状 + 构造位/绑定位归一。验收 = 三腿逐字 + 零校准。风险 = 低（同族模式复用）。
- **窄型 DX 批（plain 负字面量/元组字面量上下文收窄）**：问题 = `let a: i32 = -5` M3002（负字面量 = Unary 表达式逃逸上下文窄化）——DX 缺口（正字面量已收窄，负字面量对称缺失）。前置 = checker 上下文窄化机制扩展（负字面量按目标型取负后判定 fits）。规模 = checker 窄化判据扩展 + 测试。验收 = `let a: i32 = -5` 合法 + 越界仍拒。风险 = 中（类型系统行为变更——**需零校准审计 + 理由化**；与 v0.85 fits 门同族但方向相反：这是"放宽"不是"收紧"）；元组字面量收窄同理。

### 4.14.7 Backlog 处置表（第十二轮）

| 项 | 处置 | 理由 |
|----|------|------|
| #73 AOT struct 相等 / tree ctor 作值 / 绑定归一位置列 / u64 字面量消息 | **v0.90 候选（P1）** | 全部预存实测归属 HEAD；跨引擎合同域 |
| 观测复测批 + 归一机制 GUIDE 节 + capabilities 复算 + stale 行清理 + check-valid 门 | **v0.91 候选（P1）** | 纯测量/文档；弧线终点快照 |
| Option/Result 载荷位 | **v0.93 候选（P3→升级待活复现）** | 审查 m4：plain 位不可达，需先找活复现 |
| LSP 第二切片 | **v0.92 候选（P2）** | 前置 = v0.91 快照数据 |
| 窄型 DX 批（负字面量/元组字面量上下文收窄） | **候选（P2 语义面）** | checker 上下文窄化扩展；需零校准审计 |
| Slice 六项遗留边界 / S3 / S4 / 污点微窗 / Map perf / serve TLS / C FFI ABI / 交叉编译 / async ADR / Untrusted[u8] | **P3 条件驱动（维持）** | 各自门槛未满足 |
| async 语义 ADR / 流敏感污点 / 形式化 / mask 重开 / L2-L3 | **P4 远期（维持）** | 语义定义或研究构想先行 |
| 热重载 / 可执行内存·ROP / assume_clean / 净化器族扩张 / checker 拆分 / 抢占面 / 键级混合载体 / 响应位授权 / eval 沙箱 / 本地化 / **归一架构合并重构** | **不做（维持）** | 既有否决；归一三通道判定等价已实测，GUIDE 文档化替代重构 |

### 4.14.8 过程纪律登记（本会话教训）

1. **大文件文本手术禁令**：tests/run.mjs 曾被脚本误操作截断为 0 字节（v0.87 批，git fsck 恢复）+ heredoc 反斜杠转义三次吞掉 `\n`（v0.89 批，chr(92) 构造修复）——**登记纪律：对大文件做文本手术一律 ming tools patch 或 Write+脚本文件，禁用裸 heredoc python replace**（建议 AGENTS.md 增补）。
2. **复测周期化**：每 3–5 版或大改（归一/门禁/引擎面）后必跑 coverage/bench/AI 快照复测——v0.84 复批后五版未复测导致观测全过时（本轮纠正）。
3. **审查放行条件登记义务**：审查的"放行条件/登记要求"必须与版本提交同时落盘 plan（v0.88 批 M1a/M1b/#73 即时登记先例）。


## 4.15 第十三轮规划：评估驱动的收口任务单（2026-11-19，software-architect，基线 68c2058 v0.89.0，1524 项全绿）

> 立场声明（沿 §4.14）：架构师裁决先行落盘，维护者事后复核；每项先满足门槛再开工；不猜测性投入。
> **本轮依据《项目评估（v0.89.0）》五条优先级立单**：①核心命题对照实验 ②冻结语言面冲 1.0-rc ③真实场景试点（安全工具北星）④工程收口 ⑤性能与分发。开发姿态从"扩面"转"收口"。
> **本节取代 §4.14.5 的版本路线排序**（§4.14.6 的问题定义仍有效——v0.90 内容不变）；原 v0.92 LSP 第二切片 / v0.93 Option·Result 载荷位 / 窄型 DX 批全部转入冻结期后（§4.15.7）。
> 纪律：实测归属 HEAD 的预存缺陷（#73 等）优先于任何新语言面；**T1 未完成前不启动新增语言面任务**。

### 4.15.1 基线（2026-11-19 实测）

| 项 | 值 |
|----|----|
| 版本/提交 | v0.89.0（68c2058）；已提交门禁 **1524 项全绿**；fuzz 三种子 ×40 0 分歧；proof_fuzz 0 误报 |
| 套件现场复跑 | **未完成**：启动后 26 分钟无输出、末段 CPU 归零，人工终止——疑网络/端口类用例等待（不改变已提交门禁口径，登记 T4.1） |
| 规模 | src 23,125 行 / tests 24,888 行 / tools 2,735 行 Ming（14 个）/ docs 7,149 行 / examples 20 / 零第三方依赖 |
| 现场冒烟 | `run` hello·effects·wordcount 正常；`check --json` 正常；`cc` 对 hello/fib 拒绝（`print 插值串(C4)` / `块尾表达式(C1)`）→ T5.2 |
| 能力矩阵 | 55 行：**42 ✅ / 10 🟡 / 3 ❌**（docs/capabilities.md；§0 旧行 42/9/4 已勘误） |
| 使用数据 | usage-audit：编辑替换率 **7.4%**（380 次宿主调用中 10 次 `ming tools`，2026-11-12 快照）；AI-loop 快照为构造语料且自我声明"不代表真实修复率"→ T1 |
| 社区 | GitHub 公开；台账 2026-11-11 实测 **0 star / 0 fork**，此后无增长证据→ T3 |
| 版本节奏 | 本仓库 11 天 129 次提交、v0.23→v0.89——高速迭代已到"收口"临界点 |

### 4.15.2 任务总览

| ID | 任务 | 优先级 | 前置 | 归属 | 验收（一句话） |
|----|------|--------|------|------|----------------|
| T1.1 | 对照实验设计（预注册） | P1 | 无 | 独立文档批 | 任务集/指标/判据在数据采集前入库 |
| T1.2 | 对照实验执行与采集 | P1 | T1.1 | 独立文档批 | 原始数据可复跑 + 环境指纹 |
| T1.3 | 对照实验报告（三态结论） | P1 | T1.2 | 独立文档批 | 报告入库（含反例与局限） |
| T2.1 | v0.90 引擎一致性第三波 | P1 | 无（预存实测） | v0.90 | 四腿逐字 + 零校准 + fuzz 绿 |
| T2.2 | 语言面冻结令（维护者确认生效） | P1 | 维护者确认 | 即时（AGENTS+plan） | 硬规则落盘 |
| T2.3 | 稳定性契约草案 | P1 | T2.2 | v0.93 | docs/stability.md 评审通过 |
| T2.4 | 1.0-rc 准入清单 | P1 | T2.1/T2.3/T4 | v0.93 | checklist 全绿 |
| T3.1 | 场景选型（3–5 个） | P2 | T2.3 承诺面 | 独立批 | 场景规格 + 黑盒验收测试 |
| T3.2 | 场景实现与文档 | P2 | T3.1 | 独立批 | 端到端可跑 + gap log |
| T3.3 | 无先验用户视角验收 | P2 | T3.2 | 独立批 | 仅按文档跑通（另一 agent） |
| T4.1 | 测试套件超时/隔离 | P1 | 挂起最小复现 | v0.91 | 复现修复 + 全量限时 |
| T4.2 | checker.js 拆分 | P3 | 1.0-rc 后 | §4.15.7 | 快照 0 差异 |
| T4.3 | 支持矩阵 + CI 抽查 | P2 | 无 | v0.91 | 矩阵与探针 100% 一致 |
| T4.4 | 文档数字漂移防护 | P2 | 无 | v0.91 | 人为改错数字 → CI 红 |
| T5.1 | 基准对比（诚实发布） | P2 | 无 | v0.92 | 可复跑报告（含输的项） |
| T5.2 | C 后端 I/O 面（hello 级完整） | P2 | 无 | v0.92 | hello/fib/wordcount `cc` 通过 |
| T5.3 | 分发故事评估 | P3 | T5.2 | §4.15.7 | 决策记录（做/不做 + 数据） |

### 4.15.3 P1 任务定义

**T1.1 对照实验设计（预注册）**
- 目的：把北星核心论点"AI 用 Ming 更少写错"从主张变成可复核数据。
- 任务集：12–16 个，三类各 4–5：A. CLI 文本/文件处理（日志清洗、批量改名、CSV→JSON）；B. JSON/HTTP 数据处理（fetch→解析→汇总、serve handler）；C. 并发/资源门禁（spawn 汇总、超时/配额）。
- 每任务：规格（输入/输出/错误行为）+ 黑盒验收测试 + 固定提示模板（只换语言约束，任务描述与验收不变）。
- 对照组：TypeScript（Node 24 + tsc）与 Python 3.12；同模型、同温度、同 token 预算、同轮数上限。
- 指标（预注册，采集后不得增删）：①首次通过率（一次生成即过验收）②缺陷数（编译/测试失败计，按任务归一）③修复轮次 ④token 消耗 ⑤墙钟。
- 判据：相对差 >20% 记为"显著"；不做 p 值宣称；样本不足写"不确定"。
- 产出：`docs/experiment-design.md`（预注册表）+ `tests/experiment/tasks/` 语料入库。
- 风险：任务作者与执行者同源（构造偏差）——执行由另一 agent/会话完成；模型版本/日期全程记录。

**T1.2 执行与采集**
- 每任务 × 语言 × 3 次重复；`tests/experiment/run.mjs`（零依赖）驱动 CLI 并采集；Ming 侧记录 `--json` 诊断与 fix 应用结果，TS/Py 侧记录 tsc/pytest 输出。
- 原始数据 JSONL 入库（`tests/experiment/results/`）；环境指纹（OS/Node/Python/模型版本）。
- 验收：从零复跑同一命令产出同一汇总表（确定性部分）；噪声来源（网络/模型采样）标注。

**T1.3 对照实验报告**
- 结论三态：支持 / 不支持 / 不确定——**不支持必须发布**；每条反例逐条分析。
- 报告含方法、原始数据链接、局限（单机/单模型/小样本/任务构造偏差）；禁止外推。
- 验收：独立评估人复核可复跑；方法与 ai-loop-snapshot 同纪律（预注册 + 应用探针 + 诚实边界）。

**T2.1 v0.90 引擎一致性第三波**（内容沿用 §4.14.6，不重复立项）
- #73 AOT struct 相等 / tree ctor 作值 / 绑定归一位置列 / u64 字面量消息。
- 验收：§100 矩阵四腿逐字；既有断言零校准；fuzz 三种子 ×40 0 分歧；每项附最小复现。

**T2.2 语言面冻结令（维护者确认后生效）**
- 冻结范围：语法/关键字/类型面/效果名/诊断码族/内置函数——冻结期不新增。
- 允许：P0 安全缺陷修复；T1/T3 暴露的 DX 缺陷（不扩大语义面，需理由化 + 零校准审计）；1.0 文档。
- 落盘：AGENTS.md 硬规则新增一条；plan §4.15.2 为单一事实来源；提交说明必须标注"冻结期 P0/DX/文档"。
- 未确认前按"默认冻结"执行（新面不进版本）。
- 风险：压住已登记的 LSP 第二切片/Option·Result——换取 1.0 稳定承诺；维护者裁决。

**T2.3 稳定性契约草案（docs/stability.md）**
- 承诺面（1.0 起）：语法与类型规则；效果系统语义；内置签名与 `with` 传播；诊断码不改号（消息可改须登记）；CLI 旗标与 `--json` schema；AOT 产物 wire（format/version）；值语义/确定性/panic 首行合同。
- 非承诺面：性能数字；wasm 资格覆盖面（strict 可见即可）；C 后端支持子集（具名拒绝即可）；LSP 能力面；非 panic 消息措辞。
- 流程：弃用警告 ≥1 个 minor → 移除；安全修复例外。
- 验收：与能力矩阵/§4.15.7 交叉核对；维护者复核。

**T2.4 1.0-rc 准入清单（全绿才打 rc 标）**
- [ ] §5.1 已知缺陷无"未处置"项（修复或具名降级为文档限制）
- [ ] fuzz 三种子连续 3 次 ×40 0 分歧；proof_fuzz 0 误报
- [ ] CI 矩阵（三 OS × Node 18/20/22）在 rc 分支绿
- [ ] T4.1 生效：全量套件 ≤10 分钟，任何用例超时即失败
- [ ] T3 场景 ≥3 个端到端通过（无先验用户视角）
- [ ] T1 报告已发布（结论不限）
- [ ] 英文 GUIDE 关键章节（语法/效果/诊断/工具链）或完整英文 quickstart
- [ ] 版本三处 + README/plan/GUIDE 数字一致（T4.4 校验器绿）
- 打标：v1.0.0-rc.1；Release 仍由维护者手动创建。

### 4.15.4 P2/P3 任务定义

**T3 场景试点（安全工具北星；3–5 个）**
1. 日志/取证流水线：读日志→Untrusted 标注→正则/JSON 解析→结构化报告；验收含恶意输入（路径穿越/控制符/超大行）拒绝。
2. 协议解析器：二进制帧（显式字节序/校验和/边界检查）；`read_bytes_range` 分段；任意输入不 panic（Err 化）。
3. 内网 agent 工具服务：serve v1 + JSON 载荷 + 超时/资源门禁；验收含坏请求/超大 body/并发压力。
4. 文件完整性工具：HMAC/AES-GCM 校验 + 目录批量扫描；确定性输出 + 篡改检测。
5. （可选）发布打包自举：用 `ming tools` 完成一次真实 release 打包。
- 每场景：`examples/<name>/` + 测试 + GUIDE 节 + `docs/gap-log.md` 条目；冻结期只修 P0/DX，新语言面进 §4.15.7。
- T3.3 验收：另一 agent 仅按文档从零跑通；失败计文档缺陷（修文档或登记 gap），不计语言缺陷。

**T4.1 测试套件超时与隔离**
- 先最小复现本次挂起（26 分钟无输出、CPU 归零）；定位网络/端口/子进程泄漏。
- 机制：每 check 超时（默认 60s；网络类 120s）；`--timeout` 旗标；子进程 kill 树；随机端口；重试上限 1 并在报告标注；每节耗时打印；挂起=失败退出。
- 验收：复现用例修复；全量 <10 分钟；连续 3 次绿；注入 `sleep` 用例证明超时机制生效（慢机可用环境变量调阈值）。

**T4.3 支持矩阵**
- `docs/support-matrix.md`：语言形态 × tree / VM / wasm / C / AOT 五列；wasm 资格（`analyze()` 单一事实来源）、C1–C5、strict 三态、具名拒绝原因。
- `tests/support_matrix/` 每格一个探针（成功或具名拒绝）；矩阵变更必须同步探针。
- 验收：矩阵与探针 100% 一致；CI 接入。

**T4.4 文档数字漂移防护**
- `tests/docs_check.mjs`（零依赖）校验：package.json/bin VERSION 一致；README 状态表测试数；coverage-baseline 最新行；`tools/*.ming` 计数；能力矩阵 42/10/3。
- 文档数字以脚本输出为唯一事实来源；CI 增加一步。
- 验收：人为改错一个数字 → CI 红；修复后绿。

**T5.1 基准对比（诚实发布）**
- 任务：fib(24)、1M 循环、100k HOF、20k 词频、10MB JSON 解析、1k 文件扫描、CLI/AOT 缓存启动时间。
- 对照：Node 24（JS/TS）、Python 3.12、C（gcc -O2）同机；Ming tree/VM/C 三腿；记录内存。
- 产出：`docs/bench-vs-baselines.md`（方法 + 原始数据 + 局限；含 Ming 输的项，禁外推）。
- 验收：同一命令可复跑；数据与 tests/bench.mjs 口径交叉核对。

**T5.2 C 后端 I/O 面**
- 目标：`print` 插值（str/i64/f64/bool 段）与块尾表达式（语句位）放行——hello/fib 示例 `ming cc` 通过。
- 纪律：四引擎输出逐字（cc vs tree/VM）；不支持形态继续具名拒绝；不扩大 unsafe/asm 面。
- 验收：hello/fib/wordcount `cc` 通过；新增 §103 矩阵；C 指纹若变须理由化重校准（先例 v0.81/v0.83）。

**T5.3 分发故事评估**
- 对比 `ming cc --static` 三平台可行性、二进制大小、启动时间；AOT dist 目录模式；形成决策记录（做/不做 + 数据）。
- 约束：交叉编译维持 P3 门槛；零第三方依赖不变。

### 4.15.5 版本路线（取代 §4.14.5）

| 版本 | 主题 | 任务 | 门槛 |
|------|------|------|------|
| v0.90 | 引擎一致性第三波 | T2.1 | 无（全部预存实测归属 HEAD） ✅ 已交付（2026-11-19） |
| v0.91 | 套件可靠性 + 支持矩阵 + 文档校验 | T4.1 / T4.3 / T4.4 | ✅ 已交付（2026-11-20）：挂起未复现如实记录，机制先行；bench 复测并入 T5.1;coverage 插桩复测已于 v0.96 批次完成(95.1%/90.9%,docs/coverage-baseline.md 快照) |
| v0.92 | C 后端 I/O 面 + 基准对比 | T5.2 / T5.1 | ✅ T5.2 已交付（2026-11-20） |
| v0.93 | T5.1 跨语言基准对比 | T5.1 | ✅ 已交付（2026-11-20，docs/bench-vs-baselines.md；Python 3.10.11 vs plan 3.12 偏差如实；审查 APPROVE-with-minor 修复后通过） |
| v0.94 | O1 字节码优化首批（折叠/裁剪/线程/DCE） | §4.16-O1a | ✅ 已交付（2026-11-20）：审查 B1/M1 修复后通过；opt_gate 187；1566 项 |
| v0.95 | O1 后续 pass：通用窥孔（逐 pass 独立提交） | §4.16-O1b | ✅ 已交付（2026-11-20）：peepholePass（POP 消除/全字面量 CONCAT）；四候选登记不做；§105 9 check；opt_gate 291 |
| v0.96 | O1 后续 pass：常量传播（逐 pass 独立提交） | §4.16-O1c | ✅ 已交付（2026-11-20）：constPropPass（标量+str；六放弃锚；§106 11 check；opt_gate 374）——**O1 四 pass 全部交付** |
| v0.97 | P1 #79/#81 修复（VM builtin 方法实参拷贝/闭包 vclose 深拷贝）+ O2.1 拷贝消除设计预研（ADR-010/调研） | 审查驱动 | ✅ 已交付（2026-11-20，1595→1603 项；审查 REQUEST_CHANGES→APPROVE-with-minor 两轮；#80/#82 登记） |
| v0.98 | ADR-011 P0 分析单源化（frenames→freenames 文档面归一 + §109 环境跳过） | ADR-011 P0 | ✅ 已交付（2026-11-20，1612 项；字节码等价 10/10；M1 禁令合规 sha256） |
| v0.99 | ADR-011 P1 创建点过滤（captureEnvFor） | ADR-011 P1 | ✅ 已交付（2026-11-21，1627 项/§110 15 check；92/92 零漂移；G2 创建侧门槛全达成；分歧锚仍红设计预期，P2 翻绿） |
| 待定 | 稳定性契约 + 1.0-rc 准入 + 英文关键章节（前置 = T2.2 冻结令维护者确认） | T2.3 / T2.4 | 待维护者裁决 |
| 独立并行（不绑版本） | 基准对比 T5.1 / 对照实验 / 场景试点 / 编译器级优化 O0 | T5.1（✅ v0.93）/ T1.* / T3.* / §4.16-O0 | T1.1 预注册；T3 以 T2.3 承诺面为准；O0 不改语义 |
| 冻结期后 | LSP / Option·Result / 窄型 DX / checker 拆分 / S3·S4 等 | §4.15.7 | 各自前置 |

### 4.15.6 判据与不预支

1. **实验优先**：T1 未完成前，不启动任何新增语言面任务。
2. **冻结默认**：T2.2 维护者确认前按默认冻结执行；新面一律进 §4.15.7。
3. **1.0-rc 不设日期**：checklist 全绿才打标；不为赶版本放宽。
4. **场景不扩面**：T3 暴露的新语言面只登记不实现（P0 除外）。
5. **数字口径统一**：能力矩阵 42✅/10🟡/3❌（本版复核）；§0 旧行已勘误；后续由 T4.4 校验器锁定。

### 4.15.7 冻结期后候选（原 §4.14 v0.92/v0.93 转入 + P4）

| 项 | 原归属 | 前置 |
|----|--------|------|
| LSP 第二切片（别名位/子目录 use） | §4.14 v0.92 | 1.0-rc 后 + AI 快照数据 |
| Option/Result 泛型载荷位归一 | §4.14 v0.93 | 1.0-rc 后 + 活复现 |
| 窄型 DX 批（负字面量/元组字面量上下文收窄） | §4.14 P2 | 1.0-rc 后 + 零校准审计 |
| checker.js 拆分（T4.2） | 本节 | 1.0-rc 后；快照对照先行 |
| Slice 六项遗留边界 / S3 带长度 Ptr / S4 unsafe(cond) | ADR-009 | 各自门槛（C ABI + #55 / 四门槛） |
| 污点微窗 read_to_end / serve TLS / C FFI ABI / 交叉编译 / async 语义 ADR / Map perf | §4.14 P3/P4 | 维持门槛 |

### 4.15.8 过程纪律（沿 §4.14.8，新增三条）

4. **实验预注册**：T1 指标与判据必须在数据采集前落盘，事后不得增删；报告必须包含反例与"不确定"选项。
5. **评估驱动**：任何新任务必须写明服务于 T1–T6 哪条优先级，否则不进版本。
6. **超时纪律**：新增测试声明超时预算；网络类用例随机端口 + 失败上限；挂起即失败。
7. **heredoc 禁令第三次触发的收紧（2026-11-20，v0.90 批）**：含反斜杠转义（`
` 等）的脚本一律 Write 工具落盘执行，heredoc python 连修复脚本自身都会被 shell 层坍缩（本轮 §100 插入与修复连中三次，Node 落盘版一次通过）——大文件文本手术首选 `ming tools patch` 或 Node 落盘脚本。


## 4.16 编译器级优化程序（T6 轨道；2026-11-19，software-architect）

> 维护者方向（2026-11-19）：**先做"对本项目生成程序的优化"，再谈自举编译器实现**。本节据此立项 T6；自举编译器维持门控（§4.16.6 G1–G6）。
> 定位：优化不是新语言面（不违反 §4.15 冻结令），但它改 codegen——必须过"零校准 + 四引擎 + 确定性"同一套纪律。
> 原则：**先测量后优化**；每一趟（pass）默认开启且可 `--no-opt` 关闭；任何 pass 不得改变可观测行为（值 / panic / 消息 / 位置 / 求值顺序 / 确定性）。

### 4.16.1 现状盘点（v0.89.0 实测）

| 项 | 现状 | 机会 |
|----|------|------|
| 字节码融合 | 仅 ADDI / BINSETI / BINSET2（v0.9 窥孔） | 通用窥孔与超指令空间大 |
| 常量折叠 | 无（编译期仅模级 const 求值走树引擎） | 局部纯表达式折叠 |
| 死代码消除 | 无（语句级按语法发射） | return/break 后不可达、常量分支 |
| 拷贝消除 | **无**：ST/SET/BIND/实参/集合构造一律 deepCopy | 值语义是特色也是成本——fresh 值可免拷贝 |
| VM 分派 | 单 switch 循环；CALLMETHOD 线性分派（stdmod/typeobj→方法查找） | 内联缓存 / 分派表 |
| C 后端 | 依赖 gcc -O2；deepCopy 走 ming_vec_copy / ming_map_copy | fresh 值免拷贝、发射细节 |
| wasm | 引擎自行优化；资格分析在 wasm.js | 维持现状（不动） |
| bench | 5 项 + invariant 两形态（v0.83 基线） | 缺拷贝 / 方法分派 / 字符串构造专项 |

### 4.16.2 观测与闸门（O0；可立即启动，不改语义）

- **O0.1 统计面**：`--stats` / `MING_STATS=1` 输出每函数：字节码指令数、执行步数（复用 steps 计数）、deepCopy 次数、分配次数、CONCAT 次数、CALLMETHOD 次数；JSON 形态供 bench 采集。
- **O0.2 bench 扩面**：新增 5 项——①Vec/struct 拷贝密集循环 ②Map 更新循环 ③方法调用密集 HOF ④字符串构造循环 ⑤闭包调用循环；每项 tree/VM/C 三腿 + 内存。
- **O0.3 闸门脚本**：`tests/opt_gate.mjs`——每个 bench 项跑 opt on/off × tree/VM/C，断言输出逐字一致；全量套件 + fuzz 三种子 ×40 + proof_fuzz 纳入同一命令。
- 验收：统计与基线数据入库（`docs/opt-baseline.md`）；闸门一键可跑；零语义改动。

### 4.16.3 优化阶梯（按风险从低到高）

**O1 局部无风险（纯编译期，默认开）**
1. 常量折叠：纯运算且**不溢出**才折叠；溢出 / 除零 / 取模零保留运行时 panic（位置与消息不变）；f64 按 IEEE，只折叠确定形态。
2. 常量分支裁剪 + 跳转线程：折叠后的常量条件只发射存活分支；JUMP 链归一。
3. 死代码消除：return / break / continue / panic 之后到块尾的不可达语句不发射（静态诊断仍由 checker 负责，不受影响）。
4. 通用窥孔：冗余 `LD+ST` 消除、语句值 `POP` 消除、`DUP+ST` 折叠、相邻 CONCAT 字面量合并、`!` 与 JUMP 反转。
5. 常量传播（保守）：不可变 `let` 的常量值替换 `LD`；有 mut / 捕获 / 重赋值即放弃。

**O2 拷贝消除（高价值，需保守证明）**
6. fresh 值 ST/SET 免拷贝：构造器 / 字面量结果直接入槽（临时值不可观测——值语义不变）。
7. 不可变 let 读取免拷贝：证明无 mut 别名、无捕获逃逸后按值共享。
8. 实参 fresh 临时免拷贝：同 6 的调用点版本（含 mut 形参的"最后使用"判定）。
- 机制：编译器内建 freshness 格（fresh / borrowed / shared）+ 每形态单测；任何不确定 → 保留拷贝。
- 验收：opt on/off 输出逐字、panic 位置不变；拷贝计数（O0.1）显著下降；四引擎一致。

**O3 VM 执行器**
9. 超指令扩展：`LD/const + BIN + ST` 组合、INDEX 快路径；指令数以 O0.1 度量。
10. CALLMETHOD 内联缓存：按（接收者类别/形态, 方法名）单态缓存，慢路径回退。
11. 分派表：仅当 O0 数据显示 switch 分派占比显著才做；steps 计数口径不变。

**O4 C 后端**
12. 与 O2 同源的 fresh 值免拷贝（省略 ming_vec_copy / ming_map_copy）；`--emit-c` 快照对照。
13. 发射细节与 `-O3` 实测对比（默认保持 -O2，除非数据支持）。

**O5 高级（默认 off，仅数据支持 + 单独评审）**
14. 循环不变量外提：仅限无 panic 风险的纯表达式。
15. 强度削减：仅当溢出 / 移位语义可证一致；否则不做。
16. 小函数内联：**默认否决**（会改变 panic 调用栈首行——与四引擎逐字合同冲突）；如要做必须单独 ADR。

### 4.16.4 风险登记

| 风险 | 约束 |
|------|------|
| 溢出 / 除零 panic 语义 | 折叠 / 削减不得改变 panic 存在性、位置、消息；溢出常量保留运行时路径 |
| 求值顺序 / 效果 | 任何 pass 不得重排含效果调用；短路语义保持 |
| 值语义 | 拷贝消除必须有 fresh / borrowed 证明；不确定即拷贝 |
| panic 调用栈 | 内联 / 尾调用类变换默认否决（首行合同） |
| AOT wire | 新指令尾部追加 + format 版本兼容；旧产物可读；validateArtifact 界检查同步 |
| wasm 资格 | 新指令在 analyze() 中显式处理或具名排除；strict 三态不变 |
| 确定性 | pass 遍历顺序固定；不得依赖哈希序 |

### 4.16.5 版本与容量

- **O0 立即启动**（纯观测，不占语义面；可与 v0.90 并行）。**✅ 已交付（2026-11-20）**：O0.1 统计面/O0.2 bench 扩 5 项/O0.3 opt_gate 骨架 + opt-baseline.md（O2 靶点实证）。
- **O1**：v0.94 候选（v0.91 收口后若有余量可提前并入 v0.92 小批）；全部 pass 默认开 + `--no-opt` 可关。**✅ O1b（通用窥孔）已于 v0.95.0 交付；✅ O1c（常量传播）已于 v0.96.0 交付——O1 四 pass（折叠/分支裁剪+DCE/窥孔/常量传播）全部完成。** 后续优化线候选 = O2 拷贝消除（O0 实证最大热点：deepCopy 270 万次/10 万迭代）。**✅ 首批（折叠/裁剪/线程/DCE）已于 v0.94.0 交付（2026-11-20，审查 B1/M1 修复后通过，opt_gate 187 断言）；后续 pass 通用窥孔=O1b / 常量传播=O1c（逐 pass 独立提交）。**
- **O2**：v0.95 候选——**O1b 已于 v0.95.0 交付（窥孔），O2 后移至 O1c 之后（v0.96+）**；依赖 O1 的 freshness 基础设施；拷贝计数占比决定优先级。
- **O3 / O4**：O0 数据显示分派 / 拷贝为热点才排期；否则如实登记"未达门槛"。
- **O5**：默认不做；需要时单独 ADR。
- 与 §4.15 的关系：T6 不改变语言面、不阻塞 T1/T2；但**不得挤占 1.0-rc 关键路径**（T2.3 / T2.4 / T4.1）；排期冲突时 1.0-rc 优先。
- **节奏（维护者 2026-11-19）**：渐进交付、不设期限——O0 拆三小步（O0.1 统计面 → O0.2 bench 扩面 → O0.3 闸门），O1 按 pass 逐个提交（常量折叠 / 分支裁剪+DCE / 通用窥孔 / 常量传播各自独立）；每步独立可停，发现语义风险立即停并登记，不追求整批完成。
- **O1 提交单元裁决（架构师 2026-11-20，事后登记）**：**v0.94.0 将前三 pass「常量折叠 + 分支裁剪/跳转线程 + DCE」合并为单一提交单元**——理由：三者同处 `src/opt.js` 单一管线且存在 fixpoint 顺序耦合（fold→prune→dce，prune 消费折叠产物、dce 消费剪枝后的可达性），并共用同一 `rebuild`/span 维护基础设施；逐 pass 拆分将产生**不可独立编译/不可独立验证的中间态**（单独 fold 后 prune 未接、单独 dce 无剪枝输入），违背"拆分须各自可独立提交"的初衷。**通用窥孔（v0.95.0）与常量传播（v0.96.0）各自独立提交**——两者可独立实现、独立门禁（opt_gate 分节 O1b/O1c 各自断言）。本裁决为对「逐 pass 逐个提交」节奏的**有理由例外登记**，非静默偏离。
- **ADR-011 P0 已交付（2026-11-20，v0.98.0）**：分析单源化——collectFreeNames/collectLambdaLocals/addPatNames → src/freenames.js 叶模块（零行为变化；字节码 10 程序×两态逐字节等价；M1 禁令合规 sha256 机械证明——collectLambdaLocals 死代码承重勿修；bin dist runtime 清单补登记；§109 9 check 含 rv1 过近似锁定与死代码承重锚；独立验证 P0-B PASS 差异清单零）。P1 创建点过滤/P2 复制点过滤（#82 翻绿）待续。

### 4.16.6 自举编译器（维持门控）

- **G1** 1.0-rc 达成；**G2** T1 报告发布；**G3** T5.1 基准数据在手；**G4** T5.2 + T4.3 完成；**G5** 自举 ADR（bootstrap 策略 + AST/诊断/字节码差分验收）；**G6** T6 的 O0+O1 数据在手（优化基础设施 = 未来编译器的 pass 框架）。
- Phase 0（仅设计文档：架构 ADR + IR/ABI 草案）可在 G1 前做；Phase 1–4（自举前端 → checker → 字节码编译器 → 优化）在 G1–G6 全绿后启动。
- 明确不做：引入 LLVM（零依赖约束）/ 交叉编译（维持 P3 门槛）/ 用自举编译器替换 JS 工具链（先只做 dogfood 对照）。


## 5.1 已知缺陷(2026-11-11 code-review + 2026-11-13 三方评估 + 2026-11-14 第三/四轮,已逐项复核)

> 来源:两个 code-reviewer 子智能体 + 主会话复现 + 2026-11-13 三方评估/安全审计。**状态:v0.50.1–v0.59.0 的已修复项逐行标注;#47/#51–#54 已于 v0.60.0 收口(资源门禁一致性:参数搬运计费/外部输入计费/--max-ms 钳制/test 旗标传播/tree 契约重入);#55–#57(P2)Backlog/随 v0.61。**`已验证` = 有可复现命令/输出;`源码确认` = 代码路径明确但未跑运行期。

### 已修复(v0.50.1–v0.51.6)

| # | 缺陷 | 严重度 | 修复版本 |
|---|------|--------|---------|
| 0 | wasm 比较操作码错误 + --no-wasm 选错引擎 | P0 | v0.50.1 |
| 1 | 函数值丢失效果集(绕过 M3029) | P0 | v0.51.0 |
| 2 | 契约内 mut 方法修改参数 | P1 | v0.51.1(M3043) |
| 3 | ensures 漏 ? 早退 / 树引擎嵌套 return | P1 | v0.51.1 |
| 4 | 容器访问器返回内部引用 | P1 | v0.51.4(deepCopy) |
| 5 | match 元组嵌套模式穷尽性漏检 | P1 | v0.51.4 |
| 6 | while let 被 M3028 拒绝 | P1 | v0.51.4 |
| 7 | 泛型 bound arity 的 ReferenceError | P1 | v0.51.4 |
| 8 | Map 非原始键通过检查 | P1 | v0.51.4(M3044) |
| 9 | C f64 ≥9.22e17 UB/错值 | P1 | v0.51.3 |
| 10 | C 有符号窄截断 UB | P1 | v0.51.3(ming_sext) |
| 11 | C str 空模式/pad/ZWSP 偏差 | P1 | v0.51.3 |
| 12 | AOT sig 内嵌 AST/绝对路径 | P1 | v0.51.2 |
| 13 | build 回退只拷入口 | P1 | v0.51.2 |
| 14 | 缓存命中不校验 dist | P1 | v0.51.2 |
| 15 | 接口哈希漏 enum payload/bounds/typeArgs | P2 | v0.51.2 |
| 16 | CLI 项目参数 / -o / 值旗标 | P2 | v0.51.5 |
| 17 | VM 复合赋值窥孔:`x += N`(N≠1)误融 ±1(自举工具 diaghot 暴露;模糊器不生成 `+=`) | P0 | v0.51.6 |
| 18 | fmt if 表达式崩溃(blockInline 收到裸块) | P1 | v0.51.6 |
| 19 | fmt else-if 悬挂 `} else ` 且非幂等 | P1 | v0.51.6 |

### 新登记(2026-11-12,tools 优化会话)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 20 | fmt 注释瀑布:部分文件需 `fmt --write` 两遍到定点(注释占行后 preserveBlank 按源行距二次判定) | P2 | 已修(v0.51.6 后续提交):preserveBlank 向前看待冲刷独立行注释,常规语句前注释一遍到定点、规范形态零漂移;残余形态见 #22;§55 补 3 项回归 |
| 21 | 模糊器表达式语法不生成 `+=`/`-=` 复合赋值(#17 因此漏网) | P2 | 已修(提交 eefac3a):genStmt 补 compound 臂 + while 内复合形态,五种子 0 分歧 |
| 22 | fmt 残余瀑布形态:`} else { // 注释`(else 头行尾注释)等仍需两遍到定点(else 头 `{` 源行号在两遍间漂移,在 preserveBlank 触达之外) | P3 | **已修(v0.56.0)**:else/else-if 头行尾注释一遍到定点(空行在注释前,二次 fmt 零输出;无头注释规范形态零漂移;§60 v60.33) |

### 新登记(2026-11-12,v0.53.0 独立审查;v0.56.0 已全部修复)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 23 | **tree 引擎 for-in 循环变量遮蔽泄漏**:`let i = 100; for i in 0..3 {}; return i` 类形态 tree 返回循环变量末值而非外层 100(实测 tree 2 / VM 100;审查报告样例 tree 5 / VM 103),违反"三引擎一致"硬规则。**同根因**:C 后端区间 for-in 遮蔽时此前发射非法 C(`v_i_2` 未声明),已随本版 B3 修复(容器/区间 for-in 循环变量落入内层作用域);tree 语义待统一 | P1 | **已修(v0.56.0)**:tree 作用域模型统一——块级子环境 + for-in/while-let 每迭代内层绑定,循环结束恢复外层;三引擎逐字一致(§60 v60.1/v60.2 等) |
| 24 | **VM 捕获闭包传入 `v.map` 触发 TypeError**(`Cannot read properties of null`);tree 正常;HEAD 可复现 | P1 | **已修(v0.56.0)**:`vm.js` `callClosure` 补传 `captures`(一行修复);捕获/非捕获/多层闭包 HOF 三引擎一致(§60 v60.10–v60.12) |
| 25 | **fuzz 生成的 main 恒带 io、wasm 腿从不真实执行**——差分实际只覆盖 VM 回落路径;建议生成纯 helper 由 main 调用,让 wasm 腿真正落地 | P2 | **已修(v0.56.0)**:生成器新增 eligible helper 族,wasm 腿断言 `MING_WASM_DEBUG=1` 下 `[wasm] fn OK` 且无回落,汇总"wasm 真实执行 N"(三种子 20/16/18;§60 v60.23) |
| 26 | **buildKey 不含编译器 `src/*.js`**,仅靠 VERSION 区分——编译器改动而版本号未变时可能脏命中(设计现状,记录在案) | P3 | **已修(v0.56.0 + 审查 B2)**:键加入 `compilerSourceHash`(**src/*.js + bin/*.js** 排序内容 sha256——只含 src 时改 bin/ming.js 仍脏命中),`build --json` additive `compiler_hash`;敏感性回归覆盖 src 与 bin 单独改动/恢复(§60 v60.21/v60.22/v60.22b) |

### 新登记(2026-11-12,v0.54 收口)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 27 | **std 模块别名在字节码编译器解析失败**:`use std.math;` 后写 `math.sqrt(9.0)`(GUIDE §16 声明支持的别名形态)——`ming check` 0 诊断(检查器解析别名),但 `ming run` 在编译期抛 `Error: 编译错误:名字未解析 math` + Node 栈,退出码 1;`run --tree` 正常输出 `3.0`。与 v0.54 C5 无关,实测存在。**最小复现**:`use std.math;` + `fn main() with io { print(str(math.sqrt(9.0))); }` → `check` exit 0,`run` exit 1(`名字未解析 math`),`run --tree` exit 0 输出 `3.0`。根因方向:`src/compiler.js` 的 `compileNamedValue/compileIdentValue` 未把 `use` 导入的 std 模块短名注册为模块别名(全限定 `std.math.sqrt` 正常) | P1 | 已修(v0.54.0 独立审查 B5):`compileNamedValue` 读 `mod.imports` 的 `{std}` 绑定 → `__stdmod:<真实模块名>`;别名 `use std.x as y` 同样生效;编译器未解析名改为 `CompileError` + `file:line:col` 诊断(cc/build/run 不再裸栈);§58 v58.20 锁定 |

### 新登记(2026-11-12,v0.54.0 独立审查;v0.56.0 已全部修复)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 28 | **tree 引擎块作用域泄漏(if/unsafe 块)**:`let x = 1; if c { let x = 2; }` / `unsafe { let x = 2; }` 之后,块外读到的仍是块内的新值(实测 `let x=1; unsafe { let x=2; print } print` → tree `2/2`,VM `2/1`;HEAD 可复现)——树引擎 execBlock 复用外层 env,块级 let 覆盖了外层绑定;违反"三引擎一致"硬规则。与 #23(for-in 遮蔽泄漏)同属 tree 作用域根因,待统一修复 | P1 | **已修(v0.56.0)**:与 #23 同根因一次修复(execBlock 子环境);if/while/for/loop/match arm/unsafe/sync 块遮蔽不再外泄(§60 v60.3–v60.9) |
| 29 | **launcher 源码模式 panic 仅裸码无位置**:`dist/ming-app.mjs` 在无 `app.bytecode.json`(源码回退模式)下 panic 时只打印 `M4xxx: 消息`,不含 `file:line:col` 与源码摘录;而直接 `ming run` 的 panic 首行带位置。诊断信息在回退产物中退化 | P3 | **已修(v0.56.0)**:源码回退 launcher panic 带 `file:line:col` + 源码摘录;AOT 字节码模式输出逐字不变(§60 v60.34) |
| 30 | **extern fn 值存局部变量后 C 后端不支持调用**:`let q = f; q(...)`(f 为 extern fn)在 C 后端 let 推导为 null,发射期拒绝/无法调用;直接 `f(...)` 正常。与 v0.54 无关,既有面 | P2 | **已修(v0.56.0)**:选方案 (b)——C 后端发射期明确诊断(不再"let 推导 null");VM 诚实 M4001(§60 v60.35) |

### 新登记(2026-11-12,v0.55.0 独立审查;v0.56.0 已修 #31/#32)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 31 | **多入口共享模块时 `--proof-report` 摘要行/JSON 重复**:同一模块被多个入口加载时,摘要按入口各输出一份(per-entry 语义;文本行重复、JSON `summaries` 数组重复)。仅影响报告可读性,不影响证明结论/诊断;应按绝对路径去重 | P3 | **已修(v0.56.0 + 审查 B1)**:proof/summary 记录携带 `abs`,按 `abs + fn` 去重(文本/JSON 摘要与义务各一份;单入口行为不变;§60 v60.36)。审查 B1 修正:不能按展示路径反查 abs——同显示名不同目录的 `util.ming` 会跨目录误合并;现双模块各一份(§60 v60.51) |
| 32 | **摘要/调用点遍历对所有 `Checker.run()` 无条件执行**:即使不消费摘要(无 `--proof-report`/无跨函数证明查询)也建立摘要表与调用点上下文;小语料约 1.06x(信息性),大项目/LSP 可做惰性化(按需构建) | P3 | **已修(v0.56.0)**:无契约模块跳过摘要构建;有契约模块报告不变(§60 v60.37) |

### 新登记(2026-11-12,software-architect 精读;v0.56.0 已修 #33/#34/#36)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 33 | **契约子句尾部裸标识歧义**:`fn f(buf: Vec[i64], n: i64) -> i64 requires buf.len() == n { return n; }` 把 `n {` 解析为结构体字面量 → M2001「字段名不能是关键字 "return"」;`requires (buf.len() == n)` 加括号可绕过。自然契约写法被拒,**最小复现已实测** | P2 | **已修(v0.56.0)**:requires/ensures 专用解析模式 + struct literal 前瞻(空结构体/普通字面量双向锁定;§60 v60.13–v60.16) |
| 34 | **测试分节号重复/断档**:tests/run.mjs 存在两个 34–38 序号(旧 §34–§38 与 v0.39–v0.44 重复)、缺 §40;分节号不是稳定索引,交叉引用易漂移 | P3 | **已修(v0.56.0)**:分节号唯一化(重复 34–38 → 34b–38b、补 §40),文件头索引说明;不改测试内容(§60 v60.38) |
| 35 | **plan §4.2.10 v0.52 行引用 §54**(实际 v0.52 测试在 §56;§54 是 v0.51.6 复合赋值) | P3 | 已修(本次规划修正) |
| 36 | **fmt 丢弃 `requires`/`ensures`/struct `invariant`**(v0.56 开发中发现的 P1 数据丢失:格式化即删除契约) | P1 | **已修(v0.56.0)**:契约子句与 else 消息、invariant 逐字保留;幂等;既有规范文件零改写(§60 v60.17–v60.20)。`else` 插值消息原文经 `msgRaw` 逐字保留(#39 已修;运行时消息语义不变) |

### 已修复(2026-11-12,v0.56.0 wasm 严格模式语义)

| 编号 | 缺陷 | 严重度 | 状态 |
|------|------|--------|------|
| W1 | **wasm 一元负号 `0 - x` 栈序反**(实际返回 `x`;`-a`/负字面量比较/`(-a)+b` 语义错误) | P1 | **已修(v0.56.0)**:栈序修正;§60 v60.24/v60.25 三引擎逐字一致 + strict 存活 |
| W2 | **循环内语句 if 的 break/continue `br` 深度未计入 if 块**(曾死循环;嵌套 while/if 内层 break 跳出层级错误) | P1 | **已修(v0.56.0)**:br 深度计入 if 块;§60 v60.26–v60.29 |
| F1 | **for 体内 continue 跳过 `__i` 自增**(条件为外层变量时曾挂起;含循环变量条件 + break 组合) | P1 | **已修(v0.56.0)**:continue 前发射自增;§60 v60.30/v60.31 |
| F2 | **`inferNumType` 重复 `case`**(含 `%` 的条件/运算类型推导错误,导致 wasm 回落) | — | **已修(v0.56.0)**:合并重复 case;`%`/`*`/`-`/`/` 条件真实经 wasm(§60 v60.32) |

### 新登记(2026-11-12,v0.56 收口 + 独立审查;状态逐行)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 37 | **VM 块内本地函数声明崩溃**:块内 `fn` 声明路径在 `vm.js` 触发 `TypeError`(callValue 相关);HEAD 可复现 | P2 | **已修(v0.56.0 审查修复)**:统一由 M3047 在检查器声明处显式拒绝本地函数,VM 不再进入崩溃路径(§60 v60.52);恢复本地函数实现见 #44 |
| 38 | **GUIDE 称本地函数可递归,但检查器报 M3001**:文档与检查器行为不一致;HEAD 可复现 | P3 | **已修(v0.56.0 审查修复)**:GUIDE 改为"本地函数暂不支持(M3047,v0.57 后恢复)",与检查器一致 |
| 39 | **契约 `else` 插值消息被 parser 丢弃**(`msg=null`):fmt 无法还原(语义不受影响;与 #36 的已知限制同源) | P3 | **已修(v0.56.0 审查 A3)**:parser 以 `msgRaw` 保存 `else` 字面量原文(含引号),fmt 原样回写;运行时消息语义不变(插值形态运行时仍为 null;§60 v60.49) |
| 40 | **wasm locals 声明索引偏移 `nParams`**:f64 局部/Map 字面量导致 locals 索引错位 → 违规函数 REJECT(实测其他函数仍可经 wasm 执行,非整模块回落) | P2 | **已修(v0.59.0)**:形参占用局部索引 `0..nParams-1` 不进 locals 声明,声明改从 `nParams` 起;f64 局部/混合槽序真实经 wasm(§63 v63.1–v63.3)。剩余:数值 VecLit 容器表示未统一,显式回落具名 |
| 41 | **Map 形参 `slotTypes` 记 `vi64`** → for-in Map 形态 wasm 回落 | P3 | **已修(v0.59.0)**:`paramSlotTy` 登记 `mi64/mf64/mstr`,`__kh/k/v` 槽位补型;宿主 `map_get_i64` 返回 `BigInt(...)` 解锁 i64 值读取;§63 v63.6/v63.7(strict ok) |
| 42 | **Vec 形参多枚/与 f64 形参组合时 locals 类型错位**(实测后位单个 Vec 形参 OK;旧表述"仅签名首位可用"不准确) | P2 | **已修(v0.59.0)**:随 #40 索引模型修复;Vec[i64]×2 + f64 + i64 / 后位 f64 形参均 strict ok(§63 v63.4/v63.5) |
| 43 | **str 返回函数 `retTy` 映射 `i64`** → str 返回形态 wasm 回落 | P3 | **已修(v0.59.0)**:`retNumTy` 映射 str→i32 句柄;字面量/形参透传/拼接/值型 if/块尾表达式均 strict ok(§63 v63.8/v63.9) |
| 44 | **本地函数在 VM 无编译支持**:VM/字节码编译器没有本地函数编译路径(本地函数作值使 tree/VM 分歧;契约被 tree 静默忽略) | P1 | **已修(v0.59.0)**:`precompileLocalFns`/`compileLocalFn`(块级条目 + 递归/互递归 + 契约同模块函数口径 + 作值 LDFN→vclose + AOT entry.sig);tree `callLocalFn` 补齐;M3047 废弃不再发射;三条限制写入 GUIDE(§63 v63.22–v63.34)。**v0.59-P2 审查追加**:B1 契约域放行同块兄弟(`contractFnBinds`;自引用 ensures 与 tree 同 M4005)、B2 lambda 经 `fnBinds` 解析本地函数、B3 遮蔽定案(M3009/词法最近块)、B4 导入遮蔽 M3015、泛型专用码 M3048、`Some/Ok` 本地声明优先(§63 v63.46–v63.56) |
| 45 | **wasm 值型 if 的 blocktype 编码失败**:表达式 `if`(值上下文)静默回落,`--strict-wasm` 可见——导致 W2 的 expr-if 声明不可达(未真实走 wasm) | P2 | **已修(v0.59.0)**:按单字节 valtype 发射(修 `sleb(0x7e)` 两字节 126);i64/f64/str 值型 if/else-if 链/`&&`/`||` strict ok(§63 v63.10/v63.11;v53.25 断言翻转) |
| 46 | **wasm 块尾 if(unit 上下文)按值编译** → `REJECT: if 无 else` 回落(常见 `while { …; if c { break; } }` 形态;导致 W2/F1 在尾 if 形态上未真实走 wasm) | P2 | **已修(v0.59.0)**:unit 上下文块尾 if/loop 按语句编译;while/for/void/嵌套块尾 break/continue/return 均 strict ok(§63 v63.12/v63.13) |
| 47 | **tree 引擎 ensures 求值内嵌块尾值重入 checkEnsures**:契约表达式含带尾值的块(`if` 分支、`match` 臂块等)时,块尾求值再次触发同一函数的 checkEnsures,递归至 M4005,或二次求值时 `result` 被错误替换为块尾 bool 而报 `内部错误:match 无分支命中`。HEAD 可复现;VM/VM-only 正常(与 C1 编译器修复无关)。**最小复现**:`fn f(a: i64) -> i64 ensures if a > 0 { true } else { true } { return a; }` + `fn main() with io { print(str(f(5))); }` → `run --tree` M4005(exit 101),`run`/`run --no-wasm` 输出 5。**v0.59-P2 审查补充**:同一机制覆盖"ensures 求值途中的块尾中间值"(含本地函数 ensures 的块尾值),即 #47 是 tree 契约求值域的单一根因 | P3 | **已修(v0.60.0)**:`execBlock` 仅在函数体块尾检查 ensures(ctx 携带 `bodyBlock`;callUser/callLocalFn 传入、嵌套块剥离),表达式内嵌块不检查;本地函数同口径;三引擎输出 5(v64.B1)且违约 M4015(v64.B2);不改 VM/编译器 |
| 48 | **wasm 路径 `str_cat` 不计入 allocBytes → M4011 配额门禁引擎分歧**:wasm 把 str `+`/插值编译为 `str_cat` 导入(wasm.js compileBinNum str 分支),而宿主绑定(vm.js `str_cat`)只拼 strTable、**不调 chargeAllocBytes/ming_alloc**;解释器与 VM 字节码路径对 str 拼接按结果长度计费(interp.js `chargeAllocBytes(l.v.length + r.v.length)`)→ 同一程序默认引擎不触发配额、`--no-wasm`/tree 触发 M4011。**已验证(v0.58 审查复现)**:`fn probe(a: str) -> i64 { if a + "<120000×A>" == "x" { return 1; } return 0; }` + `print(str(probe("")))`,`--max-alloc 50000` → 默认 exit 0(输出 1)/`--no-wasm` 与 tree M4011(exit 101,累计 120000)。注:B 审查原报告的"20,000 次 `+` 循环"形态**不复现分歧**——str 累积循环(main 内 mut str 局部/str 返回 helper/Vec.push 方法调用/str 实参递归)今日均不满足 wasm 资格或实例化失败而回落字节码(计费),分歧只在 wasm 真实执行的 str_cat 上;随 #40–#43/#45/#46 修复扩大 str 形态覆盖面,该分歧**从潜伏变可达** | P2 | **已修(v0.59.0)**:wasm `str_cat` 经 `str_len(l)+str_len(r)` → `ming_alloc` 计费(与 interp 同口径;嵌套拼接 11+15=26);插值不计费(与 tree/VM 一致);plan §5.1 复现三引擎 M4011 累计 120000(§63 v63.14–v63.16)。**BMP 口径差异**(`str_len` 码点数 vs interp UTF-16 长度,代理对每字符差 1)与 **`--max-alloc` 内存风险**(bump 堆不回收,配额放大时驻留随拼接总量增长)如实登记 |
| 49 | **`std.str.join` 结果不计入分配记账,与 Vec 方法 `join` 计费不对称**:Vec 方法 join 按结果长度计费(interp.js `case 'join'` chargeAllocBytes(out.v.length)),v0.58 新增的 `std.str.join`(单次 O(n) 拼接)不调 chargeAllocBytes → 同尺寸结果 std 函数侧不触发 M4011。**已验证(v0.58 审查复现)**:10,000 × "abcdefghij" 入 Vec(`--max-alloc 60000`)→ `str.join(v).byte_len()` exit 0(输出 100000,结果 100KB 未计费)/`v.join(",").byte_len()` M4011(exit 101,累计 119999)。文档须如实标注:"join 的配额优势部分来自不计费";**API 不对称同步登记**:`v.join(sep)`(Vec 方法,带分隔符,计费)与 `str.join(v)`(std 函数,无分隔符,不计费)——GUIDE v0.58 收口条目覆盖该说明 | P3 | **已修(v0.59.0)**:`std.str.join` 按结果长度 `chargeAllocBytes(out.length)`(与 Vec 方法 join / `+` 同口径);紧配额下两形态均 M4011(累计 110000 / 119999;§62 v58.29 断言按翻转后改写;§63 记账组覆盖)。GUIDE/API 不对称说明同步更新为"已对称化" |
| 50 | **tree `deepCopy` 的 closure 分支丢 `env.mod`/`env.localFns`(pre-existing)**:闭包经 let/实参深拷贝后 `env.mod` 丢失,lambda 体内模块项访问触发 `env.mod.items` TypeError;引用外层本地函数时 `localFns` 也丢失 | P2 | **已修(v0.59-P2 B2)**:`deepCopy` 的 closure 分支保留 `mod`/`localFns`(localFns 表浅拷贝,与 `snapshotEnv` 同口径);`[1,2,3].map((x) => inc(x))` 三引擎一致(§63 v63.48/v63.49) |
### 新登记(2026-11-13,三方评估/安全审计;状态逐行)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 51 | **wasm 参数搬运计入分配配额,且 `wasmParamTop` 未复位**:`sum(v: Vec[i64])` 传 `[1,2,3]` + `--max-alloc 20` → 默认引擎 M4011(累计 43),`--no-wasm`/tree exit 0;根因 `wasmWriteVecNum`→`mingAllocRaw` 计费 + `wasmParamTopStack` 在分配后才保存→线性内存不复用 | P1 | **已修(v0.60.0)**:`mingAllocRaw(n, charge=true)` 仅搬运不计费(派生拷贝不是值创建;ming_grow/copy_vec/str_cat 计费不变);`wasmParamTop` 调用前保存/finally 复位(panic/trap/编组回落三路径),线性内存随调用复用(`wasmParamTopStack` 删除);三引擎配额矩阵 v64.A1/A2 + 10 万次复用冒烟 v64.A3(§64) |
| 52 | **外部输入边界未计入 `--max-alloc`**:`fs.read_file` 182,819 字节 + `--max-alloc 10` → exit 0;`read_bytes`/`read_line`/`read_to_end`/`list_dir`/`proc`/`http` 同源 | P1 | **已修(v0.60.0)**:read_file 先 stat 按 size 预记账/read_bytes 按 size/read_line、read_to_end 按结果长度/list_dir 按条目数/proc.exec 按 stdout+stderr 长度/http body 按长度计费;Err 路径不计费且 Err 消息与 v0.59 逐字一致;派生值不重复计费;v64.B3–B5(§64) |
| 53 | **`--max-ms` 对阻塞内建不可抢占**:`sleep(3000)` + `--max-ms 100` → 3,213ms;`join` → 3,283ms;根因 `checkTimeQuota` 每 16,384 步轮询,阻塞内建不经过 | P1 | **已修(v0.60.0)**:`remainingMs()` 钳制 sleep/join_detailed/spawn_all/sync scope/exec/http 的等待(预算已尽不等待直接熔断 → M4012);`checkTimeQuota` 边界 `>`→`>=`(钳制等待边界唤醒取整漏报修复,v0.32 自旋用例逐字不变);read_line/RegExp 进程内不可抢占边界具名(GUIDE/capabilities/代码注释);v64.B6–B9(§64) |
| 54 | **`ming test`/`ming init` 零 CLI 回归且旗标不传播**:`test --no-wasm` 仍走 wasm;`test --max-alloc 5` 通过而 `run --max-alloc 5` 触发 M4011 | P1 | **已修(v0.60.0)**:test 旗标传播(`--tree/--no-wasm/--max-steps/--max-alloc/--max-ms` 与 run 同默认值;**VMInterp.runTests 与基类 Interp.runTests 双路径**透传——审查发现基类漏透传致 `--tree` 腿静默失效,修复 + v64.B9 锁定);`--strict-wasm` 仅互斥仲裁、单独出现 stderr 提示忽略(v64.C6);`ming init` CLI 回归(v64.C4/C5)(§64) |
| 55 | **FFI str 内嵌 NUL 静默截断**:`strlen("ab\0cd")=2` 而 Ming 侧长度 5;加载面(RTLD_GLOBAL/LoadLibraryA)未文档化 | P2 | 文档 + 回归(v0.60 文档声明);拒绝截断需语义裁决,不承诺 | **已处置(v0.64)**:文档 + 回归落地——GUIDE strlen 语义声明 + NUL 黄金回归(byte_len=2,自编 DLL 实测);"FFI 扩面先裁决 NUL 策略"前置义务;架构 M4017 提案经安全实测否决存档(实参路径不可达) 
| 56 | **AOT artifact 结构校验缺失**:反序列化只验 format/version;损坏 `mainFnIdx`/表长 → raw TypeError 而非稳定诊断 | P2 | Backlog;低成本索引/表长校验 + 损坏样例回归 | **已修(v0.64)**:validateArtifact 结构校验(函数/索引/池/跳转面)——四损坏形态统一稳定诊断"不是 Ming 字节码产物"(raw TypeError 消除);21 变体入 §68 回归 
| 57 | **安全回归缺位**:FFI NUL、损坏 artifact、污点负例无测试;M4013 无专项回归 | P2 | 随 v0.61 补(与污点负例同批) | **已修(v0.64)**:§68 21 项安全回归批——M4013 专项首破/NUL 黄金/四损坏形态/S11 兜底/S13 慢连接/S9·S12 向量 

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
### 新登记(2026-11-14,v0.63 wasm slice 2 审查)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 58 | **mut Vec 元素写越界的 panic 位置三引擎差 1 列**:wasm/tree 用 `target.span`(`[` 列,interp.js:856),字节码 VM 用 Assign 语句/base span——`w[10]=x` 越界时 VM 位置列号小 1。HEAD 预存(非 v0.63 引入);v0.63 wasm 按 interp 源码口径对齐 tree | P3 | **登记未修**(v0.63 审查预存发现 A;修复需 compiler SETINDEX span 调整,涉及既有 panic 位置断言面) | **JS 引擎已修(v0.64)**:compiler SETINDEX span 对齐——三引擎 panic 位置逐字;**cc 侧残留**(cbackend.js:986 语句列 + ming_vec_set 消息带读后缀)登记,FFI/cc 触碰时顺带 
| 59 | **wasm→wasm 直调 panic 栈缺内层帧**:main→f→g(g 内越界)wasm stderr 缺 `at g` 帧(2 帧 vs tree/VM 3 帧)——wasm 直调不经 callCompiled,深层 Ming 帧不入 callStack;首行/位置/exit 101 已对齐;v0.63 已把单层栈补齐(严格改善),嵌套残留登记 | P3 | **登记未修**(v0.63 审查 M2;修复需每个 wasm 调用点下发调用点 span 透传 callStack;§67 v67.20 按现状断言) | **已修(v0.65)**:Route E 调用点帧透传——frame_push/frame_pop 导入对(正常返回弹出;panic 穿透时宿主 wasmCallFrames 并入 e.stack 后清空);main→f→g 三引擎完整 stderr 逐字(at g 帧回归);递归正常;**代价:wasm 直调 +18%**(fib30 167→197ms,信息性)

### 新登记(2026-11-14,第四轮复核——AI 协作面实测;#60–#62 先登记不修)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 60 | **REPL let 绑定陷阱**:`let x = 1;` 静默成功(被包进临时函数 `__repl_N` 体,不入持久声明集——src/repl.js:74–80),下一行引用报 M3001"找不到值 x"且 hint"最接近的名字是 Ok"(误导);失败回滚使 let 行看似成功;GUIDE §19"声明持久化"宣称与 AI 预期(let 也持久)错配;REPL 横幅停留 v0.8.0 | P3 | **登记**(第四轮 #60;修=let 行回显"绑定仅当前输入生效"或 let 纳入 decls;随 v0.64 文档清扫顺带或 Backlog) |
| 61 | **test 断言失败栈位置 undefined**:`ming test` 失败输出 `at test <名> (undefined:undefined:undefined)`——M4008 消息与左右值正确,位置未接线(runTests 以 callSpan=null 调 callUser 的既有格式化) | P3 | **已修(v0.71)**:runTests callSpan 透传 entry.decl.span(interp.js 基类 + vm.js VMInterp 双路径,#54 先例);三引擎 `at test <名> (file:line:col)` 逐字;**顺带修复预存分歧**:tree 帧名缺 `test ` 前缀(与 compiler.js:173 编译函数名口径对齐);M4008/M4003/M4011 消息与退出码逐字不变;N-60.4 同源 M4011 栈行一并解决 |
| 62 | **fix 处方"自信但错误"+级联误导**:`let r = foobar(3);`(未声明函数)级联 4 诊断——M3003"无法推断 r 的类型"先于真实根因 M3001"找不到 foobar",且 M3001 的 fix 处方建议把 `r` 替换成 `str`(自信、可机器应用、应用后更糟);级联 M3002 hint"其他类型用 debug(x)"在根因是拼错名/未声明名时系统性带偏(三形态实测)。根因:初始化器含未声明名时绑定整体丢弃而非毒化收敛——M3048 已有"毒化 never 签名收敛"先例未应用到此形态。**诊断质量面:fix 结构化处方仅 4 族发射(M2002/M2001/M3029/M3001),77 码覆盖率 ~5%(样本 ~19%)——非结构化 hint(M3015 列方法/M3049 点净化器)质量好 | **已实测修正口径(v0.66 快照)并登记不修**:fix 结构化处方**仅 3 族**发射(M2002/M3029/M3001——原登记 4 族中 **M2001 全部经 bail() 从不附加 fix**,parser.js:65);级联误导 hint 的发射码是 **M3012**(checker.js:1962,非原登记的 M3002);"级联 4 诊断"对应含插值形态(快照 e19),纯 `let r = foobar(3)` 为 3 诊断(快照 e13);M3048 已有"毒化 never 签名收敛"先例未应用到此形态 || **登记不修**(第四轮 #62):v0.66 任务 7 测量 fix 覆盖/正确率/级联比 + v0.67 候选主题"诊断协议校准"裁决;先例技术(毒化收敛)是首选修法 |

### 新登记(2026-11-14,第五轮端到端走查;#63–#65 处置、N-66–N-68 信息)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 63 | **parser 级联雪崩**:test 块误置函数体内 → 1 根因 11 条 M2001 级联 + unused 误报 + 1 条错误 fix(建议加冒号);parser 层级联比 11x(checker 层 1.75 对照)——第五轮走查实测 | P3 | **已修(v0.70)**:recover(false) 深度感知 panic-mode 恢复(`{}` 深度跟踪/`;` 深度 0 停机/`}` 深度 0 交还块循环/语句停机表移除 test)+ catch 强进路径修复;锚定语料 4→1、长体 14→1(基线代理 16 条含 11 条 let 顶层级联+假 W3101);独立验证 10 语料改前 44 条(级联比 4.4x)→ 改后逐语料对照根因保留/级联消除;既有测试**零校准**(无断言依赖旧级联);既有 1091 项(HEAD 基线)全绿 + §73 12 项 = 1103(回归锁:unclosed/nestedif/multi 干净形态不变) |
| 64 | **REPL 横幅版本漂移机制性复发**:src/repl.js:39-40 硬编码手工同步(注释自认"曾漂移"),v0.64 修 v0.8.0→v0.63.0 后 v0.65/66 又落后两版(第五轮 REPL 冒烟横幅仍 v0.63.0) | P3 | **v0.67 顺带修**:横幅改从单一事实来源读(manifest/package.json,不引 src→bin 环) |
| 65 | **serve 绑定失败 Err 后 exit 0**:serve-observation §4-4 实测——服务没起来但退出码成功(运维陷阱);main/serve Err → exit 非 0 属行为变更 | P3 | **已裁决(v0.69)**:行为变更否决,采文档化方案——main 返回 i64 已是退出码通道(实测 `return 3` → exit 3),"错误是值"下语言不替程序决定 Err 致命性,unit main 吞 Err 不可机械判定;处置 = GUIDE std.net 运维惯用法 + examples serve_demo.ming(顺带兑现 N-64);理由全文见 ADR-005 §9 |

### 新登记(2026-11-15,v0.68 实现期;#66 已修)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 66 | **`as_obj` 副本 Map 键误存包装值**:jsonMethodImpl as_obj 用 `m.set(V.str(k), val)` 把键存成 Ming 包装值,而 Map get/has 经 normKey 用裸 string 查找 → 对存在键 get 返回 None/has false/keys 双包装(打印 [object Object]);HEAD 逐字复现三引擎,既有测试零覆盖(引用 0)——v0.68 投影流触达后修复(m.set(k, val) 直存裸键,最小 diff;json_demo 黄金三引擎逐字不变) | P2 | **已修(v0.68)**:§71.17 三形态回归锁定(简单键/数字型字符串键/Unicode·emoji 键) |

### 新登记(2026-11-15,v0.70 收口 + 第七轮盘点;含 v0.68 审查 m2/n2 补登记)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 67 | **parser panic-mode 有界伪诊断**:"嵌套块在值构造内失败"形态——valBrace 结清后 salvage 所有权缺失,产出 1 条指向失真的伪诊断(v0.70 独立审查残留;YELLOW 裁决维持:误导+错误 fix 比静默更伤 AI 修正回路) | P3 | **已修(v0.71)**:构造级登记所有权(块入口快照 enterVB + 种子层同步递减 + 条件化 `--`)——p21/p05/p06 伪诊断消除且被救回语句的真实诊断如实报出(伪→真),p24 逐字不变,s1 伪 M2002 清零;独立审查四形态自建语料 + 记账推演核实 |
| 68 | **被吞区域语句级 salvage 缺失**:recover(false) 深度 0 停机把失败语句区域整体吞掉,区域内"疑似函数调用行"(如 `id(`)可抢救而未抢救(v0.70 YELLOW 登记,GUIDE 修订记录 1259) | P3 | **已修(v0.71)**:深度 0 `id(` 停机启发式——probe_anchor 真实 M3001 复活(1→2,基线误导 4 条)、锚定语料仍恰 1 条(print("bye") 救回无新诊断)、长体/干净形态回归逐字;毒汤三组 20s 守卫收敛;s1 伪清零真实面扩大(400→600,600 全为真实诊断) |
| 69 | **嵌套位置污点诊断回落通用码**(v0.68 审查 m2 补登记,同族 N-63.1):`Some(污)` 变体构造载荷位报 M3002 非 M3049(struct 字面量字段前置先例未覆盖变体构造器);同族 N-63.1 五形态(块尾/match 分支混型/spawn_all 元素/用户变体载荷)——全部**正确拒绝**,仅诊断质量非旁路;另 n2 备忘:污键 Map get 保守拒绝(行为正确,登记备忘) | P3 | **已修(v0.71)**:判定翻转 + callCtor 前置 + match/spawn_all 三处——五形态全 M3049(统一净化 hint),直传逐字不变、双侧污维持 M3002、Some(污) 自洽传播合法维持;既有 §65/§66/§71 污点回归零校准;if 分支混型位已随 v0.72 对称化收口(checker.js checkIf 双向接入) |
| — | **NOTE 极端嵌套裸栈溢出**:解析/求值深嵌套的预存极端形态(v0.70 审查 NOTE,两版本一致;非回归) | 信息 | backlog 登记;与引擎栈深相关,修复需栈深评估另裁 |

### 新登记(2026-11-17,v0.77 内容源扩面迁移期发现)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 70 | **VM:for 内 match 臂中的 `continue` → `内部错误: TypeError: iter.next is not a function` 进程崩溃**;tree 引擎同程序正常(双引擎分歧 + 崩溃)。v0.76 src 两版本一致复现(迁移期实测;最小复现形态留存 .zcode/v77/probe6 方向——match 臂内 continue 于 for 循环)。v0.77 工具迁移已全部避开该形态(改嵌套 if),不影响本批交付 | **P1** | **已修(v0.78)**:根因实测定案——match 宗量贯穿臂体留栈、Break/Continue JUMP 不清理活临时（for 崩溃/while 泄漏/break 静默泄漏三形态）；修复 = 纯编译器层 matchTemps 词法计数 + 四循环点 breakCtx 快照 + 前置 POP × popN；无 match 形态字节码逐字节不变；§81 16 条目 18 check 全形态锁定；**1251 项全绿**；fuzz 双种子 0 分歧 |
| — | **io.read_to_end**：v0.77 审查 M1 补裁**已翻转**（Untrusted[str]，与 read_line 同源同污；重复注册两行 HEAD 预存一并清理） | 信息 | **已翻转(v0.77 审查 M1)**；§80.19 锁定 |
| 71 | **lambda 体内 continue/break = checker 漏洞**：checkLambda 保留外层 inLoop → `let g = (a: i64) => { continue; };` 过 check 且块尾 never 使 g 可传 HOF——调用时 tree"continue 穿透 lambda 到外层循环"（打印空），VM compileLambda 子状态无 breakCtx 走防御分支发射裸 POP 弹穿共享操作数栈 → `TypeError: ... 'next'` 内部错误崩溃（tree/VM 分歧；语料 .zcode/v78/t_l6.ming——v0.78 实现 agent 同族发现，独立可复现） | **P1** | **登记；v0.79 候选首位**（修复归属 checker.js——lambda 体应重置 inLoop 发 M3010/M3011"continue 在循环外"；或 compiler 专用跳出机制，随批裁决） |
| — | **json_query C0 控制字符输出分歧**:污 Json 重建路径对 \u0007 等控制字符原样透出(jsonWrite 是 \uXXXX 转义)——非良性文件上逐字节口径破裂;工具头注释原指向 GUIDE §19 系错误指向,已改指本登记 | 信息 | **登记**(v0.77 迁移期发现;良性文件不含;修复需语言面码点分类能力,登记不预支) |
| — | **tree 引擎 ContSig/BrkSig 穿透 lambda 调用帧(防御不对称)**:lambda 边界的 continue/break 拦截仅在编译器层(v0.79 checker 全拦);tree 引擎 callClosure 只捕获 RetSig——若未来出现免检 AST 消费者,tree 侧会重新静默吞迭代(审查 NOTE-1,公共入口均经 checker 门控故不可达,与顶层裸 continue 信任模型一致) | 信息 | **硬化候选登记**(非阻塞;随 #71 家族后续批次评估) |

### 备注登记(2026-11-13,v0.57 收口;信息性,非缺陷)

| # | 备注 | 级别 | 状态 |
|---|------|------|------|
| N-62.1 | serve 运维事实：`--max-ms` 对 serve 程序照常生效,CLI 缺省 600000ms——**长驻服务必须显式调大**(如 `--max-ms 86400000`),否则 10 分钟后被 M4012 熔断;GUIDE std.net 节已登记 | 信息 | 已登记(v0.62 收口) |
| N-62.2 | 嵌套 serve 边缘行为:handler 白名单含 net,handler 内调 serve 编译期不拒——嵌套 serve 会绑第二服务、外层请求 30s 后 504,嵌套服务继续存活;v1 不 policing,如实登记 | 信息 | 已登记(v0.62 S2 报告;放开/禁止待后续裁决) |
| N-62.3 | §66 v66.15(worker 启动失败)skip:`new Worker` 抛错难确定性构造;行为正确性由源码审查覆盖(五条释放路径 done/error/exit/timeout/启动失败均有 release 且 done 防双释放——审查确认) | 信息 | 已登记(v0.62 审查 n2) |
| N-64 | examples 零覆盖 v0.61/v0.62 能力面:Untrusted/std.unstr 与 std.net.serve 各 0 示例(18 文件 grep 证实)——AI 靠 examples 学惯用法,两个新能力面"文档化但不可见" | 信息 | Backlog:各补 1 个 ≤30 行示例(模板 fs_demo/unsafe_demo);第四轮复核登记 |
| N-64b | 使命层端到端实测结论(AI 修正回路):17 错误程序 100% 被 `check --json` 捕获(码/位置/消息全准)、多错误一次报告 5 条、warning-only ok:true、panic 形态三引擎一致、LSP/REPL/test/fmt/doc/init 冒烟正常——AI 修正回路主干健康,是当前最强协作面 | 信息 | 第四轮复核登记(plan §4.5.8);v0.67 主题裁决证据基线 |
| N-66 | AOT 对含 test 块文件回退源码模式——"缺少签名"具名提示质量好(非静默),但产物含明文源与 build 宣传面"无明文源"不一致 | 信息 | 登记;AOT 面 test 块支持待评估 |
| N-67 | GUIDE 缺元组字段访问语法示例(.0/.1 仅解构出现;走查实测 AI 猜 .1 被 M2002 拒且无 hint) | 信息 | onboarding 包(v0.68 候选):GUIDE 类型表补一行 + examples |
| N-68 | fmt --write 写入后文案"已是规范格式"含糊(实际已写文件) | 信息 | 顺手改文案"已格式化"(v0.67 顺带候选) |
| — | 惯用法观察(非缺陷):unwrap_or("") 吞 read_file 失败 → 静默 exit 0;CLI --tree 误置 -- 后被当程序参数——AI 高频反模式 | — | 归 N-64 examples/GUIDE 惯用法节(read_file ? 传播示范 + 旗标位置说明) |
| N-65.1 | wasm Result 句柄表示:Ok/Err 构造入 objTable 句柄池,无回收(循环内构造单调增长;实测 100,000 次构造 exit 0 正确无上限)——与既有 Vec/Map 句柄、callCompiled 参数入表同一 pre-existing 模式;语义安全(Result 无变异方法,句柄共享无别名风险;Result 形参/返回不 eligible,句柄不跨函数边界) | 信息 | 已登记(v0.65 审查 NOTE 1) |
| N-65.2 | frame 透传使 wasm 直调增约 18%(fib30 167→197ms,stash 对照实测)——换 #59 三引擎栈帧逐字的代价;bench 信息性 | 信息 | 已登记(v0.65 W1;架构师复核项) |
| N-65.3 | unwrap_or/is_some/is_none 实为 **shape-eligible + emit 具名回落**(strict exit 2),非既往登记的"不 eligible"——口径修正入 GUIDE/capabilities(v0.65 W1 实测) | 信息 | 已登记(口径修正) |
| N-65.4 | M4002 wasm 消息为泛化文案(整数运算溢出/移位越界)vs tree 操作数逐字明细——HEAD 预存分歧,v0.65 复测确认(span/exit 已逐字,仅消息文本) | 信息 | 已登记(GUIDE/capabilities 已载;操作数穿越导入边界留后续) |
| N-63.1 | 嵌套位置污点诊断回落通用码:`Result[Untrusted[str],str]`→`Result[str,str]` 块尾、match/if 分支混型、spawn_all Vec 元素、用户变体载荷报 M3002(而非 M3049);`json.stringify` 的 M3033 hint 对污点值误导——全部**正确拒绝**,仅诊断质量非旁路 | 信息 | 已登记(审查 m3;后续可把判定改 `typeContainsUntrusted(actual) && !typeContainsUntrusted(expected)`) |
| N-61.2 | compiler `tryWasm` 的 Untrusted 解包为**原地修改** checker `entry.sig`(运行时擦除下语义自洽;doc/LSP 读 AST 不受影响;AOT 产物存载体签名正确)——卫生债:未来"compile 之后再读 sig 渲染"的功能会踩坑 | 信息 | 已登记(审查 n1;建议将来改 clone 喂 wasm.js,v1 不修) |
| N-60.1 | #53 钳制等待后的 `checkTimeQuota`（M4012）先于 `worker.terminate()` 抛出（syncSpawnAll/syncJoin/join_detailed/exitSyncScope 四处）——CLI 侧 `process.exit` 收割全部 worker 无碍；"解释器即库"（REPL/嵌入）场景会泄漏运行中 worker 至任务自然结束。修复前该位置无检查，非回归 | 信息 | 已登记（v0.60 批次 1 审查；后续可把 terminate 挪到检查前/finally） |
| N-60.2 | `read_file` stat 预记账的平台差异：Windows 目录 size 0 不多计（EISDIR Err 与 v0.59 逐字一致）；Linux 目录 size 4096 会多计 4096 后仍回 Err（注释已声明"偏保守"口径） | 信息 | 已登记（v0.60 批次 1 审查） |
| N-60.3 | `wasmWriteVecNum` 调用点传 3 参（含 mut 旗标）但定义只收 2 参——mut 旗标静默丢弃，`mut 参数预留容量(v0.20 push)` 注释名不副实；v0.59 既有代码，不在 v0.60 改动面 | 信息 | 已登记（latent；单独收口需评估 mut Vec 容量语义） |
| N-60.4 | test 模式 M4011 的栈行显示 `at test <名> (undefined:undefined:undefined)`——runTests 以 callSpan=null 调 callUser 的既有格式化行为（run 模式正常显示 file:line）；断言不依赖 | 信息 | 已登记（v0.60 批次 1 审查） |
| N-57.1 | `tests/coverage.mjs` 的"始终 exit 0"**非无条件**:`mkdtemp` 临时目录创建在 try 块之外,创建失败(权限/磁盘等)会以未捕获异常 exit 1——概率极低,信息性工具,本版不改代码 | 信息 | 已登记(§4.3.8 覆盖率行备注);docs/coverage-baseline.md 措辞已同步 |
| N-57.2 | bench/coverage 基线数字为**快照口径**:`tests/bench.baseline.json` 带 `meta.date`、docs/coverage-baseline.md 标注时点(2026-11-13,Node v24,win32-x64);只作同口径纵向趋势对比,`bench --write-baseline` / 重跑 coverage.mjs 刷新 | 信息 | 已登记(两文件均已标注时点) |


### 新登记(2026-11-20,v0.90 独立审查 NOTE 预存发现;登记不修)

| # | 缺陷 | 严重度 | 状态 |
|---|------|--------|------|
| 74 | **checker `unify` 无 `'ctor'` case**(checker.js:138-161 落 default false):ctor 值重赋值 `d = E.A` 误报 M3002"目标是 E.A,值是 E.A"(探针 .zcode/review90/)。预存;v0.90 将 ctor 值推向一等用法后暴露面增大 | P3 | **登记未修**(同族缺口的正规修法 = unify 补 ctor case 或 ctor 值携带类型身份;冻结期不扩面) |
| 75 | **内建/用户无载荷变体作值不对称**:`Option.None` 作值是 ctor(interp.js:1598),用户枚举无载荷变体 `E.B` 作值是枚举值(interp.js:1608/1619)——v100.4 锁定现状 | P3 | **登记未修**(不对称面在合法程序中双引擎一致,无分歧;改动会破坏既有语义面,冻结期不做) |
| 76 | **print 插值段 Call 的 inferTy/emitCallRef 返回类型表不一致**:`m.delete("x")` 作插值段——emitCallRef 知 retTy=bool 但 inferTy 返 null → 误导性 C1 拒绝"插值段 Call(Vec/Map 形态属 C4)"(该形态语句位 C 面可用;审查 m3)。修法 = evalDisplaySeg 借 emitCallRef retTy 放行可显示标量 | P3 | **登记未修**(v0.92 审查 m3;冻结期不扩 C 面) |
| 77 | **module const 字符串拼接绕过 VM 运行时 alloc 计费**(pre-existing,v0.93 即有):`const S: str = "aaaa"+"bbbb"` + `--max-alloc 4`——default/no-opt/no-wasm exit 0 而 tree exit 101 M4011(编译期 constEval 用树引擎但 VM const 池不经 CONCAT 计费)。v0.94 审查 MINOR-4 登记 | P3 | **登记未修**(修法 = constEval 继承运行时 alloc 计费或 VM const 加载补记账;影响面小) |
| 78 | **O1 B1 回归面缺口**:float wire 的 spawn/join/spawn_all 通道、Map 浮点键、Vec/Map 嵌套 float、旧 v2 artifact 兼容、tools 缓存键 opt/no-opt 无门禁断言(产品探针均通过;审查 MINOR-8/NOTE-4 登记)——v0.95+ 补用例 | P3 | **登记未修**(opt_gate 187 + v104.14 已覆盖 AOT 池主面) |
| 80 | **`Vec.slice`/`Vec.filter` 返回值浅拷贝元素**(源与结果共享元素对象引用:`v.slice(0,1)[0].push(2)` 使源 `v[0].len=2`)——四腿一致(含 tree)故非双引擎分歧,属"方法返回值浅拷贝"设计级语义问题;绑定变量即被 ST 深拷贝隔离。v0.97 独立验证发现 | P2 | **登记未修**(值语义语义面;修法=方法返回位深拷贝或登记为文档限制;影响面待真实用例评估) |
| 81 | ~~**deepCopy 缺 vclose 分支**(VM 闭包绑定/传参别名:tree 1/2/1/0 vs VM 1/2/3/0)~~ | P1 | **已修(v0.97.0,§108 8 check;tree closure 分支同口径)** |
| 82 | **树引擎闭包复制不完整**:`deepCopy(closure)` 的 `env.parent` 浅拷贝——内层闭包经 let 复制后与外层块级 let 捕获链共享(tree n3:wrapA 无 let `1/1/2` 快照 vs wrapB 有 let `1/2/3` 共享,自相矛盾;违反 design.md '无共享可变结构';VM 经 #81 修复为正确面) | P1 | **登记未修(v0.97 审查 B1 回退)**:递归 snapshotEnv 实现呈 **2^n 复制**(22 层嵌套块合法程序 4GB OOM exit 134;1M 次闭包绑定 tree +55%)——修法需 free-variable 捕获计划(对齐 VM capture plan)或持久化 env/COW;待专门设计批次(ADR 级)。**同源预存形态**:p_flat_80(同块 80 个顺序闭包)在 HEAD 亦 4GB OOM exit 134(deepCopy closure 复制整个 env.vars 含兄弟闭包的指数增长)——未来验收必须覆盖 flat-block 变体 |
| — | **bench WARN 不覆盖 vm/tree 绝对耗时回退**(只盯 cc/vm 加速比;审查 m4)——**已修(v0.94)**:bench.mjs reportBaseline 增 vm/tree 绝对回退 >20% WARN(与 cc/vm 比值告警同阈值) | P3 | ✅ 已交付(2026-11-20) |

## 6. 过程纪律（所有版本适用）

1. 每个版本：实现 + `tests/run.mjs` 分节测试 + 模糊抽查（0 分歧）+ 文档三条（GUIDE 修订记录 / README 路线图 / 诊断·能力矩阵按需）+ 版本三处同步 + 提交。
2. 发现既有 bug：先最小复现 → 回归测试 → 修复 → 记录在修订记录（不静默修）。
3. 自举优先：能用 Ming 写的工具不写别处；工具使用中发现的 bug 与语言 bug 同等对待。
4. 只承诺测过的：任何性能/覆盖率数字必须来自可复现的命令。
