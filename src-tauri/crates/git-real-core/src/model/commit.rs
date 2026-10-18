//! Types for composing and recording a commit.

use serde::{Deserialize, Serialize};

/// A commit message as the UI edits it: one-line subject plus free-form body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessage {
    pub subject: String,
    pub body: String,
}

/// Git's `gpg.format` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SigningFormat {
    OpenPgp,
    X509,
    Ssh,
}

/// What Git config says about the next commit's author and signing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitConfig {
    /// `user.name`, `None` when unset or blank.
    pub name: Option<String>,
    /// `user.email`, `None` when unset or blank.
    pub email: Option<String>,
    /// `Some` when `commit.gpgsign` is true; the format follows `gpg.format`.
    pub signing: Option<SigningFormat>,
}

/// The commit that `git commit` produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    /// Full hex object id.
    pub oid: String,
    /// First line of the recorded message.
    pub summary: String,
}
