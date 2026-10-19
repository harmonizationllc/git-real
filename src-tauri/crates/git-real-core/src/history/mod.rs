//! Commit file lists, file history and blame.

use crate::diff::change_kind;
use crate::error::GitError;
use crate::model::CommitFile;
use crate::repo::RepoSession;
use crate::revision;
use crate::status::file_path;

impl RepoSession {
    /// The paths commit `oid` (full hex) changed against its first parent,
    /// with renames paired, sorted by path.
    pub fn commit_files(&self, oid: &str) -> Result<Vec<CommitFile>, GitError> {
        let repo = self.repo();
        let commit = revision::resolve_commit(repo, oid)?;
        let new = commit.tree()?;
        let old = revision::first_parent_tree(&commit)?;
        let diff =
            revision::commit_delta_diff(repo, old.as_ref(), &new, &mut git2::DiffOptions::new())?;
        let mut files: Vec<CommitFile> = diff
            .deltas()
            .filter_map(|d| {
                change_kind(d.status()).map(|change| {
                    let path = file_path(&d.new_file());
                    let old_path = Some(file_path(&d.old_file())).filter(|o| *o != path);
                    CommitFile {
                        path,
                        old_path,
                        change,
                    }
                })
            })
            .collect();
        // libgit2 orders paired renames by their old path.
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }
}
