//! The commit graph as compact rows in fixed-size chunks, the state a
//! background builder shares with readers, and the snapshot pages are read
//! from. Lanes and edges are not stored: a page replays the layout from the
//! column state recorded at the start of the chunk it begins in.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

use git2::{Oid, Repository};

use super::lanes::LaneLayout;
use super::search;
use crate::error::GitError;
use crate::model::{GraphRow, LogPage, RefLabel};

/// Rows per chunk. Every chunk but the last of a generation holds exactly
/// this many.
pub(crate) const CHUNK_ROWS: usize = 500;

/// The most rows one page may hold.
const MAX_PAGE: u32 = 1000;

/// An author identity, shared by every row that names it.
pub(crate) struct Author {
    pub name: String,
    pub email: String,
}

/// One commit as stored: no lane, no edges, no ref labels.
#[derive(Clone)]
pub(crate) struct Row {
    pub oid: Oid,
    pub parents: Box<[Oid]>,
    pub subject: Box<str>,
    pub author: Arc<Author>,
    pub author_time: i64,
    /// Bit i set: parent i (i < 16) was ignored by the provisional layout. Parents at index >= 16 are never ignored.
    pub layout_skips: u16,
}

impl Row {
    /// The parents the layout follows: `scratch` refilled with every parent
    /// whose `layout_skips` bit is clear (parents at index 16 and up always).
    pub fn layout_parents<'a>(&self, scratch: &'a mut Vec<Oid>) -> &'a [Oid] {
        scratch.clear();
        scratch.extend(
            self.parents
                .iter()
                .enumerate()
                .filter(|&(i, _)| i >= 16 || self.layout_skips & (1 << i) == 0)
                .map(|(_, p)| *p),
        );
        scratch
    }
}

/// Up to [`CHUNK_ROWS`] consecutive rows and the layout's column state
/// before the first of them.
pub(crate) struct Chunk {
    pub rows: Vec<Row>,
    pub columns_at_start: Vec<Option<Oid>>,
}

/// Ref labels by the commit they point at.
pub(crate) type RefLabels = HashMap<Oid, Vec<RefLabel>>;

/// One build of the graph, complete or still growing.
pub(crate) struct Generation {
    pub generation: u64,
    pub complete: bool,
    pub max_lanes: u32,
    pub chunks: Vec<Arc<Chunk>>,
    pub labels: Arc<RefLabels>,
    /// Present only when complete.
    pub index: Option<Arc<HashMap<Oid, u32>>>,
}

impl Generation {
    /// The rows readers may see: all of them once complete, otherwise only
    /// those in sealed (full) chunks. The builder only ever leaves a short
    /// chunk last.
    pub fn total(&self) -> u32 {
        let rows = if self.complete {
            self.chunks.iter().map(|c| c.rows.len()).sum()
        } else {
            self.chunks
                .iter()
                .filter(|c| c.rows.len() == CHUNK_ROWS)
                .count()
                * CHUNK_ROWS
        };
        to_u32(rows)
    }
}

/// What the background builder and its readers share.
pub(crate) struct LogShared {
    pub current: Option<Generation>,
    /// Generation number of the build in progress, if any.
    pub building: Option<u64>,
    pub refreshing: bool,
    pub error: Option<GitError>,
    pub provisional_observed: bool,
    pub next_generation: u64,
}

pub(crate) type SharedLog = Arc<(Mutex<LogShared>, Condvar)>;

pub(crate) fn new_shared() -> SharedLog {
    Arc::new((
        Mutex::new(LogShared {
            current: None,
            building: None,
            refreshing: false,
            error: None,
            provisional_observed: false,
            next_generation: 1,
        }),
        Condvar::new(),
    ))
}

/// Locks the shared state. Poisoning is ignored: a panicked builder only
/// stops publishing, and every value it left is still a valid state.
pub(crate) fn lock(shared: &SharedLog) -> MutexGuard<'_, LogShared> {
    shared.0.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A reader's view of one generation, cheap to take: chunks and maps are
/// shared, not copied.
pub struct LogSnapshot {
    generation: u64,
    complete: bool,
    max_lanes: u32,
    total: u32,
    chunks: Vec<Arc<Chunk>>,
    labels: Arc<HashMap<Oid, Vec<RefLabel>>>,
    index: Option<Arc<HashMap<Oid, u32>>>,
    repo_path: PathBuf,
}

impl LogSnapshot {
    pub(crate) fn from_generation(g: &Generation, repo_path: PathBuf) -> Self {
        Self {
            generation: g.generation,
            complete: g.complete,
            max_lanes: g.max_lanes,
            total: g.total(),
            chunks: g.chunks.clone(),
            labels: Arc::clone(&g.labels),
            index: g.index.clone(),
            repo_path,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The rows this snapshot serves; see [`Generation::total`].
    pub fn total(&self) -> u32 {
        self.total
    }

    pub fn is_complete(&self) -> bool {
        self.complete
    }

    pub fn max_lanes(&self) -> u32 {
        self.max_lanes
    }

    /// Up to `count` rows (clamped to 1..=1000) from row `start`, with lanes
    /// and edges replayed from the start of `start`'s chunk. Rows at or past
    /// [`Self::total`] are not served.
    pub fn page(&self, start: u32, count: u32) -> LogPage {
        let count = count.clamp(1, MAX_PAGE);
        let end = start.saturating_add(count).min(self.total);
        let mut rows = Vec::new();
        if start < end {
            let (first_chunk, offset) = position(start);
            let mut layout =
                LaneLayout::from_columns(self.chunks[first_chunk].columns_at_start.clone());
            let mut scratch = Vec::new();
            for row in &self.chunks[first_chunk].rows[..offset] {
                layout.advance(row.oid, row.layout_parents(&mut scratch));
            }
            let wanted = (end - start) as usize;
            rows.reserve(wanted);
            let served = self.chunks[first_chunk..]
                .iter()
                .flat_map(|c| c.rows.iter())
                .skip(offset)
                .take(wanted);
            for row in served {
                let (lane, edges) = layout.next(row.oid, row.layout_parents(&mut scratch));
                rows.push(self.graph_row(row, lane, edges));
            }
        }
        LogPage { start, rows }
    }

    /// Indices, ascending, of the served rows that match `query`
    /// (case-insensitive; see [`search::matches`]). A blank query matches
    /// nothing; a full 40-hex hash is answered from the oid index without
    /// reading git. Anything else scans the rows, reading commit messages
    /// through a `Repository` opened on [`Self::repo_path`] for this call.
    pub fn search(&self, query: &str) -> Result<Vec<u32>, GitError> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        if query.len() == 40
            && let Ok(oid) = Oid::from_str(&query)
        {
            return Ok(self.find(oid).into_iter().collect());
        }
        let repo = Repository::open(self.repo_path())?;
        Ok(self
            .rows()
            .enumerate()
            .filter(|(_, row)| search::matches(&repo, row, &query))
            .map(|(i, _)| to_u32(i))
            .collect())
    }

    /// The served rows, in order.
    pub(crate) fn rows(&self) -> impl Iterator<Item = &Row> {
        self.chunks
            .iter()
            .flat_map(|c| c.rows.iter())
            .take(self.total as usize)
    }

    /// Row `index`, when this snapshot serves it.
    pub(crate) fn row(&self, index: u32) -> Option<&Row> {
        if index >= self.total {
            return None;
        }
        let (chunk, offset) = position(index);
        self.chunks.get(chunk)?.rows.get(offset)
    }

    /// The index of `oid`: from the index when present, else a linear scan
    /// over the served rows.
    pub(crate) fn find(&self, oid: Oid) -> Option<u32> {
        match &self.index {
            Some(index) => index.get(&oid).copied().filter(|&i| i < self.total),
            None => self.rows().position(|r| r.oid == oid).map(to_u32),
        }
    }

    pub(crate) fn repo_path(&self) -> &Path {
        &self.repo_path
    }

    fn graph_row(&self, row: &Row, lane: u32, edges: Vec<crate::model::GraphEdge>) -> GraphRow {
        GraphRow {
            oid: row.oid.to_string(),
            parents: row.parents.iter().map(Oid::to_string).collect(),
            subject: row.subject.to_string(),
            author_name: row.author.name.clone(),
            author_email: row.author.email.clone(),
            author_time: row.author_time,
            lane,
            edges,
            refs: self.labels.get(&row.oid).cloned().unwrap_or_default(),
        }
    }
}

/// The chunk holding row `index` and the row's offset in it.
fn position(index: u32) -> (usize, usize) {
    let index = index as usize;
    (index / CHUNK_ROWS, index % CHUNK_ROWS)
}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Arc;

    use git2::Oid;

    use super::*;
    use crate::log::lanes::LaneLayout;
    use crate::model::{GraphEdge, RefKind, RefLabel};

    fn oid(n: u32) -> Oid {
        let mut bytes = [0u8; 20];
        bytes[..4].copy_from_slice(&n.to_be_bytes());
        bytes[19] = 0xab;
        Oid::from_bytes(&bytes).unwrap()
    }

    fn o(n: u8) -> Oid {
        Oid::from_bytes(&[n; 20]).unwrap()
    }

    fn e(top: Option<u32>, bottom: Option<u32>) -> GraphEdge {
        GraphEdge { top, bottom }
    }

    fn author() -> Arc<Author> {
        thread_local! {
            static AUTHOR: Arc<Author> = Arc::new(Author {
                name: "Ada".into(),
                email: "ada@example.com".into(),
            });
        }
        AUTHOR.with(Arc::clone)
    }

    fn make_row(oid: Oid, parents: Vec<Oid>) -> Row {
        Row {
            oid,
            parents: parents.into_boxed_slice(),
            subject: "subject".into(),
            author: author(),
            author_time: 1_700_000_000,
            layout_skips: 0,
        }
    }

    fn row(n: u8, parents: &[u8]) -> Row {
        make_row(o(n), parents.iter().map(|&p| o(p)).collect())
    }

    fn row_n(n: u32, parents: &[u32]) -> Row {
        make_row(oid(n), parents.iter().map(|&p| oid(p)).collect())
    }

    /// Lays `rows` out straight and cuts them into chunks, recording the
    /// column state before each chunk, as the builder will.
    fn generation_of(rows: Vec<Row>, complete: bool) -> Generation {
        let mut layout = LaneLayout::new();
        let mut scratch = Vec::new();
        let mut chunks = Vec::new();
        let mut index = HashMap::new();
        let mut rows = rows.into_iter().peekable();
        let mut n = 0u32;
        while rows.peek().is_some() {
            let columns_at_start = layout.columns().to_vec();
            let mut chunk_rows = Vec::with_capacity(CHUNK_ROWS);
            for r in rows.by_ref().take(CHUNK_ROWS) {
                layout.advance(r.oid, r.layout_parents(&mut scratch));
                index.insert(r.oid, n);
                n += 1;
                chunk_rows.push(r);
            }
            chunks.push(Arc::new(Chunk {
                rows: chunk_rows,
                columns_at_start,
            }));
        }
        Generation {
            generation: 7,
            complete,
            max_lanes: layout.max_columns(),
            chunks,
            labels: Arc::new(HashMap::new()),
            index: complete.then(|| Arc::new(index)),
        }
    }

    fn snapshot(g: &Generation) -> LogSnapshot {
        LogSnapshot::from_generation(g, PathBuf::from("/repo"))
    }

    fn merge_shape() -> Vec<Row> {
        vec![row(9, &[3, 2]), row(3, &[1]), row(2, &[1]), row(1, &[])]
    }

    /// Two parallel lines of history with a merge every hundred rows, so
    /// the columns stay occupied across chunk boundaries.
    fn two_branch_rows(n: u32) -> Vec<Row> {
        (0..n)
            .map(|i| {
                let mut parents = Vec::new();
                if i + 2 < n {
                    parents.push(i + 2);
                }
                if i % 100 == 0 && i + 3 < n {
                    parents.push(i + 3);
                }
                row_n(i, &parents)
            })
            .collect()
    }

    #[test]
    fn row_fits_in_eighty_bytes() {
        assert!(
            std::mem::size_of::<Row>() <= 80,
            "{}",
            std::mem::size_of::<Row>()
        );
    }

    #[test]
    fn page_rows_carry_hex_oids_parents_and_strings() {
        let g = generation_of(vec![row(2, &[1]), row(1, &[])], true);
        let page = snapshot(&g).page(0, 1);
        assert_eq!(page.start, 0);
        assert_eq!(page.rows.len(), 1);
        let r = &page.rows[0];
        assert_eq!(r.oid.len(), 40);
        assert_eq!(r.oid, o(2).to_string());
        assert_eq!(r.parents, vec![o(1).to_string()]);
        assert_eq!(r.subject, "subject");
        assert_eq!(r.author_name, "Ada");
        assert_eq!(r.author_email, "ada@example.com");
        assert_eq!(r.author_time, 1_700_000_000);
    }

    #[test]
    fn page_lanes_and_edges_equal_a_straight_layout_on_the_merge_shape() {
        let g = generation_of(merge_shape(), true);
        let got: Vec<_> = snapshot(&g)
            .page(0, 10)
            .rows
            .into_iter()
            .map(|r| (r.lane, r.edges))
            .collect();
        let (n, s0, s1) = (None, Some(0), Some(1));
        assert_eq!(
            got,
            vec![
                (0, vec![e(n, s0), e(n, s1)]),
                (0, vec![e(n, s0), e(s0, n), e(s1, s1)]),
                (1, vec![e(n, s1), e(s0, s0), e(s1, n)]),
                (0, vec![e(s0, n), e(s1, n)]),
            ]
        );
        assert_eq!(g.max_lanes, 2);
    }

    #[test]
    fn page_spanning_chunks_equals_straight_layout() {
        let rows = two_branch_rows(1600);
        let mut straight = LaneLayout::new();
        let mut scratch = Vec::new();
        let expected: Vec<_> = rows
            .iter()
            .map(|r| straight.next(r.oid, r.layout_parents(&mut scratch)))
            .collect();
        let g = generation_of(rows, true);
        let page = snapshot(&g).page(700, 1000);
        assert_eq!(page.start, 700);
        let got: Vec<_> = page.rows.into_iter().map(|r| (r.lane, r.edges)).collect();
        assert_eq!(got.len(), 900);
        assert_eq!(got, expected[700..]);
    }

    #[test]
    fn page_count_is_clamped_to_one_and_one_thousand() {
        let g = generation_of(two_branch_rows(1600), true);
        let s = snapshot(&g);
        assert_eq!(s.page(0, 0).rows.len(), 1);
        assert_eq!(s.page(0, 5000).rows.len(), 1000);
    }

    #[test]
    fn page_past_the_end_is_empty_and_keeps_start() {
        let g = generation_of(vec![row(3, &[2]), row(2, &[1]), row(1, &[])], true);
        let s = snapshot(&g);
        assert_eq!(s.total(), 3);
        let page = s.page(3, 10);
        assert!(page.rows.is_empty());
        assert_eq!(page.start, 3);
        assert!(s.page(999, 1).rows.is_empty());
    }

    #[test]
    fn incomplete_generation_total_counts_sealed_chunks_only() {
        let rows = two_branch_rows(2 * CHUNK_ROWS as u32 + 7);
        let partial = generation_of(rows, false);
        assert_eq!(partial.total(), 1000);
        assert_eq!(snapshot(&partial).total(), 1000);
        assert!(!snapshot(&partial).is_complete());
        let rows = two_branch_rows(2 * CHUNK_ROWS as u32 + 7);
        let whole = generation_of(rows, true);
        assert_eq!(whole.total(), 1007);
        assert_eq!(snapshot(&whole).total(), 1007);
        assert!(snapshot(&whole).is_complete());
    }

    #[test]
    fn incomplete_generation_does_not_serve_rows_beyond_sealed_chunks() {
        let g = generation_of(two_branch_rows(2 * CHUNK_ROWS as u32 + 7), false);
        let s = snapshot(&g);
        assert_eq!(s.page(990, 50).rows.len(), 10);
        assert!(s.row(999).is_some());
        assert!(s.row(1000).is_none());
    }

    #[test]
    fn skipped_parent_is_omitted_from_layout_but_kept_in_parents() {
        let mut r = row(5, &[1, 2]);
        r.layout_skips = 0b10;
        let g = generation_of(vec![r], true);
        let page = snapshot(&g).page(0, 1);
        assert_eq!(page.rows[0].edges, vec![e(None, Some(0))]);
        assert_eq!(page.rows[0].parents.len(), 2);
    }

    #[test]
    fn layout_parents_drops_skipped_parents_below_sixteen_only() {
        let parents: Vec<u32> = (100..120).collect();
        let mut r = row_n(1, &parents);
        r.layout_skips = 0b1000_0000_0000_0101;
        let mut scratch = vec![oid(999)];
        let kept: Vec<Oid> = r.layout_parents(&mut scratch).to_vec();
        let expected: Vec<Oid> = (100..120)
            .filter(|p| ![100, 102, 115].contains(p))
            .map(oid)
            .collect();
        assert_eq!(kept, expected);
    }

    #[test]
    fn find_uses_the_index_when_present_and_scans_otherwise() {
        let mut g = generation_of(merge_shape(), true);
        let indexed = snapshot(&g);
        g.index = None;
        let scanned = snapshot(&g);
        assert_eq!(indexed.find(o(2)), Some(2));
        assert_eq!(scanned.find(o(2)), Some(2));
        assert_eq!(indexed.find(o(77)), None);
        assert_eq!(scanned.find(o(77)), None);
        assert_eq!(indexed.row(2).map(|r| r.oid), Some(o(2)));
    }

    #[test]
    fn refs_come_from_the_labels_map() {
        let mut g = generation_of(merge_shape(), true);
        let label = RefLabel {
            kind: RefKind::Branch,
            name: "main".into(),
            is_head: true,
        };
        g.labels = Arc::new(HashMap::from([(o(9), vec![label.clone()])]));
        let s = snapshot(&g);
        let rows = s.page(0, 10).rows;
        assert_eq!(rows[0].refs, vec![label]);
        assert!(rows[1..].iter().all(|r| r.refs.is_empty()));
        assert_eq!(s.generation(), 7);
        assert_eq!(s.max_lanes(), 2);
        assert_eq!(s.repo_path(), std::path::Path::new("/repo"));
    }
}
