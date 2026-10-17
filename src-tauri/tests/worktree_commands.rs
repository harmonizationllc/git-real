//! Integration tests for the working-tree command `*_inner` functions.

mod common;

use std::path::Path;

use git_real_core::{
    ChangeKind, DiffScope, HunkAction, HunkSelection, RepoSession, WorkingTreeStatus,
};
use git_real_lib::commands::worktree::{
    add_to_gitignore_inner, apply_hunk_inner, discard_paths_inner, get_file_diff_inner,
    get_status_inner, stage_all_inner, stage_paths_inner, unstage_all_inner, unstage_paths_inner,
};
use git_real_lib::error::{AppError, AppErrorKind};
use git_real_lib::state::{RepoId, RepoRegistry};
use tempfile::TempDir;

/// A registry holding one open fixture repo (one commit with README.md).
fn open_fixture() -> (TempDir, std::path::PathBuf, RepoRegistry, RepoId) {
    let (dir, path) = common::temp_repo_with_commit();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).expect("open fixture repo"));
    (dir, path, reg, id)
}

fn modify_readme(path: &Path) {
    std::fs::write(path.join("README.md"), "# fixture\nmore\n").expect("modify README");
}

fn paths(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

fn entry<'a>(status: &'a WorkingTreeStatus, path: &str) -> Option<&'a git_real_core::StatusEntry> {
    status.entries.iter().find(|e| e.path == path)
}

// get_status_inner / get_file_diff_inner: read paths.
#[test]
fn get_status_inner_lists_untracked() {
    let (_dir, path, reg, id) = open_fixture();
    std::fs::write(path.join("new.txt"), "hi").unwrap();

    let status = get_status_inner(&reg, id).unwrap();

    assert_eq!(
        entry(&status, "new.txt").map(|e| e.worktree),
        Some(Some(ChangeKind::Untracked))
    );
}

#[test]
fn get_file_diff_inner_returns_hunks() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);

    let diff = get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false).unwrap();

    assert_eq!(diff.hunks.len(), 1);
}

#[test]
fn get_file_diff_inner_no_changes_errors() {
    let (_dir, _path, reg, id) = open_fixture();

    let err = get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false)
        .expect_err("clean file has no diff");

    assert_eq!(err.kind, AppErrorKind::NoChanges);
}

// Staging commands: each changes the index/worktree as documented.
#[test]
fn stage_paths_inner_stages_modified_file() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);

    stage_paths_inner(&reg, id, &paths(&["README.md"])).unwrap();

    let status = get_status_inner(&reg, id).unwrap();
    assert_eq!(
        entry(&status, "README.md").map(|e| e.index),
        Some(Some(ChangeKind::Modified))
    );
}

#[test]
fn unstage_paths_inner_clears_index_entry() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    stage_paths_inner(&reg, id, &paths(&["README.md"])).unwrap();

    unstage_paths_inner(&reg, id, &paths(&["README.md"])).unwrap();

    let status = get_status_inner(&reg, id).unwrap();
    assert_eq!(
        entry(&status, "README.md").map(|e| (e.index, e.worktree)),
        Some((None, Some(ChangeKind::Modified)))
    );
}

#[test]
fn stage_all_inner_stages_every_change() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    std::fs::write(path.join("new.txt"), "hi").unwrap();

    stage_all_inner(&reg, id).unwrap();

    let status = get_status_inner(&reg, id).unwrap();
    assert!(status.entries.iter().all(|e| e.index.is_some()));
}

#[test]
fn unstage_all_inner_clears_index() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    stage_all_inner(&reg, id).unwrap();

    unstage_all_inner(&reg, id).unwrap();

    let status = get_status_inner(&reg, id).unwrap();
    assert!(status.entries.iter().all(|e| e.index.is_none()));
}

#[test]
fn discard_paths_inner_restores_file_content() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);

    discard_paths_inner(&reg, id, &paths(&["README.md"])).unwrap();

    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# fixture\n"
    );
}

#[test]
fn apply_hunk_inner_stages_hunk() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    let selection = HunkSelection {
        hunk_index: 0,
        lines: None,
    };

    apply_hunk_inner(&reg, id, "README.md", HunkAction::Stage, &selection).unwrap();

    let status = get_status_inner(&reg, id).unwrap();
    assert_eq!(
        entry(&status, "README.md").map(|e| e.index),
        Some(Some(ChangeKind::Modified))
    );
}

#[test]
fn apply_hunk_inner_bad_selection_errors() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    let selection = HunkSelection {
        hunk_index: 99,
        lines: None,
    };

    let err = apply_hunk_inner(&reg, id, "README.md", HunkAction::Stage, &selection)
        .expect_err("hunk 99 does not exist");

    assert_eq!(err.kind, AppErrorKind::BadSelection);
}

#[test]
fn add_to_gitignore_inner_returns_pattern() {
    let (_dir, path, reg, id) = open_fixture();
    std::fs::write(path.join("junk.txt"), "x").unwrap();

    let pattern = add_to_gitignore_inner(&reg, id, "junk.txt").unwrap();

    assert_eq!(pattern, "/junk.txt");
}

#[test]
fn add_to_gitignore_inner_writes_gitignore_file() {
    let (_dir, path, reg, id) = open_fixture();
    std::fs::write(path.join("junk.txt"), "x").unwrap();

    add_to_gitignore_inner(&reg, id, "junk.txt").unwrap();

    assert!(
        std::fs::read_to_string(path.join(".gitignore"))
            .unwrap()
            .lines()
            .any(|l| l == "/junk.txt")
    );
}

// Core errors surface with their own kinds, not the generic `git` kind.
#[test]
fn add_to_gitignore_inner_missing_path_errors_with_path_not_found() {
    let (_dir, _path, reg, id) = open_fixture();

    let err = add_to_gitignore_inner(&reg, id, "ghost.txt").expect_err("path does not exist");

    assert_eq!(err.kind, AppErrorKind::PathNotFound);
}

// Unknown ids: every command rejects an id that is not registered.
#[test]
fn unknown_repo_id_errors_for_every_command() {
    let reg = RepoRegistry::default();
    let sel = HunkSelection {
        hunk_index: 0,
        lines: None,
    };
    let p = paths(&["README.md"]);
    let results: Vec<(&str, Result<(), AppError>)> = vec![
        ("get_status", get_status_inner(&reg, 999).map(|_| ())),
        (
            "get_file_diff",
            get_file_diff_inner(&reg, 999, "README.md", DiffScope::Unstaged, false).map(|_| ()),
        ),
        ("stage_paths", stage_paths_inner(&reg, 999, &p)),
        ("unstage_paths", unstage_paths_inner(&reg, 999, &p)),
        ("stage_all", stage_all_inner(&reg, 999)),
        ("unstage_all", unstage_all_inner(&reg, 999)),
        ("discard_paths", discard_paths_inner(&reg, 999, &p)),
        (
            "apply_hunk",
            apply_hunk_inner(&reg, 999, "README.md", HunkAction::Stage, &sel),
        ),
        (
            "add_to_gitignore",
            add_to_gitignore_inner(&reg, 999, "README.md").map(|_| ()),
        ),
    ];
    let kinds: Vec<(&str, Option<AppErrorKind>)> = results
        .into_iter()
        .map(|(name, r)| (name, r.err().map(|e| e.kind)))
        .collect();
    let expected: Vec<(&str, Option<AppErrorKind>)> = kinds
        .iter()
        .map(|(name, _)| (*name, Some(AppErrorKind::UnknownRepo)))
        .collect();
    assert_eq!((kinds.len(), kinds), (9, expected));
}
