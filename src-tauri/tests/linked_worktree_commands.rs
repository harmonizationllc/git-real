//! Integration tests for the linked worktree command `*_inner` functions (GR-39).

mod common;

use std::path::PathBuf;

use git_real_core::{PrunedWorktrees, RepoSession, WorktreeBranch};
use git_real_lib::commands::linked_worktrees::{
    add_linked_worktree_inner, list_linked_worktrees_inner, prune_linked_worktrees_inner,
    remove_linked_worktree_inner,
};
use git_real_lib::error::AppErrorKind;
use git_real_lib::state::{RepoId, RepoRegistry};
use serde_json::json;

const MISSING_ID: RepoId = 4242;

/// A registered repo with one commit plus a canonical temp root for worktree folders.
fn setup() -> (
    tempfile::TempDir,
    PathBuf,
    tempfile::TempDir,
    PathBuf,
    RepoRegistry,
    RepoId,
) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let root_dir = tempfile::tempdir().unwrap();
    let root = root_dir.path().canonicalize().unwrap();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).unwrap());
    (dir, path, root_dir, root, reg, id)
}

fn feat() -> WorktreeBranch {
    WorktreeBranch::New {
        name: "feat".into(),
        start: None,
    }
}

#[test]
fn list_linked_worktrees_inner_lists_the_main_worktree() {
    let (_d, path, _r, _root, reg, id) = setup();
    let list = list_linked_worktrees_inner(&reg, id).unwrap();
    assert_eq!(list.len(), 1, "{list:?}");
    assert!(list[0].is_main && list[0].is_current);
    assert_eq!(list[0].path, path.canonicalize().unwrap());
}

#[test]
fn add_linked_worktree_inner_creates_a_worktree() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, _r, root, reg, id) = setup();
    let wt = root.join("feat");
    add_linked_worktree_inner(&reg, id, &wt, &feat()).unwrap();
    assert!(wt.exists());
    assert_eq!(list_linked_worktrees_inner(&reg, id).unwrap().len(), 2);
}

#[test]
fn remove_linked_worktree_inner_removes_it() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, _r, root, reg, id) = setup();
    let wt = root.join("feat");
    add_linked_worktree_inner(&reg, id, &wt, &feat()).unwrap();
    remove_linked_worktree_inner(&reg, id, &wt, false).unwrap();
    assert!(!wt.exists());
    assert_eq!(list_linked_worktrees_inner(&reg, id).unwrap().len(), 1);
}

#[test]
fn prune_linked_worktrees_inner_returns_the_pruned_paths() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, _r, root, reg, id) = setup();
    let wt = root.join("feat");
    add_linked_worktree_inner(&reg, id, &wt, &feat()).unwrap();
    std::fs::remove_dir_all(&wt).unwrap();
    assert_eq!(
        prune_linked_worktrees_inner(&reg, id).unwrap(),
        PrunedWorktrees { paths: vec![wt] }
    );
    assert_eq!(list_linked_worktrees_inner(&reg, id).unwrap().len(), 1);
}

#[test]
fn linked_worktree_inner_functions_reject_an_unknown_repo() {
    let (_d, _p, _r, root, reg, _id) = setup();
    let wt = root.join("x");
    let kinds = [
        list_linked_worktrees_inner(&reg, MISSING_ID)
            .unwrap_err()
            .kind,
        add_linked_worktree_inner(&reg, MISSING_ID, &wt, &feat())
            .unwrap_err()
            .kind,
        remove_linked_worktree_inner(&reg, MISSING_ID, &wt, false)
            .unwrap_err()
            .kind,
        prune_linked_worktrees_inner(&reg, MISSING_ID)
            .unwrap_err()
            .kind,
    ];
    assert_eq!(kinds, [AppErrorKind::UnknownRepo; 4]);
}

#[test]
fn remove_linked_worktree_inner_maps_worktree_dirty() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, _r, root, reg, id) = setup();
    let wt = root.join("feat");
    add_linked_worktree_inner(&reg, id, &wt, &feat()).unwrap();
    common::write_file(&wt, "README.md", "changed\n");
    let err = remove_linked_worktree_inner(&reg, id, &wt, false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::WorktreeDirty);
    assert!(wt.exists());
}

#[test]
fn worktree_branch_deserializes_tagged() {
    assert_eq!(
        serde_json::from_value::<WorktreeBranch>(
            json!({"kind": "new", "name": "f", "start": null})
        )
        .unwrap(),
        WorktreeBranch::New {
            name: "f".into(),
            start: None
        }
    );
    assert_eq!(
        serde_json::from_value::<WorktreeBranch>(json!({"kind": "existing", "name": "f"})).unwrap(),
        WorktreeBranch::Existing { name: "f".into() }
    );
}
