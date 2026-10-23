//! Types for merge, rebase, cherry-pick and revert operations.

use serde::{Deserialize, Serialize};

use super::{CommitMessage, Signature};

/// How `merge_branch` integrates a branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMode {
    /// Always record a merge commit (`git merge --no-ff`).
    Merge,
    /// Only move the branch pointer (`git merge --ff-only`).
    FastForward,
}

/// The operation git has in progress, read from the repository state and the
/// `.git` marker files. Oids are full hex; unreadable fields degrade to empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OperationState {
    None,
    Merge {
        /// The commit being merged (`MERGE_HEAD`).
        head: String,
        /// A branch whose tip is `head`, when there is one.
        branch: Option<String>,
        /// git's prepared message (`MERGE_MSG`).
        message: CommitMessage,
    },
    Rebase {
        onto: String,
        onto_name: Option<String>,
        /// The branch being rebased; `None` for a detached HEAD.
        branch: Option<String>,
        step: u32,
        total: u32,
        /// `rebase-merge/amend` exists: git stopped at an `edit` step; staged
        /// changes are amended on continue.
        stopped_for_edit: bool,
    },
    CherryPick {
        oid: String,
        message: CommitMessage,
    },
    Revert {
        oid: String,
        message: CommitMessage,
    },
}

/// How an operation that ran to its end (or stopped) left the repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationOutcome {
    Completed,
    Conflicts,
    /// Exit 0 with the rebase still in progress: an `edit` step stopped it.
    Stopped,
}

/// How checking out a pull request's head left the repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CheckoutPrOutcome {
    /// HEAD is on `branch`, which contains the pull request's head.
    CheckedOut { branch: String },
    /// `branch` has commits the head does not contain; nothing changed. Checking out
    /// again with `reset` moves it.
    NeedsReset { branch: String },
}

/// One line of an interactive rebase todo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RebaseAction {
    Pick,
    Squash,
    Fixup,
    Edit,
    Drop,
}

/// A commit an interactive rebase would replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    /// Full hex object id.
    pub oid: String,
    /// The first line of the message.
    pub subject: String,
    pub author: Signature,
}

/// One entry of the user's plan, in the order git applies them (oldest first).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    /// What git does with the commit.
    pub action: RebaseAction,
    /// Full hex object id of a commit in the plan.
    pub oid: String,
}

/// Which side of a conflict to keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

/// Whether HEAD can fast-forward to a branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FastForwardCheck {
    Possible,
    UpToDate,
    Diverged,
}
