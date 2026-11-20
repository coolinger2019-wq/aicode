# 任务:资源配额降级

## 任务描述

写一个程序:按公式生成 30 条记录,以**程序内预算规则**逐条处理——每条记录
有成本,当加入某条记录会超出预算时,停止在该记录之前,输出降级信息与汇总。
(注意:语言原生的资源门禁不是本任务的验收对象;要在程序里实现同一套预算
规则。)

## 记录公式(固定)

- 记录 i(i = 1..30):名称 = `"svc-" + str(i*4+1)`(十进制;即 svc-5, svc-9,
  svc-13, svc-17, …)。
- 记录成本 = 名称的**字符数**(`svc-5` 是 5 个字符,成本 5;`svc-13` 成本 6)。
- 预算 = 95(固定常量)。

## 处理规则

- 按序号从小到大逐条处理;维护累计成本 `kept`(初始 0)。
- 若加入当前记录会超出预算(`kept + cost > 95`)→ **不处理该记录,立即停止**
  (后续记录全部不再处理)。
- 否则累计成本并输出该记录行。

## 输出(格式逐字固定)

- 每条已处理记录一行:`R<序号> <名称> ok`
- 越界停止时一行:
  `quota exceeded at record <序号>: kept=<当前累计> need=<该记录成本> budget=95`
- 末行:`summary processed=<已处理条数> kept_chars=<累计成本>`
- 若 30 条全部容纳:无 quota 行,直接输出 summary。

## 验收方式

验收器运行你的程序(无参数),stdout 与期望输出**逐字节**比对,并检查退出码
为 0。任何 panic/异常/非零退出都判 FAIL。

## 语言约束(随语言不同,其余部分逐字相同)

### ming

- 语言:Ming v0.97.0(仓库 `C:/code/aicode`;运行方式
  `node bin/ming.js run <文件>.ming -- <参数>`,本任务无参数)。
- 程序入口签名:`fn main() -> i64 with io`;正常结束 `return 0`。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 提示:字符串拼接用 `+`;字符串长度用 `.char_len()`;`break` 退出循环合法。
- 输出必须确定。
- 交付物:单个 `solution.ming`。可用 `node bin/ming.js check solution.ming` 自查。

### typescript

- 语言:TypeScript 5 + Node 24(运行方式 `node solution.ts`)。
- 只允许使用 Node 标准库;禁止第三方依赖;禁止读取任何 `expected/` 或
  `solutions/` 目录。
- 类型完整(应通过 `tsc --noEmit --strict`);禁止 `any`。
- 交付物:单个 `solution.ts`。

### python

- 语言:Python 3.10.11(运行方式 `python solution.py`)。
- 只允许使用标准库;禁止第三方依赖;禁止读取任何 `expected/` 或 `solutions/` 目录。
- 交付物:单个 `solution.py`。
