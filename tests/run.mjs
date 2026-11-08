// tests/run.mjs — Ming 工具链回归测试(零依赖)。
// 覆盖:示例黄金输出、诊断码回归、运行时 panic 行为、fmt 幂等性、JSON 协议、值语义。

import { execFileSync, spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

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
  const r = spawnSync(process.execPath, [MING, ...args], {
    encoding: 'utf8',
    input: opts.stdin ?? '',
    cwd: opts.cwd ?? ROOT,
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
    const origRun = runMing(['run', path.join(ROOT, 'examples', file)]);
    const fmtRun = runMing(['run', fp]);
    check(`fmt:${file} 运行结果不变`, origRun.stdout === fmtRun.stdout, `orig=${JSON.stringify(origRun.stdout)} fmt=${JSON.stringify(fmtRun.stdout)}`);
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

  // 用法与未知子命令
  r = kitRun([]);
  check('kit:无参数出用法', r.code === 1 && r.stderr.includes('mingkit'), r.stderr.slice(0, 100));
  r = kitRun(['bogus']);
  check('kit:未知子命令', r.code === 1 && r.stderr.includes('未知子命令'), r.stderr.slice(0, 100));
}

// ===================== 汇总 =====================
process.stdout.write(`\n${passed} 通过,${failed} 失败\n`);
if (failed > 0) {
  process.stdout.write('\n失败清单:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}\n`);
  process.exit(1);
}