# GR-4 Working Tree View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per CLAUDE.md, every task runs through the agent team: `architect` + `tdd-tester` (parallel) → `developer` → `tdd-tester-coverage` + `code-reviewer` (parallel) → verification gate (green tests, coverage confirmed, architect sign-off). The `developer` never edits test files.

**Goal:** With a repository open, the user sees conflicted, staged and unstaged files with status badges, stages/unstages single files, selections or everything, discards with confirmation, adds untracked files to `.gitignore`, and the view refreshes when files change on disk. Hunk/line staging is delivered as backend + IPC (its controls arrive with the GR-5 diff viewer).

**Architecture:** `git-real-core` gains status, diff, patch-building, index operations and gitignore logic as `impl RepoSession` blocks (git2 only). The app layer fixes the double-open race, adds a `notify`-based per-repo watcher emitting `repo-changed`, and nine thin commands. The React front end adds typed IPC wrappers, per-repo query keys invalidated by `repo-changed`, a workspace selection store, shared `ContextMenu`/`ConfirmDialog` components, and a `ChangesPanel` mounted in a two-column `RepoPane`.

**Tech Stack:** Rust 2024, git2 0.20 (no network features), notify 8, thiserror 2, serde; Tauri 2; React 19, TypeScript, Vitest + happy-dom + Testing Library, `@tauri-apps/api/mocks`, @tanstack/react-query 5, zustand 5.

**Spec:** `docs/superpowers/specs/2026-10-17-gr4-working-tree-design.md`

## Global Constraints

- `git2` stays `default-features = false`; nothing in GR-4 touches the network. (CLAUDE.md)
- `git-real-core` has no Tauri dependency. DTOs derive serde with `#[serde(rename_all = "camelCase")]`, one struct/enum per type; `GitError` has no serde.
- `git2::Repository` is `Send` not `Sync`: commands lock the `Arc<Mutex<RepoSession>>` inside `run_blocking`; `PoisonError::into_inner` everywhere. No direct `tokio`.
- Only `src/lib/ipc/*` may import `@tauri-apps/*` (ESLint enforces it). Features import from `../../lib/ipc`.
- Front-end tests are co-located `*.test.ts(x)`; mock IPC with `mockIPC`/`clearMocks` from `@tauri-apps/api/mocks` or the `vi.mock(import("../../lib/ipc"), async (importOriginal) => ({ ...(await importOriginal()), fn: vi.fn() }))` recipe. Render with `src/test/renderWithProviders.tsx`.
- Rust tests needing a repository live in `tests/*.rs` with `mod common;`; pure functions use inline `#[cfg(test)]`.
- Every task ends green on: `npm run lint && npm run typecheck && npm test -- --coverage && npm run build` and, from `src-tauri`: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`. Front-end coverage stays 100 % statements/branches/functions/lines.
- `AppError.kind` strings gain exactly: `noChanges`, `badSelection`, `applyFailed`.
- Event names: `repo-changed` with payload `{ repoId }`. Debounce: 250 ms. Diff defaults: `context_lines = 3`, `max_lines = 10_000`.
- Styling: CSS Modules, colours only through `var(--color-*)` tokens; no hard-coded colours.
- Commit after each task with a conventional-commit message ending in the attribution lines from the session.

## Review Focus

1. **A path that is both staged and modified again** must appear in both Staged and Unstaged, and staging it from Unstaged must leave a single Staged entry. Pinned in Task 2 (`status_lists_file_changed_in_index_and_worktree`) and Task 5 (`stage_paths_merges_worktree_change_into_index`).
2. **A file deleted on disk but still in the index** must stage as a deletion, not fail with "file not found". Pinned in Task 5 (`stage_paths_stages_deletion`).
3. **Line-level staging of a hunk whose unselected deletions become context** must leave the working tree untouched and the index containing exactly the selected lines. Pinned in Task 4 (`build_patch_partial_lines_keeps_unselected_deletions_as_context`, `apply_hunk_stage_lines_leaves_worktree_untouched`).
4. **An external change burst (editor save = several events)** must produce one `repo-changed`, and `.git/objects` writes none. Pinned in Task 6 (`watcher_coalesces_burst_into_one_event`, `watcher_ignores_git_objects`).
5. **Discarding an untracked directory** must remove it entirely, and discarding a tracked, partially staged file must restore the index version, not HEAD. Pinned in Task 5 (`discard_paths_removes_untracked_dir`, `discard_paths_restores_index_version_not_head`).

---

## File Structure

**Create (Rust core, `src-tauri/crates/git-real-core/src/`):** `model/status.rs`, `model/diff.rs`, `status.rs`, `diff/mod.rs`, `diff/patch.rs`, `index_ops.rs`, `ignore.rs`; tests `tests/status.rs`, `tests/diff.rs`, `tests/patch_apply.rs`, `tests/index_ops.rs`, `tests/ignore.rs`; extend `tests/common/mod.rs`.
**Modify:** `lib.rs`, `model/mod.rs`, `error.rs`.

**Create (Rust app, `src-tauri/src/`):** `watcher.rs`, `commands/worktree.rs`; tests `tests/worktree_commands.rs`, `tests/watcher.rs`.
**Modify:** `state.rs`, `events.rs`, `error.rs`, `commands/mod.rs`, `commands/repo.rs`, `lib.rs`, `tests/registry.rs`, `tests/error.rs`, `tests/common/mod.rs`.

**Create (front end, `src/`):** `lib/store/workspace.ts`, `components/ContextMenu.tsx` (+ `.module.css`), `components/ConfirmDialog.tsx` (+ `.module.css`), `features/worktree/useStatus.ts`, `useWorktreeActions.ts`, `useFileSelection.ts`, `StatusBadge.tsx`, `FileRow.tsx`, `ChangesPanel.tsx` (+ `.module.css` each), tests beside each.
**Modify:** `lib/ipc/types.ts`, `lib/ipc/commands.ts`, `lib/ipc/events.ts`, `lib/query/keys.ts`, `app/RepoPane.tsx` (+ css), `styles/tokens.css`, `src/features/worktree/.gitkeep` (delete), `src/components/.gitkeep` (delete).

---

### Task 1: App — fix the double-open race in `RepoRegistry`

**Files:**

- Modify: `src-tauri/src/state.rs`, `src-tauri/src/commands/repo.rs` (`register_session`)
- Test: `src-tauri/tests/registry.rs`

**Interfaces:**

- Produces: `impl RepoRegistry { pub fn register_or_find(&self, session: RepoSession) -> (RepoId, bool) }` — returns the existing id (`false`) when an entry with the same canonical path exists, else inserts and returns the new id (`true`). Lookup and insert happen under one `entries()` lock. `register` stays for callers that want no dedupe.

**Behaviour:** `register_session` in `commands/repo.rs` calls `register_or_find` instead of `find_by_path` + `register`.

- [ ] **Step 1 (`architect` + `tdd-tester`):** tests in `tests/registry.rs`:
  - `register_or_find_returns_existing_id_for_same_path` — open the fixture twice via two `RepoSession::open`; second call returns the first id and `false`.
  - `register_or_find_inserts_new_path` — returns `true` and a fresh id.
  - `register_or_find_is_atomic_under_concurrency` — 8 threads each `register_or_find` a session for the same fixture path; collect ids; assert all equal and `get(id).is_some()`; `remove` once returns `true`, then `find_by_path` is `None`.
- [ ] **Step 2:** `cargo test --workspace` from `src-tauri` — expect compile failure (`register_or_find` missing).
- [ ] **Step 3 (`developer`):** implement; update `register_session`.
- [ ] **Step 4:** full Rust gates green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).**
- [ ] **Step 6 (gate):** architect sign-off. Commit: `fix(app): register sessions atomically by path`.

---

### Task 2: Core — status model and `RepoSession::status`

**Files:**

- Create: `src-tauri/crates/git-real-core/src/model/status.rs`, `src/status.rs`
- Modify: `src/model/mod.rs`, `src/lib.rs`, `tests/common/mod.rs`
- Test: `tests/status.rs`

**Interfaces:**

- Produces: `ChangeKind`, `StatusEntry`, `WorkingTreeStatus` exactly as in spec §3.2; `impl RepoSession { pub fn status(&self) -> Result<WorkingTreeStatus, GitError> }`.
- Fixture helpers added to `tests/common/mod.rs` (used by Tasks 3–5): `write_file(root, rel, contents)`, `stage(root, rel)` (git2 `add_path` or `remove_path` when missing), `commit_all(root, message) -> Oid`, `temp_repo_with_conflict() -> (TempDir, PathBuf)` (branch `other` edits `README.md` line 1, `main` edits the same line, `repo.merge` leaves `README.md` conflicted), `temp_repo_unborn() -> (TempDir, PathBuf)` (init, no commit).

**Behaviour:** spec §3.3 "status()".

- [ ] **Step 1 (`architect` + `tdd-tester`):** tests:
  - `status_clean_repo_is_empty` — fixture → `entries.is_empty()`, `head_unborn == false`.
  - `status_untracked_file` — write `new.txt` → one entry `{ path: "new.txt", index: None, worktree: Some(Untracked), conflicted: false }`.
  - `status_untracked_in_new_dir_is_recursed` — `dir/a.txt` → path `dir/a.txt` (not `dir/`).
  - `status_modified_unstaged` — edit README → `worktree: Some(Modified)`, `index: None`.
  - `status_staged_added` — write+stage → `index: Some(Added)`.
  - `status_staged_modified` — edit+stage README → `index: Some(Modified)`.
  - `status_staged_deleted` — delete+stage → `index: Some(Deleted)`.
  - `status_unstaged_deleted` — delete README → `worktree: Some(Deleted)`.
  - `status_staged_rename` — rename README to `DOC.md` via stage remove + add → one entry `{ path: "DOC.md", old_path: Some("README.md"), index: Some(Renamed) }`.
  - `status_lists_file_changed_in_index_and_worktree` — edit+stage, edit again → `index: Some(Modified)` and `worktree: Some(Modified)` on the same entry.
  - `status_conflicted` — conflict fixture → `conflicted == true`, `worktree: Some(Conflicted)`, `index: None`.
  - `status_ignored_files_excluded` — `.gitignore` with `*.log`, write `x.log` → no `x.log` entry (the `.gitignore` itself is untracked).
  - `status_entries_sorted_by_path` — write `b.txt`, `a.txt`, `c/d.txt` → paths in order.
  - `status_head_unborn` — unborn fixture with one untracked file → `head_unborn == true`.
  - `status_serializes_camel_case` — `serde_json::to_value` of an entry has keys `path, oldPath, index, worktree, conflicted` and kind `"typeChange"` for `TypeChange`.
- [ ] **Step 2:** red (compile failure).
- [ ] **Step 3 (`developer`):** implement; re-export new model types from `lib.rs` via `model::*`.
- [ ] **Step 4:** Rust gates green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).**
- [ ] **Step 6 (gate):** Commit: `feat(core): working tree status`.

---

### Task 3: Core — diff model and `RepoSession::file_diff`

**Files:**

- Create: `src/model/diff.rs`, `src/diff/mod.rs`
- Modify: `src/model/mod.rs`, `src/lib.rs`, `src/error.rs` (add `NoChanges(String)`)
- Test: `tests/diff.rs`

**Interfaces:**

- Produces: `DiffScope`, `DiffLineKind`, `DiffLine`, `Hunk`, `FileDiff`, `DiffOptions` (with `Default` = `{ ignore_whitespace: false, context_lines: 3, max_lines: 10_000 }`) as in spec §3.2; `impl RepoSession { pub fn file_diff(&self, path: &str, scope: DiffScope, opts: DiffOptions) -> Result<FileDiff, GitError> }`.
- `HunkSelection`/`HunkAction` are defined here too (DTOs) but used in Task 4.

**Behaviour:** spec §3.3 "file_diff".

- [ ] **Step 1 (`architect` + `tdd-tester`):** tests (fixture README is `# fixture\n`):
  - `diff_unstaged_modified_single_hunk` — append line → one hunk, `old_start 1, old_lines 1, new_start 1, new_lines 2`, lines `[Context "# fixture" (1,1), Addition "second" (None, 2)]`, `change: Some(Modified)`, `scope: Unstaged`.
  - `diff_untracked_file_shows_all_additions` — write `new.txt` with 3 lines → `change: Some(Untracked)`, one hunk with 3 Additions, `old_lineno` all None.
  - `diff_staged_added_file` — write+stage → `Staged`, `change: Some(Added)`, Additions.
  - `diff_staged_unborn_head_uses_empty_tree` — unborn fixture, stage a file → `Ok`, Additions.
  - `diff_staged_rename_has_old_path` — stage rename → `old_path == Some("README.md")`, `path == "DOC.md"`.
  - `diff_no_changes_in_scope_errors` — clean fixture, `Unstaged` README → `Err(NoChanges(p))` with `p == "README.md"`.
  - `diff_deleted_file_all_deletions` — delete README → `change: Some(Deleted)`, one Deletion with `new_lineno None`.
  - `diff_binary_has_no_hunks` — write `img.bin` with bytes incl. `\0` → `is_binary == true`, `hunks.is_empty()`.
  - `diff_no_newline_at_eof_flag` — write `a.txt` = `"x"` (no newline), stage, then change to `"y"` → Deletion line `x` with `no_newline_at_eof == true`.
  - `diff_strips_crlf` — content `"a\r\nb\r\n"` untracked → contents `"a"`, `"b"`.
  - `diff_ignore_whitespace_hides_indent_change` — change `# fixture` to `  # fixture  ` with `ignore_whitespace: true` → `Err(NoChanges)`; with `false` → one hunk.
  - `diff_context_lines_option` — 10-line file committed, edit line 5, `context_lines: 1` → hunk has 3 lines; default → 7... (tester computes from git2 behaviour: assert `old_lines == 3` for 1 and `== 7` for 3).
  - `diff_truncates_at_max_lines` — 50-line untracked file, `max_lines: 10` → `truncated == true`, total collected lines `== 10`.
  - `diff_serializes_camel_case` — keys `oldLineno, newLineno, noNewlineAtEof, isBinary, oldPath`.
- [ ] **Step 2:** red.
- [ ] **Step 3 (`developer`):** implement with `Diff::foreach` (file, binary, hunk, line callbacks); stop collecting once `max_lines` reached (return `false` from the line callback and treat the resulting `GIT_EUSER` error as success when `truncated` is set).
- [ ] **Step 4:** gates green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).**
- [ ] **Step 6 (gate):** Commit: `feat(core): per-file diff model`.

---

### Task 4: Core — patch builder and `apply_hunk`

**Files:**

- Create: `src/diff/patch.rs`
- Modify: `src/diff/mod.rs` (add `apply_hunk`), `src/error.rs` (add `BadSelection`, `ApplyFailed(String)`)
- Test: inline `#[cfg(test)]` in `patch.rs`; `tests/patch_apply.rs`

**Interfaces:**

- Produces: `pub fn build_patch(diff: &FileDiff, selection: &HunkSelection, reverse: bool) -> Result<String, GitError>`; `impl RepoSession { pub fn apply_hunk(&self, path: &str, action: HunkAction, selection: &HunkSelection) -> Result<(), GitError> }`.

**Behaviour:** spec §3.3 "build_patch" and "apply_hunk". Patch text format:

```
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # fixture
+second
```

Added file: `--- /dev/null`, `+++ b/<path>`, `@@ -0,0 +1,N @@`. Deleted file: `--- a/<path>`, `+++ /dev/null`, `@@ -1,N +0,0 @@`. Reverse swaps headers (`a/` old becomes the new side) and line signs. Partial selection recomputes `old_lines`/`new_lines`; a hunk that ends up with no `+`/`-` lines → `BadSelection`.

- [ ] **Step 1 (`architect` + `tdd-tester`):** unit tests in `patch.rs` building `FileDiff` values by hand:
  - `build_patch_whole_hunk_round_trips_header_and_lines`
  - `build_patch_added_file_uses_dev_null_old`
  - `build_patch_deleted_file_uses_dev_null_new`
  - `build_patch_partial_lines_keeps_unselected_deletions_as_context` — hunk `[-a, -b, +c, +d]` selecting `[0, 2]` → ` b` as context... i.e. lines `-a`, ` b`, `+c`; counts `-1,2 +1,2`.
  - `build_patch_partial_lines_drops_unselected_additions`
  - `build_patch_reverse_swaps_signs_and_counts`
  - `build_patch_no_newline_marker_follows_flagged_line`
  - `build_patch_out_of_range_hunk_is_bad_selection`, `build_patch_context_line_index_is_bad_selection`, `build_patch_empty_selection_is_bad_selection`
    Integration tests in `tests/patch_apply.rs`:
  - `apply_hunk_stage_whole_hunk` — append line → `apply_hunk(Stage, {0, None})` → `status` shows `index: Some(Modified)`, `worktree: None`.
  - `apply_hunk_stage_lines_leaves_worktree_untouched` — two separate edits in one hunk; stage one line → index has only that line (verify via `file_diff(Staged)` content), workdir file unchanged on disk.
  - `apply_hunk_unstage_whole_hunk` — stage all, unstage hunk 0 → `index: None`, `worktree: Some(Modified)`.
  - `apply_hunk_discard_hunk_restores_file` — edit, discard hunk 0 → file content equals original, status clean.
  - `apply_hunk_discard_lines_partial` — two edits, discard one line → only the other remains on disk.
  - `apply_hunk_stage_untracked_file_whole` — untracked, `Stage {0, None}` → `index: Some(Added)`.
  - `apply_hunk_bad_hunk_index_errors` → `BadSelection`.
  - `apply_hunk_stale_patch_fails_cleanly` — build situation where the hunk no longer applies (stage, then change the file's first line so the context mismatches, then unstage with a selection computed... ) → `Err(ApplyFailed(_))` and the index unchanged. (Tester may instead craft it by calling `build_patch` on a modified `FileDiff` through a `#[doc(hidden)] pub fn apply_patch_text` exposed for tests; the architect decides.)
- [ ] **Step 2:** red.
- [ ] **Step 3 (`developer`):** implement; `apply_hunk` computes the diff with `DiffOptions { ignore_whitespace: false, ..Default::default() }` and `max_lines: usize::MAX`, builds the patch, `git2::Diff::from_buffer`, `repo.apply(&diff, location, None)`, mapping errors to `ApplyFailed(e.message())`.
- [ ] **Step 4:** gates green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).**
- [ ] **Step 6 (gate):** Commit: `feat(core): hunk and line staging via patches`.

---

### Task 5: Core — index operations and gitignore

**Files:**

- Create: `src/index_ops.rs`, `src/ignore.rs`
- Modify: `src/lib.rs`
- Test: `tests/index_ops.rs`, `tests/ignore.rs`, inline tests for `gitignore_pattern`

**Interfaces:**

- Produces: `impl RepoSession { pub fn stage_paths(&self, paths: &[String]) -> Result<(), GitError>; pub fn unstage_paths(&self, paths: &[String]) -> Result<(), GitError>; pub fn stage_all(&self) -> Result<(), GitError>; pub fn unstage_all(&self) -> Result<(), GitError>; pub fn discard_paths(&self, paths: &[String]) -> Result<(), GitError>; pub fn add_to_gitignore(&self, path: &str) -> Result<String, GitError> }`; `pub fn gitignore_pattern(path: &str, is_dir: bool) -> String`.

**Behaviour:** spec §3.3 "Index operations" and "add_to_gitignore".

- [ ] **Step 1 (`architect` + `tdd-tester`):** tests:
  - `stage_paths_stages_untracked`, `stage_paths_stages_modified`, `stage_paths_stages_deletion` (file removed on disk → `index: Some(Deleted)`), `stage_paths_merges_worktree_change_into_index`, `stage_paths_multiple`, `stage_paths_marks_conflict_resolved` (conflict fixture, write resolved content, stage → `conflicted == false`), `stage_paths_unknown_path_is_path_not_found`.
  - `stage_all_stages_everything_including_deletions`.
  - `unstage_paths_restores_index_to_head`, `unstage_paths_unborn_removes_from_index`, `unstage_all_clears_staged`, `unstage_all_unborn_clears_index`.
  - `discard_paths_restores_tracked_file`, `discard_paths_restores_index_version_not_head`, `discard_paths_deletes_untracked_file`, `discard_paths_removes_untracked_dir`, `discard_paths_restores_deleted_tracked_file`, `discard_paths_unknown_path_is_path_not_found`.
  - `gitignore_pattern_file_is_rooted`, `gitignore_pattern_dir_has_trailing_slash`, `add_to_gitignore_creates_file`, `add_to_gitignore_appends_with_newline_fix` (existing file without trailing newline), `add_to_gitignore_makes_status_hide_path`.
- [ ] **Step 2:** red.
- [ ] **Step 3 (`developer`):** implement.
- [ ] **Step 4:** gates green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).**
- [ ] **Step 6 (gate):** Commit: `feat(core): stage, unstage, discard, gitignore`.

---

### Task 6: App — watcher, events, error kinds, worktree commands

**Files:**

- Create: `src-tauri/src/watcher.rs`, `src-tauri/src/commands/worktree.rs`
- Modify: `src-tauri/src/events.rs`, `src-tauri/src/error.rs`, `src-tauri/src/state.rs` (add `WatcherRegistry`), `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/repo.rs`, `src-tauri/src/lib.rs`, `src-tauri/tests/common/mod.rs`, `src-tauri/tests/error.rs`
- Test: `src-tauri/tests/worktree_commands.rs`, `src-tauri/tests/watcher.rs`

**Interfaces:**

- Produces:
  ```rust
  // events.rs
  pub const REPO_CHANGED: &str = "repo-changed";
  pub struct RepoChangedPayload { pub repo_id: RepoId }
  // watcher.rs
  pub struct RepoWatcher { /* notify watcher + debounce thread handle + stop flag */ }
  impl RepoWatcher {
      pub fn start(workdir: &Path, debounce: Duration, on_change: impl Fn() + Send + 'static) -> Result<Self, notify::Error>;
  }
  impl Drop for RepoWatcher { /* stops the thread */ }
  pub fn is_relevant(workdir: &Path, path: &Path) -> bool  // false under .git/objects or *.lock
  // state.rs
  pub struct WatcherRegistry(Mutex<HashMap<RepoId, RepoWatcher>>);
  impl WatcherRegistry { pub fn insert(&self, id, w); pub fn remove(&self, id) -> bool }
  // error.rs: AppErrorKind::{NoChanges, BadSelection, ApplyFailed}
  // commands/worktree.rs: *_inner fns taking &RepoRegistry (+ args), and #[tauri::command] wrappers:
  get_status, get_file_diff, stage_paths, unstage_paths, stage_all, unstage_all, discard_paths, apply_hunk, add_to_gitignore
  ```
- `commands/repo.rs`: after `register_session` returns a newly inserted id, `open_repo`/`init_repo`/`clone_repo` wrappers (not the `_inner`s) call `RepoWatcher::start` with `on_change` emitting `REPO_CHANGED` via `app.emit`, and insert into `WatcherRegistry`; failure to start logs with `eprintln!` and continues. `close_repo` removes the watcher.
- `lib.rs` manages `Arc<WatcherRegistry>` and registers the nine commands.

- [ ] **Step 1 (`architect` + `tdd-tester`):** tests:
  - `tests/error.rs`: `no_changes_maps_to_no_changes_kind`, `bad_selection_maps`, `apply_failed_maps` (serialized `kind` strings `noChanges`, `badSelection`, `applyFailed`).
  - `tests/watcher.rs`: `watcher_emits_once_for_burst` (start with 100 ms debounce on temp dir; write 5 files quickly; wait 400 ms; counter == 1), `watcher_emits_again_after_quiet_period` (two bursts separated by 300 ms → 2), `watcher_ignores_git_objects` (write under `.git/objects/aa/` → 0), `watcher_ignores_lock_files` (`.git/index.lock` → 0), `watcher_stops_on_drop` (drop, write, wait → counter unchanged), `is_relevant_rules` (pure).
  - `tests/worktree_commands.rs`: one happy-path test per `_inner` (`get_status_inner_lists_untracked`, `get_file_diff_inner_returns_hunks`, `stage_paths_inner`, `unstage_paths_inner`, `stage_all_inner`, `unstage_all_inner`, `discard_paths_inner`, `apply_hunk_inner_stages_hunk`, `add_to_gitignore_inner_returns_pattern`), plus `unknown_repo_id_errors_for_every_command` (loop over all nine with id 999 → `unknownRepo`), `get_file_diff_inner_no_changes_errors`, `apply_hunk_inner_bad_selection_errors`.
  - `tests/registry.rs`: `watcher_registry_insert_remove`.
- [ ] **Step 2:** red.
- [ ] **Step 3 (`developer`):** implement. The debounce thread: `recv_timeout(debounce)` loop on the notify channel; on first relevant event mark dirty, keep draining until a timeout with no events occurs, then call `on_change` once. Use `notify::recommended_watcher` with `RecursiveMode::Recursive`.
- [ ] **Step 4:** gates green.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).**
- [ ] **Step 6 (gate):** Commit: `feat(app): worktree commands and file watcher`.

---

### Task 7: Front end — IPC types/wrappers/events, query keys, workspace store, hooks

**Files:**

- Modify: `src/lib/ipc/types.ts`, `src/lib/ipc/commands.ts`, `src/lib/ipc/events.ts`, `src/lib/query/keys.ts`
- Create: `src/lib/store/workspace.ts`, `src/features/worktree/useStatus.ts`, `src/features/worktree/useWorktreeActions.ts`, `src/features/worktree/useFileSelection.ts`
- Test: `commands.test.ts`, `events.test.ts`, `keys.test.ts` (extend), `workspace.test.ts`, `useStatus.test.tsx`, `useWorktreeActions.test.tsx`, `useFileSelection.test.ts`

**Interfaces:**

- Produces (TS):
  ```ts
  // types.ts: ChangeKind = "added"|"modified"|"deleted"|"renamed"|"typeChange"|"untracked"|"conflicted";
  // StatusEntry, WorkingTreeStatus, DiffScope = "staged"|"unstaged", DiffLineKind, DiffLine, Hunk, FileDiff,
  // HunkSelection { hunkIndex: number; lines: number[] | null }, HunkAction = "stage"|"unstage"|"discard",
  // RepoChangedPayload { repoId: RepoId }; AppErrorKind += "noChanges"|"badSelection"|"applyFailed"
  // commands.ts
  getStatus(id): Promise<WorkingTreeStatus>; getFileDiff(id, path, scope, ignoreWhitespace): Promise<FileDiff>;
  stagePaths(id, paths): Promise<void>; unstagePaths(id, paths); stageAll(id); unstageAll(id); discardPaths(id, paths);
  applyHunk(id, path, action, selection): Promise<void>; addToGitignore(id, path): Promise<string>;
  // events.ts
  onRepoChanged(repoId, handler: () => void): Promise<UnlistenFn>
  // keys.ts
  queryKeys.repo(id) => ["repo", id] as const; queryKeys.status(id) => ["repo", id, "status"];
  queryKeys.fileDiff(id, path, scope, ignoreWs) => ["repo", id, "diff", path, scope, ignoreWs]
  // store/workspace.ts
  interface SelectedFile { path: string; scope: DiffScope }
  useWorkspace: { selected: Record<RepoId, SelectedFile | null>; select(repoId, file | null); clear(repoId) }
  // useStatus(repoId): { status: WorkingTreeStatus | undefined; isLoading; error: AppError | null; refetch }
  // useWorktreeActions(repoId): { stage(paths), unstage(paths), stageAll(), unstageAll(), discard(paths), addToGitignore(path), pending: boolean, error: AppError | null, clearError() }
  // useFileSelection(orderedPaths: string[]): { selected: Set<string>; click(path, { ctrl, shift }); clear(); isSelected(path) }
  ```

**Behaviour:** `useStatus` subscribes with `onRepoChanged` in an effect (unlisten on cleanup) and calls `queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) })`; its query sets `refetchOnWindowFocus: true`. `useWorktreeActions` uses `useMutation` per action; `onSettled` invalidates `queryKeys.repo(repoId)`; errors are coerced with `isAppError` like `useOpenRepo.toAppError`. `useFileSelection`: plain click → only that path; ctrl → toggle; shift → range from the anchor (last plain click) in `orderedPaths` order; paths no longer present are pruned.

- [ ] **Step 1 (`architect` + `tdd-tester`):** tests: one `mockIPC` test per wrapper asserting command name and camelCase args (`ignoreWhitespace`, `hunkIndex`); `onRepoChanged` filters by `repoId` (use `mockIPC` + `emit` from `@tauri-apps/api/event`... the tester follows the existing `events.test.ts` pattern); keys shape; store select/clear per repo; `useStatus` invalidates on event and unlistens on unmount; `useWorktreeActions` each action invokes the wrapper and invalidates the repo key, error surfaces as `AppError`, non-AppError becomes `{ kind: "io" }`; `useFileSelection` plain/ctrl/shift/prune/anchor cases.
- [ ] **Step 2:** red (`npm test`).
- [ ] **Step 3 (`developer`).**
- [ ] **Step 4:** FE gates green with 100 % coverage.
- [ ] **Step 5 (`tdd-tester-coverage` + `code-reviewer`).**
- [ ] **Step 6 (gate):** Commit: `feat(ui): worktree IPC, queries, and hooks`.

---

### Task 8: Front end — shared `ContextMenu` and `ConfirmDialog`

**Files:**

- Create: `src/components/ContextMenu.tsx` (+ `.module.css`), `src/components/ConfirmDialog.tsx` (+ `.module.css`); delete `src/components/.gitkeep`
- Test: `ContextMenu.test.tsx`, `ConfirmDialog.test.tsx`

**Interfaces:**

```ts
interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
}
function ContextMenu(props: {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}): JSX.Element | null;
// role="menu", items role="menuitem"; first item focused on open; ArrowUp/Down cycle; Enter/Space select then onClose; Escape and outside mousedown → onClose; positioned fixed at (x, y)
function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}): JSX.Element | null;
// role="dialog" aria-modal aria-labelledby; cancel button focused on open; Escape → onCancel; backdrop click → onCancel; confirm button has data-danger when danger
```

- [ ] **Step 1 (`architect` + `tdd-tester`):** tests for every behaviour listed in the interface comments, both components, incl. `renders nothing when closed`, `disabled item not selectable`, `danger styling attribute`.
- [ ] **Steps 2–6** as usual. Commit: `feat(ui): shared context menu and confirm dialog`.

---

### Task 9: Front end — `ChangesPanel`, rows, badges, tokens, `RepoPane` layout

**Files:**

- Create: `src/features/worktree/StatusBadge.tsx`, `FileRow.tsx`, `ChangesPanel.tsx` (+ `.module.css` each); delete `src/features/worktree/.gitkeep`
- Modify: `src/app/RepoPane.tsx`, `src/app/RepoPane.module.css`, `src/styles/tokens.css`
- Test: `StatusBadge.test.tsx`, `FileRow.test.tsx`, `ChangesPanel.test.tsx`, `RepoPane.test.tsx` (extend)

**Interfaces:**

```ts
function StatusBadge({ kind }: { kind: ChangeKind }); // letter: added A, modified M, deleted D, renamed R, typeChange T, untracked U, conflicted C; aria-label = kind words ("type change")
function FileRow(props: {
  entry: StatusEntry;
  section: "conflicts" | "staged" | "unstaged";
  selected: boolean;
  disabled: boolean;
  onClick(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void;
  onContextMenu(x: number, y: number): void;
  onPrimary(): void;
  onDiscard?(): void;
});
// primary button label: "Stage <path>" in unstaged/conflicts, "Unstage <path>" in staged; discard button "Discard <path>" only in unstaged
function ChangesPanel({ repoId }: { repoId: RepoId });
```

Tokens added to `tokens.css` (light / dark): `--color-added: #1a7f37 / #3fb950`, `--color-removed: #cf222e / #f85149`, `--color-modified: #9a6700 / #d29922`, `--color-danger: #cf222e / #f85149`, `--color-surface-hover: #ebebeb / #333333`.

**Behaviour:** spec §5.2. `ChangesPanel` composes `useStatus`, `useWorktreeActions`, `useFileSelection` (ordered paths = conflicts, staged, unstaged in display order, keyed as `${section}:${path}` so a file in two sections selects independently), `useWorkspace.select(repoId, { path, scope })` on row click (`scope` "staged" for the staged section, else "unstaged"), `ConfirmDialog` for discard (title "Discard changes to <path>?" or, for untracked, "Delete <path>?"; with N selected: "Discard changes to N files?"), `ContextMenu` on right-click (untracked: "Add to .gitignore" + "Delete…"; unstaged tracked: "Stage", "Discard…"; staged: "Unstage"; conflicts: "Mark resolved (stage)"). Loading state `role="status"` "Loading changes…"; error via `RepoError` with `path={null}`.
`RepoPane`: `header` row (name, path, branch as today), then a `.body` grid `grid-template-columns: 320px 1fr` with `ChangesPanel` left and `<section aria-label="Detail">Select a file to view its diff</section>` right.

- [ ] **Step 1 (`architect` + `tdd-tester`):** tests: badge letters/labels for all seven kinds; row labels and buttons per section; panel renders sections with counts and hides empty ones; empty state; stage/unstage single row calls wrapper with `[path]`; multi-select then stage calls with all selected paths of that section; Stage all / Unstage all; discard opens confirm, cancel does nothing, confirm calls `discardPaths`; untracked discard copy; context menu items per section and "Add to .gitignore" calls `addToGitignore`; buttons disabled while pending; error renders and dismisses; `RepoPane` renders the panel and placeholder.
- [ ] **Steps 2–6** as usual. Commit: `feat(ui): changes panel with stage, unstage, discard`.

---

## Self-review notes

- Spec coverage: §3 → Tasks 2–5; §4 → Tasks 1, 6; §5 → Tasks 7–9. Hunk/line controls intentionally deferred to GR-5 (spec "Scope split").
- Type consistency: `HunkSelection { hunkIndex, lines }`, `HunkAction`, `DiffScope` names match across Rust (camelCase serde) and TS. `queryKeys.repo(id)` is the invalidation prefix used by Tasks 7 and 9.
- Review Focus lines are each pinned to a named test in Tasks 2, 4, 5, 6.
