// tests/net_server_child.mjs — 独立 HTTP 服务器子进程(打印端口后保持运行)
import * as http from 'node:http';

const ECHO = process.argv[2] ?? 'ming-net-ok';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(ECHO);
});
server.listen(0, '127.0.0.1', () => {
  console.log('PORT:' + server.address().port);
});
// 保持运行直到 stdin 关闭或收到 kill
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
