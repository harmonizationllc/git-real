# GR-7 — Branch management

- Status: Draft for review
- Date: 2026-10-18
- Epic: GR-1 / Story: GR-7 "Branch management"
- Depends on: GR-3 (sessions, git CLI adapter, `RepoError`), GR-4 (watcher,
  `repo-changed`, context menu, confirm dialog), GR-5/GR-6 (`RepoPane`
  layout, mutation-hook pattern)
- Follows: ADR 0001 (hybrid git backend), ADR 0002 (project structure)

## 1. Goal

A refs column on the left of the repo pane lists local and remote branches,
highlights the current one, and lets the user create, switch, rename and
delete branches without leaving the app. The pane's columns become
resizable so the new column fits any window width.

### Acceptance criteria (from Jira GR-7)

1. Sidebar lists local and remote branches, grouped, with the current branch
   highlighted.
2. Create a branch from the current HEAD or from any commit in the graph.
3. Checkout a branch by double-click or context menu.
4. Checkout of a remote branch creates a tracking local branch.
5. Rename and delete local branches, with force-delete confirmation for
   unmerged branches.
6. Delete remote branches.
7. Branch filter / search box.

Criterion 2 is met for HEAD and for any listed branch; the graph does not
exist until GR-8. The create command takes an arbitrary start point, so GR-8
only has to call it with a commit id.

### Out of scope

- Branch folders (grouping by `/`), drag-to-merge, drag-to-rebase (GR-10).
- Push, fetch, prune, setting or changing an upstream (GR-12).
- Creating a branch from a graph commit (GR-8 reuses `create_branch`).
- Stash-and-switch when the working tree is dirty: git's own refusal is
  shown verbatim and the user decides.
- Tags and stashes in the refs column (GR-11).
- Resizing the detail pane's inner panels and persisting per-repo widths.

## 2. Decisions

- **Checkout shells out to `git switch`.** The same reasoning that put
  `git commit` on the CLI in GR-6: `post-checkout` hooks, submodules, sparse
  checkout and the "your local changes would be overwritten" guard behave
  exactly as on the command line, and git's stderr is shown verbatim. libgit2
  runs no hooks, ignores submodules and has different safe-checkout rules; it
  would be the one write path that silently diverges from the terminal.
  `git switch` needs git 2.23 (2019); the app already requires the CLI.
- **Deleting a remote branch shells out to `git push <remote> --delete
<name>`.** It is a network operation (ADR 0001). Credentials come from the
  user's agent or credential helper; `GIT_TERMINAL_PROMPT=0` turns a prompt
  into an error instead of a hang.
- **Everything else is git2**: listing (with upstream and ahead/behind),
  create, rename, local delete, and every pre-check.
- **Pre-checks run in core before git does anything**, so the common
  failures have stable error kinds instead of parsed stderr: invalid name,
  name taken, branch missing, not merged, current branch, unborn HEAD,
  unknown remote or start point. Git remains the authority for everything
  else (dirty tree, hooks, authentication).
- **Unmerged means HEAD does not descend from the branch tip.** `git branch
-d` also accepts "merged into upstream"; that nuance is not worth a second
  rule. Delete is attempted without force first; a `branchNotMerged` reply
  opens the force confirmation. One command, one flag, no separate "is
  merged" query that could go stale.
- **Checking out a remote branch switches to an existing local branch of the
  same short name when there is one**, whatever its upstream, and otherwise
  runs `git switch -c <name> --track <remote>/<name>`. That is what a user
  double-clicking `origin/feature` expects, and it never fails with "a
  branch named feature already exists".
- **Branch names never reach the command line as flags.** Every name is
  validated with `git2::Branch::name_is_valid` and rejected if it starts
  with `-`; every remote name must resolve with `Repository::find_remote`.
  The CLI calls use `-C <workdir>` and pass validated names only.
- **The session lock is not held during the network call.** The remote
  delete reads the workdir under the lock, releases it, runs the push, and
  the watcher's `repo-changed` refreshes the list when git updates the
  remote-tracking ref. Checkout does hold the lock, like commit, because it
  rewrites the index and working tree.
- **One payload for the whole column.** `list_branches` returns HEAD state,
  local branches and remote groups in one call. The header's branch line
  reads HEAD from this query, so it finally goes live (today it is a
  snapshot from open time).
- **Resizable columns with persisted widths.** The refs column and the
  changes sidebar each get a drag handle; widths live in a persisted store
  shared by every tab and are clamped to the window so the grid can never be
  wider than the pane. This fixes the existing fixed 320px sidebar too.
- **One `repo-changed` subscription per pane.** `RepoPane` subscribes once
  through a new `useRepoChanged` hook and invalidates the `repo(id)` prefix;
  `useStatus` loses its private subscription. This is the GR-6 follow-up and
  the branch query needs the same signal.
- **`git_cli` moves to the crate root.** Three modules (`remote::clone`,
  `commit::git_commit`, `refs::switch`) use it and only one is a remote
  operation. GR-6 follow-up, done here because the file is touched anyway.
- **No new dependency** in Rust or the front end.

## 3. Rust domain: `git-real-core`

### 3.1 Modules

```
crates/git-real-core/src/
  git_cli.rs           # moved from remote/git_cli.rs; `remote::git_cli` re-export removed
  model/
    branch.rs          # HeadState, Tracking, LocalBranch, RemoteBranch, RemoteGroup, BranchList
  refs/
    mod.rs             # impl RepoSession { list_branches, create_branch, rename_branch,
                       #   delete_branch, checkout_branch, checkout_remote_branch,
                       #   delete_remote_branch } + validate_branch_name
    switch.rs          # shell out: run(git, workdir, SwitchTarget) -> Result<(), GitError>
  remote/
    push_delete.rs     # shell out: run(git, workdir, remote, name) -> Result<(), GitError>
```

### 3.2 Types

```rust
// model/branch.rs — all serde camelCase
#[serde(tag = "kind")]
pub enum HeadState {
    Branch { name: String },                 // {"kind":"branch","name":"main"}
    Detached { oid: String },                // full hex oid
    Unborn { name: String },                 // the branch HEAD will create
}

pub struct Tracking {
    pub upstream: String,                    // "origin/main"
    pub ahead: Option<u32>,                  // None when the upstream ref is gone
    pub behind: Option<u32>,
}

pub struct LocalBranch {
    pub name: String,
    pub oid: String,
    pub is_head: bool,
    pub tracking: Option<Tracking>,
}

pub struct RemoteBranch {
    pub remote: String,                      // "origin"
    pub name: String,                        // "main" (short, without the remote)
    pub oid: String,
}

pub struct RemoteGroup { pub remote: String, pub branches: Vec<RemoteBranch> }

pub struct BranchList {
    pub head: HeadState,
    pub local: Vec<LocalBranch>,             // sorted by name, case-sensitive byte order
    pub remotes: Vec<RemoteGroup>,           // sorted by remote name, then branch name
}

// refs/switch.rs
pub enum SwitchTarget<'a> {
    Local(&'a str),                                    // git switch <name>
    NewTracking { name: &'a str, upstream: &'a str },  // git switch -c <name> --track <upstream>
}
```

### 3.3 Behaviour

- `list_branches()`:
  - `head`: `repo.head()`; symbolic to `refs/heads/x` → `Branch`;
    direct → `Detached`; `UnbornBranch` error → `Unborn` with the name from
    `find_reference("HEAD").symbolic_target()`.
  - `local`: `repo.branches(Some(Local))`; `is_head` from `Branch::is_head`;
    `tracking` from `branch.upstream()`: `Ok` → `graph_ahead_behind(local,
upstream)`; `Err(NotFound)` with an upstream configured
    (`branch_upstream_name` succeeds) → `Tracking { upstream, ahead: None,
behind: None }`; no upstream configured → `None`.
  - `remotes`: `repo.branches(Some(Remote))`; skip symbolic refs (`origin/
HEAD`); split with `branch_remote_name(refname)` so a remote named
    `a/b` is handled; group by remote.
  - Names are decoded lossily; a branch whose name is not valid UTF-8 is
    listed, never dropped.
- `validate_branch_name(name)`: `GitError::InvalidBranchName(name)` unless
  `Branch::name_is_valid(name)` is `Ok(true)` and `!name.starts_with('-')`.
- `create_branch(name, start_point: Option<&str>) -> LocalBranch`:
  validate; `find_branch(name, Local)` ok → `BranchExists`; `start_point`
  `None` → `repo.head()` (`UnbornBranch` → `GitError::UnbornHead`); `Some`
  → `revparse_single(spec)` (NotFound → `RevisionNotFound(spec)`), then
  `peel_to_commit`; `repo.branch(name, &commit, false)`.
- `rename_branch(old, new)`: validate `new`; `find_branch(old, Local)`
  NotFound → `BranchNotFound(old)`; `find_branch(new, Local)` ok →
  `BranchExists(new)`; `branch.rename(new, false)`. libgit2 updates HEAD and
  the `branch.<name>` config section itself.
- `delete_branch(name, force)`: `find_branch` NotFound → `BranchNotFound`;
  `is_head()` → `CannotDeleteCurrent(name)`; when `!force`, `repo.head()`
  resolves to a commit and `!graph_descendant_of(head_oid, tip)` and
  `head_oid != tip` → `BranchNotMerged(name)`; otherwise `branch.delete()`.
  A detached HEAD still has a commit, so the check works there; with an
  unborn HEAD there is nothing to be merged into, so without `force` the
  branch counts as unmerged.
- `checkout_branch(name)`: validate; `find_branch(name, Local)` NotFound →
  `BranchNotFound`; `git_cli::locate()?`; `switch::run(git, workdir,
Local(name))`.
- `checkout_remote_branch(remote, name)`: validate `name`; `find_remote
(remote)` NotFound → `RemoteNotFound(remote)`; `find_branch("remote/name",
Remote)` NotFound → `BranchNotFound("remote/name")`; if `find_branch(name,
Local)` is `Ok` → `switch::run(Local(name))`, else `switch::run
(NewTracking { name, upstream: "remote/name" })`.
- `delete_remote_branch(remote, name)`: validate `name`; `find_remote`
  NotFound → `RemoteNotFound`; `find_branch("remote/name", Remote)` NotFound
  → `BranchNotFound`; returns the arguments the app layer runs with
  (`PushDelete { git, workdir, remote, name }`), because the app releases
  the session lock before the network call. `remote::push_delete::run`
  executes it.
- `switch::run`: `git -C <workdir> switch <name>` or `git -C <workdir> switch
-c <name> --track <upstream>`, stdin null, stdout and stderr captured.
  Non-zero → `GitError::CheckoutFailed { code, stdout, stderr }`.
- `push_delete::run`: `git -C <workdir> push <remote> --delete <name>`,
  same capture. Non-zero → `GitError::PushFailed { code, stdout, stderr }`.

### 3.4 Errors

`GitError` gains `InvalidBranchName(String)`, `BranchExists(String)`,
`BranchNotFound(String)`, `BranchNotMerged(String)`,
`CannotDeleteCurrent(String)`, `UnbornHead`, `RevisionNotFound(String)`,
`RemoteNotFound(String)`, `CheckoutFailed { code, stdout, stderr }`,
`PushFailed { code, stdout, stderr }`.

### 3.5 Tests (`crates/git-real-core/tests/`)

- `branches.rs` (git2 fixtures only): list on a fresh repo (head `branch`,
  one local, no remotes); list with a bare clone as `origin` after a git2
  fetch (remote group, `origin/HEAD` skipped, tracking ahead/behind 0/0);
  ahead and behind counts after extra commits on each side; upstream gone →
  `ahead: None`; detached HEAD; unborn HEAD; create from HEAD, from a branch
  name, from a short oid; create with invalid name, `-flag`, taken name,
  unborn HEAD, unknown revision; rename (including the current branch keeps
  HEAD symbolic), rename to taken or invalid name, rename missing; delete
  merged, delete unmerged without force → `BranchNotMerged`, with force,
  current → `CannotDeleteCurrent`, missing; names with `/` list and delete;
  non-UTF-8 branch name does not panic.
- `switch.rs` (skips when `git` is not on PATH, like `commit.rs`): switch
  local; switch with a conflicting dirty file → `CheckoutFailed` with git's
  stderr and HEAD unchanged; checkout remote creates a tracking branch and
  `branch.feature.remote` is `origin`; checkout remote when a local of that
  name exists switches to it without creating anything; missing remote and
  missing remote branch kinds; `post-checkout` hook runs (writes a marker
  file).
- `push_delete.rs` (skips without `git`): against a local bare remote,
  delete removes the branch from the bare repo and the remote-tracking ref;
  deleting a branch the bare repo no longer has → `PushFailed` with stderr.
- `git_cli_command.rs` updates its import path; no behaviour change.

## 4. Tauri app layer (`src-tauri/src`)

- `commands/refs.rs`: `list_branches(id) -> BranchList`,
  `create_branch(id, name, startPoint: Option<String>, checkout: bool) ->
LocalBranch` (creates under the lock, then switches under the lock when
  `checkout`), `rename_branch(id, oldName, newName)`,
  `delete_branch(id, name, force)`, `checkout_branch(id, name)`,
  `checkout_remote_branch(id, remote, name)`, `delete_remote_branch(id,
remote, name)`. Each has an `_inner` on `RepoRegistry` and a `run_blocking`
  wrapper, registered in `lib.rs`. `delete_remote_branch_inner` locks to get
  `PushDelete`, drops the guard, then runs `push_delete::run`.
- `error.rs`: `AppErrorKind` gains `invalidBranchName`, `branchExists`,
  `branchNotFound`, `branchNotMerged`, `cannotDeleteCurrent`, `unbornHead`,
  `revisionNotFound`, `remoteNotFound`, `checkoutFailed`, `pushFailed`.
  `checkoutFailed` and `pushFailed` messages use the GR-6 rule: trimmed
  stderr, else trimmed stdout, else "git switch failed with exit code N" /
  "git push failed with exit code N" / "… was terminated by a signal". The
  helper is generalised to take the verb.
- `commands/repo.rs`, `tests/common/mod.rs`: import `git_real_core::git_cli`.
- Tests in `src-tauri/tests/refs_commands.rs`: list, create with and without
  checkout, rename, delete and force, unknown repo id, every new kind's
  mapping and the message fallbacks; remote delete against a bare repo when
  `git` is present.

## 5. Front end

### 5.1 IPC seam (`src/lib/ipc`)

- `types.ts`: `HeadState`, `Tracking`, `LocalBranch`, `RemoteBranch`,
  `RemoteGroup`, `BranchList`; `AppErrorKind` gains the ten kinds.
- `errors.ts`: the ten kinds added to `KINDS`.
- `commands.ts`: `listBranches(id)`, `createBranch(id, name, startPoint,
checkout)`, `renameBranch(id, oldName, newName)`, `deleteBranch(id, name,
force)`, `checkoutBranch(id, name)`, `checkoutRemoteBranch(id, remote,
name)`, `deleteRemoteBranch(id, remote, name)`.

### 5.2 Query keys, subscription, stores

- `queryKeys.branches(id)` = `["repo", id, "branches"]`.
- New `src/lib/query/useRepoChanged.ts`: `useRepoChanged(repoId)` holds the
  `onRepoChanged` subscription (the code now in `useStatus`) and invalidates
  `queryKeys.repo(repoId)`. `RepoPane` calls it once per tab; `useStatus`
  drops its effect. `useStatus.test.tsx` loses the subscription cases, which
  move to `useRepoChanged.test.tsx`.
- New `src/lib/store/layoutPrefs.ts` (persisted, `git-real.layoutPrefs`):

```ts
interface LayoutPrefsState {
  refsWidth: number; // default 240
  sidebarWidth: number; // default 320
  setRefsWidth(px: number): void;
  setSidebarWidth(px: number): void;
  reset(column: "refs" | "sidebar"): void;
}
```

### 5.3 Layout: `src/app`

- `layout.ts` (pure):

```ts
export const REFS_MIN = 160;
export const SIDEBAR_MIN = 240;
export const DETAIL_MIN = 320;
export const REFS_DEFAULT = 240;
export const SIDEBAR_DEFAULT = 320;
export const KEY_STEP = 16;

/** Widths that fit `container`: the sidebar shrinks first, then the refs column,
 *  each down to its minimum; `container` 0 (unmeasured) returns the inputs unchanged. */
export function clampWidths(
  container: number,
  refs: number,
  sidebar: number,
): { refs: number; sidebar: number };

/** The largest width one column may take while the others keep their minimums. */
export function maxWidth(container: number, column: "refs" | "sidebar", other: number): number;
```

- `RepoPane.tsx`: body grid becomes
  `grid-template-columns: ${refs}px ${sidebar}px 1fr` set inline from the
  clamped widths; a `ResizeObserver` on the body element supplies the
  container width (state, initial 0). Two `SplitHandle`s sit after the refs
  column and after the sidebar. The header's branch line shows `head` from
  `useBranches`: the name, `detached at <7 hex>`, or `<name> (no commits
yet)`; while the query loads it falls back to `tab.summary.headBranch`.
- `src/components/SplitHandle.tsx`:

```ts
interface SplitHandleProps {
  label: string; // "Resize branches column" / "Resize changes column"
  value: number; // current width
  min: number;
  max: number;
  onChange(px: number): void; // already clamped by the handle
  onReset(): void;
}
```

Renders `<div role="separator" aria-orientation="vertical" aria-label
  aria-valuenow aria-valuemin aria-valuemax tabIndex={0}>`. Pointer: on
`pointerdown` records the start x and `setPointerCapture`; `pointermove`
calls `onChange(clamp(value + dx))`; `pointerup`/`pointercancel` releases.
Keyboard: ArrowLeft/ArrowRight ±`KEY_STEP`, Home → `min`, End → `max`.
Double-click → `onReset`. 6px wide hit area, 1px visible line, accent on
hover/focus, `cursor: col-resize`.

### 5.4 Files in `src/features/branches/`

| File                  | Role                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useBranches.ts`      | `useQuery` on `listBranches`, `refetchOnWindowFocus: true`; exposes `branches`, `isLoading`, `error`, `refetch`                                                                                                                                                       |
| `useBranchActions.ts` | one `useMutation` over a `BranchRequest` union (create, rename, delete, checkout, checkoutRemote, deleteRemote); `onSettled` invalidates `queryKeys.repo(repoId)`; exposes the action functions, `pending`, `error`, `clearError`; same shape as `useWorktreeActions` |
| `branchFilter.ts`     | pure `filterBranches(list, query)`: case-insensitive substring on `name` for local and on `remote/name` for remote; empty query returns the input; groups keep order                                                                                                  |
| `BranchRow.tsx`       | one `<li>` with a `<button>`: name, `aria-current="true"` plus bold and accent for HEAD, tracking badge `↑n ↓m` or `gone`, `title` = full ref name                                                                                                                    |
| `BranchGroup.tsx`     | heading (`Local`, or the remote name) and the `<ul aria-label>`; "No matches" when filtered empty, "No branches" when truly empty                                                                                                                                     |
| `BranchesPanel.tsx`   | container: filter input, "New branch…" button, groups, detached row, context menu, dialogs, inline `RepoError`                                                                                                                                                        |
| `*.module.css`        | styles with the existing tokens                                                                                                                                                                                                                                       |

`src/components/PromptDialog.tsx` (shared, next to `ConfirmDialog`):

```ts
interface PromptDialogProps {
  open: boolean;
  title: string;
  label: string; // input label
  initialValue?: string;
  confirmLabel?: string;
  checkbox?: { label: string; checked: boolean; onChange(on: boolean): void };
  error: AppError | null; // shown inline under the input; dialog stays open
  pending: boolean; // disables input, checkbox and confirm; confirm reads "Working…"
  onConfirm(value: string): void;
  onCancel(): void;
}
```

Same focus and Escape handling as `ConfirmDialog` (`useLayoutEffect` focus
on the input, restore on close, no focus trap yet). Confirm is disabled while
`value.trim() === ""`; the text is selected on open so rename overwrites by
default.

### 5.5 Behaviour and copy

- Filter: `<input type="search" aria-label="Filter branches"
placeholder="Filter branches">`; Escape clears it. Filter state is
  component state, keyed per tab by `RepoPane`'s existing `key={tab.id}`.
- Groups in order: Local, then each remote. In Local, a detached HEAD shows
  a non-interactive first row `Detached at <7 hex>` with `aria-current`; an
  unborn HEAD shows `<name> (no commits yet)` the same way.
- Row interactions: click focuses the row; double-click or Enter checks out
  (ignored on the current branch); right-click, Shift+F10 or the ContextMenu
  key opens the menu at the row.
- Context menu, local branch: `Checkout` (disabled on HEAD with no title),
  `Create branch here…`, `Rename…`, `Delete…` (danger; disabled on HEAD).
  Remote branch: `Checkout` (title "Creates a local branch tracking
  `<remote>/<name>`" when no local of that name exists), `Delete on
<remote>…` (danger).
- "New branch…" button in the panel header: `PromptDialog` title `New
branch`, label `Name`, checkbox `Switch to new branch` (default on),
  confirm `Create`. Start point `null` (HEAD). `Create branch here…` uses the
  same dialog with title `New branch from <name>` and start point `<name>`.
  Disabled with title "Make a commit first" when `head.kind === "unborn"`.
- Rename: `PromptDialog` title `Rename <name>`, label `New name`, initial
  value `<name>`, confirm `Rename`.
- Delete local: `ConfirmDialog` title `Delete branch <name>?`, body `The
branch is merged into the current branch.`, confirm `Delete`, danger. On
  confirm, `deleteBranch(name, false)`. If that fails with
  `branchNotMerged`, a second `ConfirmDialog`: title `Force delete <name>?`,
  body `<name> has commits that are not merged into the current branch.
Deleting it loses them unless another ref points at them.`, confirm
  `Force delete`, danger → `deleteBranch(name, true)`.
- Delete remote: `ConfirmDialog` title `Delete <remote>/<name> on
<remote>?`, body `This removes the branch from the remote for everyone.`,
  confirm `Delete on <remote>`, danger.
- While `pending`: panel `aria-busy="true"`, menu items disabled, dialog
  confirm disabled.
- Errors: a `checkoutFailed` or `pushFailed` from a menu action shows as
  `RepoError` at the top of the panel (git's output verbatim, `white-space:
pre-wrap`) with Dismiss; a dialog action's error shows inside the open
  dialog instead, so the user can fix the name. Query errors show the same
  `RepoError` with Retry.
- Success: queries refreshed through `onSettled` and the watcher; the row
  highlight moving and the header line changing are the feedback. No toast.

### 5.6 Tests

- `layout.test.ts`: `clampWidths` shrinks sidebar first then refs, never
  below minimums, passes through when container is 0; `maxWidth` for each
  column.
- `layoutPrefs.test.ts`: defaults, setters, reset, persistence key and
  partialize.
- `SplitHandle.test.tsx`: ARIA attributes, pointer drag changes value with
  clamping, keyboard steps and Home/End, double-click resets, capture
  released on pointerup.
- `useRepoChanged.test.tsx`: subscribes once per repo id, invalidates the
  repo prefix, ignores other repo ids, unsubscribes on unmount, swallows a
  failed subscribe.
- `useBranches.test.tsx`, `useBranchActions.test.tsx`: query and each
  request's call shape, `onSettled` invalidation, error exposure.
- `branchFilter.test.ts`: case-insensitivity, remote prefix match, empty
  query, order preserved.
- `BranchRow.test.tsx`, `BranchGroup.test.tsx`: current marker, tracking
  badges, gone, empty and no-match copy.
- `PromptDialog.test.tsx`: focus and selection on open, Escape, disabled
  confirm on blank, checkbox, inline error, pending.
- `BranchesPanel.test.tsx` (IPC seam mocked): groups render, filter, double
  click and Enter call `checkout_branch`, remote double-click calls
  `checkout_remote_branch`, menu items per row type, create with and
  without checkout and the start point, rename, delete then force-delete
  path on `branchNotMerged`, remote delete confirm, error display in panel
  and in dialog, disabled create on unborn head, detached row.
- `RepoPane.test.tsx`: three columns, live header from the branch query with
  snapshot fallback, handles present, grid style follows clamped widths
  after a resize observation.
- `useStatus.test.tsx`: subscription cases removed.

## 6. Definition of Done

1. `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`,
   `npm test` (100 % coverage), `npm run lint`, `npm run typecheck` green.
2. Architect sign-off on the final branch.
3. Acceptance walk in the running app on a fixture repository with a local
   bare remote: the refs column lists Local and `origin` groups with `main`
   highlighted and `↑0 ↓0`; create `feature` from HEAD with switch on and
   see the header change; make a commit, see `↑1`; double-click `main` to
   switch back; rename `feature` to `topic`; delete `topic` and get the
   force confirmation, force delete; double-click `origin/other` and see a
   tracking local `other` appear; delete `origin/other` on the remote and
   confirm with `git -C bare.git branch`; dirty a tracked file and switch to
   a branch that changes it, see git's refusal inline; type in the filter and
   see groups narrow; drag both handles, shrink the window below the sum of
   the columns and see the detail pane keep its minimum, restart the app and
   see the widths kept.
4. Jira GR-7 transitions to Done with the walk results and any decisions
   worth revisiting in a comment.
