//! The exact `git` argument lists and failure plumbing for checkout and remote
//! branch deletion (GR-7), observed through a scripted stand-in for `git` that
//! is first on `PATH`. No real remote or real git is involved.
//!
//! `PATH` is process-wide, so it is set exactly once, before any test body
//! runs. The stand-in records its arguments in `<workdir>/.git/argv.txt` (the
//! workdir is the argument after `-C`) and, when `<workdir>/.git/behaviour`
//! exists, sources it so a test can script exit codes and output.

#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use git_real_core::{
    GitError, MergeMode, NetworkErrorKind, OperationOutcome, RepoSession, StashOutcome,
};
use git2::{BranchType, Repository};

const SCRIPT: &str = r#"printf '%s\n' "$@" > "$2/.git/argv.txt"
printf '%s' "$GIT_EDITOR" > "$2/.git/editor.txt"
[ -f "$2/.git/behaviour" ] && . "$2/.git/behaviour"
exit 0"#;

static FAKE_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
/// A temp root whose name holds a `'`, so every todo file this binary writes
/// has to be shell-quoted to survive `GIT_SEQUENCE_EDITOR`.
static QUOTED_TMP: OnceLock<tempfile::TempDir> = OnceLock::new();

fn use_fake_git() {
    FAKE_DIR.get_or_init(|| {
        let dir = tempfile::tempdir().expect("temp dir");
        common::fake_git(dir.path(), SCRIPT);
        let old = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![dir.path().to_path_buf()];
        paths.extend(std::env::split_paths(&old));
        // SAFETY: runs inside `get_or_init`, before any test body reads PATH.
        unsafe { std::env::set_var("PATH", std::env::join_paths(paths).unwrap()) };
        let quoted = tempfile::Builder::new()
            .prefix("it's-a-tmp-")
            .tempdir()
            .expect("quoted temp root");
        // SAFETY: as above, inside `get_or_init`, before any test body runs.
        unsafe { std::env::set_var("TMPDIR", quoted.path()) };
        let _ = QUOTED_TMP.set(quoted);
        dir
    });
}

fn argv(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path.join(".git").join("argv.txt"))
        .expect("the stand-in git was not run")
        .lines()
        .map(str::to_owned)
        .collect()
}

fn script_behaviour(path: &Path, body: &str) {
    std::fs::write(path.join(".git").join("behaviour"), body).unwrap();
}

/// Everything after `-C <workdir>`.
fn after_workdir(path: &Path) -> Vec<String> {
    let args = argv(path);
    assert_eq!(args[0], "-C", "{args:?}");
    args[2..].to_vec()
}

/// A repo with a fetched `origin` holding `feature` and `feat/slash`, with no
/// local branch of those names.
fn fixture() -> (tempfile::TempDir, tempfile::TempDir, PathBuf, RepoSession) {
    use_fake_git();
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &commit, false).unwrap();
        repo.branch("feat/slash", &commit, false).unwrap();
    }
    common::push_branch(&path, "feature");
    common::push_branch(&path, "feat/slash");
    common::fetch_remote(&path, "origin");
    {
        let repo = Repository::open(&path).unwrap();
        for name in ["feature", "feat/slash"] {
            repo.find_branch(name, BranchType::Local)
                .unwrap()
                .delete()
                .unwrap();
        }
    }
    let session = RepoSession::open(&path).unwrap();
    (dir, bare_dir, path, session)
}

// --- git switch argument lists ---

#[test]
fn checkout_remote_creates_the_branch_with_switch_c_and_a_full_track_refname() {
    let (_d, _b, path, session) = fixture();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(
        after_workdir(&path),
        [
            "switch",
            "-c",
            "feature",
            "--track",
            "refs/remotes/origin/feature"
        ]
    );
}

#[test]
fn checkout_remote_keeps_slashes_in_the_name_and_the_tracking_refname() {
    let (_d, _b, path, session) = fixture();
    session
        .checkout_remote_branch("origin", "feat/slash")
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        [
            "switch",
            "-c",
            "feat/slash",
            "--track",
            "refs/remotes/origin/feat/slash"
        ]
    );
}

#[test]
fn checkout_remote_with_an_existing_local_branch_runs_a_plain_switch() {
    let (_d, _b, path, session) = fixture();
    session.create_branch("feature", None).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(after_workdir(&path), ["switch", "feature"]);
}

#[test]
fn checkout_local_runs_a_plain_switch_in_the_workdir() {
    let (_d, _b, path, session) = fixture();
    session.create_branch("topic", None).unwrap();
    session.checkout_branch("topic").unwrap();
    let args = argv(&path);
    assert_eq!(args[0], "-C");
    assert_eq!(
        common::canonical(std::path::Path::new(&args[1])),
        common::canonical(&path)
    );
    assert_eq!(&args[2..], ["switch", "topic"]);
}

#[test]
fn create_and_checkout_switches_to_the_new_branch_by_name() {
    let (_d, _b, path, session) = fixture();
    let branch = session.create_and_checkout_branch("topic", None).unwrap();
    assert!(branch.is_head);
    assert_eq!(after_workdir(&path), ["switch", "topic"]);
}

// --- failure plumbing for git switch ---

#[test]
fn switch_failure_carries_exit_code_stdout_and_stderr_separately() {
    let (_d, _b, path, session) = fixture();
    session.create_branch("topic", None).unwrap();
    script_behaviour(&path, "echo from-stdout\necho from-stderr >&2\nexit 3");
    match session.checkout_branch("topic").unwrap_err() {
        GitError::CheckoutFailed {
            code,
            stdout,
            stderr,
        } => {
            assert_eq!(code, Some(3));
            assert_eq!(stdout, "from-stdout\n");
            assert_eq!(stderr, "from-stderr\n");
        }
        other => panic!("expected CheckoutFailed, got {other:?}"),
    }
}

#[test]
fn switch_killed_by_a_signal_reports_no_exit_code() {
    let (_d, _b, path, session) = fixture();
    session.create_branch("topic", None).unwrap();
    script_behaviour(&path, "kill -9 $$");
    assert!(matches!(
        session.checkout_branch("topic").unwrap_err(),
        GitError::CheckoutFailed { code: None, .. }
    ));
}

#[test]
fn failed_tracking_checkout_creates_no_local_branch() {
    let (_d, _b, path, session) = fixture();
    script_behaviour(&path, "exit 1");
    assert!(matches!(
        session
            .checkout_remote_branch("origin", "feature")
            .unwrap_err(),
        GitError::CheckoutFailed { code: Some(1), .. }
    ));
    assert!(
        Repository::open(&path)
            .unwrap()
            .find_branch("feature", BranchType::Local)
            .is_err()
    );
}

// --- git push --delete ---

#[test]
fn remote_delete_pushes_a_heads_qualified_name() {
    let (_d, _b, path, session) = fixture();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    push.run(None).unwrap();
    assert_eq!(
        after_workdir(&path),
        ["push", "origin", "--delete", "heads/feature"]
    );
}

#[test]
fn remote_delete_keeps_slashes_in_the_name() {
    let (_d, _b, path, session) = fixture();
    session
        .prepare_remote_delete("origin", "feat/slash")
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        ["push", "origin", "--delete", "heads/feat/slash"]
    );
}

#[test]
fn remote_delete_runs_in_the_accessor_workdir() {
    let (_d, _b, path, session) = fixture();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    push.run(None).unwrap();
    assert_eq!(argv(&path)[1], push.workdir().to_str().unwrap());
}

#[test]
fn push_failure_carries_exit_code_stdout_and_stderr_separately() {
    let (_d, _b, path, session) = fixture();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    script_behaviour(&path, "echo push-out\necho push-err >&2\nexit 7");
    match push.run(None).unwrap_err() {
        GitError::NetworkFailed {
            verb,
            kind,
            code,
            stdout,
            stderr,
            ..
        } => {
            assert_eq!(verb, "push");
            assert_eq!(kind, NetworkErrorKind::Other);
            assert_eq!(code, Some(7));
            assert_eq!(stdout, "push-out\n");
            assert_eq!(stderr, "push-err\n");
        }
        other => panic!("expected NetworkFailed, got {other:?}"),
    }
}

#[test]
fn push_killed_by_a_signal_reports_no_exit_code() {
    let (_d, _b, path, session) = fixture();
    let push = session.prepare_remote_delete("origin", "feature").unwrap();
    script_behaviour(&path, "kill -9 $$");
    assert!(matches!(
        push.run(None).unwrap_err(),
        GitError::NetworkFailed { code: None, .. }
    ));
}

// --- PushDelete accessors ---

#[test]
fn push_delete_exposes_the_validated_remote_name_and_workdir() {
    let (_d, _b, path, session) = fixture();
    let push = session
        .prepare_remote_delete("origin", "feat/slash")
        .unwrap();
    assert_eq!(push.remote(), "origin");
    assert_eq!(push.name(), "feat/slash");
    assert_eq!(common::canonical(push.workdir()), common::canonical(&path));
}

// --- checkout of a commit (GR-8) ---

/// Plain repo with one commit and the stand-in git first on PATH.
fn commit_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, git2::Oid) {
    use_fake_git();
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let oid = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session, oid)
}

#[test]
fn checkout_commit_runs_switch_detach_with_the_full_hex_oid() {
    let (_d, path, session, oid) = commit_fixture();
    session.checkout_commit(&oid.to_string()).unwrap();
    assert_eq!(
        after_workdir(&path),
        ["switch".to_owned(), "--detach".to_owned(), oid.to_string()]
    );
}

#[test]
fn checkout_commit_passes_the_canonical_lowercase_oid_when_given_uppercase_hex() {
    let (_d, path, session, oid) = commit_fixture();
    session
        .checkout_commit(&oid.to_string().to_uppercase())
        .unwrap();
    assert_eq!(after_workdir(&path)[2], oid.to_string());
}

#[test]
fn checkout_commit_does_not_run_git_when_the_oid_is_unknown() {
    let (_d, path, session, _oid) = commit_fixture();
    let _ = session.checkout_commit(&"0".repeat(40));
    assert!(!path.join(".git").join("argv.txt").exists());
}

#[test]
fn checkout_commit_maps_a_failing_switch_to_checkout_failed_with_the_output() {
    let (_d, path, session, oid) = commit_fixture();
    script_behaviour(&path, "echo 'boom' >&2\nexit 128");
    match session.checkout_commit(&oid.to_string()).unwrap_err() {
        GitError::CheckoutFailed { code, stderr, .. } => {
            assert_eq!(code, Some(128));
            assert!(stderr.contains("boom"));
        }
        other => panic!("expected CheckoutFailed, got {other:?}"),
    }
}

// --- GR-10a: merge, rebase, cherry-pick, revert, abort and continue ---

fn editor(path: &Path) -> String {
    std::fs::read_to_string(path.join(".git").join("editor.txt"))
        .expect("the stand-in git was not run")
}

/// A repo with one commit and a branch `other` at it; nothing in progress.
fn operation_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    use_fake_git();
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let oid = {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("other", &commit, false).unwrap();
        commit.id().to_string()
    };
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session, oid)
}

#[test]
fn merge_runs_no_ff_no_edit() {
    let (_d, path, session, _oid) = operation_fixture();
    session.merge_branch("other", MergeMode::Merge).unwrap();
    assert_eq!(
        after_workdir(&path),
        ["merge", "--no-ff", "--no-edit", "other"]
    );
}

#[test]
fn fast_forward_runs_ff_only() {
    let (_d, path, session, _oid) = operation_fixture();
    session
        .merge_branch("other", MergeMode::FastForward)
        .unwrap();
    assert_eq!(after_workdir(&path), ["merge", "--ff-only", "other"]);
}

#[test]
fn rebase_runs_git_rebase_with_the_branch() {
    let (_d, path, session, _oid) = operation_fixture();
    session.rebase_onto("other").unwrap();
    assert_eq!(after_workdir(&path), ["rebase", "other"]);
}

#[test]
fn rebase_runs_git_with_editor_disabled() {
    let (_d, path, session, _oid) = operation_fixture();
    session.rebase_onto("other").unwrap();
    assert_eq!(editor(&path), "true");
}

#[test]
fn rebase_reports_completed_when_git_exits_zero() {
    let (_d, _p, session, _oid) = operation_fixture();
    assert_eq!(
        session.rebase_onto("other").unwrap(),
        OperationOutcome::Completed
    );
}

#[test]
fn cherry_pick_runs_git_cherry_pick_with_the_full_oid() {
    let (_d, path, session, oid) = operation_fixture();
    session.cherry_pick(&oid).unwrap();
    assert_eq!(after_workdir(&path), ["cherry-pick", oid.as_str()]);
}

#[test]
fn revert_runs_no_edit_with_the_full_oid() {
    let (_d, path, session, oid) = operation_fixture();
    session.revert_commit(&oid).unwrap();
    assert_eq!(after_workdir(&path), ["revert", "--no-edit", oid.as_str()]);
}

#[test]
fn abort_during_a_merge_runs_merge_abort() {
    let (_d, path, session, oid) = operation_fixture();
    std::fs::write(path.join(".git").join("MERGE_HEAD"), format!("{oid}\n")).unwrap();
    session.abort_operation().unwrap();
    assert_eq!(after_workdir(&path), ["merge", "--abort"]);
}

#[test]
fn abort_during_a_cherry_pick_runs_cherry_pick_abort() {
    let (_d, path, session, oid) = operation_fixture();
    std::fs::write(
        path.join(".git").join("CHERRY_PICK_HEAD"),
        format!("{oid}\n"),
    )
    .unwrap();
    session.abort_operation().unwrap();
    assert_eq!(after_workdir(&path), ["cherry-pick", "--abort"]);
}

#[test]
fn abort_during_a_revert_runs_revert_abort() {
    let (_d, path, session, oid) = operation_fixture();
    std::fs::write(path.join(".git").join("REVERT_HEAD"), format!("{oid}\n")).unwrap();
    session.abort_operation().unwrap();
    assert_eq!(after_workdir(&path), ["revert", "--abort"]);
}

#[test]
fn abort_during_a_rebase_runs_rebase_abort() {
    let (_d, path, session, _oid) = operation_fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    session.abort_operation().unwrap();
    assert_eq!(after_workdir(&path), ["rebase", "--abort"]);
}

#[test]
fn continue_rebase_runs_rebase_continue() {
    let (_d, path, session, _oid) = operation_fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    session.continue_rebase().unwrap();
    assert_eq!(after_workdir(&path), ["rebase", "--continue"]);
}

#[test]
fn continue_rebase_runs_git_with_editor_disabled() {
    let (_d, path, session, _oid) = operation_fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    session.continue_rebase().unwrap();
    assert_eq!(editor(&path), "true");
}

#[test]
fn merge_does_not_run_git_when_the_branch_is_unknown() {
    let (_d, path, session, _oid) = operation_fixture();
    let _ = session.merge_branch("nope", MergeMode::Merge);
    assert!(!path.join(".git").join("argv.txt").exists());
}

#[test]
fn a_nonzero_exit_on_a_clean_repo_is_operation_failed_with_the_captured_output() {
    let (_d, path, session, _oid) = operation_fixture();
    script_behaviour(&path, "echo out\necho err >&2\nexit 3");
    match session.merge_branch("other", MergeMode::Merge).unwrap_err() {
        GitError::OperationFailed {
            verb,
            code,
            stdout,
            stderr,
        } => {
            assert_eq!(verb, "merge");
            assert_eq!(code, Some(3));
            assert_eq!(stdout.trim(), "out");
            assert_eq!(stderr.trim(), "err");
        }
        other => panic!("expected OperationFailed, got {other:?}"),
    }
}

// --- GR-10a cycle 1 coverage ---

/// Puts `.git` into the state whose marker is `marker` (a file or, with a
/// trailing slash, a directory).
fn enter_operation(path: &Path, oid: &str, marker: &str) {
    let git_dir = path.join(".git");
    match marker {
        "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" => {
            std::fs::write(git_dir.join(marker), format!("{oid}\n")).unwrap();
        }
        "rebase-merge/" => std::fs::create_dir_all(git_dir.join("rebase-merge")).unwrap(),
        other => panic!("unknown marker {other}"),
    }
}

#[test]
fn a_failing_abort_is_operation_failed_naming_the_verb_and_carrying_the_output() {
    for (marker, verb) in [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("rebase-merge/", "rebase"),
    ] {
        let (_d, path, session, oid) = operation_fixture();
        enter_operation(&path, &oid, marker);
        script_behaviour(&path, "echo out\necho err >&2\nexit 5");

        match session.abort_operation().unwrap_err() {
            GitError::OperationFailed {
                verb: got,
                code,
                stdout,
                stderr,
            } => {
                assert_eq!(got, verb, "{marker}");
                assert_eq!(code, Some(5), "{marker}");
                assert_eq!(stdout.trim(), "out", "{marker}");
                assert_eq!(stderr.trim(), "err", "{marker}");
            }
            other => panic!("{marker}: expected OperationFailed, got {other:?}"),
        }
    }
}

#[test]
fn an_interactive_rebase_is_aborted_and_continued_with_rebase() {
    let (_d, path, session, _oid) = operation_fixture();
    let dir = path.join(".git").join("rebase-merge");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("interactive"), "").unwrap();

    session.abort_operation().unwrap();
    assert_eq!(after_workdir(&path), ["rebase", "--abort"]);
    std::fs::remove_file(path.join(".git").join("argv.txt")).unwrap();
    session.continue_rebase().unwrap();
    assert_eq!(after_workdir(&path), ["rebase", "--continue"]);
}

#[test]
fn an_apply_style_rebase_is_aborted_and_continued_with_rebase() {
    let (_d, path, session, _oid) = operation_fixture();
    let dir = path.join(".git").join("rebase-apply");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("rebasing"), "").unwrap();

    session.abort_operation().unwrap();
    assert_eq!(after_workdir(&path), ["rebase", "--abort"]);
    std::fs::remove_file(path.join(".git").join("argv.txt")).unwrap();
    session.continue_rebase().unwrap();
    assert_eq!(after_workdir(&path), ["rebase", "--continue"]);
}

#[test]
fn a_multi_commit_cherry_pick_or_revert_is_aborted_with_its_own_verb() {
    for (head, todo, verb) in [
        ("CHERRY_PICK_HEAD", "pick abc\n", "cherry-pick"),
        ("REVERT_HEAD", "revert abc\n", "revert"),
    ] {
        let (_d, path, session, oid) = operation_fixture();
        enter_operation(&path, &oid, head);
        let dir = path.join(".git").join("sequencer");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("todo"), todo).unwrap();

        session.abort_operation().unwrap();

        assert_eq!(after_workdir(&path), [verb, "--abort"], "{todo:?}");
    }
}

#[test]
fn abort_and_continue_do_not_run_git_when_nothing_is_in_progress() {
    let (_d, path, session, _oid) = operation_fixture();

    assert!(matches!(
        session.abort_operation().unwrap_err(),
        GitError::NoOperation
    ));
    assert!(matches!(
        session.continue_rebase().unwrap_err(),
        GitError::NoOperation
    ));
    assert!(!path.join(".git").join("argv.txt").exists());
}

#[test]
fn continue_does_not_run_git_while_conflicts_remain() {
    let (_d, path) = common::temp_repo_with_conflict();
    common::configure_identity(&path);
    use_fake_git();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    let session = RepoSession::open(&path).unwrap();

    let err = session.continue_rebase().unwrap_err();

    assert!(matches!(err, GitError::UnresolvedConflicts), "{err:?}");
    assert!(!path.join(".git").join("argv.txt").exists());
}

#[test]
fn a_failing_continue_with_nothing_conflicted_is_operation_failed() {
    let (_d, path, session, _oid) = operation_fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    script_behaviour(&path, "echo hook said no >&2\nexit 1");

    match session.continue_rebase().unwrap_err() {
        GitError::OperationFailed {
            verb, code, stderr, ..
        } => {
            assert_eq!(verb, "rebase");
            assert_eq!(code, Some(1));
            assert!(stderr.contains("hook said no"), "{stderr}");
        }
        other => panic!("expected OperationFailed, got {other:?}"),
    }
}

#[test]
fn a_failing_fast_forward_merge_runs_ff_only_and_is_operation_failed() {
    let (_d, path, session, _oid) = operation_fixture();
    script_behaviour(&path, "echo 'not possible to fast-forward' >&2\nexit 128");

    match session
        .merge_branch("other", MergeMode::FastForward)
        .unwrap_err()
    {
        GitError::OperationFailed {
            verb, code, stderr, ..
        } => {
            assert_eq!(verb, "merge");
            assert_eq!(code, Some(128));
            assert!(stderr.contains("fast-forward"), "{stderr}");
        }
        other => panic!("expected OperationFailed, got {other:?}"),
    }
    assert_eq!(after_workdir(&path), ["merge", "--ff-only", "other"]);
}

#[test]
fn cherry_pick_and_revert_failures_name_their_own_verb() {
    for revert in [false, true] {
        let (_d, path, session, oid) = operation_fixture();
        script_behaviour(&path, "exit 1");

        let err = if revert {
            session.revert_commit(&oid).unwrap_err()
        } else {
            session.cherry_pick(&oid).unwrap_err()
        };

        match err {
            GitError::OperationFailed { verb, .. } => {
                assert_eq!(verb, if revert { "revert" } else { "cherry-pick" });
            }
            other => panic!("expected OperationFailed, got {other:?}"),
        }
    }
}

#[test]
fn cherry_pick_and_revert_do_not_run_git_for_an_unknown_oid() {
    let (_d, path, session, _oid) = operation_fixture();

    let _ = session.cherry_pick(&"0".repeat(40));
    let _ = session.revert_commit(&"0".repeat(40));

    assert!(!path.join(".git").join("argv.txt").exists());
}

#[test]
fn the_cherry_pick_target_is_passed_as_the_canonical_lowercase_oid() {
    let (_d, path, session, oid) = operation_fixture();

    session.cherry_pick(&oid.to_uppercase()).unwrap();

    assert_eq!(after_workdir(&path), ["cherry-pick", oid.as_str()]);
}

// --- GR-10c: interactive rebase ---

/// Behaviour that records `GIT_SEQUENCE_EDITOR` and then runs it the way git
/// would (through `sh -c`, so the quoting is exercised), handing it
/// `<.git>/todo.txt` to overwrite.
const CAPTURE_EDITOR: &str = r#"printf '%s' "$GIT_SEQUENCE_EDITOR" > "$2/.git/seq-editor.txt"
sh -c "$GIT_SEQUENCE_EDITOR \"\$@\"" editor "$2/.git/todo.txt""#;

/// `operation_fixture` plus one commit on top of `other`: returns the new oid.
fn interactive_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (dir, path, _session, _oid) = operation_fixture();
    let oid = common::commit_file(&path, "x.txt", "x\n", "add x").to_string();
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session, oid)
}

fn pick(oid: &str) -> git_real_core::RebaseStep {
    git_real_core::RebaseStep {
        action: git_real_core::RebaseAction::Pick,
        oid: oid.to_owned(),
    }
}

/// The todo file path embedded in the recorded `GIT_SEQUENCE_EDITOR` (`cp '<path>'`).
fn todo_path(path: &Path) -> PathBuf {
    let editor = std::fs::read_to_string(path.join(".git").join("seq-editor.txt"))
        .expect("the stand-in git did not record the sequence editor");
    let quoted = editor
        .strip_prefix("cp '")
        .and_then(|rest| rest.strip_suffix('\''))
        .unwrap_or_else(|| panic!("unexpected sequence editor {editor:?}"));
    // Undo the shell quoting: each `'` in the path was written as `'\''`.
    PathBuf::from(quoted.replace("'\\''", "'"))
}

// The temp root of this binary holds a `'` (see `QUOTED_TMP`), so the quoted
// editor command only works if the quote is escaped: the shell would otherwise
// split the path and `cp` would not find the todo.
#[test]
fn rebase_interactive_quotes_a_temp_path_that_contains_a_single_quote() {
    let (_d, path, session, oid) = interactive_fixture();
    script_behaviour(&path, CAPTURE_EDITOR);

    session.rebase_interactive("other", &[pick(&oid)]).unwrap();

    let editor = std::fs::read_to_string(path.join(".git").join("seq-editor.txt")).unwrap();
    assert!(editor.contains(r"it'\''s-a-tmp-"), "{editor:?}");
    let todo = std::fs::read_to_string(path.join(".git").join("todo.txt")).unwrap();
    assert_eq!(todo, format!("pick {oid} add x\n"));
}

#[test]
fn rebase_interactive_runs_git_rebase_i_with_the_resolved_base_oid() {
    let (_d, path, session, oid) = interactive_fixture();
    let base = branch_oid(&path, "other");

    session.rebase_interactive("other", &[pick(&oid)]).unwrap();

    assert_eq!(after_workdir(&path), ["rebase", "-i", base.as_str()]);
}

#[test]
fn rebase_interactive_runs_git_with_the_commit_editor_disabled() {
    let (_d, path, session, oid) = interactive_fixture();

    session.rebase_interactive("other", &[pick(&oid)]).unwrap();

    assert_eq!(editor(&path), "true");
}

#[test]
fn rebase_interactive_hands_git_a_todo_with_one_line_per_step() {
    let (_d, path, session, oid) = interactive_fixture();
    script_behaviour(&path, CAPTURE_EDITOR);

    session.rebase_interactive("other", &[pick(&oid)]).unwrap();

    let todo = std::fs::read_to_string(path.join(".git").join("todo.txt")).unwrap();
    assert_eq!(todo, format!("pick {oid} add x\n"));
}

// Control characters in a subject must not corrupt the todo handed to git.
#[test]
fn rebase_interactive_replaces_tabs_and_escapes_in_subjects_with_spaces() {
    let (_d, path, _session, _oid) = operation_fixture();
    let a = common::commit_file(&path, "a.txt", "a\n", "tab\there").to_string();
    let b = common::commit_file(&path, "b.txt", "b\n", "esc\x1b[0m done").to_string();
    let session = RepoSession::open(&path).unwrap();
    script_behaviour(&path, CAPTURE_EDITOR);
    let steps = [
        git_real_core::RebaseStep {
            action: git_real_core::RebaseAction::Pick,
            oid: a.clone(),
        },
        git_real_core::RebaseStep {
            action: git_real_core::RebaseAction::Pick,
            oid: b.clone(),
        },
    ];

    session.rebase_interactive("other", &steps).unwrap();

    let todo = std::fs::read_to_string(path.join(".git").join("todo.txt")).unwrap();
    assert_eq!(todo, format!("pick {a} tab here\npick {b} esc [0m done\n"));
}

#[test]
fn rebase_interactive_reports_completed_when_git_exits_zero_and_nothing_is_in_progress() {
    let (_d, _p, session, oid) = interactive_fixture();

    let outcome = session.rebase_interactive("other", &[pick(&oid)]).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
}

#[test]
fn rebase_interactive_deletes_the_todo_file_after_git_succeeds() {
    let (_d, path, session, oid) = interactive_fixture();
    script_behaviour(&path, CAPTURE_EDITOR);

    session.rebase_interactive("other", &[pick(&oid)]).unwrap();

    assert!(!todo_path(&path).exists());
}

#[test]
fn rebase_interactive_deletes_the_todo_file_when_git_fails() {
    let (_d, path, session, oid) = interactive_fixture();
    script_behaviour(&path, &format!("{CAPTURE_EDITOR}\nexit 1"));

    let err = session
        .rebase_interactive("other", &[pick(&oid)])
        .unwrap_err();

    assert!(matches!(err, GitError::OperationFailed { .. }), "{err:?}");
    assert!(!todo_path(&path).exists());
}

#[test]
fn rebase_interactive_failure_is_operation_failed_with_the_rebase_verb() {
    let (_d, path, session, oid) = interactive_fixture();
    script_behaviour(&path, "echo 'boom' >&2\nexit 128");

    let err = session
        .rebase_interactive("other", &[pick(&oid)])
        .unwrap_err();

    match err {
        GitError::OperationFailed { verb, .. } => assert_eq!(verb, "rebase"),
        other => panic!("expected OperationFailed, got {other:?}"),
    }
}

#[test]
fn rebase_interactive_does_not_run_git_for_an_invalid_plan() {
    let (_d, path, session, oid) = interactive_fixture();
    let squash = git_real_core::RebaseStep {
        action: git_real_core::RebaseAction::Squash,
        oid,
    };

    let err = session.rebase_interactive("other", &[squash]).unwrap_err();

    assert!(matches!(err, GitError::BadSelection), "{err:?}");
    assert!(!path.join(".git").join("argv.txt").exists());
}

#[test]
fn rebase_interactive_stopped_for_edit_is_reported_when_git_exits_zero_mid_rebase() {
    let (_d, path, session, oid) = interactive_fixture();
    script_behaviour(&path, "mkdir -p \"$2/.git/rebase-merge\"\nexit 0");

    let outcome = session.rebase_interactive("other", &[pick(&oid)]).unwrap();

    assert_eq!(outcome, OperationOutcome::Stopped);
}

// git is given the base tip, never the merge base, so it replays onto the branch.
#[test]
fn rebase_interactive_passes_the_base_tip_for_a_diverged_branch() {
    let (_d, path, _session, _oid) = operation_fixture();
    let oid = common::commit_file(&path, "x.txt", "x\n", "add x").to_string();
    let other_tip = {
        let repo = Repository::open(&path).unwrap();
        let other = repo.find_branch("other", BranchType::Local).unwrap();
        let parent = other.get().peel_to_commit().unwrap();
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        let tree = parent.tree().unwrap();
        repo.commit(
            Some("refs/heads/other"),
            &sig,
            &sig,
            "other work",
            &tree,
            &[&parent],
        )
        .unwrap()
        .to_string()
    };
    let session = RepoSession::open(&path).unwrap();

    session.rebase_interactive("other", &[pick(&oid)]).unwrap();

    assert_eq!(after_workdir(&path), ["rebase", "-i", other_tip.as_str()]);
}

// With nothing to replay git is never run.
#[test]
fn rebase_interactive_with_an_empty_plan_is_bad_selection_and_runs_no_git() {
    let (_d, path, session, _oid) = operation_fixture();

    let err = session.rebase_interactive("other", &[]).unwrap_err();

    assert!(matches!(err, GitError::BadSelection), "{err:?}");
    assert!(!path.join(".git").join("argv.txt").exists());
}

// The todo file holds the user's plan, so only the owner may read it.
const RECORD_TODO_MODE: &str = r#"printf '%s' "$GIT_SEQUENCE_EDITOR" > "$2/.git/seq-editor.txt"
workdir="$2"
eval "set -- ${GIT_SEQUENCE_EDITOR#cp }"
stat -c %a "$1" > "$workdir/.git/mode.txt""#;

#[test]
fn rebase_interactive_creates_the_todo_file_with_mode_0600() {
    let (_d, path, session, oid) = interactive_fixture();
    script_behaviour(&path, RECORD_TODO_MODE);

    session.rebase_interactive("other", &[pick(&oid)]).unwrap();

    let mode = std::fs::read_to_string(path.join(".git").join("mode.txt")).unwrap();
    assert_eq!(mode.trim(), "600");
}

fn branch_oid(path: &Path, name: &str) -> String {
    Repository::open(path)
        .unwrap()
        .find_branch(name, BranchType::Local)
        .unwrap()
        .get()
        .target()
        .unwrap()
        .to_string()
}

// `outcome` is shared by every rebase entry point: exit 0 with a rebase still
// in progress is Stopped for `rebase_onto` and `continue_rebase` as well.
#[test]
fn rebase_onto_reports_stopped_when_git_exits_zero_mid_rebase() {
    let (_d, path, session, _oid) = operation_fixture();
    script_behaviour(&path, "mkdir -p \"$2/.git/rebase-merge\"\nexit 0");

    let outcome = session.rebase_onto("other").unwrap();

    assert_eq!(outcome, OperationOutcome::Stopped);
}

#[test]
fn continue_rebase_reports_stopped_when_git_exits_zero_and_the_rebase_goes_on() {
    let (_d, path, session, _oid) = operation_fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();

    let outcome = session.continue_rebase().unwrap();

    assert_eq!(outcome, OperationOutcome::Stopped);
}

#[test]
fn continue_rebase_reports_completed_when_git_exits_zero_and_the_rebase_is_over() {
    let (_d, path, session, _oid) = operation_fixture();
    std::fs::create_dir_all(path.join(".git").join("rebase-merge")).unwrap();
    script_behaviour(&path, "rm -r \"$2/.git/rebase-merge\"\nexit 0");

    let outcome = session.continue_rebase().unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
}

// ---------- GR-11a: stash argv ----------

fn stash_repo() -> (tempfile::TempDir, PathBuf, RepoSession) {
    use_fake_git();
    let (dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "dirty\n");
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session)
}

#[test]
fn stash_push_passes_the_message_as_one_argv_element() {
    let (_d, path, session) = stash_repo();
    script_behaviour(&path, "echo 'No local changes to save'");
    let err = session.stash_push(Some("-x; rm -rf /"), true).unwrap_err();
    assert!(matches!(err, GitError::NothingToStash));
    assert_eq!(
        after_workdir(&path),
        ["stash", "push", "--include-untracked", "-m", "-x; rm -rf /"]
    );
}

#[test]
fn stash_push_without_a_message_has_no_m_flag() {
    let (_d, path, session) = stash_repo();
    let _ = session.stash_push(Some(" \t"), false);
    assert_eq!(after_workdir(&path), ["stash", "push"]);
}

#[test]
fn stash_apply_pop_and_drop_name_the_stash_by_index() {
    let (_d, path, session) = stash_repo();
    let oid = {
        let mut repo = Repository::open(&path).unwrap();
        let sig = git2::Signature::now("T", "t@e").unwrap();
        repo.stash_save(&sig, "via git2", None).unwrap().to_string()
    };
    assert_eq!(
        session.stash_apply(0, &oid).unwrap(),
        git_real_core::StashOutcome::Applied
    );
    assert_eq!(after_workdir(&path), ["stash", "apply", "stash@{0}"]);
    session.stash_pop(0, &oid).unwrap();
    assert_eq!(after_workdir(&path), ["stash", "drop", "stash@{0}"]);
    session.stash_drop(0, &oid).unwrap();
    assert_eq!(after_workdir(&path), ["stash", "drop", "stash@{0}"]);
}

/// Creates a stash with git2 (so `refs/stash` exists) and returns its oid.
fn git2_stash(path: &Path) -> String {
    let mut repo = Repository::open(path).unwrap();
    let sig = git2::Signature::now("T", "t@e").unwrap();
    repo.stash_save(&sig, "via git2", None).unwrap().to_string()
}

fn verbs(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path.join(".git").join("verbs.txt"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

// F2: exit 0 with an unchanged tip and no "No local changes" message is a push.
#[test]
fn stash_push_exit_zero_with_an_unchanged_tip_and_no_message_is_ok() {
    let (_d, _path, session) = stash_repo();
    assert!(matches!(session.stash_push(None, false), Ok(())));
}

// F4: pop is apply then drop of the same index.
#[test]
fn stash_pop_runs_apply_then_drop_of_the_same_index() {
    let (_d, path, session) = stash_repo();
    let oid = git2_stash(&path);
    script_behaviour(
        &path,
        r#"printf '%s %s\n' "$4" "$5" >> "$2/.git/verbs.txt""#,
    );
    let outcome = session.stash_pop(0, &oid).unwrap();
    assert_eq!(verbs(&path), ["apply stash@{0}", "drop stash@{0}"]);
    assert_eq!(outcome, StashOutcome::Applied);
}

#[test]
fn stash_pop_whose_drop_fails_is_applied_not_dropped() {
    let (_d, path, session) = stash_repo();
    let oid = git2_stash(&path);
    script_behaviour(&path, r#"[ "$4" = drop ] && { echo boom >&2; exit 1; }"#);
    assert!(matches!(
        session.stash_pop(0, &oid),
        Ok(StashOutcome::AppliedNotDropped)
    ));
}

#[test]
fn stash_pop_whose_apply_fails_never_drops() {
    let (_d, path, session) = stash_repo();
    let oid = git2_stash(&path);
    script_behaviour(
        &path,
        r#"printf '%s\n' "$4" >> "$2/.git/verbs.txt"; [ "$4" = apply ] && { echo boom >&2; exit 1; }"#,
    );
    assert!(
        matches!(session.stash_pop(0, &oid), Err(GitError::OperationFailed { verb, .. }) if verb == "stash")
    );
    assert_eq!(verbs(&path), ["apply"]);
}

#[test]
fn stash_drop_non_zero_exit_is_operation_failed() {
    let (_d, path, session) = stash_repo();
    let oid = {
        let mut repo = Repository::open(&path).unwrap();
        let sig = git2::Signature::now("T", "t@e").unwrap();
        repo.stash_save(&sig, "via git2", None).unwrap().to_string()
    };
    script_behaviour(&path, "echo 'boom' >&2; exit 1");
    assert!(
        matches!(session.stash_drop(0, &oid), Err(GitError::OperationFailed { verb, .. }) if verb == "stash")
    );
}

// ---------- GR-11b: tag argv ----------

/// A repo whose HEAD commit is returned as full hex; the stand-in git is on PATH.
fn tag_repo() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    use_fake_git();
    let (dir, path) = common::temp_repo_with_commit();
    let head = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
        .to_string();
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session, head)
}

#[test]
fn create_annotated_tag_sends_the_message_on_stdin() {
    let (_d, path, session, head) = tag_repo();
    script_behaviour(&path, r#"cat > "$2/.git/stdin.txt""#);
    session
        .create_tag("v1", &head, Some("Release\n\n-x body\n"))
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        [
            "tag",
            "-a",
            "--cleanup=whitespace",
            "-F",
            "-",
            "v1",
            head.as_str()
        ]
    );
    assert_eq!(
        std::fs::read_to_string(path.join(".git/stdin.txt")).unwrap(),
        "Release\n\n-x body\n"
    );
}

#[test]
fn create_lightweight_tag_passes_no_sign() {
    let (_d, path, session, head) = tag_repo();
    session.create_tag("rel/v1", &head, None).unwrap();
    assert_eq!(
        after_workdir(&path),
        ["tag", "--no-sign", "rel/v1", head.as_str()]
    );
}

#[test]
fn create_tag_with_a_leading_dash_runs_no_git() {
    let (_d, path, session, head) = tag_repo();
    assert!(matches!(
        session.create_tag("-f", &head, Some("m")),
        Err(GitError::InvalidTagName(_))
    ));
    assert!(!path.join(".git/argv.txt").exists());
}

#[test]
fn create_tag_non_zero_exit_is_operation_failed_with_verb_tag() {
    let (_d, path, session, head) = tag_repo();
    script_behaviour(&path, "echo boom >&2; exit 128");
    match session.create_tag("v1", &head, None).unwrap_err() {
        GitError::OperationFailed {
            verb, code, stderr, ..
        } => {
            assert_eq!(
                (verb.as_str(), code, stderr.as_str()),
                ("tag", Some(128), "boom\n")
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn push_tag_pushes_the_full_tag_refname() {
    let (_d, _b, path, session) = fixture();
    common::tag_lightweight(
        &path,
        "v1",
        Repository::open(&path)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap(),
    );
    session
        .prepare_tag_push("origin", "v1")
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(after_workdir(&path), ["push", "origin", "refs/tags/v1"]);
}

#[test]
fn delete_remote_tag_pushes_a_tags_qualified_delete() {
    let (_d, _b, path, session) = fixture();
    common::tag_lightweight(
        &path,
        "rel/v1",
        Repository::open(&path)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap(),
    );
    session
        .prepare_remote_tag_delete("origin", "rel/v1")
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        ["push", "origin", "--delete", "tags/rel/v1"]
    );
}

#[test]
fn tag_push_failure_is_network_failed_with_git_output() {
    let (_d, _b, path, session) = fixture();
    common::tag_lightweight(
        &path,
        "v1",
        Repository::open(&path)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap(),
    );
    script_behaviour(&path, "echo out\necho err >&2\nexit 1");
    for result in [
        session.prepare_tag_push("origin", "v1").unwrap().run(None),
        session
            .prepare_remote_tag_delete("origin", "v1")
            .unwrap()
            .run(None),
    ] {
        assert!(
            matches!(result, Err(GitError::NetworkFailed { code: Some(1), ref stdout, ref stderr, .. }) if stdout == "out\n" && stderr == "err\n")
        );
    }
}

#[test]
fn tag_pushes_expose_the_validated_remote_name_and_workdir() {
    let (_d, _b, path, session) = fixture();
    common::tag_lightweight(
        &path,
        "v1",
        Repository::open(&path)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap(),
    );
    let push = session.prepare_tag_push("origin", "v1").unwrap();
    let delete = session.prepare_remote_tag_delete("origin", "v1").unwrap();
    assert_eq!(
        (push.remote(), push.name(), delete.remote(), delete.name()),
        ("origin", "v1", "origin", "v1")
    );
    let canon = common::canonical(&path);
    assert_eq!(common::canonical(push.workdir()), canon);
    assert_eq!(common::canonical(delete.workdir()), canon);
}

// ---------- GR-39: linked worktree argv ----------

/// A main repo on the stand-in git plus a temp root for worktree folders.
fn worktree_repo() -> (
    tempfile::TempDir,
    PathBuf,
    tempfile::TempDir,
    PathBuf,
    RepoSession,
) {
    use_fake_git();
    let (dir, path) = common::temp_repo_with_commit();
    let root_dir = tempfile::tempdir().unwrap();
    let root = common::canonical(root_dir.path());
    let session = RepoSession::open(&path).unwrap();
    (dir, path, root_dir, root, session)
}

/// Creates a clean linked worktree `name` at `<root>/<name>` with git2; returns its canonical path.
fn git2_worktree(main: &Path, root: &Path, name: &str) -> PathBuf {
    let path = root.join(name);
    Repository::open(main)
        .unwrap()
        .worktree(name, &path, None)
        .unwrap();
    common::canonical(&path)
}

fn new_wt_branch(name: &str, start: Option<&str>) -> git_real_core::WorktreeBranch {
    git_real_core::WorktreeBranch::New {
        name: name.into(),
        start: start.map(str::to_owned),
    }
}

#[test]
fn worktree_add_new_branch_passes_the_start_verbatim() {
    let (_d, path, _r, root, session) = worktree_repo();
    let target = root.join("wt");
    session
        .add_linked_worktree(&target, &new_wt_branch("feat", Some("HEAD~0")))
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        [
            "worktree",
            "add",
            "-b",
            "feat",
            target.to_str().unwrap(),
            "HEAD~0"
        ]
    );
}

#[test]
fn worktree_add_new_branch_without_a_start_has_no_start_element() {
    let (_d, path, _r, root, session) = worktree_repo();
    let target = root.join("wt");
    session
        .add_linked_worktree(&target, &new_wt_branch("feat", None))
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        ["worktree", "add", "-b", "feat", target.to_str().unwrap()]
    );
}

#[test]
fn worktree_add_existing_branch_argv() {
    let (_d, path, _r, root, session) = worktree_repo();
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feat", &commit, false).unwrap();
    }
    let target = root.join("wt");
    session
        .add_linked_worktree(
            &target,
            &git_real_core::WorktreeBranch::Existing {
                name: "feat".into(),
            },
        )
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        ["worktree", "add", target.to_str().unwrap(), "feat"]
    );
}

#[test]
fn worktree_add_passes_a_path_with_spaces_as_one_element() {
    let (_d, path, _r, root, session) = worktree_repo();
    let target = root.join("my work");
    session
        .add_linked_worktree(&target, &new_wt_branch("feat", None))
        .unwrap();
    let args = after_workdir(&path);
    assert!(
        args.contains(&format!("{}/my work", root.display())),
        "{args:?}"
    );
}

#[test]
fn worktree_add_non_zero_exit_is_operation_failed() {
    let (_d, path, _r, root, session) = worktree_repo();
    script_behaviour(&path, "echo 'fatal: nope' >&2; exit 128");
    let err = session
        .add_linked_worktree(&root.join("wt"), &new_wt_branch("feat", None))
        .unwrap_err();
    assert!(
        matches!(err, GitError::OperationFailed { ref verb, code: Some(128), ref stderr, .. }
            if verb == "worktree add" && stderr.contains("fatal: nope")),
        "{err:?}"
    );
}

#[test]
fn worktree_remove_force_argv() {
    let (_d, path, _r, root, session) = worktree_repo();
    let wt = git2_worktree(&path, &root, "w");
    session.remove_linked_worktree(&wt, true).unwrap();
    assert_eq!(
        after_workdir(&path),
        ["worktree", "remove", "--force", wt.to_str().unwrap()]
    );
}

#[test]
fn worktree_remove_without_force_argv() {
    let (_d, path, _r, root, session) = worktree_repo();
    let wt = git2_worktree(&path, &root, "w");
    session.remove_linked_worktree(&wt, false).unwrap();
    assert_eq!(
        after_workdir(&path),
        ["worktree", "remove", wt.to_str().unwrap()]
    );
}

#[test]
fn worktree_remove_non_zero_exit_is_operation_failed() {
    let (_d, path, _r, root, session) = worktree_repo();
    let wt = git2_worktree(&path, &root, "w");
    script_behaviour(&path, "exit 1");
    let err = session.remove_linked_worktree(&wt, true).unwrap_err();
    assert!(
        matches!(err, GitError::OperationFailed { ref verb, .. } if verb == "worktree remove"),
        "{err:?}"
    );
}

#[test]
fn worktree_prune_argv() {
    let (_d, path, _r, _root, session) = worktree_repo();
    session.prune_linked_worktrees().unwrap();
    assert_eq!(after_workdir(&path), ["worktree", "prune"]);
}

#[test]
fn worktree_prune_non_zero_exit_is_operation_failed() {
    let (_d, path, _r, _root, session) = worktree_repo();
    script_behaviour(&path, "exit 1");
    let err = session.prune_linked_worktrees().unwrap_err();
    assert!(
        matches!(err, GitError::OperationFailed { ref verb, .. } if verb == "worktree prune"),
        "{err:?}"
    );
}
