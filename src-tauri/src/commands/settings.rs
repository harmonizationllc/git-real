//! Settings commands: read and update the persisted [`SettingsStore`], locate
//! and reveal its file, and report settings that point at something missing.

use std::sync::Arc;

use git_real_core::settings::Theme;
use git_real_core::{GitError, Settings, SettingsPatch};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::run_blocking;
use crate::error::{AppError, AppErrorKind};
use crate::main_window;
use crate::settings_store::SettingsStore;

pub fn get_settings_inner(store: &SettingsStore) -> Settings {
    store.get()
}

pub fn update_settings_inner(
    store: &SettingsStore,
    patch: &SettingsPatch,
) -> Result<Settings, AppError> {
    store.update(patch)
}

/// Whether an update changed the theme, so the window background must follow.
pub fn theme_changed(before: &Settings, after: &Settings) -> bool {
    before.appearance.theme != after.appearance.theme
}

/// Settings whose target is missing on disk, for the front end to flag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsHealth {
    /// A default clone directory is set but is not an existing directory.
    pub default_clone_dir_missing: bool,
}

pub fn check_settings_health_inner(store: &SettingsStore) -> SettingsHealth {
    SettingsHealth {
        default_clone_dir_missing: store
            .get()
            .clone
            .default_dir
            .is_some_and(|dir| !dir.is_dir()),
    }
}

/// The settings file's absolute path, for the front end to show.
pub fn settings_file_path_inner(store: &SettingsStore) -> String {
    store.path().to_string_lossy().into_owned()
}

/// Shows the settings file in the system file manager, writing it first when it
/// does not exist yet (the opener canonicalises the path, so it must exist).
pub fn reveal_settings_file_inner(store: &SettingsStore) -> Result<(), AppError> {
    store.ensure_file_exists().map_err(GitError::Io)?;
    tauri_plugin_opener::reveal_item_in_dir(store.path()).map_err(|e| AppError {
        kind: AppErrorKind::Io,
        message: e.to_string(),
        network: None,
    })
}

#[tauri::command]
pub async fn get_settings(settings: State<'_, Arc<SettingsStore>>) -> Result<Settings, AppError> {
    let store = Arc::clone(settings.inner());
    run_blocking(move || Ok(get_settings_inner(&store))).await
}

#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    settings: State<'_, Arc<SettingsStore>>,
    patch: SettingsPatch,
) -> Result<Settings, AppError> {
    let store = Arc::clone(settings.inner());
    let (before, next) = run_blocking(move || {
        let before = store.get();
        update_settings_inner(&store, &patch).map(|next| (before, next))
    })
    .await?;
    // The settings are saved; a failure to recolour the window is only logged.
    // A switch to `system` is left to `sync_window_background`, which the page
    // calls with the desktop's real colour scheme.
    if theme_changed(&before, &next)
        && !main_window::follows_desktop(next.appearance.theme)
        && let Some(window) = app.get_webview_window(main_window::LABEL)
        && let Err(e) = main_window::apply_background(&window, next.appearance.theme, None)
    {
        eprintln!("settings: cannot update window background: {e}");
    }
    Ok(next)
}

/// Recolours the window for the desktop colour scheme the page reports. On
/// Linux the window's own theme is cached at creation, so the page is the
/// source of truth after launch. The page calls this only while its theme is
/// `system`, and the command trusts that rather than re-checking the stored
/// theme: the page store updates at once but the file save is debounced, so
/// right after a switch to `system` the stored theme is still the old one. A
/// recolour failure is only logged.
#[tauri::command]
pub async fn sync_window_background(app: AppHandle, desktop_dark: bool) -> Result<(), AppError> {
    run_blocking(move || {
        if let Some(window) = app.get_webview_window(main_window::LABEL)
            && let Err(e) = main_window::apply_background(
                &window,
                Theme::System,
                Some(main_window::desktop_theme(desktop_dark)),
            )
        {
            eprintln!("settings: cannot update window background: {e}");
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn reveal_settings_file(settings: State<'_, Arc<SettingsStore>>) -> Result<(), AppError> {
    let store = Arc::clone(settings.inner());
    run_blocking(move || reveal_settings_file_inner(&store)).await
}

#[tauri::command]
pub async fn check_settings_health(
    settings: State<'_, Arc<SettingsStore>>,
) -> Result<SettingsHealth, AppError> {
    let store = Arc::clone(settings.inner());
    run_blocking(move || Ok(check_settings_health_inner(&store))).await
}

#[tauri::command]
pub async fn settings_file_path(
    settings: State<'_, Arc<SettingsStore>>,
) -> Result<String, AppError> {
    let store = Arc::clone(settings.inner());
    run_blocking(move || Ok(settings_file_path_inner(&store))).await
}
