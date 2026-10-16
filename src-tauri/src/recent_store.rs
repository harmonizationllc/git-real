//! File-backed list of recently opened repositories.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs, io::ErrorKind};

use git_real_core::{RecentEntry, RecentRepos};

/// Recents persisted as JSON. Save failures are logged and otherwise ignored.
pub struct RecentStore {
    path: PathBuf,
    inner: Mutex<RecentRepos>,
}

impl RecentStore {
    /// Loads the store; a missing, unreadable or corrupt file yields an empty store.
    pub fn load(path: PathBuf) -> Self {
        let repos = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                eprintln!("recent repos: ignoring corrupt {}: {e}", path.display());
                RecentRepos::default()
            }),
            Err(e) if e.kind() == ErrorKind::NotFound => RecentRepos::default(),
            Err(e) => {
                eprintln!("recent repos: cannot read {}: {e}", path.display());
                RecentRepos::default()
            }
        };
        Self {
            path,
            inner: Mutex::new(repos),
        }
    }

    pub fn touch(&self, path: PathBuf, name: String) -> Vec<RecentEntry> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default();
        let mut repos = self.lock();
        repos.touch(path, name, now);
        self.save_logged(&repos);
        repos.entries().to_vec()
    }

    pub fn remove(&self, path: &Path) -> Vec<RecentEntry> {
        let mut repos = self.lock();
        repos.remove(path);
        self.save_logged(&repos);
        repos.entries().to_vec()
    }

    pub fn entries(&self) -> Vec<RecentEntry> {
        self.lock().entries().to_vec()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RecentRepos> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn save_logged(&self, repos: &RecentRepos) {
        if let Err(e) = self.save(repos) {
            eprintln!("recent repos: cannot save {}: {e}", self.path.display());
        }
    }

    /// Writes to `<path>.tmp` then renames, so a crash never leaves a half-written file.
    fn save(&self, repos: &RecentRepos) -> io::Result<()> {
        let json = serde_json::to_string_pretty(repos).map_err(io::Error::other)?;
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
