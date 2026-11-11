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

// ===================== 34. v0.39:C 后端 C1(ming cc)=====================
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

// ===================== 35. v0.40:C2(str/Vec[i64])+ engdiff 自举工具 =====================
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

// ===================== 36. v0.41:C3(Map/Option/f64 打印)+ cc 全形态差分 =====================
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

// ===================== 37. v0.42:C4 extern fn FFI(效果即门禁 + C 后端 dlsym)=====================
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

// ===================== 38. v0.43:ffi str 桥 + Result 进 C 面 =====================
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

// ===================== §40 契约系统(v0.45 阶段 1) =====================
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
  // 运行时 M4015 路径:变量实参(静态不可判定)
  const reqVarFile = mingFile('contract_reqvar.ming', ['fn f(a: i64) -> i64 requires a > 0 { return a + 1; }', 'fn main() with io { let a = 0; print(str(f(a))); }'].join('\n'));
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
  check('v45.1:batch_rename 缺参拒绝', r.status === 1 && (r.stdout ?? '').includes('用法'), 'code=' + r.status);
  const od = path.join(dir, 'org');
  fs.mkdirSync(od);
  fs.writeFileSync(path.join(od, 'x.txt'), 'a');
  fs.writeFileSync(path.join(od, 'y.md'), 'b');
  r = runTool('file_organizer.ming', [od]);
  check('v45.1:file_organizer 按扩展名归档', r.status === 0 && fs.existsSync(path.join(od, 'txt', 'x.txt')) && fs.existsSync(path.join(od, 'md', 'y.md')), r.stdout ?? '');
  r = runTool('file_organizer.ming', []);
  check('v45.1:file_organizer 缺参拒绝', r.status === 1 && (r.stdout ?? '').includes('用法'), 'code=' + r.status);
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

  // M3041 变量实参不误报(交给运行时 M4015)
  const csOkFile = path.join(dir, 'callsiteok.ming');
  fs.writeFileSync(csOkFile, csSrc.replace('print(str(pay(-5)));', 'let v = 0 - 5;\n    print(str(pay(v)));'));
  const rcsOk = runMing(['check', csOkFile]);
  check('v46:M3041 变量实参不误报', rcsOk.code === 0 && !(rcsOk.stderr ?? '').includes('M3041'), 'code=' + rcsOk.code + ' stderr=' + (rcsOk.stderr ?? '').slice(0, 120));

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

process.stdout.write(`\n${passed} 通过,${failed} 失败\n`);
if (failed > 0) {
  process.stdout.write('\n失败清单:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}\n`);
  process.exit(1);
}

