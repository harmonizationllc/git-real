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

// --- error arms: Io and Git2 ---

#[test]
fn init_on_regular_file_is_io_error() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a-file");
    std::fs::write(&file, "x").unwrap();
    let err = RepoSession::init(&file).err().expect("should fail");
    match err {
        GitError::Io(e) => assert_eq!(e.kind(), std::io::ErrorKind::AlreadyExists),
        other => panic!("expected Io, got {other:?}"),
    }
    assert!(file.is_file(), "file must be left untouched");
}

#[test]
fn open_on_regular_file_is_not_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a-file");
    std::fs::write(&file, "x").unwrap();
    let err = RepoSession::open(&file).err().expect("should fail");
    assert!(matches!(err, GitError::NotARepository(_)));
}

#[test]
fn open_repo_with_unsupported_format_is_git2_error() {
    let (_dir, path) = common::temp_repo_with_unsupported_format();
    let err = RepoSession::open(&path).err().expect("should fail");
    assert!(
        matches!(err, GitError::Git2(_)),
        "expected Git2, got {err:?}"
    );
}

#[test]
fn init_on_unreadable_repo_is_git2_error_and_does_not_modify_it() {
    let (_dir, path) = common::temp_repo_with_unsupported_format();
    let config = path.join(".git").join("config");
    let before = std::fs::read_to_string(&config).unwrap();
    let err = RepoSession::init(&path).err().expect("should fail");
    assert!(
        matches!(err, GitError::Git2(_)),
        "expected Git2, got {err:?}"
    );
    assert_eq!(std::fs::read_to_string(&config).unwrap(), before);
}

#[test]
fn open_dangling_gitfile_is_not_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".git"), "gitdir: /nonexistent/git-real\n").unwrap();
    let err = RepoSession::open(dir.path()).err().expect("should fail");
    assert!(matches!(err, GitError::NotARepository(_)));
}

#[test]
fn error_display_messages_match_spec() {
    let p = std::path::PathBuf::from("/x/y");
    assert_eq!(
        GitError::NotARepository(p.clone()).to_string(),
        "/x/y is not a Git repository"
    );
    assert_eq!(
        GitError::AlreadyARepository(p.clone()).to_string(),
        "/x/y is already a Git repository"
    );
    assert_eq!(GitError::PathNotFound(p).to_string(), "/x/y does not exist");
    assert_eq!(
        GitError::GitCliMissing.to_string(),
        "the git executable was not found on PATH"
    );
    assert_eq!(
        GitError::CloneFailed {
            code: Some(128),
            stderr: "boom".into()
        }
        .to_string(),
        "git clone failed (exit code Some(128)): boom"
    );
}

// --- summary: is_bare, name, path accessor ---

#[test]
fn summary_is_not_bare_for_working_tree_repo() {
    let (_dir, path) = common::temp_repo_with_commit();
    assert!(!RepoSession::open(&path).unwrap().summary().is_bare);
}

#[test]
fn summary_name_for_bare_repo_is_directory_name() {
    let (_src, src_path) = common::temp_repo_with_commit();
    let (_dir, bare_path) = common::temp_bare_clone(&src_path);
    let summary = RepoSession::open(&bare_path).unwrap().summary();
    assert_eq!(summary.name, "bare.git");
}

#[test]
fn summary_path_for_bare_repo_is_canonical_gitdir_without_trailing_separator() {
    let (_src, src_path) = common::temp_repo_with_commit();
    let (_dir, bare_path) = common::temp_bare_clone(&src_path);
    let summary = RepoSession::open(&bare_path).unwrap().summary();
    assert_eq!(summary.path, std::fs::canonicalize(&bare_path).unwrap());
    assert!(!summary.path.to_string_lossy().ends_with('/'));
}

#[test]
fn summary_path_has_no_trailing_separator_for_trailing_slash_input() {
    let (_dir, path) = common::temp_repo_with_commit();
    let with_slash = format!("{}/", path.display());
    let session = RepoSession::open(&with_slash).unwrap();
    let summary = session.summary();
    assert_eq!(summary.path, std::fs::canonicalize(&path).unwrap());
    assert!(!summary.path.to_string_lossy().ends_with('/'));
}

#[test]
#[cfg(unix)]
fn summary_path_resolves_symlink_to_real_directory() {
    let (_dir, path) = common::temp_repo_with_commit();
    let links = tempfile::tempdir().unwrap();
    let link = links.path().join("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    let session = RepoSession::open(&link).unwrap();
    assert_eq!(
        session.summary().path,
        std::fs::canonicalize(&path).unwrap()
    );
    assert_eq!(
        session.summary().name,
        path.file_name().unwrap().to_string_lossy()
    );
}

#[test]
fn path_accessor_matches_summary_path() {
    let (_dir, path) = common::temp_repo_with_commit();
    let session = RepoSession::open(&path).unwrap();
    assert_eq!(session.path(), session.summary().path.as_path());
    assert_eq!(session.path(), std::fs::canonicalize(&path).unwrap());
}

#[test]
fn init_session_reports_canonical_path_and_name() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("nested").join("fresh");
    let session = RepoSession::init(&target).unwrap();
    let summary = session.summary();
    assert_eq!(summary.path, std::fs::canonicalize(&target).unwrap());
    assert_eq!(summary.name, "fresh");
    assert!(!summary.is_bare);
}

// --- summary: HEAD resolution edge cases ---

#[test]
fn summary_head_branch_fresh_init_matches_head_file() {
    let dir = tempfile::tempdir().unwrap();
    let session = RepoSession::init(dir.path()).unwrap();
    let head = std::fs::read_to_string(dir.path().join(".git").join("HEAD")).unwrap();
    let expected = head
        .trim()
        .strip_prefix("ref: refs/heads/")
        .expect("symbolic HEAD")
        .to_string();
    assert_eq!(session.summary().head_branch, Some(expected));
}

#[test]
fn summary_head_branch_keeps_slashes_in_branch_name() {
    let (_dir, path) = common::temp_repo_with_commit();
    {
        let repo = git2::Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature/deep/name", &commit, false).unwrap();
        repo.set_head("refs/heads/feature/deep/name").unwrap();
    }
    let session = RepoSession::open(&path).unwrap();
    assert_eq!(
        session.summary().head_branch,
        Some("feature/deep/name".to_string())
    );
}

#[test]
fn summary_head_branch_none_when_head_points_outside_refs_heads() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::write(
        path.join(".git").join("HEAD"),
        "ref: refs/remotes/origin/main\n",
    )
    .unwrap();
    let session = RepoSession::open(&path).unwrap();
    assert_eq!(session.summary().head_branch, None);
}
