//! GitHub and GitHub Enterprise Server REST v3.

use serde::Deserialize;

use super::http::{Transport, get, parse_timestamp, percent_encode, send_json, unexpected};
use super::model::{CiState, PullRequest, UserInfo};
use super::provider::{Provider, RepoRef};
use crate::error::GitError;
use crate::token::Token;

const HEADERS: [(&str, &str); 2] = [
    ("Accept", "application/vnd.github+json"),
    ("X-GitHub-Api-Version", "2022-11-28"),
];

#[derive(Deserialize)]
struct WireUser {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct WirePull {
    number: u64,
    title: String,
    user: WireLogin,
    head: WireHead,
    base: WireBase,
    draft: Option<bool>,
    updated_at: String,
    html_url: String,
}

#[derive(Deserialize)]
struct WireLogin {
    login: String,
}

#[derive(Deserialize)]
struct WireHead {
    #[serde(rename = "ref")]
    branch: String,
    /// `null` once the fork is deleted.
    repo: Option<WireRepo>,
}

#[derive(Deserialize)]
struct WireBase {
    #[serde(rename = "ref")]
    branch: String,
    repo: WireRepo,
}

#[derive(Deserialize)]
struct WireRepo {
    full_name: String,
    clone_url: Option<String>,
}

pub fn current_user(t: &dyn Transport, host: &str, token: &Token) -> Result<UserInfo, GitError> {
    let url = format!("{}/user", Provider::GitHub.api_base(host));
    let user: WireUser = send_json(t, &get(url, token, &HEADERS), token, host)?;
    Ok(UserInfo {
        username: user.login,
        display_name: user.name,
        avatar_url: user.avatar_url,
    })
}

pub fn list_pull_requests(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    page: u32,
) -> Result<Vec<PullRequest>, GitError> {
    let url = format!(
        "{}?state=open&sort=updated&direction=desc&per_page=50&page={page}",
        pulls_url(repo)
    );
    let pulls: Vec<WirePull> = send_json(t, &get(url, token, &HEADERS), token, &repo.host)?;
    pulls.into_iter().map(|p| convert(p, &repo.host)).collect()
}

pub fn get_pull_request(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    number: u64,
) -> Result<PullRequest, GitError> {
    let url = format!("{}/{number}", pulls_url(repo));
    let pull: WirePull = send_json(t, &get(url, token, &HEADERS), token, &repo.host)?;
    convert(pull, &repo.host)
}

fn pulls_url(repo: &RepoRef) -> String {
    format!(
        "{}/repos/{}/{}/pulls",
        repo.provider.api_base(&repo.host),
        percent_encode(&repo.namespace),
        percent_encode(&repo.name)
    )
}

fn convert(p: WirePull, host: &str) -> Result<PullRequest, GitError> {
    let from_fork = p
        .head
        .repo
        .as_ref()
        .is_none_or(|r| r.full_name != p.base.repo.full_name);
    let fork_clone_url = p
        .head
        .repo
        .and_then(|r| r.clone_url)
        .filter(|u| from_fork && u.starts_with("https://"));
    Ok(PullRequest {
        number: p.number,
        title: p.title,
        author: p.user.login,
        source_branch: p.head.branch,
        target_branch: p.base.branch,
        from_fork,
        fork_clone_url,
        draft: p.draft.unwrap_or(false),
        ci_state: CiState::None,
        updated_at: parse_timestamp(&p.updated_at).ok_or_else(|| unexpected(host))?,
        web_url: p.html_url,
    })
}
