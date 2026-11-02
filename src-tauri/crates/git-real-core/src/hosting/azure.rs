//! Azure DevOps Services REST 7.1. A host is `dev.azure.com/<org>`, so the API root is
//! `https://dev.azure.com/<org>`; a repository's `namespace` is its project. Personal access
//! tokens go as Basic auth, every request carries `api-version=7.1`, and lists come wrapped in
//! `{ "value": [...] }`.
//!
//! A PAT connects with no particular scope and fails later with 203 or 401 on the first call
//! that needs one, so each call turns `HostingAuth` into a message naming the scope it needs.
//! Web URLs are built here, never taken from the API's own `url` fields.

use serde::Deserialize;
use serde_json::json;

use super::http::{
    Request, Transport, get_as, issue_query, parse_timestamp, percent_encode, post_json_as,
    send_json, unexpected,
};
use super::model::{
    Account, CiState, HostedRepo, HostedRepoInfo, HostedRepoPage, Issue, NewPullRequest, PAGE_SIZE,
    PullRequest, UserInfo, clean_https_url,
};
use super::provider::{AuthScheme, Provider, RepoRef, account_origin_for};
use crate::error::GitError;
use crate::token::Token;

const API_VERSION: &str = "api-version=7.1";
const SCHEME: AuthScheme = AuthScheme::BasicPat;
/// The most ids a WIQL query returns.
const WIQL_MAX: usize = 20_000;
/// Open work items in the Basic, Agile, Scrum and CMMI process templates.
const WIQL_OPEN: &str = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] <> 'Closed' AND [System.State] <> 'Done' AND [System.State] <> 'Removed'";
const WORK_ITEM_FIELDS: &str =
    "System.Title,System.WorkItemType,System.Tags,System.CreatedBy,System.ChangedDate";

pub(crate) const SCOPE_CODE: &str =
    "The token can't read this repository. It needs the Code (Read & write) scope.";
pub(crate) const SCOPE_PR_CREATE: &str =
    "The token can't open pull requests. It needs the Code (Read & write) scope.";
pub(crate) const SCOPE_WORK: &str =
    "The token can't read work items. It needs the Work items (Read) scope.";
pub(crate) const SCOPE_PROJECT: &str =
    "The token can't list projects. It needs the Project and team (Read) scope.";

/// The connect check's auth message: the token does not reach `org`.
pub(crate) fn org_message(org: &str) -> String {
    format!(
        "The token can't reach the organization {org}. Check that it is current and was created there."
    )
}

#[derive(Deserialize)]
struct WireList<T> {
    value: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireConnectionData {
    authenticated_user: WireUser,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireUser {
    provider_display_name: Option<String>,
    #[serde(default)]
    properties: WireUserProperties,
}

#[derive(Deserialize, Default)]
struct WireUserProperties {
    /// The sign-in email.
    #[serde(rename = "Account")]
    account: Option<WireProperty>,
}

#[derive(Deserialize)]
struct WireProperty {
    #[serde(rename = "$value")]
    value: String,
}

/// An identity reference (`createdBy`, `System.CreatedBy`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireIdentity {
    display_name: Option<String>,
    unique_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePullRequest {
    pull_request_id: u64,
    title: String,
    created_by: Option<WireIdentity>,
    creation_date: String,
    source_ref_name: String,
    target_ref_name: String,
    is_draft: Option<bool>,
    /// Present when the source branch lives in a fork.
    fork_source: Option<WireForkSource>,
}

#[derive(Deserialize)]
struct WireForkSource {
    repository: Option<WireForkRepository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireForkRepository {
    remote_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRepoInfo {
    /// Absent for an empty repository.
    default_branch: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireWiql {
    work_items: Vec<WireWorkItemRef>,
}

#[derive(Deserialize)]
struct WireWorkItemRef {
    id: u64,
}

#[derive(Deserialize)]
struct WireWorkItem {
    id: u64,
    fields: WireWorkItemFields,
}

#[derive(Deserialize)]
struct WireWorkItemFields {
    #[serde(rename = "System.Title")]
    title: String,
    #[serde(rename = "System.WorkItemType")]
    kind: String,
    /// `a; b`; absent when there are none.
    #[serde(rename = "System.Tags")]
    tags: Option<String>,
    #[serde(rename = "System.CreatedBy")]
    created_by: Option<WireIdentity>,
    #[serde(rename = "System.ChangedDate")]
    changed_date: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireProject {
    id: String,
    name: String,
    /// `private` or `public`.
    visibility: String,
    /// `0001-01-01T00:00:00`, without a zone, on shallow references; absent on some.
    last_update_time: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRepository {
    name: String,
    project: WireProjectRef,
    /// Absent on a row the caller cannot clone; such a row is dropped.
    remote_url: Option<String>,
    ssh_url: Option<String>,
    web_url: Option<String>,
    #[serde(default)]
    is_disabled: bool,
}

#[derive(Deserialize)]
struct WireProjectRef {
    id: String,
}

/// `connectionData` needs no scope: it checks only that the PAT reaches the organization.
pub fn current_user(t: &dyn Transport, host: &str, token: &Token) -> Result<UserInfo, GitError> {
    let url = format!(
        "{}/_apis/connectionData?{API_VERSION}",
        Provider::AzureDevOps.api_base(host)
    );
    let org = host.rsplit_once('/').map_or(host, |(_, org)| org);
    let req = get_as(SCHEME, url, token, &[]);
    let data: WireConnectionData = fetch(t, &req, token, host, &org_message(org))?;
    let user = data.authenticated_user;
    let username = user
        .properties
        .account
        .map(|a| a.value)
        .or_else(|| user.provider_display_name.clone())
        .ok_or_else(|| unexpected(host))?;
    Ok(UserInfo {
        username,
        display_name: user.provider_display_name,
        avatar_url: None,
    })
}

/// Active pull requests, newest first (ADO orders by creation).
pub fn list_pull_requests(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    page: u32,
) -> Result<Vec<PullRequest>, GitError> {
    let skip = PAGE_SIZE * (page.max(1) as usize - 1);
    let url = format!(
        "{}?searchCriteria.status=active&$top={PAGE_SIZE}&$skip={skip}&{API_VERSION}",
        pull_requests_url(repo)
    );
    let list: WireList<WirePullRequest> = fetch(
        t,
        &get_as(SCHEME, url, token, &[]),
        token,
        &repo.host,
        SCOPE_CODE,
    )?;
    list.value.into_iter().map(|p| convert(p, repo)).collect()
}

pub fn get_pull_request(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    number: u64,
) -> Result<PullRequest, GitError> {
    let url = format!("{}/{number}?{API_VERSION}", pull_requests_url(repo));
    let pr: WirePullRequest = fetch(
        t,
        &get_as(SCHEME, url, token, &[]),
        token,
        &repo.host,
        SCOPE_CODE,
    )?;
    convert(pr, repo)
}

/// Issues (Boards) are taken as on: a project with Boards off fails the WIQL call instead.
pub fn repo_info(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
) -> Result<HostedRepoInfo, GitError> {
    let url = format!("{}?{API_VERSION}", repository_url(repo));
    let info: WireRepoInfo = fetch(
        t,
        &get_as(SCHEME, url, token, &[]),
        token,
        &repo.host,
        SCOPE_CODE,
    )?;
    Ok(HostedRepoInfo {
        default_branch: info
            .default_branch
            .map(|b| branch(&b, &repo.host))
            .transpose()?,
        issues_enabled: true,
    })
}

/// Open work items of every type, most recently changed first: a WIQL query for the ids up to
/// this page, then one batch read of this page's ids, put back in the WIQL order. The query goes
/// inside a `'...'` literal, so `'` is doubled and control characters are removed.
pub fn list_issues(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    query: &str,
    page: u32,
) -> Result<Vec<Issue>, GitError> {
    let page = page.max(1) as usize;
    let literal: String = issue_query(query)
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .replace('\'', "''");
    let mut wiql = WIQL_OPEN.to_owned();
    if !literal.trim().is_empty() {
        wiql = format!("{wiql} AND [System.Title] CONTAINS '{literal}'");
    }
    wiql.push_str(" ORDER BY [System.ChangedDate] DESC");
    let top = (PAGE_SIZE * page).min(WIQL_MAX);
    let url = format!(
        "{}/_apis/wit/wiql?$top={top}&{API_VERSION}",
        project_url(repo)
    );
    let req = post_json_as(SCHEME, url, token, &json!({ "query": wiql }));
    let found: WireWiql = fetch(t, &req, token, &repo.host, SCOPE_WORK)?;
    let ids: Vec<u64> = found
        .work_items
        .into_iter()
        .map(|w| w.id)
        .skip(PAGE_SIZE * (page - 1))
        .take(PAGE_SIZE)
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let csv: Vec<String> = ids.iter().map(u64::to_string).collect();
    let url = format!(
        "{}/_apis/wit/workitems?ids={}&fields={WORK_ITEM_FIELDS}&errorPolicy=omit&{API_VERSION}",
        project_url(repo),
        csv.join(",")
    );
    // `errorPolicy=omit` answers a work item deleted since the query with `null`; it is dropped.
    let items: WireList<Option<WireWorkItem>> = fetch(
        t,
        &get_as(SCHEME, url, token, &[]),
        token,
        &repo.host,
        SCOPE_WORK,
    )?;
    let mut items: Vec<WireWorkItem> = items.value.into_iter().flatten().collect();
    items.sort_by_key(|w| ids.iter().position(|id| *id == w.id));
    items
        .into_iter()
        .map(|w| convert_work_item(w, repo))
        .collect()
}

/// Every enabled repository the PAT can see in the organization, joined to its project; the
/// query matches the repository name case-insensitively. One un-paged response, paged here.
pub fn list_my_repos(
    t: &dyn Transport,
    account: &Account,
    token: &Token,
    query: &str,
    page: u32,
) -> Result<HostedRepoPage, GitError> {
    let page = page.max(1) as usize;
    let host = &account.host;
    let base = Provider::AzureDevOps.api_base(host);
    let url = format!("{base}/_apis/projects?$top=1000&{API_VERSION}");
    let projects: WireList<WireProject> = fetch(
        t,
        &get_as(SCHEME, url, token, &[]),
        token,
        host,
        SCOPE_PROJECT,
    )?;
    let url = format!("{base}/_apis/git/repositories?includeAllUrls=true&{API_VERSION}");
    let repos: WireList<WireRepository> =
        fetch(t, &get_as(SCHEME, url, token, &[]), token, host, SCOPE_CODE)?;
    let needle = issue_query(query).to_lowercase();
    let mut rows = Vec::new();
    for r in repos.value {
        if r.is_disabled || !r.name.to_lowercase().contains(&needle) {
            continue;
        }
        let Some(project) = projects.value.iter().find(|p| p.id == r.project.id) else {
            continue;
        };
        let Some(https_url) = r.remote_url else {
            continue;
        };
        // One project without a usable time must not hide the organization: it sorts last.
        let updated_at = project
            .last_update_time
            .as_deref()
            .and_then(parse_timestamp)
            .unwrap_or(0);
        let web_url = r.web_url.unwrap_or_else(|| {
            RepoRef {
                provider: Provider::AzureDevOps,
                host: host.clone(),
                namespace: project.name.clone(),
                name: r.name.clone(),
            }
            .web_url()
        });
        let row = HostedRepo {
            full_name: format!("{}/{}", project.name, r.name),
            name: r.name,
            owner: project.name.clone(),
            description: None,
            private: project.visibility != "public",
            updated_at,
            https_url,
            ssh_url: r.ssh_url,
            web_url,
        };
        rows.extend(row.sanitized());
    }
    rows.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    let has_more = rows.len() > PAGE_SIZE * page;
    let repos = rows
        .into_iter()
        .skip(PAGE_SIZE * (page - 1))
        .take(PAGE_SIZE)
        .collect();
    Ok(HostedRepoPage { repos, has_more })
}

pub fn create_pull_request(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    new: &NewPullRequest,
) -> Result<PullRequest, GitError> {
    let body = json!({
        "sourceRefName": format!("refs/heads/{}", new.source_branch),
        "targetRefName": format!("refs/heads/{}", new.target_branch),
        "title": new.title,
        "description": new.body,
    });
    let url = format!("{}?{API_VERSION}", pull_requests_url(repo));
    let req = post_json_as(SCHEME, url, token, &body);
    let pr: WirePullRequest = fetch(t, &req, token, &repo.host, SCOPE_PR_CREATE)?;
    convert(pr, repo)
}

/// `https://{host}/{project}/_git/{repo}/pullrequest/{id}`.
pub fn pull_request_web_url(repo: &RepoRef, id: u64) -> String {
    format!("{}/pullrequest/{id}", repo.web_url())
}

/// `https://{host}/{project}/_workitems/edit/{id}`.
pub fn work_item_web_url(repo: &RepoRef, id: u64) -> String {
    format!(
        "https://{}/{}/_workitems/edit/{id}",
        repo.host,
        percent_encode(&repo.namespace)
    )
}

/// `send_json`, with an auth failure reworded as `scope`, the sentence naming what the call needs.
fn fetch<T: serde::de::DeserializeOwned>(
    t: &dyn Transport,
    req: &Request,
    token: &Token,
    host: &str,
    scope: &str,
) -> Result<T, GitError> {
    send_json(t, req, token, host).map_err(|e| scope_error(e, scope))
}

/// `HostingAuth` with `message`; any other error unchanged.
fn scope_error(e: GitError, message: &str) -> GitError {
    match e {
        GitError::HostingAuth { .. } => GitError::HostingAuth {
            message: message.to_owned(),
        },
        other => other,
    }
}

/// `{base}/{project}`.
fn project_url(repo: &RepoRef) -> String {
    format!(
        "{}/{}",
        Provider::AzureDevOps.api_base(&repo.host),
        percent_encode(&repo.namespace)
    )
}

/// `{base}/{project}/_apis/git/repositories/{repo}`.
fn repository_url(repo: &RepoRef) -> String {
    format!(
        "{}/_apis/git/repositories/{}",
        project_url(repo),
        percent_encode(&repo.name)
    )
}

fn pull_requests_url(repo: &RepoRef) -> String {
    format!("{}/pullrequests", repository_url(repo))
}

/// The branch of a `refs/heads/<branch>` name; any other ref is an unexpected response.
fn branch(ref_name: &str, host: &str) -> Result<String, GitError> {
    ref_name
        .strip_prefix("refs/heads/")
        .map(str::to_owned)
        .ok_or_else(|| unexpected(host))
}

fn convert(p: WirePullRequest, repo: &RepoRef) -> Result<PullRequest, GitError> {
    let host = &repo.host;
    let from_fork = p.fork_source.is_some();
    // The URL goes to git fetch with the account's token, so it must stay in this organization.
    let fork_clone_url = p
        .fork_source
        .and_then(|f| f.repository)
        .and_then(|r| r.remote_url)
        .and_then(|u| clean_https_url(&u))
        .filter(|u| account_origin_for(host, u).is_some());
    Ok(PullRequest {
        number: p.pull_request_id,
        title: p.title,
        author: p
            .created_by
            .and_then(|c| c.display_name.or(c.unique_name))
            .unwrap_or_default(),
        source_branch: branch(&p.source_ref_name, host)?,
        target_branch: branch(&p.target_ref_name, host)?,
        from_fork,
        fork_clone_url,
        draft: p.is_draft.unwrap_or(false),
        ci_state: CiState::None,
        updated_at: parse_timestamp(&p.creation_date).ok_or_else(|| unexpected(host))?,
        web_url: pull_request_web_url(repo, p.pull_request_id),
    })
}

fn convert_work_item(w: WireWorkItem, repo: &RepoRef) -> Result<Issue, GitError> {
    let f = w.fields;
    let tags = f.tags.as_deref().unwrap_or_default();
    let labels = std::iter::once(f.kind)
        .chain(
            tags.split(';')
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_owned),
        )
        .collect();
    Ok(Issue {
        number: w.id,
        title: f.title,
        author: f
            .created_by
            .and_then(|c| c.display_name)
            .unwrap_or_default(),
        labels,
        updated_at: parse_timestamp(&f.changed_date).ok_or_else(|| unexpected(&repo.host))?,
        web_url: work_item_web_url(repo, w.id),
    })
}
