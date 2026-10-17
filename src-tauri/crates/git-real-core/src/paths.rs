//! Validation and escaping of repository-relative paths received from callers.

use std::path::{Path, PathBuf};

use crate::error::GitError;

/// Normalises `raw` to a repository-relative path, rejecting anything that
/// could reach outside the working tree or into `.git`.
///
/// Trailing `/` characters are stripped. The result must be non-empty, must
/// not start with `/`, must not contain empty, `.` or `..` components, and
/// must not have `.git` (any ASCII case) as its first component. On Windows
/// it must not contain `\` or `:` either. Every rejection is reported as
/// [`GitError::PathNotFound`] for `raw`.
pub(crate) fn repo_relative(raw: &str) -> Result<String, GitError> {
    let rejected = || GitError::PathNotFound(PathBuf::from(raw));
    let trimmed = raw.trim_end_matches('/');
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return Err(rejected());
    }
    // Windows treats `\` as a separator and `C:` as a drive prefix, either of
    // which would slip past the component checks below.
    if cfg!(windows) && trimmed.contains(['\\', ':']) {
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

/// Escapes `\ * ? [` with a backslash so libgit2 glob patterns (pathspecs
/// and gitignore lines) match `p` literally.
pub(crate) fn escape_glob(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    for c in p.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Escapes `p` for use as a literal libgit2 pathspec: glob characters as in
/// [`escape_glob`], plus a leading `!`, which would otherwise negate it.
pub(crate) fn escape_pathspec(p: &str) -> String {
    let escaped = escape_glob(p);
    if escaped.starts_with('!') {
        format!("\\{escaped}")
    } else {
        escaped
    }
}

/// Validates `raw` with [`repo_relative`] and additionally rejects it when
/// any ancestor below `workdir` is a symlink, since following one could
/// read or delete files outside the working tree.
pub(crate) fn checked_relative(workdir: &Path, raw: &str) -> Result<String, GitError> {
    let rel = repo_relative(raw)?;
    let mut ancestor = workdir.to_path_buf();
    let mut components = rel.split('/').peekable();
    while let Some(component) = components.next() {
        if components.peek().is_none() {
            break;
        }
        ancestor.push(component);
        if ancestor
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err(GitError::PathNotFound(PathBuf::from(raw)));
        }
    }
    Ok(rel)
}
