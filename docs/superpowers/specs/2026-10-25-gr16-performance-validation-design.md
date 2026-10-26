# GR-16 — Performance validation on large repositories

- Status: Draft for implementation (architect-reviewed)
- Date: 2026-10-25
- Epic: GR-1 / Story: GR-16
- Base: `main` @ 4644b29 (after GR-15)
- Related: ADR 0002 (spawn_blocking rule, paginated log), GR-8 spec §3 (one cached
  walk, "GR-16's 3-second first paint"), GR-15 spec §3 and §6 (CI shape, contract
  tests over workflow files)

## 1. Goal

Prove, on every CI run and reproducibly on a developer machine, that Git Real stays
responsive on large repositories: a benchmark harness measures the acceptance
criteria's numbers against a real public repository and a deterministic synthetic
one, fails the build when a budget is exceeded, and two small guards (a Rust contract
test for the off-UI-thread rule and an explicit front-end page cache bound) close the
criteria that are properties rather than timings.

### What already exists (not rebuilt here)

- `RepoSession::log_summary` builds the whole graph once per ref state (one
  topological `revwalk` over HEAD, branches, remotes and tags, with streaming lane
  layout) and `log_page` slices it in pages of up to 1000 rows
  (`git-real-core/src/log/{mod,walk,lanes,cache}.rs`).
- Status is one `git2` `statuses()` call with untracked recursion and rename
  detection (`git-real-core/src/status.rs`).
- Every one of the 86 `#[tauri::command]` handlers runs its body inside
  `run_blocking` (`tauri::async_runtime::spawn_blocking`) behind the per-session
  mutex (`src-tauri/src/commands/mod.rs:26-50`). Nothing touches git2 on the IPC
  thread today; nothing enforces that.
- The graph panel virtualizes rows (`@tanstack/react-virtual`) and fetches only
  the pages covering the visible range through `useQueries`
  (`src/features/graph/useLogPages.ts`), page size 500, `staleTime: Infinity`,
  default React Query `gcTime` (5 min).
- CI (`.github/workflows/ci.yml`) has `build-and-test` and `package` jobs; a Vitest
  contract test (`src/test/release.test.ts`) pins the workflow files' shape through
  the `yaml` devDependency.
- The system `git` CLI is already a hard dependency of the app (network, signing)
  and of the test suite (`git_available()` gates CLI-backed tests).

### Measured baselines (release build, i9-13900F, warm page cache)

| Repository                            |   Commits |  Files | Open | Graph build | First page |  Page all |      RSS after build | Paging RSS growth |                    Status |
| ------------------------------------- | --------: | -----: | ---: | ----------: | ---------: | --------: | -------------------: | ----------------: | ------------------------: |
| synthetic (fast-import, 100k / 10k)   |   100,000 | 10,000 | 0 ms |      460 ms |      <1 ms |     20 ms |               168 MB |              0 MB | 47 ms (200 entries dirty) |
| qemu/qemu, treeless, full main        |   134,458 |      – | 0 ms |    1,229 ms |      <1 ms |     38 ms |               333 MB |              1 MB |                n/a (bare) |
| qemu/qemu, treeless, oldest 100k      |    99,912 |      – |    – |           – |          – |         – |                    – |                 – |                         – |
| python/cpython, treeless, full main   |   133,992 |      – | 0 ms |    1,171 ms |      <1 ms |     61 ms | 432 MB (1,238 lanes) |              3 MB |                n/a (bare) |
| qemu/qemu, depth 1                    |         1 | 11,488 | 0 ms |           – |          – |         – |                    – |                 – |             31 ms (clean) |
| torvalds/linux, treeless, full master | 1,501,435 |      – | 0 ms |   41,014 ms |       1 ms | 12,145 ms |             8,798 MB |          2,055 MB |                n/a (bare) |

Fixture costs: synthetic 6.5 s to generate (69 MB); qemu treeless clone 4 s (62 MB);
qemu depth-1 clone 7 s (208 MB); cpython treeless 5 s (56 MB); linux treeless 73 s
(831 MB). libgit2 (git2 0.20) opens partial clones (`repositoryformatversion = 1`
with `remote.origin.promisor`) without complaint. A blobless clone with a lazy
checkout of 11k files took ten minutes and is not usable as a fixture.

### Goals (the ticket's acceptance criteria, mapped)

| AC                                                                | What this ticket delivers                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Benchmark suite against a large public repository runs in CI   | `git-real-bench` (new workspace binary crate) + a `bench` job in `ci.yml` that prepares three fixtures (qemu graph, qemu worktree, synthetic), runs the suite, writes a job summary and an artifact, and fails on a budget miss (§3, §4) |
| 2. Open + first graph paint < 3 s at 100k commits                 | metric `openToFirstPageMs` (open + graph build + first page serialized), budget 3000 ms, on the two 100k-commit fixtures (§3.4); end-to-end paint measured in the acceptance walk (§13)                                                  |
| 3. Status refresh < 500 ms at 10k files                           | metric `statusMs`, budget 500 ms, on the 11,488-file qemu worktree and the 10,000-file synthetic worktree (§3.4)                                                                                                                         |
| 4. All Git operations off the UI thread; UI never blocks > 100 ms | Rust contract test: every `#[tauri::command]` body calls `run_blocking`, and the handler count matches `generate_handler!` (§5); main-thread frame gaps measured in the walk (§13)                                                       |
| 5. Memory bounded while scrolling the full history                | metric `rssGrowthMb` while paging the whole history, budget 64 MB (§3.4); explicit `gcTime` on log-page queries so the webview keeps only recently viewed pages (§6); webview RSS sampled in the walk (§13)                              |

### Non-goals (each is a follow-up ticket or already one)

- Repositories of 1M+ commits (the Linux kernel: 41 s build, 8.8 GB). The AC targets
  100k; see R5 and §12.
- Changing the walk, lane layout or page shape. Nothing in the hot path changes in
  this ticket; the harness measures what exists.
- Benchmarking file history, blame, diff or search. File history is O(commits) with
  a tree lookup per row and is named in the follow-up ticket.
- A headless webview timing in CI. There is no display in CI and no WebDriver
  tooling in this environment; paint time is measured once in the acceptance walk.
- Budget scaling by runner speed or commit count. Budgets are the AC's constants.

## 2. Decisions (rulings)

Shape: question / options / selected / cost if wrong. **P** = person-grade (also a
Jira comment), **R** = routine (ledger only).

- **R1 (P)** Benchmark fixtures. A) the Linux kernel as the CI subject;
  B) `qemu/qemu` twice (a treeless bare clone trimmed to its oldest 100,000 commits
  by date order for the graph, and a depth-1 clone with 11,488 files for status) plus
  a deterministic synthetic repository (100,000 commits, 10,000 files, built with
  `git fast-import`) that needs no network; C) synthetic only. **Selected B.** The
  kernel is 15× the AC's size, clones in 73 s at 831 MB and needs 9 GB to walk,
  which exceeds the runner's 7 GB; qemu has both the commit count and the file count
  the AC names, clones in 11 s total at 270 MB, and the "oldest 100k commits" cut is
  stable as the project grows, so the number is reproducible across runs. The
  synthetic fixture keeps the suite runnable offline and gives a second, structurally
  different 100k graph. The kernel stays available as an informational run
  (`run --no-assert`). Cost if wrong: one URL constant and two size constants.
- **R2 (P)** What "open and first graph paint" measures in CI. A) one backend span
  from `RepoSession::open` through `log_summary` (the walk) to the first 500-row page
  serialized to JSON, with the AC's full 3000 ms budget; B) the same span with a
  2000 ms budget, reserving a second for IPC and render; C) a headless webview timing.
  **Selected A.** The backend span is the only part that scales with the repository
  (1.2 s at 134k commits); IPC moves ~150 KB and the panel renders ~40 virtual rows,
  tens of milliseconds, which the acceptance walk measures end to end and records.
  C is not possible without a display. The `notify` watcher that `open_repo` also
  starts (`commands/repo.rs:121-147`) is outside the span; walk step 1 covers it.
  Cost if wrong: one constant.
- **R3 (P)** Budgets fail the build. A) the `bench` job runs on the same `push` and
  `pull_request` triggers as the other jobs and exits non-zero on any budget miss,
  with the AC's numbers unscaled; B) report-only; C) enforce with a CI multiplier.
  **Selected A.** The measured values have 2.5× (graph) and 10× (status) headroom
  against GitHub's runners, and a budget nobody enforces is a dashboard, not
  validation. Cost if wrong: one `--no-assert` flag turns the job into a report.
- **R4 (P)** The memory bound. A) backend: RSS growth while paging the whole history
  through `log_page` ≤ 64 MB (measured 0–3 MB at 100–134k); front end: log-page
  queries get `gcTime: LOG_PAGE_GC_MS` (60 s) so the React Query cache holds only
  pages viewed in the last minute instead of every page seen in five; B) explicit
  eviction of pages far from the viewport; C) no front-end change (default 5 min).
  **Selected A.** The backend cache is the graph itself (one allocation per repo,
  bounded by its size; 168–432 MB at 100–134k commits, see R5), so "bounded while
  scrolling" means paging must not accumulate, which 64 MB asserts with margin.
  The `gcTime` is a one-line bound with a test; a page scrolled back to after a
  minute refetches in under a millisecond of backend time. Cost if wrong: one
  constant, or revert to the default.
- **R5 (P)** Repositories of 1M+ commits. A) make the walk incremental and the lane
  storage compact in this ticket; B) ticket it with the measurements. **Selected B.**
  The AC fixes 100k commits, which the current design meets with headroom; the
  kernel needs a different cache shape (streamed first page, edges not materialized
  per row, ~250 B/row instead of ~2–6 KB/row), which touches `walk`, `lanes`,
  `cache`, `log_page`, `search_log` and `file_history`: a large blast radius and a
  design a person should weigh. Cost if wrong: the harness already reports the
  kernel numbers, so the follow-up starts with a baseline.
- **R6 (R)** Placement: a new binary crate `src-tauri/crates/git-real-bench`
  (workspace member, never bundled) that depends on `git-real-core`, `git2`
  (`default-features = false`, for the index count), `serde` and `serde_json`. No new
  crate enters the tree: arguments are parsed by hand, timings use `std::time`, RSS
  is the `VmRSS` line of `/proc/self/status` (Linux only; `None` elsewhere, the
  crate is a dev tool and not part of `git-real-core`). This is a stated exception
  to ADR 0002's "one crate, no premature multi-crate" rule: the binary is a tool
  with its own dependencies and lifecycle, not app code; ADR 0004 records it.
- **R7 (R)** Fixtures are built through the `git` CLI (`fast-import`, `clone`,
  `rev-list`, `update-ref`, `checkout`), which the project already requires; the
  harness never fetches with libgit2. Commands are built with
  `git_real_core::git_cli::{locate, command}` (which set `LC_ALL=C`,
  `GIT_TERMINAL_PROMPT=0` and strip `GIT_DIR`/`GIT_WORK_TREE` from the
  environment); the bench crate has no PATH lookup of its own.
- **R8 (R)** The harness measures the core API (`RepoSession`) directly, not the
  Tauri commands: the commands are `run_blocking` plus a mutex around the same calls,
  and the IPC layer needs a running app.
- **R9 (R)** The `bench` job is a third job in `ci.yml` (same triggers as the others,
  `ubuntu-latest`, `timeout-minutes: 30`), with fixtures cached under
  `~/.cache/git-real-bench` by `actions/cache@v4`, results in the step summary and a
  JSON artifact kept 30 days. It does not install the Tauri system packages: the
  bench crate builds with a C compiler alone.
- **R10 (R)** The off-UI-thread guard is a source-scanning integration test in
  `src-tauri/tests/offload_contract.rs` rather than a proc macro or a runtime hook:
  the rule is lexical (every handler body contains `run_blocking(`) and the test
  fails with the offending function's name.
- **R11 (R)** Contract tests for the new job live in `src/test/release.test.ts`
  (new `describe("bench workflow")`), which already parses `ci.yml` with in-file
  helpers; no helper module is extracted.
- **R12 (R)** Docs: README gains a `Benchmarks` section between `Development` and
  `Releasing` and a `git-real-bench/` line under `Project layout`; ADR 0004 records
  R1–R6 because the 1M+ follow-up and any budget change build on them.
- **R13 (R)** Fixture markers are sibling files (`<dir>.fixture.json`) so a worktree
  fixture's status stays clean; `prepare` is idempotent on a matching marker and
  refuses a directory that exists without one.
- **R14 (R)** Where the tester's committed signatures and the architect's sheet
  differed (`BenchError` lives in `git.rs`; `cli::Command` shape), the tests won.
- **R15 (R)** Under `--no-assert` the violation lines are printed before the `INFO`
  trailer, so an informational run still shows what exceeded a budget.
- **R16 (R)** The Markdown `result` column is `info` only on violating rows under
  `--no-assert`; rows within budget stay `pass`.
- **R17 (R)** Review follow-ups fixed in-ticket: value flags reject a following
  `--flag` or a missing token (`‹flag› needs a value`); a stdin write error other
  than `BrokenPipe` is surfaced; the offload scanner accepts
  `#[tauri::command(...)]` arguments and ignores `//` comments. Accepted as is: the
  fast-import stream is buffered in memory (about 20 MB at 100k commits).

## 3. Benchmark harness (`git-real-bench`)

### 3.1 Crate

```
src-tauri/crates/git-real-bench/
  Cargo.toml          [[bin]] git-real-bench; publish = false
  src/main.rs         `fn main() { std::process::exit(app::run(args, &mut stdout, &mut stderr)) }`, nothing else
  src/app.rs          run(args: &[String], out: &mut impl Write, err: &mut impl Write) -> i32 (dispatch + exit-code mapping)
  src/cli.rs          Command, parse(&[String]) -> Result<Command, UsageError>, USAGE text
  src/fixtures.rs     FixtureKind, prepare(), fast_import_stream(), marker read/write (split into fixtures/{mod,synthetic}.rs if it passes ~300 lines; widen the CI cache glob to match)
  src/measure.rs      measure(path, label) -> Result<Measurement, BenchError>
  src/budgets.rs      constants, evaluate(&Measurement) -> Vec<Violation>
  src/report.rs       Report { version, host, budgets, results, passed }; JSON + text table + Markdown
  src/rss.rs          current_rss_mb() -> Option<u64> (Linux: /proc/self/status), parse_vm_rss(&str) -> Option<u64> (pure)
  src/git.rs          run_git(args, cwd) -> Result<String, BenchError> over git_real_core::git_cli::{locate, command}; git_available()
  tests/cli.rs        end-to-end on a tiny synthetic fixture (gated on git)
```

`src-tauri/Cargo.toml` `members` gains `"crates/git-real-bench"`. `tauri build`
bundles only the `git-real` package; the bench binary never ships.

### 3.2 Command line (exact)

```
git-real-bench prepare synthetic <dir> [--commits N] [--files M]
git-real-bench prepare public-graph <dir> [--url URL] [--commits N]
git-real-bench prepare public-worktree <dir> [--url URL]
git-real-bench run <repo>... [--json <file>] [--summary <file>] [--no-assert]
git-real-bench --help
```

Defaults: `--commits 100000`, `--files 10000`, `--url https://github.com/qemu/qemu`.
Exit codes: `0` all budgets met (or `--no-assert`); `1` a budget exceeded; `2` usage
error (prints `USAGE` to stderr); `3` fixture or measurement error (`error: ‹message›`
on stderr). Unknown flags and a missing `<dir>`/`<repo>` are usage errors.

### 3.3 Fixtures

Every `prepare` writes `<dir>.fixture.json`:
`{ "version": 1, "kind": "synthetic" | "publicGraph" | "publicWorktree", "params": { … }, "head": "‹oid›" }`.
If the marker exists with equal `kind` and `params`, `prepare` prints
`fixture ready: ‹dir› (cached)` and exits 0. If `<dir>` exists without a matching
marker: `error: ‹dir› exists but is not a matching fixture; remove it or choose another directory`
(exit 3). If `git` is not on `PATH`: `error: git is required to prepare fixtures`
(exit 3). A failed git step reports `error: git ‹args› failed: ‹stderr›` and removes
the partial `<dir>`.

**synthetic** (`params: { commits, files }`): `git init -q <dir>`, then a
`fast-import` stream generated by `fast_import_stream(commits, files, &mut impl Write)`,
deterministic (fixed identity `Bench <bench@example.com>`, timestamps
`1600000000 + 60·i`, no randomness), so the resulting oids are stable:

- Commit 1 on `refs/heads/main`, message `initial tree`, creates `files` blobs at
  `dir‹i/100:03›/sub‹(i/10)%10›/file‹i:05›.txt` with content `file ‹i›\n`.
- Commits 2..=commits, one per minute: every 40th index starts a topic of 5 commits
  on `refs/heads/scratch` (message `topic-‹t› change ‹k›`, from the main tip, each
  touching file `c % files` with `topic ‹c›\n`); 20 indices after the topic started,
  `main` merges it (`Merge topic-‹t›`, two parents). Every 10th topic is left
  unmerged and kept as `refs/heads/topic-‹t›`. Every other index is a plain `main`
  commit `commit ‹c›` touching file `c % files` with `‹c›\n`.
- `refs/tags/v0.‹c/2000›` on every 2,000th main commit (lightweight).
- `done`. Then `git update-ref -d refs/heads/scratch`, `git checkout -q main`, and a
  deterministic dirty state: append `dirty\n` to files `0..min(100, files)` and
  create untracked `dir001/sub1/new‹i›.txt` (`new\n`) for i in 0..100.

At the defaults: 100,000 commits, 10,000 files, 250 topic branches, 50 tags, status
200 entries. The generator is pure and unit-tested at small sizes.

**public-graph** (`params: { url, commits }`):
`git clone --quiet --bare --single-branch --filter=tree:0 ‹url› <dir>`; then the
`commits`-th line of `git rev-list --date-order --reverse HEAD` becomes
`refs/heads/bench` (`git update-ref`), HEAD is pointed at it (`git symbolic-ref`),
and every other ref is deleted through `git update-ref --stdin` (`delete` lines). If
the history has fewer commits than requested, the tip stays HEAD (no trim). The
marker records the chosen oid; `git rev-list --count HEAD` after trimming qemu main
is 99,912.

**public-worktree** (`params: { url }`):
`git clone --quiet --depth 1 --single-branch ‹url› <dir>`.

### 3.4 Measurement (`run`)

For each `<repo>` in order (label = the directory's file name):

1. `rssStartMb`.
2. `RepoSession::open(path)` → `openMs`. Failure: `error: cannot open ‹path›: ‹err›`, exit 3.
3. `log_summary()` → `graphBuildMs`, `commits` (= `total`), `maxLanes`.
4. `log_page(generation, 0, 500)` + `serde_json::to_vec(&page)` → `firstPageMs`.
5. `openToFirstPageMs` = one `Instant` span around steps 2–4.
6. `rssBeforePagingMb`; then every page of 500 rows from 0 to `commits`, each
   serialized → `pageAllMs`; `rssAfterPagingMb`; `rssGrowthMb = max(0, after − before)`.
7. If `RepoSession::summary().is_bare` is false: `status()` → `statusMs`,
   `statusEntries`, and `files` = index entry count (the bench's own git2 handle,
   `Repository::open(path)?.index()?.len()`, because `RepoSession::repo()` is
   crate-private); bare → all three `null`.
8. `log_summary()` again → `graphRefreshMs` (cache-hit path, informational).

No warm-up and one sample per metric: the cold run is what the user experiences.

### 3.5 Budgets (`budgets.rs`)

```rust
pub const OPEN_TO_FIRST_PAGE_MS: u128 = 3_000; // AC 2
pub const STATUS_MS: u128 = 500;               // AC 3
pub const PAGING_RSS_GROWTH_MB: u64 = 64;      // AC 5
```

`evaluate` returns one `Violation { metric, value, budget }` per exceeded budget;
`statusMs` is skipped when `null`; `rssGrowthMb` is skipped when RSS is unavailable.
Message shape: `‹label›: openToFirstPageMs 3412 exceeds 3000`.

### 3.6 Report (`report.rs`)

stdout, always:

```
fixture         commits    files  open→first page    status  paging RSS growth
synthetic        100000    10000           461 ms     47 ms              0 MB
qemu-graph        99912        -          1204 ms         -              1 MB
budgets: open→first page 3000 ms, status 500 ms, paging RSS growth 64 MB
PASS
```

(`FAIL` preceded by one violation line each; with `--no-assert`, the violation lines
are still printed and the trailer is `INFO`, always the last line — R15.) Columns
widen to the longest cell, so a long label shifts the layout.

`--summary <file>` appends a Markdown table with the same columns plus a `result`
column under a `### Git Real benchmarks` heading: `pass` for a row within budget,
`fail` for a violating row, and `info` for a violating row under `--no-assert` — R16.
`--json <file>` writes:

```json
{
  "version": 1,
  "host": { "os": "linux", "cpus": 4 },
  "budgets": { "openToFirstPageMs": 3000, "statusMs": 500, "pagingRssGrowthMb": 64 },
  "results": [
    {
      "label": "synthetic",
      "path": "…",
      "commits": 100000,
      "files": 10000,
      "maxLanes": 2,
      "openMs": 0,
      "graphBuildMs": 460,
      "firstPageMs": 0,
      "openToFirstPageMs": 461,
      "pageAllMs": 20,
      "rssBeforePagingMb": 168,
      "rssAfterPagingMb": 168,
      "rssGrowthMb": 0,
      "statusMs": 47,
      "statusEntries": 200,
      "graphRefreshMs": 7,
      "violations": []
    }
  ],
  "passed": true
}
```

camelCase keys; `null` for unavailable values; `passed` is `true` under `--no-assert`
only if there are no violations (the flag changes the exit code, not the record).

## 4. CI job (`.github/workflows/ci.yml`)

```yaml
bench:
  name: Benchmarks (large repositories)
  runs-on: ubuntu-latest
  timeout-minutes: 30
  steps:
    - name: Checkout
      uses: actions/checkout@v4
    - name: Set up Rust
      uses: dtolnay/rust-toolchain@stable
    - name: Cache Rust build
      uses: Swatinem/rust-cache@v2
      with:
        workspaces: src-tauri
    - name: Build the benchmark harness
      working-directory: src-tauri
      run: cargo build --release -p git-real-bench
    - name: Restore benchmark fixtures
      uses: actions/cache@v4
      with:
        path: ~/.cache/git-real-bench
        key: git-real-bench-fixtures-v1-${{ hashFiles('src-tauri/crates/git-real-bench/src/fixtures.rs') }}
    - name: Prepare fixtures
      run: |
        src-tauri/target/release/git-real-bench prepare synthetic ~/.cache/git-real-bench/synthetic
        src-tauri/target/release/git-real-bench prepare public-graph ~/.cache/git-real-bench/qemu-graph
        src-tauri/target/release/git-real-bench prepare public-worktree ~/.cache/git-real-bench/qemu-worktree
    - name: Run benchmarks
      run: >
        src-tauri/target/release/git-real-bench run
        ~/.cache/git-real-bench/synthetic
        ~/.cache/git-real-bench/qemu-graph
        ~/.cache/git-real-bench/qemu-worktree
        --json bench-results.json --summary "$GITHUB_STEP_SUMMARY"
    - name: Upload results
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: bench-results-${{ github.sha }}
        path: bench-results.json
        retention-days: 30
        if-no-files-found: ignore
```

Contract tests (`src/test/release.test.ts`, `describe("bench workflow")`):
`has a bench job on ubuntu-latest with a timeout`, `builds git-real-bench in release
before preparing fixtures`, `prepares the synthetic, public-graph and public-worktree
fixtures under the cached directory`, `runs the three fixtures with a JSON report and
the step summary`, `uploads the results artifact even on failure`, `never continues on
error` (no `continue-on-error` anywhere in the job), `README documents the benchmark
commands` (the README `Benchmarks` section contains the three `prepare` lines and
the `run` line).

## 5. Off-UI-thread guard (`src-tauri/tests/offload_contract.rs`)

Reads every `src/commands/*.rs` from `CARGO_MANIFEST_DIR`. For each
`#[tauri::command]` attribute, the handler is the text from the attribute to the
function's closing brace, which rustfmt keeps at column 0 (`"\n}\n"`), so a helper
or test module after the last command can never supply the call on its behalf. The
function name is the identifier after `fn `; the handler text must contain
`run_blocking(`. The scanner is a plain function over `&str` so it can be tested on
inline sources. Tests: `every_command_runs_inside_run_blocking` (lists every
offender by file and name in the failure message), `handler_names_match_generate_handler`
(the set of handler names equals the set of last path segments inside
`generate_handler![ … ]` in `src/lib.rs`, today 86 names, with the difference printed
either way), `scanner_names_a_bare_handler` (inline source with one wrapped and one
bare handler names only the bare one), and `scanner_stops_at_the_closing_brace`
(inline source where `run_blocking(` appears only in a helper after the handler
still names the handler).

## 6. Front-end page cache bound

`src/features/graph/useLogPages.ts`, beside `logPageOptions` (it is a cache policy,
not graph geometry, so it does not go in `model/layout.ts`):
`export const LOG_PAGE_GC_MS = 60_000;` with the doc comment `/** How long a log page
nobody is viewing stays cached; bounds memory while scrolling a long history. */`.
`logPageOptions` adds `gcTime: LOG_PAGE_GC_MS`; the two imperative `fetchQuery`
callers in `GraphPanel.tsx` share the options and need no change. Tests
(`useLogPages.test.tsx`): `page queries carry gcTime LOG_PAGE_GC_MS`
(`logPageOptions(...).gcTime`), and `a page no longer in view is collected after
LOG_PAGE_GC_MS`: `renderHookWithProviders` takes a no-argument callback, so the hook
reads `first`/`last` from closure variables; load pages 0–1 with real timers and
`waitFor`, then `vi.useFakeTimers()`, set the range to page 40 and `rerender()`,
`await vi.advanceTimersByTimeAsync(LOG_PAGE_GC_MS)`, and assert the page 0 query is
gone from `queryClient.getQueryCache()` while page 40 remains; restore real timers
in `afterEach`.

## 7. Docs

- README `## Benchmarks` (between `Development` and `Releasing`): what the suite
  measures and the three budgets; the three `prepare` commands and the `run` command
  with `cargo run --release -p git-real-bench --` from `src-tauri`; where CI shows
  results (job summary, `bench-results-‹sha›` artifact); the informational kernel
  run (`prepare public-graph … --url https://github.com/torvalds/linux --commits 2000000`,
  then `run … --no-assert`) with its measured numbers.
- README `## Project layout` gains `src-tauri/crates/git-real-bench/` with a
  one-line description.
- `docs/adr/0004-performance-budgets-and-benchmarks.md`: context, decision
  (R1–R6, R6 stated as the exception to ADR 0002's single-crate rule), consequences
  (the 1M+ follow-up; budgets change only with an ADR note).

## 8. Error handling

| Where                  | Condition                                           | Behaviour                                                              |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `prepare`              | `git` missing                                       | `error: git is required to prepare fixtures`, exit 3                   |
| `prepare`              | dir exists, marker missing or different             | `error: ‹dir› exists but is not a matching fixture; …`, exit 3         |
| `prepare`              | git step fails                                      | `error: git ‹args› failed: ‹stderr›`, partial dir removed, exit 3      |
| `prepare public-graph` | fewer commits than requested                        | no trim; marker records the real head                                  |
| `run`                  | path not a repository                               | `error: cannot open ‹path›: ‹err›`, exit 3, nothing written            |
| `run`                  | bare repository                                     | `statusMs`, `statusEntries`, `files` are `null`; status budget skipped |
| `run`                  | `/proc/self/status` unreadable or without `VmRSS`   | RSS fields `null`; growth budget skipped                               |
| `run`                  | `--json`/`--summary` unwritable                     | `error: cannot write ‹file›: ‹err›`, exit 3 (after printing the table) |
| cli                    | unknown flag, missing operand, unknown fixture kind | `USAGE` on stderr, exit 2                                              |

## 9. Testing strategy

- `cli.rs`: table of argument vectors → `Command` or `UsageError` (every subcommand,
  every flag, defaults, missing operand, unknown flag, `--help`).
- `fixtures.rs`: `fast_import_stream` at `commits = 50, files = 7` (exact
  first commit header, file paths, tag and topic cadence at small parameters, `done`
  terminator); marker round trip and mismatch detection; `prepare synthetic` on a
  temp dir (gated on `git_available()`) then counts via git2: commits, index length,
  tags, a `topic-` ref, 200 status entries; `prepare` twice prints `(cached)`;
  `public-graph` and the trim logic exercised against a _local_ bare repository
  (`--url` takes a path) with `--commits 5`: HEAD is the 5th oldest commit, only
  `refs/heads/bench` remains.
- `measure.rs`: on a tiny synthetic fixture: every field present, `commits` equals
  the fixture, `openToFirstPageMs >= openMs`, `files` equals the index length, bare
  fixture → `statusMs` is `None`.
- `budgets.rs`: `evaluate` on hand-built measurements: none, one, all violations;
  skipped when `None`.
- `rss.rs`: `parse_vm_rss` on a real `/proc/self/status` excerpt (kB → MB), on text
  without `VmRSS`, on a malformed number; `current_rss_mb()` is `Some` on Linux.
- `app.rs`: `run` with captured `out`/`err` buffers: `--help` → 0 and `USAGE` on
  stdout; bad args → 2 and `USAGE` on stderr; `run` on a non-repository → 3 and
  `error: cannot open …`; a violation → 1, and 0 with `--no-assert`.
- `report.rs`: JSON keys and `null`s; text table alignment on two rows; Markdown
  summary heading and `result` column; `passed` semantics with `--no-assert`.
- `tests/cli.rs`: runs the built binary (`env!("CARGO_BIN_EXE_git-real-bench")`):
  `--help` exit 0, bad args exit 2, `run` on a non-repo exit 3, `prepare synthetic
--commits 30 --files 5` then `run --json` exit 0 with a parseable report.
- Rust contract test (§5) and Vitest contract tests (§4, §6) as listed.
- Coverage: 100 % on the front-end change; the bench crate's unit tests cover every
  branch of `cli`, `budgets`, `report` and the stream generator; `measure`/`prepare`
  paths that need git are gated and run in CI.

## 10. Verification gate

From `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo fmt --all --check`. From the root: `npm run test:coverage` at 100 %,
`npm run lint`, `npm run typecheck`. Plus one local release run of the suite on the
three fixtures (numbers into the ledger and the Jira summary) and the coverage
agent's and architect's explicit approval.

## 11. Wire and persisted shapes

None. No IPC command, no settings, no new error kind. The JSON report is a CI
artifact with `"version": 1`.

## 12. Follow-up tickets opened at the end of the run

- **Commit graph at 1M+ commits**: incremental walk (first page before the walk
  completes), compact lane storage (edges derived per page, not stored per row),
  `file_history` without a full scan. Baseline: Linux kernel 1.5M commits, 41 s
  build, 8.8 GB RSS, +2 GB while paging; cpython 134k at 1,238 lanes, 432 MB.

## 13. Acceptance walk

Automated where the WebKit remote inspector driver works (memory note
`tauri-webview-automation`), on the synthetic fixture (100k commits, 10k files, 200
dirty entries), recorded in the ledger and the Jira summary:

1. Open the fixture through the stubbed folder picker; time from the `open_repo`
   invoke to the first `GraphRow` in the DOM. Expect under 3,000 ms.
2. A `requestAnimationFrame` gap monitor runs from before the open through a scripted
   scroll of the whole history (100k rows at 28 px, 25 jumps). Record the longest gap;
   expect ≤ 100 ms.
3. Sample the WebKitWebProcess RSS after the first paint, after the scroll, and after
   a second scroll back to the top; the second scroll must not grow it further than
   the first.
4. Status refresh after touching a file: the worktree panel updates; backend
   `statusMs` is already asserted by the suite.

If the driver cannot be brought up, these become `USER CHECKS`.
