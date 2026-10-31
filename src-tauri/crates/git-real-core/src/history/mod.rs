//! Commit file lists, file history and blame.

mod follow;

use std::collections::HashMap;
use std::path::Path;

use git2::{BlameOptions, ErrorCode, ObjectType, Oid, Repository};

use self::follow::{EntryMemo, rename_source};
use crate::diff::change_kind;
use crate::error::GitError;
use crate::log::LogSnapshot;
use crate::log::shared::Row;
use crate::log::signature;
use crate::model::{Blame, BlameHunk, ChangeKind, CommitFile, FileHistoryEntry, FileHistoryPage};
use crate::paths::repo_relative;
use crate::repo::RepoSession;
use crate::revision;
use crate::status::file_path;

/// The largest blob, in bytes, that `blame` will annotate.
pub const BLAME_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// The most graph rows one file-history page scans.
pub const FILE_HISTORY_SCAN_ROWS: u32 = 20_000;

/// The most entries one file-history page returns; `max_entries` is clamped
/// to 1..=this.
pub const FILE_HISTORY_MAX_ENTRIES: u32 = 1_000;

impl RepoSession {
    /// The paths commit `oid` (full hex) changed against its first parent,
    /// with renames paired, sorted by path.
    pub fn commit_files(&self, oid: &str) -> Result<Vec<CommitFile>, GitError> {
        let repo = self.repo();
        let commit = revision::resolve_commit(repo, oid)?;
        let new = commit.tree()?;
        let old = revision::first_parent_tree(&commit)?;
        let diff =
            revision::commit_delta_diff(repo, old.as_ref(), &new, &mut git2::DiffOptions::new())?;
        let mut files: Vec<CommitFile> = diff
            .deltas()
            .filter_map(|d| {
                change_kind(d.status()).map(|change| {
                    let path = file_path(&d.new_file());
                    let old_path = Some(file_path(&d.old_file())).filter(|o| *o != path);
                    CommitFile {
                        path,
                        old_path,
                        change,
                    }
                })
            })
            .collect();
        // libgit2 orders paired renames by their old path.
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    /// One page of the commits of the graph built as `generation` that
    /// changed `path`; see [`LogSnapshot::file_history`].
    pub fn file_history(
        &self,
        generation: u64,
        path: &str,
        start_row: u32,
        max_entries: u32,
        follow_path: Option<&str>,
    ) -> Result<FileHistoryPage, GitError> {
        self.log_snapshot(generation)?
            .file_history(path, start_row, max_entries, follow_path)
    }

    /// The commit that last changed each line of `path` as of commit `oid`
    /// (full hex), or of HEAD when `None`.
    pub fn blame(&self, path: &str, oid: Option<&str>) -> Result<Blame, GitError> {
        let rel = repo_relative(path)?;
        let repo = self.repo();
        let commit = match oid {
            Some(oid) => revision::resolve_commit(repo, oid)?,
            None => match repo.head().and_then(|h| h.peel_to_commit()) {
                Ok(commit) => commit,
                Err(e) if e.code() == ErrorCode::UnbornBranch => return Err(GitError::UnbornHead),
                Err(e) => return Err(e.into()),
            },
        };
        let blob_id = self.tree_blob_id(&commit.tree()?, &rel)?;
        let blob = self.checked_blob(&rel, blob_id, BLAME_MAX_BYTES)?;
        if blob.is_binary() {
            return Err(GitError::BinaryFile(rel));
        }

        let mut opts = BlameOptions::new();
        opts.newest_commit(commit.id());
        let raw = repo.blame_file(Path::new(&rel), Some(&mut opts))?;
        let mut summaries: HashMap<Oid, String> = HashMap::new();
        let hunks = raw
            .iter()
            .map(|h| {
                let id = h.final_commit_id();
                let summary = summaries
                    .entry(id)
                    .or_insert_with(|| {
                        repo.find_commit(id)
                            .ok()
                            .and_then(|c| {
                                c.summary_bytes()
                                    .map(|s| String::from_utf8_lossy(s).into_owned())
                            })
                            .unwrap_or_default()
                    })
                    .clone();
                BlameHunk {
                    start: u32::try_from(h.final_start_line()).unwrap_or(u32::MAX),
                    lines: u32::try_from(h.lines_in_hunk()).unwrap_or(u32::MAX),
                    oid: id.to_string(),
                    author: signature(&h.final_signature()),
                    summary,
                }
            })
            .collect();

        Ok(Blame {
            oid: commit.id().to_string(),
            lines: blob_lines(blob.content()),
            path: rel,
            hunks,
        })
    }

    /// Every blob path in the HEAD tree, sorted; gitlinks are skipped and an
    /// unborn HEAD has none. Non-UTF-8 names are decoded lossily.
    pub fn tracked_files(&self) -> Result<Vec<String>, GitError> {
        let repo = self.repo();
        let root = match repo.head().and_then(|h| h.peel_to_tree()) {
            Ok(tree) => tree,
            Err(e) if e.code() == ErrorCode::UnbornBranch => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        // `Tree::walk` aborts on a non-UTF-8 directory name, so walk by hand.
        let mut out = Vec::new();
        let mut stack = vec![(Vec::new(), root)];
        while let Some((prefix, tree)) = stack.pop() {
            for entry in tree.iter() {
                let mut full = prefix.clone();
                full.extend_from_slice(entry.name_bytes());
                match entry.kind() {
                    Some(ObjectType::Blob) => out.push(String::from_utf8_lossy(&full).into_owned()),
                    Some(ObjectType::Tree) => {
                        full.push(b'/');
                        stack.push((full, repo.find_tree(entry.id())?));
                    }
                    _ => {}
                }
            }
        }
        out.sort();
        Ok(out)
    }
}

/// The scan behind [`LogSnapshot::file_history`].
pub(crate) fn history_page(
    snapshot: &LogSnapshot,
    path: &str,
    start_row: u32,
    max_entries: u32,
    follow_path: Option<&str>,
) -> Result<FileHistoryPage, GitError> {
    let rel = repo_relative(path)?;
    let followed = match follow_path {
        Some(follow) => repo_relative(follow)?,
        None => rel,
    };
    let max_entries = max_entries.clamp(1, FILE_HISTORY_MAX_ENTRIES) as usize;
    let repo = Repository::open(snapshot.repo_path())?;
    let total = snapshot.total();
    let end = start_row.saturating_add(FILE_HISTORY_SCAN_ROWS).min(total);
    let mut memo = EntryMemo::new(followed);
    let mut entries = Vec::new();
    let mut next = start_row;
    for index in start_row..end {
        next = index + 1;
        let Some(row) = snapshot.row(index) else {
            break;
        };
        if let Some(entry) = history_entry(&repo, &mut memo, row)? {
            entries.push(entry);
            if entries.len() == max_entries {
                break;
            }
        }
    }
    let next_row = (next < total || !snapshot.is_complete()).then_some(next);
    Ok(FileHistoryPage {
        entries,
        next_row,
        follow_path: memo.path().to_owned(),
    })
}

/// The entry for `row` when its commit changed the followed path against
/// its first parent; a rename moves the memo onto the old name.
fn history_entry(
    repo: &Repository,
    memo: &mut EntryMemo,
    row: &Row,
) -> Result<Option<FileHistoryEntry>, GitError> {
    let commit = repo.find_commit(row.oid)?;
    let tree_id = commit.tree_id();
    let parent_tree_id = match row.parents.first() {
        Some(parent) => Some(repo.find_commit(*parent)?.tree_id()),
        None => None,
    };
    let here = memo.entry(repo, tree_id)?;
    let before = match parent_tree_id {
        Some(id) => memo.entry(repo, id)?,
        None => None,
    };
    let (change, old_path) = match (here, before) {
        (Some(a), Some(b)) if a == b => return Ok(None),
        (Some(_), Some(_)) => (ChangeKind::Modified, None),
        (Some(_), None) => {
            let tree = repo.find_tree(tree_id)?;
            let parent = parent_tree_id.map(|id| repo.find_tree(id)).transpose()?;
            match rename_source(repo, parent.as_ref(), &tree, memo.path())? {
                Some(old) => (ChangeKind::Renamed, Some(old)),
                None => (ChangeKind::Added, None),
            }
        }
        (None, Some(_)) => (ChangeKind::Deleted, None),
        (None, None) => return Ok(None),
    };
    let entry = FileHistoryEntry {
        oid: row.oid.to_string(),
        subject: row.subject.to_string(),
        author_name: row.author.name.clone(),
        author_email: row.author.email.clone(),
        author_time: row.author_time,
        change,
        path: memo.path().to_owned(),
        old_path: old_path.clone(),
    };
    if let Some(old) = old_path {
        memo.follow(old);
    }
    Ok(Some(entry))
}

/// The blob's lines, decoded lossily, without `\n` or a trailing `\r`; a
/// final newline does not start another line.
fn blob_lines(content: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(content);
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_owned())
        .collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}
