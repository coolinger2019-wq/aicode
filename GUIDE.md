# Ming(明)使用指南

**版本:v0.26.0** · 字节码 VM + WASM 分层(线性内存)+ JSON + 正则 + capability fs/net/sync/proc/env/rand + 线性句柄 + 泛型 impl + REPL · 需要 Node.js ≥ 18(Windows / macOS / Linux)

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
- `panic("消息")` 主动中止(退出码 101),输出含 Ming 调用栈。

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

`sqrt pow abs floor ceil round min max exp ln sin cos tan pi e` — 均为 f64。

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

- 同步实现(worker 线程 fetch + Atomics 阻塞),响应体上限 8MB(超出截断),总超时 35s,遵循重定向。
- `http_request` 的 body 可省略;GET/HEAD 不发送体。

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

### std.re(纯函数,v0.26)

正则 = **JS RegExp 桥接**(ECMAScript 语法),pattern 用**原始字符串** `r"..."(无转义,\\d 原样保留)。非法 pattern = 程序员错误 → panic;含 re 调用的函数在 wasm 分层自动回落 JS VM(语义不变)。

| 函数 | 签名 | 说明 |
|------|------|------|
| `is_match` | `(pattern, s) -> bool` | 是否存在匹配 |
| `find` | `(pattern, s) -> Option[str]` | 第一个匹配 |
| `find_all` | `(pattern, s) -> Vec[str]` | 全部匹配 |
| `replace` | `(pattern, s, repl) -> str` | 替换全部(repl 支持 $1 捕获引用) |
| `split` | `(pattern, s) -> Vec[str]` | 分割 |

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

| 版本 | 内容 |
|------|------|
| v0.4(当前) | 整数 number 快路径(值表示优化)、包管理 ming.toml(init/run/build/test 项目模式)、LSP(诊断推送/hover) |
| v0.5 | 寄存器式/混合后端、泛型类型 impl、更多 prelude trait、原生后端(C)/ WASM |
| v0.6 | capability IO(net/fs)、结构化并发 |
| 更远 | 自举、契约与轻量验证 |

## 24. 修订记录

每次修改语言或工具链,在此登记;GUIDE 始终与实现同步。

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
