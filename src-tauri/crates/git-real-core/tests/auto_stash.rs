//! Auto-stash on checkout: when git refuses a switch only because tracked local
//! changes would be overwritten, the changes are stashed, the switch runs again
//! and the stash is popped on the target. Every test here runs the real git CLI.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{AutoStash, AutoStashReapply, GitError, RepoSession};
use git2::Repository;

/// Repo with one commit, local identity, signing off.
fn fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session, head)
}

/// Fixture plus branch `branch` whose one commit writes `file` = `content`.
fn fixture_with_branch_file(
    branch: &str,
    file: &str,
    content: &str,
) -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (d, path, session, head) = fixture();
    common::branch_with_commit(&path, branch, file, content);
    (d, path, session, head)
}

/// README.md on HEAD; `b` changes its first line, the dirty edit its last, so
/// the two never touch the same hunk and the pop on `b` applies cleanly.
const BASE: &str = "top\n1\n2\n3\n4\n5\nbottom\n";
const ON_B: &str = "top on b\n1\n2\n3\n4\n5\nbottom\n";
const DIRTY: &str = "top\n1\n2\n3\n4\n5\nbottom dirty\n";
/// `b`'s README.md with the dirty edit reapplied.
const MERGED: &str = "top on b\n1\n2\n3\n4\n5\nbottom dirty\n";

/// Branch `b` changes README.md; the tree holds a dirty README.md, so a plain
/// `git switch b` refuses on a tracked file.
fn collision_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (d, path, session, head) = fixture();
    common::commit_file(&path, "README.md", BASE, "base");
    common::branch_with_commit(&path, "b", "README.md", ON_B);
    std::fs::write(path.join("README.md"), DIRTY).unwrap();
    (d, path, session, head)
}

/// As `collision_fixture`, but HEAD gains a commit changing README.md's last
/// line before the dirty edit, so the stash's base differs from `b` on the
/// line the edit touches and the pop on `b` conflicts.
fn collision_fixture_diverged() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (d, path, session, head) = fixture();
    common::commit_file(&path, "README.md", BASE, "base");
    common::branch_with_commit(&path, "b", "README.md", ON_B);
    common::commit_file(
        &path,
        "README.md",
        "top\n1\n2\n3\n4\n5\nbottom base2\n",
        "second",
    );
    std::fs::write(path.join("README.md"), DIRTY).unwrap();
    (d, path, session, head)
}

/// Commits `file` = `content` on the existing branch `branch`, then returns
/// the tree to the original HEAD.
fn commit_on_branch(path: &Path, branch: &str, file: &str, content: &str) {
    let repo = Repository::open(path).unwrap();
    let original = repo.head().unwrap().name().unwrap().to_owned();
    repo.set_head(&format!("refs/heads/{branch}")).unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    common::commit_file(path, file, content, &format!("{file} on {branch}"));
    repo.set_head(&original).unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
}

fn read(path: &Path, rel: &str) -> String {
    std::fs::read_to_string(path.join(rel)).unwrap()
}

// --- checkout_branch ---

#[test]
fn tracked_collision_switches_and_reapplies() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, _head) = collision_fixture();
    let out = session.checkout_branch("b").unwrap();
    assert_eq!(
        out.auto_stash,
        Some(AutoStash {
            files: 1,
            reapply: AutoStashReapply::Applied,
            detail: None
        })
    );
    assert_eq!(common::head_branch_name(&path), "b");
    assert_eq!(read(&path, "README.md"), MERGED);
    assert!(session.list_stashes().unwrap().is_empty());
}

#[test]
fn an_unrelated_untracked_file_stays_in_the_tree() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, _head) = collision_fixture();
    common::write_file(&path, "notes.txt", "mine\n");
    let out = session.checkout_branch("b").unwrap();
    assert_eq!(out.auto_stash.unwrap().files, 1);
    assert_eq!(read(&path, "notes.txt"), "mine\n");
    assert!(session.list_stashes().unwrap().is_empty());
}

#[test]
fn untracked_collision_is_refused_with_no_stash() {
    if !common::git_available() {
        return;
    }
    // b adds f.txt; the tree has an untracked f.txt
    let (_d, path, session, head) = fixture_with_branch_file("b", "f.txt", "on b\n");
    common::write_file(&path, "f.txt", "mine\n");
    let err = session.checkout_branch("b").unwrap_err();
    assert!(matches!(err, GitError::CheckoutFailed { .. }), "{err:?}");
    assert_eq!(common::head_branch_name(&path), head);
    assert_eq!(read(&path, "f.txt"), "mine\n");
    assert!(session.list_stashes().unwrap().is_empty());
}

#[test]
fn untracked_plus_tracked_collision_is_refused_with_no_stash() {
    if !common::git_available() {
        return;
    }
    // b changes README.md and adds f.txt; the tree edits README.md and has an untracked f.txt
    let (_d, path, session, head) = fixture_with_branch_file("b", "README.md", "# changed on b\n");
    commit_on_branch(&path, "b", "f.txt", "on b\n");
    std::fs::write(path.join("README.md"), "# dirty edit\n").unwrap();
    common::write_file(&path, "f.txt", "mine\n");
    let err = session.checkout_branch("b").unwrap_err();
    assert!(matches!(err, GitError::CheckoutFailed { .. }), "{err:?}");
    assert_eq!(common::head_branch_name(&path), head);
    assert_eq!(read(&path, "README.md"), "# dirty edit\n");
    assert_eq!(read(&path, "f.txt"), "mine\n");
    assert!(session.list_stashes().unwrap().is_empty());
}

#[test]
fn a_non_colliding_edit_needs_no_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, _head) = fixture_with_branch_file("b", "other.txt", "b\n");
    std::fs::write(path.join("README.md"), "# dirty edit\n").unwrap();
    let out = session.checkout_branch("b").unwrap();
    assert_eq!(out.auto_stash, None);
    assert_eq!(read(&path, "README.md"), "# dirty edit\n");
    assert!(session.list_stashes().unwrap().is_empty());
}

#[test]
fn a_missing_branch_still_fails_before_any_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, session, _head) = collision_fixture();
    assert!(matches!(
        session.checkout_branch("ghost").unwrap_err(),
        GitError::BranchNotFound(_)
    ));
    assert!(session.list_stashes().unwrap().is_empty());
}

#[test]
fn pop_conflicts_keep_the_stash_and_report_conflicts() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session, _head) = collision_fixture_diverged();
    let out = session.checkout_branch("b").unwrap();
    assert_eq!(
        out.auto_stash.as_ref().unwrap().reapply,
        AutoStashReapply::Conflicts
    );
    assert_eq!(common::head_branch_name(&path), "b");
    let stashes = session.list_stashes().unwrap();
    assert_eq!(stashes.len(), 1);
    assert!(
        stashes[0]
            .message
            .contains("git-real: auto-stash before switching to b"),
        "{}",
        stashes[0].message
    );
    assert!(
        Repository::open(&path)
            .unwrap()
            .index()
            .unwrap()
            .has_conflicts()
    );
}

/// The detector matches on git's wording; this pins both phrases against the
/// installed git (under the `LC_ALL=C` the app runs it with), so a wording
/// change shows up here instead of as a silent fallback to the plain refusal.
#[test]
fn installed_git_prints_both_collision_phrases() {
    if !common::git_available() {
        return;
    }
    let (_d, path, _session, _head) =
        fixture_with_branch_file("b", "README.md", "# changed on b\n");
    commit_on_branch(&path, "b", "f.txt", "on b\n");
    std::fs::write(path.join("README.md"), "# dirty edit\n").unwrap();
    common::write_file(&path, "f.txt", "mine\n");
    let git = git_real_core::git_cli::locate().unwrap();
    let output = git_real_core::git_cli::command(&git)
        .arg("-C")
        .arg(&path)
        .args(["switch", "b"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Your local changes to the following files would be overwritten"),
        "{stderr}"
    );
    assert!(
        stderr.contains("untracked working tree files would be overwritten"),
        "{stderr}"
    );
}
