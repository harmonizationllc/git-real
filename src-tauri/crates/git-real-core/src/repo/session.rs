use std::path::{Path, PathBuf};

use git2::{ErrorCode, Repository};

use crate::error::GitError;
use crate::model::RepoSummary;

/// An open repository together with its canonical root path.
pub struct RepoSession {
    repo: Repository,
    root: PathBuf,
}

impl RepoSession {
    /// Opens the repository rooted exactly at `path` (no parent discovery).
    pub fn open(path: impl AsRef<Path>) -> Result<Self, GitError> {
        let path = path.as_ref();
        if !path.exists() {
            return Err(GitError::PathNotFound(path.to_path_buf()));
        }
        match Repository::open(path) {
            Ok(repo) => Self::from_repo(repo),
            Err(e) if e.code() == ErrorCode::NotFound => {
                Err(GitError::NotARepository(path.to_path_buf()))
            }
            Err(e) => Err(GitError::Git2(e)),
        }
    }

    /// Initializes a new repository at `path`, creating the folder if needed.
    pub fn init(path: impl AsRef<Path>) -> Result<Self, GitError> {
        let path = path.as_ref();
        match Repository::open(path) {
            Ok(_) => return Err(GitError::AlreadyARepository(path.to_path_buf())),
            Err(e) if e.code() == ErrorCode::NotFound => {}
            Err(e) => return Err(GitError::Git2(e)),
        }
        std::fs::create_dir_all(path)?;
        Self::from_repo(Repository::init(path)?)
    }

    pub fn summary(&self) -> RepoSummary {
        let name = self.root.file_name().map_or_else(
            || self.root.to_string_lossy().into_owned(),
            |n| n.to_string_lossy().into_owned(),
        );
        let head_branch = self.repo.find_reference("HEAD").ok().and_then(|head| {
            head.symbolic_target()
                .and_then(|t| t.strip_prefix("refs/heads/"))
                .map(str::to_owned)
        });
        RepoSummary {
            path: self.root.clone(),
            name,
            head_branch,
            is_bare: self.repo.is_bare(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    fn from_repo(repo: Repository) -> Result<Self, GitError> {
        let root = std::fs::canonicalize(repo.workdir().unwrap_or_else(|| repo.path()))?;
        Ok(Self { repo, root })
    }
}
