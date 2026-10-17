//! Validation and escaping of repository-relative paths received from callers.

use std::path::PathBuf;

use crate::error::GitError;

/// Normalises `raw` to a repository-relative path, rejecting anything that
/// could reach outside the working tree or into `.git`.
///
/// Trailing `/` characters are stripped. The result must be non-empty, must
/// not start with `/`, must not contain empty, `.` or `..` components, and
/// must not have `.git` (any ASCII case) as its first component. Every
/// rejection is reported as [`GitError::PathNotFound`] for `raw`.
pub(crate) fn repo_relative(raw: &str) -> Result<String, GitError> {
    let rejected = || GitError::PathNotFound(PathBuf::from(raw));
    let trimmed = raw.trim_end_matches('/');
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return Err(rejected());
    }
    let mut components = trimmed.split('/');
    if components
        .clone()
        .any(|c| c.is_empty() || c == "." || c == "..")
    {
        return Err(rejected());
    }
    if components
        .next()
        .is_some_and(|first| first.eq_ignore_ascii_case(".git"))
    {
        return Err(rejected());
    }
    Ok(trimmed.to_owned())
}

/// Escapes `\ * ? [` with a backslash so libgit2 pathspecs and gitignore
/// patterns match `p` literally.
pub(crate) fn escape_pathspec(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    for c in p.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}
