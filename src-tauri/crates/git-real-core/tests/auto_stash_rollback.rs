//! Auto-stash failure paths that real git will not produce on demand: a
//! refused second switch, a failing stash push, apply or drop. A stand-in
//! `git` first on `PATH` runs the real git unless the repo holds a behaviour
//! file for the call: `.git/switch-<n>` for the n-th `switch` (counted in
//! `.git/switch-count`), `.git/stash-<sub>` for `stash <sub>`. A behaviour
//! file is sourced, so it can `exit` with scripted output or call the real
//! git as `"$REAL"` first. `PATH` is process-wide, so these tests have their
//! own binary and set it exactly once.

#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use git_real_core::{AutoStashReapply, GitError, RepoSession};

static FAKE_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();

/// Puts the stand-in first on `PATH`, pointing it at the real git found there now.
fn use_scripted_git() {
    FAKE_DIR.get_or_init(|| {
        let old = std::env::var_os("PATH").unwrap_or_default();
        let real = git_real_core::git_cli::locate_in(&old).expect("real git on PATH");
        let script = format!(
            r#"REAL='{}'
G="$2/.git"
case "$3" in
switch)
  n=$(( $(cat "$G/switch-count" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$G/switch-count"
  [ -f "$G/switch-$n" ] && . "$G/switch-$n"
  ;;
stash)
  [ -f "$G/stash-$4" ] && . "$G/stash-$4"
  ;;
esac
exec "$REAL" "$@""#,
            real.display()
        );
        let dir = tempfile::tempdir().expect("temp dir");
        common::fake_git(dir.path(), &script);
        let mut paths = vec![dir.path().to_path_buf()];
        paths.extend(std::env::split_paths(&old));
        // SAFETY: runs inside `get_or_init`, before any test body reads PATH.
        unsafe { std::env::set_var("PATH", std::env::join_paths(paths).unwrap()) };
        dir
    });
}

/// Scripts the stand-in's behaviour for `name` (`switch-2`, `stash-push`, ...).
fn behave(path: &Path, name: &str, body: &str) {
    std::fs::write(path.join(".git").join(name), body).unwrap();
}

const REFUSE: &str = "echo 'hook says no' >&2; exit 1\n";

/// README.md on HEAD; `b` changes its first line, the dirty edit its last, so
/// a real pop on `b` applies cleanly.
const BASE: &str = "top\n1\n2\n3\n4\n5\nbottom\n";
const ON_B: &str = "top on b\n1\n2\n3\n4\n5\nbottom\n";
const DIRTY: &str = "top\n1\n2\n3\n4\n5\nbottom dirty\n";
const MERGED: &str = "top on b\n1\n2\n3\n4\n5\nbottom dirty\n";

/// Branch `b` changes README.md; the tree holds a dirty README.md, so the
/// real `git switch b` refuses on a tracked file.
fn collision_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    use_scripted_git();
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    common::commit_file(&path, "README.md", BASE, "base");
    let head = common::head_branch_name(&path);
    common::branch_with_commit(&path, "b", "README.md", ON_B);
    std::fs::write(path.join("README.md"), DIRTY).unwrap();
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session, head)
}

fn readme(path: &Path) -> String {
    std::fs::read_to_string(path.join("README.md")).unwrap()
}

// --- the switch after the stash is refused ---

#[test]
fn a_refused_second_switch_restores_the_tree() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, head) = collision_fixture();
    behave(&path, "switch-2", REFUSE);
    let err = session.checkout_branch("b").unwrap_err();
    assert!(
        matches!(&err, GitError::CheckoutFailed { stderr, .. } if stderr.contains("hook says no")),
        "{err:?}"
    );
    assert_eq!(common::head_branch_name(&path), head);
    assert_eq!(readme(&path), DIRTY);
    assert!(session.list_stashes().unwrap().is_empty());
}

#[test]
fn a_restore_that_cannot_drop_the_stash_says_the_stash_is_kept() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, head) = collision_fixture();
    behave(&path, "switch-2", REFUSE);
    behave(&path, "stash-drop", "echo 'drop broke' >&2; exit 1\n");
    let err = session.checkout_branch("b").unwrap_err();
    assert!(
        matches!(&err, GitError::CheckoutFailedStashKept { stderr, .. } if stderr.contains("hook says no")),
        "{err:?}"
    );
    assert_eq!(common::head_branch_name(&path), head);
    assert_eq!(readme(&path), DIRTY);
    assert_eq!(session.list_stashes().unwrap().len(), 1);
}

#[test]
fn a_restore_that_cannot_apply_the_stash_says_the_stash_is_kept() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, head) = collision_fixture();
    behave(&path, "switch-2", REFUSE);
    behave(&path, "stash-apply", "echo 'apply broke' >&2; exit 1\n");
    let err = session.checkout_branch("b").unwrap_err();
    assert!(
        matches!(&err, GitError::CheckoutFailedStashKept { .. }),
        "{err:?}"
    );
    assert_eq!(common::head_branch_name(&path), head);
    assert_eq!(session.list_stashes().unwrap().len(), 1);
}

#[test]
fn create_and_checkout_deletes_the_branch_when_the_switch_after_the_stash_fails() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, head) = collision_fixture();
    behave(&path, "switch-2", REFUSE);
    let err = session
        .create_and_checkout_branch("topic", Some("b"))
        .unwrap_err();
    assert!(matches!(&err, GitError::CheckoutFailed { .. }), "{err:?}");
    let repo = git2::Repository::open(&path).unwrap();
    assert!(repo.find_branch("topic", git2::BranchType::Local).is_err());
    assert_eq!(common::head_branch_name(&path), head);
    assert_eq!(readme(&path), DIRTY);
    assert!(session.list_stashes().unwrap().is_empty());
}

// --- the stash push fails ---

#[test]
fn a_failed_stash_push_returns_the_original_refusal() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, head) = collision_fixture();
    behave(&path, "stash-push", "echo 'push broke' >&2; exit 1\n");
    let err = session.checkout_branch("b").unwrap_err();
    assert!(
        matches!(&err, GitError::CheckoutFailed { stderr, .. } if stderr.contains("would be overwritten")),
        "{err:?}"
    );
    assert_eq!(common::head_branch_name(&path), head);
    assert_eq!(readme(&path), DIRTY);
    assert!(session.list_stashes().unwrap().is_empty());
}

#[test]
fn a_stash_push_that_stashes_then_fails_is_restored() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, head) = collision_fixture();
    behave(
        &path,
        "stash-push",
        "\"$REAL\" \"$@\" >/dev/null; echo 'reset broke' >&2; exit 1\n",
    );
    let err = session.checkout_branch("b").unwrap_err();
    assert!(
        matches!(&err, GitError::CheckoutFailed { stderr, .. } if stderr.contains("would be overwritten")),
        "{err:?}"
    );
    assert_eq!(common::head_branch_name(&path), head);
    assert_eq!(readme(&path), DIRTY);
    assert!(session.list_stashes().unwrap().is_empty());
}

// --- the pop on the target fails ---

#[test]
fn a_pop_that_fails_outright_reports_kept_with_its_output() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, _head) = collision_fixture();
    behave(&path, "stash-apply", "echo 'apply broke' >&2; exit 1\n");
    let out = session.checkout_branch("b").unwrap();
    let report = out.auto_stash.unwrap();
    assert_eq!(report.reapply, AutoStashReapply::Kept);
    assert_eq!(report.files, 1);
    assert!(
        report
            .detail
            .as_deref()
            .unwrap_or("")
            .contains("apply broke"),
        "{report:?}"
    );
    assert_eq!(common::head_branch_name(&path), "b");
    assert_eq!(readme(&path), ON_B);
    assert_eq!(session.list_stashes().unwrap().len(), 1);
}

#[test]
fn a_pop_that_cannot_drop_reports_applied_not_dropped() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, _head) = collision_fixture();
    behave(&path, "stash-drop", "echo 'drop broke' >&2; exit 1\n");
    let out = session.checkout_branch("b").unwrap();
    let report = out.auto_stash.unwrap();
    assert_eq!(report.reapply, AutoStashReapply::AppliedNotDropped);
    assert_eq!(report.detail, None);
    assert_eq!(common::head_branch_name(&path), "b");
    assert_eq!(readme(&path), MERGED);
    assert_eq!(session.list_stashes().unwrap().len(), 1);
}
