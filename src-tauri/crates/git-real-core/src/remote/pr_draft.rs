//! The prefill for a new pull request (GR-13b): how far the current branch is ahead of
//! `origin/<target>`, and a title and body taken from its one commit or from its name.

use crate::commit::message::split;
use crate::error::GitError;
use crate::model::{CommitMessage, PullRequestDraft};
use crate::refs::{is_not_found, validate_branch_name};
use crate::repo::RepoSession;

/// The most commits [`RepoSession::pull_request_draft`] counts.
const MAX_AHEAD: usize = 1000;

/// A branch name read as a sentence: the text after the last `/`, runs of `-` and `_` as one
/// space, trimmed, first character upper-cased (`feature/add-login` → `Add login`).
pub fn humanize_branch(name: &str) -> String {
    let last = name.rsplit('/').next().unwrap_or(name);
    let words: Vec<&str> = last.split(['-', '_']).filter(|w| !w.is_empty()).collect();
    let text = words.join(" ");
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

impl RepoSession {
    /// The draft for a pull request from HEAD's branch into `target` on `origin`.
    /// `InvalidBranchName` for a bad `target`; `UnbornHead` / `DetachedHead` when HEAD is not a
    /// branch; `RevisionNotFound("origin/<target>")` when that remote branch is unknown.
    pub fn pull_request_draft(&self, target: &str) -> Result<PullRequestDraft, GitError> {
        validate_branch_name(target)?;
        let branch = self.head_branch()?;
        let repo = self.repo();
        let target_oid = match repo.refname_to_id(&format!("refs/remotes/origin/{target}")) {
            Ok(oid) => oid,
            Err(e) if is_not_found(&e) => {
                return Err(GitError::RevisionNotFound(format!("origin/{target}")));
            }
            Err(e) => return Err(e.into()),
        };
        let mut walk = repo.revwalk()?;
        walk.push_head()?;
        walk.hide(target_oid)?;
        let mut ahead = 0usize;
        let mut first = None;
        for oid in walk.take(MAX_AHEAD) {
            let oid = oid?;
            first.get_or_insert(oid);
            ahead += 1;
        }
        let (title, body) = match (ahead, first) {
            (1, Some(oid)) => {
                let commit = repo.find_commit(oid)?;
                let CommitMessage { subject, body } =
                    split(&String::from_utf8_lossy(commit.message_bytes()));
                (subject, body)
            }
            _ => (humanize_branch(&branch), String::new()),
        };
        Ok(PullRequestDraft {
            title,
            body,
            ahead: u32::try_from(ahead).unwrap_or(1000),
        })
    }
}
