//! Remote configuration through git2 (ADR 0001: config and ref writes are
//! local), plus the URL lookup the network operations use.

use crate::error::GitError;
use crate::model::RemoteInfo;
use crate::refs::is_not_found;
use crate::repo::RepoSession;

/// Which of a remote's URLs an operation talks to.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Direction {
    Fetch,
    Push,
}

fn validate_remote_name(name: &str) -> Result<(), GitError> {
    // `Remote::is_valid_name` unwraps a CString, so a NUL byte is refused first.
    if name.contains('\0') || name.starts_with('-') || !git2::Remote::is_valid_name(name) {
        return Err(GitError::InvalidRemoteName(name.to_owned()));
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<(), GitError> {
    if url.trim().is_empty() || url.starts_with('-') || url.contains(['\n', '\r', '\0']) {
        return Err(GitError::InvalidRemoteUrl(url.to_owned()));
    }
    Ok(())
}

impl RepoSession {
    /// Every remote, sorted by name, with the URLs as configured (not rewritten).
    pub fn list_remotes(&self) -> Result<Vec<RemoteInfo>, GitError> {
        let config = self.repo().config()?;
        Ok(self
            .remote_names()?
            .into_iter()
            .map(|name| RemoteInfo {
                fetch_url: config
                    .get_string(&format!("remote.{name}.url"))
                    .unwrap_or_default(),
                push_url: config.get_string(&format!("remote.{name}.pushurl")).ok(),
                name,
            })
            .collect())
    }

    /// Adds `name` with `url` and, when given, a separate push URL.
    pub fn add_remote(
        &self,
        name: &str,
        url: &str,
        push_url: Option<&str>,
    ) -> Result<(), GitError> {
        validate_remote_name(name)?;
        let repo = self.repo();
        if repo.find_remote(name).is_ok() {
            return Err(GitError::RemoteExists(name.to_owned()));
        }
        validate_url(url)?;
        push_url.map(validate_url).transpose()?;
        repo.remote(name, url)?;
        if push_url.is_some() {
            repo.remote_set_pushurl(name, push_url)?;
        }
        Ok(())
    }

    /// Renames first (git2 moves the tracking refs and `branch.*.remote`), then
    /// sets the URL and the push URL (`None` clears it).
    pub fn update_remote(
        &self,
        name: &str,
        new_name: &str,
        url: &str,
        push_url: Option<&str>,
    ) -> Result<(), GitError> {
        self.ensure_remote(name)?;
        validate_remote_name(new_name)?;
        validate_url(url)?;
        push_url.map(validate_url).transpose()?;
        let repo = self.repo();
        if new_name != name {
            if repo.find_remote(new_name).is_ok() {
                return Err(GitError::RemoteExists(new_name.to_owned()));
            }
            repo.remote_rename(name, new_name)?;
        }
        repo.remote_set_url(new_name, url)?;
        match repo.remote_set_pushurl(new_name, push_url) {
            // libgit2 reports clearing a push URL that is not set as NotFound.
            Err(e) if push_url.is_none() && is_not_found(&e) => Ok(()),
            result => Ok(result?),
        }
    }

    /// git2 also deletes the remote's tracking refs and its branches' upstream config.
    pub fn remove_remote(&self, name: &str) -> Result<(), GitError> {
        self.ensure_remote(name)?;
        self.repo().remote_delete(name)?;
        Ok(())
    }

    /// Every configured remote's name (UTF-8 only), sorted.
    pub(crate) fn remote_names(&self) -> Result<Vec<String>, GitError> {
        let mut names: Vec<String> = self
            .repo()
            .remotes()?
            .iter()
            .flatten()
            .map(str::to_owned)
            .collect();
        names.sort();
        Ok(names)
    }

    /// The URL git uses for `remote` in `direction`; git2 applies `insteadOf`
    /// and `pushInsteadOf`. `None` when the remote has no URL.
    pub(crate) fn used_url(
        &self,
        remote: &str,
        direction: Direction,
    ) -> Result<Option<String>, GitError> {
        let r = self.repo().find_remote(remote)?;
        let bytes = match direction {
            Direction::Fetch => r.url_bytes(),
            Direction::Push => r.pushurl_bytes().unwrap_or(r.url_bytes()),
        };
        Ok((!bytes.is_empty()).then(|| String::from_utf8_lossy(bytes).into_owned()))
    }
}
