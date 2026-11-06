//! Non-interactive SSH for network operations: ssh must fail fast instead of
//! waiting on a prompt the user cannot see (a hidden console on Windows, no
//! tty on other desktops).

use std::path::Path;
use std::process::Command;

/// The ssh command the app sets when the user has not chosen one.
pub const BATCH_MODE_SSH_COMMAND: &str = "ssh -o BatchMode=yes";

/// Whether the user already decided how ssh runs or prompts. Any `true` means
/// the app leaves `GIT_SSH_COMMAND` alone.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SshSetup {
    /// `GIT_SSH` is set in the environment.
    pub git_ssh_env: bool,
    /// `GIT_SSH_COMMAND` is set in the environment.
    pub git_ssh_command_env: bool,
    /// `SSH_ASKPASS` is set in the environment (a GUI prompt the user wants).
    pub ssh_askpass_env: bool,
    /// `core.sshCommand` is set in git config.
    pub core_ssh_command: bool,
}

impl SshSetup {
    /// Reads the process environment and git config. With `workdir`, the
    /// repository's config (which includes global and system config) is
    /// consulted; without it, `git2::Config::open_default()`. A config that
    /// cannot be opened or read counts as not configured.
    pub fn detect(workdir: Option<&Path>) -> Self {
        let config = match workdir {
            Some(dir) => git2::Repository::open(dir).and_then(|r| r.config()),
            None => git2::Config::open_default(),
        };
        Self {
            git_ssh_env: std::env::var_os("GIT_SSH").is_some(),
            git_ssh_command_env: std::env::var_os("GIT_SSH_COMMAND").is_some(),
            ssh_askpass_env: std::env::var_os("SSH_ASKPASS").is_some(),
            core_ssh_command: config
                .map(|c| c.get_string("core.sshCommand").is_ok())
                .unwrap_or(false),
        }
    }

    /// Whether any field is set, meaning the user chose how ssh runs.
    pub fn user_configured(&self) -> bool {
        self.git_ssh_env
            || self.git_ssh_command_env
            || self.ssh_askpass_env
            || self.core_ssh_command
    }
}

/// Sets `GIT_SSH_COMMAND` to [`BATCH_MODE_SSH_COMMAND`] unless
/// `setup.user_configured()`.
pub fn apply_batch_mode(cmd: &mut Command, setup: &SshSetup) {
    if !setup.user_configured() {
        cmd.env("GIT_SSH_COMMAND", BATCH_MODE_SSH_COMMAND);
    }
}
