//! The Git executable probe reports a notice when the configured path is gone
//! and the app falls back to the `git` on `PATH`.
//!
//! This is its own test binary because the tests change `PATH` and the
//! process-wide configured path, which would race with any other test that
//! runs git.

#![cfg(unix)]

mod common;

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use git_real_core::git_cli::set_configured_path;
use git_real_lib::commands::repo::check_git_cli_inner;

/// Serialises tests that touch `PATH` or the configured path.
static TEST_LOCK: Mutex<()> = Mutex::new(());

/// Resets the configured path and restores `PATH` on drop, even after a panic.
struct Restore(Option<OsString>);

impl Restore {
    fn set_path(value: &Path) -> Self {
        let saved = std::env::var_os("PATH");
        // SAFETY: callers hold `TEST_LOCK`, the only code in this binary that
        // touches the environment.
        unsafe { std::env::set_var("PATH", value) };
        Self(saved)
    }
}

impl Drop for Restore {
    fn drop(&mut self) {
        set_configured_path(None);
        // SAFETY: see `Restore::set_path`.
        unsafe {
            match &self.0 {
                Some(v) => std::env::set_var("PATH", v),
                None => std::env::remove_var("PATH"),
            }
        }
    }
}

#[test]
fn check_git_cli_reports_the_fallback_notice_when_the_configured_path_is_missing() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let fake = common::fake_git(dir.path());
    let _restore = Restore::set_path(dir.path());
    let missing = PathBuf::from("/nonexistent/path/to/git-9999");
    set_configured_path(Some(missing.clone()));

    let info = check_git_cli_inner();

    assert!(info.available);
    assert_eq!(info.path, Some(fake.to_string_lossy().into_owned()));
    assert_eq!(info.version.as_deref(), Some("9.9.9"));
    assert_eq!(
        info.error,
        Some(format!(
            "Configured Git executable not found: {}; using {}",
            missing.display(),
            fake.display()
        ))
    );
}

#[test]
fn check_git_cli_has_no_notice_when_the_configured_path_is_used() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let fake = common::fake_git(dir.path());
    let empty = tempfile::tempdir().unwrap();
    let _restore = Restore::set_path(empty.path());
    set_configured_path(Some(fake.clone()));

    let info = check_git_cli_inner();

    assert!(info.available);
    assert_eq!(info.path, Some(fake.to_string_lossy().into_owned()));
    assert_eq!(info.error, None);
}

#[test]
fn check_git_cli_keeps_the_verify_error_when_the_path_git_is_broken() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let broken = common::fake_git(dir.path());
    fs::write(&broken, "#!/bin/sh\nexit 1\n").unwrap();
    let _restore = Restore::set_path(dir.path());
    set_configured_path(Some(PathBuf::from("/nonexistent/path/to/git-9999")));

    let info = check_git_cli_inner();

    assert!(!info.available);
    let error = info.error.expect("the probe error is kept");
    assert!(
        !error.starts_with("Configured Git executable not found"),
        "notice hid the probe error: {error}"
    );
}
