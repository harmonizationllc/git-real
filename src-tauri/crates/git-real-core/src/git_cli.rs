//! Locating and invoking the system `git` executable.

use std::env;
use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, PoisonError, RwLock};
use std::thread;

use crate::error::GitError;

/// A process-wide override for the git executable. When set, [`locate`] returns
/// it instead of searching `PATH`. It is poison-tolerant: a panic while the lock
/// is held still leaves a readable value.
static CONFIGURED: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Sets (or clears, with `None`) the configured git executable path.
pub fn set_configured_path(path: Option<PathBuf>) {
    *CONFIGURED.write().unwrap_or_else(PoisonError::into_inner) = path;
}

/// The configured git executable path, if one is set.
pub fn configured_path() -> Option<PathBuf> {
    CONFIGURED
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

#[cfg(windows)]
const CANDIDATES: [&str; 2] = ["git.exe", "git"];
#[cfg(not(windows))]
const CANDIDATES: [&str; 1] = ["git"];

/// Variables that point git at a repository. git2 ignores them, so an
/// inherited value would make the CLI act on a different repository.
const REPO_ENV: [&str; 7] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
];

/// A `git` command with a stable locale, no terminal prompts, and no
/// inherited repository-locating environment.
pub fn command(git: &Path) -> Command {
    let mut cmd = Command::new(git);
    cmd.env("LC_ALL", "C").env("GIT_TERMINAL_PROMPT", "0");
    for key in REPO_ENV {
        cmd.env_remove(key);
    }
    cmd
}

/// The configured path last reported missing, so [`locate`] logs each distinct
/// missing path once instead of on every call.
static WARNED: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Logs (once per distinct path) that the configured executable is gone.
fn warn_configured_missing(configured: &Path) {
    let mut warned = WARNED.lock().unwrap_or_else(PoisonError::into_inner);
    if warned.as_deref() != Some(configured) {
        eprintln!(
            "git: configured executable {} not found; using PATH",
            configured.display()
        );
        *warned = Some(configured.to_path_buf());
    }
}

/// Finds the git executable: the configured override when it is a file,
/// otherwise the first `git` on `PATH`. A configured path that no longer exists
/// is logged once and skipped rather than treated as an error.
pub fn locate() -> Result<PathBuf, GitError> {
    if let Some(configured) = configured_path() {
        if configured.is_file() {
            return Ok(configured);
        }
        warn_configured_missing(&configured);
    }
    env::var_os("PATH")
        .and_then(locate_in)
        .ok_or(GitError::GitCliMissing)
}

/// Checks that `path` is a working git by reading `git --version`. Returns the
/// version string after `git version ` (e.g. `2.43.0`). A spawn failure maps to
/// [`GitError::GitCliMissing`]; a non-zero exit or unexpected output maps to
/// [`GitError::GitCliInvalid`].
pub fn verify(path: &Path) -> Result<String, GitError> {
    let mut cmd = command(path);
    cmd.arg("--version");
    let output = match capture(&mut cmd) {
        Ok(output) => output,
        Err(_) => return Err(GitError::GitCliMissing),
    };
    if !output.status.success() {
        let message = match output.status.code() {
            Some(code) => format!("exited with code {code}"),
            None => "terminated by a signal".to_owned(),
        };
        return Err(GitError::GitCliInvalid { message });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    match trimmed.strip_prefix("git version ") {
        Some(version) => Ok(version.trim().to_owned()),
        None => Err(GitError::GitCliInvalid {
            message: format!("unexpected output: {trimmed}"),
        }),
    }
}

/// Finds `git` in the given `PATH`-style list.
///
/// Empty and relative entries are skipped so the current directory is never
/// searched.
pub fn locate_in(path_var: impl AsRef<OsStr>) -> Option<PathBuf> {
    env::split_paths(path_var.as_ref())
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| CANDIDATES.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

/// Runs `cmd` with stdin closed and stdout and stderr captured.
pub(crate) fn capture(cmd: &mut Command) -> std::io::Result<Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
}

/// Runs `cmd` with `input` on stdin and stdout and stderr captured.
///
/// stdin is written on its own thread while the output drains, so neither
/// pipe can fill up and block both processes (a hook can print a lot before
/// git reads its input). git may exit before reading at all (a failing hook);
/// the resulting EPIPE is not the error worth reporting.
pub(crate) fn capture_with_input(cmd: &mut Command, input: &[u8]) -> io::Result<Output> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("child stdin was not captured"))?;
    let (written, output) = thread::scope(|s| {
        let writer = s.spawn(move || match stdin.write_all(input) {
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Ok(()),
            result => result, // dropping `stdin` closes it, so git sees EOF
        });
        let output = child.wait_with_output();
        (writer.join(), output)
    });
    let output = output?;
    written.map_err(|_| io::Error::other("the stdin writer thread panicked"))??;
    Ok(output)
}
