# Ming 能力矩阵(v0.38 基线审计;当前 v0.68.0)

> 本表是 v0.38 时的全面审计。v0.39–v0.65 的能力增量以 `GUIDE.md` 修订记录为准;v0.56 已复核 C/wasm 覆盖面并重算覆盖率;v0.57 契约/证明行补循环形态(无新增矩阵行);v0.58 新增 LSP 行(✅)并把流式拼接行按 join 口径改判 🟡;v0.59 新增"本地函数"行(✅,#44 恢复)并更新 WASM 行(覆盖收口 + 剩余守护具名);2026-11-13 三方评估将"运行时资源熔断"改判 🟡(#51–#53 有限口径);v0.60 交付修复后复核恢复 ✅(边界具名);v0.61 新增"数据流安全(污点标注)"行(✅,窄源 v1);**v0.62"TCP/UDP/服务端"行 ❌ → 🟡(serve v1 交付,定位内网/工具服务)**;**v0.63 更新 WASM 行(守护收口 slice 2:五形态解锁、剩余守护收窄仍具名;判定保持 🟡,无新增行)**;**v0.65 更新 WASM 行(守护收口 slice 3 终章:五形态解锁、#59 嵌套栈帧兑现、导入 69→80、strict 自造语料 18 程序残留 0、守护具名清零后余项;判定保持 🟡,无新增行)**;**v0.68 更新污点行(ADR-004:`Untrusted[Json]` 载体解锁——serve 签名翻转、投影表、stringify 拒绝、净化器族不扩;判定保持 ✅,无新增行)**。

对照"标准库金字塔"的诚实审计。✅ 生产语义 / 🟡 雏形(有硬限制)/ ❌ 缺失。

## 输入/输出与系统接口

| 能力 | 判定 | 说明 |
|------|------|------|
| stdout/stderr | ✅ | print/eprint |
| stdin 整行 | ✅ | read_line |
| stdin 全量 | ✅ | read_to_end |
| 格式化输出(宽度/精度) | ✅ | std.fmt(v0.27/v0.28):精度 fixed/exp、进制 hex/bin、宽度 align(left/right/center,字符口径) |
| 文本文件读写 | ✅ | read/write/append(Result 化) |
| 二进制文件 I/O | 🟡 | v0.31 雏形:read/write/append_bytes 整文件 ↔ Vec[u8],to_bytes/to_str 转换;8MB 上限,无流式/随机访问/mmap |
| 目录:列名/创建/递归删除 | ✅ | list_dir/make_dir/remove_dir_recursive |
| 文件元数据(大小/时间/类型) | ✅ | metadata → Json(v0.24) |
| copy/rename | ✅ | v0.24 |
| 外部进程 exec | ✅ | proc.exec → {exit, stdout, stderr}(worker 同步,60s 超时,v0.24) |
| 环境变量 读/写/删 | ✅ | std.env(v0.24,效果 env) |
| HTTP 客户端 GET/POST | ✅ | http_get/http_request/http_request_opts(v0.27):响应头 Map 可读、超时可配;重定向固定 follow;体上限 8MB;无流式/取消 |
| TCP/UDP/服务端 | 🟡 | **v0.62 服务端 v1**:`std.net.serve(port, handler) -> Result[i64, str]`(net 效果;worker-per-connection;固定 127.0.0.1 回环;并发 16/FIFO 256/体 8MB/超时 30s;Json 载荷;错误体 `Json{code,message}`;handler 效果白名单 8,sync/unsafe/ffi 拒绝;`ming build` 回退源码模式、`ming cc` 发射期拒绝、wasm 永不 eligible)。**定位**:内网/工具/agent 服务(~60ms/请求冷启动、饱和 ≈190 req/s@16、55MB/worker RSS)——不承诺生产吞吐。**未覆盖**:UDP、TLS、自定义 host、优雅停机、keep-alive 调优、流式、WebSocket、10 万级连接(北星支柱 3 远期,另 ADR) |

## 文本与信息处理

| 能力 | 判定 | 说明 |
|------|------|------|
| 基础字符串方法 | ✅ | 20+ 方法,wasm 桥接 |
| 字符串插值 | ✅ | 数值/bool 段 wasm 直译 |
| 字典序比较 | ✅ | < <= > >= |
| 正则表达式(is_match/find/find_all/replace/split) | ✅ | std.re(JS RegExp 桥接;r-string;v0.26) |
| 字符分类 is_alpha/is_digit/is_space/is_upper/is_lower | ✅ | str 方法(Unicode 感知;v0.26) |
| pad_left/pad_right | ✅ | str 方法(v0.26) |
| 流式拼接(Builder)/join | 🟡 | v0.58:`std.str.join(Vec[str]) -> str` 单次 O(n) 拼接(`use std.str` 纯函数;与 Vec 方法 `join(sep)` 的 API 不对称、#49 分配记账差异如实登记);真正的流式 Builder(push/append 不落中间串)仍 ❌;`+` 仍全量拷贝 |
| 格式化语言(对齐/进制) | 🟡 | 进制(hex/bin)、精度(fixed/exp)、宽度对齐(align)✅;千分位/本地化数字格式 ❌(与 i18n 同策略:宿主委托) |
| 本地化/国际化 | ❌ | 策略:宿主委托(借 JS Unicode 感知),非语言承诺 |

## 计算与时间

| 能力 | 判定 | 说明 |
|------|------|------|
| 整数 checked 运算 | ✅ | 溢出/除零/移位即 panic |
| 基础数学 13 函数 | ✅ | wasm 导入桥接 |
| 反三角/log2/hypot/cbrt | ✅ | std.math v0.29:asin/acos/atan/atan2/sinh/cosh/tanh/log2/log10/cbrt/hypot,wasm 导入桥接 |
| 随机数(u64/f64/range/seed) | ✅ | std.rand(效果 rand;确定性 seed;v0.25) |
| 毫秒时间戳/sleep | ✅ | — |
| 单调时钟 | ✅ | monotonic_ms(v0.25) |
| 日期分解(Json 七字段) | ✅ | date_parts(本地时区;v0.25) |
| ISO 格式化/解析 | ✅ | format_iso/parse_iso 往返(v0.25) |

## 并发、诊断与健壮性

| 能力 | 判定 | 说明 |
|------|------|------|
| 结构化并发(spawn/spawn_all/join/scoped) | ✅ | worker 隔离 + wire 边界 |
| 子任务错误隔离(Err 化) | ✅ | panic → join Err |
| 诊断协议(错误码+位置+hint+JSON) | ✅ | src/diag.js CODES 78 码(含 M5001 v0.64 补登记;docs/diagnostics.md 可查) |
| LSP 语言服务器(诊断/hover/补全/跳转/符号) | ✅ | v0.5 诊断推送 + hover;**v0.58 三新查询**:补全(标识符/字段方法/模块成员/枚举变体/关键字;保守策略——类型推不出 → 空列表、语法不可修复 → null、注释与字符串内不补全)、跳转定义(模块项/局部绑定/跨文件 use;std 与内置 → null)、文档符号(fn/struct/enum/trait/const + impl 层级);非 ASCII 消息体按 Content-Length **字节**分帧;坏 JSON 体/空体帧存活;同步、零依赖、单文件协议实现;**未覆盖**:泛型/多文件补全与跨文件 impl 解析(保守不补)、incremental sync(全量重查)、语义 token/重命名 |
| 静态契约与证明(requires/ensures) | ✅ | v0.45–v0.55:requires/ensures/invariant 运行时检查(M4015);M3040/M3041/M3042/M3043/M3044 静态检查 + M3045/W3105 边界证明;**v0.55 跨函数契约摘要**——纯函数 + 全 i64 参数/返回 + 直线体 + 无环调用图的摘要(Tarjan SCC,被调方优先拓扑序),调用点线性前置证明(M3041 扩展)、后置条件假设(requires 完整且当前路径可证才采用已证 ensures;未证明前置条件绝不假设)、M3042 假设集扩展;`--proof-report` 输出每函数契约状态与调用点统计。**v0.56**:`ming fmt` 保留 requires/ensures/invariant(#36 数据丢失修复);契约尾部裸标识可解析(#33)。**v0.57 循环义务**:范围 for(`for i in lo..hi`)体内 `buf[i]` 义务两向证明(循环变量确定性符号 `i$<n>` + 半开区间假设入集;`buf[i+k]` 位移同口径;break/continue 不破坏不变式;反例枚举含循环符号);义务记录 additive `scope: body\|loop`;M3045/W3105 码与消息不变,proven 不消除运行时 M4003。**未覆盖**:分支敏感体、`while`/`loop`/嵌套 for、脏循环(体内改写外层变量)、递归/互递归、高阶/效果函数、堆/别名、通用 SMT;摘要与证明只报告,不消除运行时 M4015/M4003 |
| panic 调用栈 | ✅ | Ming 层栈 |
| 日志库(级别/开关) | ✅ | std.log(v0.28):debug/info/warn/error,set_level/get_level,阈值过滤,stderr 输出;无文件输出/结构化字段 |
| 错误链(cause) | ✅ | v0.30:join_detailed(Json {code,message,stack})、scoped 子 panic 真实码透传 + Panic.cause、诊断协议 cause 字段;顺带修复 panic 调用栈从未填充的缺口 |
| 任务超时/取消 | 🟡 | v0.31:join_detailed 超时可配(超时硬杀,Err M4010)+ cancel(硬杀,不可捕获);无协作取消/子任务自检 |
| 运行时资源熔断 | ✅ | v0.32:maxSteps + --max-alloc(M4011)+ --max-ms(M4012),子任务继承。**v0.60(#51–#53)门禁一致性**:计费 = 值创建 + 外部输入边界(fs/stdin/proc/net 结果按长度计费),派生值(deepCopy/json.parse/re.*/wasm 参数搬运)不重复计费;sleep/join/exec/http 受 `--max-ms` 钳制(超限 M4012);**进程内不可抢占边界具名**(read_line/read_to_end 的 stdin 阻塞、RegExp 回溯——诚实登记,不属可熔断面) |
| 密码学原语 | ✅ | v0.34/v0.36:std.crypto(Hash 五件套 + HMAC 五件套 + AES-256-CBC 加解密,能力 crypto);RSA/国密/字节流接口随后 |
| 位运算 | ✅ | checked 位运算(& \| ^ << >>)+ 位截断 as(全引擎一致,溢出语义显式) |
| 字节序/位域解包 | ✅ | v0.35:std.bin pack/unpack × u16/u32/u64 × le/be(纯函数,显式端序);位域与 struct packing 判定不做(设计记录 GUIDE std.bin 节) |
| 字节流正则 | ✅ | v0.36:std.re is_match_bytes/find_bytes/replace_bytes(latin1 无损桥接,\xNN 原始字节匹配) |
| FFI(外部函数接口) | ✅ | v0.42 兑现 + v0.43 字符串桥:extern "库" fn 声明(隐含 ffi 效果,M3029 门禁;JS 引擎 M4001 拒绝,C 后端 dlopen/dlsym,M4013)。**v0.54(C5)**:extern 签名接受/返回 Ptr[u8]/Ptr[mut u8](裸地址直传,emit-c 槽为 `const unsigned char*`/`unsigned char*`)。**已声明覆盖范围**:数值(i64/u64/f64)、str 参数/返回(ming_str ↔ NUL 结尾 C 串)、Result[i64,str] 进 C 面、Ptr 槽;**未覆盖**:结构体/数组 FFI ABI、运行时动态符号 API(`lib.fn`,Backlog 已删除) |
| 受控不安全指针(`with unsafe`) | ✅ | v0.54 C5:Ptr[mut u8]/Ptr[u8](仅 u8;mut 精确匹配)、load/store/offset/is_null、std.mem.alloc/free(malloc 失败 M4011);双门禁 = 签名 `with unsafe`(M3029 逐层传播)+ 块级 `unsafe { ... }`(M3046);仅 C 原生后端执行,tree/VM 与 wasm 回落以 M4016 panic(exit 101)。**未覆盖**:Ptr 算术(除 offset)、Ptr↔整数、带长度 Ptr/Slice、打印/相等、生命周期/逃逸分析、`unsafe(cond)`;悬垂/越界 UB 不捕获(诚实声明) |
| 数据流安全(污点标注 `Untrusted[T]`) | ✅ | v0.61 窄源 v1(ADR-002):编译期标签/运行时擦除(值即载体,四引擎输出与标注无关);**来源 = `env.get`/`read_line`/extern 返回强制 + v0.68 serve 载荷(ADR-004)**(fs/net/proc 内容源 str 污点 v1.2 不标——净 str 经 `json.parse` 重建净 Json 是两域接缝,泄漏窗口如实登记);sink 门禁免费(M3049 统一机制,21 槽位);操作面载体键控(v0.68):str 白名单 5 方法(parse_i64/parse_f64/char_len/byte_len/is_empty)+ Json 投影表(get/at → `Option[Untrusted[Json]]`、as_str → `Option[Untrusted[str]]` 载体收窄、as_num/as_bool/is_*/eq 净值、as_arr/as_obj 容器载荷保污),表外 M3050;`debug`/插值/`as` 洗白禁面 M3050;**v0.68 载体扩面(ADR-004)**:serve handler 形参 `fn(Untrusted[Json]) -> Json`(载荷整树标污,回显透传 M3049 免费拦截)、`json.stringify(Untrusted[Json])` → M3049(Json→str 唯一整体出口闭合)、`std.unstr.mark_json` 标脏入口;净化族 `std.unstr`(mark/mark_json/sanitize_path 拒绝绝对与盘符相对/`..`/空段、sanitize_cli_path 校验不改写,授权位 = 路径实参位 + CLI 匹配串;**净化器族不扩**——sanitize_json 不设);wasm/C 资格按载体解包(嵌套容器形参资格拒绝回落,输出一致);12 自举工具已迁移。**未覆盖**:`Untrusted[u8]`/argv 载体(v1.2+ 另裁决)、fs/net/proc 内容源 str 污点(v1.2)、流敏感/跨函数推断、净化的形式化证明 |
| 本地函数(块内 `fn`) | ✅ | v0.59(#44,M3047 移除):函数体内 `fn` 为**块级条目**——同块内声明前可调用、自递归与同块互递归、`requires`/`ensures` 按模块函数同口径执行(违反 M4015)、可作值传给 HOF;VM/tree/默认引擎一致,AOT 产物可序列化。**四条限制**:不捕获外层局部(引用 → M3001)、块级可见(离开声明块不可见)、泛型不支持(**M3048**)且 C 后端不支持(`C1 不支持该程序形态: 语句 FnStmt`)、静态证明面不含本地函数(运行时 M4015 仍执行) |
| WASM 分层覆盖面 | 🟡 | **v0.65 更新**:守护收口 slice 3(终章)——expect(字面量 msg 经 strConsts 索引穿越;变量/插值 msg 仍具名守护)、Map unwrap(`map_has` 导入先判定,缺键 `panic_m4006`)、Err unwrap/expect(objTable 句柄表示 + res_new/res_unwrap 导入族;Err(str/数值标量) 载荷 display 逐字)、Vec[str] 下标读(`vecstr_get` 宿主界检查)、下标复合赋值 `v[i] op=`(interp assignTo 双重求值口径;标量 `&=/\|=/^=` 顺带)真实经 wasm;**#59 嵌套直调栈帧兑现**(frame_push/frame_pop 调用点帧透传,main→f→g 三引擎 stderr 逐字,`at g` 帧回归;直调 +18% 信息性)——此前"已知残留:wasm→wasm 直调 panic 栈缺内层帧"由此消除;新导入 11 条(69→80 尾部追加零错位);strict 自造语料 18 程序(c01–c18)全 exit 0 残留 0;遗留登记:M4002 wasm 消息口径 vs tree 逐字分歧(HEAD 预存)、Map 下标复合赋值通用守护。v0.63 更新:守护收口 slice 2——数值 VecLit、Vec 下标读/mut 元素写(宿主 `panic_m4003`/`panic_m4003w`)、Option 数值 Vec `get(i).unwrap()` None 分支(`panic_m4006`)、f64 复合赋值真实经 wasm;VecLit 计费改为按元素数(与 interp 对齐);strict 新语料抽查 20 程序(G1 自造,非套件)19 存活 1 具名回落(exit 2 可读)。v0.32 复活 + v0.53 strict 三态(`--strict-wasm`);v0.56 修复 W1 一元负号栈序、W2 循环内 if 的 break/continue `br` 深度、F1 for 体内 continue 跳过自增、F2 `inferNumType` 重复 case(均有 `[wasm] fn OK` 存活断言);**v0.59 覆盖收口**:#40 f64 局部/混合槽序、#41 Map 形参、#42 Vec 多形参、#43 str 返回、#45 值型 if、#46 块尾 unit if 均真实经 wasm,并修 6 个潜伏 bug(strConsts 空串/VECMAP VOID/alloc 导入索引/map_get 顺序/移位 64/守护口径);严格语料 120 程序 **ok=54 / none=66 / fallback=0**。**已声明覆盖**:i64/u64/f64/str/Vec/Map 的 eligible 函数(数值比较/算术、for-in/while/if、值型 if、块尾 if、str 返回、调用、**v0.63 起数值 VecLit、Vec 下标读/mut 元素写、Option 数值 Vec unwrap、f64 复合赋值;v0.65 起 expect(字面量 msg)、Map/Err(Result 标量载荷) unwrap·expect、Vec[str] 下标读、下标复合赋值**;**不含 `match`**——实测 `REJECT: 表达式 Match`,C 行的 match 声明正确、不受影响);**剩余守护**(守护具名清零后余项,不影响语义;strict 模式可见且原因具名):unwrap_or/is_some/is_none(shape-eligible 具名回落)、expect 非字面量 msg(变量/插值)、Result 非标量载荷(容器/结构体/bool)、Vec[str] 元素写(登记不做)、Map 下标复合赋值(通用"赋值目标"守护)、`?` 运算符(不可达,注释登记)、Vec[str].get(i) 的 unwrap/expect 消费链(具名"Vec[str].get 侧待解锁")、Result 查询方法 is_ok/is_err/unwrap_err(未入消费链分发,通用"条件 Call/条件操作数"守护)、非局部接收者形态(Option 消费链守护具名"非局部接收者") |
| 原生 C 后端(C1–C5) | 🟡 | v0.39 C1(数值函数 → C + GCC -O2,资格分析与 wasm 同源;基准对标 wasm ~10x);v0.40 C2(str/Vec[i64]/match/for-in 值语义);v0.41 C3(Map/Option/f64 打印 + floatStr);v0.42 C4(extern fn FFI);v0.53 `str` for-in 按 UTF-8 码点迭代;v0.54 C5(`with unsafe`:Ptr → unsigned char*/const unsigned char*、alloc/free → malloc/free、extern Ptr 槽;C 专用资格旗标 `opts.unsafe` 仅 ming cc 路径);v0.56 无 C 面语义变化(修复集中在 tree/VM/wasm/fmt/构建键)。**已声明覆盖范围**:eligible 形态(数值/str/Vec[i64]/Map[str,i64]/Option[i64]/Result[i64,str]/ffi/unsafe 函数及其调用/for-in/match);**未覆盖**:插值串、结构体/数组 FFI ABI、交叉编译;不支持的语句形态在 C 发射期显式拒绝(报 `C1 不支持该程序形态` 并 exit 1);需另用 JS 引擎运行 |
| 内联汇编/直接 syscall | ❌ | 北星支柱 2:原生后端之后;经 `with unsafe` 门禁(效果系统即泛化 unsafe 块) |
| 海量并发网络(10 万级连接) | ❌ | 北星支柱 3:需 async/green-thread 运行时(与确定性语义的调和待设计) |
| L2/L3 原始包构造/嗅探 | ❌ | 北星支柱 3:原生后端之后;std.net 扩展 |
| eval/热重载 | ❌ | 北星支柱 4:解释器即库,eval 可作显式能力(`with eval`)落地,成本低于多数语言。**ADR-005 已裁决(2026-11-14,docs/adr-005-eval.md):显式能力/净 str 来源(污点 sink)/内层恒 VM/Err 化/热重载另 ADR;12 项评审清单,实现待全勾**——判定 ❌ 维持至实现 |
| 交叉编译静态二进制 | 🟡 | v0.38:ming build dist 可移植目录(源 + 运行时 + launcher,Node 零依赖即跑);v0.42 `ming cc --static` 同平台静态链接。**未覆盖**:跨 OS/跨架构交叉编译(明确不承诺) |

**覆盖率:v0.62 ≈ 84%**(口径:55 行,✅=1、🟡=0.5、❌=0 → **42✅ 8🟡 5❌**;(42 + 8×0.5) / 55 = 83.6% ≈84%)。北星立项把安全工具六大支柱纳入矩阵;v0.54 新增"受控不安全指针(`with unsafe`)"行(✅,C5 交付);v0.55 新增"静态契约与证明(requires/ensures)"行(✅,跨函数摘要交付),覆盖率与 v0.54(50 行 ≈81%)同口径;v0.56 新增"WASM 分层覆盖面"行(🟡),覆盖率按 52 行口径重算为 80.8% ≈81%。v0.57 契约/证明行补循环形态(证明面扩大,能力判定不变,无新增行,覆盖率与 v0.56 同口径);v0.58 新增 LSP 行(✅)并把"流式拼接 Builder"改判 🟡,覆盖率按 53 行口径重算为 82.1% ≈82%;v0.59 新增"本地函数"行(✅,M3047 移除)并更新 WASM 行(覆盖收口),覆盖率按 54 行口径重算为 82.4% ≈82%;2026-11-13 三方评估将"运行时资源熔断"由 ✅ 改判 🟡(有限口径,#51–#53);v0.60 交付(#51–#53 修复)后复核恢复 ✅(边界具名);v0.61 新增"数据流安全(污点标注)"行(✅,窄源 v1 交付),覆盖率按 55 行口径重算为 82.7% ≈83%;**v0.62"TCP/UDP/服务端"行由 ❌ 改判 🟡(服务端 v1 交付,定位内网/工具服务),覆盖率按 42✅ 8🟡 5❌ 重算为 83.6% ≈84%**;v0.63 wasm 守护收口(无新增行,覆盖率与 v0.62 同口径 84%);v0.65 wasm slice 3(无新增行,覆盖率与 v0.62 口径同 84%);v0.68 污点载体扩面(无新增行,覆盖率口径不变)。
