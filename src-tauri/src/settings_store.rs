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
use git_real_core::settings::{SettingsFileError, SettingsWarning, Theme, WindowGeometry};
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
    ///
    /// The lock is never held while git is verified, so reads and other
    /// updates proceed meanwhile. The patch is first applied to a snapshot as
    /// a dry run (so an invalid patch never spawns git), the executable the
    /// patch names is verified unlocked, and the patch is then re-applied to
    /// the current settings under the lock, so overlapping updates each land
    /// on top of the other's result.
    pub fn update(&self, patch: &SettingsPatch) -> Result<Settings, AppError> {
        // Step 1: dry run on a snapshot; the lock is released at once.
        let snapshot = self.get();
        snapshot.apply(patch)?;
        // Step 2: verify a newly named git executable with no lock held.
        if let Some(Some(path)) = patch.git.as_ref().and_then(|g| g.executable.as_ref())
            && snapshot.git.executable.as_ref() != Some(path)
        {
            git_cli::verify(path)?;
        }
        // Step 3: apply to the current settings, save, swap.
        let mut guard = self.lock();
        let next = guard.apply(patch)?;
        let git_changed = next.git.executable != guard.git.executable;
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

    /// Writes the current settings when the file does not exist yet (load never
    /// creates it), so it can be revealed on a fresh install. An existing file
    /// is left untouched.
    pub fn ensure_file_exists(&self) -> io::Result<()> {
        let guard = self.lock();
        if self.path.exists() {
            return Ok(());
        }
        self.save(&guard)
    }

    /// A webview init script that sets `window.__GIT_REAL_SETTINGS__` to the
    /// current settings. Every `<` is written as a JSON unicode escape so no
    /// string value can close a `<script>` element. An explicit light or dark
    /// theme is also set as `data-theme` on the root element, so the page
    /// paints in it before the app script runs; the system theme is left to
    /// the page.
    pub fn to_init_script(&self) -> String {
        let settings = self.get();
        let json = serde_json::to_string(&settings)
            .expect("Settings has only string keys, so it always serialises");
        let mut script = format!(
            "window.__GIT_REAL_SETTINGS__={};",
            json.replace('<', "\\u003c")
        );
        let data_theme = match settings.appearance.theme {
            Theme::Dark => Some("dark"),
            Theme::Light => Some("light"),
            Theme::System => None,
        };
        if let Some(name) = data_theme {
            script.push_str(&format!(
                r#"if(document.documentElement)document.documentElement.setAttribute("data-theme","{name}");"#
            ));
        }
        script
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
