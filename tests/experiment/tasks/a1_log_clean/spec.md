# A1 日志清洗(spec)

## 任务

读取日志文件,按固定格式判定日志行,提取字段,过滤 DEBUG,输出保留行与汇总。

## 输入

- argv[1] = 日志文件路径(仓库根相对;UTF-8;`\n` 分行;末尾换行产生的空行不计)。
- 行格式(日志行):`<timestamp> <LEVEL> <module> <k=v>...`,空格分隔。
  `<LEVEL>` ∈ `INFO|WARN|ERROR|DEBUG`(级别字段为恰好一个 token,不能有后缀)。
  典型行:`2026-11-20T09:00:01Z INFO auth user=alice action=login ok=true`

## 行判定规则(语言中立;可用正则或等价切分实现)

一行是**日志行**,当且仅当:按单空格切分后
1. 段数 ≥ 5;
2. 第 2 段恰好等于四个级别之一(整段等值,非前缀);
3. 存在以 `user=` 开头的段与以 `action=` 开头的段。
不满足 → **非日志行**(计入 skipped)。时间戳格式不参与判定(语料保证非日志行
必然失败上述判定)。

## 处理规则

- 日志行按级别过滤:仅保留 `INFO`/`WARN`/`ERROR`;`DEBUG` 丢弃(仍计数)。
- 字段提取:`user=` 与 `action=` 段去掉前缀后即为值(值 = `[A-Za-z0-9_]+`,
  语料保证);保留行缺某字段时该字段记 `-`(语料保证不出现)。
- 保留行按原文件顺序输出:`<user> <action>`(单空格)。
- 末行汇总(固定格式,四级别全列):
  `summary INFO=<n> WARN=<n> ERROR=<n> DEBUG=<n> skipped=<n>`
  计数对象 = 全部日志行按级别;skipped = 非日志行数。

## 输出与验收

- 只写 stdout,逐行输出;退出码 0。
- 验收:stdout 与 `expected/expected.txt` 逐字节相等,退出码 0。
- 诊断信息可写 stderr,不参与验收。

## 错误行为

- argv 缺失或文件不可读:stderr 一行以 `error:` 开头的消息,退出码 1,stdout 空。
