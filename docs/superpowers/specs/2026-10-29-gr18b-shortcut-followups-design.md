# GR-18b — Shortcut follow-ups: Unbind, keycap display, AltGr guard, one file for every platform

- Jira: GR-18 "Rebindable keyboard shortcuts" (stays Done; the owner asked for
  the four follow-up candidates from the closing comment to be built under the
  same ticket without changing its status).
- Builds on: `docs/superpowers/specs/2026-10-29-gr18-rebindable-shortcuts-design.md`
  (the GR-18 spec; its §3–§7 remain the authority for everything not amended
  here), ADR 0005 (settings owned by Rust, lenient per-field load).
- Date: 2026-10-29. Shape agreed in chat; owner decisions in §8.

## 1. Intent

Close the four follow-ups the GR-18 review surfaced, so the shortcut system is
complete rather than merely rebindable:

1. **Unbind** a shortcut on purpose, not only as the loser of a conflict.
2. **Keycap display**: a user on AZERTY, Dvorak or QWERTZ sees the letter they
   pressed, while the binding keeps following the physical key.
3. **AltGr guard**: typing `€` or `ñ` with AltGr on Windows never fires a
   `Mod+Alt` chord.
4. **One file for every platform**: confirmed as already true, now stated in
   the hint and the spec; no per-platform binding sets.

And one review nicety: the shared `KeyParts` renderer moves into its own file.

### Goals

- A bound row can be unbound from the Settings section by button or by a
  bare Backspace/Delete while listening; the reference dialog shows `Unbound`
  and the chord never fires; Reset restores the default.
- A chord captured on a non-QWERTY layout displays the keycap the user saw,
  in the Settings table, the reference dialog and the tab-bar tooltips.
- A keydown that carries the `AltGraph` modifier state is ignored by
  `matchesShortcut` and by the capture.
- The Settings hint tells the user the file travels across platforms and how
  `Ctrl`/`⌘` relate.

### Non-goals

- Per-platform binding sets. Owner decision: one set; `Mod` is Ctrl on Linux
  and Windows and ⌘ on macOS, as GR-14 defined; Super and Win count as `Mod`
  too (they set `metaKey`), so a Super+K binding from Linux is ⌘K on a Mac.
- Reading the keyboard layout from the browser (`navigator.keyboard` exists
  only in Chromium; WebKitGTK and WKWebView lack it). The app learns the
  layout one key at a time, from the chords the user captures.
- A hardware check of AltGr on Windows (stays on the GR-34/35 list).

### Anti-goals

- A keycap that misrepresents the key: a shifted glyph (`!` for Shift+1), an
  Option-accented glyph (`å`) or a dead key is never recorded.
- A keycap hint that cannot be corrected: capturing the same physical key
  again always refreshes or removes its entry, and Reset all clears them.

## 2. The file

```jsonc
"shortcuts": {
  "bindings": { "fetch": "Mod+Alt+Q", "palette": null },
  "keycaps":  { "Q": "A" }    // the key labelled A sits where QWERTY has Q
}
```

- `keycaps` is a sibling map from a **physical key token** (`A`–`Z`, `0`–`9`,
  the punctuation list) to the one upper-case keycap character the user saw
  on it. It is the layout the app has learned so far. Every chord ending in
  `Q`, default or custom, displays `A` once that entry exists, so a Dvorak
  user's defaults read correctly after a single capture on each key they
  care about. A token without an entry displays itself.
- An entry whose key or value is not a single token-set character is ignored
  by the page and dropped on the next save of the section.
- Default section: `{ "bindings": {}, "keycaps": {} }` (fixture updated).

### Rust (`git-real-core/src/settings.rs`)

```rust
pub struct ShortcutSettings {
    pub bindings: BTreeMap<String, Option<String>>,
    pub keycaps: BTreeMap<String, String>,            // new, default empty
}
pub struct ShortcutsPatch {
    pub bindings: Option<BTreeMap<String, Option<String>>>,
    pub keycaps: Option<BTreeMap<String, String>>,    // new; replaces wholesale when present
}
```

- Load (lenient): `shortcuts.keycaps` present but not an object → warning
  `shortcuts.keycaps`, empty map; an entry that is not a string → dropped with
  warning `shortcuts.keycaps.<id>` (`<err>; dropped`); other entries kept.
- Normalise (both modes): each keycap is trimmed; a blank one is dropped with
  warning `shortcuts.keycaps.<id>` (`blank; dropped`). Rust does not check the
  character class; the page ignores a keycap outside the token set.
- Patch: `keycaps` present replaces the map; never an error.
- `SETTINGS_VERSION` stays 2 (additive; nothing has shipped).

### TypeScript

```ts
// src/lib/ipc/types.ts
export type ShortcutKeycaps = Record<string, string>;
// Settings.shortcuts: { bindings: ShortcutBindings; keycaps: ShortcutKeycaps }
// src/lib/store/settingsActions.ts
export function setShortcuts(shortcuts: Settings["shortcuts"]): void; // setPref({ shortcuts })
```

`setShortcuts` replaces `setShortcutBindings` (every writer sends both maps
together; the dialog always edits them as a pair).

## 3. Chord library changes (`src/lib/shortcuts/`)

```ts
// chord.ts
export function isAltGraph(e: KeyboardEvent | React.KeyboardEvent): boolean;
//   true when e.getModifierState exists and e.getModifierState("AltGraph") is true
export function chordFromEvent(e): Chord | null; // now also null when isAltGraph(e)
export function keycapFromEvent(e, chord: Chord): string | null;
//   e.key upper-cased when it is one character in the token set; else null (also null for F-keys and named keys)
export function isKeyToken(s: string): boolean; // one of the token set
// index.ts
export function matchesShortcut(e, id): boolean; // now also false when isAltGraph(e)
export function validKeycaps(keycaps: ShortcutKeycaps): ShortcutKeycaps;
//   only entries whose key and value are single-character key tokens and differ from each other
export function formatKeyParts(keys: string, keycaps?: ShortcutKeycaps): string[]; // last part replaced by keycaps[token] when present
export function formatKeys(keys: string, keycaps?: ShortcutKeycaps): string;
// useShortcutKeys.ts
export function useKeycaps(): ShortcutKeycaps; // validKeycaps of the stored map, by value
```

`keycapFromEvent` returns the keycap even when it equals the chord's key:
the caller uses equality to **remove** a stale entry (the user is back on
QWERTY for that key) and inequality to add or refresh one. It rules out the
misrepresenting cases by construction: a shifted digit gives `!` (not in the
set), Option+letter on macOS gives `å` (not in the set), a dead key gives
`Dead` (length 4). Shift+letter gives the upper-case letter, which is in the
set, so Shift chords on letters still teach the layout. A Shift press teaches
a keycap only when that keycap is a letter: on digit and punctuation keys
Shift types a different glyph that can still be in the set (QWERTZ
`Shift+Comma` types `;`, `Shift+Digit7` types `/`), so those presses learn
nothing.

## 4. Display

- `KeyParts` moves to `src/features/settings/KeyParts.tsx` with
  `KeyParts.module.css` holding the `.kbd` and `.unbound` rules (removed from
  `ShortcutsDialog.module.css`). Props unchanged: `{ parts: string[] | null }`.
- `ShortcutsDialog` rows: `formatKeyParts(keys, keycaps)` with
  `keycaps = useKeycaps()`.
- `ShortcutSettings` chord buttons and their `aria-describedby` text: same.
- `TabBar` titles: `formatKeys(keys, keycaps)`.
- Because the map is keyed by physical key, a hand edit that changes a chord
  to a key the app has not learned shows that key's own token, and one that
  moves to a learned key shows the learned keycap. Both are right for the
  layout the user taught.

## 5. Settings section changes (`ShortcutSettings.tsx`)

### Unbind

- Each row gains an `Unbind` button in the third column, before `Reset`,
  accessible name `Unbind <label>`, rendered only when the row's effective
  chord is not `null`. Click → `bindings[id] = null`, save, focus the row's
  chord button. `Reset` then appears (the id has an entry).
- While listening, a bare `Backspace` or bare `Delete` (no Mod, Alt or Shift)
  unbinds the row the same way and ends the capture. With any modifier they
  are ordinary chords (`Mod+Backspace` is bindable) and follow the normal
  capture rules.
- `Reset all to defaults` also clears `keycaps` (sends `{ bindings: {}, keycaps: {} }`),
  since it returns the section to the shipped state.

### Keycap learning

- On every capture that reaches the "same chord", "conflict" or "free chord"
  branch, `keycapFromEvent(e, chord)` is computed at keydown time and carried
  in the capture state. On save (free chord, or Replace) the map is updated
  for `chord.key`: a keycap that differs from the token is written
  (`keycaps[chord.key] = keycap`); one equal to the token deletes the entry;
  `null` (no usable character) leaves the map alone. The "same chord" branch
  also saves the map when the entry would change, so re-pressing a binding
  on a new layout corrects its display without rebinding.
- Reset, Unbind and Replace's loser do not touch `keycaps`: the map describes
  keys, not shortcuts.

### Hint copy

Replace the second hint sentence. Linux/Windows:
`Press a key combination with Ctrl or Alt, or a function key. Changes apply at once. The same settings file works on every platform: Ctrl here is ⌘ on a Mac.`
macOS: `Press a key combination with ⌘ or ⌥, or a function key. Changes apply at once. The same settings file works on every platform: ⌘ here is Ctrl on Linux and Windows.`

### Error copy (unchanged) and one new case

A chord ignored because of `AltGraph` behaves like a modifier-only press: the
row keeps listening, no error.

## 6. Error handling summary (additions to GR-18 §7)

| Situation                                                                                                              | Behaviour                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Hand edit: keycap entry whose key or value is not one token-set character (`"ab"`, `"é"`, `"Enter"`) or equals its key | ignored by the page (the token is shown); dropped on the next save of the section |
| Hand edit: `keycaps` not an object / entry not a string / blank                                                        | Rust warning, empty map / entry dropped / dropped; rest of the file kept          |
| AltGr-decorated keydown (Windows European layouts)                                                                     | never matches a shortcut; ignored while listening                                 |
| Bare Backspace/Delete while listening                                                                                  | unbinds the row                                                                   |

### Known limits (additions)

- A key the user has never captured displays its QWERTY token; the layout is
  learned one key at a time.
- On Windows, chords bound with `Mod+Alt` cannot be triggered with the AltGr
  key itself; left Ctrl + left Alt works. Chromium reports `AltGraph` only for
  the right Alt key on layouts that have one; this is untested on hardware.

## 7. Testing

Gate unchanged: `cargo test --workspace`, clippy, fmt (from `src-tauri`);
`npm run test:coverage` at 100 %, `npm run lint`, `npm run typecheck`.

- **Rust core** (`tests/settings.rs`): defaults equal the fixture (fixture gains
  `keycaps`); round trip with one keycap; lenient non-object `keycaps`, a
  numeric entry dropped with its warning, blank dropped, whitespace trimmed,
  rest of file intact; patch absent keeps / present replaces wholesale /
  trims.
- **Rust app** (`tests/settings_store.rs`): update with `keycaps` round-trips
  through the file and the init script.
- **`chord.ts`**: `isAltGraph` true/false/absent `getModifierState`;
  `chordFromEvent` null under AltGraph; `keycapFromEvent` matrix: Dvorak
  letter (`code KeyQ`, `key "a"`, chord key `Q`) → `A`; same letter (`key "q"`)
  → `Q`; Shift+digit (`key "!"`) → null; Option glyph (`key "å"`) → null; dead
  key → null; F-key or named key → null; punctuation layout swap (`code
Semicolon`, `key ","`) → `,`.
- **`index.ts`**: `matchesShortcut` false under AltGraph with an otherwise
  matching Mod+Alt chord; `validKeycaps` keeps `{ Q: "A" }`, drops `{ Q: "Q" }`,
  `{ Q: "ab" }`, `{ Q: "é" }`, `{ Enter: "A" }`, `{ q: "A" }`;
  `formatKeyParts`/`formatKeys` with and without a learned keycap, for a
  default and a custom chord, PC and Mac labels.
- **`useShortcutKeys.ts`**: `useKeycaps` follows the store by value and
  returns only valid entries.
- **`KeyParts.test.tsx`** (moved from the dialog test): kbd parts and
  `Unbound`.
- **`ShortcutsDialog`**: a row with a keycap shows it; the `.kbd`/`.unbound`
  classes still apply.
- **`TabBar`**: title uses the keycap.
- **`ShortcutSettings`**: Unbind button present on bound rows (defaults
  included) and absent on unbound rows; click → `bindings.fetch === null`,
  keycaps untouched, focus on the chord button, Reset appears; bare Backspace
  and bare Delete while listening unbind; `Mod+Backspace` while listening
  binds; a Dvorak capture (`code KeyQ`, `key "a"`) stores `bindings.fetch = "Mod+Alt+Q"`
  and `keycaps.Q = "A"`, the button shows `Ctrl`,`Alt`,`A`, and every other
  row whose chord ends in `Q` shows `A` too; a QWERTY capture on a learned
  key removes its entry; re-pressing the current chord on a new layout
  updates the entry without changing the binding; Replace writes the winner's
  keycap; Reset leaves keycaps alone; AltGraph keydown keeps listening
  without error; Reset all sends both empty maps; the hint text per platform;
  the `setShortcuts` payload shape in every save.
- **`settingsActions`**: `setShortcuts` sends both maps and replaces
  wholesale.

### Acceptance walk additions (owner, COSMIC)

8. Unbind Fetch with the button: row reads `Unbound`, `Ctrl+Shift+F` does
   nothing, Reset brings it back. Then rebind Pull, press bare Backspace while
   listening: Pull reads `Unbound`.
9. If a second layout is available (e.g. add Dvorak in COSMIC's input
   settings): capture Ctrl+Alt on the key labelled A for Fetch; the row shows
   `Ctrl+Alt+A`, `settings.json` holds `"fetch": "Mod+Alt+Q"` and
   `"keycaps": { "Q": "A" }`; switch back to QWERTY and press Ctrl+Alt+Q:
   fetch runs; capture Ctrl+Alt+Q again on QWERTY and the `Q` entry
   disappears.

## 8. Owner decisions (2026-10-29)

- One binding set for every platform; `Mod` keeps meaning Ctrl on Linux and
  Windows and ⌘ on macOS, because that is what Mac users expect ("we can keep
  as is since it's the preferred for Macs"). Super/Win continue to count as
  `Mod`.
- Build all four follow-ups plus the `KeyParts` split under GR-18 without
  changing the ticket's status; one closing comment.

## 9. Builder's calls

1. Keycaps as a sibling map keyed by **physical key**, not by shortcut id and
   not a change of the `bindings` value shape: hand-written chords keep
   working, the Rust reader stays per-entry lenient, a stale keycap cannot
   attach to the wrong chord, and defaults benefit from what the user teaches.
2. `keycapFromEvent` yields only a single token-set character (rules out
   shifted, accented and dead glyphs), and with Shift held only a letter,
   since Shift changes the glyph on digit and punctuation keys; equality
   with the token removes the entry so the learned layout self-corrects.
3. Bare Backspace/Delete as the keyboard route to Unbind; both are
   unbindable bare, so the gesture is unambiguous.
4. Any `AltGraph` keydown is ignored everywhere, on every platform.
5. `setShortcuts` replaces `setShortcutBindings`.
