//! File-backed application settings, mirroring [`RecentStore`](crate::recent_store::RecentStore).
//!
//! A missing, unreadable, corrupt or unknown-version file yields defaults
//! (logged); an invalid field falls back to its default with a logged warning
//! and the rest of the file is kept. Loading never writes the file. Saves write
//! a temp file then rename, so a crash never leaves a half-written file.

use std::ffi::OsString;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use git_real_core::git_cli;
use git_real_core::settings::{SettingsFileError, SettingsWarning, WindowGeometry};
use git_real_core::{GitError, Settings, SettingsFile, SettingsPatch};

use crate::error::AppError;

/// Settings persisted as JSON. Save failures surface as `Io` errors to the caller.
pub struct SettingsStore {
    path: PathBuf,
    inner: Mutex<Settings>,
}

impl SettingsStore {
    /// Loads the store; a missing, unreadable, corrupt or unknown-version file
    /// yields default settings. Never creates the file.
    pub fn load(path: PathBuf) -> Self {
        let settings = match fs::read_to_string(&path) {
            Ok(text) => parse_or_default(&text, &path),
            Err(e) if e.kind() == ErrorKind::NotFound => Settings::default(),
            Err(e) => {
                eprintln!("settings: cannot read {}: {e}", path.display());
                Settings::default()
            }
        };
        Self {
            path,
            inner: Mutex::new(settings),
        }
    }

    /// A snapshot of the current settings.
    pub fn get(&self) -> Settings {
        self.lock().clone()
    }

    /// Pushes the stored git executable (if any) into the process-wide override.
    /// Called once at startup after [`load`](Self::load).
    pub fn apply_git_override(&self) {
        git_cli::set_configured_path(self.get().git.executable);
    }

    /// Applies `patch`, verifying a newly set git executable, persisting the
    /// result and updating the override. On any error the stored settings and
    /// the override are left unchanged.
    pub fn update(&self, patch: &SettingsPatch) -> Result<Settings, AppError> {
        let mut guard = self.lock();
        let next = guard.apply(patch)?;
        let git_changed = next.git.executable != guard.git.executable;
        // Verify a newly set git executable before persisting it.
        if let Some(path) = next.git.executable.as_ref().filter(|_| git_changed) {
            git_cli::verify(path)?;
        }
        self.save(&next).map_err(GitError::Io)?;
        *guard = next.clone();
        // Only touch the process-wide override when the executable changed, so
        // an unrelated settings update never clears a configured path.
        if git_changed {
            git_cli::set_configured_path(next.git.executable.clone());
        }
        Ok(next)
    }

    /// Stores the main window's geometry. Writes the file only when it differs
    /// from the stored geometry; returns whether it wrote.
    pub fn set_window(&self, geometry: WindowGeometry) -> io::Result<bool> {
        let mut guard = self.lock();
        if guard.window == geometry {
            return Ok(false);
        }
        let mut next = guard.clone();
        next.window = geometry;
        self.save(&next)?;
        *guard = next;
        Ok(true)
    }

    /// The settings file's location (it may not exist yet).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A webview init script that sets `window.__GIT_REAL_SETTINGS__` to the
    /// current settings. Every `<` is written as a JSON unicode escape so no
    /// string value can close a `<script>` element.
    pub fn to_init_script(&self) -> String {
        let json = serde_json::to_string(&self.get())
            .expect("Settings has only string keys, so it always serialises");
        format!(
            "window.__GIT_REAL_SETTINGS__={};",
            json.replace('<', "\\u003c")
        )
    }

    fn lock(&self) -> MutexGuard<'_, Settings> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Writes to `<path>.tmp` then renames, so a crash never leaves a half-written file.
    fn save(&self, settings: &Settings) -> io::Result<()> {
        let file = SettingsFile::current(settings.clone());
        let json = serde_json::to_string_pretty(&file).map_err(io::Error::other)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut tmp: OsString = self.path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, json)?;
        fs::rename(&tmp, &self.path).inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })
    }
}

/// Parses a settings file through the lenient per-field reader, logging each
/// warning, and falling back to defaults on a corrupt file or an unknown version.
fn parse_or_default(text: &str, path: &Path) -> Settings {
    match SettingsFile::parse(text) {
        Ok((settings, warnings)) => {
            for SettingsWarning { field, message } in warnings {
                eprintln!("settings: {field}: {message}");
            }
            settings
        }
        Err(SettingsFileError::UnknownVersion(n)) => {
            eprintln!("settings: ignoring version {n} in {}", path.display());
            Settings::default()
        }
        Err(SettingsFileError::Corrupt(e)) => {
            eprintln!("settings: ignoring corrupt {}: {e}", path.display());
            Settings::default()
        }
    }
}
