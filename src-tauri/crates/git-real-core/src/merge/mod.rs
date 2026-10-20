//! Merge, rebase, cherry-pick and revert, plus abort and continue.
//!
//! Every operation goes through the system `git` CLI so hooks, rerere and
//! signing behave exactly as on the command line (ADR 0001). A non-zero exit
//! is classified by the repository afterwards: conflicts are a normal
//! outcome, anything else is `OperationFailed` carrying git's output. State
//! reads use git2 and the `.git` marker files. Resolving conflicts writes the
//! working tree and index through git2 (ADR 0001: index writes are git2).
//! Interactive rebase needs `cp` on the PATH git's shell sees (bundled with
//! Git for Windows).

mod interactive;
mod resolve;
mod state;
mod write_resolution;

use std::process::Output;

use git2::{BranchType, Oid, RepositoryState};

use crate::error::GitError;
use crate::git_ops::{self, operation_failed};
use crate::model::{FastForwardCheck, MergeMode, OperationOutcome, OperationState};
use crate::repo::RepoSession;
use crate::revision;

/// Keeps git's rebase from opening an editor for a commit message.
const NO_EDITOR: [(&str, &str); 1] = [("GIT_EDITOR", "true")];

impl RepoSession {
    /// The merge, rebase, cherry-pick or revert in progress, if any.
    pub fn operation_state(&self) -> OperationState {
        state::read_state(self.repo())
    }

    /// Merges `branch` (local, else `remote/name`) into HEAD: `Merge` always
    /// records a merge commit, `FastForward` only moves the branch pointer.
    pub fn merge_branch(
        &self,
        branch: &str,
        mode: MergeMode,
    ) -> Result<OperationOutcome, GitError> {
        self.ensure_clean()?;
        self.ensure_born()?;
        self.resolve_branch(branch)?;
        let (git, workdir) = self.git()?;
        let args = match mode {
            MergeMode::Merge => vec!["--no-ff", "--no-edit", branch],
            MergeMode::FastForward => vec!["--ff-only", branch],
        };
        let output = git_ops::run(&git, workdir, "merge", &args, &[])?;
        self.outcome("merge", &output)
    }

    /// Replays HEAD's branch onto `onto` (local, else `remote/name`).
    pub fn rebase_onto(&self, onto: &str) -> Result<OperationOutcome, GitError> {
        self.ensure_clean()?;
        self.ensure_born()?;
        self.resolve_branch(onto)?;
        let (git, workdir) = self.git()?;
        let output = git_ops::run(&git, workdir, "rebase", &[onto], &NO_EDITOR)?;
        self.outcome("rebase", &output)
    }

    /// Applies the change of the commit with full hex `oid` as a new commit.
    pub fn cherry_pick(&self, oid: &str) -> Result<OperationOutcome, GitError> {
        let target = self.single_parent_commit(oid)?;
        let (git, workdir) = self.git()?;
        let output = git_ops::run(&git, workdir, "cherry-pick", &[&target], &[])?;
        self.outcome("cherry-pick", &output)
    }

    /// Records a new commit undoing the commit with full hex `oid`.
    pub fn revert_commit(&self, oid: &str) -> Result<OperationOutcome, GitError> {
        let target = self.single_parent_commit(oid)?;
        let (git, workdir) = self.git()?;
        let output = git_ops::run(&git, workdir, "revert", &["--no-edit", &target], &[])?;
        self.outcome("revert", &output)
    }

    /// Runs `git <verb> --abort` for the operation in progress.
    pub fn abort_operation(&self) -> Result<(), GitError> {
        let verb = match self.repo().state() {
            RepositoryState::Merge => "merge",
            RepositoryState::Rebase
            | RepositoryState::RebaseInteractive
            | RepositoryState::RebaseMerge => "rebase",
            RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
            RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
            RepositoryState::Clean
            | RepositoryState::Bisect
            | RepositoryState::ApplyMailbox
            | RepositoryState::ApplyMailboxOrRebase => return Err(GitError::NoOperation),
        };
        let (git, workdir) = self.git()?;
        let output = git_ops::run(&git, workdir, verb, &["--abort"], &[])?;
        if output.status.success() {
            Ok(())
        } else {
            Err(operation_failed(verb, &output))
        }
    }

    /// Resumes a stopped rebase once every conflict is staged.
    pub fn continue_rebase(&self) -> Result<OperationOutcome, GitError> {
        match self.repo().state() {
            RepositoryState::Rebase
            | RepositoryState::RebaseInteractive
            | RepositoryState::RebaseMerge => {}
            RepositoryState::Clean
            | RepositoryState::Merge
            | RepositoryState::Revert
            | RepositoryState::RevertSequence
            | RepositoryState::CherryPick
            | RepositoryState::CherryPickSequence
            | RepositoryState::Bisect
            | RepositoryState::ApplyMailbox
            | RepositoryState::ApplyMailboxOrRebase => return Err(GitError::NoOperation),
        }
        self.ensure_no_conflicts()?;
        let (git, workdir) = self.git()?;
        let output = git_ops::run(&git, workdir, "rebase", &["--continue"], &NO_EDITOR)?;
        self.outcome("rebase", &output)
    }

    /// Whether HEAD can fast-forward to `branch` (local, else `remote/name`).
    /// A branch whose tip HEAD already contains is `UpToDate`.
    pub fn can_fast_forward(&self, branch: &str) -> Result<FastForwardCheck, GitError> {
        self.ensure_born()?;
        let tip = self.resolve_branch(branch)?;
        let head = self.repo().head()?.peel_to_commit()?.id();
        if tip == head || self.repo().graph_descendant_of(head, tip)? {
            Ok(FastForwardCheck::UpToDate)
        } else if self.repo().graph_descendant_of(tip, head)? {
            Ok(FastForwardCheck::Possible)
        } else {
            Ok(FastForwardCheck::Diverged)
        }
    }

    /// Local name, else `remote/name` → tip oid; `BranchNotFound` otherwise.
    /// A name starting with `-` is refused so it can never reach git's argv
    /// as an option.
    pub(crate) fn resolve_branch(&self, name: &str) -> Result<Oid, GitError> {
        if name.starts_with('-') {
            return Err(GitError::BranchNotFound(name.to_owned()));
        }
        [BranchType::Local, BranchType::Remote]
            .into_iter()
            .find_map(|kind| self.repo().find_branch(name, kind).ok()?.get().target())
            .ok_or_else(|| GitError::BranchNotFound(name.to_owned()))
    }

    /// The preconditions shared by cherry-pick and revert; returns the full
    /// hex of the commit, which is what git is given.
    fn single_parent_commit(&self, oid: &str) -> Result<String, GitError> {
        self.ensure_clean()?;
        self.ensure_born()?;
        let commit = revision::resolve_commit(self.repo(), oid)?;
        let hex = commit.id().to_string();
        if commit.parent_count() > 1 {
            return Err(GitError::MergeCommit(hex));
        }
        Ok(hex)
    }

    /// Exit 0 is `Completed`, or `Stopped` when a rebase is still in progress
    /// (an `edit` step); a non-zero exit that left an operation in
    /// progress with conflicts in the index is `Conflicts`; anything else
    /// (including a hook refusal or an empty pick, which stay in progress)
    /// is `OperationFailed`.
    fn outcome(&self, verb: &str, output: &Output) -> Result<OperationOutcome, GitError> {
        if output.status.success() {
            let in_rebase = matches!(
                self.repo().state(),
                RepositoryState::Rebase
                    | RepositoryState::RebaseInteractive
                    | RepositoryState::RebaseMerge
            );
            return Ok(if in_rebase {
                OperationOutcome::Stopped
            } else {
                OperationOutcome::Completed
            });
        }
        if self.repo().state() != RepositoryState::Clean && self.fresh_index()?.has_conflicts() {
            return Ok(OperationOutcome::Conflicts);
        }
        Err(operation_failed(verb, output))
    }
}
