//! Settings commands: read and update the persisted [`SettingsStore`].

use std::sync::Arc;

use git_real_core::{Settings, SettingsPatch};
use tauri::State;

use super::run_blocking;
use crate::error::AppError;
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
