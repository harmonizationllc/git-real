# GR-3 Open, Clone, and Initialize Repositories — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per CLAUDE.md, every task runs through the agent team: `architect` + `tdd-tester` (parallel) → `developer` → `tdd-tester-coverage` + `code-reviewer` (parallel) → verification gate (green tests, coverage confirmed, architect sign-off). The `developer` never edits test files.

**Goal:** A user can open, clone, or initialize a repository, see recent repositories on a start screen, and keep several repositories open in tabs.

**Architecture:** Pure Git logic lives in the `git-real-core` crate (git2 for open/init, the `git` CLI for clone with parsed progress). A thin Tauri layer holds a `RepoRegistry` of sessions and a `RecentStore`, exposes seven commands, and relays clone progress as events. The React front end talks to Rust only through `src/lib/ipc`, uses TanStack Query for recents and a Zustand store for tabs.

**Tech Stack:** Rust 2024 edition, git2 0.20 (no network features), thiserror 2, serde, tempfile (dev); Tauri 2, tauri-plugin-dialog 2; React 19, TypeScript, Vitest + happy-dom + Testing Library, `@tauri-apps/api/mocks`, @tanstack/react-query 5, zustand 5.

**Spec:** `docs/superpowers/specs/2026-10-16-gr3-repo-open-clone-init-design.md`

## Global Constraints

- `git2` stays `default-features = false`. Clone goes through the system `git` CLI. (CLAUDE.md, ADR 0001)
- `git-real-core` has no Tauri dependency and no serde-free rule violation: DTOs derive serde, `GitError` does not.
- All DTOs: one struct/enum per type, `#[serde(rename_all = "camelCase")]`, so a later tauri-specta switch is mechanical. (Spec 5.4)
- `git2::Repository` is `Send` not `Sync`: sessions live in `Arc<Mutex<RepoSession>>`; blocking work runs in `tauri::async_runtime::spawn_blocking`. No direct `tokio` dependency.
- Only `src/lib/ipc/*` may import `@tauri-apps/api/core`, `@tauri-apps/api/event`, or `@tauri-apps/plugin-dialog`. ESLint enforces it.
- Front-end tests are co-located `*.test.ts(x)`; Rust tests are inline `#[cfg(test)]` modules or `tests/` integration files.
- Every task ends green on: `npm run lint && npm run typecheck && npm test && npm run build` and, from `src-tauri`, `cargo fmt --all --check && cargo clippy --workspace -- -D warnings && cargo test --workspace`.
- `AppError.kind` strings are exactly: `notARepository`, `alreadyARepository`, `pathNotFound`, `gitCliMissing`, `cloneFailed`, `io`, `git`, `unknownRepo`.
- Recents cap: `MAX_ENTRIES = 20`. Recents file: `<app_config_dir>/recent-repos.json`.
- Commit after each task with a conventional-commit message ending in the attribution line from the session.

## Review Focus

1. **Path with trailing slash or `..` segments** passed to `open_repo` should resolve to the same `RepoSummary.path` as the canonical form, so tab dedupe-by-path works. Test added to Task 1 (`summary_path_is_canonical`).
2. **Clone into a destination that already exists and is non-empty** should fail with `cloneFailed` and leave the folder untouched, not partially overwrite it. Test added to Task 2 (`clone_into_non_empty_dest_fails`).
3. **Recents file written by a newer version or hand-edited to garbage** must not prevent startup. Test added to Task 4 (`load_tolerates_corrupt_file`).
4. **Clone progress events from a different clone** (two dialogs, or a stale listener) must not update the wrong progress bar. Test added to Task 6 (`onCloneProgress ignores other cloneIds`).
5. **Closing the active tab when it is the last tab** must land on the start screen with no dangling `activeId`. Test added to Task 6 (`closeTab last tab clears activeId`).

---

## File Structure

**Create (Rust core, `src-tauri/crates/git-real-core/src/`):**

- `error.rs` — `GitError`
- `model/mod.rs`, `model/repo.rs` (`RepoSummary`), `model/progress.rs` (`Progress`, `ProgressPhase`), `model/recent.rs` (`RecentEntry`)
- `repo/mod.rs`, `repo/session.rs` — `RepoSession`
- `progress.rs` — `ProgressSink`
- `remote/mod.rs`, `remote/git_cli.rs`, `remote/progress_parser.rs`, `remote/clone.rs`
- `recent.rs` — `RecentRepos`
- `tests/common/mod.rs` — shared fixtures (temp repo with a commit, bare clone)
- `tests/clone.rs` — clone integration tests

**Modify:** `lib.rs` (module declarations and re-exports).

**Create (Rust app, `src-tauri/src/`):**

- `error.rs` — `AppError`
- `state.rs` — `RepoId`, `RepoRegistry`, `RecentStore`
- `events.rs` — `CLONE_PROGRESS`, `CloneProgressPayload`, `EventProgressSink`
- `commands/mod.rs`, `commands/repo.rs`

**Modify:** `lib.rs` (plugins, state, handler), `Cargo.toml` (add `tauri-plugin-dialog`), `capabilities/default.json` (add `dialog:allow-open`).

**Create (front end, `src/`):**

- `lib/ipc/types.ts`, `lib/ipc/commands.ts`, `lib/ipc/events.ts`, `lib/ipc/dialog.ts`, `lib/ipc/index.ts`
- `lib/query/client.ts`, `lib/query/keys.ts`
- `lib/store/repoTabs.ts`
- `features/repo/repoNameFromUrl.ts`, `features/repo/useRecentRepos.ts`, `features/repo/useOpenRepo.ts`
- `features/repo/RepoError.tsx`, `features/repo/RecentList.tsx`, `features/repo/StartScreen.tsx`, `features/repo/CloneDialog.tsx`
- `app/App.tsx`, `app/TabBar.tsx`, `app/RepoPane.tsx`
- Tests beside each.

**Modify:** `src/main.tsx` (import `./app/App`), delete `src/App.tsx` and `src/App.css` (move styles to `src/app/App.css`), `eslint.config.js` (restrict `@tauri-apps/plugin-dialog`), `package.json` (add `@tauri-apps/plugin-dialog`). Remove the now-unneeded `.gitkeep` files in directories that gain real files.

---

### Task 1: Core — `GitError`, `RepoSummary`, `RepoSession` open/init/summary

**Files:**

- Create: `src-tauri/crates/git-real-core/src/error.rs`
- Create: `src-tauri/crates/git-real-core/src/model/mod.rs`, `model/repo.rs`
- Create: `src-tauri/crates/git-real-core/src/repo/mod.rs`, `repo/session.rs`
- Create: `src-tauri/crates/git-real-core/tests/common/mod.rs`
- Modify: `src-tauri/crates/git-real-core/src/lib.rs`
- Test: `src-tauri/crates/git-real-core/tests/session.rs` (integration tests, so they share `tests/common/mod.rs` fixtures with Task 2; declare with `mod common;` at the top of each `tests/*.rs` file). Pure parsers in Task 2 use inline `#[cfg(test)]` modules; everything that needs a repository fixture uses `tests/`.

**Interfaces:**

- Produces:
  ```rust
  pub enum GitError { NotARepository(PathBuf), AlreadyARepository(PathBuf), PathNotFound(PathBuf), GitCliMissing, CloneFailed { code: Option<i32>, stderr: String }, Io(std::io::Error), Git2(git2::Error) }
  pub struct RepoSummary { pub path: PathBuf, pub name: String, pub head_branch: Option<String>, pub is_bare: bool }
  pub struct RepoSession { /* owns git2::Repository */ }
  impl RepoSession {
      pub fn open(path: impl AsRef<Path>) -> Result<Self, GitError>;
      pub fn init(path: impl AsRef<Path>) -> Result<Self, GitError>;
      pub fn summary(&self) -> RepoSummary;
      pub fn path(&self) -> &Path;
  }
  ```
- Fixture helpers (test support): `fn temp_repo_with_commit() -> (TempDir, PathBuf)` creates a repo, writes `README.md`, commits on the default branch; `fn temp_bare_clone(src: &Path) -> (TempDir, PathBuf)` makes a bare clone via `git2::build::RepoBuilder::new().bare(true)` (local clone, no network).

**Behaviour to implement:**

- `open`: if `!path.exists()` → `PathNotFound(path)`. Else `git2::Repository::open(path)` (NOT `open_ext`/`discover`, so a subfolder of a repo fails). Map `git2::ErrorCode::NotFound` → `NotARepository(path)`; other git2 errors → `Git2`.
- `init`: if path exists and `git2::Repository::open(path)` succeeds → `AlreadyARepository`. Else `std::fs::create_dir_all` then `git2::Repository::init`.
- `summary`: `path` = `repo.workdir()` for non-bare, else `repo.path()`, both canonicalized and with any trailing separator removed. `name` = last component as String. `head_branch`: read reference `HEAD`; if `symbolic_target()` starts with `refs/heads/`, strip it → `Some`; else `None`. `is_bare` = `repo.is_bare()`.
- `GitError` derives `Debug` and `thiserror::Error` with the messages from the spec. No serde.

- [ ] **Step 1 (`architect` + `tdd-tester`, parallel):** Architect confirms module layout above and where test fixtures live. Tester writes failing tests:
  - `open_existing_repo_succeeds` — fixture repo → `Ok`, `summary().name` equals the temp dir name.
  - `open_missing_path_is_path_not_found` — nonexistent path → `Err(GitError::PathNotFound(p))` with `p` equal to the input.
  - `open_plain_folder_is_not_a_repository` — empty temp dir → `NotARepository`.
  - `open_subfolder_of_repo_is_not_a_repository` — `<repo>/sub` created → `NotARepository`.
  - `init_empty_folder_creates_repo` — `init` on empty dir → `Ok`, and `RepoSession::open` on the same path is `Ok`.
  - `init_non_empty_non_git_folder_succeeds` — dir containing a file → `Ok`.
  - `init_missing_folder_creates_it` — nonexistent path → `Ok`, path now exists.
  - `init_existing_repo_is_already_a_repository` — fixture repo → `AlreadyARepository`.
  - `summary_head_branch_after_commit` — fixture → `head_branch == Some(<default branch name>)` where the expected name is read from the fixture repo's HEAD via git2 (do not hardcode `master`/`main`).
  - `summary_head_branch_after_fresh_init_is_unborn_branch_name` — `init` → `head_branch.is_some()`.
  - `summary_head_branch_none_when_detached` — fixture; `repo.set_head_detached(commit_oid)` → `None`.
  - `summary_is_bare_for_bare_repo` — bare clone fixture → `is_bare == true`, `head_branch` present.
  - `summary_path_is_canonical` — open via `<repo>/./` and `<repo>/sub/..` → both `summary().path` equal canonical `<repo>`.
- [ ] **Step 2:** Run `cargo test -p git-real-core` from `src-tauri`. Expected: compile failure (types undefined).
- [ ] **Step 3 (`developer`):** Implement per Behaviour. Add `pub mod error; pub mod model; pub mod repo;` and `pub use error::GitError; pub use model::*;` to `lib.rs`.
- [ ] **Step 4:** Run `cargo test -p git-real-core`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --all --check`. Expected: all pass.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`, parallel):** coverage audit (every `GitError` arm reachable from a test, trailing-separator stripping covered), review. Loop to `developer` on BLOCKING.
- [ ] **Step 6 (gate):** `architect` sign-off. Commit: `feat(core): RepoSession open/init/summary with GitError`.

---

### Task 2: Core — progress parser, `ProgressSink`, git CLI locator, clone

**Files:**

- Create: `src-tauri/crates/git-real-core/src/model/progress.rs`
- Create: `src-tauri/crates/git-real-core/src/progress.rs`
- Create: `src-tauri/crates/git-real-core/src/remote/mod.rs`, `remote/git_cli.rs`, `remote/progress_parser.rs`, `remote/clone.rs`
- Create: `src-tauri/crates/git-real-core/tests/clone.rs`
- Modify: `src-tauri/crates/git-real-core/src/lib.rs`

**Interfaces:**

- Consumes: `GitError`, `RepoSession` (Task 1), fixtures.
- Produces:
  ```rust
  pub enum ProgressPhase { Counting, Compressing, Receiving, Resolving, CheckingOut, Other }
  pub struct Progress { pub phase: ProgressPhase, pub percent: Option<u8>, pub message: String }
  pub trait ProgressSink: Send { fn report(&mut self, progress: Progress); }
  pub mod remote {
      pub mod git_cli { pub fn locate() -> Result<PathBuf, GitError>; pub fn locate_in(path_var: &str) -> Option<PathBuf>; }
      pub mod progress_parser { pub fn parse_line(line: &str) -> Option<Progress>; pub fn split_chunks(bytes: &[u8]) -> Vec<String>; }
      pub mod clone { pub fn clone(url: &str, dest: &Path, sink: &mut dyn ProgressSink) -> Result<PathBuf, GitError>; }
  }
  ```
  Test helper type (in `tests/clone.rs`): `struct RecordingSink(Vec<Progress>)`.

**Behaviour to implement:**

- `parse_line`: trim; empty → `None`. Prefix match (case-sensitive) `Counting objects` → `Counting`, `Compressing objects` → `Compressing`, `Receiving objects` → `Receiving`, `Resolving deltas` → `Resolving`, `Updating files` → `CheckingOut`; otherwise `Other`. `percent`: first `\d{1,3}%` found, parsed, clamped to 100; `None` if absent. `message` = trimmed line.
- `split_chunks`: split a byte buffer on `\r` or `\n`, lossy-UTF8 each piece, drop empty pieces. Used because git emits progress with carriage returns.
- `locate_in(path_var)`: iterate `std::env::split_paths`, candidates `git` and on Windows also `git.exe`; return first that `is_file()`. `locate()` = `locate_in(&env::var("PATH").unwrap_or_default()).ok_or(GitError::GitCliMissing)`.
- `clone`: `locate()?`; `Command::new(git).args(["clone", "--progress", url]).arg(dest).stdout(null).stderr(piped)`; read stderr with a byte buffer loop (`read` into 4 KiB chunks, `split_chunks`, `parse_line`, `sink.report`), also accumulate the raw stderr as String; `wait()`; non-success → `CloneFailed { code: status.code(), stderr }`; success → `dest.canonicalize()?`.
- Integration tests skip (early `return`) with an `eprintln!("skipping: git not on PATH")` when `git_cli::locate()` is `Err`. Use a `file://` URL for the bare fixture so git uses the transport path that prints progress (a plain local path would hardlink and print nothing).

- [ ] **Step 1 (`architect` + `tdd-tester`):** Tester writes failing tests. Unit (inline in `progress_parser.rs`, `git_cli.rs`):
  - `parse_counting` — `"Counting objects: 100% (5/5), done."` → phase `Counting`, percent `Some(100)`.
  - `parse_compressing`, `parse_receiving`, `parse_resolving` — one line each with a mid-range percent (e.g. `"Receiving objects:  45% (9/20)"` → `Some(45)`).
  - `parse_updating_files_is_checking_out` — `"Updating files:  12% (3/25)"` → `CheckingOut`, `Some(12)`.
  - `parse_line_without_percent` — `"Cloning into 'x'..."` → `Other`, `None`, message equals trimmed input.
  - `parse_empty_line_is_none` — `""` and `"   "` → `None`.
  - `split_chunks_on_cr_and_lf` — `b"a\rb\nc"` → `["a","b","c"]`; `b"\r\n"` → `[]`.
  - `locate_in_empty_path_is_none` — `locate_in("")` → `None`.
  - `locate_in_finds_fake_git` — temp dir containing an empty file named `git` (and `git.exe` on Windows) → `Some(that path)`.
    Integration (`tests/clone.rs`):
  - `clone_local_bare_repo_reports_progress_and_opens` — bare fixture as `file://` URL into `<tmp>/dest` → `Ok(path)`, `RepoSession::open(path)` is `Ok`, sink recorded ≥1 entry, and at least one entry has phase `Receiving` or `CheckingOut`.
  - `clone_nonexistent_url_is_clone_failed` — `file:///nonexistent/repo` → `Err(CloneFailed{..})` with non-empty `stderr`.
  - `clone_into_non_empty_dest_fails` — dest dir pre-created with a file → `CloneFailed`, and the file still exists afterwards.
- [ ] **Step 2:** `cargo test -p git-real-core` → compile failure.
- [ ] **Step 3 (`developer`):** Implement. Add `pub mod progress; pub mod remote;` and re-exports to `lib.rs`.
- [ ] **Step 4:** `cargo test -p git-real-core`, clippy, fmt → pass.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`):** confirm percent clamping and `Other` with a stray `%` are covered; review the stderr read loop for partial-chunk handling (a line split across two 4 KiB reads must still parse; add a `split_chunks` test with a carry-over buffer if the implementation keeps one).
- [ ] **Step 6 (gate):** architect sign-off. Commit: `feat(core): clone via git CLI with parsed progress`.

---

### Task 3: Core — `RecentRepos`

**Files:**

- Create: `src-tauri/crates/git-real-core/src/model/recent.rs`, `src-tauri/crates/git-real-core/src/recent.rs`
- Modify: `src-tauri/crates/git-real-core/src/lib.rs`

**Interfaces:**

- Produces:

  ```rust
  pub struct RecentEntry { pub path: PathBuf, pub name: String, pub last_opened: u64 }
  pub const MAX_ENTRIES: usize = 20;
  #[derive(Default, Serialize, Deserialize)] pub struct RecentRepos { entries: Vec<RecentEntry> }
  impl RecentRepos {
      pub fn touch(&mut self, path: PathBuf, name: String, now: u64);
      pub fn remove(&mut self, path: &Path) -> bool;
      pub fn entries(&self) -> &[RecentEntry];
  }
  ```

- [ ] **Step 1 (`architect` + `tdd-tester`):** failing tests inline in `recent.rs`:
  - `touch_inserts_at_front` — touch A then B → entries `[B, A]`.
  - `touch_existing_moves_to_front_and_updates_time` — A(1), B(2), A(3) → `[A(3), B(2)]`, length 2.
  - `touch_caps_at_max_entries` — touch 25 distinct paths → length 20, the first five touched are gone.
  - `remove_present_returns_true` and `remove_absent_returns_false`.
  - `serde_round_trip` — `serde_json::to_string` then `from_str` equals original (needs `serde_json` as a dev-dependency; `PartialEq` on both types).
  - `default_is_empty`.
- [ ] **Step 2:** run → compile failure. **Step 3 (`developer`):** implement; add `serde_json = "1"` under `[dev-dependencies]`. **Step 4:** tests, clippy, fmt green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).** **Step 6 (gate):** sign-off. Commit: `feat(core): RecentRepos list logic`.

---

### Task 4: App — `AppError`, `RepoRegistry`, `RecentStore`

**Files:**

- Create: `src-tauri/src/error.rs`, `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod error; pub mod state;` only)

**Interfaces:**

- Consumes: `GitError`, `RepoSession`, `RecentRepos`, `RecentEntry`.
- Produces:
  ```rust
  #[derive(Debug, Clone, Serialize, PartialEq, Eq)] #[serde(rename_all = "camelCase")]
  pub struct AppError { pub kind: String, pub message: String }
  impl AppError { pub fn unknown_repo(id: RepoId) -> Self; }
  impl From<GitError> for AppError;
  pub type RepoId = u64;
  pub struct RepoRegistry { .. } // Default
  impl RepoRegistry {
      pub fn register(&self, session: RepoSession) -> RepoId;      // ids start at 1, increment
      pub fn get(&self, id: RepoId) -> Option<Arc<Mutex<RepoSession>>>;
      pub fn remove(&self, id: RepoId) -> bool;
      pub fn find_by_path(&self, path: &Path) -> Option<RepoId>;  // compares RepoSession::path()
  }
  pub struct RecentStore { .. }
  impl RecentStore {
      pub fn load(path: PathBuf) -> Self;                          // missing/corrupt → Default
      pub fn touch(&self, path: PathBuf, name: String) -> Vec<RecentEntry>; // now = SystemTime; saves
      pub fn remove(&self, path: &Path) -> Vec<RecentEntry>;       // saves
      pub fn entries(&self) -> Vec<RecentEntry>;
  }
  ```
- `From<GitError>`: kind per Global Constraints; `message` = `error.to_string()`.
- `RecentStore` save: `serde_json::to_string_pretty`, `create_dir_all(parent)`, write atomically (write to `<path>.tmp` then `rename`). Save errors are logged with `eprintln!` and otherwise ignored (recents are a convenience). `serde_json` is already a dependency of the app crate.
- App-crate tests need repository fixtures and the core's `tests/common` is not reachable from another crate, so add `tempfile = "3"` and `git2 = { version = "0.20", default-features = false }` under the app crate's `[dev-dependencies]` and build fixtures with `RepoSession::init` plus a git2 commit in a `#[cfg(test)] mod fixtures` in `state.rs`, reused by Task 5 via `crate::state::fixtures`.

- [ ] **Step 1 (`architect` + `tdd-tester`):** failing tests inline in each file (app crate tests run with `cargo test -p git-real`; these do not need a Tauri runtime):
  - `app_error_kind_for_each_git_error_variant` — table test over all seven `GitError` variants → expected kind strings, message non-empty.
  - `app_error_serializes_as_kind_and_message` — `serde_json::to_value` → `{"kind":"notARepository","message":...}`.
  - `registry_register_then_get` — ids start at 1 and `get(1)` is `Some`.
  - `registry_ids_are_unique_and_increasing`.
  - `registry_remove_twice` — first `true`, second `false`, `get` now `None`.
  - `registry_find_by_path` — registered fixture repo found by its canonical path; unknown path → `None`.
  - `store_load_missing_file_is_empty`.
  - `store_touch_persists_and_reloads` — touch, drop, `load` same path → one entry with the same path and name.
  - `store_remove_persists`.
  - `load_tolerates_corrupt_file` — file containing `{not json` → empty store, and a subsequent `touch` overwrites it with valid JSON.
- [ ] **Step 2:** run → compile failure. **Step 3 (`developer`):** implement. **Step 4:** `cargo test --workspace`, clippy, fmt green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).** **Step 6 (gate):** sign-off. Commit: `feat(app): AppError, RepoRegistry, RecentStore`.

---

### Task 5: App — commands, events, wiring, dialog plugin

**Files:**

- Create: `src-tauri/src/events.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/repo.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `package.json` (add `"@tauri-apps/plugin-dialog": "^2"` and run `npm install`)

**Interfaces:**

- Consumes: everything from Tasks 1–4.
- Produces (Rust):
  ```rust
  // events.rs
  pub const CLONE_PROGRESS: &str = "clone-progress";
  #[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")]
  pub struct CloneProgressPayload { pub clone_id: u64, pub progress: Progress }
  pub struct EventProgressSink { app: tauri::AppHandle, clone_id: u64 }  // impl ProgressSink → app.emit(CLONE_PROGRESS, payload)

  // commands/repo.rs
  #[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
  pub struct OpenedRepo { pub id: RepoId, pub summary: RepoSummary }
  #[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
  pub struct GitCliInfo { pub available: bool, pub path: Option<String> }

  // inner, testable, synchronous:
  pub fn open_repo_inner(reg: &RepoRegistry, recent: &RecentStore, path: &str) -> Result<OpenedRepo, AppError>;
  pub fn init_repo_inner(reg: &RepoRegistry, recent: &RecentStore, path: &str) -> Result<OpenedRepo, AppError>;
  pub fn clone_repo_inner(reg: &RepoRegistry, recent: &RecentStore, url: &str, dest: &str, sink: &mut dyn ProgressSink) -> Result<OpenedRepo, AppError>;
  pub fn close_repo_inner(reg: &RepoRegistry, id: RepoId) -> Result<(), AppError>;
  pub fn list_recent_inner(recent: &RecentStore) -> Vec<RecentEntry>;
  pub fn remove_recent_inner(recent: &RecentStore, path: &str) -> Vec<RecentEntry>;
  pub fn check_git_cli_inner() -> GitCliInfo;

  // #[tauri::command] async wrappers with the same names minus `_inner`, taking
  // State<'_, Arc<RepoRegistry>>, State<'_, Arc<RecentStore>>, AppHandle as needed,
  // each doing: let reg = reg.inner().clone(); spawn_blocking(move || ..._inner(&reg, ..)).await.map_err(|e| AppError { kind: "io".into(), message: e.to_string() })?
  ```
- Produces (contract for the front end): command names `open_repo`, `init_repo`, `clone_repo`, `close_repo`, `list_recent`, `remove_recent`, `check_git_cli`; argument keys `path`, `url`, `dest`, `cloneId`, `id` (Tauri converts snake_case Rust params to camelCase keys by default).
- `open_repo_inner`: if `reg.find_by_path(canonical)` is `Some(id)` → return that id with a fresh summary (no duplicate session). Else `RepoSession::open`, register, `recent.touch(summary.path, summary.name)`.
- `clone_repo_inner`: `remote::clone::clone(url, Path::new(dest), sink)?` then `open_repo_inner(reg, recent, &path)`.
- `lib.rs` `run()`: `.plugin(tauri_plugin_dialog::init())`, `.manage(Arc::new(RepoRegistry::default()))`, `.setup(|app| { let dir = app.path().app_config_dir()?; app.manage(Arc::new(RecentStore::load(dir.join("recent-repos.json")))); Ok(()) })`, `generate_handler![...seven commands]`.
- `capabilities/default.json` permissions: add `"dialog:allow-open"`.
- `Cargo.toml`: `tauri-plugin-dialog = "2"`.

- [ ] **Step 1 (`architect` + `tdd-tester`):** failing tests inline in `commands/repo.rs` (using a `RecordingSink` and temp fixtures; `RecentStore::load` on a temp file):
  - `open_registers_and_touches_recent` — fixture → `Ok`, `reg.get(id)` is `Some`, `recent.entries()[0].path == summary.path`.
  - `open_same_repo_twice_returns_same_id`.
  - `open_non_repo_is_not_a_repository_kind` — `kind == "notARepository"`.
  - `init_registers_and_touches_recent`.
  - `close_then_close_again_is_unknown_repo` — second call `kind == "unknownRepo"`.
  - `clone_inner_opens_result` — bare fixture via `file://` → `Ok`, sink non-empty, `reg.get(id)` is `Some`, recents touched. Skip when git absent (same guard as Task 2).
  - `clone_inner_failure_kind` — bad URL → `kind == "cloneFailed"`.
  - `remove_recent_returns_updated_list`.
  - `check_git_cli_reports_path_when_available` — if `locate()` is `Ok`, `available == true` and `path` is `Some`; otherwise `available == false`.
  - `clone_progress_payload_serializes_camel_case` — `serde_json::to_value` has keys `cloneId`, `progress.phase`.
- [ ] **Step 2:** run → compile failure. **Step 3 (`developer`):** implement, add plugin, permission, npm package. **Step 4:** `cargo test --workspace`, clippy, fmt, `npm run build` green; then `npm run tauri dev` launches and the window opens (smoke only; no UI yet).
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`):** reviewer checks every wrapper uses `spawn_blocking` and no `tokio` import appears.
- [ ] **Step 6 (gate):** sign-off. Commit: `feat(app): repo commands, clone progress events, dialog plugin`.

---

### Task 6: Front end — IPC seam, query client, tabs store, ESLint rule

**Files:**

- Create: `src/lib/ipc/types.ts`, `commands.ts`, `events.ts`, `dialog.ts`, `index.ts`; `src/lib/query/client.ts`, `keys.ts`; `src/lib/store/repoTabs.ts`
- Test: `src/lib/ipc/commands.test.ts`, `src/lib/ipc/events.test.ts`, `src/lib/store/repoTabs.test.ts`
- Modify: `eslint.config.js` (add `{ name: "@tauri-apps/plugin-dialog", message: ipcSeamMessage }` to `restrictedTauriImports.paths`)
- Delete: `src/lib/ipc/.gitkeep`, `src/lib/query/.gitkeep`, `src/lib/store/.gitkeep`

**Interfaces:**

- Produces (`types.ts`):
  ```ts
  export type RepoId = number;
  export interface RepoSummary {
    path: string;
    name: string;
    headBranch: string | null;
    isBare: boolean;
  }
  export interface OpenedRepo {
    id: RepoId;
    summary: RepoSummary;
  }
  export interface RecentEntry {
    path: string;
    name: string;
    lastOpened: number;
  }
  export type ProgressPhase =
    "counting" | "compressing" | "receiving" | "resolving" | "checkingOut" | "other";
  export interface Progress {
    phase: ProgressPhase;
    percent: number | null;
    message: string;
  }
  export interface CloneProgressPayload {
    cloneId: number;
    progress: Progress;
  }
  export type AppErrorKind =
    | "notARepository"
    | "alreadyARepository"
    | "pathNotFound"
    | "gitCliMissing"
    | "cloneFailed"
    | "io"
    | "git"
    | "unknownRepo";
  export interface AppError {
    kind: AppErrorKind;
    message: string;
  }
  export interface GitCliInfo {
    available: boolean;
    path: string | null;
  }
  export function isAppError(e: unknown): e is AppError;
  ```
- Produces (`commands.ts`): `openRepo(path)`, `initRepo(path)`, `cloneRepo(url, dest, cloneId)`, `closeRepo(id)`, `listRecent()`, `removeRecent(path)`, `checkGitCli()`, each `invoke<T>("<name>", { ...args })`.
- Produces (`events.ts`): `onCloneProgress(cloneId: number, handler: (p: Progress) => void): Promise<UnlistenFn>` wrapping `listen<CloneProgressPayload>("clone-progress", ...)` and calling `handler` only when `payload.cloneId === cloneId`.
- Produces (`dialog.ts`): `pickFolder(title?: string): Promise<string | null>` wrapping `open({ directory: true, multiple: false, title })` from `@tauri-apps/plugin-dialog`; returns `null` on cancel.
- Produces (`index.ts`): `export * from "./types"; export * from "./commands"; export * from "./events"; export * from "./dialog";`
- Produces (`query/client.ts`): `export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })`; (`keys.ts`): `export const queryKeys = { recent: ["recent"] as const }`.
- Produces (`store/repoTabs.ts`):
  ```ts
  export interface RepoTab { id: RepoId; summary: RepoSummary }
  interface RepoTabsState { tabs: RepoTab[]; activeId: RepoId | null;
    openTab(repo: OpenedRepo): void;   // if a tab with the same id or summary.path exists → activate it; else append + activate
    closeTab(id: RepoId): void;        // remove; if it was active → activate the tab that was to its left, else right, else null
    activate(id: RepoId | null): void; // null = start screen
  }
  export const useRepoTabs = create<RepoTabsState>(...)
  ```
- `rename_all = "camelCase"` on the Rust enum serializes `CheckingOut` as `"checkingOut"`; `types.ts` must match.

- [ ] **Step 1 (`architect` + `tdd-tester`):** failing tests:
  - `commands.test.ts` (uses `mockIPC` from `@tauri-apps/api/mocks`; `clearMocks()` in `afterEach`): one test per wrapper asserting `cmd` and `args` received by the mock (e.g. `openRepo("/x")` → cmd `"open_repo"`, args `{ path: "/x" }`; `cloneRepo("u","/d",7)` → `{ url:"u", dest:"/d", cloneId:7 }`; `closeRepo(3)` → `{ id: 3 }`), and that the resolved value is the mock's return. Plus `rejects with the AppError unchanged` — mock throws `{kind:"notARepository",message:"m"}` → `openRepo` rejects with that object and `isAppError` is true. Plus `isAppError` negative on `new Error("x")` and `null`.
  - `events.test.ts` (`vi.mock("@tauri-apps/api/event")` providing a `listen` that captures the handler and returns an unlisten spy): `invokes handler for matching cloneId`, `onCloneProgress ignores other cloneIds`, `returns the unlisten function`.
  - `repoTabs.test.ts` (reset store state in `beforeEach` via `useRepoTabs.setState`): `openTab appends and activates`, `openTab with same path activates existing without duplicating`, `closeTab of middle active tab activates left neighbour`, `closeTab of first active tab activates right neighbour`, `closeTab last tab clears activeId`, `closeTab of inactive tab keeps activeId`, `activate(null) shows start screen`.
- [ ] **Step 2:** `npm test` → fails (modules missing). **Step 3 (`developer`):** implement; update ESLint config. **Step 4:** `npm run lint && npm run typecheck && npm test && npm run build` green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`):** reviewer confirms no file outside `src/lib/ipc` imports Tauri packages and the ESLint rule would catch one (temporarily add an import in a scratch file, run lint, confirm the error, remove it; do not commit the scratch file).
- [ ] **Step 6 (gate):** sign-off. Commit: `feat(ui): IPC seam, query client, repo tabs store`.

---

### Task 7: Front end — start screen, recents, error panel, open/init hooks

**Files:**

- Create: `src/features/repo/repoNameFromUrl.ts`, `useRecentRepos.ts`, `useOpenRepo.ts`, `RepoError.tsx`, `RecentList.tsx`, `StartScreen.tsx`, `StartScreen.module.css`
- Test: `repoNameFromUrl.test.ts`, `RepoError.test.tsx`, `RecentList.test.tsx`, `StartScreen.test.tsx`
- Delete: `src/features/repo/.gitkeep`
- Test support: `src/test/renderWithProviders.tsx` — wraps UI in a fresh `QueryClientProvider` per test.

**Interfaces:**

- Consumes: everything exported from `src/lib/ipc`, `useRepoTabs`, `queryKeys`.
- Produces:
  ```ts
  export function repoNameFromUrl(url: string): string | null;
  // "https://github.com/a/b.git" → "b"; "git@github.com:a/b.git" → "b"; "https://x/a/b/" → "b"; "" or "https://x/" → null
  export function useRecentRepos(): {
    recents: RecentEntry[];
    isLoading: boolean;
    remove(path: string): void;
  };
  export function useOpenRepo(): {
    open(path: string): Promise<void>; // openRepo → useRepoTabs.openTab; on error sets `error`
    init(path: string): Promise<void>;
    error: AppError | null;
    errorPath: string | null;
    clearError(): void;
  };
  export function RepoError(props: {
    error: AppError;
    path: string | null;
    onInitHere?: (path: string) => void;
    onDismiss(): void;
  }): JSX.Element;
  export function RecentList(props: {
    recents: RecentEntry[];
    onOpen(path: string): void;
    onRemove(path: string): void;
  }): JSX.Element;
  export function StartScreen(props: { onClone(): void }): JSX.Element; // Open and Init buttons call pickFolder() then open/init; Clone button calls props.onClone
  ```
- `RepoError` shows `error.message`; when `error.kind === "notARepository"` and `path` is set it renders a button "Initialize repository here" calling `onInitHere(path)`. Always renders a "Dismiss" button.
- `StartScreen` renders heading "Git Real", buttons "Open repository", "Clone repository", "Initialize repository", the `RecentList` (or "No recent repositories" when empty), and `RepoError` when `useOpenRepo().error` is set.

- [ ] **Step 1 (`architect` + `tdd-tester`):** failing tests. Mock the seam with `vi.mock("../../lib/ipc")` (whole module, typed with `vi.mocked`), reset `useRepoTabs` state in `beforeEach`.
  - `repoNameFromUrl.test.ts`: the five cases listed above plus `"ssh://git@host/a/b"` → `"b"`.
  - `RepoError.test.tsx`: `shows message`, `offers init on notARepository with path`, `does not offer init for pathNotFound`, `init button calls onInitHere with path`, `dismiss calls onDismiss`.
  - `RecentList.test.tsx`: `renders name and path per entry`, `click row calls onOpen with path`, `remove button calls onRemove with path and not onOpen`.
  - `StartScreen.test.tsx`: `renders recents from listRecent`, `shows empty message when none`, `Open flows through picker to openRepo and opens a tab` (pickFolder → "/r", openRepo resolves `OpenedRepo` → `useRepoTabs.getState().tabs` has it), `picker cancel calls nothing` (pickFolder → null), `openRepo rejection renders RepoError`, `Initialize here calls initRepo with the failed path and opens a tab`, `reopening a missing recent shows pathNotFound and keeps the entry`, `remove calls removeRecent and refreshes list` (mock returns the shorter list; assert row disappears), `Clone button calls onClone`.
- [ ] **Step 2:** `npm test` fails. **Step 3 (`developer`):** implement. **Step 4:** full front-end gate green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).** **Step 6 (gate):** sign-off. Commit: `feat(ui): start screen with open, init, and recents`.

---

### Task 8: Front end — clone dialog

**Files:**

- Create: `src/features/repo/CloneDialog.tsx`, `CloneDialog.module.css`
- Test: `src/features/repo/CloneDialog.test.tsx`
- Modify: `src/features/repo/useOpenRepo.ts` (add `clone(url, dest, cloneId)`), `useOpenRepo` tests if any assert its shape.

**Interfaces:**

- Consumes: `cloneRepo`, `onCloneProgress`, `checkGitCli`, `pickFolder`, `repoNameFromUrl`, `useRepoTabs`.
- Produces: `export function CloneDialog(props: { open: boolean; onClose(): void }): JSX.Element | null;`
- Behaviour: on open, call `checkGitCli()`; if `available === false` render "Git was not found on your PATH. Install Git to clone repositories." and a Close button only. Otherwise: URL input (label "Repository URL"), "Choose folder" button → `pickFolder()` sets `parentDir`; derived destination text `${parentDir}/${repoNameFromUrl(url)}` shown when both present; "Clone" button disabled until URL non-empty, `repoNameFromUrl(url)` non-null, and `parentDir` set. On Clone: `cloneId = Date.now()`, subscribe via `onCloneProgress(cloneId, setProgress)`, call `cloneRepo(url, dest, cloneId)`; while pending show `<progress>` with `value = percent ?? undefined` and the phase message; on success `useRepoTabs.openTab(result)`, unlisten, `onClose()`; on failure show `RepoError` inline, keep the dialog open, re-enable Clone. Unlisten on unmount.

- [ ] **Step 1 (`architect` + `tdd-tester`):** failing tests (same mocking approach as Task 7; `onCloneProgress` mock captures the handler so tests can push `Progress` values):
  - `renders nothing when closed`, `shows git-missing notice when checkGitCli unavailable`, `Clone disabled until url and folder set`, `derived destination shown`, `clone calls cloneRepo with dest and a numeric cloneId`, `progress updates from events` (push `{phase:"receiving", percent:42, message:"..."}` → progress bar value 42 and message visible), `success opens tab and closes`, `failure keeps dialog open with error`, `unsubscribes on unmount` (unlisten spy called).
- [ ] **Step 2:** fails. **Step 3 (`developer`):** implement. **Step 4:** front-end gate green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).** **Step 6 (gate):** sign-off. Commit: `feat(ui): clone dialog with progress`.

---

### Task 9: Front end — app shell with tabs, wiring, manual verification

**Files:**

- Create: `src/app/App.tsx`, `src/app/App.css`, `src/app/TabBar.tsx`, `src/app/RepoPane.tsx`
- Test: `src/app/App.test.tsx`, `src/app/TabBar.test.tsx`
- Modify: `src/main.tsx` (`import App from "./app/App"`), delete `src/App.tsx`, `src/App.css`, `src/app/.gitkeep`

**Interfaces:**

- Consumes: `useRepoTabs`, `closeRepo`, `StartScreen`, `CloneDialog`, `queryClient`.
- Produces:
  ```ts
  export function TabBar(props: {
    tabs: RepoTab[];
    activeId: RepoId | null;
    onActivate(id: RepoId | null): void;
    onClose(id: RepoId): void;
  }): JSX.Element;
  // renders one button per tab (label summary.name, aria-selected when active) each with a "×" close button (aria-label `Close ${name}`), plus a "+" button that calls onActivate(null)
  export function RepoPane(props: { tab: RepoTab }): JSX.Element; // header: name, path, headBranch ?? "detached HEAD"
  export default function App(): JSX.Element;
  ```
- `App`: `QueryClientProvider` → layout with `TabBar` on top; body is `RepoPane` for the active tab or `StartScreen` when `activeId === null`; owns `cloneOpen` state and renders `CloneDialog`. `onClose(id)`: call `closeRepo(id)` (ignore rejection with kind `unknownRepo`), then `useRepoTabs.closeTab(id)`.

- [ ] **Step 1 (`architect` + `tdd-tester`):** failing tests:
  - `TabBar.test.tsx`: `renders a tab per repo`, `active tab has aria-selected`, `click activates`, `close button calls onClose and not onActivate`, `plus calls onActivate(null)`.
  - `App.test.tsx`: `shows start screen with no tabs`, `opening a repo shows its pane with name and branch`, `switching tabs changes pane`, `closing tab calls closeRepo and returns to neighbour or start screen`, `detached head renders "detached HEAD"`, `Clone button opens CloneDialog`.
- [ ] **Step 2:** fails. **Step 3 (`developer`):** implement. **Step 4:** full front-end and Rust gates green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).**
- [ ] **Step 6 (manual verification, main session):** `npm run tauri dev` and walk the five acceptance criteria: open a real repo; open a non-git folder and use "Initialize repository here"; init an empty folder; clone a small public repo over HTTPS and watch progress; reopen and remove a recent; open two repos and switch tabs. Record the outcome in the final report.
- [ ] **Step 7 (gate):** architect sign-off on the whole feature. Commit: `feat(ui): app shell with repo tabs`. Transition Jira GR-3 to Done.
