# Ming 稳定诊断码表(v0.15.0 起;维护至 v0.63.0)

诊断码是 Ming 工具链对外协议的一部分:**已发布的码含义不变**;新码只增不改。v0.27-v0.30 无新增码(错误链复用既有码面,新增可选字段)。
所有命令 `--json` 时输出 `{code, name, severity, message, file, line, col, endLine, endCol, hint?}`。

**运行时 panic 的错误链(v0.30)**:当 panic 由下级错误引起(scoped 块子任务 panic 传播到主任务),panic 诊断额外携带可选 `cause` 字段:

```json
{
  "code": "M4002", "message": "scoped 子任务失败: 整数+溢出: ...",
  "cause": {
    "code": "M4002",
    "message": "整数+溢出: ...",
    "stack": ["at victim (main.ming:4:1)"]
  }
}
```

文本格式对应 `Caused by <code>[<message>]` + 每帧 `  at 名 (file:line:col)`。`std.sync.join_detailed` 把同样的链以 Json 形态交给程序(`Err` 分支:`{code, message, stack}`)。cause 只增不改:无下级错误的 panic 不带该字段。

## M1xxx — 词法

| 码 | 名称 | 含义 |
|-----|------|------|
| M1001 | unexpected-character | 无法识别的字符 |
| M1002 | unterminated-string | 字符串/插值未闭合 |
| M1003 | invalid-number | 数字字面量或其后缀非法 |
| M1004 | invalid-escape | 非法转义(可用:\n \t \r \0 \\ \" \u{...} \{插值}) |
| M1005 | unterminated-comment | 块注释未闭合(支持嵌套) |
| M1006 | reserved-word | 使用了保留字(为未来版本预留) |

## M2xxx — 语法

| 码 | 名称 | 含义 |
|-----|------|------|
| M2001 | unexpected-token | 位置上不允许该 token(另复用于解析深嵌套守卫(v0.73):消息"表达式嵌套过深(>120 层)",语义为结构超限而非 token 错位) |
| M2002 | expected-token | 缺少期望的 token(常见:缺 `;`、缺 `}`、`==` 写成 `=`) |
| M2003 | invalid-pattern | 模式非法(let 只支持 名字/_/元组;可反驳模式用 match) |
| M2004 | invalid-lambda-params | 闭包参数必须是标识符 |
| M2005 | chained-comparison | 比较链禁止(`a < b < c` → 用 `&&`) |
| M2006 | duplicate-parameter | 重复的参数名 |
| M2007 | invalid-assignment-target | 赋值目标必须是 变量/字段/下标 |

## M3xxx — 类型与语义

| 码 | 名称 | 含义 |
|-----|------|------|
| M3001 | cannot-find-name | 名字未定义(带最近似建议)或跨模块不可见(非 pub) |
| M3002 | mismatched-types | 类型不匹配(Ming 没有隐式转换) |
| M3003 | cannot-infer-type | 无法推断(空集合/闭包参数/裸 None;加标注) |
| M3004 | assignment-to-immutable | 修改了非 mut 绑定(含会修改接收者的方法) |
| M3005 | wrong-arg-count | 参数个数不符 |
| M3006 | unknown-field | 结构体无此字段 / 该类型不支持字段访问 |
| M3007 | non-exhaustive-match | match 不穷尽(守卫分支不算覆盖) |
| M3008 | invalid-operands | 运算符不支持该操作数(bool 用 && ||;字符串只支持 +) |
| M3009 | duplicate-definition | 重复定义(项/字段/变体) |
| M3010 | break-outside-loop | break 在循环外 |
| M3011 | continue-outside-loop | continue 在循环外 |
| M3012 | cannot-interpolate-type | 插值只支持 int/float/bool/str(其他用 debug(x)) |
| M3013 | int-width-mismatch | 整数宽度/符号不匹配(用 as 显式转换) |
| M3014 | condition-not-bool | 条件不是 bool(没有真值化) |
| M3015 | unknown-method | 方法不存在(内置方法表见 GUIDE) |
| M3016 | shadowed-binding | 同层作用域重复绑定 |
| M3017 | missing-return | 有返回类型的函数存在不产生值的路径 |
| M3018 | generic-op-unavailable | 泛型参数上无操作(v0.1 泛型是参数化的;traits 在 v0.2) |
| M3019 | invalid-cast | as 只支持数值类型(str→数字用 parse_i64) |
| M3020 | cannot-index | str/元组不支持下标(用 get/chars/解构) |
| M3021 | not-callable | 调用了非函数值 |
| M3022 | unknown-import | 模块文件不存在或 std 模块名错误 |
| M3023 | missing-main | run 需要入口 main 函数(最多一个 `Vec[Untrusted[str]]` 参数——v0.82 ADR-008 元素级污点) |
| M3024 | unknown-variant | 枚举变体不存在 / 模式限定名不符 |
| M3025 | import-cycle | 模块循环导入 |
| M3026 | cannot-iterate | for 只支持 Vec / Map / str / Range |
| M3027 | missing-field | 结构体字面量缺字段(没有默认值) |
| M3028 | refutable-let-pattern | let 中使用可反驳模式(用 match / while let) |
| M3029 | undeclared-effect | 调用需要未声明的效果:给签名加 `with io, ...` 并逐层传播 |
| M3030 | unknown-effect | 未知效果名(当前可用:io / time / fs / net / sync / proc / env / rand / crypto / ffi / unsafe / eval / asm) |
| M3031 | const-not-constant | const 只接受常量表达式(字面量/运算/其他常量) |
| M3032 | trait-impl-mismatch | trait/impl 问题:缺方法、self 可变性不符、类型未实现 bound 的 trait、impl 类型参数未覆盖目标参数 |
| M3034 | join-handle-escapes | Join 句柄存入集合/struct 字段/元组/enum 载荷,或作为 spawn 参数/返回(线性资源) |
| M3033 | not-json-serializable | 类型不能 JSON 序列化(仅 int/float/bool/str/Vec/Map[str,T]/Option/元组/Json) |
| M5001 | invalid-manifest | ming.toml 清单解析错误(缺 [project]/name、值非法) |

## W3xxx — 警告(不阻断)

| 码 | 名称 | 含义 |
|-----|------|------|
| W3101 | unused-variable | 变量未使用(`_` 前缀或 `let _ =` 消除) |
| W3102 | float-equality | 浮点 `==` 精度风险(常用 `abs(a-b) < eps`) |
| W3103 | unreachable-code | 不可达代码 |
| W3104 | test-literal-overfit | 测试断言中的字面量出现在实现函数的分支条件中(可能针对测试硬编码;W 级不阻断)(v0.44) |
| W3105 | index-bounds-unproven | `--warn-unproven-index` 下:Vec 索引义务(`0 <= i` 且 `i < len$buf`)无法由 requires 线性边界静态证明(是"无法证明"而非"确定越界";循环/分支/非线性/mut Vec/无 requires 一律静默;文件已有 error 诊断时不叠加;默认不启用;v0.52) |

## M4xxx — 运行时 panic(退出码 101)

| 码 | 名称 | 含义 |
|-----|------|------|
| M4001 | panic | panic("...") 或内部不变量 |
| M4002 | integer-overflow | 整数溢出/移位越界(算术全程检查) |
| M4003 | index-out-of-bounds | Vec 索引越界 / slice 越界(用 .get(i) 得 Option) |
| M4004 | division-by-zero | 整数除零/取模零 |
| M4005 | stack-overflow | 递归过深(>250 层;建议改写为循环) |(另复用于编译管线深度守卫(v0.75):消息"表达式/插值/类型/模式/常量表达式嵌套过深(>N 层)"五变体——阈值 450/950/1450/2000/1200 实测二分校准,编译期拒绝而非运行时 panic)
| M4006 | unwrap-failed | 对 None/Err 调用 unwrap / expect |
| M4007 | missing-key | map 下标缺键(用 .get(k) 得 Option) |
| M4008 | assertion-failed | assert / assert_eq 失败(附两侧 debug 值) |
| M4010 | task-timeout | 子任务超时/已取消(join_detailed 超时参数、cancel 后 join;以 Err 值的 code 字段出现,非 panic;v0.30 起) |
| M4011 | alloc-quota-exceeded | 内存配额超限:累计分配估算超过 --max-alloc(v0.32;估算口径非 RSS)。计费 = 值创建(Vec/Map 元素 + str 字符)+ 外部输入边界(fs/stdin/proc/net 的结果按返回内容长度计费:read_file 按 stat size 预记账、read_bytes 按 size、read_line/read_to_end 按结果长度、list_dir 按条目数、proc.exec 按 stdout+stderr、http 按响应体长度;v0.60);派生值(deepCopy/json.parse/re.*/wasm 参数搬运)不重复计费。v0.54 起 C 后端 `std.mem.alloc` 的 malloc 返回 NULL 也复用本码(消息"内存分配失败:std.mem.alloc(N) 返回 NULL",不伪装 null) |
| M4012 | time-quota-exceeded | 执行时间超过 --max-ms 墙钟上限(按步数取模轮询熔断;v0.32);v0.60 起阻塞内建(sleep/join/join_detailed/spawn_all/sync scope/exec/http)的等待钳到剩余预算,预算已尽不等待、唤醒后立即熔断;进程内不可抢占边界:read_line/read_to_end 的 stdin 阻塞与 RegExp 回溯不受 --max-ms 中断 |
| M4013 | ffi-load-failed | v0.42 启用:extern fn 库加载/符号查找失败(C 后端启动绑定阶段,退出码 101) |
| M4014 | ffi-signature-invalid | v0.39 预留(未启用):ffi 签名与目标符号不符 |
| M4015 | contract-violation | v0.45:契约违反(requires/ensures),退出码 101 |
| M4016 | native-only-feature | v0.54:tree/VM 执行 `std.mem.alloc/free` 或指针读写(`p.load/store/offset`;经 `std.mem.alloc` 取得的 Ptr 在 alloc 处即拒绝,extern Ptr 在 JS 桩体处拒绝)时 panic;消息"unsafe 指针操作仅在 C 原生后端可用",退出码 101,三路(tree / VM / wasm 回落 VM)首行逐字一致。C 原生后端由 C5(v0.54)兑现:Ptr[mut u8]/Ptr[u8] → `unsigned char*`/`const unsigned char*`;C5 资格旗标 `opts.unsafe` 仅在 `ming cc` 路径放行,wasm 保持严格拒绝 |
| M4017 | asm-cc-only | v0.74(ADR-006 内联汇编):非 cc 引擎执行 `asm { ... }` 块时 panic——内联汇编仅由 C 原生后端执行;消息"内联汇编仅由 C 原生后端(ming cc)执行;tree/VM 不伪装机器语义",退出码 101,三路(run / --no-wasm / --tree)首行逐字一致(M4016 unsafe 先例句式);`with asm` 声明本身不触发,未执行 asm 块的路径在 tree/VM 正常运行,含 asm 函数永不 wasm eligible(回落 VM 后执行到块同码)。C 原生后端由 C6 资格旗标(asmEffectsAllowed,仅 `ming cc` 路径放行——C5 unsafe 先例)兑现:发射 `__asm__ volatile(...)`(volatile 固定)。**号段注记**:M4017 曾于 v0.64 作 FFI 架构提案、经安全实测否决存档且从未发布——v0.74 复用登记,号段无已发布码冲突 |
| M3040 | invariant-field-protected | 带 invariant 的 struct 字段只能在自身 impl 方法内修改(v0.46) |
| M3041 | contract-violated-at-call | 调用点静态契约违反:整数字面量实参代入 requires 可判定为假;或实参可线性化(当前函数的参数/局部线性形式;被调须全 i64 形参、非泛型、非 extern)时,代入被调 requires 的违反条件在当前 requires 假设下可证(含被调参数小值反例);不可证/不可编码静默(v0.46;线性实参扩展 v0.55) |
| M3042 | ensures-statically-false | ensures 直线体符号执行可静态证伪(含反例);v0.55 起假设集 = 本函数 requires + 已验证调用后置条件(纯函数 + 全 i64 + 直线体 + 无环调用图;被调 requires 完整且当前路径可证才采用其 ensures,反例须满足假设集;未证明前置条件的调用结果按 unknown 静默)(v0.48 QF_LIA 第一片;v0.55 跨函数扩展) |
| M3043 | contract-not-pure | 契约表达式必须是纯表达式:requires/ensures/invariant 中调用 mut 方法(Vec/Map 原地方法或 mut self 方法)(v0.51) |
| M3044 | invalid-map-key | Map 键类型必须是 int/float/bool/str(Vec/struct/enum 键无值语义相等)(v0.51.4) |
| M3045 | index-bounds-violated | 静态边界证明(QF_LIA 第二片):在 requires 线性边界 + 直线体下,Vec 索引义务(`0 <= i` 或 `i < len$buf`,len$x 为非 mut `Vec[i64]` 参数的长度符号)被可证违反——所有满足 requires 的调用都会 M4003 panic;含小值反例(i64 参数 ∈ {-2..2}、len$x ∈ 0..8 确定性枚举;反例满足完整 requires——按被跳过但可求值的 requires 叶子过滤,无候选则不给反例)。未证明不报告;requires 自相矛盾(负环)整函数跳过;不改运行时语义(v0.52) |
| M3046 | unsafe-context-required | v0.54:指针操作(`p.load/store/offset`、`std.mem.alloc/free`)、Ptr 实参传递给非 extern 函数,或把含 Ptr 的值装进容器/构造器(`Vec.push/insert/extend`、`Map.set`/Map 字面量、`Some/Ok/Err` 等变体、元组/结构体字面量;判定为递归类型谓词 `typeContainsPtr`,含 Ptr 的容器传给普通函数同样拒绝),出现在 `unsafe { ... }` 块外;所在函数还必须声明 `with unsafe`(缺效果声明报 M3029)。块外只允许 let/赋值/return 传递与 `p.is_null()` |
| M3047 | local-fn-unsupported | **已废弃(v0.59,#44 本地函数恢复)**:v0.56 曾对本地函数声明统一显式拒绝(VM 无编译路径);v0.59 起三引擎支持本地函数(块级条目语义:同块可见、递归/互递归、requires/ensures 按模块函数同口径),此码不再发射。号段按"已发布码不改号"保留,登记废弃以免复用 |
| M3048 | generic-local-fn-unsupported | v0.59 P2 审查:本地函数声明带类型参数(泛型本地函数)——本地函数编译为独立函数帧、三引擎均不做单态化,在声明处拒绝(不再复用 M3003 的"类型推断失败"码义);块内调用点按毒化签名(never)收敛,不再级联 `str(...实际是 T)`。修复:把泛型函数声明在模块级,或去掉本地函数的类型参数 |
| M3049 | untrusted-mismatch | v0.61(ADR-002 污点标注;v0.68 载体扩面 {str, Json},ADR-004;**v0.77 内容源扩面 + 出向透传,ADR-007**):`Untrusted[T]` 实参进入未显式接受 Untrusted 的槽——函数/方法实参、`let` 标注、赋值、return/块尾、Map 键/值、Vec 元素、结构体字段、extern 实参等一切"期待 T 实际 Untrusted[T]"的位置(sink 免费门禁:未显式接受 Untrusted 的位置全是 sink);典型槽(v0.68):`json.stringify(Untrusted[Json])`(Json→str 唯一整体出口,类型层闭合)、serve 回显透传(污子值直接进响应 `Map[str, Json]` 构造);**典型槽(v0.77)**:`proc.exec` 的 cmd/args(命令注入 sink)、`net.http_request` 的 headers(头注入 sink)、净目标 `+=` 污值(复合赋值洗白旁路)、`str(u)` 显示位、`debug`/插值维持 M3050;**出向透传位不再是 sink(v0.77)**:`print`/`print_raw`/`eprint` 的 Untrusted[str] 实参合法(存储面,污值写出)、`fs.write_file/append_file` 内容与 `write_bytes/append_bytes` 数据合法(污值合法写盘)、`std.str.index_of` hay 合法(纯计算)——`Untrusted[Json]`/`Untrusted[Vec[u8]]` 进 print 族仍报此码(先投影);extern 声明写裸 `-> str` 返回同样报此码(C 世界返回值没有可信的,签名须写 `-> Untrusted[str]`);**v0.82(ADR-008):`fn main` 的 args 形参声明净 `Vec[str]` 同样报此码**(OS argv 元素级必污,须写 `Vec[Untrusted[str]]`,一次到位不留 clean 旁路;uniform 对任何模块级 `fn main` 生效)。反向(期待 Untrusted、实参裸载体)报 M3002——必须显式 `std.unstr.mark`(str)/ `mark_json`(Json)。修复(hint 载体感知):str 载体先过 `std.unstr.sanitize_path` / `sanitize_cli_path`(纯函数,返回 `Result[str, str]`);Json 载体经 `.as_str()` 投影出 `Untrusted[str]` 后净化(GUIDE §18 投影表);**Map 载体(v0.82)无净化器——经投影表只读消费(get/has/keys/values)或把目标改声明为 `Untrusted[Map[str, str]]`**;或把形参改声明为对应 `Untrusted[T]` |
| M3050 | untrusted-method-forbidden | v0.61(ADR-002 污点标注;v0.68 载体扩面,ADR-004;**v0.77 污值代数,ADR-007 清单 4**;**v0.82 第四载体 Map,ADR-008**):Untrusted 的操作面禁例——① 载体方法白名单之外的任何方法在污接收者上调用(str 载体的白名单 = **污值代数 28 方法**(clean 13/keep 10/keepVec 2/keepOpt 1/keepBytes 2,逐函数裁决见 checker UNTRUSTED_STR_ALGEBRA);Vec[u8] 载体 = `len`/`is_empty`;**Map[str,str] 载体(v0.82)投影表 = `len`/`is_empty`/`get`(净键)/`has`(净键)/`keys`/`values`,mut 面(set/delete/clear 等)v1.3 只读全拒**);② 洗白通道:`debug(x)`(实参含 Untrusted,容器/struct 载荷递归判定)、字符串插值 `\{u}`、`as`/`str()` 转换;③ 类型声明 `Untrusted[非 {str, Json, Vec[u8], Map[str,str]}]`(如 `Untrusted[u8]` 原始字节载体)或 `Untrusted[Untrusted[str]]`(载体 v0.82 起 {str, Json, Vec[u8], Map[str,str]},其余载体另行裁决;键级混合载体 `Map[Untrusted[str],T]` 不支持——键污只经整表载体表达);④(v0.68)`Untrusted[Json]` 接收者调用投影表外方法(投影表:get/at/as_str/as_num/as_bool/as_arr/as_obj/is_*/eq,见 GUIDE §18);⑤(v0.82)`Untrusted[Map]` 接收者调用投影表外方法(含 `clone`/`items`——clone 返回净 Map 是洗白通道,排除)。产出净 str 的唯一出口是 `std.unstr.sanitize_path` / `sanitize_cli_path`(净化 = 类型跃迁单点可信根;Json 载体经 `as_str` 投影出污 str 后净化,净值出口为 as_num/as_bool/is_*/eq) |
| M3051 | slice-escape | v0.87(ADR-009 S2,切片只读视图):Slice 视图违反块内线性契约或构造规则——① 构造规则(ADR-009 §2.2 硬约束 1):`.view()` 的接收者必须是**非 mut 的 Vec[u8] 绑定名**(局部 let 绑定/非 mut 形参/常量);mut 绑定、表达式/字段/下标接收者、非 u8 Vec(`Vec[i64]`/`Vec[str]` 等)一律拒绝——值语义下非 mut 绑定的存储在作用域内不可变,视图无别名写面;② 块内线性(硬约束 2):视图不可 `return`、不可存入 Vec 元素/Map 值/结构体字段/枚举变体载荷/元组成分、不可作为函数/方法/std/内建实参(`debug(x)`/`print` 同面)、不可再绑定(`let s2 = s`)或赋值(`s2 = s`)、不可被闭包捕获(checker 在 lambda 边界上溯作用域链判定)、不可出现在函数形参/返回类型(顶层 fn/trait 方法/impl 方法/本地函数签名四发射点)——逃逸即悬垂风险(无借用检查器的语言里,底层 Vec 可能先死),线性约束把生命周期钉在词法块内;③ 方法面(硬约束 3):`len()`/`get(i)`/`at(i)` 白名单之外的方法调用报 M3015(不走本码);唯一构造入口 = 非 mut `Vec[u8]` 的 `v.view(start, len)`,运行时越界报 M4003 视图变体(`视图越界:长度 <n>,start+len <s+l>` / `视图越界:长度 <n>,访问 <i>`)。修复:视图只在创建它的块内就地消费(`len`/`get`/`at`);需要跨块/跨函数的数据用 `.slice(start, len)`(拷贝语义)或 `.to_vec()` 形态显式复制 |

## 约定

- 运行时 panic 输出含:Ming 源码位置 + 调用栈(最新在前)。
- `run` 的 main 返回 `i64` 可自定义退出码;工具自身错误退出码 2 属于工具链 bug,请报告。
