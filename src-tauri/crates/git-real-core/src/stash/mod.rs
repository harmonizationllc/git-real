//! Stashes: the list and a stash's files are read with git2 from the
//! `refs/stash` reflog; push, apply, pop and drop run the git CLI so hooks
//! and conflict output match the command line (ADR 0001).
//!
//! A write names a stash by index and full oid and fails with `StaleStash`
//! unless `stash@{n}` still is that oid. git takes no oid for apply, pop or
//! drop, so a terminal changing the list between the check and the git run
//! is not caught; that window is milliseconds. A conflicting apply leaves no
//! operation in progress (no MERGE_HEAD), so results are classified by the
//! index alone.

use std::process::Output;

use git2::Oid;

use crate::error::GitError;
use crate::merge::{git_ops, operation_failed};
use crate::model::{StashEntry, StashFiles, StashOutcome};
use crate::repo::RepoSession;

const STASH_REF: &str = "refs/stash";

impl RepoSession {
    /// The stashes, newest first; entry n is `stash@{n}`.
    pub fn list_stashes(&self) -> Result<Vec<StashEntry>, GitError> {
        let repo = self.repo();
        // A missing `refs/stash` reflog reads as empty.
        let reflog = repo.reflog(STASH_REF)?;
        reflog
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                let commit = repo.find_commit(entry.id_new())?;
                let message = entry.message().unwrap_or("").to_owned();
                Ok(StashEntry {
                    index: u32::try_from(i).unwrap_or(u32::MAX),
                    oid: commit.id().to_string(),
                    branch: branch_of(&message),
                    message,
                    time: entry.committer().when().seconds(),
                    base: commit.parent_id(0)?.to_string(),
                    has_untracked: commit.parent_count() >= 3,
                })
            })
            .collect()
    }

    /// The files of the listed stash `oid`; anything else is `RevisionNotFound`.
    pub fn stash_files(&self, oid: &str) -> Result<StashFiles, GitError> {
        let not_found = || GitError::RevisionNotFound(oid.to_owned());
        let wanted = Oid::from_str(oid).map_err(|_| not_found())?;
        let listed = self
            .repo()
            .reflog(STASH_REF)?
            .iter()
            .any(|e| e.id_new() == wanted);
        if !listed {
            return Err(not_found());
        }
        let stash = self.repo().find_commit(wanted)?;
        let tracked = self.commit_files(&stash.id().to_string())?;
        let (untracked, untracked_oid) = match stash.parent_id(2) {
            Ok(u) => {
                let hex = u.to_string();
                (self.commit_files(&hex)?, Some(hex))
            }
            Err(_) => (Vec::new(), None),
        };
        Ok(StashFiles {
            tracked,
            untracked,
            untracked_oid,
        })
    }

    /// `git stash push [--include-untracked] [-m <message>]`; a blank message is none.
    pub fn stash_push(
        &self,
        message: Option<&str>,
        include_untracked: bool,
    ) -> Result<(), GitError> {
        self.ensure_born()?;
        self.ensure_clean()?;
        self.ensure_no_conflicts()?;
        let before = self.stash_tip();
        let mut args = vec!["push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
            args.extend(["-m", m]);
        }
        let output = self.run_stash(&args)?;
        if !output.status.success() {
            return Err(operation_failed("stash", &output));
        }
        // git exits 0 with "No local changes to save"; the ref is the reliable signal.
        if self.stash_tip() == before {
            return Err(GitError::NothingToStash);
        }
        Ok(())
    }

    /// `git stash apply stash@{index}` after checking it is still `oid`.
    pub fn stash_apply(&self, index: u32, oid: &str) -> Result<StashOutcome, GitError> {
        self.apply_like("apply", index, oid)
    }

    /// As apply, then git drops the stash; on conflicts git keeps it.
    pub fn stash_pop(&self, index: u32, oid: &str) -> Result<StashOutcome, GitError> {
        self.apply_like("pop", index, oid)
    }

    /// `git stash drop stash@{index}` after checking it is still `oid`.
    pub fn stash_drop(&self, index: u32, oid: &str) -> Result<(), GitError> {
        self.ensure_stash(index, oid)?;
        let output = self.run_stash(&["drop", &stash_ref(index)])?;
        if output.status.success() {
            Ok(())
        } else {
            Err(operation_failed("stash", &output))
        }
    }

    fn apply_like(&self, verb: &str, index: u32, oid: &str) -> Result<StashOutcome, GitError> {
        self.ensure_stash(index, oid)?;
        self.ensure_clean()?;
        self.ensure_no_conflicts()?;
        let output = self.run_stash(&[verb, &stash_ref(index)])?;
        self.stash_outcome(&output)
    }

    /// `StaleStash` unless reflog entry `index` of `refs/stash` is `oid`
    /// (compared as ids, so hex case is ignored; non-hex is stale).
    fn ensure_stash(&self, index: u32, oid: &str) -> Result<(), GitError> {
        let wanted = Oid::from_str(oid).map_err(|_| GitError::StaleStash)?;
        let reflog = self.repo().reflog(STASH_REF)?;
        match reflog.get(index as usize) {
            Some(e) if e.id_new() == wanted => Ok(()),
            _ => Err(GitError::StaleStash),
        }
    }

    fn stash_tip(&self) -> Option<Oid> {
        self.repo().refname_to_id(STASH_REF).ok()
    }

    fn run_stash(&self, args: &[&str]) -> Result<Output, GitError> {
        let (git, workdir) = self.git()?;
        git_ops::run(&git, workdir, "stash", args, &[])
    }

    /// Exit 0 is `Applied`; a non-zero exit with index conflicts is
    /// `Conflicts`; anything else is `OperationFailed`.
    fn stash_outcome(&self, output: &Output) -> Result<StashOutcome, GitError> {
        if output.status.success() {
            Ok(StashOutcome::Applied)
        } else if self.fresh_index()?.has_conflicts() {
            Ok(StashOutcome::Conflicts)
        } else {
            Err(operation_failed("stash", output))
        }
    }
}

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

/// "On <b>: …" / "WIP on <b>: …" → `<b>`; "(no branch)" and anything else → `None`.
fn branch_of(message: &str) -> Option<String> {
    let rest = message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))?;
    let (branch, _) = rest.split_once(':')?;
    (branch != "(no branch)" && !branch.is_empty()).then(|| branch.to_owned())
}
