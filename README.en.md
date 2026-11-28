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
| Current version | **v1.9.0** (2026-11-29) |
| Regression suite | **1981 checks, all green** (§1–§123; full run every time) |
| Differential fuzzing | fuzz, 3 seeds (44044/777/20261) × 40 programs — 0 divergences; proof_fuzz 0 false positives |
| Coverage | **95.1% lines / 90.9% functions** (v0.96 refresh 2026-11-20; 16 files incl. opt.js 99.3%/100%; vm.js functions 76.6%) |
| Self-hosted tools | **18** (written in Ming; unified `ming tools` entry) |
| Capability matrix | 55 rows ≈85% ([docs/capabilities.md](docs/capabilities.md)) |
| Requirements | Node.js ≥ 18, zero third-party deps; C backend needs gcc/clang |
| Artifacts | `ming build` AOT bytecode (content-addressed cache); `ming cc` native C |

## Version history (recent)

Strictly descending. Full table and per-version details: [README.md](README.md#版本历史).

| Version | Date | Theme | Tests |
|---------|------|-------|-------|
| v1.9.0 | 2026-11-29 | P1 6.2 slice 1 = parameterized effects fs (ADR-021: `with fs("/data/**")` mixed syntax + three-form pattern grammar + M3055 static containment + M3054 runtime enforcement — 17 fs builtins gated at the callStd single point, dynamic-path overreach panics) + fix of a pre-existing dual-engine divergence (lambda panic call-stack missing <closure> frame on tree) | 1981 |
| v1.8.0 | 2026-11-28 | P1 6.1 = Ming Agent Protocol (four LSP methods ming/agent/*: type context / contract summary + proof status / candidate submission with structured counterexamples / obligation artifact export; ADR-020 security boundary = read-only candidate path through the existing check) + reference agent-client standalone repo (pure-stdlib client; demo fix loop M3045 counterexample → fix → proven) | 1939 |
| v1.7.0 | 2026-11-28 | Bridge 2 = Rust contract bridge (`ming bridge extract --from rust`: top-level fn + /// doc math-inequality lines, faithful narrow-type mapping, isize/usize/f32 approx notes, Result/tuple named skips; ADR-019) + third external consumer rustuserlib (real Rust crate cargo test vs signatures of record, neutral-dir 4/4 exit 0) | 1927 |
| v1.6.0 | 2026-11-28 | Bridge 1 = Python contract bridge (`ming bridge extract --from py`: PEP 484 annotations + docstring math-inequality lines, eight-type mapping, deterministic output; ADR-018) + second external consumer pyuserlib (ADR-017 path 2: standalone stdlib-only .mingi stub cross-checker, neutral-dir 4/4 exit 0) + M3053 hint peer-neutral wording | 1909 |
| v1.5.1 | 2026-11-28 | First external consumer lands (ming-proof-consumer, a standalone repo: independent proof re-verifier, three-corpus evidence run exit 0 without the Ming toolchain) + ADR-017 consumer criteria pinned (C1 separate repo / C2 runs without Ming toolchain / C3 consumes exported artifacts only; P1 admission met — honesty note: self-built bridgehead ≠ third-party adoption) + docs_check AGENTS header anchoring | docs_check 17 |
| v1.5.0 | 2026-11-27 | moltbook integration tool #18 (register/login/me/post/comment/read/feed/notifications; full taint chain, credentials never printed) + ADR-016 two language exits (http request body gains the same out-facing passthrough as local file writes — url/method/headers stay sinks; json.stringify_untrusted lands) — real-API end-to-end smoke passed | 1894 |
| v1.4.2 | 2026-11-27 | Self-hosted tools 14→17 (certverify certificate self-consistency checker / treehash directory fingerprint / semver semantic versioning) + five audit fixes in existing tools (batch_rename/file_organizer refuse overwriting an existing target, wc counts empty files as 0, mingkit read start<1 and three-arg interval named rejections, json_query errors append actual keys/length) + merge review (REQUEST_CHANGES) and independent re-review all closed | 1863 |
| v1.4.1 | 2026-11-27 | CI platform fix: v114.47 corpus made platform-deterministic (pure long chain triggers depthBailed defense; macOS parser-stack platform variance — AGENTS §9 caveat confirmed) + v114.48 platform-tolerant variant | 1837 |
| v1.4.0 | 2026-11-27 | Contract satisfaction check (S-5/ADR-015): `check --stub` call-site requires satisfaction (b-lite: literal arguments mechanically evaluated, violation emits M3053[bridge-contract-violated]; undecidable counted in `stub_contract.contracts`; no assumption injection) + consumer kit (`examples/consumers/verify_cert.py` independent Python implementation of the certificate criterion + consumption guide) | 1836 |
| v1.3.2 | 2026-11-27 | R-19 coverage extension: nine SMT fixtures (reserved-word rewrite / non-linearizable / multi-file sections — section order now has a discriminating guard for command-line order) + zero-command allowlist + strengthened matrix assertions | 1818 |
| v1.3.1 | 2026-11-27 | Manifest v2: certificate fingerprint binding (`artifacts` = hash of the exact artifact bytes of this export, closing TOCTOU for a single export; `--proof-manifest` opened to cert mode; per-direction `{has_cert, uses_goal, vacuous, reason}`; v1→v2 pure additive) | 1818 |
| v1.3.0 | 2026-11-27 | Self-produced linear certificates (S-3a/ADR-014): `ming check --proof-format cert` -- negative cycles from the decision procedure ARE Farkas certificates with coefficients 1; self-contained integer-arithmetic criterion (a third party re-checks in a few dozen lines); `uses_goal`/`vacuous` fields; coverage not promised, certificate-less proven obligations named; `tests/cert_check.mjs` reference checker (independent recomputation + three negative cases) + 7-corpus goldens | 1809 |
| v1.2.6 | 2026-11-27 | Provenance manifest (R-20/ADR-013): `--proof-manifest <path>` sidecar (collection pass hash / source sha256 / integer model / engine contract / obligation table / solver:null back-fill; project-relative paths, source-overwrite refusal, 8-key determinism; additive `proof_manifest` in --json) | 1786 |
| v1.2.5 | 2026-11-27 | Operand evaluation-order closure (#93: comparisons/f64/bitwise materialized in source order, condition face included) + dead-branch disposal (#94: `<<=`/`>>=` removed/asserted at three sites) + ADR-013/014 rulings (provenance manifest go; S-3 redefined as independently checkable proof artifact — self-produced negative-cycle/linear certificate, Alethe demoted to documented bypass) | 1776 |
| v1.2.4 | 2026-11-27 | Guard evaluation-order fix (#92: `/ % << >>` and `+ - *` operands materialized in source order; panic first line aligned, messages byte-identical; #91 arithmetic/shift face closed) + SMT-LIB golden fixtures (R-19: six-corpus byte-exact goldens, fixture check runs without z3, §116 local gate) | 1767 |
| v1.2.3 | 2026-11-26 | Contract bridge S-4.1 (.mingi stubs carry effect/taint signatures: @effects/@taint, format v2 dual-read) + fuzz forced short-circuit side-effect forms (R-17: reverse-validation hits #85 family on pristine v1.2.0; exit code joins norm) | 1755 |
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
