//! Pull = `git fetch <remote>` (after the session lock is released) and then,
//! under the lock again, the existing fast-forward, merge or rebase (spec §3.5).

use std::path::PathBuf;

use git2::Config;

use super::auth::{Credentials, is_http};
use super::remotes::Direction;
use super::run_network;
use crate::error::GitError;
use crate::model::{FastForwardCheck, MergeMode, OperationOutcome, PullMode};
use crate::refs::is_not_found;
use crate::repo::RepoSession;

/// A validated pull of the current branch's upstream.
#[derive(Debug)]
pub struct Pull {
    git: PathBuf,
    workdir: PathBuf,
    /// The local branch HEAD was on when the pull was prepared.
    branch: String,
    remote: String,
    /// Short upstream name for merge / rebase, such as `origin/main`.
    upstream: String,
    urls: Vec<String>,
}

impl Pull {
    /// The URLs this operation talks to, in the order git uses them.
    pub fn urls(&self) -> &[String] {
        &self.urls
    }

    pub fn remote(&self) -> &str {
        &self.remote
    }

    pub fn upstream(&self) -> &str {
        &self.upstream
    }

    /// True when the remote's fetch URL is HTTP(S), so a credential prompt can help.
    pub fn https(&self) -> bool {
        self.urls.iter().any(|u| is_http(u))
    }

    /// Runs `git -C <workdir> fetch <remote>`; a failure has verb `pull`.
    pub fn fetch(&self, creds: Option<&Credentials>) -> Result<(), GitError> {
        run_network(
            &self.git,
            &self.workdir,
            "pull",
            &["fetch", &self.remote],
            &self.urls,
            creds,
        )
    }
}

/// `Some(mode)` when `key` is set: a boolean, or git's `merges` / `interactive` spellings.
fn rebase_setting(config: &Config, key: &str) -> Result<Option<PullMode>, GitError> {
    match config.get_bool(key) {
        Ok(true) => Ok(Some(PullMode::Rebase)),
        Ok(false) => Ok(Some(PullMode::Merge)),
        Err(e) if is_not_found(&e) => Ok(None),
        Err(_) => {
            let value = config.get_string(key).unwrap_or_default();
            let rebase = matches!(value.as_str(), "merges" | "m" | "interactive" | "i");
            Ok(Some(if rebase {
                PullMode::Rebase
            } else {
                PullMode::Merge
            }))
        }
    }
}

impl RepoSession {
    /// `branch.<head>.rebase`, else `pull.rebase`, else `Merge`.
    pub fn pull_default_mode(&self) -> Result<PullMode, GitError> {
        let config = self.repo().config()?;
        if let Ok(branch) = self.head_branch()
            && let Some(mode) = rebase_setting(&config, &format!("branch.{branch}.rebase"))?
        {
            return Ok(mode);
        }
        Ok(rebase_setting(&config, "pull.rebase")?.unwrap_or(PullMode::Merge))
    }

    /// Validates a pull of HEAD's branch from its upstream; the fetch runs
    /// after the session lock is released.
    pub fn prepare_pull(&self) -> Result<Pull, GitError> {
        self.ensure_clean()?;
        let branch = self.head_branch()?;
        let up = self.upstream_of(&branch)?.ok_or(GitError::NoUpstream)?;
        let upstream = up
            .tracking_ref
            .strip_prefix("refs/remotes/")
            .unwrap_or(&up.tracking_ref)
            .to_owned();
        let urls = self
            .used_url(&up.remote, Direction::Fetch)?
            .into_iter()
            .collect();
        let (git, workdir) = self.git()?;
        Ok(Pull {
            git,
            workdir: workdir.to_path_buf(),
            branch,
            remote: up.remote,
            upstream,
            urls,
        })
    }

    /// Integrates the fetched upstream: `Rebase` replays onto it; `Merge`
    /// fast-forwards when it can, records a merge commit when the histories
    /// diverged, and does nothing when HEAD already contains it.
    ///
    /// `OperationInProgress` when HEAD left the branch the pull was prepared
    /// for (checkout is not gated by the network operation), so the upstream
    /// is never integrated into another branch.
    pub fn integrate_pull(
        &self,
        pull: &Pull,
        mode: PullMode,
    ) -> Result<OperationOutcome, GitError> {
        match self.head_branch() {
            Ok(branch) if branch == pull.branch => {}
            Ok(_) | Err(GitError::DetachedHead | GitError::UnbornHead) => {
                return Err(GitError::OperationInProgress);
            }
            Err(e) => return Err(e),
        }
        match mode {
            PullMode::Rebase => self.rebase_onto(&pull.upstream),
            PullMode::Merge => match self.can_fast_forward(&pull.upstream)? {
                FastForwardCheck::UpToDate => Ok(OperationOutcome::Completed),
                FastForwardCheck::Possible => {
                    self.merge_branch(&pull.upstream, MergeMode::FastForward)
                }
                FastForwardCheck::Diverged => self.merge_branch(&pull.upstream, MergeMode::Merge),
            },
        }
    }
}
