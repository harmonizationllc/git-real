//! Network operations through the system `git` CLI, and remote configuration
//! through git2 (`remotes`).
//!
//! Per the hybrid backend rule, anything touching the network, credentials, or
//! signing goes through the CLI rather than `git2`; the remote config and refs
//! are local, so they go through `git2`.

pub mod auth;
pub mod classify;
pub mod clone;
pub mod fetch;
pub mod progress_parser;
pub mod pull;
pub mod push;
pub mod push_delete;
pub mod push_tag;
pub(crate) mod remotes;

use std::path::Path;

use crate::error::GitError;
use crate::git_cli;
use crate::model::NetworkErrorKind;
use auth::Credentials;

/// Runs `git -C <workdir> [credential args] <args...>` for a network
/// operation. A non-zero exit is `NetworkFailed`; after a successful run with
/// credentials, each of `urls` on the credentials' origin is approved.
pub(crate) fn run_network(
    git: &Path,
    workdir: &Path,
    verb: &'static str,
    args: &[&str],
    urls: &[String],
    creds: Option<&Credentials>,
) -> Result<(), GitError> {
    let mut cmd = git_cli::command(git);
    cmd.arg("-C").arg(workdir);
    auth::apply(&mut cmd, creds);
    cmd.args(args);
    let output = git_cli::capture(&mut cmd)?;
    if output.status.success() {
        if let Some(c) = creds {
            for url in urls.iter().filter(|u| c.covers(u)) {
                auth::approve(git, workdir, url, c);
            }
        }
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let kind = classify::classify(&stderr);
    let auth = matches!(
        kind,
        NetworkErrorKind::HttpsAuthRequired | NetworkErrorKind::HttpsAuthRejected
    );
    Err(GitError::NetworkFailed {
        verb,
        kind,
        https: urls.iter().any(|u| auth::is_http(u)),
        origin: if auth {
            classify::auth_origin(&stderr)
        } else {
            None
        },
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr,
    })
}

/// `git push <remote> <args...>` through [`run_network`] with verb `push`.
pub(crate) fn run_push(
    git: &Path,
    workdir: &Path,
    remote: &str,
    args: &[&str],
    urls: &[String],
    creds: Option<&Credentials>,
) -> Result<(), GitError> {
    let mut argv = vec!["push", remote];
    argv.extend_from_slice(args);
    run_network(git, workdir, "push", &argv, urls, creds)
}
