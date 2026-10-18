//! Commit commands: author config, HEAD message, commit and amend.

use std::sync::Arc;

use git_real_core::{CommitConfig, CommitMessage, CommitOutcome};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

pub fn get_commit_config_inner(reg: &RepoRegistry, id: RepoId) -> Result<CommitConfig, AppError> {
    with_session(reg, id, |s| s.commit_config())
}

pub fn get_head_message_inner(
    reg: &RepoRegistry,
    id: RepoId,
) -> Result<Option<CommitMessage>, AppError> {
    with_session(reg, id, |s| s.head_message())
}

pub fn commit_inner(
    reg: &RepoRegistry,
    id: RepoId,
    message: &CommitMessage,
    amend: bool,
) -> Result<CommitOutcome, AppError> {
    with_session(reg, id, |s| s.commit(message, amend))
}

#[tauri::command]
pub async fn get_commit_config(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<CommitConfig, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_commit_config_inner(&reg, id)).await
}

#[tauri::command]
pub async fn get_head_message(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<Option<CommitMessage>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_head_message_inner(&reg, id)).await
}

/// Runs `git commit` (hooks included) on the blocking pool while holding the
/// session lock, so no other operation touches that repository meanwhile.
#[tauri::command]
pub async fn commit(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    message: CommitMessage,
    amend: bool,
) -> Result<CommitOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || commit_inner(&reg, id, &message, amend)).await
}
