//! `git fetch --all` (spec §3.4).

use std::path::PathBuf;

use super::auth::{Credentials, is_http};
use super::remotes::Direction;
use super::run_network;
use crate::error::GitError;
use crate::repo::RepoSession;

/// A validated fetch of every remote, ready to run once the session lock is released.
#[derive(Debug)]
pub struct Fetch {
    git: PathBuf,
    workdir: PathBuf,
    /// Every remote's fetch URL, in remote-name order.
    urls: Vec<String>,
}

impl Fetch {
    /// True when any remote's fetch URL is HTTP(S), so a credential prompt can help.
    pub fn https(&self) -> bool {
        self.urls.iter().any(|u| is_http(u))
    }

    /// Runs `git -C <workdir> fetch --all`; pruning follows the user's `fetch.prune`.
    pub fn run(&self, creds: Option<&Credentials>) -> Result<(), GitError> {
        run_network(
            &self.git,
            &self.workdir,
            "fetch",
            &["fetch", "--all"],
            &self.urls,
            creds,
        )
    }
}

impl RepoSession {
    /// `NoRemotes` when there is nothing to fetch (`git fetch --all` would exit 0 silently).
    pub fn prepare_fetch(&self) -> Result<Fetch, GitError> {
        let names = self.remote_names()?;
        if names.is_empty() {
            return Err(GitError::NoRemotes);
        }
        let mut urls = Vec::new();
        for name in &names {
            urls.extend(self.used_url(name, Direction::Fetch)?);
        }
        let (git, workdir) = self.git()?;
        Ok(Fetch {
            git,
            workdir: workdir.to_path_buf(),
            urls,
        })
    }
}
