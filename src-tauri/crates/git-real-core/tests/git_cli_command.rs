//! The shared `git_cli::command` builder: locale, prompts and repo env hygiene.

use std::ffi::OsStr;
use std::path::Path;

use git_real_core::git_cli::command;

fn env_of(cmd: &std::process::Command, key: &str) -> Option<Option<String>> {
    cmd.get_envs()
        .find(|(k, _)| *k == OsStr::new(key))
        .map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
}

#[test]
fn command_sets_locale_and_clears_repo_env() {
    let cmd = command(Path::new("/usr/bin/git"));

    assert_eq!(cmd.get_program(), OsStr::new("/usr/bin/git"));
    assert_eq!(env_of(&cmd, "LC_ALL"), Some(Some("C".to_string())));
    assert_eq!(
        env_of(&cmd, "GIT_TERMINAL_PROMPT"),
        Some(Some("0".to_string()))
    );
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_NAMESPACE",
    ] {
        assert_eq!(env_of(&cmd, key), Some(None), "{key} must be removed");
    }
}

/// Child side of the probe below: when `GR_CONSOLE_PROBE` is set, reports how
/// many processes share this process's console, then exits. A process started
/// with `CREATE_NO_WINDOW` gets a fresh windowless console of its own, so the
/// list holds only itself; a process that inherited the parent's console (or
/// has none) reports a different count.
#[cfg(windows)]
#[test]
fn console_probe() {
    if std::env::var_os("GR_CONSOLE_PROBE").is_none() {
        return;
    }
    let mut pids = [0u32; 64];
    // SAFETY: `pids` is a valid, writable buffer of the stated length.
    let count = unsafe {
        windows_sys::Win32::System::Console::GetConsoleProcessList(
            pids.as_mut_ptr(),
            pids.len() as u32,
        )
    };
    println!("console_processes={count}");
}

#[cfg(windows)]
#[test]
fn command_spawns_git_without_a_console_window() {
    let exe = std::env::current_exe().unwrap();
    let mut cmd = command(&exe);
    cmd.args(["console_probe", "--exact", "--nocapture"])
        .env("GR_CONSOLE_PROBE", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = cmd.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "probe failed: {stdout}");
    assert!(
        stdout.lines().any(|l| l.trim() == "console_processes=1"),
        "the child must own a fresh windowless console; got:\n{stdout}"
    );
}

#[test]
fn hide_console_window_keeps_program_and_env() {
    let mut cmd = std::process::Command::new("git");
    cmd.env("LC_ALL", "C");
    git_real_core::git_cli::hide_console_window(&mut cmd);
    assert_eq!(cmd.get_program(), OsStr::new("git"));
    assert_eq!(env_of(&cmd, "LC_ALL"), Some(Some("C".to_string())));
}
