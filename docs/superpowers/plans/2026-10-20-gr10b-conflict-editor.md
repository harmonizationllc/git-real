# GR-10b Inline Conflict Editor and Resolve All Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selecting a conflicted file opens an editable, syntax-highlighted CodeMirror pane in the centre column where git's conflict blocks can be kept, taken, combined, undone or hand-edited; edits autosave to the working tree; Mark resolved stages the file; the Conflicts section gains Resolve all….

**Architecture:** The working-tree text is read through the existing `get_file_content` command and decoded in the front end. Conflict blocks are parsed from git's markers once and tracked as mapped ranges in a CodeMirror `StateField`; decorations tint the blocks and a block widget renders the per-block action bar. One new core method, `write_resolution`, writes the text back and optionally stages it. `DetailPane` routes a conflicted selection to the editor; `ChangesPanel` adds the bulk action over the existing `resolve` request.

**Tech Stack:** Rust 2024 + git2 0.20 (`default-features = false`), Tauri 2, React 19 + TypeScript, TanStack Query 5, Zustand 5, CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, existing `@codemirror/language`, `@lezer/highlight`), Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-20-gr10b-conflict-editor-design.md`

## Global Constraints

- Tests first, by the test role; the developer role never edits test files (CLAUDE.md).
- Only `src/lib/ipc` imports `@tauri-apps/api/*` (ESLint-enforced).
- `git2` stays `default-features = false`; no direct `tokio`; blocking work runs through `run_blocking`; `git-real-core` has no Tauri dependency.
- `write_resolution` never writes before the conflict check passes; refuses a symlink or directory at the path with `BadSelection`; writes bytes verbatim (no newline translation); stages with `index.add_path` + `index.write()` inside `reload_on_error`; leaves the index untouched when `stage` is false.
- A conflict marker is a line starting with exactly seven `<`, `|`, `=` or `>` followed by a space or the end of the line. A block is `<<<<<<<` → optional `|||||||` → `=======` → `>>>>>>>` in that order on later lines; anything else is plain text.
- Remaining conflicts are counted by re-parsing the document, never from block states.
- Limits: `MAX_EDIT_BYTES = 2 * 1024 * 1024`; highlighting skipped above `HIGHLIGHT_LIMIT` (20 000) lines; autosave debounce `SAVE_DELAY_MS = 500`; `WRITTEN_MEMORY = 32` recent written texts.
- A plain save invalidates no query; `markResolved` invalidates `queryKeys.repo(repoId)` on completion.
- CSS classes on editor lines: `cm-conflict-marker`, `cm-conflict-ours`, `cm-conflict-base`, `cm-conflict-theirs`, `cm-conflict-resolved`.
- Copy (verbatim, spec §5): `Loading {name}…`; `Can’t edit {name} here`; `It is larger than 2 MB.`; `It is not UTF-8 text.`; `It is missing from the working tree.`; `{n} conflicts remaining` / `1 conflict remaining` / `All conflicts resolved`; buttons `Previous`, `Next`, `Keep all {ours}`, `Take all {theirs}`, `Mark resolved`, `Close`; titles `Resolve all conflicts first`, `Saving…`; block bar `Keep {ours}`, `Take {theirs}`, `Keep both`, `Undo`; state labels `Kept {ours}`, `Took {theirs}`, `Kept both`, `Edited`; bar `aria-label="Conflict {n}"`; pane `aria-label="Conflict editor"`; placeholder buttons `Keep {ours}`, `Take {theirs}`; section button `Resolve all…`; menu items `Keep {ours} for all files`, `Take {theirs} for all files`.
- `{ours}` / `{theirs}` always come from `sideLabels(state, headName(branches?.head))`.
- Gates: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `npm test` at 100 % coverage for `src/`, `npm run lint` (no new warnings), `npm run typecheck`.

## Review Focus

1. A `=======` line in ordinary content (a Markdown setext heading) with no `<<<<<<<` before it must not become a block, and a `<<<<<<<` with no `>>>>>>>` after it must stay plain text (Task 2 tests `ignores a lone separator line`, `ignores an unterminated start marker`).
2. A block whose `>>>>>>>` is the last line without a trailing newline must be replaced without adding one (Task 2 test `drops the final newline when the block ends the file`).
3. An autosave echo from the watcher arriving after the user typed more must not roll the text back (Task 3 test `ignores a watcher echo of an earlier write`).
4. Resolving the open file from the Changes panel (Keep/Take) must reload the editor, which then shows zero conflicts (Task 3 test `reloads when the file changes on disk`).
5. A hand edit that leaves markers behind keeps Mark resolved disabled; one that deletes them enables it (Task 3 tests `counts markers left by a custom edit`, `enables Mark resolved once a custom edit removes the markers`).

---

### Task 1: Core `write_resolution`, Tauri command, IPC wrapper

**Files:**

- Create: `src-tauri/crates/git-real-core/src/merge/write_resolution.rs`
- Modify: `src-tauri/crates/git-real-core/src/merge/mod.rs` (`mod write_resolution;`)
- Modify: `src-tauri/crates/git-real-core/src/merge/resolve.rs` (`conflict_path_is` becomes `pub(super)`)
- Modify: `src-tauri/src/commands/merge.rs` (`write_resolution_inner`, `write_resolution`)
- Modify: `src-tauri/src/lib.rs` (register `commands::merge::write_resolution`)
- Modify: `src/lib/ipc/commands.ts` (`writeResolution`), `src/lib/ipc/index.ts` if it re-exports by name
- Test: `src-tauri/crates/git-real-core/tests/merge.rs` (extend), `src-tauri/tests/merge_commands.rs` (extend), `src/lib/ipc/commands.test.ts` (extend)

**Interfaces:**

- Consumes: `paths::checked_relative`, `RepoSession::{workdir, fresh_index}`, `index_ops::reload_on_error`, `resolve::conflict_path_is`, `GitError::{PathNotFound, BadSelection, Io}`, `commands::{run_blocking, with_session}`.
- Produces:

```rust
impl RepoSession {
    /// Writes `text` to the conflicted `path` and, when `stage` is set, stages it,
    /// which clears the path's conflict entries.
    pub fn write_resolution(&self, path: &str, text: &str, stage: bool) -> Result<(), GitError>;
}
// app
pub fn write_resolution_inner(reg: &RepoRegistry, id: RepoId, path: &str, text: &str, stage: bool) -> Result<(), AppError>;
#[tauri::command] pub async fn write_resolution(reg: State<'_, Arc<RepoRegistry>>, id: RepoId, path: String, text: String, stage: bool) -> Result<(), AppError>;
```

```ts
/** Writes an edited resolution to a conflicted path; `stage` also stages it. */
export function writeResolution(
  id: RepoId,
  path: string,
  text: string,
  stage: boolean,
): Promise<void>;
```

- [ ] **Step 1: Write the failing tests** — in `tests/merge.rs`, on `temp_repo_with_conflict()` (README.md conflicted):
  - `write_resolution_with_stage_writes_bytes_and_clears_the_conflict`: `write_resolution("README.md", "merged\r\nline\r\n", true)` → file bytes equal exactly `merged\r\nline\r\n`; `fresh_index().has_conflicts() == false`; `status()` lists `README.md` with `index == Some(Modified)` and `conflicted == false`.
  - `write_resolution_without_stage_leaves_the_conflict`: `stage = false` → file written; `has_conflicts() == true`; `status()` entry still `conflicted`.
  - `write_resolution_on_an_unconflicted_path_is_path_not_found`: on the same fixture, a clean tracked file (`write_file` + `commit_all` beforehand, or any committed file) → `Err(PathNotFound)` and the file's bytes unchanged.
  - `write_resolution_on_a_missing_path_is_path_not_found`: `"nope.txt"` → `PathNotFound`, no file created.
  - `write_resolution_rejects_a_path_outside_the_work_tree`: `"../x"` → `Err(_)` and no file at `root.parent()/x`.
  - `write_resolution_refuses_a_symlink_at_the_path` (`#[cfg(unix)]`): remove `README.md`, `std::os::unix::fs::symlink("/etc/hostname", root.join("README.md"))` → `Err(BadSelection)`; the link still points at `/etc/hostname`; `has_conflicts()` still true.
  - `write_resolution_refuses_a_directory_at_the_path`: remove the file, `create_dir` in its place → `BadSelection`.
  - `write_resolution_keeps_the_executable_bit` (`#[cfg(unix)]`): `chmod 0o755` the conflicted file first → after writing, `mode & 0o111 != 0`.
  - `write_resolution_recreates_a_deleted_file_with_parents`: fixture variant where the conflicted path is `dir/sub/file.txt` (`diverged_fixture`-style: both branches edit `dir/sub/file.txt`, then `run_git_ok(root, &["merge", "other"])`), `remove_dir_all("dir")` → write with `stage = true` succeeds; file exists with the bytes; no conflicts.
  - `write_resolution_index_is_untouched_when_the_write_fails`: with the directory-at-path case, `fresh_index().has_conflicts()` stays true and `status()` is unchanged.
  - In `src-tauri/tests/merge_commands.rs`: `write_resolution_inner_stages_the_text` (round-trip through the registry: `has_conflicts` false after, `get_status_inner` entry not conflicted) and `write_resolution_inner_maps_path_not_found` (clean path → `AppErrorKind::PathNotFound`).
  - In `src/lib/ipc/commands.test.ts`: `writeResolution sends write_resolution with id, path, text and stage` (`invoke` called with `("write_resolution", { id: 2, path: "a.txt", text: "x\n", stage: true })`).

- [ ] **Step 2: Run to verify failure** — `cd src-tauri && cargo test -p git-real-core --test merge write_resolution` (compile error: no method), `cargo test --test merge_commands write_resolution`, `npm test -- src/lib/ipc/commands.test.ts`.

- [ ] **Step 3: Implement** — `write_resolution.rs`:

```rust
//! Writing an edited resolution back to a conflicted path.

use std::path::{Path, PathBuf};

use git2::IndexConflict;

use super::resolve::conflict_path_is;
use crate::error::GitError;
use crate::index_ops::reload_on_error;
use crate::paths::checked_relative;
use crate::repo::RepoSession;

impl RepoSession {
    /// Writes `text` to the conflicted `path` and, when `stage` is set, stages it,
    /// which clears the path's conflict entries.
    ///
    /// Nothing is written unless the path is conflicted in a fresh index. A symlink
    /// or directory at the path is refused with `BadSelection`. Bytes are written
    /// exactly as given; the caller owns line endings.
    pub fn write_resolution(&self, path: &str, text: &str, stage: bool) -> Result<(), GitError> {
        let workdir = self.workdir()?;
        let rel = checked_relative(workdir, path)?;
        let mut index = self.fresh_index()?;
        let conflicts = index
            .conflicts()?
            .collect::<Result<Vec<IndexConflict>, _>>()?;
        if !conflicts.iter().any(|c| conflict_path_is(c, &rel)) {
            return Err(GitError::PathNotFound(PathBuf::from(&rel)));
        }
        let full = workdir.join(&rel);
        if let Ok(meta) = full.symlink_metadata() {
            if meta.file_type().is_symlink() || meta.is_dir() {
                return Err(GitError::BadSelection);
            }
        }
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&full, text.as_bytes())?;
        if !stage {
            return Ok(());
        }
        let staged = (|| {
            index.add_path(Path::new(&rel))?;
            index.write()?;
            Ok(())
        })();
        reload_on_error(&mut index, staged)
    }
}
```

`resolve.rs`: `pub(super) fn conflict_path_is(...)`. `mod.rs`: `mod write_resolution;`. App `commands/merge.rs`:

```rust
pub fn write_resolution_inner(
    reg: &RepoRegistry,
    id: RepoId,
    path: &str,
    text: &str,
    stage: bool,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.write_resolution(path, text, stage))
}

#[tauri::command]
pub async fn write_resolution(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    path: String,
    text: String,
    stage: bool,
) -> Result<(), AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || write_resolution_inner(&reg, id, &path, &text, stage)).await
}
```

Register in `lib.rs` next to `resolve_conflicts`. `commands.ts`:

```ts
/** Writes an edited resolution to a conflicted path; `stage` also stages it. */
export function writeResolution(
  id: RepoId,
  path: string,
  text: string,
  stage: boolean,
): Promise<void> {
  return invoke<void>("write_resolution", { id, path, text, stage });
}
```

- [ ] **Step 4: Run to verify pass** — `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `npm test -- src/lib/ipc`.

- [ ] **Step 5: Commit** — `feat(core): write an edited conflict resolution and stage it`.

---

### Task 2: Editor foundations — dependencies, text decoding, marker parsing, `loadLanguage`, block state, action bar, `EditorPane`

**Files:**

- Modify: `package.json` (`@codemirror/view`, `@codemirror/state`, `@codemirror/commands` as dependencies; `npm install`)
- Create: `src/features/merge/editor/model/text.ts`, `model/markers.ts`, `model/blocks.ts`, `model/blockBar.ts`
- Create: `src/features/merge/editor/EditorPane.tsx`, `EditorPane.module.css`
- Modify: `src/features/diff/model/highlight.ts` (`loadLanguage`; `loadParser` derives from it)
- Test: `src/features/merge/editor/model/text.test.ts`, `markers.test.ts`, `blocks.test.ts`, `blockBar.test.ts`, `src/features/merge/editor/EditorPane.test.tsx`, `src/features/diff/model/highlight.test.ts` (extend)

**Interfaces:**

- Consumes: `languageFor`, `HIGHLIGHT_LIMIT` (diff model), `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language` (`syntaxHighlighting`, `LanguageSupport`), `@lezer/highlight` (`classHighlighter`).
- Produces:

```ts
// model/text.ts
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export type NotEditable = "tooLarge" | "notText";
export interface EditableText {
  text: string;
  crlf: boolean;
}
export function decodeEditable(bytes: ArrayBuffer): EditableText | NotEditable;
export function encodeForDisk(text: string, crlf: boolean): string;
export function lineCount(text: string): number;

// model/markers.ts
export interface ConflictBlock {
  from: number;
  to: number;
  ours: string;
  base: string | null;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
  trailingNewline: boolean;
}
export type Choice = "ours" | "theirs" | "both";
export function parseConflicts(text: string): ConflictBlock[];
export function replacementFor(block: ConflictBlock, choice: Choice): string;

// model/blocks.ts
export type BlockState = "unresolved" | "ours" | "theirs" | "both" | "custom";
export interface TrackedBlock extends ConflictBlock {
  id: number;
  state: BlockState;
  original: string;
}
export interface BlockLabels {
  ours: string;
  theirs: string;
}
export const pickBlock: StateEffectType<{ id: number; choice: Choice | "restore" }>;
export const resetBlocks: StateEffectType<string>;
export const blockLabels: Facet<BlockLabels, BlockLabels>;
export function conflictBlocks(): Extension; // field + decorations + base theme
export function blocksOf(state: EditorState): TrackedBlock[];
export function remainingConflicts(state: EditorState): number;
export function pick(view: EditorView, id: number, choice: Choice | "restore"): void;
export function pickAll(view: EditorView, choice: Choice): void;
export function goToConflict(view: EditorView, dir: 1 | -1): boolean;

// model/blockBar.ts
export class BlockBarWidget extends WidgetType {
  constructor(block: TrackedBlock, index: number, labels: BlockLabels);
}

// EditorPane.tsx
export interface EditorPaneProps {
  initialText: string;
  extensions: Extension[];
  onDocChange(text: string): void;
  viewRef: RefObject<EditorView | null>;
  ariaLabel: string;
}
export function EditorPane(props: EditorPaneProps): JSX.Element;

// diff/model/highlight.ts
export function loadLanguage(desc: LanguageDescription): Promise<LanguageSupport>;
```

- [ ] **Step 1: Write the failing tests**

  `text.test.ts`: `decodes UTF-8 and reports no CRLF`; `normalises CRLF to LF and reports crlf`; `returns tooLarge above MAX_EDIT_BYTES` (a `new ArrayBuffer(MAX_EDIT_BYTES + 1)`); `returns notText for invalid UTF-8` (`new Uint8Array([0xff, 0xfe, 0x41]).buffer`); `returns notText when the text holds U+0000`; `encodeForDisk restores CRLF only when asked`; `lineCount counts newline-terminated lines` (`"a\nb\n"` → 2, `""` → 1? define: `text.split("\n").length`, so `""` → 1 and `"a\nb\n"` → 3; tests pin that).

  `markers.test.ts`: `parses one block with labels and offsets` (`"a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\nb\n"` → one block `{from: 2, to: 38, ours: "x\n", base: null, theirs: "y\n", oursLabel: "HEAD", theirsLabel: "feature", trailingNewline: true}` — the tester computes `to` from the string); `parses two blocks in order`; `parses a diff3 block with base`; `parses empty sides` (`<<<<<<< a\n=======\n>>>>>>> b\n` → ours `""`, theirs `""`); `ignores a lone separator line` (`"Title\n=======\nbody\n"` → `[]`); `ignores an unterminated start marker`; `ignores markers that are not at line start`; `ignores markers of the wrong length` (`<<<<<<<<` eight → plain); `accepts a marker with no label` (`<<<<<<<\n`); `treats a start inside a block as text until the block ends` (second `<<<<<<<` before `=======` → the outer block still parses once a `=======` and `>>>>>>>` follow? Decide and pin: a second `<<<<<<<` before `=======` restarts the block at the later start — the earlier start is plain text); `replacementFor returns ours, theirs, both`; `drops the final newline when the block ends the file` (text ends with `>>>>>>> b` and no newline → `trailingNewline: false`, `replacementFor(block, "ours")` has no trailing `\n`; with empty ours → `""`).

  `blocks.test.ts` (headless `EditorState.create({ doc, extensions: [conflictBlocks()] })`): `tracks every parsed block as unresolved with its original text`; `pick ours replaces the block and sets the state` (apply `state.update({ changes, effects: pickBlock.of(...) })` as `pick` does; check doc and `blocksOf`); `pick theirs`, `pick both`; `restore writes the original text back and sets unresolved`; `maps block ranges through edits before the block`; `a typed change inside a block makes it custom`; `an insertion at a block boundary does not make it custom`; `a pick does not make its own block custom`; `resetBlocks replaces tracking from new text`; `remainingConflicts counts markers in the document` (after a pick of one of two → 1; after a custom edit that deletes the markers → 0; after a custom edit that keeps them → unchanged); `pickAll resolves only unresolved blocks` (needs an `EditorView` — put with the view tests below if the spike fails headlessly); `goToConflict cycles forward and backward and returns false with none`; decorations: `tints marker, ours, base and theirs lines of an unresolved block` and `tints a resolved block` (read `state.facet(EditorView.decorations)` and iterate the `RangeSet`s for class names `cm-conflict-*`); `blockLabels defaults to ours and theirs`.

  `blockBar.test.ts`: `renders three buttons for an unresolved block` (`toDOM(view)` with a stub view, `role="group"`, `aria-label="Conflict 2"`, buttons `Keep main`, `Take feature`, `Keep both`); `renders a state label and Undo for ours, theirs, both and custom` (`Kept main`, `Took feature`, `Kept both`, `Edited`); `eq is true for the same id, state and labels and false otherwise`; `clicking a button picks that choice` (stub view with a `dispatch` spy — assert the dispatched transaction spec inserts the expected text and carries `pickBlock`).

  `EditorPane.test.tsx` — **the happy-dom spike** (run first): `mounts an EditorView with the initial text` (`screen.getByRole("textbox", { name: "Conflict editor" })` or the `.cm-content` contenteditable; `viewRef.current?.state.doc.toString()` equals the text); `calls onDocChange after a dispatch`; `destroys the view on unmount`; `applies the extra extensions`. If `new EditorView` throws under happy-dom, add `// @vitest-environment jsdom` as the first line of the file, add `jsdom` to devDependencies, and record the ruling in the ledger; keep the test contract unchanged.

  `highlight.test.ts` (extend): `loadLanguage returns the LanguageSupport and shares the cache with loadParser` (both resolve from one `desc.load()` call); `a failed loadLanguage is not cached`.

- [ ] **Step 2: Run to verify failure** — `npm test -- src/features/merge/editor src/features/diff/model/highlight.test.ts`.

- [ ] **Step 3: Implement**

  `npm install @codemirror/view @codemirror/state @codemirror/commands` (exact versions as resolved; `@codemirror/view` ≥ 6.43, `@codemirror/state` ≥ 6.7).

  `text.ts`:

```ts
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export type NotEditable = "tooLarge" | "notText";
export interface EditableText {
  text: string;
  crlf: boolean;
}

/** Strict UTF-8 text with LF line endings, or why the bytes cannot be edited here. */
export function decodeEditable(bytes: ArrayBuffer): EditableText | NotEditable {
  if (bytes.byteLength > MAX_EDIT_BYTES) return "tooLarge";
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "notText";
  }
  if (raw.includes("\u0000")) return "notText";
  const crlf = raw.includes("\r\n");
  return { text: crlf ? raw.replaceAll("\r\n", "\n") : raw, crlf };
}

export function encodeForDisk(text: string, crlf: boolean): string {
  return crlf ? text.replaceAll("\n", "\r\n") : text;
}

export function lineCount(text: string): number {
  return text.split("\n").length;
}
```

`markers.ts`:

```ts
export interface ConflictBlock {
  from: number;
  to: number;
  ours: string;
  base: string | null;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
  trailingNewline: boolean;
}
export type Choice = "ours" | "theirs" | "both";

type Marker = "<" | "|" | "=" | ">";

/** The marker kind and label of a line, or null for an ordinary line. */
function markerOf(line: string): { kind: Marker; label: string } | null {
  const ch = line[0];
  if (ch !== "<" && ch !== "|" && ch !== "=" && ch !== ">") return null;
  const seven = ch.repeat(7);
  if (!line.startsWith(seven)) return null;
  const rest = line.slice(7);
  if (rest !== "" && !rest.startsWith(" ")) return null;
  return { kind: ch, label: rest.slice(1) };
}

interface Line {
  text: string;
  from: number;
  to: number;
  newline: boolean;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  let from = 0;
  while (from <= text.length) {
    const nl = text.indexOf("\n", from);
    const end = nl === -1 ? text.length : nl;
    if (nl === -1 && from === text.length && out.length > 0) break; // no empty line after a final "\n"
    out.push({
      text: text.slice(from, end),
      from,
      to: nl === -1 ? end : nl + 1,
      newline: nl !== -1,
    });
    if (nl === -1) break;
    from = nl + 1;
  }
  return out;
}

const join = (ls: Line[]) => ls.map((l) => l.text + "\n").join("");

/** Git's conflict blocks in document order; malformed markers are plain text. */
export function parseConflicts(text: string): ConflictBlock[] {
  const ls = lines(text);
  const blocks: ConflictBlock[] = [];
  let start = -1;
  let bar = -1;
  let eq = -1;
  for (let i = 0; i < ls.length; i++) {
    const m = markerOf(ls[i].text);
    if (!m) continue;
    if (m.kind === "<") {
      start = i;
      bar = -1;
      eq = -1;
    } else if (start === -1) continue;
    else if (m.kind === "|") {
      if (eq === -1) bar = i;
    } else if (m.kind === "=") {
      if (eq === -1) eq = i;
    } else if (eq !== -1) {
      const oursEnd = bar === -1 ? eq : bar;
      blocks.push({
        from: ls[start].from,
        to: ls[i].to,
        ours: join(ls.slice(start + 1, oursEnd)),
        base: bar === -1 ? null : join(ls.slice(bar + 1, eq)),
        theirs: join(ls.slice(eq + 1, i)),
        oursLabel: markerOf(ls[start].text)?.label ?? "",
        theirsLabel: m.label,
        trailingNewline: ls[i].newline,
      });
      start = -1;
      bar = -1;
      eq = -1;
    }
  }
  return blocks;
}

export function replacementFor(block: ConflictBlock, choice: Choice): string {
  const text =
    choice === "ours" ? block.ours : choice === "theirs" ? block.theirs : block.ours + block.theirs;
  return block.trailingNewline || !text.endsWith("\n") ? text : text.slice(0, -1);
}
```

`blocks.ts`:

```ts
import { EditorState, Facet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { BlockBarWidget } from "./blockBar";
import { parseConflicts, replacementFor, type Choice, type ConflictBlock } from "./markers";

export type BlockState = "unresolved" | "ours" | "theirs" | "both" | "custom";
export interface TrackedBlock extends ConflictBlock {
  id: number;
  state: BlockState;
  original: string;
}
export interface BlockLabels {
  ours: string;
  theirs: string;
}

export const pickBlock = StateEffect.define<{ id: number; choice: Choice | "restore" }>();
export const resetBlocks = StateEffect.define<string>();
export const blockLabels = Facet.define<BlockLabels, BlockLabels>({
  combine: (values) => values[0] ?? { ours: "ours", theirs: "theirs" },
});

const track = (text: string): TrackedBlock[] =>
  parseConflicts(text).map((b, id) => ({
    ...b,
    id,
    state: "unresolved",
    original: text.slice(b.from, b.to),
  }));

const field = StateField.define<TrackedBlock[]>({
  create: (state) => track(state.doc.toString()),
  update(blocks, tr) {
    for (const e of tr.effects) if (e.is(resetBlocks)) return track(e.value);
    if (!tr.docChanged && !tr.effects.some((e) => e.is(pickBlock))) return blocks;
    const picked = new Map(
      tr.effects.filter((e) => e.is(pickBlock)).map((e) => [e.value.id, e.value.choice]),
    );
    return blocks.map((b) => {
      let touched = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA < b.to && toA > b.from) touched = true;
      });
      const choice = picked.get(b.id);
      const state: BlockState =
        choice === undefined
          ? touched
            ? "custom"
            : b.state
          : choice === "restore"
            ? "unresolved"
            : choice;
      return { ...b, from: tr.changes.mapPos(b.from, -1), to: tr.changes.mapPos(b.to, 1), state };
    });
  },
});

export const blocksOf = (state: EditorState): TrackedBlock[] => state.field(field);
export const remainingConflicts = (state: EditorState): number =>
  parseConflicts(state.doc.toString()).length;

const line = (cls: string) => Decoration.line({ class: cls });
const MARKER = line("cm-conflict-marker");
const OURS = line("cm-conflict-ours");
const BASE = line("cm-conflict-base");
const THEIRS = line("cm-conflict-theirs");
const RESOLVED = line("cm-conflict-resolved");

const countLines = (s: string) => (s === "" ? 0 : s.split("\n").length - 1);

function decorate(state: EditorState): DecorationSet {
  const labels = state.facet(blockLabels);
  const ranges: ReturnType<Decoration["range"]>[] = [];
  blocksOf(state).forEach((b, i) => {
    ranges.push(
      Decoration.widget({
        widget: new BlockBarWidget(b, i + 1, labels),
        block: true,
        side: -1,
      }).range(b.from),
    );
    if (b.state === "custom" || b.from === b.to) return;
    const first = state.doc.lineAt(b.from).number;
    const last = state.doc.lineAt(Math.max(b.from, b.to - 1)).number;
    if (b.state !== "unresolved") {
      for (let n = first; n <= last; n++) ranges.push(RESOLVED.range(state.doc.line(n).from));
      return;
    }
    const plan: Decoration[] = [MARKER, ...Array<Decoration>(countLines(b.ours)).fill(OURS)];
    if (b.base !== null) plan.push(MARKER, ...Array<Decoration>(countLines(b.base)).fill(BASE));
    plan.push(MARKER, ...Array<Decoration>(countLines(b.theirs)).fill(THEIRS), MARKER);
    plan.forEach((deco, k) => {
      const n = first + k;
      if (n <= last) ranges.push(deco.range(state.doc.line(n).from));
    });
  });
  return Decoration.set(ranges, true);
}

const theme = EditorView.baseTheme({
  ".cm-conflict-marker": {
    background: "var(--conflict-marker-bg, rgba(128,128,128,.25))",
    fontWeight: "600",
  },
  ".cm-conflict-ours": { background: "var(--conflict-ours-bg, rgba(64,128,255,.15))" },
  ".cm-conflict-base": {
    background: "var(--conflict-base-bg, rgba(128,128,128,.1))",
    opacity: "0.7",
  },
  ".cm-conflict-theirs": { background: "var(--conflict-theirs-bg, rgba(64,200,96,.15))" },
  ".cm-conflict-resolved": { background: "var(--conflict-resolved-bg, rgba(255,255,255,.04))" },
});

export function conflictBlocks(): Extension {
  return [field, EditorView.decorations.compute([field, blockLabels], decorate), theme];
}

export function pick(view: EditorView, id: number, choice: Choice | "restore"): void {
  const block = blocksOf(view.state).find((b) => b.id === id);
  if (!block) return;
  const insert = choice === "restore" ? block.original : replacementFor(block, choice);
  view.dispatch({
    changes: { from: block.from, to: block.to, insert },
    effects: pickBlock.of({ id, choice }),
  });
  view.focus();
}

export function pickAll(view: EditorView, choice: Choice): void {
  const open = blocksOf(view.state).filter((b) => b.state === "unresolved");
  if (open.length === 0) return;
  view.dispatch({
    changes: open.map((b) => ({ from: b.from, to: b.to, insert: replacementFor(b, choice) })),
    effects: open.map((b) => pickBlock.of({ id: b.id, choice })),
  });
}

export function goToConflict(view: EditorView, dir: 1 | -1): boolean {
  const blocks = parseConflicts(view.state.doc.toString());
  if (blocks.length === 0) return false;
  const head = view.state.selection.main.head;
  const after = blocks.filter((b) => b.from > head);
  const before = blocks.filter((b) => b.from < head);
  const target =
    dir === 1 ? (after[0] ?? blocks[0]) : (before[before.length - 1] ?? blocks[blocks.length - 1]);
  view.dispatch({
    selection: { anchor: target.from },
    effects: EditorView.scrollIntoView(target.from, { y: "start" }),
  });
  return true;
}
```

`blockBar.ts` (widget `toDOM(view)` builds `div[role=group][aria-label="Conflict {index}"].cm-conflict-bar`; unresolved → three `button`s; otherwise a `span` label + `Undo`; each button's `onclick` calls `pick(view, block.id, choice)` imported from `./blocks`; `eq(other)` compares `block.id`, `block.state`, `index`, `labels.ours`, `labels.theirs`; `ignoreEvent()` returns `true` so CodeMirror leaves the buttons to the DOM). Import cycle `blocks ↔ blockBar` is avoided by passing an `onPick` callback into the widget constructor: `new BlockBarWidget(b, i + 1, labels, (id, choice) => pick(view, id, choice))` is not possible inside `decorate` (no view there) — so `toDOM(view)` receives the view, and `blockBar.ts` imports `pick` lazily through a tiny injected module: define `export type PickFn = (view: EditorView, id: number, choice: Choice | "restore") => void;` in `blockBar.ts` and have `blocks.ts` call `setPickHandler(pick)` once at module load. Keep it that simple; the tester's stub view tests `setPickHandler` with a spy.

`EditorPane.tsx`:

```tsx
export function EditorPane({
  initialText,
  extensions,
  onDocChange,
  viewRef,
  ariaLabel,
}: EditorPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(onDocChange);
  latest.current = onDocChange;
  useEffect(() => {
    const view = new EditorView({
      doc: initialText,
      parent: host.current as HTMLDivElement,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current(u.state.doc.toString());
        }),
        syntaxHighlighting(classHighlighter),
        paneTheme,
        ...extensions,
      ],
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view mounts once; later changes go through viewRef (effects and compartments).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={host} className={styles.pane} />;
}
```

`paneTheme = EditorView.theme({ "&": { height: "100%", background: "var(--bg)", color: "var(--fg)" }, ".cm-scroller": { fontFamily: "var(--mono)", overflow: "auto" }, ".cm-gutters": { background: "var(--bg-muted)", color: "var(--fg-muted)", border: "none" } })` using the variable names found in `src/styles/*.css` (the developer substitutes the project's actual tokens; `syntax.css` already styles `.tok-*`).

`highlight.ts`: the cache becomes `Map<string, Promise<LanguageSupport>>`; `loadLanguage(desc)` holds the existing load-and-evict logic; `loadParser(desc) = loadLanguage(desc).then((s) => s.language.parser)`.

- [ ] **Step 4: Run to verify pass** — `npm test -- src/features/merge/editor src/features/diff/model`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(ui): conflict editor foundations — markers, block state, editor pane`.

---

### Task 3: Conflict editor — writer hook, toolbar, container, `DetailPane` routing

**Files:**

- Create: `src/features/merge/editor/useResolutionWriter.ts`, `ConflictToolbar.tsx`, `ConflictEditor.tsx`, `ConflictEditor.module.css`
- Modify: `src/features/diff/DetailPane.tsx` (routing)
- Test: `useResolutionWriter.test.tsx`, `ConflictToolbar.test.tsx`, `ConflictEditor.test.tsx`, `src/features/diff/DetailPane.test.tsx` (extend)

**Interfaces:**

- Consumes: Task 1 `writeResolution`; Task 2 models and `EditorPane`; `useFileContent`, `useStatus`, `useOperationState`, `useBranches`, `useIntegrationActions`, `sideLabels`, `headName`, `RepoError`, `useWorkspace`, `languageFor`, `loadLanguage`, `HIGHLIGHT_LIMIT`.
- Produces:

```ts
export const SAVE_DELAY_MS = 500;
export const WRITTEN_MEMORY = 32;
export interface UseResolutionWriter {
  scheduleSave(text: string): void;
  discardPending(): void;
  flush(): Promise<void>;
  markResolved(text: string): Promise<AppError | null>;
  wasWritten(text: string): boolean; // among the last WRITTEN_MEMORY texts sent
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}
export function useResolutionWriter(
  repoId: RepoId,
  path: string,
  crlf: boolean,
): UseResolutionWriter;

export interface ConflictToolbarProps {
  path: string;
  remaining: number | null; // null: loading/placeholder — only path and Close show
  labels: BlockLabels;
  pending: boolean;
  onPrevious(): void;
  onNext(): void;
  onKeepAll(): void;
  onTakeAll(): void;
  onMarkResolved(): void;
  onClose(): void;
}
export function ConflictToolbar(props: ConflictToolbarProps): JSX.Element;

export function ConflictEditor({ repoId, path }: { repoId: RepoId; path: string }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

  `useResolutionWriter.test.tsx` (fake timers; `writeResolution` mocked at the seam): `scheduleSave writes once after the delay with the latest text` (two schedules within 500 ms → one call with the second text, `stage: false`, text passed through `encodeForDisk` when `crlf`); `flush sends a pending save immediately and resolves after it`; `discardPending drops a queued save`; `writes are serialised` (second write starts after the first resolves); `markResolved flushes, writes with stage true, invalidates the repo prefix and resolves null`; `markResolved resolves the AppError and sets error without invalidating`; `a failed autosave sets error; clearError clears it`; `wasWritten remembers the last 32 texts only`; `pending is true while a write is in flight`; `unmount flushes a queued save`.

  `ConflictToolbar.test.tsx`: `shows only the path and Close when remaining is null`; `shows the count copy for 0, 1 and n`; `disables Previous, Next, Keep all and Take all at zero`; `disables Mark resolved with "Resolve all conflicts first" while remaining > 0`; `disables Mark resolved with "Saving…" while pending`; `fires every callback`.

  `ConflictEditor.test.tsx` (`renderWithProviders`, seam mocked: `getFileContent`, `getStatus`, `getOperationState`, `listBranches`, `writeResolution`, `resolveConflicts`; a merge state with `branch: "feature"` and HEAD `main`): `shows Loading {name}… with role status`; `shows the placeholder with reasons` for `tooLarge` bytes, invalid UTF-8, a `tooLarge` AppError, a `binaryFile` AppError, a `pathNotFound` AppError (`It is missing from the working tree.`), and another error (its message); `placeholder Keep and Take resolve the file` (`resolveConflicts(id, [path], "ours"|"theirs")`); `renders the editor with the block bars and the count` (`2 conflicts remaining`, two groups `Conflict 1`, `Conflict 2`); `Keep main on a block resolves it and the count drops`; `Keep all / Take all resolve every block`; `typing schedules an autosave` (advance timers → `writeResolution(id, path, text, false)`, CRLF restored when the source had CRLF); `counts markers left by a custom edit` and `enables Mark resolved once a custom edit removes the markers`; `Mark resolved flushes, stages and reselects the file as staged` (`useWorkspace.getState().selected[id]` equals `{ path, scope: "staged" }`); `Mark resolved failure shows the error strip with Dismiss`; `reloads when the file changes on disk` (refetch delivers a different text → doc replaced, blocks re-parsed, count updated); `ignores a watcher echo of an earlier write` (type `a`, autosave sends `a`, type `b`, refetch delivers `a` → doc still `…b`); `ignores a refetch equal to the current document`; `labels follow the operation state` (rebase → `Keep main` / `Take topic` from `sideLabels`); `loads language support for a known extension and skips it above HIGHLIGHT_LIMIT` (mock `loadLanguage`); `Close clears the selection`; `Previous and Next move the selection between blocks`.

  `DetailPane.test.tsx` (extend): `routes a conflicted unstaged selection to the ConflictEditor` (mock `./…/merge/editor/ConflictEditor` to a marker element; status entry `conflicted: true`); `keeps the diff for a staged selection of the same path`; `keeps the diff when the entry is not conflicted`.

- [ ] **Step 2: Run to verify failure** — `npm test -- src/features/merge/editor src/features/diff/DetailPane.test.tsx`.

- [ ] **Step 3: Implement**

  `useResolutionWriter.ts`:

```ts
export function useResolutionWriter(
  repoId: RepoId,
  path: string,
  crlf: boolean,
): UseResolutionWriter {
  const queryClient = useQueryClient();
  const [error, setError] = useState<AppError | null>(null);
  const [inFlight, setInFlight] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queued = useRef<string | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const written = useRef<string[]>([]);

  const write = useCallback(
    (text: string, stage: boolean): Promise<AppError | null> => {
      setInFlight((n) => n + 1);
      written.current = [...written.current.slice(-(WRITTEN_MEMORY - 1)), text];
      const run = chain.current.then(() =>
        writeResolution(repoId, path, encodeForDisk(text, crlf), stage).then(
          () => null,
          (e: unknown) => toAppError(e),
        ),
      );
      chain.current = run;
      return run.finally(() => setInFlight((n) => n - 1));
    },
    [repoId, path, crlf],
  );

  const discardPending = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    queued.current = null;
  }, []);

  const flush = useCallback((): Promise<void> => {
    const text = queued.current;
    discardPending();
    if (text === null) return chain.current.then(() => undefined);
    return write(text, false).then((e) => {
      if (e !== null) setError(e);
    });
  }, [discardPending, write]);

  const scheduleSave = useCallback(
    (text: string) => {
      queued.current = text;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  const markResolved = useCallback(
    async (text: string) => {
      await flush();
      const e = await write(text, true);
      if (e !== null) setError(e);
      else await queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) });
      return e;
    },
    [flush, write, queryClient, repoId],
  );

  useEffect(() => () => void flush(), [flush]);

  return {
    scheduleSave,
    discardPending,
    flush,
    markResolved,
    wasWritten: (text) => written.current.includes(text),
    pending: inFlight > 0,
    error,
    clearError: () => setError(null),
  };
}
```

`ConflictEditor.tsx`: outer component reads `useFileContent(repoId, path, "unstaged", "new", true)`, `useOperationState`, `useBranches`, computes `labels = sideLabels(state, headName(branches?.head))`, `decoded = useMemo(() => (bytes ? decodeEditable(bytes) : null), [bytes])`, and renders:

- loading → `<ConflictToolbar remaining={null} …/>` + `<p role="status">Loading {name}…</p>`;
- error or non-editable → toolbar (`remaining={null}`) + `<Placeholder name reason labels onKeep onTake disabled={integration.pending} error={integration.error} />` where `reason` is derived as spec §4.7 lists; Keep/Take call `integration.run({ action: "resolve", paths: [path], side })`;
- editable → `<EditableConflict key={path} repoId path name source={decoded.text} crlf={decoded.crlf} labels />`.

`EditableConflict` holds `viewRef`, `writer = useResolutionWriter(repoId, path, crlf)`, `remaining` state (initial `parseConflicts(source).length`), two `Compartment`s (labels, language) in refs, and `extensions = useMemo(() => [conflictBlocks(), labelsComp.of(blockLabels.of(labels)), languageComp.of([])], [])` (mount-time only; the eslint rule is silenced with the same one-line comment as `EditorPane`). Effects:

- labels change → `view.dispatch({ effects: labelsComp.reconfigure(blockLabels.of(labels)) })`;
- language: `if (lineCount(source) > HIGHLIGHT_LIMIT) return; const desc = languageFor(path); if (!desc) return;` then `loadLanguage(desc)` → reconfigure; `console.error("language load failed", e)` on rejection; cancelled on cleanup;
- reload rule on `source` change: `const view = viewRef.current; if (!view) return; const doc = view.state.doc.toString(); if (source === doc || writer.wasWritten(source)) return; writer.discardPending(); view.dispatch({ changes: { from: 0, to: doc.length, insert: source }, effects: resetBlocks.of(source) }); setRemaining(parseConflicts(source).length);`
- `onDocChange(text)`: `setRemaining(remainingConflicts(view.state))`; `writer.scheduleSave(text)`.
- toolbar callbacks: `goToConflict(view, ±1)`, `pickAll(view, "ours"|"theirs")`, `markResolved`: `const text = view.state.doc.toString(); const e = await writer.markResolved(text); if (e === null) useWorkspace.getState().select(repoId, { path, scope: "staged" });`; `Close`: `select(repoId, null)`.
- render: toolbar, `{writer.error && <RepoError error={writer.error} path={null} onDismiss={writer.clearError} />}`, `<EditorPane initialText={source} extensions onDocChange viewRef ariaLabel="Conflict editor" />`.

`DetailPane.tsx` outer:

```tsx
export function DetailPane({ repoId }: { repoId: RepoId }) {
  const file = useWorkspace((s) => s.selected[repoId] ?? null);
  const { status } = useStatus(repoId);
  if (file === null) return null;
  const conflicted =
    file.scope === "unstaged" &&
    (status?.entries.some((e) => e.path === file.path && e.conflicted) ?? false);
  if (conflicted)
    return <ConflictEditor key={`conflict:${file.path}`} repoId={repoId} path={file.path} />;
  return <FileDetail key={`${scopeId(file.scope)}:${file.path}`} repoId={repoId} file={file} />;
}
```

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`; coverage 100 % for `src/`.

- [ ] **Step 5: Commit** — `feat(ui): inline conflict editor with autosave and Mark resolved`.

---

### Task 4: Changes panel — Resolve all…

**Files:**

- Modify: `src/features/worktree/ChangesPanel.tsx`
- Test: `src/features/worktree/ChangesPanel.test.tsx` (extend)

**Interfaces:**

- Consumes: existing `integration.run({ action: "resolve", paths, side })`, `sides` from `sideLabels`, `ContextMenu`.
- Produces: nothing new outside the panel.

- [ ] **Step 1: Write the failing tests** — `Conflicts header shows Resolve all… and no Stage all`; `Resolve all… opens a menu with Keep {ours} for all files and Take {theirs} for all files` (labels from a merge state: `Keep main for all files`, `Take feature for all files`); `Keep … for all files resolves every conflicted path with ours` (`resolveConflicts(id, ["a.txt", "b.txt"], "ours")`), `Take … with theirs`; `Resolve all… is disabled while an action is pending`; `a failure shows in the panel error slot`; `Escape closes the menu`.

- [ ] **Step 2: Run to verify failure** — `npm test -- src/features/worktree/ChangesPanel.test.tsx`.

- [ ] **Step 3: Implement** — add `const [resolveAll, setResolveAll] = useState<{ x: number; y: number } | null>(null);`. `headerAction("conflicts")` returns

```tsx
<button
  type="button"
  className={styles.headerAction}
  disabled={pending}
  onClick={(e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setResolveAll({ x: r.left, y: r.bottom });
  }}
>
  Resolve all…
</button>
```

and a second `ContextMenu` after the row menu:

```tsx
<ContextMenu
  open={resolveAll !== null}
  x={resolveAll?.x ?? 0}
  y={resolveAll?.y ?? 0}
  items={[
    {
      id: "keepAll",
      label: `Keep ${sides.ours} for all files`,
      onSelect: () =>
        runIntegration({
          action: "resolve",
          paths: rows.conflicts.map((r) => r.entry.path),
          side: "ours",
        }),
    },
    {
      id: "takeAll",
      label: `Take ${sides.theirs} for all files`,
      onSelect: () =>
        runIntegration({
          action: "resolve",
          paths: rows.conflicts.map((r) => r.entry.path),
          side: "theirs",
        }),
    },
  ]}
  onClose={() => setResolveAll(null)}
/>
```

- [ ] **Step 4: Run to verify pass** — `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(ui): Resolve all… on the Conflicts section`.

---

## Execution: batched agent cycles

Per `feedback-token-cost-batching`: two cycles, each running the mandatory team workflow once (architect + tdd-tester in parallel → developer → tdd-tester-coverage + code-reviewer in parallel → fix loop), then one final architect sign-off.

| Cycle | Tasks | Deliverable                                                                  |
| ----- | ----- | ---------------------------------------------------------------------------- |
| 1     | 1–2   | Rust write + command + wrapper; editor foundations incl. the happy-dom spike |
| 2     | 3–4   | Writer hook, toolbar, container, `DetailPane` routing, Resolve all…          |

Dispatch count: 2 × 5 = 10 plus the final architect = 11, plus any fix passes. Models: architect and developer on opus, tester, coverage and reviewer on sonnet, passed explicitly on each dispatch. Agents write their reports to the scratchpad, not the main context.

## After the last task

1. Full gates: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `npm test` (100 %), `npm run lint`, `npm run typecheck`.
2. Acceptance walk from spec §6 in the running app (`npm run tauri dev` driven through the WebKit remote inspector; reuse `walk10/` fixture and helpers).
3. Merge `feature/gr-10b-conflict-editor` into `main` with `--no-ff`; comment on Jira GR-10 with the slice-b walk results and follow-ups (the story stays open for GR-10c).
