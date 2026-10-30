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

/// Escapes the POSIX-regex metacharacters of `s` for a config key pattern.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if ".^$*+?()[]{}|\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `Config::set_multivar` writes its value verbatim (unlike `set_str`), so a
/// backslash or quote has to be escaped by hand; libgit2 still adds the
/// surrounding quotes when the value needs them.
fn config_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

/// Renames a remote without `Repository::remote_rename`: libgit2 copies each
/// `remote.<old>.*` value back into the config unescaped, so a backslash URL
/// (`C:\srv\a.git`) corrupts `.git/config` ("invalid escape") and a second
/// fetch refspec trips its multivar check (GR-35). This copies every entry
/// through `Config::set_str` / `set_multivar` (escaped), moves the tracking refs,
/// repoints `branch.*.remote`, then drops the old section.
fn rename_remote(repo: &git2::Repository, old: &str, new: &str) -> Result<(), GitError> {
    let mut config = repo.config()?.open_level(git2::ConfigLevel::Local)?;
    let prefix = format!("remote.{old}.");
    let old_default = format!("+refs/heads/*:refs/remotes/{old}/*");
    let new_default = format!("+refs/heads/*:refs/remotes/{new}/*");

    let mut entries = Vec::new();
    {
        let mut iter = config.entries(Some(&format!("^remote\\.{}\\..*", regex_escape(old))))?;
        while let Some(entry) = iter.next() {
            let entry = entry?;
            if let (Some(n), Some(v)) = (entry.name(), entry.value())
                && let Some(key) = n.strip_prefix(&prefix)
            {
                entries.push((key.to_owned(), v.to_owned()));
            }
        }
    }
    for (key, value) in &entries {
        let value = if key == "fetch" && *value == old_default {
            &new_default
        } else {
            value
        };
        let target = format!("remote.{new}.{key}");
        if config.get_entry(&target).is_err() {
            config.set_str(&target, value)?;
        } else {
            // "^$" matches no existing value, so this appends.
            config.set_multivar(&target, "^$", &config_escape(value))?;
        }
    }

    let old_ref_prefix = format!("refs/remotes/{old}/");
    let mut direct = Vec::new();
    let mut symbolic = Vec::new();
    for reference in repo.references()? {
        let reference = reference?;
        let Some(name) = reference.name() else {
            continue;
        };
        let Some(rest) = name.strip_prefix(&old_ref_prefix) else {
            continue;
        };
        let new_name = format!("refs/remotes/{new}/{rest}");
        match reference.symbolic_target() {
            Some(target) => symbolic.push((
                name.to_owned(),
                new_name,
                target.replacen(&old_ref_prefix, &format!("refs/remotes/{new}/"), 1),
            )),
            None => direct.push((name.to_owned(), new_name)),
        }
    }
    for (old_name, new_name) in direct {
        repo.find_reference(&old_name)?
            .rename(&new_name, false, "remote rename")?;
    }
    for (old_name, new_name, target) in symbolic {
        repo.find_reference(&old_name)?.delete()?;
        repo.reference_symbolic(&new_name, &target, false, "remote rename")?;
    }

    let mut branches = Vec::new();
    {
        let mut iter = config.entries(Some(r"^branch\..*\.remote$"))?;
        while let Some(entry) = iter.next() {
            let entry = entry?;
            if let (Some(n), Some(v)) = (entry.name(), entry.value())
                && v == old
            {
                branches.push(n.to_owned());
            }
        }
    }
    for key in branches {
        config.set_str(&key, new)?;
    }

    for (key, _) in &entries {
        // Ignore NotFound: a multivar key is removed whole on its first pass.
        match config.remove_multivar(&format!("remote.{old}.{key}"), ".*") {
            Err(e) if is_not_found(&e) => {}
            result => result?,
        }
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

    /// Renames first (see `rename_remote`), then sets the URL and the push URL
    /// (`None` clears it).
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
            rename_remote(repo, name, new_name)?;
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
