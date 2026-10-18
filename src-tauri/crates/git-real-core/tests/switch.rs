//! Checkout through `git switch` (GR-7). Tests that reach the git CLI return
//! early when it is not on PATH, like `commit.rs`; pre-check failures do not
//! need it and always run.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::git_cli;
use git_real_core::{GitError, RepoSession};
use git2::{BranchType, Repository};

fn git_available() -> bool {
    if git_cli::locate().is_err() {
        eprintln!("skipping: git not on PATH");
        return false;
    }
    true
}

/// Repo with one commit, local identity, signing off.
fn fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session, head)
}

/// Fixture plus a fetched local bare remote `origin` holding a `feature`
/// branch. The local `feature` branch is deleted again unless `keep_local`.
fn remote_fixture(
    keep_local: bool,
) -> (
    tempfile::TempDir,
    tempfile::TempDir,
    PathBuf,
    PathBuf,
    String,
) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &commit, false).unwrap();
    }
    common::push_branch(&path, "feature");
    common::fetch_remote(&path, "origin");
    if !keep_local {
        let repo = Repository::open(&path).unwrap();
        repo.find_branch("feature", BranchType::Local)
            .unwrap()
            .delete()
            .unwrap();
    }
    (dir, bare_dir, path, bare, head)
}

fn head_ref(path: &Path) -> String {
    common::head_branch_name(path)
}

fn config_string(path: &Path, key: &str) -> Option<String> {
    Repository::open(path)
        .unwrap()
        .config()
        .unwrap()
        .get_string(key)
        .ok()
}

// --- checkout_branch: local switch ---

#[test]
fn checkout_local_moves_head_to_the_branch() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = fixture();
    session.create_branch("b", None).unwrap();
    session.checkout_branch("b").unwrap();
    assert_eq!(head_ref(&path), "b");
}

#[test]
fn checkout_the_current_branch_is_ok() {
    if !git_available() {
        return;
    }
    let (_d, path, session, head) = fixture();
    session.checkout_branch(&head).unwrap();
    assert_eq!(head_ref(&path), head);
}

#[test]
fn checkout_updates_the_working_tree() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = fixture();
    common::branch_with_commit(&path, "b", "only-on-b.txt", "b\n");
    assert!(!path.join("only-on-b.txt").exists());
    session.checkout_branch("b").unwrap();
    assert!(path.join("only-on-b.txt").exists());
}

#[test]
fn checkout_a_missing_branch_fails_with_branch_not_found() {
    let (_d, _p, session, _head) = fixture();
    let err = session.checkout_branch("ghost").unwrap_err();
    assert!(matches!(err, GitError::BranchNotFound(n) if n == "ghost"));
}

#[test]
fn checkout_rejects_a_leading_dash_name() {
    let (_d, _p, session, _head) = fixture();
    let err = session.checkout_branch("-x").unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(n) if n == "-x"));
}

#[test]
fn checkout_rejects_an_invalid_name() {
    let (_d, _p, session, _head) = fixture();
    let err = session.checkout_branch("a..b").unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(_)));
}

// --- checkout_branch: git's own refusal and hooks ---

fn dirty_conflict_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (d, path, session, head) = fixture();
    common::branch_with_commit(&path, "b", "README.md", "# changed on b\n");
    std::fs::write(path.join("README.md"), "# dirty edit\n").unwrap();
    (d, path, session, head)
}

#[test]
fn checkout_with_a_conflicting_dirty_file_fails_with_gits_stderr() {
    if !git_available() {
        return;
    }
    let (_d, _p, session, _head) = dirty_conflict_fixture();
    let err = session.checkout_branch("b").unwrap_err();
    match err {
        GitError::CheckoutFailed { code, stderr, .. } => {
            assert_ne!(code, Some(0));
            assert!(stderr.contains("overwritten"), "stderr was: {stderr}");
        }
        other => panic!("expected CheckoutFailed, got {other:?}"),
    }
}

#[test]
fn checkout_with_a_conflicting_dirty_file_keeps_head_unchanged() {
    if !git_available() {
        return;
    }
    let (_d, path, session, head) = dirty_conflict_fixture();
    let _ = session.checkout_branch("b");
    assert_eq!(head_ref(&path), head);
}

#[test]
fn checkout_with_a_conflicting_dirty_file_keeps_the_local_edit() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = dirty_conflict_fixture();
    let _ = session.checkout_branch("b");
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# dirty edit\n"
    );
}

#[cfg(unix)]
#[test]
fn checkout_runs_the_post_checkout_hook() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = fixture();
    // Repo-local hooksPath so a developer's global hooksPath cannot hide the hook.
    let hooks = path.join(".git").join("hooks");
    Repository::open(&path)
        .unwrap()
        .config()
        .unwrap()
        .set_str("core.hooksPath", hooks.to_str().unwrap())
        .unwrap();
    common::install_hook(&path, "post-checkout", "touch hook-ran");
    session.create_branch("b", None).unwrap();
    session.checkout_branch("b").unwrap();
    assert!(path.join("hook-ran").exists());
}

// --- checkout_remote_branch ---

#[test]
fn checkout_remote_creates_a_local_branch_and_moves_head_to_it() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(head_ref(&path), "feature");
}

#[test]
fn checkout_remote_sets_the_tracking_remote() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(
        config_string(&path, "branch.feature.remote").as_deref(),
        Some("origin")
    );
}

#[test]
fn checkout_remote_sets_the_tracking_merge_ref() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(
        config_string(&path, "branch.feature.merge").as_deref(),
        Some("refs/heads/feature")
    );
}

#[test]
fn checkout_remote_switches_to_an_existing_local_branch_of_that_name() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = remote_fixture(true);
    let session = RepoSession::open(&path).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(head_ref(&path), "feature");
}

#[test]
fn checkout_remote_with_an_existing_local_branch_does_not_add_tracking() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = remote_fixture(true);
    let session = RepoSession::open(&path).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(config_string(&path, "branch.feature.remote"), None);
}

#[test]
fn checkout_remote_with_an_unknown_remote_fails() {
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    let err = session
        .checkout_remote_branch("nope", "feature")
        .unwrap_err();
    assert!(matches!(err, GitError::RemoteNotFound(n) if n == "nope"));
}

#[test]
fn checkout_remote_with_an_unknown_branch_fails() {
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    let err = session
        .checkout_remote_branch("origin", "nope")
        .unwrap_err();
    assert!(matches!(err, GitError::BranchNotFound(n) if n == "origin/nope"));
}

#[test]
fn checkout_remote_rejects_an_invalid_branch_name() {
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    let err = session.checkout_remote_branch("origin", "-x").unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(n) if n == "-x"));
}

#[test]
fn checkout_remote_blocked_by_a_dirty_file_fails_with_checkout_failed() {
    if !git_available() {
        return;
    }
    let (_d, _path, session) = blocked_remote_fixture();
    let err = session
        .checkout_remote_branch("origin", "remote-only")
        .unwrap_err();
    assert!(matches!(err, GitError::CheckoutFailed { .. }));
}

#[test]
fn checkout_remote_blocked_by_a_dirty_file_creates_no_local_branch() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = blocked_remote_fixture();
    let _ = session.checkout_remote_branch("origin", "remote-only");
    let repo = Repository::open(&path).unwrap();
    assert!(repo.find_branch("remote-only", BranchType::Local).is_err());
}

/// `origin/remote-only` changes README.md while the working tree has an
/// uncommitted edit to it, so git must refuse the switch.
fn blocked_remote_fixture() -> ((tempfile::TempDir, tempfile::TempDir), PathBuf, RepoSession) {
    let (d, b, path, _bare, _head) = remote_fixture(false);
    common::branch_with_commit(&path, "remote-only", "README.md", "# remote\n");
    common::push_branch(&path, "remote-only");
    common::fetch_remote(&path, "origin");
    Repository::open(&path)
        .unwrap()
        .find_branch("remote-only", BranchType::Local)
        .unwrap()
        .delete()
        .unwrap();
    std::fs::write(path.join("README.md"), "# dirty\n").unwrap();
    let session = RepoSession::open(&path).unwrap();
    ((d, b), path, session)
}
