//! What checkout and remote deletion do when the `git` executable is missing
//! or cannot be run (GR-7). `PATH` is process-wide, so every test takes the
//! lock and restores it afterwards.

#![cfg(unix)]

mod common;

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Mutex;

use git_real_core::{GitError, MergeMode, RepoSession};
use git2::{BranchType, Repository};

static PATH_LOCK: Mutex<()> = Mutex::new(());

/// Runs `body` with `PATH` set to `path`, then restores it.
fn with_path(path: OsString, body: impl FnOnce()) {
    let _guard = PATH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let old = std::env::var_os("PATH");
    // SAFETY: every test in this binary holds PATH_LOCK while touching PATH.
    unsafe { std::env::set_var("PATH", &path) };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    match old {
        Some(old) => unsafe { std::env::set_var("PATH", old) },
        None => unsafe { std::env::remove_var("PATH") },
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// A directory holding a `git` that exists but is not executable.
fn non_executable_git() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let git = dir.path().join("git");
    std::fs::write(&git, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o644)).unwrap();
    dir
}

fn fixture() -> (tempfile::TempDir, tempfile::TempDir, PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    let session = RepoSession::open(&path).unwrap();
    (dir, bare_dir, path, session)
}

fn empty_path() -> (tempfile::TempDir, OsString) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().as_os_str().to_owned();
    (dir, path)
}

#[test]
fn checkout_without_git_on_path_fails_with_git_cli_missing() {
    let (_d, _b, _path, session) = fixture();
    session.create_branch("topic", None).unwrap();
    let (_e, empty) = empty_path();
    with_path(empty, || {
        assert!(matches!(
            session.checkout_branch("topic").unwrap_err(),
            GitError::GitCliMissing
        ));
    });
}

#[test]
fn checkout_remote_without_git_on_path_fails_with_git_cli_missing() {
    let (_d, _b, path, session) = fixture();
    let head = common::head_branch_name(&path);
    let (_e, empty) = empty_path();
    with_path(empty, || {
        assert!(matches!(
            session.checkout_remote_branch("origin", &head).unwrap_err(),
            GitError::GitCliMissing
        ));
    });
}

#[test]
fn checkout_remote_validates_the_branch_before_looking_for_git() {
    let (_d, _b, _path, session) = fixture();
    let (_e, empty) = empty_path();
    with_path(empty, || {
        assert!(matches!(
            session
                .checkout_remote_branch("origin", "nope")
                .unwrap_err(),
            GitError::BranchNotFound(_)
        ));
    });
}

#[test]
fn create_and_checkout_without_git_leaves_no_branch_behind() {
    let (_d, _b, path, session) = fixture();
    let (_e, empty) = empty_path();
    with_path(empty, || {
        assert!(matches!(
            session
                .create_and_checkout_branch("topic", None)
                .unwrap_err(),
            GitError::GitCliMissing
        ));
    });
    assert!(
        Repository::open(&path)
            .unwrap()
            .find_branch("topic", BranchType::Local)
            .is_err()
    );
}

#[test]
fn prepare_remote_delete_without_git_on_path_fails_with_git_cli_missing() {
    let (_d, _b, path, session) = fixture();
    let head = common::head_branch_name(&path);
    let (_e, empty) = empty_path();
    with_path(empty, || {
        assert!(matches!(
            session.prepare_remote_delete("origin", &head).unwrap_err(),
            GitError::GitCliMissing
        ));
    });
}

#[test]
fn checkout_with_a_git_that_cannot_be_executed_fails_with_io() {
    let (_d, _b, _path, session) = fixture();
    session.create_branch("topic", None).unwrap();
    let broken = non_executable_git();
    with_path(broken.path().as_os_str().to_owned(), || {
        assert!(matches!(
            session.checkout_branch("topic").unwrap_err(),
            GitError::Io(_)
        ));
    });
}

#[test]
fn create_and_checkout_with_a_git_that_cannot_be_executed_removes_the_new_branch() {
    let (_d, _b, path, session) = fixture();
    let broken = non_executable_git();
    with_path(broken.path().as_os_str().to_owned(), || {
        assert!(matches!(
            session
                .create_and_checkout_branch("topic", None)
                .unwrap_err(),
            GitError::Io(_)
        ));
    });
    assert!(
        Repository::open(&path)
            .unwrap()
            .find_branch("topic", BranchType::Local)
            .is_err()
    );
}

#[test]
fn remote_delete_with_a_git_that_cannot_be_executed_fails_with_io() {
    let (_d, _b, path, session) = fixture();
    let head = common::head_branch_name(&path);
    let broken = non_executable_git();
    // The executable is located when the deletion is prepared.
    with_path(broken.path().as_os_str().to_owned(), || {
        let push = session.prepare_remote_delete("origin", &head).unwrap();
        assert!(matches!(push.run().unwrap_err(), GitError::Io(_)));
    });
}

// GR-10a: every CLI-backed operation reports a missing git.
fn operation_fixture() -> (tempfile::TempDir, PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("other", &commit, false).unwrap();
    }
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session)
}

#[test]
fn merge_branch_without_git_is_git_cli_missing() {
    let (_d, _path, session) = operation_fixture();
    let (_e, empty) = empty_path();
    with_path(empty, || {
        assert!(matches!(
            session.merge_branch("other", MergeMode::Merge).unwrap_err(),
            GitError::GitCliMissing
        ));
    });
}

#[test]
fn abort_and_continue_without_git_are_git_cli_missing() {
    let (_d, path, session) = operation_fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    let (_e, empty) = empty_path();
    with_path(empty, || {
        assert!(matches!(
            session.abort_operation().unwrap_err(),
            GitError::GitCliMissing
        ));
        assert!(matches!(
            session.continue_rebase().unwrap_err(),
            GitError::GitCliMissing
        ));
    });
}

// GR-10a: a git that cannot be executed is an Io error for every CLI-backed operation.
#[test]
fn operations_with_a_git_that_cannot_be_executed_fail_with_io() {
    let (_d, path, session) = operation_fixture();
    let oid = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
        .to_string();
    let broken = non_executable_git();
    with_path(broken.path().as_os_str().to_owned(), || {
        assert!(matches!(
            session.merge_branch("other", MergeMode::Merge).unwrap_err(),
            GitError::Io(_)
        ));
        assert!(matches!(
            session.rebase_onto("other").unwrap_err(),
            GitError::Io(_)
        ));
        assert!(matches!(
            session.cherry_pick(&oid).unwrap_err(),
            GitError::Io(_)
        ));
        assert!(matches!(
            session.revert_commit(&oid).unwrap_err(),
            GitError::Io(_)
        ));
    });
}

#[test]
fn abort_and_continue_with_a_git_that_cannot_be_executed_fail_with_io() {
    let (_d, path, session) = operation_fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    let broken = non_executable_git();
    with_path(broken.path().as_os_str().to_owned(), || {
        assert!(matches!(
            session.abort_operation().unwrap_err(),
            GitError::Io(_)
        ));
        assert!(matches!(
            session.continue_rebase().unwrap_err(),
            GitError::Io(_)
        ));
    });
}

#[test]
fn cherry_pick_and_revert_without_git_are_git_cli_missing() {
    let (_d, path, session) = operation_fixture();
    let oid = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
        .to_string();
    let (_e, empty) = empty_path();
    with_path(empty, || {
        assert!(matches!(
            session.cherry_pick(&oid).unwrap_err(),
            GitError::GitCliMissing
        ));
        assert!(matches!(
            session.revert_commit(&oid).unwrap_err(),
            GitError::GitCliMissing
        ));
        assert!(matches!(
            session.rebase_onto("other").unwrap_err(),
            GitError::GitCliMissing
        ));
    });
}
