# S3 协议解析器 — 实现期 gap log(T3 场景试点,2026-11-22)

> 逐条格式:spec 条目 / 实测行为 / 影响 / 建议。spec 本体不改。
> 能力面核对结论:本场景全部核心流程在 T2.3 承诺面(P1–P8)既有能力内实现成功,
> 零新增语言面;能力面探针(.zcode/exp-s3-probe,已清理)先于 spec 冻结完成,
> ①污字节值不可读、②crc32 无内建、③跨污界 == 拒绝三项探针结论直接塑形了
> spec 判据(GAP-S3-1/2/3),实现期未遇到 spec 不可实现条款。

## GAP-S3-1 "二进制帧 + read_bytes_range 分段"的兑现形态(污字节值不可读)

- **spec 条目**:plan §4.15.3 T3 场景清单 #2 原文"二进制帧(显式字节序/校验和/
  边界检查);`read_bytes_range` 分段";spec §2.1 传输编码声明、§6 忠实度标注。
- **实测行为**:探针实测 `fs.read_bytes_range`/`read_bytes` 返回的
  `Untrusted[Vec[u8]]` 字节值在语言内不可读——操作面仅 `len`/`is_empty`
  (GUIDE §18 第三载体白名单),下标读 → M3020 "Untrusted[Vec[u8]] 不支持下标
  索引",bin/crypto/re 消费面 → M3049,`to_str` 不在白名单 → M3050。纯二进制
  帧数据在 Ming 内无法按值解析(v0.77 ADR-007 设计决定:无字节洗白旁路)。
- **影响**:帧捕获文件以 **hex 传输编码**落盘(逐帧一行、小写 hex、与 hexdump/
  包捕获文本化同型);Ming 解析器从污行经污值代数(slice_chars/starts_with
  查表)重建净帧字节后,再做显式大端组装与 Fletcher-16 判定——字节序/校验和/
  边界检查语义真实存在;`read_bytes_range` 在 Ming 侧承载**字节层**(65536
  大小门禁 + 4096 分段循环计数,`bytes=` 汇总字段的唯一来源),不承载帧数据
  消费。spec §4 验收判据未放宽(逐字节断言不变)。
- **建议**:冻结期后若引入污字节值消费通道(`Untrusted[Vec[u8]]` 元素读或
  字节→bin 净槽),本场景可升级为纯二进制捕获;登记 docs/gap-log.md 总表。

## GAP-S3-2 crc32 无内建 → Fletcher-16 替代

- **spec 条目**:任务预案"crc32 若 Ming 无内建,改用可实现的校验";spec §2.1。
- **实测行为**:Ming std.crypto 无 crc32(GUIDE §18 哈希五件套 + HMAC + AES);
  场景采用 Fletcher-16(sum1/sum2 mod 255,存储 = sum2<<8|sum1 大端,覆盖域 =
  type||flags||length||payload)——纯 i64 算术 + `%` 可实现,探针验证通过。
- **影响**:gen_fixtures 与三语言 solution 共用同一公式;16 帧校验和由 Python
  独立重算全数吻合(审查复核同值;初报误记 10,实数 = frames 8 + clean 6 + bad_utf8 2)(交叉验证 PASS);校验强度弱于 crc32,对本场景的"损坏检测"
  目标足够(fixture 的 2 个 CRC_MISMATCH 样本均被捕获)。
- **建议**:若未来需要 crc32,登记为 std.crypto/std.bin 扩面候选(冻结期不做)。

## GAP-S3-3 跨污界等值比较被拒(== → M3002)→ starts_with 查表解码

- **spec 条目**:spec §3 Ming 侧污点工作流(单字符 hex 解码 = starts_with 16 查表)。
- **实测行为**:探针实测 `Untrusted[str] == str 字面量` → M3002 "两侧类型不同"
  (isComparable 恒等载体;污/净混比不放行);clean 谓词(starts_with/char_len/
  byte_len/contains)对污接收者合法。单字符解码以 16 路 starts_with 查表实现,
  语义与等值比较一致(单字符切片)。
- **影响**:无——三语言判定逐字一致;污值代数的等值白名单缺口已登记
  (若 `==` 对污串开放,查表可简化;冻结期不做)。
- **建议**:登记为污值代数候选扩面(等值比较 clean 化),冻结期后评估。

## GAP-S3-4 TS 位宽陷阱:JS `<<`/`|` 为 32 位有符号,长度组装变负

- **spec 条目**:spec §3 判定 6(length 大端组装 b0<<24|b1<<16|b2<<8|b3,
  值 > 4096 → BAD_LENGTH)。
- **实测行为**:TS 首版按位组装,`0xff << 24 | …` 在 JS 中经 32 位有符号 OR
  变负(-16777216+),length > 4096 判定被绕过 → 超大 length 样本(frames 行 10,
  ffffffff)误判 TRAILING;三语言逐字节比对立刻暴露(Ming i64/Python 大整数
  为数学值,BAD_LENGTH 正确)。
- **影响**:无(spec 公式语义 = 数学值,Ming 为参考实现);TS 修复为乘法合成
  `b0*16777216 + b1*65536 + b2*256 + b3`(double 精确域 ≤2^53 覆盖 0xFFFFFFFF),
  修复后三语言逐字节一致。
- **建议**:无(spec 不改;此为实现期跨语言口径注记——位宽语义以 Ming 为准)。

## GAP-S3-5 read_file 无效 UTF-8 = U+FFFD 替换(非 Err)→ bad_utf8 进解析路径

- **spec 条目**:spec §2.2 处理管线第 2 步(无效字节 → U+FFFD,每无效字节一个
  替换符);§4 正例腿 4。
- **实测行为**:探针实测 Ming `fs.read_file` = Node `readFileSync(path,'utf8')`
  同源替换(13 字节含 ff/fe → 9 码点,2 个 U+FFFD),**不返回 Err**;Python
  `errors="replace"` 对单字节无效序列逐字节一个替换符,实测与 Node 一致;
  TS 同 Node 运行时。bad_utf8.bin 因此进解析路径(中行 → BAD_HEX),而非
  参数级错误。
- **影响**:无——三语言逐字节一致(fixture 限定单字节无效形态,多字节序列的
  替换计数不在触达面,spec §4 粒度条款)。
- **建议**:无(GUIDE §18 read_file 未声明替换语义,属宿主继承——登记为文档
  诚实性候选,冻结期不改)。

## GAP-S3-6 metadata size 为 f64;read_bytes_range 空文件 start=0 → Err

- **spec 条目**:spec §3 Ming 侧污点工作流(字节层)。
- **实测行为**:探针实测 `metadata.get("size").as_num()` 返回 Option[f64]
  (24.0),需 `as i64` 取整;`read_bytes_range(path, 0, n)` 对 0 字节文件 →
  Err "start 超出文件大小: 0 >= 0"(start >= size 校验先于触盘)。实现按
  "先取 size 再循环(size=0 跳过循环)"规避,不对 Err 消息做文本耦合。
- **影响**:无——empty.hex 腿(exit 0,bytes=0)三语言逐字节一致。
- **建议**:无。

## GAP-S3-7 非触达边界登记(验收粒度条款)

- **spec 条目**:spec §4 验收粒度(非全规格覆盖)。
- **实测行为/影响**:以下边界被 spec 判据定义但 fixture 未构造,报告不得宣称
  已覆盖:size 恰 = 65536 的门禁边界;length 恰 = 4096 的合法上界;flags 保留位
  (≥0x04)渲染规则("忽略未名位"为完备性声明);CR 行尾(会落 BAD_HEX,可
  解释但未锚定);多字节无效 UTF-8 序列的替换计数。
- **建议**:后续扩展语料时按需补样(不改判据)。

## 实现注记(非 gap)

- Ming 运算符优先级:`&` 低于 `==`(`f & 1 == 1` 解析为 `f & (1==1)` →
  M3008),位判定需显式括号 `(f & 1) == 1`——标准 C 优先级,非缺陷。
- gen_fixtures 用 std.bin.pack_u32_be/pack_u16_be 生成 length/checksum 字段
  (探针验证 pack 值域超限 panic / unpack 越界 Err 化),solution 走手工组装
  保持单文件控制流——两路径同公式,Python 独立重算锁定。
- verify 三语言各含 11 组断言(4 正例逐字节 + 4 参数级 + 2 交叉喂入 + 1 不
  panic 专项 sweep);反向自检:喂入 S1 参考实现 → FAIL exit 1;变异样本
  (BAD_MAGIC/BAD_HEX 状态名互换)→ stdout mismatch exit 1——逐字节比对
  有齿。

## GAP-S3-8 spec §2.1 行宽公式笔误(文本瑕疵登记,判据与实现不受影响)

- **spec 条目**:spec §2.1"行字符数 = 16 + 2·length(……)"。
- **实测行为**:括号分解实际总和为 **20 + 2·length**(magic 4 + type 2 + flags 2 +
  length 8 + payload 2·length + checksum 4),与 §3 判定 7 的 `clen == 20+2·length`
  一致;实测行 1(len=11)行宽 42 = 20+22。三语言 solution 与 expected 全按
  正确的 20+2·length 实现,无任何行为影响。
- **影响**:纯 spec 文本笔误;spec 已冻结,按语料纪律不改判据文本,登记留痕
  (独立审查 MINOR-1 指认)。
- **建议**:冻结期后如修订 spec 文本,改公式为 20 + 2·length。
