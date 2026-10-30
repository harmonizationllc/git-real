# GR-18 — Rebindable keyboard shortcuts

- Jira: GR-18 "Rebindable keyboard shortcuts" (task, relates to GR-14).
- Depends on: GR-14 (`src/lib/shortcuts/` registry, `matchesShortcut`,
  `formatKeys`, `ShortcutsDialog`, `SettingsDialog`), GR-29 / ADR 0005
  (every preference lives in the Rust-owned `settings.json`, injected
  before first paint), GR-19 (every default chord reaches the page on
  WebKitGTK; nothing is reserved by the webview).
- Follows: ADR 0005 (settings owned by Rust, lenient per-field load), the
  IPC seam rule, the 100 % coverage gate, the TDD policy.
- Date: 2026-10-29. The owner skipped the brainstorming questions and asked
  for sensible defaults; every choice below is the builder's call and is
  listed in §9.

## 1. Intent

The user changes any of the fourteen GR-14 shortcuts from the Settings
dialog by pressing the new keys, sees at once when the keys are already
taken and decides what wins, resets one or all back to the defaults, and
finds the new bindings in effect everywhere the old ones were: the window
listeners, the commit editor, the reference dialog and the tab-bar
tooltips. The bindings travel in `settings.json` with every other
preference, so a copied file carries them to another machine.

The ticket says bindings persist "beside `appearancePrefs`". GR-29 has
since moved every preference into `settings.json`; bindings go there as a
new `shortcuts` group.

### Goals

1. Every registry shortcut can be rebound to a different chord from the
   Settings dialog, by pressing the keys.
2. A chord in use by another shortcut is reported at the moment it is
   pressed, with a choice to replace (the other becomes unbound) or cancel.
3. One shortcut or all of them can be reset to the GR-14 defaults.
4. Bindings persist in `settings.json` under `shortcuts.bindings` and are
   in effect before first paint, exactly like the other settings.
5. Every consumer of a chord reads the effective binding, never the
   registry default: `useGlobalShortcuts`, `RepoPane`, `MessageEditor`,
   `ShortcutsDialog`, `TabBar`.
6. A hand-edited file with an unknown id, a malformed chord or two
   shortcuts on one chord loads without error and without two shortcuts
   firing on one keypress.

### Non-goals

- Separate binding sets per platform. One `Mod` abstraction, as GR-14.
- Two-stroke chords (`Ctrl+K Ctrl+S`), mouse buttons, OS-level global
  hotkeys.
- Rebinding the two static Navigation rows (`Escape`, `Arrow keys`), the
  palette's own list navigation, or CodeMirror's editor keys.
- An explicit "Unbind" action. A shortcut becomes unbound only as the
  outcome of replacing a conflict; "Reset" restores it. (Superseded by the
  GR-18b follow-ups spec: Unbind exists.)
- Live reload of a hand-edited file (GR-29 non-goal: next launch is fine).
- Import/export of bindings. Copying the file is the feature.
- Showing chords in the command palette (it does not today).

### Anti-goals

- A chord that fires while the user types plain text. A bindable chord
  must hold `Mod` or `Alt`, or be a function key.
- Two shortcuts firing on one keypress, whatever the file says.
- A bad hand edit that breaks startup or discards the rest of the file.
- A settings file that lists all fourteen bindings when the user changed
  one. Only non-default entries are stored.

## 2. Constraints (from the project)

- `git-real-core` has no Tauri dependency and no platform assumptions. It
  stores and shapes the bindings; it does not know the shortcut ids or the
  chord grammar (those live in `src/lib/shortcuts/`).
- The front end never touches `settings.json`; it goes through
  `useSettings` (`setPref`/`save`) and the typed IPC wrappers.
- `SETTINGS_VERSION` stays 2. The change is additive; a version-2 file
  without the `shortcuts` section loads the defaults (empty), as every
  missing section does. The first tagged release has not shipped (GR-38).
- No new dependencies on either side.

## 3. The file

```jsonc
"shortcuts": {
  "bindings": {
    "fetch": "Mod+Alt+F",   // a custom chord
    "palette": null         // unbound (lost a conflict)
    // an id that is absent uses its GR-14 default
  }
}
```

- Keys are shortcut ids (`src/lib/shortcuts/index.ts` `ShortcutId`).
  Rust keeps unknown keys as written; the front end ignores them.
- A value is a chord string in the canonical form of §4, or `null`.
- The default section is `{ "bindings": {} }` and is written in the file
  like every other default (the shared fixture
  `src/lib/store/settingsDefaults.json` gains it).

### Rust (`git-real-core/src/settings.rs`)

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ShortcutSettings {
    /// Shortcut id → custom chord, or `None` for unbound. Absent = default.
    pub bindings: BTreeMap<String, Option<String>>,
}
// Settings gains `pub shortcuts: ShortcutSettings` (after `updates`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ShortcutsPatch {
    /// Replaces the whole map when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bindings: Option<BTreeMap<String, Option<String>>>,
}
// SettingsPatch gains `pub shortcuts: Option<ShortcutsPatch>`.
```

- **Load (lenient).** `shortcuts` that is not an object: warning on
  `shortcuts`, defaults (the existing per-section rule; `SECTIONS` grows to
  nine). `shortcuts.bindings` that is present but not an object: warning
  `shortcuts.bindings`, empty map. Each entry: a string is kept, `null` is
  kept, any other type is dropped with a warning on
  `shortcuts.bindings.<id>` ("<err>; dropped"). Other entries are kept.
- **Patch.** `bindings` present replaces the map wholesale (the front end
  always sends the full override map; it is at most fourteen entries).
  Never an error.
- **Normalise (both modes).** Each string value is trimmed; a blank one is
  dropped from the map with a warning `shortcuts.bindings.<id>`
  ("blank; dropped"). Rust does not check the chord grammar: the grammar is
  the front end's, and duplicating it would let the two drift. A malformed
  chord reaches the page and falls back to the default there (§5).

### TypeScript (`src/lib/ipc/types.ts`)

```ts
/** Shortcut id → custom chord, or null for unbound; an absent id uses its default. */
export type ShortcutBindings = Record<string, string | null>;
// Settings gains `shortcuts: { bindings: ShortcutBindings }`.
```

`DEFAULT_SETTINGS.shortcuts = { bindings: {} }`; `settingsDefaults.json`
gains the section; `settingsActions.ts` gains
`setShortcutBindings(bindings: ShortcutBindings): void` →
`setPref({ shortcuts: { bindings } })` (debounced, reverting with a toast
on a failed save, as every other preference).

## 4. Chord grammar (`src/lib/shortcuts/chord.ts`)

A chord is a string `[Mod+][Alt+][Shift+]<Key>`, modifiers in that order,
each at most once. GR-14's fourteen defaults are all valid chords.

`<Key>` is one token of:

- a letter `A`–`Z` (upper case in the string);
- a digit `0`–`9`;
- `F1`–`F12`;
- `Enter`, `Space`, `Backspace`, `Delete`, `Insert`, `Home`, `End`,
  `PageUp`, `PageDown`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`;
- the punctuation `,` `.` `/` `;` `'` `[` `]` `\` `-` `=` `` ` ``.

Not in the set, so never bindable: `Escape`, `Tab`, bare modifiers, dead
keys, media keys, anything else.

```ts
export interface Chord {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}
export function parseChord(keys: string): Chord | null; // null when malformed
export function chordToString(chord: Chord): string; // canonical form
export function chordFromEvent(e: KeyboardEvent | React.KeyboardEvent): Chord | null;
export function isBindable(chord: Chord): boolean;
export function codeForKey(key: string): string; // "F" → "KeyF", "," → "Comma", "PageUp" → "PageUp"
export function modifierLabels(): { mod: string; alt: string }; // "Ctrl"/"Alt", or "⌘"/"⌥" on macOS, for copy
```

- `chordFromEvent` reads the **physical** key from `e.code` (`KeyF` → `F`,
  `Digit1` → `1`, `Comma` → `,`, `F5` → `F5`, named keys verbatim) and the
  modifier flags (`ctrlKey || metaKey` → `mod`). A modifier key, or a code
  outside the set, gives `null`. Physical codes keep a binding stable across
  keyboard layouts, which GR-14 already relied on for letters.
- `isBindable` is `mod || alt || /^F\d{1,2}$/.test(key)`. `Shift+F5` is
  bindable; `Shift+A` and bare `Enter` are not.
- `matchesShortcut(e, id)` (in `index.ts`) parses the **effective** chord
  for `id` (§5); an unbound shortcut never matches. It requires exactly the
  chord's modifiers (`ctrlKey || metaKey` for `Mod`, `altKey`, `shiftKey`),
  then `e.code === codeForKey(key) || e.key.toLowerCase() === key.toLowerCase()`,
  and keeps ignoring `repeat`, `defaultPrevented` and composing events.
  Today's `altKey → false` becomes "`altKey` must equal the chord's `alt`".
- `formatKeyParts`/`formatKeys` are unchanged; `Alt` renders as `Alt` /
  `⌥` through the existing label maps. `Space` renders as `Space`.

## 5. Effective bindings (`src/lib/shortcuts/index.ts`)

```ts
export type EffectiveBindings = Record<ShortcutId, string | null>;
/** Resolves the file's overrides against the registry; deterministic, never throws. */
export function resolveBindings(overrides: ShortcutBindings): EffectiveBindings;
export function setActiveBindings(bindings: EffectiveBindings): void; // module state read by matchesShortcut
export function activeKeys(id: ShortcutId): string | null;
```

`resolveBindings`, in registry order:

1. **Overrides pass.** An override that parses, is bindable, and whose
   canonical string no earlier override claimed is assigned. An override of
   `null` marks the id unbound. Any other override (unknown id, malformed,
   unbindable, duplicate) is ignored.
2. **Defaults pass.** Each id still unassigned takes its registry default
   unless an override already claimed that chord, in which case it is
   unbound.

So a file produced by the dialog resolves to exactly what the dialog
showed, and a hand-edited file can never fire two shortcuts on one
keypress. The initial module state is `resolveBindings({})`.

### Wiring

- `src/app/bootstrapShortcuts.ts` — `bootstrapShortcuts(): () => void`
  pushes `resolveBindings(settings.shortcuts.bindings)` into
  `setActiveBindings` now and whenever the store's `shortcuts` section
  changes (identity compare, as `bootstrapAppearance` does for
  `appearance`). `main.tsx` calls it right after `bootstrapAppearance()`.
- `src/lib/shortcuts/useShortcutKeys.ts` —
  `useShortcutKeys(id): string | null` and
  `useEffectiveBindings(): EffectiveBindings`, both selecting
  `settings.shortcuts.bindings` from `useSettings` and memoising the
  resolution on that object's identity. React consumers use these; the
  module state is for event handlers only.
- `useGlobalShortcuts.ts`, `RepoPane.tsx`: unchanged calls to
  `matchesShortcut`.
- `MessageEditor.tsx` `handleEnter`: today it returns early unless
  `e.key === "Enter"` before asking `matchesShortcut(e, "commit")`. It must
  ask `matchesShortcut(e, "commit")` first (any key), then handle a plain
  `Enter` as before. `linkIssue` is already checked before `handleEnter`.
- `TabBar.tsx`: `useShortcutKeys("palette")` / `("settings")`; the title is
  `Command palette (Ctrl+K)` when bound, `Command palette` when unbound.
- `ShortcutsDialog.tsx`: rows come from `useEffectiveBindings()`; an
  unbound row shows `Unbound` in the Shortcut column (one muted `<span>`,
  no `<kbd>`). A `Customize…` button before `Close` opens
  `{ kind: "settings", section: "shortcuts" }` (the shell has one dialog
  slot, so the reference closes and Settings opens at the section).
- `src/lib/store/shell.ts`: `SettingsSection` gains `"shortcuts"`.

## 6. Settings dialog — "Keyboard shortcuts" section

`src/features/settings/ShortcutSettings.tsx`, rendered by `SettingsDialog`
after `GitSettings` and before `FileSettings`, as
`<Section id="shortcuts" name="Keyboard shortcuts">`.

### Layout

One `<table>` per registry group, in `SHORTCUT_GROUPS` order, caption =
group name, columns `Action`, `Shortcut`, and an unlabelled third column.
The two static Navigation rows are **not** listed here (they are not
bindable). Below the tables: a hint line and a `Reset all to defaults`
button.

Each row:

- `<td>` the shortcut's label.
- `<td>` a `<button type="button">` with accessible name
  `Change shortcut for <label>`; its content is the `<kbd>` parts of the
  effective chord (as the reference dialog renders them), or the text
  `Unbound`.
- `<td>` a `Reset` button, present only when the id has an entry in
  `settings.shortcuts.bindings` (custom or unbound); accessible name
  `Reset <label> to default`, title `Reset to <formatKeys(default)>`.

Hint copy (the modifier words come from the platform label maps, so macOS
reads `⌘ or ⌥`): `Press a key combination with Ctrl or Alt, or a function key. Changes apply at once.`
(GR-18b follow-ups spec §5 replaced this hint text with the cross-platform
version.)

### Capture flow (one row at a time)

Component state: `null`, or
`{ id, phase: "listening" | "conflict", chord?: string, otherId?: ShortcutId, error?: string }`.

1. Click the chord button → `listening`. The button reads `Press keys…`
   and keeps focus. A `role="status"` region in the section announces
   `Listening for a shortcut. Press Escape to cancel.`
2. `keydown` on the button while listening: always `preventDefault()` and
   `stopPropagation()`, so neither the webview nor the window listeners act
   (React's root handler runs before the `window` listeners, so the
   `useGlobalShortcuts` chords — which stay live inside shell dialogs — do
   not fire). Then:
   - `Escape` → back to `null`, nothing saved.
   - `chordFromEvent` is `null` (a modifier alone, or a key outside the
     set) → keep listening.
   - not `isBindable` → `error = "Add Ctrl or Alt, or use a function key."`
     (platform words), keep listening. The error shows under the row with
     `role="alert"`.
   - equal to the row's current effective chord → `null` (no change).
   - equal to another id's effective chord → `conflict`: the button reads
     the pressed chord; beside it the text `Already used by <other label>`
     and two buttons, `Replace` and `Cancel`.
   - otherwise → save (below), then `null`.
3. `Replace` → `bindings[id] = chord; bindings[otherId] = null` → save →
   `null`. `Cancel` → `null`.
4. Focus leaving the button (`blur`) while listening → `null`. In
   `conflict` focus moves to `Replace`, so blur does not cancel there.
5. Only one row captures at a time; clicking another row's button while
   one is listening starts listening on the new row.

### Saving

`save(next: ShortcutBindings)`: when the chord being set equals the id's
registry default, the id's entry is **deleted** instead (so the file holds
only real overrides); then `setShortcutBindings(next)`. `Reset` deletes
the id's entry and any other id's entry that holds this id's default
chord, and so on through every row whose default that frees, so a row
reset after a `Replace` gets its chord back and the row that took it
returns to its own default. `Reset all to defaults` sends
`{}`; it is disabled when the map is empty. (Since the GR-18b follow-ups,
`setShortcuts` sends `{ bindings, keycaps }` and Reset all clears both
maps.)

### Keyboard access

The chord button is a real button: `Enter`/`Space` start listening (the
key-up of that press is not a keydown, so it is not captured). While
listening, `Enter` and `Space` are ordinary keys in the set and would be
captured as chords: bare `Enter`/`Space` are unbindable, so they produce
the error line, not a binding. `Tab` is outside the set, so it moves focus
and cancels through `blur`.

## 7. Error handling summary

| Situation                                   | Behaviour                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Save rejected (I/O)                         | `useSettings.setPref` reverts the section and toasts `Couldn't save settings: <message>` (existing)       |
| Hand edit: unknown id                       | kept in the file, ignored by the page                                                                     |
| Hand edit: malformed or unbindable chord    | the id uses its default; `Reset` is offered because an entry exists                                       |
| Hand edit: two ids on one chord             | the first in registry order keeps it, the other uses its default (or is unbound when that is claimed too) |
| Hand edit: `bindings` not an object         | warning logged, empty map, rest of file kept                                                              |
| Hand edit: an entry that is a number/object | that entry dropped with a warning, rest kept                                                              |
| Pressed chord outside the token set         | ignored, keep listening                                                                                   |

### Known limits

- A key the user has never captured displays its QWERTY token; the layout is
  learned one key at a time.
- On Windows, chords bound with `Mod+Alt` cannot be triggered with the AltGr
  key itself; left Ctrl + left Alt works. Chromium reports `AltGraph` only for
  the right Alt key on layouts that have one; this is untested on hardware.
- On macOS, Option+letter chords compete with accented-character input.
- A row that is unbound only because another id's **hand-edited**
  override claimed its default shows `Unbound` with no `Reset` (no entry
  of its own). The dialog never produces this state: `Reset` on a row
  after a `Replace` drops the claiming override too (found by the
  2026-10-30 acceptance walk, item 3). Recovery for the hand-edited case
  is pressing the chord on that row and choosing `Replace`, `Reset` on
  the claiming row, or `Reset all`.

## 8. Testing

Tests first, by the test role; the gate is the usual one: `cargo test
--workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt
--check` (from `src-tauri`), `npm run test:coverage` at 100 %, `npm run
lint`, `npm run typecheck`.

- **Rust core** (`tests/settings.rs`): defaults equal the fixture (the
  existing test, with the fixture extended); file round trip with two
  bindings including a `null`; lenient: non-object `bindings`, a numeric
  entry dropped with a warning naming `shortcuts.bindings.<id>`, a blank
  string dropped, whitespace trimmed, a `null` kept, unknown ids kept, the
  rest of the file intact; patch: absent keeps, present replaces wholesale
  (an id missing from the new map disappears), blank trimmed/dropped.
- **Rust app** (`tests/settings_store.rs`): `update` with a shortcuts patch
  persists and round-trips through the file; the init script carries the
  section.
- **`chord.ts`**: parse/print round trip of every default; canonical
  ordering (`Shift+Mod+F` is malformed); duplicates malformed; every token
  class parses; `Escape`/`Tab` malformed; `chordFromEvent` for a letter on
  a non-Latin layout (`code: "KeyF"`, `key: "а"`), a digit with Shift, a
  punctuation code, `F5`, a bare modifier (null), an unknown code (null);
  `isBindable` matrix.
- **`index.ts`**: `resolveBindings`: empty → defaults; custom; `null`;
  unknown id ignored; malformed ignored; unbindable ignored; two overrides
  on one chord → second ignored; an override on another id's default →
  that id unbound; `matchesShortcut` reads the active bindings (custom
  chord fires, old default no longer fires, unbound never fires, `Alt`
  chord fires only with `altKey`); the existing matrix still passes.
- **`useShortcutKeys.ts`** and **`bootstrapShortcuts.ts`**: follow the
  store; the uninstaller stops following; the module state and the hook
  agree after a change.
- **`MessageEditor`**: with `commit` rebound to `Mod+S`, `Ctrl+S` submits
  and `Ctrl+Enter` does not; plain `Enter` still inserts/submits as before.
- **`useGlobalShortcuts`** / **`RepoPane`**: one test each that a rebound
  chord acts and the default no longer does.
- **`TabBar`**: title with a custom chord; title without a suffix when
  unbound.
- **`ShortcutsDialog`**: rows show effective chords; `Unbound` row;
  `Customize…` opens Settings at `shortcuts`.
- **`ShortcutSettings`**: the full capture flow of §6 (listening text,
  status, Escape, modifier-only, unbindable error, same chord, free chord
  saved and the entry deleted when it equals the default, conflict text
  and `Replace`/`Cancel` outcomes, blur cancels, Reset row, Reset all and
  its disabled state, only non-default entries sent, `stopPropagation`
  keeps the window listener quiet).
- **`SettingsDialog`**: the section renders; `section="shortcuts"` focuses
  its first control.

### Acceptance walk (owner, COSMIC, after merge)

1. Settings → Keyboard shortcuts → Fetch → press `Ctrl+Alt+F`. Row shows
   `Ctrl+Alt+F`, Reset appears. Press `Ctrl+Alt+F` in a repo tab: fetch
   runs. `Ctrl+Shift+F` does nothing.
2. Quit, reopen: the binding is still there; `settings.json` holds
   `"shortcuts": { "bindings": { "fetch": "Mod+Alt+F" } }` and nothing else
   under `bindings`.
3. Pull → press `Ctrl+K`: `Already used by Command palette`; Replace. The
   palette row reads `Unbound`; `Ctrl+K` pulls; the tab-bar tooltip reads
   `Command palette`. Reset on the palette row; `Ctrl+K` opens the palette
   again and Pull is back to its default.
4. `Ctrl+/` → `Customize…` lands in the section.
5. Reset all to defaults → every Reset disappears; the file's `bindings`
   is `{}`.
6. While a row is listening, press bare `Space` and bare `Enter`: the error
   line shows and no click re-triggers the button (WebKitGTK keyup
   activation).
7. With the dialog at its default size, the four three-column tables fit
   without horizontal overflow on COSMIC.
8. Unbind Fetch with the button: row reads `Unbound`, `Ctrl+Shift+F` does
   nothing, Reset brings it back. Then rebind Pull, press bare Backspace while
   listening: Pull reads `Unbound`.
9. If a second layout is available (e.g. add Dvorak in COSMIC's input
   settings): capture Ctrl+Alt on the key labelled A for Fetch; the row shows
   `Ctrl+Alt+A`, `settings.json` holds `"fetch": "Mod+Alt+Q"` and
   `"keycaps": { "Q": "A" }`; switch back to QWERTY and press Ctrl+Alt+Q:
   fetch runs; capture Ctrl+Alt+Q again on QWERTY and the `Q` entry
   disappears.

## 9. Builder's calls (the owner skipped the questions)

1. Store overrides only, with `null` for unbound; replace the map wholesale
   on patch (§3).
2. Rust validates shape, not grammar (§3).
3. Physical-key capture via `e.code`; canonical `Mod+Alt+Shift+Key` order;
   the token set of §4; `Mod`/`Alt`/F-key rule for bindability.
4. Conflict resolution: Replace unbinds the other shortcut; no explicit
   Unbind (§6). (Superseded by the GR-18b follow-ups spec: Unbind exists.)
5. Deterministic two-pass resolution for hand-edited files (§5).
6. Section placement after Git, one table per group, `Customize…` in the
   reference dialog (§5, §6).
7. No `SETTINGS_VERSION` bump (§2).

## 10. Left to the builder

- Exact CSS for the chord button, the `Unbound` text and the conflict row
  (reuse `ShortcutsDialog.module.css` `.kbd` and `SettingsDialog.module.css`
  `.row`/`.hint`/`.error`).
- Whether `useEffectiveBindings` memoises with `useMemo` or a module-level
  cache keyed on the bindings object.
- Test fixtures and helper names.

## 11. Rulings during the build (2026-10-29)

- Tab while listening is let through, so focus moves and the blur cancels the
  capture. §6 wins over the plan's "preventDefault on every keydown".
- Escape in the conflict phase cancels the conflict, is stopped before it
  reaches the dialog, and returns focus to the row's chord button.
- `Replace`, `Cancel`, `Reset` and `Reset all` return focus to a chord button;
  `Reset all` focuses the first row's.
- The chord button calls `focus()` on click, because WKWebView does not focus
  buttons on a mouse click.
- In the commit editor, a modifier-decorated Enter (Ctrl, Meta or Alt) that is
  not the commit chord is left to the window listeners. Shift+Enter keeps its
  behaviour.
- The chord button keeps its accessible name and exposes the current chord, or
  `Unbound`, through `aria-describedby`.
- The `Replace`/`Cancel` pair is grouped under the label `Shortcut conflict`.
