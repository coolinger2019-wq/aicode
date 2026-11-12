// tests/usage_audit.mjs — 宿主工具调用审计(信息性,非 CI 门槛;零依赖)。
//
// 目的:回答社区对"Ming 工具替换率"的质疑——从 ZCode 的模型 I/O 日志
// (~/.zcode/cli/rollout/model-io-sess_<id>.jsonl)统计一次真实会话的
// 宿主工具调用分布与 `ming tools` / tools/*.ming 的使用情况。
//
// 用法:
//   node tests/usage_audit.mjs [rollout.jsonl] [--json]
//   缺省:自动选择 ~/.zcode/cli/rollout 下最新的主会话日志(排除 subagent)。
//
// 输出:宿主调用按工具名计数、Ming 工具调用细分、文件编辑替换率。
// 注意:数字只覆盖该会话的主 agent;子代理各自有独立 rollout 文件。

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function latestRollout() {
  const dir = path.join(os.homedir(), '.zcode', 'cli', 'rollout');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => /^model-io-sess_.*\.jsonl$/.test(f) && !f.includes('subagent'))
    .map(f => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? files[0].f : null;
}

function audit(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const byName = new Map();
  const mingSub = new Map();
  let calls = 0, records = 0, mingCalls = 0, directRuns = 0;
  let mingEditOps = 0, hostEditOps = 0;

  for (const line of lines) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    records++;
    for (const c of j.response?.toolCalls ?? []) {
      calls++;
      const name = c.name ?? c.function?.name ?? '?';
      byName.set(name, (byName.get(name) ?? 0) + 1);
      let args = c.arguments ?? c.input ?? c.function?.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      if (name === 'Bash') {
        const cmd = String(args?.command ?? '');
        // 只认真实调用:`... bin/ming.js tools <cmd>`;避免把文档/echo 中提到的
        // "ming tools ..." 文本误计为调用(此前的 351 次口径同样只数真实调用)。
        const re = /bin\/ming\.js\s+tools\s+([a-z-]+)/g;
        let hit = false, m;
        while ((m = re.exec(cmd))) { hit = true; mingSub.set(m[1], (mingSub.get(m[1]) ?? 0) + 1); }
        if (hit) mingCalls++;
        if (/bin\/ming\.js\s+run\s+tools\/[\w-]+\.ming/.test(cmd)) directRuns++;
        mingEditOps += (cmd.match(/bin\/ming\.js\s+tools\s+(?:patch-all|patch|edit|write|insert|insert-before|del)\b/g) ?? []).length;
      }
      if (name === 'Edit' || name === 'Write') hostEditOps++;
    }
  }
  return {
    file, records, calls,
    byName: Object.fromEntries([...byName.entries()].sort((a, b) => b[1] - a[1])),
    mingCalls, directRuns, mingSub: Object.fromEntries([...mingSub.entries()].sort((a, b) => b[1] - a[1])),
    mingEditOps, hostEditOps,
    editReplacementPct: mingEditOps + hostEditOps ? +(mingEditOps / (mingEditOps + hostEditOps) * 100).toFixed(1) : 0,
  };
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const file = args.find(a => !a.startsWith('--')) ?? latestRollout();
if (!file || !fs.existsSync(file)) {
  process.stderr.write('找不到 rollout 日志;用法: node tests/usage_audit.mjs <rollout.jsonl>\n');
  process.exit(1);
}
const r = audit(file);
if (json) {
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
} else {
  process.stdout.write(`会话日志: ${path.basename(file)}(${r.records} 轮,${r.calls} 次宿主调用)\n`);
  process.stdout.write(`按工具: ${Object.entries(r.byName).map(([k, v]) => `${k}=${v}`).join(', ')}\n`);
  process.stdout.write(`Ming: ${r.mingCalls} 次 ming tools 调用(细分 ${JSON.stringify(r.mingSub)}),${r.directRuns} 次直接 tools/*.ming 运行\n`);
  process.stdout.write(`文件编辑: Ming ${r.mingEditOps} vs 宿主 Edit/Write ${r.hostEditOps} → 替换率 ${r.editReplacementPct}%\n`);
}
