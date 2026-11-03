# ADR 0008 — Whole-file diff and partial-line patches

- Status: Accepted
- Date: 2026-11-03
- Epic: GR-1 / Stories: GR-51 "File diff should show entire file", GR-52 "File diff should allow for reverting"
- Follows: ADR 0001 (hybrid git backend), ADR 0004 (budgets)

## Context

The diff pane showed git's hunks: three lines of context around each change, separated by
`@@` headers that carried the Stage, Discard and Unstage buttons. Changed lines were chosen by
clicking their line numbers in the gutter, so the smallest unit of staging was a whole line.
The owner wanted every line of the file shown with the changes in place, two buttons to move
between changes, and staging, unstaging and reverting from a right-click menu that acts on
the line under the pointer or on highlighted text, down to the word.

`apply_hunk` rebuilds the diff in the backend and turns line indices chosen in the viewer into
a patch. That only works while the viewer's diff and the backend's reload have the same shape
line for line, which the old matching three-line context guaranteed.

## Decision

- **D1 — Whole-file context.** `DiffOptions::whole_file()` sets `context_lines` to
  `WHOLE_FILE_CONTEXT = 1 << 30` and lifts the line cap, so libgit2 emits a text file as one
  hunk. The constant stays below `i32::MAX` because libgit2 copies the context into xdiff's
  `long ctxlen`, which is 32 bits on Windows; `u32::MAX` would wrap to -1 there.
  `DiffOptions::default()` keeps three lines of context and its 10,000-line cap, so core
  callers and their tests are unchanged.
- **D2 — Same options on both sides of `apply_hunk`.** The viewer's command builds its options
  from `whole_file()` and applies the caller's whitespace flag and line cap. `apply_hunk`
  reloads with `whole_file()` and whitespace not ignored, so an index chosen in the viewer
  names the same line in the backend. A line index inside a truncated prefix also names the
  same line in the uncapped reload, so a truncated diff no longer disables staging.
- **D3 — A view cap in the command layer.** `DEFAULT_VIEW_LINES = 50_000` in
  `src-tauri/src/commands/worktree.rs` applies when the IPC `maxLines` is absent. "Load full
  diff" still asks for 1,000,000 lines.
- **D4 — Partial-line edits.** `HunkSelection` gains `edits: Vec<LineEdit>`, each an index
  into the hunk's lines and the text that line should read after the action. The field has a
  serde default and is skipped when empty, so the wire shape is backward compatible. A group of
  changed lines is a deletion run and the addition run after it, paired by position as the
  viewer pairs them. A group that holds an edit, or from which the selection takes at least one
  deletion and at least one addition but not every line, is written in two parts. First come
  all of its
  old-side lines as removals, `-<original>`. Then come its new-side lines in pair-slot order
  (deletion k, then addition k) as additions: an edited line as `+<replacement>`, a selected
  addition as itself, and a kept line (an unselected old-side line, context in the patch)
  re-added as `+<original>`. A replacement, or a whole pair picked from the middle of a run,
  so lands where its pair sits among the group's other lines, not ahead of or behind them. A
  group taken whole or not at all keeps hunk order, which yields the same file either way. A
  one-sided pick (only additions, or only deletions) also keeps hunk order, git's usual
  line-staging result: pairing is a display heuristic, and the viewer never sends a one-sided
  pick of a paired run. Hunk counts are
  recomputed from the emitted ops as before. An edit whose index is not a selected changed
  line, a duplicate index, or text holding `\n` or an interior `\r` is `BadSelection`, so a
  request that would add patch lines is refused rather than guessed.
- **D5 — CRLF preserved.** The viewer computes edit text from the Display form of a line, with
  `\r\n` stripped. When the exact line ends in `\r`, the backend appends `\r` to the edit text,
  so a partially staged CRLF line keeps its ending.
- **D6 — Viewer-owned text range.** The diff rows are `user-select: none` and the viewer draws
  its own character-precise range (`useTextRange`). A pointer position becomes a row, side and
  UTF-16 offset through `caretResolver`, which uses `caretRangeFromPoint` and falls back to
  `caretPositionFromPoint`. The tint comes from state, so rows that the virtualizer unmounts
  and remounts during a long drag still show selected. A touch swipe pans the list
  (`touch-action: pan-y`); only a mouse or pen drag makes a range. Double-click selects a word,
  using the same Unicode word class as the edit tokens. In unified
  mode an end row of the other kind is treated as whole for tint, copy and action. Ctrl+C
  copies the highlighted text in every scope.
- **D7 — Edit units shared with the word diff.** `model/edits.ts` pairs the edit units of a
  changed line from the same token LCS that drives the word diff, which is now a projection of
  it. The marks the user sees are the units they can choose. `selectionRequest` turns a range
  into a `HunkSelection`: a unit touched by the range is chosen whole, a fully chosen pair becomes plain line indices,
  and a partly chosen pair becomes one line plus one edit. An unpaired line has one unit per
  token, and a partly chosen one becomes one edit, "chosen only" or "line minus chosen" by
  action and line kind.
- **D8 — Navigation and menu.** Hunk headers and gutter line selection are removed. The toolbar
  has previous and next change buttons with a counter, bound to F7 and Shift+F7 through a
  `diffNavigation` slot in the shell store that the active diff publishes. The right-click menu
  exists only for unstaged and staged diffs.
- **D9 — A row target acts on its line pair.** With no range, the menu targets the row under
  the pointer, "whole row, both sides" in the spec's words. A split row acts on both of its
  cells. A unified row acts on its line and that line's partner: "Revert this line" on a `+`
  line restores the old text, and "Stage this line" on a `-` line stages the replacement with
  it. A unified line with no partner acts alone. The plan had read a unified row as its single
  line; the spec wins.

## Consequences

- A whole-file patch must match the whole file. A diff made stale by an outside edit now always
  fails with `ApplyFailed`, and the file watcher's refetch brings the view back in step.
- The diff payload scales with the file, not with the change: about 5 MB of JSON at the
  50,000-line cap.
- A file over 50,000 lines truncates even for a one-line change. When the loaded prefix holds
  no change, the pane says "The first N lines are unchanged" beside "Load full diff".
- The syntax-highlighting cap of 20,000 lines now counts the whole file, so large files render
  unhighlighted more often.
- There is no keyboard-only text selection or keyboard-opened context menu yet. Whole-file
  staging from the Changes panel stays keyboard reachable.
