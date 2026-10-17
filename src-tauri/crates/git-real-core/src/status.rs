//! Working tree status.

use git2::{DiffFile, ErrorCode, Status, StatusOptions};

use crate::error::GitError;
use crate::model::{ChangeKind, StatusEntry, WorkingTreeStatus};
use crate::repo::RepoSession;

impl RepoSession {
    /// Lists every changed, untracked, or conflicted path, sorted by path.
    pub fn status(&self) -> Result<WorkingTreeStatus, GitError> {
        let repo = self.repo();
        let head_unborn = match repo.head() {
            Ok(_) => false,
            Err(e) if e.code() == ErrorCode::UnbornBranch => true,
            Err(e) => return Err(e.into()),
        };

        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false)
            .renames_head_to_index(true)
            .renames_index_to_workdir(true)
            .exclude_submodules(false);

        let statuses = repo.statuses(Some(&mut opts))?;
        let mut entries: Vec<StatusEntry> = statuses
            .iter()
            .map(|e| {
                let head_to_index = e.head_to_index();
                let index_to_workdir = e.index_to_workdir();
                let path = index_to_workdir
                    .as_ref()
                    .or(head_to_index.as_ref())
                    .map(|d| file_path(&d.new_file()))
                    .unwrap_or_default();
                let old_path = head_to_index
                    .as_ref()
                    .or(index_to_workdir.as_ref())
                    .map(|d| file_path(&d.old_file()))
                    .filter(|old| *old != path);
                let (index, worktree, conflicted) = kinds(e.status());
                StatusEntry {
                    path,
                    old_path,
                    index,
                    worktree,
                    conflicted,
                }
            })
            .collect();
        entries.sort_by(|a, b| a.path.cmp(&b.path));

        Ok(WorkingTreeStatus {
            entries,
            head_unborn,
        })
    }
}

/// Reads a delta file's path as `/`-separated text, independent of platform.
pub(crate) fn file_path(file: &DiffFile<'_>) -> String {
    file.path_bytes()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default()
}

/// Maps libgit2 status flags to `(index, worktree, conflicted)`.
fn kinds(s: Status) -> (Option<ChangeKind>, Option<ChangeKind>, bool) {
    if s.is_conflicted() {
        return (None, Some(ChangeKind::Conflicted), true);
    }
    let index = if s.is_index_new() {
        Some(ChangeKind::Added)
    } else if s.is_index_modified() {
        Some(ChangeKind::Modified)
    } else if s.is_index_deleted() {
        Some(ChangeKind::Deleted)
    } else if s.is_index_renamed() {
        Some(ChangeKind::Renamed)
    } else if s.is_index_typechange() {
        Some(ChangeKind::TypeChange)
    } else {
        None
    };
    let worktree = if s.is_wt_new() {
        Some(ChangeKind::Untracked)
    } else if s.is_wt_modified() {
        Some(ChangeKind::Modified)
    } else if s.is_wt_deleted() {
        Some(ChangeKind::Deleted)
    } else if s.is_wt_renamed() {
        Some(ChangeKind::Renamed)
    } else if s.is_wt_typechange() {
        Some(ChangeKind::TypeChange)
    } else {
        None
    };
    (index, worktree, false)
}
