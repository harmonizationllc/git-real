//! Linked worktree commands: list, add, remove, dirty check and prune (GR-39).

use std::path::Path;
use std::sync::Arc;

use git_real_core::{LinkedWorktree, PrunedWorktrees, WorktreeBranch};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

pub fn list_linked_worktrees_inner(
    reg: &RepoRegistry,
    id: RepoId,
) -> Result<Vec<LinkedWorktree>, AppError> {
    with_session(reg, id, |s| s.list_linked_worktrees())
}

pub fn add_linked_worktree_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &Path,
    branch: &WorktreeBranch,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.add_linked_worktree(path, branch))
}

pub fn remove_linked_worktree_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &Path,
    force: bool,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.remove_linked_worktree(path, force))
}

pub fn is_linked_worktree_dirty_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &Path,
) -> Result<bool, AppError> {
    with_session(reg, id, |s| s.linked_worktree_dirty(path))
}

pub fn prune_linked_worktrees_inner(
    reg: &RepoRegistry,
    id: RepoId,
) -> Result<PrunedWorktrees, AppError> {
    with_session(reg, id, |s| s.prune_linked_worktrees())
}

#[tauri::command]
pub async fn list_linked_worktrees(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<Vec<LinkedWorktree>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || list_linked_worktrees_inner(&reg, id)).await
}

#[tauri::command]
pub async fn add_linked_worktree(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    branch: WorktreeBranch,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || add_linked_worktree_inner(&reg, id, Path::new(&path), &branch)).await
}

#[tauri::command]
pub async fn remove_linked_worktree(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    force: bool,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || remove_linked_worktree_inner(&reg, id, Path::new(&path), force)).await
}

#[tauri::command]
pub async fn is_linked_worktree_dirty(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
) -> Result<bool, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || is_linked_worktree_dirty_inner(&reg, id, Path::new(&path))).await
}

#[tauri::command]
pub async fn prune_linked_worktrees(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<PrunedWorktrees, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || prune_linked_worktrees_inner(&reg, id)).await
}
