//! Persisted application settings: the clone directory, Git executable and
//! external tool commands the backend needs. Appearance preferences live in the
//! front end's `localStorage`, not here.

use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

/// The settings the backend persists. Every field is optional; `None` means the
/// default behaviour (clone into the chosen folder, find git on `PATH`, no
/// external tool).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub default_clone_dir: Option<PathBuf>,
    pub git_executable: Option<PathBuf>,
    pub external_editor: Option<String>,
    pub external_diff_tool: Option<String>,
    pub external_merge_tool: Option<String>,
}

/// A partial update of [`Settings`]. An absent key keeps the current value, a
/// `null` clears it, and a value sets it. Each field is `Option<Option<T>>`:
/// the outer `None` is "absent", `Some(None)` is "clear", `Some(Some(v))` is
/// "set".
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    #[serde(default, deserialize_with = "double_option")]
    pub default_clone_dir: Option<Option<PathBuf>>,
    #[serde(default, deserialize_with = "double_option")]
    pub git_executable: Option<Option<PathBuf>>,
    #[serde(default, deserialize_with = "double_option")]
    pub external_editor: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub external_diff_tool: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub external_merge_tool: Option<Option<String>>,
}

/// Distinguishes an absent key from an explicit `null`: serde only calls this
/// when the key is present, so an absent key keeps the field's default (`None`)
/// while a present key yields `Some(_)`.
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A rejected settings update.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SettingsError {
    #[error("the {0} must be an absolute path")]
    RelativePath(&'static str),
    #[error("{0} is not a directory")]
    NotADirectory(PathBuf),
}

impl Settings {
    /// Applies `patch`, validating any changed path. Strings are trimmed and an
    /// empty one becomes `None`. The clone directory and Git executable must be
    /// absolute; the clone directory must also be an existing directory.
    pub fn apply(&self, patch: &SettingsPatch) -> Result<Settings, SettingsError> {
        let mut next = self.clone();
        if let Some(value) = &patch.default_clone_dir {
            next.default_clone_dir = validate_clone_dir(value.clone())?;
        }
        if let Some(value) = &patch.git_executable {
            next.git_executable = validate_git_executable(value.clone())?;
        }
        if let Some(value) = &patch.external_editor {
            next.external_editor = normalize(value.clone());
        }
        if let Some(value) = &patch.external_diff_tool {
            next.external_diff_tool = normalize(value.clone());
        }
        if let Some(value) = &patch.external_merge_tool {
            next.external_merge_tool = normalize(value.clone());
        }
        Ok(next)
    }
}

/// Trims a command and maps a blank one to `None`.
fn normalize(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

fn validate_clone_dir(value: Option<PathBuf>) -> Result<Option<PathBuf>, SettingsError> {
    match value {
        None => Ok(None),
        Some(path) => {
            if !path.is_absolute() {
                return Err(SettingsError::RelativePath("default clone directory"));
            }
            if !path.is_dir() {
                return Err(SettingsError::NotADirectory(path));
            }
            Ok(Some(path))
        }
    }
}

fn validate_git_executable(value: Option<PathBuf>) -> Result<Option<PathBuf>, SettingsError> {
    match value {
        None => Ok(None),
        Some(path) => {
            if !path.is_absolute() {
                return Err(SettingsError::RelativePath("Git executable"));
            }
            Ok(Some(path))
        }
    }
}

/// The on-disk settings format version. Bump it when the shape changes.
pub const SETTINGS_VERSION: u32 = 1;

/// The versioned settings file: `{ "version": 1, "settings": { … } }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsFile {
    pub version: u32,
    #[serde(default)]
    pub settings: Settings,
}

impl SettingsFile {
    /// Wraps `settings` at the current version.
    pub fn current(settings: Settings) -> Self {
        Self {
            version: SETTINGS_VERSION,
            settings,
        }
    }

    /// The settings when the version is current, or `None` for an unknown
    /// version (so the caller falls back to defaults).
    pub fn into_settings(self) -> Option<Settings> {
        (self.version == SETTINGS_VERSION).then_some(self.settings)
    }
}
