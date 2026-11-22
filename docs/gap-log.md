# T3 场景试点总 gap log(docs)

> 覆盖 plan §4.15.4 T3-a 场景试点第一批(log_forensics / file_integrity)与
> T3 场景试点第 3 个(protocol_parser,2026-11-22)。
> 纪律:本页只登记不实现(plan §4.15.6 场景不扩面);spec 本体不改;逐场景明细见
> 各场景目录下 `gap-log.md`(逐条格式:spec 条目 / 实测行为 / 影响 / 建议)。
> 建档:T3-impl,2026-11-22;S3 追加:2026-11-22。

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

- **S3 追加(2026-11-22)**:protocol_parser 全部核心流程在承诺面既有能力内实现成功,
  零新增语言面;能力面探针先于 spec 冻结(三项结论塑形 spec:污字节值不可读/
  crc32 无内建/跨污界 `==` 拒绝,见 §2 G8–G10 与 GAP-S3-1/2/3)。三语言输出
  逐字节一致(3 verify 腿全 PASS,各含 4 正例逐字节 + 4 参数级 + 2 交叉喂入 +
  不 panic 专项);Fletcher-16 校验和由 Python 独立重算 16 帧全数吻合;
  fixture 重跑 sha256 逐字节不变;变异样本(BAD_MAGIC/BAD_HEX 互换)被
  verify 捕获(exit 1)——逐字节比对有齿。

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
| G8 | S3 protocol_parser | 污字节值消费通道缺失(`Untrusted[Vec[u8]]` 元素读 → M3020、字节→bin/crypto 消费面净槽 → M3049)——纯二进制帧捕获不可按值解析;场景以 hex 传输编码承载同一帧格式,Ming 从污行重建净帧字节后做字节序/校验和判定 | S3 spec §6 | 登记不实现 |
| G9 | S3 protocol_parser | crc32/adler32 无内建——Fletcher-16(mod 255)替代,gen 与三语言 solution 同一公式,Python 独立重算 16 帧全数吻合(初报误记 10;实数 = frames 8 + clean 6 + bad_utf8 2);校验强度弱于 crc32 | S3 spec §6 | 登记不实现 |
| G10 | S3 protocol_parser | `read_file` 无效 UTF-8 的 U+FFFD 替换语义属宿主(Node)继承,GUIDE §18 未声明(bad_utf8.bin 进解析路径非参数错误;Python errors="replace" 实测对齐)——文档诚实性候选 | S3 spec §6 | 已文档化(2026-11-22,GUIDE §18) |

## 3. 实现期发现(spec 文本歧义/覆盖注记,明细见场景 gap-log.md)

| # | 场景 | 摘要 | 明细 |
|---|------|------|------|
| I1 | S1 | malformed 示例"actor 含 `..`"与值域 `[A-Za-z0-9_.-]+` 冲突(`..` 在域内)——实现以规范值域为准,样本取 `../passwd` | scenarios/log_forensics/gap-log.md GAP-S1-1 |
| I2 | S1 | 报告 E/R 行"分组 vs 交错"未明说——实现按模板字面分组(E 块后 R 块),expected 逐字节锚定 | scenarios/log_forensics/gap-log.md GAP-S1-2 |
| I3 | S2 | "任一行 Err 即 REJECTED"字面与 `sanitize_cli_path` 非空要求冲突 → LF 文件全数 REJECTED,场景不可实现——实现将空行(不含控制符)直接过闸,与 spec 自身"尾空段参与重建"要求一致 | scenarios/file_integrity/gap-log.md GAP-S2-1 |
| I4 | S2 | gen/files 无控制符设计 → gen 侧 rejected>0 分支未被 fixture 触达(spec §4 非全规格覆盖条款允许;verify 腿已触达同源闸门) | scenarios/file_integrity/gap-log.md GAP-S2-2 |
| I5 | S2 | "重复名"清单损坏形态未被负例腿触达(实现面已正确:审查实测三语言一致 `error: 清单损坏: 重复名 …` exit 1;spec §4 负例清单未列,非全规格覆盖条款允许;all-OK 腿已随审查收口补入三份 verify) | scenarios/file_integrity/gap-log.md GAP-S2-3 |
| I6 | S3 | 计划原文"二进制帧 + read_bytes_range 分段"的兑现形态:探针三项结论(污字节值不可读 M3020/M3049、crc32 无内建、跨污界 `==` M3002)先于 spec 冻结塑形判据——帧以 hex 传输编码落盘,`read_bytes_range` 承载字节层(65536 门禁 + 4096 分段计数 = bytes 字段唯一来源),帧数据消费经 read_file 文本层;字节序/校验和/边界检查/不 panic 四项语义真实兑现,验收判据未放宽 | scenarios/protocol_parser/gap-log.md GAP-S3-1/2/3 |
| I7 | S3 | TS 位宽陷阱:JS `<<`/`\|` 为 32 位有符号,`0xff<<24` 变负 → 超大 length(ffffffff)误判 TRAILING;三语言逐字节比对立刻暴露,TS 改乘法合成(double 精确域覆盖 0xFFFFFFFF)后一致——位宽语义以 Ming i64/Python 大整数数学值为准 | scenarios/protocol_parser/gap-log.md GAP-S3-4 |
| I8 | S3 | Ming `&` 优先级低于 `==`(`f & 1 == 1` 解析为 `f & (1==1)` → M3008)——位判定需显式括号;标准 C 优先级非缺陷,登记为 AI 生成常见踩坑位 | scenarios/protocol_parser/gap-log.md 实现注记 |
| I9 | S3 protocol_parser | spec §2.1 行宽公式笔误(16+2·length,实为 20+2·length,与 §3 判定 7 一致)——纯文本瑕疵,三语言实现与 expected 全按正确值,无行为影响 | scenarios/protocol_parser/gap-log.md GAP-S3-8 |
| I10 | S3 protocol_parser | 空文件 read_bytes_range Err(start 超出文件大小)与 U+FFFD 替换语义为宿主继承口径(G10 同族);场景按状态行口径消费,未耦合消息文本 | scenarios/protocol_parser/gap-log.md GAP-S3-6 |

## 4. S4/S5 场景扩面(R-5,2026-11-22;明细见各场景 gap-log.md)

- **能力面核对结论(S4 agent_service / S5 release_bootstrap)**:两场景全部核心流程
  在 T2.3 承诺面(P1–P8)既有能力内实现成功,零新增语言面——S4:serve handler
  `Untrusted[Json]` 整树标污 → 投影表 + `sanitize_cli_path` 比较串位 + `json.parse`
  载体分派 + 工具结果全净值构造;S5:argv 路径位净化 → read_file 污值代数
  keep/clean 面 → 净 i64 三元组比较 → list_dir 条目净化 + 净 Vec 排序 → write_file
  出向透传。未遇到不可绕过的 M3049/M3050 拒绝。三语言(ming/ts/py)输出逐字节一致
  (S4:183 行 transcript 三腿 sha256 同值 cfb63412…;S5:六案例 stdout + notes 一致);
  fixture 重跑 sha 逐字节不变(S4+S5 共 33 文件)。
- **S4 追加(2026-11-22)**:R19 9MB 超大体客户端形态 = 头-only 声明尺寸请求
  (GAP-S4-1——全量体发送对 ming serve 早响应+destroy 为客户端可见竞态,Windows
  RST 丢缓冲响应实测 ~5%;头-only 20/20 干净 413;判定事实完整触达,判据零放宽);
  端口被占腿经 harness --occupy 三语言全实现(GAP-S4-2);错服务判定协议
  (连续 5 次 /health 非 200 → 立即失败)使交叉喂入腿 ~3s(GAP-S4-3);实现期
  环境地雷两则(Python latin-1 体编码 / ThreadingHTTPServer backlog=5)已内置
  (GAP-S4-4)。
- **S5 追加(2026-11-22)**:探针三项全按预设成立(em-dash 码点口径/guide_head
  ASCII `(` 经 spec 字节实测/notes 往返逐字节,GAP-S5-1);**发现 `Vec.sort()` 对
  空 Vec 以 M4001 panic("sort:元素不支持排序",tree/VM 双引擎一致——空容器排序
  数学 no-op 变 panic,实现以 len>0 守卫规避,src 域候选登记,GAP-S5-2)**;
  TS UTF-16 索引与 Ming 码点口径在 fixture 域(全 BMP)等价(GAP-S5-3);plan 原文
  忠实度按 spec §6 预登记落实(tag 存在性收窄/dist 冒烟降演练,GAP-S5-4)。

| # | 场景 | 摘要 | 明细 |
|---|------|------|------|
| I11 | S4 agent_service | R19 全量体发送 = 客户端可见竞态(spec 字面不可稳定冻结)——实现改头-only 声明尺寸请求(Content-Length 头承载 9437184,体字节不发送;体内容本就不参与判定),TS/Python 服务端用 spec §3.3 首选"前置检查"形态;transcript 行冻结 `R19 -> 413 code=body_too_large`,三语言一致(唯一判据)保持 | scenarios/agent_service/gap-log.md GAP-S4-1 |
| I12 | S4 agent_service | 端口被占腿构造定案:占用持有人 = harness --occupy 模式(ming 无端口持有面;js/py 原生),ming 绑定失败 = EADDRINUSE Err exit 1 stderr 一行 | scenarios/agent_service/gap-log.md GAP-S4-2 |
| I13 | S4 agent_service | 交叉喂入腿"错服务"判定:连续 5 次 /health HTTP 非 200 → 立即失败(冷启动连接拒绝不计),执行时间 150s→3s,腿语义不变 | scenarios/agent_service/gap-log.md GAP-S4-3 |
| I14 | S4 agent_service | 环境地雷两则(Python http.client str 体 latin-1 编码与 UTF-8 Content-Length 失配→服务端读挂;ThreadingHTTPServer request_queue_size=5 在 8 客户端并发下溢出 ECONNREFUSED)——实现内置(requests 显式 utf-8 字节/Server 子类 backlog 64) | scenarios/agent_service/gap-log.md GAP-S4-4 |
| I15 | S5 release_bootstrap | `Vec.sort()` 空 Vec M4001 panic("sort:元素不支持排序",tree/VM 双引擎一致;元素类型分派按首元素判型)——实现以 len>0 守卫规避,判据零变化;src 域候选登记(空容器 sort 应为 no-op) | scenarios/release_bootstrap/gap-log.md GAP-S5-2 |
| I16 | S5 release_bootstrap | 探针定案:em-dash `index_of` 码点口径 + guide_head 括号经 spec 行 75 字节实测为 ASCII `(` + notes 中文/尾\n 写读往返逐字节——全按 spec 预设,零判据调整 | scenarios/release_bootstrap/gap-log.md GAP-S5-1 |
| I17 | S5 release_bootstrap | spec §3.4"单个 \n 结尾"字面与 §3.2/§3.4 条目体逐字(含第二条目前空段)不可同时成立——expected_notes_ok.md 实测 143B、\n\n 结尾(od 实测);实现取条目体侧(逐字写盘为核心语义),歧义随 spec 修订窗口校正 | scenarios/release_bootstrap/gap-log.md GAP-S5-5(审查 MINOR-1) |
| I18 | S4/S5 | 独立审查 MINOR-2/3 收口:六份 verify 参数级腿补"stderr 恰一行"断言(split 段数==2 / \n 计数==1,零假红);交叉喂入负例腿收紧为具体 FAIL 形态(S4=harness exit 3 错服务 / S5=S2 exit 1+error: 行),排除 no-start 静默通过;harness fixture 读取移入 try/finally(异常不泄漏 child) | scenarios/agent_service/gap-log.md GAP-S4-5 |
