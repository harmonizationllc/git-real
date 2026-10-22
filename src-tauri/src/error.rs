//! Serializable error type sent across the IPC boundary.

use git_real_core::{GitError, NetworkErrorKind};
use serde::Serialize;

use crate::state::RepoId;

/// Machine-readable error category; the front end switches on its camelCase name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppErrorKind {
    NotARepository,
    AlreadyARepository,
    PathNotFound,
    GitCliMissing,
    CloneFailed,
    Io,
    Git,
    UnknownRepo,
    NoChanges,
    BadSelection,
    ApplyFailed,
    TooLarge,
    EmptyMessage,
    NothingToCommit,
    CommitFailed,
    InvalidBranchName,
    BranchExists,
    BranchNotFound,
    BranchNotMerged,
    CannotDeleteCurrent,
    UnbornHead,
    RevisionNotFound,
    RemoteNotFound,
    CheckoutFailed,
    LogStale,
    CommitNotFound,
    BinaryFile,
    OperationFailed,
    OperationInProgress,
    NoOperation,
    UnresolvedConflicts,
    MergeCommit,
    NothingToStash,
    StaleStash,
    InvalidTagName,
    TagExists,
    TagNotFound,
    NetworkFailed,
    NoRemotes,
    NoUpstream,
    DetachedHead,
    InvalidRemoteName,
    InvalidRemoteUrl,
    RemoteExists,
    InvalidCredentials,
}

/// What the UI needs to act on a network failure; stderr stays in `message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub verb: String,
    pub kind: NetworkErrorKind,
    pub https: bool,
    pub origin: Option<String>,
    // `Box<str>` keeps `AppError` under clippy's `result_large_err` threshold (128 bytes).
    /// The SSH host named by an SSH auth or host-key failure.
    pub host: Option<Box<str>>,
    /// The server's reason for a `remoteRejected` push.
    pub reason: Option<Box<str>>,
}

/// Error returned from commands: a stable `kind` plus a human-readable `message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: AppErrorKind,
    pub message: String,
    /// Present for `networkFailed` only; omitted from the JSON otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<NetworkInfo>,
}

impl AppError {
    /// Error for a repository id that is not (or no longer) registered.
    pub fn unknown_repo(id: RepoId) -> Self {
        Self {
            kind: AppErrorKind::UnknownRepo,
            message: format!("no open repository with id {id}"),
            network: None,
        }
    }
}

impl From<GitError> for AppError {
    fn from(error: GitError) -> Self {
        let kind = match &error {
            GitError::NotARepository(_) => AppErrorKind::NotARepository,
            GitError::AlreadyARepository(_) => AppErrorKind::AlreadyARepository,
            GitError::PathNotFound(_) => AppErrorKind::PathNotFound,
            GitError::GitCliMissing => AppErrorKind::GitCliMissing,
            GitError::CloneFailed { .. } => AppErrorKind::CloneFailed,
            GitError::Io(_) => AppErrorKind::Io,
            GitError::NoChanges(_) => AppErrorKind::NoChanges,
            GitError::BadSelection => AppErrorKind::BadSelection,
            GitError::ApplyFailed(_) => AppErrorKind::ApplyFailed,
            GitError::TooLarge { .. } => AppErrorKind::TooLarge,
            GitError::EmptyMessage => AppErrorKind::EmptyMessage,
            GitError::NothingToCommit => AppErrorKind::NothingToCommit,
            GitError::CommitFailed { .. } => AppErrorKind::CommitFailed,
            GitError::InvalidBranchName(_) => AppErrorKind::InvalidBranchName,
            GitError::BranchExists(_) => AppErrorKind::BranchExists,
            GitError::BranchNotFound(_) => AppErrorKind::BranchNotFound,
            GitError::BranchNotMerged(_) => AppErrorKind::BranchNotMerged,
            GitError::CannotDeleteCurrent(_) => AppErrorKind::CannotDeleteCurrent,
            GitError::UnbornHead => AppErrorKind::UnbornHead,
            GitError::RevisionNotFound(_) => AppErrorKind::RevisionNotFound,
            GitError::RemoteNotFound(_) => AppErrorKind::RemoteNotFound,
            GitError::CheckoutFailed { .. } => AppErrorKind::CheckoutFailed,
            GitError::LogStale => AppErrorKind::LogStale,
            GitError::CommitNotFound(_) => AppErrorKind::CommitNotFound,
            GitError::BinaryFile(_) => AppErrorKind::BinaryFile,
            GitError::OperationFailed { .. } => AppErrorKind::OperationFailed,
            GitError::OperationInProgress => AppErrorKind::OperationInProgress,
            GitError::NoOperation => AppErrorKind::NoOperation,
            GitError::UnresolvedConflicts => AppErrorKind::UnresolvedConflicts,
            GitError::MergeCommit(_) => AppErrorKind::MergeCommit,
            GitError::NothingToStash => AppErrorKind::NothingToStash,
            GitError::StaleStash => AppErrorKind::StaleStash,
            GitError::InvalidTagName(_) => AppErrorKind::InvalidTagName,
            GitError::TagExists(_) => AppErrorKind::TagExists,
            GitError::TagNotFound(_) => AppErrorKind::TagNotFound,
            GitError::NetworkFailed { .. } => AppErrorKind::NetworkFailed,
            GitError::NoRemotes => AppErrorKind::NoRemotes,
            GitError::NoUpstream => AppErrorKind::NoUpstream,
            GitError::DetachedHead => AppErrorKind::DetachedHead,
            GitError::InvalidRemoteName(_) => AppErrorKind::InvalidRemoteName,
            GitError::InvalidRemoteUrl(_) => AppErrorKind::InvalidRemoteUrl,
            GitError::RemoteExists(_) => AppErrorKind::RemoteExists,
            GitError::InvalidCredentials => AppErrorKind::InvalidCredentials,
            GitError::Git2(_) => AppErrorKind::Git,
        };
        let message = match &error {
            GitError::CloneFailed { code, stderr } => clone_failure_message(*code, stderr),
            GitError::CommitFailed {
                code,
                stdout,
                stderr,
            } => cli_failure_message("commit", *code, stdout, stderr),
            GitError::CheckoutFailed {
                code,
                stdout,
                stderr,
            } => cli_failure_message("switch", *code, stdout, stderr),
            GitError::NetworkFailed {
                verb,
                code,
                stdout,
                stderr,
                ..
            } => cli_failure_message(verb, *code, stdout, stderr),
            GitError::OperationFailed {
                verb,
                code,
                stdout,
                stderr,
            } => cli_failure_message(verb, *code, stdout, stderr),
            _ => error.to_string(),
        };
        let network = match &error {
            GitError::NetworkFailed {
                verb,
                kind,
                https,
                origin,
                detail,
                ..
            } => Some(NetworkInfo {
                verb: (*verb).to_owned(),
                kind: *kind,
                https: *https,
                origin: origin.clone(),
                host: detail.host.as_deref().map(Box::from),
                reason: detail.reason.as_deref().map(Box::from),
            }),
            _ => None,
        };
        Self {
            kind,
            message,
            network,
        }
    }
}

/// Reduces git's clone stderr (mostly progress noise) to its `fatal:`/`error:` lines.
fn clone_failure_message(code: Option<i32>, stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .split(['\n', '\r'])
        .map(str::trim)
        .filter(|l| l.starts_with("fatal:") || l.starts_with("error:"))
        .collect();
    if !lines.is_empty() {
        return lines.join("\n");
    }
    match code {
        Some(c) => format!("git clone failed with exit code {c}"),
        None => "git clone was terminated by a signal".to_string(),
    }
}

/// Hook and git output is what the user needs to read, so it is kept whole:
/// stderr first, then stdout, then a generic exit-status line naming the verb.
fn cli_failure_message(verb: &str, code: Option<i32>, stdout: &str, stderr: &str) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    match code {
        Some(c) => format!("git {verb} failed with exit code {c}"),
        None => format!("git {verb} was terminated by a signal"),
    }
}
