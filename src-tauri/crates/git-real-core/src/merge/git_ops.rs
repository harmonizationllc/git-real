//! The git CLI runner behind merge, rebase, cherry-pick and revert.

use std::path::Path;
use std::process::Output;

use crate::error::GitError;
use crate::git_cli;

/// Runs `git -C <workdir> <verb> <args...>` with `env` applied, stdin closed
/// and output captured. A non-zero exit is returned as-is for the caller to
/// classify; failing to spawn `git` is `GitError::Io`.
pub(crate) fn run(
    git: &Path,
    workdir: &Path,
    verb: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<Output, GitError> {
    let mut cmd = git_cli::command(git);
    cmd.arg("-C").arg(workdir).arg(verb).args(args);
    for (key, value) in env {
        cmd.env(key, value);
    }
    Ok(git_cli::capture(&mut cmd)?)
}
