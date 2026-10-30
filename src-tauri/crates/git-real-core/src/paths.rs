//! Path validation, escaping and canonicalisation.
//!
//! Validation and escaping cover repository-relative paths received from callers.

use std::path::{Path, PathBuf};

use crate::error::GitError;

/// Canonicalises `path`. The git CLI rejects `\\?\` verbatim paths, so every
/// canonical path in this crate comes from here; `dunce` drops the prefix on
/// Windows and is `std::fs::canonicalize` everywhere else.
pub(crate) fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// Normalises `raw` to a repository-relative path, rejecting anything that
/// could reach outside the working tree or into `.git`.
///
/// Trailing `/` characters are stripped. The result must be non-empty, must
/// not start with `/`, must not contain empty, `.` or `..` components, and
/// must not have `.git` (any ASCII case) as its first component. On Windows
/// it must not contain `\` or `:` either. Every rejection is reported as
/// [`GitError::PathNotFound`] for `raw`.
pub fn repo_relative(raw: &str) -> Result<String, GitError> {
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

/// Escapes `p` so a libgit2 glob pattern (a pathspec or a gitignore line)
/// matches it literally: `\ * ? [` get a backslash, and so does each
/// trailing space, which libgit2 would otherwise trim.
pub(crate) fn escape_glob(p: &str) -> String {
    let body = p.trim_end_matches(' ');
    let mut out = String::with_capacity(p.len() + 4);
    for c in body.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push_str(&"\\ ".repeat(p.len() - body.len()));
    out
}

/// Escapes `p` for use as a literal libgit2 pathspec: as [`escape_glob`],
/// plus a leading `!` (negation) or `#` (comment), either of which would
/// otherwise change or empty the pattern.
///
/// Control whitespace (`\n \r \t \x0b \x0c`) cannot be escaped: libgit2
/// ends the pattern there, so callers must reject such paths first.
pub(crate) fn escape_pathspec(p: &str) -> String {
    let escaped = escape_glob(p);
    if escaped.starts_with(['!', '#']) {
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
