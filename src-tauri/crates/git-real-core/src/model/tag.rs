//! Local tags and the remotes they can be pushed to.

use serde::Serialize;

/// A tag under `refs/tags` that peels to a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagEntry {
    /// Short name, without `refs/tags/`.
    pub name: String,
    /// Full hex id of the commit the tag peels to.
    pub target: String,
    /// The ref points at a tag object rather than straight at a commit.
    pub annotated: bool,
    /// First line of an annotated tag's message, trimmed; `None` when blank or lightweight.
    pub subject: Option<String>,
    /// Tagger time (annotated) or the commit's time (lightweight), in Unix seconds.
    pub time: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagList {
    /// Newest first by `time`, then by name.
    pub tags: Vec<TagEntry>,
    /// Every configured remote, sorted.
    pub remotes: Vec<String>,
}
