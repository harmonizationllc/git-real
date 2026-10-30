# GR-18b Shortcut Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit Unbind, a captured-keycap display for non-QWERTY layouts, an AltGr guard, and the cross-platform hint to the GR-18 shortcut system, and move `KeyParts` into its own file.

**Architecture:** The Rust `shortcuts` section gains a sibling `keycaps` map (shape-validated, wholesale replace). The `keycaps` map is keyed by physical key token (`{ "Q": "A" }`): the layout the app has learned from the user's captures, applied to every chord that ends in that key, defaults included. The chord library gains `isAltGraph`, `keycapFromEvent`, `validKeycaps` and keycap-aware formatting; `matchesShortcut` and `chordFromEvent` ignore AltGraph events. `ShortcutSettings` gains Unbind (button and bare Backspace/Delete), learns a keycap on every capture (adding, refreshing or removing the key's entry), and shows the new hint. `KeyParts` becomes `KeyParts.tsx` with its own CSS module.

**Tech Stack:** Rust 2024 + serde, Tauri 2, React 19 + TypeScript, zustand, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-29-gr18b-shortcut-followups-design.md` (amends `docs/superpowers/specs/2026-10-29-gr18-rebindable-shortcuts-design.md`)

## Global Constraints

- Tests first and written by the test role; the developer role never edits test files (CLAUDE.md). Red before green.
- Only `src/lib/ipc` imports `@tauri-apps/api/*`. `git-real-core` has no Tauri dependency. `src/lib/shortcuts/index.ts` and `chord.ts` stay store-free; `useShortcutKeys.ts` is the one bridge.
- `SETTINGS_VERSION` stays `2`. File shape: `"shortcuts": { "bindings": {…}, "keycaps": { "<id>": "<one upper-case token-set character>" } }`; default `{ "bindings": {}, "keycaps": {} }`. Patch `keycaps` replaces the map wholesale, never an error. Lenient load: non-object `keycaps` → warning `shortcuts.keycaps`, empty map; non-string entry → dropped with warning `shortcuts.keycaps.<id>` (`<err>; dropped`). Normalise trims and drops blank with warning `shortcuts.keycaps.<id>` (`blank; dropped`).
- `isAltGraph(e)`: `typeof e.getModifierState === "function" && e.getModifierState("AltGraph") === true`. `chordFromEvent` returns `null` and `matchesShortcut` returns `false` when it is true.
- `keycaps` is keyed by **physical key token** (`A`–`Z`, `0`–`9`, punctuation), value = the one upper-case keycap the user saw on it; e.g. `{ "Q": "A" }` on Dvorak. It describes keys, not shortcuts, so every chord ending in a learned token displays the learned keycap, defaults included.
- `keycapFromEvent(e, chord)`: `const k = e.key.toUpperCase()`; returns `k` when `e.key.length === 1` and `isKeyToken(k)` and `chord.key` is a single-character token (letter, digit or punctuation); else `null`. It returns `k` even when `k === chord.key` (the caller removes the entry then).
- `validKeycaps(keycaps)`: keeps an entry only when the key and the value are both single-character key tokens and differ.
- `formatKeyParts(keys, keycaps?)` replaces the last part with `keycaps[token]` when present; `formatKeys(keys, keycaps?)` joins as before.
- `useKeycaps()` returns `validKeycaps(settings.shortcuts.keycaps)`, selected with `useShallow`, memoised.
- `setShortcuts(shortcuts: Settings["shortcuts"])` → `setPref({ shortcuts })`; `setShortcutBindings` is removed.
- Copy (verbatim). Unbind button accessible name `Unbind <label>`, text `Unbind`. Hint, Linux/Windows: `Press a key combination with Ctrl or Alt, or a function key. Changes apply at once. The same settings file works on every platform: Ctrl here is ⌘ on a Mac.` macOS: `Press a key combination with ⌘ or ⌥, or a function key. Changes apply at once. The same settings file works on every platform: ⌘ here is Ctrl on Linux and Windows.` All GR-18 copy unchanged.
- Capture rules while listening (after the Tab passthrough and the preventDefault/stopPropagation): Escape → idle; `isAltGraph(e)` → keep listening; bare Backspace or bare Delete (no ctrl/meta/alt/shift) → unbind the row (`bindings[id] = null`), save, idle; then the GR-18 order (null chord → keep listening; unbindable → error; same as effective → learn the keycap and save only if the map changed, idle; conflict → carry `keycap` in the state; free → save binding and learn the keycap).
- Learning: `learn(keycaps, chord, keycap)` returns a new map where `keycap === null` leaves it unchanged, `keycap === chord.key` deletes `keycaps[chord.key]`, otherwise sets `keycaps[chord.key] = keycap`.
- Saving: `commit(next: Settings["shortcuts"])` deletes a binding equal to the registry default, then `setShortcuts(next)`. Reset deletes the id's binding entry only. Unbind sets `null` only. Replace sets the winner's chord, learns the winner's keycap, sets the loser to `null`. Reset all sends `{ bindings: {}, keycaps: {} }`. Nothing but a capture and Reset all touches `keycaps`.
- Commits: explicit paths only, never `-A`, never amend/reset/stash. Subjects `feat(GR-18): …`, `refactor(GR-18): …`, `docs(GR-18): …`. Trailers from the session's attribution reminder.
- Checks: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check` (from `src-tauri`, with `CARGO_TARGET_DIR=/home/gorlox/code/git-real/src-tauri/target`); `npm run test:coverage` at 100 % for `src/`; `npm run lint`; `npm run typecheck`.
- Model per dispatch: Task 1 → `sonnet`; Tasks 2 and 3 → `opus`; task reviewers → `opus`; final branch review → the most capable model.

## Review Focus

1. Pressing the key labelled A on Dvorak (code `KeyQ`, key `a`) with Ctrl+Alt must store `Mod+Alt+Q` and `keycaps.Q = "A"`, display `Ctrl+Alt+A`, and make every other chord ending in `Q` display `A`; switching back to QWERTY, Ctrl+Alt+Q must fire (Task 2 test `keycapFromEvent records the keycap for a Dvorak letter`, Task 3 test `a Dvorak capture learns the keycap and shows it on every chord using that key`).
2. Shift+1 on a US layout (key `!`) must not record `!` as a keycap, and Option+A on a Mac (key `å`) must not record `Å` (Task 2 tests `keycapFromEvent ignores a shifted glyph` and `ignores an accented glyph`).
3. A hand-edited `keycaps` entry such as `{ "Q": "Q" }`, `{ "Enter": "A" }` or `{ "Q": "é" }` must be ignored, and re-pressing a learned key on QWERTY must remove its entry so the display self-corrects (Task 2 test `validKeycaps drops malformed and identity entries`, Task 3 test `a QWERTY capture on a learned key removes its entry`).
4. `Mod+Backspace` while listening must bind, not unbind (Task 3 test `Mod+Backspace while listening binds the chord`).
5. An AltGraph keydown that otherwise matches `Mod+Alt+E` must not fire and must not end the capture (Task 2 test `matchesShortcut ignores an AltGraph event`, Task 3 test `an AltGraph keydown keeps listening without an error`).

---

### Task 1: `keycaps` in the settings section (Rust core, app store, fixture, TS types, defaults, `setShortcuts`)

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/settings.rs` (`ShortcutSettings.keycaps`, `ShortcutsPatch.keycaps`, `read_keycaps` in `from_json_lenient`, `apply`, `normalise`)
- Modify: `src/lib/store/settingsDefaults.json` (`"keycaps": {}` after `bindings`), `src/lib/ipc/types.ts` (`ShortcutKeycaps`, `Settings.shortcuts.keycaps`), `src/lib/store/settings.ts` (`DEFAULT_SETTINGS.shortcuts.keycaps`), `src/lib/store/settingsActions.ts` (`setShortcuts` replaces `setShortcutBindings`)
- Test: `src-tauri/crates/git-real-core/tests/settings.rs`, `src-tauri/tests/settings_store.rs`, `src/lib/store/settings.test.ts`, `src/lib/store/settingsActions.test.ts`, plus every test or source file that calls `setShortcutBindings` or builds a full `Settings` literal (`grep -rn "setShortcutBindings\|bindings: {}" src`)

**Interfaces:**

- Consumes: GR-18's `ShortcutSettings`, `ShortcutsPatch`, `read_bindings`, `SettingsWarning::new`, `set()`, `trimmed()`; TS `ShortcutBindings`, `setPref`.
- Produces:

```rust
pub struct ShortcutSettings { pub bindings: BTreeMap<String, Option<String>>, pub keycaps: BTreeMap<String, String> }
pub struct ShortcutsPatch { pub bindings: Option<BTreeMap<String, Option<String>>>, pub keycaps: Option<BTreeMap<String, String>> }
```

```ts
export type ShortcutKeycaps = Record<string, string>;
// Settings.shortcuts: { bindings: ShortcutBindings; keycaps: ShortcutKeycaps }
export function setShortcuts(shortcuts: Settings["shortcuts"]): void;
```

- [ ] **Step 1: Write the failing Rust core tests** in `tests/settings.rs`: `keycaps_default_to_an_empty_map` (`to_value(default)["shortcuts"] == json!({"bindings": {}, "keycaps": {}})`); `keycaps_round_trip_through_the_file_codec` (`{"Q": "A"}`); `lenient_keycaps_not_an_object_warns_and_uses_empty` (`"keycaps": 7` beside `"appearance": {"diffFontSize": 16}` → empty, size 16, `fields == ["shortcuts.keycaps"]`); `lenient_keycap_entry_of_wrong_type_is_dropped_with_a_warning` (`{"Q": 5, "K": "T"}` → `{"K": "T"}`, `fields == ["shortcuts.keycaps.Q"]`); `lenient_keycap_blank_is_dropped_and_whitespace_trimmed` (`{"Q": " A ", "K": " "}` → `{"Q": "A"}`, warning `shortcuts.keycaps.K` / `blank; dropped`); `patch_keycaps_absent_keeps_present_replaces_wholesale` (start `{"Q": "A", "K": "T"}`; appearance patch keeps both; `{"keycaps": {"F": "U"}}` → exactly `{"F": "U"}`; `{"keycaps": {}}` → empty; bindings patch alone leaves keycaps untouched). Rust treats keys and values as opaque strings; the character class is the page's rule.
- [ ] **Step 2: Run** `cargo test --manifest-path Cargo.toml --workspace --test settings` (from `src-tauri`) → FAIL.
- [ ] **Step 3: Implement** the field, the patch field, `fn read_keycaps(obj, warnings) -> BTreeMap<String, String>` mirroring `read_bindings`, the `apply` line, and the normalise `retain` pass for keycaps. Update `src/lib/store/settingsDefaults.json`.
- [ ] **Step 4: Run** the same test → PASS.
- [ ] **Step 5: Write the failing app-store tests** in `src-tauri/tests/settings_store.rs`: `update_persists_keycaps_and_round_trips` (patch `{"shortcuts":{"keycaps":{"Q":"A"}}}`, reload gives the map, file text contains `"keycaps"`), `init_script_carries_keycaps` (contains `"keycaps":{"Q":"A"}`).
- [ ] **Step 6: Run** `cargo test --manifest-path Cargo.toml --workspace --test settings_store keycap` → PASS; then the full Rust gate → PASS, clean.
- [ ] **Step 7: Write the failing TS tests**: `settings.test.ts` asserts `DEFAULT_SETTINGS.shortcuts` equals `{ bindings: {}, keycaps: {} }`; `settingsActions.test.ts` replaces the two `setShortcutBindings` tests with `setShortcuts sends both maps under shortcuts` (`{ bindings: { fetch: "Mod+Alt+Q" }, keycaps: { fetch: "A" } }` → `updateSettings` called with `{ shortcuts: { bindings: {…}, keycaps: {…} } }`) and `setShortcuts replaces both maps wholesale` (second call `{ bindings: { pull: "Mod+U" }, keycaps: {} }` → local state equals it).
- [ ] **Step 8: Run** `npx vitest run src/lib/store` → FAIL.
- [ ] **Step 9: Implement** `ShortcutKeycaps`, `Settings.shortcuts.keycaps`, `DEFAULT_SETTINGS`, `setShortcuts`; delete `setShortcutBindings`; update its callers (`src/features/settings/ShortcutSettings.tsx` `commit` sends `{ bindings: clean, keycaps: overridesKeycaps }` — pass the current `keycaps` through unchanged for now; `src/app/bootstrapShortcuts.test.ts`, `src/lib/shortcuts/useShortcutKeys.test.tsx` and any other caller switch to `setShortcuts({ bindings, keycaps: {} })`); fix every full `Settings` literal `typecheck` reports.
- [ ] **Step 10: Run** `npm run test:coverage && npm run lint && npm run typecheck` → PASS, 100 %.
- [ ] **Step 11: Commit** all touched files → `feat(GR-18): keycaps map in the shortcuts settings section; setShortcuts action`

---

### Task 2: AltGr guard, keycap capture and display in the chord library; `KeyParts` module; dialog and tab-bar display

**Files:**

- Modify: `src/lib/shortcuts/chord.ts` (`isAltGraph`, `chordFromEvent` guard, `keycapFromEvent`, `isKeyToken`), `src/lib/shortcuts/index.ts` (`matchesShortcut` guard, `validKeycaps`, `formatKeyParts`/`formatKeys` keycaps parameter), `src/lib/shortcuts/useShortcutKeys.ts` (`useKeycaps`), `src/features/settings/ShortcutsDialog.tsx` (import `KeyParts`, keycap-aware rows), `src/features/settings/ShortcutsDialog.module.css` (remove `.kbd`, `.unbound`), `src/features/settings/ShortcutSettings.tsx` (import path for `KeyParts` only), `src/app/TabBar.tsx` (keycaps in titles)
- Create: `src/features/settings/KeyParts.tsx`, `src/features/settings/KeyParts.module.css`
- Test: `src/lib/shortcuts/chord.test.ts`, `src/lib/shortcuts/shortcuts.test.ts`, `src/lib/shortcuts/useShortcutKeys.test.tsx`, `src/features/settings/KeyParts.test.tsx` (new; move the KeyParts cases out of `ShortcutsDialog.test.tsx`), `src/features/settings/ShortcutsDialog.test.tsx`, `src/app/TabBar.test.tsx`

**Interfaces:**

- Consumes: Task 1's `ShortcutKeycaps`, `Settings.shortcuts.keycaps`, `setShortcuts`; GR-18's `parseChord`, `chordToString`, `KEY_TOKENS`/`KEY_SET` (make a `isKeyToken(s: string): boolean` export if needed), `resolveBindings`, `useEffectiveBindings`.
- Produces: the signatures in Global Constraints plus `export function KeyParts({ parts }: { parts: string[] | null })` from `KeyParts.tsx`.

- [ ] **Step 1: Write the failing `chord.test.ts` tests**: `isAltGraph` true when `getModifierState("AltGraph")` returns true, false when it returns false, false when the method is absent; `chordFromEvent returns null under AltGraph` (`{ code: "KeyE", key: "€", ctrlKey: true, altKey: true, getModifierState: () => true }`); `keycapFromEvent records the keycap for a Dvorak letter` (`{ code: "KeyQ", key: "a" }`, chord key `Q` → `"A"`); `returns the same letter when the layout matches` (`key "q"`, chord `Q` → `"Q"`); `ignores a shifted glyph` (`key "!"`, chord `1` → null); `ignores an accented glyph` (`key "å"`, chord `A` → null); `ignores a dead key` (`key "Dead"` → null); `ignores F-keys and named keys` (chord `F5` → null, chord `Enter` → null); `records a swapped punctuation keycap` (`code Semicolon`, `key ","`, chord `;` → `","`); `records an upper-case keycap for Shift+letter` (`key "A"`, shiftKey, chord `Q` → `"A"`); `isKeyToken` true for `A`, `7`, `,`, `F5`, `Enter`, false for `a`, `é`, `ab`, `Escape`.
- [ ] **Step 2: Run** `npx vitest run src/lib/shortcuts/chord.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `chord.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Write the failing `shortcuts.test.ts` tests**: `matchesShortcut ignores an AltGraph event` (active `{ fetch: "Mod+Alt+E" }`, event `{ ctrlKey, altKey, key: "€", code: "KeyE", getModifierState: () => true }` → false; same event with `() => false` → true); `validKeycaps keeps a learned entry` (`{ Q: "A" }` → same); `validKeycaps drops malformed and identity entries` (`{ Q: "Q", Enter: "A", q: "A", R: "ab", S: "é", T: "B" }` → `{ T: "B" }`); `formatKeyParts replaces the last part with the learned keycap` (`("Mod+Alt+Q", { Q: "A" })` → `["Ctrl","Alt","A"]`, Mac `["⌘","⌥","A"]`; a default `("Mod+Shift+F", { F: "U" })` → `["Ctrl","Shift","U"]`); `formatKeys with keycaps` (`"Ctrl+Alt+A"`, Mac `"⌘⌥A"`); `without a matching entry unchanged` (`("Mod+K", { Q: "A" })` → `["Ctrl","K"]`; no argument → unchanged).
- [ ] **Step 6: Run** `npx vitest run src/lib/shortcuts/shortcuts.test.ts` → FAIL.
- [ ] **Step 7: Implement** in `index.ts`.
- [ ] **Step 8: Run** → PASS.
- [ ] **Step 9: Write the failing hook, KeyParts, dialog and tab-bar tests**: `useShortcutKeys.test.tsx`: `useKeycaps` is `{}` by default, `{ Q: "A" }` after `seedSettings({ shortcuts: { bindings: {}, keycaps: { Q: "A", Enter: "B" } } })` (the invalid entry filtered), and an equal-by-value save keeps the same object. `KeyParts.test.tsx`: renders one `<kbd>` per part; `null` renders `Unbound` (move these from `ShortcutsDialog.test.tsx`). `ShortcutsDialog.test.tsx`: `rows show learned keycaps on default and custom chords` (seed `{ bindings: { fetch: "Mod+Alt+Q" }, keycaps: { Q: "A", K: "T" } }` → Fetch row parts `["Ctrl","Alt","A"]`, Command palette row parts `["Ctrl","T"]`). `TabBar.test.tsx`: `titles use learned keycaps` (seed `{ bindings: {}, keycaps: { K: "T" } }` → `Command palette (Ctrl+T)`).
- [ ] **Step 10: Run** the four files → FAIL.
- [ ] **Step 11: Implement**: `useKeycaps` (`useShallow` on `keycaps`, `useMemo(() => validKeycaps(keycaps), [keycaps])`); create `KeyParts.tsx` + `KeyParts.module.css` (move `.kbd`, `.unbound`); `ShortcutsDialog` rows take `formatKeyParts(keys, keycaps)` with `useKeycaps()`; `ShortcutSettings` imports `KeyParts` from `./KeyParts` (no other change); `TabBar` uses `useKeycaps()` in both titles.
- [ ] **Step 12: Run** `npm run test:coverage && npm run lint && npm run typecheck` → PASS, 100 %.
- [ ] **Step 13: Commit** → `feat(GR-18): AltGr guard, keycap capture and display; KeyParts module`

---

### Task 3: Unbind, keycap recording, and the cross-platform hint in the Settings section

**Files:**

- Modify: `src/features/settings/ShortcutSettings.tsx`, `src/features/settings/SettingsDialog.module.css` (if a style is needed for the Unbind button), `docs/superpowers/specs/2026-10-29-gr18-rebindable-shortcuts-design.md` (§7 Known limits: add the two limits from the GR-18b spec §6; §8 walk: add items 8 and 9)
- Test: `src/features/settings/ShortcutSettings.test.tsx`

**Interfaces:**

- Consumes: Task 1's `setShortcuts`, `Settings["shortcuts"]`; Task 2's `isAltGraph`, `keycapFromEvent`, `useKeycaps`, `formatKeyParts(keys, keycaps)`, `formatKeys(keys, keycaps)`, `KeyParts` from `./KeyParts`.
- Produces: no new exports; `Capture` state gains `keycap: string | null` in the `conflict` phase; a private `learn(keycaps, chord, keycap)` helper.

- [ ] **Step 1: Write the failing tests** in `ShortcutSettings.test.tsx` (the `bindings()` helper becomes `shortcuts()` returning `settings.shortcuts`): `Unbind is shown on bound rows including defaults and hidden on unbound rows`; `Unbind sets null, leaves keycaps alone, focuses the chord button and shows Reset` (seed `{ bindings: { fetch: "Mod+Alt+Q" }, keycaps: { Q: "A" } }` → `{ bindings: { fetch: null }, keycaps: { Q: "A" } }`); `bare Backspace while listening unbinds`; `bare Delete while listening unbinds`; `Mod+Backspace while listening binds the chord` (→ `bindings.fetch === "Mod+Backspace"`); `a Dvorak capture learns the keycap and shows it on every chord using that key` (keyDown `{ code: "KeyQ", key: "a", ctrlKey: true, altKey: true }` on Fetch → `{ bindings: { fetch: "Mod+Alt+Q" }, keycaps: { Q: "A" } }`, Fetch button parts `Ctrl`,`Alt`,`A`, description `Ctrl+Alt+A`; then seed `pull: "Mod+Q"` and its row shows `Ctrl`,`A`); `a QWERTY capture stores no keycap`; `a QWERTY capture on a learned key removes its entry` (seed `keycaps { Q: "A" }`, capture `{ code: "KeyQ", key: "q", ctrlKey: true, altKey: true }` → `keycaps {}`); `re-pressing the current chord on a new layout updates the keycap without changing the binding` (seed `fetch: "Mod+Alt+Q"`, press `{ code: "KeyQ", key: "a", ctrlKey, altKey }` → bindings unchanged, `keycaps { Q: "A" }`, one save); `Reset leaves keycaps alone`; `Replace learns the winner's keycap` (Pull captures `{ code: "KeyK", key: "t", ctrlKey: true }` → `{ bindings: { pull: "Mod+K", palette: null }, keycaps: { K: "T" } }`); `an AltGraph keydown keeps listening without an error`; `Reset all sends both empty maps`; `the hint names the cross-platform rule` (PC text; and the Mac text with `navigator.platform` spied to `MacIntel`).
- [ ] **Step 2: Run** `npx vitest run src/features/settings/ShortcutSettings.test.tsx` → FAIL.
- [ ] **Step 3: Implement** per Global Constraints: `commit(next: Settings["shortcuts"])`, `learn`, the Unbind button (third column, before Reset, `aria-label="Unbind <label>"`, visible when `effective[id] !== null`), the bare Backspace/Delete branch and the `isAltGraph` branch in `onCaptureKey`, keycap learning in the same-chord, conflict and free-chord paths, `resetAll` sending both maps, the new hint copy via `modifierLabels()` and `isMac()`.
- [ ] **Step 4: Run** → PASS; then `npm run test:coverage && npm run lint && npm run typecheck` → PASS, 100 %.
- [ ] **Step 5: Amend the GR-18 spec**: in §7 Known limits, replace the `e.code` display bullet with the learned-layout wording and add the AltGr bullet (copy both from the GR-18b spec §6); append walk items 8–9 to §8 (GR-18b spec §7). Run `npx prettier --write` on it.
- [ ] **Step 6: Commit** code → `feat(GR-18): Unbind, keycap recording, cross-platform hint in the shortcuts section`; docs → `docs(GR-18): known limits and walk items for the follow-ups`.

---

## After the tasks

- Whole-branch review (subagent-driven-development); minors fixed on-branch (owner rule).
- Merge to main (no-ff), push; one closing comment on GR-18, **no status change** (owner instruction).
- Owner acceptance walk items 8–9 on COSMIC.
