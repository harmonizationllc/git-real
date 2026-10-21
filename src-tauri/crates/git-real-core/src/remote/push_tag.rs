//! Pushing a tag to a remote and deleting it there, through `git push`
//! (ADR 0001). Only `RepoSession::prepare_tag_push` and
//! `prepare_remote_tag_delete` build these, so only validated names reach
//! the command line.

use std::path::{Path, PathBuf};

use super::run_push;
use crate::error::GitError;

/// A validated tag push, ready to run once the session lock is released.
#[derive(Debug)]
pub struct TagPush {
    git: PathBuf,
    workdir: PathBuf,
    remote: String,
    name: String,
}

impl TagPush {
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

    /// Runs `git -C <workdir> push <remote> refs/tags/<name>`. The full refname
    /// can never be read as a branch; git rejects it when the remote already
    /// has the tag at another object ("already exists").
    pub fn run(&self) -> Result<(), GitError> {
        run_push(
            &self.git,
            &self.workdir,
            &self.remote,
            &[&format!("refs/tags/{}", self.name)],
        )
    }
}

/// A validated remote tag deletion, ready to run once the session lock is
/// released.
#[derive(Debug)]
pub struct TagPushDelete {
    git: PathBuf,
    workdir: PathBuf,
    remote: String,
    name: String,
}

impl TagPushDelete {
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

    /// Runs `git -C <workdir> push <remote> --delete tags/<name>`. `tags/<name>`
    /// must match a tag the remote advertises, so it never hits a branch of the
    /// same name, and a tag the remote lacks fails with "remote ref does not
    /// exist" instead of reporting success (as `heads/` does for branches).
    pub fn run(&self) -> Result<(), GitError> {
        run_push(
            &self.git,
            &self.workdir,
            &self.remote,
            &["--delete", &format!("tags/{}", self.name)],
        )
    }
}
