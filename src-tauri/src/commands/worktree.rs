//! Working-tree commands: status, diffs, staging, discarding and ignoring.

use std::sync::Arc;

use git_real_core::{
    DiffOptions, DiffScope, DiffSide, FileDiff, HunkAction, HunkSelection, WorkingTreeStatus,
};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

/// Largest file the app will hand to the web view for an image preview.
pub const MAX_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;

pub fn get_status_inner(reg: &RepoRegistry, id: RepoId) -> Result<WorkingTreeStatus, AppError> {
    with_session(reg, id, |s| s.status())
}

/// Diff of one file. `max_lines` caps the collected lines; `None` means the
/// core default, and `Some(0)` yields an empty, truncated diff.
pub fn get_file_diff_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &str,
    scope: DiffScope,
    ignore_whitespace: bool,
    max_lines: Option<usize>,
) -> Result<FileDiff, AppError> {
    let defaults = DiffOptions::default();
    let opts = DiffOptions {
        ignore_whitespace,
        max_lines: max_lines.unwrap_or(defaults.max_lines),
        ..defaults
    };
    with_session(reg, id, |s| s.file_diff(path, scope, opts))
}

/// Raw bytes of one side of a file, refusing files larger than `max_bytes`.
pub fn get_file_content_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &str,
    scope: DiffScope,
    side: DiffSide,
    max_bytes: u64,
) -> Result<Vec<u8>, AppError> {
    with_session(reg, id, |s| s.file_content(path, scope, side, max_bytes))
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

/// Diff of one file; `max_lines` (IPC `maxLines`) of `None` means the core default.
#[tauri::command]
pub async fn get_file_diff(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    scope: DiffScope,
    ignore_whitespace: bool,
    max_lines: Option<usize>,
) -> Result<FileDiff, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_file_diff_inner(&reg, id, &path, scope, ignore_whitespace, max_lines))
        .await
}

/// Raw bytes of one side of a file, as a binary IPC response (no base64).
#[tauri::command]
pub async fn get_file_content(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    scope: DiffScope,
    side: DiffSide,
) -> Result<tauri::ipc::Response, AppError> {
    let reg = Arc::clone(reg.inner());
    let bytes = run_blocking(move || {
        get_file_content_inner(&reg, id, &path, scope, side, MAX_PREVIEW_BYTES)
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
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
