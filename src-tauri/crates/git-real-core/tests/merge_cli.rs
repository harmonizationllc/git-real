//! The exact `git` argument lists and environment GR-10a hands to the CLI, and
//! what happens when `git` is missing, observed through a scripted stand-in
//! for `git` first on `PATH`. `PATH` is process-wide, so every test takes the
//! lock and restores it. The stand-in records its arguments in
//! `<workdir>/.git/argv.txt` (the workdir is the argument after `-C`) and
//! `$GIT_EDITOR` in `<workdir>/.git/editor.txt`, then exits 0.

#![cfg(unix)]

mod common;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use git_real_core::{GitError, MergeMode, OperationOutcome, RepoSession};

const SCRIPT: &str = r#"printf '%s\n' "$@" > "$2/.git/argv.txt"
printf '%s' "$GIT_EDITOR" > "$2/.git/editor.txt"
exit 0"#;

static PATH_LOCK: Mutex<()> = Mutex::new(());
static FAKE_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();

fn fake_dir() -> &'static Path {
    FAKE_DIR
        .get_or_init(|| {
            let dir = tempfile::tempdir().expect("temp dir");
            common::fake_git(dir.path(), SCRIPT);
            dir
        })
        .path()
}

/// Runs `body` with `PATH` set to `path`, then restores it.
fn with_path(path: OsString, body: impl FnOnce()) {
    let _guard = PATH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let old = std::env::var_os("PATH");
    // SAFETY: every test in this binary holds PATH_LOCK while touching PATH.
    unsafe { std::env::set_var("PATH", &path) };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    match old {
        Some(old) => unsafe { std::env::set_var("PATH", old) },
        None => unsafe { std::env::remove_var("PATH") },
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// Runs `body` with the stand-in `git` first on `PATH`.
fn with_fake_git(body: impl FnOnce()) {
    let old = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![fake_dir().to_path_buf()];
    paths.extend(std::env::split_paths(&old));
    with_path(std::env::join_paths(paths).unwrap(), body);
}

fn argv(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path.join(".git").join("argv.txt"))
        .expect("the stand-in git was not run")
        .lines()
        .map(str::to_owned)
        .collect()
}

/// Everything after `-C <workdir>`.
fn after_workdir(path: &Path) -> Vec<String> {
    let args = argv(path);
    assert_eq!(args[0], "-C", "{args:?}");
    assert_eq!(args[1], path.to_str().unwrap(), "{args:?}");
    args[2..].to_vec()
}

fn editor(path: &Path) -> String {
    std::fs::read_to_string(path.join(".git").join("editor.txt"))
        .expect("the stand-in git was not run")
}

/// The diverged fixture: `other` exists, nothing is in progress.
fn fixture() -> (tempfile::TempDir, PathBuf, RepoSession) {
    let (dir, path) = common::diverged_fixture();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session)
}

fn tip(path: &Path, name: &str) -> String {
    git2::Repository::open(path)
        .unwrap()
        .find_branch(name, git2::BranchType::Local)
        .unwrap()
        .get()
        .target()
        .unwrap()
        .to_string()
}

// --- argument lists, one per verb ---

#[test]
fn merge_runs_no_ff_no_edit() {
    let (_d, path, session) = fixture();
    with_fake_git(|| {
        session.merge_branch("other", MergeMode::Merge).unwrap();
    });

    assert_eq!(
        after_workdir(&path),
        ["merge", "--no-ff", "--no-edit", "other"]
    );
}

#[test]
fn fast_forward_runs_ff_only() {
    let (_d, path, session) = fixture();
    with_fake_git(|| {
        session
            .merge_branch("other", MergeMode::FastForward)
            .unwrap();
    });

    assert_eq!(after_workdir(&path), ["merge", "--ff-only", "other"]);
}

#[test]
fn rebase_runs_git_rebase_with_the_branch() {
    let (_d, path, session) = fixture();
    with_fake_git(|| {
        session.rebase_onto("other").unwrap();
    });

    assert_eq!(after_workdir(&path), ["rebase", "other"]);
}

#[test]
fn rebase_runs_git_with_editor_disabled() {
    let (_d, path, session) = fixture();
    with_fake_git(|| {
        session.rebase_onto("other").unwrap();
    });

    assert_eq!(editor(&path), "true");
}

#[test]
fn rebase_reports_completed_when_git_exits_zero() {
    let (_d, _p, session) = fixture();
    let mut outcome = None;
    with_fake_git(|| outcome = Some(session.rebase_onto("other").unwrap()));

    assert_eq!(outcome, Some(OperationOutcome::Completed));
}

#[test]
fn cherry_pick_runs_git_cherry_pick_with_the_full_oid() {
    let (_d, path, session) = fixture();
    let oid = tip(&path, "other");
    with_fake_git(|| {
        session.cherry_pick(&oid).unwrap();
    });

    assert_eq!(after_workdir(&path), ["cherry-pick", oid.as_str()]);
}

#[test]
fn revert_runs_no_edit_with_the_full_oid() {
    let (_d, path, session) = fixture();
    let oid = tip(&path, "other");
    with_fake_git(|| {
        session.revert_commit(&oid).unwrap();
    });

    assert_eq!(after_workdir(&path), ["revert", "--no-edit", oid.as_str()]);
}

#[test]
fn abort_during_a_merge_runs_merge_abort() {
    let (_d, path) = common::temp_repo_with_conflict();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();
    with_fake_git(|| session.abort_operation().unwrap());

    assert_eq!(after_workdir(&path), ["merge", "--abort"]);
}

#[test]
fn abort_during_a_cherry_pick_runs_cherry_pick_abort() {
    let (_d, path, session) = fixture();
    std::fs::write(
        path.join(".git").join("CHERRY_PICK_HEAD"),
        format!("{}\n", tip(&path, "other")),
    )
    .unwrap();
    with_fake_git(|| session.abort_operation().unwrap());

    assert_eq!(after_workdir(&path), ["cherry-pick", "--abort"]);
}

#[test]
fn abort_during_a_revert_runs_revert_abort() {
    let (_d, path, session) = fixture();
    std::fs::write(
        path.join(".git").join("REVERT_HEAD"),
        format!("{}\n", tip(&path, "other")),
    )
    .unwrap();
    with_fake_git(|| session.abort_operation().unwrap());

    assert_eq!(after_workdir(&path), ["revert", "--abort"]);
}

#[test]
fn abort_during_a_rebase_runs_rebase_abort() {
    let (_d, path, session) = fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    with_fake_git(|| session.abort_operation().unwrap());

    assert_eq!(after_workdir(&path), ["rebase", "--abort"]);
}

#[test]
fn continue_rebase_runs_rebase_continue_with_editor_disabled() {
    let (_d, path, session) = fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    with_fake_git(|| {
        session.continue_rebase().unwrap();
    });

    assert_eq!(after_workdir(&path), ["rebase", "--continue"]);
    assert_eq!(editor(&path), "true");
}

// --- failure plumbing ---

#[test]
fn a_nonzero_exit_with_a_clean_repo_is_operation_failed_with_the_captured_output() {
    let (_d, _path, session) = fixture();
    // A separate stand-in that prints on both streams and exits 3.
    let failing = tempfile::tempdir().unwrap();
    common::fake_git(failing.path(), r#"echo out; echo err >&2; exit 3"#);
    let old = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![failing.path().to_path_buf()];
    paths.extend(std::env::split_paths(&old));
    let mut result = None;
    with_path(std::env::join_paths(paths).unwrap(), || {
        result = Some(session.merge_branch("other", MergeMode::Merge));
    });

    let err = result.unwrap().unwrap_err();

    assert!(
        matches!(&err, GitError::OperationFailed { verb, code: Some(3), stdout, stderr }
            if verb == "merge" && stdout.trim() == "out" && stderr.trim() == "err"),
        "{err:?}"
    );
}

#[test]
fn missing_git_is_git_cli_missing() {
    let (_d, _p, session) = fixture();
    let empty = tempfile::tempdir().unwrap();
    let mut result = None;
    with_path(empty.path().as_os_str().to_owned(), || {
        result = Some(session.merge_branch("other", MergeMode::Merge));
    });

    let err = result.unwrap().unwrap_err();

    assert!(matches!(err, GitError::GitCliMissing), "{err:?}");
}

#[test]
fn missing_git_fails_every_cli_operation_with_git_cli_missing() {
    let (_d, path, session) = fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    let empty = tempfile::tempdir().unwrap();
    let mut results = Vec::new();
    with_path(empty.path().as_os_str().to_owned(), || {
        results.push(session.abort_operation().unwrap_err());
        results.push(session.continue_rebase().unwrap_err());
    });

    assert!(
        results.iter().all(|e| matches!(e, GitError::GitCliMissing)),
        "{results:?}"
    );
}
