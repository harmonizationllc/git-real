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
    assert_eq!(opts.max_decode_bytes, 20 * 1024 * 1024);
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
    assert_eq!(diff.hunks[0].header, "@@ -1 +1,2 @@");
}

#[test]
fn diff_hunk_header_keeps_section_text_without_newline() {
    let (_dir, path) = ten_line_fixture();
    let opts = DiffOptions {
        context_lines: 1,
        ..Default::default()
    };
    let diff = diff_of(&path, "ten.txt", DiffScope::Unstaged, opts).expect("diff");
    assert_eq!(diff.hunks[0].header, "@@ -4,3 +4,3 @@ l3");
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
    common::write_file(&path, "a.txt", "y");
    let diff = diff_of(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).expect("diff");
    assert_eq!(
        diff.hunks[0].lines,
        vec![
            line(DiffLineKind::Deletion, Some(1), None, "x", true),
            line(DiffLineKind::Addition, None, Some(1), "y", true),
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
            "newEncoding",
            "oldEncoding",
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

// --- coverage audit: EOF markers ---

#[test]
fn diff_no_newline_on_both_sides_flags_context_line() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\nb");
    common::stage(&path, "a.txt");
    common::write_file(&path, "a.txt", "A\nb");
    let diff = diff_of(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).expect("diff");
    assert_eq!(
        diff.hunks[0].lines,
        vec![
            line(DiffLineKind::Deletion, Some(1), None, "a", false),
            line(DiffLineKind::Addition, None, Some(1), "A", false),
            line(DiffLineKind::Context, Some(2), Some(2), "b", true),
        ]
    );
}

#[test]
fn diff_no_newline_on_added_last_line_flags_the_addition() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "x\n");
    common::stage(&path, "a.txt");
    common::write_file(&path, "a.txt", "x\ny");
    let diff = diff_of(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).expect("diff");
    assert_eq!(
        diff.hunks[0].lines,
        vec![
            line(DiffLineKind::Context, Some(1), Some(1), "x", false),
            line(DiffLineKind::Addition, None, Some(2), "y", true),
        ]
    );
}

#[test]
fn diff_two_eof_markers_in_one_hunk_flag_both_lines() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "x");
    common::stage(&path, "a.txt");
    common::write_file(&path, "a.txt", "y");
    let diff = diff_of(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).expect("diff");
    assert_eq!(
        diff.hunks[0].lines,
        vec![
            line(DiffLineKind::Deletion, Some(1), None, "x", true),
            line(DiffLineKind::Addition, None, Some(1), "y", true),
        ]
    );
}

#[test]
fn diff_eof_marker_after_last_kept_line_is_kept_and_not_truncated() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "x");
    common::stage(&path, "a.txt");
    common::write_file(&path, "a.txt", "y");
    let opts = DiffOptions {
        max_lines: 2,
        ..Default::default()
    };
    let diff = diff_of(&path, "a.txt", DiffScope::Unstaged, opts).expect("diff");
    assert_eq!(
        (diff.truncated, all_lines(&diff).len()),
        (false, 2),
        "markers must not count toward max_lines"
    );
    assert!(all_lines(&diff).iter().all(|l| l.no_newline_at_eof));
}

#[test]
fn diff_truncation_keeps_marker_on_last_kept_line() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "x");
    common::stage(&path, "a.txt");
    common::write_file(&path, "a.txt", "y");
    let opts = DiffOptions {
        max_lines: 1,
        ..Default::default()
    };
    let diff = diff_of(&path, "a.txt", DiffScope::Unstaged, opts).expect("diff");
    assert!(diff.truncated);
    assert_eq!(
        diff.hunks[0].lines,
        vec![line(DiffLineKind::Deletion, Some(1), None, "x", true)]
    );
}

// --- coverage audit: multiple hunks ---

/// 20 lines committed as `ten.txt`-style fixture; `edit` rewrites the worktree copy.
fn twenty_line_fixture(edit: impl Fn(&str) -> String) -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    let original: String = (1..=20).map(|i| format!("l{i}\n")).collect();
    common::write_file(&path, "twenty.txt", &original);
    common::commit_all(&path, "add twenty");
    common::write_file(&path, "twenty.txt", &edit(&original));
    (dir, path)
}

fn two_replacements(text: &str) -> String {
    text.replace("l3\n", "L3\n").replace("l18\n", "L18\n")
}

fn one_context() -> DiffOptions {
    DiffOptions {
        context_lines: 1,
        ..Default::default()
    }
}

#[test]
fn diff_two_separated_edits_yield_two_hunks_with_starts() {
    let (_dir, path) = twenty_line_fixture(two_replacements);
    let diff = diff_of(&path, "twenty.txt", DiffScope::Unstaged, one_context()).expect("diff");
    let starts: Vec<(u32, u32, u32, u32)> = diff
        .hunks
        .iter()
        .map(|h| (h.old_start, h.old_lines, h.new_start, h.new_lines))
        .collect();
    assert_eq!(starts, vec![(2, 3, 2, 3), (17, 3, 17, 3)]);
}

#[test]
fn diff_line_numbers_restart_per_hunk_with_offset_after_insertion() {
    let (_dir, path) = twenty_line_fixture(|t| two_replacements(t).replace("L3\n", "L3\nextra\n"));
    let diff = diff_of(&path, "twenty.txt", DiffScope::Unstaged, one_context()).expect("diff");
    assert_eq!(diff.hunks.len(), 2);
    let second = &diff.hunks[1];
    assert_eq!((second.old_start, second.new_start), (17, 18));
    assert_eq!(
        second.lines,
        vec![
            line(DiffLineKind::Context, Some(17), Some(18), "l17", false),
            line(DiffLineKind::Deletion, Some(18), None, "l18", false),
            line(DiffLineKind::Addition, None, Some(19), "L18", false),
            line(DiffLineKind::Context, Some(19), Some(20), "l19", false),
        ]
    );
}

#[test]
fn diff_truncation_inside_second_hunk_keeps_first_whole() {
    let (_dir, path) = twenty_line_fixture(two_replacements);
    let opts = DiffOptions {
        max_lines: 6,
        ..one_context()
    };
    let diff = diff_of(&path, "twenty.txt", DiffScope::Unstaged, opts).expect("diff");
    let counts: Vec<usize> = diff.hunks.iter().map(|h| h.lines.len()).collect();
    assert_eq!((diff.truncated, counts), (true, vec![4, 2]));
    assert_eq!(diff.hunks[1].new_lines, 3, "partial hunk keeps its counts");
}

#[test]
fn diff_truncation_at_hunk_boundary_drops_the_empty_second_hunk() {
    let (_dir, path) = twenty_line_fixture(two_replacements);
    let opts = DiffOptions {
        max_lines: 4,
        ..one_context()
    };
    let diff = diff_of(&path, "twenty.txt", DiffScope::Unstaged, opts).expect("diff");
    assert_eq!((diff.truncated, diff.hunks.len()), (true, 1));
    assert_eq!(diff.hunks[0].lines.len(), 4);
}

#[test]
fn diff_max_lines_smaller_than_first_hunk_cuts_inside_it() {
    let (_dir, path) = twenty_line_fixture(two_replacements);
    let opts = DiffOptions {
        max_lines: 2,
        ..one_context()
    };
    let diff = diff_of(&path, "twenty.txt", DiffScope::Unstaged, opts).expect("diff");
    assert_eq!((diff.truncated, diff.hunks.len()), (true, 1));
    assert_eq!(diff.hunks[0].lines.len(), 2);
    assert_eq!(diff.hunks[0].old_lines, 3, "counts are the original ones");
}

#[test]
fn diff_exactly_total_lines_across_hunks_is_not_truncated() {
    let (_dir, path) = twenty_line_fixture(two_replacements);
    let opts = DiffOptions {
        max_lines: 8,
        ..one_context()
    };
    let diff = diff_of(&path, "twenty.txt", DiffScope::Unstaged, opts).expect("diff");
    assert_eq!((diff.truncated, diff.hunks.len()), (false, 2));
}

// --- coverage audit: delta kinds and scopes ---

#[test]
fn diff_staged_deleted_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).expect("delete");
    common::stage(&path, "README.md");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Staged,
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

#[test]
fn diff_staged_deletion_is_absent_from_unstaged_scope() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).expect("delete");
    common::stage(&path, "README.md");
    let err = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect_err("deletion is fully staged");
    assert!(matches!(err, GitError::NoChanges(_)), "got {err:?}");
}

#[cfg(unix)]
#[test]
fn diff_staged_typechange_to_symlink() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).expect("remove");
    std::os::unix::fs::symlink("target.txt", path.join("README.md")).expect("symlink");
    common::stage(&path, "README.md");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Staged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(
        (diff.path.as_str(), diff.old_path, diff.change),
        ("README.md", None, Some(ChangeKind::TypeChange))
    );
}

#[cfg(unix)]
#[test]
fn diff_unstaged_typechange_to_symlink_is_one_typechange() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).expect("remove");
    std::os::unix::fs::symlink("elsewhere", path.join("README.md")).expect("symlink");
    let diff = diff_of(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(diff.change, Some(ChangeKind::TypeChange));
}

#[test]
fn diff_conflicted_path_is_ok_without_hunks_in_both_scopes() {
    let (_dir, path) = common::temp_repo_with_conflict();
    for scope in [DiffScope::Unstaged, DiffScope::Staged] {
        let diff = diff_of(&path, "README.md", scope, DiffOptions::default())
            .unwrap_or_else(|e| panic!("{scope:?}: {e:?}"));
        assert_eq!(
            (diff.change, diff.hunks.is_empty()),
            (Some(ChangeKind::Conflicted), true),
            "{scope:?}"
        );
    }
}

#[test]
fn diff_empty_untracked_file_is_ok_without_hunks() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "empty.txt", "");
    let diff = diff_of(
        &path,
        "empty.txt",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(
        (diff.change, diff.is_binary, diff.hunks.is_empty()),
        (Some(ChangeKind::Untracked), false, true)
    );
}

#[test]
fn diff_staged_rename_with_edit_has_old_path_and_hunk() {
    let (_dir, path) = common::temp_repo_with_commit();
    let original: String = (1..=10).map(|i| format!("line {i}\n")).collect();
    common::write_file(&path, "old.txt", &original);
    common::commit_all(&path, "add old");
    std::fs::remove_file(path.join("old.txt")).expect("remove");
    common::write_file(&path, "new.txt", &original.replace("line 5\n", "LINE 5\n"));
    common::stage(&path, "old.txt");
    common::stage(&path, "new.txt");
    let diff = diff_of(&path, "new.txt", DiffScope::Staged, DiffOptions::default()).expect("diff");
    assert_eq!(
        (diff.old_path.as_deref(), diff.change, diff.hunks.len()),
        (Some("old.txt"), Some(ChangeKind::Renamed), 1)
    );
}

#[test]
fn diff_staged_ignore_whitespace_hides_indent_change() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "  # fixture  \n");
    common::stage(&path, "README.md");
    let opts = DiffOptions {
        ignore_whitespace: true,
        ..Default::default()
    };
    let err = diff_of(&path, "README.md", DiffScope::Staged, opts).expect_err("ignored");
    assert!(matches!(err, GitError::NoChanges(_)), "got {err:?}");
}

#[test]
fn diff_path_in_nested_subdirectory() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "dir/inner/f.txt", "one\n");
    common::commit_all(&path, "add nested");
    common::write_file(&path, "dir/inner/f.txt", "one\ntwo\n");
    let diff = diff_of(
        &path,
        "dir/inner/f.txt",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(
        (diff.path.as_str(), diff.change, all_lines(&diff).len()),
        ("dir/inner/f.txt", Some(ChangeKind::Modified), 2)
    );
}

#[test]
fn diff_staged_added_file_in_subdirectory() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "dir/new.txt", "one\n");
    common::stage(&path, "dir/new.txt");
    let diff = diff_of(
        &path,
        "dir/new.txt",
        DiffScope::Staged,
        DiffOptions::default(),
    )
    .expect("diff");
    assert_eq!(
        (diff.path.as_str(), diff.change),
        ("dir/new.txt", Some(ChangeKind::Added))
    );
}

// --- coverage audit: serde ---

#[test]
fn diff_enums_round_trip_through_camel_case_strings() {
    use git_real_core::HunkAction;
    for (scope, text) in [
        (DiffScope::Staged, "\"staged\""),
        (DiffScope::Unstaged, "\"unstaged\""),
    ] {
        assert_eq!(serde_json::to_string(&scope).unwrap(), text);
        assert_eq!(serde_json::from_str::<DiffScope>(text).unwrap(), scope);
    }
    for (kind, text) in [
        (DiffLineKind::Context, "\"context\""),
        (DiffLineKind::Addition, "\"addition\""),
        (DiffLineKind::Deletion, "\"deletion\""),
    ] {
        assert_eq!(serde_json::to_string(&kind).unwrap(), text);
        assert_eq!(serde_json::from_str::<DiffLineKind>(text).unwrap(), kind);
    }
    for (action, text) in [
        (HunkAction::Stage, "\"stage\""),
        (HunkAction::Unstage, "\"unstage\""),
        (HunkAction::Discard, "\"discard\""),
    ] {
        assert_eq!(serde_json::to_string(&action).unwrap(), text);
        assert_eq!(serde_json::from_str::<HunkAction>(text).unwrap(), action);
    }
}

#[test]
fn diff_enums_reject_non_camel_case_names() {
    assert!(serde_json::from_str::<DiffScope>("\"Staged\"").is_err());
    assert!(serde_json::from_str::<DiffLineKind>("\"ADDITION\"").is_err());
}

#[test]
fn hunk_selection_serializes_and_parses_whole_hunk_and_line_subset() {
    use git_real_core::HunkSelection;
    let whole = HunkSelection {
        hunk_index: 2,
        lines: None,
    };
    let value = serde_json::to_value(&whole).unwrap();
    assert_eq!(value, serde_json::json!({ "hunkIndex": 2, "lines": null }));
    assert_eq!(
        serde_json::from_value::<HunkSelection>(value).unwrap(),
        whole
    );

    let subset = HunkSelection {
        hunk_index: 0,
        lines: Some(vec![1, 3]),
    };
    let value = serde_json::to_value(&subset).unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "hunkIndex": 0, "lines": [1, 3] })
    );
    assert_eq!(
        serde_json::from_value::<HunkSelection>(value).unwrap(),
        subset
    );
}

#[test]
fn hunk_selection_without_lines_key_means_whole_hunk() {
    use git_real_core::HunkSelection;
    let parsed: HunkSelection = serde_json::from_str(r#"{"hunkIndex":1}"#).unwrap();
    assert_eq!(parsed.lines, None);
}

#[test]
fn hunk_selection_rejects_snake_case_keys() {
    use git_real_core::HunkSelection;
    assert!(serde_json::from_str::<HunkSelection>(r#"{"hunk_index":1,"lines":null}"#).is_err());
}

#[test]
fn file_diff_round_trips_through_json() {
    let (_dir, path) = twenty_line_fixture(two_replacements);
    let diff = diff_of(&path, "twenty.txt", DiffScope::Unstaged, one_context()).expect("diff");
    let text = serde_json::to_string(&diff).unwrap();
    let back: FileDiff = serde_json::from_str(&text).unwrap();
    assert_eq!(back, diff);
}

#[test]
fn file_diff_deserializes_from_frontend_shaped_json() {
    let json = r#"{
        "path": "a.txt", "oldPath": "b.txt", "scope": "staged", "change": "renamed",
        "isBinary": false, "truncated": true,
        "hunks": [{
            "oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1, "header": "@@",
            "lines": [{"kind":"context","oldLineno":1,"newLineno":1,"content":"x","noNewlineAtEof":true}]
        }]
    }"#;
    let diff: FileDiff = serde_json::from_str(json).unwrap();
    assert_eq!(
        (
            diff.old_path.as_deref(),
            diff.scope,
            diff.change,
            diff.truncated
        ),
        (
            Some("b.txt"),
            DiffScope::Staged,
            Some(ChangeKind::Renamed),
            true
        )
    );
    assert_eq!(
        diff.hunks[0].lines[0],
        line(DiffLineKind::Context, Some(1), Some(1), "x", true)
    );
}

// --- fix round 1 ---

#[test]
fn diff_single_line_without_newline_at_max_lines_one_is_not_truncated() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "x.txt", "x");
    let opts = DiffOptions {
        max_lines: 1,
        ..Default::default()
    };
    let diff = diff_of(&path, "x.txt", DiffScope::Unstaged, opts).expect("diff");
    assert_eq!(
        (diff.truncated, diff.hunks[0].lines.clone()),
        (
            false,
            vec![line(DiffLineKind::Addition, None, Some(1), "x", true)]
        )
    );
}

// Expected RED until the developer fixes it: the whitespace-only check must not
// look at the already-truncated hunk list.
#[test]
fn diff_max_lines_zero_is_ok_truncated_with_no_hunks() {
    let (_dir, path) = twenty_line_fixture(two_replacements);
    let opts = DiffOptions {
        max_lines: 0,
        ..Default::default()
    };
    let diff = diff_of(&path, "twenty.txt", DiffScope::Unstaged, opts).expect("Ok, not NoChanges");
    assert_eq!((diff.truncated, diff.hunks.is_empty()), (true, true));
}
