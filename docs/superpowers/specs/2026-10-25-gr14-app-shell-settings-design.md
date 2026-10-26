# GR-14 — Application shell, settings, and keyboard shortcuts

- Jira: GR-14 "Application shell, settings, and keyboard shortcuts". One spec,
  one branch (`feature/gr-14-app-shell-settings`), no slices.
- Depends on: GR-3 (`git_cli`, `CloneDialog`, `RecentStore`, `pickFolder`),
  GR-5/GR-9 (`DetailPane`, `FileHeader`, the diff CSS modules), GR-10b
  (`ConflictEditor`), GR-12 (`useSyncActions`, `SyncToolbar`, the
  Ctrl+Shift+F/L/P shortcuts), GR-13 (`HostingStore` persistence pattern,
  `Toasts`, `useRestoreFocus`, the composing-Escape rule).
- Follows: ADR 0001/0002 (`features/settings/` was reserved for this story;
  CSS custom-property tokens for light/dark), the CLAUDE.md hybrid git rule
  (external tools are processes, so they go through the CLI side), the IPC
  seam rule, the `spawn_blocking` rule, no direct `tokio`, and the 100 %
  coverage gate.
- Date: 2026-10-25. Written unattended by the ticket orchestrator. Every
  decision in §2 is a ruling in the AFK format; person-grade ones are also
  Jira comments on GR-14.

## 1. Goal

Git Real becomes comfortable for all-day use: the window follows the
system's light or dark theme (or the user's override), the things people
configure once live in one Settings dialog (clone directory, diff font,
external editor and diff/merge tools, the Git executable), every common
action has a keyboard shortcut listed in a reference dialog, a command
palette reaches any action or open/recent repository from the keyboard, and
long-running operations announce their completion (and failures without an
inline home) as toasts.

### What already exists (not rebuilt here)

The survey of `main` at d2a2116 found:

- **Layout (AC 1):** `RepoPane` already renders a 5-column grid
  `refs | handle | centre | handle | sidebar`. The refs column holds
  Branches (with per-remote groups), Stashes, Tags, Pull requests and Issues;
  the centre holds the graph, replaced by `DetailPane` (diff / blame /
  conflict editor) when a file is selected; the sidebar holds Changes +
  commit box, or the selected commit / stash summary. Both boundaries are
  draggable `SplitHandle`s (keyboard-steppable, double-click reset) with
  widths persisted in `layoutPrefs`. Remotes are managed in `RemotesDialog`
  and shown as groups in the Branches panel.
- **Tokens:** `src/styles/tokens.css` defines 38 custom properties with a
  dark set under `@media (prefers-color-scheme: dark)`.
- **Toasts:** `src/lib/store/toasts.ts` + `src/components/Toasts.tsx`
  (polite live region, 8 s timeout paused on hover/focus, optional action).
- **Recents and tabs:** `RecentStore` (Rust) + `useRecentRepos`, `repoTabs`
  store with `openTab` / `activate`, `useOpenRepo`.
- **Fuzzy matching:** `src/features/history/model/fuzzy.ts`.

### Goals (the ticket's acceptance criteria, mapped)

| AC                                                                                                                           | Delivered by                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1 Layout with sidebar, graph, detail/diff panel; resizable                                                                   | Existing (above). GR-14 adds nothing structural; see ruling R1.        |
| 2 Light and dark themes following the system, with manual override                                                           | §3 theme preference, `data-theme`, token restructure.                  |
| 3 Settings page: default clone directory, diff font and size, external editor, external diff/merge tool, Git executable path | §4 Settings dialog, §5 settings store and commands, §6 external tools. |
| 4 Keyboard shortcuts for common actions with a reference dialog                                                              | §7 shortcut registry and `ShortcutsDialog`.                            |
| 5 Command palette for quick actions and repository switching                                                                 | §8 `CommandPalette`.                                                   |
| 6 Toast notifications for long-running operation completion and errors                                                       | §9 toast variants and the operations that raise them.                  |

### Non-goals (follow-ups, each becomes a Jira ticket at the end)

- Rebinding shortcuts (a configurable shortcut system). Shortcuts are fixed
  in this story (R6).
- A vertical graph/detail split; whole-column collapse buttons; the refs
  column's internal split (GR-17).
- A native application menu bar or window-state persistence.
- Windows-specific handling of external tool commands (Linux is first-class;
  macOS gets `Cmd` for shortcuts as today).
- Per-repository settings; syncing settings between machines; import/export.
- Focus trapping inside dialogs (the GR-3 follow-up stands).

## 2. Decisions (rulings)

Shape: question / options / selected / cost if wrong. **P** = person-grade
(also a Jira comment), **R** = routine (ledger only).

- **R1 (P)** Layout: does AC 1 need new structure? A) keep the existing
  three resizable columns and the centre graph-or-detail swap; B) add a
  stacked, resizable detail panel under the graph; C) move Remotes out of
  the dialog into a refs-column panel. **Selected A.** The existing layout
  satisfies the AC's nouns (sidebar with branches, remote groups, stashes,
  tags; graph; detail/diff pane; two resizable boundaries); B reverses a
  GR-5/GR-9 decision and shrinks the graph on every file click; C duplicates
  `RemotesDialog` and worsens the GR-17 column problem. Cost if wrong: a
  follow-up adds the stacked panel behind a layout preference.
- **R2 (P)** Settings UI shape: A) modal `SettingsDialog`; B) a routed
  full-window page. **Selected A.** There is no router; every other
  configuration surface is a dialog; a dialog keeps the repository visible
  behind theme and font changes. Cost if wrong: the dialog body is a plain
  component and can be hosted in a page later.
- **R3 (P)** Where settings persist: A) all in `localStorage` (zustand
  persist); B) all in a Rust `settings.json`; C) split: appearance (theme,
  diff font) in `localStorage`, everything the backend needs (clone
  directory, Git executable, external tools) in `settings.json` next to
  `recent-repos.json`. **Selected C.** The theme must apply before React
  paints (synchronous `localStorage` read, no flash); the Git executable and
  tool commands must be known to Rust without a round trip from the UI.
  Cost if wrong: two small stores to merge later; both are versioned.
- **R4 (P)** Settings save model: A) autosave per field (radios/pickers on
  change, text fields on blur or Enter), with inline validation; B)
  Save/Cancel buttons. **Selected A.** Appearance previews live, and a
  Save button that half-applies (theme live, Git path deferred) is confusing.
  Cost if wrong: wrapping the form in a draft state is local to the dialog.
- **R5 (P)** Git executable override plumbing: A) a process-wide configured
  path in `git_cli` (`set_configured_path`, read first by `locate()`),
  set by the app at startup and on every settings change; B) thread a
  `GitLocator` through `RepoSession` and the 11 `locate()` call sites.
  **Selected A.** B is a large refactor for one optional value; A keeps the
  single `Command::new` site and is validated before it is stored. The
  architect approved A on 2026-10-25 with the test-isolation rule in §5.3.
  Cost if wrong: the static is one function behind an accessor and can be
  replaced by injection later.
- **R6 (P)** Shortcut scope: fixed bindings in a single registry, no
  rebinding UI (the GR-12 spec deferred "a configurable shortcut system" to
  GR-14, but the AC asks only for shortcuts plus a reference dialog).
  **Selected: fixed.** Cost if wrong: the registry is data; a rebinding
  layer maps ids to keys later. Follow-up ticket.
- **R7 (P)** Toast coverage: A) completion toasts for fetch, pull, push and
  clone, plus error toasts only for failures that have no inline surface
  (external tool launches, settings persistence); existing inline errors
  (`SyncMessage`/`NetworkError`, `RepoError`, panel errors) stay where they
  are; B) also mirror every inline error as a toast. **Selected A.** B
  duplicates every failure and loses the inline actions (retry,
  credentials). Cost if wrong: adding a toast to a failure path is one line.
- **R8 (P)** External diff and merge tools run through `git difftool` /
  `git mergetool` with the user's command as `difftool.gitreal.cmd` /
  `mergetool.gitreal.cmd`, so Git handles temp files, `$LOCAL`/`$REMOTE`/
  `$BASE`/`$MERGED` and conflict bookkeeping. The editor command is split
  with a quote-aware splitter and spawned directly with the path appended.
  Alternative B) write temp files ourselves and run the commands through
  `sh -c`. **Selected A.** Cost if wrong: both are isolated in
  `git-real-core::tools`.
- **R9 (P)** Palette binding is **Ctrl+K** (Ctrl+Shift+P is already push);
  shortcut reference is **Ctrl+/**; settings is **Ctrl+,**. Alternatives:
  F1 for the palette, `?` for the reference. Cost if wrong: one registry row.
- **R10 (R)** Theme preference values are `"system" | "light" | "dark"`;
  the attribute is `data-theme` on `<html>`, absent for `system`.
- **R11 (R)** Diff font tokens are `--font-mono` and `--diff-font-size`;
  only the diff, blame and conflict-editor modules consume them (commit
  hashes and other chips keep their local monospace).
- **R12 (R)** The fuzzy matcher moves to `src/lib/fuzzy/` and
  `features/history` imports it from there (no behaviour change).
- **R13 (R)** `settings.json` is versioned (`version: 1`; `recent-repos.json`
  has no version, so this is new behaviour) and loaded tolerantly exactly as
  `RecentStore::load` does: a missing, unreadable or corrupt file logs with
  `eprintln!` and yields defaults; an unknown version yields defaults and is
  overwritten on the next save. Saves use `RecentStore`'s tmp-write-then-
  rename and log failures.
- **R16 (R)** Hooks without JSX are `.ts` (`useSettings.ts`, `useCommands.ts`).
- **R17 (R)** `AppErrorKind` is a unit enum: the new kinds are unit
  variants (`InvalidSettings`, `GitCliInvalid`, `NoExternalTool`,
  `ExternalToolFailed`); detail travels in `AppError.message`, and the UI
  knows which tool it asked for from the wrapper it called. Each new kind is
  added in both TS places: the union in `src/lib/ipc/types.ts` and the
  `KINDS` record in `src/lib/ipc/errors.ts`.
- **R14 (R)** Dialog-open suppression stays the existing DOM rule: global
  shortcuts do nothing while a `[role="dialog"]` is mounted, except that the
  palette, settings and shortcut dialogs each close on their own Escape.
  The three shell dialogs are mutually exclusive (opening one closes the
  others).
- **R15 (R)** New Tauri capability: none for the editor (Rust spawns it),
  `dialog:allow-open` already covers the folder and file pickers. No new
  plugins, no new crates.

## 3. Theme (AC 2)

### 3.1 Preference

`src/lib/store/appearancePrefs.ts` — zustand `persist`, key
`git-real.appearancePrefs`, `version: 1`:

```ts
interface AppearancePrefs {
  theme: "system" | "light" | "dark"; // default "system"
  diffFontFamily: string | null; // null = the default stack
  diffFontSize: number; // px, integer 10–24, default 13
  setTheme(theme): void;
  setDiffFontFamily(family: string | null): void; // trimmed; "" → null
  setDiffFontSize(size: number): void; // clamped to 10–24, rounded
}
```

### 3.2 Applying it

`src/app/applyAppearance.ts` exports `applyAppearance(prefs)`:

- `theme === "system"` → remove `data-theme` from `document.documentElement`;
  otherwise set `data-theme="light" | "dark"`.
- `document.documentElement.style.setProperty("--font-mono", family ?? DEFAULT_MONO)`
  and `("--diff-font-size", `${size}px`)`, where `DEFAULT_MONO` is the stack
  the diff modules use today (`ui-monospace, SFMono-Regular, Menlo, monospace`).

`src/main.tsx` calls `applyAppearance(useAppearancePrefs.getState())`
before `createRoot(...).render(...)` (zustand's `localStorage` hydration is
synchronous) and subscribes to the store so later changes re-apply. No
React hook is needed for the apply step; a `useAppearancePrefs` selector is
what the Settings dialog uses.

### 3.3 Tokens

`src/styles/tokens.css` is restructured so the dark set applies in two
cases and the light set is forced back for the override:

```css
:root {
  /* light values */
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    /* dark values */
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  /* dark values */
  color-scheme: dark;
}
```

A rule inside a media query cannot share a selector list with one outside
it, so the dark declarations are duplicated verbatim (two blocks, same 38
values). A unit test parses `tokens.css` and asserts the two dark blocks
declare the same property/value pairs, so they cannot drift. `color-scheme`
makes native form controls and scrollbars follow. The CodeMirror themes
(`EditorPane.tsx` `paneTheme`, `blocks.ts` `baseTheme`) already read
`var(--color-*)`, so they follow the override; `paneTheme`'s hard-coded
`fontFamily`/`fontSize` switch to `var(--font-mono)` / `var(--diff-font-size)`
(the `blocks.ts` bar font stays Inter on purpose).

### 3.4 Tests

- `appearancePrefs.test.ts`: defaults, persistence key, clamping and
  rounding of the size, `""` family → `null`, version.
- `applyAppearance.test.ts`: each theme value sets or removes the
  attribute; font properties are set; default stack when family is `null`.
- `tokens.test.ts`: the two dark blocks match; every light token has a dark
  counterpart.

## 4. Settings dialog (AC 3)

### 4.1 Opening it

- `TabBar` gains two right-aligned icon buttons after its `Start screen`
  button: `Commands` (accessible name `Command palette`, title
  `Command palette (Ctrl+K)`) and `Settings` (accessible name `Settings`,
  title `Settings (Ctrl+,)`). They call the shell store's `open` directly
  (no new `TabBar` props).
- Shortcut `Ctrl+,` and the palette action `Open settings` open it.
- State lives in `src/lib/store/shell.ts`:

```ts
type ShellDialog =
  | null
  | { kind: "settings"; section?: SettingsSection }
  | { kind: "palette" }
  | { kind: "shortcuts" };
interface ShellState {
  dialog: ShellDialog;
  open(d: Exclude<ShellDialog, null>): void;
  close(): void;
}
```

`App.tsx` renders `SettingsDialog`, `CommandPalette` and `ShortcutsDialog`
next to `CloneDialog` and `Toasts`, each mounted only while `dialog.kind`
matches. Focus returns to the opener through `useRestoreFocus` with the
tab-bar button as `fallbackFocus`.

### 4.2 Layout and copy (verbatim; ‹…› are values)

`src/features/settings/SettingsDialog.tsx`, `role="dialog" aria-modal="true"`,
`aria-labelledby` → `<h2>Settings</h2>`, a `Close` button, Escape closes
(composing-Escape ignored). Sections are `<section aria-labelledby>` with
`<h3>` headings, in this order. `section` from the shell store scrolls that
section into view and focuses its first control.

**Appearance**

- `Theme` — radiogroup, radios `System`, `Light`, `Dark`. Applies on change.

**Diff**

- `Font family` — text input, placeholder `System monospace`; empty clears
  to the default. Applies on blur or Enter.
- `Font size` — number input, `min=10 max=24 step=1`, suffix text `px`.
  Applies on change; out-of-range values are clamped and the input shows the
  clamped value.
- Below both: a two-line sample `<pre aria-label="Diff font sample">` using
  the tokens, lines `- const total = a + b;` and `+ const total = add(a, b);`.

**Clone**

- `Default clone directory` — read-only value (`Not set` when null) with
  buttons `Choose folder…` (`pickFolder("Choose default clone directory", current)`)
  and `Clear` (disabled when null).

**Tools** (each a text input; applies on blur or Enter; empty → unset)

- `External editor` — hint `Command line; the file or folder path is appended, e.g. code --wait`
- `External diff tool` — hint `Git difftool command, e.g. meld "$LOCAL" "$REMOTE"`
- `External merge tool` — hint `Git mergetool command, e.g. meld "$LOCAL" "$BASE" "$REMOTE" --output "$MERGED"`

**Git**

- `Git executable` — text input, placeholder `Found on PATH` with the
  discovered path shown underneath as `Using ‹path› (git version ‹x.y.z›)`
  when unset, or `Using ‹path› (git version ‹x.y.z›)` for a valid override;
  button `Browse…` (`pickFile("Choose Git executable")`, new wrapper in
  `src/lib/ipc/dialog.ts` around `open({ directory: false, multiple: false })`);
  button `Use PATH` (clears the override; disabled when unset).
- Validation on commit: an invalid value shows
  `Not a Git executable: ‹message›` in a `role="alert"` under the field and
  the stored value is unchanged (the field keeps the typed text until the
  user corrects or blurs away, then reverts).

**Status line** (one per dialog, `role="status"`, bottom): `Saved` for one
second after any backend setting persists; a failed save shows an error
toast `Couldn't save settings: ‹message›` (R7) and the field reverts to the
stored value.

### 4.3 Hook

`src/features/settings/useSettings.ts`: TanStack query
`queryKeys.settings = ["settings"]` → `getSettings()`, and a mutation
`update(patch: SettingsPatch)` → `updateSettings(patch)` that writes the
returned `Settings` into the cache and, when the patch touched
`gitExecutable`, invalidates `queryKeys.gitCli` so the `Using …` line and
`CloneDialog` refresh (optimistic updates are not needed; the dialog shows
the typed value until the mutation settles). The clone dialog and the
external-tool entry points read the same query.

## 5. Settings store and commands (Rust + IPC)

### 5.1 Core type (`git-real-core/src/settings.rs`)

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub default_clone_dir: Option<PathBuf>,
    pub git_executable: Option<PathBuf>,
    pub external_editor: Option<String>,
    pub external_diff_tool: Option<String>,
    pub external_merge_tool: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {  // every field Option<Option<T>>: absent = keep, null = clear
    pub default_clone_dir: Option<Option<PathBuf>>, …
}

impl Settings { pub fn apply(&self, patch: &SettingsPatch) -> Settings; }
```

Normalisation in `apply`: strings are trimmed, empty → `None`; paths must be
absolute (`SettingsError::RelativePath(field)`) and `default_clone_dir` must
be an existing directory (`SettingsError::NotADirectory`). `SettingsError`
maps to `AppErrorKind::InvalidSettings`. The file shape is
`SettingsFile { version: u32, settings: Settings }` with `version = 1`.
No double-option helper exists in the workspace and no crate may be added,
so `settings.rs` hand-writes `fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>`
(`Option::<T>::deserialize(d).map(Some)`) and each patch field carries
`#[serde(default, deserialize_with = "double_option")]`: absent key = keep,
`null` = clear, value = set.

### 5.2 App store (`src-tauri/src/settings_store.rs`)

`SettingsStore { path: PathBuf, inner: Mutex<Settings> }`, `load(path)`
(missing/corrupt/unknown version → defaults, logged, mirroring
`RecentStore::load`), `get() -> Settings`,
`update(patch) -> Result<Settings, AppError>` (apply → `git_cli::verify` the
Git executable if it changed → save with tmp-write-then-rename → push the
Git override into `git_cli`). Managed in `lib.rs` `setup` from
`app_config_dir().join("settings.json")`, and at startup
`git_cli::set_configured_path(settings.git_executable)`.

### 5.3 Git executable override (`git_cli.rs`)

- `static CONFIGURED: RwLock<Option<PathBuf>>` (std, no new crate) with
  `set_configured_path(Option<PathBuf>)` and `configured_path()`.
- `locate()` returns the configured path when set and it is a regular file,
  else `GitError::GitCliMissing` with a message that names the configured
  path (`Configured Git executable not found: ‹path›`); when unset it
  searches `PATH` as today.
- `verify(path: &Path) -> Result<GitVersion, GitError>` runs
  `command(path).arg("--version")`, requires exit 0 and stdout starting
  with `git version `, and returns the trimmed version string. Errors:
  `GitCliMissing` (spawn failed) or `GitError::GitCliInvalid { message }`
  (new variant: non-zero exit or unexpected output), with a `From` arm to
  the unit `AppErrorKind::GitCliInvalid`.
- `check_git_cli_inner` (`src-tauri/src/commands/repo.rs`) reports the
  effective executable: `locate()` (override or PATH) then `verify()`, so
  `GitCliInfo` gains `version: Option<String>` in Rust and TS.
- Tests: the static is shared by every test thread in the binary, so a
  `static TEST_LOCK: Mutex<()>` serialises the tests that touch it **and**
  each of them restores `None` through a panic-safe drop guard (a struct
  whose `Drop` calls `set_configured_path(None)`), never by a trailing
  statement. Fixtures are a fake executable script in a temp dir
  (`#!/bin/sh\necho git version 9.9.9`) plus a non-git script.

### 5.4 Commands (all through `run_blocking`; JS args camelCase)

| Command                    | Args                                     | Returns                                                                                                                             |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `get_settings`             | –                                        | `Settings`                                                                                                                          |
| `update_settings`          | `patch: SettingsPatch`                   | `Settings` (errors: `InvalidSettings { message }` for normalisation failures, `GitCliInvalid`, `GitCliMissing`, `Io`)               |
| `check_git_cli` (existing) | –                                        | `GitCliInfo { available, path, version: Option<String> }` — now reports the effective executable (override or PATH) and its version |
| `open_in_editor`           | `path: String`                           | `()`; errors `NoExternalTool { tool: "editor" }`, `ExternalToolFailed { message }`                                                  |
| `open_external_diff`       | `repoId, path, scope: ExternalDiffScope` | `()`; errors `NoExternalTool { tool: "diff" }`, `ExternalToolFailed`                                                                |
| `open_external_merge`      | `repoId, path`                           | `()`; errors `NoExternalTool { tool: "merge" }`, `ExternalToolFailed`                                                               |

`ExternalDiffScope` (tagged `kind`): `{ kind: "unstaged" }` (index vs
worktree), `{ kind: "staged" }` (`--cached`), `{ kind: "commit", oid }`
(parent vs commit; a root commit diffs against the empty tree
`4b825dc642cb6eb9a060e54bf8d69288fbee4904`).

IPC wrappers in `src/lib/ipc/settings.ts` (`getSettings`, `updateSettings`)
and `src/lib/ipc/tools.ts` (`openInEditor`, `openExternalDiff`,
`openExternalMerge`), re-exported from `src/lib/ipc/index.ts`
(`export * from "./settings"`, `"./tools"`); new `AppErrorKind` strings in
`types.ts` and `errors.ts` (R17). `queryKeys.settings = ["settings"]` is
added to `src/lib/query/keys.ts` beside `recent` and `gitCli`.

### 5.5 Wire shapes

```ts
interface Settings {
  defaultCloneDir: string | null;
  gitExecutable: string | null;
  externalEditor: string | null;
  externalDiffTool: string | null;
  externalMergeTool: string | null;
}
type SettingsPatch = Partial<Settings>; // present key with null clears
interface GitCliInfo {
  available: boolean;
  path: string | null;
  version: string | null;
}
```

## 6. External tools (`git-real-core/src/tools.rs`)

- `split_command(cmd: &str) -> Result<Vec<String>, ToolError>`: whitespace
  split honouring single and double quotes and backslash escapes outside
  single quotes; empty result → `ToolError::EmptyCommand`; unterminated
  quote → `ToolError::UnterminatedQuote`.
- `open_in_editor(cmd, path)`: `Command::new(argv[0]).args(argv[1..]).arg(path)`,
  stdin/stdout/stderr null, `.spawn()`; the child is not waited on (detached).
  A spawn error maps to `ExternalToolFailed { message: "Couldn't start ‹argv0›: ‹io error›" }`.
- `open_external_diff(git, repo_path, cmd, path, scope)`: runs
  `git -c difftool.gitreal.cmd=‹cmd› -c difftool.prompt=false difftool --tool=gitreal [--cached | ‹parent› ‹oid›] -- ‹path›`
  and waits; non-zero exit → `ExternalToolFailed` with the last stderr line
  (Git prints `fatal:` lines for a missing tool binary).
- `open_external_merge(git, repo_path, cmd, path)`: runs
  `git -c mergetool.gitreal.cmd=‹cmd› -c mergetool.gitreal.trustExitCode=true -c mergetool.prompt=false -c mergetool.keepBackup=false mergetool --tool=gitreal -- ‹path›`
  and waits; non-zero exit → `ExternalToolFailed`. The working-tree watcher
  already emits `repo-changed`, so the Changes panel and the conflict editor
  refresh when the tool writes the file.
- Both Git invocations set `.current_dir(repo_path)` (`git_cli::command`
  strips `GIT_DIR`/`GIT_WORK_TREE`, so the cwd is how Git finds the
  repository) and inherit `DISPLAY`/`WAYLAND_DISPLAY` (never stripped), so GUI
  tools launch. `prompt=false` plus `GIT_TERMINAL_PROMPT=0` means no TTY.
- The command handlers read the repository path under the session lock,
  **drop the lock**, and only then spawn: a merge tool can stay open for
  minutes and must not block every other command on that repository.
- `ToolError` (splitter errors, spawn failures, non-zero exits) maps to
  `AppErrorKind::ExternalToolFailed`; an unset tool is `NoExternalTool`.
- All three run inside `run_blocking`; the command returns when the tool
  exits (diff/merge) or has been spawned (editor).

### 6.1 Entry points in the UI

- `FileHeader` (diff view) gains props `scope: DiffScope` and
  `isStash: boolean` (from `file.source === "stash"`), passed by
  `DetailPane`'s `header()`, and two buttons after the view switcher:
  `Open in editor` (worktree and index scopes only, i.e. a string scope;
  hidden for commit and stash files) and `External diff` (worktree, index
  and commit scopes; hidden for stash files). Clicking with the tool unset
  opens Settings at the Tools section (via the shell store) instead of
  calling the backend. A backend failure shows an error toast
  `Couldn't open ‹tool›: ‹message›` with action `Settings…`.
- `ConflictToolbar` (not `ConflictEditor` itself) gains an optional
  `onOpenMergeTool` and a `mergeToolRunning` flag rendering `Open in merge
tool`, disabled and reading `Merge tool open…` while the tool runs; the
  same button is offered on the placeholder toolbar for binary or too-large
  conflicts, which are the main reason to reach for an external tool.
  Unset and failure behave as above.
- The palette has `Open repository in editor` (calls `open_in_editor` with
  the repository path).

## 7. Keyboard shortcuts (AC 4)

### 7.1 Registry (`src/lib/shortcuts/`)

```ts
interface Shortcut {
  id: ShortcutId;
  keys: string;
  label: string;
  group: "Application" | "Repository" | "Commit" | "Navigation";
  when: "always" | "repo" | "editor";
}
export const SHORTCUTS: readonly Shortcut[];
export function matchesShortcut(e: KeyboardEvent | React.KeyboardEvent, id: ShortcutId): boolean;
export function formatKeys(keys: string): string; // "Mod+Shift+F" → "Ctrl+Shift+F" (or "⌘⇧F" on macOS by navigator.platform)
```

`keys` uses `Mod` for Ctrl/Cmd. `matchesShortcut` compares `e.key`
case-insensitively (and `e.code` for letters, as `isLinkChord` does) and
requires exactly the listed modifiers; it ignores `e.repeat`,
`e.defaultPrevented`, and composing events.

| id            | keys         | label                   | group       | when   |
| ------------- | ------------ | ----------------------- | ----------- | ------ |
| `palette`     | Mod+K        | Command palette         | Application | always |
| `shortcuts`   | Mod+/        | Keyboard shortcuts      | Application | always |
| `settings`    | Mod+,        | Settings                | Application | always |
| `openRepo`    | Mod+O        | Open repository…        | Application | always |
| `cloneRepo`   | Mod+Shift+O  | Clone repository…       | Application | always |
| `closeTab`    | Mod+W        | Close repository tab    | Navigation  | repo   |
| `nextTab`     | Mod+PageDown | Next repository tab     | Navigation  | repo   |
| `prevTab`     | Mod+PageUp   | Previous repository tab | Navigation  | repo   |
| `fetch`       | Mod+Shift+F  | Fetch                   | Repository  | repo   |
| `pull`        | Mod+Shift+L  | Pull                    | Repository  | repo   |
| `push`        | Mod+Shift+P  | Push                    | Repository  | repo   |
| `fileHistory` | Mod+Shift+H  | File history…           | Repository  | repo   |
| `commit`      | Mod+Enter    | Commit                  | Commit      | editor |
| `linkIssue`   | Mod+Shift+I  | Link issue…             | Commit      | editor |

The reference dialog also lists two static rows under **Navigation**:
`Escape` — `Close dialog or menu`, and `Arrow keys` — `Move within lists and menus`.

### 7.2 Wiring

- `src/app/useGlobalShortcuts.ts`: one `window` keydown listener mounted in
  `App.tsx` handling the `always` and `Navigation` rows (palette, shortcuts,
  settings, open, clone, close/next/prev tab). It follows R14 and calls
  `e.preventDefault()` when it acts. Open and clone reuse the handlers
  `StartScreen`/`App` already have (lift `onClone` and the open-folder flow
  into `App`-level callbacks).
- `RepoPane` keeps its listener for the `Repository` rows but matches
  through `matchesShortcut` instead of its local map; `MessageEditor` keeps
  its handlers and matches through the same helper. No shortcut is defined
  in two places.
- Walk check: WebKitGTK may claim `Ctrl+W`, `Ctrl+O`, `Ctrl+PageUp/PageDown`
  before the page sees keydown. Every handled chord calls
  `preventDefault()`; the acceptance walk confirms they reach the app, and
  any that do not become a follow-up with an alternative binding.

### 7.3 `ShortcutsDialog` (`src/features/settings/ShortcutsDialog.tsx`)

`role="dialog"`, `<h2>Keyboard shortcuts</h2>`, one `<table>` per group with
caption = group name, columns `Action` and `Shortcut` (`<kbd>` per key,
`formatKeys`), `Close` button, Escape closes. Opened by `Mod+/`, the
palette (`Show keyboard shortcuts`), and a `Keyboard shortcuts…` button at
the bottom of the Settings dialog.

## 8. Command palette (AC 5)

`src/features/palette/CommandPalette.tsx` + `useCommands.ts` + `src/lib/fuzzy/`.

- Dialog, `aria-label="Command palette"`, an input (`aria-label="Search commands"`,
  placeholder `Type a command or repository name`, `role="combobox"`,
  `aria-controls` the listbox, `aria-activedescendant`), a `role="listbox"`
  grouped with `role="group" aria-label` headings `Actions`, `Open
repositories`, `Recent repositories`. Empty: `No matching commands`
  (`role="status"`). Arrow keys move, Home/End jump, Enter runs, Escape
  clears a non-empty query first and closes on the second press (the
  RepoBrowser rule); composing Escape is ignored. Clicking a row runs it.
  The list is capped at 50 rows after ranking.
- Rows show the label, an optional detail (repository path, shortcut via
  `formatKeys`), and highlight matched characters with `<mark>` (the
  `FilePickerDialog` convention if it has one; otherwise plain).
- Commands (`useCommands()` returns `Command[] { id, label, detail?, group, run, shortcutId? }`):
  - Always: `Open repository…`, `Clone repository…`, `Open settings`,
    `Show keyboard shortcuts`, `Theme: System`, `Theme: Light`, `Theme: Dark`
    (the active one shows detail `Current`), `Go to start screen`.
  - With a repository active: `Fetch`, `Pull`, `Push`, `File history…`,
    `Open repository in editor`, `Close repository tab`. `Fetch`/`Pull`/`Push`
    are listed disabled (`aria-disabled`, detail = the gate reason) when
    `useSyncActions` reports a gate; the palette reads the pane's hook
    through a small `repoActions` registry on the shell store that
    `RepoPane` publishes from a `useEffect` (never during render), storing
    only stable callbacks and the `gates` object, with an unmount cleanup
    that clears the entry (so the palette never mounts its own network
    hooks and no render loop can form).
  - `Open repositories`: one row per tab other than the active one,
    `Switch to ‹name›`, detail = path.
  - `Recent repositories`: one row per recent entry not already open,
    `Open ‹name›`, detail = path, running `useOpenRepo().open(path)`.
- Ranking: `rankCommands(query, commands)` in `src/lib/fuzzy/` wraps the
  existing `fuzzyMatch` (moved there, R12): blank query keeps the order
  above; otherwise matches on label then detail, stable by score, groups
  preserved. Covered by `rankCommands.test.ts`.

## 9. Toasts (AC 6)

`toasts.ts` gains a variant and the ability to stay:

```ts
interface Toast { id; text; action; variant: "info" | "success" | "error"; }
show(text, action?)                                  // unchanged: info, 8 s
notify({ text, variant, action?, sticky? }): number  // error defaults to sticky
```

`Toasts.tsx` renders `data-variant`, a leading icon with `aria-hidden`, and
for `error` uses `role="alert"` on the item (the region stays polite);
sticky toasts have no timeout and keep the `Dismiss` button. At most 5
toasts are shown; older info/success toasts are dropped first.

Raised by:

| Event                         | Toast                                                                  |
| ----------------------------- | ---------------------------------------------------------------------- |
| fetch done (`useSyncActions`) | success `Fetch complete`                                               |
| pull done, clean              | success `Pull complete` (conflicts: none; the `OperationBanner` shows) |
| push done                     | success `Pushed ‹branch›`                                              |
| clone done (`useOpenRepo`)    | success `Cloned ‹name›`                                                |
| external tool failure         | error `Couldn't open ‹editor                                           | diff tool | merge tool›: ‹message›`, action `Settings…` |
| settings save failure         | error `Couldn't save settings: ‹message›`                              |

Successful toasts do not duplicate `SyncMessage` (which only renders
failures). The existing `PR opened` toast becomes `success`.

## 10. Clone default directory

`CloneDialog` initialises `parentDir` from `settings.defaultCloneDir` when
the dialog opens and the query has data (a later load does not overwrite a
folder the user picked); `pickFolder` gets the current `parentDir` as its
`defaultPath` (new optional second argument on the wrapper; `open({ defaultPath })`).
`Destination` shows immediately when a default exists. Nothing else in the
clone flow changes.

## 11. Error handling summary

| Failure                                 | Surface                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.json` unreadable at startup   | log + defaults; nothing shown                                                                                                                           |
| save fails (`Io`)                       | field reverts; error toast                                                                                                                              |
| Git executable invalid                  | inline `role="alert"` under the field; not stored; `locate()` unaffected                                                                                |
| configured Git executable deleted later | every CLI op fails `GitCliMissing` with the configured path in the message (existing surfaces); the Settings dialog shows the same text under the field |
| tool unset                              | Settings opens at Tools; no backend call                                                                                                                |
| tool fails                              | error toast with `Settings…` action                                                                                                                     |
| palette action gated                    | row disabled with the gate reason                                                                                                                       |

## 12. Testing strategy

- **Core (`cargo test -p git-real-core`):** `settings.rs` apply/normalise/
  version tolerance; `git_cli.rs` configured-path precedence and `verify`
  with fake scripts; `tools.rs` splitter table (quotes, escapes, errors),
  editor spawn error mapping, difftool/mergetool argument construction
  (asserted through a `GIT` fake script that records argv to a file, the
  pattern `remote/` tests use for the inline helper) and the root-commit
  empty-tree case.
- **App (`cargo test --workspace`):** `SettingsStore` load/update/save
  round trip and the Git override push; command wrappers' error mapping
  (`NoExternalTool`, `GitCliInvalid`); `check_git_cli` version field.
- **Front end (Vitest, 100 %):** stores (`appearancePrefs`, `shell`,
  `toasts` variants and cap); `applyAppearance`; `tokens.test.ts`;
  `shortcuts` registry (unique ids and keys, `matchesShortcut` matrix incl.
  composing/repeat/defaultPrevented/metaKey, `formatKeys` per platform);
  `useGlobalShortcuts` (each binding, dialog suppression, preventDefault);
  `SettingsDialog` (every field commit path, clamping, validation alert,
  revert on error, section focus, Escape/composing-Escape, restore focus);
  `ShortcutsDialog` (every registry row rendered once); `CommandPalette`
  (ranking, groups, keyboard model, disabled rows, switch/open recent,
  Escape-clears-then-closes, cap 50); `rankCommands`; `FileHeader` and
  `ConflictEditor` tool buttons (hidden per scope, unset → Settings, failure
  → toast); `useSyncActions`/`useOpenRepo` toasts; `CloneDialog` default
  directory and `defaultPath`; IPC wrappers send every key; `TabBar` buttons.

## 13. Verification gate

From `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo fmt --check`, `cargo tree -i openssl-sys` prints nothing. From the
root: `npm run test:coverage` at 100 % statements/branches/functions/lines,
`npm run lint` (0 errors), `npm run typecheck`, `npx prettier --check .`.
Plus the coverage agent's confirmation and the architect's explicit approval.

## 14. Acceptance walk (manual or via the WebKit inspector driver)

1. Start the app with the system in dark mode: dark tokens apply, no flash.
   Open Settings (Ctrl+,) → Theme `Light`: the window turns light at once;
   restart: still light. Back to `System`.
2. Settings → Diff → font size 16: open a diff, the code is larger; the
   sample updates live. Set a family (`monospace`), then clear it.
3. Settings → Clone → `Choose folder…` → pick the scratchpad. Open Clone…:
   `Destination` already points into the scratchpad.
4. Settings → Git → type `/usr/bin/false` → `Not a Git executable: …`;
   `Browse…` → pick `/usr/bin/git` → `Using /usr/bin/git (git version …)`;
   `Use PATH` reverts.
5. Settings → Tools → editor `xdg-open`; select a changed file; `Open in
editor` launches it. Clear the editor; click again → Settings opens at Tools.
6. Ctrl+K → type `fet` → Enter: fetch runs and `Fetch complete` toasts.
   Ctrl+K → type a recent repository name → Enter: it opens in a new tab;
   Ctrl+PageUp/PageDown cycle tabs; Ctrl+W closes the current one.
7. Ctrl+/ → the reference lists every row of §7.1; Escape closes it.
8. Push with the remote unreachable: the inline `SyncMessage` shows as
   before (no duplicate toast); push with it reachable → `Pushed ‹branch›`.
