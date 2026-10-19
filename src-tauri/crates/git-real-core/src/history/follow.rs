//! Following one path through the commit graph: memoised tree lookups and
//! rename detection.

use std::collections::HashMap;
use std::path::Path;

use git2::{Delta, ErrorCode, ObjectType, Oid, Repository, Tree};

use crate::error::GitError;
use crate::revision;
use crate::status::file_path;

/// The blob at the followed path in each tree looked up so far. Lookups are
/// only valid for one path, so switching paths forgets them.
pub(super) struct EntryMemo {
    path: String,
    by_tree: HashMap<Oid, Option<Oid>>,
}

impl EntryMemo {
    pub(super) fn new(path: String) -> Self {
        Self {
            path,
            by_tree: HashMap::new(),
        }
    }

    pub(super) fn path(&self) -> &str {
        &self.path
    }

    /// Switches to `path` and forgets every lookup made for the previous one.
    pub(super) fn follow(&mut self, path: String) {
        self.path = path;
        self.by_tree.clear();
    }

    /// The blob at the followed path in tree `tree_oid`, memoised per tree.
    /// A tree or gitlink at the path is not the file, so it is `None`.
    pub(super) fn entry(
        &mut self,
        repo: &Repository,
        tree_oid: Oid,
    ) -> Result<Option<Oid>, GitError> {
        if let Some(found) = self.by_tree.get(&tree_oid) {
            return Ok(*found);
        }
        let tree = repo.find_tree(tree_oid)?;
        let found = match tree.get_path(Path::new(&self.path)) {
            Ok(entry) if entry.kind() == Some(ObjectType::Blob) => Some(entry.id()),
            Ok(_) => None,
            Err(e) if e.code() == ErrorCode::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        self.by_tree.insert(tree_oid, found);
        Ok(found)
    }
}

/// The old path when the change from `parent` to `tree` renamed something to `path`.
pub(super) fn rename_source(
    repo: &Repository,
    parent: Option<&Tree<'_>>,
    tree: &Tree<'_>,
    path: &str,
) -> Result<Option<String>, GitError> {
    let diff = revision::commit_delta_diff(repo, parent, tree, &mut git2::DiffOptions::new())?;
    Ok(diff
        .deltas()
        .find(|d| {
            d.status() == Delta::Renamed && d.new_file().path_bytes() == Some(path.as_bytes())
        })
        .map(|d| file_path(&d.old_file())))
}
