mod common;

use git_real_core::{
    ChangeKind, DiffLine, DiffLineKind, DiffOptions, DiffScope, FileDiff, GitError, Hunk,
    RepoSession,
};

fn diff_of(
    path: &std::path::Path,
    file: &str,
    scope: DiffScope,
    opts: DiffOptions,
) -> Result<FileDiff, GitError> {
    RepoSession::open(path)
        .expect("open")
        .file_diff(file, scope, opts)
}

fn line(
    kind: DiffLineKind,
    old: Option<u32>,
    new: Option<u32>,
    content: &str,
    no_newline_at_eof: bool,
) -> DiffLine {
    DiffLine {
        kind,
        old_lineno: old,
        new_lineno: new,
        content: content.into(),
        no_newline_at_eof,
    }
}

fn all_lines(diff: &FileDiff) -> Vec<&DiffLine> {
    diff.hunks.iter().flat_map(|h| h.lines.iter()).collect()
}

// --- default options ---

#[test]
fn diff_options_default_values() {
    let opts = DiffOptions::default();
    assert_eq!(
        (opts.ignore_whitespace, opts.context_lines, opts.max_lines),
        (false, 3, 10_000)
    );
}

// --- unstaged modifications ---

#[test]
fn diff_unstaged_modified_single_hunk() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(diff.hunks.len(), 1);
    let hunk = &diff.hunks[0];
    assert_eq!(
        (
            hunk.old_start,
            hunk.old_lines,
            hunk.new_start,
            hunk.new_lines
        ),
        (1, 1, 1, 2)
    );
    assert_eq!(
        hunk.lines,
        vec![
            line(DiffLineKind::Context, Some(1), Some(1), "# fixture", false),
            line(DiffLineKind::Addition, None, Some(2), "second", false),
        ]
    );
}

#[test]
fn diff_unstaged_modified_metadata() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(
        (
            diff.path.as_str(),
            diff.old_path.clone(),
            diff.scope,
            diff.change,
            diff.is_binary,
            diff.truncated
        ),
        (
            "README.md",
            None,
            DiffScope::Unstaged,
            Some(ChangeKind::Modified),
            false,
            false
        )
    );
}

#[test]
fn diff_hunk_header_has_range_markers() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert!(
        diff.hunks[0].header.starts_with("@@ -1 +1,2 @@"),
        "header was {:?}",
        diff.hunks[0].header
    );
}

// --- untracked files ---

#[test]
fn diff_untracked_file_shows_all_additions() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "one\ntwo\nthree\n");
    let diff = diff_of(
        &path,
        "new.txt",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(diff.change, Some(ChangeKind::Untracked));
    assert_eq!(diff.hunks.len(), 1);
    let h = &diff.hunks[0];
    assert_eq!(
        (h.old_start, h.old_lines, h.new_start, h.new_lines),
        (0, 0, 1, 3)
    );
    assert_eq!(
        diff.hunks[0].lines,
        vec![
            line(DiffLineKind::Addition, None, Some(1), "one", false),
            line(DiffLineKind::Addition, None, Some(2), "two", false),
            line(DiffLineKind::Addition, None, Some(3), "three", false),
        ]
    );
}

// --- staged scope ---

#[test]
fn diff_staged_added_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "one\ntwo\n");
    common::stage(&path, "new.txt");
    let diff = diff_of(&path, "new.txt", DiffScope::Staged, DiffOptions::default()).expect("diff");
    assert_eq!(diff.scope, DiffScope::Staged);
    assert_eq!(diff.change, Some(ChangeKind::Added));
    assert!(
        all_lines(&diff)
            .iter()
            .all(|l| l.kind == DiffLineKind::Addition)
    );
    assert_eq!(all_lines(&diff).len(), 2);
}

#[test]
fn diff_staged_modified_file_reports_modified() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    common::stage(&path, "README.md");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Staged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(diff.change, Some(ChangeKind::Modified));
}

#[test]
fn diff_staged_unborn_head_uses_empty_tree() {
    let (_dir, path) = common::temp_repo_unborn();
    common::write_file(&path, "a.txt", "hello\n");
    common::stage(&path, "a.txt");
    let diff = diff_of(&path, "a.txt", DiffScope::Staged, DiffOptions::default())
        .expect("diff against empty tree");
    assert_eq!(
        diff.hunks[0].lines,
        vec![line(DiffLineKind::Addition, None, Some(1), "hello", false)]
    );
}

#[test]
fn diff_staged_rename_has_old_path() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::rename(path.join("README.md"), path.join("DOC.md")).expect("rename");
    common::stage(&path, "README.md");
    common::stage(&path, "DOC.md");
    let diff = diff_of(&path, "DOC.md", DiffScope::Staged, DiffOptions::default()).expect("diff");
    assert_eq!(
        (diff.path.as_str(), diff.old_path.as_deref(), diff.change),
        ("DOC.md", Some("README.md"), Some(ChangeKind::Renamed))
    );
}

#[test]
fn diff_staged_rename_identical_content_has_no_hunks() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::rename(path.join("README.md"), path.join("DOC.md")).expect("rename");
    common::stage(&path, "README.md");
    common::stage(&path, "DOC.md");
    let diff = diff_of(&path, "DOC.md", DiffScope::Staged, DiffOptions::default()).expect("diff");
    assert!(diff.hunks.is_empty());
}

#[test]
fn diff_staged_scope_ignores_unstaged_edit() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    let err = diff_of(
        &path,
        "README.md",
        DiffScope::Staged,
        DiffOptions::default(),
    )
    .expect_err("nothing staged");
    assert!(matches!(err, GitError::NoChanges(_)), "got {err:?}");
}

// --- no changes / unknown paths ---

#[test]
fn diff_no_changes_in_scope_errors() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect_err("clean file");
    assert!(
        matches!(&err, GitError::NoChanges(p) if p == "README.md"),
        "got {err:?}"
    );
}

#[test]
fn diff_nonexistent_path_errors_with_no_changes() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = diff_of(
        &path,
        "missing.txt",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect_err("unknown path");
    assert!(
        matches!(&err, GitError::NoChanges(p) if p == "missing.txt"),
        "got {err:?}"
    );
}

// --- deleted files ---

#[test]
fn diff_deleted_file_all_deletions() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).expect("delete");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(diff.change, Some(ChangeKind::Deleted));
    assert_eq!(
        diff.hunks[0].lines,
        vec![line(
            DiffLineKind::Deletion,
            Some(1),
            None,
            "# fixture",
            false
        )]
    );
}

// --- binary files ---

#[test]
fn diff_binary_is_flagged() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::write(path.join("img.bin"), [0x89u8, b'P', 0, 1, 2, 0, 255]).expect("write bin");
    let diff = diff_of(
        &path,
        "img.bin",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert!(diff.is_binary);
}

#[test]
fn diff_binary_has_no_hunks() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::write(path.join("img.bin"), [0x89u8, b'P', 0, 1, 2, 0, 255]).expect("write bin");
    let diff = diff_of(
        &path,
        "img.bin",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert!(diff.hunks.is_empty());
}

#[test]
fn diff_text_file_is_not_binary() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert!(!diff.is_binary);
}

// --- line endings ---

#[test]
fn diff_no_newline_at_eof_flag() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "x");
    common::stage(&path, "a.txt");
    common::write_file(&path, "a.txt", "y\n");
    let diff = diff_of(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).expect("diff");
    assert_eq!(
        diff.hunks[0].lines,
        vec![
            line(DiffLineKind::Deletion, Some(1), None, "x", true),
            line(DiffLineKind::Addition, None, Some(1), "y", false),
        ]
    );
}

#[test]
fn diff_trailing_newline_leaves_flag_unset() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert!(all_lines(&diff).iter().all(|l| !l.no_newline_at_eof));
}

#[test]
fn diff_strips_crlf() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "crlf.txt", "a\r\nb\r\n");
    let diff = diff_of(
        &path,
        "crlf.txt",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    let contents: Vec<&str> = all_lines(&diff)
        .iter()
        .map(|l| l.content.as_str())
        .collect();
    assert_eq!(contents, vec!["a", "b"]);
}

// --- options ---

#[test]
fn diff_ignore_whitespace_hides_indent_change() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "  # fixture  \n");
    let opts = DiffOptions {
        ignore_whitespace: true,
        ..Default::default()
    };
    let err = diff_of(&path, "README.md", DiffScope::Unstaged, opts).expect_err("ignored");
    assert!(matches!(err, GitError::NoChanges(_)), "got {err:?}");
}

#[test]
fn diff_whitespace_change_shown_by_default() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "  # fixture  \n");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(diff.hunks.len(), 1);
}

fn ten_line_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    let original: String = (1..=10).map(|i| format!("l{i}\n")).collect();
    common::write_file(&path, "ten.txt", &original);
    common::commit_all(&path, "add ten");
    let edited = original.replace("l5\n", "L5\n");
    common::write_file(&path, "ten.txt", &edited);
    (dir, path)
}

fn first_hunk(diff: &FileDiff) -> &Hunk {
    diff.hunks.first().expect("one hunk")
}

#[test]
fn diff_context_lines_option_one() {
    let (_dir, path) = ten_line_fixture();
    let opts = DiffOptions {
        context_lines: 1,
        ..Default::default()
    };
    let diff = diff_of(&path, "ten.txt", DiffScope::Unstaged, opts).expect("diff");
    assert_eq!(first_hunk(&diff).old_lines, 3);
}

#[test]
fn diff_context_lines_option_one_has_four_lines() {
    let (_dir, path) = ten_line_fixture();
    let opts = DiffOptions {
        context_lines: 1,
        ..Default::default()
    };
    let diff = diff_of(&path, "ten.txt", DiffScope::Unstaged, opts).expect("diff");
    assert_eq!(first_hunk(&diff).lines.len(), 4);
}

#[test]
fn diff_context_lines_option_default_has_eight_lines() {
    let (_dir, path) = ten_line_fixture();
    let diff = diff_of(
        &path,
        "ten.txt",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(first_hunk(&diff).lines.len(), 8);
}

#[test]
fn diff_context_lines_option_default_three() {
    let (_dir, path) = ten_line_fixture();
    let diff = diff_of(
        &path,
        "ten.txt",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(first_hunk(&diff).old_lines, 7);
}

#[test]
fn diff_context_lines_zero_has_no_context() {
    let (_dir, path) = ten_line_fixture();
    let opts = DiffOptions {
        context_lines: 0,
        ..Default::default()
    };
    let diff = diff_of(&path, "ten.txt", DiffScope::Unstaged, opts).expect("diff");
    assert!(
        all_lines(&diff)
            .iter()
            .all(|l| l.kind != DiffLineKind::Context)
    );
}

// --- truncation ---

fn fifty_line_untracked() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    let text: String = (1..=50).map(|i| format!("line {i}\n")).collect();
    common::write_file(&path, "big.txt", &text);
    (dir, path)
}

#[test]
fn diff_truncates_at_max_lines() {
    let (_dir, path) = fifty_line_untracked();
    let opts = DiffOptions {
        max_lines: 10,
        ..Default::default()
    };
    let diff = diff_of(&path, "big.txt", DiffScope::Unstaged, opts).expect("diff");
    assert!(diff.truncated);
}

#[test]
fn diff_truncation_collects_exactly_max_lines() {
    let (_dir, path) = fifty_line_untracked();
    let opts = DiffOptions {
        max_lines: 10,
        ..Default::default()
    };
    let diff = diff_of(&path, "big.txt", DiffScope::Unstaged, opts).expect("diff");
    assert_eq!(all_lines(&diff).len(), 10);
}

#[test]
fn diff_not_truncated_when_under_max_lines() {
    let (_dir, path) = fifty_line_untracked();
    let diff = diff_of(
        &path,
        "big.txt",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert!(!diff.truncated);
}

#[test]
fn diff_not_truncated_when_exactly_max_lines() {
    let (_dir, path) = common::temp_repo_with_commit();
    let text: String = (1..=10).map(|i| format!("line {i}\n")).collect();
    common::write_file(&path, "ten.txt", &text);
    let opts = DiffOptions {
        max_lines: 10,
        ..Default::default()
    };
    let diff = diff_of(&path, "ten.txt", DiffScope::Unstaged, opts).expect("diff");
    assert!(!diff.truncated);
}

// --- serialization ---

#[test]
fn diff_line_serializes_camel_case() {
    let l = line(DiffLineKind::Deletion, Some(1), None, "x", true);
    let value = serde_json::to_value(&l).expect("serialize");
    assert_eq!(
        value,
        serde_json::json!({
            "kind": "deletion",
            "oldLineno": 1,
            "newLineno": null,
            "content": "x",
            "noNewlineAtEof": true
        })
    );
}

#[test]
fn diff_file_diff_serializes_camel_case() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    let value = serde_json::to_value(&diff).expect("serialize");
    let mut keys: Vec<&str> = value
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "change",
            "hunks",
            "isBinary",
            "oldPath",
            "path",
            "scope",
            "truncated"
        ]
    );
}

#[test]
fn diff_hunk_serializes_camel_case() {
    let hunk = Hunk {
        old_start: 1,
        old_lines: 2,
        new_start: 3,
        new_lines: 4,
        header: "@@".into(),
        lines: vec![],
    };
    let value = serde_json::to_value(&hunk).expect("serialize");
    assert_eq!(
        value,
        serde_json::json!({
            "oldStart": 1, "oldLines": 2, "newStart": 3, "newLines": 4,
            "header": "@@", "lines": []
        })
    );
}

#[test]
fn diff_scope_serializes_camel_case() {
    assert_eq!(
        serde_json::to_string(&DiffScope::Unstaged).expect("serialize"),
        "\"unstaged\""
    );
}

// --- architect-specified edge cases ---

#[cfg(unix)]
#[test]
fn diff_mode_only_change_is_ok_with_no_hunks() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::set_permissions(
        path.join("README.md"),
        std::fs::Permissions::from_mode(0o755),
    )
    .expect("chmod");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("mode change is a diff");
    assert!(diff.hunks.is_empty());
}

#[cfg(unix)]
#[test]
fn diff_mode_only_change_reports_modified() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::set_permissions(
        path.join("README.md"),
        std::fs::Permissions::from_mode(0o755),
    )
    .expect("chmod");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(diff.change, Some(ChangeKind::Modified));
}

#[test]
fn diff_directory_path_errors_with_no_changes() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "sub/new.txt", "hi\n");
    let err =
        diff_of(&path, "sub", DiffScope::Unstaged, DiffOptions::default()).expect_err("directory");
    assert!(
        matches!(&err, GitError::NoChanges(p) if p == "sub"),
        "got {err:?}"
    );
}

#[test]
fn diff_pathspec_glob_characters_match_literally() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "*.txt", "star\n");
    common::write_file(&path, "a.txt", "aaa\n");
    common::commit_all(&path, "add files");
    common::write_file(&path, "*.txt", "star\nmore\n");
    common::write_file(&path, "a.txt", "aaa\nmore\n");
    let diff = diff_of(&path, "*.txt", DiffScope::Unstaged, DiffOptions::default()).expect("diff");
    assert_eq!(
        (
            diff.path.as_str(),
            diff.hunks.len(),
            diff.hunks[0].lines.len()
        ),
        ("*.txt", 1, 2)
    );
}

#[test]
fn diff_glob_path_does_not_match_other_files() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "aaa\n");
    let err = diff_of(&path, "*.txt", DiffScope::Unstaged, DiffOptions::default())
        .expect_err("no file literally named *.txt");
    assert!(matches!(err, GitError::NoChanges(_)), "got {err:?}");
}

#[test]
fn diff_unstaged_scope_empty_after_staging_edit() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nsecond\n");
    common::stage(&path, "README.md");
    let err = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect_err("fully staged");
    assert!(matches!(err, GitError::NoChanges(_)), "got {err:?}");
}

#[test]
fn diff_untracked_binary_is_ok_and_flagged() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::write(path.join("img.bin"), [0u8, 1, 2, 0, 255]).expect("write bin");
    let diff = diff_of(
        &path,
        "img.bin",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(
        (diff.change, diff.is_binary, diff.hunks.is_empty()),
        (Some(ChangeKind::Untracked), true, true)
    );
}
