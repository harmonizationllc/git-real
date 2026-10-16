//! Locating the system `git` executable.

use std::env;
use std::ffi::OsStr;
use std::path::PathBuf;

use crate::error::GitError;

#[cfg(windows)]
const CANDIDATES: [&str; 2] = ["git.exe", "git"];
#[cfg(not(windows))]
const CANDIDATES: [&str; 1] = ["git"];

/// Finds `git` on the process `PATH`.
pub fn locate() -> Result<PathBuf, GitError> {
    env::var_os("PATH")
        .and_then(locate_in)
        .ok_or(GitError::GitCliMissing)
}

/// Finds `git` in the given `PATH`-style list.
///
/// Empty and relative entries are skipped so the current directory is never
/// searched.
pub fn locate_in(path_var: impl AsRef<OsStr>) -> Option<PathBuf> {
    env::split_paths(path_var.as_ref())
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| CANDIDATES.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}
