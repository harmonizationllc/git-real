//! Resolving conflicts by keeping one side whole.

use std::path::{Path, PathBuf};

use git2::build::CheckoutBuilder;
use git2::{Index, IndexConflict, IndexEntry, IndexTime};

use crate::error::GitError;
use crate::index_ops::{normalise_all, reload_on_error};
use crate::model::ConflictSide;
use crate::repo::RepoSession;

/// git's index mode for an executable regular file.
#[cfg(unix)]
const EXECUTABLE: u32 = 0o100755;

impl RepoSession {
    /// Keeps `side` of each conflicted path: writes that stage's blob (or deletes the file)
    /// and stages the path, which clears the conflict entries.
    ///
    /// Every path must be conflicted, or nothing is written and the call fails
    /// with `PathNotFound`. Once writing starts it is not atomic on the working
    /// tree: an I/O failure on one path leaves earlier paths already written,
    /// while the index is reloaded with its conflicts intact.
    pub fn resolve_conflicts(&self, paths: &[String], side: ConflictSide) -> Result<(), GitError> {
        let workdir = self.workdir()?;
        let paths = normalise_all(workdir, paths)?;
        let mut index = self.fresh_index()?;
        let conflicts = index
            .conflicts()?
            .collect::<Result<Vec<IndexConflict>, _>>()?;
        let chosen = paths
            .iter()
            .map(|p| {
                let conflict = conflicts
                    .iter()
                    .find(|c| conflict_path_is(c, p))
                    .ok_or_else(|| GitError::PathNotFound(PathBuf::from(p)))?;
                let entry = match side {
                    ConflictSide::Ours => &conflict.our,
                    ConflictSide::Theirs => &conflict.their,
                };
                Ok((Path::new(p), entry.as_ref()))
            })
            .collect::<Result<Vec<_>, GitError>>()?;
        let kept = self.worktree_contents(&chosen)?;
        let resolved = (|| {
            for ((rel, _), kept) in chosen.iter().zip(&kept) {
                let full = workdir.join(rel);
                match kept {
                    Kept::File(entry, content) => {
                        if let Some(parent) = full.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        // Never write through a symlink at the path itself: it
                        // could point outside the working tree.
                        if full
                            .symlink_metadata()
                            .is_ok_and(|m| m.file_type().is_symlink())
                        {
                            std::fs::remove_file(&full)?;
                        }
                        std::fs::write(&full, content)?;
                        set_executable(&full, entry.mode)?;
                        index.add_path(rel)?;
                    }
                    Kept::Link(entry) => {
                        checkout_entries(self.repo(), &[(rel, entry)], None)?;
                        index.add_path(rel)?;
                    }
                    Kept::Deleted => {
                        if full.symlink_metadata().is_ok() {
                            std::fs::remove_file(&full)?;
                        }
                        index.remove_path(rel)?;
                    }
                }
            }
            index.write()?;
            Ok(())
        })();
        reload_on_error(&mut index, resolved)
    }

    /// What to put in the working tree for each chosen entry. Regular files
    /// carry the bytes git would write: they go through the repository's
    /// checkout filters (`core.autocrlf`, `.gitattributes`), as
    /// `git checkout --ours` does, by checking them out into a scratch
    /// directory inside the git dir, which leaves the working tree and the
    /// index alone. Symlinks are checked out into the working tree by libgit2
    /// itself (so `core.symlinks` applies), and an absent side is a deletion.
    fn worktree_contents<'a>(
        &self,
        chosen: &[(&Path, Option<&'a IndexEntry>)],
    ) -> Result<Vec<Kept<'a>>, GitError> {
        let repo = self.repo();
        let files: Vec<_> = chosen
            .iter()
            .filter_map(|(rel, entry)| Some((*rel, (*entry)?)))
            .filter(|(_, e)| e.mode & TYPE_MASK == REGULAR_FILE)
            .collect();
        let scratch = if files.is_empty() {
            None
        } else {
            let scratch = ScratchDir::create(repo.path())?;
            checkout_entries(repo, &files, Some(&scratch.path))?;
            Some(scratch)
        };
        chosen
            .iter()
            .map(|(rel, entry)| match (entry, &scratch) {
                (None, _) => Ok(Kept::Deleted),
                (Some(e), Some(scratch)) if e.mode & TYPE_MASK == REGULAR_FILE => {
                    Ok(Kept::File(e, std::fs::read(scratch.path.join(rel))?))
                }
                (Some(e), _) => Ok(Kept::Link(e)),
            })
            .collect()
    }
}

/// What a conflicted path becomes under the side the user kept.
enum Kept<'a> {
    Deleted,
    /// A regular file and the bytes git would write for it.
    File(&'a IndexEntry, Vec<u8>),
    /// A symlink (or any other non-regular mode), written by libgit2.
    Link(&'a IndexEntry),
}

/// Force-checks `entries` out of a throwaway index into `target_dir` (the
/// working tree when `None`), through the checkout filters, without touching
/// the repository index. Paths are literal.
fn checkout_entries(
    repo: &git2::Repository,
    entries: &[(&Path, &IndexEntry)],
    target_dir: Option<&Path>,
) -> Result<(), GitError> {
    let mut detached = Index::new()?;
    let mut checkout = CheckoutBuilder::new();
    checkout
        .force()
        .recreate_missing(true)
        .update_index(false)
        .refresh(false)
        .disable_pathspec_match(true);
    for (rel, entry) in entries {
        detached.add(&IndexEntry {
            ctime: IndexTime::new(0, 0),
            mtime: IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: entry.mode,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: entry.id,
            flags: entry.flags & !STAGE_MASK,
            flags_extended: 0,
            path: entry.path.clone(),
        })?;
        checkout.path(rel);
    }
    if let Some(dir) = target_dir {
        checkout.target_dir(dir);
    }
    repo.checkout_index(Some(&mut detached), Some(&mut checkout))?;
    Ok(())
}

/// The object type bits of an index mode.
const TYPE_MASK: u32 = 0o170000;

/// git's object type bits for a regular file (either permission).
const REGULAR_FILE: u32 = 0o100000;

/// The stage bits of an index entry's flags.
const STAGE_MASK: u16 = 0x3000;

/// A directory created exclusively under `parent`, removed with its contents on drop.
struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    fn create(parent: &Path) -> Result<Self, GitError> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = parent.join(format!("git-real-resolve-{}-{nanos}", std::process::id()));
        std::fs::create_dir(&path)?;
        Ok(Self { path })
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Whether any stage of `conflict` is at `path`.
pub(super) fn conflict_path_is(conflict: &IndexConflict, path: &str) -> bool {
    [&conflict.ancestor, &conflict.our, &conflict.their]
        .into_iter()
        .flatten()
        .any(|entry| entry.path == path.as_bytes())
}

/// Gives the file the executable bits its index mode asks for (read bits
/// copied to execute bits, as git does), or takes them away.
#[cfg(unix)]
fn set_executable(full: &Path, index_mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(full)?.permissions();
    let mode = permissions.mode();
    let wanted = if index_mode == EXECUTABLE {
        mode | ((mode & 0o444) >> 2)
    } else {
        mode & !0o111
    };
    if wanted != mode {
        permissions.set_mode(wanted);
        std::fs::set_permissions(full, permissions)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_full: &Path, _index_mode: u32) -> std::io::Result<()> {
    Ok(())
}
