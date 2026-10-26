# GR-29: One settings file — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user-configurable value, plus window size and maximized state, lives in one grouped, versioned `settings.json` that Rust owns and injects into the page before first paint; the four `localStorage` stores are deleted.

**Architecture:** `git-real-core::settings` becomes a nested `Settings` with lenient per-field loading and a nested double-option patch. `SettingsStore` (app crate) adds geometry, an init-script serialiser and the file path; `lib.rs` builds the main window itself so it can size it and inject `window.__GIT_REAL_SETTINGS__`. One zustand store (`src/lib/store/settings.ts`) hydrates from that global, writes plain preferences optimistically with 300 ms per-section coalescing, and awaits validated fields exactly as GR-14 does. Consumers switch imports; the Settings dialog gains a File section and the Git-fallback notice.

**Tech Stack:** Rust (serde, serde_json, thiserror, std only), Tauri 2.12 (`WebviewWindowBuilder`, `tauri-plugin-opener` reveal), React 18 + TypeScript, zustand (no `persist` for settings), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-26-gr29-single-settings-file-design.md`

## Global Constraints

- No new crates, no new Tauri plugins, no direct `tokio`; blocking work through `run_blocking` (the `offload_contract` test enforces this for every `#[tauri::command]`).
- `git-real-core` has no Tauri dependency and no platform assumptions.
- Only `src/lib/ipc` imports `@tauri-apps/api/core`.
- File shape: `{ "version": 2, "settings": { git, clone, tools, appearance, diff, layout, updates, window } }`, camelCase, pretty-printed two-space, written by temp-then-rename.
- Clamps: `diffFontSize` 10–24 default 13; `refsWidth` ≥ 160 default 240; `sidebarWidth` ≥ 240 default 320; window ≥ 960 × 600 default 1280 × 800.
- Copy (exact): `Couldn't save settings: ‹message›`; `Configured Git executable not found: ‹path›; using ‹effective path›`; `Directory not found: ‹path›`; `Edits made outside the app apply the next time it starts.`; button `Show in folder`; section title `File`.
- Existence of paths is checked on patch only, never on load. Load never writes the file. Quit writes the file only when geometry changed.
- Tests first in every task; `cargo test -p git-real-core` for core, `cargo test --workspace` for the app crate (run from `src-tauri`), `npm test` for the front end. Front-end coverage stays at 100 %.
- Commits: explicit paths only (`git add <files>`), never `-A`, never amend/reset/stash. Subject style `feat(GR-29): …`, `test(GR-29): …`, `refactor(GR-29): …`, `docs(GR-29): …`. Trailers from the session's attribution reminder.
- Model per dispatch is mandatory (CLAUDE.md). Suggested: Tasks 1, 4, 6, 7 → `sonnet`; Tasks 2, 3, 5, 8 → `opus`; every task reviewer → `opus`; final branch review → `fable`.

## Review Focus

Inputs the spec implies but no test would otherwise exercise, each pinned to a task below:

1. A `settings.json` whose `settings.layout.refsWidth` is a float (`240.5`) or a string (`"240"`): must become the default with a warning, not a parse failure of the whole file. → Task 2.
2. `diffFontSize: 99` in the file: in effect 24, file untouched after launch and quit. → Task 2 (clamp) and Task 3 (`set_window` no-op when unchanged).
3. A configured Git path that exists but is not executable or not Git (a text file): `locate()` returns it (it is a file); `verify` fails; the dialog shows the verify error, not the fallback notice. → Task 1.
4. The user drags a column, then quits within 300 ms: the pending patch must be flushed on `pagehide`. → Task 5.
5. `update_settings` rejects a plain preference (I/O error): the store reverts only that section and toasts once; a theme set in the same window stays. → Task 5.

---

### Task 1: `locate()` falls back to PATH; the probe reports a notice

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/git_cli.rs:59-72`
- Modify: `src-tauri/crates/git-real-core/src/error.rs:143` (remove `GitCliConfiguredMissing`)
- Modify: `src-tauri/src/error.rs:202` (remove the arm)
- Modify: `src-tauri/src/commands/repo.rs:110-117`
- Test: `src-tauri/crates/git-real-core/tests/git_cli_configured.rs`
- Test: `src-tauri/tests/commands.rs` (or the file that already tests `check_git_cli_inner`; `grep -rn check_git_cli_inner src-tauri/tests`)

**Interfaces:**

- Produces: `git_cli::locate() -> Result<PathBuf, GitError>` (unchanged signature; new behaviour), `GitCliInfo { available, path, version, error }` unchanged shape, `error` now also carries the fallback notice while `available` is `true`.

- [ ] **Step 1: Rewrite the failing core tests** in `git_cli_configured.rs`: replace `locate_fails_with_the_configured_path_in_the_message_when_it_is_gone` with
  - `locate_falls_back_to_path_when_the_configured_file_is_gone`: set a missing configured path, put `fake_git_script` dir first on `PATH` via `temp_env`-style save/restore of `PATH` in the test (`std::env::set_var` under `TEST_LOCK`), assert `locate().unwrap()` is the PATH fake.
  - `locate_fails_with_git_cli_missing_when_configured_is_gone_and_path_has_no_git`: `PATH` = empty temp dir, assert `matches!(locate(), Err(GitError::GitCliMissing))`.
  - `locate_returns_a_configured_regular_file_even_when_it_is_not_git` (Review Focus 3): configured = `non_git_script`, assert `locate().unwrap()` equals it and `verify(&it)` is `Err(GitCliInvalid { .. })`.
  - Update `locate_falls_back_to_path_when_unset`'s comment; the `GitCliConfiguredMissing` match arm disappears.
- [ ] **Step 2: Run** `cargo test -p git-real-core --test git_cli_configured` → FAIL (variant still returned / compile error on removed variant after Step 3 prep).
- [ ] **Step 3: Implement** in `git_cli.rs`: `locate()` returns the configured path when `is_file()`; otherwise logs `git: configured executable {path} not found; using PATH` at most once per distinct path (a `static WARNED: Mutex<Option<PathBuf>>`), then searches `PATH`. Delete `GitError::GitCliConfiguredMissing` and its `From` arm in `src-tauri/src/error.rs`.
- [ ] **Step 4: Run** `cargo test -p git-real-core --test git_cli_configured` → PASS; `cargo build --workspace` → no references to the removed variant remain.
- [ ] **Step 5: Write the failing app test** for the probe: `check_git_cli_reports_the_fallback_notice_when_the_configured_path_is_missing` — configured = missing path, `PATH` = dir with `common_fake_git`; assert `info.available == true`, `info.path == Some(fake)`, `info.error == Some(format!("Configured Git executable not found: {}; using {}", missing.display(), fake.display()))`. And `check_git_cli_has_no_notice_when_the_configured_path_is_used`: `error == None`.
- [ ] **Step 6: Run** `cargo test --workspace --test commands check_git_cli` → FAIL.
- [ ] **Step 7: Implement** `check_git_cli_inner()` in `repo.rs`: read `configured_path()` and `locate().ok()`; after `from_probe`, when both are `Some` and differ, set `error` to the notice (keep `available`/`version` from the probe).
- [ ] **Step 8: Run** `cd src-tauri && cargo test --workspace && cargo clippy --workspace -- -D warnings` → PASS, clean.
- [ ] **Step 9: Commit** `git add src-tauri/crates/git-real-core/src/git_cli.rs src-tauri/crates/git-real-core/src/error.rs src-tauri/crates/git-real-core/tests/git_cli_configured.rs src-tauri/src/error.rs src-tauri/src/commands/repo.rs src-tauri/tests/<probe test file>` → `feat(GR-29): configured Git executable falls back to PATH with a probe notice`

---

### Task 2: Nested `Settings` v2 in `git-real-core`

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/settings.rs` (rewrite)
- Create: `src/lib/store/settingsDefaults.json` (shared defaults fixture; the TS test in Task 5 reads the same file)
- Test: `src-tauri/crates/git-real-core/tests/settings.rs` (rewrite)

**Interfaces:**

- Produces (all `pub`, all `Serialize + Deserialize + Clone + PartialEq + Eq + Debug`, `rename_all = "camelCase"`, `Default` matching the spec §3 JSON):
  - `Settings { git: GitSettings, clone: CloneSettings, tools: ToolSettings, appearance: AppearanceSettings, diff: DiffSettings, layout: LayoutSettings, updates: UpdateSettings, window: WindowGeometry }`
  - `GitSettings { executable: Option<PathBuf> }`; `CloneSettings { default_dir: Option<PathBuf>, url_form: CloneUrlForm }`; `ToolSettings { editor: Option<String>, diff_tool: Option<String>, merge_tool: Option<String> }`; `AppearanceSettings { theme: Theme, diff_font_family: Option<String>, diff_font_size: u32 }`; `DiffSettings { mode: DiffMode, ignore_whitespace: bool }`; `LayoutSettings { refs_width: u32, sidebar_width: u32, tags_collapsed: bool, pull_requests_collapsed: bool, issues_collapsed: bool }`; `UpdateSettings { check_on_startup: bool }`; `WindowGeometry { width: u32, height: u32, maximized: bool }`
  - enums `Theme { System, Light, Dark }`, `DiffMode { Split, Unified }`, `CloneUrlForm { Https, Ssh }` (`rename_all = "lowercase"`)
  - `SettingsPatch { git: Option<GitPatch>, clone: Option<ClonePatch>, tools: Option<ToolsPatch>, appearance: Option<AppearancePatch>, diff: Option<DiffPatch>, layout: Option<LayoutPatch>, updates: Option<UpdatesPatch>, window: Option<WindowPatch> }` — nullable leaves are `Option<Option<T>>` with `double_option`; non-nullable leaves are `Option<T>`.
  - `Settings::apply(&self, &SettingsPatch) -> Result<Settings, SettingsError>` (patch mode: existence checks, clamps numerics, trims strings).
  - `SettingsWarning { field: String, message: String }`; `Settings::from_json_lenient(value: &serde_json::Value) -> (Settings, Vec<SettingsWarning>)` (load mode: per-field fallback, clamps, no existence checks).
  - `pub const SETTINGS_VERSION: u32 = 2;` `SettingsFile::current(Settings) -> SettingsFile`; `SettingsFile::parse(text: &str) -> Result<(Settings, Vec<SettingsWarning>), SettingsFileError>` with `SettingsFileError { Corrupt(String), UnknownVersion(u32) }`.
  - Constants: `DIFF_FONT_MIN = 10`, `DIFF_FONT_MAX = 24`, `REFS_MIN = 160`, `SIDEBAR_MIN = 240`, `WINDOW_MIN = (960, 600)`, `WINDOW_DEFAULT = (1280, 800)`; `WindowGeometry::clamp_to_min(self) -> WindowGeometry`.
  - `SettingsError` keeps `RelativePath(&'static str)` and `NotADirectory(PathBuf)`.

- [ ] **Step 1: Write the defaults fixture** `src/lib/store/settingsDefaults.json` exactly as spec §3's JSON `settings` object (no `version` wrapper).
- [ ] **Step 2: Write the failing tests** (rewrite `tests/settings.rs`):
  - `default_settings_equal_the_shared_fixture`: `serde_json::to_value(Settings::default())` equals the parsed fixture at `concat!(env!("CARGO_MANIFEST_DIR"), "/../../../src/lib/store/settingsDefaults.json")`.
  - `file_round_trips_version_2`: `SettingsFile::current(s)` → JSON → `parse` gives `(s, [])`.
  - `file_version_1_is_unknown`: GR-14 flat v1 text → `Err(UnknownVersion(1))`; `file_corrupt_is_corrupt`: `"{not json"` → `Err(Corrupt(_))`.
  - `lenient_unknown_theme_falls_back_and_keeps_the_rest`: `{"appearance":{"theme":"sepia","diffFontSize":16}}` → theme `System`, size 16, one warning with `field == "appearance.theme"`.
  - `lenient_clamps_font_size_and_widths`: `diffFontSize: 99` → 24; `refsWidth: 10` → 160; `sidebarWidth: 10` → 240; `window: {width: 1, height: 1}` → 960 × 600; four warnings.
  - `lenient_wrong_type_falls_back_per_field` (Review Focus 1): `refsWidth: 240.5` and `refsWidth: "240"` each → 240 with a warning; other layout fields intact.
  - `lenient_keeps_a_relative_path_out_but_a_missing_absolute_path_in`: `clone.defaultDir: "rel/dir"` → `None` + warning; `clone.defaultDir: "/definitely/missing"` → kept, no warning; same for `git.executable`.
  - `lenient_ignores_unknown_keys_without_warning`.
  - `patch_absent_keeps_null_clears_value_sets` per nullable leaf (`tools.editor`), `patch_non_nullable_leaf_absent_keeps` (`diff.mode`).
  - `apply_rejects_a_missing_clone_dir_and_a_relative_git_path` (existing behaviour), `apply_clamps_font_size_and_widths`, `apply_trims_tool_commands_and_maps_empty_to_none`.
  - `window_clamp_to_min`.
- [ ] **Step 3: Run** `cargo test -p git-real-core --test settings` → FAIL to compile.
- [ ] **Step 4: Implement** `settings.rs`. `from_json_lenient` reads each leaf by path with one generic helper `fn leaf<T: DeserializeOwned>(obj: &Value, section: &str, key: &str, default: T, warnings: &mut Vec<SettingsWarning>) -> T`, then runs the same `normalise(mode)` the patch path uses (`enum Mode { Load, Patch }`) so clamps and trims are shared and only `Patch` checks existence.
- [ ] **Step 5: Run** `cargo test -p git-real-core` → PASS.
- [ ] **Step 6: Commit** `git add src-tauri/crates/git-real-core/src/settings.rs src-tauri/crates/git-real-core/tests/settings.rs src/lib/store/settingsDefaults.json` → `feat(GR-29): nested settings v2 with lenient per-field loading`

---

### Task 3: `SettingsStore` v2: warnings, geometry, init script, path; commands

**Files:**

- Modify: `src-tauri/src/settings_store.rs`
- Modify: `src-tauri/src/commands/settings.rs` (add `reveal_settings_file`, `check_settings_health`)
- Modify: `src-tauri/src/commands/tools.rs:24-27,58-61,80-83` (`.tools.editor` etc.)
- Modify: `src-tauri/src/lib.rs:43-` (register the two commands only; window work is Task 4)
- Test: `src-tauri/tests/settings_store.rs` (update + extend), `src-tauri/tests/tools_commands.rs` (nested field access in fixtures)

**Interfaces:**

- Consumes: Task 2 types.
- Produces:
  - `SettingsStore::load(path: PathBuf) -> Self` (logs each `SettingsWarning` as `settings: {field}: {message}`; version ≠ 2 logs `settings: ignoring version {n} in {path}`).
  - `get() -> Settings`, `update(&SettingsPatch) -> Result<Settings, AppError>` (unchanged flow, field now `next.git.executable`).
  - `set_window(&self, geometry: WindowGeometry) -> io::Result<bool>`: `Ok(false)` and no write when equal to the stored `window`; otherwise stores, saves, `Ok(true)`.
  - `path(&self) -> &Path`.
  - `to_init_script(&self) -> String`: `window.__GIT_REAL_SETTINGS__=<json>;` where `<json>` is `serde_json::to_string(&settings)` with every `<` replaced by `<`.
  - `SettingsHealth { default_clone_dir_missing: bool }` (`Serialize`, camelCase) and `check_settings_health_inner(store) -> SettingsHealth` (`true` when `clone.default_dir` is `Some` and `!is_dir()`).
  - Commands `reveal_settings_file(app: AppHandle, settings: State<Arc<SettingsStore>>) -> Result<(), AppError>` (calls `tauri_plugin_opener::reveal_item_in_dir(store.path())` inside `run_blocking`; an opener error maps to `AppErrorKind::Io` with the error's text) and `check_settings_health(settings) -> Result<SettingsHealth, AppError>`.

- [ ] **Step 1: Write the failing tests** in `tests/settings_store.rs`: update fixtures to the nested shape and `"version": 2`; change the "unknown version" case to version 1; add
  - `load_logs_and_keeps_the_rest_when_one_field_is_invalid`: file with `"appearance":{"theme":"sepia"}` and `"layout":{"refsWidth":300}` → theme default, `refs_width == 300`.
  - `set_window_writes_only_when_changed` (Review Focus 2): fresh store, `set_window(default)` → `Ok(false)` and the file does not exist; `set_window(1000×700)` → `Ok(true)`, file has it; same call again → `Ok(false)` and the file mtime is unchanged.
  - `to_init_script_assigns_the_global_and_escapes_lt`: store with `tools.editor = Some("</script><b>")` → script starts with `window.__GIT_REAL_SETTINGS__={` and contains `</script` and no literal `</script`.
  - `check_settings_health_flags_a_missing_clone_dir`: `None` → `false`; existing temp dir → `false`; `/definitely/missing` written straight into the file (bypassing `update`) → `true`.
  - `path_returns_the_file_location`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test --workspace --test settings_store` → FAIL.
- [ ] **Step 3: Implement** the store and commands; update `tools.rs` field access; register `commands::settings::reveal_settings_file` and `commands::settings::check_settings_health` in `generate_handler!`.
- [ ] **Step 4: Run** `cargo test --workspace && cargo clippy --workspace -- -D warnings` → PASS (the `offload_contract` test confirms both new commands use `run_blocking`).
- [ ] **Step 5: Commit** `git add src-tauri/src/settings_store.rs src-tauri/src/commands/settings.rs src-tauri/src/commands/tools.rs src-tauri/src/lib.rs src-tauri/tests/settings_store.rs src-tauri/tests/tools_commands.rs` → `feat(GR-29): settings store v2 with window geometry, init script, reveal and health commands`

---

### Task 4: Main window built in Rust with restored geometry and the init script

**Files:**

- Create: `src-tauri/src/main_window.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod main_window;` `setup` builds the window; `on_window_event`)
- Modify: `src-tauri/tauri.conf.json` (`app.windows: []`)
- Test: `src-tauri/tests/main_window.rs`

**Interfaces:**

- Consumes: `SettingsStore::{get, set_window, to_init_script}`, `WindowGeometry`, `WINDOW_MIN`, `WINDOW_DEFAULT` from Task 2/3.
- Produces:
  - `pub const LABEL: &str = "main";` `pub const TITLE: &str = "Git Real";`
  - `pub fn initial_geometry(settings: &Settings) -> WindowGeometry` (= `settings.window.clamp_to_min()`).
  - `pub fn logical_geometry(physical: (u32, u32), scale: f64, maximized: bool, stored: &WindowGeometry) -> WindowGeometry`: when `maximized`, `stored` with `maximized: true`; else `round(physical / scale)` clamped, `maximized: false`.
  - `pub fn build(app: &AppHandle, store: &SettingsStore) -> tauri::Result<WebviewWindow>`: `WebviewWindowBuilder::new(app, LABEL, WebviewUrl::default()).title(TITLE).inner_size(w, h).min_inner_size(960.0, 600.0).maximized(m).resizable(true).decorations(true).initialization_script(store.to_init_script()).build()`.
  - `pub fn on_close_requested(window: &WebviewWindow, store: &SettingsStore)`: reads `is_maximized`, `inner_size`, `scale_factor`, calls `logical_geometry`, then `store.set_window`; logs an `Err`.

- [ ] **Step 1: Write the failing tests** in `tests/main_window.rs` for the two pure functions: `initial_geometry_clamps_to_min` (1×1 → 960×600), `logical_geometry_divides_by_scale_and_rounds` ((2560, 1600), 2.0 → 1280×800), `logical_geometry_keeps_the_stored_size_when_maximized`, `logical_geometry_clamps_small_sizes`, `label_is_main_and_title_is_git_real`.
- [ ] **Step 2: Run** `cargo test --workspace --test main_window` → FAIL to compile.
- [ ] **Step 3: Implement** `main_window.rs`; in `lib.rs` `setup`, after `app.manage(settings)`, call `main_window::build(app.handle(), &settings)?`; add `.on_window_event(|window, event| if let WindowEvent::CloseRequested { .. } = event { … main_window::on_close_requested(window, &store) })` (the store comes from `window.state::<Arc<SettingsStore>>()`). Set `"windows": []` in `tauri.conf.json`; the capability file already names `"main"`.
- [ ] **Step 4: Run** `cargo test --workspace && cargo clippy --workspace -- -D warnings` → PASS. Then `npm run tauri dev` once, confirm the window opens at 1280×800, resize, quit, relaunch at the new size, and the file holds `window` (manual, note the result in the commit body).
- [ ] **Step 5: Commit** `git add src-tauri/src/main_window.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/tests/main_window.rs` → `feat(GR-29): main window built in Rust with restored geometry and settings init script`

---

### Task 5: Front-end settings store and IPC types

**Files:**

- Modify: `src/lib/ipc/types.ts:131-141`
- Modify: `src/lib/ipc/settings.ts` (add `revealSettingsFile`, `checkSettingsHealth`)
- Modify: `src/lib/query/keys.ts` (replace `settings` with `settingsHealth: ["settingsHealth"]`)
- Create: `src/global.d.ts` (`interface Window { __GIT_REAL_SETTINGS__?: unknown }`)
- Create: `src/lib/store/settings.ts`, `src/lib/store/settingsActions.ts`
- Test: `src/lib/store/settings.test.ts`, `src/lib/store/settingsActions.test.ts`, `src/lib/ipc/settings.test.ts` (extend if it exists)

**Interfaces:**

- Produces in `types.ts`: `ThemePref`, `DiffMode`, `CloneUrlForm` (string unions), `Settings` nested exactly as spec §3, `SettingsPatch = { [S in keyof Settings]?: Partial<Settings[S]> }`, `SettingsHealth { defaultCloneDirMissing: boolean }`.
- Produces in `ipc/settings.ts`: `revealSettingsFile(): Promise<void>` (`invoke("reveal_settings_file")`), `checkSettingsHealth(): Promise<SettingsHealth>`.
- Produces in `store/settings.ts`:
  - `DEFAULT_SETTINGS: Settings`; `DIFF_FONT_MIN = 10`, `DIFF_FONT_MAX = 24`, `DIFF_FONT_DEFAULT = 13`, `REFS_DEFAULT = 240`, `SIDEBAR_DEFAULT = 320`.
  - `readInjectedSettings(): Settings` — `window.__GIT_REAL_SETTINGS__` when it is an object, else `DEFAULT_SETTINGS`; never throws.
  - `useSettings` zustand store: `{ settings: Settings; setPref(patch: SettingsPatch): void; save(patch: SettingsPatch): Promise<Settings>; reconcile(): Promise<void>; flush(): Promise<void> }`.
  - `setPref`: merges locally at once; queues the patch per top-level section; a 300 ms timer per section sends the merged patch through `updateSettings`; reply replaces `settings`; rejection reverts that section to the last server-known value and toasts `Couldn't save settings: ‹message›` once per rejection.
  - `save`: awaits `updateSettings(patch)`, replaces `settings`, rethrows the error untouched (no toast; the dialog decides).
  - `reconcile`: `getSettings()` once, replaces `settings`; errors swallowed.
  - `flush`: sends every pending section now; awaits.
  - `installFlushOnPagehide(): () => void` adds `pagehide` and `beforeunload` listeners that call `flush()`.
- Produces in `store/settingsActions.ts` (module functions, each one `setPref` call): `setTheme(ThemePref)`, `setDiffFontFamily(string | null)` (trim, empty → null), `setDiffFontSize(number)` (ignore NaN; round; clamp 10–24), `setDiffMode(DiffMode)`, `setIgnoreWhitespace(boolean)`, `setRefsWidth(number)`, `setSidebarWidth(number)`, `resetWidth(column: "refs" | "sidebar")`, `setTagsCollapsed(boolean)`, `setPullRequestsCollapsed(boolean)`, `setIssuesCollapsed(boolean)`, `setCloneUrlForm(CloneUrlForm)`, `setCheckOnStartup(boolean)`.

- [ ] **Step 1: Write the failing tests** (`vi.mock("../ipc")` for `getSettings`/`updateSettings`, `vi.useFakeTimers()`):
  - `defaults equal the shared fixture`: `import fixture from "./settingsDefaults.json"`; `expect(DEFAULT_SETTINGS).toEqual(fixture)`.
  - `readInjectedSettings uses the global when present and defaults otherwise`; `…ignores a non-object global`.
  - `setPref applies locally at once and sends one coalesced patch per section after 300 ms`: two `setRefsWidth` calls → one `updateSettings({ layout: { refsWidth: <last> } })`.
  - `setPref reply replaces state (server clamp wins)`.
  - `setPref rejection reverts only that section and toasts once` (Review Focus 5): set theme (resolve) and a width (reject) → theme kept, width reverted, one toast with the exact copy.
  - `flush sends pending patches immediately`; `installFlushOnPagehide flushes on pagehide` (Review Focus 4).
  - `save awaits, replaces state and rethrows`.
  - `reconcile replaces state from getSettings and swallows errors`.
  - Actions: `setDiffFontSize clamps 9→10, 25→24, rounds 13.6→14, ignores NaN`; `setDiffFontFamily maps "" and "  " to null and trims`; `resetWidth restores 240 / 320`.
- [ ] **Step 2: Run** `npm test -- src/lib/store/settings` → FAIL.
- [ ] **Step 3: Implement** types, wrappers, `global.d.ts`, the store and the actions.
- [ ] **Step 4: Run** `npm test -- src/lib/store/settings src/lib/ipc && npm run typecheck` → store tests PASS; typecheck will still fail in consumers (expected until Tasks 6–8). Run `npm run lint` on the new files only.
- [ ] **Step 5: Commit** `git add src/lib/ipc/types.ts src/lib/ipc/settings.ts src/lib/query/keys.ts src/global.d.ts src/lib/store/settings.ts src/lib/store/settingsActions.ts src/lib/store/settings.test.ts src/lib/store/settingsActions.test.ts` → `feat(GR-29): front-end settings store hydrated from the injected settings`

---

### Task 6: Migrate layout, diff and clone-form consumers; delete `layoutPrefs` and `diffPrefs`

**Files:**

- Modify: `src/app/layout.ts:1-3` (import `LayoutColumn` type locally: `export type LayoutColumn = "refs" | "sidebar"`; re-export `REFS_DEFAULT`, `SIDEBAR_DEFAULT` from `../lib/store/settings`)
- Modify: `src/app/RepoPane.tsx:27,54-58`
- Modify: `src/features/diff/DetailPane.tsx:4,61`, `DiffViewer.tsx:4`, `DiffToolbar.tsx:3`, `model/rows.ts:2` (type import → `../../lib/ipc`)
- Modify: `src/features/tags/TagsPanel.tsx:6,44,166`, `src/features/hosting/PullRequestsPanel.tsx:5,35,154`, `src/features/hosting/IssuesPanel.tsx:4,34,164`
- Modify: `src/features/repo/CloneDialog.tsx:7,56`, `src/features/hosting/RepoBrowser.tsx:4-5,53-54`, `src/features/hosting/cloneUrlFor.ts:2`
- Delete: `src/lib/store/layoutPrefs.ts`, `layoutPrefs.test.ts`, `diffPrefs.ts`, `diffPrefs.test.ts`
- Test: the consumers' existing tests (`RepoPane.test.tsx`, `layout.test.ts`, `DetailPane*.test.tsx`, `DiffToolbar.test.tsx`, `DiffViewer.test.tsx`, `TagsPanel.test.tsx`, `PullRequestsPanel.test.tsx`, `IssuesPanel.test.tsx`, `CloneDialog.test.tsx`, `RepoBrowser.test.tsx`)

**Interfaces:**

- Consumes: `useSettings`, actions from Task 5. Pattern: `const refsWidth = useSettings((s) => s.settings.layout.refsWidth)`; `onChange={setRefsWidth}`; `onClick={() => setTagsCollapsed(!collapsed)}`.
- Test reset pattern (replaces `useLayoutPrefs.setState(…)`): `useSettings.setState({ settings: DEFAULT_SETTINGS })` in `beforeEach`; `vi.mock("../../lib/ipc")` already present in most of these files gets `updateSettings: vi.fn().mockImplementation(async () => useSettings.getState().settings)`.

- [ ] **Step 1: Update the tests first**: in each listed test file replace store imports/resets with the pattern above and assert through `useSettings.getState().settings.layout.*` / `.diff.*` where they asserted the old stores. Add one assertion per panel that toggling calls `updateSettings` with `{ layout: { tagsCollapsed: false } }` (etc.) after `vi.advanceTimersByTime(300)`.
- [ ] **Step 2: Run** `npm test -- RepoPane layout DetailPane DiffToolbar DiffViewer TagsPanel PullRequestsPanel IssuesPanel CloneDialog RepoBrowser` → FAIL.
- [ ] **Step 3: Migrate** the consumers; delete the two stores and their tests.
- [ ] **Step 4: Run** the same test selection → PASS; `grep -rn "layoutPrefs\|diffPrefs" src` → no matches.
- [ ] **Step 5: Commit** `git add <every touched/deleted path>` → `refactor(GR-29): layout and diff preferences read the settings store`

---

### Task 7: Migrate appearance, palette and update-check consumers; `updateState`; bootstrap from the injected settings

**Files:**

- Modify: `src/app/applyAppearance.ts` (own `DEFAULT_MONO`; `bootstrapAppearance()` applies `useSettings.getState().settings.appearance`, subscribes to `useSettings`, calls `installFlushOnPagehide()` and `void useSettings.getState().reconcile()`)
- Modify: `src/main.tsx` (unchanged call; verify)
- Modify: `src/features/palette/useCommands.ts:4-5,37-38`
- Modify: `src/features/settings/AboutSettings.tsx:6,16-17`
- Modify: `src/app/useUpdateCheck.ts:3,15,29,41`
- Create: `src/lib/store/updateState.ts` (`persist`, key `git-real.updateState`, `{ lastCheckedAt: number | null; markChecked(at: number): void }`, `CHECK_INTERVAL_MS`, `STARTUP_DELAY_MS` move here)
- Delete: `src/lib/store/appearancePrefs.ts`, `appearancePrefs.test.ts`, `updatePrefs.ts`, `updatePrefs.test.ts`
- Test: `src/app/applyAppearance.test.ts`, `src/app/useUpdateCheck.test.ts`, `src/features/palette/useCommands.test.tsx`, `CommandPalette.test.tsx`, `src/features/settings/AboutSettings.test.tsx`; create `src/lib/store/updateState.test.ts`

**Interfaces:**

- Consumes: Task 5. `bootstrapAppearance(): () => void` keeps its name and return.
- Produces: `useUpdateState` store as above.

- [ ] **Step 1: Update/write the failing tests**: `applyAppearance.test.ts` "bootstrap applies the injected theme before first render" sets `window.__GIT_REAL_SETTINGS__ = { …DEFAULT_SETTINGS, appearance: { theme: "dark", … } }` before `vi.resetModules()` + dynamic import, asserts `data-theme="dark"` right after `bootstrapAppearance()`; "bootstrap re-applies on store change"; "bootstrap calls reconcile once" (`getSettings` mocked, called once). `updateState.test.ts`: default null, `markChecked`, persists under `git-real.updateState`. `useUpdateCheck.test.ts`: reads `checkOnStartup` from `useSettings` and `lastCheckedAt` from `useUpdateState`. `AboutSettings.test.tsx`: toggling calls `updateSettings({ updates: { checkOnStartup: false } })` after 300 ms. Palette tests: theme commands call `setTheme` → `updateSettings({ appearance: { theme: … } })`.
- [ ] **Step 2: Run** `npm test -- applyAppearance useUpdateCheck useCommands CommandPalette AboutSettings updateState` → FAIL.
- [ ] **Step 3: Migrate**; delete the two stores.
- [ ] **Step 4: Run** the selection → PASS; `grep -rn "appearancePrefs\|updatePrefs" src` → no matches.
- [ ] **Step 5: Commit** → `refactor(GR-29): appearance and update preferences read the settings store; lastCheckedAt moves to updateState`

---

### Task 8: Settings dialog on the store: nested fields, Git notice, clone-dir alert, File section; remove the react-query hook

**Files:**

- Modify: `src/features/settings/SettingsDialog.tsx`
- Modify: `src/features/settings/useExternalTool.ts:1-5,16-20,30-31` (`settings.tools[key]`, keys `editor | diffTool | mergeTool`)
- Modify: `src/features/repo/CloneDialog.tsx:75` (`useSettings((s) => s.settings.clone.defaultDir)`)
- Modify: `src/lib/store/shell.ts:4` (`SettingsSection` adds `"file"`)
- Modify: `src/lib/ipc/settings.ts` (add `settingsFilePath`), `src/lib/query/keys.ts` (add `settingsPath: ["settingsPath"]`)
- Modify: `src-tauri/src/commands/settings.rs` (add `settings_file_path`), `src-tauri/src/lib.rs` (register it)
- Delete: `src/features/settings/useSettings.ts`, `useSettings.test.tsx`
- Test: `src/features/settings/SettingsDialog.test.tsx`, `useExternalTool.test.tsx`, `CloneDialog.test.tsx`

**Interfaces:**

- Consumes: Task 5 store (`save` for Git/clone/tools, actions for appearance), `checkGitCli`, `checkSettingsHealth`, `revealSettingsFile`, `queryKeys.settingsHealth`, `queryKeys.gitCli`.
- Behaviour pinned:
  - `GitSettings`: `save` → `useSettings.getState().save({ git: { executable: next } })`; on success `invalidateQueries(queryKeys.gitCli)`; `gitCliInvalid` → inline `Not a Git executable: ‹message›` (unchanged). Render: when `git.data.available` show `Using ‹path› (git version ‹v›)`; **additionally** when `git.data.error` is non-null render `<p role="alert">{error}</p>` regardless of `available`.
  - `CloneSettings`: `save({ clone: { defaultDir } })`; after success `invalidateQueries(queryKeys.settingsHealth)`; `useQuery(settingsHealth)`; when `defaultCloneDirMissing` render `<p role="alert">Directory not found: ‹path›</p>` under the value.
  - `ToolsSettings`: `save({ tools: { [key]: next } })` with `key: "editor" | "diffTool" | "mergeTool"`.
  - `AppearanceSettings`/`DiffSettings`: read `s.settings.appearance.*`, call `setTheme`/`setDiffFontFamily`/`setDiffFontSize` from `settingsActions`; the size-draft logic stays, reading the committed size from the store.
  - New `FileSettings` (`Section id="file" name="File"`): `<span className={styles.value}>{path}</span>` where `path` comes from a new `useQuery({ queryKey: queryKeys.settingsPath, queryFn: settingsFilePath })` — **add** IPC `settingsFilePath(): Promise<string>` (`invoke("settings_file_path")`) and the matching Rust command `settings_file_path(settings) -> Result<String, AppError>` (`store.path().to_string_lossy()`, via `run_blocking`) in `commands/settings.rs` + `generate_handler!`; a `Show in folder` button calling `revealSettingsFile()` (rejection → error toast `Couldn't open folder: ‹message›`); the hint paragraph with the exact copy.
- [ ] **Step 1: Update/write the failing tests** in `SettingsDialog.test.tsx` (fixtures become nested `DEFAULT_SETTINGS`; `vi.mock` adds `checkSettingsHealth`, `revealSettingsFile`, `settingsFilePath`): theme click → `updateSettings({ appearance: { theme: "dark" } })` after 300 ms; Git field save → `updateSettings({ git: { executable: "/usr/bin/git" } })` and `checkGitCli` re-queried; "shows the fallback notice while available" (`available: true, error: "Configured Git executable not found: /x; using /usr/bin/git"` → alert text visible and `Using /usr/bin/git` visible); "shows Directory not found under the clone field when health says missing"; "File section shows the path and Show in folder reveals"; "`section=\"file\"` focuses the File section". `useExternalTool.test.tsx`: configured when `settings.tools.editor !== null`. `CloneDialog.test.tsx`: seeds from `settings.clone.defaultDir`.
- [ ] **Step 2: Run** `npm test -- SettingsDialog useExternalTool CloneDialog` → FAIL.
- [ ] **Step 3: Implement** the dialog changes, the two small IPC/Rust additions (`settings_file_path`), delete the hook and its test.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint && npm run build` and `cd src-tauri && cargo test --workspace && cargo clippy --workspace -- -D warnings` → all PASS; coverage report shows 100 % for `src/lib/store/settings*.ts` and `src/features/settings/*`.
- [ ] **Step 5: Commit** → `feat(GR-29): settings dialog on the settings store with Git fallback notice, clone-dir alert and File section`

---

### Task 9: Docs and acceptance

**Files:**

- Modify: `docs/superpowers/specs/2026-10-26-gr29-single-settings-file-design.md` (status → implemented; record any deviation)
- Modify: `src-tauri/crates/git-real-core/src/settings.rs` module doc (remove "Appearance preferences live in the front end's localStorage").

- [ ] **Step 1:** Run the acceptance walk of spec §10 steps 1–3, 5, 6 on the dev machine (`npm run tauri dev`), step 4 by renaming the configured Git path in the file to a missing one. Record results in the spec under a new "Walk results" heading. Any failure goes back to the owning task before this one completes.
- [ ] **Step 2:** `npm run lint` (prettier covers the markdown) → clean.
- [ ] **Step 3: Commit** `git add docs/superpowers/specs/2026-10-26-gr29-single-settings-file-design.md src-tauri/crates/git-real-core/src/settings.rs` → `docs(GR-29): spec implemented status and walk results`

---

## Self-review notes

- Spec §3 (file, rules, clamps, lenient load) → Task 2; §3 writing rules → Task 3; §4 init script/store/tiers/flush/reload → Tasks 3, 4, 5, 7; §4 Git fallback → Task 1 (+ dialog in Task 8); §5 geometry → Tasks 3, 4; §6 no migration → nothing to build (stores deleted in 6, 7); §7 dialog → Task 8; §8 Rust surface → Tasks 2, 3, 4, 8 (`settings_file_path` is an addition the spec's "Rust knows the path; the UI never does" did not foresee: the dialog has to display the path, so a read-only command returns it; `reveal` still happens in Rust); §9 tests → distributed; §10 walk → Task 9.
- Names used across tasks: `useSettings` (store, Task 5) replaces the deleted hook of the same name in `features/settings` (Task 8) — call sites import from `../../lib/store/settings`. `setPref`/`save`/`reconcile`/`flush` consistent in 5, 7, 8. `WindowGeometry`, `set_window`, `to_init_script`, `path()` consistent in 2, 3, 4. `SettingsHealth.defaultCloneDirMissing` consistent in 3, 5, 8.
