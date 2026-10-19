//! Commit graph types sent to the history view.

use serde::{Deserialize, Serialize};

use super::CommitMessage;

/// What a ref label on a graph row names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    /// A detached HEAD.
    Head,
    /// A local branch.
    Branch,
    /// A remote-tracking branch.
    Remote,
    /// A tag, lightweight or annotated.
    Tag,
}

/// A ref pointing at a commit, as drawn next to its row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub kind: RefKind,
    /// Short name, such as `main`, `origin/main`, `v1` or `HEAD`.
    pub name: String,
    /// True for the branch HEAD is on, and for a detached HEAD label.
    pub is_head: bool,
}

/// One line segment in a row. `top: None` starts at the dot, `bottom: None`
/// ends at the dot; `Some(k)` is column `k` at the row's top or bottom edge.
/// Ordered by `(top, bottom)` with `None` first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub top: Option<u32>,
    pub bottom: Option<u32>,
}

/// One commit in the graph with its lane and line segments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    /// Full hex object id.
    pub oid: String,
    /// Full hex parent ids, first parent first.
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time in Unix seconds.
    pub author_time: i64,
    /// The column of the commit's dot.
    pub lane: u32,
    pub edges: Vec<GraphEdge>,
    pub refs: Vec<RefLabel>,
}

/// The size of the cached graph and the generation that pages must quote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSummary {
    pub generation: u64,
    pub total: u32,
    pub max_lanes: u32,
}

/// A slice of graph rows starting at row index `start`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub start: u32,
    pub rows: Vec<GraphRow>,
}

/// An author or committer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub name: String,
    pub email: String,
    /// Unix seconds.
    pub time: i64,
}

/// Everything the commit summary panel shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    /// Full hex object id.
    pub oid: String,
    /// Full hex parent ids, first parent first.
    pub parents: Vec<String>,
    pub message: CommitMessage,
    pub author: Signature,
    pub committer: Signature,
}

/// How far `reset` goes, as `git reset --soft|--mixed|--hard`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}
