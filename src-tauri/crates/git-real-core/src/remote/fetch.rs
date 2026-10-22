//! `git fetch --all` (spec §3.4), or `git fetch <remote>` for one remote.

use std::path::PathBuf;

use super::auth::{Credentials, is_http};
use super::remotes::Direction;
use super::run_network;
use crate::error::GitError;
use crate::repo::RepoSession;

/// A validated fetch of every remote, or of one, ready to run once the session lock is released.
#[derive(Debug)]
pub struct Fetch {
    git: PathBuf,
    workdir: PathBuf,
    /// The single remote to fetch; `None` fetches every remote.
    remote: Option<String>,
    /// The fetch URLs of the remotes fetched, in remote-name order.
    urls: Vec<String>,
}

impl Fetch {
    /// The URLs this operation talks to, in the order git uses them.
    pub fn urls(&self) -> &[String] {
        &self.urls
    }

    /// True when any fetched remote's URL is HTTP(S), so a credential prompt can help.
    pub fn https(&self) -> bool {
        self.urls.iter().any(|u| is_http(u))
    }

    /// Runs `git -C <workdir> fetch --all` (or `fetch <remote>`); pruning follows the user's
    /// `fetch.prune`.
    pub fn run(&self, creds: Option<&Credentials>) -> Result<(), GitError> {
        let target = self.remote.as_deref().unwrap_or("--all");
        run_network(
            &self.git,
            &self.workdir,
            "fetch",
            &["fetch", target],
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
        self.fetch(None, urls)
    }

    /// A fetch of the remote `name` only; `RemoteNotFound` when no such remote exists (including
    /// an empty name or one starting with `-`).
    pub fn prepare_fetch_remote(&self, name: &str) -> Result<Fetch, GitError> {
        self.ensure_remote(name)?;
        let urls = self.used_url(name, Direction::Fetch)?.into_iter().collect();
        self.fetch(Some(name.to_owned()), urls)
    }

    fn fetch(&self, remote: Option<String>, urls: Vec<String>) -> Result<Fetch, GitError> {
        let (git, workdir) = self.git()?;
        Ok(Fetch {
            git,
            workdir: workdir.to_path_buf(),
            remote,
            urls,
        })
    }
}
