//! Interactive rebase: listing the commits git would replay and running
//! `git rebase -i` with a prepared todo.
//!
//! git reads the todo through `GIT_SEQUENCE_EDITOR`, which is given a `cp`
//! of a temp file we write, so the sequencer, hooks, rerere and signing run
//! exactly as on the command line (ADR 0001).

use std::collections::HashSet;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::PathBuf;

use git2::{Oid, Sort};

use super::git_ops;
use crate::commit::message;
use crate::error::GitError;
use crate::model::{OperationOutcome, RebaseAction, RebaseCommit, RebaseStep};
use crate::repo::RepoSession;
use crate::revision;

impl RepoSession {
    /// The commits `git rebase -i base` would replay, oldest first: the range
    /// `merge_base(HEAD, base)..HEAD`. `base` is a full hex oid or a branch
    /// name. The plan is empty when `base` is HEAD or ahead of it; no common
    /// history is `BadSelection`; a range holding a merge commit is
    /// `MergeCommit`.
    pub fn rebase_plan(&self, base: &str) -> Result<Vec<RebaseCommit>, GitError> {
        Ok(self.plan_range(base)?.1)
    }

    /// Runs `git rebase -i base` with `steps` as the todo, oldest first; git
    /// is given the resolved tip of `base`, so a diverged base is replayed
    /// onto. Steps are validated against the plan before git runs, so an
    /// empty plan (nothing kept) is `BadSelection`.
    pub fn rebase_interactive(
        &self,
        base: &str,
        steps: &[RebaseStep],
    ) -> Result<OperationOutcome, GitError> {
        let (base_oid, plan) = self.plan_range(base)?;
        validate(&plan, steps)?;
        let (git, workdir) = self.git()?;
        let todo = TodoFile::write(&todo_text(&plan, steps))?;
        let editor = format!("cp {}", shell_quote(&todo.path.to_string_lossy()));
        let env = [
            ("GIT_SEQUENCE_EDITOR", editor.as_str()),
            ("GIT_EDITOR", "true"),
        ];
        let base_hex = base_oid.to_string();
        let output = git_ops::run(&git, workdir, "rebase", &["-i", &base_hex], &env);
        drop(todo);
        self.outcome("rebase", &output?)
    }

    /// The resolved tip of `base` and the commits of
    /// `merge_base(HEAD, base)..HEAD`, oldest first.
    fn plan_range(&self, base: &str) -> Result<(Oid, Vec<RebaseCommit>), GitError> {
        self.ensure_clean()?;
        self.ensure_born()?;
        let base_oid = self.resolve_base(base)?;
        let repo = self.repo();
        let head = repo.head()?.peel_to_commit()?.id();
        let fork = match repo.merge_base(head, base_oid) {
            Ok(oid) => oid,
            Err(e) if e.code() == git2::ErrorCode::NotFound => {
                return Err(GitError::BadSelection);
            }
            Err(e) => return Err(e.into()),
        };
        let mut walk = repo.revwalk()?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE)?;
        walk.push(head)?;
        walk.hide(fork)?;
        let mut plan = Vec::new();
        for oid in walk {
            let commit = repo.find_commit(oid?)?;
            if commit.parent_count() > 1 {
                return Err(GitError::MergeCommit(commit.id().to_string()));
            }
            plan.push(RebaseCommit {
                oid: commit.id().to_string(),
                subject: message::split(&String::from_utf8_lossy(commit.message_bytes())).subject,
                author: crate::log::signature(&commit.author()),
            });
        }
        Ok((base_oid, plan))
    }

    /// 40 hex characters name a commit; anything else a local or remote branch.
    fn resolve_base(&self, base: &str) -> Result<Oid, GitError> {
        if base.len() == 40 && base.bytes().all(|b| b.is_ascii_hexdigit()) {
            Ok(revision::resolve_commit(self.repo(), base)?.id())
        } else {
            self.resolve_branch(base)
        }
    }
}

/// Every step names a plan commit once, something is kept, and the first
/// kept step is not a fold (git: "cannot 'squash' without a previous commit").
fn validate(plan: &[RebaseCommit], steps: &[RebaseStep]) -> Result<(), GitError> {
    let known: HashSet<&str> = plan.iter().map(|c| c.oid.as_str()).collect();
    let mut seen = HashSet::new();
    for s in steps {
        if !known.contains(s.oid.as_str()) || !seen.insert(s.oid.as_str()) {
            return Err(GitError::BadSelection);
        }
    }
    match steps.iter().find(|s| s.action != RebaseAction::Drop) {
        None => Err(GitError::BadSelection),
        Some(first) if matches!(first.action, RebaseAction::Squash | RebaseAction::Fixup) => {
            Err(GitError::BadSelection)
        }
        Some(_) => Ok(()),
    }
}

/// The todo keyword git reads for `action`.
fn keyword(action: RebaseAction) -> &'static str {
    match action {
        RebaseAction::Pick => "pick",
        RebaseAction::Squash => "squash",
        RebaseAction::Fixup => "fixup",
        RebaseAction::Edit => "edit",
        RebaseAction::Drop => "drop",
    }
}

/// `<action> <oid> <subject>` per step; git ignores the subject, which is
/// for `git status` and `rebase-merge/done`, so control characters are
/// flattened to spaces to keep one step per line.
fn todo_text(plan: &[RebaseCommit], steps: &[RebaseStep]) -> String {
    let mut text = String::new();
    for s in steps {
        let subject = plan
            .iter()
            .find(|c| c.oid == s.oid)
            .map(|c| c.subject.replace(|ch: char| ch.is_control(), " "))
            .unwrap_or_default();
        // Writing to a String cannot fail.
        let _ = writeln!(text, "{} {} {}", keyword(s.action), s.oid, subject);
    }
    text
}

/// Single-quotes `s` for the POSIX shell git runs the sequence editor with.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A todo file in the temp dir, deleted on drop.
struct TodoFile {
    path: PathBuf,
}

impl TodoFile {
    /// Creates the file exclusively (never following a planted symlink or
    /// claiming an existing file; owner-only on Unix) and writes `text`; the guard owns the path
    /// from the moment the file is ours, so a failed write still removes it.
    fn write(text: &str) -> Result<Self, GitError> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "git-real-rebase-{}-{nanos}.todo",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        let todo = Self { path };
        file.write_all(text.as_bytes())?;
        Ok(todo)
    }
}

impl Drop for TodoFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
