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
    && JSON.stringify(Object.keys(bn1).sort()) === JSON.stringify(['build_key', 'cache_hit', 'diagnostics', 'dist_hash', 'entry', 'interface_hashes', 'ms', 'ok', 'project', 'source_count', 'version'])
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
    && JSON.stringify(Object.keys(h3).sort()) === JSON.stringify(['build_key', 'cache', 'cache_hit', 'dist_hash', 'interface_hashes', 'ms', 'ok', 'project', 'source_count']),
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

  // M2:Module 校验/实例化回落也要点名 Ming 函数(用 order→compiled.functions 映射;
  // V8 的 function #N 索引不一定可靠,故同时给 eligible 全表)。
  const ifExprProg = mingFile('v53-wasm-ifexpr.ming', [
    'fn pick(n: i64) -> i64 { let x = if n > 0 { 1 } else { 2 }; return x; }',
    'fn main() with io { print(str(pick(3))); }',
  ].join('\n'));
  const ifStrict = runMing(['run', ifExprProg, '--strict-wasm']);
  check('v53.25:if 表达式回落消息点名疑似函数与 eligible 表(strict exit 2)',
    ifStrict.code === 2 && (ifStrict.stderr ?? '').includes('疑似函数 pick') && (ifStrict.stderr ?? '').includes('eligible=[0:pick]'),
    'code=' + ifStrict.code + ' stderr=' + (ifStrict.stderr ?? '').slice(0, 240));

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
  // declare(v_ch_2)导致块外引用非法 C。只对比 VM/VM-only/cc:tree 引擎对 for-in 遮蔽
  // 有独立既有泄漏缺陷(plan §4.2.8 #23),本例 tree 输出不同(已知分歧,不在此断言)。
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
    const noR = runMing(['run', f, '--no-wasm']);
    const ccR = ccBin57 ? ccRunF(f) : null;
    shadowOk = shadowOk && vmR.code === 0 && vmR.stdout === want + '\n'
      && noR.code === 0 && noR.stdout === want + '\n'
      && (!ccR || (ccR.build === 0 && ccR.code === 0 && ccR.stdout === want + '\n'));
    shadowDetail.push(kind + ':vm=' + JSON.stringify(vmR.stdout) + ',no=' + JSON.stringify(noR.stdout) + (ccR ? ',cc=' + JSON.stringify(ccR.stdout) + '/b' + ccR.build : ',cc=skip'));
  }
  check('v53.27:C for-in 遮蔽作用域(VM / VM-only / cc 一致;tree 已知分歧见 plan #23)', shadowOk, shadowDetail.join(' '));

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

process.stdout.write(`\n${passed} 通过,${failed} 失败\n`);
if (failed > 0) {
  process.stdout.write('\n失败清单:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}\n`);
  process.exit(1);
}

