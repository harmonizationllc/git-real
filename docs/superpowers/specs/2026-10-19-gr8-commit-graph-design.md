# GR-8 — Commit graph visualization

- Status: Draft (design approved in session 2026-10-19; spec awaiting review)
- Date: 2026-10-19
- Epic: GR-1 / Story: GR-8 "Commit graph visualization"
- Depends on: GR-3 (sessions, git CLI adapter, `RepoError`), GR-4 (watcher,
  `repo-changed`, `ContextMenu`, `ConfirmDialog`), GR-5 (`DiffViewer`,
  `@tanstack/react-virtual`), GR-6 (`commit::message::split`), GR-7
  (`create_branch(name, Some(oid))`, `refs::switch`, `PromptDialog`,
  `SplitHandle`, `layoutPrefs`, `useRepoChanged`)
- Follows: ADR 0001 (hybrid git backend), ADR 0002 (project structure:
  `log/` in core, `features/graph/` and `features/history/`, paged reads)

## 1. Goal

The centre of the repo pane shows the repository's history as a graph: one
row per commit with lane lines and merge curves, ref labels, subject, author
and relative date. It scrolls smoothly on 50k+ commits, can be searched, and
offers the commit-level actions that no later story owns. Clicking a commit
opens a summary panel in the right column that GR-9 will extend.

### Acceptance criteria (from Jira GR-8)

1. Graph renders commits with lanes for branches and merge lines.
2. Branch, tag and HEAD labels are shown next to their commits.
3. Each row shows subject, author and relative date.
4. Virtualized rendering so repositories with 50k+ commits scroll smoothly.
5. Click a commit to open its detail view — met by the commit summary panel
   (section 5.7); GR-9 adds the changed-files list, diffs, history and blame
   to the same panel.
6. Search commits by message, author or hash.
7. Context menu on a commit: checkout, create branch, reset, copy hash are
   delivered here; create tag (GR-11), cherry-pick and revert (GR-10) are
   deferred to the stories that own their conflict and tag handling.

### Out of scope

- Cherry-pick and revert (GR-10), tag creation and deletion (GR-11). Tag
  labels are still rendered because reading `refs/tags` is cheap.
- The changed-files list and per-file diff of a commit (GR-9).
- A "working changes" pseudo-row at the top of the graph.
- Colouring lines by branch identity; colours follow the lane column.
- Incremental cache updates after a commit (GR-16 may add them); a ref
  change rebuilds the whole cache.
- A filtered graph view: search highlights and jumps, it never hides rows.
- Blame, file history, interactive rebase, drag-to-merge.

## 2. Decisions

- **Walk once, cache in the session, page by index.** The lane layout of row
  n depends on every row before it, so the walk cannot be partial. Core
  walks the whole graph the first time the UI asks for it and keeps the rows
  in the `RepoSession`; the UI reads a summary (`generation`, `total`,
  `maxLanes`) and then fetches 500-row pages by index. The total is known
  up front, so the scrollbar is proportional from the first paint and search
  can jump to any row. Cost: about 250 bytes per row (≈25 MB at 100k
  commits) and a full rebuild whenever a ref tip changes. Rejected: cursor
  paging with a fresh walk per page (page 100 costs a full walk, no total,
  no random access) and shipping the whole graph in one payload (tens of MB
  of JSON across IPC, fails GR-16's 3-second first paint).
- **A ref fingerprint decides when to rebuild.** Every `repo-changed`
  refetches the summary; core compares a hash of all reference names and
  targets (plus HEAD) with the cached one and rebuilds only when it differs.
  File saves, staging and status refreshes therefore never pay for a walk.
- **Pages are immutable per generation.** `generation` is part of the page,
  search and commit query keys, and those keys sit outside the `repo(id)`
  invalidation prefix: a `repo-changed` never refetches a page, a new
  generation simply re-keys them and the old entries are garbage collected.
  A page request with an outdated generation is answered with `logStale`,
  which the UI treats as "the summary is about to change", not as an error
  to show.
- **Lane layout is a pure streaming function** (`log::lanes`) over
  `(oid, parents)` in walk order, unit-tested without git. Columns are fixed
  slots that are reused once freed, so lines are straight and a row's
  drawing depends only on its own `lane` and `edges`.
- **Checkout of a commit shells out to `git switch --detach`**, for the
  reasons GR-7 gave for branches: hooks, the dirty-tree guard and git's own
  stderr. **Reset uses git2** (`Repository::reset`): no hooks, no network,
  no credentials, the same category as the GR-4 index writes.
- **Search runs in core over the cache.** Hash prefix, author and subject
  match the cached strings; the message body is read from the object store
  only for rows nothing else matched, so the cache stays small and a search
  on 100k commits still finishes well under a second.
- **The graph and the diff share the centre; the changes panel and the
  commit summary share the sidebar.** Selecting a file shows the diff with a
  Close control that returns to the graph; selecting a commit shows the
  summary with a Close control that returns to the changes panel. The two
  selections are independent.
- **Column order becomes refs | centre | sidebar** (the layout the user is used to). The
  sidebar now sits to the right of its handle, so `SplitHandle` learns which
  side its column is on. Clamp maths and persisted widths are unchanged.
- **One new dependency: Tauri's clipboard-manager plugin.** "Copy hash" must
  work reliably in WebKitGTK; the web clipboard API is not dependable there.
  The plugin is wrapped in `src/lib/ipc/clipboard.ts` like the dialog
  plugin, and the capability grants only `clipboard-manager:allow-write-text`.
- **No `resetFailed` kind.** git2 reset errors are rare and carry no CLI
  output to preserve; they map to the existing `git` kind.

## 3. Rust domain: `git-real-core`

### 3.1 Modules

```
crates/git-real-core/src/
  model/
    log.rs           # GraphRow, GraphEdge, RefLabel, RefKind, LogSummary, LogPage,
                     #   CommitDetail, Signature, ResetMode
  log/
    mod.rs           # impl RepoSession { log_summary, log_page, search_log,
                     #   commit_detail, checkout_commit, reset_to_commit }
    cache.rs         # LogCache { generation, fingerprint, rows, max_lanes }, fingerprint(repo)
    walk.rs          # build(repo, generation) -> LogCache: labels, revwalk, lanes
    lanes.rs         # pure LaneLayout: next(oid, parents) -> (lane, edges), max_columns
    search.rs        # pure matching over rows, plus the lazy body read
  refs/
    switch.rs        # SwitchTarget gains Detach(&str)
  repo/
    session.rs       # RepoSession gains pub(crate) log_cache: Option<LogCache>
```

### 3.2 Types

```rust
// model/log.rs — all serde camelCase; oids serialize as full hex strings

#[serde(rename_all = "camelCase")]
pub enum RefKind { Head, Branch, Remote, Tag }

pub struct RefLabel {
    pub kind: RefKind,
    pub name: String,        // "HEAD" | "main" | "origin/main" | "v1.0"
    pub is_head: bool,       // true for the branch HEAD is on, and for the Head label
}

/// One line segment of a row, in lane columns. `None` means the row's dot.
pub struct GraphEdge {
    pub top: Option<u32>,    // column where the segment enters from the row above
    pub bottom: Option<u32>, // column where it leaves to the row below
}

pub struct GraphRow {
    pub oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,    // unix seconds
    pub lane: u32,
    pub edges: Vec<GraphEdge>,
    pub refs: Vec<RefLabel>,
}

pub struct LogSummary { pub generation: u64, pub total: u32, pub max_lanes: u32 }

pub struct LogPage { pub start: u32, pub rows: Vec<GraphRow> }

pub struct Signature { pub name: String, pub email: String, pub time: i64 }

pub struct CommitDetail {
    pub oid: String,
    pub parents: Vec<String>,
    pub message: CommitMessage,   // commit::message::split
    pub author: Signature,
    pub committer: Signature,
}

#[serde(rename_all = "camelCase")]
pub enum ResetMode { Soft, Mixed, Hard }
```

Internally `cache.rs` stores `git2::Oid` values and converts to hex when a
page is serialized; `GraphRow` is the wire type built per page.

### 3.3 Behaviour

- `fingerprint(repo) -> u64`: hashes, in sorted order, every reference's
  name and its direct target oid or symbolic target, plus HEAD's own target.
  Uses `std::hash::DefaultHasher`. No commit is loaded.
- `log_summary(&mut self) -> LogSummary`: if the cache is `None` or its
  fingerprint differs from the current one, `walk::build` replaces it with
  `generation + 1` (first generation is 1). Returns the cache's summary. An
  unborn HEAD with no other refs yields `total: 0, max_lanes: 0`.
- `walk::build`:
  - Labels: iterate `repo.references()`; `refs/heads/<n>` → `Branch`
    (`is_head` when HEAD is symbolic to it); `refs/remotes/<r>/<n>` →
    `Remote` named `<r>/<n>`, symbolic ones (`origin/HEAD`) skipped;
    `refs/tags/<n>` → `Tag`, peeled to a commit (tags of trees or blobs are
    skipped); a detached HEAD adds `Head { name: "HEAD", is_head: true }`.
    Names are decoded lossily. Labels are keyed by target oid and, per
    row, ordered Head, branches (HEAD's first, then byte order), remotes,
    tags.
  - Walk: `Revwalk` with `push_head()` when HEAD is born,
    `push_glob("refs/heads/*")`, `push_glob("refs/remotes/*")`,
    `push_glob("refs/tags/*")`; sorting `TOPOLOGICAL | TIME`. Each commit
    contributes oid, parent oids, `summary()` (lossy, empty when missing),
    author name, email and `when().seconds()`.
  - Lanes: `LaneLayout::next(oid, &parents)` per commit in walk order.
- `lanes.rs`: `LaneLayout { columns: Vec<Option<Oid>> }`.
  `next(c, parents) -> (lane, edges)`:
  1. `lane` = the first column expecting `c`; otherwise the first free
     column, or a new one appended. A column taken this way was not
     expecting `c`, so a tip commit gets no line above its dot.
  2. Every column `k` that was expecting `c` (which includes `lane` when it
     was) yields an edge `{ top: Some(k), bottom: None }` and is freed.
  3. Parents in order: the first parent takes column `lane`; each later
     parent takes the column already expecting it if any, else the first
     free column, else a new one. Each yields `{ top: None, bottom: Some(k) }`.
     A root commit yields no bottom edges.
  4. Every column `k` that held a value before the row, was not expecting
     `c`, and still holds one after step 3 yields
     `{ top: Some(k), bottom: Some(k) }`. A column that was expecting a later
     parent therefore yields both a pass-through and a join edge.
  5. Edges are sorted by `(top, bottom)` with `None` first, for
     deterministic tests. Trailing free columns are trimmed after each row.
     `max_columns` is the largest `columns.len()` seen before trimming.
- `log_page(&self, generation, start, count) -> LogPage`: `LogStale` when
  there is no cache or its generation differs; `count` clamped to
  `1..=1000`; `start >= total` gives an empty page.
- `search_log(&self, generation, query) -> Vec<u32>`: `LogStale` as above;
  the query is trimmed and lowercased; empty → empty. A row matches when
  the query is 4–40 hex characters and a prefix of the oid, or the lowercased
  author name or email contains it, or the lowercased subject contains it;
  otherwise the commit's full message is read (`find_commit`, lossy) and
  lowercased contains decides. Indices come back ascending.
- `commit_detail(&self, oid) -> CommitDetail`: `Oid::from_str` or
  `find_commit` failure → `CommitNotFound(oid)`; message via
  `commit::message::split`.
- `checkout_commit(&self, oid)`: `find_commit` → `CommitNotFound`;
  `git_cli::locate()?`; `switch::run(git, workdir, SwitchTarget::Detach(hex))`
  runs `git -C <workdir> switch --detach <full hex>`. Non-zero →
  `CheckoutFailed` as today. Only the validated full hex reaches the command
  line.
- `reset_to_commit(&self, oid, mode)`: `find_commit` → `CommitNotFound`;
  `repo.reset(commit.as_object(), ResetType::{Soft,Mixed,Hard}, None)`.
  git2 errors map to `Git2`.

### 3.4 Errors

`GitError` gains `LogStale` ("the commit graph changed; reload it") and
`CommitNotFound(String)` ("{0} is not a commit in this repository").

### 3.5 Tests (`crates/git-real-core/tests/` and unit tests in `lanes.rs`)

- `lanes.rs` unit tests with synthetic oids: linear history is one column;
  a branch and merge opens a second column on the merge row and closes it
  at the fork commit; two branches off one parent join at that parent; an
  octopus merge opens two columns; a freed column is reused by a later
  branch; a root commit has no bottom edges; `max_columns` counts the
  widest row; edge order is deterministic.
- `log.rs` (git2 fixtures): summary and page on a fresh repo (one row,
  `main` label with `is_head`); branch + merge fixture gives expected lanes,
  edges and parents; lightweight and annotated tag labels; remote labels
  after a fetch with `origin/HEAD` skipped; detached HEAD adds the `HEAD`
  label; unborn repo gives `total: 0`; generation unchanged after writing
  an untracked file, incremented after a commit and after a branch
  creation; page bounds (`start` past the end, `count` clamp); stale
  generation → `LogStale`; search by hash prefix, by author email, by
  subject, by body-only text, case-insensitive, empty query, no match;
  `commit_detail` with two parents and a committer that differs from the
  author; `reset_to_commit` soft keeps the index, mixed unstages, hard
  restores the file; unknown oid kinds.
- `switch.rs` (skips without `git`): `checkout_commit` detaches HEAD at the
  oid; a conflicting dirty file → `CheckoutFailed` with git's stderr and
  HEAD unchanged.

## 4. Tauri app layer (`src-tauri/src`)

- `commands/log.rs`: `get_log_summary(id) -> LogSummary`,
  `get_log_page(id, generation, start, count) -> LogPage`,
  `search_log(id, generation, query) -> Vec<u32>`,
  `get_commit(id, oid) -> CommitDetail`, `checkout_commit(id, oid)`,
  `reset_to_commit(id, oid, mode: ResetMode)`. Each has an `_inner` on
  `RepoRegistry` and a `run_blocking` wrapper, registered in `lib.rs`.
- `commands/mod.rs`: `with_session` lends `&mut RepoSession` so
  `log_summary` can replace the cache; existing closures keep compiling.
- `error.rs`: `AppErrorKind` gains `logStale` and `commitNotFound`.
- `lib.rs`: `.plugin(tauri_plugin_clipboard_manager::init())`;
  `capabilities/default.json` adds `clipboard-manager:allow-write-text`;
  `Cargo.toml` adds `tauri-plugin-clipboard-manager = "2"`.
- Tests in `src-tauri/tests/log_commands.rs`: summary then page round trip,
  stale kind, search, commit detail, reset, unknown repo id, both new kinds'
  mapping; `checkout_commit` when `git` is present.

## 5. Front end

### 5.1 IPC seam (`src/lib/ipc`)

- `types.ts`: `RefKind`, `RefLabel`, `GraphEdge`, `GraphRow`, `LogSummary`,
  `LogPage`, `Signature`, `CommitDetail`, `ResetMode`; `AppErrorKind` gains
  `logStale` and `commitNotFound`.
- `errors.ts`: the two kinds added to `KINDS`.
- `commands.ts`: `getLogSummary(id)`, `getLogPage(id, generation, start,
count)`, `searchLog(id, generation, query)`, `getCommit(id, oid)`,
  `checkoutCommit(id, oid)`, `resetToCommit(id, oid, mode)`.
- New `clipboard.ts`: `copyText(text): Promise<void>` over
  `@tauri-apps/plugin-clipboard-manager`'s `writeText`; re-exported from
  `index.ts`. The only module importing the plugin.

### 5.2 Query keys and stores

- `queryKeys`: `log(id)` = `["repo", id, "log"]` (summary, under the
  invalidation prefix). Immutable keys outside it:
  `logPage(id, generation, page)` = `["repoImmutable", id, "logPage",
generation, page]`, `logSearch(id, generation, query)` =
  `["repoImmutable", id, "logSearch", generation, query]`, `commit(id,
oid)` = `["repoImmutable", id, "commit", oid]`. Page and search queries
  use `staleTime: Infinity`; the client already sets `retry: false`.
- `workspace.ts` gains `selectedCommit: Record<RepoId, string | null>`,
  `selectCommit(repoId, oid | null)`; `clear(repoId)` clears both
  selections.
- Constants in `src/features/graph/model/layout.ts`: `PAGE_SIZE = 500`,
  `ROW_HEIGHT = 28`, `LANE_WIDTH = 14`, `MAX_DRAWN_LANES = 12`,
  `MAX_LABELS = 3`, `SEARCH_DEBOUNCE_MS = 200`.

### 5.3 Layout: `src/app`

- `RepoPane.tsx`: the body grid is refs | handle | centre (`1fr`) | handle |
  sidebar, template `${refs}px auto 1fr auto ${sidebar}px`. The centre
  renders `DetailPane` when `workspace.selected[tab.id]` is set, else
  `GraphPanel`. The sidebar renders `CommitSummary` when
  `workspace.selectedCommit[tab.id]` is set, else `ChangesPanel` +
  `CommitBox`. Keys per tab stay as they are.
- `layout.ts`: unchanged maths; `DETAIL_MIN` is renamed `CENTER_MIN` (still 320) and the clamp comment says the centre keeps its minimum.
- `SplitHandle.tsx`: new prop `side?: "before" | "after"` (default
  `"before"`): the column the handle resizes. With `"after"`, pointer dx and
  ArrowLeft/ArrowRight are inverted so dragging the handle right still
  moves it right. ARIA attributes unchanged.
- `DetailPane.tsx` / `DiffToolbar.tsx`: every state of the detail pane
  offers a `Close diff` button (`aria-label="Close diff"`) that calls
  `select(repoId, null)`; in the toolbar it sits at the right end, in the
  loading, no-changes, binary and empty-hunks states it sits in the empty
  container. The "Select a file to view its diff" placeholder is removed:
  the graph is what shows when nothing is selected.

### 5.4 Files in `src/features/graph/`

| File                    | Role                                                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model/layout.ts`       | the constants above                                                                                                                                                                                                                                                                      |
| `model/edges.ts`        | pure `laneX(col)`, `edgePath(edge, lane)` → SVG path strings, `laneColour(col)` → `--graph-lane-<col % 8>`                                                                                                                                                                               |
| `model/relativeTime.ts` | pure `relativeTime(unixSeconds, now)` via `Intl.RelativeTimeFormat("en", { numeric: "auto" })`; thresholds: < 45 s "just now", < 45 min minutes, < 22 h hours, < 26 d days, < 11 months months, else years; a future time reads "just now"; `fullDate(unixSeconds)` = `toLocaleString()` |
| `model/pages.ts`        | pure `pagesFor(first, last)` → page numbers overlapping an index range; `rowIndex(page, offset)`                                                                                                                                                                                         |
| `useLogSummary.ts`      | `useQuery` on `getLogSummary`; exposes `summary`, `isLoading`, `error`, `refetch`                                                                                                                                                                                                        |
| `useLogPages.ts`        | `useQueries` over `pagesFor(range)` keyed by generation; exposes `rowAt(index)` and `error`; a `logStale` error invalidates `queryKeys.log(repoId)` once                                                                                                                                 |
| `useLogSearch.ts`       | `useQuery` on `searchLog`, enabled when the query is non-empty; exposes `matches: number[]`, `isFetching`                                                                                                                                                                                |
| `useCommitActions.ts`   | one `useMutation` over `{ action: "checkout"; oid } \| { action: "reset"; oid; mode }`; `onSettled` invalidates `queryKeys.repo(repoId)`; exposes `run`, `pending`, `error`, `clearError` (same shape as `useBranchActions`)                                                             |
| `LaneGraph.tsx`         | the row's SVG: pass-through lines, join and fork curves, the dot; width `min(maxLanes, MAX_DRAWN_LANES) * LANE_WIDTH`, overflow clipped                                                                                                                                                  |
| `RefLabels.tsx`         | up to `MAX_LABELS` pills (HEAD, branch with a bold HEAD branch, remote, tag) and a `+n` pill whose `title` lists the rest                                                                                                                                                                |
| `GraphRow.tsx`          | `role="option"`: `LaneGraph`, `RefLabels`, subject (ellipsis), author name (`title` email), relative date (`title` full date); `aria-selected`; match highlight class                                                                                                                    |
| `GraphToolbar.tsx`      | search input, `n of m` / `No matches`, Previous and Next buttons                                                                                                                                                                                                                         |
| `GraphPanel.tsx`        | container: toolbar, virtualized `role="listbox"`, placeholder rows, selection and keyboard, reveal-on-select, context menu, create-branch prompt, reset dialog, `RepoError`                                                                                                              |
| `*.module.css`          | styles with the existing tokens; `tokens.css` gains `--graph-lane-0` … `--graph-lane-7` for light and dark                                                                                                                                                                               |

### 5.5 Behaviour

- **Rows and paging.** `useVirtualizer` with `count = summary.total`,
  `estimateSize: () => ROW_HEIGHT`, `overscan: 20`, `getItemKey` = index.
  The pages overlapping the virtual items' first and last index are
  fetched; rows without data render a placeholder row (`aria-busy`, muted
  "…"). While the summary loads the list shows `Loading history…` with
  `role="status"`; a repository with `total: 0` shows `No commits yet`.
- **Selection.** Click or Enter selects a row (`selectCommit`); right-click
  selects and opens the menu. The listbox is the focusable element
  (`tabIndex={0}`, `aria-activedescendant` = the selected row's id);
  ArrowUp/ArrowDown move the selection by one, Home/End to the first and
  last row, each followed by `scrollToIndex`. Whenever the selected commit
  changes and its row is not among the rendered rows, the panel resolves
  its index with `searchLog(full oid)` and scrolls to it centred; a visible
  row is never scrolled. This is also how the summary's parent links and
  future GR-9 links reach the graph.
- **Search.** The input (`type="search"`, `aria-label="Search commits"`,
  placeholder `Search commits`) is debounced by `SEARCH_DEBOUNCE_MS`.
  Matches are highlighted in place. The counter reads `<current> of <n>`;
  Next/Enter and Previous/Shift+Enter cycle through the matches, scrolling
  to and selecting each; the first result is revealed automatically. No
  match reads `No matches`. Escape clears the input. The search re-runs
  when the generation changes and keeps its position when the match count
  allows.
- **Context menu** (right-click, Shift+F10 or the ContextMenu key on the
  selected row):
  - `Checkout` — `title` "Detaches HEAD at <7 hex>"; disabled when the row
    carries a `head` label (HEAD is already detached there).
  - `Create branch here…` — `PromptDialog` title `New branch from <7 hex>`,
    label `Name`, checkbox `Switch to new branch` (default on), confirm
    `Create`; runs `useBranchActions.run({ action: "create", startPoint:
<full oid> })`; errors show inside the dialog.
  - `Reset to this commit…` — `ConfirmDialog` (its `body` becomes
    `ReactNode`) titled `Reset to <7 hex>?` with a radio group `Mode`:
    `Soft — keep the index and working tree`, `Mixed — keep the working
tree, unstage everything` (default), `Hard — discard index and working
tree changes`; a line `Moves <branch> to <7 hex>.` (the branch from
    `useBranches(repoId).branches.head`) or `Moves HEAD to <7 hex>.` when
    detached; confirm `Reset`, `danger` while Hard is chosen.
  - `Copy hash` — `copyText(oid)`.
    While `pending`: the panel is `aria-busy`, items disabled, dialog confirm
    disabled.
- **Errors.** `checkoutFailed` and `git` from a menu action, and a failed
  copy, show as `RepoError` at the top of the panel with Dismiss. Summary
  or page load failures show `RepoError` with Retry. `logStale` is never
  shown.
- **Refresh.** `repo-changed` refetches the summary; a new generation
  re-keys pages and search, the selection (by oid) survives, and the
  scroll offset is kept.

### 5.6 Commit summary: `src/features/history/`

| File                | Role                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `useCommit.ts`      | `useQuery` on `getCommit` keyed `queryKeys.commit`                                                                                                                                                                                                                                                                                         |
| `CommitSummary.tsx` | `<section aria-label="Commit details">`: header `Commit <7 hex>` with the full hash in `<code>`, `Copy` and `Close` buttons; author line `Name <email> · <full date>`; committer line only when name, email or time differ; `Parents` as buttons labelled by 7-hex that call `selectCommit`; subject in bold, body `white-space: pre-wrap` |
| `*.module.css`      | styles                                                                                                                                                                                                                                                                                                                                     |

Loading reads `Loading commit…` (`role="status"`); an error shows
`RepoError` with Retry and a Dismiss that closes the panel; `Close`
(`aria-label="Close commit details"`) calls `selectCommit(repoId, null)`.

### 5.7 Tests

- `edges.test.ts`: `laneX`, each edge shape's path string, colour token by
  column modulo 8.
- `relativeTime.test.ts`: every threshold boundary, future time, full date.
- `pages.test.ts`: page ranges at page boundaries and for an empty range.
- `useLogSummary`, `useLogPages`, `useLogSearch`, `useCommit`,
  `useCommitActions` tests: call shapes, keys, `staleTime`, stale handling,
  `onSettled` invalidation.
- `LaneGraph.test.tsx`, `RefLabels.test.tsx`, `GraphRow.test.tsx`,
  `GraphToolbar.test.tsx`: rendering, overflow pill, selection and match
  classes, counter copy, button states.
- `GraphPanel.test.tsx` (IPC seam mocked, virtualizer measured through a
  stubbed scroll element): loading and empty states, rows from page 0,
  a scroll near the end fetches page 1, placeholder rows, click and Enter
  select, arrow and Home/End navigation, reveal of an off-screen selection
  through `searchLog`, search debounce, counter, Next/Previous cycling,
  Escape clears, context menu items and their titles, create-branch call
  shape with the oid, reset dialog modes and danger, copy hash, panel
  error display, generation change re-keys pages.
- `CommitSummary.test.tsx`: header, author and committer lines, parent
  links select the parent, copy, close, loading and error.
- `RepoPane.test.tsx`: five-track grid, graph in the centre by default,
  diff when a file is selected, summary in the sidebar when a commit is
  selected, both handles with the right `side`.
- `SplitHandle.test.tsx`: `side="after"` inverts drag and arrow keys.
- `DetailPane.test.tsx`, `DiffToolbar.test.tsx`: Close diff in every state.
- `workspace.test.ts`: commit selection and `clear`.
- `keys.test.ts`, `errors.test.ts`, `commands.test.ts`, `types.test.ts`:
  the new keys, kinds and wrappers; `clipboard.test.ts`.

## 6. Definition of Done

1. `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`,
   `cargo fmt --check`, `npm test` (100 % coverage), `npm run lint`,
   `npm run typecheck` green.
2. Architect sign-off on the final branch.
3. Acceptance walk in the running app on a fixture repository with a
   feature branch merged into `main`, an annotated tag and a local bare
   remote: the graph shows two lanes with the merge curve, `main`, `HEAD`
   branch styling, `origin/main` and the tag label on the right rows;
   author and relative dates read correctly; clicking a row opens the
   summary and its parent link jumps the graph; searching an author, a
   subject word and a 7-hex prefix highlights and cycles matches; Checkout
   detaches HEAD and the header reads `detached at …`; Create branch here
   with switch on changes the header; Reset mixed to the previous commit
   unstages the last commit's files; Copy hash pastes in a terminal;
   selecting a changed file swaps the centre to the diff and Close diff
   returns to the graph; a commit made from the commit box appears as a new
   top row without the scroll jumping; a repository with 50k generated
   commits scrolls smoothly and its first paint is under 3 s.
4. Jira GR-8 transitions to Done with the walk results and any decisions
   worth revisiting in a comment.
