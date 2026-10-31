//! Commit graph commands: summary, pages, search, commit detail, detached
//! checkout and reset.

use std::sync::Arc;

use git_real_core::{CommitDetail, LogPage, LogSummary, ResetMode};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

/// Starts a graph rebuild when a ref moved and answers within the first-answer window.
pub fn get_log_summary_inner(reg: &RepoRegistry, id: RepoId) -> Result<LogSummary, AppError> {
    with_session(reg, id, |s| s.log_summary())
}

pub fn get_log_page_inner(
    reg: &RepoRegistry,
    id: RepoId,
    generation: u64,
    start: u32,
    count: u32,
) -> Result<LogPage, AppError> {
    // The session lock is held only to take the snapshot.
    let snapshot = with_session(reg, id, |s| s.log_snapshot(generation))?;
    Ok(snapshot.page(start, count))
}

pub fn search_log_inner(
    reg: &RepoRegistry,
    id: RepoId,
    generation: u64,
    query: &str,
) -> Result<Vec<u32>, AppError> {
    // The scan runs outside the session lock, on the snapshot's own repository.
    let snapshot = with_session(reg, id, |s| s.log_snapshot(generation))?;
    snapshot.search(query).map_err(AppError::from)
}

pub fn get_commit_inner(
    reg: &RepoRegistry,
    id: RepoId,
    oid: &str,
) -> Result<CommitDetail, AppError> {
    with_session(reg, id, |s| s.commit_detail(oid))
}

pub fn checkout_commit_inner(reg: &RepoRegistry, id: RepoId, oid: &str) -> Result<(), AppError> {
    with_session(reg, id, |s| s.checkout_commit(oid))
}

pub fn reset_to_commit_inner(
    reg: &RepoRegistry,
    id: RepoId,
    oid: &str,
    mode: ResetMode,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.reset_to_commit(oid, mode))
}

#[tauri::command]
pub async fn get_log_summary(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<LogSummary, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_log_summary_inner(&reg, id)).await
}

#[tauri::command]
pub async fn get_log_page(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    generation: u64,
    start: u32,
    count: u32,
) -> Result<LogPage, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_log_page_inner(&reg, id, generation, start, count)).await
}

#[tauri::command]
pub async fn search_log(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    generation: u64,
    query: String,
) -> Result<Vec<u32>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || search_log_inner(&reg, id, generation, &query)).await
}

#[tauri::command]
pub async fn get_commit(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    oid: String,
) -> Result<CommitDetail, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_commit_inner(&reg, id, &oid)).await
}

/// Runs `git switch --detach` (hooks included) while holding the session lock.
#[tauri::command]
pub async fn checkout_commit(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    oid: String,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || checkout_commit_inner(&reg, id, &oid)).await
}

#[tauri::command]
pub async fn reset_to_commit(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    oid: String,
    mode: ResetMode,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || reset_to_commit_inner(&reg, id, &oid, mode)).await
}
