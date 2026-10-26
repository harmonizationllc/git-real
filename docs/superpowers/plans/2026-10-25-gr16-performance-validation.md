# GR-16 Performance Validation on Large Repositories Implementation Plan

> For agentic workers: tests first, by the test role; the developer writes the minimum code that makes them pass and never edits test files. Every dispatch: `git add <explicit paths>` only; never `git reset`, `git commit --amend`, `git stash`, `git add -A`, `git add -u`, `git push`, or anything that rewrites history. Run `git log -3` before committing; other agents may be committing to this branch at the same time.

**Goal:** A benchmark harness (`git-real-bench`) measures the ticket's numbers against a real public repository and a synthetic one on every CI run and fails the build when a budget is exceeded; a Rust contract test enforces the off-UI-thread rule; the front end bounds its log-page cache.

**Architecture:** A new workspace binary crate `src-tauri/crates/git-real-bench` drives `git-real-core`'s `RepoSession` directly (open, graph build, page, status), builds fixtures through the `git` CLI (`fast-import`, treeless and depth-1 clones), evaluates three constant budgets and writes a text table, a Markdown job summary and a JSON report. A third `bench` job in `ci.yml` runs it with cached fixtures. `src-tauri/tests/offload_contract.rs` scans the command sources. `useLogPages` gains `gcTime: LOG_PAGE_GC_MS`. Nothing in the app's hot path changes.

**Spec:** `docs/superpowers/specs/2026-10-25-gr16-performance-validation-design.md` (rulings R1–R17 are decided; do not reopen them). Exact copy, CLI, JSON keys and the YAML are in the spec and are normative; this plan only lists files and tests.

**Branch:** `feature/gr-16-performance-validation` from `main` (4644b29).

## Global Constraints

- **Standing rules.** Tests first, by the test role; the developer never edits test files. The only importer of `@tauri-apps/*` is `src/lib/ipc`. `git2` stays `default-features = false` everywhere, including the bench crate. **No new crate enters the tree** (the bench crate depends only on `git-real-core`, `git2`, `serde`, `serde_json`, and `tempfile` as a dev-dependency); no `clap`, no `criterion`, no `tokio`. Nothing from the bench crate is imported by `git-real-core` or the app crate. Platform-specific code (`/proc`) lives only in `git-real-bench/src/rss.rs`. 100 % statements/branches/functions/lines on the front end. Commits carry the repo-local noreply author email. `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, ESLint, `prettier --check .` clean.
- **Git CLI use (R7):** every git subprocess in the bench crate is built with `git_real_core::git_cli::{locate, command}`; no `Command::new("git")`. Tests that need git are gated on a local `git_available()` (same shape as `git-real-core/tests/common/mod.rs:520-535`, honouring the same opt-out env var) and are skipped, not failed, without it.
- **CLI (exact, spec §3.2):** `prepare synthetic <dir> [--commits N] [--files M]`, `prepare public-graph <dir> [--url URL] [--commits N]`, `prepare public-worktree <dir> [--url URL]`, `run <repo>... [--json <file>] [--summary <file>] [--no-assert]`, `--help`. Defaults `100000`, `10000`, `https://github.com/qemu/qemu`. Exit codes 0 / 1 budget / 2 usage / 3 error. Error copy exactly as spec §8.
- **Fixtures (exact, spec §3.3):** sibling marker `<dir>.fixture.json` `{ "version": 1, "kind": "synthetic" | "publicGraph" | "publicWorktree", "params": {…}, "head": "‹oid›" }`; `fixture ready: ‹dir› (cached)` on a match; synthetic stream shape, identity `Bench <bench@example.com>`, timestamps `1600000000 + 60·i`, paths `dir‹i/100:03›/sub‹(i/10)%10›/file‹i:05›.txt`, topic every 40th index (5 commits on `refs/heads/scratch`, merged 20 indices later, every 10th topic kept unmerged as `refs/heads/topic-‹t›`), lightweight tag `v0.‹c/2000›` every 2,000th main commit, then `git update-ref -d refs/heads/scratch`, `git checkout -q main`, dirty state (append `dirty\n` to files 0..99, untracked `dir001/sub1/new‹i›.txt` for 0..99). Public graph: `git clone --quiet --bare --single-branch --filter=tree:0`, trim to the `commits`-th line of `git rev-list --date-order --reverse HEAD` as `refs/heads/bench`, HEAD → it, delete every other ref via `git update-ref --stdin`; no trim when the history is shorter. Public worktree: `git clone --quiet --depth 1 --single-branch`.
- **Measurement and budgets (exact, spec §3.4–3.5):** fields `openMs`, `graphBuildMs`, `firstPageMs`, `openToFirstPageMs` (one span), `pageAllMs`, `rssBeforePagingMb`, `rssAfterPagingMb`, `rssGrowthMb`, `statusMs`, `statusEntries`, `files`, `graphRefreshMs`, `commits`, `maxLanes`, `label`, `path`, `violations`. Pages of 500 serialized with `serde_json::to_vec`. Bare check through `RepoSession::summary().is_bare`; `files` via the bench's own `git2::Repository::open(path)?.index()?.len()`. Budgets `OPEN_TO_FIRST_PAGE_MS = 3_000`, `STATUS_MS = 500`, `PAGING_RSS_GROWTH_MB = 64`; violation text `‹label›: ‹metric› ‹value› exceeds ‹budget›`.
- **Report (exact, spec §3.6):** stdout table columns `fixture commits files open→first page status paging RSS growth`, then `budgets: …`, then `PASS` / `FAIL` + violation lines / `INFO`; `--summary` appends `### Git Real benchmarks` + Markdown table with a `result` column (`pass`/`fail`/`info`); `--json` shape with `"version": 1`, camelCase, `null` for unavailable values, `passed` independent of `--no-assert`.
- **RSS:** `VmRSS` line of `/proc/self/status`, kB → MB, `None` when unreadable or absent (`rss.rs`, pure `parse_vm_rss`).
- **Offload contract (spec §5):** handler text runs from `#[tauri::command]` to the first `"\n}\n"` after it; name = identifier after `fn `; must contain `run_blocking(`; names compared as sets against `generate_handler![…]` in `src/lib.rs` (86 today).
- **Front end (spec §6):** `export const LOG_PAGE_GC_MS = 60_000;` in `src/features/graph/useLogPages.ts` with the spec's doc comment; `gcTime: LOG_PAGE_GC_MS` in `logPageOptions`; nothing else in `src/` changes.
- **CI (spec §4, verbatim YAML):** job `bench`, name `Benchmarks (large repositories)`, `ubuntu-latest`, `timeout-minutes: 30`, no apt step, `cargo build --release -p git-real-bench`, `actions/cache@v4` on `~/.cache/git-real-bench` keyed `git-real-bench-fixtures-v1-${{ hashFiles('src-tauri/crates/git-real-bench/src/fixtures.rs', 'src-tauri/crates/git-real-bench/src/cli.rs') }}` (the defaults live in `cli.rs`; widen the glob to `src/fixtures/**` if the module is split), three `prepare` lines, one `run` line with `--json bench-results.json --summary "$GITHUB_STEP_SUMMARY"`, `actions/upload-artifact@v4` `bench-results-${{ github.sha }}` with `if: always()`, `retention-days: 30`, `if-no-files-found: ignore`. No `continue-on-error`.
- Checks: from `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`, `cargo tree -i openssl-sys` prints nothing; from the root: `npm run test:coverage` at 100 %, `npm run lint`, `npm run typecheck`, `npx prettier --check .`; and once, by the Cycle 1 developer, a release run of the suite on a full-size synthetic fixture and the two qemu fixtures with the numbers in the report (fixtures under `/tmp/claude-1000/-home-gorlox-code-git-real/4e138a53-1ea2-4bc5-b8ec-4967f22f8ebb/scratchpad/afk/GR-16/fixtures/bench-*`, never inside the repo).

## Review Focus

- The generator must be deterministic: same parameters, same oids (`prepare` twice on two temp dirs gives equal `head` in the markers).
- `prepare` must never delete a directory it did not create in this invocation (the "exists but is not a matching fixture" branch refuses; only a failed step removes the partial dir created by that same step).
- `measure` takes exactly one sample per metric, no warm-up, in the spec's order; `openToFirstPageMs` is one span, not a sum.
- Nothing in `git-real-core` or `src-tauri/src` changes except `src-tauri/Cargo.toml` `members`.
- The contract test must fail with a useful message: file, handler name, and the set difference.
- Fake timers in the gcTime test must be enabled only after the first pages resolved with real timers (spec §6), or `waitFor` stalls.

## Deviations and calls (decided here; the implementer does not reopen them)

- `tests/cli.rs` uses `env!("CARGO_BIN_EXE_git-real-bench")` and a `tempfile::TempDir`; it builds a synthetic fixture with `--commits 30 --files 5` (sub-second) and runs the suite on it; it also runs `run` on the empty temp dir to get exit 3.
- The `public-graph` trim is tested against a _local_ bare repository created in the test (a `--url` that is a filesystem path works with `git clone`); no test touches the network.
- `host.cpus` uses `std::thread::available_parallelism()` (`1` on error); `host.os` is `std::env::consts::OS`.
- `Measurement` and `Report` derive `Serialize` with `#[serde(rename_all = "camelCase")]`; durations are stored as `u128` milliseconds; `Option<T>` fields serialize as `null`.
- `fixtures.rs` may be split into `fixtures/mod.rs` + `fixtures/synthetic.rs` + `fixtures/public.rs` if it passes ~300 lines; the Cycle 2 tester then pins the CI cache glob `src/fixtures/**`.
- ADR 0004 is short (status, context, decision R1–R6, consequences).

---

## Cycle 1 — Bench crate and offload contract (Tasks 1–4, Rust only)

### Task 1: Crate skeleton, `cli`, `app`, `rss`, `git`, `budgets`, `report`

**Files:** create `src-tauri/crates/git-real-bench/Cargo.toml`, `src/main.rs`, `src/app.rs`, `src/cli.rs`, `src/rss.rs`, `src/git.rs`, `src/budgets.rs`, `src/report.rs`; edit `src-tauri/Cargo.toml` (`members`).

**Tests (in each module's `#[cfg(test)]`):**

- `cli`: `parses_prepare_synthetic_with_defaults`, `parses_prepare_synthetic_with_sizes`, `parses_prepare_public_graph_with_url_and_commits`, `parses_prepare_public_worktree`, `parses_run_with_repos_json_summary_and_no_assert`, `help_flag`, `rejects_missing_dir`, `rejects_missing_repos`, `rejects_unknown_flag`, `rejects_unknown_fixture_kind`, `rejects_non_numeric_commits`, `usage_text_lists_every_subcommand`.
- `rss`: `parses_vm_rss_kb_to_mb`, `none_without_vm_rss_line`, `none_on_malformed_number`, `current_rss_is_some_on_linux` (`#[cfg(target_os = "linux")]`).
- `git`: `run_git_reports_version` (gated), `failed_command_includes_args_and_stderr` (gated: `git rev-parse` in a non-repo temp dir), `git_available_honours_opt_out`.
- `budgets`: `no_violation_under_budget`, `open_to_first_page_over_budget`, `status_over_budget`, `rss_growth_over_budget`, `all_three_violations_in_order`, `status_skipped_when_none`, `rss_skipped_when_none`, `violation_message_shape`.
- `report`: `json_has_version_budgets_results_and_passed`, `json_uses_null_for_unavailable_values`, `text_table_aligns_two_rows_and_shows_dash_for_null`, `text_ends_with_pass`, `text_ends_with_fail_and_violation_lines`, `text_ends_with_info_under_no_assert`, `markdown_summary_has_heading_and_result_column`, `passed_is_false_with_violations_even_under_no_assert`.
- `app`: `help_exits_0_and_prints_usage_to_stdout`, `bad_args_exit_2_and_print_usage_to_stderr`, `run_on_non_repository_exits_3_with_cannot_open`, `run_with_violation_exits_1` and `no_assert_exits_0_with_violation` (inject a measurement via a test-only seam: `app::run_with(args, out, err, measurer)` where `measurer: &dyn Fn(&Path, &str) -> Result<Measurement, BenchError>`; `run` passes `measure::measure`), `unwritable_json_path_exits_3_after_table`.

### Task 2: `fixtures` (synthetic stream, markers, prepare)

**Files:** create `src/fixtures.rs` (or `src/fixtures/{mod,synthetic,public}.rs`).

**Tests:** `stream_starts_with_initial_tree_commit_and_all_files` (commits 50, files 7: header lines, 7 `M 100644 inline` paths in spec format), `stream_touches_file_c_mod_files`, `stream_topic_cadence_and_merge` (`refs/heads/scratch` at index 40, `Merge topic-1` at 60, `from`/`merge` lines), `every_tenth_topic_kept_as_branch_ref` (commits 500 → `reset refs/heads/topic-10`), `tags_every_2000_main_commits` (commits 4100 → `v0.1`, `v0.2`), `stream_ends_with_done`, `stream_is_deterministic` (two generations byte-equal), `marker_round_trip`, `marker_mismatch_on_different_params`, `marker_kind_names_are_camel_case`; gated on git: `prepare_synthetic_builds_the_repository` (commits 60, files 12 → git2 counts: 60 commits reachable from all refs, index len 12, at least one `refs/tags/v0.*` only when ≥ 2000 so assert none here, `refs/heads/scratch` absent, `refs/heads/topic-10` absent at 60 commits, 200 status entries → with 12 files the dirty step must still apply to `min(100, files)` modified files and 100 untracked; **the spec's dirty counts are for the defaults, so the generator applies `min(100, files)` modifications**), `prepare_synthetic_twice_is_cached`, `prepare_refuses_foreign_directory`, `prepare_public_graph_trims_local_history` (local bare source with 12 linear commits, `--commits 5` → HEAD ancestry count 5, only `refs/heads/bench` listed, marker head = 5th oldest oid), `prepare_public_graph_without_trim_when_short` (`--commits 50` on 12 → 12), `prepare_public_worktree_clones_depth_1` (local source → 1 commit, files present), `failed_clone_removes_partial_dir_and_reports_args`.

### Task 3: `measure`

**Files:** create `src/measure.rs`.

**Tests (gated on git, tiny synthetic fixtures built through `fixtures::prepare`):** `measures_every_field_on_a_worktree_fixture` (commits = 40, files = index len, statusEntries = dirty count, `openToFirstPageMs >= openMs + graphBuildMs`-free assertion: just `>= graphBuildMs`), `bare_fixture_has_null_status_files_and_entries` (a `public-graph` from a local source), `graph_refresh_is_measured_after_build`, `cannot_open_error_names_the_path`, `rss_growth_is_never_negative`.

### Task 4: `tests/cli.rs` and the offload contract test

**Files:** create `src-tauri/crates/git-real-bench/tests/cli.rs`, `src-tauri/tests/offload_contract.rs`.

**Tests:** `cli.rs`: `help_exits_zero`, `usage_error_exits_two`, `run_on_non_repo_exits_three`, `prepare_then_run_writes_json_and_summary_and_exits_zero` (gated; asserts JSON `version`, `results[0].commits == 30`, `passed == true`, summary file contains `### Git Real benchmarks`). `offload_contract.rs`: `every_command_runs_inside_run_blocking`, `handler_names_match_generate_handler`, `scanner_names_a_bare_handler`, `scanner_stops_at_the_closing_brace` (the scanner lives in the test file as plain functions over `&str`).

**Cycle 1 deliverable:** `cargo test --workspace` green including the new crate; `cargo run --release -p git-real-bench -- prepare synthetic <tmp>/bench-synthetic` then `run` prints the table and `PASS`; the developer also prepares `public-graph` and `public-worktree` fixtures from `https://github.com/qemu/qemu` under the scratch fixtures directory, runs all three, and pastes the table into the report (expected: ~100k commits, 11.5k files, all budgets met).

## Cycle 2 — CI job, contract tests, front-end bound, docs (Tasks 5–7)

### Task 5: CI `bench` job and contract tests

**Files:** edit `.github/workflows/ci.yml` (append the `bench` job from spec §4), `src/test/release.test.ts` (new `describe("bench workflow")`).

**Tests:** `has a bench job on ubuntu-latest with a timeout`, `builds git-real-bench in release before preparing fixtures`, `prepares the synthetic, public-graph and public-worktree fixtures under the cached directory`, `runs the three fixtures with a JSON report and the step summary`, `uploads the results artifact even on failure`, `never continues on error`, `README documents the benchmark commands`, `cache key hashes the fixtures source`.

### Task 6: Front-end page cache bound

**Files:** edit `src/features/graph/useLogPages.ts`.

**Tests (`src/features/graph/useLogPages.test.tsx`):** `page queries carry gcTime LOG_PAGE_GC_MS`, `a page no longer in view is collected after LOG_PAGE_GC_MS` (design in spec §6).

### Task 7: Docs

**Files:** edit `README.md` (`## Benchmarks` between `Development` and `Releasing`; `git-real-bench/` under `## Project layout`); create `docs/adr/0004-performance-budgets-and-benchmarks.md`.

**Tests:** covered by Task 5's `README documents the benchmark commands`; the ADR is reviewed, not tested.

**Cycle 2 deliverable:** `release.test.ts` green on the new job; `npm run test:coverage` 100 %; README and ADR in place.

## Execution: batched agent cycles

Two cycles, five dispatches each (architect + tdd-tester in parallel → developer → tdd-tester-coverage + code-reviewer in parallel), then a final whole-branch architect review and the orchestrator's gate run. Expected dispatches: about 12, plus fix rounds.

## Verification gate

From `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`, `cargo tree -i openssl-sys` prints nothing. From the root: `npm run test:coverage` at 100 %, `npm run lint`, `npm run typecheck`, `npx prettier --check .`. One local release run of the suite on the three full-size fixtures with all budgets met. Plus the coverage agent's confirmation and the architect's explicit approval.

## Acceptance walk

Spec §13: automated through the WebKit inspector driver on the synthetic fixture if it comes up; otherwise listed as user checks.
