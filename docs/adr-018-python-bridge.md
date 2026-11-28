# ADR-018: Python 契约桥——抽取文法与类型映射（`ming bridge extract --from py`）

> **状态**:**已裁决 go（架构师，2026-11-28，维护者 §4.28 桥 1 启动）**——MVP 抽取文法 = PEP 484 类型注解 + docstring 数学不等式行（Google Args:/Returns: 分节优先，散行兜底）；类型映射 = TS 七类型映射表的 Python 对应版；消费侧（M3052/M3053）零改动。版本 v1.6.0（minor——CLI 新旗标）。
> **来源**：plan §4.28 桥 1；维护者 standing workflow（持续完成计划任务）。roadmap §5.2"TS 或 Python"的另一半。
> **关联**：docs/bridge-protocol.md（.mingi 格式 + TS 文法先例）、ADR-017 §4 路径 2（.mingi 桩的外部消费者）、ADR-015（S-5 满足性——消费侧已通）。

---

## 1. 抽取文法（MVP，与 TS 版对称）

**输入面**：`.py` 文件；函数 = 顶层 `def` 与方法（类内 `def`，fn 名带类前缀 `Class.method`——v1 先只取顶层 `def`，方法登记候选）。

**约定载体（按优先级）**：
1. **Google 风格 docstring 分节**：`Args:` 段每行 `名: 类型描述` 后随的**数学不等式行**；`Returns:` 段同款。例：
   ```
   def get_user(user_id, conn):
       """Fetch a user row.

       Args:
           user_id: database key.
               1 <= user_id <= 10**6
           conn: open connection.
       Returns:
           Row dict; len(row) >= 1
       """
   ```
2. **散行兜底**：docstring 内任何形如纯数学不等式的行（文法见下），自动归入其涉及的参数名（涉及多个参数 → 归入该函数的 requires；仅含返回值名/无参数名 → 丢弃 v1，登记候选）。
3. **不做的**：自然语言理解（"must be positive" 这类英文短语不解析——如实登记，与 TS 版"只认数学不等式"同纪律）；Sphinx `:param:` 风格（登记候选）；装饰器（@requires 之类）不预支。

**数学不等式文法**：与 TS 版共用一套（bridge-protocol.md 已文档化的候选文法）——十进制字面量、参数名、`len(名)`（→ len$x）、比较链（`0 <= n <= 10` 相邻对）、`**` 幂（限小整数底/指数字面量,提取期折叠为十进制字面量,结果 ≤ i64 max）。**实现期定案（2026-11-28）**：四则邻接整条丢弃（TS 版既有规则,唯一例外 = `**` 幂折叠）——bridge-protocol §11.3 表格按实现登记,本行即裁决注记。解析失败 → 该行跳过不报错（extract 的产出确定性不受坏行影响——与 TS 版同口径）。

**类型映射**（PEP 484 → Ming，v1 MVP）：
| Python | Ming |
|---|---|
| int | i64（注解含 `Literal`/范围注释不细化——登记候选） |
| float | f64 |
| str | str |
| bool | bool |
| list[T] / List[T] | Vec[T] |
| dict[str, T] / Dict[str, T] | Map[str, T] |
| T \| None / Optional[T] | Option[T] |
| 无注解 / 其他 | 该参数跳过（桩函数只含已映射参数——缺参数的桩如何核对？与 TS 版同口径：未映射参数不进桩，M3052 核对按桩内参数集对齐，登记此口径） |

## 2. 确定性与边界

- **确定性**：同一 .py 输入 → 逐字节同一 .mingi（函数按源码序；docstring 行序即约定序）。
- **诚实登记**：Python 动态性意味着注解可撒谎（标注 int 实为 str）——桩只承诺"转录注解"，不验证 Python 侧行为（与 TS 版同边界：核对的是 Ming 调用侧守约，不验证对端实现）。
- **消费侧零改动**：.mingi 格式 v2 不变；M3052/M3053 按既有路径。

## 3. 首个外部消费者（ADR-017 路径 2 同款主动构建）

`C:\code\pyuserlib\`（独立 git 仓库）：一个真实小 Python 库（3–5 个带类型注解+docstring 不等式的函数）+ `check_stubs.py`（纯标准库——读 .mingi 工件 + `ast`/`typing` 内省自身函数，交叉核对桩签名与本库真实签名一致）。三条件：C1 独立仓库 ✓ / C2 仅 Python 标准库可运行 ✓ / C3 只消费 .mingi 工件 ✓。证据运行 = 无 Ming 环境跑 check_stubs exit 0。

## 4. 明确不做（登记）

类方法抽取、Sphinx 风格、自然语言约定、`Literal` 细化、装饰器约定、ensures 从返回值注解自动推导（`-> int` 只进类型映射，不生成 ensures）。
