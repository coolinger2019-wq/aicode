// tests/net_e2e.mjs — std.net 端到端测试(独立子进程 HTTP 服务器,避免与阻塞的主线程死锁)
// v0.77 校准(ADR-007 清单 8):http_get/http_request 响应 body 翻转 → Untrusted[str];插值
// \{body} 是 M3050 洗白禁面 → 改拼接传播 + print 出向透传(ADR-007 §8.1)。期望 stdout 逐字不变。
// v0.82 校准(ADR-008):main args 翻转为 Vec[Untrusted[str]];URL 载荷不可经
// sanitize_cli_path(URL 含 "//" 内部空段被拒)——采 parse_i64 端口惯用法:argv 位置 0
// 为端口号,污点在数值校验上终结得净 i64,URL 由净部件重组(127.0.0.1 固定回环 +
// str(port) + 净路径)。期望 stdout 逐字不变。
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
  'use std.unstr;',
  '',
  // v0.82(ADR-008):argv[0] = 端口号(parse_i64 数值校验终结污点);URL 净部件重组
  'fn main(args: Vec[Untrusted[str]]) with io, net {',
  '    match args[0].parse_i64() {',
  '        Ok(port) => {',
  '            let url = "http://127.0.0.1:" + str(port) + "/hello";',
  '            match std.net.http_get(url) {',
  '                Ok((status, body)) => print(str(status) + " " + body),',
  '                Err(e)             => print("请求失败: " + e),',
  '            }',
  '        },',
  '        Err(_) => { print("请求失败: port"); },',
  '    }',
  '}',
  '',
].join('\n');
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
    args.push('--', String(port));
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
    check(`net:http_get 端到端(${engine})`, r.status === 0 && r.stdout === '200 ming-net-ok\n',
      `code=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${(r.stderr ?? '').slice(0, 300)}`);
  }

  // http_request:POST + 自定义头 + 体(回显服务器验证)
  const postProg = path.join(TMP, 'netpost.ming');
  fs.writeFileSync(postProg, [
    'use std.net;',
    'use std.unstr;',
    '',
    // v0.82(ADR-008):argv[0] = 端口号(parse_i64 数值校验终结污点);URL 净部件重组
    'fn main(args: Vec[Untrusted[str]]) with io, net {',
    '    let mut port = 0;',
    '    match args[0].parse_i64() { Ok(p) => { port = p; }, Err(_) => {} }',
    '    let url = "http://127.0.0.1:" + str(port) + "/echo";',
    '    let headers = {"x-ming": "v07"};',
    '    match std.net.http_request("POST", url, headers, "ming-body") {',
    '        Ok((status, body)) => print(str(status) + " " + body),',
    '        Err(e)             => print("请求失败: " + e),',
    '    }',
    '}',
    '',
  ].join('\n'), 'utf8');
  for (const engine of ['vm', 'tree']) {
    const args = [path.join(ROOT, 'bin', 'ming.js'), 'run', postProg];
    if (engine === 'tree') args.push('--tree');
    args.push('--', String(echoPort));
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
