//! Shared fixtures for integration tests.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use git_real_core::remote::git_cli;
use git_real_core::{Progress, ProgressSink};
use git_real_lib::recent_store::RecentStore;
use git_real_lib::state::RepoRegistry;

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

/// Returns a store file path named `name` inside a fresh temp dir.
/// The file is not created. Keep the `TempDir` alive for the path to be valid.
pub fn temp_file_path(name: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().join(name);
    (dir, path)
}

/// Clones `src` into a bare repo inside a fresh temp dir.
/// Returns the owning `TempDir` and the path of the bare repo.
pub fn temp_bare_clone(src: &Path) -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let dest = dir.path().join("bare.git");
    git2::build::RepoBuilder::new()
        .bare(true)
        .clone(src.to_str().expect("utf-8 path"), &dest)
        .expect("bare clone");
    (dir, dest)
}

/// Returns a `file://` URL for a local path.
pub fn file_url(path: &Path) -> String {
    format!("file://{}", path.display())
}

/// Test double: records every progress report so tests can inspect them.
pub struct RecordingSink(pub Vec<Progress>);

impl ProgressSink for RecordingSink {
    fn report(&mut self, progress: Progress) {
        self.0.push(progress);
    }
}

/// True when the system git CLI can be located; otherwise prints a skip notice.
pub fn git_available() -> bool {
    if git_cli::locate().is_err() {
        eprintln!("skipping: git not on PATH");
        return false;
    }
    true
}

/// A fresh registry plus a recent store backed by `<tmp>/recent-repos.json`.
/// Keep the `TempDir` alive for the store file to remain valid.
pub fn fresh_state() -> (TempDir, RepoRegistry, RecentStore) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let store = RecentStore::load(dir.path().join("recent-repos.json"));
    (dir, RepoRegistry::default(), store)
}

/// Sets a repo-local identity and turns signing off, so the developer's
/// global config (which may sign every commit) never reaches the test.
pub fn configure_identity(root: &Path) {
    let repo = Repository::open(root).expect("open repo");
    let mut config = repo.config().expect("config");
    config.set_str("user.name", "Test User").expect("set name");
    config
        .set_str("user.email", "test@example.com")
        .expect("set email");
    config
        .set_bool("commit.gpgsign", false)
        .expect("set gpgsign");
}
