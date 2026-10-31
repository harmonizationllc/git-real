//! The ref fingerprint that decides when the commit graph must be rebuilt.

use std::hash::{DefaultHasher, Hash, Hasher};

use git2::Repository;

use crate::error::GitError;

/// A hash of every ref under `refs/` plus HEAD, by name and target. Any ref
/// that is created, moved or deleted changes it; working tree edits do not.
///
/// Not noticed: `.git/shallow` changing without any ref moving, and
/// `refs/replace` (libgit2 ignores replace objects when walking anyway).
pub(crate) fn fingerprint(repo: &Repository) -> Result<u64, GitError> {
    let mut entries: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for reference in repo.references()? {
        entries.push(entry(&reference?));
    }
    // `references()` lists `refs/` only.
    if let Ok(head) = repo.find_reference("HEAD") {
        entries.push(entry(&head));
    }
    entries.sort();
    let mut hasher = DefaultHasher::new();
    entries.hash(&mut hasher);
    Ok(hasher.finish())
}

/// A ref's name and its direct target, or its symbolic target.
fn entry(reference: &git2::Reference<'_>) -> (Vec<u8>, Vec<u8>) {
    let target = match reference.target() {
        Some(oid) => oid.as_bytes().to_vec(),
        None => reference
            .symbolic_target_bytes()
            .unwrap_or_default()
            .to_vec(),
    };
    (reference.name_bytes().to_vec(), target)
}
