mod common;

use std::path::Path;

use git_real_core::{
    DiffLineKind, DiffOptions, DiffScope, FileDiff, GitError, HunkAction, HunkSelection,
    RepoSession, TextEncoding,
};

fn utf16le(s: &str) -> Vec<u8> {
    let mut v = vec![0xFF, 0xFE];
    v.extend(s.encode_utf16().flat_map(u16::to_le_bytes));
    v
}

fn write_bytes(root: &Path, rel: &str, bytes: &[u8]) {
    std::fs::write(root.join(rel), bytes).expect("write");
}

fn diff(
    path: &Path,
    file: &str,
    scope: DiffScope,
    opts: DiffOptions,
) -> Result<FileDiff, GitError> {
    RepoSession::open(path)
        .expect("open")
        .file_diff(file, scope, opts)
}

/// Commits `a.txt` as UTF-16 LE "one\ntwo\n".
fn repo_with_utf16_file() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    write_bytes(&path, "a.txt", &utf16le("one\ntwo\n"));
    common::commit_all(&path, "add utf16");
    (dir, path)
}

#[test]
fn default_max_decode_bytes_is_20_mib() {
    assert_eq!(DiffOptions::default().max_decode_bytes, 20 * 1024 * 1024);
}

#[test]
fn ordinary_text_diff_has_no_encodings() {
    let (_d, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# fixture\nmore\n");
    let d = diff(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .unwrap();
    assert_eq!(
        (d.old_encoding, d.new_encoding, d.is_binary),
        (None, None, false)
    );
}

#[test]
fn utf16_edit_yields_text_hunks_with_encodings() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(!d.is_binary);
    assert_eq!(d.old_encoding, Some(TextEncoding::Utf16Le));
    assert_eq!(d.new_encoding, Some(TextEncoding::Utf16Le));
    let lines: Vec<(DiffLineKind, &str)> = d.hunks[0]
        .lines
        .iter()
        .map(|l| (l.kind, l.content.as_str()))
        .collect();
    assert_eq!(
        lines,
        vec![
            (DiffLineKind::Context, "one"),
            (DiffLineKind::Deletion, "two"),
            (DiffLineKind::Addition, "TWO"),
        ]
    );
}

#[test]
fn encoding_only_change_reports_zero_hunks_not_no_changes() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "README.md", &utf16le("# fixture\n"));
    let d = diff(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .unwrap();
    assert!(d.hunks.is_empty());
    assert_eq!(d.old_encoding, Some(TextEncoding::Utf8));
    assert_eq!(d.new_encoding, Some(TextEncoding::Utf16Le));
    assert!(!d.is_binary);
}

#[test]
fn staged_scope_decodes_too() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    common::stage(&path, "a.txt");
    let d = diff(&path, "a.txt", DiffScope::Staged, DiffOptions::default()).unwrap();
    assert_eq!(d.hunks.len(), 1);
    assert_eq!(d.new_encoding, Some(TextEncoding::Utf16Le));
}

#[test]
fn added_utf16_file_has_no_old_encoding() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "b.txt", &utf16le("x\n"));
    let d = diff(&path, "b.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert_eq!(
        (d.old_encoding, d.new_encoding),
        (None, Some(TextEncoding::Utf16Le))
    );
    assert_eq!(d.hunks[0].lines[0].content, "x");
    assert_eq!(d.hunks[0].lines[0].kind, DiffLineKind::Addition);
}

#[test]
fn real_binary_stays_binary() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "img.png", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\x01");
    let d = diff(
        &path,
        "img.png",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .unwrap();
    assert!(d.is_binary);
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn utf8_with_nul_stays_binary() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "README.md", b"# fixture\0\n");
    let d = diff(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .unwrap();
    assert!(d.is_binary);
}

#[test]
fn side_above_max_decode_bytes_stays_binary() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    let opts = DiffOptions {
        max_decode_bytes: 4,
        ..DiffOptions::default()
    };
    let d = diff(&path, "a.txt", DiffScope::Unstaged, opts).unwrap();
    assert!(d.is_binary);
    assert!(d.hunks.is_empty());
}

#[test]
fn ignore_whitespace_applies_to_decoded_diff() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one  \ntwo\n"));
    let strict = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert_eq!(strict.hunks.len(), 1);
    let opts = DiffOptions {
        ignore_whitespace: true,
        ..DiffOptions::default()
    };
    let lenient = diff(&path, "a.txt", DiffScope::Unstaged, opts).unwrap();
    assert!(lenient.hunks.is_empty());
    assert_eq!(lenient.new_encoding, Some(TextEncoding::Utf16Le));
}

#[test]
fn decoded_diff_truncates() {
    let (_d, path) = repo_with_utf16_file();
    let long: String = (0..50).map(|i| format!("line {i}\n")).collect();
    write_bytes(&path, "a.txt", &utf16le(&long));
    let opts = DiffOptions {
        max_lines: 5,
        ..DiffOptions::default()
    };
    let d = diff(&path, "a.txt", DiffScope::Unstaged, opts).unwrap();
    assert!(d.truncated);
    assert_eq!(d.hunks.iter().map(|h| h.lines.len()).sum::<usize>(), 5);
}

#[test]
fn apply_hunk_on_utf16_file_is_bad_selection() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    let session = RepoSession::open(&path).unwrap();
    let sel = HunkSelection {
        hunk_index: 0,
        lines: None,
    };
    assert!(matches!(
        session.apply_hunk("a.txt", HunkAction::Stage, &sel),
        Err(GitError::BadSelection)
    ));
}

#[test]
fn file_diff_serializes_encodings_camel_case() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    let json = serde_json::to_value(&d).unwrap();
    assert_eq!(json["oldEncoding"], "utf16Le");
    assert_eq!(json["newEncoding"], "utf16Le");
}

#[test]
fn utf16_text_containing_nul_stays_binary() {
    // U+0000 inside UTF-16 text decodes to a NUL byte in UTF-8, so the rebuilt
    // patch is binary again; the loader must not report it as a text diff.
    let (_d, path) = repo_with_utf16_file();
    let mut bytes = utf16le("one\n");
    bytes.extend_from_slice(&[0x00, 0x00, b'\n', 0x00]); // U+0000 then '\n'
    write_bytes(&path, "a.txt", &bytes);
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(d.is_binary);
    assert!(d.hunks.is_empty());
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

fn utf16be(s: &str) -> Vec<u8> {
    let mut v = vec![0xFE, 0xFF];
    v.extend(s.encode_utf16().flat_map(u16::to_be_bytes));
    v
}

fn utf32le(s: &str) -> Vec<u8> {
    let mut v = vec![0xFF, 0xFE, 0x00, 0x00];
    v.extend(s.chars().flat_map(|c| (c as u32).to_le_bytes()));
    v
}

fn line_summary(d: &FileDiff) -> Vec<(DiffLineKind, &str)> {
    d.hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .map(|l| (l.kind, l.content.as_str()))
        .collect()
}

#[test]
fn utf8_with_nul_added_untracked_stays_binary() {
    // Old side absent, new side UTF-8 with NUL: nothing non-UTF-8 to decode.
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "new.txt", b"abc\0def\n");
    let d = diff(
        &path,
        "new.txt",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .unwrap();
    assert!(d.is_binary);
    assert!(d.hunks.is_empty());
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn utf8_with_nul_deleted_stays_binary() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "gone.txt", b"abc\0def\n");
    common::commit_all(&path, "add nul file");
    std::fs::remove_file(path.join("gone.txt")).unwrap();
    let d = diff(
        &path,
        "gone.txt",
        DiffScope::Unstaged,
        DiffOptions::default(),
    )
    .unwrap();
    assert!(d.is_binary);
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn staged_added_utf8_with_nul_stays_binary() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "new.txt", b"abc\0def\n");
    common::stage(&path, "new.txt");
    let d = diff(&path, "new.txt", DiffScope::Staged, DiffOptions::default()).unwrap();
    assert!(d.is_binary);
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn staged_added_utf16_file_has_no_old_encoding() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "b.txt", &utf16le("x\ny\n"));
    common::stage(&path, "b.txt");
    let d = diff(&path, "b.txt", DiffScope::Staged, DiffOptions::default()).unwrap();
    assert!(!d.is_binary);
    assert_eq!(
        (d.old_encoding, d.new_encoding),
        (None, Some(TextEncoding::Utf16Le))
    );
    assert_eq!(
        line_summary(&d),
        vec![(DiffLineKind::Addition, "x"), (DiffLineKind::Addition, "y")]
    );
}

#[test]
fn staged_deleted_utf16_file_has_no_new_encoding() {
    let (_d, path) = repo_with_utf16_file();
    std::fs::remove_file(path.join("a.txt")).unwrap();
    common::stage(&path, "a.txt");
    let d = diff(&path, "a.txt", DiffScope::Staged, DiffOptions::default()).unwrap();
    assert!(!d.is_binary);
    assert_eq!(
        (d.old_encoding, d.new_encoding),
        (Some(TextEncoding::Utf16Le), None)
    );
    assert_eq!(
        line_summary(&d),
        vec![
            (DiffLineKind::Deletion, "one"),
            (DiffLineKind::Deletion, "two")
        ]
    );
}

#[test]
fn unstaged_deleted_utf16_file_has_no_new_encoding() {
    let (_d, path) = repo_with_utf16_file();
    std::fs::remove_file(path.join("a.txt")).unwrap();
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert_eq!(
        (d.old_encoding, d.new_encoding),
        (Some(TextEncoding::Utf16Le), None)
    );
    assert_eq!(line_summary(&d).len(), 2);
}

#[test]
fn staged_scope_reads_head_as_old_and_index_as_new() {
    // HEAD holds UTF-16 LE, the index UTF-16 BE and the worktree UTF-8: only
    // the first two may influence the staged diff.
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16be("one\nTWO\n"));
    common::stage(&path, "a.txt");
    common::write_file(&path, "a.txt", "worktree only\n");
    let d = diff(&path, "a.txt", DiffScope::Staged, DiffOptions::default()).unwrap();
    assert_eq!(d.old_encoding, Some(TextEncoding::Utf16Le));
    assert_eq!(d.new_encoding, Some(TextEncoding::Utf16Be));
    assert_eq!(
        line_summary(&d),
        vec![
            (DiffLineKind::Context, "one"),
            (DiffLineKind::Deletion, "two"),
            (DiffLineKind::Addition, "TWO"),
        ]
    );
}

#[test]
fn unstaged_scope_reads_index_as_old_and_worktree_as_new() {
    // HEAD is UTF-16 LE, the index is rewritten to UTF-8, the worktree to UTF-16 LE.
    let (_d, path) = repo_with_utf16_file();
    common::write_file(&path, "a.txt", "one\ntwo\n");
    common::stage(&path, "a.txt");
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert_eq!(d.old_encoding, Some(TextEncoding::Utf8));
    assert_eq!(d.new_encoding, Some(TextEncoding::Utf16Le));
    assert_eq!(
        line_summary(&d),
        vec![
            (DiffLineKind::Context, "one"),
            (DiffLineKind::Deletion, "two"),
            (DiffLineKind::Addition, "TWO"),
        ]
    );
}

#[test]
fn staged_encoding_only_change_reports_zero_hunks() {
    // HEAD UTF-8 -> index UTF-16: bytes differ, text does not.
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "README.md", &utf16le("# fixture\n"));
    common::stage(&path, "README.md");
    let d = diff(
        &path,
        "README.md",
        DiffScope::Staged,
        DiffOptions::default(),
    )
    .unwrap();
    assert!(d.hunks.is_empty());
    assert!(!d.is_binary);
    assert_eq!(d.old_encoding, Some(TextEncoding::Utf8));
    assert_eq!(d.new_encoding, Some(TextEncoding::Utf16Le));
}

#[test]
fn new_side_over_limit_keeps_diff_binary_even_if_old_is_small_utf16() {
    let (_d, path) = repo_with_utf16_file(); // old side: 2 + 16 = 18 bytes
    let long: String = (0..50).map(|i| format!("line {i}\n")).collect();
    write_bytes(&path, "a.txt", &utf16le(&long));
    let opts = DiffOptions {
        max_decode_bytes: 100,
        ..DiffOptions::default()
    };
    let d = diff(&path, "a.txt", DiffScope::Unstaged, opts).unwrap();
    assert!(d.is_binary);
    assert!(d.hunks.is_empty());
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn old_side_over_limit_keeps_diff_binary_even_if_new_is_small_utf16() {
    let (_d, path) = common::temp_repo_with_commit();
    let long: String = (0..50).map(|i| format!("line {i}\n")).collect();
    write_bytes(&path, "a.txt", &utf16le(&long));
    common::commit_all(&path, "big utf16");
    write_bytes(&path, "a.txt", &utf16le("tiny\n"));
    let opts = DiffOptions {
        max_decode_bytes: 100,
        ..DiffOptions::default()
    };
    let d = diff(&path, "a.txt", DiffScope::Unstaged, opts).unwrap();
    assert!(d.is_binary);
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn staged_side_over_limit_keeps_diff_binary() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    common::stage(&path, "a.txt");
    let opts = DiffOptions {
        max_decode_bytes: 4,
        ..DiffOptions::default()
    };
    let d = diff(&path, "a.txt", DiffScope::Staged, opts).unwrap();
    assert!(d.is_binary);
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn side_exactly_at_max_decode_bytes_is_decoded() {
    let (_d, path) = repo_with_utf16_file(); // both sides are 18 bytes
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    let opts = DiffOptions {
        max_decode_bytes: 18,
        ..DiffOptions::default()
    };
    let d = diff(&path, "a.txt", DiffScope::Unstaged, opts).unwrap();
    assert!(!d.is_binary);
    assert_eq!(d.new_encoding, Some(TextEncoding::Utf16Le));
}

#[test]
fn utf16_old_with_real_binary_new_stays_binary() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\x01");
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(d.is_binary);
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn utf16_old_with_invalid_utf8_new_stays_binary() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &[0xC3, 0x28, b'a', b'\n']);
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(d.is_binary);
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn utf8_nul_old_with_utf16_new_is_binary_because_old_is_not_text() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "n.bin", b"abc\0def\n");
    common::commit_all(&path, "nul file");
    write_bytes(&path, "n.bin", &utf16le("abc\n"));
    let d = diff(&path, "n.bin", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(d.is_binary);
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn utf32_file_diff_is_decoded() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "w.txt", &utf32le("one\ntwo\n"));
    common::commit_all(&path, "utf32");
    write_bytes(&path, "w.txt", &utf32le("one\nTWO\n"));
    let d = diff(&path, "w.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(!d.is_binary);
    assert_eq!(d.old_encoding, Some(TextEncoding::Utf32Le));
    assert_eq!(d.new_encoding, Some(TextEncoding::Utf32Le));
    assert_eq!(line_summary(&d).len(), 3);
}

#[test]
fn utf16_endianness_change_is_an_encoding_only_change() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16be("one\ntwo\n"));
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(d.hunks.is_empty());
    assert_eq!(d.old_encoding, Some(TextEncoding::Utf16Le));
    assert_eq!(d.new_encoding, Some(TextEncoding::Utf16Be));
}

#[test]
fn decoded_diff_keeps_line_numbers_and_missing_final_newline() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\ntwo\nthree"));
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    let lines = &d.hunks[0].lines;
    let added = lines
        .iter()
        .find(|l| l.kind == DiffLineKind::Addition)
        .expect("addition");
    assert_eq!(added.content, "three");
    assert_eq!((added.old_lineno, added.new_lineno), (None, Some(3)));
    assert!(added.no_newline_at_eof);
    assert_eq!(lines[0].old_lineno, Some(1));
    assert_eq!(lines[0].new_lineno, Some(1));
}

#[test]
fn decoded_crlf_lines_lose_their_line_ending() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\r\nTWO\r\n"));
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(
        line_summary(&d)
            .iter()
            .all(|(_, text)| !text.contains('\r') && !text.contains('\n'))
    );
}

#[test]
fn staged_rename_with_utf16_edit_is_decoded_under_both_paths() {
    let (_d, path) = repo_with_utf16_file();
    let long: String = (0..20).map(|i| format!("line {i}\n")).collect();
    write_bytes(&path, "a.txt", &utf16le(&long));
    common::commit_all(&path, "longer");
    std::fs::remove_file(path.join("a.txt")).unwrap();
    write_bytes(
        &path,
        "b.txt",
        &utf16le(&long.replace("line 3\n", "LINE 3\n")),
    );
    common::stage(&path, "a.txt");
    common::stage(&path, "b.txt");
    let d = diff(&path, "b.txt", DiffScope::Staged, DiffOptions::default()).unwrap();
    assert_eq!(d.old_path.as_deref(), Some("a.txt"));
    assert!(!d.is_binary);
    assert_eq!(
        (d.old_encoding, d.new_encoding),
        (Some(TextEncoding::Utf16Le), Some(TextEncoding::Utf16Le))
    );
    assert!(line_summary(&d).contains(&(DiffLineKind::Addition, "LINE 3")));
}

#[test]
fn exact_mode_still_rejects_utf16_unstage() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    common::stage(&path, "a.txt");
    let session = RepoSession::open(&path).unwrap();
    let sel = HunkSelection {
        hunk_index: 0,
        lines: None,
    };
    assert!(matches!(
        session.apply_hunk("a.txt", HunkAction::Unstage, &sel),
        Err(GitError::BadSelection)
    ));
}

#[test]
fn staged_rename_edit_of_utf16_file_decodes_old_side_by_old_path() {
    let (_d, path) = repo_with_utf16_file();
    std::fs::remove_file(path.join("a.txt")).unwrap();
    write_bytes(&path, "b.txt", &utf16le("one\nTWO\n"));
    common::stage(&path, "a.txt");
    common::stage(&path, "b.txt");
    let d = diff(&path, "b.txt", DiffScope::Staged, DiffOptions::default()).unwrap();
    assert_eq!(d.old_path.as_deref(), Some("a.txt"));
    assert!(!d.is_binary);
    assert_eq!(
        (d.old_encoding, d.new_encoding),
        (Some(TextEncoding::Utf16Le), Some(TextEncoding::Utf16Le))
    );
    assert_eq!(d.hunks.len(), 1);
    assert_eq!(
        line_summary(&d),
        vec![
            (DiffLineKind::Context, "one"),
            (DiffLineKind::Deletion, "two"),
            (DiffLineKind::Addition, "TWO"),
        ]
    );
}

#[test]
fn deleted_utf16_file_shows_only_deletions() {
    let (_d, path) = repo_with_utf16_file();
    std::fs::remove_file(path.join("a.txt")).unwrap();
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(!d.is_binary);
    assert_eq!(
        (d.old_encoding, d.new_encoding),
        (Some(TextEncoding::Utf16Le), None)
    );
    assert_eq!(
        line_summary(&d),
        vec![
            (DiffLineKind::Deletion, "one"),
            (DiffLineKind::Deletion, "two")
        ]
    );
}

#[test]
fn utf16_be_with_bom_edited_in_place_is_decoded() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "a.txt", &utf16be("one\ntwo\n"));
    common::commit_all(&path, "utf16 be");
    write_bytes(&path, "a.txt", &utf16be("one\nTWO\n"));
    let d = diff(&path, "a.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(!d.is_binary);
    assert_eq!(
        (d.old_encoding, d.new_encoding),
        (Some(TextEncoding::Utf16Be), Some(TextEncoding::Utf16Be))
    );
    assert_eq!(
        line_summary(&d),
        vec![
            (DiffLineKind::Context, "one"),
            (DiffLineKind::Deletion, "two"),
            (DiffLineKind::Addition, "TWO"),
        ]
    );
}

#[test]
fn utf32_le_with_bom_edited_in_place_is_decoded() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "w.txt", &utf32le("one\ntwo\n"));
    common::commit_all(&path, "utf32 le");
    write_bytes(&path, "w.txt", &utf32le("one\nTWO\n"));
    let d = diff(&path, "w.txt", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(!d.is_binary);
    assert_eq!(
        (d.old_encoding, d.new_encoding),
        (Some(TextEncoding::Utf32Le), Some(TextEncoding::Utf32Le))
    );
    assert_eq!(
        line_summary(&d),
        vec![
            (DiffLineKind::Context, "one"),
            (DiffLineKind::Deletion, "two"),
            (DiffLineKind::Addition, "TWO"),
        ]
    );
}

#[test]
fn only_new_side_above_max_decode_bytes_stays_binary() {
    let (_d, path) = repo_with_utf16_file(); // old side is 18 bytes
    write_bytes(&path, "a.txt", &utf16le("one\ntwo\nthree\nfour\n")); // 2 + 36 bytes
    let opts = DiffOptions {
        max_decode_bytes: 20, // old fits, new does not
        ..DiffOptions::default()
    };
    let d = diff(&path, "a.txt", DiffScope::Unstaged, opts).unwrap();
    assert!(d.is_binary);
    assert!(d.hunks.is_empty());
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

// --- GR-9 coverage audit: commit scope decodes and flags binary sides ---

fn commit_scope(path: &Path) -> DiffScope {
    let head = git2::Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    DiffScope::Commit(head.to_string())
}

#[test]
fn commit_scope_transcodes_a_utf16_file_for_display() {
    let (_d, path) = repo_with_utf16_file();

    let d = diff(&path, "a.txt", commit_scope(&path), DiffOptions::default()).unwrap();

    let lines: Vec<&str> = d
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter().map(|l| l.content.as_str()))
        .collect();
    assert_eq!(
        (d.new_encoding, d.is_binary, lines),
        (Some(TextEncoding::Utf16Le), false, vec!["one", "two"])
    );
}

#[test]
fn commit_scope_keeps_a_nul_file_binary_with_no_hunks() {
    let (_d, path) = common::temp_repo_with_commit();
    common::commit_binary(&path, "img.bin", b"PNG\0\x01\x02\x03", "add binary");

    let d = diff(
        &path,
        "img.bin",
        commit_scope(&path),
        DiffOptions::default(),
    )
    .unwrap();

    assert_eq!(
        (d.is_binary, d.hunks.len(), d.new_encoding),
        (true, 0, None)
    );
}

#[test]
fn commit_scope_transcodes_the_old_side_of_a_modified_utf16_file() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\nthree\n"));
    common::commit_all(&path, "edit utf16");

    let d = diff(&path, "a.txt", commit_scope(&path), DiffOptions::default()).unwrap();

    assert_eq!(
        (d.old_encoding, d.new_encoding),
        (Some(TextEncoding::Utf16Le), Some(TextEncoding::Utf16Le))
    );
}
