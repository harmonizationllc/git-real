//! Linked worktree types sent to the refs column's Worktrees section.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::HeadState;

/// One worktree of the repository: the main one or a linked one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedWorktree {
    /// The admin name under `<commondir>/worktrees/`; `None` for the main worktree.
    pub name: Option<String>,
    /// Canonical when the folder exists, otherwise the registered path.
    pub path: PathBuf,
    /// `None` when HEAD cannot be read at all.
    pub head: Option<HeadState>,
    pub is_main: bool,
    /// The worktree this session has open.
    pub is_current: bool,
    /// The folder is gone; git keeps the entry until a prune.
    pub missing: bool,
    /// The lock reason (empty when locked without one).
    pub locked: Option<String>,
}

/// The branch a new worktree checks out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorktreeBranch {
    /// A local branch no worktree has checked out.
    Existing { name: String },
    /// A new branch at `start` (any revision, passed to git verbatim) or HEAD.
    New { name: String, start: Option<String> },
}

/// The entries a prune removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrunedWorktrees {
    pub paths: Vec<PathBuf>,
}
