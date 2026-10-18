//! Composing and recording commits.
//!
//! Message rules live in [`message`]; the commit itself goes through the
//! system `git` CLI so hooks and signing behave exactly as on the command
//! line (ADR 0001). git2 handles the reads around it.

pub mod git_commit;
pub mod message;

use git2::{Config, ErrorCode};

use crate::error::GitError;
use crate::git_cli;
use crate::model::{CommitConfig, CommitMessage, CommitOutcome, SigningFormat};
use crate::repo::RepoSession;

impl RepoSession {
    /// Author identity and signing settings the next commit will use.
    pub fn commit_config(&self) -> Result<CommitConfig, GitError> {
        let config = self.repo().config()?.snapshot()?;
        let name = optional_string(&config, "user.name")?;
        let email = optional_string(&config, "user.email")?;
        let sign = match config.get_bool("commit.gpgsign") {
            Ok(v) => v,
            Err(e) if e.code() == ErrorCode::NotFound => false,
            Err(e) => return Err(e.into()),
        };
        let signing = if sign {
            Some(signing_format(
                optional_string(&config, "gpg.format")?.as_deref(),
            ))
        } else {
            None
        };
        Ok(CommitConfig {
            name,
            email,
            signing,
        })
    }

    /// HEAD's message split for the editor; `None` when HEAD is unborn.
    pub fn head_message(&self) -> Result<Option<CommitMessage>, GitError> {
        match self.repo().head() {
            Ok(head) => {
                let commit = head.peel_to_commit()?;
                let raw = String::from_utf8_lossy(commit.message_bytes());
                Ok(Some(message::split(&raw)))
            }
            Err(e) if is_unborn(&e) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Commits the index (or amends HEAD) through `git commit`.
    pub fn commit(&self, message: &CommitMessage, amend: bool) -> Result<CommitOutcome, GitError> {
        if message.subject.trim().is_empty() {
            return Err(GitError::EmptyMessage);
        }
        if !amend && !self.has_staged_changes()? {
            return Err(GitError::NothingToCommit);
        }
        let workdir = self.workdir()?;
        let git = git_cli::locate()?;
        git_commit::run(&git, workdir, &message::join(message), amend)?;
        let head = self.repo().head()?.peel_to_commit()?;
        Ok(CommitOutcome {
            oid: head.id().to_string(),
            summary: String::from_utf8_lossy(head.summary_bytes().unwrap_or_default()).into_owned(),
        })
    }

    /// True when the index differs from HEAD's tree (or holds anything on an
    /// unborn branch). `diff_tree_to_index` with `None` reloads the on-disk
    /// index, so writes by the git CLI are seen.
    fn has_staged_changes(&self) -> Result<bool, GitError> {
        let repo = self.repo();
        let head_tree = match repo.head() {
            Ok(head) => Some(head.peel_to_tree()?),
            Err(e) if is_unborn(&e) => None,
            Err(e) => return Err(e.into()),
        };
        let diff = repo.diff_tree_to_index(head_tree.as_ref(), None, None)?;
        Ok(diff.deltas().len() > 0)
    }
}

fn is_unborn(e: &git2::Error) -> bool {
    matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound)
}

/// A string config value, with "unset" and "blank" both reported as `None`.
fn optional_string(config: &Config, key: &str) -> Result<Option<String>, GitError> {
    match config.get_string(key) {
        Ok(s) if s.trim().is_empty() => Ok(None),
        Ok(s) => Ok(Some(s)),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Maps `gpg.format` like git does: unknown or unset means OpenPGP.
fn signing_format(value: Option<&str>) -> SigningFormat {
    match value.map(str::to_ascii_lowercase).as_deref() {
        Some("ssh") => SigningFormat::Ssh,
        Some("x509") => SigningFormat::X509,
        _ => SigningFormat::OpenPgp,
    }
}
