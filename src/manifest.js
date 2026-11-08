// manifest.js — Ming 项目清单(ming.toml)解析与查找(v0.4)。
// Ming 的包管理从最小清单开始:[project] 的 name / version / entry。
// 只解析用到的 TOML 子集:节头 [x]、key = "字符串" | 数字 | true/false、# 注释。

import * as fs from 'node:fs';
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
