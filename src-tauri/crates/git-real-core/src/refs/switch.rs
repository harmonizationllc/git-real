//! Switching branches through the system `git` CLI so hooks, submodules and
//! git's safety checks behave exactly as on the command line (ADR 0001).

use std::path::Path;

use crate::error::GitError;
use crate::git_cli;

/// The phrase of git's refusal when tracked local changes would be overwritten.
pub(crate) const TRACKED_COLLISION: &str =
    "Your local changes to the following files would be overwritten";
/// The phrase of git's refusal when untracked files would be overwritten.
pub(crate) const UNTRACKED_COLLISION: &str = "untracked working tree files would be overwritten";

/// True only for a refusal caused solely by tracked local changes.
#[allow(dead_code)] // consumed by the auto-stash switch in the next commit
pub(crate) fn is_tracked_collision(stderr: &str) -> bool {
    stderr.contains(TRACKED_COLLISION) && !stderr.contains(UNTRACKED_COLLISION)
}

/// What `git switch` moves HEAD to. Names must already be validated.
#[derive(Clone, Copy)]
pub(crate) enum SwitchTarget<'a> {
    /// `git switch <name>`
    Local(&'a str),
    /// `git switch -c <name> --track <upstream>`, with `upstream` a full refname.
    NewTracking { name: &'a str, upstream: &'a str },
    /// `git switch --detach <oid>`, with `oid` the full hex of a commit.
    Detach(&'a str),
    /// `git switch -C <name> <oid>`: create `name`, or move it, at the commit `oid` (full hex).
    Reset { name: &'a str, oid: &'a str },
}

/// Runs `git -C <workdir> switch ...`; a non-zero exit is `CheckoutFailed`
/// carrying git's output.
pub(crate) fn run(git: &Path, workdir: &Path, target: SwitchTarget<'_>) -> Result<(), GitError> {
    let mut cmd = git_cli::command(git);
    cmd.arg("-C").arg(workdir).arg("switch");
    match target {
        SwitchTarget::Local(name) => {
            cmd.arg(name);
        }
        SwitchTarget::NewTracking { name, upstream } => {
            cmd.args(["-c", name, "--track", upstream]);
        }
        SwitchTarget::Detach(oid) => {
            cmd.args(["--detach", oid]);
        }
        SwitchTarget::Reset { name, oid } => {
            cmd.args(["-C", name, oid]);
        }
    }
    let output = git_cli::capture(&mut cmd)?;
    if !output.status.success() {
        return Err(GitError::CheckoutFailed {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracked_only_refusal_is_a_collision() {
        let stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\tREADME.md\nPlease commit your changes or stash them before you switch branches.\nAborting\n";
        assert!(is_tracked_collision(stderr));
    }

    #[test]
    fn untracked_only_refusal_is_not() {
        let stderr = "error: The following untracked working tree files would be overwritten by checkout:\n\tf.txt\nPlease move or remove them before you switch branches.\nAborting\n";
        assert!(!is_tracked_collision(stderr));
    }

    #[test]
    fn tracked_plus_untracked_refusal_is_not() {
        let stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\tt.txt\nerror: The following untracked working tree files would be overwritten by checkout:\n\tf.txt\nAborting\n";
        assert!(!is_tracked_collision(stderr));
    }

    #[test]
    fn other_stderr_is_not() {
        assert!(!is_tracked_collision("fatal: invalid reference: ghost\n"));
        assert!(!is_tracked_collision(""));
    }
}
