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
