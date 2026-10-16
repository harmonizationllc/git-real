mod common;

use git_real_core::{GitError, RepoSession};

// --- open: valid and invalid targets ---

#[test]
fn open_existing_repo_succeeds() {
    let (dir, path) = common::temp_repo_with_commit();
    let session = RepoSession::open(&path).expect("open should succeed");
    let expected = dir
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(session.summary().name, expected);
}

#[test]
fn open_missing_path_is_path_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");
    let err = RepoSession::open(&missing).err().expect("should fail");
    match err {
        GitError::PathNotFound(p) => assert_eq!(p, missing),
        other => panic!("expected PathNotFound, got {other:?}"),
    }
}

#[test]
fn open_plain_folder_is_not_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    let err = RepoSession::open(dir.path()).err().expect("should fail");
    assert!(matches!(err, GitError::NotARepository(_)));
}

#[test]
fn open_subfolder_of_repo_is_not_a_repository() {
    let (_dir, path) = common::temp_repo_with_commit();
    let sub = path.join("sub");
    std::fs::create_dir(&sub).unwrap();
    let err = RepoSession::open(&sub).err().expect("should fail");
    assert!(matches!(err, GitError::NotARepository(_)));
}

// --- init: creating repositories ---

#[test]
fn init_empty_folder_creates_repo() {
    let dir = tempfile::tempdir().unwrap();
    RepoSession::init(dir.path()).expect("init should succeed");
    assert!(RepoSession::open(dir.path()).is_ok());
}

#[test]
fn init_non_empty_non_git_folder_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("notes.txt"), "hi").unwrap();
    assert!(RepoSession::init(dir.path()).is_ok());
}

#[test]
fn init_missing_folder_creates_it() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("nested").join("new-repo");
    RepoSession::init(&target).expect("init should succeed");
    assert!(target.exists());
}

#[test]
fn init_existing_repo_is_already_a_repository() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = RepoSession::init(&path).err().expect("should fail");
    assert!(matches!(err, GitError::AlreadyARepository(_)));
}

// --- summary: head branch ---

#[test]
fn summary_head_branch_after_commit() {
    let (_dir, path) = common::temp_repo_with_commit();
    let expected = {
        let repo = git2::Repository::open(&path).unwrap();
        let head = repo.head().unwrap();
        head.shorthand().unwrap().to_string()
    };
    let session = RepoSession::open(&path).unwrap();
    assert_eq!(session.summary().head_branch, Some(expected));
}

#[test]
fn summary_head_branch_after_fresh_init_is_unborn_branch_name() {
    let dir = tempfile::tempdir().unwrap();
    let session = RepoSession::init(dir.path()).unwrap();
    assert!(session.summary().head_branch.is_some());
}

#[test]
fn summary_head_branch_none_when_detached() {
    let (_dir, path) = common::temp_repo_with_commit();
    {
        let repo = git2::Repository::open(&path).unwrap();
        let oid = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.set_head_detached(oid).unwrap();
    }
    let session = RepoSession::open(&path).unwrap();
    assert_eq!(session.summary().head_branch, None);
}

// --- summary: bare repositories ---

#[test]
fn summary_is_bare_for_bare_repo() {
    let (_src, src_path) = common::temp_repo_with_commit();
    let (_dir, bare_path) = common::temp_bare_clone(&src_path);
    let summary = RepoSession::open(&bare_path).unwrap().summary();
    assert!(summary.is_bare);
}

#[test]
fn summary_head_branch_present_for_bare_repo() {
    let (_src, src_path) = common::temp_repo_with_commit();
    let (_dir, bare_path) = common::temp_bare_clone(&src_path);
    let summary = RepoSession::open(&bare_path).unwrap().summary();
    assert!(summary.head_branch.is_some());
}

// --- summary: path canonicalization ---

#[test]
fn summary_path_is_canonical_for_trailing_dot_segment() {
    let (_dir, path) = common::temp_repo_with_commit();
    let canonical = std::fs::canonicalize(&path).unwrap();
    let session = RepoSession::open(path.join(".")).unwrap();
    assert_eq!(session.summary().path, canonical);
}

#[test]
fn summary_path_is_canonical_for_parent_segment() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::create_dir(path.join("sub")).unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();
    let session = RepoSession::open(path.join("sub").join("..")).unwrap();
    assert_eq!(session.summary().path, canonical);
}
