// tests/support_matrix/run.mjs — 语言形态 × 后端 支持矩阵(plan §4.15 T4.3;机器可验证)。
//
// 目的:把"语言形态 × 后端"的实际支持面变成机器可验证的表——文档与实现 100% 一致
// (说的和做的一样),不追求追平,只追求诚实。
//
// 机制:
// - 每个形态一个探针 .ming 程序(程序化写入临时目录,零仓库内语料依赖);
// - 每形态 × 五列引擎实际执行:tree(--tree)/ VM-only(--no-wasm)/ VM+wasm(默认)/
//   cc(ming cc,需 gcc/clang,缺失时整列跳过)/ AOT dist(ming build 后 node dist/ming-app.mjs);
// - **期望值钉死在本文件 EXP 表**(2026-11-20 实测钉死,基线 v0.90.0);harness 逐格比对:
//   期望 ≠ 实际 → exit 1。这就是"矩阵与实现一致"的机器保证——实现侧任何行为变化
//   (诊断码、消息、退出码、回退模式)都会让矩阵变红,必须显式重测并同步 EXP 表与文档;
// - `--write` 重新生成 docs/support-matrix.md(表格由 harness 生成,人只读);
// - `--json` 输出逐格 JSON(人读/工具读两用)。
//
// 判定口径(与 docs/support-matrix.md 头注一致):
// - ✅ ok     —— 退出码 0、stdout 与期望逐字一致、stderr 为空;
// - ⛔ reject —— 编译/检查期具名拒绝(退出码 1),首行诊断含期望码与原因片段
//               (检查器 M 码、C1 资格拒绝、build 失败诊断);
// - ☠️ panic  —— 运行时 panic(退出码 101),stderr 首行含期望 M 码与消息片段;
// - ↩️ fallback —— 仅 AOT 列:`ming build` 对该形态**具名回退源码模式**(dist 无字节码,
//               stderr 有"AOT 不可用"提示,非静默);dist 实际运行结果如实展示;
// - – skip   —— cc 列无编译器时整列跳过;AOT 列当前无跳过形态。
//
// 与 GUIDE / capabilities 的关系:docs/capabilities.md 是"能力"粗粒度(55 行 ✅/🟡/❌);
// GUIDE 是用户手册;本表是"具体语言形态 × 具体后端执行路径"的细粒度事实表。
// 矩阵变更必须同步探针与 EXP 表(plan §4.15 T4.3 验收:矩阵与探针 100% 一致)。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MING = path.join(ROOT, 'bin', 'ming.js');
const DOC_PATH = path.join(ROOT, 'docs', 'support-matrix.md');
const WRITE_DOC = process.argv.includes('--write');
const JSON_OUT = process.argv.includes('--json');
const TIMEOUT_RUN = 120000;
const TIMEOUT_BUILD = 180000;

const SYM = { ok: '✅', reject: '⛔', panic: '☠️', skip: '–' };
const LEG_TITLES = { tree: 'tree', vmOnly: 'VM(--no-wasm)', vm: 'VM+wasm(默认)', cc: 'cc(C 后端)', aot: 'AOT dist' };

function mingVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '?';
  } catch { return '?'; }
}

// 编译器探测(与 tests/bench.mjs 同序:MING_CC → PATH → 已知便携位置)
function detectCC() {
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
}

const firstLine = (s) => (s ?? '').split('\n')[0] ?? '';

// ---------- 期望值判定辅助(期望表的可读缩写) ----------
// ok(stdout)         —— exit 0 + stdout 逐字 + stderr 空
// panic(code, msg)   —— exit 101 + 首行含 code 与 msg 片段
// reject(code, msg)  —— exit 1(非 0 非 101)+ 首行含 code 与 msg 片段
// skip()             —— 跳过(仅 cc 无编译器时由 harness 动态产生,EXP 不写 skip)
const ok = (stdout) => ({ kind: 'ok', stdout });
const panic = (code, msg) => ({ kind: 'panic', code, msg });
const reject = (code, msg) => ({ kind: 'reject', code, msg });
// aot 腿专用:mode = 'bytecode'(真字节码产物)| 'fallback'(具名回退源码模式)
const aotOk = (mode, stdout) => ({ kind: 'ok', stdout, mode });
const aotPanic = (mode, code, msg) => ({ kind: 'panic', code, msg, mode });
const aotReject = (code, msg) => ({ kind: 'reject', code, msg });

// ---------- 探针与期望表(期望 = 2026-11-20 v0.90.0 实测钉死;改实现必须重测同步) ----------
const PROBES = [
  {
    id: '01', form: '整数 BIN 溢出(i32 后缀)',
    note: '窄型后缀算术溢出;cc 资格拒绝(i32 绑定 let 推导 null),AOT 字节码 M4002',
    src: `fn main() with io {
    let a = 2147483647i32;
    let b = a + 1i32;
    print(str(b));
}
`,
    exp: {
      tree: panic('M4002', '整数+溢出:2147483647 + 1 超出 i32 范围'),
      vmOnly: panic('M4002', '整数+溢出:2147483647 + 1 超出 i32 范围'),
      vm: panic('M4002', '整数+溢出:2147483647 + 1 超出 i32 范围'),
      cc: reject('C1', 'C1 不支持该程序形态:let 推导 null'),
      aot: aotPanic('bytecode', 'M4002', '整数+溢出:2147483647 + 1 超出 i32 范围'),
    },
  },
  {
    id: '02', form: '整数 BIN 溢出(u64 后缀)',
    note: 'u64 fits 门四引擎一致;cc 真实执行也 panic M4002(C 侧同模板)',
    src: `fn main() with io {
    let a = 18446744073709551615u64;
    let b = a + 1u64;
    print(str(b));
}
`,
    exp: {
      tree: panic('M4002', '整数+溢出:18446744073709551615 + 1 超出 i64u 范围'),
      vmOnly: panic('M4002', '整数+溢出:18446744073709551615 + 1 超出 i64u 范围'),
      vm: panic('M4002', '整数+溢出:18446744073709551615 + 1 超出 i64u 范围'),
      cc: panic('M4002', '整数+溢出:18446744073709551615 + 1 超出 i64u 范围'),
      aot: aotPanic('bytecode', 'M4002', '整数+溢出:18446744073709551615 + 1 超出 i64u 范围'),
    },
  },
  {
    id: '03', form: 'BIND 归一窄型溢出(i32 槽)',
    note: '绑定归一 panic 位置 = 绑定名 token(v0.90 3:9 统一);cc 资格拒绝',
    src: `fn main() with io {
    let v = [2147483647i32, 5, 2147483647];
    let y: i32 = v[2] + 1i32;
    print(y);
}
`,
    exp: {
      tree: panic('M4002', '整数溢出:2147483648 超出 i32 范围(绑定归一)'),
      vmOnly: panic('M4002', '整数溢出:2147483648 超出 i32 范围(绑定归一)'),
      vm: panic('M4002', '整数溢出:2147483648 超出 i32 范围(绑定归一)'),
      cc: reject('C1', 'C1 不支持该程序形态:let 推导 null'),
      aot: aotPanic('bytecode', 'M4002', '整数溢出:2147483648 超出 i32 范围(绑定归一)'),
    },
  },
  {
    id: '04', form: '无后缀字面量超 i64 进 u64 槽',
    note: '2^63 与 u64max 无后缀字面量绑定 u64 槽;五列全通过',
    src: `fn main() with io {
    let a: u64 = 9223372036854775808;
    print(a);
    let b: u64 = 18446744073709551615;
    print(b);
}
`,
    exp: {
      tree: ok('9223372036854775808\n18446744073709551615\n'),
      vmOnly: ok('9223372036854775808\n18446744073709551615\n'),
      vm: ok('9223372036854775808\n18446744073709551615\n'),
      cc: ok('9223372036854775808\n18446744073709551615\n'),
      aot: aotOk('bytecode', '9223372036854775808\n18446744073709551615\n'),
    },
  },
  {
    id: '05', form: 'tree ctor 作值(held ctor 调用)',
    note: 'let c = E.A; c(250) + Option.Some 部分构造器(v0.90 tree 对齐 VM)',
    src: `enum E { A(i64), B }
fn main() with io {
    let c = E.A;
    let v = c(250);
    match v {
        E.A(x) => { print(x); }
        E.B => { print(-1); }
    }
    let s = Option.Some;
    print(s(5).unwrap());
}
`,
    exp: {
      tree: ok('250\n5\n'),
      vmOnly: ok('250\n5\n'),
      vm: ok('250\n5\n'),
      cc: reject('C1', 'C1 不支持该程序形态:let 推导 null'),
      aot: aotOk('bytecode', '250\n5\n'),
    },
  },
  {
    id: '06', form: 'struct 跨构造点相等',
    note: '#73:v0.90 起异构造点同类型 struct 值相等判定正确(AOT 含)',
    src: `struct P { a: i64, b: i64 }
fn main() with io {
    let x = P { a: 1, b: 2 };
    let y = P { a: 1, b: 2 };
    let z = P { a: 1, b: 3 };
    print(x == y);
    print(x == z);
}
`,
    exp: {
      tree: ok('true\nfalse\n'),
      vmOnly: ok('true\nfalse\n'),
      vm: ok('true\nfalse\n'),
      cc: reject('C1', 'C1 不支持该程序形态:let 推导 null'),
      aot: aotOk('bytecode', 'true\nfalse\n'),
    },
  },
  {
    id: '07', form: 'enum 跨构造点相等',
    note: '#73 同族:enum 同构造 true / 不同载荷 false / 无载荷变体 true',
    src: `enum E { A(i64), B }
fn main() with io {
    let e1 = E.A(1);
    let e2 = E.A(1);
    let e3 = E.A(2);
    let b1 = E.B;
    let b2 = E.B;
    print(e1 == e2);
    print(e1 == e3);
    print(b1 == b2);
}
`,
    exp: {
      tree: ok('true\nfalse\ntrue\n'),
      vmOnly: ok('true\nfalse\ntrue\n'),
      vm: ok('true\nfalse\ntrue\n'),
      cc: reject('C1', 'C1 不支持该程序形态:let 推导 null'),
      aot: aotOk('bytecode', 'true\nfalse\ntrue\n'),
    },
  },
  {
    id: '08', form: '元组模式绑定归一',
    note: 'let (a, b) = (1, 2) + 窄型注解 (u8, u8);cc 拒绝元组 let 形式',
    src: `fn main() with io {
    let (a, b) = (1, 2);
    let (c, d): (u8, u8) = (5u8, 6u8);
    print(a + b);
    print(c + d);
}
`,
    exp: {
      tree: ok('3\n11\n'),
      vmOnly: ok('3\n11\n'),
      vm: ok('3\n11\n'),
      cc: reject('C1', 'C1 不支持该程序形态:let 形式'),
      aot: aotOk('bytecode', '3\n11\n'),
    },
  },
  {
    id: '09', form: '闭包捕获调用',
    note: 'lambda 捕获外层局部并调用(形参需类型标注,推断缺失 M3003);cc 不支持闭包;AOT 具名回退源码(闭包缺签名)',
    src: `fn main() with io {
    let n = 10;
    let f = (x: i64) => x + n;
    print(str(f(5)));
}
`,
    exp: {
      tree: ok('15\n'),
      vmOnly: ok('15\n'),
      vm: ok('15\n'),
      cc: reject('C1', 'C1 不支持该程序形态:let 推导 null'),
      aot: aotOk('fallback', '15\n'),
    },
  },
  {
    id: '10', form: '本地函数递归',
    note: '块级 fn 自递归(v0.59 #44 恢复);cc 不支持本地函数(C1 语句 FnStmt)',
    src: `fn main() with io {
    fn fact(n: i64) -> i64 {
        if n < 2 { return 1; }
        return n * fact(n - 1);
    }
    print(str(fact(6)));
}
`,
    exp: {
      tree: ok('720\n'),
      vmOnly: ok('720\n'),
      vm: ok('720\n'),
      cc: reject('C1', 'C1 不支持该程序形态:语句 FnStmt'),
      aot: aotOk('bytecode', '720\n'),
    },
  },
  {
    id: '11', form: 'match 守卫臂',
    note: 'Rust 风格 `模式 if 条件 => 值`;cc 仅整数字面量臂(C1)',
    src: `fn main() with io {
    let x = 5;
    let r = match x {
        n if n > 10 => 100,
        n if n > 0 => 200,
        _ => 300,
    };
    print(str(r));
}
`,
    exp: {
      tree: ok('200\n'),
      vmOnly: ok('200\n'),
      vm: ok('200\n'),
      cc: reject('C1', 'C1 不支持该程序形态:match 模式(C2 仅整数字面量)'),
      aot: aotOk('bytecode', '200\n'),
    },
  },
  {
    id: '12', form: 'unsafe 块(Ptr 内存读写)',
    note: 'tree/VM M4016 具名拒绝;cc 真实执行(alloc/store/load/free);AOT 回退源码后同 M4016',
    src: `fn main() with io, unsafe {
    unsafe {
        let p = std.mem.alloc(2);
        p.store(65);
        p.offset(1).store(66);
        print(str(p.load()));
        print(str(p.offset(1).load()));
        std.mem.free(p);
    }
}
`,
    exp: {
      tree: panic('M4016', 'M4016[native-only-feature]'),
      vmOnly: panic('M4016', 'M4016[native-only-feature]'),
      vm: panic('M4016', 'M4016[native-only-feature]'),
      cc: ok('65\n66\n'),
      aot: aotPanic('fallback', 'M4016', 'M4016[native-only-feature]'),
    },
  },
  {
    id: '13', form: 'asm 块(bswap 确定性形态)',
    note: 'tree/VM M4017 具名回落;cc 经 __asm__ volatile 真实执行;AOT 回退源码后同 M4017',
    src: `fn bswap64(x: i64) -> i64 with asm {
    let mut r: i64 = 0;
    asm { "mov %1, %0\\n\\tbswap %0" out("=r", mut r) in("r", x) }
    return r;
}
fn main() with io, asm {
    print(str(bswap64(72623859790382856) == 578437695752307201));
}
`,
    exp: {
      tree: panic('M4017', 'M4017[asm-cc-only]'),
      vmOnly: panic('M4017', 'M4017[asm-cc-only]'),
      vm: panic('M4017', 'M4017[asm-cc-only]'),
      cc: ok('true\n'),
      aot: aotPanic('fallback', 'M4017', 'M4017[asm-cc-only]'),
    },
  },
  {
    id: '14', form: 'eval builtin(运行时编译执行)',
    note: 'with eval 门禁;内层恒 tree;cc 发射期拒绝;AOT 具名回退源码后可用(输出末尾多一空行 = 外层 print 补的换行)',
    src: `fn main() with io, eval {
    let r = eval("fn main() with io { print(str(6 * 7)); }");
    print(r.unwrap());
}
`,
    exp: {
      tree: ok('42\n\n'),
      vmOnly: ok('42\n\n'),
      vm: ok('42\n\n'),
      cc: reject('C1', 'C1 不支持该程序形态:let 推导 null'),
      aot: aotOk('fallback', '42\n\n'),
    },
  },
  {
    id: '15', form: 'spawn/join(结构化并发)',
    note: 'worker 隔离 + join Result;sync 形态 AOT 具名回退源码后可用',
    src: `use std.sync;
fn compute(n: i64) -> i64 {
    let mut s = 0;
    for i in 1..(n + 1) { s += i; }
    return s;
}
fn main() with io, sync {
    let h = std.sync.spawn(compute, 100);
    print(str(std.sync.join(h).unwrap()));
}
`,
    exp: {
      tree: ok('5050\n'),
      vmOnly: ok('5050\n'),
      vm: ok('5050\n'),
      cc: reject('C1', 'C1 不支持该程序形态:let 推导 null'),
      aot: aotOk('fallback', '5050\n'),
    },
  },
  {
    id: '16', form: '窄型算术 fits 门(i8 溢出)',
    note: 'v0.85 fits 门:127i8+1i8 运行时 M4002(非静默回绕);cc 拒绝窄型打印',
    src: `fn main() with io {
    print(str(127i8 + 1i8));
}
`,
    exp: {
      tree: panic('M4002', '整数+溢出:127 + 1 超出 i8 范围'),
      vmOnly: panic('M4002', '整数+溢出:127 + 1 超出 i8 范围'),
      vm: panic('M4002', '整数+溢出:127 + 1 超出 i8 范围'),
      cc: reject('C1', 'C1 不支持该程序形态:str(打印 null)'),
      aot: aotPanic('bytecode', 'M4002', '整数+溢出:127 + 1 超出 i8 范围'),
    },
  },
  {
    id: '17', form: '污点 sink M3049(污进净槽)',
    note: 'Untrusted[str] 直传净 str 槽 → 检查期 M3049;五列同拒(check 先于引擎)',
    src: `use std.env;
fn main() with env {
    let s: str = std.env.get("MING_SM_PROBE").unwrap();
    print(s);
}
`,
    exp: {
      tree: reject('M3049', 'M3049[untrusted-mismatch]'),
      vmOnly: reject('M3049', 'M3049[untrusted-mismatch]'),
      vm: reject('M3049', 'M3049[untrusted-mismatch]'),
      cc: reject('M3049', 'M3049[untrusted-mismatch]'),
      aot: aotReject('M3049', 'M3049[untrusted-mismatch]'),
    },
  },
  {
    id: '18', form: 'Slice 视图逃逸 M3051',
    note: 'Slice[u8] 块内线性:跨函数返回视图 → 编译期 M3051;五列同拒',
    src: `fn leak(v: Vec[u8]) -> Slice[u8] {
    return v.view(0, 1);
}
fn main() with io {
    let v: Vec[u8] = [1, 2, 3];
    print(str(leak(v).len()));
}
`,
    exp: {
      tree: reject('M3051', 'M3051[slice-escape]'),
      vmOnly: reject('M3051', 'M3051[slice-escape]'),
      vm: reject('M3051', 'M3051[slice-escape]'),
      cc: reject('M3051', 'M3051[slice-escape]'),
      aot: aotReject('M3051', 'M3051[slice-escape]'),
    },
  },
  {
    id: '19', form: 'read_bytes_range(最小流式范围读)',
    note: 'v0.86 S1:范围读 + 短读合法(读 2 字节);AOT 真字节码可用',
    src: `use std.fs;
fn main() with io, fs {
    let _w = std.fs.write_bytes("probe.bin", "ABC".to_bytes());
    let r = std.fs.read_bytes_range("probe.bin", 1, 2);
    match r {
        Ok(bytes) => print(str(bytes.len())),
        Err(e) => print("err: " + e),
    }
}
`,
    exp: {
      tree: ok('2\n'),
      vmOnly: ok('2\n'),
      vm: ok('2\n'),
      cc: reject('C1', 'C1 不支持该程序形态:let 推导 null'),
      aot: aotOk('bytecode', '2\n'),
    },
  },
  {
    id: '20', form: '字符串插值',
    note: '数值段插值;cc 不支持插值串(C1, GUIDE C 面已声明)',
    src: `fn main() with io {
    let n = 3;
    print("n=\\{n}, n+1=\\{n + 1}");
}
`,
    exp: {
      tree: ok('n=3, n+1=4\n'),
      vmOnly: ok('n=3, n+1=4\n'),
      vm: ok('n=3, n+1=4\n'),
      cc: reject('C1', 'C1 不支持该程序形态:print 插值串(C4)'),
      aot: aotOk('bytecode', 'n=3, n+1=4\n'),
    },
  },
  {
    id: '21', form: '泛型 impl 方法(ToStr)',
    note: '泛型 struct + bound trait impl;泛型形态 AOT 具名回退源码后可用',
    src: `struct Pair[A, B] {
    left: A,
    right: B,
}
impl[A: ToStr, B: ToStr] ToStr for Pair[A, B] {
    fn to_str(self) -> str {
        return "(\\{self.left.to_str()}, \\{self.right.to_str()})";
    }
}
fn main() with io {
    let p = Pair { left: 1, right: "x" };
    print(p.to_str());
}
`,
    exp: {
      tree: ok('(1, x)\n'),
      vmOnly: ok('(1, x)\n'),
      vm: ok('(1, x)\n'),
      cc: reject('C1', 'C1 不支持该程序形态:let 推导 null'),
      aot: aotOk('fallback', '(1, x)\n'),
    },
  },
];

// ---------- 执行 ----------
function runEngine(file, leg, cwd) {
  const args = [MING];
  if (leg === 'tree') args.push('run', file, '--tree');
  else if (leg === 'vmOnly') args.push('run', file, '--no-wasm');
  else if (leg === 'vm') args.push('run', file);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd, timeout: TIMEOUT_RUN });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runCc(file, dir) {
  const ccout = path.join(dir, 'ccout');
  fs.rmSync(ccout, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [MING, 'cc', file, '--out', ccout], { encoding: 'utf8', cwd: dir, timeout: TIMEOUT_BUILD });
  if (r.status !== 0) {
    return { kind: 'compile-fail', status: r.status, first: firstLine(r.stderr || r.stdout), stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
  }
  const exe = path.join(ccout, 'main' + (process.platform === 'win32' ? '.exe' : ''));
  if (!fs.existsSync(exe)) {
    return { kind: 'compile-fail', status: r.status, first: '产物缺失(编译 exit 0 但无 exe)', stderr: '', stdout: '' };
  }
  const run = spawnSync(exe, [], { encoding: 'utf8', cwd: dir, timeout: TIMEOUT_RUN });
  return { kind: 'ran', status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

function runAot(file, dir) {
  const proj = path.join(dir, 'aot-proj');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'ming.toml'), `[project]\nname = "support-matrix"\nversion = "0.1.0"\nentry = "main.ming"\n`);
  fs.copyFileSync(file, path.join(proj, 'main.ming'));
  const build = spawnSync(process.execPath, [MING, 'build'], { encoding: 'utf8', cwd: proj, timeout: TIMEOUT_BUILD });
  if (build.status !== 0) {
    return { kind: 'build-fail', status: build.status, first: firstLine(build.stderr || build.stdout), buildStderr: build.stderr ?? '' };
  }
  const bytecode = fs.existsSync(path.join(proj, 'dist', 'app.bytecode.json'));
  const fallback = /AOT 不可用/.test(build.stderr || '');
  const run = spawnSync(process.execPath, [path.join(proj, 'dist', 'ming-app.mjs')], { encoding: 'utf8', cwd: proj, timeout: TIMEOUT_RUN });
  return { kind: 'ran', status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', bytecode, fallback };
}

function firstDiagLine(res) {
  return firstLine(res.stderr || res.stdout);
}

// 单格判定:期望 vs 实际 → { pass, cellText, detail }
function judge(exp, res, isAot = false) {
  if (exp.kind === 'ok') {
    const pass = res.status === 0 && res.stdout === exp.stdout && (res.stderr ?? '') === '';
    return { pass, cellText: pass ? SYM.ok : `${SYM.ok}?(输出不符)`, detail: pass ? '' : `exit=${res.status} stdout=${JSON.stringify(res.stdout.slice(0, 60))} stderr=${JSON.stringify((res.stderr ?? '').slice(0, 80))}` };
  }
  if (exp.kind === 'panic') {
    const fl = firstDiagLine(res);
    const pass = res.status === 101 && fl.includes(exp.code) && fl.includes(exp.msg);
    return { pass, cellText: pass ? `${SYM.panic} ${exp.code}` : `${SYM.panic}?(不符)`, detail: pass ? '' : `exit=${res.status} first=${JSON.stringify(fl.slice(0, 120))}` };
  }
  if (exp.kind === 'reject') {
    const fl = firstDiagLine(res);
    const pass = res.status !== 0 && res.status !== 101 && fl.includes(exp.code) && fl.includes(exp.msg);
    return { pass, cellText: pass ? `${SYM.reject} ${exp.code}` : `${SYM.reject}?(不符)`, detail: pass ? '' : `exit=${res.status} first=${JSON.stringify(fl.slice(0, 120))}` };
  }
  return { pass: false, cellText: '?', detail: '未知期望类型 ' + exp.kind };
}

// AOT 判定:先按 build/ran 形态归类,再判运行结果 + 回退模式钉死
function judgeAot(exp, aot) {
  if (exp.kind === 'reject') {
    if (aot.kind !== 'build-fail') {
      return { pass: false, cellText: `${SYM.reject}?(未拒绝)`, detail: `期望 build 失败,实际 kind=${aot.kind} status=${aot.status}` };
    }
    const pass = aot.first.includes(exp.code) && aot.first.includes(exp.msg);
    return { pass, cellText: pass ? `${SYM.reject} ${exp.code}` : `${SYM.reject}?(不符)`, detail: pass ? '' : `first=${JSON.stringify(aot.first.slice(0, 120))}` };
  }
  if (aot.kind !== 'ran') {
    return { pass: false, cellText: '?', detail: `期望可运行,实际 build 失败:first=${JSON.stringify((aot.first || '').slice(0, 120))}` };
  }
  const modeOk = exp.mode === 'bytecode' ? aot.bytecode === true && aot.fallback === false : aot.fallback === true && aot.bytecode === false;
  if (!modeOk) {
    return { pass: false, cellText: '?', detail: `期望 ${exp.mode},实际 bytecode=${aot.bytecode} fallback=${aot.fallback}` };
  }
  const base = judge({ ...exp, mode: undefined }, aot);
  if (base.pass && exp.mode === 'fallback') base.cellText = `↩️ ${base.cellText}`;
  return base;
}

// ---------- 报告 ----------
function localDateStr() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function renderMarkdown(results, ccPath, dateStr) {
  const v = mingVersion();
  const lines = [];
  lines.push('# Ming 支持矩阵(语言形态 × 后端;机器可验证)');
  lines.push('');
  lines.push('> 本表由 `tests/support_matrix/run.mjs` 程序化生成——**每一格都是该后端实际执行一次探针程序得出的判定**;');
  lines.push('> 期望值钉死在 harness 的 EXP 表内,harness 逐格比对,期望 ≠ 实际 → exit 1(实现的任何行为漂移都会让矩阵变红)。');
  lines.push('> 人只读此文档;矩阵变更必须同步探针与 EXP 表(plan §4.15 T4.3 验收:矩阵与探针 100% 一致)。');
  lines.push('>');
  lines.push('> **与 GUIDE / capabilities 的关系**:`docs/capabilities.md` 是"能力"粗粒度(55 行,✅/🟡/❌ 三态,42✅ 10🟡 3❌);');
  lines.push('> `GUIDE.md` 是用户手册语义说明;**本表是"具体语言形态 × 具体后端执行路径"的细粒度事实表**,只追求诚实,不追求追平。');
  lines.push('>');
  lines.push('> **判定口径**:');
  lines.push('> - ✅ 正常 —— 退出码 0、stdout 与期望逐字一致、stderr 为空;');
  lines.push('> - ⛔ 具名拒绝 —— 编译/检查期拒绝(退出码 1),首行诊断含表中码与原因(检查器 M 码、C1 资格拒绝、build 失败诊断);');
  lines.push('> - ☠️ panic —— 运行时 panic(退出码 101),stderr 首行含表中 M 码与消息;');
  lines.push('> - ↩️ 前缀(仅 AOT 列)—— `ming build` 对该形态具名回退源码模式(dist 无字节码;stderr 有"AOT 不可用"提示,非静默),dist 实际运行结果如实展示;');
  lines.push('> - 统计口径:↩️ 为 ✅ 的子集(回退格同时计入 ✅),格数相加 > 总格数;探针 13(asm)使用 bswap 指令(x86-64)——CI runner 非该架构时该格如实报红;');
  lines.push('> - – 跳过 —— cc 列无编译器时整列跳过(AOT 列当前无跳过形态)。');
  lines.push('>');
  lines.push('> 每格只标最短原因;逐形态完整说明(含 cc 拒绝原文与 AOT 回退口径)见表格下方的"逐形态说明"。探针源程序见 `tests/support_matrix/run.mjs` 的 PROBES 表。');
  lines.push('');
  lines.push(`**生成时间**:${dateStr}(harness 实测;重新生成:\`node tests/support_matrix/run.mjs --write\`)  `);
  lines.push(`**Ming**:v${v} · Node ${process.version} · ${process.platform}-${process.arch} · cc 腿:${ccPath ?? '无编译器(整列跳过)'}`);
  lines.push('');
  lines.push('| # | 语言形态 | tree | VM(--no-wasm) | VM+wasm(默认) | cc(C 后端) | AOT dist(ming build) |');
  lines.push('|---|---------|:----:|:-------------:|:--------------:|:-----------:|:---------------------:|');
  for (const r of results) {
    const cells = ['tree', 'vmOnly', 'vm', 'cc', 'aot'].map((leg) => r.cells[leg]);
    lines.push(`| ${r.probe.id} | ${r.probe.form} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## 逐形态说明');
  lines.push('');
  for (const r of results) {
    lines.push(`- **${r.probe.id} ${r.probe.form}** —— ${r.probe.note}`);
  }
  lines.push('');
  lines.push('## 覆盖统计');
  lines.push('');
  const tally = { ok: 0, reject: 0, panic: 0, skip: 0, fallback: 0 };
  for (const r of results) {
    for (const leg of ['tree', 'vmOnly', 'vm', 'cc', 'aot']) {
      const j = r.judges[leg];
      if (!j) { tally.skip++; continue; }
      if (leg === 'aot' && j.fallback) tally.fallback++;
      if (j.kind === 'ok') tally.ok++;
      else if (j.kind === 'reject') tally.reject++;
      else if (j.kind === 'panic') tally.panic++;
      else tally.skip++;
    }
  }
  lines.push(`共 ${results.length} 形态 × 5 列 = ${results.length * 5} 格:✅ 正常 ${tally.ok} · ⛔ 具名拒绝 ${tally.reject} · ☠️ panic ${tally.panic} · ↩️ AOT 回退源码 ${tally.fallback} · – 跳过 ${tally.skip}。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

// ---------- 主流程 ----------
const CC = detectCC();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-support-matrix-'));
const results = [];
let failCount = 0;

for (const probe of PROBES) {
  const dir = path.join(TMP, probe.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'main.ming');
  fs.writeFileSync(file, probe.src, 'utf8');
  const cells = {}, judges = {};
  const legs = ['tree', 'vmOnly', 'vm', 'cc', 'aot'];
  for (const leg of legs) {
    const exp = probe.exp[leg];
    if (leg === 'cc' && !CC) {
      cells[leg] = '–(无编译器)';
      judges[leg] = null;
      continue;
    }
    let j;
    if (leg === 'aot') {
      const aot = runAot(file, dir);
      j = judgeAot(exp, aot);
      j.kind = exp.kind;
      j.fallback = aot.kind === 'ran' ? aot.fallback : false;
      if (!j.pass) j.detail = `AOT: ${j.detail}`;
    } else if (leg === 'cc') {
      const cc = runCc(file, dir);
      if (cc.kind === 'compile-fail') {
        j = judge(exp, { status: cc.status, stdout: cc.stdout, stderr: cc.stderr });
      } else {
        j = judge(exp, cc);
      }
      j.kind = exp.kind;
    } else {
      const res = runEngine(file, leg, dir);
      j = judge(exp, res);
      j.kind = exp.kind;
    }
    judges[leg] = j;
    cells[leg] = j.cellText;
    if (!j.pass) {
      failCount++;
      console.error(`✗ ${probe.id} ${probe.form} [${LEG_TITLES[leg]}] 期望≠实际`);
      console.error(`    ${j.detail}`);
    }
  }
  results.push({ probe, cells, judges });
}

// 控制台表格
console.log(`Ming 支持矩阵(v${mingVersion()},Node ${process.version},cc=${CC ?? '无'})`);
console.log('');
const idW = 4, formW = Math.max(...PROBES.map((p) => p.form.length)) + 2;
console.log(`${'#'.padEnd(idW)}${'语言形态'.padEnd(formW)}tree      VM-only   VM+wasm   cc        AOT dist`);
for (const r of results) {
  const row = ['tree', 'vmOnly', 'vm', 'cc', 'aot'].map((leg) => {
    const t = r.cells[leg] ?? '–';
    return (t + ' '.repeat(10)).slice(0, 10);
  });
  console.log(`${r.probe.id.padEnd(idW)}${r.probe.form.padEnd(formW)}${row.join('')}`);
}
const tally = { ok: 0, reject: 0, panic: 0, skip: 0, fallback: 0 };
for (const r of results) {
  for (const leg of ['tree', 'vmOnly', 'vm', 'cc', 'aot']) {
    const j = r.judges[leg];
    if (!j) { tally.skip++; continue; }
    if (leg === 'aot' && j.fallback) tally.fallback++;
    if (j.kind === 'ok') tally.ok++;
    else if (j.kind === 'reject') tally.reject++;
    else if (j.kind === 'panic') tally.panic++;
    else tally.skip++;
  }
}
console.log('');
console.log(`格子统计:✅ 正常 ${tally.ok} · ⛔ 具名拒绝 ${tally.reject} · ☠️ panic ${tally.panic} · ↩️ AOT 回退源码 ${tally.fallback} · – 跳过 ${tally.skip}(共 ${results.length * 5} 格)`);
console.log('口径注记:↩️ 为 ✅ 的子集(AOT 回退格同时计入 ✅——回退后 dist 仍正常运行),故各格数相加 > 总格数;🟡 粒度能力面见 docs/capabilities.md');

fs.rmSync(TMP, { recursive: true, force: true });

if (JSON_OUT) {
  const payload = {
    ming: mingVersion(), node: process.version, platform: `${process.platform}-${process.arch}`, cc: CC,
    pass: failCount === 0, failCount,
    cells: results.flatMap((r) => ['tree', 'vmOnly', 'vm', 'cc', 'aot'].map((leg) => ({
      probe: r.probe.id, form: r.probe.form, leg,
      expected: r.probe.exp[leg].kind + (r.probe.exp[leg].code ? ':' + r.probe.exp[leg].code : ''),
      cell: r.cells[leg], pass: r.judges[leg] === null ? true : r.judges[leg].pass,
    }))),
  };
  console.log(JSON.stringify(payload, null, 2));
}

if (WRITE_DOC) {
  const dateStr = localDateStr();
  fs.writeFileSync(DOC_PATH, renderMarkdown(results, CC, dateStr), 'utf8');
  console.log(`已写入 docs/support-matrix.md(${dateStr})`);
}

console.log(failCount === 0 ? '矩阵与实现一致:全部格子与期望相符 ✓' : `矩阵与实现不一致:${failCount} 格期望≠实际 ✗`);
process.exitCode = failCount === 0 ? 0 : 1;
