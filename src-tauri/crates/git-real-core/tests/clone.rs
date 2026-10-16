mod common;

use std::path::Path;

use git_real_core::remote::{clone, git_cli};
use git_real_core::{GitError, Progress, ProgressPhase, ProgressSink, RepoSession};

/// Test double: records every progress report so tests can inspect them.
struct RecordingSink(Vec<Progress>);

impl ProgressSink for RecordingSink {
    fn report(&mut self, progress: Progress) {
        self.0.push(progress);
    }
}

fn git_available() -> bool {
    if git_cli::locate().is_err() {
        eprintln!("skipping: git not on PATH");
        return false;
    }
    true
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

    let path = clone::clone(&url, &dest, &mut sink).expect("clone should succeed");

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

    let err = clone::clone("file:///nonexistent/repo", &dest, &mut sink).expect_err("should fail");

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

    let err = clone::clone(&url, &dest, &mut sink).expect_err("should fail");

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

    let err = clone::clone_with(&missing_git, "file:///irrelevant", &dest, &mut sink)
        .expect_err("should fail");

    assert!(matches!(err, GitError::Io(_)));
}
