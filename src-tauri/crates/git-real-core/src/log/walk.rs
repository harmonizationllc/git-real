//! One topological walk over every branch, remote branch and tag, laid out
//! into lanes and labelled with the refs that point at each commit.

use std::collections::HashMap;

use git2::{Oid, Repository, Sort};

use super::cache::{CachedRow, LogCache};
use super::lanes::LaneLayout;
use crate::error::GitError;
use crate::model::{RefKind, RefLabel};

/// Walks the whole history reachable from HEAD and from every ref under
/// `refs/heads`, `refs/remotes` and `refs/tags`.
pub(crate) fn build(
    repo: &Repository,
    generation: u64,
    fingerprint: u64,
) -> Result<LogCache, GitError> {
    let mut labels = labels(repo)?;

    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    if repo.head().is_ok() {
        walk.push_head()?;
    }
    // Refs that do not peel to a commit (a tag of a blob) are skipped by libgit2.
    for glob in ["refs/heads/*", "refs/remotes/*", "refs/tags/*"] {
        walk.push_glob(glob)?;
    }

    let mut lanes = LaneLayout::new();
    let mut rows = Vec::new();
    for oid in walk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let parents: Vec<Oid> = commit.parent_ids().collect();
        let (lane, edges) = lanes.next(oid, &parents);
        let author = commit.author();
        rows.push(CachedRow {
            oid,
            parents,
            subject: lossy(commit.summary_bytes().unwrap_or_default()),
            author_name: lossy(author.name_bytes()),
            author_email: lossy(author.email_bytes()),
            author_time: author.when().seconds(),
            lane,
            edges,
            refs: labels.remove(&oid).unwrap_or_default(),
        });
    }

    Ok(LogCache {
        generation,
        fingerprint,
        rows,
        max_lanes: lanes.max_columns(),
    })
}

/// Ref labels by the commit they point at, each list ordered detached HEAD,
/// branches (HEAD's first), remote branches, tags, then by name.
fn labels(repo: &Repository) -> Result<HashMap<Oid, Vec<RefLabel>>, GitError> {
    let mut by_commit: HashMap<Oid, Vec<RefLabel>> = HashMap::new();
    let head_ref = repo.find_reference("HEAD")?;
    let head_branch = head_ref.symbolic_target_bytes().map(<[u8]>::to_vec);

    if head_branch.is_none()
        && let Some(oid) = head_ref.target()
    {
        by_commit.entry(oid).or_default().push(RefLabel {
            kind: RefKind::Head,
            name: "HEAD".to_owned(),
            is_head: true,
        });
    }

    for reference in repo.references()? {
        let reference = reference?;
        if reference.symbolic_target_bytes().is_some() {
            continue; // `refs/remotes/<remote>/HEAD`
        }
        let name = reference.name_bytes();
        let (kind, short) = if let Some(short) = name.strip_prefix(b"refs/heads/") {
            (RefKind::Branch, short)
        } else if let Some(short) = name.strip_prefix(b"refs/remotes/") {
            (RefKind::Remote, short)
        } else if let Some(short) = name.strip_prefix(b"refs/tags/") {
            (RefKind::Tag, short)
        } else {
            continue;
        };
        // A ref that does not lead to a commit (a tag of a tree or blob)
        // labels nothing.
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        let is_head = kind == RefKind::Branch && head_branch.as_deref() == Some(name);
        by_commit.entry(commit.id()).or_default().push(RefLabel {
            kind,
            name: lossy(short),
            is_head,
        });
    }

    for list in by_commit.values_mut() {
        list.sort_by(|a, b| {
            (a.kind, !a.is_head, a.name.as_bytes()).cmp(&(b.kind, !b.is_head, b.name.as_bytes()))
        });
    }
    Ok(by_commit)
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
