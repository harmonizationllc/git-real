//! GitHub and GitHub Enterprise Server REST v3.

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::json;

use super::http::{
    Request, Transport, get, issue_query, parse_timestamp, percent_encode, post_json, send_json,
    unexpected,
};
use super::model::{CiState, HostedRepoInfo, Issue, NewPullRequest, PullRequest, UserInfo};
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

#[derive(Deserialize)]
struct WireRepoInfo {
    default_branch: String,
    has_issues: Option<bool>,
}

#[derive(Deserialize)]
struct WireSearch {
    items: Vec<WireIssue>,
}

#[derive(Deserialize)]
struct WireIssue {
    number: u64,
    title: String,
    /// `null` or missing for some deleted accounts; the schema does not promise `ghost`.
    user: Option<WireLogin>,
    labels: Vec<WireLabel>,
    updated_at: String,
    html_url: String,
    /// Present when the search hit is a pull request.
    pull_request: Option<IgnoredAny>,
}

#[derive(Deserialize)]
struct WireLabel {
    name: String,
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

pub fn repo_info(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
) -> Result<HostedRepoInfo, GitError> {
    let info: WireRepoInfo =
        send_json(t, &get(repo_url(repo), token, &HEADERS), token, &repo.host)?;
    Ok(HostedRepoInfo {
        default_branch: Some(info.default_branch),
        issues_enabled: info.has_issues.unwrap_or(true),
    })
}

/// The user's search terms without `repo:`, `org:` or `user:` qualifiers (negated or not, any
/// case), so a query can never widen or move the search beyond this repository.
fn strip_repo_qualifiers(query: &str) -> String {
    const SCOPES: [&[u8]; 3] = [b"repo:", b"org:", b"user:"];
    query
        .split_ascii_whitespace()
        .filter(|t| {
            let s = t.strip_prefix('-').unwrap_or(t).as_bytes();
            !SCOPES
                .iter()
                .any(|p| s.len() >= p.len() && s[..p.len()].eq_ignore_ascii_case(p))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Issues come from the search API, so the same call serves the list and the picker; pull
/// requests among the hits are dropped.
pub fn list_issues(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    query: &str,
    page: u32,
) -> Result<Vec<Issue>, GitError> {
    let mut q = format!("repo:{}/{} is:issue is:open", repo.namespace, repo.name);
    let query = strip_repo_qualifiers(issue_query(query));
    if !query.is_empty() {
        q = format!("{q} {query}");
    }
    let url = format!(
        "{}/search/issues?q={}&sort=updated&order=desc&per_page=50&page={page}",
        repo.provider.api_base(&repo.host),
        percent_encode(&q)
    );
    let found: WireSearch = send_json(t, &get(url, token, &HEADERS), token, &repo.host)?;
    found
        .items
        .into_iter()
        .filter(|i| i.pull_request.is_none())
        .map(|i| {
            Ok(Issue {
                number: i.number,
                title: i.title,
                author: i.user.map(|u| u.login).unwrap_or_default(),
                labels: i.labels.into_iter().map(|l| l.name).collect(),
                updated_at: parse_timestamp(&i.updated_at).ok_or_else(|| unexpected(&repo.host))?,
                web_url: i.html_url,
            })
        })
        .collect()
}

pub fn create_pull_request(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    new: &NewPullRequest,
) -> Result<PullRequest, GitError> {
    let body = json!({
        "title": new.title,
        "body": new.body,
        "head": new.source_branch,
        "base": new.target_branch,
    });
    let req = with_github_headers(post_json(pulls_url(repo), token, &body));
    let pull: WirePull = send_json(t, &req, token, &repo.host)?;
    convert(pull, &repo.host)
}

/// `req` with GitHub's `Accept` in place of the generic one, plus the API version header.
fn with_github_headers(mut req: Request) -> Request {
    for (name, value) in HEADERS {
        if name.eq_ignore_ascii_case("accept") {
            req.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
        }
        req.headers.push((name.to_owned(), value.to_owned()));
    }
    req
}

/// `{base}/repos/{owner}/{name}`.
fn repo_url(repo: &RepoRef) -> String {
    format!(
        "{}/repos/{}/{}",
        repo.provider.api_base(&repo.host),
        percent_encode(&repo.namespace),
        percent_encode(&repo.name)
    )
}

fn pulls_url(repo: &RepoRef) -> String {
    format!("{}/pulls", repo_url(repo))
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
