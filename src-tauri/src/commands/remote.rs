//! Remote commands: fetch, pull, push and remote management (GR-12).
//!
//! Network work follows the GR-7 shape: validate under the session lock, run
//! git with the lock released (a slow network never blocks the repository),
//! and, for pull, integrate under the lock again. `credentials` live only for
//! the call; they are never logged, stored, or put into an error. Without typed
//! credentials, a connected account's token is used for its own `https://` host.

use std::sync::Arc;

use git_real_core::{Credentials, OperationOutcome, PullMode, PushTarget, RemoteInfo};
use serde::Deserialize;
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::hosting_store::HostingStore;
use crate::state::{RepoId, RepoRegistry};

/// Credentials as the front end sends them, before validation. Deserializing
/// never fails on content, so a bad value surfaces as `invalidCredentials`
/// rather than as a Tauri argument error. Deliberately has no `Debug`: it
/// holds the raw token.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsArg {
    pub username: String,
    pub token: String,
    pub origin: String,
}

/// Validates `arg` into [`Credentials`]; a rejected value is
/// `invalidCredentials`, whose message never contains the token.
pub fn credentials_from_arg(arg: Option<CredentialsArg>) -> Result<Option<Credentials>, AppError> {
    arg.map(|a| Credentials::new(&a.origin, &a.username, &a.token))
        .transpose()
        .map_err(AppError::from)
}

/// How a network operation authenticates. Never glob-import its variants: `None` would shadow
/// `Option::None`.
#[derive(Clone, Copy)]
pub enum NetworkAuth<'a> {
    None,
    Explicit(&'a Credentials),
    Accounts(&'a HostingStore),
}

impl<'a> NetworkAuth<'a> {
    /// Explicit when the user typed credentials, else the account store.
    pub fn new(explicit: Option<&'a Credentials>, store: &'a HostingStore) -> Self {
        explicit.map_or(Self::Accounts(store), Self::Explicit)
    }

    /// The credentials to run with once the operation's `urls` are known.
    pub fn resolve(&self, urls: &[String]) -> Option<Credentials> {
        match self {
            Self::None => None,
            Self::Explicit(c) => Some((*c).clone()),
            Self::Accounts(store) => store.credentials_for(urls),
        }
    }
}

pub fn fetch_inner(reg: &RepoRegistry, id: RepoId, auth: NetworkAuth<'_>) -> Result<(), AppError> {
    let fetch = with_session(reg, id, |s| s.prepare_fetch())?;
    fetch
        .run(auth.resolve(fetch.urls()).as_ref())
        .map_err(AppError::from)
}

pub fn fetch_remote_inner(
    reg: &RepoRegistry,
    id: RepoId,
    remote: &str,
    auth: NetworkAuth<'_>,
) -> Result<(), AppError> {
    let fetch = with_session(reg, id, |s| s.prepare_fetch_remote(remote))?;
    fetch
        .run(auth.resolve(fetch.urls()).as_ref())
        .map_err(AppError::from)
}

pub fn pull_default_mode_inner(reg: &RepoRegistry, id: RepoId) -> Result<PullMode, AppError> {
    with_session(reg, id, |s| s.pull_default_mode())
}

pub fn pull_inner(
    reg: &RepoRegistry,
    id: RepoId,
    mode: PullMode,
    auth: NetworkAuth<'_>,
) -> Result<OperationOutcome, AppError> {
    let pull = with_session(reg, id, |s| s.prepare_pull())?;
    pull.fetch(auth.resolve(pull.urls()).as_ref())
        .map_err(AppError::from)?;
    with_session(reg, id, |s| s.integrate_pull(&pull, mode))
}

pub fn push_inner(
    reg: &RepoRegistry,
    id: RepoId,
    target: &PushTarget,
    force: bool,
    expected_branch: &str,
    auth: NetworkAuth<'_>,
) -> Result<(), AppError> {
    let push = with_session(reg, id, |s| s.prepare_push(target, force, expected_branch))?;
    push.run(auth.resolve(push.urls()).as_ref())
        .map_err(AppError::from)
}

pub fn list_remotes_inner(reg: &RepoRegistry, id: RepoId) -> Result<Vec<RemoteInfo>, AppError> {
    with_session(reg, id, |s| s.list_remotes())
}

pub fn add_remote_inner(
    reg: &RepoRegistry,
    id: RepoId,
    name: &str,
    url: &str,
    push_url: Option<&str>,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.add_remote(name, url, push_url))
}

pub fn update_remote_inner(
    reg: &RepoRegistry,
    id: RepoId,
    name: &str,
    new_name: &str,
    url: &str,
    push_url: Option<&str>,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.update_remote(name, new_name, url, push_url))
}

pub fn remove_remote_inner(reg: &RepoRegistry, id: RepoId, name: &str) -> Result<(), AppError> {
    with_session(reg, id, |s| s.remove_remote(name))
}

#[tauri::command]
pub async fn fetch(
    reg: State<'_, Arc<RepoRegistry>>,
    hosting: State<'_, Arc<HostingStore>>,
    id: RepoId,
    credentials: Option<CredentialsArg>,
) -> Result<(), AppError> {
    let credentials = credentials_from_arg(credentials)?;
    let (reg, hosting) = (Arc::clone(reg.inner()), Arc::clone(hosting.inner()));
    run_blocking(move || fetch_inner(&reg, id, NetworkAuth::new(credentials.as_ref(), &hosting)))
        .await
}

#[tauri::command]
pub async fn fetch_remote(
    reg: State<'_, Arc<RepoRegistry>>,
    hosting: State<'_, Arc<HostingStore>>,
    id: RepoId,
    remote: String,
    credentials: Option<CredentialsArg>,
) -> Result<(), AppError> {
    let credentials = credentials_from_arg(credentials)?;
    let (reg, hosting) = (Arc::clone(reg.inner()), Arc::clone(hosting.inner()));
    run_blocking(move || {
        let auth = NetworkAuth::new(credentials.as_ref(), &hosting);
        fetch_remote_inner(&reg, id, &remote, auth)
    })
    .await
}

#[tauri::command]
pub async fn pull_default_mode(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<PullMode, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || pull_default_mode_inner(&reg, id)).await
}

#[tauri::command]
pub async fn pull(
    reg: State<'_, Arc<RepoRegistry>>,
    hosting: State<'_, Arc<HostingStore>>,
    id: RepoId,
    mode: PullMode,
    credentials: Option<CredentialsArg>,
) -> Result<OperationOutcome, AppError> {
    let credentials = credentials_from_arg(credentials)?;
    let (reg, hosting) = (Arc::clone(reg.inner()), Arc::clone(hosting.inner()));
    run_blocking(move || {
        pull_inner(
            &reg,
            id,
            mode,
            NetworkAuth::new(credentials.as_ref(), &hosting),
        )
    })
    .await
}

#[tauri::command]
pub async fn push(
    reg: State<'_, Arc<RepoRegistry>>,
    hosting: State<'_, Arc<HostingStore>>,
    id: RepoId,
    target: PushTarget,
    force: bool,
    expected_branch: String,
    credentials: Option<CredentialsArg>,
) -> Result<(), AppError> {
    let credentials = credentials_from_arg(credentials)?;
    let (reg, hosting) = (Arc::clone(reg.inner()), Arc::clone(hosting.inner()));
    run_blocking(move || {
        let auth = NetworkAuth::new(credentials.as_ref(), &hosting);
        push_inner(&reg, id, &target, force, &expected_branch, auth)
    })
    .await
}

#[tauri::command]
pub async fn list_remotes(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<Vec<RemoteInfo>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || list_remotes_inner(&reg, id)).await
}

#[tauri::command]
pub async fn add_remote(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    name: String,
    url: String,
    push_url: Option<String>,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || add_remote_inner(&reg, id, &name, &url, push_url.as_deref())).await
}

#[tauri::command]
pub async fn update_remote(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    name: String,
    new_name: String,
    url: String,
    push_url: Option<String>,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || update_remote_inner(&reg, id, &name, &new_name, &url, push_url.as_deref()))
        .await
}

#[tauri::command]
pub async fn remove_remote(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    name: String,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || remove_remote_inner(&reg, id, &name)).await
}
