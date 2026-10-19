# GR-9 — Commit detail, file history and blame

- Status: Approved in session 2026-10-19 (design agreed in chat; the user asked
  for spec, plan and implementation in one go)
- Date: 2026-10-19
- Epic: GR-1 / Story: GR-9 "Commit detail, file history, and blame"
- Depends on: GR-5 (`DiffViewer`, `useHighlight`, `LineContent`, `DetailPane`,
  `DiffToolbar`), GR-7 (`SplitHandle`, `layoutPrefs`, `PromptDialog` pattern),
  GR-8 (`log` cache and `generation`, `CommitSummary`, `useCommitDetail`,
  `selectCommit`, `GraphRow` styling, `relativeTime`, `shortOid`)
- Follows: ADR 0001 (hybrid git backend: blame and history are git2 reads),
  ADR 0002 (`features/history/` owns commit detail, file history and blame)

## 1. Goal

The user can inspect one commit (its files and each file's diff), open the
history of any file in a split layout (a file picker on Ctrl+Shift+H, the
file's commits on the left, the diff on the right) and read a blame of any
file at any commit, with every line linking back to its commit. Everything
renders in place inside the repo pane; no second window.

### Acceptance criteria (from Jira GR-9)

1. Commit detail panel shows full message, author, committer, date, hash and
   parent links — already met by GR-8's `CommitSummary`; this story keeps it
   and adds the files section.
2. Changed-files list with a per-file diff in the diff viewer.
3. File history view listing every commit that touched a file.
4. Blame view showing author, date and commit for each line, each linking to
   the commit.

### Out of scope

- A separate window for file history (decided: in place).
- Per-file line counts in the commit's file list.
- Blame of uncommitted working-tree text; blame always reads a committed
  revision (HEAD for working-tree scopes).
- "Blame at parent" navigation, blame ignore-revs files, `--follow` across
  copies (renames are followed, copies are not).
- Cherry-pick/revert (GR-10), tags (GR-11), file history inside the graph.

## 2. Decisions

- **Commit diffs reuse the diff pipeline through a new scope.** `DiffScope`
  gains `Commit(oid)`; `file_diff` and `file_content` serve a commit's file
  against its first parent (empty tree for a root commit) with the same
  hunks, encoding handling, truncation and image previews as the working
  tree. The viewer is read-only in that scope. Rejected: a parallel
  `commit_file_diff` function and a second `FileDiff`-like type, which would
  duplicate the decoding and the front-end states.
- **File history is computed over the GR-8 log cache**, like search: no
  second walk, graph order for free, and `generation` keys the result as
  immutable. A commit "touches" a file when the blob at the followed path
  differs between the commit and its first parent. Renames are followed: when
  the path first appears, a rename-detecting diff against the parent switches
  the followed path. A merge where the file equals the first parent is
  skipped. Rejected: `git log --follow` through the CLI (ADR 0001 keeps
  reads in git2) and a per-request revwalk (no order guarantee relative to
  the graph, repeated cost).
- **Blame uses git2 `blame_file`** per CLAUDE.md. Known risk: libgit2 blame
  is slower than `git blame` on files with long histories and it runs under
  the session mutex. The result is bounded (4 MiB blob cap, binary refused)
  and cached as immutable per `(path, oid)`. Follow-up, not in scope: a
  `git blame --porcelain` fallback behind an ADR, and taking the blame
  outside the session lock.
- **The repo pane keeps its three columns.** History mode swaps the left
  column (branches → the file's commits); the centre stays "selected file,
  else graph" and gains a Diff/Blame toggle; the sidebar stays "selected
  commit, else changes". No new column maths.
- **The file picker lists HEAD's tree on open** and is not cached: it costs
  one tree walk per open and never goes stale.
- **One new error kind, `binaryFile`**, for blame of a binary blob. Oversize
  blobs reuse `tooLarge`; a path missing from the revision reuses
  `pathNotFound`; an unborn HEAD reuses `unbornHead`.

## 3. Rust domain: `git-real-core`

### 3.1 Modules

```
crates/git-real-core/src/
  model/
    diff.rs          # DiffScope gains Commit(String); Copy derive dropped
    history.rs       # CommitFile, FileHistoryEntry, Blame, BlameHunk
  diff/mod.rs        # scoped_diff handles Commit; load_diff unchanged otherwise
  content.rs         # file_content handles (Commit, Old|New); head_blob → tree_blob
  history/
    mod.rs           # impl RepoSession { commit_files, file_history, blame, tracked_files }
    follow.rs        # pure-ish helpers: entry lookup memo, rename lookup
  log/mod.rs         # pub(crate) fn log_cache(generation) reused by file_history
  error.rs           # GitError::BinaryFile(String)
```

### 3.2 Types

```rust
// model/diff.rs
#[serde(rename_all = "camelCase")]
pub enum DiffScope {
    Staged,
    Unstaged,
    /// A commit against its first parent; the full hex oid.
    Commit(String),          // serializes as {"commit": "<hex>"}
}

// model/history.rs — all serde camelCase, Serialize

/// One path changed by a commit (first parent → commit).
pub struct CommitFile {
    pub path: String,
    pub old_path: Option<String>,   // renames
    pub change: ChangeKind,         // Added | Modified | Deleted | Renamed | TypeChange
}

/// One commit that touched a followed file.
pub struct FileHistoryEntry {
    pub oid: String,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub change: ChangeKind,         // Added | Modified | Deleted | Renamed
    /// The file's path in this commit.
    pub path: String,
    /// For `Renamed`: the path in the first parent, which the walk follows next.
    pub old_path: Option<String>,
}

/// A run of consecutive lines last changed by one commit.
pub struct BlameHunk {
    /// 1-based first line in the blamed revision.
    pub start: u32,
    pub lines: u32,
    pub oid: String,
    pub author: Signature,
    pub summary: String,
}

pub struct Blame {
    /// The commit the file was blamed at (HEAD resolved to its oid).
    pub oid: String,
    pub path: String,
    /// Cover every line of `lines` exactly once, in order.
    pub hunks: Vec<BlameHunk>,
    /// The file's lines at `oid`, lossy UTF-8, without line endings.
    pub lines: Vec<String>,
}
```

Constants: `BLAME_MAX_BYTES = 4 * 1024 * 1024`.

### 3.3 Behaviour

- **`scoped_diff` for `Commit(oid)`**: `Oid::from_str` or `find_commit`
  failure → `CommitNotFound`; old tree = first parent's tree, or `None` for
  a root; `diff_tree_to_tree(old, Some(&new), opts)` over the whole commit
  with `find_similar(renames)`, as the staged scope does. Everything after
  that (delta lookup by new path, hunks, decoding, `NoChanges`) is shared
  and unchanged. `FileDiff.scope` echoes the scope.
- **`file_content`**: `(Commit(oid), Old)` reads the blob from the first
  parent's tree (`PathNotFound` for a root or an added file), `(Commit(oid),
New)` from the commit's tree. `head_blob` becomes `tree_blob(tree, rel,
max_bytes)`, with the HEAD lookup kept for the staged scope.
- **`commit_files(oid) -> Vec<CommitFile>`**: the same tree-to-tree diff
  with rename detection, no pathspec; one `CommitFile` per delta mapped by
  the existing `change_kind` (`Unmodified` etc. skipped). Order is libgit2's
  path order. A root commit lists every path as `Added`.
- **`file_history(generation, path) -> Vec<FileHistoryEntry>`**: `LogStale`
  as `search_log`. Walk the cached rows in order with `followed = path`:
  - `entry(tree, followed) -> Option<Oid>` memoised per tree oid in a
    `HashMap` (a parent's tree is revisited when the parent's row comes up).
  - Commit entry vs first-parent entry (a root has none):
    - both present and equal → skip;
    - both present, different → `Modified`;
    - present, parent absent → run `diff_tree_to_tree(parent, commit)` with
      `find_similar(renames)`: a `Renamed` delta whose new path is `followed`
      yields `Renamed` with `old_path` and the walk continues with
      `followed = old_path`; otherwise `Added`;
    - absent, parent present → `Deleted`;
    - both absent → skip.
  - Each entry copies oid, subject, author fields and time from the cached
    row; `path` is `followed` as it was when the row was examined.
- **`blame(path, oid: Option<&str>) -> Blame`**: resolve the commit
  (`CommitNotFound` on a bad oid; HEAD via `repo.head()`, `UnbornHead` when
  unborn); `tree.get_path(path)` → `PathNotFound`; a non-blob entry →
  `PathNotFound`; ODB header size above `BLAME_MAX_BYTES` → `TooLarge`;
  `blob.is_binary()` → `BinaryFile(path)`. `BlameOptions::newest_commit(oid)`,
  `repo.blame_file(Path::new(path), Some(&mut opts))`; each git2 hunk maps
  to `BlameHunk { start: final_start_line, lines: lines_in_hunk, oid:
final_commit_id, author: final_signature, summary: find_commit(...).summary()
lossy, empty when missing }`. Lines: lossy UTF-8, split on `\n`, one
  trailing empty element dropped, a trailing `\r` stripped per line. The
  hunks' line counts sum to `lines.len()`.
- **`tracked_files() -> Vec<String>`**: HEAD tree walked pre-order; blob
  entries only (trees descended, gitlinks skipped); lossy, `/`-joined
  paths; sorted. Unborn HEAD → empty.

### 3.4 Errors

`GitError::BinaryFile(String)` ("{0} is a binary file"). `DiffScope` loses
`Copy`; callers that passed it by value now clone or borrow.

### 3.5 Tests (`crates/git-real-core/tests/`)

- `diff.rs` / `content.rs` additions: commit scope on a root commit (old
  side absent, every hunk an addition), on a child commit, on a merge (first
  parent), a rename inside a commit (`old_path`), `CommitNotFound`,
  `NoChanges` for a path the commit did not touch; `file_content` old and
  new sides for a commit, `PathNotFound` for the old side of an added file.
- `history.rs` (new): `commit_files` on root, modify, delete, rename and
  merge commits; `file_history` on a linear history (added then modified),
  across a rename (three entries, `Renamed` carries `old_path`, older entry
  uses the old path), deleted then re-added, a merge equal to its first
  parent is skipped, a merge that changed the file is listed, a path never
  committed → empty, stale generation → `LogStale`, order matches the graph;
  `blame` on a two-commit file (two hunks with the right authors, starts and
  counts, lines match the blob), at an older commit, at HEAD by default,
  CRLF lines stripped, missing path, binary blob, oversize blob, bad oid,
  unborn HEAD; `tracked_files` sorted, nested, excludes a submodule gitlink,
  unborn → empty.

## 4. Tauri app layer (`src-tauri/src`)

- `commands/history.rs`: `list_tracked_files(id) -> Vec<String>`,
  `get_commit_files(id, oid) -> Vec<CommitFile>`, `get_file_history(id,
generation, path) -> Vec<FileHistoryEntry>`, `get_blame(id, path, oid:
Option<String>) -> Blame`. Each has an `_inner` on `RepoRegistry` and a
  `run_blocking` wrapper, registered in `lib.rs`.
- `get_file_diff` and `get_file_content` keep their signatures; `scope` now
  deserializes the tagged commit form.
- `error.rs`: `AppErrorKind::BinaryFile` ↔ `GitError::BinaryFile`.
- Tests in `src-tauri/tests/history_commands.rs`: each command round trip
  on a fixture, the diff command with a commit scope payload
  (`{"commit": "<hex>"}`), `binaryFile` mapping, unknown repo id.

## 5. Front end

### 5.1 IPC seam (`src/lib/ipc`)

- `types.ts`: `DiffScope = "staged" | "unstaged" | { commit: string }`;
  `CommitFile`, `FileHistoryEntry`, `BlameHunk`, `Blame`; `AppErrorKind`
  gains `binaryFile`.
- `errors.ts`: `binaryFile` in `KINDS`.
- `commands.ts`: `listTrackedFiles(id)`, `getCommitFiles(id, oid)`,
  `getFileHistory(id, generation, path)`, `getBlame(id, path, oid | null)`.

### 5.2 Scope helpers, keys and store

- `src/features/diff/model/scope.ts` (pure): `scopeId(scope)` →
  `"staged" | "unstaged" | "commit:<oid>"` for keys and React keys;
  `commitOf(scope)` → the oid or `null`; `isReadOnly(scope)` → true for a
  commit scope.
- `queryKeys`: `fileDiff` and `fileContent` take the scope as-is (TanStack
  hashes objects deterministically). New immutable keys: `commitFiles(id,
oid)`, `fileHistory(id, generation, path)`, `blameAt(id, path, oid)`; under
  the repo prefix: `blameHead(id, path)` = `["repo", id, "blame", path]`,
  `trackedFiles(id)` = `["repo", id, "trackedFiles"]`.
- `workspace.ts` gains `historyPath: Record<RepoId, string | null>` with
  `showHistory(repoId, path | null)`, and `centreView: Record<RepoId, "diff"
| "blame">` with `setCentreView(repoId, view)`; `clear(repoId)` forgets
  both. `select` leaves `centreView` alone, so the Blame toggle persists
  across files until the user switches it back.

### 5.3 Diff feature changes (`src/features/diff/`)

- `FileHeader.tsx` (new): the row that tops every state of the centre file
  view: the path (`old → new` for renames, from the selection or the diff),
  a radio group `aria-label="View"` with `Diff` and `Blame`, a `History`
  button (`aria-label="Show file history"`) calling `showHistory(repoId,
path)`, and the existing `CloseDiffButton`. `DiffToolbar` drops its own
  path and close controls and keeps counts, mode, whitespace and notices.
- `DetailPane.tsx`: `FileDetail` is keyed by `scopeId(scope) + path`. It
  renders `FileHeader` first in every state. When `centreView` is `blame` it
  renders `BlameView` for `(path, commitOf(scope))` and skips the diff
  query (`useFileDiff` is given `null`). For a commit scope the diff is
  read-only: no `selection`, no `onHunkAction`, no discard dialog;
  `actionsDisabledReason` is unused because no actions render. The
  `No <scope> changes in <path>` copy becomes `No changes in <path>` when the
  scope is a commit.
- `HunkHeader`: `Actions` renders only for `staged` and `unstaged` scopes.
- `model/highlight.ts`: `tokenize` is already text-based; add
  `highlightText(lines: string[], parser) -> (Token[] | null)[]` and a hook
  `useTextHighlight(path, lines | undefined)` beside `useHighlight`, with
  the same `HIGHLIGHT_LIMIT` on `lines.length`.

### 5.4 History feature files (`src/features/history/`)

| File                   | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model/fuzzy.ts`       | pure `fuzzyMatch(query, path) -> number \| null`: case-insensitive subsequence; score = matched span length, minus 1000 when the whole query is a substring of the basename; `rankFiles(query, paths, limit)` → best `limit` paths by score then path; an empty query returns the first `limit` paths                                                                                                                                                                                                                                                                                           |
| `model/blameRows.ts`   | pure `blameRows(blame)` → one row per line `{ index, hunk, firstOfHunk }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `useCommitFiles.ts`    | `useQuery` on `getCommitFiles`, `staleTime: Infinity`; exposes `files`, `isLoading`, `error`, `refetch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `useFileHistory.ts`    | `useQuery` on `getFileHistory(generation, path)` enabled when the generation is known, `staleTime: Infinity`; a `logStale` error invalidates `queryKeys.log(repoId)` once (same rule as `useLogPages`)                                                                                                                                                                                                                                                                                                                                                                                          |
| `useBlame.ts`          | `useQuery` on `getBlame(path, oid)`; key `blameAt` with `staleTime: Infinity` when `oid` is set, else `blameHead`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `useTrackedFiles.ts`   | `useQuery` on `listTrackedFiles`, `enabled: open`, `gcTime: 0`, `staleTime: 0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CommitFiles.tsx`      | `<section aria-label="Changed files">` with heading `Files (n)` and a `ul`; each `li` is a button row: `StatusBadge` + path (`old → new` for renames), `aria-current="true"` when it is the selected file with this commit's scope; click → `select(repoId, { path, scope: { commit: oid } })`; right-click menu: `File history` → `showHistory`, `Blame at this commit` → select + `setCentreView("blame")`. `Loading files…` (`role="status"`), `RepoError` with Retry on failure                                                                                                             |
| `CommitSummary.tsx`    | renders `CommitFiles` after the message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `HistoryRow.tsx`       | `role="option"`: `StatusBadge`, subject (ellipsis), author (`title` email), relative date (`title` full date); `aria-selected`; renamed rows show `old → new` under the subject in the muted style                                                                                                                                                                                                                                                                                                                                                                                              |
| `FileHistoryPanel.tsx` | the left column in history mode: header `History` with the path (ellipsis, `title` full path) and `Close` (`aria-label="Close file history"`); virtualized `role="listbox" aria-label="File history"` of `HistoryRow`; `Loading history…`, `No commits touch this file`, `RepoError` with Retry. Selecting a row (click, Enter, ArrowUp/Down, Home/End) calls `selectCommit(oid)` and `select({ path: entry.path, scope: { commit: oid } })`. On first load, when the selected commit is not in the list, the first entry is selected. Escape closes the panel                                  |
| `BlameView.tsx`        | `<div role="table" aria-label="Blame">` virtualized over `blameRows` (`estimateSize` 22, overscan 20): per row a hash button (`shortOid`, `title` `<full oid> <summary>`, `aria-label="Open commit <7 hex>"`, calls `selectCommit`), author and relative date shown only on the first line of a hunk, the 1-based line number, `LineContent` with tokens from `useTextHighlight`. Hunks alternate a subtle background; rows whose hunk oid equals the selected commit get `data-current`. `Loading blame…`; errors show `RepoError` with Retry and a Dismiss that calls `setCentreView("diff")` |
| `FilePickerDialog.tsx` | modal in the `PromptDialog` pattern: title `File history`, `<input type="search" aria-label="Find file" placeholder="Type a file name">`, a `role="listbox" aria-label="Files"` of up to `MAX_PICKER_ROWS = 200` `rankFiles` results with `aria-activedescendant`; ArrowUp/Down move, Enter and click pick, Escape cancels; `Loading files…`, `No matching files`, `RepoError`. `onPick(path)` → `showHistory(repoId, path)`                                                                                                                                                                    |
| `*.module.css`         | styles with the existing tokens; the history row reuses the graph row's column widths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 5.5 Wiring

- `RepoPane.tsx`: the refs column renders `FileHistoryPanel` when
  `historyPath[tab.id]` is set, else `BranchesPanel`; the handle label stays
  `Resize branches column`. A `keydown` listener on `window` opens the
  picker on Ctrl+Shift+H (Meta+Shift+H too) unless a dialog is open; the
  picker is rendered by `RepoPane` for the active tab.
- `ChangesPanel.tsx`: every file's context menu gains `File history`
  (`showHistory(repoId, row.entry.path)`), never disabled by `pending`.
- `useRepoChanged` needs no change: HEAD blame and tracked files sit under
  the repo prefix; everything else is immutable.

### 5.6 Copy (verbatim)

`Files (n)`, `Loading files…`, `File history`, `Blame at this commit`,
`History`, `Close` (`aria-label="Close file history"`), `Loading history…`,
`No commits touch this file`, `Diff`, `Blame`, `Show file history`,
`Loading blame…`, `Find file`, `Type a file name`, `No matching files`,
`Open commit <7 hex>`, `No changes in <path>`.

### 5.7 Tests

- `scope.test.ts`, `fuzzy.test.ts`, `blameRows.test.ts`: pure functions,
  every branch.
- `useCommitFiles`, `useFileHistory` (stale → one invalidation, no retry),
  `useBlame` (key choice by oid), `useTrackedFiles` (enabled, gcTime):
  call shapes and keys.
- `CommitFiles.test.tsx`: rows, badge, rename display, click selects with the
  commit scope, `aria-current`, context menu items and their effects,
  loading, error and retry.
- `HistoryRow.test.tsx`, `FileHistoryPanel.test.tsx` (virtualizer measured
  through a stubbed scroll element as `GraphPanel.test.tsx` does): states,
  first-entry auto-select, selection by click and keys, Escape and Close,
  stale handling.
- `BlameView.test.tsx`: hunk grouping, first-line metadata, hash button
  selects the commit, current hunk marking, highlight tokens, loading, error
  with Dismiss returning to the diff.
- `FilePickerDialog.test.tsx`: filter, ranking, keyboard, pick, cancel, cap,
  states.
- `FileHeader.test.tsx`, `DiffToolbar.test.tsx`, `DetailPane.test.tsx`:
  View toggle, History button, commit scope read-only (no hunk buttons, no
  discard dialog), blame branch, copy variants; `HunkHeader.test.tsx`: no
  actions for a commit scope.
- `useTextHighlight.test.tsx`, `highlight.test.ts`: `highlightText`.
- `RepoPane.test.tsx`: history panel swap, shortcut opens the picker, pick
  enters history mode. `ChangesPanel.test.tsx`: the new menu item.
- `workspace.test.ts`, `keys.test.ts`, `types.test.ts`, `errors.test.ts`,
  `commands.test.ts`: the new state, keys, kind and wrappers.

## 6. Definition of Done

1. `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`,
   `cargo fmt --check`, `npm test` (100 % coverage), `npm run lint`,
   `npm run typecheck` green.
2. Architect sign-off on the final branch.
3. Acceptance walk in the running app on a fixture repository with a file
   that was added, modified, renamed and modified again, plus a merge and a
   binary file: selecting a commit lists its files; clicking one shows its
   diff against the parent with no stage/discard controls and a Close that
   returns to the graph; the image diff works for a committed PNG;
   Ctrl+Shift+H opens the picker, typing part of a name ranks the file first,
   Enter opens history with the newest commit selected and its diff shown;
   the rename appears as one entry with `old → new` and older entries use
   the old path; Blame shows the right author per hunk and clicking a hash
   opens that commit's summary; blame of the binary file shows the binary
   error with a working Dismiss; Close restores the branches panel.
4. Jira GR-9 transitions to Done with the walk results and follow-ups in a
   comment.
