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
