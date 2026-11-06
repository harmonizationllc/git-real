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

/// Runs the probe child through `cmd` and returns the console process count it reports.
#[cfg(windows)]
fn probe_count(mut cmd: std::process::Command) -> u32 {
    cmd.args(["console_probe", "--exact", "--nocapture"])
        .env("GR_CONSOLE_PROBE", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = cmd.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "probe failed: {stdout}");
    // libtest may print `test console_probe ... ` on the same line when it runs
    // single-threaded, so the marker is searched for inside each line.
    stdout
        .lines()
        .find_map(|l| l.split("console_processes=").nth(1))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("no console_processes marker in:\n{stdout}"))
}

#[cfg(windows)]
#[test]
fn command_spawns_git_without_a_console_window() {
    let exe = std::env::current_exe().unwrap();
    // Control: a plain spawn inherits the test runner's console, which the
    // runner (and cargo) already share, so the count is 2 or more. Without this
    // the flagged assertion below could pass on a runner that has no console.
    let plain = probe_count(std::process::Command::new(&exe));
    assert_ne!(
        plain, 1,
        "precondition: a plain child must share the runner's console or have none"
    );
    assert_eq!(
        probe_count(command(&exe)),
        1,
        "the child must own a fresh windowless console"
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
