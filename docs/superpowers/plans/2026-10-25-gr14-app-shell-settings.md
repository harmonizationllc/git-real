# GR-14 Application Shell, Settings and Keyboard Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The window follows the system theme or a manual override; one Settings dialog holds the clone directory, diff font, external editor/diff/merge tools and the Git executable; every common action has a fixed shortcut listed in a reference dialog; a Ctrl+K palette reaches actions and open/recent repositories; fetch, pull, push and clone announce completion as toasts, and failures without an inline home become error toasts.

**Architecture:** Appearance (theme, diff font) persists in `localStorage` through a zustand store applied to `<html>` before React paints; everything the backend needs (clone directory, Git executable, tool commands) persists in `settings.json` beside `recent-repos.json` through a `SettingsStore` that mirrors `RecentStore`. The Git override is a process-wide configured path read first by `git_cli::locate()`. External diff/merge run through `git difftool`/`git mergetool` with the user's command as the `gitreal` tool; the editor is spawned detached. Shell dialogs (settings, palette, shortcuts) are one slot on a `shell` store; the palette reads the active pane's sync actions from a registry on that store, never mounting network hooks itself.

**Tech Stack:** Rust (`std::process`, `serde`, `thiserror`; no new crates), Tauri 2 commands through `run_blocking`, React 19 + TypeScript, TanStack Query 5, zustand (persist), CSS custom properties, CodeMirror 6 theme vars, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-25-gr14-app-shell-settings-design.md` (rulings R1–R17 are closed; this plan does not reopen them). Architect review and survey: `/tmp/claude-1000/-home-gorlox-code-git-real/4e138a53-1ea2-4bc5-b8ec-4967f22f8ebb/scratchpad/afk/GR-14/reports/{gr-14-spec-architect,gr-14-survey}.md`.

## Global Constraints

- **Standing rules.** Tests first, written by the test role; the developer never edits test files. The only importer of `@tauri-apps/api/core` is `src/lib/ipc` (features import typed wrappers; `src/lib/ipc` is the one mock point). `git2` stays `default-features = false`; nothing network goes through it. No `tokio`, `reqwest` or new crates (R15); Tauri capabilities unchanged (`dialog:allow-open` already covers the pickers). Every command body runs inside `run_blocking`; the session lock is **never** held while an external tool runs. 100 % statements/branches/functions/lines. Commits carry the noreply author email (repo-local config). `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings`, ESLint and `prettier --check .` clean.
- **Composing-Escape rule:** an Escape with `e.nativeEvent.isComposing || e.keyCode === 229` never closes a dialog, clears a query or triggers a shortcut (shortcut matching ignores composing, `repeat` and `defaultPrevented` events).
- **Restore-focus rule:** every new dialog calls `useRestoreFocus(fallbackFocus)` before the layout effect that moves focus in; the three shell dialogs use the App root (`tabIndex={-1} data-focus-target`) as `fallbackFocus`; focus never lands on `document.body`.
- **Dialog suppression (R14):** global shortcuts do nothing while any `[role="dialog"]` is mounted; the shell dialogs close on their own Escape; opening one shell dialog closes the others (single slot).
- **Persistence keys and defaults:** `localStorage` key `git-real.appearancePrefs`, `version: 1`; `theme` default `"system"`, `diffFontFamily` default `null`, `diffFontSize` default `13`, clamped to `10–24` and rounded; `DEFAULT_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"`; tokens `--font-mono`, `--diff-font-size` (px); attribute `data-theme` on `<html>`, absent for `system`. `settings.json` is `{ "version": 1, "settings": { … } }`; missing/unreadable/corrupt/unknown-version → defaults (logged with `eprintln!`), tmp-write-then-rename saves.
- **Wire shapes (camelCase):** `Settings { defaultCloneDir, gitExecutable, externalEditor, externalDiffTool, externalMergeTool }` (all `string | null`); `SettingsPatch = Partial<Settings>` (present key with `null` clears); `GitCliInfo { available, path, version, error }`; `ExternalDiffScope = { kind: "unstaged" } | { kind: "staged" } | { kind: "commit"; oid }`; commands `get_settings`, `update_settings { patch }`, `open_in_editor { path }`, `open_external_diff { repoId, path, scope }`, `open_external_merge { repoId, path }`. New `AppErrorKind`s, unit variants in Rust and strings in **both** `types.ts` and `errors.ts` `KINDS`: `invalidSettings`, `gitCliInvalid`, `noExternalTool`, `externalToolFailed`.
- **Git invocations (exact argv, cwd = repo path):** difftool `-c difftool.gitreal.cmd=‹cmd› -c difftool.prompt=false difftool --tool=gitreal [--cached | ‹parent› ‹oid›] -- ‹path›`, where a root commit's `‹parent›` is `4b825dc642cb6eb9a060e54bf8d69288fbee4904`; mergetool `-c mergetool.gitreal.cmd=‹cmd› -c mergetool.gitreal.trustExitCode=true -c mergetool.prompt=false -c mergetool.keepBackup=false mergetool --tool=gitreal -- ‹path›`. Both through `git_cli::command(git)` (keeps `DISPLAY`/`WAYLAND_DISPLAY`, strips `GIT_*` repo vars).
- **Shortcut registry (R9, §7.1), `keys` with `Mod`:** `palette` Mod+K · `shortcuts` Mod+/ · `settings` Mod+, · `openRepo` Mod+O · `cloneRepo` Mod+Shift+O · `closeTab` Mod+W · `nextTab` Mod+PageDown · `prevTab` Mod+PageUp · `fetch` Mod+Shift+F · `pull` Mod+Shift+L · `push` Mod+Shift+P · `fileHistory` Mod+Shift+H · `commit` Mod+Enter · `linkIssue` Mod+Shift+I. Labels: `Command palette`, `Keyboard shortcuts`, `Settings`, `Open repository…`, `Clone repository…`, `Close repository tab`, `Next repository tab`, `Previous repository tab`, `Fetch`, `Pull`, `Push`, `File history…`, `Commit`, `Link issue…`. Groups `Application | Repository | Commit | Navigation`; `when` `always | repo | editor` as in the spec table. No shortcut is defined in two places.
- **Copy (verbatim; ‹…› are values):**
  - TabBar buttons: names `Command palette` (title `Command palette (Ctrl+K)`) and `Settings` (title `Settings (Ctrl+,)`).
  - Settings dialog: `<h2>Settings</h2>`, `Close`; sections `Appearance`, `Diff`, `Clone`, `Tools`, `Git`; `Theme` radios `System`, `Light`, `Dark`; `Font family` placeholder `System monospace`; `Font size` (`min=10 max=24 step=1`) suffix `px`; sample `<pre aria-label="Diff font sample">` lines `- const total = a + b;` and `+ const total = add(a, b);`; `Default clone directory` value `Not set`, buttons `Choose folder…` (picker title `Choose default clone directory`) and `Clear`; `External editor` hint `Command line; the file or folder path is appended, e.g. code --wait`; `External diff tool` hint `Git difftool command, e.g. meld "$LOCAL" "$REMOTE"`; `External merge tool` hint `Git mergetool command, e.g. meld "$LOCAL" "$BASE" "$REMOTE" --output "$MERGED"`; `Git executable` placeholder `Found on PATH`, line `Using ‹path› (git version ‹x.y.z›)`, buttons `Browse…` (picker title `Choose Git executable`) and `Use PATH`; validation alert `Not a Git executable: ‹message›`; status `Saved`; toast `Couldn't save settings: ‹message›`; bottom button `Keyboard shortcuts…`.
  - Rust messages: `Configured Git executable not found: ‹path›`; `Couldn't start ‹argv0›: ‹io error›`; `no external ‹editor|diff tool|merge tool› is configured`.
  - Tool entry points: buttons `Open in editor`, `External diff`, `Open in merge tool` (running: `Merge tool open…`); error toast `Couldn't open ‹editor|diff tool|merge tool›: ‹message›` with action `Settings…`.
  - Shortcuts dialog: `<h2>Keyboard shortcuts</h2>`, one table per group with caption = group name, columns `Action`, `Shortcut`; static Navigation rows `Escape` — `Close dialog or menu`, `Arrow keys` — `Move within lists and menus`; `Close`.
  - Palette: dialog `aria-label="Command palette"`, input `aria-label="Search commands"` placeholder `Type a command or repository name`, groups `Actions`, `Open repositories`, `Recent repositories`, empty `No matching commands`; commands `Open repository…`, `Clone repository…`, `Open settings`, `Show keyboard shortcuts`, `Theme: System`, `Theme: Light`, `Theme: Dark` (active detail `Current`), `Go to start screen`, `Fetch`, `Pull`, `Push`, `File history…`, `Open repository in editor`, `Close repository tab`, `Switch to ‹name›`, `Open ‹name›`.
  - Toasts: `Fetch complete`, `Pull complete`, `Pushed ‹branch›`, `Cloned ‹name›`; the existing `Opened #‹n›` PR toast becomes `success`.
- Checks: from `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `cargo tree -i openssl-sys` prints nothing; from the root: `npm run test:coverage` at 100 %, `npm run lint`, `npm run typecheck`, `npx prettier --check .`.

## Review Focus

1. **A merge tool left open for minutes.** Every other command on that repository must keep working: the handler reads the path under the lock, drops it, then spawns (Task 4 test `external_merge_does_not_hold_the_session_lock_while_the_tool_runs`).
2. **The Git override leaking between tests or into other binaries.** `CONFIGURED` is process-wide: every test that sets it holds `TEST_LOCK` and resets through a panic-safe guard (Task 2 `git_cli_configured.rs` guard `ResetConfigured`; test `a_panicking_test_still_resets_the_override`), and `cli_argv.rs`/`commands.rs` never see a configured path.
3. **Theme flash and override precedence.** Dark system + `light` override must paint light from the first frame: `bootstrapAppearance()` runs before `createRoot`, and the media block is gated by `:not([data-theme="light"])` while `[data-theme="dark"]` wins over a light system (Task 6 `applies the stored theme before the first render`, Task 7 `tokens.test.ts` `the media dark block is gated by :not([data-theme="light"])` and `the two dark blocks declare identical pairs`).
4. **The palette must never create network traffic or a render loop.** It reads `repoActions` from the shell store only (Task 14 test `renders repository actions without calling listBranches, listRemotes or getOperationState`); RepoPane publishes from `useEffect` with stable callbacks and clears on unmount (Task 15 tests `publishes repoActions from an effect and clears them on unmount`, `republishes only when a gate or the path changes`).
5. **A new error kind added in one TS place only.** `errors.ts` `KINDS` is `Record<AppErrorKind, true>`, so `types.ts` alone fails `typecheck`; the runtime guard is pinned by Task 5 test `isAppError accepts every new kind` (`invalidSettings`, `gitCliInvalid`, `noExternalTool`, `externalToolFailed`) and by `src-tauri/tests/error.rs` `new_kinds_serialize_to_their_camel_case_names`.

## Deviations and calls (decided here; the implementer does not reopen them)

- **`GitError::GitCliConfiguredMissing(PathBuf)`** (new core variant, Display `Configured Git executable not found: ‹path›`) maps to the existing `AppErrorKind::GitCliMissing`. The unit `GitError::GitCliMissing` cannot carry the path and has 17 usages; the wire kind is what the spec requires.
- **`GitCliInfo` gains `error: string | null`** besides `version`: the Settings dialog's "the same text under the field" (§11) needs the locate/verify message, and the wire shape has no other place for it. `available` is true only when `verify` succeeded; `path` is the located path even when `verify` failed.
- **`verify` returns `String`** (the text after `git version `, trimmed, e.g. `2.43.0`); no `GitVersion` type.
- **Commit-scope parent resolution** lives in core: `ExternalDiffScope::resolve(&RepoSession) -> Result<DiffRange, GitError>` (via a new `RepoSession::first_parent_oid`) runs under the session lock; `tools::open_external_diff` takes the resolved `DiffRange` and never touches git2.
- **`SettingsError` and `ToolError` are their own core error types** (not `GitError` variants) with `From` impls in `src-tauri/src/error.rs` → `InvalidSettings` / `ExternalToolFailed`; `NoExternalTool` is built by `AppError::no_external_tool(tool)` in the app crate.
- **Splitter rules:** backslash escapes the next char outside single quotes; inside single quotes nothing escapes; an explicit empty quoted argument (`""`) is kept; a trailing lone backslash is literal; a whitespace-only command is `EmptyCommand`.
- **`SettingsStore::load` is pure**; `SettingsStore::apply_git_override()` pushes the stored path into `git_cli` and `lib.rs` `setup` calls it once after `load`.
- **`main.tsx` stays untested** (it is not in coverage today): it calls one tested `bootstrapAppearance()` from `src/app/applyAppearance.ts`, which applies the stored prefs and subscribes for later changes.
- **Font tokens also get CSS defaults** in `:root` of `tokens.css` (`--font-mono: ui-monospace, SFMono-Regular, Menlo, monospace; --diff-font-size: 13px`) so components render correctly in tests without the bootstrap; `tokens.test.ts` counts only `--color-*`, `--syntax-*` and `--graph-lane-*` as theme tokens.
- **`UseOpenRepo.open` and `init` resolve `boolean`** like `clone`, so App can send the user to the start screen (where `RepoError` lives) when a shortcut/palette open fails. `StartScreen` takes the App-level opener as a prop (`opener: UseOpenRepo`) instead of calling `useOpenRepo()` itself; App exposes `ShellActions { openRepo(), cloneRepo(), openPath(path) }` to the shortcuts hook and the palette.
- **`closeRepoTab` moves** from `App.tsx` to `src/app/closeRepoTab.ts` so the shortcuts hook and the palette share it.
- **Shell-dialog focus fallback** is the App root element (`rootRef`), not a tab-bar button: `TabBar` gets no new props (spec §4.1) and a clicked button is not focused by WebKit anyway.
- **Font size commit model:** in-range values apply on change; an out-of-range or empty value is clamped and applied on blur/Enter, after which the input shows the clamped value (so typing `1` on the way to `16` does not snap to `10`).
- **Git field failure model:** Enter with an invalid value shows the alert and keeps the typed text; blur with an invalid value shows the alert and reverts to the stored value; any other error (`io`, `invalidSettings`) reverts and toasts `Couldn't save settings: ‹message›`.
- **`useExternalTool(tool)`** in `features/settings` is the one place the three entry points share: unset → `open({ kind: "settings", section: "tools" })` without a backend call; rejection → the error toast with `Settings…`.
- **Toast cap:** when a sixth toast arrives, the oldest non-error toast is dropped; if all five are errors, the oldest is dropped.
- **Tab cycling wraps** (next after the last is the first). `matchesShortcut` treats `Mod` as `ctrlKey || metaKey`, requires `shiftKey` to equal the listing and `altKey` to be false; letters also match on `e.code === "Key‹X›"`, `,` on `Comma`, `/` on `Slash`. `formatKeyParts` returns `["Ctrl","Shift","F"]` (or `["⌘","⇧","F"]` when `navigator.platform` starts with `Mac`); `formatKeys` joins with `+` (nothing on macOS).

---

### Task 1: Core — `settings.rs`

**Files:**

- Create: `src-tauri/crates/git-real-core/src/settings.rs`; Modify: `src/lib.rs` (`pub mod settings; pub use settings::{Settings, SettingsPatch, SettingsError, SettingsFile};`)
- Test (test role): `src-tauri/crates/git-real-core/tests/settings.rs`

**Interfaces (produces):**

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)] #[serde(rename_all = "camelCase", default)]
pub struct Settings { pub default_clone_dir: Option<PathBuf>, pub git_executable: Option<PathBuf>, pub external_editor: Option<String>, pub external_diff_tool: Option<String>, pub external_merge_tool: Option<String> }
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)] #[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch { /* same five fields as Option<Option<T>>, each #[serde(default, deserialize_with = "double_option")] */ }
#[derive(Debug, Error, PartialEq, Eq)] pub enum SettingsError {
    #[error("the {0} must be an absolute path")] RelativePath(&'static str),   // "default clone directory" | "Git executable"
    #[error("{0} is not a directory")] NotADirectory(PathBuf) }
impl Settings { pub fn apply(&self, patch: &SettingsPatch) -> Result<Settings, SettingsError>; }
pub const SETTINGS_VERSION: u32 = 1;
#[derive(Serialize, Deserialize)] pub struct SettingsFile { pub version: u32, #[serde(default)] pub settings: Settings }
impl SettingsFile { pub fn current(settings: Settings) -> Self; /// None when the version is unknown
                    pub fn into_settings(self) -> Option<Settings>; }
```

- [ ] **Step 1: Write the failing tests** in `tests/settings.rs`: `default_settings_are_all_none`; `settings_serialize_camel_case_with_nulls` (round trip through `serde_json`); `patch_absent_key_keeps_and_null_clears_and_value_sets` (JSON `{}` / `{"externalEditor":null}` / `{"externalEditor":"code --wait"}`); `apply_trims_strings_and_maps_empty_to_none` (`"  "` → `None`, `" meld "` → `"meld"`); `apply_rejects_a_relative_clone_dir_and_git_path` (`RelativePath("default clone directory")`, `RelativePath("Git executable")`); `apply_rejects_a_clone_dir_that_is_not_a_directory` (a tempfile **file** path → `NotADirectory`); `apply_accepts_an_existing_absolute_clone_dir` (tempdir); `settings_file_round_trips_version_1_and_rejects_version_2` (`into_settings()` → `None` for `version: 2`); `settings_file_without_a_settings_key_is_defaults`.
- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real-core --test settings` (from `src-tauri`): compile error, module missing.
- [ ] **Step 3: Implement** `settings.rs` as above (`double_option` = `Option::<T>::deserialize(d).map(Some)`), export from `lib.rs`.
- [ ] **Step 4: Run to verify pass** — same command; clippy clean.
- [ ] **Step 5: Commit** — `feat(core): GR-14 Settings, SettingsPatch and the versioned settings file`

### Task 2: Core — Git executable override and `verify`

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/git_cli.rs`, `src/error.rs` (`GitCliInvalid { message: String }` with Display `{message}` — e.g. `exited with code 1` or `unexpected output: hello` — so the UI's `Not a Git executable: ‹message›` prefix is not doubled; `GitCliConfiguredMissing(PathBuf)` with Display `Configured Git executable not found: {0}`)
- Test (test role): Create `src-tauri/crates/git-real-core/tests/git_cli_configured.rs` (`#![cfg(unix)]`; `static TEST_LOCK: Mutex<()>`; `struct ResetConfigured; impl Drop { set_configured_path(None) }`; fixtures via `std::fs::write` + `0o755`: a fake `#!/bin/sh\necho git version 9.9.9` and a non-git `#!/bin/sh\necho hello`); Modify `tests/session.rs`/`cli_unavailable.rs` only if their `GitCliMissing` matches need `{ .. }` (they should not: the variant stays unit).

**Interfaces (produces):**

```rust
pub fn set_configured_path(path: Option<PathBuf>);
pub fn configured_path() -> Option<PathBuf>;
pub fn locate() -> Result<PathBuf, GitError>;   // configured && is_file → Ok; configured && !is_file → GitCliConfiguredMissing; unset → PATH as today
pub fn verify(path: &Path) -> Result<String, GitError>;  // spawn error → GitCliMissing; exit≠0 or stdout not starting "git version " → GitCliInvalid; Ok("9.9.9")
```

- [ ] **Step 1: Write the failing tests** (every test takes `TEST_LOCK` and creates `ResetConfigured` first): `locate_prefers_the_configured_path_when_it_is_a_file`; `locate_fails_with_the_configured_path_in_the_message_when_it_is_gone` (`matches!(e, GitError::GitCliConfiguredMissing(p) if p == …)`, `e.to_string()` starts with `Configured Git executable not found: `); `locate_ignores_path_while_configured` (configured points at a file, `PATH` empty → still Ok); `locate_falls_back_to_path_when_unset` (`configured_path() == None`); `verify_returns_the_version_for_a_fake_git`; `verify_rejects_a_non_git_executable` (`GitCliInvalid`); `verify_maps_a_missing_file_to_git_cli_missing`; `a_panicking_test_still_resets_the_override` (`catch_unwind` around a body that sets the path and panics; afterwards `configured_path()` is `None`).
- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real-core --test git_cli_configured`: compile error.
- [ ] **Step 3: Implement** `static CONFIGURED: RwLock<Option<PathBuf>>` (poison-tolerant), the three functions, the two `GitError` variants.
- [ ] **Step 4: Run to verify pass** — `cargo test -p git-real-core`; clippy clean.
- [ ] **Step 5: Commit** — `feat(core): GR-14 configured Git executable override and verify`

### Task 3: Core — `tools.rs`

**Files:**

- Create: `src-tauri/crates/git-real-core/src/tools.rs`; Modify `src/lib.rs` (`pub mod tools;`)
- Test (test role): Create `src-tauri/crates/git-real-core/tests/tools.rs` (`#![cfg(unix)]`, `mod common;`; a fake GIT script `printf '%s\n' "$@" > "$PWD/argv.txt"` + optional `[ -f "$PWD/behaviour" ] && . "$PWD/behaviour"`, written per test into a tempdir — the `cli_argv.rs`/`clone.rs` argv-recording pattern — and passed as `git`; a fake editor script `printf '%s\n' "$@" > '‹tmp›/editor-argv.txt'`)

**Interfaces (produces):**

```rust
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
#[derive(Debug, Error, PartialEq, Eq)] pub enum ToolError {
    #[error("the command is empty")] EmptyCommand,
    #[error("the command has an unterminated quote")] UnterminatedQuote,
    #[error("Couldn't start {program}: {source}")] Spawn { program: String, source: String },
    #[error("{message}")] Failed { verb: &'static str, code: Option<i32>, message: String } } // message = last stderr line, else "git {verb} failed with exit code {code}"
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)] #[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExternalDiffScope { Unstaged, Staged, Commit { oid: String } }
#[derive(Debug, Clone, PartialEq, Eq)] pub enum DiffRange { Unstaged, Staged, Commit { parent: Option<String>, oid: String } }
impl ExternalDiffScope { pub fn resolve(&self, session: &RepoSession) -> Result<DiffRange, GitError>; }
impl RepoSession { pub fn first_parent_oid(&self, oid: &str) -> Result<Option<String>, GitError>; } // CommitNotFound for an unknown oid
pub fn split_command(cmd: &str) -> Result<Vec<String>, ToolError>;
pub fn open_in_editor(cmd: &str, path: &Path) -> Result<(), ToolError>;           // spawn detached, stdio null
pub fn open_external_diff(git: &Path, repo_path: &Path, cmd: &str, path: &str, range: &DiffRange) -> Result<(), ToolError>;
pub fn open_external_merge(git: &Path, repo_path: &Path, cmd: &str, path: &str) -> Result<(), ToolError>;
```

- [ ] **Step 1: Write the failing tests:** `split_command_table` (cases from Deviations: `code --wait`, `meld "$LOCAL" "$REMOTE"`, `'a b' c`, `a\ b`, `"a\"b"`, `'a\b'`, `""`, trailing `\`); `split_command_rejects_blank_and_unterminated` (`"   "` → `EmptyCommand`, `"abc` and `'abc` → `UnterminatedQuote`); `open_in_editor_appends_the_path_and_returns_before_the_tool_exits` (poll ≤ 2 s for the argv file: `["--wait", "/some/file"]`); `open_in_editor_maps_a_spawn_failure` (`/nonexistent/editor x` → `Spawn { program: "/nonexistent/editor", .. }`, message starts `Couldn't start /nonexistent/editor: `); `difftool_argv_for_unstaged_staged_and_commit` (exact argv from Global Constraints for each `DiffRange`; `--cached` for staged; `‹parent› ‹oid›` for a commit); `difftool_uses_the_empty_tree_for_a_root_commit`; `difftool_runs_in_the_repository_directory` (argv file lands in `repo_path`); `difftool_failure_carries_the_last_stderr_line` (behaviour `echo 'fatal: no such tool' >&2; exit 1` → `Failed { verb: "difftool", code: Some(1), message: "fatal: no such tool" }`); `mergetool_argv_is_exact`; `mergetool_failure_without_stderr_names_the_exit_code` (`git mergetool failed with exit code 2`); `first_parent_oid_is_none_for_a_root_commit_and_some_after` (`common::temp_repo_with_commit` + `common::commit_file`); `first_parent_oid_rejects_an_unknown_commit` (`CommitNotFound`); `resolve_maps_each_scope` (`Unstaged`/`Staged`/`Commit`).
- [ ] **Step 2: Run to verify failure** — `cargo test -p git-real-core --test tools`: compile error.
- [ ] **Step 3: Implement** `tools.rs`: the splitter state machine; editor via `Command::new(argv[0]).args(&argv[1..]).arg(path)` with null stdio and `spawn()` (child dropped); diff/merge via `git_cli::command(git).current_dir(repo_path)` + `git_cli::capture`, non-zero → `Failed`; `first_parent_oid` through `revision.rs` helpers.
- [ ] **Step 4: Run to verify pass** — `cargo test -p git-real-core`; clippy clean.
- [ ] **Step 5: Commit** — `feat(core): GR-14 external editor, difftool and mergetool launchers`

### Task 4: App layer — `SettingsStore`, settings and tool commands, `check_git_cli` version, wiring

**Files:**

- Create: `src-tauri/src/settings_store.rs`, `src-tauri/src/commands/settings.rs`, `src-tauri/src/commands/tools.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod settings_store;` manage `Arc<SettingsStore>` from `dir.join("settings.json")` in `setup`, then `store.apply_git_override()`; register 5 commands), `src-tauri/src/commands/mod.rs` (`pub mod settings; pub mod tools;`), `src-tauri/src/error.rs` (4 unit variants; `From<SettingsError>`, `From<ToolError>`; `AppError::no_external_tool(tool: &str)`; `GitCliInvalid`/`GitCliConfiguredMissing` arms), `src-tauri/src/commands/repo.rs` (`GitCliInfo { available, path, version: Option<String>, error: Option<String> }`, `GitCliInfo::from_probe(path: Option<PathBuf>, version: Result<String, GitError>)`, `check_git_cli_inner`)
- Test (test role): Create `src-tauri/tests/settings_store.rs`, `src-tauri/tests/tools_commands.rs` (each with its own `TEST_LOCK` + `ResetConfigured` as in Task 2); Modify `src-tauri/tests/commands.rs` (`GitCliInfo` literals gain `version`/`error`), `src-tauri/tests/error.rs`

**Interfaces (produces):**

```rust
pub struct SettingsStore { path: PathBuf, inner: Mutex<Settings> }
impl SettingsStore { pub fn load(path: PathBuf) -> Self; pub fn get(&self) -> Settings; pub fn apply_git_override(&self);
    /// apply → verify a changed Some(git_executable) → save (tmp + rename) → store → set_configured_path
    pub fn update(&self, patch: &SettingsPatch) -> Result<Settings, AppError>; }
// commands/settings.rs
pub fn get_settings_inner(store: &SettingsStore) -> Settings;
pub fn update_settings_inner(store: &SettingsStore, patch: &SettingsPatch) -> Result<Settings, AppError>;
#[tauri::command] pub async fn get_settings(settings: State<'_, Arc<SettingsStore>>) -> Result<Settings, AppError>;
#[tauri::command] pub async fn update_settings(settings: State<'_, Arc<SettingsStore>>, patch: SettingsPatch) -> Result<Settings, AppError>;
// commands/tools.rs — each reads what it needs under the lock, drops it, then locates git and runs
pub fn open_in_editor_inner(store: &SettingsStore, path: &str) -> Result<(), AppError>;
pub fn open_external_diff_inner(reg: &RepoRegistry, store: &SettingsStore, id: RepoId, path: &str, scope: &ExternalDiffScope) -> Result<(), AppError>;
pub fn open_external_merge_inner(reg: &RepoRegistry, store: &SettingsStore, id: RepoId, path: &str) -> Result<(), AppError>;
#[tauri::command] pub async fn open_in_editor(settings: State<'_, Arc<SettingsStore>>, path: String) -> Result<(), AppError>;
#[tauri::command] pub async fn open_external_diff(reg: …, settings: …, repo_id: RepoId, path: String, scope: ExternalDiffScope) -> Result<(), AppError>;
#[tauri::command] pub async fn open_external_merge(reg: …, settings: …, repo_id: RepoId, path: String) -> Result<(), AppError>;
```

- [ ] **Step 1: Write the failing tests.**
  - `settings_store.rs` (`common::temp_file_path("settings.json")`): `load_missing_corrupt_unreadable_and_unknown_version_yield_defaults` (four files; `version: 2` too); `load_does_not_create_the_file`; `update_persists_the_patch_and_round_trips` (file is `{"version":1,"settings":{…}}`, no `.tmp` left); `update_rejects_invalid_settings_without_saving` (relative path → `InvalidSettings`, file unchanged); `update_verifies_a_changed_git_executable_and_pushes_the_override` (fake git → `configured_path() == Some(fake)`); `update_rejects_a_non_git_executable_and_keeps_the_old_value` (`GitCliInvalid`; `get()` unchanged; override unchanged); `update_clearing_the_git_executable_resets_the_override`; `apply_git_override_installs_the_stored_path`; `update_reports_io_when_the_directory_is_unwritable` (parent `0o500`; `Io`; memory unchanged).
  - `tools_commands.rs` (fixture: `common::fresh_state()` + open a temp repo; configured fake git under the lock): `open_in_editor_without_a_configured_editor_is_no_external_tool` (message `no external editor is configured`, nothing spawned); `open_external_diff_runs_difftool_for_the_selected_scope` (argv recorded in the repo); `open_external_diff_for_a_root_commit_uses_the_empty_tree`; `open_external_merge_without_a_tool_is_no_external_tool`; `a_failing_tool_is_external_tool_failed_with_the_last_stderr_line`; `an_unknown_repo_is_unknown_repo`; `external_merge_does_not_hold_the_session_lock_while_the_tool_runs` (fake git blocks until `$PWD/.git/go` exists; run the inner fn on a thread; `reg.get(id).unwrap().try_lock()` succeeds within 2 s; create `go`; join → `Ok`).
  - `commands.rs`: `check_git_cli_reports_path_version_and_no_error_when_available` (existing test extended: `version` is `Some` when `locate()` succeeds); `from_probe_marks_unavailable_with_the_error_when_verify_fails` (`available: false, path: Some, version: None, error: Some(‹the GitError message›)`).
  - `error.rs`: `new_kinds_serialize_to_their_camel_case_names` (4 kinds); `settings_error_maps_to_invalid_settings`; `tool_error_maps_to_external_tool_failed_with_its_message`; `git_cli_invalid_and_configured_missing_map_to_their_kinds`.
- [ ] **Step 2: Run to verify failure** — `cargo test --workspace` (from `src-tauri`): compile errors.
- [ ] **Step 3: Implement** the store (mirror `RecentStore::load`/`save` byte for byte in shape), commands through `run_blocking`, `From` arms, `GitCliInfo`, `lib.rs` wiring.
- [ ] **Step 4: Run to verify pass** — `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`.
- [ ] **Step 5: Commit** — `feat: GR-14 settings store, settings and external-tool commands, git CLI version probe`

### Task 5: TS IPC seam

**Files:**

- Create: `src/lib/ipc/settings.ts`, `src/lib/ipc/tools.ts`; Modify: `src/lib/ipc/index.ts` (`export * from "./settings"; export * from "./tools";`), `src/lib/ipc/types.ts` (`Settings`, `SettingsPatch`, `ExternalDiffScope`, `GitCliInfo.version/error`, 4 kinds), `src/lib/ipc/errors.ts` (`KINDS`), `src/lib/ipc/dialog.ts`, `src/lib/query/keys.ts` (`settings: ["settings"] as const` beside `gitCli`)
- Test (test role): Create `src/lib/ipc/settings.test.ts`, `src/lib/ipc/tools.test.ts` (`mockIPC`/`clearMocks` as `commands.test.ts`); Modify `src/lib/ipc/dialog.test.ts`, `src/lib/ipc/errors.test.ts`, `src/lib/ipc/index.test.ts`, `src/lib/query/keys.test.ts`, and every fixture that builds a `GitCliInfo` (`CloneDialog.test.tsx`, `App.test.tsx`, `commands.test.ts`) gains `version`/`error`

**Interfaces (produces):**

```ts
export interface Settings {
  defaultCloneDir: string | null;
  gitExecutable: string | null;
  externalEditor: string | null;
  externalDiffTool: string | null;
  externalMergeTool: string | null;
}
export type SettingsPatch = Partial<Settings>;
export type ExternalDiffScope =
  { kind: "unstaged" } | { kind: "staged" } | { kind: "commit"; oid: string };
export interface GitCliInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
}
export function getSettings(): Promise<Settings>; // invoke("get_settings")
export function updateSettings(patch: SettingsPatch): Promise<Settings>; // invoke("update_settings", { patch })
export function openInEditor(path: string): Promise<void>; // { path }
export function openExternalDiff(
  repoId: RepoId,
  path: string,
  scope: ExternalDiffScope,
): Promise<void>; // { repoId, path, scope }
export function openExternalMerge(repoId: RepoId, path: string): Promise<void>;
export function pickFolder(title?: string, defaultPath?: string): Promise<string | null>; // open({ directory: true, multiple: false, title, defaultPath })
export function pickFile(title?: string): Promise<string | null>; // open({ directory: false, multiple: false, title })
```

- [ ] **Step 1: Write the failing tests:** `settings.test.ts` `getSettings sends get_settings with no arguments`, `updateSettings sends the patch under patch (null keys included)`, rejections pass through; `tools.test.ts` one `sends …` test per wrapper with every key, rejections pass through; `dialog.test.ts` `pickFolder passes defaultPath`, `pickFolder omits defaultPath when not given` (`expect.not.objectContaining({ defaultPath })`), `pickFile opens a single-file picker with the title`, `pickFile returns null on cancel`; `errors.test.ts` `isAppError accepts every new kind`; `keys.test.ts` `defines a settings key ["settings"] distinct from gitCli`; `index.test.ts` re-exports the five wrappers and `pickFile`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib`.
- [ ] **Step 3: Implement** the wrappers, types, kinds, key.
- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib`, `npm run typecheck` (the fixture updates make it green).
- [ ] **Step 5: Commit** — `feat(ipc): GR-14 settings and tool wrappers, pickFile, folder defaultPath, new error kinds`

### Task 6: Appearance store, `applyAppearance`, bootstrap

**Files:**

- Create: `src/lib/store/appearancePrefs.ts`, `src/app/applyAppearance.ts`; Modify: `src/main.tsx` (import and call `bootstrapAppearance()` before `createRoot`)
- Test (test role): Create `src/lib/store/appearancePrefs.test.ts` (reset as `layoutPrefs.test.ts`: `localStorage.clear()` + `setState`), `src/app/applyAppearance.test.ts`

**Interfaces (produces):**

```ts
export type ThemePref = "system" | "light" | "dark";
export const DEFAULT_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
export const DIFF_FONT_MIN = 10,
  DIFF_FONT_MAX = 24,
  DIFF_FONT_DEFAULT = 13;
interface AppearancePrefsState {
  theme: ThemePref;
  diffFontFamily: string | null;
  diffFontSize: number;
  setTheme(t: ThemePref): void;
  setDiffFontFamily(f: string | null): void;
  setDiffFontSize(px: number): void;
}
export const useAppearancePrefs; // persist name "git-real.appearancePrefs", version 1, partialize the three fields
export interface AppearanceSnapshot {
  theme: ThemePref;
  diffFontFamily: string | null;
  diffFontSize: number;
}
export function applyAppearance(
  prefs: AppearanceSnapshot,
  root: HTMLElement = document.documentElement,
): void;
export function bootstrapAppearance(): () => void; // applies getState(), subscribes; returns unsubscribe
```

- [ ] **Step 1: Write the failing tests:** `appearancePrefs.test.ts` — `defaults to system, null family and 13px`; `persists under git-real.appearancePrefs with version 1` (`JSON.parse(localStorage.getItem(...))` has `version: 1` and the three fields only); `setDiffFontSize clamps 9→10, 25→24 and rounds 13.6→14`; `setDiffFontSize ignores NaN` (stays); `setDiffFontFamily trims and maps "" and "  " to null`; `setTheme stores each value`. `applyAppearance.test.ts` — `system removes data-theme`; `light and dark set data-theme`; `sets --font-mono to the family and --diff-font-size in px`; `uses DEFAULT_MONO when the family is null`; `applies the stored theme before the first render` (seed `localStorage` with `{state:{theme:"light"},version:1}`, re-import the store module via `vi.resetModules()`, call `bootstrapAppearance()`, assert `data-theme="light"` synchronously); `re-applies when the store changes and stops after unsubscribe`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/store/appearancePrefs.test.ts src/app/applyAppearance.test.ts`.
- [ ] **Step 3: Implement** the store, the apply function, the bootstrap, the one-line `main.tsx` call.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(ui): GR-14 appearance preferences applied to the document before first paint`

### Task 7: Tokens restructure and diff-font consumption

**Files:**

- Modify: `src/styles/tokens.css` (light block + `color-scheme: light` + the two font defaults; `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { …dark…; color-scheme: dark } }`; `:root[data-theme="dark"] { …same dark block… }`), `src/features/diff/LineContent.module.css` (`.code`: `var(--font-mono)`, `var(--diff-font-size)`), `src/features/diff/DiffRows.module.css` (`.gutter,.gutterButton` and `.sign` families → `var(--font-mono)`; `.sign` size → `var(--diff-font-size)`), `src/features/history/BlameView.module.css` (`.lineno`, `.open` → `var(--font-mono)`), `src/features/merge/editor/EditorPane.tsx` (`paneTheme` `.cm-scroller` `fontFamily: "var(--font-mono)"`, `fontSize: "var(--diff-font-size)"`)
- Test (test role): Create `src/styles/tokens.test.ts` (reads the file with `node:fs`, parses `selector { decls }` blocks with a regex, ignores the media wrapper); Modify `src/features/merge/editor/EditorPane.test.tsx` (`renders the scroller with the font tokens`: a `cm-scroller` computed/inline style or theme class contains `var(--font-mono)`)

- [ ] **Step 1: Write the failing tests** in `tokens.test.ts`: `declares 38 theme tokens on :root plus --font-mono and --diff-font-size`; `the media dark block is gated by :not([data-theme="light"])`; `the two dark blocks declare identical pairs` (map equality of the 38 pairs + `color-scheme: dark`); `every light theme token has a dark counterpart`; `:root declares color-scheme light`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/styles src/features/merge/editor/EditorPane.test.tsx`.
- [ ] **Step 3: Implement** the CSS restructure (duplicate the dark declarations verbatim) and the token consumers.
- [ ] **Step 4: Run to verify pass**; `npx prettier --check src/styles`.
- [ ] **Step 5: Commit** — `feat(ui): GR-14 theme override tokens and diff font tokens`

### Task 8: `shell` store

**Files:**

- Create: `src/lib/store/shell.ts`; Test (test role): `src/lib/store/shell.test.ts`

**Interfaces (produces):**

```ts
export type SettingsSection = "appearance" | "diff" | "clone" | "tools" | "git";
export type ShellDialog =
  | null
  | { kind: "settings"; section?: SettingsSection }
  | { kind: "palette" }
  | { kind: "shortcuts" };
export interface RepoActions {
  repoId: RepoId;
  path: string;
  gates: { fetch: string | null; pull: string | null; push: string | null };
  fetch(): void;
  pull(): void;
  push(): void;
  fileHistory(): void;
}
export interface ShellActions {
  openRepo(): void;
  cloneRepo(): void;
  openPath(path: string): void;
}
interface ShellState {
  dialog: ShellDialog;
  repoActions: RepoActions | null;
  open(d: Exclude<ShellDialog, null>): void;
  close(): void;
  publishRepoActions(a: RepoActions | null): void;
}
export const useShell;
```

- [ ] **Step 1: Write the failing tests:** `starts with no dialog and no repoActions`; `open replaces the current dialog (mutually exclusive)`; `open settings with a section keeps the section`; `close clears the dialog only`; `publishRepoActions sets and clears the registry`.
- [ ] **Step 2–5:** run red → implement → run green → commit `feat(ui): GR-14 shell store for dialogs and repository actions`.

### Task 9: Shortcut registry; RepoPane and MessageEditor switch to it

**Files:**

- Create: `src/lib/shortcuts/index.ts` (registry + helpers; `src/lib/shortcuts/` may split `registry.ts`/`match.ts`/`format.ts`, re-exported from `index.ts`)
- Modify: `src/app/RepoPane.tsx` (delete `SYNC_SHORTCUTS` and the `h` branch; the listener keeps its dialog-suppression check and dispatches `fileHistory`/`fetch`/`pull`/`push` through `matchesShortcut`), `src/features/commit/MessageEditor.tsx` (`isLinkChord` → `matchesShortcut(e, "linkIssue")`; `handleEnter`'s Ctrl/Cmd branch → `matchesShortcut(e, "commit")`, the plain-Enter branch unchanged)
- Test (test role): Create `src/lib/shortcuts/shortcuts.test.ts`; Modify `src/app/RepoPane.test.tsx`, `src/features/commit/MessageEditor.test.tsx` only where a test named the old helper (behaviour is unchanged)

**Interfaces (produces):**

```ts
export type ShortcutId =
  | "palette"
  | "shortcuts"
  | "settings"
  | "openRepo"
  | "cloneRepo"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "fetch"
  | "pull"
  | "push"
  | "fileHistory"
  | "commit"
  | "linkIssue";
export type ShortcutGroup = "Application" | "Repository" | "Commit" | "Navigation";
export interface Shortcut {
  id: ShortcutId;
  keys: string;
  label: string;
  group: ShortcutGroup;
  when: "always" | "repo" | "editor";
}
export const SHORTCUTS: readonly Shortcut[]; // the §7.1 table, in that order
export const SHORTCUT_GROUPS: readonly ShortcutGroup[]; // ["Application","Repository","Commit","Navigation"]
export function shortcut(id: ShortcutId): Shortcut;
export function matchesShortcut(e: KeyboardEvent | React.KeyboardEvent, id: ShortcutId): boolean;
export function formatKeyParts(keys: string): string[];
export function formatKeys(keys: string): string;
```

- [ ] **Step 1: Write the failing tests:** `registry ids and keys are unique and the table has 14 rows`; `matchesShortcut matrix` (`it.each` over every row: the exact chord matches with `ctrlKey` and with `metaKey`; missing Shift, extra Shift, `altKey`, wrong key all fail); `matches letters by code on a non-Latin layout` (`key: "ф", code: "KeyF"`); `matches , and / by code`; `ignores repeat, defaultPrevented and composing events` (native `isComposing`, React `nativeEvent.isComposing`, `keyCode 229`); `formatKeyParts on Linux and macOS` (`vi.spyOn(navigator, "platform", "get")`); `formatKeys joins with + except on macOS`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/shortcuts src/app/RepoPane.test.tsx src/features/commit/MessageEditor.test.tsx`.
- [ ] **Step 3: Implement** the registry and helpers; switch the two consumers.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(ui): GR-14 shortcut registry; RepoPane and MessageEditor match through it`

### Task 10: `useGlobalShortcuts`, App-level actions, `ShortcutsDialog`

**Files:**

- Create: `src/app/useGlobalShortcuts.ts`, `src/app/closeRepoTab.ts` (moved from `App.tsx`, same body), `src/features/settings/ShortcutsDialog.tsx` (+ `.module.css`)
- Modify: `src/app/App.tsx` (root `<div ref={rootRef} tabIndex={-1} data-focus-target>`; `const opener = useOpenRepo()`; `actions: ShellActions = { openRepo: () => void pickFolder("Open repository").then(p => p !== null && actions.openPath(p)), cloneRepo: () => setCloneOpen(true), openPath: async (p) => { if (!(await opener.open(p))) activate(null) } }`; `useGlobalShortcuts(actions)`; `<StartScreen opener={opener} onClone={actions.cloneRepo} />`; mount `ShortcutsDialog` when `dialog?.kind === "shortcuts"` with `fallbackFocus={rootRef}`), `src/features/repo/StartScreen.tsx` (props `{ opener: UseOpenRepo; onClone(): void }`), `src/features/repo/useOpenRepo.ts` (`open`/`init` resolve `boolean`)
- Test (test role): Create `src/app/useGlobalShortcuts.test.tsx` (`renderHook` + `fireEvent.keyDown(window, …)`), `src/features/settings/ShortcutsDialog.test.tsx`; Modify `src/app/App.test.tsx` (`Ctrl+/ opens the shortcuts dialog and Escape returns focus to the app root`), `src/features/repo/StartScreen.test.tsx` (pass a stub opener), `src/features/repo/useOpenRepo.test.tsx` (`open resolves true/false`)

**Interfaces (produces):**

```ts
export function useGlobalShortcuts(actions: ShellActions): void; // one window keydown listener; always + Navigation rows; preventDefault when it acts
export function closeRepoTab(id: RepoId): void;
export interface ShortcutsDialogProps {
  onClose(): void;
  fallbackFocus: RefObject<HTMLElement | null>;
}
export function ShortcutsDialog(props: ShortcutsDialogProps): JSX.Element;
```

- [ ] **Step 1: Write the failing tests.** `useGlobalShortcuts.test.tsx`: `Mod+K, Mod+/ and Mod+, open the palette, shortcuts and settings dialogs`; `Mod+O and Mod+Shift+O call openRepo and cloneRepo`; `Mod+W closes the active tab (closeRepo called)`; `Mod+PageDown and Mod+PageUp cycle tabs and wrap`; `tab shortcuts do nothing without an active tab`; `does nothing while a [role="dialog"] is mounted`; `calls preventDefault only when it acts`; `removes the listener on unmount`. `ShortcutsDialog.test.tsx`: `renders one table per group with the group as caption`; `lists every registry row once with formatted kbd parts`; `lists the two static Navigation rows`; `Close and Escape call onClose; a composing Escape does not`; `restores focus to the fallback`. `useOpenRepo.test.tsx`: `open resolves true on success and false on failure`; `init resolves false on failure`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/app src/features/settings src/features/repo`.
- [ ] **Step 3: Implement** the hook (reads `useRepoTabs.getState()` at event time; opens dialogs via `useShell.getState().open`), the dialog, the App/StartScreen lift.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(ui): GR-14 global shortcuts, shortcuts reference dialog, lifted open and clone actions`

### Task 11: Toast variants, cap and completion toasts

**Files:**

- Modify: `src/lib/store/toasts.ts`, `src/components/Toasts.tsx` (+ `.module.css`: `[data-variant]` borders, icon span), `src/features/remotes/useSyncActions.ts` (after `start` resolves `ok`: fetch → `Fetch complete`; pull → `Pull complete` only when `result.value === "completed"`; push and publish/force-push → `Pushed ‹local›`), `src/features/repo/useOpenRepo.ts` (clone ok → `Cloned ‹repo.summary.name›`), `src/features/hosting/useCreatePullRequest.ts` (`notify({ text, variant: "success", action })`)
- Test (test role): Modify `src/lib/store/toasts.test.ts`, `src/components/Toasts.test.tsx`, `src/features/remotes/useSyncActions.test.tsx`, `src/features/repo/useOpenRepo.test.tsx`, `src/features/hosting/useCreatePullRequest.test.tsx`

**Interfaces (produces):**

```ts
export type ToastVariant = "info" | "success" | "error";
export interface Toast { id: number; text: string; action: { label: string; run(): void } | null; variant: ToastVariant; sticky: boolean }
export const MAX_TOASTS = 5;
show(text: string, action?: Toast["action"]): number;                                   // info, not sticky
notify(t: { text: string; variant: ToastVariant; action?: Toast["action"]; sticky?: boolean }): number; // sticky defaults to variant === "error"
```

- [ ] **Step 1: Write the failing tests.** `toasts.test.ts`: `show stores variant info and sticky false`; `notify defaults sticky to true for error and false otherwise`; `notify honours an explicit sticky`; `caps at 5 dropping the oldest non-error first`; `drops the oldest error when all five are errors`. `Toasts.test.tsx`: `renders data-variant and an aria-hidden icon`; `an error toast has role alert while the region stays status/polite`; `a sticky toast has no timeout and keeps Dismiss` (fake timers past `TOAST_MS`); `a non-sticky success toast times out`. `useSyncActions.test.tsx`: `toasts Fetch complete on success and nothing on failure`; `toasts Pull complete only for a completed outcome` (`"conflicts"` → none); `toasts Pushed <branch> after push and after publish`. `useOpenRepo.test.tsx`: `toasts Cloned <name> on clone success and not on open`. `useCreatePullRequest.test.tsx`: `the opened toast is a success variant`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/store/toasts.test.ts src/components src/features/remotes/useSyncActions.test.tsx src/features/repo src/features/hosting/useCreatePullRequest.test.tsx`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(ui): GR-14 toast variants, sticky errors, cap, and completion toasts`

### Task 12: Fuzzy matcher moves to `src/lib/fuzzy/`; `rankCommands`

**Files:**

- Create: `src/lib/fuzzy/index.ts` (`fuzzyMatch`, `rankFiles`, `MAX_PICKER_ROWS` moved verbatim; `rankCommands`); Delete: `src/features/history/model/fuzzy.ts`; Modify: `src/features/history/FilePickerDialog.tsx` (import from `../../lib/fuzzy`)
- Test (test role): Move `src/features/history/model/fuzzy.test.ts` → `src/lib/fuzzy/fuzzy.test.ts` (imports only); Create `src/lib/fuzzy/rankCommands.test.ts`

**Interfaces (produces):**

```ts
export interface Rankable {
  label: string;
  detail?: string;
}
export interface Ranked<T> {
  item: T;
  matched: "label" | "detail" | null;
}
/** Blank query: input order, matched null. Otherwise rows whose label (else detail) matches, by score, stable; group order preserved by the caller's input order. */
export function rankCommands<T extends Rankable>(query: string, items: readonly T[]): Ranked<T>[];
export const MAX_PALETTE_ROWS = 50;
```

- [ ] **Step 1: Write the failing tests:** `blank query keeps order and marks nothing matched`; `matches on label before detail`; `orders by score then input order (stable)`; `drops non-matching rows`; `is case-insensitive`.
- [ ] **Step 2–5:** run red → implement/move → `npx vitest run src/lib/fuzzy src/features/history` green → commit `refactor(ui): GR-14 fuzzy matcher under src/lib with rankCommands`.

### Task 13: `useSettings`, `useExternalTool`, `SettingsDialog`

**Files:**

- Create: `src/features/settings/useSettings.ts`, `src/features/settings/useExternalTool.ts`, `src/features/settings/TextSetting.tsx`, `src/features/settings/SettingsDialog.tsx` (+ `.module.css`)
- Test (test role): Create `useSettings.test.tsx`, `useExternalTool.test.tsx`, `TextSetting.test.tsx`, `SettingsDialog.test.tsx` (mock `src/lib/ipc`: `getSettings`, `updateSettings`, `checkGitCli`, `pickFolder`, `pickFile`; `renderWithProviders`; reset `useAppearancePrefs`, `useShell`, `useToasts`)

**Interfaces (produces):**

```ts
export interface UseSettings {
  settings: Settings | undefined;
  error: AppError | null;
  saving: boolean;
  update(patch: SettingsPatch): Promise<Settings>;
} // rejects with AppError
export function useSettings(): UseSettings; // query queryKeys.settings → getSettings; mutation writes the result with setQueryData and invalidates queryKeys.gitCli when "gitExecutable" in patch
export type ExternalTool = "editor" | "diff" | "merge";
export const TOOL_LABEL: Record<ExternalTool, string>; // editor | diff tool | merge tool
export interface UseExternalTool {
  configured: boolean;
  run(call: () => Promise<void>): Promise<void>;
} // unset → open settings at tools; rejection → error toast with Settings…
export function useExternalTool(tool: ExternalTool): UseExternalTool;
export interface TextSettingProps {
  id: string;
  label: string;
  value: string | null;
  placeholder?: string;
  hint?: string;
  onCommit(next: string | null): Promise<string | null>;
} // resolves an inline error or null
export interface SettingsDialogProps {
  section?: SettingsSection;
  onClose(): void;
  fallbackFocus: RefObject<HTMLElement | null>;
}
```

- [ ] **Step 1: Write the failing tests.** `useSettings.test.tsx`: `loads settings under the settings key`; `update writes the returned settings into the cache`; `update invalidates gitCli only when the patch has gitExecutable`; `update rejects with the AppError`. `useExternalTool.test.tsx`: `configured reflects the setting for each tool`; `run opens Settings at Tools and skips the call when unset`; `run calls through when set`; `run toasts Couldn't open <tool>: <message> with a Settings… action on rejection` (action opens settings at tools). `TextSetting.test.tsx`: `commits on blur and on Enter when changed`; `does not commit an unchanged value`; `maps an empty value to null`; `shows the inline error and keeps the text after Enter`; `shows the inline error and reverts after blur`; `resets the draft to the new value after a successful commit`. `SettingsDialog.test.tsx`: `renders the five sections in order with their headings`; `Theme radios reflect and set the appearance store`; `Font family commits on blur/Enter and empty clears`; `Font size applies in-range values on change and clamps out-of-range on blur`; `renders the two-line diff font sample`; `Clone shows Not set, Choose folder… passes the title and current directory, Clear is disabled when null`; `Choose folder… persists the picked directory and shows Saved for one second`; `tool fields commit through updateSettings with the hints shown`; `Git shows Using <path> (git version <v>) when available`; `Git shows the probe error when unavailable`; `an invalid Git executable shows Not a Git executable: … and is not stored`; `Browse… and Use PATH update the executable`; `a failed save toasts Couldn't save settings: … and reverts`; `section focuses the first control of that section`; `Keyboard shortcuts… opens the shortcuts dialog`; `Close and Escape close; a composing Escape does not`; `restores focus to the fallback`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/features/settings`.
- [ ] **Step 3: Implement** the hooks, `TextSetting`, the dialog (sections as `<section aria-labelledby>` with `<h3>`; `role="status"` status line; `scrollIntoView?.()` guard).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(ui): GR-14 settings dialog with live appearance, tools and Git executable`

### Task 14: `CommandPalette` and `useCommands`

**Files:**

- Create: `src/features/palette/useCommands.ts`, `src/features/palette/CommandPalette.tsx` (+ `.module.css`)
- Test (test role): Create `src/features/palette/useCommands.test.tsx`, `src/features/palette/CommandPalette.test.tsx` (mock `src/lib/ipc`: `listRecent`, `openRepo`, `openInEditor`, `getSettings`, `closeRepo`; seed `useRepoTabs`, `useShell.publishRepoActions`)

**Interfaces (produces):**

```ts
export type CommandGroup = "Actions" | "Open repositories" | "Recent repositories";
export interface Command {
  id: string;
  label: string;
  detail?: string;
  group: CommandGroup;
  shortcutId?: ShortcutId;
  disabledReason: string | null;
  run(): void;
}
export function useCommands(actions: ShellActions): Command[]; // order: always-actions, repo actions (when repoActions !== null), Switch to…, Open…
export interface CommandPaletteProps {
  actions: ShellActions;
  onClose(): void;
  fallbackFocus: RefObject<HTMLElement | null>;
}
```

- [ ] **Step 1: Write the failing tests.** `useCommands.test.tsx`: `lists the eight always-actions in order with the active theme marked Current`; `adds the six repository actions when repoActions is published`; `Fetch/Pull/Push carry the gate reason as disabledReason and detail`; `Switch to <name> lists every tab but the active one and activates it`; `Open <name> lists recents not already open and calls openPath`; `Open repository in editor calls openInEditor with the repository path through useExternalTool`; `shortcut ids are attached to the matching rows`. `CommandPalette.test.tsx`: `renders the combobox, listbox and three group labels`; `ranks by the query and highlights matches with <mark>`; `shows No matching commands`; `ArrowDown/Up, Home and End move aria-activedescendant`; `Enter runs the active row and closes`; `Enter on a disabled row does nothing`; `click runs a row`; `Escape clears a non-empty query first and closes on the second press`; `a composing Escape is ignored`; `caps the list at 50 rows`; `renders repository actions without calling listBranches, listRemotes or getOperationState`; `restores focus to the fallback`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/features/palette`.
- [ ] **Step 3: Implement** (`rankCommands` over the commands; `<mark>` per matched character from `fuzzyMatch`'s greedy walk — expose `fuzzyIndices(query, text): number[] | null` in `src/lib/fuzzy` if needed, tested there).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(ui): GR-14 command palette`

### Task 15: Entry points — TabBar, FileHeader, ConflictToolbar, RepoPane publication, CloneDialog default, App mounting

**Files:**

- Modify: `src/app/TabBar.tsx` (two buttons after `Start screen`, calling `useShell.getState().open(...)`), `src/features/diff/FileHeader.tsx` (props `repoId: RepoId; scope: DiffScope; isStash: boolean`; buttons after the view switcher via `useExternalTool("editor")`/`("diff")`), `src/features/diff/model/scope.ts` (`externalScope(s: DiffScope): ExternalDiffScope`), `src/features/diff/DetailPane.tsx` (`header()` passes `repoId`, `scope={file.scope}`, `isStash={file.source === "stash"}`), `src/features/merge/editor/ConflictToolbar.tsx` (props `onOpenMergeTool?(): void; mergeToolRunning?: boolean`; button on both toolbars), `src/features/merge/editor/ConflictEditor.tsx` (`useExternalTool("merge")`, `running` state around `openExternalMerge(repoId, path)`), `src/app/RepoPane.tsx` (`useEffect` publishing `RepoActions` with `syncRef`-backed callbacks and `fileHistory: () => setPicker(true)`, deps `[tab.id, path, gates.fetch, gates.pull, gates.push]`, cleanup publishes `null`), `src/features/repo/CloneDialog.tsx` (`useSettings()`; seed `parentDir` once from `defaultCloneDir` while still null; `pickFolder("Choose destination folder", parentDir ?? undefined)`), `src/app/App.tsx` (mount `SettingsDialog` and `CommandPalette` on their `dialog.kind`, `fallbackFocus={rootRef}`)
- Test (test role): Modify `src/app/TabBar.test.tsx`, `src/features/diff/FileHeader.test.tsx` (switch to `renderWithProviders`, mock `getSettings`/`openInEditor`/`openExternalDiff`), `src/features/diff/DetailPane.test.tsx`, `src/features/diff/model/scope.test.ts` (create if absent), `src/features/merge/editor/ConflictToolbar.test.tsx`, `ConflictEditor.test.tsx`, `src/app/RepoPane.test.tsx`, `src/features/repo/CloneDialog.test.tsx`, `src/app/App.test.tsx`

- [ ] **Step 1: Write the failing tests.** `TabBar.test.tsx`: `renders Command palette and Settings buttons with their titles after Start screen`; `the buttons open the palette and settings dialogs on the shell store`. `scope.test.ts`: `externalScope maps staged, unstaged and commit`. `FileHeader.test.tsx`: `shows Open in editor and External diff for unstaged and staged scopes`; `hides Open in editor for a commit scope but shows External diff`; `hides both for a stash file`; `Open in editor calls openInEditor with the path`; `External diff calls openExternalDiff with the external scope`; `an unset tool opens Settings at Tools without a backend call`; `a rejected call toasts Couldn't open diff tool: … with Settings…`. `DetailPane.test.tsx`: `passes scope and isStash to the header`. `ConflictToolbar.test.tsx`: `renders Open in merge tool on the full and placeholder toolbars when onOpenMergeTool is given`; `shows Merge tool open… disabled while running`; `omits the button without the callback`. `ConflictEditor.test.tsx`: `Open in merge tool calls openExternalMerge and shows the running label until it settles`; `an unset merge tool opens Settings at Tools`; `a failed merge tool toasts Couldn't open merge tool: …`. `RepoPane.test.tsx`: `publishes repoActions from an effect and clears them on unmount`; `republishes only when a gate or the path changes` (count `publishRepoActions` calls across re-renders); `published fetch/pull/push call the pane's sync actions`. `CloneDialog.test.tsx`: `seeds the destination from defaultCloneDir when settings load`; `does not overwrite a folder the user picked when settings load later`; `passes the current directory as defaultPath to the picker`. `App.test.tsx`: `Ctrl+, opens Settings and Escape returns focus to the app root`; `Ctrl+K opens the palette; opening Settings from it closes the palette`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/app src/features/diff src/features/merge/editor src/features/repo`.
- [ ] **Step 3: Implement** the wiring above.
- [ ] **Step 4: Run the gate** — `npm run test:coverage` (100/100/100/100), `npm run lint`, `npm run typecheck`, `npx prettier --check .`.
- [ ] **Step 5: Commit** — `feat(ui): GR-14 shell entry points: tab-bar buttons, external tool buttons, palette actions, clone default directory`

## Execution: batched agent cycles

Three cycles (the user is cost-sensitive; state dispatch counts up front):

- **Cycle 1 = Tasks 1–5** (Rust core, app layer, IPC seam): architect pre-flight (opus) + tdd-tester (sonnet) in parallel → developer (opus) → tdd-tester-coverage (sonnet) + code-reviewer (sonnet) in parallel → fix round(s) → architect sign-off. The tester writes the Task 5 TS tests from the wire shapes in this plan, so the whole cycle is one red phase.
- **Cycle 2 = Tasks 6–12** (front-end foundations): same shape. Task 9 and Task 15 both touch `RepoPane.tsx`; the developer leaves the `syncRef` in place for Task 15. `useGlobalShortcuts` opens dialogs whose components arrive in Cycle 3; its tests assert the store.
- **Cycle 3 = Tasks 13–15** (settings dialog, palette, entry points): same shape, then the final whole-branch review (opus), the lead's gate re-run and the acceptance walk.
- Expected dispatches: 5 per cycle = 15 agents, plus re-uses for fix rounds, sign-offs and the final reviewer (about 18–20 in all). Developers in parallel cycles never share a worktree; commits name explicit paths (no `add -A`, no amend, no reset).

Branch: `feature/gr-14-app-shell-settings` from `main` (d2a2116). Commits carry the noreply author email or GitHub rejects the push.

## Verification gate

From `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `cargo tree -i openssl-sys` prints nothing. From the root: `npm run test:coverage` at 100 % statements/branches/functions/lines, `npm run lint` (0 errors), `npm run typecheck`, `npx prettier --check .`. Plus the coverage agent's confirmation and the architect's explicit approval of the final implementation.

## Acceptance walk (after the gate; manual or via the WebKit inspector driver)

1. Start the app with the system in dark mode: dark tokens apply with no flash. Open Settings (Ctrl+,) → Theme `Light`: the window turns light at once; restart: still light. Back to `System`.
2. Settings → Diff → font size `16`: open a diff, the code is larger and rows are not clipped; the sample updates live. Set the family `monospace`, then clear it.
3. Settings → Clone → `Choose folder…` → pick the scratchpad. Open Clone…: `Destination` already points into the scratchpad.
4. Settings → Git → type `/usr/bin/false` → `Not a Git executable: …`; `Browse…` → pick `/usr/bin/git` → `Using /usr/bin/git (git version …)`; `Use PATH` reverts.
5. Settings → Tools → editor `xdg-open`; select a changed file; `Open in editor` launches it. Clear the editor; click again → Settings opens at Tools.
6. Ctrl+K → type `fet` → Enter: fetch runs and `Fetch complete` toasts. Ctrl+K → type a recent repository name → Enter: it opens in a new tab; Ctrl+PageUp/PageDown cycle tabs; Ctrl+W closes the current one. Any chord WebKitGTK swallows before keydown becomes a follow-up with an alternative binding (§7.2).
7. Ctrl+/ → the reference lists every row of §7.1 plus the two static rows; Escape closes it and focus returns.
8. Push with the remote unreachable: the inline `SyncMessage` shows as before (no duplicate toast); push with it reachable → `Pushed ‹branch›`.
9. Clean up: delete any cloned folder from the scratchpad, remove it from recents, reset the clone directory to `Not set`.
