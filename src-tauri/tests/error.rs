//! Integration tests for `AppError` and `AppErrorKind`.

use std::path::PathBuf;

use git_real_core::GitError;
use git_real_lib::error::{AppError, AppErrorKind};
use serde_json::json;

fn path() -> PathBuf {
    PathBuf::from("/some/path")
}

// From<GitError>: every variant maps to its documented kind, message is the
// error's Display text.
#[test]
fn app_error_kind_for_each_git_error_variant() {
    let cases: Vec<(GitError, AppErrorKind)> = vec![
        (
            GitError::NotARepository(path()),
            AppErrorKind::NotARepository,
        ),
        (
            GitError::AlreadyARepository(path()),
            AppErrorKind::AlreadyARepository,
        ),
        (GitError::PathNotFound(path()), AppErrorKind::PathNotFound),
        (GitError::GitCliMissing, AppErrorKind::GitCliMissing),
        (
            GitError::CloneFailed {
                code: Some(128),
                stderr: "boom".into(),
            },
            AppErrorKind::CloneFailed,
        ),
        (GitError::Io(std::io::Error::other("x")), AppErrorKind::Io),
        (
            GitError::Git2(git2::Error::from_str("x")),
            AppErrorKind::Git,
        ),
    ];
    for (err, expected) in cases {
        let message = err.to_string();
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
