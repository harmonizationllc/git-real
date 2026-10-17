//! Adding paths to the repository's top-level `.gitignore`.

use std::io::Write;
use std::path::PathBuf;

use crate::error::GitError;
use crate::paths::{checked_relative, escape_glob};
use crate::repo::RepoSession;

/// Builds a rooted gitignore pattern matching exactly `path`.
///
/// Glob characters, backslashes and trailing spaces are escaped so only the
/// literal name matches; directories get a trailing `/`.
pub fn gitignore_pattern(path: &str, is_dir: bool) -> String {
    let mut pattern = String::from("/");
    pattern.push_str(&escape_glob(path.trim_end_matches('/')));
    if is_dir {
        pattern.push('/');
    }
    pattern
}

impl RepoSession {
    /// Appends a pattern for `path` to `<workdir>/.gitignore` unless the
    /// file already holds it, and returns the pattern.
    pub fn add_to_gitignore(&self, path: &str) -> Result<String, GitError> {
        let workdir = self.workdir()?;
        let rel = checked_relative(workdir, path)?;
        // A gitignore pattern is one line, so a line break cannot be expressed.
        if rel.contains(['\n', '\r']) {
            return Err(GitError::BadSelection);
        }
        let meta = workdir
            .join(&rel)
            .symlink_metadata()
            .map_err(|_| GitError::PathNotFound(PathBuf::from(path)))?;
        let pattern = gitignore_pattern(&rel, meta.file_type().is_dir());

        let gitignore = workdir.join(".gitignore");
        let existing = match std::fs::read_to_string(&gitignore) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        if existing
            .lines()
            .any(|line| line.trim_end_matches('\r') == pattern)
        {
            return Ok(pattern);
        }

        let separator = if existing.is_empty() || existing.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&gitignore)?;
        writeln!(file, "{separator}{pattern}")?;
        Ok(pattern)
    }
}
