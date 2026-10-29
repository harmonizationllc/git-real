# GR-18 Rebindable Keyboard Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every GR-14 shortcut can be rebound by pressing keys in a new Settings section, conflicts are resolved at capture time, bindings persist in `settings.json` under `shortcuts.bindings`, and every chord consumer reads the effective binding.

**Architecture:** Rust gains a ninth settings section `shortcuts` (`bindings: BTreeMap<String, Option<String>>`, shape-validated only, replaced wholesale on patch). The front end gains a chord grammar (`chord.ts`), a deterministic two-pass `resolveBindings`, module-level active bindings that `matchesShortcut` reads, a store-backed hook for React consumers, and a `bootstrapShortcuts` bridge from the store to the module state. A `ShortcutSettings` section captures chords with `e.code`, reports conflicts, and writes only non-default entries.

**Tech Stack:** Rust 2024 + serde, Tauri 2, React 19 + TypeScript, zustand, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-29-gr18-rebindable-shortcuts-design.md`

## Global Constraints

- Tests first and written by the test role; the developer role never edits test files (CLAUDE.md). Red before green.
- Only `src/lib/ipc` imports `@tauri-apps/api/*`. `git-real-core` has no Tauri dependency and does not know shortcut ids or the chord grammar.
- `SETTINGS_VERSION` stays `2`. The `shortcuts` section is additive; `SECTIONS` grows to nine.
- File shape: `"shortcuts": { "bindings": { "<id>": "<chord>" | null } }`; default `{ "bindings": {} }`; only non-default entries are stored. Patch `bindings` replaces the map wholesale; never an error. Normalise trims string values and drops blank ones with warning `shortcuts.bindings.<id>` / `blank; dropped`. Lenient load: non-object `bindings` → warning `shortcuts.bindings`, empty map; a non-string, non-null entry → dropped with warning `shortcuts.bindings.<id>` (`<err>; dropped`).
- Chord grammar (spec §4): `[Mod+][Alt+][Shift+]<Key>`, modifiers in that order, each at most once. Key tokens: `A`–`Z`, `0`–`9`, `F1`–`F12`, `Enter`, `Space`, `Backspace`, `Delete`, `Insert`, `Home`, `End`, `PageUp`, `PageDown`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, and `,` `.` `/` `;` `'` `[` `]` `\` `-` `=` `` ` ``. `codeForKey`: letter → `Key<L>`, digit → `Digit<d>`, `,`→`Comma`, `.`→`Period`, `/`→`Slash`, `;`→`Semicolon`, `'`→`Quote`, `[`→`BracketLeft`, `]`→`BracketRight`, `\`→`Backslash`, `-`→`Minus`, `=`→`Equal`, `` ` ``→`Backquote`, every other token → itself. `isBindable(c) = c.mod || c.alt || /^F\d{1,2}$/.test(c.key)`.
- Resolution (spec §5): overrides pass in registry order (parse + bindable + chord unclaimed → assign; `null` → unbound; else ignore), then defaults pass (default unless an override claimed it → unbound).
- `matchesShortcut(e, id)`: false when `e.repeat || e.defaultPrevented || isComposing(e)` or the effective chord is `null`; requires `(e.ctrlKey || e.metaKey) === mod`, `e.altKey === alt`, `e.shiftKey === shift`; then `e.code === codeForKey(key) || e.key.toLowerCase() === key.toLowerCase()`.
- Copy (verbatim): section name `Keyboard shortcuts`; chord button accessible name `Change shortcut for <label>`; listening text `Press keys…`; status `Listening for a shortcut. Press Escape to cancel.`; error `Add <Mod> or <Alt>, or use a function key.` where `<Mod>`/`<Alt>` are the platform labels (`Ctrl`/`Alt`, `⌘`/`⌥`); conflict `Already used by <other label>`; buttons `Replace`, `Cancel`, `Reset` (accessible name `Reset <label> to default`, title `Reset to <formatKeys(default)>`), `Reset all to defaults`; hint `Press a key combination with <Mod> or <Alt>, or a function key. Changes apply at once.`; unbound cell `Unbound`; reference dialog button `Customize…`; tab-bar title `<label> (<keys>)` when bound, `<label>` when unbound.
- Commits: explicit paths only (`git add <files>`), never `-A`, never amend/reset/stash. Subjects `feat(GR-18): …`, `test(GR-18): …`, `docs(GR-18): …`. Trailers from the session's attribution reminder.
- Checks: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check` (from `src-tauri`); `npm run test:coverage` at 100 % statements/branches/functions/lines for `src/`; `npm run lint`; `npm run typecheck`.
- Model per dispatch is mandatory: Task 1 implementer → `sonnet`; Tasks 2 and 3 implementers → `opus`; every task reviewer → `opus`; final branch review → the most capable model available.

## Review Focus

1. A file with `"bindings": { "fetch": "Mod+K" }` and no entry for `palette` must open the palette on nothing and fetch on `Ctrl+K`, never both (Task 2 test `an override on another id's default leaves that id unbound`).
2. A Cyrillic layout pressing the physical F key with Ctrl+Alt must match a `Mod+Alt+F` binding, since GR-14 relied on `e.code` for letters (Task 2 test `chordFromEvent reads the physical key on a non-Latin layout` and `matchesShortcut fires a custom Alt chord by code`).
3. Pressing `Ctrl+K` while a row is listening must capture, not open the palette, because the `useGlobalShortcuts` chords stay live inside shell dialogs (Task 3 test `keydown while listening does not reach the window listener`).
4. Rebinding `commit` away from `Mod+Enter` must not break plain `Enter` in the subject field, and `Ctrl+Enter` must then do nothing (Task 2 test `with commit rebound to Mod+S, Ctrl+S submits and Ctrl+Enter does not`).
5. A hand-edited `"bindings": { "fetch": 5 }` must keep every other setting and log one warning naming `shortcuts.bindings.fetch` (Task 1 test `lenient_binding_entry_of_wrong_type_is_dropped_with_a_warning`).

---

### Task 1: The `shortcuts` settings section (Rust core, app store, shared fixture, TS types, store defaults, action)

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/settings.rs` (`ShortcutSettings`, `ShortcutsPatch`, `Settings.shortcuts`, `SettingsPatch.shortcuts`, `SECTIONS`, `from_json_lenient`, `apply`, `normalise`)
- Modify: `src/lib/store/settingsDefaults.json` (`"shortcuts": { "bindings": {} }` after `updates`)
- Modify: `src/lib/ipc/types.ts` (`ShortcutBindings`, `Settings.shortcuts`)
- Modify: `src/lib/store/settings.ts` (`DEFAULT_SETTINGS.shortcuts`)
- Modify: `src/lib/store/settingsActions.ts` (`setShortcutBindings`)
- Test: `src-tauri/crates/git-real-core/tests/settings.rs`, `src-tauri/tests/settings_store.rs`, `src/lib/store/settings.test.ts`, `src/lib/store/settingsActions.test.ts`

**Interfaces:**

- Consumes (verified): `leaf()`, `trimmed()`, `set()`, `SettingsWarning::new(field, message)` in `settings.rs`; `SettingsStore::update`, `to_init_script` in `settings_store.rs`; `setPref` in `settings.ts`; test helpers `patch(json)`, `fields(&warnings)`, `FIXTURE` in `tests/settings.rs`, `common::temp_file_path` in `tests/settings_store.rs`.
- Produces:

```rust
// settings.rs
pub struct ShortcutSettings { pub bindings: BTreeMap<String, Option<String>> }   // Default: empty; serde camelCase, default
pub struct ShortcutsPatch { pub bindings: Option<BTreeMap<String, Option<String>>> } // skip_serializing_if none
// Settings { …, updates, shortcuts: ShortcutSettings, window }  SettingsPatch { …, shortcuts: Option<ShortcutsPatch>, … }
```

```ts
// src/lib/ipc/types.ts
export type ShortcutBindings = Record<string, string | null>;
// Settings gains: shortcuts: { bindings: ShortcutBindings };
// src/lib/store/settingsActions.ts
export function setShortcutBindings(bindings: ShortcutBindings): void; // setPref({ shortcuts: { bindings } })
```

- [ ] **Step 1: Write the failing Rust core tests** in `tests/settings.rs` (extend; `default_settings_equal_the_shared_fixture` will fail until the fixture and struct both change):
  - `shortcuts_default_to_an_empty_map`: `Settings::default().shortcuts.bindings.is_empty()`; `serde_json::to_value(&Settings::default())["shortcuts"] == json!({"bindings": {}})`.
  - `shortcut_bindings_round_trip_through_the_file_codec`: set `bindings = {"fetch": Some("Mod+Alt+F"), "palette": None}`, `SettingsFile::current(s)` → pretty JSON → `SettingsFile::parse` → equal, no warnings; the text contains `"palette": null`.
  - `lenient_bindings_not_an_object_warns_and_uses_empty`: `{"shortcuts":{"bindings": 3}, "appearance":{"diffFontSize":16}}` → empty map, `diff_font_size == 16`, `fields == ["shortcuts.bindings"]`.
  - `lenient_binding_entry_of_wrong_type_is_dropped_with_a_warning` (Review Focus 5): `{"shortcuts":{"bindings":{"fetch": 5, "pull": "Mod+P", "push": null}}}` → map `{"pull": Some("Mod+P"), "push": None}`, `fields == ["shortcuts.bindings.fetch"]`.
  - `lenient_binding_blank_is_dropped_and_whitespace_trimmed`: `{"fetch": "  Mod+G ", "pull": "   "}` → `{"fetch": Some("Mod+G")}`, `fields == ["shortcuts.bindings.pull"]`, message `"blank; dropped"`.
  - `lenient_keeps_unknown_shortcut_ids`: `{"notAShortcut": "Mod+Q"}` kept, no warnings.
  - `lenient_shortcuts_section_not_an_object_warns`: `{"shortcuts": []}` → defaults, `fields == ["shortcuts"]`.
  - `patch_bindings_absent_keeps_present_replaces_wholesale`: start with `{"fetch": Some("Mod+G"), "pull": None}`; `apply(patch(json!({"appearance":{"theme":"dark"}})))` keeps both; `apply(patch(json!({"shortcuts":{"bindings":{"push": "Mod+U"}}})))` → exactly `{"push": Some("Mod+U")}`; `apply(patch(json!({"shortcuts":{"bindings":{}}})))` → empty.
  - `patch_bindings_trims_and_drops_blank`: `{"fetch": " Mod+G ", "pull": ""}` → `{"fetch": Some("Mod+G")}`, `Ok`.
- [ ] **Step 2: Run** `cargo test -p git-real-core --test settings` (from `src-tauri`) → FAIL (no `shortcuts` field).
- [ ] **Step 3: Implement** in `settings.rs`: the two structs, the two new fields (`shortcuts` after `updates` in both `Settings` and `SettingsPatch`), `"shortcuts"` appended to `SECTIONS`, a private `fn read_bindings(obj: &Value, warnings: &mut Vec<SettingsWarning>) -> BTreeMap<String, Option<String>>` used by `from_json_lenient` (missing or non-object section → empty silently; present non-object `bindings` → warning + empty; per-entry `Option<String>::deserialize` with the drop-and-warn rule), `apply` replacing the map when `p.bindings.is_some()`, and in `normalise` a trim/drop pass over the map (`retain` + warning per dropped id, iterating in `BTreeMap` order).
- [ ] **Step 4: Update the fixture** `src/lib/store/settingsDefaults.json`: add `"shortcuts": { "bindings": {} }` between `updates` and `window`.
- [ ] **Step 5: Run** `cargo test -p git-real-core --test settings` → PASS.
- [ ] **Step 6: Write the failing app-store tests** in `src-tauri/tests/settings_store.rs`:
  - `update_persists_shortcut_bindings_and_round_trips`: patch `{"shortcuts":{"bindings":{"fetch":"Mod+Alt+F","palette":null}}}` → result map as given; reloading `SettingsStore::load(path)` gives the same map; the file text contains `"palette": null`.
  - `init_script_carries_the_shortcuts_section`: after that update, `to_init_script()` contains `"shortcuts":{"bindings":{"fetch":"Mod+Alt+F","palette":null}}`.
- [ ] **Step 7: Run** `cargo test --workspace --test settings_store shortcut` → PASS (the core change from Step 3 already carries the section through serde; these tests pin the app-layer file and init-script behaviour). Then `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --check` → PASS, clean.
- [ ] **Step 8: Write the failing TS tests**:
  - `src/lib/store/settings.test.ts`: in `describe("defaults")`, the existing fixture comparison must now include `shortcuts`; add `it("DEFAULT_SETTINGS.shortcuts is an empty bindings map", …)` asserting `DEFAULT_SETTINGS.shortcuts` equals `{ bindings: {} }`.
  - `src/lib/store/settingsActions.test.ts`: `it("setShortcutBindings sends the whole map under shortcuts.bindings", …)`: call `setShortcutBindings({ fetch: "Mod+Alt+F", palette: null })`, advance the save timer, assert `updateSettings` was called with `{ shortcuts: { bindings: { fetch: "Mod+Alt+F", palette: null } } }`.
- [ ] **Step 9: Run** `npx vitest run src/lib/store` → FAIL (type errors / missing export).
- [ ] **Step 10: Implement** `ShortcutBindings` and `Settings.shortcuts` in `types.ts`; `shortcuts: { bindings: {} }` in `DEFAULT_SETTINGS`; `setShortcutBindings` in `settingsActions.ts`.
- [ ] **Step 11: Run** `npx vitest run src/lib/store src/lib/ipc && npm run typecheck && npm run lint` → PASS. Every other test file that builds a full `Settings` literal must still compile; fix literals (`shortcuts: { bindings: {} }`) where `typecheck` reports them.
- [ ] **Step 12: Commit** `git add src-tauri/crates/git-real-core/src/settings.rs src-tauri/crates/git-real-core/tests/settings.rs src-tauri/tests/settings_store.rs src/lib/store/settingsDefaults.json src/lib/ipc/types.ts src/lib/store/settings.ts src/lib/store/settingsActions.ts src/lib/store/settings.test.ts src/lib/store/settingsActions.test.ts` (plus any literal fixes) → `feat(GR-18): shortcuts settings section with shape-validated bindings`

---

### Task 2: Chord grammar, effective bindings, matching, store bridge, and every consumer

**Files:**

- Create: `src/lib/shortcuts/chord.ts`, `src/lib/shortcuts/useShortcutKeys.ts`, `src/app/bootstrapShortcuts.ts`
- Modify: `src/lib/shortcuts/index.ts` (`resolveBindings`, `setActiveBindings`, `activeKeys`, `matchesShortcut` via active bindings and `chord.ts`; `expectedCode` replaced by `codeForKey`; re-export `chord.ts`), `src/main.tsx` (`bootstrapShortcuts()` after `bootstrapAppearance()`), `src/features/commit/MessageEditor.tsx` (`handleEnter`), `src/app/TabBar.tsx` (titles via `useShortcutKeys`), `src/features/settings/ShortcutsDialog.tsx` (rows via `useEffectiveBindings`, `Unbound` cell)
- Test: `src/lib/shortcuts/chord.test.ts` (new), `src/lib/shortcuts/shortcuts.test.ts` (extend), `src/lib/shortcuts/useShortcutKeys.test.tsx` (new), `src/app/bootstrapShortcuts.test.ts` (new), `src/features/commit/MessageEditor.test.tsx`, `src/app/TabBar.test.tsx`, `src/app/useGlobalShortcuts.test.tsx`, `src/app/RepoPane.test.tsx`, `src/features/settings/ShortcutsDialog.test.tsx` (extend each)

**Interfaces:**

- Consumes: Task 1's `ShortcutBindings`, `Settings.shortcuts.bindings`, `useSettings`; existing `SHORTCUTS`, `shortcut(id)`, `formatKeyParts`, `formatKeys`, `isComposing`, `MAC_LABELS`/`PC_LABELS`/`isMac` in `index.ts`; test helpers `resetSettings`/`seedSettings` in `src/test/settingsStore.ts`.
- Produces:

```ts
// chord.ts
export interface Chord {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}
export function parseChord(keys: string): Chord | null;
export function chordToString(chord: Chord): string;
export function chordFromEvent(e: KeyboardEvent | React.KeyboardEvent): Chord | null;
export function isBindable(chord: Chord): boolean;
export function codeForKey(key: string): string;
export function modifierLabels(): { mod: string; alt: string }; // platform words for copy
// index.ts
export type EffectiveBindings = Record<ShortcutId, string | null>;
export function resolveBindings(overrides: ShortcutBindings): EffectiveBindings;
export function setActiveBindings(bindings: EffectiveBindings): void;
export function activeKeys(id: ShortcutId): string | null;
export function matchesShortcut(e, id): boolean; // unchanged signature, reads activeKeys
// useShortcutKeys.ts
export function useEffectiveBindings(): EffectiveBindings;
export function useShortcutKeys(id: ShortcutId): string | null;
// bootstrapShortcuts.ts
export function bootstrapShortcuts(): () => void;
```

- [ ] **Step 1: Write the failing grammar tests** `src/lib/shortcuts/chord.test.ts`:
  - `it.each(SHORTCUTS)("round-trips the default %s", …)`: `chordToString(parseChord(s.keys)!) === s.keys`.
  - `parseChord` accepts one token of each class (`"Mod+A"`, `"Alt+1"`, `"F5"`, `"Shift+F5"`, `"Mod+Space"`, `"Mod+ArrowLeft"`, `"Mod+Alt+Shift+\\"`, ``"Mod+`"``) and rejects `"Shift+Mod+F"` (order), `"Mod+Mod+F"` (duplicate), `"Mod+Escape"`, `"Mod+Tab"`, `"Mod"`, `""`, `"Mod+f"` (lower case), `"Ctrl+F"`.
  - `codeForKey` table: `F`→`KeyF`, `1`→`Digit1`, `,`→`Comma`, `/`→`Slash`, `` ` ``→`Backquote`, `PageUp`→`PageUp`, `F5`→`F5`.
  - `chordFromEvent reads the physical key on a non-Latin layout` (Review Focus 2): `{ code: "KeyF", key: "а", ctrlKey: true, altKey: true }` → `{ mod: true, alt: true, shift: false, key: "F" }`; `{ code: "Digit1", key: "!", shiftKey: true, ctrlKey: true }` → key `1`; `{ code: "Comma", key: ",", metaKey: true }` → mod true, key `,`; `{ code: "F5", key: "F5" }` → `{ mod:false, alt:false, shift:false, key:"F5" }`; `{ code: "ControlLeft", key: "Control", ctrlKey: true }` → null; `{ code: "Escape", key: "Escape" }` → null; `{ code: "MediaPlayPause" }` → null.
  - `isBindable` matrix: `Mod+A` true, `Alt+A` true, `F5` true, `Shift+F5` true, `Shift+A` false, `Enter` false, `Space` false.
  - `modifierLabels` returns `{ mod: "Ctrl", alt: "Alt" }` with `navigator.platform` `"Linux x86_64"` and `{ mod: "⌘", alt: "⌥" }` with `"MacIntel"` (spy as the existing `formatKeys` tests do).
- [ ] **Step 2: Run** `npx vitest run src/lib/shortcuts/chord.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `chord.ts` per Global Constraints. `chordFromEvent` maps `e.code` through the inverse of `codeForKey`; a code with no token is `null`.
- [ ] **Step 4: Run** `npx vitest run src/lib/shortcuts/chord.test.ts` → PASS.
- [ ] **Step 5: Write the failing resolution and matching tests** in `shortcuts.test.ts` (new `describe` blocks; `afterEach` restores `setActiveBindings(resolveBindings({}))`):
  - `resolveBindings({})` equals every registry default.
  - custom: `{ fetch: "Mod+Alt+F" }` → fetch `Mod+Alt+F`, everything else default.
  - `{ fetch: null }` → fetch `null`.
  - ignored: unknown id, `{ fetch: "Shift+Mod+F" }` (malformed), `{ fetch: "Shift+A" }` (unbindable) → defaults.
  - `two overrides on one chord keep the first in registry order`: `{ pull: "Mod+G", fetch: "Mod+G" }` → fetch `Mod+G` (fetch precedes pull in the registry), pull `Mod+Shift+L`.
  - `an override on another id's default leaves that id unbound` (Review Focus 1): `{ fetch: "Mod+K" }` → fetch `Mod+K`, palette `null`.
  - `setActiveBindings`/`activeKeys`: after `setActiveBindings(resolveBindings({ fetch: "Mod+Alt+F" }))`, `matchesShortcut({ctrlKey, altKey, key:"f", code:"KeyF"}, "fetch")` true; `{ctrlKey, shiftKey, key:"F", code:"KeyF"}` false; `matchesShortcut fires a custom Alt chord by code` with `key: "ф"` true; with `altKey: false` false; after `{ fetch: null }` nothing matches fetch; the existing matrix passes unchanged against the defaults.
- [ ] **Step 6: Run** `npx vitest run src/lib/shortcuts` → FAIL (exports missing).
- [ ] **Step 7: Implement** in `index.ts`: `resolveBindings` (two passes over `SHORTCUTS`, claimed set of canonical strings), module `let active: EffectiveBindings = resolveBindings({})`, `setActiveBindings`, `activeKeys`, and `matchesShortcut` rewritten over `parseChord(activeKeys(id))` with the modifier and code rules. Delete `expectedCode`; `export * from "./chord"`.
- [ ] **Step 8: Run** `npx vitest run src/lib/shortcuts` → PASS.
- [ ] **Step 9: Write the failing bridge tests**:
  - `src/lib/shortcuts/useShortcutKeys.test.tsx` (mock `../ipc` like `settingsActions.test.ts`; `resetSettings` in `beforeEach`): `useShortcutKeys("fetch")` is `Mod+Shift+F` by default and `Mod+Alt+F` after `seedSettings({ shortcuts: { bindings: { fetch: "Mod+Alt+F" } } })`; `useEffectiveBindings()` returns the same object across two renders with unchanged bindings (memoised) and a new one after a seed.
  - `src/app/bootstrapShortcuts.test.ts` (fresh module graph per test like `applyAppearance.test.ts`): with `window.__GIT_REAL_SETTINGS__` holding `{ fetch: "Mod+Alt+F" }`, after `bootstrapShortcuts()` `activeKeys("fetch") === "Mod+Alt+F"`; a later `setShortcutBindings({ fetch: null })` (timers advanced) makes `activeKeys("fetch")` null; after the returned uninstaller runs, a further change is not followed.
- [ ] **Step 10: Run** `npx vitest run src/lib/shortcuts/useShortcutKeys.test.tsx src/app/bootstrapShortcuts.test.ts` → FAIL.
- [ ] **Step 11: Implement** `useShortcutKeys.ts` (select `s.settings.shortcuts.bindings`, `useMemo(() => resolveBindings(bindings), [bindings])`) and `bootstrapShortcuts.ts` (`setActiveBindings(resolveBindings(useSettings.getState().settings.shortcuts.bindings))`, then `useSettings.subscribe((state, prev) => state.settings.shortcuts !== prev.settings.shortcuts && …)`; return the unsubscribe). Add `bootstrapShortcuts();` to `main.tsx` after `bootstrapAppearance();`.
- [ ] **Step 12: Run** the two files → PASS.
- [ ] **Step 13: Write the failing consumer tests** (each file mocks `../lib/ipc` or already does, and seeds bindings through `seedSettings`; for pure-DOM files, call `setActiveBindings(resolveBindings({...}))` directly and restore in `afterEach`):
  - `MessageEditor.test.tsx`: `with commit rebound to Mod+S, Ctrl+S submits and Ctrl+Enter does not` (Review Focus 4): `setActiveBindings(resolveBindings({ commit: "Mod+S" }))`; keyDown `{ key: "s", code: "KeyS", ctrlKey: true }` on the subject → `onSubmit` once; keyDown `{ key: "Enter", ctrlKey: true }` → not again; plain `Enter` on the subject still behaves as the existing test says.
  - `useGlobalShortcuts.test.tsx`: `a rebound palette chord opens the palette and the default no longer does`: `{ palette: "Mod+Alt+P" }`; `Ctrl+Alt+P` opens, `Ctrl+K` does not.
  - `RepoPane.test.tsx`: `a rebound fetch chord fetches and the default no longer does` with `{ fetch: "Mod+Alt+F" }`.
  - `TabBar.test.tsx`: `titles follow the effective bindings`: seed `{ palette: "Mod+Alt+P", settings: null }` → palette title `Command palette (Ctrl+Alt+P)`, settings title `Settings`.
  - `ShortcutsDialog.test.tsx`: `rows show effective chords and Unbound`: seed `{ fetch: "Mod+Alt+F", palette: null }` → the Fetch row has kbd parts `["Ctrl","Alt","F"]`; the Command palette row's Shortcut cell text is `Unbound` and has no `<kbd>`. (The `Customize…` button is Task 3.)
- [ ] **Step 14: Run** those five files → FAIL.
- [ ] **Step 15: Implement**: `MessageEditor.handleEnter` checks `matchesShortcut(e, "commit")` first (any key), then the existing `Enter`/composing guard and plain-Enter branch; `TabBar` uses `useShortcutKeys("palette")` / `("settings")` and builds `title` as `keys === null ? label : `${label} (${formatKeys(keys)})``; `ShortcutsDialog.rowsFor(group, bindings)` takes `useEffectiveBindings()` and renders `parts: string[] | null`, a `null` row as `<span className={styles.unbound}>Unbound</span>` (add `.unbound` to `ShortcutsDialog.module.css`).
- [ ] **Step 16: Run** `npm run test:coverage && npm run lint && npm run typecheck` → PASS, 100 %.
- [ ] **Step 17: Commit** `git add src/lib/shortcuts/chord.ts src/lib/shortcuts/chord.test.ts src/lib/shortcuts/index.ts src/lib/shortcuts/shortcuts.test.ts src/lib/shortcuts/useShortcutKeys.ts src/lib/shortcuts/useShortcutKeys.test.tsx src/app/bootstrapShortcuts.ts src/app/bootstrapShortcuts.test.ts src/main.tsx src/features/commit/MessageEditor.tsx src/features/commit/MessageEditor.test.tsx src/app/TabBar.tsx src/app/TabBar.test.tsx src/app/useGlobalShortcuts.test.tsx src/app/RepoPane.test.tsx src/features/settings/ShortcutsDialog.tsx src/features/settings/ShortcutsDialog.module.css src/features/settings/ShortcutsDialog.test.tsx` → `feat(GR-18): chord grammar, effective bindings, and consumers read them`

---

### Task 3: The Keyboard shortcuts section in Settings, and `Customize…` in the reference dialog

**Files:**

- Create: `src/features/settings/ShortcutSettings.tsx`
- Modify: `src/features/settings/SettingsDialog.tsx` (render `<ShortcutSettings />` after `<GitSettings />`), `src/features/settings/SettingsDialog.module.css` (`.chord`, `.unbound`, `.conflict` as needed), `src/features/settings/ShortcutsDialog.tsx` (`Customize…` button before `Close`), `src/lib/store/shell.ts` (`SettingsSection` gains `"shortcuts"`)
- Test: `src/features/settings/ShortcutSettings.test.tsx` (new), `src/features/settings/SettingsDialog.test.tsx`, `src/features/settings/ShortcutsDialog.test.tsx` (extend)

**Interfaces:**

- Consumes: Task 2's `chordFromEvent`, `chordToString`, `isBindable`, `modifierLabels`, `useEffectiveBindings`, `formatKeyParts`, `formatKeys`, `SHORTCUTS`, `SHORTCUT_GROUPS`, `shortcut(id)`; Task 1's `setShortcutBindings`, `useSettings` (`s.settings.shortcuts.bindings`); existing `Section` from `SettingsDialog.tsx`, `useShell.getState().open`.
- Produces: `export function ShortcutSettings(): JSX.Element`; `SettingsSection = … | "shortcuts"`.

- [ ] **Step 1: Write the failing section tests** `src/features/settings/ShortcutSettings.test.tsx` (mock `../../lib/ipc` with `updateSettings: vi.fn()`; `resetSettings()` in `beforeEach`; fake timers only where a save is awaited; render inside `renderWithProviders`; `bindings()` reads `useSettings.getState().settings.shortcuts.bindings` after advancing the 300 ms save timer):
  - `renders one table per group with every registry row and no static rows`: four tables by caption; 14 `Change shortcut for …` buttons; no `Close dialog or menu` text.
  - `a default row has no Reset button; an overridden row has one with the default in its title`: seed `{ fetch: "Mod+Alt+F" }` → `Reset Fetch to default` present with title `Reset to Ctrl+Shift+F`; `Reset Pull to default` absent.
  - `clicking the chord button starts listening`: button text `Press keys…`; status text `Listening for a shortcut. Press Escape to cancel.`
  - `Escape cancels without saving`: keyDown `{ key: "Escape", code: "Escape" }` → button shows the default parts again; `updateSettings` not called.
  - `a modifier alone keeps listening`: keyDown `{ key: "Control", code: "ControlLeft", ctrlKey: true }` → still `Press keys…`.
  - `an unbindable chord shows the error and keeps listening`: keyDown `{ key: "a", code: "KeyA" }` → alert `Add Ctrl or Alt, or use a function key.`; still listening.
  - `the current chord cancels`: on Fetch, keyDown `{ key: "F", code: "KeyF", ctrlKey: true, shiftKey: true }` → idle, no save.
  - `a free chord is saved as an override`: on Fetch, `{ key: "f", code: "KeyF", ctrlKey: true, altKey: true }` → `bindings()` equals `{ fetch: "Mod+Alt+F" }`; the button shows `Ctrl`,`Alt`,`F`; Reset appears.
  - `pressing the default again deletes the override`: seed `{ fetch: "Mod+Alt+F" }`; capture `Ctrl+Shift+F` → `bindings()` equals `{}`.
  - `a taken chord shows the conflict with Replace and Cancel`: on Pull, `{ key: "k", code: "KeyK", ctrlKey: true }` → text `Already used by Command palette`; buttons `Replace`, `Cancel`; `Replace` has focus; no save yet.
  - `Replace rebinds and unbinds the other`: → `bindings()` equals `{ pull: "Mod+K", palette: null }`; the palette row shows `Unbound`.
  - `Cancel in the conflict saves nothing`.
  - `blur while listening cancels`: `fireEvent.blur(button)` → idle, no save.
  - `starting a second row stops the first`: click Fetch, click Pull → only Pull reads `Press keys…`.
  - `Reset deletes the entry`: seed `{ fetch: "Mod+Alt+F", palette: null }`; click `Reset Fetch to default` → `bindings()` equals `{ palette: null }`.
  - `Reset all to defaults sends an empty map and is disabled when nothing is overridden`: disabled with `{}`; enabled after the seed; click → `bindings()` equals `{}`.
  - `keydown while listening does not reach the window listener` (Review Focus 3): add a `window` keydown spy; keyDown `Ctrl+K` on the listening button → spy not called; `e.defaultPrevented` true on the dispatched event.
  - `the hint uses platform words`: text `Press a key combination with Ctrl or Alt, or a function key. Changes apply at once.`
- [ ] **Step 2: Run** `npx vitest run src/features/settings/ShortcutSettings.test.tsx` → FAIL (module missing).
- [ ] **Step 3: Implement** `ShortcutSettings.tsx`: component state `capture: null | { id: ShortcutId; phase: "listening" | "conflict"; chord?: string; otherId?: ShortcutId; error?: string }`; `effective = useEffectiveBindings()`, `overrides = useSettings(s => s.settings.shortcuts.bindings)`; `commit(next: ShortcutBindings)` strips entries equal to the registry default and calls `setShortcutBindings`; the chord button's `onKeyDown` implements spec §6 step 2 in that order (`preventDefault` + `stopPropagation` first); `onBlur` cancels only in `listening`; a `useEffect` focuses the `Replace` button on entering `conflict`. Rows per `SHORTCUT_GROUPS` as in `ShortcutsDialog`, reusing its `.kbd` style via the dialog's module or a shared class.
- [ ] **Step 4: Run** the file → PASS.
- [ ] **Step 5: Write the failing dialog tests**:
  - `SettingsDialog.test.tsx`: `renders the Keyboard shortcuts section after Git and focuses it for section="shortcuts"`: the `Keyboard shortcuts` heading exists and the first `Change shortcut for Command palette` button has focus when `section: "shortcuts"`.
  - `ShortcutsDialog.test.tsx`: `Customize… opens Settings at the shortcuts section`: click → `useShell.getState().dialog` equals `{ kind: "settings", section: "shortcuts" }`.
- [ ] **Step 6: Run** the two files → FAIL.
- [ ] **Step 7: Implement**: `"shortcuts"` in `SettingsSection`; `<ShortcutSettings />` between `<GitSettings />` and `<FileSettings />`; the `Customize…` button in `ShortcutsDialog`'s actions row calling `useShell.getState().open({ kind: "settings", section: "shortcuts" })`.
- [ ] **Step 8: Run** `npm run test:coverage && npm run lint && npm run typecheck` → PASS, 100 %; `cargo test --workspace` unaffected.
- [ ] **Step 9: Commit** `git add src/features/settings/ShortcutSettings.tsx src/features/settings/ShortcutSettings.test.tsx src/features/settings/SettingsDialog.tsx src/features/settings/SettingsDialog.module.css src/features/settings/SettingsDialog.test.tsx src/features/settings/ShortcutsDialog.tsx src/features/settings/ShortcutsDialog.test.tsx src/lib/store/shell.ts` → `feat(GR-18): Keyboard shortcuts section with press-to-rebind, conflicts, and reset`

---

## After the tasks

- Whole-branch review (subagent-driven-development), fixes on-branch (owner rule: review minors are fixed, never deferred).
- Owner acceptance walk per spec §8 on COSMIC; results appended to the spec.
- `superpowers:finishing-a-development-branch`; one Jira summary comment on GR-18 at finish.
