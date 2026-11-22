# S2 文件完整性 — 实现期 gap log(T3-impl,2026-11-22)

> 逐条格式:spec 条目 / 实测行为 / 影响 / 建议。spec 本体不改(仅头注下方加实现登记行)。
> 能力面核对结论:本场景全部核心流程在 T2.3 承诺面(P1–P8)既有能力内实现成功
> (`list_dir` 条目标污 → `sanitize_cli_path` 净化 → 净 Vec 排序;`read_file` →
> 切行逐行闸 → 净行重建 → `hmac_sha256` 净槽),未遇到不可绕过的 M3049/M3050 拒绝。

## GAP-S2-1 空行过闸与 sanitize_cli_path 非空要求的冲突(spec 字面不可实现)

- **spec 条目**:§3 "文件内容 `fs.read_file` → 切行后逐行过 `sanitize_cli_path`
  闸门……任一行 Err 即 REJECTED",并要求"闸门通过后以净行重建净内容
  (`cleanLines.join("\n")`——split 保留尾部空段,对 LF 文件重建无损)"。
- **实测行为**:`sanitize_cli_path` 的文档化语义含**非空要求**(空串 → Err,
  GUIDE §18)。字面组合下:任何以 `\n` 结尾的文本文件切行后的尾空段(以及合法空行)
  都会 Err → 全数 REJECTED——场景不可实现;且与同节"尾部空段必须参与重建、对 LF
  文件无损"的要求自相矛盾(尾空段必须进 cleanLines)。实现将**空行视为不含控制符**
  直接过闸(净域空串字面进入 cleanLines),仅非空行过 `sanitize_cli_path`;三语言
  同口径,28 文件逐字节一致。
- **影响**:判定唯一——REJECTED 仅由真实控制符触发,与 spec §3 步骤 3"存在但含
  控制符 → REJECTED"一致;不放宽任何验收(expected 逐字节锚定)。
- **建议**:spec 后续修订时补一句"空行不含控制符,直接过闸(净化器对空串判 Err
  属非空要求,非控制符判定)"。

## GAP-S2-2 gen/files 无控制符设计 → gen 侧 rejected>0 分支未被 fixture 触达(信息性)

- **spec 条目**:§2.2 定义 `input/gen/files/` 为"文本内容 UTF-8、LF 行尾、无控制符
  ——"原始"文件"。
- **实测行为**:gen 腿 stdout = `manifest 28 files rejected=0`;gen 的 rejected>0
  分支(跳过控制符文件、不产出清单行)未被 fixture 触达(该闸门与 verify 腿
  REJECTED 同源,verify 腿已触达控制符路径)。
- **影响**:行为契约"退出码 0(含 rejected > 0)"未被黑盒验收断言——spec §4
  "验收粒度 = fixture 可观测行为逐字节一致,非全规格覆盖"明确允许此粒度。
- **建议**:维持现状;如需触达须向 gen/files 加控制符样本(连带改变 manifest
  期望,属 spec 变更,不在本批)。

## GAP-S2-3 清单"重复名"损坏形态未被负例腿触达(登记,2026-11-22 审查 NOTE-6)

- **spec 条目**:§3 verify 步骤 1 将"重复名"列为结构性损坏(→ 参数级错误 exit 1);
  §4 负例腿清单("缺参/key 越值域/dir 不存在/清单行被改动")未列重复名,fixture
  亦未构造该形态。
- **实测行为**:实现已正确实现——独立实测三语言一致:含重复名清单 → `error: 清单损坏:
  重复名 alpha_report.txt`,exit 1,stdout 空(ming/ts/py 逐字同口径;2026-11-22
  独立审查同结论)。
- **影响**:该损坏形态的行为未被黑盒验收断言——spec §4"验收粒度 = fixture 可观测
  行为逐字节一致,非全规格覆盖"条款允许。
- **建议**:维持现状(实现面已正确);如需触达可在后续批次向 S2 verify 加重复名
  清单负例腿(纯 verify 侧变更,不动 fixture)。
