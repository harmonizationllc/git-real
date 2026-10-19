# GR-10a — Merge, rebase, cherry-pick, revert and in-progress operations

- Status: Approved in chat on 2026-10-19 (design sections agreed; spec
  written for review)
- Date: 2026-10-19
- Epic: GR-1 / Story: GR-10 "Merge, rebase, and conflict resolution", slice
  **a** of three. GR-10b is the three-way conflict editor; GR-10c is
  interactive rebase and drag-to-merge.
- Depends on: GR-4 (`ChangesPanel`, conflict rows, `index_ops` staging),
  GR-6 (CLI commit path `commit/git_commit.rs`, `CommitBox`, `commitGate`,
  `commitDraft`), GR-7 (`BranchesPanel` menu, `useBranchActions` pattern,
  `refs/switch.rs` CLI runner, `ConfirmDialog`), GR-8 (`GraphPanel` menu,
  `GraphRowData.parents`), GR-5 (`CodeMirror` decision, used by GR-10b)
- Follows: ADR 0001 (hybrid backend: operations that create commits shell
  out to the git CLI; state and index writes are git2), ADR 0002
  (`features/merge/` owns merge, rebase and conflicts)

## 1. Goal

The user can merge or fast-forward a branch into the current one, rebase the
current branch onto another, cherry-pick or revert a commit, see when an
operation is in progress, abort or continue it, resolve each conflicted file
by keeping one side, and finish a merge, cherry-pick or revert from the
commit box, all without a terminal.

### Acceptance criteria covered (from Jira GR-10)

1. Merge via context menu with fast-forward and no-fast-forward options
   (drag-and-drop is GR-10c).
2. Rebase the current branch onto another.
3. Abort and continue for an in-progress merge or rebase. "Resolve all"
   arrives with the editor in GR-10b; this slice resolves per file.
4. Cherry-pick and revert single commits.

Conflicted files are listed (criterion 4) with keep-one-side actions; the
three-way editor is GR-10b.

### Out of scope

- The three-way editor, Resolve All (GR-10b); interactive rebase, dragging
  a branch onto another (GR-10c).
- Cherry-pick or revert of a merge commit (needs a mainline choice): the
  menu item is disabled with a hint and the core refuses.
- Multi-commit cherry-pick or revert, ranges, `--autostash`, squash merges,
  merge strategies, `rebase --onto` with three arguments.
- Editing the merge message before a clean (non-conflicting) merge: git's
  default message is used (`--no-edit`).
- Any new event: the watcher's `repo-changed` already covers the `.git`
  marker files.

## 2. Decisions

- **Every operation shells out to the git CLI**, as GR-6 decided for
  commits: `merge`, `rebase`, `cherry-pick`, `revert`, their `--abort` and
  `rebase --continue`. Hooks (`pre-merge-commit`, `post-merge`,
  `pre-rebase`, `post-rewrite`, `commit-msg`), `rerere`, merge drivers,
  `merge.conflictStyle` and signing then behave exactly as on the command
  line. Rejected: git2's `merge`/`rebase` API, which runs no hooks and would
  mean reimplementing conflict-marker writing.
- **git never waits for an editor.** Merge and revert pass `--no-edit`;
  rebase and `rebase --continue` run with `GIT_EDITOR=true` in the
  environment. Cherry-pick opens no editor without `-e`.
- **A non-zero exit is classified afterwards.** If git2 then reports a
  repository state other than `Clean` AND the index has conflicts, the
  operation stopped on conflicts and the result is the `conflicts` outcome.
  Every other non-zero exit failed and the error carries git's output: a
  dirty working tree or bad ref (state stays `Clean`), or a `pre-merge-commit`
  hook refusal or an empty cherry-pick (git leaves the operation in progress
  with no conflicts; the banner then shows it and the user commits or
  aborts). The front end refetches the operation state after that error.
- **In-progress state comes from git2 plus the `.git` marker files**
  (`MERGE_HEAD`, `MERGE_MSG`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
  `rebase-merge/`, `rebase-apply/`). No subprocess, no text parsing of
  `git status`. Rejected: `git status --porcelain=v2`.
- **Keeping one side of a conflict is a git2 index write**, like GR-4
  staging: the chosen stage's blob replaces the working-tree file and the
  path is added, which clears the conflict entries. A side that deleted the
  file removes it.
- **Merge, cherry-pick and revert finish through the commit box.** git
  itself completes those operations on `git commit`, so the existing CLI
  commit path needs no change: the box prefills git's prepared message and
  its button names the operation. Only rebase gets a real Continue, because
  `git rebase --continue` is the only way to resume the sequence.
- **Ours and theirs are shown with names, never as "ours"/"theirs"** in
  the menu: during a rebase git's "ours" is the branch being rebased onto,
  which surprises everyone. Labels come from the operation state.
- **Fast-forward possibility is checked on demand** when a branch's menu
  opens, not for every branch on every list refresh.

## 3. Rust domain: `git-real-core`

### 3.1 Modules

```
crates/git-real-core/src/
  model/merge.rs       # MergeMode, OperationState, OperationOutcome, ConflictSide, FastForwardCheck
  merge/
    mod.rs             # impl RepoSession { operation_state, merge_branch, rebase_onto, cherry_pick,
                       #   revert_commit, abort_operation, continue_rebase, resolve_conflicts,
                       #   can_fast_forward }
    git_ops.rs         # the CLI runner: run(git, workdir, verb, args, env) -> Result<Output>
    state.rs           # reading the marker files into OperationState
    resolve.rs         # keep-one-side index/worktree write
  error.rs             # five new variants (3.4)
  lib.rs               # re-exports
```

### 3.2 Types (`model/merge.rs`, all serde camelCase)

```rust
pub enum MergeMode { Merge, FastForward }        // "merge" | "fastForward"

#[serde(tag = "kind")]
pub enum OperationState {
    None,
    /// `MERGE_HEAD` present.
    Merge { head: String, branch: Option<String>, message: CommitMessage },
    /// `rebase-merge/` or `rebase-apply/` present.
    Rebase { onto: String, onto_name: Option<String>, branch: Option<String>, step: u32, total: u32 },
    CherryPick { oid: String, message: CommitMessage },
    Revert { oid: String, message: CommitMessage },
}

pub enum OperationOutcome { Completed, Conflicts }   // "completed" | "conflicts"
pub enum ConflictSide { Ours, Theirs }               // "ours" | "theirs"
pub enum FastForwardCheck { Possible, UpToDate, Diverged }
```

`CommitMessage` is the GR-6 type (`subject`, `body`), produced by the
existing `commit/message.rs` parser from the prepared message file.
`branch`, `onto_name` are resolved by matching the oid against local branch
tips first, then remote-tracking tips (`remote/name`); `None` when nothing
matches (the UI falls back to the short oid).

### 3.3 Behaviour

- **`operation_state()`**: `repo.state()` picks the variant; `Clean` →
  `None`. Merge: first line of `MERGE_HEAD` is `head`; `MERGE_MSG` parsed
  (missing file → empty message). Rebase: `rebase-merge/` is read first
  (`onto`, `head-name` stripped of `refs/heads/`, `msgnum`, `end`), else
  `rebase-apply/` (`onto`, `head-name`, `next`, `last`); an unreadable or
  unparsable file yields `None`/`0` for that field, never an error.
  Cherry-pick and revert read `CHERRY_PICK_HEAD`/`REVERT_HEAD` and
  `MERGE_MSG`. `RebaseInteractive` and `RebaseMerge` states map to `Rebase`
  too; `ApplyMailbox`, `Bisect` and `ApplyMailboxOrRebase` map to `None`
  (this slice never starts them, and there is nothing to abort).
- **Preconditions shared by `merge_branch`, `rebase_onto`, `cherry_pick`,
  `revert_commit`**: `repo.state() != Clean` → `OperationInProgress`; unborn
  HEAD → `UnbornHead`. Then run the CLI with `-C <workdir>`:
  - `merge_branch(branch, mode)`: branch resolved via `find_branch(Local)`
    then `find_branch(Remote)` → `BranchNotFound`. `Merge` →
    `merge --no-ff --no-edit <branch>`; `FastForward` → `merge --ff-only
<branch>`.
  - `rebase_onto(onto)`: same branch resolution; `rebase <onto>` with
    `GIT_EDITOR=true`.
  - `cherry_pick(oid)` / `revert_commit(oid)`: `find_commit` →
    `CommitNotFound`; `parent_count() > 1` → `MergeCommit(oid)`. Then
    `cherry-pick <oid>` / `revert --no-edit <oid>`.
  - Exit 0 → `Completed`. Non-zero, `repo.state() != Clean` and
    `fresh_index().has_conflicts()` → `Conflicts`. Any other non-zero →
    `OperationFailed { verb, code, stdout, stderr }` (the operation may
    still be in progress, e.g. after a hook refusal).
- **`abort_operation()`**: by state, `merge --abort`, `rebase --abort`,
  `cherry-pick --abort`, `revert --abort`; `Clean` → `NoOperation`. Non-zero
  → `OperationFailed`.
- **`continue_rebase()`**: state not a rebase → `NoOperation`;
  `index.has_conflicts()` → `UnresolvedConflicts`; `rebase --continue` with
  `GIT_EDITOR=true`; outcome classified as above (the next step may
  conflict).
- **`resolve_conflicts(paths, side)`**: index loaded once. Per path, the
  conflict entry (`index.conflicts()` matched by path on any stage) →
  `PathNotFound` when absent. Chosen stage (`our` for `Ours`, `their` for
  `Theirs`): present → blob written to `<workdir>/<path>` (parents created,
  mode from the entry, executable bit honoured), then `index.add_path`;
  absent → file removed if it exists, then `index.remove_path`. Index
  written once at the end; every path is validated and its conflict entry
  located before anything is written, and an I/O error mid-way leaves the
  index untouched (files already written stay on disk; the status refetch
  shows the truth). Paths go through the GR-4 `index_ops::normalise_all` check (no `..`, no
  absolute paths) before any write.
- **`can_fast_forward(branch)`**: branch resolved as above; unborn HEAD →
  `UnbornHead`; `tip == head` or `tip` already an ancestor of `head` → `UpToDate`;
  `graph_descendant_of(tip, head)` → `Possible`; else `Diverged`.
- `git_ops::run` mirrors `refs/switch.rs`: `git_cli::locate()`, `-C
<workdir>`, captured output, environment variables applied with
  `Command::env`, no stdin.

### 3.4 Errors

```rust
OperationFailed { verb: String, code: Option<i32>, stdout: String, stderr: String },
OperationInProgress,          // "another operation is in progress"
NoOperation,                  // "no merge, rebase, cherry-pick or revert is in progress"
UnresolvedConflicts,          // "resolve all conflicts first"
MergeCommit(String),          // "{0} is a merge commit; choosing a parent is not supported yet"
```

### 3.5 Tests (`crates/git-real-core/tests/merge.rs`)

Fixtures build on `common::merge_fixture`, `temp_repo_with_conflict`,
`branch_with_commit`, `configure_identity`, `install_hook`, `fake_git`.

- `operation_state`: clean → `None`; after a conflicting `git merge` →
  `Merge` with resolved branch name and parsed message; after a conflicting
  rebase → `Rebase` with onto name, branch, `step`/`total`; cherry-pick and
  revert states; unreadable marker fields degrade to `None`/`0`.
- `merge_branch`: `Merge` creates a merge commit with two parents even when
  ff is possible; `FastForward` moves HEAD without a new commit;
  `FastForward` on diverged branches → `OperationFailed` with git's stderr
  and `Clean` state; conflicting merge → `Conflicts` and status shows the
  path conflicted; unknown branch → `BranchNotFound`; remote-tracking
  branch accepted; second operation while one is in progress →
  `OperationInProgress`; unborn → `UnbornHead`; `pre-merge-commit` hook
  that exits 1 → `OperationFailed`; dirty file that would be overwritten →
  `OperationFailed` with `Clean` state.
- `rebase_onto`: clean rebase rewrites commits onto the target; conflict →
  `Conflicts`; `continue_rebase` with conflicts left → `UnresolvedConflicts`;
  after `resolve_conflicts` → `Completed` and the rebased branch has the
  expected tips; a second conflicting step → `Conflicts` again; no editor
  is spawned (`GIT_EDITOR` asserted through `fake_git` capturing the
  environment); `continue_rebase` when clean → `NoOperation`.
- `cherry_pick` / `revert_commit`: clean cases create one commit with the
  expected tree; conflict cases → `Conflicts` with the right state; merge
  commit → `MergeCommit`; bad oid → `CommitNotFound`.
- `abort_operation`: each of the four states returns to the pre-operation
  HEAD and a clean tree; `Clean` → `NoOperation`.
- `resolve_conflicts`: `Ours` and `Theirs` on a both-modified file write the
  right content and stage it; a side that deleted the file removes it from
  the tree and index; an executable file keeps its mode; an unconflicted
  path → `PathNotFound`; two paths in one call; a path outside the repo
  rejected.
- `can_fast_forward`: `Possible`, `UpToDate`, `Diverged`, `BranchNotFound`,
  `UnbornHead`.
- `git_ops`: argv and environment per verb through `fake_git`; missing git
  → `GitCliMissing`.

## 4. Tauri app layer (`src-tauri/src`)

- `commands/merge.rs`, each with an `_inner` on `RepoRegistry` and a
  `run_blocking` wrapper registered in `lib.rs`:
  `get_operation_state(id) -> OperationState`,
  `merge_branch(id, branch, mode) -> OperationOutcome`,
  `rebase_onto(id, onto) -> OperationOutcome`,
  `cherry_pick(id, oid) -> OperationOutcome`,
  `revert_commit(id, oid) -> OperationOutcome`,
  `abort_operation(id)`,
  `continue_rebase(id) -> OperationOutcome`,
  `resolve_conflicts(id, paths: Vec<String>, side) -> ()`,
  `can_fast_forward(id, branch) -> FastForwardCheck`.
- `error.rs`: `AppErrorKind::{OperationFailed, OperationInProgress,
NoOperation, UnresolvedConflicts, MergeCommit}`; `OperationFailed`'s
  message uses `cli_failure_message(verb, …)`.
- The session mutex is held for the whole CLI run, as for commit and
  switch; the UI shows pending state meanwhile.
- Tests in `src-tauri/tests/merge_commands.rs`: each command round trip on
  a fixture, the tagged `OperationState` JSON shape (`{"kind":"merge",…}`,
  `{"kind":"none"}`), each new kind's mapping, unknown repo id.

## 5. Front end

### 5.1 IPC seam (`src/lib/ipc`)

- `types.ts`: `MergeMode`, `OperationState` (discriminated on `kind`),
  `OperationOutcome`, `ConflictSide`, `FastForwardCheck`; `AppErrorKind`
  gains the five kinds.
- `errors.ts`: the five kinds in `KINDS`.
- `commands.ts`: `getOperationState`, `mergeBranch`, `rebaseOnto`,
  `cherryPick`, `revertCommit`, `abortOperation`, `continueRebase`,
  `resolveConflicts`, `canFastForward`.

### 5.2 Keys and store

- `queryKeys.operation(id) = ["repo", id, "operation"]` and
  `queryKeys.fastForward(id, branch) = ["repo", id, "fastForward", branch]`,
  both under the repo prefix so `repo-changed` invalidates them.
- `commitDraft` gains `replace(repoId, message: CommitMessage)`: sets
  subject and body, turns amend off (restoring nothing; the prepared
  message wins), and records `prefilled: CommitMessage | null` on the draft
  so a later clean-up can tell "untouched prefill" from the user's text.

### 5.3 Merge feature files (`src/features/merge/`)

```
useOperationState.ts    # useQuery(operation key); refetch on repo-changed only (staleTime: Infinity)
useCanFastForward.ts    # useQuery(fastForward key, enabled when a branch is given); staleTime 0
useIntegrationActions.ts# useMutation over a request union; `run` resolves with AppError | null,
                        #   onSettled invalidates the repo prefix (useBranchActions pattern)
operationCopy.ts        # pure: bannerTitle(state, head, conflicts), sideLabels(state, head),
                        #   commitButtonLabel(state), menu titles
OperationBanner.tsx     # the in-progress strip with Abort… and Continue / Go to commit
OperationBanner.module.css
```

Request union: `merge {branch}`, `fastForward {branch}`, `rebase {onto}`,
`cherryPick {oid}`, `revert {oid}`, `abort`, `continue`, `resolve {paths,
side}`.

`OperationBanner({ repoId })`: renders nothing while the state is loading or
`none`. Reads `useBranches` for the HEAD name and `useStatus` for the
conflict count. Title per 5.6. Buttons:

- `Abort…` (danger) opens a `ConfirmDialog` ("Abort merge?" / "Abort
  rebase?" …, body per 5.6, confirm `Abort`); on confirm runs `abort`.
- Rebase: `Continue`, disabled while conflicts remain (title `Resolve all
conflicts first`) or while pending; runs `continue`.
- Merge, cherry-pick, revert: `Go to commit`, disabled while conflicts
  remain; focuses the commit subject input (`#commit-subject`).
- A failed action shows `RepoError` inside the banner with Dismiss.

### 5.4 Changes to existing features

- **`BranchesPanel` menu** (local and remote rows that are not HEAD),
  after `Checkout`: `Merge <b> into <cur>`, `Fast-forward <cur> to <b>`,
  `Rebase <cur> onto <b>`. `<b>` is `name` or `remote/name`; `<cur>` is the
  HEAD branch. All three disabled when an action is pending, HEAD is
  detached or unborn (title `Check out a branch first`), or an operation is
  in progress (title `Finish or abort the current operation first`). The
  fast-forward item is additionally driven by `useCanFastForward` for the
  menu's target: loading → disabled, title `Checking…`; `upToDate` →
  disabled, `Already up to date`; `diverged` → disabled, `<cur> and <b>
have diverged`. Failures show in the panel's existing `RepoError` slot.
  The `conflicts` outcome is not an error: the banner and the Conflicts
  section appear through the invalidation.
- **`GraphPanel` menu**, after `Reset to this commit…`: `Cherry-pick
commit` and `Revert commit`. Disabled when pending, operation in progress
  (same title), or `row.parents.length > 1` (title `Merge commits are not
supported yet`). Cherry-pick is also disabled for the commit HEAD points
  at (`Already on this commit`).
- **`ChangesPanel` conflict rows**: menu becomes `Keep <ours>`, `Take
<theirs>`, `Mark resolved (stage)`, with labels from `sideLabels`: merge
  → HEAD branch / merged branch; rebase → onto name / rebased branch;
  cherry-pick and revert → HEAD branch / short oid; no operation (for
  example a conflict left by a stash) → `ours` / `theirs`. Multi-selection
  targets as the other actions. `useIntegrationActions.run({ resolve })`
  and its error land in the panel's existing error slot.
- **`RepoPane`**: `OperationBanner` rendered between the header and the
  three-column body.
- **`CommitBox`**: the subject input gets `id="commit-subject"`. A new
  `useOperationPrefill(repoId)` hook (in `features/commit/`) watches
  `useOperationState`: on a transition into merge, cherry-pick or revert it
  calls `replace(repoId, message)`; on a transition out (abort, or finish
  from elsewhere) it clears the draft only if it still equals `prefilled`.
  The button label comes from `commitButtonLabel`: `Commit and merge`,
  `Commit and cherry-pick`, `Commit and revert`, else the existing labels.
  The amend checkbox is disabled during any operation (title `Not available
during a <merge|rebase|cherry-pick|revert>`).
- **`commitGate`** takes `operation: OperationState | undefined` after
  `status`: a rebase → `Use Continue in the banner to resume the rebase`
  (placed after the loading check and before the identity check). The
  existing `Resolve conflicts before committing` rule stays. During a merge
  the `Stage changes to commit` rule is skipped: keeping "ours" on every
  conflict leaves the index equal to HEAD, and `git commit` with
  `MERGE_HEAD` records the merge commit anyway. Cherry-pick and revert keep
  the rule because git refuses an empty commit.

### 5.5 Wiring

`useOperationState` is read by `OperationBanner`, `BranchesPanel`,
`GraphPanel`, `ChangesPanel` and `CommitBox`; one query, shared through the
cache. Nothing new in `workspace`.

### 5.6 Copy (verbatim)

Banner titles: `Merging <b> into <cur>`, `Rebasing <cur> onto <onto>, step
<n> of <m>`, `Cherry-picking <7 hex>`, `Reverting <7 hex>`; suffix `, <k>
conflict(s) remaining` when `k > 0`, else `, no conflicts remaining`.
Abort dialog: title `Abort <merge|rebase|cherry-pick|revert>?`, body `The
working tree and index return to their state before the operation started.
Resolved conflicts are lost.`, confirm `Abort`.
Buttons: `Abort…`, `Continue`, `Go to commit`, `Dismiss`.
Menu items: `Merge <b> into <cur>`, `Fast-forward <cur> to <b>`, `Rebase
<cur> onto <b>`, `Cherry-pick commit`, `Revert commit`, `Keep <ours>`,
`Take <theirs>`, `Mark resolved (stage)`.
Titles: `Check out a branch first`, `Finish or abort the current operation
first`, `Checking…`, `Already up to date`, `<cur> and <b> have diverged`,
`Merge commits are not supported yet`, `Already on this commit`, `Resolve
all conflicts first`, `Not available during a <op>`.
Gate reason: `Use Continue in the banner to resume the rebase`.

### 5.7 Tests

- `operationCopy.test.ts`: every title, label and side-label branch,
  including the `None` fallback and short-oid fallbacks.
- `useOperationState`, `useCanFastForward` (enabled flag, key),
  `useIntegrationActions` (each request's wrapper call, error resolution,
  invalidation on success and failure).
- `OperationBanner.test.tsx`: hidden for `none`/loading; each state's
  title and conflict suffix; Abort dialog open, cancel, confirm; Continue
  gating and call; Go to commit focuses the input; error with Dismiss.
- `BranchesPanel.test.tsx`: the three items for local and remote rows,
  every disabled reason, fast-forward check states, success and failure
  paths, `conflicts` outcome shows no error.
- `GraphPanel.test.tsx`: cherry-pick and revert items, merge-commit and
  HEAD gating, calls and errors.
- `ChangesPanel.test.tsx`: conflict menu labels per operation state, keep
  and take calls with multi-selection, error display.
- `CommitBox.test.tsx` + `useOperationPrefill.test.tsx`: prefill on
  transition, no overwrite of user text, clean-up on abort only when
  untouched, labels, amend disabled; `commitGate.test.ts`: the rebase
  reason and its position.
- `commitDraft.test.ts`: `replace` and `prefilled`.
- `RepoPane.test.tsx`: banner placement. `keys.test.ts`, `types.test.ts`,
  `errors.test.ts`, `commands.test.ts`: the new keys, types, kinds and
  wrappers.

## 6. Definition of Done

1. `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`,
   `cargo fmt --check`, `npm test` (100 % coverage), `npm run lint`,
   `npm run typecheck` green.
2. Architect sign-off on the final branch.
3. Acceptance walk in the running app on a fixture with `main` and
   `feature` branches that both edit `shared.txt` plus a `fast` branch one
   commit ahead of `main`: fast-forward `main` to `fast` moves HEAD with no
   new commit; merging `feature` shows the banner with one conflict and the
   file under Conflicts; `Keep main` and `Take feature` write the expected
   content; the commit box reads `Commit and merge` with git's message and
   committing clears the banner and shows the merge commit in the graph;
   rebasing a diverged branch stops with the banner's step counter,
   Continue is disabled until the file is resolved and then completes the
   rebase; cherry-pick and revert from the graph create the expected
   commits; Abort restores the previous HEAD and a clean tree; a merge
   commit's cherry-pick item is disabled.
4. Jira GR-10 gets a comment describing slice a as done with the walk
   results and follow-ups; the story stays open for GR-10b and GR-10c.
