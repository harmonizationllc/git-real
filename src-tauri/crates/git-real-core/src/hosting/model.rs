//! Data types the hosting domain hands to the app layer.

use serde::{Deserialize, Serialize};

use super::provider::{Provider, RepoRef, host_port};
use crate::error::GitError;
use crate::remote::host::strip_user;

/// Rows per provider page; every list request asks for this many.
pub(crate) const PAGE_SIZE: usize = 50;

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

/// What the provider says about a hosted repository beyond its pull requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedRepoInfo {
    /// `None` for an empty repository.
    pub default_branch: Option<String>,
    /// `false` when the repository has its issue tracker turned off.
    pub issues_enabled: bool,
}

/// An open issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub labels: Vec<String>,
    /// Epoch seconds.
    pub updated_at: i64,
    pub web_url: String,
}

/// A pull request to open: `source_branch` into `target_branch`, both on the hosted repository.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPullRequest {
    pub title: String,
    pub body: String,
    pub source_branch: String,
    pub target_branch: String,
}

/// A repository the account can clone, from the clone dialog's browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedRepo {
    pub full_name: String,
    pub name: String,
    /// The user, organization, group path or workspace the repository belongs to.
    pub owner: String,
    pub description: Option<String>,
    pub private: bool,
    /// Epoch seconds.
    pub updated_at: i64,
    pub https_url: String,
    pub ssh_url: Option<String>,
    pub web_url: String,
}

impl HostedRepo {
    /// The repository with clone URLs safe to hand to `git clone`: `None` when `https_url` is
    /// not a plain `https://<host>/<path>` (userinfo is stripped), `ssh_url` dropped when it is
    /// not a plain scp-like or `ssh://` URL, and an empty description as `None`.
    pub fn sanitized(self) -> Option<HostedRepo> {
        let https_url = clean_https_url(&self.https_url)?;
        Some(HostedRepo {
            https_url,
            ssh_url: self.ssh_url.and_then(clean_ssh_url),
            description: self.description.filter(|d| !d.is_empty()),
            ..self
        })
    }
}

/// One page of the account's repositories.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedRepoPage {
    pub repos: Vec<HostedRepo>,
    /// The provider returned a full raw page (50 rows before sanitising), so there may be more.
    pub has_more: bool,
}

impl HostedRepoPage {
    /// One raw provider page: `has_more` from the raw row count, before any row is dropped.
    pub(crate) fn from_raw<W>(
        raw: Vec<W>,
        convert: impl FnMut(W) -> Result<Option<HostedRepo>, GitError>,
    ) -> Result<Self, GitError> {
        let has_more = raw.len() == PAGE_SIZE;
        let repos = raw
            .into_iter()
            .map(convert)
            .filter_map(Result::transpose)
            .collect::<Result<_, _>>()?;
        Ok(Self { repos, has_more })
    }
}

/// `https://<host[:port]>/<path>` with any `user@` dropped; `None` for another scheme, a bad
/// host, an empty path, or any whitespace or control character.
fn clean_https_url(url: &str) -> Option<String> {
    let (authority, path) = url.strip_prefix("https://")?.split_once('/')?;
    let authority = strip_user(authority);
    host_port(authority)?;
    let cleaned = format!("https://{authority}/{path}");
    (!path.is_empty() && !has_space_or_control(&cleaned)).then_some(cleaned)
}

/// `user@host:path` (`[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:` then a non-empty path) or an `ssh://`
/// URL whose host and optional port are validated as for `https_url` and with a non-empty path
/// after them; the user may not start with `-` (git would read it as an ssh option), and no
/// whitespace or control character anywhere.
fn clean_ssh_url(url: String) -> Option<String> {
    if has_space_or_control(&url) {
        return None;
    }
    let ok = if let Some(rest) = url.strip_prefix("ssh://") {
        rest.split_once('/').is_some_and(|(authority, path)| {
            !authority.starts_with('-')
                && host_port(strip_user(authority)).is_some()
                && !path.is_empty()
        })
    } else {
        url.split_once('@')
            .and_then(|(user, rest)| Some((user, rest.split_once(':')?)))
            .is_some_and(|(user, (host, path))| {
                plain(user, b"._-") && plain(host, b".-") && !path.is_empty()
            })
    };
    ok.then_some(url)
}

/// Non-empty, not starting with `-`, ASCII alphanumerics and `extra` only.
fn plain(s: &str, extra: &[u8]) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
}

fn has_space_or_control(s: &str) -> bool {
    s.chars().any(|c| c.is_whitespace() || c.is_control())
}
