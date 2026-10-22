//! Repository lifecycle commands: open, init, clone, close, recents, git CLI probe.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use git_real_core::git_cli;
use git_real_core::remote::clone::clone;
use git_real_core::{ProgressSink, RecentEntry, RepoSession, RepoSummary};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::remote::NetworkAuth;
use super::run_blocking;
use crate::error::AppError;
use crate::events::{EventProgressSink, REPO_CHANGED, RepoChangedPayload};
use crate::hosting_store::HostingStore;
use crate::recent_store::RecentStore;
use crate::state::{RepoId, RepoRegistry, WatcherRegistry};
use crate::watcher::{RepoWatcher, WATCH_DEBOUNCE};

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
    let (id, _) = reg.register_or_find(session);
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
    auth: NetworkAuth<'_>,
    sink: &mut dyn ProgressSink,
) -> Result<OpenedRepo, AppError> {
    let creds = auth.resolve(&[url.to_owned()]);
    let cloned = clone(url, Path::new(dest), creds.as_ref(), sink)?;
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

/// Starts a watcher emitting [`REPO_CHANGED`] for `id`, unless one already runs.
/// Blocking (a recursive watch walks the tree); a failure is logged and the repo stays open.
fn ensure_watcher(app: &AppHandle, watchers: &WatcherRegistry, id: RepoId, path: &Path) {
    if watchers.contains(id) {
        return;
    }
    let app = app.clone();
    let on_change = move || {
        // Best-effort: a closed window must not stop the watcher thread.
        let _ = app.emit(REPO_CHANGED, RepoChangedPayload { repo_id: id });
    };
    match RepoWatcher::start(path, WATCH_DEBOUNCE, on_change) {
        Ok(watcher) => {
            watchers.insert(id, watcher);
        }
        Err(e) => eprintln!("could not watch {}: {e}", path.display()),
    }
}

/// Starts the repo's watcher once the command has opened it.
fn watch_opened(
    app: &AppHandle,
    watchers: &WatcherRegistry,
    opened: Result<OpenedRepo, AppError>,
) -> Result<OpenedRepo, AppError> {
    if let Ok(repo) = &opened {
        ensure_watcher(app, watchers, repo.id, &repo.summary.path);
    }
    opened
}

#[tauri::command]
pub async fn open_repo(
    app: AppHandle,
    reg: State<'_, Arc<RepoRegistry>>,
    recent: State<'_, Arc<RecentStore>>,
    watchers: State<'_, Arc<WatcherRegistry>>,
    path: String,
) -> Result<OpenedRepo, AppError> {
    let (reg, recent) = (Arc::clone(reg.inner()), Arc::clone(recent.inner()));
    let watchers = Arc::clone(watchers.inner());
    run_blocking(move || watch_opened(&app, &watchers, open_repo_inner(&reg, &recent, &path))).await
}

#[tauri::command]
pub async fn init_repo(
    app: AppHandle,
    reg: State<'_, Arc<RepoRegistry>>,
    recent: State<'_, Arc<RecentStore>>,
    watchers: State<'_, Arc<WatcherRegistry>>,
    path: String,
) -> Result<OpenedRepo, AppError> {
    let (reg, recent) = (Arc::clone(reg.inner()), Arc::clone(recent.inner()));
    let watchers = Arc::clone(watchers.inner());
    run_blocking(move || watch_opened(&app, &watchers, init_repo_inner(&reg, &recent, &path))).await
}

#[tauri::command]
pub async fn clone_repo(
    app: AppHandle,
    reg: State<'_, Arc<RepoRegistry>>,
    recent: State<'_, Arc<RecentStore>>,
    watchers: State<'_, Arc<WatcherRegistry>>,
    url: String,
    dest: String,
    clone_id: u64,
) -> Result<OpenedRepo, AppError> {
    let (reg, recent) = (Arc::clone(reg.inner()), Arc::clone(recent.inner()));
    let watchers = Arc::clone(watchers.inner());
    // From the handle rather than a ninth parameter (clippy's argument limit).
    let hosting = Arc::clone(app.state::<Arc<HostingStore>>().inner());
    run_blocking(move || {
        let mut sink = EventProgressSink::new(app.clone(), clone_id);
        let auth = NetworkAuth::Accounts(&hosting);
        let opened = clone_repo_inner(&reg, &recent, &url, &dest, auth, &mut sink);
        watch_opened(&app, &watchers, opened)
    })
    .await
}

#[tauri::command]
pub async fn close_repo(
    reg: State<'_, Arc<RepoRegistry>>,
    watchers: State<'_, Arc<WatcherRegistry>>,
    id: RepoId,
) -> Result<(), AppError> {
    let (reg, watchers) = (Arc::clone(reg.inner()), Arc::clone(watchers.inner()));
    run_blocking(move || {
        // Dropping the watcher joins its thread, so this stays on the blocking pool.
        watchers.remove(id);
        close_repo_inner(&reg, id)
    })
    .await
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
