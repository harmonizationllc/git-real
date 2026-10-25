//! External-tool commands: open a file in the editor, or run the diff or merge
//! tool. Each reads what it needs under the session lock, drops it, then locates
//! git and runs the tool — so a tool left open for minutes never blocks the repo.

use std::path::Path;
use std::sync::{Arc, PoisonError};

use git_real_core::ExternalDiffScope;
use git_real_core::git_cli;
use git_real_core::tools;
use tauri::State;

use super::run_blocking;
use crate::error::AppError;
use crate::settings_store::SettingsStore;
use crate::state::{RepoId, RepoRegistry};

pub fn open_in_editor_inner(store: &SettingsStore, path: &str) -> Result<(), AppError> {
    let editor = store
        .get()
        .external_editor
        .ok_or_else(|| AppError::no_external_tool("editor"))?;
    tools::open_in_editor(&editor, Path::new(path))?;
    Ok(())
}

pub fn open_external_diff_inner(
    reg: &RepoRegistry,
    store: &SettingsStore,
    id: RepoId,
    path: &str,
    scope: &ExternalDiffScope,
) -> Result<(), AppError> {
    let cmd = store
        .get()
        .external_diff_tool
        .ok_or_else(|| AppError::no_external_tool("diff tool"))?;
    // Resolve the scope and read the repo path under the lock, then drop it.
    let (repo_path, range) = {
        let session = reg.get(id).ok_or_else(|| AppError::unknown_repo(id))?;
        let guard = session.lock().unwrap_or_else(PoisonError::into_inner);
        let range = scope.resolve(&guard)?;
        (guard.path().to_path_buf(), range)
    };
    let git = git_cli::locate()?;
    tools::open_external_diff(&git, &repo_path, &cmd, path, &range)?;
    Ok(())
}

pub fn open_external_merge_inner(
    reg: &RepoRegistry,
    store: &SettingsStore,
    id: RepoId,
    path: &str,
) -> Result<(), AppError> {
    let cmd = store
        .get()
        .external_merge_tool
        .ok_or_else(|| AppError::no_external_tool("merge tool"))?;
    // Read the repo path under the lock, then drop it before the tool runs.
    let repo_path = {
        let session = reg.get(id).ok_or_else(|| AppError::unknown_repo(id))?;
        let guard = session.lock().unwrap_or_else(PoisonError::into_inner);
        guard.path().to_path_buf()
    };
    let git = git_cli::locate()?;
    tools::open_external_merge(&git, &repo_path, &cmd, path)?;
    Ok(())
}

#[tauri::command]
pub async fn open_in_editor(
    settings: State<'_, Arc<SettingsStore>>,
    path: String,
) -> Result<(), AppError> {
    let store = Arc::clone(settings.inner());
    run_blocking(move || open_in_editor_inner(&store, &path)).await
}

#[tauri::command]
pub async fn open_external_diff(
    reg: State<'_, Arc<RepoRegistry>>,
    settings: State<'_, Arc<SettingsStore>>,
    repo_id: RepoId,
    path: String,
    scope: ExternalDiffScope,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    let store = Arc::clone(settings.inner());
    run_blocking(move || open_external_diff_inner(&reg, &store, repo_id, &path, &scope)).await
}

#[tauri::command]
pub async fn open_external_merge(
    reg: State<'_, Arc<RepoRegistry>>,
    settings: State<'_, Arc<SettingsStore>>,
    repo_id: RepoId,
    path: String,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    let store = Arc::clone(settings.inner());
    run_blocking(move || open_external_merge_inner(&reg, &store, repo_id, &path)).await
}
