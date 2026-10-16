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
    ];
    for (kind, expected) in cases {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(expected));
    }
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
