//! Hosting providers (GitHub, GitLab, Bitbucket): detecting the provider behind a remote URL,
//! building REST requests, mapping their statuses to [`GitError`] and their JSON to DTOs.
//!
//! This domain is pure: it reaches the network only through a [`Transport`], whose real
//! implementation is [`ureq_transport::UreqTransport`]. The git side of checking out a pull
//! request lives in [`crate::remote::pr_checkout`].

pub mod bitbucket;
pub mod github;
pub mod gitlab;
pub mod http;
pub mod model;
pub mod provider;
pub mod ureq_transport;

pub use crate::model::CheckoutPrOutcome;
pub use crate::token::Token;
pub use http::{Method, Request, Response, Transport};
pub use model::{
    Account, CiState, HostedRepo, HostedRepoInfo, HostedRepoPage, Issue, NewPullRequest,
    PullRequest, RepoContext, UserInfo,
};
pub use provider::{Provider, RepoRef};

use crate::error::GitError;
use crate::refs::validate_branch_name;

/// The account behind `token` on `host`.
pub fn current_user(
    t: &dyn Transport,
    provider: Provider,
    host: &str,
    token: &Token,
) -> Result<UserInfo, GitError> {
    match provider {
        Provider::GitHub => github::current_user(t, host, token),
        Provider::GitLab => gitlab::current_user(t, host, token),
        Provider::Bitbucket => bitbucket::current_user(t, host, token),
    }
}

/// One page (1-based, 50 per page) of `repo`'s open pull requests, newest update first.
pub fn list_pull_requests(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    page: u32,
) -> Result<Vec<PullRequest>, GitError> {
    match repo.provider {
        Provider::GitHub => github::list_pull_requests(t, repo, token, page),
        Provider::GitLab => gitlab::list_pull_requests(t, repo, token, page),
        Provider::Bitbucket => bitbucket::list_pull_requests(t, repo, token, page),
    }
}

/// The pull request `number` of `repo`.
pub fn get_pull_request(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    number: u64,
) -> Result<PullRequest, GitError> {
    match repo.provider {
        Provider::GitHub => github::get_pull_request(t, repo, token, number),
        Provider::GitLab => gitlab::get_pull_request(t, repo, token, number),
        Provider::Bitbucket => bitbucket::get_pull_request(t, repo, token, number),
    }
}

/// The default branch of `repo` and whether its issues are turned on.
pub fn repo_info(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
) -> Result<HostedRepoInfo, GitError> {
    match repo.provider {
        Provider::GitHub => github::repo_info(t, repo, token),
        Provider::GitLab => gitlab::repo_info(t, repo, token),
        Provider::Bitbucket => bitbucket::repo_info(t, repo, token),
    }
}

/// One page (1-based, 50 per page) of `repo`'s open issues matching `query` (all of them when
/// blank), newest update first.
pub fn list_issues(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    query: &str,
    page: u32,
) -> Result<Vec<Issue>, GitError> {
    match repo.provider {
        Provider::GitHub => github::list_issues(t, repo, token, query, page),
        Provider::GitLab => gitlab::list_issues(t, repo, token, query, page),
        Provider::Bitbucket => bitbucket::list_issues(t, repo, token, query, page),
    }
}

/// One page (1-based, 50 per page) of the repositories `account` can clone, matching `query`
/// by name (all of them when blank), newest update first. Rows with an unusable clone URL are
/// left out; `has_more` still reflects the raw page.
pub fn list_my_repos(
    t: &dyn Transport,
    account: &Account,
    token: &Token,
    query: &str,
    page: u32,
) -> Result<HostedRepoPage, GitError> {
    match account.provider {
        Provider::GitHub => github::list_my_repos(t, account, token, query, page),
        Provider::GitLab => gitlab::list_my_repos(t, account, token, query, page),
        Provider::Bitbucket => bitbucket::list_my_repos(t, account, token, query, page),
    }
}

/// `InvalidBranchName` when git would refuse the source or the target branch name.
pub fn validate_new_pull_request(new: &NewPullRequest) -> Result<(), GitError> {
    validate_branch_name(&new.source_branch)?;
    validate_branch_name(&new.target_branch)
}

/// Opens `new` on `repo`. `InvalidBranchName` for a source or target git would refuse, before
/// any request.
pub fn create_pull_request(
    t: &dyn Transport,
    repo: &RepoRef,
    token: &Token,
    new: &NewPullRequest,
) -> Result<PullRequest, GitError> {
    validate_new_pull_request(new)?;
    match repo.provider {
        Provider::GitHub => github::create_pull_request(t, repo, token, new),
        Provider::GitLab => gitlab::create_pull_request(t, repo, token, new),
        Provider::Bitbucket => bitbucket::create_pull_request(t, repo, token, new),
    }
}

/// What checking out a pull request fetches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckoutPlan {
    /// The head is a branch of `origin`: fetch `origin` and check out that branch.
    TrackBranch { branch: String },
    /// Fetch `refspec` from `source` (`origin` or a fork's `https://` URL) into
    /// `FETCH_HEAD`, then check out `pr/<n>`.
    FetchHead { source: String, refspec: String },
}

/// Decides what to fetch for `pr`. `InvalidBranchName` for a head branch git would refuse (or
/// read as a flag); `HostingNotFound` for a Bitbucket fork whose repository is gone.
pub fn checkout_plan(provider: Provider, pr: &PullRequest) -> Result<CheckoutPlan, GitError> {
    validate_branch_name(&pr.source_branch)?;
    if !pr.from_fork {
        return Ok(CheckoutPlan::TrackBranch {
            branch: pr.source_branch.clone(),
        });
    }
    let n = pr.number;
    let (source, refspec) = match provider {
        Provider::GitHub => ("origin".to_owned(), format!("refs/pull/{n}/head")),
        Provider::GitLab => ("origin".to_owned(), format!("refs/merge-requests/{n}/head")),
        Provider::Bitbucket => {
            let url = pr.fork_clone_url.clone().ok_or(GitError::HostingNotFound)?;
            (url, format!("refs/heads/{}", pr.source_branch))
        }
    };
    Ok(CheckoutPlan::FetchHead { source, refspec })
}
