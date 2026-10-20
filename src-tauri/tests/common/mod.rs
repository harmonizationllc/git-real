//! Shared fixtures for integration tests.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use git_real_core::git_cli;
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

/// Opt-out for machines without git: `GIT_REAL_SKIP_GIT_TESTS=1` skips the git CLI tests.
pub const SKIP_GIT_TESTS_ENV: &str = "GIT_REAL_SKIP_GIT_TESTS";

/// True when git is on PATH. Without git, panics unless the opt-out is set, so CI can never
/// pass with the CLI paths silently skipped.
pub fn git_available() -> bool {
    git_available_with(
        git_cli::locate().is_ok(),
        std::env::var(SKIP_GIT_TESTS_ENV).ok().as_deref(),
    )
}

/// The policy behind `git_available`, with its inputs explicit so it can be tested.
pub fn git_available_with(found: bool, opt_out: Option<&str>) -> bool {
    if found {
        return true;
    }
    if opt_out == Some("1") {
        eprintln!("skipping: git not on PATH ({SKIP_GIT_TESTS_ENV}=1)");
        return false;
    }
    panic!("git not on PATH: install git, or set {SKIP_GIT_TESTS_ENV}=1 to skip the git CLI tests");
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

/// Writes `name` with `content`, stages it and commits on HEAD; returns the new oid.
pub fn commit_file(path: &Path, name: &str, content: &str, message: &str) -> git2::Oid {
    let repo = Repository::open(path).expect("open repo");
    std::fs::write(path.join(name), content).expect("write file");
    let mut index = repo.index().expect("open index");
    index.add_path(Path::new(name)).expect("stage file");
    index.write().expect("write index");
    let tree = repo
        .find_tree(index.write_tree().expect("write tree"))
        .expect("find tree");
    let sig = Signature::now("Test User", "test@example.com").expect("signature");
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .expect("commit")
}

/// Adds `bare` (a local path, no network) as remote `origin` and fetches it.
pub fn add_remote_and_fetch(path: &Path, bare: &Path) {
    {
        let repo = Repository::open(path).expect("open repo");
        repo.remote("origin", bare.to_str().expect("utf-8 path"))
            .expect("add remote");
    }
    fetch_origin(path);
}

/// Fetches every branch of `origin` into `refs/remotes/origin/*`.
pub fn fetch_origin(path: &Path) {
    let repo = Repository::open(path).expect("open repo");
    let mut remote = repo.find_remote("origin").expect("find origin");
    remote
        .fetch(&["+refs/heads/*:refs/remotes/origin/*"], None, None)
        .expect("fetch");
}

/// Pushes local branch `branch` to `origin` over the local path (no network).
pub fn push_branch(path: &Path, branch: &str) {
    let repo = Repository::open(path).expect("open repo");
    let mut remote = repo.find_remote("origin").expect("find origin");
    let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote.push(&[spec.as_str()], None).expect("push");
}

/// Creates `branch` at HEAD, commits `file` on it, then returns the working
/// tree to the original branch. Returns the new commit's oid.
pub fn branch_with_commit(path: &Path, branch: &str, file: &str, content: &str) -> git2::Oid {
    let original = {
        let repo = Repository::open(path).expect("open repo");
        let head = repo.head().expect("head");
        let original = head.name().expect("utf-8 ref").to_string();
        let commit = head.peel_to_commit().expect("head commit");
        repo.branch(branch, &commit, false).expect("create branch");
        repo.set_head(&format!("refs/heads/{branch}"))
            .expect("switch to branch");
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .expect("checkout branch");
        original
    };
    let oid = commit_file(path, file, content, &format!("commit on {branch}"));
    let repo = Repository::open(path).expect("open repo");
    repo.set_head(&original).expect("switch back");
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .expect("checkout original");
    oid
}

/// The short name of the branch HEAD points at (the fixtures do not assume `main`).
pub fn head_branch_name(path: &Path) -> String {
    let repo = Repository::open(path).expect("open repo");
    let head = repo.find_reference("HEAD").expect("HEAD");
    head.symbolic_target()
        .and_then(|t| t.strip_prefix("refs/heads/"))
        .expect("HEAD is symbolic")
        .to_string()
}

/// Writes `rel` under `root`, creating parent directories.
pub fn write_file(root: &Path, rel: &str, contents: &str) {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).expect("create parent dirs");
    }
    std::fs::write(&full, contents).expect("write file");
}

/// Two branches that edited `README.md` line 1 differently and have not been
/// merged: `other` holds `# other\n`, the original branch holds `# main\n`.
/// HEAD is on the original branch, the tree is clean. No identity is configured.
pub fn diverged_fixture() -> (TempDir, PathBuf) {
    let (dir, path) = temp_repo_with_commit();
    let base_ref = {
        let repo = Repository::open(&path).expect("open repo");
        let name = repo
            .head()
            .expect("head")
            .name()
            .expect("utf-8")
            .to_string();
        let commit = repo.head().unwrap().peel_to_commit().expect("head commit");
        repo.branch("other", &commit, false).expect("create other");
        repo.set_head("refs/heads/other").expect("switch to other");
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .expect("checkout other");
        name
    };
    commit_file(&path, "README.md", "# other\n", "change on other");
    {
        let repo = Repository::open(&path).expect("open repo");
        repo.set_head(&base_ref).expect("switch back");
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .expect("checkout base");
    }
    commit_file(&path, "README.md", "# main\n", "change on base");
    (dir, path)
}

/// Base commit plus a branch `fast` one commit ahead of it (`fast.txt`), HEAD
/// still on the base branch. Returns the `fast` tip. No identity is configured.
pub fn ahead_fixture() -> (TempDir, PathBuf, git2::Oid) {
    let (dir, path) = temp_repo_with_commit();
    let tip = branch_with_commit(&path, "fast", "fast.txt", "fast\n");
    (dir, path, tip)
}
