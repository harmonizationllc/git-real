//! Hosting commands (GR-13a): connected accounts, the hosted repository behind `origin`, its
//! pull requests, and checking one out.
//!
//! Provider calls run through a [`Transport`]; git work follows the GR-7 shape (prepare under
//! the session lock, run git with it released). A token crosses IPC only inbound, on connect.

use std::sync::Arc;

use git_real_core::hosting::provider::{detect, validate_host};
use git_real_core::hosting::{
    self, Account, CheckoutPlan, CheckoutPrOutcome, Provider, PullRequest, RepoContext, RepoRef,
    Token, Transport,
};
use git_real_core::{Credentials, GitError};
use tauri::State;

use super::remote::{CredentialsArg, NetworkAuth, credentials_from_arg, fetch_remote_inner};
use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::hosting_store::HostingStore;
use crate::state::{RepoId, RepoRegistry};

pub fn hosting_list_accounts_inner(store: &HostingStore) -> Vec<Account> {
    store.accounts()
}

/// Checks `token` with the provider's current-user endpoint, then stores it.
pub fn hosting_connect_inner(
    store: &HostingStore,
    t: &dyn Transport,
    provider: Provider,
    host: Option<&str>,
    token: &str,
) -> Result<Account, AppError> {
    let token = Token::new(token)?;
    let host = validate_host(provider, host)?;
    let user = hosting::current_user(t, provider, &host, &token)?;
    Ok(store.connect(Account::new(provider, &host, user), &token)?)
}

pub fn hosting_disconnect_inner(store: &HostingStore, account_id: &str) -> Result<(), AppError> {
    Ok(store.disconnect(account_id)?)
}

/// The hosted repository behind `origin`'s raw URL and its account; `None` without an `origin`
/// or when no provider hosts it.
pub fn hosting_repo_context_inner(
    reg: &RepoRegistry,
    store: &HostingStore,
    id: RepoId,
) -> Result<Option<RepoContext>, AppError> {
    let remotes = with_session(reg, id, |s| s.list_remotes())?;
    let repo = remotes
        .into_iter()
        .find(|r| r.name == "origin")
        .and_then(|origin| detect(&origin.fetch_url, &store.hosts()));
    Ok(repo.map(|repo| {
        let account = store.find(repo.provider, &repo.host);
        RepoContext { repo, account }
    }))
}

pub fn hosting_list_pull_requests_inner(
    reg: &RepoRegistry,
    store: &HostingStore,
    t: &dyn Transport,
    id: RepoId,
    page: u32,
) -> Result<Vec<PullRequest>, AppError> {
    let (repo, account) = connected_repo(reg, store, id)?;
    with_token(store, &account, |token| {
        hosting::list_pull_requests(t, &repo, token, page.max(1))
    })
}

/// Re-reads pull request `number` from the provider, fetches its head and checks it out: the
/// head branch itself for a same-repository PR, else `pr/<number>`.
pub fn hosting_checkout_pull_request_inner(
    reg: &RepoRegistry,
    store: &HostingStore,
    t: &dyn Transport,
    id: RepoId,
    number: u64,
    reset: bool,
    credentials: Option<&Credentials>,
) -> Result<CheckoutPrOutcome, AppError> {
    let (repo, account) = connected_repo(reg, store, id)?;
    let pr = with_token(store, &account, |token| {
        hosting::get_pull_request(t, &repo, token, number)
    })?;
    let auth = NetworkAuth::new(credentials, store);
    match hosting::checkout_plan(repo.provider, &pr)? {
        CheckoutPlan::TrackBranch { branch } => {
            fetch_remote_inner(reg, id, "origin", auth)?;
            with_session(reg, id, |s| s.checkout_remote_branch("origin", &branch))?;
            Ok(CheckoutPrOutcome::CheckedOut { branch })
        }
        CheckoutPlan::FetchHead { source, refspec } => {
            let fetch = with_session(reg, id, |s| s.prepare_ref_fetch(&source, &refspec))?;
            fetch.run(auth.resolve(fetch.urls()).as_ref())?;
            with_session(reg, id, |s| s.checkout_fetch_head(&fetch, number, reset))
        }
    }
}

/// The hosted repository behind `origin` and its account; `NoHostingAccount` when either is
/// missing.
fn connected_repo(
    reg: &RepoRegistry,
    store: &HostingStore,
    id: RepoId,
) -> Result<(RepoRef, Account), AppError> {
    hosting_repo_context_inner(reg, store, id)?
        .and_then(|ctx| Some((ctx.repo, ctx.account?)))
        .ok_or_else(|| GitError::NoHostingAccount.into())
}

/// Runs a provider call with `account`'s token (`NoHostingAccount` when the keychain has none),
/// flagging the account for reconnect when the provider rejects the token.
fn with_token<T>(
    store: &HostingStore,
    account: &Account,
    f: impl FnOnce(&Token) -> Result<T, GitError>,
) -> Result<T, AppError> {
    let token = store.token(account)?.ok_or(GitError::NoHostingAccount)?;
    f(&token).map_err(|e| {
        if matches!(e, GitError::HostingAuth { .. }) {
            store.mark_needs_reconnect(&account.id);
        }
        AppError::from(e)
    })
}

#[tauri::command]
pub async fn hosting_list_accounts(
    hosting: State<'_, Arc<HostingStore>>,
) -> Result<Vec<Account>, AppError> {
    let hosting = Arc::clone(hosting.inner());
    run_blocking(move || Ok(hosting_list_accounts_inner(&hosting))).await
}

#[tauri::command]
pub async fn hosting_connect(
    hosting: State<'_, Arc<HostingStore>>,
    transport: State<'_, Arc<dyn Transport>>,
    provider: Provider,
    host: Option<String>,
    token: String,
) -> Result<Account, AppError> {
    let (hosting, transport) = (Arc::clone(hosting.inner()), Arc::clone(transport.inner()));
    run_blocking(move || {
        hosting_connect_inner(&hosting, &*transport, provider, host.as_deref(), &token)
    })
    .await
}

#[tauri::command]
pub async fn hosting_disconnect(
    hosting: State<'_, Arc<HostingStore>>,
    account_id: String,
) -> Result<(), AppError> {
    let hosting = Arc::clone(hosting.inner());
    run_blocking(move || hosting_disconnect_inner(&hosting, &account_id)).await
}

#[tauri::command]
pub async fn hosting_repo_context(
    reg: State<'_, Arc<RepoRegistry>>,
    hosting: State<'_, Arc<HostingStore>>,
    id: RepoId,
) -> Result<Option<RepoContext>, AppError> {
    let (reg, hosting) = (Arc::clone(reg.inner()), Arc::clone(hosting.inner()));
    run_blocking(move || hosting_repo_context_inner(&reg, &hosting, id)).await
}

#[tauri::command]
pub async fn hosting_list_pull_requests(
    reg: State<'_, Arc<RepoRegistry>>,
    hosting: State<'_, Arc<HostingStore>>,
    transport: State<'_, Arc<dyn Transport>>,
    id: RepoId,
    page: u32,
) -> Result<Vec<PullRequest>, AppError> {
    let (reg, hosting) = (Arc::clone(reg.inner()), Arc::clone(hosting.inner()));
    let transport = Arc::clone(transport.inner());
    run_blocking(move || hosting_list_pull_requests_inner(&reg, &hosting, &*transport, id, page))
        .await
}

#[tauri::command]
pub async fn hosting_checkout_pull_request(
    reg: State<'_, Arc<RepoRegistry>>,
    hosting: State<'_, Arc<HostingStore>>,
    transport: State<'_, Arc<dyn Transport>>,
    id: RepoId,
    number: u64,
    reset: bool,
    credentials: Option<CredentialsArg>,
) -> Result<CheckoutPrOutcome, AppError> {
    let credentials = credentials_from_arg(credentials)?;
    let (reg, hosting) = (Arc::clone(reg.inner()), Arc::clone(hosting.inner()));
    let transport = Arc::clone(transport.inner());
    run_blocking(move || {
        hosting_checkout_pull_request_inner(
            &reg,
            &hosting,
            &*transport,
            id,
            number,
            reset,
            credentials.as_ref(),
        )
    })
    .await
}
