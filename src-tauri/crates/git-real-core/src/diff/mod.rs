//! Per-file diffs.

use git2::ErrorCode;

use crate::error::GitError;
use crate::model::{ChangeKind, DiffLine, DiffLineKind, DiffOptions, DiffScope, FileDiff, Hunk};
use crate::repo::RepoSession;
use crate::status::file_path;

impl RepoSession {
    /// Diffs one file in `scope`, failing with `NoChanges` when it has none there.
    pub fn file_diff(
        &self,
        path: &str,
        scope: DiffScope,
        opts: DiffOptions,
    ) -> Result<FileDiff, GitError> {
        let no_changes = || GitError::NoChanges(path.to_owned());
        let diff = self.scoped_diff(path, scope, opts)?;

        let idx = diff
            .deltas()
            .position(|d| d.new_file().path_bytes() == Some(path.as_bytes()))
            .ok_or_else(no_changes)?;
        let patch = git2::Patch::from_diff(&diff, idx)?.ok_or_else(no_changes)?;
        let delta = patch.delta();
        let change = change_kind(delta.status()).ok_or_else(no_changes)?;
        let is_binary = delta.flags().is_binary();
        let (hunks, truncated) = collect_hunks(&patch, opts.max_lines)?;

        let no_visible_change = change == ChangeKind::Modified
            && !is_binary
            && patch.num_hunks() == 0
            && delta.old_file().mode() == delta.new_file().mode();
        if no_visible_change {
            return Err(no_changes());
        }

        let new_path = file_path(&delta.new_file());
        let old_path = Some(file_path(&delta.old_file())).filter(|old| *old != new_path);
        Ok(FileDiff {
            path: new_path,
            old_path,
            scope,
            change: Some(change),
            is_binary,
            hunks,
            truncated,
        })
    }

    /// Builds the git2 diff for `scope`: pathspec-limited when unstaged, whole
    /// index with rename detection when staged.
    fn scoped_diff(
        &self,
        path: &str,
        scope: DiffScope,
        opts: DiffOptions,
    ) -> Result<git2::Diff<'_>, GitError> {
        let repo = self.repo();
        let mut o = git2::DiffOptions::new();
        o.include_typechange(true)
            .ignore_whitespace(opts.ignore_whitespace)
            .context_lines(opts.context_lines);
        match scope {
            DiffScope::Unstaged => {
                o.pathspec(path)
                    .disable_pathspec_match(true)
                    .include_untracked(true)
                    .recurse_untracked_dirs(true)
                    .show_untracked_content(true);
                Ok(repo.diff_index_to_workdir(None, Some(&mut o))?)
            }
            DiffScope::Staged => {
                let head_tree = match repo.head().and_then(|h| h.peel_to_tree()) {
                    Ok(tree) => Some(tree),
                    Err(e) if e.code() == ErrorCode::UnbornBranch => None,
                    Err(e) => return Err(e.into()),
                };
                let mut diff = repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut o))?;
                diff.find_similar(Some(git2::DiffFindOptions::new().renames(true)))?;
                Ok(diff)
            }
        }
    }
}

/// Maps a delta status to a change kind; `None` means nothing to show.
fn change_kind(status: git2::Delta) -> Option<ChangeKind> {
    match status {
        git2::Delta::Added | git2::Delta::Copied => Some(ChangeKind::Added),
        git2::Delta::Untracked => Some(ChangeKind::Untracked),
        git2::Delta::Modified => Some(ChangeKind::Modified),
        git2::Delta::Deleted => Some(ChangeKind::Deleted),
        git2::Delta::Renamed => Some(ChangeKind::Renamed),
        git2::Delta::Typechange => Some(ChangeKind::TypeChange),
        git2::Delta::Conflicted => Some(ChangeKind::Conflicted),
        git2::Delta::Unmodified | git2::Delta::Ignored | git2::Delta::Unreadable => None,
    }
}

/// Collects hunks until `max_lines` lines are gathered; the flag reports
/// whether any line was dropped.
fn collect_hunks(patch: &git2::Patch<'_>, max_lines: usize) -> Result<(Vec<Hunk>, bool), GitError> {
    let mut hunks = Vec::with_capacity(patch.num_hunks());
    let mut count = 0usize;
    for h in 0..patch.num_hunks() {
        let (raw, n) = patch.hunk(h)?;
        let mut hunk = Hunk {
            old_start: raw.old_start(),
            old_lines: raw.old_lines(),
            new_start: raw.new_start(),
            new_lines: raw.new_lines(),
            header: line_text(raw.header()),
            lines: Vec::new(),
        };
        for l in 0..n {
            let raw_line = patch.line_in_hunk(h, l)?;
            let kind = match raw_line.origin_value() {
                git2::DiffLineType::Context => DiffLineKind::Context,
                git2::DiffLineType::Addition => DiffLineKind::Addition,
                git2::DiffLineType::Deletion => DiffLineKind::Deletion,
                git2::DiffLineType::ContextEOFNL
                | git2::DiffLineType::AddEOFNL
                | git2::DiffLineType::DeleteEOFNL => {
                    if let Some(prev) = hunk.lines.last_mut() {
                        prev.no_newline_at_eof = true;
                    }
                    continue;
                }
                git2::DiffLineType::FileHeader
                | git2::DiffLineType::HunkHeader
                | git2::DiffLineType::Binary => continue,
            };
            if count == max_lines {
                if !hunk.lines.is_empty() {
                    hunks.push(hunk);
                }
                return Ok((hunks, true));
            }
            count += 1;
            hunk.lines.push(DiffLine {
                kind,
                old_lineno: raw_line.old_lineno(),
                new_lineno: raw_line.new_lineno(),
                content: line_text(raw_line.content()),
                no_newline_at_eof: false,
            });
        }
        hunks.push(hunk);
    }
    Ok((hunks, false))
}

/// Decodes `bytes` lossily and removes one trailing `"\r\n"`, else one `"\n"`.
fn line_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(&text)
        .to_owned()
}
