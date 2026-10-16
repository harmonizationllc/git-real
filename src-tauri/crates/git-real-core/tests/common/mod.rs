//! Shared fixtures for integration tests.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use git2::{Repository, Signature};
use tempfile::TempDir;

/// Creates a temp repo with a single commit containing `README.md`.
/// The returned `TempDir` must be kept alive for the repo to exist.
pub fn temp_repo_with_commit() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    let repo = Repository::init(&path).expect("init repo");

    std::fs::write(path.join("README.md"), "# fixture\n").expect("write README");
    let mut index = repo.index().expect("open index");
    index
        .add_path(Path::new("README.md"))
        .expect("stage README");
    index.write().expect("write index");
    let tree_id = index.write_tree().expect("write tree");
    let tree = repo.find_tree(tree_id).expect("find tree");
    let sig = Signature::now("Test User", "test@example.com").expect("signature");
    repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
        .expect("commit");

    drop(tree);
    drop(repo);
    (dir, path)
}

/// Bare-clones `src` (a local path, no network) into a new temp dir.
pub fn temp_bare_clone(src: &Path) -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let dest = dir.path().join("bare.git");
    git2::build::RepoBuilder::new()
        .bare(true)
        .clone(src.to_str().expect("utf-8 path"), &dest)
        .expect("bare clone");
    (dir, dest)
}

/// Creates a repo whose config declares an unsupported `repositoryformatversion`,
/// so libgit2 fails to open it with a non-NotFound error.
pub fn temp_repo_with_unsupported_format() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    Repository::init(&path).expect("init repo");
    let config = path.join(".git").join("config");
    let text = std::fs::read_to_string(&config).expect("read config");
    assert!(text.contains("repositoryformatversion = 0"));
    std::fs::write(
        &config,
        text.replace(
            "repositoryformatversion = 0",
            "repositoryformatversion = 99",
        ),
    )
    .expect("write config");
    (dir, path)
}
