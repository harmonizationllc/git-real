# GR-10c — Interactive rebase and drag-to-merge

- Jira: GR-10 "Merge, rebase, and conflict resolution", slice **c** of three,
  the last. GR-10a (merged d65d920) shipped the operations, the in-progress
  banner and keep-one-side resolution; GR-10b (merged b3da33b) the inline
  conflict editor and Resolve all. After this slice the story moves to Done.
- Depends on: GR-10a (`merge/` core module, `git_ops::run`, `outcome`,
  `state::read_state`, `useIntegrationActions`, `OperationBanner`,
  `operationCopy`, the merge items in `BranchesPanel`), GR-8 (`GraphPanel`
  commit menu, `GraphRowData.parents`), GR-7 (`BranchRow`, `ContextMenu`,
  `ConfirmDialog` / `PromptDialog` patterns).
- Follows: ADR 0001 (operations that create commits shell out to the git
  CLI), ADR 0002 (`features/merge/` owns merge and rebase), the IPC seam
  rule, the 100 % coverage gate.
- Date: 2026-10-20. Design approved in chat (modal dialog; the current branch
  row is the only drop target).

## 1. Goal

The user can rewrite the commits of the current branch in a dialog — reorder,
squash, fixup, edit and drop — started from a commit in the graph or from a
branch to rebase onto, and can merge, fast-forward or rebase by dragging a
branch onto the current branch. Both close the last two GR-10 acceptance
criteria: "Merge a branch into the current branch via drag-and-drop" and
"Interactive rebase UI: reorder, squash, edit, drop commits".

### Out of scope

- Reword (git opens an editor per reworded commit; follow-up).
- `--rebase-merges`: a range holding a merge commit is refused with a hint,
  like cherry-pick of a merge commit in GR-10a.
- `exec` lines, `--autosquash`, `--autostash`, `break`, label/reset/merge
  todo commands, `--onto` with three arguments.
- Dropping onto any row other than the current branch, dropping onto graph
  ref labels, dragging commits.
- Editing the stopped commit's message: an `edit` stop is finished by
  staging changes and pressing Continue; git amends them into that commit.

## 2. Backend (git-real-core)

Verified in a spike (git 2.43): `GIT_SEQUENCE_EDITOR="cp '<file>'"` makes
`git rebase -i` take a prepared todo; an `edit` stop exits 0 and leaves
`rebase-merge/amend` and `stopped-sha`; `git rebase --continue` with staged
changes amends them into the stopped commit; `squash` with `GIT_EDITOR=true`
keeps both messages joined by a blank line and `fixup` keeps the first.

### 2.1 Model (`model/merge.rs`)

```rust
/// One line of an interactive rebase todo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RebaseAction { Pick, Squash, Fixup, Edit, Drop }

/// A commit the interactive rebase would replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub oid: String,          // full hex
    pub subject: String,      // first line of the message, as `message::split`
    pub author: Signature,    // the existing model Signature (name, email, time)
}

/// One entry of the user's plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep { pub action: RebaseAction, pub oid: String }
```

`OperationOutcome` gains `Stopped`: exit 0 while the repository is still in a
rebase, which is what an `edit` stop produces. `OperationState::Rebase` gains
`stopped_for_edit: bool`, true when `rebase-merge/amend` exists (the
`rebase-apply/` layout has no such marker; false there).

### 2.2 Plan (`merge/interactive.rs`)

```rust
impl RepoSession {
    /// The commits `git rebase -i base` would replay, oldest first.
    pub fn rebase_plan(&self, base: &str) -> Result<Vec<RebaseCommit>, GitError>;
    /// Runs `git rebase -i base` with `steps` as the todo.
    pub fn rebase_interactive(&self, base: &str, steps: &[RebaseStep])
        -> Result<OperationOutcome, GitError>;
}
```

`rebase_plan` checks, in this order: `ensure_clean` (`OperationInProgress`),
`ensure_born` (`UnbornHead`), `base` resolves — exactly 40 hex characters go
through `revision::resolve_commit` (`CommitNotFound`), anything else through
`resolve_branch` (local, else `remote/name`; `BranchNotFound`, which already
refuses a leading `-` so no user text reaches git's argv as an option) —
base is a strict ancestor of HEAD via `graph_descendant_of(head, base)` and
`base != head` (`BadSelection`), then a revwalk of `base..HEAD` in
topological + reverse order. Any commit in the range with more than one
parent is `MergeCommit(hex)`. The oid git is given is the resolved full hex,
never the user's text.

`rebase_interactive` re-runs `rebase_plan(base)` and validates `steps`
against it: every step oid is in the plan and no oid appears twice
(`BadSelection`); at least one step is not `Drop` (`BadSelection`); the
first non-`Drop` step is not `Squash` or `Fixup` (`BadSelection`, matching
git's "cannot 'squash' without a previous commit"). A step may omit plan
commits (git's `rebase.missingCommitsCheck` defaults to ignore) — the dialog
never does, but the core does not require it.

It then writes the todo to a fresh file under `std::env::temp_dir()` named
`git-real-rebase-<pid>-<nanos>.todo`, one line per step:
`<action> <full oid> <subject with control characters replaced by spaces>`
(git ignores everything after the oid; the subject is for `git status`
output and `rebase-merge/done`). It runs
`git_ops::run(git, workdir, "rebase", ["-i", &base_hex], env)` with env
`GIT_SEQUENCE_EDITOR=cp '<file>'` (single quotes, any `'` in the path
escaped as `'\''`) and `GIT_EDITOR=true`, deletes the file whether or not
git succeeded, and classifies the output:

- exit 0 and state `Clean` → `Completed`
- exit 0 and state a rebase → `Stopped`
- non-zero, state a rebase, index has conflicts → `Conflicts`
- anything else → `OperationFailed { verb: "rebase", … }` (as `outcome`).

`outcome` in `merge/mod.rs` gains the `Stopped` arm so `rebase_onto` and
`continue_rebase` also report it when a later `edit` step stops the rebase.
`abort_operation` and `continue_rebase` already cover `RebaseInteractive`.

### 2.3 State (`merge/state.rs`)

`read_rebase` sets `stopped_for_edit: dir.join("amend").exists()` only for
the `rebase-merge` layout.

### App layer

`src-tauri/src/commands/merge.rs`: `rebase_plan_inner(reg, id, base)`,
`rebase_interactive_inner(reg, id, base, steps)` and the two
`#[tauri::command]`s `rebase_plan(id, base: String) -> Vec<RebaseCommit>` and
`rebase_interactive(id, base: String, steps: Vec<RebaseStep>) ->
OperationOutcome`, registered in `lib.rs`. `AppError` needs no new kind.

## 3. IPC (`src/lib/ipc`)

```ts
export type RebaseAction = "pick" | "squash" | "fixup" | "edit" | "drop";
export interface RebaseCommit {
  oid: string;
  subject: string;
  author: Signature;
}
export interface RebaseStep {
  action: RebaseAction;
  oid: string;
}
export type OperationOutcome = "completed" | "conflicts" | "stopped";
// OperationState rebase variant gains `stoppedForEdit: boolean`.

export function rebasePlan(id: RepoId, base: string): Promise<RebaseCommit[]>;
export function rebaseInteractive(
  id: RepoId,
  base: string,
  steps: RebaseStep[],
): Promise<OperationOutcome>;
```

Both call `invoke("rebase_plan", { id, base })` and
`invoke("rebase_interactive", { id, base, steps })`. `queryKeys.rebasePlan(id,
base)` = `["repo", id, "rebasePlan", base]`, under the repo prefix so a
repository change refetches an open dialog's plan.

## 4. Front end

### 4.1 Files

- `src/features/merge/rebase/RebaseDialog.tsx` (+ `.module.css`, test) — the
  modal.
- `src/features/merge/rebase/RebaseStepRow.tsx` (+ `.module.css`, test) — one
  commit row.
- `src/features/merge/rebase/model/plan.ts` (+ test) — pure plan state:
  reorder, set action, validation, summary.
- `src/features/merge/rebase/useRebasePlan.ts` (+ test) — the plan query.
- `src/features/merge/useIntegrationActions.ts` — `rebaseInteractive` request.
- `src/features/merge/operationCopy.ts` — banner suffix for an edit stop.
- `src/features/graph/GraphPanel.tsx`, `src/features/branches/BranchesPanel.tsx`
  — entry points; `BranchesPanel.tsx` + `BranchRow.tsx` (+ css) — drag-to-merge.

### 4.2 Plan state (`model/plan.ts`)

```ts
export interface PlanStep {
  oid: string;
  subject: string;
  author: Signature;
  action: RebaseAction;
}
export const ACTIONS: { action: RebaseAction; label: string; hint: string }[]; // §5 order
export function initialPlan(commits: RebaseCommit[]): PlanStep[]; // newest first, all "pick"
export function move(steps: PlanStep[], from: number, to: number): PlanStep[];
export function setAction(steps: PlanStep[], index: number, action: RebaseAction): PlanStep[];
/** Why a step cannot take squash/fixup: it is the oldest kept commit. */
export function foldBlocked(steps: PlanStep[], index: number): boolean;
export function summary(steps: PlanStep[]): { kept: number; squashed: number; dropped: number };
export function toSteps(steps: PlanStep[]): RebaseStep[]; // oldest first, for the IPC
export function canStart(steps: PlanStep[]): boolean; // kept > 0 and no blocked fold
```

The dialog lists newest first, like the graph; `toSteps` reverses to git's
order. `foldBlocked` is true for the _last_ step in dialog order whose
action is not `drop`, when its action is squash or fixup — moving or dropping
can create this state, so it is validated rather than prevented, and the
row shows the hint. `summary.kept` counts steps that are not dropped and
not folded; `squashed` counts squash + fixup; a plan with a blocked fold or
nothing kept disables Start rebase.

### 4.3 Plan query (`useRebasePlan.ts`)

`useRebasePlan(repoId, base): { commits: RebaseCommit[] | undefined; error: AppError | null; loading: boolean }`
over `queryKeys.rebasePlan`, `retry: false`, `toAppError` mapping, enabled
only while the dialog is open (the dialog mounts the hook, so mount = open).

### 4.4 Dialog (`RebaseDialog.tsx`)

```ts
export interface RebaseDialogProps {
  repoId: RepoId;
  /** Full oid or branch name git is given; `label` is what the title shows. */
  base: string;
  label: string;
  onClose(): void;
}
```

Rendered by the panel that opened it only while open (`dialog !== null`),
so state resets per opening, like `PromptDialog`. A `role="dialog"`
`aria-modal` box with the same backdrop, Escape and focus-restore behaviour
as `ConfirmDialog` (copy the layout-effect pattern; do not share internals).
Title: `Rebase {head} onto {label} interactively`. Body states:

- loading: `Loading commits…` (`role="status"`).
- plan error: `RepoError` with Close only.
- empty plan (`[]`, happens when the base is HEAD's parent chain with no
  commits): `Nothing to rebase: {head} has no commits after {label}.`
- plan: `<ol aria-label="Commits to rebase">` of `RebaseStepRow`, a footer
  line `{kept} commits, {squashed} squashed, {dropped} dropped` (singular
  forms per §5), `RepoError` for a run error, buttons Cancel and
  `Start rebase` (disabled while `!canStart || pending`; reads `Working…`
  while pending like `ConfirmDialog`).

The plan is seeded from the query data once (`useState(() => initialPlan)`
inside an inner component keyed by the data, as `EditableConflict` is keyed
in GR-10b) and edited locally; a refetch that changes the commit list
remounts the inner component and resets the plan. Start calls
`integration.run({ action: "rebaseInteractive", base, steps: toSteps(plan) })`
through the opener's `useIntegrationActions` (passed as `run`/`pending`
props, so the panel's `pending` gate and error handling stay single-sourced
— the dialog shows the error itself, the panel does not). On `null` error
the dialog closes; every outcome (completed, conflicts, stopped) closes it,
because the banner and status carry the rest.

### 4.5 Row (`RebaseStepRow.tsx`)

```ts
export interface RebaseStepRowProps {
  step: PlanStep;
  index: number;
  count: number;
  blocked: boolean; // foldBlocked
  onAction(action: RebaseAction): void;
  onMove(to: number): void; // Move up = index-1, Move down = index+1
  onDragStart(): void;
  onDragOver(): void;
  onDrop(): void;
  dragging: boolean;
  dropTarget: boolean;
}
```

Layout: a drag handle (`⋮⋮`, `aria-hidden`), a `<select aria-label="Action for {short}">`
with the five actions (option titles carry the hints), `<code>` short oid,
subject (ellipsised, title = full subject), author name, `Move up` /
`Move down` icon buttons (`aria-label`, disabled at the ends or while
pending). A dropped row is dimmed and struck through; a squash/fixup row is
indented to show it folds into the row above; a blocked row shows
`Cannot squash the oldest commit` under the select (`role="alert"`). The
`<li>` is `draggable` and handles `dragstart`/`dragover`
(`preventDefault`)/`drop`; the dialog keeps the dragged index in state and
calls `move(from, to)` on drop. Keyboard users have the buttons.

### 4.6 Entry points

- `GraphPanel` commit menu, after `Revert commit`: `Rebase interactively from
here…` → `setDialog({ kind: "rebase", oid: row.oid })`, which renders
  `<RebaseDialog base={oid} label={shortOid(oid)}>`. Disabled with `title`:
  `IN_PROGRESS_TITLE` during an operation; `Check out a branch first` when
  HEAD is detached or unborn (`branches?.head.kind !== "branch"`); `Already
at HEAD` for the row whose refs include `isHead`. Ancestry is not known in
  the front end: a commit that is not an ancestor comes back as
  `badSelection` and the dialog shows it (§5 maps the message).
- `BranchesPanel` menu, after `Rebase {cur} onto {b}`: `Rebase {cur} onto
{b} interactively…` with the same `gateTitle`, opening
  `<RebaseDialog base={b} label={b}>`.

### 4.7 Drag-to-merge (`BranchRow.tsx`, `BranchesPanel.tsx`)

`BranchRowProps` gains:

```ts
drag?: {
  /** This row can be picked up. */
  draggable: boolean;
  /** This row is the drop target; `over` while a branch hovers it. */
  target: boolean; over: boolean;
  onDragStart(): void; onDragEnd(): void;
  onDragEnter(): void; onDragLeave(): void;
  onDrop(x: number, y: number): void;
}
```

The `<li>` gets `draggable={drag.draggable}` and the handlers; `dragover` on
the target calls `preventDefault` and sets `dropEffect = "move"`; `dragstart`
sets `effectAllowed = "move"` and `setData("text/plain", branchId)` so WebKit
starts the drag (the panel keeps the dragged target in state and ignores
`dataTransfer` on drop — the same-window state is the source of truth).
Visuals: the dragged row at 50 % opacity; the target row with an inset
`--color-accent` outline while `over`.

In `BranchesPanel`: `const [dragging, setDragging] = useState<BranchTarget | null>(null)`
and `[over, setOver]`. A row is draggable when it is not the current branch,
HEAD is on a branch, no operation is in progress and nothing is pending; the
current branch's row is the target when `dragging !== null`. `onDrop(x, y)`
opens the existing menu: `setMenu({ x, y, target: dragging })` — the same
`integrationItems` (Merge, Fast-forward, Rebase) plus nothing else; the
`menuBranch`/`useCanFastForward` wiring already keys off `menu.target`, so
the fast-forward gate works unchanged. `dragend` clears both states. A drop
on anything else is ignored by the browser (no `preventDefault`).

### 4.8 Banner and copy

`operationTitle` for a rebase appends `, stopped to edit` when
`stoppedForEdit` (before the conflict suffix, which then reads `, no
conflicts remaining`; with conflicts both show, since both are true).
`useIntegrationActions` adds
`{ action: "rebaseInteractive"; base: string; steps: RebaseStep[] }` →
`rebaseInteractive(repoId, base, steps)`.

## 5. Copy strings (verbatim)

```
Rebase interactively from here…
Rebase {cur} onto {b} interactively…
Already at HEAD | Check out a branch first
Rebase {head} onto {label} interactively
Loading commits…
Nothing to rebase: {head} has no commits after {label}.
Commits to rebase
Action for {short}
Pick — keep the commit | Squash — fold into the commit above, keep both messages |
Fixup — fold into the commit above, discard its message |
Edit — stop after applying it to amend | Drop — leave the commit out
Cannot squash the oldest commit
Move up | Move down
{n} commits, {m} squashed, {k} dropped   (1 commit | 1 squashed | 1 dropped)
Cancel | Start rebase | Working…
, stopped to edit
badSelection in the dialog: That commit is not on {head}.
mergeCommit in the dialog: The range contains a merge commit, which cannot be rebased interactively yet.
```

Other errors show their own message through `RepoError`.

## 6. Testing

- Rust (`crates/git-real-core/tests/merge.rs`): plan order and fields on a
  three-commit branch; plan errors for each precondition (in progress,
  unborn, unknown oid base, unknown branch base, `-` prefixed base, base not
  an ancestor, base == HEAD, merge commit in range); interactive run with reorder + squash +
  drop produces the expected log and messages; fixup keeps the first
  message; an `edit` step yields `Stopped`, state `stoppedForEdit: true`,
  step/total, and `continue_rebase` after staging a change amends it;
  conflicts outcome from a reordered conflicting pair; step validation
  errors (unknown oid, duplicate oid, all dropped, leading squash/fixup)
  leave the repository clean and the temp file deleted; a failing git
  (fake `git` script) still deletes the file. App layer in
  `src-tauri/tests/merge_commands.rs`.
- Front end: `plan.ts` headless (move bounds, fold rule, summary, toSteps
  order); `useRebasePlan`; `RebaseStepRow` (select, buttons, blocked alert,
  drag events via `fireEvent.dragStart/dragOver/drop`, which happy-dom
  supports); `RebaseDialog` (states, keyed reset on refetch, Start payload
  oldest-first, closes on every outcome, error stays open); `GraphPanel` and
  `BranchesPanel` menu items and gates; drag-to-merge (draggable flags,
  highlight, drop opens the menu with the three items, dragend clears,
  gating during an operation and detached HEAD). Coverage stays at 100 %.
- Acceptance walk on a fixture with four commits on `feature` over `main`:
  open from the graph, reorder by button and by drag, squash + drop + edit,
  Start → banner shows "stopped to edit", stage a change, Continue, verify
  the log; a conflicting reorder lands in the conflict editor; drag `main`
  onto `feature` and merge from the drop menu; a remote branch drag.

## 7. Follow-ups

- Reword with an inline message editor (needs a `GIT_EDITOR` helper or
  `exec git commit --amend -F`).
- `--rebase-merges` for ranges with merge commits.
- Drop targets on graph ref labels and on non-current branches (checkout
  first).
- Amend in the commit box during an `edit` stop, for message changes.
