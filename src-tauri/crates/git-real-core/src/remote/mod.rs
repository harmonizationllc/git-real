//! Network operations through the system `git` CLI, remote configuration
//! through git2 (`remotes`), and the local reads behind pull requests
//! (`pr_checkout`, `pr_draft`).
//!
//! Per the hybrid backend rule, anything touching the network, credentials, or
//! signing goes through the CLI rather than `git2`; the remote config and refs
//! are local, so they go through `git2`.

pub mod auth;
pub mod classify;
pub mod clone;
pub mod fetch;
pub mod host;
pub mod pr_checkout;
pub mod pr_draft;
pub mod progress_parser;
pub mod pull;
pub mod push;
pub mod push_delete;
pub mod push_tag;
pub(crate) mod remotes;
pub mod ssh;

use std::path::Path;

use crate::error::GitError;
use crate::git_cli;
use crate::model::{NetworkDetail, NetworkErrorKind};
use auth::Credentials;

/// Runs `git -C <workdir> [credential args] <args...>` for a network
/// operation. A non-zero exit is `NetworkFailed`; after a successful run with
/// credentials that [`Credentials::approves`], each of `urls` on their origin is
/// approved.
///
/// `non_interactive` (the background auto-fetch) forbids every prompt for this
/// one process: the user's credential helper is told not to interact
/// (`credential.interactive=false`, `GCM_INTERACTIVE=never`), ssh-askpass is
/// refused (`SSH_ASKPASS_REQUIRE=never`) and ssh runs in batch mode even when
/// `SSH_ASKPASS` is set. An explicit ssh command is still respected.
pub(crate) fn run_network(
    git: &Path,
    workdir: &Path,
    verb: &'static str,
    args: &[&str],
    urls: &[String],
    creds: Option<&Credentials>,
    non_interactive: bool,
) -> Result<(), GitError> {
    let mut cmd = git_cli::command(git);
    let setup = ssh::SshSetup::detect(Some(workdir));
    if non_interactive {
        ssh::apply_batch_mode_non_interactive(&mut cmd, &setup);
        cmd.env("GCM_INTERACTIVE", "never")
            .env("SSH_ASKPASS_REQUIRE", "never");
    } else {
        ssh::apply_batch_mode(&mut cmd, &setup);
    }
    cmd.arg("-C").arg(workdir);
    if non_interactive {
        cmd.args(["-c", "credential.interactive=false"]);
    }
    auth::apply(&mut cmd, creds);
    cmd.args(args);
    let output = git_cli::capture(&mut cmd)?;
    if output.status.success() {
        if let Some(c) = creds.filter(|c| c.approves()) {
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
    let host = match kind {
        NetworkErrorKind::SshAuthFailed | NetworkErrorKind::HostKeyUnverified => {
            let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
            host::ssh_host(&stderr, &urls)
        }
        _ => None,
    };
    let reason = match kind {
        NetworkErrorKind::RemoteRejected => classify::rejection_reason(&stderr),
        _ => None,
    };
    Err(GitError::NetworkFailed {
        verb,
        kind,
        https: urls.iter().any(|u| auth::is_http(u)),
        origin: if auth {
            classify::auth_origin(&stderr)
        } else {
            None
        },
        detail: Box::new(NetworkDetail { host, reason }),
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
    run_network(git, workdir, "push", &argv, urls, creds, false)
}
