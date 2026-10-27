mod common;

use common::git_available;

use std::path::Path;

#[cfg(unix)] // only the fake-git (unix) tests use these
use git_real_core::remote::auth::{Credentials, HELPER};
use git_real_core::remote::clone;
use git_real_core::{GitError, Progress, ProgressPhase, ProgressSink, RepoSession};

/// Test double: records every progress report so tests can inspect them.
struct RecordingSink(Vec<Progress>);

impl ProgressSink for RecordingSink {
    fn report(&mut self, progress: Progress) {
        self.0.push(progress);
    }
}

fn bare_url() -> (tempfile::TempDir, tempfile::TempDir, String) {
    let (src_dir, src) = common::temp_repo_with_commit();
    let (bare_dir, bare) = common::temp_bare_clone(&src);
    let url = format!("file://{}", bare.display());
    drop(src);
    (src_dir, bare_dir, url)
}

// --- clone: successful clone reports progress and yields an openable repo ---

#[test]
fn clone_local_bare_repo_reports_progress_and_opens() {
    if !git_available() {
        return;
    }
    let (_src_dir, _bare_dir, url) = bare_url();
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = RecordingSink(Vec::new());

    let path = clone::clone(&url, &dest, None, &mut sink).expect("clone should succeed");

    assert!(RepoSession::open(&path).is_ok(), "cloned repo should open");
    assert!(!sink.0.is_empty(), "sink should record progress");
    assert!(
        sink.0.iter().any(|p| matches!(
            p.phase,
            ProgressPhase::Receiving | ProgressPhase::CheckingOut
        )),
        "expected a Receiving or CheckingOut report"
    );
}

// --- clone: failure modes surface as CloneFailed ---

#[test]
fn clone_nonexistent_url_is_clone_failed() {
    if !git_available() {
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = RecordingSink(Vec::new());

    let err =
        clone::clone("file:///nonexistent/repo", &dest, None, &mut sink).expect_err("should fail");

    match err {
        GitError::CloneFailed { stderr, .. } => assert!(!stderr.is_empty()),
        other => panic!("expected CloneFailed, got {other:?}"),
    }
}

#[test]
fn clone_into_non_empty_dest_fails() {
    if !git_available() {
        return;
    }
    let (_src_dir, _bare_dir, url) = bare_url();
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    std::fs::create_dir(&dest).unwrap();
    std::fs::write(dest.join("keep.txt"), "keep").unwrap();
    let mut sink = RecordingSink(Vec::new());

    let err = clone::clone(&url, &dest, None, &mut sink).expect_err("should fail");

    assert!(matches!(err, GitError::CloneFailed { .. }));
    assert!(Path::new(&dest.join("keep.txt")).exists());
}

// --- clone_with: a missing git executable surfaces as Io (never runs git) ---

#[test]
fn clone_with_nonexistent_git_is_io_error() {
    let work = tempfile::tempdir().unwrap();
    let missing_git = work.path().join("no-such-git");
    let dest = work.path().join("dest");
    let mut sink = RecordingSink(Vec::new());

    let err = clone::clone_with(&missing_git, "file:///irrelevant", &dest, None, &mut sink)
        .expect_err("should fail");

    assert!(matches!(err, GitError::Io(_)));
}

// --- clone: details of the real git invocation ---

#[test]
fn clone_nonexistent_url_reports_nonzero_exit_code() {
    if !git_available() {
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = RecordingSink(Vec::new());

    let err =
        clone::clone("file:///nonexistent/repo", &dest, None, &mut sink).expect_err("should fail");

    match err {
        GitError::CloneFailed { code, stderr } => {
            assert!(matches!(code, Some(c) if c != 0), "code was {code:?}");
            assert!(stderr.contains("fatal"), "stderr was {stderr:?}");
        }
        other => panic!("expected CloneFailed, got {other:?}"),
    }
}

#[test]
fn clone_url_starting_with_dashes_is_not_parsed_as_option() {
    if !git_available() {
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = RecordingSink(Vec::new());

    let err = clone::clone("--upload-pack=false", &dest, None, &mut sink).expect_err("should fail");

    match err {
        GitError::CloneFailed { stderr, .. } => {
            assert!(!stderr.contains("unknown option"), "stderr was {stderr:?}");
        }
        other => panic!("expected CloneFailed, got {other:?}"),
    }
}

#[test]
fn clone_into_existing_empty_dest_succeeds_and_returns_canonical_path() {
    if !git_available() {
        return;
    }
    let (_src_dir, _bare_dir, url) = bare_url();
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    std::fs::create_dir(&dest).unwrap();
    let mut sink = RecordingSink(Vec::new());

    let path = clone::clone(&url, &dest, None, &mut sink).expect("clone should succeed");

    assert_eq!(path, dest.canonicalize().unwrap());
    assert!(path.join("README.md").exists());
}

#[test]
fn clone_reports_only_non_empty_parsed_progress() {
    if !git_available() {
        return;
    }
    let (_src_dir, _bare_dir, url) = bare_url();
    let work = tempfile::tempdir().unwrap();
    let mut sink = RecordingSink(Vec::new());

    clone::clone(&url, &work.path().join("dest"), None, &mut sink).expect("clone should succeed");

    assert!(sink.0.iter().all(|p| !p.message.is_empty()));
    assert!(
        sink.0
            .iter()
            .all(|p| p.percent.is_none_or(|percent| percent <= 100))
    );
}

// --- clone_with: scripted stand-in for git (Unix only, no real git needed) ---

#[cfg(unix)]
#[test]
fn clone_with_passes_expected_args_env_and_null_stdin() {
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let log = work.path().join("log");
    let git = common::fake_git(
        work.path(),
        &format!(
            r#"{{ printf '%s|' "$@"; echo; echo "LC_ALL=$LC_ALL"; echo "PROMPT=$GIT_TERMINAL_PROMPT"; \
cat >/dev/null && echo stdin-eof; }} > '{log}'
mkdir -p "$5"
exit 0"#,
            log = log.display()
        ),
    );
    let mut sink = RecordingSink(Vec::new());

    clone::clone_with(
        &git,
        "https://example.invalid/r.git",
        &dest,
        None,
        &mut sink,
    )
    .expect("fake clone should succeed");

    let text = std::fs::read_to_string(&log).unwrap();
    let expected_args = format!(
        "clone|--progress|--|https://example.invalid/r.git|{}|",
        dest.display()
    );
    assert_eq!(text.lines().next(), Some(expected_args.as_str()));
    assert!(text.contains("LC_ALL=C\n"), "log was {text:?}");
    assert!(text.contains("PROMPT=0\n"), "log was {text:?}");
    assert!(text.contains("stdin-eof"), "log was {text:?}");
}

#[cfg(unix)]
#[test]
fn clone_with_reports_progress_in_order_including_unterminated_tail() {
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let git = common::fake_git(
        work.path(),
        r#"mkdir -p "$5"
printf 'Cloning into x...\n' >&2
printf 'remote: Counting objects:  50%% (1/2)   \r' >&2
printf 'Receiving objects: 100%% (2/2), done.' >&2"#,
    );
    let mut sink = RecordingSink(Vec::new());

    clone::clone_with(&git, "u", &dest, None, &mut sink).expect("fake clone should succeed");

    let seen: Vec<_> = sink.0.iter().map(|p| (p.phase, p.percent)).collect();
    assert_eq!(
        seen,
        vec![
            (ProgressPhase::Other, None),
            (ProgressPhase::Counting, Some(50)),
            (ProgressPhase::Receiving, Some(100)),
        ]
    );
}

#[cfg(unix)]
#[test]
fn clone_with_joins_progress_line_split_across_reads() {
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let git = common::fake_git(
        work.path(),
        r#"mkdir -p "$5"
printf 'Receiving obj' >&2
sleep 0.3
printf 'ects:  45%% (9/20)\r' >&2"#,
    );
    let mut sink = RecordingSink(Vec::new());

    clone::clone_with(&git, "u", &dest, None, &mut sink).expect("fake clone should succeed");

    assert_eq!(sink.0.len(), 1, "got {:?}", sink.0);
    assert_eq!(sink.0[0].phase, ProgressPhase::Receiving);
    assert_eq!(sink.0[0].percent, Some(45));
}

#[cfg(unix)]
#[test]
fn clone_with_failure_carries_exit_code_and_full_stderr() {
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let git = common::fake_git(
        work.path(),
        "printf 'Receiving objects: 10%%\\r' >&2\nprintf 'fatal: boom \\303\\244\\n' >&2\nexit 7",
    );
    let mut sink = RecordingSink(Vec::new());

    let err = clone::clone_with(&git, "u", &dest, None, &mut sink).expect_err("should fail");

    match err {
        GitError::CloneFailed { code, stderr } => {
            assert_eq!(code, Some(7));
            assert!(stderr.contains("Receiving objects: 10%"), "{stderr:?}");
            assert!(stderr.contains("fatal: boom \u{e4}"), "{stderr:?}");
        }
        other => panic!("expected CloneFailed, got {other:?}"),
    }
    assert!(
        !sink.0.is_empty(),
        "progress before failure is still reported"
    );
}

#[cfg(unix)]
#[test]
fn clone_with_signal_killed_child_has_no_exit_code() {
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let git = common::fake_git(work.path(), "kill -9 $$");
    let mut sink = RecordingSink(Vec::new());

    let err = clone::clone_with(&git, "u", &dest, None, &mut sink).expect_err("should fail");

    assert!(
        matches!(err, GitError::CloneFailed { code: None, .. }),
        "{err:?}"
    );
}

#[cfg(unix)]
#[test]
fn clone_with_success_but_missing_dest_is_io_error() {
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("never-created");
    let git = common::fake_git(work.path(), "exit 0");
    let mut sink = RecordingSink(Vec::new());

    let err = clone::clone_with(&git, "u", &dest, None, &mut sink).expect_err("should fail");

    assert!(matches!(err, GitError::Io(_)), "{err:?}");
}

#[cfg(unix)]
#[test]
fn clone_with_large_stderr_does_not_deadlock() {
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let git = common::fake_git(
        work.path(),
        r#"mkdir -p "$5"
i=0
while [ $i -lt 3000 ]; do
  printf 'Receiving objects: %s%% padding padding padding padding padding\r' $((i % 101)) >&2
  i=$((i + 1))
done"#,
    );
    let mut sink = RecordingSink(Vec::new());

    clone::clone_with(&git, "u", &dest, None, &mut sink).expect("fake clone should succeed");

    assert_eq!(sink.0.len(), 3000);
}

#[cfg(unix)]
#[test]
fn clone_with_credentials_puts_the_helper_before_clone_and_the_token_in_the_env() {
    const TOKEN: &str = "TOPSECRET-123";
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let argv = work.path().join("argv.txt");
    let token = work.path().join("token.txt");
    let git = common::fake_git(
        work.path(),
        &format!(
            "printf '%s\\n' \"$@\" > '{argv}'\nprintf '%s' \"$GR_TOKEN\" > '{token}'\nexit 1",
            argv = argv.display(),
            token = token.display()
        ),
    );
    let creds = Credentials::new("https://example.test", "me", TOKEN).unwrap();
    let mut sink = RecordingSink(Vec::new());

    let _ = clone::clone_with(
        &git,
        "https://example.test/x.git",
        &dest,
        Some(&creds),
        &mut sink,
    );

    let text = std::fs::read_to_string(&argv).unwrap();
    let got: Vec<&str> = text.lines().collect();
    let dest_text = dest.display().to_string();
    let helper_key = "credential.https://example.test.helper=";
    let scoped = format!("{helper_key}{HELPER}");
    let want = [
        "-c",
        helper_key,
        "-c",
        scoped.as_str(),
        "clone",
        "--progress",
        "--",
        "https://example.test/x.git",
        dest_text.as_str(),
    ];
    assert_eq!(got, want);
    assert_eq!(std::fs::read_to_string(&token).unwrap(), TOKEN);
    assert!(!text.contains(TOKEN));
}
