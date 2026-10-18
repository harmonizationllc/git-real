//! Switching branches through the system `git` CLI so hooks, submodules and
//! git's safety checks behave exactly as on the command line (ADR 0001).

use std::path::Path;

use crate::error::GitError;
use crate::git_cli;

/// What `git switch` moves HEAD to. Names must already be validated.
pub(crate) enum SwitchTarget<'a> {
    /// `git switch <name>`
    Local(&'a str),
    /// `git switch -c <name> --track <upstream>`, with `upstream` a full refname.
    NewTracking { name: &'a str, upstream: &'a str },
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
