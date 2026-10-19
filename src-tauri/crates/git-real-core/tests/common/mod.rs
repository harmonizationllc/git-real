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

/// Writes an executable shell script named `git` into `dir` and returns its path.
/// Lets tests drive `clone_with` with a scripted stand-in for the git CLI.
///
/// A concurrent `fork` in another test thread can briefly inherit the write
/// handle, making an immediate `exec` fail with ETXTBSY. The helper therefore
/// probes the script (it exits at once when `FAKE_GIT_PROBE` is set) until the
/// kernel accepts it.
#[cfg(unix)]
pub fn fake_git(dir: &Path, script: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    let path = dir.join("git");
    let body = format!("#!/bin/sh\n[ -n \"$FAKE_GIT_PROBE\" ] && exit 0\n{script}\n");
    std::fs::write(&path, body).expect("write fake git");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    for _ in 0..100 {
        match Command::new(&path).env("FAKE_GIT_PROBE", "1").status() {
            Err(e) if e.raw_os_error() == Some(26) => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => panic!("probing fake git failed: {e}"),
            Ok(_) => break,
        }
    }
    path
}

/// Writes `contents` to `rel` under `root`, creating parent directories.
pub fn write_file(root: &Path, rel: &str, contents: &str) {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).expect("create parent dirs");
    }
    std::fs::write(&full, contents).expect("write file");
}

/// Stages `rel`: adds it when present on disk (a dangling symlink counts as present), removes it from the index when missing.
pub fn stage(root: &Path, rel: &str) {
    let repo = Repository::open(root).expect("open repo");
    let mut index = repo.index().expect("open index");
    if root.join(rel).symlink_metadata().is_ok() {
        index.add_path(Path::new(rel)).expect("add path");
    } else {
        index.remove_path(Path::new(rel)).expect("remove path");
    }
    index.write().expect("write index");
}

/// Stages every change (including deletions) and commits it on HEAD.
pub fn commit_all(root: &Path, message: &str) -> git2::Oid {
    let repo = Repository::open(root).expect("open repo");
    let mut index = repo.index().expect("open index");
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .expect("add all");
    index.update_all(["*"].iter(), None).expect("update all");
    index.write().expect("write index");
    let tree_id = index.write_tree().expect("write tree");
    let tree = repo.find_tree(tree_id).expect("find tree");
    let sig = Signature::now("Test User", "test@example.com").expect("signature");
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .expect("commit")
}

/// Creates a repo whose index holds a conflict on `README.md` (line 1 edited
/// differently on `other` and on the original branch, then merged).
pub fn temp_repo_with_conflict() -> (TempDir, PathBuf) {
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
        name
    };

    {
        let repo = Repository::open(&path).expect("open repo");
        repo.set_head("refs/heads/other").expect("switch to other");
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .expect("checkout other");
    }
    write_file(&path, "README.md", "# other\n");
    commit_all(&path, "change on other");

    {
        let repo = Repository::open(&path).expect("open repo");
        repo.set_head(&base_ref).expect("switch back");
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .expect("checkout base");
    }
    write_file(&path, "README.md", "# main\n");
    commit_all(&path, "change on base");

    let repo = Repository::open(&path).expect("open repo");
    let other = repo
        .find_branch("other", git2::BranchType::Local)
        .expect("find other");
    let annotated = repo
        .reference_to_annotated_commit(other.get())
        .expect("annotated commit");
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.allow_conflicts(true);
    repo.merge(&[&annotated], None, Some(&mut checkout))
        .expect("merge");
    assert!(repo.index().expect("index").has_conflicts());
    drop(annotated);
    drop(other);
    drop(repo);
    (dir, path)
}

/// Creates an initialised repo with no commits (unborn HEAD).
pub fn temp_repo_unborn() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    Repository::init(&path).expect("init repo");
    (dir, path)
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

/// Installs an executable `.git/hooks/<name>` with the given body.
#[cfg(unix)]
pub fn install_hook(root: &Path, name: &str, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let hooks = root.join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).expect("hooks dir");
    let path = hooks.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write hook");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
}

/// Writes `name` with `content`, stages it and commits on HEAD; returns the new oid.
pub fn commit_file(path: &Path, name: &str, content: &str, message: &str) -> git2::Oid {
    let repo = Repository::open(path).expect("open repo");
    write_file(path, name, content);
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

/// Adds `bare` (a local path, no network) as remote `origin`, fetches it and
/// sets `head_name`'s upstream to `origin/<head_name>`.
pub fn add_remote_and_fetch(path: &Path, bare: &Path, head_name: &str) {
    {
        let repo = Repository::open(path).expect("open repo");
        repo.remote("origin", bare.to_str().expect("utf-8 path"))
            .expect("add remote");
    }
    fetch_remote(path, "origin");
    let repo = Repository::open(path).expect("open repo");
    let mut branch = repo
        .find_branch(head_name, git2::BranchType::Local)
        .expect("find head branch");
    branch
        .set_upstream(Some(&format!("origin/{head_name}")))
        .expect("set upstream");
}

/// Fetches every branch of `remote` into `refs/remotes/<remote>/*`.
pub fn fetch_remote(path: &Path, remote: &str) {
    let repo = Repository::open(path).expect("open repo");
    let mut remote = repo.find_remote(remote).expect("find remote");
    let spec = format!(
        "+refs/heads/*:refs/remotes/{}/*",
        remote.name().expect("utf-8")
    );
    remote.fetch(&[spec.as_str()], None, None).expect("fetch");
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

/// Fixed base for the commit times the log fixtures use, so TIME sorting is deterministic.
pub const FIXTURE_TIME: i64 = 1_700_000_000;

/// A signature at `FIXTURE_TIME + offset` seconds.
pub fn signature_at(offset: i64) -> Signature<'static> {
    Signature::new(
        "Test User",
        "test@example.com",
        &git2::Time::new(FIXTURE_TIME + offset, 0),
    )
    .expect("signature")
}

/// Commits a tree holding exactly `files` (name, content) on `update_ref`
/// (`None` leaves every ref alone), with explicit author and committer.
pub fn commit_tree_at(
    path: &Path,
    update_ref: Option<&str>,
    files: &[(&str, &str)],
    message: &str,
    parents: &[git2::Oid],
    author: &Signature<'_>,
    committer: &Signature<'_>,
) -> git2::Oid {
    let repo = Repository::open(path).expect("open repo");
    let mut builder = repo.treebuilder(None).expect("tree builder");
    for (name, content) in files {
        let blob = repo.blob(content.as_bytes()).expect("write blob");
        builder.insert(name, blob, 0o100644).expect("insert blob");
    }
    let tree = repo
        .find_tree(builder.write().expect("write tree"))
        .expect("find tree");
    let parent_commits: Vec<git2::Commit> = parents
        .iter()
        .map(|p| repo.find_commit(*p).expect("find parent"))
        .collect();
    let refs: Vec<&git2::Commit> = parent_commits.iter().collect();
    repo.commit(update_ref, author, committer, message, &tree, &refs)
        .expect("commit")
}

/// R <- A (HEAD branch) ; R <- B (`feature`) ; M = merge(A, B) on the HEAD
/// branch. Commit times are R, A, B, M = FIXTURE_TIME + 0, 10, 20, 30, so the
/// TIME sort is deterministic. Returns (dir, path, r, a, b, m).
pub fn merge_fixture() -> (TempDir, PathBuf, git2::Oid, git2::Oid, git2::Oid, git2::Oid) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    Repository::init(&path).expect("init repo");
    let at = signature_at;
    let r = commit_tree_at(
        &path,
        Some("HEAD"),
        &[("base.txt", "base\n")],
        "root",
        &[],
        &at(0),
        &at(0),
    );
    let a = commit_tree_at(
        &path,
        Some("HEAD"),
        &[("base.txt", "base\n"), ("a.txt", "a\n")],
        "on main",
        &[r],
        &at(10),
        &at(10),
    );
    let b = commit_tree_at(
        &path,
        Some("refs/heads/feature"),
        &[("base.txt", "base\n"), ("b.txt", "b\n")],
        "on feature",
        &[r],
        &at(20),
        &at(20),
    );
    let m = commit_tree_at(
        &path,
        Some("HEAD"),
        &[("base.txt", "base\n"), ("a.txt", "a\n"), ("b.txt", "b\n")],
        "merge",
        &[a, b],
        &at(30),
        &at(30),
    );
    (dir, path, r, a, b, m)
}

/// Creates a lightweight tag `name` on `target` (any object kind).
pub fn tag_lightweight(path: &Path, name: &str, target: git2::Oid) {
    let repo = Repository::open(path).expect("open repo");
    let object = repo.find_object(target, None).expect("find target");
    repo.tag_lightweight(name, &object, false)
        .expect("lightweight tag");
}

/// Creates an annotated tag `name` (message "release") on `target`.
pub fn tag_annotated(path: &Path, name: &str, target: git2::Oid) {
    let repo = Repository::open(path).expect("open repo");
    let object = repo.find_object(target, None).expect("find target");
    let sig = Signature::now("Test User", "test@example.com").expect("signature");
    repo.tag(name, &object, &sig, "release", false)
        .expect("annotated tag");
}
