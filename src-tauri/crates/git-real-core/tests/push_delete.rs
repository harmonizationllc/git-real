//! Remote branch deletion through `git push <remote> --delete` (GR-7), against
//! a local bare repository. No network is involved. Tests that run the push
//! return early when the git CLI is not on PATH; pre-check failures always run.

mod common;

use std::path::PathBuf;

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

/// Fixture with a fetched bare remote `origin` that holds a `feature` branch.
fn fixture() -> (tempfile::TempDir, tempfile::TempDir, PathBuf, PathBuf) {
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
    (dir, bare_dir, path, bare)
}

fn bare_has_branch(bare: &std::path::Path, name: &str) -> bool {
    Repository::open_bare(bare)
        .unwrap()
        .find_branch(name, BranchType::Local)
        .is_ok()
}

fn tracking_ref_exists(path: &std::path::Path, name: &str) -> bool {
    Repository::open(path)
        .unwrap()
        .find_reference(&format!("refs/remotes/origin/{name}"))
        .is_ok()
}

// --- prepare_remote_delete: validation before any network call ---

#[test]
fn prepare_rejects_an_unknown_remote() {
    let (_d, _b, path, _bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    let err = session
        .prepare_remote_delete("nope", "feature")
        .unwrap_err();
    assert!(matches!(err, GitError::RemoteNotFound(n) if n == "nope"));
}

#[test]
fn prepare_rejects_an_unknown_remote_branch() {
    let (_d, _b, path, _bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    let err = session.prepare_remote_delete("origin", "nope").unwrap_err();
    assert!(matches!(err, GitError::BranchNotFound(n) if n == "origin/nope"));
}

#[test]
fn prepare_rejects_a_leading_dash_name() {
    let (_d, _b, path, _bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    let err = session.prepare_remote_delete("origin", "-x").unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(n) if n == "-x"));
}

#[test]
fn prepare_rejects_an_invalid_name() {
    let (_d, _b, path, _bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    let err = session.prepare_remote_delete("origin", "a..b").unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(_)));
}

#[test]
fn prepare_returns_the_validated_remote_and_branch() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    assert_eq!(push.remote(), "origin");
    assert_eq!(push.name(), "feature");
}

#[test]
fn prepare_returns_the_repository_workdir() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    assert_eq!(
        push.workdir().canonicalize().unwrap(),
        path.canonicalize().unwrap()
    );
}

#[test]
fn prepare_does_not_touch_the_remote() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    session.prepare_remote_delete("origin", "feature").unwrap();
    assert!(bare_has_branch(&bare, "feature"));
}

// --- PushDelete::run ---

#[test]
fn run_deletes_the_branch_on_the_bare_remote() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    session
        .prepare_remote_delete("origin", "feature")
        .unwrap()
        .run()
        .unwrap();
    assert!(!bare_has_branch(&bare, "feature"));
}

#[test]
fn run_removes_the_remote_tracking_ref() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    session
        .prepare_remote_delete("origin", "feature")
        .unwrap()
        .run()
        .unwrap();
    assert!(!tracking_ref_exists(&path, "feature"));
}

#[test]
fn run_leaves_the_local_branch_and_other_remote_branches_alone() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, bare) = fixture();
    let head = common::head_branch_name(&path);
    let session = RepoSession::open(&path).unwrap();
    session
        .prepare_remote_delete("origin", "feature")
        .unwrap()
        .run()
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    assert!(repo.find_branch("feature", BranchType::Local).is_ok());
    assert!(bare_has_branch(&bare, &head));
}

#[test]
fn run_reports_push_failure_when_the_remote_branch_is_already_gone() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    Repository::open_bare(&bare)
        .unwrap()
        .find_branch("feature", BranchType::Local)
        .unwrap()
        .delete()
        .unwrap();
    match push.run().unwrap_err() {
        GitError::PushFailed { code, stderr, .. } => {
            assert_eq!(code, Some(1));
            assert!(!stderr.trim().is_empty());
        }
        other => panic!("expected PushFailed, got {other:?}"),
    }
}

#[test]
fn run_reports_push_failure_when_the_remote_is_unreachable() {
    if !git_available() {
        return;
    }
    let (_d, bare_dir, path, _bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    Repository::open(&path)
        .unwrap()
        .remote_set_url(
            "origin",
            bare_dir.path().join("missing.git").to_str().unwrap(),
        )
        .unwrap();
    assert!(matches!(
        push.run().unwrap_err(),
        GitError::PushFailed { stderr, .. } if !stderr.trim().is_empty()
    ));
}

#[test]
fn run_keeps_the_remote_tracking_ref_when_the_push_fails() {
    if !git_available() {
        return;
    }
    let (_d, bare_dir, path, _bare) = fixture();
    let session = RepoSession::open(&path).unwrap();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    Repository::open(&path)
        .unwrap()
        .remote_set_url(
            "origin",
            bare_dir.path().join("missing.git").to_str().unwrap(),
        )
        .unwrap();
    let _ = push.run();
    assert!(tracking_ref_exists(&path, "feature"));
}

// --- a remote named like a flag must never reach argv ---

#[test]
fn prepare_rejects_a_remote_whose_name_starts_with_a_dash() {
    let (_d, _b, path, bare) = fixture();
    let head = common::head_branch_name(&path);
    Repository::open(&path)
        .unwrap()
        .remote("-x", bare.to_str().unwrap())
        .unwrap();
    common::fetch_remote(&path, "-x");
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(
        session.prepare_remote_delete("-x", &head).unwrap_err(),
        GitError::RemoteNotFound(name) if name == "-x"
    ));
}
