# Ming 稳定诊断码表(v0.15.0 起;维护至 v0.32.0)

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
| M2001 | unexpected-token | 位置上不允许该 token |
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
| M3023 | missing-main | run 需要入口 main 函数(最多一个 Vec[str] 参数) |
| M3024 | unknown-variant | 枚举变体不存在 / 模式限定名不符 |
| M3025 | import-cycle | 模块循环导入 |
| M3026 | cannot-iterate | for 只支持 Vec / Map / str / Range |
| M3027 | missing-field | 结构体字面量缺字段(没有默认值) |
| M3028 | refutable-let-pattern | let 中使用可反驳模式(用 match / while let) |
| M3029 | undeclared-effect | 调用需要未声明的效果:给签名加 `with io, ...` 并逐层传播 |
| M3030 | unknown-effect | 未知效果名(当前可用:io / time) |
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

## M4xxx — 运行时 panic(退出码 101)

| 码 | 名称 | 含义 |
|-----|------|------|
| M4001 | panic | panic("...") 或内部不变量 |
| M4002 | integer-overflow | 整数溢出/移位越界(算术全程检查) |
| M4003 | index-out-of-bounds | Vec 索引越界 / slice 越界(用 .get(i) 得 Option) |
| M4004 | division-by-zero | 整数除零/取模零 |
| M4005 | stack-overflow | 递归过深(>250 层;建议改写为循环) |
| M4006 | unwrap-failed | 对 None/Err 调用 unwrap / expect |
| M4007 | missing-key | map 下标缺键(用 .get(k) 得 Option) |
| M4008 | assertion-failed | assert / assert_eq 失败(附两侧 debug 值) |
| M4010 | task-timeout | 子任务超时/已取消(join_detailed 超时参数、cancel 后 join;以 Err 值的 code 字段出现,非 panic;v0.30 起) |
| M4011 | alloc-quota-exceeded | 内存配额超限:累计分配(元素/字符口径)超过 --max-alloc(v0.32) |
| M4012 | time-quota-exceeded | 执行时间超过 --max-ms 墙钟上限(v0.32) |
| M4013 | ffi-load-failed | v0.39 预留(未启用):`with ffi` 库加载/符号查找失败 → Err 载体码 |
| M4014 | ffi-signature-invalid | v0.39 预留(未启用):ffi 签名与目标符号不符 |

## 约定

- 运行时 panic 输出含:Ming 源码位置 + 调用栈(最新在前)。
- `run` 的 main 返回 `i64` 可自定义退出码;工具自身错误退出码 2 属于工具链 bug,请报告。
