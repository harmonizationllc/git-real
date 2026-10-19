//! Per-file diffs.

pub mod patch;
pub use patch::build_patch;

use std::path::Path;

use git2::ErrorCode;

use crate::encoding::{decode, detect_encoding};
use crate::error::GitError;
use crate::model::{
    ChangeKind, DiffLine, DiffLineKind, DiffOptions, DiffScope, DiffSide, FileDiff, Hunk,
    HunkAction, HunkSelection, TextEncoding,
};
use crate::repo::RepoSession;
use crate::revision;
use crate::status::file_path;

/// How diff line bytes become `DiffLine::content`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineMode {
    /// Lossy UTF-8 without the line ending, for display.
    Display,
    /// Exact text without only the trailing `\n`, for building patches.
    Exact,
}

/// A file diff plus the git file modes of both sides (0 when absent).
struct LoadedDiff {
    diff: FileDiff,
    old_mode: u32,
    new_mode: u32,
}

impl RepoSession {
    /// Diffs one file in `scope`, failing with `NoChanges` when it has none there.
    pub fn file_diff(
        &self,
        path: &str,
        scope: DiffScope,
        opts: DiffOptions,
    ) -> Result<FileDiff, GitError> {
        self.load_diff(path, scope, opts, LineMode::Display)
            .map(|loaded| loaded.diff)
    }

    /// Stages, unstages or discards one hunk of `path`, or some of its lines.
    pub fn apply_hunk(
        &self,
        path: &str,
        action: HunkAction,
        selection: &HunkSelection,
    ) -> Result<(), GitError> {
        let (scope, reverse) = match action {
            HunkAction::Stage => (DiffScope::Unstaged, false),
            HunkAction::Unstage => (DiffScope::Staged, true),
            HunkAction::Discard => (DiffScope::Unstaged, true),
        };
        let opts = DiffOptions {
            ignore_whitespace: false,
            context_lines: 3,
            max_lines: usize::MAX,
            ..DiffOptions::default()
        };
        // Decided before the exact load so any encoding stages whole.
        let whole_untracked =
            action == HunkAction::Stage && selection.lines.is_none() && self.is_untracked(path);
        if whole_untracked {
            if selection.hunk_index != 0 {
                return Err(GitError::BadSelection);
            }
            return self.stage_untracked_file(path);
        }
        let loaded = self.load_diff(path, scope, opts, LineMode::Exact)?;

        let (target, other) = if reverse {
            (loaded.new_mode, loaded.old_mode)
        } else {
            (loaded.old_mode, loaded.new_mode)
        };
        let mode = if target == 0 { other } else { target };
        let text = build_patch(&loaded.diff, selection, reverse, mode)?;
        self.apply_patch_text(&text, action)
    }

    /// Applies unified-diff `patch` to the index (stage/unstage) or the
    /// worktree (discard). Exposed for tests of stale patches.
    #[doc(hidden)]
    pub fn apply_patch_text(&self, patch: &str, action: HunkAction) -> Result<(), GitError> {
        let failed = |e: git2::Error| GitError::ApplyFailed(e.message().to_owned());
        let diff = git2::Diff::from_buffer(patch.as_bytes()).map_err(failed)?;
        let location = match action {
            HunkAction::Stage | HunkAction::Unstage => git2::ApplyLocation::Index,
            HunkAction::Discard => git2::ApplyLocation::WorkDir,
        };
        // Re-read the cached index so entries written by other processes
        // survive; `apply` writes the in-memory copy back to disk.
        self.repo().index()?.read(true)?;
        self.repo().apply(&diff, location, None).map_err(failed)
    }

    /// Whether `path` is an untracked (not ignored) worktree file.
    fn is_untracked(&self, path: &str) -> bool {
        self.repo()
            .status_file(Path::new(path))
            .is_ok_and(|s| s.contains(git2::Status::WT_NEW))
    }

    /// Adds a whole untracked file to the index; this covers empty, binary
    /// and executable files that a patch cannot express.
    fn stage_untracked_file(&self, path: &str) -> Result<(), GitError> {
        self.stage_paths(&[path.to_owned()])
    }

    /// Diffs one file in `scope` with line text decoded per `mode`.
    fn load_diff(
        &self,
        path: &str,
        scope: DiffScope,
        opts: DiffOptions,
        mode: LineMode,
    ) -> Result<LoadedDiff, GitError> {
        let no_changes = || GitError::NoChanges(path.to_owned());
        let diff = self.scoped_diff(path, &scope, opts)?;

        let idx = diff
            .deltas()
            .position(|d| d.new_file().path_bytes() == Some(path.as_bytes()))
            .ok_or_else(no_changes)?;
        let patch = git2::Patch::from_diff(&diff, idx)?.ok_or_else(no_changes)?;
        let delta = patch.delta();
        let change = change_kind(delta.status()).ok_or_else(no_changes)?;
        let raw_binary = delta.flags().is_binary();
        let decoded = if raw_binary && mode == LineMode::Display {
            self.decode_sides(&delta, &scope, opts, path)?
        } else {
            None
        };
        let (hunks, truncated, is_binary, old_encoding, new_encoding) = match decoded {
            Some(d) => (d.hunks, d.truncated, false, d.old_encoding, d.new_encoding),
            None => {
                let (hunks, truncated) = collect_hunks(&patch, opts.max_lines, mode, path)?;
                (hunks, truncated, raw_binary, None, None)
            }
        };

        // A decoded diff may have no hunks yet still differ in bytes (an
        // encoding-only change), so it is never reported as `NoChanges`.
        let no_visible_change = old_encoding.is_none()
            && new_encoding.is_none()
            && change == ChangeKind::Modified
            && !is_binary
            && patch.num_hunks() == 0
            && delta.old_file().mode() == delta.new_file().mode();
        if no_visible_change {
            return Err(no_changes());
        }

        let new_path = file_path(&delta.new_file());
        let old_path = Some(file_path(&delta.old_file())).filter(|old| *old != new_path);
        Ok(LoadedDiff {
            diff: FileDiff {
                path: new_path,
                old_path,
                scope,
                change: Some(change),
                is_binary,
                hunks,
                truncated,
                old_encoding,
                new_encoding,
            },
            old_mode: u32::from(delta.old_file().mode()),
            new_mode: u32::from(delta.new_file().mode()),
        })
    }

    /// Builds the git2 diff for `scope`: pathspec-limited when unstaged, whole
    /// index with rename detection when staged, whole commit against its first
    /// parent with rename detection for a commit.
    fn scoped_diff(
        &self,
        path: &str,
        scope: &DiffScope,
        opts: DiffOptions,
    ) -> Result<git2::Diff<'_>, GitError> {
        let repo = self.repo();
        let mut o = git2::DiffOptions::new();
        o.include_typechange(true)
            .ignore_whitespace(opts.ignore_whitespace)
            .context_lines(opts.context_lines);
        match scope {
            DiffScope::Unstaged => {
                o.pathspec(path)
                    .disable_pathspec_match(true)
                    .include_untracked(true)
                    .recurse_untracked_dirs(true)
                    .show_untracked_content(true);
                Ok(repo.diff_index_to_workdir(None, Some(&mut o))?)
            }
            DiffScope::Staged => {
                let head_tree = match repo.head().and_then(|h| h.peel_to_tree()) {
                    Ok(tree) => Some(tree),
                    Err(e) if e.code() == ErrorCode::UnbornBranch => None,
                    Err(e) => return Err(e.into()),
                };
                let mut diff = repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut o))?;
                diff.find_similar(Some(git2::DiffFindOptions::new().renames(true)))?;
                Ok(diff)
            }
            DiffScope::Commit(oid) => {
                let commit = revision::resolve_commit(repo, oid)?;
                let new = commit.tree()?;
                let old = revision::first_parent_tree(&commit)?;
                revision::commit_delta_diff(repo, old.as_ref(), &new, &mut o)
            }
        }
    }
}

/// Hunks rebuilt from transcoded text, with the encoding found on each side.
struct DecodedSides {
    hunks: Vec<Hunk>,
    truncated: bool,
    old_encoding: Option<TextEncoding>,
    new_encoding: Option<TextEncoding>,
}

/// One side of a delta, read and sniffed for decoding.
enum Sniffed {
    /// The side does not exist (an added or deleted file).
    Absent,
    /// Readable text in a known encoding.
    Text(Vec<u8>, TextEncoding),
}

impl Sniffed {
    fn encoding(&self) -> Option<TextEncoding> {
        match self {
            Sniffed::Absent => None,
            Sniffed::Text(_, encoding) => Some(*encoding),
        }
    }

    /// The decoded text; an absent side is empty.
    fn text(&self) -> String {
        match self {
            Sniffed::Absent => String::new(),
            Sniffed::Text(bytes, encoding) => decode(bytes, *encoding),
        }
    }
}

impl RepoSession {
    /// For a delta libgit2 called binary: when every present side is UTF-8,
    /// UTF-16 or UTF-32 (and at least one is not UTF-8), rebuilds the hunks
    /// from the decoded text. `None` leaves the diff binary.
    fn decode_sides(
        &self,
        delta: &git2::DiffDelta<'_>,
        scope: &DiffScope,
        opts: DiffOptions,
        path: &str,
    ) -> Result<Option<DecodedSides>, GitError> {
        let Some(old) = self.sniff_side(delta.old_file(), scope, DiffSide::Old, opts)? else {
            return Ok(None);
        };
        let Some(new) = self.sniff_side(delta.new_file(), scope, DiffSide::New, opts)? else {
            return Ok(None);
        };
        let (old_encoding, new_encoding) = (old.encoding(), new.encoding());
        let any_non_utf8 = [old_encoding, new_encoding]
            .into_iter()
            .flatten()
            .any(|e| e != TextEncoding::Utf8);
        if !any_non_utf8 {
            return Ok(None); // UTF-8 with a NUL byte really is binary
        }
        let (old_text, new_text) = (old.text(), new.text());
        let mut o = git2::DiffOptions::new();
        o.ignore_whitespace(opts.ignore_whitespace)
            .context_lines(opts.context_lines);
        let old_path = file_path(&delta.old_file());
        let patch = git2::Patch::from_buffers(
            old_text.as_bytes(),
            Some(Path::new(&old_path)),
            new_text.as_bytes(),
            Some(Path::new(path)),
            Some(&mut o),
        )?;
        if patch.delta().flags().is_binary() {
            return Ok(None); // the decoded text holds U+0000, so it is binary after all
        }
        let (hunks, truncated) = collect_hunks(&patch, opts.max_lines, LineMode::Display, path)?;
        Ok(Some(DecodedSides {
            hunks,
            truncated,
            old_encoding,
            new_encoding,
        }))
    }

    /// Reads and sniffs one side of a delta. `None` keeps the diff binary: the
    /// side exists but is unreadable, above `max_decode_bytes`, or not text.
    fn sniff_side(
        &self,
        file: git2::DiffFile<'_>,
        scope: &DiffScope,
        side: DiffSide,
        opts: DiffOptions,
    ) -> Result<Option<Sniffed>, GitError> {
        if !file.exists() {
            return Ok(Some(Sniffed::Absent));
        }
        let bytes = match self.file_content(
            &file_path(&file),
            scope.clone(),
            side,
            opts.max_decode_bytes,
        ) {
            Ok(bytes) => bytes,
            Err(GitError::TooLarge { .. } | GitError::PathNotFound(_)) => return Ok(None),
            Err(e) => return Err(e),
        };
        Ok(detect_encoding(&bytes).map(|encoding| Sniffed::Text(bytes, encoding)))
    }
}

/// Maps a delta status to a change kind; `None` means nothing to show.
pub(crate) fn change_kind(status: git2::Delta) -> Option<ChangeKind> {
    match status {
        git2::Delta::Added | git2::Delta::Copied => Some(ChangeKind::Added),
        git2::Delta::Untracked => Some(ChangeKind::Untracked),
        git2::Delta::Modified => Some(ChangeKind::Modified),
        git2::Delta::Deleted => Some(ChangeKind::Deleted),
        git2::Delta::Renamed => Some(ChangeKind::Renamed),
        git2::Delta::Typechange => Some(ChangeKind::TypeChange),
        git2::Delta::Conflicted => Some(ChangeKind::Conflicted),
        git2::Delta::Unmodified | git2::Delta::Ignored | git2::Delta::Unreadable => None,
    }
}

/// Collects hunks until `max_lines` lines are gathered; the flag reports
/// whether any line was dropped. Exact mode fails on non-UTF-8 lines of `path`.
fn collect_hunks(
    patch: &git2::Patch<'_>,
    max_lines: usize,
    mode: LineMode,
    path: &str,
) -> Result<(Vec<Hunk>, bool), GitError> {
    let mut hunks = Vec::with_capacity(patch.num_hunks());
    let mut count = 0usize;
    for h in 0..patch.num_hunks() {
        let (raw, n) = patch.hunk(h)?;
        let mut hunk = Hunk {
            old_start: raw.old_start(),
            old_lines: raw.old_lines(),
            new_start: raw.new_start(),
            new_lines: raw.new_lines(),
            header: display_text(raw.header()),
            lines: Vec::new(),
        };
        for l in 0..n {
            let raw_line = patch.line_in_hunk(h, l)?;
            let kind = match raw_line.origin_value() {
                git2::DiffLineType::Context => DiffLineKind::Context,
                git2::DiffLineType::Addition => DiffLineKind::Addition,
                git2::DiffLineType::Deletion => DiffLineKind::Deletion,
                git2::DiffLineType::ContextEOFNL
                | git2::DiffLineType::AddEOFNL
                | git2::DiffLineType::DeleteEOFNL => {
                    if let Some(prev) = hunk.lines.last_mut() {
                        prev.no_newline_at_eof = true;
                    }
                    continue;
                }
                git2::DiffLineType::FileHeader
                | git2::DiffLineType::HunkHeader
                | git2::DiffLineType::Binary => continue,
            };
            if count == max_lines {
                if !hunk.lines.is_empty() {
                    hunks.push(hunk);
                }
                return Ok((hunks, true));
            }
            count += 1;
            hunk.lines.push(DiffLine {
                kind,
                old_lineno: raw_line.old_lineno(),
                new_lineno: raw_line.new_lineno(),
                content: line_text(raw_line.content(), mode)
                    .ok_or_else(|| GitError::ApplyFailed(format!("{path} is not UTF-8 text")))?,
                no_newline_at_eof: false,
            });
        }
        hunks.push(hunk);
    }
    Ok((hunks, false))
}

/// Decodes line `bytes` per `mode`; `None` when exact text is not UTF-8.
fn line_text(bytes: &[u8], mode: LineMode) -> Option<String> {
    match mode {
        LineMode::Display => Some(display_text(bytes)),
        LineMode::Exact => {
            let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
            std::str::from_utf8(bytes).ok().map(str::to_owned)
        }
    }
}

/// Decodes `bytes` lossily and removes one trailing `"\r\n"`, else one `"\n"`.
fn display_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(&text)
        .to_owned()
}
