# Ming — English Guide: Key Chapters

> Condensed English companion for the **v1.0-rc** batch — **not** a full translation:
> per plan §4.15.3 (T2.4 item 7) it renders the four key chapters of the canonical
> guide. **GUIDE.md is canonical**: where this document and `GUIDE.md` disagree,
> `GUIDE.md` wins. Every claim is a faithful rendering of `GUIDE.md` (references like
> [§3] point there) and `docs/diagnostics.md`; the language surface is frozen (T2.2
> freeze order, 2026-11-22), so nothing here introduces a new language claim. Code
> examples are adapted from GUIDE.md's own examples (semantics verbatim); every `ming`
> block is a complete, checkable unit and passes `ming check` with zero diagnostics.

Requires Node.js >= 18 (Windows / macOS / Linux; the C backend additionally needs
gcc/clang). The toolchain and runtime have zero third-party dependencies. [GUIDE header]

```bash
node bin/ming.js run examples/hello.ming   # run (default engine: bytecode VM + wasm layer)
node bin/ming.js check your.ming --json    # type check (seconds, does not execute)
node bin/ming.js test your.ming            # run test blocks
node bin/ming.js fmt your.ming --write     # canonical formatting
```

All commands accept `--json` — structured diagnostics and results for tools and AI
consumers (chapter 3). On Windows `bin\ming.cmd` works; `npm link` gives you `ming`. [§1]

## 1. Syntax & Types

### Program structure [§2]

Top-level items are declarations only — `fn` / `struct` / `enum` / `use` / `test` /
`const` / `trait` / `impl`, each optionally `pub`. Every statement ends with `;`; the
final expression of a block may omit the `;` and its value is the block's value (Rust
style). String interpolation is `"\{expr}"` (only int/float/bool/str, M3012). Comments:
`//` line, `///` doc (extracted by `ming doc`).

The entry point is `fn main()`; it may declare `-> i64` (the value becomes the process
exit code) and at most one `args: Vec[Untrusted[str]]` parameter — OS argv is
element-level untrusted, so a clean `Vec[str]` is M3049 (v0.82, ADR-008). [§2, §18, M3023/M3049]

### Variables, mutability, built-in types [§3]

```ming
fn main() with io {
    let x = 42;            // inferred as i64
    let y: i64 = 42;       // explicit annotation
    let mut count = 0;     // only mut bindings can be reassigned
    count = count + 1;

    let (a, b) = (1, 2);   // tuple destructuring
    let _ = x + y + count; // deliberate discard (_ prefix = intentionally unused)
    print(str(a + b));
}
```

| Type | Notes |
|------|-------|
| `i8 i16 i32 i64` / `u8 u16 u32 u64` | literals default to `i64`; a suffix sets the width: `42u8` |
| `f32 f64` | float, default `f64` |
| `bool` | `true` / `false`; conditions must be bool — no truthiness |
| `str` | UTF-8 string, immutable |
| `Vec[T]` | dynamic array |
| `Map[K, V]` | ordered map — iteration order is insertion order; empty literal `[:]` |
| `Option[T]` | `Some(v)` / `None` instead of null |
| `Result[T, E]` | `Ok(v)` / `Err(e)` instead of exceptions |
| `(T1, T2)` | tuple; `()` is unit; no numeric index `t.0` (M2002) — destructure instead |
| `Range[T]` | `lo..hi`, half-open |

Narrow types (`i8/i16/i32`, `u8/u16/u32`) arise from suffixes, `as`/`to_*`, or
declaration context. Whenever a value enters a narrow slot, both engines normalize it
by the declared type — out of range is a M4002 panic, never a silent wrap. [§3]

### The hard rules [§3, §22]

- **No implicit conversion.** `1 + 2.0`, `i32 + i64`, `u8 == i64` are compile errors.
  Use `as` (bit truncation/saturation, explicit) or `to_u8()`-style conversions
  (range-checked, return `Option`).
- **No null** — missing values are `Option[T]`.
- **Integer overflow, division by zero, shift out of range → panic** (M4002/M4004) —
  never a silent wraparound. Floats are IEEE-754; `/0.0` yields inf/nan (no panic).
- **Assignment is a deep copy (value semantics).** After `let b = a;`, `a` and `b` are
  fully independent — same for arguments, returns and captures. A program contains no
  shared mutable state.

Operators: no chained comparisons `a < b < c` (M2005); no `++`/`--` (write `x += 1`);
`=` and compound assignments are statements, not expressions; `==` is deep structural
equality (Map equality ignores order); evaluation is left to right. [§4]

### Control flow [§5]

`if` is an expression (the value form must have an `else`); `while`, `while let`,
`loop` with `break`/`continue`; `for` iterates Vec, Map (yielding `(k, v)` tuples),
str (by characters) and Range. Conditions must be `bool` (M3014) — `if 1 {}` is a
compile error.

### Functions, lambdas, local functions [§6]

```ming
fn add(a: i64, b: i64) -> i64 {   // parameter and return types are explicit
    a + b                          // trailing expression = return value
}
```

Parameters are immutable by default; `mut` parameters let you reassign the local copy
(caller data is deep-copied — to "modify" caller data, return a new value). A function
with no return type returns unit. Module functions need no forward declaration.
Signatures may declare contracts — `requires ...` at entry, `ensures result ...` at
each return, struct `invariant` on fields; a violation panics at runtime with M4015
(exit 101). Contract expressions must be pure: calling an effectful function is M3029,
calling a mut method is M3043. [§6, §14]

Local functions (a `fn` declared inside a body, since v0.59) are block-level entries:
visible anywhere in the same block, self/mutually recursive, contracts like module
functions. Four limits, stated honestly: no capture of outer locals (M3001); visible
only in their block (nearest lexical block wins; same-block name collision is M3009);
no generics (M3048) and the C backend rejects them; outside the static proof face
(M3041/M3042/M3045/W3105 — runtime M4015 still applies). [§6]

Closures: `(x: i64) => x * 2` (expression body) or a block body; in higher-order
position the parameter types are usually inferred — e.g.
`nums.map((x) => x * 2).filter((x) => x % 2 == 0)`. **Capture is a value snapshot at
creation**; captured variables cannot be assigned inside the closure. A lambda body is
a new function boundary: `continue`/`break` inside target only loops within the lambda;
a bare one outside any loop is M3010/M3011 (v0.79). [§6]

### Structs, enums, match [§7, §8, §13]

```ming
struct Point {
    x: f64,
    y: f64,
}

enum Shape {
    Circle(f64),      // payload variant
    Rect(f64, f64),
    Point,            // bare variant
}

fn area(s: Shape) -> f64 {
    match s {
        Shape.Circle(r)  => std.math.pi() * r * r,
        Shape.Rect(w, h) => w * h,
        Shape.Point      => 0.0,
    }
}

fn main() with io {
    let p = Point { x: 1.0, y: 2.0 };   // all fields explicit, no defaults
    let s = Shape.Circle(2.0);          // construction is qualified: Enum.Variant
    print(str(area(s) + p.x));
}
```

Field access and assignment require the binding to be `mut`. `match` must be exhaustive
(M3007); guarded arms do not count as coverage. Patterns: literals, `_`, bindings,
tuples, qualified variants; the prelude exposes bare `Some(x)` / `None` / `Ok(v)` /
`Err(e)`. User-type methods live only in trait impls (no orphan methods) — prelude
traits `Eq`, `ToStr`, `Compare`; generic impls can bound their own type parameters. [§8, §13]

### Option, Result and `?` [§9]

```ming
fn parse_pair(s: str) -> Result[(i64, i64), str] {
    let parts = s.split(",");
    if parts.len() != 2 {
        return Err("need exactly two numbers");
    }
    let x = parts[0].trim().parse_i64()?;   // Err returns early
    let y = parts[1].trim().parse_i64()?;
    Ok((x, y))
}
```

`?` unwraps an `Option`/`Result` or **returns early** with `None`/`Err` of the same
type; the enclosing function must return a compatible Option/Result (M3002).
`unwrap()` / `expect(msg)` panic with M4006 on None/Err — use only for "cannot fail".
`panic("message")` aborts with exit code 101 and prints the Ming call stack (newest
frame first). [§9]

### Vec, Map, strings [§10, §11]

```ming
fn main() with io {
    let mut v: Vec[i64] = [3, 1, 2];   // empty literal is [] (often needs an annotation)
    v.push(4);
    v.sort();
    let first = v.get(0);              // Option[i64]; v[0] panics when out of bounds

    let mut m: Map[str, i64] = [:];    // explicit empty Map
    m.set("a", 1);
    let x = m.get("a");                // Option[i64]; m["a"] panics on a missing key

    for (k, val) in m { print("\{k}=\{val}"); }   // insertion order, always deterministic
    print(str(first.unwrap() + x.unwrap()));
}
```

Vec methods: `len is_empty push pop get first last contains index_of reverse sort
sort_by map filter fold join slice insert remove extend clear clone`. Map methods:
`len is_empty get set has delete keys values items clear clone`. Value semantics: after
`let w = v;`, pushing to `v` does not affect `w` — `w` is a full copy. [§10]

Strings: `char_len()` counts characters, `byte_len()` counts bytes; also `chars()`,
`split`, `trim`, `contains`, `starts_with`, `replace`, `repeat`, `get(i) -> Option[str]`,
`parse_i64() -> Result[i64, str]`. **`s[i]` is forbidden** (encoding ambiguity, M3020) —
use `get` / `chars` / `slice_chars`. Concatenate with `+` (convert with `str(x)` first)
or interpolate; stringify structs with `debug(x)`. [§11]

### Untrusted[T]: the taint annotation [§18 std.unstr]

`Untrusted[str]` / `Untrusted[Json]` / `Untrusted[Vec[u8]]` /
`Untrusted[Map[str, str]]` are **compile-time labels, erased at runtime** — engine
output is unaffected by the annotation. Values from external sources are untrusted:
`env.get`, `io.read_line`, extern returns (signatures must declare `Untrusted[str]`),
the serve handler parameter (whole request tree), `fs.read_file` / `read_bytes` /
`read_bytes_range` / `list_dir` entries, `proc.exec` stdout/stderr, HTTP response
bodies (and response headers), `fs.metadata`, and argv. [§18]

Any position expecting the clean carrier type rejects `Untrusted` with **M3049** —
call arguments, `let` annotations, assignments, returns, Map keys/values, Vec elements,
struct fields, if/match branch mixing. Whitewash channels are forbidden: `debug(u)`,
interpolation, `as`, `str(u)` → M3050/M3049. The operation face is a 28-method
pure-function algebra: parsing/counting/predicates end the taint in a clean scalar;
content transforms (`trim`, `replace`, `split`, `chars`, ...) keep it (`split` yields
`Vec[Untrusted[str]]`). Outbound storage passthrough is legal — `print`/`eprint` of
`Untrusted[str]` and `fs.write_*` content/data; network outbound (HTTP headers/body)
stays a sink. [§18, M3049/M3050]

The only type-transition exits are the pure sanitizers: `std.unstr.sanitize_path`
(rejects absolute paths incl. `C:x` drive-relative, `..` segments, empty segments,
empty string; Ok = normalized relative path) and `std.unstr.sanitize_cli_path`
(validate, don't rewrite: rejects NUL/C0/DEL/C1/bidi controls; Ok = the original
string). `mark` / `mark_json` label clean values as untrusted (for tests). The reverse
direction — expecting `Untrusted`, passing a bare carrier — is M3002. [§18]

```ming
use std.unstr;

fn main(args: Vec[Untrusted[str]]) with io, env {
    let target = match std.env.get("TARGET") {
        Some(u) => match std.unstr.sanitize_cli_path(u) {
            Ok(s) => s,
            Err(_) => "",
        },
        None => "",
    };
    print(target);
}
```

## 2. The Effect System

**Principle: whether a function has side effects is visible in its signature — and
the compiler enforces it.** A pure function (no `with`) is a compile-time proof that it
only computes; reviewing "does this print / read the clock / touch disk" never requires
reading the implementation.

```ming
fn pure_double(n: i64) -> i64 {      // no with = pure
    return n * 2;
}

fn show(n: i64) with io {            // printing is a side effect
    print("\{n} → \{pure_double(n)}");  // calling a pure function needs nothing
}

fn stamped() with io, time {         // multiple effects, comma-separated
    print("\{std.time.now_ms()}");
}
```

The effect set (13): `io`, `time`, `fs`, `net`, `sync`, `proc`, `env`, `rand`,
`crypto`, `ffi` (extern functions), `unsafe` (restricted pointer blocks, C backend
only), `eval` (runtime compile & execute), `asm` (inline assembly, C backend only). [§14]

**Propagation**: calling an effectful function requires the caller to declare the same
(or more) effects — layer by layer — otherwise **M3029**. The effect list doubles as
the audit list and the capability gate: without `with fs` the compiler will not let a
program touch disk at all. `main` declares its own effects; `test` blocks own all
effects. Closures inherit effects at their creation site (known limitation: closures
stored in data structures do not track call-site effects). [§14, §18]

### `with unsafe` and `std.mem` (v0.54) [§14.1]

Dangerous operations get one line in the signature and one block in the code — and only
the C native backend truly executes them.

```ming
fn main() with io, unsafe {
    unsafe {
        let p = std.mem.alloc(2);   // Ptr[mut u8]; failure -> M4011 panic (no fake null)
        p.store(65);                // u8 value, no implicit conversion
        p.offset(1).store(66);      // offset returns a new Ptr (mut-ness preserved)
        print(str(p.load()));       // 65
        print(str(p.is_null()));    // false
        std.mem.free(p);            // you allocate, you free (no GC)
    }
    // outside the block: only let/assignment/return passing and p.is_null()
}
```

Double gate: the function must declare `with unsafe` (else M3029) and pointer
reads/writes plus `std.mem.alloc/free` must sit inside `unsafe { ... }` (else M3046).
`Ptr[mut u8]` / `Ptr[u8]`, element type only `u8`; methods `load()` / `store(u8)` /
`offset(i64)` / `is_null()`. tree/VM panic **M4016** ("unsafe pointer operations are
only available on the C native backend", exit 101, identical message); wasm refuses
eligibility and falls back to the same VM path; `ming build` falls back to source mode
with a named reason. Honesty: dangling pointers and out-of-bounds accesses are
process-level UB — Ming does not catch them; track lengths yourself. One stated
exception to value semantics: copying a `Ptr` copies the address, not the memory. [§14.1]

### `with asm` (v0.74) and `with eval` (v0.69) [§18]

`asm { ... }` embeds a GCC extended-asm template; template/constraints/clobber must be
**pure string literals** (interpolation and variables are rejected at the parse layer —
no injection surface); operands are i64 via GCC constraints (`out` must target a
`mut i64` local). Only `ming cc` executes asm (`__asm__ volatile`); tree/VM panic
**M4017** with an identical message; build falls back to source mode with a named
reason. `eval(src) -> Result[str, str] with eval` compiles and runs a string as an
independent compile unit with all checks at full strength (diagnostics carry
`file='<eval>'`): Ok = inner stdout, Err = a diagnostics JSON using the same schema as
`--json`. eval is a taint sink (`Untrusted` args → M3049) with no sanitizer for code —
external inputs can never reach eval, guaranteed mechanically by the type system. The
inner engine is always the tree reference implementation; quotas are inherited per
call; nesting beyond 64 levels returns Err(M4005). [§18]

### Structured concurrency: `std.sync` [§18 std.sync]

`spawn(fn, args...)` runs a **module-level named function** in an isolated sub-VM;
`join` waits once per handle. `Join[R]` is a linear resource (M3034): it cannot be
stored into Vec/Map/struct fields or passed as a spawn argument. `spawn_all` runs one
subtask per element; `sync scope { ... }` auto-joins every handle at block exit —
structured concurrency. Cross-task types: int/u64/float/bool/str/Json/Vec/Map
(recursive), Option/Result; structs, user enums and closures cannot cross tasks.
Arguments are full copies — value semantics gives determinism without shared memory. [§18]

```ming
use std.sync;

fn fib(n: i64) -> i64 {
    if n < 2 { return n; }
    return fib(n - 1) + fib(n - 2);
}

fn main() with io, sync {
    let h1 = std.sync.spawn(fib, 25);   // two subtasks, truly parallel
    let h2 = std.sync.spawn(fib, 20);
    print(str(std.sync.join(h1).unwrap() + std.sync.join(h2).unwrap()));
}
```

## 3. Diagnostics

Diagnostic codes are part of Ming's external protocol: **a published code never changes
meaning; new codes are only added**. Families: M1xxx lexical, M2xxx syntax, M3xxx types
& semantics, M4xxx runtime panics (exit code 101), W3xxx warnings (non-blocking), plus
M5001 (manifest). The full, stable table is `docs/diagnostics.md`. [diagnostics.md header]

Human-readable output carries `code + name + severity + message + file:line:col +
hint`; with `--json` every command emits the structured protocol (fields as below, plus
optional `hint` / `fix` / `cause`). [§19]

```json
{
  "code": "M3002",
  "name": "mismatched-types",
  "severity": "error",
  "message": "let annotation is i64, but the initializer is str",
  "file": "t.ming", "line": 1, "col": 15,
  "hint": "Check both type annotations; Ming has no implicit conversions."
}
```

Exit codes: 0 success; 1 diagnostics; 101 panic; 2 toolchain bug or a `--strict-wasm`
visible fallback; `main -> i64` overrides the exit code. [§19]

**Structured fix prescriptions** (`ming check --json`, optional
`fix: {start, end, replacement}`): as of v0.80 nine families emit fixes — M2002 (insert
missing token), M3029 (add `with ...`), M3001 (rewrite to the nearest visible name),
M3002 (change the declared type), M3015 (nearest method name), M3006 (Json field →
`x.get("f")`), M3004 (add `mut`), M3008 (wrap the non-str operand in `str(...)`), M3012
(wrap the interpolation in `debug(...)`). Every family is locked by an
"apply → recheck → error gone" machine proof. [§19]

Key code families (exact semantics in `docs/diagnostics.md`):

| Code | Meaning |
|------|---------|
| M2001 | unexpected token; also reused by the parse-depth guard (v0.73): message "expression nesting too deep (>120 levels)" — a structural limit, not token misplacement |
| M3001 | cannot find name — undefined (nearest-name suggestion) or cross-module item that is not `pub` |
| M3002 | mismatched types — Ming has no implicit conversion, ever |
| M3049 | untrusted-mismatch — an `Untrusted[T]` value reached a sink that does not explicitly accept it; remedies are carrier-aware (sanitize family for str, `as_str()` projection + sanitize for Json, or declare the slot `Untrusted[T]`) |
| M4002 | integer overflow / shift out of range — arithmetic is checked end to end, never silent |
| M4003 | index out of bounds — Vec/slice indexing; use `.get(i)` to get an `Option` instead |
| M4015 | contract violation — `requires`/`ensures` failed at runtime (exit 101) |

Runtime panics print the Ming source location and call stack (newest first); scoped
subtask propagation adds a `Caused by` chain. Warnings never block: W3101
unused-variable, W3102 float-equality, W3103 unreachable-code, W3104
test-literal-overfit, W3105 index-bounds-unproven (only with `--warn-unproven-index`).
[diagnostics.md]

## 4. Toolchain

Commands: `run`, `check`, `test`, `build`, `cc`, `tools`, `init`, `fmt`, `doc`, `lsp`,
`repl`, `version`. Project mode: `run/check/test/build` without a file argument locate
`ming.toml` by walking upward; `ming init [name]` scaffolds a project. [§19, bin usage]

| Command | Purpose |
|---------|---------|
| `ming run f.ming [-- args]` | check → compile bytecode → VM. `--tree` runs the tree-walking reference engine for comparison; `--no-wasm` disables the wasm layer; `--strict-wasm` turns any eligible>0 wasm fallback into a visible failure (exit 2, named reason; mutually exclusive with `--tree`/`--no-wasm`); `--no-opt` disables the bytecode optimization pipeline; `--json` captures output; `-- args...` passes program arguments |
| `ming check f.ming [...]` | static checks only. `--json`, `--proof-report` (per-function proof statistics + contract summaries), `--warn-unproven-index` (W3105 warnings), `--strict-wasm` (verify the wasm layering survives) |
| `ming test f.ming` | run `test` blocks of the entry file; `--filter name`; quota flags propagate (defaults identical to run) |
| `ming fmt f.ming` | the only style: 4-space indent, explicit `;`, comments preserved. `--write` / `--check` (CI). Preserves `requires`/`ensures`/`invariant` (since v0.56). Do not hand-tune formatting |
| `ming doc f.ming` | extract `///` docs. `--json` stable schema `{ok, file, items:[{kind, name, line, doc, signature}]}`; `--index` aggregates multiple files |
| `ming build` | project mode → `dist` portable artifact (bytecode + runtime + launcher; `node dist/ming-app.mjs`). Content-addressed cache (v0.49); `--clean-cache` rebuilds; `--with-source` embeds source. Honest fallback to source mode (dist contains `app.ming`) for `with sync` / `with unsafe` / `with eval` / `with asm` / net programs and programs containing `test` blocks — always with a named reason |
| `ming cc f.ming` | C native backend: eligible functions (numeric + str + `Vec[i64]` + `Map[str,i64]` + `Option[i64]` + Ptr/unsafe forms) are emitted to C and compiled with gcc/clang -O2; stdout and panic first lines align verbatim with `ming run`. `--emit-c`, `--no-run`, `--static`; unsupported statement shapes are rejected at emit time (C1, exit 1) |
| `ming lsp` | stdio JSON-RPC server: diagnostics push, hover, completion, definition, document symbols; conservative completion (under-complete rather than mis-complete); Content-Length framing is UTF-8 byte-based |
| `ming repl` | interactive session: expression echo, failed-input rollback, paren balancing, `:clear`/`:quit`. Top-level declarations persist across inputs; `let` bindings are only effective for the current input (later references are M3001 — known semantics, echoed as a reminder) |
| `ming tools <cmd>` | unified entry for the 14 self-hosted tools (written in Ming): `patch` (exact-string replace, exactly-one-hit or rejected), `edit` (line-number editing), `diff` (multi-engine differential), `diag` (diagnostic heatmap, `--top N`), `wc`, `tree`, `find`, `json`, `todo`, `log`, `rename`, `organize`; args after `--` pass through to the tool |

**Resource gate flags** (`run`/`test`, propagated): `--max-steps N` (VM steps),
`--max-alloc N` (cumulative allocation estimate — value creation plus external input
boundaries; exceeded → M4011), `--max-ms N` (wall clock; exceeded → M4012; blocking
builtins like sleep/join/exec/http are clamped to the remaining budget; stdin blocking
and RegExp backtracking are not preemptible). Subtasks inherit the limits. [§19, M4011/M4012]

**CLI defaults (registered 2026-11-22, aligned with the stability contract P5
addendum)**: `--max-steps` unlimited (Infinity), `--max-alloc` **268435456 bytes**,
`--max-ms` **600000 ms** — the same default triple for run/test/general invocation
(anchored in bin/ming.js). Changing a default is a behavior change and must go through
the stability contract's deprecation process. `--max-ms` applies to serve programs too:
long-running services must raise it explicitly (e.g. `--max-ms 86400000`). [§19]

**wasm layering honesty**: functions that do not qualify for the wasm layer fall back
to the VM silently (normal exit 0 — semantics identical); `--strict-wasm` makes every
fallback visible (exit 2 with the named reason); `MING_WASM_DEBUG=1` prints
`[wasm] fn <name> OK` / `REJECT` for triage. [§19]

## Source map (guide-en → GUIDE.md)

| This document | GUIDE.md |
|---------------|----------|
| 1. Syntax & Types | §2, §3, §4, §5, §6, §7, §8, §9, §10, §11, §13, §18 (std.unstr) |
| 2. The Effect System | §14, §14.1, §18 (asm, eval, std.sync) |
| 3. Diagnostics | §19 (diagnostic protocol, fixes, exit codes) + docs/diagnostics.md |
| 4. Toolchain | §19 (command table, quotas, wasm layering) + docs/diagnostics.md (exit codes) |

Not covered here (GUIDE.md remains the single source of truth): generics & trait bounds
in depth (§12–§13), the full std library reference (§18), contracts & static bound proofs
in depth (§6), Slice views (§14.2), modules (§16), AI advice (§20), migration (§21), §22.
