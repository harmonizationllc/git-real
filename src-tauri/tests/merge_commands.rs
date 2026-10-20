//! Integration tests for the merge command `*_inner` functions (GR-10a).

mod common;

use std::path::PathBuf;

use git_real_core::{
    ConflictSide, FastForwardCheck, MergeMode, OperationOutcome, OperationState, RebaseAction,
    RebaseCommit, RebaseStep, RepoSession, Signature,
};
use git_real_lib::commands::merge::{
    abort_operation_inner, can_fast_forward_inner, cherry_pick_inner, continue_rebase_inner,
    get_operation_state_inner, merge_branch_inner, rebase_interactive_inner, rebase_onto_inner,
    rebase_plan_inner, resolve_conflicts_inner, revert_commit_inner, write_resolution_inner,
};
use git_real_lib::commands::worktree::get_status_inner;
use git_real_lib::error::AppErrorKind;
use git_real_lib::state::{RepoId, RepoRegistry};
use git2::{Oid, Repository};
use serde_json::json;
use tempfile::TempDir;

const MISSING_ID: RepoId = 4242;

fn register(path: &std::path::Path) -> (RepoRegistry, RepoId) {
    common::configure_identity(path);
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(path).expect("open"));
    (reg, id)
}

/// `other` and the base branch both edited README.md; nothing merged yet.
fn diverged() -> (TempDir, PathBuf, RepoRegistry, RepoId) {
    let (dir, path) = common::diverged_fixture();
    let (reg, id) = register(&path);
    (dir, path, reg, id)
}

/// `fast` is one commit ahead of the base branch.
fn ahead() -> (TempDir, PathBuf, RepoRegistry, RepoId, Oid) {
    let (dir, path, tip) = common::ahead_fixture();
    let (reg, id) = register(&path);
    (dir, path, reg, id, tip)
}

fn head_oid(path: &std::path::Path) -> Oid {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
}

fn branch_tip(path: &std::path::Path, name: &str) -> Oid {
    Repository::open(path)
        .unwrap()
        .find_branch(name, git2::BranchType::Local)
        .unwrap()
        .get()
        .target()
        .unwrap()
}

// --- get_operation_state_inner ---

#[test]
fn get_operation_state_inner_is_none_on_a_clean_repo() {
    let (_d, _p, reg, id) = diverged();

    let state = get_operation_state_inner(&reg, id).unwrap();

    assert_eq!(state, OperationState::None);
}

#[test]
fn get_operation_state_inner_is_merge_after_a_conflicting_merge() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = diverged();
    merge_branch_inner(&reg, id, "other", MergeMode::Merge).unwrap();

    let state = get_operation_state_inner(&reg, id).unwrap();

    assert!(matches!(state, OperationState::Merge { .. }), "{state:?}");
}

// --- merge_branch_inner ---

#[test]
fn merge_branch_inner_fast_forwards_to_the_branch_tip() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, tip) = ahead();

    let outcome = merge_branch_inner(&reg, id, "fast", MergeMode::FastForward).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(head_oid(&path), tip);
}

#[test]
fn merge_branch_inner_reports_conflicts_as_an_outcome() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = diverged();

    let outcome = merge_branch_inner(&reg, id, "other", MergeMode::Merge).unwrap();

    assert_eq!(outcome, OperationOutcome::Conflicts);
}

#[test]
fn merge_branch_inner_maps_an_unknown_branch_to_branch_not_found() {
    let (_d, _p, reg, id) = diverged();

    let err = merge_branch_inner(&reg, id, "nope", MergeMode::Merge).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::BranchNotFound);
}

#[test]
fn merge_branch_inner_maps_a_second_operation_to_operation_in_progress() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = diverged();
    merge_branch_inner(&reg, id, "other", MergeMode::Merge).unwrap();

    let err = merge_branch_inner(&reg, id, "other", MergeMode::Merge).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::OperationInProgress);
}

#[test]
fn merge_branch_inner_maps_a_refused_fast_forward_to_operation_failed() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = diverged();

    let err = merge_branch_inner(&reg, id, "other", MergeMode::FastForward).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::OperationFailed);
    assert!(err.message.contains("fast-forward"), "{}", err.message);
}

// --- rebase_onto_inner, continue_rebase_inner, resolve_conflicts_inner ---

#[test]
fn rebase_onto_inner_reports_conflicts() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = diverged();

    let outcome = rebase_onto_inner(&reg, id, "other").unwrap();

    assert_eq!(outcome, OperationOutcome::Conflicts);
}

#[test]
fn continue_rebase_inner_with_conflicts_left_is_unresolved_conflicts() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = diverged();
    rebase_onto_inner(&reg, id, "other").unwrap();

    let err = continue_rebase_inner(&reg, id).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::UnresolvedConflicts);
}

#[test]
fn continue_rebase_inner_completes_after_resolve_conflicts_inner() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = diverged();
    rebase_onto_inner(&reg, id, "other").unwrap();
    resolve_conflicts_inner(&reg, id, &["README.md".to_string()], ConflictSide::Theirs).unwrap();

    let outcome = continue_rebase_inner(&reg, id).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
}

#[test]
fn continue_rebase_inner_when_clean_is_no_operation() {
    let (_d, _p, reg, id) = diverged();

    let err = continue_rebase_inner(&reg, id).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::NoOperation);
}

#[test]
fn resolve_conflicts_inner_maps_an_unconflicted_path_to_path_not_found() {
    let (_d, _p, reg, id) = diverged();

    let err = resolve_conflicts_inner(&reg, id, &["README.md".to_string()], ConflictSide::Ours)
        .unwrap_err();

    assert_eq!(err.kind, AppErrorKind::PathNotFound);
}

// --- cherry_pick_inner and revert_commit_inner ---

#[test]
fn cherry_pick_inner_applies_the_commit() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, tip) = ahead();

    let outcome = cherry_pick_inner(&reg, id, &tip.to_string()).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(
        std::fs::read_to_string(path.join("fast.txt")).unwrap(),
        "fast\n"
    );
}

#[test]
fn cherry_pick_inner_maps_a_bad_oid_to_commit_not_found() {
    let (_d, _p, reg, id) = diverged();

    let err = cherry_pick_inner(&reg, id, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap_err();

    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

#[test]
fn revert_commit_inner_adds_an_inverse_commit() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, tip) = ahead();
    cherry_pick_inner(&reg, id, &tip.to_string()).unwrap();
    let picked = head_oid(&path);

    let outcome = revert_commit_inner(&reg, id, &picked.to_string()).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert!(!path.join("fast.txt").exists());
}

#[test]
fn revert_commit_inner_maps_a_bad_oid_to_commit_not_found() {
    let (_d, _p, reg, id) = diverged();

    let err =
        revert_commit_inner(&reg, id, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap_err();

    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

// --- abort_operation_inner ---

#[test]
fn abort_operation_inner_on_a_clean_repo_is_no_operation() {
    let (_d, _p, reg, id) = diverged();

    let err = abort_operation_inner(&reg, id).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::NoOperation);
}

#[test]
fn abort_operation_inner_returns_head_to_where_it_was() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = diverged();
    let before = head_oid(&path);
    merge_branch_inner(&reg, id, "other", MergeMode::Merge).unwrap();

    abort_operation_inner(&reg, id).unwrap();

    assert_eq!(head_oid(&path), before);
    assert_eq!(
        get_operation_state_inner(&reg, id).unwrap(),
        OperationState::None
    );
}

// --- can_fast_forward_inner ---

#[test]
fn can_fast_forward_inner_is_possible_when_the_branch_is_ahead() {
    let (_d, _p, reg, id, _tip) = ahead();

    let check = can_fast_forward_inner(&reg, id, "fast").unwrap();

    assert_eq!(check, FastForwardCheck::Possible);
}

#[test]
fn can_fast_forward_inner_is_diverged_for_diverged_branches() {
    let (_d, _p, reg, id) = diverged();

    let check = can_fast_forward_inner(&reg, id, "other").unwrap();

    assert_eq!(check, FastForwardCheck::Diverged);
}

#[test]
fn can_fast_forward_inner_maps_an_unknown_branch_to_branch_not_found() {
    let (_d, _p, reg, id, _tip) = ahead();

    let err = can_fast_forward_inner(&reg, id, "nope").unwrap_err();

    assert_eq!(err.kind, AppErrorKind::BranchNotFound);
}

// --- GR-10a cycle 1 coverage: error kinds per command ---

#[test]
fn rebase_onto_inner_maps_an_unknown_branch_to_branch_not_found() {
    let (_d, _p, reg, id) = diverged();

    let err = rebase_onto_inner(&reg, id, "nope").unwrap_err();

    assert_eq!(err.kind, AppErrorKind::BranchNotFound);
}

#[test]
fn rebase_onto_inner_maps_a_second_operation_to_operation_in_progress() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = diverged();
    assert_eq!(
        rebase_onto_inner(&reg, id, "other").unwrap(),
        OperationOutcome::Conflicts
    );

    let err = rebase_onto_inner(&reg, id, "other").unwrap_err();

    assert_eq!(err.kind, AppErrorKind::OperationInProgress);
}

#[test]
fn cherry_pick_inner_and_revert_commit_inner_map_an_operation_in_progress() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = diverged();
    merge_branch_inner(&reg, id, "other", MergeMode::Merge).unwrap();
    let head = head_oid(&path).to_string();

    let pick = cherry_pick_inner(&reg, id, &head).unwrap_err();
    let revert = revert_commit_inner(&reg, id, &head).unwrap_err();

    assert_eq!(pick.kind, AppErrorKind::OperationInProgress);
    assert_eq!(revert.kind, AppErrorKind::OperationInProgress);
}

#[test]
fn cherry_pick_inner_and_revert_commit_inner_map_a_merge_commit() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, _tip) = ahead();
    common::commit_file(&path, "base.txt", "base\n", "base moves on");
    let merged = std::process::Command::new("git")
        .args(["-C"])
        .arg(&path)
        .args(["merge", "--no-ff", "--no-edit", "fast"])
        .output()
        .unwrap();
    assert!(merged.status.success(), "{merged:?}");
    let merge_commit = head_oid(&path).to_string();

    let pick = cherry_pick_inner(&reg, id, &merge_commit).unwrap_err();
    let revert = revert_commit_inner(&reg, id, &merge_commit).unwrap_err();

    assert_eq!(pick.kind, AppErrorKind::MergeCommit);
    assert_eq!(revert.kind, AppErrorKind::MergeCommit);
    assert!(pick.message.contains(&merge_commit), "{}", pick.message);
}

#[test]
fn resolve_conflicts_inner_keeps_one_side_and_lets_the_state_clear() {
    let (_d, path, reg, id) = diverged();
    {
        let repo = Repository::open(&path).unwrap();
        let other = repo.find_branch("other", git2::BranchType::Local).unwrap();
        let annotated = repo.reference_to_annotated_commit(other.get()).unwrap();
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.allow_conflicts(true);
        repo.merge(&[&annotated], None, Some(&mut checkout))
            .unwrap();
    }

    resolve_conflicts_inner(&reg, id, &["README.md".to_string()], ConflictSide::Theirs).unwrap();

    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# other\n"
    );
    assert!(
        !Repository::open(&path)
            .unwrap()
            .index()
            .unwrap()
            .has_conflicts()
    );
}

#[test]
fn resolve_conflicts_inner_maps_a_path_outside_the_repo_to_path_not_found() {
    let (_d, _p, reg, id) = diverged();

    let err =
        resolve_conflicts_inner(&reg, id, &["../x".to_string()], ConflictSide::Ours).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::PathNotFound);
}

#[test]
fn can_fast_forward_inner_is_up_to_date_for_the_same_tip() {
    let (_d, path, reg, id, _tip) = ahead();
    {
        let repo = Repository::open(&path).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("same", &head, false).unwrap();
    }

    let check = can_fast_forward_inner(&reg, id, "same").unwrap();

    assert_eq!(check, FastForwardCheck::UpToDate);
}

// --- wire shape ---

#[test]
fn operation_state_none_serializes_as_a_tagged_object() {
    assert_eq!(
        serde_json::to_value(OperationState::None).unwrap(),
        json!({"kind": "none"})
    );
}

#[test]
fn a_live_merge_state_serializes_with_the_merge_tag_and_camel_case_fields() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = diverged();
    merge_branch_inner(&reg, id, "other", MergeMode::Merge).unwrap();

    let state = get_operation_state_inner(&reg, id).unwrap();

    let value = serde_json::to_value(state).unwrap();
    assert_eq!(value["kind"], "merge");
    assert_eq!(value["head"], branch_tip(&path, "other").to_string());
    assert_eq!(value["branch"], "other");
    assert!(value["message"]["subject"].is_string());
}

// --- unknown repository id ---

#[test]
fn every_merge_command_maps_an_unknown_repo_id_to_unknown_repo() {
    let reg = RepoRegistry::default();
    let kinds = [
        get_operation_state_inner(&reg, MISSING_ID)
            .unwrap_err()
            .kind,
        merge_branch_inner(&reg, MISSING_ID, "b", MergeMode::Merge)
            .unwrap_err()
            .kind,
        rebase_onto_inner(&reg, MISSING_ID, "b").unwrap_err().kind,
        cherry_pick_inner(&reg, MISSING_ID, "abc").unwrap_err().kind,
        revert_commit_inner(&reg, MISSING_ID, "abc")
            .unwrap_err()
            .kind,
        abort_operation_inner(&reg, MISSING_ID).unwrap_err().kind,
        continue_rebase_inner(&reg, MISSING_ID).unwrap_err().kind,
        resolve_conflicts_inner(&reg, MISSING_ID, &[], ConflictSide::Ours)
            .unwrap_err()
            .kind,
        can_fast_forward_inner(&reg, MISSING_ID, "b")
            .unwrap_err()
            .kind,
    ];

    assert!(
        kinds.iter().all(|k| *k == AppErrorKind::UnknownRepo),
        "{kinds:?}"
    );
}

// --- write_resolution_inner (GR-10b) ---

#[test]
fn write_resolution_inner_stages_the_text() {
    let (_d, path, reg, id) = diverged();
    {
        let repo = Repository::open(&path).unwrap();
        let other = repo.find_branch("other", git2::BranchType::Local).unwrap();
        let annotated = repo.reference_to_annotated_commit(other.get()).unwrap();
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.allow_conflicts(true);
        repo.merge(&[&annotated], None, Some(&mut checkout))
            .unwrap();
    }

    write_resolution_inner(&reg, id, "README.md", "both\n", true).unwrap();

    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "both\n"
    );
    assert!(
        !Repository::open(&path)
            .unwrap()
            .index()
            .unwrap()
            .has_conflicts()
    );
    let status = get_status_inner(&reg, id).unwrap();
    assert!(status.entries.iter().all(|e| !e.conflicted));
}

#[test]
fn write_resolution_inner_maps_path_not_found() {
    let (_d, _p, reg, id) = diverged();

    let err = write_resolution_inner(&reg, id, "README.md", "x\n", true).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::PathNotFound);
}

// --- GR-10c: interactive rebase ---

fn git(path: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// `main` with README, then `feature` with commits a, b, c; HEAD on `feature`.
fn feature() -> (TempDir, PathBuf, RepoRegistry, RepoId, [Oid; 3]) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    git(&path, &["branch", "-M", "main"]);
    git(&path, &["switch", "-c", "feature"]);
    let a = common::commit_file(&path, "a.txt", "a\n", "add a");
    let b = common::commit_file(&path, "b.txt", "b\n", "add b");
    let c = common::commit_file(&path, "c.txt", "c\n", "add c");
    let (reg, id) = register(&path);
    (dir, path, reg, id, [a, b, c])
}

fn step(action: RebaseAction, oid: Oid) -> RebaseStep {
    RebaseStep {
        action,
        oid: oid.to_string(),
    }
}

#[test]
fn rebase_plan_inner_lists_commits_oldest_first() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id, [a, b, c]) = feature();

    let plan = rebase_plan_inner(&reg, id, "main").unwrap();

    let oids: Vec<_> = plan.iter().map(|c| c.oid.clone()).collect();
    assert_eq!(oids, [a.to_string(), b.to_string(), c.to_string()]);
}

#[test]
fn rebase_plan_inner_returns_subject_and_author() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id, _) = feature();

    let plan = rebase_plan_inner(&reg, id, "main").unwrap();

    assert_eq!(plan[0].subject, "add a");
    assert_eq!(plan[0].author.email, "test@example.com");
}

#[test]
fn rebase_plan_inner_returns_an_empty_plan_for_a_base_equal_to_head() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, _) = feature();

    let plan = rebase_plan_inner(&reg, id, &head_oid(&path).to_string()).unwrap();

    assert!(plan.is_empty(), "{plan:?}");
}

#[test]
fn rebase_plan_inner_maps_an_unknown_branch_to_branch_not_found() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id, _) = feature();

    let err = rebase_plan_inner(&reg, id, "nope").unwrap_err();

    assert_eq!(err.kind, AppErrorKind::BranchNotFound);
}

#[test]
fn rebase_plan_inner_maps_an_unknown_oid_to_commit_not_found() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id, _) = feature();

    let err = rebase_plan_inner(&reg, id, &"f".repeat(40)).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

#[test]
fn rebase_plan_inner_maps_a_running_operation_to_operation_in_progress() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = diverged();
    rebase_onto_inner(&reg, id, "other").unwrap();

    let err = rebase_plan_inner(&reg, id, "other").unwrap_err();

    assert_eq!(err.kind, AppErrorKind::OperationInProgress);
}

#[test]
fn rebase_plan_inner_maps_a_merge_commit_in_range_to_merge_commit() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, _) = feature();
    git(&path, &["switch", "-q", "-c", "side", "main"]);
    common::commit_file(&path, "side.txt", "s\n", "side work");
    git(&path, &["switch", "-q", "feature"]);
    git(&path, &["merge", "--no-ff", "-m", "merge side", "side"]);

    let err = rebase_plan_inner(&reg, id, "main").unwrap_err();

    assert_eq!(err.kind, AppErrorKind::MergeCommit);
}

#[test]
fn rebase_interactive_inner_completes_a_drop() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, [a, b, c]) = feature();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Drop, b),
        step(RebaseAction::Pick, c),
    ];

    let outcome = rebase_interactive_inner(&reg, id, "main", &steps).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    assert_eq!(
        get_operation_state_inner(&reg, id).unwrap(),
        OperationState::None
    );
    assert!(!path.join("b.txt").exists());
}

#[test]
fn rebase_interactive_inner_replays_onto_a_diverged_branch() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, [a, b, c]) = feature();
    git(&path, &["switch", "-q", "-c", "side", "main"]);
    let side_tip = common::commit_file(&path, "side.txt", "s\n", "side work");
    git(&path, &["switch", "-q", "feature"]);
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
    ];

    let outcome = rebase_interactive_inner(&reg, id, "side", &steps).unwrap();

    assert_eq!(outcome, OperationOutcome::Completed);
    let repo = Repository::open(&path).unwrap();
    let head = repo.head().unwrap().target().unwrap();
    assert!(repo.graph_descendant_of(head, side_tip).unwrap());
}

#[test]
fn rebase_interactive_inner_reports_stopped_with_the_edit_flag() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id, [a, b, c]) = feature();
    let steps = [
        step(RebaseAction::Pick, a),
        step(RebaseAction::Edit, b),
        step(RebaseAction::Pick, c),
    ];

    let outcome = rebase_interactive_inner(&reg, id, "main", &steps).unwrap();

    assert_eq!(outcome, OperationOutcome::Stopped);
    let state = get_operation_state_inner(&reg, id).unwrap();
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

#[test]
fn rebase_interactive_inner_maps_a_leading_squash_to_bad_selection() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id, [a, b, c]) = feature();
    let steps = [
        step(RebaseAction::Squash, a),
        step(RebaseAction::Pick, b),
        step(RebaseAction::Pick, c),
    ];

    let err = rebase_interactive_inner(&reg, id, "main", &steps).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::BadSelection);
}

#[test]
fn rebase_interactive_inner_maps_an_unknown_branch_to_branch_not_found() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id, [a, ..]) = feature();

    let err =
        rebase_interactive_inner(&reg, id, "nope", &[step(RebaseAction::Pick, a)]).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::BranchNotFound);
}

#[test]
fn rebase_interactive_inner_maps_a_running_operation_to_operation_in_progress() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = diverged();
    rebase_onto_inner(&reg, id, "other").unwrap();

    let err = rebase_interactive_inner(&reg, id, "other", &[]).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::OperationInProgress);
}

#[test]
fn rebase_commands_map_an_unknown_repo_id_to_unknown_repo() {
    let reg = RepoRegistry::default();

    let plan = rebase_plan_inner(&reg, MISSING_ID, "main")
        .unwrap_err()
        .kind;
    let run = rebase_interactive_inner(&reg, MISSING_ID, "main", &[])
        .unwrap_err()
        .kind;

    assert_eq!(
        (plan, run),
        (AppErrorKind::UnknownRepo, AppErrorKind::UnknownRepo)
    );
}

#[test]
fn rebase_commit_serialises_camel_case() {
    let json = serde_json::to_value(RebaseCommit {
        oid: "a".into(),
        subject: "s".into(),
        author: Signature {
            name: "n".into(),
            email: "e".into(),
            time: 1,
        },
    })
    .unwrap();

    assert_eq!(
        json,
        json!({ "oid": "a", "subject": "s", "author": { "name": "n", "email": "e", "time": 1 } })
    );
}

#[test]
fn rebase_step_deserialises_a_camel_case_action() {
    let step: RebaseStep =
        serde_json::from_value(json!({ "action": "fixup", "oid": "a" })).unwrap();

    assert_eq!((step.action, step.oid.as_str()), (RebaseAction::Fixup, "a"));
}

#[test]
fn rebase_step_rejects_an_unknown_action() {
    let result = serde_json::from_value::<RebaseStep>(json!({ "action": "reword", "oid": "a" }));

    assert!(result.is_err());
}

#[test]
fn rebase_step_rejects_a_missing_oid() {
    let result = serde_json::from_value::<RebaseStep>(json!({ "action": "pick" }));

    assert!(result.is_err());
}

#[test]
fn every_rebase_action_serialises_to_its_lowercase_keyword() {
    let all = [
        RebaseAction::Pick,
        RebaseAction::Squash,
        RebaseAction::Fixup,
        RebaseAction::Edit,
        RebaseAction::Drop,
    ];

    let names: Vec<_> = all
        .iter()
        .map(|a| serde_json::to_value(a).unwrap())
        .collect();

    assert_eq!(
        names,
        [
            json!("pick"),
            json!("squash"),
            json!("fixup"),
            json!("edit"),
            json!("drop")
        ]
    );
}

#[test]
fn operation_outcome_stopped_serialises_as_stopped() {
    assert_eq!(
        serde_json::to_value(OperationOutcome::Stopped).unwrap(),
        json!("stopped")
    );
}

#[test]
fn rebase_state_serialises_stopped_for_edit() {
    let value = serde_json::to_value(OperationState::Rebase {
        onto: "abc".into(),
        onto_name: None,
        branch: Some("feature".into()),
        step: 2,
        total: 3,
        stopped_for_edit: true,
    })
    .unwrap();

    assert_eq!(value["stoppedForEdit"], json!(true));
}
