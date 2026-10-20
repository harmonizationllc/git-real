//! The interactive rebase todo is a file in the temp dir. When that dir is
//! unusable the run must fail cleanly with an I/O error before git starts.
//!
//! `TMPDIR` is process-wide, so this binary holds exactly one test.

#![cfg(unix)]

mod common;

use git_real_core::{GitError, OperationState, RebaseAction, RebaseStep, RepoSession};

#[test]
fn rebase_interactive_with_an_unusable_temp_dir_is_io_and_starts_nothing() {
    if !common::git_available() {
        return;
    }
    let (_d, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    common::run_git_ok(&path, &["branch", "base"]);
    let oid = common::commit_file(&path, "x.txt", "x\n", "add x").to_string();
    let session = RepoSession::open(&path).unwrap();
    let missing = path.join("no-such-temp-dir");
    // SAFETY: the only test in this binary, so nothing else reads the environment.
    unsafe { std::env::set_var("TMPDIR", &missing) };
    let steps = [RebaseStep {
        action: RebaseAction::Pick,
        oid: oid.clone(),
    }];

    let err = session.rebase_interactive("base", &steps).unwrap_err();

    assert!(matches!(err, GitError::Io(_)), "{err:?}");
    assert_eq!(session.operation_state(), OperationState::None);
    assert_eq!(
        session.rebase_plan("base").unwrap()[0].oid,
        oid,
        "the history is untouched"
    );
    assert!(!missing.exists(), "no todo directory was invented");
}
