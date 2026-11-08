// tests/net_e2e.mjs — std.net 端到端测试(独立子进程 HTTP 服务器,避免与阻塞的主线程死锁)
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-net-'));
const prog = path.join(TMP, 'nettest.ming');

const src = [
  'use std.net;',
  '',
  'fn main(args: Vec[str]) with io, net {',
  '    let url = args[0];',
  '    match std.net.http_get(url) {',
  '        Ok((status, body)) => print("\\u005c{status} \\u005c{body}"),',
  '        Err(e)             => print("请求失败: " + e),',
  '    }',
  '}',
  '',
].join('\n').replace(/\\u005c/g, '\\');
fs.writeFileSync(prog, src, 'utf8');

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('✓', name); }
  else { failed++; console.log('✗', name, detail.slice(0, 250)); }
};

// 独立服务器子进程:打印 PORT:xxxx 后保持运行;POST 端点回显方法/头/体
const serverChild = spawn(process.execPath, [path.join(ROOT, 'tests', 'net_server_child.mjs'), 'ming-net-ok'], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
});
// 追加 POST 回显服务器(第二个子进程)
const echoServer = spawn(process.execPath, ['-e', `
import * as http from 'node:http';
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(req.method + '|' + (req.headers['x-ming'] ?? '-') + '|' + b);
  });
});
server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

const waitPort = (child) => new Promise((resolve, reject) => {
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    const m = buf.match(/PORT:(\d+)/);
    if (m) { child.stdout.off('data', onData); resolve(Number(m[1])); }
  };
  child.stdout.on('data', onData);
  child.on('exit', () => reject(new Error('server exited early')));
  setTimeout(() => reject(new Error('server start timeout')), 10000);
});

const port = await waitPort(serverChild);
const echoPort = await waitPort(echoServer);

try {
  for (const engine of ['vm', 'tree']) {
    const args = [path.join(ROOT, 'bin', 'ming.js'), 'run', prog];
    if (engine === 'tree') args.push('--tree');
    args.push('--', `http://127.0.0.1:${port}/hello`);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
    check(`net:http_get 端到端(${engine})`, r.status === 0 && r.stdout === '200 ming-net-ok\n',
      `code=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${(r.stderr ?? '').slice(0, 300)}`);
  }

  // http_request:POST + 自定义头 + 体(回显服务器验证)
  const postProg = path.join(TMP, 'netpost.ming');
  fs.writeFileSync(postProg, [
    'use std.net;',
    '',
    'fn main(args: Vec[str]) with io, net {',
    '    let headers = {"x-ming": "v07"};',
    '    match std.net.http_request("POST", args[0], headers, "ming-body") {',
    '        Ok((status, body)) => print("\\u005c{status} \\u005c{body}"),',
    '        Err(e)             => print("请求失败: " + e),',
    '    }',
    '}',
    '',
  ].join('\n').replace(/\\u005c/g, '\\'), 'utf8');
  for (const engine of ['vm', 'tree']) {
    const args = [path.join(ROOT, 'bin', 'ming.js'), 'run', postProg];
    if (engine === 'tree') args.push('--tree');
    args.push('--', `http://127.0.0.1:${echoPort}/echo`);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
    check(`net:http_request POST(${engine})`, r.status === 0 && r.stdout === '200 POST|v07|ming-body\n',
      `code=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${(r.stderr ?? '').slice(0, 300)}`);
  }
} finally {
  serverChild.kill();
  echoServer.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}

process.stderr.write(`\n${passed} 通过,${failed} 失败\n`);
process.exit(failed ? 1 : 0);
