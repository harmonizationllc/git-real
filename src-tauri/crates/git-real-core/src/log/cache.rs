//! The session's cached commit graph and the ref fingerprint that decides
//! when it must be rebuilt.

use std::hash::{DefaultHasher, Hash, Hasher};

use git2::{Oid, Repository};

use crate::error::GitError;
use crate::model::{GraphEdge, GraphRow, RefLabel};

/// One laid-out commit, kept with binary oids until a page is requested.
pub(crate) struct CachedRow {
    pub(crate) oid: Oid,
    pub(crate) parents: Vec<Oid>,
    pub(crate) subject: String,
    pub(crate) author_name: String,
    pub(crate) author_email: String,
    pub(crate) author_time: i64,
    pub(crate) lane: u32,
    pub(crate) edges: Vec<GraphEdge>,
    pub(crate) refs: Vec<RefLabel>,
}

impl CachedRow {
    pub(crate) fn to_row(&self) -> GraphRow {
        GraphRow {
            oid: self.oid.to_string(),
            parents: self.parents.iter().map(Oid::to_string).collect(),
            subject: self.subject.clone(),
            author_name: self.author_name.clone(),
            author_email: self.author_email.clone(),
            author_time: self.author_time,
            lane: self.lane,
            edges: self.edges.clone(),
            refs: self.refs.clone(),
        }
    }
}

/// The whole graph, in walk order, for one state of the refs.
pub(crate) struct LogCache {
    /// Starts at 1 and increments with every rebuild.
    pub(crate) generation: u64,
    pub(crate) fingerprint: u64,
    pub(crate) rows: Vec<CachedRow>,
    pub(crate) max_lanes: u32,
}

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
