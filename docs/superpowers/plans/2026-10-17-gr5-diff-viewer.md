# GR-5 Diff Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the selected file's diff (unified or side-by-side, highlighted, with word diffs, image previews and UTF-16 decoding) and land hunk/line stage, unstage and discard controls.

**Architecture:** The Rust core gains `encoding.rs` (UTF-16/32 sniff and decode), `content.rs` (raw bytes of one diff side) and a decode step in the diff loader; the Tauri app exposes `get_file_content` and an optional line cap. The front end adds `src/features/diff/` with pure model functions (pairing, rows, word diff, highlighting via CodeMirror/Lezer), hooks, and virtualized React components that replace the detail placeholder in `RepoPane`.

**Tech Stack:** Rust 2024 + git2 0.20 (core), Tauri 2 (`tauri::ipc::Response`), React 19 + TypeScript, TanStack Query 5, Zustand 5 (`persist`), `@codemirror/language`, `@codemirror/language-data`, `@lezer/highlight`, `@tanstack/react-virtual`, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-17-gr5-diff-viewer-design.md`

## Global Constraints

- Tests first, by the test role; the developer role never edits test files (CLAUDE.md).
- The only module importing `@tauri-apps/api/core` is `src/lib/ipc` (ESLint-enforced).
- `git2` stays `default-features = false`; no direct `tokio` dependency; blocking git2 work runs through `run_blocking`.
- `git-real-core` has no Tauri dependency and no platform-specific assumptions.
- Gates: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `npm test` at 100 % statements/branches for `src/`, `npm run lint` (ESLint + `prettier --check .`, which includes docs), `npm run typecheck`.
- Constants (verbatim from the spec): `MAX_PREVIEW_BYTES = 20 * 1024 * 1024`, `DiffOptions::default().max_decode_bytes = 20 * 1024 * 1024`, `HIGHLIGHT_LIMIT = 20_000`, `FULL_DIFF_LINES = 1_000_000`, `WORD_DIFF_MAX_TOKENS = 400`, sniff window 8192 bytes, UTF-16 heuristic threshold 90 %.
- Copy (verbatim): "Select a file to view its diff", "Loading diff…", "No staged changes in {path}" / "No unstaged changes in {path}", "Binary file — no preview available", "Image too large to preview", "Only the encoding changed", "Showing the first {N} lines", "Load full diff", "Hide whitespace changes", "Side by side", "Unified", "Stage hunk", "Unstage hunk", "Discard hunk…", "Stage {n} lines", "Unstage {n} lines", "Discard {n} lines…", "Discard changes", "Discard this hunk in {path}? This cannot be undone.", "Discard {n} selected lines in {path}? This cannot be undone.", disabled reasons "Turn off “Hide whitespace changes” to stage, unstage or discard hunks" and "Hunk actions are unavailable for files decoded from UTF-16 or UTF-32; stage or discard the whole file from the Changes panel".
- Serde: every new enum is `rename_all = "camelCase"` (`utf16Le`, `old`/`new`, `tooLarge`).

## Review Focus

1. A rename whose old side is an image: `ImageDiff` must request the old side with `oldPath`, not `path`, or the old image 404s as `pathNotFound` (Task 10 test "uses oldPath for the old side").
2. A hunk whose deletion run is longer than its addition run (or vice versa): pairing must leave one-sided rows and word diff must not run on them (Task 6 tests "uneven runs").
3. A UTF-8 file that gains a UTF-16 BOM with otherwise identical text: must show "Only the encoding changed", never `noChanges` (Task 3 test, Task 10 test).
4. Hunk action while the diff is stale (file edited between fetch and click): `badSelection` must surface inline and the refetch must clear line selection (Task 8 reset test, Task 10 error test).
5. A 10,000-line truncated diff then "Load full diff": the query key must include `maxLines`, otherwise the cached truncated diff is shown again (Task 5 key test, Task 10 "refetches with FULL_DIFF_LINES").

---

### Task 1: Core — `TextEncoding`, `DiffSide`, and `encoding.rs`

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/model/diff.rs`
- Modify: `src-tauri/crates/git-real-core/src/model/mod.rs`
- Create: `src-tauri/crates/git-real-core/src/encoding.rs`
- Modify: `src-tauri/crates/git-real-core/src/lib.rs`
- Test: `src-tauri/crates/git-real-core/tests/encoding.rs`

**Interfaces:**

- Produces: `pub enum TextEncoding { Utf8, Utf16Le, Utf16Be, Utf32Le, Utf32Be }`, `pub enum DiffSide { Old, New }` (both serde camelCase, re-exported from `git_real_core`), `pub fn encoding::detect_encoding(bytes: &[u8]) -> Option<TextEncoding>`, `pub fn encoding::decode(bytes: &[u8], encoding: TextEncoding) -> String`.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/crates/git-real-core/tests/encoding.rs
use git_real_core::encoding::{decode, detect_encoding};
use git_real_core::TextEncoding;

fn utf16le(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(u16::to_le_bytes).collect()
}
fn utf16be(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(u16::to_be_bytes).collect()
}

#[test]
fn detects_boms() {
    let cases: [(&[u8], TextEncoding); 4] = [
        (&[0xFF, 0xFE, 0x00, 0x00, b'a', 0, 0, 0], TextEncoding::Utf32Le),
        (&[0x00, 0x00, 0xFE, 0xFF, 0, 0, 0, b'a'], TextEncoding::Utf32Be),
        (&[0xFF, 0xFE, b'a', 0], TextEncoding::Utf16Le),
        (&[0xFE, 0xFF, 0, b'a'], TextEncoding::Utf16Be),
    ];
    for (bytes, want) in cases {
        assert_eq!(detect_encoding(bytes), Some(want), "{bytes:?}");
    }
}

#[test]
fn detects_bomless_utf16_by_nul_pattern() {
    assert_eq!(detect_encoding(&utf16le("hello world\n")), Some(TextEncoding::Utf16Le));
    assert_eq!(detect_encoding(&utf16be("hello world\n")), Some(TextEncoding::Utf16Be));
}

#[test]
fn detects_utf8_without_nul() {
    assert_eq!(detect_encoding(b"plain ascii\n"), Some(TextEncoding::Utf8));
    assert_eq!(detect_encoding("héllo wörld ✓\n".as_bytes()), Some(TextEncoding::Utf8));
    assert_eq!(detect_encoding(&[0xEF, 0xBB, 0xBF, b'x']), Some(TextEncoding::Utf8));
}

#[test]
fn empty_is_utf8() {
    assert_eq!(detect_encoding(&[]), Some(TextEncoding::Utf8));
}

#[test]
fn rejects_binary_and_invalid_utf8() {
    assert_eq!(detect_encoding(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), None);
    assert_eq!(detect_encoding(&[0xC3, 0x28, b'a']), None); // invalid UTF-8, no NUL
    // Half the pairs have a zero high byte: below the 90 % threshold.
    assert_eq!(detect_encoding(&[b'a', 0, b'b', b'c', b'd', 0, b'e', b'f']), None);
}

#[test]
fn heuristic_looks_only_at_first_8192_bytes() {
    let mut bytes = utf16le(&"a".repeat(4096)); // exactly 8192 bytes of clean UTF-16 LE
    bytes.extend_from_slice(&[0xFF; 1000]);
    assert_eq!(detect_encoding(&bytes), Some(TextEncoding::Utf16Le));
}

#[test]
fn decode_strips_bom_and_transcodes() {
    let mut le = vec![0xFF, 0xFE];
    le.extend(utf16le("héllo\n"));
    assert_eq!(decode(&le, TextEncoding::Utf16Le), "héllo\n");
    let mut be = vec![0xFE, 0xFF];
    be.extend(utf16be("x"));
    assert_eq!(decode(&be, TextEncoding::Utf16Be), "x");
    assert_eq!(decode(&[0xEF, 0xBB, 0xBF, b'x'], TextEncoding::Utf8), "x");
    assert_eq!(decode(&[0xFF, 0xFE, 0, 0, b'a', 0, 0, 0], TextEncoding::Utf32Le), "a");
    assert_eq!(decode(&[0, 0, 0xFE, 0xFF, 0, 0, 0, b'a'], TextEncoding::Utf32Be), "a");
}

#[test]
fn decode_replaces_malformed_input() {
    assert_eq!(decode(&[b'a', 0, b'b'], TextEncoding::Utf16Le), "a\u{FFFD}");
    assert_eq!(decode(&[0x00, 0xD8, b'a', 0], TextEncoding::Utf16Le), "\u{FFFD}a"); // lone surrogate
    assert_eq!(decode(&[0xFF, 0xFF, 0xFF, 0xFF], TextEncoding::Utf32Le), "\u{FFFD}");
    assert_eq!(decode(&[b'a', 0, 0, 0, b'b'], TextEncoding::Utf32Le), "a\u{FFFD}");
    assert_eq!(decode(&[0xC3, 0x28], TextEncoding::Utf8), "\u{FFFD}(");
}

#[test]
fn enums_serialize_camel_case() {
    assert_eq!(serde_json::to_string(&TextEncoding::Utf16Le).unwrap(), "\"utf16Le\"");
    assert_eq!(serde_json::to_string(&TextEncoding::Utf32Be).unwrap(), "\"utf32Be\"");
    assert_eq!(serde_json::to_string(&git_real_core::DiffSide::Old).unwrap(), "\"old\"");
    let side: git_real_core::DiffSide = serde_json::from_str("\"new\"").unwrap();
    assert_eq!(side, git_real_core::DiffSide::New);
}
```

- [ ] **Step 2: Run to verify failure**

Run (from `src-tauri`): `cargo test -p git-real-core --test encoding`
Expected: compile error, `encoding` module and `TextEncoding` not found.

- [ ] **Step 3: Implement**

`model/diff.rs` additions:

```rust
/// Which version of a file a content request refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffSide {
    /// HEAD for `Staged`, the index for `Unstaged`.
    Old,
    /// The index for `Staged`, the working tree for `Unstaged`.
    New,
}

/// A text encoding the diff loader can transcode from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Utf32Le,
    Utf32Be,
}
```

Add both to the `pub use diff::{...}` list in `model/mod.rs`.

`src/encoding.rs`:

```rust
//! Detection and decoding of UTF-16/UTF-32 text, which libgit2 flags as binary
//! because of its NUL bytes.

use crate::model::TextEncoding;

/// Bytes examined by the BOM-less UTF-16 heuristic.
const SNIFF_BYTES: usize = 8192;

/// Sniffs `bytes`: BOM first (UTF-32 before UTF-16, since `FF FE 00 00` starts
/// with the UTF-16 LE mark), then valid UTF-8 without NUL, then the NUL-pattern
/// heuristic. `None` means "not text we can decode". Empty input is UTF-8.
pub fn detect_encoding(bytes: &[u8]) -> Option<TextEncoding> {
    if bytes.is_empty() {
        return Some(TextEncoding::Utf8);
    }
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        return Some(TextEncoding::Utf32Le);
    }
    if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
        return Some(TextEncoding::Utf32Be);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some(TextEncoding::Utf16Le);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some(TextEncoding::Utf16Be);
    }
    let head = &bytes[..bytes.len().min(SNIFF_BYTES)];
    if !head.contains(&0) {
        return std::str::from_utf8(bytes).ok().map(|_| TextEncoding::Utf8);
    }
    let pairs = head.chunks_exact(2);
    let total = pairs.len();
    let (mut le, mut be) = (0usize, 0usize);
    for p in pairs {
        if p[1] == 0 && p[0] != 0 {
            le += 1;
        } else if p[0] == 0 && p[1] != 0 {
            be += 1;
        }
    }
    if le * 10 >= total * 9 {
        Some(TextEncoding::Utf16Le)
    } else if be * 10 >= total * 9 {
        Some(TextEncoding::Utf16Be)
    } else {
        None
    }
}

/// Transcodes `bytes` to a `String`, dropping a leading BOM and replacing
/// malformed sequences with U+FFFD. A partial trailing code unit becomes one U+FFFD.
pub fn decode(bytes: &[u8], encoding: TextEncoding) -> String {
    match encoding {
        TextEncoding::Utf8 => {
            String::from_utf8_lossy(strip_bom(bytes, &[0xEF, 0xBB, 0xBF])).into_owned()
        }
        TextEncoding::Utf16Le => decode_utf16(strip_bom(bytes, &[0xFF, 0xFE]), u16::from_le_bytes),
        TextEncoding::Utf16Be => decode_utf16(strip_bom(bytes, &[0xFE, 0xFF]), u16::from_be_bytes),
        TextEncoding::Utf32Le => {
            decode_utf32(strip_bom(bytes, &[0xFF, 0xFE, 0x00, 0x00]), u32::from_le_bytes)
        }
        TextEncoding::Utf32Be => {
            decode_utf32(strip_bom(bytes, &[0x00, 0x00, 0xFE, 0xFF]), u32::from_be_bytes)
        }
    }
}

fn strip_bom<'a>(bytes: &'a [u8], bom: &[u8]) -> &'a [u8] {
    bytes.strip_prefix(bom).unwrap_or(bytes)
}

fn decode_utf16(bytes: &[u8], unit: fn([u8; 2]) -> u16) -> String {
    let chunks = bytes.chunks_exact(2);
    let partial = !chunks.remainder().is_empty();
    let mut out: String = char::decode_utf16(chunks.map(|c| unit([c[0], c[1]])))
        .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    if partial {
        out.push(char::REPLACEMENT_CHARACTER);
    }
    out
}

fn decode_utf32(bytes: &[u8], unit: fn([u8; 4]) -> u32) -> String {
    let chunks = bytes.chunks_exact(4);
    let partial = !chunks.remainder().is_empty();
    let mut out: String = chunks
        .map(|c| char::from_u32(unit([c[0], c[1], c[2], c[3]])).unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    if partial {
        out.push(char::REPLACEMENT_CHARACTER);
    }
    out
}
```

`lib.rs`: add `pub mod encoding;` (alphabetical, after `diff`).

- [ ] **Step 4: Run tests and clippy**

Run: `cargo test -p git-real-core --test encoding && cargo clippy --workspace -- -D warnings`
Expected: all pass, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/git-real-core
git commit -m "feat(core): detect and decode UTF-16/UTF-32 text"
```

---

### Task 2: Core — `file_content` and `TooLarge`

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/error.rs`
- Create: `src-tauri/crates/git-real-core/src/content.rs`
- Modify: `src-tauri/crates/git-real-core/src/lib.rs`
- Test: `src-tauri/crates/git-real-core/tests/content.rs`

**Interfaces:**

- Consumes: `DiffScope`, `DiffSide` (Task 1), `paths::repo_relative`, `paths::checked_relative`, `RepoSession::repo()`, `RepoSession::workdir()`.
- Produces: `GitError::TooLarge { path: String, size: u64, limit: u64 }` with Display `"{path} is {size} bytes, above the {limit} byte preview limit"`; `RepoSession::file_content(&self, path: &str, scope: DiffScope, side: DiffSide, max_bytes: u64) -> Result<Vec<u8>, GitError>`.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/crates/git-real-core/tests/content.rs
mod common;

use std::path::Path;

use git_real_core::{DiffScope, DiffSide, GitError, RepoSession};

const BIG: u64 = 1 << 20;

fn content(path: &Path, file: &str, scope: DiffScope, side: DiffSide) -> Result<Vec<u8>, GitError> {
    content_with(path, file, scope, side, BIG)
}

fn content_with(
    path: &Path,
    file: &str,
    scope: DiffScope,
    side: DiffSide,
    max: u64,
) -> Result<Vec<u8>, GitError> {
    RepoSession::open(path).expect("open").file_content(file, scope, side, max)
}

fn assert_not_found(result: Result<Vec<u8>, GitError>) {
    assert!(matches!(result, Err(GitError::PathNotFound(_))), "{result:?}");
}

/// README.md: HEAD = "# fixture\n", index = "# staged\n", workdir = "# work\n".
fn three_versions() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    common::stage(&path, "README.md");
    common::write_file(&path, "README.md", "# work\n");
    (dir, path)
}

#[test]
fn resolves_each_scope_and_side() {
    let (_d, path) = three_versions();
    let cases = [
        (DiffScope::Staged, DiffSide::Old, "# fixture\n"),
        (DiffScope::Staged, DiffSide::New, "# staged\n"),
        (DiffScope::Unstaged, DiffSide::Old, "# staged\n"),
        (DiffScope::Unstaged, DiffSide::New, "# work\n"),
    ];
    for (scope, side, want) in cases {
        assert_eq!(content(&path, "README.md", scope, side).unwrap(), want.as_bytes(), "{scope:?}/{side:?}");
    }
}

#[test]
fn added_file_has_no_old_side() {
    let (_d, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "x");
    common::stage(&path, "new.txt");
    assert_not_found(content(&path, "new.txt", DiffScope::Staged, DiffSide::Old));
    assert_eq!(content(&path, "new.txt", DiffScope::Staged, DiffSide::New).unwrap(), b"x");
}

#[test]
fn deleted_file_has_no_new_side() {
    let (_d, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).unwrap();
    assert_not_found(content(&path, "README.md", DiffScope::Unstaged, DiffSide::New));
    assert_eq!(content(&path, "README.md", DiffScope::Unstaged, DiffSide::Old).unwrap(), b"# fixture\n");
}

#[test]
fn rename_old_side_is_read_by_old_path() {
    let (_d, path) = common::temp_repo_with_commit();
    std::fs::rename(path.join("README.md"), path.join("RENAMED.md")).unwrap();
    common::stage(&path, "README.md");
    common::stage(&path, "RENAMED.md");
    assert_eq!(content(&path, "README.md", DiffScope::Staged, DiffSide::Old).unwrap(), b"# fixture\n");
    assert_not_found(content(&path, "RENAMED.md", DiffScope::Staged, DiffSide::Old));
}

#[test]
fn unborn_head_has_no_old_staged_side() {
    let (_d, path) = common::temp_repo_unborn();
    common::write_file(&path, "a.txt", "a");
    common::stage(&path, "a.txt");
    assert_not_found(content(&path, "a.txt", DiffScope::Staged, DiffSide::Old));
}

#[cfg(unix)]
#[test]
fn symlink_returns_its_target_string() {
    let (_d, path) = common::temp_repo_with_commit();
    std::os::unix::fs::symlink("/etc/hostname", path.join("link")).unwrap();
    assert_eq!(content(&path, "link", DiffScope::Unstaged, DiffSide::New).unwrap(), b"/etc/hostname");
}

#[test]
fn directory_and_escapes_are_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    std::fs::create_dir(path.join("dir")).unwrap();
    assert_not_found(content(&path, "dir", DiffScope::Unstaged, DiffSide::New));
    assert_not_found(content(&path, "../x", DiffScope::Unstaged, DiffSide::New));
    assert_not_found(content(&path, ".git/config", DiffScope::Unstaged, DiffSide::New));
    assert_not_found(content(&path, "missing.txt", DiffScope::Staged, DiffSide::New));
}

#[test]
fn size_limit_is_inclusive() {
    let (_d, path) = common::temp_repo_with_commit();
    common::write_file(&path, "ten.txt", "0123456789");
    assert_eq!(content_with(&path, "ten.txt", DiffScope::Unstaged, DiffSide::New, 10).unwrap().len(), 10);
    match content_with(&path, "ten.txt", DiffScope::Unstaged, DiffSide::New, 9) {
        Err(GitError::TooLarge { path: p, size, limit }) => {
            assert_eq!((p.as_str(), size, limit), ("ten.txt", 10, 9));
        }
        other => panic!("expected TooLarge, got {other:?}"),
    }
    // Blob sides are checked by object size too.
    assert!(matches!(
        content_with(&path, "README.md", DiffScope::Staged, DiffSide::Old, 3),
        Err(GitError::TooLarge { size: 10, limit: 3, .. })
    ));
}

#[test]
fn binary_bytes_round_trip() {
    let (_d, path) = common::temp_repo_with_commit();
    let bytes = [0u8, 255, 0x89, b'P', b'N', b'G', 0, 1, 2];
    std::fs::write(path.join("blob.bin"), bytes).unwrap();
    common::stage(&path, "blob.bin");
    assert_eq!(content(&path, "blob.bin", DiffScope::Unstaged, DiffSide::Old).unwrap(), bytes);
    assert_eq!(content(&path, "blob.bin", DiffScope::Unstaged, DiffSide::New).unwrap(), bytes);
}

#[test]
fn too_large_display() {
    let e = GitError::TooLarge { path: "a.png".into(), size: 30, limit: 20 };
    assert_eq!(e.to_string(), "a.png is 30 bytes, above the 20 byte preview limit");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p git-real-core --test content`
Expected: compile error, `file_content` not found.

- [ ] **Step 3: Implement**

`error.rs`, after `ApplyFailed`:

```rust
    #[error("{path} is {size} bytes, above the {limit} byte preview limit")]
    TooLarge { path: String, size: u64, limit: u64 },
```

`src/content.rs`:

```rust
//! Raw bytes of one side of a file diff, for previews and decoding.

use std::path::{Path, PathBuf};

use git2::ErrorCode;

use crate::error::GitError;
use crate::model::{DiffScope, DiffSide};
use crate::paths::{checked_relative, repo_relative};
use crate::repo::RepoSession;

impl RepoSession {
    /// Raw bytes of `path` on `side` of `scope`, refusing anything above `max_bytes`.
    /// `path` is the path on that side (the old path for the old side of a rename).
    pub fn file_content(
        &self,
        path: &str,
        scope: DiffScope,
        side: DiffSide,
        max_bytes: u64,
    ) -> Result<Vec<u8>, GitError> {
        match (scope, side) {
            (DiffScope::Staged, DiffSide::Old) => self.head_blob(&repo_relative(path)?, max_bytes),
            (DiffScope::Staged, DiffSide::New) | (DiffScope::Unstaged, DiffSide::Old) => {
                self.index_blob(&repo_relative(path)?, max_bytes)
            }
            (DiffScope::Unstaged, DiffSide::New) => {
                let workdir = self.workdir()?;
                self.workdir_bytes(workdir, &checked_relative(workdir, path)?, max_bytes)
            }
        }
    }

    fn head_blob(&self, rel: &str, max_bytes: u64) -> Result<Vec<u8>, GitError> {
        let tree = match self.repo().head().and_then(|h| h.peel_to_tree()) {
            Ok(tree) => tree,
            Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
                return Err(not_found(rel));
            }
            Err(e) => return Err(e.into()),
        };
        let entry = tree.get_path(Path::new(rel)).map_err(|_| not_found(rel))?;
        self.blob_bytes(rel, entry.id(), max_bytes)
    }

    fn index_blob(&self, rel: &str, max_bytes: u64) -> Result<Vec<u8>, GitError> {
        let mut index = self.repo().index()?;
        index.read(true)?;
        let entry = index.get_path(Path::new(rel), 0).ok_or_else(|| not_found(rel))?;
        self.blob_bytes(rel, entry.id, max_bytes)
    }

    /// Checks the object size through the ODB header before loading the blob.
    fn blob_bytes(&self, rel: &str, oid: git2::Oid, max_bytes: u64) -> Result<Vec<u8>, GitError> {
        let (size, kind) = self.repo().odb()?.read_header(oid)?;
        if kind != git2::ObjectType::Blob {
            return Err(not_found(rel));
        }
        let size = size as u64;
        if size > max_bytes {
            return Err(too_large(rel, size, max_bytes));
        }
        Ok(self.repo().find_blob(oid)?.content().to_vec())
    }

    fn workdir_bytes(&self, workdir: &Path, rel: &str, max_bytes: u64) -> Result<Vec<u8>, GitError> {
        let full = workdir.join(rel);
        let meta = std::fs::symlink_metadata(&full).map_err(|_| not_found(rel))?;
        if meta.file_type().is_symlink() {
            // Git stores a symlink as its target string; never follow it.
            let target = std::fs::read_link(&full)?;
            return Ok(target.to_string_lossy().into_owned().into_bytes());
        }
        if !meta.is_file() {
            return Err(not_found(rel));
        }
        if meta.len() > max_bytes {
            return Err(too_large(rel, meta.len(), max_bytes));
        }
        Ok(std::fs::read(&full)?)
    }
}

fn not_found(rel: &str) -> GitError {
    GitError::PathNotFound(PathBuf::from(rel))
}

fn too_large(rel: &str, size: u64, limit: u64) -> GitError {
    GitError::TooLarge { path: rel.to_owned(), size, limit }
}
```

`lib.rs`: add `pub mod content;` (after `pub mod diff;` keep alphabetical: `content` before `diff`).

- [ ] **Step 4: Run tests and clippy**

Run: `cargo test -p git-real-core && cargo clippy --workspace -- -D warnings`
Expected: pass. (The app crate's `From<GitError>` match in `src-tauri/src/error.rs` is non-exhaustive now; Task 4 fixes it. If clippy on the workspace fails only for that, add `GitError::TooLarge { .. } => AppErrorKind::Git` as a temporary arm and note it in the report; Task 4 replaces it.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(core): read raw file content for one side of a diff"
```

---

### Task 3: Core — decode UTF-16/UTF-32 sides in the diff loader

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/model/diff.rs` (`FileDiff`, `DiffOptions`)
- Modify: `src-tauri/crates/git-real-core/src/diff/mod.rs`
- Modify: `src-tauri/crates/git-real-core/src/diff/patch.rs` (only if it constructs `FileDiff` literals in tests)
- Test: `src-tauri/crates/git-real-core/tests/diff_encoding.rs`
- Test (modify): any existing test constructing `FileDiff { .. }` or `DiffOptions { .. }` literals gains the new fields (`grep -rn "FileDiff {" src-tauri`).

**Interfaces:**

- Consumes: `encoding::{detect_encoding, decode}`, `RepoSession::file_content` (Task 2), `collect_hunks`, `DiffFile::exists()`.
- Produces: `FileDiff { .., old_encoding: Option<TextEncoding>, new_encoding: Option<TextEncoding> }` (serde `oldEncoding`/`newEncoding`), `DiffOptions { .., max_decode_bytes: u64 }` default `20 * 1024 * 1024`.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/crates/git-real-core/tests/diff_encoding.rs
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

fn diff(path: &Path, file: &str, scope: DiffScope, opts: DiffOptions) -> Result<FileDiff, GitError> {
    RepoSession::open(path).expect("open").file_diff(file, scope, opts)
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
    let d = diff(&path, "README.md", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert_eq!((d.old_encoding, d.new_encoding, d.is_binary), (None, None, false));
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
    let d = diff(&path, "README.md", DiffScope::Unstaged, DiffOptions::default()).unwrap();
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
    assert_eq!((d.old_encoding, d.new_encoding), (None, Some(TextEncoding::Utf16Le)));
    assert_eq!(d.hunks[0].lines[0].content, "x");
    assert_eq!(d.hunks[0].lines[0].kind, DiffLineKind::Addition);
}

#[test]
fn real_binary_stays_binary() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "img.png", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\x01");
    let d = diff(&path, "img.png", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(d.is_binary);
    assert_eq!((d.old_encoding, d.new_encoding), (None, None));
}

#[test]
fn utf8_with_nul_stays_binary() {
    let (_d, path) = common::temp_repo_with_commit();
    write_bytes(&path, "README.md", b"# fixture\0\n");
    let d = diff(&path, "README.md", DiffScope::Unstaged, DiffOptions::default()).unwrap();
    assert!(d.is_binary);
}

#[test]
fn side_above_max_decode_bytes_stays_binary() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    let opts = DiffOptions { max_decode_bytes: 4, ..DiffOptions::default() };
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
    let opts = DiffOptions { ignore_whitespace: true, ..DiffOptions::default() };
    let lenient = diff(&path, "a.txt", DiffScope::Unstaged, opts).unwrap();
    assert!(lenient.hunks.is_empty());
    assert_eq!(lenient.new_encoding, Some(TextEncoding::Utf16Le));
}

#[test]
fn decoded_diff_truncates() {
    let (_d, path) = repo_with_utf16_file();
    let long: String = (0..50).map(|i| format!("line {i}\n")).collect();
    write_bytes(&path, "a.txt", &utf16le(&long));
    let opts = DiffOptions { max_lines: 5, ..DiffOptions::default() };
    let d = diff(&path, "a.txt", DiffScope::Unstaged, opts).unwrap();
    assert!(d.truncated);
    assert_eq!(d.hunks.iter().map(|h| h.lines.len()).sum::<usize>(), 5);
}

#[test]
fn apply_hunk_on_utf16_file_is_bad_selection() {
    let (_d, path) = repo_with_utf16_file();
    write_bytes(&path, "a.txt", &utf16le("one\nTWO\n"));
    let session = RepoSession::open(&path).unwrap();
    let sel = HunkSelection { hunk_index: 0, lines: None };
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p git-real-core --test diff_encoding`
Expected: compile errors for `max_decode_bytes`, `old_encoding`, `TextEncoding`.

- [ ] **Step 3: Implement**

`model/diff.rs`:

```rust
pub struct FileDiff {
    // ...existing fields...
    pub truncated: bool,
    /// Set only when the loader transcoded this side from UTF-16/UTF-32 (or UTF-8 opposite it).
    pub old_encoding: Option<TextEncoding>,
    pub new_encoding: Option<TextEncoding>,
}

pub struct DiffOptions {
    pub ignore_whitespace: bool,
    pub context_lines: u32,
    pub max_lines: usize,
    /// Largest side (in bytes) the loader will transcode from UTF-16/UTF-32.
    pub max_decode_bytes: u64,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self { ignore_whitespace: false, context_lines: 3, max_lines: 10_000, max_decode_bytes: 20 * 1024 * 1024 }
    }
}
```

`diff/mod.rs`: in `apply_hunk` replace the `DiffOptions { .. }` literal with
`DiffOptions { ignore_whitespace: false, context_lines: 3, max_lines: usize::MAX, ..DiffOptions::default() }`.
In `load_diff`, after `let is_binary = ...;`:

```rust
        let decoded = if is_binary && mode == LineMode::Display {
            self.decode_sides(&delta, scope, opts, path)?
        } else {
            None
        };
        let (hunks, truncated, is_binary, old_encoding, new_encoding) = match decoded {
            Some(d) => (d.hunks, d.truncated, false, d.old_encoding, d.new_encoding),
            None => {
                let (hunks, truncated) = collect_hunks(&patch, opts.max_lines, mode, path)?;
                (hunks, truncated, is_binary, None, None)
            }
        };

        let no_visible_change = old_encoding.is_none()
            && new_encoding.is_none()
            && change == ChangeKind::Modified
            && !is_binary
            && patch.num_hunks() == 0
            && delta.old_file().mode() == delta.new_file().mode();
```

and set `old_encoding, new_encoding` in the `FileDiff` literal. Add:

```rust
/// Hunks rebuilt from transcoded text, with the encoding found on each side.
struct DecodedSides {
    hunks: Vec<Hunk>,
    truncated: bool,
    old_encoding: Option<TextEncoding>,
    new_encoding: Option<TextEncoding>,
}

impl RepoSession {
    /// For a delta libgit2 called binary: when every present side is UTF-8,
    /// UTF-16 or UTF-32 (and at least one is not UTF-8), rebuilds the hunks
    /// from the decoded text. `None` leaves the diff binary.
    fn decode_sides(
        &self,
        delta: &git2::DiffDelta<'_>,
        scope: DiffScope,
        opts: DiffOptions,
        path: &str,
    ) -> Result<Option<DecodedSides>, GitError> {
        let side = |file: git2::DiffFile<'_>, which: DiffSide| -> Result<Option<Vec<u8>>, GitError> {
            if !file.exists() {
                return Ok(None);
            }
            match self.file_content(&file_path(&file), scope, which, opts.max_decode_bytes) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(GitError::TooLarge { .. }) | Err(GitError::PathNotFound(_)) => Ok(None),
                Err(e) => Err(e),
            }
        };
        let old = side(delta.old_file(), DiffSide::Old)?;
        let new = side(delta.new_file(), DiffSide::New)?;
        // A side that exists but could not be read (too large) keeps the diff binary.
        if (delta.old_file().exists() && old.is_none()) || (delta.new_file().exists() && new.is_none()) {
            return Ok(None);
        }
        let old_encoding = old.as_deref().map(detect_encoding);
        let new_encoding = new.as_deref().map(detect_encoding);
        let encodings = [old_encoding, new_encoding];
        if encodings.iter().flatten().any(Option::is_none) {
            return Ok(None); // a present side is not decodable text
        }
        let old_encoding = old_encoding.flatten();
        let new_encoding = new_encoding.flatten();
        if encodings.iter().flatten().all(|e| *e == Some(TextEncoding::Utf8)) {
            return Ok(None); // UTF-8 with a NUL byte really is binary
        }
        let old_text = old.as_deref().zip(old_encoding).map(|(b, e)| decode(b, e)).unwrap_or_default();
        let new_text = new.as_deref().zip(new_encoding).map(|(b, e)| decode(b, e)).unwrap_or_default();
        let mut o = git2::DiffOptions::new();
        o.ignore_whitespace(opts.ignore_whitespace).context_lines(opts.context_lines);
        let old_path = file_path(&delta.old_file());
        let patch = git2::Patch::from_buffers(
            old_text.as_bytes(),
            Some(Path::new(&old_path)),
            new_text.as_bytes(),
            Some(Path::new(path)),
            Some(&mut o),
        )?;
        let (hunks, truncated) = collect_hunks(&patch, opts.max_lines, LineMode::Display, path)?;
        Ok(Some(DecodedSides { hunks, truncated, old_encoding, new_encoding }))
    }
}
```

Imports: `use std::path::Path;`, `use crate::encoding::{decode, detect_encoding};`, add `DiffSide, TextEncoding` to the `crate::model` import. `is_binary` must become `let is_binary = ...` non-shadowed before the match (rename the rebound one as shown).

Fix every other `FileDiff { .. }` / `DiffOptions { .. }` literal the compiler reports (tests in `tests/diff.rs`, `tests/patch_apply.rs`, and `diff/patch.rs` unit tests, if any) by adding `old_encoding: None, new_encoding: None` or `..DiffOptions::default()`. Those edits are test-file edits: the test role makes them in Step 1.

- [ ] **Step 4: Run tests and clippy**

Run: `cargo test -p git-real-core && cargo clippy --workspace -- -D warnings`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(core): decode UTF-16/UTF-32 sides into text diffs"
```

---

### Task 4: Tauri app — `tooLarge`, `max_lines`, `get_file_content`, CSP

**Files:**

- Modify: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/commands/worktree.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`
- Test: `src-tauri/tests/worktree_commands.rs`, `src-tauri/tests/error.rs`

**Interfaces:**

- Consumes: `RepoSession::file_content`, `GitError::TooLarge`, `DiffSide`.
- Produces: `AppErrorKind::TooLarge` → `"tooLarge"`; `pub const MAX_PREVIEW_BYTES: u64 = 20 * 1024 * 1024`; `get_file_diff_inner(reg, id, path, scope, ignore_whitespace, max_lines: Option<usize>)`; `get_file_content_inner(reg, id, path, scope, side) -> Result<Vec<u8>, AppError>`; command `get_file_content(id, path, scope, side) -> Result<tauri::ipc::Response, AppError>`; command `get_file_diff` gains `max_lines: Option<usize>` (IPC arg `maxLines`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/error.rs` the `TooLarge` row in `app_error_kind_for_each_git_error_variant` (kind `AppErrorKind::TooLarge`, message `None`) and a serialisation test:

```rust
#[test]
fn too_large_serializes_camel_case() {
    let err: AppError = GitError::TooLarge { path: "a.png".into(), size: 2, limit: 1 }.into();
    assert_eq!(serde_json::to_value(&err).unwrap()["kind"], json!("tooLarge"));
}
```

Add to `tests/worktree_commands.rs` (import `DiffSide`, `get_file_content_inner`, `MAX_PREVIEW_BYTES`; update the two existing `get_file_diff_inner` calls to pass `None` as the last argument):

```rust
#[test]
fn get_file_diff_inner_honours_max_lines() {
    let (_dir, path, reg, id) = open_fixture();
    std::fs::write(path.join("README.md"), "# fixture\na\nb\nc\nd\n").unwrap();
    let capped = get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false, Some(2)).unwrap();
    assert!(capped.truncated);
    assert_eq!(capped.hunks[0].lines.len(), 2);
    let full = get_file_diff_inner(&reg, id, "README.md", DiffScope::Unstaged, false, None).unwrap();
    assert!(!full.truncated);
}

#[test]
fn get_file_content_inner_returns_bytes() {
    let (_dir, path, reg, id) = open_fixture();
    modify_readme(&path);
    let old = get_file_content_inner(&reg, id, "README.md", DiffScope::Unstaged, DiffSide::Old).unwrap();
    let new = get_file_content_inner(&reg, id, "README.md", DiffScope::Unstaged, DiffSide::New).unwrap();
    assert_eq!(old, b"# fixture\n");
    assert_eq!(new, b"# fixture\nmore\n");
}

#[test]
fn get_file_content_inner_maps_errors() {
    let (_dir, _path, reg, id) = open_fixture();
    let missing = get_file_content_inner(&reg, id, "nope.txt", DiffScope::Unstaged, DiffSide::New)
        .expect_err("missing file");
    assert_eq!(missing.kind, AppErrorKind::PathNotFound);
    let bad = get_file_content_inner(&reg, 999, "README.md", DiffScope::Unstaged, DiffSide::New)
        .expect_err("unknown repo");
    assert_eq!(bad.kind, AppErrorKind::UnknownRepo);
    assert_eq!(MAX_PREVIEW_BYTES, 20 * 1024 * 1024);
}
```

(The `TooLarge` → `AppErrorKind::TooLarge` mapping is covered in `tests/error.rs`; producing a 20 MiB fixture is not worth the test time.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --workspace`
Expected: compile errors (`TooLarge`, `get_file_content_inner`, arity of `get_file_diff_inner`).

- [ ] **Step 3: Implement**

`error.rs`: add `TooLarge,` to `AppErrorKind` and `GitError::TooLarge { .. } => AppErrorKind::TooLarge,` to the match (replacing any temporary arm from Task 2).

`commands/worktree.rs`:

```rust
/// Largest file the app will hand to the web view for an image preview.
pub const MAX_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;

pub fn get_file_diff_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &str,
    scope: DiffScope,
    ignore_whitespace: bool,
    max_lines: Option<usize>,
) -> Result<FileDiff, AppError> {
    let defaults = DiffOptions::default();
    let opts = DiffOptions {
        ignore_whitespace,
        max_lines: max_lines.unwrap_or(defaults.max_lines),
        ..defaults
    };
    with_session(reg, id, |s| s.file_diff(path, scope, opts))
}

pub fn get_file_content_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &str,
    scope: DiffScope,
    side: DiffSide,
) -> Result<Vec<u8>, AppError> {
    with_session(reg, id, |s| s.file_content(path, scope, side, MAX_PREVIEW_BYTES))
}

#[tauri::command]
pub async fn get_file_diff(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    scope: DiffScope,
    ignore_whitespace: bool,
    max_lines: Option<usize>,
) -> Result<FileDiff, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_file_diff_inner(&reg, id, &path, scope, ignore_whitespace, max_lines)).await
}

/// Raw bytes of one side of a file, as a binary IPC response (no base64).
#[tauri::command]
pub async fn get_file_content(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    scope: DiffScope,
    side: DiffSide,
) -> Result<tauri::ipc::Response, AppError> {
    let reg = Arc::clone(reg.inner());
    let bytes = run_blocking(move || get_file_content_inner(&reg, id, &path, scope, side)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}
```

`lib.rs`: add `commands::worktree::get_file_content,` after `get_file_diff`.

`tauri.conf.json`: `"img-src 'self' asset: http://asset.localhost data: blob:"`.

- [ ] **Step 4: Run tests and clippy**

Run: `cargo test --workspace && cargo clippy --workspace -- -D warnings`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(app): expose file content and a diff line cap over IPC"
```

---

### Task 5: Front end foundations — deps, IPC seam, keys, prefs store, tokens, `applyHunk` action

**Files:**

- Modify: `package.json`, `package-lock.json` (via `npm install`), `vite.config.ts`
- Modify: `src/lib/ipc/types.ts`, `src/lib/ipc/errors.ts`, `src/lib/ipc/commands.ts`
- Modify: `src/lib/query/keys.ts`
- Create: `src/lib/store/diffPrefs.ts`
- Modify: `src/styles/tokens.css`; Create: `src/styles/syntax.css`; Modify: `src/main.tsx` (import `./styles/syntax.css`)
- Modify: `src/features/worktree/useWorktreeActions.ts`
- Test: `src/lib/ipc/commands.test.ts`, `src/lib/ipc/errors.test.ts`, `src/lib/ipc/types.test.ts` (fixtures gain `oldEncoding: null, newEncoding: null`), `src/lib/query/keys.test.ts`, `src/lib/store/diffPrefs.test.ts`, `src/features/worktree/useWorktreeActions.test.tsx`

**Interfaces:**

- Produces: `DiffSide`, `TextEncoding`, `FileDiff.oldEncoding/newEncoding: TextEncoding | null`, `AppErrorKind` + `"tooLarge"`; `getFileDiff(id, path, scope, ignoreWhitespace, maxLines?: number)` sending `maxLines: maxLines ?? null`; `getFileContent(id, path, scope, side): Promise<ArrayBuffer>`; `queryKeys.fileDiff(id, path, scope, ignoreWs, maxLines: number | null = null)` → `["repo", id, "diff", path, scope, ignoreWs, maxLines]`; `queryKeys.fileContent(id, path, scope, side)` → `["repo", id, "content", path, scope, side]`; `useDiffPrefs` with `{ mode: DiffMode; ignoreWhitespace: boolean; setMode; setIgnoreWhitespace }` persisted under `"git-real.diffPrefs"`; `useWorktreeActions(...).applyHunk(path, action, selection)`; CSS tokens `--color-added-bg`, `--color-removed-bg`, `--color-added-word-bg`, `--color-removed-word-bg`, `--color-hunk-bg`, `--color-line-selected`, `--syntax-keyword`, `--syntax-string`, `--syntax-number`, `--syntax-comment`, `--syntax-variable`, `--syntax-type`, `--syntax-function`, `--syntax-operator`, `--syntax-punctuation`, `--syntax-meta`, `--syntax-invalid`.

- [ ] **Step 1: Install dependencies (developer, before tests, so imports type-check)**

```bash
npm install @codemirror/language@^6.13.1 @codemirror/language-data@^6.5.2 @lezer/highlight@^1.2.5 @tanstack/react-virtual@^3.14.21
```

In `vite.config.ts` `optimizeDeps.include`, add `"@codemirror/language"`, `"@codemirror/language-data"`, `"@lezer/highlight"`, `"@tanstack/react-virtual"`, and every key of `dependencies` in `node_modules/@codemirror/language-data/package.json` that starts with `@codemirror/lang-` or equals `@codemirror/legacy-modes` (list them literally; `node -e "console.log(Object.keys(require('@codemirror/language-data/package.json').dependencies).filter(k=>/lang-|legacy/.test(k)).map(k=>JSON.stringify(k)).join(',\n'))"` prints them).

- [ ] **Step 2: Write the failing tests**

`commands.test.ts`: change the existing `getFileDiff` expectation to include `maxLines: null`; add:

```ts
it("getFileDiff forwards maxLines when given", async () => {
  const calls = mockWith(diff);
  await getFileDiff(1, "a.txt", "unstaged", false, 1_000_000);
  expect(calls[0].args).toEqual({
    id: 1,
    path: "a.txt",
    scope: "unstaged",
    ignoreWhitespace: false,
    maxLines: 1_000_000,
  });
});

it("getFileContent sends get_file_content and returns the bytes", async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const calls = mockWith(bytes);
  const result = await getFileContent(1, "img.png", "unstaged", "new");
  expect(calls).toEqual([
    { cmd: "get_file_content", args: { id: 1, path: "img.png", scope: "unstaged", side: "new" } },
  ]);
  expect(result).toBe(bytes);
});
```

and `["getFileContent", () => getFileContent(1, "a", "staged", "old")]` in the rejection table.
`errors.test.ts`: add `"noChanges", "badSelection", "applyFailed", "tooLarge"` to `kinds` if missing.
`keys.test.ts`:

```ts
it("fileDiff defaults maxLines to null and includes it when given", () => {
  expect(queryKeys.fileDiff(3, "a", "staged", false)).toEqual([
    "repo",
    3,
    "diff",
    "a",
    "staged",
    false,
    null,
  ]);
  expect(queryKeys.fileDiff(3, "a", "staged", false, 1_000_000).at(-1)).toBe(1_000_000);
});
it("fileContent is scoped under the repo prefix", () => {
  expect(queryKeys.fileContent(3, "a.png", "unstaged", "old")).toEqual([
    "repo",
    3,
    "content",
    "a.png",
    "unstaged",
    "old",
  ]);
});
```

`diffPrefs.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useDiffPrefs } from "./diffPrefs";

beforeEach(() => {
  localStorage.clear();
  useDiffPrefs.setState({ mode: "split", ignoreWhitespace: false });
});

describe("useDiffPrefs", () => {
  it("defaults to split mode with whitespace shown", () => {
    expect(useDiffPrefs.getState()).toMatchObject({ mode: "split", ignoreWhitespace: false });
  });
  it("setMode and setIgnoreWhitespace update state", () => {
    useDiffPrefs.getState().setMode("unified");
    useDiffPrefs.getState().setIgnoreWhitespace(true);
    expect(useDiffPrefs.getState()).toMatchObject({ mode: "unified", ignoreWhitespace: true });
  });
  it("persists under git-real.diffPrefs", () => {
    useDiffPrefs.getState().setMode("unified");
    const raw = localStorage.getItem("git-real.diffPrefs");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state).toMatchObject({ mode: "unified" });
  });
  it("rehydrates from storage", async () => {
    localStorage.setItem(
      "git-real.diffPrefs",
      JSON.stringify({ state: { mode: "unified", ignoreWhitespace: true }, version: 0 }),
    );
    await useDiffPrefs.persist.rehydrate();
    expect(useDiffPrefs.getState()).toMatchObject({ mode: "unified", ignoreWhitespace: true });
  });
});
```

`useWorktreeActions.test.tsx`: mock `applyHunk` too and add:

```ts
it("should call applyHunk with repo id, path, action and selection", async () => {
  const { result } = renderHookWithProviders(() => useWorktreeActions(4));
  await run(() => result.current.applyHunk("a.ts", "stage", { hunkIndex: 1, lines: [2, 3] }));
  expect(applyHunk).toHaveBeenCalledExactlyOnceWith(4, "a.ts", "stage", {
    hunkIndex: 1,
    lines: [2, 3],
  });
});
it("should surface applyHunk failures through error", async () => {
  vi.mocked(applyHunk).mockRejectedValue({ kind: "badSelection", message: "stale" });
  const { result } = renderHookWithProviders(() => useWorktreeActions(4));
  await run(() => result.current.applyHunk("a.ts", "discard", { hunkIndex: 0, lines: null }));
  await waitFor(() => expect(result.current.error?.kind).toBe("badSelection"));
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- src/lib src/features/worktree/useWorktreeActions.test.tsx`
Expected: type errors / failures for `getFileContent`, `fileContent`, `useDiffPrefs`, `applyHunk`.

- [ ] **Step 4: Implement**

`types.ts`:

```ts
export type DiffSide = "old" | "new";
export type TextEncoding = "utf8" | "utf16Le" | "utf16Be" | "utf32Le" | "utf32Be";
// FileDiff gains:
//   oldEncoding: TextEncoding | null;
//   newEncoding: TextEncoding | null;
// AppErrorKind gains "tooLarge".
```

`errors.ts`: `tooLarge: true,` in `KINDS`.

`commands.ts`:

```ts
export function getFileDiff(
  id: RepoId,
  path: string,
  scope: DiffScope,
  ignoreWhitespace: boolean,
  maxLines?: number,
): Promise<FileDiff> {
  return invoke<FileDiff>("get_file_diff", {
    id,
    path,
    scope,
    ignoreWhitespace,
    maxLines: maxLines ?? null,
  });
}

/** Raw bytes of one side of a file; the backend answers with a binary IPC response. */
export function getFileContent(
  id: RepoId,
  path: string,
  scope: DiffScope,
  side: DiffSide,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("get_file_content", { id, path, scope, side });
}
```

`keys.ts`:

```ts
fileDiff: (id: RepoId, path: string, scope: DiffScope, ignoreWs: boolean, maxLines: number | null = null) =>
  ["repo", id, "diff", path, scope, ignoreWs, maxLines] as const,
fileContent: (id: RepoId, path: string, scope: DiffScope, side: DiffSide) =>
  ["repo", id, "content", path, scope, side] as const,
```

`diffPrefs.ts`:

```ts
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type DiffMode = "split" | "unified";

interface DiffPrefs {
  mode: DiffMode;
  ignoreWhitespace: boolean;
  setMode(mode: DiffMode): void;
  setIgnoreWhitespace(on: boolean): void;
}

/** Viewer preferences shared by every repository tab; survives restarts via localStorage. */
export const useDiffPrefs = create<DiffPrefs>()(
  persist(
    (set) => ({
      mode: "split",
      ignoreWhitespace: false,
      setMode: (mode) => set({ mode }),
      setIgnoreWhitespace: (ignoreWhitespace) => set({ ignoreWhitespace }),
    }),
    {
      name: "git-real.diffPrefs",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ mode: s.mode, ignoreWhitespace: s.ignoreWhitespace }),
    },
  ),
);
```

`tokens.css` light additions (dark block gets the second value):

```css
--color-added-bg: #dafbe1; /* dark: #12261e */
--color-removed-bg: #ffebe9; /* dark: #2d1214 */
--color-added-word-bg: #abf2bc; /* dark: #1f6f3a */
--color-removed-word-bg: #ffc1bd; /* dark: #8c2b2b */
--color-hunk-bg: #eef3fb; /* dark: #22304a */
--color-line-selected: #fff3b0; /* dark: #4a3f14 */
--syntax-keyword: #cf222e; /* dark: #ff7b72 */
--syntax-string: #0a3069; /* dark: #a5d6ff */
--syntax-number: #0550ae; /* dark: #79c0ff */
--syntax-comment: #6e7781; /* dark: #8b949e */
--syntax-variable: #953800; /* dark: #ffa657 */
--syntax-type: #8250df; /* dark: #d2a8ff */
--syntax-function: #8250df; /* dark: #d2a8ff */
--syntax-operator: #0550ae; /* dark: #79c0ff */
--syntax-punctuation: #24292f; /* dark: #c9d1d9 */
--syntax-meta: #116329; /* dark: #7ee787 */
--syntax-invalid: #cf222e; /* dark: #ff7b72 */
```

`syntax.css` (global; `classHighlighter` emits these names):

```css
.tok-keyword,
.tok-modifier,
.tok-controlKeyword,
.tok-definitionKeyword,
.tok-moduleKeyword,
.tok-operatorKeyword {
  color: var(--syntax-keyword);
}
.tok-string,
.tok-string2,
.tok-character,
.tok-regexp,
.tok-escape,
.tok-special {
  color: var(--syntax-string);
}
.tok-number,
.tok-bool,
.tok-atom,
.tok-null,
.tok-literal {
  color: var(--syntax-number);
}
.tok-comment,
.tok-lineComment,
.tok-blockComment,
.tok-docComment {
  color: var(--syntax-comment);
  font-style: italic;
}
.tok-variableName,
.tok-propertyName,
.tok-attributeName,
.tok-labelName {
  color: var(--syntax-variable);
}
.tok-typeName,
.tok-className,
.tok-namespace,
.tok-tagName,
.tok-standard {
  color: var(--syntax-type);
}
.tok-function,
.tok-definition.tok-variableName,
.tok-definition.tok-propertyName {
  color: var(--syntax-function);
}
.tok-operator,
.tok-arithmeticOperator,
.tok-logicOperator,
.tok-compareOperator,
.tok-updateOperator,
.tok-definitionOperator {
  color: var(--syntax-operator);
}
.tok-punctuation,
.tok-bracket,
.tok-paren,
.tok-brace,
.tok-separator,
.tok-angleBracket,
.tok-squareBracket {
  color: var(--syntax-punctuation);
}
.tok-meta,
.tok-processingInstruction,
.tok-annotation,
.tok-heading,
.tok-url,
.tok-link {
  color: var(--syntax-meta);
}
.tok-invalid {
  color: var(--syntax-invalid);
  text-decoration: underline wavy;
}
.tok-strong {
  font-weight: 600;
}
.tok-emphasis {
  font-style: italic;
}
.tok-strikethrough {
  text-decoration: line-through;
}
```

`main.tsx`: `import "./styles/syntax.css";` after `global.css`.

`useWorktreeActions.ts`: add `| { action: "applyHunk"; path: string; hunkAction: HunkAction; selection: HunkSelection }` to `WorktreeRequest`, `applyHunk(path: string, action: HunkAction, selection: HunkSelection): void;` to the interface, `case "applyHunk": return applyHunk(repoId, req.path, req.hunkAction, req.selection);` in `execute`, and `applyHunk: (path, action, selection) => mutate({ action: "applyHunk", path, hunkAction: action, selection }),` in the returned object. Import `applyHunk` from `../../lib/ipc` and the two types.

- [ ] **Step 5: Run the full front-end gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: pass with coverage still 100 %.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vite.config.ts src
git commit -m "feat(ui): diff viewer foundations: IPC, keys, prefs store, tokens, applyHunk action"
```

---

### Task 6: Front end model — pairing, rows, word diff, images, encoding labels, limits

**Files:**

- Create: `src/features/diff/model/limits.ts`, `pairing.ts`, `rows.ts`, `wordDiff.ts`, `images.ts`, `encoding.ts`
- Test: `src/features/diff/model/{limits,pairing,rows,wordDiff,images,encoding}.test.ts`
- Delete: `src/features/diff/.gitkeep`

**Interfaces:**

- Consumes: `DiffLine`, `FileDiff`, `Hunk`, `TextEncoding` from `src/lib/ipc`; `DiffMode` from `src/lib/store/diffPrefs`.
- Produces (all exact):
  - `limits.ts`: `HIGHLIGHT_LIMIT = 20_000`, `FULL_DIFF_LINES = 1_000_000`, `WORD_DIFF_MAX_TOKENS = 400`, `totalLines(diff: FileDiff): number`.
  - `pairing.ts`: `interface LinePair { old: number | null; new: number | null }`, `pairLines(lines: DiffLine[]): LinePair[]`.
  - `rows.ts`: `type DiffRow = { kind: "header"; key: string; hunkIndex: number; header: string } | { kind: "unified"; key: string; hunkIndex: number; lineIndex: number; partner: number | null } | { kind: "split"; key: string; hunkIndex: number; old: number | null; new: number | null }`, `buildRows(diff: FileDiff, mode: DiffMode): DiffRow[]`.
  - `wordDiff.ts`: `interface Range { start: number; end: number }`, `interface WordDiff { old: Range[]; new: Range[] }`, `wordDiff(a: string, b: string): WordDiff`.
  - `images.ts`: `IMAGE_EXTENSIONS`, `isImagePath(path: string): boolean`, `mimeFor(path: string): string`.
  - `encoding.ts`: `encodingLabel(e: TextEncoding): string`, `encodingNotice(diff: FileDiff): string | null`, `isDecoded(diff: FileDiff): boolean`.

- [ ] **Step 1: Write the failing tests**

Shared fixture helper at the top of each test file that needs it:

```ts
import type { DiffLine, DiffLineKind, FileDiff, Hunk } from "../../../lib/ipc";

export const L = (
  kind: DiffLineKind,
  content: string,
  old: number | null = null,
  nu: number | null = null,
): DiffLine => ({ kind, content, oldLineno: old, newLineno: nu, noNewlineAtEof: false });
export const hunk = (lines: DiffLine[], header = "@@ -1,2 +1,2 @@"): Hunk => ({
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 2,
  header,
  lines,
});
export const fileDiff = (hunks: Hunk[], extra: Partial<FileDiff> = {}): FileDiff => ({
  path: "a.ts",
  oldPath: null,
  scope: "unstaged",
  change: "modified",
  isBinary: false,
  hunks,
  truncated: false,
  oldEncoding: null,
  newEncoding: null,
  ...extra,
});
```

(Put it in `src/features/diff/model/testFixtures.ts`; it is test-only but not a `.test.ts` file, so exclude it from coverage by giving it `/* v8 ignore file */` at the top — or simply exercise every line, which the tests do.)

`pairing.test.ts`:

```ts
describe("pairLines", () => {
  it("context lines are two-sided with the same index", () => {
    expect(pairLines([L("context", "a"), L("context", "b")])).toEqual([
      { old: 0, new: 0 },
      { old: 1, new: 1 },
    ]);
  });
  it("zips a deletion run with the following addition run", () => {
    const lines = [L("deletion", "a"), L("deletion", "b"), L("addition", "A"), L("addition", "B")];
    expect(pairLines(lines)).toEqual([
      { old: 0, new: 2 },
      { old: 1, new: 3 },
    ]);
  });
  it("leaves uneven runs one-sided", () => {
    expect(pairLines([L("deletion", "a"), L("deletion", "b"), L("addition", "A")])).toEqual([
      { old: 0, new: 2 },
      { old: 1, new: null },
    ]);
    expect(pairLines([L("deletion", "a"), L("addition", "A"), L("addition", "B")])).toEqual([
      { old: 0, new: 1 },
      { old: null, new: 2 },
    ]);
  });
  it("addition-only and deletion-only runs are one-sided", () => {
    expect(pairLines([L("addition", "A")])).toEqual([{ old: null, new: 0 }]);
    expect(pairLines([L("deletion", "a")])).toEqual([{ old: 0, new: null }]);
  });
  it("context splits runs and a deletion after additions starts a new run", () => {
    const lines = [
      L("deletion", "a"),
      L("addition", "A"),
      L("context", "c"),
      L("addition", "B"),
      L("deletion", "d"),
    ];
    expect(pairLines(lines)).toEqual([
      { old: 0, new: 1 },
      { old: 2, new: 2 },
      { old: null, new: 3 },
      { old: 4, new: null },
    ]);
  });
  it("empty input yields no pairs", () => {
    expect(pairLines([])).toEqual([]);
  });
});
```

`rows.test.ts`:

```ts
const h0 = hunk(
  [
    L("context", "c", 1, 1),
    L("deletion", "a", 2, null),
    L("addition", "A", null, 2),
    L("addition", "B", null, 3),
  ],
  "@@ -1,2 +1,3 @@",
);
const h1 = hunk([L("addition", "z", null, 9)], "@@ -8,0 +9 @@");
const diff = fileDiff([h0, h1]);

describe("buildRows unified", () => {
  it("emits a header then one row per line with partners for changed pairs", () => {
    expect(buildRows(diff, "unified")).toEqual([
      { kind: "header", key: "h0", hunkIndex: 0, header: "@@ -1,2 +1,3 @@" },
      { kind: "unified", key: "u0:0", hunkIndex: 0, lineIndex: 0, partner: null },
      { kind: "unified", key: "u0:1", hunkIndex: 0, lineIndex: 1, partner: 2 },
      { kind: "unified", key: "u0:2", hunkIndex: 0, lineIndex: 2, partner: 1 },
      { kind: "unified", key: "u0:3", hunkIndex: 0, lineIndex: 3, partner: null },
      { kind: "header", key: "h1", hunkIndex: 1, header: "@@ -8,0 +9 @@" },
      { kind: "unified", key: "u1:0", hunkIndex: 1, lineIndex: 0, partner: null },
    ]);
  });
});
describe("buildRows split", () => {
  it("emits a header then one row per pair", () => {
    expect(buildRows(diff, "split")).toEqual([
      { kind: "header", key: "h0", hunkIndex: 0, header: "@@ -1,2 +1,3 @@" },
      { kind: "split", key: "s0:0:0", hunkIndex: 0, old: 0, new: 0 },
      { kind: "split", key: "s0:1:2", hunkIndex: 0, old: 1, new: 2 },
      { kind: "split", key: "s0:-:3", hunkIndex: 0, old: null, new: 3 },
      { kind: "header", key: "h1", hunkIndex: 1, header: "@@ -8,0 +9 @@" },
      { kind: "split", key: "s1:-:0", hunkIndex: 1, old: null, new: 0 },
    ]);
  });
  it("no hunks yields no rows", () => {
    expect(buildRows(fileDiff([]), "split")).toEqual([]);
  });
});
```

`wordDiff.test.ts`:

```ts
describe("wordDiff", () => {
  it("identical lines have no ranges", () => {
    expect(wordDiff("a b", "a b")).toEqual({ old: [], new: [] });
  });
  it("marks the changed word only", () => {
    expect(wordDiff("const a = 1;", "const b = 1;")).toEqual({
      old: [{ start: 6, end: 7 }],
      new: [{ start: 6, end: 7 }],
    });
  });
  it("marks an inserted suffix on the new side only", () => {
    expect(wordDiff("foo()", "foo(bar)")).toEqual({ old: [], new: [{ start: 4, end: 7 }] });
  });
  it("merges adjacent changed tokens into one range", () => {
    expect(wordDiff("x", "a.b")).toEqual({
      old: [{ start: 0, end: 1 }],
      new: [{ start: 0, end: 3 }],
    });
  });
  it("whitespace-only changes mark the whitespace", () => {
    expect(wordDiff("a b", "a  b")).toEqual({
      old: [{ start: 1, end: 2 }],
      new: [{ start: 1, end: 3 }],
    });
  });
  it("treats unicode letters as word characters", () => {
    expect(wordDiff("héllo wörld", "héllo wørld")).toEqual({
      old: [{ start: 6, end: 11 }],
      new: [{ start: 6, end: 11 }],
    });
  });
  it("marks whole lines above WORD_DIFF_MAX_TOKENS tokens", () => {
    const long = Array.from({ length: WORD_DIFF_MAX_TOKENS + 1 }, (_, i) => `t${i}`).join(" ");
    expect(wordDiff(long, "x")).toEqual({
      old: [{ start: 0, end: long.length }],
      new: [{ start: 0, end: 1 }],
    });
  });
  it("an empty side has no range", () => {
    expect(wordDiff("", "abc")).toEqual({ old: [], new: [{ start: 0, end: 3 }] });
  });
});
```

`images.test.ts`:

```ts
it.each([
  "a.png",
  "b.JPG",
  "c.jpeg",
  "d.gif",
  "e.webp",
  "f.bmp",
  "g.ico",
  "h.avif",
  "dir.v2/i.PNG",
])("%s is an image", (p) => expect(isImagePath(p)).toBe(true));
it.each(["a.svg", "b.ts", "noext", "x.png.bak", ".png"])("%s is not an image", (p) =>
  expect(isImagePath(p)).toBe(false),
);
it("mimeFor maps extensions", () => {
  expect(mimeFor("a.png")).toBe("image/png");
  expect(mimeFor("a.JPG")).toBe("image/jpeg");
  expect(mimeFor("a.jpeg")).toBe("image/jpeg");
  expect(mimeFor("a.ico")).toBe("image/x-icon");
  expect(mimeFor("a.avif")).toBe("image/avif");
  expect(mimeFor("a.txt")).toBe("application/octet-stream");
});
```

`encoding.test.ts`:

```ts
it("labels every encoding", () => {
  expect(
    (["utf8", "utf16Le", "utf16Be", "utf32Le", "utf32Be"] as const).map(encodingLabel),
  ).toEqual(["UTF-8", "UTF-16 LE", "UTF-16 BE", "UTF-32 LE", "UTF-32 BE"]);
});
it("encodingNotice is null for ordinary diffs", () => {
  expect(encodingNotice(fileDiff([]))).toBeNull();
});
it("encodingNotice says decoded when both sides match or one is absent", () => {
  expect(encodingNotice(fileDiff([], { oldEncoding: "utf16Le", newEncoding: "utf16Le" }))).toBe(
    "Decoded from UTF-16 LE",
  );
  expect(encodingNotice(fileDiff([], { oldEncoding: null, newEncoding: "utf16Be" }))).toBe(
    "Decoded from UTF-16 BE",
  );
  expect(encodingNotice(fileDiff([], { oldEncoding: "utf32Le", newEncoding: null }))).toBe(
    "Decoded from UTF-32 LE",
  );
});
it("encodingNotice reports a change", () => {
  expect(encodingNotice(fileDiff([], { oldEncoding: "utf8", newEncoding: "utf16Le" }))).toBe(
    "Encoding changed from UTF-8 to UTF-16 LE",
  );
});
it("isDecoded is true when either side is set", () => {
  expect(isDecoded(fileDiff([]))).toBe(false);
  expect(isDecoded(fileDiff([], { newEncoding: "utf16Le" }))).toBe(true);
});
```

`limits.test.ts`: the three constants equal `20_000`, `1_000_000`, `400`; `totalLines` sums `hunk.lines.length` across hunks (0 for none).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/features/diff/model`
Expected: module-not-found failures.

- [ ] **Step 3: Implement**

`limits.ts`:

```ts
import type { FileDiff } from "../../../lib/ipc";
/** Above this many diff lines the viewer skips syntax highlighting. */
export const HIGHLIGHT_LIMIT = 20_000;
/** Line cap requested by "Load full diff". */
export const FULL_DIFF_LINES = 1_000_000;
/** Lines with more tokens than this are marked changed as a whole. */
export const WORD_DIFF_MAX_TOKENS = 400;
export function totalLines(diff: FileDiff): number {
  return diff.hunks.reduce((n, h) => n + h.lines.length, 0);
}
```

`pairing.ts`:

```ts
import type { DiffLine } from "../../../lib/ipc";
export interface LinePair {
  old: number | null;
  new: number | null;
}
/** Pairs a run of deletions with the addition run that follows it, per hunk. */
export function pairLines(lines: DiffLine[]): LinePair[] {
  const pairs: LinePair[] = [];
  let dels: number[] = [];
  let adds: number[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) pairs.push({ old: dels[k] ?? null, new: adds[k] ?? null });
    dels = [];
    adds = [];
  };
  lines.forEach((line, i) => {
    if (line.kind === "context") {
      flush();
      pairs.push({ old: i, new: i });
    } else if (line.kind === "deletion") {
      if (adds.length > 0) flush();
      dels.push(i);
    } else {
      adds.push(i);
    }
  });
  flush();
  return pairs;
}
```

`rows.ts`:

```ts
import type { FileDiff } from "../../../lib/ipc";
import type { DiffMode } from "../../../lib/store/diffPrefs";
import { pairLines } from "./pairing";

export type DiffRow =
  | { kind: "header"; key: string; hunkIndex: number; header: string }
  | { kind: "unified"; key: string; hunkIndex: number; lineIndex: number; partner: number | null }
  | { kind: "split"; key: string; hunkIndex: number; old: number | null; new: number | null };

/** Flattens a diff into virtualizable rows; `partner` links the two halves of an edited line. */
export function buildRows(diff: FileDiff, mode: DiffMode): DiffRow[] {
  const rows: DiffRow[] = [];
  diff.hunks.forEach((hunk, hunkIndex) => {
    rows.push({ kind: "header", key: `h${hunkIndex}`, hunkIndex, header: hunk.header });
    const pairs = pairLines(hunk.lines);
    if (mode === "split") {
      for (const p of pairs) {
        rows.push({
          kind: "split",
          key: `s${hunkIndex}:${p.old ?? "-"}:${p.new ?? "-"}`,
          hunkIndex,
          old: p.old,
          new: p.new,
        });
      }
      return;
    }
    const partner = new Map<number, number>();
    for (const p of pairs) {
      if (p.old !== null && p.new !== null && p.old !== p.new) {
        partner.set(p.old, p.new);
        partner.set(p.new, p.old);
      }
    }
    hunk.lines.forEach((_, lineIndex) => {
      rows.push({
        kind: "unified",
        key: `u${hunkIndex}:${lineIndex}`,
        hunkIndex,
        lineIndex,
        partner: partner.get(lineIndex) ?? null,
      });
    });
  });
  return rows;
}
```

`wordDiff.ts`:

```ts
import { WORD_DIFF_MAX_TOKENS } from "./limits";

export interface Range {
  start: number;
  end: number;
}
export interface WordDiff {
  old: Range[];
  new: Range[];
}

const TOKEN = /[\p{L}\p{N}_]+|\s+|./gu;

function tokens(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

function whole(s: string): Range[] {
  return s.length === 0 ? [] : [{ start: 0, end: s.length }];
}

/** Converts per-token "changed" flags into merged character ranges. */
function ranges(toks: string[], changed: boolean[]): Range[] {
  const out: Range[] = [];
  let offset = 0;
  toks.forEach((t, i) => {
    const end = offset + t.length;
    if (changed[i]) {
      const last = out[out.length - 1];
      if (last && last.end === offset) last.end = end;
      else out.push({ start: offset, end });
    }
    offset = end;
  });
  return out;
}

/** Character ranges that differ between two lines, by token-level LCS. */
export function wordDiff(a: string, b: string): WordDiff {
  if (a === b) return { old: [], new: [] };
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length > WORD_DIFF_MAX_TOKENS || tb.length > WORD_DIFF_MAX_TOKENS) {
    return { old: whole(a), new: whole(b) };
  }
  const n = ta.length;
  const m = tb.length;
  const w = m + 1;
  // dp[i*w + j] = LCS length of ta[i..] and tb[j..]
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        ta[i] === tb[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const keepA = new Array<boolean>(n).fill(true);
  const keepB = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      keepA[i] = false;
      keepB[j] = false;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { old: ranges(ta, keepA), new: ranges(tb, keepB) };
}
```

(`keepA[i] === true` means "changed"; the name is inverted on purpose so the fill is `true`. Rename to `changedA` if the reviewer prefers.)

`images.ts`:

```ts
export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
] as const;
const MIME: Record<(typeof IMAGE_EXTENSIONS)[number], string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};
function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
}
function isImageExtension(ext: string): ext is (typeof IMAGE_EXTENSIONS)[number] {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}
/** Whether the viewer should preview `path` as an image (SVG diffs as text). */
export function isImagePath(path: string): boolean {
  const ext = extensionOf(path);
  return ext !== null && isImageExtension(ext);
}
export function mimeFor(path: string): string {
  const ext = extensionOf(path);
  return ext !== null && isImageExtension(ext) ? MIME[ext] : "application/octet-stream";
}
```

`encoding.ts`:

```ts
import type { FileDiff, TextEncoding } from "../../../lib/ipc";
const LABELS: Record<TextEncoding, string> = {
  utf8: "UTF-8",
  utf16Le: "UTF-16 LE",
  utf16Be: "UTF-16 BE",
  utf32Le: "UTF-32 LE",
  utf32Be: "UTF-32 BE",
};
export function encodingLabel(e: TextEncoding): string {
  return LABELS[e];
}
export function isDecoded(diff: FileDiff): boolean {
  return diff.oldEncoding !== null || diff.newEncoding !== null;
}
/** Toolbar text for a decoded diff, or null for an ordinary one. */
export function encodingNotice(diff: FileDiff): string | null {
  const { oldEncoding, newEncoding } = diff;
  if (oldEncoding === null && newEncoding === null) return null;
  if (oldEncoding === null || newEncoding === null || oldEncoding === newEncoding) {
    return `Decoded from ${encodingLabel((newEncoding ?? oldEncoding) as TextEncoding)}`;
  }
  return `Encoding changed from ${encodingLabel(oldEncoding)} to ${encodingLabel(newEncoding)}`;
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npm test -- src/features/diff && npm run lint && npm run typecheck`
Expected: pass; every model file at 100 %.

- [ ] **Step 5: Commit**

```bash
git rm -q src/features/diff/.gitkeep
git add src/features/diff
git commit -m "feat(ui): diff row model, pairing, word diff and helpers"
```

---

### Task 7: Front end — Lezer highlighting model and `useHighlight`

**Files:**

- Create: `src/features/diff/model/highlight.ts`, `src/features/diff/useHighlight.ts`
- Test: `src/features/diff/model/highlight.test.ts`, `src/features/diff/useHighlight.test.tsx`

**Interfaces:**

- Consumes: `Hunk`, `FileDiff` from `src/lib/ipc`; `HIGHLIGHT_LIMIT`, `totalLines` (Task 6); `LanguageDescription`, `languages` from `@codemirror/language-data`; `highlightTree`, `classHighlighter` from `@lezer/highlight`; `Parser` type from `@lezer/common` (transitive dependency; import the type only).
- Produces:
  - `interface Token { text: string; className: string | null }`
  - `languageFor(path: string): LanguageDescription | null`
  - `tokenize(text: string, parser: Parser): Token[][]` (one array per line, `text.split("\n")`)
  - `sideText(hunk: Hunk, side: "old" | "new"): { text: string; lineIndices: number[] }`
  - `highlightHunk(hunk: Hunk, parser: Parser): (Token[] | null)[]` indexed like `hunk.lines`
  - `type HighlightMap = Map<number, (Token[] | null)[]>` keyed by hunk index
  - `useHighlight(diff: FileDiff | undefined): HighlightMap | null`
  - `loadParser(desc: LanguageDescription): Promise<Parser>` (module-level promise cache; exported for tests to pre-warm)

- [ ] **Step 1: Write the failing tests**

`highlight.test.ts` (uses the real JavaScript grammar, which `@codemirror/language-data` depends on):

```ts
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { describe, expect, it } from "vitest";
import { highlightHunk, languageFor, sideText, tokenize } from "./highlight";
import { L, hunk } from "./testFixtures";

const parser = javascriptLanguage.parser;

describe("languageFor", () => {
  it("matches by extension and is null for unknown names", () => {
    expect(languageFor("src/app.ts")?.name).toBe("TypeScript");
    expect(languageFor("main.rs")?.name).toBe("Rust");
    expect(languageFor("README.md")?.name).toBe("Markdown");
    expect(languageFor("Makefile.weird-ext")).toBeNull();
    expect(languageFor("noext")).toBeNull();
  });
});

describe("tokenize", () => {
  it("returns one token array per line, concatenating back to the line", () => {
    const lines = tokenize("const a = 1;\n// c\n", parser);
    expect(lines).toHaveLength(3);
    expect(lines[0].map((t) => t.text).join("")).toBe("const a = 1;");
    expect(lines[2]).toEqual([]);
  });
  it("classifies keywords, numbers and comments", () => {
    const [first, second] = tokenize("const a = 1;\n// c", parser);
    expect(first.find((t) => t.text === "const")?.className).toContain("tok-");
    expect(first.find((t) => t.text === "1")?.className).toBe("tok-number");
    expect(second[0]).toEqual({ text: "// c", className: "tok-lineComment" });
  });
  it("gives plain text a null class", () => {
    const [line] = tokenize("a", parser);
    expect(line.some((t) => t.className === null) || line.every((t) => t.className !== null)).toBe(
      true,
    );
    expect(tokenize("", parser)).toEqual([[]]);
  });
  it("a multi-line comment spans lines", () => {
    const [a, b] = tokenize("/* x\ny */", parser);
    expect(a[0].className).toBe("tok-blockComment");
    expect(b[0].className).toBe("tok-blockComment");
  });
});

describe("sideText", () => {
  const h = hunk([
    L("context", "c0"),
    L("deletion", "d1"),
    L("addition", "a2"),
    L("context", "c3"),
  ]);
  it("old side is context plus deletions", () => {
    expect(sideText(h, "old")).toEqual({ text: "c0\nd1\nc3", lineIndices: [0, 1, 3] });
  });
  it("new side is context plus additions", () => {
    expect(sideText(h, "new")).toEqual({ text: "c0\na2\nc3", lineIndices: [0, 2, 3] });
  });
});

describe("highlightHunk", () => {
  it("maps tokens back to every hunk line", () => {
    const h = hunk([L("context", "let x = 1;"), L("deletion", "// old"), L("addition", "// new")]);
    const out = highlightHunk(h, parser);
    expect(out).toHaveLength(3);
    expect(out[0]?.map((t) => t.text).join("")).toBe("let x = 1;");
    expect(out[1]?.[0]).toEqual({ text: "// old", className: "tok-lineComment" });
    expect(out[2]?.[0]).toEqual({ text: "// new", className: "tok-lineComment" });
  });
});
```

`useHighlight.test.tsx`:

```ts
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fileDiff, hunk, L } from "./model/testFixtures";
import { HIGHLIGHT_LIMIT } from "./model/limits";
import { useHighlight } from "./useHighlight";

describe("useHighlight", () => {
  it("is null without a diff, for binary diffs and for unknown languages", () => {
    expect(renderHook(() => useHighlight(undefined)).result.current).toBeNull();
    expect(
      renderHook(() => useHighlight(fileDiff([hunk([L("context", "x")])], { isBinary: true })))
        .result.current,
    ).toBeNull();
    expect(
      renderHook(() => useHighlight(fileDiff([hunk([L("context", "x")])], { path: "noext" })))
        .result.current,
    ).toBeNull();
  });
  it("highlights every hunk once the language loads", async () => {
    const diff = fileDiff([hunk([L("addition", "const a = 1;")]), hunk([L("deletion", "// c")])], {
      path: "a.js",
    });
    const { result } = renderHook(() => useHighlight(diff));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.get(0)?.[0]?.find((t) => t.text === "1")?.className).toBe("tok-number");
    expect(result.current?.get(1)?.[0]?.[0]?.className).toBe("tok-lineComment");
  });
  it("skips diffs above HIGHLIGHT_LIMIT lines", async () => {
    const lines = Array.from({ length: HIGHLIGHT_LIMIT + 1 }, () => L("context", "x"));
    const { result } = renderHook(() => useHighlight(fileDiff([hunk(lines)], { path: "a.js" })));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });
  it("ignores a load that finishes after the diff changed", async () => {
    const a = fileDiff([hunk([L("addition", "a"), L("addition", "b")])], { path: "a.js" });
    const b = fileDiff([hunk([L("addition", "c")])], { path: "b.js" });
    const { result, rerender } = renderHook(({ d }) => useHighlight(d), { initialProps: { d: a } });
    rerender({ d: b });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.get(0)).toHaveLength(1); // b's single line, not a's two
  });
  it("returns null again when a language fails to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mod = await import("./model/highlight");
    vi.spyOn(mod, "loadParser").mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() =>
      useHighlight(fileDiff([hunk([L("context", "x")])], { path: "z.js" })),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });
});
```

(If `vi.spyOn` on an ESM export is refused, use `vi.mock(import("./model/highlight"), importOriginal)` and override `loadParser` for that test file.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/features/diff`
Expected: module-not-found.

- [ ] **Step 3: Implement**

`model/highlight.ts`:

```ts
import { LanguageDescription, languages } from "@codemirror/language-data";
import type { Parser } from "@lezer/common";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import type { Hunk } from "../../../lib/ipc";

export interface Token {
  text: string;
  className: string | null;
}

/** Picks a grammar from the file name; null when CodeMirror has none for it. */
export function languageFor(path: string): LanguageDescription | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return LanguageDescription.matchFilename(languages, name);
}

const parsers = new Map<string, Promise<Parser>>();

/** Loads a language's parser once; later calls share the promise. */
export function loadParser(desc: LanguageDescription): Promise<Parser> {
  let p = parsers.get(desc.name);
  if (!p) {
    p = desc.load().then((support) => support.language.parser);
    parsers.set(desc.name, p);
  }
  return p;
}

/** Parses `text` once and splits the highlighted spans into per-line tokens. */
export function tokenize(text: string, parser: Parser): Token[][] {
  const tree = parser.parse(text);
  const lines: Token[][] = text.split("\n").map(() => []);
  const starts: number[] = [];
  let acc = 0;
  for (const line of text.split("\n")) {
    starts.push(acc);
    acc += line.length + 1;
  }
  let lineNo = 0;
  let pos = 0;
  const emit = (from: number, to: number, className: string | null) => {
    while (from < to) {
      while (lineNo + 1 < starts.length && from >= starts[lineNo + 1]) lineNo++;
      const lineEnd = lineNo + 1 < starts.length ? starts[lineNo + 1] - 1 : text.length;
      const end = Math.min(to, lineEnd);
      if (end > from) lines[lineNo].push({ text: text.slice(from, end), className });
      from = end < to ? end + 1 : end; // skip the newline
    }
  };
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > pos) emit(pos, from, null);
    emit(from, to, classes);
    pos = to;
  });
  if (pos < text.length) emit(pos, text.length, null);
  return lines;
}

/** One side of a hunk as a single text, with the hunk line index of each text line. */
export function sideText(hunk: Hunk, side: "old" | "new"): { text: string; lineIndices: number[] } {
  const skip = side === "old" ? "addition" : "deletion";
  const lineIndices: number[] = [];
  const parts: string[] = [];
  hunk.lines.forEach((line, i) => {
    if (line.kind === skip) return;
    lineIndices.push(i);
    parts.push(line.content);
  });
  return { text: parts.join("\n"), lineIndices };
}

/** Tokens for every hunk line; context lines take the new side's tokens. */
export function highlightHunk(hunk: Hunk, parser: Parser): (Token[] | null)[] {
  const out: (Token[] | null)[] = hunk.lines.map(() => null);
  for (const side of ["old", "new"] as const) {
    const { text, lineIndices } = sideText(hunk, side);
    const lines = tokenize(text, parser);
    lineIndices.forEach((lineIndex, k) => {
      out[lineIndex] = lines[k] ?? [];
    });
  }
  return out;
}
```

`useHighlight.ts`:

```ts
import { useEffect, useState } from "react";
import type { FileDiff } from "../../lib/ipc";
import { highlightHunk, languageFor, loadParser, type Token } from "./model/highlight";
import { HIGHLIGHT_LIMIT, totalLines } from "./model/limits";

export type HighlightMap = Map<number, (Token[] | null)[]>;

/** Syntax tokens per hunk, or null while loading / when highlighting is skipped. */
export function useHighlight(diff: FileDiff | undefined): HighlightMap | null {
  const [state, setState] = useState<{ diff: FileDiff; map: HighlightMap } | null>(null);
  useEffect(() => {
    if (!diff || diff.isBinary || totalLines(diff) > HIGHLIGHT_LIMIT) return;
    const desc = languageFor(diff.path);
    if (!desc) return;
    let active = true;
    loadParser(desc)
      .then((parser) => {
        if (!active) return;
        const map: HighlightMap = new Map();
        diff.hunks.forEach((hunk, i) => map.set(i, highlightHunk(hunk, parser)));
        setState({ diff, map });
      })
      .catch((e: unknown) => {
        console.error("language load failed", e);
      });
    return () => {
      active = false;
    };
  }, [diff]);
  return state !== null && state.diff === diff ? state.map : null;
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npm test -- src/features/diff && npm run lint && npm run typecheck`
Expected: pass at 100 % for both files. If `tokenize` leaves an uncovered branch, add a test for text with no trailing newline and one with `\n` only.

- [ ] **Step 5: Commit**

```bash
git add src/features/diff
git commit -m "feat(ui): Lezer-based per-hunk syntax highlighting"
```

---

### Task 8: Front end hooks — `useFileDiff`, `useFileContent`, `useLineSelection`

**Files:**

- Create: `src/features/diff/useFileDiff.ts`, `useFileContent.ts`, `useLineSelection.ts`
- Test: `src/features/diff/useFileDiff.test.tsx`, `useFileContent.test.tsx`, `useLineSelection.test.ts`

**Interfaces:**

- Consumes: `getFileDiff`, `getFileContent`, `toAppError` from `src/lib/ipc`; `queryKeys` (Task 5); `SelectedFile` from `src/lib/store/workspace`.
- Produces:
  - `useFileDiff(repoId, file: SelectedFile | null, ignoreWhitespace: boolean, maxLines: number | null): { diff: FileDiff | undefined; error: AppError | null; loading: boolean; noChanges: boolean; refetch(): void }`
  - `useFileContent(repoId, path: string, scope: DiffScope, side: DiffSide, enabled: boolean): { bytes: ArrayBuffer | undefined; error: AppError | null; loading: boolean }`
  - `interface UseLineSelection { selected: ReadonlySet<number>; hunkIndex: number | null; click(hunk: number, line: number, shift: boolean): void; clear(): void }`, `useLineSelection(diff: FileDiff | undefined): UseLineSelection`

- [ ] **Step 1: Write the failing tests**

`useFileDiff.test.tsx` (mock `getFileDiff` with the `vi.mock(import("../../lib/ipc"))` recipe; render with `renderHookWithProviders`):

- disabled when `file` is null: `getFileDiff` not called, `loading` false, `diff` undefined.
- calls `getFileDiff(repoId, path, scope, ignoreWs, maxLines ?? undefined)` — with `maxLines` null it passes `undefined` (so the wrapper sends `null`); with `1_000_000` it passes `1_000_000`.
- resolves `diff`; `noChanges` false.
- rejection `{kind:"noChanges"}` → `noChanges` true, `error` null, `diff` undefined.
- rejection `{kind:"git"}` → `error.kind === "git"`, `noChanges` false; non-AppError rejection (`new Error("x")`) → `error.kind === "io"`.
- does not retry: a rejecting mock is called exactly once.
- `refetch()` calls `getFileDiff` again.
- changing `ignoreWhitespace` or `maxLines` triggers a new call with the new arguments (distinct keys).

`useFileContent.test.tsx`:

- `enabled: false` → no call. `enabled: true` → `getFileContent(repoId, path, scope, side)` once; `bytes` is the resolved buffer.
- `{kind:"tooLarge"}` rejection → `error.kind === "tooLarge"`, called once (no retry).

`useLineSelection.test.ts` (use `renderHook` from Testing Library):

```ts
const d = fileDiff([
  hunk([
    L("context", "c"),
    L("deletion", "a"),
    L("addition", "b"),
    L("addition", "c"),
    L("context", "e"),
  ]),
  hunk([L("addition", "z")]),
]);
```

- initial: `selected` empty, `hunkIndex` null.
- `click(0, 1, false)` selects {1} in hunk 0; clicking again deselects and leaves `hunkIndex` 0 with an empty set.
- clicking a context line (`click(0, 0, false)`) is ignored.
- `click(0, 1, false)` then `click(0, 3, true)` selects {1, 2, 3} (changed lines between anchor and target, inclusive, context skipped).
- shift-click with no anchor acts like a plain click.
- `click(1, 0, false)` after a selection in hunk 0 replaces it: `selected` is {0}, `hunkIndex` 1.
- `clear()` empties the set and resets `hunkIndex` to null.
- a new `diff` identity (rerender with a structurally equal clone) resets the selection.
- `selected` is a new `Set` instance after each change (referential update for memoisation).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/features/diff`
Expected: module-not-found.

- [ ] **Step 3: Implement**

`useFileDiff.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { getFileDiff, toAppError } from "../../lib/ipc";
import type { AppError, FileDiff, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import type { SelectedFile } from "../../lib/store/workspace";

export interface UseFileDiff {
  diff: FileDiff | undefined;
  error: AppError | null;
  loading: boolean;
  /** The file has no changes in this scope (e.g. its last hunk was just staged). */
  noChanges: boolean;
  refetch(): void;
}

export function useFileDiff(
  repoId: RepoId,
  file: SelectedFile | null,
  ignoreWhitespace: boolean,
  maxLines: number | null,
): UseFileDiff {
  const path = file?.path ?? "";
  const scope = file?.scope ?? "unstaged";
  const query = useQuery<FileDiff, AppError>({
    queryKey: queryKeys.fileDiff(repoId, path, scope, ignoreWhitespace, maxLines),
    queryFn: () =>
      getFileDiff(repoId, path, scope, ignoreWhitespace, maxLines ?? undefined).catch(
        (e: unknown) => {
          throw toAppError(e);
        },
      ),
    enabled: file !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const noChanges = query.error?.kind === "noChanges";
  return {
    diff: query.data,
    error: noChanges ? null : (query.error ?? null),
    loading: file !== null && query.isPending,
    noChanges,
    refetch: () => void query.refetch(),
  };
}
```

`useFileContent.ts`: same shape with `queryKeys.fileContent`, `getFileContent(repoId, path, scope, side)`, `enabled`, `retry: false`, returning `{ bytes: query.data, error: query.error ?? null, loading: enabled && query.isPending }`.

`useLineSelection.ts`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff } from "../../lib/ipc";

export interface UseLineSelection {
  selected: ReadonlySet<number>;
  hunkIndex: number | null;
  click(hunk: number, line: number, shift: boolean): void;
  clear(): void;
}

interface State {
  hunkIndex: number | null;
  anchor: number | null;
  selected: ReadonlySet<number>;
}
const EMPTY: State = { hunkIndex: null, anchor: null, selected: new Set() };

/** Selection of changed lines inside one hunk; resets whenever `diff` changes identity. */
export function useLineSelection(diff: FileDiff | undefined): UseLineSelection {
  const [state, setState] = useState<State>(EMPTY);
  const last = useRef(diff);
  useEffect(() => {
    if (last.current !== diff) {
      last.current = diff;
      setState(EMPTY);
    }
  }, [diff]);

  const click = useCallback(
    (hunk: number, line: number, shift: boolean) => {
      const lines = diff?.hunks[hunk]?.lines;
      if (!lines || lines[line]?.kind === "context") return;
      setState((prev) => {
        if (prev.hunkIndex !== hunk)
          return { hunkIndex: hunk, anchor: line, selected: new Set([line]) };
        if (shift && prev.anchor !== null) {
          const [lo, hi] = prev.anchor < line ? [prev.anchor, line] : [line, prev.anchor];
          const next = new Set(prev.selected);
          for (let i = lo; i <= hi; i++) if (lines[i].kind !== "context") next.add(i);
          return { ...prev, selected: next };
        }
        const next = new Set(prev.selected);
        if (next.has(line)) next.delete(line);
        else next.add(line);
        return { hunkIndex: hunk, anchor: line, selected: next };
      });
    },
    [diff],
  );
  const clear = useCallback(() => setState(EMPTY), []);
  return useMemo(
    () => ({ selected: state.selected, hunkIndex: state.hunkIndex, click, clear }),
    [state, click, clear],
  );
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npm test -- src/features/diff && npm run lint && npm run typecheck`
Expected: pass at 100 %.

- [ ] **Step 5: Commit**

```bash
git add src/features/diff
git commit -m "feat(ui): diff data hooks and hunk line selection"
```

---

### Task 9: Front end components — `LineContent`, `UnifiedRow`, `SplitRow`, `HunkHeader`, `DiffViewer`

**Files:**

- Create: `src/features/diff/LineContent.tsx` (+ `.module.css`), `UnifiedRow.tsx`, `SplitRow.tsx`, `DiffRows.module.css` (shared by both row components), `HunkHeader.tsx` (+ `.module.css`), `DiffViewer.tsx` (+ `.module.css`)
- Test: `src/features/diff/LineContent.test.tsx`, `UnifiedRow.test.tsx`, `SplitRow.test.tsx`, `HunkHeader.test.tsx`, `DiffViewer.test.tsx`
- Create: `src/test/mockVirtualizer.ts` (shared test helper that mocks `@tanstack/react-virtual` to render every row)

**Interfaces:**

- Consumes: `DiffRow`, `buildRows`, `wordDiff`, `Range`, `Token`, `HighlightMap`, `UseLineSelection`, `DiffMode`, `FileDiff`, `HunkAction`, `HunkSelection`.
- Produces:
  - `LineContent({ text, tokens, ranges, noNewlineAtEof }: { text: string; tokens: Token[] | null; ranges: Range[]; noNewlineAtEof: boolean })`
  - `UnifiedRow({ diff, row, highlight, selection, onGutterClick }: { diff: FileDiff; row: Extract<DiffRow, { kind: "unified" }>; highlight: HighlightMap | null; selection?: UseLineSelection; onGutterClick(hunk: number, line: number, shift: boolean): void })`
  - `SplitRow` with the same props for `kind: "split"` rows
  - `HunkHeader({ header, scope, selectedCount, disabledReason, onAction }: { header: string; scope: DiffScope; selectedCount: number; disabledReason?: string; onAction?(action: HunkAction): void })` — `onAction` absent → no buttons.
  - `DiffViewer({ diff, mode, highlight, selection, onHunkAction, actionsDisabledReason }: { diff: FileDiff; mode: DiffMode; highlight: HighlightMap | null; selection?: UseLineSelection; onHunkAction?(action: HunkAction, selection: HunkSelection): void; actionsDisabledReason?: string })`
  - `src/test/mockVirtualizer.ts`: `export function mockVirtualizer(): void` that calls `vi.mock("@tanstack/react-virtual", ...)` returning a `useVirtualizer` whose `getVirtualItems()` lists every index with `{ index, key: index, start: index * 22, size: 22, measureElement: () => undefined }`, `getTotalSize()` = `count * 22`, and `measureElement` a no-op. (Because `vi.mock` is hoisted, the helper must be a file whose import performs the mock: `import "../../test/mockVirtualizer"` at the top of each component test.)

- [ ] **Step 1: Write the failing tests**

`LineContent.test.tsx`:

- renders plain text when `tokens` is null, inside a `<code>` element.
- renders tokens as spans with their `className` (`tok-number`) and no class for null.
- wraps word-diff ranges in `<mark>`: `text "const b = 1"`, range `{6,7}` → the mark contains exactly `b`; a range crossing a token boundary splits the token so the mark still contains exactly the range text.
- an empty line renders a non-breaking space so the row keeps its height.
- `noNewlineAtEof` appends a span with text `⏎` and `title="No newline at end of file"`.

`UnifiedRow.test.tsx` / `SplitRow.test.tsx`:

- unified: a deletion row shows the old line number in the first gutter and an empty second gutter, with `data-kind="deletion"` on the row; an addition shows only the new number; context shows both.
- changed-line gutters are `<button aria-pressed="false">` with `aria-label` `"Select line {n}"` (old number for deletions, new for additions); context gutters are plain cells with no button.
- clicking a gutter calls `onGutterClick(hunkIndex, lineIndex, shiftKey)`; with `shiftKey: true` via `fireEvent.click(btn, { shiftKey: true })`.
- a selected line (`selection.selected.has(lineIndex)` and `selection.hunkIndex === row.hunkIndex`) has `aria-pressed="true"` and `data-selected="true"`.
- word diff: for a unified row whose `partner` is set, the deletion's `<mark>` contains the changed old text and the addition's contains the new; for a row with `partner: null` there is no `<mark>`.
- split: a row with `old: null` renders an empty left cell with `data-kind="empty"`; both cells use their own line numbers; both-sided changed rows get marks on both sides; context pairs get none.
- highlight tokens from `highlight.get(hunkIndex)?.[lineIndex]` are passed through (a `tok-number` span appears when provided; plain text when the map is null).

`HunkHeader.test.tsx`:

- renders the header text in a `<th>`-free `role="row"` / plain div with `data-kind="header"`.
- unstaged, 0 selected: buttons "Stage hunk" and "Discard hunk…"; staged: only "Unstage hunk".
- unstaged, 3 selected: "Stage 3 lines" and "Discard 3 lines…"; staged, 1 selected: "Unstage 1 line" (singular when `n === 1`; the same rule applies to all three labels).
- clicking calls `onAction("stage" | "unstage" | "discard")`.
- `disabledReason` disables every button and sets `title` to the reason.
- no `onAction` → no buttons at all.

`DiffViewer.test.tsx` (imports `../../test/mockVirtualizer` first):

- renders every row of `buildRows(diff, mode)` in order: headers then lines; unified vs split chosen by `mode`.
- has `role="region"` with `aria-label="Diff"` and the scroll container has `data-testid="diff-scroll"`.
- gutter clicks route to `selection.click`.
- hunk button "Stage hunk" calls `onHunkAction("stage", { hunkIndex, lines: null })`; with a selection in that hunk `{ lines: [1, 2] }` sorted ascending; a selection in another hunk does not affect this hunk's buttons (they show the whole-hunk labels).
- `actionsDisabledReason` reaches every header.
- without `onHunkAction` no buttons render and gutters are still clickable only if `selection` is provided; without `selection` gutters are plain cells.
- `highlight` map tokens appear in rows.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/features/diff`
Expected: module-not-found.

- [ ] **Step 3: Implement**

`LineContent.tsx`:

```tsx
import type { Range } from "./model/wordDiff";
import type { Token } from "./model/highlight";
import styles from "./LineContent.module.css";

interface Props {
  text: string;
  tokens: Token[] | null;
  ranges: Range[];
  noNewlineAtEof: boolean;
}

interface Piece {
  text: string;
  className: string | null;
  marked: boolean;
}

/** Splits tokens at word-diff boundaries so each piece is wholly marked or not. */
function pieces(text: string, tokens: Token[] | null, ranges: Range[]): Piece[] {
  const toks = tokens ?? [{ text, className: null }];
  const cuts = new Set<number>([0, text.length]);
  let off = 0;
  for (const t of toks) {
    off += t.text.length;
    cuts.add(off);
  }
  for (const r of ranges) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  const bounds = [...cuts].sort((a, b) => a - b);
  const out: Piece[] = [];
  let ti = 0;
  let tokEnd = toks[0]?.text.length ?? 0;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [s, e] = [bounds[i], bounds[i + 1]];
    while (s >= tokEnd && ti + 1 < toks.length) {
      ti++;
      tokEnd += toks[ti].text.length;
    }
    out.push({
      text: text.slice(s, e),
      className: toks[ti]?.className ?? null,
      marked: ranges.some((r) => s >= r.start && e <= r.end),
    });
  }
  return out;
}

export function LineContent({ text, tokens, ranges, noNewlineAtEof }: Props) {
  const parts = text.length === 0 ? [] : pieces(text, tokens, ranges);
  return (
    <code className={styles.code}>
      {parts.length === 0 ? " " : null}
      {parts.map((p, i) => {
        const span = (
          <span key={i} className={p.className ?? undefined}>
            {p.text}
          </span>
        );
        return p.marked ? (
          <mark key={i} className={styles.word}>
            {span}
          </mark>
        ) : (
          span
        );
      })}
      {noNewlineAtEof && (
        <span className={styles.eof} title="No newline at end of file">
          ⏎
        </span>
      )}
    </code>
  );
}
```

`LineContent.module.css`: `.code { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; line-height: 1.4; }`, `.word { background: var(--word-bg, transparent); color: inherit; border-radius: 2px; }`, `.eof { color: var(--color-text-muted); margin-left: 4px; }`. Rows set `--word-bg` to the added or removed word token.

`UnifiedRow.tsx`:

```tsx
import type { FileDiff } from "../../lib/ipc";
import type { HighlightMap } from "./useHighlight";
import type { UseLineSelection } from "./useLineSelection";
import type { DiffRow } from "./model/rows";
import { wordDiff } from "./model/wordDiff";
import { LineContent } from "./LineContent";
import styles from "./DiffRows.module.css";

type Row = Extract<DiffRow, { kind: "unified" }>;
interface Props {
  diff: FileDiff;
  row: Row;
  highlight: HighlightMap | null;
  selection?: UseLineSelection;
  onGutterClick?(hunk: number, line: number, shift: boolean): void;
}

export function Gutter({
  lineno,
  selectable,
  pressed,
  label,
  onClick,
}: {
  lineno: number | null;
  selectable: boolean;
  pressed: boolean;
  label: string;
  onClick?(shift: boolean): void;
}) {
  if (!selectable || !onClick) return <span className={styles.gutter}>{lineno ?? ""}</span>;
  return (
    <button
      type="button"
      className={styles.gutterButton}
      aria-pressed={pressed}
      aria-label={label}
      onClick={(e) => onClick(e.shiftKey)}
    >
      {lineno ?? ""}
    </button>
  );
}

export function UnifiedRow({ diff, row, highlight, selection, onGutterClick }: Props) {
  const hunk = diff.hunks[row.hunkIndex];
  const line = hunk.lines[row.lineIndex];
  const changed = line.kind !== "context";
  const selected = selection?.hunkIndex === row.hunkIndex && selection.selected.has(row.lineIndex);
  const partner = row.partner === null ? null : hunk.lines[row.partner];
  const ranges = partner
    ? line.kind === "deletion"
      ? wordDiff(line.content, partner.content).old
      : wordDiff(partner.content, line.content).new
    : [];
  const tokens = highlight?.get(row.hunkIndex)?.[row.lineIndex] ?? null;
  const number = line.kind === "deletion" ? line.oldLineno : line.newLineno;
  const click =
    onGutterClick && changed
      ? (shift: boolean) => onGutterClick(row.hunkIndex, row.lineIndex, shift)
      : undefined;
  return (
    <div
      className={styles.row}
      data-kind={line.kind}
      data-selected={selected || undefined}
      role="row"
    >
      <Gutter
        lineno={line.oldLineno}
        selectable={changed}
        pressed={selected}
        label={`Select line ${number}`}
        onClick={click}
      />
      <Gutter lineno={line.newLineno} selectable={false} pressed={false} label="" />
      <span className={styles.sign}>
        {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}
      </span>
      <LineContent
        text={line.content}
        tokens={tokens}
        ranges={ranges}
        noNewlineAtEof={line.noNewlineAtEof}
      />
    </div>
  );
}
```

(Only the first gutter is a button in unified mode: one control per line.) `SplitRow.tsx` follows the same pattern with two cells, each `<Gutter>` + `<LineContent>`; an absent side renders `<div className={styles.cell} data-kind="empty" />`; a both-sided row whose indices differ computes `wordDiff(old.content, new.content)` once and passes `.old` to the left and `.new` to the right. Export `Gutter` from `UnifiedRow.tsx` and import it in `SplitRow.tsx`.

`DiffRows.module.css`: `.row { display: grid; grid-template-columns: 3.5em 3.5em 1.2em 1fr; align-items: start; }`, `.row[data-kind="addition"] { background: var(--color-added-bg); --word-bg: var(--color-added-word-bg); }`, `.row[data-kind="deletion"] { background: var(--color-removed-bg); --word-bg: var(--color-removed-word-bg); }`, `.row[data-selected] { outline: 2px solid var(--color-accent); outline-offset: -2px; background: var(--color-line-selected); }`, `.gutter, .gutterButton { text-align: right; padding: 0 6px; color: var(--color-text-muted); font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; font-size: 0.75rem; line-height: 1.5; user-select: none; }`, `.gutterButton { background: none; border: 0; cursor: pointer; width: 100%; }`, `.gutterButton:hover { color: var(--color-text); }`, `.sign { text-align: center; color: var(--color-text-muted); }`, `.split { display: grid; grid-template-columns: 1fr 1fr; }`, `.cell { display: grid; grid-template-columns: 3.5em 1fr; min-width: 0; }`, `.cell[data-kind="addition"]`, `.cell[data-kind="deletion"]`, `.cell[data-kind="empty"] { background: var(--color-surface-hover); }`, `.cell[data-selected]` as for rows.

`HunkHeader.tsx`:

```tsx
import type { DiffScope, HunkAction } from "../../lib/ipc";
import styles from "./HunkHeader.module.css";

interface Props {
  header: string;
  scope: DiffScope;
  selectedCount: number;
  disabledReason?: string;
  onAction?(action: HunkAction): void;
}

function label(verb: string, n: number, ellipsis = ""): string {
  if (n === 0) return `${verb} hunk${ellipsis}`;
  return `${verb} ${n} ${n === 1 ? "line" : "lines"}${ellipsis}`;
}

export function HunkHeader({ header, scope, selectedCount, disabledReason, onAction }: Props) {
  const button = (action: HunkAction, text: string, danger = false) => (
    <button
      type="button"
      className={danger ? styles.danger : styles.action}
      disabled={disabledReason !== undefined}
      title={disabledReason}
      onClick={() => onAction?.(action)}
    >
      {text}
    </button>
  );
  return (
    <div className={styles.root} data-kind="header" role="row">
      <code className={styles.text}>{header}</code>
      {onAction && (
        <div className={styles.actions}>
          {scope === "unstaged" ? (
            <>
              {button("stage", label("Stage", selectedCount))}
              {button("discard", label("Discard", selectedCount, "…"), true)}
            </>
          ) : (
            button("unstage", label("Unstage", selectedCount))
          )}
        </div>
      )}
    </div>
  );
}
```

`DiffViewer.tsx`:

```tsx
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import type { FileDiff, HunkAction, HunkSelection } from "../../lib/ipc";
import type { DiffMode } from "../../lib/store/diffPrefs";
import { HunkHeader } from "./HunkHeader";
import { buildRows } from "./model/rows";
import { SplitRow } from "./SplitRow";
import { UnifiedRow } from "./UnifiedRow";
import type { HighlightMap } from "./useHighlight";
import type { UseLineSelection } from "./useLineSelection";
import styles from "./DiffViewer.module.css";

export interface DiffViewerProps {
  diff: FileDiff;
  mode: DiffMode;
  highlight: HighlightMap | null;
  selection?: UseLineSelection;
  onHunkAction?(action: HunkAction, selection: HunkSelection): void;
  actionsDisabledReason?: string;
}

/** Virtualized, read-only unless `selection` and `onHunkAction` are given. */
export function DiffViewer({
  diff,
  mode,
  highlight,
  selection,
  onHunkAction,
  actionsDisabledReason,
}: DiffViewerProps) {
  const rows = useMemo(() => buildRows(diff, mode), [diff, mode]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    overscan: 20,
  });
  const act = (hunkIndex: number) => (action: HunkAction) => {
    const lines =
      selection && selection.hunkIndex === hunkIndex && selection.selected.size > 0
        ? [...selection.selected].sort((a, b) => a - b)
        : null;
    onHunkAction?.(action, { hunkIndex, lines });
  };
  const gutterClick = selection ? selection.click : undefined;
  return (
    <section role="region" aria-label="Diff" className={styles.root}>
      <div ref={scrollRef} className={styles.scroll} data-testid="diff-scroll">
        <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            let body: React.ReactNode;
            if (row.kind === "header") {
              const count = selection?.hunkIndex === row.hunkIndex ? selection.selected.size : 0;
              body = (
                <HunkHeader
                  header={row.header}
                  scope={diff.scope}
                  selectedCount={count}
                  disabledReason={actionsDisabledReason}
                  onAction={onHunkAction ? act(row.hunkIndex) : undefined}
                />
              );
            } else if (row.kind === "unified") {
              body = (
                <UnifiedRow
                  diff={diff}
                  row={row}
                  highlight={highlight}
                  selection={selection}
                  onGutterClick={gutterClick}
                />
              );
            } else {
              body = (
                <SplitRow
                  diff={diff}
                  row={row}
                  highlight={highlight}
                  selection={selection}
                  onGutterClick={gutterClick}
                />
              );
            }
            return (
              <div
                key={row.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={styles.item}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {body}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
```

`DiffViewer.module.css`: `.root { flex: 1; min-height: 0; display: flex; flex-direction: column; }`, `.scroll { flex: 1; overflow: auto; }`, `.inner { position: relative; width: 100%; }`, `.item { position: absolute; top: 0; left: 0; width: 100%; }`. `HunkHeader.module.css`: `.root { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 8px; background: var(--color-hunk-bg); color: var(--color-text-muted); }`, `.text { font-size: 0.75rem; }`, `.actions { display: flex; gap: 6px; }`, `.action, .danger { font-size: 0.75rem; padding: 1px 8px; }`, `.danger { color: var(--color-danger); }`.

`src/test/mockVirtualizer.ts`:

```ts
import { vi } from "vitest";

// happy-dom has no layout, so the real virtualizer would render nothing.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 22,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 22,
        size: 22,
      })),
    measureElement: () => undefined,
  }),
}));
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npm test -- src/features/diff && npm run lint && npm run typecheck`
Expected: pass; all five components at 100 %.

- [ ] **Step 5: Commit**

```bash
git add src/features/diff src/test/mockVirtualizer.ts
git commit -m "feat(ui): virtualized diff viewer rows, hunk headers and word highlights"
```

---

### Task 10: Front end — `DiffToolbar`, `ImageDiff`, `BinaryPlaceholder`, `DetailPane`, `RepoPane` integration

**Files:**

- Create: `src/features/diff/DiffToolbar.tsx` (+ `.module.css`), `ImageDiff.tsx` (+ `.module.css`), `BinaryPlaceholder.tsx`, `DetailPane.tsx` (+ `.module.css`)
- Modify: `src/app/RepoPane.tsx`, `src/app/RepoPane.module.css`
- Test: `src/features/diff/DiffToolbar.test.tsx`, `ImageDiff.test.tsx`, `BinaryPlaceholder.test.tsx`, `DetailPane.test.tsx`; `src/app/RepoPane.test.tsx` (placeholder assertion moves to `DetailPane`)

**Interfaces:**

- Consumes: everything from Tasks 5–9; `useWorkspace`, `useDiffPrefs`, `useWorktreeActions`, `ConfirmDialog`, `RepoError`, `isImagePath`, `mimeFor`, `encodingNotice`, `isDecoded`, `FULL_DIFF_LINES`, `totalLines`.
- Produces:
  - `DiffToolbar({ diff, mode, ignoreWhitespace, onModeChange, onIgnoreWhitespaceChange, onLoadFull })`
  - `ImageDiff({ repoId, diff })`
  - `BinaryPlaceholder({ diff })`
  - `DetailPane({ repoId })`

- [ ] **Step 1: Write the failing tests**

`DiffToolbar.test.tsx`:

- shows `path`; for a rename shows `oldPath → path` (one text node `"old.ts → new.ts"`).
- a `role="radiogroup"` labelled "View mode" with radios "Side by side" and "Unified"; the checked one follows `mode`; clicking the other calls `onModeChange("unified" | "split")`.
- checkbox "Hide whitespace changes" reflects `ignoreWhitespace` and calls `onIgnoreWhitespaceChange(true/false)`.
- summary `+{additions} −{deletions}` counted over all hunks.
- `truncated: true` shows `role="status"` text `"Showing the first {totalLines} lines"` and a "Load full diff" button that calls `onLoadFull`; `truncated: false` shows neither.
- encoding notice text appears when `encodingNotice(diff)` is non-null, in an element with `data-testid="encoding-notice"`.

`ImageDiff.test.tsx` (mock `getFileContent`; stub `URL.createObjectURL` to return `"blob:1"`, `"blob:2"` and `URL.revokeObjectURL` with `vi.fn()`):

- modified: requests `("old", oldPath ?? path)` and `("new", path)` and renders two `<img>` with `alt="Old image"` / `alt="New image"` and the blob URLs; captions start "Old" and "New".
- a rename uses `oldPath` for the old side (`getFileContent` called with `"README.png"` not `"renamed.png"`).
- added (`change: "added"` or `"untracked"`): only the new side requested and rendered; deleted: only the old.
- the created `Blob` has `type` = `mimeFor(path)`.
- `tooLarge` error on one side renders "Image too large to preview" plus the error message in that side's figure; other errors render the message.
- dimensions: after `fireEvent.load(img)` with `naturalWidth/Height` defined via `Object.defineProperty`, the caption reads `"New 640×480"`.
- unmount revokes every created URL.

`BinaryPlaceholder.test.tsx`: renders "Binary file — no preview available" and the change kind label (`"Modified"`, `"Added"`, …, same mapping as `StatusBadge` — import and reuse `StatusBadge` from `../worktree/StatusBadge` if its props fit; otherwise a local label map).

`DetailPane.test.tsx` (mocks: `getFileDiff`, `getFileContent`, `applyHunk`, `onRepoChanged` via the ipc mock recipe; import `../../test/mockVirtualizer`; set `useWorkspace` selection with `useWorkspace.getState().select(...)` and reset `useDiffPrefs` in `beforeEach`):

- no selection → "Select a file to view its diff".
- selection → "Loading diff…" (`role="status"`) then the viewer region "Diff" and toolbar.
- `noChanges` rejection → "No unstaged changes in a.ts" (scope word follows the selection).
- other rejection → `role="alert"` with the message, a "Retry" button that refetches (`getFileDiff` called twice) and "Dismiss".
- binary + image path → `ImageDiff` (an `<img alt="New image">` appears); binary non-image → "Binary file — no preview available".
- decoded diff with zero hunks → "Only the encoding changed" and the toolbar notice; hunk buttons absent.
- decoded diff with hunks → every hunk button disabled with the UTF-16 reason.
- `ignoreWhitespace` on → hunk buttons disabled with the whitespace reason; toggling the checkbox calls `getFileDiff` with `true`.
- "Stage hunk" → `applyHunk(repoId, "a.ts", "stage", { hunkIndex: 0, lines: null })`.
- select two lines via gutters then "Stage 2 lines" → `lines: [1, 2]`.
- "Discard hunk…" opens `ConfirmDialog` titled "Discard changes" with body "Discard this hunk in a.ts? This cannot be undone."; Cancel calls nothing; Discard calls `applyHunk(..., "discard", ...)`. With 2 lines selected the body is "Discard 2 selected lines in a.ts? This cannot be undone.".
- `applyHunk` rejecting with `badSelection` → `role="alert"` above the viewer with Dismiss; the viewer stays.
- truncated → "Load full diff" refetches with `FULL_DIFF_LINES`; selecting another file resets to `undefined` max lines (next call has `maxLines` undefined).
- switching the selected file clears line selection (a previously `aria-pressed="true"` gutter is not pressed after the new diff renders).
- mode radio switches between unified and split rows (`data-kind="header"` count unchanged; `.split` cells appear only in split mode — assert via the presence of `data-kind="empty"` on an uneven hunk).

`RepoPane.test.tsx`: replace the "Select a file to view its diff" assertion with "renders the detail pane" (`screen.getByText("Select a file to view its diff")` still works since `DetailPane` renders it with no selection, so the test may simply stay — confirm it passes).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/features/diff src/app`
Expected: module-not-found.

- [ ] **Step 3: Implement**

`DiffToolbar.tsx`:

```tsx
import { useId } from "react";
import type { FileDiff } from "../../lib/ipc";
import type { DiffMode } from "../../lib/store/diffPrefs";
import { encodingNotice } from "./model/encoding";
import { totalLines } from "./model/limits";
import styles from "./DiffToolbar.module.css";

interface Props {
  diff: FileDiff;
  mode: DiffMode;
  ignoreWhitespace: boolean;
  onModeChange(mode: DiffMode): void;
  onIgnoreWhitespaceChange(on: boolean): void;
  onLoadFull(): void;
}

export function DiffToolbar({
  diff,
  mode,
  ignoreWhitespace,
  onModeChange,
  onIgnoreWhitespaceChange,
  onLoadFull,
}: Props) {
  const groupId = useId();
  let additions = 0;
  let deletions = 0;
  for (const h of diff.hunks)
    for (const l of h.lines) {
      if (l.kind === "addition") additions++;
      else if (l.kind === "deletion") deletions++;
    }
  const notice = encodingNotice(diff);
  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <span className={styles.path}>
          {diff.oldPath ? `${diff.oldPath} → ${diff.path}` : diff.path}
        </span>
        <span className={styles.summary}>
          <span className={styles.added}>+{additions}</span>{" "}
          <span className={styles.removed}>−{deletions}</span>
        </span>
        <div role="radiogroup" aria-label="View mode" className={styles.modes}>
          {(["split", "unified"] as const).map((m) => (
            <label key={m} className={styles.mode}>
              <input
                type="radio"
                name={groupId}
                value={m}
                checked={mode === m}
                onChange={() => onModeChange(m)}
              />
              {m === "split" ? "Side by side" : "Unified"}
            </label>
          ))}
        </div>
        <label className={styles.mode}>
          <input
            type="checkbox"
            checked={ignoreWhitespace}
            onChange={(e) => onIgnoreWhitespaceChange(e.target.checked)}
          />
          Hide whitespace changes
        </label>
      </div>
      {notice && (
        <div className={styles.notice} data-testid="encoding-notice">
          {notice}
        </div>
      )}
      {diff.truncated && (
        <div className={styles.notice} role="status">
          Showing the first {totalLines(diff)} lines
          <button type="button" onClick={onLoadFull}>
            Load full diff
          </button>
        </div>
      )}
    </div>
  );
}
```

`ImageDiff.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import type { AppError, DiffScope, DiffSide, FileDiff, RepoId } from "../../lib/ipc";
import { mimeFor } from "./model/images";
import { useFileContent } from "./useFileContent";
import styles from "./ImageDiff.module.css";

function Side({
  repoId,
  path,
  scope,
  side,
  label,
}: {
  repoId: RepoId;
  path: string;
  scope: DiffScope;
  side: DiffSide;
  label: string;
}) {
  const { bytes, error, loading } = useFileContent(repoId, path, scope, side, true);
  const url = useMemo(
    () => (bytes ? URL.createObjectURL(new Blob([bytes], { type: mimeFor(path) })) : null),
    [bytes, path],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  const [dims, setDims] = useState<string | null>(null);
  return (
    <figure className={styles.figure}>
      {url && (
        <img
          src={url}
          alt={`${label} image`}
          className={styles.img}
          onLoad={(e) =>
            setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)
          }
        />
      )}
      {loading && <span role="status">Loading…</span>}
      {error && <ErrorText error={error} />}
      <figcaption>{dims ? `${label} ${dims}` : label}</figcaption>
    </figure>
  );
}

function ErrorText({ error }: { error: AppError }) {
  return (
    <p className={styles.error}>
      {error.kind === "tooLarge" ? "Image too large to preview. " : ""}
      {error.message}
    </p>
  );
}

export function ImageDiff({ repoId, diff }: { repoId: RepoId; diff: FileDiff }) {
  const hasOld = diff.change !== "added" && diff.change !== "untracked";
  const hasNew = diff.change !== "deleted";
  return (
    <div className={styles.root}>
      {hasOld && (
        <Side
          repoId={repoId}
          path={diff.oldPath ?? diff.path}
          scope={diff.scope}
          side="old"
          label="Old"
        />
      )}
      {hasNew && (
        <Side repoId={repoId} path={diff.path} scope={diff.scope} side="new" label="New" />
      )}
    </div>
  );
}
```

`BinaryPlaceholder.tsx`: `<div className={styles.root} role="status"><p>Binary file — no preview available</p>{diff.change && <StatusBadge kind={diff.change} />}</div>` (check `StatusBadge`'s prop name in `src/features/worktree/StatusBadge.tsx`; if it renders a short code rather than a word, render the word with a local map instead).

`DetailPane.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { HunkAction, HunkSelection, RepoId } from "../../lib/ipc";
import { useDiffPrefs } from "../../lib/store/diffPrefs";
import { useWorkspace } from "../../lib/store/workspace";
import { RepoError } from "../repo/RepoError";
import { useWorktreeActions } from "../worktree/useWorktreeActions";
import { BinaryPlaceholder } from "./BinaryPlaceholder";
import { DiffToolbar } from "./DiffToolbar";
import { DiffViewer } from "./DiffViewer";
import { ImageDiff } from "./ImageDiff";
import { isDecoded } from "./model/encoding";
import { isImagePath } from "./model/images";
import { FULL_DIFF_LINES } from "./model/limits";
import { useFileDiff } from "./useFileDiff";
import { useHighlight } from "./useHighlight";
import { useLineSelection } from "./useLineSelection";
import styles from "./DetailPane.module.css";

const WHITESPACE_REASON = "Turn off “Hide whitespace changes” to stage, unstage or discard hunks";
const DECODED_REASON =
  "Hunk actions are unavailable for files decoded from UTF-16 or UTF-32; stage or discard the whole file from the Changes panel";

interface PendingDiscard {
  selection: HunkSelection;
}

export function DetailPane({ repoId }: { repoId: RepoId }) {
  const file = useWorkspace((s) => s.selected[repoId] ?? null);
  const { mode, ignoreWhitespace, setMode, setIgnoreWhitespace } = useDiffPrefs();
  const [maxLines, setMaxLines] = useState<number | null>(null);
  const fileKey = file ? `${file.scope}:${file.path}` : null;
  useEffect(() => setMaxLines(null), [fileKey]);

  const { diff, error, loading, noChanges, refetch } = useFileDiff(
    repoId,
    file,
    ignoreWhitespace,
    maxLines,
  );
  const highlight = useHighlight(diff);
  const selection = useLineSelection(diff);
  const actions = useWorktreeActions(repoId);
  const [pending, setPending] = useState<PendingDiscard | null>(null);
  const [dismissedError, setDismissedError] = useState(false);
  useEffect(() => setDismissedError(false), [error]);

  if (!file) return <Empty>Select a file to view its diff</Empty>;
  if (loading) return <Empty role="status">Loading diff…</Empty>;
  if (noChanges)
    return (
      <Empty>
        No {file.scope} changes in {file.path}
      </Empty>
    );
  if (error && !dismissedError) {
    return (
      <div className={styles.root}>
        <RepoError error={error} path={null} onDismiss={() => setDismissedError(true)} />
        <button type="button" onClick={refetch}>
          Retry
        </button>
      </div>
    );
  }
  if (!diff) return <Empty>Select a file to view its diff</Empty>;
  if (diff.isBinary) {
    return isImagePath(diff.path) ? (
      <ImageDiff repoId={repoId} diff={diff} />
    ) : (
      <BinaryPlaceholder diff={diff} />
    );
  }

  const reason = ignoreWhitespace
    ? WHITESPACE_REASON
    : isDecoded(diff)
      ? DECODED_REASON
      : undefined;
  const onHunkAction = (action: HunkAction, sel: HunkSelection) => {
    if (action === "discard") setPending({ selection: sel });
    else actions.applyHunk(diff.path, action, sel);
  };
  const n = pending?.selection.lines?.length ?? 0;
  return (
    <div className={styles.root}>
      <DiffToolbar
        diff={diff}
        mode={mode}
        ignoreWhitespace={ignoreWhitespace}
        onModeChange={setMode}
        onIgnoreWhitespaceChange={setIgnoreWhitespace}
        onLoadFull={() => setMaxLines(FULL_DIFF_LINES)}
      />
      {actions.error && (
        <RepoError error={actions.error} path={null} onDismiss={actions.clearError} />
      )}
      {diff.hunks.length === 0 && isDecoded(diff) ? (
        <Empty>Only the encoding changed</Empty>
      ) : (
        <DiffViewer
          diff={diff}
          mode={mode}
          highlight={highlight}
          selection={selection}
          onHunkAction={onHunkAction}
          actionsDisabledReason={reason}
        />
      )}
      <ConfirmDialog
        open={pending !== null}
        title="Discard changes"
        danger
        confirmLabel="Discard"
        body={
          n > 0
            ? `Discard ${n} selected lines in ${diff.path}? This cannot be undone.`
            : `Discard this hunk in ${diff.path}? This cannot be undone.`
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) actions.applyHunk(diff.path, "discard", pending.selection);
          setPending(null);
        }}
      />
    </div>
  );
}

function Empty({ children, role }: { children: React.ReactNode; role?: string }) {
  return (
    <div className={styles.empty} role={role}>
      {children}
    </div>
  );
}
```

(The error branch: `RepoError` already renders Dismiss; a sibling Retry button is enough. If the reviewer prefers, add an optional `onRetry` prop to `RepoError` instead; both satisfy the tests if the test queries by button name.)

`DetailPane.module.css`: `.root { display: flex; flex-direction: column; min-height: 0; height: 100%; }`, `.empty { flex: 1; display: grid; place-items: center; color: var(--color-text-muted); padding: 16px; text-align: center; }`.

`RepoPane.tsx`: replace the placeholder `<section aria-label="Detail">…</section>` with `<section aria-label="Detail" className={styles.detail}><DetailPane key={tab.id} repoId={tab.id} /></section>`. `RepoPane.module.css` `.detail`: `display: flex; flex-direction: column; min-height: 0; min-width: 0; border-left: 1px solid var(--color-border);` (drop `place-items`).

- [ ] **Step 4: Run every front-end gate**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: pass; coverage 100 % statements and branches for `src/`.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(ui): detail pane with diff viewer, image preview and hunk actions"
```

---

## After the last task

1. Final whole-branch review (most capable model), one fix dispatch, scoped re-review.
2. Architect sign-off on the branch.
3. Acceptance walk per spec §5 using the WebKit inspector automation (`drive.mjs` in the session scratchpad; fixture repo with a `.ts`, a `.rs`, a whitespace-only edit, a PNG, a non-image binary, a UTF-16 LE file and a 50 000-line text file).
4. `superpowers:finishing-a-development-branch`, then Jira GR-5 comment and transition.
