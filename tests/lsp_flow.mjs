// 手动全流程测试:initialize + didOpen + didChange + hover + shutdown 一次送入
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = 'C:/code/aicode';
const TMP = fs.mkdtempSync(path.join(process.env.TEMP, 'ming-lsp-'));
const FILE = path.join(TMP, 'sample.ming').replace(/\\/g, '/');
const URI = 'file:///' + FILE;

const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } },
  { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: URI, languageId: 'ming', version: 1, text: 'fn main() with io {\n    let x: i64 = true;\n}\n' } } },
  { jsonrpc: '2.0', id: 2, method: 'textDocument/hover', params: { textDocument: { uri: URI }, position: { line: 0, character: 3 } } },
  { jsonrpc: '2.0', id: 4, method: 'textDocument/hover', params: { textDocument: { uri: URI }, position: { line: 1, character: 8 } } },
  { jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'fn main() with io {\n    let x: i64 = 42;\n}\n' }] } },
  { jsonrpc: '2.0', id: 3, method: 'shutdown', params: null },
  { jsonrpc: '2.0', method: 'exit', params: null },
];

let payload = '';
for (const m of msgs) {
  const body = JSON.stringify(m);
  payload += `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}
fs.writeFileSync(path.join(TMP, 'input.txt'), payload);

const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ming.js'), 'lsp'], {
  input: payload, encoding: 'utf8', timeout: 30000, cwd: ROOT,
});

const out = r.stdout ?? '';
console.log('exit:', r.status, 'stdout bytes:', Buffer.byteLength(out));
// 按 Buffer 分帧(Content-Length 是字节数;字符串含中文时按字符切会截断)
const responses = [];
{
  let buf = Buffer.from(out, 'utf8');
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) break;
    const head = buf.slice(0, sep).toString('utf8');
    const m = head.match(/Content-Length:\s*(\d+)/i);
    if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) break;
    const body = buf.slice(sep + 4, sep + 4 + len).toString('utf8');
    buf = buf.slice(sep + 4 + len);
    try { responses.push(JSON.parse(body)); } catch (e) { console.log('BAD BODY:', body.slice(0, 80)); }
  }
}
console.log('responses:', responses.length);

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('✓', name); }
  else { failed++; console.log('✗', name, detail.slice(0, 200)); }
};

const initR = responses.find(x => x.id === 1);
check('initialize', initR?.result?.capabilities?.hoverProvider === true);
const diagN = responses.find(x => x.method === 'textDocument/publishDiagnostics');
check('诊断推送含 M3002', (diagN?.params?.diagnostics ?? []).some(d => d.code === 'M3002'), JSON.stringify(diagN).slice(0, 200));
const hoverR = responses.find(x => x.id === 2);
const hv = hoverR?.result?.contents?.value ?? '';
check('hover main 签名', hv.includes('fn main() with io'), JSON.stringify(hoverR?.result).slice(0, 150));
const hoverVar = responses.find(x => x.id === 4);
check('hover 覆盖函数体内的行(返回外层声明)', (hoverVar?.result?.contents?.value ?? '').includes('fn main() with io'), JSON.stringify(hoverVar?.result).slice(0, 150));
const shutdownR = responses.find(x => x.id === 3);
check('shutdown 确认', shutdownR !== undefined);
check('exit 代码 0(shutdown 后)', r.status === 0, 'status=' + r.status);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} 通过,${failed} 失败`);
process.exit(failed ? 1 : 0);
