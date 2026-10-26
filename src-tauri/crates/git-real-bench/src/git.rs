//! Git CLI access for the bench crate, always through `git_real_core::git_cli`.

use std::fmt;
use std::io::{self, Write};
use std::path::Path;
use std::process::{Output, Stdio};
use std::thread;

use git_real_core::git_cli;

/// A failure the bench reports as `error: <message>` (exit 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BenchError(String);

impl BenchError {
    pub fn new(message: impl Into<String>) -> Self {
        BenchError(message.into())
    }
}

impl fmt::Display for BenchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for BenchError {}

/// Runs `git <args>` in `cwd` and returns stdout. A non-zero exit becomes
/// `git <args joined by a space> failed: <stderr>`; a missing git becomes
/// `git is required to prepare fixtures`.
pub fn run_git(args: &[&str], cwd: &Path) -> Result<String, BenchError> {
    let mut cmd = git_command(args, cwd)?;
    let output = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| failed(args, &e.to_string()))?;
    finish(args, output)
}

/// `run_git` with `input` written to git's stdin (for `fast-import` and
/// `update-ref --stdin`). Stdin is fed on its own thread so a full stdout or
/// stderr pipe cannot deadlock the two processes.
pub fn run_git_with_input(args: &[&str], cwd: &Path, input: &[u8]) -> Result<String, BenchError> {
    let mut cmd = git_command(args, cwd)?;
    let mut child = cmd
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| failed(args, &e.to_string()))?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let output = thread::scope(|scope| {
        scope.spawn(move || {
            // A broken pipe means git exited early; its stderr says why.
            match stdin.write_all(input) {
                Err(e) if e.kind() != io::ErrorKind::BrokenPipe => Err(e),
                _ => Ok(()),
            }
        });
        child.wait_with_output()
    })
    .map_err(|e| failed(args, &e.to_string()))?;
    finish(args, output)
}

fn git_command(args: &[&str], cwd: &Path) -> Result<std::process::Command, BenchError> {
    let git =
        git_cli::locate().map_err(|_| BenchError::new("git is required to prepare fixtures"))?;
    let mut cmd = git_cli::command(&git);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(cmd)
}

fn finish(args: &[&str], output: Output) -> Result<String, BenchError> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(failed(args, &String::from_utf8_lossy(&output.stderr)))
    }
}

fn failed(args: &[&str], stderr: &str) -> BenchError {
    BenchError::new(format!("git {} failed: {}", args.join(" "), stderr.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{git_available, git_available_with};

    // run_git: stdout comes back, failures name the arguments and stderr.
    #[test]
    fn run_git_reports_version() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let out = run_git(&["--version"], dir.path()).unwrap();
        assert!(out.starts_with("git version "), "got {out:?}");
    }

    #[test]
    fn failed_command_includes_args_and_stderr() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let err = run_git(&["rev-parse", "--git-dir"], dir.path())
            .unwrap_err()
            .to_string();
        assert!(
            err.starts_with("git rev-parse --git-dir failed: "),
            "got {err:?}"
        );
    }

    #[test]
    fn failed_command_carries_non_empty_stderr() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let err = run_git(&["rev-parse", "--git-dir"], dir.path())
            .unwrap_err()
            .to_string();
        let stderr = err.trim_start_matches("git rev-parse --git-dir failed: ");
        assert!(!stderr.trim().is_empty(), "got {err:?}");
    }

    // The shared opt-out policy (same as git-real-core's test helper).
    #[test]
    fn git_available_honours_opt_out() {
        assert!(!git_available_with(false, Some("1")));
    }

    #[test]
    #[should_panic(expected = "git not on PATH")]
    fn git_available_panics_without_git_and_without_opt_out() {
        git_available_with(false, None);
    }

    #[test]
    fn git_available_is_true_when_found() {
        assert!(git_available_with(true, None));
    }

    #[test]
    fn bench_error_displays_its_message() {
        assert_eq!(BenchError::new("boom").to_string(), "boom");
    }
}
