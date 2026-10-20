//! GR-10a: merge, rebase, cherry-pick, revert, abort, continue, keep-one-side
//! conflict resolution and the fast-forward check. Tests that reach the git
//! CLI return early when it is not on PATH. The scripted stand-in tests live in
//! `cli_argv.rs` and `cli_unavailable.rs`, which own `PATH`.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::git_cli;
use git_real_core::{
    ChangeKind, CommitMessage, ConflictSide, FastForwardCheck, GitError, MergeMode,
    OperationOutcome, OperationState, RebaseAction, RebaseCommit, RebaseStep, RepoSession,
    Signature,
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
            stopped_for_edit: false,
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

// Only git's trailing "# Conflicts:" block is removed from the prepared message.
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
        message
            .body
            .lines()
            .all(|l| l != "# Conflicts:" && !l.starts_with("#\t")),
        "{:?}",
        message.body
    );
}

#[test]
fn state_message_keeps_hash_lines_outside_the_conflicts_block() {
    let (_d, path, session) = conflicted_merge();
    std::fs::write(
        path.join(".git").join("MERGE_MSG"),
        "#42 fix thing\n\n# Heading\nbody line\n\n# Conflicts:\n#\tREADME.md\n",
    )
    .unwrap();

    let state = session.operation_state();

    let OperationState::Merge { message, .. } = state else {
        panic!("expected a merge in progress, got {state:?}");
    };
    assert_eq!(message.subject, "#42 fix thing");
    assert_eq!(message.body, "# Heading\nbody line");
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
            stopped_for_edit: false,
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
        stopped_for_edit: false,
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
        json!({"kind": "rebase", "onto": "abc", "ontoName": null, "branch": "main", "step": 1, "total": 1, "stoppedForEdit": false})
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

// A symlink at the path is replaced, never written through to its target.
// (git 2.43 renames the other side of a file/symlink add/add conflict, so the
// symlink is put in the worktree by hand over a real content conflict.)
#[cfg(unix)]
#[test]
fn resolve_replaces_a_symlink_at_the_path_instead_of_writing_through_it() {
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("target.txt");
    std::fs::write(&target, "outside\n").unwrap();
    let (_d, path, session) = conflicted_merge();
    std::fs::remove_file(path.join("README.md")).unwrap();
    std::os::unix::fs::symlink(&target, path.join("README.md")).unwrap();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Theirs)
        .unwrap();

    let meta = path.join("README.md").symlink_metadata().unwrap();
    assert!(
        meta.file_type().is_file(),
        "README.md must be a regular file"
    );
    assert_eq!(read(&path, "README.md"), "# other\n");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "outside\n");
}

// One clean path in the batch fails the whole call before anything is written.
#[test]
fn resolve_with_a_clean_path_in_the_batch_writes_nothing() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    common::commit_file(&path, "clean.txt", "clean\n", "add clean");
    session.merge_branch("other", MergeMode::Merge).unwrap();
    let conflicted = read(&path, "README.md");
    assert!(conflicted.contains("<<<<<<<"), "{conflicted}");

    let err = session
        .resolve_conflicts(&paths(&["README.md", "clean.txt"]), ConflictSide::Ours)
        .unwrap_err();

    assert!(
        matches!(&err, GitError::PathNotFound(p) if p.as_path() == Path::new("clean.txt")),
        "{err:?}"
    );
    assert!(has_conflicts(&path));
    assert_eq!(read(&path, "README.md"), conflicted);
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

// A branch already contained in HEAD has nothing to fast-forward.
#[test]
fn can_fast_forward_is_up_to_date_for_an_ancestor_branch() {
    let (_d, path, session) = diverged();
    {
        let repo = Repository::open(&path).unwrap();
        let parent = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent(0)
            .unwrap();
        repo.branch("behind", &parent, false).unwrap();
    }

    assert_eq!(
        session.can_fast_forward("behind").unwrap(),
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

// --- GR-10a cycle 1 coverage: state reader degraded paths ---

/// Writes `files` into `<.git>/<dir>` (created) and returns the session.
fn with_marker_dir(path: &Path, dir: &str, files: &[(&str, &str)]) -> RepoSession {
    let marker = path.join(".git").join(dir);
    std::fs::create_dir_all(&marker).unwrap();
    for (name, text) in files {
        std::fs::write(marker.join(name), text).unwrap();
    }
    RepoSession::open(path).unwrap()
}

// The older `rebase-apply/` layout is read through `next` and `last`.
#[test]
fn state_reads_the_rebase_apply_layout() {
    let (_d, path, _s, tip) = ahead();
    let onto = tip.to_string();
    let session = with_marker_dir(
        &path,
        "rebase-apply",
        &[
            ("rebasing", ""),
            ("onto", &format!("{onto}\n")),
            ("next", "2\n"),
            ("last", "5\n"),
            ("head-name", "refs/heads/topic\n"),
        ],
    );

    assert_eq!(
        session.operation_state(),
        OperationState::Rebase {
            onto,
            onto_name: Some("fast".to_string()),
            branch: Some("topic".to_string()),
            step: 2,
            total: 5,
            stopped_for_edit: false,
        }
    );
}

// `rebase-merge/` wins when both layouts exist, so msgnum/end are used, not next/last.
#[test]
fn state_prefers_rebase_merge_over_rebase_apply() {
    let (_d, path, _s, _tip) = ahead();
    std::fs::create_dir_all(path.join(".git").join("rebase-apply")).unwrap();
    std::fs::write(path.join(".git").join("rebase-apply").join("next"), "9\n").unwrap();
    let session = with_marker_dir(&path, "rebase-merge", &[("msgnum", "1\n"), ("end", "3\n")]);

    let state = session.operation_state();

    let OperationState::Rebase { step, total, .. } = state else {
        panic!("expected a rebase, got {state:?}");
    };
    assert_eq!((step, total), (1, 3));
}

// A detached-HEAD rebase, or a ref outside refs/heads/, has no branch name.
#[test]
fn state_rebase_head_name_that_is_not_a_local_branch_is_none() {
    let (_d, path, _s, _tip) = ahead();
    for head_name in ["detached HEAD\n", "refs/tags/v1\n", "\n"] {
        let session = with_marker_dir(&path, "rebase-merge", &[("head-name", head_name)]);

        let state = session.operation_state();

        let OperationState::Rebase { branch, .. } = state else {
            panic!("expected a rebase, got {state:?}");
        };
        assert_eq!(branch, None, "head-name {head_name:?}");
    }
}

// Counts that are not numbers degrade to 0 rather than failing the read.
#[test]
fn state_rebase_counts_that_are_not_numbers_are_zero() {
    let (_d, path, _s, _tip) = ahead();
    let session = with_marker_dir(
        &path,
        "rebase-merge",
        &[("msgnum", "two\n"), ("end", "-1\n")],
    );

    let state = session.operation_state();

    let OperationState::Rebase { step, total, .. } = state else {
        panic!("expected a rebase, got {state:?}");
    };
    assert_eq!((step, total), (0, 0));
}

// Oid files must hold a full 40-hex id: short, non-hex or empty content is "".
#[test]
fn state_rebase_onto_that_is_not_a_full_oid_is_empty() {
    let (_d, path, _s, tip) = ahead();
    let short = &tip.to_string()[..12];
    let non_hex = "g".repeat(40);
    for bad in [short.to_string(), non_hex, String::new()] {
        let session = with_marker_dir(&path, "rebase-merge", &[("onto", &format!("{bad}\n"))]);

        let state = session.operation_state();

        let OperationState::Rebase {
            onto, onto_name, ..
        } = state
        else {
            panic!("expected a rebase, got {state:?}");
        };
        assert_eq!(onto, "", "onto {bad:?}");
        assert_eq!(onto_name, None, "onto {bad:?}");
    }
}

// Only the first line of an oid file counts, and surrounding blanks are trimmed.
#[test]
fn state_oid_file_uses_only_its_first_line() {
    let (_d, path, _s, tip) = ahead();
    let session = with_marker_dir(
        &path,
        "rebase-merge",
        &[("onto", &format!("  {tip}  \nsecond line\n"))],
    );

    let state = session.operation_state();

    let OperationState::Rebase { onto, .. } = state else {
        panic!("expected a rebase, got {state:?}");
    };
    assert_eq!(onto, tip.to_string());
}

// A valid oid that no branch points at keeps the oid and has no name.
#[test]
fn state_onto_without_a_branch_at_it_has_no_name() {
    let (_d, path, _s, _tip) = ahead();
    let orphan = common::commit_file(&path, "orphan.txt", "x\n", "orphan");
    common::run_git_ok(&path, &["reset", "-q", "--hard", "HEAD~1"]);
    let session = with_marker_dir(&path, "rebase-merge", &[("onto", &format!("{orphan}\n"))]);

    let state = session.operation_state();

    let OperationState::Rebase {
        onto, onto_name, ..
    } = state
    else {
        panic!("expected a rebase, got {state:?}");
    };
    assert_eq!(onto, orphan.to_string());
    assert_eq!(onto_name, None);
}

// A merge whose MERGE_HEAD is unreadable keeps the merge state with no head or branch.
#[test]
fn state_merge_with_an_unparsable_merge_head_has_empty_head_and_no_branch() {
    let (_d, path, session) = conflicted_merge();
    std::fs::write(path.join(".git").join("MERGE_HEAD"), "not an oid\n").unwrap();

    let state = session.operation_state();

    let OperationState::Merge { head, branch, .. } = state else {
        panic!("expected a merge, got {state:?}");
    };
    assert_eq!(head, "");
    assert_eq!(branch, None);
}

// A merge of a commit no branch points at has a head but no branch name.
#[test]
fn state_merge_of_an_unnamed_commit_has_a_head_and_no_branch() {
    let (_d, path, session) = conflicted_merge();
    let made = common::run_git_ok(
        &path,
        &["commit-tree", "-m", "dangling", "-p", "HEAD", "HEAD^{tree}"],
    );
    let orphan = String::from_utf8(made.stdout).unwrap().trim().to_string();
    std::fs::write(path.join(".git").join("MERGE_HEAD"), format!("{orphan}\n")).unwrap();

    let state = session.operation_state();

    let OperationState::Merge { head, branch, .. } = state else {
        panic!("expected a merge, got {state:?}");
    };
    assert_eq!(head, orphan);
    assert_eq!(branch, None);
}

// A cherry-pick or revert whose marker file is unreadable reports an empty oid.
#[test]
fn state_cherry_pick_and_revert_with_an_unparsable_marker_have_an_empty_oid() {
    let (_d, path, session) = conflicted_merge();
    std::fs::remove_file(path.join(".git").join("MERGE_HEAD")).unwrap();
    std::fs::write(path.join(".git").join("CHERRY_PICK_HEAD"), "junk\n").unwrap();
    let state = session.operation_state();
    let OperationState::CherryPick { oid, .. } = state else {
        panic!("expected a cherry-pick, got {state:?}");
    };
    assert_eq!(oid, "");

    std::fs::remove_file(path.join(".git").join("CHERRY_PICK_HEAD")).unwrap();
    std::fs::write(path.join(".git").join("REVERT_HEAD"), "junk\n").unwrap();
    let state = session.operation_state();
    let OperationState::Revert { oid, .. } = state else {
        panic!("expected a revert, got {state:?}");
    };
    assert_eq!(oid, "");
}

// A MERGE_MSG that is not UTF-8 is read lossily, never an error.
#[test]
fn state_message_that_is_not_utf8_is_read_lossily() {
    let (_d, path, session) = conflicted_merge();
    std::fs::write(
        path.join(".git").join("MERGE_MSG"),
        b"Merge caf\xe9 branch\n",
    )
    .unwrap();

    let state = session.operation_state();

    let OperationState::Merge { message, .. } = state else {
        panic!("expected a merge, got {state:?}");
    };
    assert!(message.subject.starts_with("Merge caf"), "{message:?}");
    assert!(message.subject.ends_with(" branch"), "{message:?}");
}

// A comment line that is not at column 0 is part of the message, as in git.
#[test]
fn state_message_keeps_lines_where_the_hash_is_not_the_first_character() {
    let (_d, path, session) = conflicted_merge();
    std::fs::write(
        path.join(".git").join("MERGE_MSG"),
        "Subject\n\nfixes #12\n  # indented\n",
    )
    .unwrap();

    let state = session.operation_state();

    let OperationState::Merge { message, .. } = state else {
        panic!("expected a merge, got {state:?}");
    };
    assert_eq!(message.body, "fixes #12\n  # indented");
}

// Bisect is not a merge/rebase/cherry-pick/revert, so no operation is reported.
#[test]
fn state_during_a_bisect_is_none() {
    let (_d, path, _s, _tip) = ahead();
    std::fs::write(path.join(".git").join("BISECT_LOG"), "").unwrap();
    let session = RepoSession::open(&path).unwrap();

    assert_eq!(session.operation_state(), OperationState::None);
}

// Names prefer a local branch over a remote-tracking one at the same commit.
// `origin/HEAD` (a symbolic ref) is never offered as a name.
#[test]
fn state_onto_name_resolves_a_remote_tracking_branch_and_skips_origin_head() {
    let (_d, _b, path, _s, tip) = ahead_with_remote_only_fast();
    common::run_git_ok(
        &path,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/fast",
        ],
    );
    let session = with_marker_dir(&path, "rebase-merge", &[("onto", &format!("{tip}\n"))]);

    let state = session.operation_state();

    let OperationState::Rebase { onto_name, .. } = state else {
        panic!("expected a rebase, got {state:?}");
    };
    assert_eq!(onto_name.as_deref(), Some("origin/fast"));
}

#[test]
fn state_onto_name_prefers_the_local_branch_over_the_remote_one() {
    let (_d, _b, path, session0, tip) = ahead_with_remote_only_fast();
    session0
        .create_branch("zz-local", Some(&tip.to_string()))
        .unwrap();
    let session = with_marker_dir(&path, "rebase-merge", &[("onto", &format!("{tip}\n"))]);

    let state = session.operation_state();

    let OperationState::Rebase { onto_name, .. } = state else {
        panic!("expected a rebase, got {state:?}");
    };
    assert_eq!(onto_name.as_deref(), Some("zz-local"));
}

// --- GR-10a cycle 1 coverage: branch resolution and precedence ---

// origin/HEAD is a symbolic ref with no direct target, so it is not a branch.
#[test]
fn symbolic_origin_head_is_branch_not_found_for_merge_and_fast_forward_check() {
    let (_d, _b, path, session, _tip) = ahead_with_remote_only_fast();
    common::run_git_ok(
        &path,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/fast",
        ],
    );
    let before = head_oid(&path);

    let merge = session.merge_branch("origin/HEAD", MergeMode::Merge);
    let check = session.can_fast_forward("origin/HEAD");

    assert!(matches!(merge, Err(GitError::BranchNotFound(ref n)) if n == "origin/HEAD"));
    assert!(matches!(check, Err(GitError::BranchNotFound(ref n)) if n == "origin/HEAD"));
    assert_eq!(head_oid(&path), before);
}

// Merging a remote-tracking branch really merges its commit.
#[test]
fn merge_of_a_remote_tracking_branch_brings_in_its_file() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, session, tip) = ahead_with_remote_only_fast();

    session
        .merge_branch("origin/fast", MergeMode::FastForward)
        .unwrap();

    assert_eq!(head_oid(&path), tip);
    assert_eq!(read(&path, "fast.txt"), "fast\n");
}

// The in-progress check comes before branch lookup.
#[test]
fn merge_and_rebase_during_an_operation_report_in_progress_before_an_unknown_branch() {
    let (_d, _p, session) = conflicted_merge();

    let merge = session.merge_branch("nope", MergeMode::Merge).unwrap_err();
    let rebase = session.rebase_onto("nope").unwrap_err();

    assert!(matches!(merge, GitError::OperationInProgress), "{merge:?}");
    assert!(
        matches!(rebase, GitError::OperationInProgress),
        "{rebase:?}"
    );
}

#[test]
fn rebase_rejects_a_dash_prefixed_branch_name() {
    let (_d, path, session) = diverged();
    let before = head_oid(&path);

    let err = session.rebase_onto("--abort").unwrap_err();

    assert!(
        matches!(&err, GitError::BranchNotFound(n) if n == "--abort"),
        "{err:?}"
    );
    assert_eq!(head_oid(&path), before);
}

#[test]
fn cherry_pick_and_revert_on_an_unborn_head_are_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = open(&path);

    let pick = session.cherry_pick(ABSENT_OID).unwrap_err();
    let revert = session.revert_commit(ABSENT_OID).unwrap_err();

    assert!(matches!(pick, GitError::UnbornHead), "{pick:?}");
    assert!(matches!(revert, GitError::UnbornHead), "{revert:?}");
}

// The in-progress check comes before the oid lookup.
#[test]
fn cherry_pick_and_revert_during_an_operation_report_in_progress_before_a_bad_oid() {
    let (_d, _p, session) = conflicted_merge();

    let pick = session.cherry_pick("not-an-oid").unwrap_err();
    let revert = session.revert_commit("not-an-oid").unwrap_err();

    assert!(matches!(pick, GitError::OperationInProgress), "{pick:?}");
    assert!(
        matches!(revert, GitError::OperationInProgress),
        "{revert:?}"
    );
}

// A short or absent oid never reaches git.
#[test]
fn cherry_pick_of_a_well_formed_absent_oid_is_commit_not_found() {
    let (_d, _p, session) = diverged();

    let err = session.cherry_pick(ABSENT_OID).unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

#[test]
fn cherry_pick_of_an_abbreviated_oid_is_commit_not_found() {
    let (_d, path, session) = diverged();
    let short = branch_tip(&path, "other").to_string()[..10].to_string();

    let err = session.cherry_pick(&short).unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

// --- GR-10a cycle 1 coverage: abort and continue ---

#[test]
fn continue_rebase_during_a_cherry_pick_or_revert_is_no_operation() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    session
        .cherry_pick(&branch_tip(&path, "other").to_string())
        .unwrap();
    let during_pick = session.continue_rebase().unwrap_err();
    session.abort_operation().unwrap();

    let first = common::commit_file(&path, "R.md", "1\n", "one");
    common::commit_file(&path, "R.md", "2\n", "two");
    session.revert_commit(&first.to_string()).unwrap();
    let during_revert = session.continue_rebase().unwrap_err();

    assert!(
        matches!(during_pick, GitError::NoOperation),
        "{during_pick:?}"
    );
    assert!(
        matches!(during_revert, GitError::NoOperation),
        "{during_revert:?}"
    );
}

// Bisect, and a mailbox apply, are not operations this module can abort or continue.
#[test]
fn abort_and_continue_during_a_bisect_are_no_operation() {
    let (_d, path, _s, _tip) = ahead();
    std::fs::write(path.join(".git").join("BISECT_LOG"), "").unwrap();
    let session = RepoSession::open(&path).unwrap();

    let abort = session.abort_operation().unwrap_err();
    let cont = session.continue_rebase().unwrap_err();

    assert!(matches!(abort, GitError::NoOperation), "{abort:?}");
    assert!(matches!(cont, GitError::NoOperation), "{cont:?}");
}

#[test]
fn abort_and_continue_during_a_mailbox_apply_are_no_operation() {
    let (_d, path, _s, _tip) = ahead();
    let session = with_marker_dir(&path, "rebase-apply", &[("applying", "")]);

    let abort = session.abort_operation().unwrap_err();
    let cont = session.continue_rebase().unwrap_err();

    assert!(matches!(abort, GitError::NoOperation), "{abort:?}");
    assert!(matches!(cont, GitError::NoOperation), "{cont:?}");
}

// Starting an operation is refused while something else is in progress.
#[test]
fn merge_during_a_bisect_is_operation_in_progress() {
    let (_d, path, _s, _tip) = ahead();
    std::fs::write(path.join(".git").join("BISECT_LOG"), "").unwrap();
    let session = RepoSession::open(&path).unwrap();

    let err = session.merge_branch("fast", MergeMode::Merge).unwrap_err();

    assert!(matches!(err, GitError::OperationInProgress), "{err:?}");
}

// Aborting a stopped rebase restores the pre-rebase file and a clean status.
#[test]
fn abort_after_rebase_stops_leaves_the_working_file_as_it_was() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = diverged();
    session.rebase_onto("other").unwrap();

    session.abort_operation().unwrap();

    assert_eq!(read(&path, "README.md"), "# main\n");
    assert_eq!(session.operation_state(), OperationState::None);
    assert!(status_is_clean(&session));
}

// --- GR-10a cycle 1 coverage: can_fast_forward ---

#[test]
fn can_fast_forward_works_from_a_detached_head() {
    let (_d, path, session, _tip) = ahead();
    let head = head_oid(&path);
    Repository::open(&path)
        .unwrap()
        .set_head_detached(head)
        .unwrap();

    assert_eq!(
        session.can_fast_forward("fast").unwrap(),
        FastForwardCheck::Possible
    );
}

// --- GR-10a cycle 1 coverage: resolve_conflicts edges ---

/// Like `modify_delete_conflict`, but the base branch is the one that deleted
/// the file, so the `Ours` stage is the absent one.
fn delete_modify_conflict() -> (TempDir, PathBuf, RepoSession) {
    cli_conflict(
        |p| std::fs::write(p.join("README.md"), "# other\n").unwrap(),
        |p| std::fs::remove_file(p.join("README.md")).unwrap(),
        |_| {},
    )
}

#[test]
fn resolve_ours_when_our_side_deleted_the_file_removes_it_and_clears_the_conflict() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = delete_modify_conflict();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Ours)
        .unwrap();

    assert!(!path.join("README.md").exists());
    let index = Repository::open(&path).unwrap().index().unwrap();
    assert!(index.iter().all(|e| e.path != b"README.md"));
    assert!(!index.has_conflicts());
}

#[test]
fn resolve_theirs_when_our_side_deleted_the_file_restores_their_content() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = delete_modify_conflict();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Theirs)
        .unwrap();

    assert_eq!(read(&path, "README.md"), "# other\n");
    let index = Repository::open(&path).unwrap().index().unwrap();
    assert!(index.get_path(Path::new("README.md"), 0).is_some());
    assert!(!index.has_conflicts());
}

// Keeping the deleted side when the working file is already gone is not an error.
#[test]
fn resolve_keeping_the_deleted_side_when_the_file_is_already_gone_succeeds() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = modify_delete_conflict();
    std::fs::remove_file(path.join("README.md")).unwrap();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Theirs)
        .unwrap();

    assert!(!has_conflicts(&path));
    assert!(!path.join("README.md").exists());
}

// The file's directory is recreated when the working tree no longer has it.
#[test]
fn resolve_recreates_the_parent_directory_of_the_kept_file() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = cli_conflict(
        |p| std::fs::write(p.join("sub").join("f.txt"), "other\n").unwrap(),
        |p| std::fs::remove_file(p.join("sub").join("f.txt")).unwrap(),
        |p| {
            common::write_file(p, "sub/f.txt", "base\n");
            common::stage(p, "sub/f.txt");
            common::run_git_ok(p, &["commit", "-q", "-m", "add sub/f.txt"]);
        },
    );
    std::fs::remove_dir_all(path.join("sub")).ok();

    session
        .resolve_conflicts(&paths(&["sub/f.txt"]), ConflictSide::Theirs)
        .unwrap();

    assert_eq!(read(&path, "sub/f.txt"), "other\n");
    assert!(!has_conflicts(&path));
}

// Listing a path twice resolves it once and still succeeds.
#[test]
fn resolve_with_a_duplicated_path_succeeds() {
    let (_d, path, session) = conflicted_merge();

    session
        .resolve_conflicts(&paths(&["README.md", "README.md"]), ConflictSide::Ours)
        .unwrap();

    assert_eq!(read(&path, "README.md"), "# main\n");
    assert!(!has_conflicts(&path));
}

// An empty selection changes nothing: files, index and conflicts are as they were.
#[test]
fn resolve_with_no_paths_changes_nothing() {
    let (_d, path, session) = conflicted_merge();
    let before = read(&path, "README.md");

    session.resolve_conflicts(&[], ConflictSide::Ours).unwrap();

    assert_eq!(read(&path, "README.md"), before);
    assert!(has_conflicts(&path));
}

// A resolve that resolves some conflicts leaves the others conflicted.
#[test]
fn resolving_one_of_two_conflicts_leaves_the_other_conflicted() {
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
        .resolve_conflicts(&paths(&["a.txt"]), ConflictSide::Ours)
        .unwrap();

    let index = Repository::open(&path).unwrap().index().unwrap();
    let conflicted: Vec<Vec<u8>> = index
        .conflicts()
        .unwrap()
        .map(|c| {
            let c = c.unwrap();
            c.our.or(c.their).or(c.ancestor).unwrap().path
        })
        .collect();
    assert_eq!(conflicted, vec![b"README.md".to_vec()]);
    assert_eq!(read(&path, "a.txt"), "main a\n");
}

// An I/O failure part-way through is returned, and the session's index is reloaded
// from disk so a retry works once the obstacle is gone.
#[cfg(unix)]
#[test]
fn resolve_failing_part_way_reports_the_error_and_a_retry_succeeds() {
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
    let a_conflicted = read(&path, "a.txt");
    std::fs::remove_file(path.join("a.txt")).unwrap();
    std::fs::create_dir(path.join("a.txt")).unwrap();

    let err = session
        .resolve_conflicts(&paths(&["README.md", "a.txt"]), ConflictSide::Theirs)
        .unwrap_err();

    assert!(matches!(err, GitError::Io(_)), "{err:?}");
    assert!(has_conflicts(&path), "the index must not be half-written");
    std::fs::remove_dir(path.join("a.txt")).unwrap();
    std::fs::write(path.join("a.txt"), a_conflicted).unwrap();
    session
        .resolve_conflicts(&paths(&["README.md", "a.txt"]), ConflictSide::Theirs)
        .unwrap();
    assert_eq!(read(&path, "a.txt"), "other a\n");
    assert_eq!(read(&path, "README.md"), "# other\n");
    assert!(!has_conflicts(&path));
}

/// README.md is executable on `other` and plain on the base branch.
#[cfg(unix)]
fn mode_conflict() -> (TempDir, PathBuf, RepoSession) {
    use std::os::unix::fs::PermissionsExt;
    cli_conflict(
        |p| {
            std::fs::write(p.join("README.md"), "# other\n").unwrap();
            std::fs::set_permissions(p.join("README.md"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        },
        |p| std::fs::write(p.join("README.md"), "# main\n").unwrap(),
        |p| {
            common::run_git_ok(p, &["config", "core.fileMode", "true"]);
        },
    )
}

// Keeping the plain side clears execute bits and stages 100644.
#[cfg(unix)]
#[test]
fn resolve_keeping_a_non_executable_side_clears_the_execute_bits() {
    use std::os::unix::fs::PermissionsExt;
    if !git_available() {
        return;
    }
    let (_d, path, session) = mode_conflict();
    std::fs::set_permissions(
        path.join("README.md"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Ours)
        .unwrap();

    let index = Repository::open(&path).unwrap().index().unwrap();
    assert_eq!(
        index.get_path(Path::new("README.md"), 0).unwrap().mode,
        0o100644
    );
    let mode = std::fs::metadata(path.join("README.md"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o111, 0, "mode {mode:o}");
    assert_eq!(read(&path, "README.md"), "# main\n");
}

// Keeping the executable side from a plain file sets exactly the read bits' execute twins.
#[cfg(unix)]
#[test]
fn resolve_keeping_an_executable_side_sets_execute_where_read_is_set() {
    use std::os::unix::fs::PermissionsExt;
    if !git_available() {
        return;
    }
    let (_d, path, session) = mode_conflict();
    std::fs::set_permissions(
        path.join("README.md"),
        std::fs::Permissions::from_mode(0o640),
    )
    .unwrap();

    session
        .resolve_conflicts(&paths(&["README.md"]), ConflictSide::Theirs)
        .unwrap();

    let index = Repository::open(&path).unwrap().index().unwrap();
    assert_eq!(
        index.get_path(Path::new("README.md"), 0).unwrap().mode,
        0o100755
    );
    let mode = std::fs::metadata(path.join("README.md"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o750, "mode {mode:o}");
    assert_eq!(read(&path, "README.md"), "# other\n");
}

// --- write_resolution (GR-10b) ---

fn readme_entry(session: &RepoSession) -> git_real_core::StatusEntry {
    session
        .status()
        .unwrap()
        .entries
        .into_iter()
        .find(|e| e.path == "README.md")
        .expect("README.md listed")
}

// Contract: with stage set, the text lands verbatim and the path's conflict clears.
#[test]
fn write_resolution_with_stage_writes_bytes_and_clears_the_conflict() {
    let (_d, path, session) = conflicted_merge();

    session
        .write_resolution("README.md", "merged\r\nline\r\n", true)
        .unwrap();

    assert_eq!(
        std::fs::read(path.join("README.md")).unwrap(),
        b"merged\r\nline\r\n"
    );
    assert!(!has_conflicts(&path));
    let entry = readme_entry(&session);
    assert_eq!(entry.index, Some(ChangeKind::Modified));
    assert!(!entry.conflicted);
}

// Contract: without stage, the text is written and the conflict stays.
#[test]
fn write_resolution_without_stage_leaves_the_conflict() {
    let (_d, path, session) = conflicted_merge();

    session
        .write_resolution("README.md", "draft\n", false)
        .unwrap();

    assert_eq!(read(&path, "README.md"), "draft\n");
    assert!(has_conflicts(&path));
    assert!(readme_entry(&session).conflicted);
}

// Contract: only conflicted paths are writable; nothing is written otherwise.
#[test]
fn write_resolution_on_an_unconflicted_path_is_path_not_found() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = cli_conflict(
        |p| std::fs::write(p.join("README.md"), "# other\n").unwrap(),
        |p| std::fs::write(p.join("README.md"), "# main\n").unwrap(),
        |p| {
            common::write_file(p, "clean.txt", "clean\n");
            common::commit_all(p, "add clean");
        },
    );

    let result = session.write_resolution("clean.txt", "changed\n", true);

    assert!(matches!(result, Err(GitError::PathNotFound(_))));
    assert_eq!(read(&path, "clean.txt"), "clean\n");
}

#[test]
fn write_resolution_on_a_missing_path_is_path_not_found() {
    let (_d, path, session) = conflicted_merge();

    let result = session.write_resolution("nope.txt", "x\n", true);

    assert!(matches!(result, Err(GitError::PathNotFound(_))));
    assert!(!path.join("nope.txt").exists());
}

#[test]
fn write_resolution_rejects_a_path_outside_the_work_tree() {
    let (_d, path, session) = conflicted_merge();
    // A name derived from the unique temp dir cannot collide with an unrelated file in its parent.
    let sentinel = format!("escaped-{}", path.file_name().unwrap().to_string_lossy());
    let escaped = path.parent().unwrap().join(&sentinel);
    assert!(!escaped.exists());

    let result = session.write_resolution(&format!("../{sentinel}"), "x\n", true);

    assert!(result.is_err());
    assert!(!escaped.exists());
}

// Contract: a symlink at the path is refused and left alone.
#[cfg(unix)]
#[test]
fn write_resolution_refuses_a_symlink_at_the_path() {
    let (_d, path, session) = conflicted_merge();
    std::fs::remove_file(path.join("README.md")).unwrap();
    let target = path.join("link-target.txt");
    std::fs::write(&target, "untouched\n").unwrap();
    std::os::unix::fs::symlink(&target, path.join("README.md")).unwrap();

    let result = session.write_resolution("README.md", "x\n", true);

    assert!(matches!(result, Err(GitError::BadSelection)));
    assert_eq!(std::fs::read_link(path.join("README.md")).unwrap(), target);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "untouched\n");
    assert!(has_conflicts(&path));
}

// Contract: a directory at the path is refused.
#[test]
fn write_resolution_refuses_a_directory_at_the_path() {
    let (_d, path, session) = conflicted_merge();
    std::fs::remove_file(path.join("README.md")).unwrap();
    std::fs::create_dir(path.join("README.md")).unwrap();

    let result = session.write_resolution("README.md", "x\n", true);

    assert!(matches!(result, Err(GitError::BadSelection)));
}

// Contract: rewriting a file keeps its permission bits.
#[cfg(unix)]
#[test]
fn write_resolution_keeps_the_executable_bit() {
    use std::os::unix::fs::PermissionsExt;
    let (_d, path, session) = conflicted_merge();
    std::fs::set_permissions(
        path.join("README.md"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();

    session.write_resolution("README.md", "x\n", true).unwrap();

    let mode = std::fs::metadata(path.join("README.md"))
        .unwrap()
        .permissions()
        .mode();
    assert_ne!(mode & 0o111, 0, "mode {mode:o}");
}

// Contract: a deleted file and its parent directories are recreated.
#[test]
fn write_resolution_recreates_a_deleted_file_with_parents() {
    if !git_available() {
        return;
    }
    let nested = "dir/sub/file.txt";
    let (_d, path, session) = cli_conflict(
        |p| std::fs::write(p.join(nested), "other\n").unwrap(),
        |p| std::fs::write(p.join(nested), "main\n").unwrap(),
        |p| {
            common::write_file(p, nested, "base\n");
            common::commit_all(p, "add nested");
        },
    );
    std::fs::remove_dir_all(path.join("dir")).unwrap();

    session.write_resolution(nested, "fixed\n", true).unwrap();

    assert_eq!(read(&path, nested), "fixed\n");
    assert!(!has_conflicts(&path));
}

// Contract: a refused write leaves the index and status exactly as they were.
#[test]
fn write_resolution_index_is_untouched_when_the_write_fails() {
    let (_d, path, session) = conflicted_merge();
    std::fs::remove_file(path.join("README.md")).unwrap();
    std::fs::create_dir(path.join("README.md")).unwrap();
    let before = session.status().unwrap();

    let _ = session.write_resolution("README.md", "x\n", true);

    assert!(has_conflicts(&path));
    assert_eq!(session.status().unwrap(), before);
}

// ---------- GR-10c: interactive rebase ----------

/// `main` with README, then `feature` with three commits a, b, c (files a.txt,
/// b.txt, c.txt), HEAD on `feature`. Returns the three feature oids oldest
/// first and the main tip. The base branch is renamed `main` so the tests do
/// not depend on git's default branch name.
fn feature_fixture() -> (TempDir, PathBuf, [Oid; 3], Oid) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    common::run_git_ok(&path, &["branch", "-M", "main"]);
    let main_tip = head_oid(&path);
    common::run_git_ok(&path, &["switch", "-c", "feature"]);
    let a = common::commit_file(&path, "a.txt", "a\n", "add a");
    let b = common::commit_file(&path, "b.txt", "b\n", "add b\n\nbody of b");
    let c = common::commit_file(&path, "c.txt", "c\n", "add c");
    (dir, path, [a, b, c], main_tip)
}

fn step(action: RebaseAction, oid: Oid) -> RebaseStep {
    RebaseStep {
        action,
        oid: oid.to_string(),
    }
}

/// Subjects of `main..HEAD`, newest first.
fn subjects(path: &Path) -> Vec<String> {
    let out = common::run_git_ok(path, &["log", "--format=%s", "main..HEAD"]);
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_owned)
        .collect()
}

fn head_message(path: &Path) -> String {
    let out = common::run_git_ok(path, &["log", "-1", "--format=%B"]);
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn plan_oids(plan: &[RebaseCommit]) -> Vec<String> {
    plan.iter().map(|c| c.oid.clone()).collect()
}

fn feature_session(path: &Path) -> RepoSession {
    RepoSession::open(path).expect("open")
}

/// Creates branch `side` at `main` with one commit of its own (so it diverges
/// from `feature`), and returns to `feature`. Returns the side tip.
fn side_off_main(path: &Path) -> Oid {
    let switch = |branch: &str| {
        let repo = Repository::open(path).unwrap();
        repo.set_head(&format!("refs/heads/{branch}")).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    };
    {
        let repo = Repository::open(path).unwrap();
        let main = repo
            .find_branch("main", BranchType::Local)
            .unwrap()
            .get()
            .peel_to_commit()
            .unwrap();
        repo.branch("side", &main, false).unwrap();
    }
    switch("side");
    let tip = common::commit_file(path, "side.txt", "s\n", "side work");
    switch("feature");
    tip
}

/// A root commit with no parents, on a new branch `orphan`. HEAD stays put.
fn orphan_branch(path: &Path) {
    let repo = Repository::open(path).unwrap();
    let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
    let tree = repo
        .find_tree(repo.treebuilder(None).unwrap().write().unwrap())
        .unwrap();
    let oid = repo
        .commit(None, &sig, &sig, "orphan root", &tree, &[])
        .unwrap();
    repo.branch("orphan", &repo.find_commit(oid).unwrap(), false)
        .unwrap();
}

fn is_descendant(path: &Path, ancestor: Oid) -> bool {
    let repo = Repository::open(path).unwrap();
    let head = repo.head().unwrap().target().unwrap();
    repo.graph_descendant_of(head, ancestor).unwrap()
}

/// `feature_fixture` plus x1 and x2, which both rewrite x.txt line 1.
fn conflicting_fixture() -> (TempDir, PathBuf, [Oid; 5]) {
    let (dir, path, [a, b, c], _) = feature_fixture();
    let x1 = common::commit_file(&path, "x.txt", "one\n", "x one");
    let x2 = common::commit_file(&path, "x.txt", "two\n", "x two");
    (dir, path, [a, b, c, x1, x2])
}

// --- rebase_plan: listing ---

// The plan lists main..HEAD oldest first with oid, subject and author.
#[test]
fn rebase_plan_lists_the_range_oldest_first_with_fields() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();

    let plan = feature_session(&path).rebase_plan("main").unwrap();

    assert_eq!(
        plan_oids(&plan),
        [a.to_string(), b.to_string(), c.to_string()]
    );
}

#[test]
fn rebase_plan_uses_the_first_line_as_the_subject() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();

    let plan = feature_session(&path).rebase_plan("main").unwrap();

    assert_eq!(plan[1].subject, "add b");
}

#[test]
fn rebase_plan_carries_the_author_name_email_and_time() {
    if !git_available() {
        return;
    }
    let (_d, path, [_, b, _], _) = feature_fixture();
    let expected_time = Repository::open(&path)
        .unwrap()
        .find_commit(b)
        .unwrap()
        .author()
        .when()
        .seconds();

    let plan = feature_session(&path).rebase_plan("main").unwrap();

    assert_eq!(
        plan[1].author,
        Signature {
            name: "Test User".into(),
            email: "test@example.com".into(),
            time: expected_time,
        }
    );
}

// A full hex oid names the base as well as a branch does; the base itself is excluded.
#[test]
fn rebase_plan_accepts_a_full_oid_base() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();

    let plan = feature_session(&path).rebase_plan(&a.to_string()).unwrap();

    assert_eq!(plan_oids(&plan), [b.to_string(), c.to_string()]);
}

#[test]
fn rebase_plan_accepts_a_remote_tracking_base() {
    if !git_available() {
        return;
    }
    let (_d, path, _, main_tip) = feature_fixture();
    Repository::open(&path)
        .unwrap()
        .reference("refs/remotes/origin/main", main_tip, true, "test")
        .unwrap();

    let plan = feature_session(&path).rebase_plan("origin/main").unwrap();

    assert_eq!(plan.len(), 3);
}

// --- rebase_plan: rejections ---

#[test]
fn rebase_plan_unknown_oid_is_commit_not_found() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();

    let err = feature_session(&path)
        .rebase_plan(&"f".repeat(40))
        .unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

#[test]
fn rebase_plan_unknown_branch_is_branch_not_found() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();

    let err = feature_session(&path).rebase_plan("nope").unwrap_err();

    assert!(
        matches!(&err, GitError::BranchNotFound(n) if n == "nope"),
        "{err:?}"
    );
}

#[test]
fn rebase_plan_dash_prefixed_base_is_branch_not_found() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();

    let err = feature_session(&path).rebase_plan("--exec").unwrap_err();

    assert!(matches!(err, GitError::BranchNotFound(_)), "{err:?}");
}

#[test]
fn rebase_plan_empty_base_is_branch_not_found() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();

    let err = feature_session(&path).rebase_plan("").unwrap_err();

    assert!(matches!(err, GitError::BranchNotFound(_)), "{err:?}");
}

// The range is merge_base(HEAD, base)..HEAD, exactly what `git rebase -i base` replays.

// A base equal to HEAD leaves nothing to replay, which is an empty plan and not an error.
#[test]
fn rebase_plan_head_itself_is_an_empty_plan() {
    if !git_available() {
        return;
    }
    let (_d, path, [_, _, c], _) = feature_fixture();

    let plan = feature_session(&path).rebase_plan(&c.to_string()).unwrap();

    assert!(plan.is_empty(), "{plan:?}");
}

// A diverged branch base: only the HEAD-side commits since the merge base are listed.
#[test]
fn rebase_plan_diverged_branch_lists_only_the_head_side_commits() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    side_off_main(&path);

    let plan = feature_session(&path).rebase_plan("side").unwrap();

    assert_eq!(
        plan_oids(&plan),
        [a.to_string(), b.to_string(), c.to_string()]
    );
}

#[test]
fn rebase_plan_on_a_diverged_fixture_branch_lists_the_head_side_commit() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();

    let plan = session.rebase_plan("other").unwrap();

    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].subject, "change on base");
}

#[test]
fn rebase_plan_descendant_of_head_is_an_empty_plan() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();
    common::run_git_ok(&path, &["switch", "-q", "main"]);

    let plan = feature_session(&path).rebase_plan("feature").unwrap();

    assert!(plan.is_empty(), "{plan:?}");
}

// Histories with no common ancestor cannot be rebased.
#[test]
fn rebase_plan_unrelated_history_is_bad_selection() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();
    orphan_branch(&path);

    let err = feature_session(&path).rebase_plan("orphan").unwrap_err();

    assert!(matches!(err, GitError::BadSelection), "{err:?}");
}

// A merge commit behind the merge base is not replayed, so it is fine.
#[test]
fn rebase_plan_with_a_merge_commit_on_the_base_side_is_ok() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();
    common::run_git_ok(&path, &["switch", "-q", "main"]);
    common::run_git_ok(&path, &["switch", "-q", "-c", "side", "main"]);
    common::commit_file(&path, "side.txt", "s\n", "side work");
    common::run_git_ok(&path, &["switch", "-q", "main"]);
    common::commit_file(&path, "m.txt", "m\n", "main work");
    common::run_git_ok(&path, &["merge", "--no-ff", "-m", "merge side", "side"]);
    common::run_git_ok(&path, &["switch", "-q", "feature"]);

    let plan = feature_session(&path).rebase_plan("main").unwrap();

    assert_eq!(plan.len(), 3);
}

#[test]
fn rebase_plan_while_in_progress_is_operation_in_progress() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();
    assert_eq!(
        session.rebase_onto("other").unwrap(),
        OperationOutcome::Conflicts
    );

    let err = session.rebase_plan("other").unwrap_err();

    assert!(matches!(err, GitError::OperationInProgress), "{err:?}");
}

#[test]
fn rebase_plan_on_unborn_is_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = open(&path);

    let err = session.rebase_plan("main").unwrap_err();

    assert!(matches!(err, GitError::UnbornHead), "{err:?}");
}

// A merge commit in the range cannot be replayed without --rebase-merges.
#[test]
fn rebase_plan_with_a_merge_commit_in_range_is_merge_commit() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();
    common::run_git_ok(&path, &["switch", "-q", "-c", "side", "main"]);
    common::commit_file(&path, "side.txt", "s\n", "side work");
    common::run_git_ok(&path, &["switch", "-q", "feature"]);
    common::run_git_ok(&path, &["merge", "--no-ff", "-m", "merge side", "side"]);
    let merge_oid = head_oid(&path).to_string();

    let err = feature_session(&path).rebase_plan("main").unwrap_err();

    assert!(
        matches!(&err, GitError::MergeCommit(o) if *o == merge_oid),
        "{err:?}"
    );
}

// --- rebase_interactive: running the plan ---

// Reorder c before a, squash b into a: the result is c then a(+b).
#[test]
fn rebase_interactive_reorders_and_squashes() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, c),
        step(RebaseAction::Pick, a),
        step(RebaseAction::Squash, b),
    ];

    let outcome = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(subjects(&path), ["add a", "add c"]);
}

#[test]
fn rebase_interactive_squash_joins_the_messages() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, c),
        step(RebaseAction::Pick, a),
        step(RebaseAction::Squash, b),
    ];
    feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    let body = head_message(&path);

    assert!(
        body.contains("add a") && body.contains("add b") && body.contains("body of b"),
        "{body}"
    );
}

#[test]
fn rebase_interactive_squash_keeps_both_changes_in_the_tree() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Squash, b),
        step(RebaseAction::Drop, c),
    ];

    feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert!(head_tree_has(&path, "a.txt") && head_tree_has(&path, "b.txt"));
    assert_eq!(subjects(&path), ["add a"]);
}

#[test]
fn rebase_interactive_leaves_no_operation_in_progress() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, c),
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
    ];
    let session = feature_session(&path);

    session.rebase_interactive("main", &steps).unwrap();

    assert_eq!(session.operation_state(), OperationState::None);
}

#[test]
fn rebase_interactive_keeps_the_branch_checked_out() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, c),
    ];

    feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert_eq!(common::head_branch_name(&path), "feature");
}

#[test]
fn rebase_interactive_reorder_changes_the_commit_order() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, c),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, a),
    ];

    feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert_eq!(subjects(&path), ["add a", "add b", "add c"]);
}

#[test]
fn rebase_interactive_drop_removes_the_commit_from_the_history() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Drop, b),
        step(RebaseAction::Pick, c),
    ];

    let outcome = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(subjects(&path), ["add c", "add a"]);
}

#[test]
fn rebase_interactive_drop_removes_the_commits_file_from_the_tree() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Drop, b),
        step(RebaseAction::Pick, c),
    ];

    feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert!(!head_tree_has(&path, "b.txt"));
}

#[test]
fn rebase_interactive_fixup_keeps_the_first_message_only() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Fixup, b),
        step(RebaseAction::Pick, c),
    ];
    feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    let msg = common::run_git_ok(&path, &["log", "-1", "--format=%B", "HEAD~1"]);

    assert_eq!(String::from_utf8_lossy(&msg.stdout).trim_end(), "add a");
}

#[test]
fn rebase_interactive_with_every_commit_picked_in_order_keeps_the_oids() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
    ];

    let outcome = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(head_oid(&path), c);
}

// An `edit` step stops git with exit 0: the outcome is Stopped and the state says why.
#[test]
fn rebase_interactive_edit_reports_stopped() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Edit, b),
        step(RebaseAction::Pick, c),
    ];

    let outcome = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert_eq!(outcome, OperationOutcome::Stopped);
}

#[test]
fn rebase_interactive_edit_stop_sets_the_flag_step_total_and_branch() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Edit, b),
        step(RebaseAction::Pick, c),
    ];
    let session = feature_session(&path);
    session.rebase_interactive("main", &steps).unwrap();

    match session.operation_state() {
        OperationState::Rebase {
            stopped_for_edit,
            step,
            total,
            branch,
            ..
        } => {
            assert!(stopped_for_edit);
            assert_eq!((step, total), (2, 3));
            assert_eq!(branch.as_deref(), Some("feature"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn rebase_interactive_edit_stop_has_the_edited_commit_checked_out() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Edit, b),
        step(RebaseAction::Pick, c),
    ];
    feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert!(head_tree_has(&path, "b.txt") && !head_tree_has(&path, "c.txt"));
}

// Continuing after an edit stop amends the staged changes into the stopped commit.
#[test]
fn continue_after_an_edit_stop_amends_staged_changes() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Edit, b),
        step(RebaseAction::Pick, c),
    ];
    let session = feature_session(&path);
    session.rebase_interactive("main", &steps).unwrap();
    common::write_file(&path, "b.txt", "b2\n");
    common::stage(&path, "b.txt");

    let outcome = session.continue_rebase().unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    let shown = common::run_git_ok(&path, &["show", "HEAD~1:b.txt"]);
    assert_eq!(String::from_utf8_lossy(&shown.stdout), "b2\n");
}

#[test]
fn continue_after_an_edit_stop_keeps_the_commit_order_and_clears_the_state() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Edit, b),
        step(RebaseAction::Pick, c),
    ];
    let session = feature_session(&path);
    session.rebase_interactive("main", &steps).unwrap();
    common::write_file(&path, "b.txt", "b2\n");
    common::stage(&path, "b.txt");
    session.continue_rebase().unwrap();

    assert_eq!(subjects(&path), ["add c", "add b", "add a"]);
    assert_eq!(session.operation_state(), OperationState::None);
}

#[test]
fn continue_after_an_edit_stop_with_nothing_staged_completes_unchanged() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Edit, b),
        step(RebaseAction::Pick, c),
    ];
    let session = feature_session(&path);
    session.rebase_interactive("main", &steps).unwrap();

    let outcome = session.continue_rebase().unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(subjects(&path), ["add c", "add b", "add a"]);
}

// A conflict stop is not an edit stop.
#[test]
fn state_without_an_amend_marker_is_not_stopped_for_edit() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();
    session.rebase_onto("other").unwrap();

    let state = session.operation_state();

    assert!(
        matches!(
            state,
            OperationState::Rebase {
                stopped_for_edit: false,
                ..
            }
        ),
        "{state:?}"
    );
}

#[test]
fn state_with_an_amend_marker_in_rebase_merge_is_stopped_for_edit() {
    let (_d, path, _s, _tip) = ahead();
    let session = with_marker_dir(
        &path,
        "rebase-merge",
        &[("msgnum", "1\n"), ("end", "2\n"), ("amend", "")],
    );

    let state = session.operation_state();

    assert!(
        matches!(
            state,
            OperationState::Rebase {
                stopped_for_edit: true,
                ..
            }
        ),
        "{state:?}"
    );
}

// The older rebase-apply layout has no amend marker, even if the file exists there.
#[test]
fn state_with_an_amend_file_in_rebase_apply_is_not_stopped_for_edit() {
    let (_d, path, _s, _tip) = ahead();
    let session = with_marker_dir(
        &path,
        "rebase-apply",
        &[
            ("rebasing", ""),
            ("next", "1\n"),
            ("last", "2\n"),
            ("amend", ""),
        ],
    );

    let state = session.operation_state();

    assert!(
        matches!(
            state,
            OperationState::Rebase {
                stopped_for_edit: false,
                ..
            }
        ),
        "{state:?}"
    );
}

// Swapping two commits that rewrite the same line conflicts.
#[test]
fn rebase_interactive_conflict_is_conflicts() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c, x1, x2]) = conflicting_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
        step(RebaseAction::Pick, x2),
        step(RebaseAction::Pick, x1),
    ];
    let session = feature_session(&path);

    let outcome = session.rebase_interactive("main", &steps).unwrap();

    assert_eq!(outcome, OperationOutcome::Conflicts);
    assert!(has_conflicts(&path));
}

#[test]
fn rebase_interactive_conflict_is_not_flagged_as_an_edit_stop() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c, x1, x2]) = conflicting_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
        step(RebaseAction::Pick, x2),
        step(RebaseAction::Pick, x1),
    ];
    let session = feature_session(&path);
    session.rebase_interactive("main", &steps).unwrap();

    let state = session.operation_state();

    assert!(
        matches!(
            state,
            OperationState::Rebase {
                stopped_for_edit: false,
                ..
            }
        ),
        "{state:?}"
    );
}

// --- rebase_interactive: validation ---

fn assert_rejected_untouched(path: &Path, session: &RepoSession, before: Oid, err: GitError) {
    assert!(matches!(err, GitError::BadSelection), "{err:?}");
    assert_eq!(session.operation_state(), OperationState::None);
    assert_eq!(head_oid(path), before);
    assert!(status_is_clean(session));
}

#[test]
fn rebase_interactive_rejects_an_oid_outside_the_range() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], main_tip) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
        step(RebaseAction::Pick, main_tip),
    ];
    let session = feature_session(&path);

    let err = session.rebase_interactive("main", &steps).unwrap_err();

    assert_rejected_untouched(&path, &session, c, err);
}

#[test]
fn rebase_interactive_rejects_an_unknown_oid() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, _, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        RebaseStep {
            action: RebaseAction::Pick,
            oid: "f".repeat(40),
        },
        step(RebaseAction::Pick, c),
    ];

    let err = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap_err();

    assert!(matches!(err, GitError::BadSelection), "{err:?}");
}

#[test]
fn rebase_interactive_rejects_an_abbreviated_oid() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        RebaseStep {
            action: RebaseAction::Pick,
            oid: b.to_string()[..7].to_string(),
        },
        step(RebaseAction::Pick, c),
    ];

    let err = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap_err();

    assert!(matches!(err, GitError::BadSelection), "{err:?}");
}

#[test]
fn rebase_interactive_rejects_a_duplicate_oid() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, ..], _) = feature_fixture();
    let steps = [step(RebaseAction::Pick, a), step(RebaseAction::Pick, a)];

    let err = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap_err();

    assert!(matches!(err, GitError::BadSelection), "{err:?}");
}

#[test]
fn rebase_interactive_rejects_all_dropped() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Drop, a),
        step(RebaseAction::Drop, b),
        step(RebaseAction::Drop, c),
    ];

    let err = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap_err();

    assert!(matches!(err, GitError::BadSelection), "{err:?}");
}

#[test]
fn rebase_interactive_rejects_an_empty_step_list() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();

    let err = feature_session(&path)
        .rebase_interactive("main", &[])
        .unwrap_err();

    assert!(matches!(err, GitError::BadSelection), "{err:?}");
}

#[test]
fn rebase_interactive_rejects_a_leading_squash() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Squash, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
    ];

    let err = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap_err();

    assert!(matches!(err, GitError::BadSelection), "{err:?}");
}

#[test]
fn rebase_interactive_rejects_a_leading_fixup_after_drops() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Drop, a),
        step(RebaseAction::Fixup, b),
        step(RebaseAction::Pick, c),
    ];

    let err = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap_err();

    assert!(matches!(err, GitError::BadSelection), "{err:?}");
}

// A fold after a drop that follows a kept commit is fine: the first kept step is a pick.
#[test]
fn rebase_interactive_accepts_a_fold_after_a_kept_commit_and_a_drop() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Drop, b),
        step(RebaseAction::Fixup, c),
    ];

    let outcome = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
}

#[test]
fn rebase_interactive_unknown_base_is_branch_not_found() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, ..], _) = feature_fixture();
    let steps = [step(RebaseAction::Pick, a)];

    let err = feature_session(&path)
        .rebase_interactive("nope", &steps)
        .unwrap_err();

    assert!(matches!(err, GitError::BranchNotFound(_)), "{err:?}");
}

#[test]
fn rebase_interactive_while_in_progress_is_operation_in_progress() {
    if !git_available() {
        return;
    }
    let (_d, _p, session) = diverged();
    session.rebase_onto("other").unwrap();
    let steps = [RebaseStep {
        action: RebaseAction::Pick,
        oid: ABSENT_OID.into(),
    }];

    let err = session.rebase_interactive("other", &steps).unwrap_err();

    assert!(matches!(err, GitError::OperationInProgress), "{err:?}");
}

#[test]
fn rebase_interactive_on_unborn_is_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = open(&path);

    let err = session.rebase_interactive("main", &[]).unwrap_err();

    assert!(matches!(err, GitError::UnbornHead), "{err:?}");
}

// A rejected plan must not touch the repository.
#[test]
fn rebase_interactive_validation_errors_leave_the_repository_clean() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let session = feature_session(&path);
    let rejects: [Vec<RebaseStep>; 3] = [
        vec![step(RebaseAction::Pick, a), step(RebaseAction::Pick, a)],
        vec![
            step(RebaseAction::Drop, a),
            step(RebaseAction::Drop, b),
            step(RebaseAction::Drop, c),
        ],
        vec![step(RebaseAction::Squash, a), step(RebaseAction::Pick, b)],
    ];

    for steps in &rejects {
        let err = session.rebase_interactive("main", steps).unwrap_err();
        assert_rejected_untouched(&path, &session, c, err);
    }
}

// --- rebase_interactive: merge-base range ---

// A diverged branch base: the HEAD-side commits are replayed onto its tip.
#[test]
fn rebase_interactive_onto_a_diverged_branch_replays_onto_its_tip() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let side_tip = side_off_main(&path);
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
    ];
    let session = feature_session(&path);

    let outcome = session.rebase_interactive("side", &steps).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert!(is_descendant(&path, side_tip));
    assert_eq!(session.operation_state(), OperationState::None);
}

#[test]
fn rebase_interactive_onto_a_diverged_branch_puts_the_replayed_subjects_on_top() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    side_off_main(&path);
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
    ];

    feature_session(&path)
        .rebase_interactive("side", &steps)
        .unwrap();

    let out = common::run_git_ok(&path, &["log", "--format=%s", "-4"]);
    let subjects: Vec<_> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(subjects, ["add c", "add b", "add a", "side work"]);
}

#[test]
fn rebase_interactive_onto_a_diverged_branch_reorders_and_squashes() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    side_off_main(&path);
    let steps = [
        step(RebaseAction::Pick, c),
        step(RebaseAction::Pick, a),
        step(RebaseAction::Squash, b),
    ];

    feature_session(&path)
        .rebase_interactive("side", &steps)
        .unwrap();

    let out = common::run_git_ok(&path, &["log", "--format=%s", "-3"]);
    let subjects: Vec<_> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(subjects, ["add a", "add c", "side work"]);
}

#[test]
fn rebase_interactive_unrelated_history_is_bad_selection() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    orphan_branch(&path);
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
    ];
    let session = feature_session(&path);

    let err = session.rebase_interactive("orphan", &steps).unwrap_err();

    assert_rejected_untouched(&path, &session, c, err);
}

// An empty plan keeps nothing, so empty steps are rejected too.
#[test]
fn rebase_interactive_with_an_empty_plan_and_empty_steps_is_bad_selection() {
    if !git_available() {
        return;
    }
    let (_d, path, [_, _, c], _) = feature_fixture();
    let session = feature_session(&path);

    let err = session.rebase_interactive(&c.to_string(), &[]).unwrap_err();

    assert_rejected_untouched(&path, &session, c, err);
}

// A subject spanning no extra lines is all the rebase plan reports, whatever the body holds.
#[test]
fn rebase_plan_subject_excludes_the_body() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();
    common::commit_file(&path, "w.txt", "w\n", "weird subject #1\n\nbody\nline");

    let plan = feature_session(&path).rebase_plan("main").unwrap();

    assert_eq!(plan[3].subject, "weird subject #1");
}

// --- GR-10c cycle 1 coverage additions ---

// A second `edit` step makes `continue_rebase` stop again: exit 0 mid-rebase is Stopped there too.
#[test]
fn continue_after_an_edit_stop_stops_again_at_a_later_edit() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Edit, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Edit, c),
    ];
    let session = feature_session(&path);
    assert_eq!(
        session.rebase_interactive("main", &steps).unwrap(),
        OperationOutcome::Stopped
    );

    let outcome = session.continue_rebase().unwrap();

    assert_eq!(outcome, OperationOutcome::Stopped);
    match session.operation_state() {
        OperationState::Rebase {
            stopped_for_edit,
            step,
            total,
            ..
        } => {
            assert!(stopped_for_edit);
            assert_eq!((step, total), (3, 3));
        }
        other => panic!("expected a rebase in progress, got {other:?}"),
    }
    assert!(head_tree_has(&path, "c.txt"));
}

// Finishing the last edit stop completes: the Stopped arm is not sticky.
#[test]
fn continue_after_the_last_edit_stop_completes() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let steps = [
        step(RebaseAction::Edit, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Edit, c),
    ];
    let session = feature_session(&path);
    session.rebase_interactive("main", &steps).unwrap();
    session.continue_rebase().unwrap();

    let outcome = session.continue_rebase().unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(session.operation_state(), OperationState::None);
}

// A plan commit missing from the steps is left out of the todo, so git removes it.
#[test]
fn rebase_interactive_omitting_a_commit_removes_it() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, _b, c], _) = feature_fixture();
    let steps = [step(RebaseAction::Pick, a), step(RebaseAction::Pick, c)];

    let outcome = feature_session(&path)
        .rebase_interactive("main", &steps)
        .unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(subjects(&path), ["add c", "add a"]);
    assert!(!head_tree_has(&path, "b.txt"));
}

// A base given as 40 uppercase hex digits is still a commit, not a branch name.
#[test]
fn rebase_plan_accepts_an_uppercase_full_oid_base() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], main_tip) = feature_fixture();

    let plan = feature_session(&path)
        .rebase_plan(&main_tip.to_string().to_uppercase())
        .unwrap();

    assert_eq!(
        plan_oids(&plan),
        [a.to_string(), b.to_string(), c.to_string()]
    );
}

// 40 hex digits naming a tree (not a commit) are CommitNotFound, never a branch lookup.
#[test]
fn rebase_plan_with_a_tree_oid_as_base_is_commit_not_found() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();
    let out = common::run_git_ok(&path, &["rev-parse", "HEAD^{tree}"]);
    let tree = String::from_utf8_lossy(&out.stdout).trim().to_owned();

    let err = feature_session(&path).rebase_plan(&tree).unwrap_err();

    assert!(
        matches!(err, GitError::CommitNotFound(ref s) if *s == tree),
        "{err:?}"
    );
}

// An abbreviated oid is read as a branch name, so a short hash of a real commit is not found.
#[test]
fn rebase_plan_with_an_abbreviated_oid_base_is_branch_not_found() {
    if !git_available() {
        return;
    }
    let (_d, path, _, main_tip) = feature_fixture();
    let short = main_tip.to_string()[..12].to_owned();

    let err = feature_session(&path).rebase_plan(&short).unwrap_err();

    assert!(
        matches!(err, GitError::BranchNotFound(ref s) if *s == short),
        "{err:?}"
    );
}

// A detached HEAD still has a plan: the range is read from the commit, not a branch.
#[test]
fn rebase_plan_works_on_a_detached_head() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    common::run_git_ok(&path, &["checkout", "--detach"]);

    let plan = feature_session(&path).rebase_plan("main").unwrap();

    assert_eq!(
        plan_oids(&plan),
        [a.to_string(), b.to_string(), c.to_string()]
    );
}

// A commit with an empty message has an empty subject, and rebasing over it still works.
#[test]
fn rebase_interactive_replays_a_commit_with_an_empty_message() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    let empty = common::commit_file(&path, "e.txt", "e\n", "");
    let session = feature_session(&path);
    let plan = session.rebase_plan("main").unwrap();
    assert_eq!(plan[3].subject, "");
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
        step(RebaseAction::Pick, empty),
    ];

    let outcome = session.rebase_interactive("main", &steps).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert!(head_tree_has(&path, "e.txt"));
}

// A merge commit in the range is refused by the run as well as by the plan, before git starts.
#[test]
fn rebase_interactive_with_a_merge_commit_in_range_is_merge_commit() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();
    common::run_git_ok(&path, &["switch", "-c", "side", "main"]);
    common::commit_file(&path, "s.txt", "s\n", "side work");
    common::run_git_ok(&path, &["switch", "feature"]);
    common::run_git_ok(&path, &["merge", "--no-ff", "-m", "merge side", "side"]);
    let session = feature_session(&path);
    let before = head_oid(&path);

    let err = session.rebase_interactive("main", &[]).unwrap_err();

    assert!(matches!(err, GitError::MergeCommit(_)), "{err:?}");
    assert_eq!(session.operation_state(), OperationState::None);
    assert_eq!(head_oid(&path), before);
}

// A base that is not an ancestor of HEAD is valid: the plan replays onto its tip.
#[test]
fn rebase_interactive_with_a_non_ancestor_base_replays_onto_its_tip() {
    if !git_available() {
        return;
    }
    let (_d, path, [a, b, c], _) = feature_fixture();
    common::run_git_ok(&path, &["branch", "elsewhere", "main"]);
    common::run_git_ok(&path, &["switch", "elsewhere"]);
    let elsewhere_tip = common::commit_file(&path, "z.txt", "z\n", "elsewhere work");
    common::run_git_ok(&path, &["switch", "feature"]);
    let session = feature_session(&path);
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
    ];

    let outcome = session.rebase_interactive("elsewhere", &steps).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert!(is_descendant(&path, elsewhere_tip));
    assert_eq!(session.operation_state(), OperationState::None);
}

// The new wire types survive a JSON round trip, so the front end and back end agree on them.
#[test]
fn rebase_commit_and_step_round_trip_through_json() {
    if !git_available() {
        return;
    }
    let (_d, path, ..) = feature_fixture();
    let plan = feature_session(&path).rebase_plan("main").unwrap();
    let json = serde_json::to_value(&plan).unwrap();
    let back: Vec<RebaseCommit> = serde_json::from_value(json).unwrap();
    assert_eq!(back, plan);

    let steps = [
        step(RebaseAction::Pick, Oid::zero()),
        step(RebaseAction::Squash, Oid::zero()),
        step(RebaseAction::Fixup, Oid::zero()),
        step(RebaseAction::Edit, Oid::zero()),
        step(RebaseAction::Drop, Oid::zero()),
    ];
    let back: Vec<RebaseStep> =
        serde_json::from_value(serde_json::to_value(steps.to_vec()).unwrap()).unwrap();
    assert_eq!(back, steps);
}

#[test]
fn stopped_outcome_and_the_edit_flag_round_trip_through_json() {
    let outcome: OperationOutcome = serde_json::from_value(json!("stopped")).unwrap();
    assert_eq!(outcome, OperationOutcome::Stopped);
    let state = OperationState::Rebase {
        onto: "a".repeat(40),
        onto_name: None,
        branch: Some("feature".into()),
        step: 2,
        total: 3,
        stopped_for_edit: true,
    };
    let back: OperationState =
        serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
    assert_eq!(back, state);
}
