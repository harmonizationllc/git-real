//! GitLab.com and self-managed GitLab REST v4. Merge requests are numbered by `iid`.

use serde::Deserialize;
use serde_json::json;

use super::http::{
    Transport, get, issue_query, parse_timestamp, percent_encode, post_json, send_json, unexpected,
};
use super::model::{CiState, HostedRepoInfo, Issue, NewPullRequest, PullRequest, UserInfo};
use super::provider::{Provider, RepoRef};
use crate::error::GitError;
use crate::token::Token;

#[derive(Deserialize)]
struct WireUser {
    username: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct WireMergeRequest {
    iid: u64,
    title: String,
    author: WireAuthor,
    source_branch: String,
    target_branch: String,
    source_project_id: u64,
    target_project_id: u64,
    draft: Option<bool>,
    updated_at: String,
    web_url: String,
}

#[derive(Deserialize)]
struct WireAuthor {
    username: String,
}

#[derive(Deserialize)]
struct WireProject {
    /// `null` for an empty project.
    default_branch: Option<String>,
    issues_access_level: Option<String>,
    /// Deprecated by `issues_access_level`, still sent by older servers.
    issues_enabled: Option<bool>,
}

#[derive(Deserialize)]
struct WireIssue {
    iid: u64,
    title: String,
    author: WireAuthor,
    labels: Vec<String>,
    updated_at: String,
    web_url: String,
}

pub fn current_user(t: &dyn Transport, host: &str, token: &Token) -> Result<UserInfo, GitError> {
    let url = format!("{}/user", Provider::GitLab.api_base(host));
    let user: WireUser = send_json(t, &get(url, token, &[]), token, host)?;
    Ok(UserInfo {
        username: user.username,
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
        "{}?state=opened&order_by=updated_at&sort=desc&per_page=50&page={page}",
        merge_requests_url(repo)
    );
    let mrs: Vec<WireMergeRequest> = send_json(t, &get(url, token, &[]), token, &repo.host)?;
    mrs.into_iter().map(|m| convert(m, &repo.host)).collect()
}

pub fn get_pull_request(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    number: u64,
) -> Result<PullRequest, GitError> {
    let url = format!("{}/{number}", merge_requests_url(repo));
    let mr: WireMergeRequest = send_json(t, &get(url, token, &[]), token, &repo.host)?;
    convert(mr, &repo.host)
}

pub fn repo_info(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
) -> Result<HostedRepoInfo, GitError> {
    let p: WireProject = send_json(t, &get(project_url(repo), token, &[]), token, &repo.host)?;
    Ok(HostedRepoInfo {
        default_branch: p.default_branch,
        issues_enabled: p.issues_access_level.as_deref() != Some("disabled")
            && p.issues_enabled != Some(false),
    })
}

pub fn list_issues(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    query: &str,
    page: u32,
) -> Result<Vec<Issue>, GitError> {
    let mut url = format!(
        "{}/issues?state=opened&order_by=updated_at&sort=desc&per_page=50&page={page}",
        project_url(repo)
    );
    let query = issue_query(query);
    if !query.is_empty() {
        url = format!("{url}&search={}", percent_encode(query));
    }
    let issues: Vec<WireIssue> = send_json(t, &get(url, token, &[]), token, &repo.host)?;
    issues
        .into_iter()
        .map(|i| {
            Ok(Issue {
                number: i.iid,
                title: i.title,
                author: i.author.username,
                labels: i.labels,
                updated_at: parse_timestamp(&i.updated_at).ok_or_else(|| unexpected(&repo.host))?,
                web_url: i.web_url,
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
        "source_branch": new.source_branch,
        "target_branch": new.target_branch,
        "title": new.title,
        "description": new.body,
    });
    let req = post_json(merge_requests_url(repo), token, &body);
    let mr: WireMergeRequest = send_json(t, &req, token, &repo.host)?;
    convert(mr, &repo.host)
}

/// The project is addressed by its full path, `/` encoded as `%2F`.
fn project_url(repo: &RepoRef) -> String {
    let project = format!("{}/{}", repo.namespace, repo.name);
    format!(
        "{}/projects/{}",
        repo.provider.api_base(&repo.host),
        percent_encode(&project)
    )
}

fn merge_requests_url(repo: &RepoRef) -> String {
    format!("{}/merge_requests", project_url(repo))
}

fn convert(m: WireMergeRequest, host: &str) -> Result<PullRequest, GitError> {
    Ok(PullRequest {
        number: m.iid,
        title: m.title,
        author: m.author.username,
        source_branch: m.source_branch,
        target_branch: m.target_branch,
        from_fork: m.source_project_id != m.target_project_id,
        fork_clone_url: None,
        draft: m.draft.unwrap_or(false),
        ci_state: CiState::None,
        updated_at: parse_timestamp(&m.updated_at).ok_or_else(|| unexpected(host))?,
        web_url: m.web_url,
    })
}
