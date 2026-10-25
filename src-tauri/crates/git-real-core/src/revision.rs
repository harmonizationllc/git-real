//! Commit and tree lookups shared by diff, content, log and history.

use git2::{Commit, Oid, Repository, Tree};

use crate::error::GitError;

/// The commit named by exactly 40 hex characters, or `CommitNotFound`.
pub(crate) fn resolve_commit<'r>(repo: &'r Repository, oid: &str) -> Result<Commit<'r>, GitError> {
    let not_found = || GitError::CommitNotFound(oid.to_owned());
    if oid.len() != 40 || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(not_found());
    }
    let id = Oid::from_str(oid).map_err(|_| not_found())?;
    repo.find_commit(id).map_err(|_| not_found())
}

/// The first parent's oid of the commit named `oid`; `None` for a root commit.
/// `CommitNotFound` when `oid` is not a commit in the repository.
pub(crate) fn first_parent_oid(repo: &Repository, oid: &str) -> Result<Option<String>, GitError> {
    let commit = resolve_commit(repo, oid)?;
    if commit.parent_count() == 0 {
        return Ok(None);
    }
    Ok(Some(commit.parent_id(0)?.to_string()))
}

/// The tree of `commit`'s first parent; `None` for a root commit.
pub(crate) fn first_parent_tree<'r>(commit: &Commit<'r>) -> Result<Option<Tree<'r>>, GitError> {
    if commit.parent_count() == 0 {
        return Ok(None);
    }
    Ok(Some(commit.parent(0)?.tree()?))
}

/// Diffs `old` (empty when `None`) to `new` with type changes kept apart
/// and renames paired, so every commit-level view agrees on change kinds.
pub(crate) fn commit_delta_diff<'r>(
    repo: &'r Repository,
    old: Option<&Tree<'r>>,
    new: &Tree<'r>,
    opts: &mut git2::DiffOptions,
) -> Result<git2::Diff<'r>, GitError> {
    opts.include_typechange(true);
    let mut diff = repo.diff_tree_to_tree(old, Some(new), Some(opts))?;
    diff.find_similar(Some(git2::DiffFindOptions::new().renames(true)))?;
    Ok(diff)
}
