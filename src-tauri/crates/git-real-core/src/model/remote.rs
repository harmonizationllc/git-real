//! Remotes and the fetch, pull and push operations that talk to them.

use serde::{Deserialize, Serialize};

/// What went wrong in a network operation, so the UI can say what to do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkErrorKind {
    HttpsAuthRequired,
    HttpsAuthRejected,
    SshAuthFailed,
    HostKeyUnverified,
    HostUnreachable,
    RepoNotFound,
    /// The server refused a ref (`[remote rejected]`), e.g. a hook or a push policy.
    RemoteRejected,
    PushRejectedNonFastForward,
    LeaseStale,
    Other,
}

/// Extra facts about a network failure, boxed in `GitError::NetworkFailed` to keep the error small.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkDetail {
    /// The SSH host named by the failure (SSH auth and host-key kinds only).
    pub host: Option<String>,
    /// The server's reason for refusing the push (`RemoteRejected` only).
    pub reason: Option<String>,
}

/// How a pull integrates the fetched upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    Merge,
    Rebase,
}

/// Where a push sends the current branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PushTarget {
    /// The branch's configured upstream.
    Upstream,
    /// `branch` on `remote`, which becomes the upstream (`git push -u`).
    SetUpstream { remote: String, branch: String },
}

/// The prefill for a new pull request from the current branch (GR-13 spec §5.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDraft {
    pub title: String,
    pub body: String,
    /// Commits on HEAD and not on `origin/<target>`, counted up to 1000.
    pub ahead: u32,
}

/// A configured remote with its URLs as written in the config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    /// The configured `remote.<name>.url`.
    pub fetch_url: String,
    /// The configured `remote.<name>.pushurl`, `None` when unset.
    pub push_url: Option<String>,
}
