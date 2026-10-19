//! The commit graph: one cached topological walk with lane layout, read in
//! pages, searched, and acted on (detached checkout, reset).

pub(crate) mod cache;
mod lanes;
mod search;
mod walk;

use git2::{Commit, ResetType};

use self::cache::{CachedRow, LogCache};
use crate::error::GitError;
use crate::git_cli;
use crate::model::{CommitDetail, LogPage, LogSummary, ResetMode, Signature};
use crate::refs::switch::{self, SwitchTarget};
use crate::repo::RepoSession;
use crate::revision;

/// The most rows one page may hold.
const MAX_PAGE: u32 = 1000;

impl RepoSession {
    /// Rebuilds the cached graph when any ref moved since the last build, and
    /// returns its generation and size.
    pub fn log_summary(&mut self) -> Result<LogSummary, GitError> {
        let fingerprint = cache::fingerprint(self.repo())?;
        let current = match self.log_cache.take() {
            Some(c) if c.fingerprint == fingerprint => c,
            previous => {
                let generation = previous.as_ref().map_or(1, |c| c.generation + 1);
                // On failure the previous cache stays so the next call retries.
                match walk::build(self.repo(), generation, fingerprint) {
                    Ok(built) => built,
                    Err(e) => {
                        self.log_cache = previous;
                        return Err(e);
                    }
                }
            }
        };
        let summary = LogSummary {
            generation: current.generation,
            total: u32::try_from(current.rows.len()).unwrap_or(u32::MAX),
            max_lanes: current.max_lanes,
        };
        self.log_cache = Some(current);
        Ok(summary)
    }

    /// Up to `count` rows (clamped to 1..=1000) from row `start` of the graph
    /// built as `generation`.
    pub fn log_page(&self, generation: u64, start: u32, count: u32) -> Result<LogPage, GitError> {
        let cache = self.log_cache(generation)?;
        let count = count.clamp(1, MAX_PAGE) as usize;
        let rows = cache
            .rows
            .iter()
            .skip(start as usize)
            .take(count)
            .map(CachedRow::to_row)
            .collect();
        Ok(LogPage { start, rows })
    }

    /// Indices, ascending, of the rows of `generation` that match `query`
    /// (case-insensitive; see [`search::matches`]). A blank query matches nothing.
    pub fn search_log(&self, generation: u64, query: &str) -> Result<Vec<u32>, GitError> {
        let cache = self.log_cache(generation)?;
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let repo = self.repo();
        Ok(cache
            .rows
            .iter()
            .enumerate()
            .filter(|(_, row)| search::matches(repo, row, &query))
            .map(|(i, _)| u32::try_from(i).unwrap_or(u32::MAX))
            .collect())
    }

    /// Message, parents, author and committer of the commit `oid` (full hex).
    pub fn commit_detail(&self, oid: &str) -> Result<CommitDetail, GitError> {
        let commit = self.find_commit_hex(oid)?;
        Ok(CommitDetail {
            oid: commit.id().to_string(),
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
            message: crate::commit::message::split(&String::from_utf8_lossy(
                commit.message_bytes(),
            )),
            author: signature(&commit.author()),
            committer: signature(&commit.committer()),
        })
    }

    /// Detaches HEAD at `oid` through `git switch --detach`. Only the
    /// canonical hex of a commit that exists reaches the command line.
    pub fn checkout_commit(&self, oid: &str) -> Result<(), GitError> {
        let hex = self.find_commit_hex(oid)?.id().to_string();
        let git = git_cli::locate()?;
        switch::run(&git, self.workdir()?, SwitchTarget::Detach(&hex))
    }

    /// Moves HEAD (and the branch it is on) to `oid`, resetting the index
    /// and working tree as `mode` says.
    pub fn reset_to_commit(&self, oid: &str, mode: ResetMode) -> Result<(), GitError> {
        let commit = self.find_commit_hex(oid)?;
        let kind = match mode {
            ResetMode::Soft => ResetType::Soft,
            ResetMode::Mixed => ResetType::Mixed,
            ResetMode::Hard => ResetType::Hard,
        };
        self.repo().reset(commit.as_object(), kind, None)?;
        Ok(())
    }

    /// The cache built as `generation`, or `LogStale`.
    pub(crate) fn log_cache(&self, generation: u64) -> Result<&LogCache, GitError> {
        self.log_cache
            .as_ref()
            .filter(|c| c.generation == generation)
            .ok_or(GitError::LogStale)
    }

    /// The commit named by exactly 40 hex characters, or `CommitNotFound`.
    fn find_commit_hex(&self, oid: &str) -> Result<Commit<'_>, GitError> {
        revision::resolve_commit(self.repo(), oid)
    }
}

pub(crate) fn signature(sig: &git2::Signature<'_>) -> Signature {
    Signature {
        name: String::from_utf8_lossy(sig.name_bytes()).into_owned(),
        email: String::from_utf8_lossy(sig.email_bytes()).into_owned(),
        time: sig.when().seconds(),
    }
}
