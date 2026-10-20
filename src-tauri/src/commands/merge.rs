//! Merge commands: merge, fast-forward, rebase, cherry-pick, revert, abort,
//! continue, keep-one-side conflict resolution and the in-progress state.
//!
//! Each git CLI run happens while holding the session lock, as for commit
//! and switch.

use std::sync::Arc;

use git_real_core::{
    ConflictSide, FastForwardCheck, MergeMode, OperationOutcome, OperationState, RebaseCommit,
    RebaseStep,
};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

pub fn get_operation_state_inner(
    reg: &RepoRegistry,
    id: RepoId,
) -> Result<OperationState, AppError> {
    with_session(reg, id, |s| Ok(s.operation_state()))
}

pub fn merge_branch_inner(
    reg: &RepoRegistry,
    id: RepoId,
    branch: &str,
    mode: MergeMode,
) -> Result<OperationOutcome, AppError> {
    with_session(reg, id, |s| s.merge_branch(branch, mode))
}

pub fn rebase_onto_inner(
    reg: &RepoRegistry,
    id: RepoId,
    onto: &str,
) -> Result<OperationOutcome, AppError> {
    with_session(reg, id, |s| s.rebase_onto(onto))
}

pub fn cherry_pick_inner(
    reg: &RepoRegistry,
    id: RepoId,
    oid: &str,
) -> Result<OperationOutcome, AppError> {
    with_session(reg, id, |s| s.cherry_pick(oid))
}

pub fn revert_commit_inner(
    reg: &RepoRegistry,
    id: RepoId,
    oid: &str,
) -> Result<OperationOutcome, AppError> {
    with_session(reg, id, |s| s.revert_commit(oid))
}

pub fn abort_operation_inner(reg: &RepoRegistry, id: RepoId) -> Result<(), AppError> {
    with_session(reg, id, |s| s.abort_operation())
}

pub fn continue_rebase_inner(reg: &RepoRegistry, id: RepoId) -> Result<OperationOutcome, AppError> {
    with_session(reg, id, |s| s.continue_rebase())
}

pub fn resolve_conflicts_inner(
    reg: &RepoRegistry,
    id: RepoId,
    paths: &[String],
    side: ConflictSide,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.resolve_conflicts(paths, side))
}

pub fn write_resolution_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &str,
    text: &str,
    stage: bool,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.write_resolution(path, text, stage))
}

pub fn can_fast_forward_inner(
    reg: &RepoRegistry,
    id: RepoId,
    branch: &str,
) -> Result<FastForwardCheck, AppError> {
    with_session(reg, id, |s| s.can_fast_forward(branch))
}

pub fn rebase_plan_inner(
    reg: &RepoRegistry,
    id: RepoId,
    base: &str,
) -> Result<Vec<RebaseCommit>, AppError> {
    with_session(reg, id, |s| s.rebase_plan(base))
}

pub fn rebase_interactive_inner(
    reg: &RepoRegistry,
    id: RepoId,
    base: &str,
    steps: &[RebaseStep],
) -> Result<OperationOutcome, AppError> {
    with_session(reg, id, |s| s.rebase_interactive(base, steps))
}

#[tauri::command]
pub async fn get_operation_state(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<OperationState, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_operation_state_inner(&reg, id)).await
}

#[tauri::command]
pub async fn merge_branch(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    branch: String,
    mode: MergeMode,
) -> Result<OperationOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || merge_branch_inner(&reg, id, &branch, mode)).await
}

#[tauri::command]
pub async fn rebase_onto(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    onto: String,
) -> Result<OperationOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || rebase_onto_inner(&reg, id, &onto)).await
}

#[tauri::command]
pub async fn cherry_pick(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    oid: String,
) -> Result<OperationOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || cherry_pick_inner(&reg, id, &oid)).await
}

#[tauri::command]
pub async fn revert_commit(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    oid: String,
) -> Result<OperationOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || revert_commit_inner(&reg, id, &oid)).await
}

#[tauri::command]
pub async fn abort_operation(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || abort_operation_inner(&reg, id)).await
}

#[tauri::command]
pub async fn continue_rebase(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<OperationOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || continue_rebase_inner(&reg, id)).await
}

#[tauri::command]
pub async fn resolve_conflicts(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    paths: Vec<String>,
    side: ConflictSide,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || resolve_conflicts_inner(&reg, id, &paths, side)).await
}

#[tauri::command]
pub async fn write_resolution(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    text: String,
    stage: bool,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || write_resolution_inner(&reg, id, &path, &text, stage)).await
}

#[tauri::command]
pub async fn can_fast_forward(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    branch: String,
) -> Result<FastForwardCheck, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || can_fast_forward_inner(&reg, id, &branch)).await
}

#[tauri::command]
pub async fn rebase_plan(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    base: String,
) -> Result<Vec<RebaseCommit>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || rebase_plan_inner(&reg, id, &base)).await
}

#[tauri::command]
pub async fn rebase_interactive(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    base: String,
    steps: Vec<RebaseStep>,
) -> Result<OperationOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || rebase_interactive_inner(&reg, id, &base, &steps)).await
}
