# ADR 0002 — Project structure (GR-2)

- Status: Accepted
- Date: 2026-10-14
- Epic: GR-1 / Story: GR-2 "Decide technology stack and Git backend"

**Verdict: APPROVED to proceed.** The scaffold is a valid baseline; nothing is broken. A short list of config fixes (section 3) should land as the first commits. One is security-blocking *before release* only, not before development.

The scaffold as read is a clean, unmodified Tauri 2 `react-ts` template: a single `greet` command in `lib.rs`, demo `App.tsx`, no test runner, no linting, an 800x600 window, `csp: null`, bundle `targets: "all"`, and `authors = ["you"]`.

## 1. Rust crate layout

**Recommendation: split the git domain into a separate workspace crate.** Make `src-tauri` a Cargo workspace whose root package is the Tauri app, with one member crate `git-real-core` holding the pure domain. This is the single most important structural decision and I recommend it firmly.

Why:
- `git-real-core` compiles and unit-tests with plain `cargo test` — no webview, no `generate_context!`, no Tauri runtime. Fast red/green cycles, which the mandated TDD workflow depends on.
- Enforces dependency inversion: the domain knows nothing about Tauri. Dependencies flow app -> core, never the reverse.
- Keeps a hard line between business logic (git operations) and transport (IPC/events).

```
src-tauri/
  Cargo.toml                 # [workspace] + the app [package] (bin + lib)
  build.rs
  tauri.conf.json
  capabilities/
  crates/
    git-real-core/               # pure git domain — NO tauri dependency
      Cargo.toml
      src/
        lib.rs
        error.rs             # GitError (thiserror), no serde
        model/               # plain DTOs, derive Serialize: Commit, Branch, Tag, StatusEntry, Diff, Hunk, ...
        repo/                # RepoSession (owns git2::Repository) + open/init/clone-local
        refs/                # branches, tags, HEAD
        status/              # working-tree status
        log/                 # graph walk, paginated commit reader
        diff/
        blame/
        remote/              # CLI adapter: shell out to `git` for fetch/pull/push
        progress.rs          # ProgressSink port (trait / mpsc) for long ops — defined here, implemented in app
  src/
    main.rs                  # unchanged entry
    lib.rs                   # run(): builder, managed state, command + event wiring
    state.rs                 # RepoRegistry (managed state)
    error.rs                 # AppError: From<GitError> + Serialize (tagged {kind, message})
    events.rs                # typed event names + payloads (clone/fetch progress, repo-changed)
    watcher.rs               # notify-based FS watcher → emits repo-changed events
    commands/                # THIN Tauri adapters, one module per domain area
      mod.rs
      repo.rs                # open_repo, init_repo, close_repo
      refs.rs                # list_branches, ...
      status.rs
      ...
```

**Naming:** `git-real-core` (not `git-real-git`) so later non-git domain logic (settings, provider config) has a home without a misleading name. Keep it as **one** crate until compile times justify splitting — no premature multi-crate.

**RepoSession / registry.** `git2::Repository` is `Send` but **not** `Sync`, so it can be moved to a thread or owned behind a mutex, but not shared by reference across threads. This drives the design:
- `RepoRegistry` = managed state holding `HashMap<RepoId, Arc<Mutex<RepoSession>>>`. `RepoId` is an opaque handle (e.g. `u64` or `Uuid`) returned to the UI on open, so the UI references repos by id, never by live object.
- Each command locks the session mutex and runs the blocking git2 work inside `tauri::async_runtime::spawn_blocking`, so git2's blocking calls never touch the IPC/UI thread. **No direct `tokio` dependency** — use Tauri's `async_runtime`. Start with `std::sync::Mutex`; adopt `parking_lot` only if profiling shows contention.

**Error strategy.** `git-real-core::GitError` via `thiserror`, serde-free (domain stays pure). The app's `AppError` wraps it with `From`, and implements `Serialize` as a tagged shape `{ kind, message }` so the UI gets a rejected promise it can discriminate on. Map at the boundary, not in the domain.

**Long-running work & streaming.**
- **Paginated reads** (log/graph on 100k commits): command returns a page + continuation cursor. Cursor-based pagination over streaming-everything — simpler, backpressure-friendly, trivially testable. The UI virtualizes and pages.
- **Unbounded progress** (clone/fetch/push via the `git` CLI): `git-real-core` exposes a `ProgressSink` port (a trait or `mpsc::Sender<Progress>`); the app layer adapts it to Tauri events (`events.rs`). Core never depends on Tauri — dependency inversion again.
- **File watching:** `notify` in `watcher.rs`, debounced, emits `repo-changed` so the UI invalidates and refetches status.

## 2. Frontend layout (`src/`)

```
src/
  main.tsx
  app/              # shell: layout, window chrome, providers (QueryClient, theme), native menus
  features/
    repo/           # open/clone/init (GR-3)
    worktree/       # stage/unstage + status (GR-4)
    diff/           # (GR-5)
    commit/         # (GR-6)
    branches/       # (GR-7)
    graph/          # (GR-8) — needs virtualization
    history/        # commit detail, file history, blame (GR-9)
    merge/          # merge/rebase/conflicts (GR-10)
    stash/          # stash/tags (GR-11)
    remotes/        # (GR-12)
    hosting/        # github/gitlab/bitbucket (GR-13)
    settings/       # (GR-14)
  lib/
    ipc/
      commands.ts   # typed invoke wrappers — the ONLY place that imports @tauri-apps/api/core
      events.ts     # typed event subscription helpers
      bindings.ts   # generated types/commands (tauri-specta) — see below
    query/          # QueryClient setup, query keys, invalidation on repo-changed
    store/          # zustand store for UI-only state
  components/        # shared presentational components
  styles/            # tokens.css (CSS custom properties), global.css
```

- **Single IPC seam.** No feature imports `@tauri-apps/api/core` directly; everything goes through `lib/ipc/commands.ts`. That one seam is what tests mock via `@tauri-apps/api/mocks` (`mockIPC`). One place for command names + types, one mock point.
- **Type sync — recommend `tauri-specta` + `specta`.** Generate TS command bindings and DTO types from the Rust structs at build time, so UI and Rust contracts cannot drift. This eliminates the hand-written-wrapper name-drift bug class. Fallback if the team wants to avoid codegen: hand-write `commands.ts` wrappers mirroring the Rust DTOs. I recommend specta.
- **State management — minimal, two tools:** **TanStack Query** for server state (git data is async, cached, invalidated on file-watch events — this maps exactly onto Query's model and avoids a hand-rolled cache), plus **Zustand** for the little global UI state (selected commit, panel sizes). No Redux — ceremony with no payoff here.
- **Styling:** **CSS Modules + CSS custom-property tokens** for light/dark and a future COSMIC accent. Avoid runtime CSS-in-JS (emotion/styled-components) for a dense, perf-sensitive desktop UI. Tailwind is acceptable if the team prefers utilities, but CSS Modules keeps the data-dense panels cleaner.
- **Tests co-located** as `*.test.ts(x)` beside source (Vitest default) — better discoverability than a separate tree.

## 3. Repo-level layout & scaffold changes

```
git-real/
  docs/
    adr/                       # NNNN-title.md architecture decision records
    superpowers/
      specs/
      plans/
  .github/workflows/ci.yml     # rust: fmt+clippy+test; ts: lint+typecheck+test+build
  .editorconfig
  rustfmt.toml                 # optional
  CLAUDE.md                    # recommended, see below — do not write yet
```

**Do now (first commits, non-blocking to architecture):**
- `git init` — done.
- `Cargo.toml`: real `description`, `authors` (23158200+harmonizationllc@users.noreply.github.com), add `license`, `repository`.
- `index.html` `<title>` and window `title`: "Git Real" not "Tauri + React + Typescript".
- Window: default ~1280x800, set `minWidth`/`minHeight`, `resizable: true`. 800x600 is too small for a git client.
- Add `@types/node` to devDeps and drop the `@ts-expect-error` hack in `vite.config.ts`.
- Remove the demo `greet` command and the logo/greet `App.tsx` body — the first real task replaces them.
- `bundle.targets`: scope to Linux (`["deb", "rpm", "appimage"]`) for the primary target rather than `"all"`, which tries mac/windows bundles. Revisit in GR-15.
- `.gitignore`: add `coverage/`, `.env*`, `*.tsbuildinfo`.

**Blocking before release only (not before dev):**
- `app.security.csp: null` must become a restrictive CSP before shipping. Set one early so violations surface during development.

**CLAUDE.md should document** (recommendation, don't write it yet): the hybrid git backend rule (git2 for reads, CLI for network/creds/signing); commands (`npm run tauri dev`, `cargo test -p git-real-core`, `cargo clippy`, `npm test`, `npm run build`); the TDD policy and the IPC-seam rule (no direct `invoke` outside `lib/ipc`); the Send-not-Sync git2 constraint; Linux/Wayland/COSMIC as primary target.

## 4. Dependencies to add

**`git-real-core`:**

| Crate | Reason |
|---|---|
| `git2` (0.20.x), `default-features = false` | libgit2 read ops; disable default openssl/ssh since network goes through the git CLI — slimmer build |
| `thiserror` | ergonomic domain `GitError` enum |
| `serde` (derive) | serialize DTOs to the UI |

Pass commit timestamps to the UI as raw epoch + offset and format in TS — avoids a Rust date dependency.

**`git-real-core` dev-deps:**

| Crate | Reason |
|---|---|
| `tempfile` | throwaway temp dirs for test repos |

(git2 itself builds the test repos; it's already a main dep.)

**App crate (`git-real`):**

| Crate | Reason |
|---|---|
| `thiserror` | `AppError` |
| `notify` (6.x) | working-tree / `.git` file watching |
| `git-real-core` (path) | the domain |
| `specta` + `tauri-specta` | generate TS bindings/types from Rust (if adopted) |

No direct `tokio` — use `tauri::async_runtime::spawn_blocking`.

**TS devDependencies:**

| Package | Reason |
|---|---|
| `vitest` | Vite-native test runner |
| `@vitest/coverage-v8` | coverage for the mandated coverage gate |
| `happy-dom` | fast DOM env for component tests |
| `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom` | component testing |
| `@types/node` | fixes `vite.config.ts` node import |
| `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks`, `prettier` | linting/formatting (scaffold has none) |

**TS runtime deps:** `@tanstack/react-query`, `zustand`, and later `@tanstack/react-virtual` (GR-8 graph). `@tauri-apps/api` already ships `/mocks` — no extra test dep for IPC mocking.

## 5. First 3 tasks (each one TDD cycle, tests first)

These form a vertical slice — open a repo and list its branches through the whole stack — proving every layer is testable before features pile on.

1. **`git-real-core`: open repo + list branches (pure domain).** Red: given a temp repo built via git2 with known branches, `RepoSession::open(path)` returns `Ok` and `list_branches()` returns expected names with the current-HEAD flag; negative: a non-repo path yields `GitError::NotARepository`. Proves the workspace crate, error type, model DTOs, and the `tempfile` test harness — with zero Tauri.
2. **App boundary: expose it through Tauri.** Red: `open_repo(path) -> RepoId` registers a session in `RepoRegistry`; `list_branches(repo_id) -> Vec<Branch>` returns them; `AppError` serializes to `{kind, message}`; negative: unknown `RepoId` errors. The command fns are plain async fns tested directly with a temp repo. Proves managed state, error serialization, and the `spawn_blocking` boundary.
3. **Frontend end-to-end with mocked IPC.** Red (Vitest + `mockIPC`): `openRepo`/`listBranches` wrappers call `invoke` with the correct command name and args and parse results; a `BranchList` component renders branches and marks the current one; negative: the error path renders an error state. Proves the single IPC seam, its mockability, TanStack Query wiring, and the full UI-to-Rust contract.

After these three green, the architecture is validated end-to-end and GR-3 onward build on a proven spine.
