# tests/experiment — T1.1 对照实验语料

> 设计与预注册判据见 `docs/experiment-design.md`(单一事实来源)。
> 本目录是语料与验收器;**执行(T1.2)由独立 agent 承担,不得就地改语料**。

## 目录结构

```
tasks/<id>/
  spec.md            人话规格 + 验收标准(给执行者/维护者,不给被测模型)
  prompt.md          固定提示模板(被测模型唯一输入;不含 fixture 真实内容)
  input/             任务输入 fixture(真实数据只在这里)
  expected/          期望输出 fixture(expected.txt[; expected_files.txt])
  verify.ming/.js/.py  三语言黑盒验收(语义等价;对被测程序输出断言)
  solutions/         参考实现(solution.ming / solution.ts / solution.py)
  mock_server.mjs    仅 B3:本地模拟 HTTP 源(单一实现,三语言共用)
  harness.mjs        仅 B4:服务生命周期 harness(启动/请求矩阵/关停)
scenarios/<name>/   T3 场景试点(log_forensics 日志取证 / file_integrity 文件完整性;
                    spec.md = 场景规格先行,T3-pre 交付;实现/fixture/verify 待 T3-impl,
                    前置 = T2.3 生效——见各 spec.md 头注)
```

## 运行验收(一律从仓库根目录)

```bash
# Ming 腿(被测程序默认 solutions/solution.ming;可传被测 .ming 路径)
node bin/ming.js run tests/experiment/tasks/a1_log_clean/verify.ming
node bin/ming.js run tests/experiment/tasks/a1_log_clean/verify.ming -- path/to/prog.ming

# TypeScript 腿(默认 solutions/solution.ts;可传被测 .ts 路径)
node tests/experiment/tasks/a1_log_clean/verify.js [path/to/prog.ts]

# Python 腿(默认 solutions/solution.py;可传被测 .py 路径)
python tests/experiment/tasks/a1_log_clean/verify.py [path/to/prog.py]
```

退出码 0 = PASS,1 = FAIL(明细走 stderr)。被测程序以仓库根为工作目录运行,
参数形状见各任务 `spec.md` 与 `prompt.md`。

## 约定

- 期望输出逐字节比对(`expected/expected.txt`,含末行换行);A2 另比对输出
  目录集合(`expected_files.txt`)与文件内容抽检。
- B3 模拟源与 B4 harness 的端口基址固定(21031 / 21241,占用自动 +3/+7 漂移,
  实际端口经 ready 文件回传;被测程序输出不含端口,故期望逐字节不变)。
- 语料纪律:所有 `.ming` 过 `ming fmt --check` 与 `ming check`;三语言 verify
  对 `solutions/` 全绿(2026-11-20/21 已验证,42 腿复跑通过)。
- 被测程序禁止读取任务 `expected/` 与 `solutions/` 目录(诚信规则;执行者
  审查标记,见设计文档 §6.6)。
- 执行者必读环境地雷(Node 24 Windows fetch/exit 崩溃、服务程序退出方式、
  ming serve 启动方式、Python 管道 CRLF):设计文档 §8"实测发现"。
