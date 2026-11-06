use serde::{Deserialize, Serialize};

use super::ChangeKind;

/// What a diff compares: either side of the index, or one commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope {
    /// HEAD -> index.
    Staged,
    /// Index -> workdir.
    Unstaged,
    /// First parent (empty tree for a root) -> the commit with this full hex id.
    Commit(String),
}

/// Which version of a file a content request refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffSide {
    /// HEAD for `Staged`, the index for `Unstaged`, the first parent for `Commit`.
    Old,
    /// The index for `Staged`, the working tree for `Unstaged`, the commit for `Commit`.
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

/// The role of one line inside a hunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
}

/// One line of a hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    /// Without the trailing newline.
    pub content: String,
    pub no_newline_at_eof: bool,
}

/// A contiguous block of changes with its surrounding context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// `"@@ -a,b +c,d @@ optional"`.
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// The diff of a single file in one scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub scope: DiffScope,
    /// `None` when the file is unchanged in this scope.
    pub change: Option<ChangeKind>,
    pub is_binary: bool,
    pub hunks: Vec<Hunk>,
    /// `true` when `max_lines` was hit; hunks are then partial.
    pub truncated: bool,
    /// Set only when the loader transcoded this side from UTF-16/UTF-32 (or UTF-8 opposite it).
    pub old_encoding: Option<TextEncoding>,
    pub new_encoding: Option<TextEncoding>,
}

/// A hunk, or some of its lines, chosen for a hunk action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    pub hunk_index: usize,
    /// Indices into `Hunk::lines` of Addition/Deletion lines; `None` = whole hunk.
    pub lines: Option<Vec<usize>>,
    /// Replacement text for selected lines, so a line can be staged partway.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edits: Vec<LineEdit>,
}

/// Replacement text for one line of a hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEdit {
    /// Index into `Hunk::lines` of a selected Addition/Deletion line.
    pub index: usize,
    pub text: String,
}

/// What to do with a selected hunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HunkAction {
    Stage,
    Unstage,
    Discard,
}

/// Options controlling how a file diff is generated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffOptions {
    pub ignore_whitespace: bool,
    pub context_lines: u32,
    /// Maximum number of lines collected across all hunks.
    pub max_lines: usize,
    /// Largest side (in bytes) the loader will transcode from UTF-16/UTF-32.
    pub max_decode_bytes: u64,
}

/// Context-line count that makes every diff hunk span the whole file.
///
/// libgit2 copies `context_lines` into xdiff's `long ctxlen`, which is 32-bit
/// on Windows, and xdiff merges neighbouring hunks when they are closer than
/// `2 * ctxlen + interhunkctxlen`, also a `long`. So twice this value must
/// fit an `i32`: `1 << 30` wrapped negative there and split a whole-file diff
/// into several hunks. `1 << 29` lines of context is still far more than any
/// file.
pub const WHOLE_FILE_CONTEXT: u32 = 1 << 29;

impl DiffOptions {
    /// Options for a single hunk holding the whole file, with no line cap.
    pub fn whole_file() -> Self {
        Self {
            context_lines: WHOLE_FILE_CONTEXT,
            max_lines: usize::MAX,
            ..Self::default()
        }
    }
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            ignore_whitespace: false,
            context_lines: 3,
            max_lines: 10_000,
            max_decode_bytes: 20 * 1024 * 1024,
        }
    }
}
