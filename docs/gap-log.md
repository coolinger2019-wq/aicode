# T3 场景试点总 gap log(docs)

> 覆盖 plan §4.15.4 T3-a 场景试点第一批(log_forensics / file_integrity)。
> 纪律:本页只登记不实现(plan §4.15.6 场景不扩面);spec 本体不改;逐场景明细见
> 各场景目录下 `gap-log.md`(逐条格式:spec 条目 / 实测行为 / 影响 / 建议)。
> 建档:T3-impl,2026-11-22。

## 1. 能力面核对结论(T3-impl 实现期)

- 两场景全部核心流程在 T2.3 承诺面(§2 P1–P8)既有能力内实现成功,**零新增语言面**:
  行级 `std.unstr.sanitize_cli_path` 控制符闸(v0.61 + v0.64 DEL/C1/双向扩展)、净域
  `re.is_match`/`==`/`json.parse`(S1)、`list_dir` 条目标污 → 净化 → 净 `Vec[str].sort`
  字节序、净行重建 → `std.crypto.hmac_sha256` 净槽(S2)。
- 未遇到不可绕过的 M3049/M3050 拒绝;spec 设计的净化路径(污/净边界一次过闸、
  闸后全净域)全部走通。
- 跨语言等价:三语言(ming/ts/py) solutions 输出逐字节一致(两场景 6 verify 腿全绿);
  `hmac_sha256` 与 TS `node:crypto.createHmac`、Python `hashlib+hmac` 同值(28 文件
  HMAC 由 Python 独立重算全数吻合,含非 ASCII 内容行)。

## 2. spec 预登记能力面缺口(登记不实现)

| # | 场景 | 缺口 | 出处 | 状态 |
|---|------|------|------|------|
| G1 | S1 log_forensics | 二进制日志(非 UTF-8 文本)不支持——`read_bytes` 载荷无字节→哈希/正则通道(crypto/re 消费面净槽) | S1 spec §6 | 登记不实现 |
| G2 | S1 log_forensics | 超大行全量驻留内存(无流式行读取;`read_bytes_range` 分段可作后续扩展) | S1 spec §6 | 登记不实现 |
| G3 | S1 log_forensics | 子目录递归扫描不做(`list_dir` 单层) | S1 spec §6 | 登记不实现 |
| G4 | S2 file_integrity | AES-GCM 加密清单不纳入 v1(`aes256_gcm_encrypt` 随机 96-bit nonce → 加密产物逐 run 不同,验收只能结构断言;v1 走 HMAC 明文清单) | S2 spec §6 | 登记不实现 |
| G5 | S2 file_integrity | 二进制文件完整性不支持(`read_bytes` → `Untrusted[Vec[u8]]` 无字节→HMAC 通道;场景限定文本文件集) | S2 spec §6 | 登记不实现 |
| G6 | S2 file_integrity | 子目录递归(`list_dir` 单层)与大量文件(>1000)分批扫描为扩展位 | S2 spec §6 | 登记不实现 |
| G7 | S2 file_integrity | 清单对抗边界:攻击者持 key 同时改文件并伪造清单行不在防护目标内(持有 key 即维护者信任域);fixture 不构造此形态 | S2 spec §7 | 登记不实现(报告不得宣称"防任意清单伪造") |

## 3. 实现期发现(spec 文本歧义/覆盖注记,明细见场景 gap-log.md)

| # | 场景 | 摘要 | 明细 |
|---|------|------|------|
| I1 | S1 | malformed 示例"actor 含 `..`"与值域 `[A-Za-z0-9_.-]+` 冲突(`..` 在域内)——实现以规范值域为准,样本取 `../passwd` | scenarios/log_forensics/gap-log.md GAP-S1-1 |
| I2 | S1 | 报告 E/R 行"分组 vs 交错"未明说——实现按模板字面分组(E 块后 R 块),expected 逐字节锚定 | scenarios/log_forensics/gap-log.md GAP-S1-2 |
| I3 | S2 | "任一行 Err 即 REJECTED"字面与 `sanitize_cli_path` 非空要求冲突 → LF 文件全数 REJECTED,场景不可实现——实现将空行(不含控制符)直接过闸,与 spec 自身"尾空段参与重建"要求一致 | scenarios/file_integrity/gap-log.md GAP-S2-1 |
| I4 | S2 | gen/files 无控制符设计 → gen 侧 rejected>0 分支未被 fixture 触达(spec §4 非全规格覆盖条款允许;verify 腿已触达同源闸门) | scenarios/file_integrity/gap-log.md GAP-S2-2 |
| I5 | S2 | "重复名"清单损坏形态未被负例腿触达(实现面已正确:审查实测三语言一致 `error: 清单损坏: 重复名 …` exit 1;spec §4 负例清单未列,非全规格覆盖条款允许;all-OK 腿已随审查收口补入三份 verify) | scenarios/file_integrity/gap-log.md GAP-S2-3 |
