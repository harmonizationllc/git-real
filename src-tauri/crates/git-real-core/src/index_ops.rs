//! Whole-file index operations: stage, unstage and discard.
//!
//! Every operation validates all of its paths before it writes anything, and
//! starts from an index freshly re-read from disk so changes made by other
//! processes (such as `git add` in a terminal) are never clobbered.

use std::path::{Path, PathBuf};

use git2::build::CheckoutBuilder;
use git2::{Commit, ErrorCode, Index, IndexAddOption, IndexEntry, IndexTime, ObjectType};

use crate::error::GitError;
use crate::paths::checked_relative;
use crate::repo::RepoSession;

/// Characters that end a libgit2 pathspec early, so a path containing one
/// cannot be expressed as a literal pathspec.
const PATHSPEC_BREAKS: [char; 5] = ['\n', '\r', '\t', '\x0b', '\x0c'];

impl RepoSession {
    /// Stages the working tree state of each path, including deletions and
    /// conflict resolutions.
    pub fn stage_paths(&self, paths: &[String]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let workdir = self.workdir()?;
        let paths = normalise_all(workdir, paths)?;
        let mut index = self.fresh_index()?;
        let staged = (|| {
            for p in &paths {
                let rel = Path::new(p);
                if workdir.join(rel).symlink_metadata().is_ok() {
                    index.add_path(rel)?;
                } else if in_index(&index, rel, 0..=3) {
                    index.remove_path(rel)?;
                } else {
                    return Err(GitError::PathNotFound(PathBuf::from(p)));
                }
            }
            index.write()?;
            Ok(())
        })();
        reload_on_error(&mut index, staged)
    }

    /// Stages every change in the working tree, ignored files excepted.
    pub fn stage_all(&self) -> Result<(), GitError> {
        let mut index = self.fresh_index()?;
        let staged = (|| {
            index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
            index.update_all(["*"], None)?;
            index.write()?;
            Ok(())
        })();
        reload_on_error(&mut index, staged)
    }

    /// Resets each path's index entry to HEAD (or removes it when unborn).
    ///
    /// A path containing control whitespace is rejected with
    /// [`GitError::BadSelection`], since it cannot be a literal pathspec.
    pub fn unstage_paths(&self, paths: &[String]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let paths = normalise_all(self.workdir()?, paths)?;
        let mut index = self.fresh_index()?;
        let head = self.head_commit()?;
        let tree = head.as_ref().map(Commit::tree).transpose()?;
        for p in &paths {
            // libgit2 stops a pathspec at these characters (and drops one that
            // starts with a newline), which would widen the reset.
            if p.contains(PATHSPEC_BREAKS) {
                return Err(GitError::BadSelection);
            }
            let rel = Path::new(p);
            let in_head = tree.as_ref().is_some_and(|t| {
                t.get_path(rel)
                    .is_ok_and(|e| e.kind() != Some(ObjectType::Tree))
            });
            if !in_head && !in_index(&index, rel, 0..=3) {
                return Err(GitError::PathNotFound(PathBuf::from(p)));
            }
        }
        // Edit the index entries directly: a pathspec cannot name every
        // path portably (libgit2 on Windows treats `\` as a separator).
        let unstaged = (|| {
            for p in &paths {
                let rel = Path::new(p);
                for stage in 0..=3 {
                    match index.remove(rel, stage) {
                        Ok(()) => {}
                        Err(e) if e.code() == ErrorCode::NotFound => {}
                        Err(e) => return Err(e.into()),
                    }
                }
                let head_entry = tree.as_ref().and_then(|t| {
                    t.get_path(rel)
                        .ok()
                        .filter(|e| e.kind() != Some(ObjectType::Tree))
                });
                if let Some(e) = head_entry {
                    index.add(&IndexEntry {
                        ctime: IndexTime::new(0, 0),
                        mtime: IndexTime::new(0, 0),
                        dev: 0,
                        ino: 0,
                        mode: e.filemode() as u32,
                        uid: 0,
                        gid: 0,
                        file_size: 0,
                        id: e.id(),
                        flags: 0,
                        flags_extended: 0,
                        path: p.clone().into_bytes(),
                    })?;
                }
            }
            index.write()?;
            Ok(())
        })();
        reload_on_error(&mut index, unstaged)
    }

    /// Resets the whole index to HEAD (or empties it when unborn).
    pub fn unstage_all(&self) -> Result<(), GitError> {
        let mut index = self.fresh_index()?;
        let unstaged = match self.head_commit()? {
            Some(commit) => self
                .repo()
                .reset_default(Some(commit.as_object()), ["*"])
                .map_err(GitError::from),
            None => index
                .clear()
                .and_then(|()| index.write())
                .map_err(GitError::from),
        };
        reload_on_error(&mut index, unstaged)
    }

    /// Throws away unstaged changes: tracked paths are restored to their
    /// index content, untracked files and directories are deleted.
    ///
    /// Conflicted paths, directories holding tracked files or a nested
    /// repository (a `.git` entry at any depth) and tracked names
    /// containing `\` are rejected with [`GitError::BadSelection`]. The index
    /// itself is never written.
    pub fn discard_paths(&self, paths: &[String]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let workdir = self.workdir()?;
        let paths = normalise_all(workdir, paths)?;
        let mut index = self.fresh_index()?;

        let mut tracked = Vec::new();
        let mut untracked_files = Vec::new();
        let mut untracked_dirs = Vec::new();
        for p in &paths {
            let rel = Path::new(p);
            if in_index(&index, rel, 1..=3) {
                return Err(GitError::BadSelection);
            }
            if in_index(&index, rel, 0..=0) {
                // Checkout is given literal paths (pathspec matching off), and
                // libgit2 cannot address a name containing `\` that way.
                if p.contains('\\') {
                    return Err(GitError::BadSelection);
                }
                tracked.push(p.as_str());
                continue;
            }
            let full = workdir.join(rel);
            match full.symlink_metadata() {
                Ok(meta) if meta.is_dir() => {
                    // A nested repository (a `.git` at any depth) is
                    // refused: deleting it would lose its history.
                    if has_entries_under(&index, p) || contains_git_entry(&full)? {
                        return Err(GitError::BadSelection);
                    }
                    untracked_dirs.push(full);
                }
                Ok(_) => untracked_files.push(full),
                Err(_) => return Err(GitError::PathNotFound(PathBuf::from(p))),
            }
        }

        if !tracked.is_empty() {
            let mut checkout = CheckoutBuilder::new();
            // Literal paths: with pathspec matching on, a name that parses to
            // an empty pattern (such as a leading `#`) would select the whole
            // index and force-restore every file.
            checkout.force().disable_pathspec_match(true);
            for p in &tracked {
                checkout.path(p);
            }
            self.repo()
                .checkout_index(Some(&mut index), Some(&mut checkout))?;
        }
        for file in &untracked_files {
            std::fs::remove_file(file)?;
        }
        for dir in &untracked_dirs {
            std::fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    /// The repository's index, re-read from disk so neither external writes
    /// nor dirty state left by an earlier failed call can leak in.
    pub(crate) fn fresh_index(&self) -> Result<Index, GitError> {
        let mut index = self.repo().index()?;
        index.read(true)?;
        Ok(index)
    }

    /// The commit HEAD points at, or `None` for an unborn branch.
    fn head_commit(&self) -> Result<Option<Commit<'_>>, GitError> {
        match self.repo().head() {
            Ok(head) => Ok(Some(head.peel_to_commit()?)),
            Err(e) if e.code() == ErrorCode::UnbornBranch => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}

/// Validates every path up front so a bad one aborts before any write.
pub(crate) fn normalise_all(workdir: &Path, paths: &[String]) -> Result<Vec<String>, GitError> {
    paths.iter().map(|p| checked_relative(workdir, p)).collect()
}

/// Passes `result` through, but on error first re-reads `index` from disk so
/// changes made before the failure do not linger in the repository's cached
/// index, where the same session's later calls would see them.
pub(crate) fn reload_on_error(
    index: &mut Index,
    result: Result<(), GitError>,
) -> Result<(), GitError> {
    if result.is_err() {
        let _ = index.read(true);
    }
    result
}

/// Whether the index has an entry for `path` at any of `stages`.
fn in_index(index: &Index, path: &Path, stages: std::ops::RangeInclusive<i32>) -> bool {
    stages
        .into_iter()
        .any(|stage| index.get_path(path, stage).is_some())
}

/// Whether any index entry lives below the directory `dir`.
fn has_entries_under(index: &Index, dir: &str) -> bool {
    let prefix = format!("{dir}/");
    index.iter().any(|e| e.path.starts_with(prefix.as_bytes()))
}

/// Whether `dir` holds a `.git` file or directory at any depth, which marks
/// a nested repository or worktree. Symlinks are not followed.
fn contains_git_entry(dir: &Path) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name() == ".git" {
            return Ok(true);
        }
        if entry.file_type()?.is_dir() && contains_git_entry(&entry.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}
