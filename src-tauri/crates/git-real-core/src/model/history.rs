//! Commit file lists, file history and blame types sent to the history views.

use serde::Serialize;

use super::{ChangeKind, Signature};

/// One path a commit changed against its first parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    /// The path before a rename.
    pub old_path: Option<String>,
    pub change: ChangeKind,
}

/// One commit that changed a file, as listed in its history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    /// Full hex object id.
    pub oid: String,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time in Unix seconds.
    pub author_time: i64,
    pub change: ChangeKind,
    /// The file's path in this commit.
    pub path: String,
    /// The path before a rename made by this commit.
    pub old_path: Option<String>,
}

/// One bounded scan of a file's history, and where the next one resumes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryPage {
    /// Newest first, in graph order.
    pub entries: Vec<FileHistoryEntry>,
    /// The row the next page starts at; `None` once the scan reached the end
    /// of a complete graph.
    pub next_row: Option<u32>,
    /// The name the scan was following when it stopped (an older name after
    /// a rename); pass it back with `next_row`.
    pub follow_path: String,
}

/// A run of consecutive lines last changed by one commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameHunk {
    /// First line, 1-based.
    pub start: u32,
    pub lines: u32,
    /// Full hex object id of the commit that last changed these lines.
    pub oid: String,
    pub author: Signature,
    pub summary: String,
}

/// A file's lines with the commit that last changed each one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    /// Full hex object id of the commit blamed at.
    pub oid: String,
    pub path: String,
    /// In line order, covering every line.
    pub hunks: Vec<BlameHunk>,
    /// The file's lines without line endings.
    pub lines: Vec<String>,
}
