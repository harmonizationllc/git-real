//! The commit graph: built in the background, read in pages from
//! snapshots, searched, and acted on (detached checkout, reset).

pub(crate) mod builder;
pub(crate) mod cache;
mod lanes;
mod search;
pub(crate) mod shared;
mod topo;
mod walk;

use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant};

use git2::{Commit, ResetType};

pub use self::shared::LogSnapshot;
use self::shared::lock;
use crate::error::GitError;
use crate::git_cli;
use crate::model::{CommitDetail, LogPage, LogSummary, ResetMode, Signature};
use crate::refs::switch::{self, SwitchTarget};
use crate::repo::RepoSession;
use crate::revision;

/// How long [`RepoSession::log_summary`] waits for a build to complete
/// before answering with the provisional state.
pub const FIRST_ANSWER_MS: u64 = 150;

impl RepoSession {
    /// Starts a rebuild when any ref moved since the last build, then waits
    /// up to [`FIRST_ANSWER_MS`] for the graph to complete. Small
    /// repositories get a complete answer; larger ones a provisional one to
    /// poll.
    pub fn log_summary(&mut self) -> Result<LogSummary, GitError> {
        self.log_summary_within(Duration::from_millis(FIRST_ANSWER_MS))
    }

    /// Like [`Self::log_summary`], but waits until the graph is complete
    /// and no rebuild is running, however long that takes.
    pub fn log_summary_complete(&mut self) -> Result<LogSummary, GitError> {
        self.summary_until(None)
    }

    /// Like [`Self::log_summary`], waiting at most `window`.
    pub fn log_summary_within(&mut self, window: Duration) -> Result<LogSummary, GitError> {
        self.summary_until(Some(Instant::now() + window))
    }

    /// The generation `generation` as a snapshot to read outside the
    /// session, or `LogStale` when it is not the one served.
    pub fn log_snapshot(&self, generation: u64) -> Result<LogSnapshot, GitError> {
        let mut state = lock(&self.log.shared);
        let current = state
            .current
            .as_ref()
            .filter(|g| g.generation == generation)
            .ok_or(GitError::LogStale)?;
        let snapshot = LogSnapshot::from_generation(current, self.path().to_path_buf());
        if !snapshot.is_complete() {
            state.provisional_observed = true;
        }
        Ok(snapshot)
    }

    /// Up to `count` rows (clamped to 1..=1000) from row `start` of the graph
    /// built as `generation`.
    pub fn log_page(&self, generation: u64, start: u32, count: u32) -> Result<LogPage, GitError> {
        Ok(self.log_snapshot(generation)?.page(start, count))
    }

    /// Indices, ascending, of the rows of `generation` that match `query`
    /// (case-insensitive; see [`search::matches`]). A blank query matches nothing.
    pub fn search_log(&self, generation: u64, query: &str) -> Result<Vec<u32>, GitError> {
        let snapshot = self.log_snapshot(generation)?;
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let repo = self.repo();
        Ok((0..snapshot.total())
            .filter(|&i| {
                snapshot
                    .row(i)
                    .is_some_and(|row| search::matches(repo, row, &query))
            })
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

    /// Restarts the build when the refs moved, then waits for the graph to
    /// settle (complete, no rebuild running), a build error, or `deadline`.
    fn summary_until(&mut self, deadline: Option<Instant>) -> Result<LogSummary, GitError> {
        let fingerprint = cache::fingerprint(self.repo())?;
        if self.log.fingerprint != Some(fingerprint) {
            if let Some(running) = self.log.builder.take() {
                running.cancel_and_join();
            }
            {
                let mut state = lock(&self.log.shared);
                // A cancelled first build's partial graph is not served on.
                if state.current.as_ref().is_some_and(|g| !g.complete) {
                    state.current = None;
                }
                state.refreshing = state.current.is_some();
                state.error = None;
            }
            self.log.builder = Some(builder::start(
                self.path().to_path_buf(),
                Arc::clone(&self.log.shared),
            ));
            self.log.fingerprint = Some(fingerprint);
        }

        let (_, condvar) = &*self.log.shared;
        let mut state = lock(&self.log.shared);
        loop {
            let settled = state.current.as_ref().is_some_and(|g| g.complete) && !state.refreshing;
            if settled || state.error.is_some() || state.building.is_none() {
                break;
            }
            state = match deadline {
                None => condvar.wait(state).unwrap_or_else(PoisonError::into_inner),
                Some(deadline) => {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    condvar
                        .wait_timeout(state, deadline - now)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
            };
        }

        if let Some(e) = state.error.take() {
            drop(state);
            // The next call starts a fresh build.
            self.log.fingerprint = None;
            return Err(e);
        }
        let summary = match &state.current {
            Some(g) => LogSummary {
                generation: g.generation,
                total: g.total(),
                max_lanes: g.max_lanes,
                complete: g.complete,
                refreshing: state.refreshing,
            },
            None => LogSummary {
                generation: state.building.unwrap_or(state.next_generation),
                total: 0,
                max_lanes: 0,
                complete: false,
                refreshing: false,
            },
        };
        if !summary.complete {
            state.provisional_observed = true;
        }
        Ok(summary)
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
