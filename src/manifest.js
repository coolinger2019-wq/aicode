// manifest.js — Ming 的两类"清单",互不依赖:
//   ① 项目清单(ming.toml)解析与查找(v0.4):Ming 的包管理从最小清单开始——
//      [project] 的 name / version / entry;只解析用到的 TOML 子集。
//   ② 证明工件 provenance manifest(v1.2.6,R-20/ADR-013;v1.3.1 manifest v2):`ming check
//      --proof-format smt-lib|cert --proof-manifest <path>` 的 sidecar 出处清单(纯构造,
//      零求解,零时间戳)。
//      两者同处本模块只因文件名 src/manifest.js 已被项目清单占用(ADR-013 §5 允许);
//      各自的函数/常量前缀(parseManifest/findManifest/initProject vs
//      PROVENANCE_* / buildProofManifest / computePassHash)不相交。

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as nodePath from 'node:path';
import { Diagnostic, SEVERITY } from './diag.js';

export const MANIFEST_NAME = 'ming.toml';

export function parseManifest(src, file) {
  const project = { name: null, version: '0.1.0', entry: 'main.ming' };
  const diags = [];
  let section = null;
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (ln === '' || ln.startsWith('#')) continue;
    if (ln.startsWith('[')) {
      if (!ln.endsWith(']')) {
        diags.push(new Diagnostic('M5001', SEVERITY.ERROR, `ming.toml 第 ${i + 1} 行:节头缺少 "]"`, span(file, i)));
        continue;
      }
      section = ln.slice(1, -1).trim();
      continue;
    }
    const eq = ln.indexOf('=');
    if (eq === -1) {
      diags.push(new Diagnostic('M5001', SEVERITY.ERROR, `ming.toml 第 ${i + 1} 行:期望 "key = value"`, span(file, i)));
      continue;
    }
    const key = ln.slice(0, eq).trim();
    const raw = ln.slice(eq + 1).trim();
    let value;
    if (raw.startsWith('"')) {
      const end = raw.indexOf('"', 1);
      if (end === -1) {
        diags.push(new Diagnostic('M5001', SEVERITY.ERROR, `ming.toml 第 ${i + 1} 行:字符串未闭合`, span(file, i)));
        continue;
      }
      value = raw.slice(1, end);
    } else if (raw === 'true' || raw === 'false') {
      value = raw === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
      value = Number(raw);
    } else {
      diags.push(new Diagnostic('M5001', SEVERITY.ERROR, `ming.toml 第 ${i + 1} 行:值只支持 "字符串"、数字、true/false`, span(file, i)));
      continue;
    }
    if (section !== 'project') continue; // 只认 [project];其他节忽略(未来扩展)
    if (key === 'name' || key === 'version' || key === 'entry') project[key] = value;
    // 未知键忽略(前向兼容)
  }
  if (section === null) {
    diags.push(new Diagnostic('M5001', SEVERITY.ERROR, 'ming.toml 缺少 [project] 节', span(file, 0)));
  }
  if (!project.name) {
    diags.push(new Diagnostic('M5001', SEVERITY.ERROR, '[project] 缺少 name 字段', span(file, 0)));
  }
  return { project, diags };
}

function span(file, line) {
  return { file, line: line + 1, col: 1, endLine: line + 1, endCol: 1 };
}

// 从 startDir 向上查找 ming.toml;返回 {dir, path, project} 或 null
export function findManifest(startDir) {
  let dir = nodePath.resolve(startDir);
  for (;;) {
    const p = nodePath.join(dir, MANIFEST_NAME);
    if (fs.existsSync(p)) {
      const src = fs.readFileSync(p, 'utf8');
      const { project, diags } = parseManifest(src, p);
      return { dir, path: p, project, diags };
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ming init:生成骨架
export function initProject(dir, name) {
  const manifestPath = nodePath.join(dir, MANIFEST_NAME);
  if (fs.existsSync(manifestPath)) return { ok: false, message: `${MANIFEST_NAME} 已存在` };
  const safeName = (name || nodePath.basename(nodePath.resolve(dir))).replace(/[^A-Za-z0-9_-]/g, '-');
  const toml = [
    '# Ming 项目清单',
    '[project]',
    `name = "${safeName}"`,
    'version = "0.1.0"',
    'entry = "main.ming"',
    '',
  ].join('\n');
  fs.writeFileSync(manifestPath, toml, 'utf8');
  const entryPath = nodePath.join(dir, 'main.ming');
  if (!fs.existsSync(entryPath)) {
    fs.writeFileSync(entryPath, [
      '// 入口:ming run 即可运行',
      'fn main() with io {',
      '    print("hello, ming");',
      '}',
      '',
    ].join('\n'), 'utf8');
  }
  return { ok: true, manifestPath, entryPath };
}

// ==================== provenance manifest(v1.2.6,R-20/ADR-013)====================
// 证明工件出处清单:与 SMT-LIB 脚本 / 线性证书同为 `ming check --proof-format` 的产物,
// 但作为旁车文件输出,工件字节零变化(docs/proof-protocol.md §4.5)。
//
// 版本(v1.3.1 manifest v2):
//   v2 = v1 的 8 键(原序、原义)**之后**追加第 9 键 `artifacts`,manifest_format 升为 2。
//   artifacts 绑定"manifest ↔ 该次导出实际产出的工件文本字节"(ADR-013 §6 v2 候选 +
//   ADR-014 §9 U8 合流;闭合 v1.3.0 审查登记的 TOCTOU 诚实限制"cert 与 smt-lib 两次独立
//   导出无哈希互绑"的**单次导出**部分——跨导出互绑仍不做,各自 manifest 各自绑定)。
//   smt-lib 模式 obligations 条目形状与 v1 逐字节相同;cert 模式在每条 obligation 上追加
//   `cert: {low, high}`(has_cert/uses_goal/vacuous/reason,与证书文本逐项同源)。
//
// 确定性契约(v1 起冻结;v2 沿袭):
//   - 键序固定(对象字面量插入序 = 协议字段表序)、数组序固定(采集序/首次出现序);
//   - 无时间戳、无主机名、无随机序、不引入绝对路径(源文件路径按命令行展示路径原样回显;
//     项目模式按 ming.toml 所在目录相对化 —— 见 collectSourceEntries);
//   - 同输入 + 同工具版本 → 逐字节相同的 JSON(末尾恰一个 LF)。
// solver 恒 null:那是**消费者回填位**(外部求解器名/版本/结论),Ming 不跑外部求解器、
// 永不填充 —— 不是"尚无结论"的占位断言。

const REPO_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');

// schema 版本:v2(自 v1.3.1)= v1 的 8 键 + 末尾 `artifacts`;字段只增不改。
export const PROVENANCE_FORMAT = 2;
export const PROVENANCE_SPEC = 'ming-proof-protocol/1';
export const PROVENANCE_PASS = 'checkIndexBoundsStatically';
// pass_hash 范围(ADR-013 §2 裁决口径 = 采集相关源文件全集;v1 冻结):
// checker.js 承载采集遍本身(checkIndexBoundsStatically),prover.js 承载逐方向判定,
// proofsmt.js 承载编码/符号面——三者任一变化都可能改变义务集或内部判定。
export const PROVENANCE_PASS_FILES = Object.freeze(['src/checker.js', 'src/prover.js', 'src/proofsmt.js']);
export const PROVENANCE_INTEGER_MODEL = Object.freeze({
  domain: 'Int',
  semantics: 'i64 checked',
  overflow: 'panic M4002',
});
// engine_contract 是自由文本(协议 §4.5 显式标注"非机检"):它陈述工具链的语义合同,
// 不随单次检查计算;版本升级时如需改写须同步协议文档,并视为 manifest 内容变更。
// differential 事实口径(2026-11-27 审查 MINOR-3):4 = 腿数(tree/VM/wasm/cc);
// PR 门禁 = 单种子 44044×25,nightly = 3 seeds×120(CI 实况,不是"4 seeds×40")。
export const PROVENANCE_ENGINE_CONTRACT = Object.freeze({
  eval_order: 'source-order (v1.2.5: #90/#92/#93 materialized)',
  differential: '4 legs × 40 programs (PR: seed 44044 × 25; nightly: 3 seeds × 120)',
});
export const PROVENANCE_HASH_PREFIX = 'sha256:';

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 工件文本 → "sha256:<hex>":哈希对象 = 完整文本的 UTF-8 字节,不做换行/空白规范化
// (文本模式 stdout 的工件部分与 --json 的 proof_smt/proof_cert 字符串是同一构造)。
const hashArtifactText = (text) => PROVENANCE_HASH_PREFIX + sha256Hex(Buffer.from(text, 'utf8'));

// 输出路径与输入/工具链文件重合 → 具名拒绝(否则会静默覆盖源文件)。由 CLI 转述为 exit 1。
export class ProvenancePathCollision extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvenancePathCollision';
  }
}

// Windows 路径比较大小写不敏感(同时覆盖盘符大小写差异);POSIX 原样。
const normPathForCompare = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// 采集 pass 指纹。拼接方案(协议 §4.5,测试独立复算):
//   pass_hash = "sha256:" + sha256( "ming-proof-protocol/1\n"
//                                    + 逐文件(<仓库相对路径> "\n" <文件原始字节的 sha256 十六进制> "\n") )
// 只用仓库相对路径(常量)与文件原始字节——不含绝对路径/时间戳,跨机同内容同值。
export function computePassHash(rootDir = REPO_ROOT) {
  const h = createHash('sha256');
  h.update(PROVENANCE_SPEC + '\n', 'utf8');
  for (const rel of PROVENANCE_PASS_FILES) {
    const bytes = fs.readFileSync(nodePath.join(rootDir, ...rel.split('/')));
    h.update(rel + '\n' + sha256Hex(bytes) + '\n', 'utf8');
  }
  return PROVENANCE_HASH_PREFIX + h.digest('hex');
}

// 源文件集合 = 命令行输入(按命令行顺序)⊕ 本次检查加载的全部模块(含 use 依赖,按加载序)。
// 去重键 = 解析后绝对路径(展示路径可跨目录同名);file 取首次出现的展示路径。
// 项目模式(baseDir = ming.toml 所在目录):file 用**项目相对路径**(正斜杠,不 `..` 逃逸)——
// 否则项目入口的解析后绝对路径会让同一项目在两台机器上 manifest 字节不同(违反协议 §4.5)。
// 哈希用**文件原始字节**(与 git blob 语义同源)。不可读源**跳过**(检查阶段已有 M3022 等
// 诊断;manifest 只列可读源),不让一个坏输入吞掉诊断与脚本。
export function collectProvenanceSources(inputs, checked, baseDir = null) {
  return collectSourceEntries(inputs, checked, baseDir).map(({ file, sha256 }) => ({ file, sha256 }));
}

function sourceDisplayPath(file, abs, baseDir) {
  if (!baseDir) return String(file);
  const rel = nodePath.relative(baseDir, abs);
  if (rel === '' || nodePath.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + nodePath.sep)) {
    return String(file);
  }
  return rel.split(nodePath.sep).join('/');
}

function collectSourceEntries(inputs, checked, baseDir) {
  const out = [];
  const seen = new Set();
  const add = (file, abs) => {
    if (typeof abs !== 'string' || abs === '' || seen.has(abs)) return;
    seen.add(abs);
    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      return; // 不可读源跳过(诊断归检查阶段;manifest 可读源子集)
    }
    out.push({ file: sourceDisplayPath(file, abs, baseDir), abs, sha256: PROVENANCE_HASH_PREFIX + sha256Hex(bytes) });
  };
  for (const f of inputs ?? []) add(f, nodePath.resolve(f));
  for (const r of checked ?? []) {
    for (const m of r?.modules ?? []) add(m.file, m.absPath ?? nodePath.resolve(m.file));
  }
  return out;
}

// 义务条目:采集序(= 脚本块顺序 = collectVcs 去重后顺序);id 方案与 §2 同一方案。
// internal_verdict 携带**内部逐方向判定原值**(proven/refuted/unknown),不做
// solver_status 三态折叠——折叠口径属 --json 诊断面(协议 §4.1),manifest 保留原始判定。
export function buildProvenanceObligations(vcs) {
  return (vcs ?? []).map((vc) => ({
    id: `vc:${vc.fn}:${vc.index}`,
    scope: vc.scope ?? 'body',
    internal_verdict: { low: vc.low, high: vc.high },
  }));
}

// artifacts 字段(manifest v2;键序固定 smt_lib_sha256 → cert_sha256,各自存在才输出)。
// 输入 = 该次导出实际产出的工件**完整文本**(bin 传入与文本模式 stdout / --json
// proof_smt·proof_cert 同一对象);文本为 null/undefined 的工件不出键(未来双导出可并存)。
// 公开导出:入参整体缺省/显式 null 都按空对象处理(CLI 恒传对象;此处只做防御,不改变语义)。
export function buildProvenanceArtifacts(arg) {
  const { smtLibText = null, certText = null } = arg ?? {};
  const out = {};
  if (typeof smtLibText === 'string') out.smt_lib_sha256 = hashArtifactText(smtLibText);
  if (typeof certText === 'string') out.cert_sha256 = hashArtifactText(certText);
  return out;
}

// 证书模式的义务视图(cert 模式追加 `cert: {low, high}`;smt-lib 模式**不**调用本函数,
// obligations 条目形状与 v1 逐字节相同)。逐项与证书文本同源(输入 = proofcert.buildCerts
// 的逐条输出):
//   has_cert = 该方向有可独立复核的证书(refs 为数组)        ← 文本 `; refs:`/`; 无证书:`
//   uses_goal = 是否引用取反目标(协议 §10.4;无证书 = null) ← 文本 `; uses_goal:`(无证书为 n/a)
//   vacuous   = 有效假设集自身不可满足(§10.4;proven 方向恒有值,非 proven = null) ← 文本 `; vacuous:`
//   reason    = 无证书的机器可读标记(refuted/unknown/const-false/...;有证书 = null) ← 文本 `; 无证书:<提示>`
// 形态纪律(2026-11-27 审查 M2):refs 只认**数组**;`refs === null` 是"无证书但视图完好"
// (refuted/unknown 的合法形态,reason 原样携带),refs 缺失/非数组 = 内部一致性缺口
// (即使 `{}` 也不能误报 has_cert,统一具名 'missing' —— 与证书文本的 missing 原因同词)。
function certDirView(dir) {
  if (!dir || typeof dir !== 'object') return { has_cert: false, uses_goal: null, vacuous: null, reason: 'missing' };
  if (!Array.isArray(dir.refs)) {
    if (dir.refs === null) {
      return { has_cert: false, uses_goal: dir.usesGoal ?? null, vacuous: dir.vacuous ?? null, reason: dir.reason ?? 'missing' };
    }
    return { has_cert: false, uses_goal: null, vacuous: null, reason: 'missing' };
  }
  return {
    has_cert: true,
    uses_goal: dir.usesGoal ?? null,
    vacuous: dir.vacuous ?? null,
    reason: dir.reason ?? null,
  };
}

// 完整 manifest 对象(v2)。tool.version 必须由 bin/ming.js 的 VERSION 传入(单一事实来源,
// 不在本模块手抄版本号);其余字段为常量或确定性派生。
// manifestPath(可选):输出路径安全校验 —— 与本次 sources 或工具链 pass 文件重合时抛
// ProvenancePathCollision(静默覆盖源文件 = 数据丢失;CLI 转述为 exit 1 具名)。
// artifacts(可选):{ smtLibText, certText } —— 本次导出实际产出的工件文本(各自存在才出键)。
// certs(可选):cert 模式下 proofcert.buildCerts(vcs) 的逐条输出,与 vcs 一一对应;
//   提供时每条 obligation 追加 `cert: {low, high}`(数量不齐 = 内部一致性缺口,具名抛出)。
export function buildProofManifest({
  toolVersion, inputs, checked, vcs, baseDir = null, manifestPath = null,
  artifacts = null, certs = null,
}) {
  const entries = collectSourceEntries(inputs, checked, baseDir);
  if (typeof manifestPath === 'string' && manifestPath !== '') {
    const outKey = normPathForCompare(nodePath.resolve(manifestPath));
    const hit = entries.find((e) => normPathForCompare(e.abs) === outKey);
    if (hit) {
      throw new ProvenancePathCollision(`--proof-manifest 输出路径 "${manifestPath}" 与检查的源文件 "${hit.file}" 重合;拒绝覆盖(请换一个输出路径)`);
    }
    for (const rel of PROVENANCE_PASS_FILES) {
      if (normPathForCompare(nodePath.join(REPO_ROOT, ...rel.split('/'))) === outKey) {
        throw new ProvenancePathCollision(`--proof-manifest 输出路径 "${manifestPath}" 与工具链源文件 "${rel}" 重合;拒绝覆盖(请换一个输出路径)`);
      }
    }
  }
  const obligations = buildProvenanceObligations(vcs);
  if (Array.isArray(certs)) {
    // 长度平齐守卫(2026-11-27 审查 M3):放在"非空"判断**之外**——空数组 + 非空义务
    // 同样抛具名内部缺口,不静默丢视图。两数组同源于同一份 vcs(bin 的 collectVcs →
    // buildCerts 去重键同口径),数量不一致只可能是内部缺口,按内部错误具名暴露。
    if (certs.length !== obligations.length) {
      throw new Error(`manifest 内部一致性缺口:证书条目数 ${certs.length} 与义务数 ${obligations.length} 不一致(请报告)`);
    }
    for (let i = 0; i < obligations.length; i++) {
      const c = certs[i] ?? {};
      obligations[i].cert = { low: certDirView(c.low), high: certDirView(c.high) };
    }
  }
  return {
    manifest_format: PROVENANCE_FORMAT,
    spec: PROVENANCE_SPEC,
    tool: { name: 'ming', version: String(toolVersion) },
    collection: {
      pass: PROVENANCE_PASS,
      pass_hash: computePassHash(),
      sources: entries.map(({ file, sha256 }) => ({ file, sha256 })),
    },
    integer_model: {
      domain: PROVENANCE_INTEGER_MODEL.domain,
      semantics: PROVENANCE_INTEGER_MODEL.semantics,
      overflow: PROVENANCE_INTEGER_MODEL.overflow,
    },
    engine_contract: {
      eval_order: PROVENANCE_ENGINE_CONTRACT.eval_order,
      differential: PROVENANCE_ENGINE_CONTRACT.differential,
    },
    obligations,
    solver: null,
    // v2 追加键(第 9 键,固定最后):绑定本次导出的工件文本字节;不带工件时为空对象
    // (CLI 不可达——manifest 只与 --proof-format smt-lib|cert 同用,恒有一件)。
    artifacts: buildProvenanceArtifacts(artifacts ?? {}),
  };
}

// 序列化:2 空格缩进 + 末尾恰一个 LF(UTF-8;Node 不做 CRLF 翻译)。
export function serializeProofManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}
