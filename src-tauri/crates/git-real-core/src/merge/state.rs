//! Reading the in-progress operation from git2 and the `.git` marker files.
//!
//! The variant comes only from `Repository::state`, so the reader agrees with
//! every "is something in progress" check; the marker files only fill fields.

use std::path::Path;

use git2::{BranchType, Oid, Repository, RepositoryState};

use crate::commit::message;
use crate::model::{CommitMessage, OperationState};

/// The operation in progress. Never fails: a missing or unparsable oid file
/// yields `""`, a missing name `None`, a missing count `0` and a missing
/// `MERGE_MSG` an empty message.
pub(crate) fn read_state(repo: &Repository) -> OperationState {
    let git_dir = repo.path();
    match repo.state() {
        RepositoryState::Clean
        | RepositoryState::Bisect
        | RepositoryState::ApplyMailbox
        | RepositoryState::ApplyMailboxOrRebase => OperationState::None,
        RepositoryState::Merge => {
            let head = oid_file(git_dir, "MERGE_HEAD");
            OperationState::Merge {
                branch: parse_oid(&head).and_then(|oid| name_for_oid(repo, oid)),
                head,
                message: prepared_message(git_dir),
            }
        }
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => read_rebase(repo, git_dir),
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
            OperationState::CherryPick {
                oid: oid_file(git_dir, "CHERRY_PICK_HEAD"),
                message: prepared_message(git_dir),
            }
        }
        RepositoryState::Revert | RepositoryState::RevertSequence => OperationState::Revert {
            oid: oid_file(git_dir, "REVERT_HEAD"),
            message: prepared_message(git_dir),
        },
    }
}

/// A local branch whose tip is `oid`, else a remote-tracking `remote/name`,
/// else `None`.
pub(crate) fn name_for_oid(repo: &Repository, oid: Oid) -> Option<String> {
    [BranchType::Local, BranchType::Remote]
        .into_iter()
        .find_map(|kind| {
            repo.branches(Some(kind))
                .ok()?
                .flatten()
                .find_map(|(branch, _)| {
                    if branch.get().target() != Some(oid) {
                        return None;
                    }
                    branch.name().ok().flatten().map(str::to_owned)
                })
        })
}

/// `rebase-merge/` (written by `git rebase` since 2.26) or, failing that,
/// the older `rebase-apply/` layout.
fn read_rebase(repo: &Repository, git_dir: &Path) -> OperationState {
    let merge_dir = git_dir.join("rebase-merge");
    let (dir, step_file, total_file) = if merge_dir.is_dir() {
        (merge_dir, "msgnum", "end")
    } else {
        (git_dir.join("rebase-apply"), "next", "last")
    };
    let onto = oid_file(&dir, "onto");
    OperationState::Rebase {
        onto_name: parse_oid(&onto).and_then(|oid| name_for_oid(repo, oid)),
        onto,
        branch: read_trimmed(&dir, "head-name")
            .and_then(|name| name.strip_prefix("refs/heads/").map(str::to_owned)),
        step: count_file(&dir, step_file),
        total: count_file(&dir, total_file),
    }
}

/// git's prepared message for the commit that will finish the operation,
/// without its comment lines.
fn prepared_message(git_dir: &Path) -> CommitMessage {
    std::fs::read(git_dir.join("MERGE_MSG"))
        .map(|raw| message::split(&strip_comments(&String::from_utf8_lossy(&raw))))
        .unwrap_or_else(|_| CommitMessage {
            subject: String::new(),
            body: String::new(),
        })
}

/// Drops every line starting with `#` (git's comments, such as the
/// `# Conflicts:` list); `message::split` then trims the blank lines left
/// at the edges of the body.
fn strip_comments(raw: &str) -> String {
    raw.lines()
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The trimmed first line of an oid file when it is a valid oid, else `""`.
fn oid_file(dir: &Path, name: &str) -> String {
    read_trimmed(dir, name)
        .and_then(|text| text.lines().next().map(str::trim).map(str::to_owned))
        .filter(|line| parse_oid(line).is_some())
        .unwrap_or_default()
}

fn count_file(dir: &Path, name: &str) -> u32 {
    read_trimmed(dir, name)
        .and_then(|text| text.parse().ok())
        .unwrap_or(0)
}

fn read_trimmed(dir: &Path, name: &str) -> Option<String> {
    let raw = std::fs::read(dir.join(name)).ok()?;
    Some(String::from_utf8_lossy(&raw).trim().to_owned())
}

/// Full-hex oids only; libgit2 would zero-pad a short prefix.
fn parse_oid(text: &str) -> Option<Oid> {
    if text.len() != 40 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Oid::from_str(text).ok()
}
