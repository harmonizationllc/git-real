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
