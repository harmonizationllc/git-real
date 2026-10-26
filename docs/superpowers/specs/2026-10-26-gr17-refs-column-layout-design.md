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

- `REFS_SECTIONS = ["branches", "stashes", "tags", "pullRequests", "issues"]`
  in column order; `RefsSection` is their union and `ResizableSection`
  excludes `"issues"`.
- `SECTION_MIN = 72` px: the least an expanded section with content keeps
  (one header plus about two rows) _(my call)_.
- `sectionFloor(natural) = min(SECTION_MIN, natural)`: a collapsed or empty
  section is never padded up to the minimum.
- `fitSections(container, sections)` where each section is
  `{ natural, fixed }` (`natural` = the measured height of its content,
  `fixed` = the stored height or `null` for automatic) returns one height per
  section:
  1. `pref = fixed === null ? natural : clamp(fixed, floor, natural)` for
     the secondary sections: a stored height is a preferred size, never a
     source of blank space. Branches (index 0) is the exception: its stored
     height is a true height, `clamp(fixed, floor, ∞)`, because Branches
     already holds the column's leftover above its content (corrected at the
     final review on 2026-10-26; the first ruling capped it at its content
     and snapped the handle whenever the column had spare room).
  2. If `Σ pref ≤ container`: Branches, when automatic, takes the leftover;
     otherwise the leftover stays at the end of the column.
  3. Otherwise the overflow is taken from the automatic sections in
     proportion to their room (`pref − floor`), then, if room runs out, from
     the fixed sections in the same way. Sections at their floor stay there;
     if the floors alone exceed the container the column scrolls.
  4. `container ≤ 0` (unmeasured) passes the naturals through, as
     `clampWidths` does for widths.
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
`min` is the section's floor; `max` is `maxSectionHeight` for Branches and,
for a secondary section, the smaller of `maxSectionHeight` and the section's
content height, so a handle under a section that cannot grow (collapsed,
empty) refuses to move instead of storing a preference that would cap the
section later; `step` is `KEY_STEP` (16); ArrowDown and
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

## 6. Left to the builder

Class names inside the new CSS modules; whether the `ResizeObserver` state is
one object or two; the exact handle gradient for the horizontal orientation
(mirror the vertical one); test fixture shapes.

## 7. Acceptance walk (owner, desktop)

1. Open a repo with stashes and tags at 1280×800: Stashes with no entries is
   one header and "No stashes"; Tags expanded shows its rows; Branches fills
   the rest.
2. Collapse Tags: its rows' space goes to Branches. Expand it: back.
3. Drag the Tags handle up and down; the column follows, nothing jumps.
   Quit, relaunch: the Tags height is back.
4. Double-click the Tags handle: automatic again.
5. Tab to a handle, press ArrowDown ×3 and ArrowUp ×3.
6. Narrow the window until the centre is at its minimum: a commit with
   `main`, `origin/main` and a tag shows at least one full name and a `+N`
   pill whose tooltip lists the rest.
7. Right-click a graph row: the context menu opens as before. Type in the
   branch filter: Tags shows matches even while collapsed.
8. Trigger a status error (e.g. remove read permission on `.git/index`): the
   Changes alert is the compact variant with its buttons below the text.
