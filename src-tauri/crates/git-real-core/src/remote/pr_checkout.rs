//! The git side of checking out a pull request (GR-13a): fetch one ref into `FETCH_HEAD`
//! (`git fetch --no-tags <source> <refspec>`), then create, fast-forward or reset `pr/<n>` at
//! it. Same-repository pull requests use the plain fetch and branch checkout instead.
//!
//! The session lock is released while the fetch runs, so another fetch can overwrite
//! `FETCH_HEAD` in between; [`RepoSession::checkout_fetch_head`] uses only the entry of the
//! refspec it fetched.

use std::path::PathBuf;

use git2::{BranchType, Oid, Reference};

use super::auth::{Credentials, origin_of};
use super::remotes::Direction;
use super::run_network;
use crate::error::GitError;
use crate::model::CheckoutPrOutcome;
use crate::refs::is_not_found;
use crate::refs::switch::{self, SwitchTarget};
use crate::repo::RepoSession;

/// A validated fetch of one ref, ready to run once the session lock is released.
#[derive(Debug)]
pub struct RefFetch {
    git: PathBuf,
    workdir: PathBuf,
    /// A remote name or an `https://` URL.
    source: String,
    /// A full refname such as `refs/pull/7/head`, without a destination.
    refspec: String,
    urls: Vec<String>,
}

impl RefFetch {
    /// The URL fetched from.
    pub fn urls(&self) -> &[String] {
        &self.urls
    }

    /// Runs `git -C <workdir> fetch --no-tags <source> <refspec>`, so a fork's tags never land
    /// in the repository.
    pub fn run(&self, creds: Option<&Credentials>) -> Result<(), GitError> {
        run_network(
            &self.git,
            &self.workdir,
            "fetch",
            &["fetch", "--no-tags", &self.source, &self.refspec],
            &self.urls,
            creds,
        )
    }
}

impl RepoSession {
    /// `source` is a configured remote (`RemoteNotFound` otherwise) or an `https://` URL
    /// (`InvalidRemoteUrl` for any other scheme, whitespace or control characters).
    /// `refspec` must be a valid `refs/...` name with no `+`, `:` or whitespace, else
    /// `InvalidBranchName`.
    pub fn prepare_ref_fetch(&self, source: &str, refspec: &str) -> Result<RefFetch, GitError> {
        let urls = if source.contains("://") {
            let clean = !source.chars().any(|c| c.is_whitespace() || c.is_control());
            if !(clean && source.starts_with("https://") && origin_of(source).is_some()) {
                return Err(GitError::InvalidRemoteUrl(source.to_owned()));
            }
            vec![source.to_owned()]
        } else {
            self.ensure_remote(source)?;
            self.used_url(source, Direction::Fetch)?
                .into_iter()
                .collect()
        };
        let plain = !refspec.contains([':', '+']) && !refspec.chars().any(char::is_whitespace);
        if !(plain && refspec.starts_with("refs/") && Reference::is_valid_name(refspec)) {
            return Err(GitError::InvalidBranchName(refspec.to_owned()));
        }
        let (git, workdir) = self.git()?;
        Ok(RefFetch {
            git,
            workdir: workdir.to_path_buf(),
            source: source.to_owned(),
            refspec: refspec.to_owned(),
            urls,
        })
    }

    /// Checks out `pr/<number>` at the commit `fetch` left in `FETCH_HEAD`: switches to it when
    /// it already contains that commit, creates or fast-forwards it otherwise, and resets it only
    /// with `reset` (else `NeedsReset`, nothing changed). `RevisionNotFound("FETCH_HEAD")` when
    /// `FETCH_HEAD` holds no entry for `fetch`'s refspec.
    pub fn checkout_fetch_head(
        &self,
        fetch: &RefFetch,
        number: u64,
        reset: bool,
    ) -> Result<CheckoutPrOutcome, GitError> {
        let repo = self.repo();
        let oid = fetched_oid(repo, &fetch.refspec)?
            .ok_or_else(|| GitError::RevisionNotFound("FETCH_HEAD".to_owned()))?;
        let name = format!("pr/{number}");
        let current = match repo.find_branch(&name, BranchType::Local) {
            Ok(branch) => branch.get().target(),
            Err(e) if is_not_found(&e) => None,
            Err(e) => return Err(e.into()),
        };
        let (git, workdir) = self.git()?;
        let hex = oid.to_string();
        let target = match current {
            Some(cur) if cur == oid || repo.graph_descendant_of(cur, oid)? => {
                SwitchTarget::Local(&name)
            }
            Some(cur) if !reset && !repo.graph_descendant_of(oid, cur)? => {
                return Ok(CheckoutPrOutcome::NeedsReset { branch: name });
            }
            _ => SwitchTarget::Reset {
                name: &name,
                oid: &hex,
            },
        };
        switch::run(&git, workdir, target)?;
        Ok(CheckoutPrOutcome::CheckedOut { branch: name })
    }
}

/// The oid of the first `FETCH_HEAD` entry for `refspec`; `None` without one (or without a
/// `FETCH_HEAD` at all). libgit2 rebuilds `refs/heads/<x>` from git's `branch 'x'` lines.
fn fetched_oid(repo: &git2::Repository, refspec: &str) -> Result<Option<Oid>, GitError> {
    let mut found = None;
    let walked = repo.fetchhead_foreach(|ref_name, _url, oid, _is_merge| {
        if found.is_none() && ref_name == refspec {
            found = Some(*oid);
        }
        true
    });
    match walked {
        Ok(()) => Ok(found),
        Err(e) if is_not_found(&e) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
