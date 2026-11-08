// lsp.js — Ming 语言服务器(v0.4,stdio JSON-RPC)。
// 能力:诊断推送(didOpen/didChange → publishDiagnostics)、hover(签名 + /// 文档)。
// 简洁优先:每次变更全量重查文件(含其本地导入),对几十 KB 源文件足够快。

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { Checker } from './checker.js';
import { parse, attachDocs } from './parser.js';

function sigType(t) {
  switch (t?.nt) {
    case 'TName': return t.name + (t.args.length ? `[${t.args.map(sigType).join(', ')}]` : '');
    case 'TTuple': return `(${t.ts.map(sigType).join(', ')})`;
    case 'TFn': return `(${t.ps.map(sigType).join(', ')}) -> ${sigType(t.ret)}`;
    default: return '?';
  }
}

function itemSignature(it) {
  switch (it.nt) {
    case 'FnDecl': {
      const tps = it.tparams?.length ? `[${it.tparams.join(', ')}]` : '';
      const params = it.params.map(p => p.self ? (p.mut ? 'mut self' : 'self') : `${p.name}: ${sigType(p.type)}`).join(', ');
      const eff = it.effects?.length ? ` with ${it.effects.map(e => e.name).join(', ')}` : '';
      return `fn ${it.name}${tps}(${params})${it.ret ? ' -> ' + sigType(it.ret) : ''}${eff}`;
    }
    case 'StructDecl': return `struct ${it.name} { ${it.fields.map(f => `${f.name}: ${sigType(f.type)}`).join(', ')} }`;
    case 'EnumDecl': return `enum ${it.name} { ${it.variants.map(v => v.name + (v.types.length ? `(${v.types.map(sigType).join(', ')})` : '')).join(', ')} }`;
    case 'ConstDecl': return `const ${it.name}${it.type ? ': ' + sigType(it.type) : ''}`;
    default: return null;
  }
}

function collectHoverables(file, src) {
  const { program, comments, diags } = parse(file, src);
  if (diags.length) return [];
  attachDocs(program.items, comments);
  const out = [];
  for (const it of program.items) {
    const sig = itemSignature(it);
    if (!sig) continue;
    out.push({ span: it.span, sig, docs: it.docs ?? [] });
    if (it.nt === 'StructDecl') {
      for (const f of it.fields) out.push({ span: f.span, sig: `${f.name}: ${sigType(f.type)}`, docs: [] });
    }
  }
  return out;
}

function posInSpan(span, line0, col0) {
  if (!span) return false;
  const line = line0 + 1, col = col0 + 1;
  if (line < span.line || line > span.endLine) return false;
  if (line === span.line && col < span.col) return false;
  if (line === span.endLine && col > span.endCol) return false;
  return true;
}

function diagnosticsFor(uri, text) {
  const file = uriToFile(uri);
  const normFile = nodePath.normalize(nodePath.resolve(file));
  // 缓冲区内容优先(编辑器未保存状态);其他文件读磁盘。
  // 注意 Checker 会把入口 resolve 成绝对路径(Windows 反斜杠),必须规范化比较。
  const readFile = (p) => (nodePath.normalize(nodePath.resolve(p)) === normFile ? text : nodeFs.readFileSync(p, 'utf8'));
  const checker = new Checker(file, readFile);
  let result;
  try {
    result = checker.run();
  } catch (e) {
    return (e.diags ?? []).map(d => diagToLsp(d, file));
  }
  const normSpanFile = (f) => nodePath.normalize(nodePath.resolve(f ?? file));
  return result.diags
    .filter(d => normSpanFile(d.span?.file) === normFile)
    .map(d => diagToLsp(d, file));
}

function diagToLsp(d, file) {
  const line = Math.max(0, (d.span?.line ?? 1) - 1);
  const col = Math.max(0, (d.span?.col ?? 1) - 1);
  const endLine = Math.max(0, (d.span?.endLine ?? d.span?.line ?? 1) - 1);
  const endCol = Math.max(0, (d.span?.endCol ?? d.span?.col ?? 1) - 1);
  return {
    range: { start: { line, character: col }, end: { line: endLine, character: endCol } },
    severity: d.severity === 'warning' ? 2 : 1,
    code: d.code,
    source: 'ming',
    message: d.message + (d.hint ? `\nhint: ${d.hint}` : ''),
  };
}

function uriToFile(uri) {
  if (uri.startsWith('file:///')) return decodeURIComponent(uri.slice('file:///'.length));
  if (uri.startsWith('file://')) return decodeURIComponent(uri.slice('file://'.length));
  return uri;
}

class LspServer {
  constructor(input = process.stdin, output = process.stdout) {
    this.input = input;
    this.output = output;
    this.buffer = '';
    this.docs = new Map(); // uri → text
    this.shutdown = false;
  }

  send(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  reply(id, result) {
    const body = JSON.stringify({ jsonrpc: '2.0', id, result });
    this.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  handleError(id, code, message) {
    const body = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    this.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  publishDiagnostics(uri) {
    const text = this.docs.get(uri);
    if (text === undefined) return;
    let diags = [];
    try {
      diags = diagnosticsFor(uri, text);
    } catch {
      diags = [];
    }
    this.send('textDocument/publishDiagnostics', { uri, diagnostics: diags });
  }

  onMessage(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize':
        this.reply(id, {
          capabilities: { textDocumentSync: 1, hoverProvider: true },
          serverInfo: { name: 'ming-lsp', version: '0.4.0' },
        });
        return;
      case 'initialized': return;
      case 'shutdown':
        this.shutdown = true;
        this.reply(id, null);
        return;
      case 'exit':
        process.exit(this.shutdown ? 0 : 1);
        return;
      case 'textDocument/didOpen': {
        const { uri, text } = params.textDocument;
        this.docs.set(uri, text);
        this.publishDiagnostics(uri);
        return;
      }
      case 'textDocument/didChange': {
        const { uri } = params.textDocument;
        const last = params.contentChanges[params.contentChanges.length - 1];
        if (last?.text !== undefined) {
          this.docs.set(uri, last.text);
          this.publishDiagnostics(uri);
        }
        return;
      }
      case 'textDocument/didClose':
        this.docs.delete(params.textDocument.uri);
        return;
      case 'textDocument/hover': {
        const { uri } = params.textDocument;
        const text = this.docs.get(uri) ?? '';
        const { line, character } = params.position;
        try {
          const items = collectHoverables(uriToFile(uri), text);
          const hit = items.find(it => posInSpan(it.span, line, character));
          if (hit) {
            const value = ['```ming', hit.sig, '```', ...(hit.docs.length ? ['', hit.docs.map(d => d.replace(/^\/+/, '').trim()).join('\n')] : [])].join('\n');
            this.reply(id, { contents: { kind: 'markdown', value } });
            return;
          }
        } catch { /* 语法错误时无 hover */ }
        this.reply(id, null);
        return;
      }
      default:
        if (id !== undefined) this.handleError(id, -32601, `method not found: ${method}`);
        return;
    }
  }

  start() {
    this.input.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      if (process.env.MING_LSP_TRACE === '1') {
        process.stderr.write('[lsp] chunk=' + JSON.stringify(chunk.toString('utf8')).slice(0, 120) + ' bufLen=' + this.buffer.length + '\n');
      }
      for (;;) {
        const sep = this.buffer.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const head = this.buffer.slice(0, sep);
        const m = head.match(/Content-Length:\s*(\d+)/i);
        if (!m) { this.buffer = this.buffer.slice(sep + 4); continue; }
        const len = Number(m[1]);
        const total = sep + 4 + len;
        if (this.buffer.length < total) return;
        const body = this.buffer.slice(sep + 4, total);
        this.buffer = this.buffer.slice(total);
        try {
          const msg = JSON.parse(body);
          this.onMessage(msg);
        } catch (e) {
          process.stderr.write('LSP handler error: ' + (e?.stack ?? e) + '\n');
          this.handleError(msg?.id, -32603, 'internal error');
        }
      }
    });
    // stdin EOF 后短暂存活,确保未冲刷的响应写出(管道场景)
    this.input.on('end', () => setTimeout(() => process.exit(this.shutdown ? 0 : 1), 100));
    this.input.resume();
  }
}

export function startLsp() {
  new LspServer().start();
}
