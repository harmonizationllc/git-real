//! Integration tests for `AppError` and `AppErrorKind`.

use std::path::PathBuf;

use git_real_core::{GitError, NetworkErrorKind};
use git_real_lib::error::{AppError, AppErrorKind, NetworkInfo};
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
        (GitError::NothingToStash, AppErrorKind::NothingToStash, None),
        (GitError::StaleStash, AppErrorKind::StaleStash, None),
        (
            GitError::InvalidTagName("a b".into()),
            AppErrorKind::InvalidTagName,
            None,
        ),
        (
            GitError::TagExists("v1".into()),
            AppErrorKind::TagExists,
            None,
        ),
        (
            GitError::TagNotFound("v1".into()),
            AppErrorKind::TagNotFound,
            None,
        ),
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
        (GitError::NoRemotes, AppErrorKind::NoRemotes, None),
        (GitError::NoUpstream, AppErrorKind::NoUpstream, None),
        (GitError::DetachedHead, AppErrorKind::DetachedHead, None),
        (
            GitError::InvalidRemoteName("a b".into()),
            AppErrorKind::InvalidRemoteName,
            None,
        ),
        (
            GitError::InvalidRemoteUrl(String::new()),
            AppErrorKind::InvalidRemoteUrl,
            None,
        ),
        (
            GitError::RemoteExists("origin".into()),
            AppErrorKind::RemoteExists,
            None,
        ),
        (
            GitError::InvalidCredentials,
            AppErrorKind::InvalidCredentials,
            None,
        ),
        (GitError::LogStale, AppErrorKind::LogStale, None),
        (
            GitError::CommitNotFound("abc123".into()),
            AppErrorKind::CommitNotFound,
            None,
        ),
        (
            GitError::BinaryFile("x".into()),
            AppErrorKind::BinaryFile,
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
                message,
                network: None
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
        (AppErrorKind::LogStale, "logStale"),
        (AppErrorKind::CommitNotFound, "commitNotFound"),
        (AppErrorKind::BinaryFile, "binaryFile"),
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

fn network_failed(code: Option<i32>, stdout: &str, stderr: &str) -> AppError {
    GitError::NetworkFailed {
        verb: "push",
        kind: NetworkErrorKind::Other,
        https: false,
        origin: None,
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
fn network_failed_message_prefers_stderr() {
    let err = network_failed(Some(1), "out\n", "error: remote ref does not exist\n");
    assert_eq!(err.kind, AppErrorKind::NetworkFailed);
    assert_eq!(err.message, "error: remote ref does not exist");
}

#[test]
fn network_failed_message_falls_back_to_stdout() {
    let err = network_failed(Some(1), "  from stdout \n", "");
    assert_eq!(err.message, "from stdout");
}

#[test]
fn network_failed_message_falls_back_to_exit_code() {
    assert_eq!(
        network_failed(Some(1), "", "").message,
        "git push failed with exit code 1"
    );
}

#[test]
fn network_failed_message_falls_back_to_signal() {
    assert_eq!(
        network_failed(None, "", "").message,
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
            message,
            network: None
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
            message: "abc123 is not a commit in this repository".into(),
            network: None
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

// GR-9: BinaryFile crosses IPC as `binaryFile`.
#[test]
fn binary_file_maps_to_the_binary_file_kind_with_the_core_message() {
    let err = GitError::BinaryFile("x".into());
    let message = err.to_string();
    let app: AppError = err.into();
    assert_eq!(
        app,
        AppError {
            kind: AppErrorKind::BinaryFile,
            message,
            network: None
        }
    );
}

#[test]
fn binary_file_message_names_the_path() {
    let app: AppError = GitError::BinaryFile("x".into()).into();
    assert_eq!(app.message, "x is a binary file");
}

#[test]
fn binary_file_serializes_as_camel_case() {
    let app: AppError = GitError::BinaryFile("x".into()).into();
    assert_eq!(
        serde_json::to_value(&app).unwrap()["kind"],
        json!("binaryFile")
    );
}

#[test]
fn binary_file_kind_serializes_as_binary_file() {
    assert_eq!(
        serde_json::to_value(AppErrorKind::BinaryFile).unwrap(),
        json!("binaryFile")
    );
}

// GR-10a operation errors: each core variant maps to its own kind.
#[test]
fn operation_errors_map_to_their_kinds() {
    let cases = [
        (
            GitError::OperationFailed {
                verb: "merge".into(),
                code: Some(1),
                stdout: String::new(),
                stderr: "boom".into(),
            },
            AppErrorKind::OperationFailed,
        ),
        (
            GitError::OperationInProgress,
            AppErrorKind::OperationInProgress,
        ),
        (GitError::NoOperation, AppErrorKind::NoOperation),
        (
            GitError::UnresolvedConflicts,
            AppErrorKind::UnresolvedConflicts,
        ),
        (
            GitError::MergeCommit("abc".into()),
            AppErrorKind::MergeCommit,
        ),
    ];
    for (err, expected) in cases {
        let app: AppError = err.into();
        assert_eq!(app.kind, expected);
    }
}

#[test]
fn operation_error_kinds_serialize_camel_case() {
    let cases = [
        (AppErrorKind::OperationFailed, "operationFailed"),
        (AppErrorKind::OperationInProgress, "operationInProgress"),
        (AppErrorKind::NoOperation, "noOperation"),
        (AppErrorKind::UnresolvedConflicts, "unresolvedConflicts"),
        (AppErrorKind::MergeCommit, "mergeCommit"),
    ];
    for (kind, expected) in cases {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(expected));
    }
}

fn operation_failed(code: Option<i32>, stdout: &str, stderr: &str) -> AppError {
    GitError::OperationFailed {
        verb: "merge".into(),
        code,
        stdout: stdout.into(),
        stderr: stderr.into(),
    }
    .into()
}

#[test]
fn operation_failed_message_prefers_stderr() {
    assert_eq!(
        operation_failed(Some(128), "out", "fatal: x").message,
        "fatal: x"
    );
}

#[test]
fn operation_failed_message_falls_back_to_stdout() {
    assert_eq!(
        operation_failed(Some(1), "only out", "").message,
        "only out"
    );
}

#[test]
fn operation_failed_message_falls_back_to_exit_code_naming_the_verb() {
    assert_eq!(
        operation_failed(Some(128), "", "").message,
        "git merge failed with exit code 128"
    );
}

#[test]
fn operation_failed_message_falls_back_to_signal_naming_the_verb() {
    assert_eq!(
        operation_failed(None, "", "").message,
        "git merge was terminated by a signal"
    );
}

#[test]
fn operation_failed_message_names_the_verb_it_was_given() {
    let app: AppError = GitError::OperationFailed {
        verb: "cherry-pick".into(),
        code: Some(2),
        stdout: String::new(),
        stderr: String::new(),
    }
    .into();
    assert_eq!(app.message, "git cherry-pick failed with exit code 2");
}

#[test]
fn operation_errors_keep_the_core_display_message() {
    let in_progress: AppError = GitError::OperationInProgress.into();
    let none: AppError = GitError::NoOperation.into();
    let unresolved: AppError = GitError::UnresolvedConflicts.into();
    let merge_commit: AppError = GitError::MergeCommit("abc".into()).into();
    assert_eq!(in_progress.message, "another operation is in progress");
    assert_eq!(
        none.message,
        "no merge, rebase, cherry-pick or revert is in progress"
    );
    assert_eq!(unresolved.message, "resolve all conflicts first");
    assert!(
        merge_commit.message.contains("abc"),
        "{}",
        merge_commit.message
    );
}

// GR-11a: the stash kinds are camelCase on the wire.
#[test]
fn stash_kinds_serialize_camel_case() {
    assert_eq!(
        serde_json::to_value(AppErrorKind::NothingToStash).unwrap(),
        json!("nothingToStash")
    );
    assert_eq!(
        serde_json::to_value(AppErrorKind::StaleStash).unwrap(),
        json!("staleStash")
    );
}

// GR-11b: the tag kinds are camelCase on the wire.
#[test]
fn tag_kinds_serialize_camel_case() {
    assert_eq!(
        serde_json::to_value(AppErrorKind::InvalidTagName).unwrap(),
        json!("invalidTagName")
    );
    assert_eq!(
        serde_json::to_value(AppErrorKind::TagExists).unwrap(),
        json!("tagExists")
    );
    assert_eq!(
        serde_json::to_value(AppErrorKind::TagNotFound).unwrap(),
        json!("tagNotFound")
    );
}

// GR-11b: the tag error messages name the tag.
#[test]
fn tag_error_messages_name_the_tag() {
    let invalid: AppError = GitError::InvalidTagName("a b".into()).into();
    let exists: AppError = GitError::TagExists("v1".into()).into();
    let missing: AppError = GitError::TagNotFound("v1".into()).into();
    assert_eq!(invalid.message, "a b is not a valid tag name");
    assert_eq!(exists.message, "a tag named v1 already exists");
    assert_eq!(missing.message, "no tag named v1");
}

// GR-12: the new remote kinds cross IPC in camelCase.
#[test]
fn remote_kinds_serialize_camel_case() {
    let cases = [
        (AppErrorKind::NetworkFailed, "networkFailed"),
        (AppErrorKind::NoRemotes, "noRemotes"),
        (AppErrorKind::NoUpstream, "noUpstream"),
        (AppErrorKind::DetachedHead, "detachedHead"),
        (AppErrorKind::InvalidRemoteName, "invalidRemoteName"),
        (AppErrorKind::InvalidRemoteUrl, "invalidRemoteUrl"),
        (AppErrorKind::RemoteExists, "remoteExists"),
        (AppErrorKind::InvalidCredentials, "invalidCredentials"),
    ];
    for (kind, expected) in cases {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(expected));
    }
}

#[test]
fn network_failed_carries_the_network_payload() {
    let stderr =
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
    let app: AppError = GitError::NetworkFailed {
        verb: "fetch",
        kind: NetworkErrorKind::HttpsAuthRequired,
        https: true,
        origin: Some("https://github.com".into()),
        code: Some(128),
        stdout: String::new(),
        stderr: stderr.into(),
    }
    .into();
    assert_eq!(app.kind, AppErrorKind::NetworkFailed);
    assert_eq!(app.message, stderr.trim());
    assert_eq!(
        app.network,
        Some(NetworkInfo {
            verb: "fetch".into(),
            kind: NetworkErrorKind::HttpsAuthRequired,
            https: true,
            origin: Some("https://github.com".into())
        })
    );
    assert_eq!(
        serde_json::to_value(&app).unwrap(),
        json!({
            "kind": "networkFailed",
            "message": stderr.trim(),
            "network": { "verb": "fetch", "kind": "httpsAuthRequired", "https": true, "origin": "https://github.com" }
        })
    );
}

#[test]
fn other_errors_serialize_without_a_network_key() {
    assert_eq!(
        serde_json::to_value(AppError::from(GitError::NoUpstream)).unwrap(),
        json!({ "kind": "noUpstream", "message": "the current branch has no upstream branch" })
    );
}

#[test]
fn remote_error_messages_use_the_core_display_text() {
    let msg = |e: GitError| AppError::from(e).message;
    assert_eq!(msg(GitError::NoRemotes), "this repository has no remotes");
    assert_eq!(msg(GitError::DetachedHead), "HEAD is not on a branch");
    assert_eq!(
        msg(GitError::InvalidRemoteName("a b".into())),
        "a b is not a valid remote name"
    );
    assert_eq!(
        msg(GitError::InvalidRemoteUrl(String::new())),
        "\"\" is not a valid remote URL"
    );
    assert_eq!(
        msg(GitError::RemoteExists("origin".into())),
        "a remote named origin already exists"
    );
    assert_eq!(
        msg(GitError::InvalidCredentials),
        "the credentials must name an http(s) origin and contain no line breaks"
    );
}
