# S5 发布打包自举 — 实现期 gap log(T3-impl,2026-11-22)

> 逐条格式:spec 条目 / 实测行为 / 影响 / 建议。spec 本体不改(仅头注下方加实现登记行)。
> 能力面核对结论:本场景全部核心流程在 T2.3 承诺面(P1–P8)既有能力内实现成功
> (argv 路径位 sanitize_cli_path → read_file 污值代数 keep/clean 面 → 净 i64 三元组
> 比较 → list_dir 条目净化 + 净 Vec 排序 → write_file 出向透传落盘),未遇到不可绕过
> 的 M3049/M3050 拒绝。三语言(ming/ts/py)六案例 stdout 与 notes 逐字节一致。

## GAP-S5-1 实现前探针定案记录(spec §5 三项)

- **spec 条目**:§5 探针清单 ①em-dash 定位与切点 ②notes 尾 \n 写盘/读盘往返
  ③Windows 文件名大小写不敏感。
- **实测行为**:① `index_of(" — ")` em-dash(U+2014)码点口径定位正确
  (`## v1.2.3 — 标题行` dash=9),`slice_chars(4, dash)` = "1.2.3";guide_head 括号
  经 spec 行 75 字节实测为 **ASCII `(`(0x28)**,`index_of("(")` 直用;② notes 模板
  (中文条目体)write_file→read_file 往返逐字节(110B 探针样本;正式 143B notes
  同口径),LF 无 CRLF 翻译——**更正(2026-11-23,审查 MINOR-1)**:本条原表述
  "尾单个 \n"仅对探针样本成立;正式 expected_notes_ok.md 实测 143B、以 `\n\n`
  结尾(条目体含第二条目 `## ` 前的空段,逐字写盘所致),§3.4 字面与 §3.2 逐字
  的歧义登记见 GAP-S5-5;③ fixture 名与期望集精确同形(全 ASCII),
  大小写不敏感不触达(粒度条款维持)。
- **影响**:探针全部按 spec 预设成立,零判据调整。
- **建议**:无。

## GAP-S5-2 `Vec.sort()` 对空 Vec 以 M4001 panic(语言既有口径;实现守卫规避)

- **spec 条目**:§3.3 检查 4 "snapshot_files:…extra 名按字节序升序、逗号连接";
  实现需对 extra 列表排序(空列表 = 合法形态,ok 案例恰为空)。
- **实测行为**:`Vec[str].sort()` 在**空 Vec** 上以 M4001 panic("sort:元素不支持
  排序")——src/interp.js 元素类型分派按首元素判型,空 Vec 无首元素 → 落入不支持
  分支;tree/VM 双引擎一致。实现以 `len > 0` 守卫规避(空 Vec 排序数学上是 no-op);
  非空排序行为正常(S2 file_integrity 同款用法既有)。
- **影响**:场景判据零变化;语言面发现如实登记——空容器 sort panic 是
  "实现性缺陷形态"(数学 no-op 变 panic),属 src 域裁决事项,本场景只登记不修
  (场景不扩面纪律;守卫为场景内正确实现,非判据放宽)。
- **建议**:登记 src 域候选(空 Vec sort 返回原 Vec);修后可移除场景守卫
  (行为对三语言 transcript/expected 零影响)。

## GAP-S5-3 TS/Python 复刻的索引口径与编码纪律(粒度条款落实)

- **spec 条目**:§7 "提取规则的跨语言逐字一致";§4 粒度条款。
- **实测行为**:TS UTF-16 索引(indexOf/slice)与 Ming 码点 index_of/slice_chars
  在 fixture 域(全 BMP、无代理对、em-dash U+2014 单码元)逐值等价——非 BMP 不触达
  (粒度条款);Python str 天然码点口径。编码纪律:Python 读写固定
  `encoding="utf-8" + newline=""`(禁平台翻译);TS writeFileSync utf8 原样 LF。
  三语言六案例 stdout 与 notes 实测逐字节一致。
- **影响**:零(粒度条款按 spec 预设成立)。
- **建议**:无。

## GAP-S5-4 plan 原文"用 ming tools 完成一次真实 release 打包"忠实度(spec §6 预登记确认)

- **spec 条目**:§6 "plan 原文……的忠实度(逐项如实标注,沿 S3 GAP-S3-1 先例)"。
- **实测行为**:按 §6 落实——版本三处一致(package.json/cli_source.txt/guide_head.txt
  三元组)、CHANGELOG 首条一致 + 条目体提取、tag 名格式门禁 + tag/版本一致性、
  文件集完整(期望集之外条目具名 FAIL)四项兑现;**tag 存在性收窄**为 tag 名格式
  门禁 + 一致性(真实 tag 存在性需读 .git,登记不实现);**dist 构建与冷启动冒烟**
  降为演练形态不入黑盒验收(ming tools patch 命令面仅演练登记)。
- **影响**:spec §6 已预登记的降级项如实落库,无新增偏离。
- **建议**:无。

## GAP-S5-5 notes "单个 \n 结尾"(spec §3.4 字面)与条目体逐字(spec §3.2,含尾空段)的歧义——实现取条目体侧(审查 MINOR-1 收口)

- **spec 条目**:§3.4 "文件以单个 \n 结尾";§3.2 "首条目体 = 该行之后、下一个
  `## ` 行之前的全部行(保序;用于 notes)"、§3.4 "## Changes 之后 = CHANGELOG
  首条目体行逐字写盘"。
- **实测行为**:CHANGELOG 首条目体含第二条目 `## ` 之前的空行(LF 文件行序中的
  空段),逐字写盘后 `expected_notes_ok.md` 实测 **143 字节、以 `\n\n` 结尾**
  (od 实测末尾 `e - n o t e s \n \n`)——§3.4 字面("单个 \n 结尾")与 §3.2/§3.4
  逐字(体含空段)不可同时成立。
- **保守裁决**:实现取**条目体侧**(143B,\n\n 结尾)——"逐字写盘"是本场景核心
  语义(出向透传位、verify 两侧同为文件内容比对),结尾修饰服从内容语义;歧义随
  spec 修订窗口校正,不在本批改判据(expected 逐字节锚定即判据,三语言一致实测)。
- **影响**:零(三语言 expected/notes 逐字节一致不变;验收粒度条款下模板尾部形态
  由 expected 即判据承载)。
- **建议**:spec §3.4 模板后续修订时注明"条目体含尾空段时,文件以条目体末行+\n
  结尾('单个 \n 结尾'指无额外追加内容)"。
