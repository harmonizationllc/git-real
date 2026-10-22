//! Bitbucket Cloud REST 2.0 (`bitbucket.org` only). Lists come wrapped in `{ "values": [...] }`;
//! the page number drives paging, so `next` is ignored.

use serde::Deserialize;

use super::http::{Token, Transport, get, parse_timestamp, percent_encode, send_json, unexpected};
use super::model::{CiState, PullRequest, UserInfo};
use super::provider::{Provider, RepoRef};
use crate::error::GitError;

#[derive(Deserialize)]
struct WireUser {
    username: Option<String>,
    nickname: Option<String>,
    display_name: Option<String>,
    links: Option<WireUserLinks>,
}

#[derive(Deserialize)]
struct WireUserLinks {
    avatar: Option<WireHref>,
}

#[derive(Deserialize)]
struct WireHref {
    href: Option<String>,
}

#[derive(Deserialize)]
struct WirePage {
    values: Vec<WirePullRequest>,
}

#[derive(Deserialize)]
struct WirePullRequest {
    id: u64,
    title: String,
    author: WireAuthor,
    source: WireEnd,
    destination: WireEnd,
    draft: Option<bool>,
    updated_on: String,
    links: WirePullLinks,
}

#[derive(Deserialize)]
struct WireAuthor {
    nickname: Option<String>,
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct WireEnd {
    branch: WireBranch,
    /// `null` on the source side once the fork is deleted.
    repository: Option<WireRepository>,
}

#[derive(Deserialize)]
struct WireBranch {
    name: String,
}

#[derive(Deserialize)]
struct WireRepository {
    full_name: String,
}

#[derive(Deserialize)]
struct WirePullLinks {
    html: WireHtml,
}

#[derive(Deserialize)]
struct WireHtml {
    href: String,
}

pub fn current_user(t: &dyn Transport, host: &str, token: &Token) -> Result<UserInfo, GitError> {
    let url = format!("{}/user", Provider::Bitbucket.api_base(host));
    let user: WireUser = send_json(t, &get(url, token, &[]), token, host)?;
    Ok(UserInfo {
        username: user
            .username
            .or(user.nickname)
            .ok_or_else(|| unexpected(host))?,
        display_name: user.display_name,
        avatar_url: user.links.and_then(|l| l.avatar).and_then(|a| a.href),
    })
}

pub fn list_pull_requests(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    page: u32,
) -> Result<Vec<PullRequest>, GitError> {
    let url = format!(
        "{}?state=OPEN&sort=-updated_on&pagelen=50&page={page}",
        pull_requests_url(repo)
    );
    let list: WirePage = send_json(t, &get(url, token, &[]), token, &repo.host)?;
    list.values
        .into_iter()
        .map(|p| convert(p, &repo.host))
        .collect()
}

pub fn get_pull_request(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    number: u64,
) -> Result<PullRequest, GitError> {
    let url = format!("{}/{number}", pull_requests_url(repo));
    let pr: WirePullRequest = send_json(t, &get(url, token, &[]), token, &repo.host)?;
    convert(pr, &repo.host)
}

fn pull_requests_url(repo: &RepoRef) -> String {
    format!(
        "{}/repositories/{}/{}/pullrequests",
        repo.provider.api_base(&repo.host),
        percent_encode(&repo.namespace),
        percent_encode(&repo.name)
    )
}

fn convert(p: WirePullRequest, host: &str) -> Result<PullRequest, GitError> {
    let target = p
        .destination
        .repository
        .ok_or_else(|| unexpected(host))?
        .full_name;
    let source = p.source.repository.map(|r| r.full_name);
    let from_fork = source.as_ref().is_none_or(|s| *s != target);
    // The name goes into a URL git fetches from, so only a plain `workspace/slug` qualifies.
    let fork_clone_url = source
        .filter(|s| from_fork && is_plain_full_name(s))
        .map(|s| format!("https://bitbucket.org/{s}.git"));
    Ok(PullRequest {
        number: p.id,
        title: p.title,
        author: p
            .author
            .nickname
            .or(p.author.display_name)
            .unwrap_or_default(),
        source_branch: p.source.branch.name,
        target_branch: p.destination.branch.name,
        from_fork,
        fork_clone_url,
        draft: p.draft.unwrap_or(false),
        ci_state: CiState::None,
        updated_at: parse_timestamp(&p.updated_on).ok_or_else(|| unexpected(host))?,
        web_url: p.links.html.href,
    })
}

/// `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`
fn is_plain_full_name(name: &str) -> bool {
    let part = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    name.split_once('/')
        .is_some_and(|(a, b)| part(a) && part(b))
}
