//! Shared fixtures for integration tests.
#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git_real_core::git_cli;
use git_real_core::hosting::{Account, Provider, Request, Response, Token, Transport, UserInfo};
use git_real_core::{GitError, Progress, ProgressSink};
use git_real_lib::hosting_store::{HostingStore, TokenStore};
use git_real_lib::recent_store::RecentStore;
use git_real_lib::state::RepoRegistry;

use git2::{Repository, Signature};
use tempfile::TempDir;

/// The `errno` for "text file busy". Executing a file that another thread's
/// fork still holds open for writing fails with it, so a freshly written
/// fake executable is retried until it runs.
#[cfg(unix)]
const ETXTBSY: i32 = 26;

/// Writes an executable `git` in `dir` that prints `git version 9.9.9`.
#[cfg(unix)]
pub fn fake_git(dir: &Path) -> PathBuf {
    fake_git_script(dir, "echo git version 9.9.9")
}

/// Writes an executable `git` in `dir` that runs the shell `script`. Probes it
/// after writing (with `FAKE_GIT_PROBE` set, which exits before `script`) until
/// it stops failing with `ETXTBSY`, so a concurrent fork cannot break the
/// first real exec.
#[cfg(unix)]
pub fn fake_git_script(dir: &Path, script: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let path = dir.join("git");
    let body = format!("#!/bin/sh\n[ -n \"$FAKE_GIT_PROBE\" ] && exit 0\n{script}\n");
    std::fs::write(&path, body).expect("write fake git");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
        .expect("make fake git executable");
    for _ in 0..100 {
        match std::process::Command::new(&path)
            .env("FAKE_GIT_PROBE", "1")
            .status()
        {
            Err(e) if e.raw_os_error() == Some(ETXTBSY) => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => panic!("probing fake git failed: {e}"),
            Ok(_) => break,
        }
    }
    path
}

/// `Repository::init` with `core.autocrlf` pinned to false in the repo's own
/// config, so a host with system-wide autocrlf=true (Git for Windows) never
/// changes fixture bytes. Use it for every non-bare fixture repo.
pub fn init_repo(path: &Path) -> Repository {
    let repo = Repository::init(path).expect("init repo");
    repo.config()
        .expect("config")
        .set_bool("core.autocrlf", false)
        .expect("pin core.autocrlf");
    repo
}

/// Sets the repo-local `core.autocrlf` to `"true"`, `"input"` or `"false"`.
pub fn set_autocrlf(path: &Path, value: &str) {
    Repository::open(path)
        .expect("open repo")
        .config()
        .expect("config")
        .set_str("core.autocrlf", value)
        .expect("set core.autocrlf");
}

/// Creates a temp repo with a single commit containing `README.md`.
/// The returned `TempDir` must be kept alive for the repo to exist.
pub fn temp_repo_with_commit() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    let repo = init_repo(&path);

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

/// Sets a repo-local identity and turns commit and tag signing off, so the
/// developer's global config (which may sign everything) never reaches the test.
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
    config
        .set_bool("tag.gpgSign", false)
        .expect("set tag.gpgSign");
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

/// An in-memory `TokenStore`; `fail_get` / `fail_set` / `fail_delete` make that call return
/// `KeychainUnavailable`. Clones share one map, so a test keeps a clone to inspect what the
/// store wrote.
#[derive(Clone, Default)]
pub struct MemoryTokenStore {
    pub map: Arc<Mutex<HashMap<String, String>>>,
    pub fail_get: bool,
    pub fail_set: bool,
    pub fail_delete: bool,
}

fn keychain_down(what: &str) -> GitError {
    GitError::KeychainUnavailable(format!("fake keychain: {what} refused"))
}

impl TokenStore for MemoryTokenStore {
    fn set(&self, key: &str, token: &Token) -> Result<(), GitError> {
        if self.fail_set {
            return Err(keychain_down("set"));
        }
        self.map
            .lock()
            .expect("token map lock")
            .insert(key.to_owned(), token.expose_secret().to_owned());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<Token>, GitError> {
        if self.fail_get {
            return Err(keychain_down("get"));
        }
        let found = self.map.lock().expect("token map lock").get(key).cloned();
        found.map(|s| Token::new(&s)).transpose()
    }

    fn delete(&self, key: &str) -> Result<(), GitError> {
        if self.fail_delete {
            return Err(keychain_down("delete"));
        }
        self.map.lock().expect("token map lock").remove(key);
        Ok(())
    }
}

/// A scripted `Transport`: answers each `send` with the next queued response and records
/// every request (method, url, headers, body). An empty queue panics with
/// "unexpected request <url>".
pub struct FakeTransport {
    pub replies: Mutex<VecDeque<Result<Response, GitError>>>,
    pub seen: Mutex<Vec<Request>>,
}

impl FakeTransport {
    /// An empty queue.
    pub fn new() -> Self {
        FakeTransport {
            replies: Mutex::new(VecDeque::new()),
            seen: Mutex::new(Vec::new()),
        }
    }

    /// Queues a response with no headers.
    pub fn reply(self, status: u16, body: &str) -> Self {
        self.reply_with(status, &[], body)
    }

    /// Queues a response with the given headers (names are stored lower-cased).
    pub fn reply_with(self, status: u16, headers: &[(&str, &str)], body: &str) -> Self {
        self.replies
            .lock()
            .expect("replies lock")
            .push_back(Ok(Response {
                status,
                headers: headers
                    .iter()
                    .map(|(k, v)| (k.to_ascii_lowercase(), (*v).to_owned()))
                    .collect(),
                body: body.to_owned(),
            }));
        self
    }

    /// Queues a transport failure.
    pub fn fail(self, error: GitError) -> Self {
        self.replies
            .lock()
            .expect("replies lock")
            .push_back(Err(error));
        self
    }

    /// Every request sent so far, oldest first.
    pub fn requests(&self) -> Vec<Request> {
        self.seen.lock().expect("seen lock").clone()
    }
}

impl Transport for FakeTransport {
    fn send(&self, req: &Request) -> Result<Response, GitError> {
        self.seen.lock().expect("seen lock").push(req.clone());
        self.replies
            .lock()
            .expect("replies lock")
            .pop_front()
            .unwrap_or_else(|| panic!("unexpected request {}", req.url))
    }
}

/// A `HostingStore` at `<tmp>/hosting_accounts.json` over a `MemoryTokenStore` the test can
/// inspect. Keep the `TempDir` alive for the file to remain valid.
pub fn hosting_store() -> (TempDir, HostingStore, MemoryTokenStore) {
    hosting_store_with(MemoryTokenStore::default())
}

/// Like `hosting_store`, over the given (possibly failing) `tokens`.
pub fn hosting_store_with(tokens: MemoryTokenStore) -> (TempDir, HostingStore, MemoryTokenStore) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let store = HostingStore::load(
        dir.path().join("hosting_accounts.json"),
        Box::new(tokens.clone()),
    );
    (dir, store, tokens)
}

/// A store with no accounts and a working fake keychain.
pub fn no_accounts() -> (TempDir, HostingStore) {
    let (dir, store, _tokens) = hosting_store();
    (dir, store)
}

/// A shared, empty `HostingStore` for tests that need a `NetworkAuth::Accounts` borrow with no
/// accounts (so `resolve` yields `None`). Its file path does not exist and is never written, so
/// nothing is created on disk. Do not add accounts to it: it is shared by the whole test binary.
pub fn empty_store() -> &'static HostingStore {
    static STORE: std::sync::OnceLock<HostingStore> = std::sync::OnceLock::new();
    STORE.get_or_init(|| {
        HostingStore::load(
            PathBuf::from("/nonexistent/git-real-empty-store/hosting_accounts.json"),
            Box::new(MemoryTokenStore::default()),
        )
    })
}

/// A GitHub account on `github.com` for `username`, with no display name or avatar.
pub fn github_account(username: &str) -> Account {
    Account::new(
        Provider::GitHub,
        "github.com",
        UserInfo {
            username: username.to_owned(),
            display_name: None,
            avatar_url: None,
        },
    )
}
