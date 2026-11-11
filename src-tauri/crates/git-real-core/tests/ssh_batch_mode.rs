//! Network operations run ssh non-interactively unless the user chose a setup.

use std::ffi::OsStr;
use std::process::Command;

use git_real_core::remote::ssh::{
    BATCH_MODE_SSH_COMMAND, SshSetup, apply_batch_mode, apply_batch_mode_non_interactive,
};

fn env_of(cmd: &Command, key: &str) -> Option<Option<String>> {
    cmd.get_envs()
        .find(|(k, _)| *k == OsStr::new(key))
        .map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
}

#[test]
fn apply_batch_mode_sets_git_ssh_command_when_nothing_is_configured() {
    let mut cmd = Command::new("git");
    apply_batch_mode(&mut cmd, &SshSetup::default());
    assert_eq!(BATCH_MODE_SSH_COMMAND, "ssh -o BatchMode=yes");
    assert_eq!(
        env_of(&cmd, "GIT_SSH_COMMAND"),
        Some(Some("ssh -o BatchMode=yes".to_string()))
    );
}

#[test]
fn apply_batch_mode_leaves_a_user_ssh_setup_alone() {
    let setups = [
        SshSetup {
            git_ssh_env: true,
            ..SshSetup::default()
        },
        SshSetup {
            git_ssh_command_env: true,
            ..SshSetup::default()
        },
        SshSetup {
            ssh_askpass_env: true,
            ..SshSetup::default()
        },
        SshSetup {
            core_ssh_command: true,
            ..SshSetup::default()
        },
    ];
    for setup in setups {
        let mut cmd = Command::new("git");
        apply_batch_mode(&mut cmd, &setup);
        assert_eq!(env_of(&cmd, "GIT_SSH_COMMAND"), None, "{setup:?}");
    }
}

#[test]
fn detect_sees_core_ssh_command_in_the_repository_config() {
    let with = tempfile::tempdir().unwrap();
    git2::Repository::init(with.path())
        .unwrap()
        .config()
        .unwrap()
        .set_str("core.sshCommand", "plink")
        .unwrap();
    assert!(SshSetup::detect(Some(with.path())).core_ssh_command);

    let without = tempfile::tempdir().unwrap();
    git2::Repository::init(without.path()).unwrap();
    assert!(!SshSetup::detect(Some(without.path())).core_ssh_command);
}

#[test]
fn user_configured_is_true_for_any_field() {
    assert!(!SshSetup::default().user_configured());
    for setup in [
        SshSetup {
            git_ssh_env: true,
            ..SshSetup::default()
        },
        SshSetup {
            git_ssh_command_env: true,
            ..SshSetup::default()
        },
        SshSetup {
            ssh_askpass_env: true,
            ..SshSetup::default()
        },
        SshSetup {
            core_ssh_command: true,
            ..SshSetup::default()
        },
    ] {
        assert!(setup.user_configured(), "{setup:?}");
    }
}

#[test]
fn non_interactive_batch_mode_overrides_an_ssh_askpass_prompt() {
    let mut cmd = Command::new("git");
    apply_batch_mode_non_interactive(
        &mut cmd,
        &SshSetup {
            ssh_askpass_env: true,
            ..SshSetup::default()
        },
    );
    assert_eq!(
        env_of(&cmd, "GIT_SSH_COMMAND"),
        Some(Some(BATCH_MODE_SSH_COMMAND.to_string()))
    );
}

#[test]
fn non_interactive_batch_mode_sets_the_command_when_nothing_is_configured() {
    let mut cmd = Command::new("git");
    apply_batch_mode_non_interactive(&mut cmd, &SshSetup::default());
    assert_eq!(
        env_of(&cmd, "GIT_SSH_COMMAND"),
        Some(Some(BATCH_MODE_SSH_COMMAND.to_string()))
    );
}

#[test]
fn non_interactive_batch_mode_still_respects_an_explicit_ssh_command() {
    for setup in [
        SshSetup {
            git_ssh_env: true,
            ssh_askpass_env: true,
            ..SshSetup::default()
        },
        SshSetup {
            git_ssh_command_env: true,
            ssh_askpass_env: true,
            ..SshSetup::default()
        },
        SshSetup {
            core_ssh_command: true,
            ssh_askpass_env: true,
            ..SshSetup::default()
        },
    ] {
        let mut cmd = Command::new("git");
        apply_batch_mode_non_interactive(&mut cmd, &setup);
        assert_eq!(env_of(&cmd, "GIT_SSH_COMMAND"), None, "{setup:?}");
    }
}
