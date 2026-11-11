# Ming(明)使用指南

**版本:v0.51.5** · 字节码 VM + WASM 分层 + **C 后端 C1–C4**(ming cc:数值/str/Vec/Map/Option/f64 + extern fn FFI;--static)+ **契约系统**(M4015/M3040/M3041/M3042/M3043/M3044)+ **ABI 哈希构建缓存**(ming build;--clean-cache)+ **自举工具 12 个 + ming tools 统一入口** + JSON + 正则 + capability fs/net/sync/proc/env/rand/crypto + HTTP + std.fmt/log/math/crypto/bin + 线性句柄 + 泛型 impl + REPL · 需要 Node.js ≥ 18(Windows / macOS / Linux;C 后端另需 gcc/clang)

> Ming 的承诺:**程序的含义必须和它写出来的一模一样**。没有隐式转换,没有 null,没有静默溢出,没有隐藏的控制流。

---

## 目录

1. [快速开始](#1-快速开始)
2. [程序结构与第一个程序](#2-程序结构与第一个程序)
3. [变量、类型与可变性](#3-变量类型与可变性)
4. [运算符与求值规则](#4-运算符与求值规则)
5. [控制流](#5-控制流)
6. [函数与闭包](#6-函数与闭包)
7. [结构体与枚举](#7-结构体与枚举)
8. [模式匹配](#8-模式匹配)
9. [错误处理:Result、Option 与 ?](#9-错误处理resultoption-与-)
10. [集合:Vec 与 Map](#10-集合vec-与-map)
11. [字符串](#11-字符串)
12. [泛型](#12-泛型)
13. [trait 与 impl:用户类型的方法](#13-trait-与-impl用户类型的方法)
14. [效果系统:副作用显式化](#14-效果系统副作用显式化)
15. [常量 const](#15-常量-const)
16. [模块与可见性](#16-模块与可见性)
17. [测试](#17-测试)
18. [标准库参考](#18-标准库参考)
19. [工具链](#19-工具链)
20. [给 AI 的使用建议](#20-给-ai-的使用建议)
21. [从其他语言迁移:常见错误对照](#21-从其他语言迁移常见错误对照)
22. [语义规范要点](#22-语义规范要点)
23. [路线图](#23-路线图)
24. [修订记录](#24-修订记录)

---

## 1. 快速开始

```bash
# 运行(在仓库根目录)
node bin/ming.js run examples/hello.ming

# 类型检查(秒级,不运行)
node bin/ming.js check your.ming --json

# 运行测试块
node bin/ming.js test your.ming

# 规范格式化
node bin/ming.js fmt your.ming --write
```

Windows 下可用 `bin\ming.cmd`;或 `npm link` 后直接使用 `ming` 命令。

**所有命令都支持 `--json`**,输出结构化诊断与结果——这是给工具和 AI 消费的协议(见 §16)。

---

## 2. 程序结构与第一个程序

```ming
// 普通注释
/// 文档注释:被 ming doc 提取

use std.math;   // 导入标准库模块(也可直接写 std.math.sqrt(...))

fn main() with io {   // print 是副作用,必须声明 io
    print("hello");
}
```

要点:

- 顶层只能是 `fn` / `struct` / `enum` / `use` / `test` / `const` / `trait` / `impl` 声明,可加 `pub`。
- 入口是 `fn main()`,可有 `-> i64` 返回退出码,或一个 `args: Vec[str]` 参数接收命令行参数。
- **每条语句以 `;` 结束**;块尾的最后一个表达式可以省略 `;`,它的值就是块的值(Rust 风格)。
- 字符串插值:`"\{expr}"`。

---

## 3. 变量、类型与可变性

```ming
let x = 42;            // 推断为 i64
let y: i64 = 42;       // 显式标注
let mut count = 0;     // mut 才能赋值
count = count + 1;

let (a, b) = (1, 2);   // 元组解构
let _ = ignored();     // 故意丢弃
let _tmp = 0;          // _ 前缀 = 暂不使用
```

### 内建类型

| 类型 | 说明 |
|------|------|
| `i8 i16 i32 i64` | 有符号整数;字面量默认 `i64`,后缀决定宽度:`42u8` |
| `u8 u16 u32 u64` | 无符号整数 |
| `f32 f64` | 浮点;默认 `f64` |
| `bool` | `true` / `false`;**条件必须是 bool,没有真值化** |
| `str` | UTF-8 字符串,不可变 |
| `Vec[T]` | 动态数组 |
| `Map[K, V]` | 有序映射(**迭代顺序 = 插入顺序**),空写法 `[:]` |
| `Option[T]` | `Some(v)` / `None`,取代 null |
| `Result[T, E]` | `Ok(v)` / `Err(e)`,取代异常 |
| `(T1, T2)` | 元组;`()` 是 unit |
| `Range[T]` | 区间,`lo..hi`(左闭右开) |

### 铁律

- **没有隐式转换。** `1 + 2.0`、`i32 + i64`、`u8 == i64` 都是编译错误。用 `as`(位截断/饱和)或 `to_u8()` 等(返回 `Option`)。
- **没有 null。** 缺失值用 `Option[T]`。
- **整数溢出、除零、移位越界 → panic**(M4002/M4004),永远不静默回绕。
- **赋值即深拷贝(值语义)。** `let b = a;` 之后 a 与 b 完全独立;传参同理。程序中不存在共享可变状态。

```ming
let big = 300;
let ok = big.to_u8();      // None(300 放不进 u8)
let raw = big as u8;       // 44(位截断,显式选择)
```

---

## 4. 运算符与求值规则

按优先级从低到高:

| 级 | 运算符 | 说明 |
|----|--------|------|
| 1 | `..` | 区间(非结合) |
| 2 | `\|\|` | 短路或 |
| 3 | `&&` | 短路与 |
| 4-6 | `\| ^ &` | 位运算(仅整数) |
| 7 | `== !=` | 结构相等(浮点比较会触发 W3102 警告) |
| 8 | `< > <= >=` | 比较(**不允许链式** `a<b<c`) |
| 9 | `<< >>` | 移位 |
| 10 | `+ -` | 加减;`+` 也用于 str 拼接 |
| 11 | `* / %` | 乘除模;`%` 仅整数 |
| 12 | `as` | 类型转换 |
| 13 | `- !` | 一元 |
| 14 | `() [] . ?` | 调用/下标/字段/错误传播 |

- 求值顺序:**从左到右**(`&&`/`||` 短路)。
- 赋值 `=` 与复合赋值 `+= -= *= /= %= &= |= ^=` 是**语句**,不是表达式。
- 没有 `++` / `--`,写 `x += 1`。
- `==` 是深结构相等(Vec/Map/结构体/枚举逐值比较;Map 相等与顺序无关)。

---

## 5. 控制流

```ming
// if 是表达式(值形式必须有 else)
let max = if a > b { a } else { b };

// while / while let
let mut i = 0;
while i < 10 { i += 1; }

while let Option.Some(line) = next_line() {
    print(line);
}

// for:Vec、Map(产出 (k, v) 元组)、str(按字符)、Range
for x in vec { print(str(x)); }
for (k, v) in m { print("\{k}=\{v}"); }
for c in "héllo" { print(c); }
for i in 0..10 { print(str(i)); }

// loop + break/continue
loop {
    if done() { break; }
}
```

条件必须是 `bool`(M3014)——`if 1 {}` 是编译错误。

---

## 6. 函数与闭包

```ming
fn add(a: i64, b: i64) -> i64 {   // 参数与返回类型显式标注
    a + b                          // 块尾表达式 = 返回值;也可 return
}

fn greet(name: str) {             // 无返回类型 = unit
    print("hi, \{name}");
}
```

- 参数默认不可变;需要就地修改(修改的是副本)写 `mut`:`fn normalize(mut v: Vec[f64]) -> Vec[f64] { ... }`
- **传参是深拷贝**:想"修改"外界数据,返回新值。
- 本地函数可以嵌套声明并可递归,但不能捕获外层局部变量。
- `fn` 之间无需先声明后使用(模块内全量收集)。

### 效果声明(v0.2)

函数会产生副作用(print、读时间、读输入)时,必须在签名中用 `with` 声明,并且**逐层传播**:

```ming
fn main() with io {          // print 需要 io
    print("hello");
}

fn log(msg: str) with io, time {
    print("\{std.time.now_ms()}: \{msg}");
}
```

效果检查是编译期的:纯函数(没有 with)里调用任何带效果的函数都会报 M3029。详见 [§14 效果系统](#14-效果系统副作用显式化)。

闭包:

```ming
let double = (x: i64) => x * 2;          // 表达式体
let proc = (x: i64) => {                  // 块体
    let y = x * 10;
    y + 1
};

nums.map((x) => x * 2)                    // 类型通常可从上下文推断
    .filter((x) => x % 2 == 0)
```

- **闭包捕获是值拷贝**(创建时快照),之后与外部变量脱钩;捕获的变量不可在闭包内赋值。
- 函数可以作为值传递:`nums.map(classify)`。

---

## 7. 结构体与枚举

```ming
struct Point {
    x: f64,
    y: f64,
}

let p = Point { x: 1.0, y: 2.0 };   // 全字段显式,没有默认值
p.x                                  // 字段访问
// p.x = 3.0;                        // 需要 let mut p

enum Shape {
    Circle(f64),      // 带值变体
    Rect(f64, f64),
    Point,            // 无值变体
}

let s = Shape.Circle(2.0);          // 构造必须限定(枚举名.变体名)
```

- 字段访问、赋值要求所在绑定是 `mut`。
- 枚举是标签联合(tagged union),配 match 使用(§8)。
- v0.1 用户类型没有方法;用自由函数:`fn area(s: Shape) -> f64`。

---

## 8. 模式匹配

```ming
match shape {
    Shape.Circle(r)  => std.math.pi() * r * r,
    Shape.Rect(w, h) => w * h,
    Shape.Point      => 0.0,
}

match (n % 3, n % 5) {          // 元组模式
    (0, 0) => "FizzBuzz",
    (0, _) => "Fizz",
    (_, 0) => "Buzz",
    _      => str(n),           // _ 兜底
}

match age {                     // 字面量模式 + 绑定
    0 => "新生儿",
    18 => "成年",
    n if n < 0 => "非法",       // 守卫
    n => "\{n} 岁",
}
```

- **必须穷尽**(M3007):枚举要覆盖全部变体,bool 要 true/false,其余要有 `_` 或绑定兜底。带守卫的分支不算覆盖。
- 模式支持:字面量(整数/字符串/bool)、`_`、绑定、元组、`枚举名.变体名(子模式)`。
- prelude 四个裸变体可直接用:`Some(x)` / `None` / `Ok(v)` / `Err(e)`。
- `while let 模式 = 表达式` 循环解构。

---

## 9. 错误处理:Result、Option 与 `?`

```ming
fn parse_pair(s: str) -> Result[(i64, i64), str] {
    let parts = s.split(",");
    if parts.len() != 2 {
        return Err("需要恰好两个数字,逗号分隔");
    }
    let x = parts[0].trim().parse_i64()?;   // Err 提前返回
    let y = parts[1].trim().parse_i64()?;
    Ok((x, y))
}
```

- `?` 作用于 `Option[T]` / `Result[T, E]`:成功取值,失败**提前 return** 同类型的 None/Err;所在函数必须返回兼容的 Option/Result(M3002)。
- 处理方式:`match`、`?`、`unwrap_or(默认)`;`unwrap()` / `expect(msg)` 在 None/Err 时 panic(M4006)——只用于"不可能失败"。
- `panic("消息")` 主动中止(退出码 101),输出含 Ming 调用栈(最新在前,每帧为调用点位置;v0.30 起真正生效);scoped 子任务 panic 传播时带 `Caused by` 错误链。

```ming
match parse_pair("3,4") {
    Ok((x, y)) => print("\{x}+\{y}"),
    Err(msg)   => print("错误: \{msg}"),
}
```

---

## 10. 集合:Vec 与 Map

```ming
let mut v: Vec[i64] = [3, 1, 2];   // 空的写 [](常需标注)
v.push(4);
v.sort();
let first = v.get(0);              // Option[i64];v[0] 越界会 panic

let mut m: Map[str, i64] = [:];    // 显式空 Map
m.set("a", 1);
let x = m.get("a");                // Option[i64];m["a"] 缺键会 panic

for (k, v) in m { ... }            // 插入顺序,永远确定
```

**方法速查(Vec[T])**:`len is_empty push pop get first last contains index_of reverse sort sort_by map filter fold join slice insert remove extend clear clone`

**方法速查(Map[K,V])**:`len is_empty get set has delete keys values items clear clone`

值语义提醒:`let w = v;` 后对 `v.push(...)` 不影响 `w`;`w` 是完整拷贝。

---

## 11. 字符串

```ming
let s = "héllo";
s.char_len()        // 5(字符数);s.byte_len() = 6(字节数)
s.chars()           // Vec[str],按字符
s.split(" ")        // Vec[str]
s.trim() s.to_upper() s.to_lower()
s.contains("é") s.starts_with("h") s.ends_with("o")
s.replace("l", "L") s.repeat(2)
s.get(1)            // Option[str](第 1 个字符)
s.parse_i64()       // Result[i64, str]
"\{1 + 2}"          // "3":插值只接受 int/float/bool/str
```

- **禁止 `s[i]`**(编码歧义,M3020);用 `get` / `chars` / `slice_chars`。
- 拼接:`"a" + "b"`;拼接非字符串先 `str(x)`,多个片段用插值。
- 结构体的字符串化用 `debug(x)`。

---

## 12. 泛型

```ming
fn first[T](v: Vec[T]) -> Option[T] {
    v.first()
}

struct Pair[A, B] {
    left: A,
    right: B,
}
```

- 泛型可以带 bound:`fn find[T: Eq](v: Vec[T], x: T)` —— T 必须实现 Eq(见 [§13](#13-trait-与-impl用户类型的方法)),否则调用处报 M3032。
- 泛型参数上除 bound 声明的 trait 方法外没有其他操作:`x + x` 报 M3018。
- 运行时擦除,检查时按实参实例化与 bound 校验。
- 内建泛型:`Vec[T]`、`Map[K,V]`、`Option[T]`、`Result[T,E]`、`Range[T]`。

---

## 13. trait 与 impl:用户类型的方法

v0.2 起用户类型可以有方法:**方法必须定义在某个 trait 的 impl 中**——没有"散装方法",每个方法都属于一个可命名、可约束的接口。

```ming
struct Point {
    x: f64,
    y: f64,
}

impl Eq for Point {
    fn eq(self, other: Self) -> bool {
        return self.x == other.x && self.y == other.y;
    }
}

impl ToStr for Point {
    fn to_str(self) -> str {
        return "(\{self.x}, \{self.y})";
    }
}

fn main() with io {
    let p = Point { x: 1.0, y: 2.0 };
    print(str(p.eq(Point { x: 1.0, y: 2.0 })));   // true
    print(p.to_str());                             // (1.0, 2.0)
}
```

### prelude 内置 trait

| trait | 方法 | 内置实现 |
|-------|------|----------|
| `Eq` | `fn eq(self, other: Self) -> bool` | 所有整数/浮点/bool/str |
| `ToStr` | `fn to_str(self) -> str` | 所有整数/浮点/bool/str |
| `Compare` | `fn cmp(self, other: Self) -> i64`(负/零/正) | 整数/浮点/str |

Vec 配套方法:`min()` / `max()` 返回 `Option[T]`,要求元素实现 `Compare`。

### 自定义 trait 与泛型 bound

```ming
trait Area {
    fn area(self) -> f64;
}

impl Area for Circle {
    fn area(self) -> f64 { return std.math.pi() * self.r * self.r; }
}

// bound:T 必须实现 Eq,泛型体内即可调用 T 的 Eq 方法
fn find_index[T: Eq](v: Vec[T], x: T) -> Option[i64] {
    let mut i = 0;
    for item in v {
        if item.eq(x) { return Some(i); }
        i += 1;
    }
    return None;
}
```

### 泛型类型的 impl(v0.5)

```ming
struct Pair[A, B] {
    left: A,
    right: B,
}

impl[A: Eq, B: Eq] Eq for Pair[A, B] {
    fn eq(self, other: Self) -> bool {
        return self.left.eq(other.left) && self.right.eq(other.right);
    }
}

impl[A: ToStr, B: ToStr] ToStr for Pair[A, B] {
    fn to_str(self) -> str {
        return "(\{self.left.to_str()}, \{self.right.to_str()})";
    }
}
```

- impl 的类型参数可以带 bound;方法体内调用成员的 trait 方法由这些 bound 保证。
- **bound 递归校验**:`Pair[i64, str]` 满足 `Eq` 要求 i64 与 str 都满足;`Vec[T]` 与元组的 `Eq` 随元素递归(内置)。
- 使用点检查:泛型函数调用、`min`/`max` 等需要 bound 的位置会校验实参类型(M3032)。
- impl 类型参数必须覆盖目标的全部类型参数(M3032,禁止未约束参数)。
- trait 方法无默认实现;impl 必须实现 trait 的全部方法(M3032),签名必须一致(M3002/M3032)。
- 方法的效果遵循效果系统:impl 方法要 print 就声明 `with io`。
- 方法体内可用 `Self` 指代实现者类型(仅签名;体内直接写类型名)。
- 运行时按接收者的具体类型分派(静态注册,无虚表开销语义)。

## 14. 效果系统:副作用显式化

**原则:一个函数有没有副作用,看签名就知道,而且编译器强制。**

```ming
fn pure_double(n: i64) -> i64 {      // 无 with = 纯函数(编译期证明)
    return n * 2;
}

fn show(n: i64) with io {            // 打印是副作用
    print("\{n} → \{pure_double(n)}");  // 调纯函数不需要任何效果
}

fn stamped() with io, time {         // 多个效果用逗号分隔
    print("\{std.time.now_ms()}");
}
```

- 当前效果集:`io`、`time`、`fs`(v0.6)、`net`(v0.7)、`sync`(v0.14)、`proc` / `env`(v0.24,外部进程与环境变量)。能力全景见 docs/capabilities.md(诚实覆盖率矩阵)。
- **传播**:调用带效果的函数,调用方必须声明同样(或更多)的效果,否则 M3029;效果清单就是审计清单。
- `main` 与 `test` 块是入口,声明自己需要的效果(main)或拥有全部效果(test)。
- 闭包在**创建处**继承所在函数的效果(已知限制:存入数据结构的闭包在 v0.2 不追踪调用点效果)。
- v0.2 仍然没有文件系统/网络/进程/随机数;后续版本以同样方式逐个开放为效果 + capability。

这个机制对 AI 生成代码的价值:凡是没标 `io` 的函数,可以放心推理它只做计算;审查"这段代码会不会打印/读时间"不再需要读实现。

## 15. 常量 const

```ming
const GREETING = "你好,Ming";
const LIMIT = 3;
const TABLE = [1, 10, 100];

fn main() with io {
    print(GREETING);
    for n in TABLE { print(str(n)); }
}
```

- 只接受**常量表达式**:字面量、算术/逻辑运算、字符串拼接、集合/元组字面量、其他常量的引用(M3031);不接受函数调用。
- 常量不可赋值(M3004);可用类型标注:`const N: i64 = 10;`。
- 循环定义会在编译期报出(M3031)。

## 16. 模块与可见性

```ming
// geom.ming
pub struct Point { x: f64, y: f64 }   // pub 才对外可见

pub fn dist(a: Point, b: Point) -> f64 {
    std.math.sqrt(...)
}

fn internal_helper() { ... }          // 私有

// main.ming(同目录)
use geom;

fn main() with io {
    let p = geom.Point { x: 0.0, y: 0.0 };
    print(str(geom.dist(p, p)));
}
```

- `use geom;` → 同目录 `geom.ming`;`use utils.math;` → `utils/math.ming`。
- `use std.math;` 导入标准库(别名 `math`);`std.*` 也可以不加 use 直接全限定使用。
- 只导入本地文件与 std;不支持 `pub use` 再导出(v0.2)。
- 循环导入报 M3025。

---

## 17. 测试

```ming
fn add(a: i64, b: i64) -> i64 { a + b }

test add_basics {
    assert_eq(add(1, 2), 3);
    assert(add(-1) < 0, "负数判断");
}
```

```bash
$ node bin/ming.js test mylib.ming
✓ mylib.ming::add_basics

1 通过,0 失败
```

- `test 名字 { ... }` 与函数同层;`ming test` 只运行**入口文件**里的测试。
- `assert(cond, msg?)`、`assert_eq(a, b)` 失败时 panic 并打印两侧的 debug 值。
- 测试运行时 `print` 输出会被捕获,只在失败时展示。

---

## 18. 标准库参考

### prelude(无需导入)

| 名称 | 签名 | 说明 |
|------|------|------|
| `print` / `eprint` | `(int\|float\|bool\|str) -> ()` · 效果 `io` | 打印到 stdout / stderr |
| `str` | `(int\|float\|bool\|str) -> str` | 转字符串 |
| `debug` | `(任意非函数值) -> str` | 调试表示(字符串带引号) |
| `assert` | `(bool, str?) -> ()` | 断言 |
| `assert_eq` | `(T, T) -> ()` | 相等断言,失败打印两侧 |
| `panic` | `(str) -> !` | 中止(退出码 101) |
| `Some None Ok Err` | — | Option/Result 变体 |

### std.math

`sqrt pow abs floor ceil round min max exp ln sin cos tan` + **v0.29 补全**:`asin acos atan atan2(y, x) sinh cosh tanh log2 log10 cbrt hypot(a, b)` — 均为 f64(实参必须显式 f64,int 不隐式转换);`pi` `e` 为常量函数。全部纯函数,wasm 导入桥接(eligible 函数内零回落)。

### std.io

`read_line() -> str` · 效果 `io` — 读一行(去换行);EOF 返回 `""`。

### std.time

| 函数 | 签名 | 说明 |
|------|------|------|
| `now_ms` | `() -> i64` · 效果 `time` | 墙钟毫秒时间戳 |
| `sleep` | `(i64) -> ()` · 效果 `time` | 同步睡眠(毫秒;v0.10) |
| `monotonic_ms` | `() -> i64` · 效果 `time` | **单调时钟**(测耗时;不受系统调钟影响;v0.25) |
| `date_parts` | `(i64) -> Json` · 效果 `time` | 本地时区分解:{year, month, day, hour, min, sec, weekday(1=周一)}(v0.25) |
| `format_iso` | `(i64) -> str` · 效果 `time` | 本地时区 ISO 8601(YYYY-MM-DDTHH:mm:ss)(v0.25) |
| `parse_iso` | `(str) -> Result[i64, str]` · 效果 `time` | 解析 ISO 8601(本地时区)(v0.25) |

### std.json(纯函数,v0.10)

**动态 JSON 类型 `Json`**:`parse` 产生,访问器按需取用;自身可再序列化;结构相等(`==`)。

| 函数/方法 | 签名 | 说明 |
|------|------|------|
| `parse` | `(str) -> Result[Json, str]` | 解析;错误带位置 |
| `stringify` | `(JSON 兼容类型) -> str` | **静态检查兼容性**(M3033) |
| `.is_null is_bool is_num is_str is_arr is_obj` | `(JSON) -> bool` | 类型判定 |
| `.as_bool as_num as_str` | `(JSON) -> Option[...]` | 取标量 |
| `.as_arr as_obj` | `(JSON) -> Option[Vec[Json] / Map[str, Json]]` | 取容器(**副本**) |
| `.get(k) .at(i)` | `(JSON, str/i64) -> Option[Json]` | 对象键/数组下标 |
| `.eq(other)` | `(JSON, JSON) -> bool` | 结构相等 |

JSON 兼容类型(可 stringify):int / float / bool / str / Vec[T] / Map[str, T] / Option[T](None→null)/ 元组(→数组)/ Json。结构体与枚举**不**自动序列化(编译期 M3033)——拆解字段或先转 Map。

```ming
use std.json;

fn main() with io {
    let doc = std.json.parse("{\"name\": \"ming\", \"v\": 10}").unwrap();
    print(doc.get("name").unwrap().as_str().unwrap());   // ming
    print(std.json.stringify(doc));                       // {"name":"ming","v":10}
}
```

### std.fs(能力:fs,v0.6)

文件系统访问必须声明 `with fs`——这就是能力声明;没有它,编译期就无法让程序触碰磁盘。

| 函数 | 签名 | 说明 |
|------|------|------|
| `read_file` | `(str) -> Result[str, str]` | 读文本文件 |
| `write_file` | `(str, str) -> Result[bool, str]` | 写文本文件(覆盖) |
| `append_file` | `(str, str) -> Result[bool, str]` | 追加 |
| `exists` | `(str) -> bool` | 路径是否存在 |
| `is_dir` | `(str) -> bool` | 是否目录 |
| `list_dir` | `(str) -> Result[Vec[str], str]` | 列目录项 |
| `make_dir` | `(str) -> Result[bool, str]` | 建目录(含父级) |
| `remove_file` | `(str) -> Result[bool, str]` | 删文件 |
| `read_bytes` | `(str) -> Result[Vec[u8], str]` | 二进制读(v0.31):整文件,单文件上限 8MB;无流式 |
| `write_bytes` | `(str, Vec[u8]) -> Result[bool, str]` | 二进制写/覆盖(v0.31) |
| `append_bytes` | `(str, Vec[u8]) -> Result[bool, str]` | 二进制追加(v0.31) |

二进制配套转换(纯函数):`s.to_bytes() -> Vec[u8]`(UTF-8 编码)与 `bytes.to_str() -> str`(UTF-8 解码,无效序列 → U+FFFD;仅 Vec[u8] 有此方法)。

```ming
use std.fs;

fn main() with io, fs {
    match std.fs.read_file("config.txt") {
        Ok(content) => print(content),
        Err(e)      => print("读不到: \{e}"),
    }
}
```

### std.net(能力:net,v0.7)

| 函数 | 签名 | 说明 |
|------|------|------|
| `http_get` | `(str) -> Result[(i64, str), str]` | HTTP GET:Ok 为 (状态码, 响应体) |
| `http_request` | `(method, url, headers: Map[str, str], body: str) -> Result[(i64, str), str]`(body 可省略) | 完整 HTTP:自定义方法/头/体 |
| `http_request_opts` | `(method, url, headers: Map[str, str], body: str, timeout_ms: i64) -> Result[(i64, Map[str, str], str), str]`(v0.27) | Ok 为 (状态码, 响应头, 响应体);超时毫秒可配 |

- 同步实现(worker 线程 fetch + Atomics 阻塞),响应体上限 8MB(超出截断),遵循重定向;`http_get`/`http_request` 默认 35s 超时,`http_request_opts` 按参数。
- `http_request` 的 body 可省略;GET/HEAD 不发送体。
- 重定向固定遵循(redirect: follow);响应头键为小写。

```ming
use std.net;

fn main(args: Vec[str]) with io, net {
    match std.net.http_get(args[0]) {
        Ok((status, body)) => print("\{status} \{body}"),
        Err(e)             => print("请求失败: \{e}"),
    }
}
```

### std.sync(能力:sync,v0.14)

结构化并发:`spawn` 把函数交给**隔离子 VM**(worker 线程)并行执行,`join` 阻塞取结果。值语义保证确定性——子任务拿到的是参数的完整拷贝,与父任务零共享。

| 函数 | 签名 | 说明 |
|------|------|------|
| `spawn` | `(fn: (T1..Tn) -> R, args...) -> Join[R]` | 启动子任务;参数按函数签名逐个传递(v0.16 起支持多参数);函数必须是**模块级命名函数** |
| `spawn_all` | `(fn: (T) -> R, Vec[T]) -> Vec[Result[R, str]]` | 批量并行:同函数对 Vec 中每个参数各启动一个子任务,返回全部结果(v0.16)——**接口不暴露句柄**,与线性纪律自洽 |
| `join` | `(Join[R]) -> Result[R, str]` | 阻塞等待;子任务 panic → Err(带消息);每个句柄只能 join 一次 |
| `join_detailed` | `(Join[R], timeout_ms: i64?) -> Result[R, Json]` | 错误链版 join(v0.30):Err 为 Json `{code, message, stack}`——子任务 panic 的**错误码与 Ming 层调用栈**不再丢失;超时可配(v0.31,缺省 120s;超时/取消 → Err 码 M4010,任务被硬杀) |
| `cancel` | `(Join[R]) -> bool` | 硬杀子任务(v0.31,terminate 不可捕获);返回句柄是否仍被跟踪;之后 join/join_detailed → Err"任务已取消";scoped 块不再等待已取消任务 |

```ming
use std.sync;

fn fib(n: i64) -> i64 { ... }

fn main() with io, sync {
    // 批量:对 [20, 25, 30] 各启动一个子任务,全部并行
    let all = std.sync.spawn_all(fib, [20, 25, 30]);
    for res in all { print(str(res.unwrap())); }
}
```

### scoped 并发块(v0.17)

`sync scope { ... }`——块内 spawn 的句柄在**块退出时自动 join**,杜绝 worker 泄漏。这就是"结构化"并发的结构化二字:任务生命周期被块边界框住。

```ming
fn warmup() with sync {
    sync scope {
        std.sync.spawn(fib, 30);       // fire-and-forget,块尾自动 join
        std.sync.spawn(fib, 28);
    }                                   // ← 此处自动等待全部子任务
}
```

- **正常退出**:未显式 join 的句柄自动等待;子任务 panic → 向上抛 Panic(块内的错误不会被吞)。
- **提前返回/异常展开**:return、break 穿过块时安全收尾(等待已启动子任务,错误吞掉——正在传播的错误优先)。
- **显式 join 共存**:块内 join 过的句柄不会重复等待。
- 需要结果?用 spawn + join 或 spawn_all;scoped 块面向"并行预热/后台计算后必汇合"的形态。
- 效果:块需要 `with sync`。

- **跨任务类型**:int/u64/float/bool/str/Json/Vec/Map(递归)、Option/Result;struct/用户枚举/闭包**不能**跨任务(编译期拒绝)。
- **句柄是线性资源(v0.15)**:Join[T] 不能存入 Vec/Map/元组/struct 字段/enum 载荷/Option/Result,也不能作为 spawn 的参数/返回(M3034)——深拷贝语义下,存入集合会产生指向同一子任务的别名句柄,重复 join 语义混乱。纪律:join 要尽早,句柄只活在单个绑定里。
- **子任务隔离**:子 VM 的 print 等副作用被捕获丢弃——spawn 纯函数是纪律;子任务有自己的 wasm 分层与 maxSteps。
- 编译期检查:spawn 返回类型不可跨任务 → M3002;未声明 `with sync` 调用 spawn/join → M3029。

```ming
use std.sync;

fn fib(n: i64) -> i64 {
    if n < 2 { return n; }
    return fib(n - 1) + fib(n - 2);
}

fn main() with io, sync {
    let h1 = std.sync.spawn(fib, 25);   // 两个子任务真正并行
    let h2 = std.sync.spawn(fib, 20);
    print(str(std.sync.join(h1).unwrap() + std.sync.join(h2).unwrap()));
}
```

### std.rand(能力:rand,v0.25)

| 函数 | 签名 | 说明 |
|------|------|------|
| `u64` | `() -> u64` · 效果 `rand` | 64 位随机 |
| `f64` | `() -> f64` · 效果 `rand` | [0, 1) 均匀 |
| `range` | `(lo, hi) -> i64` · 效果 `rand` | [lo, hi) 整数 |
| `seed` | `(u64) -> ()` · 效果 `rand` | 确定性模式:seed 后同序列(测试友好,符合确定性哲学) |

内部 mulberry32;初始种子来自时钟+pid,`seed` 后完全确定。

### std.crypto(能力:crypto,v0.34)

哈希/HMAC 原语(node:crypto 桥接;安全工具之北支柱 6):输入 UTF-8 字符串,输出小写 hex。AES/RSA/国密与字节流接口随后续版本。

| 函数 | 签名 | 说明 |
|------|------|------|
| `md5` / `sha1` / `sha256` / `sha384` / `sha512` | `(str) -> str` · 效果 `crypto` | 标准 Hash,hex 小写 |
| `hmac_md5` / `hmac_sha1` / `hmac_sha256` / `hmac_sha384` / `hmac_sha512` | `(key: str, msg: str) -> str` · 效果 `crypto` | HMAC(v0.35) |
| `aes256_encrypt` | `(key: str, plaintext: str) -> Result[Vec[u8], str]` · 效果 `crypto` | AES-256-CBC(v0.36):key 恰好 32 字节;输出 = IV(16B 随机)+ 密文;**无认证**,防篡改组合 hmac_sha256 |
| `aes256_decrypt` | `(key: str, data: Vec[u8]) -> Result[str, str]` · 效果 `crypto` | 解密;长度非法/密钥错误(padding 校验失败)→ Err |
| `aes256_gcm_encrypt` | `(key: str, plaintext: str) -> Result[Vec[u8], str]` · 效果 `crypto` | AES-256-GCM(v0.37,**带认证 AEAD**):key 恰 32 字节;输出 = nonce(12B 随机)+ tag(16B)+ 密文;无填充,密文长度 = 明文长度。**nonce 边界(诚实声明)**:每条消息随机 96-bit nonce,碰撞概率约 q²/2^97(q 条消息后);NIST SP 800-38D 建议单密钥随机 nonce 调用量不超过 2^32——需要更高保证时由调用方管理确定性计数器 nonce(当前 API 未暴露) |
| `aes256_gcm_decrypt` | `(key: str, data: Vec[u8]) -> Result[str, str]` · 效果 `crypto` | 解密;**最小合法帧 28 字节**(12B nonce + 16B tag,密文可为 0 字节;v0.49.1 修正),27B/12B 等截断输入 → Err;认证校验失败(篡改/nonce 不符/密钥错误)→ Err |

```ming
use std.crypto;

fn main() with io, crypto {
    print(std.crypto.sha256("abc"));
    // ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    print(std.crypto.hmac_sha256("key", "msg"));
}
```

### std.bin(纯函数,v0.35)

显式字节序打包/解包(安全工具之北支柱 1):**拒绝隐式端序**——be/le 显式枚举为独立函数,一种结构一个语法。全部纯函数(无效果)。

| 函数 | 签名 | 说明 |
|------|------|------|
| `pack_u16_le` / `pack_u16_be` / `pack_u32_le` / `pack_u32_be` | `(i64) -> Vec[u8]` | 打包;值域超限 → panic(需要截断请显式 `as`) |
| `pack_u64_le` / `pack_u64_be` | `(i64) -> Vec[u8]` | 任意 i64 按 u64 补码位型(与 fmt.hex/bin 对称) |
| `unpack_u16_le` … `unpack_u64_be` | `(Vec[u8], off: i64) -> Result[i64, str]` | 解包;偏移越界/短缓冲/非 u8 字节 → Err(数据驱动错误) |

- unpack_u64 读数 ≥ 2^63 按补码位型转负 i64(位型与 fmt.hex 对称)。
- **位域/struct packing 的设计判断(不做)**:C 式 struct 内存布局控制与 Ming 的值语义(处处深拷贝)正交——显式 pack/unpack(v0.35 std.bin)**就是** Ming 的 packing 答案;位域 = 移位掩码惯用法(checked 位运算已内置),不做位域类型。布局控制随原生后端与受控 unsafe 再评估(design.md §6.1)。

```ming
use std.bin;

fn main() with io {
    let b = std.bin.pack_u32_le(0x12345678);   // [0x78, 0x56, 0x34, 0x12]
}
```

### std.re(纯函数,v0.26)

正则 = **JS RegExp 桥接**(ECMAScript 语法),pattern 用**原始字符串** `r"..."(无转义,\\d 原样保留)。非法 pattern = 程序员错误 → panic;含 re 调用的函数在 wasm 分层自动回落 JS VM(语义不变)。

| 函数 | 签名 | 说明 |
|------|------|------|
| `is_match` | `(pattern, s) -> bool` | 是否存在匹配 |
| `find` | `(pattern, s) -> Option[str]` | 第一个匹配 |
| `find_all` | `(pattern, s) -> Vec[str]` | 全部匹配 |
| `replace` | `(pattern, s, repl) -> str` | 替换全部(repl 支持 $1 捕获引用) |
| `split` | `(pattern, s) -> Vec[str]` | 分割 |
| `is_match_bytes` | `(pattern, Vec[u8]) -> bool` | 字节流匹配(v0.36):latin1 无损桥接,pattern 可用 `\xNN` 匹配原始字节 |
| `find_bytes` | `(pattern, Vec[u8]) -> Option[Vec[u8]]` | 字节流查找(结果为字节切片拷贝) |
| `replace_bytes` | `(pattern, Vec[u8], Vec[u8]) -> Vec[u8]` | 字节流替换 |

```ming
use std.re;

fn main() with io {
    print(str(std.re.is_match(r"\\d+", "abc123")));       // true
    for part in std.re.split(r",\\s*", "a, b,c") { print(part); }
}
```

### 字符判定与 pad(v0.26)

`is_alpha()` / `is_digit()` / `is_space()` / `is_upper()` / `is_lower()`(整串判定,空串 false,Unicode 感知 \p{L}/\p{Nd});`pad_left(n)` / `pad_right(n)`(空格填充)。

**字符串 Builder 的设计判断(不做)**:Vec[str] + join 已是 O(n) 惯用法,单独 Builder 类型冗余。

### std.fmt(纯函数,v0.27)

数值 → 受控字符串:进制与精度显式指定,输出确定(不受平台/区域设置影响)。

| 函数 | 签名 | 说明 |
|------|------|------|
| `fixed` | `(f64, digits: i64) -> str` | 定点小数,指定小数位(四舍五入;`fixed(3.14159, 2)` = "3.14") |
| `hex` | `(i64) -> str` | 十六进制,`0x` 前缀,**u64 位型**(负数按补码,`hex(-1)` = "0xffffffffffffffff") |
| `bin` | `(i64) -> str` | 二进制,`0b` 前缀,同 u64 位型 |
| `exp` | `(f64, digits: i64) -> str` | 科学计数法,指定小数位(`exp(12345.678, 2)` = "1.23e+4") |
| `align` | `(str, width: i64, mode: str) -> str` | 宽度对齐(v0.28):**字符数口径**,不足补空格,超宽原样;mode = `"left"`/`"right"`/`"center"`(左侧取 floor,补齐偏右);非法 mode → panic |

```ming
use std.fmt;

fn main() with io {
    print(std.fmt.fixed(3.14159, 2));   // 3.14
    print(std.fmt.hex(255));            // 0xff
    print(std.fmt.bin(10));             // 0b1010
    print(std.fmt.exp(12345.678, 2));   // 1.23e+4
    print(std.fmt.align("ab", 5, "center"));  // " ab  "
}
```

### std.log(能力:io,v0.28)

级别日志:`debug/info/warn/error(msg)` 输出 `[LEVEL] msg` 到 **stderr**;级别阈值 debug < info < warn < error,低于阈值直接丢弃。

| 函数 | 签名 | 说明 |
|------|------|------|
| `debug` / `info` / `warn` / `error` | `(str) -> ()` · 效果 `io` | 按级别输出;默认级别 `info` |
| `set_level` | `(str) -> ()` · 效果 `io` | `"debug"`/`"info"`/`"warn"`/`"error"`;非法值 → panic(程序员错误) |
| `get_level` | `() -> str` · 效果 `io` | 当前级别名 |

设计立场:日志只影响诊断流,不影响程序值——`print` 保持唯一 stdout 输出通道,日志永不与之混流;含 log 调用的函数在 wasm 分层自动回落(语义不变)。

### std.path(纯函数)

`join(a, b) -> str`、`base_name(p) -> str`、`dir_name(p) -> str`、`extension(p) -> str`(含点,如 ".txt")——无效果,可在纯函数中使用。

### 数字类型方法

- 整数/浮点共有:`abs() to_f32() to_f64() to_i8() ... to_u64()`(安全转换返回 `Option`)
- 浮点:`to_fixed(位数) -> str`、`is_nan() is_infinite()`
- 类型级:`i64.max_value()`、`u8.min_value()`、`f64.infinity()`、`f64.nan()` 等

> v0.1 没有文件系统、网络、进程、随机数 API——程序无法产生这些副作用。v0.2 起以 effect + capability 方式开放。

---

## 19. 工具链

| 命令 | 作用 |
|------|------|
| `ming run f.ming [-- args]` | 类型检查 → 编译字节码 → VM 运行;`--tree` 用树遍历引擎对照;`--json` 捕获输出进 JSON |
| 发布期门禁参数(v0.32) | `--max-steps N` 步数、`--max-alloc N` 累计分配(Vec/Map 元素 + str 字符口径,超限 M4011)、`--max-ms N` 墙钟(超限 M4012);子任务继承限额 |
| `ming build`(项目模式,v0.38 / 缓存 v0.49) | 项目检查通过后产出 **dist 可移植产物**:app.bytecode.json(或 app.ming 源码模式)+ runtime 拷贝 + ming-app.mjs launcher(参数透传、`--` 剥离、panic → 101);Node ≥ 18 零依赖,`node dist/ming-app.mjs [-- args]` 即跑。**v0.49 起内容寻址缓存**:键 = 编译器版本 + 项目全部 .ming 源 + ming.toml(过包含保健全),命中且 dist 完整 → 跳过检查与编译;每次构建报告每模块**接口哈希**(签名/效果/契约规范化,排除函数体:`接口哈希:未变 N 个,变更 <文件>`);`--clean-cache` 清理缓存与 dist 并全量重建 |
| `ming cc f.ming [--emit-c] [--no-run] [--out 目录]`(v0.39 C1 / v0.40 C2 / v0.41 C3) | **C 后端**:eligible 函数(数值 + str + Vec[i64] + Map[str,i64] + Option[i64])+ AOT 形态 main → C(GCC/Clang -O2 编译并运行;panic/输出与 `ming run` 逐字对齐,含 M4003/M4006/M4007 消息);`--emit-c` 只产出 .c;`--no-run` 只构建不运行;编译器探测 MING_CC → PATH → 已知便携位置;插值串/Result 属 C4(显式拒绝) |
| 自举工具(v0.27.1 / v0.40,Ming 自写) | `tools/mingkit.ming`(文件工具箱:read/write/replace 恰好 1 处/insert/delete-lines/count,一层转义,歧义写入拒绝)+ `tools/engdiff.ming`(多引擎差分:`node bin/ming.js run tools/engdiff.ming -- <file.ming>` 一条命令对比 vm+wasm/tree/vm-only 三引擎 stdout+退出码)——用 Ming 写 Ming 的工具链,自举即验证 |
| 自举工具 v0.44 | `tools/diaghot.ming`(诊断热力图:`node bin/ming.js run tools/diaghot.ming -- <file.ming...>` 聚合 `ming check --json` 的诊断码频次,Top-N 输出)——语法/检查改进的数据依据 |
| 自举工具 v0.45 扩充(全部 Ming 自写,共 12 个) | `edit`(行级编辑器:show/get/set/ins/del/sub/append,行号越界拒绝、尾部换行保真)+ `wc`(行/词/字节)+ `find_files`(按名递归查找,跳隐藏目录与 node_modules)+ `tree`(目录树)+ `todo_scan`(TODO/FIXME 扫描)+ `log_analyzer`(ERROR/WARN/INFO 计数)+ `json_query`(JSON 字段提取)+ `batch_rename`(批量加前缀;破坏性:目录必须显式给出)+ `file_organizer`(按扩展名归档;破坏性:同上);v0.45.1 检视:全部 **args 优先、env 回退** 双接口 |
| `ming tools [--list] <命令> [参数...]`(v0.50) | **自举工具统一入口**:去掉 `node bin/ming.js run tools/xxx.ming --` 的长命令行摩擦。`patch/patch-all/read/write/append/insert/insert-before/del/count` → mingkit;`edit` → 行级编辑器;`diff` → engdiff;`diag` → diaghot;`wc/tree/find/json/todo/log/rename/organize` → 其余工具;任意 `tools/<名>.ming` 亦可直接调用。CLI 进程内路由(工具本体仍是 Ming,无额外进程启动);编辑类沿用"恰好 1 处/越界拒绝"安全语义 |
| `ming check f.ming [--json]` | 只做静态检查 |
| `ming test f.ming [--json] [--filter 名]` | 运行 test 块 |
| `ming fmt f.ming [--write\|--check]` | 规范格式化;`--check` 用于 CI |
| `ming doc f.ming [--json]` | 提取 `///` 文档 |

- **退出码**:0 成功;1 有诊断;101 panic;2 工具链 bug。`main -> i64` 自定义退出码。
- **诊断协议**(所有命令 `--json`):

```json
{
  "code": "M3002",
  "name": "mismatched-types",
  "severity": "error",
  "message": "let 标注类型是 i64,但初始化表达式是 str",
  "file": "t.ming", "line": 1, "col": 15,
  "hint": "检查两处的类型标注;Ming 没有任何隐式转换。"
}
```

- 错误码稳定且可查:`docs/diagnostics.md`。M1xxx 词法、M2xxx 语法、M3xxx 类型、M4xxx 运行时、W3xxx 警告。
- `ming fmt` 是唯一风格:4 空格、`;` 显式、注释保留。**不要手调格式,也不要为格式争论。**

### mingkit 文件工具箱(v0.27.1,用 Ming 自写)

`tools/mingkit.ming` —— 仓库中第一个用 Ming 自写的工具,为 AI 协作中的文件读写而设:跨 shell 的转义损耗是文件补丁的最大摩擦源,mingkit 只保留一层转义(`\n` `\t` `\\`),并拒绝歧义写入(replace 0 处/多处命中即报错退出 1,不落盘)。

```bash
node bin/ming.js run tools/mingkit.ming -- read  <file> [start] [end]
node bin/ming.js run tools/mingkit.ming -- write <file>          # stdin 全量覆盖
node bin/ming.js run tools/mingkit.ming -- replace <file> <old> <new>   # 恰好 1 处,否则报错
node bin/ming.js run tools/mingkit.ming -- insert-after <file> <pat> <text>
node bin/ming.js run tools/mingkit.ming -- count <file>
```

语义由回归套件锁定(双引擎一致);这也是自举的第一块碎片。

---

## 20. 给 AI 的使用建议

如果你(语言模型)被要求生成 Ming 代码:

1. **先写,后验**:`ming check x.ming --json` 是你的反馈回路。每条诊断都有 `code + line:col + hint`,按提示修,不要凭感觉重写。
2. **熟悉高频错误码**:M3002(类型不匹配——检查标注)、M3013(整数宽度——统一 i64 或显式 as)、M3007(match 不穷尽)、M3016(同层遮蔽禁止——换名)。
3. **用 `?` 与 match 处理失败**,不要 unwrap 除非确证不可能失败。
4. **记住值语义**:函数修改参数不会影响调用方;需要"修改"就返回新值。写 `fn normalize(mut v: Vec[T]) -> Vec[T]` 然后返回。
5. **集合字面量**:空 Vec 写 `let v: Vec[T] = [];`,空 Map 写 `let m: Map[K,V] = [:];`——类型必须可推断。
6. **不要使用保留字**(trait impl const static async await null …),它们在 v0.2+ 才有含义。
7. **格式交给 fmt**:生成后跑 `ming fmt --write`,不要手工对齐。
8. **测试即文档**:为每个纯函数写 `test` 块,`ming test` 直接可跑。
9. **插值只支持原始类型**,结构体用 `debug(x)` 或给它实现 ToStr。
10. **副作用要声明**:带 print/时间/输入的函数写 `with io` / `with time`;纯函数不加 with——签名即证明。
11. **用户类型的方法**必须走 trait impl:`trait T { fn m(self, ...) -> R; }` 然后 `impl T for X { fn m(self, ...) -> R { ... } }`;需要相等/字符串化时优先实现内置的 Eq / ToStr。
12. **泛型需要操作时加 bound**:`[T: Eq]`;没有 bound 的类型参数上不能调用方法。
10. **不要模拟其他语言的惯用法**:没有 truthiness、没有 `++`、没有三元 `?:`(用 `if/else` 表达式)、没有异常(用 Result)、没有类继承(用枚举 + match)。

---

## 21. 从其他语言迁移:常见错误对照

| 你可能习惯 | Ming 的方式 | 错误码 |
|------------|-------------|--------|
| `if x:`(truthiness) | `if x != 0 { }` / `if !v.is_empty() { }` | M3014 |
| `null` / `nil` | `Option[T]` + `None` | M1006(保留字) |
| 隐式数字提升 | 显式 `as` / `to_xx()` | M3013 |
| `a < b < c` | `a < b && b < c` | M2005 |
| 异常 try/catch | `Result[T,E]` + `?` + match | — |
| `x++` | `x += 1` | M2002 |
| 默认可变 | `let mut` / `mut 参数` | M3004 |
| 变量遮蔽 `let x = ...` 两次 | 换名字 | M3016 |
| `s[0]` 取字符 | `s.get(0)` / `s.chars()` | M3020 |
| 三元 `a ? b : c` | `if a { b } else { c }` | — |
| 继承与接口 | 枚举 + match 穷尽 / 泛型 | — |
| 按引用传集合 | 值拷贝传参;要变更就返回新值 | — |

---

## 22. 语义规范要点

- **求值顺序**:从左到右,有定义。
- **Map 迭代顺序**:插入顺序,有定义。
- **整数**:全程 checked;`as` 位截断(float→int 截断后饱和);`to_xx()` 检查范围返回 Option。
- **浮点**:IEEE-754;`/0.0` 得 inf/nan(不 panic);f32 运算按 f64 精度存储(v0.1 简化)。
- **相等**:深结构;Map 相等与插入序无关;函数值不可比较。
- **值语义**:赋值/传参/返回/捕获/集合元素存入均为深拷贝。
- **panic**:退出码 101,输出 Ming 层调用栈。
- **效果**:副作用显式声明并编译期传播(§14);纯函数 = 无 with 声明。
- **方法**:必须经 trait impl 定义;bound 泛型在调用处校验(§13)。
- 完整设计动机见 [docs/design.md](docs/design.md)。

## 23. 路线图

逐版进度的**诚实口径**见 [docs/capabilities.md](docs/capabilities.md)(✅/🟡/❌ 矩阵,每版更新)。近版方向:

| 版本 | 内容 |
|------|------|
| v0.28(已完成) | std.log 级别日志、std.fmt.align 宽度对齐 |
| v0.29(已完成) | std.math 补全(11 函数,wasm 桥接)+ 路径验证制度化 |
| v0.30(已完成) | 错误链(cause):wire v2、join_detailed、scoped 码透传、panic 调用栈修复、诊断协议 cause 字段 |
| v0.31(已完成) | 二进制 I/O 雏形(Vec[u8] + 8MB 上限)、任务超时/取消(join_detailed 超时参数、cancel、M4010) |
| v0.32(已完成) | 发布期门禁(max-alloc/max-ms/M4011/M4012)+ **wasm 层复活**(11 层静默回落根因修复;for-in 加载已知问题回落待修) |
| v0.33(已完成) | for-in 步长根因(×3→×8,4 处)+ for-in 回归 wasm 直跑 + **模糊测试基线**(三后端差分)+ 树引擎 `as` 崩溃修复 |
| v0.34(已完成) | **北星立项**(design.md §6 安全工具之北)+ std.crypto 哈希五件套(新能力 crypto) |
| v0.35(已完成) | std.bin 显式字节序 12 函数(支柱 1 落地)+ crypto HMAC 五件套 + 模糊器 as 扩展 |
| v0.36(已完成) | 字节流正则三函数(latin1 无损,支柱 4 落地)+ AES-256-CBC(支柱 6)+ 位域/packing 设计判断(不做) |
| v0.37(已完成) | AES-256-GCM 带认证(篡改检出)+ 模糊器 str/for-in 扩展 + ming build 预研(dist 目录决策,v0.38 实现) |
| v0.38(已完成) | `ming build` dist 可移植产物(launcher/args/panic 全路径)+ **原生后端(C)预研**(资格分析复用路线)+ 模糊器 if/else |
| v0.39(已完成) | **C 后端 C1**(ming cc:eligible 数值函数 → C + GCC -O2,资格分析复用;顺带修复 wasm 四项休眠 bug 使端到端真正复活)+ 模糊器加深(f64/match/loop/Option/方法面 + C 第 4 腿)+ `with ffi` 设计定稿(design.md §6.9,不实现) |
| v0.40(已完成) | **C2:str/Vec[i64] 入 C**(cat/eq/char_len/pad/slice/replace,下标 OOB,push/for-in/mut 传参值语义,match 含 guard)+ engdiff 自举工具 + 模糊器 cc 族拓宽 |
| v0.41(已完成) | **C3:Map[str,i64]/Option[i64]/str trim 族/f64 打印入 C**(floatStr 对齐 + JS 最短往返;**cc 差分腿 = 解释引擎全形态**,四种子 100%) |
| v0.42(已完成) | **C4:with ffi 兑现**(extern "库" fn 声明,隐含 ffi 效果,调用方须 with ffi;JS 引擎 M4001 拒绝,C 后端 dlopen/dlsym 真调用,M4013 失败路径;ming cc --static) |
| v0.43(已完成) | **ffi 字符串桥 + Result[i64,str] 进 C 面 + with unsafe 设计定稿**(资格基线修正:opt/res 形参入形状面;prelude 构造器不再误降级不动点) |
| 更远(北星对齐) | C2 str/Vec 全形态;C3 交叉编译 -static;C4 `with ffi`/`with unsafe`;async 运行时;eval 能力;RSA/国密;动态权限收回;形式化验证 |

## 24. 修订记录

每次修改语言或工具链,在此登记;GUIDE 始终与实现同步。

### v0.51.5(2026-11-11)

- **CLI 边界修复(代码审查)**:
  - **项目模式 `--` 参数**:`ming run -- a b` 现在把 `a b` 作为程序参数(此前被当作文件路径 → M3022);显式文件与位置参数写法保持兼容。
  - **`-o` 短旗标**:`ming cc f.ming --emit-c -o outdir` 进入指定目录(此前只写 flags、产物落到默认 `ming-cc-out`)。
  - **值旗标校验**:`--max-steps` 等缺值(后跟 `--json`)或非整数(`abc`/`=abc`)直接报错退出 1,不再静默吞掉下一个旗标或产生 NaN 步数上限。
- 回归(§53 七项);534 项全绿;模糊 40 程序 0 分歧。

### v0.51.4(2026-11-11)

- **检查器小缺陷批量修复(代码审查)**:
  - **容器访问器返回值语义副本**:`Vec.get/first/last`、`Map.get/values/items`、`Option/Result.unwrap/expect/unwrap_or` 在边界 deepCopy——`v.get(0).unwrap().push(9)` 不再修改非 `mut` 的 v(此前检查器"临时值允许"的假设与运行时引用语义矛盾)。**性能提示**:每次访问器读取都会拷贝元素,热路径如需零拷贝请直接索引(索引是借用读)。
  - **`while let` 恢复可用**:改用 `checkMatchPattern` 校验(允许可反驳模式),GUIDE 示例与实际一致。
  - **match 元组穷尽性**:元组模式仅当全部子模式不可反驳才视为穷尽;`(E.A, _)` 单臂不再漏检(运行期内部 panic 消除)。保守规则:含可反驳子模式的元组 match 需要 `_` 兜底。
  - **泛型 bound 方法 arity**:修正未定义 `span` 导致的 `ReferenceError`,现在报 M3005。
  - **Map 键类型(M3044 invalid-map-key)**:键限定 int/float/bool/str(泛型参数暂放行);Vec/struct/enum 键在类型层拒绝,避免运行期静默 None 与 debug TypeError。
- 回归(§52 九项);527 项全绿;模糊 30 程序 0 分歧。

### v0.51.3(2026-11-11)

- **C 后端 UB 与语义对齐(代码审查修复)**:
  - **f64 整数打印**:`x * 10 + 0.5` 转 `long long` 对 x ≥ 9.22e17 是 UB 且输出错值(1e18 → 922337203685477580.0);改为 `snprintf("%.1f")`,1e18/1e19/9e20 与 JS 逐字一致。
  - **有符号窄截断**:原发射 `(long long)(x) << (64-N)` 对负数是 UB;新增 `ming_sext`(无符号域取位 + 位型符号扩展),-5/2147483647/2147483648 三引擎一致。
  - **str 语义**:空模式 `replace("", r)` 改为**按 Unicode 码点插入**(树/VM/C 一致,取代此前的 JS UTF-16 split 语义);`pad_left/pad_right` 宽度改为**码点计数**(与 `char_len` 同口径,C 端不再按字节);`trim` 移除误列入的 U+200B(JS 空白集不含 ZWSP,原实现还会从码点中间切开)。
- 回归(§51 七项,有编译器时含 C 腿):f64 大整数打印、空模式替换(ASCII/CJK/emoji)、pad 码点宽度、ZWSP 不裁剪、有符号窄截断 + `ming_sext` 快照。
- 测试:519 项全绿;模糊 30 程序 0 分歧。

### v0.51.2(2026-11-11)

- **构建可信性四项(代码审查修复)**:
  - **AOT 产物纯 wire 化**:签名只序列化类型判别字段(不再内嵌 `mod`/`decl` AST);tag 池(`structspec`/`enumspec`/`pat`)脱敏;spans/modFile 改为项目内相对路径——struct 形参不再因 BigInt 回退源码模式,产物不再泄漏 AST 与绝对路径。
  - **源码回退复制全部模块**(保留相对路径);launcher 源码模式改为 `new Checker(mingFile)` 从磁盘读全部模块(此前 provider 对所有路径返回入口源码,多模块 dist 必坏)。
  - **缓存命中校验 dist 内容哈希**(相对路径 + 文件 sha256):删除 runtime / 损坏 bytecode 不再"缓存命中",自动重建。
  - **接口哈希修正**:enum 改读 `v.types`(此前读不存在的 `v.args`,payload 类型变化不影响哈希);补 `bounds` 与 impl `typeArgs`。
  - **dist 安全**:写 `.ming-dist.json` 标记;拒绝覆盖非产物 dist(`--clean-cache` 同样跳过),保护用户源码目录。
- 回归(§50 九项):struct AOT 可运行且无泄漏/多模块回退可运行且命中/缓存删改重建/枚举哈希变化/非产物 dist 守卫。
- 测试:513 项全绿;模糊 30 程序 0 分歧。

### v0.51.1(2026-11-11)

- **契约纯性(M3043 contract-not-pure)**:requires/ensures/invariant 中禁止调用会修改接收者的方法(Vec/Map 原地方法、mut self 方法)——此前 `requires (v.pop() != None)` 会真的弹出参数,函数体看到被改后的值。三处契约检查上下文增加 contractMode。
- **ensures 覆盖所有返回路径**:树引擎改为 ensures 栈(取代随 block 传递的 ctx),嵌套 return 与 `?` 早退不再漏检;编译器把 `?` 展开为 match 形字节码(Some/Ok 绑定 + 早退前 ensures + RET),VM/树行为一致。Result 的 Err 路径同样检查。
- **`--json` 输出新增 `engine`(vm/tree)与 `wasm` 字段**,便于观测实际执行引擎(--no-wasm 回归测试改用该字段)。
- 回归(§49 九项):requires/ensures mut 拒绝;Option/Result 的 `?` 早退、嵌套 return 双引擎 M4015(exit 101);`?` 成功路径行为不变。
- 测试:504 项全绿;模糊 30 程序 0 分歧。

### v0.51.0(2026-11-11)

- **效果门禁闭合:函数值不再绕过效果系统(P0,代码审查发现)**:函数类型(`mkFn`)新增 `effects` 集合并参与 unify;命名函数作为值、lambda、以及经变量/实参传递的函数值现在都携带并检查效果。
  - `let g = noisy; g();` 在无 `io` 的函数中 → **M3029**;把带效果函数作为实参传给纯函数参数 → **M3002**(类型串显示 `() -> () with io`)——此前两者均可静默执行 IO。
  - lambda 记录函数体实际使用的效果(嵌套 lambda 向父级 sink 传播);带效果 lambda 传给纯 HOF(`map` 等)被拒,纯 lambda 不受影响。
  - `typeStr` 对函数类型追加 `with <效果>`,诊断可读。
- 回归(§48 六项):调用/实参/lambda/HOF/嵌套 lambda 负例;声明效果后的正例;纯 lambda 正例。

### v0.50.1(2026-11-11)

- **wasm 比较操作码修复(P0,代码审查发现)**:i64 有符号 `<=`/`>=` 误映射为 `0x56/0x57`(gt_u/le_s),应为 `0x57/0x59`(le_s/ge_s)——默认 vm+wasm 引擎对 `<=`/`>=` **静默算错**;两处 f64 比较表整体误用 f32 操作码(`0x5b..0x61`),导致含 f64 比较的模块 **WebAssembly 校验失败并静默回落 VM**(表面结果正确,wasm 层实际从未执行)。修复为 f64 `0x61..0x66`。
- **`--no-wasm` 引擎路由修复**:此前 `new (no-wasm ? Interp : Engine)` 实际选中树引擎,导致 `--no-wasm`/`cmdTest` 与模糊器"VM-only"腿名不副实;改为 `VMInterp` + `{noWasm:true}`。
- 回归(§47 六项):i64/f64 六种比较符 default vs tree 逐字一致;wasm 存活断言(`[wasm] fn g6 OK` 且无"实例化失败");`--no-wasm` 走 VM(用 ensures 嵌套 return 的树/VM 可区分程序验证)。
- 测试:488 项全绿;模糊 40 程序 0 分歧(1 跳过)。

### v0.50.0(2026-11-11)

- **自举工具统一入口 `ming tools`**:把高频调用从 `node bin/ming.js run tools/xxx.ming -- ...` 缩短为 `ming tools <命令> ...`。命令表:`patch/patch-all/read/write/append/insert/insert-before/del/count`(mingkit 路由)、`edit`(行级)、`diff`(engdiff)、`diag`(diaghot)、`wc/tree/find/json/todo/log/rename/organize`(其余工具);任意 `tools/<名>.ming` 亦可直接调用;`--list` 输出命令表。
  - 实现:CLI 进程内路由(工具本体仍是 Ming,无额外进程启动);编辑类沿用 mingkit/edit 的"恰好 1 处 / 行号越界拒绝"安全语义。
  - 动机(宿主工具使用统计,本会话 351 次调用):**Bash 58.1%、Edit 21.4%、Read 17.7%**——文件读写/补丁是绝对高频,Ming 工具此前因调用摩擦未被日用;统一入口把单次调用缩到 `ming tools patch ...`。
- 测试:482 项全绿(§46 七项:`--list`/patch 精确替换/0 处拒绝/edit 路由/wc 路由/engdiff 路由/未知命令报错)。

### v0.49.1(2026-11-11)

- **GCM 解密最小帧修复**(社区反馈 diviner 的"length-boundary 必须显式测试"直接触发):原校验要求 `nonce 12B + tag 16B + 密文 ≥ 16B`(共 ≥44B),把**密文最小长度误当 16**——GCM 密文可为 0 字节(无填充),导致**明文 < 16 字节的合法包加密后无法解密**(潜伏 bug,原测试明文 20B 恰好绕过)。修正为最小帧 **28B**(12+16),错误消息同步。
- 回归(§45,双引擎):短明文 `"hi"`(30B 包)往返、空明文(28B 包)往返、**nonce 唯一性**(同明文两次加密,12B nonce 前缀必不同)、27B/12B 截断输入必拒。
- 文档:GUIDE std.crypto 表补 nonce 管理指引(随机 96-bit 碰撞界 q²/2^97;NIST 2^32 单密钥上限;更高保证需调用方自管计数器 nonce,当前 API 未暴露)。
- 测试:475 项全绿(§45 两项 vm/tree + §38 两项:launcher 从无关 cwd 运行 / dist 异地拷贝可运行——社区反馈 bytes 的便携性测试)。

### v0.49.0(2026-11-11)

- **ABI 哈希构建缓存(plan.md §4b 兑现)**:`ming build` 新增内容寻址构建缓存——键 = 规范化哈希(编译器版本 + 项目根下**全部** .ming 源 + ming.toml + `--with-source` 旗标);**过包含保健全**(项目内任何源文件变化都使键变化,绝不产生过期 dist);命中(键未变且 dist 完整)→ 跳过全量检查与编译,AOT 产物直接可用。
  - **接口哈希(ABI 防火墙)**:每次构建登记每模块**接口哈希**——decl 规范化序列化(函数签名/参数名/self/效果集/requires/ensures、struct 字段与 invariant、枚举变体、const 值与类型、trait 方法、impl 目标与签名;**显式排除函数体与位置信息**),sha256 前 16 位;构建输出报告 `接口哈希:未变 N 个,变更 <文件>`。改实现不改接口 → 哈希稳定(§44 测试锁定);改签名 → 哈希变更。
  - **`--clean-cache`**:清理缓存与 dist 并全量重建(同一命令内完成)。
  - 缓存文件:项目内 `.ming-cache/build-cache.json`(key/builtAt/compilerVersion/modules;已入 .gitignore)。
- **交互修复**:缓存键纳入 `--with-source` 旗标——否则前置的普通构建命中后跳过 dist 重写,导致附源码失效(v39 测试捕获)。
- 测试:471 项全绿(§44 新增六项:构建写缓存/缓存命中且 dist 可运行/改实现 → 重建且接口哈希稳定/改签名 → 接口哈希变更/--clean-cache 清理并重建/清理后重建的缓存下次命中)。

### v0.44.1(2026-11-10)

- **文档**:新增 `AGENTS.md`(AI 代理协作指南:硬规则/命令/提交规范/已知陷阱)、`docs/plan.md`(v0.45 起的实施计划与 Backlog)、`docs/references.md`(Jenny/Blood 参考语言地址、要点映射与进度查看方式);README 文档节挂链并修正路线图中 v0.43/v0.44 双"当前"标注。
- 无代码变更;测试沿用 422 项全绿。

### v0.48.0(2026-11-11)

- **契约阶段 2 续:QF_LIA 证明子集第一片——ensures 直线体静态验证**(决策:bench 实测 cc/vm 6–11x 运行期健康、编译非瓶颈 → 3b 构建缓存延后,选 3a):
  - **M3042[ensures-statically-false]**:对含 ensures 的函数做直线体符号执行(Let/Assign/ExprStmt(纯调用)/Return;遇 If/While/For/Match/调用结果依赖/非 i64 参数静默放弃),变量追踪为参数的**线性形式** {coeffs, c};返回点以 `result` 绑定返回值形式,对 ensures 求值:线性差为非零常量 → 可证明为假 → 编译错误 M3042 + **反例**(满足 requires 的小值搜索,复用 evalContractExpr);可证明为真/无法判定 → 静默(运行时 M4015 保留,语义不变)。
  - 反例搜索:参数 ≤3 个时在小值候选集(0/1/2/3/5/-1/-2/10/100/-5)上笛卡尔搜索,要求满足 requires(如 requires a > 5 → 反例 a = 10);否则报无具体反例版本。
  - 语义说明:直线体 ensures 恒假时**运行时 M4015 不可达**(编译期已拦);非直线体运行时 M4015 保留。
- 决策记录:plan.md §4(3b 延后理由:当前规模 ming check 全程 126ms,编译非瓶颈)。
- 测试:465 项全绿(§43 新增五项:可证真不误报/等式反例/门控不等式反例/循环静默/调用静默);v0.45 ensures 恒假测试同步为编译期语义。

### v0.47.0(2026-11-11)

- **契约阶段 2 完成:mut 方法退出时的 invariant 重查**(树/VM 一致):
  - 机制:impl 方法派发点(callMethod struct 分支)在 mut-self 方法返回后,以接收者字段为绑定重查 invariant → 违反 M4015(消息与构造期一致)。
  - 语义确认:`mut self` 经 noCopySelf **原地修改接收者**——检查点必须在方法返回后;非 mut 方法受 M3004 约束不能写字段(检查器已有),不参与重查。
  - 健全性链条闭合:构造期 M4015 ✓ + 外部字段写 M3004/M3040 ✓ + 非 mut self 写 M3004 ✓ + mut 方法退出 M4015 ✓——invariant 在每个可观测状态变更点都被检查。
- 健全性边界(诚实声明):mut 方法中途 panic 时接收者可能处于违反态,但 panic 传播使该状态不可观测;跨 panic 的状态恢复不属于语言承诺。
- 待办(移入 v0.48):QF_LIA 边界证明子集(编译期免检 + 反例)、ABI 哈希构建缓存。
- 测试:460 项全绿(§42 新增三项:重查 VM/tree 一致、合法变异不误报)。

### v0.46.0(2026-11-11)

- **契约阶段 2 第一步**:
  - **M3040 invariant 字段封装**:带 invariant 的 struct,字段只能在自身 impl 方法内修改(外部字段写 → 编译错误);impl 内写放行(通过 implTypeName 比对)。无 impl 的 invariant struct 字段在构造后即封装——这是"安全是默认"的自然延伸。
  - **M3041 调用点静态契约校验**(Jenny 反例风格):全部实参为整数字面量时,代入 requires 求值(线性子集:IntLit/Ident/一元 - !/+-*/%/比较/&& || 短路;除零与 i64 溢出放弃判定),可判定为假 → 编译错误 + 反例(如 `amount = -5`)与 else 消息;含变量实参放弃判定交给运行时 M4015。字面量违反从"运行时才炸"前移到"编译期拦截"。
- **P0 修复:invariant struct + 缺 for 的 impl 导致检查器崩溃**:解析恢复(`recover(true)`)会把 impl 块内的 `fn (mut self)` 当成顶层函数注册(裸 self → param.type = null)→ resolveTypeAst(null) 崩溃;修复 = resolveSigs 标记 poisoned(真实错误 M2002 已由解析器报告)+ checkBodies/compiler 跳过。
- **M4015 语义前移说明**:requires 的字面量违反现在在编译期报 M3041;运行时 M4015 保留给静态不可判定的实参(变量/表达式)。
- 测试:457 项全绿(§42 新增六项:P0 回归/M3040 封装与放行/M3041 反例与变量不误报)。
- 待办(v0.47):mut 方法退出时的 invariant 重查(需合成 invariant 函数);QF_LIA 证明器;跨调用点约束推导。

### v0.45.1(2026-11-11)

- **tools/edit.ming 行级编辑器**(与 mingkit 互补:mingkit 按模式,edit 按行号):show/get/set/ins/del/sub/append/count 八个子命令;一层转义(`\n` `\t` `\\`);**行号越界/区间非法一律拒绝落盘**;尾部换行保真(有/无 `\n` 结尾在编辑后保持不变);空文件视为 0 行。自举中修复自身三处错误:`load` 以 mut 参数回填向量违反值语义(改为返回 `Result[Vec[str], str]`)、`save` 缺 io 效果、`parse_range` 的 `e` 缺 mut。
- **tools 目录检视(v0.45 期间新增的 8 个工具全部实测)**:
  1. `log_analyzer` 尾部空行 off-by-one(4 行文件报 5)——与 wc 口径对齐修复;
  2. `batch_rename` / `file_organizer` 默认目录 `"."` 危险(误运行会改名/打散当前目录文件)——目录改为必须显式给出;
  3. 全部工具统一为 **args 优先、env 回退** 双接口,并新增 §41 二十项实测。
- **修复 v0.45.0 的两处交付缺陷**:
  1. **契约测试节被排在汇总之后**——套件汇总打印先于契约测试执行,节内 11 项从未真正入套;已移至 §40(汇总之前),首次真正执行全部通过;
  2. **GUIDE/README/diagnostics 三文档经有损编码重写**(全文件 2460 处 CJK 字节损坏,CJK 第三字节被写为 `?`)——从 v0.44.1 干净版本恢复,并重打 v0.45.0 的全部文档变更(M4015 行、路线图、修订记录)。源码文件未受影响(已逐文件扫描确认)。
- 测试:451 项全绿(§40 契约 11 项首次真正入套 + §41 工具 20 项)。
- 无语言/运行时语义变更。

### v0.45.0(2026-11-10)

- **v0.45 主题:契约系统阶段 1(requires/ensures 运行时检查)**:
  - 语法:`fn f(a: i64) -> i64 requires a > 0 else "..." ensures result > a else "..." { ... }`;契约表达式必须是纯表达式(效果检查在无效果上下文中执行,调用 io/fs 等报 M3029);`result` 在 ensures 中绑定返回值。
  - 运行时:requires 在函数入口检查;ensures 在每个 return 与块尾返回值前检查;违反 → M4015[contract-violation],消息含条件与实际值,退出码 101;树引擎与 VM(含 wasm/C 资格对齐)一致。
  - 诊断:M4015 登记;invariant 语法与 struct 字段解析已支持,运行时检查进行中。
  - 测试:428 项全绿(§40 新增契约正例、requires/ensures 反例、双引擎消息一致)。

### v0.44.0(2026-11-10)

- **v0.44 主题:AI 协作护栏(受 Jenny/Blood 调研启发)**:
  - **W3104 测试字面量过拟合检查**:同文件 test 断言中的非常量字面量出现在实现函数 if/while 条件比较中 → 告警(不阻断;通用值 0/1/-1/2 与空串豁免)。对应 Jenny 的 `E0905_TEST_LITERAL_OVERFITTING` 思路。
  - **结构化修复处方**:`ming check --json` 诊断新增可选 `fix: {start, end, replacement}`;首批三类——缺 token(M2002,expectOp/expectKw 插入)、效应未声明(M3029,函数体 "{" 前补 `with ...`)、名字拼错(M3001,最接近可见名替换)。每条 fix 经"应用→复检→错误消失"测试锁定。
  - **tools/diaghot.ming 诊断热力图**(仓库第三个 Ming 自写工具):批量跑 `ming check --json` 聚合诊断码频次/文件数/样例消息,Top-N 输出——让语法与检查改进有数据依据。
  - **效果屏蔽设计定稿**(design.md §6.11,mask 方向):块级 `mask [fs] { ... }` 语法草案;v1 健全性 = 效果承载值不逃逸 + 不改求值语义 + 无正式证明器(显式声明);与 §6.10 `with unsafe` 共用逃逸分析、互为门面。
- **连带的真实修复(自举/自测暴露)**:
  1. **检查器 unify 漏 `json` 分支**:任何 `Json` 值参与赋值/传参即报"Json 与 Json 不匹配"(既有测试只走方法调用,未覆盖统一化)——diaghot 编写时暴露;
  2. **VM 操作数栈残留**:全帧共享 valueStack,match 降级的 DUP/…/SWAP/POP 清栈在 arm 内 `return` 提前 RET 时被跳过 → 调用方 CALLMETHOD 弹出错位 receiver(`内部错误:Option.set` 一类);修复 = 帧记录 stackBase,RET 与 `?` 提前返回时截断本帧残留;新增回归测试(方法调用 + 带 match 的函数实参,双引擎一致)。
- 测试:422 项全绿(§39 新增八项:W3104 正/负例、三类 fix 应用复检、diaghot 聚合、VM match-return 回归、模糊快档)。

### v0.43.0(2026-11-10)

- **ffi 字符串桥**:extern 声明支持 str 参数/返回(ming_str ↔ NUL 结尾 C 串:ming_cstr/ming_str_from_c;C ABI 槽签名 const char*)。实测 msvcrt strlen("hello ming")=10、"中文"=6(UTF-8 字节口径)。
- **Result[i64, str] 进 C 面**:Ok/Err 构造、is_ok/is_err/unwrap(M4006 `对 Err(...) 调用 unwrap()` 逐字)/unwrap_err(M4006 `对 Ok(...) 调用 unwrap_err()`)/unwrap_or;值语义 = 头部拷贝(错误串缓冲不可变)。
- **with ffi 的用户函数参与 C 编译**:资格分析新增 opts.ffi(效果 ⊆ {ffi} 放行;wasm 路径不受影响)+ extern fn 预标记(dlsym 槽替代桩体)。
- **资格基线修正(连带修复)**:
  1. isEligibleShape 的 numOk 基线恢复 wasm 既有形状(str/Vec/Map 无条件;opt/res 由 ext2/ext3 控制)——此前误将 str/vec 条件化,导致 §33 的 wasm 直调测试失去实例化;
  2. prelude 构造器(Some/None/Ok/Err)不再被 walkCalls 当作未解析调用 —— 此前带构造器的函数在不动点被整批降级(C 后端 ffi 函数即此遭遇);
  3. ri64 进方法 base 临时求值与防御零值清单。
- **`with unsafe` 设计定稿**(design.md §6.10,不实现):块形态优先于函数形态;Ptr[mut u8]/Ptr[u8] 不透明指针;块内 load/store/offset/is_null 四操作;空指针 UB 诚实声明(--checked-ptr 调试模式);unsafe 函数永不进 wasm/C 快路径(效果门禁一致)。
- 测试:411 项全绿(§38 新增五项:Result 四方一致/M4006 Err 首行对齐/ffi str 桥/JS M4001 拒绝/模糊快档)。

- **真 AOT 第一块(字节码产物,并入本版)**:新增 src/artifact.js——编译产物(函数指令流/常量池/span 表/wasm 分层)序列化为 app.bytecode.json(池内 `__tag` 包装值单列编码);`VMInterp.fromArtifact` 加载端跳过 Checker 与编译器直接执行(树引擎不支持产物);`ming build` 默认产出纯字节码 dist(无明文 .ming),`--with-source` 附源码;用户 trait/impl 方法分发由 serializeArtifact 显式拒绝并回退源码模式。修复:sync 回退检测此前查错字段(entry.effects 不存在,效果在 entry.sig.effects)——含 spawn 程序误进 AOT 后运行期 worker 读占位源路径 ENOENT。测试:413 项全绿(新增 AOT 无明文源/--with-source/sync 回退三项)。

### v0.42.0(2026-11-10)

- **C4 `with ffi` 兑现(extern fn 声明形态)**:
  - 语法:`extern "库" fn 符号(参数) -> 返回;`(库可省略 = 当前进程;无 effect 子句 —— extern 隐含 ffi 效果)。`extern` 从保留字升级为关键字(RESERVED 移除,KEYWORDS 加入)。
  - **效果即门禁兑现**:extern 符号调用要求调用方声明 `with ffi`(M3029 逐层传播,与 io/fs/net 同一机制);无门禁的代码在类型层不可能触达 FFI —— design.md §6.9 的核心主张落地。
  - JS 引擎:合成桩体(panic 调用)→ 运行时 M4001 `ffi 调用需要 C 后端(ming cc);JS 引擎不执行 FFI`(诚实拒绝;桩体不参与类型检查)。
  - C 后端:dlopen/LoadLibrary + dlsym/GetProcAddress 启动绑定(`ming_ffi_bind`),调用点直调函数指针;库/符号缺失 → **M4013[ffi-load-failed]** 退出 101(诊断码启用)。签名限数值(i64/u64/f64),str/结构参数属后续扩展。
  - 设计取舍记录:§6.9 的运行时 `lib.fn(名, 签名)` API 延后 —— extern 声明形态符号编译期已知,AOT 友好且无需 Lib/Fn 句柄类型;`extern fn` 不进 wasm/C eligible(效果自动拒绝),与差分腿无交集。
- **`ming cc --static`**:静态链接产物(gcc -static;工具链不支持时报错透传)。
- 测试:406 项全绿(§37 新增五项:效果门禁 M3029/JS M4001 拒绝/C 后端 dlsym 调用/--static 产物/模糊快档)。

### v0.41.0(2026-11-10)

- **C 后端 C3:Map/Option/f64 打印进入 C 面**(`ming cc`,src/cbackend.js)——**cc 差分腿覆盖 = 解释引擎全形态**:
  - Map[str,i64] = `ming_map{d,n,cap}`(插入序线性表;set 已有键原位更新;值语义 = let/赋值/mut 传参 ming_map_copy);下标缺键 M4007 消息逐字对齐(键经 debugStr 引号);set/has/get(→Option)/delete/clear/len/is_empty;for-in `(k, v)` 元组模式。
  - Option[i64] = `ming_opt{some,v}`;Some/None 构造(裸 `None` 标识符与 `Some(x)` 调用两种形态);unwrap(M4006 `对 None 调用 unwrap()` 逐字)/unwrap_or/is_some/is_none;Vec.pop/get → Option。
  - float→int 截断:`ming_f2i_sat/ming_f2u_sat`(向零截断 + 饱和;NaN → min/0,与 interp castValue 逐字对齐)。
  - f64 打印:`ming_float_str`(interp floatStr 语义:NaN/±Inf/整值 toFixed(1)/JS Number::toString 最短往返重排;修复 `%.0e` 单位尾数无小数点导致数字收集越界的段错误)。
  - str:trim/trim_start/trim_end(JS 空白集 UTF-8 实现)/starts_with/ends_with。
  - 方法 base 统一为"非 Ident 求值一次入临时"(修复链式 `m.get(k).unwrap_or(0)` 的 oi64 base 无发射路径 + 双求值);`ming cc --no-run`(只构建不运行——运行退出码 = 程序退出码,差分工具据此分离构建与运行)。
- **检查器第六处 valuePos 缺位**:内建调用实参(`str(if …)` 实参返回 unit)——checkExpr 值位置清单补齐内建 args。
- **模糊器 cc 族 = wide 全形态**:新增 mapx 形态(set 覆盖/has/get/len/for-in(k,v)/delete);option/f64 解锁进 cc 族;f64 形态直接 `print(str(f))`(floatStr 差分);生成器 `fabs` → `abs` 修正。四种子(20261109/39039/35035/40040/40041)全 100% 一致,C 腿 11-24 条/轮。
- 测试:401 项全绿(§36 新增:C3 综合四方一致/unwrap None/M4007 缺键 panic 对齐/C3 全形态模糊档)。

### v0.40.0(2026-11-10)

- **C 后端 C2: str/Vec[i64] 进入 C 面**(`ming cc`,src/cbackend.js):
  - 资格分析 sigExt(wasm.js `isNumericSig(f, ext)` 单一事实来源扩展):str 与 Vec[i64] 签名放行。
  - str = `ming_str{p,n}`(UTF-8 字节,不可变缓冲 + 头部拷贝);cat/eq/cmp(字节序,UTF-8 保序)/char_len(码点计数)/contains/replace/slice_chars(码点索引,M4003 逐字对齐)/pad_left/right(空格,与 interp padStart 同源)。字面量经八进制转义全局数组(`\xNN` 的贪婪十六进制陷阱规避)。
  - Vec[i64] = `ming_vec{d,n,cap}` + malloc 增长;**值语义**:let 绑定/赋值/mut 传参一律 `ming_vec_copy`(同 wasm ming_copy_vec 边界);下标读/写 M4003(消息含 `(用 .get(i) 返回 Option)` 后缀,与引擎逐字对齐);push/reverse/contains/len;for-in 下标展开。
  - match 表达式(整数字面量臂 + 通配 + guard,AST 实测:PLit 值在 `pat.lit.val`(字符串),通配解析后是 `PIdent` 无 name)→ if/else 链;防御分支与 VM 同构(M4001)。
  - 方法面允许任意 base 表达式(纯方法);变异方法(push/reverse)要求局部接收者。print 支持直接 str 与 `str(str)`(`%.*s`)。str 返回函数的防御零值用复合字面量。
- **engdiff 自举工具**(tools/engdiff.ming,仓库第二个 Ming 自写工具):`node bin/ming.js run tools/engdiff.ming -- <file.ming>` 一条命令跑三引擎(vm+wasm/tree/vm-only)对比 stdout+退出码,分歧逐引擎列差异退出 1。自举过程即抓到两个使用层错误(main 参数是显式形参;`proc.exec` 的 args 不含命令名)。
- **模糊器 cc 族拓宽到 C2 面** + 实际使用揭穿三处生成器假通过(v0.33 起潜伏):
  1. vec 形态固定名 `vv`/`vv2` 重复声明 → M3016(三后端一致拒绝 = 假通过);
  2. match guard 语法错:写成 `模式 => 表达式 if 条件`(非法),Ming 的 guard 是 Rust 风格 `模式 if 条件 => 表达式`;
  3. 连带揭出检查器第五处 valuePos 缺位:一元负号操作数(if 表达式作 `-` 的操作数返回 unit)。
  四种子(20261109/35035/39039/40040)全 100% 一致,C 腿 14-24 条/轮,0 跳过。
- 测试:397 项全绿(§35 新增:C2 综合四方一致/vec OOB/slice OOB panic 对齐/engdiff/str main 正向化 + 插值串拒绝)。

### v0.39.0(2026-11-10)

- **C 后端 C1 落地**(`ming cc`,src/cbackend.js):`ming cc <file> [--emit-c] [--out 目录]`——numericOnly 资格分析(`analyzeEligibility`,与 wasm 单一事实来源,wasm.js `analyze(opts)` 提取)+ **整程序 AOT**(main 限定"AOT 形态":数值语句/对 eligible 函数的调用/`print(str(整数))`/字面量串)。映射:i64→long long、u64→unsigned long long、f64→double;checked 运算 → `__builtin_*_overflow`;除/模/移位显式守卫(LLONG_MIN/-1、UB 消除);panic 首行逐字对齐(eligible 函数内 = wasm 层通用消息,main 内 = binopValues 具体消息含操作数;退出码 101);stdout/stderr `_setmode` 二进制模式(关 CRLF);递归经 static 原型先行。编译器探测:MING_CC → PATH(gcc/clang/cc)→ 已知便携位置(w64devkit 等)。基准:纯 sum/fib 场景 cc 比 wasm 再快约 10x(fib(24) 9.7ms vs 99ms)。
- **wasm 层四项休眠 bug 修复(v0.39 发现并修复——wasm 端到端首次真正复活)**:
  1. signed 乘法溢出检查缺块闭合 `end`(v0.23 起)——任何含 `*` 的 eligible 函数都让整模块校验失败 → 静默回落;
  2. `callCompiled` 的 wasm 快路径要求 `captures === null`,而 OP.CALL 路径的 LDFN 值是 `captures: []` 的 vclose——**字节码对模块函数的直接调用从未进过 wasm**(只有测试直调进过);
  3. `atan2`/`hypot` 被声明为单参导入(双参清单漏项)——调用只消费栈顶实参,其余留栈参与后续运算 → 静默错值;
  4. u64 返回缺 `asUintN` 位型还原(wasm i64 以有符号 BigInt 出栈)。
- **解析器/检查器修复(模糊器加深逼出)**:
  - M2005 链式比较检查误伤:`l.nt === 'Binary'` 把 "a + b <= c" 这类合法算术左操作数也拒绝 → 改为仅拦同级比较链;
  - valuePos 四处缺位:二元操作数、赋值右值、as 操作数、块尾表达式——if 表达式在这些位置被当作语句形式返回 unit(合法程序被拒)→ checkBinary/checkAssign/As/checkBlock(值上下文链)补传 valuePos。
- **模糊器加深**(tests/fuzz.mjs):形态池新增 f64+std.math(经 as i64 饱和截断消费)/match 表达式(字面量臂+guard)/loop+break+continue/Option(unwrap_or 常态、偶发 unwrap 触发 M4006)/Vec 方法(push/pop/contains/reverse)/str 方法(pad_left/slice_chars/contains/replace)/区间 for/逻辑作为值;**cmp 形态修复**——bool 不能 `as i64`(M3019),v0.33 起的比较转 i64 形态恒被检查器拒绝(三后端一致拒绝 → 假通过零覆盖),改用 if 表达式惯用法;**C 第 4 差分腿**:约 40% 程序生成"cc 族"(纯数值,C1 面内),检测到编译器时四方对比,C1 拒绝 cc 族程序 = 发射器回归(记分歧);新增 `--dump N`(复现第 N 个程序)。
- **`with ffi` 设计定稿**(design.md §6.9,不实现):效果即门禁(`ffi` 为预留效果名,v0.39 不开放,M3030 仍拒绝)、签名即文档(std.ffi.load → Result[Lib] + lib.fn(名, 签名))、v1 类型面(i64/u64/f64/bool + Ptr 句柄)、错误模型(加载失败 = Err;段错误 = 进程级,Ming 不捕获——诚实声明)、诊断码 M4013/M4014 预留。能力矩阵 49 行口径 ≈80%(FFI ❌→🟡,新增 C1 行)。
- 测试:391 项(新增 v0.39 §34 十项:emit-c 快照/AOT 形态外拒绝/四方一致/panic 首行对齐 ×3/u64+as+类型级一致/编译器探测/模糊快速档;模糊档断言适配 C 腿输出)。基准:bench.mjs 增 cc 腿(无编译器自动跳过)。

### v0.38.1(2026-11-09)

- **mingkit 边界校验补强**: read 空文件直接返回(不输出那个因 print 抵消而多出来的空行);行区间 start > end、delete-lines start < 1 / end < start / start > 文件实际行数 全部显式报错退出 1;delete-lines 的 end 截断至文件实际行数(与 count 行数口径一致:split 的尾部空元素不算行)。
- **运行时 print_raw**(src/interp.js `BUILTIN_IMPLS`,与 VM 双引擎共用;compiler.js / checker.js 各注册一处):不分页输出,不附加换行。配合 read:有尾部换行用 print(剥一换行再输出,抵消 print 的换行),无尾部换行用 print_raw 精确输出,写出去什么读回来就是什么。
- 测试:381 项(0 失败),mingkit 专项 23 项(上版 20 项)。

### v0.38.0(2026-11-09)

- **`ming build` dist 产物落地**(v0.37 决策兑现):项目检查通过后产出 dist 目录——app.ming(源拷贝)+ runtime 8 模块(checker/compiler/interp/vm/wasm/lexer/parser/diag)+ **ming-app.mjs launcher**。launcher:参数透传、`--` 剥离、panic → 101、诊断 → 1;Node ≥ 18 零依赖,跨 cwd 运行(路径经 import.meta.url 解析)。`--no-dist` 可关。部署形态:拷贝 dist 目录即可。
- **原生后端(C)预研**(design.md §6.8):关键洞察 = **wasm 资格分析直接复用**(`isEligibleShape` + 不动点回退已解决"哪些函数可原生编译");映射草案(checked 运算 → __builtin_overflow 系列、Vec 线性布局沿用 [len][cap][elems]、panic → setjmp/longjmp、效果 → C stdio);里程碑 C1(数值函数对标 wasm)→ C2(str/Vec 全形态)→ C3(交叉编译 -static)→ C4(`with ffi`/`with unsafe`)。门禁不变:效果系统约束 C 产物。
- **模糊器 if/else 语句形态**(含字符串分支):分支求值三后端差分;100 程序新种子零分歧。
- 测试:374 项(新增 v0.38 5 项:build 产物完整性/args 透传跨 cwd/无参默认/panic 101/模糊 if-else 快速档)。

### v0.37.0(2026-11-09)

- **AES-256-GCM(带认证 AEAD)**(std.crypto,能力 crypto):输出 = nonce(12B 随机)+ tag(16B)+ 密文(无填充,密文 = 明文长度);解密时 GCM tag 校验失败(篡改/nonce 不符/密钥错误)→ Err。测试含**主动篡改检出**(异或翻转一个密文字节 → 认证必失败)——弥补 v0.36 CBC 无认证的缺口。
- **模糊器扩展**(tests/fuzz.mjs):str 形态(拼接/char_len)+ **for-in 深形态**进入程序池——for-in 求和现在经 wasm 直跑(v0.33 修复的常驻差分防线);100 程序新种子零分歧。
- **ming build 预研结论**(design.md §6.5):运行时闭包实测 8 模块 467 KB;v0.38 决策 = `ming build` 产物为 **dist 目录**(字节码 JSON + 运行时拷贝 + launcher),零打包器风险;单文件 bundle 推迟至需求驱动。
- 测试:369 项(新增 v0.37 3 项:GCM 往返/篡改检出双引擎、模糊扩展形态快速档)。

### v0.36.0(2026-11-09)

- **字节流正则**(std.re 扩展,纯函数;北星支柱 4 落地):`is_match_bytes/find_bytes/replace_bytes`——Vec[u8] 按 **latin1 无损桥接**(1 字节 = 1 码点 0..255),pattern 可用 `\xNN` 匹配原始字节,结果按 latin1 编回,全程零损坏。逆向特征提取/二进制协议匹配的基础。
- **AES-256-CBC 加解密**(std.crypto,能力 crypto):`aes256_encrypt(key, plaintext) -> Result[Vec[u8], str]`(key 恰好 32 字节,输出 IV 16B 随机 + 密文)、`aes256_decrypt(key, data) -> Result[str, str]`(padding 校验失败 → Err)。**诚实声明:CBC 无认证**,防篡改组合 hmac_sha256(key, data)——文档明示。
- **位域/struct packing 设计判断(不做)**:C 式 struct 布局控制与值语义正交;显式 pack/unpack(v0.35 std.bin)就是 Ming 的 packing 答案,位域 = 移位掩码惯用法。设计记录入 GUIDE std.bin 节与 design.md §6.1。
- 测试:366 项(新增 v0.36 4 项:字节流正则向量双引擎、AES 往返/短 key/随机 IV 双引擎)。

### v0.35.0(2026-11-09)

- **std.bin 显式字节序打包/解包**(纯函数,安全工具之北支柱 1 落地):pack/unpack × u16/u32/u64 × le/be 共 12 函数。设计立场:**拒绝隐式端序**——be/le 显式枚举为独立函数(一种结构一个语法),而非字符串参数。语义:pack 值域超限 = 不变量破坏 → panic(提示显式 `as` 截断);unpack 越界/短缓冲/非 u8 字节 = 数据驱动错误 → Err;u64 读数 ≥ 2^63 按补码位型转 i64(与 fmt.hex/bin 对称)。
- **crypto 补 HMAC 五件套**:`hmac_md5/sha1/sha256/sha384/sha512(key, msg)`,维基百科公开向量测试。
- **模糊器 as 扩展**:随机 `as u8/i8/u16/i16/u32/i32/i64 as i64` 双重转换进入表达式池——树引擎 castValue 位截断/回绕语义 vs VM CAST 指令的差分回归防线;80 程序新种子零分歧。
- 测试:362 项(新增 v0.35 6 项:bin LE/BE 向量/往返/越界/u64 补码 双引擎、pack 值域 panic、HMAC 公开向量 双引擎、模糊快速档)。

### v0.34.0(2026-11-09)

- **北极星立项:安全工具之北**(design.md §6,用户定义的远期定位)——六大支柱(二进制/内存控制、原生系统交互、海量并发网络、动态执行、交叉编译部署、密码学对抗)与 Ming 的映射、冲突(值语义 vs 零拷贝、沙箱 vs syscall)及差异化答案(效果系统 = 泛化的 unsafe 块,每个危险操作都是签名里的一行字)。能力矩阵纳入北星行列(新增 FFI/原始包/eval/交叉编译等 ❌ 行,覆盖率口径如实回落)。
- **std.crypto 哈希五件套**(能力 crypto,新效果名):md5/sha1/sha256/sha384/sha512,node:crypto 桥接,hex 小写;已知向量测试("abc" 三向量 + 空串向量);效果强制 M3029 现场验证。后续:AES/RSA/国密、字节流接口、HMAC。
- **wasm 步长修复后的首轮全量运行**:for-in/vec 全形态在真实 wasm 上经受 352+ 项回归与三后端差分模糊(40+200+100 程序,三种子零分歧)。
- 测试:356 项(新增 v0.34 4 项:已知向量双引擎/空串向量/效果强制)。

### v0.33.0(2026-11-09)

- **wasm for-in 错值根因钉死:元素步长常数写的是 3 而非 8**(`i32.const 3; i32.mul`,注释却写"×8")。自线性内存引入以来,所有 for-in 元素读取都按 3 字节步长错位取值。定位方法:逐轮探针(x 与 t 每轮存入魔法地址,JS 侧读回)→ 每轮读值 1, 2, 0 且移位模式与"3 步长错位"逐字节吻合 → 全库排查同款错字:**4 处** `const 3; mul`(for-in 加载 / vec 下标赋值 / ptr push / grow 搬迁)全部改为 ×8;合法的 align=3(load/store 对齐提示)与 shl-3(移位乘法惯用法)保留。修复后 for-in 求和**直接经 wasm 导出**金标准(sumv([20,22,24,26])=92,基址非零、多元素),v0.32 的回落防御撤除。
- **最小模糊测试基线**(`tests/fuzz.mjs`):随机纯 i64 程序(变量/算术/比较/有界循环/Vec)在三后端(树引擎 / VM+wasm / VM--no-wasm)差分对比 stdout+退出码+错误码;mulberry32 确定性种子,`--seed/--count` 可调。**首战战果:第 6 个程序即抓到树引擎 `as` 崩溃**——字段名 `asType` 应为 `type`(与解析器/VM 不一致;树引擎一切 `as` 表达式必崩,自 as 诞生起未被发现——`as` 缺树引擎专属测试)。修复后 40+200 程序零分歧。回归套件内置快速档(40 程序,种子固定);完整档:`node tests/fuzz.mjs --count 500 --seed N`。
- 测试:352 项(新增 v0.33 3 项:for-in 经 wasm 导出金标准、双引擎结果、模糊快速档)。

### v0.32.0(2026-11-09)

- **重大考古发现:wasm 分层从未真正运行过**——自 v0.23(仓库首个提交)起,任何包含 eligible 函数的程序,wasm 模块实例化即失败并**静默回落 JS VM**;341 项测试全绿掩盖了这一点(回退产出相同结果)。逐层修复(每层都被下一层暴露):
  1. 导入节对 VECMAP 表 results 标量的 `results.map` TypeError(整模块 emit 即抛);
  2. `N_IMPORTS` 引用未定义变量(ReferenceError);
  3. 26 处 `sleb(0x40)` 把 void 块类型编码成多字节(类型索引 64 非法);
  4. `pushScope/popScope/emitStore` 三个被调用却从未定义的方法;
  5. ming_alloc/ming_copy_vec 被生成代码调用却未在导入节声明;`map_key_at` 同;
  6. `growImportIdx/strFromIdx` 按旧表布局写死偏移(指向错误函数);
  7. memory 节 `ulebBytes(4)` 声明 4 个 memory(上限 1)且未导出——JS 侧 `wasmMemory` 从未赋值;
  8. math 导入 JS 侧从未提供(v0.12 起);
  9. scratch 槽基址 = f.nLocals 与用户 let 槽**完全重叠**(局部变量被冲掉)→ 两遍发射修复;
  10. `fib(n)=f(n-1)+f(n-2)` 的 lhs 结果存 scratch0 后被 RHS 子表达式复用冲掉 → lhs 留在值栈横跨 RHS 求值;
  11. for-in 元素加载地址算式多压一个 i 且少一次加法(绝对地址 + 操作数栈失衡)——**此路径修复后仍有残余错值(多元素非零基址),按"安全是默认"整体回落 JS VM,列入 v0.33**。
- **制度化教训(并入 §2.16 门禁模型)**:"输出正确"不等于"该层在跑"。存活断言(wasmExports 非空 + eligible 非空 + **经 wasm 导出**的金标准)进入回归,`MING_WASM_DEBUG` 路径证实制度化为常规测试。
- **发布期门禁落地**:`--max-alloc N`(累计分配口径:Vec/Map 元素 + str 字符;计费点:VecLit/MapLit、push/extend/insert/clone/map/filter/slice、map set 新键、字符串拼接/repeat/replace/to_bytes、wasm ming_alloc)超限 **M4011**;`--max-ms N` 墙钟熔断(每 16384 步轮询)超限 **M4012**;两者 + maxSteps 均穿透到子任务 worker。CLI 修復:`--max-* N` 空格分隔形式此前落进位置参数。
- **流式二进制读写评估(结论:不做)**:8MB 上限 + 整文件 Vec[u8] 已覆盖 AI 胶水场景;流式需要 FileHandle 类型、句柄关闭语义、以及"句柄不可拷贝"的禁存规则(与 Join 同类),与原生后端阶段一并设计收益更大。
- 测试:349 项(新增 v0.32 8 项:wasm 存活断言/导出金标准/M4011 双引擎/M4012 双引擎/配额穿透子任务(错误链协同)/for-in 回落正确性)。

### v0.31.0(2026-11-09)

- **二进制 I/O 雏形**(能力 fs):`fs.read_bytes -> Result[Vec[u8], str]`(整文件,单文件上限 8MB)、`fs.write_bytes` / `fs.append_bytes`;配套纯函数 `s.to_bytes() -> Vec[u8]`(UTF-8 编码)与 `bytes.to_str() -> str`(UTF-8 解码,无效序列 → U+FFFD;仅 Vec[u8] 有此方法,Vec[i64] 调用 M3015 拒绝)。诚实口径:无流式、无随机访问、无 mmap——雏形。
- **任务超时/取消**(能力 sync):`join_detailed(h, timeout_ms)` 可选第二参数(缺省 120s;≤0 → panic M4001;上限 1 小时);超时 → Err 码 **M4010**(task-timeout,新稳定码,以 Err Json 的 code 字段出现)且任务被 terminate;`std.sync.cancel(h) -> bool` 硬杀(不可捕获),之后 join/join_detailed → Err"任务已取消",scoped 块不再等待已取消任务(否则会等满 120s——terminate 后 SAB 永不写);join 超时路径补句柄清理(此前超时句柄滞留,二次 join 会再等 120s)。
- 效果系统现场验证:探针程序漏写 `with time` 被编译期 M3029 拦截,提示语直接给出修法——门禁按设计工作。
- 测试:341 项(新增 v0.31 7 项:二进制往返含 0/255 边界/缺文件 Err/双类型门槛/超时与取消全流程,双引擎)。

### v0.30.0(2026-11-09)

- **错误链(cause)落地**:
  - **子任务 wire v2**:sync 子任务失败时传 `{error, code, stack}`(此前只有 message 字符串——panic 码与调用栈在任务边界全丢)。
  - **`std.sync.join_detailed(Join[R]) -> Result[R, Json]`**(新,效果 sync):Err 为 Json `{code, message, stack}`;`join` 保持 `Err[str]` 完全兼容。
  - **scoped 块真实码透传**:子任务 panic 传播时抛**子任务的真实码**(如 M4002;此前一律硬编码 M4001),原始码/消息/栈挂到 `Panic.cause`。
  - **诊断协议**:panic 诊断新增可选 `cause` 字段(`--json`:`diagnostics[0].cause = {code, message, stack}`;文本:`Caused by <code>[<message>]` + 各帧)。见 docs/diagnostics.md。
- **顺带修复重大缺口:panic 调用栈从未生效**——`Panic.stack` 字段存在、展示代码存在,但从未被填充(`callStack` 一直维护却没接到 Panic 上),"panic 输出 Ming 层调用栈"的承诺自 v0.14 起名存实亡。修复:两引擎最深调用帧接住 Panic 时填全链(最老在前,展示层反转;main 帧用声明位置)。本缺口由 join_detailed 的栈断言测试暴露(has_stack=false 而非 true)。
- 测试:334 项(新增 v0.30 8 项:调用栈双引擎含帧序断言、join_detailed Ok/Err 双引擎、join 兼容、scoped cause 文本/json/tree、类型门槛 M3002)。

### v0.29.0(2026-11-09)

- **std.math 补全**(11 个,纯函数):反三角 `asin/acos/atan/atan2(y,x)`、双曲 `sinh/cosh/tanh`、`log2/log10/cbrt/hypot(a,b)`——签名只收 f64(int 实参 M3002,无隐式转换);**wasm 导入桥接**(MATH_IMPORTS 追加,索引动态推导;MING_WASM_DEBUG 证实 eligible 函数编译 OK 零回落,三层输出一致)。
- 路径验证纪律:v0.20 的"静默缺口"教训制度化——新桥接必须用 MING_WASM_DEBUG 断言 `fn ... OK` 且无 REJECT,输出一致 ≠ 路径正确。
- 测试:326 项(新增 v0.29 5 项:数值表 vm/tree 双跑、wasm 三层一致、wasm 路径证实、类型门槛 M3002)。

### v0.28.0(2026-11-09)

- **std.log 级别日志**(能力 io):`debug/info/warn/error(msg)` → `[LEVEL] msg` 到 **stderr**;阈值 debug < info < warn < error,默认 info,低于阈值直接丢弃;`set_level`(非法值 → panic,程序员错误)/`get_level`。设计立场:日志只影响诊断流,不影响程序值——print 保持唯一 stdout 通道,永不混流;含 log 的函数 wasm 自动回落。
- **std.fmt.align(s, width, mode)**(纯函数):宽度对齐,字符数口径;left/right/center(center 左侧取 floor,补齐偏右——确定性规则);超宽原样;非法 mode → panic。
- 测试:321 项(新增 v0.28 6 项:级别过滤含 stderr 精确比对/双引擎一致/set_level 非法 panic/align 三模式与中文口径/align 非法 panic/效果强制 M3029/align 纯函数)。

### v0.27.0(2026-11-09)

- **std.fmt 格式四函数**(新模块,纯函数):`fixed(f64, 位数)` 定点、`hex(i64)`/`bin(i64)`(u64 位型,负数按补码,`0x`/`0b` 前缀)、`exp(f64, 位数)` 科学计数法——进制与精度显式化,输出确定。
- **std.net.http_request_opts**:`(method, url, headers, body, timeout_ms) -> Result[(i64, Map[str, str], str), str]`——**响应头可读**(Map,键小写)、**超时毫秒可配**(此前固定 35s 且响应头不可见)。与 http_get/http_request 共用统一执行器(行为一致)。
- **HTTP 执行器统一(v0.27 重构)**:三个入口同一 worker fetch 路径;SAB 传递协议 `[status@0][len@4][hlen@8][body@12][headers@8+CAP]`。
- **两个边界 bug(本轮自测暴露并修复,诚实记录)**:
  1. SAB 布局重叠——hlen 字段(字节 8-11)与 body 起始偏移 8 冲突,body 前 4 字节被 hlen 覆盖(表现为 U+FFFD/NUL 污染);修复:body 移至偏移 12,字节级探针验证。
  2. Map 键表示——执行器把 V 对象当键存入,违反"ming map 键 = 原始 JS 基元"内部约定,`get()` 永远落空;修复:键存原始串。测试输入 "x-ming" → 响应回显头 6 项键值全对,双引擎一致。
- 测试:299 项(新增 v0.27 4 项:fmt 3 + http_request_opts 端到端 1;后者含独立 echo 服务器子进程,验证响应头与超时路径)。另:run.mjs 的 HTTP 段重建(子进程服务器保活,避免主线程 Atomics.wait 死锁)。

### v0.27.1(2026-11-09)

- **tools/mingkit.ming——用 Ming 自写的文件工具箱**(仓库第一个自举工具):read(整文件/行区间)/ write / append(stdin 全量)/ replace(恰好 1 处,0/多处拒绝写入)/ replace-all / insert-after / insert-before / delete-lines / count。设计动机:AI 文件补丁的最大摩擦是跨 shell 转义层,mingkit 只保留一层转义(`\n` `\t` `\\`),歧义写入一律拒绝(退出码 1,不落盘)。
- 过程中的语义核对:`new` 是 Ming 保留字(M1006 拦截,改用 repl);main 的 args 不含程序名;count 行数 = `split("\n")` 去掉末尾空元素(空文件 0 行);print 自带换行,read 原样输出:有尾部换行先剥一个再 print(抵消),无尾部换行用 print_raw(v0.38.1 运行时新增)精确输出,写出去什么读回来就是什么。
- 测试:315 项(新增 mingkit 16 项:往返/区间/精确替换拒绝/转义/插入/删行/count 中文字节口径/append/双引擎一致/用法)。

### v0.26.0(2026-11-08)

- **原始字符串字面量**:`r"..."`(语言特性)——无转义无插值,\\d 原样保留;正则标配(Rust 风格)。
- **std.re 正则五函数**:is_match/find/find_all/replace($1 捕获引用)/split——JS RegExp 桥接,纯函数;非法 pattern = 程序员错误 → panic;含 re 调用的函数 wasm 自动回落(语义不变)。
- **str 方法面扩大**:is_alpha/is_digit/is_space(Unicode \\p{L}/\\p{Nd} 感知,空串 false)、is_upper/is_lower、pad_left/pad_right。
- **Builder 设计判断(不做)**:Vec[str] + join 已是 O(n) 惯用法,单独 Builder 冗余(写入 GUIDE 迁移说明)。
- 测试:295 项(新增 v0.26 9 项:re 五函数/非法 pattern panic/字符分类/大小写/pad)。

### v0.25.0(2026-11-08)

- **时间日期**:monotonic_ms(单调钟,测耗时不受调钟影响)、date_parts(本地时区七字段 Json)、format_iso/parse_iso(ISO 8601 往返,秒级精度)。
- **std.rand**:效果 rand;mulberry32(32 位状态);u64/f64/range/seed——**seed 后完全确定**(同 seed 同序列,测试友好,符合确定性哲学);初始种子 = 时钟 ^ pid。
- **重大 bug 修复(测试暴露):JS VM 的 || 短路结构反了**——`l || r` 在 l=true 时错误地落入 r 求值(实现成了 !l || r)。该 bug 自 v0.11 字节码 || 诞生即存在,此前所有测试的 || 左操作数恰好为 false,从未暴露;新增 ||/&& 真值表全枚举 + 求值次数测试(闭包计数器验证短路)锁定。同源确认 && 编译正确。
- 测试:286 项(新增 v0.25 14 项:rand 确定性/范围/单调钟/date_parts/ISO 往返/非法输入 + 短路真值表 16 项,全双引擎)。

### v0.24.0(2026-11-08)

- **系统接口补全**(对标准库金字塔的差距审计后,最大缺口优先):
  - `std.proc.exec(cmd, args) -> Result[(exit, stdout, stderr), str]`(新效果 proc;worker 同步化,60s 超时,10MB 输出上限)——胶水语言的灵魂能力。
  - `std.env.get/set/remove`(新效果 env)——环境变量读写删。
  - fs 补全:`metadata → Json(size/is_dir/is_file/modified_ms/name)`、`copy_file`、`rename`、`remove_dir`、`remove_dir_recursive`。
  - io 补全:`read_to_end() -> str`(stdin 全量)。
- **docs/capabilities.md**:标准库金字塔诚实覆盖率矩阵(✅/🟡/❌),每版更新。v0.24 覆盖率 ≈45%(v0.23 约 1/3)。
- 定位修正:v0.24 前"可以使用"的说法过宽——诚实的说法是"可用于受控场景的胶水脚本"(纯计算/文本文件/HTTP 拉取/并行数值)。exec/env 落地后覆盖面显著扩大,但正则/日期/随机/日志仍在路上。
- 测试:256 项维持全绿(proc/env/fs 新能力随文档示例验证,效果强制 M3029 已覆盖)。

### v0.23.0(2026-11-08)

- **线性内存统一语义**:eligible 函数内 Vec[i64]/Vec[f64] 的**构造(VecLit)、let 初始化、返回**全部走线性内存——VecLit = ming_alloc(16+8n) + len/cap/elems 直接 store;返回 = 返回 ptr,JS 边界读回物化(零句柄开销);**let w = v 经 ming_copy_vec 拷贝**(值语义在 wasm 函数内完整成立:源与拷贝完全独立,mut 传参自动拷贝)。句柄路径仅剩 str 元素 Vec 与 Map。
- 测试:256 项(新增 8 项:构造+返回/mut 值语义/let 拷贝独立,全双引擎)。

### v0.22.0(2026-11-08)

- **Option 消费链编译**:get(...).unwrap()/unwrap_or(d)/is_some()/is_none() 在 wasm 内**语义直译**——unwrap ≡ 越界/缺键即 panic(M4006),unwrap_or ≡ 界内取元素/界外取默认(默认值仅求值一次),is_some/is_none ≡ 界内判定。零 Option 表示、零新 Option 导入(map_has 复用)。裸 Option(存储/match)回落 JS VM,语义不变。
- **for-in 容器(wasm 内)**:for x in v(Vec ptr)与 for (k, v) in m(Map)编译期降级为 len + 下标/map_key_at 枚举循环——**同时发现并补上 v0.20 的静默缺口**:for 降级补丁当时锚点未匹配而未生效(含 for 的函数一直在回落),本次真正进入 wasm 路径并被双引擎测试锁定。
- 测试:248 项(新增 v0.22 14 项:get 消费链 vec/map/unwrap/is_some/is_none/容器 for-in/裸 get 回落,全部双引擎)。

### v0.21.0(2026-11-08)

- **WASM 字符串插值**:多段 StrLit(\{expr} 插值)在 wasm 内编译——数值段(i64/u64/f64)经 str_from_i64/f64 导入转 str 句柄(f64 输出与 JS 引擎同一 floatStr 规则),bool 段经 str_from_bool(条件编译为 cond 表达式),str 段直用;str_cat 链式拼接。
- **str 方法面扩大**:trim/trim_start/trim_end/to_upper/to_lower/replace/contains/starts_with/ends_with 桥接;str 字典序比较(< <= > >=)经 str_lt/le/gt/ge 导入(条件与值位置均可)。
- **scoped 块结果收集的设计判断(不做)**:scope 内多个 spawn 返回类型 R 各异,异构 Join 无法收进单态 Vec[Ming 无动态类型];结果收集已由两条路覆盖——显式 join(R 保留)与 spawn_all(同构批量)。半吊子的自动收集会引入类型擦除,违背明确原则。
- 测试:234 项(新增 v0.21 12 项:插值混合类型/方法段/f64 格式/trim 系/replace/contains/首尾/字典序,全部双引擎)。

### v0.20.0(2026-11-08)

- **内存写入方向**:布局升级为 [len:i64][cap:i64][elems×cap]——mut Vec 参数边界预留容量(n+16 或 ×1.25);`push` 编译为"容量检查 + 直写 / 满则 ming_grow 导入搬迁并更新指针 local";`v[i] = x`(mut)编译为越界检查 + 直接 store。容量增长语义与 JS 引擎等价(grow 后旧位置废弃,新位置在 paramTop 之上);非 mut 参数 push/set 编译期 M3004(与值语义一致)。
- **for-in ptr 迭代降级**:`for x in v`(v 为 Vec 参数)编译期降级为 len + 下标循环(零拷贝直访内存)——惯用写法获得 wasm 加速。
- **JS VM 赋值栈序修复(长期 bug)**:`v[i] = x` 与 `p.x = x` 的字节码赋值自 v0.11 起栈序错误(先编值再编目标组件,SETINDEX/SETFIELD 弹栈错位)——本迭代由 mut ptr 测试暴露并修复;Field 分支还漏编码字段名。赋值语句的完整测试(字段/下标/复合)补齐。
- 测试:222 项(新增 v0.20 8 项:mut push/set/for-in/非 mut M3004/JS VM 赋值 3 项/双引擎)。

### v0.19.0(2026-11-08)

- **线性内存传递**:Vec[i64]/Vec[f64] 参数从句柄升级为**指针传递**——调用边界批量写入 wasm 线性内存(布局 [len:i64][elems…],DataView 批量写),函数内 len(i64.load ptr)与下标读(load(ptr+8+8*i))零导入调用;越界检查(M4003)在内存读前逐点保留。嵌套/递归调用经栈式 paramTop 分配(每层边界保存/恢复),超 256KB 自动 memory.grow。性能:纯 sum 部分 ~4x(百万/四百万元素验证),整程序 1.8x(构建阶段走字节码)。
- wasm 模块新增 memory 节(min 4 页);边界写内存前 grow。
- 范围:输入方向(len/下标读)only;Vec 返回/push/set/句柄构造数组混用 → 回落句柄路径(正确执行不加速)。
- 测试:214 项(新增 lmem 6 项:千元素正确性/f64/越界/百万 grow/--no-wasm 一致/双引擎)。

### v0.18.0(2026-11-08)

- **WASM Vec/Map 句柄化**:eligible 扩大到容器——Vec[i64]/Vec[f64]/Vec[str] 与 Map[str, i64/f64/str] 的参数/返回/局部/字面量构造/len/下标读/push/set。容器以 i32 句柄穿越(JS 侧 objTable 持 V 对象);下标越界/缺键由导入抛 M4003/M4007(span 保留);emitModule 导入节改为声明式(17 个 vec/map 导入)。
- **诚实定位**:覆盖面扩展而非性能特性——逐元素导入调用开销高于 JS VM;线性内存传递(连续布局 + 批量拷贝)是数值数组真加速的路线(v0.19)。
- 范围:for-in 容器迭代、vec.get(Option 语义)、非标量元素不支持 wasm(回落)。
- 测试:208 项(新增 wasm vec/map 6 项:sum 循环/构造返回/map get/f64/下标越界/缺键/双引擎)。

### v0.17.0(2026-11-08)

- **scoped 并发块**:`sync scope { ... }` 新语句——块内 spawn 自动注册到作用域,块退出时自动 join 未完成子任务;正常退出时子任务 panic 向上抛(不吞错),提前 return / break / 异常展开时安全收尾(等待已启动任务,吞掉子错误);显式 join 过的句柄跳过。补全"结构化并发"的结构化二字:任务生命周期被块边界框住。
- 实现:interp syncScopeStack + try/catch/rethrow 收尾;字节码新增 SYNC_ENTER/SYNC_EXIT,VM 异常展开由 callCompiled 兜底 drain 到入口深度;syncSpawn 自动注册到最内层作用域。
- 顺带修正一个语义认知:Ming 的 fib(-1) 合法返回 -1(n<2 直接返回)——并发示例中"预期 panic"的函数改用显式 panic。
- 测试:201 项(新增 scoped 6 项:自动 join/panic 传播/提前 return/显式 join 共存/效果强制/fmt 幂等 + 双引擎)。

### v0.16.0(2026-11-08)

- **spawn 多参数**:`spawn(fn, a, b, c)` 按函数签名逐参校验与传递(此前仅单参数);参数个数不符 → M3005。
- **spawn_all 批量并发**:`spawn_all(fn, Vec[T]) -> Vec[Result[R, str]]`——对 Vec 中每个参数各启动一个子任务(真并行),返回全部结果;失败任务独立 Err 不影响其他。**接口不暴露句柄**,与 M3034 线性纪律自洽:需要收集句柄的场景用批量接口表达。
- 实现:worker 启动代码抽为 syncWorkerCode() 共用;spawn 参数以 wire 数组跨越边界;spawn_all 先启动全部 worker 再逐个 Atomics.wait(等待期间后续任务已并行运行)。
- 测试:194 项(新增多参 spawn/spawn_all 批量/空 Vec/字符串任务/混合 Err/参数个数 M3005/双引擎 7 项)。

### v0.15.0(2026-11-08)

- **Join 句柄线性资源检查(M3034,新码)**:Join[T] 不能存入 Vec/Map/元组/struct 字段/enum 载荷/Option/Result,不能作为 spawn 的参数/返回——深拷贝下集合中的句柄是同一子任务的别名,重复 join 语义混乱。检查覆盖 VecLit/MapLit/TupleLit/StructLit/let 标注/spawn 签名。
- **泛型约束强化**:trait impl 方法调用点校验接收者实例满足 impl 自身 bound(`impl[A: Eq, B: Eq] Eq for Pair[A, B]` 的 .eq 被调用时,实参类型逐个过 bound;此前只在泛型函数调用与显式 bound 处检查)。
- **WASM 字符串桥接**:str 参数/返回/局部/字面量/拼接/相等/len 走 wasm——字符串以 i32 句柄穿越(JS 侧句柄表),字面量经常量表注册,拼接/相等/len 经导入;str 条件比较(if s == "x")同样支持。
- 修复:return 位置对已报错表达式(类型为 null)的连锁空解引用(内部错误 → 正常诊断)。
- 测试:187 项(新增 Join 线性 3 项、bound 调用点 1 项、wasm str 3 项)。

### v0.14.0(2026-11-08)

- **结构化并发 std.sync**:`spawn(fn, arg?) -> Join[R]` + `join(Join[R]) -> Result[R, str]`(新增 `sync` 效果与 `Join[T]` 泛型类型)。实现:worker 线程内**重建编译管线并只调目标函数**(隔离子 VM,副作用捕获丢弃),参数/结果经 **wire 序列化**深拷贝边界(int/u64/float/bool/str/Json/Vec/Map/Option/Result;struct/枚举/闭包拒绝);join 用 Atomics 阻塞(120s 超时),子任务 panic 还原为 Err;重复 join → Err。
- **编译期检查**:spawn 返回类型不可跨任务 → M3002;spawn 目标非单参数函数值 → M3002;效果强制 M3029。
- checker 的 checkStdCall 支持泛型特例签名(spawn 按函数值推导 Join[R])。
- 测试:176 项(新增 sync 7 项:双 spawn 并行/无参/子 panic/字符串跨任务/效果强制/重复 join/双引擎一致)。

### v0.13.0(2026-11-08)

- **WASM eligible 扩大:u64**:无符号整数全通道——参数/返回/局部/字面量/算术/比较。位型同 i64 但检查语义不同:加法溢出 = 结果 < 左操作数(无符号),减法溢出 = 结果 > 左操作数,乘法回验商用 div_u,除法/取模用 div_u/rem_u(仅除零检查,u64 无 min/-1 trap),比较用 lt_u/gt_u/le_u/ge_u 无符号变体;u64.max 在 wasm 内比较与 JS 引擎逐点一致(有符号解释会把 u64.max 当负数的陷阱被测试锁定)。
- VM wasm 边界允许 u64 参数(按 signed 语义还原返回值)。
- 测试:169 项(新增 wasm u64 5 项:算术/max 直通/无符号比较/溢出/除零)。

### v0.12.0(2026-11-08)

- **版本号规范化**:迭代号统一为两位小数——此前写作 v0.1–v0.9 的九个版本即 v0.01–v0.09,其后为 v0.10、v0.11、v0.12(semantic versioning 下 0.10.0 > 0.9.0,数值无歧义;此说明仅为可读性统一)。本轮发布即 v0.12.0。
- **WASM eligible 扩大:浮点**:
  - 双类型代码生成:f64 参数/返回/局部/字面量(`f64.const` IEEE 754 编码)/算术(add/sub/mul/div/neg)/比较,无溢出检查(IEEE 语义直用);局部槽带类型表('i64'/'f64'),let 推导槽型,赋值按槽型。
  - **std.math 导入化**:sqrt/pow/abs/floor/ceil/round/exp/ln/sin/cos/tan 注册为 wasm 导入(JS 侧实现),`math.sqrt(x)` 与 `std.math.sqrt(x)` 均可编译;i64/f64 混合签名按被调签名逐参编译。
  - 修复:wasm locals 声明的组数前缀误用字节数前缀(验证器报"fallthru found 2");数值函数兜底零值被推两次(块级 + 函数级),统一为函数级单次。
- 测试:164 项(新增 wasm float 3 项:sqrt/pi/全限定混合)。

### v0.11.0(2026-11-08)

- **WASM 分层后端**:新增 src/wasm.js(手写二进制编码器:LEB128/节/类型/导入/导出/代码,零依赖)。资格分析(形状 + 调用图不动点)→ 纯整数函数直接从 AST 编译为 wasm i64(局部/算术/比较/控制流/递归调用);溢出(加/减/乘/移位)、除零、min/-1 除法检查经导入 panic 回抛 Ming Panic(错误码、消息、span 逐点一致);循环回边与函数入口注入 tick 保 maxSteps。
- **分层执行**:VMInterp.callCompiled 对 eligible 函数走 wasm(参数/结果 i64 转换;wasm trap 还原为 M4005);`--no-wasm` 回退 JS VM;编译/实例化失败静默降级。
- **性能**:fib(30) 递归 JS VM 1495ms → wasm 556ms(**3.6x**);其余基准持平(回退函数不受影响)。
- 测试:161 项(新增 wasm 专项 6 项:递归/循环/溢出/除零/栈溢出/--no-wasm 一致性;全部 155 项既有测试在 wasm 默认开启下通过)。
- 范围:浮点/无符号/字符串/集合/闭包/带效果函数不 eligible(照常正确执行);扩大 eligible 是 v0.12。

### v0.10.0(2026-11-08)

- **std.json + 动态 Json 类型**:`parse`(手写递归下降,错误带位置)/ `stringify`(静态 JSON 兼容性检查,M3033——结构体/枚举不自动序列化);Json 访问器(is_* / as_* / get / at / eq);`as_obj` 返回副本,Json 不可变;Json 可整体 `==` 与再序列化。
- **time.sleep**:Atomics 同步睡眠(效果 time)。
- 测试:155 项(新增 JSON 黄金输出、stringify 拒绝结构体、parse 容错、sleep)。

### v0.9.0(2026-11-08)

- **指令融合窥孔**:编译期识别局部槽上的三种高频赋值——`x += 1`/`x -= 1` → ADDI;`x OP= 字面量` → BINSETI;`x OP= 局部` 与 `x = 局部 OP 局部` → BINSET2——单条指令完成"读-算-存",免栈操作与中间对象。溢出/除零检查与 panic span 逐点等价(M4002 回归通过);短路运算(&&/||)不融合。
- 指令编码扩展为 5 元组([op,a,b,c,span],c 为子操作码)。
- 性能:千万次循环 1495→1146ms(1.3x);"循环累加"基准 0.9x→1.3x。
- 测试:146 项(融合语义由全量黄金/诊断/双引擎对照覆盖)。

### v0.8.0(2026-11-08)

- **http_request**:`(method, url, headers: Map[str, str], body?) -> Result[(i64, str), str]`——自定义方法/头/体,复用 worker+Atomics 基础设施;GET/HEAD 不发送体;checkStdCall 支持可选参数(min/max)。
- **编译器窥孔优化**:for/while-let 的简单绑定模式(ident/wild)不再经过模式匹配机器,每迭代省 2 条指令+PATMATCH/JUMPNONE/BIND;"循环累加"基准从 0.9x 升到 1.1x(首次超过树引擎)。
- **ming REPL**:交互式会话——表达式回显(= repr)、声明持久化、失败输入自动回滚、括号平衡自动续行、:clear/:quit。REPL 求值包装按名字识别(__repl_ 前缀),返回类型随块推断(checkFnBody 的 replMode)。
- 测试:146 项(新增 REPL 会话 6 项、http_request POST 双引擎 2 项)。

### v0.7.0(2026-11-08)

- **capability 网络 std.net**:`http_get(url) -> Result[(i64, str), str]`,带 `net` 效果(编译期强制)。同步实现:worker 线程内 fetch + 主线程 Atomics.wait 阻塞,响应经 SharedArrayBuffer 传回(8MB 截断、35s 超时、错误消息回传)。**工程要点:测试服务器必须放独立进程**——同进程的 HTTP 服务器会因主线程被 Atomics 阻塞而无法 accept,构成死锁。
- **小整数驻留缓存**:i64 的 -128..127 值共享 V 对象(整数不可变,共享安全),降低分配压力。
- 测试:145 项(新增 net 效果强制 + 本地 HTTP 服务器端到端,双引擎)。

### v0.6.0(2026-11-08)

- **capability 文件系统 std.fs**:read_file / write_file / append_file / exists / is_dir / list_dir / make_dir / remove_file,全部带 `fs` 效果——**程序能否碰磁盘,签名可见、编译期强制**(未声明 `with fs` 调用即 M3029)。所有可能失败的 fs 操作返回 Result,与语言错误模型一致。
- **std.path 纯函数**:join / base_name / dir_name / extension。
- 效果集扩展为 io / time / fs;能力模型 = 效果声明(静态可审计),不引入运行时权限开关。
- 测试:144 项(新增 fs 效果强制与端到端临时目录用例)。

### v0.5.0(2026-11-08)

- **泛型类型的 impl**:`impl[A: Eq, B: Eq] Eq for Pair[A, B]`——方法签名按接收者实例类型代换;方法体内经由 impl bound 调用成员的 trait 方法;**bound 递归校验**(泛型 impl 的自身 bound 逐个检查实参,Vec/元组的 Eq 随元素递归);未约束参数禁止(M3032)。
- **Compare trait**:`fn cmp(self, other: Self) -> i64`,原始类型(整数/浮点/str)内置实现;**Vec.min()/max()** 返回 Option[T],要求元素实现 Compare。
- 测试:138 项(新增泛型 impl 黄金输出、bound 不满足/未约束参数/结构化递归诊断回归)。
- 修复:unify 的 param 绑定顺序(曾破坏 let 推断中的 var 绑定,已回归验证)。

### v0.4.0(2026-11-08)

- **整数 number 快路径(值表示优化)**:|v| ≤ 2^53-1 的整数用 JS number 表示(创建口统一归一化,同值同表示),超出自动落 BigInt;算术走"快路径 + 精确性守卫,超界回落 BigInt 重算",溢出/除零检查语义完全不变(M4002/M4004 回归通过)。千万次循环绝对提速 1.6x(2429→1495ms),两引擎共享收益;新增 2^53 边界与 u64 大值往返回归用例。
- **包管理 ming.toml**:`ming init` 生成项目骨架;run/check/test/build 不带文件参数时自动向上查找清单(项目模式);`ming build` 输出项目级构建摘要;清单解析错误码 M5001。
- **LSP 语言服务器**(`ming lsp`,stdio JSON-RPC):initialize/shutdown、didOpen/didChange → publishDiagnostics(全部诊断含 hint)、textDocument/hover(签名 + /// 文档);编辑器缓冲区优先于磁盘内容;协议测试 6 项。修掉一处真 bug:Checker 此前把入口 displayFile 强制为 basename,导致多文件诊断归属错乱。
- 测试:129 项(含 LSP 全流程 6 项、双引擎黄金对照 12 项)。

### v0.3.0(2026-11-08)

- **字节码执行管线**:`ming run` 默认走 编译器(src/compiler.js,AST→字节码:槽位分配、闭包捕获分析、模式池、指令级 span)→ 栈式 VM(src/vm.js,值栈 + 帧结构 + 迭代器指令)。
- **双引擎架构**:树遍历解释器保留为 `--tree` 对照引擎;两个引擎通过同一套黄金输出测试(12 项对照)与全部诊断回归,语义完全一致。
- **值语义在 VM 中逐点保真**:ST/SET/BIND/调用实参/集合构造/闭包捕获全部深拷贝;`mut self` 的 self 不拷贝;闭包捕获 = 创建时快照。
- **性能基准**(tests/bench.mjs,信息性):fib(24) 1.7x、高阶方法 1.2x、词频 1.0x、纯循环 0.9~1.1x(受 BigInt checked 运算主导,与树引擎同价)。已修掉两个实现陷阱(每指令访问 process.env、每次算术重建映射表)。
- 性能下一跳(v0.4):值表示优化(整数 number 快路径)、寄存器式混合后端。

### v0.2.0(2026-11-08)

- **const**:模块级常量,常量表达式校验(M3031)、循环定义检测、不可赋值(M3004)、fmt/doc 支持。
- **效果系统**:`with io, time` 显式声明副作用并逐层传播(M3029/M3030);print/eprint/read_line 标 io,now_ms 标 time;main/test 的效果规则;已知限制:闭包效果在创建处检查。
- **trait + impl + 方法**:prelude 内置 Eq / ToStr(原始类型内置实现);自定义 trait;impl 完整性/签名一致性检查(M3032);`self` / `mut self`;泛型 bound `[T: Eq]` 与调用处校验;运行时按接收者类型分派;fmt/doc 支持。
- **修复**:`()` 类型与 unit 值统一(此前空元组与 unit 类型不一致);『fn main()』现在必须为副作用声明效果(破坏性变更,示例已全部迁移)。
- 测试:113 项(新增 effects/constants/traits 黄金输出与 9 组诊断回归)。
- 破坏性变更:使用 print 的函数必须声明 `with io`。

### v0.1.0(2026-11-08)

- 首个可用版本:词法/语法/类型检查/树遍历解释器/格式化器/CLI(run/check/test/fmt/doc,全 `--json`)。
- 语言核心:i64/u*/f*/bool/str/Vec/Map/Option/Result/tuple/Range;结构体;枚举 + 穷尽 match;闭包(按值捕获);`?` 传播;参数化泛型;`test` 块;多文件 `use` + `pub`。
- 语义决定:整数全程 checked;值语义(深拷贝,无别名);Map 插入序;str 禁止下标;同层禁遮蔽;无 null/无真值化/无隐式转换。
- 工具协议:稳定诊断码 M1001–M4008 + W3101–W3103;退出码 0/1/101/2;`--json` 全覆盖。
- 标准库:print/eprint/str/debug/assert/assert_eq/panic;std.math/io/time。v0.1 无文件系统与网络能力(设计使然)。
- 测试:tests/run.mjs(黄金输出、诊断回归、panic 行为、fmt 幂等、JSON 协议、值语义、模块可见性)。
