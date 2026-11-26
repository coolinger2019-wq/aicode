# Ming (明) Programming Language

> **明** — what a program means must be exactly what it says. No implicit conversions, no null, no silent overflow, no hidden control flow.

**Language / 语言:** [中文](README.md) · **English** · [中文 · 人话版 (plain Chinese)](README.plain.md)

Ming is a programming language designed for **AI–human collaboration**. Every design decision answers one question: *how do we make it harder for generative AI to write wrong code, and easier to verify what it wrote?*

## Why Ming

The failure modes of AI-written code are highly concentrated: implicit type conversions, truthiness, null propagation, silent overflow, aliased mutable state, forgotten semicolons. Ming eliminates this entire class of problems **at the language level**, and turns verification feedback into a machine-consumable protocol:

```ming
fn main() with io {
    let name = "世界";
    let mut total = 0;
    for i in 1..11 {
        total += i;
    }
    print("你好, \{name}! 1..11 的和是 \{total}");
}
```

```bash
$ node bin/ming.js run examples/hello.ming
你好, 世界! 1..11 的和是 55

$ node bin/ming.js check examples/hello.ming --json
{ "ok": true, "diagnostics": [] }
```

## Core features

| Feature | What it means |
|---------|---------------|
| **Explicit** | No implicit conversions, no null (use `Option[T]`), no truthiness, no operator overloading, `mut` is explicit |
| **Effect system** | Side effects must be declared and propagated: `fn f() with io, time { ... }`; pure functions are compile-time provable |
| **Cross-function contracts** | `requires`/`ensures`/`invariant`: runtime checks (M4015) + static verification (M3040/M3041/M3042) + bounded static proof (M3045/W3105) with `--proof-report`; "unproven" is never assumed |
| **Safety** | Integer overflow / division by zero / out-of-bounds / missing keys all panic — predictably, with source locations and stable error codes; dangerous capabilities (disk/network) are unreachable unless declared as `fs`/`net` effects |
| **Value semantics** | Assignment, argument passing and capture are deep copies — no aliasing bugs, no data races |
| **trait + impl** | Methods on user types must be defined in traits; built-in `Eq` / `ToStr`; generic bounds `[T: Eq]` checked at call sites |
| **Determinism** | Maps keep insertion order, evaluation is left-to-right, overflow behavior is defined, `ming fmt` produces one canonical style |
| **Machine-friendly** | Every tool supports `--json`; stable diagnostic codes M1xxx–M4xxx / W3xxx with hints and fix prescriptions |
| **Multiple backends** | Tree-walking interpreter / bytecode VM (with WASM tier) / native C backend (`ming cc`); differential testing across engines is part of the semantic contract |
| **Taint tracking** | `Untrusted[T]` labels untrusted input (argv/env/fs/net/proc); sanitizers in `std.unstr`; M3049 at sinks |

## Quick start

Requires Node.js ≥ 18 (Windows / macOS / Linux). No third-party dependencies.

```bash
node bin/ming.js run examples/fizzbuzz.ming   # run
node bin/ming.js check your.ming --json       # type-check (JSON protocol)
node bin/ming.js test your.ming               # run test blocks
node bin/ming.js fmt your.ming --write        # canonical formatting
node bin/ming.js doc your.ming                # extract /// docs
node bin/ming.js cc your.ming                 # C backend: native binary (needs gcc/clang)
```

On Windows you can also use `bin\ming.cmd`. Editor integration: `node bin/ming.js lsp` starts the language server (stdio JSON-RPC; diagnostics/hover/completion/goto-definition/document symbols).

## Documentation

- **[GUIDE.md](GUIDE.md)** — user guide (syntax, types, stdlib, toolchain, AI usage; includes the revision log). *Chinese.*
- **[docs/design.md](docs/design.md)** — design philosophy and language specification highlights
- **[docs/diagnostics.md](docs/diagnostics.md)** — stable diagnostic code table
- **[docs/plan.md](docs/plan.md)** — implementation plan (currently **round §4.15** + **§4.16 compiler-level optimization (T6)**: assessment-driven consolidation — controlled experiment / language freeze → 1.0-rc / scenario pilots / engineering hardening / benchmarks; T6 measure→folding/DCE/peephole→copy elision→VM inline caches; self-hosted compiler remains gated)
- **[docs/capabilities.md](docs/capabilities.md)** — capability matrix (55 rows, ≈85%)
- **[docs/moltbook.md](docs/moltbook.md)** — community presence and discussion log (Moltbook)
- **[AGENTS.md](AGENTS.md)** — collaboration guide for AI agents (hard rules, commands, commit conventions, known pitfalls)
- **[examples/](examples/)** — runnable example programs
- **[README.plain.md](README.plain.md)** — plain-language Chinese introduction

> The canonical documentation is Chinese-first; this English README mirrors the essentials. For the complete per-version changelog see [README.md](README.md#版本历史).

## Status

| Item | Value |
|------|-------|
| Current version | **v1.2.2** (2026-11-26) |
| Regression suite | **1748 checks, all green** (§1–§115; full run every time) |
| Differential fuzzing | fuzz, 3 seeds (44044/777/20261) × 40 programs — 0 divergences; proof_fuzz 0 false positives |
| Coverage | **95.1% lines / 90.9% functions** (v0.96 refresh 2026-11-20; 16 files incl. opt.js 99.3%/100%; vm.js functions 76.6%) |
| Self-hosted tools | **14** (written in Ming; unified `ming tools` entry) |
| Capability matrix | 55 rows ≈85% ([docs/capabilities.md](docs/capabilities.md)) |
| Requirements | Node.js ≥ 18, zero third-party deps; C backend needs gcc/clang |
| Artifacts | `ming build` AOT bytecode (content-addressed cache); `ming cc` native C |

## Version history (recent)

Strictly descending. Full table and per-version details: [README.md](README.md#版本历史).

| Version | Date | Theme | Tests |
|---------|------|-------|-------|
| v1.2.2 | 2026-11-26 | Argument evaluation-order fix (#90: materialize all call arguments in source order; panic first line identical across tree/VM/cc) + Z3 external-consumption validation wired into CI (tests/z3_check.mjs 6-corpus per-block assertions + z3-verify job; R-15 closed) | 1748 |
| v1.2.1 | 2026-11-23 | cc short-circuit evaluation-order fix: `&&`/`||` guard-block materialization + lazy match guards + statement-ized while conditions (same-family fixes: #88 wildcard arm source order / #89 eager unwrap_or fallback); four-engine evaluation order aligned; seed 39039 restored as acceptance seed | 1742 |
| v1.2.0 | 2026-11-23 | Contract bridge MVP: `ming bridge extract --from ts` (JSDoc → deterministic .mingi contract stubs) + `ming check --stub` (M3052 signature check / bilateral carrier equivalence / poisoned-extern skip) + spec doc + end-to-end example; plus two fmt data-loss fixes (extern declarations silently deleted / `///` doc comments duplicated on every write); 1 MAJOR + 5 MINOR review fixes | 1726 |
| v1.1.0 | 2026-11-23 | Proof protocol first slice: `ming check --proof-format smt-lib` (QF_LIA obligations → SMT-LIB 2.0, pure output option, zero semantic change) + docs/proof-protocol.md spec + additive --json obligation fields (3 MAJOR review fixes; Z3 consumption validation pending external environment) | 1704 |
| v1.0.0 | 2026-11-23 | 1.0 GA (rc.1 admission + rc.2 G8/scenarios 5/5) | 1685 |
| v1.0.0-rc.2 | 2026-11-23 | R-6 G8 taint-bytes channel (ADR-012) + R-5 two scenarios (T3 5/5) | 1685 |
| v1.0.0-rc.1 | 2026-11-22 | 1.0-rc admission batch (T2.4 checklist all green; contract effective / parallelization / T1 experiment / 3 scenarios / English GUIDE) | 1650 |
| v0.100.0 | 2026-11-21 | ADR-011 P2 copy-point filtering (#82 closed; design line complete) | 1644 |
| v0.99.0 | 2026-11-20 | ADR-011 P1 creation-point filtered capture (captureEnvFor) | 1627 |
| v0.98.0 | 2026-11-20 | ADR-011 P0 analysis single-sourcing (freenames.js) | 1612 |
| v0.97.0 | 2026-11-20 | P1 #79/#81 fixes + O2.1 copy-elision design (ADR-010); #80/#82 registered | 1603 |
| v0.96.0 | 2026-11-20 | O1c constant propagation (4/4; O1 complete) | 1586 |
| v0.95.0 | 2026-11-20 | O1b peephole pass (2/4) | 1575 |
| v0.94.0 | 2026-11-20 | O1 bytecode optimization wave 1 (folding/pruning/threading/DCE) | 1566 |
| v0.93.0 | 2026-11-20 | Cross-language benchmark report (T5.1) | 1551 |
| v0.92.0 | 2026-11-20 | C backend I/O surface + O0 optimization observation baseline | 1551 |
| v0.91.0 | 2026-11-20 | Engineering hardening: suite timeouts + support matrix + docs check | 1541 |
| v0.90.0 | 2026-11-19 | Engine consistency wave 3: AOT struct equality #73 / tree ctor-as-value / BIND span unification / u64 literal messages | 1539 |
| v0.89.0 | 2026-11-19 | Narrow-type normalization: Map values / lambda returns / enum payload / inferred M1a·M1b | 1524 |
| v0.88.0 | 2026-11-19 | Narrow-type annotation boundaries: spec-tree-driven four-boundary normalization + AOT normSpec | 1506 |
| v0.87.0 | 2026-11-19 | ADR-009 S2: `Slice[u8]` read-only view (M3051) + narrow-type width normalization | 1488 |
| v0.86.0 | 2026-11-19 | ADR-009 S1: `read_bytes_range` minimal streaming (8MB chunk cap) | 1456 |
| v0.85.0 | 2026-11-18 | Narrow-type arithmetic consistency (intBin fits gate → M4002) + M3013 widening fix | 1441 |
| v0.84.0 | 2026-11-18 | Observation & honesty refresh (coverage/bench/AI-loop snapshot) + fits bits=32 fix | 1405 |
| v0.83.0 | 2026-11-18 | Engine consistency: M4004 message unification, #72 i32::MIN negation, LSP placeholder filter | 1398 |
| v0.82.0 | 2026-11-18 | Taint v1.3 window (ADR-008): argv `Vec[Untrusted[str]]`, response-header carrier, metadata | 1373 |
| v0.81.0 | 2026-11-18 | Engine consistency: M4002 message unification across four engines + defense-in-depth | 1333 |
| v0.80.0 | 2026-11-18 | AI-collaboration wave 2: fix prescriptions 4→9 families + LSP multi-file completion slice 1 | 1300 |
| v0.79.0 | 2026-11-17 | Robustness: #71 lambda-body continue/break checker hole | 1260 |
| v0.78.0 | 2026-11-17 | Robustness: #70 VM match-in-for continue stack divergence | 1251 |
| v0.77.0 | 2026-11-17 | Taint v1.2: fs/net/proc content sources + value algebra + outbound passthrough | 1231 |
| v0.76.0 | 2026-11-17 | Robustness: call-arg nesting guard + M3002 fix family | 1186 |
| v0.75.0 | 2026-11-16 | Robustness: all remaining raw-stack crash surfaces closed with stable M4005 diagnostics | 1173 |
| v0.74.0 | 2026-11-16 | Inline assembly: explicit `with asm` capability (ADR-006, C backend only, M4017 fallback) | 1164 |
| v0.73.0 | 2026-11-15 | Tech debt & observability: deep-nesting guards, coverage re-measurement, GUIDE cross-refs | 1141 |
| v0.72.0 | 2026-11-15 | Diagnostic quality follow-up: if-branch taint symmetry, M3049 remedy precision | 1132 |
| v0.71.0 | 2026-11-15 | Diagnostic cleanup: salvage refinement, valBrace ownership, nested taint M3049 | 1124 |
| v0.70.0 | 2026-11-15 | Diagnostic calibration II: parser cascade suppression (#63) | 1103 |
| v0.69.0 | 2026-11-15 | `eval` runtime compile-and-run (`with eval`, ADR-005) + serve exit-code idiom | 1091 |
| v0.68.0 | 2026-11-15 | `Untrusted[Json]` carrier (serve payload taint protection, ADR-004) | 1066 |
| v0.67.0 | 2026-11-15 | Diagnostic protocol calibration (poisoning convergence / M3012 context / M3015 nearest) | 1049 |
| v0.66.0 | 2026-11-14 | Observation & feedback pure-calibration release (no semantic changes) | 1035 |
| v0.65.0 | 2026-11-14 | wasm guard closure slice 3: five shapes actually run through wasm; nested stack frames | 1035 |

## Design principles

1. **Explicit beats terse** — what is written is the entire meaning.
2. **Safe by default** — dangerous operations are either checked or panic; never silent.
3. **Side effects are visible** — the effect signature says it all: a function without `io` cannot print, and the compiler guarantees it.
4. **Deterministic** — the same code always behaves the same way (including iteration order).
5. **Optimized for the verification loop** — AI works as "generate → check → fix"; the toolchain exists to serve that loop.
6. **One way to write it** — one structure, one syntax; `ming fmt` is the only style.
