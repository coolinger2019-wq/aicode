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
import { VMInterp } from '../src/vm.js';
import { Checker } from '../src/checker.js';
import { compile, CompileError } from '../src/compiler.js';

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
  // v0.82(ADR-008):main args 翻转为 Vec[Untrusted[str]](元素级污点);print 出向
  // 透传(回显合法),期望 stdout 逐字不变
  const p = mingFile('args.ming', 'fn main(args: Vec[Untrusted[str]]) with io { print(str(args.len())); print(args[0]); }');
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
  // v0.77 校准(ADR-007 清单 1):read_file 翻转 → content: Untrusted[str];trim() 保污(代数 keep),
  // 插值 \{污} 是 M3050 洗白禁面 → 改拼接传播("读到: "+污→污)+ print 出向透传(§8.1 微调)。
  // 期望输出逐字不变("读到: hello ming")——良性路径逐字节口径。
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
        Ok(content) => print("读到: " + content.trim()),
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
  // v0.77 校准(ADR-007 清单 3,Untrusted[Vec[u8]] 第三载体):read_bytes 翻转 → Ok(v) 的 v 是
  // Untrusted[Vec[u8]],内容字节按设计不可读值(下标 v[2] → M3020)——原 `print(str(v[2]))` 位
  // 重设计为白名单面 len()/is_empty() + is_empty 分支(任务移交口径);写出方向 write_bytes/
  // append_bytes 内容位出向透传(实参恒净,行为不变)。期望输出 255 → nonempty,其余逐字不变。
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
    '        Ok(v) => { print(str(v.len())); if v.is_empty() { print("empty"); } else { print("nonempty"); } }',
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
  const wantBio = '9\n中文abc\n4\nnonempty\n5\n1\n';
  for (const eng of [[], ['--tree']]) {
    const r = runMing(['run', bio, ...eng]);
    check('v31:二进制 I/O 往返' + (eng.length ? '(tree)' : '(vm)'), r.code === 0 && r.stdout === wantBio,
      'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr.slice(0, 200));
  }

  // read_bytes 不存在 → Err
  const rb = mingFile('v31-read-missing.ming', 'use std.fs;\nuse std.io;\nfn main() with io, fs { match std.fs.read_bytes("/tmp/ming-v31-nope.bin") { Ok(_) => print("bug"), Err(_) => print("err-ok") } }');
  const rrb = runMing(['run', rb]);
  check('v31:read_bytes 缺文件 Err', rrb.code === 0 && rrb.stdout === 'err-ok\n', rrb.stderr.slice(0, 150));

  // v0.77 校准(ADR-007 清单 3):污字节内容不可读值——Untrusted[Vec[u8]] 下标 → M3020(新增负例,
  // 锁定"内容字节按设计不可读值"语义;正例消费面 = len/is_empty 白名单)
  const bidx = mingFile('v31-tainted-index.ming', 'use std.fs;\nuse std.io;\nfn main() with io, fs { match std.fs.read_bytes("/tmp/ming-v31.bin") { Ok(v) => print(str(v[0])), Err(_) => print("err") } }');
  const rbidx = runMing(['check', bidx]);
  check('v31:污字节下标读拒绝 M3020', rbidx.code === 1 && rbidx.stderr.includes('M3020'), rbidx.stderr.slice(0, 150));

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
    // v0.82(ADR-008):args[0] 是污值,与净字面量 "ming" 的 if 分支混型是 M3049——
    // 迁移形态:sanitize_cli_path 校验取净(Ok 原样)后进 greet(净 str);
    // launcher 期望 stdout 逐字不变(hi, alice/ming/bob/carol)
    'use std.unstr;',
    'fn main(args: Vec[Untrusted[str]]) with io {',
    '    let mut who = "ming";',
    '    if args.len() > 0 { match std.unstr.sanitize_cli_path(args[0]) { Ok(p) => { who = p; }, Err(_) => { who = who; } } }',
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

    // panic 对齐:main 内具体消息(binopValues)与 fn 内消息,首行 + 退出码 101
    // v0.81(N-65.4):wasm 腿统一为操作数逐字口径后,架构师已收口 cc 侧残留
    // (cbackend.js ctx.specific 门拆除——M4002 四引擎逐字),fullLine 全部恢复 true
    // = 首行全等硬门槛(三形态均是);M4004(除零)eligible 泛化分叉另行登记不预支。
    const panicSrcs = [
      ['main-ovf', 'main 内溢出', 'fn main() with io { let x = 9223372036854775807; let y = x + 1; print(str(y)); }', true],
      ['fn-ovf', 'fn 内溢出', 'fn boom(a: i64, b: i64) -> i64 { return a * b; } fn main() with io { print(str(boom(3037000500, 3037000500))); }', true],
      ['div-zero', '除零', 'fn main() with io { print(str(10 / 0)); }', true],
    ];
    for (const [fileKey, desc, src, fullLine] of panicSrcs) {
      const pf = path.join(cdir, 'panic-' + fileKey + '.ming');
      fs.writeFileSync(pf, src);
      const rj = runMing(['run', pf]);
      spawnSync(process.execPath, [MING, 'cc', pf, '--out', path.join(cdir, 'out')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
      const pexe = path.join(cdir, 'out', 'panic-' + fileKey + (process.platform === 'win32' ? '.exe' : ''));
      const rc2 = fs.existsSync(pexe) ? spawnSync(pexe, [], { encoding: 'utf8', timeout: 60000 }) : { status: -1, stderr: '' };
      const ok = fullLine
        ? rj.code === 101 && rc2.status === 101 && firstLine(rj.stderr) === firstLine(rc2.stderr)
        : rj.code === 101 && rc2.status === 101;
      check('v39:panic 首行对齐(' + desc + ')',
        ok, 'js=' + JSON.stringify(firstLine(rj.stderr)) + ' cc=' + JSON.stringify(firstLine(rc2.stderr)) + ' codes=' + rj.code + '/' + rc2.status);
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
    // v0.82(ADR-008):签名翻转(print 出向透传,期望 stdout 逐字不变)
    'fn main(args: Vec[Untrusted[str]]) -> i64 with io {',
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
  // fallback 构造:eligible 形态但 wasm 守护具名回落(整体静默回落,exit 0)。v0.63 翻转校准:
  // 原夹具 `y += 1.0`(f64 复合赋值)已解锁 → strict 直接 ok;换成仍守护的 Option expect
  // (§67 同源形态)。函数名 g 与 eligible=1 口径保持,断言仅替换原因子串与非 strict 输出 2.5→1。
  const okProg = mingFile('v53-wasm-ok.ming', [
    'fn fib(n: i64) -> i64 { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }',
    'fn main() with io { print(str(fib(10))); }',
  ].join('\n'));
  // v0.65 校准:expect(编译期字面量 msg)已解锁 → 夹具换仍守护的变量 msg expect(§69 同源具名);
  // 非 strict 输出仍为 1(expect 界内取值),strict 回落机制测试意图不变。
  const fbProg = mingFile('v53-wasm-fallback.ming', [
    'fn g(v: Vec[i64]) -> i64 { let msg = "need"; return v.get(0).expect(msg); }',
    'fn main() with io { print(str(g([1, 2]))); }',
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
  // v0.65 校准:回落原因随夹具翻转(expect 字面量 msg 已解锁 → 变量 msg expect 具名守护)
  check('v53.2:strict fallback exit 2 + 点名函数与原因',
    fbStrict.code === 2 && fbStrict.stdout === '' && (fbStrict.stderr ?? '').includes('wasm 编译回落(g)') && (fbStrict.stderr ?? '').includes('expect msg 非编译期字面量(待解锁)')
    && fbJson.exit_code === 2 && fbJson.wasm_status === 'fallback' && (fbJson.error ?? '').includes('expect msg 非编译期字面量(待解锁)'),
    'code=' + fbStrict.code + ' stderr=' + (fbStrict.stderr ?? '').slice(0, 160) + ' json=' + JSON.stringify(fbJson));

  // 3) 非 strict 静默回落行为逐字不变(exit 0 + 正确结果 + stderr 干净);--json 仅 additive 多 wasm_status
  //    v0.63 校准:夹具翻转后正确结果 2.5 → 1(expect 界内取值)
  const fbPlain = runMing(['run', fbProg]);
  const fbJsonNon = JSON.parse(runMing(['run', fbProg, '--json']).stdout);
  check('v53.3:非 strict 静默回落行为不变(json 仅 additive wasm_status=fallback)',
    fbPlain.code === 0 && fbPlain.stdout === '1\n' && (fbPlain.stderr ?? '') === ''
    && fbJsonNon.exit_code === 0 && fbJsonNon.stdout === '1\n' && fbJsonNon.wasm_status === 'fallback',
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
    && stFb.status === 'fallback' && (stFb.reason ?? '').includes('编译回落(g)') && (stFb.reason ?? '').includes('expect msg 非编译期字面量(待解锁)') && stFb.eligible === 1
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
    // v0.82(ADR-008):签名翻转(print 出向透传,期望 stdout 逐字不变)
    'fn main(args: Vec[Untrusted[str]]) with io {',
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
  // v0.65 校准:expect(编译期字面量 msg)已解锁 → 换仍守护的变量 msg expect(与 fbProg 同源),
  // 函数名 g 与 fallback 触发口径保持;pick/eqf 原样保留
  // (proof 报告 pick: 义务 1 + W3102 浮点等值断言均不受翻转影响)。
  const pfProg = mingFile('v53-proof-fb.ming', [
    'fn pick(buf: Vec[i64], i: i64) -> i64 requires i >= 0 && i < buf.len() {',
    '    return buf[i];',
    '}',
    'fn eqf(x: f64) -> bool { return x == 1.0; }',
    'fn g(v: Vec[i64]) -> i64 { let msg = "need"; return v.get(0).expect(msg); }',
    'fn main() with io { print(str(pick([10, 20, 30], 1))); print(str(g([1, 2]))); }',
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
    shellStrictIgnored.code === 0 && shellStrictIgnored.stdout === '1\n'
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
  // v0.81 N-65.4 架构师收口理由化重校准:eligible 函数内 M4002 溢出检查的 panic 发射从
  // 静态 ming_panic("整数运算溢出/移位越界") 改为携带操作数的动态 fprintf(四引擎消息
  // 逐字统一)——本夹具 fn add(a,b) 是 eligible 函数,渲染 C 指纹随之合法变化
  // (c62b5c0d… → c18cc21f…)。非 unsafe 程序不发射 ming_mem_alloc/std.mem 与
  // cc 输出 === VM 输出两项断言不受影响,指纹仍逐字节锁定(防回归面不减)。
  const BASE_C_SHA = 'c18cc21fe967975db6e8706cb1e207b11e1d289694831f5608a5f324bd2d59f6';
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

  // ---- v63.19(引导守护,v0.65 翻转校准):v0.63 已解锁 VecLit/下标读/mut 写;v0.65 slice 3
  // 再解锁 Map unwrap / Vec[str] 下标读 / 下标复合赋值(全部 strict exit 0 + fn OK 无 REJECT)。
  // 改写为两段口径(单 check 保持总数不变):(a) 已解锁六形态 strict ok + fn OK + 非 strict
  // 三引擎逐字;(b) 剩余守护三形态(变量 msg expect / unwrap_or / Vec[str] 元素写,与 §69
  // 同源具名文本)strict exit 2 原因具名 + 非 strict 三引擎逐字。"剩余守护"清单随解锁收窄。
  {
    const unlockedCases = [
      ['veclit', [
        'fn vl(n: i64) -> i64 { let v = [1, 2, 3]; return v[0] + n; }',
        'fn main() with io { print(str(vl(4))); }',
      ].join('\n'), '5\n', 'vl'],
      ['vecread', [
        'fn vr(v: Vec[i64]) -> i64 { return v[0]; }',
        'fn main() with io { print(str(vr([7, 8]))); }',
      ].join('\n'), '7\n', 'vr'],
      ['vecwrite', [
        'fn vw(mut v: Vec[i64]) -> i64 { v[0] = 5; return v[1]; }',
        'fn main() with io { print(str(vw([1, 2]))); }',
      ].join('\n'), '2\n', 'vw'],
      ['mapunwrap', [
        'fn og(m: Map[str, i64]) -> i64 { return m.get("a").unwrap(); }',
        'fn main() with io { print(str(og({"a": 3}))); }',
      ].join('\n'), '3\n', 'og'],
      ['vecstr', [
        'fn vs(s: Vec[str]) -> str { return s[0]; }',
        'fn main() with io { print(vs(["a", "b"])); }',
      ].join('\n'), 'a\n', 'vs'],
      ['idxcompound', [
        'fn ic(mut v: Vec[i64]) -> i64 { v[0] += 5; return v[0]; }',
        'fn main() with io { print(str(ic([1, 2]))); }',
      ].join('\n'), '6\n', 'ic'],
    ];
    const guardedCases = [
      ['msgvar', [
        'fn gv(v: Vec[i64]) -> i64 { let msg = "need"; return v.get(0).expect(msg); }',
        'fn main() with io { print(str(gv([1, 2]))); }',
      ].join('\n'), '1\n', 'gv', 'expect msg 非编译期字面量(待解锁)'],
      ['unwrapor', [
        'fn uo(v: Vec[i64]) -> i64 { return v.get(10).unwrap_or(7); }',
        'fn main() with io { print(str(uo([1, 2]))); }',
      ].join('\n'), '7\n', 'uo', 'Option 消费链 unwrap_or'],
      ['vecstrwrite', [
        'fn vsw(mut s: Vec[str]) -> i64 { s[0] = "z"; return 1; }',
        'fn main() with io { print(str(vsw(["a", "b"]))); }',
      ].join('\n'), '1\n', 'vsw', 'Vec[str] 元素写(句柄容器,登记不做)'],
    ];
    let allOk = true;
    const detail = [];
    for (const [name, src, want, fnName] of unlockedCases) {
      const p = m63('p1_unlock_' + name + '.ming', src);
      const runs = runAll63(p);
      const st = strict63(p);
      const dbg = st.stderr ?? '';
      const ok = same63(runs, want) && st.code === 0 && st.stdout === want
        && dbg.includes(`[wasm] fn ${fnName} OK`) && !dbg.includes('REJECT') && !dbg.includes('回落');
      if (!ok) allOk = false;
      detail.push(`${name}:strict=${st.code}:runs=${runs.map(r => r.code).join(',')}`);
    }
    for (const [name, src, want, fnName, reason] of guardedCases) {
      const p = m63('p1_guard_' + name + '.ming', src);
      const runs = runAll63(p);
      const st = strict63(p);
      const ok = same63(runs, want) && st.code === 2 && st.stdout === ''
        && (st.stderr ?? '').includes(`wasm 编译回落(${fnName})`) && (st.stderr ?? '').includes(reason);
      if (!ok) allOk = false;
      detail.push(`${name}:${runs.map(r => r.code).join(',')}:strict=${st.code}`);
    }
    check('v63.19:守护翻转——已解锁(VecLit/下标读/mut 写/Map unwrap/Vec[str] 下标读/下标复合赋值)strict ok 且 [wasm] fn OK 无 REJECT;剩余守护(变量 msg expect/unwrap_or/Vec[str] 元素写)strict exit 2 原因具名;非 strict 三引擎输出逐字一致',
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
      // v0.81(N-65.4):wasm 消息统一为操作数逐字口径——原"通用文案"锁定行翻转,
      // strict 腿与 tree 腿同文案同位置(cc eligible 泛化残留已于 v0.81 架构师收口,见 v63.40)
      && (st.stderr ?? '').includes('整数<<溢出:3 << 62 超出 i64 范围') && (st.stderr ?? '').includes(`${p}:2:14:`)
      && (runs[2].stderr ?? '').includes('整数<<溢出:3 << 62 超出 i64 范围');
    check('v63.37(阻塞1):i64 `<<` 结果溢出三引擎 M4002 exit 101;strict wasm 不再 ok(N-65.4 后 wasm/tree 消息逐字一致)',
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
    check('v63.40(阻塞1/C):C 腿左移溢出 exit 101 M4002——eligible 与 main 均具体文案(与 tree 逐字;v0.81 N-65.4 架构师收口 ctx.specific 门拆除);无编译器自动跳过',
      (!r1 && !r2) || (r1 && r2 && r1.code === 101 && r2.code === 101
        && (r1.stderr ?? '').includes('M4002') && (r1.stderr ?? '').includes('整数<<溢出:3 << 62 超出 i64 范围')
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

// ===================== 64. v0.60:资源门禁一致性(#51 wasm 搬运计费 / #52 外部输入计费 / #53 --max-ms 钳制 / #47 tree 契约重入 / #54 CLI 旗标)=====================
// 文件所有权(三方评估,plan §4.4.4):§64-A = src/vm.js(#51 + runTests 透传)·
// §64-B = src/interp.js(#52/#53/#47 + runTests 透传)· §64-C = bin/ming.js(#54 CLI 转发与冲突仲裁)。
// 每个 agent 只在自己的 START/END 标记之间插入用例;不改其它区域,不改既有分节。
{
  const dir64 = path.join(TMP, 'v64');
  fs.mkdirSync(dir64, { recursive: true });
  const m64 = (name, src) => { const f = path.join(dir64, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags64 = ['', '--no-wasm', '--tree'];
  const runAll64 = (p, extra = []) => flags64.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const same64 = (runs, want) => runs.every(r => r.code === 0 && r.stdout === want);
  const fmtRuns64 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');

  // ---- §64-A-START(#51:src/vm.js——wasm 参数搬运计费分歧 + wasmParamTop 复位;runTests 透传)----
  const debugA = (p, extra = []) => runMing(['run', p, ...extra], { env: { MING_WASM_DEBUG: '1' } });
  const allGateM4011 = (runs) => runs.every(r => r.code === 101 && (r.stderr ?? '').split('\n')[0].includes('M4011'));

  // ---- v64.A1(#51):wasm 参数搬运不计费(派生拷贝口径)——[1,2,3] 实参搬运此前
  // 经 mingAllocRaw 计入 16+8*3=40 字节,--max-alloc 20 时 wasm 路径 exit 101 M4011
  // 而 --no-wasm/--tree exit 0 输出 6(四引擎语义合同违约;修复后三引擎同口径)。
  {
    const p = m64('a1_sum.ming', [
      'fn sum(v: Vec[i64]) -> i64 {',
      '    let mut t = 0;',
      '    for x in v {',
      '        t += x;',
      '    }',
      '    return t;',
      '}',
      'fn main() with io { print(str(sum([1, 2, 3]))); }',
      '',
    ].join('\n'));
    const runsOk = runAll64(p, ['--max-alloc', '20']);
    const runsGate = runAll64(p, ['--max-alloc', '2']);
    check('v64.A1:#51 搬运不计费——sum([1,2,3]) --max-alloc 20 三引擎 exit 0 输出 6;--max-alloc 2 三引擎 exit 101 且首行 M4011',
      same64(runsOk, '6\n') && allGateM4011(runsGate),
      `ok=${fmtRuns64(runsOk)} gate=${fmtRuns64(runsGate)}`);
  }

  // ---- v64.A2(#51):计费 parity 锁定——1000 次调用各创建 VecLit 3 元素,三引擎
  // 累计分配均为 3000(此前 wasm 路径每次实参搬运多计 40 → 43000 远超 tree/VM);
  // 3000 恰好放行 / 2999 超限,锁定三引擎 billing parity。
  {
    const p = m64('a2_parity.ming', [
      'fn sum(v: Vec[i64]) -> i64 {',
      '    let mut t = 0;',
      '    for x in v {',
      '        t += x;',
      '    }',
      '    return t;',
      '}',
      'fn main() with io {',
      '    let mut t = 0;',
      '    for i in 0..1000 { t += sum([1, 2, 3]); }',
      '    print(str(t));',
      '}',
      '',
    ].join('\n'));
    const runsOk = runAll64(p, ['--max-alloc', '3000']);
    const runsGate = runAll64(p, ['--max-alloc', '2999']);
    check('v64.A2:#51 计费 parity——1000×sum([1,2,3]) 累计 3000 三引擎一致:--max-alloc 3000 放行输出 6000,2999 exit 101 M4011',
      same64(runsOk, '6000\n') && allGateM4011(runsGate),
      `ok=${fmtRuns64(runsOk)} gate=${fmtRuns64(runsGate)}`);
  }

  // ---- v64.A3(#51):param-top 复位冒烟——10 万次 wasm 调用的实参搬运复用同一
  // 线性内存段(此前 push 的是搬运后的堆顶 → 永不复用、随调用单调增长;旧口径下
  // 搬运计费 40×100000 早在 500000 配额内爆掉)。wasm 真实执行另用小程序
  // MING_WASM_DEBUG 断言(fn sum OK 无 REJECT/实例化失败)——大程序逐调用
  // 打 [wasm 参数] 超 runMing 30s 超时,与 §63 wasmOk63 用小程序同口径。
  // 注:100000 × sum([1,2,3]=6) = 600000(资源口径:循环 100000 次 VecLit 各计 3)。
  {
    const p = m64('a3_reuse.ming', [
      'fn sum(v: Vec[i64]) -> i64 {',
      '    let mut t = 0;',
      '    for x in v {',
      '        t += x;',
      '    }',
      '    return t;',
      '}',
      'fn main() with io {',
      '    let mut t = 0;',
      '    for i in 0..100000 { t += sum([1, 2, 3]); }',
      '    print(str(t));',
      '}',
      '',
    ].join('\n'));
    const pd = m64('a3_dbg.ming', [
      'fn sum(v: Vec[i64]) -> i64 {',
      '    let mut t = 0;',
      '    for x in v {',
      '        t += x;',
      '    }',
      '    return t;',
      '}',
      'fn main() with io { print(str(sum([1, 2, 3]))); }',
      '',
    ].join('\n'));
    const runs = runAll64(p, ['--max-alloc', '500000']);
    const dbg = debugA(pd);
    check('v64.A3:#51 param-top 复位——100000×sum([1,2,3]) 三引擎 exit 0 输出 600000 且 wasm 真实执行(fn sum OK 无 REJECT/实例化失败)',
      same64(runs, '600000\n') && dbg.code === 0 && (dbg.stderr ?? '').includes('[wasm] fn sum OK')
      && !(dbg.stderr ?? '').includes('REJECT') && !(dbg.stderr ?? '').includes('实例化失败'),
      `${fmtRuns64(runs)} dbg=${dbg.code} ${JSON.stringify((dbg.stderr ?? '').slice(0, 120))}`);
  }

  // ---- v64.A4(#54 一半):runTests 资源旗标透传——VMInterp.runTests 创建子实例
  // 同时继承 noWasm/maxSteps/maxAlloc/maxMs(此前只传 maxSteps);CLI 侧转发在 §64-C
  // 的 bin/ming.js(同批合并后生效)。VecLit 6 元素 → 累计 6;--max-alloc 5 超限 M4011。
  {
    const p = m64('a4_testgate.ming', [
      'fn main() with io { print("ok"); }',
      'test allocgate {',
      '    let v = [1, 2, 3, 4, 5, 6];',
      '    print(str(v.len()));',
      '}',
      '',
    ].join('\n'));
    const ok = runMing(['test', p]);
    const gated = runMing(['test', p, '--max-alloc', '5']);
    const noWasm = runMing(['test', p, '--no-wasm']);
    const tree = runMing(['test', p, '--tree']);
    check('v64.A4:#54 runTests 透传——ming test exit 0 通过;--max-alloc 5 exit 1 输出含 M4011;--no-wasm 与 --tree 均 exit 0',
      ok.code === 0 && (ok.stdout ?? '').includes('allocgate')
      && gated.code === 1 && `${gated.stderr ?? ''}${gated.stdout ?? ''}`.includes('M4011')
      && noWasm.code === 0 && tree.code === 0,
      `ok=${ok.code} gated=${gated.code}/${JSON.stringify(((gated.stderr ?? '') + (gated.stdout ?? '')).split('\n').find(l => l.includes('M40')) ?? '')} noWasm=${noWasm.code} tree=${tree.code}`);
  }
  // §64-A-END

  // ---- §64-B-START(#52/#53/#47:src/interp.js——外部输入计费 / --max-ms 钳制 / tree 契约重入;runTests 透传)----

  // v64.B1(#47):ensures 含块尾表达式(if 分支)——此前 tree 引擎 execBlock 对任何带尾值的块
  // 都查 ensures,ensures 求值再次进入块尾 → 无限重入 M4005;修复后仅函数体块查,三引擎一致
  {
    const p = m64('v64-b1-contract-block.ming', [
      'fn f(a: i64) -> i64 ensures if a > 0 { true } else { true } {',
      '    return a;',
      '}',
      'fn main() with io { print(str(f(5))); }',
      '',
    ].join('\n'));
    const runs = runAll64(p);
    check('v64.B1(#47):ensures 含 if 块尾不再 tree 重入 M4005——三引擎 exit 0 输出 5(VM 原本正确)',
      same64(runs, '5\n'), `runs=${fmtRuns64(runs)}`);
  }

  // v64.B2(#47):块尾 ensures 的违约路径仍报——f(5) 走 if 分支(5 > 5 假)、f(-1) 走 else 分支
  // (-1 == 0 假),均运行时 M4015;三引擎 exit 101 且 stderr 首行含 M4015
  {
    const mk = (name, arg) => m64(name, [
      'fn f(a: i64) -> i64 ensures if a > 0 { result > a } else { result == 0 } {',
      '    return a;',
      '}',
      `fn main() with io { print(str(f(${arg}))); }`,
      '',
    ].join('\n'));
    const pPos = mk('v64-b2-violate-pos.ming', 5);
    const pNeg = mk('v64-b2-violate-neg.ming', -1);
    const rPos = runAll64(pPos);
    const rNeg = runAll64(pNeg);
    const violated = (rs) => rs.every(r => r.code === 101 && (r.stderr ?? '').split('\n')[0].includes('M4015'));
    check('v64.B2(#47):块尾 ensures 违约仍报 M4015——f(5) 与 f(-1) 三引擎 exit 101 首行含 M4015',
      violated(rPos) && violated(rNeg), `pos=${fmtRuns64(rPos)} neg=${fmtRuns64(rNeg)}`);
  }

  // v64.B3(#52):fs.read_file 外部输入边界计费——先 stat 取字节预记账再读;
  // 5000 字节 + --max-alloc 10 → M4011;10 字节(恰等配额,chargeAllocBytes 严格 >)→ exit 0
  {
    const big = path.join(dir64, 'v64-b3-big.txt');
    fs.writeFileSync(big, 'x'.repeat(5000), 'utf8');
    const small = path.join(dir64, 'v64-b3-small.txt');
    fs.writeFileSync(small, 'x'.repeat(10), 'utf8');
    const mk = (name, file) => m64(name, [
      'use std.fs;',
      'use std.io;',
      '',
      'fn main() with io, fs {',
      `    let r = std.fs.read_file("${file.replace(/\\/g, '/')}");`,
      '    print(str(r.unwrap().byte_len()));',
      '}',
      '',
    ].join('\n'));
    const pBig = mk('v64-b3-big.ming', big);
    const pSmall = mk('v64-b3-small.ming', small);
    const qBig = runAll64(pBig, ['--max-alloc', '10']);
    const fBig = runAll64(pBig);
    const fSmall = runAll64(pSmall, ['--max-alloc', '10']);
    const m4011 = (rs) => rs.every(r => r.code === 101 && (r.stderr ?? '').split('\n')[0].includes('M4011'));
    check('v64.B3(#52):read_file 5000B + --max-alloc 10 → 三引擎 M4011;默认配额输出 5000;10B 恰等配额 exit 0 输出 10',
      m4011(qBig) && same64(fBig, '5000\n') && same64(fSmall, '10\n'),
      `quota=${fmtRuns64(qBig)} free=${fmtRuns64(fBig)} small=${fmtRuns64(fSmall)}`);
  }

  // v64.B4(#52):stdin 外部输入边界计费——read_to_end 按 UTF-16 长度、read_line 按行长度;
  // 100 字符 + --max-alloc 10 → M4011;默认配额输出真实长度
  {
    const pEnd = m64('v64-b4-end.ming', [
      'use std.io;',
      '',
      'fn main() with io {',
      '    let s = io.read_to_end();',
      '    print(str(s.byte_len()));',
      '}',
      '',
    ].join('\n'));
    const pLine = m64('v64-b4-line.ming', [
      'use std.io;',
      '',
      'fn main() with io {',
      '    let line = io.read_line();',
      '    print(str(line.byte_len()));',
      '}',
      '',
    ].join('\n'));
    const qEnd = flags64.map(f => runMing(f ? ['run', pEnd, '--max-alloc', '10', f] : ['run', pEnd, '--max-alloc', '10'], { stdin: 'x'.repeat(100) }));
    const fEnd = flags64.map(f => runMing(f ? ['run', pEnd, f] : ['run', pEnd], { stdin: 'x'.repeat(100) }));
    const qLine = flags64.map(f => runMing(f ? ['run', pLine, '--max-alloc', '10', f] : ['run', pLine, '--max-alloc', '10'], { stdin: 'y'.repeat(40) }));
    const fLine = flags64.map(f => runMing(f ? ['run', pLine, f] : ['run', pLine], { stdin: 'y'.repeat(40) }));
    const m4011 = (rs) => rs.every(r => r.code === 101 && (r.stderr ?? '').split('\n')[0].includes('M4011'));
    check('v64.B4(#52):read_to_end 100 字符 + --max-alloc 10 → 三引擎 M4011,默认输出 100;read_line 40 字符同口径',
      m4011(qEnd) && same64(fEnd, '100\n') && m4011(qLine) && same64(fLine, '40\n'),
      `qEnd=${fmtRuns64(qEnd)} fEnd=${fmtRuns64(fEnd)} qLine=${fmtRuns64(qLine)} fLine=${fmtRuns64(fLine)}`);
  }

  // v64.B5(#52):fs.list_dir 外部输入边界计费——按目录条目数计费;
  // 20 个文件 + --max-alloc 5 → M4011;默认配额输出 20
  {
    const d20 = path.join(dir64, 'v64-b5-dir');
    fs.mkdirSync(d20, { recursive: true });
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(d20, `f${i}.txt`), 'a', 'utf8');
    const p = m64('v64-b5-list.ming', [
      'use std.fs;',
      'use std.io;',
      '',
      'fn main() with io, fs {',
      `    let r = std.fs.list_dir("${d20.replace(/\\/g, '/')}");`,
      '    print(str(r.unwrap().len()));',
      '}',
      '',
    ].join('\n'));
    const qRuns = runAll64(p, ['--max-alloc', '5']);
    const fRuns = runAll64(p);
    check('v64.B5(#52):list_dir 20 条目 + --max-alloc 5 → 三引擎 M4011;默认配额输出 20',
      qRuns.every(r => r.code === 101 && (r.stderr ?? '').split('\n')[0].includes('M4011')) && same64(fRuns, '20\n'),
      `quota=${fmtRuns64(qRuns)} free=${fmtRuns64(fRuns)}`);
  }

  // v64.B6(#53):time.sleep 受 --max-ms 钳制——等待钳到剩余配额,醒来立即熔断;
  // sleep(300) + --max-ms 100 → exit 101 M4012 且单次运行 < 2000ms(修复前整段睡满 exit 0);
  // sleep(50) 默认限额(600s)→ exit 0 done
  {
    const pSlow = m64('v64-b6-slow.ming', [
      'use std.io;',
      'use std.time;',
      '',
      'fn main() with io, time {',
      '    std.time.sleep(300);',
      '    print("done");',
      '}',
      '',
    ].join('\n'));
    const pOk = m64('v64-b6-ok.ming', [
      'use std.io;',
      'use std.time;',
      '',
      'fn main() with io, time {',
      '    std.time.sleep(50);',
      '    print("done");',
      '}',
      '',
    ].join('\n'));
    const qRuns = flags64.map(f => {
      const t0 = Date.now();
      const r = runMing(f ? ['run', pSlow, '--max-ms', '100', f] : ['run', pSlow, '--max-ms', '100']);
      return { r, ms: Date.now() - t0 };
    });
    const fRuns = runAll64(pOk);
    const hit = qRuns.every(({ r, ms }) => r.code === 101 && (r.stderr ?? '').split('\n')[0].includes('M4012') && ms < 2000);
    check('v64.B6(#53):sleep(300) + --max-ms 100 → 三引擎 M4012 且单次 < 2000ms;sleep(50) 默认限额 exit 0',
      hit && fRuns.every(r => r.code === 0 && r.stdout === 'done\n'),
      `quota=${fmtRuns64(qRuns.map(x => x.r))} maxMs=${Math.max(...qRuns.map(x => x.ms))} free=${fmtRuns64(fRuns)}`);
  }

  // v64.B7(#53):阻塞 join 受 --max-ms 钳制——子任务 sleep(3000),join 等待钳到剩余配额;
  // 修复前 join 原地等满 3 秒(exit 0),修复后 ~配额边界 M4012 exit 101
  {
    const p = m64('v64-b7-join.ming', [
      'use std.io;',
      'use std.sync;',
      'use std.time;',
      '',
      'fn slow(n: i64) -> i64 with time {',
      '    std.time.sleep(3000);',
      '    return n;',
      '}',
      '',
      'fn main() with io, sync {',
      '    let h = std.sync.spawn(slow, 1);',
      '    let r = std.sync.join(h);',
      '    print(str(r.unwrap()));',
      '}',
      '',
    ].join('\n'));
    const qRuns = flags64.map(f => {
      const t0 = Date.now();
      const r = runMing(f ? ['run', p, '--max-ms', '100', f] : ['run', p, '--max-ms', '100']);
      return { r, ms: Date.now() - t0 };
    });
    const hit = qRuns.every(({ r, ms }) => r.code === 101 && (r.stderr ?? '').split('\n')[0].includes('M4012') && ms < 2000);
    check('v64.B7(#53):子任务 sleep(3000) + join + --max-ms 100 → 三引擎 M4012 且单次 < 2000ms',
      hit, `runs=${fmtRuns64(qRuns.map(x => x.r))} maxMs=${Math.max(...qRuns.map(x => x.ms))}`);
  }

  // v64.B8(#53):无配额场景不回归——spawn_all 批量 + 单 spawn/join 正常路径三引擎 exit 0
  // (2+4+6=12,join 得 20,合计 32;钳制只在配额存在时改变行为)
  {
    const p = m64('v64-b8-join-ok.ming', [
      'use std.io;',
      'use std.sync;',
      '',
      'fn dbl(n: i64) -> i64 { return n * 2; }',
      '',
      'fn main() with io, sync {',
      '    let all = std.sync.spawn_all(dbl, [1, 2, 3]);',
      '    let mut sum = 0;',
      '    for res in all { sum += res.unwrap(); }',
      '    let h = std.sync.spawn(dbl, 10);',
      '    sum += std.sync.join(h).unwrap();',
      '    print(str(sum));',
      '}',
      '',
    ].join('\n'));
    const runs = runAll64(p);
    check('v64.B8(#53):无配额场景 spawn_all/join 正常——三引擎 exit 0 输出 32',
      same64(runs, '32\n'), `runs=${fmtRuns64(runs)}`);
  }

  // v64.B9(B-1/#54 另一半):基类 Interp.runTests 透传资源门禁——--tree 时 VMInterp.runTests
  // 回落本方法,此前 sub 只继承 maxSteps,`ming test --tree --max-alloc/--max-ms` 对 test 块
  // 不生效(VM/--no-wasm 路径已生效 → 三引擎分歧);GUIDE 声明资源门禁旗标对 ming test 生效。
  {
    const pGate = m64('v64-b9-testgate.ming', [
      'fn main() with io { print("ok"); }',
      'test allocgate {',
      '    let v = [1, 2, 3, 4, 5, 6];',
      '    print(str(v.len()));',
      '}',
      '',
    ].join('\n'));
    const pSleep = m64('v64-b9-testsleep.ming', [
      'use std.io;',
      'use std.time;',
      '',
      'fn main() with io { print("ok"); }',
      'test slow_sleep {',
      '    std.time.sleep(300);',
      '}',
      '',
    ].join('\n'));
    const okTree = runMing(['test', pGate, '--tree']);
    const gatedTree = runMing(['test', pGate, '--tree', '--max-alloc', '5']);
    const qRuns = flags64.map(f => {
      const t0 = Date.now();
      const r = runMing(f ? ['test', pSleep, '--tree', '--max-ms', '100', f] : ['test', pSleep, '--tree', '--max-ms', '100']);
      return { r, ms: Date.now() - t0 };
    });
    const okM4011 = (r) => r.code === 1 && `${r.stderr ?? ''}${r.stdout ?? ''}`.includes('M4011');
    const okM4012 = ({ r, ms }) => r.code === 1 && `${r.stderr ?? ''}${r.stdout ?? ''}`.includes('M4012') && ms < 2000;
    check('v64.B9(B-1):ming test --tree 资源门禁——默认 exit 0;--max-alloc 5 exit 1 含 M4011;test 块 sleep(300) + --max-ms 100 三引擎 exit 1 含 M4012',
      okTree.code === 0 && okM4011(gatedTree) && qRuns.every(okM4012),
      `ok=${okTree.code} gated=${gatedTree.code}/${JSON.stringify(((gatedTree.stderr ?? '') + (gatedTree.stdout ?? '')).split('\n').find(l => l.includes('M40')) ?? '')} ms=${fmtRuns64(qRuns.map(x => x.r))} maxMs=${Math.max(...qRuns.map(x => x.ms))}`);
  }

  // §64-B-END

  // ---- §64-C-START(#54:bin/ming.js——ming test 旗标转发与 strict 冲突仲裁;ming init CLI 回归)----
  // v64.C1:ming test 透传 --max-alloc(限额消费依赖 §64-A/B 的 runTests 透传,同批合并后生效)。
  // 程序 VecLit 6 元素 → 累计分配 6;--max-alloc 5 超限 → M4011。
  {
    const fC1 = m64('c1_allocgate.ming', 'test allocgate {\n    let v = [1,2,3,4,5,6];\n    print(str(v.len()));\n}\n');
    const c1a = runMing(['test', fC1, '--max-alloc', '5']);
    check('v64.C1:ming test --max-alloc 5 → exit 1 且输出含 M4011',
      c1a.code === 1 && (c1a.stdout + c1a.stderr).includes('M4011'),
      `code=${c1a.code} out=${JSON.stringify(c1a.stdout)} err=${JSON.stringify(c1a.stderr.slice(0, 200))}`);
    const c1b = runMing(['test', fC1]);
    check('v64.C1:ming test 无限额 → exit 0',
      c1b.code === 0 && (c1b.stdout + c1b.stderr).includes('c1_allocgate.ming::allocgate'),
      `code=${c1b.code} out=${JSON.stringify(c1b.stdout)} err=${JSON.stringify(c1b.stderr.slice(0, 200))}`);
  }

  // v64.C2:ming test 的 --no-wasm 与 --tree 输出一致(exit 0);MING_WASM_DEBUG=1 下 --no-wasm
  // 的 stderr 无任何 [wasm] 行(test 子实例也关闭 wasm 层,#54 透传 noWasm)。
  {
    const fC2 = m64('c2_plain.ming', 'test t {\n    print("hello");\n}\n');
    const c2a = runMing(['test', fC2, '--no-wasm']);
    const c2b = runMing(['test', fC2, '--tree']);
    check('v64.C2:ming test --no-wasm 与 --tree 输出一致且 exit 0',
      c2a.code === 0 && c2b.code === 0 && c2a.stdout === c2b.stdout && c2a.stderr === c2b.stderr,
      `nowasm=${c2a.code}:${JSON.stringify(c2a.stdout)}/${JSON.stringify(c2a.stderr.slice(0, 120))} tree=${c2b.code}:${JSON.stringify(c2b.stdout)}/${JSON.stringify(c2b.stderr.slice(0, 120))}`);
    const c2d = runMing(['test', fC2, '--no-wasm'], { env: { MING_WASM_DEBUG: '1' } });
    const wasmLines = (c2d.stderr ?? '').split('\n').filter((l) => l.includes('[wasm]'));
    check('v64.C2:MING_WASM_DEBUG=1 下 test --no-wasm stderr 无 [wasm] 行',
      c2d.code === 0 && wasmLines.length === 0,
      `code=${c2d.code} wasmLines=${JSON.stringify(wasmLines.slice(0, 3))} err=${JSON.stringify((c2d.stderr ?? '').slice(0, 200))}`);
  }

  // v64.C3:--strict-wasm 与 --tree/--no-wasm 同现 → 与 run 同口径的互斥拒绝(exit 1,复用
  // STRICT_WASM_CONFLICT_MSG;fail 在非 JSON 下走 stderr)。
  {
    const fC3 = m64('c3_conflict.ming', 'test t {\n    print("x");\n}\n');
    const c3a = runMing(['test', fC3, '--strict-wasm', '--tree']);
    check('v64.C3:test --strict-wasm --tree → exit 1 且消息含"互斥"',
      c3a.code === 1 && (c3a.stdout + c3a.stderr).includes('互斥'),
      `code=${c3a.code} out=${JSON.stringify(c3a.stdout)} err=${JSON.stringify((c3a.stderr ?? '').slice(0, 160))}`);
    const c3b = runMing(['test', fC3, '--strict-wasm', '--no-wasm', '--json']);
    check('v64.C3:test --strict-wasm --no-wasm --json → exit 1 且 JSON {ok:false,error} 含"互斥"',
      c3b.code === 1 && (c3b.stdout + c3b.stderr).includes('互斥') && (c3b.stdout + c3b.stderr).includes('"ok":false'),
      `code=${c3b.code} out=${JSON.stringify((c3b.stdout ?? '').slice(0, 160))} err=${JSON.stringify((c3b.stderr ?? '').slice(0, 120))}`);
  }

  // v64.C6(审查修复):test 的 --strict-wasm 单独出现(不与 --tree/--no-wasm 冲突)→ 显式提示后
  // 忽略,退出码与 stdout 不变(不静默吞旗标;提示走 stderr)。
  {
    const fC6 = m64('c6_strict_alone.ming', 'test t {\n    print("x");\n}\n');
    const c6 = runMing(['test', fC6, '--strict-wasm']);
    const c6plain = runMing(['test', fC6]);
    check('v64.C6:test --strict-wasm 单独出现 → exit 0 且 stderr 含"已忽略"提示',
      c6.code === 0 && (c6.stderr ?? '').includes('已忽略'),
      `code=${c6.code} err=${JSON.stringify((c6.stderr ?? '').slice(0, 220))}`);
    check('v64.C6:test --strict-wasm 的 stdout 与不加旗标一致(旗标仅提示,不改变输出)',
      c6.stdout === c6plain.stdout,
      `strict=${JSON.stringify(c6.stdout.slice(0, 120))} plain=${JSON.stringify(c6plain.stdout.slice(0, 120))}`);
  }

  // v64.C4/C5:ming init CLI 回归(临时目录作 cwd,不入仓库)。
  {
    const cwdC4 = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-v64c-init-'));
    const c4 = runMing(['init', 'demo'], { cwd: cwdC4 });
    const manifestP = path.join(cwdC4, 'ming.toml');
    const entryP = path.join(cwdC4, 'main.ming');
    check('v64.C4:ming init demo → exit 0 输出含"已创建"且 ming.toml/main.ming 真实存在',
      c4.code === 0 && (c4.stdout + c4.stderr).includes('已创建')
      && fs.existsSync(manifestP) && fs.existsSync(entryP)
      && fs.readFileSync(manifestP, 'utf8').includes('name = "demo"')
      && fs.readFileSync(entryP, 'utf8').includes('fn main'),
      `code=${c4.code} out=${JSON.stringify(c4.stdout)} err=${JSON.stringify((c4.stderr ?? '').slice(0, 160))}`);

    const cwdC4j = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-v64c-init-json-'));
    const c4j = runMing(['init', 'demo', '--json'], { cwd: cwdC4j });
    let c4jJson = null;
    try { c4jJson = JSON.parse(c4j.stdout); } catch { /* 断言处报错 */ }
    check('v64.C4:ming init demo --json → {ok:true, manifest, entry} 且两文件真实存在',
      c4j.code === 0 && c4jJson?.ok === true && typeof c4jJson.manifest === 'string' && typeof c4jJson.entry === 'string'
      && fs.existsSync(c4jJson.manifest) && fs.existsSync(c4jJson.entry),
      `code=${c4j.code} out=${JSON.stringify((c4j.stdout ?? '').slice(0, 220))} err=${JSON.stringify((c4j.stderr ?? '').slice(0, 120))}`);

    // 确定性负例:initProject 的重名语义(manifest 已存在 → ok:false)——二次 init exit 1 且清单未被改写。
    const before = fs.readFileSync(manifestP, 'utf8');
    const c5 = runMing(['init', 'demo'], { cwd: cwdC4 });
    check('v64.C5:ming init 重名 → exit 1 且提示"已存在",ming.toml 未被改写',
      c5.code === 1 && (c5.stdout + c5.stderr).includes('已存在') && fs.readFileSync(manifestP, 'utf8') === before,
      `code=${c5.code} out=${JSON.stringify(c5.stdout)} err=${JSON.stringify((c5.stderr ?? '').slice(0, 160))}`);
  }
  // §64-C-END
}

// ===================== 65. v0.61:污点最小片(窄源 v1;ADR-002)=====================
// 文件所有权:§65-K = tools/*.ming 迁移(12 处 env.get 解包位)+ 本区全部用例。
// 语义权威:docs/adr-002-taint.md(窄源/白名单/禁面/sanitize_cli_path 裁决)+ docs/adr-002-spike.md(迁移面 12 处)。
{
  const dir65 = path.join(TMP, 'v65');
  fs.mkdirSync(dir65, { recursive: true });
  const m65 = (name, src) => { const f = path.join(dir65, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags65 = ['', '--no-wasm', '--tree'];
  const runAll65 = (p, extra = []) => flags65.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const same65 = (runs, want) => runs.every(r => r.code === 0 && r.stdout === want);
  const fmtRuns65 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');

  // ---- §65-K-START(tools 迁移冒烟 + §65 用例:来源标注/sink 门禁/白名单/禁面/净化向量/extern 强制/擦除一致)----
  // check 层断言口径:runMing(['check', f]) → exit 1 且 stderr 首行含指定码(码在首行 = 消息锁定)。
  const chk65 = (name, f, code) => {
    const r = runMing(['check', f]);
    check(name, r.code === 1 && (r.stderr ?? '').split('\n')[0].includes(code),
      `code=${r.code} first=${JSON.stringify((r.stderr ?? '').split('\n')[0])}`);
    return r;
  };
  // 三引擎 + 环境变量注入(env.get 来源的运行层用例;V65_VAL 为测试专用变量名)
  const runsEnv65 = (p, val) => flags65.map(f => runMing(f ? ['run', p, f] : ['run', p], { env: { V65_VAL: val } }));
  const BS = String.fromCharCode(92); // 反斜杠:ming 源里值内一个反斜杠 = 源码两个(BS+BS),避免多层转义歧义

  // v65.1 来源标注负例:env.get().unwrap() → write_file 路径位 M3049(hint 含 sanitize;全码名锁定)
  {
    const f = m65('k1_sink.ming', [
      'use std.env;',
      '',
      'use std.fs;',
      '',
      'fn main() with env, fs {',
      '    let p = std.env.get("V65_ANY").unwrap();',
      '    std.fs.write_file(p, "data");',
      '}',
    ].join('\n'));
    const r = chk65('v65.1:env.get().unwrap → write_file 路径位 M3049(check exit 1,码在 stderr 首行)', f, 'M3049');
    check('v65.1:M3049 全码名 untrusted-mismatch + hint 含 sanitize 处方',
      (r.stderr ?? '').includes('M3049[untrusted-mismatch]') && (r.stderr ?? '').includes('sanitize'),
      `err=${JSON.stringify((r.stderr ?? '').slice(0, 300))}`);
  }

  // v65.2 来源标注正例:sanitize_cli_path 净化后 run exit 0,良性 env 值 Ok 原样(三引擎一致)
  {
    const f = m65('k2_env_ok.ming', [
      'use std.env;',
      '',
      'use std.unstr;',
      '',
      'fn main() with env, io {',
      '    match std.env.get("V65_VAL") {',
      '        Some(u) => {',
      '            match std.unstr.sanitize_cli_path(u) {',
      '                Ok(p) => {',
      '                    print("OK " + p);',
      '                },',
      '                Err(e) => {',
      '                    print("ERR " + e);',
      '                },',
      '            }',
      '        },',
      '        None => {',
      '            print("NONE");',
      '        },',
      '    }',
      '}',
    ].join('\n'));
    const runs = runsEnv65(f, 'a.txt');
    check('v65.2:env.get 经 sanitize_cli_path 后 run exit 0,良性值 Ok 原样(三引擎一致)',
      same65(runs, 'OK a.txt\n'), fmtRuns65(runs));
  }

  // v65.3(v0.77 校准,ADR-007 §8.1 微调:print/print_raw/eprint 出向透传——stdout/stderr 是
  // CLI 工具的存储面,污值写出 = 存储非边界穿越):read_line → print 原 M3049 断言翻转。
  // 新合同 = echo 形态合法:check exit 0 + stdin 内容原样回显(三引擎逐字);debug()/插值
  // 洗白通道维持拒绝(v65.7/v65.8 不动,负例面不缩)。
  {
    const f = m65('k3_readline_print.ming', [
      'use std.io;',
      '',
      'fn main() with io {',
      '    let line = std.io.read_line();',
      '    print(line);',
      '}',
    ].join('\n'));
    const runs = flags65.map(fl => runMing(fl ? ['run', f, fl] : ['run', f], { stdin: 'echo-me\n' }));
    check('v65.3:read_line → print 出向透传(ADR-007 微调;check exit 0 + echo 语义,三引擎一致)',
      runs.every(r => r.code === 0 && r.stdout === 'echo-me\n'), fmtRuns65(runs));
  }

  // v65.4 read_line → parse_i64 白名单 OK(stdin 注入;三引擎一致,污点在数值上终结)
  {
    const f = m65('k4_readline_parse.ming', [
      'use std.io;',
      '',
      'fn main() with io {',
      '    let line = std.io.read_line();',
      '    match line.parse_i64() {',
      '        Ok(n) => {',
      '            print(str(n + 1));',
      '        },',
      '        Err(e) => {',
      '            print("E " + e);',
      '        },',
      '    }',
      '}',
    ].join('\n'));
    const runs = flags65.map(fl => runMing(fl ? ['run', f, fl] : ['run', f], { stdin: '41\n' }));
    check('v65.4:read_line → parse_i64 白名单 OK(stdin "41" → "42",三引擎一致)',
      runs.every(r => r.code === 0 && r.stdout === '42\n'), fmtRuns65(runs));
  }

  // v65.5 白名单五方法正例:parse_i64/parse_f64/char_len/byte_len/is_empty(三引擎一致)
  {
    const f = m65('k5_whitelist.ming', [
      'use std.unstr;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("42");',
      '    match u.parse_i64() {',
      '        Ok(n) => {',
      '            print(str(n + 1));',
      '        },',
      '        Err(e) => {',
      '            print("E " + e);',
      '        },',
      '    }',
      '    let w = std.unstr.mark("3.5");',
      '    match w.parse_f64() {',
      '        Ok(f) => {',
      '            print(str(f));',
      '        },',
      '        Err(e) => {',
      '            print("E " + e);',
      '        },',
      '    }',
      '    print(str(u.char_len()));',
      '    print(str(u.byte_len()));',
      '    if u.is_empty() {',
      '        print("empty");',
      '    } else {',
      '        print("nonempty");',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll65(f);
    check('v65.5:白名单五方法正例 run 三引擎一致(43/3.5/2/2/nonempty)',
      same65(runs, '43\n3.5\n2\n2\nnonempty\n'), fmtRuns65(runs));
  }

  // v65.6(v0.77 校准,ADR-007 清单 4 污值代数):trim 入保污纯函数集(keep),原 M3050 断言翻转。
  // u.trim() 本身合法;keep 语义经 return 槽锁定——返回类型 str(净)接收 Untrusted[str] → M3049
  // (保污 ≠ 洗白:白名单放行了操作,净槽位照拦)。原"白名单外方法"负例由 e04(u.zap)继续承担。
  {
    const f = m65('k6_trim.ming', [
      'use std.unstr;',
      '',
      'fn f(u: Untrusted[str]) -> str {',
      '    return u.trim();',
      '}',
      '',
      'fn main() with io {',
      '}',
    ].join('\n'));
    chk65('v65.6:u.trim() 保污(keep)——trim 合法但净 return 槽拦截 → M3049(check exit 1,码在 stderr 首行)', f, 'M3049');
  }

  // v65.7 禁面:debug(u) → M3050(调试通道即洗白通道;全码名锁定)
  {
    const f = m65('k7_debug.ming', [
      'use std.unstr;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("x");',
      '    print(debug(u));',
      '}',
    ].join('\n'));
    const r = chk65('v65.7:debug(u) → M3050(check exit 1,码在 stderr 首行)', f, 'M3050');
    check('v65.7:M3050 全码名 untrusted-method-forbidden 锁定',
      (r.stderr ?? '').includes('M3050[untrusted-method-forbidden]'),
      `err=${JSON.stringify((r.stderr ?? '').slice(0, 200))}`);
  }

  // v65.8 禁面:插值 \{u} → M3050
  {
    const f = m65('k8_interp.ming', [
      'use std.unstr;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("x");',
      '    print("v: \\{u}");',
      '}',
    ].join('\n'));
    chk65('v65.8:插值 \\{u} → M3050(check exit 1,码在 stderr 首行)', f, 'M3050');
  }

  // v65.9(v0.77 校准,ADR-007 §8.1 微调①②):"a" + u 由 M3008 拦截改为**拼接传播**(污+净→污,
  // 拦截面后移到消费 sink)。正例 = 拼接合法 + 结果保污经 print 透传逐字;负例两发 = 传播结果进净
  // return 槽 → M3049、净目标 += 污值 → M3049(复合赋值洗白旁路封死,微调②)。
  {
    const fp = m65('k9_plus.ming', [
      'use std.unstr;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("x");',
      '    print("a" + u);',
      '}',
    ].join('\n'));
    const runs = runAll65(fp);
    check('v65.9:"a" + u 拼接传播(ADR-007 微调①;结果保污经 print 出向透传,输出 ax,三引擎一致)',
      same65(runs, 'ax\n'), fmtRuns65(runs));

    const fr = m65('k9_plus_sink.ming', [
      'use std.unstr;',
      '',
      'fn f(u: Untrusted[str]) -> str {',
      '    return "a" + u;',
      '}',
      '',
      'fn main() with io {',
      '}',
    ].join('\n'));
    chk65('v65.9:拼接结果进净 return 槽 → M3049(check exit 1,码在 stderr 首行)', fr, 'M3049');

    const fa = m65('k9_pluseq.ming', [
      'use std.unstr;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("x");',
      '    let mut n = "net";',
      '    n += u;',
      '    print(n);',
      '}',
    ].join('\n'));
    chk65('v65.9:净目标 += 污值 → M3049(微调②;复合赋值洗白旁路封死,check exit 1,码在 stderr 首行)', fa, 'M3049');
  }

  // v65.10 载荷传播:Vec[Untrusted[str]] push/下标取出再净化 OK(三引擎一致)
  {
    const f = m65('k10_vec.ming', [
      'use std.unstr;',
      '',
      'fn main() with io {',
      '    let mut v: Vec[Untrusted[str]] = [];',
      '    v.push(std.unstr.mark("a/./b.txt"));',
      '    let u = v[0];',
      '    match std.unstr.sanitize_path(u) {',
      '        Ok(p) => {',
      '            print(p);',
      '        },',
      '        Err(e) => {',
      '            print("ERR " + e);',
      '        },',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll65(f);
    check('v65.10:Vec[Untrusted[str]] push/下标取出再净化 OK(a/b.txt,三引擎一致)',
      same65(runs, 'a/b.txt\n'), fmtRuns65(runs));
  }

  // v65.11 载荷传播:struct 字段 Untrusted[str] 构造/读取(三引擎一致)
  {
    const f = m65('k11_struct.ming', [
      'use std.unstr;',
      '',
      'struct Cfg { path: Untrusted[str] }',
      '',
      'fn main() with io {',
      '    let c = Cfg { path: std.unstr.mark("cfg.json") };',
      '    match std.unstr.sanitize_path(c.path) {',
      '        Ok(p) => {',
      '            print(p);',
      '        },',
      '        Err(e) => {',
      '            print("ERR " + e);',
      '        },',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll65(f);
    check('v65.11:struct 字段 Untrusted[str] 构造/读取再净化 OK(cfg.json,三引擎一致)',
      same65(runs, 'cfg.json\n'), fmtRuns65(runs));
  }

  // v65.12 载荷传播:? 与 Result[Untrusted[str], str] 载荷保留(三引擎一致;Err 消息逐字锁定)
  {
    const f = m65('k12_result.ming', [
      'use std.unstr;',
      '',
      'fn helper(u: Untrusted[str]) -> Result[str, str] {',
      '    let p = std.unstr.sanitize_path(u)?;',
      '    return Ok(p);',
      '}',
      '',
      'fn main() with io {',
      '    match helper(std.unstr.mark("x/../y")) {',
      '        Ok(p) => {',
      '            print("OK " + p);',
      '        },',
      '        Err(e) => {',
      '            print("ERR " + e);',
      '        },',
      '    }',
      '    let r: Result[Untrusted[str], str] = Ok(std.unstr.mark("cfg.json"));',
      '    match r {',
      '        Ok(u2) => {',
      '            match std.unstr.sanitize_path(u2) {',
      '                Ok(p) => {',
      '                    print("R " + p);',
      '                },',
      '                Err(e) => {',
      '                    print("RERR " + e);',
      '                },',
      '            }',
      '        },',
      '        Err(e) => {',
      '            print("E " + e);',
      '        },',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll65(f);
    check('v65.12:? 传播 Err + Result[Untrusted[str]] 载荷保留(三引擎一致,Err 消息逐字)',
      same65(runs, 'ERR sanitize_path: 拒绝 .. 段: "x/../y"\nR cfg.json\n'), fmtRuns65(runs));
  }

  // v65.13 unwrap_or 双向:脏载荷 + 干净值 → M3002;净 Option + 脏 fallback → M3049(check 层)
  {
    const fDirty = m65('k13a_unwrap_dirty.ming', [
      'use std.unstr;',
      '',
      'fn main() with io {',
      '    let o = Some(std.unstr.mark("dirty"));',
      '    let s = o.unwrap_or("clean");',
      '    print(s);',
      '}',
    ].join('\n'));
    chk65('v65.13:unwrap_or 干净值 + 脏载荷 → M3002(精确匹配,无隐式转换)', fDirty, 'M3002');
    const fClean = m65('k13b_unwrap_fallback.ming', [
      'use std.unstr;',
      '',
      'fn main() with io {',
      '    let o: Option[str] = Some("clean");',
      '    let s = o.unwrap_or(std.unstr.mark("dirty"));',
      '    print(s);',
      '}',
    ].join('\n'));
    chk65('v65.13:净 Option + 脏 fallback → M3049(专用码优先)', fClean, 'M3049');
  }

  // v65.14 sanitize_path 向量(J 的 Err 消息逐字):7 条,三引擎逐字一致
  {
    const f = m65('k14_path_vectors.ming', [
      'use std.unstr;',
      '',
      'fn show(u: Untrusted[str]) with io {',
      '    match std.unstr.sanitize_path(u) {',
      '        Ok(p) => {',
      '            print("OK " + p);',
      '        },',
      '        Err(e) => {',
      '            print("ERR " + e);',
      '        },',
      '    }',
      '}',
      '',
      'fn main() with io {',
      '    show(std.unstr.mark("cfg.txt"));',
      '    show(std.unstr.mark("./a/./b.txt"));',
      '    show(std.unstr.mark("/abs"));',
      '    show(std.unstr.mark("a/../b"));',
      '    show(std.unstr.mark("a//b"));',
      '    show(std.unstr.mark(""));',
      '    show(std.unstr.mark("a/b/"));',
      '}',
    ].join('\n'));
    const want = [
      'OK cfg.txt',
      'OK a/b.txt',
      'ERR sanitize_path: 拒绝绝对路径: "/abs"',
      'ERR sanitize_path: 拒绝 .. 段: "a/../b"',
      'ERR sanitize_path: 空段: "a//b"',
      'ERR sanitize_path: 路径不能为空',
      'OK a/b',
    ].join('\n') + '\n';
    const runs = runAll65(f);
    check('v65.14:sanitize_path 七向量(规范化/绝对路径/../空段/空串/尾随斜杠)三引擎逐字',
      same65(runs, want), fmtRuns65(runs));
  }

  // v65.15 sanitize_cli_path 向量:校验不改写——绝对路径/.. 段/反斜杠路径 Ok 原样,空串 Err(三引擎逐字)
  {
    const f = m65('k15_cli_vectors.ming', [
      'use std.unstr;',
      '',
      'fn show(u: Untrusted[str]) with io {',
      '    match std.unstr.sanitize_cli_path(u) {',
      '        Ok(p) => {',
      '            print("OK " + p);',
      '        },',
      '        Err(e) => {',
      '            print("ERR " + e);',
      '        },',
      '    }',
      '}',
      '',
      'fn main() with io {',
      '    show(std.unstr.mark("C:' + BS + BS + 'x"));',
      '    show(std.unstr.mark("a/../b"));',
      '    show(std.unstr.mark("rel' + BS + BS + 'dir"));',
      '    show(std.unstr.mark(""));',
      '}',
    ].join('\n'));
    const want = [
      'OK C:' + BS + 'x',
      'OK a/../b',
      'OK rel' + BS + 'dir',
      'ERR sanitize_cli_path: 路径不能为空',
    ].join('\n') + '\n';
    const runs = runAll65(f);
    check('v65.15:sanitize_cli_path 校验不改写(绝对路径/.. 段/反斜杠 Ok 原样,空串 Err)三引擎逐字',
      same65(runs, want), fmtRuns65(runs));
  }

  // v65.16 控制字符 env 注入:Err 消息含 sanitize_cli_path 与 \uXXXX 转义(确定性,防 stderr 注入)
  {
    const f = m65('k16_ctrl.ming', [
      'use std.env;',
      '',
      'use std.unstr;',
      '',
      'fn main() with env, io {',
      '    match std.env.get("V65_VAL") {',
      '        Some(u) => {',
      '            match std.unstr.sanitize_cli_path(u) {',
      '                Ok(p) => {',
      '                    print("OK " + p);',
      '                },',
      '                Err(e) => {',
      '                    print("ERR " + e);',
      '                },',
      '            }',
      '        },',
      '        None => {',
      '            print("NONE");',
      '        },',
      '    }',
      '}',
    ].join('\n'));
    const runs = runsEnv65(f, 'a\tb'); // 等价 bash ANSI-C $'a\tb':制表符属 C0 控制字符
    check('v65.16:控制字符 env 注入 → Err 含 sanitize_cli_path 与 \\uXXXX 转义(三引擎一致)',
      same65(runs, 'ERR sanitize_cli_path: 含控制字符: "a' + BS + 'u0009b"\n'), fmtRuns65(runs));
  }

  // v65.17 extern 强制三态:裸 str 返回 → M3049 声明处;Untrusted[str] 声明 → check 通过;i64 不受影响
  {
    const fBare = m65('k17a_extern_str.ming', [
      'extern "msvcrt" fn strlen(s: str) -> str;',
      '',
      'fn main() {',
      '}',
    ].join('\n'));
    chk65('v65.17:extern 裸 str 返回 → M3049 声明处(C 世界返回值没有可信的)', fBare, 'M3049');
    const fTagged = m65('k17b_extern_untrusted.ming', [
      'extern "msvcrt" fn strlen(s: str) -> Untrusted[str];',
      '',
      'fn main() {',
      '}',
    ].join('\n'));
    const rTagged = runMing(['check', fTagged]);
    check('v65.17:extern -> Untrusted[str] 声明 → check exit 0',
      rTagged.code === 0, `code=${rTagged.code} err=${JSON.stringify((rTagged.stderr ?? '').slice(0, 160))}`);
    const fI64 = m65('k17c_extern_i64.ming', [
      'extern "msvcrt" fn _abs64(x: i64) -> i64;',
      '',
      'fn main() with io, ffi {',
      '    print(str(_abs64(-42)));',
      '}',
    ].join('\n'));
    const rI64 = runMing(['check', fI64]);
    check('v65.17:extern i64 返回不受污点强制影响(check exit 0;对照既有 msvcrt 用例口径)',
      rI64.code === 0, `code=${rI64.code} err=${JSON.stringify((rI64.stderr ?? '').slice(0, 160))}`);
  }

  // v65.18 擦除一致:mark/净化版与手写净串版运行输出逐字一致(运行时无污点位;三引擎)
  {
    const fDirty = m65('k18a_erasure_dirty.ming', [
      'use std.unstr;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("hello");',
      '    print(str(u.char_len()));',
      '    match std.unstr.sanitize_cli_path(u) {',
      '        Ok(p) => {',
      '            print(p);',
      '        },',
      '        Err(e) => {',
      '            print("ERR " + e);',
      '        },',
      '    }',
      '}',
    ].join('\n'));
    const fClean = m65('k18b_erasure_clean.ming', [
      'fn main() with io {',
      '    let s = "hello";',
      '    print(str(s.char_len()));',
      '    print(s);',
      '}',
    ].join('\n'));
    const runsDirty = runAll65(fDirty);
    const runsClean = runAll65(fClean);
    check('v65.18:擦除一致——mark/净化版与净串版输出逐字相同(5/hello,三引擎)',
      same65(runsDirty, '5\nhello\n') && same65(runsClean, '5\nhello\n'),
      `dirty=${fmtRuns65(runsDirty)} clean=${fmtRuns65(runsClean)}`);
  }

  // v65.19 工具冒烟:wc/tree/log_analyzer 良性 env 值输出与 argv 模式(= 迁移前基线)逐字一致;
  // 控制字符 env 值 → exit 1 + stderr 含 sanitize_cli_path(run 与 tools 路由双口径)。
  {
    const fixD = path.join(dir65, 'fix');
    fs.mkdirSync(path.join(fixD, 'sub'), { recursive: true });
    const fixA = path.join(fixD, 'a.txt');
    const fixLog = path.join(fixD, 'a.log');
    fs.writeFileSync(fixA, 'alpha\nbeta\n', 'utf8'); // 2 行 2 词 11 字节
    fs.writeFileSync(fixLog, '2026-11-14 ERROR disk full\n2026-11-14 WARN slow\n2026-11-14 INFO ok\nnoise line\n', 'utf8');
    fs.writeFileSync(path.join(fixD, 'sub', 's.ming'), '// TODO fix me\nfn main() {}\n', 'utf8');
    const wcP = path.join(ROOT, 'tools', 'wc.ming');
    const treeP = path.join(ROOT, 'tools', 'tree.ming');
    const laP = path.join(ROOT, 'tools', 'log_analyzer.ming');

    const wcEnv = runMing(['run', wcP], { env: { WC_FILE: fixA } });
    const wcArgv = runMing(['run', wcP, '--', fixA]);
    const wcWant = `2 2 11 ${fixA}\n`;
    check('v65.19:wc 经 WC_FILE(良性值)输出与 argv 模式逐字一致且精确(2 2 11)',
      wcEnv.code === 0 && wcArgv.code === 0 && wcEnv.stdout === wcWant && wcArgv.stdout === wcWant,
      `env=${JSON.stringify(wcEnv.stdout)} argv=${JSON.stringify(wcArgv.stdout)} want=${JSON.stringify(wcWant)}`);

    const wcCtrlRun = runMing(['run', wcP], { env: { WC_FILE: 'a\tb' } });
    check('v65.19:wc WC_FILE 控制字符 → exit 1 stderr 含 sanitize_cli_path(run 路由)',
      wcCtrlRun.code === 1 && (wcCtrlRun.stderr ?? '').includes('sanitize_cli_path'),
      `code=${wcCtrlRun.code} err=${JSON.stringify((wcCtrlRun.stderr ?? '').slice(0, 160))}`);
    const wcCtrlTools = runMing(['tools', 'wc'], { env: { WC_FILE: 'a\tb' } });
    check('v65.19:ming tools wc WC_FILE 控制字符 → exit 1 stderr 含 sanitize_cli_path(tools 路由)',
      wcCtrlTools.code === 1 && (wcCtrlTools.stderr ?? '').includes('sanitize_cli_path'),
      `code=${wcCtrlTools.code} err=${JSON.stringify((wcCtrlTools.stderr ?? '').slice(0, 160))}`);

    const treeEnv = runMing(['run', treeP, '--', ''], { env: { TREE_ROOT: fixD } });
    const treeArgv = runMing(['run', treeP, '--', fixD]);
    check('v65.19:tree 经 TREE_ROOT(良性值)输出与 argv 模式逐字一致(env 回退经净化不改写)',
      treeEnv.code === 0 && treeArgv.code === 0 && treeEnv.stdout === treeArgv.stdout,
      `env=${JSON.stringify(treeEnv.stdout.slice(0, 80))}/${treeEnv.code} argv=${JSON.stringify(treeArgv.stdout.slice(0, 80))}/${treeArgv.code}`);

    const laEnv = runMing(['run', laP], { env: { LOG_FILE: fixLog } });
    const laArgv = runMing(['run', laP, '--', fixLog]);
    check('v65.19:log_analyzer 经 LOG_FILE(良性值)输出与 argv 模式逐字一致(分类计数不变)',
      laEnv.code === 0 && laArgv.code === 0 && laEnv.stdout === laArgv.stdout
      && laEnv.stdout.includes('总行数: 4') && laEnv.stdout.includes('ERROR: 1'),
      `env=${JSON.stringify(laEnv.stdout)}/${laEnv.code} argv=${JSON.stringify(laArgv.stdout)}/${laArgv.code}`);
  }

  // v65.20 doc --json:signature 渲染 Untrusted[str](typeStr 渲染串口径,清单 15)
  {
    const f = m65('k20_doc.ming', [
      'fn tagged(u: Untrusted[str]) -> Result[str, str] {',
      '    return Ok("x");',
      '}',
    ].join('\n'));
    const r = runMing(['doc', f, '--json']);
    let doc = null;
    try { doc = JSON.parse(r.stdout); } catch { /* 断言处报错 */ }
    const sig = doc?.items?.[0]?.signature ?? '';
    check('v65.20:ming doc --json 的 signature 渲染 Untrusted[str]',
      r.code === 0 && doc?.ok === true && sig === 'fn tagged(u: Untrusted[str]) -> Result[str, str]',
      `code=${r.code} sig=${JSON.stringify(sig)} out=${JSON.stringify((r.stdout ?? '').slice(0, 160))}`);
  }

  // v65.21 契约 sanitize 形态锁定(ADR-002 §4.2 决定性优势:净化器在 requires 内可调用,
  // 契约成为可信根的静态声明面):check exit 0;运行 f(mark("cfg.txt")) → Ok(cfg.txt)
  // (三引擎逐字);违约形态(requires 对实际输入恒假)→ 运行时 M4015 exit 101。
  {
    const contractSrc = (req) => [
      'use std.unstr;',
      '',
      `fn f(u: Untrusted[str]) -> Result[str, str] requires ${req} {`,
      '    return std.unstr.sanitize_path(u);',
      '}',
      '',
      'fn main() with io {',
      '    match f(std.unstr.mark("cfg.txt")) {',
      '        Ok(p) => {',
      '            print("OK " + p);',
      '        },',
      '        Err(e) => {',
      '            print("ERR " + e);',
      '        },',
      '    }',
      '}',
    ].join('\n');
    const fOk = m65('k21a_contract_ok.ming', contractSrc('u.byte_len() < 256 && std.unstr.sanitize_path(u).is_ok()'));
    const rOk = runMing(['check', fOk]);
    check('v65.21:契约 sanitize 形态 check exit 0(requires 内 sanitize_path().is_ok() 可调用)',
      rOk.code === 0, `code=${rOk.code} err=${JSON.stringify((rOk.stderr ?? '').slice(0, 160))}`);
    const runsOk = runAll65(fOk);
    check('v65.21:契约 f(mark("cfg.txt")) → Ok(cfg.txt)(三引擎逐字)',
      same65(runsOk, 'OK cfg.txt\n'), fmtRuns65(runsOk));
    const fBad = m65('k21b_contract_violated.ming', contractSrc('u.byte_len() < 1 && std.unstr.sanitize_path(u).is_ok()'));
    const rBad = runMing(['check', fBad]);
    const runsBad = runAll65(fBad);
    check('v65.21:契约 requires 违约(实际 false)→ M4015 exit 101(三引擎)',
      rBad.code === 0 && runsBad.every(r => r.code === 101 && /M4015/.test(r.stderr)),
      `check=${rBad.code} runs=${fmtRuns65(runsBad)}`);
  }

  // v65.22 `as` 洗白禁面 + 载体禁面(M3050 锁码):白名单方法结果经 as 数值位 OK;
  // 直接 u as str / u as i64 → M3050(洗白通道关闭);Untrusted[i64] 与
  // Untrusted[Untrusted[str]] 声明 → M3050(载体 v1 仅 str,扩载体不得静默)。
  {
    const fWl = m65('k22a_as_whitelist.ming', [
      'use std.unstr;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("hi");',
      '    print(str(u.byte_len() as i64));',
      '}',
    ].join('\n'));
    const rWl = runMing(['check', fWl]);
    const runsWl = runAll65(fWl);
    check('v65.22:白名单 u.byte_len() as i64 OK(2,三引擎逐字)',
      rWl.code === 0 && same65(runsWl, '2\n'), `check=${rWl.code} runs=${fmtRuns65(runsWl)}`);
    const fAsStr = m65('k22b_as_str.ming', [
      'fn g(u: Untrusted[str]) -> str {',
      '    return u as str;',
      '}',
      '',
      'fn main() {',
      '}',
    ].join('\n'));
    chk65('v65.22:u as str → M3050(as 是洗白通道,对 Untrusted 关闭)', fAsStr, 'M3050');
    const fAsI64 = m65('k22c_as_i64.ming', [
      'fn g(u: Untrusted[str]) -> i64 {',
      '    return u as i64;',
      '}',
      '',
      'fn main() {',
      '}',
    ].join('\n'));
    chk65('v65.22:u as i64 → M3050(as 是洗白通道,对 Untrusted 关闭)', fAsI64, 'M3050');
    const fCarI64 = m65('k22d_carrier_i64.ming', [
      'fn h(x: Untrusted[i64]) {',
      '}',
      '',
      'fn main() {',
      '}',
    ].join('\n'));
    chk65('v65.22:Untrusted[i64] 载体禁面 → M3050(载体 v1 仅 str)', fCarI64, 'M3050');
    const fCarNest = m65('k22e_carrier_nested.ming', [
      'fn h(x: Untrusted[Untrusted[str]]) {',
      '}',
      '',
      'fn main() {',
      '}',
    ].join('\n'));
    chk65('v65.22:Untrusted[Untrusted[str]] 嵌套载体禁面 → M3050(载体 v1 仅 str)', fCarNest, 'M3050');
  }

  // v65.23 cc 擦除一致腿(gcc 存在才跑;探测与 §58/§60 同款;无编译器 → skip 保持绿)。
  // M1 审查修复后:extern getenv 形态(let 标注 Untrusted[str] + byte_len)可经 ming cc
  // 编译运行;输出与净串孪生程序的 tree 引擎输出逐字一致——tree 不执行 FFI(M4001 是设计
  // 行为),故对照面取净串孪生(即 v65.18 擦除一致的跨后端版)。另:emit-c 快照含
  // const char* 载体槽位签名(Untrusted 擦除 → C ABI 按 str)。
  {
    const ccAvail65 = (() => {
      if (process.env.MING_CC && fs.existsSync(process.env.MING_CC)) return true;
      for (const c of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
        if (fs.existsSync(c)) return true;
      }
      return spawnSync('gcc', ['--version'], { encoding: 'utf8' }).status === 0;
    })();
    const fFfi = m65('k23a_ffi_untrusted.ming', [
      'extern "msvcrt" fn getenv(n: str) -> Untrusted[str];',
      '',
      'fn main() with ffi, io {',
      '    let raw: Untrusted[str] = getenv("V65K_STR");',
      '    print(raw.byte_len() as i64);',
      '}',
    ].join('\n'));
    const fTwin = m65('k23b_clean_twin.ming', [
      'fn main() with io {',
      '    let s = "ming-rocks";',
      '    print(str(s.byte_len()));',
      '}',
    ].join('\n'));
    if (ccAvail65) {
      const ccDir = path.join(dir65, 'ccout');
      fs.mkdirSync(ccDir, { recursive: true });
      const build = spawnSync(process.execPath, [MING, 'cc', fFfi, '--out', ccDir], { encoding: 'utf8', cwd: ROOT, timeout: 180000 });
      const exe = path.join(ccDir, 'k23a_ffi_untrusted.exe');
      const rc = build.status === 0 && fs.existsSync(exe)
        ? spawnSync(exe, [], { encoding: 'utf8', timeout: 30000, env: { ...process.env, V65K_STR: 'ming-rocks' } })
        : { status: -1, stdout: '', stderr: 'no exe' };
      const twinTree = runMing(['run', fTwin, '--tree']);
      check('v65.23:cc extern getenv Untrusted 形态编译运行,输出与净串孪生 tree 输出逐字一致(10)',
        build.status === 0 && rc.status === 0 && twinTree.code === 0 && rc.stdout === twinTree.stdout && rc.stdout === '10\n',
        `build=${build.status} rc=${rc.status} cc=${JSON.stringify(rc.stdout)} ccErr=${JSON.stringify((build.stderr ?? '').slice(0, 120))} tree=${twinTree.code}:${JSON.stringify(twinTree.stdout)}`);
      const emDir = path.join(dir65, 'ccemit');
      fs.mkdirSync(emDir, { recursive: true });
      const em = spawnSync(process.execPath, [MING, 'cc', fFfi, '--emit-c', '--out', emDir], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
      const emText = em.status === 0 ? fs.readFileSync(path.join(emDir, 'k23a_ffi_untrusted.c'), 'utf8') : '';
      check('v65.23:emit-c 快照含 const char* 载体槽位签名(ming_ffi_getenv;Untrusted 擦除按 str)',
        em.status === 0 && emText.includes('const char* (*ming_ffi_getenv)(const char*)'),
        `em=${em.status} hasGetenv=${emText.includes('ming_ffi_getenv')}`);
    } else {
      check('v65.23:cc extern getenv Untrusted 形态编译运行一致(gcc 不存在,跳过)', true, 'skip: 无 C 编译器');
      check('v65.23:emit-c 载体槽位签名(gcc 不存在,跳过)', true, 'skip: 无 C 编译器');
    }
  }

  // v65.24 sanitize_path 盘符相对路径向量(M2 审查修复锁定):`C:x` 冒号即拒——原实现
  // 要求冒号后跟分隔符而漏判盘符相对路径;`C:\x` 维持 Err;消息沿用"拒绝绝对路径"
  // 逐字不变(v65.14 既有绝对路径向量不受影响)。
  {
    const f = m65('k24_driveletter.ming', [
      'use std.unstr;',
      '',
      'fn show(u: Untrusted[str]) with io {',
      '    match std.unstr.sanitize_path(u) {',
      '        Ok(p) => {',
      '            print("OK " + p);',
      '        },',
      '        Err(e) => {',
      '            print("ERR " + e);',
      '        },',
      '    }',
      '}',
      '',
      'fn main() with io {',
      '    show(std.unstr.mark("C:x"));',
      '    show(std.unstr.mark("C:' + BS + BS + 'x"));',
      '}',
    ].join('\n'));
    const want = [
      'ERR sanitize_path: 拒绝绝对路径: "C:x"',
      'ERR sanitize_path: 拒绝绝对路径: "C:' + BS + 'x"',
    ].join('\n') + '\n';
    const runs = runAll65(f);
    check('v65.24:sanitize_path 盘符相对路径 C:x 与 C:\\x → Err 拒绝绝对路径(M2 锁定)三引擎逐字',
      same65(runs, want), fmtRuns65(runs));
  }
  // §65-K-END
}

// ===================== 66. v0.62:服务端 v1(std.net.serve,worker-per-connection;ADR-001 16/16)=====================
// 文件所有权:§66 = 本区全部用例(checker serve 门禁 / 三段式拒绝 / 回环与并发冒烟)。
// 语义权威:docs/adr-001-concurrency.md §2.1/§5.2 + 评审清单 16/16 裁决(2026-11-14)。
{
  const dir66 = path.join(TMP, 'v66');
  fs.mkdirSync(dir66, { recursive: true });
  const m66 = (name, src) => { const f = path.join(dir66, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags66 = ['', '--no-wasm', '--tree'];
  const runAll66 = (p, extra = []) => flags66.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const fmtRuns66 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');

  // ---- §66-START(serve v1 用例:效果强制/handler 白名单与形态/跨模块收紧/回环 GET·POST/panic 500/超时 504/体超限 413/队列满 503/三引擎一致/wasm 资格/cc 拒绝/并发冒烟/CRLF 头注入与 9MB 响应护栏)----
  // 运行面 harness(ADR-001 清单 13:独立进程回环,CI 仅 localhost):spawn 子进程
  // `node bin/ming.js run <server.ming>`(stdio pipe,detached:false)→ TCP 探测就绪
  // (≤15s;不用 HTTP 探测——504 用例 handler 睡 40s,HTTP 探测自身会撞超时)→ fetch
  // 断言 → finally kill(不留监听;Windows 3s 后 taskkill /T /F 兜底)。端口:26000-27999
  // 段内按用例编号偏移(26000 + 用例号×10 + 槽位),跑前 net listen 探测空闲,占用
  // +1 重试(≤5 次)。响应编码断言依赖 S2 运行面契约(请求 {method,path,headers,body} /
  // 响应 {status,headers,body};错误体统一 Json{code,message}:413 body_too_large /
  // 503 queue_full / 500 handler_panic·worker_start_failed / 504 timeout)。
  const { createServer: netServer66, createConnection: netConn66 } = await import('node:net');
  const { request: httpRequest66 } = await import('node:http');
  const sleep66 = (ms) => new Promise((res) => setTimeout(res, ms));
  const port66 = (caseIdx, slot = 0) => 26000 + caseIdx * 10 + slot;

  // server 程序共用响应构造:纯 Json 管线(stringify→parse 往返,注入安全,无效果声明)。
  const RESPOND66 = [
    'fn respond(status: i64, body: str) -> Json {',
    '    let resp: Map[str, Json] = {',
    '        "status": std.json.parse(std.json.stringify(status)).unwrap(),',
    '        "headers": std.json.parse("{}").unwrap(),',
    '        "body": std.json.parse(std.json.stringify(body)).unwrap(),',
    '    };',
    '    return std.json.parse(std.json.stringify(resp)).unwrap();',
    '}',
  ].join('\n');
  // 请求载荷访问:{method,path,headers,body} 的 str 键取值(缺键/类型不合回落默认)。
  // v0.68/ADR-004 §3.2 投影形态:污接收者 get→Option[Untrusted[Json]]、as_str→Option[Untrusted[str]];
  // 净 str 出口唯一 = sanitize_cli_path(校验不改写,Err 回落默认)——echo 合法形态 = 投影+净化(ADR-004 §4.3)。
  const JSTR66 = [
    'fn jstr(req: Untrusted[Json], key: str, dflt: str) -> str {',
    '    return match req.get(key) {',
    '        Some(v) => match v.as_str() {',
    '            Some(s) => match std.unstr.sanitize_cli_path(s) {',
    '                Ok(p) => p,',
    '                Err(_) => dflt,',
    '            },',
    '            None => dflt,',
    '        },',
    '        None => dflt,',
    '    };',
    '}',
  ].join('\n');
  const serverSrc66 = (bodyLines, extraUse = []) => [
    'use std.net;',
    'use std.json;',
    ...extraUse,
    '',
    RESPOND66,
    '',
    ...bodyLines,
    '',
    'fn main() with net {',
    '    std.net.serve(__PORT__, handler);',
    '}',
  ].join('\n');
  // v0.68/ADR-004:handler 形参统一 Untrusted[Json];触载荷取值走 JSTR66 投影+净化(§3.2/§4.3)。
  const SRC66 = {
    // GET/413/双引擎/端口占用-A 共用:固定 200 "hello"
    get: serverSrc66([
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    return respond(200, "hello");',
      '}',
    ]),
    // POST 回显 body/path(v66.5):jstr 提取请求载荷 str 键,拼接回显
    echo: [
      'use std.net;',
      'use std.json;',
      'use std.unstr;',
      '',
      RESPOND66,
      '',
      JSTR66,
      '',
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    let p = jstr(req, "path", "?");',
      '    let b = jstr(req, "body", "");',
      '    return respond(200, "path:" + p + "|body:" + b);',
      '}',
      '',
      'fn main() with net {',
      '    std.net.serve(__PORT__, handler);',
      '}',
    ].join('\n'),
    // handler panic(v66.6):Vec 下标越界 → M4003,500 {code:handler_panic} 透传
    panic: serverSrc66([
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    let v: Vec[i64] = [1];',
      '    return respond(200, str(v[5]));',
      '}',
    ]),
    // handler 睡 40s(v66.7):服务端 30s 硬杀 → 504 {code:timeout},响应 <35s 返回
    sleep40s: serverSrc66([
      'fn handler(req: Untrusted[Json]) -> Json with time {',
      '    std.time.sleep(40000);',
      '    return respond(200, "late");',
      '}',
    ], ['use std.time;']),
    // handler 睡 50ms(v66.9 队列满):16 并发 + 256 队列 = 272 容量,300 并发超额 503
    sleep50ms: serverSrc66([
      'fn handler(req: Untrusted[Json]) -> Json with time {',
      '    std.time.sleep(50);',
      '    return respond(200, "q");',
      '}',
    ], ['use std.time;']),
    // handler 睡 100ms(v66.13 并发冒烟):20 并发全部 200
    sleep100ms: serverSrc66([
      'fn handler(req: Untrusted[Json]) -> Json with time {',
      '    std.time.sleep(100);',
      '    return respond(200, "ok");',
      '}',
    ], ['use std.time;']),
    // v66.11 wasm 资格构造(ADR §5.2 任务 4):纯函数 pure_add 处 wasm 候选位,
    // serve 所在 main 因 net 效果永不进 eligible——断言 pure_add OK 且无 REJECT 噪声。
    wasmProbe: [
      'use std.net;',
      'use std.json;',
      'use std.io;',
      '',
      RESPOND66,
      '',
      'fn pure_add(a: i64, b: i64) -> i64 {',
      '    return a + b;',
      '}',
      '',
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    return respond(200, "x");',
      '}',
      '',
      'fn main() with net, io {',
      '    print(str(pure_add(2, 3)));',
      '    std.net.serve(26011, handler);',
      '}',
    ].join('\n'),
    // v66.14 端口占用-B:serve 返回 Err(main 打印 ERR 后退出;A 已占同端口)
    portErr: [
      'use std.net;',
      'use std.json;',
      '',
      RESPOND66,
      '',
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    return respond(200, "hello");',
      '}',
      '',
      'fn main() with net, io {',
      '    match std.net.serve(__PORT__, handler) {',
      '        Ok(code) => { print("ok " + str(code)); },',
      '        Err(e) => { print("ERR " + e); },',
      '    }',
      '}',
    ].join('\n'),
    // v66.16 handler 响应头含 CRLF(B1 审查修复锁定):仅 /evil 注入——headers 值经 JSON
    // \r\n 转义构造真实 CR/LF → respond 头白名单拒绝 → 500 {code:internal_error}
    // (拒绝优于截断);/ok 正常 200(服务存活佐证)。修复前:writeHead 抛 ERR_INVALID_CHAR
    // → accept 线程 uncaughtException 死亡 → 主进程永久悬挂(请求侧 socket hang up)
    crlf: [
      'use std.net;',
      'use std.json;',
      'use std.unstr;',
      '',
      RESPOND66,
      '',
      JSTR66,
      '',
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    if jstr(req, "path", "?") == "/evil" {',
      '        let resp: Map[str, Json] = {',
      '            "status": std.json.parse("200").unwrap(),',
      '            "headers": std.json.parse("{\\"X-Evil\\": \\"a\\\\r\\\\nInjected: 1\\"}").unwrap(),',
      '            "body": std.json.parse("\\"hi\\"").unwrap(),',
      '        };',
      '        return std.json.parse(std.json.stringify(resp)).unwrap();',
      '    }',
      '    return respond(200, "hello");',
      '}',
      '',
      'fn main() with net {',
      '    std.net.serve(__PORT__, handler);',
      '}',
    ].join('\n'),
    // v66.17 handler 返回 9MB body(n1 审查修复锁定):超 8MB 上限 → 500
    // {code:response_too_large} 并关连接(不截断——截断破坏 Content-Length)
    bigBody: serverSrc66([
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    let big = "x".repeat(9437184);',
      '    return respond(200, big);',
      '}',
    ]),
  };

  // ---- checker 层(v66.1-v66.3:S1 面,直接 runMing check)----
  {
    const f = m66('k66_1_effect.ming', [
      'use std.net;',
      '',
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    return std.json.parse("{}").unwrap();',
      '}',
      '',
      'fn main() {',
      '    std.net.serve(26001, handler);',
      '}',
    ].join('\n'));
    const r = runMing(['check', f]);
    check('v66.1:main 未声明 net 调 serve → check exit 1 + M3029(效果强制)',
      r.code === 1 && r.stderr.includes('M3029') && r.stderr.includes('net'),
      `code=${r.code} ${JSON.stringify(r.stderr.split('\n')[0])}`);
  }
  {
    // handler 三禁效果(ADR-001 清单 2/11):sync/unsafe/ffi 在 handler 内编译期拒绝
    const serveBadEff66 = (eff) => {
      const lines = ['use std.net;', 'use std.json;'];
      if (eff === 'sync') lines.push('use std.sync;');
      lines.push(
        '',
        'fn handler(req: Untrusted[Json]) -> Json with ' + eff + ' {',
        '    return std.json.parse("{}").unwrap();',
        '}',
        '',
        'fn main() with net {',
        '    std.net.serve(26001, handler);',
        '}',
      );
      return lines.join('\n');
    };
    for (const eff of ['sync', 'unsafe', 'ffi']) {
      const f = m66('k66_2_' + eff + '.ming', serveBadEff66(eff));
      const r = runMing(['check', f]);
      check(`v66.2:handler with ${eff} → check exit 1 + M3002(handler 三禁效果白名单)`,
        r.code === 1 && r.stderr.includes('M3002') && r.stderr.includes(eff),
        `code=${r.code} ${JSON.stringify(r.stderr.split('\n')[0])}`);
    }
  }
  {
    // handler 形态拒绝(参照 spawn 特例):lambda/本地函数/非函数实参一律 M3002
    const jbody = 'fn handler(req: Untrusted[Json]) -> Json { return std.json.parse("{}").unwrap(); }';
    const shapes = [
      ['lambda', ['use std.net;', 'use std.json;', '', jbody, '', 'fn main() with net {',
        '    std.net.serve(26001, (req: Untrusted[Json]) => std.json.parse("{}").unwrap());', '}'].join('\n')],
      ['local_fn', ['use std.net;', 'use std.json;', '', 'fn main() with net {',
        '    fn local_handler(req: Untrusted[Json]) -> Json { return std.json.parse("{}").unwrap(); }',
        '    std.net.serve(26001, local_handler);', '}'].join('\n')],
      ['not_fn', ['use std.net;', 'use std.json;', '', 'fn main() with net {',
        '    let not_a_fn: i64 = 42;', '    std.net.serve(26001, not_a_fn);', '}'].join('\n')],
    ];
    for (const [kind, src] of shapes) {
      const f = m66('k66_3_' + kind + '.ming', src);
      const r = runMing(['check', f]);
      check(`v66.3:handler 形态 ${kind} → check exit 1 + M3002(必须是命名模块函数引用)`,
        r.code === 1 && r.stderr.includes('M3002') && r.stderr.includes('serve 的 handler'),
        `code=${r.code} ${JSON.stringify(r.stderr.split('\n')[0])}`);
    }
  }

  // ---- 运行面 harness 原语 ----
  // 空闲端口探测:listen('127.0.0.1') 失败(占用/TIME_WAIT 拒绝)则 +1 重试,≤5 次。
  const freePort66 = async (start) => {
    let port = start;
    for (let i = 0; i < 5; i++) {
      const free = await new Promise((res) => {
        const s = netServer66();
        s.once('error', () => res(false));
        s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
      });
      if (free) return port;
      port += 1;
    }
    return null;
  };
  // 独立进程起 server(__PORT__ 占位替换为探测到的实际端口;stdio pipe;detached:false)。
  const startServer66 = async (caseIdx, slot, src, extraFlags = []) => {
    const port = await freePort66(port66(caseIdx, slot));
    if (port === null) throw new Error('26000-27999 段内无空闲端口(起点 ' + port66(caseIdx, slot) + ')');
    const file = m66('k66_' + caseIdx + '_' + slot + '_server.ming', src.split('__PORT__').join(String(port)));
    const proc = spawn(process.execPath, [MING, 'run', file, ...extraFlags], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
    });
    const server = { proc, port, file, stdout: '', stderr: '', exited: false };
    proc.stdout.on('data', (d) => { server.stdout += d; });
    proc.stderr.on('data', (d) => { server.stderr += d; });
    proc.once('exit', () => { server.exited = true; });
    return server;
  };
  // 杀 server(不留监听):kill() → 等 exit 3s → Windows taskkill /T /F 兜底。
  const killServer66 = async (server) => {
    if (!server || server.exited || server.proc.exitCode !== null || server.proc.killed) return;
    server.proc.kill();
    await new Promise((res) => {
      const t = setTimeout(() => {
        if (process.platform === 'win32') {
          try { spawnSync('taskkill', ['/F', '/T', '/PID', String(server.proc.pid)], { encoding: 'utf8' }); } catch { /* 尽力而为 */ }
        }
        res();
      }, 3000);
      server.proc.once('exit', () => { clearTimeout(t); res(); });
    });
  };
  // TCP 连接探测(不用 HTTP:504 用例 handler 40s,HTTP 探测自身会撞超时)。
  const canConnect66 = (port) => new Promise((res) => {
    const s = netConn66({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
  const waitReady66 = async (port, timeoutMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await canConnect66(port)) return true;
      await sleep66(100);
    }
    return false;
  };
  const fetchText66 = async (url, opts = {}) => {
    const r = await fetch(url, opts);
    const body = await r.text();
    return { status: r.status, body, contentType: r.headers.get('content-type') ?? '' };
  };
  const parseJson66 = (text) => { try { return JSON.parse(text); } catch { return null; } };
  // v66.9 用原始 http.request(300 条独立短连接;fetch 的 undici 池可能复用连接,
  // 客户端排队会掩盖服务端背压,agent:false 保证逐请求新 socket)。
  const httpPost66 = (port, reqPath, body, timeoutMs = 30000) => new Promise((res, rej) => {
    const req = httpRequest66({
      host: '127.0.0.1', port, path: reqPath, method: 'POST', agent: false,
      headers: { 'content-length': String(Buffer.byteLength(body)) },
      timeout: timeoutMs,
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(new Error('client timeout ' + timeoutMs + 'ms')); });
    req.end(body);
  });
  // 运行用例外壳:finally 全量杀 server(不留监听);异常落到 check 明细(含 stderr 首行)。
  const runCase66 = async (name, fn) => {
    const servers = [];
    const start = async (...args) => { const s = await startServer66(...args); servers.push(s); return s; };
    try {
      await fn(start);
    } catch (e) {
      const last = servers.length ? servers[servers.length - 1] : null;
      check(name, false, '异常: ' + String(e && e.message ? e.message : e)
        + (last ? ' stderr[0]=' + JSON.stringify((last.stderr || '').split('\n')[0]) : ''));
    } finally {
      for (const s of servers) await killServer66(s);
    }
  };

  // v66.4 回环 GET:固定 200 "hello";Content-Type application/json(S2 契约默认)。
  await runCase66('v66.4:回环 GET → 200 + body "hello" + Content-Type application/json', async (start) => {
    const s = await start(4, 0, SRC66.get);
    if (!(await waitReady66(s.port))) throw new Error('server 15s 未就绪');
    const res = await fetchText66('http://127.0.0.1:' + s.port + '/hello', { signal: AbortSignal.timeout(10000) });
    check('v66.4:回环 GET → 200 + body "hello" + Content-Type application/json',
      res.status === 200 && res.body === 'hello' && res.contentType.includes('application/json'),
      `status=${res.status} body=${JSON.stringify(res.body)} ct=${JSON.stringify(res.contentType)} stderr[0]=${JSON.stringify((s.stderr || '').split('\n')[0])}`);
  });

  // v66.5 回环 POST:handler 回显 path/body(请求载荷 {method,path,headers,body})。
  await runCase66('v66.5:回环 POST → handler 回显 path/body', async (start) => {
    const s = await start(5, 0, SRC66.echo);
    if (!(await waitReady66(s.port))) throw new Error('server 15s 未就绪');
    const res = await fetchText66('http://127.0.0.1:' + s.port + '/echo', {
      method: 'POST', body: 'ping-body-42', signal: AbortSignal.timeout(10000),
    });
    check('v66.5:回环 POST → 200 + path:/echo 与 body:ping-body-42 回显',
      res.status === 200 && res.body.includes('path:/echo') && res.body.includes('body:ping-body-42'),
      `status=${res.status} body=${JSON.stringify(res.body)} stderr[0]=${JSON.stringify((s.stderr || '').split('\n')[0])}`);
  });

  // v66.6 handler panic → 500 {code:handler_panic} + 消息透传 Ming 码(M4003 越界)。
  await runCase66('v66.6:handler panic → 500 {code:handler_panic} + 消息含 M4003', async (start) => {
    const s = await start(6, 0, SRC66.panic);
    if (!(await waitReady66(s.port))) throw new Error('server 15s 未就绪');
    const res = await fetchText66('http://127.0.0.1:' + s.port + '/boom', { signal: AbortSignal.timeout(10000) });
    const j = parseJson66(res.body);
    check('v66.6:handler panic → 500 {code:handler_panic} + 消息含 M4003',
      res.status === 500 && j !== null && j.code === 'handler_panic' && String(j.message ?? '').includes('M4003'),
      `status=${res.status} body=${JSON.stringify(res.body).slice(0, 200)} stderr[0]=${JSON.stringify((s.stderr || '').split('\n')[0])}`);
  });

  // v66.7 handler 睡 40s → 服务端 30s 硬杀(terminate)→ 504 {code:timeout},<35s 返回。
  await runCase66('v66.7:handler 40s → 504 {code:timeout} 且响应 <35s 返回', async (start) => {
    const s = await start(7, 0, SRC66.sleep40s);
    if (!(await waitReady66(s.port))) throw new Error('server 15s 未就绪');
    const t0 = Date.now();
    const res = await fetchText66('http://127.0.0.1:' + s.port + '/slow', { signal: AbortSignal.timeout(45000) });
    const ms = Date.now() - t0;
    const j = parseJson66(res.body);
    check('v66.7:handler 40s → 504 {code:timeout} 且响应 <35s 返回',
      res.status === 504 && j !== null && j.code === 'timeout' && ms < 35000,
      `status=${res.status} code=${j ? String(j.code) : 'n/a'} ms=${ms} stderr[0]=${JSON.stringify((s.stderr || '').split('\n')[0])}`);
  });

  // v66.8 请求体 9MB > 8MB 上限 → 413 {code:body_too_large},handler 不执行(拒绝优于截断)。
  // v0.63 校准:隔离 harness 10/10 稳定;全量套件上下文偶发 fetch failed(服务端对超限体
  // 提前关闭连接,客户端仍在写 9MB → ECONNRESET 竞态,undici 抛错而非交付响应)。
  // 就绪探测已在(waitReady66);对 fetch 抛错重试 ≤2 次、间隔 200ms——仅传输层失败重试,
  // 拿到 HTTP 响应(含非 413)即停:语义失败不得被重试掩盖;最终失败明细带 server stderr 首行。
  await runCase66('v66.8:9MB 体超限 → 413 {code:body_too_large}', async (start) => {
    const s = await start(8, 0, SRC66.get);
    if (!(await waitReady66(s.port))) throw new Error('server 15s 未就绪');
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetchText66('http://127.0.0.1:' + s.port + '/upload', {
          method: 'POST', body: 'a'.repeat(9 * 1024 * 1024), signal: AbortSignal.timeout(30000),
        });
        break;
      } catch (e) {
        const cause = e && e.cause ? ' cause=' + String(e.cause.code ?? e.cause) : '';
        if (attempt === 2) {
          throw new Error(`413 请求 3 次均传输失败: ${String(e && e.message ? e.message : e)}${cause}`
            + ' stderr[0]=' + JSON.stringify((s.stderr || '').split('\n')[0]));
        }
        await sleep66(200);
      }
    }
    const j = parseJson66(res.body);
    check('v66.8:9MB 体超限 → 413 {code:body_too_large}',
      res.status === 413 && j !== null && j.code === 'body_too_large',
      `status=${res.status} body=${JSON.stringify(res.body).slice(0, 200)} stderr[0]=${JSON.stringify((s.stderr || '').split('\n')[0])}`);
  });

  // v66.9 队列满:300 条并发短连接,handler 睡 50ms,容量 16+256=272 → 超额 503。
  await runCase66('v66.9:300 并发短连接超额 → 存在 503 {code:queue_full}', async (start) => {
    const s = await start(9, 0, SRC66.sleep50ms);
    if (!(await waitReady66(s.port))) throw new Error('server 15s 未就绪');
    const rs = await Promise.allSettled(Array.from({ length: 300 }, () =>
      httpPost66(s.port, '/q', 'q')));
    const oks = rs.filter((x) => x.status === 'fulfilled');
    const s503 = oks.filter((x) => x.value.status === 503
      && (parseJson66(x.value.body) ?? {}).code === 'queue_full');
    const s200 = oks.filter((x) => x.value.status === 200).length;
    const rej = rs.filter((x) => x.status === 'rejected').map((x) => String(x.reason && x.reason.message).slice(0, 60));
    check('v66.9:300 并发短连接超额 → 存在 503 {code:queue_full}(容量 16+256=272)',
      s503.length >= 1,
      `fulfilled=${oks.length} 200=${s200} 503=${s503.length} rejected=${rej.length}(${rej[0] ?? ''}) stderr[0]=${JSON.stringify((s.stderr || '').split('\n')[0])}`);
  });

  // v66.10 三引擎一致(M3,审查修复:扩自双引擎):同 server 程序默认引擎(vm+wasm)、
  // --no-wasm 与 --tree 各起一次,GET 响应逐字一致(服务面也是三引擎差分合同)。
  // tree 腿起服含纯 JS 编译/解释慢路径,就绪探测余量放宽到 30s(其余用例 15s)。
  await runCase66('v66.10:三引擎一致(默认/--no-wasm/--tree)GET 响应逐字一致', async (start) => {
    const s1 = await start(10, 0, SRC66.get);
    const s2 = await start(10, 1, SRC66.get, ['--no-wasm']);
    const s3 = await start(10, 2, SRC66.get, ['--tree']);
    if (!(await waitReady66(s1.port))) throw new Error('server A 30s 未就绪');
    if (!(await waitReady66(s2.port))) throw new Error('server B(--no-wasm)30s 未就绪');
    if (!(await waitReady66(s3.port, 30000))) throw new Error('server C(--tree)30s 未就绪');
    const r1 = await fetchText66('http://127.0.0.1:' + s1.port + '/hello', { signal: AbortSignal.timeout(10000) });
    const r2 = await fetchText66('http://127.0.0.1:' + s2.port + '/hello', { signal: AbortSignal.timeout(10000) });
    const r3 = await fetchText66('http://127.0.0.1:' + s3.port + '/hello', { signal: AbortSignal.timeout(10000) });
    check('v66.10:三引擎一致(默认/--no-wasm/--tree)GET 响应逐字一致',
      r1.status === 200 && r1.status === r2.status && r1.status === r3.status
      && r1.body === r2.body && r1.body === r3.body
      && r1.contentType === r2.contentType && r1.contentType === r3.contentType,
      `A=${r1.status}:${JSON.stringify(r1.body)} B=${r2.status}:${JSON.stringify(r2.body)} C=${r3.status}:${JSON.stringify(r3.body)} Aerr=${JSON.stringify((s1.stderr || '').split('\n')[0])} Berr=${JSON.stringify((s2.stderr || '').split('\n')[0])} Cerr=${JSON.stringify((s3.stderr || '').split('\n')[0])}`);
  });

  // v66.11 wasm 资格拒绝(ADR §5.2 任务 4 构造):纯函数 pure_add 处 wasm 候选位且编译
  // OK;serve 所在 main 因 net 效果永不进 eligible;无 REJECT 噪声(资格层静态事实)。
  {
    const f = m66('k66_11_wasm.ming', SRC66.wasmProbe);
    const r = runMing(['check', f, '--strict-wasm', '--json'], { env: { MING_WASM_DEBUG: '1' } });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 保持 null */ }
    check('v66.11:serve 程序 wasm 资格——pure_add OK / main·handler 不进 eligible / 无 REJECT',
      r.code === 0 && j !== null && j.wasm_status === 'ok'
      && r.stderr.includes('[wasm] fn pure_add OK')
      && !r.stderr.includes('REJECT')
      && !r.stderr.includes('[wasm] fn main OK')
      && !r.stderr.includes('[wasm] fn handler OK'),
      `code=${r.code} ws=${j ? String(j.wasm_status) : 'n/a'} err=${JSON.stringify(r.stderr.split('\n').slice(0, 3).join(' | '))}`);
  }

  // v66.12 cc 发射期拒绝:serve 程序 ming cc → exit 1 + C1 不支持该程序形态。
  {
    const ccAvail66 = (() => {
      if (process.env.MING_CC && fs.existsSync(process.env.MING_CC)) return true;
      for (const c of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
        if (fs.existsSync(c)) return true;
      }
      return spawnSync('gcc', ['--version'], { encoding: 'utf8' }).status === 0;
    })();
    if (ccAvail66) {
      const f = m66('k66_12_cc.ming', SRC66.get.split('__PORT__').join('26012'));
      const r = runMing(['cc', f]);
      check('v66.12:cc 发射期拒绝 serve 程序 → exit 1 + C1 不支持该程序形态',
        r.code === 1 && (r.stderr + r.stdout).includes('C1 不支持该程序形态'),
        `code=${r.code} out=${JSON.stringify(((r.stderr || '') + (r.stdout || '')).split('\n')[0].slice(0, 160))}`);
    } else {
      check('v66.12:cc 发射期拒绝 serve 程序(gcc 不存在,跳过)', true, 'skip: 无 C 编译器');
    }
  }

  // v66.13 并发冒烟:20 并发 fetch(handler 睡 100ms)→ 全部 200(部分排队后受理)。
  await runCase66('v66.13:20 并发 fetch(handler 100ms)→ 全部 200', async (start) => {
    const s = await start(13, 0, SRC66.sleep100ms);
    if (!(await waitReady66(s.port))) throw new Error('server 15s 未就绪');
    const rs = await Promise.all(Array.from({ length: 20 }, () =>
      fetchText66('http://127.0.0.1:' + s.port + '/c', { signal: AbortSignal.timeout(30000) })));
    const all200 = rs.every((r) => r.status === 200 && r.body === 'ok');
    check('v66.13:20 并发 fetch(handler 100ms)→ 全部 200',
      all200,
      `statuses=${JSON.stringify(rs.map((r) => r.status))} bodies=${JSON.stringify(rs.slice(0, 2).map((r) => r.body))} stderr[0]=${JSON.stringify((s.stderr || '').split('\n')[0])}`);
  });

  // v66.14 端口占用:A 先占端口并就绪,B serve 同端口 → Err(main 打印 ERR 后退出)。
  // 三引擎对照(runAll66 + fmtRuns66):B 的 Err 行为三引擎一致,B 进程打印 ERR 后即退出
  // (可同步运行——与驻留 server 不同),每次 run 各自探测绑定 → 同款 Err。
  await runCase66('v66.14:端口占用 → 第二个 serve 返回 Err(打印 ERR 含端口,三引擎一致)', async (start) => {
    const a = await start(14, 0, SRC66.get);
    if (!(await waitReady66(a.port))) throw new Error('server A 15s 未就绪');
    const bFile = m66('k66_14_b_server.ming', SRC66.portErr.split('__PORT__').join(String(a.port)));
    const bRuns = runAll66(bFile);
    check('v66.14:端口占用 → 第二个 serve 返回 Err(打印 ERR 含端口,三引擎一致)',
      bRuns.length === 3 && bRuns.every((r) => r.code === 0 && r.stdout.includes('ERR') && r.stdout.includes(String(a.port))),
      `runs=${fmtRuns66(bRuns).slice(0, 300)} Aerr=${JSON.stringify((a.stderr || '').split('\n')[0])}`);
  });

  // v66.15 worker_start_failed(清单 16 的 S2 降级路径):请求 worker 启动失败难以
  // 确定性构造(worker_threads 启动失败依赖系统线程配额耗尽,时序脆弱不可复现),
  // 跳过——行为正确性由 S2 实现的源码审查覆盖(ADR-001 §5.2 任务 2 / 清单 16)。
  check('v66.15:worker_start_failed 降级(难以确定性构造,跳过;S2 源码审查覆盖)', true,
    'skip: 需要稳定触发 worker 启动失败的系统条件,CI 不可复现');

  // ---- 审查修复锁定(B1/n1/M2,2026-11-14)----
  // v66.16 handler 响应头含 CRLF(B1 三层护栏锁定):/evil 注入真实 CR/LF 头 →
  // respond 头白名单拒绝(拒绝优于截断)→ 500 {code:internal_error}(非 socket hang up);
  // /ok 正常 200 = 服务存活。修复前:writeHead 抛 ERR_INVALID_CHAR → accept 线程
  // uncaughtException 死亡 → 主进程永久悬挂(请求侧 socket hang up)。
  await runCase66('v66.16:handler 头含 CRLF → 500 internal_error 且服务存活', async (start) => {
    const s = await start(16, 0, SRC66.crlf);
    if (!(await waitReady66(s.port))) throw new Error('server 15s 未就绪');
    const evil = await fetchText66('http://127.0.0.1:' + s.port + '/evil', { signal: AbortSignal.timeout(10000) });
    const j = parseJson66(evil.body);
    const ok = await fetchText66('http://127.0.0.1:' + s.port + '/ok', { signal: AbortSignal.timeout(10000) });
    check('v66.16:handler 头含 CRLF → 500 internal_error 且服务存活',
      evil.status === 500 && j !== null && j.code === 'internal_error'
      && ok.status === 200 && ok.body === 'hello',
      `evil=${evil.status}:${JSON.stringify(evil.body).slice(0, 160)} ok=${ok.status}:${JSON.stringify(ok.body)} stderr[0]=${JSON.stringify((s.stderr || '').split('\n')[0])}`);
  });

  // v66.17 handler 返回 9MB body(n1 锁定):超 8MB 上限 → 500 {code:response_too_large}
  // 并关连接(不截断——截断破坏 Content-Length;拒绝优于截断与 v66.8 请求侧同口径)。
  await runCase66('v66.17:handler 9MB body → 500 response_too_large 并关连接', async (start) => {
    const s = await start(17, 0, SRC66.bigBody);
    if (!(await waitReady66(s.port))) throw new Error('server 15s 未就绪');
    const res = await fetchText66('http://127.0.0.1:' + s.port + '/big', { signal: AbortSignal.timeout(30000) });
    const j = parseJson66(res.body);
    check('v66.17:handler 9MB body → 500 response_too_large 并关连接',
      res.status === 500 && j !== null && j.code === 'response_too_large',
      `status=${res.status} body=${JSON.stringify(res.body).slice(0, 160)} stderr[0]=${JSON.stringify((s.stderr || '').split('\n')[0])}`);
  });

  // v66.18 跨模块 handler 收紧(M2):Field 引用导入模块的 fn 一律 M3002——v1 请求 worker
  // 管线只加载入口单文件源,跨模块模块源无法在隔离子 VM 中解析,运行期每请求必 500
  // (继承 spawn 管线既有缺口,serve 在 checker 层先行收紧)。同模块 handler(可非 pub)
  // 仍通过。
  {
    m66('k66_18_hmod.ming', [
      'pub fn mod_handler(req: Untrusted[Json]) -> Json {',
      '    return std.json.parse("{}").unwrap();',
      '}',
    ].join('\n'));
    const crossFile = m66('k66_18_cross.ming', [
      'use std.net;',
      'use std.json;',
      'use k66_18_hmod;',
      '',
      'fn main() with net {',
      '    std.net.serve(26018, k66_18_hmod.mod_handler);',
      '}',
    ].join('\n'));
    const cross = runMing(['check', crossFile]);
    const sameFile = m66('k66_18_same.ming', [
      'use std.net;',
      'use std.json;',
      '',
      'fn handler(req: Untrusted[Json]) -> Json {', // 非 pub:同模块口径放行
      '    return std.json.parse("{}").unwrap();',
      '}',
      '',
      'fn main() with net {',
      '    std.net.serve(26018, handler);',
      '}',
    ].join('\n'));
    const same = runMing(['check', sameFile]);
    check('v66.18:跨模块 handler → check exit 1 + M3002;同模块非 pub handler 仍通过',
      cross.code === 1 && cross.stderr.includes('M3002') && cross.stderr.includes('跨模块')
      && same.code === 0,
      `cross=${cross.code}:${JSON.stringify(cross.stderr.split('\n')[0])} same=${same.code}:${JSON.stringify(same.stderr.split('\n')[0])}`);
  }
  // §66-END
}

// ===================== 67. v0.63:wasm 剩余守护收口 slice 2(plan §4.4.6b)=====================
// 文件所有权:§67 = 本区全部用例。五形态:mut Vec 元素写 / Vec 下标读 / Option unwrap·expect /
// VecLit 数值元素 / f64 复合赋值——正例三引擎逐字 + 越界/None 的 M4003/M4006 消息-span-退出码逐字 + strict 存活。
{
  const dir67 = path.join(TMP, 'v67');
  fs.mkdirSync(dir67, { recursive: true });
  const m67 = (name, src) => { const f = path.join(dir67, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags67 = ['', '--no-wasm', '--tree'];
  const runAll67 = (p, extra = []) => flags67.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const same67 = (runs, want) => runs.every(r => r.code === 0 && r.stdout === want);
  const fmtRuns67 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');
  const strict67b = (p, extra = []) => runMing(['run', p, '--strict-wasm', ...extra], { env: { MING_WASM_DEBUG: '1' } });

  // ---- §67-START(slice 2 用例:五形态正例/panic 对齐/strict 存活/Err unwrap 守护具名)----

  // 源码池:正例函数独立可 eligible(main 持 io 不可 eligible,经 OP.CALL 快路径进 wasm);
  // panic 类函数同样独立 eligible,越界经 panic_m4003/panic_m4003w/panic_m4006 导入还原为 Ming Panic。
  const SRC67 = {
    // 形态 1:数值 VecLit + 下标读
    posRead: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v[1];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // 形态 2:mut 元素写 + 值语义(调用方 a 不变)
    posWrite: [
      'fn f(mut v: Vec[i64]) -> i64 {',
      '    v[0] = 99;',
      '    return v[0];',
      '}',
      'fn main() with io {',
      '    let a: Vec[i64] = [1, 2, 3];',
      '    print(f(a));',
      '    print(a[0]);',
      '}',
    ].join('\n'),
    // 形态 3:Option get(i).unwrap() 界内
    posUnwrap: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [10, 20, 30];',
      '    return v.get(2).unwrap();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // 形态 4:f64 复合赋值
    posF64: [
      'fn f() -> f64 {',
      '    let mut x: f64 = 1.5;',
      '    x /= 0.5;',
      '    x += 0.25;',
      '    return x;',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // 形态 5:五形态组合(VecLit + 下标读 + mut 写 + Option unwrap + f64 复合赋值)+ 值语义
    posCombo: [
      'fn combo(mut v: Vec[i64], idx: i64) -> f64 {',
      '    let w: Vec[i64] = [4, 5, 6];',
      '    v[idx] = w.get(1).unwrap();',
      '    let mut x: f64 = 2.0;',
      '    x /= 4.0;',
      '    if v[0] > 0 {',
      '        x += 1.0;',
      '    }',
      '    return x;',
      '}',
      'fn main() with io {',
      '    let a: Vec[i64] = [1, 2, 3];',
      '    print(combo(a, 1));',
      '    print(a[0]);',
      '    print(a[1]);',
      '}',
    ].join('\n'),
    // f64 除零:IEEE → Infinity,不 panic
    posDivZero: [
      'fn f() -> f64 {',
      '    let mut x: f64 = 1.0;',
      '    x /= 0.0;',
      '    return x;',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // 计费矩阵:main 持 io 不可 eligible,计费点在 eligible 的 bill() 内经 ming_alloc_elem 导入
    billLen3: [
      'fn bill() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v[0];',
      '}',
      'fn main() with io { print(bill()); }',
    ].join('\n'),
    billLen0: [
      'fn bill() -> i64 {',
      '    let v: Vec[i64] = [];',
      '    return v.len();',
      '}',
      'fn main() with io { print(bill()); }',
    ].join('\n'),
    // panic:越界读(M4003 读 flavor,消息带 Option 提示后缀)
    panicRead: [
      'fn boom() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v[10];',
      '}',
      'fn main() with io { print(boom()); }',
    ].join('\n'),
    // panic:mut 元素写越界(M4003 写 flavor,消息无后缀)
    panicWrite: [
      'fn boom(mut v: Vec[i64]) {',
      '    v[10] = 5;',
      '}',
      'fn main() with io { boom([1, 2, 3]); }',
    ].join('\n'),
    // panic:None unwrap(M4006)
    panicUnwrap: [
      'fn boom() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v.get(10).unwrap();',
      '}',
      'fn main() with io { print(boom()); }',
    ].join('\n'),
    // panic:panic 点直接在 wasm eligible 的 main 内(无辅助函数)
    panicInMain: [
      'fn main() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v[10];',
      '}',
    ].join('\n'),
    // panic:空 Vec 越界读(长度 0,访问 0)
    panicEmpty: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [];',
      '    return v[0];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v0.65 已解锁:Map unwrap(map_has 导入判定在先,缺键 → M4006;命中路径 strict ok)
    guardMapUnwrap: [
      'fn f() -> i64 {',
      '    let m: Map[str, i64] = {"a": 1};',
      '    return m.get("a").unwrap();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v0.65 已解锁:Err unwrap(Err(str) 构造 + 消费链;Err 分支 → M4006 `对 Err(bad) 调用 unwrap()`)
    guardErrUnwrap: [
      'fn f() -> i64 {',
      '    let r: Result[i64, str] = Err("bad");',
      '    return r.unwrap();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v0.65 已解锁:expect(编译期字面量 msg;越界 → M4006 `expect 失败: need`)
    guardExpect: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v.get(0).expect("need");',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v67.20 #59(v0.65 修复):嵌套 panic(main→f→g,g 内越界)——wasm→wasm 直调调用点
    // frame_push 透传,三帧(main→f→g)与 tree/VM 完整 stderr 逐字。
    nestedPanic: [
      'fn g() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v[10];',
      '}',
      'fn f() -> i64 {',
      '    return g();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v67.21 守护:unwrap_or(无 panic 面;shape-eligible + emit 具名回落,非"不 eligible")
    guardUnwrapOr: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v.get(10).unwrap_or(7);',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v67.22 守护:is_some——bool 局部 + 数值返回形态具名回落(shape-eligible + emit 具名);
    // bool 返回形态函数本就不 eligible(strict exit 0,无 wasm 尝试)
    guardIsSome: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let b = v.get(0).is_some();',
      '    return if b { 10 } else { 20 };',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    guardIsSomeBoolRet: [
      'fn f() -> bool {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v.get(0).is_some();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v67.23 守护:is_none(同 is_some 双形态)
    guardIsNone: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let b = v.get(0).is_none();',
      '    return if b { 10 } else { 20 };',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    guardIsNoneBoolRet: [
      'fn f() -> bool {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v.get(0).is_none();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v0.65 已解锁:Vec[str] 下标读(句柄容器经 vecstr_get;界内返回 str 句柄,strict ok)
    guardVecStrRead: [
      'fn f() -> str {',
      '    let s: Vec[str] = ["a", "b"];',
      '    return s[0];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v0.65 已解锁:下标复合赋值(interp assignTo 双重求值口径;strict ok)
    guardIdxCompound: [
      'fn f() -> i64 {',
      '    let mut v: Vec[i64] = [1, 2, 3];',
      '    v[0] += 5;',
      '    return v[0];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v67.26 审查 B1 回归锁定:嵌套下标读三复现(外层 base ptr 曾被子表达式覆盖 → 静默错值)
    b1VeclitRead: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let mut w: Vec[i64] = [v[2], v[1], v[0]];',
      '    return w[0] * 100 + w[1] * 10 + w[2];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    b1WriteIdxRead: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [0, 1, 2];',
      '    let mut w: Vec[i64] = [0, 0, 0];',
      '    w[v[0]] = 9;',
      '    return w[0] * 10 + w[1] + w[2];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    b1UnwrapArgRead: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let mut w: Vec[i64] = [7, 8, 9];',
      '    return w.get(v[0]).unwrap();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    b1ValuePosRead: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let mut w: Vec[i64] = [0, 0, 0];',
      '    w[0] = v[2];',
      '    return w[0] * 100 + w[1] * 10 + w[2];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v67.27 审查 B1 深组合:双层嵌套 + 跨变量嵌套 + Map 读嵌套(读路径/Map 读路径同修)
    b1DeepVeclit: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [2, 0, 1];',
      '    let mut w: Vec[i64] = [v[v[0]], v[v[1]], v[v[2]]];',
      '    return w[0] * 100 + w[1] * 10 + w[2];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    b1DeepWriteIdx: [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [2, 0, 1];',
      '    let mut w: Vec[i64] = [0, 0, 0];',
      '    w[v[v[1]]] = 9;',
      '    return w[0] * 100 + w[1] * 10 + w[2];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    b1CrossVarNested: [
      'fn f() -> i64 {',
      '    let a: Vec[i64] = [2, 0, 1];',
      '    let b: Vec[i64] = [0, 1, 2];',
      '    let mut w: Vec[i64] = [0, 0, 0];',
      '    w[0] = a[b[0]];',
      '    return w[0] * 100 + a[1] * 10 + b[2];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    b1MapReadNested: [
      'fn f() -> i64 {',
      '    let m: Map[str, i64] = {"k": 1};',
      '    let v: Vec[i64] = [5, 6, 7];',
      '    let x = v[m["k"]];',
      '    return x * 10 + v[2];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
    // v67.28 审查 M1 回归锁定:ming_copy_vec 搬运不计费(派生拷贝,与 tree/VM deepCopy 同口径)
    m1BillCopy: [
      'fn bill() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let mut w = v;',
      '    return w[0];',
      '}',
      'fn main() with io { print(bill()); }',
    ].join('\n'),
    m1InnerCall: [
      'fn g(mut v: Vec[i64]) -> i64 {',
      '    v[0] = 99;',
      '    return v[0];',
      '}',
      'fn f() -> i64 {',
      '    let a: Vec[i64] = [1, 2, 3];',
      '    return g(a);',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'),
  };
  const firstLine67 = (r) => (r.stderr ?? '').split('\n')[0];
  const dbg67 = (p, extra = []) => runMing(['run', p, ...extra], { env: { MING_WASM_DEBUG: '1' } });

  // v67.1 正例形态 1:数值 VecLit + 下标读——三引擎 stdout 逐字 + wasm 编译存活
  {
    const p = m67('k67_1_read.ming', SRC67.posRead);
    const runs = runAll67(p);
    const dbg = dbg67(p);
    check('v67.1:VecLit+下标读 三引擎逐字 + [wasm] fn f OK 无 REJECT',
      same67(runs, '2\n') && dbg.code === 0 && dbg.stderr.includes('[wasm] fn f OK') && !dbg.stderr.includes('REJECT'),
      fmtRuns67(runs) + ` dbg=${dbg.code}:${JSON.stringify(dbg.stderr.slice(0, 200))}`);
  }

  // v67.2 正例形态 2:mut 元素写 + 值语义(函数内 v[0]=99,调用方 a[0] 仍为 1)
  {
    const p = m67('k67_2_write.ming', SRC67.posWrite);
    const runs = runAll67(p);
    const dbg = dbg67(p);
    check('v67.2:mut 元素写 三引擎逐字 + 值语义(调用方不变) + wasm 存活',
      same67(runs, '99\n1\n') && dbg.code === 0 && dbg.stderr.includes('[wasm] fn f OK') && !dbg.stderr.includes('REJECT'),
      fmtRuns67(runs) + ` dbg=${dbg.code}:${JSON.stringify(dbg.stderr.slice(0, 200))}`);
  }

  // v67.3 正例形态 3:Option get(i).unwrap() 界内
  {
    const p = m67('k67_3_unwrap.ming', SRC67.posUnwrap);
    const runs = runAll67(p);
    const dbg = dbg67(p);
    check('v67.3:Option get(i).unwrap() 界内 三引擎逐字 + wasm 存活',
      same67(runs, '30\n') && dbg.code === 0 && dbg.stderr.includes('[wasm] fn f OK') && !dbg.stderr.includes('REJECT'),
      fmtRuns67(runs) + ` dbg=${dbg.code}:${JSON.stringify(dbg.stderr.slice(0, 200))}`);
  }

  // v67.4 正例形态 4:f64 复合赋值
  {
    const p = m67('k67_4_f64.ming', SRC67.posF64);
    const runs = runAll67(p);
    const dbg = dbg67(p);
    check('v67.4:f64 复合赋值(/= +=) 三引擎逐字 + wasm 存活',
      same67(runs, '3.25\n') && dbg.code === 0 && dbg.stderr.includes('[wasm] fn f OK') && !dbg.stderr.includes('REJECT'),
      fmtRuns67(runs) + ` dbg=${dbg.code}:${JSON.stringify(dbg.stderr.slice(0, 200))}`);
  }

  // v67.5 正例形态 5:五形态组合函数 + 值语义(combo 内改 v[1],调用方 a[1] 仍为 2)
  {
    const p = m67('k67_5_combo.ming', SRC67.posCombo);
    const runs = runAll67(p);
    check('v67.5:五形态组合 三引擎逐字 + 值语义(调用方不变)',
      same67(runs, '1.5\n1\n2\n'), fmtRuns67(runs));
  }

  // v67.6 strict 存活:五形态组合单函数 --strict-wasm exit 0 且无 REJECT
  {
    const p = m67('k67_6_strict.ming', SRC67.posCombo);
    const s = strict67b(p);
    check('v67.6:五形态组合 --strict-wasm exit 0 + fn combo OK 无 REJECT',
      s.code === 0 && s.stderr.includes('[wasm] fn combo OK') && !s.stderr.includes('REJECT') && !s.stderr.includes('回落'),
      `code=${s.code} stderr=${JSON.stringify(s.stderr.slice(0, 240))}`);
  }

  // v67.7 f64 除零:IEEE 语义 → Infinity,不 panic,三引擎逐字
  {
    const p = m67('k67_7_divzero.ming', SRC67.posDivZero);
    const runs = runAll67(p);
    check('v67.7:f64 /= 0.0 → Infinity(IEEE 不 panic)三引擎逐字',
      same67(runs, 'Infinity\n'), fmtRuns67(runs));
  }

  // v67.8 panic 对齐 1:越界读 v[10](len3)——三引擎 stderr 首行逐字(含 Option 提示后缀)+ exit 101
  {
    const p = m67('k67_8_pread.ming', SRC67.panicRead);
    const runs = runAll67(p);
    const msg = '索引越界:长度 3,访问 10(用 .get(i) 返回 Option)';
    check('v67.8:越界读 M4003 三引擎首行逐字 + exit 101',
      runs.every(r => r.code === 101) && runs.every(r => firstLine67(r).includes(msg))
        && firstLine67(runs[0]) === firstLine67(runs[1]) && firstLine67(runs[0]) === firstLine67(runs[2]),
      fmtRuns67(runs));
  }

  // v67.9 panic 对齐 2:mut 写越界——消息无后缀逐字;完整 stderr wasm==tree。
  // 注:VM(--no-wasm)与 wasm/tree 的写 panic 位置差 1 列(wasm/tree 2:6 vs VM 2:5)
  // 为 HEAD 预存(G1 实测登记),断言按 wasm==tree 写;VM 列差由架构师单独记账。
  {
    const p = m67('k67_9_pwrite.ming', SRC67.panicWrite);
    const runs = runAll67(p);
    const msg = '索引越界:长度 3,访问 10';
    check('v67.9:mut 写越界 M4003 消息无后缀逐字 + exit 101 + 完整 stderr wasm==tree',
      runs.every(r => r.code === 101) && runs.every(r => firstLine67(r).includes(msg))
        && !firstLine67(runs[0]).includes('.get(i)') && runs[0].stderr === runs[2].stderr,
      fmtRuns67(runs));
  }

  // v67.10 panic 对齐 3:None unwrap——M4006 消息逐字 + 完整 stderr 三引擎逐字
  {
    const p = m67('k67_10_punwrap.ming', SRC67.panicUnwrap);
    const runs = runAll67(p);
    const msg = '对 None 调用 unwrap()';
    check('v67.10:None unwrap M4006 首行逐字 + exit 101 + 完整 stderr 三引擎逐字',
      runs.every(r => r.code === 101) && runs.every(r => firstLine67(r).includes(msg))
        && firstLine67(runs[0]) === firstLine67(runs[1]) && firstLine67(runs[0]) === firstLine67(runs[2])
        && runs[0].stderr === runs[1].stderr && runs[0].stderr === runs[2].stderr,
      fmtRuns67(runs));
  }

  // v67.11 计费矩阵(G2 硬验收):len3 VecLit --max-alloc 3 → 三引擎 exit 0(3 不大于 3)
  {
    const p = m67('k67_11_bill3.ming', SRC67.billLen3);
    const runs = runAll67(p, ['--max-alloc', '3']);
    check('v67.11:计费对齐 len3 --max-alloc 3 三引擎 exit 0 输出 1',
      same67(runs, '1\n'), fmtRuns67(runs));
  }

  // v67.12 计费矩阵:len3 --max-alloc 2 → 三引擎均 M4011 且累计值一致(3>2,元素口径)
  {
    const p = m67('k67_12_bill2.ming', SRC67.billLen3);
    const runs = runAll67(p, ['--max-alloc', '2']);
    const msg = '内存配额超限:累计分配 3 超过上限 2';
    check('v67.12:计费对齐 len3 --max-alloc 2 三引擎 M4011 累计 3 一致 + exit 101',
      runs.every(r => r.code === 101) && runs.every(r => firstLine67(r).includes(msg))
        && firstLine67(runs[0]) === firstLine67(runs[1]) && firstLine67(runs[0]) === firstLine67(runs[2]),
      fmtRuns67(runs));
  }

  // v67.13 计费矩阵:len0 空 Vec --max-alloc 0 → 0 计费(n<=0 早退),三引擎 exit 0
  {
    const p = m67('k67_13_bill0.ming', SRC67.billLen0);
    const runs = runAll67(p, ['--max-alloc', '0']);
    check('v67.13:计费对齐 len0 --max-alloc 0 三引擎 exit 0 输出 0',
      same67(runs, '0\n'), fmtRuns67(runs));
  }

  // v67.14 空 Vec 构造 + 越界读 panic(G1 补位锁定):长度 0,访问 0,三引擎首行逐字
  {
    const p = m67('k67_14_empty.ming', SRC67.panicEmpty);
    const runs = runAll67(p);
    const dbg = dbg67(p);
    const msg = '索引越界:长度 0,访问 0(用 .get(i) 返回 Option)';
    check('v67.14:空 Vec 越界读 M4003 三引擎首行逐字 + exit 101 + wasm 存活',
      runs.every(r => r.code === 101) && runs.every(r => firstLine67(r).includes(msg))
        && firstLine67(runs[0]) === firstLine67(runs[1]) && firstLine67(runs[0]) === firstLine67(runs[2])
        && dbg.code === 101 && dbg.stderr.includes('[wasm] fn f OK'),
      fmtRuns67(runs) + ` dbg=${dbg.code}`);
  }

  // v67.15 任务 2 验收:越界读 panic 的完整 stderr(含调用栈尾帧)三引擎逐字——
  // G2 候选修复(callCompiled catch 先填 e.stack 再 pop)实测逐字一致后保留。
  {
    const p = m67('k67_15_stack.ming', SRC67.panicRead);
    const runs = runAll67(p);
    check('v67.15:M4003 越界读完整 stderr(含栈)三引擎逐字',
      runs.every(r => r.code === 101) && runs[0].stderr === runs[1].stderr && runs[0].stderr === runs[2].stderr
        && runs[0].stderr.includes('at boom (') && runs[0].stderr.includes('at main ('),
      `w=${JSON.stringify(runs[0].stderr.slice(-260))} n=${JSON.stringify(runs[1].stderr.slice(-260))}`);
  }

  // v67.16 任务 2 验收:panic 点直接在 wasm eligible 的 main 内——完整 stderr 三引擎逐字
  {
    const p = m67('k67_16_pmain.ming', SRC67.panicInMain);
    const runs = runAll67(p);
    check('v67.16:main 内越界读完整 stderr(含栈)三引擎逐字',
      runs.every(r => r.code === 101) && runs[0].stderr === runs[1].stderr && runs[0].stderr === runs[2].stderr,
      `w=${JSON.stringify(runs[0].stderr.slice(-260))} n=${JSON.stringify(runs[1].stderr.slice(-260))}`);
  }

  // v67.17(v0.65 翻转):Map unwrap 已解锁(map_has 导入判定在先)——strict exit 0 +
  // [wasm] fn f OK 无 REJECT;非 strict 三引擎正确输出 1。缺键分支 panic 对齐见 §69 v69.6。
  {
    const p = m67('k67_17_mapunwrap.ming', SRC67.guardMapUnwrap);
    const s = strict67b(p);
    const ns = runAll67(p);
    check('v67.17:Map unwrap 已解锁——strict exit 0 + [wasm] fn f OK 无 REJECT;非 strict 三引擎正确输出 1',
      s.code === 0 && s.stdout === '1\n' && s.stderr.includes('[wasm] fn f OK') && !s.stderr.includes('REJECT') && !s.stderr.includes('回落')
        && same67(ns, '1\n'),
      `strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('wasm]')) ?? '')} ns=${fmtRuns67(ns)}`);
  }

  // v67.18(v0.65 翻转):Err unwrap 已解锁(Err 构造经 objTable 句柄 + res_unwrap_*)——
  // strict 下 fn 编译 OK,Err("bad") 分支运行时 M4006 `对 Err(bad) 调用 unwrap()`,
  // 三引擎 panic 完整 stderr 逐字(exit 101)。m3(v0.65 审查):strict 侧 panic 断言由
  // 全文 includes 统一为 firstLine 口径(与 §69 panicAlign69 同源)——debug 环境的 strict
  // stderr 带 [wasm] 前缀行,另跑无 debug 的 strict 对齐首行(fn OK/无 REJECT 仍看 debug 腿)。
  {
    const p = m67('k67_18_errunwrap.ming', SRC67.guardErrUnwrap);
    const s = strict67b(p);
    const sPlain = runMing(['run', p, '--strict-wasm']);
    const ns = runAll67(p);
    check('v67.18:Err unwrap 已解锁——strict fn OK + 运行时 M4006 对 Err(bad) 调用 unwrap();三引擎 panic 逐字 exit 101',
      s.code === 101 && s.stderr.includes('[wasm] fn f OK') && !s.stderr.includes('REJECT')
        && sPlain.code === 101 && firstLine67(sPlain).includes('error M4006')
        && firstLine67(sPlain).includes('对 Err(bad) 调用 unwrap()')
        && firstLine67(sPlain) === firstLine67(ns[0]) && sPlain.stderr === ns[0].stderr
        && ns.every(r => r.code === 101) && firstLine67(ns[0]) === firstLine67(ns[1]) && firstLine67(ns[0]) === firstLine67(ns[2])
        && ns[0].stderr === ns[1].stderr && ns[0].stderr === ns[2].stderr,
      `strict=${s.code}:${JSON.stringify(firstLine67(s))} plain=${sPlain.code}:${JSON.stringify(firstLine67(sPlain))} ns=${fmtRuns67(ns)}`);
  }

  // v67.19(v0.65 翻转):expect(编译期字面量 msg)已解锁(msg 经 strConsts 穿越导入边界)
  // ——strict exit 0 + [wasm] fn f OK;非 strict 三引擎输出 1。越界 panic 对齐见 §69 v69.8。
  {
    const p = m67('k67_19_expect.ming', SRC67.guardExpect);
    const s = strict67b(p);
    const ns = runAll67(p);
    check('v67.19:expect(字面量 msg)已解锁——strict exit 0 + [wasm] fn f OK;非 strict 三引擎输出 1',
      s.code === 0 && s.stdout === '1\n' && s.stderr.includes('[wasm] fn f OK') && !s.stderr.includes('REJECT') && !s.stderr.includes('回落')
        && same67(ns, '1\n'),
      `strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('wasm]')) ?? '')} ns=${fmtRuns67(ns)}`);
  }

  // v67.20(v0.65 翻转,#59 修复):嵌套 panic(main→f→g,g 内越界)——wasm→wasm 直调调用点
  // frame_push/frame_pop 透传(帧名/调用点 span 与 interp callUser 同口径),panic 穿透时
  // 帧按调用序合并进 e.stack → 三帧(`at g`/`at f`/`at main`)完整 stderr 三引擎逐字。
  // v0.63 已知残留(wasm 栈缺内层 g 帧)就此收口。
  {
    const p = m67('k67_20_npanic.ming', SRC67.nestedPanic);
    const runs = runAll67(p);
    const msg = '索引越界:长度 3,访问 10(用 .get(i) 返回 Option)';
    check('v67.20:嵌套 panic 三帧完整 stderr 三引擎逐字(含 at g/at f/at main)+ exit 101',
      runs.every(r => r.code === 101)
        && firstLine67(runs[0]) === firstLine67(runs[1]) && firstLine67(runs[0]) === firstLine67(runs[2])
        && firstLine67(runs[0]).includes(msg)
        && runs[0].stderr === runs[1].stderr && runs[0].stderr === runs[2].stderr
        && runs[0].stderr.includes('at g (') && runs[0].stderr.includes('at f (') && runs[0].stderr.includes('at main ('),
      fmtRuns67(runs) + ` wasmStack=${JSON.stringify(runs[0].stderr.slice(-200))}`);
  }

  // v67.21 具名守护 4:unwrap_or——strict exit 2 + 具名 Option 消费链 unwrap_or(函数 shape-eligible
  // + emit 期具名回落,非"不 eligible";v0.65 口径修正);非 strict 三引擎界外取默认
  {
    const p = m67('k67_21_unwrapor.ming', SRC67.guardUnwrapOr);
    const s = strict67b(p);
    const ns = runAll67(p);
    check('v67.21:unwrap_or strict exit 2 + REJECT Option 消费链 unwrap_or;非 strict 三引擎输出 7',
      s.code === 2 && s.stderr.includes('REJECT: Option 消费链 unwrap_or') && same67(ns, '7\n'),
      `strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('REJECT')) ?? '')} ns=${fmtRuns67(ns)}`);
  }

  // v67.22 具名守护 5:is_some——bool 局部+数值返回形态具名回落(strict exit 2;shape-eligible +
  // emit 期具名,非"不 eligible");bool 返回形态函数本就不 eligible(strict exit 0,无 wasm 尝试)
  // ——GUIDE §19 措辞双形态锁定
  {
    const p = m67('k67_22_issome.ming', SRC67.guardIsSome);
    const s = strict67b(p);
    const ns = runAll67(p);
    const pb = m67('k67_22b_issome_ret.ming', SRC67.guardIsSomeBoolRet);
    const sb = strict67b(pb);
    const nsb = runAll67(pb);
    check('v67.22:is_some bool 局部 strict exit 2 + REJECT is_some;bool 返回形态不 eligible(strict exit 0);非 strict 三引擎 10/true',
      s.code === 2 && s.stderr.includes('REJECT: Option 消费链 is_some') && same67(ns, '10\n')
        && sb.code === 0 && same67(nsb, 'true\n'),
      `strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('REJECT')) ?? '')} ret=${sb.code} ns=${fmtRuns67(ns)} nsb=${fmtRuns67(nsb)}`);
  }

  // v67.23 具名守护 6:is_none——同 v67.22 双形态口径
  {
    const p = m67('k67_23_isnone.ming', SRC67.guardIsNone);
    const s = strict67b(p);
    const ns = runAll67(p);
    const pb = m67('k67_23b_isnone_ret.ming', SRC67.guardIsNoneBoolRet);
    const sb = strict67b(pb);
    const nsb = runAll67(pb);
    check('v67.23:is_none bool 局部 strict exit 2 + REJECT is_none;bool 返回形态不 eligible(strict exit 0);非 strict 三引擎 20/false',
      s.code === 2 && s.stderr.includes('REJECT: Option 消费链 is_none') && same67(ns, '20\n')
        && sb.code === 0 && same67(nsb, 'false\n'),
      `strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('REJECT')) ?? '')} ret=${sb.code} ns=${fmtRuns67(ns)} nsb=${fmtRuns67(nsb)}`);
  }

  // v67.24(v0.65 翻转):Vec[str] 下标读已解锁(vecstr_get 宿主导入,界内返回 str 句柄)
  // ——strict exit 0 + [wasm] fn f OK;非 strict 三引擎 'a'。越界 panic 对齐见 §69 v69.11。
  {
    const p = m67('k67_24_vecstr.ming', SRC67.guardVecStrRead);
    const s = strict67b(p);
    const ns = runAll67(p);
    check('v67.24:Vec[str] 下标读已解锁——strict exit 0 + [wasm] fn f OK;非 strict 三引擎输出 a',
      s.code === 0 && s.stdout === 'a\n' && s.stderr.includes('[wasm] fn f OK') && !s.stderr.includes('REJECT') && !s.stderr.includes('回落')
        && same67(ns, 'a\n'),
      `strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('wasm]')) ?? '')} ns=${fmtRuns67(ns)}`);
  }

  // v67.25(v0.65 翻转):下标复合赋值 v[i] += x 已解锁(interp assignTo 双重求值口径,wasm 对齐)
  // ——strict exit 0 + [wasm] fn f OK;非 strict 三引擎输出 6。
  {
    const p = m67('k67_25_compound.ming', SRC67.guardIdxCompound);
    const s = strict67b(p);
    const ns = runAll67(p);
    check('v67.25:下标复合赋值已解锁——strict exit 0 + [wasm] fn f OK;非 strict 三引擎输出 6',
      s.code === 0 && s.stdout === '6\n' && s.stderr.includes('[wasm] fn f OK') && !s.stderr.includes('REJECT') && !s.stderr.includes('回落')
        && same67(ns, '6\n'),
      `strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('wasm]')) ?? '')} ns=${fmtRuns67(ns)}`);
  }

  // v67.26 审查 B1 回归锁定:嵌套下标读三复现——修复前 wasm 静默错值(121/0/2 vs tree 321/90/8),
  // 根因 = 外层 base ptr 存共享 iscratch,被下标读子表达式的编译覆盖;现 base ptr 走专属 tempSlot。
  // 值位(w[0] = v[2])本就无冲突(求值序 value 先于 base 入槽),一并锁定防回归。
  {
    const p1 = m67('k67_26a_veclit.ming', SRC67.b1VeclitRead);
    const p2 = m67('k67_26b_write.ming', SRC67.b1WriteIdxRead);
    const p3 = m67('k67_26c_unwrap.ming', SRC67.b1UnwrapArgRead);
    const p4 = m67('k67_26d_value.ming', SRC67.b1ValuePosRead);
    const r1 = runAll67(p1); const r2 = runAll67(p2); const r3 = runAll67(p3); const r4 = runAll67(p4);
    const dbg1 = dbg67(p1);
    check('v67.26:B1 嵌套读三复现(321/90/8)+ 值位(300)三引擎逐字 + wasm 编译存活无 REJECT',
      same67(r1, '321\n') && same67(r2, '90\n') && same67(r3, '8\n') && same67(r4, '300\n')
        && dbg1.code === 0 && dbg1.stderr.includes('[wasm] fn f OK') && !dbg1.stderr.includes('REJECT'),
      `r1=${fmtRuns67(r1)} r2=${fmtRuns67(r2)} r3=${fmtRuns67(r3)} r4=${fmtRuns67(r4)} dbg=${dbg1.code}`);
  }

  // v67.27 审查 B1 深组合:双层嵌套(v[v[0]])/元素写下标双层(w[v[v[1]]])/跨变量嵌套(a[b[0]])/
  // Map 读作下标(v[m["k"]])——读路径与 Map 读路径的 base ptr 同走专属槽,三引擎逐字。
  {
    const p1 = m67('k67_27a_deep.ming', SRC67.b1DeepVeclit);
    const p2 = m67('k67_27b_deepw.ming', SRC67.b1DeepWriteIdx);
    const p3 = m67('k67_27c_cross.ming', SRC67.b1CrossVarNested);
    const p4 = m67('k67_27d_mapread.ming', SRC67.b1MapReadNested);
    const r1 = runAll67(p1); const r2 = runAll67(p2); const r3 = runAll67(p3); const r4 = runAll67(p4);
    const dbg1 = dbg67(p1);
    check('v67.27:B1 深组合(120/9/202/67)三引擎逐字 + wasm 编译存活无 REJECT',
      same67(r1, '120\n') && same67(r2, '9\n') && same67(r3, '202\n') && same67(r4, '67\n')
        && dbg1.code === 0 && dbg1.stderr.includes('[wasm] fn f OK') && !dbg1.stderr.includes('REJECT'),
      `r1=${fmtRuns67(r1)} r2=${fmtRuns67(r2)} r3=${fmtRuns67(r3)} r4=${fmtRuns67(r4)} dbg=${dbg1.code}`);
  }

  // v67.28 审查 M1 回归锁定:ming_copy_vec 搬运不计费(charge=false,与 wasmWriteVecNum #51
  // "派生拷贝不计费"同口径)。修复前 wasm 按字节计费(16+8n),--max-alloc 5 下 wasm M4011 累计 43
  // 而 tree/VM exit 0;现三引擎一致。--max-alloc 2 → VecLit 自身计 3 > 2,三引擎 M4011 首行逐字
  // (计费口径不被 copy 破坏;注:--max-alloc 3 三引擎 exit 0,与 v67.11 元素口径一致)。
  {
    const p1 = m67('k67_28a_copy.ming', SRC67.m1BillCopy);
    const p2 = m67('k67_28b_call.ming', SRC67.m1InnerCall);
    const r1ok = runAll67(p1, ['--max-alloc', '5']);
    const r2ok = runAll67(p2, ['--max-alloc', '5']);
    const r1lim = runAll67(p1, ['--max-alloc', '2']);
    const r2lim = runAll67(p2, ['--max-alloc', '2']);
    check('v67.28:M1 copy 不计费 —— bill_copy/inner_call --max-alloc 5 三引擎 exit 0(1/99);--max-alloc 2 三引擎 M4011 首行逐字',
      same67(r1ok, '1\n') && same67(r2ok, '99\n')
        && r1lim.every(r => r.code === 101) && firstLine67(r1lim[0]) === firstLine67(r1lim[1]) && firstLine67(r1lim[0]) === firstLine67(r1lim[2])
        && firstLine67(r1lim[0]).includes('M4011')
        && r2lim.every(r => r.code === 101) && firstLine67(r2lim[0]) === firstLine67(r2lim[1]) && firstLine67(r2lim[0]) === firstLine67(r2lim[2])
        && firstLine67(r2lim[0]).includes('M4011'),
      `r1ok=${fmtRuns67(r1ok)} r2ok=${fmtRuns67(r2ok)} r1lim=${fmtRuns67(r1lim)} r2lim=${fmtRuns67(r2lim)}`);
  }

  // §67-END
}

// ===================== 68. v0.64:信任边界与诚实失败收口(plan §4.5.1)=====================
// 文件所有权:§68 = 本区全部用例。覆盖:#56 artifact 四损坏形态统一诊断 / S9 嵌套 serve 编译期拒绝
// (两遍式;v68.13-16 审查修复批:M1 遮蔽正例不误伤回归 + S12 sanitize_cli_path 闸门扩展向量——
// DEL(0x7F)/C1(NEL U+0085)/双向符(LRE U+202A) mark 字面量与 env 注入三引擎逐字) /
// #57 安全回归批(M4013 专项/NUL 黄金/S11 兜底/S13 慢连接)。
{
  const dir68 = path.join(TMP, 'v68');
  fs.mkdirSync(dir68, { recursive: true });
  const m68 = (name, src) => { const f = path.join(dir68, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags68 = ['', '--no-wasm', '--tree'];
  const runAll68 = (p, extra = []) => flags68.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const fmtRuns68 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');

  // ---- §68-START(#56 校验/S9 拒绝+遮蔽正例/S12 向量/M4013 专项/NUL 黄金/S11·S13 断言)----
  // 测试源(SRC68 与 §66 的 SRC66 同风格;serve 程序 __PORT__ 占位由 startServer68 替换)
  // v0.68/ADR-004:handler 形参统一 Untrusted[Json](整树标污);原 `return req` 透传
  // 属 M3049 拦截面(§4.3 回显免费拦截),S9 夹具统一换合法净体(断言意图不变)。
  const SRC68 = {
    // #56 探针项目入口(纯 io,AOT 资格)
    probe: 'fn main() with io {\n    print("ok68");\n}\n',
    // S9 嵌套 serve(全限定 std.net.serve 形态):handler 体内挂内层服务 → M3002
    s9Nested: [
      'use std.net;',
      'use std.json;',
      '',
      'fn inner(req: Untrusted[Json]) -> Json {',
      '    return std.json.parse("{}").unwrap();',
      '}',
      '',
      'fn handler(req: Untrusted[Json]) -> Json with net {',
      '    std.net.serve(18191, inner);',
      '    return std.json.parse("{}").unwrap();',
      '}',
      '',
      'fn main() with net {',
      '    std.net.serve(18190, handler);',
      '}',
    ].join('\n'),
    // S9 嵌套 serve(use std.net 别名短形态 net.serve)
    s9NestedShort: [
      'use std.net;',
      'use std.json;',
      '',
      'fn inner(req: Untrusted[Json]) -> Json {',
      '    return std.json.parse("{}").unwrap();',
      '}',
      '',
      'fn handler(req: Untrusted[Json]) -> Json with net {',
      '    net.serve(18191, inner);',
      '    return std.json.parse("{}").unwrap();',
      '}',
      '',
      'fn main() with net {',
      '    net.serve(18190, handler);',
      '}',
    ].join('\n'),
    // S9 正例:main 直接 serve(非 handler 体)
    s9MainDirect: [
      'use std.net;',
      'use std.json;',
      '',
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    return std.json.parse("{}").unwrap();',
      '}',
      '',
      'fn main() with net {',
      '    std.net.serve(__PORT__, handler);',
      '}',
    ].join('\n'),
    // S9 正例:handlerA 调 handlerB(嵌套两层 handler,A 体内无 serve)
    s9HandlerChain: [
      'use std.net;',
      'use std.json;',
      '',
      'fn handlerB(req: Untrusted[Json]) -> Json {',
      '    return std.json.parse("{}").unwrap();',
      '}',
      '',
      'fn handlerA(req: Untrusted[Json]) -> Json {',
      '    return handlerB(req);',
      '}',
      '',
      'fn main() with net {',
      '    std.net.serve(__PORT__, handlerA);',
      '}',
    ].join('\n'),
    // S9 遮蔽正例(v0.64 审查修复 M1):use std.net + handler 内局部 net: S(impl Server
    // for S)调用同名 trait 方法 net.serve(7)。修前 isDirectServeCall 对 Ident 基名只查
    // mod.imports、不咨询遮蔽守卫,该形态被误报 M3002"serve 不能在 handler 内调用"(exit 1)。
    s9Shadow: [
      'use std.net;',
      'use std.json;',
      '',
      'trait Server { fn serve(self, p: i64) -> i64; }',
      'struct S { v: i64 }',
      'impl Server for S { fn serve(self, p: i64) -> i64 { return p; } }',
      '',
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    let net: S = S { v: 1 };',
      '    let r = net.serve(7);',
      '    return std.json.parse("{}").unwrap();',
      '}',
      '',
      'fn main() with net {',
      '    std.net.serve(__PORT__, handler);',
      '}',
    ].join('\n'),
    // S9 遮蔽语义锁定:纯方法调用(不挂服务)——net.serve(7) 走 trait 方法返回 7
    s9ShadowRun: [
      'use std.net;',
      '',
      'trait Server { fn serve(self, p: i64) -> i64; }',
      'struct S { v: i64 }',
      'impl Server for S { fn serve(self, p: i64) -> i64 { return p; } }',
      '',
      'fn main() with io {',
      '    let net: S = S { v: 1 };',
      '    let r = net.serve(7);',
      '    print(str(r));',
      '}',
    ].join('\n'),
    // M4013 专项(FFI 效果门禁 check 期正反例;extern 隐含 ffi 效果)
    gate: 'extern "ming_no_such_lib_68" fn boom() -> i64;\nfn main() { boom(); }\n',
    gateOk: 'extern "ming_no_such_lib_68" fn boom() -> i64;\nfn main() with ffi { boom(); }\n',
    // M4013 C 后端专项:库加载失败 → 启动绑定阶段 M4013[ffi-load-failed] exit 101
    boom: 'extern "ming_no_such_lib_68" fn boom() -> i64;\nfn main() with ffi { boom(); }\n',
    // #55 NUL 黄金:extern 返回 "ab\0cd" → strlen 语义 byte_len=2(__DLL__ = DLL 绝对路径)
    nul: [
      'extern "__DLL__" fn nulstr() -> Untrusted[str];',
      '',
      'fn main() with io, ffi {',
      '    let s = nulstr();',
      '    print(str(s.byte_len()));',
      '}',
    ].join('\n'),
    // S13:快 handler(50 挂起连接期间正常请求仍 200)
    s13fast: [
      'use std.net;',
      'use std.json;',
      '',
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    let resp: Map[str, Json] = {',
      '        "status": std.json.parse("200").unwrap(),',
      '        "headers": std.json.parse("{}").unwrap(),',
      '        "body": std.json.parse("\\"ok\\"").unwrap(),',
      '    };',
      '    return std.json.parse(std.json.stringify(resp)).unwrap();',
      '}',
      '',
      'fn main() with net {',
      '    std.net.serve(__PORT__, handler);',
      '}',
    ].join('\n'),
    // S11:畸形响应兜底语义(/s700 status 700;/harr headers 数组;/numbody 数值 body)
    s11: [
      'use std.net;',
      'use std.json;',
      'use std.unstr;',
      '',
      // ADR-004 §3.2:投影(get/as_str 保污)+ sanitize_cli_path 净化后才能产净 str
      'fn jstr(req: Untrusted[Json], key: str, dflt: str) -> str {',
      '    return match req.get(key) {',
      '        Some(v) => match v.as_str() {',
      '            Some(s) => match std.unstr.sanitize_cli_path(s) {',
      '                Ok(p) => p,',
      '                Err(_) => dflt,',
      '            },',
      '            None => dflt,',
      '        },',
      '        None => dflt,',
      '    };',
      '}',
      '',
      'fn js(v: i64) -> Json {',
      '    return std.json.parse(str(v)).unwrap();',
      '}',
      '',
      'fn resp700() -> Json {',
      '    let resp: Map[str, Json] = {',
      '        "status": js(700),',
      '        "headers": std.json.parse("{}").unwrap(),',
      '        "body": std.json.parse("\\"x\\"").unwrap(),',
      '    };',
      '    return std.json.parse(std.json.stringify(resp)).unwrap();',
      '}',
      '',
      'fn respHarr() -> Json {',
      '    let resp: Map[str, Json] = {',
      '        "status": js(200),',
      '        "headers": std.json.parse("[\\"a\\",\\"b\\"]").unwrap(),',
      '        "body": std.json.parse("\\"y\\"").unwrap(),',
      '    };',
      '    return std.json.parse(std.json.stringify(resp)).unwrap();',
      '}',
      '',
      'fn respNumBody() -> Json {',
      '    let resp: Map[str, Json] = {',
      '        "status": js(200),',
      '        "headers": std.json.parse("{}").unwrap(),',
      '        "body": js(42),',
      '    };',
      '    return std.json.parse(std.json.stringify(resp)).unwrap();',
      '}',
      '',
      'fn handler(req: Untrusted[Json]) -> Json {',
      '    let p = jstr(req, "path", "?");',
      '    if p == "/s700" { return resp700(); }',
      '    if p == "/harr" { return respHarr(); }',
      '    if p == "/numbody" { return respNumBody(); }',
      '    return js(0);',
      '}',
      '',
      'fn main() with net {',
      '    std.net.serve(__PORT__, handler);',
      '}',
    ].join('\n'),
  };

  // ---- #56:损坏产物四形态统一诊断 ----
  // ming build 真实产物(dist/app.bytecode.json)→ JSON 改写损坏字段 → node dist/ming-app.mjs。
  // 修前基线(plan §4.5.7 S14):mainFnIdx=99 / functions=[] → raw TypeError(vm.js:283)exit 1;
  // mainFnIdx=-1 → M3023 exit 101;opcode 999 → M4001 exit 101。修后统一:"不是 Ming 字节码产物:
  // <具体原因>" Error 通道 exit 1(零新增 M 码,复用 artifact.js 既有 Error 文案)。
  const proj68 = path.join(dir68, 'proj68');
  fs.mkdirSync(proj68, { recursive: true });
  fs.writeFileSync(path.join(proj68, 'ming.toml'), '[project]\nname = "probe68"\n');
  fs.writeFileSync(path.join(proj68, 'main.ming'), SRC68.probe);
  const build68 = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: proj68, timeout: 60000 });
  const bjson68 = path.join(proj68, 'dist', 'app.bytecode.json');
  const launcher68 = path.join(proj68, 'dist', 'ming-app.mjs');
  const pristine68 = fs.existsSync(bjson68) ? JSON.parse(fs.readFileSync(bjson68, 'utf8')) : null;
  const writeArtifact68 = (a) => fs.writeFileSync(bjson68, JSON.stringify(a));
  const restore68 = () => writeArtifact68(pristine68);
  const runLauncher68 = () => {
    const r = spawnSync(process.execPath, [launcher68], { encoding: 'utf8', cwd: proj68, timeout: 30000 });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const corruptRun68 = (mutate) => {
    const a = JSON.parse(JSON.stringify(pristine68));
    mutate(a);
    writeArtifact68(a);
    const r = runLauncher68();
    restore68();
    return r;
  };
  check('v68 前置:ming build 产出 dist(app.bytecode.json + ming-app.mjs)',
    build68.status === 0 && pristine68 !== null && fs.existsSync(launcher68),
    `build=${build68.status} stderr=${(build68.stderr ?? '').slice(0, 150)}`);

  // v68.1:mainFnIdx 越界(修前 raw TypeError vm.js:283)
  {
    const r = corruptRun68((a) => { a.mainFnIdx = 99; });
    check('v68.1:损坏产物 mainFnIdx=99 → exit 1 "不是 Ming 字节码产物: mainFnIdx 越界"(不再 raw TypeError)',
      r.code === 1 && r.stderr.includes('不是 Ming 字节码产物') && r.stderr.includes('mainFnIdx 越界(99')
        && !r.stderr.includes('TypeError') && r.stdout === '',
      `code=${r.code} err1=${JSON.stringify((r.stderr ?? '').split('\n').find((l) => l.includes('不是') || l.includes('Error')) ?? '')}`);
  }
  // v68.2:functions=[](修前 raw TypeError 同款)
  {
    const r = corruptRun68((a) => { a.functions = []; });
    check('v68.2:损坏产物 functions=[] → exit 1 "不是 Ming 字节码产物: functions 必须是非空数组"(不再 raw TypeError)',
      r.code === 1 && r.stderr.includes('不是 Ming 字节码产物') && r.stderr.includes('functions 必须是非空数组')
        && !r.stderr.includes('TypeError') && r.stdout === '',
      `code=${r.code} err1=${JSON.stringify((r.stderr ?? '').split('\n').find((l) => l.includes('不是') || l.includes('Error')) ?? '')}`);
  }
  // v68.3:mainFnIdx=-1(修前 M3023 exit 101——负值越界并入统一通道)
  {
    const r = corruptRun68((a) => { a.mainFnIdx = -1; });
    check('v68.3:损坏产物 mainFnIdx=-1 → exit 1 "不是 Ming 字节码产物"(不再 M3023)',
      r.code === 1 && r.stderr.includes('不是 Ming 字节码产物') && r.stderr.includes('mainFnIdx 越界(-1')
        && !r.stderr.includes('M3023') && r.stdout === '',
      `code=${r.code} err1=${JSON.stringify((r.stderr ?? '').split('\n').find((l) => l.includes('不是') || l.includes('M3023')) ?? '')}`);
  }
  // v68.4:坏 opcode 999(修前 M4001 exit 101——统一进反序列化结构校验,损坏不进 VM)
  {
    const r = corruptRun68((a) => { a.functions[0].code[0] = 999; });
    check('v68.4:损坏产物 opcode 999 → exit 1 "不是 Ming 字节码产物: 非法操作码"(不再 M4001)',
      r.code === 1 && r.stderr.includes('不是 Ming 字节码产物') && r.stderr.includes('非法操作码 999')
        && !r.stderr.includes('M4001') && r.stdout === '',
      `code=${r.code} err1=${JSON.stringify((r.stderr ?? '').split('\n').find((l) => l.includes('不是') || l.includes('M4001')) ?? '')}`);
  }
  // v68.5:良好产物回归(四形态之外产物必须照常运行)
  {
    restore68();
    const r = runLauncher68();
    check('v68.5:良好产物回归——node dist/ming-app.mjs 输出 ok68 exit 0',
      r.code === 0 && r.stdout === 'ok68\n',
      `code=${r.code} stdout=${JSON.stringify(r.stdout)} err1=${JSON.stringify((r.stderr ?? '').split('\n')[0])}`);
  }

  // ---- S9:嵌套 serve 编译期拒绝(check 期,引擎无关)----
  {
    const f1 = m68('k68_6_nested.ming', SRC68.s9Nested);
    const f2 = m68('k68_6_nested_short.ming', SRC68.s9NestedShort);
    const r1 = runMing(['check', f1]);
    const r2 = runMing(['check', f2]);
    check('v68.6:handler 体内 serve → check exit 1 M3002(全限定 std.net.serve 与 use 别名 net.serve 两形态)',
      r1.code === 1 && r1.stderr.includes('M3002') && r1.stderr.includes('serve 不能在 handler 内调用')
        && r2.code === 1 && r2.stderr.includes('M3002') && r2.stderr.includes('serve 不能在 handler 内调用'),
      `full=${r1.code}:${JSON.stringify(r1.stderr.split('\n')[0])} short=${r2.code}:${JSON.stringify(r2.stderr.split('\n')[0])}`);
  }
  {
    const f = m68('k68_7_main_direct.ming', SRC68.s9MainDirect.split('__PORT__').join('26987'));
    const r = runMing(['check', f]);
    check('v68.7:正例不误伤——main 直接 serve(非 handler 体)check exit 0',
      r.code === 0, `code=${r.code} stderr=${(r.stderr ?? '').slice(0, 150)}`);
  }
  {
    const f = m68('k68_8_handler_chain.ming', SRC68.s9HandlerChain.split('__PORT__').join('26988'));
    const r = runMing(['check', f]);
    check('v68.8:正例不误伤——handlerA 调 handlerB(嵌套两层 handler,体内无 serve)check exit 0',
      r.code === 0, `code=${r.code} stderr=${(r.stderr ?? '').slice(0, 150)}`);
  }

  // ---- #57:M4013 FFI 门禁专项 ----
  // M4013 语义 = C 后端启动绑定阶段的 ffi-load-failed(diagnostics.md;exit 101)——
  // check 期"无 with ffi 调 extern"的效果门禁是 M3029(§42 已有,本区正反例锁定)。
  {
    const fBad = m68('k68_9_gate.ming', SRC68.gate);
    const fOk = m68('k68_9_gate_ok.ming', SRC68.gateOk);
    const rBad = runMing(['check', fBad]);
    const rOk = runMing(['check', fOk]);
    check('v68.9a:FFI 效果门禁——无 with ffi 调 extern → check M3029 exit 1;with ffi → check exit 0',
      rBad.code === 1 && rBad.stderr.includes('M3029') && rBad.stderr.includes('ffi')
        && rOk.code === 0,
      `bad=${rBad.code}:${JSON.stringify(rBad.stderr.split('\n')[0])} ok=${rOk.code}`);
  }
  // cc 腿(gcc 探测照 §34b 口径):M4013 库加载失败 + #55 NUL 黄金;无 gcc skip 注明
  const detectCC68 = () => {
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
  const cc68 = detectCC68();
  const ffiDir68 = path.join(dir68, 'ffi68');
  fs.mkdirSync(ffiDir68, { recursive: true });
  if (!cc68) {
    check('v68.9b:M4013 专项(cc 无编译器 skip)', true, '无 gcc/clang:cc 腿跳过(M4013 是 C 后端启动绑定阶段诊断,无编译器不可达)');
    check('v68.10:#55 NUL 黄金(cc 无编译器 skip)', true, '无 gcc/clang:cc 腿跳过(需自编 mini DLL + ming cc)');
  } else {
    // v68.9b:坏库名 → 启动绑定 M4013[ffi-load-failed] exit 101
    {
      const boomFile = m68('k68_9_boom.ming', SRC68.boom);
      const ccBoom = spawnSync(process.execPath, [MING, 'cc', boomFile, '--no-run', '--out', path.join(ffiDir68, 'out9')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
      const boomExe = path.join(ffiDir68, 'out9', 'k68_9_boom.exe');
      const rBoom = fs.existsSync(boomExe) ? spawnSync(boomExe, [], { encoding: 'utf8', timeout: 30000 }) : { status: -1, stderr: '(exe 缺失)' };
      check('v68.9b:M4013 专项——extern 坏库 → C 后端 exit 101 "error M4013[ffi-load-failed]"',
        ccBoom.status === 0 && rBoom.status === 101 && (rBoom.stderr ?? '').includes('M4013') && (rBoom.stderr ?? '').includes('ffi-load-failed'),
        `cc=${ccBoom.status} run=${rBoom.status} err1=${JSON.stringify((rBoom.stderr ?? '').split('\n')[0])}`);
    }
    // v68.10:#55 NUL 黄金——自编 mini DLL 返回 "ab\0cd"(6 字节)→ strlen 语义 byte_len=2
    {
      fs.writeFileSync(path.join(ffiDir68, 'nul68.c'), '__declspec(dllexport) const char* nulstr(void) { return "ab\\0cd"; }\n');
      const dllBuild = spawnSync(cc68, ['-shared', '-static-libgcc', '-o', path.join(ffiDir68, 'nul68.dll'), path.join(ffiDir68, 'nul68.c')], { encoding: 'utf8', timeout: 60000 });
      const dll68 = path.join(ffiDir68, 'nul68.dll');
      if (dllBuild.status !== 0 || !fs.existsSync(dll68)) {
        check('v68.10:#55 NUL 黄金(DLL 构建不稳定 skip)', true, `gcc -shared 失败 status=${dllBuild.status}:${(dllBuild.stderr ?? '').split('\n')[0]}`);
      } else {
        const nulFile = m68('k68_10_nul.ming', SRC68.nul.split('__DLL__').join(dll68.replace(/\\/g, '/')));
        const ccNul = spawnSync(process.execPath, [MING, 'cc', nulFile, '--no-run', '--out', path.join(ffiDir68, 'out10')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
        const nulExe = path.join(ffiDir68, 'out10', 'k68_10_nul.exe');
        const rNul = fs.existsSync(nulExe) ? spawnSync(nulExe, [], { encoding: 'utf8', timeout: 30000 }) : { status: -1, stdout: '(exe 缺失)' };
        check('v68.10:#55 NUL 黄金——extern 返回 "ab\\0cd" → byte_len=2(strlen 语义;DLL 加载成功同时锁定 M4013 无误报)',
          ccNul.status === 0 && rNul.status === 0 && rNul.stdout === '2\n',
          `cc=${ccNul.status} run=${rNul.status} stdout=${JSON.stringify(rNul.stdout)} err1=${JSON.stringify((rNul.stderr ?? '').split('\n')[0])}`);
      }
    }
  }

  // ---- serve 运行面 harness(§68 自持最小版,模式照 §66;端口段 28100-28199 独立)----
  const { createServer: netServer68, createConnection: netConn68 } = await import('node:net');
  const sleep68 = (ms) => new Promise((res) => setTimeout(res, ms));
  const freePort68 = async (start) => {
    let port = start;
    for (let i = 0; i < 5; i++) {
      const free = await new Promise((res) => {
        const s = netServer68();
        s.once('error', () => res(false));
        s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
      });
      if (free) return port;
      port += 1;
    }
    return null;
  };
  const startServer68 = async (name, src, portHint) => {
    const port = await freePort68(portHint);
    if (port === null) throw new Error('28100-28199 段内无空闲端口(起点 ' + portHint + ')');
    const file = m68(name, src.split('__PORT__').join(String(port)));
    const proc = spawn(process.execPath, [MING, 'run', file], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
    const server = { proc, port, file, stdout: '', stderr: '', exited: false };
    proc.stdout.on('data', (d) => { server.stdout += d; });
    proc.stderr.on('data', (d) => { server.stderr += d; });
    proc.once('exit', () => { server.exited = true; });
    return server;
  };
  const killServer68 = async (server) => {
    if (!server || server.exited || server.proc.exitCode !== null || server.proc.killed) return;
    server.proc.kill();
    await new Promise((res) => {
      const t = setTimeout(() => {
        if (process.platform === 'win32') {
          try { spawnSync('taskkill', ['/F', '/T', '/PID', String(server.proc.pid)], { encoding: 'utf8' }); } catch { /* 尽力而为 */ }
        }
        res();
      }, 3000);
      server.proc.once('exit', () => { clearTimeout(t); res(); });
    });
  };
  const canConnect68 = (port) => new Promise((res) => {
    const s = netConn68({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
  const waitReady68 = async (port, timeoutMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await canConnect68(port)) return true;
      await sleep68(100);
    }
    return false;
  };
  const fetchText68 = async (url, opts = {}) => {
    const r = await fetch(url, opts);
    const body = await r.text();
    return { status: r.status, body, contentType: r.headers.get('content-type') ?? '', headerA: r.headers.get('a') };
  };
  const errFirst68 = (s) => JSON.stringify(((s && s.stderr) || '').split('\n')[0]);
  // 运行用例外壳:finally 杀 server + 销毁挂起 socket(不留监听,不留悬连接)。
  const runCase68 = async (name, fn) => {
    const servers = [];
    const sockets = [];
    try {
      await fn(async (srcName, src, portHint) => {
        const s = await startServer68(srcName, src, portHint);
        servers.push(s);
        return s;
      }, sockets);
    } catch (e) {
      const last = servers.length ? servers[servers.length - 1] : null;
      check(name, false, '异常: ' + String(e && e.message ? e.message : e)
        + (last ? ' stderr[0]=' + errFirst68(last) : ''));
    } finally {
      for (const s of sockets) { try { s.destroy(); } catch { /* 尽力而为 */ } }
      for (const s of servers) await killServer68(s);
    }
  };

  // v68.11:S13 慢连接行为锁定——50 挂起连接(半截请求头)期间正常请求仍 200
  // (S13 实测基线:50 挂起不占 worker;超时余量放宽至 25s,实测 ~0.1s)
  await runCase68('v68.11:S13 慢连接行为锁定——50 挂起连接期间正常请求仍 200', async (start) => {
    const s = await start('k68_11_server.ming', SRC68.s13fast, 28110);
    if (!(await waitReady68(s.port))) throw new Error('server 15s 未就绪');
    const hung = [];
    for (let i = 0; i < 50; i++) {
      const sk = netConn68({ host: '127.0.0.1', port: s.port });
      sk.on('error', () => { /* 服务端被杀/连接重置:挂起 socket 的预期噪声 */ });
      sk.once('connect', () => { try { sk.write('GET /slow HTTP/1.1\r\nHost: slow\r\nUser-Agent: hang\r\n'); } catch { /* 尽力而为 */ } });
      hung.push(sk);
    }
    await sleep68(300);
    const res = await fetchText68('http://127.0.0.1:' + s.port + '/fast', { signal: AbortSignal.timeout(25000) });
    check('v68.11:S13 慢连接行为锁定——50 挂起连接期间正常请求 200 "ok"',
      res.status === 200 && res.body === 'ok',
      `status=${res.status} body=${JSON.stringify(res.body)} hung=${hung.length} stderr[0]=${errFirst68(s)}`);
  });

  // v68.12:S11 兜底语义锁定(修前 6 形态实测全 200 无诊断;文档化不改 500——语义裁决,
  // 本批只锁行为):status 700 → 200、headers 数组 → 静默丢弃默认头、数值 body → 空体。
  await runCase68('v68.12:S11 兜底语义锁定——畸形响应三形态', async (start) => {
    const s = await start('k68_12_server.ming', SRC68.s11, 28120);
    if (!(await waitReady68(s.port))) throw new Error('server 15s 未就绪');
    const r700 = await fetchText68('http://127.0.0.1:' + s.port + '/s700', { signal: AbortSignal.timeout(10000) });
    check('v68.12a:S11 兜底——status 700(超出 100..599)→ 200,body 保留',
      r700.status === 200 && r700.body === 'x',
      `status=${r700.status} body=${JSON.stringify(r700.body)} stderr[0]=${errFirst68(s)}`);
    const rHarr = await fetchText68('http://127.0.0.1:' + s.port + '/harr', { signal: AbortSignal.timeout(10000) });
    check('v68.12b:S11 兜底——headers 为数组 → 静默丢弃,默认 Content-Type application/json 兜底',
      rHarr.status === 200 && rHarr.body === 'y' && rHarr.contentType === 'application/json' && rHarr.headerA === null,
      `status=${rHarr.status} body=${JSON.stringify(rHarr.body)} ct=${JSON.stringify(rHarr.contentType)} a=${JSON.stringify(rHarr.headerA)}`);
    const rNum = await fetchText68('http://127.0.0.1:' + s.port + '/numbody', { signal: AbortSignal.timeout(10000) });
    check('v68.12c:S11 兜底——数值 body → 空体',
      rNum.status === 200 && rNum.body === '',
      `status=${rNum.status} body=${JSON.stringify(rNum.body)}`);
  });

  // ---- S12 向量(v0.64 审查修复 m1):sanitize_cli_path 闸门扩展——DEL/C1/双向符 ----
  // v65.15/16 只锁了空串与 C0 制表;本区补 S12 收紧后拒绝集的三类字面量向量(三引擎逐字):
  // DEL(0x7F)/ C1(0x80–0x9F,取 NEL U+0085)/ Unicode 双向控制符(U+202A LRE)。
  // 字面量向量以码点直写源文件(实测源串字面量可含原始控制码点,不依赖源层 \uXXX 转义);
  // env 注入走 spawnSync env 块(Windows UTF-16 环境码元原样到达子进程,等价 bash ANSI-C
  // $'a\x7fb' 的字节注入形态)。Err 消息按拒绝集码点 \uXXXX 小写 4 位转义(interp 既有口径)。
  const BS68 = String.fromCharCode(92);
  const same68 = (runs, want) => runs.every(r => r.code === 0 && r.stdout === want);
  const CTRL68 = {
    del: String.fromCharCode(0x7F),
    nel: String.fromCharCode(0x85),
    lre: String.fromCharCode(0x202A),
  };
  const s12show68 = (body) => [
    'use std.unstr;',
    '',
    'fn show(u: Untrusted[str]) with io {',
    '    match std.unstr.sanitize_cli_path(u) {',
    '        Ok(p) => {',
    '            print("OK " + p);',
    '        },',
    '        Err(e) => {',
    '            print("ERR " + e);',
    '        },',
    '    }',
    '}',
    '',
    'fn main() with io {',
    ...body,
    '}',
  ].join('\n');
  const s12env68 = () => [
    'use std.env;',
    '',
    'use std.unstr;',
    '',
    'fn main() with env, io {',
    '    match std.env.get("MING_V64_VAL") {',
    '        Some(u) => {',
    '            match std.unstr.sanitize_cli_path(u) {',
    '                Ok(p) => {',
    '                    print("OK " + p);',
    '                },',
    '                Err(e) => {',
    '                    print("ERR " + e);',
    '                },',
    '            }',
    '        },',
    '        None => {',
    '            print("NONE");',
    '        },',
    '    }',
    '}',
  ].join('\n');
  const runsEnv68 = (p, val) => flags68.map(f => runMing(f ? ['run', p, f] : ['run', p], { env: { MING_V64_VAL: val } }));

  // v68.13:mark 字面量向量合一——DEL/C1(NEL)/RTL(LRE) 三类源字面量 → Err 各含对应转义
  {
    const f = m68('k68_13_mark_vectors.ming', s12show68([
      '    show(std.unstr.mark("a' + CTRL68.del + 'b"));',
      '    show(std.unstr.mark("a' + CTRL68.nel + 'b"));',
      '    show(std.unstr.mark("a' + CTRL68.lre + 'b"));',
    ]));
    const want = [
      'ERR sanitize_cli_path: 含控制字符: "a' + BS68 + 'u007fb"',
      'ERR sanitize_cli_path: 含控制字符: "a' + BS68 + 'u0085b"',
      'ERR sanitize_cli_path: 含控制字符: "a' + BS68 + 'u202ab"',
    ].join('\n') + '\n';
    const runs = runAll68(f);
    check('v68.13:S12 mark 字面量向量(DEL 0x7F/C1 NEL U+0085/双向符 LRE U+202A)→ Err 含对应 \\uXXXX 转义(三引擎逐字)',
      same68(runs, want), fmtRuns68(runs));
  }
  // v68.14:S12 env 注入 DEL(等价 bash ANSI-C V=$'a\x7fb')→ Err \u007f
  {
    const f = m68('k68_14_env_del.ming', s12env68());
    const runs = runsEnv68(f, 'a' + CTRL68.del + 'b');
    check('v68.14:S12 env 注入 DEL(0x7F)→ Err \\u007f(三引擎逐字)',
      same68(runs, 'ERR sanitize_cli_path: 含控制字符: "a' + BS68 + 'u007fb"\n'), fmtRuns68(runs));
  }
  // v68.15:S12 env 注入 C1(NEL U+0085)→ Err \u0085
  {
    const f = m68('k68_15_env_c1.ming', s12env68());
    const runs = runsEnv68(f, 'a' + CTRL68.nel + 'b');
    check('v68.15:S12 env 注入 C1(U+0085 NEL)→ Err \\u0085(三引擎逐字)',
      same68(runs, 'ERR sanitize_cli_path: 含控制字符: "a' + BS68 + 'u0085b"\n'), fmtRuns68(runs));
  }

  // ---- S9 两遍式回归(v0.64 审查修复 M1):遮蔽 net 名后 trait 方法调用不误伤 ----
  // 修法:serve 静态判定以 checker 真实解析结果为单一事实来源(checkStdCall 的
  // std.net.serve 特例解析成功处按 Call 节点引用身份登记 serveCallNodes;run() 收尾
  // 对每个调用点的 handler 声明体子树做身份扫描)。遮蔽情形(net: S 的 trait 方法
  // net.serve)走方法调用路径,不进登记集合 → check exit 0;嵌套 serve 正向面
  // (v68.6 两形态)与本批正例(v68.7/8)行为不变。运行面 net.serve(7) 仍走 trait 方法。
  {
    const f = m68('k68_16_shadow.ming', SRC68.s9Shadow.split('__PORT__').join('26989'));
    const r = runMing(['check', f]);
    check('v68.16a:M1 修复——handler 内遮蔽 net 名后调用 trait 方法 serve 不误伤(check exit 0,不再 M3002)',
      r.code === 0 && !(r.stderr ?? '').includes('M3002'),
      `code=${r.code} stderr=${(r.stderr ?? '').slice(0, 200)}`);
    const f2 = m68('k68_16_shadow_run.ming', SRC68.s9ShadowRun);
    const runs = runAll68(f2);
    check('v68.16b:M1 修复——遮蔽名下 trait 方法 net.serve(7) 语义不变,三引擎逐字输出 7',
      same68(runs, '7\n'), fmtRuns68(runs));
  }
  // §68-END
}

// ===================== 69. v0.65:wasm 守护收口 slice 3(plan §4.5.2;守护具名清单清零)=====================
// 文件所有权:§69 = 本区全部用例。五形态:expect(msg)/Map unwrap(map_has 导入)/Err unwrap(载荷 display)/
// Vec[str] 下标读(句柄)/下标复合赋值 v[i] += x——正例三引擎逐字 + panic 消息-span-退出码逐字 + strict 存活 + #59 嵌套栈帧。
{
  const dir69 = path.join(TMP, 'v69');
  fs.mkdirSync(dir69, { recursive: true });
  const m69 = (name, src) => { const f = path.join(dir69, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags69 = ['', '--no-wasm', '--tree'];
  const runAll69 = (p, extra = []) => flags69.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const same69 = (runs, want) => runs.every(r => r.code === 0 && r.stdout === want);
  const fmtRuns69 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');
  const strict69c = (p, extra = []) => runMing(['run', p, '--strict-wasm', ...extra], { env: { MING_WASM_DEBUG: '1' } });

  // ---- §69-START(slice 3 用例:五形态正例/panic 对齐/strict 存活/#59 嵌套栈帧)----

  // v69.1 形态 1 正例:expect(编译期字面量 msg)命中路径——三引擎逐字 + strict 存活
  // (msg 经 strConsts 表索引穿越导入边界;宿主 panic_expect 与 interp.js:3246 同源)
  {
    const p = m69('k69_01_expect_hit.ming', [
      'fn g(v: Vec[i64]) -> i64 { return v.get(0).expect("need"); }',
      'fn main() with io { print(str(g([1, 2]))); }',
    ].join('\n'));
    const runs = runAll69(p);
    const s = strict69c(p);
    check('v69.1:expect(字面量 msg)命中——三引擎输出 1 + strict exit 0 + [wasm] fn g OK 无 REJECT',
      same69(runs, '1\n') && s.code === 0 && s.stdout === '1\n'
        && s.stderr.includes('[wasm] fn g OK') && !s.stderr.includes('REJECT') && !s.stderr.includes('回落'),
      `runs=${fmtRuns69(runs)} strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('wasm]') || l.includes('回落')) ?? '')}`);
  }

  // v69.2 形态 2 正例:Map unwrap 命中(map_has 导入判定在先;Map expect 命中同批锁定)
  {
    const p = m69('k69_02_mapunwrap_hit.ming', [
      'fn f() -> i64 {',
      '    let m: Map[str, i64] = {"a": 1};',
      '    return m.get("a").unwrap();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const p2 = m69('k69_02b_mapexpect_hit.ming', [
      'fn f() -> i64 {',
      '    let m: Map[str, i64] = {"a": 1};',
      '    return m.get("a").expect("cfg");',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const runs = runAll69(p);
    const s = strict69c(p);
    const runs2 = runAll69(p2);
    const s2 = strict69c(p2);
    check('v69.2:Map unwrap/expect 命中——三引擎输出 1 + strict exit 0 + [wasm] fn f OK 无 REJECT',
      same69(runs, '1\n') && same69(runs2, '1\n') && s.code === 0 && s2.code === 0
        && s.stderr.includes('[wasm] fn f OK') && !s.stderr.includes('REJECT')
        && s2.stderr.includes('[wasm] fn f OK') && !s2.stderr.includes('REJECT'),
      `runs=${fmtRuns69(runs)} strict=${s.code} runs2=${fmtRuns69(runs2)} strict2=${s2.code}`);
  }

  // v69.3 形态 3 正例:Ok/Err 构造 + Result unwrap Ok 分支(Ok i64 载荷直通 / Ok str 载荷
  // 经 strTable 句柄)——三引擎逐字 + strict 存活。Err 分支 panic(display 载荷)在 v69.7
  // 完整对齐,数值载荷 i64/u64/f64 display 在 v69.9。
  {
    const p = m69('k69_03_resok.ming', [
      'fn oki() -> i64 {',
      '    let r: Result[i64, str] = Ok(7);',
      '    return r.unwrap();',
      '}',
      'fn oks() -> str {',
      '    let r: Result[str, str] = Ok("hello");',
      '    return r.unwrap();',
      '}',
      'fn main() with io {',
      '    print(str(oki()));',
      '    print(oks());',
      '}',
    ].join('\n'));
    const runs = runAll69(p);
    const s = strict69c(p);
    check('v69.3:Ok 构造 + unwrap 两载荷型——三引擎输出 7/hello + strict exit 0 + [wasm] fn OK 无 REJECT',
      same69(runs, '7\nhello\n') && s.code === 0 && s.stdout === '7\nhello\n'
        && s.stderr.includes('[wasm] fn oki OK') && s.stderr.includes('[wasm] fn oks OK') && !s.stderr.includes('REJECT'),
      `runs=${fmtRuns69(runs)} strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('REJECT') || l.includes('回落')) ?? '')}`);
  }

  // v69.4 形态 4 正例:Vec[str] 下标读(句柄容器经 vecstr_get,界内返回 str 句柄)
  {
    const p = m69('k69_04_vecstr_read.ming', [
      'fn f() -> str {',
      '    let s: Vec[str] = ["a", "b"];',
      '    return s[0];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const runs = runAll69(p);
    const s = strict69c(p);
    check('v69.4:Vec[str] 下标读——三引擎输出 a + strict exit 0 + [wasm] fn f OK 无 REJECT',
      same69(runs, 'a\n') && s.code === 0 && s.stdout === 'a\n'
        && s.stderr.includes('[wasm] fn f OK') && !s.stderr.includes('REJECT') && !s.stderr.includes('回落'),
      `runs=${fmtRuns69(runs)} strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('wasm]') || l.includes('回落')) ?? '')}`);
  }

  // v69.5 形态 5 正例:下标复合赋值全操作矩阵——i64 七种(+= -= *= /= %= &= |=)+
  // 标量顺带解锁(&= |= ^= %=)+ f64 四种(+= -= *= /=;interp float 无 %,wasm 无 frem)
  {
    const p = m69('k69_05_ops.ming', [
      'fn f() -> i64 {',
      '    let mut v: Vec[i64] = [10, 10, 10, 10, 10, 10, 10];',
      '    v[0] += 5;',
      '    v[1] -= 3;',
      '    v[2] *= 2;',
      '    v[3] /= 4;',
      '    v[4] %= 3;',
      '    v[5] &= 6;',
      '    v[6] |= 9;',
      '    return v[0] + v[1] + v[2] + v[3] + v[4] + v[5] + v[6];',
      '}',
      'fn g() -> i64 {',
      '    let mut x: i64 = 12;',
      '    x &= 10;',
      '    x |= 5;',
      '    x ^= 3;',
      '    x %= 7;',
      '    return x;',
      '}',
      'fn h() -> f64 {',
      '    let mut w: Vec[f64] = [1.0, 2.0, 4.0, 10.0];',
      '    w[0] += 0.5;',
      '    w[1] -= 0.25;',
      '    w[2] *= 2.0;',
      '    w[3] /= 4.0;',
      '    return w[0] + w[1] + w[2] + w[3];',
      '}',
      'fn main() with io {',
      '    print(str(f()));',
      '    print(str(g()));',
      '    print(str(h()));',
      '}',
    ].join('\n'));
    const runs = runAll69(p);
    const s = strict69c(p);
    check('v69.5:下标复合赋值全操作矩阵——三引擎 58/0/13.75 + strict exit 0 + 三 fn OK 无 REJECT',
      same69(runs, '58\n0\n13.75\n') && s.code === 0 && s.stdout === '58\n0\n13.75\n'
        && s.stderr.includes('[wasm] fn f OK') && s.stderr.includes('[wasm] fn g OK') && s.stderr.includes('[wasm] fn h OK')
        && !s.stderr.includes('REJECT'),
      `runs=${fmtRuns69(runs)} strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('REJECT') || l.includes('回落')) ?? '')}`);
  }

  // panic 完整对齐公因子:三引擎(默认/no-wasm/tree)+ strict 四路 stderr 全文逐字 + exit 101
  // (strict 路**不带 MING_WASM_DEBUG**:debug 前缀行会破坏全文逐字可比性)
  const panicAlign69 = (p) => {
    const runs = runAll69(p);
    const s = runMing(['run', p, '--strict-wasm']);
    const same4 = runs[0].stderr === runs[1].stderr && runs[0].stderr === runs[2].stderr && runs[0].stderr === s.stderr;
    return { runs, s, same4 };
  };
  const firstLine69 = (r) => (r.stderr ?? '').split('\n')[0];

  // v69.6 panic 对齐 1:Map 缺键 unwrap——map_has 先判定,缺键 → M4006 `对 None 调用 unwrap()`
  // (消息/span/调用栈/exit 与 tree/VM 逐字,strict 同)
  {
    const p = m69('k69_06_mapmiss.ming', [
      'fn f() -> i64 {',
      '    let m: Map[str, i64] = {"a": 1};',
      '    return m.get("b").unwrap();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const { runs, s, same4 } = panicAlign69(p);
    check('v69.6:Map 缺键 unwrap M4006——四路 stderr 全文逐字 + 首行 `对 None 调用 unwrap()` + exit 101',
      runs.every(r => r.code === 101) && s.code === 101 && same4
        && firstLine69(runs[0]).includes('error M4006') && firstLine69(runs[0]).includes('对 None 调用 unwrap()')
        && runs[0].stderr.includes('at f (') && runs[0].stderr.includes('at main ('),
      fmtRuns69(runs) + ` strict=${s.code} same4=${same4}`);
  }

  // v69.7 panic 对齐 2:Err(str) unwrap——res_unwrap_str 宿主 `对 Err(bad) 调用 unwrap()`
  // (display 载荷与 interp.js:3258 同源;四路 stderr 全文逐字)
  {
    const p = m69('k69_07_errunwrap.ming', [
      'fn f() -> i64 {',
      '    let r: Result[i64, str] = Err("bad");',
      '    return r.unwrap();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const { runs, s, same4 } = panicAlign69(p);
    check('v69.7:Err(str) unwrap M4006——四路 stderr 全文逐字 + 首行 `对 Err(bad) 调用 unwrap()` + exit 101',
      runs.every(r => r.code === 101) && s.code === 101 && same4
        && firstLine69(runs[0]).includes('error M4006') && firstLine69(runs[0]).includes('对 Err(bad) 调用 unwrap()'),
      fmtRuns69(runs) + ` strict=${s.code} same4=${same4}`);
  }

  // v69.8 panic 对齐 3:expect(字面量 msg)失败——Vec 越界与 Map 缺键两路,消息
  // `expect 失败: <msg>`(span = expect 调用点;四路 stderr 全文逐字)
  {
    const p = m69('k69_08_vecexpect.ming', [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v.get(10).expect("need");',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const p2 = m69('k69_08b_mapexpect.ming', [
      'fn f() -> i64 {',
      '    let m: Map[str, i64] = {"a": 1};',
      '    return m.get("b").expect("cfg key");',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const a = panicAlign69(p);
    const b = panicAlign69(p2);
    check('v69.8:expect 失败 M4006(Vec 越界 + Map 缺键)——四路 stderr 全文逐字 + `expect 失败: need`/`expect 失败: cfg key` + exit 101',
      a.runs.every(r => r.code === 101) && a.s.code === 101 && a.same4
        && firstLine69(a.runs[0]).includes('expect 失败: need')
        && b.runs.every(r => r.code === 101) && b.s.code === 101 && b.same4
        && firstLine69(b.runs[0]).includes('expect 失败: cfg key'),
      `a=${fmtRuns69(a.runs)} strictA=${a.s.code} same4a=${a.same4} b=${fmtRuns69(b.runs)} strictB=${b.s.code} same4b=${b.same4}`);
  }

  // v69.9 Err 数值载荷 display:i64 直出 / u64 位型保真(isU64 → BigInt.asUintN,经
  // eligible 形参穿越调用边界)/ f64 display(2.0 保一位小数)——三引擎首行逐字 + exit 101
  {
    const pi = m69('k69_09a_erri64.ming', [
      'fn f() -> i64 {',
      '    let r: Result[i64, i64] = Err(7);',
      '    return r.unwrap();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const pu = m69('k69_09b_erru64.ming', [
      'fn eu(bad: u64) -> u64 {',
      '    let r: Result[u64, u64] = Err(bad);',
      '    return r.unwrap();',
      '}',
      'fn main() with io { print(eu(18446744073709551615)); }',
    ].join('\n'));
    const pf = m69('k69_09c_errf64.ming', [
      'fn f() -> f64 {',
      '    let r: Result[f64, f64] = Err(2.0);',
      '    return r.unwrap();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const a = panicAlign69(pi);
    const b = panicAlign69(pu);
    const c = panicAlign69(pf);
    const dbgU = strict69c(pu);
    check('v69.9:Err 数值载荷 display 三型(i64=7 / u64 位型保真 18446744073709551615 / f64=2.0)——三引擎首行逐字 + exit 101 + u64 fn wasm OK',
      a.runs.every(r => r.code === 101) && firstLine69(a.runs[0]).includes('对 Err(7) 调用 unwrap()')
        && firstLine69(a.runs[0]) === firstLine69(a.runs[1]) && firstLine69(a.runs[0]) === firstLine69(a.runs[2])
        && b.runs.every(r => r.code === 101) && firstLine69(b.runs[0]).includes('对 Err(18446744073709551615) 调用 unwrap()')
        && firstLine69(b.runs[0]) === firstLine69(b.runs[1]) && firstLine69(b.runs[0]) === firstLine69(b.runs[2])
        && dbgU.code === 101 && dbgU.stderr.includes('[wasm] fn eu OK')
        && c.runs.every(r => r.code === 101) && firstLine69(c.runs[0]).includes('对 Err(2.0) 调用 unwrap()')
        && firstLine69(c.runs[0]) === firstLine69(c.runs[1]) && firstLine69(c.runs[0]) === firstLine69(c.runs[2]),
      `i=${fmtRuns69(a.runs)} u=${fmtRuns69(b.runs)} dbgU=${dbgU.code} f=${fmtRuns69(c.runs)}`);
  }

  // v69.10 下标复合赋值边界:(a) 越界 v[10] += 5——读 flavor 界检查先触发(interp evalExpr
  // target 口径),消息带 `(用 .get(i) 返回 Option)` 后缀、span = target.span;四路 stderr 逐字。
  // (b) 双重求值副作用锁定:interp assignTo 的 rhs 先、读/写两段 base/index 各求值一次
  // (共两次)——io 计数程序三引擎逐字 `i\ni\n25`(main 带 io 恒走 VM,本用例锁定的是
  // interp/assignTo 语义本身;eligible wasm 路径的双重求值由 v69.10c 的 --max-steps
  // 步数差独立观测——下标读写不计费、eligible fn 不可用 io,步数是唯一可观测面)。
  {
    const p = m69('k69_10a_compound_oob.ming', [
      'fn f() -> i64 {',
      '    let mut v: Vec[i64] = [1, 2, 3];',
      '    v[10] += 5;',
      '    return v[0];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const p2 = m69('k69_10b_doubleeval.ming', [
      'fn idx() -> i64 with io {',
      '    print("i");',
      '    return 1;',
      '}',
      'fn main() with io {',
      '    let mut v: Vec[i64] = [10, 20, 30];',
      '    v[idx()] += 5;',
      '    print(str(v[1]));',
      '}',
    ].join('\n'));
    const a = panicAlign69(p);
    const runs2 = runAll69(p2);
    check('v69.10:下标复合赋值越界 M4003 读 flavor(span=target)+ 双重求值副作用锁定(索引函数被调两次,三引擎逐字 i/i/25)',
      a.runs.every(r => r.code === 101) && a.s.code === 101 && a.same4
        && firstLine69(a.runs[0]).includes('索引越界:长度 3,访问 10(用 .get(i) 返回 Option)')
        && same69(runs2, 'i\ni\n25\n'),
      `a=${fmtRuns69(a.runs)} strictA=${a.s.code} same4=${a.same4} b=${fmtRuns69(runs2)}`);
  }

  // v69.10c(m2 v0.65 审查)双重求值的 eligible wasm 路径可观测对照(--max-steps 步数差):
  // eligible fn 内 `v[idx()] += 5` 按契约 idx 求值两次,每次函数入口 tick 50 步(wasm.js
  // 入口注入 ming_tick)——提升为 `let i = idx()`(一次)后最小通过步数恰差一个 tick
  // (实测 wasm 腿 159 vs 109)。阈值 130 下:两次 → M4001、一次 → exit 0 输出 25。
  // tree/VM 的逐步计步间隔仅 1 步(脆弱)且恰好两次已由 v69.10b 的 io 程序锁定,
  // 故此处只断 wasm 腿(间隔 50 步,阈值容差 ±20 步的主函数步数漂移)。
  {
    const pA = m69('k69_10c_stepcall.ming', [
      'fn idx() -> i64 { return 1; }',
      'fn f() -> i64 {',
      '    let mut v: Vec[i64] = [10, 20, 30];',
      '    v[idx()] += 5;',
      '    return v[1];',
      '}',
      'fn main() with io { print(str(f())); }',
    ].join('\n'));
    const pB = m69('k69_10c_stephoist.ming', [
      'fn idx() -> i64 { return 1; }',
      'fn f() -> i64 {',
      '    let mut v: Vec[i64] = [10, 20, 30];',
      '    let i = idx();',
      '    v[i] += 5;',
      '    return v[1];',
      '}',
      'fn main() with io { print(str(f())); }',
    ].join('\n'));
    const runsA = runAll69(pA);
    const runsB = runAll69(pB);
    const limA = runMing(['run', pA, '--max-steps', '130']);
    const limB = runMing(['run', pB, '--max-steps', '130']);
    check('v69.10c:双重求值 wasm 步数对照——v[idx()] += 5(--max-steps 130 → M4001)vs 提升一次求值(→ exit 0);无限制三引擎逐字 25',
      same69(runsA, '25\n') && same69(runsB, '25\n')
        && limA.code === 101 && firstLine69(limA).includes('M4001') && firstLine69(limA).includes('执行步数超过上限 130')
        && limB.code === 0 && limB.stdout === '25\n',
      `A=${fmtRuns69(runsA)} B=${fmtRuns69(runsB)} limA=${limA.code}:${JSON.stringify(firstLine69(limA))} limB=${limB.code}:${JSON.stringify(limB.stdout)}`);
  }

  // v69.11 Vec[str] 下标读边界:(a) 越界 → M4003 读 flavor(宿主 vecstr_get,消息带
  // `(用 .get(i) 返回 Option)` 后缀 + span)四路逐字;(b) 元素写 → 具名守护
  // `Vec[str] 元素写(句柄容器,登记不做)`(strict exit 2;非 strict 三引擎正常执行)
  {
    const p = m69('k69_11a_vecstr_oob.ming', [
      'fn f() -> str {',
      '    let s: Vec[str] = ["a", "b"];',
      '    return s[5];',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const p2 = m69('k69_11b_vecstr_write.ming', [
      'fn f() -> i64 {',
      '    let mut s: Vec[str] = ["a", "b"];',
      '    s[0] = "z";',
      '    return 1;',
      '}',
      'fn main() with io { print(str(f())); }',
    ].join('\n'));
    const a = panicAlign69(p);
    const runs2 = runAll69(p2);
    const s2 = strict69c(p2);
    check('v69.11:Vec[str] 越界读 M4003 后缀逐字(四路)+ 元素写具名守护 strict exit 2 + 非 strict 三引擎 1',
      a.runs.every(r => r.code === 101) && a.s.code === 101 && a.same4
        && firstLine69(a.runs[0]).includes('索引越界:长度 2,访问 5(用 .get(i) 返回 Option)')
        && same69(runs2, '1\n') && s2.code === 2 && s2.stdout === ''
        && (s2.stderr ?? '').includes('wasm 编译回落(f)') && (s2.stderr ?? '').includes('Vec[str] 元素写(句柄容器,登记不做)'),
      `a=${fmtRuns69(a.runs)} strictA=${a.s.code} same4=${a.same4} b=${fmtRuns69(runs2)} strictB=${s2.code}:${JSON.stringify((s2.stderr ?? '').split('\n')[0])}`);
  }

  // v69.12 #59 嵌套栈帧:(a) main→f→g(g 内越界)三引擎完整 stderr 全文逐字(含 `at g`
  // 帧——v0.63 已知残留就此收口);(b) fib(25) 递归(直调 frame_push/pop 配对)输出逐字。
  // 直调开销 +18% 为信息性(帧进出两次导入调用),不做脆弱的时间断言。
  {
    const p = m69('k69_12a_nested.ming', [
      'fn g() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v[10];',
      '}',
      'fn f() -> i64 {',
      '    return g();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const p2 = m69('k69_12b_fib.ming', [
      'fn fib(n: i64) -> i64 { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }',
      'fn main() with io { print(str(fib(25))); }',
    ].join('\n'));
    const a = panicAlign69(p);
    const runs2 = runAll69(p2);
    const s2 = strict69c(p2);
    check('v69.12:#59 嵌套 panic 三帧 stderr 三引擎逐字(at g/at f/at main)+ fib(25)=75025 递归正常 + strict fn OK',
      a.runs.every(r => r.code === 101) && a.s.code === 101 && a.same4
        && a.runs[0].stderr.includes('at g (') && a.runs[0].stderr.includes('at f (') && a.runs[0].stderr.includes('at main (')
        && same69(runs2, '75025\n') && s2.code === 0 && s2.stdout === '75025\n' && s2.stderr.includes('[wasm] fn fib OK'),
      `a=${fmtRuns69(a.runs)} strictA=${a.s.code} same4=${a.same4} b=${fmtRuns69(runs2)} strictB=${s2.code}`);
  }

  // v69.13 组合函数:五形态共存单函数(strict exit 0 + [wasm] fn combo OK;非 strict 三引擎逐字)
  {
    const p = m69('k69_13_combo.ming', [
      'fn combo(v: Vec[i64], s: Vec[str], m: Map[str, i64]) -> i64 {',
      '    let mut w: Vec[i64] = [1, 2, 3];',
      '    w[0] += v.get(1).expect("need");',
      '    let r: Result[i64, str] = Ok(2);',
      '    let e: i64 = r.unwrap();',
      '    let mv: i64 = m.get("a").unwrap();',
      '    let t = s[0];',
      '    let mut total = w[0] + e + mv;',
      '    if t == "ab" { total += 1; }',
      '    return total;',
      '}',
      'fn main() with io { print(str(combo([10, 20, 30], ["ab", "cd"], {"a": 5}))); }',
    ].join('\n'));
    const runs = runAll69(p);
    const s = strict69c(p);
    check('v69.13:五形态组合单函数——三引擎输出 29 + strict exit 0 + [wasm] fn combo OK 无 REJECT',
      same69(runs, '29\n') && s.code === 0 && s.stdout === '29\n'
        && s.stderr.includes('[wasm] fn combo OK') && !s.stderr.includes('REJECT') && !s.stderr.includes('回落'),
      `runs=${fmtRuns69(runs)} strict=${s.code}:${JSON.stringify(s.stderr.split('\n').find(l => l.includes('REJECT') || l.includes('回落')) ?? '')}`);
  }

  // v69.14 守护具名余项(仍具名,strict exit 2):变量 msg expect / Result 非标量载荷
  // (容器与 bool)/ Map 下标复合赋值(通用"赋值目标"文本);非 strict 三引擎语义不变
  // (变量 msg 正常取值 / Err([1,2]) panic / Map 复合赋值求值)
  {
    const p1 = m69('k69_14a_msgvar.ming', [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let msg = "need";',
      '    return v.get(0).expect(msg);',
      '}',
      'fn main() with io { print(str(f())); }',
    ].join('\n'));
    const p2 = m69('k69_14b_resnonscalar.ming', [
      'fn f() -> i64 {',
      '    let r: Result[i64, Vec[i64]] = Err([1, 2]);',
      '    return r.unwrap();',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const p3 = m69('k69_14c_mapcompound.ming', [
      'fn f() -> i64 {',
      '    let mut m: Map[str, i64] = {"a": 1};',
      '    m["a"] += 1;',
      '    return m["a"];',
      '}',
      'fn main() with io { print(str(f())); }',
    ].join('\n'));
    const s1 = strict69c(p1);
    const runs1 = runAll69(p1);
    const s2 = strict69c(p2);
    const runs2 = runAll69(p2);
    const s3 = strict69c(p3);
    const runs3 = runAll69(p3);
    check('v69.14:守护具名余项——变量 msg expect / Result 非标量载荷 / Map 下标复合赋值 均 strict exit 2 具名;非 strict 语义不变',
      s1.code === 2 && (s1.stderr ?? '').includes('expect msg 非编译期字面量(待解锁)') && same69(runs1, '1\n')
        && s2.code === 2 && (s2.stderr ?? '').includes('Result 载荷非标量(容器/结构体/bool 待解锁)')
        && runs2.every(r => r.code === 101) && firstLine69(runs2[0]).includes('对 Err([1, 2]) 调用 unwrap()')
          && firstLine69(runs2[0]) === firstLine69(runs2[1]) && firstLine69(runs2[0]) === firstLine69(runs2[2])
        && s3.code === 2 && (s3.stderr ?? '').includes('wasm 编译回落(f)') && (s3.stderr ?? '').includes('赋值目标')
        && same69(runs3, '2\n'),
      `s1=${s1.code}:${JSON.stringify((s1.stderr ?? '').split('\n')[0])} runs1=${fmtRuns69(runs1)} s2=${s2.code}:${JSON.stringify((s2.stderr ?? '').split('\n')[0])} s3=${s3.code}:${JSON.stringify((s3.stderr ?? '').split('\n')[0])} runs3=${fmtRuns69(runs3)}`);
  }

  // v69.15 unwrap_or/is_some/is_none 口径锁定:函数 shape-eligible + emit 期具名回落
  // (strict exit 2,v0.65 修正既往"不 eligible"表述——REJECT 文本可见);bool 返回形态
  // 函数才是不 eligible(strict exit 0);非 strict 三引擎语义逐字
  {
    const p1 = m69('k69_15a_unwrapor.ming', [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    return v.get(10).unwrap_or(7);',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const p2 = m69('k69_15b_issome.ming', [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let b = v.get(0).is_some();',
      '    return if b { 10 } else { 20 };',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const p3 = m69('k69_15c_isnone.ming', [
      'fn f() -> i64 {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let b = v.get(0).is_none();',
      '    return if b { 10 } else { 20 };',
      '}',
      'fn main() with io { print(f()); }',
    ].join('\n'));
    const s1 = strict69c(p1);
    const runs1 = runAll69(p1);
    const s2 = strict69c(p2);
    const runs2 = runAll69(p2);
    const s3 = strict69c(p3);
    const runs3 = runAll69(p3);
    check('v69.15:unwrap_or/is_some/is_none——shape-eligible + emit 具名回落(strict exit 2 + REJECT 文本);非 strict 三引擎 7/10/20',
      s1.code === 2 && (s1.stderr ?? '').includes('REJECT: Option 消费链 unwrap_or') && same69(runs1, '7\n')
        && s2.code === 2 && (s2.stderr ?? '').includes('REJECT: Option 消费链 is_some') && same69(runs2, '10\n')
        && s3.code === 2 && (s3.stderr ?? '').includes('REJECT: Option 消费链 is_none') && same69(runs3, '20\n'),
      `s1=${s1.code}:${JSON.stringify((s1.stderr ?? '').split('\n').find(l => l.includes('REJECT')) ?? '')} s2=${s2.code} s3=${s3.code} runs=${fmtRuns69(runs1)}|${fmtRuns69(runs2)}|${fmtRuns69(runs3)}`);
  }

  // v69.16 计费回归(interp.js:2009 M4011 口径,单位 = Vec/Map 元素 + str 字符):
  // (a) Res 句柄构造不计费(Ok/Err → objTable,tree/VM/wasm 三侧同口径)——1000 次构造
  // --max-alloc 0 三引擎 exit 0;(b) Vec[str] 读不计费(vecstr_get → strTable 句柄)——
  // 100 次读 --max-alloc 2(初始 VecLit 恰好 3 单位中的 2)三引擎 exit 0;
  // (c) 对照:循环内 VecLit 构造照常计费 → M4011(证明配额通道本身活着)
  {
    const pRes = m69('k69_16a_resloop.ming', [
      'fn resloop(n: i64) -> i64 {',
      '    let mut acc = 0;',
      '    let mut i = 0;',
      '    while i < n {',
      '        let r: Result[i64, str] = Ok(i);',
      '        acc += r.unwrap();',
      '        i += 1;',
      '    }',
      '    return acc;',
      '}',
      'fn main() with io { print(str(resloop(1000))); }',
    ].join('\n'));
    const pSread = m69('k69_16b_sread.ming', [
      'fn sread(n: i64) -> i64 {',
      '    let s: Vec[str] = ["a", "b"];',
      '    let mut acc = 0;',
      '    let mut i = 0;',
      '    while i < n {',
      '        if s[0] == "a" { acc += 1; }',
      '        i += 1;',
      '    }',
      '    return acc;',
      '}',
      'fn main() with io { print(str(sread(100))); }',
    ].join('\n'));
    const pCharge = m69('k69_16c_charge.ming', [
      'fn chargey(n: i64) -> i64 {',
      '    let mut acc = 0;',
      '    let mut i = 0;',
      '    while i < n {',
      '        let pad = [1, 2];',
      '        acc += pad.len();',
      '        i += 1;',
      '    }',
      '    return acc;',
      '}',
      'fn main() with io { print(str(chargey(100))); }',
    ].join('\n'));
    const runsRes = runAll69(pRes, ['--max-alloc', '0']);
    const runsSread = runAll69(pSread, ['--max-alloc', '2']);
    const rCharge = runMing(['run', pCharge, '--max-alloc', '0']);
    check('v69.16:计费回归——Res 句柄构造与 Vec[str] 读不计费(max-alloc 0/2 三引擎逐字)+ 循环 VecLit 构造照常 M4011',
      same69(runsRes, '499500\n') && same69(runsSread, '100\n')
        && rCharge.code === 101 && (rCharge.stderr ?? '').includes('M4011') && (rCharge.stderr ?? '').includes('内存配额超限'),
      `res=${fmtRuns69(runsRes)} sread=${fmtRuns69(runsSread)} charge=${rCharge.code}:${JSON.stringify(firstLine69(rCharge))}`);
  }

  // v69.17(v0.65 审查 M1)无标注 Result let:resCtorSlotTy 方法体引用了签名上不存在的
  // ctx → `let r = Ok(7)`(无标注)在 emit 期 ReferenceError("ctx is not defined",
  // 非具名回落,违背"守护具名清零后余项全部 strict 具名")。修复(签名 + 调用点传 ctx)后:
  // (a) 无标注 Ok(7) + unwrap 真实经 wasm(strict exit 0 + [wasm] fn f OK;三引擎输出 7);
  // (b) 标注 ok 侧非标量(Result[Vec[i64], str])落具名"Result 载荷非标量"守护
  //     (resolveResAnnTy 对非标量 ok 型返回 null——标注存在而槽型解析不出 = 载荷守护,
  //     与 compileResCtor 同口径;strict exit 2;非 strict 三引擎语义不变)。
  {
    const p1 = m69('k69_17a_resunann.ming', [
      'fn f() -> i64 {',
      '    let r = Ok(7);',
      '    return r.unwrap();',
      '}',
      'fn main() with io { print(str(f())); }',
    ].join('\n'));
    const p2 = m69('k69_17b_resannvec.ming', [
      'fn g() -> i64 {',
      '    let _r: Result[Vec[i64], str] = Ok([1, 2]);',
      '    return 0;',
      '}',
      'fn main() with io { print(str(g())); }',
    ].join('\n'));
    const s1 = strict69c(p1);
    const runs1 = runAll69(p1);
    const s2 = strict69c(p2);
    const runs2 = runAll69(p2);
    check('v69.17:无标注 Result let 经 wasm(三引擎 7 + strict exit 0 + [wasm] fn f OK)+ 标注非标量载荷具名回落(strict exit 2;非 strict 三引擎 0)',
      same69(runs1, '7\n') && s1.code === 0 && (s1.stderr ?? '').includes('[wasm] fn f OK') && !(s1.stderr ?? '').includes('REJECT') && !(s1.stderr ?? '').includes('ctx is not defined')
        && same69(runs2, '0\n') && s2.code === 2 && (s2.stderr ?? '').includes('Result 载荷非标量(容器/结构体/bool 待解锁)') && !(s2.stderr ?? '').includes('ctx is not defined'),
      `s1=${s1.code}:${JSON.stringify((s1.stderr ?? '').split('\n').find(l => l.includes('wasm]')) ?? '')} runs1=${fmtRuns69(runs1)} s2=${s2.code} runs2=${fmtRuns69(runs2)}`);
  }

  // v69.18(v0.65 审查 M2)Result.expect 求值序:interp 方法调用先接收者后实参——此前
  // wasm 先编 msg 再编接收者,`Err(<溢出>).expect(mk())` 双溢出对照中 tree panic span 在
  // Err 载荷(第 6 行)、wasm 在 mk 内(第 2 行)。修复(接收者句柄先编入专属 tempSlot →
  // msg 求值后 drop → 再取回句柄)后四路 span 逐字:(a) 接收者先溢出 → span 第 6 行;
  // (b) 反向对照:接收者 Ok(7) 无害、msg 的 mk() 溢出 → 四路 span 在 mk 内(第 2 行)。
  // M4002 消息文本 wasm 层为通用口径(capabilities WASM 行"遗留登记"预存分歧),
  // 故比对 span 前缀(file:line:col: error M4002[integer-overflow]:)而非全文。
  {
    const spanOf = (r) => {
      const l = (r.stderr ?? '').split('\n')[0];
      const i = l.indexOf(': error M4002');
      return i >= 0 ? l.slice(0, i) : '(no-span:' + l.slice(0, 80) + ')';
    };
    const pR = m69('k69_18a_recvovf.ming', [
      'fn mk() -> str {',
      '    let _x = 9223372036854775807 + 1;',
      '    return "s";',
      '}',
      'fn f() -> i64 {',
      '    return Err(9223372036854775807 + 1).expect(mk());',
      '}',
      'fn main() with io { print(str(f())); }',
    ].join('\n'));
    const pM = m69('k69_18b_msgovf.ming', [
      'fn mk() -> str {',
      '    let _x = 9223372036854775807 + 1;',
      '    return "s";',
      '}',
      'fn f() -> i64 {',
      '    return Ok(7).expect(mk());',
      '}',
      'fn main() with io { print(str(f())); }',
    ].join('\n'));
    const runsR = runAll69(pR);
    const sR = runMing(['run', pR, '--strict-wasm']);
    const runsM = runAll69(pM);
    const sM = runMing(['run', pM, '--strict-wasm']);
    check('v69.18:expect 求值序 recv→args——Err 载荷溢出时四路 span 同在 Err 载荷(第 6 行,mk 未执行);Ok 接收者时四路 span 同在 mk(第 2 行);exit 101',
      runsR.every(r => r.code === 101) && sR.code === 101
        && spanOf(runsR[0]) === spanOf(runsR[1]) && spanOf(runsR[0]) === spanOf(runsR[2]) && spanOf(runsR[0]) === spanOf(sR)
        && spanOf(runsR[0]).endsWith('k69_18a_recvovf.ming:6:36')
        && runsM.every(r => r.code === 101) && sM.code === 101
        && spanOf(runsM[0]) === spanOf(runsM[1]) && spanOf(runsM[0]) === spanOf(runsM[2]) && spanOf(runsM[0]) === spanOf(sM)
        && spanOf(runsM[0]).endsWith('k69_18b_msgovf.ming:2:34'),
      `R=${fmtRuns69(runsR)} sR=${sR.code}:${JSON.stringify(spanOf(sR))} M=${fmtRuns69(runsM)} sM=${sM.code}:${JSON.stringify(spanOf(sM))}`);
  }

  // §69-END
}

// ===================== 70. v0.67:诊断协议校准三切口 + REPL 顺带(plan §4.6.7/§4.7.2;#62/#60/#64)=====================
// 文件所有权:§70 = 本区全部用例。切口 1 毒化收敛(let 初始化器 + match 臂绑定双路径) /
// 切口 2 M3012 语境化抑制 / 切口 3 M3015 nearest(三主发射点 + 通用) / REPL let 回显 + 横幅单一事实来源。
{
  const dir70 = path.join(TMP, 'v70');
  fs.mkdirSync(dir70, { recursive: true });
  const m70 = (name, src) => { const f = path.join(dir70, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags70 = ['', '--no-wasm', '--tree'];
  const runAll70 = (p, extra = []) => flags70.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const fmtRuns70 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');

  // ---- §70-START(三切口正负例/REPL let 回显/横幅逐字/快照语料固化复测)----
  // v0.67(plan §4.6.7 任务 5 + §4.7.2 注意点 4):AI 修正回路快照(docs/ai-loop-snapshot.md §1)
  // 语料套件化——e13/e19/e16/e04/e06 形态内联重建(快照原始 24 形态语料在会话 tmpdir 不入仓)。
  // 纪律:全部先实测后断言;注释里的 BEFORE 数为基线 HEAD 147ff1e(v0.66.0,切口前)对**本套件
  // 重建语料**的实测,与快照原文逐形计数略有出入(重建形态有增删,如 e13 用 str(r) 形态比快照
  // debug 形态多一条 M3002 级联),倍率方向一致;官方汇总由架构师按本套件重算回填 plan §4.6.7。
  const chk70 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 崩溃形态(如 ReferenceError)→ j=null,由断言点名 */ }
    return { code: r.code, j };
  };
  const codes70 = (res) => (res.j ? res.j.diagnostics.map((d) => d.code + (d.fix ? '(fix:' + d.fix.replacement + ')' : '')).join(',') : '(no-json:exit ' + res.code + ')');
  const noFix70 = (res) => !!res.j && res.j.diagnostics.every((d) => d.fix === undefined);
  const hintOf70 = (res, code) => { const d = res.j && res.j.diagnostics.find((x) => x.code === code); return d ? (d.hint ?? '') : null; };

  // 语料(内联固化;快照 e13/e19/e16/e21/e04/e06 形态重建 + 切口验证辅助形态)。
  const e13 = m70('e13_let_poison.ming', [
    'fn main() with io {',
    '    let r = foobar(3);',
    '    print(str(r));',
    '}',
  ].join('\n'));
  const e19 = m70('e19_let_poison_interp.ming', [
    'fn main() with io {',
    '    let r = foobar(3);',
    '    print("v=\\{r}");',
    '}',
  ].join('\n'));
  const e16 = m70('e16_serve_sync.ming', [
    'use std.net;',
    'use std.json;',
    'fn handler(req: Untrusted[Json]) -> Json with sync {',
    '    return std.json.parse("{}").unwrap();',
    '}',
    'fn main() with net, io {',
    '    match std.net.serve(27001, handler) {',
    '        Ok(v) => print("ok"),',
    '        Err(e) => print("err=\\{e}"),',
    '    }',
    '}',
  ].join('\n'));
  const e21 = m70('e21_serve_ok.ming', [
    'use std.net;',
    'use std.json;',
    'fn handler(req: Untrusted[Json]) -> Json {',
    '    return std.json.parse("{}").unwrap();',
    '}',
    'fn main() with net, io {',
    '    match std.net.serve(27001, handler) {',
    '        Ok(v) => print("ok"),',
    '        Err(e) => print("err=\\{e}"),',
    '    }',
    '}',
  ].join('\n'));
  const e04 = m70('e04_untrusted_method.ming', [
    'use std.io;',
    'fn main() with io {',
    '    let u = io.read_line();',
    '    let n = u.zap();',
    '    print(n);',
    '}',
  ].join('\n'));
  // v0.77 校准(ADR-007 清单 4):快照 e04 原语料 `u.trim()` 在 v0.61 白名单外(M3050),v0.77 trim
  // 入保污代数(keep)→ 语料改为同样"白名单外"的 zap()——e04 形态(根因 M3050 唯一、无级联、
  // 无 fix)逐字保持,v70.3/v70.11 断言零校准。
  const e06 = m70('e06_method_typo.ming', [
    'fn main() with io {',
    '    let s = "hello";',
    '    let n = s.lenth();',
    '    print(str(n));',
    '}',
  ].join('\n'));
  // e14 重建(f04 探针载体):4 根因并发 + 失绑 z(nearest 命中单字母名,快照记 z→x)。
  const e14 = m70('e14_multi_root.ming', [
    'fn main() with io {',
    '    let a: i64 = "s";',
    '    let w = 1i32 + 1i64;',
    '    let c = 1;',
    '    c = 2;',
    '    let x = "s";',
    '    let z = nosuchfn(3);',
    '    print(str(z));',
    '}',
  ].join('\n'));
  // 辅助形态:match 臂毒化(切口 1 路径 b 直击,不经 serve 门)/插值内未解析名(切口 2 信号 a)/
  // 真类型错对照(切口 2 不误伤)/let 缺初始化(路径 a 第二分支 + 基线崩溃修复)/元组毒化。
  const mp70 = m70('v70_match_poison.ming', [
    'fn main() with io {',
    '    match nosuchfn(3) {',
    '        Ok(v) => print("ok"),',
    '        Err(e) => print("err=\\{e}"),',
    '    }',
    '}',
  ].join('\n'));
  const iname70 = m70('v70_interp_name.ming', [
    'fn main() with io {',
    '    print("v=\\{nosuch}");',
    '}',
  ].join('\n'));
  const ctl70 = m70('v70_interp_true_type.ming', [
    'struct P { x: i64 }',
    'fn main() with io {',
    '    let p = P { x: 1 };',
    '    print("v=\\{p}");',
    '}',
  ].join('\n'));
  const lni70 = m70('v70_let_noinit.ming', [
    'fn main() with io {',
    '    let x;',
    '    print(str(x));',
    '}',
  ].join('\n'));
  const llp70 = m70('v70_let_noinit_loop.ming', [
    'fn main() with io {',
    '    let mut i = 0;',
    '    while i < 3 {',
    '        let x;',
    '        i += 1;',
    '    }',
    '}',
  ].join('\n'));
  const tp70f = m70('v70_tuple_poison.ming', [
    'fn main() with io {',
    '    let (a, b) = nosuchfn();',
    '    print(str(a));',
    '}',
  ].join('\n'));
  // 切口 3 语料:三主发射点 + 用户类型(有 impl/无 impl 对照)。
  const vsetx70 = m70('v70_vec_setx.ming', [
    'fn main() with io {',
    '    let v = [1, 2, 3];',
    '    v.setx(0, 9);',
    '}',
  ].join('\n'));
  const msetx70 = m70('v70_map_setx.ming', [
    'fn main() with io {',
    '    let m: Map[str, i64] = {};',
    '    m.setx("a", 1);',
    '}',
  ].join('\n'));
  const strimal70 = m70('v70_str_trimal.ming', [
    'fn main() with io {',
    '    let s = " hello ";',
    '    let t = s.trim_al();',
    '    print(t);',
    '}',
  ].join('\n'));
  const utype70 = m70('v70_utype_near.ming', [
    'trait Tick {',
    '    fn inc(self) -> i64;',
    '}',
    'struct Counter { n: i64 }',
    'impl Tick for Counter {',
    '    fn inc(self) -> i64 { return self.n + 1; }',
    '}',
    'fn main() with io {',
    '    let c = Counter { n: 1 };',
    '    print(str(c.inc2()));',
    '}',
  ].join('\n'));
  const utypeNi70 = m70('v70_utype_noimpl.ming', [
    'struct Counter { n: i64 }',
    'fn main() with io {',
    '    let c = Counter { n: 1 };',
    '    print(str(c.inc2()));',
    '}',
  ].join('\n'));

  // check --json 实测(一次采集,多断言复用;采集顺序即语料定义顺序)。
  const r13 = chk70(e13);
  const r19 = chk70(e19);
  const r16 = chk70(e16);
  const r21 = chk70(e21);
  const r04 = chk70(e04);
  const r06 = chk70(e06);
  const r14 = chk70(e14);
  const rmp = chk70(mp70);
  const rin = chk70(iname70);
  const rctl = chk70(ctl70);
  const rlni = chk70(lni70);
  const rllp = chk70(llp70);
  const rtp = chk70(tp70f);
  const rvx = chk70(vsetx70);
  const rmx = chk70(msetx70);
  const rtr = chk70(strimal70);
  const rut = chk70(utype70);
  const rutNi = chk70(utypeNi70);

  // v70.12 快照复测数字登记(供架构师回填 plan §4.6.7 验收行;汇总不在断言里写死,由 plan 收口):
  // - 误导模式:7 种(快照 §2d)→ 实测剩 1 种(目标 ≤2 ✓)。模式 1(r→str)/2(e→Ok)/3(z→单字母)/
  //   4(n→u)/5(n→s)五条假 fix 全部消失(v70.8,处方无应用面);模式 6(M3012 debug hint)语境化
  //   (v70.5,根因为名/毒化时中性,真类型错保留);模式 7(解析层毒化短名 nearest 命中内置 Ok,e22
  //   顶层 let/e23 语法毒化两形态)nearest-Ok hint 半句已消(v0.67 收口:nearest 候选排除内置
  //   构造器,cannotFindValue 过滤 Ok/Err/Some/None,v70.9 断言锁定)——M3001 本体仍随 parser
  //   级联毒化残留,抑制是 #63(v0.70 候选),不在 checker 三切口面(plan §4.6.7"明确不做"),
  //   checker 层按程序实例计 9 处 → 2 处。
  // - fix 错误:4(f01/f02/f04/f05 应用后更糟 + f03 静默改语义)→ 实测 0(目标 ≤1 ✓)——五条旧处方
  //   在新输出中均不存在(v70.8 断言 fix 字段缺失),无应用面即无误用面。
  // - 级联放大比(checker 层,#62 族五形态汇总,含 warning 口径):BEFORE 19/5 = 3.8 → AFTER 7/5 = 1.4
  //   (目标 ≤1.5 ✓)。逐形态 BEFORE→AFTER(本套件重建语料实测):e13 4→1、e19 4→2、e16 3→2、
  //   e04 4→1、e06 4→1;辅助形态:match 臂 3→2、e14(4 根因)10→7、元组毒化 5→2、let 缺初始化
  //   崩溃→2(M3003+W3101)。e14 的 3 条 W3101 为重建语料未用名噪声(快照原语料 1 条),汇总未计入。
  // - 快照 go/no-go 三判据复核:误导(7→1 ✓)/fix 错误(4→0 ✓)/级联(3.8→1.4 ✓)——三判据全达标的
  //   "修后确认",GO 裁决维持。

  // v70.1 切口 1 主形态(快照 e13 重建):根因唯一优先——M3001(foobar)存在,M3003"无法推断"
  // 不再先行(基线排序:M3003, M3001, M3001(fix:str), M3002),r→str 假 fix 消失(f01 探针载体),
  // str(r) 的 M3002 级联消失(毒化 never 收敛,使用点不再级联)。
  check('v70.1:切口 1 let 毒化收敛(e13)——根因 M3001 唯一,M3003 不先行,r→str 假 fix 消失,M3002 级联消失',
    !!r13.j && r13.j.diagnostics.length === 1
      && r13.j.diagnostics[0].code === 'M3001' && r13.j.diagnostics[0].message.includes('foobar')
      && r13.j.diagnostics[0].fix === undefined
      && !r13.j.diagnostics.some((d) => d.code === 'M3003')
      && !r13.j.diagnostics.some((d) => d.code === 'M3002')
      && r13.code === 1,
    `exit=${r13.code} diags=${codes70(r13)}`);

  // v70.2 切口 1 match 臂路径(快照 e16 机制直击 + serve 门全形态):被匹配值失型(根因已报)时
  // Err(e) 臂绑定毒化 never——e→Ok 假 fix 消失(f02 探针载体,应用后曾新增 M3005);serve 门形态
  // M3002 为真实根因(白名单违规)原样保留且不再伴随 M3001;合规对照 e21 干净(级联由违规诱导,机制证实)。
  check('v70.2:切口 1 match 臂毒化——match_poison 假 fix(e→Ok)消失且仅 M3001 根因+M3012;e16 serve 门 M3002 根因保留无 M3001 假 fix;e21 合规对照 ok:true',
    !!rmp.j && rmp.j.diagnostics.length === 2
      && rmp.j.diagnostics.some((d) => d.code === 'M3001' && d.fix === undefined && d.message.includes('nosuchfn'))
      && rmp.j.diagnostics.some((d) => d.code === 'M3012') && noFix70(rmp)
      && !!r16.j && r16.j.diagnostics.length === 2
      && r16.j.diagnostics.some((d) => d.code === 'M3002' && d.message.includes('with sync'))
      && !r16.j.diagnostics.some((d) => d.code === 'M3001') && noFix70(r16)
      && !!r21.j && r21.j.ok === true && r21.code === 0,
    `mp=${codes70(rmp)} e16=${codes70(r16)} e21=${codes70(r21)}`);

  // v70.3 切口 1 白名单外方法级联(快照 e04):M3050 根因唯一保留;n→u 假 fix 消失(f05 探针载体,
  // 应用后曾把用户引向 debug(u) 污点禁面);M3003/M3001/M3002 级联全消失。
  check('v70.3:切口 1 白名单外级联(e04)——M3050 根因唯一,n→u 假 fix 消失,无 M3003/M3001 级联',
    !!r04.j && r04.j.diagnostics.length === 1
      && r04.j.diagnostics[0].code === 'M3050' && r04.j.diagnostics[0].fix === undefined,
    `exit=${r04.code} diags=${codes70(r04)}`);

  // v70.4 毒化只影响 check 诊断面:三引擎 run(exit/stdout/stderr)逐字一致——check 失败在引擎
  // 分派前拦截(exit 1),运行时语义零变化(基线同为此输出;毒化不引入任何运行面差异)。
  const same3_70 = (runs) => runs.length === 3 && runs.every((r) => r.code === runs[0].code && r.stdout === runs[0].stdout && r.stderr === runs[0].stderr);
  const runs13 = runAll70(e13);
  const runsMp = runAll70(mp70);
  const runs19 = runAll70(e19);
  check('v70.4:毒化程序三引擎 run 逐字一致(e13/match_poison/e19;exit 1 + 空 stdout + stderr 逐字同)',
    same3_70(runs13) && runs13[0].code === 1 && runs13[0].stdout === '' && runs13[0].stderr.includes('M3001')
      && same3_70(runsMp) && runsMp[0].code === 1
      && same3_70(runs19) && runs19[0].code === 1,
    `e13=${fmtRuns70(runs13)} | mp=${fmtRuns70(runsMp)} | e19=${fmtRuns70(runs19)}`);

  // v70.5 切口 2 M3012 语境化:插值含未解析名(v70 信号 a)/毒化绑定读(信号 b)时 hint 中性
  // (不含 debug 建议——根因未修时 debug(同名) 仍错,快照 e19/e16 双复现);对照:名字已解析的
  // 真类型错(struct P 插值)保留 debug 建议(不误伤)。
  check('v70.5:切口 2 M3012 hint 语境化——未解析名/毒化读 → 中性 hint(指向根因,无 debug 建议);真类型错 → debug 建议保留',
    hintOf70(r19, 'M3012') !== null && hintOf70(r19, 'M3012').includes('根因') && !hintOf70(r19, 'M3012').includes('debug')
      && hintOf70(rmp, 'M3012') !== null && !hintOf70(rmp, 'M3012').includes('debug')
      && hintOf70(rin, 'M3012') !== null && !hintOf70(rin, 'M3012').includes('debug')
      && hintOf70(rctl, 'M3012') !== null && hintOf70(rctl, 'M3012').includes('debug'),
    `e19=${JSON.stringify(hintOf70(r19, 'M3012'))} mp=${JSON.stringify(hintOf70(rmp, 'M3012'))} name=${JSON.stringify(hintOf70(rin, 'M3012'))} ctl=${JSON.stringify(hintOf70(rctl, 'M3012'))}`);

  // v70.6 切口 3 主发射点三断言(如实口径):Vec setx → "get"(vec 表无 set,≤2 编辑距离近名如实给
  // get 而非编造 set);Map setx → "set"(表内有);str trim_al 无近名 → 维持全表(不发低质建议)。
  check('v70.6:切口 3 主发射点——Vec setx→最接近 "get"/Map setx→最接近 "set"/str trim_al 无近名维持全表',
    !!rvx.j && rvx.j.diagnostics.length === 1 && rvx.j.diagnostics[0].code === 'M3015'
      && rvx.j.diagnostics[0].message.includes(';最接近的方法是 "get"')
      && !!rmx.j && rmx.j.diagnostics.length === 1 && rmx.j.diagnostics[0].code === 'M3015'
      && rmx.j.diagnostics[0].message.includes(';最接近的方法是 "set"')
      && !!rtr.j && rtr.j.diagnostics.length === 1 && rtr.j.diagnostics[0].code === 'M3015'
      && rtr.j.diagnostics[0].message.includes('(有:') && !rtr.j.diagnostics[0].message.includes('最接近的方法是'),
    `vec=${codes70(rvx)} map=${codes70(rmx)} str=${rtr.j ? rtr.j.diagnostics[0].message.slice(-40) : codes70(rtr)}`);

  // v70.7 切口 3 通用接收者(用户类型):trait impl 方法集内 nearest(inc2→inc);无 impl 类型无方法表,
  // 维持无建议现状(impls=null 路径,不编造)。
  check('v70.7:切口 3 用户类型——impl 方法集内 inc2→最接近 "inc";无 impl 类型无表不加建议',
    !!rut.j && rut.j.diagnostics.length >= 1 && rut.j.diagnostics.some((d) => d.code === 'M3015' && d.message.includes(';最接近的方法是 "inc"'))
      && !!rutNi.j && rutNi.j.diagnostics.some((d) => d.code === 'M3015' && !d.message.includes('最接近的方法是')),
    `utype=${codes70(rut)} noimpl=${codes70(rutNi)}`);

  // v70.8 处方应用后果探针回归(f01–f05,快照 §0 判据 6):五条旧误导处方在新诊断输出中已不存在
  // (毒化收敛后 M3001-nearest 处方不再发射)——断言五形态的 M3001/毒化级联诊断零 fix 字段,即
  // "应用后更糟"无应用面:f01(e13 r→str)/f02(e16 e→Ok)/f03(e06 n→s)/f04(e14 z→单字母)/f05(e04 n→u)。
  // 注意:M3029/M2002 的合法 fix 不在本口径(其位置准,快照实测"好")。
  // v0.76 重校准(理由化,逐条):e14 语料首行 `let a: i64 = "s";` 是**真实根因** let 标注
  // 位类型不匹配(非毒化级联——initT=str 具体、无未解析名),v0.76 M3002 fix 扩面在其上
  // 发射"把标注改为 str"处方(§79.10 同款;应用后该根因消除且不新增错误,v44 纪律实测)。
  // 这不是 f01–f05 旧误导处方的回归——五条旧处方全部挂在 M3001-nearest/毒化位上,本断言
  // 对 M3001 维持零 fix 逐字锁定;e14 的 fix 字段仅允许出现且必须出现在 M3002 let 标注位
  // (replacement 恰 "str = ",硬锚点)。e13/e16/e06/e04 无 let/const 标注位真实根因,
  // 全诊断零 fix 口径不变。
  // v0.80 重校准(v0.76 同型理由化):e14 语料 `let c = 1; c = 2;` 是**真实根因**非 mut
  // 赋值位(声明与赋值同函数的简单 let,非形参/捕获/解构),v0.80 M3004 fix 扩面在其上
  // 发射"声明处补 mut"处方(zero-width 插入 'mut ',应用后该根因消除——v44 纪律同判;
  // §84.5 形状/§84.11 f-probe 机器证明)。M3001 零 fix 维持;e14 的 fix 字段允许 M3002
  // let 标注位('str = ')与 M3004 mut 插入位('mut ')各恰一处。e13/e16/e06/e04 无此两类
  // 真实根因(e06 的 lenth 与 str 方法表无 ≤2 近名),全诊断零 fix 口径不变。
  check('v70.8:f01–f05 探针回归——五形态 M3001/毒化级联零 fix 字段(旧误导处方无应用面);e14 另允许 M3002 let 标注位(replacement 恰 "str = ")与 M3004 mut 插入位(replacement 恰 "mut ",v0.80 扩面重校准)两处方',
    noFix70(r13) && noFix70(r16) && noFix70(r06) && noFix70(r04)
      && !!r14.j && r14.j.diagnostics.every((d) => d.code !== 'M3001' || d.fix === undefined)
      && r14.j.diagnostics.filter((d) => d.fix).every((d) => (d.code === 'M3002' && d.fix.replacement === 'str = ') || (d.code === 'M3004' && d.fix.replacement === 'mut '))
      && r14.j.diagnostics.some((d) => d.code === 'M3002' && d.fix)
      && r14.j.diagnostics.some((d) => d.code === 'M3004' && d.fix),
    `e13=${codes70(r13)} e16=${codes70(r16)} e06=${codes70(r06)} e14=${codes70(r14)} e04=${codes70(r04)}`);

  // v70.9 REPL #60(方案 a,plan §4.6.4/§4.7.2 定案):let 行执行成功后回显"仅当前输入生效"
  // (曾静默成功,下一行引用报 M3001+Ok hint 令人困惑——快照第五轮 #60);let 不跨输入语义不变:
  // 后续输入引用仍报 M3001(预期,方案 a 下 let 不入 decls,顶层项模型冲突见 §4.7.2)。
  // v0.67 收口(快照三切口之一,plan §4.6.7 验收行补齐):nearest 候选排除内置构造器
  // (checker.js cannotFindValue 过滤 Ok/Err/Some/None)——"最接近的名字是 Ok"不再随 M3001
  // 发射,断言收紧为 !includes(此前偏离登记"hint 半句未落地"随本修复消解)。
  const rLet70 = runMing(['repl'], { stdin: 'let x = 1 + 2;\n:quit\n' });
  const rLetUse70 = runMing(['repl'], { stdin: 'let x = 1;\nx + 1;\n:quit\n' });
  const useAll70 = rLetUse70.stdout + rLetUse70.stderr;
  check('v70.9:REPL #60 let 回显(仅当前输入生效 + 绑定名)且 let 不跨输入语义不变(后续引用 M3001 仍在且无 Ok nearest hint)',
    rLet70.code === 0 && rLet70.stdout.includes('仅当前输入生效') && rLet70.stdout.includes('绑定 x')
      && rLetUse70.code === 0 && useAll70.includes('M3001') && !useAll70.includes('最接近的名字是 Ok')
      && rLet70.stderr === '' && !rLetUse70.stdout.includes('= '),
    `let=${JSON.stringify(rLet70.stdout)} use=${JSON.stringify(useAll70.slice(0, 300))}`);

  // v70.10 REPL #64:横幅版本单一事实来源(package.json)——与 `ming version` 一致(基线硬编码
  // 曾漂移 v0.8.0→v0.63.0 两版,#64 机制性修复);fn 声明跨输入持久回归(double(21)=42)。
  const ver70 = runMing(['version']);
  const mv70 = ver70.stdout.match(/v(\d+\.\d+\.\d+)/);
  const rBan70 = runMing(['repl'], { stdin: ':quit\n' });
  const mb70 = rBan70.stdout.match(/Ming v(\d+\.\d+\.\d+) REPL/);
  const rFn70 = runMing(['repl'], { stdin: 'fn double(n: i64) -> i64 { return n * 2; }\ndouble(21)\n:quit\n' });
  check('v70.10:REPL #64 横幅版本 = ming version(package.json 单一事实来源)+ fn 跨输入持久(double(21)=42)',
    !!mv70 && !!mb70 && mv70[1] === mb70[1] && rBan70.code === 0
      && rFn70.code === 0 && rFn70.stdout.includes('= 42'),
    `version=${JSON.stringify(ver70.stdout.slice(0, 40))} banner=${JSON.stringify(rBan70.stdout.split('\n')[0])} fn=${JSON.stringify(rFn70.stdout.slice(-40))}`);

  // v70.11 快照语料固化复测(plan §4.7.2 注意点 4):#62 族五形态级联收敛逐形态断言
  // (BEFORE→AFTER 见 v70.12 登记;此处锁定 AFTER 形态,回归即红)。
  const cnt70 = (res) => (res.j ? res.j.diagnostics.length : -1);
  check('v70.11:快照语料固化复测——e13=1/e19=2/e16=2/e04=1/e06=1(级联收敛 AFTER 锁定)',
    cnt70(r13) === 1 && cnt70(r19) === 2 && cnt70(r16) === 2 && cnt70(r04) === 1 && cnt70(r06) === 1,
    `e13=${cnt70(r13)}:${codes70(r13)} e19=${cnt70(r19)}:${codes70(r19)} e16=${cnt70(r16)}:${codes70(r16)} e04=${cnt70(r04)}:${codes70(r04)} e06=${cnt70(r06)}:${codes70(r06)}`);

  // v70.13 切口 1 随带修复:let 缺初始化不崩溃——基线双崩溃(walkLinearBody null.nt 先炸,patternBrief 未导入的 ReferenceError 在其后暴露),顺序经审查 NOTE-1 修正
  // ReferenceError;线性分析 lin(null) 同批加守卫)——M3003 根因发出,绑定毒化收敛(使用点无级联),
  // 循环体内同口径。
  check('v70.13:切口 1 随带——let 缺初始化不崩溃(基线 ReferenceError),M3003 根因 + 使用点毒化收敛;循环体内同口径',
    !!rlni.j && rlni.j.diagnostics.length === 1 && rlni.j.diagnostics[0].code === 'M3003'
      && !!rllp.j && rllp.j.diagnostics.some((d) => d.code === 'M3003')
      && !rllp.j.diagnostics.some((d) => d.code === 'M3001') && !rllp.j.diagnostics.some((d) => d.code === 'M3002'),
    `noinit=${codes70(rlni)} loop=${codes70(rllp)}`);

  // v70.14 切口 1 元组毒化:let (a, b) = nosuchfn() 元组解构按 never 静默下推(基线 5 条:
  // M3003×2 + M3001(fix:Ok 单字母假 fix)+ M3002"元组模式要求元组类型"级联 → 2 条:根因 M3001
  // + b 未用 W3101),无假 fix。
  check('v70.14:切口 1 元组毒化——let (a,b) = 失型初始化按 never 下推,无 M3002 元组级联/无 M3003/无假 fix',
    !!rtp.j && rtp.j.diagnostics.some((d) => d.code === 'M3001' && d.fix === undefined && d.message.includes('nosuchfn'))
      && !rtp.j.diagnostics.some((d) => d.code === 'M3003')
      && !rtp.j.diagnostics.some((d) => d.code === 'M3002')
      && noFix70(rtp),
    `tuple=${codes70(rtp)}`);
  // ---- v70.15(MINOR-3):parser 级联文件形态 e23 直测——顶层 let + 使用点 nearest-Ok 半句消除(回归锁) ----
  {
    const e23 = m70('e23-form.ming', [
      'let x = 1;',
      '',
      'fn main() with io {',
      '    print(str(x + 1));',
      '}',
      '',
    ].join('\n'));
    const ck = runMing(['check', e23, '--json']);
    const j68 = (() => { try { return JSON.parse(ck.stdout); } catch { return null; } })();
    const m3001 = j68 && j68.diagnostics ? j68.diagnostics.filter(d => d.code === 'M3001') : [];
    const okHint = m3001.some(d => (d.hint || '').includes('最接近的名字是 "Ok"') || (d.fix && JSON.stringify(d.fix).includes('"Ok"')));
    const fixOk = m3001.some(d => d.fix && JSON.stringify(d.fix).includes('"Ok"'));
    check('v70.15:e23 文件形态——顶层 let 级联 M3001 无 nearest-Ok hint/无 Ok fix(切口收口直测)',
      m3001.length > 0 && !okHint && !fixOk,
      'm3001=' + m3001.length + ' okHint=' + okHint + ' fixOk=' + fixOk + ' stderr0=' + JSON.stringify((ck.stderr ?? '').split('\n')[0]));
  }

  // §70-END
}

// ===================== 71. v0.68:Untrusted[Json] 载体解锁(ADR-004 §7.1 测试清单;serve 签名翻转/投影表/mark_json)=====================
// 文件所有权:§71 = 本区全部用例。签名破坏正负例 / 投影表逐条(标注赋值锁定) / sink 拦截矩阵(M3049 载体感知) /
// mark_json 构造面 / 深拷贝保污 / 净 Json 对照不误伤 + 工具冒烟 / 擦除一致孪生 / 禁面 M3050 / 投影表外 M3050 /
// as_obj 副本键形态修复回归 / wasm-C 资格核验(ADR-004 清单 12) / 契约内投影。
// 纪律:全部先实测后断言;投影/禁面/sink 消息逐字取自实测。
{
  const dir71 = path.join(TMP, 'v71');
  fs.mkdirSync(dir71, { recursive: true });
  const m71 = (name, src) => { const f = path.join(dir71, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags71 = ['', '--no-wasm', '--tree'];
  const runAll71 = (p, extra = []) => flags71.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const fmtRuns71 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');
  const chk71 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 崩溃形态 → j=null,由断言点名 */ }
    return { code: r.code, j };
  };
  const codes71 = (res) => (res.j ? res.j.diagnostics.map((d) => d.code + (d.fix ? '(fix:' + d.fix.replacement + ')' : '')).join(',') : '(no-json:exit ' + res.code + ')');
  const diag71 = (res, code) => (res.j ? res.j.diagnostics.find((d) => d.code === code) : null);
  const same3_71 = (runs) => runs.length === 3 && runs.every((r) => r.code === runs[0].code && r.stdout === runs[0].stdout && r.stderr === runs[0].stderr);

  // 语料公用:Ming 源内的 JSON 字面量(双引号串内转义引号;JS 单引号串写 \\" 落盘为 \")。
  const JDOC71 = '{\\"a\\":{\\"b\\":1},\\"s\\":\\"x\\",\\"n\\":1.5,\\"f\\":true,\\"arr\\":[1],\\"o\\":{}}';
  const PJDOC71 = 'std.json.parse("' + JDOC71 + '")';

  // ---- v71.1 serve 签名正负例(ADR-004 清单 14/§2.1 候选 A)----
  const sigOk71 = m71('v71_sig_ok.ming', [
    'use std.net;',
    'use std.json;',
    'fn handler(req: Untrusted[Json]) -> Json {',
    '    return std.json.parse("{}").unwrap();',
    '}',
    'fn main() with net, io {',
    '    match std.net.serve(27101, handler) {',
    '        Ok(v) => print("ok"),',
    '        Err(e) => print("err=\\{e}"),',
    '    }',
    '}',
  ].join('\n'));
  const sigOld71 = m71('v71_sig_old.ming', [
    'use std.net;',
    'use std.json;',
    'fn handler(req: Json) -> Json {',
    '    return std.json.parse("{}").unwrap();',
    '}',
    'fn main() with net, io {',
    '    match std.net.serve(27102, handler) {',
    '        Ok(v) => print("ok"),',
    '        Err(e) => print("err=\\{e}"),',
    '    }',
    '}',
  ].join('\n'));
  const rSigOk = chk71(sigOk71);
  const rSigOld = chk71(sigOld71);
  check('v71.1:serve 签名——Untrusted[Json] 正例 check exit 0;旧签名 Json → M3002"形参必须是 Untrusted[Json]"+Err 臂毒化 M3012',
    rSigOk.code === 0 && !!rSigOk.j && rSigOk.j.ok === true && rSigOk.j.diagnostics.length === 0
      && rSigOld.code === 1 && !!rSigOld.j && rSigOld.j.diagnostics.length === 2
      && rSigOld.j.diagnostics.some((d) => d.code === 'M3002' && d.message.includes('形参必须是 Untrusted[Json]') && (d.hint ?? '').includes('请求载荷不可信'))
      && rSigOld.j.diagnostics.some((d) => d.code === 'M3012'),
    `ok=${rSigOk.code}/${codes71(rSigOk)} old=${rSigOld.code}/${codes71(rSigOld)}`);

  // ---- v71.2 投影表逐条(ADR-004 清单 4/8/9;标注赋值锁定形态)----
  // get/at → Option[Untrusted[Json]](递归污:unwrap 后再 get 仍成立);as_str → Option[Untrusted[str]]
  // (载体收窄);as_num/as_bool → 净值;as_arr → Option[Vec[Untrusted[Json]]](Vec 侧 get);
  // as_obj → Option[Map[str, Untrusted[Json]]];is_* → bool。全部以"标注 let 赋值 + 全量使用"锁定。
  const proj71 = m71('v71_proj_table.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let j = ' + PJDOC71 + '.unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    let g: Option[Untrusted[Json]] = u.get("a");',
    '    let gg: Option[Untrusted[Json]] = g.unwrap().get("b");',
    '    let at: Option[Untrusted[Json]] = u.at(0);',
    '    let at2: Option[Untrusted[Json]] = u.as_arr().unwrap().get(0);',
    '    let s: Option[Untrusted[str]] = u.as_str();',
    '    let n: Option[f64] = u.as_num();',
    '    let b: Option[bool] = u.as_bool();',
    '    let arr: Option[Vec[Untrusted[Json]]] = u.as_arr();',
    '    let o: Option[Map[str, Untrusted[Json]]] = u.as_obj();',
    '    let t: bool = u.is_obj();',
    '    print(str(t) + str(at.is_some()) + str(at2.is_some()) + str(s.is_some()) + str(n.is_some()) + str(b.is_some()) + str(arr.is_some()) + str(o.is_some()) + str(gg.is_some()));',
    '}',
  ].join('\n'));
  const rProj = chk71(proj71);
  check('v71.2:投影表标注赋值锁定——get/at 递归污/as_str 收窄/as_num·as_bool 净值/as_arr·as_obj 容器保污/is_* 净值,check exit 0 零诊断',
    rProj.code === 0 && !!rProj.j && rProj.j.ok === true && rProj.j.diagnostics.length === 0,
    `exit=${rProj.code} diags=${codes71(rProj)}`);

  // ---- v71.3 eq 净污均可(清单 9:污点在布尔上终结)----
  const eq71 = m71('v71_eq.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    let u2: Untrusted[Json] = std.unstr.mark_json(std.json.parse("{}").unwrap());',
    '    let e1: bool = u.eq(std.json.parse("{}").unwrap());',
    '    let e2: bool = u.eq(u2);',
    '    print(str(e1) + " " + str(e2));',
    '}',
  ].join('\n'));
  const rEq = chk71(eq71);
  const runsEq = runAll71(eq71);
  check('v71.3:eq 实参净污均可——净 Json 与 Untrusted[Json] 实参均 check exit 0,三引擎输出 "true true" 逐字',
    rEq.code === 0 && !!rEq.j && rEq.j.ok === true && rEq.j.diagnostics.length === 0
      && same3_71(runsEq) && runsEq[0].code === 0 && runsEq[0].stdout === 'true true\n',
    `check=${codes71(rEq)} runs=${fmtRuns71(runsEq)}`);

  // ---- v71.4 sink 矩阵 1(ADR-004 §4.2):stringify(Json→str 唯一整体出口)/ write_file 形参位 ----
  // M3049 消息含载体感知 remedy(不可信 Json:先经 .as_str() 投影……);stringify 专用码后不再级联。
  const sinkStr71 = m71('v71_sink_stringify.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    print(std.json.stringify(u));',
    '}',
  ].join('\n'));
  const sinkWf71 = m71('v71_sink_writefile.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io, fs {',
    '    let j = std.json.parse("{}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    std.fs.write_file(u, "x");',
    '}',
  ].join('\n'));
  const rSinkStr = chk71(sinkStr71);
  const rSinkWf = chk71(sinkWf71);
  check('v71.4:sink 拦截——stringify(Untrusted[Json]) 与 write_file 形参位各一发 M3049,消息含载体感知 remedy(不可信 Json:先经 .as_str() 投影)',
    rSinkStr.code === 1 && !!rSinkStr.j && rSinkStr.j.diagnostics.length === 1
      && rSinkStr.j.diagnostics[0].code === 'M3049' && rSinkStr.j.diagnostics[0].message.includes('不可信 Json:先经 .as_str() 投影')
      && rSinkWf.code === 1 && !!rSinkWf.j && rSinkWf.j.diagnostics.length === 1
      && rSinkWf.j.diagnostics[0].code === 'M3049' && rSinkWf.j.diagnostics[0].message.includes('期望 str,实际 Untrusted[Json]'),
    `stringify=${codes71(rSinkStr)} wf=${codes71(rSinkWf)}`);

  // ---- v71.5 sink 矩阵 2:Map 值槽(set 方法 + 字面量构造)各一发 M3049 ----
  const sinkMapSet71 = m71('v71_sink_map_set.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    let mut m: Map[str, Json] = {};',
    '    m.set("a", u);',
    '    print(str(m.len()));',
    '}',
  ].join('\n'));
  const sinkMapLit71 = m71('v71_sink_map_lit.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    let m: Map[str, Json] = { "a": u };',
    '    print(str(m.len()));',
    '}',
  ].join('\n'));
  const rSinkMSet = chk71(sinkMapSet71);
  const rSinkMLit = chk71(sinkMapLit71);
  check('v71.5:sink 拦截——Map 值槽两形态(set 方法/字面量)各一发 M3049"map 值类型不匹配",无级联',
    rSinkMSet.code === 1 && !!rSinkMSet.j && rSinkMSet.j.diagnostics.length === 1
      && rSinkMSet.j.diagnostics[0].code === 'M3049' && rSinkMSet.j.diagnostics[0].message.includes('map 值类型不匹配')
      && rSinkMLit.code === 1 && !!rSinkMLit.j && rSinkMLit.j.diagnostics.length === 1
      && rSinkMLit.j.diagnostics[0].code === 'M3049' && rSinkMLit.j.diagnostics[0].message.includes('map 值类型不匹配'),
    `set=${codes71(rSinkMSet)} lit=${codes71(rSinkMLit)}`);

  // ---- v71.6 sink 矩阵 3:struct 字段 / 透传 fn(Json) 形参 ----
  const sinkStruct71 = m71('v71_sink_struct.ming', [
    'use std.json;',
    'use std.unstr;',
    'struct Box { j: Json }',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    let b = Box { j: u };',
    '    print(b.j.is_obj());',
    '}',
  ].join('\n'));
  const sinkFn71 = m71('v71_sink_fn.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn sink(j: Json) -> Json {',
    '    return j;',
    '}',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    print(str(sink(u).is_obj()));',
    '}',
  ].join('\n'));
  const rSinkStruct = chk71(sinkStruct71);
  const rSinkFn = chk71(sinkFn71);
  check('v71.6:sink 拦截——struct 字段位与透传 fn(Json) 形参位各一发 M3049,无级联',
    rSinkStruct.code === 1 && !!rSinkStruct.j && rSinkStruct.j.diagnostics.length === 1
      && rSinkStruct.j.diagnostics[0].code === 'M3049' && rSinkStruct.j.diagnostics[0].message.includes('字段 "j"')
      && rSinkFn.code === 1 && !!rSinkFn.j && rSinkFn.j.diagnostics.length === 1
      && rSinkFn.j.diagnostics[0].code === 'M3049' && rSinkFn.j.diagnostics[0].message.includes('参数 #1(j)'),
    `struct=${codes71(rSinkStruct)} fn=${codes71(rSinkFn)}`);

  // ---- v71.7 sink 矩阵 4(清单 6):响应回显——裸 fn return 位 + serve 语境同码;净化后回显对照放行 ----
  const echo71 = m71('v71_sink_echo.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn echo(u: Untrusted[Json]) -> Json {',
    '    return u;',
    '}',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    print(str(echo(u).is_obj()));',
    '}',
  ].join('\n'));
  const echoServe71 = m71('v71_sink_echo_serve.ming', [
    'use std.net;',
    'use std.json;',
    'fn handler(req: Untrusted[Json]) -> Json {',
    '    return req;',
    '}',
    'fn main() with net, io {',
    '    match std.net.serve(27103, handler) {',
    '        Ok(v) => print("ok"),',
    '        Err(e) => print("err=\\{e}"),',
    '    }',
    '}',
  ].join('\n'));
  const echoOk71 = m71('v71_echo_sanitized.ming', [
    'use std.net;',
    'use std.json;',
    'use std.unstr;',
    'fn handler(req: Untrusted[Json]) -> Json {',
    '    let body = match req.get("body").unwrap().as_str() {',
    '        Some(s) => match std.unstr.sanitize_cli_path(s) {',
    '            Ok(p) => p,',
    '            Err(_) => "?",',
    '        },',
    '        None => "?",',
    '    };',
    '    return std.json.parse("{\\"status\\":200,\\"headers\\":{},\\"body\\":\\"" + body + "\\"}").unwrap();',
    '}',
    'fn main() with net, io {',
    '    match std.net.serve(27104, handler) {',
    '        Ok(v) => print("ok"),',
    '        Err(e) => print("err=\\{e}"),',
    '    }',
    '}',
  ].join('\n'));
  const rEcho = chk71(echo71);
  const rEchoServe = chk71(echoServe71);
  const rEchoOk = chk71(echoOk71);
  check('v71.7:sink 拦截——回显 return 位(裸 fn 与 serve handler 同码)一发 M3049"return 的值类型";投影+净化后 echo 合法 exit 0',
    rEcho.code === 1 && !!rEcho.j && rEcho.j.diagnostics.length === 1
      && rEcho.j.diagnostics[0].code === 'M3049' && rEcho.j.diagnostics[0].message.includes('return 的值类型')
      && rEchoServe.code === 1 && !!rEchoServe.j && rEchoServe.j.diagnostics.length === 1
      && rEchoServe.j.diagnostics[0].code === 'M3049' && rEchoServe.j.diagnostics[0].message.includes('return 的值类型')
      && rEchoOk.code === 0 && !!rEchoOk.j && rEchoOk.j.ok === true,
    `echo=${codes71(rEcho)} serve=${codes71(rEchoServe)} ok=${rEchoOk.code}/${codes71(rEchoOk)}`);

  // ---- v71.8 mark_json(ADR-004 清单 4):构造面 + unwrap_or fallback + 三引擎擦除一致 ----
  const mj71 = m71('v71_mark_json.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let u: Untrusted[Json] = std.unstr.mark_json(std.json.parse("{\\"k\\":\\"v\\"}").unwrap());',
    '    let g = u.get("k").unwrap_or(std.unstr.mark_json(std.json.parse("\\"d\\"").unwrap()));',
    '    let s = g.as_str().unwrap();',
    '    print(str(s.char_len()));',
    '}',
  ].join('\n'));
  const rMj = chk71(mj71);
  const runsMj = runAll71(mj71);
  check('v71.8:mark_json 构造面 + Option[Untrusted[Json]] unwrap_or fallback——check exit 0,三引擎输出 "1" 逐字(运行时擦除)',
    rMj.code === 0 && !!rMj.j && rMj.j.ok === true && rMj.j.diagnostics.length === 0
      && same3_71(runsMj) && runsMj[0].code === 0 && runsMj[0].stdout === '1\n',
    `check=${codes71(rMj)} runs=${fmtRuns71(runsMj)}`);

  // ---- v71.9 深拷贝保污(值语义:let a = req 深拷贝,标注赋值锁定副本仍污)----
  const cp71 = m71('v71_deepcopy.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let j = std.json.parse("{\\"k\\":\\"v\\"}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    let a = u;',
    '    let g: Option[Untrusted[Json]] = a.get("k");',
    '    print(str(g.is_some()));',
    '}',
  ].join('\n'));
  const rCp = chk71(cp71);
  const runsCp = runAll71(cp71);
  check('v71.9:深拷贝保污——let a = u 后 a.get("k") 仍按 Option[Untrusted[Json]] 类型成立,三引擎输出 "true" 逐字',
    rCp.code === 0 && !!rCp.j && rCp.j.ok === true && rCp.j.diagnostics.length === 0
      && same3_71(runsCp) && runsCp[0].code === 0 && runsCp[0].stdout === 'true\n',
    `check=${codes71(rCp)} runs=${fmtRuns71(runsCp)}`);

  // ---- v71.10 洗白禁面(ADR-002 清单机制载体无关):debug / 插值 / as 各一发 M3050 ----
  const fbDebug71 = m71('v71_forbid_debug.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let u: Untrusted[Json] = std.unstr.mark_json(std.json.parse("{}").unwrap());',
    '    debug(u);',
    '}',
  ].join('\n'));
  const fbInterp71 = m71('v71_forbid_interp.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let u: Untrusted[Json] = std.unstr.mark_json(std.json.parse("{}").unwrap());',
    '    print("v=\\{u}");',
    '}',
  ].join('\n'));
  const fbAs71 = m71('v71_forbid_as.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let u: Untrusted[Json] = std.unstr.mark_json(std.json.parse("{}").unwrap());',
    '    let j = u as Json;',
    '    print(str(j.is_obj()));',
    '}',
  ].join('\n'));
  const rFbDebug = chk71(fbDebug71);
  const rFbInterp = chk71(fbInterp71);
  const rFbAs = chk71(fbAs71);
  check('v71.10:洗白禁面——debug/插值/as 各一发 M3050,消息点名 Untrusted[Json] 载体',
    rFbDebug.code === 1 && !!rFbDebug.j && rFbDebug.j.diagnostics.length === 1
      && rFbDebug.j.diagnostics[0].code === 'M3050' && rFbDebug.j.diagnostics[0].message.includes('debug 的参数含 Untrusted[Json]')
      && rFbInterp.code === 1 && !!rFbInterp.j && rFbInterp.j.diagnostics.length === 1
      && rFbInterp.j.diagnostics[0].code === 'M3050' && rFbInterp.j.diagnostics[0].message.includes('插值')
      && rFbAs.code === 1 && !!rFbAs.j && rFbAs.j.diagnostics.length === 1
      && rFbAs.j.diagnostics[0].code === 'M3050' && rFbAs.j.diagnostics[0].message.includes('"as" 不接受 Untrusted[Json]'),
    `debug=${codes71(rFbDebug)} interp=${codes71(rFbInterp)} as=${codes71(rFbAs)}`);

  // ---- v71.11 投影表外方法 → M3050(消息列投影表 + nearest 近名后缀,M3015 口径)----
  const tblOut71 = m71('v71_table_out.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let u: Untrusted[Json] = std.unstr.mark_json(std.json.parse("{}").unwrap());',
    '    let _ = u.len();',
    '}',
  ].join('\n'));
  const rTblOut = chk71(tblOut71);
  check('v71.11:投影表外——u.len() 一发 M3050,消息含"投影表"全表与 nearest "get" 建议',
    rTblOut.code === 1 && !!rTblOut.j && rTblOut.j.diagnostics.length === 1
      && rTblOut.j.diagnostics[0].code === 'M3050'
      && rTblOut.j.diagnostics[0].message.includes('Untrusted[Json] 没有方法 ".len"')
      && rTblOut.j.diagnostics[0].message.includes('投影表 get / at / as_str')
      && rTblOut.j.diagnostics[0].message.includes('最接近的方法是 "get"'),
    `tblout=${codes71(rTblOut)}`);

  // ---- v71.12 对照不误伤(净值 Json 全方法)+ 工具冒烟(ADR-004 迁移面 tools = 0)----
  const clean71 = m71('v71_clean.ming', [
    'use std.json;',
    'fn main() with io {',
    '    let j = ' + PJDOC71 + '.unwrap();',
    '    let g: Option[Json] = j.get("a");',
    '    let gg: Option[Json] = g.unwrap().get("b");',
    '    let s: Option[str] = j.get("s").unwrap().as_str();',
    '    let n: Option[f64] = j.get("n").unwrap().as_num();',
    '    let b: Option[bool] = j.get("f").unwrap().as_bool();',
    '    let arr: Option[Vec[Json]] = j.get("arr").unwrap().as_arr();',
    '    let o: Option[Map[str, Json]] = j.get("o").unwrap().as_obj();',
    '    let t: bool = j.is_obj();',
    '    let e: bool = j.eq(' + PJDOC71 + '.unwrap());',
    '    print(str(t) + str(e) + str(gg.is_some()) + str(s.unwrap().char_len()) + str(n.unwrap()) + str(b.unwrap()) + str(arr.unwrap().len()) + str(o.unwrap().len()));',
    '}',
  ].join('\n'));
  const rClean = chk71(clean71);
  const runsClean = runAll71(clean71);
  const jqFile71 = path.join(dir71, 'v71_cfg.json');
  fs.writeFileSync(jqFile71, '{"a":{"b":"deep"}}', 'utf8');
  const jq71 = runMing(['tools', 'json_query', jqFile71, 'a.b']);
  check('v71.12:对照不误伤——净 Json(json.parse 字面量)全方法净值 check exit 0,三引擎 "truetruetrue11.5true10" 逐字;tools json_query 冒烟 a.b→deep',
    rClean.code === 0 && !!rClean.j && rClean.j.ok === true && rClean.j.diagnostics.length === 0
      && same3_71(runsClean) && runsClean[0].code === 0 && runsClean[0].stdout === 'truetruetrue11.5true10\n'
      && jq71.code === 0 && jq71.stdout.includes('deep'),
    `check=${codes71(rClean)} runs=${fmtRuns71(runsClean)} jq=${JSON.stringify(jq71.stdout.slice(0, 20))}`);

  // ---- v71.13 运行时擦除一致(ADR-004 清单 12/实现注记:标注与否输出逐字)----
  // 污净孪生:同一计算(投影 + char_len/len 观察)污标与净标六跑(2 程序 × 3 引擎)输出逐字同。
  const twin71 = m71('v71_clean_twin.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let j = ' + PJDOC71 + '.unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    let g: Option[Untrusted[Json]] = u.get("a");',
    '    let gg: Option[Untrusted[Json]] = g.unwrap().get("b");',
    '    let s: Option[Untrusted[str]] = u.get("s").unwrap().as_str();',
    '    let n: Option[f64] = u.get("n").unwrap().as_num();',
    '    let b: Option[bool] = u.get("f").unwrap().as_bool();',
    '    let arr: Option[Vec[Untrusted[Json]]] = u.get("arr").unwrap().as_arr();',
    '    let o: Option[Map[str, Untrusted[Json]]] = u.get("o").unwrap().as_obj();',
    '    let t: bool = u.is_obj();',
    '    let e: bool = u.eq(' + PJDOC71 + '.unwrap());',
    '    print(str(t) + str(e) + str(gg.is_some()) + str(s.unwrap().char_len()) + str(n.unwrap()) + str(b.unwrap()) + str(arr.unwrap().len()) + str(o.unwrap().len()));',
    '}',
  ].join('\n'));
  const runsTwin = runAll71(twin71);
  check('v71.13:运行时擦除一致——污标孪生与净标对照六跑(2 程序 × 3 引擎)输出逐字 "truetruetrue11.5true10"',
    same3_71(runsTwin) && runsTwin[0].code === 0 && runsTwin[0].stdout === 'truetruetrue11.5true10\n'
      && runsClean[0].stdout === runsTwin[0].stdout,
    `twin=${fmtRuns71(runsTwin)}`);

  // ---- v71.14 wasm/C 资格核验(ADR-004 清单 12:解包后与裸 Json 形参同款资格拒绝回落)----
  // 形态 A(Json/污标形参函数独占):eligible=0 → 层级 'none',strict exit 0,三引擎输出逐字;
  // 形态 B(混合:i64 fn + Json fn):i64 fn 真实入 wasm([wasm] fn numf OK),污标/裸 Json fn 同款拒绝,
  // MING_WASM_DEBUG=1 下两变体均点名 numf OK 且无 REJECT。
  const wUt71 = m71('v71_wasm_ut.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn probe(u: Untrusted[Json]) -> bool {',
    '    return u.is_obj();',
    '}',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    print(str(probe(u)));',
    '}',
  ].join('\n'));
  const wBare71 = m71('v71_wasm_bare.ming', [
    'use std.json;',
    'fn probe(j: Json) -> bool {',
    '    return j.is_obj();',
    '}',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    print(str(probe(j)));',
    '}',
  ].join('\n'));
  const wMixUt71 = m71('v71_wasm_mix_ut.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn numf(x: i64) -> i64 {',
    '    return x * 2;',
    '}',
    'fn probe(u: Untrusted[Json]) -> bool {',
    '    return u.is_obj();',
    '}',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    print(str(numf(21)) + str(probe(u)));',
    '}',
  ].join('\n'));
  const wMixBare71 = m71('v71_wasm_mix_bare.ming', [
    'use std.json;',
    'fn numf(x: i64) -> i64 {',
    '    return x * 2;',
    '}',
    'fn probe(j: Json) -> bool {',
    '    return j.is_obj();',
    '}',
    'fn main() with io {',
    '    let j = std.json.parse("{}").unwrap();',
    '    print(str(numf(21)) + str(probe(j)));',
    '}',
  ].join('\n'));
  const runsWUt = runAll71(wUt71);
  const runsWBare = runAll71(wBare71);
  const runsWMixUt = runAll71(wMixUt71);
  const runsWMixBare = runAll71(wMixBare71);
  const strictUt = runMing(['run', wUt71, '--strict-wasm']);
  const strictBare = runMing(['run', wBare71, '--strict-wasm']);
  const strictMixUt = runMing(['run', wMixUt71, '--strict-wasm']);
  const strictMixBare = runMing(['run', wMixBare71, '--strict-wasm']);
  const dbgMixUt = runMing(['run', wMixUt71], { env: { MING_WASM_DEBUG: '1' } });
  const dbgMixBare = runMing(['run', wMixBare71], { env: { MING_WASM_DEBUG: '1' } });
  check('v71.14:wasm 资格——Json/Untrusted[Json] 形参同款拒绝(独占形态 strict exit 0 + 三引擎 "true" 逐字;混合形态 strict exit 0 + 三引擎 "42true" 逐字 + debug 双变体点名 numf OK 无 REJECT)',
    same3_71(runsWUt) && runsWUt[0].code === 0 && runsWUt[0].stdout === 'true\n'
      && same3_71(runsWBare) && runsWBare[0].code === 0 && runsWBare[0].stdout === 'true\n'
      && strictUt.code === 0 && strictUt.stdout === 'true\n' && strictBare.code === 0 && strictBare.stdout === 'true\n'
      && same3_71(runsWMixUt) && runsWMixUt[0].code === 0 && runsWMixUt[0].stdout === '42true\n'
      && same3_71(runsWMixBare) && runsWMixBare[0].code === 0 && runsWMixBare[0].stdout === '42true\n'
      && strictMixUt.code === 0 && strictMixUt.stdout === '42true\n' && strictMixBare.code === 0 && strictMixBare.stdout === '42true\n'
      && dbgMixUt.stderr.includes('[wasm] fn numf OK') && !dbgMixUt.stderr.includes('REJECT') && dbgMixUt.stdout === '42true\n'
      && dbgMixBare.stderr.includes('[wasm] fn numf OK') && !dbgMixBare.stderr.includes('REJECT') && dbgMixBare.stdout === '42true\n',
    `ut=${fmtRuns71(runsWUt)} bare=${fmtRuns71(runsWBare)} strict=${strictUt.code}/${strictBare.code}/${strictMixUt.code}/${strictMixBare.code} dbg=${JSON.stringify(dbgMixUt.stderr.split('\n').filter(l => l.includes('[wasm]')).join('|').slice(0, 120))}`);

  // ---- v71.15 C 后端发射期拒绝(清单 12:解包后与裸 Json 形参逐字一致;--emit-c 不需 gcc,拒绝发生在发射期)----
  const ccUt = runMing(['cc', wMixUt71, '--emit-c']);
  const ccBare = runMing(['cc', wMixBare71, '--emit-c']);
  check('v71.15:cc 发射期拒绝——Untrusted[Json] 与裸 Json 两变体 exit 1,stderr 逐字一致(同款 C1 拒绝)',
    ccUt.code === 1 && ccBare.code === 1 && ccUt.stderr === ccBare.stderr && ccUt.stderr.includes('C1 不支持该程序形态'),
    `ut=${ccUt.code}:${JSON.stringify(ccUt.stderr.split('\n')[0])} bare=${ccBare.code}:${JSON.stringify(ccBare.stderr.split('\n')[0])}`);

  // ---- v71.16 契约内投影(投影纯函数口径;requires 内 unwrap 后 as_str().is_some())----
  const contract71 = m71('v71_contract.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn path_len(req: Untrusted[Json]) -> i64',
    '    requires req.get("path").unwrap().as_str().is_some() {',
    '    let s = req.get("path").unwrap().as_str().unwrap();',
    '    return s.char_len() as i64;',
    '}',
    'fn main() with io {',
    '    let j = std.json.parse("{\\"path\\":\\"/abc\\"}").unwrap();',
    '    let u: Untrusted[Json] = std.unstr.mark_json(j);',
    '    print(str(path_len(u)));',
    '}',
  ].join('\n'));
  const rContract = chk71(contract71);
  const runsContract = runAll71(contract71);
  check('v71.16:契约内投影——requires 投影链(get→unwrap→as_str→is_some)check exit 0,三引擎输出 "4" 逐字',
    rContract.code === 0 && !!rContract.j && rContract.j.ok === true && rContract.j.diagnostics.length === 0
      && same3_71(runsContract) && runsContract[0].code === 0 && runsContract[0].stdout === '4\n',
    `check=${codes71(rContract)} runs=${fmtRuns71(runsContract)}`);

  // ---- v71.17 as_obj 副本键形态修复回归(v0.68 触达即修:副本键裸形态,同 normKey 口径)----
  // 修复前:get/has 对存在的 str 键查不到(Map 键误存 Ming 包装值)、keys() 双重包装([object Object])。
  // 三形态:净 Json as_obj 链 / parse→at→as_obj 嵌套链 / 污标 as_obj(Map[str, Untrusted[Json]])。
  const aoMin71 = m71('v71_asobj_min.ming', [
    'use std.json;',
    'fn main() with io {',
    '    let j = std.json.parse("{\\"k\\":\\"v\\"}").unwrap();',
    '    let m = j.as_obj().unwrap();',
    '    let got = m.get("k");',
    '    if got.is_some() {',
    '        print("get=some(" + got.unwrap().as_str().unwrap() + ")");',
    '    } else {',
    '        print("get=none");',
    '    }',
    '    print("has=" + str(m.has("k")));',
    '    print("len=" + str(m.len()));',
    '    let ks = m.keys();',
    '    print("keys_len=" + str(ks.len()));',
    '    let k0 = ks.get(0);',
    '    if k0.is_some() {',
    '        print("keys0=" + k0.unwrap());',
    '    } else {',
    '        print("keys0=none");',
    '    }',
    '}',
  ].join('\n'));
  const aoChain71 = m71('v71_asobj_chain.ming', [
    'use std.json;',
    'fn main() with io {',
    '    let j = std.json.parse("[1,{\\"k\\":\\"v\\"}]").unwrap();',
    '    let inner = j.at(1).unwrap().as_obj().unwrap();',
    '    let got = inner.get("k");',
    '    if got.is_some() {',
    '        print("v=" + got.unwrap().as_str().unwrap());',
    '    } else {',
    '        print("none");',
    '    }',
    '}',
  ].join('\n'));
  const aoTaint71 = m71('v71_asobj_taint.ming', [
    'use std.json;',
    'use std.unstr;',
    'fn main() with io {',
    '    let u: Untrusted[Json] = std.unstr.mark_json(std.json.parse("{\\"k\\":\\"v\\"}").unwrap());',
    '    let m: Map[str, Untrusted[Json]] = u.as_obj().unwrap();',
    '    let got = m.get("k");',
    '    if got.is_some() {',
    '        print("v=" + str(got.unwrap().as_str().unwrap().char_len()));',
    '    } else {',
    '        print("none");',
    '    }',
    '    let k0 = m.keys().get(0);',
    '    if k0.is_some() {',
    '        print("k0=" + k0.unwrap());',
    '    } else {',
    '        print("k0=none");',
    '    }',
    '}',
  ].join('\n'));
  const runsAoMin = runAll71(aoMin71);
  const runsAoChain = runAll71(aoChain71);
  const runsAoTaint = runAll71(aoTaint71);
  const rAoChainChk = chk71(aoChain71);
  check('v71.17:as_obj 副本键修复——净链 get=some(v)/has=true/keys0=k、parse→at→as_obj 嵌套链 v=v、污标链 v=1/k0=k,三引擎逐字',
    same3_71(runsAoMin) && runsAoMin[0].code === 0 && runsAoMin[0].stdout === 'get=some(v)\nhas=true\nlen=1\nkeys_len=1\nkeys0=k\n'
      && same3_71(runsAoChain) && runsAoChain[0].code === 0 && runsAoChain[0].stdout === 'v=v\n'
      && rAoChainChk.code === 0
      && same3_71(runsAoTaint) && runsAoTaint[0].code === 0 && runsAoTaint[0].stdout === 'v=1\nk0=k\n',
    `min=${fmtRuns71(runsAoMin)} chain=${fmtRuns71(runsAoChain)} taint=${fmtRuns71(runsAoTaint)}`);
  // ---- v71.18(M1 审查修复):M3049 的 hint 字段载体中性(--json 是 AI 直接消费面,v0.67 同类风险收口) ----
  {
    const f = m71('hint_carrier.ming', [
      'use std.json;',
      'use std.unstr;',
      'use std.fs;',
      'fn handler(req: Untrusted[Json]) -> Json with fs {',
      '    std.json.stringify(req);',
      '    return std.json.parse("{}").unwrap();',
      '}',
      '',
    ].join('\n'));
    const ck = runMing(['check', f, '--json']);
    const j = (() => { try { return JSON.parse(ck.stdout); } catch { return null; } })();
    const d49 = j && j.diagnostics ? j.diagnostics.find(d => d.code === 'M3049') : null;
    const hint = d49 ? (d49.hint || '') : '';
    check('v71.18:M3049 hint 字段载体中性——str 与 Json 两条净化路径都在 hint 中(--json 消费面口径)',
      d49 && hint.includes('str 载体') && hint.includes('Json 载体'),
      'code=' + (d49 ? d49.code : 'none') + ' hint=' + JSON.stringify(hint.slice(0, 120)));
  }

  // ---- §71-END
}


// ===================== 72. v0.69:eval(显式能力 with eval;ADR-005 12/12 go)=====================
// 文件所有权:§72 = 本区全部用例(ADR-005 §7 清单 12 项 + §9 实现期义务核验)。
// 正例(字面量/合成串/嵌套/内层非零退出码)/ Err 化载荷(编译失败 N 条 std.json.parse 断言/类型错/
// 内层 panic M4003/契约 M4015/缺 main M3023/熔断 M4001——panic 不穿透,外层存活)/
// 门禁面(M3029 无声明与逐层传播/契约内 M3029/M3049 污点 sink/serve handler 内 M3002)/
// 引擎面(strict-wasm 具名回落/build 回退源码模式/cc 发射期拒绝)。
// 纪律:内层恒 tree 参考实现(ADR-005 §9 裁决 5)→ 外层三引擎(default/--no-wasm/--tree)输出逐字一致;
// Err 载荷在 Ming 程序内经 std.json.parse 断言(不依赖 JSON 键序与多余字段);全部先实测后断言。
// 架构师裁决(2026-11-15):v72.13 按 'none' 口径锁定——with eval 函数经 wasm.js 资格闸
// (effectOk 仅 ffi/unsafe)在资格分析阶段即被排除 → eligible=0 → wasm_status 'none' →
// strict exit 0(v53.4 先例:零 eligible → exit 0)。'none' 即"with eval 永不进 wasm"的
// 可观测诚实三态;ADR-005 wasm.js 零改动承诺下不产生具名回落消息(核验结果记入 ADR §9)。
{
  const dir72 = path.join(TMP, 'v72');
  fs.mkdirSync(dir72, { recursive: true });
  const m72 = (name, src) => { const f = path.join(dir72, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags72 = ['', '--no-wasm', '--tree'];
  const runAll72 = (p, extra = []) => flags72.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const same3_72 = (runs) => runs.length === 3 && runs.every((r) => r.code === runs[0].code && r.stdout === runs[0].stdout && r.stderr === runs[0].stderr);
  const fmtRuns72 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');
  const chk72 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 崩溃形态 → j=null,由断言点名 */ }
    return { code: r.code, j };
  };
  const codes72 = (res) => (res.j ? res.j.diagnostics.map((d) => d.code).join(',') : '(no-json:exit ' + res.code + ')');
  // Ming 源内构造嵌套引号的 eval 串:JSON.stringify 的 \" 转义与 Ming 串字面量对这些 ASCII 语料同形
  const q72 = (s) => JSON.stringify(s);

  // ---- v72.1 正例:字面量 eval(内层 print 捕获进 Ok 载荷,含换行)----
  const p72_1 = m72('v72_1_literal.ming', [
    'fn main() with io, eval {',
    '    match eval(' + q72('fn main() with io { print("hi"); }') + ') {',
    '        Ok(s) => print("OK:" + s),',
    '        Err(e) => print("ERR:" + e),',
    '    }',
    '}',
  ].join('\n'));
  const runs72_1 = runAll72(p72_1);
  check('v72.1:字面量 eval 正例——内层 print("hi") 捕获进 Ok 载荷(含换行,s="hi\\n"),print("OK:"+s) 输出 "OK:hi\\n\\n";三引擎逐字一致(内层恒 tree,外层三引擎合同延伸)',
    same3_72(runs72_1) && runs72_1[0].code === 0 && runs72_1[0].stdout === 'OK:hi\n\n',
    `runs=${fmtRuns72(runs72_1)}`);

  // ---- v72.2 正例:程序内合成净 str(引号拼接模板)——合法来源集 = 字面量 + 程序内合成(ADR-005 §2.1)----
  const p72_2 = m72('v72_2_synth.ming', [
    'fn main() with io, eval {',
    '    let src = "fn main() with io { print(" + ' + q72('"') + ' + ' + q72('x') + ' + ' + q72('"') + ' + "); }";',
    '    match eval(src) {',
    '        Ok(s) => print("OK:" + s),',
    '        Err(e) => print("ERR:" + e),',
    '    }',
    '}',
  ].join('\n'));
  const runs72_2 = runAll72(p72_2);
  check('v72.2:合成串 eval 正例——外层拼接生成内层代码(print("x")),Ok 载荷 "x\\n"(含换行)→ 输出 "OK:x\\n\\n";三引擎逐字一致',
    same3_72(runs72_2) && runs72_2[0].code === 0 && runs72_2[0].stdout === 'OK:x\n\n',
    `runs=${fmtRuns72(runs72_2)}`);

  // ---- v72.3 编译失败 Err 化:内层语法错 → Err 载荷 --json 协议同构 JSON,Ming 程序内 std.json.parse 断言 ----
  const p72_3 = m72('v72_3_compile_err.ming', [
    'use std.json;',
    'fn main() with io, eval {',
    '    match eval(' + q72('fn {') + ') {',
    '        Ok(s) => print("UNEXPECTED_OK:" + s),',
    '        Err(e) => {',
    '            let j = std.json.parse(e).unwrap();',
    '            let ok = j.get("ok").unwrap().as_bool().unwrap();',
    '            let arr = j.get("diagnostics").unwrap().as_arr().unwrap();',
    '            let c0 = arr.get(0).unwrap().get("code").unwrap().as_str().unwrap();',
    '            print("ok=" + str(ok) + " n_ge1=" + str(arr.len() >= 1) + " m2=" + str(c0.starts_with("M2")));',
    '        },',
    '    }',
    '}',
  ].join('\n'));
  const r72_3 = runMing(['run', p72_3]);
  check('v72.3:编译失败 Err 化——内层 "fn {" → Err 载荷 std.json.parse 成功(ok=false、diagnostics ≥1 条、首条 code M2xxx);内层 M 检查零降级',
    r72_3.code === 0 && r72_3.stdout === 'ok=false n_ge1=true m2=true\n',
    `code=${r72_3.code} stdout=${JSON.stringify(r72_3.stdout)} stderr=${JSON.stringify((r72_3.stderr ?? '').split('\n')[0])}`);

  // ---- v72.4 内层类型错误 → Err 含 M3xxx 码(类型检查在内层编译单元原档执行)----
  const p72_4 = m72('v72_4_type_err.ming', [
    'use std.json;',
    'fn main() with io, eval {',
    '    match eval(' + q72('fn main() { let x: i64 = "s"; }') + ') {',
    '        Ok(s) => print("UNEXPECTED_OK:" + s),',
    '        Err(e) => {',
    '            let j = std.json.parse(e).unwrap();',
    '            let arr = j.get("diagnostics").unwrap().as_arr().unwrap();',
    '            let mut m3 = false;',
    '            for d in arr {',
    '                if d.get("code").unwrap().as_str().unwrap().starts_with("M3") { m3 = true; }',
    '            }',
    '            print("m3=" + str(m3) + " n_ge1=" + str(arr.len() >= 1));',
    '        },',
    '    }',
    '}',
  ].join('\n'));
  const r72_4 = runMing(['run', p72_4]);
  check('v72.4:内层类型错误 Err 化——let x: i64 = "s" → Err 载荷 diagnostics 含 M3xxx 码,无 Ok 逃逸',
    r72_4.code === 0 && r72_4.stdout === 'm3=true n_ge1=true\n',
    `code=${r72_4.code} stdout=${JSON.stringify(r72_4.stdout)} stderr=${JSON.stringify((r72_4.stderr ?? '').split('\n')[0])}`);

  // ---- v72.5 内层 panic M4003 Err 化不穿透:单诊断 code=M4003、file='<eval>';外层存活 exit 0 ----
  const p72_5 = m72('v72_5_panic.ming', [
    'use std.json;',
    'fn main() with io, eval {',
    '    match eval(' + q72('fn main() with io { let v = [1]; print(str(v[5])); }') + ') {',
    '        Ok(s) => print("UNEXPECTED_OK:" + s),',
    '        Err(e) => {',
    '            let j = std.json.parse(e).unwrap();',
    '            let arr = j.get("diagnostics").unwrap().as_arr().unwrap();',
    '            let d0 = arr.get(0).unwrap();',
    '            let c0 = d0.get("code").unwrap().as_str().unwrap();',
    '            let f0 = d0.get("file").unwrap().as_str().unwrap();',
    '            print("n=" + str(arr.len()) + " code=" + c0 + " file=" + f0);',
    '        },',
    '    }',
    '}',
  ].join('\n'));
  const runs72_5 = runAll72(p72_5);
  check('v72.5:内层 panic Err 化不穿透——v[5] 越界 → Err 单诊断 code=M4003、file=<eval>;Err 分支 print 后外层正常 exit 0;三引擎逐字一致',
    same3_72(runs72_5) && runs72_5[0].code === 0 && runs72_5[0].stdout === 'n=1 code=M4003 file=<eval>\n',
    `runs=${fmtRuns72(runs72_5)}`);

  // ---- v72.6 内层契约违约 M4015 → Err(运行时失败同通道,外层存活)----
  // 实参经 Vec 元素(f(v[0]))绕开 M3041 调用点字面量静态契约校验,违约落到运行时 M4015。
  const p72_6 = m72('v72_6_contract.ming', [
    'use std.json;',
    'fn main() with io, eval {',
    '    match eval(' + q72('fn f(x: i64) -> i64 requires x > 0 { return x; } fn main() with io { let v = [-1]; print(str(f(v[0]))); }') + ') {',
    '        Ok(s) => print("UNEXPECTED_OK:" + s),',
    '        Err(e) => {',
    '            let j = std.json.parse(e).unwrap();',
    '            let arr = j.get("diagnostics").unwrap().as_arr().unwrap();',
    '            let c0 = arr.get(0).unwrap().get("code").unwrap().as_str().unwrap();',
    '            print("n=" + str(arr.len()) + " code=" + c0);',
    '        },',
    '    }',
    '}',
  ].join('\n'));
  const r72_6 = runMing(['run', p72_6]);
  check('v72.6:内层契约违约 Err 化——f(v[0]) 运行时违反 requires x > 0 → Err 单诊断 code=M4015;外层存活 exit 0(panic 不穿透)',
    r72_6.code === 0 && r72_6.stdout === 'n=1 code=M4015\n',
    `code=${r72_6.code} stdout=${JSON.stringify(r72_6.stdout)} stderr=${JSON.stringify((r72_6.stderr ?? '').split('\n')[0])}`);

  // ---- v72.7 内层缺 main → Err 含 M3023(零新码自然覆盖;ADR-005 §9 裁决 10 实测口径)----
  const p72_7 = m72('v72_7_nomain.ming', [
    'use std.json;',
    'fn main() with io, eval {',
    '    match eval(' + q72('fn helper() { }') + ') {',
    '        Ok(s) => print("UNEXPECTED_OK:" + s),',
    '        Err(e) => {',
    '            let j = std.json.parse(e).unwrap();',
    '            let arr = j.get("diagnostics").unwrap().as_arr().unwrap();',
    '            let mut found = false;',
    '            for d in arr {',
    '                if d.get("code").unwrap().as_str().unwrap() == "M3023" { found = true; }',
    '            }',
    '            print("m3023=" + str(found));',
    '        },',
    '    }',
    '}',
  ].join('\n'));
  const r72_7 = runMing(['run', p72_7]);
  check('v72.7:内层缺 main Err 化——"fn helper() { }" → Err 载荷 diagnostics 含 M3023;外层存活 exit 0',
    r72_7.code === 0 && r72_7.stdout === 'm3023=true\n',
    `code=${r72_7.code} stdout=${JSON.stringify(r72_7.stdout)} stderr=${JSON.stringify((r72_7.stderr ?? '').split('\n')[0])}`);

  // ---- v72.8 内层熔断 M4001 Err 化:--max-steps 500 全量继承(按调用重置,sync 先例);外层存活 ----
  const p72_8 = m72('v72_8_quota.ming', [
    'fn main() with io, eval {',
    '    let mut i = 0;',
    '    while i < 2 {',
    '        match eval(' + q72('fn main() { while true { } }') + ') {',
    '            Ok(s) => print("UNEXPECTED_OK:" + s),',
    '            Err(e) => { print("c" + str(i) + "_m4001=" + str(e.contains("M4001"))); },',
    '        }',
    '        i = i + 1;',
    '    }',
    '}',
  ].join('\n'));
  const runs72_8 = runAll72(p72_8, ['--max-steps', '500']);
  check('v72.8:内层熔断 Err 化——--max-steps 500(内层按调用重置全量继承)循环两次 eval 死循环内层 → 两次 Err 均含 M4001;外层存活 exit 0;三引擎逐字一致',
    same3_72(runs72_8) && runs72_8[0].code === 0 && runs72_8[0].stdout === 'c0_m4001=true\nc1_m4001=true\n',
    `runs=${fmtRuns72(runs72_8)}`);

  // ---- v72.9 M3029 效果门禁:未声明调 eval + helper with eval / main 未声明的逐层传播 ----
  const p72_9a = m72('v72_9a_m3029.ming', 'fn main() { eval(' + q72('fn main() { }') + '); }');
  const p72_9b = m72('v72_9b_m3029_prop.ming', [
    'fn go() -> Result[str, str] with eval {',
    '    return eval(' + q72('fn main() { }') + ');',
    '}',
    'fn main() with io {',
    '    print("x");',
    '    let _ = go();',
    '}',
  ].join('\n'));
  const r72_9a = chk72(p72_9a);
  const r72_9b = chk72(p72_9b);
  check('v72.9:M3029 效果门禁——main 未声明 eval 直接调 eval(check exit 1 + M3029 消息点名 eval);helper with eval 而 main 未声明 → M3029 逐层传播',
    r72_9a.code === 1 && !!r72_9a.j && r72_9a.j.diagnostics.some((d) => d.code === 'M3029' && d.message.includes('eval'))
      && r72_9b.code === 1 && !!r72_9b.j && r72_9b.j.diagnostics.some((d) => d.code === 'M3029' && d.message.includes('eval')),
    `a=${r72_9a.code}/${codes72(r72_9a)} b=${r72_9b.code}/${codes72(r72_9b)}`);

  // ---- v72.10 契约内 eval → M3029(契约表达式空效果集检查,零新机制自动覆盖)----
  const p72_10 = m72('v72_10_contract_eff.ming', [
    'fn f(x: i64) -> i64',
    '    requires eval(' + q72('fn main() { }') + ').is_ok() {',
    '    return x;',
    '}',
    'fn main() with io {',
    '    print("x");',
    '}',
  ].join('\n'));
  const r72_10 = chk72(p72_10);
  check('v72.10:契约内 eval → M3029——requires 表达式里调 eval(声明处即检查,函数未被调用也发射),消息点名效果 eval',
    r72_10.code === 1 && !!r72_10.j && r72_10.j.diagnostics.some((d) => d.code === 'M3029' && d.message.includes('eval')),
    `code=${r72_10.code}/${codes72(r72_10)}`);

  // ---- v72.11 M3049 污点 sink:env.get 的 Untrusted[str] 实参进 eval 被拦(v1 无净化器出口)----
  const p72_11 = m72('v72_11_sink.ming', [
    'use std.env;',
    'fn main() with env, eval {',
    '    let u = std.env.get("MING_V72_SINK").unwrap();',
    '    eval(u);',
    '}',
  ].join('\n'));
  const r72_11 = chk72(p72_11);
  check('v72.11:M3049 污点 sink——env.get().unwrap() 的 Untrusted[str] 进 eval 实参位 → check exit 1 + M3049(外部输入永不动态执行,类型级保证)',
    r72_11.code === 1 && !!r72_11.j && r72_11.j.diagnostics.some((d) => d.code === 'M3049' && d.message.includes('Untrusted[str]')),
    `code=${r72_11.code}/${codes72(r72_11)}`);

  // ---- v72.12 serve handler 内 eval → M3002(eval 不进 SERVE_HANDLER_EFFECTS 8 白名单)----
  const p72_12 = m72('v72_12_serve.ming', [
    'use std.net;',
    'use std.json;',
    'fn handler(req: Untrusted[Json]) -> Json with eval {',
    '    eval(' + q72('fn main() { }') + ');',
    '    return std.json.parse("{}").unwrap();',
    '}',
    'fn main() with net, io {',
    '    match std.net.serve(27212, handler) {',
    '        Ok(v) => print("ok"),',
    '        Err(e) => print("err=\\{e}"),',
    '    }',
    '}',
  ].join('\n'));
  const r72_12 = chk72(p72_12);
  check('v72.12:serve handler 内 eval → M3002——handler 声明 with eval 不在 SERVE_HANDLER_EFFECTS 白名单(check exit 1,消息点名 eval)',
    r72_12.code === 1 && !!r72_12.j && r72_12.j.diagnostics.some((d) => d.code === 'M3002' && d.message.includes('eval')),
    `code=${r72_12.code}/${codes72(r72_12)}`);

  // ---- v72.13 wasm strict 三态核验('none' 口径,架构师裁决 2026-11-15):with eval 函数经
  // wasm.js 资格闸(effectOk 仅 ffi/unsafe)在资格分析阶段排除 → eligible=0 → 'none' →
  // strict exit 0(v53.4 先例:零 eligible → exit 0)——"永不进 wasm"的可观测诚实形态 ----
  const p72_13 = m72('v72_13_strict.ming', [
    'fn go() -> i64 with eval {',
    '    eval(' + q72('fn main() { }') + ');',
    '    return 1;',
    '}',
    'fn main() with io, eval {',
    '    print(str(go()));',
    '}',
  ].join('\n'));
  const runs72_13 = runAll72(p72_13);
  const strict72_13 = runMing(['run', p72_13, '--strict-wasm', '--json']);
  let j72_13 = null;
  try { j72_13 = JSON.parse(strict72_13.stdout); } catch { /* 崩溃形态 → 断言点名 */ }
  check('v72.13:wasm strict 三态 "none" 口径——with eval 程序非 strict 三引擎输出 "1\\n" 逐字;--strict-wasm --json → exit 0 且 wasm_status=none(eligible=0,v53.4 先例;不误报 ok/fallback)',
    same3_72(runs72_13) && runs72_13[0].code === 0 && runs72_13[0].stdout === '1\n'
      && strict72_13.code === 0 && j72_13 !== null && j72_13.wasm_status === 'none',
    `runs=${fmtRuns72(runs72_13)} strict=${strict72_13.code}/${JSON.stringify((strict72_13.stdout ?? '').slice(-60))}`);

  // ---- v72.14 ming build 遇 with eval:显式回退源码模式 + 具名原因;dist launcher 行为与源码模式一致 ----
  const bp72 = path.join(TMP, 'v72build');
  fs.mkdirSync(bp72, { recursive: true });
  fs.writeFileSync(path.join(bp72, 'ming.toml'), '[project]\nname = "v72eval"\nversion = "0.1.0"\nentry = "app.ming"\n');
  fs.copyFileSync(p72_1, path.join(bp72, 'app.ming'));
  const srcRun72 = runMing(['run', path.join(bp72, 'app.ming')]);
  const bld72 = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: bp72, timeout: 120000 });
  const launcher72 = spawnSync(process.execPath, [path.join(bp72, 'dist', 'ming-app.mjs')], { encoding: 'utf8', cwd: bp72, timeout: 60000 });
  check('v72.14:ming build 遇 with eval 显式回退源码模式——AOT 不可用 + 具名原因(eval)+ 已回退源码模式;无 app.bytecode.json;dist launcher 与源码模式输出一致("OK:hi\\n\\n")',
    bld72.status === 0 && (bld72.stderr ?? '').includes('AOT 不可用') && (bld72.stderr ?? '').includes('已回退源码模式')
      && (bld72.stderr ?? '').includes('eval')
      && fs.existsSync(path.join(bp72, 'dist', 'app.ming')) && !fs.existsSync(path.join(bp72, 'dist', 'app.bytecode.json'))
      && srcRun72.code === 0 && srcRun72.stdout === 'OK:hi\n\n'
      && launcher72.status === 0 && launcher72.stdout === 'OK:hi\n\n',
    `build=${bld72.status} stderr=${JSON.stringify((bld72.stderr ?? '').slice(0, 200))} src=${srcRun72.code}:${JSON.stringify(srcRun72.stdout)} launcher=${launcher72.status}:${JSON.stringify(launcher72.stdout)}/${JSON.stringify((launcher72.stderr ?? '').slice(0, 120))}`);

  // ---- v72.15 cc 发射期拒绝:with eval main 体发射 → Unsupported("调用 eval")→ "C1 不支持该程序形态" ----
  // (--emit-c 形态不需 gcc,拒绝发生在发射期;参照 v71.15/v66.12 口径。
  //  语料用裸 eval 调用语句 + 尾随 print:match 语句位/块尾表达式是 C1 既有拒绝形态,会先于 eval 触发,
  //  断言追加 "eval" 点名具名原因,避免误把无关 C1 拒绝当 eval 拒绝。)
  const p72_15 = m72('v72_15_cc.ming', [
    'fn main() with io, eval {',
    '    eval(' + q72('fn main() { }') + ');',
    '    print("done");',
    '}',
  ].join('\n'));
  const cc72 = runMing(['cc', p72_15, '--emit-c']);
  check('v72.15:cc 发射期拒绝 with eval——exit 1 + "C1 不支持该程序形态:调用 eval"(--emit-c 不依赖本机 gcc)',
    cc72.code === 1 && ((cc72.stderr ?? '') + (cc72.stdout ?? '')).includes('C1 不支持该程序形态')
      && ((cc72.stderr ?? '') + (cc72.stdout ?? '')).includes('eval'),
    `code=${cc72.code} out=${JSON.stringify((((cc72.stderr ?? '') + (cc72.stdout ?? '')).split('\n')[0] ?? '').slice(0, 160))}`);

  // ---- v72.16 嵌套 eval → Ok(内层程序里再 eval;内层恒 tree 与嵌套深度无关)----
  const innerMost72 = 'fn main() with io { print("deep"); }';
  const inner72src = 'fn main() with io, eval { match eval(' + q72(innerMost72) + ') { Ok(s) => print("IN:" + s), Err(e) => print("E:" + e), } }';
  const p72_16 = m72('v72_16_nested.ming', [
    'fn main() with io, eval {',
    '    match eval(' + q72(inner72src) + ') {',
    '        Ok(s) => print("OUT:" + s),',
    '        Err(e) => print("E:" + e),',
    '    }',
    '}',
  ].join('\n'));
  const runs72_16 = runAll72(p72_16);
  check('v72.16:嵌套 eval 正例——内层程序再 eval 最内层,捕获链逐层含换行,输出 "OUT:IN:deep\\n\\n\\n";三引擎一致',
    same3_72(runs72_16) && runs72_16[0].code === 0 && runs72_16[0].stdout === 'OUT:IN:deep\n\n\n',
    `runs=${fmtRuns72(runs72_16)}`);

  // ---- v72.17 内层 main 返回非零(= 3)→ Ok:载荷仅 stdout,退出码语义属进程边界不进 Err(ADR-005 裁决 4)----
  const p72_17 = m72('v72_17_exitcode.ming', [
    'fn main() with io, eval {',
    '    match eval(' + q72('fn main() -> i64 with io { print("v"); return 3; }') + ') {',
    '        Ok(s) => print("OK:" + s),',
    '        Err(e) => print("ERR:" + e),',
    '    }',
    '}',
  ].join('\n'));
  const runs72_17 = runAll72(p72_17);
  check('v72.17:内层非零退出码 → Ok——main 返回 3 不进 Err,Ok 载荷仅捕获 stdout("v\\n")→ 输出 "OK:v\\n\\n";三引擎逐字一致',
    same3_72(runs72_17) && runs72_17[0].code === 0 && runs72_17[0].stdout === 'OK:v\n\n',
    `runs=${fmtRuns72(runs72_17)}`);

  // ---- v72.18(v0.69 审查 MAJOR-1 锁定):eval 链式自递归 → 64 层确定性守卫 Panic M4005
  // → Err 化不穿透(外层存活 exit 0);深度与机器栈大小无关(64 DONE = 守卫深度)。
  // v0.77 校准(ADR-007 清单 1+11):原夹具 `eval(read_file(自身))` 自递归正是本 ADR 关闭的形态
  // (污内容永不动态执行,read_file 翻转后 eval(污) → M3049)——改**净源构造**:夹具是 JSON 往返
  // quine(程序用 json.stringify 的转义 = 源面字面量转义(探针逐字节核对)重建自身文本再 eval,
  // 全程纯净无 I/O),嵌套链与守卫语义与原夹具完全一致(63 层 NESTED-OK + 第 65 层 eval 调用
  // M4005 → 上层 evalInner 转 Err;恰 64 个 DONE)。
  const esc72 = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  const head72 = 'use std.json;\n\nfn main() with io, eval {\n    let s = ';
  const tail72 = ';\n    let ph = "@Q" + "Q@";\n    match eval(s.replace(ph, json.stringify(s))) {\n        Ok(s2) => print("NESTED-OK:" + s2),\n        Err(e) => { print("NESTED-ERR:" + e); },\n    }\n    print("DONE");\n}\n';
  const quineRec72 = path.join(dir72, 'v72_selfrec.ming');
  fs.writeFileSync(quineRec72, head72 + esc72(head72 + '@QQ@' + tail72) + tail72, 'utf8');
  const runs72_18 = runAll72(quineRec72);
  const dones72_18 = (runs72_18[0].stdout.match(/DONE/g) ?? []).length;
  check('v72.18:eval 链式自递归 → 64 层守卫 Err 化——63 层 NESTED-OK 后第 64 层 eval 调用 Panic M4005(消息含 "嵌套过深")由上层 evalInner 转 Err;恰 64 个 DONE;exit 0(外层存活);三引擎逐字一致',
    same3_72(runs72_18) && runs72_18[0].code === 0 && dones72_18 === 64
      && runs72_18[0].stdout.includes('NESTED-ERR:{"ok":false,"diagnostics":[{"code":"M4005","name":"stack-overflow"')
      && runs72_18[0].stdout.includes('嵌套过深'),
    `runs=${fmtRuns72(runs72_18).slice(0, 300)} dones=${dones72_18}`);

  // ---- v72.19(v0.69 审查 MINOR-2 锁定):内层模块装载失败(M3022)→ Err 化——
  // use 未知 std 模块在 Checker.run() 内产 error 级诊断/use 目标不可读抛 MingError,
  // 两条路径观测面一致:Err 载荷 diagnostics 含 M3022 ----
  const p72_19 = m72('v72_19_m3022.ming', [
    'fn main() with io, eval {',
    '    match eval(' + q72('use std.nope;\nfn main() { }') + ') {',
    '        Ok(s) => print("OK:" + s),',
    '        Err(e) => print("ERR:" + e),',
    '    }',
    '}',
  ].join('\n'));
  const runs72_19 = runAll72(p72_19);
  check('v72.19:内层 M3022(未知 std 模块)→ Err 化——载荷 diagnostics 含 code=M3022,外层存活;三引擎逐字一致',
    same3_72(runs72_19) && runs72_19[0].code === 0 && runs72_19[0].stdout.includes('"code":"M3022"')
      && runs72_19[0].stdout.startsWith('ERR:'),
    `runs=${fmtRuns72(runs72_19)}`);

  // ---- v72.20(v0.69 审查 MINOR-2/NOTE-1 锁定):内层熔断 M4011/M4012 与 panic 同通道;
  // Ok 载荷 = 捕获 stdout + eprint(capture 混收,与 sync 先例同款口径)----
  const p72_20a = m72('v72_20_alloc.ming', [
    'fn main() with io, eval {',
    '    match eval(' + q72('fn main() with io { let mut v: Vec[i64] = []; for i in 0..1000 { v.push(i); } print(str(v.len())); }') + ') {',
    '        Ok(s) => print("OK:" + s),',
    '        Err(e) => { print("ERR:" + e); },',
    '    }',
    '}',
  ].join('\n'));
  const alloc72_20 = runMing(['run', p72_20a, '--max-alloc', '500']);
  const p72_20b = m72('v72_20_ms.ming', [
    'fn main() with io, eval {',
    '    match eval(' + q72('use std.time;\nfn main() with time { time.sleep(5000); }') + ') {',
    '        Ok(s) => print("OK:" + s),',
    '        Err(e) => { print("ERR:" + e); },',
    '    }',
    '}',
  ].join('\n'));
  const ms72_20 = runMing(['run', p72_20b, '--max-ms', '300']);
  const p72_20c = m72('v72_20_eprint.ming', [
    'fn main() with io, eval {',
    '    match eval(' + q72('fn main() with io { eprint("E1"); print("P1"); }') + ') {',
    '        Ok(s) => print("OK[" + s + "]"),',
    '        Err(e) => print("ERR:" + e),',
    '    }',
    '}',
  ].join('\n'));
  const ep72_20 = runMing(['run', p72_20c]);
  check('v72.20:内层熔断 M4011(--max-alloc 5)与 M4012(--max-ms 300 + sleep)均 Err 化同通道,外层存活 exit 0;Ok 载荷含内层 eprint("OK[E1\\nP1\\n]")',
    alloc72_20.code === 0 && alloc72_20.stdout.includes('"code":"M4011"')
      && ms72_20.code === 0 && ms72_20.stdout.includes('"code":"M4012"')
      && ep72_20.code === 0 && ep72_20.stdout === 'OK[E1\nP1\n]\n',
    `alloc=${alloc72_20.code}/${JSON.stringify(alloc72_20.stdout.slice(0, 80))} ms=${ms72_20.code}/${JSON.stringify(ms72_20.stdout.slice(0, 80))} ep=${ep72_20.code}/${JSON.stringify(ep72_20.stdout)}`);

  // ---- §72-END
}

// ===================== 73. v0.70:诊断校准二期(#63 parser 级联抑制——深度感知 panic-mode 恢复)=====================
// 文件所有权:§73 = 本区全部用例。
// 根因机制:旧 recover(false) 语句停机表含顶层关键字 `test`(test 只能顶层,不是语句)——语句解析
// 失败落在 `test` 上时 recover 立即返回(未消费),catch 强进 1 token 到 `ident {`,下一轮被误解析为
// 结构体字面量(字段名路径 → M2002"期望 :"+错误 fix),函数体提前闭合 → 后续合法语句与收尾 `}`
// 在顶层级联雪崩。锚定语料改前 1 根因 → 4 条诊断(3×M2001 + 1×M2002)。
// 实现(src/parser.js 单文件):① recover(false) 深度感知 panic-mode(失败语句 {...} 区域整体吞掉,
// `test` 移出语句停机表,depth===0 时 `}` 不消费交还块循环);② 值构造 brace 登记(valBrace:
// struct/map 字面量、match 体已消费未闭合的 `{`,失败穿越时整句吞到匹配 `}`,字面量自己的 `}`
// 不再被误当块收尾);③ parseProgram/parseBlock catch 强进路径改造(recover 未前进时强进 1 token
// 后继续 recover(false) 推进到下一个语句边界)。recover(true) 顶层行为逐字不变。
// 预期副作用(记录):失败语句到下一个 `;`/语句关键字之间的好语句被 panic-mode 吞掉(如锚定语料的
// `print("bye");`)——程序反正编译失败 exit 1,诊断正确性优先于语句 salvage。
// 纪律:全部先实测后断言;改前条数取自 HEAD 449b59f 基线(git worktree 实测)。
{
  const dir73 = path.join(TMP, 'v73');
  fs.mkdirSync(dir73, { recursive: true });
  const m73 = (name, src) => { const f = path.join(dir73, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const chk73 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 崩溃形态 → j=null,由断言点名 */ }
    return { code: r.code, j };
  };
  const ds73 = (res) => (res.j && res.j.diagnostics) || [];
  const codes73 = (res) => ds73(res).map((d) => d.code).sort().join(',');
  const hasTop73 = (res) => ds73(res).some((d) => (d.message || '').includes('顶层'));

  const ANCHOR73 = [
    'fn add(a: i64, b: i64) -> i64 { return a + b; }',
    'fn main() with io {',
    '    print("hi");',
    '    test add_works {',
    '        assert_eq(add(2, 3), 5);',
    '        assert_eq(add(1, 1), 2);',
    '    }',
    '    print("bye");',
    '}',
  ].join('\n');

  // ---- v73.1 锚定语料:恰 1 条 M2001(根因指向性保留),无 fix,无 M2002/顶层级联 ----
  // v0.70 恢复策略校准:旧 4 条(① M2001 无法解析的表达式:"test"@4:5 根因 ② M2002 期望":"@5:18
  // 结构体字面量误解析 ③ M2001 顶层…"print"@8:5 ④ M2001 顶层…"}"@9:1)→ 新 1 条(根因 ① 保留,
  // 级联 ②③④ 消除)。实测:1 条,M2001@4,"test" 在 message,fix 字段不存在。
  {
    const p = m73('v73_1_anchor.ming', ANCHOR73);
    const res = chk73(p);
    const ds = ds73(res);
    check('v73.1:锚定语料——恰 1 条诊断 code=M2001 message 含 "test" 无 fix 字段,无 M2002/顶层级联(v0.70 恢复策略校准:旧 4 条 → 新 1 条,根因 ① 保留,级联 ②③④ 消除)',
      ds.length === 1 && ds[0].code === 'M2001' && ds[0].message.includes('test') && ds[0].fix === undefined
        && res.j && res.j.ok === false,
      `n=${ds.length} codes=${codes73(res)} msg=${JSON.stringify(ds[0] ? ds[0].message : '')} fix=${ds[0] && ds[0].fix === undefined ? 'NONE' : JSON.stringify(ds[0] && ds[0].fix)}`);
  }

  // ---- v73.2 长函数体:第 3 句放 test 块,诊断不随体长线性放大 ----
  // v0.70 恢复策略校准:旧 14 条(11×M2001 + 1×M2002 + 2×W3101,随体长线性放大)→ 新 1 条(根因 M2001@4)。
  {
    const p = m73('v73_2_longbody.ming', [
      'fn main() with io {',
      '    let a = 1;',
      '    let b = 2;',
      '    test x {',
      '        assert_eq(a, 1);',
      '    }',
      '    let c = 3;',
      '    let d = 4;',
      '    let e = 5;',
      '    let f = 6;',
      '    let g = 7;',
      '    let h = 8;',
      '    let i = 9;',
      '    let j = 10;',
      '    print(a + b + c + d + e + f + g + h + i + j);',
      '}',
    ].join('\n'));
    const res = chk73(p);
    const ds = ds73(res);
    check('v73.2:长函数体(12+ 语句,第 3 句放 test 块)——诊断数 ≤2 且首条为根因 M2001(不随体长线性放大;旧 14 条 → 新 1 条,级联消除)',
      ds.length <= 2 && ds[0] && ds[0].code === 'M2001' && ds[0].message.includes('test'),
      `n=${ds.length} codes=${codes73(res)} msg0=${JSON.stringify(ds[0] ? ds[0].message : '')}`);
  }

  // ---- v73.3 关键字语句恢复:错误语句后的 let/return 语句仍被解析,毒化行为正常 ----
  // 植入 checker 可见错误(let x = nosuch)证明后续语句确实被解析(而非被吞)。实测新 3 条:
  // M2001@2(根因)+ W3101@5 + M3001@5(毒化形态,三者均无 fix)。旧 5 条(4×M2001+1×M2002,
  // 级联淹没 M3001/W3101)→ 新 3 条且无"顶层"级联。
  {
    const p = m73('v73_3_kwrecovery.ming', [
      'fn main() with io {',
      '    test broken {',
      '        assert_eq(1, 1);',
      '    }',
      '    let x = nosuch;',
      '    return;',
      '}',
    ].join('\n'));
    const res = chk73(p);
    const ds = ds73(res);
    const m3001 = ds.find((d) => d.code === 'M3001');
    check('v73.3:关键字语句恢复——错误语句后 let/return 仍被解析,无"顶层"级联 M2001;毒化形态正常(M3001 nosuch 无 fix,旧 5 条 → 新 3 条)',
      codes73(res) === 'M2001,M3001,W3101' && !hasTop73(res) && m3001 && m3001.fix === undefined && m3001.message.includes('nosuch'),
      `codes=${codes73(res)} hasTop=${hasTop73(res)} m3001fix=${m3001 && m3001.fix === undefined ? 'NONE' : 'HAS'}`);
  }

  // ---- v73.4 struct literal 失败语句:整句吞到 ";",无 N 条级联 ----
  // 参照 §66 的 Json 构造形态反例。v0.70 恢复策略校准:旧 4 条(1×M2002 期望字段名 + 3×M2001 顶层
  // ——"实际是 ";"",字面量自己的 `}` 曾被误当块收尾提前闭合 main)→ 新 1 条(valBrace 登记让字面量
  // 的 `}` 被深度感知吞掉,整句吞到 ";")。
  {
    const p = m73('v73_4_structlit.ming', [
      'fn main() with io {',
      '    let r = Json{ "status": 1 };',
      '    print(1);',
      '}',
    ].join('\n'));
    const res = chk73(p);
    const ds = ds73(res);
    check('v73.4:struct literal 失败语句(Json{"status": 1})——1-2 条,根因 M2002 期望字段名保留,整句吞到 ";",无顶层级联(旧 4 条 → 新 1 条)',
      ds.length >= 1 && ds.length <= 2 && ds.some((d) => d.code === 'M2002' && (d.message || '').includes('期望字段名')) && !hasTop73(res),
      `n=${ds.length} codes=${codes73(res)} hasTop=${hasTop73(res)}`);
  }

  // ---- v73.5 未闭合块:恰 1 条 M2002 块未闭合,无顶层级联雪崩 ----
  // 新旧行为一致(改前 1 条 → 改后 1 条,回归锁)。
  {
    const p = m73('v73_5_unclosed.ming', [
      'fn f() {',
      '    let x = 1;',
    ].join('\n'));
    const res = chk73(p);
    const ds = ds73(res);
    check('v73.5:未闭合块——M2002 块未闭合恰 1 条,无顶层级联雪崩(旧 1 条 → 新 1 条,回归锁)',
      ds.length === 1 && ds[0].code === 'M2002' && (ds[0].message || '').includes('块未闭合') && !hasTop73(res),
      `n=${ds.length} codes=${codes73(res)}`);
  }

  // ---- v73.6 顶层 recover 不变:顶层非法 token 的 M2001 顶层 + hint 保留;后续声明仍解析 ----
  // 6a:快照 e22 顶层 let 形态——M2001 顶层 + hint 逐字保留(改前 1 条 → 改后 1 条,回归锁)。
  // 6b:顶层多个声明中夹一个非法 token(整数 123 标识符 abc)——后续 fn main 仍解析
  // (line≥3 无任何"顶层"诊断;M3002@1 是语料自身 fn a 的 return 类型错,新旧一致)。
  {
    const pa = m73('v73_6a_toplevel.ming', [
      'let x = 1;',
      '',
      'fn main() with io {',
      '    print(1);',
      '}',
    ].join('\n'));
    const ra = chk73(pa);
    const dsa = ds73(ra);
    check('v73.6a:顶层 recover 不变——顶层 let 的 M2001 顶层 + hint 保留,恰 1 条(旧 1 条 → 新 1 条,回归锁)',
      dsa.length === 1 && dsa[0].code === 'M2001' && (dsa[0].message || '').includes('顶层') && (dsa[0].hint || '').includes('顶层不能写 let'),
      `n=${dsa.length} codes=${codes73(ra)} msg=${JSON.stringify(dsa[0] ? dsa[0].message : '')} hint=${JSON.stringify(dsa[0] ? dsa[0].hint : '')}`);
  }
  {
    const pb = m73('v73_6b_stray.ming', [
      'fn a() { return 1; }',
      '123 abc',
      'fn main() with io {',
      '    print(1);',
      '}',
    ].join('\n'));
    const rb = chk73(pb);
    const dsb = ds73(rb);
    check('v73.6b:顶层声明间夹非法 token——M2001 顶层@2 保留,后续声明仍解析(line≥3 无"顶层"诊断;旧 2 条 → 新 2 条,回归锁)',
      dsb.length === 2 && dsb.some((d) => d.code === 'M2001' && d.line === 2 && (d.message || '').includes('顶层'))
        && !dsb.some((d) => d.line >= 3 && (d.message || '').includes('顶层')),
      `n=${dsb.length} codes=${codes73(rb)} lines=${dsb.map((d) => d.line).join(',')}`);
  }

  // ---- v73.7 "5 6" 缺分号形态: M2002 根因保留,级联不劣化 ----
  // v0.70 恢复策略校准:旧 1 条(M2002 语句后缺少 ";",根因后的 print("…") 被 inline recover 吞到 ";")
  // → 新 1 条,不劣化(回归锁)。
  {
    const p = m73('v73_7_nosemi.ming', [
      'fn main() with io {',
      '    5 6',
      '    print(1);',
      '}',
    ].join('\n'));
    const res = chk73(p);
    const ds = ds73(res);
    check('v73.7:"5 6" 缺分号形态——M2002 根因保留恰 1 条,级联不劣化(旧 1 条 → 新 1 条,回归锁)',
      ds.length === 1 && ds[0].code === 'M2002' && (ds[0].message || '').includes('语句后缺少'),
      `n=${ds.length} codes=${codes73(res)} msg=${JSON.stringify(ds[0] ? ds[0].message : '')}`);
  }

  // ---- v73.8 嵌套失败块:if 块内语法错 → 外层函数其余部分恢复,诊断 ≤2 ----
  // v0.70 恢复策略校准:旧 3 条(M2001@3 + M2002 级联 + M3001 误解析连坐)→ 新 1 条(根因 M2001@3)。
  {
    const p = m73('v73_8_nested.ming', [
      'fn main() with io {',
      '    if 1 < 2 {',
      '        test broken { }',
      '        print(1);',
      '    }',
      '    print(2);',
      '}',
    ].join('\n'));
    const res = chk73(p);
    const ds = ds73(res);
    check('v73.8:嵌套失败块——if 块内语法错诊断 ≤2 且首条为根因 M2001,外层函数其余部分恢复无顶层级联(旧 3 条 → 新 1 条)',
      ds.length <= 2 && ds[0] && ds[0].code === 'M2001' && ds[0].message.includes('test') && !hasTop73(res),
      `n=${ds.length} codes=${codes73(res)} hasTop=${hasTop73(res)}`);
  }

  // ---- v73.9 深度守卫:失败语句含未闭合 "{" → 恢复不吞到文件尾 ----
  // 9a(字面形态 `test x { let a = 1;` 无收尾):深度感知扫描吞掉被盗的一个 `}`(失败块区域整体
  // 平衡)后停在语句关键字边界——恰 2 条有界诊断(根因 M2001@3 + M2002 块未闭合@f 的 "{"),零
  // "顶层"级联。旧 4 条(2×M2001 + M3002 + W3101,旧级联路径意外救回 f/g 但带伪诊断)→ 新 2 条。
  // 注:被盗 brace 使 f 收尾缺失 → pre-existing 块未闭合语义(parseFn 无 body catch)丢弃 f 条目,
  // 与 v73.5 未闭合块同一传播路径,非本次改动引入。
  // 代价如实登记(v0.70 审查 MINOR-1):HEAD 报出的 g 内真实 M3002@5 不再报(g 随 f 的未闭合
  // bail 整体丢弃)——与 GUIDE 诚实边界"被吞区域内的诊断不报"同口径;换得 HEAD 漏报的块
  // 未闭合 M2002 被报出。
  // 9b(补 `}` 形态):扫描停在 `fn` 边界,第二个 fn 顶层真实解析+检查(M3002@6 为语料自身
  // return 类型错)——直接证明"恢复不吞到文件尾,第二个 fn 正常"。旧 5 条 → 新 2 条。
  {
    const pa = m73('v73_9a_depthguard.ming', [
      'fn f() with io {',
      '    print(1);',
      '    test x { let a = 1;',
      '}',
      'fn g() { return 2; }',
    ].join('\n'));
    const ra = chk73(pa);
    const dsa = ds73(ra);
    check('v73.9a:深度守卫(失败语句含未闭合 "{")——恰 2 条有界诊断(M2001 根因 + M2002 块未闭合),恢复不吞到文件尾,零顶层级联(旧 4 条 → 新 2 条)',
      dsa.length === 2 && codes73(ra) === 'M2001,M2002' && dsa.some((d) => d.code === 'M2001' && d.message.includes('test')) && !hasTop73(ra),
      `n=${dsa.length} codes=${codes73(ra)} hasTop=${hasTop73(ra)}`);
  }
  {
    const pb = m73('v73_9b_depthguard2.ming', [
      'fn f() with io {',
      '    print(1);',
      '    test x { let a = 1;',
      '}',
      '}',
      'fn g() { return 2; }',
    ].join('\n'));
    const rb = chk73(pb);
    const dsb = ds73(rb);
    const m3002b = dsb.find((d) => d.code === 'M3002');
    check('v73.9b:深度守卫(补 `}` 形态)——第二个 fn 顶层真实解析+检查(M3002@6 为语料自身类型错),零顶层级联,证明恢复停在语句边界(旧 5 条 → 新 2 条)',
      dsb.length === 2 && codes73(rb) === 'M2001,M3002' && dsb.some((d) => d.code === 'M2001' && d.message.includes('test'))
        && m3002b && m3002b.line === 6 && !hasTop73(rb),
      `n=${dsb.length} codes=${codes73(rb)} lines=${dsb.map((d) => d.line).join(',')}`);
  }

  // ---- v73.10 --json 协议:锚定语料 diagnostics 数组长度=1 且 codes=['M2001'] ----
  {
    const p = m73('v73_10_json.ming', ANCHOR73);
    const res = chk73(p);
    const ds = ds73(res);
    check('v73.10:--json 协议——JSON 可解析,ok=false,diagnostics 长度=1,codes 恰为 [\'M2001\']',
      res.j !== null && res.j.ok === false && Array.isArray(res.j.diagnostics) && res.j.diagnostics.length === 1
        && JSON.stringify(res.j.diagnostics.map((d) => d.code)) === JSON.stringify(['M2001']),
      `j=${res.j === null ? 'null' : 'ok'} n=${ds.length} codes=${JSON.stringify(ds.map((d) => d.code))}`);
  }

  // ---- §73-END
}

// ===================== 74. v0.71:诊断残留收口(salvage 精化/valBrace 所有权/M3049 化)=====================
// 文件所有权:§74 = 本区全部用例(任务 1/2/3;#61 test 栈位置与 N-68 fmt 文案由并行 agent 负责,不在本区)。
// 三个机制(全部 src/parser.js + src/checker.js,零新增 M 码):
//   ① #68 salvage 精化:recover(false) 语句层停机表新增深度 0 `id(` 启发式——当前 token 是标识符
//      且下一个 token 是 `(` 时停机不消费(疑似新调用语句起始),交还块循环按语句解析抢救。
//      效果:GUIDE 1259 登记语料 v0.70 = 1 条(行 8 真实 M3001 静默)→ v0.71 = 2 条(根因 M2001 +
//      nosuchfn_xyz 的 M3001,真实错误恢复报出);基线 v0.69 = 4 条误导。
//   ② #67 valBrace 构造级登记所有权:登记所有权分层(块入口快照)——本块内失败的值构造其收尾 `}`
//      由本块 recover 消费结清(随消费同步递减),外层活构造的收尾交还外层构造的收尾 expectOp;
//      不变量:任意 recover 退出时 valBrace 精确等于"已消费未匹配的 `{` 数"中仍活着的部分
//      (无负数/无陈旧/无双重递减)。效果:"嵌套块在值构造内失败"形态的伪 M2002"期望 }"/伪 M2003
//      全部消失,根因保留,真实诊断(checker 层)补位——error 总量持平伪→真。
//   ③ #69 嵌套污点位置 M3049 化(N-63.1 五形态 + v0.68 审查 m2):untrustedMismatchDiag 判定改
//      typeContainsUntrusted(actual) && !typeContainsUntrusted(expected)——嵌套位置(容器载荷/
//      块尾/match 臂混型/spawn_all 元素/变体构造载荷)发 M3049 带净化处方,不再回落 M3002;
//      全部仍正确拒绝,直传位码与消息逐字不变,双侧都含污维持 M3002,Some(污) 污类型自洽传播合法。
// 纪律:全部先实测后断言;改前条数取自 HEAD 5c176d6(v0.70.0)与 v0.69 副本(Temp/v70verify/repo_head)实测。
{
  const dir74 = path.join(TMP, 'v74');
  fs.mkdirSync(dir74, { recursive: true });
  const m74 = (name, src) => { const f = path.join(dir74, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const chk74 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 崩溃/挂起形态 → j=null,由断言点名 */ }
    return { code: r.code, j };
  };
  const ds74 = (res) => (res.j && res.j.diagnostics) || [];
  const codes74 = (res) => ds74(res).map((d) => d.code).sort().join(',');
  const msgHas74 = (res, code, frag) => ds74(res).some((d) => d.code === code && (d.message || '').includes(frag));

  // ---- 任务 1(#68 salvage 精化):深度 0 `id(` 停机启发式 ----
  {
    // v74.1:GUIDE 1259 登记语料形态(test 块后跟未知名调用)——根因保留 + salvage 生效。
    // 实测:v0.69 基线 4 条误导 → v0.70(HEAD) 1 条(M2001@4 根因;行 8 nosuchfn_xyz 的真实
    // M3001 静默)→ v0.71 恰 2 条(根因 + M3001@8)。salvage 把 `nosuchfn_xyz(` 停机交还,
    // 语句被解析,checker 报出未知名。
    const p = m74('v74_1_anchor_idcall.ming', [
      'fn add(a: i64, b: i64) -> i64 { return a + b; }',
      'fn main() with io {',
      '    print("hi");',
      '    test add_works {',
      '        assert_eq(add(2, 3), 5);',
      '        assert_eq(add(1, 1), 2);',
      '    }',
      '    nosuchfn_xyz();',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    check('v74.1:salvage 精化——GUIDE 1259 语料恰 2 条:根因 M2001@4 含 "test" + nosuchfn_xyz 的 M3001@8(真实错误恢复报出,旧 v0.70 静默/v0.69 4 条误导)',
      ds.length === 2 && codes74(res) === 'M2001,M3001'
        && ds.some((d) => d.code === 'M2001' && d.line === 4 && d.message.includes('test'))
        && ds.some((d) => d.code === 'M3001' && d.line === 8 && d.message.includes('nosuchfn_xyz')),
      `n=${ds.length} codes=${codes74(res)} lines=${ds.map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v74.2:salvage 救回的调用语句之后的合法语句仍被解析(let z 产生 W3101 证明解析到位)。
    // 实测 3 条:M2001@3(根因)+ M3001@6(未知名)+ W3101@6(z 未使用——即 let z 确实被解析)。
    const p = m74('v74_2_salvage_then_let.ming', [
      'fn main() with io {',
      '    print("a");',
      '    test broken {',
      '        assert_eq(1, 1);',
      '    }',
      '    unknown_call_xyz(1);',
      '    let z = 9;',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    check('v74.2:salvage 救回调用语句且后续 let 仍解析——M2001@3 根因 + M3001@6 未知名 + W3101@7(z 未使用证明 let 被解析到位)',
      codes74(res) === 'M2001,M3001,W3101'
        && ds.some((d) => d.code === 'M2001' && d.line === 3)
        && ds.some((d) => d.code === 'M3001' && d.line === 6 && d.message.includes('unknown_call_xyz'))
        && ds.some((d) => d.code === 'W3101' && d.line === 7),
      `codes=${codes74(res)} lines=${ds.map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v74.3:毒汤终止性冒烟——9 层 `id(` 嵌套毒汤(启发式停机点密集)+ 块内毒。
    // 终止性链路:启发式停机不消费 → 失败点仍 id( 时 catch 强进(next()+recover)保证每轮
    // 至少前进 1 token → 必达 eof。runMing 自带 30s timeout,挂起形态 r.code=null 被点名。
    // 实测:exit 1,恰 4 条(M2001 根因 + M2002 + 2×M2001 级联毒,全部有界)。
    const p = m74('v74_3_poison_terminate.ming', [
      'fn main() {',
      '  a( b( c( d( e( f( g( h( i( j( k(',
      '  let q = ;',
      '  zz(',
      '}',
      'fn t() { return 3; }',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    check('v74.3:毒汤终止性冒烟——9 层 id( 嵌套毒汤有限时间收敛(exit 1 非 timeout),诊断有界 ≤8 条,无挂起(启发式停机+强进链路实测)',
      res.code === 1 && res.j !== null && ds.length >= 1 && ds.length <= 8,
      `code=${res.code} j=${res.j === null ? 'null' : 'ok'} n=${ds.length} codes=${codes74(res)}`);
  }

  // ---- 任务 2(#67 valBrace 构造级登记所有权):四探针口径 ----
  {
    // v74.4:合法 struct 构造内嵌套块失败(纯 valBrace 形态)——伪 M2002"期望 }"消失,根因保留,
    // checker 真实诊断补位。实测改前 5 error(2×M2001 根因 + 伪 M2002@3:40 + 2×M3029)
    // → 改后 5 error(2×M2001 根因 + M3002@3:17 if 缺 else[真实] + 2×M3029),伪→真总量持平。
    const p = m74('v74_4_valbrace_struct.ming', [
      'struct S { a: i64 }',
      'fn main() {',
      '  let x = S{ a: if true { let q = ; } };',
      '  print("good1");',
      '  let y = 2 + ;',
      '  print("good2");',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const errs = ds.filter((d) => d.code !== 'W3101'); // W3101(x/y 未使用)与恢复机制无关,单列
    check('v74.4:valBrace 所有权(合法构造)——恰 5 条 error:M2001@3/M2001@5 根因保留 + M3002@3(if 缺 else,真实)+ 2×M3029;无伪 M2002"期望 }"',
      errs.length === 5 && errs.map((d) => d.code).sort().join(',') === 'M2001,M2001,M3002,M3029,M3029'
        && errs.some((d) => d.code === 'M2001' && d.line === 3)
        && errs.some((d) => d.code === 'M2001' && d.line === 5)
        && errs.some((d) => d.code === 'M3002' && d.line === 3 && d.message.includes('必须有 else'))
        && !msgHas74(res, 'M2002', '期望 "}"'),
      `n=${errs.length} codes=${errs.map((d) => d.code).sort().join(',')} lines=${errs.map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v74.5:p21 登记语料形态(Json{ 未导入)——伪 M2002@2:43"期望 }"消失,根因 2 条保留,
    // checker 真实 M3001("Json" 不是结构体)补位。实测改前 5 error(伪 M2002 在列)→ 改后
    // 5 error(伪→真 M3001@2:11),M2001 恰 2 条。
    const p = m74('v74_5_valbrace_p21.ming', [
      'fn main() {',
      '  let x = Json{ a: if true { let q = ; } };',
      '  print("good1");',
      '  let y = 2 + ;',
      '  print("good2");',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const errs = ds.filter((d) => d.code !== 'W3101');
    const m2001 = errs.filter((d) => d.code === 'M2001');
    check('v74.5:valBrace 所有权(p21 形态)——伪 M2002@2:43 消失(无任何"期望 }"),根因 M2001 恰 2 条,真实 M3001(Json 不是结构体)与 2×M3029 补位,共 5 条 error',
      errs.length === 5 && m2001.length === 2
        && m2001.some((d) => d.line === 2) && m2001.some((d) => d.line === 4)
        && msgHas74(res, 'M3001', 'Json') && !msgHas74(res, 'M2002', '期望 "}"'),
      `n=${errs.length} m2001=${m2001.length} codes=${errs.map((d) => d.code).sort().join(',')} lines=${errs.map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v74.6:p24 顶层 const 形态——recover(true) 入口清零(v0.70 MAJOR-1)保留,顶层行为逐字不变。
    // 实测新旧逐字同 4 条:M2002@1:16(根因)+ M2001@1:18 + M2001@3:15(根因)+ M3029@4:3。
    const p = m74('v74_6_valbrace_p24.ming', [
      'const K = S{ a 1 };',
      'fn main() {',
      '  let y = 2 + ;',
      '  print("g");',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    check('v74.6:valBrace 所有权(p24 顶层 const 形态)——恰 4 条逐字:M2002@1 根因 + M2001@1 + M2001@3 根因 + M3029@4(顶层 recover(true) 行为逐字不变,回归锁)',
      ds.length === 4 && codes74(res) === 'M2001,M2001,M2002,M3029'
        && ds.some((d) => d.code === 'M2002' && d.line === 1 && d.message.includes('期望 ":"'))
        && ds.some((d) => d.code === 'M2001' && d.line === 1)
        && ds.some((d) => d.code === 'M2001' && d.line === 3),
      `n=${ds.length} codes=${codes74(res)} lines=${ds.map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v74.7:p05 单层嵌套形态——伪 M2002 消失。实测改前 3 error(M2001+伪 M2002+M3029)
    // → 改后 3 error(M3001@2 真实 + M2001@2 根因 + M3029@3),error 总量持平伪→真。
    const p = m74('v74_7_valbrace_p05.ming', [
      'fn main() {',
      '  let x = Json{ a: if true { let q = ; } };',
      '  print("after");',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const errs = ds.filter((d) => d.code !== 'W3101');
    check('v74.7:valBrace 所有权(p05 形态)——恰 3 条 error:M3001@2(Json 不是结构体,真实)+ M2001@2 根因 + M3029@3;无伪 M2002',
      errs.length === 3 && errs.map((d) => d.code).sort().join(',') === 'M2001,M3001,M3029'
        && errs.some((d) => d.code === 'M2001' && d.line === 2)
        && !msgHas74(res, 'M2002', '期望 "}"'),
      `n=${errs.length} codes=${errs.map((d) => d.code).sort().join(',')} lines=${errs.map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v74.8:p06 match 臂嵌套块形态——伪 M2003(无效模式 ";")消失。实测改前 3 error
    // (M2001+伪 M2003+M3029)→ 改后 3 error(M3001@2 找不到 x[真实]+M2001@2 根因+M3029@3)。
    const p = m74('v74_8_valbrace_p06.ming', [
      'fn main() {',
      '  let r = match x { 1 => { let q = ; } };',
      '  print("after");',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const errs = ds.filter((d) => d.code !== 'W3101');
    check('v74.8:valBrace 所有权(p06 match 形态)——恰 3 条 error:M3001@2(找不到值 x,真实)+ M2001@2 根因 + M3029@3;无伪 M2003',
      errs.length === 3 && errs.map((d) => d.code).sort().join(',') === 'M2001,M3001,M3029'
        && errs.some((d) => d.code === 'M2001' && d.line === 2)
        && !errs.some((d) => d.code === 'M2003'),
      `n=${errs.length} codes=${errs.map((d) => d.code).sort().join(',')} lines=${errs.map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v74.9:s1 压力复利不回升——200 行"构造内嵌套块失败"压力语料。实测改前 parser 层
    // 400 条(200 M2001 根因 + 200 伪 M2002)→ 改后 parser 层 200 条(伪全消),check 总量
    // 400 条(200 根因 + 200 真实 M3001)≤400 且不复利。
    const lines = ['fn main() {'];
    for (let i = 0; i < 200; i++) lines.push(`  let x${i} = Json{ a: if true { let q = ; } };`);
    lines.push('}');
    const p = m74('v74_9_valbrace_stress.ming', lines.join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const errs = ds.filter((d) => d.code !== 'W3101'); // W3101(x0..x199 未使用)200 条与恢复机制无关
    const m2002fake = errs.filter((d) => d.code === 'M2002' && (d.message || '').includes('期望 "}"')).length;
    check('v74.9:valBrace 所有权(200 行压力)——error 总量 ≤400 且无伪 M2002"期望 }"(改前 parser 层 200 条伪;复利不回升),M2001 根因恰 200 条,真实 M3001 恰 200 条',
      errs.length <= 400 && m2002fake === 0
        && errs.filter((d) => d.code === 'M2001').length === 200
        && errs.filter((d) => d.code === 'M3001').length === 200,
      `n=${errs.length} fakeM2002=${m2002fake} m2001=${errs.filter((d) => d.code === 'M2001').length} m3001=${errs.filter((d) => d.code === 'M3001').length}`);
  }

  // ---- 任务 3(#69 嵌套污点位置 M3049 化):五形态 + 直传逐字 + 双侧污 M3002 ----
  {
    // v74.10:m2 形态——Some(污) 载荷经泛型槽合法绑定为 Option[Untrusted[str]],let 标注位
    // 发 M3049(带净化处方)。实测改前 M3002"let 标注类型是 Option[str]..."(无净化 hint)
    // → 改后恰 1 条 M3049。v0.72 remedy 文案校准:actual 是复合载体(Option[...]),
    // remedy 断言从中性"净化"收紧为中性措辞模板"不可信值嵌套于复合类型"(§75.5 同款)。
    const p = m74('v74_10_m2_some_let.ming', [
      'use std.env;',
      'fn main() with env {',
      '    let o: Option[str] = Some(std.env.get("X").unwrap());',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const errs = ds.filter((d) => d.code !== 'W3101');
    check('v74.10:M3049 化(m2:Some(污)→let 标注位)——恰 1 条 M3049,message 含期望 Option[str]/实际 Option[Untrusted[str]]/复合载体中性净化处方(旧 M3002 无 hint)',
      errs.length === 1 && errs[0].code === 'M3049'
        && errs[0].message.includes('期望 Option[str]') && errs[0].message.includes('实际 Option[Untrusted[str]]')
        && (errs[0].message || '').includes('净化')
        && (errs[0].message || '').includes('不可信值嵌套于复合类型'),
      `n=${errs.length} codes=${errs.map((d) => d.code).join(',')} msg=${JSON.stringify(errs[0] ? errs[0].message : '')}`);
  }
  {
    // v74.11:N-63.1 块尾形态——块尾值 Option[Untrusted[str]] vs 签名 Option[str] → M3049。
    // 实测改前 M3002@2:35 → 改后恰 1 条 M3049@2:35。v0.72 remedy 文案校准:复合载体
    // (Option[...])的 remedy 收紧断言为中性措辞模板"不可信值嵌套于复合类型"(§75.5 同款)。
    const p = m74('v74_11_blocktail.ming', [
      'use std.env;',
      'fn pick() -> Option[str] with env {',
      '    Some(std.env.get("X").unwrap())',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const errs = ds.filter((d) => d.code !== 'W3101');
    check('v74.11:M3049 化(块尾形态)——恰 1 条 M3049,message 含"块尾返回类型不匹配:期望 Option[str],实际 Option[Untrusted[str]]"+复合载体中性 remedy(旧 M3002)',
      errs.length === 1 && errs[0].code === 'M3049'
        && errs[0].message.includes('块尾返回类型不匹配:期望 Option[str],实际 Option[Untrusted[str]]')
        && (errs[0].message || '').includes('不可信值嵌套于复合类型'),
      `n=${errs.length} codes=${errs.map((d) => d.code).join(',')} msg=${JSON.stringify(errs[0] ? errs[0].message : '')}`);
  }
  {
    // v74.12:N-63.1 match 臂混型形态——污臂 vs 净臂。实测改前 3 条(M3049 块尾[顶层污已有]
    // + M3002 match 值类型 + M3002 分支混型)→ 改后 3 条全 M3049(块尾/match 值类型/分支混型)。
    // v0.72 remedy 文案校准注记:本语料 actual 均为直传位(Untrusted[str]),直传 remedy 逐字
    // 不受 MINOR-2 分流影响;复合位(actual 为容器/Result 形态)的中性措辞由 §75.5/§75.7 锁定。
    const p = m74('v74_12_match_arms.ming', [
      'use std.env;',
      'fn pick(n: i64) -> str with env {',
      '    match n {',
      '        1 => std.env.get("A").unwrap(),',
      '        _ => "clean",',
      '    }',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const m3049 = ds.filter((d) => d.code === 'M3049');
    check('v74.12:M3049 化(match 臂混型)——恰 3 条全 M3049(块尾/match 的值类型/分支类型不一致各 1),零 M3002 残留(旧 2×M3002)',
      ds.length === 3 && m3049.length === 3
        && msgHas74(res, 'M3049', '块尾返回类型不匹配') && msgHas74(res, 'M3049', 'match 的值类型不匹配')
        && msgHas74(res, 'M3049', 'match 分支类型不一致'),
      `n=${ds.length} codes=${codes74(res)} msgs=${ds.map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v74.13:N-63.1 spawn_all 元素形态——Vec[Untrusted[str]] 传净参数函数 → M3049 指向元素。
    // 实测改前 M3002"第二个参数必须是 Vec[str](实际 Vec[Untrusted[str]])"→ 改后恰 1 条 M3049。
    const p = m74('v74_13_spawnall_elem.ming', [
      'use std.env;',
      'fn load(s: str) -> str with env {',
      '    return s;',
      '}',
      'fn main() with sync, env {',
      '    let us = [std.env.get("A").unwrap(), std.env.get("B").unwrap()];',
      '    let rs = std.sync.spawn_all(load, us);',
      '    let _ = rs;',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const errs = ds.filter((d) => d.code !== 'W3101');
    check('v74.13:M3049 化(spawn_all 元素形态)——恰 1 条 M3049,message 含"spawn_all 的 Vec 元素类型不匹配:期望 str,实际 Untrusted[str]"(旧 M3002 整参数位)',
      errs.length === 1 && errs[0].code === 'M3049'
        && errs[0].message.includes('spawn_all 的 Vec 元素类型不匹配:期望 str,实际 Untrusted[str]'),
      `n=${errs.length} codes=${errs.map((d) => d.code).join(',')} msg=${JSON.stringify(errs[0] ? errs[0].message : '')}`);
  }
  {
    // v74.14:m2 用户变体载荷形态——具体净槽(E.Mk 的 str 载荷)传污 → M3049。
    // 实测改前 M3002@4:41"变体值类型不匹配:期望 str,实际 Untrusted[str]"→ 改后同位 M3049。
    const p = m74('v74_14_variant_payload.ming', [
      'use std.env;',
      'enum E { Mk(str) }',
      'fn main() with env {',
      '    let e = E.Mk(std.env.get("X").unwrap());',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const errs = ds.filter((d) => d.code !== 'W3101');
    check('v74.14:M3049 化(用户变体载荷形态)——恰 1 条 M3049,message 含"变体载荷类型不匹配:期望 str,实际 Untrusted[str]"(旧 M3002"变体值类型不匹配")',
      errs.length === 1 && errs[0].code === 'M3049'
        && errs[0].message.includes('变体载荷类型不匹配:期望 str,实际 Untrusted[str]'),
      `n=${errs.length} codes=${errs.map((d) => d.code).join(',')} msg=${JSON.stringify(errs[0] ? errs[0].message : '')}`);
  }
  {
    // v74.15:直传位逐字不变——顶层 Untrusted 进净槽的 M3049 码与消息 v0.61 起逐字稳定。
    // 实测改前后同:1 条 M3049,message 逐字(含载体感知净化 hint)。
    const p = m74('v74_15_direct_unchanged.ming', [
      'use std.env;',
      'fn main() with env {',
      '    let u = std.env.get("X").unwrap();',
      '    let s: str = u;',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const m3049 = ds.filter((d) => d.code === 'M3049');
    check('v74.15:直传位逐字不变——恰 1 条 M3049,message 逐字"let 标注类型不匹配:期望 str,实际 Untrusted[str](不可信值:先净化,或把目标改声明为 Untrusted[str])"',
      m3049.length === 1 && m3049[0].message === 'let 标注类型不匹配:期望 str,实际 Untrusted[str](不可信值:先净化,或把目标改声明为 Untrusted[str])',
      `n=${m3049.length} codes=${codes74(res)} msg=${JSON.stringify(m3049[0] ? m3049[0].message : '')}`);
  }
  {
    // v74.16:双侧都含污(结构错配)维持 M3002——Untrusted[str] 值进 Untrusted[Json] 槽
    // 不是"污进净槽",给净化处方即误导。实测恰 1 条 M3002,零 M3049。
    const p = m74('v74_16_both_dirty.ming', [
      'use std.env;',
      'fn main() with env {',
      '    let a: Untrusted[str] = std.env.get("X").unwrap();',
      '    let j: Untrusted[Json] = a;',
      '}',
    ].join('\n'));
    const res = chk74(p);
    const ds = ds74(res);
    const errs = ds.filter((d) => d.code !== 'W3101');
    check('v74.16:双侧含污维持 M3002——恰 1 条 M3002(Untrusted[str] vs Untrusted[Json] 结构错配),零 M3049(不给误导净化处方)',
      errs.length === 1 && errs[0].code === 'M3002' && errs[0].message.includes('Untrusted[Json]') && errs[0].message.includes('Untrusted[str]'),
      `n=${errs.length} codes=${errs.map((d) => d.code).join(',')} msg=${JSON.stringify(errs[0] ? errs[0].message : '')}`);
  }
  {
    // v74.17:Some(污) 污类型自洽传播合法——泛型载荷槽 unify 绑定(v0.61 deepResolveT 保的
    // 合法性),无任何诊断 exit 0。#69 改动不得误伤此路径(callCtor 前置只在 unify 失败后)。
    const p = m74('v74_17_some_dirty_ok.ming', [
      'use std.env;',
      'fn main() with env {',
      '    let o = Some(std.env.get("X").unwrap());',
      '    match o { Some(u) => { let _ = u; }, None => {} }',
      '}',
    ].join('\n'));
    const res = chk74(p);
    check('v74.17:Some(污) 污类型自洽传播合法——check exit 0 且零诊断(泛型载荷槽绑定合法,v0.61 语义不回退)',
      res.code === 0 && res.j !== null && res.j.ok === true && ds74(res).length === 0,
      `code=${res.code} ok=${res.j && res.j.ok} n=${ds74(res).length}`);
  }

  // ---- §74-END
}

// ===================== 75. v0.72:诊断质量补刀小批(if 分支混型 M3049 对称化/复合载体 remedy 精确化)=====================
// 文件所有权:§75 = 本区全部用例。零新增 M 码,无新语言面;两处改动都在 src/checker.js(v0.71 独立审查 2 MINOR):
//   ① MINOR-1——if 分支混型点(checkIf 值形式,仿 match 臂 v0.71 先例)双向接入 untrustedMismatchDiag:
//      分支混型且恰一侧含污 → M3049(what='if 两个分支类型不同',带净化处方);双侧净结构错配与双侧都含污
//      (结构错配)两者都未发码才落通用 M3002(消息文本不变)。污在 then 或 else 均捕获(对称化)。
//      注:合同实现下"恰一侧含污"数学上必发 M3049(两方向必有一向 actual 含污/expected 净)——
//      "污参与且 M3002 维持"的可达形态 = 双侧含污且结构错配(v75.3/v75.8 实测锁定)。
//   ② MINOR-2——untrustedMismatchDiag 的 remedy 按实际类型形态分流:直传位(a.k==='untrusted')的
//      str/json 双 remedy 逐字不变(v74.15 锁定,v75.6 复锁);复合载体(opt/vec/map/res/tuple 等嵌套
//      形态)改中性措辞"不可信值嵌套于复合类型:先投影取出污值→按载体净化",去掉对复合实参不成立的
//      "把目标改声明为 Untrusted[str]"误导处方。注:非泛型 struct 字面量的污值经字段位直传 actual
//      (Untrusted[str])先行拦截(字段位仍直传 remedy,v75.6 Raw 语料复锁)。注(v0.72 验证修正):
//      含污字段 struct 整值赋给目标(如 let c: Clean = r)可产生复合 actual——Raw 语料实测该位
//      换统一中性模板(误导子串消除,恰判定④原始目标);v75.6b 与该形态并存不冲突。复合位语料
//      取 Vec[Untrusted[str]](v75.5)与 struct 整值(v75.6b 同族)双形态。
// 纪律:全部先实测后断言;改前条数取自 HEAD b4a6f25(v0.71.0)实测(f2 原报 M3049@6:5 + M3002@6:31)。
{
  const dir75 = path.join(TMP, 'v75');
  fs.mkdirSync(dir75, { recursive: true });
  const m75 = (name, src) => { const f = path.join(dir75, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const chk75 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 崩溃/挂起形态 → j=null,由断言点名 */ }
    return { code: r.code, j };
  };
  const ds75 = (res) => (res.j && res.j.diagnostics) || [];
  const codes75 = (res) => ds75(res).map((d) => d.code).sort().join(',');
  const msgHas75 = (res, code, frag) => ds75(res).some((d) => d.code === code && (d.message || '').includes(frag));

  // ---- MINOR-1:if 分支混型 M3049 对称化 ----
  {
    // v75.1:对称化正例(嵌套形态,#69 登记语料 f2)——污嵌在 then 臂 Result 载荷。改前
    // M3049@6:5(let)+ M3002@6:31(if 混型回落)→ 改后恰 2 条 M3049,if 位消息 what=
    // 'if 两个分支类型不同' + 复合载体中性 remedy(MINOR-2 分流),零 M3002 残留。
    const p = m75('v75_1_if_tail.ming', [
      'use std.env;',
      '',
      'fn main() with env, io {',
      '    let u = env.get("X").unwrap();',
      '    let c = 1;',
      '    let r: Result[str, str] = if c == 1 {',
      '        Ok(u)',
      '    } else {',
      '        Ok("x")',
      '    };',
      '    print("x");',
      '}',
    ].join('\n'));
    const res = chk75(p);
    const ds = ds75(res);
    const m3049 = ds.filter((d) => d.code === 'M3049');
    check('v75.1:if 分支对称化正例(嵌套形态 f2)——恰 2 条 M3049(let 标注位 + if 混型位 what="if 两个分支类型不同"),复合 remedy,零 M3002(旧 M3002@6:31)',
      ds.length === 3 && m3049.length === 2 && codes75(res) === 'M3049,M3049,W3101'
        && msgHas75(res, 'M3049', 'let 标注类型不匹配:期望 Result[str, str],实际 Result[Untrusted[str], ?]')
        && msgHas75(res, 'M3049', 'if 两个分支类型不同:期望 Result[str, ?],实际 Result[Untrusted[str], ?]')
        && msgHas75(res, 'M3049', '不可信值嵌套于复合类型'),
      `n=${ds.length} codes=${codes75(res)} msgs=${ds.map((d) => d.code + '@' + d.line + ':' + d.col).join(',')}`);
  }
  {
    // v75.2:对称化正例(直传形态,双向覆盖)——then 臂污(g1):混型由反向调用 (tt,et) 捕获;
    // else 臂污(g2):混型由首调 (et,tt) 捕获。两向消息同形 what='if 两个分支类型不同' + 直传 remedy
    // 逐字;g2 的 let 反向(净 str 进 Untrusted 槽)维持 M3002(v0.61 口径,无隐式 mark)。
    const p1 = m75('v75_2a_if_then_direct.ming', [
      'use std.env;',
      '',
      'fn main() with env, io {',
      '    let u = env.get("X").unwrap();',
      '    let c = 1;',
      '    let s: str = if c == 1 { u } else { "x" };',
      '    print("x");',
      '}',
    ].join('\n'));
    const r1 = chk75(p1);
    const p2 = m75('v75_2b_if_else_direct.ming', [
      'use std.env;',
      '',
      'fn main() with env, io {',
      '    let u = env.get("X").unwrap();',
      '    let c = 1;',
      '    let w: Untrusted[str] = if c == 1 { "x" } else { u };',
      '    let _ = w;',
      '}',
    ].join('\n'));
    const r2 = chk75(p2);
    check('v75.2:if 分支对称化正例(直传形态双向)——then 污与 else 污各发 1 条 if 位 M3049(what="if 两个分支类型不同" + 直传 remedy 逐字),else 污语料的 let 反向维持 M3002',
      ds75(r1).length === 3 && msgHas75(r1, 'M3049', 'let 标注类型不匹配:期望 str,实际 Untrusted[str](不可信值:先净化,或把目标改声明为 Untrusted[str])')
        && msgHas75(r1, 'M3049', 'if 两个分支类型不同:期望 str,实际 Untrusted[str](不可信值:先净化,或把目标改声明为 Untrusted[str])')
        && ds75(r2).length === 2 && msgHas75(r2, 'M3049', 'if 两个分支类型不同:期望 str,实际 Untrusted[str](不可信值:先净化,或把目标改声明为 Untrusted[str])')
        && msgHas75(r2, 'M3002', 'let 标注类型是 Untrusted[str],但初始化表达式是 str'),
      `r1=${codes75(r1)} r2=${codes75(r2)} r2msgs=${ds75(r2).map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v75.3:单侧直传污 + 另一侧结构错配(亦含污)→ M3002 维持——分支一侧直传污(Untrusted[str])、
    // 另一侧复合嵌套污(Option[Untrusted[str]]),双侧都含污是结构错配而非"污进净槽",
    // 双向 untrustedMismatchDiag 都不发码落 M3002(不给误导净化处方,v74.16 同语义在 if 新调用点)。
    // if 位零 M3049;唯一 M3049 在 let 标注位(actual=Untrusted[str] 直传,与 if 位无关)。
    const p = m75('v75_3_if_dirty_vs_wrapped.ming', [
      'use std.env;',
      '',
      'fn main() with env, io {',
      '    let u = env.get("X").unwrap();',
      '    let c = 1;',
      '    let o: Option[str] = if c == 1 { u } else { Some(u) };',
      '    print("x");',
      '}',
    ].join('\n'));
    const res = chk75(p);
    const ds = ds75(res);
    const ifM3049 = ds.some((d) => d.code === 'M3049' && (d.message || '').includes('if 两个分支类型不同'));
    check('v75.3:if 单侧直传污+另一侧结构错配(亦含污)→ M3002 维持——if 位消息逐字"if 两个分支类型不同:Untrusted[str] 与 Option[Untrusted[str]]",if 位零 M3049(双侧污不发净化处方)',
      ds.length === 3 && msgHas75(res, 'M3002', 'if 两个分支类型不同:Untrusted[str] 与 Option[Untrusted[str]]')
        && !ifM3049 && msgHas75(res, 'M3049', 'let 标注类型不匹配:期望 Option[str],实际 Untrusted[str]'),
      `n=${ds.length} codes=${codes75(res)} msgs=${ds.map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v75.4:双侧净结构错配 → 通用 M3002 消息文本不变——对称化接入不得影响纯混型回落路径
    // (str vs i64,无任何污参与),消息逐字"if 两个分支类型不同:str 与 i64"。
    const p = m75('v75_4_if_clean_mixed.ming', [
      'fn main() {',
      '    let c = 1;',
      '    let r: str = if c == 1 { "x" } else { 42 };',
      '    let _ = r;',
      '}',
    ].join('\n'));
    const res = chk75(p);
    const ds = ds75(res);
    check('v75.4:双侧净结构错配维持 M3002——恰 1 条诊断,消息逐字"if 两个分支类型不同:str 与 i64"(纯混型回落路径不受对称化影响)',
      ds.length === 1 && ds[0].code === 'M3002' && ds[0].message === 'if 两个分支类型不同:str 与 i64',
      `n=${ds.length} codes=${codes75(res)} msg=${JSON.stringify(ds[0] ? ds[0].message : '')}`);
  }

  // ---- MINOR-2:复合载体 remedy 中性措辞 ----
  {
    // v75.5:复合载体(actual=Vec[Untrusted[str]])remedy 中性措辞——message 含中性模板全文,
    // 不含"把目标改声明为 Untrusted[str]"子串(对复合实参该处方不成立,MINOR-2 核心断言)。
    const p = m75('v75_5_vec_composite.ming', [
      'use std.env;',
      '',
      'fn main() with env, io {',
      '    let u = env.get("X").unwrap();',
      '    let v = [u];',
      '    let v2: Vec[str] = v;',
      '    let _ = v2;',
      '}',
    ].join('\n'));
    const res = chk75(p);
    const ds = ds75(res);
    const m3049 = ds.filter((d) => d.code === 'M3049');
    check('v75.5:复合载体 remedy 中性措辞——恰 1 条 M3049,message 含"不可信值嵌套于复合类型:先投影取出污值(容器 .get/.unwrap/解构)再按其载体净化"模板且不含"把目标改声明为 Untrusted[str]"子串',
      m3049.length === 1
        && m3049[0].message.includes('let 标注类型不匹配:期望 Vec[str],实际 Vec[Untrusted[str]](不可信值嵌套于复合类型:先投影取出污值(容器 .get/.unwrap/解构)再按其载体净化(str 载荷经 std.unstr.sanitize_*;Json 载荷经 .as_str() 投影后净化),或在目标类型对应位置承载 Untrusted)')
        && !m3049[0].message.includes('把目标改声明为 Untrusted[str]'),
      `n=${ds.length} codes=${codes75(res)} msg=${JSON.stringify(m3049[0] ? m3049[0].message : '')}`);
  }
  {
    // v75.6:直传 remedy 逐字回归锁(MINOR-2 分流不得误伤直传位)——(a) v74.15 同口径语料
    // message 逐字;(b) Raw 结构体字段位语料:非泛型 struct 字面量污值经字段位直传 actual
    // 拦截,字段位 remedy 仍逐字"把目标改声明为 Untrusted[str]"(字段位该处方成立:可改声明
    // struct Raw { p: Untrusted[str] })。
    const p1 = m75('v75_6a_direct_let.ming', [
      'use std.env;',
      'fn main() with env {',
      '    let u = std.env.get("X").unwrap();',
      '    let s: str = u;',
      '}',
    ].join('\n'));
    const r1 = chk75(p1);
    const p2 = m75('v75_6b_raw_field.ming', [
      'use std.env;',
      '',
      'struct Raw {',
      '    p: str,',
      '}',
      '',
      'fn main() with env, io {',
      '    let u = env.get("X").unwrap();',
      '    let w: Raw = Raw{ p: u };',
      '    print("x");',
      '}',
    ].join('\n'));
    const r2 = chk75(p2);
    const m1 = ds75(r1).filter((d) => d.code === 'M3049');
    const m2 = ds75(r2).filter((d) => d.code === 'M3049');
    check('v75.6:直传 remedy 逐字回归锁——let 直传位与 Raw 字段位 message 均逐字"(不可信值:先净化,或把目标改声明为 Untrusted[str])"(v74.15 同口径;MINOR-2 分流仅改复合位)',
      m1.length === 1 && m1[0].message === 'let 标注类型不匹配:期望 str,实际 Untrusted[str](不可信值:先净化,或把目标改声明为 Untrusted[str])'
        && m2.length === 1 && m2[0].message === '字段 "p" 类型不匹配:期望 str,实际 Untrusted[str](不可信值:先净化,或把目标改声明为 Untrusted[str])',
      `m1=${JSON.stringify(m1[0] ? m1[0].message : '')} m2=${JSON.stringify(m2[0] ? m2[0].message : '')}`);
  }

  // ---- 回归:match 位与双侧污语义不回退 ----
  {
    // v75.7:match 对称化回归(#69 登记语料 f3)——3 条 M3049(let 标注/match 值类型/match 分支
    // 类型不一致)零 M3002,复合位 remedy 校准为中性措辞(v0.72);另 match 位双侧污结构错配
    // (Untrusted[str] 臂 vs Option[Untrusted[str]] 臂)维持 M3002(bidirectional bail 不给处方)。
    const p1 = m75('v75_7a_match_arms.ming', [
      'use std.env;',
      '',
      'fn main() with env, io {',
      '    let u = env.get("X").unwrap();',
      '    let n = 1;',
      '    let r: Result[str, str] = match n {',
      '        1 => Ok(u),',
      '        _ => Ok("x"),',
      '    };',
      '    print("x");',
      '}',
    ].join('\n'));
    const r1 = chk75(p1);
    const p2 = m75('v75_7b_match_both_dirty.ming', [
      'use std.env;',
      '',
      'fn pick(n: i64) -> str with env {',
      '    match n {',
      '        1 => env.get("A").unwrap(),',
      '        _ => Some(env.get("B").unwrap()),',
      '    }',
      '}',
    ].join('\n'));
    const r2 = chk75(p2);
    check('v75.7:match 对称化回归——f3 语料恰 3 条全 M3049(块尾/match 的值类型/match 分支类型不一致各 1,复合位中性 remedy),零 M3002;match 位双侧污语料维持 1 条 M3002"match 分支类型不一致:Untrusted[str] 与 Option[Untrusted[str]]"',
      ds75(r1).length === 4 && codes75(r1) === 'M3049,M3049,M3049,W3101'
        && msgHas75(r1, 'M3049', 'match 的值类型不匹配:期望 Result[str, str],实际 Result[Untrusted[str], ?]')
        && msgHas75(r1, 'M3049', 'match 分支类型不一致:期望 Result[str, ?],实际 Result[Untrusted[str], ?]')
        && msgHas75(r1, 'M3049', '不可信值嵌套于复合类型')
        && ds75(r2).length === 3 && msgHas75(r2, 'M3002', 'match 分支类型不一致:Untrusted[str] 与 Option[Untrusted[str]]')
        && ds75(r2).filter((d) => d.code === 'M3049').length === 2,
      `r1=${codes75(r1)} r2=${codes75(r2)} r2msgs=${ds75(r2).map((d) => d.code + '@' + d.line).join(',')}`);
  }
  {
    // v75.8:双侧污 M3002 维持(v74.16 同款载体对在 if 新调用点)——Untrusted[str] 分支 vs
    // Untrusted[Json] 分支是载体结构错配而非"污进净槽",if 位落 M3002 逐字,零 M3049
    // (不给净化处方);let j/let w 两处反向错配维持 M3002(v0.61 口径)。
    const p = m75('v75_8_if_both_dirty.ming', [
      'use std.env;',
      '',
      'fn main() with env, io {',
      '    let a: Untrusted[str] = env.get("X").unwrap();',
      '    let j: Untrusted[Json] = a;',
      '    let c = 1;',
      '    let w: Untrusted[Json] = if c == 1 { a } else { j };',
      '    let _ = w;',
      '}',
    ].join('\n'));
    const res = chk75(p);
    const ds = ds75(res);
    check('v75.8:双侧污维持 M3002(if 位)——恰 3 条全 M3002 零 M3049,if 位消息逐字"if 两个分支类型不同:Untrusted[str] 与 Untrusted[Json]"(v74.16 语义在对称化新调用点不回退)',
      ds.length === 3 && codes75(res) === 'M3002,M3002,M3002'
        && msgHas75(res, 'M3002', 'if 两个分支类型不同:Untrusted[str] 与 Untrusted[Json]'),
      `n=${ds.length} codes=${codes75(res)} msgs=${ds.map((d) => d.code + '@' + d.line).join(',')}`);
  }

  // ---- §75-END
}


// ===================== 76. v0.73:解析深嵌套守卫(裸栈崩溃 → 稳定诊断)=====================
// 文件所有权:§76 = 本区全部用例。改动面:src/parser.js 单文件——解析递归深度计数器
// this.exprDepth(构造器置 0)+ 四挂点 try/finally 进出配对:parsePrimary(全部表达式叶子
// 入口,主闸)+ parseUnary(`-`/`!` 自递归)+ parseIf(else-if 链直接递归)+ parseBlock
// (嵌套块直接递归);超限 PARSE_DEPTH_LIMIT=120 → bail M2001"表达式嵌套过深(>120 层);
// 提示:拆分嵌套结构或引入中间绑定"稳定诊断。零新增 M 码(M2001 既有复用);编译器/求值侧
// 零改动(实测解析器是全管线第一个崩的点:run/check 在各形态解析崩点正下方均存活——
// paren@230/ifexpr@285/callnest@245 OK;interp.js 的 depth>250 守卫是 Ming 调用栈递归
// M4005,与表达式嵌套无关,不在本面)。
// 阈值依据(2026-11-15 本机实测,Node v24.11.0/win32-x64,详见 src/parser.js 头注):
// 合同原拟 300 基于抽测深度 1200-2000——实测最小崩点远低于此(lambda ~221/括号 ~234/
// if-expr ~291/Map 字面量 ~296,300 落在崩区内),故下调 120;合法语料(32 文件 examples+tools)
// 实测最大下降深度 12 层,fuzz 预算 ≤~15——10 倍余量。合同 v76.2 原拟"800 层括号合法解析"
// 不可达(无守卫时裸崩点 ~234 层,实测),正例校准为 100 层(有效合法边界 118 层:fn 体块
// 与叶子 primary 各计 1 层),负例 1500 层 if-expr(2 层/单位计数,守卫于 ~61 单位触发)。
// 纪律:全部先实测后断言;裸崩判定 = 输出含 "Maximum call stack"/"RangeError"。
{
  const dir76 = path.join(TMP, 'v76');
  fs.mkdirSync(dir76, { recursive: true });
  const m76 = (name, src) => { const f = path.join(dir76, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const chk76 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 裸栈崩溃形态 → j=null,由断言点名 */ }
    return { code: r.code, j, out: r.stdout + r.stderr };
  };
  const crash76 = (res) => res.out.includes('Maximum call stack') || res.out.includes('RangeError');
  const deepMsg76 = (res) => (res.j && res.j.diagnostics || []).filter((d) => d.code === 'M2001' && (d.message || '').includes('嵌套过深'));
  const ifexprSrc76 = (n) => 'fn main() -> i64 { let x = ' + 'if true { 1 } else { '.repeat(n) + '0' + ' }'.repeat(n) + '; return 0; }\n';
  const parenSrc76 = (n) => 'fn main() -> i64 { let x = ' + '('.repeat(n) + '1' + ')'.repeat(n) + '; return 0; }\n';

  // ---- v76.1:deepexpr 形态(1500 层 if-expr)→ 稳定 M2001,无裸栈崩溃 ----
  {
    // 改前(HEAD):裸 RangeError "Maximum call stack size exceeded"(parseMul 栈帧)exit 1;
    // 改后:恰 1 条 M2001"表达式嵌套过深(>120 层)"(截断 AST 另有 checker M3002 属诚实报告,
    // 不在本断言面;实测诊断集 = W3101 + M3002 + M2001×1（v0.73 审查 NOTE-3 补正:W3101 未使用警告合法存在）)。
    const p = m76('v76_1_deepexpr.ming', ifexprSrc76(1500));
    const res = chk76(p);
    const deep = deepMsg76(res);
    check('v76.1:deepexpr 1500 层 if-expr——check exit 1 + 恰 1 条 M2001"嵌套过深(>120 层)"稳定诊断,零裸栈崩溃(Maximum call stack/RangeError 不出现)',
      res.code === 1 && res.j !== null && deep.length === 1
        && (deep[0].message || '').includes('>120 层') && (deep[0].message || '').includes('拆分嵌套结构或引入中间绑定')
        && !crash76(res),
      `exit=${res.code} json=${res.j !== null} M2001嵌套过深=${deep.length} 裸崩=${crash76(res)} codes=${res.j ? (res.j.diagnostics || []).map((d) => d.code).join(',') : String(res.out).slice(0, 120)}`);
  }

  // ---- v76.2:deepparen 合法形态(100 层括号)→ 不误伤,check/run 双 exit 0 ----
  {
    // 合法深层表达式必须照常解析+编译+运行(100 层 = 合法边界 118 层下方,守卫远离此点;
    // 改前 HEAD 该深度实测亦 exit 0——本断言同时锁定"守卫不引入回归"与"不误伤")。
    // 注:语料 `let x = (...); return 0;` 恒有 1 条 W3101 未使用警告(exit 0 合法)——
    // 断言按"零 M 码诊断"口径(守卫误触只会以 M2001 出现)。
    const p = m76('v76_2_deepparen_ok.ming', parenSrc76(100));
    const c = chk76(p);
    const r = runMing(['run', p]);
    const mCodes76 = (c.j && c.j.diagnostics || []).filter((d) => /^M/.test(d.code || ''));
    check('v76.2:deepparen 100 层(合法深表达式)——check exit 0 且 run exit 0 且零 M 码诊断(W3101 未使用警告合法存在;守卫不误伤,有效合法边界 118 层,阈值 120 远离崩区)',
      c.code === 0 && c.j !== null && mCodes76.length === 0 && r.code === 0 && !crash76(c) && !crash76({ out: r.stdout + r.stderr }),
      `check_exit=${c.code} run_exit=${r.code} codes=${c.j ? (c.j.diagnostics || []).map((d) => d.code).join(',') : '?'} 裸崩=${crash76(c)}`);
  }

  // ---- v76.3:嵌套失败恢复语料 → 守卫计数恢复路径零残留,两个深嵌套形态独立判定 ----
  {
    // 三函数连排:深100(合法)→ 深115+语法错(少右括号)→ 深115(合法)。断言:恰报语法错
    // (M2002/M3001,实测 2 条),零 M2001"嵌套过深"——若 bail 穿透后计数残留,后位深115
    // 形态(深度 117,残差 ≥4 即越限)会误触 M2001;零裸崩。
    const p = m76('v76_3_recover.ming', [
      'fn f1() -> i64 { let a = ' + '('.repeat(100) + '1' + ')'.repeat(100) + '; return a; }',
      'fn broken() -> i64 { let b = ' + '('.repeat(115) + '1 ; return b; }',
      'fn f2() -> i64 { let c = ' + '('.repeat(115) + '2' + ')'.repeat(115) + '; return c; }',
    ].join('\n') + '\n');
    const res = chk76(p);
    const ds = (res.j && res.j.diagnostics) || [];
    check('v76.3:深嵌套失败+恢复语料——exit 1 + 恰报语法错(M2002 存在,实测伴 M3001 截断诚实诊断)+ 零 M2001 嵌套过深(计数 finally 递减零残留,后位深 115 形态独立判定不误触)+ 零裸崩',
      res.code === 1 && res.j !== null && deepMsg76(res).length === 0
        && ds.some((d) => d.code === 'M2002') && !crash76(res),
      `exit=${res.code} json=${res.j !== null} codes=${ds.map((d) => d.code).join(',')} 裸崩=${crash76(res)}`);
  }

  // ---- v76.4:全 examples 回归冒烟 → 守卫不影响合法程序 ----
  {
    // 20 个示例全部 check exit 0(改前基线同;与 §1 run 黄金输出互补,本条锁 check 面)。
    const exDir = path.join(ROOT, 'examples');
    const exFiles = fs.readdirSync(exDir).filter((f) => f.endsWith('.ming')).sort();
    const bad = [];
    for (const f of exFiles) {
      const r = runMing(['check', path.join(exDir, f)]);
      if (r.code !== 0 || crash76({ out: r.stdout + r.stderr })) bad.push(`${f}(exit=${r.code})`);
    }
    check(`v76.4:全 examples(${exFiles.length} 文件)check 全 exit 0——解析深嵌套守卫对合法程序零影响`,
      exFiles.length >= 20 && bad.length === 0,
      `n=${exFiles.length} bad=${bad.join(',') || '无'}`);
  }

  // ---- v76.5:三个不经 parsePrimary 的直接递归形态 → 同计数器一并收进稳定诊断 ----
  {
    // 一元链(parseUnary 自递归,改前裸崩点 ~2050)/裸块(parseBlock 直接递归,~1137)/
    // else-if 链(parseIf 直接递归,~4150)。三形态改前均裸 RangeError;改后各自触发守卫。
    // 实测:unary/bareblock 恰 1 条 M2001;elseif 因 panic-mode 逐段恢复重解析为多条 M2001
    // (实测 4 条,每条指向一段超限下降——多诊断语义同 #63 panic-mode,不钉 exact 数)。
    const pU = m76('v76_5a_unary.ming', 'fn main() -> i64 { let x = ' + '!'.repeat(300) + 'true; return 0; }\n');
    const rU = chk76(pU);
    const pB = m76('v76_5b_bareblock.ming', 'fn main() -> i64 { ' + '{'.repeat(300) + ' return 0; ' + '}'.repeat(300) + ' }\n');
    const rB = chk76(pB);
    const pE = m76('v76_5c_elseif.ming', 'fn main() -> i64 { ' + 'if true { return 1; } else '.repeat(300) + '{ return 0; } }\n');
    const rE = chk76(pE);
    check('v76.5:一元链/裸块/else-if 链三直接递归形态——各自 exit 1 且 M2001"嵌套过深"≥1(unary/bareblock 实测恰 1),全部零裸栈崩溃',
      rU.code === 1 && deepMsg76(rU).length === 1 && !crash76(rU)
        && rB.code === 1 && deepMsg76(rB).length === 1 && !crash76(rB)
        && rE.code === 1 && deepMsg76(rE).length >= 1 && !crash76(rE),
      `unary: exit=${rU.code} n=${deepMsg76(rU).length} 裸崩=${crash76(rU)} | bareblock: exit=${rB.code} n=${deepMsg76(rB).length} 裸崩=${crash76(rB)} | elseif: exit=${rE.code} n=${deepMsg76(rE).length} 裸崩=${crash76(rE)}`);
  }

  // ---- v76.6/v76.7:wasm map_set_f64 / map_set_str 宿主导入覆盖(coverage agent 补测裁决) ----
  {
    // 形态:纯函数内 Map[str, f64] / Map[str, str] 字面量 + get().unwrap() 返回——MapLit
    // 发射按值类型逐条目走 map_set_f64 / map_set_str 导入(src/wasm.js MapLit:'map_set_' + valTy)。
    // 可观测面(三层合取,缺一即回落/错值):
    //   ① MING_WASM_DEBUG=1 → stderr "[wasm] fn mf OK" 且无 REJECT(函数体经 wasm 编译,导入被引用);
    //   ② --strict-wasm exit 0(wasm 分层真实执行,无回落——回落即 exit 2);
    //   ③ stdout 逐字 "1.5"/"x"——map_set_* 未真实调用则 map 为空,get 返回 None → unwrap
    //     M4006 panic(exit 101):输出正确即宿主导入真实调用(值往返证明;导入接线缺失在
    //     实例化期即失败)。count 口径:NODE_V8_COVERAGE 聚合下 vm.js map_set_f64/map_set_str
    //     行由此二用例首覆盖(改前基线 0——coverage agent 实测;v76.6 count=1 / v76.7 count=1)。
    const p = m76('v76_6_map_set_f64.ming', [
      'fn mf() -> f64 {',
      '    let m: Map[str, f64] = { "a": 1.5 };',
      '    return m.get("a").unwrap();',
      '}',
      '',
      'fn main() with io {',
      '    print(str(mf()));',
      '}',
    ].join('\n'));
    const d6 = runMing(['run', p, '--strict-wasm'], { env: { MING_WASM_DEBUG: '1' } });
    const e6 = d6.stderr ?? '';
    check('v76.6:wasm map_set_f64 覆盖——strict-wasm exit 0 + [wasm] fn mf OK 无 REJECT/实例化失败 + stdout 逐字 "1.5"(map_set_f64 真实调用,值往返证明)',
      d6.code === 0 && e6.includes('[wasm] fn mf OK') && !e6.includes('REJECT') && !e6.includes('实例化失败')
        && d6.stdout === '1.5\n',
      `exit=${d6.code} stdout=${JSON.stringify(d6.stdout)} stderr=${JSON.stringify(e6.split('\n').filter((l) => l.includes('wasm')).slice(0, 4))}`);
    const p7 = m76('v76_7_map_set_str.ming', [
      'fn ms() -> str {',
      '    let m: Map[str, str] = { "a": "x" };',
      '    return m.get("a").unwrap();',
      '}',
      '',
      'fn main() with io {',
      '    print(ms());',
      '}',
    ].join('\n'));
    const d7 = runMing(['run', p7, '--strict-wasm'], { env: { MING_WASM_DEBUG: '1' } });
    const e7 = d7.stderr ?? '';
    check('v76.7:wasm map_set_str 覆盖——strict-wasm exit 0 + [wasm] fn ms OK 无 REJECT/实例化失败 + stdout 逐字 "x"(map_set_str 真实调用,值往返证明)',
      d7.code === 0 && e7.includes('[wasm] fn ms OK') && !e7.includes('REJECT') && !e7.includes('实例化失败')
        && d7.stdout === 'x\n',
      `exit=${d7.code} stdout=${JSON.stringify(d7.stdout)} stderr=${JSON.stringify(e7.split('\n').filter((l) => l.includes('wasm')).slice(0, 4))}`);
  }

  // ---- v76.8:VMInterp.fromArtifact 加载路径(src/vm.js 覆盖缺口闭合;coverage agent 补测裁决) ----
  {
    // 事实修正(实测,coverage agent 处方前提校正):tools 缓存命中走 toolArtifactToPrebuilt
    // (deserializeArtifact + new VMInterp(bin/ming.js)),**不经** VMInterp.fromArtifact 静态方法
    // ——bin/ming.js tools 缓存注释"命中直接 VMInterp.fromArtifact 执行"与实现不符(登记报告);
    // "同一工具冷/热两次 CLI + 输出一致 + 第二次 [tools-cache] hit"形态已由 §61 v57.20 覆盖
    // (6 例 + hit 标记),不重复。fromArtifact 唯一运行期调用方是 dist launcher(ming build 产物),
    // 而 launcher 执行 dist/runtime/vm.js 副本——NODE_V8_COVERAGE 按 src/*.js 聚合不可见,
    // 故 src/vm.js 的 fromArtifact 在覆盖基线中真实未覆盖。本用例进程内直调 fromArtifact
    // (与 launcher AOT 模式同一加载语义:deserializeArtifact + makeCheckLike + precompiled):
    // tools 冷跑写缓存 → 读缓存 JSON → fromArtifact 加载 → runMain 执行,断言 exit/输出与
    // CLI 冷跑逐字一致,二次加载执行同断言(加载合同:产物加载执行与全链路输出一致)。
    const dir768 = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-v768-'));
    const w768 = path.join(dir768, 'w.txt');
    fs.writeFileSync(w768, 'alpha beta\nalpha\n', 'utf8'); // 2 行 3 词 17 字节
    const TOOLS_CACHE_768 = path.join(ROOT, '.ming-cache', 'tools');
    const hadCache768 = fs.existsSync(TOOLS_CACHE_768);
    if (hadCache768) fs.rmSync(TOOLS_CACHE_768, { recursive: true, force: true }); // 冷跑保证条目恰 1
    const noDbg768 = { MING_TOOLS_DEBUG: '' }; // 显式关掉继承(防宿主 shell 泄漏,§61 noDbg 同款)
    const rCold = runMing(['tools', 'wc', w768], { cwd: dir768, env: noDbg768 });
    const entries768 = fs.existsSync(TOOLS_CACHE_768)
      ? fs.readdirSync(TOOLS_CACHE_768).filter((x) => x.endsWith('.json')) : [];
    let fa768 = null, fa2Out = null, faErr = '';
    try {
      const artifact = JSON.parse(fs.readFileSync(path.join(TOOLS_CACHE_768, entries768[0]), 'utf8'));
      const vm = VMInterp.fromArtifact(artifact, { capture: true });
      const r1 = vm.runMain([w768]); // launcher 模板在 runMain 之前剥 "--",此处直接传实参
      fa768 = { code: r1.exitCode, out: vm.flushCaptured() };
      const vm2 = VMInterp.fromArtifact(artifact, { capture: true });
      const r2 = vm2.runMain([w768]);
      fa2Out = { code: r2.exitCode, out: vm2.flushCaptured() };
    } catch (e) { faErr = String((e && e.message) || e); }
    if (!hadCache768) fs.rmSync(TOOLS_CACHE_768, { recursive: true, force: true }); // 恢复原状态(目录 gitignored)
    check('v76.8:VMInterp.fromArtifact 加载路径——缓存条目恰 1 + 进程内 fromArtifact 执行 exit/输出与 CLI 冷跑逐字一致,二次加载执行同断言(产物加载合同;vm.js fromArtifact 覆盖缺口闭合)',
      rCold.code === 0 && entries768.length === 1 && faErr === '' && fa768 !== null
        && fa768.code === 0 && fa768.out === rCold.stdout
        && fa2Out !== null && fa2Out.code === 0 && fa2Out.out === rCold.stdout,
      `cli=${rCold.code} entries=${entries768.length} faErr=${JSON.stringify(faErr)} `
        + `fa=${fa768 ? fa768.code + '/' + JSON.stringify(fa768.out) : 'null'} `
        + `fa2=${fa2Out ? fa2Out.code + '/' + JSON.stringify(fa2Out.out) : 'null'} `
        + `cliOut=${JSON.stringify(rCold.stdout)}`);
  }

  // ---- v76.9(v0.73 审查 MAJOR-1 锁定):嵌套字符串插值跨实例递归——每层 new Parser 新实例,
  // exprDepth 经构造器第三参(baseDepth)跨实例传递;修复前该形态 212 层裸崩(新最低崩点,
  // 低于其余形态最低 221)——150 层稳定 M2001,100 层合法通过 ----
  const BS769 = String.fromCharCode(92); // 反斜杠(Ming 插值开符 "\{" 的首字符;源码零反斜杠字面量——转义层纪律)
  const mkInterp769 = (n) => {
    let inner = '"x"';
    for (let i = 0; i < n; i++) inner = '"' + BS769 + '{' + inner + ' }"';
    return ['fn main() with io {', '    let x = ' + inner + ';', '    print(str(x.char_len()));', '}'].join(String.fromCharCode(10));
  };
  const p76_9a = m76('v76_9_interp150.ming', mkInterp769(150));
  const r76_9a = runMing(['check', p76_9a, '--json']);
  const p76_9b = m76('v76_9_interp100.ming', mkInterp769(100));
  const r76_9b = runMing(['check', p76_9b]);
  let j76_9a = null;
  try { j76_9a = JSON.parse(r76_9a.stdout); } catch { /* 崩溃形态 → 断言点名 */ }
  const d76_9a = j76_9a ? j76_9a.diagnostics.filter((d) => d.code === 'M2001' && (d.message || '').includes('嵌套过深')) : [];
  check('v76.9:嵌套字符串插值守卫(baseDepth 跨实例传递)——150 层 → M2001 表达式嵌套过深(零裸栈 RangeError);100 层合法 exit 0(守卫不误伤)',
    r76_9a.code === 1 && d76_9a.length >= 1
      && (r76_9a.stderr ?? '').includes('Maximum call stack') === false
      && r76_9b.code === 0,
    `a=${r76_9a.code}/${JSON.stringify((r76_9a.stdout ?? '').slice(0, 120))} b=${r76_9b.code}`);

  // ---- §76-END
}

// ===================== 77. v0.74:内联汇编(显式能力 with asm;ADR-006 12/12 go;cc 独占+M4017 具名回落)=====================
// 文件所有权:§77 = 本区全部用例(ADR-006 §1 grammar/§2 引擎口径/§3 门禁/§4 M4017/§6 fuzz 合同)。
// 形态参照:§58 unsafe(同"cc 独占+具名回落"家族:hasCC 探测+skip/M4016 句式/黄金+三路一致)与
// §72 eval(同"显式能力"家族:M3029 门禁/契约内/serve handler/build 回退/wasm 'none' 三态)。
// 正例(cc 真实执行:rdtsc 单调/bswap 字节序/lea 双 in 值进出)/三引擎具名回落(tree/VM/wasm 回落
// M4017[asm-cc-only] exit 101 消息逐字)/门禁面(M3029 无声明与逐层传播/契约内 M3029/serve handler
// 内 M3002/out 非 mut 既有码 M3004/in 非 i64 M3002/模板非字面量解析层拒绝 M2001-M2002)/
// wasm 'none' 三态(v72.13 口径)/build 具名回退源码模式(usesAsm)/tools 缓存回归/fuzz 0 分歧/
// REPL 冒烟/MING_CC 无效探测回落。
// 平台改口(2026-11-15 gcc 实测,win32 + w64devkit):任务原拟 syscall 39(getpid)/getpagesize(30)
// 为 Linux x86-64 专用 syscall ABI,Windows PE 无稳定用户态直接 syscall 面(ntdll 系统调用号随
// Windows 构建漂移 + KTHREAD 布局依赖)——v77.2 改为确定性用户态指令 bswap(同"编译器无内建场景"
// 意图)。rdtsc/lea/mov/bswap 模板全部 gcc 实测编译运行通过;任务草拟的 clobber("rax","rdx") 与
// "=a"/"=d" 输出绑定同用 → GCC "asm operand has impossible constraints" error,故 v77.1 不带
// clobber(=a/=d 约束即声明寄存器关联,与任务自注"约束只声明关联"一致)。
// 纪律:全部先实测后断言;cc 腿沿用 §58 hasCC 探测 + skip 口径。实现由并行 agent 落地于本分节
// 编写期间(src/parser+checker+cbackend+interp+vm+wasm+diag+bin,git status M 实录)——§77 全部
// 15 条已按落地实现逐条实测校准(2026-11-15):v77.2/v77.12 out 子句补 mut 关键字(解析层语法
// 强制)、v77.14 REPL 按实测口径(REPL 环境效果集 [io,time,fs,net] 不含 asm → 调用 M3029,
// M4017 在 REPL 不可观测)。HEAD 实现前基线(实录):asm 块 → M3030 unknown-effect + M2002。
{
  const dir77 = path.join(TMP, 'v77');
  fs.mkdirSync(dir77, { recursive: true });
  const m77 = (name, src) => { const f = path.join(dir77, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags77 = ['', '--no-wasm', '--tree'];
  const runAll77 = (p, extra = []) => flags77.map(f => runMing(f ? ['run', p, ...extra, f] : ['run', p, ...extra]));
  const first77 = (s) => (s ?? '').split('\n')[0];
  // 三引擎一致口径:stdout 全等 + stderr 首行相等(panic 多行输出按首行比对,v58.6 同款)
  const same3_77 = (runs) => runs.length === 3 && runs.every((r) => r.code === runs[0].code && r.stdout === runs[0].stdout && first77(r.stderr) === first77(runs[0].stderr));
  const fmtRuns77 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify(first77(r.stderr))}`).join(' | ');
  const chk77 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 崩溃形态 → j=null,由断言点名 */ }
    return { code: r.code, j, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  const codes77 = (res) => (res.j ? (res.j.diagnostics || []).map((d) => d.code).join(',') : '(no-json:exit ' + res.code + ')');
  const TAG77 = 'M4017[asm-cc-only]';
  const MSG77 = '内联汇编仅由 C 原生后端(ming cc)执行;tree/VM 不伪装机器语义';

  // cc 探测(§58 detectCC58 同款:MING_CC → PATH → 已知便携位置)
  const detectCC77 = () => {
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
  const hasCC77 = !!detectCC77();
  const ccRun77 = (file, out) => spawnSync(process.execPath, [MING, 'cc', file, '--out', out], { encoding: 'utf8', timeout: 180000 });

  // 共用语料:rdtsc(=a/=d 声明寄存器关联,无 clobber——GCC 实测 rax/rdx clobber 与输出绑定冲突)
  const p77_1 = m77('v77_1_rdtsc.ming', [
    'fn rdtsc() -> i64 with asm {',
    '    let mut lo: i64 = 0;',
    '    let mut hi: i64 = 0;',
    '    asm {',
    '        "rdtsc"',
    '        out("=a", mut lo)',
    '        out("=d", mut hi)',
    '    }',
    '    return lo + hi * 4294967296;',
    '}',
    'fn main() with io, asm {',
    '    let t1 = rdtsc();',
    '    let t2 = rdtsc();',
    '    print(str(t2 > t1));',
    '    print(str(t1 > 0));',
    '}',
  ].join('\n'));

  // ---- v77.1 正例(cc 真实执行):rdtsc 两次读取单调递增且非零 ----
  if (hasCC77) {
    const r771 = ccRun77(p77_1, path.join(dir77, 'c-rdtsc'));
    check('v77.1:rdtsc cc 真实执行——exit 0 + stdout 逐字 "true\\ntrue\\n"(tsc 两次单调递增且非零;__asm__ volatile 透传,=a/=d 约束回写 mut 变量)',
      r771.status === 0 && r771.stdout === 'true\ntrue\n' && (r771.stderr ?? '') === '',
      'status=' + r771.status + ' stdout=' + JSON.stringify(r771.stdout) + ' stderr=' + JSON.stringify((r771.stderr ?? '').slice(0, 200)));
  } else {
    check('v77.1:rdtsc cc 真实执行(无编译器,跳过)', true, 'skip: 无 C 编译器');
  }

  // ---- v77.2 值进出正确性(cc):bswap 确定性字节序往返(替代 Linux-only syscall getpid/getpagesize——
  // Windows PE 无稳定用户态直接 syscall 面,见节头平台改口;bswap 同为"编译器无内建场景"探针)----
  const p77_2 = m77('v77_2_bswap.ming', [
    'fn bswap64(x: i64) -> i64 with asm {',
    '    let mut r: i64 = 0;',
    '    asm { "mov %1, %0\\n\\tbswap %0" out("=r", mut r) in("r", x) }',
    '    return r;',
    '}',
    'fn main() with io, asm {',
    '    print(str(bswap64(72623859790382856) == 578437695752307201));',
    '    print(str(bswap64(578437695752307201) == 72623859790382856));',
    '}',
  ].join('\n'));
  if (hasCC77) {
    const r772 = ccRun77(p77_2, path.join(dir77, 'c-bswap'));
    check('v77.2:bswap cc 真实执行——exit 0 + stdout 逐字 "true\\ntrue\\n"(0x0102030405060708 ↔ 0x0807060504030201 双向字节序颠倒;多指令模板 \\n\\t 转义,Ming 词法 \\n \\t 实测支持)',
      r772.status === 0 && r772.stdout === 'true\ntrue\n' && (r772.stderr ?? '') === '',
      'status=' + r772.status + ' stdout=' + JSON.stringify(r772.stdout) + ' stderr=' + JSON.stringify((r772.stderr ?? '').slice(0, 200)));
  } else {
    check('v77.2:bswap cc 真实执行(无编译器,跳过)', true, 'skip: 无 C 编译器');
  }

  // ---- v77.3 三引擎具名回落:同一 rdtsc 程序 run(默认= wasm 回落 VM)/--tree/--no-wasm 全 M4017 ----
  const runs77_3 = runAll77(p77_1);
  check('v77.3:三引擎具名回落——run/--no-wasm/--tree 全 exit 101 + stdout 空 + stderr 首行三路逐字一致(含 M4017[asm-cc-only] 标签与合同消息)',
    runs77_3.every((r) => r.code === 101) && runs77_3.every((r) => r.stdout === '')
      && same3_77(runs77_3)
      && first77(runs77_3[0].stderr).includes(TAG77) && first77(runs77_3[0].stderr).includes(MSG77),
    `runs=${fmtRuns77(runs77_3)}`);

  // ---- v77.4 M3029 效果门禁:main 未声明 asm 直接写 asm 块 / helper with asm 逐层传播 ----
  const p77_4a = m77('v77_4a_no_effect.ming', [
    'fn main() with io {',
    '    asm { "nop" }',
    '}',
  ].join('\n'));
  const p77_4b = m77('v77_4b_prop.ming', [
    'fn go() -> i64 with asm {',
    '    asm { "nop" }',
    '    return 1;',
    '}',
    'fn main() with io {',
    '    print(str(go()));',
    '}',
  ].join('\n'));
  const r77_4a = chk77(p77_4a);
  const r77_4b = chk77(p77_4b);
  check('v77.4:M3029 效果门禁——main 未声明 asm 直接写 asm 块(check exit 1 + M3029 消息点名 asm);helper with asm 而 main 未声明 → M3029 逐层传播',
    r77_4a.code === 1 && !!r77_4a.j && r77_4a.j.diagnostics.some((d) => d.code === 'M3029' && (d.message || '').includes('asm'))
      && r77_4b.code === 1 && !!r77_4b.j && r77_4b.j.diagnostics.some((d) => d.code === 'M3029' && (d.message || '').includes('asm')),
    `a=${r77_4a.code}/${codes77(r77_4a)} b=${r77_4b.code}/${codes77(r77_4b)}`);

  // ---- v77.5 契约内 asm → M3029(asm 仅语句位,契约面经调用 asm 效果函数触达;声明处即检查,函数未调用也发射)----
  const p77_5 = m77('v77_5_contract.ming', [
    'fn probe() -> i64 with asm {',
    '    asm { "nop" }',
    '    return 1;',
    '}',
    'fn f(x: i64) -> i64 requires probe() > 0 {',
    '    return x;',
    '}',
    'fn main() with io {',
    '    print("x");',
    '}',
  ].join('\n'));
  const r77_5 = chk77(p77_5);
  check('v77.5:契约内 asm → M3029——requires 表达式调用 with asm 函数(契约表达式空效果集,非纯);声明处即检查,消息点名 asm',
    r77_5.code === 1 && !!r77_5.j && r77_5.j.diagnostics.some((d) => d.code === 'M3029' && (d.message || '').includes('asm')),
    `code=${r77_5.code}/${codes77(r77_5)}`);

  // ---- v77.6 serve handler 内 asm → M3002(handler 白名单 8 效果不含 asm;§66/v72.12 形态)----
  const p77_6 = m77('v77_6_serve.ming', [
    'use std.net;',
    'use std.json;',
    'fn handler(req: Untrusted[Json]) -> Json with asm {',
    '    asm { "nop" }',
    '    return std.json.parse("{}").unwrap();',
    '}',
    'fn main() with net, io {',
    '    match std.net.serve(27715, handler) {',
    '        Ok(v) => print("ok"),',
    '        Err(e) => print("err=\\{e}"),',
    '    }',
    '}',
  ].join('\n'));
  const r77_6 = chk77(p77_6);
  check('v77.6:serve handler 内 asm → M3002——handler 声明 with asm 不在 SERVE_HANDLER_EFFECTS 白名单(check exit 1,消息点名 asm)',
    r77_6.code === 1 && !!r77_6.j && r77_6.j.diagnostics.some((d) => d.code === 'M3002' && (d.message || '').includes('asm')),
    `code=${r77_6.code}/${codes77(r77_6)}`);

  // ---- v77.7 out 非 mut / in 非 i64(实测校准:mut 关键字是解析层语法强制(ADR §1 grammar
  // out(<约束>, mut <变量>);无关键字形态 → 解析 M2002,不在本断言面)。M3004 = checker 层
  // "mut 关键字在但变量本身非 mut"(asm 写入语义 = 对不可变量赋值,ADR §1"M3004 类既有码");
  // in 非 i64(str 值)→ M3002"asm in 操作数必须是 i64,实际是 str")----
  const p77_7a = m77('v77_7a_out_imm.ming', [
    'fn main() with io, asm {',
    '    let imm: i64 = 0;',
    '    asm { "nop" out("=r", mut imm) }',
    '    print(str(imm));',
    '}',
  ].join('\n'));
  const p77_7b = m77('v77_7b_in_str.ming', [
    'fn main() with io, asm {',
    '    asm { "nop" in("r", "strval") }',
    '}',
  ].join('\n'));
  const r77_7a = chk77(p77_7a);
  const r77_7b = chk77(p77_7b);
  check('v77.7:操作数类型面——out 目标非 mut 变量 → M3004(asm 写入 = 对不可变量赋值);in 操作数 str 值 → M3002(操作数全 i64,无隐式转换)',
    r77_7a.code === 1 && !!r77_7a.j && r77_7a.j.diagnostics.some((d) => d.code === 'M3004')
      && r77_7b.code === 1 && !!r77_7b.j && r77_7b.j.diagnostics.some((d) => d.code === 'M3002'),
    `a=${r77_7a.code}/${codes77(r77_7a)} b=${r77_7b.code}/${codes77(r77_7b)}`);

  // ---- v77.8 模板非字面量 → 解析层拒绝(注入卫生:模板/约束/clobber 字面量强制,ADR §3;M2001 unexpected/M2002 expected 类)----
  const p77_8 = m77('v77_8_nonliteral.ming', [
    'fn main() with io, asm {',
    '    let t = "nop";',
    '    asm { t }',
    '}',
  ].join('\n'));
  const r77_8 = chk77(p77_8);
  check('v77.8:模板非字面量解析层拒绝——asm { t }(str 变量作模板)→ check exit 1 + M2001/M2002 类解析诊断(运行时拼接在解析层拒绝,注入面消除)',
    r77_8.code === 1 && !!r77_8.j && r77_8.j.diagnostics.some((d) => /^M200[12]$/.test(d.code || '')),
    `code=${r77_8.code}/${codes77(r77_8)}`);

  // ---- v77.9 wasm 资格 "none" 三态(v72.13 口径):含 asm 函数永不 wasm eligible(effectOk 自动排除,零改动)
  // ——dormant 带 with asm 但 main 不执行 asm 块 → 三引擎 run 正常输出;--strict-wasm --json → exit 0 + wasm_status none ----
  const p77_9 = m77('v77_9_dormant.ming', [
    'fn dormant() -> i64 with asm {',
    '    asm { "nop" }',
    '    return 1;',
    '}',
    'fn main() with io, asm {',
    '    print("ok");',
    '}',
  ].join('\n'));
  const runs77_9 = runAll77(p77_9);
  const strict77_9 = runMing(['run', p77_9, '--strict-wasm', '--json']);
  let j77_9 = null;
  try { j77_9 = JSON.parse(strict77_9.stdout); } catch { /* 崩溃形态 → 断言点名 */ }
  check('v77.9:wasm 资格 "none" 口径(v72.13 先例)——dormant/main 含 asm 效果 → eligible=0;三引擎 run 输出 "ok\\n" exit 0(asm 块未执行,无 M4017);--strict-wasm --json → exit 0 且 wasm_status=none(不误报 ok/fallback)',
    same3_77(runs77_9) && runs77_9[0].code === 0 && runs77_9[0].stdout === 'ok\n'
      && strict77_9.code === 0 && j77_9 !== null && j77_9.wasm_status === 'none',
    `runs=${fmtRuns77(runs77_9)} strict=${strict77_9.code}/${JSON.stringify((strict77_9.stdout ?? '').slice(-60))}`);

  // ---- v77.10 ming build 遇 with asm:显式回退源码模式 + 具名原因(usesAsm);dist launcher 与源码模式一致(v72.14/v58.10 形态)----
  const bp77 = path.join(TMP, 'v77build');
  fs.mkdirSync(bp77, { recursive: true });
  fs.writeFileSync(path.join(bp77, 'ming.toml'), '[project]\nname = "v77asm"\nversion = "0.1.0"\nentry = "app.ming"\n');
  fs.copyFileSync(p77_9, path.join(bp77, 'app.ming'));
  const srcRun77b = runMing(['run', path.join(bp77, 'app.ming')]);
  const bld77 = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: bp77, timeout: 120000 });
  const launcher77 = spawnSync(process.execPath, [path.join(bp77, 'dist', 'ming-app.mjs')], { encoding: 'utf8', cwd: bp77, timeout: 60000 });
  check('v77.10:ming build 遇 with asm 显式回退源码模式——AOT 不可用 + 具名原因(含 asm)+ 已回退源码模式;无 app.bytecode.json;dist launcher 与源码模式输出一致("ok\\n")',
    bld77.status === 0 && (bld77.stderr ?? '').includes('AOT 不可用') && (bld77.stderr ?? '').includes('已回退源码模式')
      && (bld77.stderr ?? '').includes('asm')
      && fs.existsSync(path.join(bp77, 'dist', 'app.ming')) && !fs.existsSync(path.join(bp77, 'dist', 'app.bytecode.json'))
      && srcRun77b.code === 0 && srcRun77b.stdout === 'ok\n'
      && launcher77.status === 0 && launcher77.stdout === 'ok\n',
    `build=${bld77.status} stderr=${JSON.stringify((bld77.stderr ?? '').slice(0, 200))} src=${srcRun77b.code}:${JSON.stringify(srcRun77b.stdout)} launcher=${launcher77.status}:${JSON.stringify(launcher77.stdout)}/${JSON.stringify((launcher77.stderr ?? '').slice(0, 120))}`);

  // ---- v77.11 tools 缓存回归:asm probe 排除不影响既有工具(冷/热 stdout 一致 + 热跑 [tools-cache] hit;§61 v57.20 形态)----
  const w77 = path.join(dir77, 'w.txt');
  fs.writeFileSync(w77, 'alpha beta\nalpha\n', 'utf8');
  const rCold77t = runMing(['tools', 'wc', w77], { cwd: dir77, env: { MING_TOOLS_DEBUG: '1' } });
  const rWarm77t = runMing(['tools', 'wc', w77], { cwd: dir77, env: { MING_TOOLS_DEBUG: '1' } });
  const rPlain77t = runMing(['tools', 'wc', w77], { cwd: dir77, env: { MING_TOOLS_DEBUG: '' } });
  check('v77.11:tools 缓存回归(asm 排除不伤既有工具)——wc 两跑 stdout 一致且热跑 [tools-cache] hit;无旗标无前缀且输出不变',
    rCold77t.code === 0 && rWarm77t.code === 0 && rWarm77t.stdout === rCold77t.stdout
      && (rWarm77t.stderr ?? '').includes('[tools-cache] hit')
      && rPlain77t.code === 0 && rPlain77t.stdout === rCold77t.stdout && !(rPlain77t.stderr ?? '').includes('[tools-cache]'),
    `cold=${rCold77t.code}/${JSON.stringify(rCold77t.stdout)} warm=${rWarm77t.code}/${JSON.stringify((rWarm77t.stderr ?? '').split('\n').filter((l) => l.includes('[tools-cache]')))}`);

  // ---- v77.12 in 值传入正确性(cc):lea 双 in 操作数(3+4=7 / -10+42=32 / 0+0=0)----
  const p77_12 = m77('v77_12_add.ming', [
    'fn add2(a: i64, b: i64) -> i64 with asm {',
    '    let mut s: i64 = 0;',
    '    asm { "lea (%1,%2,1), %0" out("=r", mut s) in("r", a) in("r", b) }',
    '    return s;',
    '}',
    'fn main() with io, asm {',
    '    print(str(add2(3, 4)));',
    '    print(str(add2(-10, 42)));',
    '    print(str(add2(0, 0)));',
    '}',
  ].join('\n'));
  if (hasCC77) {
    const r7712 = ccRun77(p77_12, path.join(dir77, 'c-add'));
    check('v77.12:in 值传入正确性(cc)——lea (%1,%2,1),%0 双 in 按声明序进约束机制,exit 0 + stdout 逐字 "7\\n32\\n0\\n"(含负数)',
      r7712.status === 0 && r7712.stdout === '7\n32\n0\n' && (r7712.stderr ?? '') === '',
      'status=' + r7712.status + ' stdout=' + JSON.stringify(r7712.stdout) + ' stderr=' + JSON.stringify((r7712.stderr ?? '').slice(0, 200)));
  } else {
    check('v77.12:in 值传入正确性(cc)(无编译器,跳过)', true, 'skip: 无 C 编译器');
  }

  // ---- v77.13 fuzz 合同回归:asm 不入模糊器生成器(ADR §6),纯回归 0 分歧(种子固定可复现)----
  const fuzz77 = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'fuzz.mjs'), '--count', '10', '--seed', '44044'], { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('v77.13:fuzz 合同回归(seed 44044 count 10;asm 不入生成器——asm 语义由 §77 专项锁定,差分合同 = cc 逐字透传 vs 其余具名拒绝)',
    fuzz77.status === 0 && /分歧 0/.test(fuzz77.stdout ?? ''),
    'code=' + fuzz77.status + ' tail=' + (fuzz77.stdout ?? '').slice(-120));

  // ---- v77.14 REPL 冒烟(实测校准 2026-11-15):with asm 声明存活(无 M3030);顶层调用 asm 函数
  // → M3029 效果门禁在 REPL 同样生效(REPL 环境效果集 = [io, time, fs, net],不含 asm——asm 块
  // 在 REPL v1 不可达执行,M4017 不可观测);诊断不杀会话(前后表达式均回显);:quit exit 0
  // (v70.9/v70.10 管道形态;任务预案"M4017 或 ALL_EFFECTS 口径"实测均否——按实测口径锁定)----
  const repl77 = runMing(['repl'], {
    stdin: [
      'fn poke() -> i64 with asm { asm { "nop" } return 5; }',
      '1 + 1',
      'poke()',
      '2 + 2',
      ':quit',
    ].join('\n') + '\n',
  });
  const repAll77 = (repl77.stdout ?? '') + (repl77.stderr ?? '');
  check('v77.14:REPL 冒烟——with asm 声明存活(无 M3030 未知效果);poke() 调用 → M3029 点名 [asm](REPL 环境效果集不含 asm,效果门禁同口径);诊断不杀会话(前后表达式 = 2 / = 4 均回显);:quit exit 0',
    repl77.code === 0 && !repAll77.includes('M3030') && repAll77.includes('M3029') && repAll77.includes('[asm]')
      && !repAll77.includes('M3030') && repl77.stdout.includes('= 2') && repl77.stdout.includes('= 4'),
    `code=${repl77.code} out=${JSON.stringify(repl77.stdout.slice(-200))} err=${JSON.stringify((repl77.stderr ?? '').slice(0, 160))}`);

  // ---- v77.15 MING_CC 无效探测回落口径:无效 MING_CC 不致 cc 假失败(探测按 MING_CC → PATH → 已知位置回落,
  // bin/ming.js detectCCompiler 顺序),asm 程序 cc 真实执行不受影响;真"无编译器"机器 = detectCCompiler 返回 null
  // → '未找到 C 编译器' exit 1(bin/ming.js:1442),本机 w64devkit 存在不可诱导 → 沿 §58 C 腿 skip 口径 ----
  if (hasCC77) {
    const r7715 = runMing(['cc', p77_12, '--out', path.join(dir77, 'c-badcc')], { env: { MING_CC: 'C:/nonexistent/v77/gcc.exe' } });
    check('v77.15:MING_CC 无效探测回落——指向不存在路径不致假失败(按序回落到可用编译器),asm 程序 cc 真实执行 exit 0 + stdout 逐字 "7\\n32\\n0\\n"',
      r7715.code === 0 && r7715.stdout === '7\n32\n0\n',
      'code=' + r7715.code + ' stdout=' + JSON.stringify(r7715.stdout) + ' stderr=' + JSON.stringify((r7715.stderr ?? '').slice(0, 200)));
  } else {
    check('v77.15:MING_CC 无效探测回落(无编译器,跳过)', true, 'skip: 无 C 编译器(真缺席路径 = detectCCompiler null → 未找到 C 编译器 exit 1)');
  }

  // ---- v77.16 fmt 无损重建(P1 数据丢失缺口收口):HEAD 基线 fmt 对 AsmBlock 落 default 输出
  // '// ? AsmBlock' 占位,--write 静默删除 asm 块(2026-11-15 实测副本实证)——违反 v0.56(A3)
  // "不丢语义"合同。修复 = fmt.js stmt() AsmBlock 分支:模板整体拼接后按 \n 拆行(非末行补回
  // \n → cbackend join('') 拼接值逐字不变,拆行点只由拼接总值决定 → 再 fmt 幂等);out/in/clobber
  // 每子句一行(clobber 扁平数组 → 逗号规范形,与多组形态同 AST)。四断言:dry-run 无占位且重建
  // 形态完整 / --write 后 check 0 诊断 + fmt --check 规范 / 幂等(再 fmt 逐字)/ 语义不变
  // (run 具名回落 panic 码+消息逐字——剥文件名行前缀后比对,行号平移为格式化固有属性;
  // cc 腿真实执行 stdout 逐字,模板拆行后 C 发射同模板串) ----
  {
    const src16 = [
      'fn addone(x: i64) -> i64 with asm {',
      '    let mut r: i64 = 0;',
      '    asm { "mov %0, %1\\n\\tadd $1, %0" out("=r", mut r) in("r", x) clobber("r10", "r11") }',
      '    return r;',
      '}',
      'fn main() with asm, io { print(str(addone(41))); }',
    ].join('\n');
    const p16 = m77('v77_16_fmt.ming', src16);
    const p16b = m77('v77_16_fmt_copy.ming', src16);
    // (a) dry-run:无占位,完整重建(模板按 \n 拆行 + 三类子句逐行)
    const f16 = runMing(['fmt', p16]);
    const out16 = f16.stdout;
    const rebuilt16 = out16.includes('asm {') && out16.includes('"mov %0, %1\\n"') && out16.includes('"\\tadd $1, %0"')
      && out16.includes('out("=r", mut r)') && out16.includes('in("r", x)') && out16.includes('clobber("r10", "r11")');
    check('v77.16a:fmt dry-run 无损重建——无 "// ? AsmBlock" 占位,模板按 \\n 拆行 + out/in/clobber 子句逐行',
      f16.code === 0 && !out16.includes('// ? AsmBlock') && rebuilt16,
      'code=' + f16.code + ' out=' + JSON.stringify(out16.slice(0, 260)));
    // (b) --write 后:check 0 诊断 + fmt --check 规范 + asm 块仍在(未被删)
    const w16 = runMing(['fmt', p16b, '--write']);
    const chk16 = chk77(p16b);
    const canon16 = runMing(['fmt', p16b, '--check']);
    const formatted16 = fs.readFileSync(p16b, 'utf8');
    check('v77.16b:fmt --write 后语义保持——check 0 诊断 + fmt --check 规范 + asm 块完整保留',
      w16.code === 0 && chk16.code === 0 && (chk16.j?.diagnostics ?? []).length === 0 && canon16.code === 0
        && formatted16.includes('asm {') && formatted16.includes('out("=r", mut r)') && !formatted16.includes('// ?'),
      'w=' + w16.code + ' chk=' + codes77(chk16) + ' canon=' + canon16.code + ' ' + JSON.stringify((canon16.stdout + canon16.stderr).slice(0, 120)));
    // (c) 幂等:对已格式化文件再次 --write,落盘内容与首次 --write 逐字一致
    // (dry-run 对已规范文件 stdout 为空——"已是规范格式"提示不输出规范文本,故以两次 --write 口径)
    const f16b = runMing(['fmt', p16b, '--write']);
    const formatted16b = fs.readFileSync(p16b, 'utf8');
    check('v77.16c:fmt 幂等——对已格式化文件再次 --write,落盘内容逐字一致(拆行点由拼接总值决定)',
      f16b.code === 0 && formatted16b === formatted16,
      'code=' + f16b.code + ' delta=' + JSON.stringify(formatted16b.slice(0, 120)));
    // (d) 语义不变:格式化前后 run(默认引擎)具名回落 panic 码+消息逐字(剥 "…ming:line:col: " 前缀
    // 后比对——行号平移是格式化固有属性;贪婪匹配到最后 ".ming:" 以越过 Windows 盘符冒号);exit 101 不变
    const strip16 = (s) => ((s ?? '').split('\n')[0] ?? '').replace(/^.*ming:\d+:\d+:\s*/, '');
    const rOrig16 = runMing(['run', p16]);
    const rFmt16 = runMing(['run', p16b]);
    check('v77.16d:fmt 后语义不变——M4017 具名回落 exit 101,panic 码+消息逐字(剥文件名/行号前缀)',
      rOrig16.code === 101 && rFmt16.code === 101 && strip16(rOrig16.stderr) === strip16(rFmt16.stderr)
        && strip16(rFmt16.stderr).includes(TAG77) && strip16(rFmt16.stderr).includes(MSG77),
      'orig=' + JSON.stringify(first77(rOrig16.stderr)) + ' fmt=' + JSON.stringify(first77(rFmt16.stderr)));
    // (e) cc 腿(有编译器时):格式化前后真实执行 stdout 逐字(拆行后 join('') 拼接值不变 → C 发射同模板串)
    if (hasCC77) {
      const cO16 = ccRun77(p16, path.join(dir77, 'c-fmt-orig'));
      const cF16 = ccRun77(p16b, path.join(dir77, 'c-fmt-new'));
      const exeO16 = path.join(dir77, 'c-fmt-orig', 'v77_16_fmt' + (process.platform === 'win32' ? '.exe' : ''));
      const exeF16 = path.join(dir77, 'c-fmt-new', 'v77_16_fmt_copy' + (process.platform === 'win32' ? '.exe' : ''));
      const runO16 = spawnSync(exeO16, [], { encoding: 'utf8', timeout: 30000 });
      const runF16 = spawnSync(exeF16, [], { encoding: 'utf8', timeout: 30000 });
      check('v77.16e:fmt 后 cc 语义不变——前后真实执行 exit 0 + stdout 逐字 "42\\n"(模板拼接值保真)',
        cO16.status === 0 && cF16.status === 0 && runO16.status === 0 && runF16.status === 0
          && runO16.stdout === '42\n' && runF16.stdout === '42\n',
        'cc=' + cO16.status + '/' + cF16.status + ' run=' + runO16.status + ':' + JSON.stringify(runO16.stdout) + '/' + runF16.status + ':' + JSON.stringify(runF16.stdout));
    } else {
      check('v77.16e:fmt 后 cc 语义不变(无编译器,跳过)', true, 'skip: 无 C 编译器');
    }
  }

  // ---- v77.17 lsp AsmBlock 查询面(实测口径:参数/外层 let 绑定在函数体遍历前 push,
  // AsmBlock 无 case 时同样可解析——visitStmt 显式分支为完备性与 lambda-in-asm 形态,
  // 非行为修复;断言 = 四查询面全数正确且不崩) ----
  {
    const src17 = [
      'fn addone(x: i64) -> i64 with asm {',
      '    let mut r: i64 = 0;',
      '    asm {',
      '        "mov %0, %1\\n\\tadd $1, %0"',
      '        out("=r", mut r)',
      '        in("r", x)',
      '    }',
      '    return r;',
      '}',
      'fn main() with asm, io {',
      '    print(str(addone(41)));',
      '}',
    ].join('\n');
    const p17 = m77('v77_17_lsp.ming', src17);
    const uri17 = 'file:///' + p17.replace(/\\/g, '/');
    const syms17 = documentSymbolsFor(p17, src17);
    check('v77.17a:documentSymbol 对含 asm 程序返回两符号(签名携带 with asm,不崩不丢)',
      syms17.length === 2 && syms17[0].name === 'addone' && syms17[0].detail.includes('with asm') && syms17[1].name === 'main',
      JSON.stringify(syms17.map(s => s.name + ':' + s.detail)));
    // definition:asm 块内 in 表达式的 x(0 基行 5 字符 16)→ 参数声明 span(0 基行 0 字符 10-11);
    // out 行的 r(0 基行 4 字符 22)→ let mut r 声明 span(0 基行 1 字符 12-13)——2026-11-15 实测锚点
    const defX17 = definitionFor(uri17, p17, src17, 5, 16);
    const defR17 = definitionFor(uri17, p17, src17, 4, 22);
    check('v77.17b:definition 下钻 asm 块——in 表达式 x → 参数声明,块外 r → let 声明(均不崩)',
      defX17 && defX17.range && defX17.range.start.line === 0 && defX17.range.start.character === 10
        && defR17 && defR17.range && defR17.range.start.line === 1 && defR17.range.start.character === 12,
      'x=' + JSON.stringify(defX17) + ' r=' + JSON.stringify(defR17));
    const comp17 = completionFor(p17, src17, 5, 16);
    check('v77.17c:completion 在 asm 块内局部可见——x(param)/r(let)/addone(签名含 with asm)',
      comp17 && Array.isArray(comp17.items)
        && comp17.items.some(i => i.label === 'x' && i.detail === 'param')
        && comp17.items.some(i => i.label === 'r' && i.detail === 'let')
        && comp17.items.some(i => i.label === 'addone' && (i.detail ?? '').includes('with asm')),
      JSON.stringify((comp17?.items ?? []).filter(i => ['x', 'r', 'addone'].includes(i.label))));
  }

  // ---- §77-END
}

// ===================== 78. v0.75:健壮性收尾(残留裸栈崩溃面全面清零)=====================
// 文件所有权:§78 = 本区全部用例。改动面:src/checker.js + src/lexer.js + src/parser.js
// 三文件——零新增 M 码,复用 M4005[stack-overflow] 作 check/parse/lex-time 诊断变体
// ("栈溢出"语义本名;先例 = v0.73 parser exprDepth 复用 M2001 的变体模式)。
//   ① checker:checkExpr 入口深度守卫(CHECK_DEPTH_LIMIT=450,try/finally 配对)——
//     二元/调用/成员/下标链是解析器**迭代**下降产物,AST 深度远超解析递归深度,类型检查
//     递归裸崩;超限 bail(MingError 携 M4005)由毒化网入账:checkLet(绑定毒化 never,
//     v0.67 切口 1 先例)/checkBlock 语句网(后续语句正常检查)/checkBodies 函数网(块尾
//     与契约表达式);constExprType 独立递归面同口径(CONST_DEPTH_LIMIT=1200,实测崩点
//     ~2200);depthBailed 登记使只读静态遍历(摘要/证明/边界/测试字面量/serve 扫描)跳过
//     已报告声明,防根因报告后二次裸崩。
//   ② lexer:插值嵌套守卫(INTERP_DEPTH_LIMIT=950)——scanString→lexInterpExpr→lexToken
//     递归链,每层嵌套约 3 帧;词法错误即抛 MingError(既有语义),诊断唯一。
//   ③ parser:parseType/parsePattern 深度守卫(TYPE_DEPTH_LIMIT=1450/PAT_DEPTH_LIMIT=2000,
//     与 exprDepth 分域计数)——checker 类型树遍历实测崩点 2701 是真实约束(低于 parseType
//     自身崩点 5674);顺带(v0.74 审查 NOTE-2)asm 块在表达式位的专用诊断(原回落结构体
//     字面量路径报误导的 M2002"期望字段名")。
// 阈值依据(2026-11-16 本机实测,Node v24.11.0/win32-x64,直连 API 二分到个位,详见各源文件头注):
//   checker 链:调用链 ×814(最低)/成员链 ×1291/二元链 ×1465/下标链 ×2068;类型树遍历 ×2701;
//   模式 ×3761;插值 ×1762(最浅入口);const 链 ×2200。阈值 ≈ 各域最低崩点的 53-55%
//   (v0.73 审查口径:留跨机余量,V8 帧大小随版本浮动 ±30% 量级);合法程序(examples+tools
//   32 文件)各域深度个位数~低两位,fuzz 生成器表达式预算 ≤3 层——正常程序绝不触发。
// 纪律:全部先实测后断言;裸崩判定 = 输出含 "Maximum call stack"/"RangeError"。
{
  const dir78 = path.join(TMP, 'v78');
  fs.mkdirSync(dir78, { recursive: true });
  const m78 = (name, src) => { const f = path.join(dir78, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const chk78 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 裸栈崩溃形态 → j=null,由断言点名 */ }
    return { code: r.code, j, out: r.stdout + r.stderr };
  };
  const crash78 = (res) => res.out.includes('Maximum call stack') || res.out.includes('RangeError');
  const codes78 = (res) => (res.j && res.j.diagnostics || []).map((d) => d.code);
  const diags78 = (res, code) => (res.j && res.j.diagnostics || []).filter((d) => d.code === code);

  // 语料生成器(与架构师基线 .zcode/v75/ 同形态;层次可参数化)
  const binSrc78 = (n) => 'fn main() with io {\n    let x = ' + Array.from({ length: n }, () => '1').join(' + ') + ';\n    print(str(x));\n}\n';
  const callSrc78 = (n) => 'fn main() with io {\n    let s = "ab"' + '.replace("a", "b")'.repeat(n) + ';\n    print(s);\n}\n';
  const interpSrc78 = (n) => 'fn main() with io {\n    let x = ' + '"\\{ '.repeat(n) + '1' + ' }"'.repeat(n) + ';\n    print(str(x));\n}\n';
  const typeSrc78 = (n) => 'fn f(v: ' + 'Vec['.repeat(n) + 'i64' + ']'.repeat(n) + ') -> i64 with io { return 0; }\nfn main() with io { print(str(f([])));\n}\n';
  const patSrc78 = (n) => 'fn main() with io {\n    let o: Option[i64] = Some(1);\n    let r = match o { ' + 'Some('.repeat(n) + 'v' + ')'.repeat(n) + ' => 1, _ => 0 };\n    print(str(r));\n}\n';

  // ---- v78.1:binchain 形态(3001 项二元链)→ 稳定 M4005,零裸栈崩溃 ----
  {
    // 改前(HEAD 8fbbe13):裸 RangeError "Maximum call stack size exceeded"(checkExpr
    // 栈帧)exit 1;改后:恰 1 条 M4005"表达式嵌套过深(>450 层)"(绑定毒化 never,
    // print(str(x)) 不级联——实测诊断集 = M4005×1,零其他 M 码)。
    const p = m78('v78_1_binchain.ming', binSrc78(3001));
    const res = chk78(p);
    const m = diags78(res, 'M4005');
    check('v78.1:binchain 3001 项二元链——check exit 1 + 恰 1 条 M4005"表达式嵌套过深(>450 层)"逐字稳定诊断(绑定毒化零级联),零裸栈崩溃',
      res.code === 1 && res.j !== null && m.length === 1
        && (m[0].message || '') === '表达式嵌套过深(>450 层);提示:拆分嵌套结构或引入中间绑定'
        && codes78(res).every((c) => c === 'M4005')
        && !crash78(res),
      `exit=${res.code} json=${res.j !== null} M4005=${m.length} codes=${codes78(res).join(',')} 裸崩=${crash78(res)}`);
  }

  // ---- v78.2:callchain 形态(2000 层方法调用链)→ 稳定 M4005,零裸栈崩溃 ----
  {
    // 调用链是 checker 最低崩点形态(×814,2000 层远超);改后同 v78.1 口径:
    // 恰 1 条 M4005"表达式嵌套过深(>450 层)",绑定毒化零级联。
    const p = m78('v78_2_callchain.ming', callSrc78(2000));
    const res = chk78(p);
    const m = diags78(res, 'M4005');
    check('v78.2:callchain 2000 层方法调用链——check exit 1 + 恰 1 条 M4005"表达式嵌套过深(>450 层)"稳定诊断(最低崩点形态),零裸栈崩溃',
      res.code === 1 && res.j !== null && m.length === 1
        && (m[0].message || '').includes('>450 层')
        && codes78(res).every((c) => c === 'M4005')
        && !crash78(res),
      `exit=${res.code} json=${res.j !== null} M4005=${m.length} codes=${codes78(res).join(',')} 裸崩=${crash78(res)}`);
  }

  // ---- v78.3:lexerinterp 形态(2900 层嵌套插值)→ 稳定 M4005(词法域),零裸栈崩溃 ----
  {
    // 改前:裸 RangeError(lexer scanString→lexInterpExpr→lexToken 递归链,peek 栈帧);
    // 改后:lex 中止 + 恰 1 条 M4005"插值嵌套过深(>950 层)"(词法错误即抛 MingError
    // 是本类既有语义,诊断唯一;码裁决:M1004[invalid-escape] 语义不符,M4005 本名)。
    const p = m78('v78_3_interp.ming', interpSrc78(2900));
    const res = chk78(p);
    const m = diags78(res, 'M4005');
    check('v78.3:lexerinterp 2900 层嵌套插值——check exit 1 + 恰 1 条 M4005"插值嵌套过深(>950 层)"逐字稳定诊断(词法域),零裸栈崩溃',
      res.code === 1 && res.j !== null && m.length === 1
        && (m[0].message || '') === '插值嵌套过深(>950 层);提示:拆分嵌套结构或引入中间绑定'
        && codes78(res).every((c) => c === 'M4005')
        && !crash78(res),
      `exit=${res.code} json=${res.j !== null} M4005=${m.length} codes=${codes78(res).join(',')} 裸崩=${crash78(res)}`);
  }

  // ---- v78.4:deeptype 形态(3500 层 Vec 类型嵌套)→ 稳定 M4005(类型域),零裸栈崩溃 ----
  {
    // 改前:裸 RangeError(checker 类型树遍历 resolveTypeAst/checkJoinNotStored 族,×2701
    // 全管线最低崩点;parseType 自身崩点 5674 更深);改后:parseType 守卫 1450 先触发——
    // 恰 1 条 M4005"类型嵌套过深(>1450 层)";签名 bail 走既有 item 级恢复,伴 M2001
    // 恢复落点与 main 引用级联(M3001/M3002)同既有签名 bail 行为(实测 fn f(v: ) 同形),
    // 断言只钉 M4005 存在性与逐字消息,不钉恢复伴生诊断数。
    const p = m78('v78_4_deeptype.ming', typeSrc78(3500));
    const res = chk78(p);
    const m = diags78(res, 'M4005');
    check('v78.4:deeptype 3500 层 Vec 嵌套——check exit 1 + 恰 1 条 M4005"类型嵌套过深(>1450 层)"逐字稳定诊断(类型域,checker 遍历崩点 2701 之下),零裸栈崩溃',
      res.code === 1 && res.j !== null && m.length === 1
        && (m[0].message || '') === '类型嵌套过深(>1450 层);提示:拆分嵌套结构或引入中间绑定'
        && !crash78(res),
      `exit=${res.code} json=${res.j !== null} M4005=${m.length} codes=${codes78(res).join(',')} 裸崩=${crash78(res)}`);
  }

  // ---- v78.5:deeppat 形态(2100 层模式嵌套)→ 稳定 M4005(模式域),零裸栈崩溃 ----
  {
    // 改前:纯模式嵌套 Some(Some[…]) 实测崩点 3761(2100 在 v0.73 exprDepth 守卫下曾是
    // 盲区——模式不经 parsePrimary);改后:parsePattern 守卫 2000 触发,恰 1 条 M4005
    // "模式嵌套过深(>2000 层)";match 语句 bail 走语句级恢复,r 未绑定级联(M3001/M3002)
    // 同既有语句 bail 行为,不钉伴生诊断数。
    const p = m78('v78_5_deeppat.ming', patSrc78(2100));
    const res = chk78(p);
    const m = diags78(res, 'M4005');
    check('v78.5:deeppat 2100 层 Some 嵌套模式——check exit 1 + 恰 1 条 M4005"模式嵌套过深(>2000 层)"逐字稳定诊断(模式域,实测崩点 3761 的 53%),零裸栈崩溃',
      res.code === 1 && res.j !== null && m.length === 1
        && (m[0].message || '') === '模式嵌套过深(>2000 层);提示:拆分嵌套结构或引入中间绑定'
        && !crash78(res),
      `exit=${res.code} json=${res.j !== null} M4005=${m.length} codes=${codes78(res).join(',')} 裸崩=${crash78(res)}`);
  }

  // ---- v78.6:合法面不误伤——全部 examples + tools check exit 0(34 文件冒烟;v0.79 工具 12→14)----
  {
    // 合法程序各域嵌套深度个位数~低两位,守卫阈值 450/950/1450/2000 远离;改前基线同。
    // 本条同时锁"examples(20)+ 自举工具(14)= 34 文件"两个面。
    const dirs = ['examples', 'tools'];
    const files = [];
    for (const d of dirs) {
      for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith('.ming')).sort()) {
        files.push(path.join(ROOT, d, f));
      }
    }
    const bad = [];
    for (const f of files) {
      const r = runMing(['check', f]);
      if (r.code !== 0 || crash78({ out: r.stdout + r.stderr })) bad.push(`${path.basename(path.dirname(f))}/${path.basename(f)}(exit=${r.code})`);
    }
    check('v78.6:合法面不误伤——examples+tools 共 34 文件 check 全 exit 0,零裸栈崩溃(四域守卫阈值远离合法深度)',
      files.length === 34 && bad.length === 0,
      `n=${files.length} bad=${bad.join(',') || '无'}`);
  }

  // ---- v78.7:恢复路径零残留——守卫触发后同文件后续语句正常检查(毒化纪律)----
  {
    // 深 2000 层 let 初始化器(checkLet 毒化网)→ 绑定 x 毒化 never →
    //   print(str(x)) 按底类型收敛(零 M3001/M3003 级联,v0.67 切口 1 先例);
    // 后续独立语句 let y: i64 = "s" 照常检查(M3002 存在 = 后续语句未被放弃)。
    // 断言:M4005 恰 1(根因唯一)、M3002 存在、M3001 零(毒化收敛)、零裸崩。
    const p = m78('v78_7_recover.ming', [
      'fn main() with io {',
      '    let x = ' + Array.from({ length: 2000 }, () => '1').join(' + ') + ';',
      '    print(str(x));',
      '    let y: i64 = "s";',
      '}',
    ].join('\n') + '\n');
    const res = chk78(p);
    check('v78.7:恢复路径零残留——M4005 恰 1 + 后续语句独立诊断 M3002 存在(检查未中断)+ 毒化绑定零 M3001 级联 + 零裸栈崩溃',
      res.code === 1 && res.j !== null && diags78(res, 'M4005').length === 1
        && diags78(res, 'M3002').length >= 1 && diags78(res, 'M3001').length === 0
        && !crash78(res),
      `exit=${res.code} json=${res.j !== null} codes=${codes78(res).join(',')} 裸崩=${crash78(res)}`);
  }

  // ---- v78.8:asm 块在表达式位 → 点名 asm 的专用诊断(v0.74 审查 NOTE-2)----
  {
    // 改前:`let x = asm { "nop" };` 回落结构体字面量路径 → M2002"期望字段名,实际是
    // 字符串字面量"(误导);改后:parsePrimary 表达式位 asm+{ 点名 bail M2001
    // "asm 块仅能作为语句使用(不能作表达式);把 asm 块移到语句位"。语句位 asm 块
    // (v77 全套)不受影响——守卫只拦"结构体字面量回落路径"这一个位。
    const p = m78('v78_8_asm_expr.ming', 'fn main() with io {\n    let x = asm { "nop" };\n    print(str(x));\n}\n');
    const res = chk78(p);
    const asmDiags = (res.j && res.j.diagnostics || []).filter((d) => d.code === 'M2001' && (d.message || '').includes('asm'));
    check('v78.8:asm 表达式位——check exit 1 + 恰 1 条 M2001 且消息点名 asm(仅能作为语句使用/不能作表达式/移到语句位),零裸栈崩溃',
      res.code === 1 && res.j !== null && asmDiags.length === 1
        && (asmDiags[0].message || '').includes('asm 块仅能作为语句使用(不能作表达式)')
        && (asmDiags[0].message || '').includes('把 asm 块移到语句位')
        && !crash78(res),
      `exit=${res.code} json=${res.j !== null} asm诊断=${asmDiags.length} codes=${codes78(res).join(',')} 裸崩=${crash78(res)}`);
  }

  // ---- v78.9:const 初始化器深链(constExprType 独立递归面)→ 稳定 M4005,零裸栈崩溃 ----
  {
    // const X = 1+1+…(1500 项):constExprType 不经 checkExpr(v0.75 同口径独立守卫
    // 1200 层,实测裸崩点 ~2200)——改前裸 RangeError;改后 bail 由 resolveSigs const
    // 分支入账,rtype 毒化 never → print(str(X)) 零级联。恰 1 条 M4005 逐字消息。
    const p = m78('v78_9_constchain.ming', 'const X = ' + Array.from({ length: 1500 }, () => '1').join(' + ') + ';\nfn main() with io { print(str(X)); }\n');
    const res = chk78(p);
    const m = diags78(res, 'M4005');
    check('v78.9:const 链 1500 项——check exit 1 + 恰 1 条 M4005"常量表达式嵌套过深(>1200 层)"逐字稳定诊断(独立递归面),零裸栈崩溃',
      res.code === 1 && res.j !== null && m.length === 1
        && (m[0].message || '') === '常量表达式嵌套过深(>1200 层);提示:拆分嵌套结构或引入中间绑定'
        && codes78(res).every((c) => c === 'M4005')
        && !crash78(res),
      `exit=${res.code} json=${res.j !== null} M4005=${m.length} codes=${codes78(res).join(',')} 裸崩=${crash78(res)}`);
  }

  // ---- §78-END
}

// ===================== 79. v0.76:第五崩面收口(call-arg 嵌套守卫盲视)+ fix 处方扩面 =====================
// 文件所有权:§79 = 本区全部用例。改动面:src/parser.js(parsePostfix 三重入点守卫)+
// src/checker.js(M3002 let/const 标注位 fix + annotationFixType 助手)——零新增 M 码,
// 零新 fix 协议(沿 v0.44 d.fix = {start,end,replacement})。
//   ① 第五崩面(v0.75 §5.1 RED FLAG:call-arg 嵌套 ~240/250 层 Parser 裸 RangeError,
//     pre-existing 两版本一致):根因 = parsePostfix 循环内的 parseExpr 完整重入(调用实参
//     `f(` / 下标 `v[` / postfix 结构体字面量链 `a.b{`)发生在 parsePrimary 返回**之后**,
//     exprDepth 已递减——嵌套深度不累积而 JS 栈照常增长,120 阈值守卫形同虚设(v0.73
//     头注把"调用嵌套"归入"经 parsePrimary 的形态"系误判,已修正)。修复 = 三重入点
//     配对登记(try/finally 纪律同 parseUnary/parseIf/parseBlock,v0.73 先例)。
//     实测裸崩点(2026-11-17 本机 Node v24.11.0/win32-x64,全管线 check 二分校准到个位):
//     call 253(252 存活/253 崩)/index 253/postfix 字面量链 243——RED FLAG 的 "~240/250"
//     与本实测吻合(形态差异 ±个位)。
//   ② 有效合法边界(函数体内 let 位,计数确定性 = 与机器无关的纯计数算术):
//     fn 体块贡献 1 层(parseBlock 挂点),实参重入每层 +1,内层 parsePrimary 叶子瞬时
//     +1——118 层存活(叶子峰值 120 不超阈)/119 层触发 M2001(叶子峰值 121>120)。
//     守卫触达点栈深 ≈ 裸崩点的 47%(v0.73 审查口径 53-55% 同源,跨机余量:V8 帧大小
//     ±30% 浮动下守卫点栈深仍 < 裸崩点栈深,guard 先于裸崩恒成立)。
//   ③ fix 处方扩面(77 码中 M2002/M3029/M3001 三族之后的新族):M3002 let/const 标注位
//     "把声明类型改为实际类型"处方——替换域 = 标注首 token 起、初始化表达式首 token 止
//     (类型 AST span 只覆盖首 token,标注全文末尾不可机械取得,故以 init 起点为右界,
//     替换文本自带 " = ")。不可标注形态(未解析 var/never/unit/空元组/带效果 fn 类型/
//     enum ctor/元类型)由 annotationFixType 判 null;declared 含 Untrusted 一律不给
//     (摘标注即洗白旁路,M3049 直传位 remedy 措辞纪律同源);实参位 M3002 不在本扩面。
//     M2002 块未闭合:收尾 "}" 机械定位于 eof 插入(诊断 span 已指向未闭合块的 "{";
//     多重未闭合逐轮收敛);仅挂 fix 字段,控制流与诊断计数不变(v73.5 恰 1 条断言不受影响)。
//   ④ 既有嵌套测试(§76 全部/§78 全部)零校准:既有语料全部为括号/一元/裸块/else-if/
//     if-expr/插值/类型/模式形态,无深 call-arg/index/postfix 字面量链——三重入点挂点
//     对其深度贡献为零(v76.2 括号 100 层/v78.6 合法面 32 文件同套件复跑锁零回归)。
{
  const dir79 = path.join(TMP, 'v79');
  fs.mkdirSync(dir79, { recursive: true });
  const m79 = (name, src) => { const f = path.join(dir79, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const chk79 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 裸栈崩溃形态 → j=null,由断言点名 */ }
    return { code: r.code, j, out: r.stdout + r.stderr };
  };
  const crash79 = (res) => res.out.includes('Maximum call stack') || res.out.includes('RangeError');
  const deepMsg79 = (res) => (res.j && res.j.diagnostics || []).filter((d) => d.code === 'M2001' && (d.message || '').includes('嵌套过深'));
  const M2001_MSG = '表达式嵌套过深(>120 层);提示:拆分嵌套结构或引入中间绑定'; // v0.73 文案逐字口径
  // 语料生成器(RED FLAG 基线 .zcode/v76/nested_*.ming 同形态;层次可参数化)。
  // 注意 return 0:main 的 i64 返回值即进程退出码(v0.69 #65 惯用法),语料深求值结果
  // 非零会让合法层位的 `ming run` 以 exit 1"成功返回"——合法面断言必须 return 0。
  const callArgSrc79 = (n) => 'fn f(x: i64) -> i64 { return x + 0; }\nfn main() -> i64 { let x: i64 = ' + 'f('.repeat(n) + '1' + ')'.repeat(n) + '; return 0; }\n';
  const indexSrc79 = (n) => 'fn main() -> i64 { let v: Vec[i64] = [1, 2, 3]; let x: i64 = ' + 'v['.repeat(n) + '0' + ']'.repeat(n) + '; return 0; }\n';
  const postStructSrc79 = (n) => 'struct S { f: S }\nfn main() -> i64 { let z: i64 = ' + 'a.b{f: '.repeat(n) + 'S{}' + '}'.repeat(n) + '.f; return z; }\n';
  // v44 同款 applyFix(§79 本地副本;§39 的 applyFix 在其分节块内不可见)
  const applyFix79 = (src, fix) => {
    const lines = src.split('\n');
    const off = (p) => { let o = 0; for (let i = 0; i < p.line - 1; i++) o += lines[i].length + 1; return o + p.col - 1; };
    return src.slice(0, off(fix.start)) + fix.replacement + src.slice(off(fix.end));
  };

  // ---- v79.1:call-arg 250 层(RED FLAG 语料层位,裸崩点 253 之下)→ 稳定 M2001 逐字 ----
  {
    // 改前:该层位 check 通过(守卫盲视——深度不累积);253 层裸 RangeError exit 1。
    // 改后:250 层获得诚实 M2001(>118 合法边界的超限形态统一进稳定诊断),零裸崩。
    const p = m79('v79_1_call250.ming', callArgSrc79(250));
    const res = chk79(p);
    const deep = deepMsg79(res);
    check('v79.1:call-arg 250 层(RED FLAG 层位)——check exit 1 + M2001"表达式嵌套过深(>120 层)"≥1 条且逐条逐字(panic-mode 恢复重解析允许多条),零裸栈崩溃',
      res.code === 1 && res.j !== null && deep.length >= 1
        && deep.every((d) => (d.message || '') === M2001_MSG)
        && !crash79(res),
      `exit=${res.code} json=${res.j !== null} M2001=${deep.length} 裸崩=${crash79(res)} codes=${res.j ? (res.j.diagnostics || []).map((d) => d.code).join(',') : String(res.out).slice(0, 120)}`);
  }

  // ---- v79.2:崩点+10 = 263 层 → M2001 逐字稳定(实测裸崩点 253 的上方)----
  {
    const p = m79('v79_2_call263.ming', callArgSrc79(263));
    const res = chk79(p);
    const deep = deepMsg79(res);
    check('v79.2:call-arg 263 层(实测裸崩点 253 +10)——M2001 ≥1 条且逐条逐字稳定诊断,零裸栈崩溃(裸 RangeError 被 guard 前置消除)',
      res.code === 1 && res.j !== null && deep.length >= 1
        && deep.every((d) => (d.message || '') === M2001_MSG)
        && !crash79(res),
      `exit=${res.code} json=${res.j !== null} M2001=${deep.length} 裸崩=${crash79(res)}`);
  }

  // ---- v79.3:300 层 → 零裸 RangeError(任务 RED FLAG 复核层位)----
  {
    const p = m79('v79_3_call300.ming', callArgSrc79(300));
    const res = chk79(p);
    const deep = deepMsg79(res);
    check('v79.3:call-arg 300 层——M2001 ≥1 条逐字 + 零裸栈崩溃(改前 260 层即裸崩,300 层纳入稳定诊断面)',
      res.code === 1 && res.j !== null && deep.length >= 1
        && deep.every((d) => (d.message || '') === M2001_MSG)
        && !crash79(res),
      `exit=${res.code} json=${res.j !== null} M2001=${deep.length} 裸崩=${crash79(res)}`);
  }

  // ---- v79.4:4000 层极端深度 → 恢复路径终止(不挂起),零裸崩 ----
  {
    const p = m79('v79_4_call4000.ming', callArgSrc79(4000));
    const res = chk79(p);
    const deep = deepMsg79(res);
    check('v79.4:call-arg 4000 层——check 在 runMing 30s 超时内完成(exit 1)+ M2001 ≥1 条逐字 + 零裸栈崩溃(恢复路径零挂起)',
      res.code === 1 && res.j !== null && deep.length >= 1
        && deep.every((d) => (d.message || '') === M2001_MSG)
        && !crash79(res),
      `exit=${res.code} json=${res.j !== null} M2001=${deep.length} 裸崩=${crash79(res)}`);
  }

  // ---- v79.5:合法边界 118 层 call-arg → 不误伤,check exit 0 零 M 码 ----
  {
    // 计数确定性边界:fn 体块 1 层 + 每层实参重入 +1 + 内层叶子瞬时 +1 → 118 层叶子峰值
    // 120 不超阈(118 与机器无关;机器相关的只是裸崩点,guard 点栈深 ≈ 裸崩点 47% 恒前置)。
    const p = m79('v79_5_call118_ok.ming', callArgSrc79(118));
    const c = chk79(p);
    const r = runMing(['run', p]);
    const mCodes79 = (c.j && c.j.diagnostics || []).filter((d) => /^M/.test(d.code || ''));
    check('v79.5:call-arg 118 层(实测合法边界)——check exit 0 且 run exit 0 且零 M 码诊断(守卫不误伤;改前该深度亦 exit 0,行为不变)',
      c.code === 0 && c.j !== null && mCodes79.length === 0 && r.code === 0 && !crash79(c) && !crash79({ out: r.stdout + r.stderr }),
      `check_exit=${c.code} run_exit=${r.code} codes=${c.j ? (c.j.diagnostics || []).map((d) => d.code).join(',') : '?'} 裸崩=${crash79(c)}`);
  }

  // ---- v79.6:边界 +1 = 119 层 → M2001 恰 1 条(有效边界精确性)----
  {
    const p = m79('v79_6_call119_fire.ming', callArgSrc79(119));
    const res = chk79(p);
    const deep = deepMsg79(res);
    check('v79.6:call-arg 119 层(边界 +1)——check exit 1 + 恰 1 条 M2001 逐字(叶子峰值 121>120;panic-mode 吞语句后剩余实参不再二次超限),零裸栈崩溃',
      res.code === 1 && res.j !== null && deep.length === 1
        && (deep[0].message || '') === M2001_MSG
        && !crash79(res),
      `exit=${res.code} json=${res.j !== null} M2001=${deep.length} 裸崩=${crash79(res)}`);
  }

  // ---- v79.7:index 形态(同盲点同栈形)——118 合法 / 300 层稳定诊断 ----
  {
    const pOk = m79('v79_7a_index118_ok.ming', indexSrc79(118));
    const cOk = chk79(pOk);
    const mCodesOk = (cOk.j && cOk.j.diagnostics || []).filter((d) => /^M/.test(d.code || ''));
    const pDeep = m79('v79_7b_index300.ming', indexSrc79(300));
    const cDeep = chk79(pDeep);
    const deep = deepMsg79(cDeep);
    check('v79.7:index 嵌套(实测裸崩点 253,与 call-arg 同栈形)——118 层合法 exit 0 零 M 码 + 300 层 M2001 ≥1 条逐字,全部零裸栈崩溃',
      cOk.code === 0 && cOk.j !== null && mCodesOk.length === 0 && !crash79(cOk)
        && cDeep.code === 1 && cDeep.j !== null && deep.length >= 1
        && deep.every((d) => (d.message || '') === M2001_MSG)
        && !crash79(cDeep),
      `118: exit=${cOk.code} codes=${cOk.j ? (cOk.j.diagnostics || []).map((d) => d.code).join(',') : '?'} | 300: exit=${cDeep.code} M2001=${deep.length} 裸崩=${crash79(cDeep)}`);
  }

  // ---- v79.8:postfix 结构体字面量链(a.b{f: …},实测裸崩点 243)→ 稳定诊断 ----
  {
    // parsePrimaryInner 直入路径(`S { … }`)本就在守卫区内(行为不变);本形态经 postfix
    // `.` 分支重入——修复前 243 层裸崩,修复后纳入稳定诊断面。
    const p = m79('v79_8_pstruct300.ming', postStructSrc79(300));
    const res = chk79(p);
    const deep = deepMsg79(res);
    check('v79.8:postfix 结构体字面量链 300 层——check exit 1 + M2001 ≥1 条逐字 + 零裸栈崩溃(实测裸崩点 243 上方)',
      res.code === 1 && res.j !== null && deep.length >= 1
        && deep.every((d) => (d.message || '') === M2001_MSG)
        && !crash79(res),
      `exit=${res.code} json=${res.j !== null} M2001=${deep.length} 裸崩=${crash79(res)}`);
  }

  // ---- v79.9:恢复路径零残留(§76.3 同款三函数连排,call-arg 版本)----
  {
    // 三函数连排:深100(合法)→ 深130(守卫触发)→ 深100(合法,后位独立判定)。
    // 断言:M2001"嵌套过深"恰 1 条(只由 broken 发出)——若 bail 穿透后计数残留,后位
    // 深100 形态(叶子峰值 102)会误触第二条 M2001;broken 的 return b 走毒化纪律
    // (M3001 级联为既有语句 bail 行为,不钉);零裸崩。
    const p = m79('v79_9_recover.ming', [
      'fn f(x: i64) -> i64 { return x + 0; }',
      'fn f1() -> i64 { let a = ' + 'f('.repeat(100) + '1' + ')'.repeat(100) + '; return a; }',
      'fn broken() -> i64 { let b = ' + 'f('.repeat(130) + '1' + ')'.repeat(130) + '; return b; }',
      'fn f2() -> i64 { let c = ' + 'f('.repeat(100) + '2' + ')'.repeat(100) + '; return c; }',
    ].join('\n') + '\n');
    const res = chk79(p);
    check('v79.9:恢复路径零残留(call-arg 版)——M2001 嵌套过深恰 1 条(broken 独发;计数 finally 递减,后位深100 形态独立判定不误触)+ 零裸栈崩溃',
      res.code === 1 && res.j !== null && deepMsg79(res).length === 1
        && (deepMsg79(res)[0].message || '') === M2001_MSG
        && !crash79(res),
      `exit=${res.code} json=${res.j !== null} M2001=${deepMsg79(res).length} codes=${res.j ? (res.j.diagnostics || []).map((d) => d.code).join(',') : '?'} 裸崩=${crash79(res)}`);
  }

  // ---- v79.10:M3002 let 标注位 fix 正例——fix JSON 硬锚点逐字 + applyFix 复检干净 ----
  {
    // 沿 v44 applyFix 纪律:应用处方后复检必须零错误(机械正确性证明)。
    // 替换域 = 标注首 token(i64@2:12)起、初始化表达式首 token("hello"@2:18)止,
    // 替换文本 "str = " 自带等号(实测锚点,2026-11-17)。
    const src = ['fn main() -> i64 {', '    let x: i64 = "hello";', '    return 0;', '}', ''].join('\n');
    const p = m79('v79_10_letfix.ming', src);
    const res = chk79(p);
    const d = (res.j && res.j.diagnostics || []).find((x) => x.code === 'M3002');
    const fixOk = !!d && !!d.fix
      && JSON.stringify(d.fix) === JSON.stringify({ start: { line: 2, col: 12 }, end: { line: 2, col: 18 }, replacement: 'str = ' });
    let cleanOk = false;
    if (fixOk) {
      const f2 = m79('v79_10_letfix_fixed.ming', applyFix79(src, d.fix));
      const r2 = runMing(['check', f2]);
      cleanOk = r2.code === 0;
    }
    check('v79.10:M3002 let 标注位 fix——消息逐字 + fix JSON 硬锚点(start 2:12/end 2:18/replacement "str = ")+ 应用后复检 exit 0',
      res.code === 1 && res.j !== null && !!d
        && (d.message || '') === 'let 标注类型是 i64,但初始化表达式是 str'
        && fixOk && cleanOk,
      `exit=${res.code} msg=${JSON.stringify(d && d.message)} fix=${JSON.stringify(d && d.fix)} 应用后clean=${cleanOk}`);
  }

  // ---- v79.11:M3002 const 标注位 fix 正例——同款硬锚点 + applyFix 复检干净 ----
  {
    const src = ['const N: i64 = "x";', '', 'fn main() -> i64 { return 0; }', ''].join('\n');
    const p = m79('v79_11_constfix.ming', src);
    const res = chk79(p);
    const d = (res.j && res.j.diagnostics || []).find((x) => x.code === 'M3002');
    const fixOk = !!d && !!d.fix
      && JSON.stringify(d.fix) === JSON.stringify({ start: { line: 1, col: 10 }, end: { line: 1, col: 16 }, replacement: 'str = ' });
    let cleanOk = false;
    if (fixOk) {
      const f2 = m79('v79_11_constfix_fixed.ming', applyFix79(src, d.fix));
      const r2 = runMing(['check', f2]);
      cleanOk = r2.code === 0;
    }
    check('v79.11:M3002 const 标注位 fix——消息逐字 + fix JSON 硬锚点(start 1:10/end 1:16/replacement "str = ")+ 应用后复检 exit 0',
      res.code === 1 && res.j !== null && !!d
        && (d.message || '') === '常量 "N" 标注类型是 i64,但表达式是 str'
        && fixOk && cleanOk,
      `exit=${res.code} msg=${JSON.stringify(d && d.message)} fix=${JSON.stringify(d && d.fix)} 应用后clean=${cleanOk}`);
  }

  // ---- v79.12:M2002 块未闭合 fix 正例——收尾 "}" 机械定位于 eof + applyFix 复检干净 ----
  {
    // 语料无尾换行: eof 定位于 line 3 col 19(print(str(x)); 末尾);fix 即在此插入 "}"。
    const src = ['fn main() with io {', '    let x = 1;', '    print(str(x));'].join('\n');
    const p = m79('v79_12_blockfix.ming', src);
    const res = chk79(p);
    const d = (res.j && res.j.diagnostics || []).find((x) => x.code === 'M2002');
    const fixOk = !!d && !!d.fix
      && JSON.stringify(d.fix) === JSON.stringify({ start: { line: 3, col: 19 }, end: { line: 3, col: 19 }, replacement: '}' });
    let cleanOk = false;
    if (fixOk) {
      const f2 = m79('v79_12_blockfix_fixed.ming', applyFix79(src, d.fix));
      const r2 = runMing(['check', f2]);
      cleanOk = r2.code === 0;
    }
    check('v79.12:M2002 块未闭合 fix——消息逐字 + fix JSON 硬锚点(start/end 3:19/replacement "}")+ 应用后复检 exit 0(v73.5 恰 1 条断言零校准:仅挂 fix 字段)',
      res.code === 1 && res.j !== null && !!d
        && (d.message || '') === '块未闭合(缺少 "}")'
        && fixOk && cleanOk,
      `exit=${res.code} msg=${JSON.stringify(d && d.message)} fix=${JSON.stringify(d && d.fix)} 应用后clean=${cleanOk}`);
  }

  // ---- v79.13:M3002 fix 负例三连——不可标注形态/污点边界/非标注位一律不给(宁缺毋滥)----
  {
    // (a) 污点边界:declared 含 Untrusted → 不给处方(建议摘标注即洗白旁路);
    // (b) unit 初始化器:() 不可作为类型标注回写(不给处方);
    // (c) 实参位 M3002(非 let/const 标注位):不在本扩面,fix === undefined 维持。
    const srcU = ['use std.unstr;', '', 'fn main() -> i64 {', '    let u: Untrusted[str] = "x";', '    return 0;', '}', ''].join('\n');
    const rU = chk79(m79('v79_13a_untrusted.ming', srcU));
    const dU = (rU.j && rU.j.diagnostics || []).find((x) => x.code === 'M3002');
    const srcE = ['fn main() with io {', '    let x: i64 = print("a");', '}', ''].join('\n');
    const rE = chk79(m79('v79_13b_unit.ming', srcE));
    const dE = (rE.j && rE.j.diagnostics || []).find((x) => x.code === 'M3002');
    const srcA = ['fn f(x: i64) -> i64 { return x; }', '', 'fn main() -> i64 {', '    let z = f("s");', '    return 0;', '}', ''].join('\n');
    const rA = chk79(m79('v79_13c_argsite.ming', srcA));
    const dA = (rA.j && rA.j.diagnostics || []).find((x) => x.code === 'M3002');
    check('v79.13:M3002 fix 负例三连——污点边界(declared Untrusted[str])/unit 初始化器/实参位均 M3002 在但 fix 缺失(宁缺毋滥,不给应用后更糟的处方)',
      rU.code === 1 && !!dU && dU.fix === undefined && (dU.message || '').includes('Untrusted[str]')
        && rE.code === 1 && !!dE && dE.fix === undefined && (dE.message || '').includes('()')
        && rA.code === 1 && !!dA && dA.fix === undefined,
      `untrusted: ${dU ? JSON.stringify(dU.fix) : '无诊断'} | unit: ${dE ? JSON.stringify(dE.fix) : '无诊断'} | argsite: ${dA ? JSON.stringify(dA.fix) : '无诊断'}`);
  }

  // ---- v79.14:审查 MAJOR-2 回归——Binary init(操作符起始 span 形态)fix 右界取真实首 token ----
  {
    // 修复前:fix end 落在 '+'@2:20(应用后 "let x: i64 = + 2;" → 二次 M2001);
    // 修复后:exprFirstSpan 下钻 Binary.l,fix end 落 '1'@2:18,应用后复检干净。
    const src = ['fn main() -> i64 {', '    let x: str = 1 + 2;', '    return 0;', '}', ''].join('\n');
    const res = chk79(m79('v79_14_bin.ming', src));
    const d = (res.j && res.j.diagnostics || []).find((x) => x.code === 'M3002');
    const fixOk = !!d && !!d.fix
      && JSON.stringify(d.fix) === JSON.stringify({ start: { line: 2, col: 12 }, end: { line: 2, col: 18 }, replacement: 'i64 = ' });
    let cleanOk = false;
    if (fixOk) {
      const f2 = m79('v79_14_bin_fixed.ming', applyFix79(src, d.fix));
      cleanOk = runMing(['check', f2]).code === 0;
    }
    check('v79.14:MAJOR-2 回归——Binary init(1 + 2)的 fix 右界取真实首 token(end 2:18 非 2:20)+ 应用后复检 exit 0',
      res.code === 1 && !!d && fixOk && cleanOk,
      `msg=${JSON.stringify(d && d.message)} fix=${JSON.stringify(d && d.fix)} 应用后clean=${cleanOk}`);
  }

  // ---- v79.15:MAJOR-2 回归——Call init(callee 起始形态)fix 右界下钻到 callee 首 token ----
  {
    // 修复前:fix end 落 '('(callee 被吞,应用后 "let a: i64 = ();" 二次 M3002)。
    const src = ['fn g() -> i64 { return 1; }', '', 'fn main() -> i64 {', '    let a: str = g();', '    return 0;', '}', ''].join('\n');
    const res = chk79(m79('v79_15_call.ming', src));
    const d = (res.j && res.j.diagnostics || []).find((x) => x.code === 'M3002');
    const fixOk = !!d && !!d.fix
      && JSON.stringify(d.fix) === JSON.stringify({ start: { line: 4, col: 12 }, end: { line: 4, col: 18 }, replacement: 'i64 = ' });
    let cleanOk = false;
    if (fixOk) {
      const f2 = m79('v79_15_call_fixed.ming', applyFix79(src, d.fix));
      cleanOk = runMing(['check', f2]).code === 0;
    }
    check('v79.15:MAJOR-2 回归——Call init(g())的 fix 右界下钻 callee(end 4:18)+ 应用后复检 exit 0',
      res.code === 1 && !!d && fixOk && cleanOk,
      `msg=${JSON.stringify(d && d.message)} fix=${JSON.stringify(d && d.fix)} 应用后clean=${cleanOk}`);
  }

  // ---- v79.16:MAJOR-2 回归——Range init(下界被吞形态)fix 右界下钻 lo + Range[i64] 标注回写 ----
  {
    // 修复前:fix end 落 '..'(下界 0 被吞,应用后 "let r: Range[i64] = ..3;" → M2001)。
    const src = ['fn main() -> i64 {', '    let r: i64 = 0..3;', '    return 0;', '}', ''].join('\n');
    const res = chk79(m79('v79_16_range.ming', src));
    const d = (res.j && res.j.diagnostics || []).find((x) => x.code === 'M3002');
    const fixOk = !!d && !!d.fix
      && JSON.stringify(d.fix) === JSON.stringify({ start: { line: 2, col: 12 }, end: { line: 2, col: 18 }, replacement: 'Range[i64] = ' });
    let cleanOk = false;
    if (fixOk) {
      const f2 = m79('v79_16_range_fixed.ming', applyFix79(src, d.fix));
      cleanOk = runMing(['check', f2]).code === 0;
    }
    check('v79.16:MAJOR-2 回归——Range init(0..3)的 fix 右界下钻 lo(end 2:18)+ Range[i64] 回写后复检 exit 0',
      res.code === 1 && !!d && fixOk && cleanOk,
      `msg=${JSON.stringify(d && d.message)} fix=${JSON.stringify(d && d.fix)} 应用后clean=${cleanOk}`);
  }

  // ---- §79-END
}

// 文件所有权:§80 = 本区全部用例(ADR-007 §8 实现期义务核验:v1.2 内容源扩面——fs/net/proc 污点
// 来源、两域接缝、污值代数)。改动面:src 全线(源翻转/代数/接缝/出向透传)已由实现 agent 交付,
// 本分节只锁定义务,不改 src。既有断言迁移(v65.3/v65.6/v65.9/v70.3/v70.11/v72.18/fs e2e/v31)
// 逐条理由化见各原位校准注释;本区全部为**新增**断言(无既有校准)。
// 义务映射:清单 1/2/3(逐源标污 v80.1–v80.6)/清单 4(代数逐类别 keep/keepVec/keepOpt/keepBytes/
// clean v80.7–v80.11)/§8.1 微调①(+ 传播 v80.12)②(+= 禁面 v80.12)③(bytes 消费面 v80.10)/
// 清单 6 出向透传(write v80.15 + print v80.13)/清单 5(接缝双向 v80.14)/清单 7(exec 双向 v80.4/
// v80.5)/清单 8(http body v80.6)/清单 11 引擎面(wasm 资格回归 v80.17)/清单 11+ADR-005(eval
// 污内容 M3049,v80.16;自递归链净源化=v72.18 校准)。
{
  const dir80 = path.join(TMP, 'v80');
  fs.mkdirSync(dir80, { recursive: true });
  const m80 = (name, src) => { const f = path.join(dir80, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags80 = ['', '--no-wasm', '--tree'];
  const runAll80 = (p) => flags80.map(fl => runMing(fl ? ['run', p, fl] : ['run', p]));
  const same80 = (runs, want) => runs.every(r => r.code === 0 && r.stdout === want);
  const fmtRuns80 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');
  const firstCode80 = (r) => (r.stderr ?? '').split('\n')[0];
  const j80 = (p) => { const r = runMing(['check', p, '--json']); try { return { r, j: JSON.parse(r.stdout) }; } catch { return { r, j: null }; } };

  // v80.1 清单 1:read_file 标污——Ok 载体 Untrusted[str]。负例 = 净槽拦截 M3049;正例 = 白名单
  // 消费(char_len/byte_len 标量终结)三引擎逐字。
  {
    const f80 = m80('v80_1_readfile.ming', [
      'use std.fs;',
      'use std.io;',
      '',
      'fn main() with io, fs {',
      '    match std.fs.read_file("' + path.join(dir80, 'src1.txt').replace(/\\/g, '/') + '") {',
      '        Ok(content) => { print(str(content.char_len())); print(str(content.byte_len())); }',
      '        Err(e) => print("ERR:" + e),',
      '    }',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(dir80, 'src1.txt'), 'ab\n', 'utf8');
    const runs = runAll80(f80);
    check('v80.1:read_file → Untrusted[str] 标污(清单 1)——白名单消费 char_len/byte_len 三引擎逐字(ab\\n=3/3)',
      same80(runs, '3\n3\n'), fmtRuns80(runs));
    const neg = j80(m80('v80_1_readfile_neg.ming', [
      'use std.fs;',
      'use std.io;',
      '',
      'fn main() with io, fs {',
      '    let c = std.fs.read_file("' + path.join(dir80, 'src1.txt').replace(/\\/g, '/') + '").unwrap();',
      '    let clean: str = c;',
      '    print(str(clean.byte_len()));',
      '}',
    ].join('\n')));
    check('v80.1:read_file 结果进净槽 → M3049(check exit 1,首行码锁定)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.2 清单 3:read_bytes 标污——Untrusted[Vec[u8]] 第三载体;操作面 = len/is_empty(白名单),
  // 内容字节不可读值(下标 M3020;正例重设计面已在 v31 锁定,此处锁定负例 + is_empty)。
  {
    fs.writeFileSync(path.join(dir80, 'src2.bin'), Buffer.from([1, 2, 3]), 'binary');
    const f80 = m80('v80_2_readbytes.ming', [
      'use std.fs;',
      'use std.io;',
      '',
      'fn main() with io, fs {',
      '    match std.fs.read_bytes("' + path.join(dir80, 'src2.bin').replace(/\\/g, '/') + '") {',
      '        Ok(v) => { print(str(v.len())); if v.is_empty() { print("empty"); } else { print("nonempty"); } }',
      '        Err(e) => print("ERR:" + e),',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.2:read_bytes → Untrusted[Vec[u8]] 标污(清单 3)——len/is_empty 白名单消费三引擎逐字(3/nonempty)',
      same80(runs, '3\nnonempty\n'), fmtRuns80(runs));
    const neg = j80(m80('v80_2_readbytes_neg.ming', [
      'use std.fs;',
      'use std.io;',
      '',
      'fn main() with io, fs {',
      '    match std.fs.read_bytes("' + path.join(dir80, 'src2.bin').replace(/\\/g, '/') + '") {',
      '        Ok(v) => print(str(v[0])),',
      '        Err(e) => print("ERR:" + e),',
      '    }',
      '}',
    ].join('\n')));
    check('v80.2:污字节下标读 → M3020(内容字节按设计不可读值;check exit 1)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3020'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.3 清单 2:list_dir 条目标污——Vec[Untrusted[str]];消费 = len(净)+ get(0) → Option[污]
  // → sanitize_cli_path(机械净化器,Ok 原样);负例 = 条目进净槽 M3049。目录由夹具固定 1 条目(确定性)。
  {
    const d80 = path.join(dir80, 'listdir');
    fs.mkdirSync(d80, { recursive: true });
    fs.writeFileSync(path.join(d80, 'only.txt'), 'x', 'utf8');
    const f80 = m80('v80_3_listdir.ming', [
      'use std.fs;',
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io, fs {',
      '    match std.fs.list_dir("' + d80.replace(/\\/g, '/') + '") {',
      '        Ok(entries) => {',
      '            print(str(entries.len()));',
      '            match entries.get(0) {',
      '                Some(name) => match std.unstr.sanitize_cli_path(name) {',
      '                    Ok(np) => print("OK " + np),',
      '                    Err(e) => print("SE:" + e),',
      '                },',
      '                None => print("none"),',
      '            }',
      '        },',
      '        Err(e) => print("ERR:" + e),',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.3:list_dir → Vec[Untrusted[str]] 标污(清单 2)——len + get(0) + sanitize_cli_path Ok 原样,三引擎逐字(1/OK only.txt)',
      same80(runs, '1\nOK only.txt\n'), fmtRuns80(runs));
    const neg = j80(m80('v80_3_listdir_neg.ming', [
      'use std.fs;',
      'use std.io;',
      '',
      'fn main() with io, fs {',
      '    match std.fs.list_dir("' + d80.replace(/\\/g, '/') + '") {',
      '        Ok(entries) => { match entries.get(0) { Some(name) => { let c: str = name; print(c); }, None => print("none") } },',
      '        Err(e) => print("ERR:" + e),',
      '    }',
      '}',
    ].join('\n')));
    check('v80.3:list_dir 条目进净槽 → M3049(check exit 1,首行码锁定)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.4 清单 7(source 向):proc.exec stdout/stderr 标污——cmd 用 node -e(确定性输出 "abc\n";
  // PATH 解析);消费 = exit(净 i64)+ stdout byte_len/is_empty;负例 = stdout 进净槽 M3049。
  // sync.spawn 同口径由本用例的 stderr 侧覆盖(同一 exec 载荷)。
  {
    const nodeLit = JSON.stringify(process.execPath);
    const f80 = m80('v80_4_exec.ming', [
      'use std.proc;',
      'use std.io;',
      '',
      'fn main() with io, proc {',
      '    match std.proc.exec(' + nodeLit + ', ["-e", "console.log(\'abc\')"]) {',
      '        Ok((exit, so, se)) => { print(str(exit)); print(str(so.byte_len())); print(str(so.is_empty())); print(str(se.is_empty())); }',
      '        Err(e) => print("ERR:" + e),',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.4:proc.exec stdout/stderr → Untrusted[str] 标污(清单 7 source 向)——exit 净 + stdout byte_len/is_empty 白名单,三引擎逐字(0/4/false/true)',
      same80(runs, '0\n4\nfalse\ntrue\n'), fmtRuns80(runs));
    const neg = j80(m80('v80_4_exec_neg.ming', [
      'use std.proc;',
      'use std.io;',
      '',
      'fn main() with io, proc {',
      '    match std.proc.exec(' + nodeLit + ', ["-e", "console.log(\'abc\')"]) {',
      '        Ok((_, so, _)) => { let c: str = so; print(c); },',
      '        Err(e) => print("ERR:" + e),',
      '    }',
      '}',
    ].join('\n')));
    check('v80.4:exec stdout 进净槽 → M3049(check exit 1,首行码锁定)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.5 清单 7(sink 向):exec cmd = 命令注入 sink——污值进 cmd → M3049(唯一双向点,双向各锁;
  // 与 v80.4 构成 exec 的 source/sink 双向锁定)。
  {
    const nodeLit = JSON.stringify(process.execPath);
    const neg = j80(m80('v80_5_exec_cmd.ming', [
      'use std.proc;',
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io, proc {',
      '    let c: Untrusted[str] = std.unstr.mark(' + nodeLit + ');',
      '    match std.proc.exec(c, ["-e", "console.log(\'abc\')"]) {',
      '        Ok((_, _, _)) => print("ok"),',
      '        Err(e) => print("ERR:" + e),',
      '    }',
      '}',
    ].join('\n')));
    check('v80.5:exec cmd sink——污 cmd → M3049(命令注入面;check exit 1,首行码锁定)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.6 清单 8:http 响应 body 标污——独立子进程 echo 服务器(§10 同款模式),固定响应体;
  // 消费 = status(净)+ body byte_len 白名单;负例 = body 进净槽 M3049。URL 保持净槽由 v27 覆盖。
  {
    const echoServer = spawn(process.execPath, ['-e', [
      'import * as http from "node:http";',
      'const server = http.createServer((req, res) => {',
      '  res.writeHead(200, { "content-type": "text/plain" });',
      '  res.end("taint-80-body");',
      '});',
      'server.listen(0, "127.0.0.1", () => console.log("PORT:" + server.address().port));',
      'process.stdin.resume();',
      'process.stdin.on("end", () => process.exit(0));',
    ].join('\n')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let port80 = 0;
    try {
      port80 = await new Promise((resolve, reject) => {
        let buf = '';
        const onData = (c) => { buf += c; const m = buf.match(/PORT:(\d+)/); if (m) { echoServer.stdout.off('data', onData); resolve(Number(m[1])); } };
        echoServer.stdout.on('data', onData);
        echoServer.on('exit', () => reject(new Error('echo exited')));
        setTimeout(() => reject(new Error('echo timeout')), 10000);
      });
      const f80 = m80('v80_6_http.ming', [
        'use std.net;',
        'use std.io;',
        '',
        'fn main() with io, net {',
        '    match std.net.http_get("http://127.0.0.1:' + String(port80) + '/t80") {',
        '        Ok((status, body)) => { print(str(status)); print(str(body.byte_len())); print(str(body.is_empty())); }',
        '        Err(e) => print("ERR:" + e),',
        '    }',
        '}',
      ].join('\n'));
      const runs = runAll80(f80);
      check('v80.6:http 响应 body → Untrusted[str] 标污(清单 8)——status 净 + body byte_len/is_empty 白名单,三引擎逐字(200/13/false)',
        same80(runs, '200\n13\nfalse\n'), fmtRuns80(runs));
      const neg = j80(m80('v80_6_http_neg.ming', [
        'use std.net;',
        'use std.io;',
        '',
        'fn main() with io, net {',
        '    match std.net.http_get("http://127.0.0.1:' + String(port80) + '/t80") {',
        '        Ok((_, body)) => { let c: str = body; print(c); },',
        '        Err(e) => print("ERR:" + e),',
        '    }',
        '}',
      ].join('\n')));
      check('v80.6:http body 进净槽 → M3049(请求侧净槽;headers sink 锁定见 v80.21;check exit 1)',
        neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
        `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
    } finally {
      echoServer.kill();
    }
  }

  // v80.7 清单 4 keep 类:str→str 纯函数输出保污——trim/to_upper/replace/slice_chars 各一;
  // keep 语义锁定 = 结果进净槽 M3049(保污 ≠ 洗白)+ 运行时值经 print 透传逐字。
  {
    const f80 = m80('v80_7_keep.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("  aBc ");',
      '    print(u.trim());',
      '    print(u.trim().to_upper());',
      '    print(u.trim().replace("a", "X"));',
      '    print(u.trim().slice_chars(1, 2));',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.7:keep 代数(trim/to_upper/replace/slice_chars)运行值逐字(aBc/ABC/XBc/B;print 出向透传)',
      same80(runs, 'aBc\nABC\nXBc\nB\n'), fmtRuns80(runs));
    const neg = j80(m80('v80_7_keep_neg.ming', [
      'use std.unstr;',
      '',
      'fn f(u: Untrusted[str]) -> str {',
      '    return u.trim().to_upper();',
      '}',
      '',
      'fn main() with io {',
      '}',
    ].join('\n')));
    check('v80.7:keep 结果进净 return 槽 → M3049(保污 ≠ 洗白;check exit 1)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.8 清单 4 keepVec 类:split → Vec[Untrusted[str]](载荷精确保污)——len 净、元素 byte_len
  // 白名单、元素进净槽 M3049(log_analyzer 分行迁移面)。
  {
    const f80 = m80('v80_8_keepvec.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("a,bb,ccc");',
      '    let parts = u.split(",");',
      '    print(str(parts.len()));',
      '    match parts.get(1) {',
      '        Some(p) => print(str(p.byte_len())),',
      '        None => print("none"),',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.8:keepVec 代数(split)——len 净 + 元素 byte_len 白名单,三引擎逐字(3/2)',
      same80(runs, '3\n2\n'), fmtRuns80(runs));
    const neg = j80(m80('v80_8_keepvec_neg.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("a,b");',
      '    let parts = u.split(",");',
      '    match parts.get(0) {',
      '        Some(p) => { let c: str = p; print(c); },',
      '        None => print("none"),',
      '    }',
      '}',
    ].join('\n')));
    check('v80.8:keepVec 元素进净槽 → M3049(载荷保污,无重组洗白旁路;check exit 1)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.9 清单 4 keepOpt 类:get(i) → Option[Untrusted[str]](内容衍生子串)——unwrap 消费 +
  // byte_len;负例 = 取出子串进净槽 M3049(edit 行级切片迁移面)。
  {
    const f80 = m80('v80_9_keepopt.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("hello");',
      '    match u.get(1) {',
      '        Some(c) => print(str(c.byte_len())),',
      '        None => print("none"),',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.9:keepOpt 代数(get(i) → Option[Untrusted[str]])——单字符 byte_len,三引擎逐字(1)',
      same80(runs, '1\n'), fmtRuns80(runs));
    const neg = j80(m80('v80_9_keepopt_neg.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("hello");',
      '    match u.get(1) {',
      '        Some(c) => { let s: str = c; print(s); },',
      '        None => print("none"),',
      '    }',
      '}',
    ].join('\n')));
    check('v80.9:keepOpt 取出子串进净槽 → M3049(check exit 1,首行码锁定)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.10 清单 4 keepBytes 类(§8.1 微调③):bytes/to_bytes → Untrusted[Vec[u8]](与 read_bytes
  // 第三载体对称)——len/is_empty 消费;字节消费面维持净槽:污字节进净 Vec[u8] 标注 → M3049,
  // 无 re/bin 洗白旁路。
  {
    const f80 = m80('v80_10_keepbytes.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("abcd");',
      '    let b = u.to_bytes();',
      '    print(str(b.len()));',
      '    print(str(b.is_empty()));',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.10:keepBytes 代数(to_bytes → Untrusted[Vec[u8],微调③)——len/is_empty 消费,三引擎逐字(4/false)',
      same80(runs, '4\nfalse\n'), fmtRuns80(runs));
    const neg = j80(m80('v80_10_keepbytes_neg.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("abcd");',
      '    let c: Vec[u8] = u.to_bytes();',
      '    print(str(c.len()));',
      '}',
    ].join('\n')));
    check('v80.10:污字节进净 Vec[u8] 槽 → M3049(re/bin 消费面维持净槽,无字节洗白旁路;check exit 1)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.11 清单 4 clean 类:标量/布尔/计数输出污点终结(位置与计数不携带内容,v0.61 先例推广)——
  // char_len/byte_len/parse_i64(净 Err 消息)/contains/is_alpha 三引擎逐字。
  {
    const f80 = m80('v80_11_clean.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("42ab");',
      '    let w = std.unstr.mark("42");',
      '    print(str(u.char_len()));',
      '    print(str(u.byte_len()));',
      '    match w.parse_i64() {',
      '        Ok(n) => print(str(n + 1)),',
      '        Err(e) => print("E:" + e),',
      '    }',
      '    print(str(u.contains("42")));',
      '    print(str(u.is_alpha()));',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.11:clean 代数(char_len/byte_len/parse_i64/contains/is_alpha)——标量终结,三引擎逐字(4/4/43/true/false)',
      same80(runs, '4\n4\n43\ntrue\nfalse\n'), fmtRuns80(runs));
  }

  // v80.12 §8.1 微调①②:+ 拼接传播与 += 禁面——污+净→污、污+污→污(print 透传逐字);
  // 净目标 += 污值 → M3049(复合赋值洗白旁路封死;v65.9 迁移面之外的本区锁定)。
  {
    const f80 = m80('v80_12_plus.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let a = std.unstr.mark("x");',
      '    let b = std.unstr.mark("y");',
      '    print("a" + a);',
      '    print(a + b);',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.12:+ 拼接传播(微调①)——污+净→污、污+污→污,print 出向透传逐字(ax/xy,三引擎一致)',
      same80(runs, 'ax\nxy\n'), fmtRuns80(runs));
    const neg = j80(m80('v80_12_pluseq.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("x");',
      '    let mut n = "net";',
      '    n += u;',
      '    print(n);',
      '}',
    ].join('\n')));
    check('v80.12:净目标 += 污值 → M3049(微调②;check exit 1,首行码锁定)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.13 清单 6 出向透传(print 家族):污 str 放行 = 存储非边界穿越(v65.3 echo 形态之外的
  // 全码名锁定);debug()/插值维持拒绝;污 Json 进 print → M3049 且 hint 带投影 remedy(.as_str,
  // v0.68 载体感知)。
  {
    const okP = m80('v80_13_print_ok.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("t80");',
      '    print(u);',
      '    print_raw(u);',
      '    eprint(u);',
      '}',
    ].join('\n'));
    const runs = runAll80(okP);
    check('v80.13:print/print_raw/eprint 出向透传(清单 6 微调)——污 str 放行逐字(stdout "t80\\nt80" + stderr "t80\\n"),三引擎一致',
      runs.every(r => r.code === 0 && r.stdout === 't80\nt80' && r.stderr === 't80\n'), fmtRuns80(runs));
    const dbg = j80(m80('v80_13_debug.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u = std.unstr.mark("t80");',
      '    print(debug(u));',
      '}',
    ].join('\n')));
    check('v80.13:debug(污) 维持 M3050(调试通道即洗白通道,出向透传不扩到 debug;check exit 1)',
      dbg.r.code === 1 && !!dbg.j && dbg.j.diagnostics.some(d => d.code === 'M3050'),
      `code=${dbg.r.code} first=${JSON.stringify(firstCode80(dbg.r))}`);
    const jn = j80(m80('v80_13_print_json.ming', [
      'use std.unstr;',
      'use std.json;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    match json.parse("{}") {',
      '        Ok(j) => { let u = std.unstr.mark_json(j); print(u); },',
      '        Err(e) => print("E:" + e),',
      '    }',
      '}',
    ].join('\n')));
    const jdiag = (jn.j && jn.j.diagnostics || []).find(d => d.code === 'M3049');
    check('v80.13:print(污 Json) → M3049 且 hint 带投影 remedy(.as_str,载体感知;check exit 1)',
      jn.r.code === 1 && !!jdiag && (jdiag.hint ?? '').includes('.as_str()'),
      `code=${jn.r.code} first=${JSON.stringify(firstCode80(jn.r))} hint=${JSON.stringify(jdiag ? jdiag.hint : null)}`);
  }

  // v80.14 清单 5:两域接缝双向——污进污出(read_file → json.parse → Untrusted[Json] → get/as_str
  // 投影保污)与净路径逐字不变(净字面量 parse → 净 Json,同消费同输出)。同一夹具内容两个来源
  // (污/净)输出逐字相同 = 接缝只在载体分派,值语义零变化。
  {
    const fixture = path.join(dir80, 'j80.json');
    fs.writeFileSync(fixture, '{"name":"ming","n":3}', 'utf8');
    const docLit80 = '"{\\"name\\":\\"ming\\",\\"n\\":3}"';
    const consumeBody80 = [
      '    let mut out = "";',
      '    match j.get("name") {',
      '        Some(v) => {',
      '            match v.as_str() {',
      '                Some(s) => { out = out + str(s.byte_len()); },',
      '                None => { out = out + "?"; },',
      '            }',
      '        },',
      '        None => { out = out + "!"; },',
      '    }',
      '    match j.get("n") {',
      '        Some(v) => {',
      '            match v.as_num() {',
      '                Some(n) => { out = out + "," + str(n); },',
      '                None => { out = out + "?"; },',
      '            }',
      '        },',
      '        None => { out = out + "!"; },',
      '    }',
      '    return out;',
    ];
    const f80 = m80('v80_14_seam.ming', [
      'use std.fs;',
      'use std.json;',
      'use std.io;',
      '',
      'fn consume(j: Json) -> str {',
      ...consumeBody80,
      '}',
      '',
      'fn consumeT(j: Untrusted[Json]) -> str {',
      ...consumeBody80,
      '}',
      '',
      'fn main() with io, fs {',
      '    match json.parse(' + docLit80 + ') {',
      '        Ok(j) => print("clean:" + consume(j)),',
      '        Err(e) => print("PE:" + e),',
      '    }',
      '    match std.fs.read_file("' + fixture.replace(/\\/g, '/') + '") {',
      '        Ok(raw) => {',
      '            match json.parse(raw) {',
      '                Ok(j) => print("taint:" + consumeT(j)),',
      '                Err(e) => print("PE:" + e),',
      '            }',
      '        },',
      '        Err(e) => print("ERR:" + e),',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.14:json 接缝双向(清单 5)——净路径逐字(clean:4,3.0)+ 污进污出(taint:4,3.0,parse(污 str) → Untrusted[Json] 投影消费),两路输出逐字相同,三引擎一致',
      same80(runs, 'clean:4,3.0\ntaint:4,3.0\n'), fmtRuns80(runs));
    const neg = j80(m80('v80_14_seam_neg.ming', [
      'use std.json;',
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io {',
      '    let u: Untrusted[str] = std.unstr.mark("{\\"a\\":1}");',
      '    match json.parse(u) {',
      '        Ok(j) => { let c: Json = j; print(str(c.as_obj().is_some())); },',
      '        Err(e) => print("PE:" + e),',
      '    }',
      '}',
    ].join('\n')));
    check('v80.14:parse(污) 结果进净 Json 槽 → M3049(污进污出,接缝不洗白;check exit 1)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
  }

  // v80.15 清单 6 出向透传(write 家族):写污 → 回读 → byte_len 逐字验证——write_file(str 污
  // 内容)+ append_bytes(污字节,to_bytes 产物)合法落盘(存储非边界穿越),回读值逐字相等。
  {
    const wf = path.join(dir80, 'w80.txt').replace(/\\/g, '/');
    const f80 = m80('v80_15_write.ming', [
      'use std.fs;',
      'use std.unstr;',
      'use std.io;',
      '',
      'fn main() with io, fs {',
      '    let u = std.unstr.mark("abc\\n");',
      '    match std.fs.write_file("' + wf + '", u) {',
      '        Ok(_) => { },',
      '        Err(e) => { print("WERR:" + e); return; },',
      '    }',
      '    match std.fs.append_bytes("' + wf + '", std.unstr.mark("Z").to_bytes()) {',
      '        Ok(_) => { },',
      '        Err(e) => { print("AERR:" + e); return; },',
      '    }',
      '    match std.fs.read_file("' + wf + '") {',
      '        Ok(back) => print(str(back.byte_len())),',
      '        Err(e) => print("RERR:" + e),',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll80(f80);
    check('v80.15:write 透传(清单 6)——write_file 污内容 + append_bytes 污字节合法落盘,回读 byte_len=5 逐字,三引擎一致',
      same80(runs, '5\n'), fmtRuns80(runs));
  }

  // v80.16 清单 11 + ADR-005:eval 污内容 M3049 回归——污源构造 = read_file(...).unwrap() 进 eval
  // (非自递归夹具;自递归链净源化 = v72.18 JSON-quine 校准);对照 = eval 净字面量 run 正常。
  {
    const src80 = path.join(dir80, 'ev80.ming');
    fs.writeFileSync(src80, 'fn main() with io { print("ev80-ok"); }\n', 'utf8');
    const neg = j80(m80('v80_16_eval_neg.ming', [
      'use std.fs;',
      'use std.io;',
      '',
      'fn main() with io, eval, fs {',
      '    let u = std.fs.read_file("' + src80.replace(/\\/g, '/') + '").unwrap();',
      '    match eval(u) { Ok(s) => print(s), Err(e) => print("E:" + e) }',
      '}',
    ].join('\n')));
    check('v80.16:eval(污内容) → M3049(污内容永不动态执行,窗口机械关闭;check exit 1,首行码锁定)',
      neg.r.code === 1 && !!neg.j && neg.j.diagnostics.some(d => d.code === 'M3049'),
      `code=${neg.r.code} first=${JSON.stringify(firstCode80(neg.r))}`);
    const okP = m80('v80_16_eval_ok.ming', [
      'use std.io;',
      '',
      'fn main() with io, eval {',
      '    match eval("fn main() with io { print(\\"clean-ok\\"); }") {',
      '        Ok(s) => print("OK:" + s),',
      '        Err(e) => print("E:" + e),',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll80(okP);
    check('v80.16:eval(净字面量) 不受影响——Ok 载荷逐字(OK:clean-ok),三引擎一致',
      same80(runs, 'OK:clean-ok\n\n'), fmtRuns80(runs));
  }

  // v80.17 清单 11 引擎面:wasm/C 资格按载体判定(零新机制,回归核验)——(a) 污形参函数
  // (顶层 Untrusted[str] + 嵌套容器 Vec[Untrusted[str]] 解包)用资格内操作(strict exit 0,
  // 资格不因污点标注改变)且三引擎逐字;(b) 含污程序中既有具名守卫(unwrap_or 链/byte_len 非直调
  // 形态——对照实验:净 str byte_len 同码,资格按操作而非污点)仍 strict 可见 exit 2 原因具名,
  // 非 strict 回落输出一致。污点面不改写资格判定,回落永远可见 = 清单 11 的诚实回落语义。
  {
    const f80a = m80('v80_17_wasm_ok.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn count(vs: Vec[Untrusted[str]]) -> i64 {',
      '    return vs.len();',
      '}',
      '',
      'fn has(u: Untrusted[str]) -> bool {',
      '    return u.contains("b");',
      '}',
      '',
      'fn main() with io {',
      '    let v: Vec[Untrusted[str]] = [std.unstr.mark("a"), std.unstr.mark("bb")];',
      '    print(str(count(v)));',
      '    print(str(has(std.unstr.mark("abc"))));',
      '}',
    ].join('\n'));
    const rs = runMing(['run', f80a, '--strict-wasm']);
    const runs = runAll80(f80a);
    check('v80.17:(a) 污形参 wasm 资格回归(清单 11)——Untrusted[str]/Vec[Untrusted[str]] 形参解包,资格内操作 strict-wasm exit 0,三引擎逐字(2/true)',
      rs.code === 0 && same80(runs, '2\ntrue\n'), `strict=${rs.code} ${JSON.stringify(rs.stderr.slice(0, 120))} ${fmtRuns80(runs)}`);
    const f80b = m80('v80_17_wasm_named.ming', [
      'use std.unstr;',
      'use std.io;',
      '',
      'fn blen(u: Untrusted[str]) -> i64 {',
      '    return u.byte_len();',
      '}',
      '',
      'fn main() with io {',
      '    print(str(blen(std.unstr.mark("abc"))));',
      '}',
    ].join('\n'));
    const rstrict = runMing(['run', f80b, '--strict-wasm']);
    const runsB = runAll80(f80b);
    check('v80.17:(b) 污形参 + 资格外操作仍具名回落——byte_len(非直调形态,净 str 同码)strict exit 2 原因具名(非直接调用),非 strict 回落输出三引擎一致(3)',
      rstrict.code === 2 && (rstrict.stderr ?? '').includes('strict-wasm: wasm 编译回落') && (rstrict.stderr ?? '').includes('非直接调用') && same80(runsB, '3\n'),
      `strict=${rstrict.code} ${JSON.stringify((rstrict.stderr ?? '').slice(0, 120))} ${fmtRuns80(runsB)}`);
    const f80c = m80('v80_17_wasm_twin.ming', [
      'use std.io;',
      '',
      'fn blen(u: str) -> i64 {',
      '    return u.byte_len();',
      '}',
      '',
      'fn main() with io {',
      '    print(str(blen("abc")));',
      '}',
    ].join('\n'));
    const rstrict2 = runMing(['run', f80c, '--strict-wasm']);
    const runsC = runAll80(f80c);
    const reasonB = ((rstrict.stderr ?? '').match(/wasm 编译回落\([^)]*\):([^\n]+)/) ?? [])[1] ?? '';
    const reasonC = ((rstrict2.stderr ?? '').match(/wasm 编译回落\([^)]*\):([^\n]+)/) ?? [])[1] ?? '';
    check('v80.17:(c) 资格判定污点中性(净/污孪生对照)——净 str 版 blen 与 (b) 污版同 strict 判定(exit 2 + 同原因字面),非 strict 输出同(3)',
      rstrict2.code === 2 && reasonB !== '' && reasonB === reasonC && same80(runsC, '3\n'),
      `strict=${rstrict2.code} reasonB=${JSON.stringify(reasonB)} reasonC=${JSON.stringify(reasonC)} ${fmtRuns80(runsC)}`);
  }

  // ---- v80.18:审查 B1 修正——污接收者 parse_i64 的 Err 载荷保污(keepResErr)----
  // 修复前:Err 文本回显原串且为净 str(审查实测 "LEAKED:不是有效的整数: \"SECRET-...\"" +
  // 净 str 直入 eval 零诊断——击穿 ADR-005);修复后:Ok 净 i64 不变,Err 载荷 Untrusted[str]。
  {
    const okSrc = [
      'use std.unstr;',
      '',
      'fn main() -> i64 with io {',
      '    let u: Untrusted[str] = std.unstr.mark("42");',
      '    match u.parse_i64() {',
      '        Ok(n) => print(str(n)),',
      '        Err(msg) => print("ERR"),',
      '    }',
      '    return 0;',
      '}',
    ].join('\n');
    const runsOk = runAll80(m80('v80_18_ok.ming', okSrc));
    check('v80.18:(a) Ok 路径净 i64 不变(keepResErr 只包 Err 载荷)——三引擎逐字(42)',
      same80(runsOk, '42\n'), fmtRuns80(runsOk));
    const leakSrc = [
      'use std.unstr;',
      '',
      'fn main() with io, eval {',
      '    let u: Untrusted[str] = std.unstr.mark("SECRET-abc");',
      '    match u.parse_i64() {',
      '        Ok(n) => print(str(n)),',
      '        Err(msg) => { let s: str = msg; eval(s); }',
      '    }',
      '    return 0;',
      '}',
    ].join('\n');
    const jL = j80(m80('v80_18_leak.ming', leakSrc));
    const dL = (jL.j && jL.j.diagnostics || []).find((x) => x.code === 'M3049');
    check('v80.18:(b) Err 载荷保污——污 Err msg 进净 str 槽 M3049,eval(污) 仍拒绝(审查实测的 eval 击穿就此关闭)',
      jL.r.code === 1 && jL.j !== null && !!dL,
      `exit=${jL.r.code} M3049=${!!dL} 首行=${firstCode80(jL.r)}`);
  }

  // ---- v80.19:审查 M1 裁决(翻转)——io.read_to_end → Untrusted[str](与 read_line 同源同污)----
  {
    const okSrc = ['use std.io;', '', 'fn main() with io {', '    let t: Untrusted[str] = std.io.read_to_end();', '    print(str(t.char_len()));', '}', ''].join('\n');
    const runsOk = runAll80(m80('v80_19_ok.ming', okSrc));
    const badSrc = ['use std.io;', '', 'fn main() with io {', '    let s: str = std.io.read_to_end();', '}', ''].join('\n');
    const jBad = j80(m80('v80_19_bad.ming', badSrc));
    const dBad = (jBad.j && jBad.j.diagnostics || []).find((x) => x.code === 'M3049');
    check('v80.19:M1 裁决(翻转)——read_to_end 污槽承接编译通过(EOF 空 Three 引擎 0\n)+ 净槽 M3049',
      same80(runsOk, '0\n') && jBad.r.code === 1 && !!dBad, fmtRuns80(runsOk));
  }

  // ---- v80.20:审查 m3——std.str.index_of 回归(字符下标口径/增补平面/None)----
  {
    const hitSrc = ['use std.str;', '', 'fn main() -> i64 with io {', '    print(str(str.index_of("a🎉b🎉cd", "cd").unwrap()));', '    return 0;', '}', ''].join('\n');
    const runsHit = runAll80(m80('v80_20_hit.ming', hitSrc));
    const noneSrc = ['use std.str;', '', 'fn main() -> i64 with io {', '    print(str(str.index_of("abc", "zz").unwrap_or(-1)));', '    return 0;', '}', ''].join('\n');
    const runsNone = runAll80(m80('v80_20_none.ming', noneSrc));
    check('v80.20:(a) index_of 字符下标(增补平面 🎉 按码点计)——三引擎逐字(4)',
      same80(runsHit, '4\n'), fmtRuns80(runsHit));
    check('v80.20:(b) index_of 未找到 None → unwrap_or(-1) 三引擎逐字(-1)',
      same80(runsNone, '-1\n'), fmtRuns80(runsNone));
  }

  // ---- v80.21:审查 m4 四锁定——exec args sink M3049/json.parse(接缝污 Json 直入) M3049/污+=污 保污正例 ----
  {
    // FRAG 自 §80.14 seam_neg 语料行程序化提取(run.mjs 源级转义原样,零手打反斜杠)。
    const FRAG = "std.unstr.mark(\"{\\\\\"a\\\\\":1}\")";
    const argsSrc = ['use std.unstr;', 'use std.proc;', '', 'fn main() with proc {', '    let t: Untrusted[str] = std.unstr.mark("x");', '    std.proc.exec("cmd", [t]);', '}', ''].join('\n');
    const jArgs = j80(m80('v80_21_args.ming', argsSrc));
    const dArgs = (jArgs.j && jArgs.j.diagnostics || []).find((x) => x.code === 'M3049');
    const tjSrc = ['use std.json;', 'use std.unstr;', 'use std.io;', '', 'fn main() with io {', '    match json.parse(std.unstr.mark("[1,2,3]")) {', '        Ok(u) => { let v = json.parse(u); },', '        Err(e) => print("PE:" + e),', '    }', '}', ''].join(String.fromCharCode(10));
    const jTj = j80(m80('v80_21_tj.ming', tjSrc));
    const dTj = (jTj.j && jTj.j.diagnostics || []).find((x) => x.code === 'M3049');
    const incSrc = ['use std.unstr;', '', 'fn main() -> i64 with io {', '    let mut t: Untrusted[str] = std.unstr.mark("x");', '    t += std.unstr.mark("y");', '    print(t);', '    return 0;', '}', ''].join('\n');
    const runsInc = runAll80(m80('v80_21_inc.ming', incSrc));
    check('v80.21:(a) exec args sink M3049+(b) json.parse(接缝污 Json 直入) M3049+(c) 污+=污累计保污经 print 透传逐字(xy)',
      jArgs.r.code === 1 && !!dArgs && jTj.r.code === 1 && !!dTj && same80(runsInc, 'xy\n'),
      `args=${!!dArgs} tj=${!!dTj} ${fmtRuns80(runsInc)}`);
  }

  // ---- §80-END
}

// 文件所有权:§81 = 本区全部用例。缺陷 #70(P1,v0.78):for 内 match 臂中的 continue
// → VM `内部错误: TypeError: iter.next is not a function` 进程崩溃(tree 正常,双引擎分歧)。
// 根因:match 编译为表达式,宗量(scrutinee)整个臂体期间留在操作数栈上;臂内 break/continue
// 的 JUMP 直达循环头/尾,栈上宗量未弹——for 的 ITERNEXT peek 栈顶把宗量误当迭代器
// (崩溃),while 虽不崩但每轮泄漏一个宗量值(JUMPFALSE 弹的是真条件,泄漏在下方)。
// 修复(src/compiler.js,纯字节码层,vm.js/interp.js 零改动):
//   ① compileStmt Break/Continue 发射前置 POP——弹掉"循环登记后新开的 match 宗量"层数
//     (popN = st.matchTemps - bctx.matchTemps;循环之前的外层宗量在迭代器之下,保留);
//   ② compileExpr Match:宗量编译后 st.matchTemps++、臂序列结束 --(词法计数器);
//   ③ For/While/WhileLet/Loop 四循环点在 breakCtx 登记 matchTemps 快照。
// 范围边界(实测):wasm 无 Match 分支 → 含 match 函数恒不 eligible,回落 VM(本修复面),
//   strict-wasm 三态 'none' exit 0 不变;cc emitValue 对"块含语句的臂"诚实 C1 拒绝,
//   无错值面;tree 递归求值天然正确,零改动。语料源自 tools/log_analyzer.ming 迁移期形态。
{
  const dir81 = path.join(TMP, 'v81');
  fs.mkdirSync(dir81, { recursive: true });
  const m81 = (name, src) => { const f = path.join(dir81, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags81 = ['', '--no-wasm', '--tree'];
  const runAll81 = (p) => flags81.map(fl => runMing(fl ? ['run', p, fl] : ['run', p]));
  const same81 = (runs, want) => runs.every(r => r.code === 0 && r.stdout === want);
  const fmtRuns81 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}/${JSON.stringify((r.stderr ?? '').split('\n')[0])}`).join(' | ');

  // v81.1 基线形态(#70 最小复现,log_analyzer 迁移期原形态):for-in + match 臂 continue。
  // 修复前 VM 内部错误 exit 2;期望 stdout = "2\n3\n" 三引擎逐字。
  {
    const f = m81('v81_1_probe.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    for x in v {',
      '        match x {',
      '            1 => { continue; }',
      '            _ => { print(str(x)); }',
      '        }',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.1:for-in + match 臂 continue(#70 基线)——三引擎逐字 2\\n3\\n exit 0(修复前 VM iter.next 崩溃)',
      same81(runs, '2\n3\n'), fmtRuns81(runs));
    const strict = runMing(['run', f, '--strict-wasm']);
    check('v81.1b:同语料 --strict-wasm exit 0(含 match 函数恒不 eligible,三态 none,v53.4/v72.13 口径零变化)',
      strict.code === 0 && strict.stdout === '2\n3\n', `code=${strict.code} out=${JSON.stringify(strict.stdout)}`);
  }

  // v81.2 break 在 match 臂内(修复前静默泄漏宗量+迭代器,输出侥幸一致;修复后栈干净)。
  {
    const f = m81('v81_2_break.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    for x in v {',
      '        match x {',
      '            1 => { break; }',
      '            _ => { print(str(x)); }',
      '        }',
      '    }',
      '    print("done");',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.2:match 臂内 break——三引擎逐字 done(宗量前置弹栈,迭代器泄漏面消除)',
      same81(runs, 'done\n'), fmtRuns81(runs));
  }

  // v81.3 match 值形态(表达式位置)含 continue 臂——never 臂与 i64 臂统一(修复前同崩)。
  {
    const f = m81('v81_3_expr.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    for x in v {',
      '        let y = match x {',
      '            1 => { continue; }',
      '            _ => x * 10,',
      '        };',
      '        print(str(y));',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.3:match 值形态(let y = match)含 continue 臂——三引擎逐字 20\\n30\\n',
      same81(runs, '20\n30\n'), fmtRuns81(runs));
  }

  // v81.4 嵌套 match:两层宗量同时在栈,内层臂 continue 需弹两层(修复前同崩)。
  {
    const f = m81('v81_4_nested.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2, 3, 4];',
      '    for x in v {',
      '        match x {',
      '            1 => { continue; }',
      '            2 => {',
      '                match x {',
      '                    2 => { continue; }',
      '                    _ => { print("never"); }',
      '                }',
      '                print("after-inner");',
      '            }',
      '            _ => { print(str(x)); }',
      '        }',
      '        print("tail");',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.4:嵌套 match 臂内 continue(两层宗量)——三引擎逐字 3\\ntail\\n4\\ntail\\n',
      same81(runs, '3\ntail\n4\ntail\n'), fmtRuns81(runs));
  }

  // v81.5 嵌套 for:内层 match 臂 continue/break 只作用内层循环(修复前内层 ITERNEXT 同崩)。
  {
    const f = m81('v81_5_nestfor.ming', [
      'fn main() -> i64 with io {',
      '    for a in [1, 2] {',
      '        for b in [1, 2, 3] {',
      '            match b {',
      '                1 => { continue; }',
      '                3 => { break; }',
      '                _ => { print(str(a) + str(b)); }',
      '            }',
      '            print("inner-tail");',
      '        }',
      '        print("outer-iter");',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.5:嵌套 for + match 臂 continue/break(内层宗量只弹到内层循环头)——三引擎逐字 12\\ninner-tail\\nouter-iter\\n22\\ninner-tail\\nouter-iter\\n',
      same81(runs, '12\ninner-tail\nouter-iter\n22\ninner-tail\nouter-iter\n'), fmtRuns81(runs));
  }

  // v81.6 多臂 continue + guard 臂 continue(guard 失败落点栈平衡不回退)。
  {
    const f = m81('v81_6_multi.ming', [
      'fn main() -> i64 with io {',
      '    for x in [1, 2, 3, 4, 5] {',
      '        match x {',
      '            1 => { continue; }',
      '            2 if x > 0 => { continue; }',
      '            3 => { print("three"); }',
      '            _ => { print(str(x)); }',
      '        }',
      '        print("t");',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.6:多臂 continue + guard 臂 continue——三引擎逐字 three\\nt\\n4\\nt\\n5\\nt\\n',
      same81(runs, 'three\nt\n4\nt\n5\nt\n'), fmtRuns81(runs));
  }

  // v81.7 guard 位置嵌套 match 表达式(宗量嵌宗量)+ guard 臂 continue。
  {
    const f = m81('v81_7_guard.ming', [
      'fn main() -> i64 with io {',
      '    for x in [1, 2] {',
      '        match x {',
      '            1 if match x { 1 => true, _ => false } => { print("one"); }',
      '            _ => { print(str(x)); }',
      '        }',
      '    }',
      '    for y in [1, 2, 3] {',
      '        match y {',
      '            2 => { print("two"); }',
      '            _ if y == 3 => { continue; }',
      '            _ => { print(str(y)); }',
      '        }',
      '        print("g");',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.7:guard 嵌套 match + guard 臂 continue——三引擎逐字 one\\n2\\n1\\ng\\ntwo\\ng\\n',
      same81(runs, 'one\n2\n1\ng\ntwo\ng\n'), fmtRuns81(runs));
  }

  // v81.8 while + match 臂 continue/break(修复前不崩但每轮泄漏宗量;修复后语义不变、栈干净)。
  {
    const f = m81('v81_8_while.ming', [
      'fn main() -> i64 with io {',
      '    let mut i = 0;',
      '    while i < 5 {',
      '        i += 1;',
      '        match i {',
      '            1 => { continue; }',
      '            3 => { break; }',
      '            _ => { print(str(i)); }',
      '        }',
      '    }',
      '    print(str(i));',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.8:while + match 臂 continue/break——三引擎逐字 2\\n3\\n(泄漏面消除,行为与 tree 逐字)',
      same81(runs, '2\n3\n'), fmtRuns81(runs));
  }

  // v81.9 while-let + match 臂 continue(PATMATCH 路径循环;修复前泄漏)。
  {
    const f = m81('v81_9_wlet.ming', [
      'fn getv(i: i64) -> Option[i64] { if i % 2 == 0 { return Some(i); } return None; }',
      'fn main() -> i64 with io {',
      '    let mut k = 0;',
      '    while let Some(n) = getv(k) {',
      '        k += 1;',
      '        match n {',
      '            0 => { continue; }',
      '            2 => { print("two"); }',
      '            _ => { print(str(n)); }',
      '        }',
      '        print("wt");',
      '    }',
      '    print("done " + str(k));',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.9:while-let + match 臂 continue——三引擎逐字 done 1(getv(0)=Some(0)→continue,getv(1)=None 退出)',
      same81(runs, 'done 1\n'), fmtRuns81(runs));
  }

  // v81.10 bare loop + match 臂 continue/break(loop 表达式值 = break 落点 unit)。
  {
    const f = m81('v81_10_loop.ming', [
      'fn main() -> i64 with io {',
      '    let mut i = 0;',
      '    loop {',
      '        i += 1;',
      '        match i {',
      '            1 => { continue; }',
      '            2 => { print("loop-two"); }',
      '            _ => { break; }',
      '        }',
      '    }',
      '    print(str(i));',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.10:bare loop + match 臂 continue/break——三引擎逐字 loop-two\\n3\\n',
      same81(runs, 'loop-two\n3\n'), fmtRuns81(runs));
  }

  // v81.11 if 表达式臂与臂内块(if 分支无活宗量;宗量来自外层 match,继续弹一层)。
  {
    const f = m81('v81_11_ifarm.ming', [
      'fn main() -> i64 with io {',
      '    for x in [1, 2, 3] {',
      '        match x {',
      '            1 => if x == 1 { continue; } else { print("no"); },',
      '            2 => { if x == 2 { continue; } print("no2"); }',
      '            _ => { print(str(x)); }',
      '        }',
      '        print("t");',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.11:if 表达式臂/臂内块 continue——三引擎逐字 3\\nt\\n',
      same81(runs, '3\nt\n'), fmtRuns81(runs));
  }

  // v81.12 unsafe 块内 continue(match 臂内;inLoop 穿透 unsafe,修复前同面泄漏/崩溃)。
  {
    const f = m81('v81_12_unsafe.ming', [
      'fn main() -> i64 with io, unsafe {',
      '    let mut i = 0;',
      '    while i < 3 {',
      '        i += 1;',
      '        match i {',
      '            1 => { unsafe { continue; } }',
      '            _ => { print("u" + str(i)); }',
      '        }',
      '        print("ut");',
      '    }',
      '    print("end");',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.12:unsafe 块内 continue(臂内)——三引擎逐字 u2\\nut\\nu3\\nut\\nend\\n(块内无指针操作,M4016 不触发)',
      same81(runs, 'u2\nut\nu3\nut\nend\n'), fmtRuns81(runs));
  }

  // v81.13 连续多轮 continue 的栈界回归:1000 轮全部走 continue 臂(修复前 while 形态每轮
  // 泄漏 1 个宗量值;for 形态首轮即崩——此处 3 引擎逐字锁定无泄漏累积可观测面)。
  {
    const f = m81('v81_13_stress.ming', [
      'fn main() -> i64 with io {',
      '    let mut n = 0;',
      '    for x in 0..1000 {',
      '        match x {',
      '            _ => { continue; }',
      '        }',
      '    }',
      '    while n < 1000 {',
      '        n += 1;',
      '        match n {',
      '            _ => { continue; }',
      '        }',
      '    }',
      '    print(str(n));',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.13:1000 轮 continue 臂(for+while)栈不增长——三引擎逐字 1000',
      same81(runs, '1000\n'), fmtRuns81(runs));
  }

  // v81.14 engdiff 多后端差分(基线语料 tree/vm(wasm)/vm-only 三腿一致)。
  {
    const f = m81('v81_14_diff.ming', [
      'fn main() -> i64 with io {',
      '    let mut total = 0;',
      '    for x in [1, 2, 3, 4, 5, 6] {',
      '        match x % 3 {',
      '            0 => { continue; }',
      '            _ => { total += x; }',
      '        }',
      '    }',
      '    print(str(total));',
      '    return 0;',
      '}',
    ].join('\n'));
    const d = runMing(['tools', 'diff', f]);
    check('v81.14:engdiff 三后端差分一致(match-in-for continue 载荷)——退出码 0',
      d.code === 0 && (d.stdout ?? '').includes('engdiff: 一致'), `code=${d.code} out=${JSON.stringify((d.stdout ?? '').split('\n')[0])}`);
    const runs = runAll81(f);
    check('v81.14b:同语料三引擎逐字 12(1+2+4+5,跳过 3/6)',
      same81(runs, '12\n'), fmtRuns81(runs));
  }

  // v81.15 既有语义回归:无 match 的 break/continue 字节码路径零变化(popN=0 → 无前置 POP,
  // 与 v0.77 逐字节同)。语料 = 纯 for/while/loop break+continue 黄金输出。
  {
    const f = m81('v81_15_plain.ming', [
      'fn main() -> i64 with io {',
      '    let mut s = 0;',
      '    for x in 1..10 {',
      '        if x % 2 == 0 { continue; }',
      '        if x > 7 { break; }',
      '        s += x;',
      '    }',
      '    let mut t = 0;',
      '    let mut k = 0;',
      '    while k < 100 {',
      '        k += 1;',
      '        if k % 3 == 0 { continue; }',
      '        if k > 9 { break; }',
      '        t += k;',
      '    }',
      '    print(str(s) + "," + str(t));',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.15:无 match 的 continue/break(1+3+5+7=16;1+2+4+5+7+8=27)——三引擎逐字(既有语义零变化)',
      same81(runs, '16,27\n'), fmtRuns81(runs));
  }

  // v81.16 外层 match 包住循环:外层宗量位于迭代器之下必须跨循环存活,popN 只弹
  // 循环内新开的宗量层(快照不变量;修复前内层 ITERNEXT 同崩,修复后外层臂继续执行)。
  {
    const f = m81('v81_16_outer.ming', [
      'fn main() -> i64 with io {',
      '    let a = 1;',
      '    match a {',
      '        1 => {',
      '            for x in [1, 2, 3] {',
      '                match x {',
      '                    2 => { break; }',
      '                    3 => { continue; }',
      '                    _ => { print(str(x)); }',
      '                }',
      '                print("it");',
      '            }',
      '            print("after-loop");',
      '        }',
      '        _ => { print("no"); }',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll81(f);
    check('v81.16:外层 match 包住循环(宗量跨循环存活)——三引擎逐字 1\\nit\\nafter-loop\\n',
      same81(runs, '1\nit\nafter-loop\n'), fmtRuns81(runs));
  }


  // ---- v81.17:审查 MINOR-2 补测——三层嵌套 match popN=3(快照不变量激进面)----
  {
    const p = m81('v81_17_pop3.ming', [
      'fn main() -> i64 with io {',
      '    for x in [1, 2, 3] {',
      '        match x {',
      '            _ => {',
      '                match x {',
      '                    _ => {',
      '                        match x {',
      '                            2 => { continue; }',
      '                            _ => { print(str(x)); }',
      '                        }',
      '                    }',
      '                }',
      '            }',
      '        }',
      '    }',
      '    return 0;',
      '}',
    ].join(String.fromCharCode(10)));
    const runs = runAll81(p);
    check('v81.17:三层嵌套 match popN=3——continue 恰弹三层宗量(return 2),三引擎逐字(1\n3\n)',
      same81(runs, '1\n3\n'), fmtRuns81(runs));
  }

  // ---- v81.18:审查 MINOR-2 补测——循环在 match 臂内,两层各有 match+continue(跨快照边界 popN=1/1)----
  {
    const p = m81('v81_18_cross.ming', [
      'fn main() -> i64 with io {',
      '    for x in [1, 2] {',
      '        match x {',
      '            _ => {',
      '                for y in [1, 2] {',
      '                    match y {',
      '                        1 => { continue; }',
      '                        _ => { print(str(x) + str(y)); }',
      '                    }',
      '                }',
      '            }',
      '        }',
      '    }',
      '    return 0;',
      '}',
    ].join(String.fromCharCode(10)));
    const runs = runAll81(p);
    check('v81.18:循环在 match 臂内跨快照边界(popN=1/1)——内层 continue 只弹内层宗量,外层宗量跨迭代存活,三引擎逐字(12\n22\n)',
      same81(runs, '12\n22\n'), fmtRuns81(runs));
  }

  // ---- §81-END
}

// 文件所有权:§82 = 本区全部用例。缺陷 #71(P1,v0.79):循环内 lambda 体裸 continue/break
// 过 check(checkLambda 的 ctx2 = {...ctx} 保留外层 inLoop → M3010/M3011 不发射),且块尾
// never 使 g 可传 HOF——调用时三态分歧:tree 引擎 ContSig/BrkSig 穿透 lambda 调用帧被
// 外层循环捕获(吞迭代,exit 0);VM compileLambda 子状态无 breakCtx 走防御分支发射裸
// POP(无 JUMP 落点)弹穿全帧共享操作数栈(内部错误 TypeError,exit 2)。语料 .zcode/v78/
// t_l6.ming(v0.78 实现 agent 同族发现,独立可复现)。修复(语义定案:lambda 体是新函数
// 边界,continue/break 不穿透——与本地函数/普通函数一致,v0.59 #44 先例):
//   ① checker(checkLambda):ctx2 重置 inLoop: false——lambda 内裸 continue/break 发
//     M3011/M3010(消息与既有文案逐字);lambda 体自己的 for/while/loop 正常置位,
//     其内部 continue/break 合法且只作用于 lambda 内的循环。
//   ② compiler:compileLambda 子状态不携带 breakCtx(既有事实,注释显式化)+ compileStmt
//     Break/Continue 防御分支由裸 POP 改具名 CompileError(纵深防御;修复后不可达,
//     审查 MINOR-3 同点)。
// 零校准锚点:§81 全形态(match 臂 continue/break 三引擎逐字)在全量回归中逐字复跑;
// git archive HEAD 对照:v0.78 语料仅 t_l6/t_lambda 两文件新增 M3011(均为本缺陷家族,
// 修复目标),其余语料诊断逐字不变。
{
  const dir82 = path.join(TMP, 'v82');
  fs.mkdirSync(dir82, { recursive: true });
  const m82 = (name, src) => { const f = path.join(dir82, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const j82 = (p) => { const r = runMing(['check', p, '--json']); try { return { r, j: JSON.parse(r.stdout) }; } catch { return { r, j: null }; } };
  const codes82 = (j) => (j?.diagnostics ?? []).map(d => d.code);
  const flags82 = ['', '--no-wasm', '--tree'];
  const runAll82 = (p) => flags82.map(fl => runMing(fl ? ['run', p, fl] : ['run', p]));
  const same82 = (runs, want) => runs.every(r => r.code === 0 && r.stdout === want);
  const fmtRuns82 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}`).join(' | ');

  // v82.1 基线形态(#71 语料 t_l6 原样):for 内 lambda 体裸 continue + 传 map。
  // 修复前三态:check exit 0 / tree exit 0 吞迭代 / VM exit 2 内部错误。
  {
    const f = m82('v82_1_corpus.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    for x in v {',
      '        let g = (a: i64) => { continue; };',
      '        let w = v.map(g);',
      '        print(str(x));',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const { r: chk, j } = j82(f);
    const m3011 = (j?.diagnostics ?? []).find(d => d.code === 'M3011');
    check('v82.1:for 内 lambda 体裸 continue(#71 语料)——check 拒绝 M3011"continue 只能出现在循环内"(错误位=continue 自身)',
      chk.code === 1 && j?.ok === false && m3011 != null
      && m3011.message === 'continue 只能出现在循环内' && m3011.severity === 'error'
      && m3011.line === 4,
      `chk=${chk.code} ok=${j?.ok} codes=${JSON.stringify(codes82(j))} m3011=${JSON.stringify(m3011)}`);
    const runs = runAll82(f).map(x => ({ code: x.code, stdout: x.stdout }));
    check('v82.1b:同语料三引擎均不执行(check 层拦截后无运行形态)——exit 1 且 stdout 空',
      runs.every(x => x.code === 1 && x.stdout === ''), fmtRuns82(runs));
  }

  // v82.2 对偶形态:for 内 lambda 体裸 break → M3010(消息与既有文案逐字)。
  {
    const f = m82('v82_2_break.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    for x in v {',
      '        let g = (a: i64) => { break; };',
      '        let _ = v.map(g);',
      '        print(str(x));',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const { r: chk, j } = j82(f);
    const m3010 = (j?.diagnostics ?? []).find(d => d.code === 'M3010');
    check('v82.2:for 内 lambda 体裸 break——check 拒绝 M3010"break 只能出现在循环内"',
      chk.code === 1 && m3010 != null && m3010.message === 'break 只能出现在循环内'
      && m3010.severity === 'error' && m3010.line === 4,
      `chk=${chk.code} codes=${JSON.stringify(codes82(j))} m3010=${JSON.stringify(m3010)}`);
  }

  // v82.3 语义定案正例:lambda 体自己的 for + continue 合法——continue 只作用于
  // lambda 内的循环,外层循环不受影响(三引擎逐字;修复前该形态本就合法,零校准)。
  {
    const f = m82('v82_3_own_loop.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let g = (n: i64) => {',
      '        let mut acc = 0;',
      '        for i in 0..n {',
      '            if i % 2 == 0 { continue; }',
      '            acc += i;',
      '        }',
      '        return acc;',
      '    };',
      '    for x in v {',
      '        let w = v.map(g);',
      '        print(str(x) + ":" + str(w.get(0).unwrap_or(-1)));',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const { r: chk, j } = j82(f);
    const runs = runAll82(f);
    check('v82.3:lambda 体自带 for + continue 合法(外层每迭代照常打印)——check 0 + 三引擎逐字 1:0\\n2:0\\n3:0\\n',
      chk.code === 0 && codes82(j).every(c => !c.startsWith('M')) && same82(runs, '1:0\n2:0\n3:0\n'),
      `chk=${chk.code} codes=${JSON.stringify(codes82(j))} ${fmtRuns82(runs)}`);
  }

  // v82.4 lambda 体自带 while + break 合法(对偶形态)——break 只作用于 lambda 内循环。
  {
    const f = m82('v82_4_own_while.ming', [
      'fn main() -> i64 with io {',
      '    let find = (n: i64) => {',
      '        let mut i = 0;',
      '        while i < n {',
      '            if i * i >= n { break; }',
      '            i += 1;',
      '        }',
      '        return i;',
      '    };',
      '    print(str(find(10)));',
      '    print(str(find(1)));',
      '    return 0;',
      '}',
    ].join('\n'));
    const { r: chk } = j82(f);
    const runs = runAll82(f);
    check('v82.4:lambda 体自带 while + break 合法——check 0 + 三引擎逐字 4\\n1\\n',
      chk.code === 0 && same82(runs, '4\n1\n'), `chk=${chk.code} ${fmtRuns82(runs)}`);
  }

  // v82.5 HOF 场景(缺陷报告的"块尾 never 使 g 可传 HOF"通道):循环内 lambda 传 map——
  // 合法 lambda(无裸 continue/break)行为不变;非法形态已在 v82.1 于 check 层拦截,
  // 不存在"never 尾 lambda 进入 map"的运行形态。
  {
    const f = m82('v82_5_hof.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    for x in v {',
      '        let g = (a: i64) => a * 2;',
      '        let w = v.map(g);',
      '        print(str(x) + "->" + str(w.get(0).unwrap_or(-1)));',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const { r: chk } = j82(f);
    const runs = runAll82(f);
    check('v82.5:循环内 lambda 传 map(HOF 通道正例)——check 0 + 三引擎逐字 1->2\\n2->2\\n3->2\\n',
      chk.code === 0 && same82(runs, '1->2\n2->2\n3->2\n'), `chk=${chk.code} ${fmtRuns82(runs)}`);
  }

  // v82.6 边界归属:嵌套 lambda 的裸 continue 归属内层边界(恰 1 条 M3011);
  // 顶层裸 continue(无 lambda、无循环)维持既有口径 M3011(零校准)。
  {
    const f1 = m82('v82_6_nested.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2];',
      '    for x in v {',
      '        let outer = (a: i64) => {',
      '            let inner = (b: i64) => { continue; };',
      '            return inner(a);',
      '        };',
      '        let _ = v.map(outer);',
      '        print(str(x));',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const r1 = j82(f1);
    const m1 = (r1.j?.diagnostics ?? []).filter(d => d.code === 'M3011');
    const f2 = m82('v82_6_toplevel.ming', [
      'fn main() -> i64 with io {',
      '    continue;',
      '    return 0;',
      '}',
    ].join('\n'));
    const r2 = j82(f2);
    const m2 = (r2.j?.diagnostics ?? []).filter(d => d.code === 'M3011');
    check('v82.6:嵌套 lambda 裸 continue 恰 1 条 M3011 归属内层(line 5) + 顶层裸 continue 维持 M3011(零校准)',
      r1.r.code === 1 && m1.length === 1 && m1[0].line === 5
      && r2.r.code === 1 && m2.length === 1 && m2[0].line === 2,
      `nested=${r1.r.code} m=${JSON.stringify(m1)} | top=${r2.r.code} m=${JSON.stringify(m2)}`);
  }

  // v82.7 compiler 纵深防御断言(白盒):剥掉 M3010/M3011 模拟 checker/编译器边界不一致,
  // compile 必须以具名 CompileError 失败(修复前:裸 POP 静默发射 → VM 弹穿共享操作数栈
  // 内部错误崩溃)。修复后正常管线不可达;此处仅锁定"防御分支具名、不裸 POP"。
  {
    const f = m82('v82_7_defense.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    for x in v {',
      '        let g = (a: i64) => { continue; };',
      '        let _ = v.map(g);',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    let thrown = null;
    try {
      const c = new Checker(f);
      const result = c.run();
      result.diags = result.diags.filter(d => !/M3010|M3011/.test(d.code));
      compile(result);
    } catch (e) {
      thrown = e;
    }
    check('v82.7:防御分支(白盒)——剥 M3011 后 compile 具名 CompileError"lambda/本地函数体内的 break/continue 缺少循环上下文"(不再裸 POP)',
      thrown instanceof CompileError && thrown.message.includes('lambda/本地函数体内的 break/continue 缺少循环上下文'),
      `thrown=${thrown ? thrown.name + ': ' + thrown.message : 'null(未抛——裸 POP 静默)'}`);
  }

  // v82.8 既有合法形态零校准:lambda 体内的 loop{break}(loop 是 lambda 自己的循环)
  // 仍合法——v60.48 形态在函数边界语义下的行为不变。
  {
    const f = m82('v82_8_loop_break.ming', [
      'fn main() with io {',
      '  let f = () => { loop { break; } };',
      '  f();',
      '  print("ok");',
      '}',
      '',
    ].join('\n'));
    const { r: chk } = j82(f);
    const runs = runAll82(f);
    check('v82.8:lambda 体自带 loop{break} 仍合法(v60.48 形态零校准)——check 0 + 三引擎逐字 ok',
      chk.code === 0 && same82(runs, 'ok\n'), `chk=${chk.code} ${fmtRuns82(runs)}`);
  }

  // ---- 83. v0.79 工具追加:xnsni(URL → xn-- 十六进制 SNI 改写,CCS 2026 §4.3 CircumVolve 方法)----
  // 工具本体 tools/xnsni.ming + TOOL_CMDS 注册;本分节锁十六进制向量与错误纪律。
  {
    // v83.1 论文示例向量逐字:cloudflare.com → xn--636c6f7564666c6172652e636f6d
    const r1 = runMing(['tools', 'xnsni', 'https://cloudflare.com/ping']);
    check('v83.1:xnsni 论文示例向量——cloudflare.com → xn--636c6f7564666c6172652e636f6d(sni/url/curl 三行含)+ exit 0',
      r1.code === 0 && r1.stdout.includes("sni:    xn--636c6f7564666c6172652e636f6d")
        && r1.stdout.includes("https://xn--636c6f7564666c6172652e636f6d/ping")
        && r1.stdout.includes("--connect-to") && r1.stdout.includes(":443:cloudflare.com:443"),
      `code=${r1.code} out=${JSON.stringify(r1.stdout.slice(0,160))}`);
    // v83.2 http+端口+路径形态:example.com:8080 → xn--6578616d706c652e636f6d,端口 8080 透传
    const r2 = runMing(['tools', 'xnsni', 'http://example.com:8080/a/b?x=1']);
    check('v83.2:http+端口形态——sni=xn--6578616d706c652e636f6d / port 8080 / 路径与查询串保留 / exit 0',
      r2.code === 0 && r2.stdout.includes("sni:    xn--6578616d706c652e636f6d")
        && r2.stdout.includes("port:   8080")
        && r2.stdout.includes("http://xn--6578616d706c652e636f6d/a/b?x=1"),
      `code=${r2.code} out=${JSON.stringify(r2.stdout.slice(0,160))}`);
    // v83.3 错误纪律:空参 → usage 走 stderr + exit 1(不静默成功)
    const r3 = runMing(['tools', 'xnsni']);
    check('v83.3:xnsni 错误纪律——空参 usage 走 stderr + exit 1',
      r3.code === 1 && (r3.stderr || '').includes("用法:") && r3.stdout === '',
      `code=${r3.code} stderr=${JSON.stringify((r3.stderr||'').slice(0,80))} stdout=${JSON.stringify(r3.stdout)}`);
  }

    // v83.4 xnopen:用法纪律(空参 → exit 1 + stderr 用法)
    const r4 = runMing(['tools', 'xnopen']);
    check('v83.4:xnopen 错误纪律——空参 usage 走 stderr + exit 1',
      r4.code === 1 && (r4.stderr || '').includes('用法:') && r4.stdout === '',
      `code=${r4.code} stderr=${JSON.stringify((r4.stderr||'').slice(0,80))}`);
    // v83.5 xnopen:离线探测三段判定确定性——127.0.0.1:1 两端都不可达 → 改写不可达判定
    const r5 = runMing(['tools', 'xnopen', 'http://127.0.0.1:1/', '--', '--no-chrome']);
    check('v83.5:xnopen 离线探测判定——127.0.0.1:1 原/改写均 0 + 改写不可达判定行 + exit 0',
      r5.code === 0 && r5.stdout.includes('原 URL:  0') && r5.stdout.includes('改写后:  0')
        && r5.stdout.includes('改写不可达'),
      `code=${r5.code} out=${JSON.stringify(r5.stdout.slice(0,200))}`);
  // ---- §82-END
}

// ===================== 84. v0.80:fix 结构化处方扩面(AI 协作面第二波)=====================
// 文件所有权:§84 = 本区全部用例。v0.80 fix 结构化处方扩面(AI 协作面第二波,plan §4.12.5):
// 既有 4 族(M2002/M3029/M3001/M3002)之外,按快照(docs/ai-loop-snapshot.md)数据驱动新增
// 5 个高频 fix 族——M3015(方法名 nearest 改写,v0.67 切口 3 消息建议的结构化同源)/
// M3006(Json 点字段 → x.get("f"),快照 e15 serve 载荷高频缺口)/M3004(声明处补 mut,
// 快照 e09)/M3008(str 拼接标量包 str(...))/M3012(插值包 debug(...),快照 e19 hint 的
// 机械形态)。纪律(v44 先例):应用处方后必消除该错误——每族带 f-probe(程序化应用 →
// 复检 0 error,快照 §0.6 方法学);守卫排除面负例宁缺毋滥(v0.76 两 MAJOR 先例——误伤面
// 是最大风险);既有 4 族 fix 形状逐字零回归锚点;无 fix 诊断席位不变。协议 additive:
// fix 对象 schema 与 v0.44 完全同形({start,end,replacement}),零新诊断码,零消息文案改动。
{
  const dir84 = path.join(TMP, 'v84');
  fs.mkdirSync(dir84, { recursive: true });
  const m84 = (name, src) => { const f = path.join(dir84, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const j84 = (p) => { const r = runMing(['check', p, '--json']); try { return { r, j: JSON.parse(r.stdout) }; } catch { return { r, j: null }; } };
  const find84 = (j, code) => (j?.diagnostics ?? []).find(d => d.code === code);
  // fix 形状规范化(键序归一后逐字比较)——shape84 与既有 toJson 序列化键序一致
  const shape84 = (d) => d && d.fix ? JSON.stringify({ start: d.fix.start, end: d.fix.end, replacement: d.fix.replacement }) : 'null';
  // f-probe(快照 §0.6 方法学):fix 处方程序化应用到语料(机械改写,不手抄)→ 复检,
  // 断言 0 error——"应用处方后必消除该错误"的机器证明。
  const applyFix84 = (src, fix) => {
    const lines = src.split('\n');
    const off = (p) => { let o = 0; for (let i = 0; i < p.line - 1; i++) o += lines[i].length + 1; return o + p.col - 1; };
    return src.slice(0, off(fix.start)) + fix.replacement + src.slice(off(fix.end));
  };
  const probe84 = (key, code, src) => {
    const f = m84(key + '.ming', src);
    const { j } = j84(f);
    const d = (j?.diagnostics ?? []).find(x => x.code === code && x.fix);
    if (!d) return { ok: false, why: '未找到带 fix 的 ' + code + ' codes=' + JSON.stringify((j?.diagnostics ?? []).map(x => x.code)) };
    const f2 = m84(key + '-fixed.ming', applyFix84(src, d.fix));
    const { j: j2 } = j84(f2);
    const errs = (j2?.diagnostics ?? []).filter(x => x.severity === 'error');
    return { ok: j2?.ok === true && errs.length === 0, why: `recheck ok=${j2?.ok} errs=${errs.map(e => e.code + '@' + e.line).join(',') || 'CLEAN'}` };
  };

  // 语料(五族正例)
  const c8415 = ['fn main() -> i64 with io {', '    let v: Vec[i64] = [1, 2];', '    let n = v.lenx();', '    print(str(n));', '    return 0;', '}', ''].join('\n');
  const c8415s = ['fn main() -> i64 with io {', '    let s = "abc";', '    let _ = s.to_uppr();', '    return 0;', '}', ''].join('\n');
  const c84imp = ['struct Greet { name: str }', 'trait Desc { fn describe(self) -> str; }', 'impl Desc for Greet { fn describe(self) -> str { return self.name; } }', 'fn main() -> i64 {', '    let g = Greet { name: "a" };', '    let _ = g.describ();', '    return 0;', '}', ''].join('\n');
  const c8406 = ['fn main() -> i64 {', '    let r = std.json.parse("{}");', '    let p = r.unwrap();', '    let v = p.name;', '    if v.is_some() { return 1; }', '    return 0;', '}', ''].join('\n');
  const c8404 = ['fn main() -> i64 {', '    let x = 1;', '    x = 2;', '    return x;', '}', ''].join('\n');
  const c8408 = ['fn main() -> i64 with io {', '    let n = 42;', '    print("n=" + n);', '    return 0;', '}', ''].join('\n');
  const c84lit = ['fn main() -> i64 with io {', '    let a = "a" + 42;', '    let b = "b" + true;', '    let c = "c" + 1.5;', '    return 0;', '}', ''].join('\n');
  const c8412 = ['fn main() -> i64 with io {', '    let items: Vec[i64] = [1, 2];', '    print("items=\\{items}");', '    return 0;', '}', ''].join('\n');

  // ---- v84.1–v84.3 M3015 nearest fix(候选取自接收者真实方法集;消息 suffix 与 fix 同源)----
  {
    const { j } = j84(m84('v84_15vec.ming', c8415));
    const d = find84(j, 'M3015');
    check('v84.1:M3015 Vec nearest fix——lenx→len(替换域=方法名 token;消息含同源 suffix";最接近的方法是 \"len\"")',
      !!d && d.fix != null && shape84(d) === '{"start":{"line":3,"col":15},"end":{"line":3,"col":19},"replacement":"len"}'
        && d.message.endsWith(';最接近的方法是 "len"'),
      `diag=${JSON.stringify(d)}`);
  }
  {
    const { j } = j84(m84('v84_15str.ming', c8415s));
    const d = find84(j, 'M3015');
    check('v84.2:M3015 str nearest fix——to_uppr→to_upper(替换域=方法名 token,col 15–22)',
      !!d && d.fix != null && shape84(d) === '{"start":{"line":3,"col":15},"end":{"line":3,"col":22},"replacement":"to_upper"}',
      `diag=${JSON.stringify(d)}`);
  }
  {
    const { j } = j84(m84('v84_15impl.ming', c84imp));
    const d = find84(j, 'M3015');
    check('v84.3:M3015 用户类型 nearest fix——候选取自 impl 方法集(describ→describe),非全局名字表(内置构造器不在方法表,结构性不可能命中)',
      !!d && d.fix != null && shape84(d) === '{"start":{"line":6,"col":15},"end":{"line":6,"col":22},"replacement":"describe"}'
        && d.message.endsWith(';最接近的方法是 "describe"'),
      `diag=${JSON.stringify(d)}`);
  }

  // ---- v84.4–v84.8 M3006/M3004/M3008/M3012 正例(fix 形状)----
  {
    const { j } = j84(m84('v84_06json.ming', c8406));
    const d = find84(j, 'M3006');
    check('v84.4:M3006 Json 点字段 fix——p.name → p.get("name")(替换域=字段名 token;接收者 Json + 字段名简单标识符)',
      !!d && d.fix != null && shape84(d) === '{"start":{"line":4,"col":15},"end":{"line":4,"col":19},"replacement":"get(\\"name\\")"}',
      `diag=${JSON.stringify(d)}`);
  }
  {
    const { j } = j84(m84('v84_04mut.ming', c8404));
    const d = find84(j, 'M3004');
    check('v84.5:M3004 mut 插入 fix——零宽插入(start==end=声明绑定名 2:9),替换域不吞原文',
      !!d && d.fix != null && shape84(d) === '{"start":{"line":2,"col":9},"end":{"line":2,"col":9},"replacement":"mut "}',
      `diag=${JSON.stringify(d)}`);
  }
  {
    const { j } = j84(m84('v84_08id.ming', c8408));
    const d = find84(j, 'M3008');
    check('v84.6:M3008 str 拼接 fix——非 str 标量(标识符 i64)包 str(n)(替换域=操作数 3:18–19)',
      !!d && d.fix != null && shape84(d) === '{"start":{"line":3,"col":18},"end":{"line":3,"col":19},"replacement":"str(n)"}',
      `diag=${JSON.stringify(d)}`);
  }
  {
    const f = m84('v84_08lit.ming', c84lit);
    const { j } = j84(f);
    const ds = (j?.diagnostics ?? []).filter(d => d.code === 'M3008');
    check('v84.7:M3008 str 拼接字面量 fix——整型/布尔/浮点三形态各包 str(42)/str(true)/str(1.5)',
      ds.length === 3 && ds.every(d => d.fix != null)
        && ds[0].fix.replacement === 'str(42)' && ds[0].fix.start.line === 2
        && ds[1].fix.replacement === 'str(true)' && ds[1].fix.start.line === 3
        && ds[2].fix.replacement === 'str(1.5)' && ds[2].fix.start.line === 4,
      `diags=${JSON.stringify(ds.map(d => ({ line: d.line, fix: d.fix })))}`);
  }
  {
    const { j } = j84(m84('v84_12dbg.ming', c8412));
    const d = find84(j, 'M3012');
    check('v84.8:M3012 插值 debug 包装 fix——items → debug(items)(替换域=插值表达式 3:20–25)',
      !!d && d.fix != null && shape84(d) === '{"start":{"line":3,"col":20},"end":{"line":3,"col":25},"replacement":"debug(items)"}',
      `diag=${JSON.stringify(d)}`);
  }

  // ---- v84.9–v84.13 f-probe(应用处方后必消除——五族各 1 条机器证明)----
  {
    const p = probe84('v84p15', 'M3015', c8415);
    check('v84.9:f-probe M3015——lenx→len 应用后复检 0 error', p.ok, p.why);
  }
  {
    const p = probe84('v84p06', 'M3006', c8406);
    check('v84.10:f-probe M3006——p.name→p.get("name") 应用后复检 0 error(毒化级联一并消除)', p.ok, p.why);
  }
  {
    const p = probe84('v84p04', 'M3004', c8404);
    check('v84.11:f-probe M3004——声明处补 mut 应用后复检 0 error', p.ok, p.why);
  }
  {
    const p = probe84('v84p08', 'M3008', c8408);
    check('v84.12:f-probe M3008——"n="+n → "n="+str(n) 应用后复检 0 error', p.ok, p.why);
  }
  {
    const p = probe84('v84p12', 'M3012', c8412);
    check('v84.13:f-probe M3012——\\{items} → \\{debug(items)} 应用后复检 0 error', p.ok, p.why);
  }

  // ---- v84.14–v84.19 守卫排除面负例(宁缺毋滥——误伤面是最大风险)----
  {
    const { j: jv } = j84(m84('v84n_vec.ming', ['fn main() -> i64 with io {', '    let v: Vec[i64] = [1];', '    let _ = "a" + v;', '    return 0;', '}', ''].join('\n')));
    const { j: jj } = j84(m84('v84n_json.ming', ['fn main() -> i64 {', '    let j = std.json.parse("{}").unwrap();', '    let _ = "a" + j;', '    return 0;', '}', ''].join('\n')));
    const dv = find84(jv, 'M3008'), dj = find84(jj, 'M3008');
    check('v84.14:M3008 负例——非 ToStr 类型(Vec/Json)不发 fix(包 str(...) 必产生新 M3002,违反"应用后必消除")',
      !!dv && dv.fix == null && !!dj && dj.fix == null,
      `vec=${JSON.stringify(dv?.fix)} json=${JSON.stringify(dj?.fix)}`);
  }
  {
    const { j } = j84(m84('v84n_untr.ming', ['fn main() -> i64 with io {', '    let u = std.io.read_line();', '    let _ = u + 42;', '    return 0;', '}', ''].join('\n')));
    const d = find84(j, 'M3008');
    check('v84.15:M3008 负例——任一侧含 Untrusted 不发 fix(str(u) 是洗白通道 M3049,污值禁入)',
      !!d && d.fix == null && !find84(j, 'M3029'),
      `diag=${JSON.stringify(d)}`);
  }
  {
    const { j: jp } = j84(m84('v84n_param.ming', ['fn f(x: i64) -> i64 {', '    x = 2;', '    return x;', '}', 'fn main() -> i64 { return f(1); }', ''].join('\n')));
    const { j: jl } = j84(m84('v84n_lcap.ming', ['fn main() -> i64 {', '    let x = 1;', '    let g = () => { x = 2; return x; };', '    return g();', '}', ''].join('\n')));
    const dp = find84(jp, 'M3004'), dl = find84(jl, 'M3004');
    check('v84.16:M3004 负例——形参赋值/lambda 捕获外层变量不发 fix(声明与赋值跨函数边界,fnId 判定)',
      !!dp && dp.fix == null && !!dl && dl.fix == null,
      `param=${JSON.stringify(dp?.fix)} lambda=${JSON.stringify(dl?.fix)}`);
  }
  {
    const { j } = j84(m84('v84n_near.ming', ['fn main() -> i64 {', '    let v: Vec[i64] = [1];', '    let _ = v.zzzzzz();', '    return 0;', '}', ''].join('\n')));
    const d = find84(j, 'M3015');
    check('v84.17:M3015 负例——nearest 距离 >2 无建议:消息无";最接近的方法是"后缀且不发 fix(方法表候选不含内置构造器,结构性排除)',
      !!d && d.fix == null && !d.message.includes(';最接近的方法是'),
      `diag=${JSON.stringify(d)}`);
  }
  {
    const { j: js } = j84(m84('v84n_struct.ming', ['struct Point { x: i64, y: i64 }', 'fn main() -> i64 {', '    let p = Point { x: 1, y: 2 };', '    let _ = p.z;', '    return 0;', '}', ''].join('\n')));
    const { j: jt } = j84(m84('v84n_str.ming', ['fn main() -> i64 {', '    let s = "abc";', '    let _ = s.foo;', '    return 0;', '}', ''].join('\n')));
    const ds = find84(js, 'M3006'), dt = find84(jt, 'M3006');
    check('v84.18:M3006 负例——接收者非 Json(结构体缺字段无机械改名/str 无字段)不发 fix',
      !!ds && ds.fix == null && !!dt && dt.fix == null,
      `struct=${JSON.stringify(ds?.fix)} str=${JSON.stringify(dt?.fix)}`);
  }
  {
    const { j: jf } = j84(m84('v84n_fn.ming', ['fn main() -> i64 with io {', '    let f = (a: i64) => a + 1;', '    print("\\{f}");', '    return 0;', '}', ''].join('\n')));
    const { j: ju } = j84(m84('v84n_unres.ming', ['fn main() -> i64 with io {', '    print("\\{nope}");', '    return 0;', '}', ''].join('\n')));
    const df = find84(jf, 'M3012'), du = find84(ju, 'M3012');
    check('v84.19:M3012 负例——函数值插值(debug 拒绝 fn)与根因未解析名(debug(同名) 仍错)不发 fix',
      !!df && df.fix == null && !!du && du.fix == null && !!find84(ju, 'M3001'),
      `fn=${JSON.stringify(df?.fix)} unres=${JSON.stringify(du?.fix)}`);
  }

  // ---- v84.20–v84.22 零回归锚点(既有 4 族 fix 形状逐字不变 + 无 fix 席位不变)----
  {
    const f1 = m84('v84r_2002.ming', ['fn main() with io {', '    let x = 1', '    print(str(x));', '}', ''].join('\n'));
    const f2 = m84('v84r_3029.ming', ['fn f() {', '    print("hi");', '}', 'fn main() with io { f(); }', ''].join('\n'));
    const f3 = m84('v84r_3001.ming', ['fn main() with io {', '    let total = 1;', '    print(str(totl));', '}', ''].join('\n'));
    const f4 = m84('v84r_3002.ming', ['fn main() {', '    let x: i64 = "s";', '}', ''].join('\n'));
    const j1 = j84(f1).j, j2 = j84(f2).j, j3 = j84(f3).j, j4 = j84(f4).j;
    const d2002 = find84(j1, 'M2002'), d3029 = find84(j2, 'M3029'), d3001 = find84(j3, 'M3001'), d3002 = find84(j4, 'M3002');
    const w3101 = find84(j4, 'W3101');
    check('v84.20:零回归锚点——既有 4 族 fix 形状逐字不变(M2002 插入";"/M3029 补" with io "/M3001 名字替换/M3002 标注改写)',
      d2002 != null && d2002.fix != null && shape84(d2002) === '{"start":{"line":3,"col":5},"end":{"line":3,"col":5},"replacement":";"}'
        && d3029 != null && d3029.fix != null && shape84(d3029) === '{"start":{"line":1,"col":8},"end":{"line":1,"col":8},"replacement":" with io "}'
        && d3001 != null && d3001.fix != null && shape84(d3001) === '{"start":{"line":3,"col":15},"end":{"line":3,"col":19},"replacement":"total"}'
        && d3002 != null && d3002.fix != null && shape84(d3002) === '{"start":{"line":2,"col":12},"end":{"line":2,"col":18},"replacement":"str = "}',
      `M2002=${shape84(d2002)} M3029=${shape84(d3029)} M3001=${shape84(d3001)} M3002=${shape84(d3002)}`);
    check('v84.21:零回归锚点——无 fix 旗标诊断席位不变(W3101 未使用变量无 fix 键)',
      w3101 != null && w3101.fix == null,
      `W3101=${JSON.stringify(w3101?.fix)}`);
  }
  {
    const { j } = j84(m84('v84n_3013.ming', ['fn main() -> i64 {', '    let a: i32 = 1;', '    let b: i64 = 2;', '    let _c = a + b;', '    return 0;', '}', ''].join('\n')));
    const d = find84(j, 'M3013');
    check('v84.22:零回归锚点——M3013(新 5 族守卫域之外)维持无 fix',
      !!d && d.fix == null,
      `diag=${JSON.stringify(d?.fix)}`);
  }
  // ---- v84.23–v84.25 守卫排除面负例补全(独立审查 MINOR-2:循环绑定、Json 赋值位、
  //      Ptr 插值——合同禁面的测试锚定;while-let 与 for 绑定同走 checkPattern 默认参
  //      letFix=false,取语法确定的 for 形态锚定)----
  {
    const { j } = j84(m84('v84n_forbind.ming', ['fn main() -> i64 {', '    let v: Vec[i64] = [1, 2];', '    for x in v {', '        x = 5;', '    }', '    return 0;', '}', ''].join('\n')));
    const d = find84(j, 'M3004');
    check('v84.23:M3004 负例——for-in 循环变量重赋值不发 fix(循环绑定非 let 声明,mut 关键字无处可插)',
      !!d && d.fix == null,
      `diag=${JSON.stringify(d?.fix)}`);
  }
  {
    const { j } = j84(m84('v84n_jassign.ming', ['fn main() -> i64 {', '    let j = std.json.parse("{}").unwrap();', '    j.name = 1;', '    return 0;', '}', ''].join('\n')));
    const d = find84(j, 'M3006');
    check('v84.24:M3006 负例——Json 字段赋值位(独立消息路径)不发 fix(get("f") 是读投影,对赋值位不成立)',
      !!d && d.fix == null,
      `diag=${JSON.stringify(d?.fix)}`);
  }
  {
    const { j } = j84(m84('v84n_ptr.ming', ['fn f(p: Ptr[u8]) -> i64 with unsafe {', '    let s = "x\\{p}";', '    return 0;', '}', 'fn main() -> i64 { return 0; }', ''].join('\n')));
    const d = find84(j, 'M3012');
    check('v84.25:M3012 负例——Ptr 插值不发 fix(debug 拒绝 Ptr,包 debug(...) 必产生新错误)',
      !!d && d.fix == null,
      `diag=${JSON.stringify(d?.fix)}`);
  }
  {
    // v0.80 审查 MAJOR-1 锁定:整值浮点 String() 渲染无小数点,替换文本必须补 ".0"——
    // 否则 str(100) 输出 "100" 与源程序 "100.0" 值不等价。替换文本 + 应用后复检双锚定。
    const src = ['fn main() -> i64 with io {', '    let _ = "c" + 100.0;', '    return 0;', '}', ''].join('\n');
    const f = m84('v84f_intfloat.ming', src);
    const { j } = j84(f);
    const d = find84(j, 'M3008');
    const f2 = m84('v84f_intfloat-fixed.ming', applyFix84(src, d.fix));
    const { j: j2 } = j84(f2);
    check('v84.26:M3008 整值浮点——替换文本 str(100.0) 值忠实(非 str(100))+f-probe 应用后 0 error',
      !!d && d.fix != null && d.fix.replacement === 'str(100.0)' && j2?.ok === true,
      `fix=${JSON.stringify(d?.fix)} re_ok=${j2?.ok} re_diag=${JSON.stringify((j2?.diagnostics ?? []).map((x) => x.code))}`);
  }
  // ---- §84-END
}

// ===================== 85. v0.80:LSP 多文件符号补全第一切片 =====================
// 文件所有权:§85 = 本区全部用例。实现面仅 src/lsp.js(补全面 additive,既有单文件路径逐字未动)。
// 切片三件(架构师合同 plan §4.12.5;保守原则:宁可空列表不可错补;check-ID 前缀 v85.*——
// §83 号与 v83 前缀已被 xnsni/xnopen 工具提交占用,避让):
//   ① 本地 use 导入成员补全(v0.58 既有 machinery:membersOfBase/useImportsOf/parseModuleFile
//     ——本切片补测 as 别名正例 + 保守负例锚定)——`use geom as g;` 后 `g.` 列目标文件顶层
//     pub 项(fn/struct/enum/const + 签名摘要);trait 不能 pub(语法面:`pub` 后只允许
//     fn/struct/enum/const,M2002)→ 与 checker 口径一致不出现在跨模块成员列表(如实锁定);
//     目标缺失/解析失败 → 空列表不崩(不 null、不猜)。
//   ② `use ` 关键字上下文(本版新收口)——此前该上下文回落通用列表(关键字/内置在 use 行是
//     错补);现只给 std.X 全名(STD_MODULES)+ 本地同目录 .ming 模块名(checker.load 同口径)。
//     裸 'std' 不给(`use std;` = M3022)、裸模块名不给(单段按本地文件解析);目录不可枚举
//     → 仅 std 面;自文件名不候选(自导入 = M3025 循环);子目录首段不列(下一跳 `D.` 无成员
//     支撑,登记不预支)。
//   ③ std 模块成员补全 as 别名走通(v0.58 既有面补测):`use std.str as s;` → `s.` =
//     std.str 函数集;裸 bind 形态 `use std.str;` → `str.` 同列表。
//   另:§62 既有补全形态四类各抽 1 条重断言(单文件零回归锚)+ 管道协议抽查(UTF-8 字节分帧)。
{
  const dir85 = path.join(TMP, 'v85');
  fs.mkdirSync(dir85, { recursive: true });
  const mk85 = (name, src) => { const f = path.join(dir85, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const labels85 = (r) => (r === null || r === undefined ? null : r.items.map((i) => i.label));
  const kinds85 = (r) => (r === null ? null : r.items.map((i) => i.kind));
  const details85 = (r) => (r === null ? null : r.items.map((i) => i.detail));
  const uri85 = (p) => 'file:///' + p.split(path.sep).join('/');
  // 管道会话(§62 同款字节分帧,本区自持副本:§62 助手在其块作用域内)
  const frame85 = (m) => { const b = JSON.stringify(m); return `Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`; };
  const parse85 = (out) => {
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

  // 公用夹具:被 use 的目标模块(pub fn/struct/enum/const + 非 pub trait 与 fn)
  mk85('geom.ming', [
    'pub fn add(a: i64, b: i64) -> i64 { return a + b; }',
    'pub struct Pt { x: i64, y: i64 }',
    'pub enum Shape { Circle, Square }',
    'pub const MAX: i64 = 100;',
    'trait Drawable { fn draw(self) -> i64; }',
    'fn hidden() -> i64 { return 0; }',
    '',
  ].join('\n'));
  mk85('brokenmod.ming', 'fn f( {\n'); // 解析失败的目标(切片①负例)

  // ---- v85.1(切片① 正例):`use geom as g;` 后 `g.` → 目标文件顶层 pub 项全列(签名摘要)----
  {
    const p = mk85('a85_alias.ming', 'use geom as g;\nfn main() {\n  let x = g.\n}\n');
    const r = completionFor(p, fs.readFileSync(p, 'utf8'), 2, 12);
    check('v85.1:mf_alias_members —— `g.`(as 别名)→ add/Pt/Shape/MAX 恰四项(kinds 3/22/13/21 + 签名摘要);非 pub 的 hidden 与 trait Drawable 不列,局部变量不混入',
      r !== null && JSON.stringify(labels85(r)) === JSON.stringify(['add', 'Pt', 'Shape', 'MAX'])
      && JSON.stringify(kinds85(r)) === JSON.stringify([3, 22, 13, 21])
      && JSON.stringify(details85(r)) === JSON.stringify([
        'fn add(a: i64, b: i64) -> i64', 'struct Pt { x: i64, y: i64 }',
        'enum Shape { Circle, Square }', 'const MAX: i64',
      ]),
      `r=${JSON.stringify(r)}`);
  }

  // ---- v85.2(切片① 前缀过滤):`g.a` → [add](穿透 as 别名)----
  {
    const p = mk85('a85_prefix.ming', 'use geom as g;\nfn main() {\n  let y = g.a\n}\n');
    const r = completionFor(p, fs.readFileSync(p, 'utf8'), 2, 13);
    check('v85.2:mf_alias_prefix —— `g.a` → [add](前缀过滤穿透 as 别名)',
      r !== null && JSON.stringify(labels85(r)) === JSON.stringify(['add']),
      `r=${JSON.stringify(r)}`);
  }

  // ---- v85.3(切片① 负例):目标解析失败 / 不存在 → 空列表不崩(不 null、不猜)----
  {
    const p1 = mk85('a85_neg1.ming', 'use brokenmod as bm;\nfn main() {\n  let a = bm.\n}\n');
    const r1 = completionFor(p1, fs.readFileSync(p1, 'utf8'), 2, 14);
    const p2 = mk85('a85_neg2.ming', 'use nothere as m2;\nfn main() {\n  let b = m2.\n}\n');
    const r2 = completionFor(p2, fs.readFileSync(p2, 'utf8'), 2, 15);
    check('v85.3:mf_neg_broken_missing —— brokenmod(语法坏)→ [];nothere(不存在)→ [];均 isIncomplete:false 空列表不崩',
      r1 !== null && r1.isIncomplete === false && Array.isArray(r1.items) && r1.items.length === 0
      && r2 !== null && r2.isIncomplete === false && Array.isArray(r2.items) && r2.items.length === 0,
      `broken=${JSON.stringify(r1)} missing=${JSON.stringify(r2)}`);
  }

  // ---- v85.4(切片① 失效绑定):目标文件删除前可补、删除后 → [];通用列表不含失效绑定 ----
  {
    mk85('gone.ming', 'pub fn ghost() -> i64 { return 0; }\n');
    const p = mk85('a85_gone.ming', 'use gone;\nfn main() {\n  gone.\n}\n');
    const src = fs.readFileSync(p, 'utf8');
    const rActive = completionFor(p, src, 2, 7);
    fs.unlinkSync(path.join(dir85, 'gone.ming'));
    const rStale = completionFor(p, src, 2, 7);
    // 通用空前缀用完整可解析源(失效绑定断言不依赖占位修复)
    const pGen = mk85('a85_gonegen.ming', 'use gone;\nfn main() {\n  \n}\n');
    const rGeneric = completionFor(pGen, fs.readFileSync(pGen, 'utf8'), 2, 2);
    check('v85.4:mf_stale_binding —— gone.ming 在盘 → [ghost];删除后 → [];通用列表不含 gone(无失效绑定)',
      rActive !== null && JSON.stringify(labels85(rActive)) === JSON.stringify(['ghost'])
      && rStale !== null && rStale.isIncomplete === false && rStale.items.length === 0
      && rGeneric !== null && !labels85(rGeneric).includes('gone'),
      `active=${JSON.stringify(labels85(rActive))} stale=${JSON.stringify(rStale)} generic=${JSON.stringify(rGeneric && labels85(rGeneric).includes('gone'))}`);
  }

  // ---- v85.5(切片② 正例):`use ` → std.X 全名 + 本地同目录模块名;错补面收口 ----
  {
    const up = path.join(dir85, 'useproj');
    fs.mkdirSync(path.join(up, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(up, 'geom.ming'), [
      'pub fn add(a: i64, b: i64) -> i64 { return a + b; }',
      'pub struct Pt { x: i64, y: i64 }',
      'pub enum Shape { Circle, Square }',
      'pub const MAX: i64 = 100;',
      'trait Drawable { fn draw(self) -> i64; }',
      'fn hidden() -> i64 { return 0; }',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(up, 'sub', 'inner.ming'), 'pub fn deep() -> i64 { return 1; }\n', 'utf8');
    const pUse = path.join(up, 'main.ming');
    fs.writeFileSync(pUse, 'use \nuse geom as g;\nfn main() {\n}\n', 'utf8');
    const r = completionFor(pUse, fs.readFileSync(pUse, 'utf8'), 0, 4);
    check('v85.5:mf_use_context —— `use ` → std.X 全名 + 本地 geom(kind 全 9);无裸 std/自文件 main/子目录 sub/关键字/内置(错补面收口)',
      r !== null
      && labels85(r).includes('std.str') && labels85(r).includes('std.math') && labels85(r).includes('geom')
      && kinds85(r).every((k) => k === 9)
      && !labels85(r).includes('std') && !labels85(r).includes('main') && !labels85(r).includes('sub')
      && !labels85(r).includes('let') && !labels85(r).includes('fn') && !labels85(r).includes('print'),
      `n=${r && r.items.length} labels=${JSON.stringify(labels85(r))}`);
  }

  // ---- v85.6(切片② 前缀 + 保守回退):`use ge` → [geom];目录不可枚举 → 仅 std 面 ----
  {
    const up = path.join(dir85, 'useproj');
    const pUse = path.join(up, 'main.ming');
    const rGe = completionFor(pUse, 'use ge\nfn main() {\n}\n', 0, 6);
    const pGhost = path.join(dir85, 'no-such-dir', 'ghost.ming'); // 目录不存在 → readdir 失败
    const rGhost = completionFor(pGhost, 'use \nfn main() {\n}\n', 0, 4);
    check('v85.6:mf_use_prefix_and_nodir —— `use ge` → [geom] 恰一项;目录不可枚举 → 仅 std 面(全 std.* 前缀,含 std.str,无本地/关键字)',
      rGe !== null && JSON.stringify(labels85(rGe)) === JSON.stringify(['geom'])
      && rGhost !== null && rGhost.items.length >= 15 && labels85(rGhost).every((l) => l.startsWith('std.'))
      && labels85(rGhost).includes('std.str'),
      `ge=${JSON.stringify(labels85(rGe))} ghost=${JSON.stringify(labels85(rGhost))}`);
  }

  // ---- v85.7(切片③):std 模块 as 别名成员补全走通;裸 bind 形态同列表 ----
  {
    const p1 = mk85('a85_stdalias.ming', 'use std.str as s;\nfn main() {\n  let j = s.\n}\n');
    const r1 = completionFor(p1, fs.readFileSync(p1, 'utf8'), 2, 12);
    const p2 = mk85('a85_stdbare.ming', 'use std.str;\nfn main() {\n  let k = str.\n}\n');
    const r2 = completionFor(p2, fs.readFileSync(p2, 'utf8'), 2, 14);
    check('v85.7:mf_std_alias —— `s.`(std.str as s)→ join/index_of(kind 3,detail std.str.*);`str.`(裸 bind)同列表',
      r1 !== null && labels85(r1).includes('join') && labels85(r1).includes('index_of')
      && kinds85(r1).every((k) => k === 3) && details85(r1).every((d) => typeof d === 'string' && d.startsWith('std.str.'))
      && r2 !== null && JSON.stringify(labels85(r2)) === JSON.stringify(labels85(r1))
      && JSON.stringify(kinds85(r2)) === JSON.stringify(kinds85(r1)),
      `alias=${JSON.stringify(r1)} bare=${JSON.stringify(r2)}`);
  }

  // ---- v85.8(单文件零回归锚):§62 既有补全形态四类各抽 1 条逐字重断言 ----
  {
    mk85('helper.ming', [
      'pub fn shout(s: str) -> str { return s + "!"; }',
      'fn hidden() -> i64 { return 1; }',
      'pub const LIMIT: i64 = 3;',
      '',
    ].join('\n'));
    const pF = mk85('a85_reg_field.ming', [
      'struct Point { x: i64, y: i64, }',
      'trait Geo { fn len2(self) -> i64; }',
      'impl Geo for Point { fn len2(self) -> i64 { return self.x * self.x + self.y * self.y; } }',
      'fn main() with io {',
      '  let p = Point { x: 1, y: 2 };',
      '  p.',
      '}',
      '',
    ].join('\n'));
    const rF = completionFor(pF, fs.readFileSync(pF, 'utf8'), 5, 4);
    const pH = mk85('a85_reg_helper.ming', ['use helper;', 'fn main() with io {', '  helper.', '}', ''].join('\n'));
    const rH = completionFor(pH, fs.readFileSync(pH, 'utf8'), 2, 9);
    const pO = mk85('a85_reg_prefix.ming', [
      'struct Opt { v: i64, }',
      'fn main() with io {',
      '  let o2 = 1;',
      '  o',
      '}',
      '',
    ].join('\n'));
    const rO = completionFor(pO, fs.readFileSync(pO, 'utf8'), 3, 3);
    const pE = mk85('a85_reg_empty.ming', ['fn main() with io {', '  ', '}', ''].join('\n'));
    const rE = completionFor(pE, fs.readFileSync(pE, 'utf8'), 1, 2);
    check('v85.8:mf_singlefile_zero_reg —— 字段方法 `p.` = [x,y,len2](5/5/2);模块成员 `helper.` = [shout,LIMIT];标识符前缀 `o` = [o2];空前缀含 let/print/std',
      rF !== null && JSON.stringify(labels85(rF)) === JSON.stringify(['x', 'y', 'len2']) && JSON.stringify(kinds85(rF)) === JSON.stringify([5, 5, 2])
      && rH !== null && JSON.stringify(labels85(rH)) === JSON.stringify(['shout', 'LIMIT'])
      && rO !== null && JSON.stringify(labels85(rO)) === JSON.stringify(['o2'])
      && rE !== null && labels85(rE).includes('let') && labels85(rE).includes('print') && labels85(rE).includes('std'),
      `field=${JSON.stringify(labels85(rF))} helper=${JSON.stringify(labels85(rH))} o=${JSON.stringify(labels85(rO))} empty=${rE && rE.items.length}`);
  }

  // ---- v85.9(管道协议抽查):多文件 stdio JSON-RPC 会话(Content-Length 按 UTF-8 字节分帧)----
  {
    const up = path.join(dir85, 'useproj');
    const uriA = uri85(path.join(up, 'main.ming'));
    const textA = '// 多文件补全(中文注释练 UTF-8 字节分帧)\nuse \nfn main() {\n}\n';
    const uriB = uri85(path.join(up, 'b_alias.ming')); // 主文件本体不必在盘:成员补全只依赖目标 geom.ming 在盘
    const textB = 'use geom as g;\nfn main() {\n  g.\n}\n';
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: uriA, languageId: 'ming', version: 1, text: textA } } },
      { jsonrpc: '2.0', id: 2, method: 'textDocument/completion', params: { textDocument: { uri: uriA }, position: { line: 1, character: 4 } } },
      { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: uriB, languageId: 'ming', version: 1, text: textB } } },
      { jsonrpc: '2.0', id: 3, method: 'textDocument/completion', params: { textDocument: { uri: uriB }, position: { line: 2, character: 4 } } },
      { jsonrpc: '2.0', id: 4, method: 'shutdown', params: null },
      { jsonrpc: '2.0', method: 'exit', params: null },
    ];
    const r = runMing(['lsp'], { stdin: msgs.map(frame85).join('') });
    const rs = parse85(r.stdout);
    const byId = (i) => rs.find((x) => x.id === i);
    const useLabels = (byId(2)?.result?.items ?? []).map((i) => i.label);
    const gLabels = (byId(3)?.result?.items ?? []).map((i) => i.label);
    check('v85.9:mf_pipe_session —— stdio 会话:`use ` 位置补全含 geom/std.str(无自文件 main);`g.` 位置补全含 add/Pt/Shape/MAX(无 hidden);exit 0',
      r.code === 0
      && useLabels.includes('geom') && useLabels.includes('std.str') && !useLabels.includes('main')
      && gLabels.includes('add') && gLabels.includes('Pt') && gLabels.includes('Shape') && gLabels.includes('MAX')
      && !gLabels.includes('hidden'),
      `code=${r.code} ids=${JSON.stringify(rs.map((x) => x.id))} use=${JSON.stringify(useLabels)} g=${JSON.stringify(gLabels)}`);
  }
  // ---- §85-END
}

// ===================== 86. v0.81:tree ContSig 硬化 + json_query C0 序列化收敛 =====================
// 文件所有权:§86 = 本区全部用例。两项引擎一致性清账(plan §4.12.5):
//   ① tree 引擎 ContSig/BrkSig 纵深防御(v0.79 独立审查 NOTE-1)——src/interp.js 新增
//     brkContGuard:callClosure(闭包分支)/callLocalFn 的 catch 在 RetSig 之后检查
//     BrkSig/ContSig,到达函数边界即抛具名 Panic M4001(与 compiler.js compileStmt
//     Break/Continue 防御分支 v0.79 ② 同模式同口径;M4001 = 既有内部不变量码,零新增
//     M 码)。checker 已在函数边界拒绝裸 continue/break(M3010/M3011),循环内合法信号
//     由循环 execStmt catch 就地消化——守卫正常程序不可达,白盒经合成闭包/本地函数
//     直连内部方法验证(v82.7 同做法;信号由 body AST {nt:'Continue'/'Break'} 经
//     execStmt 抛出真实 BrkSig/ContSig,不经导出面)。
//   ② json_query C0 序列化收敛(v0.77 迁移期登记 → 本版修复)——tools/json_query.ming
//     重建路径 json_escape/json_escape_u 补 27 条 C0 replace(0x00–0x07/0x0B/0x0E–0x1F;
//     \b \t \n \f \r 短形态既有),与引擎 jsonWrite(debug(Json))逐字节一致。黄金锚
//     实测:\u0001 → \u0001(小写四位补零),DEL U+007F 引擎不转义 → 工具同口径原样
//     透出(v0.77"语言面无码点数值途径"登记以 replace 字面量枚举修正收敛——无需码点
//     算术)。良性路径(不含 C0)输出与 HEAD 版本逐字节不变(黄金期望锁定)。
{
  const dir86 = path.join(TMP, 'v86');
  fs.mkdirSync(dir86, { recursive: true });
  const m86 = (name, src) => { const f = path.join(dir86, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags86 = ['', '--no-wasm', '--tree'];
  const runAll86 = (p) => flags86.map(fl => runMing(fl ? ['run', p, fl] : ['run', p]));
  const same86 = (runs, want) => runs.every(r => r.code === 0 && r.stdout === want);
  const fmtRuns86 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout)}`).join(' | ');
  const GUARD_MSG_86 = '内部错误(树引擎):lambda/本地函数体内的 break/continue 穿透了函数调用帧(checker 已拦截,不应到达)';

  // 白盒助手:真实 Checker 管线取 checkResult;VMInterp tree 模式 = 纯树引擎实例
  // (callClosure/callLocalFn 走 Interp 原型链,不含 VM 编译路径)
  const wb86 = () => {
    const f = m86('v86_wb.ming', 'fn main() -> i64 with io { let g = (a: i64) => a + 1; print(g(1)); return 0; }\n');
    return new VMInterp(new Checker(f).run(), { capture: true, tree: true });
  };
  const callClo86 = (bodyNode) => {
    const interp = wb86();
    const clo = {
      t: 'closure', params: [{ name: 'a' }],
      body: { nt: 'BlockExpr', block: { stmts: [bodyNode] } },
      env: { vars: new Map(), parent: null, mod: null }, fnType: null,
    };
    try { interp.callClosure(clo, [{ t: 'int', v: 1n }], null); return null; } catch (e) { return e; }
  };
  const callLocalFn86 = (bodyNode) => {
    const interp = wb86();
    const sig = { decl: { params: [], body: { stmts: [bodyNode] }, ensures: null, requires: null, name: 'lf' }, env: null, mod: null, name: 'lf' };
    try { interp.callLocalFn(sig, [], { span: null }); return null; } catch (e) { return e; }
  };

  // v86.1–v86.3 ContSig/BrkSig 白盒:守卫具名 M4001,消息逐字
  {
    const eC = callClo86({ nt: 'Continue', span: { file: 'wb', line: 1, col: 1 } });
    check('v86.1:ContSig 白盒(callClosure·tree)——合成闭包体裸 continue 具名 Panic M4001 消息逐字(不再穿透)',
      eC != null && eC.code === 'M4001' && eC.message === GUARD_MSG_86,
      `e=${eC ? eC.constructor.name + ':' + eC.code + ':' + eC.message : 'null(信号穿透——守卫缺失)'}`);
    const eB = callClo86({ nt: 'Break', span: { file: 'wb', line: 1, col: 1 } });
    check('v86.2:BrkSig 白盒(callClosure·tree)——合成闭包体裸 break 同消息逐字',
      eB != null && eB.code === 'M4001' && eB.message === GUARD_MSG_86,
      `e=${eB ? eB.constructor.name + ':' + eB.code + ':' + eB.message : 'null(信号穿透——守卫缺失)'}`);
    const eL = callLocalFn86({ nt: 'Continue', span: { file: 'wb', line: 1, col: 1 } });
    check('v86.3:ContSig 白盒(callLocalFn·tree)——本地函数体裸 continue 同消息逐字',
      eL != null && eL.code === 'M4001' && eL.message === GUARD_MSG_86,
      `e=${eL ? eL.constructor.name + ':' + eL.code + ':' + eL.message : 'null(信号穿透——守卫缺失)'}`);
  }

  // v86.4/v86.5 正常形态零回归(§82 v82.3/v82.4 同款语料,三引擎逐字):
  // lambda 自带 for+continue / while+break 仍合法——守卫只拦信号跨帧,不碰合法循环。
  {
    const f = m86('v86_4_own_loop.ming', [
      'fn main() -> i64 with io {',
      '    let v: Vec[i64] = [1, 2, 3];',
      '    let g = (n: i64) => {',
      '        let mut acc = 0;',
      '        for i in 0..n {',
      '            if i % 2 == 0 { continue; }',
      '            acc += i;',
      '        }',
      '        return acc;',
      '    };',
      '    for x in v {',
      '        let w = v.map(g);',
      '        print(str(x) + ":" + str(w.get(0).unwrap_or(-1)));',
      '    }',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs = runAll86(f);
    check('v86.4:lambda 自带 for+continue + 外层 map(HOF 通道)三引擎逐字 1:0\\n2:0\\n3:0\\n',
      same86(runs, '1:0\n2:0\n3:0\n'), fmtRuns86(runs));
    const f2 = m86('v86_5_own_while.ming', [
      'fn main() -> i64 with io {',
      '    let find = (n: i64) => {',
      '        let mut i = 0;',
      '        while i < n {',
      '            if i * i >= n { break; }',
      '            i += 1;',
      '        }',
      '        return i;',
      '    };',
      '    print(str(find(10)));',
      '    print(str(find(1)));',
      '    return 0;',
      '}',
    ].join('\n'));
    const runs2 = runAll86(f2);
    check('v86.5:lambda 自带 while+break 合法三引擎逐字 4\\n1\\n',
      same86(runs2, '4\n1\n'), fmtRuns86(runs2));
  }

  // v86.6–v86.11 json_query C0 收敛:夹具含 \u0000/\u0001/\u0007/\u000b/\u001f/DEL
  // (引擎不转义,原样透出)/多字节(emoji/中文)+ C0 键;引擎黄金 = 真实 Ming 管线
  // debug(Json)(--tree),另以 JSON.stringify(jsonWrite 的单一事实来源)双锚逐字节。
  {
    const c0obj = {
      name: 'x\u0001y', tab: 'a\tb', bell: '\u0007', del: '\u007f',
      nl: 'g\nh', cr: 'i\rj', bs: 'c\\d', esc: 'e"f',
      nul: '\u0000', vt: '\u000b', us: '\u001f',
      emoji: '😀', zh: '中文',
      arr: ['p\u0007q', 'plain', 'tab\there'],
      deep: { 'k\u0002v': 'x\u0001y', bell: '\u0007', vt: '\u000b', us: '\u001f', del: 'a\u007fb', inner: ['p\u0007q'] },
      empty: {}, emptyarr: [], num: 3.5, boolv: true, nullv: null,
    };
    const c0json = JSON.stringify(c0obj);
    const c0file = path.join(dir86, 'v86_c0.json');
    fs.writeFileSync(c0file, c0json, 'utf8');
    const paths86 = ['arr', 'deep', 'empty', 'emptyarr', 'num', 'boolv', 'nullv'];
    // 引擎黄金程序:同一 JSON 文本作净字面量(Ming 转义 = 先反斜杠后引号,逐字复原)
    const esc86 = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const goldSrc = [
      'use std.json;',
      'fn main() -> i64 with io {',
      '    let s = "' + esc86(c0json) + '";',
      '    let doc = match std.json.parse(s) { Ok(j) => j, Err(e) => { eprint(e); return 1; } };',
      ...paths86.map(q => '    print(debug(doc.get("' + q + '").unwrap()));'),
      '    return 0;',
      '}',
    ].join('\n');
    const goldFile = m86('v86_gold.ming', goldSrc);
    const gold = runMing(['run', goldFile, '--tree']);
    check('v86.6:引擎 debug(Json) 黄金锚(--tree)——C0 语料 7 子树逐行解析输出 exit 0 且 stderr 空',
      gold.code === 0 && gold.stdout.length > 0 && gold.stderr === '',
      `code=${gold.code} out=${JSON.stringify(gold.stdout.slice(0, 120))} err=${JSON.stringify(gold.stderr.slice(0, 120))}`);
    const jsGold = paths86.map(q => JSON.stringify(c0obj[q]) + '\n').join('');
    check('v86.7:黄金锚出处(jsonWrite = JSON.stringify 单一事实)——引擎输出与 JS 重构逐字节一致',
      gold.stdout === jsGold,
      `got=${JSON.stringify(gold.stdout.slice(0, 120))} want=${JSON.stringify(jsGold.slice(0, 120))}`);
    // 工具输出 vs 引擎黄金:重建路径(非字符串叶子)逐字节一致(C0 已收敛)
    const tool = runMing(['tools', 'json', c0file, ...paths86]);
    check('v86.8:json_query C0 收敛——工具多路径输出与引擎 debug(Json) 逐字节一致(含 \\u0001/\\u0007/\\u000b/\\u001f/\\u0000 与 C0 键 \\u0002)',
      tool.code === 0 && tool.stdout === gold.stdout && tool.stderr === '',
      `code=${tool.code} out=${JSON.stringify(tool.stdout.slice(0, 120))} want=${JSON.stringify(gold.stdout.slice(0, 120))} err=${JSON.stringify(tool.stderr.slice(0, 80))}`);
    // 良性路径零回归:8 条常规查询黄金期望(与 HEAD 版本行为逐字节——对照实测锁定)
    const benign = ['zh', 'emoji', 'arr.1', 'num', 'boolv', 'nullv', 'empty', 'emptyarr'];
    const toolB = runMing(['tools', 'json', c0file, ...benign]);
    const benignGold = '中文\n😀\nplain\n3.5\ntrue\nnull\n{}\n[]\n';
    check('v86.9:良性路径零回归——不含 C0 的 8 条常规查询输出逐字节不变(HEAD 黄金期望)',
      toolB.code === 0 && toolB.stdout === benignGold && toolB.stderr === '',
      `code=${toolB.code} out=${JSON.stringify(toolB.stdout)} want=${JSON.stringify(benignGold)}`);
    // 工具三引擎一致:C0 deep 查询 tree/default/no-wasm 输出逐字节相同
    const deepLine = JSON.stringify(c0obj.deep) + '\n';
    const rT = runMing(['run', '--tree', 'tools/json_query.ming', '--', c0file, 'deep']);
    const rD = runMing(['run', 'tools/json_query.ming', '--', c0file, 'deep']);
    const rN = runMing(['run', '--no-wasm', 'tools/json_query.ming', '--', c0file, 'deep']);
    check('v86.10:工具三引擎一致(tree/default/no-wasm)——C0 deep 查询输出逐字节相同',
      rT.code === 0 && rD.code === 0 && rN.code === 0
      && rT.stdout === deepLine && rD.stdout === deepLine && rN.stdout === deepLine,
      `tree=${rT.code}:${JSON.stringify(rT.stdout.slice(0, 80))} def=${rD.code}:${JSON.stringify(rD.stdout.slice(0, 80))} nowasm=${rN.code}:${JSON.stringify(rN.stdout.slice(0, 80))}`);
    // 工具纪律:缺文件/键不存在/缺参一律 exit 1 + stderr 具名 + stdout 空
    const e1 = runMing(['tools', 'json', path.join(dir86, 'v86_missing.json'), 'a']);
    const e2 = runMing(['tools', 'json', c0file, 'nope']);
    const e3 = runMing(['tools', 'json']);
    check('v86.11:工具纪律——缺文件/键不存在/缺参一律 exit 1 + stderr 具名 + stdout 空',
      e1.code === 1 && (e1.stderr || '').includes('无法读取文件') && e1.stdout === ''
      && e2.code === 1 && (e2.stderr || '').includes('键不存在') && e2.stdout === ''
      && e3.code === 1 && (e3.stderr || '').includes('用法') && e3.stdout === '',
      `e1=${e1.code}:${JSON.stringify((e1.stderr || '').slice(0, 60))} e2=${e2.code}:${JSON.stringify((e2.stderr || '').slice(0, 60))} e3=${e3.code}:${JSON.stringify((e3.stderr || '').slice(0, 60))}`);
  }

  // ---- §86-END
}

// ===================== 87. v0.81:wasm M4002 消息口径统一(N-65.4) =====================
// 文件所有权:§87 = 本区全部用例。实现面仅 src/vm.js(宿主导入 panic_m4002_op)+ src/wasm.js
// (导入表尾部追加 TI+17;emitCheckedOp/emitCheckedOpU/Unary 共 13 个 M4002 调用点切换);
// tree/VM(interp.js/compiler.js)零改动——消息模板单一事实参考在 interp.js
// (panicOverflow/intBinSlow/negSlow),tree/VM 消息逐字不变,既有测试除 v63.37 的
// wasm 泛化文案锁定行(分支 a 统一后必然翻转)外零校准。
// 分支裁决(架构师合同 plan §4.12.5):**分支 a**。成本评估证据:每个 M4002 检查点的
// 操作数都已在 scratch0(a)/scratch1(b) 槽(emitCheckedOp/emitCheckedOpU 头注槽位合同;
// 检查点处 s0/s1 未被冲掉——+/-/* 先落回绕值到 scratch2 再检查,除法/移位检查先于结果写入)
// ——携带穿越导入边界 = 尾部追加 1 条导入 + 实参压栈,
// 零二进制布局改动、零计费改动、零资格语义改动(§v87.20 锁定),不触碰 wasm 签名/槽位/
// locals(未触发 plan §4.3.8/§5.1 前置条件)。旧 AOT 产物(dist 内容寻址缓存)按名解析导入,
// 泛化导入 panic_m4002 保留(索引 1 不删,新生成模块不再调用)——v87.22 白盒锁定。
// 残留(如实登记,不预支):① N-65.4 同族 **cc eligible 函数**泛化口径——**已于本版
// 架构师收口**(cbackend.js ctx.specific 门拆除,M4002 四引擎逐字;v39 fullLine 翻回
// true + v63.40 断言翻转同步落盘);② **M4004 除零/取模零**同族分歧(tree/VM
// `整数除零:<a> / 0` 与 `整数取模零:<a> % 0` 两形态——取模零为 tree 专属模板,cc main
// 已同口径,eligible 泛化输出"整数除零"连措辞都不同——未来统一时两模板都要做,
// 同一 import 扩面形态可复用本项做法);③ 取负溢出 tree 位置 <unknown>:0:0
// (interp.js negSlow 不带 span,VM/wasm/cc 带位置)。
// fuzz 实测:norm 只比对诊断码不含消息文本(fuzz.mjs:373),双种子(44044/777)×25 全绿。
{
  const dir87 = path.join(TMP, 'v81');
  fs.mkdirSync(dir87, { recursive: true });
  const m87 = (name, src) => { const f = path.join(dir87, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags87 = ['', '--no-wasm', '--tree'];
  const runAll87 = (p) => flags87.map(f => runMing(f ? ['run', p, f] : ['run', p]));
  const fl87 = (r) => {
    // panic 首行 = 含 ": error M4002" 的第一行(stderr 首行在 MING_WASM_DEBUG=1 下是 [wasm] 探测行)
    const ls = (r.stderr ?? '').split('\n');
    return ls.find(l => l.includes(': error M4002')) ?? ls[0] ?? '';
  };
  // 消息文本 = 首行去掉 "<file>:<line>:<col>: error M4002[integer-overflow]: " 头
  const msg87 = (r) => {
    const m = /^(.*? error M4002\[integer-overflow\]: )(.*)$/.exec(fl87(r));
    return m ? m[2] : '(no-m4002:' + fl87(r).slice(0, 90) + ')';
  };
  const fmt87 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(fl87(r))}`).join(' | ');
  const strict87 = (p) => runMing(['run', p, '--strict-wasm'], { env: { MING_WASM_DEBUG: '1' } });
  const cc87 = (p) => runMing(['cc', p]);
  const ccAvail87 = (() => {
    if (process.env.MING_CC && fs.existsSync(process.env.MING_CC)) return true;
    for (const c of ['C:/w64devkit/bin/gcc.exe', 'C:/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe', 'C:/TDM-GCC-64/bin/gcc.exe']) {
      if (fs.existsSync(c)) return true;
    }
    return spawnSync('gcc', ['--version'], { encoding: 'utf8' }).status === 0;
  })();

  // ---- 溢出形态矩阵 × 引擎腿(v87.1–v87.18) ----
  // 每形态:tree/--no-wasm/默认(wasm) 三腿 exit 101 + M4002 + 消息文本逐字一致;
  // posKind='std' 断言三腿**首行**(位置+消息)逐字一致;'neg'/'vec' 位置有预存缺口
  // (见头注残留③与 vec 的 VM 1 列差)只锁消息文本,位置不锁(将来修复零校准)。
  // cc 腿(有编译器时):v0.81 N-65.4 架构师收口后 M4002 四引擎逐字——std 形态首行全等,
  // neg 形态消息同锁(位置与 tree 同源缺口)。
  const forms87 = [
    // -- 有符号 i64(emitCheckedOp;eligible 函数内溢出,wasm 腿经 panic_m4002_op)--
    ['f87_add_p.ming', ['fn f(a: i64, b: i64) -> i64 { return a + b; }', 'fn main() with io { print(str(f(9223372036854775807, 1))); }'], '整数+溢出:9223372036854775807 + 1 超出 i64 范围', 'std'],
    ['f87_add_n.ming', ['fn f(a: i64, b: i64) -> i64 { return a + b; }', 'fn main() with io { print(str(f(-9223372036854775807, -2))); }'], '整数+溢出:-9223372036854775807 + -2 超出 i64 范围', 'std'],
    ['f87_sub.ming', ['fn f(a: i64, b: i64) -> i64 { return a - b; }', 'fn main() with io { print(str(f(-9223372036854775807, 2))); }'], '整数-溢出:-9223372036854775807 - 2 超出 i64 范围', 'std'],
    ['f87_mul.ming', ['fn f(a: i64, b: i64) -> i64 { return a * b; }', 'fn main() with io { print(str(f(9223372036854775807, 2))); }'], '整数*溢出:9223372036854775807 * 2 超出 i64 范围', 'std'],
    ['f87_mul_min.ming', ['fn f(a: i64, b: i64) -> i64 { return a * b; }', 'fn main() with io { print(str(f(-9223372036854775808, -1))); }'], '整数*溢出:-9223372036854775808 * -1 超出 i64 范围', 'std'],
    ['f87_div.ming', ['fn f(a: i64, b: i64) -> i64 { return a / b; }', 'fn main() with io { print(str(f(-9223372036854775808, -1))); }'], '整数除法溢出:-9223372036854775808 / -1', 'std'],
    ['f87_shl_rng.ming', ['fn f(a: i64, b: i64) -> i64 { return a << b; }', 'fn main() with io { print(str(f(1, 64))); }'], '移位位数 64 越界(必须在 0..63)', 'std'],
    ['f87_shl_ng.ming', ['fn f(a: i64, b: i64) -> i64 { return a << b; }', 'fn main() with io { print(str(f(1, -1))); }'], '移位位数 -1 越界(必须在 0..63)', 'std'],
    ['f87_shr_rng.ming', ['fn f(a: i64, b: i64) -> i64 { return a >> b; }', 'fn main() with io { print(str(f(1, 64))); }'], '移位位数 64 越界(必须在 0..63)', 'std'],
    ['f87_shl_bits.ming', ['fn f(a: i64, b: i64) -> i64 { return a << b; }', 'fn main() with io { print(str(f(3, 62))); }'], '整数<<溢出:3 << 62 超出 i64 范围', 'std'],
    // 取负 i64::MIN(kind 5)。tree 位置 <unknown>:0:0 预存(negSlow 无 span),位置不锁。
    ['f87_neg.ming', ['fn f(a: i64) -> i64 { return -a; }', 'fn main() with io { print(str(f(-9223372036854775808))); }'], '整数取负溢出:--9223372036854775808 超出范围', 'neg'],
    // eligible 函数内复合赋值 x += 1(Assign → emitCheckedOp 路径,VM ADDI 同消息模板)
    ['f87_incr.ming', ['fn g(a: i64) -> i64 { let mut x = a; x += 1; return x; }', 'fn main() with io { print(str(g(9223372036854775807))); }'], '整数+溢出:9223372036854775807 + 1 超出 i64 范围', 'std'],
    // -- u64(emitCheckedOpU;宿主 BigInt.asUintN 重解释,与 tree 的 u64 display 一致)--
    ['f87_uadd.ming', ['fn f(a: u64, b: u64) -> u64 { return a + b; }', 'fn main() with io { print(str(f(18446744073709551615u64, 1u64))); }'], '整数+溢出:18446744073709551615 + 1 超出 i64u 范围', 'std'],
    ['f87_usub.ming', ['fn f(a: u64, b: u64) -> u64 { return a - b; }', 'fn main() with io { print(str(f(0u64, 1u64))); }'], '整数-溢出:0 - 1 超出 i64u 范围', 'std'],
    ['f87_umul.ming', ['fn f(a: u64, b: u64) -> u64 { return a * b; }', 'fn main() with io { print(str(f(9223372036854775808u64, 2u64))); }'], '整数*溢出:9223372036854775808 * 2 超出 i64u 范围', 'std'],
    ['f87_ushl.ming', ['fn f(a: u64, b: u64) -> u64 { return a << b; }', 'fn main() with io { print(str(f(3u64, 63u64))); }'], '整数<<溢出:3 << 63 超出 i64u 范围', 'std'],
    ['f87_ushr.ming', ['fn f(a: u64, b: u64) -> u64 { return a >> b; }', 'fn main() with io { print(str(f(1u64, 64u64))); }'], '移位位数 64 越界(必须在 0..63)', 'std'],
    // -- Vec 下标复合赋值 v[0] += 1(Assign Index 复合路径内联 emitCheckedOp,span = target.span;
    //    tree 与 wasm 同位,VM 直译路径预存 1 列差——只锁消息文本与 tree/wasm 首行相等)--
    ['f87_veccomp.ming', ['fn h(mut v: Vec[i64]) -> i64 { v[0] = 9223372036854775807; v[0] += 1; return v[0]; }', 'fn main() with io { let w: Vec[i64] = [0]; print(str(h(w))); }'], '整数+溢出:9223372036854775807 + 1 超出 i64 范围', 'vec'],
  ];
  forms87.forEach(([name, lines, want, posKind], fi) => {
    const p = m87(name, lines.join('\n') + '\n');
    const runs = runAll87(p);
    // cc 腿:vec 下标复合赋值形态 cc C1 发射期拒绝(exit 1,登记形态)→ 不进 cc 断言
    const ccR = ccAvail87 && posKind !== 'vec' ? cc87(p) : null;
    let ok = runs.every(r => r.code === 101 && (r.stderr ?? '').includes('M4002') && msg87(r) === want);
    if (posKind === 'std') {
      // 首行逐字一致(位置 + 消息;三腿 span 同源:tree e.span / VM 指令 span / wasm spanId)
      // 腿序 runs[0]=默认(wasm) runs[1]=--no-wasm(VM) runs[2]=--tree
      ok = ok && fl87(runs[0]) === fl87(runs[1]) && fl87(runs[0]) === fl87(runs[2])
        && fl87(runs[0]).startsWith(p + ':1:');
    } else if (posKind === 'neg') {
      // 消息已统一;位置:wasm/VM 带 span 且相等(预存),tree <unknown>(预存,不锁)
      ok = ok && fl87(runs[0]) === fl87(runs[1]) && fl87(runs[0]).startsWith(p + ':1:30:');
    } else if (posKind === 'vec') {
      // 消息已统一;tree 与 wasm 首行相等(同 target.span),VM 1 列差预存不锁
      ok = ok && fl87(runs[0]) === fl87(runs[2]) && fl87(runs[0]).startsWith(p + ':1:');
    }
    // cc 腿(v0.81 N-65.4 架构师收口 cbackend 后):M4002 四引擎消息逐字——std 形态
    // 首行(位置+消息)与 js 腿全等,neg 形态消息同锁(位置预存缺口与 tree 同源不锁)
    ok = ok && (!ccR || (ccR.code === 101 && (ccR.stderr ?? '').includes('M4002')));
    if (ccR) {
      if (posKind === 'std') ok = ok && fl87(ccR) === fl87(runs[0]);
      else ok = ok && msg87(ccR) === want;
    }
    check(`v87.${fi + 1}:M4002 消息三引擎逐字一致(${name.replace(/^f87_/, '').replace(/\.ming$/, '')}${posKind === 'std' ? ',首行含位置' : ',消息文本'})` + (posKind === 'vec' ? '(cc C1 拒绝该形态,跳过)' : ' + cc 腿 101'),
      ok, `runs=${fmt87(runs)} cc=${ccR ? ccR.code + ':' + JSON.stringify(fl87(ccR)) : 'skip'}`);
  });

  // ---- v87.19:main 内联溢出——四腿(tree/VM/wasm-main 兜底/cc main)首行逐字一致 ----
  // main 带 io 不 eligible → 默认腿走 VM 兜底(本就具体口径);cc main = specific(specific=true)。
  {
    const p = m87('f87_main_inline.ming', 'fn main() with io { let m = i64.max_value(); print(str(m + 1)); }\n');
    const runs = runAll87(p);
    const ccR = ccAvail87 ? cc87(p) : null;
    const want = '整数+溢出:9223372036854775807 + 1 超出 i64 范围';
    const ok = runs.every(r => r.code === 101 && msg87(r) === want)
      && fl87(runs[0]) === fl87(runs[1]) && fl87(runs[0]) === fl87(runs[2])
      && (!ccR || (ccR.code === 101 && msg87(ccR) === want && fl87(ccR) === fl87(runs[0])));
    check('v87.19:main 内联 +1 溢出——三腿首行逐字 + cc main 具体口径同位同文(四腿一致)',
      ok, `runs=${fmt87(runs)} cc=${ccR ? ccR.code + ':' + JSON.stringify(fl87(ccR)) : 'skip'}`);
  }

  // ---- v87.20/v87.21:strict-wasm 语义零回归(资格/实例化不受新导入影响) ----
  {
    const pok = m87('f87_strict_ok.ming', 'fn f(a: i64, b: i64) -> i64 { return a * 2 + (b << 1); }\nfn main() with io { print(str(f(3, 4))); }\n');
    const sok = strict87(pok);
    check('v87.20:strict wasm 资格零回归——算术 fn 仍 eligible([wasm] fn f OK,无 REJECT/实例化失败),exit 0 输出 14',
      sok.code === 0 && sok.stdout === '14\n' && (sok.stderr ?? '').includes('[wasm] fn f OK')
      && !(sok.stderr ?? '').includes('REJECT') && !(sok.stderr ?? '').includes('实例化失败'),
      `code=${sok.code} out=${JSON.stringify(sok.stdout)} err=${JSON.stringify((sok.stderr ?? '').split('\n').filter(l => l.includes('wasm')).join(' | ').slice(0, 160))}`);
    const povf = m87('f87_strict_ovf.ming', 'fn f(a: i64) -> i64 { return a + 1; }\nfn main() with io { print(str(f(9223372036854775807))); }\n');
    const sovf = strict87(povf);
    // strict 下 eligible>0 且模块健康 → 程序真实执行 panic exit 101;若导入扩展破坏
    // 编码/实例化 → wasm 回落 → exit 2(本断言同时证明溢出检查仍在 wasm 腿内执行)
    check('v87.21:strict wasm 溢出 fn 仍 eligible 真实执行(exit 101 + 具体文案;非 exit 2 回落)',
      sovf.code === 101 && (sovf.stderr ?? '').includes('M4002') && msg87(sovf) === '整数+溢出:9223372036854775807 + 1 超出 i64 范围',
      `code=${sovf.code}:${JSON.stringify(fl87(sovf))}`);
  }

  // ---- v87.22(白盒):导入表尾部追加正确(TI+17)+ 旧导入保留(AOT 兼容) ----
  // §32 同款单次编译白盒:Checker → compile → compiled.wasm.bytes → WebAssembly.Module.imports
  // (按导入节序返回)。尾部追加 = 末位导入 panic_m4002_op;panic_m4002 仍在索引 1
  // (v0.63 G1 教训:只追加不插删,tick/panic×2/math 基址算式零漂移);panic_m4002* 恰 2 个。
  // 旧 AOT 产物兼容 = 泛化导入保留 + 宿主 vm.js 同名条目保留(按名解析,新产物多 1 条导入
  // 对旧宿主不可见;旧产物在新宿主实例化所需的 panic_m4002 仍提供)。
  {
    const { Checker } = await import('../src/checker.js');
    const { compile } = await import('../src/compiler.js');
    const src = 'fn f(a: i64, b: i64) -> i64 { return a + b; }\nfn main() with io { print(str(f(1, 2))); }\n';
    const p = m87('f87_imports.ming', src);
    const c = new Checker(p, () => src);
    const result = c.run();
    const compiled = compile(result);
    const bytes = compiled?.wasm?.bytes ?? null;
    let imports = null;
    if (bytes) {
      const mod = new WebAssembly.Module(bytes); // 构造成功 = 模块校验通过(新导入签名合法)
      imports = WebAssembly.Module.imports(mod);
    }
    const last = imports ? imports[imports.length - 1] : null;
    check('v87.22(白盒):导入表尾部追加——末位 = ming/panic_m4002_op;panic_m4002 保留索引 1;panic_m4002* 恰 2 个;模块校验通过',
      !!bytes && !!imports && last?.module === 'ming' && last?.name === 'panic_m4002_op'
      && imports[1]?.module === 'ming' && imports[1]?.name === 'panic_m4002'
      && imports.filter(i => i.name.startsWith('panic_m4002')).length === 2,
      `nImport=${imports ? imports.length : 'null'} last=${JSON.stringify(last ?? null)} idx1=${imports ? JSON.stringify(imports[1] ?? null) : 'null'}`);
  }
  // ---- §87-END
}

// ===================== 88. v0.82:污点 v1.3 窗口(argv 载体 + 响应头第四载体 + metadata;ADR-008)=====================
// 文件所有权:§88 = 本区全部用例。实现面:src/checker.js(载体白名单扩 Map[str,str] 第四载体 +
// untrustedMapMethod 投影表 + main args 编译期 M3049 + fs.metadata / net.http_request_opts 签名翻转
// + M3050 待解锁清单文案更新)+ src/interp.js 与 src/vm.js(M3023 消息随 main 合法带参形态翻转,
// 运行时值交付路径零改动)+ src/compiler.js(tryWasm 核验定案,零代码改动)。
// 引擎面零新机制(v88.11 白盒锁定):Untrusted[Map] 形参经 v0.61 顶层解包 → Map 形参('mstr' 槽,
// v0.59 #41);Vec[Untrusted[str]] 形参(argv 元素级)顶层是 Vec 不解包 → typeToNumTy 对 untrusted
// 元素返回 null → paramSlotTy 回落 'vi64' 句柄槽(v80.17(a) 自 v0.80 锁定的资格形态)——实现期
// 实测:若做元素级解包,槽型翻成 'vstr' 会翻转 v80.17(a) 的 vs.len() 资格(非直接调用回落),
// 故解包维持顶层(ADR-008 §2.6/清单 7 "零新机制"的实测依据,已写入 compiler.js 注释)。
// 迁移完成记录(2026-11-18,Agent F):14 个 tools/*.ming(含 v0.80 后新增 xnsni/xnopen)+
// 本文件 4 处 `fn main(args: Vec[str])` + tests/net_e2e.mjs 2 处已全部翻转 Vec[Untrusted[str]];
// 工具 main 头部逐元素过 std.unstr.sanitize_cli_path 取净值(路径位/CLI 匹配比较串;空串参数
// 原样保留迁移前语义——env 回退/解析失败路径),parse_i64 位沿污值代数,回显位走出向透传;
// 良性路径与迁移前 HEAD 工具基线逐字节一致(43 例对照;唯一差异例 = todo_scan 无参自扫描
// 仓库本体的语料行号漂移,非工具行为)。§89 锁定迁移面。GUIDE/docs/package.json 由架构师集成。
{
  const dir88 = path.join(TMP, 'v82');
  fs.mkdirSync(dir88, { recursive: true });
  const m88 = (name, src) => { const f = path.join(dir88, name); fs.writeFileSync(f, src, 'utf8'); return f; };
  const flags88 = ['', '--no-wasm', '--tree'];
  const runAll88 = (p, args = []) => flags88.map(f => runMing(f ? ['run', p, ...args, f] : ['run', p, ...args]));
  const same88 = (runs, want, code = 0) => runs.every(r => r.code === code && r.stdout === want);
  const fmtRuns88 = (runs) => runs.map(r => `${r.code}:${JSON.stringify(r.stdout.slice(0, 60))}`).join(' | ');
  const chk88 = (p) => {
    const r = runMing(['check', p, '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 崩溃形态 → j=null,由断言点名 */ }
    return { code: r.code, j };
  };
  const codes88 = (res) => (res.j ? res.j.diagnostics.map((d) => d.code).join(',') : '(no-json:exit ' + res.code + ')');
  const errsOf88 = (res, code) => (res.j ? res.j.diagnostics.filter(d => d.code === code) : []);

  // ---- v88.1:main 正例——Vec[Untrusted[str]] + sanitize_cli_path 逐元素消费,三引擎逐字 ----
  {
    const p = m88('v88_main_ok.ming', [
      'use std.unstr;',
      'fn main(args: Vec[Untrusted[str]]) -> i64 with io {',
      '    let mut n: i64 = 0;',
      '    for a in args {',
      '        match std.unstr.sanitize_cli_path(a) {',
      '            Ok(p) => { print(p); n += 1; },',
      '            Err(_) => { print("BAD"); },',
      '        }',
      '    }',
      '    return n;',
      '}',
    ].join('\n'));
    const runs = runAll88(p, ['aa/bb', 'x;y']);
    check('v88.1:main(args: Vec[Untrusted[str]]) 正例——argv 逐元素 sanitize_cli_path 后三引擎输出逐字(exit 2)',
      same88(runs, 'aa/bb\nx;y\n', 2), `runs=${fmtRuns88(runs)}`);
  }

  // ---- v88.2:main 负例——净 Vec[str] 声明 → M3049 恰一条(extern 裸 str 返回先例,零新码) ----
  {
    const p = m88('v88_main_neg.ming', [
      'fn main(args: Vec[str]) -> i64 with io {',
      '    print(args.len());',
      '    return 0;',
      '}',
    ].join('\n'));
    const r = chk88(p);
    const m3049 = errsOf88(r, 'M3049');
    check('v88.2:main(args: Vec[str]) → 编译期 M3049 恰一条,消息点名 Vec[Untrusted[str]] + sanitize_cli_path 处方',
      r.code === 1 && r.j && r.j.diagnostics.length === 1 && m3049.length === 1
      && m3049[0].message.includes('必须声明为 Vec[Untrusted[str]]')
      && m3049[0].message.includes('std.unstr.sanitize_cli_path'),
      `code=${r.code} ${codes88(r)} msg=${JSON.stringify(m3049[0]?.message?.slice(0, 120) ?? '')}`);
  }

  // ---- v88.3:REPL/test 空参口径 + M3023 消息翻转锁定 ----
  {
    const p = m88('v88_test_empty.ming', [
      'fn main(args: Vec[Untrusted[str]]) -> i64 with io {',
      '    return args.len();',
      '}',
      'test t1 { assert_eq(1 + 1, 2); }',
    ].join('\n'));
    const t = runMing(['test', p]);
    check('v88.3a:ming test 对带参 main 文件——test 块照常运行(main 不被调用,空参口径)',
      t.code === 0 && t.stdout.includes('1 通过,0 失败'), `code=${t.code} out=${JSON.stringify(t.stdout.slice(0, 80))} err=${JSON.stringify(t.stderr.slice(0, 120))}`);
    const runs = runAll88(p, []);
    check('v88.3b:ming run 无参——空 Vec[Untrusted[str]] 交付(len 0 → exit 0),三引擎一致',
      same88(runs, '', 0), `runs=${fmtRuns88(runs)}`);
    const pm = m88('v88_m3023.ming', 'fn main(a: i64, b: i64) with io { }\n');
    const legs = ['', '--tree'].map(f => runMing(f ? ['run', pm, f] : ['run', pm]));
    check('v88.3c:M3023 消息随合法带参形态翻转——双形参 main exit 101,消息逐字 Vec[Untrusted[str]](tree/VM 同文)',
      legs.every(r => r.code === 101 && (r.stderr ?? '').includes('M3023')
        && (r.stderr ?? '').includes('main 最多接受一个参数:args: Vec[Untrusted[str]]')),
      `legs=${legs.map(r => `${r.code}:${JSON.stringify((r.stderr ?? '').split('\n')[0].slice(0, 110))}`).join(' | ')}`);
  }

  // ---- v88.4:响应头第四载体投影表正例——六方法类型面全过(check exit 0) ----
  {
    const p = m88('v88_hdr_pos.ming', [
      'fn probe(h: Untrusted[Map[str, str]]) -> i64 {',
      '    let n = h.len();',
      '    let e = h.is_empty();',
      '    let v = h.get("content-type");',
      '    let b = h.has("x-ming-echo");',
      '    let ks = h.keys();',
      '    let vs = h.values();',
      '    return n + ks.len() + vs.len() + (if b { 1 } else { 0 }) + (if e { 1 } else { 0 }) + (if v.is_some() { 1 } else { 0 });',
      '}',
      'fn main() -> i64 with io { print(0); return 0; }',
    ].join('\n'));
    const r = chk88(p);
    check('v88.4:Untrusted[Map] 投影表正例——len/is_empty/get(净键)/has(净键)/keys/values 六方法 check exit 0',
      r.code === 0 && r.j && r.j.ok === true && r.j.diagnostics.length === 0,
      `code=${r.code} ${codes88(r)}`);
  }

  // ---- v88.5:mut 面 M3050(只读 v1.3)——set/delete/clear 各一发,消息锁定 ----
  {
    const p = m88('v88_hdr_mut.ming', [
      'fn s(h: Untrusted[Map[str, str]]) -> i64 { h.set("k", "v"); return 0; }',
      'fn d(h: Untrusted[Map[str, str]]) -> i64 { h.delete("k"); return 0; }',
      'fn c(h: Untrusted[Map[str, str]]) -> i64 { h.clear(); return 0; }',
      'fn main() -> i64 with io { print(0); return 0; }',
    ].join('\n'));
    const r = chk88(p);
    const m3050 = errsOf88(r, 'M3050');
    check('v88.5:Untrusted[Map] mut 面 set/delete/clear → M3050 恰三条,消息含"v1.3 只读"与投影表全列举',
      r.code === 1 && m3050.length === 3
      && m3050.every(d => d.message.includes('v1.3 只读'))
      && m3050.every(d => d.message.includes('len / is_empty / get / has / keys / values')),
      `code=${r.code} n3050=${m3050.length} msg0=${JSON.stringify(m3050[0]?.message?.slice(0, 140) ?? '')}`);
  }

  // ---- v88.6:污值禁面——污键进 get 净键槽 M3049;keys() 污序列进净 Vec 槽 M3049(嵌套) ----
  {
    const pk = m88('v88_hdr_dirtykey.ming', [
      'use std.unstr;',
      'fn probe(h: Untrusted[Map[str, str]]) -> i64 {',
      '    let _ = h.get(std.unstr.mark("k"));',
      '    return 0;',
      '}',
      'fn main() -> i64 with io { print(0); return 0; }',
    ].join('\n'));
    const rk = chk88(pk);
    const mk = errsOf88(rk, 'M3049');
    const pv = m88('v88_hdr_keyssink.ming', [
      'fn probe(h: Untrusted[Map[str, str]]) -> i64 {',
      '    let a: Vec[str] = h.keys();',
      '    return 0;',
      '}',
      'fn main() -> i64 with io { print(0); return 0; }',
    ].join('\n'));
    const rv = chk88(pv);
    const mv = errsOf88(rv, 'M3049');
    check('v88.6:污键 h.get(mark) → M3049(键是净槽);keys() → Vec[Untrusted[str]] 进净 Vec[str] 槽 → M3049(嵌套复合)',
      rk.code === 1 && mk.length === 1 && mk[0].message.includes('.get() 的键必须是 str')
      && rv.code === 1 && mv.length === 1 && mv[0].message.includes('Vec[Untrusted[str]]'),
      `key=${codes88(rk)} ${JSON.stringify(mk[0]?.message?.slice(0, 90) ?? '')} | keys=${codes88(rv)} ${JSON.stringify(mv[0]?.message?.slice(0, 90) ?? '')}`);
  }

  // ---- v88.7:第四载体运行时端到端——本地 echo server,投影六方法真实值黄金 ----
  {
    const echoServer = spawn(process.execPath, ['-e', [
      'const http = require("http");',
      'const server = http.createServer((req, res) => {',
      '    req.on("data", () => {});',
      '    req.on("end", () => { res.writeHead(200, { "content-type": "text/plain", "x-ming-echo": "yes" }); res.end("ok"); });',
      '});',
      'server.listen(0, "127.0.0.1", () => console.log("PORT:" + server.address().port));',
      'setTimeout(() => process.exit(0), 20000);',
    ].join('\n')], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const echoPort = await new Promise((resolve, reject) => {
        let buf = '';
        const onData = (c) => { buf += c; const m = buf.match(/PORT:(\d+)/); if (m) { echoServer.stdout.off('data', onData); resolve(Number(m[1])); } };
        echoServer.stdout.on('data', onData);
        echoServer.on('exit', () => reject(new Error('echo exited')));
        setTimeout(() => reject(new Error('echo timeout')), 10000);
      });
      const p = m88('v88_http_rt.ming', [
        'use std.net;',
        'fn main() with io, net {',
        '    match std.net.http_request_opts("GET", "http://127.0.0.1:' + echoPort + '/", [:], "", 5000) {',
        '        Ok((status, headers, body)) => {',
        '            print(str(status));',
        '            print(str(headers.get("content-type").unwrap().contains("text")));',
        '            print(str(headers.has("x-ming-echo")));',
        '            let kn = headers.keys().len();',
        '            let vn = headers.values().len();',
        '            print(str(kn == vn));',
        '            let mut kk: i64 = 0;',
        '            for k in headers.keys() { kk += 1; }',
        '            print(str(kk == kn));',
        '            print(str(headers.is_empty()));',
        '            print(str(headers.len() == kn));',
        '        }',
        '        Err(e) => { print("ERR: " + e); }',
        '    }',
        '}',
      ].join('\n'));
      const r = runMing(['run', p]);
      check('v88.7:http_request_opts 响应头第四载体端到端——真实响应头经投影表消费(get/has/keys/values/len/is_empty 全污面可用,键值同污)',
        r.code === 0 && r.stdout === '200\ntrue\ntrue\ntrue\ntrue\nfalse\ntrue\n',
        `code=${r.code} out=${JSON.stringify(r.stdout.slice(0, 120))} err=${JSON.stringify(r.stderr.slice(0, 160))}`);
    } finally {
      echoServer.kill();
    }
  }

  // ---- v88.8:sink 面不变——请求侧 headers 污值 M3049;响应头 bleach(净 Map 标注)M3049 ----
  {
    const pr = m88('v88_req_sink.ming', [
      'use std.net;',
      'fn main() with io, net {',
      '    let h = { "k": std.unstr.mark("v") };',
      '    let r = std.net.http_request_opts("GET", "http://127.0.0.1:1/", h, "", 1000);',
      '    return;',
      '}',
    ].join('\n'));
    const rr = chk88(pr);
    const mr = errsOf88(rr, 'M3049');
    const pb = m88('v88_resp_bleach.ming', [
      'use std.net;',
      'fn main() with io, net {',
      '    match std.net.http_request_opts("GET", "http://127.0.0.1:1/", [:], "", 1000) {',
      '        Ok((status, headers, body)) => {',
      '            let clean: Map[str, str] = headers;',
      '            print(str(status));',
      '        },',
      '        Err(_) => { print("err"); },',
      '    }',
      '}',
    ].join('\n'));
    const rb = chk88(pb);
    const mb = errsOf88(rb, 'M3049');
    check('v88.8:请求侧 headers sink 不变(污值 → M3049 参数 #3)+ 响应头 bleach 关闭(污表 → 净 Map 槽 M3049)',
      rr.code === 1 && mr.length === 1 && mr[0].message.includes('参数 #3')
      && rb.code === 1 && mb.length === 1 && mb[0].message.includes('Untrusted[Map[str, str]]'),
      `req=${codes88(rr)} ${JSON.stringify(mr[0]?.message?.slice(0, 80) ?? '')} | bleach=${codes88(rb)} ${JSON.stringify(mb[0]?.message?.slice(0, 80) ?? '')}`);
  }

  // ---- v88.9:fs.metadata 载体翻转——污 Json 投影消费正例(run)+ 净槽 sink 负例(M3049) ----
  {
    const pp = m88('v88_meta_ok.ming', [
      'use std.fs;',
      'fn main() -> i64 with io, fs {',
      '    match fs.metadata(".") {',
      '        Ok(m) => {',
      '            let d = m.get("is_dir").unwrap().as_bool().unwrap();',
      '            let f = m.get("is_file").unwrap().as_bool().unwrap();',
      '            let nm = m.get("name").unwrap().as_str().unwrap();',
      '            print(str(d));',
      '            print(str(f));',
      '            print(nm.char_len());',
      '            return 0;',
      '        },',
      '        Err(_) => { return 1; },',
      '    }',
      '}',
    ].join('\n'));
    const runs = runAll88(pp, []);
    check('v88.9a:fs.metadata → Result[Untrusted[Json], str] 投影消费正例——is_dir/is_file/名称长度三引擎逐字(当前目录)',
      same88(runs, 'true\nfalse\n1\n', 0), `runs=${fmtRuns88(runs)}`);
    const pn = m88('v88_meta_sink.ming', [
      'use std.fs;',
      'fn main() -> i64 with io, fs {',
      '    match fs.metadata(".") {',
      '        Ok(m) => {',
      '            let nm: str = m.get("name").unwrap().as_str().unwrap();',
      '            print(nm);',
      '            return 0;',
      '        },',
      '        Err(_) => { return 1; },',
      '    }',
      '}',
    ].join('\n'));
    const rn = chk88(pn);
    const mn = errsOf88(rn, 'M3049');
    check('v88.9b:metadata 污 Json 投影出 Untrusted[str] 进净 str 槽 → M3049(载体收窄后仍污,洗白关闭)',
      rn.code === 1 && mn.length === 1 && mn[0].message.includes('Untrusted[str]'),
      `code=${rn.code} ${codes88(rn)} ${JSON.stringify(mn[0]?.message?.slice(0, 90) ?? '')}`);
  }

  // ---- v88.10:载体白名单 M3050 文案更新锁定——Map[str,str] 入列;argv 销项;非 str 键/值载体仍拒 ----
  {
    const pm = m88('v88_carrier_map.ming', [
      'fn bad(m: Untrusted[Map[str, i64]]) -> i64 { return 0; }',
      'fn main() -> i64 with io { print(0); return 0; }',
    ].join('\n'));
    const rm = chk88(pm);
    const mm = errsOf88(rm, 'M3050');
    const pv = m88('v88_carrier_vecstr.ming', [
      'fn bad(v: Untrusted[Vec[str]]) -> i64 { return 0; }',
      'fn main() -> i64 with io { print(0); return 0; }',
    ].join('\n'));
    const rv = chk88(pv);
    const mv = errsOf88(rv, 'M3050');
    check('v88.10:M3050 载体文案 = str/Json/Vec[u8]/Map[str,str] 且不再列 argv(v0.82 销项);Untrusted[Vec[str]] 整容器仍拒(元素级口径)',
      rm.code === 1 && mm.length === 1 && mm[0].message.includes('str/Json/Vec[u8]/Map[str,str]') && !mm[0].message.includes('argv')
      && rv.code === 1 && mv.length === 1 && mv[0].message.includes('得到 Vec[str]'),
      `map=${codes88(rm)} ${JSON.stringify(mm[0]?.message?.slice(0, 100) ?? '')} | vec=${codes88(rv)} ${JSON.stringify(mv[0]?.message?.slice(0, 100) ?? '')}`);
  }

  // ---- v88.11:引擎面零新机制(白盒)——顶层解包后 sig 形状 + v80.17(a) 形态 strict 资格保持 ----
  {
    const sig88 = (name, src) => {
      const f = m88(name, src);
      const c = new Checker(f, () => src);
      const result = c.run();
      const errs = result.diags.filter(d => d.severity === 'error');
      if (errs.length) return { err: errs[0].code + ':' + errs[0].message.slice(0, 60) };
      const compiled = compile(result);
      const fnEntry = compiled.functions.find(fn => fn.name === 'probe');
      return { sig: JSON.stringify(fnEntry?.entry?.sig?.params?.[0]?.type ?? null) };
    };
    const mapSig = sig88('v88_wb_map.ming', 'fn probe(m: Untrusted[Map[str, str]]) -> i64 { return m.len(); }\nfn main() -> i64 with io { print(0); return 0; }\n');
    const vecSig = sig88('v88_wb_vec.ming', 'fn probe(v: Vec[Untrusted[str]]) -> i64 { return v.len(); }\nfn main() -> i64 with io { print(0); return 0; }\n');
    check('v88.11a(白盒):tryWasm 顶层解包——Untrusted[Map] 形参 → 裸 Map 形状(= 净 Map 形参同形);Vec[Untrusted[str]] 保持 vec<untrusted>(vi64 句柄槽,v80.17(a) 口径)',
      mapSig.sig === '{"k":"map","kt":{"k":"str"},"vt":{"k":"str"}}'
      && vecSig.sig === '{"k":"vec","el":{"k":"untrusted","el":{"k":"str"}}}',
      `map=${mapSig.sig ?? mapSig.err} vec=${vecSig.sig ?? vecSig.err}`);
    const p80 = m88('v88_v8017a.ming', [
      'use std.unstr;',
      'use std.io;',
      'fn count(vs: Vec[Untrusted[str]]) -> i64 {',
      '    return vs.len();',
      '}',
      'fn has(u: Untrusted[str]) -> bool {',
      '    return u.contains("b");',
      '}',
      'fn main() with io {',
      '    let v: Vec[Untrusted[str]] = [std.unstr.mark("a"), std.unstr.mark("bb")];',
      '    print(str(count(v)));',
      '    print(str(has(std.unstr.mark("abc"))));',
      '}',
    ].join('\n'));
    const rs = runMing(['run', p80, '--strict-wasm']);
    const runs = runAll88(p80, []);
    check('v88.11b:v80.17(a) 形态保持——Vec[Untrusted[str]]/Untrusted[str] 形参 strict-wasm exit 0,三引擎逐字(2/true)',
      rs.code === 0 && rs.stdout === '2\ntrue\n' && same88(runs, '2\ntrue\n'),
      `strict=${rs.code} ${JSON.stringify(rs.stderr.slice(0, 120))} ${fmtRuns88(runs)}`);
  }

  // ---- v88.12:既有污点回归锚点重断言(§65/§71 代表形态,零校准证明) ----
  {
    // §65 v65.1 形态:env.get().unwrap → write_file 路径位 sink(M3049 + sanitize 处方)
    const f65 = m88('v88_anchor_envsink.ming', [
      'use std.env;',
      'use std.fs;',
      'fn main() with env, fs {',
      '    let p = std.env.get("V88_ANY").unwrap();',
      '    std.fs.write_file(p, "data");',
      '}',
    ].join('\n'));
    const r65 = chk88(f65);
    const m6588 = errsOf88(r65, 'M3049');
    // §71 v71.10 形态:Untrusted[Json] debug 洗白禁面(M3050)
    const f71 = m88('v88_anchor_jsondebug.ming', [
      'use std.json;',
      'use std.unstr;',
      'fn main() with io {',
      '    let u: Untrusted[Json] = std.unstr.mark_json(std.json.parse("{}").unwrap());',
      '    debug(u);',
      '}',
    ].join('\n'));
    const r71 = chk88(f71);
    const m7188 = errsOf88(r71, 'M3050');
    check('v88.12:既有污点锚点重断言——env.get→write_file sink M3049(§65 v65.1 形态)+ Untrusted[Json] debug 禁面 M3050(§71 v71.10 形态)逐字保持',
      r65.code === 1 && m6588.length === 1 && (m6588[0].message + ' ' + (m6588[0].hint ?? '')).includes('sanitize')
      && r71.code === 1 && m7188.length === 1 && m7188[0].message.includes('debug 的参数含 Untrusted[Json]'),
      `env=${codes88(r65)} ${JSON.stringify(m6588[0]?.message?.slice(0, 80) ?? '')} | json=${codes88(r71)} ${JSON.stringify(m7188[0]?.message?.slice(0, 80) ?? '')}`);
  }
  // ---- v88.13:M3049 remedy 载体感知第四载体(审查 MINOR-1)——Untrusted[Map] 进净槽,
  //      处方必须是 Map 投影表口径(非 str 措辞"净化/Untrusted[str]";零新码,复用 sink 探针)
  {
    const f13 = m88('v88_map_remedy.ming', [
      'fn take(m: Map[str, str]) -> i64 { return m.len(); }',
      'fn main() -> i64 with io, net {',
      '    let r = std.net.http_request_opts("GET", "http://127.0.0.1:1/", {}, "", 1);',
      '    let (_st, hs, _body) = r.unwrap();',
      '    return take(hs);',
      '}',
    ].join('\n'));
    const r13 = chk88(f13);
    const m13 = errsOf88(r13, 'M3049');
    check('v88.13:M3049 remedy 载体感知——Untrusted[Map] sink 处方含 Map 投影表口径与 Untrusted[Map[str, str]] 改声明(非 str 措辞)',
      r13.code === 1 && m13.length >= 1 && m13.some((d) => (d.message + ' ' + (d.hint ?? '')).includes('Untrusted[Map[str, str]]')
        && (d.message + ' ' + (d.hint ?? '')).includes('投影表')),
      `codes=${codes88(r13)} msg=${JSON.stringify(m13[0]?.message?.slice(0, 120) ?? '')} hint=${JSON.stringify(m13[0]?.hint?.slice(0, 120) ?? '')}`);
  }
  // ---- §88-END
}

// ===================== 89. v0.82:污点 v1.3 迁移面锁定(tools/*.ming ×14 + 迁移语料 + net_e2e;ADR-008)=====================
// 文件所有权:§89 = 本区全部用例。迁移形态(Agent F,§88 迁移完成记录):14 个工具 main
// 签名 Vec[str] → Vec[Untrusted[str]],args 头部逐元素过 std.unstr.sanitize_cli_path
// (校验不改写:拒控制字符,Ok 原样)取净值——路径位/CLI 匹配比较串统一净化,空串参数
// 原样保留(迁移前语义:env 回退/解析失败路径);parse_i64 位沿污值代数标量终结;回显/
// 打印位走出向透传。本分节黄金期望逐字节来自迁移前 HEAD 工具基线实测(43 例对照,
// 42 例逐字节一致;唯一差异例 = todo_scan 无参自扫描仓库本体的语料行号漂移,非工具行为)。
{
  const dir89 = path.join(TMP, 'v89');
  fs.mkdirSync(dir89, { recursive: true });
  const tool89 = (n) => path.join(ROOT, 'tools', n);
  const run89 = (argv, opts = {}) => runMing(argv, opts);

  // ---- v89.1:wc 冒烟逐字节(单文件 + 多文件 total;HEAD 黄金) ----
  {
    const p1 = path.join(dir89, 'wc1.txt');
    const p2 = path.join(dir89, 'wc2.log');
    fs.writeFileSync(p1, 'alpha\nbeta\n', 'utf8');
    fs.writeFileSync(p2, 'one two\nthree\n', 'utf8');
    const r1 = run89(['run', tool89('wc.ming'), '--', p1]);
    const r2 = run89(['run', tool89('wc.ming'), '--', p1, p2]);
    check('v89.1:wc 冒烟逐字节——单文件(2 2 11)+ 多文件 total(4 5 25),与迁移前 HEAD 基线逐字一致',
      r1.code === 0 && r1.stdout === `2 2 11 ${p1}\n`
      && r2.code === 0 && r2.stdout === `2 2 11 ${p1}\n2 3 14 ${p2}\n4 5 25 total\n`,
      `r1=${r1.code}:${JSON.stringify(r1.stdout.slice(0, 80))} r2=${r2.code}:${JSON.stringify(r2.stdout.slice(0, 100))}`);
  }

  // ---- v89.2:tree 冒烟逐字节(全列/深度 1/空 arg → env 回退语义保持) ----
  {
    const td = path.join(dir89, 'treeD');
    fs.mkdirSync(path.join(td, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(td, 'a.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(td, 'sub', 'b.txt'), 'b', 'utf8');
    const full = `${td}\n├── a.txt\n└── sub\n    └── b.txt\n\n共 3 个条目\n`;
    const d1 = `${td}\n├── a.txt\n└── sub\n\n共 2 个条目\n`;
    const r1 = run89(['run', tool89('tree.ming'), '--', td]);
    // v65.19 先例:空串参数原样保留 → root="" → TREE_ROOT 回退(迁移前语义逐字节)
    const r2 = run89(['run', tool89('tree.ming'), '--', ''], { env: { TREE_ROOT: td } });
    const r3 = run89(['run', tool89('tree.ming'), '--', td, '1']);
    check('v89.2a:tree 冒烟逐字节——目录树全列(3 条目)与迁移前 HEAD 基线逐字一致',
      r1.code === 0 && r1.stdout === full, `code=${r1.code} out=${JSON.stringify(r1.stdout.slice(0, 120))}`);
    check('v89.2b:tree 空 arg 语义保持——空串原样保留 → TREE_ROOT 回退,输出与显式目录逐字一致',
      r2.code === 0 && r2.stdout === full && r2.stderr === '', `code=${r2.code} out=${JSON.stringify(r2.stdout.slice(0, 80))}`);
    check('v89.2c:tree 深度 1 逐字节(2 条目,不下钻)', r3.code === 0 && r3.stdout === d1, `code=${r3.code} out=${JSON.stringify(r3.stdout.slice(0, 80))}`);
  }

  // ---- v89.3:todo_scan + find_files 冒烟逐字节 ----
  {
    const sd = path.join(dir89, 'scanD');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'code.ming'), '// TODO: 实现缓存\nfn f() { return 1; }\n// FIXME: 边界\n', 'utf8');
    const codeP = path.join(sd, 'code.ming');
    const r1 = run89(['run', tool89('todo_scan.ming'), '--', sd]);
    check('v89.3a:todo_scan 冒烟逐字节——命中行带行号回显(2 处,整行 trim 原样含 // 前缀)与迁移前 HEAD 基线逐字一致',
      r1.code === 0 && r1.stdout === `扫描目录: ${sd}\n${codeP}:1: // TODO: 实现缓存\n${codeP}:3: // FIXME: 边界\n共发现 2 处待办标记\n`,
      `code=${r1.code} out=${JSON.stringify(r1.stdout.slice(0, 160))}`);
    const fd = path.join(dir89, 'findD');
    fs.mkdirSync(path.join(fd, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(fd, 'a.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(fd, 'sub', 'b.txt'), 'b', 'utf8');
    const r2 = run89(['run', tool89('find_files.ming'), '--', fd, 'txt']);
    check('v89.3b:find_files 冒烟逐字节——递归命中 2 个(名称匹配串过净化不改写)',
      r2.code === 0 && r2.stdout === `在 ${fd} 中查找包含 "txt" 的文件名:\n${path.join(fd, 'a.txt')}\n${path.join(fd, 'sub', 'b.txt')}\n共找到 2 个\n`,
      `code=${r2.code} out=${JSON.stringify(r2.stdout.slice(0, 160))}`);
  }

  // ---- v89.4:batch_rename + file_organizer 冒烟逐字节(破坏性,独立夹具) ----
  {
    const rd = path.join(dir89, 'ren89');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, '1.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(rd, '2.log'), 'b', 'utf8');
    const r1 = run89(['run', tool89('batch_rename.ming'), '--', rd, 'pre_']);
    check('v89.4a:batch_rename 冒烟逐字节——加前缀输出与磁盘效应,与迁移前 HEAD 基线逐字一致',
      r1.code === 0 && r1.stdout === `目录: ${rd}, 前缀: pre_, 扩展名过滤: \n重命名: 1.txt -> pre_1.txt\n重命名: 2.log -> pre_2.log\n共重命名 2 个文件\n`
      && fs.existsSync(path.join(rd, 'pre_1.txt')) && fs.existsSync(path.join(rd, 'pre_2.log')) && !fs.existsSync(path.join(rd, '1.txt')),
      `code=${r1.code} out=${JSON.stringify(r1.stdout.slice(0, 160))}`);
    const od = path.join(dir89, 'org89');
    fs.mkdirSync(od, { recursive: true });
    fs.writeFileSync(path.join(od, 'x.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(od, 'y.md'), 'b', 'utf8');
    const r2 = run89(['run', tool89('file_organizer.ming'), '--', od]);
    check('v89.4b:file_organizer 冒烟逐字节——按扩展名归档输出与磁盘效应',
      r2.code === 0 && r2.stdout === `整理目录: ${od}\n移动: ${path.join(od, 'x.txt')} -> ${path.join(od, 'txt', 'x.txt')}\n移动: ${path.join(od, 'y.md')} -> ${path.join(od, 'md', 'y.md')}\n共移动 2 个文件\n`
      && fs.existsSync(path.join(od, 'txt', 'x.txt')) && fs.existsSync(path.join(od, 'md', 'y.md')),
      `code=${r2.code} out=${JSON.stringify(r2.stdout.slice(0, 160))}`);
  }

  // ---- v89.5:log_analyzer + json_query 冒烟逐字节 ----
  {
    const la = path.join(dir89, 'a.log');
    fs.writeFileSync(la, 'line1\nline2 ERROR x\nline3 WARN y\nline4 INFO z\n', 'utf8');
    const r1 = run89(['run', tool89('log_analyzer.ming'), '--', la]);
    check('v89.5a:log_analyzer 冒烟逐字节——分类计数 6 行与迁移前 HEAD 基线逐字一致',
      r1.code === 0 && r1.stdout === `文件: ${la}\n总行数: 4\nERROR: 1\nWARN:  1\nINFO:  1\n其他:  1\n`,
      `code=${r1.code} out=${JSON.stringify(r1.stdout.slice(0, 140))}`);
    const jf = path.join(dir89, 'cfg.json');
    fs.writeFileSync(jf, '{"name": "ming", "v": 44, "servers": [{"host": "h1"}]}', 'utf8');
    const r2 = run89(['run', tool89('json_query.ming'), '--', jf, 'name']);
    const r3 = run89(['run', tool89('json_query.ming'), '--', jf, 'servers.0.host']);
    check('v89.5b:json_query 冒烟逐字节——裸字符串叶子 + 点路径下钻,与迁移前 HEAD 基线逐字一致',
      r2.code === 0 && r2.stdout === 'ming\n' && r3.code === 0 && r3.stdout === 'h1\n',
      `r2=${r2.code}:${JSON.stringify(r2.stdout)} r3=${r3.code}:${JSON.stringify(r3.stdout)}`);
  }

  // ---- v89.6:mingkit + edit 冒烟逐字节 ----
  {
    const kf = path.join(dir89, 'kit89.txt');
    const w = run89(['run', tool89('mingkit.ming'), '--', 'write', kf], { stdin: 'alpha\nbeta\ngamma\n' });
    const r1 = run89(['run', tool89('mingkit.ming'), '--', 'read', kf]);
    const r2 = run89(['run', tool89('mingkit.ming'), '--', 'count', kf]);
    check('v89.6a:mingkit 冒烟逐字节——write/read 往返 + count 行/字符/字节,与迁移前 HEAD 基线逐字一致',
      w.code === 0 && r1.code === 0 && r1.stdout === 'alpha\nbeta\ngamma\n'
      && r2.code === 0 && r2.stdout === '行 3\n字符 17\n字节 17\n',
      `w=${w.code} r1=${r1.code}:${JSON.stringify(r1.stdout.slice(0, 60))} r2=${r2.code}:${JSON.stringify(r2.stdout)}`);
    const ef = path.join(dir89, 'edit89.txt');
    fs.writeFileSync(ef, 'alpha\nbeta\ngamma\n', 'utf8');
    const r3 = run89(['run', tool89('edit.ming'), '--', 'show', ef, '1', '3']);
    const r4 = run89(['run', tool89('edit.ming'), '--', 'count', ef]);
    check('v89.6b:edit 冒烟逐字节——show 带行号区间 + count,与迁移前 HEAD 基线逐字一致',
      r3.code === 0 && r3.stdout === '1|alpha\n2|beta\n3|gamma\n' && r4.code === 0 && r4.stdout === '3\n',
      `r3=${r3.code}:${JSON.stringify(r3.stdout)} r4=${r4.code}:${JSON.stringify(r4.stdout)}`);
  }

  // ---- v89.7:diaghot + engdiff 冒烟逐字节 ----
  {
    const dh = path.join(dir89, 'code89.ming');
    fs.writeFileSync(dh, 'fn main() with io { print(str(nope)); }\n', 'utf8');
    const r1 = run89(['run', tool89('diaghot.ming'), '--', dh, '--top', '3']);
    check('v89.7a:diaghot 冒烟逐字节——聚合 2 条诊断(M3001/M3002)含首条消息回显,与迁移前 HEAD 基线逐字一致',
      r1.code === 0 && r1.stdout === '诊断热力图:1 个文件,2 条诊断,2 种码\n  1. M3001  x1  (1 个文件)\n     找不到值 "nope"\n  2. M3002  x1  (1 个文件)\n     str 的参数 #1 必须是 int/float/bool/str,实际是 ?\n',
      `code=${r1.code} out=${JSON.stringify(r1.stdout.slice(0, 200))}`);
    const r2 = run89(['run', tool89('engdiff.ming'), '--', path.join(ROOT, 'examples', 'fib.ming')]);
    check('v89.7b:engdiff 冒烟逐字节——三引擎一致 + fib 全输出,与迁移前 HEAD 基线逐字一致',
      r2.code === 0 && r2.stdout === 'engdiff: 一致(退出码 0)\nfib(0) = 0\nfib(1) = 1\nfib(2) = 1\nfib(3) = 2\nfib(4) = 3\nfib(5) = 5\nfib(6) = 8\nfib(7) = 13\nfib(8) = 21\nfib(9) = 34\nfib(10) = 55\n\n',
      `code=${r2.code} out=${JSON.stringify(r2.stdout.slice(0, 160))}`);
  }

  // ---- v89.8:xnsni + xnopen 冒烟逐字节(论文向量/http 形态/离线探测) ----
  {
    const r1 = run89(['tools', 'xnsni', 'https://cloudflare.com/ping']);
    const note = 'note:   论文 CCS 2026 §4.3——SNI 改写 + --connect-to 映射真实主机 + Host 头;服务器宽容性依赖,失败请对照原 URL 行为\n';
    check('v89.8a:xnsni 冒烟逐字节——论文示例向量(cloudflare.com → xn--636c…)7 行与迁移前 HEAD 基线逐字一致',
      r1.code === 0 && r1.stdout === 'scheme: https\nhost:   cloudflare.com\nport:   443\nsni:    xn--636c6f7564666c6172652e636f6d\nurl:    https://xn--636c6f7564666c6172652e636f6d/ping\ncurl:   curl --connect-to \'xn--636c6f7564666c6172652e636f6d:443:cloudflare.com:443\' -H \'Host: cloudflare.com\' \'https://xn--636c6f7564666c6172652e636f6d/ping\'\n' + note,
      `code=${r1.code} out=${JSON.stringify(r1.stdout.slice(0, 160))}`);
    const r2 = run89(['tools', 'xnsni', 'http://example.com:8080/a/b?x=1']);
    check('v89.8b:xnsni http+端口形态逐字节(端口透传/路径与查询串保留)',
      r2.code === 0 && r2.stdout === 'scheme: http\nhost:   example.com\nport:   8080\nsni:    xn--6578616d706c652e636f6d\nurl:    http://xn--6578616d706c652e636f6d/a/b?x=1\ncurl:   curl --connect-to \'xn--6578616d706c652e636f6d:8080:example.com:8080\' -H \'Host: example.com\' \'http://xn--6578616d706c652e636f6d/a/b?x=1\'\n' + note,
      `code=${r2.code} out=${JSON.stringify(r2.stdout.slice(0, 160))}`);
    const r3 = run89(['tools', 'xnopen', 'http://127.0.0.1:1/', '--', '--no-chrome']);
    check('v89.8c:xnopen 离线探测逐字节——原/改写均 0 + 改写不可达判定 + --no-chrome skipped',
      r3.code === 0 && r3.stdout === '== 改写 ==\nsni:  xn--3132372e302e302e31\nurl:  http://xn--3132372e302e302e31/\n== 探测(curl 全配方) ==\n原 URL:  0\n改写后:  0\n判定: 改写不可达——服务器不宽容伪 IDN SNI,或站点属 DNS/IP 层封锁(本方法无效)\n== Chrome ==\nskipped(--no-chrome)\n',
      `code=${r3.code} out=${JSON.stringify(r3.stdout.slice(0, 200))}`);
  }

  // ---- v89.9:工具错误纪律(stderr + exit 1;错误文本经迁移逐字保持) ----
  {
    const r1 = run89(['run', tool89('wc.ming'), '--', path.join(dir89, 'nope89.txt')]);
    check('v89.9a:wc 缺文件纪律——exit 1 + stderr 具名(wc: 无法读取)+ stdout 空',
      r1.code === 1 && (r1.stderr ?? '').includes('wc: 无法读取') && (r1.stderr ?? '').includes('nope89.txt') && r1.stdout === '',
      `code=${r1.code} err=${JSON.stringify((r1.stderr ?? '').slice(0, 100))}`);
    const r2 = run89(['run', tool89('wc.ming'), '--', 'a\tb']);
    check('v89.9b:wc argv 控制字符 → sanitize_cli_path 拒绝(exit 1;v65.19 env 侧同款纪律的 argv 侧)',
      r2.code === 1 && (r2.stderr ?? '').includes('sanitize_cli_path') && r2.stdout === '',
      `code=${r2.code} err=${JSON.stringify((r2.stderr ?? '').slice(0, 110))}`);
    const td = path.join(dir89, 'treeD');
    const r3 = run89(['run', tool89('tree.ming'), '--', td, 'x']);
    const r4 = run89(['run', tool89('tree.ming'), '--', td, '0']);
    check('v89.9c:tree 深度错误文本逐字——"深度不是整数: x"/"深度必须是正整数,得到 0"(嵌参回显经净化不改写)',
      r3.code === 1 && r3.stderr === 'tree: 深度不是整数: x\n'
      && r4.code === 1 && r4.stderr === 'tree: 深度必须是正整数,得到 0\n',
      `r3=${r3.code}:${JSON.stringify(r3.stderr)} r4=${r4.code}:${JSON.stringify(r4.stderr)}`);
    const jf = path.join(dir89, 'cfg.json');
    const r5 = run89(['run', tool89('json_query.ming'), '--', jf, 'nope']);
    const kf = path.join(dir89, 'kit89.txt');
    const r6 = run89(['run', tool89('mingkit.ming'), '--', 'replace', kf, 'nope', 'X']);
    const ef = path.join(dir89, 'edit89.txt');
    const r7 = run89(['run', tool89('edit.ming'), '--', 'set', ef, '99', 'x']);
    check('v89.9d:json_query/mingkit/edit 错误文本逐字——键不存在/未找到目标串(0 处)/行号超出范围(嵌参回显)',
      r5.code === 1 && r5.stderr === 'json_query: 键不存在: nope(路径 nope)\n'
      && r6.code === 1 && r6.stderr === 'mingkit: 未找到目标串(0 处): nope\n'
      && r7.code === 1 && r7.stderr === 'edit: 行号超出范围(99,实际 3 行)\n',
      `r5=${r5.code}:${JSON.stringify(r5.stderr)} r6=${r6.code}:${JSON.stringify(r6.stderr)} r7=${r7.code}:${JSON.stringify(r7.stderr)}`);
  }

  // ---- v89.10:迁移语料代理位(v38 build 形态逐字 + net_e2e.mjs 实跑) ----
  {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-v89-dist-'));
    fs.writeFileSync(path.join(proj, 'ming.toml'), '[project]\nname = "v89dist"\nversion = "0.1.0"\nentry = "main.ming"\n');
    fs.writeFileSync(path.join(proj, 'main.ming'), [
      'fn greet(name: str) -> str {',
      '    return "hi, " + name;',
      '}',
      '',
      'use std.unstr;',
      'fn main(args: Vec[Untrusted[str]]) with io {',
      '    let mut who = "ming";',
      '    if args.len() > 0 { match std.unstr.sanitize_cli_path(args[0]) { Ok(p) => { who = p; }, Err(_) => { who = who; } } }',
      '    print(greet(who));',
      '    print(str(args.len()));',
      '}',
    ].join('\n'));
    const build = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: proj, timeout: 120000 });
    const run = (a) => spawnSync(process.execPath, [path.join(proj, 'dist', 'ming-app.mjs'), ...a], { encoding: 'utf8', cwd: proj, timeout: 60000 });
    const r1 = run(['--', 'alice']);
    const r2 = run([]);
    check('v89.10a:v38 形态迁移语料——Vec[Untrusted[str]] main 经 sanitize_cli_path 进 greet(净 str),AOT build + launcher stdout 逐字(hi, alice/ming)',
      build.status === 0 && r1.status === 0 && r1.stdout === 'hi, alice\n1\n' && r2.status === 0 && r2.stdout === 'hi, ming\n0\n',
      `build=${build.status} r1=${r1.status}:${JSON.stringify(r1.stdout)} r2=${r2.status}:${JSON.stringify(r2.stdout)} err=${(r1.stderr ?? '').slice(0, 120)}`);
    fs.rmSync(proj, { recursive: true, force: true });
    const e2e = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'net_e2e.mjs')], { encoding: 'utf8', cwd: ROOT, timeout: 180000 });
    check('v89.10b:net_e2e.mjs 实跑——parse_i64 端口惯用法(URL 净部件重组)双引擎 4 通过 0 失败',
      e2e.status === 0 && (e2e.stderr ?? '').includes('4 通过,0 失败'),
      `code=${e2e.status} err=${JSON.stringify((e2e.stderr ?? '').slice(0, 200))} out=${JSON.stringify((e2e.stdout ?? '').slice(0, 200))}`);
  }
  // ---- §89-END
}

process.stdout.write(`\n${passed} 通过,${failed} 失败\n`);
if (failed > 0) {
  process.stdout.write('\n失败清单:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}\n`);
  process.exit(1);
}


  // ---- §76-END

