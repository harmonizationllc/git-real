//! Commit file lists, file history and blame.

mod follow;

use std::collections::HashMap;
use std::path::Path;

use git2::{BlameOptions, ErrorCode, ObjectType, Oid};

use self::follow::{EntryMemo, rename_source};
use crate::diff::change_kind;
use crate::error::GitError;
use crate::log::signature;
use crate::model::{Blame, BlameHunk, ChangeKind, CommitFile, FileHistoryEntry};
use crate::paths::repo_relative;
use crate::repo::RepoSession;
use crate::revision;
use crate::status::file_path;

/// The largest blob, in bytes, that `blame` will annotate.
pub const BLAME_MAX_BYTES: u64 = 4 * 1024 * 1024;

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

    /// The commits of the graph built as `generation` that changed `path`
    /// against their first parent, in graph order, following renames.
    ///
    /// The graph spans every ref while the followed path is one name at a
    /// time, so same-named files on unrelated branches are listed too, and
    /// after a rename, commits on other branches that still use the new name
    /// are missed.
    pub fn file_history(
        &self,
        generation: u64,
        path: &str,
    ) -> Result<Vec<FileHistoryEntry>, GitError> {
        let rel = repo_relative(path)?;
        let cache = self.log_cache(generation)?;
        let repo = self.repo();
        let mut memo = EntryMemo::new(rel);
        let mut out = Vec::new();
        for row in &cache.rows {
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
                (Some(a), Some(b)) if a == b => continue,
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
                (None, None) => continue,
            };
            out.push(FileHistoryEntry {
                oid: row.oid.to_string(),
                subject: row.subject.clone(),
                author_name: row.author_name.clone(),
                author_email: row.author_email.clone(),
                author_time: row.author_time,
                change,
                path: memo.path().to_owned(),
                old_path: old_path.clone(),
            });
            if let Some(old) = old_path {
                memo.follow(old);
            }
        }
        Ok(out)
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
