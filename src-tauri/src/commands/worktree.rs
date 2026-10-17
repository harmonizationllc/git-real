//! Working-tree commands: status, diffs, staging, discarding and ignoring.

use std::sync::Arc;

use git_real_core::{
    DiffOptions, DiffScope, FileDiff, HunkAction, HunkSelection, WorkingTreeStatus,
};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

pub fn get_status_inner(reg: &RepoRegistry, id: RepoId) -> Result<WorkingTreeStatus, AppError> {
    with_session(reg, id, |s| s.status())
}

pub fn get_file_diff_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &str,
    scope: DiffScope,
    ignore_whitespace: bool,
) -> Result<FileDiff, AppError> {
    let opts = DiffOptions {
        ignore_whitespace,
        ..DiffOptions::default()
    };
    with_session(reg, id, |s| s.file_diff(path, scope, opts))
}

pub fn stage_paths_inner(reg: &RepoRegistry, id: RepoId, paths: &[String]) -> Result<(), AppError> {
    with_session(reg, id, |s| s.stage_paths(paths))
}

pub fn unstage_paths_inner(
    reg: &RepoRegistry,
    id: RepoId,
    paths: &[String],
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.unstage_paths(paths))
}

pub fn stage_all_inner(reg: &RepoRegistry, id: RepoId) -> Result<(), AppError> {
    with_session(reg, id, |s| s.stage_all())
}

pub fn unstage_all_inner(reg: &RepoRegistry, id: RepoId) -> Result<(), AppError> {
    with_session(reg, id, |s| s.unstage_all())
}

pub fn discard_paths_inner(
    reg: &RepoRegistry,
    id: RepoId,
    paths: &[String],
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.discard_paths(paths))
}

pub fn apply_hunk_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &str,
    action: HunkAction,
    selection: &HunkSelection,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.apply_hunk(path, action, selection))
}

pub fn add_to_gitignore_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &str,
) -> Result<String, AppError> {
    with_session(reg, id, |s| s.add_to_gitignore(path))
}

#[tauri::command]
pub async fn get_status(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<WorkingTreeStatus, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_status_inner(&reg, id)).await
}

#[tauri::command]
pub async fn get_file_diff(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    scope: DiffScope,
    ignore_whitespace: bool,
) -> Result<FileDiff, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_file_diff_inner(&reg, id, &path, scope, ignore_whitespace)).await
}

#[tauri::command]
pub async fn stage_paths(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || stage_paths_inner(&reg, id, &paths)).await
}

#[tauri::command]
pub async fn unstage_paths(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || unstage_paths_inner(&reg, id, &paths)).await
}

#[tauri::command]
pub async fn stage_all(reg: State<'_, Arc<RepoRegistry>>, id: RepoId) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || stage_all_inner(&reg, id)).await
}

#[tauri::command]
pub async fn unstage_all(reg: State<'_, Arc<RepoRegistry>>, id: RepoId) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || unstage_all_inner(&reg, id)).await
}

#[tauri::command]
pub async fn discard_paths(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || discard_paths_inner(&reg, id, &paths)).await
}

#[tauri::command]
pub async fn apply_hunk(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    action: HunkAction,
    selection: HunkSelection,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || apply_hunk_inner(&reg, id, &path, action, &selection)).await
}

#[tauri::command]
pub async fn add_to_gitignore(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
) -> Result<String, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || add_to_gitignore_inner(&reg, id, &path)).await
}
