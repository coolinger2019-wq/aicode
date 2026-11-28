# ADR-020: Ming Agent 原生协议——LSP 之上的四个 Agent 方法（roadmap §6.1）

> **状态**:**已裁决 go（架构师，2026-11-28，维护者 standing workflow 视为点名；P1 6.1 准入已达成——ADR-017）**。版本 v1.8.0（minor）。
> **来源**：roadmap §6.1（P1 准入达成后启动）；§4.27 P1 解锁登记。
> **关联**：src/lsp.js（stdio JSON-RPC,字节分帧 v0.58）、--json 诊断协议、--proof-report（v0.52/v1.1 义务追溯字段）、docs/proof-protocol.md、examples/consumers/（消费套件先例）。

---

## 1. 传输与命名

- **传输 = 既有 LSP stdio JSON-RPC**（Content-Length 字节分帧,零新进程模型）；方法名空间 `ming/agent/*`（LSP 自定义方法标准形态,不占 textServer/* 命名空间）。既有 hover/completion/definition/documentSymbol/诊断推送逐字不动。
- **schema 公开**：docs/agent-protocol.md（规范文档,与 --json 诊断码体系对齐——诊断对象复用 `{code,name,severity,message,file,line,col,endLine,endCol}` 形态）。

## 2. 四个方法（schema 钉死）

1. **`ming/agent/queryTypeContext`**（file, line, col → 位置处的类型/效果上下文）
   - 返回 `{ ok, type?, effects?, fn?, span? }`——type 复用 lsp.js sigType 渲染;effects = 所在 fn 的 with 声明;不在 fn 内/未知 → ok:false + 具名 reason（宁可少报不错报,LSP 既有纪律）。
2. **`ming/agent/getContractSummary`**（file, fn? → 契约摘要 + 证明状态）
   - 返回 `{ ok, functions: [{ name, requires[], ensures[], obligations: [{ id, kind: proven|violated|unproven, scope, counterexample? }] }] }`——数据源 = checker proofs（--proof-report 同源,id = `vc:<fn>:<n>` 稳定语法）;fn 缺省 = 全函数。
3. **`ming/agent/submitCandidate`**（candidate: 文件**路径** → 结构化检查结果)
   - **安全边界（裁决核心）**：candidate 是**本地文件路径**,协议只触发"读该文件并走既有 check 管线"——**不执行候选代码,不做网络,无新效果面**（与 `ming check` 同权）。
   - 返回 `{ ok, pass, diagnostics: [<--json 诊断对象>], proofs: {summary, functions}, counterexamples: [{ obligationId, values }] }`——AI 修正回路结构化：具体哪个 VC 未证/违反 + 反例值,而非叙事。
4. **`ming/agent/requestProofObligation`**（file, fn? → 原始义务工件）
   - 返回 `{ ok, report: <--proof-report JSON 同构>, smtLib?: SMT-LIB 2.0 文本（--proof-format smt-lib 同源） }`——Agent 可自行拿去外部求解器（独立复核叙事的协议面）。

## 3. 错误面与确定性

- 一切失败（文件不存在/解析失败/位置越界）→ JSON-RPC error 或 `{ ok:false, reason }` 具名,**绝不静默**;确定性 = 同请求同响应（无时间/随机）。
- 协议面纯读 + 既有 check 管线,零新增 M 码,语言语义零变化。

## 4. 交付物（roadmap §6.1 对账）

1. 协议规范文档：docs/agent-protocol.md（消息 schema/示例/错误面）。
2. **参考 Agent 客户端**：`C:\code\agent-client\`（独立 git 仓库,第四个外部消费者同款纪律——纯 Python 标准库,stdio JSON-RPC,只经协议消费 Ming:spawn `ming lsp` 进程,四方法端到端)。三条件对照:C1 独立仓库 ✓ / C2 不依赖 Ming 工具链的**代码依赖**(运行时 spawn `ming lsp` 是协议交互本身,非库依赖——与 pyuserlib/rustuserlib 的"消费导出工件"不同类,属 roadmap §6.1 自己的交付物定义) / C3 消费的是协议响应(结构化 JSON),不是人工解读输出。
3. **演示完整循环**：Agent 提交候选（含越界错误）→ 收到 M3045 结构化反例 → 修正 → 再提交 → proven。脚本化在 agent-client 仓库（`demo.py`）。

## 5. 明确不做（登记）

- 协议层不做代码执行/网络/写盘（submitCandidate 仅读路径走 check）；不做多文件工作区索引增量协议（LSP 既有 didOpen/didChange 已覆盖）；不做鉴权（stdio 本地进程边界）；Python 之外的参考客户端（TS 版登记候选）。
