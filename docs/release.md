# Release 打包与分发(v0.58)

> 本文说明 Ming 的发布打包流程;不承诺安装器/包管理器(plan §4.3.5 任务 4)。

## 流程:tag 推送 → artifact → 手动 Release

1. **打 tag 并推送**:`git tag v0.58.0 && git push origin v0.58.0`(tag 名须匹配 `v*`;**仅从 CI 绿的 main 打 tag**——release job 只做冒烟 + 打包,不含回归,回归由 ci.yml 在 main 上把关)。
2. **Actions 自动打包**:`.github/workflows/release.yml` 的 `package` job(ubuntu + Node 20)依次执行:
   CLI 冒烟(`ming version` + `run examples/hello.ming`)→ 版本三处一致性校验(package.json 与 bin/ming.js)
   → 零 npm 依赖校验 → `zip -r ming-<tag>.zip bin src tools examples docs GUIDE.md README.md AGENTS.md package.json`
   → zip 清单核对 → 上传 workflow artifact(actions/upload-artifact@v4,artifact 名 `ming-<tag>`;tag 本身带 `v`,命名不再重复加 v)。
3. **维护者手动创建 GitHub Release**:在 GitHub Releases 页以该 tag 创建 Release,并把 artifact zip 附为资产。

**为何不自动创建 Release**:常见 gh-release 类 action(如 softprops/action-gh-release)均为第三方社区
action,违反本仓库"只用官方 action"纪律(ci.yml 同款约束);自动化的收益不值得引入第三方供应链面。
手动创建 Release 只需一次点击 + 拖拽上传 zip。

## 包内容物

- **包含**:`bin/`(CLI 与运行时)、`src/`(编译器全量源)、`tools/`(自举工具)、`examples/`、`docs/`、
  `GUIDE.md`、`README.md`、`AGENTS.md`、`package.json`(零依赖,仅版本元数据)。
- **排除**:`.ming-cache/`(构建缓存)、`.zcode/`(会话工件)、`ming-cc-out/`(C 后端输出)、`dist/`(AOT 产物)。

解包后即用:`node bin/ming.js run examples/hello.ming`(要求 Node ≥ 18,零 npm 安装步骤)。

## 本地分发替代方案

- **`ming build`**:产出 `dist/` 字节码 AOT 产物(v0.49 起内容寻址缓存),适合同语言版本间快速分发项目。
- **`ming cc`**:编译为原生可执行文件(需 gcc/clang,见 `docs/capabilities.md` 的 unsafe/C 支持行),
  适合无 Node 环境的目标机。

## 零 npm 纪律

工具链与运行时保持 Node ≥ 18 零依赖(仓库根 AGENTS.md 硬规则 3):`package.json` 不得出现
`dependencies`/`devDependencies`;release.yml 的零依赖校验步骤会在发现依赖时使打包失败。
