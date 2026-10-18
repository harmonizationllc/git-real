# GR-7 Branch Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A resizable refs column on the left of the repo pane that lists local and remote branches with the current one highlighted, and lets the user create, switch, rename, delete and filter branches; the header's branch line goes live.

**Architecture:** `git-real-core` gains a `refs` module: git2 for listing (with upstream ahead/behind), create, rename, local delete and every pre-check; a shell-out to `git switch` for checkout and to `git push --delete` for remote deletion (ADR 0001). `git_cli` moves to the crate root. The Tauri app exposes seven commands. The front end adds `src/features/branches/`, a shared `PromptDialog`, a `SplitHandle` with a persisted `layoutPrefs` store and pure clamping maths, a single `useRepoChanged` subscription in `RepoPane`, and a three-column grid.

**Tech Stack:** Rust 2024 + git2 0.20 (`default-features = false`), `std::process::Command`, Tauri 2, React 19 + TypeScript, TanStack Query 5, Zustand 5 (`persist`), Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-18-gr7-branch-management-design.md`

## Global Constraints

- Tests first, by the test role; the developer role never edits test files (CLAUDE.md).
- The only module importing `@tauri-apps/api/*` is `src/lib/ipc` (ESLint-enforced).
- `git2` stays `default-features = false`; no direct `tokio` dependency; blocking work runs through `run_blocking`; `git-real-core` has no Tauri dependency.
- Checkout always shells out to `git switch`; remote delete always shells out to `git push <remote> --delete <name>`. git2 never checks out or pushes in product code.
- Child processes use `git_cli::command` (`LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, repo env removed) plus `-C <workdir>`; stdin null, stdout and stderr captured. Only validated names reach the command line.
- Branch name validation: `git2::Branch::name_is_valid(name) == Ok(true)` and `!name.starts_with('-')`. Remote names must resolve with `Repository::find_remote`.
- Unmerged: HEAD resolves to a commit `h`, branch tip `t`, `h != t` and `!graph_descendant_of(h, t)`; with an unborn HEAD every branch counts as unmerged.
- The session lock is held for checkout but **not** during the push.
- No new dependency in Rust or the front end.
- Serde: every new struct and enum is `rename_all = "camelCase"`; `HeadState` is `tag = "kind"`. Error kinds: `invalidBranchName`, `branchExists`, `branchNotFound`, `branchNotMerged`, `cannotDeleteCurrent`, `unbornHead`, `revisionNotFound`, `remoteNotFound`, `checkoutFailed`, `pushFailed`.
- Layout constants: `REFS_MIN = 160`, `SIDEBAR_MIN = 240`, `DETAIL_MIN = 320`, `REFS_DEFAULT = 240`, `SIDEBAR_DEFAULT = 320`, `KEY_STEP = 16`; store key `git-real.layoutPrefs`.
- Copy (verbatim): filter placeholder and label "Filter branches"; group headings "Local" and the remote name; empty copy "No branches" / "No matches"; detached row "Detached at <7 hex>"; unborn row "<name> (no commits yet)"; button "New branch…"; dialog titles "New branch", "New branch from <name>", "Rename <name>", "Delete branch <name>?", "Force delete <name>?", "Delete <remote>/<name> on <remote>?"; labels "Name", "New name"; checkbox "Switch to new branch"; confirm labels "Create", "Rename", "Delete", "Force delete", "Delete on <remote>"; bodies "The branch is merged into the current branch.", "<name> has commits that are not merged into the current branch. Deleting it loses them unless another ref points at them.", "This removes the branch from the remote for everyone."; menu items "Checkout", "Create branch here…", "Rename…", "Delete…", "Delete on <remote>…"; remote checkout title "Creates a local branch tracking <remote>/<name>"; disabled create title "Make a commit first"; pending confirm "Working…"; handle labels "Resize branches column", "Resize changes column"; app-layer fallbacks "git switch failed with exit code N", "git push failed with exit code N", "git switch was terminated by a signal", "git push was terminated by a signal".
- Gates: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `npm test` at 100 % coverage for `src/`, `npm run lint` (ESLint + `prettier --check .`, includes docs), `npm run typecheck`.

## Review Focus

1. A branch name that is valid for git but starts with `-` (git rejects `-x` already, but `--track` style names must never be built from user input): `validate_branch_name` rejects any leading `-` before git sees it (Task 1 test `create_rejects_leading_dash`).
2. A remote named `a/b` or a branch named `feature/x` on `origin`: splitting `origin/feature/x` on the first `/` would be wrong; `branch_remote_name` does the split (Task 1 test `remote_branch_with_slash_in_name_keeps_remote_and_name`).
3. Checking out a remote branch when a local branch of that short name already exists with a different upstream: must switch, not fail with "already exists" (Task 2 test `checkout_remote_switches_to_existing_local`).
4. Window narrower than the two columns plus the detail minimum: the stored widths stay, the displayed ones shrink sidebar first (Task 4 test `clampWidths shrinks the sidebar before the refs column`), and the grid template reflects the clamped values (Task 6 test `should use clamped widths after a resize observation`).
5. `delete` failing with `branchNotMerged` must not leave the first confirm dialog open with a stale error, and cancelling the force dialog must clear the error (Task 5 tests `should open the force-delete dialog on branchNotMerged` and `should clear the error when the force dialog is cancelled`).

---

### Task 1: Core — `git_cli` move, branch model, errors, git2 branch operations

**Files:**

- Move: `src-tauri/crates/git-real-core/src/remote/git_cli.rs` → `src-tauri/crates/git-real-core/src/git_cli.rs`
- Modify: `src-tauri/crates/git-real-core/src/lib.rs` (add `pub mod git_cli;`, `pub mod refs;`)
- Modify: `src-tauri/crates/git-real-core/src/remote/mod.rs` (drop `pub mod git_cli;`)
- Modify: `src-tauri/crates/git-real-core/src/remote/clone.rs`, `src/commit/mod.rs`, `src/commit/git_commit.rs` (`use crate::git_cli;`)
- Modify: `src-tauri/crates/git-real-core/tests/commit.rs`, `tests/clone.rs`, `tests/git_cli_command.rs`, `tests/remote_unit.rs` and `src-tauri/src/commands/repo.rs`, `src-tauri/tests/common/mod.rs` (import path `git_real_core::git_cli`)
- Create: `src-tauri/crates/git-real-core/src/model/branch.rs`
- Modify: `src-tauri/crates/git-real-core/src/model/mod.rs`
- Modify: `src-tauri/crates/git-real-core/src/error.rs`
- Create: `src-tauri/crates/git-real-core/src/refs/mod.rs`
- Test: `src-tauri/crates/git-real-core/tests/branches.rs`
- Test helper: `src-tauri/crates/git-real-core/tests/common/mod.rs` (add `commit_file`, `add_remote_and_fetch`)

**Interfaces:**

- Produces: `git_real_core::git_cli::{command, locate, locate_in}` (moved, unchanged); `git_real_core::{HeadState, Tracking, LocalBranch, RemoteBranch, RemoteGroup, BranchList}`; `RepoSession::{list_branches, create_branch, rename_branch, delete_branch}`; `git_real_core::refs::validate_branch_name(&str) -> Result<(), GitError>`; `GitError::{InvalidBranchName, BranchExists, BranchNotFound, BranchNotMerged, CannotDeleteCurrent, UnbornHead, RevisionNotFound, RemoteNotFound, CheckoutFailed, PushFailed}`.

- [ ] **Step 1: Move `git_cli` and fix imports**

`git mv src-tauri/crates/git-real-core/src/remote/git_cli.rs src-tauri/crates/git-real-core/src/git_cli.rs`. In `lib.rs` add `pub mod git_cli;` (alphabetical). Remove `pub mod git_cli;` from `remote/mod.rs`. Replace `use crate::remote::git_cli;` with `use crate::git_cli;` in `remote/clone.rs`, `commit/mod.rs`, `commit/git_commit.rs`; replace `git_real_core::remote::git_cli` with `git_real_core::git_cli` in the four core tests, `src-tauri/src/commands/repo.rs` (`use git_real_core::remote::clone::clone; use git_real_core::git_cli;`) and `src-tauri/tests/common/mod.rs`.

Run: `cd src-tauri && cargo test --workspace` → all green, no behaviour change. Commit: `refactor(core): move git_cli to the crate root`.

- [ ] **Step 2: Write the failing tests**

Add to `tests/common/mod.rs`:

```rust
/// Writes `name` with `content`, stages it and commits on HEAD; returns the new oid.
pub fn commit_file(path: &Path, name: &str, content: &str, message: &str) -> git2::Oid {
    let repo = Repository::open(path).expect("open");
    std::fs::write(path.join(name), content).expect("write");
    let mut index = repo.index().expect("index");
    index.add_path(Path::new(name)).expect("add");
    index.write().expect("write index");
    let tree = repo.find_tree(index.write_tree().expect("tree")).expect("find tree");
    let sig = Signature::now("Test User", "test@example.com").expect("sig");
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).expect("commit")
}

/// Adds `bare` as remote `origin`, fetches it over the local path (no network)
/// and sets `main`'s upstream to `origin/main`.
pub fn add_remote_and_fetch(path: &Path, bare: &Path) {
    let repo = Repository::open(path).expect("open");
    let mut remote = repo
        .remote("origin", bare.to_str().expect("utf-8"))
        .expect("add remote");
    remote
        .fetch(&["+refs/heads/*:refs/remotes/origin/*"], None, None)
        .expect("fetch");
    let mut main = repo.find_branch("main", git2::BranchType::Local).expect("main");
    main.set_upstream(Some("origin/main")).expect("upstream");
}
```

Note: `temp_repo_with_commit` commits on whatever `init.defaultBranch` libgit2 uses (`master` unless configured). Tests must not assume `main`: read the name from `list_branches().head`. Where a test needs a known name, create it with `create_branch`. Adjust `add_remote_and_fetch` to take the branch name as a parameter: `add_remote_and_fetch(path, bare, head_name)`.

`tests/branches.rs`:

```rust
mod common;

use git_real_core::refs::validate_branch_name;
use git_real_core::{GitError, HeadState, RepoSession};
use git2::{BranchType, Repository};

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session)
}

fn head_name(s: &RepoSession) -> String {
    match s.list_branches().unwrap().head {
        HeadState::Branch { name } => name,
        other => panic!("expected branch head, got {other:?}"),
    }
}

// --- list ---
#[test] fn list_fresh_repo_has_one_local_branch_as_head_and_no_remotes()
//   local.len()==1, local[0].is_head, local[0].name==head_name, local[0].tracking.is_none(), remotes.is_empty(), local[0].oid is 40 hex
#[test] fn list_sorts_local_branches_by_name()
//   create "zeta","alpha" → names == [alpha, head, zeta] in byte order (head name sorts where it falls; assert sorted())
#[test] fn list_remote_group_skips_origin_head_and_reports_tracking_zero()
//   bare clone, add_remote_and_fetch; remotes==[origin with exactly the head branch]; local head tracking == Some{upstream:"origin/<head>", ahead:Some(0), behind:Some(0)}
#[test] fn list_reports_ahead_and_behind()
//   after remote set up: commit_file locally → ahead Some(1) behind Some(0); then commit in a second clone of the bare and push (git2 push over file path) → fetch → behind Some(1)
#[test] fn list_reports_gone_upstream_with_none_counts()
//   set branch.<head>.remote=origin and branch.<head>.merge=refs/heads/nope via config → tracking Some{upstream:"origin/nope", ahead:None, behind:None}
#[test] fn list_detached_head()
//   repo.set_head_detached(oid) → head == Detached{oid}; no local branch is_head
#[test] fn list_unborn_head()
//   Repository::init fresh dir → head == Unborn{name} (name from HEAD symbolic target), local empty
#[test] fn remote_branch_with_slash_in_name_keeps_remote_and_name()
//   create local "feature/x", push to bare via git2 (refspec), fetch → RemoteBranch{remote:"origin", name:"feature/x"}
#[test] fn list_tolerates_non_utf8_branch_name()
//   write .git/refs/heads/<invalid bytes> file (unix only, OsStr from bytes) → list_branches is Ok and contains a lossy name

// --- validate ---
#[test] fn validate_accepts_plain_and_slashed_names()
#[test] fn validate_rejects_empty_space_dotdot_trailing_lock_and_leading_dash()
//   "", "a b", "a..b", "a.lock", "-x", "a/", "@{x}" → InvalidBranchName(name)

// --- create ---
#[test] fn create_from_head_points_at_head_commit_and_is_not_head()
#[test] fn create_from_branch_name_and_from_short_oid()
#[test] fn create_rejects_leading_dash()           // "-x" → InvalidBranchName
#[test] fn create_rejects_taken_name()             // BranchExists(name)
#[test] fn create_on_unborn_head_fails()           // UnbornHead
#[test] fn create_with_unknown_revision_fails()    // RevisionNotFound("nope")

// --- rename ---
#[test] fn rename_moves_branch_and_keeps_oid()
#[test] fn rename_current_branch_keeps_head_symbolic()  // HEAD symbolic_target == refs/heads/<new>
#[test] fn rename_rejects_taken_invalid_and_missing()   // BranchExists, InvalidBranchName, BranchNotFound

// --- delete ---
#[test] fn delete_merged_branch_without_force()
#[test] fn delete_unmerged_without_force_fails_and_keeps_branch()  // BranchNotMerged(name); find_branch still Ok
#[test] fn delete_unmerged_with_force()
#[test] fn delete_current_fails()                                 // CannotDeleteCurrent
#[test] fn delete_missing_fails()                                 // BranchNotFound
#[test] fn delete_on_unborn_head_counts_as_unmerged()             // init repo, write a ref by hand pointing at a commit from another repo is awkward: instead create repo, commit, create branch "b", then `repo.set_head("refs/heads/newborn")` (unborn symbolic) → delete("b", false) → BranchNotMerged; force → Ok
#[test] fn branch_with_slash_lists_and_deletes()
```

Write each test body fully (the comments above are the assertions to encode). Use `assert!(matches!(err, GitError::BranchNotMerged(n) if n == "b"))` style for kinds.

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test -p git-real-core --test branches` → compile errors (missing module/types).

- [ ] **Step 4: Implement**

`model/branch.rs`:

```rust
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeadState {
    Branch { name: String },
    Detached { oid: String },
    Unborn { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracking { pub upstream: String, pub ahead: Option<u32>, pub behind: Option<u32> }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch { pub name: String, pub oid: String, pub is_head: bool, pub tracking: Option<Tracking> }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch { pub remote: String, pub name: String, pub oid: String }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGroup { pub remote: String, pub branches: Vec<RemoteBranch> }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList { pub head: HeadState, pub local: Vec<LocalBranch>, pub remotes: Vec<RemoteGroup> }
```

Re-export all six from `model/mod.rs`.

`error.rs` additions:

```rust
#[error("{0} is not a valid branch name")]
InvalidBranchName(String),
#[error("a branch named {0} already exists")]
BranchExists(String),
#[error("no branch named {0}")]
BranchNotFound(String),
#[error("{0} is not fully merged")]
BranchNotMerged(String),
#[error("cannot delete the current branch {0}")]
CannotDeleteCurrent(String),
#[error("the repository has no commits yet")]
UnbornHead,
#[error("{0} is not a known revision")]
RevisionNotFound(String),
#[error("no remote named {0}")]
RemoteNotFound(String),
#[error("git switch failed (exit code {code:?}): {stderr}")]
CheckoutFailed { code: Option<i32>, stdout: String, stderr: String },
#[error("git push failed (exit code {code:?}): {stderr}")]
PushFailed { code: Option<i32>, stdout: String, stderr: String },
```

`refs/mod.rs`:

```rust
//! Branch listing and local branch operations through git2; checkout and
//! remote deletion shell out (see `switch` and `remote::push_delete`).

use git2::{Branch, BranchType, ErrorCode, Repository};

use crate::error::GitError;
use crate::model::{BranchList, HeadState, LocalBranch, RemoteBranch, RemoteGroup, Tracking};
use crate::repo::RepoSession;

/// Valid for git and never readable as a command-line flag.
pub fn validate_branch_name(name: &str) -> Result<(), GitError> {
    match Branch::name_is_valid(name) {
        Ok(true) if !name.starts_with('-') => Ok(()),
        Ok(_) => Err(GitError::InvalidBranchName(name.to_owned())),
        Err(e) => Err(e.into()),
    }
}

fn is_not_found(e: &git2::Error) -> bool { e.code() == ErrorCode::NotFound }

fn lossy_name(branch: &Branch) -> String {
    String::from_utf8_lossy(branch.name_bytes().unwrap_or_default()).into_owned()
}

fn head_state(repo: &Repository) -> Result<HeadState, GitError> {
    match repo.head() {
        Ok(head) if head.is_branch() => Ok(HeadState::Branch {
            name: String::from_utf8_lossy(head.shorthand_bytes()).into_owned(),
        }),
        Ok(head) => Ok(HeadState::Detached { oid: head.target().map(|o| o.to_string()).unwrap_or_default() }),
        Err(e) if e.code() == ErrorCode::UnbornBranch => {
            let name = repo.find_reference("HEAD")?.symbolic_target()
                .and_then(|t| t.strip_prefix("refs/heads/")).unwrap_or("").to_owned();
            Ok(HeadState::Unborn { name })
        }
        Err(e) => Err(e.into()),
    }
}

fn tracking(repo: &Repository, branch: &Branch) -> Result<Option<Tracking>, GitError> {
    let Some(refname) = branch.get().name() else { return Ok(None) };
    let upstream_ref = match repo.branch_upstream_name(refname) {
        Ok(buf) => buf.as_str().map(str::to_owned),
        Err(e) if is_not_found(&e) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let Some(upstream_ref) = upstream_ref else { return Ok(None) };
    let upstream = upstream_ref.strip_prefix("refs/remotes/").unwrap_or(&upstream_ref).to_owned();
    match branch.upstream() {
        Ok(up) => {
            let (ahead, behind) = match (branch.get().target(), up.get().target()) {
                (Some(l), Some(u)) => repo.graph_ahead_behind(l, u)?,
                _ => (0, 0),
            };
            Ok(Some(Tracking { upstream, ahead: Some(ahead as u32), behind: Some(behind as u32) }))
        }
        Err(e) if is_not_found(&e) => Ok(Some(Tracking { upstream, ahead: None, behind: None })),
        Err(e) => Err(e.into()),
    }
}

impl RepoSession {
    pub fn list_branches(&self) -> Result<BranchList, GitError> {
        let repo = self.repo();
        let head = head_state(repo)?;
        let mut local = Vec::new();
        for item in repo.branches(Some(BranchType::Local))? {
            let (branch, _) = item?;
            local.push(LocalBranch {
                name: lossy_name(&branch),
                oid: branch.get().target().map(|o| o.to_string()).unwrap_or_default(),
                is_head: branch.is_head(),
                tracking: tracking(repo, &branch)?,
            });
        }
        local.sort_by(|a, b| a.name.cmp(&b.name));

        let mut groups: Vec<RemoteGroup> = Vec::new();
        for item in repo.branches(Some(BranchType::Remote))? {
            let (branch, _) = item?;
            if branch.get().symbolic_target_bytes().is_some() { continue; } // origin/HEAD
            let Some(refname) = branch.get().name() else { continue };
            let remote = match repo.branch_remote_name(refname) {
                Ok(buf) => buf.as_str().unwrap_or_default().to_owned(),
                Err(e) if is_not_found(&e) => continue,
                Err(e) => return Err(e.into()),
            };
            let full = lossy_name(&branch);
            let name = full.strip_prefix(&format!("{remote}/")).unwrap_or(&full).to_owned();
            let entry = RemoteBranch { remote: remote.clone(), name, oid: branch.get().target().map(|o| o.to_string()).unwrap_or_default() };
            match groups.iter_mut().find(|g| g.remote == remote) {
                Some(g) => g.branches.push(entry),
                None => groups.push(RemoteGroup { remote, branches: vec![entry] }),
            }
        }
        groups.sort_by(|a, b| a.remote.cmp(&b.remote));
        for g in &mut groups { g.branches.sort_by(|a, b| a.name.cmp(&b.name)); }
        Ok(BranchList { head, local, remotes: groups })
    }

    pub fn create_branch(&self, name: &str, start_point: Option<&str>) -> Result<LocalBranch, GitError> {
        validate_branch_name(name)?;
        let repo = self.repo();
        if repo.find_branch(name, BranchType::Local).is_ok() {
            return Err(GitError::BranchExists(name.to_owned()));
        }
        let commit = match start_point {
            None => match repo.head() {
                Ok(h) => h.peel_to_commit()?,
                Err(e) if e.code() == ErrorCode::UnbornBranch => return Err(GitError::UnbornHead),
                Err(e) => return Err(e.into()),
            },
            Some(spec) => match repo.revparse_single(spec) {
                Ok(obj) => obj.peel_to_commit()?,
                Err(e) if is_not_found(&e) => return Err(GitError::RevisionNotFound(spec.to_owned())),
                Err(e) => return Err(e.into()),
            },
        };
        let branch = repo.branch(name, &commit, false)?;
        Ok(LocalBranch { name: lossy_name(&branch), oid: commit.id().to_string(), is_head: false, tracking: None })
    }

    pub fn rename_branch(&self, old: &str, new: &str) -> Result<(), GitError> {
        validate_branch_name(new)?;
        let repo = self.repo();
        let mut branch = find_local(repo, old)?;
        if repo.find_branch(new, BranchType::Local).is_ok() {
            return Err(GitError::BranchExists(new.to_owned()));
        }
        branch.rename(new, false)?;
        Ok(())
    }

    pub fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError> {
        let repo = self.repo();
        let mut branch = find_local(repo, name)?;
        if branch.is_head() {
            return Err(GitError::CannotDeleteCurrent(name.to_owned()));
        }
        if !force && !self.is_merged_into_head(&branch)? {
            return Err(GitError::BranchNotMerged(name.to_owned()));
        }
        branch.delete()?;
        Ok(())
    }

    fn is_merged_into_head(&self, branch: &Branch) -> Result<bool, GitError> {
        let repo = self.repo();
        let head = match repo.head() {
            Ok(h) => h.target(),
            Err(e) if e.code() == ErrorCode::UnbornBranch => None,
            Err(e) => return Err(e.into()),
        };
        let (Some(head), Some(tip)) = (head, branch.get().target()) else { return Ok(false) };
        Ok(head == tip || repo.graph_descendant_of(head, tip)?)
    }
}

fn find_local<'r>(repo: &'r Repository, name: &str) -> Result<Branch<'r>, GitError> {
    match repo.find_branch(name, BranchType::Local) {
        Ok(b) => Ok(b),
        Err(e) if is_not_found(&e) => Err(GitError::BranchNotFound(name.to_owned())),
        Err(e) => Err(e.into()),
    }
}
```

Add `pub mod refs;` to `lib.rs`. The `commit` module's private `is_unborn` helper may be reused if visible; otherwise match on `ErrorCode::UnbornBranch` as above.

- [ ] **Step 5: Run tests, clippy, commit**

Run: `cd src-tauri && cargo test -p git-real-core && cargo clippy --workspace -- -D warnings`. Expected: green. Commit: `feat(core): branch model and git2 branch operations`.

---

### Task 2: Core — `git switch` and `git push --delete` shell-outs

**Files:**

- Create: `src-tauri/crates/git-real-core/src/refs/switch.rs`
- Create: `src-tauri/crates/git-real-core/src/remote/push_delete.rs`
- Modify: `src-tauri/crates/git-real-core/src/refs/mod.rs` (`pub mod switch;` + three methods)
- Modify: `src-tauri/crates/git-real-core/src/remote/mod.rs` (`pub mod push_delete;`)
- Test: `src-tauri/crates/git-real-core/tests/switch.rs`, `tests/push_delete.rs`

**Interfaces:**

- Consumes: Task 1 (`validate_branch_name`, `find_local`, errors, `git_cli`).
- Produces:

```rust
// refs/switch.rs
pub enum SwitchTarget<'a> { Local(&'a str), NewTracking { name: &'a str, upstream: &'a str } }
pub fn run(git: &Path, workdir: &Path, target: SwitchTarget<'_>) -> Result<(), GitError>;

// remote/push_delete.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushDelete { pub git: PathBuf, pub workdir: PathBuf, pub remote: String, pub name: String }
impl PushDelete { pub fn run(&self) -> Result<(), GitError>; }

// impl RepoSession
pub fn checkout_branch(&self, name: &str) -> Result<(), GitError>;
pub fn checkout_remote_branch(&self, remote: &str, name: &str) -> Result<(), GitError>;
/// Validates and returns the push to run after the session lock is released.
pub fn prepare_remote_delete(&self, remote: &str, name: &str) -> Result<PushDelete, GitError>;
```

- [ ] **Step 1: Write the failing tests**

`tests/switch.rs` (every test returns early when `git_cli::locate()` fails, as `commit.rs` does):

```rust
#[test] fn checkout_local_moves_head()
//   create "b" from HEAD; checkout_branch("b"); HEAD symbolic == refs/heads/b
#[test] fn checkout_current_branch_is_ok()
#[test] fn checkout_missing_branch_fails_before_git()        // BranchNotFound; works even with fake git absent? no — just assert kind
#[test] fn checkout_with_conflicting_dirty_file_fails_and_keeps_head()
//   create "b", on "b" commit README.md change (commit_file), switch back to head; dirty README.md in worktree; checkout_branch("b") → CheckoutFailed{stderr contains "overwritten"}; HEAD unchanged
#[test] fn checkout_runs_post_checkout_hook()
//   write .git/hooks/post-checkout: "#!/bin/sh\ntouch \"$(git rev-parse --show-toplevel)/hook-ran\"\n" chmod 755; set core.hooksPath unset; checkout → hook-ran exists (unix only)
#[test] fn checkout_remote_creates_tracking_branch()
//   bare + add_remote_and_fetch; create local "feature", push via git2 to bare, delete local "feature" (force); checkout_remote_branch("origin","feature") → local "feature" exists, branch.feature.remote == "origin", HEAD on feature
#[test] fn checkout_remote_switches_to_existing_local()
//   same setup but keep local "feature" with upstream unset; checkout_remote_branch → HEAD on feature; branch.feature.remote config NotFound (nothing created/changed)
#[test] fn checkout_remote_unknown_remote_and_branch()      // RemoteNotFound("nope"), BranchNotFound("origin/nope")
#[test] fn checkout_rejects_invalid_name()                    // InvalidBranchName
```

`tests/push_delete.rs` (skips without git):

```rust
#[test] fn prepare_validates_remote_and_branch()
//   RemoteNotFound, BranchNotFound("origin/nope"), InvalidBranchName("-x"); Ok returns PushDelete with workdir == session path, remote, name
#[test] fn run_deletes_branch_on_bare_remote_and_tracking_ref()
//   create "feature", push to bare, fetch; prepare_remote_delete("origin","feature").run() → bare has no refs/heads/feature; local repo has no refs/remotes/origin/feature
#[test] fn run_reports_push_failure_verbatim()
//   delete the branch in the bare repo directly first, then run → PushFailed{stderr non-empty, code Some(1)}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real-core --test switch --test push_delete` → compile errors.

- [ ] **Step 3: Implement**

`refs/switch.rs`:

```rust
//! Switching branches through the system `git` CLI so hooks, submodules and
//! git's safety checks behave exactly as on the command line (ADR 0001).

use std::path::Path;
use std::process::Stdio;

use crate::error::GitError;
use crate::git_cli;

pub enum SwitchTarget<'a> {
    Local(&'a str),
    NewTracking { name: &'a str, upstream: &'a str },
}

pub fn run(git: &Path, workdir: &Path, target: SwitchTarget<'_>) -> Result<(), GitError> {
    let mut cmd = git_cli::command(git);
    cmd.arg("-C").arg(workdir).arg("switch");
    match target {
        SwitchTarget::Local(name) => { cmd.arg(name); }
        SwitchTarget::NewTracking { name, upstream } => { cmd.args(["-c", name, "--track", upstream]); }
    }
    let output = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output()?;
    if !output.status.success() {
        return Err(GitError::CheckoutFailed {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}
```

`remote/push_delete.rs`: same shape, `args(["push"]).arg(&self.remote).arg("--delete").arg(&self.name)`, error `PushFailed`.

`refs/mod.rs` additions:

```rust
pub mod switch;
use crate::remote::push_delete::PushDelete;
use crate::git_cli;

impl RepoSession {
    pub fn checkout_branch(&self, name: &str) -> Result<(), GitError> {
        validate_branch_name(name)?;
        find_local(self.repo(), name)?;
        let git = git_cli::locate()?;
        switch::run(&git, self.workdir()?, switch::SwitchTarget::Local(name))
    }

    pub fn checkout_remote_branch(&self, remote: &str, name: &str) -> Result<(), GitError> {
        let upstream = self.remote_ref(remote, name)?;
        let git = git_cli::locate()?;
        let workdir = self.workdir()?;
        if self.repo().find_branch(name, BranchType::Local).is_ok() {
            switch::run(&git, workdir, switch::SwitchTarget::Local(name))
        } else {
            switch::run(&git, workdir, switch::SwitchTarget::NewTracking { name, upstream: &upstream })
        }
    }

    pub fn prepare_remote_delete(&self, remote: &str, name: &str) -> Result<PushDelete, GitError> {
        self.remote_ref(remote, name)?;
        Ok(PushDelete { git: git_cli::locate()?, workdir: self.workdir()?.to_path_buf(), remote: remote.to_owned(), name: name.to_owned() })
    }

    /// Validates `name`, checks the remote exists and `remote/name` is a remote branch; returns "remote/name".
    fn remote_ref(&self, remote: &str, name: &str) -> Result<String, GitError> {
        validate_branch_name(name)?;
        let repo = self.repo();
        match repo.find_remote(remote) {
            Ok(_) => {}
            Err(e) if is_not_found(&e) => return Err(GitError::RemoteNotFound(remote.to_owned())),
            Err(e) => return Err(e.into()),
        }
        let full = format!("{remote}/{name}");
        match repo.find_branch(&full, BranchType::Remote) {
            Ok(_) => Ok(full),
            Err(e) if is_not_found(&e) => Err(GitError::BranchNotFound(full)),
            Err(e) => Err(e.into()),
        }
    }
}
```

- [ ] **Step 4: Run, clippy, commit** — `cargo test -p git-real-core && cargo clippy --workspace -- -D warnings`; commit `feat(core): checkout via git switch and remote branch deletion via git push`.

---

### Task 3: Tauri app — error kinds and `refs` commands

**Files:**

- Modify: `src-tauri/src/error.rs`
- Create: `src-tauri/src/commands/refs.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`pub mod refs;`), `src-tauri/src/lib.rs` (register seven commands)
- Test: `src-tauri/tests/refs_commands.rs`, additions to `src-tauri/tests/error.rs`

**Interfaces:**

- Consumes: Tasks 1–2.
- Produces: commands `list_branches(id)`, `create_branch(id, name, startPoint, checkout)`, `rename_branch(id, oldName, newName)`, `delete_branch(id, name, force)`, `checkout_branch(id, name)`, `checkout_remote_branch(id, remote, name)`, `delete_remote_branch(id, remote, name)` and their `_inner` functions `(reg: &RepoRegistry, id: RepoId, ...)`.

- [ ] **Step 1: Write the failing tests**

`tests/error.rs` additions: `app_error_kind_for_each_git_error_variant` gains the ten new variants; `new_kinds_serialize_camel_case` covers `invalidBranchName` … `pushFailed`; `checkout_failed_message_prefers_stderr_then_stdout_then_exit_code_or_signal` and the same for `push_failed` with the exact fallback strings "git switch failed with exit code 128", "git push was terminated by a signal".

`tests/refs_commands.rs`:

```rust
#[test] fn list_branches_inner_returns_head_and_local()
#[test] fn create_branch_inner_without_checkout_keeps_head()
#[test] fn create_branch_inner_with_checkout_moves_head()        // skip without git
#[test] fn rename_and_delete_inner()
#[test] fn delete_branch_inner_maps_not_merged()                 // kind BranchNotMerged, then force Ok
#[test] fn unknown_repo_id_maps_for_every_command()               // UnknownRepo for all seven inners
#[test] fn delete_remote_branch_inner_releases_lock_and_deletes() // skip without git; bare remote; afterwards list_branches shows no origin/feature
#[test] fn delete_remote_branch_inner_maps_remote_not_found()
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real --test refs_commands --test error` → compile errors.

- [ ] **Step 3: Implement**

`error.rs`: add the ten variants to `AppErrorKind` and the `From` match; replace `commit_failure_message` with

```rust
/// Hook and git output is what the user needs to read, so it is kept whole:
/// stderr first, then stdout, then a generic exit-status line naming the verb.
fn cli_failure_message(verb: &str, code: Option<i32>, stdout: &str, stderr: &str) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() { return stderr.to_string(); }
    let stdout = stdout.trim();
    if !stdout.is_empty() { return stdout.to_string(); }
    match code {
        Some(c) => format!("git {verb} failed with exit code {c}"),
        None => format!("git {verb} was terminated by a signal"),
    }
}
```

used with `"commit"`, `"switch"`, `"push"`.

`commands/refs.rs`:

```rust
//! Branch commands: list, create, rename, delete, checkout, remote delete.

use std::sync::Arc;

use git_real_core::{BranchList, LocalBranch};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

pub fn list_branches_inner(reg: &RepoRegistry, id: RepoId) -> Result<BranchList, AppError> {
    with_session(reg, id, |s| s.list_branches())
}

pub fn create_branch_inner(reg: &RepoRegistry, id: RepoId, name: &str, start_point: Option<&str>, checkout: bool) -> Result<LocalBranch, AppError> {
    with_session(reg, id, |s| {
        let branch = s.create_branch(name, start_point)?;
        if checkout { s.checkout_branch(name)?; }
        Ok(branch)
    })
}

pub fn rename_branch_inner(reg: &RepoRegistry, id: RepoId, old_name: &str, new_name: &str) -> Result<(), AppError> {
    with_session(reg, id, |s| s.rename_branch(old_name, new_name))
}

pub fn delete_branch_inner(reg: &RepoRegistry, id: RepoId, name: &str, force: bool) -> Result<(), AppError> {
    with_session(reg, id, |s| s.delete_branch(name, force))
}

pub fn checkout_branch_inner(reg: &RepoRegistry, id: RepoId, name: &str) -> Result<(), AppError> {
    with_session(reg, id, |s| s.checkout_branch(name))
}

pub fn checkout_remote_branch_inner(reg: &RepoRegistry, id: RepoId, remote: &str, name: &str) -> Result<(), AppError> {
    with_session(reg, id, |s| s.checkout_remote_branch(remote, name))
}

/// Validates under the session lock, then pushes with the lock released so a
/// slow network call never blocks status refreshes.
pub fn delete_remote_branch_inner(reg: &RepoRegistry, id: RepoId, remote: &str, name: &str) -> Result<(), AppError> {
    let push = with_session(reg, id, |s| s.prepare_remote_delete(remote, name))?;
    push.run().map_err(AppError::from)
}

#[tauri::command]
pub async fn list_branches(reg: State<'_, Arc<RepoRegistry>>, id: RepoId) -> Result<BranchList, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || list_branches_inner(&reg, id)).await
}

#[tauri::command]
pub async fn create_branch(reg: State<'_, Arc<RepoRegistry>>, id: RepoId, name: String, start_point: Option<String>, checkout: bool) -> Result<LocalBranch, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || create_branch_inner(&reg, id, &name, start_point.as_deref(), checkout)).await
}
// rename_branch(id, old_name, new_name), delete_branch(id, name, force), checkout_branch(id, name),
// checkout_remote_branch(id, remote, name), delete_remote_branch(id, remote, name): same wrapper shape.
```

Tauri maps `start_point` ↔ `startPoint`, `old_name` ↔ `oldName`, `new_name` ↔ `newName` automatically (camelCase args).

Register all seven in `lib.rs` after `commands::commit::commit`.

- [ ] **Step 4: Run, clippy, commit** — `cargo test --workspace && cargo clippy --workspace -- -D warnings`; commit `feat(app): branch commands and error kinds`.

---

### Task 4: Front end foundations — IPC seam, keys, `useRepoChanged`, layout maths, `layoutPrefs`, `SplitHandle`, `PromptDialog`

**Files:**

- Modify: `src/lib/ipc/types.ts`, `src/lib/ipc/errors.ts`, `src/lib/ipc/commands.ts`, `src/lib/query/keys.ts`
- Create: `src/lib/query/useRepoChanged.ts`
- Modify: `src/features/worktree/useStatus.ts` (remove the subscription effect and the `useQueryClient`/`useEffect`/`onRepoChanged` imports)
- Create: `src/lib/store/layoutPrefs.ts`, `src/app/layout.ts`, `src/components/SplitHandle.tsx` + `.module.css`, `src/components/PromptDialog.tsx` + `.module.css`
- Test: `src/lib/ipc/commands.test.ts` and `errors.test.ts` and `types.test.ts` (extend), `src/lib/query/keys.test.ts` (extend), `src/lib/query/useRepoChanged.test.tsx`, `src/features/worktree/useStatus.test.tsx` (remove the subscription, robustness-subscription and multi-repo-isolation cases; keep query cases), `src/lib/store/layoutPrefs.test.ts`, `src/app/layout.test.ts`, `src/components/SplitHandle.test.tsx`, `src/components/PromptDialog.test.tsx`

**Interfaces:**

- Produces:

```ts
// types.ts
export type HeadState =
  | { kind: "branch"; name: string }
  | { kind: "detached"; oid: string }
  | { kind: "unborn"; name: string };
export interface Tracking { upstream: string; ahead: number | null; behind: number | null }
export interface LocalBranch { name: string; oid: string; isHead: boolean; tracking: Tracking | null }
export interface RemoteBranch { remote: string; name: string; oid: string }
export interface RemoteGroup { remote: string; branches: RemoteBranch[] }
export interface BranchList { head: HeadState; local: LocalBranch[]; remotes: RemoteGroup[] }
// AppErrorKind adds the ten kinds.

// commands.ts
listBranches(id): Promise<BranchList>                                   // invoke("list_branches", { id })
createBranch(id, name, startPoint: string | null, checkout: boolean): Promise<LocalBranch>  // { id, name, startPoint, checkout }
renameBranch(id, oldName, newName): Promise<void>                        // { id, oldName, newName }
deleteBranch(id, name, force: boolean): Promise<void>                    // { id, name, force }
checkoutBranch(id, name): Promise<void>                                  // { id, name }
checkoutRemoteBranch(id, remote, name): Promise<void>                    // { id, remote, name }
deleteRemoteBranch(id, remote, name): Promise<void>                      // { id, remote, name }

// keys.ts
branches: (id: RepoId) => ["repo", id, "branches"] as const

// useRepoChanged.ts
export function useRepoChanged(repoId: RepoId): void   // the effect body now in useStatus, verbatim

// layoutPrefs.ts
export const useLayoutPrefs = create<LayoutPrefsState>()(persist(..., { name: "git-real.layoutPrefs", partialize: (s) => ({ refsWidth: s.refsWidth, sidebarWidth: s.sidebarWidth }) }))
interface LayoutPrefsState { refsWidth: number; sidebarWidth: number; setRefsWidth(px: number): void; setSidebarWidth(px: number): void; reset(column: "refs" | "sidebar"): void }

// layout.ts
export const REFS_MIN = 160, SIDEBAR_MIN = 240, DETAIL_MIN = 320, REFS_DEFAULT = 240, SIDEBAR_DEFAULT = 320, KEY_STEP = 16;
export function clampWidths(container: number, refs: number, sidebar: number): { refs: number; sidebar: number };
export function maxWidth(container: number, column: "refs" | "sidebar", other: number): number;

// SplitHandle.tsx
export interface SplitHandleProps { label: string; value: number; min: number; max: number; onChange(px: number): void; onReset(): void }

// PromptDialog.tsx
export interface PromptDialogProps { open: boolean; title: string; label: string; initialValue?: string; confirmLabel?: string; checkbox?: { label: string; checked: boolean; onChange(on: boolean): void }; error: AppError | null; pending: boolean; onConfirm(value: string): void; onCancel(): void }
```

- [ ] **Step 1: Write the failing tests**

`layout.test.ts`:

```ts
it("passes widths through when the container is unmeasured", () =>
  expect(clampWidths(0, 240, 320)).toEqual({ refs: 240, sidebar: 320 }));
it("keeps widths that fit", () =>
  expect(clampWidths(1200, 240, 320)).toEqual({ refs: 240, sidebar: 320 }));
it("shrinks the sidebar before the refs column", () =>
  expect(clampWidths(860, 240, 320)).toEqual({ refs: 240, sidebar: 300 }));
it("shrinks the refs column once the sidebar is at its minimum", () =>
  expect(clampWidths(760, 240, 320)).toEqual({ refs: 200, sidebar: 240 }));
it("never goes below the minimums", () =>
  expect(clampWidths(100, 240, 320)).toEqual({ refs: 160, sidebar: 240 }));
it("raises widths below the minimums", () =>
  expect(clampWidths(1200, 10, 10)).toEqual({ refs: 160, sidebar: 240 }));
it("maxWidth leaves room for the other column and the detail minimum", () => {
  expect(maxWidth(1200, "refs", 320)).toBe(560);
  expect(maxWidth(1200, "sidebar", 240)).toBe(640);
});
it("maxWidth is never below the column minimum", () =>
  expect(maxWidth(300, "refs", 320)).toBe(160));
it("maxWidth is unbounded when unmeasured", () => expect(maxWidth(0, "refs", 320)).toBe(Infinity));
```

`layoutPrefs.test.ts`: defaults 240/320; setters; `reset("refs")` → 240 and `reset("sidebar")` → 320; `persist.getOptions().name === "git-real.layoutPrefs"`; partialize drops functions (mirror `diffPrefs.test.ts`).

`SplitHandle.test.tsx`: renders `role="separator"` with `aria-orientation="vertical"`, `aria-label`, `aria-valuenow/min/max`; `ArrowRight` calls `onChange(value + 16)`, `ArrowLeft` `value - 16`, `Home` → `min`, `End` → `max`, clamped at both ends; pointer: `pointerdown` at clientX 100 then `pointermove` at 130 → `onChange(value + 30)`, move past max → `onChange(max)`; `setPointerCapture`/`releasePointerCapture` called (stub them on the element since happy-dom lacks them); `pointermove` without a prior `pointerdown` does nothing; double-click → `onReset`.

`PromptDialog.test.tsx`: nothing rendered when closed; `role="dialog"` with `aria-labelledby` title; input has the label and the initial value, is focused and its text selected on open (`selectionStart 0`, `selectionEnd length`); confirm disabled when the trimmed value is empty; Enter submits with the trimmed value; Escape and backdrop click call `onCancel`; checkbox renders and calls `onChange`; `error` renders in a `role="alert"`; `pending` disables input, checkbox and confirm and the confirm reads "Working…"; focus returns to the previously focused element on close.

`useRepoChanged.test.tsx`: move the seven subscription tests and the four multi-repo/robustness subscription tests from `useStatus.test.tsx`, re-targeted at `renderHookWithProviders(() => useRepoChanged(id))` and asserting through `queryClient.invalidateQueries` spies / `getQueryState(...).isInvalidated`. `useStatus.test.tsx` keeps only the "query" describe plus `refetchOnWindowFocus`.

IPC tests: extend `commands.test.ts` with the seven invoke shapes (names and argument objects above), `errors.test.ts` with the ten kinds accepted by `isAppError`, `keys.test.ts` with `branches(3)` equals `["repo", 3, "branches"]` and has the repo prefix.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/app/layout.test.ts src/lib src/components` → fails on missing modules.

- [ ] **Step 3: Implement**

`layout.ts`:

```ts
export const REFS_MIN = 160;
export const SIDEBAR_MIN = 240;
export const DETAIL_MIN = 320;
export const REFS_DEFAULT = 240;
export const SIDEBAR_DEFAULT = 320;
export const KEY_STEP = 16;

export function clampWidths(container: number, refs: number, sidebar: number) {
  if (container <= 0) return { refs, sidebar };
  let r = Math.max(REFS_MIN, refs);
  let s = Math.max(SIDEBAR_MIN, sidebar);
  const over = r + s + DETAIL_MIN - container;
  if (over > 0) {
    const cut = Math.min(over, s - SIDEBAR_MIN);
    s -= cut;
    r = Math.max(REFS_MIN, r - (over - cut));
  }
  return { refs: r, sidebar: s };
}

export function maxWidth(container: number, column: "refs" | "sidebar", other: number): number {
  if (container <= 0) return Infinity;
  const [min, otherMin] = column === "refs" ? [REFS_MIN, SIDEBAR_MIN] : [SIDEBAR_MIN, REFS_MIN];
  return Math.max(min, container - DETAIL_MIN - Math.max(other, otherMin));
}
```

`SplitHandle.tsx`:

```tsx
export function SplitHandle({ label, value, min, max, onChange, onReset }: SplitHandleProps) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (px: number) => Math.min(max, Math.max(min, px));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max === Infinity ? undefined : max}
      tabIndex={0}
      className={styles.handle}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, value };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current) onChange(clamp(start.current.value + e.clientX - start.current.x));
      }}
      onPointerUp={(e) => {
        start.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={(e) => {
        start.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const next =
          e.key === "ArrowRight"
            ? value + KEY_STEP
            : e.key === "ArrowLeft"
              ? value - KEY_STEP
              : e.key === "Home"
                ? min
                : e.key === "End"
                  ? max
                  : null;
        if (next === null) return;
        e.preventDefault();
        onChange(clamp(next));
      }}
    />
  );
}
```

CSS: `width: 6px; cursor: col-resize; background: linear-gradient(to right, transparent 2px, var(--color-border) 2px 3px, transparent 3px)`; `:hover, :focus-visible` use `--color-accent`; `touch-action: none`.

`PromptDialog.tsx`: structure of `ConfirmDialog` (backdrop, `role="dialog"`, `aria-modal`, `useLayoutEffect` focus + restore, Escape, backdrop click) around a `<form onSubmit>` with `<label htmlFor>` + `<input>` (`useLayoutEffect` also calls `input.select()`), optional `<label><input type="checkbox"/></label>`, `error && <p role="alert">{error.message}</p>`, Cancel and submit buttons. `onConfirm(value.trim())`; submit disabled when `pending || value.trim() === ""`.

`useRepoChanged.ts`: the effect lifted from `useStatus` unchanged. `useStatus` keeps its query only.

- [ ] **Step 4: Run gates, commit** — `npm test && npm run lint && npm run typecheck` (coverage must stay at 100 %); commit `feat(ui): branch IPC seam, layout prefs, split handle, prompt dialog, single repo-changed hook`.

---

### Task 5: Front end — `src/features/branches/`

**Files:**

- Create: `src/features/branches/useBranches.ts`, `useBranchActions.ts`, `branchFilter.ts`, `BranchRow.tsx` + `.module.css`, `BranchGroup.tsx` + `.module.css`, `BranchesPanel.tsx` + `.module.css`
- Test: `useBranches.test.tsx`, `useBranchActions.test.tsx`, `branchFilter.test.ts`, `BranchRow.test.tsx`, `BranchGroup.test.tsx`, `BranchesPanel.test.tsx`

**Interfaces:**

- Consumes: Task 4.
- Produces:

```ts
export function useBranches(repoId: RepoId): {
  branches: BranchList | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
};

type BranchRequest =
  | { action: "create"; name: string; startPoint: string | null; checkout: boolean }
  | { action: "rename"; oldName: string; newName: string }
  | { action: "delete"; name: string; force: boolean }
  | { action: "checkout"; name: string }
  | { action: "checkoutRemote"; remote: string; name: string }
  | { action: "deleteRemote"; remote: string; name: string };
/** Every action resolves (never rejects) with the AppError or null; `error` mirrors the last result. */
export interface UseBranchActions {
  run(req: BranchRequest): Promise<AppError | null>;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}
export function useBranchActions(repoId: RepoId): UseBranchActions;

export function filterBranches(list: BranchList, query: string): BranchList;

export type BranchTarget =
  { kind: "local"; branch: LocalBranch } | { kind: "remote"; branch: RemoteBranch };
export interface BranchRowProps {
  target: BranchTarget;
  current: boolean;
  onActivate(): void;
  onContextMenu(x: number, y: number): void;
}
export interface BranchGroupProps {
  heading: string;
  listLabel: string;
  filtered: boolean;
  children: ReactNode;
  count: number;
  leading?: ReactNode;
}
export function BranchesPanel({ repoId }: { repoId: RepoId }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

`branchFilter.test.ts`: empty query returns the same object; `"MAIN"` matches `main`; remote match on `origin/feature` by `"origin/f"` and by `"feat"`; order preserved; a group with no matches is kept with an empty `branches` array (the group component renders "No matches").

`useBranchActions.test.tsx`: each request calls the right IPC function with the right arguments; `run` resolves `null` on success and the `AppError` on failure (`toAppError` applied to non-AppError rejections); `error` is set after failure and cleared by `clearError`; `onSettled` invalidates `queryKeys.repo(repoId)` on success and failure; `pending` true during a call.

`useBranches.test.tsx`: loading, data, error, `refetchOnWindowFocus` true, key `branches(id)`.

`BranchRow.test.tsx`: name shown; `aria-current="true"` and class `current` when `current`; tracking badge `↑2 ↓1` (`aria-label="2 ahead, 1 behind"`), `gone` when counts are null, no badge without tracking; remote row shows `name` and `title="refs/remotes/origin/main"`, local `title="refs/heads/main"`; double-click calls `onActivate`; Enter calls `onActivate`; click alone does not; right-click calls `onContextMenu(x, y)` and prevents default; Shift+F10 and `ContextMenu` key call `onContextMenu` with the row's bounding box left/bottom.

`BranchGroup.test.tsx`: heading rendered as `<h2>`; `<ul aria-label={listLabel}>`; `count === 0 && !filtered` → "No branches"; `count === 0 && filtered` → "No matches"; `leading` rendered before the list.

`BranchesPanel.test.tsx` (mock `../../lib/ipc` like `ChangesPanel.test.tsx`; default `listBranches` resolves `{ head: { kind: "branch", name: "main" }, local: [main(isHead), feature], remotes: [{ remote: "origin", branches: [{ remote: "origin", name: "main" }, { remote: "origin", name: "other" }] }] }`):

- renders region `aria-label="Branches"`, groups "Local" and "origin", `main` marked current
- filter narrows: typing `oth` leaves only `origin/other`, Local shows "No matches"; Escape clears
- double-click `feature` → `checkoutBranch(1, "feature")`; Enter on `feature` → same; double-click `main` (current) → no call
- double-click `other` under origin → `checkoutRemoteBranch(1, "origin", "other")`
- context menu on `feature`: items Checkout, Create branch here…, Rename…, Delete…; on `main`: Checkout and Delete… disabled; on remote `other`: Checkout (title "Creates a local branch tracking origin/other"), Delete on origin…; on remote `main` (local `main` exists): Checkout has no title
- "New branch…" opens the dialog "New branch", label "Name", checkbox "Switch to new branch" checked; confirm with `topic` → `createBranch(1, "topic", null, true)`; dialog closes on success
- "Create branch here…" on `feature` → title "New branch from feature", confirm → `createBranch(1, "x", "feature", true)`; unchecking the checkbox → `checkout: false`
- `createBranch` rejecting with `{ kind: "branchExists", message: "taken" }` keeps the dialog open with the alert "taken"; cancel clears the error and the panel shows no alert
- Rename… on `feature`: title "Rename feature", initial value `feature`, confirm `topic` → `renameBranch(1, "feature", "topic")`
- Delete… on `feature`: confirm dialog "Delete branch feature?" body "The branch is merged into the current branch." → `deleteBranch(1, "feature", false)`; on success the dialog closes
- `should open the force-delete dialog on branchNotMerged`: `deleteBranch` rejects with `branchNotMerged` → dialog "Force delete feature?" with the body copy; confirm "Force delete" → `deleteBranch(1, "feature", true)`; no alert visible in between
- `should clear the error when the force dialog is cancelled`: cancel → no alert, no dialog
- Delete on origin… on `other`: dialog "Delete origin/other on origin?" body "This removes the branch from the remote for everyone." confirm "Delete on origin" → `deleteRemoteBranch(1, "origin", "other")`
- `checkoutBranch` rejecting with `{ kind: "checkoutFailed", message: "error: Your local changes…" }` shows a `RepoError` alert at the top with the message and Dismiss clears it
- head `detached` → first Local row "Detached at 0123abc" with `aria-current`, no interactive button; head `unborn` → row "main (no commits yet)" and "New branch…" disabled with title "Make a commit first"
- query error → `RepoError` with Retry calling `listBranches` again
- `aria-busy="true"` on the region while an action is pending; menu items disabled while pending

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/features/branches` → module not found.

- [ ] **Step 3: Implement**

`branchFilter.ts`:

```ts
export function filterBranches(list: BranchList, query: string): BranchList {
  const q = query.trim().toLowerCase();
  if (q === "") return list;
  const hit = (s: string) => s.toLowerCase().includes(q);
  return {
    head: list.head,
    local: list.local.filter((b) => hit(b.name)),
    remotes: list.remotes.map((g) => ({
      ...g,
      branches: g.branches.filter((b) => hit(`${b.remote}/${b.name}`)),
    })),
  };
}
```

`useBranchActions.ts`: `useMutation<void | LocalBranch, AppError, BranchRequest>` with `mutationFn` switching on `action` and wrapping rejections in `toAppError`; `onSettled` invalidates `queryKeys.repo(repoId)`; `run = (req) => mutation.mutateAsync(req).then(() => null, (e: AppError) => e)`; `error: mutation.error ?? null`; `clearError: mutation.reset`.

`BranchRow.tsx`: `<li onContextMenu>` → `<button type="button" className={cx(styles.row, current && styles.current)} aria-current={current || undefined} title={fullRef} onDoubleClick={onActivate} onKeyDown={...}>` with `<span className={styles.name}>{name}</span>` and the tracking badge `<span className={styles.badge} aria-label="2 ahead, 1 behind">↑2 ↓1</span>` / `gone`. Keyboard: Enter → `onActivate()`; `Shift+F10` or `e.key === "ContextMenu"` → `const r = e.currentTarget.getBoundingClientRect(); onContextMenu(r.left, r.bottom)`.

`BranchGroup.tsx`: `<section className={styles.group} aria-labelledby={id}><h2 id={id}>{heading}</h2>{leading}{count === 0 ? <p className={styles.empty}>{filtered ? "No matches" : "No branches"}</p> : <ul aria-label={listLabel}>{children}</ul>}</section>`.

`BranchesPanel.tsx` state:

```ts
type Dialog =
  | { kind: "create"; title: string; startPoint: string | null }
  | { kind: "rename"; name: string }
  | { kind: "deleteLocal"; name: string }
  | { kind: "forceDelete"; name: string }
  | { kind: "deleteRemote"; remote: string; name: string };
const [query, setQuery] = useState("");
const [menu, setMenu] = useState<{ x: number; y: number; target: BranchTarget } | null>(null);
const [dialog, setDialog] = useState<Dialog | null>(null);
const [checkoutNew, setCheckoutNew] = useState(true);
```

Handlers:

```ts
const closeDialog = () => { setDialog(null); actions.clearError(); };
const activate = (t: BranchTarget) => {
  if (t.kind === "local") { if (!t.branch.isHead) void actions.run({ action: "checkout", name: t.branch.name }); }
  else void actions.run({ action: "checkoutRemote", remote: t.branch.remote, name: t.branch.name });
};
const confirmCreate = async (name: string) => {
  if (dialog?.kind !== "create") return;
  const err = await actions.run({ action: "create", name, startPoint: dialog.startPoint, checkout: checkoutNew });
  if (err === null) closeDialog();
};
const confirmRename = async (newName: string) => { ... run rename ...; if (err === null) closeDialog(); };
const confirmDeleteLocal = async () => {
  if (dialog?.kind !== "deleteLocal") return;
  const { name } = dialog;
  const err = await actions.run({ action: "delete", name, force: false });
  if (err === null) closeDialog();
  else if (err.kind === "branchNotMerged") { actions.clearError(); setDialog({ kind: "forceDelete", name }); }
};
const confirmForce = async () => { ...run delete force... ; if (err === null) closeDialog(); };
const confirmDeleteRemote = async () => { ...; if (err === null) closeDialog(); };
```

Error placement: `const panelError = dialog === null ? actions.error : null;` is shown as `<RepoError error path={null} onDismiss={actions.clearError}/>`; `PromptDialog` receives `error={actions.error}`. `ConfirmDialog` has no error slot: a failing confirm (other than the `branchNotMerged` hand-off) closes the dialog and the panel shows the error: implement as `if (err === null || err.kind !== "branchNotMerged") setDialog(null)` without clearing the error.

Menu items are built from `menu.target` as in `ChangesPanel.menuItems`, each `disabled: actions.pending` (plus the HEAD rules). Region: `<section aria-label="Branches" aria-busy={actions.pending || undefined} className={styles.root}>` with a header row holding the filter `<input type="search" aria-label="Filter branches" placeholder="Filter branches" onKeyDown Escape → setQuery("")>` and the "New branch…" button (`disabled` + `title="Make a commit first"` when `head.kind === "unborn"`).

- [ ] **Step 4: Run gates, commit** — `npm test && npm run lint && npm run typecheck`; commit `feat(ui): branches panel with checkout, create, rename, delete and filter`.

---

### Task 6: Front end — `RepoPane` three columns, live header, single subscription

**Files:**

- Modify: `src/app/RepoPane.tsx`, `src/app/RepoPane.module.css`
- Test: `src/app/RepoPane.test.tsx`

**Interfaces:**

- Consumes: Tasks 4–5 (`useBranches`, `BranchesPanel`, `SplitHandle`, `useLayoutPrefs`, `clampWidths`, `maxWidth`, `useRepoChanged`).

- [ ] **Step 1: Write the failing tests**

Extend the `vi.mock` with `listBranches` (default resolves head `branch main`, local `[main]`, remotes `[]`) and stub `globalThis.ResizeObserver` with a class that records the callback so a test can fire it with `[{ contentRect: { width } }]`.

- `should render the branches region left of the changes region` (DOM order: Branches, separator "Resize branches column", Changes, separator "Resize changes column", Detail)
- `should subscribe to repo-changed once per tab` (`onRepoChanged` called once with the tab id across re-renders)
- `should show the live head name from the branch list` (list resolves `feature` while summary says `main` → header shows `feature`)
- `should show detached at the short oid` and `should show the unborn name with no commits yet`
- `should fall back to the summary while the branch list loads` (pending promise → `main`; `null` summary → `detached HEAD` as before)
- `should set the grid template from the stored widths` (`style.gridTemplateColumns === "240px auto 320px auto 1fr"`)
- `should use clamped widths after a resize observation` (fire observer with width 860 → `"240px auto 300px auto 1fr"`)
- `should persist a handle drag to layoutPrefs` (keyboard `ArrowRight` on "Resize branches column" → `useLayoutPrefs.getState().refsWidth === 256`)
- `should reset a column on double-click` (set 300 then dblclick → 240)
- `should disconnect the observer on unmount`

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/app/RepoPane.test.tsx`.

- [ ] **Step 3: Implement**

```tsx
export function RepoPane({ tab }: { tab: RepoTab }) {
  const headingId = useId();
  const { name, path, headBranch } = tab.summary;
  useRepoChanged(tab.id);
  const { branches } = useBranches(tab.id);
  const prefs = useLayoutPrefs();
  const [container, setContainer] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setContainer(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { refs, sidebar } = clampWidths(container, prefs.refsWidth, prefs.sidebarWidth);
  const headLabel = headLine(branches?.head, headBranch);
  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <header>
        …<p className={styles.branch}>{headLabel}</p>
      </header>
      <div
        ref={bodyRef}
        className={styles.body}
        style={{ gridTemplateColumns: `${refs}px auto ${sidebar}px auto 1fr` }}
      >
        <div key={`refs-${tab.id}`} className={styles.refs}>
          <BranchesPanel repoId={tab.id} />
        </div>
        <SplitHandle
          label="Resize branches column"
          value={refs}
          min={REFS_MIN}
          max={maxWidth(container, "refs", sidebar)}
          onChange={prefs.setRefsWidth}
          onReset={() => prefs.reset("refs")}
        />
        <div key={tab.id} className={styles.sidebar}>
          …ChangesPanel, CommitBox…
        </div>
        <SplitHandle
          label="Resize changes column"
          value={sidebar}
          min={SIDEBAR_MIN}
          max={maxWidth(container, "sidebar", refs)}
          onChange={prefs.setSidebarWidth}
          onReset={() => prefs.reset("sidebar")}
        />
        <section aria-label="Detail" className={styles.detail}>
          …
        </section>
      </div>
    </section>
  );
}

function headLine(head: HeadState | undefined, fallback: string | null): string {
  if (head === undefined) return fallback ?? "detached HEAD";
  switch (head.kind) {
    case "branch":
      return head.name;
    case "detached":
      return `detached at ${head.oid.slice(0, 7)}`;
    case "unborn":
      return `${head.name} (no commits yet)`;
  }
}
```

CSS: remove the fixed `grid-template-columns`; `.refs { display:flex; flex-direction:column; min-height:0; min-width:0; }`; `.sidebar` keeps its border; `.body` gets `min-width: 0; overflow: hidden`.

- [ ] **Step 4: Run gates, commit** — `npm test && npm run lint && npm run typecheck`; commit `feat(ui): resizable refs column and live head in RepoPane`.

---

## Execution: batched agent cycles

Three cycles, one per layer, each with the mandatory sequence architect + tdd-tester (parallel) → developer → tdd-tester-coverage + code-reviewer (parallel), then one final architect sign-off:

| Cycle | Tasks | Deliverable                                      |
| ----- | ----- | ------------------------------------------------ |
| 1     | 1–3   | Rust core + app commands, `cargo test` green     |
| 2     | 4     | Front-end foundations, `npm test` green at 100 % |
| 3     | 5–6   | Branches panel and resizable pane, all gates     |

Models per `~/.claude/agents/*.md`: architect and developer on opus, tdd-tester, tdd-tester-coverage and code-reviewer on sonnet. Agents write reports to the session scratchpad, not the main context.

## After the last task

1. Full gates on the branch: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `npm test` (100 %), `npm run lint`, `npm run typecheck`.
2. Final architect sign-off on the whole branch.
3. Acceptance walk in the running app (spec §6.3).
4. `git merge --no-ff feature/gr-7-branch-management` into `main`, delete the branch.
5. Jira GR-7 → Done with walk results and follow-ups.
