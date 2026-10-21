//! Network operations through the system `git` CLI.
//!
//! Per the hybrid backend rule, anything touching the network, credentials, or
//! signing goes through the CLI rather than `git2`.

pub mod clone;
pub mod progress_parser;
pub mod push_delete;
pub mod push_tag;

use std::path::Path;

use crate::error::GitError;
use crate::git_cli;

/// Runs `git -C <workdir> push <remote> <args...>`. A non-zero exit is
/// `PushFailed` carrying git's exit code, stdout and stderr.
pub(crate) fn run_push(
    git: &Path,
    workdir: &Path,
    remote: &str,
    args: &[&str],
) -> Result<(), GitError> {
    let mut cmd = git_cli::command(git);
    cmd.arg("-C")
        .arg(workdir)
        .arg("push")
        .arg(remote)
        .args(args);
    let output = git_cli::capture(&mut cmd)?;
    if output.status.success() {
        return Ok(());
    }
    Err(GitError::PushFailed {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}
