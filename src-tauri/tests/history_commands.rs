//! Integration tests for the history command `*_inner` functions (GR-9).

mod common;

use std::path::PathBuf;

use git_real_core::{ChangeKind, RepoSession};
use git_real_lib::commands::history::{
    get_blame_inner, get_commit_files_inner, get_file_history_inner, list_tracked_files_inner,
};
use git_real_lib::commands::log::get_log_summary_inner;
use git_real_lib::error::AppErrorKind;
use git_real_lib::state::{RepoId, RepoRegistry};
use git2::{Oid, Repository};
use tempfile::TempDir;

const MISSING_ID: RepoId = 4242;
const ABSENT_OID: &str = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/// Registered repo with one commit (README.md), local identity, signing off.
fn open_fixture() -> (TempDir, PathBuf, RepoRegistry, RepoId) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).expect("open"));
    (dir, path, reg, id)
}

fn head_oid(path: &std::path::Path) -> Oid {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
}

// --- list_tracked_files_inner ---

#[test]
fn list_tracked_files_inner_lists_the_committed_file() {
    let (_d, _p, reg, id) = open_fixture();

    let files = list_tracked_files_inner(&reg, id).unwrap();

    assert_eq!(files, ["README.md"]);
}

#[test]
fn list_tracked_files_inner_includes_a_nested_file_after_a_commit() {
    let (_d, path, reg, id) = open_fixture();
    common::commit_file(&path, "src.txt", "x\n", "add src");

    let files = list_tracked_files_inner(&reg, id).unwrap();

    assert_eq!(files, ["README.md", "src.txt"]);
}

// --- get_commit_files_inner ---

#[test]
fn get_commit_files_inner_lists_the_root_commit_file_as_added() {
    let (_d, path, reg, id) = open_fixture();

    let files = get_commit_files_inner(&reg, id, &head_oid(&path).to_string()).unwrap();

    assert_eq!(
        files
            .iter()
            .map(|f| (f.path.as_str(), f.change))
            .collect::<Vec<_>>(),
        [("README.md", ChangeKind::Added)]
    );
}

#[test]
fn get_commit_files_inner_maps_a_bad_oid_to_commit_not_found() {
    let (_d, _p, reg, id) = open_fixture();

    let err = get_commit_files_inner(&reg, id, ABSENT_OID).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

// --- get_file_history_inner ---

#[test]
fn get_file_history_inner_returns_one_entry_for_a_file_with_one_commit() {
    let (_d, path, reg, id) = open_fixture();
    let summary = get_log_summary_inner(&reg, id).unwrap();

    let entries = get_file_history_inner(&reg, id, summary.generation, "README.md").unwrap();

    assert_eq!(
        entries
            .iter()
            .map(|e| (e.oid.clone(), e.change))
            .collect::<Vec<_>>(),
        [(head_oid(&path).to_string(), ChangeKind::Added)]
    );
}

#[test]
fn get_file_history_inner_returns_nothing_for_an_unknown_path() {
    let (_d, _p, reg, id) = open_fixture();
    let summary = get_log_summary_inner(&reg, id).unwrap();

    let entries = get_file_history_inner(&reg, id, summary.generation, "nope.txt").unwrap();

    assert!(entries.is_empty());
}

#[test]
fn get_file_history_inner_maps_a_wrong_generation_to_log_stale() {
    let (_d, _p, reg, id) = open_fixture();
    get_log_summary_inner(&reg, id).unwrap();

    let err = get_file_history_inner(&reg, id, 99, "README.md").unwrap_err();

    assert_eq!(err.kind, AppErrorKind::LogStale);
}

#[test]
fn get_file_history_inner_maps_a_call_before_any_summary_to_log_stale() {
    let (_d, _p, reg, id) = open_fixture();

    let err = get_file_history_inner(&reg, id, 1, "README.md").unwrap_err();

    assert_eq!(err.kind, AppErrorKind::LogStale);
}

// --- get_blame_inner ---

#[test]
fn get_blame_inner_returns_one_hunk_for_a_single_commit_file() {
    let (_d, path, reg, id) = open_fixture();

    let blame = get_blame_inner(&reg, id, "README.md", None).unwrap();

    assert_eq!(
        (blame.oid, blame.hunks.len(), blame.lines),
        (head_oid(&path).to_string(), 1, vec!["# fixture".to_owned()])
    );
}

#[test]
fn get_blame_inner_at_an_explicit_commit_blames_that_commit() {
    let (_d, path, reg, id) = open_fixture();
    let root = head_oid(&path).to_string();
    common::commit_file(&path, "README.md", "# fixture\ntwo\n", "add two");

    let blame = get_blame_inner(&reg, id, "README.md", Some(&root)).unwrap();

    assert_eq!((blame.oid, blame.lines.len()), (root, 1));
}

#[test]
fn get_blame_inner_maps_a_binary_file_to_binary_file() {
    let (_d, path, reg, id) = open_fixture();
    common::commit_file(&path, "img.bin", "PNG\0\u{1}\u{2}", "add binary");

    let err = get_blame_inner(&reg, id, "img.bin", None).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::BinaryFile);
}

#[test]
fn get_blame_inner_maps_a_missing_path_to_path_not_found() {
    let (_d, _p, reg, id) = open_fixture();

    let err = get_blame_inner(&reg, id, "nope.txt", None).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::PathNotFound);
}

#[test]
fn get_blame_inner_maps_a_bad_oid_to_commit_not_found() {
    let (_d, _p, reg, id) = open_fixture();

    let err = get_blame_inner(&reg, id, "README.md", Some(ABSENT_OID)).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

// --- unknown repo id: every command maps to unknownRepo ---

#[test]
fn list_tracked_files_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = list_tracked_files_inner(&reg, MISSING_ID).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn get_commit_files_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = get_commit_files_inner(&reg, MISSING_ID, ABSENT_OID).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn get_file_history_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = get_file_history_inner(&reg, MISSING_ID, 1, "a.txt").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn get_blame_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = get_blame_inner(&reg, MISSING_ID, "a.txt", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}
