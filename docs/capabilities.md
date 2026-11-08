# Ming 能力矩阵(v0.32.0)

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
| 流式拼接 Builder | ❌ | + 每次全量拷贝 |
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
| 诊断协议(错误码+位置+hint+JSON) | ✅ | 40+ 码 |
| panic 调用栈 | ✅ | Ming 层栈 |
| 日志库(级别/开关) | ✅ | std.log(v0.28):debug/info/warn/error,set_level/get_level,阈值过滤,stderr 输出;无文件输出/结构化字段 |
| 错误链(cause) | ✅ | v0.30:join_detailed(Json {code,message,stack})、scoped 子 panic 真实码透传 + Panic.cause、诊断协议 cause 字段;顺带修复 panic 调用栈从未填充的缺口 |
| 任务超时/取消 | 🟡 | v0.31:join_detailed 超时可配(超时硬杀,Err M4010)+ cancel(硬杀,不可捕获);无协作取消/子任务自检 |
| 运行时资源熔断 | ✅ | v0.32:maxSteps + --max-alloc(M4011)+ --max-ms(M4012),子任务继承;配额为累计分配估算口径 |

**覆盖率:v0.32.0 ≈ 90%**(口径:38 行,✅=1、🟡=0.5、❌=0 → 32✅ 3🟡 3❌;v0.31 ≈88%)。v0.33 方向:wasm for-in 元素加载错值根因、模糊测试。剩余 🟡/❌ 的硬限制与"不做"判定见各表。
