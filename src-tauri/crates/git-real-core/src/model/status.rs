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

/// Which side deleted a file in a modify/delete conflict, i.e. whose index
/// stage is absent while the ancestor and the other side are present.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    /// Stage 2 (ours) is absent: we deleted it, they modified it.
    DeletedByUs,
    /// Stage 3 (theirs) is absent: they deleted it, we modified it.
    DeletedByThem,
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
    /// `Some` only for a modify/delete conflict; marker conflicts are `None`.
    pub conflict: Option<ConflictKind>,
}

/// The working tree status of a repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeStatus {
    /// Sorted by path, stable.
    pub entries: Vec<StatusEntry>,
    pub head_unborn: bool,
}
