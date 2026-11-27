# ADR-016: moltbook 集成工具——网络出向数据面与序列化出口

> **状态**:**已裁决 go（架构师，2026-11-27）**——两项语言出口落地：① http 请求 **body 槽位出向透传**（v0.77 清单 6 扩面：本地存储 → 网络出向数据面；url/method/headers sink 不变）；② 落地 v0.68 登记候选 `json.stringify_untrusted`（污进污出）。零新增 M 码，零运行时语义变化（类型层 + 纯函数加法）。版本 v1.5.0。
> **来源**：维护者指令（2026-11-27）："做一个集成工具就是 moltbook 的应用的集成工具，方便 agents 注册，登录，查看，答复，查询等功能"。工具 #18 = `tools/moltbook.ming`。
> **关联**：ADR-007（清单 6 出向透传原裁决）、ADR-008（argv 污点 v1.3）、v0.68（stringify 拒绝 + stringify_untrusted 登记候选）、checker.js net fns 注释（"网络出向保持 sink"）。

---

## 1. 决策问题

Ming 版 moltbook 客户端工具需要：注册（POST）、登录（校验 + 落盘）、查看（GET 帖/评论/feed/通知）、答复（POST 评论）。现有门禁下：

- GET 全通（响应侧 v0.77 起标污，消费面完备）。
- **POST 全拦**：三个独立门禁点串联——
  1. **body sink**（ADR-007 清单 6 明文"出向透传仅限本地存储，网络出向保持 sink"）；
  2. **Json→str 整体出口闭合**（v0.68：`json.stringify(Untrusted[Json])` → M3049——即使 body 放开，编码这步也被拦）；
  3. **headers sink**（api_key 来自凭证文件 = Untrusted[str]，Authorization 头直接 M3049）。

## 2. 逐项裁决

### 2.1 body 槽位出向透传（'outstr'）——采纳

| 项 | 裁决 |
|---|---|
| 变更 | `http_request`/`http_request_opts` 的 **body 参数位** 标记 `'outstr'`（污值合法流入） |
| 不变 | **url/method/headers 保持 sink**（M3049 不动）：url = 目的地控制面（头注入/SSRF 面），headers = CR/LF 头注入面 |
| 语义依据 | 与本地存储同构：write 家族"存储不是边界穿越"（§2.5）→ 网络出向 data plane 同理——**发送是存储的远端形态** |
| 门禁原始目标不受损 | 渗出通道的构成要件 = **污数据 + 攻击者控制的目的地**。url 是净槽：攻击者不能选择外传目的地；headers 净化路径见 §2.3。残余风险（操作者把敏感内容误发给自选目的地）与 write_file 同级（写盘后可再发布），v0.77 已同等接受 |
| 运行时 | **零变化**（纯类型层槽位标记；tree/VM/wasm/cc 执行路径不动） |

### 2.2 `json.stringify_untrusted(Untrusted[Json]) -> Untrusted[str]`——采纳（v0.68 登记候选落地）

- 污进污出：`Untrusted[Json]` → `Untrusted[str]`（编码保污）；**净 Json 同时接受 → 净 str**（既有 `stringify` 零迁移，两函数并存）。
- 消费面：产出恒污 → 只能流向 out 槽位（print 出向透传 / write_file outstr / **http body outstr（§2.1）**）——不能回流计算面（debug/插值/as 照旧 M3050/M3008）。
- 投影表（Untrusted[Json] 方法表）追加 `stringify_untrusted`；载体分派同 `json.parse` 两域接缝口径。
- 落地理由：它是 v0.68 明文登记的候选（GUIDE §json"污进污出变体登记候选"）；不落地则 body 放开也无效（编码步仍拦），两裁决互为前提。

### 2.3 凭证链（不新增净化器）

`api_key` 全链：凭证文件读取（Untrusted）→ `json.parse`（污进污出 → Untrusted[Json]）→ 投影 `as_str`（Option[Untrusted[str]]）→ **`std.unstr.sanitize_cli_path`**（拒绝 NUL/C0/DEL/C1/双向控制符 = **恰是 CR/LF 头注入防御面**；moltbook key 字符集 [A-Za-z0-9_-] 必过）→ Ok(净 str) → headers sink 合法。**不新增净化器**（"净化器族不扩"两轮裁决维持）——复用既有净化器，其拒绝面与头注入面重合是语义巧合的正当使用，非扩权。

### 2.4 否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 新增通用内容净化器 | "净化器族不扩"两轮裁决（v0.68/ADR-012 §4.6）；通用洗白 = 门禁旁路 |
| argv 内容位改净 | ADR-008 已裁"内容位保污透传" |
| body 保持 sink + 工具手拼 JSON 转义 | 转义正确性责任下放工具层 = 注入 bug 面；与语言"机器友好"立场相悖 |
| GET-only 工具 | 注册/答复是维护者点名的功能，不成立 |

## 3. 实现面（合同）

1. checker：`http_request` body 位（参数 4）与 `http_request_opts` body 位（参数 4）标 `'outstr'`；头注释同步（v0.77 清单 6 扩面按本 ADR）。
2. interp/compiler：`json.stringify_untrusted` 裸 builtin + Untrusted[Json] 投影表方法（checker 签名 + interp 效果分支，纯函数无效果——挂在 std.json 命名空间，`json.stringify_untrusted` 模块调用形式与投影表双形式同 v0.58 口径）；wasm/C 资格：纯函数，按既有 Json 函数同判。
3. 工具 `tools/moltbook.ming`（效果 `io, fs, net`）：CLI 合同见批次指令（register/login/me/post/comment/read/feed/notifications + `--base-url` + `--creds`）；凭证永不打印；错误 stderr + exit 1 具名。
4. 测试：checker 正/负例（body 透传 OK；url/headers 仍 M3049；stringify_untrusted 污进污出/净直传）；工具行为测试用本地 mock server（独立进程、动态端口——**分节入 PAR_GROUPS 组 0**）。
5. 文档三处：GUIDE（§19 sink 清单补 body 位 + std.json 两行 + 工具行）、ADR-016（本文）、diagnostics 零变化。

## 4. 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| body 透传被视为门禁弱化 | 中 | 本 ADR 明示"目的地净槽"论证 + 测试锁定 headers/url 仍拦（负例双向） |
| stringify_untrusted 被当洗白器 | 中 | 产出恒污（Untrusted[str]），消费面 out-only——类型层不可回流 |
| 凭证意外打印 | 高 | 工具永不输出 key（register 打印 claim_url 而非 key）；测试断言 stdout 无 key 子串 |
| mock server 端口冲突 | 低 | 动态端口 + 组 0 串行（既有端口漂移纪律） |

---

## 5. 实现期注记（agent A，2026-11-27）

1. **Json 构造路径定案**：§2.4 预期"字面量内插污 str → Untrusted[Json]"在语言面**不存在**（Ming 无 Json 字面量构造；`Json { f: u }` 走 struct 字面量路径 → 毒化 M3002；Map/Vec 混污容器进不了 Json 载体）。落地采用批次指令的退路并加固：**手拼转义（esc = 7 段顺序 replace，先反斜杠后其余，保污纯函数）→ `json.parse` 自校验（Err = 具名错误 exit 1，不静默发坏 body）→ `.stringify_untrusted()` 规范化（编码正确性回归语言层）→ Untrusted[str] → http body（'outstr'）**。转义层只覆盖 5 个命名控制字符（\b\f\n\r\t）+ `"` + `\` 共 7 段转义；其余 C0 控制字符无法在污面按码点检测（污值代数无码点出口），由 parse 自校验层拒绝（诚实失败）。实测双引擎（tree/VM）输出逐字一致。
2. **工具效果集 = `io, fs, net, env`**（§3.3 合同写 "io, fs, net"）：HOME/USERPROFILE 凭证路径探测必须 `std.env.get`（效果 env），实现期必要扩项；无 env 时回退当前目录 `moltbook.json` 的合同行为不变。
3. **tools AOT 缓存**：`toolCacheProbe` 的效果排除清单加 `net`（bin/ming.js，v0.62 cmdBuild usesNet 同口径）——`ming tools moltbook ...` 具名回退源码模式（`[tools-cache] fallback moltbook.ming: probe 不可缓存`），不写缓存条目。
4. **CLI 透传**：`--creds/--base-url/--limit/--read-all` 是工具自有选项，经 `ming tools moltbook <子命令> -- <参数...>` 的 `--` 段透传（diaghot `--top` 既有约定）；直接裸写会被 ming 的全局 flag 解析吞掉。本工具 argv 解析自身兼容两种形态（`--` 段内外皆可识别选项）。
5. **wasm 资格**：`json.stringify_untrusted` 模块形式与 `json.stringify` 编译路径相同（`__stdmod:json`），资格口径逐字镜像（对照样本 functions=2 均无 REJECT）；投影表方法形式（Untrusted 接收者）沿既有 Json 投影运行面。src/wasm.js 零改动。
6. **URL 构造位无百分号编码**（独立审查 NOTE-1，2026-11-27）：post-id/submolt 拼 URL 前仅过 `std.unstr.sanitize_cli_path`（控制字符面：NUL/C0/DEL/C1/双向控制符），**无百分号编码**——调用者须保证其为 URL 安全字符（真实 moltbook post-id 为 UUID、submolt 名为 `[a-z0-9_]`）；`--base-url` 同理原样拼接。std 无 URL 编码助手，登记语言候选（裁决前不实现）。
