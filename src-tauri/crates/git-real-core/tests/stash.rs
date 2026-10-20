//! Stash list, files, push, apply, pop and drop (GR-11a), against real temp
//! repositories and the system git CLI.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{ChangeKind, GitError, OperationState, RepoSession, StashEntry, StashOutcome};
use git2::Repository;
use tempfile::TempDir;

/// A repo with README.md committed, an identity, and an open session.
fn repo() -> (TempDir, PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session)
}

fn read(path: &Path, rel: &str) -> String {
    std::fs::read_to_string(path.join(rel)).unwrap()
}

fn stash_tip(path: &Path) -> Option<git2::Oid> {
    Repository::open(path)
        .unwrap()
        .refname_to_id("refs/stash")
        .ok()
}

fn is_clean(path: &Path) -> bool {
    common::run_git_ok(path, &["status", "--porcelain"])
        .stdout
        .is_empty()
}

/// Edits README.md and stashes it with `git stash push -m <msg>`; returns the new entry 0.
fn stash_readme(path: &Path, session: &RepoSession, content: &str, msg: &str) -> StashEntry {
    common::write_file(path, "README.md", content);
    common::run_git_ok(path, &["stash", "push", "-m", msg]);
    session.list_stashes().unwrap().remove(0)
}

/// Stash README "stashed\n", then commit README "committed\n": applying the stash conflicts.
fn conflicting_stash(path: &Path, session: &RepoSession) -> StashEntry {
    let entry = stash_readme(path, session, "stashed\n", "wip");
    common::commit_file(path, "README.md", "committed\n", "change readme");
    entry
}

// ---------- list ----------

#[test]
fn list_stashes_is_empty_without_a_stash_ref() {
    let (_d, _p, session) = repo();
    assert_eq!(session.list_stashes().unwrap(), vec![]);
}

#[test]
fn list_stashes_lists_newest_first_with_indexes_oids_and_time() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let first = stash_readme(&path, &session, "one\n", "first");
    let second = stash_readme(&path, &session, "two\n", "second");
    let list = session.list_stashes().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(
        (list[0].index, list[0].oid.as_str()),
        (0, second.oid.as_str())
    );
    assert_eq!(
        (list[1].index, list[1].oid.as_str()),
        (1, first.oid.as_str())
    );
    let rev = common::run_git_ok(&path, &["rev-parse", "stash@{1}"]);
    assert_eq!(String::from_utf8_lossy(&rev.stdout).trim(), list[1].oid);
    assert!(list[0].time > 1_600_000_000);
}

#[test]
fn list_stashes_parses_message_and_branch() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let head = common::head_branch_name(&path);
    let named = stash_readme(&path, &session, "x\n", "wip");
    assert_eq!(named.message, format!("On {head}: wip"));
    assert_eq!(named.branch.as_deref(), Some(head.as_str()));
    common::write_file(&path, "README.md", "y\n");
    common::run_git_ok(&path, &["stash", "push"]);
    let wip = session.list_stashes().unwrap().remove(0);
    assert!(
        wip.message.starts_with(&format!("WIP on {head}: ")),
        "{}",
        wip.message
    );
    assert_eq!(wip.branch.as_deref(), Some(head.as_str()));
}

#[test]
fn list_stashes_detached_entry_has_no_branch() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    common::run_git_ok(&path, &["checkout", "--detach"]);
    common::write_file(&path, "README.md", "x\n");
    common::run_git_ok(&path, &["stash", "push"]);
    let entry = session.list_stashes().unwrap().remove(0);
    assert!(
        entry.message.starts_with("WIP on (no branch): "),
        "{}",
        entry.message
    );
    assert_eq!(entry.branch, None);
}

#[test]
fn list_stashes_unparseable_message_has_no_branch() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    common::write_file(&path, "README.md", "x\n");
    let created = common::run_git_ok(&path, &["stash", "create"]);
    let oid = String::from_utf8_lossy(&created.stdout).trim().to_owned();
    common::run_git_ok(&path, &["stash", "store", "-m", "custom note", &oid]);
    let entry = session.list_stashes().unwrap().remove(0);
    assert_eq!(
        (entry.message.as_str(), entry.branch.clone()),
        ("custom note", None)
    );
}

#[test]
fn list_stashes_sets_untracked_flag_and_base() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let head = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    common::write_file(&path, "new.txt", "n\n");
    common::run_git_ok(&path, &["stash", "push", "--include-untracked"]);
    let with_u = session.list_stashes().unwrap().remove(0);
    assert!(with_u.has_untracked);
    assert_eq!(with_u.base, head.to_string());
    let plain = stash_readme(&path, &session, "x\n", "plain");
    assert!(!plain.has_untracked);
}

// ---------- files ----------

#[test]
fn stash_files_splits_tracked_and_untracked() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    common::write_file(&path, "README.md", "changed\n");
    common::write_file(&path, "new.txt", "n\n");
    common::run_git_ok(&path, &["stash", "push", "--include-untracked"]);
    let entry = session.list_stashes().unwrap().remove(0);
    let files = session.stash_files(&entry.oid).unwrap();
    assert_eq!(
        files
            .tracked
            .iter()
            .map(|f| (f.path.as_str(), f.change))
            .collect::<Vec<_>>(),
        [("README.md", ChangeKind::Modified)]
    );
    assert_eq!(
        files
            .untracked
            .iter()
            .map(|f| (f.path.as_str(), f.change))
            .collect::<Vec<_>>(),
        [("new.txt", ChangeKind::Added)]
    );
    let u = common::run_git_ok(&path, &["rev-parse", "stash@{0}^3"]);
    assert_eq!(
        files.untracked_oid.as_deref(),
        Some(String::from_utf8_lossy(&u.stdout).trim())
    );
}

#[test]
fn stash_files_without_untracked_has_no_untracked_oid() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let entry = stash_readme(&path, &session, "x\n", "plain");
    let files = session.stash_files(&entry.oid).unwrap();
    assert_eq!(files.tracked.len(), 1);
    assert!(files.untracked.is_empty());
    assert_eq!(files.untracked_oid, None);
}

#[test]
fn stash_files_reports_a_rename_and_a_delete() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    common::commit_file(&path, "gone.txt", "g\n", "add gone");
    common::run_git_ok(&path, &["mv", "README.md", "READ.md"]);
    common::run_git_ok(&path, &["rm", "-q", "gone.txt"]);
    common::run_git_ok(&path, &["stash", "push"]);
    let entry = session.list_stashes().unwrap().remove(0);
    let files = session.stash_files(&entry.oid).unwrap();
    let renamed = files.tracked.iter().find(|f| f.path == "READ.md").unwrap();
    assert_eq!(
        (renamed.change, renamed.old_path.as_deref()),
        (ChangeKind::Renamed, Some("README.md"))
    );
    assert!(
        files
            .tracked
            .iter()
            .any(|f| f.path == "gone.txt" && f.change == ChangeKind::Deleted)
    );
}

#[test]
fn stash_files_non_stash_commit_is_revision_not_found() {
    let (_d, path, session) = repo();
    let head = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
        .to_string();
    assert!(matches!(session.stash_files(&head), Err(GitError::RevisionNotFound(o)) if o == head));
}

#[test]
fn stash_files_unknown_oid_is_revision_not_found() {
    let (_d, _p, session) = repo();
    assert!(matches!(
        session.stash_files(&"f".repeat(40)),
        Err(GitError::RevisionNotFound(_))
    ));
}

// ---------- push ----------

#[test]
fn stash_push_with_message_records_it_and_cleans_the_tree() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let head = common::head_branch_name(&path);
    common::write_file(&path, "README.md", "x\n");
    session.stash_push(Some("my work"), false).unwrap();
    assert!(is_clean(&path));
    assert_eq!(
        session.list_stashes().unwrap()[0].message,
        format!("On {head}: my work")
    );
}

#[test]
fn stash_push_without_message_uses_the_wip_message() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    common::write_file(&path, "README.md", "x\n");
    session.stash_push(None, false).unwrap();
    assert!(
        session.list_stashes().unwrap()[0]
            .message
            .starts_with("WIP on ")
    );
}

#[test]
fn stash_push_blank_message_is_treated_as_none() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    common::write_file(&path, "README.md", "x\n");
    session.stash_push(Some("   "), false).unwrap();
    assert!(
        session.list_stashes().unwrap()[0]
            .message
            .starts_with("WIP on ")
    );
}

#[test]
fn stash_push_include_untracked_stashes_untracked_files() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    common::write_file(&path, "new.txt", "n\n");
    session.stash_push(None, true).unwrap();
    assert!(!path.join("new.txt").exists());
    assert!(session.list_stashes().unwrap()[0].has_untracked);
}

#[test]
fn stash_push_untracked_only_without_flag_is_nothing_to_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    common::write_file(&path, "new.txt", "n\n");
    assert!(matches!(
        session.stash_push(None, false),
        Err(GitError::NothingToStash)
    ));
    assert!(path.join("new.txt").exists());
    assert_eq!(stash_tip(&path), None);
}

#[test]
fn stash_push_clean_tree_is_nothing_to_stash_even_with_existing_stashes() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    stash_readme(&path, &session, "x\n", "one");
    let before = stash_tip(&path);
    assert!(matches!(
        session.stash_push(Some("again"), true),
        Err(GitError::NothingToStash)
    ));
    assert_eq!(stash_tip(&path), before);
}

#[test]
fn stash_push_mid_merge_is_operation_in_progress() {
    let (_d, path) = common::temp_repo_with_conflict();
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(
        session.stash_push(None, false),
        Err(GitError::OperationInProgress)
    ));
}

#[test]
fn stash_push_with_index_conflicts_is_unresolved_conflicts() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let entry = conflicting_stash(&path, &session);
    assert_eq!(
        session.stash_apply(entry.index, &entry.oid).unwrap(),
        StashOutcome::Conflicts
    );
    assert!(matches!(
        session.stash_push(None, false),
        Err(GitError::UnresolvedConflicts)
    ));
}

#[test]
fn stash_push_on_unborn_is_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    common::write_file(&path, "a.txt", "a\n");
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(
        session.stash_push(None, true),
        Err(GitError::UnbornHead)
    ));
}

#[test]
fn stash_push_git_failure_is_operation_failed_with_stderr() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    common::write_file(&path, "README.md", "x\n");
    std::fs::write(path.join(".git/index.lock"), "").unwrap();
    match session.stash_push(None, false) {
        Err(GitError::OperationFailed { verb, stderr, .. }) => {
            assert_eq!(verb, "stash");
            assert!(stderr.contains("index.lock"), "{stderr}");
        }
        other => panic!("{other:?}"),
    }
}

// ---------- apply / pop ----------

#[test]
fn stash_apply_clean_restores_changes_and_keeps_the_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let entry = stash_readme(&path, &session, "stashed\n", "wip");
    assert_eq!(
        session.stash_apply(entry.index, &entry.oid).unwrap(),
        StashOutcome::Applied
    );
    assert_eq!(read(&path, "README.md"), "stashed\n");
    assert_eq!(session.list_stashes().unwrap().len(), 1);
}

#[test]
fn stash_apply_conflict_reports_conflicts_and_keeps_the_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let entry = conflicting_stash(&path, &session);
    assert_eq!(
        session.stash_apply(entry.index, &entry.oid).unwrap(),
        StashOutcome::Conflicts
    );
    assert!(
        Repository::open(&path)
            .unwrap()
            .index()
            .unwrap()
            .has_conflicts()
    );
    assert_eq!(session.operation_state(), OperationState::None);
    assert_eq!(session.list_stashes().unwrap().len(), 1);
}

#[test]
fn stash_pop_clean_removes_the_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let entry = stash_readme(&path, &session, "stashed\n", "wip");
    assert_eq!(
        session.stash_pop(entry.index, &entry.oid).unwrap(),
        StashOutcome::Applied
    );
    assert_eq!(read(&path, "README.md"), "stashed\n");
    assert!(session.list_stashes().unwrap().is_empty());
}

#[test]
fn stash_pop_conflict_keeps_the_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let entry = conflicting_stash(&path, &session);
    assert_eq!(
        session.stash_pop(entry.index, &entry.oid).unwrap(),
        StashOutcome::Conflicts
    );
    assert_eq!(session.list_stashes().unwrap()[0].oid, entry.oid);
}

#[test]
fn stash_apply_refused_by_dirty_overlap_is_operation_failed() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let entry = stash_readme(&path, &session, "stashed\n", "wip");
    common::write_file(&path, "README.md", "local\n");
    match session.stash_apply(entry.index, &entry.oid) {
        Err(GitError::OperationFailed { verb, stderr, .. }) => {
            assert_eq!(verb, "stash");
            assert!(stderr.contains("would be overwritten"), "{stderr}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(read(&path, "README.md"), "local\n");
    assert!(
        !Repository::open(&path)
            .unwrap()
            .index()
            .unwrap()
            .has_conflicts()
    );
}

#[test]
fn stash_apply_with_existing_index_conflicts_is_unresolved_conflicts() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let entry = conflicting_stash(&path, &session);
    session.stash_apply(entry.index, &entry.oid).unwrap();
    assert!(matches!(
        session.stash_apply(entry.index, &entry.oid),
        Err(GitError::UnresolvedConflicts)
    ));
    assert!(matches!(
        session.stash_pop(entry.index, &entry.oid),
        Err(GitError::UnresolvedConflicts)
    ));
    assert_eq!(session.list_stashes().unwrap().len(), 1);
}

#[test]
fn stash_apply_during_merge_is_operation_in_progress() {
    if !common::git_available() {
        return;
    }
    let (_d, path) = common::diverged_fixture();
    common::configure_identity(&path);
    common::write_file(&path, "side.txt", "s\n");
    common::run_git_ok(&path, &["stash", "push", "--include-untracked"]);
    common::run_git(&path, &["merge", "other"]); // conflicts on README.md
    let session = RepoSession::open(&path).unwrap();
    let entry = session.list_stashes().unwrap().remove(0);
    assert!(matches!(
        session.stash_apply(entry.index, &entry.oid),
        Err(GitError::OperationInProgress)
    ));
    assert!(matches!(
        session.stash_pop(entry.index, &entry.oid),
        Err(GitError::OperationInProgress)
    ));
}

#[test]
fn stash_apply_checks_the_guard_before_the_operation_state() {
    if !common::git_available() {
        return;
    }
    let (_d, path) = common::diverged_fixture();
    common::configure_identity(&path);
    common::write_file(&path, "side.txt", "s\n");
    common::run_git_ok(&path, &["stash", "push", "--include-untracked"]);
    common::run_git(&path, &["merge", "other"]);
    let session = RepoSession::open(&path).unwrap();
    let entry = session.list_stashes().unwrap().remove(0);
    assert!(matches!(
        session.stash_apply(1, &entry.oid),
        Err(GitError::StaleStash)
    ));
}

#[test]
fn stash_apply_wrong_oid_for_the_index_is_stale_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    stash_readme(&path, &session, "x\n", "wip");
    assert!(matches!(
        session.stash_apply(0, &"a".repeat(40)),
        Err(GitError::StaleStash)
    ));
}

#[test]
fn stash_pop_out_of_range_index_is_stale_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let entry = stash_readme(&path, &session, "x\n", "wip");
    assert!(matches!(
        session.stash_pop(5, &entry.oid),
        Err(GitError::StaleStash)
    ));
    assert_eq!(session.list_stashes().unwrap().len(), 1);
}

// ---------- drop ----------

#[test]
fn stash_drop_removes_only_the_named_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let older = stash_readme(&path, &session, "one\n", "older");
    let newer = stash_readme(&path, &session, "two\n", "newer");
    session.stash_drop(1, &older.oid).unwrap();
    let list = session.list_stashes().unwrap();
    assert_eq!(
        list.iter().map(|e| e.oid.as_str()).collect::<Vec<_>>(),
        [newer.oid.as_str()]
    );
}

#[test]
fn stash_drop_with_a_shifted_index_is_stale_and_drops_nothing() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let noted = stash_readme(&path, &session, "one\n", "noted");
    // A stash made elsewhere shifts `noted` to stash@{1}.
    common::write_file(&path, "README.md", "two\n");
    common::run_git_ok(&path, &["stash", "push", "-m", "terminal"]);
    assert!(matches!(
        session.stash_drop(noted.index, &noted.oid),
        Err(GitError::StaleStash)
    ));
    assert_eq!(session.list_stashes().unwrap().len(), 2);
}

#[test]
fn stash_drop_stale_after_a_pop_elsewhere() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let entry = stash_readme(&path, &session, "x\n", "wip");
    common::run_git_ok(&path, &["stash", "drop"]);
    assert!(matches!(
        session.stash_drop(entry.index, &entry.oid),
        Err(GitError::StaleStash)
    ));
}
