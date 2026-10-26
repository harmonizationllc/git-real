//! Settings commands: read and update the persisted [`SettingsStore`], reveal
//! its file, and report settings that point at something missing.

use std::sync::Arc;

use git_real_core::{Settings, SettingsPatch};
use serde::Serialize;
use tauri::State;

use super::run_blocking;
use crate::error::{AppError, AppErrorKind};
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

/// Shows the settings file in the system file manager.
pub fn reveal_settings_file_inner(store: &SettingsStore) -> Result<(), AppError> {
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
    settings: State<'_, Arc<SettingsStore>>,
    patch: SettingsPatch,
) -> Result<Settings, AppError> {
    let store = Arc::clone(settings.inner());
    run_blocking(move || update_settings_inner(&store, &patch)).await
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
