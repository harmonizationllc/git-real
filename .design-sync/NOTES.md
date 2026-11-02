# design-sync notes for Git Real

- Git Real is a Tauri app, not a component library: there is no `dist/` and no
  Storybook. The sync entry is the hand-written barrel `.design-sync/entry.ts`,
  which re-exports only the components in scope. `package.json` `types` points
  at that barrel so the converter reads prop types straight from TypeScript
  source. Add a line to the barrel to sync another component.
- Components import `src/lib/ipc` for types (and a few for runtime). The module
  loads fine in a browser; only `invoke` calls fail, so previews must not
  trigger IPC. Never author a preview that clicks through to a git operation.
- Styles are CSS Modules (`*.module.css`), bundled by esbuild's local-css
  loader into `_ds_bundle.css`. Tokens live in `src/styles/tokens.css`
  (light + dark via `prefers-color-scheme` and `data-theme`), base styles in
  `global.css`, syntax colours in `syntax.css`. Fonts are `system-ui` and
  `monospace`; nothing ships, nothing to copy.
- Scope on first sync (2026-11-02): 22 presentational components. Excluded on
  purpose: panels that fetch via IPC (GraphPanel, ChangesPanel, DiffViewer,
  hosting, settings dialogs) and CodeMirror-backed editors.

## Preview-authoring learnings (first sync, 2026-11-02)

- Previews import from `"git-real"`; layout glue is inline styles (the DS has
  no utility classes). Row components (BranchRow, StashRow, TagRow, FileRow)
  render `<li>` and need a `<ul style={{ listStyle: "none", margin: 0, padding: 0 }}>`
  wrapper. HistoryRow is a `div role="option"`; wrap in `div role="listbox"`.
- Widths that avoid wrapping: FileHeader ~880 px (six controls in the row),
  HunkHeader ~760 px, RepoError ~640 px, TabBar long-name cell 640 px with two
  tabs, HistoryRow 440 px. Toolbars (SyncToolbar, GraphToolbar) are fine at 560 px.
- Overlays need `overrides.<Name>: { cardMode: "single", viewport }`:
  ConfirmDialog and PromptDialog (640x400), ContextMenu (360x240), Toasts
  (480x240; its root is `position: fixed; right: 16px; bottom: 16px`).
- Toasts renders from the zustand store; `useToasts` is exported from the
  barrel so previews seed toasts synchronously, guarded to run once per cell.
- SyncToolbar/SyncMessage take a `SyncActions` object; a plain literal with
  no-op functions and static state renders with no IPC. Their nested dialogs
  stay closed because their state is null. FileHeader reads the settings store
  during render; fine with the default store.
- RefLabels measures its parent's clientWidth (wrap in a fixed-width nowrap
  flex div) and shows at most 3 pills, so a 4th ref never appears.
- Time-dependent rows (StashRow, HistoryRow) take `now` in Unix seconds;
  previews pin it so relative times stay stable.
- The `<details>` disclosure in NetworkError and SyncMessage stays collapsed;
  the component has no prop to open it.
- Prop types: the converter keeps in-repo interface names (`RepoTab`,
  `StatusEntry`, `SyncActions`, ...) by reference, so `dtsPropsFor` in
  config.json carries hand-flattened bodies for 16 components. Re-flatten
  when those interfaces change (`src/lib/ipc/types.ts`, `useSyncActions.ts`,
  `repoTabs.ts`, `errors.ts`).

## Known render warns

- `[RENDER_THIN] ConfirmDialog.html / PromptDialog.html: rendered height is 0px`:
  benign. Both render a `position: fixed` backdrop, so the measured root has no
  height; the screenshots show the dialog fully. Cards are single-mode 640x400.

## Re-sync risks

- `dtsPropsFor` bodies are hand-flattened copies of in-repo interfaces; they
  go stale silently when `src/lib/ipc/types.ts`, `useSyncActions.ts`,
  `repoTabs.ts` or `errors.ts` change. Diff them against the source on re-sync.
- The barrel `.design-sync/entry.ts` and `package.json` `types` are the only
  wiring; a renamed component path breaks the build loudly (good).
- Previews pin `now` timestamps and seed the toast store; both are stable
  across runs. Nothing is fetched from the network during the build.
- Toolchain: Node 24, esbuild/ts-morph installed fresh into `.ds-sync/` per
  clone; Playwright chromium from `~/.cache/ms-playwright`.

## Re-sync 2026-11-02 (after the COSMIC restyle, main 31438a7)

- Sources unchanged, styling and bundle changed; 22 carried forward, 5 spot-checked
  (TabBar, SyncToolbar, FileRow, ConfirmDialog, ContextMenu) and re-graded good.
- conventions.md rewritten for the restyled system (shape tokens, button
  data-attribute vocabulary, shadow tokens); esbuild writes attribute selectors
  unquoted in `_ds_bundle.css`, so validate names with `data-variant=primary`, not
  the quoted form.
