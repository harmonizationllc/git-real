//! Resolving conflicts by keeping one side whole.

use std::path::{Path, PathBuf};

use git2::{IndexConflict, IndexEntry, Oid};

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
    /// with `PathNotFound`.
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
                Ok((Path::new(p), entry.as_ref().map(blob_and_mode)))
            })
            .collect::<Result<Vec<_>, GitError>>()?;
        let resolved = (|| {
            for (rel, entry) in &chosen {
                let full = workdir.join(rel);
                match entry {
                    Some((id, mode)) => {
                        let blob = self.repo().find_blob(*id)?;
                        if let Some(parent) = full.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        std::fs::write(&full, blob.content())?;
                        set_executable(&full, *mode)?;
                        index.add_path(rel)?;
                    }
                    None => {
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
}

fn blob_and_mode(entry: &IndexEntry) -> (Oid, u32) {
    (entry.id, entry.mode)
}

/// Whether any stage of `conflict` is at `path`.
fn conflict_path_is(conflict: &IndexConflict, path: &str) -> bool {
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
