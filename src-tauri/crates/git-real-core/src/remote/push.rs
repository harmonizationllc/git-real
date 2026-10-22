//! `git push` of the current branch to its upstream or a new one, optionally
//! with `--force-with-lease` (spec §3.6).

use std::path::PathBuf;

use super::auth::{Credentials, is_http};
use super::remotes::Direction;
use super::run_network;
use crate::error::GitError;
use crate::model::PushTarget;
use crate::refs::validate_branch_name;
use crate::repo::RepoSession;

/// A validated push of HEAD's branch, ready to run once the session lock is released.
#[derive(Debug)]
pub struct Push {
    git: PathBuf,
    workdir: PathBuf,
    remote: String,
    /// The local branch being pushed, so the pushed commit is that branch's even if HEAD moves.
    local: String,
    /// The branch on the remote.
    branch: String,
    /// `refs/heads/<branch>:<oid>`, `<oid>` empty when there was no tracking ref.
    lease: Option<String>,
    set_upstream: bool,
    urls: Vec<String>,
}

impl Push {
    /// The URLs this operation talks to, in the order git uses them.
    pub fn urls(&self) -> &[String] {
        &self.urls
    }

    pub fn remote(&self) -> &str {
        &self.remote
    }

    pub fn branch(&self) -> &str {
        &self.branch
    }

    pub fn lease(&self) -> Option<&str> {
        self.lease.as_deref()
    }

    /// True when the push URL is HTTP(S), so a credential prompt can help.
    pub fn https(&self) -> bool {
        self.urls.iter().any(|u| is_http(u))
    }

    /// `git push [-u] [--force-with-lease=<lease>] <remote> refs/heads/<local>:refs/heads/<branch>`.
    pub fn run(&self, creds: Option<&Credentials>) -> Result<(), GitError> {
        let lease = self
            .lease
            .as_ref()
            .map(|l| format!("--force-with-lease={l}"));
        let refspec = format!("refs/heads/{}:refs/heads/{}", self.local, self.branch);
        let mut args = vec!["push"];
        if self.set_upstream {
            args.push("-u");
        }
        if let Some(lease) = &lease {
            args.push(lease);
        }
        args.extend([self.remote.as_str(), refspec.as_str()]);
        run_network(&self.git, &self.workdir, "push", &args, &self.urls, creds)
    }
}

impl RepoSession {
    /// Validates a push of HEAD's branch to `target`. With `force`, the lease
    /// expects the remote-tracking ref as it is now. `OperationInProgress` when
    /// HEAD is not on `expected_branch`, the branch the caller saw and confirmed.
    pub fn prepare_push(
        &self,
        target: &PushTarget,
        force: bool,
        expected_branch: &str,
    ) -> Result<Push, GitError> {
        let local = self.head_branch()?;
        if local != expected_branch {
            return Err(GitError::OperationInProgress);
        }
        let (remote, branch, tracking_ref, set_upstream) = match target {
            PushTarget::Upstream => {
                let up = self.upstream_of(&local)?.ok_or(GitError::NoUpstream)?;
                (up.remote, up.branch, up.tracking_ref, false)
            }
            PushTarget::SetUpstream { remote, branch } => {
                self.ensure_remote(remote)?;
                validate_branch_name(branch)?;
                (
                    remote.clone(),
                    branch.clone(),
                    format!("refs/remotes/{remote}/{branch}"),
                    true,
                )
            }
        };
        // A missing tracking ref leases "expect absent": git refuses to replace a branch we never saw.
        let lease = force.then(|| {
            let oid = self
                .repo()
                .refname_to_id(&tracking_ref)
                .map(|o| o.to_string())
                .unwrap_or_default();
            format!("refs/heads/{branch}:{oid}")
        });
        let urls = self
            .used_url(&remote, Direction::Push)?
            .into_iter()
            .collect();
        let (git, workdir) = self.git()?;
        Ok(Push {
            git,
            workdir: workdir.to_path_buf(),
            remote,
            local,
            branch,
            lease,
            set_upstream,
            urls,
        })
    }
}
