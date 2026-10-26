# ADR 0004 — Performance budgets and benchmarks

- Status: Accepted
- Date: 2026-10-25
- Epic: GR-1 / Story: GR-16 "Performance validation on large repositories"

## Context

Git Real's commit graph, paging and status code were written to stay responsive on
large repositories, but nothing measured them. GR-16 sets budgets from its acceptance
criteria (open and first graph paint under 3 s at 100,000 commits, status under 500 ms
at 10,000 files, memory bounded while scrolling the full history) and enforces them in
CI. Measured on an i9-13900F with a warm page cache, the current design builds the graph
of a 100,000–134,000-commit repository in 0.5–1.2 s and grows by 0–3 MB while paging,
while the Linux kernel (1,501,435 commits) takes 41 s and 8.8 GB. Six choices in this
work shape any later budget change and the 1M+ follow-up, so they are recorded here.

## Decision

- **R1 — Fixtures.** CI benchmarks `qemu/qemu` twice (a treeless bare clone trimmed to
  its oldest 100,000 commits for the graph, and a depth-1 clone with 11,488 files for
  status) plus a deterministic synthetic repository of 100,000 commits and 10,000 files
  built with `git fast-import`, which needs no network. The Linux kernel exceeds the
  runner's memory and stays an informational `run --no-assert`.
- **R2 — What "open and first graph paint" measures.** One backend span from
  `RepoSession::open` through the graph build to the first 500-row page serialized to
  JSON, with the full 3000 ms budget. IPC and render are tens of milliseconds and are
  measured end to end in the acceptance walk; CI has no display for a webview timing.
- **R3 — Budgets fail the build.** The `bench` job runs on the same triggers as the
  other CI jobs and exits non-zero on any budget miss, with the acceptance criteria's
  numbers unscaled.
- **R4 — The memory bound.** On the backend, resident memory may grow by at most 64 MB
  while paging the whole history. On the front end, log-page queries carry
  `gcTime: LOG_PAGE_GC_MS` (60 s), so the query cache holds only pages viewed in the
  last minute.
- **R5 — Repositories of 1M+ commits are a follow-up.** The acceptance criteria fix
  100,000 commits, which the current design meets with headroom. The kernel needs a
  different cache shape that touches the walk, lane layout, cache, paging, search and
  file history, so it is ticketed with the measurements rather than done here.
- **R6 — A separate benchmark crate.** The harness is a new binary crate,
  `src-tauri/crates/git-real-bench`, a workspace member that is never bundled. It
  depends on `git-real-core`, `git2` (`default-features = false`), `serde` and
  `serde_json`, and adds no new crate to the tree. This is a stated exception to
  ADR 0002's rule to keep one crate with no premature multi-crate split: the binary is
  a development tool with its own dependencies and lifecycle, not app code.

## Consequences

- A change that slows the graph build, paging or status past a budget fails CI on the
  pull request that introduces it. The budgets are the acceptance criteria's constants;
  they change only with a note added to this ADR.
- The fixtures are cached between CI runs; the first run clones about 270 MB from
  GitHub, and the synthetic fixture keeps the suite runnable offline.
- Repositories of 1M+ commits are a follow-up ticket: an incremental walk that serves
  the first page before the walk completes, compact lane storage with edges derived per
  page, and file history without a full scan. Its baseline is the Linux kernel at
  1,501,435 commits: 41 s to build the graph, 8.8 GB of memory, and 2 GB more while
  paging; cpython at 134,000 commits reaches 1,238 lanes and 432 MB.
- `git-real-core` stays the single app domain crate; further crates need the same kind
  of justification as R6.
