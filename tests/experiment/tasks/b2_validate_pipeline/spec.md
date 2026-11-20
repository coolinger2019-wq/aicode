# B2 数据校验管线(spec)

## 任务

读取 JSON 记录数组,按手写 schema 校验每条记录,输出逐记录结果行与汇总。

## 输入

- argv[1] = 记录文件路径;顶层为 JSON 数组,每条记录为 JSON 对象。
- 记录可能缺字段、字段类型可能不对(语料保证覆盖这些形态)。

## Schema(固定;字段检查顺序 id → email → age → role,全字段检查、不短路)

- `id`:必须存在、为数值、且 ≥ 1;
- `email`:必须存在、为字符串、且包含 `@`;
- `age`:必须存在、为数值、且 0 ≤ age ≤ 150;
- `role`:必须存在、为字符串、且取值 ∈ {`admin`, `user`, `guest`}(整串等值)。
- 无效字段输出 `<field> invalid`,按检查顺序以 `; `(分号+空格)连接。

## 输出

- 每条记录一行:全部字段有效 → `record <序号> ok`;否则
  `record <序号> <field1> invalid; <field2> invalid; ...`(序号 = 数组中
  1 起序)。
- 末行汇总:`ok=<全有效条数> failed=<其余条数>`。

## 验收

stdout 与 `expected/expected.txt` 逐字节相等,退出码 0。

## 错误行为

- 参数缺失、文件不可读、JSON 解析失败、顶层非数组:stderr 一行以 `error:`
  开头,退出码 1,stdout 空。
