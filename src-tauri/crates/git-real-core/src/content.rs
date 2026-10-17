//! Raw bytes of one side of a file diff, for previews and decoding.

use std::io::Read;
use std::path::{Path, PathBuf};

use git2::{ErrorCode, ObjectType};

use crate::error::GitError;
use crate::model::{DiffScope, DiffSide};
use crate::paths::{checked_relative, repo_relative};
use crate::repo::RepoSession;

/// Git file mode of a gitlink (submodule) entry.
const GITLINK_MODE: u32 = 0o160000;

impl RepoSession {
    /// Raw bytes of `path` on `side` of `scope`, refusing anything above `max_bytes`.
    /// `path` is the path on that side (the old path for the old side of a rename).
    pub fn file_content(
        &self,
        path: &str,
        scope: DiffScope,
        side: DiffSide,
        max_bytes: u64,
    ) -> Result<Vec<u8>, GitError> {
        match (scope, side) {
            (DiffScope::Staged, DiffSide::Old) => self.head_blob(&repo_relative(path)?, max_bytes),
            (DiffScope::Staged, DiffSide::New) | (DiffScope::Unstaged, DiffSide::Old) => {
                self.index_blob(&repo_relative(path)?, max_bytes)
            }
            (DiffScope::Unstaged, DiffSide::New) => {
                let workdir = self.workdir()?;
                workdir_bytes(workdir, &checked_relative(workdir, path)?, max_bytes)
            }
        }
    }

    fn head_blob(&self, rel: &str, max_bytes: u64) -> Result<Vec<u8>, GitError> {
        let tree = match self.repo().head().and_then(|h| h.peel_to_tree()) {
            Ok(tree) => tree,
            Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
                return Err(not_found(rel));
            }
            Err(e) => return Err(e.into()),
        };
        let entry = match tree.get_path(Path::new(rel)) {
            Ok(entry) => entry,
            Err(e) if e.code() == ErrorCode::NotFound => return Err(not_found(rel)),
            Err(e) => return Err(e.into()),
        };
        // Trees, and gitlinks whose commit lives in the submodule's store.
        if entry.kind() != Some(ObjectType::Blob) {
            return Err(not_found(rel));
        }
        self.blob_bytes(rel, entry.id(), max_bytes)
    }

    fn index_blob(&self, rel: &str, max_bytes: u64) -> Result<Vec<u8>, GitError> {
        let mut index = self.repo().index()?;
        index.read(true)?;
        let entry = index
            .get_path(Path::new(rel), 0)
            .ok_or_else(|| not_found(rel))?;
        // The index stores no object kind; a gitlink is its only non-blob entry.
        if entry.mode == GITLINK_MODE {
            return Err(not_found(rel));
        }
        self.blob_bytes(rel, entry.id, max_bytes)
    }

    /// Checks the object size through the ODB header before loading the blob.
    fn blob_bytes(&self, rel: &str, oid: git2::Oid, max_bytes: u64) -> Result<Vec<u8>, GitError> {
        let (size, kind) = self.repo().odb()?.read_header(oid)?;
        if kind != ObjectType::Blob {
            return Err(not_found(rel));
        }
        let size = size as u64;
        if size > max_bytes {
            return Err(too_large(rel, size, max_bytes));
        }
        Ok(self.repo().find_blob(oid)?.content().to_vec())
    }
}

/// Reads the working-tree file, refusing it when its size is above `max_bytes`.
/// The read itself is bounded too, so a file that grows after its metadata was
/// read still cannot exceed the cap.
fn workdir_bytes(workdir: &Path, rel: &str, max_bytes: u64) -> Result<Vec<u8>, GitError> {
    let full = workdir.join(rel);
    let meta = std::fs::symlink_metadata(&full).map_err(|_| not_found(rel))?;
    if meta.file_type().is_symlink() {
        // Git stores a symlink as its target string; never follow it.
        let target = std::fs::read_link(&full)?;
        return Ok(target.to_string_lossy().into_owned().into_bytes());
    }
    if !meta.is_file() {
        return Err(not_found(rel));
    }
    if meta.len() > max_bytes {
        return Err(too_large(rel, meta.len(), max_bytes));
    }
    // The file may have grown since its metadata was read.
    let mut bytes = Vec::new();
    std::fs::File::open(&full)?
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    let size = bytes.len() as u64;
    if size > max_bytes {
        return Err(too_large(rel, size, max_bytes));
    }
    Ok(bytes)
}

fn not_found(rel: &str) -> GitError {
    GitError::PathNotFound(PathBuf::from(rel))
}

fn too_large(rel: &str, size: u64, limit: u64) -> GitError {
    GitError::TooLarge {
        path: rel.to_owned(),
        size,
        limit,
    }
}
