# Ming 证明协议 v1——义务标识与 SMT-LIB 导出规范

> **状态**:v1.1 首批(S-1 + S-2,plan §4.21 切片表)+ v1.2.6 R-20(provenance manifest,ADR-013)· **日期**:2026-11-23(manifest 增补 2026-11-27) · **实现**:`src/proofsmt.js`(编码)/ `src/checker.js`(VC 采集,`checkIndexBoundsStatically`)/ `src/manifest.js`(provenance manifest 构造)/ `bin/ming.js`(旗标与协议字段)
> **范围**:本文档规范四件事——①证明义务标识(`proof_obligation_id`)的文法与语义;②`ming check --proof-format smt-lib` 的 SMT-LIB 2.0 输出格式;③`--json` 协议的加法式字段(`proof_obligation_id` / `solver_status` / `proof_smt`);④`--proof-manifest <path>` 的 provenance manifest schema v1(§4.5)。
> **立场声明**:Ming 的证明器是 **QF_LIA 限定子集**(线性整数算术的差分约束求解,`src/prover.js`)。本文档只描述**它实际做了什么**,不描述"理想证明器应该做什么";每一处能力边界都以"内部证明器不证明什么"一节如实登记。`solver_status` 是 **Ming 内部证明器的判定口径**,不是外部求解器结论——外部求解器对同一义务可能给出更强或不同的回答,这正是外部审计的价值,解读规则见"外部求解器消费方式"。
> **关联**:[GUIDE.md §6 契约与静态边界证明](../GUIDE.md) / [docs/diagnostics.md](diagnostics.md)(M3045/W3105)/ [docs/stability-contract.md](stability-contract.md)(承诺面口径)/ [docs/roadmap-infrastructure.md §5.1](roadmap-infrastructure.md)(原始需求)/ plan §4.21(裁决与切片)。

---

## 1. 义务模型:什么是"一个证明义务"

静态边界证明遍(`checkIndexBoundsStatically`)对每个**满足采集门槛**的索引点采集一个义务(VC,验证条件):

- **采集门槛**(全部满足才采集;不满足 = 静默不采集,见 §6):函数带 `requires`、含非 `mut` 的 `Vec[i64]` 参数、索引点位于直线体或干净的范围 for 循环体内。索引表达式**不可线性化**时义务仍采集(聚合状态 = unproven),但目标不编码(见 §3.4)——"未编码"不等于"未采集"。
- **义务内容**:对索引形式 `i`(线性形式),在假设集 `H` 下证明两方向——
  - **low**:`0 <= i`;
  - **high**:`i < len$<基名>`(`len$x` 是 Vec 参数的长度符号)。
- **假设集 `H`**:`requires` 的线性叶子合取(线性形式)⊕ 范围 for 的循环区间约束(`lo <= i$<n> < hi`,仅 loop 作用域义务)。

义务判定(内部,`proveImplication`):方向成立 = **proven**;取反可证(违反方向被假设集强制——未必存在具体反例,见 §6.2 规则 4 豁免)= **refuted**;其余 = **unknown**(内部放弃判定)。义务聚合三态 = `--proof-report` 的 `kind`:两向 proven → `proven`;任一方向 refuted → `violated`(M3045);其余 → `unproven`(默认静默,`--warn-unproven-index` 下 W3105)。

## 2. 义务标识方案:`proof_obligation_id`

**文法**:

```
proof_obligation_id ::= "vc:" <函数名> ":" <序号>
<函数名>             ::= Ming 函数标识符(模块级 fn 名;本地函数不在证明面,见 §6)
<序号>               ::= 十进制正整数(1 起)
```

**语义**(方案在本文定义一次,`--json` 与 SMT-LIB 输出两处共用):

1. **序号 = 该函数内义务的采集顺序**(深度优先、按源码求值序遍历函数体的确定性顺序),从 1 开始连续编号。
2. **模块内唯一**:函数名在模块内唯一(M3009 保证),序号单调 → 同一模块内 `vc:<fn>:<n>` 恒指向同一义务。
3. **跨模块**:不同模块可以有同名 `vc:f:1`——跨模块消歧靠诊断自带的 `file` 字段与 SMT 脚本的文件分节注释(`; ===== 文件:<路径> =====`),**不**把路径编进 id(id 保持精简可引用;路径按命令行展示路径原样,见 §3.3)。
4. **稳定性**:同一源文件在同版本工具链下,义务采集顺序是确定性的(不依赖哈希序/时间/随机);义务增删(改源码)自然改变后续序号——id 标识的是**本次检查中采集的义务实例**,不是跨版本的源码位置句柄。
5. **消费面**:M3045 / W3105 诊断(仅 `--proof-format smt-lib` 开启时,见 §4)、`--json --proof-report` 的义务条目(同上)、SMT-LIB 脚本注释(每次输出)。

## 3. SMT-LIB 输出格式(`--proof-format smt-lib`)

### 3.1 脚本结构

一个命令输出**一个**完整 SMT-LIB 2.0 脚本(stdout 承载;`--json` 模式下作为 `proof_smt` 字符串字段承载,内容逐字相同)。结构:

```
(set-logic QF_LIA)
(set-info :source "Ming 证明义务导出(QF_LIA 子集;规范见 docs/proof-protocol.md)")
; ===== 文件:<展示路径> =====          ← 多文件检查时按命令行顺序分节;单文件同样有此行
; ---- vc:<fn>:<n> — 索引 <索引原文>(scope: <body|loop>)----
; 方向 low — ming 内部判定: <proven|refuted|unknown>(期望/说明文本)
(push)
(declare-const <符号> Int)...
(assert <假设>)...                    ← 该义务的假设集 H(逐条)
(assert (not <low 目标>))             ← 取反方向目标
(check-sat)
(pop)
; 方向 high — ming 内部判定: ...(期望/说明文本)
(push)
...
(check-sat)
(pop)
(exit)
```

**结构不变式**(每个输出必须满足,§5 的冻结承诺以此为准):

1. 首行恒为 `(set-logic QF_LIA)`;末行恒为 `(exit)`。
2. 每个可编码义务两方向各**恰好一个** `(check-sat)`(low 在前、high 在后);`(declare-const)` 全部位于其所在 `(push)` 块内、任何 `(assert)` 之前。
3. 每个方向块以 `(push)` 开、`(pop)` 闭——块间零状态泄漏(义务 A 的断言不影响义务 B 的回答)。
4. 括号配平;注释(`;` 起行)不进入求解器状态。
5. **零义务脚本**(无可分析基 / 无索引点 / 假设集自相矛盾整函数放弃等):输出"头两行 + `; 无证明义务` + `(exit)`"——空脚本诚实声明无事可检,不伪装成已证明。

**为什么方向是独立 check-sat**:义务目标 `0 <= i ∧ i < len$buf` 的合取**不能**用单块 `assert (not (and P Q))` 检验——`¬(P∧Q) = ¬P ∨ ¬Q` 是析取,存在"违反一方向但满足另一方向"的模型会让合取取反可满足,把 proven 误读成 sat。内部判定与脚本都按**逐方向**检验(`H ∧ ¬low` 与 `H ∧ ¬high` 各自独立),这是本协议的结构性要求,不是风格选择。

### 3.2 理论与符号编码(QF_LIA,如实编码面)

- **理论**:`QF_LIA`(无量词线性整数算术)。变量一律 `Int`;谓词只含 `+ - *`(* 仅限常量×变量)与 `= < <= > >=`(Ming `==` 映射为 SMT `=`)。无常量传播、无位运算、无浮点、无量词——内部证明器采集到什么就编码什么,**不虚标**。
- **变量声明**:每个出现的名字 `(declare-const <符号> Int)`;声明集 = 该方向块中假设集与方向目标出现的名字的并(确定性:按假设逐条、系数 Map 插入序收集)。
- **线性形式渲染**:`Σ coeff·var + c` → `(+ (* <c> <x>) ... <常数>)`;系数 ±1 省略乘法;系数 0 不出现(规范形);常数项最后;全零形式渲染为 `0`。
- **负数**:SMT-LIB 数字字面量无符号——负常数/负系数一律用一元减 `(- n)`(如 `(* (- 2) x)`、`(- 5)`),保证严格合规(求解器普遍同时接受 `-5` 字面量,本协议不依赖该宽容)。
- **内部符号**:`len$<参数名>` 与循环区间符号 `i$<n>` 原样输出——`$` 是 SMT-LIB 简单符号的合法字符(letters/digits + `~!@$%^&*_-+=<>.?/`,不以数字开头,且**不是保留字**——第三条件见下条重写规则),且 `$` 不是合法 Ming 标识符字符,不与用户名冲突。
- **保留字重写**:Ming 标识符命中 SMT-LIB 保留字/内建排序/内建函数符号(官方规范 §3.1 保留词含 `_`;`as`/`exists`/`forall`/`let`/`par`/`match`/`Int`/`and`/`div`/`mod` 等,黑名单在 `src/proofsmt.js` 保守并集)时**整脚本统一重写**:追加 `_v`,再撞顺延 `_v2`/`_v3`…。重写为**双射**(同一名字全脚本恒同一符号;不冲突恒原样),重写只改脚本符号名,不改义务语义。示例:参数 `div` → 脚本符号 `div_v`;参数 `_` → `__v`。

### 3.3 确定性与路径

同一输入(同一文件内容 + 同一命令行参数集)恒产出逐字节相同的脚本:无时间戳、无随机顺序、无工具链版本号。文件分节注释与义务头注释中的路径按**命令行展示路径原样**(不绝对化、不规范化、不解析)——用户传相对路径则脚本含相对路径;这是用户输入的回显,协议本身不引入绝对路径。

**项目模式例外(登记,2026-11-27 审查 MAJOR-1)**:无文件参数的项目模式(`ming.toml` 入口,裸 `ming check`)没有"命令行展示路径"——脚本文件分节沿用入口的**解析路径(当前为绝对路径)**,这是本节展示路径口径的唯一例外。provenance manifest 侧已按项目根相对化(§4.5,manifest 无绝对路径);脚本侧相对化会改动 check 的输入路径口径(诊断 `file` 字段一并变化),超出本批预算,登记为后续候选(改动须同步本节与 §4.5)。

**逐字节确定性由入库黄金锁定**(R-19):`tests/proof_fixtures/` 保存六语料测试矩阵(proven / refuted-sat / refuted-unsat / unknown / zero / loop)的完整 SMT-LIB 脚本,`node tests/z3_check.mjs` 在 z3 探测**之前**逐字节比对——同一实现在任何机器上重新生成必须与 fixture 完全一致。实验面(§5:注释措辞/分节格式/set-info 文本)的任何变更都会使比对失败,须通过 `node tests/z3_check.mjs --update-fixtures` **显式更新** fixtures——**更新即审查信号**(git diff 逐字节可审,不随生成重跑而静默漂移);`--no-comments` 可剥离注释先看纯命令面差异。

### 3.4 内部判定注释(诚实标注)

每个方向块头注释携带内部判定,逐字面固定:

| 内部判定 | 注释 | 外部求解器的期望回答 |
|---|---|---|
| `proven` | `proven(期望 unsat)` | `unsat` |
| `refuted` | `refuted(内部判定违反方向被假设集强制;期望 sat——若外部 unsat,先核对假设集自身可满足性,见协议 §6.2 规则 4)` | `sat`——**前提是假设集自身可满足**;假设集不可满足时外部必答 `unsat`,这**不是**分歧(豁免见 §6.2 规则 4) |
| `unknown` | `unknown(内部未判定;外部结论不设期望)` | 无期望(sat/unsat 皆可能) |

索引表达式不可线性化的义务(`form` 为 null):义务头注释 + `; 索引表达式不可线性化:义务目标未编码(内部未证明;无 (check-sat) 可发射)`,**不发射任何命令**(无 push/declare/assert/check-sat)——没有可检目标时发射假设断言只会产出无意义的 sat,协议选择不伪装。

## 4. `--json` 协议字段(加法式)

全部字段仅在 `--proof-format smt-lib` 开启时出现;**不带该旗标时,`--json`/`--proof-report`/`--warn-unproven-index` 的既有输出逐字节不变**(字段只增不改;`fix`/`cause` 先例同款)。

### 4.1 诊断对象上的字段(M3045 / W3105)

| 字段 | 类型 | 语义 |
|---|---|---|
| `proof_obligation_id` | string | §2 的义务标识;指向该诊断对应的义务 |
| `solver_status` | string | **Ming 内部 QF_LIA 证明器**对该义务的判定(见下表);**不是外部求解器结论** |

发射点与取值(当前全部证明义务诊断面;M3041/M3042 属契约判定面、无稳定义务标识,不携带这两个字段):

| 诊断 | 义务状态 | `solver_status` |
|---|---|---|
| `M3045[index-bounds-violated]` | 违反方向被内部判定强制(未必存在具体反例——假设集不可满足时同样 refuted,见 §6.2 规则 4) | `"sat"` |
| `W3105[index-bounds-unproven]` | 内部放弃判定 | `"unknown"` |
| proven 义务 | 两向内部可证 | 不发诊断——`"unsat"` 在 `--proof-report` 义务条目与脚本注释中可见 |

`solver_status` 全值域 = `{"unsat", "sat", "unknown"}`,映射规则统一为:**proven → unsat;refuted(违反方向被强制)→ sat;unknown → unknown**。注意 `sat` 指向诊断消息中具名的**违反方向**(M3045 消息只点名被证伪的那一方向;同一义务另一方向可能仍为 unknown)。

### 4.2 `--proof-report` 义务条目上的字段

`proofs.functions[].obligations[]` 每条 additive 增加 `proof_obligation_id`(同 §2,序号 = 条目顺序)与 `solver_status`(由条目 `kind` 映射:`proven→unsat` / `violated→sat` / `unproven→unknown`)。

### 4.3 顶层 `proof_smt`

字符串字段 = 本次输出的完整 SMT-LIB 脚本(与文本模式 stdout 逐字相同)。`--proof-report` 与 `--proof-format` 可并存:`proofs` 与 `proof_smt` 共存于同一 JSON 对象。

### 4.4 退出码与文本模式

**退出码语义零变化**:0(无错误诊断)/ 1(有错误诊断,如 M3045)/ 2(strict-wasm 回落)。SMT 导出是纯输出选项,不改变任何判定。文本模式:诊断与 `--proof-report` 摘要行走 stderr/既有 stdout 通道,SMT 脚本追加在其后输出到 stdout(`--proof-report` 并存时 stdout = 摘要行 + 脚本;无 `--proof-report` 时 stdout = 纯脚本)。

**未知旗标值不静默**:`--proof-format <非 smt-lib 值>` → stderr 具名报错 + exit 1;缺值 → 解析层 `--proof-format 需要一个值` + exit 1。其他命令(run/test/…)不消费本旗标(按既有"命令只读自己认识的旗标"风格忽略)。

### 4.5 provenance manifest(`--proof-manifest <path>`,v1.2.6 / ADR-013)

脚本逐字节确定,但消费者无法仅凭脚本回答"哪个工具版本、哪版采集逻辑、什么整数模型、对应哪份源码"(外部评审 cwahq/Klara,2026-11-26 指向的 provenance 缺口)。`--proof-manifest <path>` 在脚本**旁车**写一份确定性 JSON 出处清单(sidecar)——脚本字节零变化,清单可被 git diff 审查(`pass_hash`/源哈希变化即提示重证)。

**用法与约束**:

```bash
ming check f.ming --proof-format smt-lib --proof-manifest f.manifest.json
ming check f.ming --proof-format smt-lib --proof-manifest f.manifest.json --json   # 顶层 additive proof_manifest
```

- 必须与 `--proof-format smt-lib` **同用**:缺该旗标 → stderr 具名 + exit 1(manifest 描述的就是 SMT-LIB 工件);缺值(**空格形式**)→ 解析层 `--proof-manifest 需要一个值` + exit 1。`--proof-manifest=` 空值 = 空路径(写盘失败,exit 1 具名)。路径含 `=` 时请用空格形式 `--proof-manifest <path>`(等号形式在第二个 `=` 处截断,是 `parseArgs` 的既有行为,不在本协议范围)。
- **`-`(stdout)拒绝**:脚本与 manifest 同时写 stdout 会互相污染(消费者无法区分两个工件的边界),这是对 ADR-013 §3 的 `<path|->` 的**实现期收窄**;拒绝消息给出替代指引(写文件路径),exit 1。
- **输出路径安全校验**:manifest 路径解析后与本次检查的任一源文件、或采集 pass 涉及的三个工具链源文件(`src/checker.js` / `src/prover.js` / `src/proofsmt.js`)重合 → **拒绝覆盖**并 exit 1 具名(静默覆盖源文件 = 数据丢失;Windows 下按大小写不敏感比较)。
- 文本模式:stdout 仍为纯脚本(逐字节不变),stderr 在诊断之后追加一行回执 `provenance manifest 已写入 <path>`;`--json` 模式:顶层 additive `proof_manifest` 对象(与落盘文件**同一构造**),既有字段与不带旗标输出逐字节不变。
- 写盘失败(目录不存在/不可写)= 命令行输入错误:stderr 具名 + exit 1;**不影响任何证明判定与退出码语义**(清单是纯输出选项)。构造期只把可预期的输入错误(路径重合/工具链源文件不可读)转述为 exit 1;意外内部错误按内部错误口径暴露,不伪装成用户输入错误。

**字段(v1,冻结)**——键序即下表序;数组序见各行:

| 字段 | 类型 | 语义 | 确定性来源 |
|---|---|---|---|
| `manifest_format` | int | schema 版本,当前 `1`(加法演进 = 升版) | 常量 |
| `spec` | string | 协议标识 `"ming-proof-protocol/1"` | 常量 |
| `tool.name` / `tool.version` | string | `"ming"` / 工具版本(与 `ming version`、`package.json` 同源:CLI 的 `VERSION` 传入,不手抄) | 常量 |
| `collection.pass` | string | 采集遍名 `"checkIndexBoundsStatically"` | 常量 |
| `collection.pass_hash` | string | 采集 pass 指纹 `sha256:<hex>`,范围与拼接方案见下 | 三源文件内容 |
| `collection.sources[]` | array | `{file, sha256}`:本次检查的源文件集合与哈希,见下 | 文件内容 |
| `integer_model` | object | `{domain:"Int", semantics:"i64 checked", overflow:"panic M4002"}`:诚实声明语义域(i64 检查溢出,panic 先于值进入模型);**不虚构 SMT 侧假设** | 常量 |
| `engine_contract` | object | `{eval_order, differential}` 语义面摘要——**自由文本,非机检**(见下) | 常量(随版本变更) |
| `obligations[]` | array | `{id, scope, internal_verdict:{low,high}}`,采集序 | 采集序 |
| `solver` | null | **消费者回填位**,Ming 永不填充(见下) | — |

**`collection.pass_hash` 范围(ADR-013 §2 裁决口径,v1 冻结)** = 采集相关源文件**全集**的三个文件内容:`src/checker.js`(采集遍 `checkIndexBoundsStatically` 本身)+ `src/prover.js`(逐方向判定)+ `src/proofsmt.js`(编码/符号面)。拼接方案(§113 测试侧按同一方案用 `node:crypto` 独立复算):

```
pass_hash = "sha256:" + sha256( "ming-proof-protocol/1\n"
                                + "src/checker.js\n"  + sha256hex(文件原始字节) + "\n"
                                + "src/prover.js\n"  + sha256hex(文件原始字节) + "\n"
                                + "src/proofsmt.js\n" + sha256hex(文件原始字节) + "\n" )
```

只用仓库相对路径常量与文件原始字节——不含绝对路径/时间戳,跨机同内容同值。范围过宽(无关改动使全量 manifest 失效)与过窄(采集逻辑改了 hash 不变)的风险按 ADR-013 §6 以"采集相关源文件全集"首版为准,证据驱动收窄(收窄 = manifest v2)。

**`collection.sources[]`** = 本次检查**加载的源文件全集**:命令行输入(按命令行顺序)⊕ `use` 依赖(按加载序),按解析后绝对路径去重,`file` 取首次出现的**展示路径原样**(§3.3 口径:不绝对化/不规范化/不解析——用户传相对路径则清单含相对路径);**项目模式**(entry 来自 `ming.toml`)下 `file` 一律改为**项目相对路径**(相对 ming.toml 所在目录、正斜杠、不 `..` 逃逸)——项目入口在 CLI 内部是解析后绝对路径,不相对化会让同一项目在两台机器上 manifest 字节不同。`sha256` 为文件**原始字节**的哈希。**不可读源跳过**(检查阶段已发 M3022 等诊断;manifest 只列可读源,不让一个坏输入吞掉诊断与脚本)。依赖同样改变义务集,故与脚本分节同口径纳入(不是只记命令行文件名)。**注意**:同一项目模式下 SMT 脚本的文件分节仍是入口解析路径(§3.3 项目模式例外,脚本侧本批未相对化)——本节的"manifest 无绝对路径"只约束 manifest,脚本侧例外在 §3.3 如实登记,两侧不互相掩盖。

**`obligations[]`**:`id` 与 §2 同一方案(`vc:<fn>:<序号>`,序号 = 采集序);`scope` = `body|loop`(§1);`internal_verdict` 携带**内部逐方向判定原值** `proven|refuted|unknown`——**不**做 §4.1 的 `solver_status` 三态折叠(折叠属诊断协议面;manifest 保留原值,`unknown` 如实保留,消费者可自行计数)。顺序 = 脚本块顺序 = `--proof-report` 义务条目顺序。**已知限制(v2 候选,§113.29 登记)**:§2.3 口径下不同模块可有同名 `vc:f:1`,而本数组条目**无 `file` 字段**消歧——消费者须按条目顺序对照脚本文件分节与 `sources[]` 定位归属;v2 候选 = 条目携带文件限定(加法演进,`manifest_format` 升版)。

**`engine_contract` 非机检**:该字段是自由文本的语义面摘要(`eval_order` = 源码序物化 #90/#92/#93 的对齐结论;`differential` = tree/VM/wasm/cc 四腿差分模糊证据指针——PR 门禁单种子 44044×25、nightly 3 seeds×120),**不随单次检查计算、不可由 manifest 自身验证**——它是诚实声明,不是机器可检断言。漂移风险由本文档与 §113 的逐字断言承担(改文本 = 测试与文档同步变更)。

**`solver` 恒 `null`(消费者回填位)**:Ming 不跑外部求解器;该位留给消费者记录"哪个求解器/版本对哪些义务给出 sat/unsat"。回填工具与格式不在本协议(ADR-013 §6 登记 S-5+/Agent 协议候选)。`solver: null` **不是**"尚无结论"断言——内部判定在 `obligations[].internal_verdict` 如实携带;Klara 的"unknown 不得折叠为 pass"在 manifest 层 = `internal_verdict` 原值保留、消费者可计数。

**确定性**:键序固定(表序)、数组序固定(命令行序/加载序/采集序);无时间戳、无主机名、无随机序;不引入绝对路径(展示路径是用户输入回显;项目模式按项目根相对化);同输入 + 同工具版本 → **逐字节相同 JSON**(2 空格缩进、UTF-8、LF、末尾恰一个换行)。

**与 fixture(R-19)的关系**:manifest 是旁车,不改变脚本字节 → `tests/proof_fixtures/` 黄金不受影响;manifest 自身**不入 fixture 黄金**(它含工具版本与 `pass_hash`,版本升级即变;确定性由 §113 双跑 + 独立复算锁定)。

## 5. 稳定性承诺(与 docs/stability-contract.md 口径对齐,不越权)

本协议是 **1.0 后新增面**(v1.1 首批),按 stability-contract §1.2 的 additive 先例入库(新增语言面/新增 `--json` 字段 = additive,非破坏)。分层承诺:

| 面 | 状态 | 说明 |
|---|---|---|
| `proof_obligation_id` 文法与序号语义(§2) | **冻结**(自 v1.1) | 文法、序号规则、"模块内唯一"承诺不变;跨模块消歧方式(file 字段)不变 |
| `solver_status` 值域与映射规则(§4.1) | **冻结**(自 v1.1) | 三值集与 proven→unsat/refuted→sat/unknown→unknown 映射不变;新增值域 = additive(须本文档修订登记) |
| SMT 脚本**结构不变式**(§3.1 五条) | **冻结**(自 v1.1) | 任何演进不得破坏五条不变式 |
| SMT 脚本细节(注释措辞、分节格式、set-info 文本) | **实验性** | minor 版本可调整;外部消费者不应解析注释内容,只应消费命令结构。实验面变更必须通过 `node tests/z3_check.mjs --update-fixtures` 显式更新 `tests/proof_fixtures/`(**更新即审查信号**;默认严格逐字节,`--no-comments` 仅用于查看纯命令面差异) |
| provenance manifest schema v1(§4.5,`--proof-manifest`) | **冻结**(自 v1.2.6) | 字段集/键序/确定性口径/`sources` 路径口径(§3.3 展示路径 + 项目模式相对化)不变;加法演进 = `manifest_format` 升版(ADR-013 §4)。`solver` 位是**消费者回填**语义(非 Ming 断言),回填工具/格式不在本协议(ADR-013 §6) |
| 保留字黑名单(§3.2) | 实验性(单射保证不变) | 黑名单扩圈只影响罕见冲突名的符号拼写,双射性质不变 |
| 本协议是否纳入 P1–P8 承诺面 | **未纳入** | 新面按契约 §1.2 走 additive;纳入承诺面须契约修订,本文档不预支 |

冻结面变更(改 id 文法/改值域/破结构不变式)自承诺生效日起走 stability-contract §4 弃用流程。

## 6. 外部求解器消费方式

### 6.1 基本用法(z3 示例)

```bash
ming check f.ming --proof-format smt-lib > f.smt2
z3 f.smt2
# 输出 = 逐块 (check-sat) 的回答序列,顺序 = 脚本中块顺序;对照脚本注释的"期望"逐块核对
```

任何 SMT-LIB 2.0 兼容求解器(CVC5/Yices/Bitwuzla…)均可消费;`push/pop`、`declare-const`、逐块 `check-sat` 是标准命令面,无求解器专属扩展。

### 6.2 结果解读(诚实规则)

1. **内部 proven(期望 unsat)+ 外部 unsat** = 一致,交叉验证通过。
2. **内部 refuted(期望 sat)+ 外部 sat** = 一致;外部模型(`(get-model)`,需自行追加)即内部反例的独立确认。
3. **内部 unknown + 外部 unsat** = 外部更强——**不构成 Ming 误证**:Ming 静态证明面本就保守放弃(见 §7),外部补证只增强结论,不改变 Ming 的报告行为。
4. **内部 proven/refuted + 外部回答相反** = 真实分歧候选,优先怀疑脚本消费方式(块顺序/期望错位)。**refuted 方向的豁免**:refuted 只声明"违反方向被假设集强制"(E(eff) ⊨ ¬goal);若假设集 L 自身不可满足(差分编码可能漏检 requires 矛盾,见 §6.3),外部必答 unsat 而"期望 sat"不成立——**先核对假设集自身可满足性再下分歧结论**,此类不是分歧,是"反例声明在不可满足假设集上无意义"的已知窗口(§3.4 注记已如实携带)。确认非豁免形态后按仓库流程报告 issue——三态判定与差分约束编码是内部合同(§56/§57 测试锁定),分歧即缺陷信号。

### 6.3 为什么外部可能更强(内部编码限制,如实)

内部判定走差分约束求解(Bellman-Ford,变量 ≤ 12),对约束形态有额外限制:系数须 ±1、双变量须一正一负(x−y 形态)、`!=`/`||`/非线性叶子不作为假设。**SMT 脚本编码的是采集到的完整线性约束合取,不受这些差分编码限制**——外部求解器可能从同一假设集证明内部放弃的方向(解读规则 3)。

另一处**忠实镜像**的后果:假设集不包含 `len$x >= 0` 域假设(内部证据集没有它,脚本不虚构)——外部求解器产出的模型可能呈现真实 Ming 不可能的负 Vec 长度。这只影响**模型**解读,不影响 unsat/sat 判定的正确性(判定正确性由规则 1–4 与豁免口径覆盖)。

## 7. 内部证明器不证明什么(限制如实,不得夸大)

以下情形内部证明器**一律静默放弃**——"**义务未采集 ≠ 已证明**"(v0.57 起的语义,GUIDE §6 同口径):

- **控制流**:`while` / `loop`、分支语句之后的义务(非直线体停止采集)、嵌套 for、脏循环(体内重赋值循环变量/改写外层可见变量/藏不可分析分支);
- **区间**:for 的 iter 非 Range、区间不可线性化;
- **表达式**:`||` / `!=` / 非线性叶子(不作为假设)、索引表达式不可线性化(义务采集但目标不编码);
- **类型面**:`mut` Vec 参数、非 `Vec[i64]` 元素类型、别名重绑定(`let b = buf`)、本地函数(静态证明面不含本地函数);
- **全局**:requires 自相矛盾(负环 = 函数不可达 → 整函数跳过)、变量总数超上限(> 12 → 整函数放弃)。

因此:**`--proof-format smt-lib` 的脚本只覆盖"已采集"的义务**;脚本之外没有义务——既没有"未证明"清单,也没有"已证明全体"的声明。证明只报告,不改运行时语义(M4003 边界 panic 原样保留)。泛化能力(更多控制流/非线性/浮点)属于 plan §4.20 P2 的"证明扩面"门槛项,本协议不预支。

**Alethe 证明日志**:不在本批(S-3 候选,plan §4.21——前置"S-1 稳定 + Z3 独立复核往返",未排期)。

## 8. 验证状态(如实)

| 项 | 状态 |
|---|---|
| 内部判定面回归 | ✅ 全量套件既有分节(§56/§57 等)零校准全绿;本批新增 §113(S-1 专项) |
| 独立审查(2026-11-23) | ✅ 3 MAJOR 修复:保留字 `_` 漏网(官方规范 §3.1 核实)→ `__v` 重写;跨行索引注释破裂 → 空白折叠;refuted 注记虚假声明(无反例说成有反例)→ 豁免口径改词——§113.19 回归锁定;单源化保留字表(废除测试手抄副本) |
| SMT 语法自检 | ✅ 括号配平 / `(set-logic QF_LIA)` 首行 / `(exit)` 末行 / declare 前置于 assert / push-pop 配对 / 保留字重写双射——§113 结构断言锁定(保留字表单源 = `src/proofsmt.js`) |
| Z3 消费验证 | ✅ **CI 验证通过(2026-11-26,[run 45834397042 · z3-verify job](https://github.com/coolinger2019-wq/aicode/actions/runs/45834397042/job/139969754333),success)**——`tests/z3_check.mjs`(6 语料 × 逐块对照:全 proven / 违反(假设集可满足)/ 违反(假设集不可满足 → §6.2 规则 4 豁免)/ unknown / 零义务 / loop 作用域)+ `.github/workflows/ci.yml` 的 `z3-verify` job(ubuntu-latest,apt 装 z3 + `z3 --version` 探测;安装失败即 job 失败,不静默跳过)。**历史**:2026-11-23 实测本机无 z3 → 2026-11-26 接入 CI;接入前 pip z3 5.4.1 本机预检(6 语料 7 块断言全过,版本与 apt 包不同)。诚实边界:同 run 的 macos-latest/node20 测试腿被 runner 平台回收(15 分钟整点 cancelled、零 step 记录,基础设施抖动)导致 run 级红,已触发仅失败 job 重跑;与 z3-verify 无关,job 级证据独立成立 |
| 跨求解器(CVC5 等) | ⏳ 未验证(无环境) |
| fixture 黄金(R-19) | ✅ `tests/proof_fixtures/` 六语料 SMT-LIB 脚本逐字节入库(`proven` / `refuted-sat` / `refuted-unsat` / `unknown` / `zero` / `loop`,文件名与 `tests/z3_check.mjs` 的 `CORPORA` slug 对齐);比对在 z3 探测**之前**执行——**本机无 z3 也校验确定性黄金**,缺失 fixture 或不一致 = exit 1 并打印首处差异行(两侧截断 200 字符)。脚本以相对路径生成(`; ===== 文件:<slug>.ming =====`),无时间戳/绝对路径,入库即黄金;更新唯一通道 = `--update-fixtures`(逐文件打印 新增/变更/未变,幂等——无漂移时重跑零 diff);**fixture 通过只证明输出未变(确定性),不证明内部判定正确——语义有效性由 §6 z3 逐块消费与 §7 限制口径承担;`--update-fixtures` 拒绝为生成阶段失败的语料写盘(审查 MAJOR-1),孤儿 fixture(目录多出文件)判失败(审查 MINOR-3)。** |
| provenance manifest(§4.5) | ✅ §113 v113.20–v113.29:旗标组合(缺 `--proof-format`/缺值/`-` 拒绝)/字段形状与固定序/义务与 `--proof-report` 互推(含 `unknown` 不折叠与零义务空数组)/`pass_hash` 与 `sources` 独立复算(含作用域敏感度与 use 依赖)/双跑逐字节/`--json` additive 原始字节同构造/无旗标输出零变化/**项目模式 sources 项目相对化 + 两临时根逐字节相同(审查 MAJOR-1)**/**输出路径重合拒绝(m1)**/**不可读输入诊断与脚本照常(m2)**/**同名跨文件重复 id 登记(v2 候选,NOTE-3)**。**诚实边界**:`pass_hash` 的"随源变化"以实例化副本(临时目录)验证,不修改仓库源文件;manifest 不证明脚本已由外部求解器复核——那是消费者动作(§6) |

## 9. 测试锚点

| 面 | 锚点 |
|---|---|
| SMT-LIB 导出结构/内部判定面 | `tests/run.mjs` §113(S-1 专项:义务 id、逐方向判定注释、括号配平、保留字重写双射) |
| provenance manifest 确定性/出处面 | `tests/run.mjs` §113(v113.20–v113.29:旗标约束、字段固定序、`solver===null`、义务互推与 `unknown` 原值、`pass_hash`/`sources` 独立复算、双跑逐字节、`--json` additive 原始字节同构造、无旗标零变化、项目模式相对化、路径重合拒绝、不可读输入、重复 id 登记) |
| 静态证明模糊 | `tests/proof_fuzz.mjs`(边界证明 1/2 + summaries + loops 模式,反例独立求值) |
| fixture 黄金 + Z3 外部消费 | `tests/z3_check.mjs`(R-19):阶段 A 生成 + 结构断言 → 阶段 B fixture 比对(`tests/proof_fixtures/<slug>.smt2`,缺失/不一致 = 失败,不依赖 z3)→ 阶段 C z3 逐块对照(z3 不可用打印跳过行 exit 0);`--update-fixtures` 为 fixtures 唯一更新通道,`--no-comments` 只看纯命令面 |
| 文档数字 | `tests/docs_check.mjs`(版本三处 / README / 工具数 / 能力矩阵) |

---

*本文档是 S-1/S-2 切片的交付物之一;实现面变更必须同步修订本文档(AGENTS §6 纪律:文档 ≠ 已交付,任何声明必须可被 tests/run.mjs 证明)。*
