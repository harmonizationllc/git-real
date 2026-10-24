//! Bitbucket Cloud REST 2.0 (`bitbucket.org` only). Lists come wrapped in `{ "values": [...] }`;
//! the page number drives paging, so `next` is ignored.

use serde::Deserialize;
use serde_json::{Value, json};

use super::http::{
    Transport, get, issue_query, parse_timestamp, percent_encode, post_json, send_json, unexpected,
};
use super::model::{
    Account, CiState, HostedRepo, HostedRepoInfo, Issue, NewPullRequest, PullRequest, UserInfo,
};
use super::provider::{Provider, RepoRef, is_plain_segment};
use crate::error::GitError;
use crate::token::Token;

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
struct WirePage<T> {
    values: Vec<T>,
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

#[derive(Deserialize)]
struct WireRepoInfo {
    /// `null` for an empty repository.
    mainbranch: Option<WireBranch>,
    has_issues: Option<bool>,
}

#[derive(Deserialize)]
struct WireIssue {
    id: u64,
    title: String,
    /// `bug`, `enhancement`, ...: Bitbucket's only issue label.
    kind: Option<Value>,
    /// `null` for an anonymous or deleted reporter.
    reporter: Option<WireAuthor>,
    updated_on: String,
    links: WirePullLinks,
}

#[derive(Deserialize)]
struct WireMyRepo {
    full_name: String,
    name: String,
    workspace: WireWorkspace,
    description: Option<String>,
    is_private: bool,
    updated_on: String,
    links: WireRepoLinks,
}

#[derive(Deserialize)]
struct WireWorkspace {
    slug: String,
}

#[derive(Deserialize)]
struct WireRepoLinks {
    #[serde(rename = "clone")]
    clones: Vec<WireCloneLink>,
    html: WireHtml,
}

#[derive(Deserialize)]
struct WireCloneLink {
    /// `https` or `ssh`.
    name: String,
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
    let list: WirePage<WirePullRequest> = send_json(t, &get(url, token, &[]), token, &repo.host)?;
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

pub fn repo_info(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
) -> Result<HostedRepoInfo, GitError> {
    let info: WireRepoInfo =
        send_json(t, &get(repository_url(repo), token, &[]), token, &repo.host)?;
    Ok(HostedRepoInfo {
        default_branch: info.mainbranch.map(|b| b.name),
        issues_enabled: info.has_issues.unwrap_or(true),
    })
}

/// Open means `new` or `open`. The query goes inside a `title ~ "..."` literal, so `"` and `\`
/// are removed from it first.
pub fn list_issues(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    query: &str,
    page: u32,
) -> Result<Vec<Issue>, GitError> {
    let mut filter = r#"(state="new" OR state="open")"#.to_owned();
    let literal: String = issue_query(query)
        .chars()
        .filter(|c| !matches!(c, '"' | '\\'))
        .collect();
    if !literal.trim().is_empty() {
        filter = format!(r#"{filter} AND title ~ "{literal}""#);
    }
    let url = format!(
        "{}/issues?pagelen=50&page={page}&sort=-updated_on&q={}",
        repository_url(repo),
        percent_encode(&filter)
    );
    let list: WirePage<WireIssue> = send_json(t, &get(url, token, &[]), token, &repo.host)?;
    list.values
        .into_iter()
        .map(|i| {
            Ok(Issue {
                number: i.id,
                title: i.title,
                author: i
                    .reporter
                    .and_then(|r| r.nickname.or(r.display_name))
                    .unwrap_or_default(),
                labels: i
                    .kind
                    .as_ref()
                    .and_then(Value::as_str)
                    .map(|k| vec![k.to_owned()])
                    .unwrap_or_default(),
                updated_at: parse_timestamp(&i.updated_on).ok_or_else(|| unexpected(&repo.host))?,
                web_url: i.links.html.href,
            })
        })
        .collect()
}

/// Every repository the account is a member of. The query goes inside a `name ~ "..."`
/// literal, so `"` and `\` are removed from it first.
pub fn list_my_repos(
    t: &dyn Transport,
    account: &Account,
    token: &Token,
    query: &str,
    page: u32,
) -> Result<Vec<HostedRepo>, GitError> {
    let mut url = format!(
        "{}/repositories?role=member&sort=-updated_on&pagelen=50&page={page}",
        Provider::Bitbucket.api_base(&account.host)
    );
    let literal: String = issue_query(query)
        .chars()
        .filter(|c| !matches!(c, '"' | '\\'))
        .collect();
    if !literal.trim().is_empty() {
        url = format!(
            "{url}&q={}",
            percent_encode(&format!(r#"name ~ "{literal}""#))
        );
    }
    let list: WirePage<WireMyRepo> = send_json(t, &get(url, token, &[]), token, &account.host)?;
    list.values
        .into_iter()
        .filter_map(|r| convert_repo(r, &account.host).transpose())
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
        "description": new.body,
        "source": { "branch": { "name": new.source_branch } },
        "destination": { "branch": { "name": new.target_branch } },
    });
    let req = post_json(pull_requests_url(repo), token, &body);
    let pr: WirePullRequest = send_json(t, &req, token, &repo.host)?;
    convert(pr, &repo.host)
}

/// `{base}/repositories/{workspace}/{slug}`.
fn repository_url(repo: &RepoRef) -> String {
    format!(
        "{}/repositories/{}/{}",
        repo.provider.api_base(&repo.host),
        percent_encode(&repo.namespace),
        percent_encode(&repo.name)
    )
}

fn pull_requests_url(repo: &RepoRef) -> String {
    format!("{}/pullrequests", repository_url(repo))
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

/// `workspace/slug`, each `[A-Za-z0-9._-]+` but not `.` or `..`.
fn is_plain_full_name(name: &str) -> bool {
    name.split_once('/')
        .is_some_and(|(a, b)| is_plain_segment(a) && is_plain_segment(b))
}

/// `unexpected` without an `https` clone link; `Ok(None)` when that link is unusable, so the
/// row is left out.
fn convert_repo(r: WireMyRepo, host: &str) -> Result<Option<HostedRepo>, GitError> {
    let href = |name: &str| {
        r.links
            .clones
            .iter()
            .find(|l| l.name == name)
            .map(|l| l.href.clone())
    };
    let https_url = href("https").ok_or_else(|| unexpected(host))?;
    let ssh_url = href("ssh");
    Ok(HostedRepo {
        full_name: r.full_name,
        name: r.name,
        owner: r.workspace.slug,
        description: r.description,
        private: r.is_private,
        updated_at: parse_timestamp(&r.updated_on).ok_or_else(|| unexpected(host))?,
        https_url,
        ssh_url,
        web_url: r.links.html.href,
    }
    .sanitized())
}
