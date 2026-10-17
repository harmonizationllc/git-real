mod common;

use git_real_core::diff::build_patch;
use git_real_core::{
    ChangeKind, DiffLineKind, DiffOptions, DiffScope, GitError, HunkAction, HunkSelection,
    RepoSession, StatusEntry, WorkingTreeStatus,
};

const BASE: &str = "a\nb\nc\nd\ne\n";
const BOTH_EDITED: &str = "a\nB\nc\nD\ne\n";

fn session(path: &std::path::Path) -> RepoSession {
    RepoSession::open(path).expect("open")
}

fn whole() -> HunkSelection {
    HunkSelection {
        hunk_index: 0,
        lines: None,
    }
}

fn picked(indices: &[usize]) -> HunkSelection {
    HunkSelection {
        hunk_index: 0,
        lines: Some(indices.to_vec()),
    }
}

fn status_entry(status: &WorkingTreeStatus, path: &str) -> StatusEntry {
    status
        .entries
        .iter()
        .find(|e| e.path == path)
        .cloned()
        .unwrap_or_else(|| panic!("no entry for {path}: {:?}", status.entries))
}

/// Commits `f.txt` = "a..e" then edits lines b and d in the worktree.
/// Hunk 0 is `[a, -b, +B, c, -d, +D, e]`: indices 1/2 are one edit, 4/5 the other.
fn repo_with_two_edits() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", BASE);
    common::commit_all(&path, "add f");
    common::write_file(&path, "f.txt", BOTH_EDITED);
    (dir, path)
}

/// `(kind, content)` of every changed line in the diff of `f.txt` in `scope`.
fn changed(path: &std::path::Path, scope: DiffScope) -> Vec<(DiffLineKind, String)> {
    session(path)
        .file_diff("f.txt", scope, DiffOptions::default())
        .expect("diff")
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .filter(|l| l.kind != DiffLineKind::Context)
        .map(|l| (l.kind, l.content.clone()))
        .collect()
}

fn read(path: &std::path::Path, rel: &str) -> String {
    std::fs::read_to_string(path.join(rel)).expect("read file")
}

// --- stage ---

#[test]
fn apply_hunk_stage_whole_hunk() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    session(&path)
        .apply_hunk("README.md", HunkAction::Stage, &whole())
        .expect("stage hunk");
    let entry = status_entry(&session(&path).status().expect("status"), "README.md");
    assert_eq!(
        (entry.index, entry.worktree),
        (Some(ChangeKind::Modified), None)
    );
}

#[test]
fn apply_hunk_stage_lines_stages_only_the_selected_lines() {
    let (_dir, path) = repo_with_two_edits();
    session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &picked(&[1, 2]))
        .expect("stage lines");
    assert_eq!(
        changed(&path, DiffScope::Staged),
        vec![
            (DiffLineKind::Deletion, "b".to_owned()),
            (DiffLineKind::Addition, "B".to_owned()),
        ]
    );
}

#[test]
fn apply_hunk_stage_lines_leaves_worktree_untouched() {
    let (_dir, path) = repo_with_two_edits();
    session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &picked(&[1, 2]))
        .expect("stage lines");
    assert_eq!(read(&path, "f.txt"), BOTH_EDITED);
}

#[test]
fn apply_hunk_stage_lines_leaves_the_other_edit_unstaged() {
    let (_dir, path) = repo_with_two_edits();
    session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &picked(&[1, 2]))
        .expect("stage lines");
    assert_eq!(
        changed(&path, DiffScope::Unstaged),
        vec![
            (DiffLineKind::Deletion, "d".to_owned()),
            (DiffLineKind::Addition, "D".to_owned()),
        ]
    );
}

#[test]
fn apply_hunk_stage_untracked_file_whole() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "one\ntwo\n");
    session(&path)
        .apply_hunk("new.txt", HunkAction::Stage, &whole())
        .expect("stage untracked");
    let entry = status_entry(&session(&path).status().expect("status"), "new.txt");
    assert_eq!(entry.index, Some(ChangeKind::Added));
}

// --- unstage ---

#[test]
fn apply_hunk_unstage_whole_hunk() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    common::stage(&path, "README.md");
    session(&path)
        .apply_hunk("README.md", HunkAction::Unstage, &whole())
        .expect("unstage hunk");
    let entry = status_entry(&session(&path).status().expect("status"), "README.md");
    assert_eq!(
        (entry.index, entry.worktree),
        (None, Some(ChangeKind::Modified))
    );
}

#[test]
fn apply_hunk_unstage_lines_keeps_the_unselected_edit_staged() {
    let (_dir, path) = repo_with_two_edits();
    common::stage(&path, "f.txt");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Unstage, &picked(&[1, 2]))
        .expect("unstage lines");
    assert_eq!(
        changed(&path, DiffScope::Staged),
        vec![
            (DiffLineKind::Deletion, "d".to_owned()),
            (DiffLineKind::Addition, "D".to_owned()),
        ]
    );
}

#[test]
fn apply_hunk_unstage_lines_leaves_worktree_untouched() {
    let (_dir, path) = repo_with_two_edits();
    common::stage(&path, "f.txt");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Unstage, &picked(&[1, 2]))
        .expect("unstage lines");
    assert_eq!(read(&path, "f.txt"), BOTH_EDITED);
}

// --- discard ---

#[test]
fn apply_hunk_discard_hunk_restores_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    session(&path)
        .apply_hunk("README.md", HunkAction::Discard, &whole())
        .expect("discard hunk");
    assert_eq!(read(&path, "README.md"), "# fixture\n");
}

#[test]
fn apply_hunk_discard_hunk_leaves_status_clean() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    session(&path)
        .apply_hunk("README.md", HunkAction::Discard, &whole())
        .expect("discard hunk");
    assert!(session(&path).status().expect("status").entries.is_empty());
}

#[test]
fn apply_hunk_discard_lines_partial() {
    let (_dir, path) = repo_with_two_edits();
    session(&path)
        .apply_hunk("f.txt", HunkAction::Discard, &picked(&[1, 2]))
        .expect("discard lines");
    assert_eq!(read(&path, "f.txt"), "a\nb\nc\nD\ne\n");
}

#[test]
fn apply_hunk_discard_does_not_touch_the_index() {
    let (_dir, path) = repo_with_two_edits();
    session(&path)
        .apply_hunk("f.txt", HunkAction::Discard, &picked(&[1, 2]))
        .expect("discard lines");
    let entry = status_entry(&session(&path).status().expect("status"), "f.txt");
    assert_eq!(
        (entry.index, entry.worktree),
        (None, Some(ChangeKind::Modified))
    );
}

// --- invalid selections ---

#[test]
fn apply_hunk_bad_hunk_index_errors() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    let selection = HunkSelection {
        hunk_index: 5,
        lines: None,
    };
    let err = session(&path)
        .apply_hunk("README.md", HunkAction::Stage, &selection)
        .expect_err("bad hunk index");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[test]
fn apply_hunk_context_line_selection_errors() {
    let (_dir, path) = repo_with_two_edits();
    let err = session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &picked(&[0]))
        .expect_err("context line");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[test]
fn apply_hunk_empty_line_selection_errors() {
    let (_dir, path) = repo_with_two_edits();
    let err = session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &picked(&[]))
        .expect_err("empty selection");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[test]
fn apply_hunk_bad_selection_leaves_worktree_and_index_unchanged() {
    let (_dir, path) = repo_with_two_edits();
    let before = session(&path).status().expect("status");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &picked(&[0]))
        .expect_err("context line");
    assert_eq!(session(&path).status().expect("status"), before);
}

#[test]
fn apply_hunk_unchanged_file_errors_with_no_changes() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .apply_hunk("README.md", HunkAction::Stage, &whole())
        .expect_err("nothing to stage");
    assert!(matches!(err, GitError::NoChanges(_)), "got {err:?}");
}

#[test]
fn apply_hunk_unstage_with_nothing_staged_errors_with_no_changes() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    let err = session(&path)
        .apply_hunk("README.md", HunkAction::Unstage, &whole())
        .expect_err("nothing staged");
    assert!(matches!(err, GitError::NoChanges(_)), "got {err:?}");
}

// --- stale patches ---

// A patch whose context no longer matches must fail without touching the index.
const STALE_PATCH: &str = "diff --git a/README.md b/README.md\nindex 0000000..0000000 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n # something else\n+second\n";

fn index_blob(path: &std::path::Path, rel: &str) -> Option<Vec<u8>> {
    let repo = git2::Repository::open(path).expect("open repo");
    let index = repo.index().expect("index");
    let entry = index.get_path(std::path::Path::new(rel), 0)?;
    Some(repo.find_blob(entry.id).expect("blob").content().to_vec())
}

/// Builds a patch from a real diff, then makes the index disagree with it.
fn stale_patch_from_real_diff(path: &std::path::Path) -> String {
    common::write_file(path, "README.md", "# fixture\nsecond\n");
    let diff = session(path)
        .file_diff("README.md", DiffScope::Unstaged, DiffOptions::default())
        .expect("diff");
    common::write_file(path, "README.md", "# changed\n");
    common::stage(path, "README.md");
    common::write_file(path, "README.md", "# changed\nsecond\n");
    build_patch(&diff, &whole(), false, 0o100644).expect("patch")
}

#[test]
fn apply_hunk_stale_patch_fails_cleanly() {
    let (_dir, path) = common::temp_repo_with_commit();
    let text = stale_patch_from_real_diff(&path);
    let err = session(&path)
        .apply_patch_text(&text, HunkAction::Stage)
        .expect_err("stale patch");
    assert!(
        matches!(&err, GitError::ApplyFailed(m) if m.contains("did not apply")),
        "got {err:?}"
    );
}

#[test]
fn apply_hunk_stale_patch_leaves_index_blob_unchanged() {
    let (_dir, path) = common::temp_repo_with_commit();
    let text = stale_patch_from_real_diff(&path);
    session(&path)
        .apply_patch_text(&text, HunkAction::Stage)
        .expect_err("stale patch");
    assert_eq!(
        index_blob(&path, "README.md"),
        Some(b"# changed\n".to_vec())
    );
}

#[test]
fn apply_patch_text_hand_written_stale_patch_fails() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .apply_patch_text(STALE_PATCH, HunkAction::Stage)
        .expect_err("stale patch");
    assert!(matches!(err, GitError::ApplyFailed(_)), "got {err:?}");
}

#[test]
fn apply_patch_text_stale_patch_leaves_status_unchanged() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nlocal\n");
    let before = session(&path).status().expect("status");
    session(&path)
        .apply_patch_text(STALE_PATCH, HunkAction::Stage)
        .expect_err("stale patch");
    assert_eq!(session(&path).status().expect("status"), before);
}

#[test]
fn apply_patch_text_stale_discard_leaves_worktree_file_unchanged() {
    let (_dir, path) = common::temp_repo_with_commit();
    session(&path)
        .apply_patch_text(STALE_PATCH, HunkAction::Discard)
        .expect_err("stale patch");
    assert_eq!(read(&path, "README.md"), "# fixture\n");
}

#[test]
fn apply_patch_text_garbage_text_fails_with_apply_failed() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .apply_patch_text("not a patch at all\n", HunkAction::Stage)
        .expect_err("garbage");
    assert!(matches!(err, GitError::ApplyFailed(_)), "got {err:?}");
}

// --- multi-hunk, rename, mode, line endings, added files ---

fn twenty_lines() -> String {
    (1..=20).map(|n| format!("l{n}\n")).collect()
}

fn repo_with_two_distant_edits() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", &twenty_lines());
    common::commit_all(&path, "add f");
    let edited = twenty_lines()
        .replace("l2\n", "L2\n")
        .replace("l18\n", "L18\n");
    common::write_file(&path, "f.txt", &edited);
    (dir, path)
}

#[test]
fn apply_hunk_stage_second_hunk_alone() {
    let (_dir, path) = repo_with_two_distant_edits();
    let selection = HunkSelection {
        hunk_index: 1,
        lines: None,
    };
    session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &selection)
        .expect("stage second hunk");
    assert_eq!(
        changed(&path, DiffScope::Staged),
        vec![
            (DiffLineKind::Deletion, "l18".to_owned()),
            (DiffLineKind::Addition, "L18".to_owned()),
        ]
    );
}

#[test]
fn apply_hunk_unstage_renamed_file_keeps_rename() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "a\nb\nc\nd\ne\n");
    common::commit_all(&path, "five lines");
    std::fs::remove_file(path.join("README.md")).expect("remove");
    common::write_file(&path, "DOC.md", "a\nb\nc\nd\nE\n");
    common::stage(&path, "README.md");
    common::stage(&path, "DOC.md");
    session(&path)
        .apply_hunk("DOC.md", HunkAction::Unstage, &whole())
        .expect("unstage hunk of renamed file");
    assert_eq!(
        (index_blob(&path, "DOC.md"), index_blob(&path, "README.md")),
        (Some(b"a\nb\nc\nd\ne\n".to_vec()), None)
    );
}

#[cfg(unix)]
#[test]
fn apply_hunk_stage_preserves_executable_index_mode() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "run.sh", &twenty_lines());
    std::fs::set_permissions(path.join("run.sh"), std::fs::Permissions::from_mode(0o755))
        .expect("chmod");
    common::commit_all(&path, "add script");
    let edited = twenty_lines()
        .replace("l2\n", "L2\n")
        .replace("l18\n", "L18\n");
    common::write_file(&path, "run.sh", &edited);
    session(&path)
        .apply_hunk("run.sh", HunkAction::Stage, &whole())
        .expect("stage hunk");
    let repo = git2::Repository::open(&path).expect("open");
    let mode = repo
        .index()
        .expect("index")
        .get_path(std::path::Path::new("run.sh"), 0)
        .expect("entry")
        .mode;
    assert_eq!(mode, 0o100755);
}

#[cfg(unix)]
#[test]
fn apply_hunk_discard_preserves_executable_disk_mode() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "run.sh", &twenty_lines());
    std::fs::set_permissions(path.join("run.sh"), std::fs::Permissions::from_mode(0o755))
        .expect("chmod");
    common::commit_all(&path, "add script");
    let edited = twenty_lines()
        .replace("l2\n", "L2\n")
        .replace("l18\n", "L18\n");
    common::write_file(&path, "run.sh", &edited);
    session(&path)
        .apply_hunk("run.sh", HunkAction::Stage, &whole())
        .expect("stage hunk");
    session(&path)
        .apply_hunk("run.sh", HunkAction::Discard, &whole())
        .expect("discard hunk");
    let disk_mode = std::fs::metadata(path.join("run.sh"))
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(disk_mode, 0o755);
}

#[test]
fn apply_hunk_crlf_file_stage_whole_hunk_keeps_line_endings() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "a\r\nb\r\n");
    common::commit_all(&path, "crlf");
    common::write_file(&path, "README.md", "a\r\nb\r\nc\r\n");
    session(&path)
        .apply_hunk("README.md", HunkAction::Stage, &whole())
        .expect("stage hunk");
    assert_eq!(
        index_blob(&path, "README.md"),
        Some(b"a\r\nb\r\nc\r\n".to_vec())
    );
}

#[test]
fn apply_hunk_unstage_added_file_removes_it_from_index() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "one\ntwo\n");
    common::stage(&path, "new.txt");
    session(&path)
        .apply_hunk("new.txt", HunkAction::Unstage, &whole())
        .expect("unstage added file");
    assert_eq!(index_blob(&path, "new.txt"), None);
}

#[test]
fn apply_hunk_unstage_added_file_keeps_it_on_disk() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "one\ntwo\n");
    common::stage(&path, "new.txt");
    session(&path)
        .apply_hunk("new.txt", HunkAction::Unstage, &whole())
        .expect("unstage added file");
    assert_eq!(read(&path, "new.txt"), "one\ntwo\n");
}

#[test]
fn apply_hunk_stage_untracked_file_with_line_selection_stages_only_those_lines() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "one\ntwo\n");
    session(&path)
        .apply_hunk("new.txt", HunkAction::Stage, &picked(&[0]))
        .expect("stage first line");
    assert_eq!(index_blob(&path, "new.txt"), Some(b"one\n".to_vec()));
}

#[test]
fn apply_hunk_untracked_whole_stage_with_bad_hunk_index_errors() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "one\n");
    let selection = HunkSelection {
        hunk_index: 1,
        lines: None,
    };
    let err = session(&path)
        .apply_hunk("new.txt", HunkAction::Stage, &selection)
        .expect_err("bad hunk index");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

// --- coverage audit: untracked, deleted, reverse, subdirectory and odd inputs ---

fn exists(path: &std::path::Path, rel: &str) -> bool {
    path.join(rel).symlink_metadata().is_ok()
}

fn hand_diff(
    change: ChangeKind,
    lines: Vec<git_real_core::DiffLine>,
    old_start: u32,
    new_start: u32,
) -> git_real_core::FileDiff {
    let count = |skip: DiffLineKind| lines.iter().filter(|l| l.kind != skip).count() as u32;
    git_real_core::FileDiff {
        path: "f.txt".into(),
        old_path: None,
        scope: DiffScope::Unstaged,
        change: Some(change),
        is_binary: false,
        hunks: vec![git_real_core::Hunk {
            old_start,
            old_lines: count(DiffLineKind::Addition),
            new_start,
            new_lines: count(DiffLineKind::Deletion),
            header: String::new(),
            lines,
        }],
        truncated: false,
    }
}

fn line(kind: DiffLineKind, content: &str, flagged: bool) -> git_real_core::DiffLine {
    git_real_core::DiffLine {
        kind,
        old_lineno: None,
        new_lineno: None,
        content: content.into(),
        no_newline_at_eof: flagged,
    }
}

#[test]
fn apply_hunk_discard_untracked_file_whole_deletes_it_from_disk() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "one\ntwo\n");
    session(&path)
        .apply_hunk("new.txt", HunkAction::Discard, &whole())
        .expect("discard untracked");
    assert!(!exists(&path, "new.txt"));
}

#[test]
fn apply_hunk_discard_untracked_file_with_line_selection_keeps_unselected_lines() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "one\ntwo\nthree\n");
    session(&path)
        .apply_hunk("new.txt", HunkAction::Discard, &picked(&[0]))
        .expect("discard first line");
    assert_eq!(read(&path, "new.txt"), "two\nthree\n");
}

#[test]
fn apply_hunk_stage_empty_untracked_file_whole_adds_it() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "empty.txt", "");
    session(&path)
        .apply_hunk("empty.txt", HunkAction::Stage, &whole())
        .expect("stage empty file");
    assert_eq!(index_blob(&path, "empty.txt"), Some(Vec::new()));
}

#[test]
fn apply_hunk_stage_untracked_file_in_subdirectory_whole() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "sub/dir/new.txt", "one\n");
    session(&path)
        .apply_hunk("sub/dir/new.txt", HunkAction::Stage, &whole())
        .expect("stage nested untracked");
    assert_eq!(
        index_blob(&path, "sub/dir/new.txt"),
        Some(b"one\n".to_vec())
    );
}

#[test]
fn apply_hunk_stage_whole_binary_untracked_file_adds_it() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::write(path.join("blob.bin"), b"\x00\x01\x02\xff").expect("write");
    session(&path)
        .apply_hunk("blob.bin", HunkAction::Stage, &whole())
        .expect("stage binary");
    assert_eq!(
        index_blob(&path, "blob.bin"),
        Some(b"\x00\x01\x02\xff".to_vec())
    );
}

#[test]
fn apply_hunk_hunk_of_modified_binary_file_is_bad_selection() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::write(path.join("blob.bin"), b"\x00\x01").expect("write");
    common::commit_all(&path, "binary");
    std::fs::write(path.join("blob.bin"), b"\x00\x02").expect("write");
    let err = session(&path)
        .apply_hunk("blob.bin", HunkAction::Stage, &whole())
        .expect_err("binary has no hunks");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[test]
fn apply_hunk_non_utf8_tracked_file_fails_with_apply_failed_and_changes_nothing() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::write(path.join("l1.txt"), b"caf\xe9\n").expect("write");
    common::commit_all(&path, "latin1");
    std::fs::write(path.join("l1.txt"), b"caf\xe9\nmore\n").expect("write");
    let before = session(&path).status().expect("status");
    let err = session(&path)
        .apply_hunk("l1.txt", HunkAction::Stage, &whole())
        .expect_err("not utf-8");
    assert!(
        matches!(&err, GitError::ApplyFailed(m) if m.contains("not UTF-8")),
        "got {err:?}"
    );
    assert_eq!(session(&path).status().expect("status"), before);
}

#[test]
fn apply_hunk_stage_conflicted_file_is_rejected() {
    let (_dir, path) = common::temp_repo_with_conflict();
    let result = session(&path).apply_hunk("README.md", HunkAction::Stage, &whole());
    assert!(result.is_err(), "conflicted file must not be patched");
}

#[cfg(unix)]
#[test]
fn apply_hunk_type_change_is_bad_selection() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).expect("remove");
    std::os::unix::fs::symlink("elsewhere", path.join("README.md")).expect("symlink");
    let err = session(&path)
        .apply_hunk("README.md", HunkAction::Stage, &whole())
        .expect_err("type change");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[test]
fn apply_hunk_unstage_staged_deletion_restores_index_entry() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", BASE);
    common::commit_all(&path, "add f");
    std::fs::remove_file(path.join("f.txt")).expect("remove");
    common::stage(&path, "f.txt");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Unstage, &whole())
        .expect("unstage deletion");
    assert_eq!(index_blob(&path, "f.txt"), Some(BASE.as_bytes().to_vec()));
    assert!(!exists(&path, "f.txt"), "unstage must not touch the disk");
}

#[test]
fn apply_hunk_unstage_lines_of_staged_deletion_restores_only_selected_lines() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", BASE);
    common::commit_all(&path, "add f");
    std::fs::remove_file(path.join("f.txt")).expect("remove");
    common::stage(&path, "f.txt");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Unstage, &picked(&[0, 1]))
        .expect("unstage two deleted lines");
    assert_eq!(index_blob(&path, "f.txt"), Some(b"a\nb\n".to_vec()));
}

#[test]
fn apply_hunk_discard_unstaged_deletion_restores_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", BASE);
    common::commit_all(&path, "add f");
    std::fs::remove_file(path.join("f.txt")).expect("remove");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Discard, &whole())
        .expect("discard deletion");
    assert_eq!(read(&path, "f.txt"), BASE);
}

#[test]
fn apply_hunk_discard_lines_of_unstaged_deletion_restores_only_selected_lines() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", BASE);
    common::commit_all(&path, "add f");
    std::fs::remove_file(path.join("f.txt")).expect("remove");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Discard, &picked(&[0, 4]))
        .expect("discard two deleted lines");
    assert_eq!(read(&path, "f.txt"), "a\ne\n");
}

#[test]
fn apply_hunk_stage_lines_of_unstaged_deletion_removes_only_selected_lines() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", BASE);
    common::commit_all(&path, "add f");
    std::fs::remove_file(path.join("f.txt")).expect("remove");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &picked(&[0]))
        .expect("stage one deleted line");
    assert_eq!(index_blob(&path, "f.txt"), Some(b"b\nc\nd\ne\n".to_vec()));
}

#[test]
fn apply_hunk_stage_whole_unstaged_deletion_removes_index_entry() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", BASE);
    common::commit_all(&path, "add f");
    std::fs::remove_file(path.join("f.txt")).expect("remove");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &whole())
        .expect("stage deletion");
    assert_eq!(index_blob(&path, "f.txt"), None);
}

#[test]
fn apply_hunk_unstage_lines_of_added_file_keeps_unselected_lines_staged() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "one\ntwo\nthree\n");
    common::stage(&path, "new.txt");
    session(&path)
        .apply_hunk("new.txt", HunkAction::Unstage, &picked(&[0]))
        .expect("unstage first line");
    assert_eq!(index_blob(&path, "new.txt"), Some(b"two\nthree\n".to_vec()));
}

#[test]
fn apply_hunk_discard_second_hunk_alone_keeps_first_edit() {
    let (_dir, path) = repo_with_two_distant_edits();
    let selection = HunkSelection {
        hunk_index: 1,
        lines: None,
    };
    session(&path)
        .apply_hunk("f.txt", HunkAction::Discard, &selection)
        .expect("discard second hunk");
    assert_eq!(read(&path, "f.txt"), twenty_lines().replace("l2\n", "L2\n"));
}

#[test]
fn apply_hunk_unstage_second_hunk_alone_keeps_first_edit_staged() {
    let (_dir, path) = repo_with_two_distant_edits();
    common::stage(&path, "f.txt");
    let selection = HunkSelection {
        hunk_index: 1,
        lines: None,
    };
    session(&path)
        .apply_hunk("f.txt", HunkAction::Unstage, &selection)
        .expect("unstage second hunk");
    assert_eq!(
        changed(&path, DiffScope::Staged),
        vec![
            (DiffLineKind::Deletion, "l2".to_owned()),
            (DiffLineKind::Addition, "L2".to_owned()),
        ]
    );
}

#[test]
fn apply_hunk_stage_lines_in_subdirectory_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "src/deep/f.txt", BASE);
    common::commit_all(&path, "add nested");
    common::write_file(&path, "src/deep/f.txt", BOTH_EDITED);
    session(&path)
        .apply_hunk("src/deep/f.txt", HunkAction::Stage, &picked(&[4, 5]))
        .expect("stage nested lines");
    assert_eq!(
        index_blob(&path, "src/deep/f.txt"),
        Some(b"a\nb\nc\nD\ne\n".to_vec())
    );
}

#[test]
fn apply_hunk_discard_lines_in_subdirectory_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "src/deep/f.txt", BASE);
    common::commit_all(&path, "add nested");
    common::write_file(&path, "src/deep/f.txt", BOTH_EDITED);
    session(&path)
        .apply_hunk("src/deep/f.txt", HunkAction::Discard, &picked(&[1, 2]))
        .expect("discard nested lines");
    assert_eq!(read(&path, "src/deep/f.txt"), "a\nb\nc\nD\ne\n");
}

#[test]
fn apply_hunk_crlf_partial_discard_keeps_other_edit_and_line_endings() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", "a\r\nb\r\nc\r\nd\r\ne\r\n");
    common::commit_all(&path, "crlf");
    common::write_file(&path, "f.txt", "a\r\nB\r\nc\r\nD\r\ne\r\n");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Discard, &picked(&[1, 2]))
        .expect("discard first edit");
    assert_eq!(read(&path, "f.txt"), "a\r\nb\r\nc\r\nD\r\ne\r\n");
}

#[test]
fn apply_hunk_crlf_partial_stage_keeps_line_endings() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", "a\r\nb\r\nc\r\nd\r\ne\r\n");
    common::commit_all(&path, "crlf");
    common::write_file(&path, "f.txt", "a\r\nB\r\nc\r\nD\r\ne\r\n");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &picked(&[4, 5]))
        .expect("stage second edit");
    assert_eq!(
        index_blob(&path, "f.txt"),
        Some(b"a\r\nb\r\nc\r\nD\r\ne\r\n".to_vec())
    );
}

#[test]
fn apply_hunk_stage_whole_hunk_adding_text_after_unterminated_line_is_exact() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", "a\nb");
    common::commit_all(&path, "no eol");
    common::write_file(&path, "f.txt", "a\nb\nc");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Stage, &whole())
        .expect("stage");
    assert_eq!(index_blob(&path, "f.txt"), Some(b"a\nb\nc".to_vec()));
}

#[cfg(unix)]
#[test]
fn apply_hunk_unstage_preserves_executable_index_mode() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "run.sh", BASE);
    std::fs::set_permissions(path.join("run.sh"), std::fs::Permissions::from_mode(0o755))
        .expect("chmod");
    common::commit_all(&path, "add script");
    common::write_file(&path, "run.sh", BOTH_EDITED);
    common::stage(&path, "run.sh");
    session(&path)
        .apply_hunk("run.sh", HunkAction::Unstage, &picked(&[1, 2]))
        .expect("unstage lines");
    let repo = git2::Repository::open(&path).expect("open");
    let mode = repo
        .index()
        .expect("index")
        .get_path(std::path::Path::new("run.sh"), 0)
        .expect("entry")
        .mode;
    assert_eq!(mode, 0o100755);
}

#[cfg(unix)]
#[test]
fn apply_hunk_stage_lines_preserves_executable_index_mode() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "run.sh", BASE);
    std::fs::set_permissions(path.join("run.sh"), std::fs::Permissions::from_mode(0o755))
        .expect("chmod");
    common::commit_all(&path, "add script");
    common::write_file(&path, "run.sh", BOTH_EDITED);
    session(&path)
        .apply_hunk("run.sh", HunkAction::Stage, &picked(&[1, 2]))
        .expect("stage lines");
    let repo = git2::Repository::open(&path).expect("open");
    let mode = repo
        .index()
        .expect("index")
        .get_path(std::path::Path::new("run.sh"), 0)
        .expect("entry")
        .mode;
    assert_eq!(mode, 0o100755);
}

#[test]
fn apply_hunk_apply_failed_message_names_the_failure() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .apply_patch_text(STALE_PATCH, HunkAction::Stage)
        .expect_err("stale");
    assert!(
        matches!(&err, GitError::ApplyFailed(m) if m.contains("did not apply")),
        "got {err:?}"
    );
    assert!(err.to_string().starts_with("the patch did not apply"));
}

// --- build_patch: reverse no-newline, duplicates, delete header mode ---

#[test]
fn build_patch_reverse_flagged_pair_emits_removals_before_additions_with_markers() {
    let diff = hand_diff(
        ChangeKind::Modified,
        vec![
            line(DiffLineKind::Deletion, "x", true),
            line(DiffLineKind::Addition, "y", true),
        ],
        1,
        1,
    );
    let patch = build_patch(&diff, &whole(), true, 0o100644).expect("patch");
    assert_eq!(
        patch,
        "diff --git a/f.txt b/f.txt\nindex 0000000..0000000 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-y\n\\ No newline at end of file\n+x\n\\ No newline at end of file\n"
    );
}

#[test]
fn build_patch_reverse_flagged_context_before_restored_line_is_rewritten() {
    // Reverse, only the deletion selected: the flagged addition becomes context and
    // is followed by an emitted `+`, so it must be written as -y, marker, +y.
    let diff = hand_diff(
        ChangeKind::Modified,
        vec![
            line(DiffLineKind::Addition, "y", true),
            line(DiffLineKind::Deletion, "z", false),
        ],
        1,
        1,
    );
    let patch = build_patch(&diff, &picked(&[1]), true, 0o100644).expect("patch");
    assert_eq!(
        patch,
        "diff --git a/f.txt b/f.txt\nindex 0000000..0000000 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,2 @@\n-y\n\\ No newline at end of file\n+y\n+z\n"
    );
}

#[test]
fn build_patch_duplicate_line_indices_behave_like_a_set() {
    let diff = hand_diff(
        ChangeKind::Modified,
        vec![
            line(DiffLineKind::Deletion, "a", false),
            line(DiffLineKind::Addition, "b", false),
        ],
        1,
        1,
    );
    let once = build_patch(&diff, &picked(&[1]), false, 0o100644).expect("once");
    let twice = build_patch(&diff, &picked(&[1, 1, 1]), false, 0o100644).expect("twice");
    assert_eq!(once, twice);
}

#[test]
fn build_patch_deleted_file_header_carries_the_mode() {
    let diff = hand_diff(
        ChangeKind::Deleted,
        vec![line(DiffLineKind::Deletion, "x", false)],
        1,
        0,
    );
    let patch = build_patch(&diff, &whole(), false, 0o100755).expect("patch");
    assert!(patch.contains("deleted file mode 100755\n"), "got {patch}");
}

#[test]
fn build_patch_reverse_of_deleted_file_with_mode_uses_new_file_mode() {
    let diff = hand_diff(
        ChangeKind::Deleted,
        vec![line(DiffLineKind::Deletion, "x", false)],
        1,
        0,
    );
    let patch = build_patch(&diff, &whole(), true, 0o100755).expect("patch");
    assert!(patch.contains("new file mode 100755\n"), "got {patch}");
}

#[test]
fn build_patch_picked_index_in_later_hunk_does_not_leak_across_hunks() {
    // Indices are per hunk: index 2 is valid in hunk 0 only if hunk 0 has 3+ lines.
    let mut diff = hand_diff(
        ChangeKind::Modified,
        vec![line(DiffLineKind::Addition, "a", false)],
        1,
        1,
    );
    let second = hand_diff(
        ChangeKind::Modified,
        vec![
            line(DiffLineKind::Context, "c", false),
            line(DiffLineKind::Addition, "d", false),
            line(DiffLineKind::Addition, "e", false),
        ],
        9,
        9,
    );
    diff.hunks.extend(second.hunks);
    let selection = HunkSelection {
        hunk_index: 0,
        lines: Some(vec![2]),
    };
    let err = build_patch(&diff, &selection, false, 0o100644).expect_err("out of range");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[test]
fn build_patch_reverse_marker_only_after_last_line_of_its_side() {
    // Reverse with only the deletion picked: `+x` is followed by context `y`, so
    // the restored x ends in a newline and must carry no marker; `y` keeps its own.
    let diff = hand_diff(
        ChangeKind::Modified,
        vec![
            line(DiffLineKind::Context, "a", false),
            line(DiffLineKind::Deletion, "x", true),
            line(DiffLineKind::Addition, "y", true),
        ],
        1,
        1,
    );
    let patch = build_patch(&diff, &picked(&[1]), true, 0o100644).expect("patch");
    assert_eq!(
        patch,
        "diff --git a/f.txt b/f.txt\nindex 0000000..0000000 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,3 @@\n a\n+x\n y\n\\ No newline at end of file\n"
    );
}

#[test]
fn apply_hunk_discard_deletion_before_unterminated_line_restores_with_newline() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", "a\nx");
    common::commit_all(&path, "no eol");
    common::write_file(&path, "f.txt", "a\ny");
    // Hunk: [ a, -x(flag), +y(flag)]; discarding only the deletion restores x.
    session(&path)
        .apply_hunk("f.txt", HunkAction::Discard, &picked(&[1]))
        .expect("discard deletion only");
    assert_eq!(read(&path, "f.txt"), "a\nx\ny");
}

// --- RED: pinned bugs awaiting the developer fix ---

#[test]
fn apply_hunk_stage_whole_untracked_non_utf8_file_adds_it() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::write(path.join("latin1.txt"), b"caf\xe9\n").expect("write");
    let session = RepoSession::open(&path).expect("open");
    let whole = HunkSelection {
        hunk_index: 0,
        lines: None,
    };
    session
        .apply_hunk("latin1.txt", HunkAction::Stage, &whole)
        .expect("a whole untracked file stages regardless of encoding");
    let status = session.status().expect("status");
    let entry = status
        .entries
        .iter()
        .find(|e| e.path == "latin1.txt")
        .expect("entry");
    assert_eq!(entry.index, Some(ChangeKind::Added));
}

#[test]
fn apply_hunk_discard_whole_hunk_restores_file_without_trailing_newline() {
    // Reverse no-newline rule: -b(flag) +b +c(flag) must reverse to "a\nb" exactly.
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", "a\nb");
    common::commit_all(&path, "no eol");
    common::write_file(&path, "f.txt", "a\nb\nc");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Discard, &whole())
        .expect("discard");
    assert_eq!(read(&path, "f.txt"), "a\nb");
}

#[test]
fn apply_hunk_unstage_whole_hunk_restores_unterminated_line() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", "a\nb");
    common::commit_all(&path, "no eol");
    common::write_file(&path, "f.txt", "a\nb\nc");
    common::stage(&path, "f.txt");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Unstage, &whole())
        .expect("unstage");
    assert_eq!(index_blob(&path, "f.txt"), Some(b"a\nb".to_vec()));
}

#[test]
fn apply_hunk_discard_replaced_unterminated_line_restores_it() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "f.txt", "x");
    common::commit_all(&path, "no eol");
    common::write_file(&path, "f.txt", "y");
    session(&path)
        .apply_hunk("f.txt", HunkAction::Discard, &whole())
        .expect("discard");
    assert_eq!(read(&path, "f.txt"), "x");
}
