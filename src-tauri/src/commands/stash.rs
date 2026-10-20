//! Stash commands: list, files, push, apply, pop and drop.

use std::sync::Arc;

use git_real_core::{StashEntry, StashFiles, StashOutcome};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

pub fn list_stashes_inner(reg: &RepoRegistry, id: RepoId) -> Result<Vec<StashEntry>, AppError> {
    with_session(reg, id, |s| s.list_stashes())
}

pub fn get_stash_files_inner(
    reg: &RepoRegistry,
    id: RepoId,
    oid: &str,
) -> Result<StashFiles, AppError> {
    with_session(reg, id, |s| s.stash_files(oid))
}

pub fn stash_push_inner(
    reg: &RepoRegistry,
    id: RepoId,
    message: Option<&str>,
    include_untracked: bool,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.stash_push(message, include_untracked))
}

pub fn stash_apply_inner(
    reg: &RepoRegistry,
    id: RepoId,
    index: u32,
    oid: &str,
) -> Result<StashOutcome, AppError> {
    with_session(reg, id, |s| s.stash_apply(index, oid))
}

pub fn stash_pop_inner(
    reg: &RepoRegistry,
    id: RepoId,
    index: u32,
    oid: &str,
) -> Result<StashOutcome, AppError> {
    with_session(reg, id, |s| s.stash_pop(index, oid))
}

pub fn stash_drop_inner(
    reg: &RepoRegistry,
    id: RepoId,
    index: u32,
    oid: &str,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.stash_drop(index, oid))
}

#[tauri::command]
pub async fn list_stashes(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<Vec<StashEntry>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || list_stashes_inner(&reg, id)).await
}

#[tauri::command]
pub async fn get_stash_files(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    oid: String,
) -> Result<StashFiles, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_stash_files_inner(&reg, id, &oid)).await
}

#[tauri::command]
pub async fn stash_push(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    message: Option<String>,
    include_untracked: bool,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || stash_push_inner(&reg, id, message.as_deref(), include_untracked)).await
}

#[tauri::command]
pub async fn stash_apply(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    index: u32,
    oid: String,
) -> Result<StashOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || stash_apply_inner(&reg, id, index, &oid)).await
}

#[tauri::command]
pub async fn stash_pop(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    index: u32,
    oid: String,
) -> Result<StashOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || stash_pop_inner(&reg, id, index, &oid)).await
}

#[tauri::command]
pub async fn stash_drop(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    index: u32,
    oid: String,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || stash_drop_inner(&reg, id, index, &oid)).await
}
