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
    config.set_bool("commit.gpgsign", false).expect("set gpgsign");
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
