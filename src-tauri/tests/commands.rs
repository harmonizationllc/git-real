//! Integration tests for the repo command `*_inner` functions and `run_blocking`.

mod common;

use git_real_core::git_cli;
use git_real_lib::commands::repo::{
    GitCliInfo, check_git_cli_inner, clone_repo_inner, close_repo_inner, init_repo_inner,
    list_recent_inner, open_repo_inner, remove_recent_inner,
};
use git_real_lib::commands::run_blocking;
use git_real_lib::error::{AppError, AppErrorKind};

fn path_str(path: &std::path::Path) -> &str {
    path.to_str().expect("utf-8 path")
}

// --- open_repo_inner: registers a session and touches recents ---

#[test]
fn open_registers_and_touches_recent() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();

    let opened = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();

    assert!(reg.get(opened.id).is_some());
    assert_eq!(recent.entries()[0].path, opened.summary.path);
    assert_eq!(opened.summary.path, path.canonicalize().unwrap());
    assert_eq!(
        opened.summary.name,
        path.file_name().unwrap().to_string_lossy()
    );
}

// Re-opening the same repo must not create a second session.
#[test]
fn open_same_repo_twice_returns_same_id() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();

    let first = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();
    let second = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();

    assert_eq!(first.id, second.id);
}

#[test]
fn open_same_repo_twice_keeps_one_recent_entry() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();

    open_repo_inner(&reg, &recent, path_str(&path)).unwrap();
    open_repo_inner(&reg, &recent, path_str(&path)).unwrap();

    assert_eq!(recent.entries().len(), 1);
}

#[test]
fn open_same_repo_twice_registers_no_second_session() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();

    let first = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();
    open_repo_inner(&reg, &recent, path_str(&path)).unwrap();

    assert!(reg.get(first.id + 1).is_none());
}

// Opening via the `.git` directory resolves to the same canonical root.
#[test]
fn open_dot_git_dir_dedupes_with_workdir() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();

    let first = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();
    let second = open_repo_inner(&reg, &recent, path_str(&path.join(".git"))).unwrap();

    assert_eq!(first.id, second.id);
}

#[test]
fn close_then_reopen_gets_new_id() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();

    let first = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();
    close_repo_inner(&reg, first.id).unwrap();
    let second = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();

    assert_eq!(second.id, first.id + 1);
}

// --- open_repo_inner: failures register and touch nothing ---

#[test]
fn open_non_repo_is_not_a_repository_kind() {
    let (_state, reg, recent) = common::fresh_state();
    let empty = tempfile::tempdir().unwrap();

    let err = open_repo_inner(&reg, &recent, path_str(empty.path())).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::NotARepository);
}

#[test]
fn open_non_repo_registers_nothing() {
    let (_state, reg, recent) = common::fresh_state();
    let empty = tempfile::tempdir().unwrap();

    let _ = open_repo_inner(&reg, &recent, path_str(empty.path()));

    assert!(reg.get(1).is_none());
}

#[test]
fn open_non_repo_leaves_recents_empty() {
    let (_state, reg, recent) = common::fresh_state();
    let empty = tempfile::tempdir().unwrap();

    let _ = open_repo_inner(&reg, &recent, path_str(empty.path()));

    assert!(recent.entries().is_empty());
}

#[test]
fn open_missing_path_is_path_not_found() {
    let (_state, reg, recent) = common::fresh_state();
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");

    let err = open_repo_inner(&reg, &recent, path_str(&missing)).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::PathNotFound);
}

#[test]
fn open_missing_path_registers_and_touches_nothing() {
    let (_state, reg, recent) = common::fresh_state();
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");

    let _ = open_repo_inner(&reg, &recent, path_str(&missing));

    assert!(reg.get(1).is_none() && recent.entries().is_empty());
}

#[test]
fn open_empty_path_is_an_error() {
    let (_state, reg, recent) = common::fresh_state();

    assert!(open_repo_inner(&reg, &recent, "").is_err());
}

// --- init_repo_inner ---

#[test]
fn init_registers_and_touches_recent() {
    let (_state, reg, recent) = common::fresh_state();
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("fresh");

    let opened = init_repo_inner(&reg, &recent, path_str(&target)).unwrap();

    assert!(opened.summary.path.join(".git").exists());
    assert!(reg.get(opened.id).is_some());
    assert_eq!(recent.entries()[0].path, opened.summary.path);
}

#[test]
fn init_existing_repo_is_already_a_repository_kind() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();

    let err = init_repo_inner(&reg, &recent, path_str(&path)).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::AlreadyARepository);
}

#[test]
fn init_existing_repo_registers_and_touches_nothing() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();

    let _ = init_repo_inner(&reg, &recent, path_str(&path));

    assert!(reg.get(1).is_none() && recent.entries().is_empty());
}

// --- close_repo_inner ---

#[test]
fn close_removes_the_session() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();
    let opened = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();

    close_repo_inner(&reg, opened.id).unwrap();

    assert!(reg.get(opened.id).is_none());
}

#[test]
fn close_then_close_again_is_unknown_repo() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();
    let opened = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();

    assert_eq!(close_repo_inner(&reg, opened.id), Ok(()));
    let err = close_repo_inner(&reg, opened.id).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn close_again_error_message_contains_the_id() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();
    let opened = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();
    close_repo_inner(&reg, opened.id).unwrap();

    let err = close_repo_inner(&reg, opened.id).unwrap_err();

    assert!(err.message.contains(&opened.id.to_string()));
}

#[test]
fn close_unknown_id_is_unknown_repo() {
    let (_state, reg, _recent) = common::fresh_state();

    let err = close_repo_inner(&reg, 7).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

// --- list_recent_inner / remove_recent_inner ---

#[test]
fn list_recent_is_most_recent_first() {
    let (_state, reg, recent) = common::fresh_state();
    let (_a_dir, a) = common::temp_repo_with_commit();
    let (_b_dir, b) = common::temp_repo_with_commit();
    let a_opened = open_repo_inner(&reg, &recent, path_str(&a)).unwrap();
    let b_opened = open_repo_inner(&reg, &recent, path_str(&b)).unwrap();

    let listed = list_recent_inner(&recent);

    let paths: Vec<_> = listed.iter().map(|e| e.path.clone()).collect();
    assert_eq!(paths, vec![b_opened.summary.path, a_opened.summary.path]);
}

#[test]
fn list_recent_matches_store_entries() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();
    open_repo_inner(&reg, &recent, path_str(&path)).unwrap();

    assert_eq!(list_recent_inner(&recent), recent.entries());
}

#[test]
fn list_recent_is_empty_for_fresh_store() {
    let (_state, _reg, recent) = common::fresh_state();

    assert!(list_recent_inner(&recent).is_empty());
}

#[test]
fn remove_recent_returns_updated_list() {
    let (_state, reg, recent) = common::fresh_state();
    let (_a_dir, a) = common::temp_repo_with_commit();
    let (_b_dir, b) = common::temp_repo_with_commit();
    let a_opened = open_repo_inner(&reg, &recent, path_str(&a)).unwrap();
    let b_opened = open_repo_inner(&reg, &recent, path_str(&b)).unwrap();

    let remaining = remove_recent_inner(&recent, path_str(&a_opened.summary.path));

    let paths: Vec<_> = remaining.iter().map(|e| e.path.clone()).collect();
    assert_eq!(paths, vec![b_opened.summary.path]);
}

#[test]
fn remove_recent_result_equals_list_recent() {
    let (_state, reg, recent) = common::fresh_state();
    let (_a_dir, a) = common::temp_repo_with_commit();
    let (_b_dir, b) = common::temp_repo_with_commit();
    let a_opened = open_repo_inner(&reg, &recent, path_str(&a)).unwrap();
    open_repo_inner(&reg, &recent, path_str(&b)).unwrap();

    let remaining = remove_recent_inner(&recent, path_str(&a_opened.summary.path));

    assert_eq!(remaining, list_recent_inner(&recent));
}

#[test]
fn remove_recent_unknown_path_is_unchanged() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();
    open_repo_inner(&reg, &recent, path_str(&path)).unwrap();
    let before = list_recent_inner(&recent);

    let after = remove_recent_inner(&recent, "/no/such/recent/path");

    assert_eq!(after, before);
}

// --- check_git_cli_inner / GitCliInfo::from_located ---

#[test]
fn check_git_cli_reports_path_when_available() {
    let info = check_git_cli_inner();

    match git_cli::locate() {
        Ok(p) => assert_eq!(
            info,
            GitCliInfo {
                available: true,
                path: Some(p.to_string_lossy().into_owned())
            }
        ),
        Err(_) => assert_eq!(
            info,
            GitCliInfo {
                available: false,
                path: None
            }
        ),
    }
}

#[test]
fn git_cli_info_from_located_some() {
    let info = GitCliInfo::from_located(Some(std::path::PathBuf::from("/usr/bin/git")));

    assert_eq!(
        info,
        GitCliInfo {
            available: true,
            path: Some("/usr/bin/git".to_string())
        }
    );
}

#[test]
fn git_cli_info_from_located_none() {
    let info = GitCliInfo::from_located(None);

    assert_eq!(
        info,
        GitCliInfo {
            available: false,
            path: None
        }
    );
}

#[test]
fn git_cli_info_serializes_camel_case() {
    let info = GitCliInfo::from_located(Some(std::path::PathBuf::from("/usr/bin/git")));

    assert_eq!(
        serde_json::to_value(info).unwrap(),
        serde_json::json!({"available": true, "path": "/usr/bin/git"})
    );
}

#[test]
fn opened_repo_serializes_id_and_summary() {
    let (_state, reg, recent) = common::fresh_state();
    let (_dir, path) = common::temp_repo_with_commit();
    let opened = open_repo_inner(&reg, &recent, path_str(&path)).unwrap();

    let value = serde_json::to_value(&opened).unwrap();

    assert_eq!(value["id"], serde_json::json!(opened.id));
    assert!(value["summary"]["path"].is_string());
}

// --- clone_repo_inner (needs the git CLI) ---

#[test]
fn clone_inner_opens_result() {
    if !common::git_available() {
        return;
    }
    let (_state, reg, recent) = common::fresh_state();
    let (_src_dir, src) = common::temp_repo_with_commit();
    let (_bare_dir, bare) = common::temp_bare_clone(&src);
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = common::RecordingSink(Vec::new());

    let opened = clone_repo_inner(
        &reg,
        &recent,
        &common::file_url(&bare),
        path_str(&dest),
        &mut sink,
    )
    .unwrap();

    assert_eq!(opened.summary.path, dest.canonicalize().unwrap());
}

#[test]
fn clone_inner_reports_progress_to_sink() {
    if !common::git_available() {
        return;
    }
    let (_state, reg, recent) = common::fresh_state();
    let (_src_dir, src) = common::temp_repo_with_commit();
    let (_bare_dir, bare) = common::temp_bare_clone(&src);
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = common::RecordingSink(Vec::new());

    clone_repo_inner(
        &reg,
        &recent,
        &common::file_url(&bare),
        path_str(&dest),
        &mut sink,
    )
    .unwrap();

    assert!(!sink.0.is_empty());
}

#[test]
fn clone_inner_registers_session_and_touches_recent() {
    if !common::git_available() {
        return;
    }
    let (_state, reg, recent) = common::fresh_state();
    let (_src_dir, src) = common::temp_repo_with_commit();
    let (_bare_dir, bare) = common::temp_bare_clone(&src);
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = common::RecordingSink(Vec::new());

    let opened = clone_repo_inner(
        &reg,
        &recent,
        &common::file_url(&bare),
        path_str(&dest),
        &mut sink,
    )
    .unwrap();

    assert!(reg.get(opened.id).is_some());
    assert_eq!(recent.entries()[0].path, opened.summary.path);
}

#[test]
fn clone_inner_failure_kind() {
    if !common::git_available() {
        return;
    }
    let (_state, reg, recent) = common::fresh_state();
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = common::RecordingSink(Vec::new());

    let err = clone_repo_inner(
        &reg,
        &recent,
        "file:///nonexistent/repo",
        path_str(&dest),
        &mut sink,
    )
    .unwrap_err();

    assert_eq!(err.kind, AppErrorKind::CloneFailed);
}

#[test]
fn clone_inner_failure_message_is_reduced_to_fatal_line() {
    if !common::git_available() {
        return;
    }
    let (_state, reg, recent) = common::fresh_state();
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = common::RecordingSink(Vec::new());

    let err = clone_repo_inner(
        &reg,
        &recent,
        "file:///nonexistent/repo",
        path_str(&dest),
        &mut sink,
    )
    .unwrap_err();

    assert!(err.message.starts_with("fatal:"), "got: {}", err.message);
}

#[test]
fn clone_inner_failure_message_omits_progress_noise() {
    if !common::git_available() {
        return;
    }
    let (_state, reg, recent) = common::fresh_state();
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = common::RecordingSink(Vec::new());

    let err = clone_repo_inner(
        &reg,
        &recent,
        "file:///nonexistent/repo",
        path_str(&dest),
        &mut sink,
    )
    .unwrap_err();

    assert!(!err.message.contains("Cloning into"));
}

#[test]
fn clone_inner_failure_registers_and_touches_nothing() {
    if !common::git_available() {
        return;
    }
    let (_state, reg, recent) = common::fresh_state();
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = common::RecordingSink(Vec::new());

    let _ = clone_repo_inner(
        &reg,
        &recent,
        "file:///nonexistent/repo",
        path_str(&dest),
        &mut sink,
    );

    assert!(reg.get(1).is_none() && recent.entries().is_empty());
}

#[test]
fn clone_inner_into_non_empty_dest_fails() {
    if !common::git_available() {
        return;
    }
    let (_state, reg, recent) = common::fresh_state();
    let (_src_dir, src) = common::temp_repo_with_commit();
    let (_bare_dir, bare) = common::temp_bare_clone(&src);
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    std::fs::create_dir(&dest).unwrap();
    std::fs::write(dest.join("keep.txt"), "mine").unwrap();
    let mut sink = common::RecordingSink(Vec::new());

    let err = clone_repo_inner(
        &reg,
        &recent,
        &common::file_url(&bare),
        path_str(&dest),
        &mut sink,
    )
    .unwrap_err();

    assert_eq!(err.kind, AppErrorKind::CloneFailed);
}

#[test]
fn clone_inner_into_non_empty_dest_leaves_existing_file_untouched() {
    if !common::git_available() {
        return;
    }
    let (_state, reg, recent) = common::fresh_state();
    let (_src_dir, src) = common::temp_repo_with_commit();
    let (_bare_dir, bare) = common::temp_bare_clone(&src);
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    std::fs::create_dir(&dest).unwrap();
    std::fs::write(dest.join("keep.txt"), "mine").unwrap();
    let mut sink = common::RecordingSink(Vec::new());

    let _ = clone_repo_inner(
        &reg,
        &recent,
        &common::file_url(&bare),
        path_str(&dest),
        &mut sink,
    );

    assert_eq!(
        std::fs::read_to_string(dest.join("keep.txt")).unwrap(),
        "mine"
    );
}

// --- run_blocking: off-thread execution with join failures mapped to Io ---

#[test]
fn run_blocking_returns_value() {
    let result = tauri::async_runtime::block_on(run_blocking(|| Ok(5)));

    assert_eq!(result, Ok(5));
}

#[test]
fn run_blocking_passes_through_app_error() {
    let result: Result<(), AppError> =
        tauri::async_runtime::block_on(run_blocking(|| Err(AppError::unknown_repo(3))));

    assert_eq!(result, Err(AppError::unknown_repo(3)));
}

#[test]
fn run_blocking_maps_panic_to_io_kind() {
    let result: Result<(), AppError> =
        tauri::async_runtime::block_on(run_blocking(|| panic!("boom")));

    assert_eq!(result.unwrap_err().kind, AppErrorKind::Io);
}

#[test]
fn run_blocking_panic_error_has_a_message() {
    let result: Result<(), AppError> =
        tauri::async_runtime::block_on(run_blocking(|| panic!("boom")));

    assert!(!result.unwrap_err().message.is_empty());
}
