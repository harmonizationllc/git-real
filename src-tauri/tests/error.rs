//! Integration tests for `AppError` and `AppErrorKind`.

use std::path::PathBuf;

use git_real_core::GitError;
use git_real_lib::error::{AppError, AppErrorKind};
use serde_json::json;

fn path() -> PathBuf {
    PathBuf::from("/some/path")
}

// From<GitError>: every variant maps to its documented kind. The message is the
// error's Display text, except CloneFailed, whose message is reduced (see below).
#[test]
fn app_error_kind_for_each_git_error_variant() {
    let cases: Vec<(GitError, AppErrorKind, Option<&str>)> = vec![
        (
            GitError::NotARepository(path()),
            AppErrorKind::NotARepository,
            None,
        ),
        (
            GitError::AlreadyARepository(path()),
            AppErrorKind::AlreadyARepository,
            None,
        ),
        (
            GitError::PathNotFound(path()),
            AppErrorKind::PathNotFound,
            None,
        ),
        (GitError::GitCliMissing, AppErrorKind::GitCliMissing, None),
        (
            GitError::CloneFailed {
                code: Some(128),
                stderr: "boom".into(),
            },
            AppErrorKind::CloneFailed,
            Some("git clone failed with exit code 128"),
        ),
        (
            GitError::Io(std::io::Error::other("x")),
            AppErrorKind::Io,
            None,
        ),
        (
            GitError::Git2(git2::Error::from_str("x")),
            AppErrorKind::Git,
            None,
        ),
        (
            GitError::TooLarge {
                path: "a.png".into(),
                size: 2,
                limit: 1,
            },
            AppErrorKind::TooLarge,
            None,
        ),
        (
            GitError::InvalidBranchName("a b".into()),
            AppErrorKind::InvalidBranchName,
            None,
        ),
        (
            GitError::BranchExists("main".into()),
            AppErrorKind::BranchExists,
            None,
        ),
        (
            GitError::BranchNotFound("ghost".into()),
            AppErrorKind::BranchNotFound,
            None,
        ),
        (
            GitError::BranchNotMerged("wip".into()),
            AppErrorKind::BranchNotMerged,
            None,
        ),
        (
            GitError::CannotDeleteCurrent("main".into()),
            AppErrorKind::CannotDeleteCurrent,
            None,
        ),
        (GitError::UnbornHead, AppErrorKind::UnbornHead, None),
        (
            GitError::RevisionNotFound("nope".into()),
            AppErrorKind::RevisionNotFound,
            None,
        ),
        (
            GitError::RemoteNotFound("nope".into()),
            AppErrorKind::RemoteNotFound,
            None,
        ),
        (
            GitError::CheckoutFailed {
                code: Some(128),
                stdout: String::new(),
                stderr: String::new(),
            },
            AppErrorKind::CheckoutFailed,
            Some("git switch failed with exit code 128"),
        ),
        (
            GitError::PushFailed {
                code: Some(1),
                stdout: String::new(),
                stderr: String::new(),
            },
            AppErrorKind::PushFailed,
            Some("git push failed with exit code 1"),
        ),
    ];
    for (err, expected, reduced) in cases {
        let message = reduced.map_or_else(|| err.to_string(), str::to_string);
        let app: AppError = err.into();
        assert_eq!(
            app,
            AppError {
                kind: expected,
                message
            }
        );
    }
}

#[test]
fn app_error_message_is_not_empty_for_clone_failed_with_no_exit_code() {
    let app: AppError = GitError::CloneFailed {
        code: None,
        stderr: String::new(),
    }
    .into();
    assert!(!app.message.is_empty());
}

// Wire format: kinds serialize as camelCase strings the front end relies on.
#[test]
fn app_error_kind_serializes_camel_case() {
    let cases = [
        (AppErrorKind::NotARepository, "notARepository"),
        (AppErrorKind::AlreadyARepository, "alreadyARepository"),
        (AppErrorKind::PathNotFound, "pathNotFound"),
        (AppErrorKind::GitCliMissing, "gitCliMissing"),
        (AppErrorKind::CloneFailed, "cloneFailed"),
        (AppErrorKind::Io, "io"),
        (AppErrorKind::Git, "git"),
        (AppErrorKind::UnknownRepo, "unknownRepo"),
        (AppErrorKind::NoChanges, "noChanges"),
        (AppErrorKind::BadSelection, "badSelection"),
        (AppErrorKind::ApplyFailed, "applyFailed"),
        (AppErrorKind::TooLarge, "tooLarge"),
    ];
    for (kind, expected) in cases {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(expected));
    }
}

// TooLarge: the wire kind is camelCase so the front end can branch on it.
#[test]
fn too_large_serializes_camel_case() {
    let err: AppError = GitError::TooLarge {
        path: "a.png".into(),
        size: 2,
        limit: 1,
    }
    .into();
    assert_eq!(
        serde_json::to_value(&err).unwrap()["kind"],
        json!("tooLarge")
    );
}

#[test]
fn app_error_serializes_as_kind_and_message() {
    let err = GitError::NotARepository(path());
    let message = err.to_string();
    let app: AppError = err.into();
    assert_eq!(
        serde_json::to_value(app).unwrap(),
        json!({"kind": "notARepository", "message": message})
    );
}

// AppError::unknown_repo
#[test]
fn unknown_repo_has_unknown_repo_kind() {
    assert_eq!(AppError::unknown_repo(42).kind, AppErrorKind::UnknownRepo);
}

#[test]
fn unknown_repo_message_mentions_id() {
    assert!(AppError::unknown_repo(42).message.contains("42"));
}

// CloneFailed message reduction: only `fatal:` / `error:` lines survive; progress
// noise (split on both '\n' and '\r') is dropped.
fn clone_failed_message(code: Option<i32>, stderr: &str) -> String {
    let app: AppError = GitError::CloneFailed {
        code,
        stderr: stderr.into(),
    }
    .into();
    assert_eq!(app.kind, AppErrorKind::CloneFailed);
    app.message
}

#[test]
fn clone_failed_message_keeps_only_fatal_and_error_lines() {
    let stderr = "Cloning into 'x'...\nremote: Counting objects: 100% (3/3)\rReceiving objects:  50%\nfatal: repository 'u' not found\nerror: boom\n";
    assert_eq!(
        clone_failed_message(Some(128), stderr),
        "fatal: repository 'u' not found\nerror: boom"
    );
}

#[test]
fn clone_failed_message_splits_on_carriage_return() {
    assert_eq!(
        clone_failed_message(Some(128), "Receiving objects:  10%\rfatal: x"),
        "fatal: x"
    );
}

#[test]
fn clone_failed_message_trims_leading_whitespace() {
    assert_eq!(
        clone_failed_message(Some(128), "  fatal: x  \n"),
        "fatal: x"
    );
}

#[test]
fn clone_failed_message_without_fatal_uses_exit_code() {
    assert_eq!(
        clone_failed_message(Some(128), "Cloning into 'x'...\nReceiving objects:  50%\r"),
        "git clone failed with exit code 128"
    );
}

#[test]
fn clone_failed_message_without_code_reports_signal() {
    assert_eq!(
        clone_failed_message(None, ""),
        "git clone was terminated by a signal"
    );
}

#[test]
fn clone_failed_message_with_only_error_line() {
    assert_eq!(
        clone_failed_message(Some(1), "Cloning into 'x'...\nerror: RPC failed\n"),
        "error: RPC failed"
    );
}

#[test]
fn clone_failed_message_ignores_blank_and_whitespace_only_lines() {
    assert_eq!(
        clone_failed_message(Some(128), "\n   \r\n\t\nfatal: a\n\n  \nfatal: b\n"),
        "fatal: a\nfatal: b"
    );
}

#[test]
fn clone_failed_message_ignores_fatal_not_at_line_start() {
    assert_eq!(
        clone_failed_message(Some(128), "remote: fatal: hidden\nwarning: error: nested\n"),
        "git clone failed with exit code 128"
    );
}

#[test]
fn clone_failed_message_with_signal_and_noise_only_reports_signal() {
    assert_eq!(
        clone_failed_message(None, "Receiving objects:  50%\r"),
        "git clone was terminated by a signal"
    );
}

#[test]
fn clone_failed_message_prefers_fatal_lines_over_exit_code() {
    let message = clone_failed_message(Some(128), "fatal: nope\n");
    assert!(!message.contains("exit code"));
}

// Working-tree errors (GR-4): core variants get dedicated kinds and keep their Display text.
#[test]
fn no_changes_maps_to_no_changes_kind() {
    let err = GitError::NoChanges("a.txt".into());
    let message = err.to_string();
    let app: AppError = err.into();
    assert_eq!(
        serde_json::to_value(app).unwrap(),
        json!({"kind": "noChanges", "message": message})
    );
}

#[test]
fn bad_selection_maps() {
    let err = GitError::BadSelection;
    let message = err.to_string();
    let app: AppError = err.into();
    assert_eq!(
        serde_json::to_value(app).unwrap(),
        json!({"kind": "badSelection", "message": message})
    );
}

#[test]
fn apply_failed_maps() {
    let err = GitError::ApplyFailed("hunk rejected".into());
    let message = err.to_string();
    let app: AppError = err.into();
    assert_eq!(
        serde_json::to_value(app).unwrap(),
        json!({"kind": "applyFailed", "message": message})
    );
}

#[test]
fn apply_failed_message_includes_reason() {
    let app: AppError = GitError::ApplyFailed("hunk rejected".into()).into();
    assert!(app.message.contains("hunk rejected"));
}

#[test]
fn empty_message_and_nothing_to_commit_map_to_their_kinds() {
    assert_eq!(
        AppError::from(GitError::EmptyMessage).kind,
        AppErrorKind::EmptyMessage
    );
    assert_eq!(
        AppError::from(GitError::NothingToCommit).kind,
        AppErrorKind::NothingToCommit
    );
}

#[test]
fn commit_failed_message_prefers_stderr() {
    let err = AppError::from(GitError::CommitFailed {
        code: Some(1),
        stdout: "On branch main\n".into(),
        stderr: "hook says no\nsecond line\n".into(),
    });
    assert_eq!(err.kind, AppErrorKind::CommitFailed);
    assert_eq!(err.message, "hook says no\nsecond line");
}

#[test]
fn commit_failed_message_falls_back_to_stdout() {
    let err = AppError::from(GitError::CommitFailed {
        code: Some(1),
        stdout: "  nothing to commit, working tree clean \n".into(),
        stderr: "  \n".into(),
    });
    assert_eq!(err.message, "nothing to commit, working tree clean");
}

#[test]
fn commit_failed_message_falls_back_to_exit_code_or_signal() {
    let code = AppError::from(GitError::CommitFailed {
        code: Some(128),
        stdout: String::new(),
        stderr: String::new(),
    });
    assert_eq!(code.message, "git commit failed with exit code 128");
    let signal = AppError::from(GitError::CommitFailed {
        code: None,
        stdout: String::new(),
        stderr: String::new(),
    });
    assert_eq!(signal.message, "git commit was terminated by a signal");
}

#[test]
fn new_kinds_serialize_camel_case() {
    assert_eq!(
        serde_json::to_value(AppErrorKind::EmptyMessage).unwrap(),
        "emptyMessage"
    );
    assert_eq!(
        serde_json::to_value(AppErrorKind::NothingToCommit).unwrap(),
        "nothingToCommit"
    );
    assert_eq!(
        serde_json::to_value(AppErrorKind::CommitFailed).unwrap(),
        "commitFailed"
    );
}

// GR-7 branch errors: the wire kinds are camelCase strings the front end relies on.
#[test]
fn branch_error_kinds_serialize_camel_case() {
    let cases = [
        (AppErrorKind::InvalidBranchName, "invalidBranchName"),
        (AppErrorKind::BranchExists, "branchExists"),
        (AppErrorKind::BranchNotFound, "branchNotFound"),
        (AppErrorKind::BranchNotMerged, "branchNotMerged"),
        (AppErrorKind::CannotDeleteCurrent, "cannotDeleteCurrent"),
        (AppErrorKind::UnbornHead, "unbornHead"),
        (AppErrorKind::RevisionNotFound, "revisionNotFound"),
        (AppErrorKind::RemoteNotFound, "remoteNotFound"),
        (AppErrorKind::CheckoutFailed, "checkoutFailed"),
        (AppErrorKind::PushFailed, "pushFailed"),
    ];
    for (kind, expected) in cases {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(expected));
    }
}

#[test]
fn branch_not_merged_serializes_as_kind_and_message() {
    let err = GitError::BranchNotMerged("wip".into());
    let message = err.to_string();
    let app: AppError = err.into();
    assert_eq!(
        serde_json::to_value(app).unwrap(),
        json!({"kind": "branchNotMerged", "message": message})
    );
}

#[test]
fn branch_error_messages_name_the_branch() {
    let app: AppError = GitError::BranchExists("topic".into()).into();
    assert!(app.message.contains("topic"));
}

fn checkout_failed(code: Option<i32>, stdout: &str, stderr: &str) -> AppError {
    GitError::CheckoutFailed {
        code,
        stdout: stdout.into(),
        stderr: stderr.into(),
    }
    .into()
}

fn push_failed(code: Option<i32>, stdout: &str, stderr: &str) -> AppError {
    GitError::PushFailed {
        code,
        stdout: stdout.into(),
        stderr: stderr.into(),
    }
    .into()
}

#[test]
fn checkout_failed_message_prefers_stderr() {
    let err = checkout_failed(
        Some(1),
        "Switched\n",
        "error: local changes\nwould be overwritten\n",
    );
    assert_eq!(err.kind, AppErrorKind::CheckoutFailed);
    assert_eq!(err.message, "error: local changes\nwould be overwritten");
}

#[test]
fn checkout_failed_message_falls_back_to_stdout() {
    let err = checkout_failed(Some(1), "  from stdout \n", "  \n");
    assert_eq!(err.message, "from stdout");
}

#[test]
fn checkout_failed_message_falls_back_to_exit_code() {
    assert_eq!(
        checkout_failed(Some(128), "", "").message,
        "git switch failed with exit code 128"
    );
}

#[test]
fn checkout_failed_message_falls_back_to_signal() {
    assert_eq!(
        checkout_failed(None, " ", " ").message,
        "git switch was terminated by a signal"
    );
}

#[test]
fn push_failed_message_prefers_stderr() {
    let err = push_failed(Some(1), "out\n", "error: remote ref does not exist\n");
    assert_eq!(err.kind, AppErrorKind::PushFailed);
    assert_eq!(err.message, "error: remote ref does not exist");
}

#[test]
fn push_failed_message_falls_back_to_stdout() {
    let err = push_failed(Some(1), "  from stdout \n", "");
    assert_eq!(err.message, "from stdout");
}

#[test]
fn push_failed_message_falls_back_to_exit_code() {
    assert_eq!(
        push_failed(Some(1), "", "").message,
        "git push failed with exit code 1"
    );
}

#[test]
fn push_failed_message_falls_back_to_signal() {
    assert_eq!(
        push_failed(None, "", "").message,
        "git push was terminated by a signal"
    );
}

#[test]
fn commit_failed_message_still_names_commit_after_the_helper_is_generalised() {
    let err = AppError::from(GitError::CommitFailed {
        code: Some(3),
        stdout: String::new(),
        stderr: String::new(),
    });
    assert_eq!(err.message, "git commit failed with exit code 3");
}

// GR-8: the commit graph error kinds.
#[test]
fn log_stale_maps_to_the_log_stale_kind_with_the_core_message() {
    let err = GitError::LogStale;
    let message = err.to_string();
    let app: AppError = err.into();
    assert_eq!(
        app,
        AppError {
            kind: AppErrorKind::LogStale,
            message
        }
    );
}

#[test]
fn log_stale_message_tells_the_user_to_reload() {
    let app: AppError = GitError::LogStale.into();
    assert_eq!(app.message, "the commit graph changed; reload it");
}

#[test]
fn commit_not_found_maps_to_its_kind_and_names_the_oid() {
    let app: AppError = GitError::CommitNotFound("abc123".into()).into();
    assert_eq!(
        app,
        AppError {
            kind: AppErrorKind::CommitNotFound,
            message: "abc123 is not a commit in this repository".into()
        }
    );
}

#[test]
fn log_stale_serializes_as_camel_case() {
    let app: AppError = GitError::LogStale.into();
    assert_eq!(
        serde_json::to_value(&app).unwrap()["kind"],
        json!("logStale")
    );
}

#[test]
fn commit_not_found_serializes_as_camel_case() {
    let app: AppError = GitError::CommitNotFound("x".into()).into();
    assert_eq!(
        serde_json::to_value(&app).unwrap()["kind"],
        json!("commitNotFound")
    );
}
