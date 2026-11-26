# ADR-013:证明工件 provenance manifest(出处清单)

> **状态**:**已裁决 go(架构师,2026-11-27)**——§7 三项裁决:① 字段集 v1 批准(`pass_hash` 范围 = checker 采集段 + prover + proofsmt 源文件内容;`engine_contract` 保持自由文本但协议内显式标注"非机检";`solver: null` = 消费者回填位,非 Ming 自动填充) ② 交付形态 = sidecar 旗标 `--proof-manifest <path|->`(要求与 `--proof-format smt-lib` 同用) ③ 实现随下一批;与 S-3a 证书指纹位以 manifest v2 additive 合流(ADR-014 §9 U8)。外部评审字段集已在 moltbook 帖征求反馈(2026-11-26)。
> **来源**:moltbook 外部评审两条独立评论合流——cwahq:"the proof artifact is portable only if the semantics travel with it: language version, lowering-pass hash, integer model, evaluation order, and solver assumptions. otherwise the script deterministically proves one compiler's translation while the next backend executes a different machine.";Klara:"`solver_status` has to be three-valued, and the solver name and version have to travel with it... a proof checked by a different solver build is a different claim." 两者指向同一缺口:**证明工件缺出处(provenance)**。
> **关联**:docs/proof-protocol.md(S-1 协议,§5 稳定性分层/§8 验证状态)/ docs/roadmap-infrastructure.md §5.1(P0 证明对象标准化)/ docs/plan.md §4.20 P2 R-20 / 交付物 = SMT-LIB 脚本旁车的 JSON manifest(sidecar,不改变脚本字节)。

---

## 1. 决策问题

`ming check --proof-format smt-lib` 产出逐字节确定的 SMT-LIB 脚本,但它只携带"约束 + 内部判定注释"。外部消费者无法仅凭脚本回答:

1. 这是**哪个版本**的 Ming、哪一版**义务采集逻辑**产出的?(工具版本 + 采集 pass 指纹)
2. 证明的是**什么语义**?(整数模型:i64 带溢出检查?求值序?——脚本编码的是源级 VC,但消费方需要知道背后的引擎合同)
3. **哪个求解器**给出过什么结论?(外部复核是消费者自己的动作;manifest 给消费者一个回填/对照位)
4. 义务集合对应**哪个源码状态**?(源文件哈希——改一行源码,义务集可能不同)

**本 ADR 只解决"出处随工件旅行",不解决"证明生产"**(内部差分求解器不产推理链,Alethe 问题见 ADR-014)。

## 2. 草案:字段集(manifest schema v1)

确定性 JSON(键序固定、无时间戳、无绝对路径);示例:

```json
{
  "manifest_format": 1,
  "spec": "ming-proof-protocol/1",
  "tool": { "name": "ming", "version": "1.2.4" },
  "collection": {
    "pass": "checkIndexBoundsStatically",
    "pass_hash": "<sha256: 采集逻辑源文件内容(prover.js+proofsmt.js 相关段)>",
    "sources": [ { "file": "f.ming", "sha256": "<源文件哈希>" } ]
  },
  "integer_model": { "domain": "Int", "semantics": "i64 checked", "overflow": "panic M4002" },
  "engine_contract": {
    "eval_order": "source-order (v1.2.4: #90/#92 materialized call args & checked operands)",
    "differential": "tree/VM/wasm/cc;4 seeds × 40 programs, 0 divergences (CI fuzz job)"
  },
  "obligations": [ { "id": "vc:get:1", "scope": "body", "internal_verdict": { "low": "proven", "high": "proven" } } ],
  "solver": null
}
```

字段裁决:

| 字段 | 语义 | 确定性来源 |
|---|---|---|
| `tool.version` | 工具版本(与 `ming version` 同源 = package.json) | 常量 |
| `collection.pass_hash` | **采集 pass 指纹** = 相关源文件(checker 采集段/prover/proofsmt)内容 sha256 | 源文件内容 |
| `collection.sources[]` | 每个输入 .ming 的 sha256 + 命令行展示路径(§3.3 口径) | 文件内容 |
| `integer_model` | 诚实声明语义域:i64 检查溢出(= panic 先于值进入模型);**不虚构 SMT 侧假设** | 常量 |
| `engine_contract` | 消费者最关心的语义面摘要:eval order 已物化对齐(v1.2.4);差分模糊证据指针 | 常量(随版本变更) |
| `obligations[]` | 义务 id + 方向判定——与脚本注释同信息、机器可读形式 | 采集序 |
| `solver` | **恒 null**(Ming 不跑外部求解器);消费者回填位:哪个求解器/版本对哪些义务给出 sat/unsat | 消费者填写 |

**不包含**:时间戳、机器名、绝对路径、CSS 指纹等非确定信息;也不含"证明日志"(S-3/ADR-014 范围)。

## 3. 交付形态(选项与裁决)

- **A. sidecar 文件**(推荐):`ming check f.ming --proof-format smt-lib --proof-manifest <path|->`——脚本 stdout 不变(字节稳定性零破坏),manifest 写指定路径或 stdout。消费者拿到"脚本 + manifest"两个工件;manifest 可被 git diff 审查(pass_hash/source 变化即提示重证)。
- **B. 内嵌 SMT-LIB `(set-info :source ...)`**:标准机制,但把版本/tool 信息写进脚本 = 破坏字节稳定性(且每次版本升级全量 fixture 失效)。**否决**。
- **C. 仅 `--json` 字段**:`check --json` 增 `manifest` 字段——可行,但 JSON 诊断协议是另一稳定面,manifest 生命周期应独立。作为 A 的从属(实现上 manifest 构造与 JSON 输出共用函数)不单独成形态。

## 4. 与既有承诺面的关系

- **脚本字节稳定(fixture 黄金)不受影响**:manifest 是旁车,A 形态下脚本输出逐字节不变。
- **`solver_status` 三值口径不变**(§4.1:proven→unsat/refuted 违反方向→sat/放弃→unknown,内部证明器口径);manifest 的 `solver` 位明确是**消费者回填**,不是 Ming 的断言——Klara 的"unknown 不得折叠为 pass"在 manifest 层的对应 = `obligations[].internal_verdict` 如实携带 unknown,消费者可计数。
- **稳定性分层**:manifest schema v1 自实现起冻结(加法演进 = manifest_format 升版);不进 P1–P8 承诺面(沿 proof-protocol §5 口径)。
- **确定性**:键序/数组序由实现固定;哈希用 sha256;同输入同工具版本 → 逐字节同 manifest。

## 5. 实现切片(裁决后执行)

1. `src/manifest.js`(或 proofsmt.js 内导出)纯函数:从 check 结果 + 源文件集合构造 manifest;`pass_hash` 计算范围显式登记(包含哪些源文件)。
2. `bin/ming.js`:check 增 `--proof-manifest <path|->` 旗标(与 `--proof-format smt-lib` 组合;缺 `--proof-format` 时给出明确错误或允许?建议:**要求同用**,manifest 描述的就是 SMT-LIB 工件)。
3. tests §113 扩展:字段存在性/确定性双跑/pass_hash 随源变化/`solver` 恒 null/无旗标输出不变/fixture 不受影响。
4. docs/proof-protocol.md 新增 §"provenance manifest"小节 + §5 稳定性表 + §8 验证状态行。

## 6. 风险与未决

- **pass_hash 范围过宽或过窄**:过宽 → 任何无关改动使全量 manifest 失效(消费者体验到"永远要重证");过窄 → 采集逻辑改了 hash 不变(更糟)。草案取"采集相关源文件全集",首版可接受;证据驱动收窄。
- **engine_contract 是自由文本**:诚实但不可机检。风险=漂移。备选:只放版本号 + 由协议文档承载叙述;裁决时可取舍。
- **消费者回填 solver 位**:需要约定回填工具/格式(是否 Ming 提供 `ming proof annotate` 把外部结果并回?)——**不在本 ADR**,登记为 S-5+/Agent 协议候选。
- **与 ADR-014 的关系(已裁决后口径)**:ADR-014 裁决 = S-3 重定义为可独立复核证明工件(v1 自产线性证书,非 Alethe);证书指纹位**以 manifest v2 additive** 进入(ADR-014 §9 U8),v1 字段不变;`solver` 位仍是**消费者回填位**(非 Ming 自动填充,非证明日志指针)。

## 7. 裁决请求

1. 字段集(v1)是否批准,尤其:`pass_hash` 范围、`engine_contract` 自由文本的取舍、`solver: null` 回填位口径。
2. 交付形态 A(sidecar 旗标)是否批准;旗标命名 `--proof-manifest`。
3. 实现切片是否随下一批(S 切片)执行。
