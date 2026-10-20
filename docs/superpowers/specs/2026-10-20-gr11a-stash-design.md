# GR-11a — Stash

- Jira: GR-11 "Stash and tag management", slice **a** of two. Slice b
  (tags: create lightweight/annotated, sidebar list, delete local, push and
  delete remote) follows with its own spec. The story stays one Jira issue
  and moves to Done after slice b.
- Depends on: GR-7 (`BranchesPanel` layout and inline-error pattern,
  `ContextMenu`, `ConfirmDialog`), GR-9 (`CommitSummary`, `commit_files`,
  `DiffScope::Commit`, workspace `selectedCommit`), GR-10a (`git_ops::run`,
  the "non-zero exit is conflicts only when the index has conflicts" rule,
  `OperationInProgress` / `UnresolvedConflicts`), GR-10b (conflict editor,
  reached from the Changes panel conflicts group).
- Follows: ADR 0001 (operations that create commits shell out to the git
  CLI; local reads use git2), ADR 0002 (`features/stash/` owns the stash
  UI), the IPC seam rule, the 100 % coverage gate.
- Date: 2026-10-20. Design approved in chat section by section.

## 1. Goal

The user can stash the working tree with an optional message and an
"include untracked files" option, see their stashes in the left column,
inspect a stash's files and diffs before applying it, and apply, pop or drop
a stash (drop asks for confirmation). An apply or pop that conflicts leaves
the conflicted files in the Changes panel, where the GR-10b editor resolves
them. This closes the first three GR-11 acceptance criteria.

### Out of scope (follow-ups)

- Stash nodes in the commit graph.
- `git stash apply --index` (restoring the staged/unstaged split).
- Partial stash (per-file pathspecs), `--staged`, `--keep-index`.
- Renaming a stash; `git stash branch`.
- Tags (GR-11b).

## 2. Decisions

- **Writes use the git CLI, reads use git2** (chat approach A). `git stash
push`, `apply`, `pop` and `drop` run through `git_cli`; a stash push
  creates commits (ADR 0001), and apply/pop are merges whose conflict
  output (markers, conflicted index entries, pop keeping the stash) must
  match the command line so the existing conflict UI handles it. Rejected:
  git2's stash API (different conflict behaviour, no hooks) and parsing
  `git stash list` / `show -p` (moves local reads off git2).
- **Stash list comes from the `refs/stash` reflog** via git2, newest first;
  entry _n_ is `stash@{n}`.
- **No new `DiffScope` variant.** A stash commit `W` has parents
  `[base, index, untracked?]`. Its tracked diff is `W` against its first
  parent, which `DiffScope::Commit(W)` already is. The untracked commit `U`
  (third parent) is a root commit, so `DiffScope::Commit(U)` diffs it
  against the empty tree.
- **Index + oid guard.** Every write names a stash by both index and full
  oid; core checks that `stash@{n}` still resolves to that oid before
  running git, and fails with `StaleStash` otherwise. This prevents dropping
  the wrong stash after the list shifted (e.g. a stash made in a terminal).
- **Confirmation on drop only** (user choice). Apply and pop run at once; a
  conflicting pop keeps the stash, so nothing is lost.
- **Entry points: both** (user choice) — a **+** on the Stashes section
  header and a **Stash…** button in the Changes panel header, sharing one
  dialog and one actions hook.
- **Sidebar only** (user choice): no graph nodes in this slice.
- **Push detection by ref, not text.** "Nothing to stash" is detected by
  comparing the `refs/stash` target before and after `git stash push`
  (git exits 0 with "No local changes to save"), never by parsing stdout.

## 3. Core (`git-real-core`)

### 3.1 Model — `src/model/stash.rs`

```rust
pub struct StashEntry {
    pub index: u32,              // n in stash@{n}
    pub oid: String,             // full hex of the stash commit W
    pub message: String,         // reflog message, e.g. "On main: wip" / "WIP on main: abc1234 subject"
    pub branch: Option<String>,  // parsed from "On <b>:" / "WIP on <b>:"; None if unparseable or "(no branch)"
    pub time: i64,               // reflog committer time, seconds since epoch
    pub base: String,            // full hex of W^1
    pub has_untracked: bool,     // W has a third parent
}

pub struct StashFiles {
    pub tracked: Vec<CommitFile>,      // W vs W^1 (same shape as commit_files)
    pub untracked: Vec<CommitFile>,    // empty tree vs U
    pub untracked_oid: Option<String>, // U, when present
}

pub enum StashOutcome { Applied, Conflicts }
```

Serialized camelCase like the other models; `StashOutcome` as
`"applied" | "conflicts"`.

### 3.2 `src/stash/mod.rs` — `impl RepoSession`

| Method                                                             | Backend | Behaviour                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_stashes() -> Vec<StashEntry>`                                | git2    | Reads the `refs/stash` reflog; missing ref → empty vec.                                                                                                                                                                                                                                                                                                    |
| `stash_files(oid) -> StashFiles`                                   | git2    | `oid` must be a commit with ≥ 2 parents reachable as a stash; otherwise `RevisionNotFound`. Tracked via the `commit_files` logic; untracked via the third parent's tree.                                                                                                                                                                                   |
| `stash_push(message: Option<&str>, include_untracked: bool) -> ()` | CLI     | Refuses on unborn HEAD (`UnbornHead`), an operation in progress (`OperationInProgress`) or index conflicts (`UnresolvedConflicts`). Runs `git stash push [--include-untracked] [-m <message>]`; a blank/whitespace message is treated as none. Unchanged `refs/stash` target afterwards → `NothingToStash`. Non-zero exit → `OperationFailed` with stderr. |
| `stash_apply(index, oid) -> StashOutcome`                          | CLI     | Guard (§2), refuse during an operation in progress, then `git stash apply stash@{n}`. Exit 0 → `Applied`. Non-zero and index has conflicts → `Conflicts`. Other non-zero → `OperationFailed` with stderr (e.g. "local changes would be overwritten").                                                                                                      |
| `stash_pop(index, oid) -> StashOutcome`                            | CLI     | As apply, with `git stash pop`. On `Conflicts` git keeps the stash.                                                                                                                                                                                                                                                                                        |
| `stash_drop(index, oid) -> ()`                                     | CLI     | Guard, then `git stash drop stash@{n}`; non-zero → `OperationFailed`.                                                                                                                                                                                                                                                                                      |

CLI calls reuse the `git_cli::command` environment (`LC_ALL=C`,
`GIT_TERMINAL_PROMPT=0`, cleared repo env) and run with `-C <workdir>`.
Index values are formatted by the code (`stash@{<u32>}`), never taken as
strings from the caller. The message is passed as a separate argv element
after `-m`.

### 3.3 Errors — `GitError`

New: `NothingToStash`, `StaleStash`. Reused: `UnbornHead`,
`OperationInProgress`, `UnresolvedConflicts`, `OperationFailed`,
`RevisionNotFound`. `AppErrorKind` gains `nothingToStash` and `staleStash`,
mapped in `src-tauri/src/error.rs`.

## 4. App layer (`src-tauri`)

`src/commands/stash.rs`, registered in `lib.rs`, each an `*_inner` function
plus an async command using `with_session` + `run_blocking`:

| Command           | Args                                            | Returns        |
| ----------------- | ----------------------------------------------- | -------------- |
| `list_stashes`    | `id`                                            | `StashEntry[]` |
| `get_stash_files` | `id, oid`                                       | `StashFiles`   |
| `stash_push`      | `id, message: string \| null, includeUntracked` | `void`         |
| `stash_apply`     | `id, index, oid`                                | `StashOutcome` |
| `stash_pop`       | `id, index, oid`                                | `StashOutcome` |
| `stash_drop`      | `id, index, oid`                                | `void`         |

The repo watcher already emits repo-changed for `.git` ref/reflog and
worktree changes; the front end invalidates the stash queries on it.

## 5. Front end

### 5.1 IPC — `src/lib/ipc`

Types `StashEntry`, `StashFiles`, `StashOutcome` in `types.ts`; typed
wrappers in `commands.ts`; the two new error kinds in `errors.ts`. Nothing
outside `src/lib/ipc` calls `invoke`.

### 5.2 Hooks — `src/features/stash/`

- `useStashes(repoId)`: query for `list_stashes`, refreshed on repo-changed.
- `useStashFiles(repoId, oid)`: query for `get_stash_files`, enabled when an
  oid is selected.
- `useStashActions(repoId)`: `push`, `apply`, `pop`, `drop` mutations; on
  success they invalidate stashes, status and log queries. Exposes `pending`,
  the last `error`, and the last conflict `notice`
  (`{ kind: "apply" | "pop", index }`). Shared by the panel, the dialog, the
  Changes panel button and the summary.

### 5.3 Workspace store

`selectedStash: Record<RepoId, string | null>` (full oid) with
`selectStash`. `selectStash(repo, oid)` sets `selectedCommit[repo] = null`;
`selectCommit(repo, oid)` with a non-null oid sets `selectedStash[repo] =
null`. `clear(repo)` forgets it.

### 5.4 `StashesPanel` (left column)

- Rendered in `RepoPane`'s refs column below `BranchesPanel`, in its own
  component and file; both are replaced by `FileHistoryPanel` while history
  is open.
- Header "Stashes" with the count and a **+** button labelled "Stash
  changes…". Disabled, with a `title` giving the reason, when: HEAD is
  unborn ("Make a commit first"), an operation is in progress, the index has
  conflicts, or the status has no changes ("No changes to stash").
- One row per stash: message, branch (when known), relative time, an
  "untracked" marker when `hasUntracked`. Empty list → "No stashes".
- Click (or Enter/Space) selects the stash. Right-click or the context-menu
  key opens `ContextMenu` with **Apply**, **Pop**, **Drop…**; Apply/Pop are
  disabled during an operation in progress. Keyboard follows `BranchRow`.
- **Drop…** opens `ConfirmDialog`: "Drop stash@{n}?" / "This can't be
  undone." / confirm "Drop".
- Inline status area under the header (same pattern as BranchesPanel):
  - conflict notice after an apply: "Applied with conflicts. Resolve them in
    Changes."; after a pop, plus " The stash was kept; drop it once
    resolved." Dismissable; cleared by the next action.
  - errors: `staleStash` → "The stash list changed; it has been refreshed."
    (and the list refetches); `operationFailed` → git's message; others →
    the shared error-message mapping.

### 5.5 `StashDialog`

A modal form: optional "Message" text field, "Include untracked files"
checkbox (off by default), Cancel / **Stash** buttons. Submit calls
`push`; success closes the dialog; `nothingToStash` shows inline ("No local
changes to stash.") and keeps it open; other errors show inline too. Opened
by the panel's **+** and by the Changes panel's **Stash…** button (in the
header next to Stage all / Unstage all, with the same disabled rules).

### 5.6 `StashSummary` (right column)

- `RepoPane`'s right column shows `CommitSummary` when a commit is selected,
  `StashSummary` when a stash is selected, otherwise Changes + CommitBox.
- Header: "stash@{n}" and a Close button (clears the selection). Body:
  message, branch, date, base commit short id. Buttons **Apply**, **Pop**,
  **Drop…** (drop confirms as in §5.4).
- File list in two groups, **Changes** (tracked) and **Untracked** (only
  when present), each row with the status badge used by CommitSummary.
  Clicking a file selects it with scope `{ commit: stashOid }` (tracked) or
  `{ commit: untrackedOid }` (untracked), so the existing `DetailPane` shows
  the diff.
- When the selected oid is no longer in `useStashes` (popped, dropped, or
  changed outside the app) or `get_stash_files` returns `revisionNotFound`,
  the selection clears and the column returns to Changes.

## 6. Error handling summary

| Situation                                    | Kind                       | UI                                               |
| -------------------------------------------- | -------------------------- | ------------------------------------------------ |
| Push with no local changes                   | `nothingToStash`           | Inline in StashDialog; dialog stays open         |
| `stash@{n}` no longer matches the oid        | `staleStash`               | Panel message, list refetch                      |
| Write during merge/rebase/cherry-pick/revert | `operationInProgress`      | Controls disabled with reason; error as fallback |
| Push with index conflicts                    | `unresolvedConflicts`      | Controls disabled with reason; error as fallback |
| Push on unborn HEAD                          | `unbornHead`               | Controls disabled "Make a commit first"          |
| Apply/pop refused without conflicts          | `operationFailed` (stderr) | Panel message with git's text; nothing changed   |
| Selected stash unknown                       | `revisionNotFound`         | Summary closes, selection clears                 |

`conflicts` is an outcome, not an error (§5.4 notice).

## 7. Testing

Tests are written first by the tester role; the developer never edits them.

- **Core** `crates/git-real-core/tests/stash.rs` (temp repos via
  `tests/common`): list empty / several / message and branch parsing /
  untracked flag / detached "(no branch)"; files tracked vs untracked,
  rename and delete inside a stash, non-stash oid → `RevisionNotFound`;
  push with and without message, blank message, `-u` includes untracked,
  nothing to stash, mid-merge refusal, index conflicts refusal, unborn HEAD;
  apply clean, apply conflict (index conflicted, stash kept), pop clean
  (stash removed), pop conflict (stash kept), apply refused by dirty overlap
  (`OperationFailed` with stderr, tree unchanged), stale index/oid for
  apply, pop and drop; drop success; argv check that the message is one
  argv element.
- **App layer** `src-tauri/tests/stash_commands.rs`: each `*_inner`
  wiring, unknown repo, error-kind mapping for the two new kinds.
- **Front end** (Vitest, IPC mocked at `src/lib/ipc`): wrappers and types;
  error kinds; `useStashes` / `useStashFiles` / `useStashActions`
  (invalidation, notice, error); workspace store mutual exclusion and
  `clear`; `StashesPanel` (rows, empty, count, disabled reasons, menu,
  keyboard, drop confirm, notices, errors, stale refetch); `StashDialog`
  (message, checkbox, submit, inline errors, cancel); `StashSummary`
  (header, groups, untracked group hidden when absent, file selection
  scopes, buttons, selection cleared when the stash vanishes); Changes
  panel **Stash…** button; `RepoPane` right-column switching.
- **Gate:** `cargo test --workspace`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo fmt --check`, `npm test` with 100 %
  statements/branches/functions/lines, `npm run lint`, `npm run typecheck`,
  final architect approval.
- **Acceptance walk** (running app, WebKit inspector tooling):
  1. Stash with a message and an untracked file → row appears, working tree
     clean.
  2. Select it → summary shows Changes and Untracked groups; open a diff in
     each.
  3. Apply → changes return, stash remains.
  4. Commit a change to the same lines the stash touches (clean tree), then
     Pop → notice, conflicted file in Changes, resolve in the GR-10b editor,
     stash still listed. (An uncommitted overlapping change makes git refuse
     instead — `operationFailed`, covered by core tests.)
  5. Drop… → confirm → row gone.
  6. Note a row's index and oid, create a stash in a terminal (the watcher
     refreshes the list), then call `stash_drop` with the old index and oid
     through the inspector → `staleStash`, nothing dropped. (The UI refetch
     makes the race hard to hit by hand.)
  7. "Stash…" from the Changes panel with nothing to stash → disabled with
     reason.
  8. Stash with only an untracked file and the checkbox off → inline
     "No local changes to stash."; dialog stays open.
