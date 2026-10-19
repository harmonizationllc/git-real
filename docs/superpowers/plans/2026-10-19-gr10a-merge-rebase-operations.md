# GR-10a Merge, Rebase, Cherry-pick, Revert and In-progress Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the branch and graph context menus the user can merge, fast-forward, rebase, cherry-pick and revert; a banner shows any in-progress operation with Abort and Continue; conflicted files can be resolved by keeping one side; the commit box finishes a merge, cherry-pick or revert with git's prepared message.

**Architecture:** A new `merge` module in `git-real-core` shells out to the git CLI for every operation (hooks, rerere and signing behave as on the command line), classifies a non-zero exit by the repository state afterwards, reads the in-progress state from git2 plus the `.git` marker files, and resolves conflicts with a git2 index write. The Tauri app exposes nine commands. The front end adds `features/merge/` (state query, action mutations, copy helpers, `OperationBanner`), extends three existing context menus, and teaches the commit box to prefill and finish an operation.

**Tech Stack:** Rust 2024 + git2 0.20 (`default-features = false`) + system git CLI, Tauri 2, React 19 + TypeScript, TanStack Query 5, Zustand 5, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-19-gr10a-merge-rebase-operations-design.md`

## Global Constraints

- Tests first, by the test role; the developer role never edits test files (CLAUDE.md).
- Only `src/lib/ipc` imports `@tauri-apps/api/*` (ESLint-enforced).
- `git2` stays `default-features = false`; no direct `tokio`; blocking work runs through `run_blocking`; `git-real-core` has no Tauri dependency.
- Operations run through the CLI with `git_cli::command(git)` and `-C <workdir>`: `merge --no-ff --no-edit <branch>`, `merge --ff-only <branch>`, `rebase <onto>` (env `GIT_EDITOR=true`), `cherry-pick <oid>`, `revert --no-edit <oid>`, `merge|rebase|cherry-pick|revert --abort`, `rebase --continue` (env `GIT_EDITOR=true`). State reads and conflict resolution are git2.
- Classification: exit 0 → `Completed`; non-zero with `repo.state() != Clean` AND a conflicted fresh index → `Conflicts`; every other non-zero → `OperationFailed { verb, code, stdout, stderr }` (a hook-refused merge or an empty cherry-pick stays in progress with no conflicts; the UI refetches the operation state after an `operationFailed` error).
- Serde: every new type is `rename_all = "camelCase"`; `OperationState` is internally tagged on `kind` with camelCase variant names and fields (`#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]`); oids are full hex.
- New error kinds, Rust ↔ TS: `OperationFailed` ↔ `operationFailed`, `OperationInProgress` ↔ `operationInProgress`, `NoOperation` ↔ `noOperation`, `UnresolvedConflicts` ↔ `unresolvedConflicts`, `MergeCommit` ↔ `mergeCommit`.
- Query keys under the repo prefix: `operation(id) = ["repo", id, "operation"]`, `fastForward(id, branch) = ["repo", id, "fastForward", branch]`.
- Copy (verbatim, spec §5.6): banner `Merging <b> into <cur>`, `Rebasing <cur> onto <onto>, step <n> of <m>`, `Cherry-picking <7 hex>`, `Reverting <7 hex>`, suffix `, <k> conflicts remaining` (`, 1 conflict remaining`; `, no conflicts remaining`); dialog title `Abort <merge|rebase|cherry-pick|revert>?`, body `The working tree and index return to their state before the operation started. Resolved conflicts are lost.`, confirm `Abort`; buttons `Abort…`, `Continue`, `Go to commit`; menu items `Merge <b> into <cur>`, `Fast-forward <cur> to <b>`, `Rebase <cur> onto <b>`, `Cherry-pick commit`, `Revert commit`, `Keep <ours>`, `Take <theirs>`, `Mark resolved (stage)`; titles `Check out a branch first`, `Finish or abort the current operation first`, `Checking…`, `Already up to date`, `<cur> and <b> have diverged`, `Merge commits are not supported yet`, `Already on this commit`, `Resolve all conflicts first`, `Not available during a <merge|rebase|cherry-pick|revert>`; commit buttons `Commit and merge`, `Commit and cherry-pick`, `Commit and revert`; gate reason `Use Continue in the banner to resume the rebase`; banner `aria-label="Operation in progress"`.
- Gates: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`, `npm test` at 100 % coverage for `src/`, `npm run lint`, `npm run typecheck`.

## Review Focus

1. A merge or rebase refused for a dirty working tree ("Your local changes would be overwritten") must surface git's message as an error and leave no banner, because the state stays `Clean` (Task 1 test `merge_refused_for_dirty_tree_is_operation_failed`).
2. Keeping a side that deleted the file must remove the file and its index entry, not write an empty file (Task 2 test `resolve_keeping_deleted_side_removes_the_file`).
3. A conflicted rebase whose next step also conflicts must report `Conflicts` again from `continue_rebase` and keep the banner with the new step number (Task 1 test `continue_rebase_stops_again_on_the_next_conflict`).
4. Opening the app while a merge is already in progress (started in a terminal) must prefill the commit box once and never clobber text the user then types (Task 6 tests `prefills on first observation of a merge`, `does not overwrite edited text on refetch`).
5. A conflict with no operation in progress (left by `git stash pop`) must still offer keep/take with the plain `ours`/`theirs` labels and the banner stays hidden (Task 5 test `conflict menu falls back to ours and theirs without an operation`).

---

### Task 1: Core — operation model, state reader, CLI runner, merge/rebase/cherry-pick/revert/abort/continue

**Files:**

- Create: `src-tauri/crates/git-real-core/src/model/merge.rs`
- Modify: `src-tauri/crates/git-real-core/src/model/mod.rs` (`mod merge; pub use merge::{ConflictSide, FastForwardCheck, MergeMode, OperationOutcome, OperationState};`)
- Create: `src-tauri/crates/git-real-core/src/merge/mod.rs`, `merge/git_ops.rs`, `merge/state.rs`
- Modify: `src-tauri/crates/git-real-core/src/lib.rs` (`pub mod merge;`)
- Modify: `src-tauri/crates/git-real-core/src/error.rs` (five variants, §3.4 of the spec)
- Modify: `src-tauri/crates/git-real-core/src/commit/mod.rs` (`is_unborn` becomes `pub(crate)` so `merge` reuses it)
- Test: `src-tauri/crates/git-real-core/tests/merge.rs` (create), `tests/common/mod.rs` (extend)
- Test helpers added to `common/mod.rs`:
  - `diverged_fixture() -> (TempDir, PathBuf)`: the first half of `temp_repo_with_conflict` (base commit, branch `other` edits `README.md` to `# other\n`, base branch edits it to `# main\n`, HEAD back on base, clean tree, no merge). `temp_repo_with_conflict` is rewritten as `diverged_fixture` plus the existing git2 merge.
  - `ahead_fixture() -> (TempDir, PathBuf, git2::Oid)`: base commit, branch `fast` with one extra commit (`branch_with_commit(path, "fast", "fast.txt", "fast\n")`), HEAD on base; returns the `fast` tip.
  - `run_git(root: &Path, args: &[&str]) -> std::process::Output`: runs the real `git -C root ...` with `configure_identity` assumed (panics when the status is not success), for fixtures that need the CLI (for example `git merge` to create a conflicted state the way git does).

**Interfaces:**

- Consumes: `RepoSession::{repo, workdir, fresh_index}`, `git_cli::{command, locate, capture}`, `commit::message::split`, `commit::is_unborn`.
- Produces:

```rust
// model/merge.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMode { Merge, FastForward }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum OperationState {
    None,
    Merge { head: String, branch: Option<String>, message: CommitMessage },
    Rebase { onto: String, onto_name: Option<String>, branch: Option<String>, step: u32, total: u32 },
    CherryPick { oid: String, message: CommitMessage },
    Revert { oid: String, message: CommitMessage },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationOutcome { Completed, Conflicts }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide { Ours, Theirs }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FastForwardCheck { Possible, UpToDate, Diverged }

// error.rs
#[error("git {verb} failed")]
OperationFailed { verb: String, code: Option<i32>, stdout: String, stderr: String },
#[error("another operation is in progress")]
OperationInProgress,
#[error("no merge, rebase, cherry-pick or revert is in progress")]
NoOperation,
#[error("resolve all conflicts first")]
UnresolvedConflicts,
#[error("{0} is a merge commit; choosing a parent is not supported yet")]
MergeCommit(String),

// merge/git_ops.rs
/// `git -C <workdir> <verb> <args...>` with `env` applied; `GitCliMissing` when git is absent.
pub(crate) fn run(git: &Path, workdir: &Path, verb: &str, args: &[&str], env: &[(&str, &str)]) -> Result<Output, GitError>;

// merge/state.rs
/// Reads the marker files; never fails (unreadable fields degrade to None/0).
pub(crate) fn read_state(repo: &Repository) -> OperationState;
/// A local branch whose tip is `oid`, else `remote/name`, else None.
pub(crate) fn name_for_oid(repo: &Repository, oid: Oid) -> Option<String>;

// merge/mod.rs
impl RepoSession {
    pub fn operation_state(&self) -> OperationState;
    pub fn merge_branch(&self, branch: &str, mode: MergeMode) -> Result<OperationOutcome, GitError>;
    pub fn rebase_onto(&self, onto: &str) -> Result<OperationOutcome, GitError>;
    pub fn cherry_pick(&self, oid: &str) -> Result<OperationOutcome, GitError>;
    pub fn revert_commit(&self, oid: &str) -> Result<OperationOutcome, GitError>;
    pub fn abort_operation(&self) -> Result<(), GitError>;
    pub fn continue_rebase(&self) -> Result<OperationOutcome, GitError>;
    /// Local name, else `remote/name` → tip oid; `BranchNotFound` otherwise.
    pub(crate) fn resolve_branch(&self, name: &str) -> Result<Oid, GitError>;
}
```

- [ ] **Step 1: Write the failing tests** — `tests/merge.rs`, every fixture through `configure_identity`. State: `state_is_none_on_a_clean_repo`; `state_after_conflicting_merge_names_the_branch` (`temp_repo_with_conflict` → `Merge { head == other tip, branch == Some("other"), message.subject starts with "Merge branch 'other'" }`; note git2's merge writes `MERGE_MSG`); `state_after_conflicting_rebase_has_step_and_total` (`diverged_fixture`, `rebase_onto("other")` → `Rebase { onto == other tip, onto_name == Some("other"), branch == Some(head name), step == 1, total == 1 }`); `state_after_conflicting_cherry_pick` and `state_after_conflicting_revert` (cherry-pick `other`'s commit onto base → `CherryPick { oid, message.subject == "change on other" }`; revert HEAD after a conflicting setup: commit `# main\n` then `# more\n`, make the tree conflict by editing in between — simplest: `revert_commit(<commit that changed README>)` on a repo whose later commit also changed README → `Revert { oid }`); `state_degrades_when_rebase_files_are_unreadable` (write `rebase-merge/` with only `head-name` → `step 0, total 0, onto ""`, `onto_name None`). Merge: `merge_creates_a_merge_commit_even_when_ff_is_possible` (`ahead_fixture`, `merge_branch("fast", Merge)` → `Completed`, HEAD has two parents); `fast_forward_moves_head_without_a_commit` (`FastForward` → HEAD == fast tip, one parent); `fast_forward_on_diverged_is_operation_failed` (`diverged_fixture`, `FastForward` → `OperationFailed { verb: "merge", .. }` with stderr containing `fast-forward`, state `None`); `merge_conflict_is_conflicts_outcome_and_status_shows_it` (`diverged_fixture`, `Merge` → `Conflicts`; `status()` has `README.md` conflicted; `operation_state()` is `Merge`); `merge_unknown_branch_is_branch_not_found`; `merge_accepts_a_remote_tracking_branch` (`add_remote_and_fetch` then `merge_branch("origin/<name>", Merge)`); `merge_while_in_progress_is_operation_in_progress` (`temp_repo_with_conflict`); `merge_on_unborn_is_unborn_head`; `merge_refused_by_pre_merge_commit_hook_is_operation_failed` (`install_hook(root, "pre-merge-commit", "exit 1")` → `OperationFailed`, state `None`, HEAD unchanged); `merge_refused_for_dirty_tree_is_operation_failed` (`ahead_fixture`, write `fast.txt` locally uncommitted → git refuses → `OperationFailed`, state `None`). Rebase: `rebase_replays_commits_onto_the_target` (`ahead_fixture` with an extra commit on base touching another file: rebase base onto `fast` → `Completed`, HEAD's parent == fast tip); `rebase_conflict_is_conflicts`; `continue_rebase_with_conflicts_left_is_unresolved_conflicts`; `continue_rebase_after_resolution_completes` (resolve by writing `README.md` and `stage_paths` → `Completed`, state `None`, HEAD parent == other tip); `continue_rebase_stops_again_on_the_next_conflict` (two commits on base both editing README, rebase onto other → `Conflicts`, resolve+continue → `Conflicts` again, state `step == 2`); `continue_rebase_when_clean_is_no_operation`; `rebase_runs_git_with_editor_disabled` (`fake_git` script `printf '%s' "$GIT_EDITOR" > "$FAKE_OUT"; exit 0` and a `PATH` override as `tests/cli_argv.rs` does → file contains `true`). Cherry-pick / revert: `cherry_pick_creates_one_commit_with_the_change` (base + `other` tip → `Completed`, HEAD parent == old HEAD, tree has other's README); `cherry_pick_conflict_is_conflicts`; `cherry_pick_merge_commit_is_merge_commit` (`merge_fixture` → `MergeCommit(m)`); `cherry_pick_bad_oid_is_commit_not_found`; `revert_creates_an_inverse_commit` (revert HEAD → `Completed`, tree equals grandparent's); `revert_conflict_is_conflicts`; `revert_merge_commit_is_merge_commit`. Abort: `abort_merge_restores_head_and_clean_tree`, `abort_rebase_restores_the_branch`, `abort_cherry_pick`, `abort_revert`, `abort_when_clean_is_no_operation`. Serde: `operation_state_serializes_tagged` (`{"kind":"none"}`; `{"kind":"rebase","onto":"…","ontoName":null,"branch":"main","step":1,"total":1}`; `{"kind":"cherryPick",…}`), `merge_mode_serializes_camel_case` (`"fastForward"`). Runner: `git_ops_run_passes_verb_args_and_env` through `fake_git`; `git_ops_missing_git_is_git_cli_missing`.

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real-core --test merge` (from `src-tauri`); expected: compile errors on `merge_branch` and friends.

- [ ] **Step 3: Implement** — `state.rs`: `match repo.state()`: `Clean | Bisect | ApplyMailbox | ApplyMailboxOrRebase → None`; `Merge → read MERGE_HEAD first line` (missing → `None` variant) with `name_for_oid`, `MERGE_MSG` through `message::split` (missing → empty); `Rebase | RebaseInteractive | RebaseMerge → rebase-merge/{onto, head-name, msgnum, end}` else `rebase-apply/{onto, head-name, next, last}`, `head-name` stripped of `refs/heads/`; `CherryPick | CherryPickSequence → CHERRY_PICK_HEAD + MERGE_MSG`; `Revert | RevertSequence → REVERT_HEAD + MERGE_MSG`. Marker files live under `repo.path()`. `name_for_oid`: iterate `repo.branches(Some(Local))` then `Some(Remote)`, first whose `get().target() == Some(oid)`, name via `Branch::name()` (remote names are already `origin/main`; skip `origin/HEAD`). `git_ops::run`: `git_cli::command(git)`, `.arg("-C").arg(workdir).arg(verb).args(args)`, `for (k, v) in env { cmd.env(k, v) }`, `git_cli::capture`. `mod.rs`: `fn ensure_clean(&self)` (`state() != Clean → OperationInProgress`), `fn ensure_born(&self)` (`repo.head()` with `is_unborn → UnbornHead`), `fn outcome(&self, verb, output)` per the Global Constraints classification, `fn git(&self) -> (PathBuf, &Path)` = `(git_cli::locate()?, self.workdir()?)`. `resolve_branch`: `find_branch(name, Local)` then `find_branch(name, Remote)` → `target()`, else `BranchNotFound(name)`. `cherry_pick`/`revert_commit`: `Oid::from_str` + `find_commit` → `CommitNotFound`; `parent_count() > 1 → MergeCommit`. `abort_operation`: verb by state (`Merge → "merge"`, rebase kinds → `"rebase"`, cherry-pick kinds → `"cherry-pick"`, revert kinds → `"revert"`, else `NoOperation`), args `["--abort"]`, non-zero → `OperationFailed`. `continue_rebase`: state not a rebase kind → `NoOperation`; `self.fresh_index()?.has_conflicts() → UnresolvedConflicts`; run `rebase --continue` with `GIT_EDITOR=true`; classify.

- [ ] **Step 4: Run to verify pass** — `cargo test -p git-real-core`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`.

- [ ] **Step 5: Commit** — `feat(core): merge, rebase, cherry-pick, revert, abort and continue through the git CLI`.

---

### Task 2: Core — `resolve_conflicts` and `can_fast_forward`

**Files:**

- Create: `src-tauri/crates/git-real-core/src/merge/resolve.rs`
- Modify: `src-tauri/crates/git-real-core/src/merge/mod.rs` (`mod resolve;`, `can_fast_forward`)
- Modify: `src-tauri/crates/git-real-core/src/index_ops.rs` (`normalise_all` and `reload_on_error` become `pub(crate)`)
- Test: `src-tauri/crates/git-real-core/tests/merge.rs` (extend)

**Interfaces:**

- Consumes: `index_ops::{normalise_all, reload_on_error}`, `RepoSession::{fresh_index, workdir, repo, resolve_branch}`, `GitError::{PathNotFound, UnbornHead}`.
- Produces:

```rust
impl RepoSession {
    /// Keeps `side` of each conflicted path: writes that stage's blob (or deletes the file)
    /// and stages the path, which clears the conflict entries.
    pub fn resolve_conflicts(&self, paths: &[String], side: ConflictSide) -> Result<(), GitError>;
    pub fn can_fast_forward(&self, branch: &str) -> Result<FastForwardCheck, GitError>;
}
```

- [ ] **Step 1: Write the failing tests** — on `temp_repo_with_conflict` (README conflicted, ours `# main\n`, theirs `# other\n`): `resolve_ours_writes_head_content_and_stages` (file reads `# main\n`; `status()` entry no longer conflicted, `index == Some(Modified)` or unchanged vs HEAD → not listed; `fresh_index().has_conflicts() == false`); `resolve_theirs_writes_the_other_side`; `resolve_keeping_deleted_side_removes_the_file` (fixture: `diverged_fixture` variant where `other` deletes `README.md` instead of editing it; `git merge other` via `run_git` → modify/delete conflict; `Theirs` → file gone, index has no `README.md`, no conflicts); `resolve_keeps_executable_mode` (conflicted file created with mode `0o100755` on both sides → mode preserved after `Ours`); `resolve_unconflicted_path_is_path_not_found` (a path that is clean → `PathNotFound`, and nothing written); `resolve_two_paths_in_one_call`; `resolve_rejects_a_path_outside_the_repo` (`"../x"` → error, as `stage_paths` does); `resolve_on_a_clean_repo_is_path_not_found`. Fast-forward: `can_fast_forward_is_possible_when_ahead` (`ahead_fixture`, `"fast"` → `Possible`); `can_fast_forward_is_up_to_date_for_the_same_tip` (a branch created at HEAD → `UpToDate`); `can_fast_forward_is_diverged` (`diverged_fixture`, `"other"` → `Diverged`); `can_fast_forward_unknown_is_branch_not_found`; `can_fast_forward_unborn_is_unborn_head`; `can_fast_forward_accepts_remote_tracking`.

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real-core --test merge`.

- [ ] **Step 3: Implement** — `resolve.rs`: `normalise_all(workdir, paths)?`, `let mut index = self.fresh_index()?`, then inside a closure per path: collect the conflict (`index.conflicts()?` → find the `IndexConflict` whose `our`/`their`/`ancestor` path equals the path bytes) → `PathNotFound` when none; `chosen = match side { Ours => c.our, Theirs => c.their }`; `Some(entry)` → `repo.find_blob(entry.id)`, create parent dirs, write content, `set_permissions` with mode `0o755` when `entry.mode == 0o100755` (unix) else leave default, `index.add_path(rel)`; `None` → `remove_file` if it exists, `index.remove_path(rel)`. After the loop `index.write()`. Wrap with `reload_on_error`. `can_fast_forward`: `ensure_born`; `tip = resolve_branch(branch)?`; `head = repo.head()?.target()`; `tip == head → UpToDate`; `repo.graph_descendant_of(tip, head)? → Possible`; else `Diverged`.

- [ ] **Step 4: Run to verify pass** — `cargo test -p git-real-core`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`.

- [ ] **Step 5: Commit** — `feat(core): keep-one-side conflict resolution and fast-forward check`.

---

### Task 3: Tauri app — `merge` commands and the five error kinds

**Files:**

- Create: `src-tauri/src/commands/merge.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`pub mod merge;`), `src-tauri/src/lib.rs` (register nine commands), `src-tauri/src/error.rs` (kinds + mapping; `OperationFailed` message via `cli_failure_message(verb, code, stdout, stderr)`)
- Test: `src-tauri/tests/merge_commands.rs` (create), `src-tauri/tests/error.rs` (extend)

**Interfaces:**

- Consumes: `with_session`, `run_blocking`, Task 1–2 session methods.
- Produces (each `_inner` on `&RepoRegistry`, each `#[tauri::command] async fn` through `run_blocking`):

```rust
pub fn get_operation_state_inner(reg, id) -> Result<OperationState, AppError>
pub fn merge_branch_inner(reg, id, branch: &str, mode: MergeMode) -> Result<OperationOutcome, AppError>
pub fn rebase_onto_inner(reg, id, onto: &str) -> Result<OperationOutcome, AppError>
pub fn cherry_pick_inner(reg, id, oid: &str) -> Result<OperationOutcome, AppError>
pub fn revert_commit_inner(reg, id, oid: &str) -> Result<OperationOutcome, AppError>
pub fn abort_operation_inner(reg, id) -> Result<(), AppError>
pub fn continue_rebase_inner(reg, id) -> Result<OperationOutcome, AppError>
pub fn resolve_conflicts_inner(reg, id, paths: &[String], side: ConflictSide) -> Result<(), AppError>
pub fn can_fast_forward_inner(reg, id, branch: &str) -> Result<FastForwardCheck, AppError>
// command names: get_operation_state, merge_branch, rebase_onto, cherry_pick, revert_commit,
// abort_operation, continue_rebase, resolve_conflicts, can_fast_forward
```

- [ ] **Step 1: Write the failing tests** — `merge_commands.rs` (fixtures copied from `history_commands.rs`' `open_fixture` plus `common::ahead_fixture`/`diverged_fixture` mirrored in `src-tauri/tests/common`): `get_operation_state_inner` is `None` then `Merge` after a conflicting `merge_branch_inner`; `merge_branch_inner` fast-forward `Completed`; `rebase_onto_inner` conflict → `Conflicts`, `continue_rebase_inner` → `UnresolvedConflicts` kind, after `resolve_conflicts_inner(.., Theirs)` → `Completed`; `cherry_pick_inner` and `revert_commit_inner` happy paths; `abort_operation_inner` on a clean repo → kind `NoOperation`; `can_fast_forward_inner` → `Possible`; `serde_json::to_value(OperationState::None) == json!({"kind":"none"})`; unknown repo id → `UnknownRepo` for every command. `error.rs`: each new `GitError` variant maps to its kind; `OperationFailed { verb: "merge", stderr: "fatal: x" }` message is `fatal: x`; `OperationFailed` with empty output and `code: Some(128)` → `git merge failed with exit code 128`.

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real --test merge_commands --test error` (from `src-tauri`).

- [ ] **Step 3: Implement** — mirror `commands/refs.rs`; add the five `AppErrorKind` variants and `From<GitError>` arms; register in `lib.rs` after `commands::history::get_blame`.

- [ ] **Step 4: Run to verify pass** — `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`.

- [ ] **Step 5: Commit** — `feat(app): merge, rebase, cherry-pick and revert commands`.

---

### Task 4: Front end foundations — seam, keys, draft store, `features/merge/` hooks, copy and banner

**Files:**

- Modify: `src/lib/ipc/types.ts`, `src/lib/ipc/errors.ts`, `src/lib/ipc/commands.ts`, `src/lib/ipc/index.ts` (re-exports)
- Modify: `src/lib/query/keys.ts`
- Modify: `src/lib/store/commitDraft.ts`
- Create: `src/features/merge/useOperationState.ts`, `useCanFastForward.ts`, `useIntegrationActions.ts`, `operationCopy.ts`, `OperationBanner.tsx`, `OperationBanner.module.css`
- Test: `types.test.ts`, `errors.test.ts`, `commands.test.ts`, `keys.test.ts`, `commitDraft.test.ts` (extend); `useOperationState.test.tsx`, `useCanFastForward.test.tsx`, `useIntegrationActions.test.tsx`, `operationCopy.test.ts`, `OperationBanner.test.tsx` (create)

**Interfaces:**

- Consumes: `useBranches` (head name), `useStatus` (conflict count), `ConfirmDialog`, `RepoError`, `shortOid` from `features/graph/model/layout`.
- Produces:

```ts
// types.ts
export type MergeMode = "merge" | "fastForward";
export type OperationState =
  | { kind: "none" }
  | { kind: "merge"; head: string; branch: string | null; message: CommitMessage }
  | { kind: "rebase"; onto: string; ontoName: string | null; branch: string | null; step: number; total: number }
  | { kind: "cherryPick"; oid: string; message: CommitMessage }
  | { kind: "revert"; oid: string; message: CommitMessage };
export type OperationOutcome = "completed" | "conflicts";
export type ConflictSide = "ours" | "theirs";
export type FastForwardCheck = "possible" | "upToDate" | "diverged";
// AppErrorKind gains "operationFailed" | "operationInProgress" | "noOperation" | "unresolvedConflicts" | "mergeCommit"

// commands.ts
getOperationState(id): Promise<OperationState>                        // "get_operation_state", { id }
mergeBranch(id, branch, mode: MergeMode): Promise<OperationOutcome>   // "merge_branch", { id, branch, mode }
rebaseOnto(id, onto): Promise<OperationOutcome>                       // "rebase_onto", { id, onto }
cherryPick(id, oid): Promise<OperationOutcome>                        // "cherry_pick", { id, oid }
revertCommit(id, oid): Promise<OperationOutcome>                      // "revert_commit", { id, oid }
abortOperation(id): Promise<void>                                     // "abort_operation", { id }
continueRebase(id): Promise<OperationOutcome>                         // "continue_rebase", { id }
resolveConflicts(id, paths: string[], side: ConflictSide): Promise<void> // "resolve_conflicts", { id, paths, side }
canFastForward(id, branch): Promise<FastForwardCheck>                 // "can_fast_forward", { id, branch }

// keys.ts
operation: (id) => ["repo", id, "operation"] as const,
fastForward: (id, branch: string) => ["repo", id, "fastForward", branch] as const,

// commitDraft.ts — CommitDraft gains `prefilled: CommitMessage | null` (EMPTY_DRAFT: null; toggleAmend keeps it)
/** Keeps the draft in step with an operation's prepared message (null = no committing operation). */
syncPrefill(repoId: RepoId, message: CommitMessage | null): void;
//   message !== null: when the draft is EMPTY_DRAFT-equal text (subject and body empty) or its text equals `prefilled`
//     → { subject, body, amend: false, stash: null, prefilled: message }; otherwise untouched.
//   message === null: when `prefilled !== null` and the text still equals it → clear(repoId); else set prefilled null.

// useOperationState.ts
export interface UseOperationState { state: OperationState | undefined; error: AppError | null; refetch(): void }
export function useOperationState(repoId): UseOperationState   // useQuery(queryKeys.operation), refetchOnWindowFocus: true

// useCanFastForward.ts
export function useCanFastForward(repoId, branch: string | null): { check: FastForwardCheck | undefined; isLoading: boolean }
//   enabled: branch !== null; staleTime: 0; gcTime: 0

// useIntegrationActions.ts
export type IntegrationRequest =
  | { action: "merge"; branch: string } | { action: "fastForward"; branch: string }
  | { action: "rebase"; onto: string } | { action: "cherryPick"; oid: string } | { action: "revert"; oid: string }
  | { action: "abort" } | { action: "continue" } | { action: "resolve"; paths: string[]; side: ConflictSide };
export interface UseIntegrationActions { run(req): Promise<AppError | null>; pending: boolean; error: AppError | null; clearError(): void }
//   mutationFn maps each action to its wrapper; onSettled invalidates queryKeys.repo(repoId) (useBranchActions pattern)

// operationCopy.ts
export type OperationNoun = "merge" | "rebase" | "cherry-pick" | "revert";
export function operationNoun(state: Exclude<OperationState, { kind: "none" }>): OperationNoun;
export function headName(head: HeadState | undefined): string;          // branch → name; otherwise "HEAD"
export function bannerTitle(state: Exclude<...>, head: string, conflicts: number): string;
export function sideLabels(state: OperationState | undefined, head: string): { ours: string; theirs: string };
//   merge → { head, branch ?? shortOid(merge.head) }; rebase → { ontoName ?? shortOid(onto), branch ?? head };
//   cherryPick/revert → { head, shortOid(oid) }; none/undefined → { "ours", "theirs" }
export function commitButtonLabel(state: OperationState | undefined): string | null; // merge/cherryPick/revert only
export const IN_PROGRESS_TITLE = "Finish or abort the current operation first";
export function commitsThroughBox(state: OperationState | undefined): boolean;  // merge | cherryPick | revert

// OperationBanner.tsx
export function OperationBanner({ repoId }: { repoId: RepoId }): React.JSX.Element | null;
//   null while state is undefined or kind "none"; <section aria-label="Operation in progress" aria-busy={pending}>
//   title per bannerTitle; `Abort…` (danger) → ConfirmDialog → run({ action: "abort" });
//   rebase: `Continue` disabled when conflicts > 0 (title "Resolve all conflicts first") or pending → run({ action: "continue" });
//   others: `Go to commit` disabled when conflicts > 0 → document.getElementById("commit-subject")?.focus();
//   error → RepoError with onDismiss clearError
```

- [ ] **Step 1: Write the failing tests** — `types.test.ts`/`errors.test.ts`: the five kinds accepted; `commands.test.ts`: each wrapper invokes the exact command name and payload (table above); `keys.test.ts`: the two keys start with `["repo", id]`; `commitDraft.test.ts`: `syncPrefill` fills an empty draft and records `prefilled`; leaves user text alone; refills when text still equals the old prefill; `null` clears an untouched prefill; `null` keeps edited text and drops `prefilled`; `setAmend` keeps `prefilled`; `EMPTY_DRAFT.prefilled === null`. `operationCopy.test.ts`: every branch of every helper incl. `, 1 conflict remaining`, `, 2 conflicts remaining`, `, no conflicts remaining`, short-oid fallbacks, `headName` for detached/unborn/undefined. Hooks (mock `../../lib/ipc`): `useOperationState` key and call; `useCanFastForward` disabled for `null`, key includes the branch; `useIntegrationActions` each action → the right wrapper with the right args, `run` resolves `null` on success (also for the `"conflicts"` outcome) and the `AppError` on failure, invalidates `queryKeys.repo` on both. `OperationBanner.test.tsx` (mock the three hooks and `useBranches`/`useStatus`): renders nothing for undefined/none; merge title with branch and `, 1 conflict remaining`; rebase title with step; cherry-pick and revert titles with 7-hex; Abort opens the dialog with the right title and body, Cancel closes, confirm runs `abort`; `Continue` disabled with title while conflicts remain, enabled and calls `continue` at zero; `Go to commit` focuses `#commit-subject` (render an input with that id in the test); error shown with Dismiss calling `clearError`; `aria-busy` while pending.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib src/features/merge`.

- [ ] **Step 3: Implement** — per the interfaces. `OperationBanner` CSS: a full-width strip with the title on the left and the buttons on the right, `var(--color-warning-bg)`-style tokens from `tokens.css` if present, else the existing panel background with a top/bottom border.

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(ui): merge feature foundations, operation banner and commit-draft prefill`.

---

### Task 5: Front end — branch, graph and conflict context menus

**Files:**

- Modify: `src/features/branches/BranchesPanel.tsx`, `src/features/graph/GraphPanel.tsx`, `src/features/worktree/ChangesPanel.tsx`
- Test: `BranchesPanel.test.tsx`, `GraphPanel.test.tsx`, `ChangesPanel.test.tsx` (extend)

**Interfaces:**

- Consumes: `useOperationState`, `useIntegrationActions`, `useCanFastForward`, `sideLabels`, `headName`, `IN_PROGRESS_TITLE` (Task 4); `MenuItem.{disabled,title}`.
- Produces: no new exports. Behaviour:
  - `BranchesPanel`: `const { state } = useOperationState(repoId)`, `const integration = useIntegrationActions(repoId)`, `const menuBranch = menu === null || (menu.target.kind === "local" && menu.target.branch.isHead) ? null : branchId(menu.target)` where `branchId` is `name` or `${remote}/${name}`; `const { check, isLoading } = useCanFastForward(repoId, menuBranch)`. Items appended after `Checkout` for remote rows and non-HEAD local rows: `merge` (`Merge <b> into <cur>`), `fastForward` (`Fast-forward <cur> to <b>`), `rebase` (`Rebase <cur> onto <b>`). Common `disabled`/`title`: pending (either hook) → disabled; `state?.kind !== "none"` → `IN_PROGRESS_TITLE`; head not a branch → `Check out a branch first`. Fast-forward extra: `isLoading` → `Checking…`; `upToDate` → `Already up to date`; `diverged` → `<cur> and <b> have diverged`. `onSelect` → `void integration.run({ action, … })`. Panel error slot shows `actions.error ?? integration.error`; dismiss clears both; `aria-busy` on either pending.
  - `GraphPanel`: same two hooks; `headOid = branches.local.find(b => b.isHead)?.oid ?? (head.kind === "detached" ? head.oid : null)`; items after `Reset to this commit…`: `cherryPick` (`Cherry-pick commit`) and `revert` (`Revert commit`). Disabled: pending; `state?.kind !== "none"` (`IN_PROGRESS_TITLE`); `row.parents.length > 1` (`Merge commits are not supported yet`); cherry-pick also `row.oid === headOid` (`Already on this commit`). `panelError` includes `integration.error`; `clearErrors` resets it; `pending` includes `integration.pending`.
  - `ChangesPanel`: `useOperationState`, `useBranches`, `useIntegrationActions`; `const sides = sideLabels(state, headName(branches?.head))`; conflicts-row menu: `keepOurs` (`Keep <sides.ours>`) → `run({ action: "resolve", paths: targets(row), side: "ours" })`, `takeTheirs` (`Take <sides.theirs>`) → `side: "theirs"`, then the existing `Mark resolved (stage)`. Disabled while either hook is pending. Error slot: `actions.error ?? integration.error`; `FileRow disabled` on either pending.

- [ ] **Step 1: Write the failing tests** — `BranchesPanel.test.tsx` (mock `../merge/useOperationState`, `../merge/useIntegrationActions`, `../merge/useCanFastForward`): local non-HEAD row menu has the three items with exact labels; HEAD row has none; remote row labels use `origin/x`; `fastForward` disabled with `Checking…` while loading, `Already up to date`, `<cur> and <b> have diverged`, enabled on `possible`; all three disabled with `IN_PROGRESS_TITLE` when state is a merge; detached head → `Check out a branch first`; selecting `merge` calls `run({ action: "merge", branch })`, `fastForward` → `{ action: "fastForward", branch }`, `rebase` → `{ action: "rebase", onto }`; integration error shows in the panel and Dismiss clears it; `aria-busy` when integration pending. `GraphPanel.test.tsx`: both items present; disabled reasons (`Merge commits are not supported yet` for `parents.length === 2`, `Already on this commit` for the HEAD row on cherry-pick only, in-progress title); calls `run({ action: "cherryPick", oid })` and `{ action: "revert", oid }`; integration error in the panel. `ChangesPanel.test.tsx`: conflict row menu is `Keep main`, `Take feature`, `Mark resolved (stage)` for a merge state with `branch: "feature"` and head `main`; rebase state labels are `Keep <ontoName>` / `Take <branch>`; `conflict menu falls back to ours and theirs without an operation` (`Keep ours`, `Take theirs`); keep calls `run({ action: "resolve", paths: ["README.md"], side: "ours" })`, take with `theirs`; multi-selected conflict rows pass every selected path; integration error shown with Dismiss; rows disabled while integration pending.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/features/branches src/features/graph src/features/worktree`.

- [ ] **Step 3: Implement** — as described under Produces; keep the menu-building functions pure where they already are (`menuItems`).

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(ui): merge, rebase, cherry-pick, revert and keep-one-side menu actions`.

---

### Task 6: Front end — commit box prefill and labels, commit gate, `RepoPane` banner

**Files:**

- Create: `src/features/commit/useOperationPrefill.ts`
- Modify: `src/features/commit/CommitBox.tsx`, `src/features/commit/commitGate.ts`, `src/features/commit/MessageEditor.tsx` (subject input gets `id="commit-subject"`; `useId` stays for the label association via `aria-labelledby` or the label's `htmlFor` switches to the fixed id), `src/app/RepoPane.tsx`
- Test: `useOperationPrefill.test.tsx` (create), `CommitBox.test.tsx`, `commitGate.test.ts`, `MessageEditor.test.tsx`, `RepoPane.test.tsx` (extend)

**Interfaces:**

- Consumes: `useOperationState`, `commitsThroughBox`, `commitButtonLabel`, `operationNoun`, `OperationBanner` (Task 4); `useCommitDraft.syncPrefill`.
- Produces:

```ts
// commitGate.ts — CommitGateInput gains `operation: OperationState | undefined`
//   order: loading (status/config undefined) → operation?.kind === "rebase" → "Use Continue in the banner to resume the rebase"
//          → identity → conflicts → staged → subject
// useOperationPrefill.ts
export function useOperationPrefill(repoId: RepoId): OperationState | undefined;
//   const { state } = useOperationState(repoId);
//   useEffect(() => { if (state !== undefined) useCommitDraft.getState().syncPrefill(repoId, commitsThroughBox(state) ? state.message : null); }, [repoId, state]);
//   returns state for the box
// CommitBox: button label = pending ? "Committing…" : draft.amend ? "Amend commit" : (commitButtonLabel(state) ?? "Commit");
//   amend checkbox disabled when state !== undefined && state.kind !== "none", title `Not available during a ${operationNoun(state)}`
// RepoPane: <OperationBanner repoId={tab.id} /> rendered between <header> and the body div
```

- [ ] **Step 1: Write the failing tests** — `useOperationPrefill.test.tsx` (mock `useOperationState`; real store): `prefills on first observation of a merge` (empty draft → subject/body from the message, `prefilled` set); `does not overwrite edited text on refetch` (user `setSubject` then the same state object re-renders → text kept); transition to `none` clears an untouched prefill; transition to `none` keeps edited text; rebase state passes `null` (no prefill); returns the state. `commitGate.test.ts`: rebase reason appears after loading and before identity (identity unset + rebase → rebase reason); `operation: undefined` and `{ kind: "none" }` change nothing. `CommitBox.test.tsx` (mock `useOperationPrefill`): label `Commit and merge` / `Commit and cherry-pick` / `Commit and revert`; `Commit` for none; amend disabled with `Not available during a merge`; amend still works for none. `MessageEditor.test.tsx`: subject input has `id="commit-subject"` and is still labelled `Subject`. `RepoPane.test.tsx`: `OperationBanner` rendered (mock it) between the header and the body, with `repoId === tab.id`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/features/commit src/app`.

- [ ] **Step 3: Implement** — as described under Produces.

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(ui): commit box finishes merges, cherry-picks and reverts; operation banner in the repo pane`.

---

## Execution: batched agent cycles

Per `feedback-token-cost-batching`: three cycles, each running the mandatory team workflow once (architect + tdd-tester in parallel → developer → tdd-tester-coverage + code-reviewer in parallel → fix loop), then one final architect sign-off.

| Cycle | Tasks | Deliverable                                                                 |
| ----- | ----- | --------------------------------------------------------------------------- |
| 1     | 1–3   | Rust: operations, state, resolve, fast-forward check, commands, error kinds |
| 2     | 4     | Front-end foundations: seam, keys, draft prefill, merge hooks, banner       |
| 3     | 5–6   | Context menus, conflict actions, commit box, `RepoPane` wiring              |

Dispatch count: 3 × 5 = 15 plus the final architect = 16, plus any fix passes. Models: architect and developer on the opus agent definitions, tester, coverage and reviewer on sonnet, passed explicitly on each dispatch. Agents write their reports to the scratchpad, not the main context.

## After the last task

1. Full gates: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`, `npm test` (100 %), `npm run lint`, `npm run typecheck`.
2. Acceptance walk from spec §6 in the running app (`npm run tauri dev`, driven through the WebKit remote inspector per the `tauri-webview-automation` memory and the `gr9/walk/helpers9.js` pattern).
3. Merge `feature/gr-10a-merge-rebase-operations` into `main` with `--no-ff`; comment on Jira GR-10 with the slice-a walk results and follow-ups (the story stays open for GR-10b and GR-10c).
