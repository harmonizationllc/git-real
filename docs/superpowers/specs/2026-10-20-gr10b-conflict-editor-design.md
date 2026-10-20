# GR-10b — Inline conflict editor and Resolve All

- Jira: GR-10 "Merge, rebase, and conflict resolution", slice **b** of three.
  GR-10a (merged d65d920) shipped the operations, the in-progress banner and
  keep-one-side resolution; GR-10c is interactive rebase and drag-to-merge.
- Depends on: GR-10a (`features/merge/` hooks, `sideLabels`, `resolve_conflicts`,
  conflict rows in `ChangesPanel`), GR-5 (`languageFor` / `loadParser`,
  CodeMirror 6 chosen as the one highlighter), GR-4 (`useFileContent`,
  `get_file_content`, `index_ops` guards).
- Follows: ADR 0001 (index writes are git2), ADR 0002 (`features/merge/` owns
  conflicts), the IPC seam rule, the 100 % coverage gate.
- Date: 2026-10-20.

## 1. Goal

Selecting a file under **Conflicts** opens an editor in the centre column in
place of the diff. Git's conflict markers are shown as blocks with
`Keep <ours>` / `Take <theirs>` / `Keep both` actions; the text is freely
editable with syntax highlighting; edits autosave to the working tree;
**Mark resolved** stages the file. The Conflicts section gains
**Resolve all…** to keep one side for every conflicted file at once.

Layout decision (user, 2026-10-20): the simpler inline layout, one editable
pane. Side panes showing the raw branch files are a possible later upgrade.

### Out of scope

- Ours/theirs side panes, three-way alignment, a base choice.
- Interactive rebase, drag-to-merge (GR-10c).
- Custom `conflict-marker-size` attributes: markers are exactly seven
  characters, as git writes by default.
- Nested conflict blocks (a `<<<<<<<` inside a block).

## 2. Backend (git-real-core)

One new session method in `src/merge/write_resolution.rs`:

```rust
impl RepoSession {
    /// Writes `text` to the conflicted `path` and, when `stage` is set, stages it,
    /// which clears the path's conflict entries.
    pub fn write_resolution(&self, path: &str, text: &str, stage: bool) -> Result<(), GitError>;
}
```

Rules, in order:

1. `checked_relative(workdir, path)` validates the path (outside the work
   tree, `.git`, absolute → the existing `BadSelection` / `PathNotFound`).
2. A fresh index (`fresh_index`) must hold a conflict whose any stage is at
   `path` (reuse `conflict_path_is`); otherwise `PathNotFound`. Nothing is
   written before this check passes.
3. If the path exists in the working tree as a symlink or a directory, the
   call fails with `BadSelection` (never write through a link or into a
   directory). Parent directories are created when missing (git deletes the
   file in some delete/modify cases).
4. `std::fs::write` with the bytes exactly as given: the front end applies
   CRLF before sending, the core never translates. An existing file keeps
   its mode (the exec bit survives); a new file gets the default mode.
5. When `stage`: `index.add_path(rel)` then `index.write()`, wrapped in
   `reload_on_error` so a failed write leaves the cached index as on disk.
   When `!stage` the index is untouched.

Reading needs no new core code: the editor reads the working-tree bytes via
the existing `file_content(path, Unstaged, New, MAX_PREVIEW_BYTES)`.

### App layer

`src-tauri/src/commands/merge.rs` gains

```rust
#[tauri::command]
pub async fn write_resolution(reg, id: RepoId, path: String, text: String, stage: bool) -> Result<(), AppError>
```

registered in `lib.rs`. No new error kinds: `PathNotFound`, `BadSelection`
and `Io` already map.

## 3. IPC (`src/lib/ipc`)

```ts
export function writeResolution(
  id: RepoId,
  path: string,
  text: string,
  stage: boolean,
): Promise<void>;
```

No new types, keys or events. The editor reads through `useFileContent(repoId,
path, "unstaged", "new", enabled)` (key `fileContent`), which the repo-changed
event already invalidates.

## 4. Front end

### 4.1 Files (`src/features/merge/editor/`)

```
ConflictEditor.tsx        # container: data, placeholder states, toolbar, pane, error strip
ConflictEditor.module.css
ConflictToolbar.tsx       # path, count, Previous/Next, Keep all/Take all, Mark resolved, Close
EditorPane.tsx            # thin React wrapper that owns one CodeMirror EditorView
model/text.ts             # pure: decodeEditable(bytes) -> {text, crlf} | NotEditable; encodeForDisk
model/markers.ts          # pure: parseConflicts(text) -> ConflictBlock[]; replacementFor(block, choice)
model/blocks.ts           # CodeMirror StateField + effects: tracked blocks, pick/undo, decorations
model/blockBar.ts         # WidgetType for the per-block action bar
useResolutionWriter.ts    # autosave + markResolved over writeResolution
```

Plus edits to `features/diff/model/highlight.ts` (`loadLanguage`),
`features/diff/DetailPane.tsx` (routing), `features/worktree/ChangesPanel.tsx`
(Resolve all), `lib/ipc/commands.ts`, and `package.json`.

New dependencies: `@codemirror/view`, `@codemirror/state`,
`@codemirror/commands` (history, default keymap). `@codemirror/language` and
`@lezer/highlight` are already present.

### 4.2 Reading and decoding (`model/text.ts`)

```ts
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export type NotEditable = "tooLarge" | "notText";
export interface EditableText {
  text: string;
  crlf: boolean;
}
export function decodeEditable(bytes: ArrayBuffer): EditableText | NotEditable;
export function encodeForDisk(text: string, crlf: boolean): string;
```

- `byteLength > MAX_EDIT_BYTES` → `"tooLarge"`.
- `TextDecoder("utf-8", { fatal: true })`; a decode failure or a U+0000 in the
  result → `"notText"`.
- `crlf` is true when the text contains `\r\n`; the editor text is the
  decoded text with every `\r\n` replaced by `\n`. `encodeForDisk` puts
  `\r\n` back when `crlf`.

### 4.3 Markers (`model/markers.ts`)

```ts
export interface ConflictBlock {
  from: number; // offset of the `<<<<<<<` line start
  to: number; // offset just past the `>>>>>>>` line's newline (or doc end)
  ours: string; // lines between `<<<<<<<` and `|||||||`/`=======`, each with "\n"
  base: string | null; // lines between `|||||||` and `=======`, or null without diff3
  theirs: string; // lines between `=======` and `>>>>>>>`
  oursLabel: string; // text after `<<<<<<< ` (may be "")
  theirsLabel: string;
  trailingNewline: boolean; // false only when `>>>>>>>` is the last line without "\n"
}
export type Choice = "ours" | "theirs" | "both";
export function parseConflicts(text: string): ConflictBlock[];
export function replacementFor(block: ConflictBlock, choice: Choice): string;
```

A marker is a line that starts with exactly seven of the same character
(`<`, `|`, `=`, `>`) followed by a space or the end of the line. A block is
`<<<<<<<`, then optionally `|||||||`, then `=======`, then `>>>>>>>`, each
at a later line; anything else (a start without an end, markers out of
order) is plain text and no block. `replacementFor` returns `ours`,
`theirs`, or `ours + theirs`; when `trailingNewline` is false the final
`"\n"` of the replacement is dropped. Blocks never overlap and are
returned in document order.

### 4.4 Block state (`model/blocks.ts`)

A `StateField<TrackedBlock[]>` created from the initial text:

```ts
export type BlockState = "unresolved" | "ours" | "theirs" | "both" | "custom";
export interface TrackedBlock extends ConflictBlock {
  id: number;
  state: BlockState;
  original: string;
}
export const pickBlock: StateEffectType<{ id: number; choice: Choice | "restore" }>;
export const resetBlocks: StateEffectType<string>; // reload from new text
export function conflictBlocks(): Extension; // reads the document; blockLabels is a Facet
export function blocksOf(state: EditorState): TrackedBlock[];
export function remainingConflicts(state: EditorState): number; // parseConflicts(doc).length
export function pickAll(view: EditorView, choice: Choice): void; // every "unresolved" block
export function goToConflict(view: EditorView, dir: 1 | -1): boolean;
```

- On every transaction a block that is not picked maps `from` with `assoc`
  1 and `to` with `assoc` -1, clamped to `to >= from`, so text typed at
  either boundary stays outside the block; a picked block takes
  `from = mapPos(from, -1)` and `to = from + inserted length`. A change that
  touches the open interval of a block and does not carry that block's
  `pickBlock` effect sets its state to `"custom"`.
- `pickBlock` with a choice replaces `[from, to)` with
  `replacementFor(block, choice)`, sets the state, and keeps `original`
  (the marker text); `"restore"` writes `original` back and sets
  `"unresolved"`. The replacing transaction carries the effect, so the
  touch rule does not fire.
- **Remaining conflicts are counted from the document**, not from states:
  `remainingConflicts` re-parses the current text. A custom edit that leaves
  markers behind still counts; one that removes them does not.
- `goToConflict` moves the selection to the next/previous parsed block from
  the cursor (wrapping) and scrolls it into view.
- Decorations (same module): line classes `cm-conflict-marker` on the four
  marker lines, `cm-conflict-ours`, `cm-conflict-base` (dimmed) and
  `cm-conflict-theirs` on the content lines of an unresolved block;
  `cm-conflict-resolved` on every line of a block in state ours/theirs/both;
  nothing for custom. A block widget (`side: -1`, at `from`) renders the
  action bar for every block in every state.

### 4.5 Action bar (`model/blockBar.ts`)

`role="group"`, `aria-label="Conflict {n}"` where n is the 1-based index in
document order. Buttons by state:

- unresolved: `Keep {ours}`, `Take {theirs}`, `Keep both`
- ours / theirs / both / custom: a label `Kept {ours}` / `Took {theirs}` /
  `Kept both` / `Edited`, then `Undo`

`{ours}` / `{theirs}` come from `sideLabels(state, headName(branches?.head))`
exactly as the Changes panel menu does. Clicks dispatch `pickBlock`
(`Undo` → `"restore"`) and refocus the view.

### 4.6 Editor pane (`EditorPane.tsx`)

```ts
export interface EditorPaneProps {
  initialText: string;
  extensions: Extension[];
  onDocChange(text: string): void; // called after every docChanged transaction
  viewRef: RefObject<EditorView | null>;
  ariaLabel: string;
}
```

Mounts one `EditorView` on a `div`, destroys it on unmount, never recreates
it for prop changes (callers reset the document through `resetBlocks` /
`view.dispatch`). Base extensions: `lineNumbers()`, `history()`,
`keymap.of([...defaultKeymap, ...historyKeymap])`, `EditorView.lineWrapping`
off, a theme built on the app's CSS variables, and
`syntaxHighlighting(classHighlighter)` so the diff viewer's existing
`.tok-*` styles apply. Language support is added when
`loadLanguage(languageFor(path))` resolves, through a `Compartment`, and
skipped when the text has more than `HIGHLIGHT_LIMIT` lines.

`features/diff/model/highlight.ts` gains

```ts
export function loadLanguage(desc: LanguageDescription): Promise<LanguageSupport>;
```

sharing the existing cache: the cache stores the `LanguageSupport` promise
and `loadParser` maps it to `.language.parser`. A failed load is still
evicted.

### 4.7 Container (`ConflictEditor.tsx`)

```ts
export function ConflictEditor({ repoId, path }: { repoId: RepoId; path: string }): JSX.Element;
```

States, in order of precedence:

1. Loading (`useFileContent` pending): `<p role="status">Loading {name}…</p>`
   under the toolbar (name is the path's last segment).
2. Not editable: a placeholder with heading `Can’t edit {name} here`, a
   reason, and `Keep {ours}` / `Take {theirs}` buttons that run the existing
   `resolve` request for `[path]` (disabled while pending). Reasons:
   - `tooLarge` or an `AppError` of kind `tooLarge` → `It is larger than 2 MB.`
   - `notText` or kind `binaryFile` → `It is not UTF-8 text.`
   - kind `pathNotFound` → `It is missing from the working tree.`
   - any other `AppError` → its `message`.
3. Editable: the toolbar, an error strip (`RepoError` with Dismiss) when the
   writer reports an error, and the pane (`aria-label="Conflict editor"`).

Reload rule: the writer remembers the last 32 texts it sent. When the
query delivers new bytes that decode to `source`: `source` equal to the
current document, or to one of those sent texts, is ignored (our own write
echoed by the watcher, possibly after more typing); anything else replaces
the document with `source` via `resetBlocks` (blocks re-parsed) after
dropping unsent autosave work.

### 4.8 Toolbar (`ConflictToolbar.tsx`)

While loading or showing the placeholder the toolbar renders only the path
and `Close`. In the editable state — left: the path. Centre: `{n} conflicts remaining` (`1 conflict remaining`,
`All conflicts resolved` at zero), then `Previous` and `Next` (disabled at
zero). Right: `Keep all {ours}`, `Take all {theirs}` (disabled at zero, while
pending, or when no tracked block is still `unresolved` — `canPickAll`),
`Mark resolved`, `Close`.

`Mark resolved`: disabled with title `Resolve all conflicts first` while
remaining > 0, or `Saving…` while the writer is pending. On click: flush
the autosave, then `markResolved(text)`; on success
`useWorkspace.getState().select(repoId, { path, scope: "staged" })` so the
staged diff of the resolution shows. On failure the error strip shows.

`Close`: `select(repoId, null)`.

### 4.9 Writer (`useResolutionWriter.ts`)

```ts
export interface UseResolutionWriter {
  scheduleSave(text: string): void; // debounced 500 ms, stage: false
  flush(): Promise<void>; // send a pending save now and await it
  markResolved(text: string): Promise<AppError | null>; // stage: true
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}
export function useResolutionWriter(
  repoId: RepoId,
  path: string,
  crlf: boolean,
): UseResolutionWriter;
```

- Saves are serialised: a new save waits for the in-flight one. The text
  sent is `encodeForDisk(text, crlf)`.
- A plain save invalidates nothing (the file watcher's repo-changed event
  refreshes status and content). `markResolved` invalidates the repo prefix
  on settle, like every other integration action.
- Unmount flushes a pending save (fire and forget).
- `pending` is true while any write is in flight.
- `wasWritten(text)` reports whether `text` is among the last 32 texts sent
  (`WRITTEN_MEMORY`); `discardPending()` drops a queued, unsent save.

### 4.10 Routing (`DetailPane.tsx`)

The outer `DetailPane` also reads `useStatus(repoId)`. When the selected
file has `scope === "unstaged"` and its status entry is `conflicted`, it
renders `<ConflictEditor key={"conflict:" + path} repoId path />`
instead of `FileDetail`. Once the file is staged the entry is no longer
conflicted, so a stale `unstaged` selection falls back to the diff; the
editor avoids that by reselecting as staged on success (4.8).

### 4.11 Resolve all (`ChangesPanel.tsx`)

The Conflicts section header, which has no action today, gets a
`Resolve all…` button (disabled while pending). It opens the panel's
`ContextMenu` anchored at the button's bottom-left with two items:
`Keep {ours} for all files` and `Take {theirs} for all files`, each
running `resolve` with every path in the Conflicts section. No
confirmation, matching the per-file actions; abort remains the undo.

## 5. Copy strings (verbatim)

```
Loading {name}…
Can’t edit {name} here
It is larger than 2 MB.
It is not UTF-8 text.
It is missing from the working tree.
{n} conflicts remaining | 1 conflict remaining | All conflicts resolved
Previous | Next | Keep all {ours} | Take all {theirs} | Mark resolved | Close
Resolve all conflicts first | Saving…
Keep {ours} | Take {theirs} | Keep both | Undo
Kept {ours} | Took {theirs} | Kept both | Edited
Conflict {n}
Resolve all…
Keep {ours} for all files | Take {theirs} for all files
```

## 6. Testing

- Rust (`crates/git-real-core/tests/merge.rs`): write with stage clears the
  conflict and stages the bytes verbatim (CRLF kept); write without stage
  leaves the conflict and the index untouched; non-conflicted path →
  `PathNotFound` with nothing written; symlink or directory at the path →
  `BadSelection`; path outside the work tree rejected; exec bit survives;
  a deleted working-tree file is recreated with parents; app-layer command
  test in `src-tauri/tests/merge_commands.rs`.
- Front end: pure modules (`text`, `markers`, `blocks` via `EditorState`
  without a view) carry most of the logic and are tested headlessly.
  `EditorPane`, `ConflictEditor` and the action bar need a live
  `EditorView`; cycle 1 includes a spike mounting one under happy-dom. If it
  fails, those test files declare `// @vitest-environment jsdom` and
  `jsdom` joins devDependencies. Coverage stays at 100 %.
- Acceptance walk on the GR-10a fixture: merge with a two-block conflict,
  per-block Keep/Take/both/Undo, free edit marks Edited, count follows the
  document, Mark resolved stages and shows the staged diff, Keep all, Resolve
  all with two files, a diff3-style block shows the dimmed base, a binary
  conflicted file shows the placeholder with working Keep/Take.

## 7. Follow-ups

- Side panes with the raw branch files (the layout the user first chose and
  then deferred).
- `conflict-marker-size` attribute support.
- Keep-one-side via `checkout_index` so symlink and gitlink sides and smudge
  filters are honoured (carried from GR-10a).
