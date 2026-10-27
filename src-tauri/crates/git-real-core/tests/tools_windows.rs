//! GR-20 Task 4: checks that only a Windows host can run (cmd.exe, creation
//! flags). Compiles to an empty test binary elsewhere.

#![cfg(windows)]

use std::path::Path;
use std::time::{Duration, Instant};

use git_real_core::{CommandSyntax, ToolEnv, open_in_editor_with};

#[test]
fn a_bare_name_resolves_to_a_cmd_file_on_path_and_runs_through_cmd_exe() {
    let dir = tempfile::tempdir().unwrap();
    let argv = dir.path().join("argv.txt");
    let script = format!("@echo %* > \"{}\"\r\n", argv.display());
    std::fs::write(dir.path().join("code.cmd"), script).unwrap();

    let env = ToolEnv {
        path: dir.path().as_os_str().to_owned(),
        pathext: ".COM;.EXE;.BAT;.CMD".into(),
    };
    open_in_editor_with(
        CommandSyntax::Windows,
        &env,
        "code --wait",
        Path::new(r"C:\f.txt"),
        None,
    )
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    let text = loop {
        // The file may exist before cmd.exe has written its contents.
        if let Ok(t) = std::fs::read_to_string(&argv) {
            if t.contains("--wait") {
                break t;
            }
        }
        assert!(Instant::now() < deadline, "argv.txt never appeared");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(text.contains(r"--wait C:\f.txt"), "argv text: {text:?}");
}

#[test]
fn a_console_program_spawns_without_blocking() {
    let env = ToolEnv::from_process();
    open_in_editor_with(
        CommandSyntax::Windows,
        &env,
        "cmd /c exit",
        Path::new("0"),
        None,
    )
    .unwrap();
}

#[test]
fn from_process_reads_pathext() {
    assert!(!ToolEnv::from_process().pathext.is_empty());
}
