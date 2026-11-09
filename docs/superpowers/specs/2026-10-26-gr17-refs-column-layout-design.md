# GR-17: Refs column layout and readable graph ref labels — design

**Ticket:** GR-17 "Refs column layout and readable graph ref labels" (Story,
Backlog; found during the GR-11b acceptance walk at 1280×800).
**Builds on:** GR-7 (refs column, `SplitHandle`, persisted widths), GR-11
(stashes, tags, `RepoError variant="panel"`), GR-13 (pull requests and issues
panels), ADR 0005 (settings owned by Rust, `settings.json` is the only store).
**Status:** written from the ticket without a brainstorming round (the owner
skipped the questions on 2026-10-26); every choice below marked _(my call)_ is
the author's and is open to the owner's review. Plan in
`docs/superpowers/plans/2026-10-26-gr17-refs-column-layout.md`.

## 1. Intent

Three findings from one walk, all about space:

- **A.** The left column (Branches, Stashes, Tags, and since GR-13 also Pull
  requests and Issues) splits its height by fixed caps: every section but
  Branches is `max-height: 40%`. Two open sections leave Tags two rows; an
  empty Stashes section still takes ~100 px; Branches keeps a blank gap.
- **C.** Graph ref pills shrink together under a flex cap, so a commit with
  `main`, `origin/main` and `v0.2` shows "m…", "o…", "v…" in a narrow centre.
- **D.** Three error boxes still use the full-size `RepoError` layout in a
  narrow pane: `TagsPanel` copy error, `ChangesPanel` status error and
  `ChangesPanel` action error.

Success is the ticket's acceptance criteria, restated in §2.

## 2. Goals, non-goals, anti-goals

**Goals (the acceptance criteria):**

1. Branches, Stashes, Tags, Pull requests and Issues share the column by
   content: an empty or collapsed section takes only what it shows, and no
   section keeps a large blank gap while another is cramped.
2. Each section boundary is draggable and keyboard-steppable, with the chosen
   height persisted in the layout preferences, resettable by double-click
   _(my call: the ticket says "consider"; included because collapse toggles
   alone give no control over Stashes or Branches)_.
3. Ref labels stay readable when a commit has several refs: the first labels
   in full, then a `+N` chip for the rest. Every truncated label keeps its
   full name as its hover title and its accessible name.
4. The three error boxes in D use `variant="panel"`.
5. The branch filter, the Tags collapse and the graph context menus keep
   working as before (pinned by the existing tests and the walk in §7).

**Non-goals:** virtualising any refs list; a resizable Issues boundary (it is
the last section, nothing sits below it); changing the file-history mode of
the column (`FileHistoryPanel` still replaces the whole column); the two list
error alerts (Branches, Tags) that deliberately keep the default layout.

**Anti-goals:** a section that shows blank space inside itself beyond its
content, except Branches, which keeps the column's leftover as today; a
settings shape change that an older `settings.json` cannot load (new leaves
must default); any new dependency.

## 3. The column (A)

### 3.1 Model

`src/app/refsLayout.ts` (pure, tested with numbers, no DOM):

- `REFS_SECTIONS = ["branches", "stashes", "tags", "worktrees", "pullRequests", "issues"]`
  in column order; `RefsSection` is their union and `ResizableSection`
  excludes `"issues"`.
- `SECTION_MIN = 72` px: the least an expanded section with content keeps
  (one header plus about two rows) _(my call)_.
- `sectionFloor(natural) = natural` when `natural ≤ SECTION_WHOLE_MAX = 144`,
  else `SECTION_MIN`: a section short enough to show whole is shown whole
  _(amended 2026-11-02 after the GR-31 walk: a one-row Worktrees section at
  92 px lost its row to the 72 px floor)_. 144 is the 40 px header plus two
  rows of the tallest row kind (stash and worktree rows are 52 px), so a
  section of up to two rows of anything is never clipped; a taller section
  may still be squeezed to `SECTION_MIN`, which the owner confirmed on
  2026-11-02 as the accepted trade-off against measuring row heights.
- `fitSections(container, sections)` where each section is
  `{ natural, fixed }` (`natural` = the measured height of its content,
  `fixed` = the stored height or `null` for automatic) returns one height per
  section:
  1. `pref = fixed === null ? natural : max(floor, fixed)`: a stored height
     is a true height for every open section; a collapsed section's stored
     height is ignored (the component passes `fixed = null`) _(amended
     2026-11-09: the owner asked for any open section to be pulled open past
     its content)_.
  2. If `Σ pref ≤ container`: Branches, when automatic, takes the leftover;
     otherwise the leftover stays at the end of the column.
  3. Otherwise the overflow is taken first from the stored sections' blank
     space (`pref − natural`, where positive), then from the automatic
     sections in proportion to their room (`pref − floor`), then, if room runs
     out, from the stored sections' room in the same way _(amended
     2026-11-09: a stored Local height was clipping Worktrees to show blank
     space)_. Sections at their floor stay there;
     if the floors alone exceed the container the column scrolls. Heights
     are returned as whole pixels; when the shares fill the container, the
     rounding remainder goes to the last automatic section that is sharing
     (above its floor and shrunk below its content), else to Branches when
     it is automatic and above its floor, else it stays unassigned. A
     section shown whole never gains or loses the pixel, and the column's
     inline heights otherwise sum exactly to its container _(GR-31, review
     minor on independent rounding; recipient narrowed at the GR-31 final
     review)_.
  4. `container ≤ 0` (unmeasured) passes the naturals through, as
     `clampWidths` does for widths.
  5. `resizeSection(container, sections, absorber, index, px)` returns the
     stored height of every section after dragging `index` to `px`: the
     dragged section stores `px`, and every other stored section that the new
     fit would shrink below `max(floor, fixed)` is unpinned (`null`), so the
     dragged height holds; the rest are kept _(amended 2026-11-09: dragging
     Remote with a stored Local height handed most of each pixel back to
     Local)_.
- `maxSectionHeight(container, sections, index)` =
  `container − Σ floor(others)`; `Infinity` while unmeasured.

### 3.2 Component

`src/app/RefsColumn.tsx` replaces the fragment `RepoPane` renders in the
refs column when no file history is open. It renders, in order, each panel
inside a `section` wrapper (`overflow: auto`, inline `height` from
`fitSections` once measured) and, between consecutive sections, a horizontal
`SplitHandle` that sizes the section above it:

| Handle label                   | Sizes         | Stored as                   |
| ------------------------------ | ------------- | --------------------------- |
| `Resize Branches section`      | Branches      | `layout.branchesHeight`     |
| `Resize Stashes section`       | Stashes       | `layout.stashesHeight`      |
| `Resize Tags section`          | Tags          | `layout.tagsHeight`         |
| `Resize Pull requests section` | Pull requests | `layout.pullRequestsHeight` |

Handle contract: `value` is the rendered height, rounded to whole pixels;
`min` is the section's floor; `max` is `maxSectionHeight` for every open
section and the content height for a collapsed one, so a collapsed handle
refuses to move instead of storing a height that is ignored _(amended
2026-11-09)_; `step` is `KEY_STEP` (16); ArrowDown and
ArrowUp move it; double-click resets the stored height to `null`. A change
that leaves the rendered height where it is, or that arrives before the
column is measured, stores nothing (ruled at the final review on
2026-10-26).

Measurement: one `ResizeObserver` per `RefsColumn` observes the column root
(container = its content height minus one `SPLIT_HANDLE_WIDTH` track per
handle actually rendered) and each section's content wrapper (its natural
height). Entries whose target is unknown are ignored. Until the root and
every wrapper have reported at least once, no inline heights are set and the
wrappers fall back to `flex: 0 1 auto; min-height: 0`, so a test without
layout renders every section. A wrapper may report zero: the Pull requests
and Issues panels render nothing for a repository without a hosting
account, and such a section takes 0 px and renders no handle of its own
(ruled during execution on 2026-10-26; the first draft required every
height to be above zero, which never happened on a local-only repository).

Panels lose their own sizing rules (`flex`, `max-height: 40%`, `min-height`,
`overflow`, `border-top`): the wrapper scrolls and the handle draws the
divider. `BranchesPanel` keeps its flex column for its toolbar and list but
no longer takes `flex: 1`.

### 3.3 Settings

Rust `LayoutSettings` gains `branches_height`, `stashes_height`,
`tags_height`, `pull_requests_height: Option<u32>` (camelCase on the wire,
default `None`). `normalise` clamps a present value to at least
`SECTION_HEIGHT_MIN = 72` with the usual warning (`layout.tagsHeight` …).
`LayoutPatch` carries them as `Option<Option<u32>>` through `double_option`,
so a present `null` clears back to automatic. The shared fixture
`src/lib/store/settingsDefaults.json`, `Settings.layout` in
`src/lib/ipc/types.ts` and `DEFAULT_SETTINGS` gain the four `null` leaves.
`setSectionHeight(section: ResizableSection, height: number | null)` in
`settingsActions.ts` rounds and saves through `setPref` like `setRefsWidth`.

## 4. Ref labels (C)

`RefLabels` keeps showing at most `MAX_LABELS` (3) pills and a `+N` pill for
the rest, and now also hides trailing candidates that do not fit beside the
subject:

- Pills never shrink (`flex: none`), are capped at `24ch` with an ellipsis
  and keep `title={name}`; the DOM text is the full name, so the accessible
  name is the full name.
- `fitLabels(widths, gap, budget, moreWidth, total = widths.length)` in
  `src/features/graph/model/refLabelFit.ts` returns how many candidates
  show: the largest `k ≥ 1` such that the first `k` widths with `k − 1` gaps
  fit the budget when `k` is every ref (`k === total`), or with the `+N`
  pill and `k` gaps otherwise. At least one pill always shows. (`total` was
  added during execution on 2026-10-26: with more refs than `MAX_LABELS`
  the `+N` pill is rendered even when every candidate fits, so its width
  must be budgeted then too.)
- The component observes its parent flex cell with a `ResizeObserver` and
  measures the rendered pills by `offsetWidth`; the budget is the cell's
  width minus `SUBJECT_RESERVE_PX = 64` (the 8ch the CSS reserved) minus the
  cell gap. The `+N` pill's width is its measured width when rendered, else
  `MORE_PILL_PX = 36`. While the cell or any pill measures zero (no layout,
  as in tests) every candidate shows. Candidates beyond `k` are kept in the
  DOM as `visibility: hidden; position: absolute` so they stay measurable and
  out of the accessibility tree; the root is `position: relative` so an
  out-of-flow pill can never widen the graph list (ruled during execution).
- The `+N` pill gets `aria-label` of `N more: name, name` and keeps its
  newline-joined `title`.

## 5. Error boxes (D)

`TagsPanel` copy error, `ChangesPanel` status error and `ChangesPanel`
action error pass `variant="panel"`. No reason to keep the default was found:
each sits in a column at most a few hundred pixels wide.

_(Amended 2026-11-02, GR-31.)_ The list errors of `BranchesPanel`,
`StashesPanel`, `TagsPanel` and `WorktreesPanel`, and `GraphPanel`'s summary,
panel and page errors, pass `variant="panel"` too. On the GR-31 walk, a path error
in the default variant wrapped at about ten characters per line beside its
buttons in the 240 px refs column.

## 6. Left to the builder

Class names inside the new CSS modules; whether the `ResizeObserver` state is
one object or two; the exact handle gradient for the horizontal orientation
(mirror the vertical one); test fixture shapes.

## 7. Acceptance walk (owner, desktop)

1. Open a repo with stashes and tags at 1280×800: Stashes with no entries is
   one header and "No stashes"; Tags expanded shows its rows; Branches fills
   the rest. Repeat on a repo with hundreds of branches and a few dozen
   tags: judge whether the proportional split leaves Tags usable (final
   review Minor 2; if not, the spec rule in §3.1 step 3 is the thing to
   change, not the code).
2. Collapse Tags: its rows' space goes to Branches. Expand it: back.
3. Drag the Tags handle up and down; the column follows, nothing jumps.
   Quit, relaunch: the Tags height is back. On a repo without stashes, drag
   the Stashes handle: it refuses to move and nothing is stored. Drag the
   Branches handle up with few branches: Branches shrinks and the blank
   space moves to the column's end (by design for the primary section).
4. Double-click the Tags handle: automatic again.
5. Tab to a handle, press ArrowDown ×3 and ArrowUp ×3.
6. Narrow the window until the centre is at its minimum: a commit with
   `main`, `origin/main` and a tag shows at least one full name and a `+N`
   pill whose tooltip lists the rest.
7. Right-click a graph row: the context menu opens as before. Type in the
   branch filter: Tags shows matches even while collapsed.
8. Trigger a status error (e.g. remove read permission on `.git/index`): the
   Changes alert is the compact variant with its buttons below the text.

### Walk results (2026-11-02, GR-31 branch, agent walk on COSMIC)

Fixtures: `many-branches` (301 local branches, 40 annotated tags, one stash
made through the app's Stash dialog, one worktree, no hosting account),
`no-stashes` (the same repository without the stash) and `demo` (two
branches). Dev build at 1280×800 and at the window's 960 px minimum width;
drags as pointer events on the handles, keys from a uinput keyboard, state
read through the WebKit inspector. The column was 638 px tall at 1280×800
(614 px after four handle tracks) and 1185 px maximised.

1. Pass, with one change. Stashes with no entries is its header and "No
   stashes" (68 px); Tags expanded shows its rows; Branches takes the rest.
   On `many-branches` the proportional split gave, at 1280×800 and
   maximised: Branches 343 and 793 px (10 and 28 rows of 301), Tags 130 and
   227 px (2 and 4 rows of 40, with a scrollbar), Worktrees 73 and 74 px of
   its 92 px single row. Ruling: Tags is tight but usable, and the handle
   stores a preferred height, so the §3.1 step 3 rule stands (a fair share
   per section with content was computed and rejected: five such sections
   leave Branches about 120 px). The clipped Worktrees row was the defect:
   §3.1 now keeps a section of at most `SECTION_WHOLE_MAX` whole, which
   gives 327 / 68 / 127 / 92 px at 1280×800, summing to the column.
2. Pass. Collapse: Tags 40 px, Branches 414 px. Expand: 327 and 127 px.
3. Pass. Tags handle +60 px: Tags 187, Branches 267, sum unchanged; −100 px:
   87, stored as `tagsHeight`. Relaunch: the stored 187 px came back. On
   `no-stashes` the Stashes handle stays at 68 px (min = max) and nothing is
   stored. On `demo` the Branches handle up by 80 px: Branches 342 → 262 px,
   the heights sum to 558 px of 638 and the blank space sits at the end.
4. Pass. Double-click the Tags handle: 127 px again, `tagsHeight` null.
5. Pass. ArrowDown ×3: 127 → 175 px. ArrowUp ×3: 127 px.
6. Pass at the 960 px minimum: `master` in full, the other two candidates
   hidden, a `+68` pill whose title lists the remaining branches and tags.
   The fixture has no remote, so `origin/main` was not exercised.
7. Pass. The context menu opens on a graph row; typing `v1.1` in the branch
   filter with Tags collapsed shows its 11 matching tags.
8. Pass after two fixes. An unreadable or corrupt `.git/index` is read by
   libgit2 as an empty index and raises no error, so the trigger was an
   unreadable `.git` directory plus a working-tree write. That exposed a
   segfault: libgit2 1.9.7 frees an uninitialised config entry when a
   string read follows a failed file read, reached from `pull_default_mode`
   (GR-31 moved those reads to a config snapshot, pinned in
   `tests/remote_sync.rs`). With the fix, the Changes box is the compact
   variant with Dismiss below the text. The list-error boxes of the refs
   panels and the graph panel were still the default variant and wrapped
   the path about ten characters per line at 240 px; GR-31 moved them to
   the panel variant (§5).
