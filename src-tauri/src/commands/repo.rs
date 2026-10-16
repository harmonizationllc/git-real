//! Repository lifecycle commands: open, init, clone, close, recents, git CLI probe.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use git_real_core::remote::{clone::clone, git_cli};
use git_real_core::{ProgressSink, RecentEntry, RepoSession, RepoSummary};
use serde::Serialize;
use tauri::{AppHandle, State};

use super::run_blocking;
use crate::error::AppError;
use crate::events::EventProgressSink;
use crate::recent_store::RecentStore;
use crate::state::{RepoId, RepoRegistry};

/// A registered repository: its handle plus a snapshot summary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedRepo {
    pub id: RepoId,
    pub summary: RepoSummary,
}

/// Whether the system git CLI was found, and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCliInfo {
    pub available: bool,
    pub path: Option<String>,
}

impl GitCliInfo {
    pub fn from_located(located: Option<PathBuf>) -> Self {
        Self {
            available: located.is_some(),
            path: located.map(|p| p.to_string_lossy().into_owned()),
        }
    }
}

/// Registers the session (reusing the id of an already-open repo) and records it as recent.
fn register_session(reg: &RepoRegistry, recent: &RecentStore, session: RepoSession) -> OpenedRepo {
    let summary = session.summary();
    let id = match reg.find_by_path(session.path()) {
        Some(id) => id,
        None => reg.register(session),
    };
    recent.touch(summary.path.clone(), summary.name.clone());
    OpenedRepo { id, summary }
}

pub fn open_repo_inner(
    reg: &RepoRegistry,
    recent: &RecentStore,
    path: &str,
) -> Result<OpenedRepo, AppError> {
    let session = RepoSession::open(path)?;
    Ok(register_session(reg, recent, session))
}

pub fn init_repo_inner(
    reg: &RepoRegistry,
    recent: &RecentStore,
    path: &str,
) -> Result<OpenedRepo, AppError> {
    let session = RepoSession::init(path)?;
    Ok(register_session(reg, recent, session))
}

pub fn clone_repo_inner(
    reg: &RepoRegistry,
    recent: &RecentStore,
    url: &str,
    dest: &str,
    sink: &mut dyn ProgressSink,
) -> Result<OpenedRepo, AppError> {
    let cloned = clone(url, Path::new(dest), sink)?;
    let session = RepoSession::open(&cloned)?;
    Ok(register_session(reg, recent, session))
}

pub fn close_repo_inner(reg: &RepoRegistry, id: RepoId) -> Result<(), AppError> {
    if reg.remove(id) {
        Ok(())
    } else {
        Err(AppError::unknown_repo(id))
    }
}

pub fn list_recent_inner(recent: &RecentStore) -> Vec<RecentEntry> {
    recent.entries()
}

pub fn remove_recent_inner(recent: &RecentStore, path: &str) -> Vec<RecentEntry> {
    recent.remove(Path::new(path))
}

pub fn check_git_cli_inner() -> GitCliInfo {
    GitCliInfo::from_located(git_cli::locate().ok())
}

#[tauri::command]
pub async fn open_repo(
    reg: State<'_, Arc<RepoRegistry>>,
    recent: State<'_, Arc<RecentStore>>,
    path: String,
) -> Result<OpenedRepo, AppError> {
    let (reg, recent) = (Arc::clone(reg.inner()), Arc::clone(recent.inner()));
    run_blocking(move || open_repo_inner(&reg, &recent, &path)).await
}

#[tauri::command]
pub async fn init_repo(
    reg: State<'_, Arc<RepoRegistry>>,
    recent: State<'_, Arc<RecentStore>>,
    path: String,
) -> Result<OpenedRepo, AppError> {
    let (reg, recent) = (Arc::clone(reg.inner()), Arc::clone(recent.inner()));
    run_blocking(move || init_repo_inner(&reg, &recent, &path)).await
}

#[tauri::command]
pub async fn clone_repo(
    app: AppHandle,
    reg: State<'_, Arc<RepoRegistry>>,
    recent: State<'_, Arc<RecentStore>>,
    url: String,
    dest: String,
    clone_id: u64,
) -> Result<OpenedRepo, AppError> {
    let (reg, recent) = (Arc::clone(reg.inner()), Arc::clone(recent.inner()));
    run_blocking(move || {
        let mut sink = EventProgressSink::new(app, clone_id);
        clone_repo_inner(&reg, &recent, &url, &dest, &mut sink)
    })
    .await
}

#[tauri::command]
pub async fn close_repo(reg: State<'_, Arc<RepoRegistry>>, id: RepoId) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || close_repo_inner(&reg, id)).await
}

#[tauri::command]
pub async fn list_recent(
    recent: State<'_, Arc<RecentStore>>,
) -> Result<Vec<RecentEntry>, AppError> {
    let recent = Arc::clone(recent.inner());
    run_blocking(move || Ok(list_recent_inner(&recent))).await
}

#[tauri::command]
pub async fn remove_recent(
    recent: State<'_, Arc<RecentStore>>,
    path: String,
) -> Result<Vec<RecentEntry>, AppError> {
    let recent = Arc::clone(recent.inner());
    run_blocking(move || Ok(remove_recent_inner(&recent, &path))).await
}

#[tauri::command]
pub async fn check_git_cli() -> Result<GitCliInfo, AppError> {
    run_blocking(|| Ok(check_git_cli_inner())).await
}
