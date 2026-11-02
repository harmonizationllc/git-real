# Building with Git Real components

Git Real is a desktop Git client (Tauri + React) styled for the COSMIC
desktop: a grey ground, panels as rounded cards, pill buttons, one accent,
compact 13 to 14 px type. Match that register: information-dense, no
decorative chrome, system fonts only.

## Setup: nothing to wrap

There is no provider. Components read design tokens from CSS custom
properties that `styles.css` defines on `:root`. Dark theme is automatic
via `prefers-color-scheme`; force it with `<html data-theme="dark">` (or
`data-theme="light"`). The body font and ground come from the same
stylesheet (`font-family: var(--font-ui)`, `background: var(--color-bg)`).

## Styling idiom: tokens and data attributes, not classes

Component styles are CSS Modules compiled to hashed class names. Those
class names are NOT a public vocabulary: never write `className="row"` or
guess a module class. Style your own layout glue with inline styles or
plain CSS that uses the tokens below. Never hard-code a colour, radius,
spacing or font.

Colour tokens: `--color-bg` (window ground), `--color-surface` (cards,
dialogs, rows), `--color-surface-2` (inputs, segmented-control tracks),
`--color-surface-hover`, `--color-border`, `--color-text`,
`--color-text-muted`, `--color-accent` + `--color-on-accent` (primary
action, current branch, HEAD), `--color-accent-tint` (selected rows, focus
halo), `--color-backdrop` (behind dialogs), `--color-danger`,
`--color-warning`, `--color-added`, `--color-modified`, `--color-removed`.
Diff backgrounds: `--color-added-bg`, `--color-removed-bg`,
`--color-added-word-bg`, `--color-removed-word-bg`, `--color-hunk-bg`,
`--color-line-selected`. Graph lanes: `--graph-lane-0` to `--graph-lane-7`.
Syntax: `--syntax-keyword`, `--syntax-string`, `--syntax-number`,
`--syntax-comment`, `--syntax-variable`, `--syntax-type`,
`--syntax-function`, `--syntax-operator`, `--syntax-punctuation`,
`--syntax-meta`, `--syntax-invalid`.

Shape tokens: spacing `--space-1` 4, `--space-2` 8, `--space-3` 12,
`--space-4` 16, `--space-5` 24, `--space-6` 32 (px); radius `--radius-xs`
4 (badges), `--radius-s` 8 (cards, rows, inputs), `--radius-m` 16
(dialogs), `--radius-pill` (buttons, chips); control heights `--control-h`
32 and `--control-h-sm` 24; shadows `--shadow-card` (a 1 px ring for
panels; never a blurred shadow on a large surface) and `--shadow-popover`
(menus, pickers, toasts).

Type tokens: `--font-ui` (system UI), `--font-mono` (paths, hashes,
code), `--diff-font-size`; sizes `--text-xs` 12, `--text-sm` 13,
`--text-md` 14, `--text-base` 16, `--text-lg` 18, `--text-xl` 20,
`--text-2xl` 24 (px). Weights are only normal, 600 and 700.

## Buttons and chips: the data-attribute vocabulary

Any `<button>` becomes a pill by opting in with `data-variant`:
`primary` (accent fill, one per area), `neutral` (grey fill, the default
secondary), `ghost` (transparent, for row and header actions), `icon`
(square, glyph only, add `aria-label`), `danger` (destructive text
action). Add `data-size="sm"` for 24 px row actions, `data-fill="neutral"`
to give an icon button a grey disc, and `data-danger="true"` on a primary
to make it a destructive confirm. Chips use the global class `gr-pill`
with `data-kind="head" | "branch" | "remote" | "tag"`; section headings
inside panels use the global class `gr-section-heading`.

## Composition rules that matter

- A panel is a card: `background: var(--color-surface); border-radius:
var(--radius-s); box-shadow: var(--shadow-card); overflow: hidden`, with
  `var(--space-2)` between cards so the ground shows.
- Row components (`FileRow`, `BranchRow`, `StashRow`, `TagRow`) render
  `<li>`: put them in `<ul style={{ listStyle: "none", margin: 0, padding:
"var(--space-1) 6px" }}>`. `HistoryRow` is a `div role="option"`: wrap in
  `div role="listbox"`. Rows are 32 px, rounded, and select with
  `--color-accent-tint`, never a left border.
- Overlays (`ConfirmDialog`, `PromptDialog`, `ContextMenu`) render nothing
  until `open` is true and position themselves fixed; `Toasts` renders
  from the `useToasts` store (`useToasts.getState().notify({ text,
variant })`).
- `SyncToolbar` and `SyncMessage` take one `sync` object (see their
  props); pass static state and no-op functions for mockups.
- `RefLabels` sizes to its parent width and shows at most 3 pills.
- Paths and hashes use `var(--font-mono)`; status letters come from
  `StatusBadge`, never hand-drawn.

## Where the truth lives

Read `styles.css` and its import `_ds_bundle.css` for every token, the
button vocabulary and the real component CSS. Each component ships
`<Name>.d.ts` (the exact props) and `<Name>.prompt.md` (usage and
examples). Prefer those over this summary.

## Idiomatic snippet

```jsx
<section
  style={{
    background: "var(--color-surface)",
    borderRadius: "var(--radius-s)",
    boxShadow: "var(--shadow-card)",
    overflow: "hidden",
  }}
>
  <header
    style={{
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "space-between",
      padding: "0 var(--space-2)",
    }}
  >
    <h2 className="gr-section-heading">Unstaged · 1</h2>
    <button type="button" data-variant="ghost" data-size="sm">
      Stage all
    </button>
  </header>
  <ul style={{ listStyle: "none", margin: 0, padding: "var(--space-1) 6px" }}>
    <FileRow
      entry={{
        path: "src/app/App.tsx",
        oldPath: null,
        index: null,
        worktree: "modified",
        conflicted: false,
      }}
      section="unstaged"
      kind="modified"
      selected={false}
      disabled={false}
      onClick={noop}
      onContextMenu={noop}
      onPrimary={noop}
      onDiscard={noop}
    />
  </ul>
</section>
```
