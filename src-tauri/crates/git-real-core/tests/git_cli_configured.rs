//! Task 2: Failing tests for Git executable override (`set_configured_path`,
//! `configured_path`, `locate`, `verify`) and the new `GitError` variants.
//! Expected to fail to compile until the implementation exists.

#![cfg(unix)]

mod common;

use std::path::PathBuf;
use std::sync::Mutex;

use git_real_core::GitError;
use git_real_core::git_cli::{configured_path, locate, set_configured_path, verify};

/// Serialises tests that touch the process-wide `CONFIGURED` static.
static TEST_LOCK: Mutex<()> = Mutex::new(());

/// Panic-safe guard: on drop resets the configured path to `None`
/// so a panicking test cannot contaminate others.
struct ResetConfigured;

impl Drop for ResetConfigured {
    fn drop(&mut self) {
        set_configured_path(None);
    }
}

/// Writes a fake executable `git` in `dir` that emits `git version 9.9.9`.
fn fake_git_script(dir: &std::path::Path) -> PathBuf {
    common::fake_git(dir, "echo git version 9.9.9")
}

/// Writes a non-git executable in `dir` that emits `hello`.
/// Probes the script after writing (same pattern as `common::fake_git`) so a
/// concurrent fork in another test thread cannot trigger ETXTBSY.
fn non_git_script(dir: &std::path::Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    let path = dir.join("fake_nongit");
    std::fs::write(
        &path,
        "#!/bin/sh\n[ -n \"$FAKE_GIT_PROBE\" ] && exit 0\necho hello\n",
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    for _ in 0..100 {
        match Command::new(&path).env("FAKE_GIT_PROBE", "1").status() {
            Err(e) if e.raw_os_error() == Some(26) => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => panic!("probing non_git_script failed: {e}"),
            Ok(_) => break,
        }
    }
    path
}

// --- locate ---

#[test]
fn locate_prefers_the_configured_path_when_it_is_a_file() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let dir = tempfile::tempdir().unwrap();
    let fake = fake_git_script(dir.path());

    set_configured_path(Some(fake.clone()));
    let result = locate();
    assert_eq!(result.unwrap(), fake);
}

/// Restores `PATH` on drop so a panicking test cannot leak its value.
struct RestorePath(Option<std::ffi::OsString>);

impl RestorePath {
    /// Sets `PATH` to `value`, remembering the previous value.
    fn set(value: &std::path::Path) -> Self {
        let saved = std::env::var_os("PATH");
        // SAFETY: callers hold `TEST_LOCK`, and every test in this binary that
        // reads or writes the environment does too.
        unsafe { std::env::set_var("PATH", value) };
        Self(saved)
    }
}

impl Drop for RestorePath {
    fn drop(&mut self) {
        // SAFETY: see `RestorePath::set`.
        unsafe {
            match &self.0 {
                Some(v) => std::env::set_var("PATH", v),
                None => std::env::remove_var("PATH"),
            }
        }
    }
}

#[test]
fn locate_falls_back_to_path_when_the_configured_file_is_gone() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let dir = tempfile::tempdir().unwrap();
    let fake = fake_git_script(dir.path());
    let _path = RestorePath::set(dir.path());
    set_configured_path(Some(PathBuf::from("/nonexistent/path/to/git-9999")));

    assert_eq!(locate().unwrap(), fake);
}

#[test]
fn locate_fails_with_git_cli_missing_when_configured_is_gone_and_path_has_no_git() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let empty = tempfile::tempdir().unwrap();
    let _path = RestorePath::set(empty.path());
    set_configured_path(Some(PathBuf::from("/nonexistent/path/to/git-9999")));

    assert!(matches!(locate(), Err(GitError::GitCliMissing)));
}

#[test]
fn locate_returns_a_configured_regular_file_even_when_it_is_not_git() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let dir = tempfile::tempdir().unwrap();
    let nongit = non_git_script(dir.path());
    set_configured_path(Some(nongit.clone()));

    assert_eq!(locate().unwrap(), nongit);
    assert!(matches!(
        verify(&nongit),
        Err(GitError::GitCliInvalid { .. })
    ));
}

#[test]
fn locate_ignores_path_while_configured() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let dir = tempfile::tempdir().unwrap();
    let fake = fake_git_script(dir.path());
    set_configured_path(Some(fake.clone()));

    // Even if PATH were empty, the configured path is returned.
    let result = locate();
    assert_eq!(result.unwrap(), fake);
}

#[test]
fn locate_falls_back_to_path_when_unset() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    // Ensure nothing is configured.
    set_configured_path(None);
    assert_eq!(configured_path(), None);

    // With nothing configured, locate() searches PATH: it is Ok or
    // Err(GitCliMissing) depending on whether git is installed, never another error.
    match locate() {
        Ok(_) => {}
        Err(GitError::GitCliMissing) => {}
        Err(e) => panic!("unexpected error when CONFIGURED is None: {:?}", e),
    }
}

// --- verify ---

#[test]
fn verify_returns_the_version_for_a_fake_git() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let dir = tempfile::tempdir().unwrap();
    let fake = fake_git_script(dir.path());
    let version = verify(&fake).unwrap();
    assert_eq!(version, "9.9.9");
}

#[test]
fn verify_rejects_a_non_git_executable() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let dir = tempfile::tempdir().unwrap();
    let nongit = non_git_script(dir.path());
    let err = verify(&nongit).unwrap_err();
    assert!(
        matches!(err, GitError::GitCliInvalid { .. }),
        "expected GitCliInvalid, got {:?}",
        err
    );
}

#[test]
fn verify_maps_a_missing_file_to_git_cli_missing() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let missing = PathBuf::from("/nonexistent/no-such-git-binary");
    let err = verify(&missing).unwrap_err();
    assert!(
        matches!(err, GitError::GitCliMissing),
        "expected GitCliMissing, got {:?}",
        err
    );
}

// --- Review Focus 2: panic-safe guard ---

#[test]
fn a_panicking_test_still_resets_the_override() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Simulate a test that sets the path, then panics.
    let _ = std::panic::catch_unwind(|| {
        let _reset = ResetConfigured;
        set_configured_path(Some(PathBuf::from("/tmp/fake-git-panic")));
        panic!("simulated panic inside a test");
    });
    // After the panic the guard must have reset the path.
    assert_eq!(configured_path(), None);
}
