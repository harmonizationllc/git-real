//! Branch listing types sent to the refs column.

use std::path::PathBuf;

use serde::Serialize;

/// What HEAD points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeadState {
    /// HEAD is on a local branch.
    Branch { name: String },
    /// HEAD points straight at a commit (full hex oid).
    Detached { oid: String },
    /// No commits yet; `name` is the branch the first commit will create.
    Unborn { name: String },
}

/// A local branch's upstream and how far apart the two are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracking {
    /// Short upstream name, such as `origin/main`.
    pub upstream: String,
    /// `None` when the upstream ref is gone.
    pub ahead: Option<u32>,
    /// `None` when the upstream ref is gone.
    pub behind: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub name: String,
    pub oid: String,
    pub is_head: bool,
    pub tracking: Option<Tracking>,
    /// The other worktree that has this branch checked out, if any.
    pub worktree: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    /// The remote, such as `origin`.
    pub remote: String,
    /// The branch name without the remote prefix.
    pub name: String,
    pub oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGroup {
    pub remote: String,
    pub branches: Vec<RemoteBranch>,
}

/// Everything the refs column shows, in one payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub head: HeadState,
    /// Sorted by name in byte order.
    pub local: Vec<LocalBranch>,
    /// Sorted by remote name, each group's branches by name.
    pub remotes: Vec<RemoteGroup>,
}
