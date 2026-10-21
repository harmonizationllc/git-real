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
    #[error("{0} has no changes in that scope")]
    NoChanges(String),
    #[error("the selection does not match the file's changes")]
    BadSelection,
    #[error("the patch did not apply: {0}")]
    ApplyFailed(String),
    #[error("{path} is {size} bytes, above the {limit} byte preview limit")]
    TooLarge { path: String, size: u64, limit: u64 },
    #[error("the commit message has no subject")]
    EmptyMessage,
    #[error("nothing is staged to commit")]
    NothingToCommit,
    #[error("git commit failed (exit code {code:?}): {stderr}")]
    CommitFailed {
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
    #[error("{0} is not a valid branch name")]
    InvalidBranchName(String),
    #[error("a branch named {0} already exists")]
    BranchExists(String),
    #[error("no branch named {0}")]
    BranchNotFound(String),
    #[error("{0} is not fully merged")]
    BranchNotMerged(String),
    #[error("cannot delete the current branch {0}")]
    CannotDeleteCurrent(String),
    #[error("the repository has no commits yet")]
    UnbornHead,
    #[error("{0} is not a known revision")]
    RevisionNotFound(String),
    #[error("no remote named {0}")]
    RemoteNotFound(String),
    #[error("git switch failed (exit code {code:?}): {stderr}")]
    CheckoutFailed {
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
    #[error("git push failed (exit code {code:?}): {stderr}")]
    PushFailed {
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
    #[error("the commit graph changed; reload it")]
    LogStale,
    #[error("{0} is not a commit in this repository")]
    CommitNotFound(String),
    #[error("{0} is a binary file")]
    BinaryFile(String),
    #[error("git {verb} failed")]
    OperationFailed {
        verb: String,
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
    #[error("another operation is in progress")]
    OperationInProgress,
    #[error("no merge, rebase, cherry-pick or revert is in progress")]
    NoOperation,
    #[error("resolve all conflicts first")]
    UnresolvedConflicts,
    #[error("{0} is a merge commit; choosing a parent is not supported yet")]
    MergeCommit(String),
    #[error("there are no local changes to stash")]
    NothingToStash,
    #[error("the stash list changed; reload it")]
    StaleStash,
    #[error("{0} is not a valid tag name")]
    InvalidTagName(String),
    #[error("a tag named {0} already exists")]
    TagExists(String),
    #[error("no tag named {0}")]
    TagNotFound(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Git2(#[from] git2::Error),
}
