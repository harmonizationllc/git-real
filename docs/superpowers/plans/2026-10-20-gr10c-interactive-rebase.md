# GR-10c Interactive Rebase and Drag-to-Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user rewrites the current branch's commits (reorder, squash, fixup, edit, drop) in a modal dialog opened from the graph or the branch menu, and merges, fast-forwards or rebases by dragging a branch row onto the current branch row.

**Architecture:** The core lists the commits `git rebase -i <base>` would replay with a git2 revwalk, validates the user's todo, writes it to a temp file and runs the git CLI with `GIT_SEQUENCE_EDITOR=cp '<file>'` so git takes the plan verbatim (ADR 0001: commit-creating operations go through the CLI). The outcome gains `stopped` for an `edit` stop, which the state reader reports as `stoppedForEdit`. The front end keeps the plan as a pure array model (`plan.ts`), renders it in `RebaseDialog` and sends it through the existing `useIntegrationActions`. Drag-to-merge reuses the Branches panel's merge menu: a drop on the current branch row opens that menu for the dragged branch.

**Tech Stack:** Rust 2024 + git2 0.20 (`default-features = false`), system git CLI, Tauri 2, React 19 + TypeScript, TanStack Query 5, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-20-gr10c-interactive-rebase-design.md`

## Global Constraints

- Tests first, by the test role; the developer role never edits test files (CLAUDE.md).
- Only `src/lib/ipc` imports `@tauri-apps/api/*` (ESLint-enforced).
- `git2` stays `default-features = false`; no direct `tokio`; blocking work runs through `run_blocking`; `git-real-core` has no Tauri dependency.
- The git CLI run uses `git_ops::run` with env `GIT_SEQUENCE_EDITOR=cp '<file>'` (single-quoted, `'` in the path escaped as `'\''`) and `GIT_EDITOR=true`; the temp file is `std::env::temp_dir().join(format!("git-real-rebase-{pid}-{nanos}.todo"))` and is deleted whether or not git succeeded.
- Todo lines are `<action> <full oid> <subject>` with every control character in the subject replaced by a space; the oid git is given as `base` is the resolved full hex.
- Validation order in `rebase_plan`: in progress → unborn → base resolves (40 hex: `resolve_commit` / `CommitNotFound`; otherwise `resolve_branch` / `BranchNotFound`) → strict ancestor (`BadSelection`) → merge commit in range (`MergeCommit(hex)`). `rebase_interactive` re-runs `rebase_plan`, then: unknown oid, duplicate oid, nothing kept, first kept step squash/fixup → `BadSelection`.
- Outcome classification: exit 0 + state `Clean` → `Completed`; exit 0 + rebase state → `Stopped`; non-zero + rebase state + conflicts in the index → `Conflicts`; else `OperationFailed { verb: "rebase" }`.
- `OperationState::Rebase.stopped_for_edit` = `rebase-merge/amend` exists (false for the `rebase-apply` layout). Serde field `stoppedForEdit`.
- Dialog lists newest first; `toSteps` sends oldest first. `foldBlocked(steps, i)` is true when step `i` is the last non-drop step and its action is squash or fixup.
- `queryKeys.rebasePlan(id, base) = ["repo", id, "rebasePlan", base]`.
- Drag-to-merge: a row is draggable when it is not current, HEAD is on a branch, no operation is in progress and nothing is pending; the current row is the only target, and only while `dragging !== null`; drop opens the existing merge menu at the drop point.
- Copy (verbatim, spec §5): `Rebase interactively from here…`; `Rebase {cur} onto {b} interactively…`; `Already at HEAD`; `Check out a branch first`; `Rebase {head} onto {label} interactively`; `Loading commits…`; `Nothing to rebase: {head} has no commits after {label}.`; `Commits to rebase`; `Action for {short}`; action labels `Pick — keep the commit`, `Squash — fold into the commit above, keep both messages`, `Fixup — fold into the commit above, discard its message`, `Edit — stop after applying it to amend`, `Drop — leave the commit out`; `Cannot squash the oldest commit`; `Move up`; `Move down`; `{n} commits, {m} squashed, {k} dropped` with singulars `1 commit`, `1 squashed`, `1 dropped`; `Cancel`; `Start rebase`; `Working…`; banner `, stopped to edit`; dialog messages `That commit is not on {head}.` (badSelection) and `The range contains a merge commit, which cannot be rebased interactively yet.` (mergeCommit).
- Gates: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `npm test` at 100 % coverage for `src/`, `npm run lint` (no new warnings), `npm run typecheck`.

## Review Focus

1. A todo whose steps omit some plan commits is accepted by the core (git ignores missing commits) but the dialog never produces one; the core must still reject an oid outside the range (Task 1 test `rebase_interactive_rejects_an_oid_outside_the_range`).
2. A subject containing a newline or a `#` must not corrupt the todo file (Task 1 test `rebase_interactive_sanitises_subjects_in_the_todo`).
3. Dropping the newest row then squashing what is now the oldest kept row must disable Start with the alert, and moving it back up must re-enable it (Task 2 test `blocks a squash that becomes the oldest kept step after a move`).
4. A branch dragged over a row other than the current one must not highlight anything or open a menu on drop (Task 3 test `ignores a drop on a non-current row`).
5. While a rebase is in progress every row loses `draggable` so the gesture cannot start a second operation (Task 3 test `disables dragging during an operation`).

---

### Task 1: Core `rebase_plan` / `rebase_interactive`, `Stopped` outcome, state flag, commands, IPC

**Files:**

- Create: `src-tauri/crates/git-real-core/src/merge/interactive.rs`
- Modify: `src-tauri/crates/git-real-core/src/model/merge.rs` (`RebaseAction`, `RebaseCommit`, `RebaseStep`, `OperationOutcome::Stopped`, `stopped_for_edit`)
- Modify: `src-tauri/crates/git-real-core/src/model/mod.rs` (re-export the three new types)
- Modify: `src-tauri/crates/git-real-core/src/merge/mod.rs` (`mod interactive;`, `Stopped` arm in `outcome`, `ensure_clean`/`ensure_born`/`git` become `pub(super)`)
- Modify: `src-tauri/crates/git-real-core/src/merge/state.rs` (`stopped_for_edit`)
- Modify: `src-tauri/src/commands/merge.rs`, `src-tauri/src/lib.rs`
- Modify: `src/lib/ipc/types.ts`, `src/lib/ipc/commands.ts`, `src/lib/query/keys.ts`
- Test: `src-tauri/crates/git-real-core/tests/merge.rs` (extend), `src-tauri/tests/merge_commands.rs` (extend), `src/lib/ipc/commands.test.ts`, `src/lib/ipc/types.test.ts` (extend), `src/lib/query/keys.test.ts` if present

**Interfaces:**

- Consumes: `git_ops::run`, `RepoSession::{ensure_clean, ensure_born, resolve_branch, git, fresh_index, outcome}`, `revision::resolve_commit`, `commit::message::split`, `model::Signature`, `GitError::{BadSelection, MergeCommit, CommitNotFound, BranchNotFound}`.
- Produces:

```rust
pub enum RebaseAction { Pick, Squash, Fixup, Edit, Drop }          // serde camelCase
pub struct RebaseCommit { pub oid: String, pub subject: String, pub author: Signature }
pub struct RebaseStep { pub action: RebaseAction, pub oid: String }
pub enum OperationOutcome { Completed, Conflicts, Stopped }
// OperationState::Rebase { …, stopped_for_edit: bool }
impl RepoSession {
    pub fn rebase_plan(&self, base: &str) -> Result<Vec<RebaseCommit>, GitError>;
    pub fn rebase_interactive(&self, base: &str, steps: &[RebaseStep]) -> Result<OperationOutcome, GitError>;
}
// app layer
pub fn rebase_plan_inner(reg: &RepoRegistry, id: RepoId, base: &str) -> Result<Vec<RebaseCommit>, AppError>;
pub fn rebase_interactive_inner(reg: &RepoRegistry, id: RepoId, base: &str, steps: &[RebaseStep]) -> Result<OperationOutcome, AppError>;
// IPC
export type RebaseAction = "pick" | "squash" | "fixup" | "edit" | "drop";
export interface RebaseCommit { oid: string; subject: string; author: Signature }
export interface RebaseStep { action: RebaseAction; oid: string }
export type OperationOutcome = "completed" | "conflicts" | "stopped";
export function rebasePlan(id: RepoId, base: string): Promise<RebaseCommit[]>;
export function rebaseInteractive(id: RepoId, base: string, steps: RebaseStep[]): Promise<OperationOutcome>;
queryKeys.rebasePlan(id, base)
```

- [ ] **Step 1: Write the failing core tests** (append to `src-tauri/crates/git-real-core/tests/merge.rs`; every CLI test starts with `if !common::git_available() { return; }` and `common::configure_identity(&path)` as the existing rebase tests do)

```rust
// ---------- GR-10c: interactive rebase ----------

/// `main` with README, then `feature` with three commits a, b, c (files a.txt, b.txt, c.txt),
/// HEAD on `feature`. Returns the three feature oids oldest first and the main tip.
fn feature_fixture() -> (TempDir, PathBuf, [Oid; 3], Oid) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let main_tip = Repository::open(&path).unwrap().head().unwrap().target().unwrap();
    common::run_git_ok(&path, &["switch", "-c", "feature"]);
    let a = common::commit_file(&path, "a.txt", "a\n", "add a");
    let b = common::commit_file(&path, "b.txt", "b\n", "add b\n\nbody of b");
    let c = common::commit_file(&path, "c.txt", "c\n", "add c");
    (dir, path, [a, b, c], main_tip)
}

fn step(action: RebaseAction, oid: Oid) -> RebaseStep {
    RebaseStep { action, oid: oid.to_string() }
}

fn subjects(path: &Path) -> Vec<String> {
    let out = common::run_git_ok(path, &["log", "--format=%s", "main..HEAD"]);
    String::from_utf8_lossy(&out.stdout).lines().map(str::to_owned).collect()
}

#[test]
fn rebase_plan_lists_the_range_oldest_first_with_fields() {
    let (_d, path, [a, b, c], _) = feature_fixture();
    let session = RepoSession::open(&path).unwrap();

    let plan = session.rebase_plan("main").unwrap();

    assert_eq!(plan.iter().map(|c| c.oid.as_str()).collect::<Vec<_>>(), [a.to_string(), b.to_string(), c.to_string()]);
    assert_eq!(plan[1].subject, "add b");
    assert_eq!(plan[1].author.name, "Test User");
    assert_eq!(plan[1].author.email, "test@example.com");
}

#[test]
fn rebase_plan_accepts_a_full_oid_base() {
    let (_d, path, [a, b, c], _) = feature_fixture();
    let session = RepoSession::open(&path).unwrap();
    let plan = session.rebase_plan(&a.to_string()).unwrap();
    assert_eq!(plan.iter().map(|c| c.oid.clone()).collect::<Vec<_>>(), [b.to_string(), c.to_string()]);
}

#[test]
fn rebase_plan_accepts_a_remote_tracking_base() { /* add_remote_and_fetch from main, plan("origin/main") == 3 commits */ }

#[test]
fn rebase_plan_unknown_oid_is_commit_not_found() {
    let (_d, path, ..) = feature_fixture();
    let err = RepoSession::open(&path).unwrap().rebase_plan(&"f".repeat(40)).unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(_)));
}

#[test]
fn rebase_plan_unknown_branch_is_branch_not_found() { /* "nope" → BranchNotFound */ }

#[test]
fn rebase_plan_dash_prefixed_base_is_branch_not_found() { /* "--exec" → BranchNotFound */ }

#[test]
fn rebase_plan_head_itself_is_bad_selection() { /* base = c.to_string() → BadSelection */ }

#[test]
fn rebase_plan_non_ancestor_is_bad_selection() { /* base = "other" from branch_with_commit(.., "other", ..) → BadSelection */ }

#[test]
fn rebase_plan_while_in_progress_is_operation_in_progress() { /* diverged_fixture + rebase_onto("other") conflicts, then rebase_plan("other") → OperationInProgress */ }

#[test]
fn rebase_plan_on_unborn_is_unborn_head() { /* temp_repo_unborn → UnbornHead */ }

#[test]
fn rebase_plan_with_a_merge_commit_in_range_is_merge_commit() {
    // feature_fixture, then on feature: `git merge --no-ff main`? main is an ancestor, so instead:
    // create `side` from main with one commit, back on feature `git merge --no-ff side`, plan("main") → MergeCommit(merge oid)
}

#[test]
fn rebase_interactive_reorders_squashes_and_drops() {
    let (_d, path, [a, b, c], _) = feature_fixture();
    let session = RepoSession::open(&path).unwrap();
    // git order: c first, then a with b squashed into it
    let steps = [step(RebaseAction::Pick, c), step(RebaseAction::Pick, a), step(RebaseAction::Squash, b)];

    let outcome = session.rebase_interactive("main", &steps).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(subjects(&path), ["add a", "add c"]);          // newest first
    let body = String::from_utf8_lossy(&common::run_git_ok(&path, &["log", "-1", "--format=%B"]).stdout).into_owned();
    assert!(body.contains("add a") && body.contains("add b") && body.contains("body of b"), "{body}");
    assert_eq!(session.operation_state(), OperationState::None);
    assert_eq!(common::head_branch_name(&path), "feature");
}

#[test]
fn rebase_interactive_drop_removes_the_commit() { /* pick a, drop b, pick c → subjects ["add c","add a"], b.txt absent */ }

#[test]
fn rebase_interactive_fixup_keeps_the_first_message_only() { /* pick a, fixup b → log -1 %B == "add a\n" */ }

#[test]
fn rebase_interactive_edit_stops_with_the_flag() {
    let (_d, path, [a, b, c], _) = feature_fixture();
    let session = RepoSession::open(&path).unwrap();
    let steps = [step(RebaseAction::Pick, a), step(RebaseAction::Edit, b), step(RebaseAction::Pick, c)];

    let outcome = session.rebase_interactive("main", &steps).unwrap();

    assert_eq!(outcome, OperationOutcome::Stopped);
    match session.operation_state() {
        OperationState::Rebase { stopped_for_edit, step, total, branch, .. } => {
            assert!(stopped_for_edit);
            assert_eq!((step, total), (2, 3));
            assert_eq!(branch.as_deref(), Some("feature"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn continue_after_an_edit_stop_amends_staged_changes() {
    // as above, then write_file b.txt "b2\n", stage("b.txt"), session.continue_rebase() == Completed,
    // `git show HEAD~1:b.txt` == "b2\n", subjects == ["add c","add b","add a"], state None
}

#[test]
fn state_without_an_amend_marker_is_not_stopped_for_edit() { /* conflicting rebase_onto → stopped_for_edit false */ }

#[test]
fn rebase_interactive_conflict_is_conflicts() {
    // feature_fixture plus two commits both editing x.txt line 1 (x1 then x2); steps swap them → Conflicts, index has conflicts
}

#[test]
fn rebase_interactive_rejects_an_oid_outside_the_range() { /* step with main_tip → BadSelection, state None, log unchanged */ }

#[test]
fn rebase_interactive_rejects_a_duplicate_oid() { /* pick a, pick a → BadSelection */ }

#[test]
fn rebase_interactive_rejects_all_dropped() { /* drop a, drop b, drop c → BadSelection */ }

#[test]
fn rebase_interactive_rejects_a_leading_squash() { /* squash a, pick b → BadSelection */ }

#[test]
fn rebase_interactive_rejects_a_leading_fixup_after_drops() { /* drop a, fixup b, pick c → BadSelection */ }

#[test]
fn rebase_interactive_sanitises_subjects_in_the_todo() {
    // commit with message "weird\nsubject #1\n\nbody"; fake_git that copies "$@"'s todo into $FAKE_OUT
    // is too indirect — instead run for real with pick only and assert Completed and the subject survived intact in the log.
}

#[test]
fn rebase_interactive_cleans_the_temp_file_when_git_fails() {
    // fake_git script: `exit 1`; PATH set to the fake dir for this process (the existing fake-git tests show how);
    // count files matching git-real-rebase-* in temp_dir before and after → equal; error is OperationFailed verb "rebase"
}

#[test]
fn rebase_interactive_validation_errors_leave_the_repository_clean() { /* after the rejects: state None, index clean, HEAD unchanged */ }
```

Also extend `state_reads_the_rebase_apply_layout` expectations with `stopped_for_edit: false` (the struct gained a field; every `OperationState::Rebase { .. }` literal in the file needs it).

- [ ] **Step 2: Write the failing app-layer tests** (append to `src-tauri/tests/merge_commands.rs`)

```rust
#[test]
fn rebase_plan_inner_lists_commits() { /* feature fixture via run_git_ok; rebase_plan_inner(&reg, id, "main") has 3 entries oldest first */ }

#[test]
fn rebase_plan_inner_maps_bad_selection() { /* base = HEAD oid → AppErrorKind::BadSelection */ }

#[test]
fn rebase_interactive_inner_completes_a_drop() { /* → OperationOutcome::Completed, get_operation_state_inner None */ }

#[test]
fn rebase_interactive_inner_reports_stopped() { /* edit step → OperationOutcome::Stopped and state stopped_for_edit */ }

#[test]
fn rebase_step_and_commit_serialise_camel_case() {
    let json = serde_json::to_value(RebaseCommit { oid: "a".into(), subject: "s".into(), author: Signature { name: "n".into(), email: "e".into(), time: 1 } }).unwrap();
    assert_eq!(json, json!({ "oid": "a", "subject": "s", "author": { "name": "n", "email": "e", "time": 1 } }));
    let step: RebaseStep = serde_json::from_value(json!({ "action": "fixup", "oid": "a" })).unwrap();
    assert_eq!(step.action, RebaseAction::Fixup);
    assert_eq!(serde_json::to_value(OperationOutcome::Stopped).unwrap(), json!("stopped"));
}

#[test]
fn rebase_state_serialises_stopped_for_edit() { /* json of a Rebase state has "stoppedForEdit": false */ }
```

- [ ] **Step 3: Write the failing IPC tests** (`src/lib/ipc/commands.test.ts`: `rebasePlan sends rebase_plan with id and base`, `rebaseInteractive sends rebase_interactive with id, base and steps`, both added to the error-mapping table; `src/lib/ipc/types.test.ts`: a rebase state literal with `stoppedForEdit: true` type-checks and `"stopped"` is an `OperationOutcome`; `src/lib/query/keys.test.ts` if it exists: `rebasePlan(1, "main")` equals `["repo", 1, "rebasePlan", "main"]`)

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test -p git-real-core --test merge rebase_plan` → compile error (no `rebase_plan`). `npm test -- src/lib/ipc` → fails on missing exports.

- [ ] **Step 5: Implement the model** (`model/merge.rs`)

```rust
/// One line of an interactive rebase todo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RebaseAction {
    Pick,
    Squash,
    Fixup,
    Edit,
    Drop,
}

impl RebaseAction {
    /// The todo keyword git reads.
    pub(crate) fn keyword(self) -> &'static str {
        match self {
            Self::Pick => "pick",
            Self::Squash => "squash",
            Self::Fixup => "fixup",
            Self::Edit => "edit",
            Self::Drop => "drop",
        }
    }
}

/// A commit an interactive rebase would replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    /// Full hex object id.
    pub oid: String,
    pub subject: String,
    pub author: Signature,
}

/// One entry of the user's plan, in the order git applies them (oldest first).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub action: RebaseAction,
    /// Full hex object id of a commit in the plan.
    pub oid: String,
}
```

`OperationOutcome` gains `/// Exit 0 with the rebase still in progress: an `edit` step stopped it.` `Stopped`. `Rebase` gains `/// `rebase-merge/amend`exists: git stopped at an`edit` step; staged changes are amended on continue.` `stopped_for_edit: bool`. `Signature` needs `Deserialize` (it is in `model/log.rs`; add the derive). Re-export in `model/mod.rs`.

- [ ] **Step 6: Implement the state flag** (`state.rs::read_rebase`): `stopped_for_edit: merge_dir_used && dir.join("amend").exists()` — compute `let interactive = merge_dir.is_dir();` before choosing the layout and use it.

- [ ] **Step 7: Implement `merge/interactive.rs`**

```rust
//! Interactive rebase: listing the commits git would replay and running
//! `git rebase -i` with a prepared todo.
//!
//! git reads the todo through `GIT_SEQUENCE_EDITOR`, which is given a `cp`
//! of a temp file we write, so the sequencer, hooks, rerere and signing run
//! exactly as on the command line (ADR 0001).

use std::collections::HashSet;
use std::path::PathBuf;

use git2::{Oid, RepositoryState, Sort};

use super::git_ops;
use crate::commit::message;
use crate::error::GitError;
use crate::model::{OperationOutcome, RebaseAction, RebaseCommit, RebaseStep, Signature};
use crate::repo::RepoSession;
use crate::revision;

impl RepoSession {
    /// The commits `git rebase -i base` would replay, oldest first. `base` is
    /// a full hex oid or a branch name and must be a strict ancestor of HEAD;
    /// a range holding a merge commit is `MergeCommit`.
    pub fn rebase_plan(&self, base: &str) -> Result<Vec<RebaseCommit>, GitError> {
        self.ensure_clean()?;
        self.ensure_born()?;
        let base_oid = self.resolve_base(base)?;
        let repo = self.repo();
        let head = repo.head()?.peel_to_commit()?.id();
        if base_oid == head || !repo.graph_descendant_of(head, base_oid)? {
            return Err(GitError::BadSelection);
        }
        let mut walk = repo.revwalk()?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE)?;
        walk.push(head)?;
        walk.hide(base_oid)?;
        let mut plan = Vec::new();
        for oid in walk {
            let commit = repo.find_commit(oid?)?;
            if commit.parent_count() > 1 {
                return Err(GitError::MergeCommit(commit.id().to_string()));
            }
            let author = commit.author();
            plan.push(RebaseCommit {
                oid: commit.id().to_string(),
                subject: message::split(commit.message().unwrap_or("")).subject,
                author: Signature {
                    name: author.name().unwrap_or("").to_owned(),
                    email: author.email().unwrap_or("").to_owned(),
                    time: author.when().seconds(),
                },
            });
        }
        Ok(plan)
    }

    /// Runs `git rebase -i base` with `steps` as the todo, oldest first.
    pub fn rebase_interactive(
        &self,
        base: &str,
        steps: &[RebaseStep],
    ) -> Result<OperationOutcome, GitError> {
        let plan = self.rebase_plan(base)?;
        validate(&plan, steps)?;
        let base_hex = self.resolve_base(base)?.to_string();
        let todo = TodoFile::write(&todo_text(&plan, steps))?;
        let editor = format!("cp {}", shell_quote(&todo.path.to_string_lossy()));
        let (git, workdir) = self.git()?;
        let env = [("GIT_SEQUENCE_EDITOR", editor.as_str()), ("GIT_EDITOR", "true")];
        let output = git_ops::run(&git, workdir, "rebase", &["-i", &base_hex], &env);
        drop(todo);
        self.outcome("rebase", &output?)
    }

    /// 40 hex characters name a commit; anything else a local or remote branch.
    fn resolve_base(&self, base: &str) -> Result<Oid, GitError> {
        if base.len() == 40 && base.bytes().all(|b| b.is_ascii_hexdigit()) {
            Ok(revision::resolve_commit(self.repo(), base)?.id())
        } else {
            self.resolve_branch(base)
        }
    }
}

/// Every step names a plan commit once, something is kept, and the first
/// kept step is not a fold (git: "cannot 'squash' without a previous commit").
fn validate(plan: &[RebaseCommit], steps: &[RebaseStep]) -> Result<(), GitError> {
    let known: HashSet<&str> = plan.iter().map(|c| c.oid.as_str()).collect();
    let mut seen = HashSet::new();
    for s in steps {
        if !known.contains(s.oid.as_str()) || !seen.insert(s.oid.as_str()) {
            return Err(GitError::BadSelection);
        }
    }
    match steps.iter().find(|s| s.action != RebaseAction::Drop) {
        None => Err(GitError::BadSelection),
        Some(first) if matches!(first.action, RebaseAction::Squash | RebaseAction::Fixup) => {
            Err(GitError::BadSelection)
        }
        Some(_) => Ok(()),
    }
}

/// `<action> <oid> <subject>` per step; git ignores the subject, which is
/// for `git status` and `rebase-merge/done`, so control characters are
/// flattened to spaces to keep one step per line.
fn todo_text(plan: &[RebaseCommit], steps: &[RebaseStep]) -> String {
    let mut text = String::new();
    for s in steps {
        let subject = plan
            .iter()
            .find(|c| c.oid == s.oid)
            .map(|c| c.subject.replace(|ch: char| ch.is_control(), " "))
            .unwrap_or_default();
        text.push_str(&format!("{} {} {}\n", s.action.keyword(), s.oid, subject));
    }
    text
}

/// Single-quotes `s` for the POSIX shell git runs the sequence editor with.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A todo file in the temp dir, deleted on drop.
struct TodoFile {
    path: PathBuf,
}

impl TodoFile {
    fn write(text: &str) -> Result<Self, GitError> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "git-real-rebase-{}-{nanos}.todo",
            std::process::id()
        ));
        std::fs::write(&path, text)?;
        Ok(Self { path })
    }
}

impl Drop for TodoFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
```

In `merge/mod.rs`: add `mod interactive;`, make `ensure_clean`, `ensure_born`, `git` and `outcome` `pub(super)`, and extend `outcome`:

```rust
    pub(super) fn outcome(&self, verb: &str, output: &Output) -> Result<OperationOutcome, GitError> {
        let in_rebase = matches!(
            self.repo().state(),
            RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge
        );
        if output.status.success() {
            return Ok(if in_rebase { OperationOutcome::Stopped } else { OperationOutcome::Completed });
        }
        if self.repo().state() != RepositoryState::Clean && self.fresh_index()?.has_conflicts() {
            return Ok(OperationOutcome::Conflicts);
        }
        Err(operation_failed(verb, output))
    }
```

Note the `state` check for `Stopped` happens after git exits, so `rebase_onto` and `continue_rebase` also report it when an `edit` line (from a plan) stops a later step. Document the `cp` requirement in the module doc of `merge/mod.rs`: "interactive rebase needs `cp` on the PATH git's shell sees (bundled with Git for Windows)".

- [ ] **Step 8: Implement the commands and IPC**

`commands/merge.rs`: `rebase_plan_inner` / `rebase_interactive_inner` via `with_session`, plus `#[tauri::command] pub async fn rebase_plan(reg, id, base: String) -> Result<Vec<RebaseCommit>, AppError>` and `rebase_interactive(reg, id, base: String, steps: Vec<RebaseStep>) -> Result<OperationOutcome, AppError>` in the `run_blocking` shape of the file. Register both in `lib.rs` after `can_fast_forward`.

`types.ts`: add the three types, extend `OperationOutcome`, add `stoppedForEdit: boolean` to the rebase variant. `commands.ts`:

```ts
export function rebasePlan(id: RepoId, base: string): Promise<RebaseCommit[]> {
  return invoke<RebaseCommit[]>("rebase_plan", { id, base });
}

export function rebaseInteractive(
  id: RepoId,
  base: string,
  steps: RebaseStep[],
): Promise<OperationOutcome> {
  return invoke<OperationOutcome>("rebase_interactive", { id, base, steps });
}
```

`keys.ts`: `rebasePlan: (id: RepoId, base: string) => ["repo", id, "rebasePlan", base] as const,`. Fix every front-end rebase-state fixture that now lacks `stoppedForEdit` (typecheck will list them: `operationCopy.test.ts`, `OperationBanner.test.tsx`, `types.test.ts`, others).

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --check`; `npm test -- src/lib && npm run typecheck`.

- [ ] **Step 10: Commit**

```bash
git add src-tauri src/lib
git commit -m "feat(core): GR-10c interactive rebase plan and run, stopped outcome, IPC wrappers"
```

---

### Task 2: Rebase dialog — plan model, plan query, step row, dialog, integration request, banner copy

**Files:**

- Create: `src/features/merge/rebase/model/plan.ts`, `src/features/merge/rebase/useRebasePlan.ts`, `src/features/merge/rebase/RebaseStepRow.tsx` (+ `.module.css`), `src/features/merge/rebase/RebaseDialog.tsx` (+ `.module.css`)
- Modify: `src/features/merge/useIntegrationActions.ts` (`rebaseInteractive` request), `src/features/merge/operationCopy.ts` (edit-stop suffix)
- Test: `model/plan.test.ts`, `useRebasePlan.test.tsx`, `RebaseStepRow.test.tsx`, `RebaseDialog.test.tsx`, extend `useIntegrationActions.test.tsx`, `operationCopy.test.ts`, `OperationBanner.test.tsx`

**Interfaces:**

- Consumes: Task 1's IPC (`rebasePlan`, `rebaseInteractive`, `RebaseCommit`, `RebaseStep`, `RebaseAction`, `queryKeys.rebasePlan`), `RepoError`, `shortOid`, `UseIntegrationActions`.
- Produces:

```ts
// model/plan.ts
export interface PlanStep { oid: string; subject: string; author: Signature; action: RebaseAction }
export const ACTIONS: readonly { action: RebaseAction; label: string }[];
export function initialPlan(commits: RebaseCommit[]): PlanStep[];
export function move(steps: PlanStep[], from: number, to: number): PlanStep[];
export function setAction(steps: PlanStep[], index: number, action: RebaseAction): PlanStep[];
export function foldBlocked(steps: PlanStep[], index: number): boolean;
export function summary(steps: PlanStep[]): { kept: number; squashed: number; dropped: number };
export function summaryText(s: ReturnType<typeof summary>): string;
export function toSteps(steps: PlanStep[]): RebaseStep[];
export function canStart(steps: PlanStep[]): boolean;
// useRebasePlan.ts
export function useRebasePlan(repoId: RepoId, base: string): { commits: RebaseCommit[] | undefined; error: AppError | null; loading: boolean };
// RebaseDialog.tsx
export interface RebaseDialogProps { repoId: RepoId; base: string; label: string; head: string; run: UseIntegrationActions["run"]; pending: boolean; onClose(): void }
export function RebaseDialog(props: RebaseDialogProps): JSX.Element;
// useIntegrationActions.ts
| { action: "rebaseInteractive"; base: string; steps: RebaseStep[] }
```

- [ ] **Step 1: Write the failing plan-model tests** (`model/plan.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import type { RebaseCommit } from "../../../../lib/ipc";
import {
  canStart,
  foldBlocked,
  initialPlan,
  move,
  setAction,
  summary,
  summaryText,
  toSteps,
} from "./plan";

const commit = (c: string, subject = `commit ${c}`): RebaseCommit => ({
  oid: c.repeat(40),
  subject,
  author: { name: "Ann", email: "ann@example.com", time: 1 },
});
// git order: a oldest … c newest
const commits = [commit("a"), commit("b"), commit("c")];

describe("initialPlan", () => {
  it("should list newest first with every action pick", () => {
    expect(initialPlan(commits).map((s) => [s.oid[0], s.action])).toEqual([
      ["c", "pick"],
      ["b", "pick"],
      ["a", "pick"],
    ]);
  });
});

describe("move", () => {
  it("should move a step down one place", () => {
    expect(move(initialPlan(commits), 0, 1).map((s) => s.oid[0])).toEqual(["b", "c", "a"]);
  });
  it("should move a step to the end", () => {
    expect(move(initialPlan(commits), 0, 2).map((s) => s.oid[0])).toEqual(["b", "a", "c"]);
  });
  it("should return the same array for an out-of-range target", () => {
    const steps = initialPlan(commits);
    expect(move(steps, 0, -1)).toBe(steps);
    expect(move(steps, 2, 3)).toBe(steps);
  });
  it("should not mutate the input", () => {
    /* … */
  });
});

describe("setAction", () => {
  it("should change one step's action and keep the others", () => {
    /* … */
  });
});

describe("foldBlocked", () => {
  it("should block squash on the oldest step", () => {
    const steps = setAction(initialPlan(commits), 2, "squash");
    expect(foldBlocked(steps, 2)).toBe(true);
    expect(foldBlocked(steps, 0)).toBe(false);
  });
  it("should block fixup on the oldest kept step when older steps are dropped", () => {
    const steps = setAction(setAction(initialPlan(commits), 2, "drop"), 1, "fixup");
    expect(foldBlocked(steps, 1)).toBe(true);
  });
  it("should not block a squash with a kept step below it", () => {
    expect(foldBlocked(setAction(initialPlan(commits), 1, "squash"), 1)).toBe(false);
  });
  it("should not block a dropped step", () => {
    /* drop on index 2 → false */
  });
});

describe("summary", () => {
  it("should count kept, squashed and dropped", () => {
    const steps = setAction(setAction(initialPlan(commits), 0, "squash"), 2, "drop");
    expect(summary(steps)).toEqual({ kept: 1, squashed: 1, dropped: 1 });
  });
  it("should count an edit as kept", () => {
    /* … kept 3 */
  });
  it("should count fixup as squashed", () => {
    /* … */
  });
});

describe("summaryText", () => {
  it("should use plurals", () => {
    expect(summaryText({ kept: 3, squashed: 2, dropped: 0 })).toBe(
      "3 commits, 2 squashed, 0 dropped",
    );
  });
  it("should use singulars", () => {
    expect(summaryText({ kept: 1, squashed: 1, dropped: 1 })).toBe(
      "1 commit, 1 squashed, 1 dropped",
    );
  });
});

describe("toSteps", () => {
  it("should emit oldest first with actions", () => {
    const steps = setAction(initialPlan(commits), 0, "drop");
    expect(toSteps(steps)).toEqual([
      { action: "pick", oid: "a".repeat(40) },
      { action: "pick", oid: "b".repeat(40) },
      { action: "drop", oid: "c".repeat(40) },
    ]);
  });
});

describe("canStart", () => {
  it("should be false when everything is dropped", () => {
    /* … */
  });
  it("should be false with a blocked fold", () => {
    /* … */
  });
  it("should be true for the initial plan", () => {
    /* … */
  });
  it("should be false for an empty plan", () => {
    expect(canStart([])).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing hook, row and dialog tests**

`useRebasePlan.test.tsx` (mock `rebasePlan` from `../../../lib/ipc`): resolves `commits` and `loading` false; maps a rejection through `toAppError` into `error`; uses `queryKeys.rebasePlan(repoId, base)` (`queryClient.getQueryData`); does not retry (`rebasePlan` called once after a failure).

`RebaseStepRow.test.tsx` (render with props from a `renderRow(over)` helper like `BranchRow.test.tsx`):

- renders the short oid, subject (with `title` = full subject), author name;
- the select has `aria-label="Action for {short}"` and the five options in order with the spec labels;
- changing the select calls `onAction("squash")`;
- `Move up` is disabled at index 0, `Move down` at `index === count - 1`; clicking calls `onMove(index ∓ 1)`;
- `blocked` renders `Cannot squash the oldest commit` with `role="alert"`; absent otherwise;
- a `drop` step has the `dropped` class (`data-dropped="true"` for a stable test hook); `squash`/`fixup` have `data-fold="true"`;
- `fireEvent.dragStart(li)` calls `onDragStart`; `fireEvent.dragOver(li)` calls `onDragOver` and `preventDefault` (`fireEvent.dragOver` returns false when default was prevented); `fireEvent.drop(li)` calls `onDrop`;
- `dragging` sets `aria-grabbed`-free visual class via `data-dragging`; `dropTarget` sets `data-drop-target`.

`RebaseDialog.test.tsx` (mock `rebasePlan`; pass `run = vi.fn()` and `pending`):

- `Loading commits…` with `role="status"` while pending;
- lists rows newest first under `Commits to rebase`, title `Rebase feature onto main interactively`;
- empty plan shows `Nothing to rebase: feature has no commits after main.` and no Start button;
- plan error `badSelection` shows `That commit is not on feature.`, `mergeCommit` shows the merge message, another kind shows its own message; only Cancel/Close remains;
- footer reads `3 commits, 0 squashed, 0 dropped` and updates after a select change;
- Move down then Start sends `run({ action: "rebaseInteractive", base: "main", steps: [oldest-first…] })` reflecting the new order;
- drag: `dragStart` on row 0, `dragOver` + `drop` on row 2 → order `b, a, c` (newest-first list shows c? Pin exact expectation from `move(steps, 0, 2)`);
- `blocks a squash that becomes the oldest kept step after a move`: drop the oldest row, set the middle row to squash → alert + Start disabled; move the squash row up → enabled again;
- Start disabled while `pending` and reads `Working…`; Escape and backdrop click call `onClose` unless pending;
- `run` resolving `null` calls `onClose`; resolving an error keeps the dialog open and shows `RepoError`; a refetch returning a different list resets the plan (change `rebasePlan`'s mock, `queryClient.invalidateQueries`, expect rows to follow and actions to reset).

`useIntegrationActions.test.tsx`: `rebaseInteractive` request calls `rebaseInteractive(4, "main", steps)` and invalidates `queryKeys.repo`.
`operationCopy.test.ts`: `stoppedForEdit: true` → `Rebasing feature onto main, step 2 of 3, stopped to edit, no conflicts remaining`; false → unchanged. `OperationBanner.test.tsx`: the banner shows the suffix.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- src/features/merge` → module not found for `rebase/…`, request union error.

- [ ] **Step 4: Implement `model/plan.ts`**

```ts
import type { RebaseAction, RebaseCommit, RebaseStep, Signature } from "../../../../lib/ipc";

export interface PlanStep {
  oid: string;
  subject: string;
  author: Signature;
  action: RebaseAction;
}

export const ACTIONS: readonly { action: RebaseAction; label: string }[] = [
  { action: "pick", label: "Pick — keep the commit" },
  { action: "squash", label: "Squash — fold into the commit above, keep both messages" },
  { action: "fixup", label: "Fixup — fold into the commit above, discard its message" },
  { action: "edit", label: "Edit — stop after applying it to amend" },
  { action: "drop", label: "Drop — leave the commit out" },
];

const isFold = (a: RebaseAction) => a === "squash" || a === "fixup";

/** Newest first, like the graph; every commit picked. */
export function initialPlan(commits: RebaseCommit[]): PlanStep[] {
  return commits.map((c) => ({ ...c, action: "pick" as const })).reverse();
}

/** The steps with the one at `from` moved to `to`; the same array when `to` is out of range. */
export function move(steps: PlanStep[], from: number, to: number): PlanStep[] {
  if (to < 0 || to >= steps.length || from === to) return steps;
  const next = steps.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function setAction(steps: PlanStep[], index: number, action: RebaseAction): PlanStep[] {
  return steps.map((s, i) => (i === index ? { ...s, action } : s));
}

/** The oldest kept step cannot fold into a commit above it: there is none. */
export function foldBlocked(steps: PlanStep[], index: number): boolean {
  if (!isFold(steps[index].action)) return false;
  return !steps.slice(index + 1).some((s) => s.action !== "drop");
}

export function summary(steps: PlanStep[]): { kept: number; squashed: number; dropped: number } {
  let kept = 0,
    squashed = 0,
    dropped = 0;
  for (const s of steps) {
    if (s.action === "drop") dropped += 1;
    else if (isFold(s.action)) squashed += 1;
    else kept += 1;
  }
  return { kept, squashed, dropped };
}

export function summaryText({ kept, squashed, dropped }: ReturnType<typeof summary>): string {
  return `${kept} ${kept === 1 ? "commit" : "commits"}, ${squashed} squashed, ${dropped} dropped`;
}

/** git's order: oldest first. */
export function toSteps(steps: PlanStep[]): RebaseStep[] {
  return steps.map(({ action, oid }) => ({ action, oid })).reverse();
}

export function canStart(steps: PlanStep[]): boolean {
  return summary(steps).kept > 0 && !steps.some((_, i) => foldBlocked(steps, i));
}
```

- [ ] **Step 5: Implement `useRebasePlan.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { rebasePlan, toAppError } from "../../../lib/ipc";
import type { AppError, RebaseCommit, RepoId } from "../../../lib/ipc";
import { queryKeys } from "../../../lib/query/keys";

/** The commits `git rebase -i base` would replay; refetched with the repo, never retried. */
export function useRebasePlan(repoId: RepoId, base: string) {
  const query = useQuery<RebaseCommit[], AppError>({
    queryKey: queryKeys.rebasePlan(repoId, base),
    queryFn: () =>
      rebasePlan(repoId, base).catch((e: unknown) => {
        throw toAppError(e);
      }),
    retry: false,
  });
  return { commits: query.data, error: query.error ?? null, loading: query.isPending };
}
```

- [ ] **Step 6: Implement `RebaseStepRow.tsx`**

```tsx
import type { DragEvent } from "react";
import type { RebaseAction } from "../../../lib/ipc";
import { shortOid } from "../../graph/model/layout";
import styles from "./RebaseStepRow.module.css";
import { ACTIONS, type PlanStep } from "./model/plan";

export interface RebaseStepRowProps {
  step: PlanStep;
  index: number;
  count: number;
  blocked: boolean;
  disabled: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onAction(action: RebaseAction): void;
  onMove(to: number): void;
  onDragStart(): void;
  onDragOver(): void;
  onDrop(): void;
}

export function RebaseStepRow({
  step,
  index,
  count,
  blocked,
  disabled,
  dragging,
  dropTarget,
  onAction,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
}: RebaseStepRowProps) {
  const short = shortOid(step.oid);
  const fold = step.action === "squash" || step.action === "fixup";
  const over = (e: DragEvent) => {
    e.preventDefault();
    onDragOver();
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    onDrop();
  };
  return (
    <li
      className={styles.row}
      draggable={!disabled}
      data-dropped={step.action === "drop" ? "true" : undefined}
      data-fold={fold ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-drop-target={dropTarget ? "true" : undefined}
      onDragStart={onDragStart}
      onDragOver={over}
      onDrop={drop}
    >
      <span className={styles.handle} aria-hidden="true">
        ⋮⋮
      </span>
      <select
        aria-label={`Action for ${short}`}
        value={step.action}
        disabled={disabled}
        onChange={(e) => onAction(e.target.value as RebaseAction)}
      >
        {ACTIONS.map(({ action, label }) => (
          <option key={action} value={action}>
            {label}
          </option>
        ))}
      </select>
      <code className={styles.oid}>{short}</code>
      <span className={styles.subject} title={step.subject}>
        {step.subject}
      </span>
      <span className={styles.author}>{step.author.name}</span>
      <button
        type="button"
        aria-label="Move up"
        disabled={disabled || index === 0}
        onClick={() => onMove(index - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Move down"
        disabled={disabled || index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        ↓
      </button>
      {blocked && (
        <p role="alert" className={styles.alert}>
          Cannot squash the oldest commit
        </p>
      )}
    </li>
  );
}
```

CSS: grid row (`handle select oid subject author up down`, alert spanning the full width), `[data-dropped] .subject { text-decoration: line-through; opacity: .6 }`, `[data-fold]` indents by 16px, `[data-dragging] { opacity: .5 }`, `[data-drop-target] { outline: 2px solid var(--color-accent); outline-offset: -2px }`, monospace `.oid`, muted `.author`, `.alert { color: var(--color-danger) }`. Tokens from `src/styles/tokens.css` only.

- [ ] **Step 7: Implement `RebaseDialog.tsx`**

```tsx
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { AppError, RebaseCommit, RepoId } from "../../../lib/ipc";
import { RepoError } from "../../repo/RepoError";
import type { UseIntegrationActions } from "../useIntegrationActions";
import styles from "./RebaseDialog.module.css";
import { RebaseStepRow } from "./RebaseStepRow";
import {
  canStart,
  foldBlocked,
  initialPlan,
  move,
  setAction,
  summary,
  summaryText,
  toSteps,
} from "./model/plan";
import { useRebasePlan } from "./useRebasePlan";

export interface RebaseDialogProps {
  repoId: RepoId;
  /** What git is given: a full oid or a branch name. */
  base: string;
  /** What the title shows for `base`. */
  label: string;
  /** The current branch name, for the title and messages. */
  head: string;
  run: UseIntegrationActions["run"];
  pending: boolean;
  onClose(): void;
}

function planMessage(error: AppError, head: string): string {
  if (error.kind === "badSelection") return `That commit is not on ${head}.`;
  if (error.kind === "mergeCommit")
    return "The range contains a merge commit, which cannot be rebased interactively yet.";
  return error.message;
}

/** The interactive rebase plan: rendered only while open, so its state starts fresh each time. */
export function RebaseDialog({
  repoId,
  base,
  label,
  head,
  run,
  pending,
  onClose,
}: RebaseDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const { commits, error, loading } = useRebasePlan(repoId, base);
  const showingPlan = !loading && error === null && (commits as RebaseCommit[]).length > 0;

  // Focus the first button (Cancel) on open and restore focus on close, as ConfirmDialog does.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement;
    (dialogRef.current as HTMLDivElement).querySelector("button")?.focus();
    return () => previous.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !pending) onClose();
  };
  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !pending) onClose();
  };

  let body: React.ReactNode;
  if (loading) body = <p role="status">Loading commits…</p>;
  else if (error !== null) body = <p className={styles.message}>{planMessage(error, head)}</p>;
  else if ((commits as RebaseCommit[]).length === 0)
    body = (
      <p
        className={styles.message}
      >{`Nothing to rebase: ${head} has no commits after ${label}.`}</p>
    );
  else
    body = (
      // Keyed by the commit list so a refetch that changes it resets the plan.
      <Plan
        key={(commits as RebaseCommit[]).map((c) => c.oid).join()}
        commits={commits as RebaseCommit[]}
        base={base}
        run={run}
        pending={pending}
        onClose={onClose}
      />
    );

  return (
    <div className={styles.backdrop} onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        onKeyDown={onKeyDown}
      >
        <h2
          id={titleId}
          className={styles.title}
        >{`Rebase ${head} onto ${label} interactively`}</h2>
        {body}
        {/* Plan renders its own actions row (Cancel + Start); the other states get Cancel alone. */}
        {!showingPlan && (
          <div className={styles.actions}>
            <button type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

`Plan` (same file, not exported): `const [steps, setSteps] = useState(() => initialPlan(commits))`, `const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null)`, `const [runError, setRunError] = useState<AppError | null>(null)`. Rows map to `RebaseStepRow` with `blocked={foldBlocked(steps, i)}`, `disabled={pending}`, `dragging={drag?.from === i}`, `dropTarget={drag?.over === i}`, `onAction={(a) => setSteps(setAction(steps, i, a))}`, `onMove={(to) => setSteps(move(steps, i, to))}`, `onDragStart={() => setDrag({ from: i, over: null })}`, `onDragOver={() => drag && setDrag({ ...drag, over: i })}`, `onDrop={() => { if (drag) setSteps(move(steps, drag.from, i)); setDrag(null); }}`; the `<ol aria-label="Commits to rebase">` also handles `onDragEnd={() => setDrag(null)}`. Footer `<p>{summaryText(summary(steps))}</p>`, `runError && <RepoError error={runError} path={null} onDismiss={() => setRunError(null)} />`, and the Start button: `disabled={!canStart(steps) || pending}`, text `pending ? "Working…" : "Start rebase"`, `onClick={() => void start()}` where `start` awaits `run({ action: "rebaseInteractive", base, steps: toSteps(steps) })` and calls `onClose()` on `null`, else `setRunError(e)`. `Plan` renders its own `.actions` row with Cancel (`onClose`) then Start, so every state has exactly one Cancel (the tests assert by role and name only).

CSS: copy the `ConfirmDialog.module.css` backdrop/dialog/title/actions rules into `RebaseDialog.module.css` with `max-width: 48rem`, `.list { list-style: none; margin: 0; padding: 0; max-height: 60vh; overflow: auto; display: flex; flex-direction: column; gap: 2px }`, `.message { margin: 0 }`, `.summary { margin: 0; color: var(--color-text-muted) }`.

- [ ] **Step 8: Integration request and banner copy**

`useIntegrationActions.ts`: add the union member and `case "rebaseInteractive": return rebaseInteractive(repoId, req.base, req.steps);` (import from `../../lib/ipc`). `operationCopy.ts` rebase title: append `${state.stoppedForEdit ? ", stopped to edit" : ""}` before returning.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -- src/features/merge && npm run lint && npm run typecheck`.

- [ ] **Step 10: Commit**

```bash
git add src/features/merge
git commit -m "feat(ui): GR-10c rebase dialog with plan model, step rows and edit-stop banner copy"
```

---

### Task 3: Entry points and drag-to-merge

**Files:**

- Modify: `src/features/graph/GraphPanel.tsx` (menu item + `rebase` dialog kind), `src/features/branches/BranchesPanel.tsx` (menu item, `rebase` dialog kind, drag state), `src/features/branches/BranchRow.tsx` (+ `.module.css`: `drag` prop)
- Test: `GraphPanel.test.tsx`, `BranchesPanel.test.tsx`, `BranchRow.test.tsx` (extend)

**Interfaces:**

- Consumes: Task 2's `RebaseDialog`, `IN_PROGRESS_TITLE`, `headName`, `shortOid`, `integrationItems`, `branchId`.
- Produces:

```ts
// BranchRow.tsx
export interface BranchDrag {
  draggable: boolean;
  target: boolean;
  over: boolean;
  onDragStart(): void;
  onDragEnd(): void;
  onDragEnter(): void;
  onDragLeave(): void;
  onDrop(x: number, y: number): void;
}
// BranchRowProps gains `drag?: BranchDrag`
```

- [ ] **Step 1: Write the failing tests**

`BranchRow.test.tsx`:

- without `drag` the `<li>` has no `draggable` attribute and no drag handlers fire anything;
- `drag.draggable` sets `draggable="true"`; `fireEvent.dragStart(li, { dataTransfer })` calls `onDragStart` and sets `effectAllowed = "move"` and `setData("text/plain", "<branchId>")` on a fake `dataTransfer` object (`{ setData: vi.fn(), effectAllowed: "", dropEffect: "" }`); `dragEnd` calls `onDragEnd`;
- `drag.target`: `dragEnter` calls `onDragEnter`; `dragLeave` calls `onDragLeave`; `fireEvent.dragOver` returns `false` (default prevented) and sets `dropEffect = "move"`; `fireEvent.drop(li, { clientX: 10, clientY: 20 })` calls `onDrop(10, 20)` and prevents default;
- not a target: `dragOver` returns `true` (not prevented) and `drop` does not call `onDrop`;
- `drag.over` adds `data-drop-over="true"`; dragging state is the panel's concern (no prop); the test for the dragged row's class uses `data-dragging` set by the panel via the same prop? No — keep the row ignorant: the panel passes `draggable: false` for the row being dragged? No. Simplest: row shows `data-drop-over` only; the dragged row's dimming comes from the `:active`-less CSS `[draggable="true"]:active`? Rule: dimming the dragged row is dropped from scope (the browser's drag image already shows it); only the target highlight is tested.

`BranchesPanel.test.tsx`:

- `Rebase main onto feature interactively…` item in the local `feature` row's menu (after `Rebase main onto feature`), disabled with `IN_PROGRESS_TITLE` during an operation and `Check out a branch first` when detached; selecting it opens a dialog titled `Rebase main onto feature interactively` (mock `rebasePlan` to resolve `[]` so the dialog shows the empty message — enough to prove wiring); the remote row's item reads `Rebase main onto origin/other interactively…`; Cancel closes it;
- drag-to-merge: with `main` current, the `feature` row `<li>` is `draggable="true"` and the `main` row is not; `dragStart` on `feature` then `dragEnter` on `main` sets `data-drop-over` on `main`; `drop` on `main` at `(5, 6)` opens the menu with exactly `Merge feature into main`, `Fast-forward main to feature`, `Rebase main onto feature` (no checkout/rename/delete items — assert the menu has three items); choosing `Merge feature into main` calls `integrationRun({ action: "merge", branch: "feature" })`; `dragEnd` without a drop clears `data-drop-over`;
- `ignores a drop on a non-current row`: `dragStart` on `feature`, `dragEnter`/`drop` on `origin/other` → no highlight, no menu;
- a remote row (`origin/other`) is draggable and its drop menu reads `Merge origin/other into main`;
- `disables dragging during an operation`: operation state `merge` → no row has `draggable="true"`; detached HEAD → same; `pending` true → same;
- the current row is a target only while dragging: without a prior `dragStart`, `dragOver` on `main` is not prevented.

`GraphPanel.test.tsx`:

- `Rebase interactively from here…` after `Revert commit`; disabled with `Already at HEAD` on the row with the `isHead` ref, `IN_PROGRESS_TITLE` during an operation, `Check out a branch first` when `branches.head.kind === "detached"`; selecting opens the dialog titled `Rebase main onto <short> interactively` with `rebasePlan` called with `(repoId, <full oid>)`; Cancel closes it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/features/branches src/features/graph`.

- [ ] **Step 3: Implement `BranchRow` drag support**

```tsx
export interface BranchDrag {
  draggable: boolean;
  target: boolean;
  over: boolean;
  onDragStart(): void;
  onDragEnd(): void;
  onDragEnter(): void;
  onDragLeave(): void;
  onDrop(x: number, y: number): void;
}
// in BranchRow, with `drag` destructured (optional):
const dragProps =
  drag === undefined
    ? {}
    : {
        draggable: drag.draggable || undefined,
        onDragStart: (e: DragEvent<HTMLLIElement>) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", branchId); // `${remote}/${name}` or name
          drag.onDragStart();
        },
        onDragEnd: drag.onDragEnd,
        onDragEnter: () => {
          if (drag.target) drag.onDragEnter();
        },
        onDragLeave: () => {
          if (drag.target) drag.onDragLeave();
        },
        onDragOver: (e: DragEvent<HTMLLIElement>) => {
          if (!drag.target) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        },
        onDrop: (e: DragEvent<HTMLLIElement>) => {
          if (!drag.target) return;
          e.preventDefault();
          drag.onDrop(e.clientX, e.clientY);
        },
        "data-drop-over": drag.over ? "true" : undefined,
      };
```

Spread `dragProps` on the `<li>`. CSS: `.item[data-drop-over] { outline: 2px solid var(--color-accent); outline-offset: -2px; }`. `dragEnter`/`dragLeave` bubble from children: track a depth counter in the panel (`enter` increments, `leave` decrements, `over = depth > 0`), so moving over the inner button does not flicker.

- [ ] **Step 4: Implement the panels**

`BranchesPanel.tsx`:

- `Dialog` gains `| { kind: "rebase"; base: string; label: string }`; the menu item after `rebase`:

```ts
{
  id: "rebaseInteractive",
  label: `Rebase ${cur} onto ${b} interactively…`,
  disabled: pending || gateTitle !== undefined,
  title: gateTitle,
  onSelect: () => openDialog({ kind: "rebase", base: b, label: b }),
},
```

- render `{dialog?.kind === "rebase" && <RebaseDialog repoId={repoId} base={dialog.base} label={dialog.label} head={headName(branches?.head)} run={integration.run} pending={integration.pending} onClose={closeDialog} />}`;
- drag state: `const [dragging, setDragging] = useState<BranchTarget | null>(null); const [overDepth, setOverDepth] = useState(0);`; `const canDrag = state?.kind === "none" && list.head.kind === "branch" && !pending;` in `renderList`; `row()` gains the `drag` prop:

```ts
drag: {
  draggable: canDrag && !current,
  target: current && dragging !== null,
  over: current && overDepth > 0,
  onDragStart: () => setDragging(target),
  onDragEnd: () => { setDragging(null); setOverDepth(0); },
  onDragEnter: () => setOverDepth((d) => d + 1),
  onDragLeave: () => setOverDepth((d) => Math.max(0, d - 1)),
  onDrop: (x, y) => {
    if (dragging !== null) setMenu({ x, y, target: dragging, dropMenu: true });
    setDragging(null);
    setOverDepth(0);
  },
}
```

- `MenuState` gains `dropMenu?: boolean`; `menuItems` returns `integrationItems(target, list.head)` alone when `dropMenu` is set (the existing menu for a remote/local row includes checkout etc.; the drop menu shows only the three integration items).

`GraphPanel.tsx`: `Dialog` gains `| { kind: "rebase"; oid: string }`; menu item after `revert`:

```ts
{
  id: "rebaseInteractive",
  label: "Rebase interactively from here…",
  disabled: pending || rebaseTitle !== undefined,
  title: rebaseTitle,
  onSelect: () => openDialog({ kind: "rebase", oid: row.oid }),
},
```

with `const rebaseTitle = state?.kind !== "none" ? IN_PROGRESS_TITLE : head?.kind !== "branch" ? "Check out a branch first" : atHead ? "Already at HEAD" : undefined;` (`head = branches?.head` is already computed below `menuItems`; hoist it above). Render `{dialog?.kind === "rebase" && <RebaseDialog repoId={repoId} base={dialog.oid} label={shortOid(dialog.oid)} head={headName(head)} run={integration.run} pending={integration.pending} onClose={closeDialog} />}`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run lint && npm run typecheck` (full suite: coverage must stay at 100 %).

- [ ] **Step 6: Commit**

```bash
git add src/features/branches src/features/graph
git commit -m "feat(ui): GR-10c rebase entry points and drag-to-merge on the current branch"
```

---

## Execution: batched agent cycles

| Cycle | Tasks               | architect + tdd-tester | developer | coverage + reviewer |
| ----- | ------------------- | ---------------------- | --------- | ------------------- |
| 1     | T1 (Rust + IPC)     | 1 + 1                  | 1         | 1 + 1               |
| 2     | T2 + T3 (front end) | 1 + 1                  | 1         | 1 + 1               |

Cycle 2's architect and tester may start once cycle 1's developer has committed (they need the IPC names, which Task 1's Interfaces block already fixes). Models: architect and developer `opus`; tester, coverage and reviewer `sonnet`. Final architect sign-off on the whole branch after cycle 2's review is clean.

## After the last task

- Verification gate: `cargo test --workspace`, clippy, fmt, `npm test` at 100 %, lint, typecheck, final architect approval.
- Acceptance walk in the running app (spec §6) with the WebKit inspector tooling from `walk10b/`.
- Merge `--no-ff` into `main`, delete the branch, post the Jira comment on GR-10 and transition the story to Done, update the memory note.
