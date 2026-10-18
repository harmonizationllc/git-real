mod common;

use std::path::Path;

use git_real_core::commit::git_commit;
use git_real_core::git_cli;
use git_real_core::{CommitMessage, GitError, RepoSession, SigningFormat};
use git2::Repository;

fn git_available() -> bool {
    if git_cli::locate().is_err() {
        eprintln!("skipping: git not on PATH");
        return false;
    }
    true
}

fn msg(subject: &str, body: &str) -> CommitMessage {
    CommitMessage {
        subject: subject.to_string(),
        body: body.to_string(),
    }
}

/// Repo with one commit, local identity, signing off.
fn fixture() -> (tempfile::TempDir, std::path::PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session)
}

fn head_oid(path: &Path) -> git2::Oid {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
}

fn head_raw_message(path: &Path) -> String {
    let repo = Repository::open(path).unwrap();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    commit.message().unwrap().to_string()
}

fn set_config(path: &Path, key: &str, value: &str) {
    Repository::open(path)
        .unwrap()
        .config()
        .unwrap()
        .set_str(key, value)
        .unwrap();
}

// --- commit_config ---

#[test]
fn commit_config_reads_identity_and_no_signing_by_default() {
    let (_d, _p, session) = fixture();
    let cfg = session.commit_config().unwrap();
    assert_eq!(cfg.name.as_deref(), Some("Test User"));
    assert_eq!(cfg.email.as_deref(), Some("test@example.com"));
    assert_eq!(cfg.signing, None);
}

#[test]
fn commit_config_blank_name_is_none() {
    let (_d, path, session) = fixture();
    set_config(&path, "user.name", "   ");
    assert_eq!(session.commit_config().unwrap().name, None);
}

#[test]
fn commit_config_reports_ssh_signing_when_gpgsign_true() {
    let (_d, path, session) = fixture();
    set_config(&path, "commit.gpgsign", "true");
    set_config(&path, "gpg.format", "ssh");
    assert_eq!(
        session.commit_config().unwrap().signing,
        Some(SigningFormat::Ssh)
    );
}

#[test]
fn commit_config_signing_defaults_to_openpgp_and_is_case_insensitive() {
    let (_d, path, session) = fixture();
    set_config(&path, "commit.gpgsign", "true");
    assert_eq!(
        session.commit_config().unwrap().signing,
        Some(SigningFormat::OpenPgp)
    );
    set_config(&path, "gpg.format", "X509");
    assert_eq!(
        session.commit_config().unwrap().signing,
        Some(SigningFormat::X509)
    );
    set_config(&path, "gpg.format", "something-new");
    assert_eq!(
        session.commit_config().unwrap().signing,
        Some(SigningFormat::OpenPgp)
    );
}

#[test]
fn commit_config_gpgsign_false_is_no_signing_even_with_format() {
    let (_d, path, session) = fixture();
    set_config(&path, "gpg.format", "ssh");
    assert_eq!(session.commit_config().unwrap().signing, None);
}

// --- head_message ---

#[test]
fn head_message_is_none_on_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = RepoSession::open(&path).unwrap();
    assert_eq!(session.head_message().unwrap(), None);
}

#[test]
fn head_message_splits_subject_and_body() {
    let (_d, path, session) = fixture();
    common::write_file(&path, "a.txt", "a\n");
    common::commit_all(&path, "Subject here\n\nBody para\n\nSecond para\n");
    assert_eq!(
        session.head_message().unwrap(),
        Some(msg("Subject here", "Body para\n\nSecond para"))
    );
}

#[test]
fn head_message_with_invalid_utf8_is_lossy_not_panic() {
    let (_d, path, session) = fixture();
    let repo = Repository::open(&path).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let sig = git2::Signature::now("T", "t@e.c").unwrap();
    let tree = head.tree().unwrap();
    // Build a commit whose message is the Latin-1 bytes "caf\xE9" (not UTF-8):
    // write the object buffer with a placeholder, patch the bytes, store it.
    let buf = repo
        .commit_create_buffer(&sig, &sig, "placeholder", &tree, &[&head])
        .unwrap();
    let mut raw: Vec<u8> = buf.to_vec();
    let pos = raw.windows(11).position(|w| w == b"placeholder").unwrap();
    raw.splice(pos..pos + 11, [b'c', b'a', b'f', 0xE9]);
    let oid = repo
        .odb()
        .unwrap()
        .write(git2::ObjectType::Commit, &raw)
        .unwrap();
    repo.set_head_detached(oid).unwrap();
    let m = session.head_message().unwrap().unwrap();
    assert_eq!(m.subject, "caf\u{FFFD}");
    assert_eq!(m.body, "");
}

// --- commit: happy paths (need the real git) ---

#[test]
fn commit_on_unborn_head_creates_root_commit() {
    if !git_available() {
        return;
    }
    let (_d, path) = common::temp_repo_unborn();
    common::configure_identity(&path);
    common::write_file(&path, "a.txt", "a\n");
    common::stage(&path, "a.txt");
    let session = RepoSession::open(&path).unwrap();

    let out = session.commit(&msg("First", ""), false).unwrap();

    assert_eq!(out.summary, "First");
    assert_eq!(out.oid, head_oid(&path).to_string());
    assert_eq!(head_raw_message(&path), "First\n");
    let repo = Repository::open(&path).unwrap();
    assert_eq!(
        repo.head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent_count(),
        0
    );
}

#[test]
fn commit_records_subject_and_body_and_advances_head() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    let before = head_oid(&path);
    common::write_file(&path, "b.txt", "b\n");
    common::stage(&path, "b.txt");

    let out = session
        .commit(&msg("Add b", "Because.\n\nMore."), false)
        .unwrap();

    let after = head_oid(&path);
    assert_ne!(before, after);
    assert_eq!(out.oid, after.to_string());
    assert_eq!(head_raw_message(&path), "Add b\n\nBecause.\n\nMore.\n");
    let repo = Repository::open(&path).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_id(0).unwrap(), before);
    // Index is clean afterwards: status sees nothing staged.
    assert!(session.status().unwrap().entries.is_empty());
}

#[test]
fn commit_keeps_hash_lines_in_body() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    common::write_file(&path, "c.txt", "c\n");
    common::stage(&path, "c.txt");

    session
        .commit(&msg("Hash", "# not a comment\nline"), false)
        .unwrap();

    assert_eq!(head_raw_message(&path), "Hash\n\n# not a comment\nline\n");
}

#[test]
fn amend_replaces_message_and_keeps_parent() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    common::write_file(&path, "d.txt", "d\n");
    common::stage(&path, "d.txt");
    session.commit(&msg("Typo", ""), false).unwrap();
    let repo = Repository::open(&path).unwrap();
    let parent = repo
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .parent_id(0)
        .unwrap();

    let out = session.commit(&msg("Fixed", "body"), true).unwrap();

    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.id().to_string(), out.oid);
    assert_eq!(head.parent_id(0).unwrap(), parent);
    assert_eq!(head_raw_message(&path), "Fixed\n\nbody\n");
}

#[test]
fn amend_with_nothing_staged_is_allowed() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    let before = head_oid(&path);

    let out = session
        .commit(&msg("initial commit, reworded", ""), true)
        .unwrap();

    assert_ne!(out.oid, before.to_string());
    assert_eq!(head_raw_message(&path), "initial commit, reworded\n");
}

#[test]
fn amend_includes_newly_staged_changes() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    common::write_file(&path, "e.txt", "e\n");
    common::stage(&path, "e.txt");

    session.commit(&msg("initial commit", ""), true).unwrap();

    let repo = Repository::open(&path).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    assert!(tree.get_name("e.txt").is_some());
    assert_eq!(
        repo.head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent_count(),
        0
    );
}

// --- commit: pre-checks (no git needed) ---

#[test]
fn commit_with_blank_subject_is_empty_message() {
    let (_d, path, session) = fixture();
    common::write_file(&path, "f.txt", "f\n");
    common::stage(&path, "f.txt");
    let err = session.commit(&msg("  \n", "body"), false).unwrap_err();
    assert!(matches!(err, GitError::EmptyMessage), "{err:?}");
}

#[test]
fn commit_with_nothing_staged_is_nothing_to_commit() {
    let (_d, path, session) = fixture();
    common::write_file(&path, "README.md", "# changed but unstaged\n");
    let err = session.commit(&msg("Subject", ""), false).unwrap_err();
    assert!(matches!(err, GitError::NothingToCommit), "{err:?}");
}

#[test]
fn commit_on_unborn_head_with_empty_index_is_nothing_to_commit() {
    let (_d, path) = common::temp_repo_unborn();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();
    let err = session.commit(&msg("Subject", ""), false).unwrap_err();
    assert!(matches!(err, GitError::NothingToCommit), "{err:?}");
}

#[test]
fn empty_message_check_runs_before_staged_check() {
    let (_d, _p, session) = fixture();
    let err = session.commit(&msg("", ""), false).unwrap_err();
    assert!(matches!(err, GitError::EmptyMessage), "{err:?}");
}

// --- commit: failures from git ---

#[cfg(unix)]
#[test]
fn failing_pre_commit_hook_reports_hook_output() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    common::install_hook(&path, "pre-commit", "echo 'hook says no' >&2\nexit 1");
    common::write_file(&path, "g.txt", "g\n");
    common::stage(&path, "g.txt");
    let before = head_oid(&path);

    // A large body so the stdin write would block or EPIPE if git exits first.
    let body = "x".repeat(200_000);
    let err = session.commit(&msg("Blocked", &body), false).unwrap_err();

    match err {
        GitError::CommitFailed { code, stderr, .. } => {
            assert_eq!(code, Some(1));
            assert!(stderr.contains("hook says no"), "{stderr}");
        }
        other => panic!("expected CommitFailed, got {other:?}"),
    }
    assert_eq!(head_oid(&path), before);
}

#[test]
fn commit_with_conflicts_fails_through_git() {
    if !git_available() {
        return;
    }
    let (_d, path) = common::temp_repo_with_conflict();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();
    let err = session.commit(&msg("Merge", ""), false).unwrap_err();
    match err {
        GitError::CommitFailed { stderr, .. } => {
            assert!(stderr.to_lowercase().contains("unmerged"), "{stderr}")
        }
        other => panic!("expected CommitFailed, got {other:?}"),
    }
}

#[test]
fn commit_on_bare_repo_is_not_a_repository() {
    let (_src_dir, src) = common::temp_repo_with_commit();
    let (_bare_dir, bare) = common::temp_bare_clone(&src);
    let session = RepoSession::open(&bare).unwrap();
    let err = session.commit(&msg("S", ""), true).unwrap_err();
    assert!(matches!(err, GitError::NotARepository(_)), "{err:?}");
}

// --- git_commit::run with a scripted git ---

#[cfg(unix)]
#[test]
fn run_passes_expected_args_env_and_stdin() {
    let dir = tempfile::tempdir().unwrap();
    let script = r#"
out="$(dirname "$0")"
printf '%s\n' "$@" > "$out/args"
cat > "$out/stdin"
printf '%s|%s\n' "$LC_ALL" "$GIT_TERMINAL_PROMPT" > "$out/env"
exit 0
"#;
    let git = common::fake_git(dir.path(), script);
    let workdir = dir.path().join("wd");
    std::fs::create_dir_all(&workdir).unwrap();

    git_commit::run(&git, &workdir, "Subject\n\nBody\n", false).unwrap();

    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    let expected = format!(
        "-C\n{}\ncommit\n--cleanup=whitespace\n-F\n-\n",
        workdir.display()
    );
    assert_eq!(args, expected);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("stdin")).unwrap(),
        "Subject\n\nBody\n"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("env")).unwrap(),
        "C|0\n"
    );
}

#[cfg(unix)]
#[test]
fn run_appends_amend_flag() {
    let dir = tempfile::tempdir().unwrap();
    let git = common::fake_git(
        dir.path(),
        "printf '%s\\n' \"$@\" > \"$(dirname \"$0\")/args\"; cat >/dev/null; exit 0",
    );
    git_commit::run(&git, dir.path(), "S\n", true).unwrap();
    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    assert!(args.ends_with("-F\n-\n--amend\n"), "{args}");
}

#[cfg(unix)]
#[test]
fn run_failure_carries_code_stdout_and_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let git = common::fake_git(
        dir.path(),
        "cat >/dev/null; echo 'to stdout'; echo 'to stderr' >&2; exit 3",
    );
    let err = git_commit::run(&git, dir.path(), "S\n", false).unwrap_err();
    match err {
        GitError::CommitFailed {
            code,
            stdout,
            stderr,
        } => {
            assert_eq!(code, Some(3));
            assert_eq!(stdout, "to stdout\n");
            assert_eq!(stderr, "to stderr\n");
        }
        other => panic!("{other:?}"),
    }
}

#[cfg(unix)]
#[test]
fn run_exit_without_reading_stdin_is_not_an_io_error() {
    let dir = tempfile::tempdir().unwrap();
    let git = common::fake_git(dir.path(), "echo 'refused' >&2; exit 1");
    let big = "y".repeat(500_000);
    let err = git_commit::run(&git, dir.path(), &big, false).unwrap_err();
    assert!(
        matches!(err, GitError::CommitFailed { code: Some(1), .. }),
        "{err:?}"
    );
}

#[cfg(unix)]
#[test]
fn run_signal_killed_child_has_no_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let git = common::fake_git(dir.path(), "cat >/dev/null; kill -9 $$");
    let err = git_commit::run(&git, dir.path(), "S\n", false).unwrap_err();
    assert!(
        matches!(err, GitError::CommitFailed { code: None, .. }),
        "{err:?}"
    );
}

#[test]
fn run_with_missing_git_is_io_error() {
    let dir = tempfile::tempdir().unwrap();
    let err = git_commit::run(&dir.path().join("no-git"), dir.path(), "S\n", false).unwrap_err();
    assert!(matches!(err, GitError::Io(_)), "{err:?}");
}

#[cfg(unix)]
#[test]
fn run_does_not_deadlock_when_hook_output_and_message_exceed_pipe_buffer() {
    let dir = tempfile::tempdir().unwrap();
    let git = common::fake_git(
        dir.path(),
        "head -c 300000 /dev/zero | tr '\\0' x >&2; cat >/dev/null; exit 0",
    );
    let message = format!("S\n\n{}", "y".repeat(300_000));
    let workdir = dir.path().to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(git_commit::run(&git, &workdir, &message, false));
    });

    let result = rx.recv_timeout(std::time::Duration::from_secs(10));

    assert!(matches!(result, Ok(Ok(()))), "{result:?}");
}
