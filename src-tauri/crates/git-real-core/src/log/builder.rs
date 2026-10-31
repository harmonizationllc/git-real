//! The background graph builder: a thread with its own `Repository` that
//! walks the history in two passes and publishes into the shared log state.
//!
//! Pass A is a best-first traversal by committer time, laid out at once and
//! published in sealed chunks when nothing older is being served. Pass B
//! sorts the collected rows topologically in memory, lays them out again and
//! publishes the result as complete: under the build's own generation number
//! when no reader observed the provisional state, otherwise under the next.

use std::cmp::{Ordering as CmpOrdering, Reverse};
use std::collections::{BinaryHeap, HashMap};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use git2::{Oid, Repository};

use super::lanes::LaneLayout;
use super::shared::{
    Author, CHUNK_ROWS, Chunk, Generation, RefLabels, Row, SKIP_BITS, SharedLog, lock,
};
use super::topo::topo_order;
use super::walk::labels_and_tips;
use crate::error::GitError;

/// A running (or finished) build. Dropping it detaches the thread; call
/// [`Builder::cancel_and_join`] to stop it.
pub(crate) struct Builder {
    cancel: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Builder {
    /// Asks the build to stop at its next chunk boundary and waits for it.
    /// A cancelled build publishes nothing further.
    pub(crate) fn cancel_and_join(mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            // A panicking build has nothing left to publish.
            let _ = thread.join();
        }
    }
}

/// Starts a build of the repository at `repo_path` under the next generation
/// number, recording it in `shared.building`.
pub(crate) fn start(repo_path: PathBuf, shared: SharedLog) -> Builder {
    start_job(repo_path, shared, Job::build)
}

/// What a build thread runs: both passes, `None` when cancelled.
type BuildFn = fn(&Job) -> Result<Option<Final>, GitError>;

/// [`start`] with the passes given, so a test can make them panic.
pub(crate) fn start_job(repo_path: PathBuf, shared: SharedLog, build: BuildFn) -> Builder {
    let (generation, publish_provisional) = {
        let mut state = lock(&shared);
        let generation = state.next_generation;
        state.next_generation = generation + 1;
        state.building = Some(generation);
        state.provisional_observed = false;
        // Served-until-final: a complete graph stays until the new one is.
        (generation, state.current.is_none())
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let job = Job {
        repo_path,
        shared: Arc::clone(&shared),
        cancel: Arc::clone(&cancel),
        generation,
        publish_provisional,
        build,
    };
    let thread = match std::thread::Builder::new()
        .name("log-builder".to_owned())
        .spawn(move || job.run())
    {
        Ok(thread) => Some(thread),
        Err(e) => {
            let mut state = lock(&shared);
            state.error = Some(GitError::Io(e));
            state.building = None;
            state.refreshing = false;
            shared.1.notify_all();
            None
        }
    };
    Builder { cancel, thread }
}

/// What the builder thread owns.
pub(crate) struct Job {
    repo_path: PathBuf,
    shared: SharedLog,
    cancel: Arc<AtomicBool>,
    generation: u64,
    publish_provisional: bool,
    build: BuildFn,
}

/// The final state of a build, ready to publish.
pub(crate) struct Final {
    chunks: Vec<Arc<Chunk>>,
    max_lanes: u32,
    labels: Arc<RefLabels>,
    index: HashMap<Oid, u32>,
}

impl Job {
    fn run(self) {
        // A panic must still settle the shared state, or every reader would
        // wait on `building` for good.
        let result = catch_unwind(AssertUnwindSafe(|| (self.build)(&self)))
            .unwrap_or_else(|_| Err(GitError::Io(std::io::Error::other(BUILD_PANICKED))));
        let mut state = lock(&self.shared);
        match result {
            // A cancelled build's successor owns the shared state, so only
            // this build's own `building` mark is cleared.
            _ if self.cancelled() => {
                if state.building == Some(self.generation) {
                    state.building = None;
                }
                return;
            }
            // Only a cancelled build returns `None`; settle anyway.
            Ok(None) => {}
            Ok(Some(done)) => {
                let generation = if state.provisional_observed {
                    self.generation + 1
                } else {
                    self.generation
                };
                state.next_generation = state.next_generation.max(generation + 1);
                state.current = Some(Generation {
                    generation,
                    complete: true,
                    max_lanes: done.max_lanes,
                    chunks: done.chunks,
                    labels: done.labels,
                    index: Some(Arc::new(done.index)),
                });
            }
            Err(e) => {
                state.error = Some(e);
                if state.current.as_ref().is_some_and(|g| !g.complete) {
                    state.current = None;
                }
            }
        }
        state.building = None;
        state.refreshing = false;
        self.shared.1.notify_all();
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// Both passes; `None` when cancelled.
    fn build(&self) -> Result<Option<Final>, GitError> {
        let repo = Repository::open(&self.repo_path)?;
        let (labels, tips) = labels_and_tips(&repo)?;
        let labels = Arc::new(labels);

        // Pass A: time order, laid out as it goes, sealed in chunks.
        let mut traversal = Traversal::new(&repo, &tips);
        let mut layout = LaneLayout::new();
        let mut scratch = Vec::new();
        let mut chunks: Vec<Arc<Chunk>> = Vec::new();
        let mut open = Vec::with_capacity(CHUNK_ROWS);
        let mut columns_at_start = Vec::new();
        let mut times = Vec::new();
        while let Some((row, time)) = traversal.next_row()? {
            layout.advance(row.oid, row.layout_parents(&mut scratch));
            times.push(time);
            open.push(row);
            if open.len() == CHUNK_ROWS {
                let chunk = Arc::new(Chunk {
                    rows: std::mem::replace(&mut open, Vec::with_capacity(CHUNK_ROWS)),
                    columns_at_start: std::mem::replace(
                        &mut columns_at_start,
                        layout.columns().to_vec(),
                    ),
                });
                if self.cancelled() {
                    return Ok(None);
                }
                if self.publish_provisional {
                    self.publish_chunk(&chunk, layout.max_columns(), &labels);
                }
                chunks.push(chunk);
            }
        }
        if !open.is_empty() {
            chunks.push(Arc::new(Chunk {
                rows: open,
                columns_at_start,
            }));
        }
        if self.cancelled() {
            return Ok(None);
        }

        // Pass B: topological order, laid out again from the same rows.
        let parents: Vec<Vec<u32>> = chunks
            .iter()
            .flat_map(|c| c.rows.iter())
            .map(|r| {
                r.parents
                    .iter()
                    .filter_map(|p| traversal.seen().get(p).copied())
                    .collect()
            })
            .collect();
        let order = topo_order(&parents, &times);
        drop(parents);
        drop(times);
        let mut index = traversal.into_seen();
        let mut final_position = vec![0u32; order.len()];
        for (position, &row) in order.iter().enumerate() {
            final_position[row as usize] = to_u32(position);
        }
        for row in index.values_mut() {
            *row = final_position[*row as usize];
        }
        drop(final_position);
        if self.cancelled() {
            return Ok(None);
        }

        let Some(rows) = self.take_rows(chunks) else {
            return Ok(None);
        };
        let mut slots: Vec<Option<Row>> = rows.into_iter().map(Some).collect();
        let mut layout = LaneLayout::new();
        let mut final_chunks = Vec::with_capacity(order.len().div_ceil(CHUNK_ROWS));
        for block in order.chunks(CHUNK_ROWS) {
            if self.cancelled() {
                return Ok(None);
            }
            let columns_at_start = layout.columns().to_vec();
            let mut rows = Vec::with_capacity(block.len());
            // `order` is a permutation, so every slot is taken exactly once.
            for row in block.iter().filter_map(|&i| slots[i as usize].take()) {
                let mut row = row;
                row.layout_skips = 0;
                layout.advance(row.oid, &row.parents);
                rows.push(row);
            }
            final_chunks.push(Arc::new(Chunk {
                rows,
                columns_at_start,
            }));
        }
        Ok(Some(Final {
            chunks: final_chunks,
            max_lanes: layout.max_columns(),
            labels,
            index,
        }))
    }

    /// Appends a sealed chunk to the provisional generation, creating it on
    /// the first chunk, and wakes waiting readers.
    fn publish_chunk(&self, chunk: &Arc<Chunk>, max_lanes: u32, labels: &Arc<RefLabels>) {
        let mut state = lock(&self.shared);
        match &mut state.current {
            Some(g) if g.generation == self.generation && !g.complete => {
                g.chunks.push(Arc::clone(chunk));
                g.max_lanes = max_lanes;
            }
            Some(_) => return,
            None => {
                state.current = Some(Generation {
                    generation: self.generation,
                    complete: false,
                    max_lanes,
                    chunks: vec![Arc::clone(chunk)],
                    labels: Arc::clone(labels),
                    index: None,
                });
            }
        }
        self.shared.1.notify_all();
    }

    /// The rows of `chunks` in order: moved out of chunks nobody else
    /// holds, cloned from those a reader (or the provisional generation)
    /// still shares. `None` when cancelled, checked once per chunk.
    fn take_rows(&self, chunks: Vec<Arc<Chunk>>) -> Option<Vec<Row>> {
        let mut rows = Vec::with_capacity(chunks.iter().map(|c| c.rows.len()).sum());
        for chunk in chunks {
            if self.cancelled() {
                return None;
            }
            match Arc::try_unwrap(chunk) {
                Ok(chunk) => rows.extend(chunk.rows),
                Err(shared) => rows.extend(shared.rows.iter().cloned()),
            }
        }
        Some(rows)
    }
}

/// The error a panicked build reports.
const BUILD_PANICKED: &str = "the commit graph build stopped unexpectedly";

/// `seen` value of a commit discovered but not yet emitted.
const PENDING: u32 = u32::MAX;

/// Pass A without the thread: a best-first walk from the tips that yields
/// the newest committer time first among the commits discovered so far,
/// ties going to the earlier discovered.
pub(crate) struct Traversal<'r> {
    repo: &'r Repository,
    /// Pushed on the first [`Self::next_row`], where lookups may fail.
    tips: Vec<Oid>,
    /// Discovered commits not yet emitted, parsed once.
    heap: BinaryHeap<Pending>,
    /// Every discovered commit: its row index once emitted, else `PENDING`.
    seen: HashMap<Oid, u32>,
    discovered: u32,
    emitted: u32,
    /// Interned authors by `name NUL email`.
    authors: HashMap<Box<[u8]>, Arc<Author>>,
    author_key: Vec<u8>,
}

impl<'r> Traversal<'r> {
    pub(crate) fn new(repo: &'r Repository, tips: &[Oid]) -> Self {
        Self {
            repo,
            tips: tips.to_vec(),
            heap: BinaryHeap::new(),
            seen: HashMap::new(),
            discovered: 0,
            emitted: 0,
            authors: HashMap::new(),
            author_key: Vec::new(),
        }
    }

    /// The next row with its committer time, or `None` when every commit
    /// reachable from the tips was emitted. A parent emitted before its
    /// child (committer date skew) is marked in the row's `layout_skips`.
    pub(crate) fn next_row(&mut self) -> Result<Option<(Row, i64)>, GitError> {
        for tip in std::mem::take(&mut self.tips) {
            self.discover(tip)?;
        }
        let Some(next) = self.heap.pop() else {
            return Ok(None);
        };
        self.seen.insert(next.oid, self.emitted);
        self.emitted += 1;

        let mut layout_skips = 0u32;
        for (i, parent) in next.parents.iter().enumerate() {
            match self.seen.get(parent) {
                Some(&row) if row != PENDING => {
                    if i < SKIP_BITS {
                        layout_skips |= 1 << i;
                    }
                }
                Some(_) => {}
                None => self.discover(*parent)?,
            }
        }
        let row = Row {
            oid: next.oid,
            parents: next.parents,
            subject: next.subject,
            author: next.author,
            author_time: next.author_time,
            layout_skips,
        };
        Ok(Some((row, next.time)))
    }

    /// Every commit discovered so far, with its row index once emitted.
    pub(crate) fn seen(&self) -> &HashMap<Oid, u32> {
        &self.seen
    }

    /// The oid to row index map, once the walk is exhausted.
    pub(crate) fn into_seen(self) -> HashMap<Oid, u32> {
        self.seen
    }

    /// Reads `oid` (the only time it is parsed) and queues it, unless it
    /// was discovered before.
    fn discover(&mut self, oid: Oid) -> Result<(), GitError> {
        if self.seen.contains_key(&oid) {
            return Ok(());
        }
        let commit = self.repo.find_commit(oid)?;
        let author = commit.author();
        let pending = Pending {
            time: commit.time().seconds(),
            seq: self.discovered,
            oid,
            parents: commit.parent_ids().collect(),
            subject: String::from_utf8_lossy(commit.summary_bytes().unwrap_or_default()).into(),
            author: self.intern(author.name_bytes(), author.email_bytes()),
            author_time: author.when().seconds(),
        };
        self.seen.insert(oid, PENDING);
        self.heap.push(pending);
        self.discovered += 1;
        Ok(())
    }

    fn intern(&mut self, name: &[u8], email: &[u8]) -> Arc<Author> {
        self.author_key.clear();
        self.author_key.extend_from_slice(name);
        self.author_key.push(0);
        self.author_key.extend_from_slice(email);
        if let Some(author) = self.authors.get(self.author_key.as_slice()) {
            return Arc::clone(author);
        }
        let author = Arc::new(Author {
            name: String::from_utf8_lossy(name).into_owned(),
            email: String::from_utf8_lossy(email).into_owned(),
        });
        self.authors.insert(
            self.author_key.clone().into_boxed_slice(),
            Arc::clone(&author),
        );
        author
    }
}

/// A discovered commit waiting to be emitted, with everything its row needs.
/// Ordered by committer time, then earlier discovery first.
struct Pending {
    time: i64,
    seq: u32,
    oid: Oid,
    parents: Box<[Oid]>,
    subject: Box<str>,
    author: Arc<Author>,
    author_time: i64,
}

impl Pending {
    fn key(&self) -> (i64, Reverse<u32>) {
        (self.time, Reverse(self.seq))
    }
}

impl Ord for Pending {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        self.key().cmp(&other.key())
    }
}

impl PartialOrd for Pending {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Pending {
    fn eq(&self, other: &Self) -> bool {
        self.key() == other.key()
    }
}

impl Eq for Pending {}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use git2::{Signature, Time};

    use super::*;

    fn commit(repo: &Repository, time: i64, parents: &[Oid]) -> Oid {
        let sig = Signature::new("Ada", "ada@example.com", &Time::new(time, 0)).unwrap();
        let tree = repo
            .find_tree(repo.treebuilder(None).unwrap().write().unwrap())
            .unwrap();
        let parents: Vec<git2::Commit> = parents
            .iter()
            .map(|p| repo.find_commit(*p).unwrap())
            .collect();
        let parents: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(None, &sig, &sig, &format!("t{time}"), &tree, &parents)
            .unwrap()
    }

    fn walk(repo: &Repository, tips: &[Oid]) -> Vec<(Oid, i64, u32)> {
        let mut t = Traversal::new(repo, tips);
        let mut out = Vec::new();
        while let Some((row, time)) = t.next_row().unwrap() {
            out.push((row.oid, time, row.layout_skips));
        }
        out
    }

    #[test]
    fn traversal_yields_newest_committer_time_first_and_marks_emitted_parents() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // root(10) <- p(20) <- c(5), with both c and p as tips.
        let root = commit(&repo, 10, &[]);
        let p = commit(&repo, 20, &[root]);
        let c = commit(&repo, 5, &[p]);
        let got = walk(&repo, &[c, p]);
        // p (20) pops before c (5) and root (10); c's parent p was emitted.
        assert_eq!(got, vec![(p, 20, 0), (root, 10, 0), (c, 5, 1)]);
    }

    #[test]
    fn traversal_marks_an_emitted_octopus_parent_past_index_sixteen() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // Twenty roots p0..p19 at times 10..29 and an older octopus over all of
        // them; p17 is also a tip, so it is emitted before the octopus.
        let parents: Vec<Oid> = (0..20).map(|i| commit(&repo, 10 + i, &[])).collect();
        let octopus = commit(&repo, 5, &parents);
        let got = walk(&repo, &[octopus, parents[17]]);
        let skips = got.iter().find(|r| r.0 == octopus).map(|r| r.2);
        assert_eq!(skips, Some(1u32 << 17));
    }

    #[test]
    fn traversal_lists_each_commit_once_and_shares_authors() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let root = commit(&repo, 1, &[]);
        let a = commit(&repo, 2, &[root]);
        let b = commit(&repo, 3, &[root]);
        let m = commit(&repo, 4, &[a, b]);
        let mut t = Traversal::new(&repo, &[m, a, b]);
        let mut rows = Vec::new();
        while let Some((row, _)) = t.next_row().unwrap() {
            rows.push(row);
        }
        let oids: Vec<Oid> = rows.iter().map(|r| r.oid).collect();
        assert_eq!(oids, vec![m, b, a, root]);
        assert!(Arc::ptr_eq(&rows[0].author, &rows[3].author));
        assert_eq!(t.seen().len(), 4);
        assert_eq!(t.into_seen()[&root], 3);
    }
}
