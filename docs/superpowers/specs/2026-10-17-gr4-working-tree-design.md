# GR-4 — Working tree view: stage, unstage, and discard changes

- Status: Approved (decisions delegated to the agent by the user on 2026-10-17; see §2)
- Date: 2026-10-17
- Epic: GR-1 / Story: GR-4
- Depends on: ADR 0001, ADR 0002, GR-3 spec (`2026-10-16-gr3-repo-open-clone-init-design.md`)

## 1. Goal

With a repository open, the user sees every modified, added, deleted, renamed,
untracked and conflicted file, grouped into **Conflicts**, **Staged** and
**Unstaged**, and moves files between the working tree and the index. The
view refreshes by itself when files change on disk.

### Acceptance criteria (from Jira GR-4)

1. File list shows status (modified, added, deleted, renamed, untracked,
   conflicted) with icons.
2. Stage and unstage a single file, a selection, or all files.
3. Stage and unstage individual hunks and lines.
4. Discard changes for a file or hunk with a confirmation prompt.
5. Untracked files can be added to `.gitignore` from the context menu.
6. View refreshes automatically when files change on disk.

### Scope split with GR-5

Criteria 3 and the hunk half of 4 need a rendered diff to click on. GR-4
delivers the **backend and IPC** for hunk- and line-level stage, unstage and
discard (`apply_hunk`) with full tests; the **controls** that invoke them are
part of the diff viewer in GR-5, which starts immediately after. GR-4 also
delivers the `get_file_diff` command the viewer will consume, because the
patch builder needs the same diff model. GR-4 is marked Done in Jira once GR-5
has landed the controls.

### Out of scope

- Diff rendering, syntax highlighting, side-by-side (GR-5).
- Commit (GR-6). The Changes panel leaves room for the commit box below it.
- Submodules: shown as modified entries, never descended into.
- Conflict resolution UI (GR-10): a conflicted file can be staged (marks it
  resolved) or discarded, nothing more.
- Resizable panels (GR-14).

## 2. Decisions

- **Two-column status model.** Each entry carries `index` (HEAD → index
  change) and `worktree` (index → workdir change), like `git status
--porcelain=2`. A file modified in both appears in both the Staged and
  Unstaged sections. Conflicted entries carry `conflicted: true` and sit in
  their own section.
- **Hunk and line staging apply a patch through git2** (`Repository::apply`
  with `ApplyLocation::Index` or `WorkDir`). The patch is built in pure Rust
  from the diff the core computed itself, never from text the UI sends; the UI
  identifies a hunk by its index and lines by their index within the hunk.
  Line and hunk operations are computed with whitespace ignoring **off**; the
  viewer disables them while "hide whitespace changes" is on (GR-5).
- **Discard restores the working tree from the index, not HEAD.** "Discard"
  lives in the Unstaged section, so it removes unstaged changes only. For an
  untracked file (or directory) discard deletes it. Every discard goes through
  a confirmation prompt in the UI; the backend has no confirmation.
- **File watching is in the app layer with `notify` 8**, recursive on the
  working directory (which includes `.git`), debounced to one `repo-changed`
  event per 250 ms per repository. Events under `.git/objects/` and `*.lock`
  files are dropped. If a watch cannot be established (inotify limits) the
  error is logged and the view still refreshes after every action and on
  window focus. Ignored directories such as `node_modules` are watched too;
  pruning them is a follow-up if inotify limits bite in practice.
- **The deferred double-open race is fixed first.** `RepoRegistry` gains
  `register_or_find`, which looks up by path and inserts under one lock.
- **Context menu and confirmation dialog are custom React components** in
  `src/components/`, not native menus, so they are testable with Testing
  Library and themable with the tokens.
- **Status icons are lettered badges** (M, A, D, R, T, U, C) in CSS Modules
  with an `aria-label`, no icon font or SVG dependency.
- **No new front-end dependency.** One new Rust use: `notify` (already in
  `Cargo.toml`, unused until now).

## 3. Rust domain: `git-real-core`

### 3.1 Modules

```
crates/git-real-core/src/
  model/
    status.rs       # ChangeKind, StatusEntry, WorkingTreeStatus
    diff.rs         # DiffScope, DiffLineKind, DiffLine, Hunk, FileDiff, HunkSelection, HunkAction
  status.rs         # impl RepoSession { fn status }
  diff/
    mod.rs          # impl RepoSession { fn file_diff, fn apply_hunk }
    patch.rs        # pure: build_patch(FileDiff, &HunkSelection, reverse) -> String
  index_ops.rs      # impl RepoSession { stage_paths, unstage_paths, stage_all, unstage_all, discard_paths }
  ignore.rs         # impl RepoSession { add_to_gitignore }; pure gitignore_pattern(path, is_dir)
```

`RepoSession` keeps owning the `git2::Repository`; the new modules add
`impl RepoSession` blocks and take `&self`.

### 3.2 Types

```rust
// model/status.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind { Added, Modified, Deleted, Renamed, TypeChange, Untracked, Conflicted }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,                 // repo-relative, '/' separated
    pub old_path: Option<String>,     // Some for renames
    pub index: Option<ChangeKind>,    // HEAD -> index
    pub worktree: Option<ChangeKind>, // index -> workdir (Untracked lives here)
    pub conflicted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeStatus {
    pub entries: Vec<StatusEntry>,    // sorted by path, stable
    pub head_unborn: bool,
}
```

```rust
// model/diff.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope { Staged, Unstaged }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind { Context, Addition, Deletion }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    pub content: String,              // without the trailing newline
    pub no_newline_at_eof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32, pub old_lines: u32,
    pub new_start: u32, pub new_lines: u32,
    pub header: String,               // "@@ -a,b +c,d @@ optional"
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub scope: DiffScope,
    pub change: Option<ChangeKind>,   // None when the file is unchanged in this scope
    pub is_binary: bool,
    pub hunks: Vec<Hunk>,
    pub truncated: bool,              // true when max_lines was hit; hunks are then partial
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    pub hunk_index: usize,
    pub lines: Option<Vec<usize>>,    // indices into Hunk.lines of Addition/Deletion lines; None = whole hunk
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HunkAction { Stage, Unstage, Discard }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffOptions { pub ignore_whitespace: bool, pub context_lines: u32, pub max_lines: usize }
impl Default for DiffOptions { /* false, 3, 10_000 */ }
```

New `GitError` variants:

```rust
#[error("{0} has no changes in that scope")]
NoChanges(String),
#[error("hunk selection is out of range")]
BadSelection,
#[error("could not apply patch: {0}")]
ApplyFailed(String),
```

### 3.3 Behaviour

**`status()`** uses `StatusOptions` with `include_untracked`,
`recurse_untracked_dirs`, `renames_head_to_index`, `renames_index_to_workdir`,
`exclude_submodules(false)`, ignored files excluded. Mapping of git2 flags:

| git2 flag                                               | field                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `INDEX_NEW / MODIFIED / DELETED / RENAMED / TYPECHANGE` | `index = Some(Added/Modified/Deleted/Renamed/TypeChange)`          |
| `WT_NEW`                                                | `worktree = Some(Untracked)`                                       |
| `WT_MODIFIED / DELETED / RENAMED / TYPECHANGE`          | `worktree = Some(Modified/Deleted/Renamed/TypeChange)`             |
| `CONFLICTED`                                            | `conflicted = true`, `worktree = Some(Conflicted)`, `index = None` |

`path` is the new path (`head_to_index().new_file()` or
`index_to_workdir().new_file()`), `old_path` the old one when it differs.
`head_unborn` is `repo.head().is_err()` with `UnbornBranch`. Entries are sorted
by `path`.

**`file_diff(path, scope, opts)`**:

- `Unstaged`: `diff_index_to_workdir` with `pathspec(path)`,
  `include_untracked(true)`, `recurse_untracked_dirs(true)`,
  `show_untracked_content(true)`, `ignore_whitespace(opts.ignore_whitespace)`,
  `context_lines(opts.context_lines)`.
- `Staged`: `diff_tree_to_index(head_tree_or_none, None, opts)`; an unborn
  HEAD diffs against the empty tree.
- Renames: `find_similar` with defaults so a staged rename shows as one diff
  with `old_path`.
- The single delta's `new_file().path()` becomes `path`; no delta →
  `Err(NoChanges(path))`.
- `is_binary` from the delta flags; a binary diff has no hunks.
- Hunks and lines are collected through `Diff::foreach`; `DiffLine.content`
  drops exactly one trailing `\n` (and `\r\n`); origin `'\'` lines set
  `no_newline_at_eof` on the previous line. When the running line count reaches
  `max_lines`, collection stops and `truncated = true`.

**`patch::build_patch(diff, selection, reverse)`** (pure, inline tests):

- Output: `--- a/<old_path or path>` / `+++ b/<path>` (`/dev/null` for an added
  or deleted file), one `@@ -o,n +p,m @@` hunk, lines prefixed ` `, `+`, `-`,
  and `\ No newline at end of file` after lines flagged `no_newline_at_eof`.
- With `lines = Some(idx)`: additions not selected are omitted; deletions not
  selected become context; counts are recomputed. Indices that are out of
  range or point at context lines → `Err(BadSelection)`.
- With `reverse = true` the roles swap: `+` ↔ `-`, old ↔ new headers and
  counts. This is how unstage (reverse onto the index) and discard (reverse
  onto the workdir) work.
- Hunk `new_start` for a staged-scope partial patch is kept as computed; git2
  apply tolerates offset drift the way `git apply` does.

**`apply_hunk(path, action, selection)`**:

| action  | diff scope | reverse | apply location |
| ------- | ---------- | ------- | -------------- |
| Stage   | Unstaged   | no      | Index          |
| Unstage | Staged     | yes     | Index          |
| Discard | Unstaged   | yes     | WorkDir        |

always with `DiffOptions { ignore_whitespace: false, .. }`. git2 apply errors
map to `ApplyFailed(message)`. For an untracked file, `Stage` with
`lines: None` stages the whole file (same as `stage_paths`).

**Index operations** (each writes the index once):

- `stage_paths(paths)`: for each path, `add_path` when it exists on disk,
  otherwise `remove_path`. Staging a conflicted path with `add_path` marks it
  resolved.
- `stage_all()`: `add_all(["*"], Default)` then `update_all(["*"])`.
- `unstage_paths(paths)`: with a HEAD commit, `reset_default(Some(head), paths)`;
  unborn → `remove_path` for each.
- `unstage_all()`: `reset_default(Some(head), ["*"])`; unborn → `index.clear()`.
- `discard_paths(paths)`: tracked → `checkout_index` with `force()` and
  `path(p)`; untracked file → `remove_file`, untracked dir →
  `remove_dir_all`. Unknown path → `PathNotFound`.

**`add_to_gitignore(path)`** appends `gitignore_pattern(path, is_dir)` to
`<workdir>/.gitignore` (created if missing; a missing final newline is added
first). The pattern is `/path` for a file and `/path/` for a directory.
Returns the pattern written.

### 3.4 Tests (`cargo test -p git-real-core`)

Integration tests in `tests/status.rs`, `tests/diff.rs`, `tests/index_ops.rs`,
`tests/ignore.rs` using `tests/common` fixtures extended with helpers that
write files, stage, commit, and build conflict states (two branches editing the
same line, merged with `git2::Repository::merge`). `patch.rs` has inline unit
tests for selection and reversal. The behaviours above are each pinned by at
least one positive and one negative test.

## 4. Tauri app layer

### 4.1 Changes

- `state.rs`: `RepoRegistry::register_or_find(session) -> (RepoId, bool)` under
  the map lock (fixes the double-open race); `register_session` uses it.
- `watcher.rs`: `RepoWatcher::start(app, repo_id, workdir) -> Result<RepoWatcher, notify::Error>`
  wraps a `notify::RecommendedWatcher`; a thread debounces raw events and
  emits `repo-changed` `{ repoId }`. Dropping stops it. `WatcherRegistry`
  (managed state) maps `RepoId → RepoWatcher`; started in `open/init/clone`
  after registration, removed in `close_repo`.
- `events.rs`: `REPO_CHANGED = "repo-changed"`, `RepoChangedPayload { repo_id }`.
- `error.rs`: new kinds `noChanges`, `badSelection`, `applyFailed`.
- `commands/worktree.rs` (each is a thin wrapper over an `*_inner` fn that
  takes `&RepoRegistry` and locks the session; unknown id → `unknownRepo`):

| command            | args                                                     | returns                    |
| ------------------ | -------------------------------------------------------- | -------------------------- |
| `get_status`       | `id`                                                     | `WorkingTreeStatus`        |
| `get_file_diff`    | `id, path, scope, ignoreWhitespace: bool`                | `FileDiff`                 |
| `stage_paths`      | `id, paths: Vec<String>`                                 | `()`                       |
| `unstage_paths`    | `id, paths`                                              | `()`                       |
| `stage_all`        | `id`                                                     | `()`                       |
| `unstage_all`      | `id`                                                     | `()`                       |
| `discard_paths`    | `id, paths`                                              | `()`                       |
| `apply_hunk`       | `id, path, action: HunkAction, selection: HunkSelection` | `()`                       |
| `add_to_gitignore` | `id, path`                                               | `String` (pattern written) |

All run through `run_blocking`. Mutating commands do not emit events
themselves; the watcher does.

### 4.2 Tests (`cargo test --workspace`)

`tests/worktree_commands.rs` drives the `*_inner` functions with a temp repo;
`tests/watcher.rs` starts a watcher on a temp dir with a recording emitter
(the watcher takes an `impl Fn(RepoId) + Send` so tests do not need an
`AppHandle`) and asserts one event for a burst of writes and none for
`.git/objects` writes; `tests/registry.rs` gains a concurrent
`register_or_find` test.

## 5. Front end

### 5.1 Files

```
src/lib/ipc/types.ts        # + ChangeKind, StatusEntry, WorkingTreeStatus, DiffScope, DiffLineKind,
                            #   DiffLine, Hunk, FileDiff, HunkSelection, HunkAction, RepoChangedPayload
src/lib/ipc/commands.ts     # + getStatus, getFileDiff, stagePaths, unstagePaths, stageAll, unstageAll,
                            #   discardPaths, applyHunk, addToGitignore
src/lib/ipc/events.ts       # + onRepoChanged(repoId, handler)
src/lib/query/keys.ts       # + status(repoId), fileDiff(repoId, path, scope, ignoreWs), repo(repoId) prefix
src/lib/store/workspace.ts  # selectedFile per repo: { path, scope } | null; select(repoId, file)
src/components/ContextMenu.tsx   # items, position, Escape/outside-click close, roving focus
src/components/ConfirmDialog.tsx # title, body, confirm/cancel labels, danger flag
src/features/worktree/useStatus.ts          # query + repo-changed subscription → invalidate repo(repoId)
src/features/worktree/useWorktreeActions.ts # mutations; each invalidates repo(repoId) on settle
src/features/worktree/useFileSelection.ts   # pure multi-select (click, ctrl, shift) over an ordered list
src/features/worktree/StatusBadge.tsx
src/features/worktree/FileRow.tsx
src/features/worktree/ChangesPanel.tsx      # sections, Stage all/Unstage all, discard confirm, context menu
src/app/RepoPane.tsx        # layout: header, left ChangesPanel (320px), right detail placeholder
src/styles/tokens.css       # + --color-added, --color-removed, --color-modified, --color-danger (light+dark)
```

### 5.2 Behaviour

- `useStatus(repoId)` queries `getStatus`; it subscribes to `repo-changed` for
  that repo and invalidates every query under `queryKeys.repo(repoId)`.
  `refetchOnWindowFocus` is on for this query.
- Sections render in order Conflicts, Staged, Unstaged, each with a count and
  hidden when empty; an empty state reads "No changes".
- Row: badge (letter + `aria-label` like "modified"), path with the directory
  muted, `old → new` for renames. Click selects (sets `workspace.selectedFile`
  with the row's scope) and supports Ctrl and Shift multi-select.
- Per row: a "Stage"/"Unstage" button (`aria-label` "Stage <path>"), and in
  the Unstaged section a "Discard" button that opens `ConfirmDialog`
  ("Discard changes to <path>?" / "Delete untracked file <path>?"). With a
  multi-selection the action applies to the whole selection within that
  section.
- Section header buttons "Stage all" / "Unstage all".
- Right-click on an untracked row opens the context menu with "Add to
  .gitignore"; other rows get "Stage"/"Unstage"/"Discard…".
- While a mutation is pending the affected buttons are disabled; an error
  renders through `RepoError` (dismissable) above the list.
- `RepoPane` shows the detail placeholder "Select a file to view its diff"
  (replaced in GR-5).

### 5.3 Tests

`mockIPC` for commands; `mockWindows`/`emit` from `@tauri-apps/api/mocks` are
not needed: `onRepoChanged` is mocked through the `vi.mock(import("../../lib/ipc"))`
recipe. Coverage stays at 100 % statements/branches for `src/`.

## 6. Definition of Done

1. All gates green: `npm run lint && npm run typecheck && npm test -- --coverage && npm run build`;
   from `src-tauri`: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`.
2. Architect sign-off on every task and on the merged branch.
3. Manual walk (automated through the webview driver when the user is away):
   modify, add, delete, rename and create untracked files in a fixture repo
   and confirm sections, badges, stage/unstage single, multi and all,
   discard with confirmation, add to `.gitignore`, and an external `touch`
   refreshing the view within a second.
4. Jira GR-4 transitions to Done after GR-5 lands the hunk/line controls.
