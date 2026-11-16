//! Deleting a branch on a remote through `git push --delete` (ADR 0001).

use std::path::{Path, PathBuf};

use super::auth::Credentials;
use super::run_push;
use crate::error::GitError;

/// A validated remote branch deletion of one or more branches, ready to run once the session lock is
/// released. Only `RepoSession::prepare_remote_delete` builds one, so only
/// validated names ever reach the command line.
#[derive(Debug)]
pub struct PushDelete {
    git: PathBuf,
    workdir: PathBuf,
    remote: String,
    names: Vec<String>,
    /// The push URL git uses, empty when the remote has none.
    urls: Vec<String>,
}

impl PushDelete {
    /// The URLs this operation talks to, in the order git uses them.
    pub fn urls(&self) -> &[String] {
        &self.urls
    }

    pub(crate) fn new(
        git: PathBuf,
        workdir: PathBuf,
        remote: String,
        names: Vec<String>,
        urls: Vec<String>,
    ) -> Self {
        Self {
            git,
            workdir,
            remote,
            names,
            urls,
        }
    }

    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    pub fn remote(&self) -> &str {
        &self.remote
    }

    pub fn names(&self) -> &[String] {
        &self.names
    }

    /// Runs `git -C <workdir> push <remote> --delete heads/<a> heads/<b> ...`,
    /// one `heads/<name>` per name in a single push.
    ///
    /// `heads/<name>` never matches a remote tag called `<name>`, so a stale
    /// remote-tracking ref cannot lead to deleting a tag. It is deliberately
    /// not the full `refs/heads/<name>`: git sends a full refname to the
    /// remote unchecked and reports success when the branch is already gone,
    /// while `heads/<name>` must match an advertised ref, so a missing branch
    /// fails with "remote ref does not exist". That holds for every name: git
    /// refuses the whole push before sending anything when one name is stale.
    /// A non-zero exit is `NetworkFailed` carrying git's output.
    pub fn run(&self, creds: Option<&Credentials>) -> Result<(), GitError> {
        let mut args = vec!["--delete".to_string()];
        args.extend(self.names.iter().map(|n| format!("heads/{n}")));
        run_push(
            &self.git,
            &self.workdir,
            &self.remote,
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
            &self.urls,
            creds,
        )
    }
}
