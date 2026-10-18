//! Deleting a branch on a remote through `git push --delete` (ADR 0001).

use std::path::{Path, PathBuf};

use crate::error::GitError;
use crate::git_cli;

/// A validated remote branch deletion, ready to run once the session lock is
/// released. Only `RepoSession::prepare_remote_delete` builds one, so only
/// validated names ever reach the command line.
#[derive(Debug)]
pub struct PushDelete {
    git: PathBuf,
    workdir: PathBuf,
    remote: String,
    name: String,
}

impl PushDelete {
    pub(crate) fn new(git: PathBuf, workdir: PathBuf, remote: String, name: String) -> Self {
        Self {
            git,
            workdir,
            remote,
            name,
        }
    }

    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    pub fn remote(&self) -> &str {
        &self.remote
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Runs `git -C <workdir> push <remote> --delete heads/<name>`.
    ///
    /// `heads/<name>` never matches a remote tag called `<name>`, so a stale
    /// remote-tracking ref cannot lead to deleting a tag. It is deliberately
    /// not the full `refs/heads/<name>`: git sends a full refname to the
    /// remote unchecked and reports success when the branch is already gone,
    /// while `heads/<name>` must match an advertised ref, so a missing branch
    /// fails with "remote ref does not exist". A non-zero exit is
    /// `PushFailed` carrying git's output.
    pub fn run(&self) -> Result<(), GitError> {
        let mut cmd = git_cli::command(&self.git);
        cmd.arg("-C")
            .arg(&self.workdir)
            .arg("push")
            .arg(&self.remote)
            .arg("--delete")
            .arg(format!("heads/{}", self.name));
        let output = git_cli::capture(&mut cmd)?;
        if !output.status.success() {
            return Err(GitError::PushFailed {
                code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
        Ok(())
    }
}
