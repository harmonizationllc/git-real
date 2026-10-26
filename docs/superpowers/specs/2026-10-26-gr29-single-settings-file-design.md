# GR-29: One settings file — design

**Ticket:** GR-29 "Revisit decisions made during unattended AFK runs", item 1,
widened by the owner on 2026-10-26.
**Reverses:** GR-14 ruling R3 (split store) and, in passing, the pre-GR-14
habit of persisting UI preferences in `localStorage`.
**Status:** reviewed by a builder check; awaiting owner approval.

## 1. Intent

Every setting the user can change lives in **one plain JSON file** that a
person can open, read, back up, and copy to another machine. Nothing the user
configures lives in the browser's `localStorage`. The file is
`settings.json` in the Tauri app config directory (on Linux,
`~/.config/<bundle id>/settings.json`, beside `recent-repos.json`), which
GR-14 already created for the backend-only settings.

The owner's words: "settings living in one file that can be read, backed up,
transferred to a different machine", then "move them too, everything in one
file" for the layout state, and "yes, remember window size and maximized
state too".

### Goals

1. All thirteen values currently persisted by the four zustand `persist`
   stores move into `settings.json` (§3).
2. Window size and maximized state are remembered in the same file and
   restored at the next launch.
3. First paint is correct: theme, fonts and column widths are right before
   React renders. No flash, no loading screen, no layout jump.
4. The Settings dialog shows where the file is and can reveal it.

### Non-goals

- Live reload when the file is edited by hand while the app runs. The
  owner said "next launch is fine". Hand edits apply at the next launch.
- Window **position**. Wayland does not let applications set or read it;
  the compositor places windows. Not stored on any platform (keeps the
  file portable and `git-real-core` platform-neutral).
- Recent repositories (`recent-repos.json`) and hosting credentials stay in
  their own files. They are history and secrets, not preferences.
- A settings import/export UI. Copying the file is the feature.
- Multi-window.
- **Migration of existing data.** Owner decision (2026-10-26): the app has
  not shipped, so neither the four `localStorage` stores nor the GR-14
  version-1 `settings.json` are carried over. Old browser keys are left in
  place, inert and never read. A version-1 file is treated as an unknown
  version (defaults, overwritten on next save). From the first tagged
  release onward the file is a contract and every shape change owes a
  migration.

### Anti-goals

- A settings file that silently rewrites itself every few seconds or on
  every startup. The file is written when the user changes a setting, and
  once at window close for geometry.
- Losing a preference because a path in a copied file does not exist on
  this machine. Missing paths degrade exactly as GR-14 already does for the
  Git executable: inline message in Settings, defaults in effect, file left
  as written.
- Re-introducing a second store "just for one value".

## 2. Constraints (from the project)

- `git-real-core` has no Tauri dependency and no platform assumptions; the
  `Settings` type, normalisation and the file codec stay there.
- No new crates, no new Tauri plugins. `tauri-plugin-opener` is already a
  dependency and is used to reveal the file.
- No direct `tokio`; use `tauri::async_runtime`.
- `src/lib/ipc` is the only place that calls `invoke`.
- Tests first; `git-real-core` tests run with plain `cargo test`.

## 3. The file

Version bumps from 1 to 2. Shape, camelCase, grouped so a person can read
it (grouping is my call; GR-14's five fields were flat):

```json
{
  "version": 2,
  "settings": {
    "git": { "executable": null },
    "clone": { "defaultDir": null, "urlForm": "https" },
    "tools": { "editor": null, "diffTool": null, "mergeTool": null },
    "appearance": { "theme": "system", "diffFontFamily": null, "diffFontSize": 13 },
    "diff": { "mode": "split", "ignoreWhitespace": false },
    "layout": {
      "refsWidth": 240,
      "sidebarWidth": 320,
      "tagsCollapsed": true,
      "pullRequestsCollapsed": false,
      "issuesCollapsed": true
    },
    "updates": { "checkOnStartup": true },
    "window": { "width": 1280, "height": 800, "maximized": false }
  }
}
```

Field sources and rules:

| Section / field                           | Comes from                                                   | Validation / normalisation                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.executable`                          | v1 `gitExecutable`                                           | unchanged: absolute path, verified with `git --version` before store                                                                            |
| `clone.defaultDir`                        | v1 `defaultCloneDir`                                         | unchanged: absolute, existing directory                                                                                                         |
| `clone.urlForm`                           | `layoutPrefs.cloneUrlForm`                                   | `"https" \| "ssh"`                                                                                                                              |
| `tools.*`                                 | v1 `externalEditor`, `externalDiffTool`, `externalMergeTool` | unchanged: trimmed, empty → null                                                                                                                |
| `appearance.theme`                        | `appearancePrefs.theme`                                      | `"system" \| "light" \| "dark"`                                                                                                                 |
| `appearance.diffFontFamily`               | `appearancePrefs.diffFontFamily`                             | trimmed, empty → null                                                                                                                           |
| `appearance.diffFontSize`                 | `appearancePrefs.diffFontSize`                               | integer, clamped 10–24                                                                                                                          |
| `diff.mode`                               | `diffPrefs.mode`                                             | `"split" \| "unified"`                                                                                                                          |
| `diff.ignoreWhitespace`                   | `diffPrefs.ignoreWhitespace`                                 | bool                                                                                                                                            |
| `layout.refsWidth`, `layout.sidebarWidth` | `layoutPrefs`                                                | integer px; clamped to the same bounds the split handles enforce today (builder reads them from `SplitHandle`/`layoutPrefs`), default 240 / 320 |
| `layout.*Collapsed`                       | `layoutPrefs`                                                | bool                                                                                                                                            |
| `updates.checkOnStartup`                  | `updatePrefs.checkOnStartup`                                 | bool                                                                                                                                            |
| `window.width`, `window.height`           | new                                                          | logical px, integers, at least the configured minimum (960 × 600)                                                                               |
| `window.maximized`                        | new                                                          | bool                                                                                                                                            |

**Not moved, my call:** `updatePrefs.lastCheckedAt` (epoch ms of the last
update check). It is bookkeeping, not a preference, and moving it would
rewrite the file daily. It stays in `localStorage` under its existing key,
alone in a renamed store `updateState` so the word "prefs" no longer lies.

**Loading rules** (extend GR-14's R13): a missing, unreadable or corrupt file
logs and yields defaults; any version other than 2 (including GR-14's 1)
yields defaults and is overwritten on the next save; an unknown key inside
the known version
is ignored and dropped on save; a value that fails validation (a relative
path, a size out of range, an unknown enum string) is replaced by its
default **for that field only**, logged, and the rest of the file is kept.
That last rule is what makes a file copied from another machine safe.

**Existence is never checked on load.** "Existing directory" for
`clone.defaultDir` and "verified with `git --version`" for `git.executable`
are checks the **patch** path runs when the user sets the value. On load,
only shape is validated (absolute path, enum, range). A path that does not
exist on this machine is kept in the file as written; the dialog shows the
same inline `role="alert"` text under the clone directory field that GR-14
shows under the Git field (`Directory not found: ‹path›`), and the clone
dialog falls back to the picker's default when the seed directory is
missing. One validator with a `mode: Load | Patch` flag, so the two paths
cannot drift.

**Writing:** unchanged mechanism (serialize, write to a temp file in the
same directory, rename). Pretty-printed with two-space indent so the file
diffs well in a backup. Written when a setting changes, and at window close
**only if the geometry differs** from what the file holds (§5). Never on a
read, never on a plain quit. So a hand-edited `diffFontSize: 99` stays `99`
in the file (clamped to 24 in effect) until the user changes some setting.

## 4. How the front end gets settings before first paint

Rust creates the main window in `setup` (it moves out of
`tauri.conf.json`'s `app.windows`) with `WebviewWindowBuilder`, so it can:

1. apply the stored `window` size and maximized flag before the window is
   shown (§5), and
2. attach an **initialization script** that runs before any page script:
   `window.__GIT_REAL_SETTINGS__ = <settings JSON>;`.

The front end has **one** settings store, `src/lib/store/settings.ts`
(zustand, **not** `persist`), created from `window.__GIT_REAL_SETTINGS__` at
module load. `src/main.tsx` applies appearance from it before `createRoot`,
exactly as `applyAppearance` does today, so the first paint has the right
theme, fonts and widths. If the global is missing (Vitest, a plain browser
tab), the store starts from the TypeScript defaults, which equal the Rust
defaults; a test asserts the two default sets are identical by comparing
the TS defaults to the JSON `git-real-core` produces for `Settings::default()`.

**Reload reconciliation.** The initialization script's text is fixed when
Rust builds the window, so after a webview reload (Ctrl+R, a Vite full
reload in dev) the global holds launch-time values. Right after hydrating,
the store calls `get_settings` once and replaces its state with the reply.
In production there is no reload and the reply equals the global; in dev a
reload may show launch-time values for one round trip. `get_settings`
therefore stays a real command, not tests-only.

The four `persist` stores (`appearancePrefs`, `diffPrefs`, `layoutPrefs`,
`updatePrefs`) are deleted. Their 16 consumer modules read the same field
names from `useSettings` selectors; the setter names are kept so call sites
change only their import. `features/settings/useSettings.ts` (the
react-query hook over `get_settings`) is replaced by the store: the store
is the source of truth; `get_settings` is called once for reload
reconciliation (above) and otherwise unused by the UI.

### Two write tiers

- **Validated fields** (`git.executable`, `clone.defaultDir`, `tools.*`):
  behaviour is exactly GR-14's. The dialog awaits `update_settings`, shows
  inline errors, reverts on failure. Nothing changes for the user.
- **Plain preferences** (everything else): the store updates **locally
  first** so a column drag or a theme click is instant, then sends the
  patch. Patches for the same section within 300 ms are coalesced (a drag
  produces many `setRefsWidth` calls). On rejection the store reverts that
  section to the server's returned value and shows one error toast
  `Couldn't save settings: ‹message›`. A failed write never blocks the UI.

`update_settings` returns the full normalised `Settings`; the store replaces
its state with the reply (so clamping done in Rust shows in the UI).

**Flush on close.** A coalesced patch can still be pending when the user
quits right after a drag. The store flushes pending patches on the
document's `pagehide` event (and `beforeunload` as a belt). Rust's
`SettingsStore` serialises every save behind its mutex and each save writes
the whole state, so the flush and the geometry save (§5) may land in either
order and the file ends up with both.

### Patch shape

`SettingsPatch` is nested like the file: every section optional, every
leaf a double option (absent = keep, `null` = clear where nullable, value =
set), using GR-14's hand-written `double_option` deserializer. The TS type
is `DeepPartial<Settings>` with `null` allowed on nullable leaves.

### Configured Git executable that does not exist here

Owner decision (2026-10-26): **fall back to PATH.** `git_cli::locate()`
returns the configured path when it is a regular file; when it is set but
missing, it logs once and searches `PATH` exactly as if nothing were
configured. The stored path is left in the file. `check_git_cli` reports the
effective executable (the PATH one) plus `error` =
`Configured Git executable not found: ‹path›; using ‹effective path›`, and
the Settings dialog shows that text under the Git field as a notice, not a
blocker. If PATH has no Git either, behaviour is today's `GitCliMissing`.
This replaces GR-14's `GitError::GitCliConfiguredMissing` hard failure; the
variant is removed and its tests inverted.

## 5. Window geometry

- **Restore:** in `setup`, after `SettingsStore::load`, build the window
  with `.inner_size(width, height)` (logical) and `.maximized(maximized)`.
  Size is clamped to the configured minimum before use so a hand-edited
  `1x1` cannot produce an unusable window. The configured defaults
  (1280 × 800, min 960 × 600) move from `tauri.conf.json` into one Rust
  constant block next to the builder.
- **Save:** on `WindowEvent::CloseRequested`, read `is_maximized()`; if not
  maximized, read `inner_size()` and convert to logical with the scale
  factor; **if the result differs from the stored `window` section**, write
  it and save; otherwise do nothing. Saving only at close is my call: it is
  at most one write per session and "remembered at next launch" is the ask.
  A crash loses the last resize, which is acceptable. No resize-debounce
  timer.
- **Not stored:** position (non-goal), monitor, fullscreen.
- Linux/Wayland is the target: `inner_size` and `maximized` are honoured by
  WebKitGTK under Wayland; COSMIC tiling may override size, which is fine
  (we save whatever the compositor gave us).

## 6. No data migration

See the non-goal. The four `persist` stores are deleted outright; nothing
reads their `localStorage` keys. `lastCheckedAt` starts over under its new
`updateState` key. No `SettingsFileV1` struct, no import module.

## 7. Settings dialog

- New section **File** at the bottom: the path of `settings.json`
  (read-only, selectable) and a `Show in folder` button that calls
  `tauri-plugin-opener`'s reveal through a new IPC wrapper
  `revealSettingsFile()` → command `reveal_settings_file` (the reveal
  happens in Rust; the UI reads the path for display only, through a
  read-only `settings_file_path` command). Below the path, one line of copy:
  `Edits made outside the app apply the next time it starts.`
- The **Appearance** section is unchanged visually; its controls now write
  through the settings store.
- Diff mode, whitespace, collapsed sections, column widths and clone URL
  form keep their existing controls where they are (diff toolbar, panel
  headers, split handles, clone dialog). They are not duplicated into the
  dialog.
- Updates: `checkOnStartup` keeps its existing control (wherever GR-15 put
  it); it writes through the store.

## 8. Rust surface

`git-real-core/src/settings.rs`: `Settings` becomes the nested struct of §3
with `Default`; `SettingsPatch` nested double-options; `Settings::apply`
normalises and validates per field (§3 table); `SettingsFile` codec
(`version: 2`, anything else → defaults); per-field fallback-to-default on
invalid values with a returned list of
`(field, message)` warnings for the app to log; `WindowGeometry` type with
`clamp_to_min`.

`src-tauri/src/settings_store.rs`: `load` (logs warnings), `get`,
`update(patch)` (unchanged flow: apply → verify Git executable if it
changed → save → push override), new `set_window(geometry)` used by the
close handler, `path()` for the reveal command, `to_init_script()` producing
the one-line script.

Commands: `get_settings`, `update_settings` (wire shape changes to nested),
new `reveal_settings_file`, `settings_file_path`, `check_settings_health`
(reports whether the stored clone directory is missing on this machine, so
the dialog can show its alert). All through `run_blocking`.

`lib.rs`: window built in `setup`; `on_window_event` for `CloseRequested`.
`tauri.conf.json`: `app.windows` becomes `[]`; `title` and `minWidth`/
`minHeight` live in the Rust constants.

## 9. Tests

- **core:** `locate()` falls back to PATH when the configured path is
  missing (and still fails when PATH has no Git); a version-1 file loads
  as defaults; per-field fallback (bad theme string → default theme, rest intact; width
  below min → min); load keeps a non-existent `clone.defaultDir` and
  `git.executable` while patch rejects them; patch semantics per section;
  defaults JSON snapshot that the TS test compares against;
  `WindowGeometry::clamp_to_min`.
- **app:** `SettingsStore::set_window` writes the file; `to_init_script`
  escapes `</script>` and non-ASCII safely (JSON string inside a JS
  assignment: `JSON.stringify` on the Rust side via `serde_json`, then no
  further escaping is needed except `<` → `\u003c`).
- **front end:** store hydrates from the global, then reconciles from
  `get_settings`; defaults equal Rust's; optimistic update + coalescing +
  revert on rejection; pending patch flushed on `pagehide`;
  `applyAppearance` still applies before render;
  each migrated consumer keeps its behaviour (existing tests, import path
  changed).
- **gate:** CLAUDE.md's full suite plus clippy; coverage stays at the
  project's current 100 % front-end figure.

## 10. Acceptance walk (owner, real desktop, COSMIC)

1. Launch this build with the GR-14 `settings.json` still in place: the
   app starts on defaults. Set dark theme, unified diff, drag the refs
   column wider, collapse Tags, set the Git path. Quit, launch: all five
   are as left and `~/.config/…/settings.json` is version 2 and holds them.
2. Resize the window, quit, launch: same size. Maximize, quit, launch:
   maximized. Un-maximize: returns to the saved un-maximized size.
3. Quit. Edit the file by hand: theme to `light`, `refsWidth` to `300`,
   `diffFontSize` to `99`. Launch: light theme, 300 px column, font size
   24 (clamped), and a log line about the clamp. The file is not rewritten
   until the next change.
4. Copy the file to a machine (or a second user) without the configured
   Git executable path. Launch: fetch and status work on PATH Git, Settings
   shows `Configured Git executable not found: … ; using /usr/bin/git`
   under the Git field, file unchanged.
5. Settings → File → Show in folder opens the directory.
6. Cold start in dark mode shows no light flash (closes GR-19 step 2 for
   this design).

## 11. Left to the builder

- Exact clamp bounds for the two column widths (read from the current
  split-handle code).
- Where `checkOnStartup`'s control lives today and how it imports the store.
- Whether `useSettings` selectors are one hook with selector functions or
  a few named hooks; keep call-site diffs small.
- The coalescing implementation (a per-section timer in the store is
  enough; no library).
- Test fixture for the init script in Vitest (set the global in a setup
  file or per test).

## 12. Owner decisions recorded

- One file for everything the user configures (2026-10-26).
- Layout state (widths, collapsed sections, clone URL form) counts as
  settings (2026-10-26).
- Window size and maximized state are remembered; position is not
  (2026-10-26, after being told Wayland forbids position).
- Hand edits apply at next launch, no live reload (2026-10-26).
- A configured Git executable missing on this machine falls back to PATH
  with a notice (2026-10-26).
- No migration of browser stores or the version-1 file; the app has not
  shipped (2026-10-26).

## 13. My calls (flagged for the owner's skim)

- Grouped file layout (§3) rather than flat.
- `lastCheckedAt` stays in the browser.
- Geometry saved at window close only, and only when it changed.
- Existence of paths is checked when set, never when loaded; the store
  reconciles from `get_settings` after a reload; pending patches flush on
  `pagehide`.
- Per-field fallback-to-default on invalid values instead of
  whole-file-to-defaults.
- Optimistic local update for plain preferences; validated fields keep
  GR-14's await-then-apply.
- The window definition moves from `tauri.conf.json` into Rust.
- A `File` section with `Show in folder` in the Settings dialog.
