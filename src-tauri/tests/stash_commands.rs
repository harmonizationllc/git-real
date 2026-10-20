//! Integration tests for the stash command `*_inner` functions (GR-11a).

mod common;

use git_real_core::{RepoSession, StashEntry, StashFiles, StashOutcome};
use git_real_lib::commands::stash::{
    get_stash_files_inner, list_stashes_inner, stash_apply_inner, stash_drop_inner,
    stash_pop_inner, stash_push_inner,
};
use git_real_lib::error::AppErrorKind;
use git_real_lib::state::{RepoId, RepoRegistry};
use serde_json::json;

const MISSING_ID: RepoId = 4242;

fn setup() -> (tempfile::TempDir, std::path::PathBuf, RepoRegistry, RepoId) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).unwrap());
    (dir, path, reg, id)
}

/// Dirties README.md and pushes it as a stash through the command layer.
fn push_one(path: &std::path::Path, reg: &RepoRegistry, id: RepoId) -> StashEntry {
    common::write_file(path, "README.md", "x\n");
    stash_push_inner(reg, id, Some("wip"), false).unwrap();
    list_stashes_inner(reg, id).unwrap().remove(0)
}

#[test]
fn list_stashes_inner_is_empty_for_a_fresh_repo() {
    let (_d, _p, reg, id) = setup();
    assert_eq!(list_stashes_inner(&reg, id).unwrap(), vec![]);
}

#[test]
fn stash_push_inner_then_list_and_files() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = setup();
    common::write_file(&path, "README.md", "x\n");
    common::write_file(&path, "new.txt", "n\n");
    stash_push_inner(&reg, id, Some("wip"), true).unwrap();
    let list = list_stashes_inner(&reg, id).unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].message.ends_with(": wip"), "{}", list[0].message);
    assert!(list[0].has_untracked);
    let files = get_stash_files_inner(&reg, id, &list[0].oid).unwrap();
    assert_eq!(
        files
            .tracked
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["README.md"]
    );
    assert_eq!(
        files
            .untracked
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["new.txt"]
    );
}

#[test]
fn stash_push_inner_maps_nothing_to_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = setup();
    let err = stash_push_inner(&reg, id, None, false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NothingToStash);
}

#[test]
fn stash_apply_and_pop_inner_report_applied() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = setup();
    let entry = push_one(&path, &reg, id);
    assert_eq!(
        stash_apply_inner(&reg, id, entry.index, &entry.oid).unwrap(),
        StashOutcome::Applied
    );
    assert_eq!(list_stashes_inner(&reg, id).unwrap().len(), 1);
    // Reset the working tree so the pop applies cleanly.
    let repo = git2::Repository::open(&path).unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    assert_eq!(
        stash_pop_inner(&reg, id, entry.index, &entry.oid).unwrap(),
        StashOutcome::Applied
    );
    assert!(list_stashes_inner(&reg, id).unwrap().is_empty());
}

#[test]
fn stash_drop_inner_removes_the_entry() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = setup();
    let entry = push_one(&path, &reg, id);
    stash_drop_inner(&reg, id, entry.index, &entry.oid).unwrap();
    assert!(list_stashes_inner(&reg, id).unwrap().is_empty());
}

#[test]
fn stash_drop_inner_maps_stale_stash() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = setup();
    push_one(&path, &reg, id);
    let err = stash_drop_inner(&reg, id, 0, &"a".repeat(40)).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::StaleStash);
}

#[test]
fn get_stash_files_inner_maps_revision_not_found() {
    let (_d, path, reg, id) = setup();
    let head = git2::Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
        .to_string();
    let err = get_stash_files_inner(&reg, id, &head).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::RevisionNotFound);
}

#[test]
fn stash_commands_report_unknown_repo() {
    let reg = RepoRegistry::default();
    let oid = "a".repeat(40);
    assert_eq!(
        list_stashes_inner(&reg, MISSING_ID).unwrap_err().kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        get_stash_files_inner(&reg, MISSING_ID, &oid)
            .unwrap_err()
            .kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        stash_push_inner(&reg, MISSING_ID, None, false)
            .unwrap_err()
            .kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        stash_apply_inner(&reg, MISSING_ID, 0, &oid)
            .unwrap_err()
            .kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        stash_pop_inner(&reg, MISSING_ID, 0, &oid).unwrap_err().kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        stash_drop_inner(&reg, MISSING_ID, 0, &oid)
            .unwrap_err()
            .kind,
        AppErrorKind::UnknownRepo
    );
}

#[test]
fn stash_models_serialise_camel_case() {
    let entry = StashEntry {
        index: 2,
        oid: "w".into(),
        message: "On main: m".into(),
        branch: Some("main".into()),
        time: 7,
        base: "b".into(),
        has_untracked: true,
    };
    assert_eq!(
        serde_json::to_value(entry).unwrap(),
        json!({ "index": 2, "oid": "w", "message": "On main: m", "branch": "main", "time": 7, "base": "b", "hasUntracked": true })
    );
    let files = StashFiles {
        tracked: vec![],
        untracked: vec![],
        untracked_oid: None,
    };
    assert_eq!(
        serde_json::to_value(files).unwrap(),
        json!({ "tracked": [], "untracked": [], "untrackedOid": null })
    );
    assert_eq!(
        serde_json::to_value(StashOutcome::Conflicts).unwrap(),
        json!("conflicts")
    );
    assert_eq!(
        serde_json::to_value(StashOutcome::Applied).unwrap(),
        json!("applied")
    );
}
