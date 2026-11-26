# 契约桥端到端示例(S-4,plan §4.21 / R-16)

演示 TypeScript JSDoc → Ming `.mingi` 契约桩 → Ming `extern fn` 签名核对的最小闭环。

| 文件 | 角色 |
|------|------|
| `demo.ts` | TypeScript 导出函数(`clamp`/`sum` 带 JSDoc 契约候选;`readConfig`/`hasKey` 演示 `@effects`/`@taint` 桥接元数据;`parseAny` 演示表外类型诚实跳过) |
| `demo.mingi` | 由 `ming bridge extract` 生成的契约桩(**入库黄金**;确定性输出,勿手工编辑) |
| `demo.ming` | Ming 侧:`extern "libdemo" fn clamp(...)` 声明 + 真实 FFI 调用点(`with ffi`)+ 效果/污点元数据的消费面 |
| `README.md` | 本文件 |

## 跑一遍

```bash
# 1) 从 TS 提取契约桩到当前目录(覆盖 demo.mingi;输出确定性)
node bin/ming.js bridge extract --from ts examples/bridge_demo/demo.ts --out examples/bridge_demo

# 2) 契约桥一致性检查:同名 extern fn 与桩逐位核对(失配 → M3052)
node bin/ming.js check examples/bridge_demo/demo.ming --stub examples/bridge_demo

# 3) 看 JSON 注记(checked 条目携带桩的候选 requires/ensures + effects/taint 元数据)
node bin/ming.js check examples/bridge_demo/demo.ming --stub examples/bridge_demo --json
```

## 试一次失配

把 `demo.ming` 里 `clamp` 的第一个参数改成 `x: i64`,再跑第 2 步:

```text
error M3052[bridge-signature-mismatch]: 桥接签名失配:extern 函数 "clamp" 与契约桩 ... 不一致——参数 #1 类型 桩=f64、extern=i64
```

Ming 不会静默接受跨语言边界的形状漂移;按提示改回声明,或重新生成桩。

## 诚实边界

- 契约桩是**候选边界条件**的声明性工件(`len$xs` 是桩格式的长度符号,写进 Ming
  `requires` 需改写为 `xs.len()`),MVP 不自动注入 Ming 契约;
- `demo.mingi` 入库作黄金:重新 extract 后 `git diff` 必须为空(确定性承诺);
- 实际 FFI 执行需要 C 原生后端(`ming cc`)与 `libdemo`;本示例只演示声明级桥接,
  JS 引擎执行 extern 调用按 M4001 拒绝(本示例的 `main` 不调用它);
- 只有 TypeScript JSDoc 一种源语言、`extern fn` 一种边界形态;`.mingi` 格式与
  M3052 口径见 `docs/bridge-protocol.md`。
