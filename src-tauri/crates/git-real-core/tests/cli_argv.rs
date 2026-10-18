//! The exact `git` argument lists and failure plumbing for checkout and remote
//! branch deletion (GR-7), observed through a scripted stand-in for `git` that
//! is first on `PATH`. No real remote or real git is involved.
//!
//! `PATH` is process-wide, so it is set exactly once, before any test body
//! runs. The stand-in records its arguments in `<workdir>/.git/argv.txt` (the
//! workdir is the argument after `-C`) and, when `<workdir>/.git/behaviour`
//! exists, sources it so a test can script exit codes and output.

#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use git_real_core::{GitError, RepoSession};
use git2::{BranchType, Repository};

const SCRIPT: &str = r#"printf '%s\n' "$@" > "$2/.git/argv.txt"
[ -f "$2/.git/behaviour" ] && . "$2/.git/behaviour"
exit 0"#;

static FAKE_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();

fn use_fake_git() {
    FAKE_DIR.get_or_init(|| {
        let dir = tempfile::tempdir().expect("temp dir");
        common::fake_git(dir.path(), SCRIPT);
        let old = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![dir.path().to_path_buf()];
        paths.extend(std::env::split_paths(&old));
        // SAFETY: runs inside `get_or_init`, before any test body reads PATH.
        unsafe { std::env::set_var("PATH", std::env::join_paths(paths).unwrap()) };
        dir
    });
}

fn argv(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path.join(".git").join("argv.txt"))
        .expect("the stand-in git was not run")
        .lines()
        .map(str::to_owned)
        .collect()
}

fn script_behaviour(path: &Path, body: &str) {
    std::fs::write(path.join(".git").join("behaviour"), body).unwrap();
}

/// Everything after `-C <workdir>`.
fn after_workdir(path: &Path) -> Vec<String> {
    let args = argv(path);
    assert_eq!(args[0], "-C", "{args:?}");
    args[2..].to_vec()
}

/// A repo with a fetched `origin` holding `feature` and `feat/slash`, with no
/// local branch of those names.
fn fixture() -> (tempfile::TempDir, tempfile::TempDir, PathBuf, RepoSession) {
    use_fake_git();
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &commit, false).unwrap();
        repo.branch("feat/slash", &commit, false).unwrap();
    }
    common::push_branch(&path, "feature");
    common::push_branch(&path, "feat/slash");
    common::fetch_remote(&path, "origin");
    {
        let repo = Repository::open(&path).unwrap();
        for name in ["feature", "feat/slash"] {
            repo.find_branch(name, BranchType::Local)
                .unwrap()
                .delete()
                .unwrap();
        }
    }
    let session = RepoSession::open(&path).unwrap();
    (dir, bare_dir, path, session)
}

// --- git switch argument lists ---

#[test]
fn checkout_remote_creates_the_branch_with_switch_c_and_a_full_track_refname() {
    let (_d, _b, path, session) = fixture();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(
        after_workdir(&path),
        [
            "switch",
            "-c",
            "feature",
            "--track",
            "refs/remotes/origin/feature"
        ]
    );
}

#[test]
fn checkout_remote_keeps_slashes_in_the_name_and_the_tracking_refname() {
    let (_d, _b, path, session) = fixture();
    session
        .checkout_remote_branch("origin", "feat/slash")
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        [
            "switch",
            "-c",
            "feat/slash",
            "--track",
            "refs/remotes/origin/feat/slash"
        ]
    );
}

#[test]
fn checkout_remote_with_an_existing_local_branch_runs_a_plain_switch() {
    let (_d, _b, path, session) = fixture();
    session.create_branch("feature", None).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(after_workdir(&path), ["switch", "feature"]);
}

#[test]
fn checkout_local_runs_a_plain_switch_in_the_workdir() {
    let (_d, _b, path, session) = fixture();
    session.create_branch("topic", None).unwrap();
    session.checkout_branch("topic").unwrap();
    let args = argv(&path);
    assert_eq!(args[0], "-C");
    assert_eq!(
        std::fs::canonicalize(&args[1]).unwrap(),
        std::fs::canonicalize(&path).unwrap()
    );
    assert_eq!(&args[2..], ["switch", "topic"]);
}

#[test]
fn create_and_checkout_switches_to_the_new_branch_by_name() {
    let (_d, _b, path, session) = fixture();
    let branch = session.create_and_checkout_branch("topic", None).unwrap();
    assert!(branch.is_head);
    assert_eq!(after_workdir(&path), ["switch", "topic"]);
}

// --- failure plumbing for git switch ---

#[test]
fn switch_failure_carries_exit_code_stdout_and_stderr_separately() {
    let (_d, _b, path, session) = fixture();
    session.create_branch("topic", None).unwrap();
    script_behaviour(&path, "echo from-stdout\necho from-stderr >&2\nexit 3");
    match session.checkout_branch("topic").unwrap_err() {
        GitError::CheckoutFailed {
            code,
            stdout,
            stderr,
        } => {
            assert_eq!(code, Some(3));
            assert_eq!(stdout, "from-stdout\n");
            assert_eq!(stderr, "from-stderr\n");
        }
        other => panic!("expected CheckoutFailed, got {other:?}"),
    }
}

#[test]
fn switch_killed_by_a_signal_reports_no_exit_code() {
    let (_d, _b, path, session) = fixture();
    session.create_branch("topic", None).unwrap();
    script_behaviour(&path, "kill -9 $$");
    assert!(matches!(
        session.checkout_branch("topic").unwrap_err(),
        GitError::CheckoutFailed { code: None, .. }
    ));
}

#[test]
fn failed_tracking_checkout_creates_no_local_branch() {
    let (_d, _b, path, session) = fixture();
    script_behaviour(&path, "exit 1");
    assert!(matches!(
        session
            .checkout_remote_branch("origin", "feature")
            .unwrap_err(),
        GitError::CheckoutFailed { code: Some(1), .. }
    ));
    assert!(
        Repository::open(&path)
            .unwrap()
            .find_branch("feature", BranchType::Local)
            .is_err()
    );
}

// --- git push --delete ---

#[test]
fn remote_delete_pushes_a_heads_qualified_name() {
    let (_d, _b, path, session) = fixture();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    push.run().unwrap();
    assert_eq!(
        after_workdir(&path),
        ["push", "origin", "--delete", "heads/feature"]
    );
}

#[test]
fn remote_delete_keeps_slashes_in_the_name() {
    let (_d, _b, path, session) = fixture();
    session
        .prepare_remote_delete("origin", "feat/slash")
        .unwrap()
        .run()
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        ["push", "origin", "--delete", "heads/feat/slash"]
    );
}

#[test]
fn remote_delete_runs_in_the_accessor_workdir() {
    let (_d, _b, path, session) = fixture();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    push.run().unwrap();
    assert_eq!(argv(&path)[1], push.workdir().to_str().unwrap());
}

#[test]
fn push_failure_carries_exit_code_stdout_and_stderr_separately() {
    let (_d, _b, path, session) = fixture();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    script_behaviour(&path, "echo push-out\necho push-err >&2\nexit 7");
    match push.run().unwrap_err() {
        GitError::PushFailed {
            code,
            stdout,
            stderr,
        } => {
            assert_eq!(code, Some(7));
            assert_eq!(stdout, "push-out\n");
            assert_eq!(stderr, "push-err\n");
        }
        other => panic!("expected PushFailed, got {other:?}"),
    }
}

#[test]
fn push_killed_by_a_signal_reports_no_exit_code() {
    let (_d, _b, path, session) = fixture();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    script_behaviour(&path, "kill -9 $$");
    assert!(matches!(
        push.run().unwrap_err(),
        GitError::PushFailed { code: None, .. }
    ));
}

// --- PushDelete accessors ---

#[test]
fn push_delete_exposes_the_validated_remote_name_and_workdir() {
    let (_d, _b, path, session) = fixture();
    let push = session
        .prepare_remote_delete("origin", "feat/slash")
        .unwrap();
    assert_eq!(push.remote(), "origin");
    assert_eq!(push.name(), "feat/slash");
    assert_eq!(
        std::fs::canonicalize(push.workdir()).unwrap(),
        std::fs::canonicalize(&path).unwrap()
    );
}
