# Ming Agent 原生协议(LSP 之上的四个 Agent 方法)

> 版本:v1.8(ADR-020,roadmap §6.1;2026-11-28 裁决 go)
> 状态:**已实现**——schema 钉死(ADR-020 §2),确定性 = 同请求同响应;MVP 期内响应
> 字段键序与义务 id 语法(`vc:<fn>:<n>`)保持稳定。
> 单一事实来源:本文件定义四个 `ming/agent/*` 方法的请求/响应 schema 与错误面;
> 实现为 `src/lsp.js`(stdio JSON-RPC,字节分帧 v0.58);数据源与 CLI 旗标同源——
> 诊断对象 = `--json` 协议(`src/diag.js` diagJson),义务记录 = `--proof-report`
> (checker proofRecords),SMT-LIB 文本 = `--proof-format smt-lib`(`src/proofsmt.js`)。
> 裁决与边界:docs/adr-020-agent-protocol.md。

---

## 1. 范围

Agent 原生协议把 Ming 的**结构化检查面**(类型上下文 / 契约摘要 / 候选检查结论 /
证明义务原始工件)以四个 JSON-RPC 方法暴露给 AI 代理,让"AI 修正回路"消费
**结构化事实**(哪个义务未证/违反 + 反例值),而非人工解读 stderr 叙事。

MVP 边界(固定,不扩面):

- 传输:**既有 LSP stdio JSON-RPC**(Content-Length 字节分帧,零新进程模型)——
  spawn `ming lsp`,先 `initialize`,方法名空间 `ming/agent/*`(LSP 自定义方法标准
  形态,不占 `textDocument/*` 命名空间);
- 既有 hover/completion/definition/documentSymbol/诊断推送路径**逐字未动**(§62 锚);
  四方法不在 `initialize` capabilities 里声明(自定义命名空间恒可用,无需协商);
- 四方法一律**读盘**(编辑器 didOpen/didChange 的缓冲区内容不参与)——与
  `ming check` 同权,确定性最简形态;活缓冲诊断走既有 `publishDiagnostics` 通道;
- **不做**:代码执行 / 网络 / 写盘(§5 安全边界)、多文件工作区索引增量协议
  (didOpen/didChange 已覆盖)、鉴权(stdio 本地进程边界)。

## 2. 传输与会话

与 LSP 完全同款:`Content-Length: <字节数>\r\n\r\n<JSON 体>`(长度按 **UTF-8 字节**
计,消息体含中文/emoji 时按字符累计会截断会话);一次会话内请求可流水发送,
响应按处理序返回。会话骨架:

```text
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}
← {"jsonrpc":"2.0","id":1,"result":{"capabilities":{…},"serverInfo":{…}}}
→ {"jsonrpc":"2.0","id":2,"method":"ming/agent/getContractSummary","params":{"file":"demo.ming"}}
← {"jsonrpc":"2.0","id":2,"result":{…}}
→ {"jsonrpc":"2.0","id":9,"method":"shutdown","params":null}
← {"jsonrpc":"2.0","id":9,"result":null}
→ {"jsonrpc":"2.0","method":"exit","params":null}
(进程退出,exit code 0)
```

坐标约定(四个方法一致):

- 请求侧 `line`/`col`:**0 起**(LSP `textDocument/hover` 同款;`col` 为该行内偏移);
- 响应侧 `span`:**1-based Ming span**(`{ line, col, endLine, endCol }`,与
  `--json` 诊断对象的 `line/col/endLine/endCol` 同口径)。

## 3. 方法 schema

### 3.1 `ming/agent/queryTypeContext` — 位置处的类型/效果上下文

请求 params:

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | string(必填) | Ming 源文件路径 |
| `line` | integer ≥ 0(必填) | 0 起行号 |
| `col` | integer ≥ 0(必填) | 0 起列偏移 |

响应 `result`(成功):

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 恒 `true` |
| `type` | string | 位置命中的声明签名(hover 同款渲染,如 `fn dist(p: Point) -> i64 with io`、`struct Point { x: i64, y: i64 }`、字段 `x: i64`) |
| `effects` | string[] | 所在 fn 的 `with` 效果名数组;不在 fn 内 → `[]` |
| `fn` | string \| null | 所在 fn 的完整签名;不在 fn 内 → `null` |
| `span` | object | 命中声明的 1-based span `{ line, col, endLine, endCol }` |

响应 `result`(失败):`{ "ok": false, "reason": "<具名原因>" }`。

定位语义:与 hover 同款声明定位(`collectHoverables`);多处命中取**最小 span**
(内层优先——字段位置报字段签名而非外层结构体);位置不落在任何类型化声明上
(use 行/空行/越界/注释)→ `ok:false` 具名(宁可少报不错报)。`fn`/`effects` 取
**内层包含 fn**(体内位置:局部 fn 体内 → `fn` = 该局部 fn、`type` = 外层声明;**impl 方法体内与 test 块内 → `ok:false`(具名 reason)——与 hover 同款口径:collectHoverables 只收模块级 item 与 struct 字段;登记候选:扩收 impl 方法);签名/契约行位置回退到模块级
fn/impl 方法)。test 块内位置 → `fn: null`、`effects: []`(test 无签名,如实)。

真实报文示例(`types.ming` 第 4 行体内,0 起 `line:3, col:4`):

```json
→ {"jsonrpc":"2.0","id":10,"method":"ming/agent/queryTypeContext","params":{"file":"types.ming","line":3,"col":4}}
← {"jsonrpc":"2.0","id":10,"result":{"ok":true,"type":"fn dist(p: Point) -> i64 with io","effects":["io"],"fn":"fn dist(p: Point) -> i64 with io","span":{"line":3,"col":1,"endLine":5,"endCol":2}}}
```

顶层(第 2 行 `struct Point` 上,`line:1, col:6`):

```json
← {"jsonrpc":"2.0","id":11,"result":{"ok":true,"type":"struct Point { x: i64, y: i64 }","effects":[],"fn":null,"span":{"line":2,"col":1,"endLine":2,"endCol":33}}}
```

### 3.2 `ming/agent/getContractSummary` — 契约摘要 + 证明状态

请求 params:

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | string(必填) | Ming 源文件路径 |
| `fn` | string(可选) | 只报该顶层 fn;缺省 = 全函数(声明序) |

响应 `result`(成功):

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 恒 `true` |
| `functions` | array | 每项 `{ name, requires, ensures, obligations }`(见下) |

`functions[]` 元素:

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 顶层 fn 名(声明序;impl 方法/局部 fn 不列) |
| `requires` | string[] | requires 子句源文(剥前导关键字,表达式与可选 `else "消息"` 后缀逐字保留);无子句 → `[]`。语法上可重复但后者覆盖,故至多 1 条 |
| `ensures` | string[] | 同上(ensures 子句) |
| `obligations` | array | 索引边界义务(`--proof-report` 同源;无义务 fn → `[]`) |

`obligations[]` 元素:

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 稳定义务 id `vc:<fn>:<n>`(n = 采集序 1 起,与 `--proof-format smt-lib` 义务注记、`--json` 的 `proof_obligation_id` 同一口径) |
| `kind` | string | `proven`(两方向可证)/ `violated`(可证违反)/ `unproven`(未证明) |
| `scope` | string | `body`(直线体)/ `loop`(范围 for 循环体内) |
| `counterexample` | string | 仅 violated 且有反例时出现,如 `"len$buf = 0, n = 0"`(`len$x` = Vec 实参长度符号;结构化形态见 3.3 的 `counterexamples`) |

`ok` 只表示"摘要生成成功":语义违反(M3045 等)**不算方法失败**,如实以
`kind: "violated"` 呈现。`fn` 过滤名不存在 → `ok:false`。

真实报文示例(`contract.ming`,过滤 `fn: "f"`):

```json
→ {"jsonrpc":"2.0","id":20,"method":"ming/agent/getContractSummary","params":{"file":"contract.ming","fn":"f"}}
← {"jsonrpc":"2.0","id":20,"result":{"ok":true,"functions":[{"name":"f","requires":["n == buf.len()"],"ensures":[],"obligations":[{"id":"vc:f:1","kind":"violated","scope":"body","counterexample":"len$buf = 0, n = 0"}]}]}}
```


> 注:入口文件存在不可解析本地导入(M3022)等**诊断类失败**时,`getContractSummary` 仍 `ok:true`（摘要只覆盖入口文件顶层 fn 的可收集面——诊断不在本方法面,消费方需经 `submitCandidate` 查看）。### 3.3 `ming/agent/submitCandidate` — 候选提交(只读检查)

**安全边界(裁决核心,ADR-020 §2)**:`candidate` 是**本地文件路径**,协议只触发
"读该文件并走既有 check 管线"——**不执行候选代码,不做网络,无写盘,无新效果面**
(与 `ming check` 同权)。响应里只有检查结论(诊断对象/义务记录/反例值),
没有任何可执行内容。

请求 params:

| 字段 | 类型 | 说明 |
|------|------|------|
| `candidate` | string(必填) | 候选文件路径(不存在 → `ok:false` 具名) |

响应 `result`(成功):

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 恒 `true`(检查完成;候选自身的结论在 `pass`) |
| `pass` | boolean | 无 error 级诊断 → `true` |
| `diagnostics` | array | `--json` 诊断对象同形:`{ code, name, severity, message, file, line, col, endLine, endCol, hint?, fix?, notes? }`(1-based 位置) |
| `proofs` | object | `{ summary, functions }`——`summary` = `{ functions, obligations, proven, violated, unproven }` 计数(`--proof-report` 同口径);`functions` = 3.2 的 `functions[]` 同形(全函数) |
| `counterexamples` | array | 每项 `{ obligationId, values }`——从 violated 义务的反例字符串结构化: obligationId = 义务 id;values = `{ 变量名: "十进制字符串值" }`(值保持字符串:反例值保字符串是**防御性**口径:当前反例来自确定性枚举窗口(i64 ∈ {-2..2}、len ∈ {0..8}、循环符号 ∈ {-2..10},src/checker.js 枚举器),构造不出超 2^53 的值;若未来枚举/求解窗口放宽,字符串保值不受 JSON 安全整数限制, consumers 按十进制字符串解析即可。

真实报文示例(候选含越界违反,`vc:f:1` 反例):

```json
→ {"jsonrpc":"2.0","id":30,"method":"ming/agent/submitCandidate","params":{"candidate":"contract.ming"}}
← {"jsonrpc":"2.0","id":30,"result":{"ok":true,"pass":false,"diagnostics":[{"code":"M3045","name":"index-bounds-violated","severity":"error","message":"函数 \"f\" 的索引 \"buf[n]\" 可静态证明越界(违反义务:n < len$buf)(反例:len$buf = 0, n = 0)","file":"contract.ming","line":5,"col":12,"endLine":5,"endCol":18,"hint":"让索引满足 n < len$buf 对所有满足 requires 的调用成立(调整 requires 边界或索引表达式);该越界在运行时本会以 M4003 panic。"}],"proofs":{"summary":{"functions":3,"obligations":3,"proven":1,"violated":1,"unproven":1},"functions":[…3.2 同形…]},"counterexamples":[{"obligationId":"vc:f:1","values":{"len$buf":"0","n":"0"}}]}}
```

### 3.4 `ming/agent/requestProofObligation` — 原始义务工件

请求 params:

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | string(必填) | Ming 源文件路径 |
| `fn` | string(可选) | 只报该顶层 fn;缺省 = 全部 |

响应 `result`(成功):

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 恒 `true` |
| `report` | object | `--proof-report --json` 同构:`{ summary, functions, summaries }`。`summary` = `{ functions, obligations, proven, violated, unproven }`;`functions[]` = 逐函数义务记录 `{ file, abs, fn, total, proven, violated, unproven, obligations: [{ file, fn, index, kind, obligation, line, col, counterexample, scope }] }`(`obligation` = 违反义务线性文本,如 `"n < len$buf"`;`index` = 索引表达式原文);`summaries[]` = 契约摘要统计 `{ file, abs, fn, requires_present, requires_complete, ensures_present, ensures_proven, calls_proven, calls_violated }`。覆盖该文件连同其本地导入模块(与 `--proof-report` 同口径);`abs` 为绝对路径(报告去重键成分,同 CLI) |
| `smtLib` | string | `--proof-format smt-lib` 同源文本(`src/proofsmt.js` 进程内直调,不 spawn 子进程);QF_LIA 2.0 脚本,每义务两方向 `(push)…(check-sat)(pop)` 块,内部判定结论写在注释里;Agent 可自行喂给外部求解器独立复核 |

`fn` 过滤作用于全部三个数据源(`functions`/`summaries`/SMT 义务),`report.summary`
为过滤后子集的统计。义务记录含 BigInt 线性形式的部分**不进 JSON**(与 CLI 的
proofs 白名单纪律一致);SMT 文本是线性形式的唯一出口。

真实报文示例(全函数,SMT 摘录):

```json
→ {"jsonrpc":"2.0","id":40,"method":"ming/agent/requestProofObligation","params":{"file":"contract.ming"}}
← {"jsonrpc":"2.0","id":40,"result":{"ok":true,"report":{"summary":{"functions":3,"obligations":3,"proven":1,"violated":1,"unproven":1},"functions":[{"file":"contract.ming","abs":"C:\\…\\contract.ming","fn":"get","total":1,"proven":1,"violated":0,"unproven":0,"obligations":[{"file":"contract.ming","fn":"get","index":"i","kind":"proven","obligation":"0 <= i && i < len$buf","line":2,"col":12,"counterexample":null,"scope":"body"}]},…],"summaries":[…]},"smtLib":"(set-logic QF_LIA)\n(set-info :source \"Ming 证明义务导出(QF_LIA 子集;规范见 docs/proof-protocol.md)\")\n\n; ===== 文件:contract.ming =====\n; ---- vc:get:1 — 索引 i(scope: body)----\n; 方向 low — ming 内部判定: proven(期望 unsat)\n(push)\n(declare-const i Int)\n(declare-const len$buf Int)\n(assert (>= i 0))\n(assert (< i len$buf))\n(assert (not (>= i 0)))\n(check-sat)\n(pop)\n…"}}
```

## 4. 错误面清单

失败**绝不静默**:方法可表达的失败 → `result = { "ok": false, "reason": "<具名>" }`;
实现内部意外异常 → JSON-RPC error(连同 stderr 留痕);未知方法 → JSON-RPC error。

| 失败形态 | 返回 |
|----------|------|
| 参数缺失/类型错误(如缺 `line`) | `{ ok:false, reason:"参数 \"line\" 必须是非负整数(LSP 坐标,0 起)" }` / `缺少必填参数 "file"(非空字符串)` |
| 文件不存在 | `{ ok:false, reason:"文件不存在: <path>" }` |
| 文件不可读(权限等) | `{ ok:false, reason:"无法读取文件 \"<path>\": <系统原因>" }` |
| 语法错误(四个方法同款) | `{ ok:false, reason:"文件存在语法错误,…:<首条诊断消息>" }`(submitCandidate 例外:诊断照报,见 3.3) |
| `fn` 过滤名不存在 | `{ ok:false, reason:"函数 \"<fn>\" 不存在于该文件" }` |
| queryTypeContext 位置不落在任何类型化声明上 | `{ ok:false, reason:"指定位置不落在任何类型化声明上(宁可不报)" }` |
| 实现内部意外异常 | JSON-RPC error `{ code: -32603, message: "internal error: <方法名>: <原因>" }`(stderr 留痕) |
| 未知 `ming/agent/*` 方法(含任意未知方法) | JSON-RPC error `{ code: -32601, message: "method not found: <方法名>" }` |

**确定性**:同请求同响应(无时间/随机;Map 插入序即遍历序;SMT 变量序 = 采集序)。
协议面纯读 + 既有 check 管线,零新增 M 码,语言语义零变化。

## 5. 安全边界(ADR-020 §2/§3 要点)

1. `submitCandidate` 的 `candidate` 是**本地文件路径**,协议只触发"读该文件并走
   既有 check 管线"——**不执行候选代码,不做网络,无写盘,无新效果面**(与
   `ming check` 同权);响应里只有检查结论,没有任何可执行内容。
2. 四方法一律读盘、纯读;不触碰 LSP 缓冲区写入路径,不产生副作用。
3. 效果门禁不变:协议实现自身零新增能力;候选代码的检查与 `ming check` 完全同权
   (该拒绝的照拒绝,该 panic 面照静态诊断)。
4. 不做鉴权(边界 = stdio 本地进程);不承诺多租户/远程使用形态。

## 6. 演示循环(AI 修正回路)

与参考 Agent 客户端(`C:\code\agent-client\` 的 `demo.py`)对齐的完整叙事:

1. Agent 对 `contract.ming` 调 `getContractSummary` → 看到 `vc:f:1` `kind: "violated"`
   (或直接提交候选);
2. `submitCandidate` → `pass:false`,`diagnostics` 含 M3045(消息带违反义务
   `n < len$buf` 与反例),`counterexamples` 给出结构化值
   `{"obligationId":"vc:f:1","values":{"len$buf":"0","n":"0"}}`——AI 拿到的是
   "哪个义务、违反条件、具体值",不是叙事;
3. Agent 修正 requires(如改 `requires n >= 1 && n <= buf.len()`),写盘后再次
   `submitCandidate` → `pass:true`、`counterexamples: []`;
4. 需要独立复核时调 `requestProofObligation` → 拿到 `--proof-report` 同构报告与
   QF_LIA SMT-LIB 文本,喂外部求解器对 `(check-sat)` 的结论自行核对
   (Ming 内部判定口径:proven→unsat / violated→sat / unproven→unknown;外部求解
   结论不设期望,见脚本注释与 docs/proof-protocol.md §6.2 规则 4)。

## 7. 明确不做(登记,ADR-020 §5)

- 协议层不做代码执行/网络/写盘(`submitCandidate` 仅读路径走 check);
- 不做多文件工作区索引增量协议(LSP 既有 didOpen/didChange 已覆盖);
- 不做鉴权(stdio 本地进程边界);
- Python 之外的参考客户端(TS 版登记候选)。
