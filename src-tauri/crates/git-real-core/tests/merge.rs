//! GR-10a: merge, rebase, cherry-pick, revert, abort, continue, keep-one-side
//! conflict resolution and the fast-forward check. Tests that reach the git
//! CLI return early when it is not on PATH. The scripted stand-in tests live in
//! `cli_argv.rs` and `cli_unavailable.rs`, which own `PATH`.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::git_cli;
use git_real_core::{
    CommitMessage, ConflictSide, FastForwardCheck, GitError, MergeMode, OperationOutcome,
    OperationState, RepoSession,
};
use git2::{BranchType, Oid, Repository};
use serde_json::json;
use tempfile::TempDir;

const ABSENT_OID: &str = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

fn git_available() -> bool {
    if git_cli::locate().is_err() {
        eprintln!("skipping: git not on PATH");
        return false;
    }
    true
}

fn open(path: &Path) -> RepoSession {
    common::configure_identity(path);
    RepoSession::open(path).expect("open")
}

/// `other` and the base branch both edited README.md; nothing merged yet.
fn diverged() -> (TempDir, PathBuf, RepoSession) {
    let (dir, path) = common::diverged_fixture();
    let session = open(&path);
    (dir, path, session)
}

/// A git2-created merge of `other` into the base branch, README.md conflicted.
fn conflicted_merge() -> (TempDir, PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_conflict();
    let session = open(&path);
    (dir, path, session)
}

fn ahead() -> (TempDir, PathBuf, RepoSession, Oid) {
    let (dir, path, tip) = common::ahead_fixture();
    let session = open(&path);
    (dir, path, session, tip)
}

fn head_oid(path: &Path) -> Oid {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
}

fn parents_of_head(path: &Path) -> Vec<Oid> {
    let repo = Repository::open(path).unwrap();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    commit.parent_ids().collect()
}

fn branch_tip(path: &Path, name: &str) -> Oid {
    Repository::open(path)
        .unwrap()
        .find_branch(name, BranchType::Local)
        .unwrap()
        .get()
        .target()
        .unwrap()
}

fn has_conflicts(path: &Path) -> bool {
    Repository::open(path)
        .unwrap()
        .index()
        .unwrap()
        .has_conflicts()
}

fn read(path: &Path, rel: &str) -> String {
    std::fs::read_to_string(path.join(rel)).unwrap()
}

fn paths(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

fn head_tree_has(path: &Path, rel: &str) -> bool {
    let repo = Repository::open(path).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    tree.get_path(Path::new(rel)).is_ok()
}

fn status_is_clean(session: &RepoSession) -> bool {
    session.status().unwrap().entries.is_empty()
}

/// A fetched copy of the `ahead` fixture where `fast` exists only as
/// `origin/fast` (the local branch is deleted).
fn ahead_with_remote_only_fast() -> (TempDir, TempDir, PathBuf, RepoSession, Oid) {
    let (dir, path, tip) = common::ahead_fixture();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    common::push_branch(&path, "fast");
    common::fetch_remote(&path, "origin");
    assert!(
        Repository::open(&path)
            .unwrap()
            .find_reference("refs/remotes/origin/fast")
            .is_ok(),
        "origin/fast must exist before the local branch is deleted"
    );
    Repository::open(&path)
        .unwrap()
        .find_branch("fast", BranchType::Local)
        .unwrap()
        .delete()
        .unwrap();
    let session = RepoSession::open(&path).unwrap();
    (dir, bare_dir, path, session, tip)
}

/// README.md is both-modified on `other` and on the base branch, built with
/// the real git CLI. `other_edit` / `base_edit` run in the branch's checkout
/// before the commit. Returns the repo with `git merge other` already run.
fn cli_conflict(
    other_edit: impl FnOnce(&Path),
    base_edit: impl FnOnce(&Path),
    setup: impl FnOnce(&Path),
) -> (TempDir, PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    setup(&path);
    let base = common::head_branch_name(&path);
    common::run_git_ok(&path, &["checkout", "-q", "-b", "other"]);
    other_edit(&path);
    common::run_git_ok(&path, &["add", "-A"]);
    common::run_git_ok(&path, &["commit", "-q", "-m", "other side"]);
    common::run_git_ok(&path, &["checkout", "-q", &base]);
    base_edit(&path);
    common::run_git_ok(&path, &["add", "-A"]);
    common::run_git_ok(&path, &["commit", "-q", "-m", "base side"]);
    let merged = common::run_git(&path, &["merge", "other"]);
    assert!(!merged.status.success(), "the merge must conflict");
    assert!(has_conflicts(&path), "the merge must leave conflicts");
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session)
}

// --- operation_state ---

// A repo with nothing in progress reports no operation.
#[test]
fn state_is_none_on_a_clean_repo() {
    let (_d, _p, session) = diverged();

    assert_eq!(session.operation_state(), OperationState::None);
}

// A conflicting merge reports the merged tip, the branch name and git's prepared message.
#[test]
fn state_after_conflicting_merge_names_the_branch() {
    let (_d, path, session) = conflicted_merge();

    let state = session.operation_state();

    let OperationState::Merge {
        head,
        branch,
        message,
    } = state
    else {
        panic!("expected a merge in progress, got {state:?}");
    };
    assert_eq!(head, branch_tip(&path, "other").to_string());
    assert_eq!(branch.as_deref(), Some("other"));
    assert!(
        message.subject.starts_with("Merge branch 'other'"),
        "{}",
        message.subject
    );
}

// A conflicting rebase reports the target, the rebased branch and the step counters.
#[test]
fn state_after_conflicting_rebase_has_step_and_total() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    let head = common::head_branch_name(&path);
    session.rebase_onto("other").unwrap();

    let state = session.operation_state();

    assert_eq!(
        state,
        OperationState::Rebase {
            onto: branch_tip(&path, "other").to_string(),
            onto_name: Some("other".to_string()),
            branch: Some(head),
            step: 1,
            total: 1,
        }
    );
}

// A conflicting cherry-pick reports the picked commit and its message.
#[test]
fn state_after_conflicting_cherry_pick() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    let other = branch_tip(&path, "other");
    session.cherry_pick(&other.to_string()).unwrap();

    let state = session.operation_state();

    let OperationState::CherryPick { oid, message } = state else {
        panic!("expected a cherry-pick in progress, got {state:?}");
    };
    assert_eq!(oid, other.to_string());
    assert_eq!(message.subject, "change on other");
}

// A conflicting revert reports the reverted commit and git's prepared message.
#[test]
fn state_after_conflicting_revert() {
    if !git_available() {
        return;
    }
    let (_d, path) = common::temp_repo_with_commit();
    let session = open(&path);
    let first = common::commit_file(&path, "README.md", "# main\n", "set main");
    common::commit_file(&path, "README.md", "# more\n", "set more");
    session.revert_commit(&first.to_string()).unwrap();

    let state = session.operation_state();

    let OperationState::Revert { oid, message } = state else {
        panic!("expected a revert in progress, got {state:?}");
    };
    assert_eq!(oid, first.to_string());
    assert!(message.subject.starts_with("Revert"), "{}", message.subject);
}

// git's own commit flow strips comment lines from the prepared message.
#[test]
fn state_message_strips_comment_lines() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();
    session.merge_branch("other", MergeMode::Merge).unwrap();

    let state = session.operation_state();

    let OperationState::Merge { message, .. } = state else {
        panic!("expected a merge in progress, got {state:?}");
    };
    assert_eq!(message.subject, "Merge branch 'other'");
    assert!(
        message.body.lines().all(|l| !l.starts_with('#')),
        "{:?}",
        message.body
    );
}

#[test]
fn state_message_drops_hand_written_comment_lines_from_the_body() {
    let (_d, path, session) = conflicted_merge();
    std::fs::write(
        path.join(".git").join("MERGE_MSG"),
        "Subject\n\n# comment\nbody line\n# another\n",
    )
    .unwrap();

    let state = session.operation_state();

    let OperationState::Merge { message, .. } = state else {
        panic!("expected a merge in progress, got {state:?}");
    };
    assert_eq!(message.subject, "Subject");
    assert_eq!(message.body, "body line");
}

// Unreadable or missing rebase marker files degrade to empty fields, never an error.
#[test]
fn state_degrades_when_rebase_files_are_unreadable() {
    let (_d, path) = common::temp_repo_with_commit();
    let dir = path.join(".git").join("rebase-merge");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("head-name"), "refs/heads/topic\n").unwrap();
    let session = RepoSession::open(&path).unwrap();

    let state = session.operation_state();

    assert_eq!(
        state,
        OperationState::Rebase {
            onto: String::new(),
            onto_name: None,
            branch: Some("topic".to_string()),
            step: 0,
            total: 0,
        }
    );
}

// A merge whose MERGE_MSG is missing still reports the merge with an empty message.
#[test]
fn state_of_a_merge_without_a_message_file_has_an_empty_message() {
    let (_d, path, session) = conflicted_merge();
    std::fs::remove_file(path.join(".git").join("MERGE_MSG")).unwrap();

    let state = session.operation_state();

    let OperationState::Merge { message, .. } = state else {
        panic!("expected a merge in progress, got {state:?}");
    };
    assert_eq!(
        message,
        CommitMessage {
            subject: String::new(),
            body: String::new()
        }
    );
}

// --- merge_branch ---

// Mode Merge always records a merge commit, even when a fast-forward is possible.
#[test]
fn merge_creates_a_merge_commit_even_when_ff_is_possible() {
    if !git_available() {
        return;
    }
    let (_d, path, session, tip) = ahead();
    let before = head_oid(&path);

    let outcome = session.merge_branch("fast", MergeMode::Merge).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(parents_of_head(&path), [before, tip]);
}

// Mode FastForward moves the branch pointer and creates no commit.
#[test]
fn fast_forward_moves_head_without_a_commit() {
    if !git_available() {
        return;
    }
    let (_d, path, session, tip) = ahead();

    let outcome = session
        .merge_branch("fast", MergeMode::FastForward)
        .unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(head_oid(&path), tip);
}

#[test]
fn fast_forward_brings_the_new_file_into_the_working_tree() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _tip) = ahead();

    session
        .merge_branch("fast", MergeMode::FastForward)
        .unwrap();

    assert_eq!(read(&path, "fast.txt"), "fast\n");
}

// A fast-forward that is not possible is a plain failure carrying git's message.
#[test]
fn fast_forward_on_diverged_is_operation_failed() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();

    let err = session
        .merge_branch("other", MergeMode::FastForward)
        .unwrap_err();

    assert!(
        matches!(&err, GitError::OperationFailed { verb, stderr, .. }
            if verb == "merge" && stderr.contains("fast-forward")),
        "{err:?}"
    );
}

#[test]
fn fast_forward_on_diverged_leaves_no_operation_state() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();
    let _ = session.merge_branch("other", MergeMode::FastForward);

    assert_eq!(session.operation_state(), OperationState::None);
}

// A content conflict is a normal outcome, not an error.
#[test]
fn merge_conflict_is_conflicts_outcome_and_status_shows_it() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();

    let outcome = session.merge_branch("other", MergeMode::Merge).unwrap();

    assert_eq!(outcome, OperationOutcome::Conflicts);
    let entries = session.status().unwrap().entries;
    assert!(
        entries
            .iter()
            .any(|e| e.path == "README.md" && e.conflicted),
        "{entries:?}"
    );
}

#[test]
fn merge_conflict_leaves_a_merge_in_progress() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();
    session.merge_branch("other", MergeMode::Merge).unwrap();

    assert!(matches!(
        session.operation_state(),
        OperationState::Merge { .. }
    ));
}

#[test]
fn merge_unknown_branch_is_branch_not_found() {
    let (_d, _p, session) = diverged();

    let err = session.merge_branch("nope", MergeMode::Merge).unwrap_err();

    assert!(
        matches!(&err, GitError::BranchNotFound(n) if n == "nope"),
        "{err:?}"
    );
}

// A remote-tracking name (origin/fast) is accepted when no local branch has the name.
#[test]
fn merge_accepts_a_remote_tracking_branch() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, session, tip) = ahead_with_remote_only_fast();

    let outcome = session
        .merge_branch("origin/fast", MergeMode::Merge)
        .unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert!(parents_of_head(&path).contains(&tip));
}

#[test]
fn merge_while_in_progress_is_operation_in_progress() {
    let (_d, _p, session) = conflicted_merge();

    let err = session.merge_branch("other", MergeMode::Merge).unwrap_err();

    assert!(matches!(err, GitError::OperationInProgress), "{err:?}");
}

#[test]
fn merge_rejects_a_dash_prefixed_branch_name() {
    let (_d, _p, session) = diverged();

    let err = session.merge_branch("-x", MergeMode::Merge).unwrap_err();

    assert!(
        matches!(&err, GitError::BranchNotFound(n) if n == "-x"),
        "{err:?}"
    );
}

#[test]
fn merge_on_unborn_is_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = open(&path);

    let err = session.merge_branch("main", MergeMode::Merge).unwrap_err();

    assert!(matches!(err, GitError::UnbornHead), "{err:?}");
}

// A pre-merge-commit hook that refuses is a failure, not a conflict. git 2.43
// leaves MERGE_HEAD behind ("Not committing merge"), so the operation stays in
// progress with no conflicts in the index.
#[cfg(unix)]
#[test]
fn merge_refused_by_pre_merge_commit_hook_is_operation_failed() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _tip) = ahead();
    common::install_hook(&path, "pre-merge-commit", "exit 1");

    let err = session.merge_branch("fast", MergeMode::Merge).unwrap_err();

    assert!(
        matches!(&err, GitError::OperationFailed { verb, .. } if verb == "merge"),
        "{err:?}"
    );
}

#[cfg(unix)]
#[test]
fn merge_refused_by_hook_leaves_the_merge_in_progress() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _tip) = ahead();
    common::install_hook(&path, "pre-merge-commit", "exit 1");
    let _ = session.merge_branch("fast", MergeMode::Merge);

    let state = session.operation_state();

    assert!(matches!(state, OperationState::Merge { .. }), "{state:?}");
}

#[cfg(unix)]
#[test]
fn merge_refused_by_hook_leaves_head_unchanged() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _tip) = ahead();
    let before = head_oid(&path);
    common::install_hook(&path, "pre-merge-commit", "exit 1");
    let _ = session.merge_branch("fast", MergeMode::Merge);

    assert_eq!(head_oid(&path), before);
}

// An untracked file that the merge would overwrite makes git refuse before it starts.
#[test]
fn merge_refused_for_dirty_tree_is_operation_failed() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _tip) = ahead();
    common::write_file(&path, "fast.txt", "local\n");

    let err = session.merge_branch("fast", MergeMode::Merge).unwrap_err();

    assert!(matches!(err, GitError::OperationFailed { .. }), "{err:?}");
}

#[test]
fn merge_refused_for_dirty_tree_leaves_no_operation_state() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _tip) = ahead();
    common::write_file(&path, "fast.txt", "local\n");
    let _ = session.merge_branch("fast", MergeMode::Merge);

    assert_eq!(session.operation_state(), OperationState::None);
}

#[test]
fn merge_refused_for_dirty_tree_keeps_the_local_file() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _tip) = ahead();
    common::write_file(&path, "fast.txt", "local\n");
    let _ = session.merge_branch("fast", MergeMode::Merge);

    assert_eq!(read(&path, "fast.txt"), "local\n");
}

// --- rebase_onto and continue_rebase ---

#[test]
fn rebase_replays_commits_onto_the_target() {
    if !git_available() {
        return;
    }
    let (_d, path, session, tip) = ahead();
    common::commit_file(&path, "local.txt", "local\n", "local work");

    let outcome = session.rebase_onto("fast").unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(parents_of_head(&path), [tip]);
}

#[test]
fn rebase_keeps_the_replayed_change_in_the_tree() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _tip) = ahead();
    common::commit_file(&path, "local.txt", "local\n", "local work");
    session.rebase_onto("fast").unwrap();

    assert!(head_tree_has(&path, "local.txt") && head_tree_has(&path, "fast.txt"));
}

#[test]
fn rebase_conflict_is_conflicts() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();

    let outcome = session.rebase_onto("other").unwrap();

    assert_eq!(outcome, OperationOutcome::Conflicts);
}

#[test]
fn rebase_unknown_branch_is_branch_not_found() {
    let (_d, _p, session) = diverged();

    let err = session.rebase_onto("nope").unwrap_err();

    assert!(
        matches!(&err, GitError::BranchNotFound(n) if n == "nope"),
        "{err:?}"
    );
}

#[test]
fn rebase_while_in_progress_is_operation_in_progress() {
    let (_d, _p, session) = conflicted_merge();

    let err = session.rebase_onto("other").unwrap_err();

    assert!(matches!(err, GitError::OperationInProgress), "{err:?}");
}

#[test]
fn rebase_on_unborn_is_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = open(&path);

    let err = session.rebase_onto("main").unwrap_err();

    assert!(matches!(err, GitError::UnbornHead), "{err:?}");
}

#[test]
fn continue_rebase_with_conflicts_left_is_unresolved_conflicts() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();
    session.rebase_onto("other").unwrap();

    let err = session.continue_rebase().unwrap_err();

    assert!(matches!(err, GitError::UnresolvedConflicts), "{err:?}");
}

#[test]
fn continue_rebase_after_resolution_completes() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    session.rebase_onto("other").unwrap();
    common::write_file(&path, "README.md", "# resolved\n");
    session.stage_paths(&paths(&["README.md"])).unwrap();

    let outcome = session.continue_rebase().unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
}

#[test]
fn continue_rebase_after_resolution_clears_the_state() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    session.rebase_onto("other").unwrap();
    common::write_file(&path, "README.md", "# resolved\n");
    session.stage_paths(&paths(&["README.md"])).unwrap();
    session.continue_rebase().unwrap();

    assert_eq!(session.operation_state(), OperationState::None);
}

#[test]
fn continue_rebase_after_resolution_sits_on_the_target() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    session.rebase_onto("other").unwrap();
    common::write_file(&path, "README.md", "# resolved\n");
    session.stage_paths(&paths(&["README.md"])).unwrap();
    session.continue_rebase().unwrap();

    assert_eq!(parents_of_head(&path), [branch_tip(&path, "other")]);
}

/// Two commits on the base branch both edit README.md, so replaying them onto
/// `other` conflicts at step 1 and again at step 2.
fn two_step_rebase() -> (TempDir, PathBuf, RepoSession) {
    let (dir, path, session) = diverged();
    common::commit_file(&path, "README.md", "# main2\n", "second change on base");
    (dir, path, session)
}

#[test]
fn continue_rebase_stops_again_on_the_next_conflict() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = two_step_rebase();
    assert_eq!(
        session.rebase_onto("other").unwrap(),
        OperationOutcome::Conflicts
    );
    common::write_file(&path, "README.md", "# resolved\n");
    session.stage_paths(&paths(&["README.md"])).unwrap();

    let outcome = session.continue_rebase().unwrap();

    assert_eq!(outcome, OperationOutcome::Conflicts);
}

#[test]
fn continue_rebase_reports_step_two_after_the_second_stop() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = two_step_rebase();
    session.rebase_onto("other").unwrap();
    common::write_file(&path, "README.md", "# resolved\n");
    session.stage_paths(&paths(&["README.md"])).unwrap();
    session.continue_rebase().unwrap();

    let state = session.operation_state();

    assert!(
        matches!(
            state,
            OperationState::Rebase {
                step: 2,
                total: 2,
                ..
            }
        ),
        "{state:?}"
    );
}

#[test]
fn continue_rebase_when_clean_is_no_operation() {
    let (_d, _p, session) = diverged();

    let err = session.continue_rebase().unwrap_err();

    assert!(matches!(err, GitError::NoOperation), "{err:?}");
}

#[test]
fn continue_rebase_during_a_merge_is_no_operation() {
    let (_d, _p, session) = conflicted_merge();

    let err = session.continue_rebase().unwrap_err();

    assert!(matches!(err, GitError::NoOperation), "{err:?}");
}

// --- cherry_pick ---

#[test]
fn cherry_pick_creates_one_commit_with_the_change() {
    if !git_available() {
        return;
    }
    let (_d, path, session, tip) = ahead();
    let before = head_oid(&path);

    let outcome = session.cherry_pick(&tip.to_string()).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(parents_of_head(&path), [before]);
}

#[test]
fn cherry_pick_brings_the_change_into_the_tree() {
    if !git_available() {
        return;
    }
    let (_d, path, session, tip) = ahead();
    session.cherry_pick(&tip.to_string()).unwrap();

    assert_eq!(read(&path, "fast.txt"), "fast\n");
}

#[test]
fn cherry_pick_conflict_is_conflicts() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    let other = branch_tip(&path, "other");

    let outcome = session.cherry_pick(&other.to_string()).unwrap();

    assert_eq!(outcome, OperationOutcome::Conflicts);
}

#[test]
fn cherry_pick_merge_commit_is_merge_commit() {
    let (_d, path, _r, _a, _b, m) = common::merge_fixture();
    let session = open(&path);

    let err = session.cherry_pick(&m.to_string()).unwrap_err();

    assert!(
        matches!(&err, GitError::MergeCommit(o) if *o == m.to_string()),
        "{err:?}"
    );
}

#[test]
fn cherry_pick_malformed_oid_is_commit_not_found() {
    let (_d, _p, session) = diverged();

    let err = session.cherry_pick("not-an-oid").unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

#[test]
fn revert_malformed_oid_is_commit_not_found() {
    let (_d, _p, session) = diverged();

    let err = session.revert_commit("not-an-oid").unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

// Picking a commit whose change HEAD already contains is empty: git stops
// without conflicts, so it is a failure while the pick stays in progress.
#[test]
fn empty_cherry_pick_is_operation_failed_with_state_cherry_pick() {
    if !git_available() {
        return;
    }
    let (_d, _p, session, tip) = ahead();
    session.cherry_pick(&tip.to_string()).unwrap();

    let err = session.cherry_pick(&tip.to_string()).unwrap_err();

    assert!(
        matches!(&err, GitError::OperationFailed { verb, .. } if verb == "cherry-pick"),
        "{err:?}"
    );
    assert!(matches!(
        session.operation_state(),
        OperationState::CherryPick { .. }
    ));
}

#[test]
fn cherry_pick_bad_oid_is_commit_not_found() {
    let (_d, _p, session) = diverged();

    let err = session.cherry_pick(ABSENT_OID).unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

#[test]
fn cherry_pick_while_in_progress_is_operation_in_progress() {
    let (_d, path, session) = conflicted_merge();
    let other = branch_tip(&path, "other");

    let err = session.cherry_pick(&other.to_string()).unwrap_err();

    assert!(matches!(err, GitError::OperationInProgress), "{err:?}");
}

// --- revert_commit ---

#[test]
fn revert_creates_an_inverse_commit() {
    if !git_available() {
        return;
    }
    let (_d, path) = common::temp_repo_with_commit();
    let session = open(&path);
    let before = common::head_branch_name(&path);
    let added = common::commit_file(&path, "a.txt", "a\n", "add a");

    let outcome = session.revert_commit(&added.to_string()).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    let repo = Repository::open(&path).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let grandparent = repo.find_commit(added).unwrap().parent(0).unwrap();
    assert_eq!(head.parent_ids().collect::<Vec<_>>(), [added]);
    assert_eq!(head.tree_id(), grandparent.tree_id());
    assert_eq!(common::head_branch_name(&path), before);
}

#[test]
fn revert_conflict_is_conflicts() {
    if !git_available() {
        return;
    }
    let (_d, path) = common::temp_repo_with_commit();
    let session = open(&path);
    let first = common::commit_file(&path, "README.md", "# main\n", "set main");
    common::commit_file(&path, "README.md", "# more\n", "set more");

    let outcome = session.revert_commit(&first.to_string()).unwrap();

    assert_eq!(outcome, OperationOutcome::Conflicts);
}

#[test]
fn revert_merge_commit_is_merge_commit() {
    let (_d, path, _r, _a, _b, m) = common::merge_fixture();
    let session = open(&path);

    let err = session.revert_commit(&m.to_string()).unwrap_err();

    assert!(
        matches!(&err, GitError::MergeCommit(o) if *o == m.to_string()),
        "{err:?}"
    );
}

#[test]
fn revert_bad_oid_is_commit_not_found() {
    let (_d, _p, session) = diverged();

    let err = session.revert_commit(ABSENT_OID).unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

#[test]
fn revert_while_in_progress_is_operation_in_progress() {
    let (_d, path, session) = conflicted_merge();
    let head = head_oid(&path);

    let err = session.revert_commit(&head.to_string()).unwrap_err();

    assert!(matches!(err, GitError::OperationInProgress), "{err:?}");
}

// --- abort_operation ---

#[test]
fn abort_merge_restores_head_and_clean_tree() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    let before = head_oid(&path);
    session.merge_branch("other", MergeMode::Merge).unwrap();

    session.abort_operation().unwrap();

    assert_eq!(head_oid(&path), before);
    assert!(status_is_clean(&session));
    assert_eq!(session.operation_state(), OperationState::None);
}

#[test]
fn abort_merge_restores_the_conflicted_file() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    session.merge_branch("other", MergeMode::Merge).unwrap();
    session.abort_operation().unwrap();

    assert_eq!(read(&path, "README.md"), "# main\n");
}

#[test]
fn abort_rebase_restores_the_branch() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    let before = head_oid(&path);
    let branch = common::head_branch_name(&path);
    session.rebase_onto("other").unwrap();

    session.abort_operation().unwrap();

    assert_eq!(head_oid(&path), before);
    assert_eq!(common::head_branch_name(&path), branch);
    assert!(status_is_clean(&session));
    assert_eq!(session.operation_state(), OperationState::None);
}

#[test]
fn abort_cherry_pick() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    let before = head_oid(&path);
    let other = branch_tip(&path, "other");
    session.cherry_pick(&other.to_string()).unwrap();

    session.abort_operation().unwrap();

    assert_eq!(head_oid(&path), before);
    assert!(status_is_clean(&session));
    assert_eq!(session.operation_state(), OperationState::None);
}

#[test]
fn abort_revert() {
    if !git_available() {
        return;
    }
    let (_d, path) = common::temp_repo_with_commit();
    let session = open(&path);
    let first = common::commit_file(&path, "README.md", "# main\n", "set main");
    let last = common::commit_file(&path, "README.md", "# more\n", "set more");
    session.revert_commit(&first.to_string()).unwrap();

    session.abort_operation().unwrap();

    assert_eq!(head_oid(&path), last);
    assert!(status_is_clean(&session));
    assert_eq!(session.operation_state(), OperationState::None);
}

#[test]
fn abort_when_clean_is_no_operation() {
    let (_d, _p, session) = diverged();

    let err = session.abort_operation().unwrap_err();

    assert!(matches!(err, GitError::NoOperation), "{err:?}");
}

// --- serde shapes the front end relies on ---

#[test]
fn operation_state_serializes_tagged() {
    let none = serde_json::to_value(OperationState::None).unwrap();
    let rebase = serde_json::to_value(OperationState::Rebase {
        onto: "abc".into(),
        onto_name: None,
        branch: Some("main".into()),
        step: 1,
        total: 1,
    })
    .unwrap();
    let pick = serde_json::to_value(OperationState::CherryPick {
        oid: "abc".into(),
        message: CommitMessage {
            subject: "s".into(),
            body: String::new(),
        },
    })
    .unwrap();

    assert_eq!(none, json!({"kind": "none"}));
    assert_eq!(
        rebase,
        json!({"kind": "rebase", "onto": "abc", "ontoName": null, "branch": "main", "step": 1, "total": 1})
    );
    assert_eq!(
        pick,
        json!({"kind": "cherryPick", "oid": "abc", "message": {"subject": "s", "body": ""}})
    );
}

#[test]
fn operation_state_merge_and_revert_serialize_tagged() {
    let message = CommitMessage {
        subject: "s".into(),
        body: "b".into(),
    };
    let merge = serde_json::to_value(OperationState::Merge {
        head: "h".into(),
        branch: Some("other".into()),
        message: message.clone(),
    })
    .unwrap();
    let revert = serde_json::to_value(OperationState::Revert {
        oid: "o".into(),
        message,
    })
    .unwrap();

    assert_eq!(
        merge,
        json!({"kind": "merge", "head": "h", "branch": "other", "message": {"subject": "s", "body": "b"}})
    );
    assert_eq!(
        revert,
        json!({"kind": "revert", "oid": "o", "message": {"subject": "s", "body": "b"}})
    );
}

#[test]
fn merge_mode_serializes_camel_case() {
    assert_eq!(serde_json::to_value(MergeMode::Merge).unwrap(), "merge");
    assert_eq!(
        serde_json::to_value(MergeMode::FastForward).unwrap(),
        "fastForward"
    );
}

#[test]
fn outcome_side_and_check_serialize_camel_case() {
    assert_eq!(
        serde_json::to_value(OperationOutcome::Completed).unwrap(),
        "completed"
    );
    assert_eq!(
        serde_json::to_value(OperationOutcome::Conflicts).unwrap(),
        "conflicts"
    );
    assert_eq!(serde_json::to_value(ConflictSide::Ours).unwrap(), "ours");
    assert_eq!(
        serde_json::to_value(ConflictSide::Theirs).unwrap(),
        "theirs"
    );
    assert_eq!(
        serde_json::to_value(FastForwardCheck::UpToDate).unwrap(),
        "upToDate"
    );
}

#[test]
fn merge_mode_deserializes_from_the_wire_name() {
    let mode: MergeMode = serde_json::from_value(json!("fastForward")).unwrap();

    assert_eq!(mode, MergeMode::FastForward);
}

#[test]
fn new_error_variants_display_their_messages() {
    assert_eq!(
        GitError::OperationInProgress.to_string(),
        "another operation is in progress"
    );
    assert_eq!(
        GitError::NoOperation.to_string(),
        "no merge, rebase, cherry-pick or revert is in progress"
    );
    assert_eq!(
        GitError::UnresolvedConflicts.to_string(),
        "resolve all conflicts first"
    );
    assert_eq!(
        GitError::MergeCommit("abc".into()).to_string(),
        "abc is a merge commit; choosing a parent is not supported yet"
    );
}

// --- resolve_conflicts ---

#[test]
fn resolve_ours_writes_head_content_and_stages() {
    let (_d, path, session) = conflicted_merge();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Ours)
        .unwrap();

    assert_eq!(read(&path, "README.md"), "# main\n");
}

#[test]
fn resolve_ours_clears_the_conflict() {
    let (_d, path, session) = conflicted_merge();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Ours)
        .unwrap();

    assert!(!has_conflicts(&path));
    assert!(
        session
            .status()
            .unwrap()
            .entries
            .iter()
            .all(|e| !e.conflicted),
        "status still lists a conflict"
    );
}

#[test]
fn resolve_theirs_writes_the_other_side() {
    let (_d, path, session) = conflicted_merge();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Theirs)
        .unwrap();

    assert_eq!(read(&path, "README.md"), "# other\n");
}

#[test]
fn resolve_theirs_stages_the_other_side_in_the_index() {
    let (_d, path, session) = conflicted_merge();
    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Theirs)
        .unwrap();

    let repo = Repository::open(&path).unwrap();
    let index = repo.index().unwrap();
    let entry = index.get_path(Path::new("README.md"), 0).expect("stage 0");
    let blob = repo.find_blob(entry.id).unwrap();
    assert_eq!(blob.content(), b"# other\n");
}

/// README.md is modified on the base branch and deleted on `other` (a
/// modify/delete conflict created by the real git CLI).
fn modify_delete_conflict() -> (TempDir, PathBuf, RepoSession) {
    cli_conflict(
        |p| std::fs::remove_file(p.join("README.md")).unwrap(),
        |p| std::fs::write(p.join("README.md"), "# main\n").unwrap(),
        |_| {},
    )
}

#[test]
fn resolve_keeping_deleted_side_removes_the_file() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = modify_delete_conflict();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Theirs)
        .unwrap();

    assert!(!path.join("README.md").exists());
}

#[test]
fn resolve_keeping_deleted_side_removes_the_index_entry() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = modify_delete_conflict();
    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Theirs)
        .unwrap();

    let index = Repository::open(&path).unwrap().index().unwrap();
    assert!(index.iter().all(|e| e.path != b"README.md"));
    assert!(!index.has_conflicts());
}

#[test]
fn resolve_keeping_the_modified_side_of_a_modify_delete_keeps_the_file() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = modify_delete_conflict();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Ours)
        .unwrap();

    assert_eq!(read(&path, "README.md"), "# main\n");
    assert!(!has_conflicts(&path));
}

/// README.md is executable on both sides and edited differently on each.
#[cfg(unix)]
fn executable_conflict() -> (TempDir, PathBuf, RepoSession) {
    use std::os::unix::fs::PermissionsExt;
    let write = |p: &Path, text: &str| {
        std::fs::write(p.join("README.md"), text).unwrap();
        std::fs::set_permissions(p.join("README.md"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
    };
    cli_conflict(
        |p| write(p, "# other\n"),
        |p| write(p, "# main\n"),
        |p| {
            common::run_git_ok(p, &["config", "core.fileMode", "true"]);
            write(p, "# fixture\n");
            common::run_git_ok(p, &["add", "README.md"]);
            common::run_git_ok(p, &["commit", "-q", "-m", "make executable"]);
        },
    )
}

#[cfg(unix)]
#[test]
fn resolve_keeps_executable_mode_in_the_index() {
    use std::os::unix::fs::PermissionsExt;
    if !git_available() {
        return;
    }
    let (_d, path, session) = executable_conflict();
    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Ours)
        .unwrap();

    let index = Repository::open(&path).unwrap().index().unwrap();
    let entry = index.get_path(Path::new("README.md"), 0).expect("stage 0");
    assert_eq!(entry.mode, 0o100755);
    let on_disk = std::fs::metadata(path.join("README.md"))
        .unwrap()
        .permissions();
    assert_ne!(on_disk.mode() & 0o111, 0, "the executable bit was lost");
}

#[cfg(unix)]
#[test]
fn resolve_keeps_executable_mode_with_the_chosen_content() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = executable_conflict();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Theirs)
        .unwrap();

    assert_eq!(read(&path, "README.md"), "# other\n");
}

#[test]
fn resolve_unconflicted_path_is_path_not_found() {
    let (_d, path, session) = conflicted_merge();
    common::write_file(&path, "clean.txt", "mine\n");
    common::stage(&path, "clean.txt");

    let err = session
        .resolve_conflicts(&paths(&["clean.txt"]), ConflictSide::Ours)
        .unwrap_err();

    assert!(matches!(err, GitError::PathNotFound(_)), "{err:?}");
}

#[test]
fn resolve_unconflicted_path_writes_nothing() {
    let (_d, path, session) = conflicted_merge();
    common::write_file(&path, "clean.txt", "mine\n");
    common::stage(&path, "clean.txt");
    let conflicted_before = read(&path, "README.md");

    let _ = session.resolve_conflicts(&paths(&["clean.txt"]), ConflictSide::Theirs);

    assert_eq!(read(&path, "clean.txt"), "mine\n");
    assert_eq!(read(&path, "README.md"), conflicted_before);
    assert!(has_conflicts(&path));
}

#[test]
fn resolve_two_paths_in_one_call() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = cli_conflict(
        |p| {
            std::fs::write(p.join("README.md"), "# other\n").unwrap();
            std::fs::write(p.join("a.txt"), "other a\n").unwrap();
        },
        |p| {
            std::fs::write(p.join("README.md"), "# main\n").unwrap();
            std::fs::write(p.join("a.txt"), "main a\n").unwrap();
        },
        |p| {
            common::commit_file(p, "a.txt", "base a\n", "add a");
        },
    );

    session
        .resolve_conflicts(&paths(&["README.md", "a.txt"]), ConflictSide::Theirs)
        .unwrap();

    assert_eq!(read(&path, "README.md"), "# other\n");
    assert_eq!(read(&path, "a.txt"), "other a\n");
    assert!(!has_conflicts(&path));
}

#[test]
fn resolve_rejects_a_path_outside_the_repo() {
    let (_d, _p, session) = conflicted_merge();

    for bad in ["../x", ".git/config", "/etc/passwd"] {
        let err = session
            .resolve_conflicts(&paths(&[bad]), ConflictSide::Ours)
            .expect_err("outside repo");

        assert!(matches!(err, GitError::PathNotFound(_)), "{bad}: {err:?}");
    }
}

#[test]
fn resolve_with_one_bad_path_leaves_the_conflict_untouched() {
    let (_d, path, session) = conflicted_merge();

    let _ = session.resolve_conflicts(&paths(&["README.md", "../x"]), ConflictSide::Ours);

    assert!(has_conflicts(&path));
}

#[test]
fn resolve_on_a_clean_repo_is_path_not_found() {
    let (_d, _p, session) = diverged();

    let err = session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Ours)
        .unwrap_err();

    assert!(matches!(err, GitError::PathNotFound(_)), "{err:?}");
}

// --- can_fast_forward ---

#[test]
fn can_fast_forward_is_possible_when_ahead() {
    let (_d, _p, session, _tip) = ahead();

    assert_eq!(
        session.can_fast_forward("fast").unwrap(),
        FastForwardCheck::Possible
    );
}

#[test]
fn can_fast_forward_is_up_to_date_for_the_same_tip() {
    let (_d, _p, session, _tip) = ahead();
    session.create_branch("same", None).unwrap();

    assert_eq!(
        session.can_fast_forward("same").unwrap(),
        FastForwardCheck::UpToDate
    );
}

#[test]
fn can_fast_forward_is_diverged() {
    let (_d, _p, session) = diverged();

    assert_eq!(
        session.can_fast_forward("other").unwrap(),
        FastForwardCheck::Diverged
    );
}

#[test]
fn can_fast_forward_unknown_is_branch_not_found() {
    let (_d, _p, session, _tip) = ahead();

    let err = session.can_fast_forward("nope").unwrap_err();

    assert!(
        matches!(&err, GitError::BranchNotFound(n) if n == "nope"),
        "{err:?}"
    );
}

#[test]
fn can_fast_forward_rejects_a_dash_prefixed_branch_name() {
    let (_d, _p, session, _tip) = ahead();

    let err = session.can_fast_forward("-x").unwrap_err();

    assert!(
        matches!(&err, GitError::BranchNotFound(n) if n == "-x"),
        "{err:?}"
    );
}

#[test]
fn can_fast_forward_unborn_is_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = open(&path);

    let err = session.can_fast_forward("main").unwrap_err();

    assert!(matches!(err, GitError::UnbornHead), "{err:?}");
}

#[test]
fn can_fast_forward_accepts_remote_tracking() {
    let (_d, _b, _p, session, _tip) = ahead_with_remote_only_fast();

    assert_eq!(
        session.can_fast_forward("origin/fast").unwrap(),
        FastForwardCheck::Possible
    );
}
