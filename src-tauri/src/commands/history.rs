//! Commit detail, file history and blame commands: tracked files, a
//! commit's file list, one file's history and blame.

use std::sync::Arc;

use git_real_core::{Blame, CommitFile, FileHistoryEntry};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

pub fn list_tracked_files_inner(reg: &RepoRegistry, id: RepoId) -> Result<Vec<String>, AppError> {
    with_session(reg, id, |s| s.tracked_files())
}

pub fn get_commit_files_inner(
    reg: &RepoRegistry,
    id: RepoId,
    oid: &str,
) -> Result<Vec<CommitFile>, AppError> {
    with_session(reg, id, |s| s.commit_files(oid))
}

pub fn get_file_history_inner(
    reg: &RepoRegistry,
    id: RepoId,
    generation: u64,
    path: &str,
) -> Result<Vec<FileHistoryEntry>, AppError> {
    with_session(reg, id, |s| s.file_history(generation, path))
}

pub fn get_blame_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &str,
    oid: Option<&str>,
) -> Result<Blame, AppError> {
    with_session(reg, id, |s| s.blame(path, oid))
}

#[tauri::command]
pub async fn list_tracked_files(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<Vec<String>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || list_tracked_files_inner(&reg, id)).await
}

#[tauri::command]
pub async fn get_commit_files(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    oid: String,
) -> Result<Vec<CommitFile>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_commit_files_inner(&reg, id, &oid)).await
}

#[tauri::command]
pub async fn get_file_history(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    generation: u64,
    path: String,
) -> Result<Vec<FileHistoryEntry>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_file_history_inner(&reg, id, generation, &path)).await
}

#[tauri::command]
pub async fn get_blame(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    oid: Option<String>,
) -> Result<Blame, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_blame_inner(&reg, id, &path, oid.as_deref())).await
}
