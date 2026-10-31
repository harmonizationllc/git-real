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
    /// poll. A call that finds a build already running answers at once.
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

    /// Indices, ascending, of the rows of `generation` that match `query`;
    /// see [`LogSnapshot::search`].
    pub fn search_log(&self, generation: u64, query: &str) -> Result<Vec<u32>, GitError> {
        self.log_snapshot(generation)?.search(query)
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
        let started = self.log.fingerprint != Some(fingerprint);
        if started {
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

        // Only the call that started the build waits out its window; a poll on a
        // build already running answers at once, so it never holds the session
        // lock for the window. `None` (wait for completion) always waits.
        let deadline = match deadline {
            Some(_) if !started => Some(Instant::now()),
            other => other,
        };
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use git2::{Oid, Repository, Signature, Time};

    use super::builder::{self, Final, Job};
    use super::cache;
    use crate::error::GitError;
    use crate::repo::RepoSession;

    /// A repository with `n` linear commits on HEAD, one second apart.
    fn chain(n: i64) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let tree = repo
            .find_tree(repo.treebuilder(None).unwrap().write().unwrap())
            .unwrap();
        let mut parent: Option<Oid> = None;
        for i in 0..n {
            let sig = Signature::new("Ada", "ada@example.com", &Time::new(1_000 + i, 0)).unwrap();
            let parents: Vec<git2::Commit> = parent
                .iter()
                .map(|p| repo.find_commit(*p).unwrap())
                .collect();
            let parents: Vec<&git2::Commit> = parents.iter().collect();
            parent = Some(
                repo.commit(Some("HEAD"), &sig, &sig, &format!("c{i}"), &tree, &parents)
                    .unwrap(),
            );
        }
        dir
    }

    fn panicking_build(_: &Job) -> Result<Option<Final>, GitError> {
        panic!("injected build panic");
    }

    #[test]
    fn a_panicking_build_surfaces_as_an_error_and_the_next_call_retries() {
        let dir = chain(1);
        let mut s = RepoSession::open(dir.path()).unwrap();
        s.log.fingerprint = Some(cache::fingerprint(s.repo()).unwrap());
        s.log.builder = Some(builder::start_job(
            s.path().to_path_buf(),
            Arc::clone(&s.log.shared),
            panicking_build,
        ));
        let failed = s.log_summary_complete();
        assert!(matches!(failed, Err(GitError::Io(_))), "{failed:?}");
        let retried = s.log_summary_complete().unwrap();
        assert_eq!((retried.total, retried.complete), (1, true));
    }

    #[test]
    fn dropping_the_session_mid_build_joins_the_builder() {
        let dir = chain(1200);
        let mut s = RepoSession::open(dir.path()).unwrap();
        s.log_summary_within(Duration::ZERO).unwrap();
        let shared = Arc::clone(&s.log.shared);
        drop(s);
        // The builder thread held the other clone; joining released it.
        assert_eq!(Arc::strong_count(&shared), 1);
    }
}
