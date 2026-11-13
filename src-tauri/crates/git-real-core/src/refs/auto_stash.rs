//! Auto-stash around a checkout: when git refuses a switch only because
//! tracked local changes would be overwritten, stash them, switch again and
//! pop the stash on the target. Every failure path leaves the changes in the
//! working tree or in a stash the stash list shows.

use std::path::Path;

use crate::error::GitError;
use crate::model::{AutoStash, AutoStashReapply, StashOutcome};
use crate::refs::switch::{self, SwitchTarget, is_tracked_collision};
use crate::repo::RepoSession;

/// The stash message, so the user can tell an auto-stash from their own.
pub(crate) fn stash_message(label: &str) -> String {
    format!("git-real: auto-stash before switching to {label}")
}

impl RepoSession {
    /// `switch::run`, and on a tracked-collision refusal: stash, switch again, pop.
    /// `label` names the target in the stash message.
    pub(crate) fn switch_auto_stash(
        &self,
        git: &Path,
        workdir: &Path,
        target: SwitchTarget<'_>,
        label: &str,
    ) -> Result<Option<AutoStash>, GitError> {
        let refused = match switch::run(git, workdir, target) {
            Ok(()) => return Ok(None),
            Err(e) => e,
        };
        if !matches!(&refused, GitError::CheckoutFailed { stderr, .. } if is_tracked_collision(stderr))
        {
            return Err(refused);
        }
        if self.stash_push(Some(&stash_message(label)), false).is_err() {
            return Err(refused);
        }
        let Some(oid) = self.stash_tip() else {
            return Err(refused);
        };
        let oid = oid.to_string();
        let files = match self.stash_files(&oid) {
            Ok(f) => f.tracked.len() as u32,
            Err(_) => return Err(self.restore_stash(&oid, refused)),
        };
        if let Err(e) = switch::run(git, workdir, target) {
            return Err(self.restore_stash(&oid, e));
        }

        let (reapply, detail) = match self.stash_pop(0, &oid) {
            Ok(StashOutcome::Applied) => (AutoStashReapply::Applied, None),
            Ok(StashOutcome::Conflicts) => (AutoStashReapply::Conflicts, None),
            Ok(StashOutcome::AppliedNotDropped) => (AutoStashReapply::AppliedNotDropped, None),
            Err(GitError::OperationFailed { stdout, stderr, .. }) => {
                (AutoStashReapply::Kept, Some(pop_output(&stderr, &stdout)))
            }
            Err(e) => (AutoStashReapply::Kept, Some(e.to_string())),
        };
        Ok(Some(AutoStash {
            files,
            reapply,
            detail,
        }))
    }

    /// Pops the auto-stash back onto the unchanged tree and returns `err`; if
    /// that pop fails, the stash stays and `err` becomes `CheckoutFailedStashKept`.
    fn restore_stash(&self, oid: &str, err: GitError) -> GitError {
        if self.stash_pop(0, oid).is_ok() {
            return err;
        }
        match err {
            GitError::CheckoutFailed {
                code,
                stdout,
                stderr,
            } => GitError::CheckoutFailedStashKept {
                code,
                stdout,
                stderr,
            },
            other => GitError::CheckoutFailedStashKept {
                code: None,
                stdout: String::new(),
                stderr: other.to_string(),
            },
        }
    }
}

/// A failed pop's output for the report: stderr then stdout, each trimmed,
/// joined by a newline when both are non-empty.
fn pop_output(stderr: &str, stdout: &str) -> String {
    [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_message_names_the_target() {
        assert_eq!(
            stash_message("feature/x"),
            "git-real: auto-stash before switching to feature/x"
        );
    }

    #[test]
    fn pop_output_joins_the_non_empty_streams() {
        assert_eq!(pop_output(" err \n", "\nout\n"), "err\nout");
        assert_eq!(pop_output("err\n", "  "), "err");
        assert_eq!(pop_output("", "out\n"), "out");
        assert_eq!(pop_output("", ""), "");
    }
}
