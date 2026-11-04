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
use crate::remote::remotes::Direction;
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

/// A local branch's upstream on a configured remote.
#[derive(Debug)]
pub(crate) struct Upstream {
    pub(crate) remote: String,
    /// The branch on the remote (`branch.<b>.merge` without `refs/heads/`).
    pub(crate) branch: String,
    /// The remote-tracking refname, such as `refs/remotes/origin/main`.
    pub(crate) tracking_ref: String,
}

impl RepoSession {
    /// HEAD state, local branches with tracking, and remote branches grouped
    /// by remote.
    pub fn list_branches(&self) -> Result<BranchList, GitError> {
        let repo = self.repo();
        let head = head_state(repo)?;
        // An unreadable worktree registry turns the annotation off rather than
        // failing the list; the branch commands still refuse on it.
        let elsewhere = self.checked_out_elsewhere().unwrap_or_else(|e| {
            eprintln!("worktree registry unreadable; branch annotations off: {e}");
            std::collections::BTreeMap::new()
        });

        let mut local = Vec::new();
        for item in repo.branches(Some(BranchType::Local))? {
            let (branch, _) = item?;
            let name = lossy_name(&branch);
            local.push(LocalBranch {
                worktree: elsewhere.get(&name).cloned(),
                oid: tip(&branch),
                is_head: branch.is_head(),
                tracking: tracking(repo, &branch),
                name,
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
            worktree: None,
        })
    }

    /// Renames a local branch; libgit2 moves HEAD, the HEAD of every other
    /// worktree it can open, and the branch's config section with it. A
    /// branch held by a worktree whose folder is missing is refused: libgit2
    /// cannot update that worktree's HEAD. On a repository whose filesystem
    /// does not distinguish case (`core.ignorecase`), a new name that differs
    /// only by case from another branch is refused with `BranchCaseCollision`;
    /// changing only the case of the branch's own name is allowed.
    pub fn rename_branch(&self, old: &str, new: &str) -> Result<(), GitError> {
        validate_branch_name(new)?;
        let repo = self.repo();
        let mut branch = find_local(repo, old)?;
        refuse_duplicate_branch(repo, new, Some(old))?;
        if let Some(worktree) = self.checked_out_elsewhere()?.remove(old)
            && !worktree.exists()
        {
            return Err(GitError::BranchCheckedOut {
                name: old.to_owned(),
                worktree,
            });
        }
        // NTFS stats the target and finds the branch's own file under the old
        // spelling, so libgit2 refuses a case-only rename unless forced.
        let force = ignores_case(repo) && old != new && old.to_lowercase() == new.to_lowercase();
        branch.rename(new, force)?;
        Ok(())
    }

    /// Deletes a local branch. Without `force` the branch must be merged into
    /// HEAD; the current branch can never be deleted.
    pub fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError> {
        validate_branch_name(name)?;
        let repo = self.repo();
        let mut branch = find_local(repo, name)?;
        if branch.is_head() {
            return Err(GitError::CannotDeleteCurrent(name.to_owned()));
        }
        self.refuse_checked_out_elsewhere(name)?;
        if !force && !is_merged_into_head(repo, &branch)? {
            return Err(GitError::BranchNotMerged(name.to_owned()));
        }
        branch.delete()?;
        Ok(())
    }

    /// Points a local branch at a remote-tracking branch, or clears its
    /// upstream. `upstream` is the short remote-tracking name (`origin/main`);
    /// `None` clears it. A name that is not a remote-tracking branch is
    /// refused with `BranchNotFound` before anything is written.
    pub fn set_branch_upstream(
        &self,
        branch: &str,
        upstream: Option<&str>,
    ) -> Result<(), GitError> {
        let repo = self.repo();
        find_local(repo, branch)?;
        // Both keys are read and written at repository level only: libgit2's
        // set-upstream would prefer a local branch of the same name, and
        // removal can only ever reach repository config.
        let config = repo.config()?;
        match upstream {
            Some(name) => {
                let found = find_branch_exact(repo, name, BranchType::Remote)?;
                let refname = found
                    .get()
                    .name()
                    .ok_or_else(|| GitError::BranchNotFound(name.to_owned()))?
                    .to_owned();
                let (remote, merge) = upstream_mapping(repo, name, &refname)?;
                let mut local = config.open_level(git2::ConfigLevel::Local)?;
                write_upstream(&mut local, branch, &remote, &merge)?;
            }
            None => clear_upstream(&config, branch)?,
        }
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
            worktree: None,
        })
    }

    /// Switches to a local branch through `git switch`.
    pub fn checkout_branch(&self, name: &str) -> Result<(), GitError> {
        validate_branch_name(name)?;
        find_local(self.repo(), name)?;
        self.refuse_checked_out_elsewhere(name)?;
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
        let target = match find_local(self.repo(), name) {
            Ok(_) => {
                self.refuse_checked_out_elsewhere(name)?;
                switch::SwitchTarget::Local(name)
            }
            Err(GitError::BranchNotFound(_)) => {
                refuse_duplicate_branch(self.repo(), name, None)?;
                switch::SwitchTarget::NewTracking {
                    name,
                    upstream: &upstream,
                }
            }
            Err(e) => return Err(e),
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
            self.used_url(remote, Direction::Push)?
                .into_iter()
                .collect(),
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

    /// `RemoteNotFound` unless `remote` is configured. An empty name, or one starting with `-`,
    /// is refused outright: `git push` would read it as a flag, and git itself
    /// never creates one.
    pub(crate) fn ensure_remote(&self, remote: &str) -> Result<(), GitError> {
        if remote.is_empty() || remote.starts_with('-') {
            return Err(GitError::RemoteNotFound(remote.to_owned()));
        }
        match self.repo().find_remote(remote) {
            Ok(_) => Ok(()),
            Err(e) if is_not_found(&e) => Err(GitError::RemoteNotFound(remote.to_owned())),
            Err(e) => Err(e.into()),
        }
    }

    /// The local branch HEAD is on: `UnbornHead` before the first commit,
    /// `DetachedHead` off a branch.
    pub(crate) fn head_branch(&self) -> Result<String, GitError> {
        match head_state(self.repo())? {
            HeadState::Branch { name } => Ok(name),
            HeadState::Detached { .. } => Err(GitError::DetachedHead),
            HeadState::Unborn { .. } => Err(GitError::UnbornHead),
        }
    }

    /// `branch`'s upstream; `None` without one, for an upstream on `.`, or for
    /// a merge ref outside `refs/heads/`. `RemoteNotFound` when the configured
    /// remote no longer exists.
    pub(crate) fn upstream_of(&self, branch: &str) -> Result<Option<Upstream>, GitError> {
        let repo = self.repo();
        let refname = format!("refs/heads/{branch}");
        let remote = match repo.branch_upstream_remote(&refname) {
            Ok(buf) => String::from_utf8_lossy(&buf).into_owned(),
            Err(e) if is_not_found(&e) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if remote == "." {
            return Ok(None);
        }
        // Before `branch_upstream_name`, which reports a missing remote as not found.
        self.ensure_remote(&remote)?;
        // A snapshot: `get_string` on a live config can crash after a failed read (remote/pull.rs).
        let merge = match repo
            .config()?
            .snapshot()?
            .get_string(&format!("branch.{branch}.merge"))
        {
            Ok(m) => m,
            Err(e) if is_not_found(&e) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let Some(remote_branch) = merge.strip_prefix("refs/heads/") else {
            return Ok(None);
        };
        let tracking_ref = match repo.branch_upstream_name(&refname) {
            Ok(buf) => String::from_utf8_lossy(&buf).into_owned(),
            Err(e) if is_not_found(&e) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        Ok(Some(Upstream {
            remote,
            branch: remote_branch.to_owned(),
            tracking_ref,
        }))
    }

    /// `BranchCheckedOut` when another worktree has `name` checked out.
    pub(crate) fn refuse_checked_out_elsewhere(&self, name: &str) -> Result<(), GitError> {
        match self.checked_out_elsewhere()?.remove(name) {
            Some(worktree) => Err(GitError::BranchCheckedOut {
                name: name.to_owned(),
                worktree,
            }),
            None => Ok(()),
        }
    }

    /// The pre-checks for a new branch: a valid, free name and a start point
    /// that resolves to a commit. Returns that commit.
    pub(crate) fn new_branch_target(
        &self,
        name: &str,
        start_point: Option<&str>,
    ) -> Result<Commit<'_>, GitError> {
        validate_branch_name(name)?;
        let repo = self.repo();
        refuse_duplicate_branch(repo, name, None)?;
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

pub(crate) fn head_state(repo: &Repository) -> Result<HeadState, GitError> {
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

/// Finds the local branch called exactly `name`. See `find_branch_exact`.
pub(crate) fn find_local<'r>(repo: &'r Repository, name: &str) -> Result<Branch<'r>, GitError> {
    find_branch_exact(repo, name, BranchType::Local)
}

/// The remote name and `refs/heads/...` merge ref a remote-tracking ref maps
/// back to through its remote's fetch refspec. `name` is the short name used
/// in the error when no single remote maps it.
fn upstream_mapping(
    repo: &Repository,
    name: &str,
    refname: &str,
) -> Result<(String, String), GitError> {
    let unmapped = |detail: &str| GitError::UpstreamUnmapped {
        upstream: name.to_owned(),
        detail: detail.to_owned(),
    };
    let remote_name = match repo.branch_remote_name(refname) {
        Ok(buf) => buf.as_str().map(str::to_owned),
        Err(e) if e.code() == ErrorCode::Ambiguous => {
            return Err(unmapped("more than one remote fetches it"));
        }
        Err(e) if e.code() == ErrorCode::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let Some(remote_name) = remote_name else {
        return Err(unmapped("no remote fetches it"));
    };
    let remote = repo.find_remote(&remote_name)?;
    for spec in remote.refspecs() {
        if spec.direction() == git2::Direction::Fetch && spec.dst_matches(refname) {
            let merge = spec.rtransform(refname)?;
            if let Some(merge) = merge.as_str() {
                return Ok((remote_name, merge.to_owned()));
            }
        }
    }
    Err(unmapped("no remote fetches it"))
}

/// The config operations `write_upstream` and `clear_upstream` need, so the
/// rollback path can be tested without forcing a real write failure.
trait ConfigKeys {
    fn set(&mut self, key: &str, value: &str) -> Result<(), git2::Error>;
    fn remove(&mut self, key: &str) -> Result<(), git2::Error>;
    fn has(&self, key: &str) -> bool;
}

impl ConfigKeys for git2::Config {
    fn set(&mut self, key: &str, value: &str) -> Result<(), git2::Error> {
        self.set_str(key, value)
    }
    fn remove(&mut self, key: &str) -> Result<(), git2::Error> {
        git2::Config::remove(self, key)
    }
    fn has(&self, key: &str) -> bool {
        self.get_entry(key).is_ok()
    }
}

/// Writes `branch.<b>.remote` then `branch.<b>.merge`; when the second write
/// fails the first is removed again so no half-written upstream is left.
fn write_upstream(
    keys: &mut impl ConfigKeys,
    branch: &str,
    remote: &str,
    merge: &str,
) -> Result<(), git2::Error> {
    let remote_key = format!("branch.{branch}.remote");
    keys.set(&remote_key, remote)?;
    if let Err(e) = keys.set(&format!("branch.{branch}.merge"), merge) {
        let _ = keys.remove(&remote_key);
        return Err(e);
    }
    Ok(())
}

/// Removes the repository-level upstream keys of `branch`. Opens the local
/// level itself so keys from global or system config are never touched.
fn clear_upstream(config: &git2::Config, branch: &str) -> Result<(), git2::Error> {
    let mut local = config.open_level(git2::ConfigLevel::Local)?;
    // A gone upstream still has its keys, so remove what exists.
    for key in ["remote", "merge"] {
        let key = format!("branch.{branch}.{key}");
        if local.has(&key) {
            local.remove(&key)?;
        }
    }
    Ok(())
}

/// Finds the branch of `kind` called exactly `name` (`origin/main` for a
/// remote-tracking branch). With `core.ignorecase` set libgit2's
/// `find_branch` matches case-insensitively, so the branches are compared by
/// name instead and `alpha` never resolves to `Alpha`.
fn find_branch_exact<'r>(
    repo: &'r Repository,
    name: &str,
    kind: BranchType,
) -> Result<Branch<'r>, GitError> {
    if ignores_case(repo) {
        for branch in repo.branches(Some(kind))? {
            let (branch, _) = branch?;
            if lossy_name(&branch) == name {
                return Ok(branch);
            }
        }
        return Err(GitError::BranchNotFound(name.to_owned()));
    }
    match repo.find_branch(name, kind) {
        Ok(branch) => Ok(branch),
        Err(e) if is_not_found(&e) => Err(GitError::BranchNotFound(name.to_owned())),
        Err(e) => Err(e.into()),
    }
}

/// Reads `core.ignorecase`; an unopenable config or unreadable value is false.
pub(super) fn ignores_case(repo: &Repository) -> bool {
    repo.config()
        .ok()
        .and_then(|c| c.get_bool("core.ignorecase").ok())
        .unwrap_or(false)
}

/// Refuses `name` when a local branch already has it. Compared by name,
/// never by `find_branch`: on a case-insensitive filesystem that lookup
/// finds `Alpha` when asked for `alpha`. When `core.ignorecase` is true a
/// case-only match (other than `keep`) is a `BranchCaseCollision`.
pub(crate) fn refuse_duplicate_branch(
    repo: &Repository,
    name: &str,
    keep: Option<&str>,
) -> Result<(), GitError> {
    let ignorecase = ignores_case(repo);
    let folded = name.to_lowercase();
    let mut collision = None;
    for branch in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = branch?;
        let existing = lossy_name(&branch);
        if existing == name {
            return Err(GitError::BranchExists(name.to_owned()));
        }
        if collision.is_none()
            && ignorecase
            && Some(existing.as_str()) != keep
            && existing.to_lowercase() == folded
        {
            collision = Some(existing);
        }
    }
    match collision {
        Some(existing) => Err(GitError::BranchCaseCollision {
            requested: name.to_owned(),
            existing,
        }),
        None => Ok(()),
    }
}

pub(crate) fn is_not_found(e: &git2::Error) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Records writes; fails `set` for `fail_key`.
    struct FakeKeys {
        fail_key: &'static str,
        set: Vec<(String, String)>,
        removed: Vec<String>,
    }

    impl ConfigKeys for FakeKeys {
        fn set(&mut self, key: &str, value: &str) -> Result<(), git2::Error> {
            if key.ends_with(self.fail_key) {
                return Err(git2::Error::from_str("disk full"));
            }
            self.set.push((key.to_owned(), value.to_owned()));
            Ok(())
        }
        fn remove(&mut self, key: &str) -> Result<(), git2::Error> {
            self.removed.push(key.to_owned());
            Ok(())
        }
        fn has(&self, key: &str) -> bool {
            self.set.iter().any(|(k, _)| k == key)
        }
    }

    #[test]
    fn write_upstream_sets_remote_then_merge() {
        let mut keys = FakeKeys {
            fail_key: "never",
            set: vec![],
            removed: vec![],
        };
        write_upstream(&mut keys, "topic", "origin", "refs/heads/main").unwrap();
        assert_eq!(
            keys.set,
            vec![
                ("branch.topic.remote".to_owned(), "origin".to_owned()),
                (
                    "branch.topic.merge".to_owned(),
                    "refs/heads/main".to_owned()
                ),
            ]
        );
        assert!(keys.removed.is_empty());
    }

    #[test]
    fn write_upstream_removes_remote_when_merge_fails() {
        let mut keys = FakeKeys {
            fail_key: ".merge",
            set: vec![],
            removed: vec![],
        };
        let err = write_upstream(&mut keys, "topic", "origin", "refs/heads/main").unwrap_err();
        assert_eq!(err.message(), "disk full");
        assert_eq!(keys.removed, vec!["branch.topic.remote".to_owned()]);
    }

    fn two_level_config(dir: &std::path::Path, global: &str, local: &str) -> git2::Config {
        let g = dir.join("global");
        let l = dir.join("local");
        std::fs::write(&g, global).unwrap();
        std::fs::write(&l, local).unwrap();
        let mut config = git2::Config::new().unwrap();
        config
            .add_file(&g, git2::ConfigLevel::Global, false)
            .unwrap();
        config
            .add_file(&l, git2::ConfigLevel::Local, false)
            .unwrap();
        config
    }

    #[test]
    fn clear_upstream_leaves_global_keys_alone() {
        let dir = tempfile::tempdir().unwrap();
        let config = two_level_config(
            dir.path(),
            "[branch \"probe\"]\n\tremote = origin\n\tmerge = refs/heads/probe\n",
            "",
        );
        clear_upstream(&config, "probe").unwrap();
        let global = std::fs::read_to_string(dir.path().join("global")).unwrap();
        assert!(global.contains("remote = origin"), "{global}");
        assert!(global.contains("merge = refs/heads/probe"), "{global}");
    }

    #[test]
    fn clear_upstream_removes_local_keys_only() {
        let dir = tempfile::tempdir().unwrap();
        let config = two_level_config(
            dir.path(),
            "[branch \"probe\"]\n\tremote = elsewhere\n",
            "[branch \"probe\"]\n\tremote = origin\n\tmerge = refs/heads/probe\n",
        );
        clear_upstream(&config, "probe").unwrap();
        let local = std::fs::read_to_string(dir.path().join("local")).unwrap();
        assert!(!local.contains("remote ="), "{local}");
        assert!(!local.contains("merge ="), "{local}");
        let global = std::fs::read_to_string(dir.path().join("global")).unwrap();
        assert!(global.contains("remote = elsewhere"), "{global}");
    }
}
