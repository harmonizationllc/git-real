//! GR-20 Tasks 3 and 4: host-independent tests for the command splitter's
//! syntax parameter and the Windows program resolver. Not gated by a cfg:
//! nothing here depends on the host OS.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use git_real_core::{
    CommandSyntax, DEFAULT_PATHEXT, ToolEnv, ToolError, resolve_program, split_command,
    split_command_with,
};

fn owned(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn windows_syntax_table() {
    let cases: &[(&str, &[&str])] = &[
        ("code --wait", &["code", "--wait"]),
        (
            r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe --wait",
            &[
                r"C:\Users\me\AppData\Local\Programs\Microsoft",
                "VS",
                r"Code\Code.exe",
                "--wait",
            ],
        ),
        (
            r#""C:\Program Files\Microsoft VS Code\Code.exe" --wait"#,
            &[r"C:\Program Files\Microsoft VS Code\Code.exe", "--wait"],
        ),
        (r#"a"b c"d"#, &["ab cd"]),
        // 2 backslashes + quote: 1 backslash, and the quote toggles quoting
        (r#"\\"x""#, &[r"\x"]),
        // 3 backslashes + quote: 1 backslash and a literal quote
        (r#""a\\\"b""#, &[r#"a\"b"#]),
        // "" inside a quoted span is a literal quote
        (r#""a""b""#, &[r#"a"b"#]),
        // single quotes are ordinary characters
        ("'a b'", &["'a", "b'"]),
        ("a\tb", &["a", "b"]),
        (r#""""#, &[""]),
    ];
    for (input, expected) in cases {
        assert_eq!(
            split_command_with(CommandSyntax::Windows, input).unwrap(),
            owned(expected),
            "input {input:?}"
        );
    }
}

#[test]
fn windows_syntax_errors() {
    assert_eq!(
        split_command_with(CommandSyntax::Windows, "  \t ").unwrap_err(),
        ToolError::EmptyCommand
    );
    assert_eq!(
        split_command_with(CommandSyntax::Windows, r#""abc"#).unwrap_err(),
        ToolError::UnterminatedQuote
    );
    // A trailing backslash inside quotes escapes the closing quote.
    assert_eq!(
        split_command_with(CommandSyntax::Windows, r#""C:\Program Files\""#).unwrap_err(),
        ToolError::UnterminatedQuote
    );
}

#[test]
fn posix_syntax_is_unchanged() {
    // The same eight rows as `split_command_table` in tests/tools.rs.
    let cases: &[(&str, &[&str])] = &[
        ("code --wait", &["code", "--wait"]),
        (r#"meld "$LOCAL" "$REMOTE""#, &["meld", "$LOCAL", "$REMOTE"]),
        ("'a b' c", &["a b", "c"]),
        (r"a\ b", &["a b"]),
        (r#""a\"b""#, &["a\"b"]),
        (r"'a\b'", &[r"a\b"]),
        (r#""""#, &[""]),
        (r"\", &["\\"]),
    ];
    for (input, expected) in cases {
        assert_eq!(
            split_command_with(CommandSyntax::Posix, input).unwrap(),
            owned(expected),
            "input {input:?}"
        );
    }
    assert_eq!(
        split_command_with(CommandSyntax::Posix, "   ").unwrap_err(),
        ToolError::EmptyCommand
    );
    assert_eq!(
        split_command_with(CommandSyntax::Posix, "'abc").unwrap_err(),
        ToolError::UnterminatedQuote
    );
}

#[cfg(not(windows))]
#[test]
fn native_syntax_is_posix_off_windows() {
    assert_eq!(CommandSyntax::native(), CommandSyntax::Posix);
    assert_eq!(split_command("'a b'").unwrap(), vec!["a b".to_string()]);
}

#[cfg(windows)]
#[test]
fn native_syntax_is_windows_on_windows() {
    assert_eq!(CommandSyntax::native(), CommandSyntax::Windows);
    assert_eq!(
        split_command(r"C:\x\y.exe").unwrap(),
        vec![r"C:\x\y.exe".to_string()]
    );
}

// ─── resolve_program ─────────────────────────────────────────────────────────

fn env(path: &str, pathext: &str) -> ToolEnv {
    ToolEnv {
        path: path.into(),
        pathext: pathext.into(),
    }
}

fn files(list: &[&str]) -> impl Fn(&Path) -> bool {
    let set: HashSet<String> = list.iter().map(|s| s.to_string()).collect();
    move |p: &Path| set.contains(p.to_string_lossy().as_ref())
}

#[test]
fn resolve_program_finds_a_cmd_launcher_through_pathext() {
    let f = files(&[r"C:\VSCode\bin\code.CMD"]);
    assert_eq!(
        resolve_program(
            "code",
            &env(r"C:\Windows;C:\VSCode\bin", ".COM;.EXE;.BAT;.CMD"),
            &f
        ),
        Some(PathBuf::from(r"C:\VSCode\bin\code.CMD"))
    );
}

#[test]
fn resolve_program_prefers_the_name_as_given_then_pathext_order() {
    let f = files(&[r"C:\a\x", r"C:\a\x.CMD", r"C:\a\x.EXE"]);
    assert_eq!(
        resolve_program("x", &env(r"C:\a", ".CMD;.EXE"), &f),
        Some(PathBuf::from(r"C:\a\x"))
    );
    assert_eq!(
        resolve_program("x.EXE", &env(r"C:\a", ".CMD;.EXE"), &f),
        Some(PathBuf::from(r"C:\a\x.EXE"))
    );
    let f = files(&[r"C:\a\x.CMD", r"C:\a\x.EXE"]);
    assert_eq!(
        resolve_program("x", &env(r"C:\a", ".CMD;.EXE"), &f),
        Some(PathBuf::from(r"C:\a\x.CMD"))
    );
}

#[test]
fn resolve_program_skips_empty_and_relative_path_entries() {
    let f = files(&[r"bin\x.EXE", r"C:\b\x.EXE"]);
    assert_eq!(
        resolve_program("x", &env(r";bin;C:\b", ".EXE"), &f),
        Some(PathBuf::from(r"C:\b\x.EXE"))
    );
}

#[test]
fn resolve_program_does_not_search_path_for_rooted_programs() {
    let f = files(&[
        r"\\srv\tools\code.CMD",
        r"C:\t\code.EXE",
        r"C:/t/code.EXE",
        r"C:\on\path\code.EXE",
    ]);
    let e = env(r"C:\on\path", ".EXE;.CMD");
    assert_eq!(
        resolve_program(r"\\srv\tools\code", &e, &f),
        Some(PathBuf::from(r"\\srv\tools\code.CMD"))
    );
    assert_eq!(
        resolve_program(r"C:\t\code", &e, &f),
        Some(PathBuf::from(r"C:\t\code.EXE"))
    );
    assert_eq!(
        resolve_program(r"C:/t/code", &e, &f),
        Some(PathBuf::from(r"C:/t/code.EXE"))
    );
    assert_eq!(resolve_program(r"C:\missing\code", &e, &f), None);
}

#[test]
fn resolve_program_probes_pathext_as_given_and_defaults_it_when_empty() {
    let seen = std::cell::RefCell::new(Vec::<String>::new());
    let probe = |p: &Path| {
        seen.borrow_mut().push(p.to_string_lossy().into_owned());
        false
    };
    resolve_program("code", &env(r"C:\a", " .com; .exe;.Bat;.CMD "), probe);
    assert_eq!(
        seen.borrow().as_slice(),
        [
            r"C:\a\code",
            r"C:\a\code.com",
            r"C:\a\code.exe",
            r"C:\a\code.Bat",
            r"C:\a\code.CMD"
        ]
    );
    let f = files(&[r"C:\a\code.CMD"]);
    assert_eq!(
        resolve_program("code", &env(r"C:\a", ""), &f),
        Some(PathBuf::from(r"C:\a\code.CMD"))
    );
    assert_eq!(DEFAULT_PATHEXT, ".COM;.EXE;.BAT;.CMD");
}

#[test]
fn resolve_program_returns_none_when_nothing_matches() {
    assert_eq!(
        resolve_program("code", &env(r"C:\a", ".EXE"), |_| false),
        None
    );
}
