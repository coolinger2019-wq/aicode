// tests/run.mjs — Ming 工具链回归测试(零依赖)。
// 覆盖:示例黄金输出、诊断码回归、运行时 panic 行为、fmt 幂等性、JSON 协议、值语义。
// 分节索引(v0.56 #34):分节号唯一、不复用。历史 v0.39–v0.43 块与更早的 v0.34–v0.38
// 曾共用 34–38,现以 34b–38b 区分;§39 = v0.44,§40 = v0.45 契约系统(文档引用沿用)。
// 后续新分节从 §60 起按序分配;`§N` 与 `N.` 是同一编号的两种写法,不另设第二套编号。

import { execFileSync, spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeSummaries } from '../src/prover.js';
import { completionFor, definitionFor, documentSymbolsFor } from '../src/lsp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-tests-'));

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed++; }
  else { failed++; failures.push({ name, detail }); process.stderr.write(`✗ ${name}\n${detail ? '    ' + detail.split('\n').join('\n    ') + '\n' : ''}`); }
}

function runMing(args, opts = {}) {
  // v0.53 审查修复:默认剥掉 MING_WASM_STRICT——开发者 shell 导出该变量后整套用例
  // 会被当成 strict 模式(回落 exit 2)而大面积假失败。需要注入的用例显式传 env。
  const env = { ...process.env, ...(opts.env ?? {}) };
  if (!opts.env || !Object.prototype.hasOwnProperty.call(opts.env, 'MING_WASM_STRICT')) delete env.MING_WASM_STRICT;
  const r = spawnSync(process.execPath, [MING, ...args], {
    encoding: 'utf8',
    input: opts.stdin ?? '',
    cwd: opts.cwd ?? ROOT,
    env,
    timeout: 30000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function mingFile(name, src) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, src, 'utf8');
  return p;
}

// ===================== 1. 示例黄金输出 =====================
const GOLDEN = {
  'hello.ming': '你好, 世界!\n1..11 的和是 55\n',
  'fizzbuzz.ming': '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n',
  'fib.ming': Array.from({ length: 11 }, (_, i) => `fib(${i}) = ${[0,1,1,2,3,5,8,13,21,34,55][i]}`).join('\n') + '\n',
  'shapes.ming': '3.141592653589793\n10.0\n一个点\n',
  'results.ming': '10, 20 → x=10, y=20\n1,2,3 → 错误: 需要恰好两个数字,逗号分隔\nabc → 错误: 需要恰好两个数字,逗号分隔\n10 / 2 = 5\n7 / 0 = 除零\n',
  'closures.ming': '翻倍: [10, 6, 16, 2, 18, 4]\n偶数: [8, 2]\n求和: 28\n降序: [9, 8, 5, 3, 2, 1]\n字典序: apple, banana, cherry\nadd_base(5) = 105\n',
  'wordcount.ming': 'the: 3\nquick: 1\nbrown: 1\nfox: 2\njumps: 1\nover: 1\nlazy: 1\ndog: 1\n共 11 个词, 8 个不同\n',
  'numbers.ming': 'i64.max = 9223372036854775807\nu8.max  = 255\n300.to_u8() = None\n200.to_u8() = Some(200)\n解析成功: 42\n解析失败: 不是有效的整数: "4x2"\n',
  'generics.ming': 'Some("a")\n[42, 42]\nq.left = "one", q.right = 1\n',
  'traits.ming': 'p = (1.5, -2.0)\np.eq((1.5, -2.0)) = true\n找到,下标 1\n圆面积 = 12.566370614359172\n',
  'effects.ming': '你好,Ming\n1 → 2\n10 → 20\n100 → 200\nLIMIT = 3, t0 = true\n',
  'json_demo.ming': 'name = Some("ming")\nversion = 10.0\ntags[0] = "fast"\nmeta.ok = true\nmissing = None\n{"host":"127.0.0.1","port":"8080"}\n[1.5,2.5]\nnull\n{"name":"ming","version":10,"tags":["fast","safe"],"meta":{"ok":true}}\n错误: JSON 语法错误(位置 7): 无效的数字\n',
  'generics_impl.ming': 'true\nfalse\n(1, one)\n0\n1\n9\napple\napple x3 | pear x7\n',
  'modules.ming': 'a 到 b 的距离 = 5.0\n中点 = Point{x: 1.5, y: 2.0}\n线段长度 = 5.0\n',
};

for (const [file, expected] of Object.entries(GOLDEN)) {
  const r = runMing(['run', path.join(ROOT, 'examples', file)]);
  check(`golden:${file}`, r.code === 0 && r.stdout === expected,
    `code=${r.code}\n--- 期望 ---\n${JSON.stringify(expected)}\n--- 实际 ---\n${JSON.stringify(r.stdout)}\n${r.stderr}`);
  // 双引擎一致性:树遍历引擎(--tree)必须产出相同结果
  const rt = runMing(['run', path.join(ROOT, 'examples', file), '--tree']);
  check(`golden-tree:${file}`, rt.code === 0 && rt.stdout === expected,
    `code=${rt.code} stdout=${JSON.stringify(rt.stdout.slice(0, 80))} stderr=${rt.stderr.slice(0, 120)}`);
}

// ===================== 2. 诊断码回归 =====================
const DIAG_CASES = [
  // [说明, 源码, 期望错误码, 是否运行期]
  ['无隐式真值化', 'fn main() { let x = 1; if x { print("y"); } }', 'M3014', false],
  ['无 null', 'fn main() { let x = null; }', 'M1006', false],
  ['整数宽度不匹配', 'fn main() { let a = 1; let b: i32 = 2; print(str(a + b)); }', 'M3013', false],
  ['类型不匹配', 'fn main() { let x: i64 = "s"; }', 'M3002', false],
  ['不可变赋值', 'fn main() { let x = 1; x = 2; }', 'M3004', false],
  ['缺少字段', 'struct P { x: i64, } fn main() { let p = P { }; }', 'M3027', false],
  ['未知字段', 'struct P { x: i64, } fn main() { let p = P { y: 1 }; }', 'M3006', false],
  ['match 不穷尽', 'enum E { A, B } fn f(e: E) -> i64 { match e { E.A => 1 } return 0; } fn main() { print(str(f(E.A))); }', 'M3007', false],
  ['索引越界(运行时)', 'fn main() with io { let v = [1]; print(str(v[5])); }', 'M4003', true],
  ['整数溢出 panic', 'fn main() with io { let m = i64.max_value(); print(str(m + 1)); }', 'M4002', true],
  ['除零 panic', 'fn main() with io { let a = 1; let b = 0; print(str(a / b)); }', 'M4004', true],
  ['map 缺键 panic', 'fn main() with io { let m = {"k": 1}; print(str(m["x"])); }', 'M4007', true],
  ['unwrap None panic', 'fn main() with io { let x: Option[i64] = None; print(str(x.unwrap())); }', 'M4006', true],
  ['?: 需要函数返回 Option/Result', 'fn f() -> i64 { let x = None?; return x; } fn main() { print(str(f())); }', 'M3002', false],
  ['泛型参数上无运算', 'fn double[T](x: T) -> T { return x + x; } fn main() { print(str(double(2))); }', 'M3018', false],
  ['同层遮蔽禁止', 'fn main() { let x = 1; let x = 2; }', 'M3016', false],
  ['break 在循环外', 'fn main() { break; }', 'M3010', false],
  ['缺 return', 'fn f() -> i64 { } fn main() { print(str(f())); }', 'M3017', false],
  ['str 不能索引', 'fn main() with io { let s = "abc"; print(str(s[0])); }', 'M3020', false],
  ['? 插值非原始类型', 'struct P { x: i64, } fn main() { let p = P { x: 1 }; print("\\{p}"); }', 'M3012', false],
  ['缺少 main(run 需要)', 'fn helper() { }', 'M3023', true],
  ['浮点 == 警告', 'fn main() { let a = 1.0; let b = 1.0; if a == b { print("eq"); } }', 'W3102', false],
  ['比较链禁止', 'fn main() { let a = 1; let b = 2; let c = 3; if a < b < c { print("y"); } }', 'M2005', false],
  ['闭包捕获按值不可赋值', 'fn main() { let x = 1; let f = () => { x = 2; }; }', 'M3004', false],
  ['const 只接受常量表达式', 'fn f() -> i64 { return 1; } const X = f(); fn main() with io { print(str(X)); }', 'M3031', false],
  ['const 循环定义', 'const A = B + 1; const B = A + 1; fn main() with io { print(str(A)); }', 'M3031', false],
  ['print 需要 io 效果', 'fn main() { print("x"); }', 'M3029', false],
  ['未知效果名', 'fn main() with teleport { print("x"); }', 'M3030', false],
  ['纯函数不能调用 io 函数', 'fn a() with io { print("x"); } fn b() { a(); } fn main() with io { b(); }', 'M3029', false],
  ['now_ms 需要 time 效果', 'fn main() with io { let t = std.time.now_ms(); print(str(t > 0)); }', 'M3029', false],
  ['常量不可赋值', 'const C = 1; fn main() with io { C = 2; }', 'M3004', false],
  ['impl 缺少方法', 'trait T2 { fn m(self) -> i64; } struct S { x: i64, } impl T2 for S { } fn main() with io { print("x"); }', 'M3032', false],
  ['impl 方法签名不符', 'trait T3 { fn m(self, v: i64) -> i64; } struct S2 { x: i64, } impl T3 for S2 { fn m(self, v: str) -> i64 { return 1; } } fn main() with io { print("x"); }', 'M3002', false],
  ['bound 不满足', 'struct S3 { x: i64, } fn find[T: Eq](v: Vec[T], x: T) -> Option[i64] { return None; } fn main() with io { let r = find([S3 { x: 1 }], S3 { x: 1 }); print(str(r.is_none())); }', 'M3032', false],
  ['未知 trait bound', 'fn g[T: Nope](x: T) -> T { return x; } fn main() with io { print(str(g(1))); }', 'M3032', false],
  ['mut self 方法修改生效', 'struct Box2 { v: i64, } trait Bump { fn bump(mut self) -> (); } impl Bump for Box2 { fn bump(mut self) -> () { self.v = self.v + 1; } } fn main() with io { let mut b = Box2 { v: 1 }; b.bump(); print(str(b.v)); }', null, false, '2\n'],
  ['非 mut self 不可赋值', 'struct Box3 { v: i64, } trait T4 { fn f(self) -> (); } impl T4 for Box3 { fn f(self) -> () { self.v = 1; } } fn main() with io { print("x"); }', 'M3004', false],
  ['const 可用', 'const C = 21; fn main() with io { print(str(C * 2)); }', null, false, '42\n'],
  ['2^53 边界快慢路径一致', 'fn main() with io { let a = 9007199254740991; print(str(a + 1)); print(str(a + 2)); print(str(a + 2 - 2)); print(str(a * 2)); }', null, false, '9007199254740992\n9007199254740993\n9007199254740991\n18014398509481982\n'],
  ['i64 溢出双向', 'fn main() with io { let m = i64.max_value(); print(str(m + 1 == m)); }', 'M4002', true],
  ['泛型 impl bound 不满足', 'struct P2[A, B] { l: A, r: B, } trait T5 { fn m(self) -> i64; } impl[A: Eq] T5 for P2[A, B] { fn m(self) -> i64 { return 1; } } fn main() with io { print("x"); }', 'M3032', false],
  ['泛型 impl 结构化 Eq 递归', 'struct P3[A, B] { l: A, r: B, } impl[A: Eq, B: Eq] Eq for P3[A, B] { fn eq(self, other: Self) -> bool { return true; } } struct Bad { x: i64, } fn find[T: Eq](v: Vec[T]) -> i64 { return 0; } fn main() with io { let v: Vec[P3[i64, Bad]] = [P3 { l: 1, r: Bad { x: 1 } }]; print(str(find(v))); }', 'M3032', false],
  ['Vec.min 需要元素实现 Compare', 'struct NoCmp { x: i64, } fn main() with io { let v: Vec[NoCmp] = [NoCmp { x: 1 }]; print(str(v.min().is_none())); }', 'M3032', false],
  ['json.stringify 拒绝结构体', 'struct S9 { x: i64, } fn main() with io { let s = S9 { x: 1 }; print(std.json.stringify(s)); }', 'M3033', false],
  ['json.parse 非法输入返回 Err', 'fn main() with io { print(str(std.json.parse("{").is_err())); }', null, false, 'true\n'],
  ['time.sleep 睡眠', 'fn main() with io, time { std.time.sleep(10); print("done"); }', null, false, 'done\n'],
  ['u64 大值往返', 'fn main() with io { let u = u64.max_value(); let one = 1u64; print(str(u - one)); print(str(u == u64.max_value())); }', null, false, '18446744073709551614\ntrue\n'],
];

DIAG_CASES.forEach(([desc, src, code, runtime, expectedOut], idx) => {
  const p = mingFile(`diag-${code ?? 'ok'}-${idx}.ming`, src);
  if (code === null) {
    // 正向用例:必须编译通过并产出期望输出
    const r = runMing(['run', p]);
    check(`diag:${desc}`, r.code === 0 && r.stdout === expectedOut,
      `code=${r.code} stdout=${JSON.stringify(r.stdout)} stderr=${r.stderr}`);
    return;
  }
  const cmd = runtime ? 'run' : 'check';
  const r = runMing([cmd, p, '--json']);
  let found = false;
  try {
    const j = JSON.parse(r.stdout);
    found = (j.diagnostics ?? []).some(d => d.code === code &&
      (code.startsWith('W') ? d.severity === 'warning' : d.severity === 'error'));
  } catch { /* ignore */ }
  check(`diag:${desc}(${code})`, found, `cmd=${cmd}\nstdout=${r.stdout.slice(0, 400)}\nstderr=${r.stderr.slice(0, 200)}`);
});

// ===================== 3. 运行时行为(panic 细节 / 退出码)====================
{
  const p = mingFile('panic-overflow.ming', 'fn main() with io { let m = i64.max_value(); print(str(m + 1)); }');
  const r = runMing(['run', p]);
  check('panic:溢出退出码 101', r.code === 101, `code=${r.code} stderr=${r.stderr}`);
  check('panic:输出含错误码与位置', r.stderr.includes('M4002') && r.stderr.includes('panic-overflow.ming:1:'), r.stderr);
}
{
  const p = mingFile('panic-stack.ming', 'fn f(n: i64) -> i64 { return f(n + 1); } fn main() with io { print(str(f(0))); }');
  const r = runMing(['run', p]);
  check('panic:栈溢出可控(M4005,不是崩溃)', r.code === 101 && r.stderr.includes('M4005'), `code=${r.code} stderr=${r.stderr.slice(0, 200)}`);
}
{
  const p = mingFile('exit-code.ming', 'fn main() -> i64 { return 7; }');
  const r = runMing(['run', p]);
  check('main 返回 i64 作为退出码', r.code === 7, `code=${r.code}`);
}
{
  const p = mingFile('args.ming', 'fn main(args: Vec[str]) with io { print(str(args.len())); print(args[0]); }');
  const r = runMing(['run', p, '--', 'hello', 'world']);
  check('main 接收 argv', r.code === 0 && r.stdout === '2\nhello\n', `stdout=${JSON.stringify(r.stdout)}`);
}

// ===================== 4. 值语义(无别名)====================
{
  const p = mingFile('value-semantics.ming', `
fn mutate(mut v: Vec[i64]) {
    v.push(99);
}

fn main() with io {
    let mut a = [1, 2, 3];
    let b = a;
    mutate(a);
    print(str(a.len()));
    print(str(b.len()));

    let mut m = {"x": 1};
    let n = m;
    m.set("y", 2);
    print(str(n.len()));

    let p = (a, b);
    let (pa, pb) = p;
    print(str(pa.len()));
}
`);
  const r = runMing(['run', p]);
  check('值语义:赋值/传参深拷贝', r.code === 0 && r.stdout === '3\n3\n1\n3\n',
    `code=${r.code} stdout=${JSON.stringify(r.stdout)} stderr=${r.stderr}`);
}

// ===================== 5. fmt 幂等性与可编译性 =====================
{
  // 复制 examples 到临时目录(保持多文件模块的相对引用),原位格式化
  const fmtDir = path.join(TMP, 'fmt');
  fs.mkdirSync(fmtDir, { recursive: true });
  for (const file of fs.readdirSync(path.join(ROOT, 'examples'))) {
    if (file.endsWith('.ming')) fs.copyFileSync(path.join(ROOT, 'examples', file), path.join(fmtDir, file));
  }
  for (const file of fs.readdirSync(fmtDir)) {
    const fp = path.join(fmtDir, file);
    const f1 = runMing(['fmt', fp]);
    check(`fmt:${file} 解析成功`, f1.code === 0, f1.stderr);
    if (f1.stdout !== '') fs.writeFileSync(fp, f1.stdout, 'utf8');
    // 幂等:对已格式化文件再次 fmt,应当报告"已是规范格式"
    const f2 = runMing(['fmt', fp, '--check']);
    check(`fmt:${file} 幂等`, f2.code === 0, f2.stderr + f2.stdout);
    const rr = runMing(['check', fp]);
    check(`fmt:${file} 格式化后可编译`, rr.code === 0, rr.stderr);
    // 格式化后行为不变(run 输出一致)
    // v0.54 审查 M6:同时断言退出码与 stderr 首行(unsafe_demo 在 tree/VM 是 M4016 panic,
    // stdout 恒为空;只比 stdout 会空转)。
    const origRun = runMing(['run', path.join(ROOT, 'examples', file)]);
    const fmtRun = runMing(['run', fp]);
    const normHead = (s, f) => (s ?? '').split('\n')[0].split(path.resolve(f)).join('<file>').split(f).join('<file>');
    const sameExit = origRun.code === fmtRun.code;
    const sameOut = origRun.stdout === fmtRun.stdout;
    const sameErrHead = normHead(origRun.stderr, path.join(ROOT, 'examples', file)) === normHead(fmtRun.stderr, fp);
    check(`fmt:${file} 运行结果不变`, sameOut && sameExit && sameErrHead,
      `orig=${JSON.stringify(origRun.stdout)} fmt=${JSON.stringify(fmtRun.stdout)} code=${origRun.code}/${fmtRun.code}`
      + ` errHead=${JSON.stringify((origRun.stderr ?? '').split('\n')[0])}/${JSON.stringify((fmtRun.stderr ?? '').split('\n')[0])}`);
  }
}

// ===================== 6. JSON 协议 =====================
{
  const r = runMing(['run', path.join(ROOT, 'examples', 'hello.ming'), '--json']);
  const j = JSON.parse(r.stdout);
  check('json:run 结构', j.ok === true && j.exit_code === 0 && j.stdout.includes('你好, 世界!'), JSON.stringify(j).slice(0, 200));
}
{
  const p = mingFile('bad.ming', 'fn main() { let x: i64 = true; }');
  const r = runMing(['check', p, '--json']);
  const j = JSON.parse(r.stdout);
  check('json:check 结构', j.ok === false && j.diagnostics[0].code === 'M3002' && j.diagnostics[0].line === 1, JSON.stringify(j).slice(0, 300));
}
{
  const r = runMing(['run', path.join(ROOT, 'examples', 'fib.ming'), '--json']);
  const j = JSON.parse(r.stdout);
  check('json:run 捕获 stdout', j.stdout === GOLDEN['fib.ming'], JSON.stringify(j).slice(0, 200));
}

// ===================== 7. 多文件与可见性 =====================
{
  const dir = path.join(TMP, 'modtest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib.ming'), 'pub fn half(x: i64) -> i64 { x / 2 }\nfn secret() -> i64 { 1 }\n', 'utf8');
  const mainP = path.join(dir, 'main.ming');
  fs.writeFileSync(mainP, 'use lib;\nfn main() with io { print(str(lib.half(9))); }\n', 'utf8');
  const r = runMing(['run', mainP]);
  check('模块:pub 函数可调用', r.code === 0 && r.stdout === '4\n', `stdout=${JSON.stringify(r.stdout)} stderr=${r.stderr}`);

  const badP = path.join(dir, 'bad.ming');
  fs.writeFileSync(badP, 'use lib;\nfn main() with io { print(str(lib.secret())); }\n', 'utf8');
  const r2 = runMing(['check', badP, '--json']);
  const j2 = JSON.parse(r2.stdout);
  check('模块:非 pub 不可见', j2.ok === false && j2.diagnostics.some(d => d.code === 'M3001'), r2.stdout.slice(0, 300));
}

// ===================== 8. LSP 协议(子进程,同步消息流)=====================
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'lsp_flow.mjs')], { encoding: 'utf8', timeout: 60000 });
  check('lsp:全流程(initialize/诊断/hover/shutdown)', r.status === 0, (r.stdout + r.stderr).slice(0, 300));
}

// ===================== 9. capability 文件系统(std.fs)=====================
{
  // 效果强制:未声明 fs 效果不得触碰文件系统
  const p = mingFile('fs-cap.ming', 'use std.fs;\nfn main() with io { print(str(std.fs.exists("x"))); }');
  const rc = runMing(['check', p, '--json']);
  const jc = JSON.parse(rc.stdout);
  check('fs:效果强制(M3029)', jc.ok === false && jc.diagnostics.some(d => d.code === 'M3029'), rc.stdout.slice(0, 300));

  // 端到端:临时目录内 写入→读取→列目录→清理
  const fsDir = path.join(TMP, 'fsdemo');
  fs.mkdirSync(fsDir, { recursive: true });
  const prog = path.join(fsDir, 'fs_demo_prog.ming');
  fs.writeFileSync(prog, `
use std.fs;

fn main() with io, fs {
    match std.fs.write_file("data.txt", "hello ming\\n") {
        Ok(_)   => print("写入成功"),
        Err(e)  => { print("写入失败: \\{e}"); return; }
    }
    match std.fs.read_file("data.txt") {
        Ok(content) => print("读到: \\{content.trim()}"),
        Err(e)      => print("读取失败: \\{e}"),
    }
    match std.fs.list_dir(".") {
        Ok(entries) => print("目录项: \\{str(entries.len())}"),
        Err(e)      => print("列目录失败: \\{e}"),
    }
    print(str(std.fs.exists("data.txt")));
    let _ = std.fs.remove_file("data.txt");
    print(str(std.fs.exists("data.txt")));
    print(std.path.join("a", "b.txt"));
}
`, 'utf8');
  const rr = runMing(['run', 'fs_demo_prog.ming'], { cwd: fsDir });
  const expected = '写入成功\n读到: hello ming\n目录项: 2\ntrue\nfalse\na' + path.sep + 'b.txt\n';
  check('fs:端到端(写/读/列/删/path)', rr.code === 0 && rr.stdout === expected,
    `code=${rr.code}\n--- 期望 ---\n${JSON.stringify(expected)}\n--- 实际 ---\n${JSON.stringify(rr.stdout)}\n${rr.stderr}`);
}

// ===================== 10. capability 网络(std.net)=====================
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'net_e2e.mjs')], { encoding: 'utf8', timeout: 180000 });
  check('net:效果强制 + http_get 端到端(双引擎)', r.status === 0, (r.stdout + r.stderr).slice(0, 300));
}

// ===================== 11. REPL =====================
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'repl.mjs')], { encoding: 'utf8', timeout: 120000 });
  check('repl:会话(回显/声明持久/诊断/退出)', r.status === 0, (r.stdout + r.stderr).slice(0, 300));
}

// ===================== 12. WASM 分层(v0.11)=====================
{
  const srcs = [
    ['wasm fib 递归', 'fn fib(n: i64) -> i64 { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); } fn main() with io { print(str(fib(25))); }', '75025\n', null],
    ['wasm 循环', 'fn sum(n: i64) -> i64 { let mut t = 0; let mut i = 0; while i < n { i += 1; t += i; } return t; } fn main() with io { print(str(sum(10000))); }', '50005000\n', null],
    ['wasm 溢出 panic', 'fn main() with io { let m = i64.max_value(); print(str(m + 1)); }', null, 'M4002'],
    ['wasm 除零 panic', 'fn main() with io { let a = 10; let b = 0; print(str(a / b)); }', null, 'M4004'],
    ['wasm 栈溢出可控', 'fn f(n: i64) -> i64 { return f(n + 1); } fn main() with io { print(str(f(0))); }', null, 'M4005'],
  ];
  for (const [desc, src, expectOut, expectPanic] of srcs) {
    const p = mingFile('wasm-' + desc.replace(/\s+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    if (expectPanic) {
      check('wasm:' + desc, r.code === 101 && r.stderr.includes(expectPanic), 'code=' + r.code + ' stderr=' + r.stderr.slice(0, 120));
    } else {
      check('wasm:' + desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout));
    }
  }
  // wasm float:f64 签名 + std.math 导入
  const floatSrcs = [
    ['wasm float sqrt', 'fn hypot(a: f64, b: f64) -> f64 { return std.math.sqrt(a * a + b * b); } fn main() with io { print(str(hypot(3.0, 4.0))); }', '5.0\n'],
    ['wasm float pi', 'fn main() with io { print(str(std.math.pi() > 3.14)); }', 'true\n'],
    ['wasm float 全限定', 'fn half(x: f64) -> f64 { return x / 2.0; } fn main() with io { print(str(std.math.sqrt(half(9.0)))); }', '2.1213203435596424\n'],
  ];
  for (const [desc, src, expectOut] of floatSrcs) {
    const p = mingFile('wasm-' + desc.replace(/\s+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check('wasm:' + desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 120));
  }
  // wasm u64:无符号算术/比较/检查(v0.13)
  const u64Srcs = [
    ['wasm u64 算术', 'fn uadd(a: u64, b: u64) -> u64 { return a + b; } fn main() with io { print(str(uadd(5u64, 7u64))); }', '12\n'],
    ['wasm u64 max 直通', 'fn uadd(a: u64, b: u64) -> u64 { return a + b; } fn main() with io { print(str(uadd(u64.max_value(), 0u64))); }', '18446744073709551615\n'],
    ['wasm u64 无符号比较', 'fn umax(a: u64, b: u64) -> u64 { if a > b { return a; } return b; } fn main() with io { print(str(umax(u64.max_value(), 5u64))); }', '18446744073709551615\n'],
    ['wasm u64 溢出 panic', 'fn uadd(a: u64, b: u64) -> u64 { return a + b; } fn main() with io { print(str(uadd(u64.max_value(), 1u64))); }', null, 'M4002'],
    ['wasm u64 除零 panic', 'fn udiv(a: u64, b: u64) -> u64 { return a / b; } fn main() with io { print(str(udiv(10u64, 0u64))); }', null, 'M4004'],
  ];
  for (const [desc, src, expectOut, expectPanic] of u64Srcs) {
    const p = mingFile('wasm-' + desc.replace(/\s+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    if (expectPanic) {
      check('wasm:' + desc, r.code === 101 && r.stderr.includes(expectPanic), 'code=' + r.code + ' stderr=' + r.stderr.slice(0, 120));
    } else {
      check('wasm:' + desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout));
    }
  }
  // --no-wasm 退路:同一程序走 JS VM,结果一致
  const pw = mingFile('wasm-consist.ming', srcs[0][1]);
  const rWasm = runMing(['run', pw]);
  const rNo = runMing(['run', pw, '--no-wasm']);
  check('wasm:--no-wasm 结果一致', rWasm.stdout === rNo.stdout && rNo.code === 0, 'wasm=' + JSON.stringify(rWasm.stdout) + ' no=' + JSON.stringify(rNo.stdout));
}

// ===================== 13. 结构化并发(std.sync)=====================
{
  const srcs = [
    ['sync:双 spawn 并行', 'use std.sync;\nfn fib(n: i64) -> i64 { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }\nfn main() with io, sync {\n    let h1 = std.sync.spawn(fib, 25);\n    let h2 = std.sync.spawn(fib, 20);\n    let r1 = std.sync.join(h1);\n    let r2 = std.sync.join(h2);\n    print(str(r1.unwrap() + r2.unwrap()));\n}\n', '81790\n'],
    ['sync:单 spawn 无参函数', 'use std.sync;\nfn answer() -> i64 { return 42; }\nfn main() with io, sync { print(str(std.sync.join(std.sync.spawn(answer)).unwrap())); }\n', '42\n'],
    ['sync:子 panic → Err', 'use std.sync;\nfn boom(n: i64) -> i64 { panic("子任务爆炸"); return n; }\nfn main() with io, sync {\n    match std.sync.join(std.sync.spawn(boom, 1)) {\n        Ok(v)  => print("不该到这"),\n        Err(e) => print("ERR: " + e),\n    }\n}\n', 'ERR: 子任务爆炸\n'],
    ['sync:字符串跨任务', 'use std.sync;\nfn greet(name: str) -> str { return "hi, " + name; }\nfn main() with io, sync { print(str(std.sync.join(std.sync.spawn(greet, "ming")).unwrap())); }\n', 'hi, ming\n'],
  ];
  for (const [desc, src, expectOut] of srcs) {
    const p = mingFile('sync-' + desc.replace(/[^a-zA-Z0-9\\u4e00-\\u9fa5]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150) + ' FILELEN=' + fs.statSync(p).size + ' SRCHEAD=' + JSON.stringify(fs.readFileSync(p, 'utf8').slice(0, 80)));
  }
  // 效果强制:未声明 sync 不得 spawn
  const p = mingFile('sync-cap.ming', 'use std.sync;\nfn f() -> i64 { return 1; }\nfn main() with io { print(str(std.sync.join(std.sync.spawn(f)).unwrap())); }\n');
  const rc = runMing(['check', p, '--json']);
  const jc = JSON.parse(rc.stdout);
  check('sync:效果强制(M3029)', jc.ok === false && jc.diagnostics.some(d => d.code === 'M3029'), rc.stdout.slice(0, 250));
  // 双 join → Err
  const p2 = mingFile('sync-double-join.ming', 'use std.sync;\nfn f() -> i64 { return 1; }\nfn main() with io, sync {\n    let h = std.sync.spawn(f);\n    let _ = std.sync.join(h);\n    match std.sync.join(h) {\n        Ok(v)  => print("不该到这"),\n        Err(e) => print("ERR: " + e),\n    }\n}\n');
  const r2 = runMing(['run', p2]);
  check('sync:重复 join → Err', r2.code === 0 && r2.stdout === 'ERR: join:句柄 #1 不存在或已 join 过\n', 'stdout=' + JSON.stringify(r2.stdout) + ' stderr=' + r2.stderr.slice(0, 150));
  // --tree 对照
  const p3 = mingFile('sync-tree.ming', srcs[0][1]);
  const r3 = runMing(['run', p3, '--tree']);
  check('sync:双引擎一致', r3.code === 0 && r3.stdout === '81790\n', 'stdout=' + JSON.stringify(r3.stdout));
}

// ===================== 14. v0.15:Join 线性 / 约束强化 / WASM str =====================
{
  // Join 线性检查:句柄禁入集合
  const cases = [
    ['Join 禁入 Vec', 'use std.sync;\nfn f() -> i64 { return 1; }\nfn main() with io, sync {\n    let v: Vec[Join[i64]] = [std.sync.spawn(f)];\n    print(str(v.len()));\n}\n', 'M3034'],
    ['Join 禁入 Map', 'use std.sync;\nfn f() -> i64 { return 1; }\nfn main() with io, sync {\n    let m: Map[str, Join[i64]] = {"h": std.sync.spawn(f)};\n    print(str(m.len()));\n}\n', 'M3034'],
    ['Join 返回类型拒绝', 'use std.sync;\nfn f() -> Join[i64] { panic("x"); return std.sync.spawn(f); }\nfn main() with io, sync { print(str(std.sync.join(std.sync.spawn(f)).unwrap())); }\n', 'M3034'],
  ];
  for (const [desc, src, code] of cases) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['check', p, '--json']);
    const j = JSON.parse(r.stdout);
    check(desc, j.ok === false && j.diagnostics.some(d => d.code === code), r.stdout.slice(0, 250));
  }
  // 泛型约束强化:trait 方法调用点校验接收者 impl bound
  const pb = mingFile('bound-at-call.ming', 'struct PB[A, B] { l: A, r: B, }\nimpl[A: Eq, B: Eq] Eq for PB[A, B] {\n    fn eq(self, other: Self) -> bool { return true; }\n}\nstruct NoEq9 { x: i64, }\nfn main() with io {\n    let p = PB { l: 1, r: NoEq9 { x: 1 } };\n    print(str(p.eq(p)));\n}\n');
  const rb = runMing(['check', pb, '--json']);
  const jb = JSON.parse(rb.stdout);
  check('泛型:方法调用点校验 impl bound(M3032)', jb.ok === false && jb.diagnostics.some(d => d.code === 'M3032'), rb.stdout.slice(0, 250));
  // WASM str
  const strSrcs = [
    ['wasm str 拼接与回显', 'fn greet(name: str) -> str { return "hello, " + name + "!"; } fn main() with io { print(greet("ming")); }', 'hello, ming!\n'],
    ['wasm str 相等', 'fn eq(a: str, b: str) -> bool { return a == b; } fn main() with io { print(str(eq("x", "x"))); print(str(eq("x", "y"))); }', 'true\nfalse\n'],
    ['wasm str len', 'fn n(s: str) -> i64 { return s.char_len(); } fn main() with io { print(str(n("abcde"))); }', '5\n'],
  ];
  for (const [desc, src, expectOut] of strSrcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
  }
}

// ===================== 15. v0.16:多参 spawn / spawn_all =====================
{
  const srcs = [
    ['sync:多参 spawn', 'use std.sync;\nfn add3(a: i64, b: i64, c: i64) -> i64 { return a + b + c; }\nfn main() with io, sync { print(str(std.sync.join(std.sync.spawn(add3, 10, 20, 30)).unwrap())); }\n', '60\n'],
    ['sync:spawn_all 批量', 'use std.sync;\nfn fib(n: i64) -> i64 { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }\nfn main() with io, sync {\n    let all = std.sync.spawn_all(fib, [20, 25, 30]);\n    let mut total = 0;\n    for res in all { total += res.unwrap(); }\n    print(str(total));\n}\n', '913830\n'],
    ['sync:spawn_all 空 Vec', 'use std.sync;\nfn f(x: i64) -> i64 { return x; }\nfn main() with io, sync { let empty: Vec[i64] = []; print(str(std.sync.spawn_all(f, empty).len())); }\n', '0\n'],
    ['sync:spawn_all 字符串任务', 'use std.sync;\nfn shout(s: str) -> str { return s + "!"; }\nfn main() with io, sync {\n    let all = std.sync.spawn_all(shout, ["a", "b"]);\n    for res in all { print(res.unwrap()); }\n}\n', 'a!\nb!\n'],
  ];
  for (const [desc, src, expectOut] of srcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
  }
  // 混合 Err:spawn_all 中一个任务 panic
  const pm = mingFile('sync-mixed-panic.ming', 'use std.sync;\nfn maybe(n: i64) -> i64 { if n < 0 { panic("neg"); } return n; }\nfn main() with io, sync {\n    let all = std.sync.spawn_all(maybe, [5, -1, 7]);\n    print(str(all.get(0).unwrap().unwrap()));\n    print(str(all.get(1).unwrap().is_err()));\n    print(str(all.get(2).unwrap().unwrap()));\n}\n');
  const rm = runMing(['run', pm]);
  check('sync:spawn_all 混合 Err', rm.code === 0 && rm.stdout === '5\ntrue\n7\n', 'code=' + rm.code + ' stdout=' + JSON.stringify(rm.stdout) + ' stderr=' + rm.stderr.slice(0, 150));
  // spawn 参数个数不符 → M3005
  const pw = mingFile('sync-arity.ming', 'use std.sync;\nfn add3(a: i64, b: i64, c: i64) -> i64 { return a + b + c; }\nfn main() with io, sync { print(str(std.sync.join(std.sync.spawn(add3, 1, 2)).unwrap())); }\n');
  const rw = runMing(['check', pw, '--json']);
  const jw = JSON.parse(rw.stdout);
  check('sync:spawn 参数个数不符(M3005)', jw.ok === false && jw.diagnostics.some(d => d.code === 'M3005'), rw.stdout.slice(0, 250));
  // 双引擎
  const p3 = mingFile('sync16-tree.ming', srcs[1][1]);
  const r3 = runMing(['run', p3, '--tree']);
  check('sync:spawn_all 双引擎一致', r3.code === 0 && r3.stdout === '913830\n', 'stdout=' + JSON.stringify(r3.stdout));
}

// ===================== 16. v0.17:scoped 并发块 =====================
{
  const mk = (body) => 'use std.sync;\nfn fib(n: i64) -> i64 { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }\nfn boom() -> i64 { panic("scoped 子任务失败"); return 0; }\n' + body;
  const srcs = [
    ['scoped:自动 join', 'fn ok() -> i64 with sync { sync scope { std.sync.spawn(fib, 10); std.sync.spawn(fib, 15); } return fib(20); }\nfn main() with io, sync { print(str(ok())); }\n', '6765\n'],
    ['scoped:子 panic 传播', 'fn p() -> i64 with sync { sync scope { std.sync.spawn(fib, 5); std.sync.spawn(boom); } return 1; }\nfn main() with io, sync {\n    match std.sync.join(std.sync.spawn(p)) {\n        Ok(v)  => print(\"不该到这\"),\n        Err(e) => print(\"隔离: \" + e),\n    }\n}\n', '隔离: scoped 子任务失败: scoped 子任务失败\n'],
    ['scoped:提前 return 安全', 'fn er(n: i64) -> i64 with sync { sync scope { std.sync.spawn(fib, 8); if n > 0 { return 42; } } return 0; }\nfn main() with io, sync { print(str(er(1))); }\n', '42\n'],
    ['scoped:显式 join 共存', 'fn ej() -> i64 with sync { sync scope { let h = std.sync.spawn(fib, 12); std.sync.join(h); } return 144; }\nfn main() with io, sync { print(str(ej())); }\n', '144\n'],
  ];
  for (const [desc, body, expectOut] of srcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', mk(body));
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
  }
  // 效果强制:scoped 块需要 sync
  const pe = mingFile('scoped-cap.ming', mk('fn bad() -> i64 { sync scope { std.sync.spawn(fib, 1); } return 0; }\nfn main() with io { print(str(bad())); }\n'));
  const re = runMing(['check', pe, '--json']);
  const je = JSON.parse(re.stdout);
  check('scoped:效果强制(M3029)', je.ok === false && je.diagnostics.some(d => d.code === 'M3029'), re.stdout.slice(0, 250));
  // fmt 幂等
  const pf = mingFile('scoped-fmt.ming', mk('fn ok2() -> i64 with sync { sync scope { std.sync.spawn(fib, 3); } return 7; }\nfn main() with io, sync { print(str(ok2())); }\n'));
  const f1 = runMing(['fmt', pf]);
  fs.writeFileSync(pf, f1.stdout, 'utf8');
  const f2 = runMing(['fmt', pf, '--check']);
  check('scoped:fmt 幂等', f2.code === 0, f2.stderr + f2.stdout);
  // 双引擎
  const p3 = mingFile('scoped-tree.ming', mk(srcs[0][1]));
  const r3 = runMing(['run', p3, '--tree']);
  check('scoped:双引擎一致', r3.code === 0 && r3.stdout === '6765\n', 'stdout=' + JSON.stringify(r3.stdout));
}

// ===================== 17. v0.18:WASM Vec/Map 句柄化 =====================
{
  const srcs = [
    ['wasm vec sum 循环', 'fn sum(v: Vec[i64]) -> i64 { let mut t = 0; let mut i = 0; while i < v.len() { t += v[i]; i += 1; } return t; } fn main() with io { print(str(sum([10, 20, 30, 40]))); }', '100\n'],
    ['wasm vec 构造+push+返回', 'fn build() -> Vec[i64] { let mut v: Vec[i64] = []; v.push(100); v.push(23); return v; } fn main() with io { let b = build(); print(str(b.len())); print(str(sum2(b))); } fn sum2(v: Vec[i64]) -> i64 { let mut t = 0; let mut i = 0; while i < v.len() { t += v[i]; i += 1; } return t; }', '2\n123\n'],
    ['wasm map get', 'fn total(m: Map[str, i64]) -> i64 { return m["a"] + m["b"]; } fn main() with io { let m: Map[str, i64] = {"a": 11, "b": 22}; print(str(total(m))); }', '33\n'],
    ['wasm vec f64', 'fn sum(v: Vec[f64]) -> f64 { let mut t = 0.0; let mut i = 0; while i < v.len() { t = t + v[i]; i += 1; } return t; } fn main() with io { print(str(sum([1.5, 2.5]))); }', '4.0\n'],
  ];
  for (const [desc, src, expectOut] of srcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
  }
  // wasm 下标越界 → M4003
  const pO = mingFile('wasm-vec-oob.ming', 'fn get(v: Vec[i64], i: i64) -> i64 { return v[i]; } fn main() with io { let v: Vec[i64] = [1]; print(str(get(v, 5))); }');
  const rO = runMing(['run', pO]);
  check('wasm vec 越界 panic(M4003)', rO.code === 101 && rO.stderr.includes('M4003'), 'code=' + rO.code + ' stderr=' + rO.stderr.slice(0, 150));
  // wasm map 缺键 → M4007
  const pM = mingFile('wasm-map-miss.ming', 'fn get(m: Map[str, i64], k: str) -> i64 { return m[k]; } fn main() with io { let m: Map[str, i64] = {"a": 1}; print(str(get(m, "zz"))); }');
  const rM = runMing(['run', pM]);
  check('wasm map 缺键 panic(M4007)', rM.code === 101 && rM.stderr.includes('M4007'), 'code=' + rM.code + ' stderr=' + rM.stderr.slice(0, 150));
  // 双引擎一致
  const p3 = mingFile('wasm-vec-tree.ming', srcs[0][1]);
  const r3 = runMing(['run', p3, '--tree']);
  check('wasm vec 双引擎一致', r3.code === 0 && r3.stdout === '100\n', 'stdout=' + JSON.stringify(r3.stdout));
}

// ===================== 18. v0.19:线性内存传递 =====================
{
  const mkSum = (n, expected) => [
    ['lmem:sum 正确性(' + n + ')', 'fn sum(v: Vec[i64]) -> i64 { let mut t = 0; let mut i = 0; while i < v.len() { t += v[i]; i += 1; } return t; } fn build(n: i64) -> Vec[i64] { let mut v: Vec[i64] = []; let mut i = 0; while i < n { v.push(i); i += 1; } return v; } fn main() with io { print(str(sum(build(' + n + ')))); }', expected + '\n'],
    ['lmem:双引擎一致(' + n + ')', 'fn sum(v: Vec[i64]) -> i64 { let mut t = 0; let mut i = 0; while i < v.len() { t += v[i]; i += 1; } return t; } fn build(n: i64) -> Vec[i64] { let mut v: Vec[i64] = []; let mut i = 0; while i < n { v.push(i); i += 1; } return v; } fn main() with io { print(str(sum(build(' + n + ')))); }', expected + '\n'],
  ];
  for (const [desc, src, expectOut] of mkSum(1000, '499500')) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    if (desc.includes('双引擎')) {
      const r = runMing(['run', p, '--tree']);
      check(desc, r.code === 0 && r.stdout === expectOut, 'stdout=' + JSON.stringify(r.stdout));
    } else {
      const r = runMing(['run', p]);
      check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
    }
  }
  // f64 元素
  const pf = mingFile('lmem-f64.ming', 'fn sum(v: Vec[f64]) -> f64 { let mut t = 0.0; let mut i = 0; while i < v.len() { t = t + v[i]; i += 1; } return t; } fn main() with io { let v: Vec[f64] = [1.5, 2.25]; print(str(sum(v))); }');
  const rf = runMing(['run', pf]);
  check('lmem:f64 元素', rf.code === 0 && rf.stdout === '3.75\n', 'stdout=' + JSON.stringify(rf.stdout));
  // 越界 panic(线性内存路径)
  const po = mingFile('lmem-oob.ming', 'fn get(v: Vec[i64], i: i64) -> i64 { return v[i]; } fn main() with io { let v: Vec[i64] = [1, 2]; print(str(get(v, 9))); }');
  const ro = runMing(['run', po]);
  check('lmem:越界 panic(M4003)', ro.code === 101 && ro.stderr.includes('M4003'), 'code=' + ro.code + ' stderr=' + ro.stderr.slice(0, 150));
  // 大数组正确性(内存 grow)
  const pb = mingFile('lmem-big.ming', 'fn sum(v: Vec[i64]) -> i64 { let mut t = 0; let mut i = 0; while i < v.len() { t += v[i]; i += 1; } return t; } fn build(n: i64) -> Vec[i64] { let mut v: Vec[i64] = []; let mut i = 0; while i < n { v.push(i); i += 1; } return v; } fn main() with io { print(str(sum(build(1000000)))); }');
  const rb = runMing(['run', pb]);
  check('lmem:百万元素(grow)', rb.code === 0 && rb.stdout === '499999500000\n', 'code=' + rb.code + ' stdout=' + JSON.stringify(rb.stdout) + ' stderr=' + rb.stderr.slice(0, 150));
  // --no-wasm 一致
  const pc = mingFile('lmem-consist.ming', mkConsistSrc());
  function mkConsistSrc() { return 'fn sum(v: Vec[i64]) -> i64 { let mut t = 0; let mut i = 0; while i < v.len() { t += v[i]; i += 1; } return t; } fn build(n: i64) -> Vec[i64] { let mut v: Vec[i64] = []; let mut i = 0; while i < n { v.push(i); i += 1; } return v; } fn main() with io { print(str(sum(build(10000)))); }'; }
  const r1 = runMing(['run', pc]);
  const r2 = runMing(['run', pc, '--no-wasm']);
  check('lmem:--no-wasm 一致', r1.stdout === r2.stdout && r2.code === 0, 'wasm=' + JSON.stringify(r1.stdout) + ' no=' + JSON.stringify(r2.stdout));
}

// ===================== 19. v0.20:内存写入 + for-in 迭代 + 赋值栈序修复 =====================
{
  const srcs = [
    ['v20:mut ptr push(容量预留)', 'fn fill(mut v: Vec[i64], n: i64) -> i64 { let mut i = 0; while i < n { v.push(i * 2); i += 1; } return v.len(); } fn main() with io { let v: Vec[i64] = [1, 2]; print(str(fill(v, 5))); }', '7\n'],
    ['v20:mut ptr set(v[i]=x)', 'fn double(mut v: Vec[i64]) -> i64 { let mut i = 0; let len = v.len(); while i < len { v[i] = v[i] * 2; i += 1; } return v[0] + v[1]; } fn main() with io { let v: Vec[i64] = [3, 4]; print(str(double(v))); }', '14\n'],
    ['v20:for-in ptr 迭代', 'fn sum(v: Vec[i64]) -> i64 { let mut t = 0; for x in v { t += x; } return t; } fn main() with io { print(str(sum([10, 20, 30]))); }', '60\n'],
    ['v20:非 mut 不可 push', 'fn bad(v: Vec[i64]) -> i64 { v.push(1); return v.len(); } fn main() with io { let v: Vec[i64] = [1]; print(str(bad(v))); }', null, 'M3004', true],
    ['v20:JS VM 字段赋值', 'struct P { x: i64, } fn main() with io { let mut p = P { x: 1 }; p.x = 5; print(str(p.x)); }', '5\n'],
    ['v20:JS VM 下标赋值', 'fn main() with io { let mut v = [1, 2]; v[0] = 9; print(str(v[0])); }', '9\n'],
    ['v20:JS VM 下标复合', 'fn main() with io { let mut v = [1, 2]; v[1] += 10; print(str(v[1])); }', '12\n'],
  ];
  for (const [desc, src, expectOut, expectPanic] of srcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const isCheck = desc.includes('非 mut 不可 push');
    const r = isCheck ? runMing(['check', p, '--json']) : runMing(['run', p]);
    if (isCheck) {
      let jOk = false;
      try { jOk = JSON.parse(r.stdout).diagnostics.some(d => d.code === 'M3004'); } catch { }
      check(desc, jOk, r.stdout.slice(0, 250));
    } else if (expectPanic) {
      check(desc, r.code === 101 && r.stderr.includes(expectPanic), 'code=' + r.code + ' stderr=' + r.stderr.slice(0, 150));
    } else {
      check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
    }
  }
  // 双引擎
  const p3 = mingFile('v20-tree.ming', srcs[2][1]);
  const r3 = runMing(['run', p3, '--tree']);
  check('v20:for-in 双引擎一致', r3.code === 0 && r3.stdout === '60\n', 'stdout=' + JSON.stringify(r3.stdout));
}

// ===================== 20. v0.21:WASM 插值 + str 方法面 =====================
{
  const BS = "\\";
  const I = (e) => BS + '{' + e + '}';
  const srcs = [
    ['v21:wasm 内插值(混合类型)', 'fn describe(n: i64, ok: bool) -> str { return "' + I('n') + ' ok=' + I('ok') + '"; } fn main() with io { print(describe(7, true)); }', '7 ok=true\n'],
    ['v21:wasm 插值方法调用段', 'fn main() with io { let v: Vec[f64] = [1.5, 2.5]; print("' + I('v.len()') + ' items"); }', '2 items\n'],
    ['v21:str 方法 trim 系', 'fn clean(s: str) -> str { return s.trim().to_lower(); } fn main() with io { print(clean("  Hi World  ")); }', 'hi world\n'],
    ['v21:str replace/contains/starts', 'fn main() with io { let s = "Hello Ming"; print(s.replace("Ming", "World")); print(str(s.contains("Ming"))); print(str(s.starts_with("Hell"))); print(str(s.ends_with("zz"))); }', 'Hello World\ntrue\ntrue\nfalse\n'],
    ['v21:str 字典序', 'fn cmp(a: str, b: str) -> bool { return a < b; } fn main() with io { print(str(cmp("abc", "abd"))); print(str(cmp("zz", "aa"))); }', 'true\nfalse\n'],
    ['v21:str f64 插值格式', 'fn fmt(x: f64) -> str { return "' + I('x') + '"; } fn main() with io { print(fmt(2.5)); }', '2.5\n'],
  ];
  for (const [desc, src, expectOut] of srcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
    // 双引擎
    const rt = runMing(['run', p, '--tree']);
    check(desc + '(tree)', rt.code === 0 && rt.stdout === expectOut, 'stdout=' + JSON.stringify(rt.stdout));
  }
}

// ===================== 21. v0.22:Option 消费链 + 容器 for-in(wasm 内)=====================
{
  const srcs = [
    ['v22:get 消费链(wasm 内)', 'fn pick(v: Vec[i64], i: i64) -> i64 { return v.get(i).unwrap_or(-1); } fn main() with io { print(str(pick([10, 20], 0))); print(str(pick([10, 20], 9))); }', '10\n-1\n'],
    ['v22:map get 消费链(wasm 内)', 'fn g(m: Map[str, i64], k: str) -> i64 { return m.get(k).unwrap_or(0); } fn main() with io { let m: Map[str, i64] = {"k": 5}; print(str(g(m, "k"))); print(str(g(m, "zz"))); }', '5\n0\n'],
    ['v22:get unwrap(wasm 内)', 'fn must(v: Vec[str], i: i64) -> str { return v.get(i).unwrap(); } fn main() with io { print(must(["a", "b"], 1)); }', 'b\n'],
    ['v22:is_some/is_none(wasm 内)', 'fn has(v: Vec[i64], i: i64) -> bool { return v.get(i).is_some(); } fn main() with io { print(str(has([1], 0))); print(str(has([1], 5))); }', 'true\nfalse\n'],
    ['v22:for-in vec(wasm 内)', 'fn sum(v: Vec[i64]) -> i64 { let mut t = 0; for x in v { t += x; } return t; } fn main() with io { print(str(sum([5, 10, 15]))); }', '30\n'],
    ['v22:for-in map(wasm 内)', 'fn dump(m: Map[str, i64]) -> i64 { let mut t = 0; for (k, v) in m { t += v; } return t; } fn main() with io { let m: Map[str, i64] = {"a": 1, "b": 2, "c": 3}; print(str(dump(m))); }', '6\n'],
    ['v22:裸 get 回落(语义不变)', 'fn main() with io { let v: Vec[i64] = [7, 8]; let o = v.get(0); print(str(o.unwrap())); }', '7\n'],
  ];
  for (const [desc, src, expectOut] of srcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
    const rt = runMing(['run', p, '--tree']);
    check(desc + '(tree)', rt.code === 0 && rt.stdout === expectOut, 'stdout=' + JSON.stringify(rt.stdout));
  }
}

// ===================== 22. v0.23:线性内存统一语义 =====================
{
  const srcs = [
    ['lmem23:构造+push+返回 Vec', 'fn build(n: i64) -> Vec[i64] { let mut v: Vec[i64] = []; let mut i = 0; while i < n { v.push(i * i); i += 1; } return v; } fn sum(v: Vec[i64]) -> i64 { let mut t = 0; for x in v { t += x; } return t; } fn main() with io { let v = build(5); print(str(v.len())); print(str(sum(v))); }', '5\n30\n'],
    ['lmem23:mut 参数值语义', 'fn bump(mut v: Vec[i64]) -> i64 { v[0] = 999; v.push(7); return v.len(); } fn main() with io { let v: Vec[i64] = [1, 2]; let n = bump(v); print(str(n)); print(str(v[0])); print(str(v.len())); }', '3\n1\n2\n'],
    ['lmem23:let 拷贝独立', 'fn main() with io { let v: Vec[i64] = [1, 2]; let w = v; let mut w2 = w; w2[0] = 99; print(str(v[0])); print(str(w[0])); print(str(w2[0])); }', '1\n1\n99\n'],
    ['lmem23:let mut w = v 拷贝独立', 'fn main() with io { let v: Vec[i64] = [5]; let mut w = v; w.push(9); print(str(v.len())); print(str(w.len())); }', '1\n2\n'],
  ];
  for (const [desc, src, expectOut] of srcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
    const rt = runMing(['run', p, '--tree']);
    check(desc + '(tree)', rt.code === 0 && rt.stdout === expectOut, 'stdout=' + JSON.stringify(rt.stdout));
  }
}

// ===================== 23. v0.25:时间日期 + 随机 =====================
{
  const BS = String.fromCharCode(92);
  const I = (e) => BS + '{' + e + '}';
  const srcs = [
    ['v25:rand 确定性(seed)', 'use std.rand; fn main() with io, rand { std.rand.seed(42); let a = std.rand.range(1, 100); std.rand.seed(42); let b = std.rand.range(1, 100); print(str(a)); print(str(b)); print(str(a == b)); }', '46\n46\ntrue\n'],
    ['v25:rand u64/f64 范围', 'use std.rand; fn main() with io, rand { let u = std.rand.u64(); let f = std.rand.f64(); print(str(f >= 0.0 && f < 1.0)); }', 'true\n'],
    ['v25:rand range 范围', 'use std.rand; fn main() with io, rand { std.rand.seed(7); let mut ok = true; let mut i = 0; while i < 50 { let r = std.rand.range(5, 10); if r < 5 || r >= 10 { ok = false; } i += 1; } print(str(ok)); }', 'true\n'],
    ['v25:monotonic 测 sleep', 'use std.time; fn main() with io, time { let t0 = std.time.monotonic_ms(); std.time.sleep(30); let dt = std.time.monotonic_ms() - t0; print(str(dt >= 25)); }', 'true\n'],
    ['v25:date_parts 字段', 'use std.time; fn main() with io, time { let parts = std.time.date_parts(std.time.now_ms()); print(str(parts.get("year").unwrap().as_num().unwrap() >= 2026.0)); print(str(parts.get("month").unwrap().as_num().unwrap() >= 1.0)); print(str(parts.get("month").unwrap().as_num().unwrap() <= 12.0)); }', 'true\ntrue\ntrue\n'],
    ['v25:ISO 往返', 'use std.time; fn main() with io, time { let now = std.time.now_ms(); let iso = std.time.format_iso(now); print(str(std.time.parse_iso(iso).unwrap() / 1000 == now / 1000)); }', 'true\n'],
    ['v25:parse_iso 非法输入', 'use std.time; fn main() with io, time { print(str(std.time.parse_iso("not-a-date").is_err())); }', 'true\n'],
  ];
  for (const [desc, src, expectOut] of srcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
    const rt = runMing(['run', p, '--tree']);
    check(desc + '(tree)', rt.code === 0 && rt.stdout === expectOut, 'stdout=' + JSON.stringify(rt.stdout));
  }
}

// ===================== 24. 短路求值真值表(v0.20 遗留 bug 回归)=====================
{
  // || 与 && 的 l true/false 全真值表(双引擎)——锁定 v0.20 修复的 || 短路结构
  const cases = [
    ['||:l true', 'print(str(3 < 5 || 4 >= 10));', 'true\n'],
    ['||:l false', 'print(str(3 > 5 || 4 < 10));', 'true\n'],
    ['||:两侧 false', 'print(str(3 > 5 || 4 > 10));', 'false\n'],
    ['&&:l true', 'print(str(3 < 5 && 4 < 10));', 'true\n'],
    ['&&:l false', 'print(str(3 > 5 && 4 < 10));', 'false\n'],
    ['&&:两侧 true', 'print(str(3 < 5 && 4 < 10));', 'true\n'],
    ['||:闭包捕获不影响外部(值语义)', 'let mut n = 0; let inc = () => { n += 1; true }; let a = false || inc(); print(str(n)); print(str(a));', '0\ntrue\n'],
    ['&&:闭包捕获不影响外部(值语义)', 'let mut n = 0; let inc = () => { n += 1; true }; let a = true && inc(); print(str(n)); print(str(a));', '0\ntrue\n'],
  ];
  for (const [desc, body, expectOut] of cases) {
    const src = 'fn main() with io { ' + body + ' }';
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
    const rt = runMing(['run', p, '--tree']);
    check(desc + '(tree)', rt.code === 0 && rt.stdout === expectOut, 'stdout=' + JSON.stringify(rt.stdout));
  }
}

// ===================== 25. v0.26:正则 + 字符分类 + pad =====================
{
  const D = '\\d';  // JS 字符串:反斜杠+d(Ming 源码里 r"\d+" 的原文)
  const S = '\\s';
  const srcs = [
    ['v26:re is_match', 'use std.re; fn main() with io { print(str(std.re.is_match(r"' + D + '+", "abc123"))); print(str(std.re.is_match(r"' + D + '+", "abc"))); }', 'true\nfalse\n'],
    ['v26:re find', 'use std.re; fn main() with io { match std.re.find(r"' + D + '+", "abc 123 def 456") { Some(s) => print("got: " + s), None => print("none") } }', 'got: 123\n'],
    ['v26:re find_all', 'use std.re; fn main() with io { print(str(std.re.find_all(r"' + D + '+", "a1b22c333").len())); }', '3\n'],
    ['v26:re replace 捕获组', 'use std.re; fn main() with io { print(std.re.replace(r"(' + D + '+)-(' + D + '+)", "12-34", "$2-$1")); }', '34-12\n'],
    ['v26:re split', 'use std.re; fn main() with io { for part in std.re.split(r",' + S + '*", "a, b,c") { print(part); } }', 'a\nb\nc\n'],
    ['v26:字符分类', 'fn main() with io { print(str("hello".is_alpha())); print(str("123".is_digit())); print(str("  ".is_space())); print(str("".is_alpha())); }', 'true\ntrue\ntrue\nfalse\n'],
    ['v26:大小写判定', 'fn main() with io { print(str("HELLO".is_upper())); print(str("hello".is_lower())); print(str("123".is_upper())); }', 'true\ntrue\nfalse\n'],
    ['v26:pad', 'fn main() with io { print("[" + "ab".pad_left(5) + "]"); print("[" + "ab".pad_right(5) + "]"); }', '[   ab]\n[ab   ]\n'],
  ];
  for (const [desc, src, expectOut] of srcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
  }
  const pP = mingFile('v26-re-panic.ming', 'use std.re; fn main() with io { print(str(std.re.is_match("[", "x"))); }');
  const rP = runMing(['run', pP]);
  check('v26:re 非法 pattern panic', rP.code === 101 && rP.stderr.includes('M4001'), 'code=' + rP.code + ' stderr=' + rP.stderr.slice(0, 150));
}

// ===================== 26. v0.27:fmt + HTTP opts =====================
{
  const srcs = [
    ['v27:fmt.fixed', 'use std.fmt; fn main() with io { print(std.fmt.fixed(3.14159, 2)); print(std.fmt.fixed(2.0, 0)); }', '3.14\n2\n'],
    ['v27:fmt.hex/bin', 'use std.fmt; fn main() with io { print(std.fmt.hex(255)); print(std.fmt.bin(10)); print(std.fmt.hex(-1)); }', '0xff\n0b1010\n0xffffffffffffffff\n'],
    ['v27:fmt.exp', 'use std.fmt; fn main() with io { print(std.fmt.exp(12345.678, 2)); }', '1.23e+4\n'],
  ];
  for (const [desc, src, expectOut] of srcs) {
    const p = mingFile(desc.replace(/[^a-zA-Z0-9]+/g, '-') + '.ming', src);
    const r = runMing(['run', p]);
    check(desc, r.code === 0 && r.stdout === expectOut, 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 150));
  }
  // HTTP opts:独立 echo 服务器子进程(回显方法/头/体)
  const echoServer = spawn(process.execPath, ['-e', [
    'import * as http from "node:http";',
    'const server = http.createServer((req, res) => {',
    '  let b = "";',
    '  req.on("data", c => b += c);',
    '  req.on("end", () => {',
    '    res.writeHead(200, { "content-type": "text/plain", "x-ming-echo": "yes" });',
    '    res.end(req.method + "|" + (req.headers["x-ming"] ?? "-") + "|" + b);',
    '  });',
    '});',
    'server.listen(0, "127.0.0.1", () => console.log("PORT:" + server.address().port));',
    'process.stdin.resume();',
    'process.stdin.on("end", () => process.exit(0));',
  ].join("\n"),
  ], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });

  const echoPort = await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (c) => { buf += c; const m = buf.match(/PORT:(\d+)/); if (m) { echoServer.stdout.off("data", onData); resolve(Number(m[1])); } };
    echoServer.stdout.on("data", onData);
    echoServer.on("exit", () => reject(new Error("echo exited")));
    setTimeout(() => reject(new Error("echo timeout")), 10000);
  });

  const srcLines = [
    'use std.net;',
    'fn main() with io, net {',
    '    let h = { "x-ming": "v27" };',
    '    match std.net.http_request_opts("POST", "http://127.0.0.1:" + str(' + echoPort + ') + "/echo", h, "body-27", 15000) {',
    '        Ok((status, headers, body)) => {',
    '            print(str(status));',
    '            print(body);',
    '            print(str(headers.get("content-type").is_some()));',
    '        }',
    '        Err(e) => print("ERR: " + e),',
    '    }',
    '    match std.net.http_request_opts("GET", "http://10.255.255.1/", [:], "", 500) {',
    '        Ok(_)   => print("bug"),',
    '        Err(_)  => print("timeout-ok"),',
    '    }',
    '}',
  ];
  const p = mingFile("v27-http-opts.ming", srcLines.join("\n"));
  const r1 = runMing(["run", p]);
  const want = "200\nPOST|v27|body-27\ntrue\ntimeout-ok\n";
  check("v27:http_request_opts POST+响应头+超时", r1.code === 0 && r1.stdout === want, "code=" + r1.code + " stdout=" + JSON.stringify(r1.stdout) + " stderr=" + r1.stderr.slice(0, 200));
  echoServer.kill();
}

// ===================== 27. v0.27.1:mingkit 文件工具(用 Ming 自写)=====================
{
  const KIT = path.join(ROOT, 'tools', 'mingkit.ming');
  const kitRun = (args, stdin = '') => runMing(['run', KIT, ...args], { stdin });
  const f = (n) => path.join(TMP, n);

  // write + read 往返(含中文)
  let r = kitRun(['write', f('k1.txt')], 'alpha\nbeta\ngamma\n');
  check('kit:write 退出码', r.code === 0, r.stderr.slice(0, 150));
  r = kitRun(['read', f('k1.txt')]);
  check('kit:read 往返', r.code === 0 && r.stdout === 'alpha\nbeta\ngamma\n', JSON.stringify(r.stdout));
  r = kitRun(['read', f('k1.txt'), '2', '3']);
  check('kit:read 行区间', r.stdout === 'beta\ngamma\n', JSON.stringify(r.stdout));

  // replace:恰好 1 处;0 处与多处拒绝(退出码 1,不改文件)
  r = kitRun(['replace', f('k1.txt'), 'beta', 'BETA']);
  check('kit:replace 恰好 1 处', r.code === 0 && kitRun(['read', f('k1.txt')]).stdout === 'alpha\nBETA\ngamma\n', r.stderr.slice(0, 150));
  r = kitRun(['replace', f('k1.txt'), 'nope', 'X']);
  check('kit:replace 0 处拒绝', r.code === 1 && r.stderr.includes('未找到'), 'code=' + r.code);
  fs.writeFileSync(f('k2.txt'), 'dup dup\n');
  r = kitRun(['replace', f('k2.txt'), 'dup', 'Y']);
  check('kit:replace 多处拒绝', r.code === 1 && r.stderr.includes('2 处'), r.stderr.slice(0, 150));
  r = kitRun(['replace-all', f('k2.txt'), 'dup', 'Y']);
  check('kit:replace-all', r.code === 0 && kitRun(['read', f('k2.txt')]).stdout === 'Y Y\n', r.stderr.slice(0, 150));

  // \n 转义:单参数实现跨行替换
  fs.writeFileSync(f('k3.txt'), 'one\n');
  r = kitRun(['replace', f('k3.txt'), 'one', 'two\\nthree']);
  check('kit:replace \\n 转义', r.code === 0 && kitRun(['read', f('k3.txt')]).stdout === 'two\nthree\n', JSON.stringify(r.stdout));

  // insert-after / insert-before(只动第一个命中行)
  fs.writeFileSync(f('k4.txt'), 'a1\na2\na3\n');
  kitRun(['insert-after', f('k4.txt'), 'a2', '插入']);
  kitRun(['insert-before', f('k4.txt'), 'a1', '首前']);
  r = kitRun(['read', f('k4.txt')]);
  check('kit:insert-after/before', r.stdout === '首前\na1\na2\n插入\na3\n', JSON.stringify(r.stdout));

  // delete-lines:带 end 与缺 end(删到尾)
  fs.writeFileSync(f('k5.txt'), '1\n2\n3\n4\n');
  kitRun(['delete-lines', f('k5.txt'), '2', '3']);
  r = kitRun(['read', f('k5.txt')]);
  check('kit:delete-lines 区间', r.stdout === '1\n4\n', JSON.stringify(r.stdout));
  kitRun(['delete-lines', f('k5.txt'), '2']);
  r = kitRun(['read', f('k5.txt')]);
  check('kit:delete-lines 缺 end', r.stdout === '1\n', JSON.stringify(r.stdout));

  // count + append + 双引擎一致
  fs.writeFileSync(f('k6.txt'), '中\n');
  r = kitRun(['count', f('k6.txt')]);
  check('kit:count 字节口径', r.stdout === '行 1\n字符 2\n字节 4\n', JSON.stringify(r.stdout));
  r = kitRun(['append', f('k6.txt')], '尾\n');
  check('kit:append', r.code === 0 && kitRun(['read', f('k6.txt')]).stdout === '中\n尾\n', JSON.stringify(r.stdout));
  fs.writeFileSync(f('k7.txt'), 'p\nq\n');
  const rt = runMing(['run', KIT, '--tree', 'replace', f('k7.txt'), 'p', 'P']);
  check('kit:双引擎一致(tree)', rt.code === 0 && kitRun(['read', f('k7.txt')]).stdout === 'P\nq\n', rt.stderr.slice(0, 150));

  // read:空文件无输出;区间 start>end 拒绝
  fs.writeFileSync(f('k9.txt'), '');
  r = kitRun(['read', f('k9.txt')]);
  check('kit:read 空文件无输出', r.code === 0 && r.stdout === '', JSON.stringify(r.stdout));
  r = kitRun(['read', f('k1.txt'), '3', '2']);
  check('kit:read 区间 start>end', r.code === 1 && r.stderr.includes('start 不能大于 end'), r.stderr.slice(0, 100));

  // delete-lines:start<1 / end<start / start>文件行数 拒绝
  r = kitRun(['delete-lines', f('k1.txt'), '0', '2']);
  check('kit:delete-lines start<1', r.code === 1 && r.stderr.includes('start 必须从 1 开始'), r.stderr.slice(0, 100));
  r = kitRun(['delete-lines', f('k1.txt'), '2', '1']);
  check('kit:delete-lines end<start', r.code === 1 && r.stderr.includes('end 不能小于 start'), r.stderr.slice(0, 100));
  r = kitRun(['delete-lines', f('k5.txt'), '5', '6']);
  check('kit:delete-lines start>文件行数', r.code === 1 && r.stderr.includes('start 超出文件范围'), r.stderr.slice(0, 100));

  // read:无尾部换行原样往返(走 print_raw)
  fs.writeFileSync(f('k10.txt'), 'no trailing newline');
  r = kitRun(['write', f('k10.txt')], 'no trailing newline');
  r = kitRun(['read', f('k10.txt')]);
  check('kit:read 无尾换行往返', r.code === 0 && r.stdout === 'no trailing newline', JSON.stringify(r.stdout));
  fs.writeFileSync(f('k11.txt'), 'two\nlines\n');
  r = kitRun(['read', f('k11.txt')]);
  check('kit:read 有尾换行往返', r.code === 0 && r.stdout === 'two\nlines\n', JSON.stringify(r.stdout));

  // 用法与未知子命令
  r = kitRun([]);
  check('kit:无参数出用法', r.code === 1 && r.stderr.includes('mingkit'), r.stderr.slice(0, 100));
  r = kitRun(['bogus']);
  check('kit:未知子命令', r.code === 1 && r.stderr.includes('未知子命令'), r.stderr.slice(0, 100));
}

// ===================== 28. v0.28:std.log + std.fmt.align =====================
{
  const src28 = [
    'use std.log;',
    'use std.fmt;',
    '',
    'fn main() with io {',
    '    std.log.warn("w1");',
    '    std.log.debug("d-hidden");',
    '    std.log.info("i1");',
    '    std.log.set_level("debug");',
    '    std.log.debug("d-now");',
    '    print(std.log.get_level());',
    '    std.log.set_level("error");',
    '    std.log.warn("w-hidden");',
    '    std.log.error("e1");',
    '    print(std.fmt.align("ab", 5, "left") + "|");',
    '    print(std.fmt.align("ab", 5, "right") + "|");',
    '    print(std.fmt.align("ab", 5, "center") + "|");',
    '    print(std.fmt.align("中文", 5, "right") + "|");',
    '    print(std.fmt.align("toolong", 3, "left") + "|");',
    '}',
  ].join('\n');
  const p28 = mingFile('v28-log-align.ming', src28);
  const r28 = runMing(['run', p28]);
  const wantOut = 'debug\nab   |\n   ab|\n ab  |\n   中文|\ntoolong|\n';
  const wantErr = '[WARN] w1\n[INFO] i1\n[DEBUG] d-now\n[ERROR] e1\n';
  check('v28:log 级别过滤 + align 三模式', r28.code === 0 && r28.stdout === wantOut && r28.stderr === wantErr,
    'code=' + r28.code + ' stdout=' + JSON.stringify(r28.stdout) + ' stderr=' + JSON.stringify(r28.stderr));
  const rt28 = runMing(['run', p28, '--tree']);
  check('v28:双引擎一致(tree)', rt28.code === 0 && rt28.stdout === wantOut && rt28.stderr === wantErr,
    'code=' + rt28.code + ' stderr=' + JSON.stringify(rt28.stderr));

  // set_level 非法 → panic M4001(退出码 101)
  const pb = mingFile('v28-log-bad.ming', 'use std.log;\nfn main() with io { std.log.set_level("loud"); }');
  const rb = runMing(['run', pb]);
  check('v28:set_level 非法 panic', rb.code === 101 && rb.stderr.includes('M4001') && rb.stderr.includes('非法日志级别'), 'code=' + rb.code);

  // align 非法模式 → panic
  const pc = mingFile('v28-align-bad.ming', 'use std.fmt;\nfn main() with io { print(std.fmt.align("a", 5, "middle")); }');
  const rc = runMing(['run', pc]);
  check('v28:align 非法模式 panic', rc.code === 101 && rc.stderr.includes('M4001') && rc.stderr.includes('对齐模式'), 'code=' + rc.code);

  // 效果强制:log 未声明 io → M3029
  const pe = mingFile('v28-log-cap.ming', 'use std.log;\nfn main() { std.log.info("x"); }');
  const re28 = runMing(['check', pe]);
  check('v28:log 效果强制 M3029', re28.code === 1 && re28.stderr.includes('M3029'), 'code=' + re28.code + ' stderr=' + re28.stderr.slice(0, 150));

  // align 纯函数:无 io 也能用
  const pp = mingFile('v28-align-pure.ming', 'use std.fmt;\nfn pad(s: str) -> str { return std.fmt.align(s, 4, "center"); }\nfn main() with io { print(pad("x")); }');
  const rp = runMing(['run', pp]);
  check('v28:align 是纯函数', rp.code === 0 && rp.stdout === ' x  \n', 'code=' + rp.code + ' stdout=' + JSON.stringify(rp.stdout));
}

// ===================== 29. v0.29:std.math 补全(反三角/双曲/log2/log10/cbrt/hypot/atan2)=====================
{
  const src29 = [
    'use std.math;',
    'use std.io;',
    '',
    'fn main() with io {',
    '    print(std.math.asin(1.0));',
    '    print(std.math.atan2(1.0, 1.0));',
    '    print(std.math.sinh(0.0));',
    '    print(std.math.cosh(0.0));',
    '    print(std.math.log2(8.0));',
    '    print(std.math.log10(1000.0));',
    '    print(std.math.cbrt(27.0));',
    '    print(std.math.hypot(3.0, 4.0));',
    '    print(std.math.tanh(0.0));',
    '}',
  ].join('\n');
  const p29 = mingFile('v29-math.ming', src29);
  const want29 = '1.5707963267948966\n0.7853981633974483\n0.0\n1.0\n3.0\n3.0\n3.0\n5.0\n0.0\n';
  check('v29:math 补全数值表(vm)', runMing(['run', p29]).stdout === want29, JSON.stringify(runMing(['run', p29]).stdout));
  check('v29:math 补全数值表(tree)', runMing(['run', p29, '--tree']).stdout === want29, '');

  // wasm 桥接:eligible 函数内用新函数;三引擎一致 + MING_WASM_DEBUG 证实编译未被拒绝
  const pw = mingFile('v29-math-wasm.ming', [
    'use std.math;',
    'use std.io;',
    '',
    'fn hot(a: f64) -> f64 {',
    '    return std.math.cbrt(a) + std.math.hypot(a, 2.0) + std.math.log2(a) + std.math.tanh(a);',
    '}',
    '',
    'fn main() with io {',
    '    print(hot(27.0));',
    '}',
  ].join('\n'));
  const rw1 = runMing(['run', pw]);
  const rw2 = runMing(['run', pw, '--no-wasm']);
  const rt3 = runMing(['run', pw, '--tree']);
  check('v29:math wasm 三层一致', rw1.stdout === rw2.stdout && rw2.stdout === rt3.stdout && rw1.code === 0,
    'wasm=' + JSON.stringify(rw1.stdout) + ' nowasm=' + JSON.stringify(rw2.stdout) + ' tree=' + JSON.stringify(rt3.stdout));
  const prevDbg = process.env.MING_WASM_DEBUG;
  process.env.MING_WASM_DEBUG = '1';
  const rd = runMing(['run', pw]);
  if (prevDbg === undefined) delete process.env.MING_WASM_DEBUG; else process.env.MING_WASM_DEBUG = prevDbg;
  check('v29:math wasm 路径证实(hot 编译 OK)', rd.stderr.includes('[wasm] fn hot OK') && !rd.stderr.includes('REJECT'), rd.stderr.slice(0, 200));

  // 类型门槛:math 只收 f64,int 实参 → M3002
  const pt = mingFile('v29-math-type.ming', 'use std.math;\nfn main() with io { print(std.math.cbrt(27)); }');
  const rr = runMing(['check', pt]);
  check('v29:math 类型门槛 M3002', rr.code === 1 && rr.stderr.includes('M3002'), 'code=' + rr.code + ' stderr=' + rr.stderr.slice(0, 150));
}

// ===================== 30. v0.30:错误链(cause)=====================
{
  // panic 携带 Ming 层调用栈(修复长期承诺不生效的缺口)
  const ps = mingFile('v30-stack.ming', [
    'fn inner(n: i64) -> i64 {',
    '    let m = i64.max_value();',
    '    return m + n;',
    '}',
    '',
    'fn outer(n: i64) -> i64 {',
    '    return inner(n);',
    '}',
    '',
    'fn main() with io {',
    '    print(str(outer(1)));',
    '}',
  ].join('\n'));
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', ps, ...eng]);
    const ok = r.code === 101 && r.stderr.includes('M4002')
      && r.stderr.indexOf('at inner') !== -1 && r.stderr.indexOf('at outer') !== -1 && r.stderr.indexOf('at main') !== -1
      && r.stderr.indexOf('at inner') < r.stderr.indexOf('at outer') && r.stderr.indexOf('at outer') < r.stderr.indexOf('at main');
    check('v30:panic 调用栈' + (eng.length ? '(tree)' : '(vm)'), ok, 'code=' + r.code + ' stderr=' + r.stderr.slice(0, 300));
  }

  // join_detailed:Ok 与 join 同值;Err 带真实 code 与栈(Json)
  const jd = mingFile('v30-join-detailed.ming', [
    'use std.sync;',
    'use std.io;',
    '',
    'fn good(n: i64) -> i64 { return n * 2; }',
    'fn boom(n: i64) -> i64 { let m = i64.max_value(); return m + n; }',
    '',
    'fn main() with io, sync {',
    '    let h1 = std.sync.spawn(good, 21);',
    '    match std.sync.join_detailed(h1) {',
    '        Ok(v) => print("Ok: " + str(v)),',
    '        Err(info) => print("Err? " + debug(info)),',
    '    }',
    '    let h2 = std.sync.spawn(boom, 1);',
    '    match std.sync.join_detailed(h2) {',
    '        Ok(_)  => print("bug"),',
    '        Err(info) => {',
    '            print("code=" + info.get("code").unwrap().as_str().unwrap());',
    '            print("has_stack=" + str(info.get("stack").unwrap().as_arr().unwrap().len() > 0));',
    '        }',
    '    }',
    '    let h3 = std.sync.spawn(boom, 1);',
    '    match std.sync.join(h3) {',
    '        Ok(_)  => print("bug2"),',
    '        Err(e) => print("join 兼容: " + e),',
    '    }',
    '}',
  ].join('\n'));
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', jd, ...eng]);
    const out = r.stdout;
    const ok = r.code === 0 && out.startsWith('Ok: 42\n') && out.includes('code=M4002') && out.includes('has_stack=true')
      && out.includes('join 兼容: 整数+溢出');
    check('v30:join_detailed 错误链' + (eng.length ? '(tree)' : '(vm)'), ok, 'code=' + r.code + ' stdout=' + JSON.stringify(out) + ' stderr=' + r.stderr.slice(0, 200));
  }

  // scoped 子 panic:真实码透传 + cause 链(文本 + --json)
  const sc = mingFile('v30-scoped-cause.ming', [
    'use std.io;',
    'use std.sync;',
    '',
    'fn victim(n: i64) -> i64 {',
    '    let m = i64.max_value();',
    '    return m + n;',
    '}',
    '',
    'fn main() with io, sync {',
    '    sync scope {',
    '        std.sync.spawn(victim, 1);',
    '    }',
    '    print("不该到这");',
    '}',
  ].join('\n'));
  const rs = runMing(['run', sc]);
  const okTxt = rs.code === 101 && rs.stderr.includes('M4002') && rs.stderr.includes('scoped 子任务失败') && rs.stderr.includes('Caused by M4002') && rs.stderr.includes('at victim');
  check('v30:scoped cause 文本(vm)', okTxt, 'code=' + rs.code + ' stderr=' + rs.stderr.slice(0, 300));
  const rsj = runMing(['run', sc, '--json']);
  let okJson = false;
  try {
    const j = JSON.parse(rsj.stdout);
    const dj = j.diagnostics?.[0];
    okJson = rsj.code === 101 && dj?.code === 'M4002' && dj?.cause?.code === 'M4002'
      && Array.isArray(dj.cause.stack) && dj.cause.stack.length > 0 && dj.cause.stack[0].includes('victim');
  } catch { }
  check('v30:scoped cause json(vm)', okJson, rsj.stdout.slice(0, 300));
  const rst = runMing(['run', sc, '--tree']);
  check('v30:scoped cause(tree)', rst.code === 101 && rst.stderr.includes('Caused by M4002'), rst.stderr.slice(0, 200));

  // 类型门槛:join_detailed 实参非句柄 → M3002
  const pt30 = mingFile('v30-join-type.ming', 'use std.sync;\nfn main() with sync { let _ = std.sync.join_detailed(3); }');
  const rr30 = runMing(['check', pt30]);
  check('v30:join_detailed 类型门槛 M3002', rr30.code === 1 && rr30.stderr.includes('M3002'), 'code=' + rr30.code + ' stderr=' + rr30.stderr.slice(0, 150));
}

// ===================== 31. v0.31:二进制 I/O 雏形 + 任务超时/取消 =====================
{
  // 二进制:to_bytes/to_str 往返 + write/read/append_bytes(含 0/255 边界)
  const bio = mingFile('v31-binary.ming', [
    'use std.fs;',
    'use std.io;',
    '',
    'fn main() with io, fs {',
    '    let bytes = "中文abc".to_bytes();',
    '    print(str(bytes.len()));',
    '    print(bytes.to_str());',
    '    let raw: Vec[u8] = [0, 1, 255, 128];',
    '    match std.fs.write_bytes("/tmp/ming-v31.bin", raw) {',
    '        Ok(_) => { },',
    '        Err(e) => print("W-ERR: " + e),',
    '    }',
    '    match std.fs.read_bytes("/tmp/ming-v31.bin") {',
    '        Ok(v) => { print(str(v.len())); print(str(v[2])); }',
    '        Err(e) => print("R-ERR: " + e),',
    '    }',
    '    std.fs.append_bytes("/tmp/ming-v31.bin", [7]);',
    '    match std.fs.read_bytes("/tmp/ming-v31.bin") {',
    '        Ok(v) => print(str(v.len())),',
    '        Err(e) => print("R2-ERR: " + e),',
    '    }',
    '    let bad: Vec[u8] = [255];',
    '    print(str(bad.to_str().char_len()));',
    '}',
  ].join('\n'));
  const wantBio = '9\n中文abc\n4\n255\n5\n1\n';
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', bio, ...eng]);
    check('v31:二进制 I/O 往返' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === wantBio,
      'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 200));
  }

  // read_bytes 不存在 → Err
  const rb = mingFile('v31-read-missing.ming', 'use std.fs;\nuse std.io;\nfn main() with io, fs { match std.fs.read_bytes("/tmp/ming-v31-nope.bin") { Ok(_) => print("bug"), Err(_) => print("err-ok") } }');
  const rrb = runMing(['run', rb]);
  check('v31:read_bytes 缺文件 Err', rrb.code === 0 && rrb.stdout === 'err-ok\n', rrb.stderr.slice(0, 150));

  // 类型门槛:Vec[i64].to_str → M3015;join_detailed 非句柄 → M3002
  const bt = mingFile('v31-tostr-type.ming', 'use std.io;\nfn main() with io { let v: Vec[i64] = [1]; v.to_str(); }');
  const rbt = runMing(['check', bt]);
  check('v31:Vec[i64].to_str 拒绝 M3015', rbt.code === 1 && rbt.stderr.includes('M3015') && rbt.stderr.includes('Vec[u8]'), rbt.stderr.slice(0, 150));
  const jt = mingFile('v31-jd-type.ming', 'use std.sync;\nfn main() with sync { std.sync.join_detailed(3, 100); }');
  const rjt = runMing(['check', jt]);
  check('v31:join_detailed 非句柄 M3002', rjt.code === 1 && rjt.stderr.includes('M3002'), rjt.stderr.slice(0, 150));

  // 超时与取消:join_detailed(h, ms) 超时 M4010;cancel → join 得"任务已取消";重复 cancel false
  const tc = mingFile('v31-timeout-cancel.ming', [
    'use std.io;',
    'use std.sync;',
    'use std.time;',
    '',
    'fn slow(n: i64) -> i64 with time {',
    '    std.time.sleep(8000);',
    '    return n;',
    '}',
    '',
    'fn fast(n: i64) -> i64 { return n * 2; }',
    '',
    'fn main() with io, sync, time {',
    '    let h1 = std.sync.spawn(slow, 1);',
    '    match std.sync.join_detailed(h1, 300) {',
    '        Ok(_)  => print("bug"),',
    '        Err(info) => print("timeout code=" + info.get("code").unwrap().as_str().unwrap()),',
    '    }',
    '    let h2 = std.sync.spawn(slow, 2);',
    '    print("cancel=" + str(std.sync.cancel(h2)));',
    '    match std.sync.join(h2) {',
    '        Ok(_)  => print("bug2"),',
    '        Err(e) => print("join-after-cancel: " + e),',
    '    }',
    '    print("cancel-again=" + str(std.sync.cancel(h2)));',
    '    let h3 = std.sync.spawn(fast, 21);',
    '    match std.sync.join_detailed(h3, 5000) {',
    '        Ok(v) => print("ok=" + str(v)),',
    '        Err(info) => print("ERR " + debug(info)),',
    '    }',
    '}',
  ].join('\n'));
  const wantTc = 'timeout code=M4010\ncancel=true\njoin-after-cancel: 任务已取消: #2\ncancel-again=false\nok=42\n';
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', tc, ...eng], { });
    check('v31:超时与取消' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === wantTc,
      'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 200));
  }
}

// ===================== 32. v0.32:发布期门禁(配额/熔断)+ wasm 层存活断言 =====================
{
  // wasm 层存活断言(v0.32 制度化:模块必须真的实例化,且导出算对——此前整层静默回落 16 版)
  {
    const { VMInterp } = await import('../src/vm.js');
    const { Checker } = await import('../src/checker.js');
    const src = [
      'fn fib(n: i64) -> i64 {',
      '    if n < 2 { return n; }',
      '    return fib(n - 1) + fib(n - 2);',
      '}',
      '',
      'fn main() with io { print(str(fib(25))); }',
    ].join('\n');
    const p = path.join(TMP, 'w32-live.ming');
    fs.writeFileSync(p, src);
    const c = new Checker(p, () => src);
    const result = c.run(); // 单次编译:vm 与模块查找必须同源
    const vm = new VMInterp(result, { capture: true });
    check('v32:wasm 层存活(实例化非空 + eligible 非空)', !!vm.wasmExports && (vm.wasmEligible?.size ?? 0) > 0, 'wasmExports=' + !!vm.wasmExports);
    let fe = null, mod = null;
    for (const m of result.modules) {
      const e = m.items.get('fib');
      if (e?.kind === 'fn') { fe = e; mod = m; break; }
    }
    const v = vm.callUser(mod, fe, null, [{ t: 'int', v: 25n, bits: 64, signed: true }], null);
    check('v32:wasm 导出金标准(fib(25)=75025,经 wasm 导出)', v?.t === 'int' && (v?.v === 75025n || v?.v === 75025), 'got=' + String(v?.v) + ' type=' + (v?.t ?? '?'));
  }

  // M4011 内存配额(--max-alloc;双引擎)
  const qa = mingFile('v32-quota.ming', 'fn main() with io { let mut v: Vec[i64] = []; let mut i = 0; while i < 100000 { v.push(i); i += 1; } print(str(v.len())); }');
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', qa, ...eng, '--max-alloc', '1000']);
    check('v32:M4011 内存配额' + (eng.length ? '(tree)' : '(vm)'), r.code === 101 && r.stderr.includes('M4011') && r.stderr.includes('alloc-quota-exceeded'), 'code=' + r.code + ' stderr=' + r.stderr.slice(0, 150));
  }

  // M4012 时间熔断(--max-ms;双引擎)
  const qt = mingFile('v32-time.ming', 'fn main() with io { let mut i = 0; while 1 < 2 { i += 1; } }');
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', qt, ...eng, '--max-ms', '300']);
    check('v32:M4012 时间熔断' + (eng.length ? '(tree)' : '(vm)'), r.code === 101 && r.stderr.includes('M4012') && r.stderr.includes('time-quota-exceeded'), 'code=' + r.code + ' stderr=' + r.stderr.slice(0, 150));
  }

  // 配额穿透子任务:子 panic 经错误链带回 M4011(v0.30 × v0.32 协同)
  const qc = mingFile('v32-child-quota.ming', [
    'use std.sync;',
    '',
    'fn big(n: i64) -> i64 {',
    '    let mut v: Vec[i64] = [];',
    '    let mut i = 0;',
    '    while i < n {',
    '        v.push(i);',
    '        i += 1;',
    '    }',
    '    return v.len();',
    '}',
    '',
    'fn main() with io, sync {',
    '    match std.sync.join_detailed(std.sync.spawn(big, 100000), 30000) {',
    '        Ok(_) => print("bug"),',
    '        Err(info) => print("code=" + info.get("code").unwrap().as_str().unwrap()),',
    '    }',
    '}',
  ].join('\n'));
  const rq = runMing(['run', qc, '--max-alloc', '5000']);
  check('v32:配额穿透子任务(M4011 经错误链)', rq.code === 0 && rq.stdout === 'code=M4011\n', 'stdout=' + JSON.stringify(rq.stdout) + ' stderr=' + rq.stderr.slice(0, 150));

  // for-in 安全回落:已知错值路径整体回落 JS VM(正确结果优先于分层)
  const rf = mingFile('v32-forin-fallback.ming', [
    'fn sumv(v: Vec[i64]) -> i64 {',
    '    let mut t = 0;',
    '    for x in v {',
    '        t = t + x;',
    '    }',
    '    return t;',
    '}',
    '',
    'fn main() with io { print(str(sumv([1, 2, 3, 4]))); }',
  ].join('\n'));
  const rfor = runMing(['run', rf]);
  check('v32:for-in 回落结果正确', rfor.code === 0 && rfor.stdout === '10\n', 'stdout=' + JSON.stringify(rfor.stdout));
}

// ===================== 33. v0.33:for-in 步长修复确认 + 模糊基线快速档 =====================
{
  // 步长修复后,for-in 求和经由 wasm 导出金标准(此前该形态回落)
  {
    const { VMInterp } = await import('../src/vm.js');
    const { Checker } = await import('../src/checker.js');
    const src33 = [
      'fn sumv(v: Vec[i64]) -> i64 {',
      '    let mut t = 0;',
      '    for x in v {',
      '        t = t + x;',
      '    }',
      '    return t;',
      '}',
      '',
      'fn main() with io { print(str(sumv([20, 22, 24, 26]))); }',
    ].join('\n');
    const p33 = path.join(TMP, 'w33.ming');
    fs.writeFileSync(p33, src33);
    const result = new Checker(p33, () => src33).run();
    const vm = new VMInterp(result, { capture: true });
    let fe = null, mod = null;
    for (const m of result.modules) {
      const e = m.items.get('sumv');
      if (e?.kind === 'fn') { fe = e; mod = m; break; }
    }
    const elems = [20, 22, 24, 26];
    const ptr = vm.mingAllocRaw(16 + elems.length * 8);
    const dv = new DataView(vm.wasmMemory.buffer);
    dv.setBigInt64(ptr, BigInt(elems.length), true);
    dv.setBigInt64(ptr + 8, BigInt(elems.length), true);
    elems.forEach((x, i) => dv.setBigInt64(ptr + 16 + 8 * i, BigInt(x), true));
    const r = vm.wasmExports.m0(ptr);
    check('v33:for-in 求和经 wasm 导出(步长修复)', Number(r) === 92, 'm0=' + String(r));
    const rr = runMing(['run', p33]);
    check('v33:for-in 双引擎结果', rr.code === 0 && rr.stdout === '92\n', rr.stderr.slice(0, 150));
  }

  // 模糊基线快速档(种子固定可复现;完整档:node tests/fuzz.mjs --count 500 --seed 变化)
  const fuzz = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '40', '--seed', '20261109'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v33:模糊基线快速档(40 程序三后端一致)', fuzz.status === 0 && /分歧 0/.test(fuzz.stdout), 'code=' + fuzz.status + ' tail=' + (fuzz.stdout ?? '').slice(-120));
}

// ===================== 34. v0.34:std.crypto(安全工具之北支柱 6 第一块)=====================
{
  const ck = mingFile('v34-crypto.ming', [
    'use std.crypto;',
    '',
    'fn main() with io, crypto {',
    '    print(std.crypto.md5("abc"));',
    '    print(std.crypto.sha1("abc"));',
    '    print(std.crypto.sha256("abc"));',
    '    print(str(std.crypto.sha512("abc").char_len()));',
    '    print(str(std.crypto.sha384("").char_len()));',
    '}',
  ].join('\n'));
  const wantCk = [
    '900150983cd24fb0d6963f7d28e17f72',
    'a9993e364706816aba3e25717850c26c9cd0d89d',
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    '128',
    '96',
  ].join('\n') + '\n';
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', ck, ...eng]);
    check('v34:crypto 已知向量' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === wantCk,
      'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout));
  }

  // 空串向量(sha256("") 公开值)
  const ce = mingFile('v34-crypto-empty.ming', 'use std.crypto;\nfn main() with io, crypto { print(std.crypto.sha256("")); }');
  const re = runMing(['run', ce]);
  check('v34:sha256 空串向量', re.code === 0 && re.stdout === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n', re.stdout);

  // crypto 效果强制 M3029(新效果名)
  const cp = mingFile('v34-crypto-cap.ming', 'use std.crypto;\nfn main() with io { print(std.crypto.sha256("x")); }');
  const rp = runMing(['check', cp]);
  check('v34:crypto 效果强制 M3029', rp.code === 1 && rp.stderr.includes('M3029') && rp.stderr.includes('crypto'), rp.stderr.slice(0, 150));
}

// ===================== 35. v0.35:std.bin 显式字节序 + crypto HMAC + 模糊器 as 扩展 =====================
{
  // bin:LE/BE 打包已知向量 + 往返 + 越界 Err + u64 补码位型(双引擎)
  const bn = mingFile('v35-bin.ming', [
    'use std.bin;',
    '',
    'fn main() with io {',
    '    let le = std.bin.pack_u32_le(0x12345678);',
    '    print(str(le[0]) + "," + str(le[1]) + "," + str(le[2]) + "," + str(le[3]));',
    '    let be = std.bin.pack_u32_be(0x12345678);',
    '    print(str(be[0]) + "," + str(be[1]) + "," + str(be[2]) + "," + str(be[3]));',
    '    match std.bin.unpack_u32_le(std.bin.pack_u32_le(305419896), 0) {',
    '        Ok(v) => print(str(v)),',
    '        Err(e) => print("ERR: " + e),',
    '    }',
    '    match std.bin.unpack_u16_le(std.bin.pack_u32_le(1), 3) {',
    '        Ok(_) => print("bug"),',
    '        Err(e) => print("ERR: " + e),',
    '    }',
    '    match std.bin.unpack_u64_le(std.bin.pack_u64_le(-1), 0) {',
    '        Ok(v) => print(str(v)),',
    '        Err(e) => print("ERR: " + e),',
    '    }',
    '    print(str(std.bin.pack_u16_be(1).len()));',
    '}',
  ].join('\n'));
  const wantBn = [
    '120,86,52,18',
    '18,52,86,120',
    '305419896',
    'ERR: unpack:偏移越界(需 [3, 5),长度 4)',
    '-1',
    '2',
  ].join('\n') + '\n';
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', bn, ...eng]);
    check('v35:bin 显式字节序' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === wantBn,
      'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout));
  }

  // pack 值域超限 → panic M4001(u16 收到负数)
  const qv = mingFile('v35-bin-range.ming', 'use std.bin;\nfn main() with io { print(str(std.bin.pack_u16_le(-1).len())); }');
  const rqv = runMing(['run', qv]);
  check('v35:pack 值域超限 M4001', rqv.code === 101 && rqv.stderr.includes('M4001') && rqv.stderr.includes('超出 u16'), 'code=' + rqv.code + ' stderr=' + rqv.stderr.slice(0, 150));

  // HMAC 公开向量(维基百科 HMAC-SHA256 标准例)
  const hm = mingFile('v35-hmac.ming', [
    'use std.crypto;',
    '',
    'fn main() with io, crypto {',
    '    print(std.crypto.hmac_sha256("key", "The quick brown fox jumps over the lazy dog"));',
    '    print(std.crypto.hmac_md5("key", "The quick brown fox jumps over the lazy dog"));',
    '}',
  ].join('\n'));
  const wantHm = [
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    '80070713463e7749b90c2dc24911e275',
  ].join('\n') + '\n';
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', hm, ...eng]);
    check('v35:HMAC 公开向量' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === wantHm,
      'stdout=' + JSON.stringify(r.stdout));
  }

  // 模糊器 as 扩展快速验证(小种子;完整覆盖见 fuzz.mjs 深档)
  const fuzz35 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '30', '--seed', '35035'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v35:模糊 as/扩展形态(30 程序三后端一致)', fuzz35.status === 0 && /分歧 0/.test(fuzz35.stdout ?? ''), 'code=' + fuzz35.status + ' tail=' + (fuzz35.stdout ?? '').slice(-120));
}

// ===================== 36. v0.36:字节流正则 + AES-256-CBC =====================
{
  // 字节流正则:latin1 无损(零字节与高位字节可匹配;双引擎)
  const rb = mingFile('v36-re-bytes.ming', [
    'use std.re;',
    '',
    'fn main() with io {',
    '    let data: Vec[u8] = [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x01, 0x57, 0x6f, 0x72, 0x6c, 0x64];',
    '    print(str(std.re.is_match_bytes(r"World", data)));',
    '    print(str(std.re.is_match_bytes(r"\\x00\\x01", data)));',
    '    match std.re.find_bytes(r"W\\x6frld", data) {',
    '        Some(m) => print(str(m.len())),',
    '        None    => print("none"),',
    '    }',
    '    let out = std.re.replace_bytes(r"\\x00\\x01", data, [0x2d, 0x2d]);',
    '    print(str(out.len()));',
    '    print(str(std.re.is_match_bytes(r"\\x2d\\x2d", out)));',
    '}',
  ].join('\n'));
  const wantRb = 'true\ntrue\n5\n12\ntrue\n';
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', rb, ...eng]);
    check('v36:字节流正则' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === wantRb,
      'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 200));
  }

  // AES-256-CBC:往返 + key 长度校验 + 随机 IV(两次密文不同;双引擎)
  const ae = mingFile('v36-aes.ming', [
    'use std.crypto;',
    '',
    'fn main() with io, crypto {',
    '    let key = "0123456789abcdef0123456789abcdef";',
    '    match std.crypto.aes256_encrypt(key, "机密数据 secret-42") {',
    '        Ok(data) => {',
    '            print(str(data.len()));',
    '            match std.crypto.aes256_decrypt(key, data) {',
    '                Ok(pt) => print(pt),',
    '                Err(e) => print("D-ERR: " + e),',
    '            }',
    '        }',
    '        Err(e) => print("E-ERR: " + e),',
    '    }',
    '    match std.crypto.aes256_encrypt("short", "x") {',
    '        Ok(_) => print("bug"),',
    '        Err(e) => print("KEY-ERR: " + e),',
    '    }',
    '    let c1 = std.crypto.aes256_encrypt(key, "same-input");',
    '    let c2 = std.crypto.aes256_encrypt(key, "same-input");',
    '    print(str(c1.unwrap() == c2.unwrap()));',
    '}',
  ].join('\n'));
  const wantAe = ['48', '机密数据 secret-42', 'KEY-ERR: aes256_encrypt:key 必须恰好 32 字节(AES-256),得到 5', 'false'].join('\n') + '\n';
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', ae, ...eng]);
    check('v36:AES-256 往返/校验/随机 IV' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === wantAe,
      'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 200));
  }
}

// ===================== 37. v0.37:AES-256-GCM(带认证)+ 模糊器 str/for-in 扩展 =====================
{
  // GCM:往返 + 篡改检出(异或翻转一个密文字节,tag 校验必失败;双引擎)
  const gm = mingFile('v37-gcm.ming', [
    'use std.crypto;',
    '',
    'fn main() with io, crypto {',
    '    let key = "0123456789abcdef0123456789abcdef";',
    '    match std.crypto.aes256_gcm_encrypt(key, "authenticated 数据") {',
    '        Ok(data) => {',
    '            print(str(data.len()));',
    '            match std.crypto.aes256_gcm_decrypt(key, data) {',
    '                Ok(pt) => print(pt),',
    '                Err(e) => print("D-ERR: " + e),',
    '            }',
    '            let mut tampered = data.clone();',
    '            tampered[40] = tampered[40] ^ (1 as u8);',
    '            match std.crypto.aes256_gcm_decrypt(key, tampered) {',
    '                Ok(_)  => print("篡改未检出!"),',
    '                Err(e) => print("T-ERR ok"),',
    '            }',
    '        }',
    '        Err(e) => print("E-ERR: " + e),',
    '    }',
    '}',
  ].join('\n'));
  const wantGm = ['48', 'authenticated 数据', 'T-ERR ok'].join('\n') + '\n';
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', gm, ...eng]);
    check('v37:GCM 往返/篡改检出' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === wantGm,
      'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 200));
  }

  // 模糊器扩展形态快速档(str + for-in;种子固定)
  const fuzz37 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '50', '--seed', '37037'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v37:模糊扩展形态(50 程序三后端一致)', fuzz37.status === 0 && /分歧 0/.test(fuzz37.stdout ?? ''), 'code=' + fuzz37.status + ' tail=' + (fuzz37.stdout ?? '').slice(-120));
}

// ===================== 38. v0.38:ming build dist 产物 + 模糊器 if/else =====================
{
  // dist 可移植产物:项目构建 → launcher 直跑(args 透传 / exit 0 / panic 101 / 跨 cwd)
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-dist-'));
  fs.writeFileSync(path.join(proj, 'ming.toml'), '[project]\nname = "dist38"\nversion = "0.1.0"\nentry = "main.ming"\n');
  fs.writeFileSync(path.join(proj, 'main.ming'), [
    'fn greet(name: str) -> str {',
    '    return "hi, " + name;',
    '}',
    '',
    'fn main(args: Vec[str]) with io {',
    '    let who = if args.len() > 0 { args[0] } else { "ming" };',
    '    print(greet(who));',
    '    print(str(args.len()));',
    '}',
  ].join('\n'));
  const build = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: proj, timeout: 60000 });
  const distOk = build.status === 0 && fs.existsSync(path.join(proj, 'dist', 'ming-app.mjs')) && fs.existsSync(path.join(proj, 'dist', 'runtime', 'vm.js')) && fs.existsSync(path.join(proj, 'dist', 'app.bytecode.json'));
  check('v38/v39:ming build 产出 dist(字节码)', distOk, 'code=' + build.status + ' out=' + (build.stdout ?? '').slice(-100));
  check('v39:AOT 产物无明文源', !fs.existsSync(path.join(proj, 'dist', 'app.ming')), 'dist 含 app.ming');
  const withSrc = spawnSync(process.execPath, [MING, 'build', '--with-source'], { encoding: 'utf8', cwd: proj, timeout: 60000 });
  check('v39:--with-source 附源码', withSrc.status === 0 && fs.existsSync(path.join(proj, 'dist', 'app.ming')), 'code=' + withSrc.status);
  const run = (args2, cwd2) => spawnSync(process.execPath, [path.join(proj, 'dist', 'ming-app.mjs'), ...args2], { encoding: 'utf8', cwd: cwd2 ?? proj, timeout: 60000 });
  const r1 = run(['--', 'alice']);
  check('v38:launcher args 透传 + 跨 cwd', r1.status === 0 && r1.stdout === 'hi, alice\n1\n', 'stdout=' + JSON.stringify(r1.stdout) + ' stderr=' + (r1.stderr ?? '').slice(0, 150));
  const r2 = run([]);
  check('v38:launcher 无参默认', r2.status === 0 && r2.stdout === 'hi, ming\n0\n', JSON.stringify(r2.stdout));
  // v0.49.1(社区反馈 bytes 的"拷贝到异地 + 无关 cwd"测试):dist 自包含性实证
  const rElse = run(['--', 'bob'], os.tmpdir());
  check('v49.1:launcher 从无关 cwd 运行', rElse.status === 0 && rElse.stdout === 'hi, bob\n1\n', 'status=' + rElse.status + ' stdout=' + JSON.stringify(rElse.stdout) + ' stderr=' + (rElse.stderr ?? '').slice(0, 150));
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-dist-moved-'));
  fs.cpSync(path.join(proj, 'dist'), path.join(moved, 'dist'), { recursive: true });
  const rMove = spawnSync(process.execPath, [path.join(moved, 'dist', 'ming-app.mjs'), '--', 'carol'], { encoding: 'utf8', cwd: os.tmpdir(), timeout: 60000 });
  check('v49.1:dist 异地拷贝后可运行', rMove.status === 0 && rMove.stdout === 'hi, carol\n1\n', 'status=' + rMove.status + ' stdout=' + JSON.stringify(rMove.stdout) + ' stderr=' + (rMove.stderr ?? '').slice(0, 150));
  fs.rmSync(moved, { recursive: true, force: true });
  fs.writeFileSync(path.join(proj, 'panicmain.ming'), 'fn main() with io { panic("dist panic 测试"); }');
  fs.writeFileSync(path.join(proj, 'ming.toml'), '[project]\nname = "dist38"\nversion = "0.1.0"\nentry = "panicmain.ming"\n');
  spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: proj, timeout: 60000 });
  const r3 = run([]);
  check('v38:launcher panic → 101', r3.status === 101 && (r3.stderr ?? '').includes('M4001'), 'status=' + r3.status + ' stderr=' + (r3.stderr ?? '').slice(0, 120));

  // 模糊器 if/else 形态快速档
  const fuzz38 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '40', '--seed', '38038'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v38:模糊 if/else 形态(40 程序三后端一致)', fuzz38.status === 0 && /分歧 0/.test(fuzz38.stdout ?? ''), 'code=' + fuzz38.status + ' tail=' + (fuzz38.stdout ?? '').slice(-120));
  fs.rmSync(proj, { recursive: true, force: true });
}

// ===================== 34b. v0.39:C 后端 C1(ming cc)=====================
// (#34 去重,v0.56:原编号 34,与 v0.34 段重复;文档无 §34 指向本段,v0.34 段保持 34。)
{
  const cdir = path.join(TMP, 'cc39');
  fs.mkdirSync(cdir, { recursive: true });
  const detectCC39 = () => {
    const candidates = [];
    if (process.env.MING_CC) candidates.push(process.env.MING_CC);
    candidates.push('gcc', 'clang', 'cc');
    for (const p of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
      if (fs.existsSync(p)) candidates.push(p);
    }
    for (const c of candidates) {
      try { const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15000 }); if (r.status === 0) return c; } catch { /* 试下一个 */ }
    }
    return null;
  };
  const firstLine = (s) => (s ?? '').split('\n')[0];

  // --emit-c 快照(不依赖编译器,恒跑)
  const c1src = [
    'fn fib(n: i64) -> i64 {',
    '    if n < 2 { return n; }',
    '    return fib(n - 1) + fib(n - 2);',
    '}',
    '',
    'fn sum_to(n: i64) -> i64 {',
    '    let mut total: i64 = 0;',
    '    for i in 1..n + 1 {',
    '        total += i;',
    '    }',
    '    return total;',
    '}',
    '',
    'fn main() with io {',
    '    print(str(fib(15)));',
    '    print(str(sum_to(100)));',
    '}',
  ].join('\n');
  const c1file = path.join(cdir, 'c1.ming');
  fs.writeFileSync(c1file, c1src);
  const rc = spawnSync(process.execPath, [MING, 'cc', c1file, '--emit-c', '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
  const cPath = path.join(cdir, 'out', 'c1.c');
  const cCode = fs.existsSync(cPath) ? fs.readFileSync(cPath, 'utf8') : '';
  check('v39:emit-c 产出 C 源', rc.status === 0 && cCode.includes('__builtin_add_overflow') && cCode.includes('ming_panic') && cCode.includes('static long long m'), 'code=' + rc.status + ' stderr=' + (rc.stderr ?? '').slice(0, 150));
  check('v39:emit-c 含 AOT main 与 _setmode', cCode.includes('ming_main') && cCode.includes('_O_BINARY'), '');

  // AOT 形态外拒绝(str main)
  // v0.40(C2):str/Vec 形态已入 C 面 —— 原"str main 拒绝"改为正向用例;插值串仍属 C3
  fs.writeFileSync(path.join(cdir, 'strmain.ming'), 'fn main() with io { print("hello"); print(str("abc".char_len())); }');
  const rs = spawnSync(process.execPath, [MING, 'cc', path.join(cdir, 'strmain.ming'), '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
  const exeS = path.join(cdir, 'out', 'strmain' + (process.platform === 'win32' ? '.exe' : ''));
  const rccS = spawnSync(exeS, [], { encoding: 'utf8', timeout: 60000 });
  const rjS = runMing(['run', path.join(cdir, 'strmain.ming')]);
  check('v40:str main 正向(cc = run)', rccS.status === 0 && rccS.stdout === rjS.stdout, 'cc=' + JSON.stringify(rccS.stdout) + ' js=' + JSON.stringify(rjS.stdout) + ' build=' + rs.status);
  fs.writeFileSync(path.join(cdir, 'interp.ming'), 'fn main() with io { print("x=\\{1}"); }');
  const ri = spawnSync(process.execPath, [MING, 'cc', path.join(cdir, 'interp.ming'), '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
  check('v40:AOT 形态外拒绝(插值串属 C3)', ri.status === 1 && (ri.stderr ?? '').includes('不支持'), 'status=' + ri.status + ' stderr=' + (ri.stderr ?? '').slice(0, 120));

  const ccBin = detectCC39();
  if (ccBin) {
    // 四方一致:tree = vm(+wasm) = vm(--no-wasm) = cc 原生产物
    const build = spawnSync(process.execPath, [MING, 'cc', c1file, '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
    const exe = path.join(cdir, 'out', 'c1' + (process.platform === 'win32' ? '.exe' : ''));
    const rcc = fs.existsSync(exe) ? spawnSync(exe, [], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stdout: '' };
    const rvm = runMing(['run', c1file]);
    const rtree = runMing(['run', c1file, '--tree']);
    const rnow = runMing(['run', c1file, '--no-wasm']);
    check('v39:cc 四方一致(fib+循环)', build.status === 0 && rcc.status === 0 && rcc.stdout === rvm.stdout && rvm.stdout === rtree.stdout && rvm.stdout === rnow.stdout,
      'build=' + build.status + ' cc=' + JSON.stringify(rcc.stdout) + ' vm=' + JSON.stringify(rvm.stdout) + ' tree=' + JSON.stringify(rtree.stdout));

    // panic 对齐:main 内具体消息(binopValues)与 fn 内 wasm 通用消息,首行 + 退出码 101
    const panicSrcs = [
      ['main-ovf', 'main 内溢出', 'fn main() with io { let x = 9223372036854775807; let y = x + 1; print(str(y)); }'],
      ['fn-ovf', 'fn 内溢出', 'fn boom(a: i64, b: i64) -> i64 { return a * b; } fn main() with io { print(str(boom(3037000500, 3037000500))); }'],
      ['div-zero', '除零', 'fn main() with io { print(str(10 / 0)); }'],
    ];
    for (const [fileKey, desc, src] of panicSrcs) {
      const pf = path.join(cdir, 'panic-' + fileKey + '.ming');
      fs.writeFileSync(pf, src);
      const rj = runMing(['run', pf]);
      spawnSync(process.execPath, [MING, 'cc', pf, '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
      const pexe = path.join(cdir, 'out', 'panic-' + fileKey + (process.platform === 'win32' ? '.exe' : ''));
      const rc2 = fs.existsSync(pexe) ? spawnSync(pexe, [], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stderr: '' };
      check('v39:panic 首行对齐(' + desc + ')', rj.code === 101 && rc2.status === 101 && firstLine(rj.stderr) === firstLine(rc2.stderr),
        'js=' + JSON.stringify(firstLine(rj.stderr)) + ' cc=' + JSON.stringify(firstLine(rc2.stderr)) + ' codes=' + rj.code + '/' + rc2.status);
    }

    // u64/类型级/as 截断 全字节一致
    fs.writeFileSync(path.join(cdir, 'u64c.ming'), [
      'fn umax(a: u64, b: u64) -> u64 {',
      '    if a > b { return a; }',
      '    return b;',
      '}',
      'fn narrow(x: i64) -> i64 {',
      '    return x as u8 as i64;',
      '}',
      'fn main() with io {',
      '    print(str(umax(u64.max_value(), 5u64)));',
      '    print(str(narrow(300)));',
      '    print(str(narrow(-1)));',
      '    print(str(i64.min_value()));',
      '}',
    ].join('\n'));
    const uf = path.join(cdir, 'u64c.ming');
    const build2 = spawnSync(process.execPath, [MING, 'cc', uf, '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
    const uexe = path.join(cdir, 'out', 'u64c' + (process.platform === 'win32' ? '.exe' : ''));
    const ru = fs.existsSync(uexe) ? spawnSync(uexe, [], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stdout: '' };
    const ruj = runMing(['run', uf]);
    check('v39:cc u64/as/类型级 一致', build2.status === 0 && ru.status === 0 && ru.stdout === ruj.stdout,
      'cc=' + JSON.stringify(ru.stdout) + ' js=' + JSON.stringify(ruj.stdout) + ' build=' + build2.status);
    check('v39:编译器探测命中', typeof ccBin === 'string' && ccBin.length > 0, 'cc=' + ccBin);
  } else {
    check('v39:C 腿(无编译器,跳过运行时差分)', true);
  }

  // 模糊器 v0.39 快速档(新形态:f64+math/match/loop/Option/Vec/str 方法)
  const fuzz39 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '40', '--seed', '39039'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v39:模糊器加深形态(40 程序一致)', fuzz39.status === 0 && /分歧 0/.test(fuzz39.stdout ?? ''), 'code=' + fuzz39.status + ' tail=' + (fuzz39.stdout ?? '').slice(-150));
}

// ===================== 35b. v0.40:C2(str/Vec[i64])+ engdiff 自举工具 =====================
// (#34 去重,v0.56:原编号 35,与 v0.35 段重复。)
{
  const cdir = path.join(TMP, 'cc40');
  fs.mkdirSync(cdir, { recursive: true });

  // C2 综合程序:字符串(拼接/相等/char_len/pad_left/slice_chars/replace/中文)+ Vec[i64]
  // (字面量/下标/len/push/for-in/mut 传参值语义)+ match(含 guard)+ 类型级
  const c2src = [
    'fn join_count(items: Vec[i64]) -> i64 {',
    '    let mut acc = 0;',
    '    for e in items { acc += e; }',
    '    return acc;',
    '}',
    'fn shout(s: str, times: i64) -> str {',
    '    let mut out = "";',
    '    let mut i = 0;',
    '    while i < times { out = out + s + "!"; i = i + 1; }',
    '    return out;',
    '}',
    'fn bump(mut v: Vec[i64], x: i64) -> i64 {',
    '    v.push(x);',
    '    return v.len() as i64;',
    '}',
    'fn main() with io {',
    '    let greeting = "你好, ming";',
    '    print(greeting);',
    '    print(str(greeting.char_len()));',
    '    let loud = shout("go", 3);',
    '    print(loud);',
    '    if loud == "go!go!go!" { print(str(1)); } else { print(str(0)); }',
    '    let nums: Vec[i64] = [10, 20, 30];',
    '    print(str(nums.len()));',
    '    print(str(nums[1]));',
    '    print(str(join_count(nums)));',
    '    print(str(bump(nums, 40)));',
    '    print(str(nums.len()));',
    '    let mut flags: Vec[i64] = [1, 0, 1];',
    '    flags[1] = 7;',
    '    flags.push(-5);',
    '    if flags.contains(7) { print(str(100)); }',
    '    let m = match 3 { 1 => 100, 3 => 300, _ => 0 };',
    '    let g = match 5 { 1 if x > 9 => 1, _ => 42 };',
    '    print(str(m + g));',
    '    let padded = "ab".pad_left(5);',
    '    print(padded);',
    '    print(str(padded.char_len()));',
    '    let cut = "hello ming".slice_chars(0, 5);',
    '    print(cut);',
    '    let replaced = "aXbXc".replace("X", "--");',
    '    print(replaced);',
    '    let s2 = "中文abc";',
    '    print(str(s2.char_len()));',
    '}',
  ].join('\n');
  // g 的 guard 引用未定义变量 x → 换成字面 guard
  const c2srcFixed = c2src.replace('1 if x > 9 => 1', '1 if 2 > 9 => 1');
  const c2file = path.join(cdir, 'c2full.ming');
  fs.writeFileSync(c2file, c2srcFixed);
  const build40 = spawnSync(process.execPath, [MING, 'cc', c2file, '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  const exe40 = path.join(cdir, 'out', 'c2full' + (process.platform === 'win32' ? '.exe' : ''));
  const rcc40 = spawnSync(exe40, [], { encoding: 'utf8', timeout: 60000 });
  const rj40 = runMing(['run', c2file]);
  check('v40:C2 综合 四方一致(str/Vec/match/值语义)', build40.status === 0 && rcc40.status === 0 && rcc40.stdout === rj40.stdout,
    'build=' + build40.status + ' cc=' + JSON.stringify(rcc40.stdout).slice(0, 120) + ' js=' + JSON.stringify(rj40.stdout).slice(0, 120));

  // panic 对齐:vec OOB 与 slice OOB(消息含 "(用 .get(i) 返回 Option)" 后缀)
  const panic40 = [
    ['vec-oob', 'fn main() with io { let v: Vec[i64] = [1, 2, 3]; print(str(v[9])); }'],
    ['slice-oob', 'fn main() with io { let s = "hello"; print(s.slice_chars(0, 9)); }'],
  ];
  for (const [k, src] of panic40) {
    const pf = path.join(cdir, 'p40-' + k + '.ming');
    fs.writeFileSync(pf, src);
    const rj = runMing(['run', pf]);
    spawnSync(process.execPath, [MING, 'cc', pf, '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
    const pe = path.join(cdir, 'out', 'p40-' + k + (process.platform === 'win32' ? '.exe' : ''));
    const rc = spawnSync(pe, [], { encoding: 'utf8', timeout: 60000 });
    const fl = (s) => (s ?? '').split('\n')[0];
    check('v40:panic 首行对齐(' + k + ')', rj.code === 101 && rc.status === 101 && fl(rj.stderr) === fl(rc.stderr),
      'js=' + JSON.stringify(fl(rj.stderr)) + ' cc=' + JSON.stringify(fl(rc.stderr)));
  }

  // engdiff 自举工具:多引擎一致路径(退出码 0 + 一致标记)
  const red = spawnSync(process.execPath, [MING, 'run', path.join(ROOT, 'tools', 'engdiff.ming'), '--', path.join(ROOT, 'examples', 'fib.ming')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  check('v40:engdiff 自举工具(三引擎一致)', red.status === 0 && (red.stdout ?? '').includes('engdiff: 一致'), 'code=' + red.status + ' tail=' + (red.stdout ?? '').slice(-80));

  // 模糊器 v0.40 快速档(cc 族已拓宽到 C2 面)
  const fuzz40 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '40', '--seed', '40040'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v40:模糊器 C2 面(40 程序多后端一致)', fuzz40.status === 0 && /分歧 0/.test(fuzz40.stdout ?? ''), 'code=' + fuzz40.status + ' tail=' + (fuzz40.stdout ?? '').slice(-150));
}

// ===================== 36b. v0.41:C3(Map/Option/f64 打印)+ cc 全形态差分 =====================
// (#34 去重,v0.56:原编号 36,与 v0.36 段重复。)
{
  const cdir = path.join(TMP, 'cc41');
  fs.mkdirSync(cdir, { recursive: true });

  // C3 综合程序:Map(插入序/set 覆盖/index/has/get/for-in(k,v))+ Option(pop/get/unwrap/
  // unwrap_or/is_none)+ str(trim 族/starts/ends)+ f64 打印(floatStr 对齐)+ mut 传参值语义
  const c3src = [
    'fn tally(mut counts: Map[str, i64], key: str, by: i64) -> i64 {',
    '    let cur = counts.get(key).unwrap_or(0);',
    '    counts.set(key, cur + by);',
    '    return counts.len() as i64;',
    '}',
    'fn main() with io {',
    '    let mut m: Map[str, i64] = {"alpha": 1, "beta": 2};',
    '    print(str(tally(m, "gamma", 9)));',
    '    print(str(m.len()));',
    '    m["alpha"] = 100;',
    '    m["delta"] = 4;',
    '    print(str(m["alpha"] + m["delta"]));',
    '    for (k, v) in m {',
    '        print(k);',
    '        print(str(v));',
    '    }',
    '    print(str(m.get("beta").unwrap()));',
    '    print(str(m.get("nope").unwrap_or(77)));',
    '    if m.has("beta") { print(str(1)); }',
    '    let mut vv: Vec[i64] = [5, 6, 7];',
    '    print(str(vv.pop().unwrap_or(0)));',
    '    print(str(vv.get(0).unwrap()));',
    '    let empty: Option[i64] = None;',
    '    if empty.is_none() { print(str(-1)); }',
    '    let s = "  hello  ";',
    '    print("[" + s.trim() + "]");',
    '    print(str(if s.trim_start().starts_with("hello") { 1 } else { 0 }));',
    '    print(str(if "abc".ends_with("bc") { 1 } else { 0 }));',
    '    let f = 2.25;',
    '    print(f);',
    '    print(str(2.0));',
    '    print(str(1.5));',
    '    print(str(0.0015));',
    '    print(str(1.0e21));',
    '    print(str(1.0e-7));',
    '    print(str(123456.78));',
    '}',
  ].join('\n');
  const c3file = path.join(cdir, 'c3full.ming');
  fs.writeFileSync(c3file, c3src);
  const build41 = spawnSync(process.execPath, [MING, 'cc', c3file, '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  const exe41 = path.join(cdir, 'out', 'c3full' + (process.platform === 'win32' ? '.exe' : ''));
  const rcc41 = spawnSync(exe41, [], { encoding: 'utf8', timeout: 60000 });
  const rj41 = runMing(['run', c3file]);
  check('v41:C3 综合 四方一致(Map/Option/f64/trim)', build41.status === 0 && rcc41.status === 0 && rcc41.stdout === rj41.stdout,
    'build=' + build41.status + ' cc=' + JSON.stringify(rcc41.stdout).slice(0, 100) + ' js=' + JSON.stringify(rj41.stdout).slice(0, 100));

  // panic 对齐:unwrap None(M4006)与 map 缺键(M4007)
  const panic41 = [
    ['unwrap-none', 'fn main() with io { let mut m: Map[str, i64] = {"a": 1}; print(str(m.get("zz").unwrap())); }'],
    ['map-missing', 'fn main() with io { let m: Map[str, i64] = {"a": 1}; print(str(m["zz"])); }'],
  ];
  for (const [k, src] of panic41) {
    const pf = path.join(cdir, 'p41-' + k + '.ming');
    fs.writeFileSync(pf, src);
    const rj = runMing(['run', pf]);
    spawnSync(process.execPath, [MING, 'cc', pf, '--no-run', '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
    const pe = path.join(cdir, 'out', 'p41-' + k + (process.platform === 'win32' ? '.exe' : ''));
    const rc = spawnSync(pe, [], { encoding: 'utf8', timeout: 60000 });
    const fl = (s) => (s ?? '').split('\n')[0];
    check('v41:panic 首行对齐(' + k + ')', rj.code === 101 && rc.status === 101 && fl(rj.stderr) === fl(rc.stderr),
      'js=' + JSON.stringify(fl(rj.stderr)) + ' cc=' + JSON.stringify(fl(rc.stderr)));
  }

  // 模糊器 v0.41 快速档(cc 族 = wide 全形态)
  const fuzz41 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '40', '--seed', '40041'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v41:模糊器 C3 全形态(40 程序多后端一致)', fuzz41.status === 0 && /分歧 0/.test(fuzz41.stdout ?? ''), 'code=' + fuzz41.status + ' tail=' + (fuzz41.stdout ?? '').slice(-150));
}

// ===================== 37b. v0.42:C4 extern fn FFI(效果即门禁 + C 后端 dlsym)=====================
// (#34 去重,v0.56:原编号 37,与 v0.37 段重复。)
{
  const cdir = path.join(TMP, 'cc42');
  fs.mkdirSync(cdir, { recursive: true });

  // 效果即门禁:无 with ffi 的调用 → M3029(引擎无关)
  const ffiSrc = [
    'extern "msvcrt" fn _abs64(x: i64) -> i64;',
    'fn main() with io, ffi {',
    '    print(str(_abs64(-42)));',
    '    print(str(_abs64(123456789)));',
    '}',
  ].join('\n');
  const gateSrc = 'extern "msvcrt" fn _abs64(x: i64) -> i64;\nfn main() with io { print(str(_abs64(-1))); }';
  const gateFile = path.join(cdir, 'gate.ming');
  fs.writeFileSync(gateFile, gateSrc);
  const rg = runMing(['check', gateFile]);
  check('v42:ffi 效果门禁(无 with ffi → M3029)', rg.code === 1 && (rg.stderr ?? '').includes('M3029') && (rg.stderr ?? '').includes('ffi'), 'code=' + rg.code + ' stderr=' + (rg.stderr ?? '').slice(0, 150));

  // JS 引擎:M4001 诚实拒绝(合成桩体);C 后端:dlsym 真调用(Windows;其他平台跳过)
  if (process.platform === 'win32') {
    const ffiFile = path.join(cdir, 'ffi42.ming');
    fs.writeFileSync(ffiFile, ffiSrc);
    const rj = runMing(['run', ffiFile]);
    check('v42:JS 引擎 ffi → M4001 拒绝', rj.code === 101 && (rj.stderr ?? '').includes('ffi 调用需要 C 后端'), 'code=' + rj.code + ' stderr=' + (rj.stderr ?? '').slice(0, 120));
    const build42 = spawnSync(process.execPath, [MING, 'cc', ffiFile, '--no-run', '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
    const exe42 = path.join(cdir, 'out', 'ffi42.exe');
    const rc42 = fs.existsSync(exe42) ? spawnSync(exe42, [], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stdout: '' };
    check('v42:C 后端 extern dlsym 调用', build42.status === 0 && rc42.status === 0 && rc42.stdout === '42\n123456789\n',
      'build=' + build42.status + ' out=' + JSON.stringify(rc42.stdout));
    // --static:静态链接产物可运行
    const buildS = spawnSync(process.execPath, [MING, 'cc', ffiFile, '--no-run', '--static', '--out', path.join(cdir, 'out2')], { encoding: 'utf8', cwd: ROOT, timeout: 180000 });
    const exeS = path.join(cdir, 'out2', 'ffi42.exe');
    const rcS = fs.existsSync(exeS) ? spawnSync(exeS, [], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stdout: '' };
    check('v42:--static 静态链接产物', buildS.status === 0 && rcS.status === 0 && rcS.stdout === '42\n123456789\n',
      'build=' + buildS.status + ' out=' + JSON.stringify(rcS.stdout));
  } else {
    check('v42:extern dlsym(非 Windows 跳过)', true);
  }

  // 模糊器 v0.42 快速档
  const fuzz42 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '40', '--seed', '40042'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v42:模糊器快档(40 程序多后端一致)', fuzz42.status === 0 && /分歧 0/.test(fuzz42.stdout ?? ''), 'code=' + fuzz42.status + ' tail=' + (fuzz42.stdout ?? '').slice(-150));
}

// ===================== 38b. v0.43:ffi str 桥 + Result 进 C 面 =====================
// (#34 去重,v0.56:原编号 38,与 v0.38 段重复。)
{
  const cdir = path.join(TMP, 'cc43');
  fs.mkdirSync(cdir, { recursive: true });

  // Result[i64,str] 纯程序(无 ffi):JS 三引擎与 C 全字节一致 + M4006 Err 消息对齐
  const resSrc = [
    'fn parse_pos(n: i64) -> Result[i64, str] {',
    '    if n < 0 { return Err("负数"); }',
    '    if n > 100 { return Err("过大"); }',
    '    return Ok(n);',
    '}',
    'fn main() with io {',
    '    print(str(parse_pos(42).unwrap()));',
    '    print(parse_pos(-1).unwrap_err());',
    '    print(str(parse_pos(200).unwrap_or(-2)));',
    '    if parse_pos(7).is_ok() { print(str(1)); }',
    '    if parse_pos(-1).is_err() { print(str(2)); }',
    '    let r: Result[i64, str] = Err("boom");',
    '    print(r.unwrap_err());',
    '}',
  ].join('\n');
  const resFile = path.join(cdir, 'res43.ming');
  fs.writeFileSync(resFile, resSrc);
  const buildR = spawnSync(process.execPath, [MING, 'cc', resFile, '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  const exeR = path.join(cdir, 'out', 'res43' + (process.platform === 'win32' ? '.exe' : ''));
  const rcR = spawnSync(exeR, [], { encoding: 'utf8', timeout: 60000 });
  const rjR = runMing(['run', resFile]);
  check('v43:Result 四方一致(Ok/Err/unwrap/unwrap_err/unwrap_or)', buildR.status === 0 && rcR.status === 0 && rcR.stdout === rjR.stdout && rjR.code === 0,
    'build=' + buildR.status + ' cc=' + JSON.stringify(rcR.stdout) + ' js=' + JSON.stringify(rjR.stdout));

  // M4006:对 Err(...) 调用 unwrap() —— 首行逐字对齐
  const pu = path.join(cdir, 'punwrap.ming');
  fs.writeFileSync(pu, 'fn main() with io { let r: Result[i64, str] = Err("bad"); print(str(r.unwrap())); }');
  const rju = runMing(['run', pu]);
  spawnSync(process.execPath, [MING, 'cc', pu, '--no-run', '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  const exeU = path.join(cdir, 'out', 'punwrap' + (process.platform === 'win32' ? '.exe' : ''));
  const rcu = fs.existsSync(exeU) ? spawnSync(exeU, [], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stderr: '' };
  const fl = (s) => (s ?? '').split('\n')[0];
  check('v43:M4006 Err unwrap 首行对齐', rju.code === 101 && rcu.status === 101 && fl(rju.stderr) === fl(rcu.stderr),
    'js=' + JSON.stringify(fl(rju.stderr)) + ' cc=' + JSON.stringify(fl(rcu.stderr)));

  // ffi str 桥:extern strlen + with ffi 的用户函数参与 C 编译(Windows;其他平台跳过)
  if (process.platform === 'win32') {
    const ffiSrc43 = [
      'extern "msvcrt" fn strlen(s: str) -> i64;',
      'fn slen(s: str) -> i64 with ffi {',
      '    return strlen(s);',
      '}',
      'fn main() with io, ffi {',
      '    print(str(slen("hello ming")));',
      '    print(str(slen("中文")));',
      '}',
    ].join('\n');
    const ff = path.join(cdir, 'ffi43.ming');
    fs.writeFileSync(ff, ffiSrc43);
    const rjf = runMing(['run', ff]);
    check('v43:ffi 程序 JS 引擎 M4001 拒绝', rjf.code === 101 && (rjf.stderr ?? '').includes('ffi 调用需要 C 后端'), 'code=' + rjf.code);
    const buildF = spawnSync(process.execPath, [MING, 'cc', ff, '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
    const exeF = path.join(cdir, 'out', 'ffi43.exe');
    const rcF = fs.existsSync(exeF) ? spawnSync(exeF, [], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stdout: '' };
    // strlen 按字节:"hello ming"=10,"中文"=6(UTF-8);with ffi 的用户函数 slen 参与 C 编译
    check('v43:ffi str 桥(strlen + with ffi 用户函数)', buildF.status === 0 && rcF.status === 0 && rcF.stdout === '10\n6\n',
      'build=' + buildF.status + ' out=' + JSON.stringify(rcF.stdout));
  } else {
    check('v43:ffi str 桥(非 Windows 跳过)', true);
  }

  // v0.43 修复:sync 程序自动回退源码模式(此前效果检测查错字段 → 误进 AOT → 运行期 worker ENOENT)
  const syncProj = path.join(cdir, 'syncproj');
  fs.mkdirSync(syncProj, { recursive: true });
  fs.writeFileSync(path.join(syncProj, 'app.ming'), ['fn fib(n: i64) -> i64 {', '    if n < 2 { return n; }', '    return fib(n - 1) + fib(n - 2);', '}', 'fn main() with io, sync {', '    let h = std.sync.spawn(fib, 10);', '    print(str(std.sync.join(h).unwrap()));', '}', ''].join('\n'));
  fs.writeFileSync(path.join(syncProj, 'ming.toml'), ['[project]', 'name = "syncfallback"', 'version = "0.1.0"', 'entry = "app.ming"', ''].join('\n'));
  const bs = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: syncProj, timeout: 60000 });
  const fellBack = bs.status === 0 && fs.existsSync(path.join(syncProj, 'dist', 'app.ming')) && !fs.existsSync(path.join(syncProj, 'dist', 'app.bytecode.json'));
  const rs2 = fellBack ? spawnSync(process.execPath, [path.join(syncProj, 'dist', 'ming-app.mjs')], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stdout: '' };
  check('v43:sync 程序回退源码模式', fellBack && rs2.status === 0 && rs2.stdout === '55\n', 'build=' + bs.status + ' out=' + JSON.stringify(rs2.stdout) + ' stderr=' + (bs.stderr ?? '').slice(0, 100));

  // 模糊器快档
  const fuzz43 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '40', '--seed', '40043'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v43:模糊器快档(40 程序多后端一致)', fuzz43.status === 0 && /分歧 0/.test(fuzz43.stdout ?? ''), 'code=' + fuzz43.status + ' tail=' + (fuzz43.stdout ?? '').slice(-150));
}

// ===================== 39. v0.44:AI 协作护栏(过拟合检查/修复处方/热力图)+ VM 修复 =====================
{
  const cdir = path.join(TMP, 'v44');
  fs.mkdirSync(cdir, { recursive: true });

  // 1) 测试字面量过拟合检查(W3104)
  const of1 = path.join(cdir, 'overfit.ming');
  fs.writeFileSync(of1, [
    'fn classify(n: i64) -> i64 {',
    '    if n == 42 { return 100; }',
    '    return n * 2;',
    '}',
    'test classify_bounds {',
    '    assert_eq(classify(42), 100);',
    '}',
  ].join('\n'));
  const ro1 = runMing(['check', of1]);
  check('v44:W3104 过拟合告警', ro1.code === 0 && (ro1.stderr ?? '').includes('W3104'), 'code=' + ro1.code + ' stderr=' + (ro1.stderr ?? '').slice(0, 120));
  const nf1 = path.join(cdir, 'nofit.ming');
  fs.writeFileSync(nf1, [
    'fn classify(n: i64) -> i64 {',
    '    if n == 42 { return 100; }',
    '    return n * 2;',
    '}',
    'test classify_bounds {',
    '    assert_eq(classify(5), 10);',
    '}',
  ].join('\n'));
  const rn1 = runMing(['check', nf1]);
  check('v44:W3104 负例不告警', rn1.code === 0 && !(rn1.stderr ?? '').includes('W3104'), 'stderr=' + (rn1.stderr ?? '').slice(0, 120));

  // 2) 结构化修复处方:--json 的 fix 应用后 → 复检无错误
  const applyFix = (src, fix) => {
    const lines = src.split('\n');
    const off = (p) => { let o = 0; for (let i = 0; i < p.line - 1; i++) o += lines[i].length + 1; return o + p.col - 1; };
    return src.slice(0, off(fix.start)) + fix.replacement + src.slice(off(fix.end));
  };
  const fixCases = [
    ['fix-semicolon', 'M2002', ['fn main() with io {', '    let x = 1', '    print(str(x));', '}', ''].join('\n')],
    ['fix-effect', 'M3029', ['fn f() {', '    print("hi");', '}', 'fn main() with io { f(); }', ''].join('\n')],
    ['fix-name', 'M3001', ['fn main() with io {', '    let total = 1;', '    print(str(totl));', '}', ''].join('\n')],
  ];
  for (const [key, code, src] of fixCases) {
    const f = path.join(cdir, key + '.ming');
    fs.writeFileSync(f, src);
    const rj = runMing(['check', f, '--json']);
    let diag = null;
    try { diag = (JSON.parse(rj.stdout).diagnostics ?? []).find(d => d.code === code && d.fix); } catch { /* 解析失败即 null */ }
    if (!diag) { check('v44:' + key + ' 修复处方', false, '未找到带 fix 的 ' + code + ' stdout=' + (rj.stdout ?? '').slice(0, 150)); continue; }
    const fixedSrc = applyFix(src, diag.fix);
    const f2 = path.join(cdir, key + '-fixed.ming');
    fs.writeFileSync(f2, fixedSrc);
    const r2 = runMing(['check', f2]);
    check('v44:' + key + ' 修复处方(应用后无错误)', r2.code === 0, 'code=' + r2.code + ' stderr=' + (r2.stderr ?? '').slice(0, 150));
  }

  // 3) diaghot 自举工具:聚合输出含预期码(样本分文件,避免 parse 错误中止类型检查)
  const dhFile = path.join(cdir, 'dhname.ming');
  fs.writeFileSync(dhFile, ['fn main() with io {', '    print(str(nope));', '}', ''].join('\n'));
  const rdh = spawnSync(process.execPath, [MING, 'run', path.join(ROOT, 'tools', 'diaghot.ming'), '--', dhFile, of1], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
  check('v44:diaghot 自举工具聚合', rdh.status === 0 && (rdh.stdout ?? '').includes('M3001') && (rdh.stdout ?? '').includes('W3104'), 'code=' + rdh.status + ' out=' + (rdh.stdout ?? '').slice(0, 200));

  // 4) VM 修复回归:match 内 return 后的操作数栈残留(method 调用 + 参数为带 match 的函数调用)
  const vmFile = path.join(cdir, 'matchret.ming');
  fs.writeFileSync(vmFile, [
    'fn pick(j: i64) -> str {',
    '    match j {',
    '        0 => { return "a"; }',
    '        _ => { return "b"; }',
    '    }',
    '}',
    'fn main() with io {',
    '    let mut m: Map[str, str] = [:];',
    '    m.set("k", pick(0));',
    '    print(str(m.len()));',
    '    print(m["k"]);',
    '}',
  ].join('\n'));
  const rvm = runMing(['run', vmFile]);
  const rtree = runMing(['run', vmFile, '--tree']);
  check('v44:VM match-return 栈残留修复', rvm.code === 0 && rvm.stdout === '1\na\n' && rvm.stdout === rtree.stdout,
    'vm=' + JSON.stringify(rvm.stdout) + ' tree=' + JSON.stringify(rtree.stdout) + ' stderr=' + (rvm.stderr ?? '').slice(0, 120));

  // 5) 模糊器快档
  const fuzz44 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '40', '--seed', '44044'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v44:模糊器快档(40 程序多后端一致)', fuzz44.status === 0 && /分歧 0/.test(fuzz44.stdout ?? ''), 'code=' + fuzz44.status + ' tail=' + (fuzz44.stdout ?? '').slice(-150));
}

// ===================== 40. 契约系统(v0.45 阶段 1)=====================
// (v0.56 #34:原写作 "§40";统一为 "40." 以消除编号断档。GUIDE/plan 的 §40 引用不变。)
{
  const okSrc = ['fn f(a: i64) -> i64 requires a > 0 ensures result == a + 1 {', '  return a + 1;', '}', 'fn main() with io { print(str(f(3))); }'].join('\n');
  const okFile = mingFile('contract_ok.ming', okSrc);
  const rok = runMing(['run', okFile]);
  const rokt = runMing(['run', okFile, '--tree']);
  check('v45:契约正例运行成功', rok.code === 0 && rok.stdout === '4\n' && rok.stdout === rokt.stdout,
    'vm=' + JSON.stringify(rok.stdout) + ' tree=' + JSON.stringify(rokt.stdout) + ' stderr=' + (rok.stderr ?? '').slice(0, 120));

  const reqSrc = ['fn f(a: i64) -> i64 requires a > 0 { return a + 1; }', 'fn main() with io { print(str(f(0))); }'].join('\n');
  const reqFile = mingFile('contract_req.ming', reqSrc);
  // v0.46:字面量实参违反 → 编译期 M3041(不再到运行时)
  const rreqLit = runMing(['run', reqFile]);
  check('v45:requires 字面量违反编译期 M3041', rreqLit.code === 1 && /M3041/.test(rreqLit.stderr), 'code=' + rreqLit.code + ' stderr=' + (rreqLit.stderr ?? '').slice(0, 120));
  // 运行时 M4015 路径:非线性表达式实参(静态不可判定;v0.55 线性实参已能在编译期证明,
  // 故此处用 `/` 形式保持"静态不可判定"的原意)
  const reqVarFile = mingFile('contract_reqvar.ming', ['fn f(a: i64) -> i64 requires a > 0 { return a + 1; }', 'fn main() with io { let a = 0; let b = a / 2; print(str(f(b))); }'].join('\n'));
  const rreq = runMing(['run', reqVarFile]);
  const rreqt = runMing(['run', reqVarFile, '--tree']);
  check('v45:requires 违反 M4015(VM)', rreq.code === 101 && /M4015/.test(rreq.stderr));
  check('v45:requires 违反 M4015(tree)', rreqt.code === 101 && /M4015/.test(rreqt.stderr));
  check('v45:requires 违反消息双引擎一致', rreq.stderr.split('\n')[0] === rreqt.stderr.split('\n')[0],
    'vm=' + JSON.stringify(rreq.stderr.split('\n')[0]) + ' tree=' + JSON.stringify(rreqt.stderr.split('\n')[0]));

  const ensSrc = ['fn f(a: i64) -> i64 ensures result > a else "结果必须大于输入" { return a; }', 'fn main() with io { print(str(f(3))); }'].join('\n');
  const ensFile = mingFile('contract_ens.ming', ensSrc);
  // v0.48:直线体 ensures 恒假 → 编译期 M3042(不再到运行时)
  const rens = runMing(['run', ensFile]);
  const renst = runMing(['run', ensFile, '--tree']);
  check('v45:ensures 恒假编译期 M3042', rens.code === 1 && /M3042/.test(rens.stderr) && (rens.stderr ?? '').includes('结果必须大于输入'));
  check('v45:ensures 静态证伪双引擎一致', rens.stderr.split('\n')[0] === renst.stderr.split('\n')[0],
    'vm=' + JSON.stringify(rens.stderr.split('\n')[0]) + ' tree=' + JSON.stringify(renst.stderr.split('\n')[0]));

  // invariant 违反
  const invSrc = ['struct S { x: i64, invariant x >= 0 }', 'fn main() with io { let s = S { x: -1 }; print(str(s.x)); }'].join('\n');
  const invFile = mingFile('contract_inv.ming', invSrc);
  const rinv = runMing(['run', invFile]);
  const rinvl = runMing(['run', invFile, '--tree']);
  check('v45:invariant 违反 M4015(VM)', rinv.code === 101 && /M4015/.test(rinv.stderr));
  check('v45:invariant 违反消息双引擎一致', rinv.stderr.split('\n')[0] === rinvl.stderr.split('\n')[0]);
}

// ===================== 41. v0.45.1:自举工具检视(11 个工具全部实测)=====================
{
  const dir = path.join(TMP, 'v45tools');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const runTool = (tool, args, env = {}) => spawnSync(process.execPath, [MING, 'run', path.join(ROOT, 'tools', tool), ...args], {
    encoding: 'utf8', cwd: ROOT, timeout: 60000,
    env: { ...process.env, ...env },
  });

  // ---- edit.ming(行级编辑器)----
  const ef = path.join(dir, 'f.txt');
  fs.writeFileSync(ef, 'alpha\nbeta\ngamma\n');
  let r = runTool('edit.ming', ['show', ef, '1', '3']);
  check('v45.1:edit show 带行号', r.status === 0 && r.stdout === '1|alpha\n2|beta\n3|gamma\n', JSON.stringify(r.stdout));
  r = runTool('edit.ming', ['count', ef]);
  check('v45.1:edit count', r.status === 0 && r.stdout === '3\n', JSON.stringify(r.stdout));
  r = runTool('edit.ming', ['set', ef, '2', 'BETA2']);
  check('v45.1:edit set', r.status === 0 && fs.readFileSync(ef, 'utf8') === 'alpha\nBETA2\ngamma\n', fs.readFileSync(ef, 'utf8'));
  r = runTool('edit.ming', ['ins', ef, '1', 'FIRST']);
  check('v45.1:edit ins 首行前', r.status === 0 && fs.readFileSync(ef, 'utf8') === 'FIRST\nalpha\nBETA2\ngamma\n', fs.readFileSync(ef, 'utf8'));
  r = runTool('edit.ming', ['del', ef, '2', '3']);
  check('v45.1:edit del 区间', r.status === 0 && fs.readFileSync(ef, 'utf8') === 'FIRST\ngamma\n', fs.readFileSync(ef, 'utf8'));
  r = runTool('edit.ming', ['sub', ef, '1', '1', 'X1\nX2']);
  check('v45.1:edit sub 多行替换', r.status === 0 && fs.readFileSync(ef, 'utf8') === 'X1\nX2\ngamma\n', fs.readFileSync(ef, 'utf8'));
  r = runTool('edit.ming', ['append', ef, 'TAIL']);
  check('v45.1:edit append(保尾换行)', r.status === 0 && fs.readFileSync(ef, 'utf8') === 'X1\nX2\ngamma\nTAIL\n', fs.readFileSync(ef, 'utf8'));
  r = runTool('edit.ming', ['set', ef, '99', 'x']);
  check('v45.1:edit set 越界拒绝', r.status === 1 && (r.stderr ?? '').includes('行号超出范围'), 'code=' + r.status);
  const ef2 = path.join(dir, 'nt.txt');
  fs.writeFileSync(ef2, 'a\nb');  // 无尾部换行
  r = runTool('edit.ming', ['set', ef2, '1', 'A']);
  r = runTool('edit.ming', ['append', ef2, 'c']);
  check('v45.1:edit 无尾换行保真', r.status === 0 && fs.readFileSync(ef2, 'utf8') === 'A\nb\nc', JSON.stringify(fs.readFileSync(ef2, 'utf8')));
  const ef3 = path.join(dir, 'empty.txt');
  fs.writeFileSync(ef3, '');
  r = runTool('edit.ming', ['count', ef3]);
  check('v45.1:edit 空文件 0 行', r.status === 0 && r.stdout === '0\n', JSON.stringify(r.stdout));
  r = runTool('edit.ming', ['set', ef3, '1', 'x']);
  check('v45.1:edit 空文件 set 拒绝', r.status === 1 && (r.stderr ?? '').includes('行号超出范围'), 'code=' + r.status);

  // ---- wc / json_query / log_analyzer ----
  fs.writeFileSync(path.join(dir, 'a.log'), 'line1\nline2 ERROR x\nline3 WARN y\nline4 INFO z\n');
  r = runTool('wc.ming', [path.join(dir, 'a.log')]);
  check('v45.1:wc 行/词/字节', r.status === 0 && r.stdout.trim() === '4 10 46 ' + path.join(dir, 'a.log'), JSON.stringify(r.stdout));
  fs.writeFileSync(path.join(dir, 'cfg.json'), '{"name": "ming", "v": 44}');
  r = runTool('json_query.ming', [path.join(dir, 'cfg.json'), 'name']);
  check('v45.1:json_query 取字段', r.status === 0 && r.stdout.includes('ming'), JSON.stringify(r.stdout));
  r = runTool('log_analyzer.ming', [path.join(dir, 'a.log')]);
  check('v45.1:log_analyzer 计数(尾部空行不计)', r.status === 0 && r.stdout.includes('总行数: 4') && r.stdout.includes('ERROR: 1'), JSON.stringify(r.stdout));

  // ---- find_files / tree / todo_scan ----
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'code.ming'), '// TODO: 实现缓存\nfn f() { return 1; }\n// FIXME: 边界\n');
  r = runTool('find_files.ming', [dir, 'txt']);
  check('v45.1:find_files 按名查找', r.status === 0 && (r.stdout ?? '').includes('notes.txt') && (r.stdout ?? '').includes('b.txt'), JSON.stringify(r.stdout).slice(0, 150));
  r = runTool('tree.ming', [dir]);
  check('v45.1:tree 目录树', r.status === 0 && (r.stdout ?? '').includes('├──') && (r.stdout ?? '').includes('sub'), JSON.stringify(r.stdout).slice(0, 150));
  r = runTool('todo_scan.ming', [dir]);
  check('v45.1:todo_scan 待办标记', r.status === 0 && (r.stdout ?? '').includes('TODO: 实现缓存') && (r.stdout ?? '').includes('共发现 2 处'), JSON.stringify(r.stdout).slice(0, 200));

  // ---- batch_rename / file_organizer(args 模式 + 缺参拒绝)----
  const rd = path.join(dir, 'rename');
  fs.mkdirSync(rd);
  fs.writeFileSync(path.join(rd, '1.txt'), 'a');
  fs.writeFileSync(path.join(rd, '2.log'), 'b');
  r = runTool('batch_rename.ming', [rd, 'pre_']);
  check('v45.1:batch_rename 加前缀', r.status === 0 && fs.existsSync(path.join(rd, 'pre_1.txt')) && fs.existsSync(path.join(rd, 'pre_2.log')), r.stdout ?? '');
  r = runTool('batch_rename.ming', []);
  check('v45.1:batch_rename 缺参拒绝(用法走 stderr)', r.status === 1 && (r.stderr ?? '').includes('用法'), 'code=' + r.status);
  const od = path.join(dir, 'org');
  fs.mkdirSync(od);
  fs.writeFileSync(path.join(od, 'x.txt'), 'a');
  fs.writeFileSync(path.join(od, 'y.md'), 'b');
  r = runTool('file_organizer.ming', [od]);
  check('v45.1:file_organizer 按扩展名归档', r.status === 0 && fs.existsSync(path.join(od, 'txt', 'x.txt')) && fs.existsSync(path.join(od, 'md', 'y.md')), r.stdout ?? '');
  r = runTool('file_organizer.ming', []);
  check('v45.1:file_organizer 缺参拒绝(用法走 stderr)', r.status === 1 && (r.stderr ?? '').includes('用法'), 'code=' + r.status);
}

// ===================== 42. v0.46:契约阶段 2 第一步(invariant 封装 + 调用点静态校验)=====================
{
  const dir = path.join(TMP, 'v46');
  fs.mkdirSync(dir, { recursive: true });

  // P0 回归:invariant struct + 缺 for 的 impl(解析恢复产物)——不得崩溃检查器
  const p0 = path.join(dir, 'p0.ming');
  fs.writeFileSync(p0, ['struct S { x: i64, invariant x >= 0 }', 'impl S {', '    fn break_it(mut self) {', '        self.x = -5;', '    }', '}', 'fn main() with io { }', ''].join('\n'));
  const rp0 = runMing(['check', p0]);
  check('v46:P0 恢复产物不崩溃检查器', rp0.code === 1 && (rp0.stderr ?? '').includes('M2002') && !(rp0.stderr ?? '').includes('TypeError'), 'code=' + rp0.code + ' stderr=' + (rp0.stderr ?? '').slice(0, 120));

  // M3040:带 invariant 的 struct 外部字段写被封装;impl 方法内写放行
  const encSrc = [
    'trait AccountOps {',
    '    fn withdraw(mut self, amount: i64) -> i64;',
    '}',
    'struct Account { balance: i64, invariant balance >= 0 }',
    'impl AccountOps for Account {',
    '    fn withdraw(mut self, amount: i64) -> i64 {',
    '        self.balance = self.balance - amount;',
    '        return self.balance;',
    '    }',
    '}',
    'fn main() with io {',
    '    let mut acct = Account { balance: 100 };',
    '    acct.balance = -50;',
    '    print(str(acct.withdraw(30)));',
    '}',
  ].join('\n');
  const encFile = path.join(dir, 'enc.ming');
  fs.writeFileSync(encFile, encSrc);
  const renc = runMing(['check', encFile]);
  check('v46:M3040 invariant 字段封装', renc.code === 1 && (renc.stderr ?? '').includes('M3040') && (renc.stderr ?? '').includes('只能在它的 impl 方法内修改'), 'stderr=' + (renc.stderr ?? '').slice(0, 140));

  // 同程序去掉外部写 → 编译干净(impl 内写放行 + 无误报)
  const encOkFile = path.join(dir, 'encok.ming');
  fs.writeFileSync(encOkFile, encSrc.replace('    acct.balance = -50;\n', ''));
  const rok2 = runMing(['check', encOkFile]);
  check('v46:M3040 impl 内写放行且无误报', rok2.code === 0, 'code=' + rok2.code + ' stderr=' + (rok2.stderr ?? '').slice(0, 140));

  // M3041:字面量实参违反 requires → 编译期反例(含 else 消息)
  const csSrc = [
    'fn pay(amount: i64) -> i64 requires amount > 0 else "金额必须为正" {',
    '    return amount * 2;',
    '}',
    'fn main() with io {',
    '    print(str(pay(-5)));',
    '    print(str(pay(3)));',
    '}',
  ].join('\n');
  const csFile = path.join(dir, 'callsite.ming');
  fs.writeFileSync(csFile, csSrc);
  const rcs = runMing(['check', csFile]);
  check('v46:M3041 调用点静态违反(反例 + else 消息)', rcs.code === 1 && (rcs.stderr ?? '').includes('M3041') && (rcs.stderr ?? '').includes('amount = -5') && (rcs.stderr ?? '').includes('金额必须为正'), 'stderr=' + (rcs.stderr ?? '').slice(0, 160));

  // M3041 非线性变量实参不误报(交给运行时 M4015;v0.55 起线性实参会在编译期证明)
  const csOkFile = path.join(dir, 'callsiteok.ming');
  fs.writeFileSync(csOkFile, csSrc.replace('print(str(pay(-5)));', 'let v = 0 - 10;\n    let w = v / 2;\n    print(str(pay(w)));'));
  const rcsOk = runMing(['check', csOkFile]);
  check('v46:M3041 非线性变量实参不误报', rcsOk.code === 0 && !(rcsOk.stderr ?? '').includes('M3041'), 'code=' + rcsOk.code + ' stderr=' + (rcsOk.stderr ?? '').slice(0, 120));

  // v0.47:mut 方法退出时的 invariant 重查(双引擎一致;非法变异拦截,合法变异放行)
  const invSrc = [
    'trait SOps {',
    '    fn break_it(mut self);',
    '    fn fix(mut self);',
    '}',
    'struct S { x: i64, invariant x >= 0 }',
    'impl SOps for S {',
    '    fn break_it(mut self) {',
    '        self.x = -5;',
    '    }',
    '    fn fix(mut self) {',
    '        self.x = 5;',
    '    }',
    '}',
    'fn main() with io {',
    '    let mut s = S { x: 1 };',
    '    print(str(s.x));',
    '    s.fix();',
    '    print(str(s.x));',
    '    s.break_it();',
    '    print(str(s.x));',
    '}',
  ].join('\n');
  const invFile = path.join(dir, 'inv47.ming');
  fs.writeFileSync(invFile, invSrc);
  const rinv = runMing(['run', invFile]);
  const rinvt = runMing(['run', invFile, '--tree']);
  check('v47:mut 方法退出重查 M4015(VM)', rinv.code === 101 && (rinv.stdout ?? '') === '1\n5\n' && /M4015/.test(rinv.stderr), 'code=' + rinv.code + ' stdout=' + JSON.stringify(rinv.stdout) + ' stderr=' + (rinv.stderr ?? '').slice(0, 100));
  check('v47:mut 方法退出重查 M4015(tree)', rinvt.code === 101 && rinvt.stdout === rinv.stdout && rinvt.stderr.split('\n')[0] === rinv.stderr.split('\n')[0], 'tree=' + JSON.stringify(rinvt.stdout) + ' stderr=' + (rinvt.stderr ?? '').slice(0, 100));
  const invOkFile = path.join(dir, 'inv47ok.ming');
  fs.writeFileSync(invOkFile, invSrc.replace('    s.break_it();\n    print(str(s.x));\n', ''));
  const rinvOk = runMing(['run', invOkFile]);
  check('v47:合法变异不误报', rinvOk.code === 0 && (rinvOk.stdout ?? '') === '1\n5\n', 'code=' + rinvOk.code + ' stdout=' + JSON.stringify(rinvOk.stdout));
}

// ===================== 43. v0.48:QF_LIA 第一片(ensures 直线体静态验证)=====================
{
  const dir = path.join(TMP, 'v48');
  fs.mkdirSync(dir, { recursive: true });
  const mk = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };

  // 可证真 → 无诊断
  const okF = mk('ok.ming', ['fn f(a: i64) -> i64 requires a > 0 ensures result == a + 1 {', '    return a + 1;', '}', 'fn main() with io { print(str(f(3))); }', ''].join('\n'));
  const rok = runMing(['check', okF]);
  check('v48:M3042 可证真不误报', rok.code === 0 && !(rok.stderr ?? '').includes('M3042'), 'stderr=' + (rok.stderr ?? '').slice(0, 140));

  // 等式可证假 → M3042 + requires 满足的反例
  const eqF = mk('eq.ming', ['fn f(a: i64) -> i64 requires a > 0 ensures result == a + 2 {', '    return a + 1;', '}', 'fn main() with io { print(str(f(3))); }', ''].join('\n'));
  const req = runMing(['check', eqF]);
  check('v48:M3042 等式可证假(反例 a=1)', req.code === 1 && (req.stderr ?? '').includes('M3042') && (req.stderr ?? '').includes('a = 1'), 'stderr=' + (req.stderr ?? '').slice(0, 160));

  // 不等式可证假 → 反例满足门控要求(a > 5 → a=10)
  const inqF = mk('inq.ming', ['fn g(a: i64) -> i64 requires a > 5 ensures result > a + 5 {', '    return a + 1;', '}', 'fn main() with io { print(str(g(10))); }', ''].join('\n'));
  const rinq = runMing(['check', inqF]);
  check('v48:M3042 不等式可证假(门控反例 a=10)', rinq.code === 1 && (rinq.stderr ?? '').includes('M3042') && (rinq.stderr ?? '').includes('a = 10'), 'stderr=' + (rinq.stderr ?? '').slice(0, 160));

  // 非直线体(循环)静默;调用表达式静默
  const loopF = mk('loop.ming', ['fn h(n: i64) -> i64 requires n >= 0 ensures result == n * 2 {', '    let mut acc = 0;', '    for i in 0..n { acc += 2; }', '    return acc;', '}', 'fn main() with io { print(str(h(3))); }', ''].join('\n'));
  const rloop = runMing(['check', loopF]);
  check('v48:M3042 非直线体静默(循环)', rloop.code === 0 && !(rloop.stderr ?? '').includes('M3042'), 'stderr=' + (rloop.stderr ?? '').slice(0, 140));
  const callF = mk('call.ming', ['fn twice(a: i64) -> i64 { return a * 2; }', 'fn h(a: i64) -> i64 requires a > 0 ensures result == a * 2 {', '    return twice(a);', '}', 'fn main() with io { print(str(h(3))); }', ''].join('\n'));
  const rcall = runMing(['check', callF]);
  check('v48:M3042 调用表达式静默', rcall.code === 0 && !(rcall.stderr ?? '').includes('M3042'), 'stderr=' + (rcall.stderr ?? '').slice(0, 140));
}

// ===================== 44. v0.49:ABI 哈希构建缓存(命中/接口哈希稳定性/--clean-cache)=====================
{
  const proj = path.join(TMP, 'v49proj');
  fs.mkdirSync(proj, { recursive: true });
  const appPath = path.join(proj, 'app.ming');
  const cacheFile = path.join(proj, '.ming-cache', 'build-cache.json');
  const build = () => spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: proj, timeout: 120000 });
  const runDist = () => spawnSync(process.execPath, [path.join(proj, 'dist', 'ming-app.mjs')], { encoding: 'utf8', timeout: 60000 });

  fs.writeFileSync(path.join(proj, 'ming.toml'), '[project]\nname = "v49"\nversion = "0.1.0"\nentry = "app.ming"\n');
  fs.writeFileSync(appPath, ['fn fib(n: i64) -> i64 {', '    if n < 2 { return n; }', '    return fib(n - 1) + fib(n - 2);', '}', 'fn main() with io {', '    print(str(fib(10)));', '}', ''].join('\n'));

  // build #1:全量,缓存写入
  const b1 = build();
  const cacheOk = b1.status === 0 && fs.existsSync(cacheFile);
  check('v49:构建写入缓存', cacheOk && fs.existsSync(path.join(proj, 'dist', 'ming-app.mjs')), 'code=' + b1.status + ' stderr=' + (b1.stderr ?? '').slice(0, 120));

  // build #2:键未变 → 缓存命中,dist 可运行
  const b2 = build();
  const r2 = runDist();
  check('v49:缓存命中(跳过 check+compile,dist 可运行)', b2.status === 0 && (b2.stdout ?? '').includes('缓存命中') && r2.status === 0 && r2.stdout === '55\n', 'code=' + b2.status + ' stdout=' + JSON.stringify(r2.stdout));

  // 改实现(输出文案变化)→ 不命中重建;接口哈希稳定(实现变化不影响接口哈希)
  const ifaceBefore = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).modules.find(m => m.file === 'app.ming').interfaceHash;
  fs.writeFileSync(appPath, ['fn fib(n: i64) -> i64 {', '    if n < 2 { return n; }', '    return fib(n - 1) + fib(n - 2);', '}', 'fn main() with io {', '    print(str(fib(12)));', '    print("v2");', '}', ''].join('\n'));
  const b3 = build();
  const ifaceAfter = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).modules.find(m => m.file === 'app.ming').interfaceHash;
  const r3 = runDist();
  check('v49:改实现 → 重建 + 接口哈希稳定', b3.status === 0 && !(b3.stdout ?? '').includes('缓存命中') && ifaceAfter === ifaceBefore && r3.stdout.includes('144') && r3.stdout.includes('v2'), 'code=' + b3.status + ' iface=' + ifaceBefore.slice(0, 8) + '→' + ifaceAfter.slice(0, 8) + ' out=' + JSON.stringify(r3.stdout));

  // 改签名(加参数)→ 接口哈希变更(ABI 防火墙可观测)
  fs.writeFileSync(appPath, ['fn fib(n: i64, acc: i64) -> i64 {', '    if n < 2 { return n; }', '    return fib(n - 1, acc) + fib(n - 2, acc);', '}', 'fn main() with io {', '    print(str(fib(12, 0)));', '    print("v3");', '}', ''].join('\n'));
  const b4 = build();
  const ifaceSig = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).modules.find(m => m.file === 'app.ming').interfaceHash;
  const r4 = runDist();
  check('v49:改签名 → 接口哈希变更', b4.status === 0 && ifaceSig !== ifaceAfter && (b4.stdout ?? '').includes('变更') && r4.stdout === '144\nv3\n', 'iface=' + ifaceSig.slice(0, 8) + ' out=' + JSON.stringify(r4.stdout));

  // --clean-cache → 清理旧缓存与 dist 并全量重建(同一命令内完成,产物可运行;缓存重写)
  const b5 = build();
  const bClean = spawnSync(process.execPath, [MING, 'build', '--clean-cache'], { encoding: 'utf8', cwd: proj, timeout: 120000 });
  const rClean = runDist();
  check('v49:--clean-cache 清理并全量重建', bClean.status === 0 && (bClean.stdout ?? '').includes('已清理') && fs.existsSync(path.join(proj, 'dist', 'ming-app.mjs')) && fs.existsSync(cacheFile) && rClean.status === 0 && rClean.stdout === '144\nv3\n', 'clean=' + bClean.status + ' stdout=' + (bClean.stdout ?? '').slice(0, 120) + ' out=' + JSON.stringify(rClean.stdout));
  // 重建后的缓存有效:下一次构建命中
  const b6 = build();
  check('v49:clean 后重建的缓存有效(下次命中)', b6.status === 0 && (b6.stdout ?? '').includes('缓存命中'), 'code=' + b6.status);
}

// ===================== 45. v0.49.1:GCM 长度边界修复(短明文往返 + nonce 唯一性 + <28B 拒绝)=====================
{
  const gb = mingFile('v491-gcm-boundary.ming', [
    'use std.crypto;',
    '',
    'fn main() with io, crypto {',
    '    let key = "0123456789abcdef0123456789abcdef";',
    '    match std.crypto.aes256_gcm_encrypt(key, "hi") {',
    '        Ok(d) => {',
    '            print("short_len=" + str(d.len()));',
    '            match std.crypto.aes256_gcm_decrypt(key, d) {',
    '                Ok(pt) => print("short_rt=" + pt),',
    '                Err(e) => print("SHORT-ERR: " + e),',
    '            }',
    '        },',
    '        Err(e) => print("ENC-ERR: " + e),',
    '    }',
    '    match std.crypto.aes256_gcm_encrypt(key, "") {',
    '        Ok(d) => {',
    '            print("empty_len=" + str(d.len()));',
    '            match std.crypto.aes256_gcm_decrypt(key, d) {',
    '                Ok(pt) => print("empty_rt_len=" + str(pt.byte_len())),',
    '                Err(e) => print("EMPTY-ERR: " + e),',
    '            }',
    '        },',
    '        Err(e) => print("ENC-ERR: " + e),',
    '    }',
    '    match std.crypto.aes256_gcm_encrypt(key, "same") {',
    '        Ok(a) => {',
    '            match std.crypto.aes256_gcm_encrypt(key, "same") {',
    '                Ok(b) => {',
    '                    let mut same = true;',
    '                    let mut i = 0;',
    '                    while i < 12 {',
    '                        if a[i] != b[i] { same = false; }',
    '                        i += 1;',
    '                    }',
    '                    if same { print("NONCE-COLLISION"); } else { print("nonce-ok"); }',
    '                },',
    '                Err(e) => print("ENC2-ERR: " + e),',
    '            }',
    '        },',
    '        Err(e) => print("ENC-ERR: " + e),',
    '    }',
    '    let mut b27: Vec[u8] = [];',
    '    let mut k = 0;',
    '    while k < 27 { b27.push(0 as u8); k += 1; }',
    '    match std.crypto.aes256_gcm_decrypt(key, b27) {',
    '        Ok(_) => print("27-ACCEPTED!"),',
    '        Err(e) => print("27-rejected"),',
    '    }',
    '    let mut b12: Vec[u8] = [];',
    '    let mut j = 0;',
    '    while j < 12 { b12.push(0 as u8); j += 1; }',
    '    match std.crypto.aes256_gcm_decrypt(key, b12) {',
    '        Ok(_) => print("12-ACCEPTED!"),',
    '        Err(e) => print("12-rejected"),',
    '    }',
    '}',
  ].join('\n'));
  const wantGb = ['short_len=30', 'short_rt=hi', 'empty_len=28', 'empty_rt_len=0', 'nonce-ok', '27-rejected', '12-rejected'].join('\n') + '\n';
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', gb, ...eng]);
    check('v49.1:GCM 最小帧 28B/短与空明文往返/nonce 唯一' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === wantGb,
      'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 200));
  }
}

// ===================== 46. v0.50:ming tools 统一入口 =====================
{
  const dir = path.join(TMP, 'tools50');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 't.txt');
  fs.writeFileSync(f, 'alpha\nbeta\ngamma\n');
  const t = (args) => spawnSync(process.execPath, [MING, 'tools', ...args], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });

  const rList = t(['--list']);
  check('v50:--list 列出命令', rList.status === 0 && (rList.stdout ?? '').includes('patch') && (rList.stdout ?? '').includes('diff'), 'code=' + rList.status);

  const rPatch = t(['patch', f, 'alpha', 'ALPHA']);
  const afterPatch = fs.readFileSync(f, 'utf8');
  check('v50:patch 精确替换(mingkit 路由)', rPatch.status === 0 && afterPatch === 'ALPHA\nbeta\ngamma\n', 'code=' + rPatch.status + ' content=' + JSON.stringify(afterPatch));

  const rAgain = t(['patch', f, 'alpha', 'X']);
  check('v50:patch 0 处匹配拒绝(退出码 1)', rAgain.status === 1 && fs.readFileSync(f, 'utf8') === afterPatch, 'code=' + rAgain.status);

  const rEdit = t(['edit', 'set', f, '2', 'BETA']);
  check('v50:edit 子命令路由(行级)', rEdit.status === 0 && fs.readFileSync(f, 'utf8').split('\n')[1] === 'BETA', 'code=' + rEdit.status);

  const rWc = t(['wc', f]);
  check('v50:wc 路由', rWc.status === 0 && (rWc.stdout ?? '').startsWith('3 '), 'stdout=' + JSON.stringify((rWc.stdout ?? '').slice(0, 40)));

  const rDiff = t(['diff', path.join(ROOT, 'examples', 'fib.ming')]);
  check('v50:diff 路由(engdiff 三引擎一致)', rDiff.status === 0 && (rDiff.stdout ?? '').includes('engdiff: 一致'), 'code=' + rDiff.status);

  const rBad = t(['nope']);
  check('v50:未知命令报错 exit 1', rBad.status === 1 && (rBad.stderr ?? '').includes('未知工具'), 'code=' + rBad.status);
}

// ===================== 47. v0.50.1:wasm 比较操作码修复(<=/>= 六符 × i64/f64)=====================
{
  const icmp = mingFile('v501-wasm-cmp-i64.ming', [
    'fn f1(a: i64, b: i64) -> i64 { if a == b { return 1; } return 0; }',
    'fn f2(a: i64, b: i64) -> i64 { if a != b { return 2; } return 0; }',
    'fn f3(a: i64, b: i64) -> i64 { if a < b { return 3; } return 0; }',
    'fn f4(a: i64, b: i64) -> i64 { if a > b { return 4; } return 0; }',
    'fn f5(a: i64, b: i64) -> i64 { if a <= b { return 5; } return 0; }',
    'fn f6(a: i64, b: i64) -> i64 { if a >= b { return 6; } return 0; }',
    'fn main() with io {',
    '    print(str(f1(3,3)) + str(f2(3,4)) + str(f3(3,4)) + str(f4(4,3)) + str(f5(3,4)) + str(f6(4,3)));',
    '    print(str(f5(5,3)) + str(f6(3,5)) + str(f5(9,2)) + str(f6(9,2)));',
    '}',
  ].join('\n'));
  const icmpWant = '123456\n0006\n';
  const iVm = runMing(['run', icmp]);
  const iTree = runMing(['run', icmp, '--tree']);
  check('v50.1:wasm i64 六种比较符正确(vm+wasm)', iVm.code === 0 && iVm.stdout === icmpWant, 'code=' + iVm.code + ' stdout=' + JSON.stringify(iVm.stdout));
  check('v50.1:i64 六种比较符树引擎一致', iTree.code === 0 && iTree.stdout === icmpWant, 'code=' + iTree.code + ' stdout=' + JSON.stringify(iTree.stdout));

  const fcmp = mingFile('v501-wasm-cmp-f64.ming', [
    'fn g1(a: f64, b: f64) -> i64 { if a == b { return 1; } return 0; }',
    'fn g2(a: f64, b: f64) -> i64 { if a != b { return 2; } return 0; }',
    'fn g3(a: f64, b: f64) -> i64 { if a < b { return 3; } return 0; }',
    'fn g4(a: f64, b: f64) -> i64 { if a > b { return 4; } return 0; }',
    'fn g5(a: f64, b: f64) -> i64 { if a <= b { return 5; } return 0; }',
    'fn g6(a: f64, b: f64) -> i64 { if a >= b { return 6; } return 0; }',
    'fn main() with io {',
    '    print(str(g1(3.0,3.0)) + str(g2(3.0,4.0)) + str(g3(3.0,4.0)) + str(g4(4.0,3.0)) + str(g5(3.0,4.0)) + str(g6(4.0,3.0)));',
    '    print(str(g5(5.0,5.0)) + str(g6(5.0,5.0)) + str(g5(6.0,5.0)) + str(g6(4.0,5.0)));',
    '}',
  ].join('\n'));
  const fcmpWant = '123456\n5600\n';
  const fVm = runMing(['run', fcmp]);
  const fTree = runMing(['run', fcmp, '--tree']);
  check('v50.1:wasm f64 六种比较符正确(vm+wasm)', fVm.code === 0 && fVm.stdout === fcmpWant, 'code=' + fVm.code + ' stdout=' + JSON.stringify(fVm.stdout));
  check('v50.1:f64 六种比较符树引擎一致', fTree.code === 0 && fTree.stdout === fcmpWant, 'code=' + fTree.code + ' stdout=' + JSON.stringify(fTree.stdout));

  // 存活断言:函数真的编译进 wasm,且模块实例化未失败(此前 f32 操作码会导致整体静默回落)
  const prevDbg2 = process.env.MING_WASM_DEBUG;
  process.env.MING_WASM_DEBUG = '1';
  const dbg = runMing(['run', fcmp]);
  if (prevDbg2 === undefined) delete process.env.MING_WASM_DEBUG; else process.env.MING_WASM_DEBUG = prevDbg2;
  const dbgErr = dbg.stderr ?? '';
  check('v50.1:wasm 模块真实实例化(非静默回落)', dbg.code === 0 && dbgErr.includes('[wasm] fn g6 OK') && !dbgErr.includes('实例化失败'), 'stderr=' + dbgErr.slice(0, 220));

  // --no-wasm 必须走 VM(非树引擎):用 --json 的 engine 字段直接观测
  const engineProbe = mingFile('v501-nowasm-engine.ming', 'fn main() with io { print("e"); }');
  const noWasmJson = runMing(['run', engineProbe, '--no-wasm', '--json']);
  const defaultJson = runMing(['run', engineProbe, '--json']);
  let noWasmEngine = null, defaultWasm = null;
  try { noWasmEngine = JSON.parse(noWasmJson.stdout ?? '{}').engine; } catch {}
  try { defaultWasm = JSON.parse(defaultJson.stdout ?? '{}').wasm; } catch {}
  check('v50.1:--no-wasm 走 VM 而非树引擎', noWasmJson.code === 0 && noWasmEngine === 'vm' && defaultWasm === true, 'engine=' + noWasmEngine + ' wasmDefault=' + defaultWasm);
}

// ===================== 48. v0.51:效果门禁函数值(类型携带 effects)=====================
{
  const bypass = mingFile('v51-eff-bypass.ming', [
    'fn noisy() -> () with io { print("副作用!"); }',
    'fn pure_one() -> () { let g = noisy; g(); }',
    'fn apply(f: () -> ()) -> () { f(); }',
    'fn pure_two() -> () { apply(noisy); }',
    'fn main() { pure_one(); pure_two(); }',
  ].join('\n'));
  const rB = runMing(['check', bypass]);
  check('v51:效果函数值调用被拒(M3029)', rB.code === 1 && (rB.stderr ?? '').includes('M3029') && (rB.stderr ?? '').includes('io'), 'code=' + rB.code + ' stderr=' + (rB.stderr ?? '').slice(0, 160));
  check('v51:带效果函数作为实参被拒(类型显示 with io)', rB.code === 1 && (rB.stderr ?? '').includes('M3002') && (rB.stderr ?? '').includes('with io'), 'stderr=' + (rB.stderr ?? '').slice(0, 200));

  const pos = mingFile('v51-eff-pos.ming', [
    'fn noisy() -> () with io { print("ok"); }',
    'fn wrapper() with io { let g = noisy; g(); g(); }',
    'fn main() with io { wrapper(); }',
  ].join('\n'));
  const rPos = runMing(['run', pos]);
  const rPosChk = runMing(['check', pos]);
  check('v51:声明效果后函数值可正常使用', rPosChk.code === 0 && rPos.code === 0 && rPos.stdout === 'ok\nok\n', 'check=' + rPosChk.code + ' run=' + rPos.code + ' stdout=' + JSON.stringify(rPos.stdout));

  const lam = mingFile('v51-eff-lambda.ming', [
    'fn main() with io {',
    '    let v = [1, 2];',
    '    let g = (x: i64) => { print(str(x)); x };',
    '    let w = v.map(g);',
    '    print(str(w.len()));',
    '}',
  ].join('\n'));
  const rLam = runMing(['check', lam]);
  check('v51:带效果 lambda 不能传给纯 HOF(map)', rLam.code === 1 && (rLam.stderr ?? '').includes('M3002') && (rLam.stderr ?? '').includes('with io'), 'code=' + rLam.code + ' stderr=' + (rLam.stderr ?? '').slice(0, 180));

  const pureLam = mingFile('v51-eff-pure-lambda.ming', [
    'fn main() with io {',
    '    let v = [1, 2];',
    '    let w = v.map((x: i64) => x * 2);',
    '    print(str(w.get(0).unwrap()));',
    '}',
  ].join('\n'));
  const rPure = runMing(['run', pureLam]);
  check('v51:纯 lambda 传 HOF 不受影响', rPure.code === 0 && rPure.stdout === '2\n', 'code=' + rPure.code + ' stdout=' + JSON.stringify(rPure.stdout));

  const nested = mingFile('v51-eff-nested-lambda.ming', [
    'fn noisy() -> () with io { print("x"); }',
    'fn pure() -> () { let g = () => { noisy(); }; }',
    'fn main() { pure(); }',
  ].join('\n'));
  const rNest = runMing(['check', nested]);
  check('v51:嵌套 lambda 内的效果仍被追溯(M3029)', rNest.code === 1 && (rNest.stderr ?? '').includes('M3029'), 'code=' + rNest.code);
}

// ===================== 49. v0.51.1:契约纯性(M3043)+ ensures 全返回路径 =====================
{
  const reqMut = mingFile('v511-contract-mut-requires.ming', [
    'fn f(mut v: Vec[i64]) -> i64 requires (v.pop() != None) { return v.len(); }',
    'fn main() with io { print(str(f([1, 2, 3]))); }',
  ].join('\n'));
  const rReq = runMing(['check', reqMut]);
  check('v51.1:requires 中 mut 方法被拒(M3043)', rReq.code === 1 && (rReq.stderr ?? '').includes('M3043') && (rReq.stderr ?? '').includes('.pop()'), 'code=' + rReq.code + ' stderr=' + (rReq.stderr ?? '').slice(0, 160));

  const ensMut = mingFile('v511-contract-mut-ensures.ming', [
    'fn f(mut v: Vec[i64]) -> i64 ensures v.pop() != None else "必须有元素" { return v.len(); }',
    'fn main() with io { print(str(f([1, 2, 3]))); }',
  ].join('\n'));
  const rEns = runMing(['check', ensMut]);
  check('v51.1:ensures 中 mut 方法被拒(M3043)', rEns.code === 1 && (rEns.stderr ?? '').includes('M3043'), 'code=' + rEns.code);

  const qopt = mingFile('v511-ensures-qopt.ming', [
    'fn f(o: Option[i64]) -> Option[i64] ensures result.is_some() else "必须有值" {',
    '    let x = o?;',
    '    return Some(x);',
    '}',
    'fn main() with io { match f(None) { Some(v) => print("Some"), None => print("None") } }',
  ].join('\n'));
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', qopt, ...eng]);
    check('v51.1:? 早退触发 ensures' + (eng.length ? '(tree)' : '(vm)'), r.code === 101 && (r.stderr ?? '').includes('M4015') && (r.stderr ?? '').includes('必须有值'), 'code=' + r.code);
  }

  const qres = mingFile('v511-ensures-qres.ming', [
    'fn g(r: Result[i64, str]) -> Result[i64, str] ensures result.is_ok() else "必须成功" {',
    '    let x = r?;',
    '    return Ok(x + 1);',
    '}',
    'fn main() with io { match g(Err("boom")) { Ok(v) => print("ok"), Err(e) => print("err " + e) } }',
  ].join('\n'));
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', qres, ...eng]);
    check('v51.1:Result ? 的 Err 路径触发 ensures' + (eng.length ? '(tree)' : '(vm)'), r.code === 101 && (r.stderr ?? '').includes('M4015'), 'code=' + r.code);
  }

  const nest = mingFile('v511-ensures-nested.ming', [
    'fn f(x: i64) -> i64 ensures result > x else "结果必须大于输入" {',
    '    if x >= 0 { return x; }',
    '    return 0 - x;',
    '}',
    'fn main() with io { print(str(f(2))); }',
  ].join('\n'));
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', nest, ...eng]);
    check('v51.1:嵌套 return 触发 ensures' + (eng.length ? '(tree)' : '(vm)'), r.code === 101 && (r.stderr ?? '').includes('M4015'), 'code=' + r.code);
  }

  const ok = mingFile('v511-ensures-ok.ming', [
    'fn f(o: Option[i64]) -> Option[i64] ensures result.is_some() else "必须有值" {',
    '    let x = o?;',
    '    return Some(x + 1);',
    '}',
    'fn main() with io { match f(Some(1)) { Some(v) => print("ok " + str(v)), None => print("None") } }',
  ].join('\n'));
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', ok, ...eng]);
    check('v51.1:? 成功路径行为不变' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === 'ok 2\n', 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout));
  }
}

// ===================== 50. v0.51.2:构建可信性(artifact/回退/缓存/哈希/守卫)=====================
{
  const proj = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };
  const writeProj = (d, files) => {
    fs.writeFileSync(path.join(d, 'ming.toml'), `[project]\nname = "${path.basename(d)}"\nversion = "0.1.0"\nentry = "app.ming"\n`);
    for (const [f, c] of Object.entries(files)) {
      const p = path.join(d, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c);
    }
  };
  const build = (d) => spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: d, timeout: 120000 });
  const runDist = (d) => spawnSync(process.execPath, [path.join(d, 'dist', 'ming-app.mjs')], { encoding: 'utf8', timeout: 60000 });

  // 1) struct 形参:AOT 产物可序列化,且不泄漏字段类型/源码路径
  const s1 = proj('v512-struct');
  writeProj(s1, { 'app.ming': 'struct P { x: i64 }\nfn add(p: P) -> i64 { return p.x + 1; }\nfn main() with io { print(str(add(P { x: 1 }))); }\n' });
  const b1 = build(s1);
  const artPath = path.join(s1, 'dist', 'app.bytecode.json');
  const art = fs.existsSync(artPath) ? fs.readFileSync(artPath, 'utf8') : '';
  check('v51.2:struct 形参走 AOT(不再 BigInt 回退)', b1.status === 0 && fs.existsSync(artPath) && (b1.stdout ?? '').includes('字节码'), 'code=' + b1.status + ' out=' + (b1.stdout ?? '').slice(-100));
  const bs = String.fromCharCode(92);
  check('v51.2:AOT 产物不泄漏字段类型/绝对路径', art.length > 0 && !art.includes('"TName"') && !art.includes('C:' + bs), 'leak=' + art.slice(0, 120));
  const r1 = runDist(s1);
  check('v51.2:struct AOT 产物可运行', r1.status === 0 && r1.stdout === '2\n', 'out=' + JSON.stringify(r1.stdout));

  // 2) 源码回退复制全部模块;二次构建命中且产物仍可运行
  const s2 = proj('v512-multi');
  writeProj(s2, {
    'util.ming': 'pub fn tw(x: i64) -> i64 { return x * 2; }\n',
    'app.ming': 'use util;\nfn main() with io, sync { print(str(util.tw(21))); }\n',
  });
  const b2 = build(s2);
  const b2b = build(s2);
  const r2 = runDist(s2);
  check('v51.2:源码回退复制全部模块', b2.status === 0 && fs.existsSync(path.join(s2, 'dist', 'util.ming')) && (b2.stderr ?? '').includes('AOT 不可用'), 'hasUtil=' + fs.existsSync(path.join(s2, 'dist', 'util.ming')));
  check('v51.2:多模块源码 dist 可运行(缓存命中后仍可)', r2.status === 0 && r2.stdout === '42\n' && (b2b.stdout ?? '').includes('缓存命中'), 'out=' + JSON.stringify(r2.stdout) + ' hit=' + (b2b.stdout ?? '').includes('缓存命中'));

  // 3) 缓存命中必须校验 dist 内容
  const s3 = proj('v512-cache');
  writeProj(s3, { 'app.ming': 'fn main() with io { print("ok"); }\n' });
  build(s3);
  const hit1 = build(s3);
  fs.rmSync(path.join(s3, 'dist', 'runtime'), { recursive: true, force: true });
  const miss1 = build(s3);
  const r3a = runDist(s3);
  fs.writeFileSync(path.join(s3, 'dist', 'app.bytecode.json'), 'garbage');
  const miss2 = build(s3);
  const r3b = runDist(s3);
  check('v51.2:缓存命中仍有效(内容未变)', (hit1.stdout ?? '').includes('缓存命中'), 'out=' + (hit1.stdout ?? '').slice(0, 60));
  check('v51.2:dist 被删改 → 不再命中并重建', !(miss1.stdout ?? '').includes('缓存命中') && !(miss2.stdout ?? '').includes('缓存命中') && r3a.status === 0 && r3b.status === 0 && r3b.stdout === 'ok\n', 'miss1=' + (miss1.stdout ?? '').includes('缓存命中') + ' miss2=' + (miss2.stdout ?? '').includes('缓存命中') + ' out=' + JSON.stringify(r3b.stdout));

  // 4) 接口哈希:枚举 payload 类型变化必须改变哈希
  const s4 = proj('v512-enum');
  writeProj(s4, { 'app.ming': 'enum E { A(i64) }\nfn main() with io { print("x"); }\n' });
  build(s4);
  const hash1 = JSON.parse(fs.readFileSync(path.join(s4, '.ming-cache', 'build-cache.json'), 'utf8')).modules.find(m => m.file === 'app.ming').interfaceHash;
  fs.writeFileSync(path.join(s4, 'app.ming'), 'enum E { A(str) }\nfn main() with io { print("x"); }\n');
  const b4 = build(s4);
  const hash2 = JSON.parse(fs.readFileSync(path.join(s4, '.ming-cache', 'build-cache.json'), 'utf8')).modules.find(m => m.file === 'app.ming').interfaceHash;
  check('v51.2:枚举 payload 类型变化 → 接口哈希变化', hash1 !== hash2 && (b4.stdout ?? '').includes('变更'), 'h1=' + hash1 + ' h2=' + hash2);

  // 5) 拒绝覆盖非产物 dist(保护用户源码目录)
  const s5 = proj('v512-guard');
  writeProj(s5, { 'app.ming': 'fn main() with io { print("g"); }\n' });
  fs.mkdirSync(path.join(s5, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(s5, 'dist', 'util.ming'), '// 用户源码\n');
  const b5 = build(s5);
  check('v51.2:非产物 dist 拒绝覆盖且保留文件', b5.status === 1 && (b5.stderr ?? '').includes('拒绝覆盖') && fs.existsSync(path.join(s5, 'dist', 'util.ming')), 'code=' + b5.status + ' stderr=' + (b5.stderr ?? '').slice(0, 100));
}

// ===================== 51. v0.51.4:C 后端 UB 与语义对齐(f64/截断/str) =====================
{
  const detectCC = () => {
    const candidates = [];
    if (process.env.MING_CC) candidates.push(process.env.MING_CC);
    candidates.push('gcc', 'clang', 'cc');
    for (const p of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
      if (fs.existsSync(p)) candidates.push(p);
    }
    for (const c of candidates) {
      try { const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15000 }); if (r.status === 0) return c; } catch { /* 试下一个 */ }
    }
    return null;
  };
  const hasCC = !!detectCC();
  const ccRun = (file, out) => spawnSync(process.execPath, [MING, 'cc', file, '--out', out], { encoding: 'utf8', timeout: 180000 });

  // 1) f64 大整数打印:不再经 long long,结果与 JS 逐字一致
  const f64 = mingFile('v514-f64.ming', [
    'fn main() with io {',
    '    print(str(1.0e18));',
    '    print(str(1.0e19));',
    '    print(str(9.0e20));',
    '    print(str(2.5));',
    '    print(str(0.0));',
    '    print(str(1.0e21));',
    '}',
  ].join('\n'));
  const wantF = '1000000000000000000.0\n10000000000000000000.0\n900000000000000000000.0\n2.5\n0.0\n1e+21\n';
  const fJs = runMing(['run', f64]);
  check('v51.3:f64 大整数 JS 输出', fJs.code === 0 && fJs.stdout === wantF, 'out=' + JSON.stringify(fJs.stdout));
  if (hasCC) {
    const fC = ccRun(f64, path.join(TMP, 'v514-c1'));
    check('v51.3:C f64 大整数打印与 JS 一致', fC.status === 0 && fC.stdout === wantF, 'out=' + JSON.stringify((fC.stdout ?? '').slice(0, 120)));
  } else {
    check('v51.3:C f64 大整数打印(无编译器,跳过)', true);
  }

  // 2) str:空模式 replace(码点插入)/ pad 码点宽度 / ZWSP 不属空白
  const zw = String.fromCharCode(0x200B);
  const strSrc = [
    'fn main() with io {',
    '    print("ab".replace("", "-"));',
    '    print("中文".replace("", "-"));',
    '    print("😀a".replace("", "-"));',
    '    print("中".pad_left(3));',
    '    print(str("中".pad_left(3).char_len()));',
    '    print(str("中".pad_left(3).byte_len()));',
    '    print(str("中".pad_right(3).byte_len()));',
    '    let z = "' + zw + 'a";',
    '    print(str(z.trim_start().byte_len()));',
    '}',
  ].join('\n');
  const strFile = mingFile('v514-str.ming', strSrc);
  const wantS = 'a-b\n中-文\n😀-a\n  中\n3\n5\n5\n4\n';
  const sVm = runMing(['run', strFile]);
  const sTree = runMing(['run', strFile, '--tree']);
  check('v51.3:str 空模式/pad/ZWSP 双引擎一致', sVm.code === 0 && sVm.stdout === wantS && sTree.stdout === wantS, 'vm=' + JSON.stringify(sVm.stdout) + ' tree=' + JSON.stringify(sTree.stdout));
  if (hasCC) {
    const sC = ccRun(strFile, path.join(TMP, 'v514-c2'));
    check('v51.3:C str 三处语义与 JS 一致', sC.status === 0 && sC.stdout === wantS, 'out=' + JSON.stringify((sC.stdout ?? '').slice(0, 120)));
  } else {
    check('v51.3:C str 三处语义(无编译器,跳过)', true);
  }

  // 3) 有符号窄截断:负数/越界值符号扩展与 JS 一致;发射 C 用 ming_sext
  const narrow = mingFile('v514-narrow.ming', [
    'fn f(x: i64) -> i64 { let y = x as i32; return y as i64; }',
    'fn main() with io { print(str(f(-5))); print(str(f(2147483647))); print(str(f(2147483648))); }',
  ].join('\n'));
  const wantN = '-5\n2147483647\n-2147483648\n';
  const nJs = runMing(['run', narrow]);
  check('v51.3:窄截断 JS 符号扩展基线', nJs.code === 0 && nJs.stdout === wantN, 'out=' + JSON.stringify(nJs.stdout));
  if (hasCC) {
    const outDir = path.join(TMP, 'v514-c3');
    const nC = ccRun(narrow, outDir);
    const emitDir = path.join(TMP, 'v514-c3e');
    spawnSync(process.execPath, [MING, 'cc', narrow, '--emit-c', '--out', emitDir], { encoding: 'utf8', timeout: 60000 });
    const cSrc = fs.readdirSync(emitDir).filter(x => x.endsWith('.c')).map(x => fs.readFileSync(path.join(emitDir, x), 'utf8')).join('\n');
    check('v51.3:C 窄截断与 JS 一致且用 ming_sext', nC.status === 0 && nC.stdout === wantN && cSrc.includes('ming_sext('), 'out=' + JSON.stringify((nC.stdout ?? '').slice(0, 80)) + ' sext=' + cSrc.includes('ming_sext('));
  } else {
    check('v51.3:C 窄截断(无编译器,跳过)', true);
  }
}

// ===================== 52. v0.51.4:检查器小缺陷(访问器/while let/元组/map 键/span) =====================
{
  // 1) 访问器返回副本:通过 get/unwrap 修改临时值不得影响原容器
  const acc = mingFile('v514-accessor.ming', [
    'fn main() with io {',
    '    let v = [[1], [2]];',
    '    v.get(0).unwrap().push(9);',
    '    print(debug(v));',
    '    let mut a = v.get(0).unwrap();',
    '    a.push(7);',
    '    print(debug(v));',
    '    print(debug(a));',
    '    let m = {"k": [1]};',
    '    let mut b = m.get("k").unwrap();',
    '    b.push(5);',
    '    print(debug(m));',
    '    print(debug(b));',
    '}',
  ].join('\n'));
  const accWant = '[[1], [2]]\n[[1], [2]]\n[1, 7]\n{"k": [1]}\n[1, 5]\n';
  const accVm = runMing(['run', acc]);
  const accTree = runMing(['run', acc, '--tree']);
  check('v51.4:容器访问器返回值语义副本(双引擎)', accVm.code === 0 && accVm.stdout === accWant && accTree.stdout === accWant, 'vm=' + JSON.stringify(accVm.stdout) + ' tree=' + JSON.stringify(accTree.stdout));

  // 2) while let 可用(GUIDE 示例)
  const wl = mingFile('v514-whilelet.ming', [
    'fn main() with io {',
    '    let mut v = [1, 2];',
    '    while let Some(x) = v.pop() { print(str(x)); }',
    '}',
  ].join('\n'));
  const wlVm = runMing(['run', wl]);
  const wlTree = runMing(['run', wl, '--tree']);
  check('v51.4:while let 枚举解构可运行(双引擎)', wlVm.code === 0 && wlVm.stdout === '2\n1\n' && wlTree.stdout === '2\n1\n', 'vm=' + JSON.stringify(wlVm.stdout));

  // 3) 元组内嵌套可反驳模式不再被当作穷尽
  const mt = mingFile('v514-match-tuple.ming', [
    'enum E { A, B }',
    'fn f(t: (E, i64)) -> i64 { match t { (E.A, _) => 1 } }',
    'fn main() with io { print(str(f((E.B, 0)))); }',
  ].join('\n'));
  const mtChk = runMing(['check', mt]);
  check('v51.4:元组内枚举模式未穷尽 → M3007', mtChk.code === 1 && (mtChk.stderr ?? '').includes('M3007'), 'code=' + mtChk.code);
  const mtOk = mingFile('v514-match-tuple-ok.ming', [
    'enum E { A, B }',
    'fn f(t: (E, i64)) -> i64 { match t { (E.A, _) => 1, (E.B, _) => 2, _ => 3 } }',
    'fn main() with io { print(str(f((E.B, 0)))); }',
  ].join('\n'));
  const mtRun = runMing(['run', mtOk]);
  check('v51.4:元组 match 加兜底后可运行', mtRun.code === 0 && mtRun.stdout === '2\n', 'out=' + JSON.stringify(mtRun.stdout));

  // 4) 泛型 bound 方法 arity 错误 → M3005(不是 ReferenceError)
  const gen = mingFile('v514-generic.ming', [
    'struct S { v: i64 }',
    'trait T { fn m(self, x: i64) -> i64; }',
    'impl T for S { fn m(self, x: i64) -> i64 { return self.v + x; } }',
    'fn g[A: T](a: A) -> i64 { return a.m(); }',
    'fn main() with io { print(str(g(S { v: 1 }))); }',
  ].join('\n'));
  const genChk = runMing(['check', gen]);
  check('v51.4:泛型 bound arity → M3005 而非 ReferenceError', genChk.code === 1 && (genChk.stderr ?? '').includes('M3005') && !(genChk.stderr ?? '').includes('ReferenceError'), 'stderr=' + (genChk.stderr ?? '').slice(0, 150));

  // 5) Map 键类型限制(M3044),原始键不受影响
  const mk1 = mingFile('v514-mapkey-ann.ming', 'fn main() with io { let mut m: Map[Vec[i64], i64] = [:]; print(str(m.len())); }');
  const mk2 = mingFile('v514-mapkey-lit.ming', 'fn main() with io { let m = { [1, 2]: 3 }; print(str(m.len())); }');
  const mk1c = runMing(['check', mk1]);
  const mk2c = runMing(['check', mk2]);
  check('v51.4:Map 非原始键标注 → M3044', mk1c.code === 1 && (mk1c.stderr ?? '').includes('M3044'), 'code=' + mk1c.code);
  check('v51.4:Map 非原始键字面量 → M3044', mk2c.code === 1 && (mk2c.stderr ?? '').includes('M3044'), 'code=' + mk2c.code);
  const mkOk = mingFile('v514-mapkey-ok.ming', 'fn main() with io { let m = {"a": 1, "b": 2}; print(str(m.len())); }');
  const mkOkRun = runMing(['run', mkOk]);
  check('v51.4:str 键 Map 正常', mkOkRun.code === 0 && mkOkRun.stdout === '2\n', 'out=' + JSON.stringify(mkOkRun.stdout));
}

// ===================== 53. v0.52:CLI 边界(项目参数/ -o / 值旗标) =====================
{
  const dir = path.join(TMP, 'v52cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ming.toml'), '[project]\nname = "cli"\nversion = "0.1.0"\nentry = "app.ming"\n');
  const app = path.join(dir, 'app.ming');
  fs.writeFileSync(app, [
    'fn main(args: Vec[str]) -> i64 with io {',
    '    print(str(args.len()));',
    '    for a in args { print(a); }',
    '    return 0;',
    '}',
  ].join('\n'));
  const run = (args) => spawnSync(process.execPath, [MING, 'run', ...args], { encoding: 'utf8', cwd: dir, timeout: 60000 });

  const pArgs = run(['--', 'a', 'b']);
  check('v52:项目模式 -- 之后的参数传给程序', pArgs.status === 0 && pArgs.stdout === '2\na\nb\n', 'out=' + JSON.stringify(pArgs.stdout) + ' err=' + (pArgs.stderr ?? '').slice(0, 100));
  const fArgs = run(['app.ming', '--', 'x', 'y']);
  check('v52:显式文件 -- 之后的参数传给程序', fArgs.status === 0 && fArgs.stdout === '2\nx\ny\n', 'out=' + JSON.stringify(fArgs.stdout));
  const legacy = run(['app.ming', 'z']);
  check('v52:位置参数兼容(无 --)', legacy.status === 0 && legacy.stdout === '1\nz\n', 'out=' + JSON.stringify(legacy.stdout));

  // 值旗标缺值/非法值:报错而不是吞掉下一个旗标
  const miss = spawnSync(process.execPath, [MING, 'run', app, '--max-steps', '--json'], { encoding: 'utf8', cwd: dir, timeout: 60000 });
  check('v52:--max-steps 缺值报错(不吞 --json)', miss.status === 1 && (miss.stderr ?? '').includes('需要一个值') && !(miss.stdout ?? '').includes('args'), 'code=' + miss.status + ' err=' + (miss.stderr ?? '').slice(0, 80));
  const bad = spawnSync(process.execPath, [MING, 'run', app, '--max-steps', 'abc'], { encoding: 'utf8', cwd: dir, timeout: 60000 });
  check('v52:--max-steps 非整数报错', bad.status === 1 && (bad.stderr ?? '').includes('非负整数'), 'code=' + bad.status);
  const badEq = spawnSync(process.execPath, [MING, 'run', app, '--max-steps=abc'], { encoding: 'utf8', cwd: dir, timeout: 60000 });
  check('v52:--max-steps=abc 报错', badEq.status === 1 && (badEq.stderr ?? '').includes('非负整数'), 'code=' + badEq.status);

  // -o 短旗标:产物进入指定目录,不建默认 ming-cc-out
  const occ = path.join(dir, 'occ');
  fs.mkdirSync(occ, { recursive: true });
  fs.writeFileSync(path.join(occ, 'demo.ming'), 'fn main() with io { print("x"); }\n');
  const emit = spawnSync(process.execPath, [MING, 'cc', 'demo.ming', '--emit-c', '-o', 'outdir'], { encoding: 'utf8', cwd: occ, timeout: 60000 });
  check('v52:-o 短旗标被采纳', emit.status === 0 && fs.existsSync(path.join(occ, 'outdir', 'demo.c')) && !fs.existsSync(path.join(occ, 'ming-cc-out')), 'code=' + emit.status + ' out=' + (emit.stdout ?? '').slice(0, 100));
}

// ===================== 54. v0.51.6:VM 复合赋值窥孔修复(x += N / -= N,N≠1 被误融 ±1)=====================
// 自举工具 diaghot 的 `i += 2` 在 VM 下静默算错暴露:窥孔融合只判 IntLit 不判值,
// x += 2 被编成 ADDI +1(树引擎正确 → 双引擎分歧)。修复后三引擎一致。
{
  const caFile = mingFile('v516-compound-addi.ming', [
    'fn main() -> i64 with io {',
    '    let mut i = 0;',
    '    i += 2;',
    '    i += 2;',
    '    print(str(i));',
    '    let mut j = 10;',
    '    j -= 3;',
    '    print(str(j));',
    '    let mut k = 5;',
    '    while k > 0 { k -= 2; }',
    '    print(str(k));',
    '    let mut m = 0;',
    '    m += 1;',
    '    print(str(m));',
    '    return 0;',
    '}',
  ].join('\n'));
  // 期望:4 / 7 / 1(5-2-2)/ 1;误融版本会输出 2 / 9 / 0 / 1
  const caWant = '4\n7\n-1\n1\n';
  const caVm = runMing(['run', caFile]);
  const caTree = runMing(['run', caFile, '--tree']);
  const caOnly = runMing(['run', caFile, '--no-wasm']);
  check('v51.6:x += N(N≠1)VM 正确(不再融成 +1)', caVm.code === 0 && caVm.stdout === caWant, 'code=' + caVm.code + ' stdout=' + JSON.stringify(caVm.stdout));
  check('v51.6:复合赋值树引擎一致', caTree.code === 0 && caTree.stdout === caWant, 'stdout=' + JSON.stringify(caTree.stdout));
  check('v51.6:复合赋值 vm-only 一致', caOnly.code === 0 && caOnly.stdout === caWant, 'stdout=' + JSON.stringify(caOnly.stdout));
  check('v51.6:x += 1 窥孔融合保持有效', caVm.stdout.endsWith('1\n'), 'tail=' + JSON.stringify(caVm.stdout.slice(-2)));
}

// ===================== 55. v0.51.6:自举工具优化(错误纪律/多文件/点路径/目录展开/--top/幂等/深度)=====================
{
  const dir = path.join(TMP, 'tools516');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const runTool = (tool, args) => spawnSync(process.execPath, [MING, 'run', path.join(ROOT, 'tools', tool), ...args], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
  const tools = (args) => spawnSync(process.execPath, [MING, 'tools', ...args], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });

  // ---- fmt:v0.51.6 两处修复(if 表达式崩溃 / else-if 悬挂)+ 工具规范格式 ----
  const probeSrc = [
    'fn pick(a: i64) -> i64 {',
    '    if a > 10 { return 1; }',
    '    else if a > 5 { return 2; }',
    '    else { return 3; }',
    '}',
    'fn main() with io {',
    '    let x = if 1 > 0 { 7 } else { 8 };',
    '    print(str(x));',
    '}',
  ].join('\n');
  const probeFile = path.join(dir, 'fmtprobe.ming');
  fs.writeFileSync(probeFile, probeSrc);
  const rf1 = runMing(['fmt', probeFile]);
  const fmt1 = rf1.stdout ?? '';
  check('v51.6:fmt if 表达式不崩溃且 else-if 内联', rf1.code === 0 && fmt1.includes('} else if a > 5 {') && fmt1.includes('let x = if 1 > 0 { 7 } else { 8 };'), 'code=' + rf1.status + ' out=' + JSON.stringify(fmt1));
  fs.writeFileSync(probeFile, fmt1);
  const rf2 = runMing(['fmt', probeFile, '--check']);
  check('v51.6:fmt else-if 输出幂等', rf2.code === 0 && (rf2.stdout ?? '').includes('已是规范格式'), 'code=' + rf2.status + ' out=' + JSON.stringify(rf2.stdout));
  const probeRun = runMing(['run', probeFile]);
  check('v51.6:fmt 后行为不变', probeRun.code === 0 && probeRun.stdout === '7\n', JSON.stringify(probeRun.stdout));
  const nonCanon = [];
  for (const tf of fs.readdirSync(path.join(ROOT, 'tools'))) {
    if (!tf.endsWith('.ming')) continue;
    const c = runMing(['fmt', path.join(ROOT, 'tools', tf), '--check']);
    if (c.code !== 0) nonCanon.push(tf);
  }
  check('v51.6:全部自举工具 fmt 规范', nonCanon.length === 0, '非规范: ' + nonCanon.join(','));

  // ---- wc:多文件 + total + 错误纪律 ----
  const wa = path.join(dir, 'a.txt');
  fs.writeFileSync(wa, 'one two\nthree\n');
  const wb = path.join(dir, 'b.txt');
  fs.writeFileSync(wb, 'x y z w\n');
  let r = runTool('wc.ming', [wa]);
  check('v51.6:wc 单文件格式不变', r.status === 0 && r.stdout.trim() === '2 3 14 ' + wa, JSON.stringify(r.stdout));
  r = runTool('wc.ming', [wa, wb]);
  check('v51.6:wc 多文件附 total', r.status === 0 && r.stdout === '2 3 14 ' + wa + '\n1 4 8 ' + wb + '\n3 7 22 total\n', JSON.stringify(r.stdout));
  r = runTool('wc.ming', [wa, path.join(dir, 'nope.txt'), wb]);
  check('v51.6:wc 失败走 stderr 退出 1 且不中断其余', r.status === 1 && (r.stderr ?? '').includes('nope.txt') && !(r.stdout ?? '').includes('wc:') && (r.stdout ?? '').includes(wa) && (r.stdout ?? '').endsWith('total\n'), 'code=' + r.status + ' out=' + JSON.stringify(r.stdout) + ' err=' + (r.stderr ?? '').slice(0, 80));

  // ---- json_query:点路径 + 类型化输出 + 退出码 ----
  const jf = path.join(dir, 'cfg.json');
  fs.writeFileSync(jf, '{"name":"ming","v":44,"ok":true,"n":null,"servers":[{"host":"h1"},{"host":"h2"}],"deps":{"a":1}}');
  r = runTool('json_query.ming', [jf, 'name']);
  check('v51.6:json 字符串叶子裸输出', r.status === 0 && r.stdout === 'ming\n', JSON.stringify(r.stdout));
  r = runTool('json_query.ming', [jf, 'servers.1.host']);
  check('v51.6:json 点路径数组下标', r.status === 0 && r.stdout === 'h2\n', JSON.stringify(r.stdout));
  r = runTool('json_query.ming', [jf, 'v', 'ok', 'n', 'deps']);
  check('v51.6:json 多路径类型化输出', r.status === 0 && r.stdout === '44\ntrue\nnull\n{"a":1}\n', JSON.stringify(r.stdout));
  r = runTool('json_query.ming', [jf, 'servers.9.host']);
  check('v51.6:json 越界退出 1(stderr)', r.status === 1 && (r.stderr ?? '').includes('越界') && (r.stdout ?? '') === '', JSON.stringify(r.stdout));
  r = runTool('json_query.ming', [jf, 'name.x']);
  check('v51.6:json 穿过标量拒绝', r.status === 1 && (r.stderr ?? '').includes('标量'), 'code=' + r.status);
  r = runTool('json_query.ming', [jf, 'nope']);
  check('v51.6:json 键不存在退出 1', r.status === 1 && (r.stderr ?? '').includes('键不存在'), 'code=' + r.status);
  const badJf = path.join(dir, 'bad.json');
  fs.writeFileSync(badJf, '{"a": ');
  r = runTool('json_query.ming', [badJf, 'a']);
  check('v51.6:json 解析失败退出 1', r.status === 1 && (r.stderr ?? '').includes('解析失败'), 'code=' + r.status);

  // ---- diaghot:目录递归展开 + --top + `--` 透传 ----
  const ddir = path.join(dir, 'proj');
  fs.mkdirSync(path.join(ddir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(ddir, 'bad1.ming'), 'fn main() with io { let x: i64 = "s"; print("x"); }\n');
  fs.writeFileSync(path.join(ddir, 'bad2.ming'), 'fn main() with io { let unused1 = 1; print("x"); }\n');
  fs.writeFileSync(path.join(ddir, 'note.md'), 'fn fake() {}\n');
  fs.writeFileSync(path.join(ddir, 'nested', 'bad3.ming'), 'fn main() with io { let unused2 = 2; let unused3 = 3; print("y"); }\n');
  r = tools(['diag', ddir]);
  check('v51.6:diag 目录递归收 .ming(排除非 .ming)', r.status === 0 && (r.stdout ?? '').includes('3 个文件') && (r.stdout ?? '').includes('1. W3101') && (r.stdout ?? '').includes('2. M3002'), JSON.stringify(r.stdout));
  r = tools(['diag', ddir, '--', '--top', '1']);
  check('v51.6:diag --top 限量且 `--` 透传生效', r.status === 0 && (r.stdout ?? '').includes('1. W3101') && !(r.stdout ?? '').includes('M3002'), JSON.stringify(r.stdout));
  r = tools(['diag', ddir, '--', '--top=1']);
  check('v51.6:diag --top=N 等号形式', r.status === 0 && (r.stdout ?? '').includes('1. W3101') && !(r.stdout ?? '').includes('M3002'), JSON.stringify(r.stdout));
  r = tools(['diag', ddir, '--', '--top', '0']);
  check('v51.6:diag --top 0 拒绝', r.status === 1 && (r.stderr ?? '').includes('正整数'), 'code=' + r.status + ' err=' + (r.stderr ?? '').slice(0, 80));
  r = runTool('diaghot.ming', [wa]);
  check('v51.6:diag 非 .ming 参数拒绝', r.status === 1 && (r.stderr ?? '').includes('不是 .ming'), 'code=' + r.status + ' err=' + (r.stderr ?? '').slice(0, 80));

  // ---- batch_rename:幂等 + 失败退出 1 ----
  const rdir = path.join(dir, 'ren');
  fs.mkdirSync(rdir, { recursive: true });
  fs.writeFileSync(path.join(rdir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(rdir, 'b.txt'), 'b');
  r = runTool('batch_rename.ming', [rdir, 'p_', '.txt']);
  check('v51.6:rename 首轮全部改名', r.status === 0 && fs.existsSync(path.join(rdir, 'p_a.txt')) && fs.existsSync(path.join(rdir, 'p_b.txt')) && !fs.existsSync(path.join(rdir, 'a.txt')), JSON.stringify(r.stdout));
  r = runTool('batch_rename.ming', [rdir, 'p_', '.txt']);
  check('v51.6:rename 幂等(已带前缀跳过)', r.status === 0 && (r.stdout ?? '').includes('共重命名 0 个文件') && !fs.existsSync(path.join(rdir, 'p_p_a.txt')), JSON.stringify(r.stdout));
  fs.writeFileSync(path.join(rdir, 'c.txt'), 'c');
  fs.mkdirSync(path.join(rdir, 'p_c.txt'));
  r = runTool('batch_rename.ming', [rdir, 'p_', '.txt']);
  check('v51.6:rename 失败退出 1 且保留原文件', r.status === 1 && (r.stderr ?? '').includes('失败') && fs.existsSync(path.join(rdir, 'c.txt')), 'code=' + r.status + ' err=' + (r.stderr ?? '').slice(0, 100));

  // ---- file_organizer:失败退出 1 + 正常路径 ----
  // 跨平台必败场景:目标位置(x.txt 在 txt/ 内的位置)已被目录占用——
  // Windows 会静默覆盖同路径普通文件,但文件→目录的 rename 在两边都失败
  const odir = path.join(dir, 'org');
  fs.mkdirSync(path.join(odir, 'txt', 'x.txt'), { recursive: true });
  fs.writeFileSync(path.join(odir, 'x.txt'), 'x');
  r = runTool('file_organizer.ming', [odir]);
  check('v51.6:organize 失败退出 1 且保留原文件', r.status === 1 && (r.stderr ?? '').includes('失败') && fs.existsSync(path.join(odir, 'x.txt')), 'code=' + r.status + ' err=' + (r.stderr ?? '').slice(0, 100));
  const od2 = path.join(dir, 'org2');
  fs.mkdirSync(od2, { recursive: true });
  fs.writeFileSync(path.join(od2, 'y.txt'), 'y');
  r = runTool('file_organizer.ming', [od2]);
  check('v51.6:organize 正常移动进扩展名目录', r.status === 0 && fs.existsSync(path.join(od2, 'txt', 'y.txt')) && !fs.existsSync(path.join(od2, 'y.txt')), JSON.stringify(r.stdout));

  // ---- tree:深度参数 + 错误纪律 ----
  r = runTool('tree.ming', [dir, '1']);
  check('v51.6:tree 深度 1 不下钻', r.status === 0 && (r.stdout ?? '').includes('├── a.txt') && !(r.stdout ?? '').includes('│   '), JSON.stringify(r.stdout).slice(0, 120));
  r = runTool('tree.ming', [dir, '0']);
  check('v51.6:tree 深度 0 拒绝', r.status === 1 && (r.stderr ?? '').includes('正整数'), 'code=' + r.status);
  r = runTool('tree.ming', [dir, 'abc']);
  check('v51.6:tree 深度非整数拒绝', r.status === 1 && (r.stderr ?? '').includes('不是整数'), 'code=' + r.status);

  // ---- log_analyzer / todo_scan:错误纪律 + .mjs 覆盖 ----
  r = runTool('log_analyzer.ming', [path.join(dir, 'nope.log')]);
  check('v51.6:log 读不了退出 1(stderr)', r.status === 1 && (r.stderr ?? '').includes('无法读取') && (r.stdout ?? '') === '', JSON.stringify(r.stdout));
  fs.writeFileSync(path.join(dir, 'task.mjs'), '// TODO: mjs 覆盖\n');
  r = runTool('todo_scan.ming', [dir]);
  check('v51.6:todo_scan 覆盖 .mjs', r.status === 0 && (r.stdout ?? '').includes('task.mjs:1: // TODO: mjs 覆盖'), JSON.stringify(r.stdout).slice(-200));

  // ---- tools 路由:wc 多文件经统一入口 ----
  r = tools(['wc', wa, wb]);
  check('v51.6:ming tools wc 多文件', r.status === 0 && (r.stdout ?? '').endsWith('total\n'), JSON.stringify(r.stdout));

  // ---- fmt 一次到位:v0.51.6 后续修复(plan #20 注释瀑布两遍定点)----
  // tools/ + examples/ 全量:一遍 fmt --write 后再 fmt --check 必须通过(一次到定点),
  // 且两遍 --write 输出逐字相等;凡原本 --check 通过的规范文件,一遍 fmt 不得改写任何字节。
  let fmtIdemBad = [], fmtDriftBad = [], fmtCanonN = 0;
  for (const d of ['tools', 'examples']) {
    for (const tf of fs.readdirSync(path.join(ROOT, d))) {
      if (!tf.endsWith('.ming')) continue;
      const orig = path.join(ROOT, d, tf);
      const origBytes = fs.readFileSync(orig, 'utf8');
      const copy = path.join(dir, 'idem-' + tf);
      fs.writeFileSync(copy, origBytes);
      const origCanon = runMing(['fmt', orig, '--check']).code === 0;
      if (origCanon) fmtCanonN++;
      runMing(['fmt', copy, '--write']);
      const b1 = fs.readFileSync(copy, 'utf8');
      runMing(['fmt', copy, '--write']);
      const b2 = fs.readFileSync(copy, 'utf8');
      if (runMing(['fmt', copy, '--check']).code !== 0 || b1 !== b2) fmtIdemBad.push(d + '/' + tf);
      if (origCanon && b1 !== origBytes) fmtDriftBad.push(d + '/' + tf);
    }
  }
  check('v51.6:fmt 一次到位(tools+examples 全部一遍到定点)', fmtIdemBad.length === 0, '未到定点: ' + fmtIdemBad.join(','));
  check('v51.6:fmt 规范文件零漂移(' + fmtCanonN + ' 个 --check 通过者零字节改写)', fmtDriftBad.length === 0, '被改写: ' + fmtDriftBad.join(','));

  // 最小复现(单行块 + 行尾注释,来自 mingkit 历史形态):行尾注释被瀑布移成独立行后,
  // 第二遍曾按新行距多插一个空行(需 fmt 两遍才定点);修复后两遍输出必须逐字相等,
  // 且规范形态在独立行注释前保留一个空行(与 tools/mingkit.ming 现状一致)。
  const reproSrc = [
    'fn main() with io {',
    '    if 1 > 0 { return; }  // 行尾注释',
    '    print("ok");',
    '}',
  ].join('\n');
  const reproFile = path.join(dir, 'fmtcomment.ming');
  fs.writeFileSync(reproFile, reproSrc);
  runMing(['fmt', reproFile, '--write']);
  const repro1 = fs.readFileSync(reproFile, 'utf8');
  runMing(['fmt', reproFile, '--write']);
  const repro2 = fs.readFileSync(reproFile, 'utf8');
  check('v51.6:fmt 行尾注释一次到位(两遍逐字相等 + 空行保留)', repro1 === repro2 && repro1 !== reproSrc && repro1.includes('fn main() with io {\n\n    // 行尾注释\n    if 1 > 0 {'), JSON.stringify(repro1));
}

// ===================== 56. v0.52 阶段 1:prover 抽出(线性形式代数 + 差分约束求解;M3042/M3041 行为逐字不变)=====================
{
  const dir = path.join(TMP, 'v52prover');
  fs.mkdirSync(dir, { recursive: true });
  const mk = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };

  // 1) 可证真不报(常量差整数判定)+ 非常量差(≤12 变量)经差分约束求解后静默放弃
  //    (本阶段假设集为空:requires 不作为假设,非常量差与 v0.48 一样判 unknown)
  const okF = mk('ok.ming', ['fn f(a: i64) -> i64 requires a > 0 ensures result >= a + 1 {', '    return a + 1;', '}', 'fn main() with io { print(str(f(3))); }', ''].join('\n'));
  const rok = runMing(['check', okF]);
  const solverF = mk('solver.ming', ['fn h(a: i64) -> i64 requires a > 0 ensures result > 0 {', '    return a;', '}', 'fn main() with io { print(str(h(3))); }', ''].join('\n'));
  const rsolver = runMing(['check', solverF]);
  check('v52:prover 可证真不报;非常量差(≤12 变量)经求解器静默', rok.code === 0 && !(rok.stderr ?? '').includes('M3042') && rsolver.code === 0 && !(rsolver.stderr ?? '').includes('M3042'), 'ok=' + rok.code + '/' + (rok.stderr ?? '').slice(0, 100) + ' solver=' + rsolver.code + '/' + (rsolver.stderr ?? '').slice(0, 100));

  // 2) 可证违反:M3042 逐字不变(码名 + 消息 + 反例 + hint,与 §43 黄金一致)
  const eqF = mk('eq.ming', ['fn f(a: i64) -> i64 requires a > 0 ensures result == a + 2 {', '    return a + 1;', '}', 'fn main() with io { print(str(f(3))); }', ''].join('\n'));
  const req = runMing(['check', eqF]);
  check('v52:M3042 逐字不变(码名 + 反例 a = 1 + hint)', req.code === 1
    && (req.stderr ?? '').includes('error M3042[ensures-statically-false]: 函数 "f" 的 ensures 可静态证伪(反例:a = 1)')
    && (req.stderr ?? '').includes('hint: 修正确保表达式或函数体;该错误在运行时本会以 M4015 出现。'), 'stderr=' + (req.stderr ?? '').slice(0, 220));

  // 3) 超变量上限(13 > MAX_PROVER_VARS=12)静默放弃(too-many-vars → 不报、不误报)
  const params = Array.from({ length: 13 }, (_, i) => 'a' + (i + 1) + ': i64').join(', ');
  const sum = Array.from({ length: 13 }, (_, i) => 'a' + (i + 1)).join(' + ');
  const bigF = mk('big.ming', ['fn k(' + params + ') -> i64 requires a1 > 0 ensures result > 0 {', '    return ' + sum + ';', '}', 'fn main() with io { print(str(k(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))); }', ''].join('\n'));
  const rbig = runMing(['check', bigF]);
  check('v52:ensures 13 变量超上限静默放弃(too-many-vars 不报)', rbig.code === 0 && !(rbig.stderr ?? '').includes('M3042'), 'code=' + rbig.code + ' stderr=' + (rbig.stderr ?? '').slice(0, 140));

  // ---- v0.52 阶段 2:越界包含静态验证(requires 边界 → 索引义务;M3045/W3105,plan §4.2.3 任务 2+3)----
  const mkB = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };
  const clean = (r) => r.code === 0 && !(r.stderr ?? '').includes('M3045') && !(r.stderr ?? '').includes('W3105');

  // 4) 可证真不误报:0 <= i 且 i < len$buf 两向可证(含 len$x 符号、mut i64 参数重赋值、buf.len()-1);
  //    严格性:requires n <= buf.len() 不蕴含 i < len$buf → 未证明默认静默(不误报)
  const bokF = mkB('bounds_ok.ming', [
    'fn get(buf: Vec[i64], i: i64) -> i64 requires i >= 0 && i < buf.len() {',
    '    return buf[i];',
    '}',
    'fn last(buf: Vec[i64]) -> i64 requires buf.len() >= 1 {',
    '    return buf[buf.len() - 1];',
    '}',
    'fn shifted(buf: Vec[i64], n: i64) -> i64 requires n >= 1 && n <= buf.len() {',
    '    let j = n - 1;',
    '    return buf[j];',
    '}',
    'fn loose(buf: Vec[i64], n: i64) -> i64 requires n <= buf.len() {',
    '    return buf[n];',
    '}',
    'fn main() with io { print(str(get([1, 2], 1)) + str(last([1, 2])) + str(shifted([1, 2], 2)) + str(loose([1, 2], 0))); }',
    '',
  ].join('\n'));
  const brok = runMing(['check', bokF]);
  check('v52.2:可证真不误报(义务两向可证;<= 严格性未证明静默)', clean(brok), 'code=' + brok.code + ' stderr=' + (brok.stderr ?? '').slice(0, 200));

  // 5) 可证违反:M3045 + 反例(码名 + 索引原文 + 违反义务 + len$x 小值反例 + hint)
  const bbadF = mkB('bounds_bad.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n == buf.len() {',
    '    return buf[n];',
    '}',
    'fn main() with io { print(str(f([1, 2], 2))); }',
    '',
  ].join('\n'));
  const brbad = runMing(['check', bbadF]);
  check('v52.2:可证违反 M3045+反例(len$buf = 0, n = 0)', brbad.code === 1
    && (brbad.stderr ?? '').includes('error M3045[index-bounds-violated]: 函数 "f" 的索引 "buf[n]" 可静态证明越界(违反义务:n < len$buf)(反例:len$buf = 0, n = 0)')
    && (brbad.stderr ?? '').includes('hint: 让索引满足 n < len$buf 对所有满足 requires 的调用成立')
    && (brbad.stderr ?? '').includes('该越界在运行时本会以 M4003 panic。'), 'code=' + brbad.code + ' stderr=' + (brbad.stderr ?? '').slice(0, 260));

  // 6) mut Vec 参数放弃(push 改长度;非 mut Vec[i64] 之外的元素类型同样放弃):静默
  const bmutF = mkB('bounds_mut.ming', [
    'fn f(mut buf: Vec[i64], n: i64) -> i64 requires n == buf.len() {',
    '    buf.push(0);',
    '    return buf[n];',
    '}',
    'fn g(s: Vec[str], i: i64) -> str requires i == s.len() {',
    '    return s[i];',
    '}',
    'fn main() with io { print(str(f([1], 1))); print(g(["a"], 1)); }',
    '',
  ].join('\n'));
  const brmut = runMing(['check', bmutF]);
  check('v52.2:mut Vec / 非元素类型放弃(静默,不报 M3045)', clean(brmut), 'code=' + brmut.code + ' stderr=' + (brmut.stderr ?? '').slice(0, 200));

  // 7) requires 负环(自相矛盾 → 函数不可达)→ 整函数跳过报告
  const bcycF = mkB('bounds_cycle.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n >= buf.len() && n < buf.len() {',
    '    return buf[n];',
    '}',
    'fn main() with io { print(str(f([], 0))); }',
    '',
  ].join('\n'));
  const brcyc = runMing(['check', bcycF]);
  check('v52.2:requires 负环跳过(不可达 → 不报 M3045)', clean(brcyc), 'code=' + brcyc.code + ' stderr=' + (brcyc.stderr ?? '').slice(0, 200));

  // 8) 非直线体放弃(if/复合赋值 → 后续义务不再收集):静默
  const bnlF = mkB('bounds_nonlin.ming', [
    'fn a(buf: Vec[i64], n: i64) -> i64 requires n >= 1 && n < buf.len() {',
    '    if n > 2 { return buf[n - 1]; }',
    '    return buf[n - 1];',
    '}',
    'fn b(buf: Vec[i64], mut n: i64) -> i64 requires n >= 0 && n < buf.len() {',
    '    n += 1;',
    '    return buf[n];',
    '}',
    'fn main() with io { print(str(a([1, 2, 3], 3)) + str(b([1, 2], 1))); }',
    '',
  ].join('\n'));
  const brnl = runMing(['check', bnlF]);
  check('v52.2:非直线体(if/复合赋值)放弃(静默,不报 M3045)', clean(brnl), 'code=' + brnl.code + ' stderr=' + (brnl.stderr ?? '').slice(0, 200));

  // ---- v0.52 阶段 3(收口,plan §4.2.3 任务 4+5+6):循环/别名/非线性放弃、警告旗标、
  //      --proof-report 文本与 JSON、无旗标 JSON 快照、运行时仍 M4003 ----

  // 9) 循环放弃(for/while 内义务不登记):静默,且 --warn-unproven-index 下也无 W3105
  const bloopF = mkB('bounds_loop.ming', [
    'fn f(buf: Vec[i64], mut n: i64) -> i64 requires n >= 0 && n < buf.len() {',
    '    let mut s = 0;',
    '    for i in 0..n { s += buf[i]; }',
    '    while n > 0 { s += buf[n]; n -= 1; }',
    '    return s;',
    '}',
    'fn main() with io { print(str(f([1, 2, 3], 2))); }',
    '',
  ].join('\n'));
  const brloop = runMing(['check', bloopF]);
  const brloopW = runMing(['check', bloopF, '--warn-unproven-index']);
  check('v52.3:循环放弃(for/while 义务不登记;旗标下也无 W3105)', clean(brloop) && clean(brloopW), 'code=' + brloop.code + '/' + brloopW.code + ' stderr=' + (brloopW.stderr ?? '').slice(0, 200));

  // 10) 别名/重绑定放弃(let b = buf → 形式不可计算 → 后续 b[n] 不登记):静默
  const baliasF = mkB('bounds_alias.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n >= 0 && n < buf.len() {',
    '    let b = buf;',
    '    return b[n];',
    '}',
    'fn main() with io { print(str(f([1, 2], 1))); }',
    '',
  ].join('\n'));
  const bralias = runMing(['check', baliasF]);
  const braliasW = runMing(['check', baliasF, '--warn-unproven-index']);
  check('v52.3:别名放弃(let b = buf 后 b[n] 不登记;旗标下也无 W3105)', clean(bralias) && clean(braliasW), 'code=' + bralias.code + '/' + braliasW.code + ' stderr=' + (braliasW.stderr ?? '').slice(0, 200));

  // 11) 非线性索引静默(buf[n * n] → 形式 null → 未证明):默认静默,旗标下发 W3105(未证明而非违反)
  const bnl2F = mkB('bounds_nonlinear.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n >= 0 && n < buf.len() {',
    '    return buf[n * n];',
    '}',
    'fn main() with io { print(str(f([1, 2, 3, 4], 1))); }',
    '',
  ].join('\n'));
  const brnl2 = runMing(['check', bnl2F]);
  const brnl2W = runMing(['check', bnl2F, '--warn-unproven-index']);
  check('v52.3:非线性索引静默(默认不报 M3045/W3105)', clean(brnl2), 'code=' + brnl2.code + ' stderr=' + (brnl2.stderr ?? '').slice(0, 200));
  check('v52.3:非线性索引旗标下 W3105(未证明:0 <= n * n; n * n < len$buf)', brnl2W.code === 0
    && (brnl2W.stderr ?? '').includes('warning W3105[index-bounds-unproven]: 函数 "f" 的索引 "buf[n * n]" 无法静态证明在界内(未证明:0 <= n * n; n * n < len$buf)')
    && !(brnl2W.stderr ?? '').includes('M3045'), 'code=' + brnl2W.code + ' stderr=' + (brnl2W.stderr ?? '').slice(0, 240));

  // 12) 警告旗标:--warn-unproven-index 下未证明发 W3105(逐字消息,warning 不改退出码)
  const bwarnF = mkB('bounds_warn.ming', [
    'fn loose(buf: Vec[i64], n: i64) -> i64 requires n >= 0 && n <= buf.len() {',
    '    return buf[n];',
    '}',
    'fn main() with io { print(str(loose([1, 2], 0))); }',
    '',
  ].join('\n'));
  const brwarn = runMing(['check', bwarnF, '--warn-unproven-index']);
  check('v52.3:警告旗标下 W3105 逐字消息(未证明:n < len$buf;退出码仍 0)', brwarn.code === 0
    && (brwarn.stderr ?? '').includes('warning W3105[index-bounds-unproven]: 函数 "loose" 的索引 "buf[n]" 无法静态证明在界内(未证明:n < len$buf)'),
    'code=' + brwarn.code + ' stderr=' + (brwarn.stderr ?? '').slice(0, 240));

  // 13) 默认不发 W3105(同文件无旗标 → check 干净)
  const brnowarn = runMing(['check', bwarnF]);
  check('v52.3:默认不发 W3105(同文件无旗标 check 干净)', clean(brnowarn), 'code=' + brnowarn.code + ' stderr=' + (brnowarn.stderr ?? '').slice(0, 200));

  // 14) 无 requires 不警告(无前置 → 无边界可依 → 静默;旗标下同样不发)
  const bnoreqF = mkB('bounds_noreq.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 {',
    '    return buf[n];',
    '}',
    'fn main() with io { print(str(f([1, 2], 0))); }',
    '',
  ].join('\n'));
  const brnoreq = runMing(['check', bnoreqF, '--warn-unproven-index']);
  check('v52.3:无 requires 不警告(旗标下也无 W3105/M3045)', clean(brnoreq), 'code=' + brnoreq.code + ' stderr=' + (brnoreq.stderr ?? '').slice(0, 200));

  // 15) 无旗标 JSON 快照:与 git HEAD 版本 CLI 输出逐字一致(证明 --proof-report/--warn-unproven-index/证明记录全 additive)
  const jdir = path.join(TMP, 'v52jsnap');
  fs.mkdirSync(jdir, { recursive: true });
  const jf = (name, src) => { const p = path.join(jdir, name); fs.writeFileSync(p, src); return p; };
  const jClean = jf('clean.ming', 'fn main() with io { print(str(1 + 2)); }\n');
  const jDiag = jf('diag.ming', [
    'fn f(a: i64) -> i64 requires a > 0 ensures result == a + 2 {',
    '    return a + 1;',
    '}',
    'fn main() with io { print(str(f(3))); }',
    '',
  ].join('\n'));
  const jPlain = jf('plain.ming', 'fn main() with io { let v: Vec[i64] = [3, 1]; let mut s = 0; for x in v { s += x; } print(str(s)); }\n');
  // HEAD CLI 快照:bin/ming.js + src/*.js 逐文件 git show 到临时目录(只读,零依赖 tar)
  const headDir = path.join(TMP, 'v52headcli');
  fs.rmSync(headDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(headDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(headDir, 'src'), { recursive: true });
  const gitShow = (p) => { const g = spawnSync('git', ['-C', ROOT, 'show', 'HEAD:' + p], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }); return (g.status === 0 && !g.error) ? g.stdout : null; };
  const headReady = (() => {
    const bin = gitShow('bin/ming.js');
    if (!bin) return false;
    fs.writeFileSync(path.join(headDir, 'bin', 'ming.js'), bin);
    const ls = spawnSync('git', ['-C', ROOT, 'ls-tree', '--name-only', 'HEAD', 'src/'], { encoding: 'utf8' });
    if (ls.status !== 0 || ls.error) return false;
    for (const line of ls.stdout.split('\n')) {
      const nm = line.trim();
      if (!nm.endsWith('.js')) continue;
      const data = gitShow(nm);
      if (!data) return false;
      fs.writeFileSync(path.join(headDir, nm), data);
    }
    return true;
  })();
  const jsonOf = (binPath, file) => { const r = spawnSync(process.execPath, [binPath, 'check', file, '--json'], { encoding: 'utf8', timeout: 30000 }); return r.stdout ?? ''; };
  let headSame = headReady;
  const headBin = path.join(headDir, 'bin', 'ming.js');
  for (const f of [jClean, jDiag, jPlain]) if (headSame) headSame = jsonOf(headBin, f) === jsonOf(MING, f);
  check('v52.3:无旗标 JSON 与 git HEAD 版本输出逐字一致(clean/diag/plain 三语料)', headSame, 'headReady=' + headReady);
  // 黄金快照(路径归一化;对 HEAD 时代输出逐字节固化,HEAD 前移后仍守住无旗标 JSON 协议)
  // 分隔符无关:仅 file 字段把 \ 与 / 归一后比较(POSIX 也能跑),其余字段逐字节不变
  const normJson = (s) => JSON.stringify(JSON.parse(s), (k, v) => (typeof v === 'string' ? (k === 'file' ? v.split(TMP).join('<TMP>').split('\\').join('/') : v.split(TMP).join('<TMP>')) : v), 2) + '\n';
  const GOLDEN_CLEAN = '{\n  "ok": true,\n  "diagnostics": []\n}\n';
  const GOLDEN_DIAG = '{\n  "ok": false,\n  "diagnostics": [\n    {\n      "code": "M3042",\n      "name": "ensures-statically-false",\n      "severity": "error",\n      "message": "函数 \\"f\\" 的 ensures 可静态证伪(反例:a = 1)",\n      "file": "<TMP>/v52jsnap/diag.ming",\n      "line": 1,\n      "col": 36,\n      "endLine": 1,\n      "endCol": 59,\n      "hint": "修正确保表达式或函数体;该错误在运行时本会以 M4015 出现。"\n    }\n  ]\n}\n';
  check('v52.3:无旗标 JSON 黄金快照(clean 空 + diag M3042,路径归一化逐字节)',
    normJson(jsonOf(MING, jClean)) === GOLDEN_CLEAN && normJson(jsonOf(MING, jDiag)) === GOLDEN_DIAG,
    'clean=' + JSON.stringify(normJson(jsonOf(MING, jClean)).slice(0, 60)) + ' diag=' + JSON.stringify(normJson(jsonOf(MING, jDiag)).slice(0, 120)));

  // 16) 运行时仍 M4003:requires 只约束部分调用面(n <= buf.len())→ check 干净,
  //     但满足 requires 的实参仍可越界 → 默认引擎与树引擎都 M4003/101(证明只报告,不改运行时)
  const bm4003F = mkB('bounds_m4003.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n >= 0 && n <= buf.len() {',
    '    return buf[n];',
    '}',
    'fn main() with io { print(str(f([1, 2], 2))); }',
    '',
  ].join('\n'));
  const brm4003c = runMing(['check', bm4003F]);
  const brm4003 = runMing(['run', bm4003F]);
  const brm4003t = runMing(['run', bm4003F, '--tree']);
  check('v52.3:check 干净(未证明不报)但运行时仍 M4003(退出 101,双引擎一致)', clean(brm4003c)
    && brm4003.code === 101 && (brm4003.stderr ?? '').includes('M4003')
    && brm4003t.code === 101 && (brm4003t.stderr ?? '').includes('M4003'),
    'check=' + brm4003c.code + '/' + (brm4003c.stderr ?? '').slice(0, 120) + ' run=' + brm4003.code + '/' + (brm4003.stderr ?? '').slice(0, 120) + ' tree=' + brm4003t.code + '/' + (brm4003t.stderr ?? '').slice(0, 120));

  // 17) --proof-report 文本摘要:每函数一行统计;零义务语料零额外行;M3045 仍走诊断通道
  const brepF = mkB('bounds_report.ming', [
    'fn get(buf: Vec[i64], i: i64) -> i64 requires i >= 0 && i < buf.len() {',
    '    return buf[i];',
    '}',
    'fn bad(buf: Vec[i64], n: i64) -> i64 requires n == buf.len() {',
    '    return buf[n];',
    '}',
    'fn main() with io { print(str(get([1, 2], 1))); }',
    '',
  ].join('\n'));
  const brrep = runMing(['check', brepF, '--proof-report']);
  check('v52.3:--proof-report 文本摘要(逐函数统计行;M3045 共存;退出 1)', brrep.code === 1
    && (brrep.stderr ?? '').includes('error M3045[index-bounds-violated]')
    && (brrep.stdout ?? '').includes(':get: 义务 1,proven 1,violated 0,unproven 0')
    && (brrep.stdout ?? '').includes(':bad: 义务 1,proven 0,violated 1,unproven 0'),
    'code=' + brrep.code + ' stdout=' + JSON.stringify((brrep.stdout ?? '').slice(0, 220)) + ' stderr=' + (brrep.stderr ?? '').slice(0, 160));
  const brrep0 = runMing(['check', jPlain, '--proof-report']);
  check('v52.3:--proof-report 零义务语料零额外行(stdout 逐字不变)', brrep0.code === 0 && brrep0.stdout === '', 'code=' + brrep0.code + ' stdout=' + JSON.stringify(brrep0.stdout));

  // 18) --json --proof-report:additive proofs 字段(每函数统计 + 逐义务数组);无旗标 JSON 无 proofs 键
  const brj = JSON.parse(runMing(['check', brepF, '--json', '--proof-report']).stdout);
  const brjNoFlag = JSON.parse(runMing(['check', brepF, '--json']).stdout);
  const pget = brj.proofs.functions.find((x) => x.fn === 'get');
  const pbad = brj.proofs.functions.find((x) => x.fn === 'bad');
  check('v52.3:--json --proof-report proofs 字段(summary + 逐义务 {file,fn,index,kind,obligation,反例})',
    brj.proofs.summary.functions === 2 && brj.proofs.summary.obligations === 2
    && brj.proofs.summary.proven === 1 && brj.proofs.summary.violated === 1 && brj.proofs.summary.unproven === 0
    && pget && pget.total === 1 && pget.proven === 1
    && pget.obligations[0].index === 'i' && pget.obligations[0].kind === 'proven'
    && pget.obligations[0].obligation === '0 <= i && i < len$buf' && pget.obligations[0].counterexample === null
    && pbad && pbad.obligations[0].kind === 'violated' && pbad.obligations[0].obligation === 'n < len$buf'
    && pbad.obligations[0].counterexample === 'len$buf = 0, n = 0' && pbad.obligations[0].line === 5
    && brj.diagnostics.some((d) => d.code === 'M3045'),
    JSON.stringify(brj.proofs).slice(0, 300));
  check('v52.3:无旗标 JSON 不含 proofs 键(纯 additive)', !('proofs' in brjNoFlag), JSON.stringify(Object.keys(brjNoFlag)));

  // 19) 复合索引的索引原文完整性(.parser 的 Binary/Call 子节点 span 起点在操作符/实参括号;
  //     证明报告/义务文本必须从完整 Index 跨度取方括号内文,不被截断)
  const bidxF = mkB('bounds_idxtext.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n >= 1 && n <= buf.len() {',
    '    return buf[n - 1];',
    '}',
    'fn g(buf: Vec[i64], n: i64) -> i64 requires n >= 0 {',
    '    return buf[buf.len()];',
    '}',
    'fn main() with io { print(str(f([1, 2, 3], 2)) + str(g([1], 0))); }',
    '',
  ].join('\n'));
  const bridx = JSON.parse(runMing(['check', bidxF, '--json', '--proof-report']).stdout);
  const ifn = bridx.proofs.functions.find((x) => x.fn === 'f');
  const ign = bridx.proofs.functions.find((x) => x.fn === 'g');
  check('v52.3:复合索引原文完整(buf[n - 1] → "n - 1";buf[buf.len()] → "buf.len()";义务文本同步)',
    ifn && ifn.obligations[0].index === 'n - 1' && ifn.obligations[0].kind === 'proven'
    && ifn.obligations[0].obligation === '0 <= n - 1 && n - 1 < len$buf'
    && ign && ign.obligations[0].index === 'buf.len()' && ign.obligations[0].kind === 'violated'
    && ign.obligations[0].obligation === 'buf.len() < len$buf'
    && ign.obligations[0].counterexample === 'len$buf = 0, n = 0'
    && bridx.diagnostics.some((d) => d.code === 'M3045'),
    JSON.stringify(bridx.proofs?.functions?.map((x) => x.obligations?.[0]) ?? null).slice(0, 300));

  // 20) 反例过滤:requires 含被跳过但可求值的叶子时(% 不可编码为线性假设,但 evalContractExpr
  //     可判定),M3045 反例枚举命中候选后按被跳过叶子过滤 —— 反例必须满足完整 requires,
  //     取最小奇数解(len$buf = 1, n = 1;修复前会给出不满足奇偶约束的 len$buf = 0, n = 0);
  //     过滤后无候选则退回"无反例"消息变体
  const bmodF = mkB('bounds_mod.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n == buf.len() && n % 2 == 1 {',
    '    return buf[n];',
    '}',
    'fn main() with io { print(str(f([1], 1))); }',
    '',
  ].join('\n'));
  const brmod = runMing(['check', bmodF]);
  check('v52.4:反例过滤(被跳过 % 叶子 → 最小奇数解,M3045 逐字 len$buf = 1, n = 1)', brmod.code === 1
    && (brmod.stderr ?? '').includes('error M3045[index-bounds-violated]: 函数 "f" 的索引 "buf[n]" 可静态证明越界(违反义务:n < len$buf)(反例:len$buf = 1, n = 1)')
    && (brmod.stderr ?? '').includes('hint: 让索引满足 n < len$buf 对所有满足 requires 的调用成立'),
    'code=' + brmod.code + ' stderr=' + (brmod.stderr ?? '').slice(0, 260));

  // 21) 过滤后反例满足被跳过叶子(属性断言):反例 n 为奇数且 n == len$buf(完整 requires 成立)
  const brmodJ = JSON.parse(runMing(['check', bmodF, '--json', '--proof-report']).stdout);
  const modCex = brmodJ.proofs.functions.find((x) => x.fn === 'f')?.obligations?.[0]?.counterexample ?? null;
  const modVals = {};
  let modOk = typeof modCex === 'string' && modCex.length > 0;
  for (const kv of modOk ? modCex.split(', ') : []) {
    const [k, v] = kv.split(' = ');
    if (!/^-?\d+$/.test(v ?? '')) { modOk = false; break; }
    modVals[k] = BigInt(v);
  }
  check('v52.4:过滤后反例满足被跳过叶子(n 为奇数且 n == len$buf)', modOk
    && modVals['n'] % 2n === 1n && modVals['n'] === modVals['len$buf'],
    'cex=' + JSON.stringify(modCex));

  // 22) W3105 噪声门控:文件已有 error 诊断时不再叠加 W3105 —— buf["k"] 索引类型错误语料
  //     在 --warn-unproven-index 下只有 M3002、无 W3105(错误优先,告警不稀释)
  const btypF = mkB('bounds_typerr.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n >= 0 && n <= buf.len() {',
    '    return buf["k"];',
    '}',
    'fn main() with io { print(str(f([1, 2], 0))); }',
    '',
  ].join('\n'));
  const brtypW = runMing(['check', btypF, '--warn-unproven-index']);
  check('v52.4:W3105 门控(文件已有 M3002 error → 旗标下只有 M3002、无 W3105)', brtypW.code === 1
    && (brtypW.stderr ?? '').includes('error M3002') && !(brtypW.stderr ?? '').includes('W3105'),
    'code=' + brtypW.code + ' stderr=' + (brtypW.stderr ?? '').slice(0, 240));
}

// ===================== 57. v0.53:strict wasm 三态 + 构建可信性(collectProjectSources/buildKey/build --json)=====================
// v0.53 阶段2 追加:env -i launcher 验收(v53.14-16)+ C 后端 str for-in 码点迭代黄金(v53.17-19)
// v0.53 阶段3 追加:CI workflow 静态结构 + 版本三处一致/修订记录(v53.20-21)
// v0.53 收口追加:尾表达式函数 wasm 模块有效性回归(v53.22;strict 暴露的既有回落形态)
// v0.53.0 独立审查修复回归:F 节 v53.23–v53.31(B2 JSON 信息丢失 / M1 no-wasm 字段 /
// M2 点名函数 / M9 fib 真 wasm 执行 / B3 C for-in 遮蔽 / M12 除号 opcode / M6 env 剥离 / M7 纯 JSON)
{
  // ---------- A. strict wasm(--strict-wasm / MING_WASM_STRICT=1;判定本体 src/wasm.js wasmLayerStatus)----------
  // fallback 构造:eligible 形态(f64→f64)但 wasm 不支持 f64 复合赋值(§47 同类:整体静默回落,exit 0)
  const okProg = mingFile('v53-wasm-ok.ming', [
    'fn fib(n: i64) -> i64 { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }',
    'fn main() with io { print(str(fib(10))); }',
  ].join('\n'));
  const fbProg = mingFile('v53-wasm-fallback.ming', [
    'fn g(x: f64) -> f64 { let mut y = x; y += 1.0; return y; }',
    'fn main() with io { print(str(g(1.5))); }',
  ].join('\n'));
  const noneProg = mingFile('v53-wasm-none.ming', 'fn main() with io { print("e"); }');

  // 1) eligible 程序 strict 下 ok:旗标与环境变量等价;--json wasm_status=ok;
  //    键集固化(除新增 wasm_status 外与 HEAD 逐字一致);--tree 无 wasm 分层,键集完全不变
  const okStrict = runMing(['run', okProg, '--strict-wasm']);
  // 环境变量等价:显式注入 env(runMing 默认剥离 MING_WASM_STRICT,见 M6 修复)
  const okEnv = runMing(['run', okProg], { env: { MING_WASM_STRICT: '1' } });
  const okJson = JSON.parse(runMing(['run', okProg, '--json']).stdout);
  const treeJson = JSON.parse(runMing(['run', okProg, '--json', '--tree']).stdout);
  check('v53.1:strict-wasm eligible 程序 ok(旗标+环境变量+json 三态+键集固化)',
    okStrict.code === 0 && okStrict.stdout === '55\n'
    && okEnv.code === 0 && okEnv.stdout === '55\n'
    && okJson.wasm_status === 'ok' && okJson.exit_code === 0
    && JSON.stringify(Object.keys(okJson).sort()) === JSON.stringify(['engine', 'exit_code', 'ms', 'ok', 'stderr', 'stdout', 'wasm', 'wasm_status'])
    && !('wasm_status' in treeJson) && JSON.stringify(Object.keys(treeJson).sort()) === JSON.stringify(['engine', 'exit_code', 'ms', 'ok', 'stderr', 'stdout', 'wasm']),
    'code=' + okStrict.code + ' env=' + okEnv.code + ' status=' + okJson.wasm_status + ' keys=' + JSON.stringify(Object.keys(okJson).sort()));

  // 2) fallback:strict exit 2 并点名函数与原因(文本 stderr 与 --json 两路)
  const fbStrict = runMing(['run', fbProg, '--strict-wasm']);
  const fbJson = JSON.parse(runMing(['run', fbProg, '--strict-wasm', '--json']).stdout);
  check('v53.2:strict fallback exit 2 + 点名函数与原因',
    fbStrict.code === 2 && fbStrict.stdout === '' && (fbStrict.stderr ?? '').includes('wasm 编译回落(g)') && (fbStrict.stderr ?? '').includes('f64 复合赋值')
    && fbJson.exit_code === 2 && fbJson.wasm_status === 'fallback' && (fbJson.error ?? '').includes('f64 复合赋值'),
    'code=' + fbStrict.code + ' stderr=' + (fbStrict.stderr ?? '').slice(0, 160) + ' json=' + JSON.stringify(fbJson));

  // 3) 非 strict 静默回落行为逐字不变(exit 0 + 正确结果 + stderr 干净);--json 仅 additive 多 wasm_status
  const fbPlain = runMing(['run', fbProg]);
  const fbJsonNon = JSON.parse(runMing(['run', fbProg, '--json']).stdout);
  check('v53.3:非 strict 静默回落行为不变(json 仅 additive wasm_status=fallback)',
    fbPlain.code === 0 && fbPlain.stdout === '2.5\n' && (fbPlain.stderr ?? '') === ''
    && fbJsonNon.exit_code === 0 && fbJsonNon.stdout === '2.5\n' && fbJsonNon.wasm_status === 'fallback',
    'code=' + fbPlain.code + ' stdout=' + JSON.stringify(fbPlain.stdout) + ' status=' + fbJsonNon.wasm_status);

  // 4) 零 eligible → none(exit 0;main 带 io 不 eligible,无分层可验)
  const noneJson = JSON.parse(runMing(['run', noneProg, '--json']).stdout);
  check('v53.4:零 eligible → none(exit 0)', noneJson.wasm_status === 'none' && noneJson.exit_code === 0, 'status=' + noneJson.wasm_status);

  // 5) 互斥冲突 exit 1:--strict-wasm × --tree/--no-wasm,环境变量同样要拦
  const c1 = runMing(['run', okProg, '--strict-wasm', '--tree']);
  const c2 = runMing(['run', okProg, '--strict-wasm', '--no-wasm']);
  const c3 = runMing(['run', okProg, '--tree'], { env: { MING_WASM_STRICT: '1' } });
  check('v53.5:互斥冲突 exit 1(旗标×tree/no-wasm + 环境变量×tree)',
    c1.code === 1 && (c1.stderr ?? '').includes('互斥') && c2.code === 1 && (c2.stderr ?? '').includes('互斥') && c3.code === 1 && (c3.stderr ?? '').includes('互斥'),
    'codes=' + c1.code + ',' + c2.code + ',' + c3.code);

  // 6) check --strict-wasm:通过语料 ok;回落语料 exit 2 + 原因;非 strict 的 check --json 不带 wasm_status
  const chkOk = JSON.parse(runMing(['check', okProg, '--strict-wasm', '--json']).stdout);
  const chkFb = runMing(['check', fbProg, '--strict-wasm']);
  const chkPlain = JSON.parse(runMing(['check', okProg, '--json']).stdout);
  check('v53.6:check --strict-wasm(ok/fallback exit 2;非 strict JSON 无 wasm_status)',
    chkOk.wasm_status === 'ok' && chkFb.code === 2 && (chkFb.stderr ?? '').includes('wasm 编译回落(g)') && !('wasm_status' in chkPlain),
    'ok=' + chkOk.wasm_status + ' fb=' + chkFb.code + ' stderr=' + (chkFb.stderr ?? '').slice(0, 140));

  // 7) wasmLayerStatus 纯函数三态直测(覆盖 fallback 分支;不经过 CLI)
  const { Checker } = await import('../src/checker.js');
  const { compile } = await import('../src/compiler.js');
  const { wasmLayerStatus } = await import('../src/wasm.js');
  const mkStatus = (p) => { const c = new Checker(p); const r = c.run(); return wasmLayerStatus(r, compile(r)); };
  const stOk = mkStatus(okProg);
  const stFb = mkStatus(fbProg);
  const stNone = mkStatus(noneProg);
  check('v53.7:wasmLayerStatus 纯函数三态(ok/fallback 点名/none)',
    stOk.status === 'ok' && stOk.eligible >= 1 && stOk.reason === null
    && stFb.status === 'fallback' && (stFb.reason ?? '').includes('编译回落(g)') && (stFb.reason ?? '').includes('f64 复合赋值') && stFb.eligible === 1
    && stNone.status === 'none' && stNone.eligible === 0,
    'ok=' + JSON.stringify(stOk) + ' fb=' + JSON.stringify(stFb) + ' none=' + JSON.stringify(stNone));

  // ---------- B. 构建可信性(任务4)----------
  const mkProj53 = (name) => {
    const d = path.join(TMP, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'ming.toml'), '[project]\nname = "' + name + '"\nversion = "0.1.0"\nentry = "app.ming"\n');
    return d;
  };
  const write53 = (d, rel, src) => { const p = path.join(d, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, src); };
  const build53 = (d, extra = []) => spawnSync(process.execPath, [MING, 'build', '--json', ...extra], { encoding: 'utf8', cwd: d, timeout: 120000 });
  // build --json:stdout 为纯 JSON(v0.53 审查修复:人读"产物:"行改走 stderr),可直接 JSON.parse
  const parseBuild53 = (stdout) => JSON.parse(stdout);

  const pn = mkProj53('v53-nested');
  write53(pn, 'app.ming', 'fn main() with io { print("n"); }\n');
  // v53.9 要害:两个文件**同名**(lib/a.ming 与 lib/deep/a.ming,均定义 pub fn a,内容不同)——
  // 旧实现条目只用 basename,交换内容后键不变(漏检);相对路径 + 内容才真正区分。
  write53(pn, 'lib/a.ming', 'pub fn a() -> i64 { return 1; }\n');
  write53(pn, 'lib/deep/a.ming', 'pub fn a() -> i64 { return 2; }\n');

  // 8) 嵌套两层目录 source_count 正确(collectProjectSources 修复证据:旧实现 4 文件收 11 条,新实现 4 条)
  //    fresh JSON 键集固化 + interface_hashes 结构化(每模块 file+interfaceHash)
  const bn1r = build53(pn);
  const bn1 = parseBuild53(bn1r.stdout);
  check('v53.8:嵌套目录 source_count=4 + fresh 键集固化 + interface_hashes 结构化',
    bn1r.status === 0 && bn1.ok === true && bn1.source_count === 4 && bn1.cache_hit === false && typeof bn1.dist_hash === 'string' && bn1.dist_hash.length > 0
    && JSON.stringify(Object.keys(bn1).sort()) === JSON.stringify(['build_key', 'cache_hit', 'compiler_hash', 'diagnostics', 'dist_hash', 'entry', 'interface_hashes', 'ms', 'ok', 'project', 'source_count', 'version'])
    && Array.isArray(bn1.interface_hashes) && bn1.interface_hashes.length === 1 && bn1.interface_hashes[0].file === 'app.ming' && /^[0-9a-f]{16}$/.test(bn1.interface_hashes[0].interfaceHash),
    'count=' + bn1.source_count + ' keys=' + JSON.stringify(Object.keys(bn1).sort()) + ' ifaces=' + JSON.stringify(bn1.interface_hashes));

  // 9) 同名不同目录交换内容 → build_key 变化(旧实现条目只用 basename,交换后条目多重集不变 → 漏检)
  //    初始 lib/a.ming=1、lib/deep/a.ming=2;交换后 lib/a.ming=2、lib/deep/a.ming=1。
  const k1 = parseBuild53(build53(pn).stdout).build_key;
  write53(pn, 'lib/a.ming', 'pub fn a() -> i64 { return 2; }\n');
  write53(pn, 'lib/deep/a.ming', 'pub fn a() -> i64 { return 1; }\n');
  const k2 = parseBuild53(build53(pn).stdout).build_key;
  check('v53.9:同名不同目录交换内容 → build_key 变化(旧实现 basename 键会保持不变)', k1 !== k2, 'k1=' + k1.slice(0, 12) + ' k2=' + k2.slice(0, 12));

  // 10) 两次 --clean-cache 构建 dist_hash 相同(同 OS + 同 Node 主版本可复现)
  const cl1 = parseBuild53(build53(pn, ['--clean-cache']).stdout);
  const cl2 = parseBuild53(build53(pn, ['--clean-cache']).stdout);
  check('v53.10:两次 --clean-cache 构建 dist_hash 相同',
    cl1.cache_hit === false && cl2.cache_hit === false && cl1.dist_hash === cl2.dist_hash && cl1.build_key === cl2.build_key,
    'h1=' + (cl1.dist_hash ?? '').slice(0, 16) + ' h2=' + (cl2.dist_hash ?? '').slice(0, 16));

  // 11) 第三次构建(不 clean)cache_hit: true;hit JSON 键集固化;键与 dist_hash 稳定
  const h3 = parseBuild53(build53(pn).stdout);
  check('v53.11:第三次构建 cache_hit true(hit 键集固化 + 键/哈希稳定)',
    h3.cache_hit === true && h3.cache === 'hit' && h3.build_key === cl2.build_key && h3.dist_hash === cl2.dist_hash && h3.source_count === 4
    && JSON.stringify(Object.keys(h3).sort()) === JSON.stringify(['build_key', 'cache', 'cache_hit', 'compiler_hash', 'dist_hash', 'interface_hashes', 'ms', 'ok', 'project', 'source_count']),
    'hit=' + h3.cache_hit + ' keys=' + JSON.stringify(Object.keys(h3).sort()));

  // 12) 非 .ming 项目行为不变:空目录与仅清单(入口缺失)的失败逐字保留
  const emptyDir = path.join(TMP, 'v53-empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  const tomlOnly = mkProj53('v53-toml-only');
  const e1 = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: emptyDir, timeout: 60000 });
  const e2 = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: tomlOnly, timeout: 60000 });
  check('v53.12:非项目/仅清单项目行为不变',
    e1.status === 1 && (e1.stderr ?? '').includes('build 需要 ming.toml') && e2.status === 1 && (e2.stderr ?? '').includes('入口文件不存在'),
    'c1=' + e1.status + ' c2=' + e2.status + ' e2=' + (e2.stderr ?? '').slice(0, 100));

  // 13) 旧缓存(键算法变化后)自然失效重建,不崩溃:预写异键缓存 → 重建成功 → 下次命中
  const lp = mkProj53('v53-legacy');
  write53(lp, 'app.ming', 'fn main() with io { print("l"); }\n');
  const legacy = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: lp, timeout: 120000 });
  fs.writeFileSync(path.join(lp, '.ming-cache', 'build-cache.json'), JSON.stringify({ key: 'legacy-old-algorithm', builtAt: '2000-01-01T00:00:00.000Z', compilerVersion: '0.49.0', distHash: null, modules: [] }, null, 1));
  const reb = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: lp, timeout: 120000 });
  const rebHit = parseBuild53(build53(lp).stdout);
  check('v53.13:旧缓存键失效自然重建(不崩溃 + 下次命中)',
    legacy.status === 0 && reb.status === 0 && !(reb.stdout ?? '').includes('缓存命中') && rebHit.cache_hit === true,
    'legacy=' + legacy.status + ' reb=' + reb.status + ' hit=' + rebHit.cache_hit);

  // ---------- C. env -i launcher 验收(v0.53 任务3)----------
  // 最小项目 → 构建 AOT dist → 复制到与项目无关的临时目录 → 删除项目源目录
  // → 无关 cwd + 平台最小环境启动 launcher(Windows 仅 SystemRoot;POSIX 仅 PATH/LANG)。
  // 断言 stdout/退出码与正常(继承)环境逐字一致,参数按字节透传。
  const penv = mkProj53('v53-env-i');
  write53(penv, 'app.ming', [
    'fn main(args: Vec[str]) with io {',
    '    print("dist-ok");',
    '    print(str(args.len()));',
    '    if args.len() > 0 { print(args[0]); }',
    '    if args.len() > 1 { panic("dist-env-i"); }',
    '}',
  ].join('\n'));
  const benv = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: penv, timeout: 120000 });
  const envIDist = path.join(TMP, 'v53-env-i-relocated', 'dist');
  fs.mkdirSync(path.dirname(envIDist), { recursive: true });
  fs.cpSync(path.join(penv, 'dist'), envIDist, { recursive: true });
  // 删除项目源目录:dist 若含任何源码/项目路径依赖,异地启动立即失败
  fs.rmSync(penv, { recursive: true, force: true });
  const envICwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-env-i-cwd-'));
  const envILauncher = path.join(envIDist, 'ming-app.mjs');
  const envIMinimal = process.platform === 'win32'
    ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
    : { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  const runEnvI = (args57, minimal) => spawnSync(process.execPath, [envILauncher, ...args57], {
    encoding: 'utf8', cwd: envICwd, timeout: 60000, ...(minimal ? { env: envIMinimal } : {}),
  });
  const envIN1 = runEnvI(['--', 'arg1'], false);
  const envIM1 = runEnvI(['--', 'arg1'], true);
  check('v53.14:env -i launcher 异地 dist(删源 + 无关 cwd;最小环境与正常环境 stdout/退出码逐字一致)',
    benv.status === 0 && fs.existsSync(path.join(envIDist, 'app.bytecode.json')) && !fs.existsSync(path.join(envIDist, 'app.ming'))
    && envIN1.status === 0 && envIM1.status === 0 && envIM1.stdout === 'dist-ok\n1\narg1\n'
    && envIM1.stdout === envIN1.stdout && envIM1.status === envIN1.status,
    'build=' + benv.status + ' min=' + JSON.stringify(envIM1.stdout) + ' normal=' + JSON.stringify(envIN1.stdout) + ' codes=' + envIM1.status + '/' + envIN1.status + ' err=' + (envIM1.stderr ?? '').slice(0, 150));

  // 多字节 UTF-8 实参逐字透传(最小环境;单参避免触发上面的 panic 分支)
  const envIN2 = runEnvI(['--', '汉字😀'], false);
  const envIM2 = runEnvI(['--', '汉字😀'], true);
  check('v53.15:env -i 参数透传逐字(-- 剥离 + 多字节 UTF-8 实参)',
    envIN2.status === 0 && envIM2.status === 0 && envIM2.stdout === 'dist-ok\n1\n汉字😀\n'
    && envIM2.stdout === envIN2.stdout && envIM2.status === envIN2.status,
    'min=' + JSON.stringify(envIM2.stdout) + ' normal=' + JSON.stringify(envIN2.stdout) + ' codes=' + envIM2.status + '/' + envIN2.status);

  // panic 路径不依赖环境:exit 101 + stderr 首行逐字一致
  const firstLine53 = (s) => (s ?? '').split('\n')[0];
  const envIN3 = runEnvI(['--', 'a', 'panic'], false);
  const envIM3 = runEnvI(['--', 'a', 'panic'], true);
  check('v53.16:env -i panic 路径(exit 101;stderr 首行与正常环境逐字一致)',
    envIN3.status === 101 && envIM3.status === 101
    && firstLine53(envIM3.stderr) === firstLine53(envIN3.stderr)
    && firstLine53(envIM3.stderr).includes('M4001')
    && envIM3.stdout === envIN3.stdout,
    'codes=' + envIM3.status + '/' + envIN3.status + ' min=' + JSON.stringify(firstLine53(envIM3.stderr)) + ' normal=' + JSON.stringify(firstLine53(envIN3.stderr)));

  // ---------- D. v0.53 任务5:C 后端 str for-in 按 UTF-8 码点迭代 ----------
  // 黄金三组:ASCII/CJK/emoji;tree / VM / VM-only / cc 输出逐字一致。
  // 注:默认引擎的 wasm 腿对含 str for-in 的函数会整模块回落 JS VM(该形态不在 wasm
  // 资格面内),所以这里比较的是 VM 语义,不暗示 wasm 处理了 str for-in。
  // 无编译器时 C 腿自动跳过(与既有 C 腿测试同风格),JS 三引擎仍校验。
  const detectCC57 = () => {
    const candidates = [];
    if (process.env.MING_CC) candidates.push(process.env.MING_CC);
    candidates.push('gcc', 'clang', 'cc');
    for (const p of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
      if (fs.existsSync(p)) candidates.push(p);
    }
    for (const c of candidates) {
      try { const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15000 }); if (r.status === 0) return c; } catch { /* 试下一个 */ }
    }
    return null;
  };
  const ccBin57 = detectCC57();
  const ccOut57 = path.join(TMP, 'v53-cc-strfor');
  fs.mkdirSync(ccOut57, { recursive: true });
  const strForCases = [
    ['ascii', 'abc', '3'],
    ['cjk', '汉字', '2'],
    ['emoji', '😀a', '2'],
  ];
  let seq57 = 17;
  for (const [k57, lit57, want57] of strForCases) {
    const f57 = mingFile('v53-strfor-' + k57 + '.ming', [
      'fn count(s: str) -> i64 {',
      '    let mut v = 0;',
      '    for ch in s { v += ch.char_len() as i64; }',
      '    return v;',
      '}',
      'fn main() with io { print(str(count("' + lit57 + '"))); }',
      '',
    ].join('\n'));
    const rt57 = runMing(['run', f57, '--tree']);
    const rv57 = runMing(['run', f57]);
    const rn57 = runMing(['run', f57, '--no-wasm']);
    let ccOk57 = true;
    let ccDetail57 = '无编译器,跳过 C 腿';
    if (ccBin57) {
      const b57 = spawnSync(process.execPath, [MING, 'cc', f57, '--no-run', '--out', ccOut57], { encoding: 'utf8', timeout: 180000 });
      const exe57 = path.join(ccOut57, 'v53-strfor-' + k57 + (process.platform === 'win32' ? '.exe' : ''));
      const rc57 = b57.status === 0 && fs.existsSync(exe57) ? spawnSync(exe57, [], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stdout: '' };
      ccOk57 = b57.status === 0 && rc57.status === 0 && rc57.stdout === want57 + '\n';
      ccDetail57 = 'build=' + b57.status + ' cc=' + JSON.stringify(rc57.stdout) + ' stderr=' + (b57.stderr ?? '').slice(0, 150);
    }
    check('v53.' + seq57 + ':str for-in 码点迭代 ' + k57 + '(' + lit57 + '→' + want57 + ';tree / VM / VM-only / cc 逐字一致;wasm 腿为 VM 回落)',
      rt57.code === 0 && rv57.code === 0 && rn57.code === 0
      && rt57.stdout === want57 + '\n' && rv57.stdout === want57 + '\n' && rn57.stdout === want57 + '\n'
      && ccOk57,
      'tree=' + JSON.stringify(rt57.stdout) + ' vm=' + JSON.stringify(rv57.stdout) + ' nowasm=' + JSON.stringify(rn57.stdout) + ' ' + ccDetail57);
    seq57++;
  }

  // ---------- E. v0.53 任务1/6:CI workflow 结构与版本收口(静态)----------
  // 零依赖静态校验:不解析 YAML,只锁定结构关键行(与 .github/workflows/ci.yml 同步维护)。
  // 实际矩阵执行结果以 GitHub Actions 记录为准;本测试防的是"workflow 丢失/矩阵缩水/引入 npm"。
  const ciPath = path.join(ROOT, '.github', 'workflows', 'ci.yml');
  const ci = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, 'utf8') : '';
  const ciUses = [...ci.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)].map(m => m[1]);
  const ciHas = (s) => ci.includes(s);
  check('v53.20:CI workflow 结构(触发器/九组合/C 腿/nightly/官方 action/零 npm/timeout)',
    ci.length > 0
    && ciHas('push:') && ciHas('pull_request:') && ciHas('schedule:') && ciHas("cron: '17 3 * * *'")
    && ciHas('os: [ubuntu-latest, macos-latest, windows-latest]')
    && ciHas('node: [18, 20, 22]')
    && ciHas('c-backend:') && ciHas('os: [ubuntu-latest, macos-latest]')
    && ciHas('seed: [44044, 7, 2026]')
    && ciHas('node tests/run.mjs') && ciHas('--seed 44044 --count 25') && ciHas('--count 100')
    && ciHas('run examples/fib.ming --strict-wasm') // M9:CI 跑示例 strict(纯 Node,不依赖 gcc)
    && ciHas('--count 120') && ciHas('--count 300')
    && ciHas('timeout-minutes: 20') && ciHas('timeout-minutes: 40')
    && ciUses.length === 6 && ciUses.every(u => u === 'actions/checkout@v4' || u === 'actions/setup-node@v4')
    && !ciHas('npm install') && !ciHas('npm ci'),
    'exists=' + (ci.length > 0) + ' uses=' + JSON.stringify(ciUses));

  // 版本三处一致 + GUIDE 修订记录存在(与 package.json 动态比对,未来版本无需改测试)
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const binVersion = (fs.readFileSync(MING, 'utf8').match(/export const VERSION = '([^']+)'/) ?? [])[1];
  const guideText = fs.readFileSync(path.join(ROOT, 'GUIDE.md'), 'utf8');
  const guideHead = (guideText.match(/^\*\*版本:v([0-9.]+)\*\*/m) ?? [])[1];
  const guideRev = guideText.includes('### v' + pkgVersion + '(');
  check('v53.21:版本三处一致(package.json/bin VERSION/GUIDE 头)+ GUIDE 修订记录',
    pkgVersion === binVersion && binVersion === guideHead && guideRev,
    'pkg=' + pkgVersion + ' bin=' + binVersion + ' guide=' + guideHead + ' rev=' + guideRev);

  // 审查发现(v0.53 收口):strict wasm 暴露既有 wasm 模块校验回落——非 void 函数以尾表达式
  // 结束时,函数级兜底补零在返回值之后再压一个值 → 函数末尾 2 值 → 整模块 "expected 1
  // elements on the stack for fallthru, found 2" → 静默回落。修复见 src/wasm.js emitBodyOnce。
  const tailProg = mingFile('v53-wasm-tail.ming', [
    'fn count(n: i64) -> i64 {',
    '    let mut i = 0;',
    '    while i < n { i += 1; }',
    '    i',
    '}',
    'fn main() with io { print(str(count(7))); }',
  ].join('\n'));
  const tailStrict = runMing(['run', tailProg, '--strict-wasm', '--json']);
  const tailJson = JSON.parse(tailStrict.stdout);
  check('v53.22:尾表达式函数 wasm 模块有效(strict ok;函数级补零不再多压栈)',
    tailStrict.code === 0 && tailJson.wasm_status === 'ok' && tailJson.stdout === '7\n',
    'code=' + tailStrict.code + ' status=' + tailJson.wasm_status + ' stdout=' + JSON.stringify(tailJson.stdout));

  // ---------- F. v0.53.0 独立审查修复回归(2026-11-12)----------
  // B2:check --strict-wasm 的 fallback 与正常路径共用同一 out 构造——ok:false、
  // diagnostics(含 warning)与 --proof-report 的 proofs 都不能丢。
  const pfProg = mingFile('v53-proof-fb.ming', [
    'fn pick(buf: Vec[i64], i: i64) -> i64 requires i >= 0 && i < buf.len() {',
    '    return buf[i];',
    '}',
    'fn eqf(x: f64) -> bool { return x == 1.0; }',
    'fn g(x: f64) -> f64 { let mut y = x; y += 1.0; return y; }',
    'fn main() with io { print(str(pick([10, 20, 30], 1))); print(str(g(1.5))); }',
  ].join('\n'));
  const pfR = runMing(['check', pfProg, '--proof-report', '--json', '--strict-wasm']);
  const pfJ = JSON.parse(pfR.stdout);
  const pfT = runMing(['check', pfProg, '--proof-report', '--strict-wasm']);
  check('v53.23:check --strict-wasm fallback JSON 保留 ok:false/diagnostics/proofs(exit 2)',
    pfR.code === 2 && pfJ.ok === false && Array.isArray(pfJ.diagnostics) && pfJ.diagnostics.some(d => d.code === 'W3102')
    && pfJ.wasm_status === 'fallback' && pfJ.proofs?.summary?.proven === 1 && pfJ.proofs.functions[0]?.fn === 'pick'
    && pfT.code === 2 && (pfT.stdout ?? '').includes('pick: 义务 1') && (pfT.stderr ?? '').includes('W3102')
    && (pfT.stderr ?? '').includes('wasm 编译回落(g)'),
    'code=' + pfR.code + ' json=' + JSON.stringify(pfJ).slice(0, 320) + ' text=' + JSON.stringify((pfT.stdout ?? '').slice(0, 200)));

  // M1:--no-wasm 时 wasm 层未参与执行,JSON 不得再报 wasm_status(否则被误读为 wasm 已跑过)。
  const nowasmRun = runMing(['run', okProg, '--json', '--no-wasm']);
  const nowasmJson = JSON.parse(nowasmRun.stdout);
  check('v53.24:run --json --no-wasm 不输出 wasm_status(wasm 层未参与执行)',
    nowasmRun.code === 0 && nowasmJson.wasm === false && nowasmJson.stdout === '55\n' && !('wasm_status' in nowasmJson)
    && JSON.stringify(Object.keys(nowasmJson).sort()) === JSON.stringify(['engine', 'exit_code', 'ms', 'ok', 'stderr', 'stdout', 'wasm']),
    'keys=' + JSON.stringify(Object.keys(nowasmJson).sort()) + ' status=' + JSON.stringify(nowasmJson.wasm_status));

  // M2(v0.59 翻转):#45 修复后值型 if 的 blocktype 按单字节 valtype 发射,strict 下真实
  // 经 wasm 执行(不再回落点名 pick)。断言改为:strict --json wasm_status=ok,调试输出
  // 有 "[wasm] fn pick OK" 且无实例化失败;--json 键集与 v53.1 固化口径一致(additive
  // wasm_status,不新增/丢失键)。
  const ifExprProg = mingFile('v53-wasm-ifexpr.ming', [
    'fn pick(n: i64) -> i64 { let x = if n > 0 { 1 } else { 2 }; return x; }',
    'fn main() with io { print(str(pick(3))); }',
  ].join('\n'));
  const ifJson = JSON.parse(runMing(['run', ifExprProg, '--strict-wasm', '--json']).stdout);
  const ifDbg = runMing(['run', ifExprProg, '--strict-wasm'], { env: { MING_WASM_DEBUG: '1' } });
  check('v53.25:if 表达式 strict ok(wasm_status=ok;[wasm] fn pick OK,无实例化失败)',
    ifJson.exit_code === 0 && ifJson.wasm_status === 'ok' && ifJson.stdout === '1\n'
    && JSON.stringify(Object.keys(ifJson).sort()) === JSON.stringify(['engine', 'exit_code', 'ms', 'ok', 'stderr', 'stdout', 'wasm', 'wasm_status'])
    && ifDbg.code === 0 && (ifDbg.stderr ?? '').includes('[wasm] fn pick OK') && !(ifDbg.stderr ?? '').includes('实例化失败'),
    'code=' + ifDbg.code + ' status=' + ifJson.wasm_status + ' dbg=' + JSON.stringify((ifDbg.stderr ?? '').slice(0, 240)));

  // M9:示例 fib 的 strict 门禁必须证明 wasm 真的执行了(不能只信 wasm_status 自报):
  // MING_WASM_DEBUG=1 下 stderr 含 "[wasm] fn fib OK" 且无 "实例化失败";CI test job 跑同一命令。
  const fibPath = path.join(ROOT, 'examples', 'fib.ming');
  const fibStrict = runMing(['run', fibPath, '--strict-wasm', '--json']);
  const fibJ = JSON.parse(fibStrict.stdout);
  const fibDbg = runMing(['run', fibPath, '--strict-wasm'], { env: { MING_WASM_DEBUG: '1' } });
  check('v53.26:fib strict ok 且真实经 wasm 执行([wasm] fn fib OK,无实例化失败)',
    fibStrict.code === 0 && fibJ.wasm_status === 'ok'
    && fibDbg.code === 0 && (fibDbg.stderr ?? '').includes('[wasm] fn fib OK') && !(fibDbg.stderr ?? '').includes('实例化失败'),
    'code=' + fibStrict.code + ' status=' + fibJ.wasm_status + ' dbg=' + JSON.stringify((fibDbg.stderr ?? '').slice(0, 200)));

  // B3:C 后端 for-in 循环变量的作用域泄漏——遮蔽外层同名变量时此前在函数作用域
  // declare(v_ch_2)导致块外引用非法 C。v0.56 起 tree 的 for-in 遮蔽泄漏(#23)已修,
  // 本用例把 tree 一并纳入断言(四路逐字一致)。
  const ccRunF = (f) => {
    const b = spawnSync(process.execPath, [MING, 'cc', f, '--no-run', '--out', ccOut57], { encoding: 'utf8', timeout: 180000 });
    const exe = path.join(ccOut57, path.basename(f).replace(/\.ming$/i, '') + (process.platform === 'win32' ? '.exe' : ''));
    const r = b.status === 0 && fs.existsSync(exe) ? spawnSync(exe, [], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stdout: '', stderr: '' };
    return { build: b.status, code: r.status, stdout: r.stdout ?? '', stderr: (b.stderr ?? '') + (r.stderr ?? '') };
  };
  const shadowCases = [
    ['str', [
      'fn probe(s: str) -> i64 {',
      '    let ch = "汉字";',
      '    let mut acc = 0;',
      '    for ch in s { acc += ch.char_len() as i64; }',
      '    return ch.char_len() as i64 * 10 + acc;',
      '}',
      'fn main() with io { print(str(probe("abc"))); }',
    ].join('\n'), '23'],
    ['vec', [
      'fn probe(v: Vec[i64]) -> i64 {',
      '    let x = 99;',
      '    let mut acc = 0;',
      '    for x in v { acc += x; }',
      '    return x + acc;',
      '}',
      'fn main() with io { print(str(probe([1, 2, 3]))); }',
    ].join('\n'), '105'],
    ['map', [
      'fn probe(m: Map[str, i64]) -> i64 {',
      '    let k = "z";',
      '    let mut acc = 0;',
      '    for (k, v) in m { acc += v; }',
      '    return k.char_len() as i64 + acc;',
      '}',
      'fn main() with io { print(str(probe({"a": 1, "b": 2}))); }',
    ].join('\n'), '4'],
    ['range', [
      'fn probe() -> i64 {',
      '    let i = 100;',
      '    for i in 0..3 { }',
      '    return i;',
      '}',
      'fn main() with io { print(str(probe())); }',
    ].join('\n'), '100'],
  ];
  let shadowOk = true;
  const shadowDetail = [];
  for (const [kind, src, want] of shadowCases) {
    const f = mingFile('v53-shadow-' + kind + '.ming', src);
    const vmR = runMing(['run', f]);
    const treeR = runMing(['run', f, '--tree']);
    const noR = runMing(['run', f, '--no-wasm']);
    const ccR = ccBin57 ? ccRunF(f) : null;
    shadowOk = shadowOk && vmR.code === 0 && vmR.stdout === want + '\n'
      && treeR.code === 0 && treeR.stdout === want + '\n'
      && noR.code === 0 && noR.stdout === want + '\n'
      && (!ccR || (ccR.build === 0 && ccR.code === 0 && ccR.stdout === want + '\n'));
    shadowDetail.push(kind + ':vm=' + JSON.stringify(vmR.stdout) + ',tree=' + JSON.stringify(treeR.stdout)
      + ',no=' + JSON.stringify(noR.stdout) + (ccR ? ',cc=' + JSON.stringify(ccR.stdout) + '/b' + ccR.build : ',cc=skip'));
  }
  check('v53.27:C for-in 遮蔽作用域(tree 已随 #23 修复;VM / tree / VM-only / cc 一致)', shadowOk, shadowDetail.join(' '));

  // M12:wasm `/` 守卫修复(0x83 i64.and → 0x71 i32.and,并把 if 移到两个比较之后)。
  // 修复前任何含 / 的 eligible 函数整模块校验失败 → 静默回落 JS VM。
  const divCases = mingFile('v53-div-cases.ming', [
    'fn dv(a: i64, b: i64) -> i64 { return a / b; }',
    'fn main() with io { print(str(dv(7, 2))); print(str(dv(-7, 2))); print(str(dv(7, -2))); print(str(dv(-7, -2))); }',
  ].join('\n'));
  const dvStrict = runMing(['run', divCases, '--strict-wasm', '--json']);
  const dvJ = JSON.parse(dvStrict.stdout);
  const dvTree = runMing(['run', divCases, '--tree']);
  const dvNo = runMing(['run', divCases, '--no-wasm']);
  const dvCc = ccBin57 ? ccRunF(divCases) : null;
  const dvWant = '3\n-3\n-3\n3\n';
  check('v53.28:eligible 含 / 的函数 strict ok 且 tree/VM/VM-only/cc 一致(i32.and 修复)',
    dvStrict.code === 0 && dvJ.wasm_status === 'ok' && dvJ.stdout === dvWant
    && dvTree.stdout === dvWant && dvNo.stdout === dvWant && (!dvCc || (dvCc.build === 0 && dvCc.stdout === dvWant)),
    'strict=' + dvStrict.code + '/' + dvJ.wasm_status + ' json=' + JSON.stringify(dvJ.stdout) + ' tree=' + JSON.stringify(dvTree.stdout) + ' no=' + JSON.stringify(dvNo.stdout) + ' cc=' + JSON.stringify(dvCc && dvCc.stdout));

  // 守卫回归:零除 M4004、min/-1 M4002 在 wasm 执行路径仍是 panic(exit 101)。
  const divZero = mingFile('v53-div-zero.ming', 'fn dv(a: i64, b: i64) -> i64 { return a / b; }\nfn main() with io { print(str(dv(10, 0))); }\n');
  const divOvf = mingFile('v53-div-ovf.ming', 'fn dv(a: i64, b: i64) -> i64 { return a / b; }\nfn main() with io { print(str(dv(-9223372036854775807 - 1, -1))); }\n');
  const dz = runMing(['run', divZero, '--strict-wasm']);
  const dovf = runMing(['run', divOvf, '--strict-wasm']);
  check('v53.29:/ 的零除与 min/-1 守卫仍在(M4004/M4002,exit 101;wasm 执行路径)',
    dz.code === 101 && (dz.stderr ?? '').includes('M4004') && dovf.code === 101 && (dovf.stderr ?? '').includes('M4002'),
    'dz=' + dz.code + ' stderr=' + JSON.stringify((dz.stderr ?? '').slice(0, 90)) + ' ovf=' + dovf.code + ' stderr=' + JSON.stringify((dovf.stderr ?? '').slice(0, 90)));

  // M6:夹具默认剥离 MING_WASM_STRICT——开发者 shell 导出该变量不该让非 strict 用例假失败;
  // 需要 strict 的用例显式注入 env(见 v53.1/v53.5)。
  const savedShellStrict = process.env.MING_WASM_STRICT;
  process.env.MING_WASM_STRICT = '1';
  const shellStrictIgnored = runMing(['run', fbProg]);
  if (savedShellStrict === undefined) delete process.env.MING_WASM_STRICT; else process.env.MING_WASM_STRICT = savedShellStrict;
  const injectedStrict = runMing(['run', fbProg], { env: { MING_WASM_STRICT: '1' } });
  check('v53.30:夹具默认剥离 MING_WASM_STRICT(shell 导出不致假失败;显式注入仍生效)',
    shellStrictIgnored.code === 0 && shellStrictIgnored.stdout === '2.5\n'
    && injectedStrict.code === 2 && (injectedStrict.stderr ?? '').includes('wasm 编译回落(g)'),
    'shell=' + shellStrictIgnored.code + '/' + JSON.stringify(shellStrictIgnored.stdout) + ' injected=' + injectedStrict.code);

  // M7:build --json 的 stdout 为纯 JSON(人读"产物:"行改走 stderr),可直接 JSON.parse。
  const pureB = build53(pn, ['--clean-cache']);
  const pureJ = JSON.parse(pureB.stdout);
  check('v53.31:build --json stdout 纯 JSON(人读产物行改走 stderr)',
    pureB.status === 0 && pureB.stdout.trim().startsWith('{') && pureB.stdout.trim().endsWith('}')
    && (pureB.stderr ?? '').includes('产物:dist/') && pureJ.ok === true && pureJ.cache_hit === false && typeof pureJ.build_key === 'string',
    'status=' + pureB.status + ' head=' + JSON.stringify((pureB.stdout ?? '').slice(0, 20)) + ' stderr=' + JSON.stringify((pureB.stderr ?? '').slice(0, 120)));
}

// ===================== 58. v0.54:with unsafe 最小实现(类型/语法/检查器/效果门禁/C5)=====================
// 14 项:v58.1-6 类型面/禁止面/门禁/黄金+三路 M4016;v58.7-11 C5 黄金/emit-c/alloc 失败/build 回退/既有 C 不变;
// v58.12-14 Ptr 别名面/offset 链式 C 黄金/unsafe 效果传播。
{
  const dir = path.join(TMP, 'v54unsafe');
  fs.mkdirSync(dir, { recursive: true });
  const mkU = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };

  // 1) 类型面/方法面正向:Ptr[mut u8] + Ptr[u8] 解析、四条方法、块外 let/return 传递与 is_null
  const okU = mkU('types_ok.ming', [
    'fn ro(p: Ptr[u8]) -> bool {',
    '    return p.is_null();',
    '}',
    '',
    'fn peek(p: Ptr[mut u8]) -> bool {',
    '    let q = p;',
    '    return q.is_null();',
    '}',
    '',
    'fn main() with io, unsafe {',
    '    unsafe {',
    '        let p: Ptr[mut u8] = std.mem.alloc(2);',
    '        p.store(65);',
    '        p.offset(1).store(66);',
    '        let first = p.load();',
    '        let second = p.offset(1).load();',
    '        let empty = p.is_null();',
    '        let same = peek(p);',
    '        print(str(first));',
    '        print(str(second));',
    '        print(str(empty));',
    '        print(str(same));',
    '        std.mem.free(p);',
    '    }',
    '}',
    '',
  ].join('\n'));
  const rOkU = runMing(['check', okU]);
  check('v58.1:Ptr[mut u8]/Ptr[u8] 解析 + load/store/offset/is_null + 块外 let/is_null 允许(check 0 诊断)',
    rOkU.code === 0 && (rOkU.stderr ?? '') === '', 'code=' + rOkU.code + ' stderr=' + (rOkU.stderr ?? '').slice(0, 300));

  // 2) 类型面负向:unify 拒绝 mut 错配、Ptr 元素仅 u8、只读 Ptr 不可 store(typeStr 逐字出现)
  const tyU = mkU('types_neg.ming', [
    'fn ro(p: Ptr[u8]) with unsafe {',
    '    unsafe {',
    '        p.store(1);',
    '    }',
    '}',
    '',
    'fn main() with io, unsafe {',
    '    unsafe {',
    '        let p = std.mem.alloc(1);',
    '        let q: Ptr[u8] = p;',
    '        let bad: Ptr[i64] = p;',
    '        print(str(q.is_null()));',
    '        print(str(bad.is_null()));',
    '        std.mem.free(p);',
    '    }',
    '}',
    '',
  ].join('\n'));
  const rTyU = runMing(['check', tyU]);
  const tyErr = rTyU.stderr ?? '';
  check('v58.2:Ptr 类型负向(mut 错配 unify 拒绝 + 元素仅 u8 + 只读不可 store;typeStr 为 Ptr[mut u8]/Ptr[u8])',
    rTyU.code === 1 && tyErr.includes('M3002') && tyErr.includes('Ptr[mut u8]') && tyErr.includes('Ptr[u8]')
    && tyErr.includes('只支持 u8') && tyErr.includes('只读指针,不能 store'),
    'code=' + rTyU.code + ' stderr=' + tyErr.slice(0, 500));

  // 3) 禁止面:索引/算术/==/插值/打印/debug/JSON/Map 键/as 全部静态拒绝
  const badU = mkU('surfaces.ming', [
    'fn main() with io, unsafe {',
    '    unsafe {',
    '        let p = std.mem.alloc(1);',
    '        let _ = p[0];',
    '        let _ = p + 1;',
    '        let _ = p == p;',
    '        let _ = "\\{p}";',
    '        print(str(p));',
    '        debug(p);',
    '        std.json.stringify(p);',
    '        let _m: Map[Ptr[u8], i64] = [:];',
    '        let _ = p as i64;',
    '    }',
    '}',
    '',
  ].join('\n'));
  const rBadU = runMing(['check', badU]);
  const badErr = rBadU.stderr ?? '';
  check('v58.3:Ptr 禁止面(M3020 索引 / M3008 算术与== / M3012 插值 / M3002 打印与 debug / M3033 JSON / M3044 Map 键 / M3019 as)',
    rBadU.code === 1 && ['M3020', 'M3008', 'M3012', 'M3002', 'M3033', 'M3044', 'M3019'].every((c) => badErr.includes(c))
    && badErr.includes('Ptr 不支持 "=="') && badErr.includes('不能传给 debug'),
    'code=' + rBadU.code + ' codes=' + ['M3020', 'M3008', 'M3012', 'M3002', 'M3033', 'M3044', 'M3019'].map((c) => c + ':' + badErr.includes(c)).join(',') + ' stderr=' + badErr.slice(0, 400));

  // 4) unsafe 块必须位于声明 with unsafe 的函数内(M3029,沿用效果码)
  const noEffU = mkU('no_effect.ming', [
    'fn main() with io {',
    '    unsafe {',
    '    }',
    '}',
    '',
  ].join('\n'));
  const rNoEffU = runMing(['check', noEffU]);
  check('v58.4:unsafe 块缺 with unsafe → M3029(消息含 [unsafe])',
    rNoEffU.code === 1 && (rNoEffU.stderr ?? '').includes('M3029') && (rNoEffU.stderr ?? '').includes('[unsafe]')
    && (rNoEffU.stderr ?? '').includes('with unsafe'),
    'code=' + rNoEffU.code + ' stderr=' + (rNoEffU.stderr ?? '').slice(0, 300));

  // 5) 指针操作/Ptr 实参在块外 → M3046(load 调用 + 传参两处;块外 let/return/is_null 不报)
  const outU = mkU('outside.ming', [
    'fn take(p: Ptr[u8]) -> () {',
    '}',
    '',
    'fn load_out(p: Ptr[u8]) -> u8 {',
    '    return p.load();',
    '}',
    '',
    'fn pass_out(p: Ptr[u8]) -> () {',
    '    take(p);',
    '}',
    '',
    'fn ok_out(p: Ptr[u8]) -> bool {',
    '    let q = p;',
    '    return q.is_null();',
    '}',
    '',
  ].join('\n'));
  const rOutU = runMing(['check', outU]);
  const outErr = rOutU.stderr ?? '';
  check('v58.5:块外指针操作/Ptr 传参 → M3046(2 处;load 与 take;ok_out 的 let/is_null 不报)',
    rOutU.code === 1 && (outErr.match(/M3046/g) ?? []).length === 2
    && outErr.includes('指针操作 ".load()"') && outErr.includes('函数 "take"'),
    'code=' + rOutU.code + ' M3046=' + (outErr.match(/M3046/g) ?? []).length + ' stderr=' + outErr.slice(0, 400));

  // 6) 黄金示例:check 0 诊断;tree/VM/wasm 回落三路 M4016 逐字一致(exit 101)
  const exU = path.join(ROOT, 'examples', 'unsafe_demo.ming');
  const chkU = runMing(['check', exU]);
  const trU = runMing(['run', exU, '--tree']);
  const vmU = runMing(['run', exU, '--no-wasm']);
  const wmU = runMing(['run', exU]); // with unsafe 不进 wasm 资格面 → 回落 VM,同一 M4016
  const firstLineU = (s) => (s ?? '').split('\n')[0];
  const msgU = 'unsafe 指针操作仅在 C 原生后端可用';
  check('v58.6:examples/unsafe_demo.ming check 0 诊断;tree/VM/wasm 回落 exit 101 + M4016 首行逐字一致',
    chkU.code === 0 && (chkU.stderr ?? '') === ''
    && trU.code === 101 && vmU.code === 101 && wmU.code === 101
    && firstLineU(trU.stderr) === firstLineU(vmU.stderr) && firstLineU(vmU.stderr) === firstLineU(wmU.stderr)
    && firstLineU(trU.stderr).includes('M4016[native-only-feature]') && firstLineU(trU.stderr).includes(msgU)
    && trU.stdout === '' && vmU.stdout === '' && wmU.stdout === '',
    'check=' + chkU.code + '/' + JSON.stringify((chkU.stderr ?? '').slice(0, 120))
    + ' tree=' + trU.code + ' vm=' + vmU.code + ' wasm=' + wmU.code
    + ' first=' + JSON.stringify(firstLineU(trU.stderr)));

  // ---------- 阶段 2(v0.54/C5):C 原生后端(Ptr → unsigned char*/const unsigned char*) ----------
  const detectCC58 = () => {
    const candidates = [];
    if (process.env.MING_CC) candidates.push(process.env.MING_CC);
    candidates.push('gcc', 'clang', 'cc');
    for (const p of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
      if (fs.existsSync(p)) candidates.push(p);
    }
    for (const c of candidates) {
      try { const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15000 }); if (r.status === 0) return c; } catch { /* 试下一个 */ }
    }
    return null;
  };
  const hasCC58 = !!detectCC58();
  const ccRun58 = (file, out) => spawnSync(process.execPath, [MING, 'cc', file, '--out', out], { encoding: 'utf8', timeout: 180000 });
  const readC58 = (d) => fs.readdirSync(d).filter(x => x.endsWith('.c')).map(x => fs.readFileSync(path.join(d, x), 'utf8')).join('\n');

  // 7) C5 黄金:alloc 2 字节 → store 65 at 0 / 66 at offset 1 → load 两条打印(u8 提升 i64)
  if (hasCC58) {
    const cg = ccRun58(exU, path.join(dir, 'c5-golden'));
    check('v58.7:C5 黄金 examples/unsafe_demo.ming(cc 实跑 65/66/false,exit 0)',
      cg.status === 0 && cg.stdout === '65\n66\nfalse\n' && (cg.stderr ?? '') === '',
      'status=' + cg.status + ' stdout=' + JSON.stringify(cg.stdout) + ' stderr=' + JSON.stringify((cg.stderr ?? '').slice(0, 160)));
  } else {
    check('v58.7:C5 黄金(无编译器,跳过)', true);
  }

  // 8) emit-c 符号:Ptr[mut u8] → unsigned char*;Ptr[u8] → const unsigned char*(extern 槽直接传裸地址)
  const emDir = path.join(dir, 'c5-emit');
  const em = spawnSync(process.execPath, [MING, 'cc', exU, '--emit-c', '--out', emDir], { encoding: 'utf8', timeout: 60000 });
  const emSrc = readC58(emDir);
  const roU = mkU('ro_slot.ming', [
    'extern "msvcrt" fn memchr(s: Ptr[u8], c: i64, n: i64) -> Ptr[u8];',
    '',
    'fn main() with io, unsafe {',
    '    unsafe {',
    '        let p = std.mem.alloc(1);',
    '        std.mem.free(p);',
    '    }',
    '}',
    '',
  ].join('\n'));
  const roDir = path.join(dir, 'c5-emit-ro');
  const roEm = spawnSync(process.execPath, [MING, 'cc', roU, '--emit-c', '--out', roDir], { encoding: 'utf8', timeout: 60000 });
  const roSrc = readC58(roDir);
  check('v58.8:emit-c 含 unsigned char*/malloc/free;Ptr[u8] extern 槽为 const unsigned char*(裸地址直传)',
    em.status === 0 && emSrc.includes('unsigned char*') && emSrc.includes('malloc(') && emSrc.includes('free(')
    && emSrc.includes('ming_mem_alloc(') && roEm.status === 0
    && roSrc.includes('static const unsigned char* (*ming_ffi_memchr)(const unsigned char*, long long, long long)'),
    'emit=' + em.status + ' ro=' + roEm.status + ' markers=' + ['unsigned char*', 'malloc(', 'free(', 'ming_mem_alloc('].map(k => k + ':' + emSrc.includes(k)).join(',')
    + ' slot=' + roSrc.includes('const unsigned char* (*ming_ffi_memchr)'));

  // 9) alloc 失败语义:malloc 返回 NULL 不伪装 null → M4011 panic + exit 101(负长度必失败)
  if (hasCC58) {
    const oomU = mkU('oom_alloc.ming', [
      'fn main() with io, unsafe {',
      '    unsafe {',
      '        let p = std.mem.alloc(-1);',
      '        print(str(p.is_null()));',
      '        std.mem.free(p);',
      '    }',
      '}',
      '',
    ].join('\n'));
    const oom = ccRun58(oomU, path.join(dir, 'c5-oom'));
    const oomFirst = (oom.stderr ?? '').split('\n')[0];
    check('v58.9:std.mem.alloc 失败(malloc 返回 NULL)→ M4011 首行 + exit 101(不伪装 null)',
      oom.status === 101 && oom.stdout === ''
      && oomFirst.includes('M4011[alloc-quota-exceeded]') && oomFirst.includes('内存分配失败')
      && oomFirst.includes('std.mem.alloc(-1)') && oomFirst.includes('返回 NULL'),
      'status=' + oom.status + ' stdout=' + JSON.stringify(oom.stdout) + ' first=' + JSON.stringify(oomFirst));
  } else {
    check('v58.9:std.mem.alloc 失败语义(无编译器,跳过)', true);
  }

  // 10) ming build 遇 with unsafe:AOT 显式回退源码模式并说明原因(不产出字节码产物)
  const bp = path.join(dir, 'c5-build');
  fs.mkdirSync(bp, { recursive: true });
  fs.writeFileSync(path.join(bp, 'ming.toml'), '[project]\nname = "c5build"\nversion = "0.1.0"\nentry = "app.ming"\n');
  fs.copyFileSync(exU, path.join(bp, 'app.ming'));
  const bld = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: bp, timeout: 120000 });
  check('v58.10:ming build 遇 with unsafe 显式回退源码模式(AOT 不可用 + 原因;无 app.bytecode.json)',
    bld.status === 0 && (bld.stderr ?? '').includes('AOT 不可用')
    && (bld.stderr ?? '').includes('with unsafe') && (bld.stderr ?? '').includes('已回退源码模式')
    && fs.existsSync(path.join(bp, 'dist', 'app.ming')) && !fs.existsSync(path.join(bp, 'dist', 'app.bytecode.json')),
    'status=' + bld.status + ' stderr=' + JSON.stringify((bld.stderr ?? '').slice(0, 200)));

  // 11) 既有 C 输出不变抽查:非 unsafe 程序不发射 ming_mem_alloc/unsafe;cc 与 VM 输出一致
  const baseU = mkU('c5_baseline.ming', [
    'fn add(a: i64, b: i64) -> i64 { return a + b; }',
    'fn main() with io {',
    '    let mut v = [1, 2, 3];',
    '    v.push(4);',
    '    let m = {"a": 1, "b": 2};',
    '    print(str(add(v[0], m["b"])));',
    '    print(str(1.5 + 2.0));',
    '    print("ab".replace("b", "c"));',
    '}',
    '',
  ].join('\n'));
  const baseEmDir = path.join(dir, 'c5-baseline-emit');
  const baseEm = spawnSync(process.execPath, [MING, 'cc', baseU, '--emit-c', '--out', baseEmDir], { encoding: 'utf8', timeout: 60000 });
  const baseSrc = readC58(baseEmDir);
  const baseJs = runMing(['run', baseU]);
  // v0.54 审查 M4:字节级回归——固定非 unsafe 程序的渲染后 C 内容指纹。
  // 源文件是绝对路径,发射的 C 会把它写进 panic 位置字符串;先归一化为 <file>,
  // 使指纹跨机器/跨 OS 稳定(相对路径运行与归一化后的绝对路径运行逐字节相同)。
  const baseAbsEsc = baseU.split('\\').join('\\\\');
  const baseNorm = baseSrc.split(baseAbsEsc).join('<file>').split(baseU).join('<file>');
  const baseSha = createHash('sha256').update(baseNorm, 'utf8').digest('hex');
  const BASE_C_SHA = 'c62b5c0d13435318b676258ce2885a356c0ce763523e88c03c64bd68daf162ab';
  if (hasCC58) {
    const baseC = ccRun58(baseU, path.join(dir, 'c5-baseline-run'));
    check('v58.11:既有 C 输出不变抽查(非 unsafe 程序不发射 ming_mem_alloc/std.mem;cc 输出与 VM 逐字一致;渲染 C 指纹逐字节不变)',
      baseEm.status === 0 && !baseSrc.includes('ming_mem_alloc') && !baseSrc.includes('std.mem')
      && baseJs.code === 0 && baseC.status === 0 && baseC.stdout === baseJs.stdout
      && baseSha === BASE_C_SHA,
      'emit=' + baseEm.status + ' markers=' + baseSrc.includes('ming_mem_alloc') + '/' + baseSrc.includes('std.mem')
      + ' js=' + JSON.stringify(baseJs.stdout) + ' cc=' + JSON.stringify((baseC.stdout ?? '').slice(0, 120))
      + ' sha=' + baseSha);
  } else {
    check('v58.11:既有 C 输出不变抽查(无编译器,仅查发射无新增符号 + 渲染 C 指纹)',
      baseEm.status === 0 && !baseSrc.includes('ming_mem_alloc') && !baseSrc.includes('std.mem')
      && baseSha === BASE_C_SHA,
      'emit=' + baseEm.status + ' markers=' + baseSrc.includes('ming_mem_alloc') + '/' + baseSrc.includes('std.mem')
      + ' sha=' + baseSha);
  }

  // 12) Ptr 值语义/别名面:C5 明示"值拷贝的是地址本身,不是内存"——同一地址的两个 Ptr 变量,
  //     经 a.store 后 b.load 可见(C 侧断言;tree/VM 在 alloc 处即 M4016,不可能观察该语义)
  const aliasU = mkU('alias.ming', [
    'fn main() with io, unsafe {',
    '    unsafe {',
    '        let a = std.mem.alloc(1);',
    '        let b = a;',
    '        a.store(7);',
    '        print(str(b.load()));',
    '        std.mem.free(a);',
    '    }',
    '}',
    '',
  ].join('\n'));
  const aliasChk = runMing(['check', aliasU]);
  const aliasTree = runMing(['run', aliasU, '--tree']);
  const aliasFirst = (aliasTree.stderr ?? '').split('\n')[0];
  if (hasCC58) {
    const aliasRun = ccRun58(aliasU, path.join(dir, 'c5-alias'));
    check('v58.12:Ptr 值语义/别名面(值拷贝 = 地址本身;a.store 后 b.load 可见;C 侧 7;tree M4016)',
      aliasChk.code === 0 && (aliasChk.stderr ?? '') === ''
      && aliasRun.status === 0 && aliasRun.stdout === '7\n' && (aliasRun.stderr ?? '') === ''
      && aliasTree.code === 101 && aliasFirst.includes('M4016[native-only-feature]'),
      'check=' + aliasChk.code + ' cc=' + aliasRun.status + '/' + JSON.stringify(aliasRun.stdout)
      + ' tree=' + aliasTree.code + ' first=' + JSON.stringify(aliasFirst));
  } else {
    check('v58.12:Ptr 值语义/别名面(无编译器:仅 check 0 诊断 + tree M4016)',
      aliasChk.code === 0 && aliasTree.code === 101 && aliasFirst.includes('M4016[native-only-feature]'),
      'check=' + aliasChk.code + ' tree=' + aliasTree.code + ' first=' + JSON.stringify(aliasFirst));
  }

  // 13) offset 链式与边界内访问:C 黄金 10/30/30(仍用 3 字节分配,不越界)
  const chainU = mkU('offset_chain.ming', [
    'fn main() with io, unsafe {',
    '    unsafe {',
    '        let p = std.mem.alloc(3);',
    '        p.store(10);',
    '        p.offset(1).store(20);',
    '        p.offset(1).offset(1).store(30);',
    '        print(str(p.load()));',
    '        print(str(p.offset(2).load()));',
    '        print(str(p.offset(1).offset(1).load()));',
    '        std.mem.free(p);',
    '    }',
    '}',
    '',
  ].join('\n'));
  const chainChk = runMing(['check', chainU]);
  if (hasCC58) {
    const chainRun = ccRun58(chainU, path.join(dir, 'c5-chain'));
    check('v58.13:offset 链式(p.offset(1).offset(1).load())与边界内访问的 C 黄金(10/30/30)',
      chainChk.code === 0 && (chainChk.stderr ?? '') === ''
      && chainRun.status === 0 && chainRun.stdout === '10\n30\n30\n' && (chainRun.stderr ?? '') === '',
      'check=' + chainChk.code + ' cc=' + chainRun.status + '/' + JSON.stringify(chainRun.stdout));
  } else {
    check('v58.13:offset 链式(无编译器:仅 check 0 诊断)', chainChk.code === 0 && (chainChk.stderr ?? '') === '',
      'check=' + chainChk.code + ' stderr=' + JSON.stringify((chainChk.stderr ?? '').slice(0, 160)));
  }

  // 14) unsafe 效果传播:纯函数调用 with unsafe 函数 → M3029(效果名 unsafe);调用方声明后通过
  const propBadU = mkU('prop_bad.ming', [
    'fn danger(x: i64) -> i64 with unsafe {',
    '    unsafe {',
    '        let p = std.mem.alloc(1);',
    '        p.store(42);',
    '        std.mem.free(p);',
    '    }',
    '    return x + 1;',
    '}',
    '',
    'fn pure_caller(x: i64) -> i64 {',
    '    return danger(x);',
    '}',
    '',
    'fn main() with io {',
    '    print(str(pure_caller(3)));',
    '}',
    '',
  ].join('\n'));
  const propOkU = mkU('prop_ok.ming', [
    'fn danger(x: i64) -> i64 with unsafe {',
    '    unsafe {',
    '        let p = std.mem.alloc(1);',
    '        p.store(42);',
    '        std.mem.free(p);',
    '    }',
    '    return x + 1;',
    '}',
    '',
    'fn wrapper(x: i64) -> i64 with unsafe {',
    '    return danger(x);',
    '}',
    '',
    'fn main() with io, unsafe {',
    '    print(str(wrapper(3)));',
    '}',
    '',
  ].join('\n'));
  const propBadR = runMing(['check', propBadU]);
  const propOkR = runMing(['check', propOkU]);
  const propBadErr = propBadR.stderr ?? '';
  check('v58.14:unsafe 效果传播(纯函数调用 with unsafe → M3029 [unsafe];调用方声明后 0 诊断)',
    propBadR.code === 1 && (propBadErr.match(/M3029/g) ?? []).length === 1
    && propBadErr.includes('需要效果 [unsafe]') && propBadErr.includes('"pure_caller"') && propBadErr.includes('[纯函数]')
    && propOkR.code === 0 && (propOkR.stderr ?? '') === '',
    'bad=' + propBadR.code + ' M3029=' + (propBadErr.match(/M3029/g) ?? []).length + ' ok=' + propOkR.code
    + ' stderr=' + propBadErr.slice(0, 300));

  // ---------- 阶段 3(v0.54.0 独立审查 B1–B5)----------
  // 15) B1 正例:unsafe 块内 return 是最后一条语句 → 函数必然终止,不得误报 M3017
  const b1OkU = mkU('review_b1_ok.ming', [
    'fn alloc1() -> Ptr[mut u8] with unsafe {',
    '    unsafe {',
    '        let p = std.mem.alloc(1);',
    '        p.store(7);',
    '        return p;',
    '    }',
    '}',
    '',
    'fn main() -> i64 with unsafe {',
    '    unsafe {',
    '        let q = alloc1();',
    '        let v = q.load();',
    '        std.mem.free(q);',
    '        return v as i64;',
    '    }',
    '}',
    '',
  ].join('\n'));
  const b1OkR = runMing(['check', b1OkU]);
  check('v58.15:B1 unsafe 块终止流(块内 return 为最后语句 → 工厂函数 check 0 诊断,无 M3017)',
    b1OkR.code === 0 && (b1OkR.stderr ?? '') === '',
    'code=' + b1OkR.code + ' stderr=' + (b1OkR.stderr ?? '').slice(0, 300));

  // 16) B1 反例:loop 内只有 unsafe { break; } → loop 以 unit 结束(i64/Ptr 都不接受)
  const b1BadU = mkU('review_b1_bad.ming', [
    'fn main() -> i64 with unsafe {',
    '    let x: i64 = loop { unsafe { break; } };',
    '    let p: Ptr[mut u8] = loop { unsafe { break; } };',
    '    let _ = p.is_null();',
    '    return x;',
    '}',
    '',
  ].join('\n'));
  const b1BadR = runMing(['check', b1BadU]);
  const b1BadErr = b1BadR.stderr ?? '';
  check('v58.16:B1 unsafe break 冒泡(loop { unsafe { break; } } 装 i64/Ptr → 2×M3002,初始化表达式是 ())',
    b1BadR.code === 1 && (b1BadErr.match(/M3002/g) ?? []).length === 2
    && b1BadErr.includes('初始化表达式是 ()') && b1BadErr.includes('i64') && b1BadErr.includes('Ptr[mut u8]'),
    'code=' + b1BadR.code + ' M3002=' + (b1BadErr.match(/M3002/g) ?? []).length + ' stderr=' + b1BadErr.slice(0, 320));

  // 17) B2:unsafe 块在 C 端必须是独立作用域——块内 let 遮蔽外层同名变量不得 redefinition
  const b2U = mkU('review_b2_scope.ming', [
    'fn main() -> i64 with io, unsafe {',
    '    let x = 1;',
    '    unsafe {',
    '        let x = 2;',
    '        print(str(x));',
    '    }',
    '    print(str(x));',
    '    return 0;',
    '}',
    '',
  ].join('\n'));
  const b2Chk = runMing(['check', b2U]);
  const b2Vm = runMing(['run', b2U, '--no-wasm']);
  const b2EmDir = path.join(dir, 'b2-emit');
  const b2Em = spawnSync(process.execPath, [MING, 'cc', b2U, '--emit-c', '--out', b2EmDir], { encoding: 'utf8', timeout: 60000 });
  const b2Src = readC58(b2EmDir);
  // 内层 x 必须出现在一对花括号内(C 作用域),而不是与 v_x=1 同层
  const b2Scoped = /\{\s*\n\s*long long v_x = 2LL;/.test(b2Src) || /\{\s*long long v_x = 2LL;/.test(b2Src);
  if (hasCC58) {
    const b2C = ccRun58(b2U, path.join(dir, 'b2-run'));
    check('v58.17:B2 unsafe 块 C 作用域(cc 输出 2/1 与 VM 一致;发射含 { 作用域块,不再 redefinition)',
      b2Chk.code === 0 && (b2Chk.stderr ?? '') === ''
      && b2Vm.code === 0 && b2Vm.stdout === '2\n1\n'
      && b2Em.status === 0 && b2Scoped
      && b2C.status === 0 && b2C.stdout === '2\n1\n' && (b2C.stderr ?? '') === '',
      'chk=' + b2Chk.code + ' vm=' + b2Vm.code + '/' + JSON.stringify(b2Vm.stdout)
      + ' cc=' + b2C.status + '/' + JSON.stringify(b2C.stdout) + ' scoped=' + b2Scoped
      + ' stderr=' + JSON.stringify((b2C.stderr ?? '').slice(0, 160)));
  } else {
    check('v58.17:B2 unsafe 块 C 作用域(无编译器:check/VM + 发射含 { 作用域块)',
      b2Chk.code === 0 && b2Vm.code === 0 && b2Vm.stdout === '2\n1\n' && b2Em.status === 0 && b2Scoped,
      'chk=' + b2Chk.code + ' vm=' + b2Vm.code + '/' + JSON.stringify(b2Vm.stdout) + ' scoped=' + b2Scoped);
  }

  // 18) B3:块外把 Ptr 装进容器/构造器 → M3046;同一批构造放在 unsafe 块内 → 0 诊断
  const b3Shape = (inside) => {
    const ind = '    ';
    const body = [
      '    let q = make();',
      ind + 'let _h = H { p: q };',
      ind + 'let _o = Some(q);',
      ind + 'let mut vv: Vec[Ptr[mut u8]] = [];',
      ind + 'vv.push(q);',
      ind + 'let _t = (q, 1);',
      ind + 'let _a = take_h(H { p: q });',
      ind + 'let _b = take_opt(Some(q));',
      ind + 'let _c = take_t((q, 1));',
      '    return 0;',
    ];
    const lines = inside
      ? ['fn outside() -> i64 with unsafe {', '    let q = make();', '    unsafe {', ...body.slice(1, -1), '    }', '    return 0;', '}']
      : ['fn outside() -> i64 with unsafe {', ...body, '}'];
    return [
      'struct H { p: Ptr[mut u8] }',
      'fn make() -> Ptr[mut u8] with unsafe {',
      '    unsafe {',
      '        let p = std.mem.alloc(1);',
      '        p.store(3);',
      '        return p;',
      '    }',
      '}',
      'fn take_h(h: H) -> i64 { return 0; }',
      'fn take_opt(o: Option[Ptr[mut u8]]) -> i64 { return 0; }',
      'fn take_t(t: (Ptr[mut u8], i64)) -> i64 { return 0; }',
      ...lines,
      'fn main() -> i64 with unsafe { return outside(); }',
      '',
    ].join('\n');
  };
  const b3OutU = mkU('review_b3_outside.ming', b3Shape(false));
  const b3InU = mkU('review_b3_inside.ming', b3Shape(true));
  const b3OutR = runMing(['check', b3OutU]);
  const b3InR = runMing(['check', b3InU]);
  const b3Err = b3OutR.stderr ?? '';
  check('v58.18:B3 容器载荷逃逸(块外 H{}/Some/push/元组/传参 → 7×M3046;块内 0 诊断)',
    b3OutR.code === 1 && (b3Err.match(/M3046/g) ?? []).length === 7
    && b3Err.includes('结构体字段含 Ptr') && b3Err.includes('变体载荷含 Ptr')
    && b3Err.includes('Vec 元素含 Ptr') && b3Err.includes('元组成分含 Ptr')
    && b3InR.code === 0 && (b3InR.stderr ?? '') === '',
    'out=' + b3OutR.code + ' M3046=' + (b3Err.match(/M3046/g) ?? []).length + ' in=' + b3InR.code
    + ' inErr=' + JSON.stringify((b3InR.stderr ?? '').slice(0, 200)));

  // 19) B4:unsafe 块内定义的闭包携带 unsafe 效果,不得洗成纯函数值;
  //     块内直接调用该闭包仍允许(效果已由所在函数声明)
  const b4BadU = mkU('review_b4_launder.ming', [
    'fn pure_call(f: () -> u8) -> u8 { return f(); }',
    'fn make() -> (() -> u8) with unsafe {',
    '    let mut g: () -> u8 = () => 0;',
    '    unsafe {',
    '        let p = std.mem.alloc(1);',
    '        p.store(42);',
    '        g = () => p.load();',
    '    }',
    '    return g;',
    '}',
    'fn main() -> i64 with io, unsafe {',
    '    let g = make();',
    '    print(str(pure_call(g)));',
    '    return 0;',
    '}',
    '',
  ].join('\n'));
  const b4OkU = mkU('review_b4_direct.ming', [
    'fn run() -> u8 with unsafe {',
    '    unsafe {',
    '        let p = std.mem.alloc(1);',
    '        p.store(5);',
    '        let g = () => p.load();',
    '        let v = g();',
    '        std.mem.free(p);',
    '        return v;',
    '    }',
    '}',
    'fn main() -> i64 with io, unsafe {',
    '    print(str(run()));',
    '    return 0;',
    '}',
    '',
  ].join('\n'));
  const b4BadR = runMing(['check', b4BadU]);
  const b4OkR = runMing(['check', b4OkU]);
  const b4Err = b4BadR.stderr ?? '';
  check('v58.19:B4 闭包洗效果(unsafe 闭包赋给纯函数类型 → M3029[unsafe];块内直接调用 0 诊断)',
    b4BadR.code === 1 && (b4Err.match(/M3029/g) ?? []).length === 1
    && b4Err.includes('[unsafe]') && b4Err.includes('效果只增不减')
    && b4OkR.code === 0 && (b4OkR.stderr ?? '') === '',
    'bad=' + b4BadR.code + ' M3029=' + (b4Err.match(/M3029/g) ?? []).length + ' ok=' + b4OkR.code
    + ' stderr=' + b4Err.slice(0, 260));

  // 20) B5:use std.mem / use std.math 短名在字节码编译器可解析(#27 全链路)
  const b5MemU = mkU('review_b5_mem.ming', [
    'use std.mem;',
    'fn main() -> i64 with unsafe {',
    '    unsafe {',
    '        let p = mem.alloc(1);',
    '        p.store(9);',
    '        let v = p.load();',
    '        mem.free(p);',
    '        return v as i64;',
    '    }',
    '}',
    '',
  ].join('\n'));
  const b5MathU = mkU('review_b5_math.ming', [
    'use std.math;',
    'fn main() -> i64 with io {',
    '    let x = math.sqrt(25.0);',
    '    print(str(x));',
    '    return 0;',
    '}',
    '',
  ].join('\n'));
  const b5MemTree = runMing(['run', b5MemU, '--tree']);
  const b5MemVm = runMing(['run', b5MemU, '--no-wasm']);
  const b5MathTree = runMing(['run', b5MathU, '--tree']);
  const b5MathVm = runMing(['run', b5MathU, '--no-wasm']);
  const b5MemFirst = (b5MemTree.stderr ?? '').split('\n')[0];
  const b5MemVmFirst = (b5MemVm.stderr ?? '').split('\n')[0];
  const b5MathOk = b5MathTree.code === 0 && b5MathTree.stdout === '5.0\n'
    && b5MathVm.code === 0 && b5MathVm.stdout === '5.0\n'
    && !(b5MathVm.stderr ?? '').includes('名字未解析');
  let b5MemCcOk = true;
  let b5MemCcDetail = 'no-cc';
  if (hasCC58) {
    const b5MemCc = ccRun58(b5MemU, path.join(dir, 'b5-mem-cc'));
    b5MemCcOk = b5MemCc.status === 0 && (b5MemCc.stderr ?? '') === '';
    b5MemCcDetail = 'cc=' + b5MemCc.status + '/' + JSON.stringify((b5MemCc.stderr ?? '').slice(0, 160));
  }
  check('v58.20:B5 use std.mem/std.math 短名(#27):mem 三路一致(tree/VM M4016,cc 跑通)+ math tree/VM 5.0',
    b5MemTree.code === 101 && b5MemVm.code === 101
    && b5MemFirst === b5MemVmFirst && b5MemFirst.includes('M4016[native-only-feature]')
    && b5MathOk && b5MemCcOk,
    'memTree=' + b5MemTree.code + ' memVm=' + b5MemVm.code + ' first=' + JSON.stringify(b5MemFirst)
    + ' mathTree=' + b5MathTree.code + '/' + JSON.stringify(b5MathTree.stdout)
    + ' mathVm=' + b5MathVm.code + '/' + JSON.stringify(b5MathVm.stdout)
    + ' ' + b5MemCcDetail);
}

// ===================== 59. v0.55:跨函数契约摘要 + 调用点线性前置条件(M3041 扩展)=====================
{
  const dir = path.join(TMP, 'v55');
  fs.mkdirSync(dir, { recursive: true });
  const mk = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };
  const silent = (r) => r.code === 0 && !/M3041|M3042/.test(r.stderr ?? '');

  // ---- v59.1:摘要引擎(纯数据接口:Tarjan SCC + 被调方优先拓扑序 + 硬门控)----
  // 契约 AST 对 prover 不透明 → 用轻量假 AST + 注入 toLinear 直接驱动 computeSummaries。
  const FV = (n) => ({ nt: 'V', n });
  const FC = (k) => ({ nt: 'C', k: BigInt(k) });
  const FL = (op, l, r) => ({ nt: 'L', op, l, r });
  const FAND = (l, r) => ({ nt: 'A', l, r });
  const FT = { nt: 'True' };
  const FBAD = { nt: 'Bad' };
  const toLin = (ast, varMap) => {
    if (ast == null) return [];
    const leaves = [];
    const split = (e) => { if (e?.nt === 'A') { split(e.l); split(e.r); return; } leaves.push(e); };
    split(ast);
    const out = [];
    for (const leaf of leaves) {
      if (leaf?.nt === 'True') continue;
      if (leaf?.nt !== 'L') return null;
      const side = (x) => {
        if (x?.nt === 'C') return { coeffs: new Map(), c: x.k };
        if (x?.nt === 'V') {
          const f = varMap.get(x.n);
          return f ? { coeffs: new Map(f.coeffs), c: f.c } : null;
        }
        return null;
      };
      const l = side(leaf.l), r = side(leaf.r);
      if (!l || !r) return null;
      out.push({ lhs: l, op: leaf.op, rhs: r });
    }
    return out;
  };
  const linF = (spec, c = 0n) => ({ coeffs: new Map(Object.entries(spec).map(([k, v]) => [k, BigInt(v)])), c: BigInt(c) });
  const P = (n) => ({ name: n, type: 'i64' });
  const postX1 = [{ lhs: linF({ result: 1, x: -1 }), op: '==', rhs: linF({}, 1) }]; // result - x == 1
  const chainFns = [
    { name: 'f', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: ['g'], post: postX1 },
    { name: 'g', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: ['h'], post: postX1 },
    { name: 'h', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: [], post: postX1 },
  ];
  const chain = computeSummaries(chainFns, toLin);
  const chain2 = computeSummaries(chainFns, toLin);
  const chainOrder = [...chain.keys()].join(',');
  check('v59.1:摘要引擎链式拓扑序(声明 f,g,h → 计算 h,g,f)+ requires/ensures 采用 + 确定性',
    chainOrder === 'h,g,f' && chainOrder === [...chain2.keys()].join(',')
    && ['f', 'g', 'h'].every((n) => chain.get(n).requires?.length === 1 && chain.get(n).ensures?.length === 1 && chain.get(n).noSummary === false),
    'order=' + chainOrder);

  const gate = computeSummaries([
    { name: 'badReq', params: [P('x')], requires: FL('==', FBAD, FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: [], post: postX1 },
    { name: 'badPost', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: [], post: null },
    { name: 'badVar', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: [], post: [{ lhs: linF({ z: 1 }), op: '>=', rhs: linF({}, 0) }] },
    { name: 'noEns', params: [P('x')], requires: FAND(FL('>=', FV('x'), FC(0)), FT), ensures: null, calls: [], post: null },
  ], toLin);
  check('v59.1:摘要硬门控(requires 不完整 / post 未证 / 非形参变量 → ensures=null;无 ensures → 空合取)',
    gate.get('badReq').requires === null && gate.get('badReq').ensures === null
    && gate.get('badPost').requires?.length === 1 && gate.get('badPost').ensures === null
    && gate.get('badVar').requires?.length === 1 && gate.get('badVar').ensures === null
    && Array.isArray(gate.get('noEns').ensures) && gate.get('noEns').ensures.length === 0,
    JSON.stringify([...gate.values()].map((s) => [s.name, s.requires === null ? null : s.requires.length, s.ensures === null ? null : s.ensures.length])));

  // N10(v0.55.0 审查):注入的 toLinear / computePost 结果 op 非法 → 视为不可编码
  // (requires → 不完整门控;ensures → 不采用),不得进入差分约束求解器。
  const n10 = computeSummaries([
    { name: 'badReqOp', params: [P('x')], requires: FL('~', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: [], post: postX1 },
    { name: 'badPostOp', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: [], post: [{ lhs: linF({ result: 1 }), op: '~', rhs: linF({ x: 1 }) }] },
  ], toLin);
  check('v59.1:N10 注入 toLinear/computePost 非法 op → 视为不可编码(requires 不完整 / ensures 不采用)',
    n10.get('badReqOp').requires === null && n10.get('badReqOp').ensures === null
    && n10.get('badPostOp').requires?.length === 1 && n10.get('badPostOp').ensures === null,
    JSON.stringify([...n10.values()].map((s) => [s.name, s.requires === null ? null : s.requires.length, s.ensures === null ? null : s.ensures.length])));

  const cyc = computeSummaries([
    { name: 'r', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: ['r'], post: postX1 },
    { name: 'p', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: ['q'], post: postX1 },
    { name: 'q', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: ['p'], post: postX1 },
    { name: 's', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: ['r'], post: postX1 },
  ], toLin);
  check('v59.1:环(自递归 r→r / 互递归 p↔q)noSummary → ensures 不采用;环外调用方 s 仍出摘要',
    cyc.get('r').noSummary === true && cyc.get('p').noSummary === true && cyc.get('q').noSummary === true
    && cyc.get('r').ensures === null && cyc.get('p').ensures === null && cyc.get('q').ensures === null
    && cyc.get('s').noSummary === false && cyc.get('s').ensures?.length === 1 && cyc.get('r').requires?.length === 1,
    JSON.stringify([...cyc.values()].map((s) => [s.name, s.noSummary, s.ensures === null ? null : s.ensures.length])));

  // 端到端:链式 f→g→h(丢弃调用的直线体)全绿 —— 各函数 ensures 由自身返回形式成立
  const chainSrc = mk('chain.ming', [
    'fn h(a: i64) -> i64 requires a >= 0 ensures (result == a + 1) { return a + 1; }',
    'fn g(a: i64) -> i64 requires a >= 0 ensures (result == a + 2) { h(a); return a + 2; }',
    'fn f(a: i64) -> i64 requires a >= 0 ensures (result == a + 3) { g(a); return a + 3; }',
    'fn main() with io { print(str(f(1))); }',
    '',
  ].join('\n'));
  const rchain = runMing(['check', chainSrc]);
  check('v59.1:链式 f→g→h 摘要语料 check 全绿(调用语句丢弃结果,ensures 由返回形式成立)', silent(rchain), 'code=' + rchain.code + ' stderr=' + (rchain.stderr ?? '').slice(0, 200));

  // v0.55 阶段 2:M3042 假设集现在含本函数 requires → 仅靠 a == 0 即可证伪(能力提升)
  const m3042Same = mk('m3042_same.ming', [
    'fn f(a: i64) -> i64 requires a == 0 ensures (result == 1) { return a; }',
    'fn main() with io { print(str(f(0))); }',
    '',
  ].join('\n'));
  const rm3042 = runMing(['check', m3042Same]);
  check('v59.1:M3042 假设集含本函数 requires(a == 0 ⇒ result == 1 可证伪,反例 a = 0)',
    rm3042.code === 1 && (rm3042.stderr ?? '').includes('M3042') && (rm3042.stderr ?? '').includes('(反例:a = 0)'),
    'code=' + rm3042.code + ' stderr=' + (rm3042.stderr ?? '').slice(0, 200));

  // ---- v59.2:调用点线性实参可证违反 → M3041 + 反例(非字面量路径)----
  const lin1 = mk('callsite_linear.ming', [
    'fn limit(a: i64) -> i64 requires a >= 5 { return a; }',
    'fn caller(x: i64) -> i64 requires x <= 4 { return limit(x); }',
    'fn main() with io { print(str(caller(4))); }',
    '',
  ].join('\n'));
  const rlin1 = runMing(['check', lin1]);
  check('v59.2:参数实参可证违反 g.requires → M3041 + 反例(非字面量)',
    rlin1.code === 1 && (rlin1.stderr ?? '').includes('M3041')
    && (rlin1.stderr ?? '').includes('调用点静态违反契约:实参使 requires 不成立(反例:a = -2)'),
    'code=' + rlin1.code + ' stderr=' + (rlin1.stderr ?? '').slice(0, 220));

  const lin2 = mk('callsite_local.ming', [
    'fn limit(a: i64) -> i64 requires a >= 5 { return a; }',
    'fn caller(x: i64) -> i64 requires x <= 3 { let y = x + 1; return limit(y); }',
    'fn main() with io { print(str(caller(3))); }',
    '',
  ].join('\n'));
  const rlin2 = runMing(['check', lin2]);
  check('v59.2:局部线性形式实参(let y = x + 1)可证违反 → M3041 + 反例',
    rlin2.code === 1 && (rlin2.stderr ?? '').includes('M3041') && (rlin2.stderr ?? '').includes('(反例:a = -1)'),
    'code=' + rlin2.code + ' stderr=' + (rlin2.stderr ?? '').slice(0, 220));

  // ---- v59.3:对抗面 —— 不得误报(硬门槛)----
  const adv = mk('adversarial.ming', [
    'const LIST: Vec[i64] = [1, 2, 3];',
    'fn limit(a: i64) -> i64 requires a >= 5 { return a; }',
    'fn even(a: i64) -> i64 requires a % 2 == 0 { return a; }',
    'fn pick(buf: Vec[i64], i: i64) -> i64 requires i < buf.len() { return buf[i]; }',
    'fn lenreq(a: i64) -> i64 requires (a < LIST.len()) { return a; }',
    'fn id[T](a: T) -> T { return a; }',
    // 1) 需求只给下界:x >= 0 不蕴含 x >= 5 也不蕴含 x < 5 → 不可证违反,静默
    'fn weak(x: i64) -> i64 requires x >= 0 { return limit(x); }',
    // 2) 非线性实参 x * x(v0.55 线性化失败 → 静默)
    'fn nonlin(x: i64) -> i64 requires x <= 0 { return limit(x * x); }',
    // 3) 被调 requires 不可编码(%):整条静默
    'fn modreq(x: i64) -> i64 requires x <= -1 { return even(x); }',
    // 4) 被调含 Vec 参数 + len():直接跳过
    'fn vecreq(x: i64) -> i64 requires x <= 0 { return pick([1, 2], x); }',
    // 5) 泛型调用:跳过
    'fn gen(x: i64) -> i64 requires x <= 0 { return id(x); }',
    // 6) 全 i64 形参但 requires 含常量 Vec 的 len():不可编码 → 静默
    'fn constlen(x: i64) -> i64 requires x <= 0 { return lenreq(x); }',
    'fn main() with io { print(str(weak(0)) + str(nonlin(0)) + str(modreq(-2)) + str(vecreq(0)) + str(gen(0)) + str(constlen(0))); }',
    '',
  ].join('\n'));
  const radv = runMing(['check', adv]);
  check('v59.3:对抗面无误报(下界不足/非线性/%/Vec+len/泛型/常量 len → 全部静默)', silent(radv), 'code=' + radv.code + ' stderr=' + (radv.stderr ?? '').slice(0, 300));

  // 形参重赋值后 requires 假设作废(否则 mut x 改值会造成误报)
  const reassign = mk('reassign.ming', [
    'fn limit(a: i64) -> i64 requires a > 50 { return a; }',
    'fn caller(mut x: i64) -> i64 requires x <= 5 { x = 100; return limit(x); }',
    'fn main() with io { print(str(caller(0))); }',
    '',
  ].join('\n'));
  const rre = runMing(['check', reassign]);
  check('v59.3:形参重赋值后旧 requires 假设作废(不误报 M3041)', silent(rre), 'code=' + rre.code + ' stderr=' + (rre.stderr ?? '').slice(0, 300));

  // 调用方 ensures 不得依赖未证明前提的被调 ensures(阶段 2 的硬门控;h 无 requires)
  const noAssume = mk('no_assume.ming', [
    'fn g(a: i64) -> i64 requires a >= 0 ensures (result == a + 1) { return a + 1; }',
    'fn h(a: i64) -> i64 ensures (result == a + 1) { return g(a); }',
    'fn main() with io { print(str(h(1))); }',
    '',
  ].join('\n'));
  const rna = runMing(['check', noAssume]);
  check('v59.3:被调 requires 未证明 → 不假设其 ensures(静默,不误报 M3042)', silent(rna), 'code=' + rna.code + ' stderr=' + (rna.stderr ?? '').slice(0, 300));

  // 多参数混合:可证违反其中一条 → 正确报告;反例须满足其余可编码 requires
  const multi = mk('multi.ming', [
    'fn mm(a: i64, b: i64) -> i64 requires (a > 0 && b > a) { return a; }',
    'fn caller(x: i64) -> i64 requires x <= 0 { return mm(x, 0); }',
    'fn main() with io { print(str(caller(0))); }',
    '',
  ].join('\n'));
  const rmulti = runMing(['check', multi]);
  check('v59.3:多参数混合(线性 + 字面量)可证违反 → M3041 + 反例满足其余合取(b > a)',
    rmulti.code === 1 && (rmulti.stderr ?? '').includes('M3041') && (rmulti.stderr ?? '').includes('(反例:a = -2, b = 0)'),
    'code=' + rmulti.code + ' stderr=' + (rmulti.stderr ?? '').slice(0, 260));

  // ---- v59.4:递归/互递归/循环/分支静默 ----
  // v0.55.0 审查修复(B1):branch 改为纯分支体(不依赖 rec 的 noSummary)——分支内形参重赋值
  // 必须让直线分析停止;旧实现跳过 if 后把 x 当作入口值,误报 M3041。
  const rec = mk('recursion.ming', [
    'fn rec(a: i64) -> i64 requires a >= 0 ensures (result >= 0) { if a == 0 { return 0; } return rec(a - 1); }',
    'fn ping(a: i64) -> i64 requires a >= 0 ensures (result >= 0) { if a == 0 { return 0; } return pong(a - 1); }',
    'fn pong(a: i64) -> i64 requires a >= 0 ensures (result >= 0) { if a == 0 { return 0; } return ping(a - 1); }',
    'fn limit(a: i64) -> i64 requires a > 50 { return a; }',
    'fn branch(mut x: i64) -> i64 requires x == 0 { if x == 0 { x = 100; } return limit(x); }',
    'fn loopCall(x: i64) -> i64 requires x <= 4 { let mut i = x; while i < 0 { rec(i); i += 1; } return 0; }',
    'fn main() with io { print(str(rec(2)) + str(ping(2)) + str(branch(0)) + str(loopCall(0))); }',
    '',
  ].join('\n'));
  const rrec = runMing(['check', rec]);
  check('v59.4:递归/互递归/循环/分支静默(无摘要错误、无 M3041/M3042)', silent(rrec), 'code=' + rrec.code + ' stderr=' + (rrec.stderr ?? '').slice(0, 300));

  // ---- v59.5:字面量 M3041 路径逐字不变(§42 黄金形态)----
  const lit = mk('literal.ming', [
    'fn pay(amount: i64) -> i64 requires amount > 0 else "金额必须为正" {',
    '    return amount * 2;',
    '}',
    'fn main() with io {',
    '    print(str(pay(-5)));',
    '    print(str(pay(3)));',
    '}',
    '',
  ].join('\n'));
  const rlit = runMing(['check', lit]);
  check('v59.5:字面量 M3041 逐字不变(消息 + 反例 + else + hint)',
    rlit.code === 1
    && (rlit.stderr ?? '').includes('error M3041[contract-violated-at-call]: 调用点静态违反契约:实参使 requires 不成立(反例:amount = -5);金额必须为正')
    && (rlit.stderr ?? '').includes('hint: 调整实参以满足前置条件;该错误在运行时本会以 M4015 出现。')
    && (rlit.stderr.match(/M3041/g) ?? []).length === 1,
    'code=' + rlit.code + ' stderr=' + (rlit.stderr ?? '').slice(0, 260));

  // ---- v59.6:调用后置条件假设 —— 链式 f→g→h 的 ensures 可证真/可证伪 ----
  // 接口契约:computeSummaries 第三参按拓扑序回调(callee 先算),回调可见已算出的被调摘要;
  // 摘要输出带 params(调用点把 ensures 的形参代入实参所需)。
  const cbOrder = [];
  const cbSeen = new Map();
  const cbFns = [
    { name: 'caller', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: ['callee'] },
    { name: 'callee', params: [P('x')], requires: FL('>=', FV('x'), FC(0)), ensures: FL('==', FV('result'), FV('x')), calls: [] },
  ];
  const cbOut = computeSummaries(cbFns, toLin, (fn, soFar) => {
    cbOrder.push(fn.name);
    const seen = soFar.get('callee');
    cbSeen.set(fn.name, seen ? seen.ensures : null);
    return postX1;
  });
  check('v59.6:computeSummaries 第三参按拓扑序回调(callee 先于 caller;回调可见已算摘要;输出带 params)',
    cbOrder.join(',') === 'callee,caller'
    && cbSeen.get('callee') === null && cbSeen.get('caller')?.length === 1
    && cbOut.get('caller').ensures?.length === 1 && cbOut.get('caller').params.join(',') === 'x'
    && cbOut.get('callee').params.join(',') === 'x',
    'order=' + cbOrder.join(',') + ' seen=' + JSON.stringify([...cbSeen.entries()].map(([k, v]) => [k, v == null ? null : v.length])));

  // h.ensures(result == a + 1) 直线体自证;g 的体调用 h 并返回 r + 1,只有假设 h 的
  // ensures 才能证 result == a + 2;f 同理依赖 g。正向(ensures 成立)静默、负向报 M3042。
  const chainOk = mk('chain_assume_ok.ming', [
    'fn h(a: i64) -> i64 requires a >= 0 ensures (result == a + 1) { return a + 1; }',
    'fn g(a: i64) -> i64 requires a >= 0 ensures (result == a + 2) { let r = h(a); return r + 1; }',
    'fn f(a: i64) -> i64 requires a >= 0 ensures (result == a + 3) { let r = g(a); return r + 1; }',
    'fn main() with io { print(str(f(1))); }',
    '',
  ].join('\n'));
  const rco = runMing(['check', chainOk]);
  check('v59.6:链式摘要可证真(g.ensures 假设 h、f.ensures 假设 g)→ 静默',
    silent(rco), 'code=' + rco.code + ' stderr=' + (rco.stderr ?? '').slice(0, 260));

  const chainBad = mk('chain_assume_bad.ming', [
    'fn h(a: i64) -> i64 requires a >= 0 ensures (result == a + 1) { return a + 1; }',
    'fn g(a: i64) -> i64 requires a >= 0 ensures (result == a + 2) { let r = h(a); return r + 1; }',
    'fn f(a: i64) -> i64 requires a >= 0 ensures (result == a + 4) { let r = g(a); return r + 1; }',
    'fn main() with io { print(str(f(1))); }',
    '',
  ].join('\n'));
  const rcb = runMing(['check', chainBad]);
  check('v59.6:依赖 g.ensures 才可证伪的 f.ensures → M3042 + 反例满足 f.requires(a >= 0 ⇒ 反例 a = 0)',
    rcb.code === 1 && (rcb.stderr ?? '').includes('M3042') && (rcb.stderr ?? '').includes('(反例:a = 0)')
    && !(rcb.stderr ?? '').includes('M3041'),
    'code=' + rcb.code + ' stderr=' + (rcb.stderr ?? '').slice(0, 260));

  // ---- v59.7:硬门控 —— 被调 requires 不完整/未证明 → 不得假设其 ensures ----
  // (a) requires 含不可编码叶(%):摘要 requires = null → ensures 不采用 → 静默
  const gateInc = mk('gate_incomplete.ming', [
    'fn g(a: i64) -> i64 requires a % 2 == 0 ensures (result == a + 2) { return a + 2; }',
    'fn f(a: i64) -> i64 requires a >= 0 ensures (result == a + 4) { let r = g(a); return r + 1; }',
    'fn main() with io { print(str(f(1))); }',
    '',
  ].join('\n'));
  const rgi = runMing(['check', gateInc]);
  check('v59.7:被调 requires 不可编码(% 2 == 0)→ 摘要 ensures 不采用,静默',
    silent(rgi), 'code=' + rgi.code + ' stderr=' + (rgi.stderr ?? '').slice(0, 260));

  // (b) requires 完整但当前路径不可证(a >= 5 推不出)→ 不采用 ensures → 静默
  const gateUnp = mk('gate_unproven.ming', [
    'fn g(a: i64) -> i64 requires a >= 5 ensures (result == a + 2) { return a + 2; }',
    'fn f(a: i64) -> i64 requires a >= 0 ensures (result == a + 4) { let r = g(a); return r + 1; }',
    'fn main() with io { print(str(f(1))); }',
    '',
  ].join('\n'));
  const rgu = runMing(['check', gateUnp]);
  check('v59.7:被调 requires 完整但当前路径不可证(a >= 0 推不出 a >= 5)→ 静默',
    silent(rgu), 'code=' + rgu.code + ' stderr=' + (rgu.stderr ?? '').slice(0, 260));

  // (c) 正例:requires 完整且当前路径可证(a >= 5)→ 假设生效,可证伪 → M3042 + 反例 a = 5
  const gatePro = mk('gate_proven.ming', [
    'fn g(a: i64) -> i64 requires a >= 5 ensures (result == a + 2) { return a + 2; }',
    'fn f(a: i64) -> i64 requires a >= 5 ensures (result == a + 4) { let r = g(a); return r + 1; }',
    'fn main() with io { print(str(f(5))); }',
    '',
  ].join('\n'));
  const rgp = runMing(['check', gatePro]);
  check('v59.7:requires 完整且当前路径可证 → 采用 ensures,依赖它才可证伪 → M3042(反例 a = 5)',
    rgp.code === 1 && (rgp.stderr ?? '').includes('M3042') && (rgp.stderr ?? '').includes('(反例:a = 5)'),
    'code=' + rgp.code + ' stderr=' + (rgp.stderr ?? '').slice(0, 260));

  // (d) 传递门控:g 的 post 依赖 h,而 h.requires(a >= 5) 在 g 的 requires(a >= 0) 下不可证
  //     → g.post 未证 → 摘要 ensures 不采用 → f 静默(不假设未证明前提的传递链)
  const transGate = mk('gate_transitive.ming', [
    'fn h(a: i64) -> i64 requires a >= 5 ensures (result == a + 1) { return a + 1; }',
    'fn g(a: i64) -> i64 requires a >= 0 ensures (result == a + 2) { let r = h(a); return r + 1; }',
    'fn f(a: i64) -> i64 requires a >= 0 ensures (result == a + 4) { let r = g(a); return r + 1; }',
    'fn main() with io { print(str(f(1))); }',
    '',
  ].join('\n'));
  const rtg = runMing(['check', transGate]);
  check('v59.7:传递门控(h.requires 在 g 内不可证 → g.ensures 未证 → f 不假设)静默',
    silent(rtg), 'code=' + rtg.code + ' stderr=' + (rtg.stderr ?? '').slice(0, 300));

  // ---- v59.8:递归/互递归 noSummary → 不假设,静默 ----
  // f/fr 的 ensures 若错误地假设了 g/p 的 ensures 反而会被"证伪"(a + 9 ≠ a + 3)→ 静默即证明未假设
  const recSummary = mk('rec_summary.ming', [
    'fn g(a: i64) -> i64 requires a >= 0 ensures (result == a + 2) { if a == 0 { return 2; } return g(a - 1) + 1; }',
    'fn p(a: i64) -> i64 requires a >= 0 ensures (result == a + 1) { if a == 0 { return 1; } return q(a - 1) + 1; }',
    'fn q(a: i64) -> i64 requires a >= 0 ensures (result == a + 2) { if a == 0 { return 2; } return p(a - 1) + 1; }',
    'fn f(a: i64) -> i64 requires a >= 0 ensures (result == a + 9) { let r = g(a); return r + 1; }',
    'fn fr(a: i64) -> i64 requires a >= 0 ensures (result == a + 9) { let r = p(a); return r + 1; }',
    'fn main() with io { print(str(f(1)) + str(fr(1))); }',
    '',
  ].join('\n'));
  const rrs = runMing(['check', recSummary]);
  check('v59.8:递归(g)/互递归(p↔q)noSummary → 不假设其 ensures;依赖它的调用方静默',
    silent(rrs), 'code=' + rrs.code + ' stderr=' + (rrs.stderr ?? '').slice(0, 300));

  // ---- v59.9:无摘要/无 ensures 的调用结果变量 unknown(不得凭空假设)----
  const unknownRes = mk('unknown_result.ming', [
    'fn g(a: i64) -> i64 requires a >= 0 { return a * 2; }',
    'fn f(a: i64) -> i64 requires a >= 0 ensures (result > a) { let r = g(a); return r; }',
    'fn f2(a: i64) -> i64 requires a >= 0 ensures (result == a + 100) { let r = g(a); return r + 1; }',
    'fn main() with io { print(str(f(1)) + str(f2(1))); }',
    '',
  ].join('\n'));
  const rur = runMing(['check', unknownRes]);
  check('v59.9:被调无 ensures → 结果变量 unknown,依赖它的 ensures 静默(不误报)',
    silent(rur), 'code=' + rur.code + ' stderr=' + (rur.stderr ?? '').slice(0, 300));

  // ---- v59.10:既有 M3042 单函数行为逐字不变(§43/§45 形态)----
  const legacy = mk('legacy_m3042.ming', [
    'fn f(a: i64) -> i64 requires a > 0 ensures result == a + 2 {',
    '    return a + 1;',
    '}',
    'fn main() with io { print(str(f(3))); }',
    '',
  ].join('\n'));
  const rleg = runMing(['check', legacy]);
  check('v59.10:既有 M3042 逐字不变(§43 形态:码名 + 消息 + 反例 a = 1 + hint)',
    rleg.code === 1
    && (rleg.stderr ?? '').includes('error M3042[ensures-statically-false]: 函数 "f" 的 ensures 可静态证伪(反例:a = 1)')
    && (rleg.stderr ?? '').includes('hint: 修正确保表达式或函数体;该错误在运行时本会以 M4015 出现。'),
    'code=' + rleg.code + ' stderr=' + (rleg.stderr ?? '').slice(0, 260));

  const legacyNoReq = mk('legacy_noreq.ming', [
    'fn f(a: i64) -> i64 ensures result > a else "结果必须大于输入" { return a; }',
    'fn main() with io { print(str(f(3))); }',
    '',
  ].join('\n'));
  const rln = runMing(['check', legacyNoReq]);
  check('v59.10:无 requires 的单函数 M3042 逐字不变(§45 形态:反例 a = 0 + else 消息)',
    rln.code === 1
    && (rln.stderr ?? '').includes('error M3042[ensures-statically-false]: 函数 "f" 的 ensures 可静态证伪(反例:a = 0);结果必须大于输入'),
    'code=' + rln.code + ' stderr=' + (rln.stderr ?? '').slice(0, 260));

  // ---- v59.11:多调用结果符号独立性(两次 g 调用各自后置)----
  const twoCalls = mk('two_calls.ming', [
    'fn g(a: i64) -> i64 requires a >= 0 ensures (result == a + 1) { return a + 1; }',
    'fn f(a: i64) -> i64 requires a >= 0 ensures (result == 0) { let r = g(a); let s = g(a + 1); return r - s; }',
    'fn fok(a: i64) -> i64 requires a >= 0 ensures (result == 0 - 1) { let r = g(a); let s = g(a + 1); return r - s; }',
    'fn main() with io { print(str(f(1)) + str(fok(1))); }',
    '',
  ].join('\n'));
  const rtc = runMing(['check', twoCalls]);
  check('v59.11:两次调用各自独立符号(r - s = -1);共享符号会误证 result == 0 → 必须报 M3042(反例 a = 0)',
    rtc.code === 1 && (rtc.stderr ?? '').includes('M3042') && (rtc.stderr ?? '').includes('(反例:a = 0)')
    && !(rtc.stderr ?? '').includes('"fok"'),
    'code=' + rtc.code + ' stderr=' + (rtc.stderr ?? '').slice(0, 300));

  // ---- v59.13:直线体判定(B1)——控制流分支不得被"穿透" ----
  // 旧 walkLinearBody 的 descend 白名单把 ExprStmt 包裹的 If/Match/BlockExpr 当纯表达式跳过,
  // 后续语句被误认为直线路径 → 摘要采用分支内已改写的旧形参值 / 误报 M3041/M3042/M3045。
  const b1If = mk('b1_if_return.ming', [
    'fn f(x: i64) -> i64 requires x >= 0 ensures (result == x) { if x >= 0 { return x; } return -1; }',
    'fn main() with io { print(str(f(1))); }',
    '',
  ].join('\n'));
  const rb1If = runMing(['check', b1If]);
  check('v59.13:B1 if 分支返回不再被穿透(HEAD 误报 M3042 → 静默)',
    silent(rb1If), 'code=' + rb1If.code + ' stderr=' + (rb1If.stderr ?? '').slice(0, 300));

  const b1Assign = mk('b1_match_block.ming', [
    'fn limit(a: i64) -> i64 requires a > 50 { return a; }',
    'fn m(mut x: i64) -> i64 requires x == 0 { match x { _ => { x = 100; } } return limit(x); }',
    'fn b(mut x: i64) -> i64 requires x == 0 { { x = 100; } return limit(x); }',
    'fn main() with io { print(str(m(0)) + str(b(0))); }',
    '',
  ].join('\n'));
  const rb1As = runMing(['check', b1Assign]);
  check('v59.13:B1 match/裸块赋值后停止直线分析(HEAD 误报 M3041 → 静默)',
    silent(rb1As), 'code=' + rb1As.code + ' stderr=' + (rb1As.stderr ?? '').slice(0, 300));

  const b1Bogus = mk('b1_bogus_summary.ming', [
    'fn g(mut a: i64) -> i64 requires a == 0 ensures (result == a + 5) { if a == 0 { a = 10; return 15; } return 5; }',
    'fn caller(x: i64) -> i64 requires x == 0 ensures (result == x + 15) { return g(x); }',
    'fn main() with io { print(str(caller(0))); }',
    '',
  ].join('\n'));
  const rb1Bogus = runMing(['check', b1Bogus]);
  check('v59.13:B1 分支内形参重赋值后摘要不得采用(调用方正确程序必须静默;HEAD 误报 M3042)',
    silent(rb1Bogus), 'code=' + rb1Bogus.code + ' stderr=' + (rb1Bogus.stderr ?? '').slice(0, 300));

  const b1Idx = mk('b1_index_branch.ming', [
    'fn f(buf: Vec[i64], mut i: i64) -> i64 requires (i == 5 && buf.len() == 5) { if i == 5 { i = 0; } return buf[i]; }',
    'fn main() with io { print(str(f([1, 2, 3, 4, 5], 5))); }',
    '',
  ].join('\n'));
  const rb1Idx = runMing(['check', b1Idx]);
  check('v59.13:B1 索引遍历同源修复(if 分支内赋值后 buf[i] 不再误报 M3045;HEAD 复现)',
    silent(rb1Idx) && !(rb1Idx.stderr ?? '').includes('M3045'), 'code=' + rb1Idx.code + ' stderr=' + (rb1Idx.stderr ?? '').slice(0, 300));

  // ---- v59.14:短路 &&/|| 的右侧不得当作无条件调用点(B2)----
  const b2 = mk('b2_short_circuit.ming', [
    'fn limit(a: i64) -> i64 requires a > 0 { return a; }',
    'fn f1(x: i64) -> i64 requires x <= 0 { let _b = (x > 100) && (limit(x) > 0); return 0; }',
    'fn f2(x: i64) -> i64 requires x <= 0 { let _b = false && (limit(x) > 0); return 0; }',
    'fn f3(x: i64) -> i64 requires x <= 0 { let _b = (x <= 0) || (limit(x) > 0); return 0; }',
    'fn main() with io { print(str(f1(0)) + str(f2(0)) + str(f3(0))); }',
    '',
  ].join('\n'));
  const rb2 = runMing(['check', b2]);
  check('v59.14:B2 &&/|| 右侧条件求值不收集(guard 恒假/恒真 → 静默,HEAD 误报 M3041)',
    silent(rb2), 'code=' + rb2.code + ' stderr=' + (rb2.stderr ?? '').slice(0, 300));

  const b2Left = mk('b2_left_call.ming', [
    'fn limit(a: i64) -> i64 requires a > 0 { return a; }',
    'fn f(x: i64) -> i64 requires x <= 0 { let _b = (limit(x) > 0) && true; return 0; }',
    'fn main() with io { print(str(f(0))); }',
    '',
  ].join('\n'));
  const rb2L = runMing(['check', b2Left]);
  check('v59.14:B2 左侧必求值调用仍能报 M3041(不因短路修复漏报)',
    rb2L.code === 1 && (rb2L.stderr ?? '').includes('M3041') && (rb2L.stderr ?? '').includes('(反例:a = -2)'),
    'code=' + rb2L.code + ' stderr=' + (rb2L.stderr ?? '').slice(0, 300));

  // ---- v59.15:反例必须满足调用方 requires(B3)----
  const b3 = mk('b3_cex_context.ming', [
    'fn limit(a: i64) -> i64 requires a == 5 { return a; }',
    'fn caller(x: i64) -> i64 requires x == 10 { return limit(x); }',
    'fn main() with io { print(str(caller(10))); }',
    '',
  ].join('\n'));
  const rb3 = runMing(['check', b3]);
  check('v59.15:B3 反例落在调用方合法输入集(x == 10 → 反例 a = 10,不再是不可达的 a = -2)',
    rb3.code === 1 && (rb3.stderr ?? '').includes('M3041') && (rb3.stderr ?? '').includes('(反例:a = 10)')
    && !(rb3.stderr ?? '').includes('a = -2'),
    'code=' + rb3.code + ' stderr=' + (rb3.stderr ?? '').slice(0, 300));

  const b3c = mk('b3_cex_const.ming', [
    'fn limit(a: i64) -> i64 requires a == 5 { return a; }',
    'fn caller() -> i64 requires true { let y = 0 - 5; return limit(y); }',
    'fn main() with io { print(str(caller())); }',
    '',
  ].join('\n'));
  const rb3c = runMing(['check', b3c]);
  check('v59.15:B3 常量实参直接报常量值(let y = 0 - 5 → 反例 a = -5,不是枚举小值 a = -2)',
    rb3c.code === 1 && (rb3c.stderr ?? '').includes('M3041') && (rb3c.stderr ?? '').includes('(反例:a = -5)'),
    'code=' + rb3c.code + ' stderr=' + (rb3c.stderr ?? '').slice(0, 300));

  // ---- v59.16:复合赋值线性转移(M6)----
  const m6Branch = mk('m6_branch.ming', [
    'fn f(mut x: i64) -> i64 requires x == 3 ensures (result == 5) { if x >= 0 { x += 2; } return x; }',
    'fn main() with io { print(str(f(3))); }',
    '',
  ].join('\n'));
  const rm6b = runMing(['check', m6Branch]);
  check('v59.16:M6 分支内 x += 2 不得被当作未执行(HEAD 误报 M3042 → 静默)',
    silent(rm6b), 'code=' + rm6b.code + ' stderr=' + (rm6b.stderr ?? '').slice(0, 300));

  const m6Lin = mk('m6_linear.ming', [
    'fn good(mut x: i64) -> i64 requires x == 3 ensures (result == 5) { x += 2; return x; }',
    'fn plus(mut x: i64) -> i64 requires x == 3 ensures (result == 2) { x -= 2; x *= 2; return x; }',
    'fn bad(mut x: i64) -> i64 requires x == 2 ensures (result == 5) { x += 2; return x; }',
    'fn main() with io { print(str(good(3)) + str(plus(3)) + str(bad(2))); }',
    '',
  ].join('\n'));
  const rm6l = runMing(['check', m6Lin]);
  check('v59.16:M6 直线复合赋值线性转移(+= -= *= 常量:good/plus 静默;bad 必须 M3042 反例 x = 2)',
    rm6l.code === 1 && (rm6l.stderr ?? '').includes('M3042') && (rm6l.stderr ?? '').includes('(反例:x = 2)')
    && !(rm6l.stderr ?? '').includes('"good"') && !(rm6l.stderr ?? '').includes('"plus"'),
    'code=' + rm6l.code + ' stderr=' + (rm6l.stderr ?? '').slice(0, 300));

  // ---- v59.12:--proof-report 契约摘要(additive;文本逐函数一行 + JSON summaries 数组)----
  // 链式语料:每个函数被调用点的 requires 都可证满足(h→g→f→main),ensures 均已证。
  const rsText = runMing(['check', chainOk, '--proof-report']);
  const lineOf = (fn) => (rsText.stdout ?? '').split('\n').find((l) => l.includes(`:${fn}: 契约摘要`)) ?? '';
  check('v59.12:--proof-report 文本契约摘要(每函数一行,链式调用点 1 可证)',
    rsText.code === 0
    && lineOf('h').endsWith(': 契约摘要 requires=完整 ensures=已证 调用点=1 可证, 0 违反')
    && lineOf('g').endsWith(': 契约摘要 requires=完整 ensures=已证 调用点=1 可证, 0 违反')
    && lineOf('f').endsWith(': 契约摘要 requires=完整 ensures=已证 调用点=1 可证, 0 违反'),
    'stdout=' + JSON.stringify((rsText.stdout ?? '').slice(0, 400)));
  const rsJson = JSON.parse(runMing(['check', chainOk, '--json', '--proof-report']).stdout);
  const sumOf = (j, fn) => j.proofs?.summaries?.find((s) => s.fn === fn);
  // v0.56(B1):additive `abs`(模块绝对路径)——报告按 abs+fn 去重;键序保持追加在 file 之后。
  check('v59.12:--json --proof-report 增加 summaries[{file,abs,fn,requires_present,requires_complete,ensures_present,ensures_proven,calls_proven,calls_violated}]',
    Array.isArray(rsJson.proofs?.summaries)
    && ['h', 'g', 'f'].every((fn) => {
      const s = sumOf(rsJson, fn);
      return s && typeof s.abs === 'string' && s.abs.length > 0
        && s.requires_present === true && s.requires_complete === true
        && s.ensures_present === true && s.ensures_proven === true && s.calls_proven === 1 && s.calls_violated === 0
        && JSON.stringify(Object.keys(s)) === JSON.stringify(['file', 'abs', 'fn', 'requires_present', 'requires_complete', 'ensures_present', 'ensures_proven', 'calls_proven', 'calls_violated']);
    }),
    JSON.stringify(rsJson.proofs?.summaries ?? null).slice(0, 400));

  // 可证违反语料:被调 g.requires 被调用点可证违反 → summaries.calls_violated=1;
  // 调用方 f 的 ensures 因调用后置未采用而未证。
  const repViol = mk('report_violation.ming', [
    'fn g(a: i64) -> i64 requires a >= 5 ensures (result == a + 1) { return a + 1; }',
    'fn f(a: i64) -> i64 requires a <= 3 ensures (result == a + 2) { let r = g(a); return r + 1; }',
    'fn main() with io { print(str(f(0))); }',
    '',
  ].join('\n'));
  const rvJson = JSON.parse(runMing(['check', repViol, '--json', '--proof-report']).stdout);
  const sg = sumOf(rvJson, 'g'), sf = sumOf(rvJson, 'f');
  check('v59.12:违反语料 summaries.calls_violated=1(被调 requires 可证违反);调用方 ensures 未证',
    sg && sg.calls_violated === 1 && sg.calls_proven === 0 && sg.requires_complete === true && sg.ensures_proven === true
    && sf && sf.calls_violated === 0 && sf.calls_proven === 1 && sf.ensures_proven === false,
    JSON.stringify([sg, sf]));

  // 状态三态:requires 含不可编码叶 → 不完整;循环/未证 ensures → 未证;无契约纯函数 → 无/无
  const repStates = mk('report_states.ming', [
    'fn none(a: i64) -> i64 { return a + 1; }',
    'fn inc(a: i64) -> i64 requires a % 2 == 0 ensures (result == a + 2) { if a == 0 { return 2; } return inc(a - 2) + 2; }',
    'fn main() with io { print(str(none(1)) + str(inc(0))); }',
    '',
  ].join('\n'));
  const rstat = runMing(['check', repStates, '--proof-report']);
  const statLine = (fn) => (rstat.stdout ?? '').split('\n').find((l) => l.includes(`:${fn}: 契约摘要`)) ?? '';
  check('v59.12:摘要状态三态(无契约 → 无/无;requires 不可编码 → 不完整;环 ensures → 未证)',
    rstat.code === 0
    && statLine('none').endsWith(': 契约摘要 requires=无 ensures=无 调用点=0 可证, 0 违反')
    && statLine('inc').endsWith(': 契约摘要 requires=不完整 ensures=未证 调用点=1 可证, 0 违反'),
    'stdout=' + JSON.stringify((rstat.stdout ?? '').slice(0, 400)));

  // M5(v0.55.0 审查):无契约函数 JSON 必须给出 requires_present/ensures_present=false,
  // 消费者不能仅凭 ensures_proven=true(无 ensures = 空后置条件)误判"已证 ensures"。
  const rstatJson = JSON.parse(runMing(['check', repStates, '--json', '--proof-report']).stdout);
  const snone = sumOf(rstatJson, 'none'), sinc = sumOf(rstatJson, 'inc');
  check('v59.12:JSON summaries 新增 requires_present/ensures_present(无契约 → false,不与 ensures_proven=true 混淆)',
    snone && snone.requires_present === false && snone.requires_complete === true && snone.ensures_present === false
    && sinc && sinc.requires_present === true && sinc.requires_complete === false && sinc.ensures_present === true,
    JSON.stringify([snone, sinc]));

  // 无旗标:JSON 无 proofs/summaries 键,文本 check 无摘要行(纯 additive)
  const rsPlain = runMing(['check', chainOk]);
  const rsPlainJson = JSON.parse(runMing(['check', chainOk, '--json']).stdout);
  check('v59.12:无旗标无摘要输出(文本空 + JSON 无 proofs/summaries 键)',
    rsPlain.code === 0 && rsPlain.stdout === '' && !('proofs' in rsPlainJson) && !('summaries' in rsPlainJson),
    'stdout=' + JSON.stringify(rsPlain.stdout) + ' keys=' + JSON.stringify(Object.keys(rsPlainJson)));
}


// ===================== 60. v0.56:tree 引擎作用域模型统一(#23 for-in 遮蔽泄漏 / #28 块作用域泄漏)+ fmt 契约保真(#36)=====================
// 根因:execBlock 复用调用方 env,For/WhileLet 直接写外层 env。修复后每次进入块建立子环境
// (childEnv),let/模式变量只写本层;赋值经 lookupVar 找到 owner,外层 mut 变量天然穿透。
{
  const dir = path.join(TMP, 'v56');
  fs.mkdirSync(dir, { recursive: true });
  const mk = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };
  // 三引擎对照:默认 VM+wasm / --no-wasm / --tree 的 stdout 必须与期望逐字一致
  const tri = (name, src, expected) => {
    const p = mk(name, src);
    const vm = runMing(['run', p]);
    const tree = runMing(['run', p, '--tree']);
    const noWasm = runMing(['run', p, '--no-wasm']);
    const ok = vm.code === 0 && tree.code === 0 && noWasm.code === 0
      && vm.stdout === expected && tree.stdout === expected && noWasm.stdout === expected;
    return {
      ok,
      detail: `vm=${vm.code}:${JSON.stringify(vm.stdout)} tree=${tree.code}:${JSON.stringify(tree.stdout)} `
        + `vm-only=${noWasm.code}:${JSON.stringify(noWasm.stdout)} expected=${JSON.stringify(expected)}\n`
        + `vm stderr=${(vm.stderr ?? '').slice(0, 200)}\ntree stderr=${(tree.stderr ?? '').slice(0, 200)}`,
    };
  };

  // ---- v60.1:#23 for-in 数值范围遮蔽不泄漏(外层 i 保持原值)----
  const r601 = tri('for_num_shadow.ming', [
    'fn main() with io {',
    '  let i = 100;',
    '  let mut acc = 0;',
    '  for i in 0..3 { acc += i; }',
    '  print(str(i));',
    '  print(str(acc));',
    '}',
    '',
  ].join('\n'), '100\n3\n');
  check('v60.1:for-in 数值范围循环变量遮蔽不外泄(外层 i=100;tree/VM/VM-only 逐字一致)', r601.ok, r601.detail);

  // ---- v60.2:#23 for-in str / Vec 迭代同样不泄漏 ----
  const r602 = tri('for_coll_shadow.ming', [
    'fn main() with io {',
    '  let s = "ab";',
    '  let mut acc = "";',
    '  for s in s { acc = acc + s + "-"; }',
    '  print(s);',
    '  print(acc);',
    '  let v = [7, 8];',
    '  for v in v { print(str(v)); }',
    '  print(str(v.len()));',
    '}',
    '',
  ].join('\n'), 'ab\na-b-\n7\n8\n2\n');
  check('v60.2:for-in str/Vec 迭代遮蔽不外泄(外层 s 与 v 恢复;三引擎逐字一致)', r602.ok, r602.detail);

  // ---- v60.3:#28 if 块 let 遮蔽(两分支形态;块外保持外层值)----
  const r603 = tri('if_shadow.ming', [
    'fn main() with io {',
    '  let x = 1;',
    '  if true { let x = 2; print(str(x)); } else { let x = 3; print(str(x)); }',
    '  if false { let x = 4; } else { let x = 5; print(str(x)); }',
    '  print(str(x));',
    '}',
    '',
  ].join('\n'), '2\n5\n1\n');
  check('v60.3:if 块 let 遮蔽不外泄(then/else 两分支;块外 x=1)', r603.ok, r603.detail);

  // ---- v60.4:#28 match 臂块 let 遮蔽 ----
  const r604 = tri('match_shadow.ming', [
    'fn main() with io {',
    '  let x = 1;',
    '  match 3 {',
    '    1 => { let x = 2; print(str(x)); }',
    '    _ => { let x = 3; print(str(x)); }',
    '  }',
    '  print(str(x));',
    '}',
    '',
  ].join('\n'), '3\n1\n');
  check('v60.4:match 臂内 let 遮蔽不外泄(臂外 x=1;三引擎逐字一致)', r604.ok, r604.detail);

  // ---- v60.5:#28 unsafe 块 let 遮蔽(块内无指针操作,三引擎可执行)----
  const r605 = tri('unsafe_shadow.ming', [
    'fn main() with io, unsafe {',
    '  let x = 1;',
    '  unsafe { let x = 2; print(str(x)); }',
    '  print(str(x));',
    '}',
    '',
  ].join('\n'), '2\n1\n');
  check('v60.5:unsafe 块 let 遮蔽不外泄(块外 x=1;三引擎逐字一致)', r605.ok, r605.detail);

  // ---- v60.6:#23 while-let 模式变量不逃逸(不得覆盖外层同名变量)----
  const r606 = tri('whilelet_scope.ming', [
    'fn main() with io {',
    '  let mut x = 10;',
    '  let mut q: Option[i64] = Some(4);',
    '  while let Some(x) = q {',
    '    print(str(x));',
    '    q = None;',
    '  }',
    '  print(str(x));',   // 外层 x 必须仍是 10(HEAD tree 曾被末次模式绑定覆盖为 4)
    '}',
    '',
  ].join('\n'), '4\n10\n');
  check('v60.6:while-let 模式变量不逃逸(外层同名 x=10 不被覆盖;与 VM 一致)', r606.ok, r606.detail);

  // ---- v60.7:嵌套块链式查找 + 外层赋值穿透 ----
  const r607 = tri('nested_assign.ming', [
    'fn main() with io {',
    '  let mut x = 1;',
    '  {',
    '    x = 2;',         // 穿透到函数级 mut x
    '    let x = 3;',     // 块内遮蔽
    '    print(str(x));',
    '    {',
    '      let x = 4;',   // 再嵌套一层遮蔽
    '      print(str(x));',
    '    }',
    '    print(str(x));',
    '  }',
    '  print(str(x));',     // 外层已被赋为 2
    '}',
    '',
  ].join('\n'), '3\n4\n3\n2\n');
  check('v60.7:嵌套块链式查找 + 外层赋值穿透(块内 3/4/3,块外 2)', r607.ok, r607.detail);

  // ---- v60.8:闭包跨块捕获(与 VM 相同的按值快照 + 最近绑定语义)----
  const r608 = tri('closure_block_capture.ming', [
    'fn main() with io {',
    '  let k = 10;',
    '  let mut f: () -> i64 = () => 0;',
    '  let mut g: () -> i64 = () => 0;',
    '  {',
    '    let k = 20;',
    '    f = () => k;',   // 捕获块内最近绑定
    '  }',
    '  g = () => k;',      // 捕获块外层绑定
    '  print(str(f()));',
    '  print(str(g()));',
    '}',
    '',
  ].join('\n'), '20\n10\n');
  check('v60.8:闭包跨块捕获(最近绑定按值快照:f=20,g=10;与 VM 确定性语义一致)', r608.ok, r608.detail);

  // ---- v60.9:#28 loop 块 let 遮蔽(execBlock 子环境覆盖 loop 体)----
  const r609 = tri('loop_shadow.ming', [
    'fn main() with io {',
    '  let x = 1;',
    '  loop {',
    '    let x = 2;',
    '    print(str(x));',
    '    break;',
    '  }',
    '  print(str(x));',
    '}',
    '',
  ].join('\n'), '2\n1\n');
  check('v60.9:loop 块 let 遮蔽不外泄(块外 x=1;三引擎逐字一致)', r609.ok, r609.detail);

  // ---- v60.10:#24 捕获闭包经 HOF(map)调用不再崩溃(默认 VM 崩溃的原始复现)----
  const r610 = tri('closure_hof_map.ming', [
    'fn main() with io {',
    '  let k = 10;',
    '  let v = [1, 2, 3];',
    '  let w = v.map((x: i64) => x * k);',
    '  print(str(w.get(0).unwrap()));',
    '  print(str(w.get(2).unwrap()));',
    '}',
    '',
  ].join('\n'), '10\n30\n');
  check('v60.10:#24 捕获闭包经 map 调用(原 TypeError 复现;三引擎逐字一致)', r610.ok, r610.detail);

  // ---- v60.11:#24 多层嵌套捕获(闭包返回闭包)经 HOF + 捕获值语义快照 ----
  const r611 = tri('closure_hof_nested.ming', [
    'fn main() with io {',
    '  let k = 10;',
    '  let mut m = 5;',
    '  let f = (x: i64) => x * k + m;',
    '  m = 99;',                       // 捕获后改外层:闭包读到创建时快照 5,不是 99
    '  let mkadd = (a: i64) => (b: i64) => a + b + k;',
    '  let add2 = mkadd(2);',
    '  let w = [1, 2].map((x: i64) => add2(x));',
    '  print(debug(w));',
    '  print(str(f(2)));',
    '}',
    '',
  ].join('\n'), '[13, 14]\n25\n');
  check('v60.11:#24 嵌套捕获经 HOF(闭包返回闭包)+ 捕获值语义快照(f(2)=25 非 119)', r611.ok, r611.detail);

  // ---- v60.12:#24 非捕获闭包/filter/fold/sort_by 与直接调用均不受影响 ----
  const r612 = tri('closure_hof_misc.ming', [
    'fn main() with io {',
    '  let v = [1, 2, 3, 4];',
    '  let ev = v.filter((x: i64) => x % 2 == 0);',
    '  print(debug(ev));',
    '  let g = (x: i64) => x + 1;',
    '  print(str(g(41)));',
    '  let k = 10;',
    '  print(str(v.fold(0, (acc: i64, x: i64) => acc + x * k)));',
    '  let mut a = [3, 1, 2];',
    '  a.sort_by((x: i64, y: i64) => x - y);',
    '  print(debug(a));',
    '}',
    '',
  ].join('\n'), '[2, 4]\n42\n100\n[1, 2, 3]\n');
  check('v60.12:#24 非捕获闭包 + filter/fold/sort_by + 直接调用(三引擎逐字一致)', r612.ok, r612.detail);

  // ---- v60.13:#33 requires 以裸标识结尾(后跟函数体 `{`)----
  const reqBareSrc = [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires buf.len() == n { return n; }',
    'fn main() with io {',
    '  print(str(f([1, 2, 3], 3)));',
    '}',
    '',
  ].join('\n');
  const reqBarePath = mk('contract_requires_bare.ming', reqBareSrc);
  const reqBareCheck = runMing(['check', reqBarePath]);
  const r613 = tri('contract_requires_bare_run.ming', reqBareSrc, '3\n');
  check('v60.13:#33 requires 裸标识尾随可解析(check=0 且三引擎运行一致)',
    reqBareCheck.code === 0 && r613.ok,
    `check=${reqBareCheck.code} stderr=${(reqBareCheck.stderr ?? '').slice(0, 200)}\n${r613.detail}`);

  // ---- v60.14:#33 ensures 裸标识尾随;加括号写法等价 ----
  const r614 = tri('contract_ensures_bare.ming', [
    'fn g(n: i64) -> i64 ensures result > n { return n + 1; }',
    'fn h(n: i64) -> i64 ensures (result > n) { return n + 1; }',
    'fn main() with io {',
    '  print(str(g(1)));',
    '  print(str(h(1)));',
    '}',
    '',
  ].join('\n'), '2\n2\n');
  check('v60.14:#33 ensures 裸标识尾随与括号写法等价(三引擎逐字一致)', r614.ok, r614.detail);

  // ---- v60.15:#33 普通位置 struct literal 回归 + 契约内嵌(带字段)struct literal ----
  const r615 = tri('contract_struct_lit.ming', [
    'struct S { x: i64, }',
    'fn mk(s: S) -> i64 { return s.x; }',
    'fn mks() -> S { return S { x: 7 }; }',
    'fn pos(s: S) -> i64 requires mk(S { x: s.x }) == s.x { return s.x; }',
    'fn main() with io {',
    '  let s = S { x: 1 };',
    '  print(str(mk(S { x: 2 })));',
    '  print(str(mks().x));',
    '  print(str(pos(S { x: 3 })));',
    '  print(str(s.x));',
    '}',
    '',
  ].join('\n'), '2\n7\n3\n1\n');
  check('v60.15:#33 struct literal 常态回归(构造/实参/返回/契约内嵌字段形态均可)', r615.ok, r615.detail);

  // ---- v60.16:#33 空结构体字面量 S {} 与空函数体 {} 的消歧(契约尾随两种形态)----
  const r616 = tri('contract_empty_brace.ming', [
    'struct E {}',
    'fn same(e: E) -> i64 requires e == E {} { return 1; }',
    'fn req(b: bool) requires b {}',
    'fn main() with io {',
    '  req(true);',
    '  print(str(same(E {})));',
    '}',
    '',
  ].join('\n'), '1\n');
  check('v60.16:#33 契约内 S {} 空字面量可解析,且空函数体 {}(尾随裸标识)不误判', r616.ok, r616.detail);

  // ---- v60.17:#36 requires/ensures(+else 消息)fmt 保真 ----
  const p6017 = mk('fmt_contract_fn.ming', [
    'fn f(n: i64) -> i64 requires n > 0 else "n must be positive" ensures result > n else "result must exceed n" { return n + 1; }',
    'fn main() with io {',
    '  print(str(f(1)));',
    '}',
    '',
  ].join('\n'));
  const f6017 = runMing(['fmt', p6017]);
  const sig6017 = (f6017.stdout.split('\n').find(l => l.startsWith('fn f(')) ?? '');
  const want6017 = 'fn f(n: i64) -> i64 requires n > 0 else "n must be positive" ensures result > n else "result must exceed n" {';
  check('v60.17:#36 requires/ensures(+else 消息)fmt 逐字保真',
    f6017.code === 0 && sig6017 === want6017,
    `code=${f6017.code} sig=${JSON.stringify(sig6017)}\nstderr=${(f6017.stderr ?? '').slice(0, 200)}`);
  fs.writeFileSync(p6017, f6017.stdout, 'utf8');
  const idem6017 = runMing(['fmt', p6017, '--check']);
  const chk6017 = runMing(['check', p6017]);
  const run6017 = runMing(['run', p6017]);
  check('v60.17:fmt 后二次 fmt 幂等 + check 0 + 运行 2',
    idem6017.code === 0 && chk6017.code === 0 && run6017.code === 0 && run6017.stdout === '2\n',
    `idem=${idem6017.code} check=${chk6017.code} run=${run6017.code}:${JSON.stringify(run6017.stdout)}\n`
    + `${(idem6017.stderr ?? '').slice(0, 150)}\n${(chk6017.stderr ?? '').slice(0, 150)}`);
  // fmt 后的 requires 运行时仍以 M4015 拒绝(实参经调用返回,静态不可判定)
  const p6017b = mk('fmt_contract_fn_viol.ming', [
    'fn pick(x: i64) -> i64 { return x - 2; }',
    'fn f(n: i64) -> i64 requires n > 0 else "n must be positive" { return n + 1; }',
    'fn main() with io {',
    '  let a = 1;',
    '  print(str(f(pick(a))));',
    '}',
    '',
  ].join('\n'));
  const f6017b = runMing(['fmt', p6017b]);
  fs.writeFileSync(p6017b, f6017b.stdout, 'utf8');
  const run6017b = runMing(['run', p6017b]);
  check('v60.17:fmt 后 requires 运行时仍 M4015(消息保真,exit 101)',
    f6017b.code === 0 && run6017b.code === 101
    && run6017b.stderr.includes('M4015') && run6017b.stderr.includes('n must be positive'),
    `fmt=${f6017b.code} run=${run6017b.code} err=${(run6017b.stderr ?? '').split('\n')[0]}`);

  // ---- v60.18:#36 struct invariant fmt 保真 + 运行时 invariant 违反仍 M4015 ----
  const p6018 = mk('fmt_contract_invariant.ming', [
    'struct S { x: i64, invariant x >= 0 }',
    'fn main() with io {',
    '  let k = 0;',
    '  let s = S { x: k };',
    '  print(str(s.x));',
    '}',
    '',
  ].join('\n'));
  const f6018 = runMing(['fmt', p6018]);
  const hasField6018 = f6018.stdout.includes('    x: i64,\n');
  const hasInv6018 = f6018.stdout.includes('    invariant x >= 0,\n');
  check('v60.18:#36 struct invariant fmt 保真(字段行 + invariant 行,逗号规范)',
    f6018.code === 0 && hasField6018 && hasInv6018,
    `code=${f6018.code} out=${JSON.stringify(f6018.stdout)}`);
  fs.writeFileSync(p6018, f6018.stdout, 'utf8');
  const idem6018 = runMing(['fmt', p6018, '--check']);
  const chk6018 = runMing(['check', p6018]);
  const run6018 = runMing(['run', p6018]);
  check('v60.18:invariant fmt 后二次 fmt 幂等 + check 0 + 正常运行',
    idem6018.code === 0 && chk6018.code === 0 && run6018.code === 0 && run6018.stdout === '0\n',
    `idem=${idem6018.code} check=${chk6018.code} run=${run6018.code}:${JSON.stringify(run6018.stdout)}\n`
    + `${(idem6018.stderr ?? '').slice(0, 150)}\n${(chk6018.stderr ?? '').slice(0, 150)}`);
  const p6018b = mk('fmt_contract_invariant_viol.ming', [
    'struct S { x: i64, invariant x >= 0 }',
    'fn main() with io {',
    '  let k = -1;',
    '  let s = S { x: k };',
    '  print(str(s.x));',
    '}',
    '',
  ].join('\n'));
  const f6018b = runMing(['fmt', p6018b]);
  fs.writeFileSync(p6018b, f6018b.stdout, 'utf8');
  const run6018b = runMing(['run', p6018b]);
  check('v60.18:fmt 后 invariant 违反运行时仍 M4015(exit 101)',
    f6018b.code === 0 && run6018b.code === 101
    && run6018b.stderr.includes('M4015') && run6018b.stderr.includes('invariant'),
    `fmt=${f6018b.code} run=${run6018b.code} err=${(run6018b.stderr ?? '').split('\n')[0]}`);

  // ---- v60.19:#36 多子句/换行缩进形态:parser 语义为"同类后者覆盖",fmt 归一化且行为不变 ----
  const p6019 = mk('fmt_contract_multi.ming', [
    'fn f(n: i64) -> i64',
    '    requires n > 0',
    '    requires n < 100',
    '    ensures result > n',
    '    ensures result < 101',
    '{',
    '    return n + 1;',
    '}',
    'fn main() with io {',
    '  let a = 3;',
    '  print(str(f(a)));',
    '}',
    '',
  ].join('\n'));
  const origRun6019 = runMing(['run', p6019]);
  const f6019 = runMing(['fmt', p6019]);
  const sig6019 = (f6019.stdout.split('\n').find(l => l.startsWith('fn f(')) ?? '');
  const want6019 = 'fn f(n: i64) -> i64 requires n < 100 ensures result < 101 {';
  const body6019 = f6019.stdout.includes('{\n    return n + 1;\n}');
  check('v60.19:#36 多子句按 parser 语义归一(同类后者覆盖)、多行签名并回一行、块首无空行',
    f6019.code === 0 && sig6019 === want6019 && body6019
    && !f6019.stdout.includes('n > 0') && !f6019.stdout.includes('result > n'),
    `code=${f6019.code} sig=${JSON.stringify(sig6019)} body=${body6019}\nout=${JSON.stringify(f6019.stdout)}`);
  fs.writeFileSync(p6019, f6019.stdout, 'utf8');
  const idem6019 = runMing(['fmt', p6019, '--check']);
  const chk6019 = runMing(['check', p6019]);
  const run6019 = runMing(['run', p6019]);
  check('v60.19:fmt 前后 stdout/退出码一致(4/4, 0/0)+ 二次 fmt 幂等 + check 0',
    origRun6019.code === 0 && origRun6019.stdout === '4\n'
    && run6019.code === 0 && run6019.stdout === '4\n' && idem6019.code === 0 && chk6019.code === 0,
    `orig=${origRun6019.code}:${JSON.stringify(origRun6019.stdout)} fmt=${run6019.code}:${JSON.stringify(run6019.stdout)} `
    + `idem=${idem6019.code} check=${chk6019.code}\n${(chk6019.stderr ?? '').slice(0, 150)}`);

  // ---- v60.20:#36 契约内复杂表达式(&&/调用/len()/result)语义不被 fmt 改写 ----
  const p6020 = mk('fmt_contract_complex.ming', [
    'fn is_even(k: i64) -> bool { return k % 2 == 0; }',
    'fn pick0(buf: Vec[i64], n: i64) -> i64',
    '  requires n > 0 && buf.len() == n && is_even(n)',
    '  ensures result >= 0 && result < buf.len()',
    '{',
    '    return 0;',
    '}',
    'fn main() with io {',
    '  print(str(pick0([2, 4], 2)));',
    '}',
    '',
  ].join('\n'));
  const origChk6020 = runMing(['check', p6020]);
  const origRun6020 = runMing(['run', p6020]);
  const f6020 = runMing(['fmt', p6020]);
  const sig6020 = (f6020.stdout.split('\n').find(l => l.startsWith('fn pick0(')) ?? '');
  const want6020 = 'fn pick0(buf: Vec[i64], n: i64) -> i64 requires n > 0 && buf.len() == n && is_even(n) ensures result >= 0 && result < buf.len() {';
  fs.writeFileSync(p6020, f6020.stdout, 'utf8');
  const chk6020 = runMing(['check', p6020]);
  const run6020 = runMing(['run', p6020]);
  const idem6020 = runMing(['fmt', p6020, '--check']);
  check('v60.20:#36 复杂契约表达式 fmt 逐字保真且 fmt 前后 check/run 一致',
    f6020.code === 0 && sig6020 === want6020
    && origChk6020.code === 0 && chk6020.code === 0
    && origRun6020.code === 0 && origRun6020.stdout === '0\n'
    && run6020.code === 0 && run6020.stdout === '0\n' && idem6020.code === 0,
    `fmt=${f6020.code} sig=${JSON.stringify(sig6020)} chk=${origChk6020.code}/${chk6020.code} `
    + `run=${origRun6020.code}:${JSON.stringify(origRun6020.stdout)}/${run6020.code}:${JSON.stringify(run6020.stdout)} idem=${idem6020.code}\n`
    + `${(f6020.stderr ?? '').slice(0, 200)}`);

  // ---- v60.21:#26 buildKey 补编译器源码指纹——--json 含 compiler_hash 且两次构建稳定 ----
  const bdir = path.join(TMP, 'v56-build-key');
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'ming.toml'), '[project]\nname = "v56bk"\nversion = "0.1.0"\nentry = "app.ming"\n');
  fs.writeFileSync(path.join(bdir, 'app.ming'), 'fn main() with io { print("bk"); }\n');
  const buildJ = (bin, cwd) => spawnSync(process.execPath, [bin, 'build', '--json'], { encoding: 'utf8', cwd, timeout: 120000 });
  const bj1r = buildJ(MING, bdir);
  const bj2r = buildJ(MING, bdir);
  let bj1 = null, bj2 = null;
  try { bj1 = JSON.parse(bj1r.stdout); bj2 = JSON.parse(bj2r.stdout); } catch { /* 断言处报错 */ }
  check('v60.21:#26 build --json 含 compiler_hash(32 hex),两次构建稳定且缓存命中键一致',
    bj1r.status === 0 && bj2r.status === 0 && !!bj1 && !!bj2
    && /^[0-9a-f]{32}$/.test(bj1.compiler_hash ?? '') && bj1.compiler_hash === bj2.compiler_hash
    && bj1.build_key === bj2.build_key && bj1.cache_hit === false && bj2.cache_hit === true,
    `codes=${bj1r.status}/${bj2r.status} ch1=${(bj1?.compiler_hash ?? '').slice(0, 8)} ch2=${(bj2?.compiler_hash ?? '').slice(0, 8)} `
    + `k1=${(bj1?.build_key ?? '').slice(0, 8)} k2=${(bj2?.build_key ?? '').slice(0, 8)} hit=${bj1?.cache_hit}/${bj2?.cache_hit}`);

  // ---- v60.22:#26 敏感性——改编译器源码(版本号不变)→ build_key 变化;恢复 → 键恢复 ----
  // v0.56(B2):指纹含 bin/*.js —— 单独改 bin/ming.js(launcher/build 逻辑)同样必须使键失效。
  // 仓库零依赖,bin/ming.js + src/ + package.json 可整体复制后独立运行(与 env -i 验收同一思路)。
  const ccopy = path.join(TMP, 'v56-compiler-copy');
  const cbin = path.join(ccopy, 'bin', 'ming.js');
  const csrc = path.join(ccopy, 'src');
  fs.mkdirSync(path.join(ccopy, 'bin'), { recursive: true });
  fs.copyFileSync(MING, cbin);
  fs.cpSync(path.join(ROOT, 'src'), csrc, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(ccopy, 'package.json'));
  const sdir = path.join(TMP, 'v56-sensitivity-proj');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'ming.toml'), '[project]\nname = "v56sens"\nversion = "0.1.0"\nentry = "app.ming"\n');
  fs.writeFileSync(path.join(sdir, 'app.ming'), 'fn main() with io { print("sens"); }\n');
  const keyOf = (r) => { try { return JSON.parse(r.stdout).build_key ?? null; } catch { return null; } };
  const sensT0 = Date.now();
  const s1r = buildJ(cbin, sdir);
  const s1 = keyOf(s1r);
  const probe = path.join(csrc, 'fmt.js');
  fs.appendFileSync(probe, '\n// v0.56(#26) compiler-hash sensitivity probe\n');
  const s2r = buildJ(cbin, sdir);
  const s2 = keyOf(s2r);
  fs.copyFileSync(path.join(ROOT, 'src', 'fmt.js'), probe); // 恢复原字节
  const s3r = buildJ(cbin, sdir);
  const s3 = keyOf(s3r);
  const sensMs = Date.now() - sensT0;
  check('v60.22:#26 改 src/*.js(版本不变)→ build_key 变化;恢复源 → 键恢复(内容决定)',
    s1r.status === 0 && s2r.status === 0 && s3r.status === 0
    && !!s1 && !!s2 && !!s3 && s1 !== s2 && s3 === s1,
    `ms=${sensMs} k1=${(s1 ?? '').slice(0, 8)} k2=${(s2 ?? '').slice(0, 8)} k3=${(s3 ?? '').slice(0, 8)} `
    + `codes=${s1r.status}/${s2r.status}/${s3r.status} err=${(s2r.stderr ?? '').slice(0, 160)}`);

  // ---- v60.22b(B2):单独改 bin/ming.js → build_key 变化;恢复 → 键恢复 ----
  fs.appendFileSync(cbin, '\n// v0.56(B2) bin compiler-hash sensitivity probe\n');
  const s4r = buildJ(cbin, sdir);
  const s4 = keyOf(s4r);
  fs.copyFileSync(MING, cbin); // 恢复原字节(再次运行即回归基线键)
  const s5r = buildJ(cbin, sdir);
  const s5 = keyOf(s5r);
  check('v60.22b(B2):改 bin/ming.js(版本不变)→ build_key 变化;恢复 → 键恢复',
    s4r.status === 0 && s5r.status === 0 && !!s4 && !!s5 && s4 !== s1 && s5 === s1,
    `k1=${(s1 ?? '').slice(0, 8)} k4=${(s4 ?? '').slice(0, 8)} k5=${(s5 ?? '').slice(0, 8)} `
    + `codes=${s4r.status}/${s5r.status} err=${(s4r.stderr ?? '').slice(0, 160)}`);

  // ---- v60.23:#25 fuzz wasm eligible 族真实执行(计数 > 0 且 0 分歧;首程序固定 wasm 族)----
  const fz56 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '4', '--seed', '56001'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v60.23:#25 fuzz 汇总含 wasm 真实执行计数(>0)且 0 分歧',
    fz56.status === 0 && /wasm 真实执行 [1-9]\d* 程序/.test(fz56.stdout ?? '') && /分歧 0/.test(fz56.stdout ?? ''),
    `code=${fz56.status} tail=${(fz56.stdout ?? '').slice(-180)} err=${(fz56.stderr ?? '').slice(0, 160)}`);

  // ---- v60.24:W1 wasm 一元负号 `-a` 栈序(0 - x)——三引擎逐字一致 ----
  // 根因:compileNum Unary 的 i64/u64 分支先压 x 后压 0,i64.sub 实际算 x - 0。
  const r6024 = tri('wasm_neg.ming', [
    'fn wf(a: i64) -> i64 { return -a; }',
    'fn main() with io { print(str(wf(3))); print(str(wf(-3))); print(str(wf(0))); }',
    '',
  ].join('\n'), '-3\n3\n0\n');
  check('v60.24:W1 wasm 一元负号 wf(a)=-a,a∈{3,-3,0} 三引擎逐字一致', r6024.ok, r6024.detail);

  // ---- v60.25:W1 负字面量比较(两侧)+ (-a)+b 组合 ----
  const r6025 = tri('wasm_neg_cmp.ming', [
    'fn wneg(a: i64) -> i64 {',
    '  let mut t = 0;',
    '  if a > -5 { t = t + 1; } else { t = t + 2; }',
    '  t = t + (-a);',
    '  return t;',
    '}',
    'fn lhs(a: i64) -> i64 { if -5 < a { return 1; } return 0; }',
    'fn comb(a: i64, b: i64) -> i64 { return (-a) + b; }',
    'fn main() with io {',
    '  print(str(wneg(3)) + " " + str(wneg(-7)) + " " + str(wneg(0)));',
    '  print(str(lhs(3)) + " " + str(lhs(-7)));',
    '  print(str(comb(3, 10)));',
    '}',
    '',
  ].join('\n'), '-2 9 1\n1 0\n7\n');
  check('v60.25:W1 负字面量参与比较(两侧)与 (-a)+b 组合三引擎一致', r6025.ok, r6025.detail);

  // ---- v60.26:W2 while 体内 if 中的 break——br 深度必须计入 if 块 ----
  // 修复前 wasm 的 br 1 只到 if 末尾 → 循环继续 → 死循环(runMing timeout 30s 捕获)。
  const r6026 = tri('wasm_break.ming', [
    'fn brk() -> i64 {',
    '  let mut i = 0;',
    '  while i < 5 { if i == 3 { break; } i += 1; }',
    '  return i;',
    '}',
    'fn main() with io { print(str(brk())); }',
    '',
  ].join('\n'), '3\n');
  check('v60.26:W2 while 体内 if break 跳出正确层级(三引擎一致,死循环由 30s 超时拦截)', r6026.ok, r6026.detail);

  // ---- v60.27:W2 continue——任务形态(% 条件)+ wasm eligible 形态(== 条件)----
  // 注:F2(v0.56)已修复 wasm inferNumType 的 Binary 重复 case,`%` 条件类型推导正常;
  // 本用例同时断言 strict 存活(`[wasm] fn cont OK`,无 REJECT/实例化失败),不再只验回落一致。
  const p6027a = mk('wasm_continue_task.ming', [
    'fn cont() -> i64 {',
    '  let mut i = 0; let mut s = 0;',
    '  while i < 10 {',
    '    i += 1;',
    '    if i % 2 == 0 { continue; }',
    '    if i > 6 { break; }',
    '    s += i;',
    '  }',
    '  return s;',
    '}',
    'fn main() with io { print(str(cont())); }',
    '',
  ].join('\n'));
  const r6027a = tri('wasm_continue_task.ming', fs.readFileSync(p6027a, 'utf8'), '9\n');
  const r6027aStrict = runMing(['run', p6027a, '--strict-wasm'], { env: { MING_WASM_DEBUG: '1' } });
  check('v60.27a:W2 任务形态(% 条件 continue + break)三引擎一致且终止;strict 下 cont 真实经 wasm',
    r6027a.ok && r6027aStrict.code === 0
    && (r6027aStrict.stderr ?? '').includes('[wasm] fn cont OK')
    && !(r6027aStrict.stderr ?? '').includes('REJECT') && !(r6027aStrict.stderr ?? '').includes('实例化失败'),
    `${r6027a.detail}\nstrict=${r6027aStrict.code} dbg=${JSON.stringify((r6027aStrict.stderr ?? '').slice(0, 240))}`);
  const r6027b = tri('wasm_continue.ming', [
    'fn cont2() -> i64 {',
    '  let mut i = 0; let mut s = 0;',
    '  while i < 5 { i += 1; if i == 2 { continue; } s += i; }',
    '  return s;',
    '}',
    'fn main() with io { print(str(cont2())); }',
    '',
  ].join('\n'), '13\n');
  check('v60.27b:W2 wasm eligible continue(if i==2)语义正确且三引擎一致', r6027b.ok, r6027b.detail);

  // ---- v60.28:W2 嵌套 while/if——内层 break 只跳出内层 ----
  const r6028 = tri('wasm_nested_break.ming', [
    'fn nested() -> i64 {',
    '  let mut i = 0; let mut s = 0;',
    '  while i < 3 {',
    '    i += 1;',
    '    if i == 2 {',
    '      let mut j = 0;',
    '      while j < 5 { if j == 1 { break; } j += 1; }',
    '      s += j;',
    '    }',
    '    s += i;',
    '  }',
    '  return s;',
    '}',
    'fn main() with io { print(str(nested())); }',
    '',
  ].join('\n'), '7\n');
  check('v60.28:W2 嵌套 while/if 内层 break 只跳出内层(外层继续;s=7)', r6028.ok, r6028.detail);

  // ---- v60.29:W1/W2 wasm 存活断言——真正经 wasm 执行而非静默回落 ----
  // MING_WASM_DEBUG=1 + --strict-wasm(回落 → exit 2):wf/brk/cont2/nested 全部 OK、
  // 有 [wasm 参数](实际调用)、无 REJECT/实例化失败。
  const p6029 = mk('wasm_live.ming', [
    'fn wf(a: i64) -> i64 { return -a; }',
    'fn brk() -> i64 { let mut i = 0; while i < 5 { if i == 3 { break; } i += 1; } return i; }',
    'fn cont2() -> i64 { let mut i = 0; let mut s = 0; while i < 5 { i += 1; if i == 2 { continue; } s += i; } return s; }',
    'fn nested() -> i64 {',
    '  let mut i = 0; let mut s = 0;',
    '  while i < 3 { i += 1; if i == 2 { let mut j = 0; while j < 5 { if j == 1 { break; } j += 1; } s += j; } s += i; }',
    '  return s;',
    '}',
    'fn main() with io { print(str(wf(3)) + " " + str(brk()) + " " + str(cont2()) + " " + str(nested())); }',
    '',
  ].join('\n'));
  const live6029 = runMing(['run', p6029, '--strict-wasm'], { env: { MING_WASM_DEBUG: '1' } });
  const liveErr = live6029.stderr ?? '';
  const liveFns = ['wf', 'brk', 'cont2', 'nested'].map(n => liveErr.includes(`[wasm] fn ${n} OK`));
  check('v60.29:W1/W2 函数真实经 wasm 执行(--strict-wasm 存活 + [wasm 参数] + 无 REJECT/实例化失败)',
    live6029.code === 0 && live6029.stdout === '-3 3 13 7\n'
    && liveFns.every(Boolean) && liveErr.includes('[wasm 参数]')
    && !liveErr.includes('REJECT') && !liveErr.includes('实例化失败'),
    `code=${live6029.code} stdout=${JSON.stringify(live6029.stdout)} fns=${JSON.stringify(liveFns)}\n`
    + liveErr.slice(0, 400));

  // ---- v60.30:F1 for-in 体内 continue(条件为外层变量)——不得跳过 __i 自增 ----
  // 修复前 wasm 的 continue 直接 br 到 loop 头,跳过循环尾 __i += 1 → 死循环(超时拦截);
  // 修复后自增在 loop 头,continue 回头部先自增再判界。fc 为 Vec 形参 helper(wasm eligible),
  // main 另用 Vec 字面量覆盖默认/树/VM-only 三腿。
  const src6030 = [
    'fn fc(v: Vec[i64], k: i64) -> i64 {',
    '  let mut s = 0;',
    '  for x in v {',
    '    if k == 0 { continue; }',
    '    s += x;',
    '  }',
    '  return s;',
    '}',
    'fn main() with io {',
    '  let v = [1, 2, 3];',
    '  let mut t = 0;',
    '  for y in [10, 20] {',
    '    if t > 0 { continue; }',
    '    t += y;',
    '  }',
    '  print(str(fc(v, 0)));',
    '  print(str(fc(v, 1)));',
    '  print(str(t));',
    '}',
    '',
  ].join('\n');
  const r6030 = tri('wasm_for_continue.ming', src6030, '0\n6\n10\n');
  const p6030 = mk('wasm_for_continue_live.ming', src6030);
  const live6030 = runMing(['run', p6030, '--strict-wasm'], { env: { MING_WASM_DEBUG: '1' } });
  const err6030 = live6030.stderr ?? '';
  check('v60.30:F1 for-in 体内 continue(外层变量条件)三引擎一致且终止;fc 真实经 wasm 执行',
    r6030.ok && live6030.code === 0 && live6030.stdout === '0\n6\n10\n'
    && err6030.includes('[wasm] fn fc OK') && err6030.includes('[wasm 参数]')
    && !err6030.includes('REJECT') && !err6030.includes('实例化失败'),
    `${r6030.detail}\nlive=${live6030.code}:${JSON.stringify(live6030.stdout)}\n${err6030.slice(0, 300)}`);

  // ---- v60.31:F1 for-in 体内 continue(条件含循环变量)+ break 组合 ----
  // `if x % 2 == 0 { continue; }` 同时依赖 F2 类型推导(模式变量 slot 类型)与 F1 目标重定向;
  // fcb 在 x>5 break,fb 在 x==4 break,均只跳出整个 for。
  const src6031 = [
    'fn fcb(v: Vec[i64]) -> i64 {',
    '  let mut s = 0;',
    '  for x in v {',
    '    if x % 2 == 0 { continue; }',
    '    if x > 5 { break; }',
    '    s += x;',
    '  }',
    '  return s;',
    '}',
    'fn fb(v: Vec[i64]) -> i64 {',
    '  let mut s = 0;',
    '  for x in v {',
    '    if x == 2 { continue; }',
    '    if x == 4 { break; }',
    '    s += x;',
    '  }',
    '  return s;',
    '}',
    'fn main() with io {',
    '  let v = [1, 2, 3, 4, 6, 9];',
    '  print(str(fcb(v)));',
    '  print(str(fb(v)));',
    '}',
    '',
  ].join('\n');
  const r6031 = tri('wasm_for_continue_var.ming', src6031, '4\n4\n');
  const p6031 = mk('wasm_for_continue_var_live.ming', src6031);
  const live6031 = runMing(['run', p6031, '--strict-wasm'], { env: { MING_WASM_DEBUG: '1' } });
  const err6031 = live6031.stderr ?? '';
  check('v60.31:F1 for-in continue(循环变量条件)+ break 三引擎一致;fcb/fb 真实经 wasm 执行',
    r6031.ok && live6031.code === 0 && live6031.stdout === '4\n4\n'
    && ['fcb', 'fb'].every(n => err6031.includes(`[wasm] fn ${n} OK`))
    && err6031.includes('[wasm 参数]')
    && !err6031.includes('REJECT') && !err6031.includes('实例化失败'),
    `${r6031.detail}\nlive=${live6031.code}:${JSON.stringify(live6031.stdout)}\n${err6031.slice(0, 300)}`);

  // ---- v60.32:F2 inferNumType 合并 Binary case——`%` 等条件真实经 wasm ----
  // 修复前重复 case 使非 `+` 二元推导 undefined → "条件操作数 undefined" 整模块回落。
  // 修复后 `i % 2 == 0`、`i * 2 - i / 2`、`i % 3` 的类型均正确推出,且 gm 实跑 wasm。
  const src6032 = [
    'fn gm(i: i64) -> i64 {',
    '  let mut s = 0;',
    '  if i % 2 == 0 { s += 1; }',
    '  s += i * 2 - i / 2;',
    '  let q = i % 3;',
    '  if q == 0 { s += 10; }',
    '  return s;',
    '}',
    'fn main() with io {',
    '  print(str(gm(4)));',
    '  print(str(gm(5)));',
    '  print(str(gm(6)));',
    '}',
    '',
  ].join('\n');
  const r6032 = tri('wasm_mod_cond.ming', src6032, '7\n8\n20\n');
  const p6032 = mk('wasm_mod_cond_live.ming', src6032);
  const live6032 = runMing(['run', p6032, '--strict-wasm'], { env: { MING_WASM_DEBUG: '1' } });
  const err6032 = live6032.stderr ?? '';
  check('v60.32:F2 `%`/`*`/`-`/`/` 条件与运算类型推导正确且 gm 真实经 wasm 执行(无 REJECT)',
    r6032.ok && live6032.code === 0 && live6032.stdout === '7\n8\n20\n'
    && err6032.includes('[wasm] fn gm OK') && err6032.includes('[wasm 参数]')
    && !err6032.includes('REJECT') && !err6032.includes('实例化失败'),
    `${r6032.detail}\nlive=${live6032.code}:${JSON.stringify(live6032.stdout)}\n${err6032.slice(0, 300)}`);

  // ---- v60.33:#22 else/else-if 头行尾注释一遍到定点(HEAD 需两遍)----
  const p6033 = mk('fmt_else_comment.ming', [
    'fn main() with io {',
    '    let x = 2;',
    '    if x == 0 {',
    '        print("a");',
    '    } else if x == 1 { // 二号',
    '        print("b");',
    '    } else { // 兜底',
    '        print("c");',
    '    }',
    '}',
    '',
  ].join('\n'));
  const f6033a = runMing(['fmt', p6033]);
  const out6033 = f6033a.stdout;
  fs.writeFileSync(p6033, out6033, 'utf8');
  const f6033b = runMing(['fmt', p6033]); // 已到定点 → 无输出
  const c6033 = runMing(['fmt', p6033, '--check']);
  check('v60.33:#22 else/else-if 头行尾注释一遍到定点(空行在注释前,注释保留,二次 fmt 零输出)',
    f6033a.code === 0
    && out6033.includes('} else if x == 1 {\n\n        // 二号')
    && out6033.includes('} else {\n\n        // 兜底')
    && f6033b.code === 0 && f6033b.stdout === '' && c6033.code === 0,
    `fmt=${f6033a.code} second=${JSON.stringify(f6033b.stdout)} check=${c6033.code}\n`
    + `out=${JSON.stringify(out6033)}\n${(c6033.stderr ?? '').slice(0, 200)}`);
  // 无头注释的 else 输出保持既有规范(头行后空行),验证修复不改变普通形态
  const p6033b = mk('fmt_else_plain_v56.ming', [
    'fn main() with io {',
    '    if true {',
    '        print("a");',
    '    } else {',
    '        print("b");',
    '    }',
    '}',
    '',
  ].join('\n'));
  const plain6033 = runMing(['fmt', p6033b]);
  check('v60.33:#22 无头注释的 else 规范形态零漂移(头行后保留空行)',
    plain6033.code === 0 && plain6033.stdout.includes('} else {\n\n        print("b");'),
    `code=${plain6033.code} out=${JSON.stringify(plain6033.stdout)}`);

  // ---- v60.34:#29 源码回退 launcher panic 带 file:line:col + 源码摘录 ----
  const pd6034 = path.join(dir, 'src-fallback-panic');
  fs.mkdirSync(pd6034, { recursive: true });
  fs.writeFileSync(path.join(pd6034, 'ming.toml'), '[project]\nname = "v56sf"\nversion = "0.1.0"\nentry = "app.ming"\n');
  const panic6034 = [
    'fn main() with io, sync {',
    '  let a = 10;',
    '  let b = 0;',
    '  print(str(a / b));',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(pd6034, 'app.ming'), panic6034);
  const b6034 = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: pd6034, timeout: 120000 });
  const fallback6034 = b6034.status === 0
    && fs.existsSync(path.join(pd6034, 'dist', 'app.ming'))
    && !fs.existsSync(path.join(pd6034, 'dist', 'app.bytecode.json'));
  const r6034 = fallback6034
    ? spawnSync(process.execPath, [path.join(pd6034, 'dist', 'ming-app.mjs')], { encoding: 'utf8', timeout: 60000 })
    : { status: -1, stdout: '', stderr: '' };
  const err6034 = r6034.stderr ?? '';
  check('v60.34:#29 源码回退 launcher panic 含 file:line:col + M4004 + 源码摘录(exit 101)',
    fallback6034 && r6034.status === 101
    && /app\.ming:\d+:\d+: error M4004\[division-by-zero\]/.test(err6034)
    && err6034.includes('print(str(a / b));'),
    `build=${b6034.status} fallback=${fallback6034} run=${r6034.status}\n`
    + `out=${JSON.stringify(r6034.stdout)} err=${JSON.stringify(err6034.slice(0, 400))}`);
  // AOT 字节码模式输出逐字不变(仅 `CODE: 消息`,无位置前缀)
  const pd6034b = path.join(dir, 'aot-panic');
  fs.mkdirSync(pd6034b, { recursive: true });
  fs.writeFileSync(path.join(pd6034b, 'ming.toml'), '[project]\nname = "v56ap"\nversion = "0.1.0"\nentry = "app.ming"\n');
  fs.writeFileSync(path.join(pd6034b, 'app.ming'), [
    'fn main() with io {',
    '  let a = 10;',
    '  let b = 0;',
    '  print(str(a / b));',
    '}',
    '',
  ].join('\n'));
  const b6034b = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: pd6034b, timeout: 120000 });
  const aot6034 = fs.existsSync(path.join(pd6034b, 'dist', 'app.bytecode.json'));
  const r6034b = aot6034
    ? spawnSync(process.execPath, [path.join(pd6034b, 'dist', 'ming-app.mjs')], { encoding: 'utf8', timeout: 60000 })
    : { status: -1, stdout: '', stderr: '' };
  check('v60.34:#29 AOT 字节码模式 panic 输出逐字不变(仍为 `M4004: 消息`)',
    b6034b.status === 0 && aot6034 && r6034b.status === 101
    && (r6034b.stderr ?? '').split('\n')[0] === 'M4004: 整数除零:10 / 0',
    `build=${b6034b.status} aot=${aot6034} run=${r6034b.status} err=${JSON.stringify((r6034b.stderr ?? '').split('\n')[0])}`);

  // ---- v60.35:#30 extern fn 值经局部变量:C 后端明确诊断(选择方案 b)----
  const p6035 = mk('cc_extern_value.ming', [
    'extern "msvcrt" fn _abs64(x: i64) -> i64;',
    'fn main() with io, ffi {',
    '  let q = _abs64;',
    '  print(str(q(-7)));',
    '}',
    '',
  ].join('\n'));
  const chk6035 = runMing(['check', p6035]);
  const vm6035 = runMing(['run', p6035]);
  const cc6035 = runMing(['cc', p6035, '--no-run', '--out', path.join(dir, 'cc-extern-value')]);
  const ccErr6035 = cc6035.stderr ?? '';
  check('v60.35:#30 extern fn 值经局部变量:C 后端明确诊断(不再"let 推导 null"),VM 诚实 M4001',
    chk6035.code === 0
    && vm6035.code === 101 && (vm6035.stderr ?? '').includes('ffi 调用需要 C 后端')
    && cc6035.code === 1 && ccErr6035.includes('extern fn 值') && ccErr6035.includes('请直接调用')
    && !ccErr6035.includes('let 推导 null'),
    `check=${chk6035.code} vm=${vm6035.code} cc=${cc6035.code}\n`
    + `vmErr=${JSON.stringify((vm6035.stderr ?? '').split('\n')[0])}\nccErr=${JSON.stringify(ccErr6035.split('\n')[0])}`);

  // ---- v60.36:#31 多入口共享模块 proof-report 按绝对路径去重 ----
  const d6036 = path.join(dir, 'report-dedupe');
  fs.mkdirSync(d6036, { recursive: true });
  fs.writeFileSync(path.join(d6036, 'shared.ming'), [
    'pub fn inc(a: i64) -> i64 requires a > 0 ensures result > a {',
    '    return a + 1;',
    '}',
    'pub fn pick(buf: Vec[i64], i: i64) -> i64 requires i >= 0 && i < buf.len() {',
    '    return buf[i];',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(d6036, 'main.ming'), [
    'use shared;',
    'fn main() with io {',
    '    print(str(shared.inc(1)));',
    '    print(str(shared.pick([1, 2], 0)));',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(d6036, 'lib.ming'), [
    'use shared;',
    'pub fn use_it(v: Vec[i64]) -> i64 {',
    '    return shared.inc(shared.pick(v, 0));',
    '}',
    '',
  ].join('\n'));
  const main6036 = path.join(d6036, 'main.ming');
  const lib6036 = path.join(d6036, 'lib.ming');
  const rep6036 = runMing(['check', main6036, lib6036, '--proof-report']);
  const repLines6036 = (rep6036.stdout ?? '').split('\n');
  const incLines6036 = repLines6036.filter(l => l.includes(':inc: 契约摘要'));
  const pickLines6036 = repLines6036.filter(l => l.includes(':pick: 义务'));
  let repJson6036 = null;
  try { repJson6036 = JSON.parse(runMing(['check', main6036, lib6036, '--json', '--proof-report']).stdout); } catch { /* 断言处报错 */ }
  const sumInc6036 = (repJson6036?.proofs?.summaries ?? []).filter(s => s.fn === 'inc');
  const fnPick6036 = (repJson6036?.proofs?.functions ?? []).filter(f => f.fn === 'pick');
  check('v60.36:#31 多入口共享模块 proof-report 去重(文本/JSON 摘要与义务各一份)',
    rep6036.code === 0 && incLines6036.length === 1 && pickLines6036.length === 1
    && sumInc6036.length === 1 && fnPick6036.length === 1,
    `code=${rep6036.code} inc=${incLines6036.length} pick=${pickLines6036.length} `
    + `jsonInc=${sumInc6036.length} jsonPick=${fnPick6036.length}\n`
    + `out=${JSON.stringify((rep6036.stdout ?? '').slice(0, 300))}`);
  const repOne6036 = runMing(['check', main6036, '--proof-report']);
  let repOneJson6036 = null;
  try { repOneJson6036 = JSON.parse(runMing(['check', main6036, '--json', '--proof-report']).stdout); } catch { /* 断言处报错 */ }
  const oneLines6036 = (repOne6036.stdout ?? '').split('\n');
  check('v60.36:#31 单入口行为不变(摘要/义务各一行,JSON 各一条)',
    repOne6036.code === 0
    && oneLines6036.filter(l => l.includes(':inc: 契约摘要')).length === 1
    && oneLines6036.filter(l => l.includes(':pick: 义务')).length === 1
    && (repOneJson6036?.proofs?.summaries ?? []).filter(s => s.fn === 'inc').length === 1
    && (repOneJson6036?.proofs?.functions ?? []).filter(f => f.fn === 'pick').length === 1,
    `code=${repOne6036.code} out=${JSON.stringify((repOne6036.stdout ?? '').slice(0, 300))}`);

  // ---- v60.37:#32 无契约模块跳过摘要构建;有契约模块报告不变 ----
  const many6037 = [];
  for (let i = 0; i < 150; i++) many6037.push(`fn f${i}(x: i64) -> i64 { return x + ${i}; }`);
  many6037.push('fn main() with io { print(str(f0(1))); }', '');
  const p6037 = mk('nocontract_many.ming', many6037.join('\n'));
  const t6037 = Date.now();
  const rep6037 = runMing(['check', p6037, '--proof-report']);
  const ms6037 = Date.now() - t6037;
  let repJson6037 = null;
  try { repJson6037 = JSON.parse(runMing(['check', p6037, '--json', '--proof-report']).stdout); } catch { /* 断言处报错 */ }
  check('v60.37:#32 无契约模块跳过摘要构建(check 0 诊断;--proof-report 无摘要/证明条目)',
    rep6037.code === 0 && (rep6037.stdout ?? '') === ''
    && Array.isArray(repJson6037?.proofs?.summaries) && repJson6037.proofs.summaries.length === 0
    && Array.isArray(repJson6037?.proofs?.functions) && repJson6037.proofs.functions.length === 0
    && (repJson6037?.diagnostics ?? []).length === 0,
    `code=${rep6037.code} ms=${ms6037} out=${JSON.stringify((rep6037.stdout ?? '').slice(0, 120))}`);
  const repContract6037 = runMing(['check', path.join(d6036, 'shared.ming'), '--proof-report']);
  check('v60.37:#32 有契约模块摘要报告不变(inc 摘要 + pick 义务各就位)',
    repContract6037.code === 0
    && (repContract6037.stdout ?? '').includes(':inc: 契约摘要 requires=完整 ensures=已证')
    && (repContract6037.stdout ?? '').includes(':pick: 义务 1,proven 1,violated 0,unproven 0'),
    `code=${repContract6037.code} out=${JSON.stringify((repContract6037.stdout ?? '').slice(0, 300))}`);

  // ---- v60.38:#34 分节号唯一化(无重复 34–38;34b–38b 与 40 就位)----
  const selfSrc6038 = fs.readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');
  const heads6038 = [];
  for (const line of selfSrc6038.split('\n')) {
    const m = line.match(/^\/\/ ===================== ([0-9]+[a-z]?)\./);
    if (m) heads6038.push(m[1]);
  }
  const dup6038 = heads6038.filter((h, i) => heads6038.indexOf(h) !== i);
  check('v60.38:#34 分节号唯一(无重复;34b–38b + 40 已就位,§39/§40 文档引用不变)',
    dup6038.length === 0
    && ['34b', '35b', '36b', '37b', '38b', '39', '40', '41'].every(h => heads6038.includes(h)),
    `dups=${JSON.stringify(dup6038)} heads=${JSON.stringify(heads6038.filter(h => /^3[4-9]|^40|^41/.test(h)))}`);

  // ================= A 组(v0.56 独立审查):契约作用域 / u64 一元负号 / fmt 契约保真 =================
  // 三引擎失败用例:exit 101 + M4015 + 关键实际值,且三份 stderr 逐字一致。
  const triFail = (name, src, needle) => {
    const p = mk(name, src);
    const runs = [
      runMing(['run', p]),
      runMing(['run', p, '--tree']),
      runMing(['run', p, '--no-wasm']),
    ];
    const first = (r) => (r.stderr ?? '').split('\n').find(l => l.includes('M4015')) ?? '';
    const ok = runs.every(r => r.code === 101 && (r.stderr ?? '').includes('M4015') && (r.stderr ?? '').includes(needle)
      && r.stderr === runs[0].stderr && r.stdout === runs[0].stdout);
    return { ok, detail: `codes=${JSON.stringify(runs.map(r => r.code))} stdout=${JSON.stringify(runs.map(r => r.stdout))}\n`
      + `vm=${JSON.stringify(first(runs[0]))}\ntree=${JSON.stringify(first(runs[1]))}\nvm-only=${JSON.stringify(first(runs[2]))}` };
  };
  // C 腿可用性(与 §58 同款探测;无编译器时 C 断言跳过,保持绿)
  const ccAvailA = (() => {
    if (process.env.MING_CC && fs.existsSync(process.env.MING_CC)) return true;
    for (const c of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
      if (fs.existsSync(c)) return true;
    }
    return spawnSync('gcc', ['--version'], { encoding: 'utf8' }).status === 0;
  })();

  // ---- v60.39(A1):body 的 `let a` 不得遮蔽形参——ensures 看形参值 ----
  const r6039 = triFail('a1_param_shadow.ming', [
    'fn f(a: i64) -> i64 ensures result > a { let a = 0; return 1; }',
    'fn main() with io { print(str(f(5))); }',
    '',
  ].join('\n'), '实际: 1');
  check('v60.39(A1):`let a` 遮蔽形参不影响 ensures(1 > 5 违反;三引擎 M4015 逐字一致)', r6039.ok, r6039.detail);

  // ---- v60.40(A1):形参名 result——函数体用形参,契约 result 恒指返回值 ----
  const r6040a = tri('a1_param_result_ok.ming', [
    'fn f(result: i64) -> i64 ensures result > 0 { return result; }',
    'fn main() with io { print(str(f(5))); }',
    '',
  ].join('\n'), '5\n');
  const r6040b = triFail('a1_param_result_bad.ming', [
    'fn f(result: i64) -> i64 ensures result > 0 { return result; }',
    'fn main() with io { print(str(f(5))); print(str(f(-1))); }',
    '',
  ].join('\n'), '实际: -1');
  check('v60.40(A1):形参名 result(VM 不再 TypeError;body=形参,契约=返回值)',
    r6040a.ok && r6040b.ok, `${r6040a.detail}\n${r6040b.detail}`);

  // ---- v60.41(A1):body 的 `let result` 不得被契约读取(契约 result=返回值) ----
  const r6041 = triFail('a1_local_result.ming', [
    'fn f(a: i64) -> i64 ensures result > 100 { let result = 200; return a; }',
    'fn main() with io { print(str(f(5))); }',
    '',
  ].join('\n'), '实际: 5');
  check('v60.41(A1):body `let result` 与契约无关(实际返回值 5,不是 200;三引擎一致)', r6041.ok, r6041.detail);

  // ---- v60.42(A1):mut 形参被重赋值 → 契约看形参最终值(v0.49 语义) ----
  const r6042a = triFail('a1_mut_param_bad.ming', [
    'fn f(mut a: i64) -> i64 ensures result > a { if a == 1 { a = 10; } return 5; }',
    'fn main() with io { print(str(f(1))); }',
    '',
  ].join('\n'), '实际: 5');
  const r6042b = tri('a1_mut_param_ok.ming', [
    'fn f(mut a: i64) -> i64 ensures result > a { if a == 1 { a = 2; } return 5; }',
    'fn main() with io { print(str(f(1))); print(str(f(3))); }',
    '',
  ].join('\n'), '5\n5\n');
  check('v60.42(A1):mut 形参重赋值后 ensures 看最终值(5>10 违反 / 5>2 与 5>3 通过)', r6042a.ok && r6042b.ok,
    `${r6042a.detail}\n${r6042b.detail}`);

  // ---- v60.43(A1):嵌套块局部 result + 契约调用模块级纯函数 ----
  const r6043a = triFail('a1_nested_result.ming', [
    'fn f(a: i64) -> i64 ensures result > 100 {',
    '  if a > 0 { let result = 200; return a; }',
    '  return a;',
    '}',
    'fn main() with io { print(str(f(5))); }',
    '',
  ].join('\n'), '实际: 5');
  const r6043b = tri('a1_module_fn.ming', [
    'fn twice(x: i64) -> i64 { return x * 2; }',
    'fn f(a: i64) -> i64 ensures result > twice(a) { let a = 0; return 6; }',
    'fn main() with io { print(str(f(2))); }',
    '',
  ].join('\n'), '6\n');
  check('v60.43(A1):嵌套块 `let result` 不泄漏进契约;契约可调用模块级纯函数且 body 局部不遮蔽',
    r6043a.ok && r6043b.ok, `${r6043a.detail}\n${r6043b.detail}`);

  // ---- v60.44(A2):u64 一元负号在类型层拒绝(M3008),四入口一致 ----
  const p6044 = mk('u64_neg_reject.ming', [
    'fn f(a: u64) -> u64 { return -a; }',
    'fn main() with io { print(str(f(1u64))); }',
    '',
  ].join('\n'));
  const chk6044 = runMing(['check', p6044]);
  const run6044 = [[], ['--tree'], ['--no-wasm']].map(fl => runMing(['run', p6044, ...fl]));
  const cc6044 = ccAvailA ? runMing(['cc', p6044]) : null;
  const cast6044 = tri('u64_neg_cast_ok.ming', [
    'fn f(a: u64) -> i64 { return -(a as i64); }',
    'fn main() with io { print(str(f(3u64))); }',
    '',
  ].join('\n'), '-3\n');
  check('v60.44(A2):u64 一元 "-" 检查器拒绝 M3008(check/三引擎/C 腿一致;`as i64` 存照)',
    chk6044.code === 1 && (chk6044.stderr ?? '').includes('M3008') && (chk6044.stderr ?? '').includes('无符号')
    && run6044.every(r => r.code === 1 && (r.stderr ?? '').includes('M3008'))
    && (!cc6044 || (cc6044.code === 1 && (cc6044.stderr ?? '').includes('M3008')))
    && cast6044.ok,
    `check=${chk6044.code} runs=${JSON.stringify(run6044.map(r => r.code))} cc=${cc6044?.code}\n`
    + `stderr=${JSON.stringify((chk6044.stderr ?? '').split('\n')[0])}\n${cast6044.detail}`);

  // ---- v60.45(A2):i64 一元负号四引擎回归保持 ----
  const p6045 = mk('i64_neg_four.ming', [
    'fn f(a: i64) -> i64 { return -a; }',
    'fn main() with io { print(str(f(3))); print(str(f(-3))); }',
    '',
  ].join('\n'));
  const tri6045 = tri('i64_neg_three.ming', fs.readFileSync(p6045, 'utf8'), '-3\n3\n');
  const cc6045 = ccAvailA ? runMing(['cc', p6045]) : null;
  check('v60.45(A2):i64 一元负号三引擎逐字一致;C 腿(-3/3)',
    tri6045.ok && (!cc6045 || (cc6045.code === 0 && cc6045.stdout === '-3\n3\n')),
    `${tri6045.detail}\ncc=${cc6045 ? cc6045.code + ':' + JSON.stringify(cc6045.stdout) : 'skip(无编译器)'}`);

  // ---- v60.46(A2):u64 二元减法下溢——tree/VM-only 也要 M4002(与 wasm/C 一致) ----
  const p6046 = mk('u64_sub_underflow.ming', [
    'fn f(a: u64) -> u64 { return 0u64 - a; }',
    'fn main() with io { print(str(f(1u64))); }',
    '',
  ].join('\n'));
  const run6046 = [[], ['--tree'], ['--no-wasm']].map(fl => runMing(['run', p6046, ...fl]));
  const cc6046 = ccAvailA ? runMing(['cc', p6046]) : null;
  const subOk6046 = tri('u64_sub_ok.ming', [
    'fn f(a: u64) -> u64 { return 10u64 - a; }',
    'fn main() with io { print(str(f(3u64))); print(str(f(10u64))); }',
    '',
  ].join('\n'), '7\n0\n');
  check('v60.46(A2):u64 二元减法下溢三引擎 + C 腿全 M4002;范围内减法保持 7/0',
    run6046.every(r => r.code === 101 && (r.stderr ?? '').includes('M4002'))
    && (!cc6046 || (cc6046.code === 101 && (cc6046.stderr ?? '').includes('M4002')))
    && subOk6046.ok,
    `runs=${JSON.stringify(run6046.map(r => [r.code, ((r.stderr ?? '').match(/M\d{4}/) ?? [null])[0]]))} `
    + `cc=${cc6046 ? cc6046.code + ':' + ((cc6046.stderr ?? '').match(/M\d{4}/) ?? [null])[0] : 'skip(无编译器)'}\n`
    + `${subOk6046.detail}`);

  // ---- v60.47(A3):lambda 立即调用 fmt 不丢括号(合法→非法 的契约破坏) ----
  const p6047 = mk('fmt_lambda_call.ming', [
    'fn f(a: i64) -> i64 requires ((x: i64) => x + 1)(0) == 1 { return a; }',
    'fn main() with io { print(str(f(5))); }',
    '',
  ].join('\n'));
  const f6047 = runMing(['fmt', p6047]);
  const sig6047 = (f6047.stdout.split('\n').find(l => l.startsWith('fn f(')) ?? '');
  fs.writeFileSync(p6047, f6047.stdout, 'utf8');
  const chk6047 = runMing(['check', p6047]);
  const run6047 = runMing(['run', p6047]);
  const idem6047 = runMing(['fmt', p6047, '--check']);
  check('v60.47(A3):lambda 立即调用 fmt 保留 callee 括号 + fmt 后 check/run/幂等',
    f6047.code === 0 && sig6047.includes('requires ((x: i64) => x + 1)(0) == 1')
    && chk6047.code === 0 && run6047.code === 0 && run6047.stdout === '5\n' && idem6047.code === 0,
    `fmt=${f6047.code} sig=${JSON.stringify(sig6047)} chk=${chk6047.code} run=${run6047.code}:${JSON.stringify(run6047.stdout)} `
    + `idem=${idem6047.code}\n${(chk6047.stderr ?? '').slice(0, 200)}`);

  // ---- v60.48(A3):blockInline 不支持的语句必须失败退出 1 且 --write 不落盘 ----
  const p6048 = mk('fmt_blockinline_reject.ming', [
    'fn main() with io {',
    '  let f = () => { loop { break; } };',
    '  f();',
    '  print("ok");',
    '}',
    '',
  ].join('\n'));
  const before6048 = fs.readFileSync(p6048, 'utf8');
  const f6048 = runMing(['fmt', p6048]);
  const fw6048 = runMing(['fmt', p6048, '--write']);
  const after6048 = fs.readFileSync(p6048, 'utf8');
  check('v60.48(A3):fmt 遇内联块未知语句报错退出 1(file:line:col),不再输出 /* ? */,--write 不改写源文件',
    f6048.code === 1 && f6048.stdout === '' && /:\d+:\d+: error: fmt 失败: fmt 不支持/.test(f6048.stderr ?? '')
    && !f6048.stdout.includes('/* ? */')
    && fw6048.code === 1 && after6048 === before6048,
    `fmt=${f6048.code} write=${fw6048.code} unchanged=${after6048 === before6048}\n`
    + `err=${JSON.stringify((f6048.stderr ?? '').split('\n')[0])}`);

  // ---- v60.49(A3):契约 else 的插值消息 fmt 逐字保留(运行语义不变:msg 仍为 null) ----
  const p6049 = mk('fmt_interp_msg.ming', [
    'fn f(n: i64) -> i64 requires n > 0 else "bad value: \\{n}" { return n; }',
    'fn main() with io { print(str(f(3))); }',
    '',
  ].join('\n'));
  const f6049 = runMing(['fmt', p6049]);
  fs.writeFileSync(p6049, f6049.stdout, 'utf8');
  const chk6049 = runMing(['check', p6049]);
  const run6049 = runMing(['run', p6049]);
  const idem6049 = runMing(['fmt', p6049, '--check']);
  check('v60.49(A3):`else "bad value: \\{n}"` fmt 后逐字保留 + check/run/幂等',
    f6049.code === 0 && f6049.stdout.includes('else "bad value: \\{n}"')
    && chk6049.code === 0 && run6049.code === 0 && run6049.stdout === '3\n' && idem6049.code === 0,
    `fmt=${f6049.code} out=${JSON.stringify(f6049.stdout.split('\n')[0])} chk=${chk6049.code} `
    + `run=${run6049.code}:${JSON.stringify(run6049.stdout)} idem=${idem6049.code}\n`
    + `${(chk6049.stderr ?? '').slice(0, 200)}`);

  // ---- v60.50(A3):空结构体字面量规范为 E {} + 控制字符转义(仅 fmt 输出) ----
  const p6050a = mk('fmt_empty_struct.ming', [
    'struct E {}',
    'fn f(e: E) -> i64 { return 1; }',
    'fn main() with io { let e = E {  }; print(str(f(E {  }))); }',
    '',
  ].join('\n'));
  const f6050a = runMing(['fmt', p6050a]);
  fs.writeFileSync(p6050a, f6050a.stdout, 'utf8');
  const chk6050a = runMing(['check', p6050a]);
  const run6050a = runMing(['run', p6050a]);
  const p6050b = mk('fmt_ctrl_str.ming', [
    'fn main() with io { print("a\\rb\\0c\\u{1}d"); }',
    '',
  ].join('\n'));
  const f6050b = runMing(['fmt', p6050b]);
  fs.writeFileSync(p6050b, f6050b.stdout, 'utf8');
  const chk6050b = runMing(['check', p6050b]);
  const idem6050b = runMing(['fmt', p6050b, '--check']);
  check('v60.50(A3):空结构体字面量 `E {}`(无双空格)+ \\r/\\0/控制字符按转义输出且 check/幂等',
    f6050a.code === 0 && f6050a.stdout.includes('E {}') && !f6050a.stdout.includes('E {  }')
    && chk6050a.code === 0 && run6050a.code === 0 && run6050a.stdout === '1\n'
    && f6050b.code === 0 && f6050b.stdout.includes('"a\\rb\\0c\\u{1}d"')
    && chk6050b.code === 0 && idem6050b.code === 0,
    `empty=${f6050a.code} has=${f6050a.stdout.includes('E {}')} double=${f6050a.stdout.includes('E {  }')} `
    + `chk=${chk6050a.code} run=${run6050a.code}:${JSON.stringify(run6050a.stdout)}\n`
    + `ctrl=${f6050b.code} out=${JSON.stringify((f6050b.stdout.match(/print\\(.*\\)/) ?? [''])[0])} `
    + `chk=${chk6050b.code} idem=${idem6050b.code}`);

  // ---- v60.51(B1):同显示名不同目录的双模块各一份(按绝对路径去重,不跨目录误合并)----
  // sub/a.ming 与 other/b.ming 都 `use util;` → 各自加载 sub/util.ming 与 other/util.ming,
  // 两模块展示路径同为 "util.ming"(绝对路径不同)。旧实现按展示路径反查 abs → 两者合并成一份。
  const d6051 = path.join(dir, 'dup-display');
  fs.mkdirSync(path.join(d6051, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(d6051, 'other'), { recursive: true });
  const utilSrc6051 = [
    'pub fn inc(a: i64) -> i64 requires a > 0 ensures result > a {',
    '    return a + 1;',
    '}',
    'pub fn pick(buf: Vec[i64], i: i64) -> i64 requires i >= 0 && i < buf.len() {',
    '    return buf[i];',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(d6051, 'sub', 'util.ming'), utilSrc6051);
  fs.writeFileSync(path.join(d6051, 'other', 'util.ming'), utilSrc6051);
  for (const m of ['sub', 'other']) {
    fs.writeFileSync(path.join(d6051, m, m === 'sub' ? 'a.ming' : 'b.ming'), [
      'use util;',
      'pub fn run() -> i64 {',
      '    return util.inc(util.pick([1, 2], 0));',
      '}',
      '',
    ].join('\n'));
  }
  fs.writeFileSync(path.join(d6051, 'main.ming'), [
    'use sub.a;',
    'use other.b;',
    'fn main() with io {',
    '    print(str(a.run() + b.run()));',
    '}',
    '',
  ].join('\n'));
  const main6051 = path.join(d6051, 'main.ming');
  const rep6051 = runMing(['check', main6051, '--proof-report']);
  const outLines6051 = (rep6051.stdout ?? '').split('\n');
  const incLines6051 = outLines6051.filter(l => l.includes('util.ming:inc: 契约摘要'));
  const pickLines6051 = outLines6051.filter(l => l.includes('util.ming:pick: 义务'));
  let repJson6051 = null;
  try { repJson6051 = JSON.parse(runMing(['check', main6051, '--json', '--proof-report']).stdout); } catch { /* 断言处报错 */ }
  const incSum6051 = (repJson6051?.proofs?.summaries ?? []).filter(s => s.fn === 'inc');
  const pickFn6051 = (repJson6051?.proofs?.functions ?? []).filter(f => f.fn === 'pick');
  const absSet6051 = new Set(pickFn6051.map(f => f.abs));
  check('v60.51(B1):同显示名不同目录的 util.ming 各一份(文本 2 行/JSON 2 条,abs 不同)',
    rep6051.code === 0 && incLines6051.length === 2 && pickLines6051.length === 2
    && incSum6051.length === 2 && pickFn6051.length === 2 && absSet6051.size === 2,
    `code=${rep6051.code} inc=${incLines6051.length} pick=${pickLines6051.length} `
    + `jsonInc=${incSum6051.length} jsonPick=${pickFn6051.length} abs=${JSON.stringify([...absSet6051])}\n`
    + `out=${JSON.stringify((rep6051.stdout ?? '').slice(0, 400))}`);

  // ---- v60.52(v0.59 翻转):本地函数恢复(#44,M3047 移除) ----
  // v0.56 口径:M3047 显式拒绝。v0.59 起 check/run/--tree/--no-wasm 三引擎一致执行;
  // M3047 不再发射(check stderr 无 M3047);cc(C 后端)仍不支持块内 FnStmt(exit 1 + C1)。
  const localCases6052 = [
    ['top', [
      'fn main() with io {',
      '    fn twice(a: i64) -> i64 { return a * 2; }',
      '    print(str(twice(3)));',
      '}',
      '',
    ].join('\n'), '6\n'],
    ['nested', [
      'fn main() with io {',
      '    if true {',
      '        fn inner() -> i64 { return 7; }',
      '        print(str(inner()));',
      '    }',
      '}',
      '',
    ].join('\n'), '7\n'],
    ['value', [
      'fn main() with io {',
      '    fn inc(x: i64) -> i64 { return x + 1; }',
      '    let w = [1, 2, 3].map(inc);',
      '    print(str(w.len()));',
      '}',
      '',
    ].join('\n'), '3\n'],
    ['contract', [
      'fn main() with io {',
      '    fn inc(a: i64) -> i64 requires a > 0 ensures result > a { return a + 1; }',
      '    print(str(inc(1)));',
      '}',
      '',
    ].join('\n'), '2\n'],
  ];
  let localOk6052 = true;
  const localDetail6052 = [];
  for (const [kind, src, want] of localCases6052) {
    const p = mk('local_fn_' + kind + '.ming', src);
    const runs = [runMing(['check', p]), runMing(['run', p]), runMing(['run', p, '--tree']), runMing(['run', p, '--no-wasm'])];
    // cc(C 后端)仍拒绝块内 FnStmt:exit 1 + C1;无编译器自动跳过
    const ccRun6052 = ccAvailA ? runMing(['cc', p]) : null;
    const runOk = runs[0].code === 0 && !(runs[0].stderr ?? '').includes('M3047')
      && runs.slice(1).every(r => r.code === 0 && r.stdout === want)
      && !runs.some(r => (r.stderr ?? '').includes('TypeError'));
    const ccOk = !ccRun6052 || (ccRun6052.code === 1 && (ccRun6052.stderr ?? '').includes('C1 不支持'));
    if (!runOk || !ccOk) localOk6052 = false;
    localDetail6052.push(`${kind}:${JSON.stringify(runs.map(r => r.code))} out=${JSON.stringify(runs[1]?.stdout)}`
      + `:cc=${ccRun6052 ? ccRun6052.code + ':' + JSON.stringify((ccRun6052.stderr ?? '').split('\n')[0]) : 'skip(无编译器)'}`);
  }
  check('v60.52(B6,v0.59):本地函数(顶层/嵌套块/作值/带契约)check/run/--tree/--no-wasm exit 0 且三引擎逐字一致;无 M3047;cc 仍 exit 1 + C1',
    localOk6052, localDetail6052.join('\n'));

  // ---- v60.53:块级 if 遮蔽的 cc 对照(§60 四引擎一致性;无 gcc 自动跳过)----
  const p6053 = mk('block_shadow_cc.ming', [
    'fn probe(c: i64) -> i64 {',
    '    let x = 1;',
    '    if c > 0 { let x = 2; }',
    '    return x;',
    '}',
    'fn main() with io { print(str(probe(1))); print(str(probe(0))); }',
    '',
  ].join('\n'));
  const vm6053 = runMing(['run', p6053]);
  const cc6053 = ccAvailA ? runMing(['cc', p6053]) : null;
  check('v60.53:if 块 let 遮蔽 cc 输出与 VM 一致(1/1;无 gcc 跳过)',
    vm6053.code === 0 && vm6053.stdout === '1\n1\n'
    && (!cc6053 || (cc6053.code === 0 && cc6053.stdout === '1\n1\n')),
    `vm=${vm6053.code}:${JSON.stringify(vm6053.stdout)} `
    + `cc=${cc6053 ? cc6053.code + ':' + JSON.stringify(cc6053.stdout) : 'skip(无编译器)'}`
    + `${cc6053 ? '\n' + JSON.stringify((cc6053.stderr ?? '').slice(0, 200)) : ''}`);

  // ---- v60.54(C1):ensures match 表达式自身压入的臂变量可解析(修复前 VM M4001 名字未解析 v)----
  const r6054a = tri('c1_match_ok.ming', [
    'fn f(a: i64) -> Result[i64, str] ensures match result { Ok(v) => v > 0, Err(_) => true } {',
    '  return Ok(a);',
    '}',
    'fn g(a: i64) -> Option[i64] ensures match result { Some(v) => v > 0, None => true } {',
    '  return Some(a);',
    '}',
    'fn main() with io {',
    '  match f(5) { Ok(v) => print(str(v)), Err(_) => print("err") }',
    '  match g(7) { Some(v) => print(str(v)), None => print("none") }',
    '}',
    '',
  ].join('\n'), '5\n7\n');
  const r6054b = triFail('c1_match_bad.ming', [
    'fn f(a: i64) -> Result[i64, str] ensures match result { Ok(v) => v > 0, Err(_) => true } {',
    '  return Ok(a);',
    '}',
    'fn main() with io {',
    '  match f(-1) { Ok(v) => print(str(v)), Err(_) => print("err") }',
    '}',
    '',
  ].join('\n'), '实际: Ok(-1)');
  check('v60.54(C1):ensures match result 的臂变量可解析(Result 通过=5 / Option 通过=7 / 违反=Ok(-1);三引擎逐字一致)',
    r6054a.ok && r6054b.ok, `${r6054a.detail}\n${r6054b.detail}`);

  // ---- v60.55(C1):ensures if 块内 let 可解析(VM/VM-only 回归)----
  // tree 侧同形态受 plan §5.1 #47(HEAD 既有:契约求值内嵌块尾值再次触发
  // checkEnsures 重入)限制;测试允许"修复后 5"或"当前 M4005",不锁定缺陷。
  const p6055 = mk('c1_if_let.ming', [
    'fn f(a: i64) -> i64 ensures if a > 0 { let x = a; x > 0 } else { true } {',
    '  return a;',
    '}',
    'fn main() with io { print(str(f(5))); }',
    '',
  ].join('\n'));
  const vm6055 = runMing(['run', p6055]);
  const nw6055 = runMing(['run', p6055, '--no-wasm']);
  const tree6055 = runMing(['run', p6055, '--tree']);
  const treeKnown6055 = tree6055.code === 0
    ? tree6055.stdout === '5\n'
    : (tree6055.code === 101 && /M4005/.test(tree6055.stderr ?? ''));
  check('v60.55(C1):ensures if 块内 let 可解析(VM/VM-only=5;tree 为 HEAD 既有 #47:M4005 或修复后 5)',
    vm6055.code === 0 && vm6055.stdout === '5\n' && nw6055.code === 0 && nw6055.stdout === '5\n' && treeKnown6055,
    `vm=${vm6055.code}:${JSON.stringify(vm6055.stdout)} vm-only=${nw6055.code}:${JSON.stringify(nw6055.stdout)} `
    + `tree=${tree6055.code}:${JSON.stringify(tree6055.stdout)} first=${JSON.stringify((tree6055.stderr ?? '').split('\n')[0])}`);

  // ---- v60.56(C1):嵌套 match + 多个臂变量(b/e/v)在契约内可解析 ----
  const r6056 = tri('c1_match_nested.ming', [
    'fn f(a: i64, b: i64) -> Result[i64, str] ensures match result { Ok(v) => match v { 0 => b > 0, _ => v > b }, Err(e) => e.char_len() >= 0 } {',
    '  if a > b { return Ok(a); }',
    '  return Err("lo");',
    '}',
    'fn main() with io {',
    '  match f(3, 0) { Ok(v) => print(str(v)), Err(e) => print(e) }',
    '  match f(0, 0) { Ok(v) => print(str(v)), Err(e) => print(e) }',
    '}',
    '',
  ].join('\n'), '3\nlo\n');
  check('v60.56(C1):ensures 嵌套 match + 多臂变量(v/b/e)可解析(3/lo;三引擎逐字一致)', r6056.ok, r6056.detail);

  // ---- v60.57(C1):match 臂块内 let 再嵌套 match(VM/VM-only 回归;tree 同 #47)----
  const p6057 = mk('c1_arm_let.ming', [
    'fn f(a: i64) -> Result[i64, str] ensures match result { Ok(v) => { let w = v * 2; match w { 0 => false, _ => w > 0 } }, Err(_) => true } {',
    '  return Ok(a);',
    '}',
    'fn main() with io {',
    '  match f(2) { Ok(v) => print(str(v)), Err(_) => print("err") }',
    '}',
    '',
  ].join('\n'));
  const vm6057 = runMing(['run', p6057]);
  const nw6057 = runMing(['run', p6057, '--no-wasm']);
  const tree6057 = runMing(['run', p6057, '--tree']);
  const treeKnown6057 = tree6057.code === 0
    ? tree6057.stdout === '2\n'
    : (tree6057.code === 101 && /M4001|M4005/.test(tree6057.stderr ?? ''));
  check('v60.57(C1):ensures 臂块内 let + 嵌套 match 可解析(VM/VM-only=2;tree 为 HEAD 既有 #47)',
    vm6057.code === 0 && vm6057.stdout === '2\n' && nw6057.code === 0 && nw6057.stdout === '2\n' && treeKnown6057,
    `vm=${vm6057.code}:${JSON.stringify(vm6057.stdout)} vm-only=${nw6057.code}:${JSON.stringify(nw6057.stdout)} `
    + `tree=${tree6057.code}:${JSON.stringify(tree6057.stdout)} first=${JSON.stringify((tree6057.stderr ?? '').split('\n')[0])}`);

  // ---- v60.58(C2):含 ensures 的函数体内闭包 return——闭包不执行外层 ensures,外层出口仍检查 ----
  const r6058a = tri('c2_lambda_return_ok.ming', [
    'fn f(a: i64) -> i64 ensures result > 0 {',
    '  let g: () -> i64 = () => { return 1; };',
    '  let x = g();',
    '  return a + x;',
    '}',
    'fn main() with io { print(str(f(1))); }',
    '',
  ].join('\n'), '2\n');
  const r6058b = triFail('c2_lambda_return_bad.ming', [
    'fn f(a: i64) -> i64 ensures result > 0 {',
    '  let g: () -> i64 = () => { return -5; };',
    '  return a + g();',
    '}',
    'fn main() with io { print(str(f(1))); }',
    '',
  ].join('\n'), '实际: -4');
  check('v60.58(C2):闭包 return 不编译外层 ensures(闭包 -5 不触发;外层返回 -4 仍 M4015;三引擎一致)',
    r6058a.ok && r6058b.ok, `${r6058a.detail}\n${r6058b.detail}`);

  // ---- v60.59(C1):契约内臂变量与形参同名——词法遮蔽(臂变量优先,不得落到形参槽)----
  const r6059 = triFail('c1_arm_shadow_param.ming', [
    'fn f(v: i64) -> Result[i64, str] ensures match result { Ok(v) => v > 0, Err(_) => true } {',
    '  return Ok(-5);',
    '}',
    'fn main() with io { match f(7) { Ok(x) => print(str(x)), Err(_) => print("err") } }',
    '',
  ].join('\n'), '实际: Ok(-5)');
  check('v60.59(C1):契约内臂变量 v 遮蔽同名形参(v=-5 触发,不是形参 7;三引擎逐字一致)', r6059.ok, r6059.detail);
}

// ===================== 61. v0.57:循环边界证明(QF_LIA 第四片)+ tools AOT 缓存 + 覆盖率/bench 基线 =====================
// A 组(v57.1–v57.19):范围 for(`for i in lo..hi`)体内 buf[i] 义务 —— 经
//   `check --json --proof-report` 的 proofs 字段断言(义务 {kind, obligation, scope, counterexample};
//   scope='loop' 循环体内 / 'body' 直线体)。义务/反例文本以实现实际输出校准;M3045 码/退出码/
//   反例核心要素不放松。校准注:无 requires 的函数不进入边界分析(v0.52 既有行为),
//   故 A8/A17 按实现口径补线性 requires。
// B 组(v57.20–v57.25):ming tools AOT 缓存(缓存目录 <repo>/.ming-cache/tools,gitignored;
//   观测旗标 MING_TOOLS_DEBUG=1,决策行走 stderr)。核心合同:冷/热 stdout/stderr/退出码逐字一致、
//   panic 对齐、损坏自愈、旁路(--tree/--json)不缓存、ming run 直连不受影响。
// C 组(v57.26–v57.27):覆盖率/bench 基线轻量冒烟(coverage 完整插桩运行为手动信息性项,不入门禁)。
{
  const dir = path.join(TMP, 'v57');
  fs.mkdirSync(dir, { recursive: true });
  const mk = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };

  // ---- A 组公用:check --json --proof-report 解析 ----
  const proofJson = (p, extra = []) => {
    const r = runMing(['check', p, '--json', '--proof-report', ...extra]);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 断言处报错 */ }
    return { r, j };
  };
  const oblsOf = (j, fn) => (j?.proofs?.functions ?? []).filter((f) => f.fn === fn).flatMap((f) => f.obligations);
  const fRecsOf = (j, fn) => (j?.proofs?.functions ?? []).filter((f) => f.fn === fn);
  const diagCodes = (j) => (j?.diagnostics ?? []).map((d) => d.code);
  const bothEnginesOk = (p) => runMing(['run', p]).code === 0 && runMing(['run', p, '--tree']).code === 0;

  // ---- v57.1(A1):`for i in 0..buf.len()` 的 buf[i] 义务 proven ----
  const p571 = mk('a1_loop_0_len.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 1 {',
    '  for i in 0..buf.len() {',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1, 2]))); }',
    '',
  ].join('\n'));
  const pj571 = proofJson(p571);
  const ob571 = oblsOf(pj571.j, 'f');
  check('v57.1:A1 loop_range_0_len_proven —— 恰 1 条义务 proven scope=loop(0 <= i && i < len$buf);run/run --tree exit 0',
    pj571.r.code === 0 && ob571.length === 1
    && ob571[0].kind === 'proven' && ob571[0].scope === 'loop'
    && ob571[0].obligation === '0 <= i && i < len$buf'
    && diagCodes(pj571.j).length === 0
    && bothEnginesOk(p571),
    `code=${pj571.r.code} obls=${JSON.stringify(ob571)} diags=${JSON.stringify(diagCodes(pj571.j))}`);

  // ---- v57.2(A2):下界 1 由 lo 推出 —— `for i in 1..buf.len()` proven ----
  const p572 = mk('a2_loop_1_len.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 1 {',
    '  for i in 1..buf.len() {',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1, 2]))); }',
    '',
  ].join('\n'));
  const pj572 = proofJson(p572);
  const ob572 = oblsOf(pj572.j, 'f');
  check('v57.2:A2 loop_range_1_len_proven —— `for i in 1..buf.len()` 义务 proven scope=loop(0 <= i 由 lo 推出)',
    pj572.r.code === 0 && ob572.length === 1
    && ob572[0].kind === 'proven' && ob572[0].scope === 'loop'
    && ob572[0].obligation === '0 <= i && i < len$buf',
    `code=${pj572.r.code} obls=${JSON.stringify(ob572)}`);

  // ---- v57.3(A3):非零下界参数 `for i in n..buf.len()` proven ----
  const p573 = mk('a3_loop_n_len.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n >= 0 && buf.len() >= 1 {',
    '  for i in n..buf.len() {',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1, 2], 1))); }',
    '',
  ].join('\n'));
  const pj573 = proofJson(p573);
  const ob573 = oblsOf(pj573.j, 'f');
  check('v57.3:A3 loop_range_n_len_proven —— requires n >= 0 下 `for i in n..buf.len()` 义务 proven scope=loop',
    pj573.r.code === 0 && ob573.length === 1
    && ob573[0].kind === 'proven' && ob573[0].scope === 'loop'
    && ob573[0].obligation === '0 <= i && i < len$buf',
    `code=${pj573.r.code} obls=${JSON.stringify(ob573)}`);

  // ---- v57.4(A4):上界参数 + requires n <= buf.len() —— `for i in 0..n` proven ----
  const p574 = mk('a4_loop_0_n.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n <= buf.len() && buf.len() >= 1 {',
    '  for i in 0..n {',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1, 2], 2))); }',
    '',
  ].join('\n'));
  const pj574 = proofJson(p574);
  const ob574 = oblsOf(pj574.j, 'f');
  check('v57.4:A4 loop_range_0_n_requires_proven —— requires n <= buf.len() 下 `for i in 0..n` 义务 proven scope=loop',
    pj574.r.code === 0 && ob574.length === 1
    && ob574[0].kind === 'proven' && ob574[0].scope === 'loop'
    && ob574[0].obligation === '0 <= i && i < len$buf',
    `code=${pj574.r.code} obls=${JSON.stringify(ob574)}`);

  // ---- v57.5(A5):上界参数无上界要求 —— unproven 默认静默(exit 0、0 诊断) ----
  const p575 = mk('a5_loop_0_n_unproven.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n >= 0 && buf.len() >= 1 {',
    '  for i in 0..n {',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1, 2], 1))); }',
    '',
  ].join('\n'));
  const plain575 = runMing(['check', p575]);
  const pj575 = proofJson(p575);
  const ob575 = oblsOf(pj575.j, 'f');
  check('v57.5:A5 loop_range_0_n_unproven_silent —— check exit 0 无输出;proofs 义务 kind=unproven scope=loop',
    plain575.code === 0 && plain575.stdout === '' && plain575.stderr === ''
    && diagCodes(pj575.j).length === 0
    && ob575.length === 1 && ob575[0].kind === 'unproven' && ob575[0].scope === 'loop',
    `code=${plain575.code} out=${JSON.stringify(plain575.stdout)} err=${JSON.stringify(plain575.stderr)} obls=${JSON.stringify(ob575)}`);

  // ---- v57.6(A6):--warn-unproven-index 下 A5 形态恰 1 条 W3105(消息含未证明义务) ----
  const warn576 = runMing(['check', p575, '--warn-unproven-index']);
  check('v57.6:A6 loop_w3105_flag —— 恰 1 条 W3105,消息含 无法静态证明在界内(未证明:i < len$buf)',
    warn576.code === 0
    && (warn576.stderr.match(/W3105/g) ?? []).length === 1
    && (warn576.stderr ?? '').includes('无法静态证明在界内(未证明:i < len$buf)'),
    `code=${warn576.code} w3105=${(warn576.stderr.match(/W3105/g) ?? []).length} err=${JSON.stringify((warn576.stderr ?? '').split('\n')[0])}`);

  // ---- v57.7(A7):上界 n+1 越界可证违反 —— M3045 + 反例(len$buf = 0, i$0 = 0) ----
  const p577 = mk('a7_loop_violated_high.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 0 {',
    '  for i in buf.len()..buf.len() + 1 {',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1]))); }',
    '',
  ].join('\n'));
  const plain577 = runMing(['check', p577]);
  const pj577 = proofJson(p577);
  const ob577 = oblsOf(pj577.j, 'f');
  const msg577 = (pj577.j?.diagnostics ?? [])[0]?.message ?? '';
  check('v57.7:A7 loop_violated_high —— exit 1 恰 1 条 error M3045(违反义务:i < len$buf;反例 len$buf = 0, i$0 = 0)',
    plain577.code === 1
    && (plain577.stderr.match(/M3045/g) ?? []).length === 1
    && JSON.stringify(diagCodes(pj577.j)) === '["M3045"]'
    && pj577.j?.diagnostics?.[0]?.severity === 'error'
    && msg577.includes('违反义务:i < len$buf')
    && msg577.includes('(反例:len$buf = 0, i$0 = 0)')
    && ob577.length === 1 && ob577[0].kind === 'violated' && ob577[0].scope === 'loop',
    `code=${plain577.code} msg=${JSON.stringify(msg577)} obls=${JSON.stringify(ob577)}`);

  // ---- v57.8(A8):常量低侧越界 `for i in 0 - 1..0` —— M3045 + 反例 i$0 = -1 ----
  const p578 = mk('a8_loop_violated_low.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 1 {',
    '  for i in 0 - 1..0 {',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1]))); }',
    '',
  ].join('\n'));
  const pj578 = proofJson(p578);
  const msg578 = (pj578.j?.diagnostics ?? [])[0]?.message ?? '';
  check('v57.8:A8 loop_violated_low —— exit 1 M3045 低侧(违反义务:0 <= i;反例含 i$0 = -1)',
    pj578.r.code === 1 && JSON.stringify(diagCodes(pj578.j)) === '["M3045"]'
    && msg578.includes('违反义务:0 <= i')
    && msg578.includes('i$0 = -1'),
    `code=${pj578.r.code} msg=${JSON.stringify(msg578)}`);

  // ---- v57.9(A9):参数低侧越界 `for i in n - 1..n` + requires n == 0 —— M3045 + 反例 n = 0, i$0 = -1 ----
  const p579 = mk('a9_loop_violated_low_param.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n == 0 {',
    '  for i in n - 1..n {',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1], 0))); }',
    '',
  ].join('\n'));
  const pj579 = proofJson(p579);
  const msg579 = (pj579.j?.diagnostics ?? [])[0]?.message ?? '';
  check('v57.9:A9 loop_violated_low_param —— exit 1 M3045(违反义务:0 <= i;反例 n = 0 与 i$0 = -1)',
    pj579.r.code === 1 && JSON.stringify(diagCodes(pj579.j)) === '["M3045"]'
    && msg579.includes('违反义务:0 <= i')
    && msg579.includes('n = 0') && msg579.includes('i$0 = -1'),
    `code=${pj579.r.code} msg=${JSON.stringify(msg579)}`);

  // ---- v57.10(A10):循环变量重赋值 → 保守放弃(只报 M3004,无 M3045) ----
  const p5710 = mk('a10_loop_reassign.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 1 {',
    '  for i in 0..buf.len() {',
    '    i = 5;',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1]))); }',
    '',
  ].join('\n'));
  const pj5710 = proofJson(p5710);
  check('v57.10:A10 loop_reassign_aborts —— 诊断恰为 [M3004],无 M3045;check exit 1',
    pj5710.r.code === 1 && JSON.stringify(diagCodes(pj5710.j)) === '["M3004"]',
    `code=${pj5710.r.code} diags=${JSON.stringify(diagCodes(pj5710.j))}`);

  // ---- v57.11(A11):嵌套 for → 保守放弃(exit 0;proofs 无 f 记录) ----
  const p5711 = mk('a11_loop_nested.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 1 {',
    '  for i in 0..buf.len() {',
    '    for j in 0..2 {',
    '      return buf[i];',
    '    }',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1]))); }',
    '',
  ].join('\n'));
  const pj5711 = proofJson(p5711);
  check('v57.11:A11 loop_nested_abort —— check exit 0、0 诊断、proofs 无 f 记录(0 义务)',
    pj5711.r.code === 0 && diagCodes(pj5711.j).length === 0 && fRecsOf(pj5711.j, 'f').length === 0,
    `code=${pj5711.r.code} fRecs=${JSON.stringify(fRecsOf(pj5711.j, 'f'))}`);

  // ---- v57.12(A12):while 守卫形态 → 静默放弃(exit 0、0 诊断) ----
  const p5712 = mk('a12_loop_while.ming', [
    'fn f(buf: Vec[i64], n: i64) -> i64 requires n >= 1 && n <= buf.len() {',
    '  let mut i = 0;',
    '  while i < n {',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1], 1))); }',
    '',
  ].join('\n'));
  const pj5712 = proofJson(p5712);
  check('v57.12:A12 loop_while_abort —— check exit 0、0 诊断(while 不采集循环义务)',
    pj5712.r.code === 0 && diagCodes(pj5712.j).length === 0,
    `code=${pj5712.r.code} diags=${JSON.stringify(diagCodes(pj5712.j))}`);

  // ---- v57.13(A13):索引表达式位移 `buf[i + 1]` 上界 len-1 —— proven ----
  const p5713 = mk('a13_loop_shift.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 1 {',
    '  for i in 0..buf.len() - 1 {',
    '    return buf[i + 1];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1]))); }',
    '',
  ].join('\n'));
  const pj5713 = proofJson(p5713);
  const ob5713 = oblsOf(pj5713.j, 'f');
  check('v57.13:A13 loop_shift_proven —— `for i in 0..len-1` 的 buf[i+1] 义务 proven scope=loop',
    pj5713.r.code === 0 && ob5713.length === 1
    && ob5713[0].kind === 'proven' && ob5713[0].scope === 'loop'
    && ob5713[0].obligation === '0 <= i + 1 && i + 1 < len$buf',
    `code=${pj5713.r.code} obls=${JSON.stringify(ob5713)}`);

  // ---- v57.14(A14):循环内改写外层 mut 变量 → for 后整体放弃(恰 1 条循环义务;buf[n] 不采集) ----
  const p5714 = mk('a14_loop_mut_dirty.ming', [
    'fn f(buf: Vec[i64], mut n: i64) -> i64 requires n >= 1 && n <= buf.len() && buf.len() >= 1 {',
    '  for i in 0..n {',
    '    n = n - 1;',
    '    return buf[i];',
    '  }',
    '  return buf[n];',
    '}',
    'fn main() with io { print(str(f([1, 2], 2))); }',
    '',
  ].join('\n'));
  const pj5714 = proofJson(p5714);
  const ob5714 = oblsOf(pj5714.j, 'f');
  check('v57.14:A14 loop_mut_dirty_stops_after —— 恰 1 条义务(proven scope=loop);for 后 buf[n] 不采集、无 M3045',
    diagCodes(pj5714.j).length === 0 && ob5714.length === 1
    && ob5714[0].kind === 'proven' && ob5714[0].scope === 'loop'
    && ob5714[0].index === 'i',
    `diags=${JSON.stringify(diagCodes(pj5714.j))} obls=${JSON.stringify(ob5714)}`);

  // ---- v57.15(A15):两个顺序 for 各裸 buf[i];—— 2 条义务均 proven scope=loop;run 双引擎 exit 0 ----
  const p5715 = mk('a15_loop_two.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 1 {',
    '  for i in 0..buf.len() {',
    '    buf[i];',
    '  }',
    '  for j in 0..buf.len() {',
    '    buf[j];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1, 2]))); }',
    '',
  ].join('\n'));
  const pj5715 = proofJson(p5715);
  const ob5715 = oblsOf(pj5715.j, 'f');
  check('v57.15:A15 loop_two_loops_both_proven —— 2 条义务均 proven scope=loop(i/j);run/run --tree exit 0',
    pj5715.r.code === 0 && ob5715.length === 2
    && ob5715.every((o) => o.kind === 'proven' && o.scope === 'loop')
    && ob5715[0].index === 'i' && ob5715[1].index === 'j'
    && bothEnginesOk(p5715),
    `code=${pj5715.r.code} obls=${JSON.stringify(ob5715)}`);

  // ---- v57.16(A16):循环体内 break/continue 不破坏不变式 —— proven;run 双引擎 exit 0 ----
  const p5716 = mk('a16_loop_break_continue.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 1 {',
    '  for i in 0..buf.len() {',
    '    buf[i];',
    '    continue;',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1, 2]))); }',
    '',
  ].join('\n'));
  const pj5716 = proofJson(p5716);
  const ob5716 = oblsOf(pj5716.j, 'f');
  check('v57.16:A16 loop_break_continue_ok —— `buf[i]; continue;` 义务 proven scope=loop;run/run --tree exit 0',
    pj5716.r.code === 0 && ob5716.length === 1
    && ob5716[0].kind === 'proven' && ob5716[0].scope === 'loop'
    && bothEnginesOk(p5716),
    `code=${pj5716.r.code} obls=${JSON.stringify(ob5716)}`);

  // ---- v57.17(A17):空洞区间 [5,2) —— 义务空洞真 proven;run exit 0 ----
  const p5717 = mk('a17_loop_empty_interval.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 0 {',
    '  for i in 5..2 {',
    '    return buf[i];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1]))); }',
    '',
  ].join('\n'));
  const pj5717 = proofJson(p5717);
  const ob5717 = oblsOf(pj5717.j, 'f');
  check('v57.17:A17 loop_empty_interval_vacuous —— 空区间义务 proven scope=loop;run exit 0',
    pj5717.r.code === 0 && ob5717.length === 1
    && ob5717[0].kind === 'proven' && ob5717[0].scope === 'loop'
    && runMing(['run', p5717]).code === 0,
    `code=${pj5717.r.code} obls=${JSON.stringify(ob5717)}`);

  // ---- v57.18(A18):循环体内契约调用(带 requires 的 g)—— 无 M3041/M3045 误报 ----
  const p5718 = mk('a18_loop_contract_call.ming', [
    'fn g(x: i64) -> i64 requires x >= 0 { return x; }',
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 1 {',
    '  for i in 0..buf.len() {',
    '    let k = g(i);',
    '    return buf[k];',
    '  }',
    '  return 0;',
    '}',
    'fn main() with io { print(str(f([1]))); }',
    '',
  ].join('\n'));
  const pj5718 = proofJson(p5718);
  check('v57.18:A18 loop_contract_call_no_regress —— 循环体内 let k = g(i) 后 check exit 0、0 诊断(无 M3041/M3045)',
    pj5718.r.code === 0 && diagCodes(pj5718.j).length === 0,
    `code=${pj5718.r.code} diags=${JSON.stringify(diagCodes(pj5718.j))}`);

  // ---- v57.19(A19,补充):同函数两态 scope —— break 路径循环义务(loop)+ 循环后直线义务(body) ----
  const p5719 = mk('a19_loop_mixed_scope.ming', [
    'fn f(buf: Vec[i64]) -> i64 requires buf.len() >= 2 {',
    '  for i in 0..buf.len() {',
    '    buf[i];',
    '    break;',
    '  }',
    '  return buf[0];',
    '}',
    'fn main() with io { print(str(f([1, 2]))); }',
    '',
  ].join('\n'));
  const pj5719 = proofJson(p5719);
  const ob5719 = oblsOf(pj5719.j, 'f');
  check('v57.19:A19 loop_mixed_scope —— scope 字段两态:循环内 i=loop、循环后 0=body(均 proven);proven 义务 main 实跑双引擎 exit 0',
    pj5719.r.code === 0 && diagCodes(pj5719.j).length === 0 && ob5719.length === 2
    && ob5719[0].index === 'i' && ob5719[0].scope === 'loop' && ob5719[0].kind === 'proven'
    && ob5719[1].index === '0' && ob5719[1].scope === 'body' && ob5719[1].kind === 'proven'
    && bothEnginesOk(p5719),
    `code=${pj5719.r.code} obls=${JSON.stringify(ob5719)}`);

  // ---- B 组公用:tools AOT 缓存(仓库级 .ming-cache/tools;gitignored) ----
  const B_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-v57b-'));
  const TOOLS_CACHE = path.join(ROOT, '.ming-cache', 'tools');
  const cacheEntries = () => fs.existsSync(TOOLS_CACHE)
    ? fs.readdirSync(TOOLS_CACHE).filter((x) => x.endsWith('.json'))
    : [];
  const clearToolCache = () => fs.rmSync(TOOLS_CACHE, { recursive: true, force: true });
  const runTool = (args, env = {}) => runMing(['tools', ...args], { cwd: B_DIR, env });
  const noDbg = { MING_TOOLS_DEBUG: '' }; // 显式关掉继承(防宿主 shell 泄漏 MING_TOOLS_DEBUG)
  const wTxt = path.join(B_DIR, 'w.txt');
  fs.writeFileSync(wTxt, 'alpha beta\nalpha\n', 'utf8'); // 2 行 3 词 17 字节

  // ---- v57.20(B1):冷/热逐字一致(wc/patch 成功+0 处拒绝/json 正常+缺键/read)+ 二次运行 hit ----
  clearToolCache();
  const pOk = path.join(B_DIR, 'p_ok.txt');
  const pZero = path.join(B_DIR, 'p_zero.txt');
  const qJson = path.join(B_DIR, 'q.json');
  fs.writeFileSync(pZero, 'aaa\n', 'utf8');
  fs.writeFileSync(qJson, '{"a":{"b":1},"c":2}', 'utf8');
  const b1Cases = [
    { tag: 'wc', args: ['wc', wTxt] },
    { tag: 'patch-ok', args: ['patch', pOk, 'hello', 'hi'], pre: () => fs.writeFileSync(pOk, 'hello\n', 'utf8') },
    { tag: 'patch-zero', args: ['patch', pZero, 'zzz', 'qqq'] }, // 0 处拒绝:exit 1,不改文件
    { tag: 'json-hit', args: ['json', qJson, 'a.b'] },
    { tag: 'json-miss', args: ['json', qJson, 'x.y'] }, // 缺键:exit 1
    { tag: 'read', args: ['read', wTxt] },
  ];
  const coldB1 = b1Cases.map((c) => { if (c.pre) c.pre(); return runTool(c.args, noDbg); });
  const warmB1 = b1Cases.map((c) => { if (c.pre) c.pre(); return runTool(c.args, noDbg); });
  const b1Same = b1Cases.every((c, i) => coldB1[i].code === warmB1[i].code
    && coldB1[i].stdout === warmB1[i].stdout && coldB1[i].stderr === warmB1[i].stderr);
  const b1CodesOk = coldB1[0].code === 0 && coldB1[1].code === 0 && coldB1[2].code === 1
    && coldB1[3].code === 0 && coldB1[4].code === 1 && coldB1[5].code === 0;
  const dbgB1 = runTool(['wc', wTxt], { MING_TOOLS_DEBUG: '1' });
  check('v57.20:B1 tools 缓存冷/热逐字一致(6 例 code+stdout+stderr 全等;缓存恰 3 条目 wc/mingkit/json_query)且二次运行 [tools-cache] hit',
    b1Same && b1CodesOk && cacheEntries().length === 3
    && dbgB1.code === 0 && (dbgB1.stderr ?? '').includes('[tools-cache] hit'),
    `same=${b1Same} codes=${JSON.stringify(coldB1.map((r) => r.code))} entries=${JSON.stringify(cacheEntries())} `
    + `dbg=${JSON.stringify((dbgB1.stderr ?? '').split('\n').filter((l) => l.includes('[tools-cache]')))}`);

  // ---- v57.21(B2):缓存命中 panic 对齐(--max-steps 3 → M4001;stderr 逐字一致;exit 101) ----
  clearToolCache();
  const panicC = runTool(['wc', wTxt, '--max-steps', '3'], noDbg);
  const panicW = runTool(['wc', wTxt, '--max-steps', '3'], noDbg);
  const pwErrNorm = (panicW.stderr ?? '').replace(/\\/g, '/');
  check('v57.21:B2 缓存命中 panic 对齐 —— 冷/热 stdout+stderr 逐字相等;M4001 首行(步数上限 3)+ at main 栈帧含 tools/wc.ming;exit 101',
    panicC.code === 101 && panicW.code === 101
    && panicC.stdout === panicW.stdout && panicC.stderr === panicW.stderr
    && (panicW.stderr ?? '').split('\n')[0].includes('M4001')
    && pwErrNorm.includes('执行步数超过上限 3')
    && pwErrNorm.includes('at main') && pwErrNorm.includes('tools/wc.ming')
    && cacheEntries().length >= 1,
    `codes=${panicC.code}/${panicW.code} same=${panicC.stderr === panicW.stderr} `
    + `err1=${JSON.stringify((panicW.stderr ?? '').split('\n')[0])}`);

  // ---- v57.22(B3):损坏缓存自愈(重建为可 JSON.parse 的产物;输出与 run 直连逐字一致) ----
  clearToolCache();
  const b3a = runTool(['wc', wTxt], noDbg);
  const b3Entries = cacheEntries();
  let b3Corrupted = false;
  if (b3Entries.length === 1) {
    fs.writeFileSync(path.join(TOOLS_CACHE, b3Entries[0]), '{corrupt', 'utf8');
    b3Corrupted = true;
  }
  const b3b = runTool(['wc', wTxt], noDbg);
  const b3Direct = runMing(['run', path.join(ROOT, 'tools', 'wc.ming'), '--', wTxt], { env: noDbg });
  let b3Parsed = false;
  try {
    b3Parsed = b3Entries.length === 1 && b3Corrupted
      && typeof JSON.parse(fs.readFileSync(path.join(TOOLS_CACHE, b3Entries[0]), 'utf8')) === 'object';
  } catch { /* 保持 false,断言处报错 */ }
  check('v57.22:B3 损坏缓存自愈 —— {corrupt 后冷跑重建:输出与 run 直连逐字一致、条目恢复可 JSON.parse',
    b3Entries.length === 1 && b3Corrupted
    && b3b.code === 0 && b3b.stdout === b3a.stdout && b3b.stderr === b3a.stderr
    && b3Direct.code === 0 && b3b.stdout === b3Direct.stdout
    && b3Parsed,
    `entries=${JSON.stringify(b3Entries)} corrupted=${b3Corrupted} parsed=${b3Parsed} `
    + `codes=${b3a.code}/${b3b.code}/${b3Direct.code} same=${b3b.stdout === b3Direct.stdout}`);

  // ---- v57.23(B4):旁路(--tree/--json)不缓存;冷跑恰 +1;patch-all 与 patch 同键共享条目 ----
  clearToolCache();
  const b4tree = runTool(['wc', wTxt, '--tree'], noDbg);
  const b4json = runTool(['wc', wTxt, '--json'], noDbg);
  const b4EntriesAfterBypass = cacheEntries(); // 旁路运行后立即快照(后续 patch 会写缓存,不能再查实时)
  const p4 = path.join(B_DIR, 'p4.txt');
  fs.writeFileSync(p4, 'aaa\n', 'utf8');
  const b4cold = runTool(['patch', p4, 'aaa', 'bbb'], noDbg);
  const b4EntriesAfterCold = cacheEntries();
  const b4all = runTool(['patch-all', p4, 'bbb', 'ccc'], noDbg);
  const b4EntriesAfterAll = cacheEntries();
  check('v57.23:B4 旁路不缓存(--tree/--json 后 0 条目)+ 冷跑恰 +1 + patch-all 与 patch 同键共享(仍 1 条;aaa→bbb→ccc 实际执行)',
    b4tree.code === 0 && b4json.code === 0 && b4EntriesAfterBypass.length === 0
    && b4cold.code === 0 && b4EntriesAfterCold.length === 1
    && b4all.code === 0 && b4EntriesAfterAll.length === 1
    && fs.readFileSync(p4, 'utf8').trim() === 'ccc',
    `bypass codes=${b4tree.code}/${b4json.code} afterBypass=${JSON.stringify(b4EntriesAfterBypass)} `
    + `afterCold=${JSON.stringify(b4EntriesAfterCold)} afterAll=${JSON.stringify(b4EntriesAfterAll)} p4=${JSON.stringify(fs.readFileSync(p4, 'utf8'))}`);

  // ---- v57.24(B5):MING_TOOLS_DEBUG=1 决策行(冷 stored / 热 hit);无旗标无前缀且输出不变 ----
  clearToolCache();
  const b5cold = runTool(['wc', wTxt], { MING_TOOLS_DEBUG: '1' });
  const b5warm = runTool(['wc', wTxt], { MING_TOOLS_DEBUG: '1' });
  const b5off = runTool(['wc', wTxt], noDbg);
  check('v57.24:B5 MING_TOOLS_DEBUG=1 决策行走 stderr(冷 stored、热 hit);无旗标无 [tools-cache] 前缀且 stdout 不变',
    b5cold.code === 0 && b5warm.code === 0 && b5off.code === 0
    && (b5cold.stderr ?? '').includes('[tools-cache] stored')
    && (b5warm.stderr ?? '').includes('[tools-cache] hit')
    && !(b5off.stderr ?? '').includes('[tools-cache]')
    && b5cold.stdout === b5warm.stdout && b5cold.stdout === b5off.stdout,
    `codes=${b5cold.code}/${b5warm.code}/${b5off.code} `
    + `cold=${JSON.stringify((b5cold.stderr ?? '').split('\n').filter((l) => l.includes('[tools-cache]')))} `
    + `warm=${JSON.stringify((b5warm.stderr ?? '').split('\n').filter((l) => l.includes('[tools-cache]')))}`);

  // ---- v57.25(B6):ming run 直连工具路由不受缓存影响(直连不写缓存;输出与 tools 路由逐字一致) ----
  clearToolCache();
  const dTxt = path.join(B_DIR, 'd.txt');
  fs.writeFileSync(dTxt, 'x\ny\n', 'utf8');
  const b6direct = runMing(['run', path.join(ROOT, 'tools', 'wc.ming'), '--', dTxt], { env: noDbg });
  const b6EntriesAfterDirect = cacheEntries();
  const b6tools = runTool(['wc', dTxt], noDbg);
  check('v57.25:B6 ming run 直连路由不受缓存影响 —— 直连后 0 缓存条目;stdout 与 tools 路由逐字一致',
    b6direct.code === 0 && b6EntriesAfterDirect.length === 0
    && b6tools.code === 0 && b6tools.stdout === b6direct.stdout && b6direct.stdout.trim() !== '',
    `direct=${b6direct.code} entriesAfterDirect=${JSON.stringify(b6EntriesAfterDirect)} `
    + `tools=${b6tools.code} same=${b6tools.stdout === b6direct.stdout}`);

  // ---- v57.26(C1):coverage.mjs 存在 + 语法可加载 + 覆盖率基线文档存在 ----
  // 完整插桩运行(NODE_V8_COVERAGE 跑全量回归,~7 分钟)为手动信息性项,不入门禁;
  // 基线数字见 docs/coverage-baseline.md(plan §4.3.8:先建立基线再谈阈值)。
  const covPath = path.join(ROOT, 'tests', 'coverage.mjs');
  const covSyntax = spawnSync(process.execPath, ['--check', covPath], { encoding: 'utf8' });
  const covBaselineDoc = path.join(ROOT, 'docs', 'coverage-baseline.md');
  check('v57.26:C1 coverage.mjs 存在且语法可加载(--check exit 0)+ 覆盖率基线文档存在(完整插桩运行为手动信息性项)',
    fs.existsSync(covPath) && covSyntax.status === 0 && fs.existsSync(covBaselineDoc),
    `exists=${fs.existsSync(covPath)} check=${covSyntax.status} doc=${fs.existsSync(covBaselineDoc)} `
    + `err=${JSON.stringify((covSyntax.stderr ?? '').slice(0, 200))}`);

  // ---- v57.27(C2):bench 基线可解析(meta.date + items)且 bench.mjs 带基线对比输出(Δ基线) ----
  const benchBaselinePath = path.join(ROOT, 'tests', 'bench.baseline.json');
  let base5727 = null;
  try { base5727 = JSON.parse(fs.readFileSync(benchBaselinePath, 'utf8')); } catch { /* 断言处报错 */ }
  const benchEnv5727 = { ...process.env };
  delete benchEnv5727.MING_WASM_STRICT; // 与 runMing 同口径:剥掉宿主可能泄漏的 strict 旗标
  const benchR = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'bench.mjs')], {
    encoding: 'utf8', cwd: ROOT, timeout: 300000, env: benchEnv5727,
  });
  const benchLines5727 = (benchR.stdout ?? '').split('\n').filter((l) => l.includes('基线'));
  check('v57.27:C2 bench 基线存在可解析(meta.date + items 非空)且 bench.mjs exit 0 带 Δ基线对比输出',
    base5727 && typeof base5727 === 'object'
    && typeof base5727.meta?.date === 'string' && base5727.meta.date !== ''
    && base5727.items && typeof base5727.items === 'object' && Object.keys(base5727.items).length >= 1
    && benchR.status === 0
    && benchLines5727.some((l) => l.includes('Δ基线'))
    && benchLines5727.some((l) => l.includes('基线对比')),
    `bench=${benchR.status} baselineDate=${JSON.stringify(base5727?.meta?.date)} `
    + `items=${Object.keys(base5727?.items ?? {}).length} `
    + `lines=${JSON.stringify(benchLines5727.slice(-2))}`);
}

// ===================== 62. v0.58:LSP 补全/跳转/符号(A)+ std.str.join 与编译器名字解析(B)+ doc --json/--index 与 Release(C)=====================
// A 组(v58.1–v58.16):LSP 三新查询。语义断言直连 src/lsp.js 导出的
//   completionFor/definitionFor/documentSymbolsFor(lsp.js 供测试/工具直连的可测入口);
//   协议断言(initialize capabilities/诊断推送/didClose/坏 JSON 存活/非 ASCII 分帧)走 §8 同款
//   Content-Length 管道会话(runMing stdin + Buffer 字节分帧)。kind 为 LSP 标准数值
//   (5 Field / 2 Method / 3 Function / 6 Variable / 9 Module / 14 Keyword / 20 EnumMember / 8 Field-symbol / 22…)。
//   保守策略锁死:类型推不出 → [](宁可少补),语法不可修复 → null;注释/字符串内 → []。
//   断言以工作树实现逐条实测校准(2026-11-13);impl 语法必须为 `impl <Trait> for <Type>`。
// B 组(v58.17–v58.29):std.str.join(单次 O(n) 拼接,Builder 方案的最小替代,plan §4.3.5 架构调整)+
//   `use std.str` 下内建/模块/别名/模块级遮蔽四形态名字解析(三引擎逐字;B 包修复)+
//   遮蔽守卫(B 审查 MINOR-1:基名被局部遮蔽 → 按局部值方法调用)+
//   分配记账不对称(#49 已登记,按现状如实断言:std join 结果不计费,Vec 方法 join 计费)。
// C 组(v58.30–v58.34):ming doc --json 稳定 schema / --index 聚合 / 默认文本输出逐字不变 /
//   release.yml 结构静态校验(零 YAML 依赖:关键串 + uses 前缀白名单 + 无双 v)。
{
  const dir = path.join(TMP, 'v58');
  fs.mkdirSync(dir, { recursive: true });
  const mk = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src, 'utf8'); return f; };

  // ---- A 组公用:直连三查询 ----
  const labelsOf = (r) => (r === null || r === undefined ? null : r.items.map((i) => i.label));
  const kindsOf = (r) => (r === null ? null : r.items.map((i) => i.kind));
  // ---- A 组公用:管道会话(帧按字节计,Content-Length 是字节数) ----
  const lspFrame = (m) => { const b = JSON.stringify(m); return `Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`; };
  const lspParse = (out) => {
    const responses = [];
    let buf = Buffer.from(out, 'utf8');
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) break;
      const head = buf.slice(0, sep).toString('utf8');
      const m = head.match(/Content-Length:\s*(\d+)/i);
      if (!m) { buf = buf.slice(sep + 4); continue; }
      const len = Number(m[1]);
      if (buf.length < sep + 4 + len) break;
      try { responses.push(JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString('utf8'))); } catch { /* 坏体不计数 */ }
      buf = buf.slice(sep + 4 + len);
    }
    return responses;
  };
  const lspSession = (msgs) => {
    const r = runMing(['lsp'], { stdin: msgs.map(lspFrame).join('') });
    return { code: r.code, rs: lspParse(r.stdout), err: r.stderr };
  };
  const uriOf = (p) => 'file:///' + p.split(path.sep).join('/');

  // ---- v58.1(任务 1):initialize capabilities 四能力同时真;shutdown 后 exit 0 ----
  {
    const s = lspSession([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } },
      { jsonrpc: '2.0', id: 2, method: 'shutdown', params: null },
      { jsonrpc: '2.0', method: 'exit', params: null },
    ]);
    const caps = s.rs.find((x) => x.id === 1)?.result?.capabilities;
    check('v58.1:A1 lsp_initialize_capabilities —— hover/completion/definition/documentSymbol 四能力同时真;shutdown 后 exit 0',
      s.code === 0 && !!caps
      && caps.hoverProvider === true && !!caps.completionProvider && caps.definitionProvider === true && caps.documentSymbolProvider === true,
      `code=${s.code} caps=${JSON.stringify(caps)}`);
  }

  // ---- v58.2(任务 2):字段补全-字面量:struct 字段(kind 5)+ impl 方法(kind 2),不含 fn ----
  {
    const p = mk('a2_field_literal.ming', [
      'struct Point { x: i64, y: i64, }',
      'trait Geo { fn len2(self) -> i64; }',
      'impl Geo for Point { fn len2(self) -> i64 { return self.x * self.x + self.y * self.y; } }',
      'fn main() with io {',
      '  let p = Point { x: 1, y: 2 };',
      '  p.',
      '}',
      '',
    ].join('\n'));
    const r = completionFor(p, fs.readFileSync(p, 'utf8'), 5, 4);
    check('v58.2:A2 completion_field_literal —— `p.`(字面量推导)→ 字段 x,y(kind 5)+ 方法 len2(kind 2);不含 fn',
      r !== null && JSON.stringify(labelsOf(r)) === JSON.stringify(['x', 'y', 'len2'])
      && JSON.stringify(kindsOf(r)) === JSON.stringify([5, 5, 2])
      && !labelsOf(r).includes('fn'),
      `r=${JSON.stringify(r)}`);
  }

  // ---- v58.3(任务 3):注解参数与 impl self 同型成员列表 ----
  {
    const pA = mk('a3_annot.ming', [
      'struct Point { x: i64, y: i64, }',
      'trait Geo { fn len2(self) -> i64; }',
      'impl Geo for Point { fn len2(self) -> i64 { return self.x * self.x; } }',
      'fn f(p: Point) -> i64 {',
      '  return p.',
      '}',
      'fn main() with io { print(str(f(Point { x: 1, y: 2 }))); }',
      '',
    ].join('\n'));
    const pS = mk('a3_self.ming', [
      'struct Point { x: i64, y: i64, }',
      'trait Geo { fn len2(self) -> i64; }',
      'impl Geo for Point { fn len2(self) -> i64 { return self.',
      '} }',
      '',
    ].join('\n'));
    const rA = completionFor(pA, fs.readFileSync(pA, 'utf8'), 4, 11);
    const rS = completionFor(pS, fs.readFileSync(pS, 'utf8'), 2, 57);
    check('v58.3:A3 completion_annot_vs_self —— `fn f(p: Point)` 内 `p.` 与 impl 内 `self.` 同型(字段+方法同列表)',
      rA !== null && rS !== null
      && JSON.stringify(labelsOf(rA)) === JSON.stringify(['x', 'y', 'len2'])
      && JSON.stringify(labelsOf(rA)) === JSON.stringify(labelsOf(rS))
      && JSON.stringify(kindsOf(rA)) === JSON.stringify(kindsOf(rS)),
      `annot=${JSON.stringify(rA)} self=${JSON.stringify(rS)}`);
  }

  // ---- v58.4(任务 4):成员补全-use:math. 含 sqrt/pi;std. 模块列表;helper. 只含 pub 项 ----
  {
    mk('helper.ming', [
      'pub fn shout(s: str) -> str { return s + "!"; }',
      'fn hidden() -> i64 { return 1; }',
      'pub const LIMIT: i64 = 3;',
      '',
    ].join('\n'));
    const pM = mk('a4_math.ming', [
      'use std.math;',
      'fn main() with io {',
      '  print(str(math.sqrt(4.0)));',
      '  math.',
      '}',
      '',
    ].join('\n'));
    const rM = completionFor(pM, fs.readFileSync(pM, 'utf8'), 3, 8);
    const pStd = mk('a4_std.ming', ['fn main() with io {', '  std.', '}', ''].join('\n'));
    const rStd = completionFor(pStd, fs.readFileSync(pStd, 'utf8'), 1, 6);
    const pH = mk('a4_helper.ming', ['use helper;', 'fn main() with io {', '  helper.', '}', ''].join('\n'));
    const rH = completionFor(pH, fs.readFileSync(pH, 'utf8'), 2, 9);
    check('v58.4:A4 completion_use_members —— math. 含 sqrt/pi(kind 3);std. 列模块(kind 9);helper. 只含 pub 项(shout/LIMIT,无 hidden)',
      rM !== null && labelsOf(rM).includes('sqrt') && labelsOf(rM).includes('pi') && kindsOf(rM).every((k) => k === 3)
      && rStd !== null && labelsOf(rStd).includes('math') && labelsOf(rStd).includes('str') && kindsOf(rStd).every((k) => k === 9)
      && rH !== null && JSON.stringify(labelsOf(rH)) === JSON.stringify(['shout', 'LIMIT']) && !labelsOf(rH).includes('hidden'),
      `math=${JSON.stringify(rM && labelsOf(rM))} std=${JSON.stringify(rStd && labelsOf(rStd))} helper=${JSON.stringify(rH && labelsOf(rH))}`);
  }

  // ---- v58.5(任务 5):空前缀(关键字+模块项)与作用域保守前缀 ----
  {
    const pE = mk('a5_empty.ming', ['fn main() with io {', '  ', '}', ''].join('\n'));
    const rE = completionFor(pE, fs.readFileSync(pE, 'utf8'), 1, 2);
    const pO = mk('a5_prefix.ming', [
      'struct Opt { v: i64, }',
      'fn main() with io {',
      '  let o2 = 1;',
      '  o',
      '}',
      '',
    ].join('\n'));
    const rO = completionFor(pO, fs.readFileSync(pO, 'utf8'), 3, 3);
    check('v58.5:A5 completion_prefix_scope —— 空前缀含关键字(let)与内置(print)与 std;前缀 `o` 恰命中作用域内 o2(大小写敏感,不命中 Opt)',
      rE !== null && rE.items.length >= 40 && labelsOf(rE).includes('let') && labelsOf(rE).includes('print') && labelsOf(rE).includes('std')
      && rO !== null && JSON.stringify(labelsOf(rO)) === JSON.stringify(['o2']),
      `empty n=${rE && rE.items.length} o=${JSON.stringify(rO && labelsOf(rO))}`);
  }

  // ---- v58.6(任务 6):枚举变体补全(kind 20) ----
  {
    const pC = mk('a6_color.ming', [
      'enum Color { Red, Green, Blue }',
      'fn main() with io {',
      '  let c = Color.',
      '}',
      '',
    ].join('\n'));
    const rC = completionFor(pC, fs.readFileSync(pC, 'utf8'), 2, 16);
    const pO = mk('a6_option.ming', ['fn main() with io {', '  Option.', '}', ''].join('\n'));
    const rO = completionFor(pO, fs.readFileSync(pO, 'utf8'), 1, 9);
    check('v58.6:A6 completion_enum_variants —— `Color.` → Red/Green/Blue(kind 20);`Option.` → Some/None(kind 20)',
      rC !== null && JSON.stringify(labelsOf(rC)) === JSON.stringify(['Red', 'Green', 'Blue']) && kindsOf(rC).every((k) => k === 20)
      && rO !== null && JSON.stringify(labelsOf(rO)) === JSON.stringify(['Some', 'None']) && kindsOf(rO).every((k) => k === 20),
      `color=${JSON.stringify(rC && labelsOf(rC))} option=${JSON.stringify(rO && labelsOf(rO))}`);
  }

  // ---- v58.7(任务 7):打字中间态(占位修复)与不可修复 null ----
  {
    const p1 = mk('a7_mid1.ming', [
      'struct Point { x: i64, y: i64, }',
      'fn main() with io {',
      '  let p = Point { x: 1, y: 2 };',
      '  let probe = p.',
      '}',
      '',
    ].join('\n'));
    const r1 = completionFor(p1, fs.readFileSync(p1, 'utf8'), 3, 16);
    const p2 = mk('a7_mid2.ming', [
      'struct Point { x: i64, y: i64, }',
      'fn main() with io {',
      '  let probe: Po',
      '}',
      '',
    ].join('\n'));
    const r2 = completionFor(p2, fs.readFileSync(p2, 'utf8'), 2, 14);
    const p3 = mk('a7_num.ming', ['fn main() with io {', '  3.', '}', ''].join('\n'));
    const r3 = completionFor(p3, fs.readFileSync(p3, 'utf8'), 1, 4); // 光标在小数点后(打字位)
    const p4 = mk('a7_broken.ming', ['fn main() with io {', '  let a = ??? weird', '}', ''].join('\n'));
    const r4 = completionFor(p4, fs.readFileSync(p4, 'utf8'), 1, 19);
    check('v58.7:A7 completion_typing_midstate —— `let probe = p.` → x/y;`let probe: Po` → 单项 Point;`3.` → 空列表;不可修复 → null',
      r1 !== null && JSON.stringify(labelsOf(r1)) === JSON.stringify(['x', 'y'])
      && r2 !== null && JSON.stringify(labelsOf(r2)) === JSON.stringify(['Point'])
      && r3 !== null && Array.isArray(r3.items) && r3.items.length === 0
      && r4 === null,
      `mid1=${JSON.stringify(r1 && labelsOf(r1))} mid2=${JSON.stringify(r2 && labelsOf(r2))} num=${JSON.stringify(r3)} broken=${JSON.stringify(r4)}`);
  }

  // ---- v58.8(任务 8):definition-模块项:fn 名 span 精确(行+列) ----
  {
    const p = mk('a8_def_fn.ming', [
      'fn greet(name: str) -> str { return "hi " + name; }',
      'fn main() with io { print(greet("x")); }',
      '',
    ].join('\n'));
    const d = definitionFor(p, p, fs.readFileSync(p, 'utf8'), 1, 26);
    check('v58.8:A8 definition_module_fn —— greet 跳转到本文件声明名 span(line 0,char 3..8)',
      d !== null && d.uri === p
      && d.range.start.line === 0 && d.range.start.character === 3
      && d.range.end.line === 0 && d.range.end.character === 8,
      `d=${JSON.stringify(d)}`);
  }

  // ---- v58.9(任务 9):definition-跨文件与内置保守 null ----
  {
    mk('helper.ming', ['pub fn shout(s: str) -> str { return s + "!"; }', ''].join('\n'));
    const p = mk('a9_def_cross.ming', [
      'use helper;',
      'use std.math;',
      'fn main() with io {',
      '  print(helper.shout("hi"));',
      '  print(str(math.sqrt(4.0)));',
      '}',
      '',
    ].join('\n'));
    const dCross = definitionFor(p, p, fs.readFileSync(p, 'utf8'), 3, 15);
    const dStd = definitionFor(p, p, fs.readFileSync(p, 'utf8'), 4, 17);
    const pB = mk('a8_def_fn.ming', [
      'fn greet(name: str) -> str { return "hi " + name; }',
      'fn main() with io { print(greet("x")); }',
      '',
    ].join('\n'));
    const dBuiltin = definitionFor(pB, pB, fs.readFileSync(pB, 'utf8'), 1, 21); // print:内置无源 → null
    check('v58.9:A9 definition_cross_and_builtin —— helper.shout → 另一文件 file:/// URI(char 7..12);math.sqrt → null;内置 print → null',
      dCross !== null && dCross.uri.startsWith('file:///') && dCross.uri.endsWith('helper.ming')
      && dCross.range.start.line === 0 && dCross.range.start.character === 7 && dCross.range.end.character === 12
      && dStd === null && dBuiltin === null,
      `cross=${JSON.stringify(dCross)} std=${JSON.stringify(dStd)} builtin=${JSON.stringify(dBuiltin)}`);
  }

  // ---- v58.10(任务 10):definition-局部变量与枚举变体 ----
  {
    const p = mk('a10_def_local.ming', [
      'enum Color { Red, Green }',
      'fn f(p: i64) -> i64 { return p; }',
      'fn main() with io {',
      '  let p = 7;',
      '  print(str(f(p)));',
      '  let c = Color.Red;',
      '}',
      '',
    ].join('\n'));
    const dLocal = definitionFor(p, p, fs.readFileSync(p, 'utf8'), 4, 14);
    const dVariant = definitionFor(p, p, fs.readFileSync(p, 'utf8'), 5, 17);
    check('v58.10:A10 definition_local_variant —— 实参 p → `let p` span(line 3,char 6..7);Color.Red → 变体行(line 0,char 13..16)',
      dLocal !== null && dLocal.uri === p
      && dLocal.range.start.line === 3 && dLocal.range.start.character === 6 && dLocal.range.end.character === 7
      && dVariant !== null && dVariant.uri.startsWith('file:///')
      && dVariant.range.start.line === 0 && dVariant.range.start.character === 13 && dVariant.range.end.character === 16,
      `local=${JSON.stringify(dLocal)} variant=${JSON.stringify(dVariant)}`);
  }

  // ---- v58.11(任务 11):documentSymbol 顶层 kinds + children 层级;use/test 不列 ----
  {
    const p = mk('a11_symbols.ming', [
      'const TOP: i64 = 1;',
      'struct Pair { a: i64, b: i64, }',
      'enum Shade { Dark, Light }',
      'trait Eq2 { fn same(self, other: Self) -> bool; }',
      'impl Eq2 for Pair { fn same(self, other: Self) -> bool { return true; } }',
      'fn top_fn() -> i64 { return 0; }',
      'use std.math;',
      'test t1 { assert_eq(1, 1); }',
      'fn main() with io { print(str(top_fn())); }',
      '',
    ].join('\n'));
    const syms = documentSymbolsFor(p, fs.readFileSync(p, 'utf8'));
    const flat = syms === null ? null : syms.map((s) => `${s.name}:${s.kind}`);
    const pair = syms === null ? null : syms.find((s) => s.name === 'Pair');
    const impl = syms === null ? null : syms.find((s) => s.name === 'impl Eq2 for Pair');
    check('v58.11:A11 document_symbols —— 顶层 const/struct/enum/trait/impl/fn kinds 与 children 层级;use 与 test 不列',
      Array.isArray(syms)
      && JSON.stringify(flat) === JSON.stringify(['TOP:14', 'Pair:23', 'Shade:10', 'Eq2:11', 'impl Eq2 for Pair:5', 'top_fn:12', 'main:12'])
      && JSON.stringify(pair.children.map((c) => `${c.name}:${c.kind}`)) === JSON.stringify(['a:8', 'b:8'])
      && JSON.stringify(impl.children.map((c) => `${c.name}:${c.kind}`)) === JSON.stringify(['same:6'])
      && !flat.some((s) => s.startsWith('t1') || s.startsWith('math')),
      `flat=${JSON.stringify(flat)}`);
  }

  // ---- v58.12(任务 12):错误形态:语法文件三查询 null 不崩溃、诊断仍推送;didClose 后 null ----
  {
    const brokenText = 'fn main() with io { let = 1; }\n';
    const p = mk('a12_broken.ming', brokenText);
    const uri = uriOf(p);
    const s = lspSession([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'ming', version: 1, text: brokenText } } },
      { jsonrpc: '2.0', id: 2, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 0, character: 24 } } },
      { jsonrpc: '2.0', id: 3, method: 'textDocument/definition', params: { textDocument: { uri }, position: { line: 0, character: 4 } } },
      { jsonrpc: '2.0', id: 4, method: 'textDocument/documentSymbol', params: { textDocument: { uri } } },
      { jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } },
      { jsonrpc: '2.0', id: 5, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character: 4 } } },
      { jsonrpc: '2.0', id: 6, method: 'shutdown', params: null },
      { jsonrpc: '2.0', method: 'exit', params: null },
    ]);
    const diag = s.rs.find((x) => x.method === 'textDocument/publishDiagnostics');
    const byId = (i) => s.rs.find((x) => x.id === i);
    check('v58.12:A12 lsp_error_shapes —— 语法文件 completion/definition/documentSymbol 全 null 不崩溃;诊断仍推送(M 码);didClose 后 hover null;exit 0',
      s.code === 0
      && byId(2)?.result === null && byId(3)?.result === null && byId(4)?.result === null
      && Array.isArray(diag?.params?.diagnostics) && diag.params.diagnostics.length >= 1
      && String(diag.params.diagnostics[0].code).startsWith('M')
      && byId(5)?.result === null && byId(6)?.result === null,
      `code=${s.code} ids=${JSON.stringify(s.rs.map((x) => x.id))} diag=${JSON.stringify(diag?.params?.diagnostics?.[0]?.code)}`);
  }

  // ---- v58.13(任务 13):非 ASCII 分帧(既有 P1 修复回归):中文注释/字符串 → 诊断与 hover 正常 ----
  {
    const zhSrc = '// 中文注释:类型不匹配\nfn main() with io {\n  let s = "中文😀字符串";\n  let x: i64 = true;\n  print(s);\n}\n';
    const p = mk('a13_zh.ming', zhSrc);
    const uri = uriOf(p);
    const s = lspSession([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'ming', version: 1, text: zhSrc } } },
      { jsonrpc: '2.0', id: 2, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 1, character: 3 } } },
      { jsonrpc: '2.0', id: 3, method: 'shutdown', params: null },
      { jsonrpc: '2.0', method: 'exit', params: null },
    ]);
    const diag = s.rs.find((x) => x.method === 'textDocument/publishDiagnostics');
    const hoverVal = s.rs.find((x) => x.id === 2)?.result?.contents?.value ?? '';
    check('v58.13:A13 lsp_nonascii_framing —— didOpen 含中文注释/中文字符串/emoji → 会话不瘫痪:诊断推送(M3002)+ hover 正常;exit 0',
      s.code === 0
      && Array.isArray(diag?.params?.diagnostics) && diag.params.diagnostics.some((d) => d.code === 'M3002')
      && hoverVal.includes('fn main() with io'),
      `code=${s.code} nDiag=${diag?.params?.diagnostics?.length} hover=${JSON.stringify(hoverVal.slice(0, 40))}`);
  }

  // ---- v58.14(A 审查回归 1):坏 JSON 体存活:坏体 + 空体帧后 initialize/shutdown 仍有响应 ----
  {
    const bad = 'Content-Length: 5\r\n\r\n{@}@@' + 'Content-Length: 0\r\n\r\n'
      + lspFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      + lspFrame({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null })
      + lspFrame({ jsonrpc: '2.0', method: 'exit', params: null });
    const r = runMing(['lsp'], { stdin: bad });
    const rs = lspParse(r.stdout);
    check('v58.14:A14 lsp_bad_json_survival —— 坏体/空体不杀会话:exit 0、stderr 无 ReferenceError、initialize/shutdown 均有响应',
      r.code === 0 && !/ReferenceError/.test(r.stderr)
      && JSON.stringify(rs.map((x) => x.id)) === JSON.stringify([1, 2]),
      `code=${r.code} ids=${JSON.stringify(rs.map((x) => x.id))} err=${JSON.stringify(r.stderr.slice(0, 120))}`);
  }

  // ---- v58.15(A 审查回归 2):块注释内不补全(嵌套深度按 lexer 语义) ----
  {
    const src = [
      'use std.math;',
      'fn main() with io {',
      '  /* math. */',
      '  let x = 1.0;',
      '  /* math.',
      '  跨行 */ let y = std.math.sqrt(x);',
      '  /* /* 嵌套未闭 */ let z = 2.0;',
      '  */ let w = 3.0; math.',
      '}',
      '',
    ].join('\n');
    const p = mk('a15_block_comment.ming', src);
    const q = (li, col) => completionFor(p, src, li, col);
    const inComment1 = q(2, 10);   // 单行块注释内
    const inComment2 = q(4, 10);   // 跨行块注释内
    const inComment3 = q(6, 24);   // 嵌套未闭(深度 1)内
    const afterClose = q(7, 18);   // 注释闭合后同行 → 正常补全
    check('v58.15:A15 completion_block_comment —— 单行/跨行/嵌套未闭块注释内 → [];闭合后同行正常(含 w,不含注释内 z)',
      inComment1 !== null && inComment1.items.length === 0
      && inComment2 !== null && inComment2.items.length === 0
      && inComment3 !== null && inComment3.items.length === 0
      && afterClose !== null && afterClose.items.length > 0
      && labelsOf(afterClose).includes('w') && !labelsOf(afterClose).includes('z'),
      `c1=${JSON.stringify(inComment1)} c2=${JSON.stringify(inComment2)} c3=${JSON.stringify(inComment3)} after=${JSON.stringify(afterClose && labelsOf(afterClose))}`);
  }

  // ---- v58.16(A 审查回归 3):第三式(吞掉光标后同行残余 + 括号补齐) ----
  {
    const mkCase = (bodyLine) => {
      const src = [
        'enum Color { Red, Green }',
        'struct Pt { x: i64, y: i64, }',
        'fn main() with io {',
        '  let pt = Pt { x: 1, y: 2 };',
        bodyLine,
        '}',
        '',
      ].join('\n');
      const p = mk('a16_third.ming', src);
      return { p, src, line: 4 };
    };
    const c1 = mkCase('  let c = Color.;');
    const r1 = completionFor(c1.p, c1.src, 4, 16);
    const c2 = mkCase('  print(pt.);');
    const r2 = completionFor(c2.p, c2.src, 4, 11);
    const c3 = mkCase('  print(std.');
    const r3 = completionFor(c3.p, c3.src, 4, 12);
    const c4 = mkCase('  print(pt.');
    const r4 = completionFor(c4.p, c4.src, 4, 11);
    const c5 = mkCase('  let pp = Pt { x: pt.');
    const r5 = completionFor(c5.p, c5.src, 4, 22);
    const srcNest = [
      'struct Pt { x: i64, y: i64, }',
      'fn id(v: i64) -> i64 { return v; }',
      'fn main() with io {',
      '  let pt = Pt { x: 1, y: 2 };',
      '  print(id(pt.',
      '}',
      '',
    ].join('\n');
    const pNest = mk('a16_nested.ming', srcNest);
    const r6 = completionFor(pNest, srcNest, 4, 14);
    check('v58.16:A16 completion_third_form —— `let c = Color.;` → Red/Green;`print(pt.);` → x/y;`print(std.` → std 列表;`print(id(pt.` → x/y;struct 字段值位 → null',
      r1 !== null && JSON.stringify(labelsOf(r1)) === JSON.stringify(['Red', 'Green'])
      && r2 !== null && JSON.stringify(labelsOf(r2)) === JSON.stringify(['x', 'y'])
      && r3 !== null && labelsOf(r3).includes('math') && labelsOf(r3).includes('str')
      && r4 !== null && JSON.stringify(labelsOf(r4)) === JSON.stringify(['x', 'y'])
      && r6 !== null && JSON.stringify(labelsOf(r6)) === JSON.stringify(['x', 'y'])
      && r5 === null,
      `c1=${JSON.stringify(r1 && labelsOf(r1))} c2=${JSON.stringify(r2 && labelsOf(r2))} c3=${JSON.stringify(r3 && labelsOf(r3))} c4=${JSON.stringify(r4 && labelsOf(r4))} c6=${JSON.stringify(r6 && labelsOf(r6))} c5=${JSON.stringify(r5)}`);
  }

  // ---- v58.17(任务 17):join 空 Vec / 单元素 / 多元素依序 ----
  {
    const p = mk('b17_join_basic.ming', [
      'use std.str;',
      'fn main() with io {',
      '  let a: Vec[str] = [];',
      '  print(str.join(a));',
      '  let b = ["x"];',
      '  print(str.join(b));',
      '  let c = ["a", "b", "c"];',
      '  print(str.join(c));',
      '}',
      '',
    ].join('\n'));
    const r = runMing(['run', p]);
    check('v58.17:B17 join_basic —— 空 Vec → ""(空行);单元素 = 该元素;多元素依序连接',
      r.code === 0 && r.stdout === '\nx\nabc\n',
      `code=${r.code} out=${JSON.stringify(r.stdout)} err=${r.stderr.slice(0, 120)}`);
  }

  // ---- v58.18(任务 18):join 含空串(含全空)/中文与 emoji(byte_len 口径) ----
  {
    const p = mk('b18_join_empty_zh.ming', [
      'use std.str;',
      'fn main() with io {',
      '  let a = ["", "b", ""];',
      '  print("[" + str.join(a) + "]");',
      '  let e: Vec[str] = [""];',
      '  print("[" + str.join(e) + "]");',
      '  let zh = ["中", "文", "😀"];',
      '  let j = str.join(zh);',
      '  print(j);',
      '  print(str(j.byte_len()));',
      '}',
      '',
    ].join('\n'));
    const r = runMing(['run', p]);
    check('v58.18:B18 join_empty_zh —— 含空串/全空串数组;中文+emoji 按 byte_len 口径 = 10(3+3+4)',
      r.code === 0 && r.stdout === '[b]\n[]\n中文😀\n10\n',
      `code=${r.code} out=${JSON.stringify(r.stdout)} err=${r.stderr.slice(0, 120)}`);
  }

  // ---- v58.19(任务 19):join == `+` 循环逐字相等;1000 元素;值语义 ----
  {
    const pEq = mk('b19a_join_eq_plus.ming', [
      'use std.str;',
      'fn main() with io {',
      '  let v = ["a", "b", "c"];',
      '  let mut acc = "";',
      '  for s in v { acc = acc + s; }',
      '  print(str(str.join(v) == acc));',
      '}',
      '',
    ].join('\n'));
    const rEq = runMing(['run', pEq]);
    const rEqT = runMing(['run', pEq, '--tree']);
    const p1k = mk('b19b_join_1k.ming', [
      'use std.str;',
      'fn main() with io {',
      '  let mut v: Vec[str] = [];',
      '  for i in 0..1000 { v.push(str(i)); }',
      '  let j = str.join(v);',
      '  print(str(j.byte_len()));',
      '  print(j);',
      '}',
      '',
    ].join('\n'));
    const r1k = runMing(['run', p1k]);
    const r1kT = runMing(['run', p1k, '--tree']);
    const pVal = mk('b19c_join_value_sem.ming', [
      'use std.str;',
      'fn main() with io {',
      '  let v = ["a", "b"];',
      '  let _j = str.join(v);',
      '  print(str(v.len()));',
      '  print(v[0]);',
      '}',
      '',
    ].join('\n'));
    const rVal = runMing(['run', pVal]);
    check('v58.19:B19 join_eq_plus_1k_value —— join 与 `+` 循环逐字相等(双引擎);1000 元素 byte_len 2890 且双引擎输出逐字一致;join 后入参 Vec 不变(值语义)',
      rEq.code === 0 && rEqT.code === 0 && rEq.stdout === 'true\n' && rEqT.stdout === 'true\n'
      && r1k.code === 0 && r1kT.code === 0 && r1k.stdout === r1kT.stdout && r1k.stdout.startsWith('2890\n')
      && rVal.code === 0 && rVal.stdout === '2\na\n',
      `eq=${rEq.code}/${rEqT.code} 1k=${r1k.code}/${r1kT.code} val=${JSON.stringify(rVal.stdout)} err=${r1k.stderr.slice(0, 120)}`);
  }

  // ---- v58.20(任务 20a):负例-类型(M3002 ×2) ----
  {
    const pV = mk('b20a_join_vec_i64.ming', [
      'use std.str;',
      'fn main() with io {',
      '  let v: Vec[i64] = [1, 2];',
      '  print(str.join(v));',
      '}',
      '',
    ].join('\n'));
    const rV = runMing(['check', pV]);
    const pS = mk('b20b_join_str_arg.ming', [
      'use std.str;',
      'fn main() with io {',
      '  print(str.join("ab"));',
      '}',
      '',
    ].join('\n'));
    const rS = runMing(['check', pS]);
    check('v58.20:B20 join_negative_types —— Vec[i64] 实参与 str 实参均 M3002(期望 Vec[str]),check exit 1',
      rV.code === 1 && rV.stderr.includes('M3002') && rV.stderr.includes('期望 Vec[str]')
      && rS.code === 1 && rS.stderr.includes('M3002') && rS.stderr.includes('期望 Vec[str]'),
      `vec=${rV.code} str=${rS.code} err=${rV.stderr.slice(0, 100)}`);
  }

  // ---- v58.21(任务 20b):负例-参数个数(M3005)与不存在名(M3001) ----
  {
    const p0 = mk('b20c_join_0arg.ming', ['use std.str;', 'fn main() with io {', '  print(str.join());', '}', ''].join('\n'));
    const r0 = runMing(['check', p0]);
    const p2 = mk('b20d_join_2arg.ming', ['use std.str;', 'fn main() with io {', '  let v = ["a"];', '  print(str.join(v, v));', '}', ''].join('\n'));
    const r2 = runMing(['check', p2]);
    const pX = mk('b20e_join_unknown.ming', ['use std.str;', 'fn main() with io {', '  print(str.joinx());', '}', ''].join('\n'));
    const rX = runMing(['check', pX]);
    check('v58.21:B21 join_negative_arity_name —— 0 参/2 参 → M3005(需要 1 个参数);不存在名 joinx → M3001(std.str 中没有)',
      r0.code === 1 && r0.stderr.includes('M3005') && r0.stderr.includes('需要 1 个参数')
      && r2.code === 1 && r2.stderr.includes('M3005')
      && rX.code === 1 && rX.stderr.includes('M3001') && rX.stderr.includes('joinx'),
      `n0=${r0.code} n2=${r2.code} nx=${rX.code} err=${rX.stderr.slice(0, 100)}`);
  }

  // ---- v58.22(任务 21):纯函数:无效果声明调用通过(双引擎) ----
  {
    const p = mk('b21_join_pure.ming', [
      'use std.str;',
      'fn j(v: Vec[str]) -> str {',
      '  return str.join(v);',
      '}',
      'fn main() with io {',
      '  print(j(["p", "q"]));',
      '}',
      '',
    ].join('\n'));
    const c = runMing(['check', p]);
    const r = runMing(['run', p]);
    const rT = runMing(['run', p, '--tree']);
    check('v58.22:B22 join_pure_fn —— join 是纯函数:无效果声明的函数体调用 check exit 0,双引擎输出 pq',
      c.code === 0 && r.code === 0 && rT.code === 0 && r.stdout === 'pq\n' && rT.stdout === 'pq\n',
      `check=${c.code} run=${r.code} tree=${rT.code} out=${JSON.stringify(r.stdout)}`);
  }

  // ---- v58.23(任务 22):`use std.str as s;` 别名形式 ----
  {
    const p = mk('b22_join_alias.ming', [
      'use std.str as s;',
      'fn main() with io {',
      '  print(s.join(["m", "n"]));',
      '}',
      '',
    ].join('\n'));
    const r = runMing(['run', p]);
    const rT = runMing(['run', p, '--tree']);
    check('v58.23:B23 join_alias —— `use std.str as s;` + `s.join(v)` 双引擎输出 mn',
      r.code === 0 && rT.code === 0 && r.stdout === 'mn\n' && rT.stdout === 'mn\n',
      `run=${r.code} tree=${rT.code} out=${JSON.stringify(r.stdout)} err=${r.stderr.slice(0, 120)}`);
  }

  // ---- v58.24(任务 23):wasm 资格:join 所在数值型函数 REJECT(非直接调用)→ strict 回落可见 exit 2 ----
  {
    const p = mk('b23_join_strict_wasm.ming', [
      'use std.str;',
      'fn probe(a: i64) -> i64 {',
      '  let v = ["x"];',
      '  let s = str.join(v);',
      '  if s == "x" { return a + 1; }',
      '  return a;',
      '}',
      'fn main() with io { print(str(probe(1))); }',
      '',
    ].join('\n'));
    const r = runMing(['run', p, '--strict-wasm']);
    const rPlain = runMing(['run', p]);
    check('v58.24:B24 join_strict_wasm_reject —— probe 含 str.join 非直接调用 → wasm REJECT;--strict-wasm 回落可见 exit 2(stderr 点名);非 strict 正常运行',
      r.code === 2 && r.stderr.includes('strict-wasm:') && r.stderr.includes('非直接调用')
      && rPlain.code === 0,
      `strict=${r.code} err=${JSON.stringify(r.stderr.slice(0, 140))} plain=${rPlain.code}`);
  }

  // ---- v58.25(任务 24):ming cc C1 拒绝(资格面外的形态,发射期显式拒绝) ----
  {
    const p = mk('b24_join_cc.ming', [
      'use std.str;',
      'fn main() with io {',
      '  print(str.join(["a", "b"]));',
      '}',
      '',
    ].join('\n'));
    const r = runMing(['cc', p, '--emit-c']);
    check('v58.25:B25 join_cc_c1_reject —— cc --emit-c 显式拒绝(exit 1,stderr C1 不支持,不进资格面)',
      r.code === 1 && r.stderr.includes('C1 不支持'),
      `code=${r.code} err=${JSON.stringify(r.stderr.slice(0, 120))}`);
  }

  // ---- v58.26(任务 25):编译器四形态 × 三引擎逐字(内建/模块/别名/模块级遮蔽) ----
  {
    const pA = mk('b25a_builtin_vs_module.ming', [
      'use std.str;',
      'fn main() with io {',
      '  print(str(42));',
      '  let v = ["a", "b"];',
      '  print(str.join(v));',
      '}',
      '',
    ].join('\n'));
    const pB = mk('b25b_alias.ming', [
      'use std.str as s;',
      'fn main() with io {',
      '  let v = ["a", "b"];',
      '  print(s.join(v));',
      '}',
      '',
    ].join('\n'));
    const pC = mk('b25c_module_fn_shadow.ming', [
      'fn str(x: i64) -> i64 { return x * 100; }',
      'fn main() with io {',
      '  print(str(42));',
      '}',
      '',
    ].join('\n'));
    const three = (p) => {
      const vm = runMing(['run', p]);
      const tree = runMing(['run', p, '--tree']);
      const nowasm = runMing(['run', p, '--no-wasm']);
      return { vm, tree, nowasm };
    };
    const a = three(pA);
    const b = three(pB);
    const c = three(pC);
    check('v58.26:B26 compiler_four_forms —— `use std.str` 下 str(42) 仍内建(42)+ str.join(v) 走模块(ab);别名 s.join(v)=ab;模块级 fn str 遮蔽调用模块 fn 赢(4200);三引擎逐字一致',
      a.vm.code === 0 && a.vm.stdout === '42\nab\n' && a.tree.stdout === a.vm.stdout && a.nowasm.stdout === a.vm.stdout
      && b.vm.code === 0 && b.vm.stdout === 'ab\n' && b.tree.stdout === b.vm.stdout && b.nowasm.stdout === b.vm.stdout
      && c.vm.code === 0 && c.vm.stdout === '4200\n' && c.tree.stdout === c.vm.stdout && c.nowasm.stdout === c.vm.stdout,
      `a=${a.vm.code}/${JSON.stringify(a.vm.stdout)} b=${b.vm.code}/${JSON.stringify(b.vm.stdout)} c=${c.vm.code}/${JSON.stringify(c.vm.stdout)} `
      + `errA=${a.vm.stderr.slice(0, 80)} errC=${c.vm.stderr.slice(0, 80)}`);
  }

  // ---- v58.27(任务 26):遮蔽守卫(B 审查 MINOR-1):局部 str: Vec[str] 遮蔽导入 → Vec 方法 ----
  {
    const p = mk('b26_shadow_vec.ming', [
      'use std.str;',
      'fn main() with io {',
      '  let str: Vec[str] = ["a", "b"];',
      '  print(str.join(","));',
      '}',
      '',
    ].join('\n'));
    const c = runMing(['check', p]);
    const r = runMing(['run', p]);
    const rT = runMing(['run', p, '--tree']);
    const pBad = mk('b26b_shadow_m3002.ming', [
      'use std.str;',
      'fn main() with io {',
      '  let str: Vec[str] = ["a", "b"];',
      '  let other = ["x", "y"];',
      '  print(str.join(other));',
      '}',
      '',
    ].join('\n'));
    const cBad = runMing(['check', pBad]);
    check('v58.27:B27 shadow_guard —— 局部 str 遮蔽导入:check ok,tree/VM "a,b"(Vec 方法);str.join(其他 Vec) → checker M3002(分隔符须 str)',
      c.code === 0 && r.code === 0 && rT.code === 0 && r.stdout === 'a,b\n' && rT.stdout === 'a,b\n'
      && cBad.code === 1 && cBad.stderr.includes('M3002') && cBad.stderr.includes('join 的分隔符必须是 str'),
      `check=${c.code} run=${r.code} tree=${rT.code} bad=${cBad.code} err=${cBad.stderr.slice(0, 100)}`);
  }

  // ---- v58.28(任务 27):math 共存:use std.str + use std.math 同文件 ----
  {
    const p = mk('b27_str_math_coexist.ming', [
      'use std.str;',
      'use std.math;',
      'fn main() with io {',
      '  print(str.join(["a", "b"]));',
      '  print(str(math.sqrt(4.0)));',
      '}',
      '',
    ].join('\n'));
    const r = runMing(['run', p]);
    const rT = runMing(['run', p, '--tree']);
    check('v58.28:B28 str_math_coexist —— 同文件两导入:join 与 sqrt 均正常(双引擎 ab / 2.0)',
      r.code === 0 && rT.code === 0 && r.stdout === 'ab\n2.0\n' && rT.stdout === 'ab\n2.0\n',
      `run=${r.code} tree=${rT.code} out=${JSON.stringify(r.stdout)} err=${r.stderr.slice(0, 120)}`);
  }

  // ---- v58.29(任务 28):分配记账不对称 → v0.59(#49)已对称化 ----
  // v0.58 口径:std.str.join 结果不计入分配记账(100KB 结果在 60KB 配额下 exit 0);
  // Vec 方法 join 按结果长度计费 → M4011。#49 起 std.str.join 同样按结果长度计费,
  // 两形态在紧配额下同口径 M4011(不对称性已消除);此处按实际输出锁定。
  {
    const bigItems = Array.from({ length: 10000 }, () => '"abcdefghij"').join(', ');
    const pStd = mk('b28a_join_std_alloc.ming',
      'use std.str;\nfn main() with io {\n  let v: Vec[str] = [' + bigItems + '];\n  print(str(str.join(v).byte_len()));\n}\n');
    const rStd = runMing(['run', pStd, '--max-alloc', '60000']);
    const pVec = mk('b28b_join_vec_alloc.ming',
      'fn main() with io {\n  let v: Vec[str] = [' + bigItems + '];\n  print(str(v.join(",").byte_len()));\n}\n');
    const rVec = runMing(['run', pVec, '--max-alloc', '60000']);
    check('v58.29:B29 join_alloc_accounting —— --max-alloc 60000 下 100KB 结果:std.str.join 与 Vec.join 均按结果长度计费 → M4011 exit 101(#49 已对称化)',
      rStd.code === 101 && rStd.stderr.includes('M4011') && rStd.stderr.includes('累计分配 110000')
      && rVec.code === 101 && rVec.stderr.includes('M4011'),
      `std=${rStd.code}/${JSON.stringify((rStd.stderr ?? '').split('\n')[0])} `
      + `vec=${rVec.code}/${JSON.stringify((rVec.stderr ?? '').split('\n')[0])}`);
  }

  // ---- v58.30(任务 29):doc --json schema:六种 kind + 字段 + impl name + 泛型 impl 签名 ----
  {
    const p = mk('c30_doc_all_kinds.ming', [
      '/// 顶层常量文档',
      '/// 第二行文档',
      'const LIMIT: i64 = 3;',
      '',
      '/// 一对值',
      'struct Pair[A, B] { l: A, r: B, }',
      '',
      '/// 颜色',
      'enum Color { Red, Green }',
      '',
      '/// 相等',
      'trait Eq2 {',
      '  /// 判等',
      '  fn eq(self, other: Self) -> bool;',
      '}',
      '',
      'impl[A: Eq2, B: Eq2] Eq2 for Pair[A, B] {',
      '  /// 实现 eq',
      '  fn eq(self, other: Self) -> bool { return true; }',
      '}',
      '',
      'fn plain() -> i64 { return 1; }',
      '',
      'fn main() with io { print(str(plain())); }',
      '',
    ].join('\n'));
    const r = runMing(['doc', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 断言处报错 */ }
    const kinds = new Set((j?.items ?? []).map((i) => i.kind));
    const impl = (j?.items ?? []).find((i) => i.kind === 'impl');
    const fieldsOk = (j?.items ?? []).every((i) => typeof i.kind === 'string' && typeof i.name === 'string'
      && typeof i.line === 'number' && Array.isArray(i.doc) && typeof i.signature === 'string');
    check('v58.30:C30 doc_json_schema —— ok/file/items;六种 kind 各 ≥1;item 字段 kind/name/line/doc/signature;impl name=impl Eq2 for Pair;泛型 impl 签名重建',
      r.code === 0 && j?.ok === true && j.file === p && Array.isArray(j.items) && j.items.length >= 6
      && ['fn', 'struct', 'enum', 'trait', 'const', 'impl'].every((k) => kinds.has(k))
      && fieldsOk
      && impl?.name === 'impl Eq2 for Pair'
      && impl?.signature === 'impl[A, B] Eq2 for Pair[A, B] { fn eq(self, other: Self) -> bool }',
      `code=${r.code} kinds=${JSON.stringify([...kinds])} impl=${JSON.stringify(impl)}`);
  }

  // ---- v58.31(任务 30):无 /// → doc [];多行 /// 保序;methodSig 含 effects 与 requires/ensures ----
  {
    const pC = mk('c31_method_contract.ming', [
      '/// 存储',
      'trait Store {',
      '  fn save(self, path: str) -> i64;',
      '}',
      '',
      '/// 文件存储',
      'impl Store for Saver {',
      '  /// 保存并计数',
      '  fn save(self, path: str) -> i64 with fs requires path.len() > 0 else "path 非空" ensures result >= 0 else "非负" {',
      '    return 0;',
      '  }',
      '}',
      '',
      'struct Saver { n: i64, }',
      '',
      'fn main() with io { print("ok"); }',
      '',
    ].join('\n'));
    const r = runMing(['doc', pC, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 断言处报错 */ }
    const impl = (j?.items ?? []).find((i) => i.kind === 'impl');
    const main = (j?.items ?? []).find((i) => i.name === 'main');
    const pD = mk('c31_multidoc.ming', [
      '/// 第一行',
      '/// 第二行',
      'const K: i64 = 1;',
      '',
      'fn main() with io { print(str(K)); }',
      '',
    ].join('\n'));
    const rD = runMing(['doc', pD, '--json']);
    let jD = null;
    try { jD = JSON.parse(rD.stdout); } catch { /* 断言处报错 */ }
    const kItem = (jD?.items ?? []).find((i) => i.name === 'K');
    check('v58.31:C31 doc_json_doc_methodsig —— main 无 /// → doc [];多行 /// 保序;impl 方法签名含 with fs + requires/ensures 与 else 消息(逐字)',
      r.code === 0 && Array.isArray(main?.doc) && main.doc.length === 0
      && rD.code === 0 && JSON.stringify(kItem?.doc) === JSON.stringify([' 第一行', ' 第二行'])
      && impl?.signature === 'impl Store for Saver { fn save(self, path: str) -> i64 with fs requires path.len() > 0 else "path 非空" ensures result >= 0 else "非负" }',
      `main=${JSON.stringify(main?.doc)} k=${JSON.stringify(kItem?.doc)} impl=${JSON.stringify(impl?.signature)}`);
  }

  // ---- v58.32(任务 31):默认文本输出逐字不变;trait/impl 不列;多文件无 --index 保持单文件 ----
  {
    const pG = mk('g1.ming', [
      '/// 常量文档',
      '/// 第二行',
      'const LIMIT: i64 = 3;',
      '',
      '/// 打印',
      'fn main() with io { print("x"); }',
      '',
    ].join('\n'));
    const g = runMing(['doc', pG]);
    const expected = '## const LIMIT: i64 = ...\n常量文档\n第二行\n    (g1.ming:3)\n\n## fn main() with io\n打印\n    (g1.ming:6)\n\n';
    const pTI = mk('c32_trait_impl.ming', [
      '/// 存储',
      'trait Store {',
      '  fn save(self, path: str) -> i64;',
      '}',
      '',
      'impl Store for Saver {',
      '  fn save(self, path: str) -> i64 { return 0; }',
      '}',
      '',
      'struct Saver { n: i64, }',
      '',
      'fn main() with io { print("ok"); }',
      '',
    ].join('\n'));
    const ti = runMing(['doc', pTI]);
    const p2nd = mk('c32_second.ming', [
      'fn only_second() -> i64 { return 1; }',
      '',
      'fn main() with io { print(str(only_second())); }',
      '',
    ].join('\n'));
    const multi = runMing(['doc', pG, p2nd]);
    check('v58.32:C32 doc_text_unchanged —— 默认文本逐字不变(黄金);trait/impl 文件 text 不含 trait/impl 行;多文件无 --index 只处理第一个',
      g.code === 0 && g.stdout === expected
      && ti.code === 0 && ti.stdout.includes('## struct Saver') && !ti.stdout.includes('Store') && !ti.stdout.includes('impl ')
      && multi.code === 0 && multi.stdout.includes('LIMIT') && !multi.stdout.includes('only_second'),
      `g=${g.code} ti=${JSON.stringify(ti.stdout.slice(0, 60))} multi=${multi.code}`);
  }

  // ---- v58.33(任务 32):--index 多文件聚合 / 单文件同 schema / 错误路径 json 化 ----
  {
    const pA = mk('c33_idx_a.ming', [
      '/// 文档 A',
      'const LIMIT_A: i64 = 1;',
      '',
      'fn main() with io { print(str(LIMIT_A)); }',
      '',
    ].join('\n'));
    const pB = mk('c33_idx_b.ming', [
      '/// 文档 B',
      'const LIMIT_B: i64 = 2;',
      '',
      'fn main() with io { print(str(LIMIT_B)); }',
      '',
    ].join('\n'));
    const rMulti = runMing(['doc', pA, pB, '--index']);
    let jM = null;
    try { jM = JSON.parse(rMulti.stdout); } catch { /* 断言处报错 */ }
    const rSingle = runMing(['doc', pA, '--index']);
    let jS = null;
    try { jS = JSON.parse(rSingle.stdout); } catch { /* 断言处报错 */ }
    const rErr = runMing(['doc', path.join(dir, 'nope.ming'), '--index']);
    let jE = null;
    try { jE = JSON.parse(rErr.stdout); } catch { /* 断言处报错 */ }
    check('v58.33:C33 doc_index —— 多文件聚合 {ok, files:2, items 每项含 file 且两文件项都在};单文件 --index 同 schema(files:1);缺失文件 {ok:false,error} exit 1',
      rMulti.code === 0 && jM?.ok === true && jM.files === 2 && Array.isArray(jM.items) && jM.items.length >= 4
      && jM.items.every((i) => typeof i.file === 'string')
      && jM.items.some((i) => i.name === 'LIMIT_A' && i.file === pA) && jM.items.some((i) => i.name === 'LIMIT_B' && i.file === pB)
      && rSingle.code === 0 && jS?.ok === true && jS.files === 1 && jS.items.every((i) => i.file === pA)
      && rErr.code === 1 && jE?.ok === false && typeof jE.error === 'string' && jE.error.includes('无法读取'),
      `multi=${rMulti.code}/${jM?.files}/${jM?.items?.length} single=${jS?.files} err=${rErr.code}/${JSON.stringify(jE)}`);
  }

  // ---- v58.34(任务 33):release.yml 静态校验(零 YAML 依赖) ----
  {
    const ymlPath = path.join(ROOT, '.github', 'workflows', 'release.yml');
    const yml = fs.existsSync(ymlPath) ? fs.readFileSync(ymlPath, 'utf8') : null;
    const usesLines = yml === null ? [] : yml.split('\n').filter((l) => /^\s*uses:/.test(l)).map((l) => l.trim());
    const artifactName = 'name: ming-${{ github.ref_name }}';
    const zipName = 'ming-${{ github.ref_name }}.zip';
    check('v58.34:C34 release_workflow_static —— 可解析结构(name/jobs/steps);触发含 tags v* 与 workflow_dispatch;uses 全部 actions/ 前缀;artifact 名 ming-<tag> 无双 v',
      yml !== null && yml.startsWith('name: Release') && yml.includes('jobs:') && yml.includes('steps:')
      && yml.includes("tags: ['v*']") && yml.includes('workflow_dispatch:')
      && usesLines.length >= 3 && usesLines.every((l) => /^uses:\s*actions\//.test(l))
      && yml.includes(artifactName)
      && yml.includes(zipName)
      && !yml.includes('ming-v${{'),
      `exists=${yml !== null} uses=${JSON.stringify(usesLines)}`);
  }
}

// ===================== 63. v0.59:默认引擎全面性(wasm 覆盖收口 P1 + 本地函数恢复 P2 + invariant bench P3)=====================
// P1 组(v63.1–v63.21):#40 f64 局部/混合槽序、#42 Vec 多形参组合、#41 Map[str,i64]/i64 值 Index
//   (宿主补丁解锁)、#43 str 返回、#45 值型 if、#46 块尾 if(while/for/void/嵌套)、#48 记账
//   (str_cat/嵌套计数/插值不计费)、strConsts 常量非空 + AOT、剩余守护(VecLit/下标/mut/Option)
//   显式回落具名、Vec[f64] 形参解锁、fib 存活回归。
// P2 组(v63.22–v63.34):本地函数(#44,M3047 移除)——块级条目/嵌套块/递归/互递归/声明前调用/
//   作值/契约正例+违反 M4015/捕获拒绝 M3001/泛型 M3003/M3047 不发射/AOT/cc 拒绝/深递归。
// P3 组(v63.35–v63.36):bench invariant 项存在与基线键(信息性;exit 0 门禁)。
// P1 审查修复组(v63.37–v63.45):v0.59-P1 独立审查 3 阻塞 + MINOR——`<<` 结果溢出
//   (wasm/C 后端)、M4007 消息/位置(wasm 宿主 span)、VecLit/MapLit 记费、mut Vec/Vec[f64]
//   for-in、u64 ≥2^63 字面量 SLEB、i64.min/越界字面量守卫。
{
  const dir = path.join(TMP, 'v63');
  fs.mkdirSync(dir, { recursive: true });
  const m63 = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags63 = ['', '--no-wasm', '--tree'];
  const runAll63 = (p, extra = []) => flags63.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const same63 = (runs, want) => runs.every(r => r.code === 0 && r.stdout === want);
  const fmtRuns63 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');
  const strict63 = (p, extra = []) => runMing(['run', p, '--strict-wasm', ...extra], { env: { MING_WASM_DEBUG: '1' } });
  const wasmOk63 = (dbg, names) => dbg.code === 0 && names.every(n => (dbg.stderr ?? '').includes(`[wasm] fn ${n} OK`))
    && !(dbg.stderr ?? '').includes('REJECT') && !(dbg.stderr ?? '').includes('实例化失败');
  const ccAvail63 = (() => {
    if (process.env.MING_CC && fs.existsSync(process.env.MING_CC)) return true;
    for (const c of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
      if (fs.existsSync(c)) return true;
    }
    return spawnSync('gcc', ['--version'], { encoding: 'utf8' }).status === 0;
  })();
  const aot63 = (name, src) => {
    const proj = path.join(dir, name);
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'ming.toml'),
      `[project]\nname = "${name}"\nversion = "0.1.0"\nentry = "main.ming"\n`);
    fs.writeFileSync(path.join(proj, 'main.ming'), src);
    const b = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: proj, timeout: 60000 });
    const dist = path.join(proj, 'dist', 'ming-app.mjs');
    const r = b.status === 0 && fs.existsSync(dist)
      ? spawnSync(process.execPath, [dist], { encoding: 'utf8', cwd: proj, timeout: 60000 })
      : { status: -1, stdout: '', stderr: (b.stderr ?? '') + '(build failed)' };
    return { b, r };
  };

  // ---- v63.1(#40):f64 局部 + 算术 + 比较,strict ok 且三引擎一致 ----
  {
    const p = m63('p1_f40a.ming', [
      'fn f40a(n: i64, a: f64, b: f64) -> i64 {',
      '    let x = a + b;',
      '    let y = x * 2.0;',
      '    if y > 3.0 { return n + 1; }',
      '    return n;',
      '}',
      'fn main() with io { print(str(f40a(5, 1.5, 2.0))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.1:#40 f64 局部(i64/f64 形参 + let x = a+b + x*2.0 + 比较)f64→i64 三引擎一致且 strict wasm ok',
      same63(runs, '6\n') && wasmOk63(st, ['f40a']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 200))}`);
  }

  // ---- v63.2(#40):f64 局部 while 累加(f64 局部记账/回写) ----
  {
    const p = m63('p1_f40b.ming', [
      'fn f40b(n: i64) -> f64 {',
      '    let mut acc = 0.0;',
      '    let mut i = 0;',
      '    while i < n {',
      '        acc = acc + 0.5;',
      '        i += 1;',
      '    }',
      '    return acc;',
      '}',
      'fn main() with io { print(str(f40b(4))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.2:#40 f64 局部 while 累加(acc = acc + 0.5)三引擎一致(2.0)且 strict wasm ok',
      same63(runs, '2.0\n') && wasmOk63(st, ['f40b']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 200))}`);
  }

  // ---- v63.3(#40):混合类型局部顺序(i64/f64/Vec[i64] 形参交错) ----
  {
    const p = m63('p1_f40c.ming', [
      'fn f40c(n: i64, a: f64, v: Vec[i64], b: f64) -> i64 {',
      '    let s = a + b;',
      '    let mut t = n;',
      '    for k in v { t += k; }',
      '    if s > 0.0 { return t; }',
      '    return n;',
      '}',
      'fn main() with io { print(str(f40c(1, 1.0, [1, 2], 2.0))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.3:#40 混合槽序(i64,f64,Vec[i64],f64 形参交错;Vec for-in 与 f64 局部并存)三引擎一致且 strict ok',
      same63(runs, '4\n') && wasmOk63(st, ['f40c']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 200))}`);
  }

  // ---- v63.4(#42):Vec[i64]×2 + f64 + i64 多形参 for-in ----
  {
    const p = m63('p1_f42a.ming', [
      'fn f42a(v: Vec[i64], w: Vec[i64], k: f64, n: i64) -> i64 {',
      '    let mut s = 0;',
      '    for x in v { s += x; }',
      '    for y in w { s += y; }',
      '    if k > 0.0 { return s + n; }',
      '    return s - n;',
      '}',
      'fn main() with io { print(str(f42a([1, 2], [3, 4], 1.0, 5))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.4:#42 Vec[i64]×2 + f64 + i64 多形参(两段 for-in)三引擎一致(15)且 strict ok',
      same63(runs, '15\n') && wasmOk63(st, ['f42a']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 200))}`);
  }

  // ---- v63.5(#42):后位 f64 形参(Vec[i64], i64, f64) ----
  {
    const p = m63('p1_f42b.ming', [
      'fn f42b(v: Vec[i64], n: i64, k: f64) -> i64 {',
      '    let mut s = 0;',
      '    for x in v { s += x; }',
      '    if k > 0.0 { return s + n; }',
      '    return s;',
      '}',
      'fn main() with io { print(str(f42b([10, 20], 3, 0.5))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.5:#42 后位 f64 形参(Vec[i64], i64, f64)三引擎一致(33)且 strict ok',
      same63(runs, '33\n') && wasmOk63(st, ['f42b']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 200))}`);
  }

  // ---- v63.6(#41 + 宿主补丁):Map[str,i64] for-in + Index 三引擎 + strict ok ----
  {
    const p = m63('p1_f41a.ming', [
      'fn f41a(m: Map[str, i64]) -> i64 {',
      '    let mut s = 0;',
      '    for (k, v) in m { s += v; }',
      '    return s + m["b"];',
      '}',
      'fn main() with io { print(str(f41a({"a": 1, "b": 2}))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.6:#41 Map[str,i64] for-in + Index(`m["b"]`)三引擎一致(5)且 strict wasm ok(宿主 map_get_i64 返回 BigInt)',
      same63(runs, '5\n') && wasmOk63(st, ['f41a']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 200))}`);
  }

  // ---- v63.7(#41):Map[str,f64]/Map[str,str] for-in 三引擎 + strict ok ----
  {
    const pF = m63('p1_f41b.ming', [
      'fn f41b(m: Map[str, f64]) -> f64 {',
      '    let mut s = 0.0;',
      '    for (k, v) in m { s = s + v; }',
      '    return s;',
      '}',
      'fn main() with io { print(str(f41b({"a": 1.5, "b": 2.5}))); }',
      '',
    ].join('\n'));
    const pS = m63('p1_f41c.ming', [
      'fn f41c(m: Map[str, str]) -> str {',
      '    let mut s = "";',
      '    for (k, v) in m { s = s + v; }',
      '    return s;',
      '}',
      'fn main() with io { print(f41c({"a": "x", "b": "y"})); }',
      '',
    ].join('\n'));
    const rF = runAll63(pF);
    const rS = runAll63(pS);
    const stF = strict63(pF);
    const stS = strict63(pS);
    check('v63.7:#41 Map[str,f64]/Map[str,str] for-in 三引擎一致(4.0 / xy)且 strict wasm ok',
      same63(rF, '4.0\n') && same63(rS, 'xy\n') && wasmOk63(stF, ['f41b']) && wasmOk63(stS, ['f41c']),
      `f64=${fmtRuns63(rF)} str=${fmtRuns63(rS)} strictF=${stF.code} strictS=${stS.code}`);
  }

  // ---- v63.8(#43):str 返回(字面量/形参透传/拼接)+ [wasm 参数] ----
  {
    const p = m63('p1_f43a.ming', [
      'fn r_lit() -> str { return "abc"; }',
      'fn r_pass(s: str) -> str { return s; }',
      'fn r_cat(a: str, b: str) -> str { return a + b; }',
      'fn main() with io {',
      '    print(r_lit());',
      '    print(r_pass("hello"));',
      '    print(r_cat("ab", "cd"));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.8:#43 str 返回(字面量/形参透传/拼接)三引擎一致且 strict ok + [wasm 参数] 可见 str 封送',
      same63(runs, 'abc\nhello\nabcd\n') && wasmOk63(st, ['r_lit', 'r_pass', 'r_cat'])
      && (st.stderr ?? '').includes('[wasm 参数] 0 pt= str/b- a= str'),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 240))}`);
  }

  // ---- v63.9(#43):str 返回值型 if / 块尾表达式 ----
  {
    const p = m63('p1_f43b.ming', [
      'fn r_if(n: i64) -> str { return if n > 0 { "pos" } else { "neg" }; }',
      'fn r_tail(n: i64) -> str {',
      '    if n > 0 { "yes" } else { "no" }',
      '}',
      'fn main() with io {',
      '    print(r_if(1)); print(r_if(-1));',
      '    print(r_tail(1)); print(r_tail(-1));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.9:#43 str 返回值型 if / 块尾 if 表达式(i32 句柄 blocktype)三引擎一致且 strict ok',
      same63(runs, 'pos\nneg\nyes\nno\n') && wasmOk63(st, ['r_if', 'r_tail']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 240))}`);
  }

  // ---- v63.10(#45):值型 if i64/f64/str ----
  {
    const p = m63('p1_f45a.ming', [
      'fn ifi(n: i64) -> i64 { let x = if n > 0 { 1 } else { 2 }; return x; }',
      'fn iff(n: i64) -> f64 { let y = if n > 0 { 1.5 } else { 2.5 }; return y; }',
      'fn ifs(n: i64) -> str { let s = if n > 0 { "a" } else { "b" }; return s; }',
      'fn main() with io {',
      '    print(str(ifi(1))); print(str(ifi(-1)));',
      '    print(str(iff(1))); print(str(iff(-1)));',
      '    print(ifs(1)); print(ifs(-1));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.10:#45 值型 if i64/f64/str(单字节 valtype blocktype)三引擎一致且 strict ok',
      same63(runs, '1\n2\n1.5\n2.5\na\nb\n') && wasmOk63(st, ['ifi', 'iff', 'ifs']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 240))}`);
  }

  // ---- v63.11(#45):else-if 链 + &&/|| 条件 ----
  {
    const p = m63('p1_f45b.ming', [
      'fn ifchain(n: i64) -> i64 {',
      '    let x = if n > 5 { 1 } else if n > 0 { 2 } else { 3 };',
      '    return x;',
      '}',
      'fn ifand(a: i64, b: i64) -> i64 { let x = if a > 0 && b > 0 { 1 } else { 0 }; return x; }',
      'fn ifor(a: i64, b: i64) -> i64 { let x = if a > 0 || b > 0 { 1 } else { 0 }; return x; }',
      'fn main() with io {',
      '    print(str(ifchain(9))); print(str(ifchain(3))); print(str(ifchain(-1)));',
      '    print(str(ifand(1, 1))); print(str(ifand(1, 0)));',
      '    print(str(ifor(0, 0))); print(str(ifor(1, 0)));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.11:#45 值型 else-if 链 + &&/|| 条件三引擎一致且 strict ok',
      same63(runs, '1\n2\n3\n1\n0\n0\n1\n') && wasmOk63(st, ['ifchain', 'ifand', 'ifor']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 240))}`);
  }

  // ---- v63.12(#46):while/for 语句位 if 的 continue/break ----
  {
    const p = m63('p1_f46a.ming', [
      'fn w46(n: i64) -> i64 {',
      '    let mut i = 0; let mut s = 0;',
      '    while i < n {',
      '        i += 1;',
      '        if i % 2 == 0 { continue; }',
      '        s += i;',
      '    }',
      '    return s;',
      '}',
      'fn f46(v: Vec[i64]) -> i64 {',
      '    let mut s = 0;',
      '    for x in v {',
      '        if x == 0 { continue; }',
      '        if x > 100 { break; }',
      '        s += x;',
      '    }',
      '    return s;',
      '}',
      'fn main() with io {',
      '    print(str(w46(6)));',
      '    print(str(f46([5, 0, 7, 200])));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.12:#46 while/for 语句位 if(continue/break;无 else)三引擎一致且 strict ok',
      same63(runs, '9\n12\n') && wasmOk63(st, ['w46', 'f46']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 240))}`);
  }

  // ---- v63.13(#46):void 函数体尾 if + 嵌套块尾 if(break/return) ----
  {
    const p = m63('p1_f46b.ming', [
      'fn void46(n: i64) {',
      '    let mut i = 0;',
      '    while i < n {',
      '        i += 1;',
      '        if i == 2 { return; }',
      '    }',
      '}',
      'fn nest46(n: i64) -> i64 {',
      '    let mut s = 0; let mut i = 0;',
      '    while i < n {',
      '        i += 1;',
      '        if i > 2 {',
      '            if i == 4 { break; }',
      '            s += i;',
      '        }',
      '    }',
      '    return s;',
      '}',
      'fn main() with io { void46(9); print(str(nest46(10))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.13:#46 void 函数体尾 if + 嵌套块尾 if(break/return;unit 上下文按语句编译)三引擎一致且 strict ok',
      same63(runs, '3\n') && wasmOk63(st, ['void46', 'nest46']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 240))}`);
  }

  // ---- v63.14(#48):plan §5.1 复现——wasm str_cat 计费三引擎 M4011 累计 120000 ----
  {
    const bigA = 'A'.repeat(120000);
    const p = m63('p1_f48plan.ming',
      'fn probe(a: str) -> i64 { if a + "' + bigA + '" == "x" { return 1; } return 0; }\n'
      + 'fn main() with io { print(str(probe(""))); }\n');
    const runs = runAll63(p, ['--max-alloc', '50000']);
    const ok = runs.every(r => r.code === 101 && (r.stderr ?? '').includes('M4011') && (r.stderr ?? '').includes('累计分配 120000'));
    check('v63.14:#48 plan §5.1 复现(--max-alloc 50000):默认(wasm)/--no-wasm/--tree 均 M4011 exit 101,累计 120000',
      ok, runs.map(r => `${r.code}:${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | '));
  }

  // ---- v63.15(#48):嵌套拼接计数——内层 11、外层 15(累计 11 → 26) ----
  {
    const p = m63('p1_f48nest.ming', [
      'fn nest(a: str, b: str, c: str) -> str {',
      '    return (a + b) + c;',
      '}',
      'fn main() with io { print(nest("aaaaa", "bbbbbb", "cccc")); }',
      '',
    ].join('\n'));
    const r10 = runAll63(p, ['--max-alloc', '10']);
    const r20 = runAll63(p, ['--max-alloc', '20']);
    const ok = r10.every(r => r.code === 101 && (r.stderr ?? '').includes('累计分配 11'))
      && r20.every(r => r.code === 101 && (r.stderr ?? '').includes('累计分配 26'));
    check('v63.15:#48 嵌套拼接计数:内层 11(配额 10 → 累计 11),外层 15(配额 20 → 累计 26);三引擎同口径',
      ok, `10:${r10.map(r => r.code).join(',')} 20:${r20.map(r => r.code).join(',')}`);
  }

  // ---- v63.16(#48):插值不计费(与 interp 同口径;--max-alloc 1 三引擎 exit 0) ----
  {
    const p = m63('p1_f48interp.ming', [
      'fn interp(n: i64) -> str {',
      '    return "v=\\{n}";',
      '}',
      'fn main() with io { print(interp(42)); }',
      '',
    ].join('\n'));
    const runs = runAll63(p, ['--max-alloc', '1']);
    const st = strict63(p, ['--max-alloc', '1']);
    check('v63.16:#48 插值不计费(--max-alloc 1 → 三引擎 exit 0 输出 v=42;strict wasm ok)',
      same63(runs, 'v=42\n') && wasmOk63(st, ['interp']),
      `${fmtRuns63(runs)} strict=${st.code}`);
  }

  // ---- v63.17(strConsts):字符串常量不再为空("a"=="b" false / "a"=="a" true) ----
  {
    const p = m63('p1_strconsts.ming', [
      'fn eqab() -> i64 { if "a" == "b" { return 1; } return 0; }',
      'fn eqaa() -> i64 { if "a" == "a" { return 1; } return 0; }',
      'fn main() with io { print(str(eqab())); print(str(eqaa())); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.17:strConsts 随产物返回——"a"=="b" 为 0(不再因空常量表误判真),"a"=="a" 为 1;三引擎一致且 strict ok',
      same63(runs, '0\n1\n') && wasmOk63(st, ['eqab', 'eqaa']),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 200))}`);
  }

  // ---- v63.18(strConsts/AOT):build 产物中 str 常量与 str 返回正确 ----
  {
    const a = aot63('aot_strconsts', [
      'fn greeting(name: str) -> str {',
      '    return "hi, " + name;',
      '}',
      'fn main() with io {',
      '    print(greeting("ming"));',
      '    print(str("a" == "b"));',
      '}',
      '',
    ].join('\n'));
    check('v63.18:AOT build + dist 运行 str 返回/常量正确(hi, ming + false;strConsts 随 artifact 持久化)',
      a.b.status === 0 && a.r.status === 0 && a.r.stdout === 'hi, ming\nfalse\n',
      `build=${a.b.status} run=${a.r.status} out=${JSON.stringify(a.r.stdout)} err=${JSON.stringify((a.r.stderr ?? '').slice(0, 160))}`);
  }

  // ---- v63.19(引导守护):VecLit/下标/mut 写/Option 链显式回落,原因具名,输出三引擎一致 ----
  {
    const cases = [
      ['veclit', [
        'fn vl(n: i64) -> i64 { let v = [1, 2, 3]; return v[0] + n; }',
        'fn main() with io { print(str(vl(4))); }',
      ].join('\n'), '5\n', 'vl', 'VecLit 数值元素(容器表示待统一)'],
      ['vecread', [
        'fn vr(v: Vec[i64]) -> i64 { return v[0]; }',
        'fn main() with io { print(str(vr([7, 8]))); }',
      ].join('\n'), '7\n', 'vr', 'Vec 下标读(宿主 panic_m4003 导入待补)'],
      ['vecwrite', [
        'fn vw(mut v: Vec[i64]) -> i64 { v[0] = 5; return v[1]; }',
        'fn main() with io { print(str(vw([1, 2]))); }',
      ].join('\n'), '2\n', 'vw', 'mut Vec 元素写(宿主 panic_m4003 导入待补)'],
      ['option', [
        'fn og(m: Map[str, i64]) -> i64 { return m.get("a").unwrap(); }',
        'fn main() with io { print(str(og({"a": 3}))); }',
      ].join('\n'), '3\n', 'og', 'Option 消费链(宿主 M4006/M4007 导入待补)'],
    ];
    let allOk = true;
    const detail = [];
    for (const [name, src, want, fnName, reason] of cases) {
      const p = m63('p1_guard_' + name + '.ming', src);
      const runs = runAll63(p);
      const st = strict63(p);
      const ok = same63(runs, want) && st.code === 2 && st.stdout === ''
        && (st.stderr ?? '').includes(`wasm 编译回落(${fnName})`) && (st.stderr ?? '').includes(reason);
      if (!ok) allOk = false;
      detail.push(`${name}:${runs.map(r => r.code).join(',')}:strict=${st.code}`);
    }
    check('v63.19:剩余守护(VecLit/下标/mut 写/Option 链)strict exit 2 且回落原因具名;非 strict 三引擎输出逐字一致',
      allOk, detail.join(' | '));
  }

  // ---- v63.20(宿主补丁):Vec[f64] 形参解锁,strict wasm ok ----
  {
    const p = m63('p1_vecf64param.ming', [
      'fn vfp(v: Vec[f64]) -> f64 { return 2.5; }',
      'fn main() with io { print(str(vfp([1.5, 2.5]))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    check('v63.20:Vec[f64] 形参(宿主 wasmWriteVecNum 认 float)三引擎一致且 strict wasm ok + [wasm 参数] vec',
      same63(runs, '2.5\n') && wasmOk63(st, ['vfp'])
      && (st.stderr ?? '').includes('[wasm 参数] 0 pt= vec/b- a= vec'),
      `${fmtRuns63(runs)} strict=${st.code} ${JSON.stringify((st.stderr ?? '').slice(0, 200))}`);
  }

  // ---- v63.21(存活回归):examples/fib strict 下 fib/fib_loop 真实经 wasm ----
  {
    const st = strict63(path.join(ROOT, 'examples', 'fib.ming'));
    const expectFib = Array.from({ length: 11 }, (_, i) => `fib(${i}) = ${[0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55][i]}`).join('\n') + '\n';
    check('v63.21:examples/fib --strict-wasm exit 0,输出逐字不变且 [wasm] fn fib OK / fib_loop OK,无 REJECT/实例化失败',
      st.code === 0 && st.stdout === expectFib && wasmOk63(st, ['fib', 'fib_loop']),
      `code=${st.code} out=${JSON.stringify(st.stdout.slice(0, 80))} ${JSON.stringify((st.stderr ?? '').slice(0, 240))}`);
  }

  // ================= P2 组:本地函数(#44,M3047 移除) =================

  // ---- v63.22:块顶层本地函数(声明+调用)三引擎一致 ----
  {
    const p = m63('p2_top.ming', [
      'fn main() with io {',
      '    fn twice(a: i64) -> i64 { return a * 2; }',
      '    print(str(twice(3)));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const ck = runMing(['check', p]);
    check('v63.22:本地函数块顶层——check/run/--tree/--no-wasm exit 0 输出 6;无 M3047',
      same63(runs, '6\n') && ck.code === 0 && !(ck.stderr ?? '').includes('M3047'),
      `${fmtRuns63(runs)} check=${ck.code}:${JSON.stringify((ck.stderr ?? '').slice(0, 160))}`);
  }

  // ---- v63.23:嵌套块内本地函数 ----
  {
    const p = m63('p2_nested.ming', [
      'fn main() with io {',
      '    if true {',
      '        fn inner() -> i64 { return 7; }',
      '        print(str(inner()));',
      '    }',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    check('v63.23:嵌套块本地函数(if 块内声明/调用)三引擎一致(7)',
      same63(runs, '7\n'), fmtRuns63(runs));
  }

  // ---- v63.24:本地函数自递归 ----
  {
    const p = m63('p2_rec.ming', [
      'fn main() with io {',
      '    fn local_fact(n: i64) -> i64 {',
      '        if n <= 1 { return 1; }',
      '        return n * local_fact(n - 1);',
      '    }',
      '    print(str(local_fact(5)));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    check('v63.24:本地函数自递归(独立帧 + 自身可见)三引擎一致(120)',
      same63(runs, '120\n'), fmtRuns63(runs));
  }

  // ---- v63.25:互递归 + 声明前调用(块级条目可见性) ----
  {
    const p = m63('p2_mutual.ming', [
      'fn main() with io {',
      '    print(str(is_even(10)));',
      '    print(str(later(3)));',
      '    fn later(n: i64) -> i64 { return n + 100; }',
      '    fn is_even(n: i64) -> i64 {',
      '        if n == 0 { return 1; }',
      '        return is_odd(n - 1);',
      '    }',
      '    fn is_odd(n: i64) -> i64 {',
      '        if n == 0 { return 0; }',
      '        return is_even(n - 1);',
      '    }',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    check('v63.25:本地函数互递归 + 声明前调用(块级条目,不要求声明序)三引擎一致(1 / 103)',
      same63(runs, '1\n103\n'), fmtRuns63(runs));
  }

  // ---- v63.26:本地函数作值(传给 HOF map) ----
  {
    const p = m63('p2_value.ming', [
      'fn main() with io {',
      '    fn inc(x: i64) -> i64 { return x + 1; }',
      '    let w = [1, 2, 3].map(inc);',
      '    print(str(w.len()));',
      '    print(str(w[2]));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const ck = runMing(['check', p]);
    check('v63.26:本地函数作值(传给 map;LDFN→vclose 路径)三引擎一致(3 / 4)且 check exit 0',
      same63(runs, '3\n4\n') && ck.code === 0,
      `${fmtRuns63(runs)} check=${ck.code}`);
  }

  // ---- v63.27:本地函数契约正例(requires/ensures 三引擎执行) ----
  {
    const p = m63('p2_contract.ming', [
      'fn main() with io {',
      '    fn inc(a: i64) -> i64 requires a > 0 ensures result > a { return a + 1; }',
      '    print(str(inc(1)));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const ck = runMing(['check', p]);
    check('v63.27:本地函数契约正例(requires/ensures)check exit 0 且三引擎一致(2)',
      same63(runs, '2\n') && ck.code === 0, `${fmtRuns63(runs)} check=${ck.code}`);
  }

  // ---- v63.28:本地函数契约违反 → M4015 exit 101(三引擎逐字) ----
  {
    const p = m63('p2_violate.ming', [
      'fn main() with io {',
      '    fn inc(a: i64) -> i64 requires a > 0 ensures result > a { return a + 1; }',
      '    print(str(inc(0)));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const ok = runs.every(r => r.code === 101 && (r.stderr ?? '').includes('M4015')
      && (r.stderr ?? '').includes('requires (实际: false)'));
    check('v63.28:本地函数 requires 违反 → 三引擎 M4015 exit 101(消息逐字)',
      ok, runs.map(r => `${r.code}:${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | '));
  }

  // ---- v63.29:本地函数捕获外层局部 → M3001 拒绝(不捕获语义) ----
  {
    const p = m63('p2_capture.ming', [
      'fn main() with io {',
      '    let base = 10;',
      '    fn add_base(n: i64) -> i64 { return n + base; }',
      '    print(str(add_base(1)));',
      '}',
      '',
    ].join('\n'));
    const ck = runMing(['check', p]);
    const run = runMing(['run', p]);
    check('v63.29:本地函数引用外层局部 → check/run exit 1 + M3001(帧不捕获外层局部)',
      ck.code === 1 && (ck.stderr ?? '').includes('M3001') && (ck.stderr ?? '').includes('找不到值 "base"')
      && run.code === 1 && (run.stderr ?? '').includes('M3001') && !(run.stderr ?? '').includes('M3047'),
      `check=${ck.code} run=${run.code} ${JSON.stringify((ck.stderr ?? '').split('\n').filter(l => l.includes('M3001')).slice(0, 1))}`);
  }

  // ---- v63.30:泛型本地函数 → M3048(声明处显式拒绝,专用码;无 T 级联) ----
  {
    const p = m63('p2_generic.ming', [
      'fn main() with io {',
      '    fn id[T](x: T) -> T { return x; }',
      '    print(str(id(1)));',
      '}',
      '',
    ].join('\n'));
    const ck = runMing(['check', p]);
    const run = runMing(['run', p]);
    check('v63.30:泛型本地函数 → check/run exit 1 + M3048(generic-local-fn-unsupported;无 M3003/实际是 T 级联)',
      ck.code === 1 && (ck.stderr ?? '').includes('M3048') && (ck.stderr ?? '').includes('不支持类型参数')
      && !(ck.stderr ?? '').includes('M3003') && !(ck.stderr ?? '').includes('实际是 T')
      && run.code === 1 && !(ck.stderr ?? '').includes('M3047'),
      `check=${ck.code} run=${run.code} ${JSON.stringify((ck.stderr ?? '').slice(0, 300))}`);
  }

  // ---- v63.31:M3047 不再发射(四个本地函数形态 check stderr 均无该码) ----
  {
    const cases = [
      ['top', 'fn main() with io { fn f() -> i64 { return 1; } print(str(f())); }'],
      ['nested', 'fn main() with io { if true { fn g() -> i64 { return 2; } print(str(g())); } }'],
      ['value', 'fn main() with io { fn inc(x: i64) -> i64 { return x + 1; } print(str([1].map(inc).len())); }'],
      ['contract', 'fn main() with io { fn h(a: i64) -> i64 requires a > 0 { return a; } print(str(h(1))); }'],
    ];
    let allOk = true;
    const detail = [];
    for (const [name, src] of cases) {
      const p = m63('p2_m3047_' + name + '.ming', src + '\n');
      const ck = runMing(['check', p]);
      if (ck.code !== 0 || (ck.stderr ?? '').includes('M3047')) allOk = false;
      detail.push(`${name}=${ck.code}/${(ck.stderr ?? '').includes('M3047')}`);
    }
    check('v63.31:M3047[local-fn-unsupported] 不再发射(四形态 check exit 0 且 stderr 无 M3047)',
      allOk, detail.join(' '));
  }

  // ---- v63.32:AOT 字节码产物含本地函数(build + dist 运行) ----
  {
    const a = aot63('aot_local_fn', [
      'fn main() with io {',
      '    fn twice(a: i64) -> i64 { return a * 2; }',
      '    print(str(twice(21)));',
      '}',
      '',
    ].join('\n'));
    check('v63.32:AOT build 本地函数产物 + dist 运行(42;字节码产物非源码回退)',
      a.b.status === 0 && a.r.status === 0 && a.r.stdout === '42\n'
      && ((a.b.stdout ?? '') + (a.b.stderr ?? '')).includes('app.bytecode.json')
      && !((a.b.stdout ?? '') + (a.b.stderr ?? '')).includes('回退源码模式'),
      `build=${a.b.status} run=${a.r.status} out=${JSON.stringify(a.r.stdout)} log=${JSON.stringify(((a.b.stdout ?? '') + (a.b.stderr ?? '')).slice(0, 200))} err=${JSON.stringify((a.r.stderr ?? '').slice(0, 160))}`);
  }

  // ---- v63.33:C 后端仍不支持块内 FnStmt(exit 1 + C1;无编译器跳过) ----
  {
    const p = m63('p2_cc.ming', [
      'fn main() with io {',
      '    fn twice(a: i64) -> i64 { return a * 2; }',
      '    print(str(twice(3)));',
      '}',
      '',
    ].join('\n'));
    const rc = ccAvail63 ? runMing(['cc', p]) : null;
    check('v63.33:cc(C 后端)遇块内 FnStmt → exit 1 + stderr `语句 FnStmt`(无编译器自动跳过)',
      !rc || (rc.code === 1 && (rc.stderr ?? '').includes('C1 不支持') && (rc.stderr ?? '').includes('语句 FnStmt')),
      rc ? `cc=${rc.code} ${JSON.stringify((rc.stderr ?? '').split('\n')[0])}` : 'skip(无编译器)');
  }

  // ---- v63.34:本地函数深递归 M4005(仅断言消息与 exit,不断言帧数) ----
  {
    const p = m63('p2_deep.ming', [
      'fn main() with io {',
      '    fn down(n: i64) -> i64 {',
      '        if n == 0 { return 0; }',
      '        return down(n - 1);',
      '    }',
      '    print(str(down(100000)));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const ok = runs.every(r => r.code === 101 && (r.stderr ?? '').includes('M4005')
      && (r.stderr ?? '').includes('调用栈过深(>250 层递归);如需更深递归请改写为循环'));
    check('v63.34:本地函数深递归 → 三引擎 M4005 exit 101(消息逐字;不断言帧数)',
      ok, runs.map(r => `${r.code}:${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | '));
  }

  // ================= P1 审查修复组(阻塞 1–3 + MINOR;v63.37–v63.44) =================

  // ---- v63.37(阻塞 1):i64 `<<` 结果溢出——wasm 不再静默回绕,三引擎 M4002 exit 101 ----
  {
    const p = m63('p1r_shift_i64.ming', [
      'fn sh(a: i64, b: i64) -> i64 {',
      '    return a << b;',
      '}',
      'fn main() with io { print(str(sh(3, 62))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    const ok = runs.every(r => r.code === 101 && (r.stderr ?? '').includes('M4002'))
      && st.code === 101 && (st.stderr ?? '').includes('M4002')
      // wasm 层通用文案(既有口径)与 tree/VM 具体文案的差异如实锁定:码/退出码/位置一致
      && (st.stderr ?? '').includes('整数运算溢出/移位越界') && (st.stderr ?? '').includes(`${p}:2:14:`)
      && (runs[2].stderr ?? '').includes('整数<<溢出:3 << 62 超出 i64 范围');
    check('v63.37(阻塞1):i64 `<<` 结果溢出三引擎 M4002 exit 101;strict wasm 不再 ok(wasm 通用文案+同位置,tree 具体文案)',
      ok, `runs=${fmtRuns63(runs)} strict=${st.code}:${JSON.stringify((st.stderr ?? '').split('\n')[0])}`);
  }

  // ---- v63.38(阻塞 1):u64 `<<` 结果溢出同上(逻辑右移回检) ----
  {
    const p = m63('p1r_shift_u64.ming', [
      'fn ush(a: u64, b: u64) -> u64 { return a << b; }',
      'fn main() with io { print(str(ush(3u64, 63u64))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    const ok = runs.every(r => r.code === 101 && (r.stderr ?? '').includes('M4002'))
      && st.code === 101 && (st.stderr ?? '').includes('M4002')
      && (runs[2].stderr ?? '').includes('整数<<溢出:3 << 63 超出 i64u 范围');
    check('v63.38(阻塞1):u64 `<<` 结果溢出三引擎 M4002 exit 101;strict wasm 不再 ok',
      ok, `runs=${fmtRuns63(runs)} strict=${st.code}:${JSON.stringify((st.stderr ?? '').split('\n')[0])}`);
  }

  // ---- v63.39(阻塞 1):范围边界——不溢出的移位保持正确值(含 i64.min/0 位移) ----
  {
    const p = m63('p1r_shift_ok.ming', [
      'fn sh(a: i64, b: i64) -> i64 { return a << b; }',
      'fn ush(a: u64, b: u64) -> u64 { return a << b; }',
      'fn main() with io {',
      '    print(str(sh(1, 62)));',
      '    print(str(sh(-1, 63)));',
      '    print(str(sh(0, 63)));',
      '    print(str(sh(7, 0)));',
      '    print(str(ush(1u64, 62u64)));',
      '    print(str(ush(18446744073709551615u64, 0u64)));',
      '}',
      '',
    ].join('\n'));
    const want = '4611686018427387904\n-9223372036854775808\n0\n7\n4611686018427387904\n18446744073709551615\n';
    const runs = runAll63(p);
    const st = strict63(p);
    const cc = ccAvail63 ? runMing(['cc', p]) : null;
    const ok = same63(runs, want) && st.code === 0 && st.stdout === want
      && (!cc || (cc.code === 0 && cc.stdout === want));
    check('v63.39(阻塞1):不溢出移位边界保持(1<<62/-1<<63/0<<63/7<<0/u64)三引擎 + C 腿逐字',
      ok, `runs=${fmtRuns63(runs)} strict=${st.code} cc=${cc ? cc.code + ':' + JSON.stringify(cc.stdout) : 'skip'}`);
  }

  // ---- v63.40(阻塞 1,C 腿):eligible 函数内通用消息 / main 内具体消息(既有 C 对齐口径) ----
  {
    const pf = m63('p1r_cc_fn.ming', [
      'fn sh(a: i64, b: i64) -> i64 { return a << b; }',
      'fn main() with io { print(str(sh(3, 62))); }',
      '',
    ].join('\n'));
    const pm = m63('p1r_cc_main.ming', [
      'fn main() with io { let v = 3 << 62; print(str(v)); }',
      '',
    ].join('\n'));
    const r1 = ccAvail63 ? runMing(['cc', pf]) : null;
    const r2 = ccAvail63 ? runMing(['cc', pm]) : null;
    check('v63.40(阻塞1/C):C 腿左移溢出 exit 101 M4002——eligible 函数通用文案、main 具体文案(与 tree 逐字);无编译器自动跳过',
      (!r1 && !r2) || (r1 && r2 && r1.code === 101 && r2.code === 101
        && (r1.stderr ?? '').includes('M4002') && (r1.stderr ?? '').includes('整数运算溢出/移位越界')
        && (r2.stderr ?? '').includes('整数<<溢出:3 << 62 超出 i64 范围')),
      `fn=${r1 ? r1.code + ':' + JSON.stringify((r1.stderr ?? '').split('\n')[0]) : 'skip'} `
      + `main=${r2 ? r2.code + ':' + JSON.stringify((r2.stderr ?? '').split('\n')[0]) : 'skip'}`);
  }

  // ---- v63.41(阻塞 2):wasm M4007 消息/位置与 tree/VM 逐字(引号 + 后缀 + file:line:col) ----
  {
    const p = m63('p1r_map_missing.ming', [
      'fn getv(m: Map[str, i64], k: str) -> i64 {',
      '    return m[k];',
      '}',
      'fn main() with io {',
      '    let m = {"a": 1};',
      '    print(str(getv(m, "a")));',
      '    print(str(getv(m, "zz")));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    const wantFirst = `${p}:2:13: error M4007[missing-key]: map 中不存在键 "zz"(用 .get(k) 返回 Option)`;
    const first = (r) => (r.stderr ?? '').split('\n')[0];
    // strict 运行时 MING_WASM_DEBUG=1 会先打调试行,按 error 行定位
    const errOf = (r) => ((r.stderr ?? '').split('\n').find(l => l.includes('error M4007')) ?? '');
    const ok = runs.every(r => r.code === 101 && first(r) === wantFirst)
      && st.code === 101 && errOf(st) === wantFirst && st.stdout === '1\n';
    check('v63.41(阻塞2):缺键 M4007 首行三引擎逐字(wasm 宿主 span 实参:引号+后缀+位置,不再 <unknown>:0:0)',
      ok, `runs=${runs.map(r => r.code + ':' + JSON.stringify(first(r))).join(' | ')} strict=${st.code}:${JSON.stringify(errOf(st))}`);
  }

  // ---- v63.42(阻塞 3):VecLit/MapLit 记账——--max-alloc 1 下 wasm 不再绕过 ----
  {
    const pm = m63('p1r_alloc_map.ming', [
      'fn f() -> i64 {',
      '    let m = {"a": 1, "b": 2};',
      '    return m["a"];',
      '}',
      'fn main() with io { print(str(f())); }',
      '',
    ].join('\n'));
    const pv = m63('p1r_alloc_vec.ming', [
      'fn f() -> i64 {',
      '    let v = ["a", "b"];',
      '    return 1;',
      '}',
      'fn main() with io { print(str(f())); }',
      '',
    ].join('\n'));
    const runQ = (p, extra) => [[], ['--no-wasm'], ['--tree']].map(f => runMing(['run', p, ...extra, ...f]));
    const runA = (p) => runQ(p, ['--max-alloc', '1']);
    const errLine = (r) => ((r.stderr ?? '').split('\n').find(l => l.includes('error M4011')) ?? '');
    const rm = runA(pm);
    const rv = runA(pv);
    const stm = strict63(pm, ['--max-alloc', '1']);
    const stv = strict63(pv, ['--max-alloc', '1']);
    const wantM = `${pm}:2:13: error M4011[alloc-quota-exceeded]: 内存配额超限:累计分配 2 超过上限 1(用 --max-alloc 调整)`;
    const wantV = `${pv}:2:13: error M4011[alloc-quota-exceeded]: 内存配额超限:累计分配 2 超过上限 1(用 --max-alloc 调整)`;
    const okOvf = rm.every(r => r.code === 101 && errLine(r) === wantM)
      && rv.every(r => r.code === 101 && errLine(r) === wantV)
      && stm.code === 101 && errLine(stm) === wantM && stv.code === 101 && errLine(stv) === wantV;
    // 配额充足:正常输出(strict 下 wasm 真实执行)
    const okRun = same63(runQ(pm, ['--max-alloc', '100']), '1\n');
    const stOk = strict63(pm, ['--max-alloc', '100']);
    check('v63.42(阻塞3):Map/Vec 字面量经 ming_alloc 按元素数记账——--max-alloc 1 三引擎 M4011 首行逐字(含位置);配额充足正常',
      okOvf && okRun && stOk.code === 0 && stOk.stdout === '1\n'
      && (stOk.stderr ?? '').includes('[wasm] fn f OK'),
      `map=${rm.map(r => r.code + ':' + JSON.stringify(errLine(r))).join(' | ')} `
      + `vec=${rv.map(r => r.code).join(',')} strict=${stm.code}/${stv.code} ok=${stOk.code}:${JSON.stringify(stOk.stdout)}`);
  }

  // ---- v63.43(MINOR 1/2):mut Vec for-in 解锁(vi64ptrm 剥后缀)+ Vec[f64] 元素值 ----
  {
    const p = m63('p1r_for_minor.ming', [
      'fn sumv(mut v: Vec[i64]) -> i64 {',
      '    let mut t = 0;',
      '    for x in v { t = t + x; }',
      '    return t;',
      '}',
      'fn sumf(v: Vec[f64]) -> f64 {',
      '    let mut t = 0.0;',
      '    for x in v { t = t + x; }',
      '    return t;',
      '}',
      'fn main() with io {',
      '    print(str(sumv([1, 2, 3])));',
      '    print(str(sumf([1.5, 2.5])));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    const ok = same63(runs, '6\n4.0\n') && wasmOk63(st, ['sumv', 'sumf']) && st.stdout === '6\n4.0\n';
    check('v63.43(MINOR1/2):mut Vec for-in(`vi64ptrm` 剥后缀)与 Vec[f64] for-in 元素值 6/4.0;strict wasm sumv/sumf OK',
      ok, `runs=${fmtRuns63(runs)} strict=${st.code}:${JSON.stringify(st.stdout)} `
      + `dbg=${(st.stderr ?? '').split('\n').filter(l => l.includes('[wasm] fn')).join(',')}`);
  }

  // ---- v63.44(MINOR 6):u64 字面量 ≥2^63 的 SLEB 编码——strict wasm 实例化存活 ----
  {
    const p = m63('p1r_u64_lit.ming', [
      'fn f() -> u64 { return 18446744073709551615u64; }',
      'fn main() with io { print(str(f())); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    const ok = same63(runs, '18446744073709551615\n') && wasmOk63(st, ['f']) && st.stdout === '18446744073709551615\n';
    check('v63.44(MINOR6):u64 字面量 ≥2^63(2^64-1)编码不再 extra bits in varint;strict wasm f OK 且输出逐字',
      ok, `runs=${fmtRuns63(runs)} strict=${st.code}:${JSON.stringify(st.stdout)} `
      + `dbg=${(st.stderr ?? '').split('\n').filter(l => l.includes('[wasm]')).join(',')}`);
  }

  // ---- v63.45(MINOR 6 回归守卫):i64.min 字面量与越界字面量 ----
  {
    const pmin = m63('p1r_i64_min.ming', [
      'fn f() -> i64 { return -9223372036854775808; }',
      'fn main() with io { print(str(f())); }',
      '',
    ].join('\n'));
    const pover = m63('p1r_i64_over.ming', [
      'fn f() -> i64 { return -9223372036854775809; }',
      'fn main() with io { print(str(f())); }',
      '',
    ].join('\n'));
    const runsMin = runAll63(pmin);
    const stMin = strict63(pmin);
    const runsOver = runAll63(pover);
    const stOver = strict63(pover);
    const ccOver = ccAvail63 ? runMing(['cc', pover]) : null;
    const ok = same63(runsMin, '-9223372036854775808\n') && wasmOk63(stMin, ['f']) && stMin.stdout === '-9223372036854775808\n'
      // 越界字面量:wasm 显式回落(不再 asIntN 静默回绕),默认与 --no-wasm 同为 M4002;
      // strict 原因具名;tree 位置差异(`<unknown>`,字面量 span 既有口径)不断言
      && runsOver.every(r => r.code === 101 && (r.stderr ?? '').includes('M4002'))
      && stOver.code === 2 && (stOver.stderr ?? '').includes('i64 字面量越界')
      && (!ccOver || (ccOver.code === 1 && (ccOver.stderr ?? '').includes('C1 不支持')));
    check('v63.45(MINOR6 回归):-9223372036854775808 三引擎 + strict wasm f OK;越界字面量 wasm 显式回落(strict 具名)且三引擎 M4002',
      ok, `min=${fmtRuns63(runsMin)} stMin=${stMin.code} over=${runsOver.map(r => r.code).join(',')} `
      + `stOver=${stOver.code}:${JSON.stringify((stOver.stderr ?? '').split('\n')[0])} `
      + `cc=${ccOver ? ccOver.code + ':' + JSON.stringify((ccOver.stderr ?? '').split('\n')[0]) : 'skip'}`);
  }

  // ================= P2 审查修复组(阻塞 B1–B4 + MINOR;v63.46–v63.56) =================

  // ---- v63.46(B1):本地函数 ensures 引用同块兄弟本地函数(三引擎一致) ----
  {
    const p = m63('p2r_sib_ensures.ming', [
      'fn main() with io {',
      '    fn positive(x: i64) -> bool { return x > 0; }',
      '    fn inc(a: i64) -> i64 requires a > 0 ensures positive(result) { return a + 1; }',
      '    print(str(inc(1)));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const ck = runMing(['check', p]);
    check('v63.46(B1):ensures 引用同块兄弟本地函数(positive(result))三引擎一致(2)且 check exit 0',
      same63(runs, '2\n') && ck.code === 0, `${fmtRuns63(runs)} check=${ck.code}`);
  }

  // ---- v63.47(B1):自引用 ensures 与 tree 同行为(无限递归 → M4005,消息首行逐字) ----
  {
    const p = m63('p2r_self_ensures.ming', [
      'fn main() with io {',
      '    fn f(a: i64) -> i64 ensures f(a) >= 0 { return a; }',
      '    print(str(f(1)));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const first0 = (runs[0].stderr ?? '').split('\n')[0];
    const first2 = (runs[2].stderr ?? '').split('\n')[0];
    const ok = runs.every(r => r.code === 101 && (r.stderr ?? '').includes('M4005')
      && (r.stderr ?? '').includes('调用栈过深(>250 层递归);如需更深递归请改写为循环'))
      && first0 === first2;
    check('v63.47(B1):自引用 ensures 三引擎 M4005 exit 101;default 与 --tree 首行逐字一致',
      ok, runs.map(r => `${r.code}:${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | '));
  }

  // ---- v63.48(B2):lambda 引用外层本地函数(声明-调用)三引擎一致 ----
  {
    const p = m63('p2r_lambda_localfn.ming', [
      'fn main() with io {',
      '    fn inc(x: i64) -> i64 { return x + 1; }',
      '    let f = (x: i64) => inc(x);',
      '    print(str(f(1)));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const ck = runMing(['check', p]);
    check('v63.48(B2):lambda 引用同块本地函数三引擎一致(2)且 check exit 0',
      same63(runs, '2\n') && ck.code === 0, `${fmtRuns63(runs)} check=${ck.code}`);
  }

  // ---- v63.49(B2):HOF 内 lambda 引用本地函数 + 闭包深拷贝保留 mod/localFns ----
  {
    const p = m63('p2r_lambda_hof.ming', [
      'fn main() with io {',
      '    fn inc(x: i64) -> i64 { return x + 1; }',
      '    let w = [1, 2, 3].map((x: i64) => inc(x));',
      '    print(str(w.len()));',
      '    print(str(w[2]));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    check('v63.49(B2):[1,2,3].map((x) => inc(x)) 三引擎一致(3 / 4;闭包 deepCopy 保留 mod/localFns)',
      same63(runs, '3\n4\n'), fmtRuns63(runs));
  }

  // ---- v63.50(B3):同块 let/fn 同名 → M3009(两种声明顺序同一诊断) ----
  {
    const p1 = m63('p2r_let_then_fn.ming', [
      'fn main() with io {',
      '    let f = (x: i64) => x + 100;',
      '    fn f(x: i64) -> i64 { return x + 1; }',
      '    print(str(f(1)));',
      '}',
      '',
    ].join('\n'));
    const p2 = m63('p2r_fn_then_let.ming', [
      'fn main() with io {',
      '    fn f(x: i64) -> i64 { return x + 1; }',
      '    let f = (x: i64) => x + 100;',
      '    print(str(f(1)));',
      '}',
      '',
    ].join('\n'));
    const c1 = runMing(['check', p1]);
    const c2 = runMing(['check', p2]);
    const ok = [c1, c2].every(r => r.code === 1 && (r.stderr ?? '').includes('M3009')
      && (r.stderr ?? '').includes('本块已声明为本地函数'))
      && runMing(['run', p1]).code === 1 && runMing(['run', p2]).code === 1;
    check('v63.50(B3):同块 let 与 fn 同名 → check/run exit 1 + M3009(两种声明顺序同一诊断,消除顺序敏感)',
      ok, `c1=${c1.code}:${JSON.stringify((c1.stderr ?? '').split('\n')[0])} c2=${c2.code}:${JSON.stringify((c2.stderr ?? '').split('\n')[0])}`);
  }

  // ---- v63.51(B3):跨块遮蔽按词法最近块胜(内层 fn 遮蔽外层 let/形参;外层值不变) ----
  {
    const pCall = m63('p2r_shadow_call.ming', [
      'fn main() with io {',
      '    let f = (x: i64) => x + 100;',
      '    {',
      '        fn f(x: i64) -> i64 { return x + 1; }',
      '        print(str(f(1)));',
      '    }',
      '    print(str(f(1)));',
      '}',
      '',
    ].join('\n'));
    const pParam = m63('p2r_shadow_param.ming', [
      'fn run(f: (i64) -> i64) -> i64 {',
      '    {',
      '        fn f(x: i64) -> i64 { return x + 1; }',
      '        return f(1);',
      '    }',
      '}',
      'fn main() with io { print(str(run((x: i64) => x + 100))); }',
      '',
    ].join('\n'));
    const rCall = runAll63(pCall);
    const rParam = runAll63(pParam);
    const ok = same63(rCall, '2\n101\n') && same63(rParam, '2\n');
    check('v63.51(B3):跨块词法最近块胜——内层 fn 遮蔽外层 let/形参(2/101 与 2;外层绑定不被改写)',
      ok, `call=${fmtRuns63(rCall)} param=${fmtRuns63(rParam)}`);
  }

  // ---- v63.52(MINOR1):同块重名本地函数 → M3009(不再静默后者胜) ----
  {
    const p = m63('p2r_dup_localfn.ming', [
      'fn main() with io {',
      '    fn f() -> i64 { return 1; }',
      '    fn f() -> i64 { return 2; }',
      '    print(str(f()));',
      '}',
      '',
    ].join('\n'));
    const ck = runMing(['check', p]);
    const run = runMing(['run', p]);
    check('v63.52(MINOR1):同块重名本地函数 → check/run exit 1 + M3009(note 指向首次声明)',
      ck.code === 1 && (ck.stderr ?? '').includes('M3009') && (ck.stderr ?? '').includes('重复定义')
      && (ck.stderr ?? '').includes('首次声明在这里') && run.code === 1,
      `check=${ck.code} run=${run.code} ${JSON.stringify((ck.stderr ?? '').slice(0, 200))}`);
  }

  // ---- v63.53(B4):本地函数遮蔽导入模块/模块项 → check 级 M3015(不再 tree 内部错误) ----
  {
    const pMath = m63('p2r_shadow_math.ming', [
      'use std.math;',
      'fn main() with io {',
      '    fn math(x: i64) -> i64 { return x + 1; }',
      '    print(str(math.sqrt(4.0)));',
      '}',
      '',
    ].join('\n'));
    const pStr = m63('p2r_shadow_str.ming', [
      'use std.str;',
      'fn main() with io {',
      '    fn str(x: i64) -> i64 { return x + 1; }',
      '    print(str.join(["a", "b"]));',
      '}',
      '',
    ].join('\n'));
    const c1 = runMing(['check', pMath]);
    const c2 = runMing(['check', pStr]);
    const r1 = runMing(['run', pMath]);
    const r2 = runMing(['run', pMath, '--tree']);
    const ok = c1.code === 1 && (c1.stderr ?? '').includes('M3015') && (c1.stderr ?? '').includes('本地函数 "math"')
      && c2.code === 1 && (c2.stderr ?? '').includes('M3015') && (c2.stderr ?? '').includes('本地函数 "str"')
      && r1.code === 1 && r2.code === 1 && !((r2.stderr ?? '').includes('内部错误'));
    check('v63.53(B4):本地函数遮蔽导入(math/str)的成员调用 → 三引擎 check 级 M3015 用户诊断(无 tree 内部错误)',
      ok, `math=${c1.code}:${JSON.stringify((c1.stderr ?? '').split('\n')[0])} str=${c2.code}:${JSON.stringify((c2.stderr ?? '').split('\n')[0])} tree=${r2.code}`);
  }

  // ---- v63.54(MINOR2):泛型本地函数专用码 M3048 + 无 T/级联 ----
  {
    const p = m63('p2r_generic_code.ming', [
      'fn main() with io {',
      '    fn id[T](x: T) -> T { return x; }',
      '    print(str(id(1)));',
      '}',
      '',
    ].join('\n'));
    const ck = runMing(['check', p]);
    const run = runMing(['run', p]);
    const msg = (ck.stderr ?? '');
    const ok = ck.code === 1 && msg.includes('M3048[generic-local-fn-unsupported]')
      && !msg.includes('M3003') && !msg.includes('实际是 T') && !msg.includes('实际是 ?')
      && run.code === 1;
    check('v63.54(MINOR2):泛型本地函数 → 仅 M3048(专用码;无 M3003 / str 类型级联)',
      ok, `check=${ck.code} run=${run.code} ${JSON.stringify(msg.slice(0, 260))}`);
  }

  // ---- v63.55(MINOR7):prelude 名(Some/Ok)被本地声明遮蔽——本地优先(三引擎一致) ----
  {
    const pSome = m63('p2r_shadow_some.ming', [
      'fn main() with io {',
      '    fn Some(x: i64) -> i64 { return x + 1; }',
      '    print(str(Some(1)));',
      '}',
      '',
    ].join('\n'));
    const pOk = m63('p2r_shadow_ok.ming', [
      'fn main() with io {',
      '    fn Ok(x: i64) -> i64 { return x + 2; }',
      '    print(str(Ok(1)));',
      '}',
      '',
    ].join('\n'));
    const pVar = m63('p2r_shadow_some_var.ming', [
      'fn main() with io {',
      '    let Some = (x: i64) => x + 1;',
      '    print(str(Some(1)));',
      '}',
      '',
    ].join('\n'));
    const r1 = runAll63(pSome);
    const r2 = runAll63(pOk);
    const r3 = runAll63(pVar);
    const ok = same63(r1, '2\n') && same63(r2, '3\n') && same63(r3, '2\n');
    check('v63.55(MINOR7):fn Some/fn Ok/let Some 遮蔽 prelude 构造器——本地声明优先(2/3/2 三引擎)',
      ok, `some=${fmtRuns63(r1)} ok=${fmtRuns63(r2)} var=${fmtRuns63(r3)}`);
  }

  // ---- v63.56(M4):未被调用的本地函数声明不再使 strict fallback(形状阶段判 ineligible) ----
  {
    const p = m63('p2r_strict_fnstmt.ming', [
      'fn outer(n: i64) -> i64 {',
      '    fn unused() -> i64 { return 1; }',
      '    return n + 1;',
      '}',
      'fn main() with io { print(str(outer(1))); }',
      '',
    ].join('\n'));
    const runs = runAll63(p);
    const st = strict63(p);
    const ok = same63(runs, '2\n') && st.code === 0 && st.stdout === '2\n'
      && !(st.stderr ?? '').includes('REJECT') && !(st.stderr ?? '').includes('实例化失败');
    check('v63.56(M4):函数体含 FnStmt 形状阶段 ineligible——未调用本地函数声明不再 strict fallback(exit 0)',
      ok, `runs=${fmtRuns63(runs)} strict=${st.code}:${JSON.stringify((st.stderr ?? '').slice(0, 200))}`);
  }

  // ================= P3 组:invariant bench(信息性;exit 0) =================

  // ---- v63.35:bench exit 0 且输出含 invariant 新项 ----
  {
    const env = { ...process.env };
    delete env.MING_WASM_STRICT;
    const b = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'bench.mjs')], {
      encoding: 'utf8', cwd: ROOT, timeout: 300000, env,
    });
    const out = b.stdout ?? '';
    check('v63.35:node tests/bench.mjs exit 0 且输出含 "契约 invariant 循环" 新项(重查 µs/次)',
      b.status === 0 && out.includes('契约 invariant 循环') && out.includes('invariant 重查'),
      `code=${b.status} tail=${JSON.stringify(out.slice(-400))} err=${JSON.stringify((b.stderr ?? '').slice(0, 200))}`);
  }

  // ---- v63.36:bench 基线含 invariant 项键(loopN/rounds/exits/vmUs/treeUs) ----
  {
    let base = null;
    try { base = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'bench.baseline.json'), 'utf8')); } catch { /* 断言处报错 */ }
    const it = base?.items?.['契约 invariant 循环']?.invariant;
    check('v63.36:bench.baseline.json 含 "契约 invariant 循环".invariant 键(loopN=10000/rounds/exits=300000/vmUs/treeUs 数值)',
      it && it.loopN === 10000 && it.rounds > 0 && it.exits === it.loopN * it.rounds
      && typeof it.vmUs === 'number' && typeof it.treeUs === 'number',
      `invariant=${JSON.stringify(it)}`);
  }
}


process.stdout.write(`\n${passed} 通过,${failed} 失败\n`);
if (failed > 0) {
  process.stdout.write('\n失败清单:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}\n`);
  process.exit(1);
}

