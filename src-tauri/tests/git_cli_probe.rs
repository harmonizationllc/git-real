//! The Git executable probe reports a notice when the configured path is gone
//! and the app falls back to the `git` on `PATH`.
//!
//! This is its own test binary because the tests change `PATH` and the
//! process-wide configured path, which would race with any other test that
//! runs git.

#![cfg(unix)]

use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
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

/// Writes an executable `git` in `dir` that prints `git version 9.9.9`. Probes
/// it after writing so a concurrent fork cannot cause ETXTBSY on first exec.
fn fake_git(dir: &Path) -> PathBuf {
    let path = dir.join("git");
    fs::write(
        &path,
        "#!/bin/sh\n[ -n \"$FAKE_GIT_PROBE\" ] && exit 0\necho git version 9.9.9\n",
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    for _ in 0..100 {
        match std::process::Command::new(&path)
            .env("FAKE_GIT_PROBE", "1")
            .status()
        {
            Err(e) if e.raw_os_error() == Some(26) => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => panic!("probing fake git failed: {e}"),
            Ok(_) => break,
        }
    }
    path
}

#[test]
fn check_git_cli_reports_the_fallback_notice_when_the_configured_path_is_missing() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let fake = fake_git(dir.path());
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
    let fake = fake_git(dir.path());
    let empty = tempfile::tempdir().unwrap();
    let _restore = Restore::set_path(empty.path());
    set_configured_path(Some(fake.clone()));

    let info = check_git_cli_inner();

    assert!(info.available);
    assert_eq!(info.path, Some(fake.to_string_lossy().into_owned()));
    assert_eq!(info.error, None);
}
