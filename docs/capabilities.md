# Ming 能力矩阵(v0.38 基线审计;当前 v0.58.0)

> 本表是 v0.38 时的全面审计。v0.39–v0.58 的能力增量以 `GUIDE.md` 修订记录为准;v0.56 已复核 C/wasm 覆盖面并重算覆盖率;v0.57 契约/证明行补循环形态(无新增矩阵行);v0.58 新增 LSP 行(✅)并把流式拼接行按 join 口径改判 🟡。

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
| TCP/UDP/服务端 | ❌ | — |

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
| 诊断协议(错误码+位置+hint+JSON) | ✅ | src/diag.js CODES 71 码(含 M4013);docs/diagnostics.md 可查 |
| LSP 语言服务器(诊断/hover/补全/跳转/符号) | ✅ | v0.5 诊断推送 + hover;**v0.58 三新查询**:补全(标识符/字段方法/模块成员/枚举变体/关键字;保守策略——类型推不出 → 空列表、语法不可修复 → null、注释与字符串内不补全)、跳转定义(模块项/局部绑定/跨文件 use;std 与内置 → null)、文档符号(fn/struct/enum/trait/const + impl 层级);非 ASCII 消息体按 Content-Length **字节**分帧;坏 JSON 体/空体帧存活;同步、零依赖、单文件协议实现;**未覆盖**:泛型/多文件补全与跨文件 impl 解析(保守不补)、incremental sync(全量重查)、语义 token/重命名 |
| 静态契约与证明(requires/ensures) | ✅ | v0.45–v0.55:requires/ensures/invariant 运行时检查(M4015);M3040/M3041/M3042/M3043/M3044 静态检查 + M3045/W3105 边界证明;**v0.55 跨函数契约摘要**——纯函数 + 全 i64 参数/返回 + 直线体 + 无环调用图的摘要(Tarjan SCC,被调方优先拓扑序),调用点线性前置证明(M3041 扩展)、后置条件假设(requires 完整且当前路径可证才采用已证 ensures;未证明前置条件绝不假设)、M3042 假设集扩展;`--proof-report` 输出每函数契约状态与调用点统计。**v0.56**:`ming fmt` 保留 requires/ensures/invariant(#36 数据丢失修复);契约尾部裸标识可解析(#33)。**v0.57 循环义务**:范围 for(`for i in lo..hi`)体内 `buf[i]` 义务两向证明(循环变量确定性符号 `i$<n>` + 半开区间假设入集;`buf[i+k]` 位移同口径;break/continue 不破坏不变式;反例枚举含循环符号);义务记录 additive `scope: body\|loop`;M3045/W3105 码与消息不变,proven 不消除运行时 M4003。**未覆盖**:分支敏感体、`while`/`loop`/嵌套 for、脏循环(体内改写外层变量)、递归/互递归、高阶/效果函数、堆/别名、通用 SMT;摘要与证明只报告,不消除运行时 M4015/M4003 |
| panic 调用栈 | ✅ | Ming 层栈 |
| 日志库(级别/开关) | ✅ | std.log(v0.28):debug/info/warn/error,set_level/get_level,阈值过滤,stderr 输出;无文件输出/结构化字段 |
| 错误链(cause) | ✅ | v0.30:join_detailed(Json {code,message,stack})、scoped 子 panic 真实码透传 + Panic.cause、诊断协议 cause 字段;顺带修复 panic 调用栈从未填充的缺口 |
| 任务超时/取消 | 🟡 | v0.31:join_detailed 超时可配(超时硬杀,Err M4010)+ cancel(硬杀,不可捕获);无协作取消/子任务自检 |
| 运行时资源熔断 | ✅ | v0.32:maxSteps + --max-alloc(M4011)+ --max-ms(M4012),子任务继承;配额为累计分配估算口径 |
| 密码学原语 | ✅ | v0.34/v0.36:std.crypto(Hash 五件套 + HMAC 五件套 + AES-256-CBC 加解密,能力 crypto);RSA/国密/字节流接口随后 |
| 位运算 | ✅ | checked 位运算(& \| ^ << >>)+ 位截断 as(全引擎一致,溢出语义显式) |
| 字节序/位域解包 | ✅ | v0.35:std.bin pack/unpack × u16/u32/u64 × le/be(纯函数,显式端序);位域与 struct packing 判定不做(设计记录 GUIDE std.bin 节) |
| 字节流正则 | ✅ | v0.36:std.re is_match_bytes/find_bytes/replace_bytes(latin1 无损桥接,\xNN 原始字节匹配) |
| FFI(外部函数接口) | ✅ | v0.42 兑现 + v0.43 字符串桥:extern "库" fn 声明(隐含 ffi 效果,M3029 门禁;JS 引擎 M4001 拒绝,C 后端 dlopen/dlsym,M4013)。**v0.54(C5)**:extern 签名接受/返回 Ptr[u8]/Ptr[mut u8](裸地址直传,emit-c 槽为 `const unsigned char*`/`unsigned char*`)。**已声明覆盖范围**:数值(i64/u64/f64)、str 参数/返回(ming_str ↔ NUL 结尾 C 串)、Result[i64,str] 进 C 面、Ptr 槽;**未覆盖**:结构体/数组 FFI ABI、运行时动态符号 API(`lib.fn`,Backlog 已删除) |
| 受控不安全指针(`with unsafe`) | ✅ | v0.54 C5:Ptr[mut u8]/Ptr[u8](仅 u8;mut 精确匹配)、load/store/offset/is_null、std.mem.alloc/free(malloc 失败 M4011);双门禁 = 签名 `with unsafe`(M3029 逐层传播)+ 块级 `unsafe { ... }`(M3046);仅 C 原生后端执行,tree/VM 与 wasm 回落以 M4016 panic(exit 101)。**未覆盖**:Ptr 算术(除 offset)、Ptr↔整数、带长度 Ptr/Slice、打印/相等、生命周期/逃逸分析、`unsafe(cond)`;悬垂/越界 UB 不捕获(诚实声明) |
| WASM 分层覆盖面 | 🟡 | v0.32 复活 + v0.53 strict 三态(`--strict-wasm`);v0.56 修复 W1 一元负号栈序、W2 循环内 if 的 break/continue `br` 深度、F1 for 体内 continue 跳过自增、F2 `inferNumType` 重复 case(均有 `[wasm] fn OK` 存活断言)。**已声明覆盖**:i64/u64/f64/str/Vec/Map 的 eligible 函数(数值比较/算术、for-in/while/if、调用;**不含 `match`**——实测 `REJECT: 表达式 Match`,C 行的 match 声明正确、不受影响);**剩余回落形态**(不影响语义;strict 模式可见):f64 局部/Map 字面量的 locals 索引偏移(#40:违规函数 REJECT,同模块其他函数仍可经 wasm 执行)、Map 形参 `slotTypes` 记 i64 致 for-in Map 回落(#41)、Vec 形参多枚/与 f64 形参组合时 locals 类型错位(#42;后位单个 Vec 形参实测 OK)、str 返回函数 `retTy` 映射 i64(#43) |
| 原生 C 后端(C1–C5) | 🟡 | v0.39 C1(数值函数 → C + GCC -O2,资格分析与 wasm 同源;基准对标 wasm ~10x);v0.40 C2(str/Vec[i64]/match/for-in 值语义);v0.41 C3(Map/Option/f64 打印 + floatStr);v0.42 C4(extern fn FFI);v0.53 `str` for-in 按 UTF-8 码点迭代;v0.54 C5(`with unsafe`:Ptr → unsigned char*/const unsigned char*、alloc/free → malloc/free、extern Ptr 槽;C 专用资格旗标 `opts.unsafe` 仅 ming cc 路径);v0.56 无 C 面语义变化(修复集中在 tree/VM/wasm/fmt/构建键)。**已声明覆盖范围**:eligible 形态(数值/str/Vec[i64]/Map[str,i64]/Option[i64]/Result[i64,str]/ffi/unsafe 函数及其调用/for-in/match);**未覆盖**:插值串、结构体/数组 FFI ABI、交叉编译;不支持的语句形态在 C 发射期显式拒绝(报 `C1 不支持该程序形态` 并 exit 1);需另用 JS 引擎运行 |
| 内联汇编/直接 syscall | ❌ | 北星支柱 2:原生后端之后;经 `with unsafe` 门禁(效果系统即泛化 unsafe 块) |
| 海量并发网络(10 万级连接) | ❌ | 北星支柱 3:需 async/green-thread 运行时(与确定性语义的调和待设计) |
| L2/L3 原始包构造/嗅探 | ❌ | 北星支柱 3:原生后端之后;std.net 扩展 |
| eval/热重载 | ❌ | 北星支柱 4:解释器即库,eval 可作显式能力(`with eval`)落地,成本低于多数语言 |
| 交叉编译静态二进制 | 🟡 | v0.38:ming build dist 可移植目录(源 + 运行时 + launcher,Node 零依赖即跑);v0.42 `ming cc --static` 同平台静态链接。**未覆盖**:跨 OS/跨架构交叉编译(明确不承诺) |

**覆盖率:v0.58.0 ≈ 82%**(口径:53 行,✅=1、🟡=0.5、❌=0 → 40✅ 7🟡 6❌;(40 + 7×0.5) / 53 = 82.1% ≈82%)。北星立项把安全工具六大支柱纳入矩阵;v0.54 新增"受控不安全指针(`with unsafe`)"行(✅,C5 交付);v0.55 新增"静态契约与证明(requires/ensures)"行(✅,跨函数摘要交付),覆盖率与 v0.54(50 行 ≈81%)同口径;v0.56 新增"WASM 分层覆盖面"行(🟡:v0.56 修复四个语义缺陷,如实列出剩余回落形态 #40–#43),覆盖率按 52 行口径重算为 80.8% ≈81%。v0.56 审计更新 C 后端/wasm 行与契约行(fmt 保真);v0.57 契约/证明行补循环形态(证明面扩大,能力判定不变,无新增行,覆盖率与 v0.56 同口径);v0.58 新增 LSP 行(✅,三新查询交付)并把"流式拼接 Builder"改判 🟡(std.str.join 单次 O(n);流式 Builder 本身仍 ❌,如实说明),覆盖率按 53 行口径重算为 82.1% ≈82%。
