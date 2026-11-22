# S5 发布打包自举(spec,T3 场景扩面 R-5)

> 状态:**spec 先行,不含实现**——plan §4.20 P1 R-5(T3 场景扩面 3/5 → 5/5)的
> spec 批次,沿 T3-pre 先例(f901665:spec 入库、实现另批)。实现批次(fixture/
> 三语言 solutions/verify/gap-log)在 spec 审查通过后另排,本 spec 审查通过前
> 不动工。对应 plan §4.15.3 T3 场景清单 #5("发布打包自举:用 `ming tools`
> 完成一次真实 release 打包")。
> 承诺面口径:验收只依赖 docs/stability-contract.md §2 P1–P8 已交付能力,不依赖
> §3 N1–N7(不断言性能/引擎归属——"必须走 wasm"即违规,契约 §5.6 口径)。
> **fixture 化声明**:plan 原文的"真实 release 打包"在本场景落为**仓库状态
> 只读快照的检查与 release-notes 生成**(fixture 化,不真读 .git、不做真实
> dist 构建入验收)——忠实度逐项标注见 §6;真实打包流程留维护者手动
> (docs/release.md + docs/release-checklist.md),本场景 = 打包自举的
> 可验收核(fuzz/漂移防线之前的机械检查层)。
> **实现登记(2026-11-22,T3-impl)**:本 spec 已实现——gen_fixtures + 三语言
> solutions + verify.{ming,js,py}(内容/参数级/交叉喂入/变异/不 panic 专项全腿绿);
> 探针定案与 `Vec.sort()` 空 Vec M4001 既有口径见 gap-log.md(GAP-S5-1/2/3/4)。

## 1. 场景目标(真实场景,非玩具)

发布工程(release engineering)的自举检查工具:维护者打 tag/发 Release 前,
对一份"待发布状态快照"做机械化验收——**版本三处一致**(package.json 清单 /
CLI 源的 VERSION 声明 / 文档修订记录头)、**CHANGELOG 首条含当前版本**、
**tag 名与版本一致**、**快照文件集完整**(无混入的草稿/意外文件),全部
通过则生成模板化 release-notes.md 供 Release 页使用。快照目录内容不可信:
可能是陈旧工作区(某处版本号忘改)、CHANGELOG 未更新、tag 与版本错位、
或混入未清理的草稿文件——不一致必须**逐项具名 FAIL**,绝不静默通过
(发布事故的真实形态就是"某处漏改")。参数级错误(缺参/快照目录不存在/
快照结构性损坏)与内容级不一致(check FAIL 行)是两类失败:前者进程报错
退出,后者是正常检查输出(check 行 + 非零退出码)。

仓库对位(如实登记,非实现依赖):真实仓库的同类门禁 = AGENTS §7"版本
三处同步"(package.json / bin/ming.js VERSION / GUIDE 修订记录)+
tests/docs_check.mjs(T4.4 数字漂移防护)。本场景用**合成 mimic 快照**
(小文件集,同名同形不同文件)——不读仓库真实文件:fixture 独立于仓库
演进(真文件格式若变,语料不漂移),三语言在任何检出目录可复现。

## 2. 程序形状与输入数据形态

### 2.1 调用形状(三语言一致)

```
prog <snapshot_dir> <notes_out>
```

- argv[1] = 快照目录路径(经 CLI 路径位净化;必须存在且为目录)。
- argv[2] = release-notes 输出路径(经净化;仅当全部检查 OK 时覆盖写;
  FAIL/参数错误路径**不触碰**该路径——含已存在同名文件时不修改,验收腿
  一律使用新建路径避免歧义)。
- stdout 只写检查行/汇总行;诊断走 stderr 不参与验收(参数级 error 行除外)。
- 被测程序以仓库根为工作目录(T1.2 提交物形态惯例)。

### 2.2 fixture 设计(由 gen_fixtures.ming 确定性生成;重跑逐字节不变)

布局 `tests/experiment/scenarios/release_bootstrap/`:

```
input/snapshots/<case>/    六个快照目录(下方表;每目录恰含下方五文件集,
                           extra_file 案例多一个 draft_notes.txt)
expected/expected_stdout_{ok,mismatch_cli,mismatch_changelog,mismatch_tag,
  extra_file}.txt          检查行期望(逐字节;由参考实现产出,三语言腿全绿 +
                           交叉喂入 FAIL 后入库——S3 惯例)
expected/expected_notes_ok.md   release-notes 期望(逐字节)
verify.{ming,js,py}        三语言黑盒验收(T-impl;语义等价)
solutions/solution.{ming,ts,py}  参考实现(T-impl)
gap-log.md                 实现期建档(spec 预登记候选见 §6/§7)
output/                    验收腿运行时产物(notes 实写位置;不入 expected;
                           .gitignore 处理由实现批次登记)
```

**快照五文件集**(基础版本 = 合成版号 `1.2.3`,tag = `v1.2.3`;与仓库
真实版本号无耦合,防演进漂移):

| 文件 | mimic 对象 | 内容形态(提取规则见 §3) |
|------|-----------|--------------------------|
| `package.json` | 项目清单 | 紧凑 JSON `{"name":"ming-app","version":"1.2.3"}` |
| `cli_source.txt` | CLI 入口源(VERSION 声明) | 数行文本,恰一行以 `const VERSION` 开头,版本号在一对双引号之间;另含一行含 `VERSION` 的普通注释行作干扰(首匹配语义) |
| `guide_head.txt` | 文档修订记录头 | 数行文本,恰一行以 `### v` 开头,其后为 `1.2.3(2026-11-22):…` 形态,版本号终止于首个 `(` |
| `CHANGELOG.md` | 变更日志 | 首行 `## v1.2.3 — <标题>`,其后 2 行条目体(`- ` 开头),再接第二条目 `## v1.2.2 — 旧条目` + 1 行体(首条选择语义;中文内容,UTF-8) |
| `tag.txt` | tag 名 | 单行 `v1.2.3`(末尾 LF) |

**六案例**:

| case | 构造 | 预期 |
|------|------|------|
| ok | 五文件全部一致 | exit 0 + notes 生成 |
| mismatch_cli | cli_source.txt 版本 = `1.2.2`,其余一致 | three_place FAIL,exit 1 |
| mismatch_changelog | CHANGELOG 首条 = `## v1.2.2 — 旧条目版本`,其余一致 | changelog FAIL,exit 1 |
| mismatch_tag | tag.txt = `v1.2.2`,其余一致 | tag FAIL,exit 1 |
| missing_version | package.json 无 `version` 字段 | 参数级错误(结构性),exit 1 |
| extra_file | 额外 `draft_notes.txt` | snapshot_files FAIL,exit 1 |

规模量级:每文件 ≤ 200 字节;全 fixture ≤ 4KB。UTF-8、LF 行尾、末行
以 LF 结尾(末尾换行产生的空段不计,S1 口径)。

## 3. 被测程序职责(三语言 Ming/TypeScript/Python 同一语义)

### 3.1 结构门禁(先于一切检查行;任一失败 → stdout 空,stderr 恰一行以
`error:` 开头,exit 1)

1. argv 缺失/路径净化 Err/快照目录不存在或非目录/输出路径净化 Err。
2. 快照五文件逐一 `read_file`:任一不可读 → 结构性缺失。
3. 提取失败(下述 3.2 各文件的提取规则无产出):package.json 非 JSON/
   无 `version` 字段/version 非 str;cli_source.txt 无 `const VERSION` 行
   或该行无成对双引号;guide_head.txt 无 `### v` 行或版本段缺 `(` 终止;
   CHANGELOG.md 首行非 `## v` 形态或缺 ` — ` 分隔;tag.txt 空/无 `v` 前缀/
   三段数字不全为整数。

**提取成功但值不一致 = 内容级 FAIL**(检查行输出),不属结构门禁——
同一条件不得两种裁决(黑盒判定唯一,S2 口径)。

### 3.2 版本提取(逐文件规则;全部经污值代数在污域切片,数值化后在净域比较)

版本统一解析为 **(major, minor, patch) 三元组 of i64**:`split(".")` 后
逐段 `parse_i64`(**Err 载荷保污**(`Untrusted[str]`,keepResErr,v0.77 B1
裁决);本场景不消费 Err 载荷——任一段非整数即提取失败,归结构门禁)。
比较全部在净 i64 域(跨污界 `==` 不可用 M3002 的规避形态;三元组相等 =
逐段相等)。

| 文件 | 提取规则(判定序) |
|------|------------------|
| package.json | `json.parse`(载体感知:污 str → 污 Json)→ `get("version")` → `as_str()` → `Option[Untrusted[str]]` → 三元组 |
| cli_source.txt | `split("\n")` → **首个** `starts_with("const VERSION")` 的行 → 行内首个 `"` 与其后的下一个 `"` 之间(`index_of` 定位,净标量;`slice_chars` 切片,keep)→ 三元组 |
| guide_head.txt | 首个 `starts_with("### v")` 的行 → `slice_chars(5, char_len)` → 首个 `(` 前(`index_of("(", …)`,无 `(` → 提取失败)→ 三元组 |
| CHANGELOG.md | **首行** `starts_with("## v")` → `slice_chars(4, char_len)` → 首个 ` — `(空格+em-dash+空格,3 字符)前 → 三元组;**首条目体** = 该行之后、下一个 `starts_with("## ")` 行之前的全部行(保序;用于 notes) |
| tag.txt | 全文 `trim()` → 必须 `starts_with("v")` → 去首字符后三元组 |

### 3.3 四检查(全部执行,不短路;检查行序固定)

1. `three_place`:package.json / cli_source.txt / guide_head.txt 三元组
   逐段相等(参考值 = package.json)。
2. `changelog`:CHANGELOG 首条三元组 == 参考值。
3. `tag`:tag 三元组 == 参考值。
4. `snapshot_files`:`list_dir` 条目逐一 `sanitize_cli_path`(Err 条目 →
   跳过,不计 extra——fixture 全 ASCII 名不触达,粒度条款)→ 与期望
   文件名集合 {五文件} 比较:期望名缺失已在结构门禁报错;**目录中出现
   期望集之外的条目 → FAIL**(extra 名按字节序升序、逗号连接;fixture
   恰一个)。

**stdout 输出(逐字节;OK/FAIL 形态)**:

```
check three_place OK
check changelog OK
check tag OK
check snapshot_files OK
summary checks=4 failed=0 version=1.2.3 tag=v1.2.3
```

FAIL 行细节格式(值全部为**净域重构**——三元组 i64 经 `str()`/拼接渲染,
无污值出向问题):

- `check three_place FAIL package=<p> cli=<c> guide=<g>`(恒列三值)
- `check changelog FAIL changelog=<v> version=<v>`
- `check tag FAIL tag=<v> version=<v>`(tag 值不带 v 前缀,与 version 同形)
- `check snapshot_files FAIL extra=<name>`

`summary` 恒为末行:`summary checks=4 failed=<n> version=<参考三元组渲染>
tag=v<tag 三元组渲染>`。

### 3.4 release-notes 生成(仅全部检查 OK;逐字节模板,LF,文件以单个 \n 结尾)

```
# Release v1.2.3

tag: v1.2.3
version: 1.2.3
changelog: 1.2.3

## Changes
- toolchain: 自举工具链冒烟
- notes: 模板化 release-notes
```

头部四行值 = 净域重构(tag 行带 v 前缀);`## Changes` 之后 = CHANGELOG
首条目体行**逐字写盘**(出向透传位:污值合法写盘——存储不是边界穿越,
GUIDE §18;verify 读盘比对两侧同为文件内容,无跨污界比较)。

**Ming 侧污点工作流**(语义即上;TS/Python 实现等价提取函数,三语言行为
规则逐字一致):argv 路径位 `sanitize_cli_path`(v0.82);`read_file` →
`Untrusted[str]`(v0.77 源翻转);污值代数 keep 面(`split`/`slice_chars`/
`trim`/`starts_with`)+ 净标量(`index_of`/`char_len`/`parse_i64`);
`list_dir` 条目污 → `sanitize_cli_path`(v0.77 条目标污,机械净化器直接
适用);`write_file` 内容出向透传(changelog 体逐字落盘);输出行由净
三元组重构渲染。

## 4. 黑盒验收标准(对齐 scenarios/<name> verify 惯例)

- **内容腿(5 逐字节)**:
  1. ok → stdout = expected_stdout_ok.txt,**exit 0**,notes 内容 =
     expected_notes_ok.md(读盘逐字节)。
  2. mismatch_cli / mismatch_changelog / mismatch_tag / extra_file →
     stdout = 各自 expected(逐字节),**exit 1**,输出路径**无文件**
     (不存在断言)。
- **参数级腿**(各:exit 1、stdout 空、stderr 恰一行以 `error:` 开头):
  缺参(0/1 个 argv);快照目录不存在;argv[1] 指向普通文件
  (extra_file/draft_notes.txt 形态);missing_version 案例整体
  (结构性,归参数级形态)。
- **负例腿**(T-impl):交叉喂入另一场景参考实现(S2 solution)预期 FAIL;
  expected 变异样本(改一处检查行/notes 一字符)→ mismatch FAIL。
- **不 panic 专项**:对全部 6 快照目录跑被测程序,断言 stderr 不含引擎
  panic 标记(`panic`/`内部错误`/`RangeError`/`TypeError`/`Traceback`);
  三份 verify 各自覆盖(S3 同款)。
- **验收粒度 = fixture 可观测行为逐字节一致,非全规格覆盖**(设计 §8
  缺口 8 口径)。已知不触达边界,报告不得过度解读:`sanitize_path` 的
  规范化全语义(本场景只用 `sanitize_cli_path`,校验不改写);多个
  extra 文件的排序渲染(fixture 恰一个);快照子目录条目形态;
  CHANGELOG 第三条目及以后;tag 多行/前导空白;`### v` 行在 guide_head
  中出现多次;版本号含前导零(如 `01`)的解析;BOM;非 UTF-8 字节
  (read_file U+FFFD 替换语义不触达,G10)。

## 5. 触达的 Ming 能力面(设计锚定;不确定项标注"实现前探针")

- 效果声明:`fn main(args: Vec[Untrusted[str]]) -> i64 with io, fs`
  (无 net/proc——纯 fs 场景,不读 .git、不调 git,设计选择)。
- 污点(P8):argv 元素级污(v0.82,路径位 sanitize_cli_path/数值位
  parse_i64);`read_file` → `Untrusted[str]`(v0.77);`list_dir` →
  `Vec[Untrusted[str]]` 条目污(v0.77)+ 逐条目 `sanitize_cli_path`;
  污值代数 28 方法触达子集:keep(`split`/`slice_chars`/`trim`)+
  clean(`starts_with`/`char_len`/`parse_i64`)。
- 载体感知 JSON(v0.77):`json.parse(污 str)` → 污 Json → `get`/`as_str`
  投影(载体收窄)。
- 净域面:i64 三元组相等;`str(i64)`/`+` 渲染;`Vec[str]` 集合比较
  (ASCII 名,字节序);`write_file`(净路径,内容含出向透传的污行)。
- 出向:`print`(检查行)/`eprint`(error: 行)/退出码 0/1。
- 确定性(P7):输出全由输入决定;无时间/随机/哈希序依赖;条目集合
  比较前排序(实现面,字节序)。
- **实现前探针清单**:①`index_of(" — ")` 的 em-dash(U+2014)定位与
  `slice_chars` 切点(码点口径,fixture 无增补平面);②notes 末尾单个
  `\n` 的写盘/读盘往返(write_file 原样,LF 不翻译);③Windows 文件名
  大小写不敏感对集合比较的影响(期望集与 fixture 名精确同形,不触达)。

## 6. 与 T2.3 承诺面的依赖标注

- **不依赖未实现语言面——全部在冻结面内**:argv 污点(v0.82)/read_file
  与 list_dir 源翻转(v0.77)/污值代数 28 方法(v0.77)/净化族(v0.61/
  v0.64)/载体感知 json(v0.77)/窄型与确定性(P1/P7)均为已交付版本行
  (契约 §2 P1/P3/P7/P8)。T2.2 冻结令已确认(2026-11-22),本场景实现
  不触碰任何承诺面变更。
- **plan 原文"用 ming tools 完成一次真实 release 打包"的忠实度(逐项
  如实标注,沿 S3 GAP-S3-1 先例)**:
  - **版本三处同步检查** → 兑现(程序化,mimic 快照);
  - **CHANGELOG 校验** → 兑现(首条版本一致 + 条目体提取);
  - **tag 存在性** → 兑现形态 = **tag 名格式门禁 + tag/版本一致性**
    (快照内 tag.txt)——真实 tag 存在性需读 .git(git 查询面),不在
    fixture 化范围,登记不实现;
  - **dist 构建与冷启动冒烟** → **演练形态**,不入黑盒验收:`ming build`
    需 ming.toml 项目与产物运行(cwd/缓存/编译器状态环境依赖),验收
    判据无法跨环境逐字节;演练命令面(实现批次在 GUIDE 对位处登记,
    不改变判据) = 版本位经 `ming tools patch`(恰好 1 处拒绝语义)→
    `ming build` → `node dist/ming-app.mjs` 冒烟;launcher 可执行性
    (node dist/ming-app.mjs 即跑 + panic → 101)是契约 §6 #3 ④ 的
    承诺界面,演练按其自检。
  - 真实打包流程(打 tag/Release 页/CI 证据)留维护者手动
    (docs/release.md + release-checklist)——本场景是其机械检查层的
    可验收化,不替代人工发布。
- **依赖 T2.3 生效的部分**:实现批次本身(spec 审查后另排)——流程
  门槛而非能力缺口。
- **已知能力面缺口(gap log 位,登记不实现——plan §4.15.6 场景不扩面)**:
  ①git 查询面(tag 存在性/log 校验)不做——需 proc/外部工具依赖,本
  场景刻意保持纯 fs;②CHANGELOG 仅取首条(全量遍历/多版本区间不做);
  ③release 产物签名/校验和(hmac 可用但非本场景目标)不做;④子目录
  递归(list_dir 单层)不做。

## 7. 已知风险与 gap log 位

- **跨语言换行与编码**:fixture 统一 LF、UTF-8;Python 腿读写固定
  `newline=""`/`encoding="utf-8"`(禁平台翻译,三语言逐字节前提);
  changelog 中文条目体经写盘/读盘往返,verify 两侧同源(污→写、读→污)
  无跨污界比较。
- **mimic 快照与真实仓库格式的漂移隔离**:cli_source.txt/guide_head.txt
  是合成 mimic(形态对齐 AGENTS §7 三处与 GUIDE 修订记录),**不是**
  仓库真文件解析——真实文件演进(如修订记录格式变更)不影响语料;
  该边界写入报告,不得宣称"已验证仓库三处一致"。
- **合成版号防耦合**:fixture 版本 `1.2.3` 与仓库真实版本无关联;若
  实现期误用仓库版本号,视为语料缺陷修正(不校准既有判据)。
- **提取规则的跨语言逐字一致**:首匹配语义(首个 `const VERSION` 行/
  首个 `### v` 行/首行 `## v`)、" — " 三字符分隔、引号间切片——三
  语言 verify 与 solution 按同一伪代码实现,审查时逐条对照;em-dash
  在 TS/Python 源码中的字面量编码(UTF-8 源文件)探针项确认。
- **FAIL 不触碰输出路径**:语义 = 检查未通过不产出 notes(半成品防混入);
  验收腿输出路径恒新建,已存在文件的保留语义不被 fixture 触达
  (粒度条款)。
- **win32 文件名字典序**:fixture 全 ASCII 名,字节序 = 名字序;
  snapshot_files 的 extra 排序渲染跨语言一致(审查对照项)。
- **gap log 位**:`docs/gap-log.md` 追加本场景条目;场景内 gap-log.md
  逐条明细(spec 条目/实测行为/影响/建议);本 spec 预登记候选 = §6
  四项缺口 + **§6 忠实度降级三项**(tag 存在性收窄为一致性/dist 构建冷
  启动降为演练形态/ming tools 仅演练命令面——plan 忠实度偏差登记 gap,
  GAP-S3-1 先例)+ §7 前 5 项风险(第 6 项 win32 文件名字典序为实现期
  审查对照项,非 gap)+ 实现期发现的任何口径分歧。
