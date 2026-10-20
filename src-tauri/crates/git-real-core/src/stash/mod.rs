//! Stashes: the list and a stash's files are read with git2 from the
//! `refs/stash` reflog; push, apply, pop and drop run the git CLI so hooks
//! and conflict output match the command line (ADR 0001).
//!
//! A write names a stash by index and full oid and fails with `StaleStash`
//! unless `stash@{n}` still is that oid. git takes no oid for apply, pop or
//! drop, so a terminal changing the list between the check and the git run
//! is not caught; that window is milliseconds. A conflicting apply leaves no
//! operation in progress (no MERGE_HEAD), so results are classified by the
//! index alone. Pop is apply then drop, so a drop that fails after a clean
//! apply is reported as `AppliedNotDropped` rather than as a failure.

use std::process::Output;

use git2::Oid;

use crate::error::GitError;
use crate::git_ops::{self, operation_failed};
use crate::model::{StashEntry, StashFiles, StashOutcome};
use crate::repo::RepoSession;

const STASH_REF: &str = "refs/stash";
/// What `git stash push` prints when there was nothing to stash (`LC_ALL=C`).
const NO_LOCAL_CHANGES: &str = "No local changes to save";

impl RepoSession {
    /// The stashes, newest first; entry n is `stash@{n}`. Entries git2
    /// cannot read, or without a parent, are skipped; `index` stays the
    /// reflog position.
    pub fn list_stashes(&self) -> Result<Vec<StashEntry>, GitError> {
        // A missing `refs/stash` reflog reads as empty.
        let reflog = self.repo().reflog(STASH_REF)?;
        Ok(reflog
            .iter()
            .zip(0u32..)
            .filter_map(|(entry, index)| self.stash_entry(&entry, index))
            .collect())
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
        // git exits 0 both when nothing was stashed and when the new stash
        // equals the tip; its message tells them apart.
        if self.stash_tip() == before
            && String::from_utf8_lossy(&output.stdout).contains(NO_LOCAL_CHANGES)
        {
            return Err(GitError::NothingToStash);
        }
        Ok(())
    }

    /// `git stash apply stash@{index}` after checking it is still `oid`.
    pub fn stash_apply(&self, index: u32, oid: &str) -> Result<StashOutcome, GitError> {
        self.ensure_stash(index, oid)?;
        self.ensure_clean()?;
        self.ensure_no_conflicts()?;
        let output = self.run_stash(&["apply", &stash_ref(index)])?;
        self.stash_outcome(&output)
    }

    /// As apply; after a clean apply the stash is dropped. A failed drop (or a
    /// list that changed meanwhile) leaves the stash and is
    /// `AppliedNotDropped`. On conflicts it is kept.
    pub fn stash_pop(&self, index: u32, oid: &str) -> Result<StashOutcome, GitError> {
        match self.stash_apply(index, oid)? {
            StashOutcome::Applied => Ok(match self.stash_drop(index, oid) {
                Ok(()) => StashOutcome::Applied,
                Err(_) => StashOutcome::AppliedNotDropped,
            }),
            other => Ok(other),
        }
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

    /// `None` for an entry whose commit is unreadable or parentless (e.g. hand-stored).
    fn stash_entry(&self, entry: &git2::ReflogEntry<'_>, index: u32) -> Option<StashEntry> {
        let commit = self.repo().find_commit(entry.id_new()).ok()?;
        let base = commit.parent_id(0).ok()?;
        let message = entry.message().unwrap_or("").to_owned();
        Some(StashEntry {
            index,
            oid: commit.id().to_string(),
            branch: branch_of(&message),
            message,
            time: entry.committer().when().seconds(),
            base: base.to_string(),
            has_untracked: commit.parent_count() >= 3,
        })
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

/// git's "WIP on <b>: " / "On <b>: " → `<b>`. Ref names hold no space or ':', so
/// "(no branch)" and hand-stored text ("On the fence: …") are `None`. Mirrors `stashSubject`.
fn branch_of(message: &str) -> Option<String> {
    let rest = message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))?;
    let (branch, _) = rest.split_once(": ")?;
    (!branch.is_empty() && !branch.contains([' ', ':'])).then(|| branch.to_owned())
}
