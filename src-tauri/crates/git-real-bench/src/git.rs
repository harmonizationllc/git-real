//! Git CLI access for the bench crate, always through `git_real_core::git_cli`.

use std::fmt;
use std::path::Path;

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
    todo!()
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
