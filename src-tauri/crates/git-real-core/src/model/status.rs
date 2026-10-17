use serde::{Deserialize, Serialize};

/// The kind of change recorded for one side (index or worktree) of a status entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChange,
    Untracked,
    Conflicted,
}

/// One changed path in the working tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    /// Repo-relative, `/` separated.
    pub path: String,
    /// `Some` for renames.
    pub old_path: Option<String>,
    /// HEAD -> index.
    pub index: Option<ChangeKind>,
    /// Index -> workdir (`Untracked` lives here).
    pub worktree: Option<ChangeKind>,
    pub conflicted: bool,
}

/// The working tree status of a repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeStatus {
    /// Sorted by path, stable.
    pub entries: Vec<StatusEntry>,
    pub head_unborn: bool,
}
