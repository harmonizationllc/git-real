//! Stash list entries, a stash's files and the result of applying one.

use serde::Serialize;

use super::CommitFile;

/// One entry of the `refs/stash` reflog; `index` is n in `stash@{n}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    /// Full hex id of the stash commit.
    pub oid: String,
    /// The reflog message, e.g. "On main: wip" or "WIP on main: abc1234 subject".
    pub message: String,
    /// The branch of git's "On <b>: " / "WIP on <b>: " prefix; `None` for
    /// "(no branch)" or a message without that prefix (a branch holds no space or ':').
    pub branch: Option<String>,
    /// Reflog committer time in Unix seconds.
    pub time: i64,
    /// Full hex id of the commit the stash was made on (its first parent).
    pub base: String,
    /// The stash has a third parent holding untracked files.
    pub has_untracked: bool,
}

/// A stash's tracked changes (against its base) and untracked files (against the empty tree).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashFiles {
    pub tracked: Vec<CommitFile>,
    pub untracked: Vec<CommitFile>,
    /// Full hex id of the untracked-files commit, when there is one.
    pub untracked_oid: Option<String>,
}

/// How an apply or pop ended; conflicts are an outcome, not an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StashOutcome {
    Applied,
    Conflicts,
    /// A pop applied cleanly but its stash could not be dropped; the stash is still listed.
    AppliedNotDropped,
}
