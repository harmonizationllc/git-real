//! Writing an edited resolution back to a conflicted path.

use std::path::{Path, PathBuf};

use git2::IndexConflict;

use super::resolve::conflict_path_is;
use crate::error::GitError;
use crate::index_ops::reload_on_error;
use crate::paths::checked_relative;
use crate::repo::RepoSession;

impl RepoSession {
    /// Writes `text` to the conflicted `path` and, when `stage` is set, stages it,
    /// which clears the path's conflict entries.
    ///
    /// Nothing is written unless the path is conflicted in a fresh index. A symlink
    /// or directory at the path is refused with `BadSelection`. Bytes are written
    /// exactly as given; the caller owns line endings.
    pub fn write_resolution(&self, path: &str, text: &str, stage: bool) -> Result<(), GitError> {
        let workdir = self.workdir()?;
        let rel = checked_relative(workdir, path)?;
        let mut index = self.fresh_index()?;
        let conflicts = index
            .conflicts()?
            .collect::<Result<Vec<IndexConflict>, _>>()?;
        if !conflicts.iter().any(|c| conflict_path_is(c, &rel)) {
            return Err(GitError::PathNotFound(PathBuf::from(&rel)));
        }
        let full = workdir.join(&rel);
        if let Ok(meta) = full.symlink_metadata()
            && (meta.file_type().is_symlink() || meta.is_dir())
        {
            return Err(GitError::BadSelection);
        }
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&full, text.as_bytes())?;
        if !stage {
            return Ok(());
        }
        let staged = (|| {
            index.add_path(Path::new(&rel))?;
            index.write()?;
            Ok(())
        })();
        reload_on_error(&mut index, staged)
    }
}
