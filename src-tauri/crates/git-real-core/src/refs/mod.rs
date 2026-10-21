//! Branch listing and local branch operations through git2; checkout and
//! remote deletion shell out (see [`switch`] and [`crate::remote::push_delete`]).
//! Tags live in the private `tags` child module.

pub(crate) mod switch;
mod tags;

use git2::{Branch, BranchType, Commit, ErrorCode, Repository};

use crate::error::GitError;
use crate::git_cli;
use crate::model::{BranchList, HeadState, LocalBranch, RemoteBranch, RemoteGroup, Tracking};
use crate::remote::push_delete::PushDelete;
use crate::repo::RepoSession;

/// Accepts names git accepts for a branch that can never be read as a
/// command-line flag.
pub fn validate_branch_name(name: &str) -> Result<(), GitError> {
    match Branch::name_is_valid(name) {
        Ok(true) if !name.starts_with('-') => Ok(()),
        Ok(_) => Err(GitError::InvalidBranchName(name.to_owned())),
        Err(e) => Err(e.into()),
    }
}

impl RepoSession {
    /// HEAD state, local branches with tracking, and remote branches grouped
    /// by remote.
    pub fn list_branches(&self) -> Result<BranchList, GitError> {
        let repo = self.repo();
        let head = head_state(repo)?;

        let mut local = Vec::new();
        for item in repo.branches(Some(BranchType::Local))? {
            let (branch, _) = item?;
            local.push(LocalBranch {
                name: lossy_name(&branch),
                oid: tip(&branch),
                is_head: branch.is_head(),
                tracking: tracking(repo, &branch),
            });
        }
        local.sort_by(|a, b| a.name.cmp(&b.name));

        let mut remotes: Vec<RemoteGroup> = Vec::new();
        for item in repo.branches(Some(BranchType::Remote))? {
            let (branch, _) = item?;
            if branch.get().symbolic_target_bytes().is_some() {
                continue; // `<remote>/HEAD`
            }
            let Some(refname) = branch.get().name() else {
                continue;
            };
            // libgit2 matches the ref against each remote's fetch refspec,
            // so a remote whose own name contains `/` splits correctly.
            let remote = match repo.branch_remote_name(refname) {
                Ok(buf) => String::from_utf8_lossy(&buf).into_owned(),
                Err(e) if is_not_found(&e) => continue,
                Err(e) => return Err(e.into()),
            };
            let full = lossy_name(&branch);
            let name = full
                .strip_prefix(&format!("{remote}/"))
                .unwrap_or(&full)
                .to_owned();
            let entry = RemoteBranch {
                remote: remote.clone(),
                name,
                oid: tip(&branch),
            };
            match remotes.iter_mut().find(|g| g.remote == remote) {
                Some(group) => group.branches.push(entry),
                None => remotes.push(RemoteGroup {
                    remote,
                    branches: vec![entry],
                }),
            }
        }
        remotes.sort_by(|a, b| a.remote.cmp(&b.remote));
        for group in &mut remotes {
            group.branches.sort_by(|a, b| a.name.cmp(&b.name));
        }

        Ok(BranchList {
            head,
            local,
            remotes,
        })
    }

    /// Creates `name` at `start_point` (any revision) or at HEAD. HEAD stays
    /// where it is.
    pub fn create_branch(
        &self,
        name: &str,
        start_point: Option<&str>,
    ) -> Result<LocalBranch, GitError> {
        let commit = self.new_branch_target(name, start_point)?;
        self.repo().branch(name, &commit, false)?;
        Ok(LocalBranch {
            name: name.to_owned(),
            oid: commit.id().to_string(),
            is_head: false,
            tracking: None,
        })
    }

    /// Renames a local branch; libgit2 moves HEAD and the branch's config
    /// section with it.
    pub fn rename_branch(&self, old: &str, new: &str) -> Result<(), GitError> {
        validate_branch_name(new)?;
        let repo = self.repo();
        let mut branch = find_local(repo, old)?;
        if repo.find_branch(new, BranchType::Local).is_ok() {
            return Err(GitError::BranchExists(new.to_owned()));
        }
        branch.rename(new, false)?;
        Ok(())
    }

    /// Deletes a local branch. Without `force` the branch must be merged into
    /// HEAD; the current branch can never be deleted.
    pub fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError> {
        let repo = self.repo();
        let mut branch = find_local(repo, name)?;
        if branch.is_head() {
            return Err(GitError::CannotDeleteCurrent(name.to_owned()));
        }
        if !force && !is_merged_into_head(repo, &branch)? {
            return Err(GitError::BranchNotMerged(name.to_owned()));
        }
        branch.delete()?;
        Ok(())
    }

    /// Creates `name` and switches to it, all or nothing: when git refuses the
    /// switch (a dirty tree, a hook) the new branch is deleted again and the
    /// `CheckoutFailed` error is returned.
    pub fn create_and_checkout_branch(
        &self,
        name: &str,
        start_point: Option<&str>,
    ) -> Result<LocalBranch, GitError> {
        let commit = self.new_branch_target(name, start_point)?;
        let git = git_cli::locate()?;
        let workdir = self.workdir()?;
        let repo = self.repo();
        let mut branch = repo.branch(name, &commit, false)?;
        if let Err(e) = switch::run(&git, workdir, switch::SwitchTarget::Local(name)) {
            // The switch error is the one worth reporting.
            let _ = branch.delete();
            return Err(e);
        }
        Ok(LocalBranch {
            name: name.to_owned(),
            oid: commit.id().to_string(),
            is_head: true,
            tracking: None,
        })
    }

    /// Switches to a local branch through `git switch`.
    pub fn checkout_branch(&self, name: &str) -> Result<(), GitError> {
        validate_branch_name(name)?;
        find_local(self.repo(), name)?;
        let git = git_cli::locate()?;
        switch::run(&git, self.workdir()?, switch::SwitchTarget::Local(name))
    }

    /// Checks out `<remote>/<name>`: switches to the local branch `name` when
    /// one exists (whatever its upstream), otherwise creates it tracking the
    /// remote branch.
    pub fn checkout_remote_branch(&self, remote: &str, name: &str) -> Result<(), GitError> {
        let upstream = self.remote_branch_ref(remote, name)?;
        let git = git_cli::locate()?;
        let workdir = self.workdir()?;
        let target = if self.repo().find_branch(name, BranchType::Local).is_ok() {
            switch::SwitchTarget::Local(name)
        } else {
            switch::SwitchTarget::NewTracking {
                name,
                upstream: &upstream,
            }
        };
        switch::run(&git, workdir, target)
    }

    /// Validates a remote branch deletion and returns the push to run after
    /// the session lock is released.
    pub fn prepare_remote_delete(&self, remote: &str, name: &str) -> Result<PushDelete, GitError> {
        self.remote_branch_ref(remote, name)?;
        Ok(PushDelete::new(
            git_cli::locate()?,
            self.workdir()?.to_path_buf(),
            remote.to_owned(),
            name.to_owned(),
        ))
    }

    /// Checks that `remote` exists, validates `name` and that `<remote>/<name>`
    /// is a remote branch. Returns its full refname, so git can never resolve
    /// it to a local branch that happens to be called `<remote>/<name>`.
    fn remote_branch_ref(&self, remote: &str, name: &str) -> Result<String, GitError> {
        self.ensure_remote(remote)?;
        validate_branch_name(name)?;
        let short = format!("{remote}/{name}");
        match self.repo().find_branch(&short, BranchType::Remote) {
            Ok(_) => Ok(format!("refs/remotes/{short}")),
            Err(e) if is_not_found(&e) => Err(GitError::BranchNotFound(short)),
            Err(e) => Err(e.into()),
        }
    }

    /// `RemoteNotFound` unless `remote` is configured. A name starting with `-`
    /// is refused outright: `git push` would read it as a flag, and git itself
    /// never creates one.
    fn ensure_remote(&self, remote: &str) -> Result<(), GitError> {
        if remote.starts_with('-') {
            return Err(GitError::RemoteNotFound(remote.to_owned()));
        }
        match self.repo().find_remote(remote) {
            Ok(_) => Ok(()),
            Err(e) if is_not_found(&e) => Err(GitError::RemoteNotFound(remote.to_owned())),
            Err(e) => Err(e.into()),
        }
    }

    /// The pre-checks for a new branch: a valid, free name and a start point
    /// that resolves to a commit. Returns that commit.
    fn new_branch_target(
        &self,
        name: &str,
        start_point: Option<&str>,
    ) -> Result<Commit<'_>, GitError> {
        validate_branch_name(name)?;
        let repo = self.repo();
        if repo.find_branch(name, BranchType::Local).is_ok() {
            return Err(GitError::BranchExists(name.to_owned()));
        }
        match start_point {
            None => match repo.head() {
                Ok(head) => Ok(head.peel_to_commit()?),
                Err(e) if e.code() == ErrorCode::UnbornBranch => Err(GitError::UnbornHead),
                Err(e) => Err(e.into()),
            },
            Some(spec) => match repo.revparse_single(spec) {
                Ok(object) => Ok(object.peel_to_commit()?),
                Err(e) if is_not_found(&e) => Err(GitError::RevisionNotFound(spec.to_owned())),
                Err(e) => Err(e.into()),
            },
        }
    }
}

fn head_state(repo: &Repository) -> Result<HeadState, GitError> {
    match repo.head() {
        Ok(head) if head.is_branch() => Ok(HeadState::Branch {
            name: String::from_utf8_lossy(head.shorthand_bytes()).into_owned(),
        }),
        Ok(head) => Ok(HeadState::Detached {
            oid: head.target().map(|o| o.to_string()).unwrap_or_default(),
        }),
        Err(e) if e.code() == ErrorCode::UnbornBranch => {
            let head = repo.find_reference("HEAD")?;
            let target = String::from_utf8_lossy(head.symbolic_target_bytes().unwrap_or_default());
            let name = target.strip_prefix("refs/heads/").unwrap_or(&target);
            Ok(HeadState::Unborn {
                name: name.to_owned(),
            })
        }
        Err(e) => Err(e.into()),
    }
}

/// Upstream name and ahead/behind counts for a local branch.
///
/// A configured upstream whose ref is gone reports `None` counts. Anything
/// else that fails (odd config, a branch whose configured remote no longer
/// exists, which libgit2 reports as not found) reads as untracked, so one
/// branch can never fail the whole listing.
fn tracking(repo: &Repository, branch: &Branch) -> Option<Tracking> {
    let refname = branch.get().name()?;
    let upstream_ref = repo.branch_upstream_name(refname).ok()?;
    let upstream_ref = upstream_ref.as_str()?;
    let upstream = upstream_ref
        .strip_prefix("refs/remotes/")
        .or_else(|| upstream_ref.strip_prefix("refs/heads/"))
        .unwrap_or(upstream_ref)
        .to_owned();
    match branch.upstream() {
        Ok(up) => {
            let (ahead, behind) = repo
                .graph_ahead_behind(branch.get().target()?, up.get().target()?)
                .ok()?;
            Some(Tracking {
                upstream,
                ahead: Some(count(ahead)),
                behind: Some(count(behind)),
            })
        }
        Err(e) if is_not_found(&e) => Some(Tracking {
            upstream,
            ahead: None,
            behind: None,
        }),
        Err(_) => None,
    }
}

/// True when HEAD's commit is the branch tip or descends from it. With an
/// unborn HEAD there is nothing to be merged into, so it is false.
fn is_merged_into_head(repo: &Repository, branch: &Branch) -> Result<bool, GitError> {
    let head = match repo.head() {
        Ok(head) => head.target(),
        Err(e) if e.code() == ErrorCode::UnbornBranch => None,
        Err(e) => return Err(e.into()),
    };
    let (Some(head), Some(tip)) = (head, branch.get().target()) else {
        return Ok(false);
    };
    Ok(head == tip || repo.graph_descendant_of(head, tip)?)
}

fn find_local<'r>(repo: &'r Repository, name: &str) -> Result<Branch<'r>, GitError> {
    match repo.find_branch(name, BranchType::Local) {
        Ok(branch) => Ok(branch),
        Err(e) if is_not_found(&e) => Err(GitError::BranchNotFound(name.to_owned())),
        Err(e) => Err(e.into()),
    }
}

fn is_not_found(e: &git2::Error) -> bool {
    e.code() == ErrorCode::NotFound
}

fn lossy_name(branch: &Branch) -> String {
    String::from_utf8_lossy(branch.name_bytes().unwrap_or_default()).into_owned()
}

fn tip(branch: &Branch) -> String {
    branch
        .get()
        .target()
        .map(|o| o.to_string())
        .unwrap_or_default()
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}
