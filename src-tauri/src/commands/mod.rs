//! Tauri command handlers.

pub mod commit;
pub mod history;
pub mod hosting;
pub mod linked_worktrees;
pub mod log;
pub mod merge;
pub mod refs;
pub mod remote;
pub mod repo;
pub mod settings;
pub mod stash;
pub mod tags;
pub mod tools;
pub mod update;
pub mod worktree;

use std::sync::PoisonError;

use git_real_core::{GitError, RepoSession};

use crate::error::{AppError, AppErrorKind};
use crate::state::{RepoId, RepoRegistry};

/// Runs blocking work on Tauri's blocking pool, mapping a join failure to an `Io` error.
pub async fn run_blocking<T, F>(f: F) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError {
            kind: AppErrorKind::Io,
            message: e.to_string(),
            network: None,
        })?
}

/// Runs `f` on the locked session for `id`, or fails with `unknownRepo`.
pub fn with_session<T>(
    reg: &RepoRegistry,
    id: RepoId,
    f: impl FnOnce(&mut RepoSession) -> Result<T, GitError>,
) -> Result<T, AppError> {
    let session = reg.get(id).ok_or_else(|| AppError::unknown_repo(id))?;
    // git2 writes the index through a lock file, so a panicked op leaves no torn state.
    let mut guard = session.lock().unwrap_or_else(PoisonError::into_inner);
    f(&mut guard).map_err(AppError::from)
}
