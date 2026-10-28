//! Linked worktrees: the list is read with git2 (the admin `HEAD` file stands
//! in when a worktree cannot be opened); add, remove and prune run
//! `git worktree` from this session's own workdir, so git resolves the common
//! dir itself and its checks and messages match the command line (ADR 0001).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use git2::{BranchType, Repository, StatusOptions, WorktreeLockStatus};

use crate::error::GitError;
use crate::git_ops::{self, operation_failed};
use crate::model::{HeadState, LinkedWorktree, PrunedWorktrees, WorktreeBranch};
use crate::refs::{find_local, head_state, validate_branch_name};
use crate::repo::RepoSession;

impl RepoSession {
    /// The main worktree first (when the repository has one), then the linked
    /// worktrees sorted by path. Empty for a bare session.
    pub fn list_linked_worktrees(&self) -> Result<Vec<LinkedWorktree>, GitError> {
        let repo = self.repo();
        if repo.is_bare() {
            return Ok(Vec::new());
        }
        let common = repo.commondir();
        let mut linked = Vec::new();
        for name in repo.worktrees()?.iter().flatten() {
            let Ok(worktree) = repo.find_worktree(name) else {
                continue;
            };
            let registered = worktree.path().to_path_buf();
            let missing = !registered.exists();
            let path = registered.canonicalize().unwrap_or(registered);
            let locked = match worktree.is_locked() {
                // git writes the reason with a trailing newline.
                Ok(WorktreeLockStatus::Locked(reason)) => {
                    Some(reason.unwrap_or_default().trim_end().to_owned())
                }
                _ => None,
            };
            let head = Repository::open_from_worktree(&worktree)
                .ok()
                .and_then(|r| head_state(&r).ok())
                .or_else(|| admin_head(common, name));
            linked.push(LinkedWorktree {
                name: Some(name.to_owned()),
                is_current: path == self.path(),
                path,
                head,
                is_main: false,
                missing,
                locked,
            });
        }
        linked.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(self.main_row(common).into_iter().chain(linked).collect())
    }

    /// `git worktree add` for `branch` into `path`, which must not exist or be
    /// an empty folder. A new branch's `start` is passed to git verbatim.
    pub fn add_linked_worktree(
        &self,
        path: &Path,
        branch: &WorktreeBranch,
    ) -> Result<(), GitError> {
        // git resolves a relative path against the workdir and never expands `~`.
        if !path.is_absolute() {
            return Err(GitError::PathNotAbsolute(path.to_path_buf()));
        }
        let target = path.to_string_lossy();
        let args: Vec<&str> = match branch {
            WorktreeBranch::New { name, start } => {
                validate_branch_name(name)?;
                if self.repo().find_branch(name, BranchType::Local).is_ok() {
                    return Err(GitError::BranchExists(name.clone()));
                }
                let start = start.as_deref();
                if let Some(flag) = start.filter(|s| s.starts_with('-')) {
                    return Err(GitError::RevisionNotFound(flag.to_owned()));
                }
                self.new_branch_target(name, start)?;
                ensure_free_folder(path)?;
                ["add", "-b", name, &target]
                    .into_iter()
                    .chain(start)
                    .collect()
            }
            WorktreeBranch::Existing { name } => {
                find_local(self.repo(), name)?;
                if head_state(self.repo())? == (HeadState::Branch { name: name.clone() }) {
                    return Err(GitError::BranchCheckedOut {
                        name: name.clone(),
                        worktree: self.path().to_path_buf(),
                    });
                }
                self.refuse_checked_out_elsewhere(name)?;
                ensure_free_folder(path)?;
                vec!["add", &target, name]
            }
        };
        self.run_worktree("worktree add", &args)
    }

    /// `git worktree remove [--force]` for the listed worktree at `path` (as
    /// registered, or its canonical form). Without `force` a worktree whose
    /// folder still exists must have no changes, untracked files included.
    pub fn remove_linked_worktree(&self, path: &Path, force: bool) -> Result<(), GitError> {
        let canonical = path.canonicalize().ok();
        let list = self.list_linked_worktrees()?;
        let entry = list
            .iter()
            .find(|w| w.path == path || canonical.as_deref() == Some(w.path.as_path()))
            .ok_or_else(|| GitError::WorktreeNotFound(path.to_path_buf()))?;
        if entry.is_main {
            return Err(GitError::CannotRemoveMain);
        }
        if entry.is_current {
            return Err(GitError::CannotRemoveCurrent);
        }
        if let Some(reason) = &entry.locked {
            return Err(GitError::WorktreeLocked(reason.clone()));
        }
        if !force && !entry.missing && is_dirty(&entry.path)? {
            return Err(GitError::WorktreeDirty(entry.path.clone()));
        }
        let target = entry.path.to_string_lossy();
        let mut args = vec!["remove"];
        if force {
            args.push("--force");
        }
        args.push(&target);
        self.run_worktree("worktree remove", &args)
    }

    /// `git worktree prune`; returns the entries it removes: the missing,
    /// unlocked ones as listed just before.
    pub fn prune_linked_worktrees(&self) -> Result<PrunedWorktrees, GitError> {
        let paths = self
            .list_linked_worktrees()?
            .into_iter()
            .filter(|w| w.missing && w.locked.is_none())
            .map(|w| w.path)
            .collect();
        self.run_worktree("worktree prune", &["prune"])?;
        Ok(PrunedWorktrees { paths })
    }

    /// The canonical common dir when it lies outside this session's root, as
    /// it does for a linked worktree; the watcher adds it as a second root.
    pub fn common_dir_outside_workdir(&self) -> Option<PathBuf> {
        let common = self.repo().commondir().canonicalize().ok()?;
        (!common.starts_with(self.path())).then_some(common)
    }

    /// Branch name to path for every other worktree on a branch, missing ones included.
    pub(crate) fn checked_out_elsewhere(&self) -> Result<BTreeMap<String, PathBuf>, GitError> {
        Ok(self
            .list_linked_worktrees()?
            .into_iter()
            .filter(|w| !w.is_current)
            .filter_map(|w| match w.head {
                Some(HeadState::Branch { name }) => Some((name, w.path)),
                _ => None,
            })
            .collect())
    }

    /// The main worktree's row. A main session is its own; a linked session
    /// takes the workdir of the repository at the common dir, kept only when
    /// that folder opens onto the same common dir: with `--separate-git-dir`
    /// nothing records the main worktree, and libgit2 would guess the gitdir's
    /// parent. `None` for a bare main repository.
    fn main_row(&self, common: &Path) -> Option<LinkedWorktree> {
        if !self.repo().is_worktree() {
            return Some(main_entry(
                self.path().to_path_buf(),
                self.repo(),
                self.path(),
            ));
        }
        let repo = Repository::open(common).ok()?;
        if repo.is_bare() {
            return None;
        }
        let path = repo.workdir()?.canonicalize().ok()?;
        let back = Repository::open(&path).ok()?;
        same_dir(back.commondir(), common).then(|| main_entry(path, &repo, self.path()))
    }

    /// Runs `git worktree <args>`; a non-zero exit is `OperationFailed { verb }`.
    fn run_worktree(&self, verb: &str, args: &[&str]) -> Result<(), GitError> {
        let (git, workdir) = self.git()?;
        let output = git_ops::run(&git, workdir, "worktree", args, &[])?;
        if output.status.success() {
            Ok(())
        } else {
            Err(operation_failed(verb, &output))
        }
    }
}

fn main_entry(path: PathBuf, repo: &Repository, root: &Path) -> LinkedWorktree {
    LinkedWorktree {
        name: None,
        head: head_state(repo).ok(),
        is_main: true,
        is_current: path == root,
        missing: false,
        locked: None,
        path,
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

/// HEAD as `<common>/worktrees/<name>/HEAD` records it: a branch ref or a
/// detached oid; `None` for anything else.
fn admin_head(common: &Path, name: &str) -> Option<HeadState> {
    let text = std::fs::read_to_string(common.join("worktrees").join(name).join("HEAD")).ok()?;
    let line = text.trim();
    if let Some(branch) = line.strip_prefix("ref: refs/heads/") {
        return Some(HeadState::Branch {
            name: branch.to_owned(),
        });
    }
    (line.len() == 40 && line.bytes().all(|b| b.is_ascii_hexdigit())).then(|| HeadState::Detached {
        oid: line.to_owned(),
    })
}

/// `PathExists` unless `path` is absent or an empty directory.
fn ensure_free_folder(path: &Path) -> Result<(), GitError> {
    if !path.exists() || (path.is_dir() && std::fs::read_dir(path)?.next().is_none()) {
        Ok(())
    } else {
        Err(GitError::PathExists(path.to_path_buf()))
    }
}

/// Any change at all, untracked files included, ignored files not.
fn is_dirty(path: &Path) -> Result<bool, GitError> {
    let repo = Repository::open(path)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    Ok(!repo.statuses(Some(&mut opts))?.is_empty())
}
