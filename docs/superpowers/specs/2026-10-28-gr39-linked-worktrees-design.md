# GR-39 — Linked worktrees: list, add, open, remove, prune

- Jira: GR-39 "Git worktree management: list, add, open, and remove linked
  worktrees" (story under GR-1).
- Depends on: GR-3 (repo tabs, `open_repo`, recent repos), GR-7
  (`BranchesPanel`, `BranchRow`, `ContextMenu`, `ConfirmDialog`, inline
  error pattern, `validate_branch_name`), GR-11b (`TagsPanel` collapsible
  section header), GR-14/GR-29 (Rust-owned settings, `LayoutSettings`),
  GR-17 (`RefsColumn`, `refsLayout.fitSections`, per-section heights).
- Follows: ADR 0001 (local reads with git2, writes that run hooks or have
  CLI-defined semantics through the git CLI), ADR 0002 (`features/<name>/`
  owns a feature's UI), ADR 0005 (settings live in Rust), the IPC seam
  rule, the 100 % coverage gate.
- Date: 2026-10-28. Shape agreed in chat: a Worktrees section in the left
  refs column that lists every worktree of the repository; double-click
  opens one as a tab; add through a **+** dialog or a branch's context
  menu; remove with confirmation and an explicit force step; prune stale
  entries; branches checked out elsewhere are marked and locked in the
  branch list.

## 1. Goal

The user sees the linked worktrees of the open repository in the left
column, opens any of them as a tab, adds one from an existing or new
branch into a folder they choose, removes one (with a second confirmation
when it has uncommitted changes), and prunes entries whose folder is gone.
A branch checked out in another worktree is shown as such and cannot be
checked out or deleted from the current tab. A tab opened on a linked
worktree has every feature the main checkout has.

### Non-goals (out of scope, per the ticket)

- Several worktrees side by side in one window.
- `git worktree move`, `lock`, `unlock`, `repair`.
- Bare-repository worktree layouts: a bare repository lists no worktrees
  and the section shows "Not available for bare repositories".
- Submodule worktrees.

### Anti-goals

- Deleting a branch when its worktree is removed. Removing a worktree never
  touches refs.
- Silent force. A remove that would discard uncommitted changes always
  needs the second, explicitly worded confirmation.
- Renaming or re-routing the existing working-tree commands. `commands::
worktree`, `features/worktree` and their IPC names keep meaning "the
  working tree"; everything new is namespaced `linked_worktree(s)`.

## 2. Decisions

- **Naming.** Core module `git-real-core/src/linked_worktrees/`, model
  `LinkedWorktree`, Tauri commands `list_linked_worktrees`,
  `add_linked_worktree`, `remove_linked_worktree`, `prune_linked_worktrees`,
  front-end feature folder `src/features/linkedWorktrees/`. The user-facing
  word is just "worktree" ("Worktrees" section, "Add worktree…").
- **Reads with git2, writes with the CLI.** The list, each worktree's HEAD,
  lock state, missing-folder state and the dirty check before a remove use
  git2 (`Repository::worktrees`, `Worktree`, `Repository::open_from_worktree`,
  `statuses`). `add`, `remove` and `prune` run `git worktree …` through
  `git_cli` so hooks (`post-checkout`), lock semantics and refusal messages
  match the command line. Rejected: git2's `Worktree::prune` and
  `Repository::worktree()` (no hooks; different refusal rules).
- **Every worktree, from any tab.** `git_worktree_list` reads the common
  dir, so a tab opened on a linked worktree lists the same set as the main
  tab. The list has the main worktree first (when there is one, see below),
  then linked worktrees sorted by path; `isCurrent` marks the entry whose
  canonical path is the session root.
- **The main row comes from the common dir, not its parent.** Core opens
  `Repository::open(commondir())`: when that repository is not bare, its
  `workdir()` is the main worktree (this also covers `--separate-git-dir`,
  which libgit2 resolves through `core.worktree`). When it is bare (a
  linked worktree of a bare repository), there is no main row and the
  section lists linked worktrees only. A session that is itself bare lists
  nothing and shows the bare message.
- **A missing folder still holds its branch.** git keeps a worktree's HEAD
  in the admin dir (`<commondir>/worktrees/<name>/HEAD`) and refuses
  `switch`, `branch -D` and `worktree add` for that branch until the entry
  is pruned. So `head` of a missing worktree is read from that admin file
  (a `ref: refs/heads/<b>` line or a raw oid), and missing entries take part
  in the checked-out-elsewhere map; `head` is `None` only when the file is
  absent or unparsable.
- **Prune candidates are missing and not locked.** `git worktree prune`
  skips locked entries (a lock's main use is a removable drive), so the
  Prune button, the returned paths and the tabs closed after a prune all use
  `missing && locked.is_none()`.
- **Open = open_repo.** Opening a worktree is the existing `openRepo(path)`
  flow: a new tab, or the existing tab for that path activated; the recent
  list is touched by `register_session` as for any repo. No new command.
- **Dirty check in core, not stderr parsing.** Before a non-force remove,
  core opens the target worktree with git2 and runs a status that includes
  untracked files; any entry means `WorktreeDirty`. The UI turns that into
  the second confirmation. A refusal git still produces (for example a
  change made between the check and the run) is an `OperationFailed` with
  git's text.
- **Locked worktrees are shown, not removed.** `git worktree remove` refuses
  a locked worktree even with `--force` (it needs `--force --force`). The
  row shows a "locked" badge with the reason as `title`; Remove is disabled
  with "Locked: <reason>" (or "Locked" when no reason). Unlocking is out of
  scope.
- **Branch lock via the branch list.** `LocalBranch` gains
  `worktree: string | null`, the canonical path of the linked worktree that
  has the branch checked out (never the current session's own worktree,
  which `isHead` already covers). Core refuses `checkout_branch` and
  `delete_branch` for such a branch with the new `BranchCheckedOut { name,
worktree }` before running git, so the message is the app's and names the
  folder. The menu items are disabled with the same text, so the error is
  only reached from a stale list.
- **Section placement (my call).** `REFS_SECTIONS` becomes
  `branches, stashes, tags, worktrees, pullRequests, issues`. Worktrees is
  resizable and collapsible like Tags (`worktreesCollapsed`,
  `worktreesHeight` in `LayoutSettings`, default collapsed `false`, height
  `null`).
- **Default target folder (my call).** A sibling of the main worktree named
  `<main folder name>-<branch>` with `/` in the branch replaced by `-`,
  computed in the front end from the main entry of the list; a Browse
  button opens `pickFolder` at the main worktree's parent. The field is
  editable.
- **Watcher covers the common dir.** A tab on a linked worktree watches its
  own folder today; refs, `HEAD` of other worktrees and the worktree
  registry live under the main repo's `.git`. `RepoWatcher::start` takes an
  optional second root (the common dir when it is not inside the workdir)
  and the relevance rule treats it as a `.git` dir: `objects/` and `*.lock`
  are ignored, everything else refreshes. A main-worktree tab already sees
  linked worktrees' `HEAD` files under `.git/worktrees/<name>/`.
- **Closing tabs of a removed worktree happens first (my call).** Before
  running a remove (after the user's final confirmation) or a prune, the
  front end closes every open tab whose `summary.path` is a target path
  (via the existing `closeRepoTab`, which drops the session and its
  recursive watcher), then runs the command. On Windows an open directory
  watch can block deleting the folder, so the watcher must be gone before
  git runs. If the command then fails, the tabs stay closed; the worktree
  is still listed and one double-click reopens it. Afterwards the hook
  invalidates the worktree, branch and recent queries. The recent-repos
  entry is left in place; opening it later fails with the existing
  `pathNotFound` flow and its Remove-from-recent control.

## 3. Core (`git-real-core`)

### 3.1 Model — `src/model/linked_worktree.rs`

```rust
pub struct LinkedWorktree {
    pub name: Option<String>,   // git's worktree name (folder under .git/worktrees); None for main
    pub path: PathBuf,          // canonical when the folder exists, else the registered path
    pub head: Option<HeadState>,// None only when HEAD is unreadable (see §3.2 for missing folders)
    pub is_main: bool,
    pub is_current: bool,       // this session's root
    pub missing: bool,          // folder no longer exists (prune candidate)
    pub locked: Option<String>, // Some(reason) when locked; "" when locked without a reason
}

pub enum WorktreeBranch<'a> {
    Existing(&'a str),                           // git worktree add <path> <name>
    New { name: &'a str, start: Option<&'a str> }, // git worktree add -b <name> <path> [<start>]
}

pub struct PrunedWorktrees { pub paths: Vec<PathBuf> }   // entries removed by prune
```

`LinkedWorktree` serializes camelCase like the other models; `head` reuses
`HeadState`. `LocalBranch` gains `pub worktree: Option<PathBuf>` (camelCase
`worktree`, a canonical path string or null).

### 3.2 `src/linked_worktrees/mod.rs` — `impl RepoSession`

| Method                                                           | Backend    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_linked_worktrees() -> Vec<LinkedWorktree>`                 | git2       | Bare session → empty vec. Main entry (§2): `Repository::open(commondir())`; if not bare, its canonical `workdir()` with `head_state` of that repository; if bare, no main row. Then one entry per `repo.worktrees()` name: `find_worktree`, `path()` (canonicalized when it exists), `missing = !path.exists()`, `locked = is_locked()` reason, `head` via `Repository::open_from_worktree` when the folder exists, else parsed from `<commondir>/worktrees/<name>/HEAD` (`ref: refs/heads/<b>` → `Branch`, a 40-hex line → `Detached`, anything else → `None`). A worktree whose `find_worktree` fails is skipped. Sorted by path after the main entry. |
| `add_linked_worktree(path: &Path, branch: WorktreeBranch) -> ()` | CLI        | Validates: `New` name through `validate_branch_name`, then `BranchExists` if a local branch of that name exists; `Existing` name must be a local branch (`BranchNotFound`) and not checked out in any worktree including this one (`BranchCheckedOut`); `start`, when given, must resolve to a commit (`RevisionNotFound`); `path` must not exist, or be an empty directory (`PathExists(path)`). Then `git -C <workdir> worktree add [-b <name>] <path> [<existing>                                                                                                                                                                                     | <start>]`. Non-zero exit → `OperationFailed { verb: "worktree add" }`. |
| `remove_linked_worktree(path: &Path, force: bool) -> ()`         | git2 + CLI | `path` must be a listed linked worktree (`WorktreeNotFound(path)`); main → `CannotRemoveMain`; current session root → `CannotRemoveCurrent`; locked → `WorktreeLocked(reason)`. When `!force` and the folder exists: open it with git2, `statuses` with untracked included and ignored excluded; any entry → `WorktreeDirty(path)`. Then `git -C <workdir> worktree remove [--force] <path>`. A missing folder is removed without `--force` (git only drops the entry). Non-zero → `OperationFailed { verb: "worktree remove" }`.                                                                                                                        |
| `prune_linked_worktrees() -> PrunedWorktrees`                    | git2 + CLI | Collects the paths of entries with `missing && locked.is_none()` (the entries git will prune), runs `git -C <workdir> worktree prune`, returns those paths. Non-zero → `OperationFailed { verb: "worktree prune" }`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `common_dir_outside_workdir() -> Option<PathBuf>`                | git2       | `commondir()` canonicalized when it is not under the session root; None for the main worktree. Used by the app layer's watcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

`list_branches` (refs/mod.rs) fills `LocalBranch.worktree`: for each
worktree other than the current session (the main one included when the
session is a linked worktree; missing ones included, §2) whose HEAD is a
branch, map branch name → path. `checkout_branch`, `checkout_remote_branch`
(when it switches to an existing local branch) and `delete_branch` consult
the same map and fail with `BranchCheckedOut` before touching git. The map
is built by a private `checked_out_elsewhere()` helper shared by the
callers.

CLI calls reuse `git_cli::command` (`LC_ALL=C`, cleared repo env) with
`-C <workdir>`; paths and names are separate argv elements and the target
path is passed as given (absolute, from the dialog). `git worktree remove`
needs git ≥ 2.17 and removing an entry whose folder is gone without
`--force` needs 2.18 (both 2018); the existing CLI probe already reports
the version and no extra gate is added. A clean worktree that contains
submodules is refused by git without force; the app shows git's text as
`operationFailed` and offers no force step for it (submodule worktrees are
out of scope).

### 3.3 Errors — `GitError`

New: `BranchCheckedOut { name: String, worktree: PathBuf }`,
`WorktreeNotFound(PathBuf)`, `WorktreeDirty(PathBuf)`,
`WorktreeLocked(String)`, `CannotRemoveMain`, `CannotRemoveCurrent`,
`PathExists(PathBuf)`. Reused: `BranchExists`, `BranchNotFound`,
`RevisionNotFound`, `InvalidBranchName`, `OperationFailed`. `AppErrorKind`
gains the camelCase twins (`branchCheckedOut`, `worktreeNotFound`,
`worktreeDirty`, `worktreeLocked`, `cannotRemoveMain`,
`cannotRemoveCurrent`, `pathExists`), mapped in `src-tauri/src/error.rs`
and `src/lib/ipc/errors.ts`. `branchCheckedOut`'s message is
"<name> is checked out in worktree <folder>".

## 4. App layer (`src-tauri`)

`src/commands/linked_worktrees.rs`, registered in `lib.rs`, each an
`*_inner` plus an async command using `with_session` + `run_blocking`:

| Command                  | Args                                                                                           | Returns               |
| ------------------------ | ---------------------------------------------------------------------------------------------- | --------------------- |
| `list_linked_worktrees`  | `id`                                                                                           | `LinkedWorktree[]`    |
| `add_linked_worktree`    | `id, path, branch: { kind: "existing", name } \| { kind: "new", name, start: string \| null }` | `void`                |
| `remove_linked_worktree` | `id, path, force`                                                                              | `void`                |
| `prune_linked_worktrees` | `id`                                                                                           | `{ paths: string[] }` |

`ensure_watcher` passes `session.common_dir_outside_workdir()` as the second
root. `RepoWatcher::start(workdir, extra: Option<&Path>, …)` watches both
recursively; `is_relevant(workdir, extra, path)` applies the `.git` rules
(`objects/`, `*.lock` ignored) to paths under `extra`.

`LayoutSettings` and `LayoutPatch` (in `git-real-core/src/settings.rs`)
gain `worktrees_collapsed: bool` (default false) and `worktrees_height:
Option<u32>` (default None), key names `layout.worktreesCollapsed` and
`layout.worktreesHeight`, read/written like `tags_*`.

## 5. Front end

### 5.1 IPC — `src/lib/ipc`

Types `LinkedWorktree`, `WorktreeBranch`, `PrunedWorktrees` and the
`worktree` field on `LocalBranch` in `types.ts`; wrappers
`listLinkedWorktrees`, `addLinkedWorktree`, `removeLinkedWorktree`,
`pruneLinkedWorktrees` in `commands.ts`; the seven new error kinds in
`errors.ts`. Nothing outside `src/lib/ipc` calls `invoke`.

### 5.2 Hooks — `src/features/linkedWorktrees/`

- `useLinkedWorktrees(repoId)`: query for the list, refreshed on
  repo-changed (the common-dir watch makes this fire for every tab of the
  repository).
- `useLinkedWorktreeActions(repoId)`: `add`, `remove`, `prune` mutations in
  the `useBranchActions` shape (`run` never rejects; `pending`, `error`,
  `clearError`). `remove` and `prune` first close the tabs whose path is in
  the target set (§2), then run the command. On success: invalidate
  worktrees, branches, status and recent queries.
- `defaultWorktreePath(mainPath, branch)`: pure helper for the dialog's
  default folder (sibling of the main worktree, `/` → `-`).

### 5.3 `WorktreesPanel` (refs column)

- Header "Worktrees (n)" with the collapse toggle (Tags pattern), a **+**
  button "Add worktree…" and a **Prune** icon button "Prune stale
  worktrees", disabled with `title` "No stale worktrees" when no row is
  missing and unlocked. Both disabled while an action is pending. Bare
  session: body text "Not available for bare repositories", no buttons.
- One row per worktree: folder name (full path as `title`), the branch name
  or "detached at <short oid>" or "no commits yet", a "main" badge, a
  "current" badge for the session's own worktree, a "missing" badge when
  the folder is gone, a "locked" badge with the reason as `title`. Rows are
  `BranchRow`-style `<li>`s: click/arrow keys focus, **double-click or
  Enter opens** the worktree (`useOpenRepo().open(path)`), right-click or
  the context-menu key opens the menu. A missing worktree cannot be opened
  (Open disabled, "Folder not found").
- Context menu: **Open** (disabled for the current one, "Already open in
  this tab"), **Remove…** (danger; disabled for main "The main worktree
  cannot be removed", for current "Close this tab and remove it from
  another worktree", for locked "Locked: <reason>").
- **Remove…** opens `ConfirmDialog`: "Remove worktree <folder>?" / "The
  folder and its contents are deleted. The branch is kept." / confirm
  "Remove". A `worktreeDirty` result reopens the dialog as the force step:
  "<folder> has uncommitted changes" / "Removing it discards them. This
  can't be undone." / confirm "Remove anyway" (danger), which runs with
  `force: true`.
- Inline status area under the header (BranchesPanel pattern) shows the
  last error through the shared error-message mapping; `operationFailed`
  shows git's text.
- The section is replaced by `FileHistoryPanel` with the others while
  history is open.

### 5.4 `AddWorktreeDialog`

Modal form opened by the panel's **+** and by the branch context menu:

- Branch: two radio choices, "Existing branch" with a select of local
  branches not checked out anywhere (the current branch and ones with
  `worktree` set are listed disabled with the reason), and "New branch"
  with a name field validated as the create-branch dialog validates
  (`InvalidBranchName`, `BranchExists` inline).
- Start point (New branch only): "Current HEAD" (default) or "Commit" with a
  text field accepting a ref or short oid (passed through as `start`;
  `revisionNotFound` shown inline).
- Folder: text field prefilled by `defaultWorktreePath` and updated when the
  branch changes until the user edits it; **Browse…** opens `pickFolder`.
  `pathExists` shown inline.
- Cancel / **Add**. Success closes the dialog and opens the new worktree as
  a tab (my call: matching "create and checkout" in the branch dialog).

The branch context menu gains **Create worktree…** on local branches
(disabled with the lock text when the branch is checked out elsewhere;
pre-fills "Existing branch" with that branch) and on remote branches
(pre-fills "New branch" with the branch name and start point
`<remote>/<name>`). Rejected: a separate "worktree from remote" flow; the
dialog's start-point field covers it.

### 5.5 Branch list changes

`BranchRow` shows a badge with the worktree folder name for a local branch
with `worktree` set (`title` "Checked out in worktree <path>"). In
`BranchesPanel`, **Checkout** and **Delete…** are disabled for such a
branch with `title` "Checked out in worktree <folder>"; drag-to-merge is
unaffected (merging a branch checked out elsewhere is allowed).

### 5.6 Refs column and settings

`REFS_SECTIONS` adds `worktrees` after `tags`; `RefsColumn` renders
`WorktreesPanel`, adds the resize handle label and `worktreesHeight`;
`refsLayout` tests cover six sections. Settings store/types gain
`worktreesCollapsed` and `worktreesHeight`; `settingsActions` gains
`setWorktreesCollapsed`.

## 6. Error handling summary

| Situation                                      | Kind                                       | UI                                                                          |
| ---------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Checkout/delete a branch checked out elsewhere | `branchCheckedOut`                         | Menu item disabled with reason; inline error when reached from a stale list |
| Remove a worktree with changes, no force       | `worktreeDirty`                            | Second confirmation "Remove anyway"                                         |
| Remove locked worktree                         | `worktreeLocked`                           | Menu item disabled with reason; inline error fallback                       |
| Remove main / current                          | `cannotRemoveMain` / `cannotRemoveCurrent` | Menu item disabled with reason; inline error fallback                       |
| Remove an entry that vanished                  | `worktreeNotFound`                         | Inline error, list refetched                                                |
| Add into an existing non-empty folder          | `pathExists`                               | Inline in dialog, dialog stays open                                         |
| Add with bad or taken branch name              | `invalidBranchName` / `branchExists`       | Inline in dialog                                                            |
| Add with unknown start point                   | `revisionNotFound`                         | Inline in dialog                                                            |
| git refuses add/remove/prune                   | `operationFailed` (stderr)                 | Inline with git's text                                                      |
| Open a missing worktree                        | —                                          | Open disabled "Folder not found"                                            |

## 7. Testing

Tests are written first by the tester role; the developer never edits them.

- **Core** `crates/git-real-core/tests/linked_worktrees.rs` (temp repos via
  `tests/common`, `git worktree add` through the CLI in fixtures): list
  from main (main first, sorted, heads, `isCurrent`), list from a linked
  worktree (same set, `isCurrent` moves), detached and unborn heads,
  missing folder (`missing`, head parsed from the admin HEAD file for a
  branch and a detached oid, `None` for a corrupt file), locked with and
  without reason, bare session (empty), linked worktree of a bare
  repository (no main row), `--separate-git-dir` main (main row is the
  workdir); add existing branch, add new branch at HEAD and at a
  commit, invalid name, taken name, branch checked out here / elsewhere,
  unknown start, existing non-empty folder, empty folder accepted, argv
  check (`-b` form and plain form, path as one element); remove clean,
  remove dirty without force → `WorktreeDirty` and nothing deleted, with
  force → gone, untracked-only counts as dirty, remove missing folder
  without force, remove main / current / locked refusals, unknown path;
  prune with none / several missing returns their paths and skips a
  locked missing one; `list_branches` `worktree` field for a live and a
  missing worktree, `checkout_branch`, `checkout_remote_branch` and
  `delete_branch` refusals;
  `common_dir_outside_workdir` for main (None) and linked (Some).
- **App layer** `src-tauri/tests/linked_worktree_commands.rs`: each
  `*_inner` wiring, unknown repo, error-kind mapping for the seven new
  kinds; `watcher.rs` tests for the second root and `is_relevant` on paths
  under it; settings round-trip for the two new layout keys.
- **Front end** (Vitest, IPC mocked at `src/lib/ipc`): wrappers, types,
  error kinds and messages; `useLinkedWorktrees` / `useLinkedWorktreeActions`
  (invalidation, tabs closed before remove and prune and left closed on
  failure); `defaultWorktreePath`;
  `WorktreesPanel` (rows and badges, bare message, open on double-click and
  Enter, open disabled for current and missing, menu gating, remove
  confirm, force step on `worktreeDirty`, prune disabled/enabled, inline
  errors, collapse); `AddWorktreeDialog` (branch modes, disabled existing
  branches, start point, default folder tracking and user override, Browse,
  inline errors, submit opens the tab); `BranchRow` badge; `BranchesPanel`
  gating and **Create worktree…** prefill for local and remote;
  `refsLayout` and `RefsColumn` with six sections; settings store.
- **Gate:** `cargo test --workspace`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo fmt --check`, `npm test` with 100 %
  statements/branches/functions/lines, `npm run lint`, `npm run typecheck`,
  final architect approval.
- **Acceptance walk** (running app, WebKit inspector tooling):
  1. Open a repo with no linked worktrees → section shows only the main
     row, marked main and current.
  2. **+** → new branch `wt/demo` at HEAD, default folder → row appears;
     the new worktree opens as a tab; its section lists both rows with
     "current" on the linked one; `main` shows the lock badge in Branches.
  3. In the main tab, Checkout and Delete on `wt/demo` are disabled with
     the reason; Create worktree… on it is disabled too.
  4. Commit in the linked tab → the main tab's branch list updates the
     `wt/demo` tip without a manual refresh (common-dir watch).
  5. Edit a file in the linked worktree, switch to the main tab, Remove… →
     first confirm → second "Remove anyway" step → cancel; nothing removed.
     Repeat and confirm → folder gone, the linked tab closed, branch
     `wt/demo` still listed and now checkoutable.
  6. Add a worktree from the existing branch `wt/demo`, then delete its
     folder in a terminal → row shows "missing" and still names `wt/demo`,
     Open disabled, `wt/demo` still locked in Branches, Prune enabled →
     Prune → row gone, `wt/demo` free.
  7. Lock a worktree in a terminal (`git worktree lock --reason demo`) →
     "locked" badge, Remove disabled with "Locked: demo".
  8. Open a linked worktree from Recent repos on the start screen → opens
     like any repo; status, log, branches, stash and sync all work.

## 8. Left to the builder

- Exact badge styling and icons; follow the existing badge styles in
  `BranchRow.module.css` and the tags panel.
- Which existing dialog component the add dialog is built on (the
  create-branch dialog is the closest model).
- Whether `checked_out_elsewhere()` caches across the three callers inside
  one `list_branches` call or recomputes; correctness first, the list is
  short.
- Test fixture helpers for creating linked worktrees in temp repos.
