//! Integration tests for the working-tree command `*_inner` functions.

mod common;

use std::path::Path;

use git_real_core::{
    ChangeKind, DiffScope, DiffSide, HunkAction, HunkSelection, RepoSession, WorkingTreeStatus,
};
use git_real_lib::commands::worktree::{
    MAX_PREVIEW_BYTES, add_to_gitignore_inner, apply_hunk_inner, discard_paths_inner,
    get_file_content_inner, get_file_diff_inner, get_status_inner, stage_all_inner,
    stage_paths_inner, unstage_all_inner, unstage_paths_inner,
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

    let diff =
        get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false, None).unwrap();

    assert_eq!(diff.hunks.len(), 1);
}

#[test]
fn get_file_diff_inner_no_changes_errors() {
    let (_dir, _path, reg, id) = open_fixture();

    let err = get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false, None)
        .expect_err("clean file has no diff");

    assert_eq!(err.kind, AppErrorKind::NoChanges);
}

// max_lines: the optional cap is forwarded to the diff options.
#[test]
fn get_file_diff_inner_honours_max_lines() {
    let (_dir, path, reg, id) = open_fixture();
    std::fs::write(path.join("README.md"), "# fixture\na\nb\nc\nd\n").unwrap();
    let capped =
        get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false, Some(2)).unwrap();
    assert!(capped.truncated);
    assert_eq!(capped.hunks[0].lines.len(), 2);
}

#[test]
fn get_file_diff_inner_without_max_lines_is_not_truncated() {
    let (_dir, path, reg, id) = open_fixture();
    std::fs::write(path.join("README.md"), "# fixture\na\nb\nc\nd\n").unwrap();
    let full =
        get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false, None).unwrap();
    assert!(!full.truncated);
}

// Some(0) is pinned as implemented: nothing is collected and the diff reports truncation.
#[test]
fn get_file_diff_inner_zero_max_lines_is_an_empty_truncated_diff() {
    let (_dir, path, reg, id) = open_fixture();
    std::fs::write(path.join("README.md"), "# fixture\na\nb\n").unwrap();
    let diff =
        get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false, Some(0)).unwrap();
    let collected: usize = diff.hunks.iter().map(|h| h.lines.len()).sum();
    assert_eq!((collected, diff.truncated), (0, true));
}

// None means the core default of 10_000 lines, so an explicit 10_000 is equivalent.
#[test]
fn get_file_diff_inner_none_matches_the_core_default_cap() {
    let (_dir, path, reg, id) = open_fixture();
    let body: String = (0..10_050).map(|i| format!("line {i}\n")).collect();
    std::fs::write(path.join("README.md"), body).unwrap();
    let default =
        get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false, None).unwrap();
    let explicit = get_file_diff_inner(
        &reg,
        id,
        "README.md",
        DiffScope::Unstaged,
        false,
        Some(10_000),
    )
    .unwrap();
    let count = |d: &git_real_core::FileDiff| d.hunks.iter().map(|h| h.lines.len()).sum::<usize>();
    assert_eq!(
        (
            count(&default),
            default.truncated,
            count(&explicit),
            explicit.truncated
        ),
        (10_000, true, 10_000, true)
    );
}

// Every scope/side pair resolves to the documented source through the app layer.
#[test]
fn get_file_content_inner_staged_old_is_head_and_new_is_index() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    stage_paths_inner(&reg, id, &paths(&["README.md"])).unwrap();
    std::fs::write(path.join("README.md"), "# fixture\nmore\nworktree only\n").unwrap();
    let read = |scope, side| {
        get_file_content_inner(&reg, id, "README.md", scope, side, MAX_PREVIEW_BYTES).unwrap()
    };
    assert_eq!(
        (
            read(DiffScope::Staged, DiffSide::Old),
            read(DiffScope::Staged, DiffSide::New),
        ),
        (b"# fixture\n".to_vec(), b"# fixture\nmore\n".to_vec())
    );
}

#[test]
fn get_file_content_inner_unstaged_old_is_the_index_not_head() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    stage_paths_inner(&reg, id, &paths(&["README.md"])).unwrap();
    std::fs::write(path.join("README.md"), "# fixture\nmore\nworktree only\n").unwrap();
    let old = get_file_content_inner(
        &reg,
        id,
        "README.md",
        DiffScope::Unstaged,
        DiffSide::Old,
        MAX_PREVIEW_BYTES,
    )
    .unwrap();
    assert_eq!(old, b"# fixture\nmore\n");
}

#[test]
fn get_file_content_inner_staged_old_of_a_new_file_maps_to_path_not_found() {
    let (_dir, path, reg, id) = open_fixture();
    std::fs::write(path.join("fresh.txt"), "x\n").unwrap();
    stage_paths_inner(&reg, id, &paths(&["fresh.txt"])).unwrap();
    let err = get_file_content_inner(
        &reg,
        id,
        "fresh.txt",
        DiffScope::Staged,
        DiffSide::Old,
        MAX_PREVIEW_BYTES,
    )
    .expect_err("not in HEAD");
    assert_eq!(err.kind, AppErrorKind::PathNotFound);
}

// get_file_content_inner: raw bytes of one side of a file.
#[test]
fn get_file_content_inner_returns_old_bytes() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    let old = get_file_content_inner(
        &reg,
        id,
        "README.md",
        DiffScope::Unstaged,
        DiffSide::Old,
        MAX_PREVIEW_BYTES,
    )
    .unwrap();
    assert_eq!(old, b"# fixture\n");
}

#[test]
fn get_file_content_inner_returns_new_bytes() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    let new = get_file_content_inner(
        &reg,
        id,
        "README.md",
        DiffScope::Unstaged,
        DiffSide::New,
        MAX_PREVIEW_BYTES,
    )
    .unwrap();
    assert_eq!(new, b"# fixture\nmore\n");
}

#[test]
fn get_file_content_inner_missing_file_maps_to_path_not_found() {
    let (_dir, _path, reg, id) = open_fixture();
    let missing = get_file_content_inner(
        &reg,
        id,
        "nope.txt",
        DiffScope::Unstaged,
        DiffSide::New,
        MAX_PREVIEW_BYTES,
    )
    .expect_err("missing file");
    assert_eq!(missing.kind, AppErrorKind::PathNotFound);
}

#[test]
fn get_file_content_inner_unknown_repo_errors() {
    let (_dir, _path, reg, _id) = open_fixture();
    let bad = get_file_content_inner(
        &reg,
        999,
        "README.md",
        DiffScope::Unstaged,
        DiffSide::New,
        MAX_PREVIEW_BYTES,
    )
    .expect_err("unknown repo");
    assert_eq!(bad.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn get_file_content_inner_over_limit_maps_to_too_large() {
    let (_dir, _path, reg, id) = open_fixture();
    let err = get_file_content_inner(&reg, id, "README.md", DiffScope::Unstaged, DiffSide::New, 1)
        .expect_err("file above the limit");
    assert_eq!(err.kind, AppErrorKind::TooLarge);
    assert!(err.message.contains("above the 1 byte preview limit"));
}

#[test]
fn max_preview_bytes_is_twenty_mebibytes() {
    assert_eq!(MAX_PREVIEW_BYTES, 20 * 1024 * 1024);
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
    assert_eq!(
        (
            entry(&status, "README.md").map(|e| e.index),
            entry(&status, "new.txt").map(|e| e.index),
        ),
        (
            Some(Some(ChangeKind::Modified)),
            Some(Some(ChangeKind::Added))
        )
    );
}

#[test]
fn unstage_all_inner_clears_index() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    stage_all_inner(&reg, id).unwrap();

    unstage_all_inner(&reg, id).unwrap();

    let status = get_status_inner(&reg, id).unwrap();
    assert_eq!(
        entry(&status, "README.md").map(|e| (e.index, e.worktree)),
        Some((None, Some(ChangeKind::Modified)))
    );
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
            get_file_diff_inner(&reg, 999, "README.md", DiffScope::Unstaged, false, None)
                .map(|_| ()),
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

// Edge cases (coverage audit): whitespace option, other hunk actions, error kinds.
fn indent_readme(path: &Path) {
    std::fs::write(path.join("README.md"), "  # fixture\n").expect("indent README");
}

#[test]
fn get_file_diff_inner_ignore_whitespace_false_shows_indent_change() {
    let (_dir, path, reg, id) = open_fixture();
    indent_readme(&path);

    let diff =
        get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false, None).unwrap();

    assert_eq!(diff.hunks.len(), 1);
}

#[test]
fn get_file_diff_inner_ignore_whitespace_true_hides_indent_change() {
    let (_dir, path, reg, id) = open_fixture();
    indent_readme(&path);

    let err = get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, true, None)
        .expect_err("indent-only change is invisible when whitespace is ignored");

    assert_eq!(err.kind, AppErrorKind::NoChanges);
}

#[test]
fn get_file_diff_inner_staged_scope_shows_staged_change() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    stage_paths_inner(&reg, id, &paths(&["README.md"])).unwrap();

    let staged =
        get_file_diff_inner(&reg, id, "README.md", DiffScope::Staged, false, None).unwrap();
    let unstaged = get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false, None)
        .expect_err("everything is staged, nothing left unstaged");

    assert_eq!(
        (staged.hunks.len(), unstaged.kind),
        (1, AppErrorKind::NoChanges)
    );
}

#[test]
fn apply_hunk_inner_unstage_clears_staged_hunk() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    stage_all_inner(&reg, id).unwrap();
    let selection = HunkSelection {
        hunk_index: 0,
        lines: None,
    };

    apply_hunk_inner(&reg, id, "README.md", HunkAction::Unstage, &selection).unwrap();

    let status = get_status_inner(&reg, id).unwrap();
    assert_eq!(
        entry(&status, "README.md").map(|e| (e.index, e.worktree)),
        Some((None, Some(ChangeKind::Modified)))
    );
}

#[test]
fn apply_hunk_inner_discard_restores_worktree_and_keeps_index_untouched() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    let selection = HunkSelection {
        hunk_index: 0,
        lines: None,
    };

    apply_hunk_inner(&reg, id, "README.md", HunkAction::Discard, &selection).unwrap();

    let content = std::fs::read_to_string(path.join("README.md")).unwrap();
    let status = get_status_inner(&reg, id).unwrap();
    assert_eq!(
        (content.as_str(), entry(&status, "README.md").is_none()),
        ("# fixture\n", true)
    );
}

#[test]
fn apply_hunk_inner_unstage_bad_selection_errors() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    stage_all_inner(&reg, id).unwrap();
    let selection = HunkSelection {
        hunk_index: 99,
        lines: None,
    };

    let err = apply_hunk_inner(&reg, id, "README.md", HunkAction::Unstage, &selection)
        .expect_err("hunk 99 does not exist");

    assert_eq!(err.kind, AppErrorKind::BadSelection);
}

#[test]
fn discard_paths_inner_unknown_path_errors_with_path_not_found() {
    let (_dir, _path, reg, id) = open_fixture();

    let err = discard_paths_inner(&reg, id, &paths(&["ghost.txt"]))
        .expect_err("ghost.txt is neither tracked nor on disk");

    assert_eq!(err.kind, AppErrorKind::PathNotFound);
}

#[test]
fn discard_paths_inner_deletes_untracked_file() {
    let (_dir, path, reg, id) = open_fixture();
    std::fs::write(path.join("scratch.txt"), "x").unwrap();

    discard_paths_inner(&reg, id, &paths(&["scratch.txt"])).unwrap();

    assert!(!path.join("scratch.txt").exists());
}

#[test]
fn unstage_paths_inner_control_whitespace_path_is_bad_selection() {
    let (_dir, _path, reg, id) = open_fixture();

    let err = unstage_paths_inner(&reg, id, &paths(&["a\nb"]))
        .expect_err("control whitespace cannot be a literal pathspec");

    assert_eq!(err.kind, AppErrorKind::BadSelection);
}

#[test]
fn stage_paths_inner_error_leaves_registry_session_usable() {
    let (_dir, path, reg, id) = open_fixture();
    let _ = discard_paths_inner(&reg, id, &paths(&["ghost.txt"]));
    std::fs::write(path.join("new.txt"), "hi").unwrap();

    let status = get_status_inner(&reg, id).unwrap();

    assert!(entry(&status, "new.txt").is_some());
}

#[test]
fn get_status_inner_recovers_from_poisoned_session_lock() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    let session = reg.get(id).unwrap();
    let _ = std::thread::spawn(move || {
        let _guard = session.lock().unwrap();
        panic!("poison the session lock");
    })
    .join();

    let status = get_status_inner(&reg, id).expect("poison must be recovered");

    assert!(entry(&status, "README.md").is_some());
}

#[test]
fn stage_all_inner_then_unstage_all_inner_round_trips_to_unstaged() {
    let (_dir, path, reg, id) = open_fixture();
    std::fs::write(path.join("new.txt"), "hi").unwrap();

    stage_all_inner(&reg, id).unwrap();
    let staged = get_status_inner(&reg, id).unwrap();
    unstage_all_inner(&reg, id).unwrap();
    let unstaged = get_status_inner(&reg, id).unwrap();

    assert_eq!(
        (
            entry(&staged, "new.txt").map(|e| e.index),
            entry(&unstaged, "new.txt").map(|e| (e.index, e.worktree)),
        ),
        (
            Some(Some(ChangeKind::Added)),
            Some((None, Some(ChangeKind::Untracked)))
        )
    );
}

// GR-9: the diff command accepts a commit scope.
fn head_hex(path: &Path) -> String {
    git2::Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
        .to_string()
}

#[test]
fn get_file_diff_inner_with_commit_scope_returns_the_commit_diff() {
    let (_dir, path, reg, id) = open_fixture();
    let scope = DiffScope::Commit(head_hex(&path));

    let diff = get_file_diff_inner(&reg, id, "README.md", scope.clone(), false, None).unwrap();

    assert_eq!(
        (diff.change, diff.scope, diff.hunks.len()),
        (Some(ChangeKind::Added), scope, 1)
    );
}

#[test]
fn get_file_diff_inner_with_commit_scope_for_an_untouched_path_maps_to_no_changes() {
    let (_dir, path, reg, id) = open_fixture();
    let scope = DiffScope::Commit(head_hex(&path));

    let err = get_file_diff_inner(&reg, id, "other.txt", scope, false, None).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::NoChanges);
}

#[test]
fn get_file_diff_inner_with_an_unknown_commit_maps_to_commit_not_found() {
    let (_dir, _path, reg, id) = open_fixture();
    let scope = DiffScope::Commit("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into());

    let err = get_file_diff_inner(&reg, id, "README.md", scope, false, None).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

#[test]
fn get_file_content_inner_with_commit_scope_reads_the_commit_blob() {
    let (_dir, path, reg, id) = open_fixture();
    let scope = DiffScope::Commit(head_hex(&path));

    let bytes = get_file_content_inner(
        &reg,
        id,
        "README.md",
        scope,
        DiffSide::New,
        MAX_PREVIEW_BYTES,
    )
    .unwrap();

    assert_eq!(bytes, b"# fixture\n");
}

#[test]
fn diff_scope_deserializes_the_tagged_commit_payload() {
    let scope: DiffScope = serde_json::from_str(r#"{"commit":"abc"}"#).unwrap();

    assert_eq!(scope, DiffScope::Commit("abc".into()));
}

#[test]
fn diff_scope_deserializes_the_plain_string_payloads() {
    let scope: DiffScope = serde_json::from_str(r#""staged""#).unwrap();

    assert_eq!(scope, DiffScope::Staged);
}

#[test]
fn diff_scope_rejects_an_unknown_tagged_payload() {
    let result = serde_json::from_str::<DiffScope>(r#"{"branch":"abc"}"#);

    assert!(result.is_err());
}

// GR-9 coverage audit: the tagged scope payload drives the commands end to end.
#[test]
fn get_file_content_inner_accepts_a_scope_decoded_from_the_ipc_payload() {
    let (_dir, path, reg, id) = open_fixture();
    let payload = format!(r#"{{"commit":"{}"}}"#, head_hex(&path));
    let scope: DiffScope = serde_json::from_str(&payload).unwrap();

    let bytes = get_file_content_inner(
        &reg,
        id,
        "README.md",
        scope,
        DiffSide::New,
        MAX_PREVIEW_BYTES,
    )
    .unwrap();

    assert_eq!(bytes, b"# fixture\n");
}

#[test]
fn get_file_content_inner_with_commit_scope_old_side_on_a_root_maps_to_path_not_found() {
    let (_dir, path, reg, id) = open_fixture();
    let scope = DiffScope::Commit(head_hex(&path));

    let err = get_file_content_inner(
        &reg,
        id,
        "README.md",
        scope,
        DiffSide::Old,
        MAX_PREVIEW_BYTES,
    )
    .unwrap_err();

    assert_eq!(err.kind, AppErrorKind::PathNotFound);
}

#[test]
fn get_file_content_inner_with_an_unknown_commit_maps_to_commit_not_found() {
    let (_dir, _path, reg, id) = open_fixture();
    let scope = DiffScope::Commit("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into());

    let err = get_file_content_inner(
        &reg,
        id,
        "README.md",
        scope,
        DiffSide::New,
        MAX_PREVIEW_BYTES,
    )
    .unwrap_err();

    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

#[test]
fn get_file_content_inner_with_commit_scope_over_the_limit_maps_to_too_large() {
    let (_dir, path, reg, id) = open_fixture();
    let scope = DiffScope::Commit(head_hex(&path));

    let err = get_file_content_inner(&reg, id, "README.md", scope, DiffSide::New, 3).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::TooLarge);
}

#[test]
fn get_file_diff_inner_with_commit_scope_echoes_the_scope_as_tagged_json() {
    let (_dir, path, reg, id) = open_fixture();
    let hex = head_hex(&path);

    let diff = get_file_diff_inner(
        &reg,
        id,
        "README.md",
        DiffScope::Commit(hex.clone()),
        false,
        None,
    )
    .unwrap();

    assert_eq!(
        serde_json::to_value(&diff.scope).unwrap(),
        serde_json::json!({ "commit": hex })
    );
}
