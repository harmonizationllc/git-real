//! Serializable error type sent across the IPC boundary.

use git_real_core::GitError;
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
}

/// Error returned from commands: a stable `kind` plus a human-readable `message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: AppErrorKind,
    pub message: String,
}

impl AppError {
    /// Error for a repository id that is not (or no longer) registered.
    pub fn unknown_repo(id: RepoId) -> Self {
        Self {
            kind: AppErrorKind::UnknownRepo,
            message: format!("no open repository with id {id}"),
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
            GitError::Git2(_) => AppErrorKind::Git,
        };
        Self {
            kind,
            message: error.to_string(),
        }
    }
}
