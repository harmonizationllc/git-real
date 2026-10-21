//! Tags: listed and deleted with git2; created through `git tag` so
//! `tag.gpgSign` is honoured (signing is CLI-only, ADR 0001); pushed and
//! deleted on a remote through `git push` after the session lock is released.

use git2::{Reference, Repository, Tag};

use super::is_not_found;
use crate::error::GitError;
use crate::git_cli;
use crate::git_ops::{self, operation_failed};
use crate::model::{TagEntry, TagList};
use crate::remote::push_tag::{TagPush, TagPushDelete};
use crate::repo::RepoSession;
use crate::revision::resolve_commit;

/// Names git accepts for `refs/tags/<name>` that can never be read as a flag.
fn validate_tag_name(name: &str) -> Result<(), GitError> {
    // `Tag::is_valid_name` unwraps a CString, so a NUL byte must be refused first.
    if name.contains('\0') || name.starts_with('-') || !Tag::is_valid_name(name) {
        return Err(GitError::InvalidTagName(name.to_owned()));
    }
    Ok(())
}

impl RepoSession {
    /// Local tags that peel to a commit, newest first, and the configured remotes.
    pub fn list_tags(&self) -> Result<TagList, GitError> {
        let repo = self.repo();
        let mut tags = Vec::new();
        for reference in repo.references_glob("refs/tags/*")? {
            if let Some(entry) = tag_entry(repo, &reference?) {
                tags.push(entry);
            }
        }
        tags.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| a.name.cmp(&b.name)));
        let mut remotes: Vec<String> = repo
            .remotes()?
            .iter()
            .flatten()
            .map(str::to_owned)
            .collect();
        remotes.sort();
        Ok(TagList { tags, remotes })
    }

    /// `git tag -a --cleanup=whitespace -F - <name> <oid>` with `message` on
    /// stdin, or `git tag --no-sign <name> <oid>` without one.
    pub fn create_tag(&self, name: &str, oid: &str, message: Option<&str>) -> Result<(), GitError> {
        validate_tag_name(name)?;
        match self.repo().find_reference(&tag_ref(name)) {
            Ok(_) => return Err(GitError::TagExists(name.to_owned())),
            Err(e) if is_not_found(&e) => {}
            Err(e) => return Err(e.into()),
        }
        let target = resolve_commit(self.repo(), oid)?.id().to_string();
        // git 2.43 stores a blank annotated message without complaint, so it is refused here.
        if message.is_some_and(|m| m.trim().is_empty()) {
            return Err(GitError::EmptyMessage);
        }
        let (git, workdir) = self.git()?;
        let output = match message {
            Some(m) => git_ops::run_with_input(
                &git,
                workdir,
                "tag",
                &["-a", "--cleanup=whitespace", "-F", "-", name, &target],
                m.as_bytes(),
            )?,
            // `--no-sign`: with tag.gpgSign set, a plain `git tag` would open
            // an editor for a signed annotated tag.
            None => git_ops::run(&git, workdir, "tag", &["--no-sign", name, &target], &[])?,
        };
        if output.status.success() {
            Ok(())
        } else {
            Err(operation_failed("tag", &output))
        }
    }

    /// Deletes the local tag `name`.
    pub fn delete_tag(&self, name: &str) -> Result<(), GitError> {
        self.find_tag(name)?;
        self.repo().tag_delete(name)?;
        Ok(())
    }

    /// Validates a tag push and returns it, to run after the session lock is released.
    pub fn prepare_tag_push(&self, remote: &str, name: &str) -> Result<TagPush, GitError> {
        self.ensure_remote(remote)?;
        self.find_tag(name)?;
        Ok(TagPush::new(
            git_cli::locate()?,
            self.workdir()?.to_path_buf(),
            remote.to_owned(),
            name.to_owned(),
        ))
    }

    /// As [`Self::prepare_tag_push`]; the local tag must exist (local tags only, spec §2).
    pub fn prepare_remote_tag_delete(
        &self,
        remote: &str,
        name: &str,
    ) -> Result<TagPushDelete, GitError> {
        self.ensure_remote(remote)?;
        self.find_tag(name)?;
        Ok(TagPushDelete::new(
            git_cli::locate()?,
            self.workdir()?.to_path_buf(),
            remote.to_owned(),
            name.to_owned(),
        ))
    }

    /// The local `refs/tags/<name>`; a name that cannot be a tag is `TagNotFound` too.
    fn find_tag(&self, name: &str) -> Result<Reference<'_>, GitError> {
        let not_found = || GitError::TagNotFound(name.to_owned());
        validate_tag_name(name).map_err(|_| not_found())?;
        match self.repo().find_reference(&tag_ref(name)) {
            Ok(r) => Ok(r),
            Err(e) if is_not_found(&e) => Err(not_found()),
            Err(e) => Err(e.into()),
        }
    }
}

fn tag_ref(name: &str) -> String {
    format!("refs/tags/{name}")
}

/// `None` for a tag that does not peel to a commit (a tree or blob), as the graph skips it.
fn tag_entry(repo: &Repository, reference: &Reference<'_>) -> Option<TagEntry> {
    let name = reference.name_bytes().strip_prefix(b"refs/tags/")?;
    let commit = reference.peel_to_commit().ok()?;
    let tag = reference.target().and_then(|oid| repo.find_tag(oid).ok());
    let commit_time = commit.time().seconds();
    let (annotated, subject, time) = match &tag {
        Some(t) => (
            true,
            subject_of(t.message_bytes()),
            t.tagger().map_or(commit_time, |s| s.when().seconds()),
        ),
        None => (false, None, commit_time),
    };
    Some(TagEntry {
        name: String::from_utf8_lossy(name).into_owned(),
        target: commit.id().to_string(),
        annotated,
        subject,
        time,
    })
}

fn subject_of(message: Option<&[u8]>) -> Option<String> {
    let text = String::from_utf8_lossy(message?);
    let first = text.lines().next()?.trim();
    (!first.is_empty()).then(|| first.to_owned())
}
