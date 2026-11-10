# Ming(�?编程语言

> **�?*——程序的含义必须和它写出来的一模一样。没有隐式转�?没有 null,没有静默溢出,没有隐藏的控制流�?

Ming 是一门为 **AI 与人类协�?* 设计的编程语言。它的每一个设计决定都在回答一个问�?*怎样让生成式 AI 更难写出错的代码,更容易被验证?*

## 为什么要�?Ming

AI 写代码的失败模式高度集中:隐式类型转换、真值化、null 传播、静默溢出、别名共享可变状态、忘不掉的分号歧义。人类语言的历史包袱把这些坑全部留给了 AI。Ming 从零开�?把这一整类问题**在语言层面消灭**,并把验证反馈做成机器可消费的协议:

```ming
fn main() {
    let name = "世界";
    let mut total = 0;
    for i in 1..11 {
        total += i;
    }
    print("你好, \{name}! 1..11 的和�?\{total}");
}
```

```bash
$ node bin/ming.js run examples/hello.ming
你好, 世界! 1..11 的和�?55

$ node bin/ming.js check examples/hello.ming --json
{ "ok": true, "diagnostics": [] }
```

## 核心特�?v0.39)

| 特�?| 说明 |
|------|------|
| **明确** | 无隐式转换、无 null(�?`Option[T]`)、无真值化、无操作符重载、`mut` 显式声明 |
| **效果系统** | 副作用必须显式声明并逐层传播:`fn f() with io, time { ... }`;纯函数是编译期可证明�?|
| **安全** | 整数溢出/除零/越界/缺键全部 panic(可预期、有位置、有错误�?;v0.2 程序**没有文件系统与网络能�?* |
| **值语�?* | 赋�?传参/捕获都是深拷�?结构共享不可能发生——没有别�?bug,没有数据竞争 |
| **trait + impl** | 用户类型的方法必须定义在 trait �?prelude 内置 `Eq` / `ToStr`;泛型 bound `[T: Eq]` 调用处校�?|
| **确定确定** | Map 保持插入序、求值顺序从左到右、溢出行为有定义、`ming fmt` 唯一风格 |
| **机器友好** | 所有工具支�?`--json`;稳定诊断�?M1xxx~M4xxx)�?hint;`ming doc` 提取文档 |
| **快速反�?* | `check` 秒级类型检�?内置 `test` �?`?` 错误传播;模式匹配穷尽性检�?|
| **双引�?* | 默认字节�?VM;`--tree` 树遍历对�?同一测试套锁定语义一�?|
| **工程�?* | ming.toml 项目模式(init/run/build/test)、LSP 服务�?诊断/hover)、number 快路�?|
| **泛型 impl** | `impl[A: Eq, B: Eq] Eq for Pair[A, B]`;bound 递归校验;Compare trait + Vec.min/max |
| **capability fs** | `std.fs` 文件系统�?fs 效果开放——碰磁盘的代码在签名上自�?|
| **capability net** | `std.net.http_get` / `http_request` �?net 效果开�?同步 HTTP(worker + Atomics 桥接) |
| **REPL** | `ming repl`:表达式回显、声明持久化、失败回滚、多行续�?|
| **指令融合** | 高频赋值单指令�?�?�?�?,溢出检查逐点保留 |
| **FFI(extern fn,`with ffi`)** | `extern "�? fn 符号(...) -> T;` 声明;调用方必须声�?ffi 效果(M3029 门禁);JS 引擎 M4001 诚实拒绝,C 后端 dlopen/dlsym 真调�?失败 M4013);`ming cc --static` 静态链�?|
| **JSON** | 动�?`Json` 类型 + 编译期序列化兼容性检�?parse 错误带位�?|
| **WASM 分层** | i64/u64/f64/str/Vec/Map 编译�?WebAssembly;线性内存统一语义(构�?拷贝/读写/返回);�?sum ~4x |
| **C 后端 C1/C2/C3** | `ming cc`:eligible 函数 �?C(GCC/Clang -O2),资格分析�?wasm 同源;panic 逐字对齐;C2 str/Vec[i64] 值语�?C3 Map/Option/f64 打印(floatStr 对齐);**cc 差分腿覆�?= 解释引擎全形�?*;�?sum/fib 场景�?wasm 再快 ~10x |
| **结构化并�?* | `spawn`(多参�?/`spawn_all`(批量)/`join`/`sync scope`(作用域自�?join):确定性并�?|
| **线性句�?* | Join 句柄禁入集合/struct(M3034);trait 方法调用点校�?impl bound |

## 快速开�?

需�?Node.js �?18(任何平台:Windows / macOS / Linux)�?

```bash
node bin/ming.js run examples/fizzbuzz.ming   # 运行
node bin/ming.js check your.ming --json       # 类型检�?JSON 协议)
node bin/ming.js test your.ming               # 运行 test �?
node bin/ming.js fmt your.ming --write        # 规范格式�?
node bin/ming.js doc your.ming                # 提取 /// 文档
node bin/ming.js cc your.ming                 # C 后端:编译为原生可执行(需 gcc/clang)
```

Windows 下也可以�?`bin\ming.cmd`�?

## 文档

- **[AGENTS.md](AGENTS.md)** �?AI 代理与本仓库协作的指�?硬规则、命令、提交规范、已知陷�?
- **[docs/plan.md](docs/plan.md)** �?实施计划(v0.45 起的版本范围、验收与 Backlog)
- **[docs/references.md](docs/references.md)** �?参考语言跟踪(Jenny / Blood 的地址、要点与进度查看方式)
- **[GUIDE.md](GUIDE.md)** �?使用指南(语法、类型、标准库、工具链、AI 使用建议)
- **[docs/design.md](docs/design.md)** �?设计哲学与语言规范要点
- **[docs/diagnostics.md](docs/diagnostics.md)** �?稳定诊断码表
- **[examples/](examples/)** �?可运行的示例程序

## 路线�?

- **v0.43** �?**ffi 字符串桥(str �?C �?+ Result[i64,str] �?C �?+ ffi 效果函数参与 C 编译**(资格基线修正:opt/res 形参入形状面;prelude 构造器不再误降级不动点)+ `with unsafe` 受限指针块设计定�?design.md §6.10)
*（本版同时并入另一窗口成果:�?AOT 字节码产物——ming build 默认纯字节码 dist,无明文源;--with-source 附源�?spawn/trait 自动回退源码模式�?
- **v0.44(当前)** �?**AI 协作护栏**(W3104 测试字面量过拟合检�?+ `--json` 结构化修复处�?fix + tools/diaghot.ming 诊断热力�?+ **mask 效果屏蔽设计定稿**(design.md §6.11)——受 Jenny/Blood 调研启发;连带修复 unify �?json 分支、VM match-return 栈残留两项真�?bug
- **v0.45(��ǰ)** �� ��Լϵͳ�׶� 1(requires/ensures ����ʱ���,VM+������һ��,M4015;invariant �﷨��֧��)
- **更远(北星对齐)** �?async 运行�?eval;RSA/国密

## 设计原则(全文�?design.md)

1. **明确优于简�?* —�?写出来的就是全部含义�?
2. **安全是默�?不是选项** —�?危险操作要么被检�?要么 panic,绝不静默�?
3. **副作用可�?* —�?效果签名说明一�?没标 `io` 的函数不可能打印,编译器保证�?
4. **确定�?* —�?同样的代码永远产生同样的行为(包括迭代顺序)�?
5. **为验证循环优�?* —�?AI 的核心工作方式是"生成 �?检�?�?修正",工具链必须为这个循环服务�?
6. **没有第二种写�?* —�?一种结构一个语�?`ming fmt` 是唯一风格�?

## 状�?

v0.42.0:字节�?VM + **WASM 分层(v0.39 真正复活)** + **C 后端 C1/C2/C3(ming cc:cc 差分�?= 解释引擎全形�?--static)** + **`with ffi` 兑现(extern fn 声明 + 效果门禁 + dlopen/dlsym)** + **自举工具 mingkit/engdiff(Ming 自写)** + 正则 + 结构化并�?+ **错误�?cause)** + **二进�?I/O + 任务超时/取消 + 资源熔断(--max-alloc/--max-ms)** + JSON + capability fs/net/sync/proc/env/rand/io + HTTP(响应�?超时可配)+ std.fmt(进制/精度/对齐)+ std.log + std.math 全函�?wasm 桥接)+ std.crypto(Hash/HMAC)+ std.bin(显式字节�?+ 字节流正�?+ AES-CBC/GCM + ming build 可移植产�? 时间日期 + 线性句�?+ 泛型 impl + REPL + 项目管理 + LSP。能力矩阵见 docs/capabilities.md(49 行口�?�?0%)。模糊基�?tests/fuzz.mjs(多后端差�?C 腿全形�?�?

