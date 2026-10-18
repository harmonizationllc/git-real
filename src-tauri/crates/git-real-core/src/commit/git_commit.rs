//! Recording a commit through the system `git` CLI.

use std::io::{self, Write};
use std::path::Path;
use std::process::{ChildStdin, Stdio};
use std::thread;

use crate::error::GitError;
use crate::remote::git_cli;

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
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("child stdin was not captured"))?;

    // Git runs the pre-commit hook before it reads the message, and the hook's
    // output fills git's stderr. Writing stdin while the output drains keeps
    // either pipe from filling up and blocking both processes.
    let (written, output) = thread::scope(|s| {
        let writer = s.spawn(move || write_message(stdin, message));
        let output = child.wait_with_output();
        (writer.join(), output)
    });
    let output = output?;
    written.map_err(|_| io::Error::other("the stdin writer thread panicked"))??;

    if !output.status.success() {
        return Err(GitError::CommitFailed {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}

/// Writes the message and closes stdin so git sees EOF.
///
/// Git exits before reading the message when a pre-commit hook fails; the
/// resulting EPIPE is not the error worth reporting.
fn write_message(mut stdin: ChildStdin, message: &str) -> io::Result<()> {
    match stdin.write_all(message.as_bytes()) {
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        result => result,
    }
}
