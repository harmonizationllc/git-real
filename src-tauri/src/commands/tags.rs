//! Tag commands: list, create, delete, push and remote delete.

use std::sync::Arc;

use git_real_core::{Credentials, TagList};
use tauri::State;

use super::remote::{CredentialsArg, credentials_from_arg};
use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

pub fn list_tags_inner(reg: &RepoRegistry, id: RepoId) -> Result<TagList, AppError> {
    with_session(reg, id, |s| s.list_tags())
}

/// Runs `git tag` (signing included) while holding the session lock.
pub fn create_tag_inner(
    reg: &RepoRegistry,
    id: RepoId,
    name: &str,
    oid: &str,
    message: Option<&str>,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.create_tag(name, oid, message))
}

pub fn delete_tag_inner(reg: &RepoRegistry, id: RepoId, name: &str) -> Result<(), AppError> {
    with_session(reg, id, |s| s.delete_tag(name))
}

/// Validates under the session lock, then pushes with the lock released so a
/// slow network call never blocks other operations on the repository.
pub fn push_tag_inner(
    reg: &RepoRegistry,
    id: RepoId,
    remote: &str,
    name: &str,
    credentials: Option<&Credentials>,
) -> Result<(), AppError> {
    let push = with_session(reg, id, |s| s.prepare_tag_push(remote, name))?;
    push.run(credentials).map_err(AppError::from)
}

/// As [`push_tag_inner`], for `git push --delete`.
pub fn delete_remote_tag_inner(
    reg: &RepoRegistry,
    id: RepoId,
    remote: &str,
    name: &str,
    credentials: Option<&Credentials>,
) -> Result<(), AppError> {
    let delete = with_session(reg, id, |s| s.prepare_remote_tag_delete(remote, name))?;
    delete.run(credentials).map_err(AppError::from)
}

#[tauri::command]
pub async fn list_tags(reg: State<'_, Arc<RepoRegistry>>, id: RepoId) -> Result<TagList, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || list_tags_inner(&reg, id)).await
}

#[tauri::command]
pub async fn create_tag(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    name: String,
    oid: String,
    message: Option<String>,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || create_tag_inner(&reg, id, &name, &oid, message.as_deref())).await
}

#[tauri::command]
pub async fn delete_tag(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    name: String,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || delete_tag_inner(&reg, id, &name)).await
}

#[tauri::command]
pub async fn push_tag(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    remote: String,
    name: String,
    credentials: Option<CredentialsArg>,
) -> Result<(), AppError> {
    let credentials = credentials_from_arg(credentials)?;
    let reg = Arc::clone(reg.inner());
    run_blocking(move || push_tag_inner(&reg, id, &remote, &name, credentials.as_ref())).await
}

#[tauri::command]
pub async fn delete_remote_tag(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    remote: String,
    name: String,
    credentials: Option<CredentialsArg>,
) -> Result<(), AppError> {
    let credentials = credentials_from_arg(credentials)?;
    let reg = Arc::clone(reg.inner());
    run_blocking(move || delete_remote_tag_inner(&reg, id, &remote, &name, credentials.as_ref()))
        .await
}
