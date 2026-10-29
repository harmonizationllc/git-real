# GR-39 Linked Worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Worktrees section in the refs column lists every worktree of the open repository; double-click opens one as a tab; a dialog adds one from an existing or new branch into a chosen folder; remove confirms (twice when dirty); prune clears stale entries; branches checked out in another worktree are badged and locked in the branch list.

**Architecture:** Core reads worktrees with git2 (`Repository::worktrees`, `find_worktree`, `open_from_worktree`, the admin `HEAD` file for a missing folder) and writes with the git CLI through `git_ops::run` (`git worktree add|remove|prune`). `list_branches` gains a per-branch `worktree` path from the same listing, and checkout/delete refuse such branches before git runs. The app layer adds four commands, seven error kinds, a second watcher root (the common dir of a linked worktree) and two layout settings. The front end adds typed IPC wrappers, a `linkedWorktrees` feature (list hook, actions hook, panel, row, add dialog), a sixth refs section, and badge/gating changes in the branches feature. Opening a worktree is the existing `openRepo` flow.

**Tech Stack:** Rust 2024 + git2 0.20 (`default-features = false`), system git CLI (≥ 2.18 for worktree remove of a gone folder), Tauri 2, notify 8, React 19 + TypeScript, TanStack Query 5, zustand, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-28-gr39-linked-worktrees-design.md`

## Global Constraints

- Tests come first and are written by the test role. The developer role never edits test files (CLAUDE.md).
- Only `src/lib/ipc` imports `@tauri-apps/api/*`. `git2` stays `default-features = false`. No direct `tokio`; blocking work runs through `run_blocking`. `git-real-core` has no Tauri dependency and no platform assumptions.
- Naming: core module `linked_worktrees`, model `LinkedWorktree`, commands `list_linked_worktrees`, `add_linked_worktree`, `remove_linked_worktree`, `prune_linked_worktrees`, feature folder `src/features/linkedWorktrees/`. The existing `commands::worktree` / `features/worktree` (the working tree) are not renamed. User-facing word: "worktree".
- Reads use git2; `add`, `remove`, `prune` use `git_ops::run(&git, workdir, "worktree", args, &[])` with `workdir` = the session's own workdir (git resolves the common dir itself). argv after `-C <workdir>` (each element separate, never joined): `worktree add -b <name> <path> [<start>]` for a new branch (`<start>` passed verbatim only when given), `worktree add <path> <name>` for an existing branch, `worktree remove [--force] <path>`, `worktree prune`. `<path>` is the entry's path for remove (canonical when the folder exists) and the caller's path for add, converted with `to_string_lossy`.
- Order of checks. `add`, new branch: `validate_branch_name` → `BranchExists` → start resolves to a commit (`RevisionNotFound`; a start beginning with `-` is `RevisionNotFound` without consulting git2) or, with no start, HEAD is born (`UnbornHead`) → path check → git. `add`, existing branch: `BranchNotFound` → `BranchCheckedOut` (the session's own HEAD first, then other worktrees) → path check → git. Path check: a path that exists must be an empty directory, else `PathExists(path)`. `remove`: `WorktreeNotFound` → `CannotRemoveMain` → `CannotRemoveCurrent` → `WorktreeLocked` → (when `!force` and the folder exists) dirty check → git. `prune`: collect candidates → git.
- Dirty check: `Repository::open(entry.path)`, `statuses` with `include_untracked(true).recurse_untracked_dirs(true).include_ignored(false)`; any entry is `WorktreeDirty(path)`.
- Listing rules (spec §2–3): bare session → empty. Main row from `Repository::open(commondir)` when that repository is not bare: path = its canonical `workdir()`, `head` = `head_state` of it, `name: None`, `is_main: true`. Linked rows: one per `worktrees()` name, `find_worktree` failures skipped, path canonicalized when it exists, `missing = !path.exists()`, `locked` from `is_locked()` (`Locked(reason)` → `Some(reason.unwrap_or_default())`), `head` = `Repository::open_from_worktree` + `head_state`, else the admin file `<commondir>/worktrees/<name>/HEAD` (`ref: refs/heads/<b>` → `Branch`, a 40-hex line → `Detached`, otherwise `None`). Linked rows sorted by path. `is_current` = path equals the session root. Prune candidates = `missing && locked.is_none()`.
- Checked-out-elsewhere map: every listed row that is not current and whose `head` is `Branch { name }` → `name → path` (missing rows included; the main row included when the session is a linked worktree).
- New `GitError` variants and messages: `BranchCheckedOut { name: String, worktree: PathBuf }` → "`{name}` is checked out in worktree `{folder}`" where folder is the path's last component (or the whole path when it has none); `WorktreeNotFound(PathBuf)` → "`{0}` is not a worktree of this repository"; `WorktreeDirty(PathBuf)` → "`{0}` has uncommitted changes"; `WorktreeLocked(String)` → "the worktree is locked" plus ": `{0}`" when the reason is non-empty; `CannotRemoveMain` → "the main worktree cannot be removed"; `CannotRemoveCurrent` → "the worktree open in this tab cannot be removed from here"; `PathExists(PathBuf)` → "`{0}` already exists and is not empty". `AppErrorKind` / TS kinds: `branchCheckedOut`, `worktreeNotFound`, `worktreeDirty`, `worktreeLocked`, `cannotRemoveMain`, `cannotRemoveCurrent`, `pathExists`. CLI failures are `OperationFailed { verb: "worktree add" | "worktree remove" | "worktree prune" }`.
- Tauri commands (JS args camelCase): `list_linked_worktrees {id}`, `add_linked_worktree {id, path, branch}` with `branch` = `{kind:"existing", name}` | `{kind:"new", name, start}`, `remove_linked_worktree {id, path, force}`, `prune_linked_worktrees {id}` → `{paths}`.
- Watcher: `RepoWatcher::start(workdir, extra: Option<&Path>, debounce, on_change)` watches both roots recursively; `is_relevant(workdir, extra, path)`: under `workdir` the existing rules; under `extra` paths in `objects/` and `*.lock` files are irrelevant, everything else relevant; elsewhere relevant. `extra` = `RepoSession::common_dir_outside_workdir()` (canonical `commondir()` unless it is under the session root).
- Settings: `LayoutSettings.worktrees_collapsed: bool` (default `false`), `worktrees_height: Option<u32>` (default `None`, bounded at `SECTION_HEIGHT_MIN` like the other heights); keys `layout.worktreesCollapsed`, `layout.worktreesHeight`; `LayoutPatch` twins; `src/lib/store/settingsDefaults.json`, TS `Settings.layout`, `DEFAULT_SETTINGS` and `setWorktreesCollapsed` match.
- Refs column: `REFS_SECTIONS = ["branches", "stashes", "tags", "worktrees", "pullRequests", "issues"]`; handle label `Resize Worktrees section`.
- Query keys: `queryKeys.linkedWorktrees(id) = ["repo", id, "linkedWorktrees"]`; `mutationKeys.linkedWorktree(id) = ["linkedWorktree", id]`. Actions invalidate `queryKeys.repo(id)` and `queryKeys.recent` on settle.
- Tab closing: `remove(path, force)` and `prune(paths)` first call `closeRepoTab(tab.id)` for every tab in `useRepoTabs` whose `summary.path` is in the target set, then run the command; a failure leaves them closed.
- Copy (verbatim). Section heading `Worktrees (n)`; `+` accessible name `Add worktree…`; prune button accessible name `Prune stale worktrees`, title `No stale worktrees` when nothing is stale; loading `Loading worktrees…`; bare `Not available for bare repositories`; row branch text as `RepoPane.headLine` (`<name>`, `detached at <7 hex>`, `<name> (no commits yet)`) and `unknown HEAD` when `head` is null; badges `main`, `current`, `missing`, `locked` (locked title = reason, or `Locked` when empty); row title = full path; menu `Open` (titles `Already open in this tab`, `Folder not found`), `Remove…` (titles `The main worktree cannot be removed`, `Close this tab and remove it from another worktree`, `Locked: <reason>` or `Locked`); first confirm title `Remove worktree <folder>?`, body `The folder and its contents are deleted. The branch is kept.`, confirm `Remove`; force confirm title `<folder> has uncommitted changes`, body `Removing it discards them. This can't be undone.`, confirm `Remove anyway`; dialog title `Add worktree`, radios `Existing branch` / `New branch`, select label `Branch`, option suffixes ` (current)` and ` (checked out in <folder>)`, name label `Name`, start radios `Current HEAD` / `Commit`, commit input label `Commit`, folder label `Folder`, `Browse…` (picker title `Choose worktree folder`), `Cancel`, `Add`; branch badge = `<folder>` with title `Checked out in worktree <path>`; branch menu item `Create worktree…`; menu titles `Checked out in worktree <folder>`.
- `defaultWorktreePath(mainPath, branch)`: `<parent of mainPath><sep><basename of mainPath>-<branch with every "/" replaced by "-">`, where `<sep>` is `\` when `mainPath` contains a backslash, else `/`; a blank branch uses `worktree`. `folderName(path)`: the last non-empty segment split on `/` or `\`.
- Checks: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check` (from `src-tauri`), `npm run test:coverage` at 100 % statements/branches/functions/lines for `src/`, `npm run lint`, `npm run typecheck`.

## Review Focus

1. A worktree registered through a symlinked path must still be found by its canonical path on remove, since tabs and dialogs hand core canonical paths (Task 1 test `remove_accepts_the_canonical_path_of_a_symlinked_worktree`, unix only).
2. A branch name with `/` and a Windows-style main path must give a usable default folder (Task 2 tests `defaultWorktreePath` "replaces slashes in the branch" and "keeps a backslash separator").
3. Double-click on the current worktree's row must not open anything, and Open must say why (Task 2 test "should not open the current worktree and disable Open with Already open in this tab").
4. Removing a worktree that vanished in a terminal must show `worktreeNotFound` inline and refetch the list, not hang on a stale row (Task 2 test "should show worktreeNotFound inline and refetch the list").
5. A folder with a space must reach git as one argv element, and a start spec must be passed verbatim, not resolved (Task 1 tests `worktree_add_passes_a_path_with_spaces_as_one_element` and `worktree_add_new_branch_passes_the_start_verbatim`).

## Deviations from spec

- **`WorktreeBranch` owns its strings** (`Existing { name: String }`, `New { name: String, start: Option<String> }`) and derives `Deserialize` with `#[serde(tag = "kind", rename_all = "camelCase")]`, so the Tauri command takes it directly. The spec's borrowed form would need a second type.
- **The admin `HEAD` fallback applies whenever `open_from_worktree` fails**, not only when the folder is missing: one rule, and a folder whose `.git` file is damaged still reports its branch as git does.
- **The main row's HEAD** is `head_state` of the repository opened at the common dir; the spec left the mechanism open.
- **`watch_opened` looks the common dir up through the registry** (`reg.get(id)` → `common_dir_outside_workdir()`), so `open_repo_inner`, `init_repo_inner` and `clone_repo_inner` keep their signatures and tests.
- **Settings land in Task 1 on both sides** (Rust, the shared `settingsDefaults.json` fixture, TS types, store defaults, action), because the Rust defaults test reads the fixture and the TS store test compares against it.
- **The add dialog reports success through `onAdded(path)`**; its opener (panel or branches panel) opens the tab with `useOpenRepo` and shows any open error inline. The dialog itself owns an `useLinkedWorktreeActions` instance, as `CreateTagDialog` does, so add errors never leak into a panel.
- **The dialog opens in "New branch" mode from `+`** with an empty name, start "Current HEAD" and the folder tracking the name; from a local branch's menu it opens in "Existing branch" mode with that branch; from a remote branch's menu in "New branch" mode with the name and start `<remote>/<name>`.
- **Double-click (checkout) on a badged branch is not blocked in the row**; the core guard returns `branchCheckedOut` and the panel shows it inline. Only the menu items are disabled.
- **`head_state` becomes `pub(crate)`** in `refs/mod.rs`; `linked_worktrees` is a sibling module.
- **The argv tests create worktrees with git2** (`Repository::worktree(name, path, None)`), since `cli_argv.rs` runs the whole binary against a stand-in git that writes argv into `<workdir>/.git/argv.txt`; every worktree CLI call therefore runs with `-C <main workdir>` in those tests.

---

### Task 1: Core worktree model and operations, branch guards, app commands, watcher second root, settings

**Files:**

- Create: `src-tauri/crates/git-real-core/src/model/linked_worktree.rs`
- Create: `src-tauri/crates/git-real-core/src/linked_worktrees/mod.rs`
- Modify: `src-tauri/crates/git-real-core/src/model/mod.rs` (`mod linked_worktree;` + `pub use linked_worktree::{LinkedWorktree, PrunedWorktrees, WorktreeBranch};`), `src/model/branch.rs` (`LocalBranch.worktree: Option<PathBuf>`), `src/lib.rs` (`pub mod linked_worktrees;` after `pub mod index_ops;`), `src/error.rs` (seven variants), `src/refs/mod.rs` (`pub(crate) fn head_state`, `worktree` in the three `LocalBranch` constructors, guards in `checkout_branch`, `checkout_remote_branch`, `delete_branch`), `src/settings.rs` (two layout fields, defaults, patch, bounds list, read leaves, apply)
- Modify: `src/lib/store/settingsDefaults.json` (`"worktreesCollapsed": false`, `"worktreesHeight": null` after `tagsHeight`), `src/lib/ipc/types.ts` (`Settings.layout.worktreesCollapsed: boolean; worktreesHeight: number | null`), `src/lib/store/settings.ts` (`DEFAULT_SETTINGS.layout` twins), `src/lib/store/settingsActions.ts` (`setWorktreesCollapsed`)
- Create: `src-tauri/src/commands/linked_worktrees.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`pub mod linked_worktrees;`), `src-tauri/src/lib.rs` (four handlers after `commands::worktree::*` entries), `src-tauri/src/error.rs` (seven kinds + mapping), `src-tauri/src/watcher.rs` (second root), `src-tauri/src/commands/repo.rs` (`ensure_watcher` / `watch_opened` pass the common dir)
- Test: `src-tauri/crates/git-real-core/tests/linked_worktrees.rs` (new), `tests/cli_argv.rs` (extend), `tests/branches.rs` (extend: `worktree: None` in literals, guard tests), `tests/settings.rs` (extend), `src-tauri/tests/linked_worktree_commands.rs` (new), `src-tauri/tests/error.rs` (extend), `src-tauri/tests/watcher.rs` (extend, 3-arg `is_relevant`), `src/lib/store/settings.test.ts`, `src/lib/store/settingsActions.test.ts`, `src/lib/ipc/settings.test.ts` (extend)

**Interfaces:**

- Consumes (verified): `git_ops::run(git, workdir, verb, args, env) -> Result<Output, GitError>`, `git_ops::operation_failed(verb, &output) -> GitError`, `RepoSession::{repo(), workdir(), path(), git() -> (PathBuf, &Path)}`, `refs::validate_branch_name`, private `refs::{find_local, new_branch_target, head_state}`, `git2::{Repository::{worktrees, find_worktree, open_from_worktree, commondir, is_bare, workdir, statuses}, Worktree::{path, is_locked, name}, WorktreeLockStatus}`, `StatusOptions`. App: `with_session`, `run_blocking`, `RepoRegistry::get`, `WatcherRegistry`, `RepoWatcher`. Test helpers: core `common::{temp_repo_with_commit, temp_repo_unborn, temp_bare_clone, add_remote_and_fetch, head_branch_name, write_file, commit_file, run_git, run_git_ok, git_available}`, `cli_argv.rs` `use_fake_git`/`argv`; app `common::{temp_repo_with_commit, configure_identity, git_available, write_file}`.
- Produces:

```rust
// model/linked_worktree.rs (serde camelCase)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkedWorktree { pub name: Option<String>, pub path: PathBuf, pub head: Option<HeadState>, pub is_main: bool, pub is_current: bool, pub missing: bool, pub locked: Option<String> }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)] #[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorktreeBranch { Existing { name: String }, New { name: String, start: Option<String> } }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrunedWorktrees { pub paths: Vec<PathBuf> }
// model/branch.rs: LocalBranch gains `pub worktree: Option<PathBuf>` (last field)
// linked_worktrees/mod.rs
impl RepoSession {
    pub fn list_linked_worktrees(&self) -> Result<Vec<LinkedWorktree>, GitError>;
    pub fn add_linked_worktree(&self, path: &Path, branch: &WorktreeBranch) -> Result<(), GitError>;
    pub fn remove_linked_worktree(&self, path: &Path, force: bool) -> Result<(), GitError>;
    pub fn prune_linked_worktrees(&self) -> Result<PrunedWorktrees, GitError>;
    pub fn common_dir_outside_workdir(&self) -> Option<PathBuf>;
    pub(crate) fn checked_out_elsewhere(&self) -> Result<BTreeMap<String, PathBuf>, GitError>;
}
// commands/linked_worktrees.rs
pub fn list_linked_worktrees_inner(reg: &RepoRegistry, id: RepoId) -> Result<Vec<LinkedWorktree>, AppError>;
pub fn add_linked_worktree_inner(reg: &RepoRegistry, id: RepoId, path: &Path, branch: &WorktreeBranch) -> Result<(), AppError>;
pub fn remove_linked_worktree_inner(reg: &RepoRegistry, id: RepoId, path: &Path, force: bool) -> Result<(), AppError>;
pub fn prune_linked_worktrees_inner(reg: &RepoRegistry, id: RepoId) -> Result<PrunedWorktrees, AppError>;
// + #[tauri::command] async list_linked_worktrees(reg, id), add_linked_worktree(reg, id, path: String, branch: WorktreeBranch), remove_linked_worktree(reg, id, path: String, force: bool), prune_linked_worktrees(reg, id)
// watcher.rs
impl RepoWatcher { pub fn start(workdir: &Path, extra: Option<&Path>, debounce: Duration, on_change: impl Fn() + Send + 'static) -> Result<Self, notify::Error>; }
pub fn is_relevant(workdir: &Path, extra: Option<&Path>, path: &Path) -> bool;
```

```ts
// settingsActions.ts
export function setWorktreesCollapsed(worktreesCollapsed: boolean): void; // setPref({ layout: { worktreesCollapsed } })
```

- [ ] **Step 1: Write the failing core tests** (`src-tauri/crates/git-real-core/tests/linked_worktrees.rs`; every test that runs git starts with `if !common::git_available() { return; }`). Fixture helpers in the file:

```rust
/// Main repo with one commit plus a second temp dir for linked worktrees.
fn fixture() -> (TempDir, PathBuf, TempDir, PathBuf, String) // (main_dir, main, wt_dir, wt_root, head_branch)
/// `git -C main worktree add -b <branch> <wt_root>/<name>`; returns the canonical path.
fn add_worktree(main: &Path, wt_root: &Path, name: &str, branch: &str) -> PathBuf
fn session(path: &Path) -> RepoSession
fn entry<'a>(list: &'a [LinkedWorktree], path: &Path) -> &'a LinkedWorktree
```

Tests and assertions:

- `list_from_main_has_main_first_then_linked_sorted_by_path`: add `b` (branch `feat/b`) and `a` (branch `feat/a`); list from main has 3 rows; row 0 is `{ name: None, path: main canonical, head: Some(Branch{head_branch}), is_main: true, is_current: true, missing: false, locked: None }`; rows 1–2 paths are `[a, b]`; row 1 is `{ name: Some("a"), head: Some(Branch{"feat/a"}), is_main: false, is_current: false, .. }`.
- `list_from_linked_worktree_marks_it_current_and_same_set`: session on `a` lists the same 3 paths; only `a` has `is_current`; main row still `is_main`.
- `list_reports_detached_head`: `git worktree add --detach <path>`; row head is `Some(Detached{oid})` with the main head oid.
- `list_missing_folder_reads_branch_from_admin_head`: `remove_dir_all(a)`; row has `missing: true`, `head: Some(Branch{"feat/a"})`, `path == a` (the registered path).
- `list_missing_detached_reads_oid_from_admin_head`: detached worktree deleted → `head: Some(Detached{oid})`.
- `list_corrupt_admin_head_has_no_head`: delete the folder, overwrite `main/.git/worktrees/a/HEAD` with `"garbage\n"` → `head: None`, `missing: true`.
- `list_locked_with_reason_and_without`: `git worktree lock --reason demo a`, `git worktree lock b` → `locked: Some("demo")` and `Some("")`.
- `list_bare_session_is_empty`: `temp_bare_clone` session → `vec![]`.
- `list_linked_worktree_of_bare_repo_has_no_main_row`: `git -C <bare> worktree add <wt_root>/w <head_branch>`; session on `w` → one row, `is_main: false`, `is_current: true`.
- `list_separate_git_dir_main_row_is_the_workdir`: `git init --separate-git-dir=<wt_root>/gitdir <wt_root>/work`, `configure_identity`, `commit_file`; add a worktree from `work`; session on the worktree → main row path == canonical `work`.
- `add_existing_branch_creates_worktree_on_it`: `git branch feat` then `add_linked_worktree(&p, &Existing{"feat"})` → `p` exists, `Repository::open(&p).head().shorthand() == "feat"`.
- `add_new_branch_at_head`: `New{"feat", None}` → worktree on `feat` at the main head oid.
- `add_new_branch_at_commit`: `commit_file` twice; `New{"old", Some(first_oid)}` → the worktree head oid == first oid.
- `add_invalid_name_is_invalid_branch_name` (`"-x"` → `InvalidBranchName`), `add_taken_name_is_branch_exists`, `add_unknown_existing_branch_is_branch_not_found`, `add_unknown_start_is_revision_not_found` (`Some("nope")` and `Some("-x")`), `add_new_on_unborn_head_is_unborn_head`.
- `add_existing_branch_checked_out_here_is_branch_checked_out`: `Existing{head_branch}` → `BranchCheckedOut { name, worktree }` with `worktree` == main canonical.
- `add_existing_branch_checked_out_elsewhere_is_branch_checked_out`: `feat/a` after `add_worktree` → `worktree == a`.
- `add_into_non_empty_folder_is_path_exists`: folder with a file → `PathExists(p)`; folder untouched.
- `add_into_empty_folder_succeeds`.
- `remove_clean_worktree_deletes_folder_and_keeps_branch`: → `!a.exists()`, `list` has 2 rows, `git branch --list feat/a` non-empty.
- `remove_dirty_without_force_is_worktree_dirty_and_keeps_everything`: modify a tracked file in `a` → `WorktreeDirty(a)`; folder and entry still there.
- `remove_untracked_only_without_force_is_worktree_dirty`.
- `remove_dirty_with_force_removes`.
- `remove_missing_folder_without_force_drops_entry`: `remove_dir_all(a)` then `remove(a, false)` → `Ok`, list has no `a`.
- `remove_main_is_cannot_remove_main`, `remove_current_is_cannot_remove_current` (session on `a`, remove `a`), `remove_locked_is_worktree_locked` (reason `"demo"`), `remove_unknown_path_is_worktree_not_found`.
- `remove_accepts_the_canonical_path_of_a_symlinked_worktree` (`#[cfg(unix)]`): `symlink(wt_root, link)`; `git worktree add -b feat <link>/s`; `remove(<canonical wt_root>/s, false)` → `Ok`, entry gone.
- `prune_with_nothing_stale_returns_no_paths`: `PrunedWorktrees { paths: vec![] }`, list unchanged.
- `prune_returns_missing_paths_and_skips_locked`: delete `a` and `b`, lock `b` → `paths == vec![a]`; list keeps `b` (missing, locked) and drops `a`.
- `list_branches_marks_branch_checked_out_in_linked_worktree`: `feat/a`'s `worktree == Some(a)`; `head_branch`'s is `None`.
- `list_branches_marks_branch_of_missing_worktree`: after deleting `a`, still `Some(a)`.
- `list_branches_from_linked_marks_main_branch`: session on `a`: `head_branch.worktree == Some(main)`, `feat/a.worktree == None`.
- `checkout_branch_checked_out_elsewhere_is_refused`: `BranchCheckedOut`, main HEAD unchanged.
- `delete_branch_checked_out_elsewhere_is_refused` (force true and false both `BranchCheckedOut`, branch still exists).
- `checkout_remote_branch_with_local_checked_out_elsewhere_is_refused`: `temp_bare_clone` + `add_remote_and_fetch` (as `branches.rs::remote_fixture`), push `feat/a` so `origin/feat/a` exists, worktree on `feat/a` → `checkout_remote_branch("origin", "feat/a")` is `BranchCheckedOut`.
- `common_dir_outside_workdir_is_none_for_main_and_some_for_linked`: main → `None`; session on `a` → `Some(canonical main/.git)`.
- `error_messages`: `GitError::BranchCheckedOut { name: "x".into(), worktree: "/w/sub".into() }.to_string() == "x is checked out in worktree sub"`; `WorktreeLocked("".into())` → `"the worktree is locked"`; `WorktreeLocked("demo".into())` → `"the worktree is locked: demo"`.

In `tests/cli_argv.rs` (fixtures via git2 `Repository::worktree`): `worktree_add_new_branch_passes_the_start_verbatim` (argv after `-C <workdir>` == `["worktree","add","-b","feat","<path>","HEAD~0"]`), `worktree_add_existing_branch_argv` (`["worktree","add","<path>","feat"]`), `worktree_add_passes_a_path_with_spaces_as_one_element` (`"<root>/my work"` is one element), `worktree_remove_force_argv` (`["worktree","remove","--force","<canonical path>"]`; the git2-created worktree is clean, so pass `force: true` to cover the flag and `false` in a sibling test without it), `worktree_prune_argv` (`["worktree","prune"]`).

In `tests/branches.rs`: add `worktree: None` to every `LocalBranch` literal (compile), nothing else.

In `tests/settings.rs`: mirror the `tagsHeight` cases at lines 479–549 for `worktreesHeight` (string value warns, `0` clamps to `Some(72)`, `null` resets, serialized file contains `"worktreesHeight": null`) and `tagsCollapsed` at 238–245 for `worktreesCollapsed` (default `false`, round-trips `true`); the defaults test that reads `settingsDefaults.json` must keep passing.

- [ ] **Step 2: Write the failing app-layer tests**

`src-tauri/tests/linked_worktree_commands.rs` (setup as `tag_commands.rs::setup`, guard with `common::git_available()` where git runs): `list_linked_worktrees_inner_lists_the_main_worktree` (one row, `is_main && is_current`), `add_linked_worktree_inner_creates_a_worktree` (`New { name: "feat", start: None }` into a temp path; the path then exists), `remove_linked_worktree_inner_removes_it`, `prune_linked_worktrees_inner_returns_the_pruned_paths` (delete the folder first; `paths == vec![path]`), `linked_worktree_inner_functions_reject_an_unknown_repo` (all four → `AppErrorKind::UnknownRepo`), `remove_linked_worktree_inner_maps_worktree_dirty` (dirty worktree, `force: false` → `AppErrorKind::WorktreeDirty`), `worktree_branch_deserializes_tagged` (`serde_json::from_value::<WorktreeBranch>(json!({"kind":"new","name":"f","start":null}))` == `New{..}`, `json!({"kind":"existing","name":"f"})` == `Existing{..}`).

`src-tauri/tests/error.rs`: extend `app_error_kind_for_each_git_error_variant` with the seven variants and `app_error_kind_serializes_camel_case` with `branchCheckedOut`, `worktreeNotFound`, `worktreeDirty`, `worktreeLocked`, `cannotRemoveMain`, `cannotRemoveCurrent`, `pathExists`.

`src-tauri/tests/watcher.rs`: change every `RepoWatcher::start(dir, …)` to `start(dir, None, …)` and every `is_relevant(w, p)` to `is_relevant(w, None, p)`; add `is_relevant_extra_root_rules` (with `extra = Some("/c")`: `/c/HEAD` true, `/c/refs/heads/main` true, `/c/worktrees/a/HEAD` true, `/c/objects/aa/bb` false, `/c/index.lock` false, `/c/refs/heads/main.lock` false, `/elsewhere/x` true), `start_with_extra_root_fires_for_a_change_there` (two temp dirs, write a file in the extra one → count reaches 1), `start_with_extra_root_ignores_objects_there` (write under `<extra>/objects/aa/` → count stays 0 after `settle()`), `start_with_a_missing_extra_root_is_an_error`.

Front-end settings tests: `src/lib/store/settings.test.ts` — the defaults equal `settingsDefaults.json` (existing comparison, now covering the two new keys); `src/lib/store/settingsActions.test.ts` — `setWorktreesCollapsed(true)` sends `{ layout: { worktreesCollapsed: true } }`; `src/lib/ipc/settings.test.ts` — the layout fixture includes `worktreesCollapsed: false, worktreesHeight: null`.

- [ ] **Step 3: Run the new tests to verify they fail**

Run (from `src-tauri`): `cargo test -p git-real-core --test linked_worktrees`, `cargo test --test linked_worktree_commands`, `cargo test --test watcher`; `npm test -- src/lib/store`.
Expected: compile errors for the missing module, types, variants and the new `start`/`is_relevant` arities; TS failures on the missing layout keys.

- [ ] **Step 4: Implement the core**

`model/linked_worktree.rs` as in Interfaces. `error.rs`: the seven variants; `BranchCheckedOut` uses `#[error("{name} is checked out in worktree {}", folder_name(.worktree))]` with a private `fn folder_name(p: &Path) -> String` (last component, else `p.display()`), `WorktreeLocked` uses `#[error("the worktree is locked{}", lock_suffix(.0))]` with `fn lock_suffix(reason: &str) -> String` (`""` or `": {reason}"`). `refs/mod.rs`: `pub(crate) fn head_state`; `worktree: None` in the three constructors; `checkout_branch` after `find_local`: `if let Some(wt) = self.checked_out_elsewhere()?.get(name) { return Err(BranchCheckedOut{..}) }`; same in `delete_branch` after the `is_head` check and in `checkout_remote_branch` when the local branch exists; `list_branches` builds the map once and fills `worktree` per local branch.

`linked_worktrees/mod.rs`: `list_linked_worktrees` per the listing rules; private `fn admin_head(common: &Path, name: &str) -> Option<HeadState>`; private `fn main_row(common: &Path, root: &Path) -> Option<LinkedWorktree>`; `add_linked_worktree` builds the args per the argv shapes, resolving the start with `new_branch_target(name, start)` (start beginning with `-` → `RevisionNotFound` first); `remove_linked_worktree` finds the entry by comparing `entry.path` with `path` and with `path.canonicalize()` when that succeeds; `prune_linked_worktrees`; `common_dir_outside_workdir`; `checked_out_elsewhere`.

`settings.rs`: the two fields everywhere `tags_collapsed` / `tags_height` appear (struct, `Default`, `LayoutPatch` with `double_option`, the bounded-heights array, `read` leaves, `apply`); `settingsDefaults.json`, `types.ts`, `settings.ts`, `settingsActions.ts` as listed.

- [ ] **Step 5: Implement the app layer**

`commands/linked_worktrees.rs` as in Interfaces (`with_session` + `run_blocking`, `Path::new(&path)` in the async commands). `error.rs`: kinds and mapping; `OperationFailed` already maps its verb into the message. `watcher.rs`: `start` watches `extra` recursively too when given (canonicalized; a missing one is the same `notify::Error::io` as a missing workdir); the debounce thread gets both roots; `is_relevant(workdir, extra, path)` per the rule. `commands/repo.rs`: `ensure_watcher(app, watchers, id, path, extra: Option<&Path>)`; `watch_opened(app, watchers, reg, opened)` reads `reg.get(id)` → lock → `common_dir_outside_workdir()` and passes it; the three callers pass `&reg`. `lib.rs` registers the four commands.

- [ ] **Step 6: Run the full Rust and settings checks**

Run (from `src-tauri`): `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`; from the root: `npm test -- src/lib/store src/lib/ipc/settings.test.ts`, `npm run typecheck`.
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/crates/git-real-core/src src-tauri/crates/git-real-core/tests src-tauri/src src-tauri/tests src/lib/store src/lib/ipc/types.ts src/lib/ipc/settings.test.ts
git commit -m "feat(GR-39): linked worktree core ops, branch guards, commands, common-dir watch, layout settings"
```

---

### Task 2: Front-end IPC, refs section, Worktrees panel and Add worktree dialog

**Files:**

- Modify: `src/lib/ipc/types.ts` (`LinkedWorktree`, `WorktreeBranch`, `PrunedWorktrees`, `LocalBranch.worktree: string | null`, seven `AppErrorKind` members), `src/lib/ipc/commands.ts`, `src/lib/ipc/errors.ts` (`KINDS`), `src/lib/query/keys.ts`, `src/app/refsLayout.ts`, `src/app/RefsColumn.tsx` (`LABELS.worktrees`, `panels.worktrees`)
- Create: `src/features/linkedWorktrees/useLinkedWorktrees.ts`, `useLinkedWorktreeActions.ts`, `worktreePath.ts`, `worktreeCopy.ts`, `WorktreeRow.tsx` + `.module.css`, `WorktreesPanel.tsx` + `.module.css`, `AddWorktreeDialog.tsx` + `.module.css`
- Create: `src/test/worktreeFixtures.ts` (`linkedWorktree(over: Partial<LinkedWorktree> = {}): LinkedWorktree` defaulting to a main, current row at `/repos/app` on `main`)
- Modify (fixtures only, `worktree: null` added to every `LocalBranch` literal): the 14 test files that contain `isHead:` (find them with `grep -rl "isHead:" src --include=*.ts --include=*.tsx`)
- Test: `src/lib/ipc/commands.test.ts`, `errors.test.ts`, `types.test.ts`, `src/lib/query/keys.test.ts`, `src/app/refsLayout.test.ts`, `src/app/RefsColumn.test.tsx` (extend); `src/features/linkedWorktrees/*.test.ts(x)` (new)

**Interfaces:**

- Consumes: Task 1's commands and settings; `useOpenRepo` (`open(path) → Promise<boolean>`, `error`, `clearError`), `closeRepoTab(id)`, `useRepoTabs`, `pickFolder(title, defaultPath)`, `ConfirmDialog`, `ContextMenu`/`MenuItem`, `RepoError`, `useRestoreFocus`, `useBranches`, `useSettings`, `setWorktreesCollapsed`, `setSectionHeight`, `renderWithProviders`, `seedSettings`/`resetSettings`, `oidOf`.
- Produces:

```ts
// types.ts
export interface LinkedWorktree {
  name: string | null;
  path: string;
  head: HeadState | null;
  isMain: boolean;
  isCurrent: boolean;
  missing: boolean;
  locked: string | null;
}
export type WorktreeBranch =
  { kind: "existing"; name: string } | { kind: "new"; name: string; start: string | null };
export interface PrunedWorktrees {
  paths: string[];
}
// commands.ts
export function listLinkedWorktrees(id: RepoId): Promise<LinkedWorktree[]>;
export function addLinkedWorktree(id: RepoId, path: string, branch: WorktreeBranch): Promise<void>;
export function removeLinkedWorktree(id: RepoId, path: string, force: boolean): Promise<void>;
export function pruneLinkedWorktrees(id: RepoId): Promise<PrunedWorktrees>;
// keys.ts: queryKeys.linkedWorktrees(id), mutationKeys.linkedWorktree(id)
// worktreePath.ts
export function defaultWorktreePath(mainPath: string, branch: string): string;
export function folderName(path: string): string;
// worktreeCopy.ts
export function headText(head: HeadState | null): string; // per Global Constraints copy
export function removeTitle(w: LinkedWorktree): string | undefined; // the disabled reason for Remove…, undefined when allowed
export function openTitle(w: LinkedWorktree): string | undefined; // same for Open
// useLinkedWorktrees.ts
export interface UseLinkedWorktrees {
  list: LinkedWorktree[] | undefined;
  error: AppError | null;
  refetch(): void;
}
export function useLinkedWorktrees(repoId: RepoId): UseLinkedWorktrees;
// useLinkedWorktreeActions.ts
export interface UseLinkedWorktreeActions {
  add(path: string, branch: WorktreeBranch): Promise<AppError | null>;
  remove(path: string, force: boolean): Promise<AppError | null>; // closes matching tabs first
  prune(paths: string[]): Promise<AppError | null>; // closes tabs on `paths` first
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}
export function useLinkedWorktreeActions(repoId: RepoId): UseLinkedWorktreeActions;
// AddWorktreeDialog.tsx
export interface AddWorktreeDialogProps {
  repoId: RepoId;
  open: boolean;
  initial?: WorktreeBranch;
  onClose(): void;
  onAdded(path: string): void;
  fallbackFocus?: RefObject<HTMLElement | null>;
}
export function AddWorktreeDialog(props: AddWorktreeDialogProps): React.JSX.Element | null;
// WorktreeRow.tsx
export interface WorktreeRowProps {
  worktree: LinkedWorktree;
  onOpen(): void;
  onContextMenu(x: number, y: number): void;
}
// WorktreesPanel.tsx
export function WorktreesPanel({ repoId }: { repoId: RepoId }): React.JSX.Element;
```

- [ ] **Step 1: Write the failing IPC, keys and layout tests**

`commands.test.ts` (with `mockIPC`): the four wrappers invoke `list_linked_worktrees {id}`, `add_linked_worktree {id, path, branch}`, `remove_linked_worktree {id, path, force}`, `prune_linked_worktrees {id}` and return the mocked value. `errors.test.ts`: the seven kinds are accepted by `isAppError`/`toAppError` (follow the existing kind table test). `types.test.ts`: a `LinkedWorktree` and both `WorktreeBranch` shapes type-check; a `LocalBranch` with `worktree: "/w/a"`. `keys.test.ts`: `linkedWorktrees(1)` is `["repo", 1, "linkedWorktrees"]`; `mutationKeys.linkedWorktree(1)` is `["linkedWorktree", 1]`. `refsLayout.test.ts`: the order constant becomes the six-section list. `RefsColumn.test.tsx`: "five sections … four handles" becomes six and five; the observer test counts six wrappers; the `worktrees` wrapper renders the panel's heading `Worktrees (…)` (mock `listLinkedWorktrees`).

- [ ] **Step 2: Write the failing feature tests** (`src/features/linkedWorktrees/`, IPC mocked as in `TagsPanel.test.tsx`; `listLinkedWorktrees` resolves `[main, a]` where `a = linkedWorktree({ name: "a", path: "/repos/app-feat-a", head: { kind: "branch", name: "feat/a" }, isMain: false, isCurrent: false })`; `listBranches` resolves a list with `main` (head) and `feat/a` (`worktree: "/repos/app-feat-a"`))

`worktreePath.test.ts`: `defaultWorktreePath("/repos/app", "feat/x")` → `"/repos/app-feat-x"`; `("C:\\src\\app", "x")` → `"C:\\src\\app-x"` ("keeps a backslash separator"); blank branch → `"/repos/app-worktree"`; `folderName("/repos/app-feat-a/")` → `"app-feat-a"`, `folderName("C:\\src\\app")` → `"app"`.

`worktreeCopy.test.ts`: `headText` for branch / detached (`detached at ` + 7 hex) / unborn / null (`unknown HEAD`); `removeTitle` for main, current, locked with and without reason, and a removable row (`undefined`); `openTitle` for current, missing and openable.

`useLinkedWorktrees.test.tsx`: fetches under `queryKeys.linkedWorktrees`; surfaces an `AppError`.

`useLinkedWorktreeActions.test.tsx`: `add` resolves null and invalidates `repo(1)` and `recent`; a rejected add resolves the `AppError` and sets `error`; `remove("/repos/app-feat-a", false)` closes the tab whose `summary.path` is that path (seed `useRepoTabs` with two tabs; `closeRepo` mock called with its id; the other tab stays) before `removeLinkedWorktree` is called (assert call order with `vi.fn` invocation order); a failing remove leaves the tab closed; `prune(["/x"])` closes a tab at `/x` then calls `pruneLinkedWorktrees`; `pending` is true while a call is in flight.

`WorktreeRow.test.tsx`: renders folder name, `title` = full path, head text, the `main`/`current`/`missing`/`locked` badges (locked title = reason or `Locked`); double-click and Enter call `onOpen`; Shift+F10, ContextMenu key and right-click call `onContextMenu`.

`WorktreesPanel.test.tsx`:

- "should list the worktrees with the heading count" (`Worktrees (2)`, list `aria-label` `Worktree list`, rows in list order).
- "should show the bare message for an empty list" (`Not available for bare repositories`, no `+`, no prune button).
- "should open a worktree on double-click and Enter" (`openRepo` called with the path).
- "should not open the current worktree and disable Open with Already open in this tab".
- "should disable Open for a missing worktree with Folder not found".
- "should disable Remove… for main, current and locked rows with their titles".
- "should confirm, then remove without force" (`removeLinkedWorktree(1, path, false)`).
- "should offer Remove anyway on worktreeDirty and remove with force" (first call rejects `{kind:"worktreeDirty"}`; the second dialog's title is `<folder> has uncommitted changes`; confirm → `removeLinkedWorktree(1, path, true)`).
- "should cancel the force step without removing".
- "should show worktreeNotFound inline and refetch the list" (`listLinkedWorktrees` called again after the failure).
- "should enable Prune only when a stale unlocked row exists" (title `No stale worktrees` otherwise; a missing but locked row keeps it disabled) and "should prune the stale paths" (`pruneLinkedWorktrees(1)` called; tabs on those paths closed).
- "should collapse and expand with the stored preference" (`worktreesCollapsed`).
- "should open the add dialog from + and open the new worktree on success" (`addLinkedWorktree` resolves; `openRepo` called with the dialog's folder).
- "should show an open failure inline" (`openRepo` rejects → `RepoError` with Dismiss).

`AddWorktreeDialog.test.tsx`:

- "should start in New branch mode with the folder tracking the name" (typing `feat/x` makes Folder `/repos/app-feat-x`; blank name → `/repos/app-worktree`).
- "should stop tracking once the folder was edited".
- "should list local branches in Existing mode and disable current and checked-out ones" (`main (current)`, `feat/a (checked out in app-feat-a)` disabled; a free branch enabled; switching to a branch updates the folder).
- "should submit a new branch at HEAD" (`addLinkedWorktree(1, "/repos/app-feat-x", { kind: "new", name: "feat/x", start: null })`, then `onClose` and `onAdded("/repos/app-feat-x")`).
- "should submit a new branch at a commit" (`start: "abc123"`).
- "should submit an existing branch" (`{ kind: "existing", name: "free" }`).
- "should prefill from initial" (existing → Existing mode with the branch selected; new with start → New mode, name and Commit filled).
- "should disable Add while the name or folder is blank or while pending".
- "should show pathExists, branchExists, invalidBranchName and revisionNotFound inline and stay open".
- "should browse for a folder" (`pickFolder` called with `Choose worktree folder` and the main worktree's parent; the picked path fills Folder; a cancelled pick changes nothing).
- "should cancel with Escape and the Cancel button".

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npm test -- src/lib src/app/refsLayout.test.ts src/app/RefsColumn.test.tsx src/features/linkedWorktrees`
Expected: failures on missing exports, modules and section.

- [ ] **Step 4: Implement the IPC layer, keys, layout and fixtures**

`types.ts`, `commands.ts`, `errors.ts`, `keys.ts`, `refsLayout.ts`, `RefsColumn.tsx` as in Interfaces and Global Constraints. Add `worktree: null` to the `LocalBranch` literals in the 14 test files and any non-test fixture builder (the developer may touch test files only for this type-driven field addition; the tester's new tests already carry the field).

- [ ] **Step 5: Implement the feature**

- `worktreePath.ts`, `worktreeCopy.ts` per Global Constraints.
- `useLinkedWorktrees`: `useQuery` on `queryKeys.linkedWorktrees`, `refetchOnWindowFocus: true`, like `useTags`.
- `useLinkedWorktreeActions`: `useMutation` keyed `mutationKeys.linkedWorktree(repoId)` in the `useTagActions` shape (busy counter + `useIsMutating`); `remove`/`prune` close matching tabs via `closeRepoTab` before `mutateAsync`; `onSettled` invalidates `queryKeys.repo(repoId)` and `queryKeys.recent`.
- `WorktreeRow`: `BranchRow`-style `<li>` with a `<button>` (`title` = path, `onDoubleClick` → `onOpen`, Enter → `onOpen`, Shift+F10 / ContextMenu → `onContextMenu`), folder name, head text, badges.
- `WorktreesPanel`: `TagsPanel` structure (collapsible heading via `setWorktreesCollapsed`, `+`, prune button, feedback area, list, `ContextMenu`, two `ConfirmDialog`s keyed by `confirm: { path: string; force: boolean } | null`, `AddWorktreeDialog`); `useOpenRepo` for Open and for `onAdded`; its `error` rendered through `RepoError variant="panel"`; a `worktreeNotFound` result triggers `refetch()`.
- `AddWorktreeDialog`: mounted body per open like `CreateTagDialog`; own `useLinkedWorktreeActions`; `useBranches` for the select; `useLinkedWorktrees` for the main row (`list.find(w => w.isMain) ?? list.find(w => w.isCurrent)`) whose path feeds `defaultWorktreePath` and the picker's `defaultPath` (its parent); state `mode`, `existing`, `name`, `startMode`, `start`, `folder`, `folderTouched`, `error`; submit builds the `WorktreeBranch`, awaits `add`, on null calls `onClose()` then `onAdded(folder)`; errors shown inline with the Rust message via `RepoError variant="panel"` (no dismiss, cleared on the next submit).

- [ ] **Step 6: Run the front-end checks**

Run: `npm run test:coverage`, `npm run lint`, `npm run typecheck`.
Expected: all pass; coverage 100 % for `src/`.

- [ ] **Step 7: Commit**

```bash
git add src/lib src/app src/features/linkedWorktrees src/test
git commit -m "feat(GR-39): Worktrees section, add dialog, open/remove/prune actions"
```

---

### Task 3: Branch list integration — badge, gating, Create worktree…

**Files:**

- Modify: `src/features/branches/BranchRow.tsx` (badge), `BranchRow.module.css` (reuse `.badge`), `src/features/branches/BranchesPanel.tsx` (menu gating, `Create worktree…`, `worktree` dialog kind, `useOpenRepo` in the error chain)
- Test: `src/features/branches/BranchRow.test.tsx`, `BranchesPanel.test.tsx` (extend)

**Interfaces:**

- Consumes: `AddWorktreeDialog` (`initial`, `onAdded`), `folderName`, `useOpenRepo`, `LocalBranch.worktree`.
- Produces: `BranchesPanel`'s `Dialog` union gains `{ kind: "worktree"; initial: WorktreeBranch }`.

- [ ] **Step 1: Write the failing tests**

`BranchRow.test.tsx`: "should badge a branch checked out in another worktree" (`worktree: "/repos/app-feat-a"` → badge text `app-feat-a`, title `Checked out in worktree /repos/app-feat-a`); "should render no badge when worktree is null".

`BranchesPanel.test.tsx`:

- "should disable Checkout and Delete… for a branch checked out elsewhere with the worktree title" (both items `aria-disabled`, title `Checked out in worktree app-feat-a`).
- "should disable Create worktree… for a branch checked out elsewhere".
- "should open the add dialog in Existing mode from a local branch" (`Create worktree…` on `free` → dialog with `Existing branch` checked and `free` selected).
- "should open the add dialog in New mode from a remote branch" (`origin/topic` → `New branch` checked, Name `topic`, Commit `origin/topic`).
- "should open the new worktree after the dialog adds it" (`openRepo` called with the folder).
- "should show an open failure in the panel error area".
- "should show branchCheckedOut inline after a double-click checkout" (`checkoutBranch` rejects `{ kind: "branchCheckedOut", message: "feat/a is checked out in worktree app-feat-a" }` → that message appears).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/features/branches`
Expected: failures on the missing badge, items and dialog.

- [ ] **Step 3: Implement**

`BranchRow`: after `TrackingBadge`, for a local branch with `worktree !== null` render `<span className={styles.badge} title={\`Checked out in worktree ${worktree}\`}>{folderName(worktree)}</span>`. `BranchesPanel`: `const elsewhere = target.kind === "local" ? target.branch.worktree : null; const lockedTitle = elsewhere === null ? undefined : \`Checked out in worktree ${folderName(elsewhere)}\`;`checkout`disabled: pending || isHead || elsewhere !== null, title: lockedTitle`; delete likewise; new item `{ id: "worktree", label: "Create worktree…", disabled: pending || elsewhere !== null, title: lockedTitle, onSelect: () => openDialog({ kind: "worktree", initial: { kind: "existing", name } }) }`after`create`for local rows and`{ id: "worktree", label: "Create worktree…", disabled: pending, onSelect: () => openDialog({ kind: "worktree", initial: { kind: "new", name, start: \`${remote}/${name}\` } }) }`after checkout for remote rows; render`<AddWorktreeDialog repoId={repoId} open initial={dialog.initial} onClose={closeDialog} onAdded={(path) => void opener.open(path)} fallbackFocus={rootRef} />`; `opener = useOpenRepo()`joins`panelError` (`?? opener.error`) and `clearErrors` (`opener.clearError()`).

- [ ] **Step 4: Run the front-end checks**

Run: `npm run test:coverage`, `npm run lint`, `npm run typecheck`.
Expected: all pass; coverage 100 %.

- [ ] **Step 5: Commit**

```bash
git add src/features/branches
git commit -m "feat(GR-39): badge and lock branches checked out in another worktree; Create worktree… menu"
```

---

### Final gate (after Task 3, before the whole-branch review)

- From `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`. From the root: `npm run test:coverage`, `npm run lint`, `npm run typecheck`, `npm run build`.
- Acceptance walk per spec §7 (steps 1–8) on the running app, driven with the desktop-walk tooling; results recorded in a `docs(GR-39)` commit alongside the spec.

---

### Addendum: review fix waves (2026-10-28)

The whole-branch review returned two Important findings, fixed in one wave: the tab close is awaited before `git worktree remove`/`prune` runs, and a relative or `~` folder is refused in core (`PathNotAbsolute`). The owner then ruled that every deferred minor is fixed on this branch rather than ticketed. That follow-up ran as two waves plus a closing round, each reviewed:

- **Wave R (Rust):** a read-only `is_linked_worktree_dirty` command sharing the remove's dirty helper, and an unopenable existing folder counting as dirty; `list_branches` degrades its worktree annotation (with a log line) when the registry cannot be read while the guards keep propagating; prune reports every entry git removed by diffing the registry names before and after, falling back to the recorded candidate paths if the re-read fails; `rename_branch` refuses a branch held by a missing worktree (libgit2 updates a live holder's HEAD, verified by test); the admin `HEAD` fallback accepts 64-hex oids.
- **Wave F (front end):** the panel asks core whether the worktree is dirty after the first confirm and closes tabs only on the final confirmation, so a cancelled force step keeps the tab and its commit draft; remote-branch Checkout and Create worktree… respect a local twin held elsewhere or current (title `Already checked out in this worktree`); Existing mode explains an empty choice (`Every branch is checked out in a worktree. Create a new one.`); tab matching tolerates a trailing separator (`samePath`); copy polish (`Add` label while pending, `Worktrees` without a count while loading, a text `Prune` control, no `flushSync`); the branches test asserts the dialog closed.
- **Closing round (Rust):** root-run chmod tests announce their skip, the prune test is named for what it corrupts, the registry test matches the propagated variant, and the dirty doc comment states that any unopenable folder counts as dirty.

Not fixable here: the separate-git-dir main row from a linked tab (git itself cannot name it) and Windows verbatim path prefixes (pre-existing, GR-34/35).
