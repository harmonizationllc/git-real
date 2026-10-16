//! Error type shared by all core operations.

use std::path::PathBuf;

use thiserror::Error;

/// Errors produced by the Git domain.
#[derive(Debug, Error)]
pub enum GitError {
    #[error("{0} is not a Git repository")]
    NotARepository(PathBuf),
    #[error("{0} is already a Git repository")]
    AlreadyARepository(PathBuf),
    #[error("{0} does not exist")]
    PathNotFound(PathBuf),
    #[error("the git executable was not found on PATH")]
    GitCliMissing,
    #[error("git clone failed (exit code {code:?}): {stderr}")]
    CloneFailed { code: Option<i32>, stderr: String },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Git2(#[from] git2::Error),
}
