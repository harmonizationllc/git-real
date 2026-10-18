//! Branch commands: list, create, rename, delete, checkout, remote delete.

use std::sync::Arc;

use git_real_core::{BranchList, LocalBranch};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
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
) -> Result<LocalBranch, AppError> {
    with_session(reg, id, |s| {
        if checkout {
            s.create_and_checkout_branch(name, start_point)
        } else {
            s.create_branch(name, start_point)
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

pub fn delete_branch_inner(
    reg: &RepoRegistry,
    id: RepoId,
    name: &str,
    force: bool,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.delete_branch(name, force))
}

pub fn checkout_branch_inner(reg: &RepoRegistry, id: RepoId, name: &str) -> Result<(), AppError> {
    with_session(reg, id, |s| s.checkout_branch(name))
}

pub fn checkout_remote_branch_inner(
    reg: &RepoRegistry,
    id: RepoId,
    remote: &str,
    name: &str,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.checkout_remote_branch(remote, name))
}

/// Validates under the session lock, then pushes with the lock released so a
/// slow network call never blocks other operations on the repository.
pub fn delete_remote_branch_inner(
    reg: &RepoRegistry,
    id: RepoId,
    remote: &str,
    name: &str,
) -> Result<(), AppError> {
    let push = with_session(reg, id, |s| s.prepare_remote_delete(remote, name))?;
    push.run().map_err(AppError::from)
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
) -> Result<LocalBranch, AppError> {
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
pub async fn delete_branch(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    name: String,
    force: bool,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || delete_branch_inner(&reg, id, &name, force)).await
}

/// Runs `git switch` (hooks included) while holding the session lock.
#[tauri::command]
pub async fn checkout_branch(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    name: String,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || checkout_branch_inner(&reg, id, &name)).await
}

#[tauri::command]
pub async fn checkout_remote_branch(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    remote: String,
    name: String,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || checkout_remote_branch_inner(&reg, id, &remote, &name)).await
}

#[tauri::command]
pub async fn delete_remote_branch(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    remote: String,
    name: String,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || delete_remote_branch_inner(&reg, id, &remote, &name)).await
}
