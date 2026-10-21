//! Shared plumbing of the git CLI writes (merge, rebase, cherry-pick, revert,
//! stash, tag): the runner, the precondition guards and the failure mapping.

use std::path::{Path, PathBuf};
use std::process::Output;

use git2::RepositoryState;

use crate::commit::is_unborn;
use crate::error::GitError;
use crate::git_cli;
use crate::repo::RepoSession;

/// Runs `git -C <workdir> <verb> <args...>` with `env` applied, stdin closed
/// and output captured. A non-zero exit is returned as-is for the caller to
/// classify; failing to spawn `git` is `GitError::Io`.
pub(crate) fn run(
    git: &Path,
    workdir: &Path,
    verb: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<Output, GitError> {
    let mut cmd = git_cli::command(git);
    cmd.arg("-C").arg(workdir).arg(verb).args(args);
    for (key, value) in env {
        cmd.env(key, value);
    }
    Ok(git_cli::capture(&mut cmd)?)
}

/// As [`run`], with `input` on stdin instead of a closed stdin.
pub(crate) fn run_with_input(
    git: &Path,
    workdir: &Path,
    verb: &str,
    args: &[&str],
    input: &[u8],
) -> Result<Output, GitError> {
    let mut cmd = git_cli::command(git);
    cmd.arg("-C").arg(workdir).arg(verb).args(args);
    Ok(git_cli::capture_with_input(&mut cmd, input)?)
}

pub(crate) fn operation_failed(verb: &str, output: &Output) -> GitError {
    GitError::OperationFailed {
        verb: verb.to_owned(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

impl RepoSession {
    /// `OperationInProgress` unless the repository is in its clean state.
    pub(crate) fn ensure_clean(&self) -> Result<(), GitError> {
        if self.repo().state() == RepositoryState::Clean {
            Ok(())
        } else {
            Err(GitError::OperationInProgress)
        }
    }

    /// `UnbornHead` when HEAD has no commit yet.
    pub(crate) fn ensure_born(&self) -> Result<(), GitError> {
        match self.repo().head() {
            Ok(_) => Ok(()),
            Err(e) if is_unborn(&e) => Err(GitError::UnbornHead),
            Err(e) => Err(e.into()),
        }
    }

    /// `UnresolvedConflicts` when the index has conflict entries.
    pub(crate) fn ensure_no_conflicts(&self) -> Result<(), GitError> {
        if self.fresh_index()?.has_conflicts() {
            Err(GitError::UnresolvedConflicts)
        } else {
            Ok(())
        }
    }

    /// The located git executable and the working directory, for a CLI run.
    pub(crate) fn git(&self) -> Result<(PathBuf, &Path), GitError> {
        Ok((git_cli::locate()?, self.workdir()?))
    }
}
