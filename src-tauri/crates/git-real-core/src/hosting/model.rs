//! Data types the hosting domain hands to the app layer.

use serde::Serialize;

use super::provider::{Provider, RepoRef};

/// The account a token belongs to, as the provider reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserInfo {
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// A connected account: one per `(provider, host)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// [`Account::key`], also the keychain user of its token.
    pub id: String,
    pub provider: Provider,
    pub host: String,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    /// The provider rejected this account's token; reconnecting clears it.
    pub needs_reconnect: bool,
}

impl Account {
    pub fn new(provider: Provider, host: &str, user: UserInfo) -> Self {
        Self {
            id: Self::key(provider, host, &user.username),
            provider,
            host: host.to_owned(),
            username: user.username,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
            needs_reconnect: false,
        }
    }

    /// `<provider>:<host>:<username>`, e.g. `github:github.com:octo`.
    pub fn key(provider: Provider, host: &str, username: &str) -> String {
        format!("{}:{host}:{username}", provider.as_str())
    }
}

/// The hosted repository behind `origin` and the account connected for its host, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoContext {
    pub repo: RepoRef,
    pub account: Option<Account>,
}

/// A pull request's combined CI status. Never `use CiState::*`: its `None` would shadow
/// `Option::None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CiState {
    Passing,
    Failing,
    Pending,
    None,
}

/// An open pull request (a merge request on GitLab).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    /// The head lives in another repository than the base (or that repository is gone).
    pub from_fork: bool,
    /// The fork's `https://` clone URL, when the provider gives one.
    pub fork_clone_url: Option<String>,
    pub draft: bool,
    pub ci_state: CiState,
    /// Epoch seconds.
    pub updated_at: i64,
    pub web_url: String,
}
