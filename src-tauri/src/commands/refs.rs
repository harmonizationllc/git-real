//! Branch commands: list, create, rename, delete, set upstream, checkout, remote delete.

use std::sync::Arc;

use git_real_core::{BranchList, CheckoutOutcome, CreatedBranch, GitError};
use serde::Serialize;
use tauri::State;

use super::remote::{CredentialsArg, NetworkAuth, credentials_from_arg};
use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::hosting_store::HostingStore;
use crate::state::{RepoId, RepoRegistry};

pub fn list_branches_inner(reg: &RepoRegistry, id: RepoId) -> Result<BranchList, AppError> {
    with_session(reg, id, |s| s.list_branches())
}

/// With `checkout`, creating and switching is one all-or-nothing core
/// operation: a refused switch leaves no new branch behind.
pub fn create_branch_inner(
    reg: &RepoRegistry,
    id: RepoId,
    name: &str,
    start_point: Option<&str>,
    checkout: bool,
) -> Result<CreatedBranch, AppError> {
    with_session(reg, id, |s| {
        if checkout {
            s.create_and_checkout_branch(name, start_point)
        } else {
            s.create_branch(name, start_point)
                .map(|branch| CreatedBranch {
                    branch,
                    auto_stash: None,
                })
        }
    })
}

pub fn rename_branch_inner(
    reg: &RepoRegistry,
    id: RepoId,
    old_name: &str,
    new_name: &str,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.rename_branch(old_name, new_name))
}

/// The result of deleting one branch in a batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BranchDeleteStatus {
    Deleted,
    /// Refused because the branch is unmerged; a forced delete would succeed.
    NotMerged,
    Failed {
        error: AppError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteOutcome {
    pub name: String,
    pub status: BranchDeleteStatus,
}

/// Deletes every name, never stopping at a failure: one outcome per name, in
/// input order.
pub fn delete_branches_inner(
    reg: &RepoRegistry,
    id: RepoId,
    names: &[String],
    force: bool,
) -> Result<Vec<BranchDeleteOutcome>, AppError> {
    with_session(reg, id, |s| {
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        Ok(s.delete_branches(&names, force)
            .into_iter()
            .map(|(name, result)| BranchDeleteOutcome {
                name,
                status: match result {
                    Ok(()) => BranchDeleteStatus::Deleted,
                    Err(GitError::BranchNotMerged(_)) => BranchDeleteStatus::NotMerged,
                    Err(e) => BranchDeleteStatus::Failed {
                        error: AppError::from(e),
                    },
                },
            })
            .collect())
    })
}

pub fn set_branch_upstream_inner(
    reg: &RepoRegistry,
    id: RepoId,
    branch: &str,
    upstream: Option<&str>,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.set_branch_upstream(branch, upstream))
}

pub fn checkout_branch_inner(
    reg: &RepoRegistry,
    id: RepoId,
    name: &str,
) -> Result<CheckoutOutcome, AppError> {
    with_session(reg, id, |s| s.checkout_branch(name))
}

pub fn checkout_remote_branch_inner(
    reg: &RepoRegistry,
    id: RepoId,
    remote: &str,
    name: &str,
) -> Result<CheckoutOutcome, AppError> {
    with_session(reg, id, |s| s.checkout_remote_branch(remote, name))
}

/// Validates under the session lock, then pushes with the lock released so a
/// slow network call never blocks other operations on the repository.
pub fn delete_remote_branches_inner(
    reg: &RepoRegistry,
    id: RepoId,
    remote: &str,
    names: &[String],
    auth: NetworkAuth<'_>,
) -> Result<(), AppError> {
    let push = with_session(reg, id, |s| {
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        s.prepare_remote_delete(remote, &names)
    })?;
    push.run(auth.resolve(push.urls()).as_ref())
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn list_branches(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<BranchList, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || list_branches_inner(&reg, id)).await
}

#[tauri::command]
pub async fn create_branch(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> Result<CreatedBranch, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || create_branch_inner(&reg, id, &name, start_point.as_deref(), checkout))
        .await
}

#[tauri::command]
pub async fn rename_branch(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    old_name: String,
    new_name: String,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || rename_branch_inner(&reg, id, &old_name, &new_name)).await
}

#[tauri::command]
pub async fn delete_branches(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    names: Vec<String>,
    force: bool,
) -> Result<Vec<BranchDeleteOutcome>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || delete_branches_inner(&reg, id, &names, force)).await
}

#[tauri::command]
pub async fn set_branch_upstream(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    branch: String,
    upstream: Option<String>,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || set_branch_upstream_inner(&reg, id, &branch, upstream.as_deref())).await
}

/// Runs `git switch` (hooks included) while holding the session lock.
#[tauri::command]
pub async fn checkout_branch(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    name: String,
) -> Result<CheckoutOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || checkout_branch_inner(&reg, id, &name)).await
}

#[tauri::command]
pub async fn checkout_remote_branch(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    remote: String,
    name: String,
) -> Result<CheckoutOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || checkout_remote_branch_inner(&reg, id, &remote, &name)).await
}

#[tauri::command]
pub async fn delete_remote_branches(
    reg: State<'_, Arc<RepoRegistry>>,
    hosting: State<'_, Arc<HostingStore>>,
    id: RepoId,
    remote: String,
    names: Vec<String>,
    credentials: Option<CredentialsArg>,
) -> Result<(), AppError> {
    let credentials = credentials_from_arg(credentials)?;
    let (reg, hosting) = (Arc::clone(reg.inner()), Arc::clone(hosting.inner()));
    run_blocking(move || {
        let auth = NetworkAuth::new(credentials.as_ref(), &hosting);
        delete_remote_branches_inner(&reg, id, &remote, &names, auth)
    })
    .await
}
