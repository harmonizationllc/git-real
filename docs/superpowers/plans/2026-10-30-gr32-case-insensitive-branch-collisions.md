# GR-32 Case-Only Branch Collisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a repository whose filesystem does not distinguish case, refuse creating or renaming a branch to a case-only variant of an existing local branch with a dedicated error, and let the two byte-order sort tests gated under GR-32 run on every platform.

**Architecture:** One private helper in `refs/mod.rs` replaces the three `find_branch` duplicate pre-checks: it iterates local branch names once, returns `BranchExists` on an exact match and, when `core.ignorecase` is true, `BranchCaseCollision` on a lowercase-fold match. The new core variant maps to a new Tauri `AppErrorKind` and a new front-end kind string; no dialog changes. The gated sort tests lose their colliding names, and the case-only pairs move to Unix-only tests.

**Tech Stack:** Rust 2024, git2 (libgit2, no network features), thiserror, Tauri 2, TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-30-gr32-case-insensitive-branch-collisions-design.md`

## Global Constraints

- Tests first (red before green). The developer role never edits test files; test code is written in the test step, before implementation.
- `git-real-core` carries no platform `cfg` in product code; the behaviour keys off `core.ignorecase`. Platform `cfg` is allowed only in tests, exactly where this plan says.
- Case comparison is `str::to_lowercase()` on both sides. An unset or unreadable `core.ignorecase` counts as `false`.
- Error message, verbatim: `a branch named {existing} already exists, and this repository's filesystem does not distinguish {requested} from it by case`.
- Kind names: core `GitError::BranchCaseCollision { requested: String, existing: String }`, Tauri `AppErrorKind::BranchCaseCollision`, front end `"branchCaseCollision"`.
- Commits: explicit paths only, never `-A`, never amend/reset/stash. Subjects `feat(GR-32): …`, `test(GR-32): …`. Trailers from the session's attribution reminder.
- Checks, run from the worktree root `/home/gorlox/code/git-real/.claude/worktrees/gr-32-case-collisions`: `cargo test --manifest-path src-tauri/crates/git-real-core/Cargo.toml`, `cargo test --manifest-path src-tauri/Cargo.toml --workspace`, `cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `npm run typecheck`, `npm run lint`, `npm test`.

## Review Focus

- Non-ASCII case pairs (`Ärger` / `ärger`) must collide like ASCII ones. Test in Task 1.
- A garbage `core.ignorecase` value (`maybe`) must behave as `false`, not fail the operation. Test in Task 1.
- Renaming a branch to its own exact name must still be `BranchExists`, as today; only the case comparison skips `keep`. Test in Task 1.
- A remote-tracking branch whose name is a case variant of the requested local name must not count: only local branches are compared. Test in Task 1.
- An unborn repository (no branches) must still report `UnbornHead` from `create_branch`, not panic in the iteration. Existing test `create_on_unborn_head_fails_with_unborn_head` in `branches.rs` covers it; Task 1 confirms it still passes.

---

### Task 1: Core helper, error variant and tests

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/error.rs:42-43` (add variant after `BranchExists`)
- Modify: `src-tauri/crates/git-real-core/src/refs/mod.rs:132-137` (`rename_branch`), `:324-334` (`new_branch_target`), new free fn near `find_local` (`:418`)
- Modify: `src-tauri/crates/git-real-core/src/linked_worktrees/mod.rs:73-76` (remove the `find_branch` pre-check)
- Test: `src-tauri/crates/git-real-core/tests/common/mod.rs` (new helper), `src-tauri/crates/git-real-core/tests/branches.rs`, `src-tauri/crates/git-real-core/tests/linked_worktrees.rs`

**Interfaces:**

- Produces: `GitError::BranchCaseCollision { requested: String, existing: String }` (Task 3 maps it); `fn refuse_duplicate_branch(repo: &Repository, name: &str, keep: Option<&str>) -> Result<(), GitError>` (private to `refs/mod.rs`); test helper `pub fn set_ignorecase(path: &Path, value: bool)` in `tests/common/mod.rs`.

- [ ] **Step 1: Write the test helper and fixture variant**

In `tests/common/mod.rs`:

```rust
/// Writes `core.ignorecase` into the repository's own config file, as git
/// does at init on a case-insensitive filesystem. Call before opening the
/// `RepoSession` under test.
pub fn set_ignorecase(path: &Path, value: bool) {
    Repository::open(path)
        .expect("open repo")
        .config()
        .expect("config")
        .set_bool("core.ignorecase", value)
        .expect("set core.ignorecase");
}
```

In `tests/branches.rs`, beside `fixture()`:

```rust
/// `fixture()` with `core.ignorecase` written before the session opens.
fn fixture_ignorecase(value: bool) -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (dir, path) = common::temp_repo_with_commit();
    common::set_ignorecase(&path, value);
    let head = common::head_branch_name(&path);
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session, head)
}
```

- [ ] **Step 2: Write the failing tests in `tests/branches.rs`**

Add a section `// --- case-only collisions (GR-32) ---` with:

```rust
#[test]
fn create_case_variant_is_case_collision_when_ignorecase() {
    let (_d, _p, session, _h) = fixture_ignorecase(true);
    session.create_branch("Alpha", None).unwrap();
    let err = session.create_branch("alpha", None).unwrap_err();
    assert!(
        matches!(err, GitError::BranchCaseCollision { ref requested, ref existing }
            if requested == "alpha" && existing == "Alpha"),
        "{err:?}"
    );
}

#[test]
fn create_exact_duplicate_stays_branch_exists_when_ignorecase() {
    // create "Alpha" twice → GitError::BranchExists(n) with n == "Alpha"
}

#[test]
fn create_case_variant_folds_non_ascii() {
    // create "Ärger" then "ärger" → BranchCaseCollision { requested: "ärger", existing: "Ärger" }
}

#[test]
fn create_case_variant_sees_nested_names() {
    // create "feature/X" then "feature/x" → BranchCaseCollision { existing: "feature/X", .. }
}

#[test]
fn rename_to_case_variant_of_other_branch_is_case_collision() {
    // create "zeta" and "Alpha"; rename "zeta" → "ALPHA"
    // → BranchCaseCollision { requested: "ALPHA", existing: "Alpha" }
}

#[test]
fn rename_to_exact_other_branch_stays_branch_exists_when_ignorecase() {
    // create "zeta" and "Alpha"; rename "zeta" → "Alpha" → BranchExists("Alpha")
}

#[test]
fn rename_to_own_exact_name_is_branch_exists() {
    // fixture_ignorecase(true); create "alpha"; rename "alpha" → "alpha" → BranchExists("alpha")
}

#[test]
fn rename_changes_only_the_case_of_own_name() {
    // fixture_ignorecase(true); create "alpha"; rename "alpha" → "Alpha" is Ok(());
    // local_names(&session.list_branches().unwrap()) contains "Alpha" and not "alpha".
    // Runs on every platform; the core-windows CI job is the real check (spec §2.5).
}

#[test]
fn case_variant_of_remote_branch_does_not_collide() {
    // remote_fixture(); common::branch_with_commit(&path, "Topic", "t.txt", "t\n");
    // common::push_branch(&path, "Topic"); common::fetch_remote(&path, "origin");
    // common::set_ignorecase(&path, true); open the session;
    // session.delete_branch("Topic", true).unwrap();  // only origin/Topic remains
    // assert session.create_branch("topic", None).is_ok().
}

#[cfg(unix)]
#[test]
fn create_case_variant_allowed_when_not_ignorecase() {
    // fixture_ignorecase(false); create "Alpha" and "alpha" both Ok;
    // local_names contains both. Unix-only: on NTFS the files really collide.
}

#[cfg(unix)]
#[test]
fn garbage_ignorecase_value_counts_as_false() {
    // fixture(); Repository::open(&path).config().set_str("core.ignorecase", "maybe");
    // reopen session; create "Alpha" and "alpha" both Ok.
}

#[cfg(windows)]
#[test]
fn fresh_repo_on_windows_refuses_case_variant() {
    // plain fixture(); assert Repository::open(&path).config().get_bool("core.ignorecase") == Ok(true);
    // create "Alpha" then "alpha" → BranchCaseCollision { requested: "alpha", existing: "Alpha" }.
}

#[test]
fn case_collision_message_names_both_spellings() {
    assert_eq!(
        GitError::BranchCaseCollision { requested: "alpha".into(), existing: "Alpha".into() }.to_string(),
        "a branch named Alpha already exists, and this repository's filesystem does not distinguish alpha from it by case"
    );
}
```

Fill each commented body with the obvious code using `fixture_ignorecase`, `local_names`, `matches!` with `"{err:?}"` messages, in the file's existing style.

- [ ] **Step 3: Write the failing test in `tests/linked_worktrees.rs`**

After `add_taken_name_is_branch_exists`:

```rust
#[test]
fn add_case_variant_name_is_case_collision() {
    let (_md, main, _wd, root, _head) = fixture();
    common::set_ignorecase(&main, true);
    session(&main).create_branch("Alpha", None).unwrap();
    let err = session(&main)
        .add_linked_worktree(&root.join("x"), &new_branch("alpha", None))
        .unwrap_err();
    assert!(
        matches!(err, GitError::BranchCaseCollision { ref requested, ref existing }
            if requested == "alpha" && existing == "Alpha"),
        "{err:?}"
    );
    assert!(!root.join("x").exists());
}
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/crates/git-real-core/Cargo.toml --test branches --test linked_worktrees`
Expected: compile error `no variant named BranchCaseCollision` (every new test fails to build).

- [ ] **Step 5: Add the variant in `error.rs`**

Directly after `BranchExists(String)`:

```rust
#[error(
    "a branch named {existing} already exists, and this repository's filesystem \
     does not distinguish {requested} from it by case"
)]
BranchCaseCollision { requested: String, existing: String },
```

- [ ] **Step 6: Implement `refuse_duplicate_branch` in `refs/mod.rs`**

Free function beside `find_local`:

```rust
/// Refuses `name` when a local branch already has it. Compared by name,
/// never by `find_branch`: on a case-insensitive filesystem that lookup
/// finds `Alpha` when asked for `alpha`. When `core.ignorecase` is true a
/// case-only match (other than `keep`) is a `BranchCaseCollision`.
fn refuse_duplicate_branch(repo: &Repository, name: &str, keep: Option<&str>) -> Result<(), GitError>
```

Approach: read `ignorecase = repo.config()?.get_bool("core.ignorecase").unwrap_or(false)`; compute `folded = name.to_lowercase()` once; iterate `repo.branches(Some(BranchType::Local))?`, taking each `lossy_name(&branch)`; exact equality → `Err(BranchExists(name.to_owned()))`; else if `ignorecase && Some(existing.as_str()) != keep && existing.to_lowercase() == folded` → `Err(BranchCaseCollision { requested: name.to_owned(), existing })`; otherwise `Ok(())` after the loop.

- [ ] **Step 7: Wire the helper into the three call sites**

- `new_branch_target`: replace the `find_branch(...).is_ok()` block with `refuse_duplicate_branch(repo, name, None)?;`.
- `rename_branch`: replace its `find_branch(new, ...)` block with `refuse_duplicate_branch(repo, new, Some(old))?;` (keep `validate_branch_name(new)?` first and `find_local(repo, old)?` before it, as now).
- `add_linked_worktree` (`WorktreeBranch::New` arm): delete the three-line `find_branch` check; `validate_branch_name(name)?` stays, `new_branch_target` does the rest.

- [ ] **Step 8: Run the core tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/crates/git-real-core/Cargo.toml`
Expected: all pass, including `add_taken_name_is_branch_exists` and the unborn-head create test. The `#[cfg(windows)]` test is skipped here.

- [ ] **Step 9: Clippy and fmt**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings && cargo fmt --manifest-path src-tauri/Cargo.toml --check`
Expected: clean. (The Tauri crate will not compile until Task 3 if its `AppErrorKind` match is exhaustive over `GitError`; it is a `match` on `GitError` in `src-tauri/src/error.rs:150-200`, so expect `non-exhaustive patterns` here and fix it in Task 3. If so, run clippy on the core crate only for this task: `cargo clippy --manifest-path src-tauri/crates/git-real-core/Cargo.toml --all-targets -- -D warnings`.)

- [ ] **Step 10: Commit**

```bash
git add src-tauri/crates/git-real-core/src/error.rs src-tauri/crates/git-real-core/src/refs/mod.rs src-tauri/crates/git-real-core/src/linked_worktrees/mod.rs src-tauri/crates/git-real-core/tests/common/mod.rs src-tauri/crates/git-real-core/tests/branches.rs src-tauri/crates/git-real-core/tests/linked_worktrees.rs
git commit -m "feat(GR-32): refuse case-only branch collisions on case-insensitive filesystems"
```

---

### Task 2: Split the two gated sort tests

**Files:**

- Test: `src-tauri/crates/git-real-core/tests/branches.rs:81-97`
- Test: `src-tauri/crates/git-real-core/tests/status.rs:386-402`

**Interfaces:** none.

- [ ] **Step 1: Rewrite `list_sorts_local_branches_by_name_in_byte_order`**

Remove the `// GR-32` comment and the `#[cfg(unix)]` gate. Names become `"zeta"`, `"Beta"`, `"alpha"`; `expected` is `[head, "zeta", "Beta", "alpha"]` sorted, as now.

- [ ] **Step 2: Add the Unix-only case pair test below it**

```rust
// Unix-only: a case-insensitive filesystem cannot hold both spellings, and
// GR-32 refuses the second one there.
#[cfg(unix)]
#[test]
fn list_sorts_case_only_variants_in_byte_order() {
    let (_d, _p, session, head) = fixture();
    session.create_branch("alpha", None).unwrap();
    session.create_branch("Alpha", None).unwrap();
    let mut expected = vec![head, "alpha".to_string(), "Alpha".to_string()];
    expected.sort();
    assert_eq!(local_names(&session.list_branches().unwrap()), expected);
}
```

- [ ] **Step 3: Rewrite `status_entries_sorted_bytewise_with_mixed_case_and_nesting`**

Remove the comment and gate. Files: `["b.txt", "a/b.txt", "a.txt", "a-b.txt", "B/z.txt"]`; expected `vec!["B/z.txt", "a-b.txt", "a.txt", "a/b.txt", "b.txt"]`.

- [ ] **Step 4: Add the Unix-only case pair test below it**

```rust
// Unix-only: a case-insensitive filesystem cannot hold both spellings.
#[cfg(unix)]
#[test]
fn status_entries_sort_case_only_variants_bytewise() {
    let (_dir, path) = common::temp_repo_with_commit();
    for p in ["b.txt", "B.txt", "a/z.txt", "A/z.txt"] {
        common::write_file(&path, p, "x\n");
    }
    let paths: Vec<_> = status_of(&path).entries.into_iter().map(|e| e.path).collect();
    assert_eq!(paths, vec!["A/z.txt", "B.txt", "a/z.txt", "b.txt"]);
}
```

- [ ] **Step 5: Run both test files**

Run: `cargo test --manifest-path src-tauri/crates/git-real-core/Cargo.toml --test branches --test status`
Expected: all pass; `grep -n "GR-32" src-tauri/crates/git-real-core/tests/*.rs` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/git-real-core/tests/branches.rs src-tauri/crates/git-real-core/tests/status.rs
git commit -m "test(GR-32): run byte-order sort tests on every platform, case pairs Unix-only"
```

---

### Task 3: Tauri and front-end error kind

**Files:**

- Modify: `src-tauri/src/error.rs:28` (enum) and `:171` (match arm)
- Modify: `src/lib/ipc/types.ts:61` (union)
- Modify: `src/lib/ipc/errors.ts:21` (`KINDS` record)

**Interfaces:**

- Consumes: `GitError::BranchCaseCollision { .. }` from Task 1.
- Produces: `AppErrorKind::BranchCaseCollision`, serialised `"branchCaseCollision"` (the enum's existing serde rename rule handles the casing; check the `#[serde(rename_all = ...)]` attribute on `AppErrorKind` and add nothing new).

- [ ] **Step 1: Verify the red state**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings`
Expected: `non-exhaustive patterns: GitError::BranchCaseCollision { .. } not covered` in `src-tauri/src/error.rs`. (If the match has a wildcard arm instead and compiles, that is the red state for the wrong kind being reported; proceed anyway.)

- [ ] **Step 2: Add the Tauri kind and mapping**

In `AppErrorKind`, add `BranchCaseCollision,` directly after `BranchExists,`. In the `From<GitError>` match, add `GitError::BranchCaseCollision { .. } => AppErrorKind::BranchCaseCollision,` directly after the `BranchExists` arm.

- [ ] **Step 3: Add the front-end kind**

`src/lib/ipc/types.ts`: add `| "branchCaseCollision"` directly after `| "branchExists"`. `src/lib/ipc/errors.ts`: add `branchCaseCollision: true,` directly after `branchExists: true,`.

- [ ] **Step 4: Run every check**

Run, from the worktree root:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --workspace
cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
npm run typecheck && npm run lint && npm test
```

Expected: all green; `npm test` coverage stays at 100 % (the two edits add no branches).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/error.rs src/lib/ipc/types.ts src/lib/ipc/errors.ts
git commit -m "feat(GR-32): surface branchCaseCollision through the IPC error kinds"
```

---

### Task 4: Case-exact local branch lookups

Spec §6.1. Owner decision: fixed here, not ticketed.

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/refs/mod.rs` (`find_local`, `checkout_remote_branch`, visibility of `refuse_duplicate_branch`)
- Modify: `src-tauri/crates/git-real-core/src/merge/mod.rs` (`resolve_branch`)
- Modify: `src-tauri/crates/git-real-core/src/remote/pr_checkout.rs` (`checkout_fetch_head`)
- Test: `src-tauri/crates/git-real-core/tests/branches.rs`, `tests/pr_checkout.rs`, and the files that already test `checkout_remote_branch` and `merge_branch` (find them with `grep -ln`)

**Interfaces:**

- Consumes: `ignores_case`, `refuse_duplicate_branch`, `lossy_name` (Task 1, `refs/mod.rs`); `common::set_ignorecase`, `fixture_ignorecase` (Task 1 tests).
- Produces: `pub(crate) fn find_local<'r>(repo: &'r Repository, name: &str) -> Result<Branch<'r>, GitError>` is case-exact on ignorecase repos; `pub(crate) fn refuse_duplicate_branch(repo, name, keep)` is visible crate-wide.

- [ ] **Step 1: Write the failing tests**

In `tests/branches.rs`, section `// --- case-only collisions ---`. "Both spellings" means: open the repo with git2, create `Alpha` and `alpha` at HEAD, then `common::set_ignorecase(&path, true)`, then `RepoSession::open` (as `exact_match_wins_over_case_collision_when_both_spellings_exist` does).

```rust
#[cfg(unix)]
#[test]
fn delete_removes_exact_spelling_when_both_spellings_exist() {
    // both spellings, ignorecase on
    session.delete_branch("alpha", true).unwrap();
    let names = local_names(&session.list_branches().unwrap());
    assert!(names.contains(&"Alpha".to_owned()), "{names:?}");
    assert!(!names.contains(&"alpha".to_owned()), "{names:?}");
}

#[cfg(unix)]
#[test]
fn rename_moves_exact_spelling_when_both_spellings_exist() {
    // both spellings, ignorecase on
    session.rename_branch("alpha", "gamma").unwrap();
    let names = local_names(&session.list_branches().unwrap());
    assert!(names.contains(&"Alpha".to_owned()) && names.contains(&"gamma".to_owned()), "{names:?}");
    assert!(!names.contains(&"alpha".to_owned()), "{names:?}");
}

#[cfg(windows)]
#[test]
fn fresh_repo_on_windows_does_not_resolve_case_variant_lookups() {
    let (_d, _p, session, _h) = fixture(); // no ignorecase override: git wrote true at init
    session.create_branch("Alpha", None).unwrap();
    let err = session.delete_branch("alpha", true).unwrap_err();
    assert!(matches!(err, GitError::BranchNotFound(ref n) if n == "alpha"), "{err:?}");
    let err = session.checkout_branch("alpha").unwrap_err();
    assert!(matches!(err, GitError::BranchNotFound(ref n) if n == "alpha"), "{err:?}");
    assert!(local_names(&session.list_branches().unwrap()).contains(&"Alpha".to_owned()));
}
```

In the file that tests `checkout_remote_branch` (guard with `if !common::git_available() { return; }` like its neighbours; set up the remote the way they do, with the remote branch named `alpha`; create local `Alpha` with `create_branch`; `common::set_ignorecase(&path, true)` before opening the session used for the call):

```rust
#[test]
fn checkout_remote_case_variant_of_local_branch_is_case_collision() {
    let err = session.checkout_remote_branch("origin", "alpha").unwrap_err();
    assert!(
        matches!(err, GitError::BranchCaseCollision { ref requested, ref existing } if requested == "alpha" && existing == "Alpha"),
        "{err:?}"
    );
    // HEAD did not move and no `alpha` branch was created.
}
```

In `tests/pr_checkout.rs` (reuse its fetch fixture; create local `PR/7` at HEAD; `set_ignorecase(true)`; open the session):

```rust
#[test]
fn checkout_pr_case_variant_of_existing_branch_is_case_collision() {
    let err = session.checkout_fetch_head(&fetch, 7, false).unwrap_err();
    assert!(
        matches!(err, GitError::BranchCaseCollision { ref requested, ref existing } if requested == "pr/7" && existing == "PR/7"),
        "{err:?}"
    );
    // `PR/7` still points where it did.
}
```

In the merge test file, `#[cfg(unix)]`: `Alpha` at commit X, `alpha` at a different commit Y, HEAD on the default branch, ignorecase on; the public call that goes through `resolve_branch` (`merge_branch` or the fast-forward check) must act on Y. Name it `merge_resolves_exact_spelling_when_both_spellings_exist`.

- [ ] **Step 2: Run them and confirm the observable reds**

Run: `cargo test --manifest-path src-tauri/crates/git-real-core/Cargo.toml --test branches --test pr_checkout --test <remote-checkout file> --test <merge file>`
Expected: `checkout_remote_case_variant_of_local_branch_is_case_collision` and `checkout_pr_case_variant_of_existing_branch_is_case_collision` FAIL (today the switch succeeds). The two "both spellings" tests and the merge test pass already on Linux (`find_branch` is exact there); they guard the new iteration path. The Windows test is red only in CI.

- [ ] **Step 3: Implement**

`refs/mod.rs`:

- `find_local`: when `ignores_case(repo)`, iterate `repo.branches(Some(BranchType::Local))` and return the branch whose `lossy_name(&branch) == name`; none → `GitError::BranchNotFound(name.to_owned())`. Otherwise keep the `find_branch` path. Doc comment: one sentence on why.
- `refuse_duplicate_branch`: `pub(crate)`.
- `checkout_remote_branch`: `match find_local(repo, name) { Ok(_) => { self.refuse_checked_out_elsewhere(name)?; SwitchTarget::Local(name) } Err(GitError::BranchNotFound(_)) => { refuse_duplicate_branch(repo, name, None)?; SwitchTarget::NewTracking { .. } } Err(e) => return Err(e) }`.

`merge/mod.rs` `resolve_branch`: local tip via `crate::refs::find_local(self.repo(), name).ok().and_then(|b| b.get().target())`, then the remote `find_branch(name, BranchType::Remote)` fallback as today.

`remote/pr_checkout.rs` `checkout_fetch_head`: `let current = match find_local(repo, &name) { Ok(b) => b.get().target(), Err(GitError::BranchNotFound(_)) => { refuse_duplicate_branch(repo, &name, None)?; None } Err(e) => return Err(e) };` (import both from `crate::refs`; drop the now-unused `BranchType`/`is_not_found` imports if nothing else uses them).

- [ ] **Step 4: Run the checks**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --workspace
cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/git-real-core/src/refs/mod.rs src-tauri/crates/git-real-core/src/merge/mod.rs src-tauri/crates/git-real-core/src/remote/pr_checkout.rs src-tauri/crates/git-real-core/tests/
git commit -m "fix(GR-32): make every local branch lookup case-exact on case-insensitive repositories"
```

---

### Task 5: Canonical paths without the Windows verbatim prefix

Spec §6.2. Owner decision: fixed here, not ticketed.

**Files:**

- Modify: `src-tauri/crates/git-real-core/Cargo.toml` (add `dunce = "1"` under `[dependencies]`; it is already in `Cargo.lock`)
- Create: `src-tauri/crates/git-real-core/src/paths.rs`; register `mod paths;` in `lib.rs`
- Modify: `src/repo/session.rs:89,105`, `src/linked_worktrees/mod.rs:33,159,206,230,260`, `src/remote/clone.rs:76` — every `canonicalize` call becomes `paths::canonical(..)`
- Modify: `tests/common/mod.rs` (add `pub fn canonical(path: &Path) -> PathBuf`), and every `canonicalize` call in `tests/linked_worktrees.rs`, `tests/cli_argv.rs`, `tests/push_delete.rs`, `tests/session.rs`, `tests/clone.rs` becomes `common::canonical(&..)` (`grep -rn canonicalize src-tauri/crates/git-real-core/tests` must then list only the test _name_ in `tests/recent.rs`)

**Interfaces:**

- Produces: `pub(crate) fn canonical(path: &Path) -> std::io::Result<PathBuf>` in `src/paths.rs` = `dunce::canonicalize(path)`, doc comment: the git CLI rejects `\\?\` verbatim paths, so every canonical path in this crate comes from here. `tests/common::canonical(path) -> PathBuf` = `dunce::canonicalize(path).unwrap()`.

- [ ] **Step 1: Write the failing tests (red on Windows only)**

`tests/session.rs`:

```rust
#[cfg(windows)]
#[test]
fn session_path_has_no_verbatim_prefix_on_windows() {
    let (_d, path) = common::temp_repo_with_commit();
    let session = RepoSession::open(&path).unwrap();
    assert!(!session.path().to_string_lossy().starts_with(r"\\?\"), "{:?}", session.path());
}
```

`tests/linked_worktrees.rs`:

```rust
#[cfg(windows)]
#[test]
fn listed_worktree_paths_have_no_verbatim_prefix_on_windows() {
    if !common::git_available() { return; }
    let (_md, main, _wd, root, _head) = fixture();
    add_worktree(&main, &root, "a", "feat/a");
    for w in session(&main).list_linked_worktrees().unwrap() {
        assert!(!w.path.to_string_lossy().starts_with(r"\\?\"), "{:?}", w.path);
    }
}
```

The 39 Windows failures of `tests/linked_worktrees.rs` on CI run 41110930528 are the red for the production change.

- [ ] **Step 2: Implement**

Add the dependency, the module, and the helper; replace the eight production calls and every test call as listed. `same_dir` becomes `matches!((canonical(a), canonical(b)), (Ok(a), Ok(b)) if a == b)`.

- [ ] **Step 3: Run the checks**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --workspace
cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
grep -rn canonicalize src-tauri/crates/git-real-core/src src-tauri/crates/git-real-core/tests
```

Expected: all green; the grep prints only `src/paths.rs` and the `touch_does_not_canonicalize_dot_dot_paths` test name.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.lock src-tauri/crates/git-real-core/Cargo.toml src-tauri/crates/git-real-core/src/lib.rs src-tauri/crates/git-real-core/src/paths.rs src-tauri/crates/git-real-core/src/repo/session.rs src-tauri/crates/git-real-core/src/linked_worktrees/mod.rs src-tauri/crates/git-real-core/src/remote/clone.rs src-tauri/crates/git-real-core/tests/
git commit -m "fix(GR-32): canonicalise paths without the Windows verbatim prefix so git accepts them"
```

---

### After the tasks (orchestrator, not a task)

- Push the branch and watch the Windows core job: it must pass the whole crate with no failures (Tasks 4 and 5 remove the only ones). Benchmarks' status-budget failure predates the branch.
- Whole-branch review of the new range, then `superpowers:finishing-a-development-branch`.
