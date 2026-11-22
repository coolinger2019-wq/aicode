# S2 文件完整性校验(spec,T3-pre)

> 状态:**spec 先行,不含实现**——plan §4.18.2 T3-pre 交付物;实现/fixture/verify 由
> T3-impl 批次承担(前置 = T2.3 生效,plan §4.18.2 T3-impl 行)。本 spec 审查通过前
> 不动工。对应 plan §4.15.4 T3-a 场景 4(文件完整性工具:HMAC 校验 + 目录批量扫描;
> 确定性输出 + 篡改检测)。
> 承诺面口径:验收只依赖 docs/stability-contract.md §2 P1–P8 已交付能力,不依赖
> §3 N1–N7(不断言性能/引擎归属,契约 §5.6 口径)。

实现登记(2026-11-22):见 gap-log.md

## 1. 场景目标(真实场景,非玩具)

发布物完整性校验(release verification):维护者发布前对文本文件集生成 keyed
HMAC 清单(manifest),使用者下载后用同一 key 重算比对——被篡改/损坏/缺失/
多出的文件**逐个具名报出**,清单自身被篡改也必须被检测(每行携带 HMAC,
逐行重验)。文件内容不可信:含控制符的文件按可疑处理(REJECTED,拒绝计算
哈希)而非静默纳入——控制符注入是报告/终端注入的真实攻击面。参数级错误
(key 非法/路径非法/清单损坏)与内容级篡改是两类失败:前者进程报错退出,
后者是正常校验输出(逐文件状态行 + 非零退出码)。

## 2. 程序形状与输入数据形态

### 2.1 调用形状(三语言一致,同程序双子命令)

```
prog gen <dir> <manifest.txt> <key>      # 生成清单
prog verify <dir> <manifest.txt> <key>   # 校验
```

- `<dir>`:单层目录(递归扫描 v1 不做,见 §7);参与文件 = 目录下以 `.txt`
  结尾的普通文件(ASCII 名,值域 `[a-z0-9_-]+\.txt`,语料保证)。
- `<key>`:HMAC key,值域 `[A-Za-z0-9]+`(语料保证;经 CLI 路径/比较串净化
  口径校验,非法 → 参数级错误)。
- `<manifest.txt>`:清单,每行 `<name> <hex64>`,`name` 升序(字节序);生成
  时覆盖写;校验时逐行解析。
- stdout 只写状态/汇总行;诊断走 stderr 不参与验收;仓库根为工作目录。

### 2.2 fixture 设计(由 T3-impl 建;规模给量级)

布局 `tests/experiment/scenarios/file_integrity/`:

```
input/gen/files/           生成腿文件集(25–35 个 .txt;单文件 ≤ 32KB,总量 ≤ 512KB;
                           文本内容 UTF-8、LF 行尾、无控制符——"原始"文件)
input/verify/files/        校验腿文件集(同规模;其中:内容被篡改 ~2 个、
                           含控制符内容 ~2 个[如 \x01、\x1b[31m]、EXTRA ~1 个)
input/verify/manifest.txt  校验腿清单(对"原始"文件集以固定 key 生成;删除 1 个
                           文件、保留其清单行以构造 MISSING——删清单行产出的是
                           EXTRA(§3 步骤 4 口径);行序字节升序)
input/verify/key.txt?      不设文件——key 经 argv 传入(命令行惯例);固定 key 值
                           写入 spec 与 prompt(如 `integkey2026`),三语言同值
expected/gen_manifest.txt  生成腿清单期望(逐字节)
expected/expected_gen_stdout.txt / expected_verify_stdout.txt  摘要期望(逐字节)
verify.{ming,js,py}        三语言黑盒验收(T3-impl)
solutions/solution.{ming,ts,py}  参考实现(T3-impl)
```

## 3. 被测程序职责(三语言 Ming/TypeScript/Python 同一语义)

**gen**:
1. 校验参数(dir 存在/key 值域合法/manifest 路径合法)——失败 → 参数级错误。
2. 扫描 `<dir>`,取 `.txt` 文件名集合,按**字节序升序**处理。
3. 逐文件读内容;含控制符(集合同 S1 §3.3:C0 含 `\t`、DEL、C1、U+202A–202E)
   → 该文件跳过并计入 `rejected`(gen 不产出其清单行)。
4. 对通过闸门的文件计算 `hmac_sha256(key, content)`(hex 小写 64 位),写清单行。
5. 清单落盘 + stdout 摘要行(逐字节,见 §4)。

**verify**:
1. 校验参数(同上;manifest 不存在/行格式非法/重复名等**结构性损坏** → 参数级
   错误"清单损坏",exit 1)。清单行 hex 与重算 HMAC 不符**不是**参数级错误
   ——统一归步骤 3 的 `TAMPERED` 形态(同一条件不得两种裁决,验收黑盒判定
   才唯一)。
   - **防清单篡改**的机制 = 步骤 3 的重算比对:清单任一行 hex 被改(无对应
     文件变动)→ 重算该文件 HMAC 与被改行不符 → `TAMPERED`;清单加行
     (无对应文件)→ `MISSING`;清单删行(文件仍在)→ `EXTRA`——增删改均以
     状态行形态暴露(不设第二层自校验,诚实登记:清单整行伪造 = 攻击者
     同时改文件与清单的对抗超出 v1 场景,见 §7)。
2. 解析清单 → `name → hex` 有序映射(字节序);扫描目录得实际 `.txt` 集合。
3. 对每个清单内 name:文件缺失 → `MISSING`;存在但含控制符 → `REJECTED`;
   否则重算 HMAC 与清单比对 → `OK` / `TAMPERED`。
4. 对目录内不在清单中的 name → `EXTRA`。
5. stdout 全部状态行(按 name 字节序混排)+ 汇总行;退出码 = 全 OK ? 0 : 1。

Ming 侧污点工作流:`fs.list_dir` → `Vec[Untrusted[str]]`(v0.77 条目标污)
→ 逐条目 `sanitize_cli_path`(Err → 计入 skipped_names,不进状态行)→ 净名
`ends_with(".txt")` 过滤 → 净 Vec[str] `sort()`(污 Vec 方法白名单仅
`len/is_empty`——**先净化后排序**);文件内容 `fs.read_file` →
`Untrusted[str]` → 切行后逐行过 `sanitize_cli_path` 闸门——**整文件直接过
净化器不行**(内容含 `\n` 必 Err),任一行 Err 即 REJECTED(与 S1 同一口径:
控制符集合一致);闸门通过后以**净行重建净内容**(`cleanLines.join("\n")`
——split 保留尾部空段,对 LF 文件重建无损)得到净 str,方可进净槽
`std.crypto.hmac_sha256(key, cleanContent)`(crypto 消费面净槽:污 content
直接入参 → M3049;净行重建后整条链 `ming check` 通过)。TS/Python 实现等价
校验函数(同一控制符集合/值域)——三语言行为规则逐字一致。

## 4. 黑盒验收标准(对齐 tasks/<id> verify 惯例)

- **gen 腿**:
  - stdout 逐字节:`manifest <n> files rejected=<r>`(n = 产出清单行数)。
  - `manifest.txt` 读盘逐字节比对(行序 = 字节序)。
  - 退出码 0(含 rejected > 0);参数级错误 → exit 1,stdout 空,stderr
    一行以 `error:` 开头。
- **verify 腿**:stdout 状态行逐字节:
  ```
  <name> OK|TAMPERED|MISSING|REJECTED|EXTRA
  (按 name 字节序混排)
  summary ok=<a> tampered=<b> missing=<c> rejected=<d> extra=<e>
  ```
  退出码:全部 OK → 0;存在任一非 OK → 1(校验工具的"发现篡改"是正常
  输出路径,验收同时断言逐字节输出与退出码)。清单损坏 → exit 1,stdout 空。
- **负例腿**(T3-impl):交叉喂入另一场景参考实现预期 FAIL;参数错误腿
  (缺参/key 越值域/dir 不存在/清单行被改动)预期 exit 1。
- 验收粒度 = fixture 可观测行为逐字节一致,非全规格覆盖(设计 §8 缺口 8
  口径;边界语义如"恰好 32KB 文件"不被 fixture 触达,报告不得过度解读)。

## 5. 触达的 Ming 能力面

- 效果声明:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs, crypto`。
- 污点(P8):`list_dir` 条目污 → `sanitize_cli_path` 净化(v0.61/v0.64);
  `read_file` 内容污 → 切行逐行闸门;污值代数 clean 谓词
  (`ends_with`/`is_empty`/`char_len`);argv 污点(v0.82,`sanitize_cli_path`
  授权位 = CLI 匹配/比较串)。
- crypto(P3,承诺面 v0.34–v0.37):`hmac_sha256(key, msg) -> str`(hex 小写;
  node:crypto 桥接,跨语言定值——TS `node:crypto.createHmac`、Python
  `hashlib+hmac` 标准库同值,零第三方依赖)。
- 净域面:`Vec[str]` `sort()`(字节序;v0.87 起窄型归一面)、`==` 净串等值、
  Map 插入序(P7 确定性——清单映射按行序构造)。
- 出向:`write_file`(净内容/净路径)、`print`/`eprint`。
- 确定性(P7):HMAC/输出全由输入与固定 key 决定;无时间/随机/哈希序依赖。

## 6. 与 T2.3 承诺面的依赖标注

- **不依赖未实现语言面——可先行实现的部分**:全部核心流程只依赖 v0.100
  HEAD 已交付并测试的能力(P1/P2/P3/P7/P8);`hmac_sha256`/`list_dir` 条目
  标污/`sanitize_cli_path`/`read_file` 源翻转均为已发布承诺面(v0.34/v0.77/
  v0.61/v0.82 版本行)。T2.2 冻结令已确认(2026-11-22),契约已生效——本
  场景实现不触碰任何承诺面变更。
- **依赖 T2.3 生效的部分**:实现批次本身(T3-impl 前置 = T2.3 生效)——
  流程门槛而非能力缺口。
- **已知能力面缺口(gap log 位,登记不实现——plan §4.15.6 场景不扩面)**:
  ①**AES-GCM 加密清单扩展不纳入 v1**:`aes256_gcm_encrypt` 每条消息随机
  96-bit nonce(GUIDE §18 诚实声明)→ 加密产物逐 run 不同,验收只能结构
  断言而非逐字节;v1 走 HMAC 明文清单,加密清单登记 gap 由 T3-impl 裁决。
  ②**二进制文件完整性不支持**:`read_bytes` → `Untrusted[Vec[u8]]` 无
  字节→HMAC 通道(crypto 消费面净槽,无 `Vec[u8]`→`str` 无损转换)——
  场景限定文本文件集,二进制线登记 gap。③子目录递归(list_dir 单层)
  与大量文件(>1000)分批扫描登记为扩展位。

## 7. 已知风险与 gap log 位

- **清单对抗边界(诚实登记)**:v1 的"防清单篡改"= 文件与清单行的交叉
  比对暴露增删改;攻击者同时改文件**并**伪造清单行(持有 key)不在防护
  目标内(持有 key 即维护者信任域)。fixture 不构造此形态,T3 报告不得
  宣称"防任意清单伪造"。
- **跨语言 HMAC 等价**:`hmac_sha256` 为 RFC 2104 定值算法,三语言标准库
  同值;实现期若发现 hex 大小写/编码分歧,先写最小复现,登记
  `docs/gap-log.md`(T3-impl 建档,本场景为登记来源之一)。
- **win32 文件名字典序**:fixture 文件名全 ASCII,字节序 = 名字序;verify
  的状态行序必须三语言一致(spec §4 字节序口径,审查对照)。
- **CRLF**:fixture 统一 LF;read→write 不翻译(三语言各写各读,无交叉)。
- **控制符文件在 win32 的落盘**:REJECTED 样本为**内容**含控制符(文件名
  合法)——win32 文件系统不收控制符文件名,fixture 只用内容注入形态。
- **gap log 位**:`docs/gap-log.md`(T3-impl 建档);本场景预登记候选 =
  §6 三项缺口 + §7 清单对抗边界 + 实现期发现的任何口径分歧。
