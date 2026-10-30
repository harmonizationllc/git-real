//! Cloning a repository through the system `git` CLI.

use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::error::GitError;
use crate::git_cli;
use crate::paths::canonical;
use crate::progress::ProgressSink;
use crate::remote::auth::{self, Credentials};
use crate::remote::progress_parser::{LineBuffer, parse_line};

/// Clones `url` into `dest` using the `git` found on `PATH`.
pub fn clone(
    url: &str,
    dest: &Path,
    creds: Option<&Credentials>,
    sink: &mut dyn ProgressSink,
) -> Result<PathBuf, GitError> {
    clone_with(&git_cli::locate()?, url, dest, creds, sink)
}

/// Clones `url` into `dest` using the given `git` executable, reporting
/// progress parsed from its stderr. `creds` go through the inline helper
/// ([`auth::apply`]); there is no prompt-and-retry.
pub fn clone_with(
    git: &Path,
    url: &str,
    dest: &Path,
    creds: Option<&Credentials>,
    sink: &mut dyn ProgressSink,
) -> Result<PathBuf, GitError> {
    let mut cmd = git_cli::command(git);
    auth::apply(&mut cmd, creds);
    let mut child = cmd
        .args(["clone", "--progress", "--"])
        .arg(url)
        .arg(dest)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;

    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("child stderr was not captured"))?;

    let mut raw = Vec::new();
    let mut lines = LineBuffer::default();
    let mut buf = [0u8; 4096];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                report_lines(lines.push(&buf[..n]), sink);
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.into());
            }
        }
    }
    report_lines(lines.finish(), sink);

    let status = child.wait()?;
    if !status.success() {
        return Err(GitError::CloneFailed {
            code: status.code(),
            stderr: String::from_utf8_lossy(&raw).into_owned(),
        });
    }
    Ok(canonical(dest)?)
}

fn report_lines(lines: Vec<String>, sink: &mut dyn ProgressSink) {
    lines
        .iter()
        .filter_map(|line| parse_line(line))
        .for_each(|progress| sink.report(progress));
}
