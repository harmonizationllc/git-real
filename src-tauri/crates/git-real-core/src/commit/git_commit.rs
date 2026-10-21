//! Recording a commit through the system `git` CLI.

use std::path::Path;

use crate::error::GitError;
use crate::git_cli;

/// Runs `git -C <workdir> commit --cleanup=whitespace -F - [--amend]` with
/// `message` on stdin. Hooks, signing and identity fallback are git's.
pub fn run(git: &Path, workdir: &Path, message: &str, amend: bool) -> Result<(), GitError> {
    let mut cmd = git_cli::command(git);
    cmd.arg("-C")
        .arg(workdir)
        .args(["commit", "--cleanup=whitespace", "-F", "-"]);
    if amend {
        cmd.arg("--amend");
    }
    // Git runs the pre-commit hook before it reads the message, and the hook's
    // output fills git's stderr; the runner drains it while writing stdin.
    let output = git_cli::capture_with_input(&mut cmd, message.as_bytes())?;

    if !output.status.success() {
        return Err(GitError::CommitFailed {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}
