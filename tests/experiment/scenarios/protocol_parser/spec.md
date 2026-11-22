# S3 协议解析器(spec,T3 场景试点)

> 状态:**spec 冻结,实现按本判据执行**——对应 plan §4.15.3 T3 场景清单 #2
> ("二进制帧(显式字节序/校验和/边界检查);`read_bytes_range` 分段;任意输入
> 不 panic(Err 化)")。T2.2 冻结令已确认(2026-11-22):本场景全部设计在现有
> 能力面内,零新增语言面;能力面探针(.zcode/exp-s3-probe,2026-11-22)结论
> 已内化进判据,探针不复现的形态一律不进入 fixture。
> 承诺面口径:验收只依赖 docs/stability-contract.md §2 P1–P8 已交付能力,不依赖
> §3 N1–N7(不断言性能/引擎归属——"必须走 wasm"即违规,契约 §5.6 口径)。

## 1. 场景目标(真实场景,非玩具)

遥测/代理协议的帧扫描器(frame scanner):运维侧对一个"帧捕获文件"做验收
扫描——逐帧解出头部字段(类型/标志位/载荷长度)、校验完整性校验和、按帧
具名报出损坏形态(坏 magic/坏编码/类型未知/长度越界/截断/尾部多余/校验和
不符)。捕获文件内容不可信:超大 length 声明是经典的"宣告再分配"DoS 面,
必须先过大小门禁再进解析;非 UTF-8 字节流是真实采集管道的常态,必须以
替换解码进入分类而不是崩溃。参数级错误(缺参/路径非法/输入超门禁/输入是
目录)与内容级损坏(坏帧)是两类失败:前者进程报错退出,后者是正常扫描
输出(逐帧状态行 + 非零退出码)。**硬验收:任意输入不 panic**——所有畸形
输入都走结构化 stdout 状态或参数级 error,绝无引擎 panic。

## 2. 程序形状与输入数据形态

### 2.1 帧格式(MGTP,固定;字节级定义)

```
偏移   字段       宽度   说明
0     magic     2B    0x4D 0x47("MG")
2     type      1B    0x01=DATA / 0x02=CTRL / 0x03=KEEPALIVE
3     flags     1B    bit0 0x01=ACK_REQ,bit1 0x02=FRAG;其余位保留(值不限)
4     length    4B    payload 字节数,大端(b0<<24 | b1<<16 | b2<<8 | b3)
8     payload   len B 任意字节
8+len checksum  2B    Fletcher-16,大端(sum2<<8 | sum1),覆盖范围 =
                      type||flags||length(4B)||payload(不含 magic 与 checksum 自身)
```

- 帧总长 = 8 + length 字节。MAX_PAYLOAD = 4096(length 合法值域 [0, 4096],
  0 = 空 payload 合法)。 Fletcher-16 定义:sum1 = (sum1 + b) mod 255,
  sum2 = (sum2 + sum1) mod 255,初值均 0,b 按覆盖范围字节序遍历。
- **传输编码(fixture 文件形态)**:每帧一行,帧字节按序转两位**小写 hex**;
  行字符数 = 16 + 2·length(magic 4 + type 2 + flags 2 + length 8 + payload
  2·length + checksum 4);行尾 LF,文件以 LF 结尾。规划背景如实声明:Ming
  探针实测 `read_bytes_range`/`read_bytes` 返回的 `Untrusted[Vec[u8]]` 字节值
  在语言内不可读(操作面仅 len/is_empty,下标 M3020/消费面 M3049,见 §6),
  故捕获文件以 hex 传输编码落盘(与 hexdump/包捕获文本化同型),帧格式本身
  仍是上述字节级定义;三语言解析器从 hex 行重建帧字节后再做字节序/校验和
  判定——显式字节序与校验和语义真实存在,不因传输编码而退化。

### 2.2 调用形状(三语言一致)

```
prog <capture 文件>
```

- argv[1] = 捕获文件路径(仓库根为工作目录);stdout 只写状态/汇总行;
  诊断走 stderr 不参与验收(参数级 error 行除外,见 §4)。
- **处理管线(语言中立,顺序固定)**:
  1. 字节层(先于一切解析):取文件元数据得字节大小 size;`size > 65536`
     → 参数级错误(大小门禁——"宣告再分配"防线,超大输入绝不进解析)。
     然后以 **4096 字节分段**从 0 读到 size(`read_bytes_range` 循环;短读
     合法),分段合计必须 = size,作为 stdout `bytes=` 字段的唯一来源。
  2. 解析层:整读文件为文本(UTF-8;**无效字节 → U+FFFD 替换,每无效字节
     一个替换符**——Ming/Node 同源语义,Python 必须 `errors="replace"`,
     探针实测三语言逐字对齐);按 `\n` 切行,末尾换行产生的空段不计行
     (S1 口径);逐行独立判定(§3),互不牵引。
- 参数级错误(argv 缺失/路径非法/元数据不可读/输入非普通文件/size 超门禁/
  分段读 Err/整读 Err):stdout 空,stderr 恰一行以 `error:` 开头,exit 1。

### 2.3 fixture 设计(由 gen_fixtures.ming 确定性生成;重跑逐字节不变)

布局 `tests/experiment/scenarios/protocol_parser/`:

```
input/frames.hex      主输入:22 行(合法 8 帧 + 空行 2 + 畸形 12,畸形形态
                      每种 ≥1;行序合法/畸形交错),预期 exit 1
input/clean.hex       6 合法帧(类型/标志/长度 0 边界混合),预期 exit 0
input/empty.hex       0 字节,预期 exit 0(lines=0)
input/bad_utf8.bin    3 合法帧行,中行 payload hex 内嵌无效字节(\xff\xfe 替换
                      两个 hex 字符,行宽不变)→ U+FFFD → BAD_HEX,预期 exit 1
input/oversize.hex    65537 字节(= 门禁 +1,内容为合法帧行重复+余量,门禁先于
                      解析,内容不参与判定),预期参数级 error exit 1
expected/expected_{frames,clean,empty,badutf8}_stdout.txt  逐字节期望
                      (由参考实现产出,三语言腿全绿 + 交叉喂入 FAIL 后入库)
verify.{ming,js,py}   三语言黑盒验收(语义等价)
solutions/solution.{ming,ts,py}  参考实现
```

frames.hex 行形态清单(判定序 = §3 首条命中即停;行号从 1 起,含空行):

| 行号 | 形态 | 预期状态 |
|------|------|----------|
| 1/2/3/4/7/16/18/21 | 合法帧(DATA/CTRL/KEEPALIVE × flags 00/01/02/03 × len 11/5/11/0/64/1/1/0,含空 payload 与 64B 确定性 pattern) | OK |
| 5/11 | 空行 | blank(计数) |
| 6 | magic = "4e47"(其余合法) | BAD_MAGIC |
| 8 | payload hex 含 'g' | BAD_HEX |
| 9 | type = 04 | BAD_TYPE |
| 10 | length = ffffffff(超大 length 声明) | BAD_LENGTH |
| 12 | 6 字符残行("4d4701") | TRUNCATED |
| 13 | 头完整 + payload 缺 5 字符 + 无 checksum | TRUNCATED |
| 14 | 合法帧 + 尾部多余 hex("dead") | TRAILING |
| 15 | 合法帧 checksum 字段 +1 | CRC_MISMATCH |
| 17 | magic = "mg47"(非 hex 字符;钉死 magic 先于 hex 扫描) | BAD_MAGIC |
| 19 | length = 00001001(4097 > 4096) | BAD_LENGTH |
| 20 | 恰 16 字符(头完整,声明 len=2) | TRUNCATED |
| 22 | 合法帧 checksum 字段全零 | CRC_MISMATCH |

计数锚(实现与期望必须一致):lines=22 ok=8 bad=12 blank=2。

## 3. 被测程序职责(三语言 Ming/TypeScript/Python 同一语义)

**逐行判定(语言中立;`clen` = 行字符数 = 码点数,切片/下标均码点索引;
首条命中即停,判毕该行不再回看)**:

1. clen == 0 → blank(只计数,不产出状态行)。
2. clen < 16 → `TRUNCATED`(头不完整)。
3. 行首 4 字符 ≠ "4d47" → `BAD_MAGIC`(先于 hex 扫描——非 hex 的坏 magic
   归 BAD_MAGIC,fixture 行 17 钉死该顺序)。
4. 自第 4 字符起(含 payload 与 checksum 区)存在非 `[0-9a-f]` 字符(首个
   即停)→ `BAD_HEX`。
5. type 字节(行 [4,6) 两位 hex 解码)∉ {1,2,3} → `BAD_TYPE`。
6. length 字节(行 [8,16) 八位 hex 解码,大端组装
   b0<<24|b1<<16|b2<<8|b3)> 4096 → `BAD_LENGTH`。
7. clen < 20+2·length → `TRUNCATED`(payload/checksum 区缺字);
   clen > 20+2·length → `TRAILING`(声明帧后有多余字符)。
8. checksum(行 [16+2·length, +4) 两位 hex 大端解码)≠ 重算 Fletcher-16
   (覆盖 §2.1 定义域,输入为**重建的帧字节序列**)→ `CRC_MISMATCH`。
9. 否则 `OK`。

**输出(stdout,逐字节)**:

- OK 行:`frame <lineno> OK type=<DATA|CTRL|KEEPALIVE> flags=<BITS> len=<length 十进制>`;
  `<BITS>` 渲染 = 有名位按位序(ACK_REQ=bit0,FRAG=bit1)逗号连接,无有名位
  → `none`(保留位 ≥0x04 忽略——fixture 不构造,规则为完备性声明)。
- 非 OK 行:`frame <lineno> <STATUS>`(状态字面量 ∈ BAD_MAGIC/BAD_HEX/
  BAD_TYPE/BAD_LENGTH/TRUNCATED/TRAILING/CRC_MISMATCH)。
- 末行(恰一行):`summary lines=<L> ok=<a> bad=<b> blank=<c> bytes=<n>`;
  L = 物理行数(末尾换行空段不计),bad = 非空非 OK 行合计,bytes = 字节层
  分段合计(= 文件字节大小)。
- **退出码**:bad > 0 → 1;否则 0(内容级损坏是正常扫描输出,与 S2"发现
  篡改即 exit 1"同口径;参数级错误恒 exit 1 且 stdout 空)。
- `<lineno>` 从 1 起(含空行计数——物理行号,可回溯定位)。

**Ming 侧污点工作流(语义即上述判定;TS/Python 无污点系统,实现等价
判定函数,三语言行为规则逐字一致)**:

- argv 污点(v0.82):`sanitize_cli_path` 净化路径(Err → 参数级错误)。
- 字节层:`fs.metadata` → `Untrusted[Json]` → `get("is_file").as_bool()` 与
  `get("size").as_num()`(→ Option[f64],`as i64` 取整);`fs.read_bytes_range`
  4096 分段循环(Ok 段 `len()` 累加——第三载体操作面仅 len/is_empty,恰好
  覆盖"计数"语义;Err → 参数级错误)。
- 解析层:`fs.read_file` → `Untrusted[str]`(v0.77 源翻转)→ `split("\n")`
  (keepVec)→ 逐行 `char_len`(clean)定长检查 → `slice_chars`(keep)切
  字段 → **单字符 hex 解码 = starts_with 16 查表**(clean 谓词;`==` 跨污界
  → M3002,探针实测,故不用等值比较)→ 解码得净 i64 后进入净域:大端组装
  (`<<`/`|`,checked)与 Fletcher-16 累加(`%`)全在净 i64 域,帧字节以
  `(hi<<4|lo) as u8` 重建进净 `Vec[u8]`(校验和覆盖域)。
- 出向:`print`(净 str 由净 i64/净字面量构造);`eprint` 参数级 error。

## 4. 黑盒验收标准(对齐 scenarios/<name> verify 惯例)

- **正例腿(逐字节)**:
  1. frames.hex → stdout = expected_frames_stdout.txt(22 状态/空行省略 +
     summary),exit 1。
  2. clean.hex → expected_clean_stdout.txt,exit 0。
  3. empty.hex → expected_empty_stdout.txt(`summary lines=0 ok=0 bad=0
     blank=0 bytes=0`),exit 0。
  4. bad_utf8.bin → expected_badutf8_stdout.txt,exit 1。
- **参数级腿**(各:exit 1、stdout 空、stderr 恰以 `error:` 开头):
  5. oversize.hex(65537 > 65536 门禁)。
  6. 缺参(无 argv[1])。
  7. 路径不存在。
  8. 输入为目录(scenarios/protocol_parser/input)。
- **负例腿**:交叉喂入 S1/S2 参考实现(frames.hex 作输入)——不得产出
  expected_frames_stdout.txt(S1/S2 同款口径:实现"以期望输出成功"即 FAIL)。
- **不 panic 专项(硬验收)**:对 input/ 全部 5 个文件跑被测程序,断言
  stderr 不含引擎 panic 标记(`panic`/`内部错误`/`RangeError`/`TypeError`/
  `Traceback`);三份 verify 各自覆盖(每语言腿内自检)。
- **验收粒度 = fixture 可观测行为逐字节一致,非全规格覆盖**(设计 §8 缺口 8
  口径)。已知非触达边界,报告不得过度解读:size 恰 = 65536 的门禁边界;
  length 恰 = 4096 的合法上界;flags 保留位(≥0x04)渲染;非 LF 行尾(CR);
  多字节无效 UTF-8 序列的替换计数(fixture 只用单字节无效 ff/fe)。

## 5. 触达的 Ming 能力面(探针实测锚定,2026-11-22)

- 效果声明:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs`。
- 污点(P8):argv(v0.82)+ `sanitize_cli_path`;`read_file` → `Untrusted[str]`
  (v0.77 源翻转);污值代数 clean 谓词(char_len/byte_len/starts_with)+
  keep 面(split keepVec/slice_chars keep);第三载体计数面(`read_bytes_range`
  → `Untrusted[Vec[u8]]`.`len()`,v0.77/v0.86);**跨污界 `==` 不可用(M3002)
  ——字段解码用 starts_with 查表,探针实测**。
- 字节层:`fs.metadata` → `Untrusted[Json]`(v0.82)投影 `get`/`as_num`/
  `as_bool`(净值);`fs.read_bytes_range`(v0.86 S1)分段循环:短读合法、
  `start >= size` Err、`len=0` 短路不触探——本场景只用正参分段。
- 净域面:i64 checked 位运算(`<<`/`|`/`&`)+ `%`;窄型 `as u8` 位截断;
  净 `Vec[u8]` 构建;大端手工组装(b0<<24|…);Fletcher-16 手工累加。
  std.bin pack/unpack(探针验证可用含 Err 化越界)由 **gen_fixtures** 使用
  (pack_u32_be/pack_u16_be 生成 length/checksum 字段),solution 走手工组装。
- 出向:`print`/`eprint`(净 str)。
- 确定性(P7):输出全由输入决定;无时间/随机/哈希序依赖;分段读合计与
  元数据 size 恒等(循环按 size 界定)。
- **探针结论汇总(决定 spec 设计)**:①污字节值不可读(下标 M3020/消费面
  M3049)→ 纯二进制捕获不可行,帧以 hex 传输编码落盘(§2.1 已声明);
  ②crc32 无内建 → Fletcher-16(任务预案"可实现校验"分支);③`==` 跨污界
  M3002 → starts_with 查表解码;④metadata size 是 f64 → `as i64`;
  ⑤read_file 无效 UTF-8 = U+FFFD 替换(非 Err)→ bad_utf8 进解析路径
  (Python errors="replace" 对齐);⑥read_bytes_range 空文件 start=0 → Err
  → 字节层先取 size 再循环(size=0 跳过循环);⑦溢出 M4002 panic exit 101
  (checked)——组装式 0xFFFFFFFF < 2^63,fixture 不触达溢出。

## 6. 与 T2.3 承诺面的依赖标注

- **不依赖未实现语言面——全部在冻结面内**:字节层(metadata v0.82/
  read_bytes_range v0.86/污点计数面 v0.77)与解析层(read_file 源翻转 v0.77/
  污值代数 28 方法 v0.77/argv v0.82)均为已交付版本行(契约 §2 P2/P3/P8);
  语法类型位运算/窄型 as(P1)与确定性(P7)同面。T2.2 冻结令已确认
  (2026-11-22)——本场景实现不触碰任何承诺面变更。
- **计划原文"二进制帧 + read_bytes_range 分段"的忠实度(如实标注)**:
  字节序(大端 length/checksum 显式组装)、校验和(Fletcher-16 逐字节)、
  边界检查(头完整/长度上界/宽度一致/大小门禁)、read_bytes_range 分段
  (4096 循环 + 短读)、任意输入不 panic(Err 化)五项全部兑现;**兑现形态
  受探针 ① 约束**——帧数据消费走 hex 传输编码,Ming 解析器从污行重建净帧
  字节后再做字节序/校验和判定;`read_bytes_range` 在 Ming 侧承载字节层
  (门禁 + 分段计数,bytes= 字段),不承载帧数据消费(字节值不可读)。
  该偏差 + 依据已登记 docs/gap-log.md(场景 gap-log.md GAP-S3-1),不放宽
  任何验收判据。
- **已知能力面缺口(gap log 位,登记不实现——plan §4.15.6 场景不扩面)**:
  ①污字节值消费(`Untrusted[Vec[u8]]` 元素读/字节→bin/crypto 通道)缺失,
  纯二进制帧捕获不可解析;②crc32/adler32 无内建(本场景 Fletcher-16 替代,
  语义自洽);③read_file 无效 UTF-8 替换语义属宿主(Node)继承,Python 侧
  以 errors="replace" 显式对齐,非语言承诺面。

## 7. 已知风险与 gap log 位

- **跨语言 U+FFFD 计数**:Ming/TS 同源(Node Buffer.toString('utf8'));Python
  `errors="replace"` 对单字节无效序列(ff/fe)逐字节一个替换符,探针实测
  与 Node 一致;fixture 限定单字节无效形态,多字节序列不触达(§4 粒度条款)。
- **码点口径**:clen/切片 = 码点(char_len/TS `Array.from`/Python `len`);
  fixture 行均为 ASCII+U+FFFD(无代理对),三语言恒等;报告不得外推到
  增补平面。
- **Fletcher-16 变体纪律**:mod 255 与存储序(sum2<<8|sum1 大端)由 §2.1
  唯一定义,gen_fixtures 与三语言 solution 共用同一公式;三语言腿全绿即
  锁定,不与 RFC 其他变体混淆。
- **win32 管道 CRLF**:fixture 统一 LF;三语言各写各读(stdout 经管道,
  verify 以 text+utf8 读取并按 \n 断言——S1/S2 先例);输入文件若被外部
  工具改成 CRLF,行尾 \r 落入 BAD_HEX(非 panic),行为可解释。
- **oversize.hex 的仓库体积**:65537 字节 ≈ 64KB,与 S2(≤512KB)同量级;
  生成器确定性,重跑 sha 逐字节不变。
- **gap log 位**:`docs/gap-log.md` 追加本场景条目;场景内 gap-log.md 逐条
  明细(spec 条目/实测行为/影响/建议);本 spec 预登记候选 = §6 三项缺口 +
  §7 前 4 项风险 + 实现期发现的任何口径分歧。
