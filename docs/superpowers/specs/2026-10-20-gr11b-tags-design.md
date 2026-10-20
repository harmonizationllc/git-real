# GR-11b — Tags

- Jira: GR-11 "Stash and tag management", slice **b** of two (the last).
  GR-11a (stash) is merged (d410b89 plus follow-up merges up to c4b14bc).
  After this slice the story moves to Done.
- Depends on: GR-7 (`BranchesPanel` filter, `ContextMenu`, `ConfirmDialog`,
  `remote/push_delete.rs` prepare-then-run pattern, `validate_branch_name`),
  GR-6 (CLI commit with the message on stdin), GR-8 (`GraphPanel` commit
  menu, ref labels), GR-9 (`selectCommit`), GR-11a (`StashesPanel` layout and
  feedback pattern, crate-private `git_ops.rs`, `useRestoreFocus`,
  `data-focus-target` + `src/styles/focusTargets.test.ts`).
- Follows: ADR 0001 / CLAUDE.md hybrid rule (signing and network → git CLI;
  local reads and ref writes → git2), ADR 0002, the IPC seam rule, the 100 %
  coverage gate.
- Date: 2026-10-20. Design approved in chat section by section.

## 1. Goal

The user can create lightweight and annotated tags on any commit, see local
tags in a collapsible Tags section of the left column (filtered together with
branches), jump to a tag's commit, delete a local tag, and push a tag to or
delete it from any configured remote. Tags already show in the commit graph;
this slice keeps that working for every tag the user creates or deletes.
This closes the last three GR-11 acceptance criteria.

### Out of scope (follow-ups)

- Fetch, and any knowledge of tags that exist only on a remote (user choice
  A: act on local tags only; no `ls-remote`).
- Push all tags (`--tags`), force-moving an existing tag, renaming a tag.
- Verifying tag signatures; showing a tag's full annotation beyond the
  subject tooltip.

## 2. Decisions

- **Remote knowledge: local tags only** (user choice A). Push and remote
  delete are single CLI calls on demand; git's output reports the result.
- **One menu item per remote** (user choice): "Push to ‹remote›" and
  "Delete from ‹remote›…" for every configured remote; with none, the items
  are disabled with "No remotes configured".
- **Create dialog: explicit Annotated toggle** (user choice), on by default;
  Message is shown and required only while it is on.
- **Tags section: collapsible + shared filter** (user choice). Starts
  collapsed; collapsed state is remembered app-wide; the existing branch
  filter filters tags too.
- **Backends.** Create runs the git CLI (`tag.gpgSign` may sign annotated
  tags; signing is CLI-only). List and local delete use git2 (local read /
  ref write, as branch delete does). Push and remote delete run the CLI after
  the session lock is released (prepare-then-run, as `PushDelete`).
- **Refspecs.** Push sends `refs/tags/<name>`; remote delete sends
  `--delete tags/<name>`, which must match a tag the remote advertises: it
  can never hit a branch, and a missing remote tag fails ("remote ref does
  not exist") instead of reporting success.

## 3. Core (`git-real-core`)

### 3.1 Model — `src/model/tag.rs`

```rust
pub struct TagEntry {
    pub name: String,            // short name, without refs/tags/
    pub target: String,          // full hex of the commit the tag peels to
    pub annotated: bool,
    pub subject: Option<String>, // first line of an annotated tag's message
    pub time: i64,               // tagger time (annotated) or commit time (lightweight), epoch seconds
}

pub struct TagList {
    pub tags: Vec<TagEntry>,     // newest first by `time`, then name ascending
    pub remotes: Vec<String>,    // every configured remote, from repo.remotes(), sorted
}
```

Serialized camelCase like the other models. A tag that does not peel to a
commit (tree or blob) is skipped, matching the graph.

### 3.2 `src/refs/tags.rs` — `impl RepoSession`

| Method                                                     | Backend | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tags() -> TagList`                                   | git2    | As §3.1; no tags → empty `tags`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `create_tag(name, oid, message: Option<&str>) -> ()`       | CLI     | Validates `name` with git's ref-name rules for `refs/tags/<name>` and refuses a leading `-` (`InvalidTagName`); existing `refs/tags/<name>` → `TagExists`; `oid` must resolve to a commit (`CommitNotFound`); `Some(msg)` with only whitespace → `EmptyMessage`. Annotated: `git -C <wd> tag -a --cleanup=whitespace -F - <name> <oid>` with the message on stdin. Lightweight: `git -C <wd> tag <name> <oid>`. Non-zero exit (signing failure, missing identity) → `OperationFailed { verb: "tag", .. }` with stderr. |
| `delete_tag(name) -> ()`                                   | git2    | Missing → `TagNotFound`; otherwise `repo.tag_delete(name)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `prepare_tag_push(remote, name) -> TagPush`                | git2    | Remote must exist and not start with `-` (`RemoteNotFound`); tag must exist locally (`TagNotFound`).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `prepare_remote_tag_delete(remote, name) -> TagPushDelete` | git2    | Same validation (the local tag must exist; choice A).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The oid passed to git is the resolved full hex. The tag name is validated
before it reaches argv, so no `--` separator is needed (git's `tag` does not
document one); argv tests pin the exact shape.

### 3.3 `src/remote/push_tag.rs`

`TagPush::run()` → `git -C <wd> push <remote> refs/tags/<name>`;
`TagPushDelete::run()` → `git -C <wd> push <remote> --delete tags/<name>`.
Both use `git_cli::command` (no terminal prompt, `LC_ALL=C`, cleared repo
env). Non-zero exit → `PushFailed { code, stdout, stderr }`. Constructors
are `pub(crate)` so only the `prepare_*` methods build them.

### 3.4 Errors

New `GitError` variants `InvalidTagName(String)`, `TagExists(String)`,
`TagNotFound(String)`; `AppErrorKind` gains `invalidTagName`, `tagExists`,
`tagNotFound`, mapped in `src-tauri/src/error.rs`. Reused: `CommitNotFound`,
`EmptyMessage`, `OperationFailed`, `RemoteNotFound`, `PushFailed`.

## 4. App layer (`src-tauri`)

`src/commands/tags.rs`, registered in `lib.rs`; `*_inner` + async command
via `with_session` / `run_blocking`:

| Command             | Args                                     | Returns   |
| ------------------- | ---------------------------------------- | --------- |
| `list_tags`         | `id`                                     | `TagList` |
| `create_tag`        | `id, name, oid, message: string \| null` | `void`    |
| `delete_tag`        | `id, name`                               | `void`    |
| `push_tag`          | `id, remote, name`                       | `void`    |
| `delete_remote_tag` | `id, remote, name`                       | `void`    |

`push_tag` / `delete_remote_tag` prepare inside `with_session` and run after
it returns, like `delete_remote_branch_inner`. The watcher already reports
`refs/tags` and `packed-refs` changes.

## 5. Front end

### 5.1 IPC and query

Types `TagEntry`, `TagList`; wrappers `listTags`, `createTag`, `deleteTag`,
`pushTag`, `deleteRemoteTag`; error kinds `invalidTagName`, `tagExists`,
`tagNotFound`; query key `tags(id)` and mutation key `tag(id)`.

### 5.2 Shared filter

The branch filter text moves from `BranchesPanel` local state to the
workspace store: `refsFilter: Record<RepoId, string>` with
`setRefsFilter(repoId, text)`, forgotten by `clear(repoId)`. The input stays
in `BranchesPanel`, labelled **"Filter branches and tags"** (placeholder
unchanged in style). Tags match by the same case-insensitive substring rule
as `filterBranches` (a `filterTags` helper beside it).

### 5.3 `features/tags/`

- `useTags(repoId)`: query, refreshed on repo-changed.
- `useTagActions(repoId)`: `create`, `remove`, `push`, `deleteRemote`;
  shared busy via the `tag(id)` mutation key; create/remove invalidate tags
  and log; push/deleteRemote invalidate tags. Exposes `pending`, `error`,
  and the last push `status` (`{ kind: "pushed" | "deletedRemote", name,
remote }`).
- `TagsPanel.tsx` (left column, below `StashesPanel`; replaced by
  `FileHistoryPanel` like the others):
  - Header: a toggle button "Tags (n)" (`aria-expanded`), or "Tags (m of
    n)" while the filter has text; a **+** "Create tag…" (tags HEAD;
    disabled "Make a commit first" on an unborn HEAD). The header heading
    carries `data-focus-target` and `tabIndex={-1}` (focus fallback).
  - Collapsed by default; `layoutPrefs.tagsCollapsed` (persisted, app-wide).
    While the filter has text the list is shown regardless.
  - Empty: "No tags"; filter with no hits: "No matches".
  - Status line: "Pushed ‹name› to ‹remote›." / "Deleted ‹name› from
    ‹remote›."; errors via `TagFeedback` (same pattern as `StashFeedback`):
    `pushFailed` shows git's output; `tagNotFound` → "Tag ‹name› no longer
    exists; the list has been refreshed."; others via the shared mapping.
- `TagRow.tsx`: button with the name, short target oid, and an "annotated"
  marker (`title` = subject when present); click selects the target commit
  (`selectCommit`). Right-click / Shift+F10 / ContextMenu key opens
  `ContextMenu` (fallback = panel heading) with:
  **Copy name**, **Push to ‹remote›** (each remote), **Delete from
  ‹remote›…** (each remote), **Delete tag…**. With no remotes the remote
  items appear once each as **Push to remote** / **Delete from remote…**,
  disabled with title "No remotes configured".
- `CreateTagDialog.tsx`: title "Create tag on ‹short oid›"; **Name** input;
  **Annotated** checkbox (checked by default); **Message** textarea shown
  only while annotated; Cancel / **Create** (disabled until the name is
  non-blank and, when annotated, the message is non-blank). Inline errors:
  `invalidTagName` → "‹name› is not a valid tag name."; `tagExists` → "A tag
  named ‹name› already exists."; `commitNotFound` → "That commit no longer
  exists."; `emptyMessage` → "Enter a message for an annotated tag.";
  `operationFailed` → git's text. Uses `useRestoreFocus` and the GR-11a
  dialog focus rules (dialog focused while pending, first invalid field
  after an inline error).
- Confirms (`ConfirmDialog`): **Delete tag…** → "Delete tag ‹name›?" / "The
  tag is removed from this repository only." / "Delete";
  **Delete from ‹remote›…** → "Delete tag ‹name› from ‹remote›?" / "Others
  who already fetched it keep their copy." / "Delete".

### 5.4 Graph

`GraphPanel`'s commit menu gains **"Create tag here…"** directly after
"Create branch here…", opening `CreateTagDialog` for that commit.

### 5.5 Layout

`RepoPane` refs column: `BranchesPanel`, `StashesPanel`, `TagsPanel`.

## 6. Error handling summary

| Situation                                                    | Kind              | UI                                   |
| ------------------------------------------------------------ | ----------------- | ------------------------------------ |
| Invalid name / leading `-`                                   | `invalidTagName`  | Dialog inline                        |
| Name taken                                                   | `tagExists`       | Dialog inline                        |
| Commit gone                                                  | `commitNotFound`  | Dialog inline                        |
| Blank annotated message                                      | `emptyMessage`    | Dialog inline (normally prevented)   |
| Signing / identity / other git failure on create             | `operationFailed` | Dialog inline, git's text            |
| Tag vanished before delete/push                              | `tagNotFound`     | Panel message + refetch              |
| Unknown remote / leading `-`                                 | `remoteNotFound`  | Panel message                        |
| Push rejected / exists / offline / auth / remote tag missing | `pushFailed`      | Panel message, git's output          |
| Unborn HEAD                                                  | —                 | **+** disabled "Make a commit first" |

## 7. Testing

Tests are written first by the tester role; the developer never edits them.

- **Core** `crates/git-real-core/tests/tags.rs` (temp repos; a local bare
  repo as the remote, so no real network): list empty / mixed / newest-first
  order / name tiebreak / tag of a tree skipped / remotes listed when a
  remote has no branches; create lightweight, annotated with a multi-line
  message (stored verbatim after whitespace cleanup), invalid name, leading
  `-`, existing name, unknown oid, blank message, signing honoured
  (`tag.gpgSign=true` with `gpg.program` set to a failing script →
  `OperationFailed` carrying its stderr); delete success / missing; push
  success (bare repo has the tag), push of a tag the remote has at a
  different commit → `PushFailed`, remote delete success, remote delete of a
  tag the remote lacks → `PushFailed`, remote delete never removes a remote
  branch with the same name, unknown remote / leading `-` → `RemoteNotFound`.
- **Argv** in `tests/cli_argv.rs`: annotated create (`tag -a
--cleanup=whitespace -F - <name> <oid>`, message on stdin), lightweight
  create, push `refs/tags/<name>`, delete `--delete tags/<name>`.
- **App** `src-tauri/tests/tag_commands.rs`: wiring, unknown repo, error
  mapping for the three new kinds.
- **Front end** (Vitest, IPC mocked at `src/lib/ipc`): wrappers, types,
  keys, error kinds; `filterTags`; workspace `refsFilter`; `useTags`,
  `useTagActions`; `TagsPanel` (collapse + persistence, auto-open while
  filtering, counts, rows, empty states, menu per remote and with none,
  confirms, push status, errors, refetch on `tagNotFound`); `TagRow`
  keyboard and selection; `CreateTagDialog` (checkbox toggles Message,
  disabled Create, inline errors, focus); `BranchesPanel` filter label and
  shared query; GraphPanel "Create tag here…"; `RepoPane` column order;
  `focusTargets` guard includes `TagsPanel`.
- **Gate:** `cargo test --workspace`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo fmt --check`, `npm test` at 100 %
  statements/branches/functions/lines, `npm run lint`, `npm run typecheck`,
  `npx prettier --check .`, final architect approval.
- **Acceptance walk** (running app; fixture with a local bare repo as
  `origin`):
  1. "Create tag here…" on an older commit, annotated → graph label and a
     Tags row (annotated marker, subject tooltip).
  2. **+** → lightweight tag on HEAD.
  3. Type in the filter → branches and tags both narrow; collapsed Tags
     opens while filtering and shows "m of n".
  4. Push to origin → status line; `git ls-remote --tags` on the bare repo
     lists the tag.
  5. Delete from origin… → confirm → gone from the bare repo.
  6. Delete tag… → confirm → row and graph label gone.
  7. Duplicate name in the dialog → inline "A tag named … already exists."
  8. Move a tag locally (delete + recreate elsewhere), push again → git's
     rejection shown in the panel.
