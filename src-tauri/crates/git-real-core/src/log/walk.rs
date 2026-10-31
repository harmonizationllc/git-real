//! The refs a graph build starts from: the commits they point at (the
//! tips) and the labels drawn on those commits.

use std::collections::HashSet;

use git2::{Oid, Reference, Repository};

use super::shared::RefLabels;
use crate::error::GitError;
use crate::model::{RefKind, RefLabel};

/// Ref labels by the commit they point at, each list ordered detached HEAD,
/// branches (HEAD's first), remote branches, tags, then by name; and the
/// tips: HEAD's commit when born, then every commit a ref under
/// `refs/heads`, `refs/remotes` or `refs/tags` peels to, deduplicated, in
/// `references()` order.
///
/// A ref whose target object is missing is an error, as it was for the
/// libgit2 walk this replaces; a ref that does not lead to a commit (a tag of
/// a tree or blob) is skipped.
pub(crate) fn labels_and_tips(repo: &Repository) -> Result<(RefLabels, Vec<Oid>), GitError> {
    let mut by_commit = RefLabels::new();
    let mut tips = Vec::new();
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
    // An unborn HEAD has no commit; any other HEAD must lead to one.
    if let Ok(head) = repo.head() {
        tips.push(head.peel_to_commit()?.id());
    }

    for reference in repo.references()? {
        let reference = reference?;
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
        if reference.symbolic_target_bytes().is_some() {
            // `refs/remotes/<remote>/HEAD`: no label, and its target is a
            // ref of its own.
            continue;
        }
        let Some(commit) = peel_tip(repo, &reference)? else {
            continue;
        };
        tips.push(commit);
        let is_head = kind == RefKind::Branch && head_branch.as_deref() == Some(name);
        by_commit.entry(commit).or_default().push(RefLabel {
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
    let mut seen = HashSet::with_capacity(tips.len());
    tips.retain(|oid| seen.insert(*oid));
    Ok((by_commit, tips))
}

/// The commit a direct ref leads to; `None` when it leads to something else.
/// A target object that does not exist is an error.
fn peel_tip(repo: &Repository, reference: &Reference<'_>) -> Result<Option<Oid>, GitError> {
    let Some(target) = reference.target() else {
        return Ok(None);
    };
    let object = repo.find_object(target, None)?;
    Ok(object.peel_to_commit().ok().map(|c| c.id()))
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
