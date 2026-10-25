//! Task 3: Failing tests for `tools.rs` — split_command, open_in_editor,
//! open_external_diff, open_external_merge, ExternalDiffScope::resolve.
//! Expected to fail to compile until the implementation exists.

#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{
    DiffRange, EMPTY_TREE, ExternalDiffScope, RepoSession, ToolError, open_external_diff,
    open_external_merge, open_in_editor, split_command,
};

// ─── Fake-git helper ──────────────────────────────────────────────────────────
//
// The git stand-in writes its arguments line-by-line to `$PWD/argv.txt`
// and optionally sources `$PWD/behaviour` to inject custom exit codes / output.
const ARGV_SCRIPT: &str = r#"printf '%s\n' "$@" > "$PWD/argv.txt"
[ -f "$PWD/behaviour" ] && . "$PWD/behaviour"
exit 0"#;

fn fake_git(dir: &Path) -> PathBuf {
    common::fake_git(dir, ARGV_SCRIPT)
}

/// Reads the recorded argv from `<repo>/.git/argv.txt` (we pass `current_dir`
/// = repo_path, but the script writes to `$PWD`).
fn read_argv(dir: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(dir.join("argv.txt")).unwrap_or_default();
    text.lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_owned())
        .collect()
}

// ─── split_command ────────────────────────────────────────────────────────────

#[test]
fn split_command_table() {
    let cases: &[(&str, &[&str])] = &[
        ("code --wait", &["code", "--wait"]),
        (r#"meld "$LOCAL" "$REMOTE""#, &["meld", "$LOCAL", "$REMOTE"]),
        ("'a b' c", &["a b", "c"]),
        (r"a\ b", &["a b"]),
        (r#""a\"b""#, &["a\"b"]),
        (r"'a\b'", &[r"a\b"]), // inside single quotes, nothing escapes
        (r#""""#, &[""]),      // explicit empty double-quoted arg
        (r"\", &["\\"]),       // trailing lone backslash is literal
    ];
    for (input, expected) in cases {
        let got =
            split_command(input).unwrap_or_else(|e| panic!("split_command({:?}) → {:?}", input, e));
        assert_eq!(
            got,
            expected.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            "input: {:?}",
            input
        );
    }
}

#[test]
fn split_command_rejects_blank_and_unterminated() {
    assert_eq!(split_command("   ").unwrap_err(), ToolError::EmptyCommand);
    assert_eq!(
        split_command("\"abc").unwrap_err(),
        ToolError::UnterminatedQuote
    );
    assert_eq!(
        split_command("'abc").unwrap_err(),
        ToolError::UnterminatedQuote
    );
}

// ─── open_in_editor ───────────────────────────────────────────────────────────

#[test]
fn open_in_editor_appends_the_path_and_returns_before_the_tool_exits() {
    let dir = tempfile::tempdir().unwrap();
    let argv_file = dir.path().join("editor-argv.txt");
    let argv_file_str = argv_file.to_str().unwrap();

    // Editor script: records its args and sleeps briefly so we can verify the
    // function returns before the process exits.
    let script = format!("printf '%s\\n' \"$@\" > '{argv_file_str}'\nsleep 2\n");
    let editor_path = {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.path().join("fake_editor");
        std::fs::write(&p, format!("#!/bin/sh\n{script}")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    };

    // Use "sh <script>" so the kernel execs /bin/sh (already in memory) rather than
    // the freshly-written file, preventing ETXTBSY when a parallel test's fork
    // inherits the write fd from the just-created script.
    let cmd = format!("sh {} --wait", editor_path.display());
    let file_path = PathBuf::from("/some/file");
    open_in_editor(&cmd, &file_path).unwrap();

    // The function returns immediately; wait up to 2 s for the argv file.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !argv_file.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "editor argv file never appeared"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let lines: Vec<String> = std::fs::read_to_string(&argv_file)
        .unwrap()
        .lines()
        .map(|l| l.to_owned())
        .collect();
    assert_eq!(lines, vec!["--wait".to_string(), "/some/file".to_string()]);
}

#[test]
fn open_in_editor_maps_a_spawn_failure() {
    let err = open_in_editor("/nonexistent/editor x", &PathBuf::from("/f")).unwrap_err();
    match &err {
        ToolError::Spawn { program, .. } => {
            assert_eq!(program, "/nonexistent/editor");
            assert!(
                err.to_string()
                    .starts_with("Couldn't start /nonexistent/editor:"),
                "unexpected message: {}",
                err
            );
        }
        other => panic!("expected Spawn, got {:?}", other),
    }
}

// ─── open_external_diff ───────────────────────────────────────────────────────

fn make_fake_git_dir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let git = fake_git(dir.path());
    (dir, git)
}

fn make_repo_dir() -> (tempfile::TempDir, PathBuf) {
    common::temp_repo_with_commit()
}

#[test]
fn difftool_argv_for_unstaged() {
    let (git_dir, git) = make_fake_git_dir();
    let (_repo_dir, repo_path) = make_repo_dir();
    let range = DiffRange::Unstaged;
    open_external_diff(
        &git,
        &repo_path,
        "meld \"$LOCAL\" \"$REMOTE\"",
        "a.txt",
        &range,
    )
    .unwrap();
    let argv = read_argv(&repo_path);
    // Expected: -c difftool.gitreal.cmd=<cmd> -c difftool.prompt=false difftool --tool=gitreal -- a.txt
    assert!(
        argv.iter()
            .any(|a| a.starts_with("-c") || a.contains("difftool.gitreal.cmd"))
    );
    assert!(argv.contains(&"difftool".to_string()));
    assert!(argv.contains(&"--tool=gitreal".to_string()));
    assert!(argv.contains(&"a.txt".to_string()));
    // Not --cached for unstaged
    assert!(!argv.contains(&"--cached".to_string()));
    drop(git_dir);
}

#[test]
fn difftool_argv_for_staged() {
    let (git_dir, git) = make_fake_git_dir();
    let (_repo_dir, repo_path) = make_repo_dir();
    let range = DiffRange::Staged;
    open_external_diff(&git, &repo_path, "meld", "b.txt", &range).unwrap();
    let argv = read_argv(&repo_path);
    assert!(argv.contains(&"--cached".to_string()));
    assert!(argv.contains(&"b.txt".to_string()));
    drop(git_dir);
}

#[test]
fn difftool_argv_for_commit() {
    let (git_dir, git) = make_fake_git_dir();
    let (_repo_dir, repo_path) = make_repo_dir();
    let parent_oid = "aabbccdd00112233aabbccdd00112233aabbccdd".to_string();
    let commit_oid = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string();
    let range = DiffRange::Commit {
        parent: Some(parent_oid.clone()),
        oid: commit_oid.clone(),
    };
    open_external_diff(&git, &repo_path, "meld", "c.txt", &range).unwrap();
    let argv = read_argv(&repo_path);
    assert!(argv.contains(&parent_oid));
    assert!(argv.contains(&commit_oid));
    assert!(argv.contains(&"c.txt".to_string()));
    assert!(!argv.contains(&"--cached".to_string()));
    drop(git_dir);
}

#[test]
fn difftool_uses_the_empty_tree_for_a_root_commit() {
    let (git_dir, git) = make_fake_git_dir();
    let (_repo_dir, repo_path) = make_repo_dir();
    let commit_oid = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string();
    let range = DiffRange::Commit {
        parent: None,
        oid: commit_oid.clone(),
    };
    open_external_diff(&git, &repo_path, "meld", "d.txt", &range).unwrap();
    let argv = read_argv(&repo_path);
    assert!(argv.contains(&EMPTY_TREE.to_string()));
    assert!(argv.contains(&commit_oid));
    drop(git_dir);
}

#[test]
fn difftool_runs_in_the_repository_directory() {
    let (git_dir, git) = make_fake_git_dir();
    let (_repo_dir, repo_path) = make_repo_dir();
    // The argv.txt is written to $PWD, which must equal repo_path.
    open_external_diff(&git, &repo_path, "meld", "e.txt", &DiffRange::Unstaged).unwrap();
    assert!(repo_path.join("argv.txt").exists());
    drop(git_dir);
}

#[test]
fn difftool_failure_carries_the_last_stderr_line() {
    let dir = tempfile::tempdir().unwrap();
    let behaviour = "echo 'fatal: no such tool' >&2; exit 1";
    let git = common::fake_git(
        dir.path(),
        &format!("printf '%s\\n' \"$@\" > \"$PWD/argv.txt\"\n{behaviour}"),
    );
    let (_repo_dir, repo_path) = make_repo_dir();
    // Write the behaviour file so the script always exits 1 with the message
    std::fs::write(
        repo_path.join("behaviour"),
        "echo 'fatal: no such tool' >&2; exit 1",
    )
    .ok();
    let err =
        open_external_diff(&git, &repo_path, "meld", "f.txt", &DiffRange::Unstaged).unwrap_err();
    match &err {
        ToolError::Failed {
            verb,
            code,
            message,
        } => {
            assert_eq!(*verb, "difftool");
            assert_eq!(*code, Some(1));
            assert!(
                message.contains("fatal: no such tool"),
                "message: {}",
                message
            );
        }
        other => panic!("expected Failed, got {:?}", other),
    }
    drop(dir);
}

// ─── open_external_merge ─────────────────────────────────────────────────────

#[test]
fn mergetool_argv_is_exact() {
    let (git_dir, git) = make_fake_git_dir();
    let (_repo_dir, repo_path) = make_repo_dir();
    open_external_merge(
        &git,
        &repo_path,
        "meld \"$LOCAL\" \"$MERGED\"",
        "conflict.txt",
    )
    .unwrap();
    let argv = read_argv(&repo_path);
    // Must include: -c mergetool.gitreal.cmd=<cmd> -c mergetool.gitreal.trustExitCode=true
    // -c mergetool.prompt=false -c mergetool.keepBackup=false mergetool --tool=gitreal -- <path>
    assert!(
        argv.iter()
            .any(|a| a.contains("mergetool.gitreal.trustExitCode=true"))
    );
    assert!(
        argv.iter()
            .any(|a| a.contains("mergetool.keepBackup=false"))
    );
    assert!(argv.contains(&"mergetool".to_string()));
    assert!(argv.contains(&"--tool=gitreal".to_string()));
    assert!(argv.contains(&"conflict.txt".to_string()));
    drop(git_dir);
}

#[test]
fn mergetool_failure_without_stderr_names_the_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let git = common::fake_git(
        dir.path(),
        "printf '%s\\n' \"$@\" > \"$PWD/argv.txt\"\nexit 2",
    );
    let (_repo_dir, repo_path) = make_repo_dir();
    let err = open_external_merge(&git, &repo_path, "meld", "merge.txt").unwrap_err();
    match &err {
        ToolError::Failed {
            verb,
            code,
            message,
        } => {
            assert_eq!(*verb, "mergetool");
            assert_eq!(*code, Some(2));
            assert!(
                message.contains("exit code 2"),
                "message should name exit code: {}",
                message
            );
        }
        other => panic!("expected Failed, got {:?}", other),
    }
    drop(dir);
}

// ─── first_parent_oid / ExternalDiffScope::resolve ────────────────────────────

#[test]
fn first_parent_oid_is_none_for_a_root_commit_and_some_after() {
    let (_dir, path) = common::temp_repo_with_commit();
    // Get the root commit OID — scope repo and head so they're dropped before we
    // open the RepoSession (git2::Repository is not Sync; two handles to the same
    // repo are fine but the head borrow must end first).
    let root_oid = {
        let repo = git2::Repository::open(&path).unwrap();
        repo.head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string()
    };

    let session = RepoSession::open(path.to_str().unwrap()).unwrap();
    let parent = session.first_parent_oid(&root_oid).unwrap();
    assert!(parent.is_none(), "root commit has no parent");

    // Add a second commit and verify its first parent is the root.
    let second_oid = common::commit_file(&path, "b.txt", "b\n", "second commit").to_string();
    let session2 = RepoSession::open(path.to_str().unwrap()).unwrap();
    let parent2 = session2.first_parent_oid(&second_oid).unwrap();
    assert_eq!(parent2, Some(root_oid));
}

#[test]
fn first_parent_oid_rejects_an_unknown_commit() {
    use git_real_core::GitError;

    let (_dir, path) = common::temp_repo_with_commit();
    let session = RepoSession::open(path.to_str().unwrap()).unwrap();
    let err = session
        .first_parent_oid("0000000000000000000000000000000000000000")
        .unwrap_err();
    assert!(
        matches!(err, GitError::CommitNotFound(_) | GitError::Git2(_)),
        "unexpected error: {:?}",
        err
    );
}

#[test]
fn resolve_maps_each_scope() {
    let (_dir, path) = common::temp_repo_with_commit();
    let session = RepoSession::open(path.to_str().unwrap()).unwrap();

    // Unstaged → DiffRange::Unstaged
    let r = ExternalDiffScope::Unstaged.resolve(&session).unwrap();
    assert_eq!(r, DiffRange::Unstaged);

    // Staged → DiffRange::Staged
    let r2 = ExternalDiffScope::Staged.resolve(&session).unwrap();
    assert_eq!(r2, DiffRange::Staged);

    // Commit → DiffRange::Commit
    let repo = git2::Repository::open(&path).unwrap();
    let oid = repo
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .id()
        .to_string();
    drop(repo);
    let scope = ExternalDiffScope::Commit { oid: oid.clone() };
    let r3 = scope.resolve(&session).unwrap();
    match r3 {
        DiffRange::Commit {
            oid: got_oid,
            parent,
        } => {
            assert_eq!(got_oid, oid);
            // Root commit → parent is None
            assert!(parent.is_none());
        }
        other => panic!("expected DiffRange::Commit, got {:?}", other),
    }
}
