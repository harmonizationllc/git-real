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
        let contents = self.worktree_contents(&chosen)?;
        let resolved = (|| {
            for ((rel, entry), content) in chosen.iter().zip(&contents) {
                let full = workdir.join(rel);
                match (entry, content) {
                    (Some(entry), Some(content)) => {
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
                    _ => {
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

    /// The bytes git would write to the working tree for each chosen entry
    /// (`None` where the side is absent). Regular files go through the
    /// repository's checkout filters (`core.autocrlf`, `.gitattributes`), as
    /// `git checkout --ours` does: they are checked out into a scratch
    /// directory inside the git dir, leaving the working tree and the index
    /// alone. Other modes (symlinks) keep the raw blob.
    fn worktree_contents(
        &self,
        chosen: &[(&Path, Option<&IndexEntry>)],
    ) -> Result<Vec<Option<Vec<u8>>>, GitError> {
        let repo = self.repo();
        let regular = |e: &IndexEntry| e.mode & 0o170000 == REGULAR_FILE;
        let mut filtered = Index::new()?;
        let mut checkout = CheckoutBuilder::new();
        checkout
            .force()
            .recreate_missing(true)
            .update_index(false)
            .refresh(false)
            .disable_pathspec_match(true);
        for (rel, entry) in chosen {
            if let Some(entry) = entry.filter(|e| regular(e)) {
                filtered.add(&IndexEntry {
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
        }
        let scratch = ScratchDir::create(repo.path())?;
        if !filtered.is_empty() {
            checkout.target_dir(&scratch.path);
            repo.checkout_index(Some(&mut filtered), Some(&mut checkout))?;
        }
        chosen
            .iter()
            .map(|(rel, entry)| match entry {
                Some(e) if regular(e) => Ok(Some(std::fs::read(scratch.path.join(rel))?)),
                Some(e) => Ok(Some(repo.find_blob(e.id)?.content().to_vec())),
                None => Ok(None),
            })
            .collect()
    }
}

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
