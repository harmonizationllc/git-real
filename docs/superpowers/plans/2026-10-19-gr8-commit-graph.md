# GR-8 Commit Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The centre of the repo pane shows the commit graph (lanes, merge curves, ref labels, subject, author, relative date), virtualized over the whole history, searchable, with a context menu (checkout, create branch, reset, copy hash) and a commit summary panel in the sidebar.

**Architecture:** `git-real-core` gains a `log` module: one topological walk with a pure streaming lane layout, cached in the `RepoSession` and invalidated by a ref fingerprint; pages, search and commit detail read from the cache; checkout of a commit shells out to `git switch --detach`, reset uses git2. The Tauri app exposes six commands and the clipboard plugin. The front end adds `src/features/graph/` (virtualized listbox over on-demand pages keyed by generation), `src/features/history/CommitSummary`, a `side` prop on `SplitHandle`, a Close control on the diff, and a refs | centre | sidebar grid.

**Tech Stack:** Rust 2024 + git2 0.20 (`default-features = false`), `std::process::Command`, Tauri 2 + `tauri-plugin-clipboard-manager` 2, React 19 + TypeScript, TanStack Query 5, `@tanstack/react-virtual` 3, Zustand 5, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-19-gr8-commit-graph-design.md`

## Global Constraints

- Tests first, by the test role; the developer role never edits test files (CLAUDE.md).
- The only modules importing `@tauri-apps/api/*` or `@tauri-apps/plugin-*` live in `src/lib/ipc` (ESLint-enforced).
- `git2` stays `default-features = false`; no direct `tokio`; blocking work runs through `run_blocking`; `git-real-core` has no Tauri dependency.
- Checkout of a commit always shells out to `git -C <workdir> switch --detach <full hex>`; only a validated full hex oid reaches the command line. Reset uses `git2::Repository::reset`.
- The cache lives in `RepoSession` and is rebuilt only when the ref fingerprint changes; `generation` starts at 1 and increments per rebuild.
- Lane layout follows spec section 3.3 exactly; edges are sorted by `(top, bottom)` with `None` first.
- Search: query trimmed and lowercased; hash match only for 4–40 hex characters as an oid prefix; body read lazily only for rows nothing else matched; indices ascending.
- Serde: every new struct and enum is `rename_all = "camelCase"`; oids are full hex strings on the wire. New error kinds: `logStale`, `commitNotFound`.
- Query keys: summary under the repo prefix (`["repo", id, "log"]`); pages, search and commit detail under `["repoImmutable", id, ...]` with `staleTime: Infinity`.
- Constants: `PAGE_SIZE = 500`, `ROW_HEIGHT = 28`, `LANE_WIDTH = 14`, `MAX_DRAWN_LANES = 12`, `MAX_LABELS = 3`, `SEARCH_DEBOUNCE_MS = 200`; page `count` clamp `1..=1000` in core.
- Copy (verbatim): list `aria-label="Commits"`; loading `Loading history…`; empty `No commits yet`; search `aria-label="Search commits"` and placeholder `Search commits`; counter `<current> of <n>` / `No matches`; buttons `Previous`, `Next`; menu items `Checkout`, `Create branch here…`, `Reset to this commit…`, `Copy hash`; checkout title `Detaches HEAD at <7 hex>`; prompt title `New branch from <7 hex>`, label `Name`, checkbox `Switch to new branch`, confirm `Create`; reset title `Reset to <7 hex>?`, radio group `Mode`, options `Soft — keep the index and working tree`, `Mixed — keep the working tree, unstage everything`, `Hard — discard index and working tree changes`, line `Moves <branch> to <7 hex>.` / `Moves HEAD to <7 hex>.`, confirm `Reset`; diff close `aria-label="Close diff"`; summary section `aria-label="Commit details"`, heading `Commit <7 hex>`, buttons `Copy` and `Close` (`aria-label="Close commit details"`), `Loading commit…`; placeholder row text `…`.
- One new dependency pair: `tauri-plugin-clipboard-manager = "2"` (Rust) and `@tauri-apps/plugin-clipboard-manager` (npm); capability `clipboard-manager:allow-write-text`.
- Gates: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`, `npm test` at 100 % coverage for `src/`, `npm run lint`, `npm run typecheck`.

## Review Focus

1. A page requested with a generation the backend no longer holds must not loop: the UI invalidates the summary once and shows placeholders, never an error (Task 5 test `useLogPages invalidates the summary once on logStale and does not retry`).
2. A tag that points at a tree or blob, and `refs/remotes/origin/HEAD`, must not crash or label anything (Task 1 tests `tag_of_a_blob_is_skipped`, `remote_head_symbolic_ref_is_skipped`).
3. A commit whose first parent is already expected by another column must still draw both lines to the parent's row, and a later parent already expected must yield both a pass-through and a join (Task 1 lanes tests `two_tips_share_a_parent`, `later_parent_already_expected_yields_pass_through_and_join`).
4. Repository with an unborn HEAD but a fetched remote: the walk must still list the remote's commits and the summary must not report `total: 0` (Task 1 test `unborn_head_with_remote_branches_lists_them`).
5. Selecting a commit whose row is off-screen must scroll to it exactly once and must not scroll when the row is already rendered (Task 5 tests `reveals an off-screen selection through searchLog` and `does not scroll for a rendered selection`).

---

### Task 1: Core — log model, lanes, cache, walk, pages, search, commit detail

**Files:**

- Create: `src-tauri/crates/git-real-core/src/model/log.rs`
- Modify: `src-tauri/crates/git-real-core/src/model/mod.rs` (add `mod log;` and `pub use log::{CommitDetail, GraphEdge, GraphRow, LogPage, LogSummary, RefKind, RefLabel, ResetMode, Signature};`)
- Modify: `src-tauri/crates/git-real-core/src/error.rs` (add `LogStale`, `CommitNotFound(String)`)
- Create: `src-tauri/crates/git-real-core/src/log/mod.rs`, `log/lanes.rs`, `log/cache.rs`, `log/walk.rs`, `log/search.rs`
- Modify: `src-tauri/crates/git-real-core/src/lib.rs` (add `pub mod log;`)
- Modify: `src-tauri/crates/git-real-core/src/repo/session.rs` (field `pub(crate) log_cache: Option<crate::log::cache::LogCache>`, initialised `None` in `from_repo`)
- Test: unit tests inside `log/lanes.rs` (`#[cfg(test)] mod tests`), `src-tauri/crates/git-real-core/tests/log.rs`
- Test helper: `src-tauri/crates/git-real-core/tests/common/mod.rs` gains `merge_fixture()` (see Step 1) and `tag_lightweight(path, name, oid)`, `tag_annotated(path, name, oid)`

**Interfaces:**

- Consumes: `RepoSession::repo()` (pub(crate)), `commit::message::split(&str) -> CommitMessage`, `GitError`.
- Produces:

```rust
// model/log.rs — all #[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub enum RefKind { Head, Branch, Remote, Tag }
pub struct RefLabel { pub kind: RefKind, pub name: String, pub is_head: bool }
#[derive(Copy, PartialOrd, Ord)] pub struct GraphEdge { pub top: Option<u32>, pub bottom: Option<u32> }
pub struct GraphRow { pub oid: String, pub parents: Vec<String>, pub subject: String, pub author_name: String,
    pub author_email: String, pub author_time: i64, pub lane: u32, pub edges: Vec<GraphEdge>, pub refs: Vec<RefLabel> }
pub struct LogSummary { pub generation: u64, pub total: u32, pub max_lanes: u32 }
pub struct LogPage { pub start: u32, pub rows: Vec<GraphRow> }
pub struct Signature { pub name: String, pub email: String, pub time: i64 }
pub struct CommitDetail { pub oid: String, pub parents: Vec<String>, pub message: CommitMessage, pub author: Signature, pub committer: Signature }
#[derive(Copy, Deserialize)] pub enum ResetMode { Soft, Mixed, Hard }   // Deserialize too: it arrives from the UI

// log/lanes.rs
pub struct LaneLayout { columns: Vec<Option<Oid>>, max_columns: u32 }
impl LaneLayout { pub fn new() -> Self; pub fn next(&mut self, oid: Oid, parents: &[Oid]) -> (u32, Vec<GraphEdge>); pub fn max_columns(&self) -> u32 }

// log/cache.rs
pub(crate) struct CachedRow { oid: Oid, parents: Vec<Oid>, subject: String, author_name: String, author_email: String, author_time: i64, lane: u32, edges: Vec<GraphEdge>, refs: Vec<RefLabel> }
pub(crate) struct LogCache { pub generation: u64, pub fingerprint: u64, pub rows: Vec<CachedRow>, pub max_lanes: u32 }
pub(crate) fn fingerprint(repo: &Repository) -> Result<u64, GitError>
impl CachedRow { pub(crate) fn to_row(&self) -> GraphRow }

// log/walk.rs
pub(crate) fn build(repo: &Repository, generation: u64, fingerprint: u64) -> Result<LogCache, GitError>

// log/search.rs
pub(crate) fn matches(repo: &Repository, row: &CachedRow, query: &str) -> bool   // query already trimmed + lowercased

// log/mod.rs
impl RepoSession {
    pub fn log_summary(&mut self) -> Result<LogSummary, GitError>;
    pub fn log_page(&self, generation: u64, start: u32, count: u32) -> Result<LogPage, GitError>;
    pub fn search_log(&self, generation: u64, query: &str) -> Result<Vec<u32>, GitError>;
    pub fn commit_detail(&self, oid: &str) -> Result<CommitDetail, GitError>;
}
// GitError::LogStale ("the commit graph changed; reload it"), GitError::CommitNotFound(String) ("{0} is not a commit in this repository")
```

- [ ] **Step 1: Write the failing tests**

`log/lanes.rs` unit tests (synthetic oids: `fn o(n: u8) -> Oid { Oid::from_bytes(&[n; 20]).unwrap() }`, `fn e(top: Option<u32>, bottom: Option<u32>) -> GraphEdge`):

```rust
#[test] fn linear_history_is_one_column() {
    let mut l = LaneLayout::new();
    assert_eq!(l.next(o(2), &[o(1)]), (0, vec![e(None, Some(0))]));            // tip: no line above
    assert_eq!(l.next(o(1), &[o(0)]), (0, vec![e(None, Some(0)), e(Some(0), None)]));
    assert_eq!(l.next(o(0), &[]), (0, vec![e(Some(0), None)]));               // root: no bottom edge
    assert_eq!(l.max_columns(), 1);
}
#[test] fn merge_opens_a_second_column_and_closes_at_the_fork() {
    // M(parents A,B) ; A(parent R) ; B(parent R) ; R
    let (m, a, b, r) = (o(9), o(3), o(2), o(1));
    let mut l = LaneLayout::new();
    assert_eq!(l.next(m, &[a, b]), (0, vec![e(None, Some(0)), e(None, Some(1))]));
    assert_eq!(l.next(a, &[r]), (0, vec![e(None, Some(0)), e(Some(0), None), e(Some(1), Some(1))]));
    assert_eq!(l.next(b, &[r]), (1, vec![e(None, Some(1)), e(Some(0), Some(0)), e(Some(1), None)]));
    assert_eq!(l.next(r, &[]), (0, vec![e(Some(0), None), e(Some(1), None)]));
    assert_eq!(l.max_columns(), 2);
}
#[test] fn two_tips_share_a_parent() {
    // T1(parent R) ; T2(parent R) ; R — both columns run to R and join there
    let mut l = LaneLayout::new();
    assert_eq!(l.next(o(3), &[o(1)]), (0, vec![e(None, Some(0))]));
    assert_eq!(l.next(o(2), &[o(1)]), (1, vec![e(None, Some(1)), e(Some(0), Some(0))]));
    assert_eq!(l.next(o(1), &[]), (0, vec![e(Some(0), None), e(Some(1), None)]));
}
#[test] fn freed_column_is_reused() {
    // M(A,B) ; B(A) ; A(R) ; T(R) ; R — T takes column 1 again after A freed it
    let (m, a, b, t, r) = (o(9), o(3), o(2), o(4), o(1));
    let mut l = LaneLayout::new();
    l.next(m, &[a, b]); l.next(b, &[a]);
    assert_eq!(l.next(a, &[r]), (0, vec![e(None, Some(0)), e(Some(0), None), e(Some(1), None)]));
    assert_eq!(l.next(t, &[r]), (1, vec![e(None, Some(1)), e(Some(0), Some(0))]));
    assert_eq!(l.next(r, &[]), (0, vec![e(Some(0), None), e(Some(1), None)]));
    assert_eq!(l.max_columns(), 2);
}
#[test] fn octopus_merge_opens_two_columns() {
    let mut l = LaneLayout::new();
    assert_eq!(l.next(o(9), &[o(1), o(2), o(3)]), (0, vec![e(None, Some(0)), e(None, Some(1)), e(None, Some(2))]));
    assert_eq!(l.max_columns(), 3);
}
#[test] fn later_parent_already_expected_yields_pass_through_and_join() {
    // X(parent B) ; M(parents A,B)
    let mut l = LaneLayout::new();
    l.next(o(5), &[o(2)]);
    assert_eq!(l.next(o(4), &[o(3), o(2)]), (1, vec![e(None, Some(0)), e(None, Some(1)), e(Some(0), Some(0))]));
}
#[test] fn edges_are_sorted_none_first() { /* build any row with mixed edges and assert the Vec is sorted */ }
#[test] fn trailing_free_columns_are_trimmed() { /* after a root in column 1 with column 0 free, columns.len() == 0 */ }
```

`tests/common/mod.rs` additions:

```rust
/// R ← A (main) ; R ← B (feature) ; M = merge(A, B) on main. Returns (dir, path, r, a, b, m).
/// Commit times are forced apart (R, A, B, M = 1_700_000_000 + 0/10/20/30) through explicit Signatures
/// so the TIME sort is deterministic; the fixture builds commits with git2 directly, not `commit_file`.
pub fn merge_fixture() -> (TempDir, PathBuf, Oid, Oid, Oid, Oid)
pub fn tag_lightweight(path: &Path, name: &str, target: Oid)   // repo.tag_lightweight
pub fn tag_annotated(path: &Path, name: &str, target: Oid)     // repo.tag with a Signature and message "release"
```

`tests/log.rs` (git2 fixtures only; `fn open(path) -> RepoSession`):

- `summary_on_fresh_repo_is_one_row_with_head_branch_label`: `temp_repo_with_commit` → `log_summary()` = `{ generation: 1, total: 1, max_lanes: 1 }`; `log_page(1, 0, 10).rows[0]` has `lane 0`, `edges == []`? No: a lone root has no parents and nothing expected: `edges == []`; `refs == [RefLabel { kind: Branch, name: <head>, is_head: true }]`; `subject == "initial"`, `author_name == "Test User"`, `author_email == "test@example.com"`, `author_time > 0`, `parents == []`, `oid` is 40 hex.
- `merge_fixture_has_two_lanes_with_expected_edges`: rows in order M, B, A, R (TIME sort puts the newer B before A) and assert each row's `lane`, `edges` and `parents` per the lanes table above (M lane 0 edges `[{None,0},{None,1}]`; B lane 1 edges `[{None,1},{0,0},{1,None}]`; A lane 0 edges `[{None,0},{0,None},{1,1}]`; R lane 0 edges `[{0,None},{1,None}]`); `max_lanes == 2`; `main` label on M, `feature` label on B.
- `lightweight_and_annotated_tags_are_labelled`: tag `v1` lightweight and `v2` annotated on R → R's refs contain both `Tag` labels, ordered `v1`, `v2`, after branch labels.
- `tag_of_a_blob_is_skipped`: `tag_lightweight` on a blob oid → summary unchanged, no panic.
- `remote_labels_after_fetch_and_remote_head_symbolic_ref_is_skipped`: bare clone + `add_remote_and_fetch(path, bare, head)` → the head row has `Remote` label `origin/<head>` and no label named `origin/HEAD`.
- `detached_head_adds_head_label`: `repo.set_head_detached(oid)` → the row's refs start with `{ Head, "HEAD", is_head: true }` and the branch label has `is_head: false`.
- `unborn_repo_has_no_rows`: `temp_repo_unborn` → `{ generation: 1, total: 0, max_lanes: 0 }`, page is empty.
- `unborn_head_with_remote_branches_lists_them`: unborn repo + remote fetched from a repo with commits → `total >= 1`.
- `generation_is_stable_across_untracked_writes_and_bumps_on_ref_changes`: summary twice → same generation; `write_file` → same; `commit_file` → 2; `repo.branch("x", ...)` → 3; `set_head_detached` → 4.
- `page_bounds`: 3 commits: `log_page(g, 1, 10)` → `start 1`, 2 rows; `log_page(g, 3, 10)` → empty; `log_page(g, 0, 0)` → 1 row (clamp to 1); `log_page(g, 0, 5000)` → 3 rows.
- `stale_generation_is_rejected`: `log_page(g + 1, 0, 10)` and `search_log(g + 1, "x")` → `GitError::LogStale`; before any summary call `log_page(1, 0, 10)` → `LogStale`.
- `search_matches_hash_prefix_author_subject_and_body`: commits "feat: Add parser\n\nImplements the tokenizer" and "fix typo" by authors Alice <alice@x.io> and Bob; `search_log(g, "FEAT")` → `[idx of feat]`; `"alice@x"` → Alice's rows; `"tokenizer"` (body only) → feat row; `&oid[..7]` → that row; `"abc"` (3 hex) does not match by hash; `"   "` → `[]`; `"zzz"` → `[]`; indices ascending when several match.
- `commit_detail_has_message_parents_author_and_committer`: on M → `parents == [a, b]` hex, `message.subject == "merge"`, `message.body == ""`, author and committer names; a commit created with a different committer signature reports both.
- `commit_detail_unknown_or_malformed_oid`: `"deadbeef".repeat(5)` → `CommitNotFound`; `"nothex"` → `CommitNotFound`.

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real-core --test log` and `cargo test -p git-real-core lanes` (from `src-tauri`) → fail to compile on missing modules.

- [ ] **Step 3: Implement**

`log/lanes.rs`:

```rust
pub struct LaneLayout { columns: Vec<Option<Oid>>, max_columns: u32 }

impl LaneLayout {
    pub fn new() -> Self { Self { columns: Vec::new(), max_columns: 0 } }

    pub fn next(&mut self, oid: Oid, parents: &[Oid]) -> (u32, Vec<GraphEdge>) {
        let before: Vec<Option<Oid>> = self.columns.clone();
        let mut edges = Vec::new();
        // 1. the dot's column
        let expecting: Vec<usize> = (0..before.len()).filter(|&k| before[k] == Some(oid)).collect();
        let lane = match expecting.first() {
            Some(&k) => k,
            None => self.take_free(),
        };
        // 2. every column expecting this commit joins the dot and is freed
        for &k in &expecting {
            edges.push(GraphEdge { top: Some(k as u32), bottom: None });
            self.columns[k] = None;
        }
        // 3. parents leave the dot
        for (i, parent) in parents.iter().enumerate() {
            let k = if i == 0 { lane } else {
                match self.columns.iter().position(|c| *c == Some(*parent)) {
                    Some(k) => k,
                    None => self.take_free(),
                }
            };
            self.columns[k] = Some(*parent);
            edges.push(GraphEdge { top: None, bottom: Some(k as u32) });
        }
        // 4. untouched columns pass straight through
        for k in 0..before.len() {
            if before[k].is_some() && before[k] != Some(oid) && self.columns.get(k).is_some_and(Option::is_some) {
                edges.push(GraphEdge { top: Some(k as u32), bottom: Some(k as u32) });
            }
        }
        self.max_columns = self.max_columns.max(self.columns.len() as u32);
        while self.columns.last().is_some_and(Option::is_none) { self.columns.pop(); }
        edges.sort();
        (lane as u32, edges)
    }

    /// First free column, or a new one; the slot is left `None` for the caller to fill.
    fn take_free(&mut self) -> usize {
        match self.columns.iter().position(Option::is_none) {
            Some(k) => k,
            None => { self.columns.push(None); self.columns.len() - 1 }
        }
    }

    pub fn max_columns(&self) -> u32 { self.max_columns }
}
```

Note for step 1: when `take_free` is used for the dot and the commit has no parents, the column stays `None` and is trimmed. `max_columns` must be sampled before trimming (as above) so a dot in a new last column counts.

`log/cache.rs`:

```rust
pub(crate) fn fingerprint(repo: &Repository) -> Result<u64, GitError> {
    let mut entries: Vec<(String, String)> = Vec::new();
    for reference in repo.references()? {
        let r = reference?;
        let name = String::from_utf8_lossy(r.name_bytes()).into_owned();
        let target = match r.target() {
            Some(oid) => oid.to_string(),
            None => String::from_utf8_lossy(r.symbolic_target_bytes().unwrap_or_default()).into_owned(),
        };
        entries.push((name, target));
    }
    if let Ok(head) = repo.find_reference("HEAD") {
        entries.push(("HEAD".into(), head.target().map(|o| o.to_string())
            .or_else(|| head.symbolic_target().map(str::to_owned)).unwrap_or_default()));
    }
    entries.sort();
    let mut h = DefaultHasher::new();
    entries.hash(&mut h);
    Ok(h.finish())
}
```

`log/walk.rs`: `build` collects labels into `HashMap<Oid, Vec<RefLabel>>` (resolve HEAD's symbolic target once; `refs/tags/*` → `reference.peel_to_commit()`; skip on `Err`), sorts each label list with the key `(kind order Head < Branch < Remote < Tag, !is_head, name bytes)`, then runs the revwalk:

```rust
let mut walk = repo.revwalk()?;
walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
if repo.head().is_ok() { walk.push_head()?; }
for glob in ["refs/heads/*", "refs/remotes/*", "refs/tags/*"] { walk.push_glob(glob)?; }
let mut lanes = LaneLayout::new();
let mut rows = Vec::new();
for oid in walk {
    let oid = oid?;
    let commit = repo.find_commit(oid)?;
    let parents: Vec<Oid> = commit.parent_ids().collect();
    let (lane, edges) = lanes.next(oid, &parents);
    let author = commit.author();
    rows.push(CachedRow {
        oid, parents,
        subject: String::from_utf8_lossy(commit.summary_bytes().unwrap_or_default()).into_owned(),
        author_name: String::from_utf8_lossy(author.name_bytes()).into_owned(),
        author_email: String::from_utf8_lossy(author.email_bytes()).into_owned(),
        author_time: author.when().seconds(),
        lane, edges,
        refs: labels.remove(&oid).unwrap_or_default(),
    });
}
Ok(LogCache { generation, fingerprint, rows, max_lanes: lanes.max_columns() })
```

`log/search.rs`:

```rust
pub(crate) fn matches(repo: &Repository, row: &CachedRow, query: &str) -> bool {
    let hex_query = query.len() >= 4 && query.len() <= 40 && query.bytes().all(|b| b.is_ascii_hexdigit());
    if hex_query && row.oid.to_string().starts_with(query) { return true; }
    if row.author_name.to_lowercase().contains(query) || row.author_email.to_lowercase().contains(query) { return true; }
    if row.subject.to_lowercase().contains(query) { return true; }
    repo.find_commit(row.oid).ok()
        .map(|c| String::from_utf8_lossy(c.message_bytes()).to_lowercase().contains(query))
        .unwrap_or(false)
}
```

`log/mod.rs`:

```rust
impl RepoSession {
    pub fn log_summary(&mut self) -> Result<LogSummary, GitError> {
        let fp = cache::fingerprint(self.repo())?;
        let stale = self.log_cache.as_ref().is_none_or(|c| c.fingerprint != fp);
        if stale {
            let generation = self.log_cache.as_ref().map_or(1, |c| c.generation + 1);
            self.log_cache = Some(walk::build(self.repo(), generation, fp)?);
        }
        let c = self.log_cache.as_ref().expect("cache just built");
        Ok(LogSummary { generation: c.generation, total: c.rows.len() as u32, max_lanes: c.max_lanes })
    }
    fn cache(&self, generation: u64) -> Result<&LogCache, GitError> {
        self.log_cache.as_ref().filter(|c| c.generation == generation).ok_or(GitError::LogStale)
    }
    pub fn log_page(&self, generation: u64, start: u32, count: u32) -> Result<LogPage, GitError> {
        let c = self.cache(generation)?;
        let count = count.clamp(1, 1000) as usize;
        let rows = c.rows.iter().skip(start as usize).take(count).map(CachedRow::to_row).collect();
        Ok(LogPage { start, rows })
    }
    pub fn search_log(&self, generation: u64, query: &str) -> Result<Vec<u32>, GitError> {
        let c = self.cache(generation)?;
        let q = query.trim().to_lowercase();
        if q.is_empty() { return Ok(Vec::new()); }
        Ok(c.rows.iter().enumerate().filter(|(_, r)| search::matches(self.repo(), r, &q)).map(|(i, _)| i as u32).collect())
    }
    pub fn commit_detail(&self, oid: &str) -> Result<CommitDetail, GitError> {
        let commit = Oid::from_str(oid).ok().and_then(|o| self.repo().find_commit(o).ok())
            .ok_or_else(|| GitError::CommitNotFound(oid.to_owned()))?;
        let sig = |s: git2::Signature<'_>| Signature { name: lossy(s.name_bytes()), email: lossy(s.email_bytes()), time: s.when().seconds() };
        Ok(CommitDetail {
            oid: commit.id().to_string(),
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
            message: crate::commit::message::split(&String::from_utf8_lossy(commit.message_bytes())),
            author: sig(commit.author()), committer: sig(commit.committer()),
        })
    }
}
```

`model/log.rs` as in Interfaces; `GraphEdge` derives `PartialOrd, Ord` (field order `top`, `bottom`, so the derived order is `(top, bottom)` with `None` first).

- [ ] **Step 4: Run to verify pass** — `cargo test -p git-real-core` → green; `cargo clippy -p git-real-core -- -D warnings`; `cargo fmt --check`.

- [ ] **Step 5: Commit** — `git commit -m "feat(core): commit graph walk, lanes, cache, search and commit detail"` (test commit first per the TDD team workflow).

---

### Task 2: Core — `checkout_commit` and `reset_to_commit`

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/refs/switch.rs` (`SwitchTarget::Detach(&'a str)` → `git switch --detach <oid>`)
- Modify: `src-tauri/crates/git-real-core/src/log/mod.rs` (add the two methods)
- Test: `src-tauri/crates/git-real-core/tests/switch.rs` (extend), `src-tauri/crates/git-real-core/tests/log.rs` (extend with reset cases)

**Interfaces:**

- Consumes: `git_cli::locate`, `switch::run`, `RepoSession::path()`.
- Produces:

```rust
impl RepoSession {
    pub fn checkout_commit(&self, oid: &str) -> Result<(), GitError>;                 // CommitNotFound | GitCliMissing | CheckoutFailed
    pub fn reset_to_commit(&self, oid: &str, mode: ResetMode) -> Result<(), GitError>; // CommitNotFound | Git2
}
```

- [ ] **Step 1: Write the failing tests**

`tests/switch.rs`:

- `checkout_commit_detaches_head` (skips without git): two commits; `checkout_commit(&first_hex)` → `repo.head_detached() == true` and `head().target() == first`.
- `checkout_commit_with_conflicting_dirty_file_fails_with_git_stderr` (skips without git): dirty a file the target changes → `Err(CheckoutFailed { stderr, .. })` with `stderr` non-empty and HEAD unchanged.
- `checkout_commit_unknown_oid_needs_no_git`: `"0".repeat(40)` → `CommitNotFound`; `"zz"` → `CommitNotFound`.
- `checkout_commit_argv_is_detach_then_oid`: with `common::fake_git` recording argv, assert the recorded args end with `["switch", "--detach", <hex>]` (follow the existing argv test in `switch.rs`).

`tests/log.rs`:

- `reset_soft_keeps_index_and_worktree`: commit 1, commit 2 changing `a.txt`; `reset_to_commit(c1, Soft)` → `head().target() == c1`, index still holds c2's blob for `a.txt`, file content unchanged.
- `reset_mixed_unstages`: same setup → HEAD c1, index entry for `a.txt` equals c1's blob, file content still c2's.
- `reset_hard_restores_the_file`: → HEAD c1, file content c1's.
- `reset_unknown_oid`: → `CommitNotFound`.

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real-core --test switch --test log`.

- [ ] **Step 3: Implement**

```rust
// switch.rs
Detach(&'a str) => cmd.args(["--detach", oid]),

// log/mod.rs
pub fn checkout_commit(&self, oid: &str) -> Result<(), GitError> {
    let commit = self.find_commit_hex(oid)?;            // shared helper with commit_detail
    let git = git_cli::locate()?;
    switch::run(&git, self.path(), SwitchTarget::Detach(&commit.id().to_string()))
}
pub fn reset_to_commit(&self, oid: &str, mode: ResetMode) -> Result<(), GitError> {
    let commit = self.find_commit_hex(oid)?;
    let kind = match mode { ResetMode::Soft => ResetType::Soft, ResetMode::Mixed => ResetType::Mixed, ResetMode::Hard => ResetType::Hard };
    self.repo().reset(commit.as_object(), kind, None)?;
    Ok(())
}
```

- [ ] **Step 4: Run to verify pass** — `cargo test -p git-real-core`, clippy, fmt.

- [ ] **Step 5: Commit** — `feat(core): detached checkout and reset to a commit`.

---

### Task 3: Tauri app — error kinds, `log` commands, clipboard plugin

**Files:**

- Create: `src-tauri/src/commands/log.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`pub mod log;`; `with_session` closure type `FnOnce(&mut RepoSession) -> Result<T, GitError>` and call `f(&mut guard)`)
- Modify: `src-tauri/src/error.rs` (`AppErrorKind::{LogStale, CommitNotFound}` and the `From<GitError>` arms)
- Modify: `src-tauri/src/lib.rs` (plugin init, six commands registered)
- Modify: `src-tauri/Cargo.toml` (`tauri-plugin-clipboard-manager = "2"`), `src-tauri/capabilities/default.json` (`"clipboard-manager:allow-write-text"`)
- Test: `src-tauri/tests/log_commands.rs`, `src-tauri/tests/error_mapping.rs` or the existing error test file (extend with the two kinds)

**Interfaces:**

- Consumes: Task 1 and 2 methods, `run_blocking`, `with_session`, `RepoRegistry`.
- Produces (Tauri command names and argument keys — the front end mirrors them exactly):

```rust
get_log_summary(id)                                    -> LogSummary
get_log_page(id, generation: u64, start: u32, count: u32) -> LogPage
search_log(id, generation: u64, query: String)         -> Vec<u32>
get_commit(id, oid: String)                            -> CommitDetail
checkout_commit(id, oid: String)                       -> ()
reset_to_commit(id, oid: String, mode: ResetMode)      -> ()
// each with a pub fn <name>_inner(reg: &RepoRegistry, id: RepoId, ...) -> Result<_, AppError>
// AppErrorKind serializes as "logStale" | "commitNotFound"
```

- [ ] **Step 1: Write the failing tests** — `tests/log_commands.rs`: summary then page round trip on `temp_repo_with_commit` (one row, generation 1); `get_log_page_inner(reg, id, 99, 0, 10)` → kind `LogStale`; `search_log_inner` finds the subject; `get_commit_inner` returns the subject and an empty parents list; `reset_to_commit_inner(.., ResetMode::Mixed)` after a second commit moves HEAD back; unknown repo id → `UnknownRepo` for every command; `checkout_commit_inner` detaches HEAD when git is available; error mapping: `GitError::LogStale` → `"logStale"`, `CommitNotFound` → `"commitNotFound"` with the message text; `with_session` still works for an existing `&self` closure (`list_branches_inner` test already covers it).

- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real --test log_commands` (from `src-tauri`).

- [ ] **Step 3: Implement** — mirror `commands/refs.rs`: `_inner` functions using `with_session`, `#[tauri::command] async fn` wrappers with `run_blocking`. `with_session`:

```rust
pub fn with_session<T>(reg: &RepoRegistry, id: RepoId, f: impl FnOnce(&mut RepoSession) -> Result<T, GitError>) -> Result<T, AppError> {
    let session = reg.get(id).ok_or_else(|| AppError::unknown_repo(id))?;
    let mut guard = session.lock().unwrap_or_else(PoisonError::into_inner);
    f(&mut guard).map_err(AppError::from)
}
```

`lib.rs`: `.plugin(tauri_plugin_clipboard_manager::init())` after the dialog plugin; register `commands::log::{get_log_summary, get_log_page, search_log, get_commit, checkout_commit, reset_to_commit}`.

- [ ] **Step 4: Run to verify pass** — `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`.

- [ ] **Step 5: Commit** — `feat(app): commit graph commands and clipboard plugin`.

---

### Task 4: Front end foundations — IPC seam, keys, store, graph model, tokens, `SplitHandle` side, `ConfirmDialog` body, diff Close

**Files:**

- Modify: `src/lib/ipc/types.ts`, `errors.ts`, `commands.ts`, `index.ts`; Create: `src/lib/ipc/clipboard.ts`
- Modify: `src/lib/query/keys.ts`, `src/lib/store/workspace.ts`, `src/styles/tokens.css`
- Create: `src/features/graph/model/layout.ts`, `model/edges.ts`, `model/relativeTime.ts`, `model/pages.ts`
- Modify: `src/components/SplitHandle.tsx` (`side` prop), `src/components/ConfirmDialog.tsx` (`body?: ReactNode`, rendered in a `<div id={bodyId}>`)
- Modify: `src/features/diff/DiffToolbar.tsx` (`onClose(): void` → `Close diff` button), `src/features/diff/DetailPane.tsx` (close in every state, placeholder removed; `DetailPane` returns `null` when nothing is selected — `RepoPane` decides what to show)
- Modify: `src/test/mockVirtualizer.ts` (add `scrollToIndex: () => undefined` and `scrollElement: null` to the returned object)
- Modify: `package.json` (`@tauri-apps/plugin-clipboard-manager`), `eslint.config.*` only if the restricted-import pattern does not already cover `@tauri-apps/plugin-*`
- Test: `commands.test.ts`, `errors.test.ts`, `types.test.ts`, `clipboard.test.ts`, `keys.test.ts`, `workspace.test.ts`, `layout.test.ts` (graph model), `edges.test.ts`, `relativeTime.test.ts`, `pages.test.ts`, `SplitHandle.test.tsx`, `ConfirmDialog.test.tsx`, `DiffToolbar.test.tsx`, `DetailPane.test.tsx`

**Interfaces:**

- Produces:

```ts
// types.ts
export type RefKind = "head" | "branch" | "remote" | "tag";
export interface RefLabel { kind: RefKind; name: string; isHead: boolean }
export interface GraphEdge { top: number | null; bottom: number | null }
export interface GraphRow { oid: string; parents: string[]; subject: string; authorName: string; authorEmail: string; authorTime: number; lane: number; edges: GraphEdge[]; refs: RefLabel[] }
export interface LogSummary { generation: number; total: number; maxLanes: number }
export interface LogPage { start: number; rows: GraphRow[] }
export interface Signature { name: string; email: string; time: number }
export interface CommitDetail { oid: string; parents: string[]; message: CommitMessage; author: Signature; committer: Signature }
export type ResetMode = "soft" | "mixed" | "hard";
// AppErrorKind adds "logStale" | "commitNotFound"

// commands.ts
getLogSummary(id): Promise<LogSummary>                                         // invoke("get_log_summary", { id })
getLogPage(id, generation, start, count): Promise<LogPage>                     // { id, generation, start, count }
searchLog(id, generation, query): Promise<number[]>                            // { id, generation, query }
getCommit(id, oid): Promise<CommitDetail>                                      // { id, oid }
checkoutCommit(id, oid): Promise<void>                                         // { id, oid }
resetToCommit(id, oid, mode: ResetMode): Promise<void>                         // { id, oid, mode }
// clipboard.ts
copyText(text: string): Promise<void>                                          // writeText from @tauri-apps/plugin-clipboard-manager

// keys.ts
log: (id) => ["repo", id, "log"]
repoImmutable: (id) => ["repoImmutable", id]
logPage: (id, generation, page) => ["repoImmutable", id, "logPage", generation, page]
logSearch: (id, generation, query) => ["repoImmutable", id, "logSearch", generation, query]
commit: (id, oid) => ["repoImmutable", id, "commit", oid]

// workspace.ts
selectedCommit: Record<RepoId, string | null>; selectCommit(repoId, oid: string | null): void; clear(repoId) clears both maps

// features/graph/model/layout.ts
export const PAGE_SIZE = 500, ROW_HEIGHT = 28, LANE_WIDTH = 14, MAX_DRAWN_LANES = 12, MAX_LABELS = 3, SEARCH_DEBOUNCE_MS = 200;
export const shortOid = (oid: string) => oid.slice(0, 7);
// model/edges.ts
export const laneX = (col: number) => col * LANE_WIDTH + LANE_WIDTH / 2;
export function edgePath(edge: GraphEdge, lane: number): string;   // see Step 3
export const laneColour = (col: number) => `var(--graph-lane-${col % 8})`;
export const gutterWidth = (maxLanes: number) => Math.max(1, Math.min(maxLanes, MAX_DRAWN_LANES)) * LANE_WIDTH;
// model/relativeTime.ts
export function relativeTime(unixSeconds: number, now: number): string;   // now in ms (Date.now())
export function fullDate(unixSeconds: number): string;
// model/pages.ts
export function pagesFor(first: number, last: number): number[];           // inclusive indices; [] when last < first
export const pageOf = (index: number) => Math.floor(index / PAGE_SIZE);
export const pageStart = (page: number) => page * PAGE_SIZE;

// SplitHandle.tsx
side?: "before" | "after"   // default "before"; "after" inverts pointer dx and ArrowLeft/ArrowRight
// ConfirmDialog.tsx
body?: ReactNode
// DiffToolbar.tsx
onClose(): void
```

- [ ] **Step 1: Write the failing tests**

`edges.test.ts`:

```ts
it("laneX centres the column", () => {
  expect(laneX(0)).toBe(7);
  expect(laneX(2)).toBe(35);
});
it("draws a pass-through as a vertical line", () =>
  expect(edgePath({ top: 1, bottom: 1 }, 0)).toBe("M 21 0 V 28"));
it("draws a join in the dot's own column as a half line", () =>
  expect(edgePath({ top: 0, bottom: null }, 0)).toBe("M 7 0 V 14"));
it("draws a join from another column as a curve", () =>
  expect(edgePath({ top: 1, bottom: null }, 0)).toBe("M 21 0 C 21 7 7 7 7 14"));
it("draws a fork in the dot's own column as a half line", () => expect(edgePath({ top: null, bottom: 0 }, 0)).toBe("M 7 14 V 28"));
  expect(edgePath({ null: 0 } as never, 0)) /* { top: null, bottom: 0 } */
    .toBe("M 7 14 V 28"));
it("draws a fork to another column as a curve", () =>
  expect(edgePath({ top: null, bottom: 2 }, 0)).toBe("M 7 14 C 7 21 35 21 35 28"));
it("colours by column modulo 8", () => {
  expect(laneColour(9)).toBe("var(--graph-lane-1)");
});
it("gutter width is capped and at least one lane", () => {
  expect(gutterWidth(0)).toBe(14);
  expect(gutterWidth(40)).toBe(168);
});
```

`relativeTime.test.ts` (`now = Date.UTC(2026, 9, 19, 12, 0, 0)` and `t = (secondsAgo) => now / 1000 - secondsAgo`): 10 s → `"just now"`; 44 s → `"just now"`; 45 s → `"1 minute ago"`; 30 min → `"30 minutes ago"`; 44 min → `"44 minutes ago"`; 45 min → `"1 hour ago"`; 21 h → `"21 hours ago"`; 22 h → `"yesterday"`; 3 d → `"3 days ago"`; 25 d → `"25 days ago"`; 26 d → `"last month"`; 6 × 30 d → `"6 months ago"`; 11 × 30 d → `"last year"`; 3 × 365 d → `"3 years ago"`; a future time (`now / 1000 + 3600`) → `"just now"`; `fullDate(0)` equals `new Date(0).toLocaleString()`.

`pages.test.ts`: `pagesFor(0, 10)` → `[0]`; `pagesFor(499, 500)` → `[0, 1]`; `pagesFor(1200, 1700)` → `[2, 3]`; `pagesFor(5, 4)` → `[]`; `pageOf(500)` → 1; `pageStart(2)` → 1000.

`SplitHandle.test.tsx` (extend): with `side="after"`, pointer move +30 calls `onChange(value - 30)`; `ArrowRight` calls `onChange(value - step)`; `ArrowLeft` `value + step`; `Home`/`End` unchanged; default side keeps the existing behaviour.

`ConfirmDialog.test.tsx` (extend): a `body` given as an element renders inside the described-by node; string body still renders.

`DiffToolbar.test.tsx` (extend): a button `aria-label="Close diff"` calls `onClose`. `DetailPane.test.tsx`: the Close diff button appears in the loading, no-changes, error (as Dismiss already does), binary and no-line-changes states and calls `select(repoId, null)`; `DetailPane` renders nothing when no file is selected (the placeholder test is replaced).

`workspace.test.ts`: `selectCommit` sets per repo, `null` clears, `clear` removes both entries, other repos untouched. `keys.test.ts`: the five new keys and that `logPage`/`logSearch`/`commit` do **not** start with `queryKeys.repo(id)`. `commands.test.ts`: six invoke shapes. `errors.test.ts`: the two kinds. `clipboard.test.ts`: mocks `@tauri-apps/plugin-clipboard-manager` and asserts `writeText("abc")` is called. `tokens.css`: no test; `GraphRow` tests in Task 5 assert the inline `stroke` variable.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib src/components src/features/graph/model src/features/diff`.

- [ ] **Step 3: Implement**

`edges.ts`:

```ts
export function edgePath({ top, bottom }: GraphEdge, lane: number): string {
  const H = ROW_HEIGHT,
    mid = H / 2,
    xl = laneX(lane);
  if (top !== null && bottom !== null) return `M ${laneX(top)} 0 V ${H}`;
  if (top !== null) {
    const xk = laneX(top);
    return xk === xl
      ? `M ${xl} 0 V ${mid}`
      : `M ${xk} 0 C ${xk} ${mid / 2} ${xl} ${mid / 2} ${xl} ${mid}`;
  }
  const xk = laneX(bottom as number);
  return xk === xl
    ? `M ${xl} ${mid} V ${H}`
    : `M ${xl} ${mid} C ${xl} ${mid * 1.5} ${xk} ${mid * 1.5} ${xk} ${H}`;
}
```

`relativeTime.ts`:

```ts
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function relativeTime(unixSeconds: number, now: number): string {
  const s = now / 1000 - unixSeconds;
  if (s < 45) return "just now";
  const m = s / 60,
    h = m / 60,
    d = h / 24;
  if (m < 45) return rtf.format(-Math.max(1, Math.round(m)), "minute");
  if (h < 22) return rtf.format(-Math.max(1, Math.round(h)), "hour");
  if (d < 26) return rtf.format(-Math.max(1, Math.round(d)), "day");
  if (d < 11 * 30) return rtf.format(-Math.max(1, Math.round(d / 30)), "month");
  return rtf.format(-Math.max(1, Math.round(d / 365)), "year");
}
export const fullDate = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleString();
```

(`numeric: "auto"` gives "yesterday" for -1 day, "last month", "last year"; the tests above pin those strings.)

`SplitHandle.tsx`: `const sign = side === "after" ? -1 : 1;` applied to the pointer delta and to the arrow-key step. `ConfirmDialog.tsx`: `body?: ReactNode`, rendered as `<div id={bodyId} className={styles.body}>{body}</div>`. `DiffToolbar.tsx`: `<button type="button" aria-label="Close diff" onClick={onClose}>✕</button>` at the end. `DetailPane.tsx`: `if (file === null) return null;` and a `CloseDiff` button (`onClick={() => useWorkspace.getState().select(repoId, null)}`) inside each `Empty` container and passed to `DiffToolbar`. `tokens.css` light: `--graph-lane-0: #396cd8; -1: #1a7f37; -2: #9a6700; -3: #cf222e; -4: #8250df; -5: #0a7ea4; -6: #bf5b16; -7: #6e7781`; dark: `#4f8cff #3fb950 #d29922 #f85149 #d2a8ff #39c5cf #f0883e #8b949e`.

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(ui): graph foundations — IPC seam, keys, store, lane geometry, handle side, diff close`.

---

### Task 5: Front end — `src/features/graph/`

**Files:**

- Create: `useLogSummary.ts`, `useLogPages.ts`, `useLogSearch.ts`, `useCommitActions.ts`, `LaneGraph.tsx` + `.module.css`, `RefLabels.tsx` + `.module.css`, `GraphRow.tsx` + `.module.css`, `GraphToolbar.tsx` + `.module.css`, `GraphPanel.tsx` + `.module.css`
- Test: one `*.test.ts(x)` beside each

**Interfaces:**

- Consumes: Task 4 types, commands, keys, model; `useBranches`, `useBranchActions` (`features/branches`), `PromptDialog`, `ConfirmDialog`, `ContextMenu`, `RepoError`, `useWorkspace`.
- Produces:

```ts
export function useLogSummary(repoId): {
  summary: LogSummary | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
};
export function useLogPages(
  repoId,
  generation: number | undefined,
  first: number,
  last: number,
): { rowAt(index: number): GraphRow | undefined; error: AppError | null; refetch(): void };
export function useLogSearch(
  repoId,
  generation: number | undefined,
  query: string,
): { matches: number[]; isFetching: boolean };
export type CommitRequest =
  { action: "checkout"; oid: string } | { action: "reset"; oid: string; mode: ResetMode };
export function useCommitActions(repoId): {
  run(req: CommitRequest): Promise<AppError | null>;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
};
export function LaneGraph({ row, maxLanes }: { row: GraphRow; maxLanes: number }): JSX.Element; // <svg aria-hidden width height={ROW_HEIGHT}>
export function RefLabels({ refs }: { refs: RefLabel[] }): JSX.Element | null;
export function GraphRow({
  row,
  maxLanes,
  selected,
  matched,
  id,
  onSelect,
  onContextMenu,
}): JSX.Element; // role="option"
export function GraphToolbar({
  query,
  onQueryChange,
  matchCount,
  current,
  onPrevious,
  onNext,
}): JSX.Element;
export function GraphPanel({ repoId }: { repoId: RepoId }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

Hooks (`renderHookWithProviders`, IPC seam mocked with `vi.mock("../../lib/ipc", ...)`):

- `useLogSummary`: calls `getLogSummary(id)`, key `queryKeys.log(id)`, exposes data and `toAppError`-mapped error.
- `useLogPages`: `(id, 7, 0, 10)` fetches page 0 only (`getLogPage(id, 7, 0, 500)`); `(id, 7, 490, 510)` fetches pages 0 and 1; `rowAt(501)` returns row index 1 of page 1; `rowAt` outside loaded pages is `undefined`; `generation undefined` fetches nothing; query options have `staleTime: Infinity`; **`invalidates the summary once on logStale and does not retry`**: `getLogPage` rejects `{ kind: "logStale", message }` → `queryClient.invalidateQueries` called once with `queryKeys.log(id)`, `getLogPage` called once, `error` stays `null`.
- `useLogSearch`: disabled for `""` and whitespace; `searchLog(id, gen, "abc")` after the query changes; key `queryKeys.logSearch(id, gen, "abc")`; `matches` default `[]`.
- `useCommitActions`: `checkout` → `checkoutCommit(id, oid)`; `reset` → `resetToCommit(id, oid, "hard")`; `onSettled` invalidates `queryKeys.repo(id)`; `run` resolves with the AppError on failure and `error` mirrors it; `clearError`.

Components:

- `LaneGraph`: renders one `<path d>` per edge with `stroke` = `var(--graph-lane-<col>)` (col = top for pass/join, bottom for fork) and `<circle cx cy r>` at the dot with `fill` = the lane colour; width = `gutterWidth(maxLanes)`; `aria-hidden="true"`.
- `RefLabels`: nothing for `[]`; pills with class per kind; HEAD branch pill has the `head` class and `aria-current="true"`; four labels → three pills plus `+1` whose `title` is the fourth name; `title` of each pill is the full name.
- `GraphRow`: `role="option"`, `aria-selected`, `id`, subject text, author `title` is the email, date text from `relativeTime` and `title` from `fullDate`, `matched` class, click → `onSelect`, `contextmenu` → `onContextMenu(x, y)`.
- `GraphToolbar`: `type="search"` with `aria-label="Search commits"`; counter `2 of 5`; `No matches` when `matchCount === 0` and query non-empty; nothing when the query is empty; `Previous`/`Next` disabled with no matches; Enter → `onNext`, Shift+Enter → `onPrevious`; Escape → `onQueryChange("")`.
- `GraphPanel` (IPC mocked; `vi.mock("@tanstack/react-virtual", () => import("../../test/mockVirtualizer"))`; `useBranches` fed through the mocked `listBranches`):
  - `Loading history…` with `role="status"` while the summary is pending; `No commits yet` for `total: 0`.
  - rows from page 0 render in order with `aria-label="Commits"` listbox; `aria-activedescendant` unset until a selection.
  - a summary of `total: 600` requests pages 0 and 1 (the mock renders every row).
  - a row whose page has not resolved renders the `…` placeholder with `aria-busy`.
  - click selects (`useWorkspace.getState().selectedCommit[id] === oid`), `aria-selected`; `ArrowDown` from row 0 selects row 1 and calls `scrollToIndex(1)`; `Home`/`End`; Enter selects the active row.
  - **`reveals an off-screen selection through searchLog`**: `selectCommit(id, oidNotRendered)` with pages that do not contain it → `searchLog(id, gen, oid)` called once and `scrollToIndex(idx, { align: "center" })` called with its result; **`does not scroll for a rendered selection`**: selecting a rendered oid never calls `searchLog`.
  - search: typing `fix` waits `SEARCH_DEBOUNCE_MS` (fake timers) then calls `searchLog`; matches get the `matched` class; the first match is selected and revealed; `Next` cycles and wraps; `Previous` wraps backwards; counter text.
  - context menu via right-click: four items with the exact labels; `Checkout` title `Detaches HEAD at <7 hex>`; `Checkout` disabled on a row with a `head` label; selecting `Checkout` calls `checkoutCommit`; `Create branch here…` opens `PromptDialog` titled `New branch from <7 hex>` and confirming with `topic` + checkbox on calls `createBranch(id, "topic", <full oid>, true)`; `Reset to this commit…` opens the dialog titled `Reset to <7 hex>?` with `Mixed` checked, the line `Moves main to <7 hex>.`, choosing `Hard` turns the confirm `danger`, confirm calls `resetToCommit(id, oid, "hard")`; `Copy hash` calls `copyText(oid)`; Shift+F10 on the listbox opens the menu for the selected row.
  - a `checkoutFailed` rejection shows `RepoError` with the message and Dismiss clears it; a summary rejection shows `RepoError` with Retry calling `getLogSummary` again.
  - `aria-busy` on the panel while a mutation is pending; menu items disabled.
  - a new generation from a summary refetch (mock `getLogSummary` to resolve `{ generation: 2 }` on the second call, trigger `queryClient.invalidateQueries(queryKeys.log(id))`) requests `getLogPage(id, 2, 0, 500)` and keeps the selected oid.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/features/graph`.

- [ ] **Step 3: Implement**

`useLogPages.ts` (shape):

```ts
export function useLogPages(repoId, generation, first, last) {
  const queryClient = useQueryClient();
  const pages = generation === undefined ? [] : pagesFor(first, last);
  const results = useQueries({
    queries: pages.map((page) => ({
      queryKey: queryKeys.logPage(repoId, generation as number, page),
      queryFn: () =>
        getLogPage(repoId, generation as number, pageStart(page), PAGE_SIZE).catch((e) => {
          throw toAppError(e);
        }),
      staleTime: Infinity,
    })),
  });
  // one invalidation per stale generation; a ref remembers which generation was already handled
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (generation === undefined || handled.current === generation) return;
    if (results.some((r) => r.error?.kind === "logStale")) {
      handled.current = generation;
      void queryClient.invalidateQueries({ queryKey: queryKeys.log(repoId) });
    }
  }, [results, generation, repoId, queryClient]);
  const byPage = new Map(pages.map((p, i) => [p, results[i].data]));
  const rowAt = (index: number) =>
    byPage.get(pageOf(index))?.rows[index - pageStart(pageOf(index))];
  const firstError = results.find((r) => r.error && r.error.kind !== "logStale")?.error ?? null;
  return { rowAt, error: firstError, refetch: () => results.forEach((r) => void r.refetch()) };
}
```

`GraphPanel.tsx` responsibilities, in order: summary query; `useVirtualizer({ count: total, getScrollElement, estimateSize: () => ROW_HEIGHT, overscan: 20, getItemKey: (i) => i })`; `const items = virtualizer.getVirtualItems()`; pages for `items[0]?.index … items.at(-1)?.index`; selection from `useWorkspace`; reveal effect (`useEffect` on `[selected, generation]`: if `selected` and no rendered row has that oid → `queryClient.fetchQuery({ queryKey: queryKeys.logSearch(repoId, generation, selected), queryFn: () => searchLog(repoId, generation, selected), staleTime: Infinity })` then `scrollToIndex(idx, { align: "center" })`); search state (`input`, debounced `query` via `useEffect` + `setTimeout`, `useLogSearch`, `current` index into `matches`, reset to 0 when `matches` changes and reveal `matches[0]`); keyboard handler on the listbox (`ArrowUp/ArrowDown/Home/End/Enter`, `Shift+F10`/`ContextMenu`); menu state `{ x, y, row }`; dialog state `{ kind: "create", oid } | { kind: "reset", oid, mode }`; `useBranchActions` for create, `useCommitActions` for checkout/reset; `RepoError` for `actions.error`, `summary.error` and `pages.error`.

Row layout CSS: `.row { display: grid; grid-template-columns: var(--gutter) minmax(0, 1fr) 140px 90px; height: 28px; align-items: center; }`, subject with `text-overflow: ellipsis`, selected row `background: var(--color-surface-hover)` with an accent left border, matched row `background: var(--color-line-selected)`.

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(ui): commit graph panel with search and commit actions`.

---

### Task 6: Front end — `CommitSummary`, `RepoPane` rewiring

**Files:**

- Create: `src/features/history/useCommit.ts`, `src/features/history/CommitSummary.tsx` + `.module.css`
- Modify: `src/app/RepoPane.tsx`, `src/app/RepoPane.module.css` (`.detail` → `.center`), `src/app/layout.ts` (`DETAIL_MIN` → `CENTER_MIN`, same value; update the comment and the GR-7 tests' import)
- Test: `useCommit.test.tsx`, `CommitSummary.test.tsx`, `RepoPane.test.tsx` (extend), `layout.test.ts` (rename only)

**Interfaces:**

- Consumes: `getCommit`, `queryKeys.commit`, `copyText`, `useWorkspace`, `GraphPanel`, `DetailPane`, `SplitHandle` `side`.
- Produces:

```ts
export function useCommit(
  repoId,
  oid: string,
): {
  commit: CommitDetail | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
};
export function CommitSummary({ repoId, oid }: { repoId: RepoId; oid: string }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

- `useCommit`: key `queryKeys.commit(id, oid)`, `getCommit(id, oid)`, `staleTime: Infinity`.
- `CommitSummary`: `section` with `aria-label="Commit details"`; heading `Commit <7 hex>`; `<code>` with the full hash; `Copy` calls `copyText(oid)`; `Close` (`aria-label="Close commit details"`) calls `selectCommit(id, null)`; author line `Alice <alice@x.io> · <fullDate>`; committer line only when the committer differs; parent buttons labelled by 7 hex call `selectCommit(id, parent)`; subject in a `<strong>`/heading and body in an element with `white-space: pre-wrap` (assert the class); `Loading commit…` `role="status"`; error → `RepoError` with Retry refetching and Dismiss closing the panel.
- `RepoPane`: grid template `"<refs>px auto 1fr auto <sidebar>px"`; `GraphPanel` in the centre by default (assert `aria-label="Commits"`); after `select(id, file)` the centre shows the diff and the graph is unmounted; after `selectCommit(id, oid)` the sidebar shows `Commit details` and neither `ChangesPanel` nor `CommitBox` render; the second `SplitHandle` has `side="after"` (assert through the inverted ArrowRight behaviour on the `Resize changes column` separator); existing header and width tests still pass.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/features/history src/app`.

- [ ] **Step 3: Implement** — `RepoPane` body:

```tsx
<div ref={bodyRef} className={styles.body} style={{ gridTemplateColumns: `${refs}px auto 1fr auto ${sidebar}px` }}>
  <div key={`refs-${tab.id}`} className={styles.refs}><BranchesPanel repoId={tab.id} /></div>
  <SplitHandle label="Resize branches column" ... />
  <section aria-label="History" className={styles.center}>
    {selectedFile ? <DetailPane key={tab.id} repoId={tab.id} /> : <GraphPanel key={tab.id} repoId={tab.id} />}
  </section>
  <SplitHandle label="Resize changes column" side="after" ... />
  <div key={tab.id} className={styles.sidebar}>
    {selectedCommit ? <CommitSummary repoId={tab.id} oid={selectedCommit} /> : (<><ChangesPanel repoId={tab.id} /><CommitBox repoId={tab.id} /></>)}
  </div>
</div>
```

`selectedFile = useWorkspace((s) => s.selected[tab.id] ?? null)`, `selectedCommit = useWorkspace((s) => s.selectedCommit[tab.id] ?? null)`.

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`; then the full Rust gates once more.

- [ ] **Step 5: Commit** — `feat(ui): commit summary panel and graph-centred layout`.

---

## Execution: batched agent cycles

Per `feedback-token-cost-batching`: three cycles, each running the mandatory team workflow once (architect + tdd-tester in parallel → developer → tdd-tester-coverage + code-reviewer in parallel → fix loop), then one final architect sign-off.

| Cycle | Tasks | Deliverable                                                                |
| ----- | ----- | -------------------------------------------------------------------------- |
| 1     | 1–3   | Rust: core log module, checkout/reset, app commands, clipboard plugin      |
| 2     | 4     | Front-end foundations (seam, keys, store, geometry, handle, dialog, close) |
| 3     | 5–6   | Graph panel, commit summary, `RepoPane` rewiring                           |

Dispatch count: 3 × 5 = 15 plus the final architect = 16, plus any fix passes. Models: architect and developer on the opus agent definitions, tester, coverage and reviewer on sonnet, passed explicitly on each dispatch. Agents write their reports to the scratchpad, not the main context.

## After the last task

1. Full gates: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`, `npm test` (100 %), `npm run lint`, `npm run typecheck`.
2. Acceptance walk from spec section 6 in the running app (`npm run tauri dev`, driven through the WebKit remote inspector per the `tauri-webview-automation` memory).
3. Merge `feature/gr-8-commit-graph` into `main` with `--no-ff`; transition Jira GR-8 to Done with the walk results and follow-ups.
