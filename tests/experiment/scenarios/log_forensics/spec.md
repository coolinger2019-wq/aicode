# S1 日志取证流水线(spec,T3-pre)

> 状态:**spec 先行,不含实现**——plan §4.18.2 T3-pre 交付物;实现/fixture/verify 由
> T3-impl 批次承担(前置 = T2.3 生效,plan §4.18.2 T3-impl 行)。本 spec 审查通过前
> 不动工。对应 plan §4.15.4 T3-a 场景 1(日志/取证流水线)。
> 承诺面口径:验收只依赖 docs/stability-contract.md §2 P1–P8 已交付能力,不依赖
> §3 N1–N7(不断言性能/引擎归属——"必须走 wasm"即违规,契约 §5.6 口径)。

## 1. 场景目标(真实场景,非玩具)

安全事件响应(incident response)取证:分析师从一台疑似被入侵主机的应用日志中
提取安全事件(WARN/ERROR 与结构化 JSON 事件),生成**确定性结构化报告**留档。
日志内容不可信——攻击者可注入控制符(终端/报告注入)、超长行(解析器DoS)、
伪造格式(字段欺骗)。工具必须**把恶意行分类为具名拒绝项**计入报告,而不是
原样混入报告正文或崩溃。参数级错误(路径非法/文件不可读)与内容级恶意
(rejected 行)是两类不同失败:前者进程报错退出,后者是正常取证输出。

## 2. 程序形状与输入数据形态

### 2.1 调用形状(三语言一致)

```
prog <input.log> <report.txt>
```

- argv[1] = 事件日志路径(仓库根相对;UTF-8;`\n` 分行;文件末尾以 `\n` 结尾,
  末尾换行产生的空行不计行)。
- argv[2] = 报告输出路径(覆盖写)。
- stdout 只写摘要行;报告正文落盘 report.txt;诊断走 stderr 不参与验收。
- 被测程序以仓库根为工作目录(T1.2 提交物形态惯例)。

### 2.2 fixture 设计(由 T3-impl 建;规模给量级)

布局 `tests/experiment/scenarios/log_forensics/`:

```
input/main.log            唯一主输入(约 180–260 行,单行 ≤ 200 字符,除 overlong 样本)
expected/expected_stdout.txt   摘要行期望(逐字节)
expected/expected_report.txt   报告正文期望(逐字节;verify 读盘比对)
verify.{ming,js,py}       三语言黑盒验收(T3-impl;语义等价)
solutions/solution.{ming,ts,py}  参考实现(T3-impl)
```

main.log 构成(量级,最终计数以建成 fixture 为准,期望文件由参考实现产出后
人工复核——T1.1 语料惯例"三语言腿全绿 + 交叉喂入 FAIL"):

| 形态 | 量级 | 说明 |
|------|------|------|
| 文本行 INFO | ~100 | 合法,非事件 |
| 文本行 WARN / ERROR | ~35 / ~25 | 合法事件行 |
| 文本行 DEBUG | ~15 | 合法,非事件 |
| JSON 事件行 | ~25 | `{` 开头,含 level/actor/event 字段,四级混合 |
| 空行 | ~6 | skipped 计数 |
| 恶意行 ctrl-char | ~5 | 含 C0(如 `\x01\x07`)、C1(U+0085)、DEL(U+007F)、双向控制符(U+202E) |
| 恶意行 overlong | ~2 | >4096 字符(ASCII) |
| 恶意行 malformed | ~5 | 段数不足/级别拼缀(`INFOX`)/字段值越值域(如 actor 含 `..`) |

行格式(文本行):`<timestamp> <LEVEL> <actor> <event> <k=v>...`,单空格分隔;
`<LEVEL>` ∈ `INFO|WARN|ERROR|DEBUG`;`actor`/`event` 值域 `[A-Za-z0-9_.-]+`
(语料保证合法行满足)。JSON 行:紧凑对象,字段 `level`(四级别之一)/`actor`/
`event`(值域同上)必存在,其余字段不参与判定。时间戳格式不参与判定。

## 3. 被测程序职责(三语言 Ming/TypeScript/Python 同一语义)

行分类判定顺序(语言中立,逐行执行;`char_len` = 字符数,非字节数):

1. 空行(切行后为空)→ `skipped`(只计数,不产出报告行)。
2. 字符数 > 4096 → `rejected/overlong`。
3. 含控制符 → `rejected/ctrl-char`。控制符集合 = C0(0x00–0x1F,含 `\t`;
   `\n` 已被切行移除)、DEL(U+007F)、C1(U+0080–U+009F)、双向控制符
   (U+202A–U+202E)。
4. 以 `{` 开头 → JSON 行:`parse` 失败,或缺 `level`/`actor`/`event` 字段,
   或任一字段值越值域/`level` 越级别集 → `rejected/malformed`;否则按
   `level` 归类(事件 = WARN|ERROR,非事件 = INFO|DEBUG)。
5. 其余 → 文本行:单空格切分后段数 < 5,或第 2 段不整段等值于四级别之一,
   或第 3 段(actor)/第 4 段(event)越值域 → `rejected/malformed`;否则按
   `level` 归类(同上)。

Ming 侧污点工作流(spec 级约定,语义即上述判定):`fs.read_file` 返回
`Untrusted[str]` → `split("\n")` → 逐行**先过行级控制符闸**
(`std.unstr.sanitize_cli_path`,Err 即 ctrl-char)→ Ok 净串后再做格式/值域
判定与 JSON 解析(净域:`re.is_match`/`==`/`json.parse` 均净槽)。TS/Python
无污点系统,实现等价的行级校验函数(同一控制符集合/值域/长度阈值)——
三语言行为规则逐字一致,Ming 的闸门是编译期强制(P8),对照语言是手工约定。

## 4. 黑盒验收标准(对齐 tasks/<id> verify 惯例)

- **stdout**:恰好一行摘要,逐字节断言:
  `summary events=<n> rejected=<n> info=<n> skipped=<n> total=<n>`
  (events = WARN+ERROR 合法行数;rejected = 三类恶意合计;info = INFO+DEBUG
  合法行数 + JSON 非事件行;total = 总行数,不含末尾换行空行)。
- **report.txt**(verify 读盘逐字节比对):
  ```
  report <input名>
  E <lineno> <LEVEL> <actor> <event>
  (事件行按文件序,JSON 行与文本行同格式;字段值取判定提取值)
  R <lineno> <reason>
  (拒绝行按文件序,reason ∈ {overlong, ctrl-char, malformed})
  ```
  `<lineno>` 从 1 起(含空行计数——物理行号,取证可回溯定位)。
- **退出码**:0 = 成功(含 rejected > 0——内容级恶意是正常取证输出);
  1 = 参数级错误(argv 缺失/路径非法/文件不可读/输出路径不可写),stdout 空,
  stderr 一行以 `error:` 开头。
- **负例腿**(T3-impl):交叉喂入另一场景参考实现预期 FAIL;参数错误腿
  (缺参/不存在路径)预期 exit 1——沿用 T1.2-b 负例腿惯例。
- 验收粒度 = fixture 可观测行为逐字节一致,非全规格覆盖(设计 §8 缺口 8
  口径;边界语义如"恰 4096 字符行"不被 fixture 触达,T3 报告不得过度解读)。

## 5. 触达的 Ming 能力面

- 效果声明:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs`。
- 污点(P8):`fs.read_file` → `Untrusted[str]`(v0.77 源翻转);`split` keepVec;
  `std.unstr.sanitize_cli_path` 行级闸门(v0.61 + v0.64 DEL/C1/双向扩展);
  污值代数谓词 clean 面(`char_len`/`starts_with`/`is_empty`)。
- 净域面:`json.parse`(净串 → Json;投影 `get`/`as_str`——**JSON 行已在
  净域**,投影走净 Json 面)、`re.is_match`(净槽,值域判定)、`Vec.sort`
  (事件行按序输出时如需排序——本场景按文件序,不强需)。
- 出向:`write_file`(路径净槽,内容净——报告由净字段构造);`print`/`eprint`。
- 确定性(P7):输出全由输入决定;无时间/随机/哈希序依赖;`<input名>` 取
  argv 原样净化后的相对路径字面。

## 6. 与 T2.3 承诺面的依赖标注

- **不依赖未实现语言面——可先行实现的部分**:全部核心流程只依赖 v0.100
  HEAD 已交付并测试的能力(P1 语法类型/P2 效果/P3 内置签名/P7 确定性/
  P8 污点);`sanitize_cli_path` 的 DEL/C1/双向控制符拒绝(v0.64)已覆盖
  §3.3 控制符集合,无需新面。T2.2 冻结令已确认(2026-11-22),契约已生效
  ——本场景实现不触碰任何承诺面变更。
- **正则消费面净槽(P8 登记口径)已在设计内消化**:解析闸门在污/净边界
  一次完成,闸门后全部净域——不需要"污→正则"通道,不构成 gap。
- **依赖 T2.3 生效的部分**:实现批次本身(T3-impl 前置 = T2.3 生效)——
  流程门槛而非能力缺口。
- **已知能力面缺口(gap log 位,登记不实现——plan §4.15.6 场景不扩面)**:
  ①二进制日志(非 UTF-8 文本)不支持——`read_bytes` 载荷无字节→哈希/正则
  通道(crypto/re 消费面净槽),登记 gap;②超大行全量驻留内存(无流式行
  读取;`read_bytes_range` 分段可作后续扩展,登记 gap);③子目录递归扫描
  不做(list_dir 单层)。

## 7. 已知风险与 gap log 位

- **跨语言计数口径**:`char_len`(Ming,字符数)与 TS `[...s].length`/
  Python `len(s)` 均为码点口径——fixture 的 overlong 样本用 ASCII 消除
  代理对歧义;非 ASCII 行长度 ≤ 200 字符不触阈值。实现期若发现口径分歧,
  先写最小复现,登记 `docs/gap-log.md`(该文件由 T3-impl 建档,本场景为
  首个登记来源之一)。
- **`\t` 归类 ctrl-char 的严格口径**:本场景声明字段分隔为单空格,含 `\t`
  的行 = 恶意(ctrl-char)。TS/Python 校验函数必须复刻同一集合——审查时
  对照三语言控制符判定逐字一致。
- **JSON 行内真实控制符**:行级闸门先于 JSON 解析(注入防御优先)——
  JSON 字符串内的字面控制符(非 `\t` 转义)在行级即拒。fixture 保证合法
  JSON 行无真实控制符,转义序列(`\t` 两字符)不受影响。
- **win32 管道 CRLF**:fixture 统一 `\n`;verify 读盘按字节比对(三语言腿
  各写各读,无交叉污染——设计 §8 实测发现 4 口径)。
- **gap log 位**:`docs/gap-log.md`(T3-impl 建档);本场景预登记候选 =
  §6 三项缺口 + 实现期发现的任何口径分歧。
