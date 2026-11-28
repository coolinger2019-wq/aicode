# ADR-019: Rust 契约桥——映射裁决（`ming bridge extract --from rust`）

> **状态**:**已裁决 go（架构师，2026-11-28，维护者 §4.28 桥 2 启动）**——MVP 抽取 = 顶层 `fn`/`pub fn` 的 `///` doc 注释数学不等式行 + 类型映射表（§1）；impl 方法/async/宏生成登记候选；消费侧（M3052/M3053）零改动。版本 v1.7.0（minor）。
> **来源**：plan §4.28 桥 2（预研先行→本 ADR 即预研产出）；维护者 standing workflow。
> **关联**：ADR-018（Python 版先例：文法骨架/确定性/诚实边界纪律全部沿用）、bridge-protocol.md（.mingi v2 + §11 Python 节先例）、ADR-017 §4 路径 2（外部消费者）。

---

## 1. 类型映射表（Rust → Ming）

| Rust | Ming | 备注 |
|---|---|---|
| i8/i16/i32/i64 | 同名窄型 | Ming 窄型注解体系（v0.85+）原生支持 |
| u8/u16/u32/u64 | 同名窄型 | u64 忠实映射（Ming 有 u64 字面量/编码面） |
| isize / usize | i64 / u64 | 指针宽度型无对位——**取有符号/无符号 64 位近似,登记候选**（impl 期以 note 标注该参数） |
| f32 / f64 | f64 | f32 升 f64（登记候选：f32 保留） |
| bool | bool | |
| String / &String / &str / &‘a str | str | 生命周期 token 一律剥离 |
| Vec<T> / &Vec<T> / &[T] / &’a [T] | Vec[T] | slice 形态等价处理 |
| HashMap<String,V> / BTreeMap<String,V>（含 & 引用形） | Map[str, V] | 键限 String/&str;非 String 键 → 不可映射 skip |
| Option<T>（含 &Option<T>） | Option[T] | |
| Result<T, E> | **不可映射 skip**（双类型返回;登记候选:映射 T） | |
| 引用/可变引用 &T / &mut T | 剥引取内层 T | `mut` 可变性不进 .mingi v1（格式无此面） |
| 元组 (A, B) / 原生指针 / impl Trait / 泛型未映射 | **skip** | 具名 note/skipped |

## 2. 函数形态与抽取面

- **抽取**：顶层 `fn`/`pub fn`（含 `pub(crate)` 等 pub 可见性限定前缀）；**impl 块内方法不扫**（登记候选）；`async fn` → 具名 skip；`unsafe fn` → 具名 skip（效果面无对位）；泛型函数 `fn name<T>` → 取名 `name`、尖括号参数剥离。
- **约定载体**：`///` 外层 doc 注释行（`//!` 内层不扫）；数学不等式行文法 = TS/Python 共用套（十进制字面量/参数名/`len(名)`→len$/比较链/`**` 幂折叠）；四则邻接整条丢弃（同 TS/Python 定案）；`#[doc = "..."]` 属性形态登记候选。
- **Rust 特记法适配**：类型内 `'a` 生命周期剥离；`where` 子句忽略（不进桩不报错）；默认值不存在（Rust 语义）。
- **确定性**：同输入逐字节同输出（函数按源码序）；generated-by 行 `--from rust(MVP;…;ADR-019)`。

## 3. 消费侧与外部消费者

- **消费侧零改动**：.mingi v2 格式不变；M3052/M3053 既有路径。
- **外部消费者 = 真实 Rust crate 的 `cargo test`**（ADR-017 §4 路径 2 的字面形态——"消费方是外部 CI"）：`C:\code\rustuserlib\`——3–5 个带 `///` 不等式的 `pub fn` + `tests/stub_consistency.rs`（Rust 实现的 .mingi 最小解析器 + 手写签名断言比对）；桩由 `node bin/ming.js bridge extract --from rust` 预生成入库（纯数据），`cargo test` 运行**不需要 Ming**（C2）。证据 = 中性目录 `cargo test` exit 0 + 篡改桩负例 cargo test fail。

## 3.1 实现期定案注记（2026-11-28，实现与联调实测落定）

1. **where 移位解析**：`) -> Ret` 后 where 在下一行 → 右括号同行余部看不到,按 §2"忽略（不进桩不报错）"**照常转录**（非具名 skip）——移位解析不支持的机械后果,如实登记。
2. **元组参数 / 非 String 键 HashMap**：按 Python 口径 = **参数级 note + 不进桩,函数保留**（非整函数 skip）。
3. **doc 关联策略**：`///` 与 fn 之间允许属性行/注释/空行（惯用形态）;其他顶层项打断;`/// - `/`* ` 列表标记剥离（负字面量 `-5` 不受影响）。
4. **`mut x: T` 参数绑定前缀剥离**（可变性不进 .mingi v1,§1 同源）;`HashMap<'a,K,V>` 清洗后空参数位 → 不可映射。
5. **签名行块注释实测口径**：`fn blk(x: i64 /* c */, n: i64)` → 参数级 note + 函数保留（`blk(n: i64)`）;块注释含 `)` 时签名窗提前闭合 → 具名 skip。`r#raw` 名具名 skip 时函数名截断为形态副作用（`r#type` → `skipped: r`）——罕见形态,如实登记。
6. **跨行泛型声明列表**（`fn f<` 换行 `>`）→ 具名 skip"泛型参数列表未闭合"（尖括号配对只在单行内找）;`const fn`/`r#raw` 名/签名行块注释 → 静默不扫或具名 skip（罕见,如实登记）。
6. **"Google 式"口径备案**：Rust 唯一载体 = `///` 散行（无 Google 分节惯用法）;§2"散行兜底为主"即全文口径。

## 4. 明确不做（登记）

impl 方法抽取、`#[doc]` 属性形态、async/unsafe 抽取、宏生成函数、trait 默认方法、f32 保留、Result→T 映射、元组映射、泛型约束进桩、非 String 键 HashMap。
