# GR-5 — Diff viewer

- Status: Approved (design reviewed in session 2026-10-17)
- Epic: GR-1 / Story: GR-5 "Diff viewer"
- Depends on: GR-4 (`get_file_diff`, `apply_hunk`, Changes panel, watcher)
- Follows: ADR 0001 (hybrid git backend), ADR 0002 (project structure)

## 1. Goal

Show the diff of the file selected in the Changes panel, in unified or
side-by-side form, with syntax colouring, both line numbers, optional
whitespace hiding, image previews for binary images, and smooth rendering of
very large diffs. Land the hunk- and line-level stage, unstage and discard
controls that GR-4 deferred here.

### Acceptance criteria (from Jira GR-5)

1. Side-by-side and unified diff modes.
2. Syntax highlighting for common languages.
3. Line numbers for both old and new sides.
4. Whitespace-only changes can be hidden.
5. Binary files and images show a placeholder or image preview instead of a
   raw diff.
6. Large files render without freezing the UI.

### Added in design review

7. Intraline (word-level) change highlighting inside paired modified lines.
8. Hunk and line stage / unstage / discard controls (GR-4 criterion 3 and the
   hunk half of criterion 4).
9. UTF-16 and UTF-32 text files, which libgit2 flags as binary, decode to a
   text diff with an encoding notice; an encoding-only change is reported as
   such rather than as "no changes".

### Out of scope

- Editable text (GR-10 builds the conflict editor on the same CodeMirror
  language packages; see §2).
- Diffs of commits (GR-9). `DiffViewer` takes a `FileDiff` value so GR-9 can
  reuse it unchanged.
- Resizable panes, tab-width and wrap settings (GR-14).
- Horizontal scrolling: long lines wrap.
- Highlighting inside the Changes panel or anywhere outside the viewer.

## 2. Decisions

- **Highlighting runs in the web view with CodeMirror 6 / Lezer**, not in
  Rust. The user asked for a future editable conflict view; Lezer parsers are
  incremental and the same language packages power a live editor, so one
  highlighter serves both. `syntect` (Rust), Shiki and highlight.js were
  rejected because none is incremental and each would force a second
  highlighter or per-keystroke IPC later. No editor instance is created in
  GR-5: `@lezer/highlight`'s `highlightTree` colours a parse tree standalone.
- **Languages are chosen by filename** through `@codemirror/language-data`
  and loaded on demand with dynamic imports, so the main bundle carries no
  grammars. Unknown languages render plain.
- **Each hunk is highlighted per side.** The old side is the hunk's context
  plus deletion lines, the new side its context plus addition lines. Each
  side is parsed once as one text. Multi-line constructs that cross a hunk
  boundary may colour wrong at the edge; this is the accepted trade-off of
  not fetching whole files.
- **Diffs above `HIGHLIGHT_LIMIT = 20_000` lines render unhighlighted.**
  Parsing stays synchronous on the main thread below that limit (well under
  a second). Everything else that keeps the UI responsive is virtualization.
- **Rows are virtualized with `@tanstack/react-virtual`** using measured
  heights, because lines wrap and so have variable height.
- **Long lines wrap** (`white-space: pre-wrap; overflow-wrap: anywhere`) so
  both sides of a split row stay aligned and the viewer has one scrollbar.
- **Side-by-side pairing is per hunk, run by run.** A run of deletions is
  zipped with the run of additions that follows it; leftovers are one-sided.
  Context lines are always two-sided. The same pairing drives word diffs in
  both modes.
- **Word diff is an in-house token LCS**, bounded: when either line has more
  than `WORD_DIFF_MAX_TOKENS = 400` tokens the whole line is marked changed.
- **The backend's 10 000-line truncation stays.** The viewer shows a banner
  with "Load full diff", which refetches with `maxLines = 1_000_000`. The
  diff command therefore gains an optional `maxLines` argument.
- **Image preview bytes come from a new `get_file_content` command** that
  returns raw bytes (a `tauri::ipc::Response`, no base64) for one side of a
  file. Content over `MAX_PREVIEW_BYTES = 20 MiB` is refused with a new
  `tooLarge` error kind so the UI can show the size instead of loading it.
  The CSP `img-src` gains `blob:`; the front end shows previews through
  `URL.createObjectURL`.
- **UTF-16 and UTF-32 files are decoded in the backend.** libgit2 marks any
  file with a NUL byte in its first 8 KB as binary, which covers every UTF-16
  file. When a diff is flagged binary, both sides are sniffed (byte-order
  mark first, then a NUL-pattern heuristic for BOM-less UTF-16). If every
  present side is UTF-8, UTF-16 or UTF-32 and no side exceeds
  `max_decode_bytes` (default 20 MiB), the sides are transcoded to UTF-8 and
  the hunks are built from the decoded buffers. `FileDiff` carries
  `old_encoding` / `new_encoding` so the viewer can say "Decoded from UTF-16
  LE" or "Encoding changed from UTF-8 to UTF-16 LE". Hunk and line actions
  are disabled for decoded files because a patch built from decoded text
  cannot apply to the raw bytes; whole-file actions in the Changes panel
  still work. Single-byte encodings (Latin-1, Windows-1252) are unchanged:
  they diff as text with lossy UTF-8 display, a known limitation. Git's
  `working-tree-encoding` attribute is not honoured by libgit2 and is not
  consulted.
- **Workdir content follows git semantics for symlinks**: the bytes of a
  symlink are its link target string, never the target file's contents. This
  stops a symlink from previewing files outside the repository.
- **Line selection is confined to one hunk**, because `apply_hunk` takes one
  `HunkSelection`. Clicking a changed line in another hunk starts a new
  selection there. Selection resets whenever the diff data changes.
- **Hunk and line actions are disabled while "Hide whitespace changes" is
  on** (GR-4 decision: patches are built with whitespace ignoring off, so
  the indices would not match).
- **Viewer preferences (mode, hide whitespace) persist in localStorage**
  through a small Zustand store. Default mode is side-by-side.
- **"No changes in this scope" is a state, not an error.** `get_file_diff`
  fails with `noChanges` once the last hunk is staged; the pane shows an
  empty state and keeps the selection.

## 3. Rust

### 3.1 `git-real-core`

New in `model/diff.rs`:

```rust
/// Which version of a file a content request refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffSide {
    /// HEAD for `Staged`, the index for `Unstaged`.
    Old,
    /// The index for `Staged`, the working tree for `Unstaged`.
    New,
}
```

```rust
/// A text encoding the diff loader can transcode from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Utf32Le,
    Utf32Be,
}
```

`FileDiff` gains two fields, both `None` for an ordinary diff and set only
when the loader decoded the sides (an absent side stays `None`):

```rust
pub old_encoding: Option<TextEncoding>,
pub new_encoding: Option<TextEncoding>,
```

`DiffOptions` gains `pub max_decode_bytes: u64` (default `20 * 1024 * 1024`);
a side larger than this is not decoded and the diff stays binary.

New in `error.rs`:

```rust
#[error("{path} is {size} bytes, above the {limit} byte preview limit")]
TooLarge { path: String, size: u64, limit: u64 },
```

New module `content.rs` with one method:

```rust
impl RepoSession {
    /// Raw bytes of `path` on `side` of `scope`, refusing anything above `max_bytes`.
    pub fn file_content(
        &self,
        path: &str,
        scope: DiffScope,
        side: DiffSide,
        max_bytes: u64,
    ) -> Result<Vec<u8>, GitError>;
}
```

Behaviour:

- `path` is the path **on that side**: callers pass `old_path` for the old
  side of a rename. It goes through the existing `repo_relative` guard in
  `paths.rs`; a rejected path is `PathNotFound`.
- `(Staged, Old)`: blob at `path` in the HEAD tree. Unborn HEAD or missing
  entry → `PathNotFound`.
- `(Staged, New)` and `(Unstaged, Old)`: blob of the index entry at `path`
  (stage 0) after `index.read(true)`. Missing → `PathNotFound`.
- `(Unstaged, New)`: the working-tree file. `symlink_metadata` decides: a
  symlink returns its target as bytes; a directory or missing file is
  `PathNotFound`.
- The size check happens before any read: blob size or file length greater
  than `max_bytes` → `TooLarge`. Equal is allowed.
- Bytes are returned verbatim; nothing is decoded.

Tests in `tests/content.rs` (fixtures from `tests/common/mod.rs`): all four
scope/side combinations on a modified tracked file; added file old side →
`PathNotFound`; deleted file new side → `PathNotFound`; rename old side via
old path; unborn HEAD staged old → `PathNotFound`; symlink returns the link
target; directory → `PathNotFound`; `..` path → `PathNotFound`; a file one
byte over the limit → `TooLarge` with the right size and limit; exactly at
the limit succeeds; binary bytes (including `\0`) round-trip unchanged.

New module `encoding.rs`:

```rust
/// Sniffs `bytes`: BOM first (UTF-32 before UTF-16, since `FF FE 00 00`
/// starts with the UTF-16 LE mark), then valid UTF-8 without NUL, then the
/// BOM-less UTF-16 heuristic. `None` means "not text we can decode".
pub fn detect_encoding(bytes: &[u8]) -> Option<TextEncoding>;

/// Transcodes `bytes` to a `String`, dropping a leading BOM and replacing
/// malformed sequences with U+FFFD. Odd trailing bytes become one U+FFFD.
pub fn decode(bytes: &[u8], encoding: TextEncoding) -> String;
```

Heuristic for BOM-less UTF-16: look at the first 8192 bytes as pairs. If at
least 90 % of pairs have a zero high byte and a non-zero low byte, the
encoding is UTF-16 LE (zero at odd offsets) or UTF-16 BE (zero at even
offsets). Empty input is `Some(Utf8)`. UTF-32 without a BOM is not detected.

`load_diff` changes (Display mode only; Exact mode, used by `apply_hunk`,
never decodes, so a hunk action on such a file fails with `BadSelection`):

1. After `is_binary` is computed true, fetch the bytes of each present side
   through the same resolution `file_content` uses (old: HEAD or index; new:
   index or workdir), with `opts.max_decode_bytes` as the cap. A `TooLarge`
   result leaves the diff binary.
2. Detect each present side. If any present side is `None`, or every present
   side is `Utf8`, the diff stays binary (a UTF-8 file with a NUL is binary).
3. Otherwise decode each side, build `git2::Patch::from_buffers(old, old_path,
new, new_path, opts)` with the same context and whitespace options, and
   collect hunks with the existing collector. Set `is_binary = false`, the
   two encoding fields, and `truncated` as usual.
4. The `no_visible_change` rule is skipped when decoding happened: a file
   whose only change is its encoding returns a diff with zero hunks and two
   different encodings, not `NoChanges`.

Tests in `tests/encoding.rs`: BOMs for all four UTF-16/32 variants; BOM-less
LE and BE; ASCII and multibyte UTF-8 → `Utf8`; a PNG header → `None`; empty →
`Some(Utf8)`; decode strips the BOM; an odd trailing byte decodes to one
U+FFFD; an unpaired surrogate decodes to U+FFFD. In `tests/diff.rs`: a UTF-16
LE file edited in place yields text hunks with both encodings `Utf16Le`; UTF-8
→ UTF-16 LE with identical text yields zero hunks, `Utf8`/`Utf16Le`, no error;
a real binary stays `is_binary`; a UTF-16 side above `max_decode_bytes` stays
binary; `ignore_whitespace` applies to the decoded diff; `apply_hunk` on a
UTF-16 file fails with `BadSelection`; an added UTF-16 file has
`old_encoding == None`.

### 3.2 Tauri app

- `error.rs`: `AppErrorKind::TooLarge` (`"tooLarge"`), mapped from
  `GitError::TooLarge`.
- `commands/worktree.rs`:
  - `get_file_diff(id, path, scope, ignore_whitespace, max_lines: Option<usize>)`;
    `None` keeps `DiffOptions::default().max_lines`.
  - `get_file_content(id, path, scope, side) -> Result<tauri::ipc::Response, AppError>`
    with `pub const MAX_PREVIEW_BYTES: u64 = 20 * 1024 * 1024`, running the
    core call through `run_blocking` and `with_session` like its siblings.
    An `_inner` function returning `Result<Vec<u8>, AppError>` carries the
    tests; the command wraps it in `Response::new`.
- `lib.rs`: register `get_file_content`.
- `tauri.conf.json`: `img-src 'self' asset: http://asset.localhost data: blob:`.

Tests in `tests/worktree_commands.rs`: `get_file_diff_inner` with
`Some(2)` truncates and `None` does not; `get_file_content_inner` returns
bytes, maps `TooLarge` to `AppErrorKind::TooLarge`, and `unknownRepo` for a
bad id. `tests/error.rs`: `tooLarge` serialises in camelCase.

## 4. Front end

### 4.1 Dependencies

Runtime: `@codemirror/language`, `@codemirror/language-data`,
`@lezer/highlight`, `@tanstack/react-virtual`. (`@codemirror/state` and
`@codemirror/view` arrive transitively; nothing imports them in GR-5.)
`vite.config.ts` `optimizeDeps.include` gains the four packages plus every
`@codemirror/lang-*` and `@codemirror/legacy-modes` dependency listed in
`node_modules/@codemirror/language-data/package.json`, so a first dynamic
language import never triggers a dev-server re-optimisation reload.

### 4.2 IPC seam (`src/lib/ipc`)

- `types.ts`: `export type DiffSide = "old" | "new";`,
  `export type TextEncoding = "utf8" | "utf16Le" | "utf16Be" | "utf32Le" | "utf32Be";`,
  `oldEncoding: TextEncoding | null` and `newEncoding: TextEncoding | null` on
  `FileDiff`, and `"tooLarge"` added to `AppErrorKind`.
- `errors.ts`: `tooLarge: true` in `KINDS`.
- `commands.ts`:
  - `getFileDiff(id, path, scope, ignoreWhitespace, maxLines?: number)` passes
    `{ id, path, scope, ignoreWhitespace, maxLines: maxLines ?? null }`.
  - `getFileContent(id, path, scope, side): Promise<ArrayBuffer>` →
    `invoke<ArrayBuffer>("get_file_content", { id, path, scope, side })`.

### 4.3 Query keys and stores

- `queryKeys.fileDiff(id, path, scope, ignoreWs, maxLines: number | null)`
  (GR-4 call sites, if any, pass `null`).
- `queryKeys.fileContent(id, path, scope, side)`.
- New `src/lib/store/diffPrefs.ts`:

```ts
export type DiffMode = "split" | "unified";
interface DiffPrefs {
  mode: DiffMode;            // default "split"
  ignoreWhitespace: boolean; // default false
  setMode(mode: DiffMode): void;
  setIgnoreWhitespace(on: boolean): void;
}
export const useDiffPrefs = create<DiffPrefs>()(persist(..., { name: "git-real.diffPrefs" }));
```

Persistence failures (no `localStorage`) are swallowed by zustand's
`createJSONStorage`; the store still works in memory.

### 4.4 Files in `src/features/diff/`

Pure model, no React, in `model/`:

| File                 | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model/pairing.ts`   | `pairLines(lines: DiffLine[]): LinePair[]` where `LinePair = { old: number \| null; new: number \| null }` (indices into `lines`). Context → both set to the same index. Deletion run then addition run → zipped; leftovers one-sided.                                                                                                                                                                                                                                                                                                                                                                        |
| `model/rows.ts`      | `buildRows(diff: FileDiff, mode: DiffMode): DiffRow[]`. `DiffRow = { kind: "header"; hunkIndex; header } \| { kind: "unified"; hunkIndex; lineIndex; partner: number \| null } \| { kind: "split"; hunkIndex; old: number \| null; new: number \| null }`. `partner`/`old`+`new` come from `pairLines`. Row `key` strings are stable: `h{hunk}`, `u{hunk}:{line}`, `s{hunk}:{old}:{new}`.                                                                                                                                                                                                                     |
| `model/wordDiff.ts`  | `wordDiff(a: string, b: string): { old: Range[]; new: Range[] }`, `Range = { start: number; end: number }` in UTF-16 offsets. Tokens match `/[\p{L}\p{N}_]+\|\s+\|./gu`. LCS over tokens; adjacent changed tokens merge into one range. Over `WORD_DIFF_MAX_TOKENS` tokens on either side → one range covering the whole line each. Identical lines → empty ranges.                                                                                                                                                                                                                                           |
| `model/highlight.ts` | `languageFor(path: string): LanguageDescription \| null` (`LanguageDescription.matchFilename(languages, basename)`); `tokenize(text: string, parser: Parser): Token[][]` (`Token = { text: string; className: string \| null }`, one array per line, lines split on `\n`); `sideText(hunk, side): { text: string; lineIndices: number[] }` (old = context + deletions, new = context + additions, in order); `highlightHunk(hunk, parser): (Token[] \| null)[]` indexed by `hunk.lines`; context lines take the new side's tokens. Class names come from `classHighlighter` (`tok-keyword`, `tok-string`, …). |
| `model/images.ts`    | `IMAGE_EXTENSIONS = ["png","jpg","jpeg","gif","webp","bmp","ico","avif"]`, `isImagePath(path)`, `mimeFor(path)`. SVG is not listed: it diffs as text.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `model/encoding.ts`  | `encodingLabel(e: TextEncoding): string` ("UTF-8", "UTF-16 LE", "UTF-16 BE", "UTF-32 LE", "UTF-32 BE"); `encodingNotice(diff): string \| null` → `null` when both fields are null, "Decoded from {label}" when equal or one side absent, "Encoding changed from {old} to {new}" otherwise; `isDecoded(diff)`.                                                                                                                                                                                                                                                                                                 |
| `model/limits.ts`    | `HIGHLIGHT_LIMIT = 20_000`, `FULL_DIFF_LINES = 1_000_000`, `WORD_DIFF_MAX_TOKENS = 400`, `totalLines(diff)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Hooks:

| File                  | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useFileDiff.ts`      | `useFileDiff(repoId, file: SelectedFile \| null, ignoreWs, maxLines: number \| null)`: `useQuery` on `queryKeys.fileDiff`, `enabled: file !== null`, `retry: false`, `refetchOnWindowFocus: false`, errors mapped with `toAppError`. Returns `{ diff, error, loading, noChanges }` where `noChanges` is `error?.kind === "noChanges"` and `error` is then `null`.                                               |
| `useFileContent.ts`   | `useFileContent(repoId, path, scope, side, enabled)`: `useQuery` returning `ArrayBuffer`; `retry: false`. Exposes `{ bytes, error, loading }`.                                                                                                                                                                                                                                                                  |
| `useHighlight.ts`     | `useHighlight(diff: FileDiff \| undefined): HighlightMap \| null`, `HighlightMap = Map<number, (Token[] \| null)[]>` keyed by hunk index. Returns `null` when no diff, no language, binary, or `totalLines(diff) > HIGHLIGHT_LIMIT`. Loads the language once per description (module-level cache of promises), then tokenizes every hunk in an effect. A stale load result (diff changed meanwhile) is ignored. |
| `useLineSelection.ts` | `useLineSelection(diff)`: `{ selected: ReadonlySet<number>; hunkIndex: number \| null; click(hunk, line, shift: boolean); clear() }`. Only `addition`/`deletion` lines are selectable. Plain click toggles and sets the anchor; shift-click selects the anchor-to-line range of changed lines within the hunk; a click in another hunk replaces the selection. Reset when `diff` identity changes.              |

Components:

| File                              | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DetailPane.tsx`                  | Replaces the placeholder in `RepoPane`. Props `{ repoId }`. Reads `useWorkspace` selection, `useDiffPrefs`, `useFileDiff`, `useWorktreeActions`. States in order: no selection → "Select a file to view its diff"; loading → "Loading diff…" (`role="status"`); `noChanges` → "No {staged\|unstaged} changes in {path}"; other error → `RepoError` with Retry and Dismiss; binary image → `ImageDiff`; other binary → `BinaryPlaceholder`; decoded with zero hunks → `DiffToolbar` + "Only the encoding changed"; else `DiffToolbar` + `DiffViewer`. Owns `maxLines` state (`null` until "Load full diff", reset on file change), the discard `ConfirmDialog`, and action errors (`RepoError` above the viewer with Dismiss). |
| `DiffToolbar.tsx`                 | File path (`oldPath → path` for renames), mode radio group ("Side by side" / "Unified"), "Hide whitespace changes" checkbox, line count summary (`+a −d`), the encoding notice from `encodingNotice` when present, and the truncation banner `"Showing the first N lines"` with a "Load full diff" button when `diff.truncated`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `DiffViewer.tsx`                  | Props `{ diff; mode; highlight: HighlightMap \| null; selection?: UseLineSelection; onHunkAction?(action: HunkAction, selection: HunkSelection): void; actionsDisabledReason?: string }`. Builds rows with `buildRows`, virtualizes with `useVirtualizer({ count, getScrollElement, estimateSize: () => 22, measureElement })`, and renders `HunkHeader`, `UnifiedRow` or `SplitRow`. Omitting `onHunkAction` and `selection` makes it read-only (GR-9).                                                                                                                                                                                                                                                                      |
| `HunkHeader.tsx`                  | Header text plus buttons. Unstaged scope: "Stage hunk", "Discard hunk…"; staged: "Unstage hunk". With `n` lines selected in this hunk the labels become "Stage {n} lines" / "Discard {n} lines…" / "Unstage {n} lines". Buttons are `disabled` with `title={actionsDisabledReason}` when a reason is given.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `UnifiedRow.tsx` / `SplitRow.tsx` | Gutters are `<button aria-pressed>` for changed lines (toggle selection; shift handled via the event) and plain cells for context. Line numbers right-aligned, `font-variant-numeric: tabular-nums`. The line body is `LineContent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `LineContent.tsx`                 | Renders `tokens ?? [{ text, className: null }]` as spans, splitting spans at word-diff range boundaries and wrapping changed segments in `<mark className={styles.word}>`. Appends the `⏎` "No newline at end of file" marker when `noNewlineAtEof`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ImageDiff.tsx`                   | Fetches old and new bytes with `useFileContent` (old path = `oldPath ?? path`; sides enabled per `change`: added → new only, deleted → old only). Shows two figures with captions "Old {w}×{h}" / "New {w}×{h}" (dimensions read from the `<img>` on load). `tooLarge` → "Image too large to preview" plus the error message per side. Blob URLs revoked on cleanup.                                                                                                                                                                                                                                                                                                                                                          |
| `BinaryPlaceholder.tsx`           | "Binary file — no preview available" with the change kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Styling: CSS Modules per component; new tokens in `src/styles/tokens.css`
(`--color-added-bg`, `--color-removed-bg`, `--color-added-word-bg`,
`--color-removed-word-bg`, `--color-hunk-bg`, `--color-line-selected`) and a
new global `src/styles/syntax.css` mapping `.tok-*` classes to
`--syntax-*` tokens (keyword, string, number, comment, variable, type,
function, operator, punctuation, meta, invalid), light and dark. `RepoPane`
drops `place-items: center` on `.detail` and gives it `min-height: 0;
display: flex; flex-direction: column` so the viewer scrolls inside it.

### 4.5 Behaviour

- Selecting a row in the Changes panel (GR-4) already writes
  `useWorkspace.selected[repoId]`; the pane reacts to it.
- Toggling "Hide whitespace changes" refetches with `ignoreWhitespace: true`;
  hunk and line buttons disable with the reason "Turn off “Hide whitespace
  changes” to stage, unstage or discard hunks".
- Hunk button → `actions.applyHunk(path, action, { hunkIndex, lines })`
  where `lines` is `null` for the whole hunk, otherwise the sorted selected
  indices. `useWorktreeActions` gains the `applyHunk` request kind; the
  existing `onSettled` invalidation refreshes status and diff together.
- Discard (hunk or lines) opens `ConfirmDialog`: title "Discard changes",
  body "Discard this hunk in {path}? This cannot be undone." or "Discard {n}
  selected lines in {path}? This cannot be undone.", confirm label
  "Discard", danger.
- Action errors (`badSelection`, `applyFailed`, …) show above the viewer
  with Dismiss; the refetch triggered by `onSettled` already refreshes the
  stale diff.
- For a decoded file (`isDecoded(diff)`) hunk and line buttons disable with
  the reason "Hunk actions are unavailable for files decoded from UTF-16 or
  UTF-32; stage or discard the whole file from the Changes panel".
- Mode and whitespace preferences apply to every repository tab.
- Switching tabs or files resets line selection and `maxLines`.

### 4.6 Tests

- Model functions: table-driven Vitest tests, including pairing of
  deletion-only, addition-only, uneven runs and interleaved context; word
  diff on identical, fully different, prefix/suffix, whitespace-only and
  over-limit lines; `tokenize` against the real JavaScript parser (`import
{ javascriptLanguage } from "@codemirror/lang-javascript"`) and a stub
  parser; `sideText` index maps; `isImagePath` case-insensitivity.
- Hooks and components: Testing Library with the `vi.mock(import("../../lib/ipc"))`
  recipe. `@tanstack/react-virtual` is mocked in component tests to render
  every row (happy-dom has no layout); real virtualization is checked in the
  acceptance walk by counting DOM rows on a 10 000-line diff.
  `URL.createObjectURL`/`revokeObjectURL` are stubbed in `ImageDiff` tests.
- Coverage stays at 100 % statements and branches for `src/`.

## 5. Definition of Done

1. `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`,
   `npm test` (100 % coverage), `npm run lint`, `npm run typecheck` green.
2. Architect sign-off on the final branch.
3. Acceptance walk in the running app on a fixture repository: both modes,
   highlighting on a `.ts` and a `.rs` file, line numbers on both sides,
   whitespace toggle hides a whitespace-only hunk, PNG preview and a
   non-image binary placeholder, a 50 000-line file scrolls with fewer than
   200 rows in the DOM, word highlights on an edited line, a UTF-16 LE file shows a text diff with
   the encoding notice and disabled hunk buttons, stage one hunk,
   stage two lines, unstage one hunk, discard one hunk with confirmation.
4. Jira GR-5 transitions to Done with the walk results and any decisions
   worth revisiting in a comment.
