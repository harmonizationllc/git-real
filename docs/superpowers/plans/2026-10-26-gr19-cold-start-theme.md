# GR-19 Cold-Start Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cold start of Git Real paints in the stored theme from the first frame the compositor shows: no white webview frame, no frame in the other colour scheme.

**Architecture:** Rust owns the first frame. `main_window::build` builds the window hidden, sets the window/webview background colour from the stored theme (desktop scheme via `WebviewWindow::theme()` for `system`), then shows it. The init script pre-applies `data-theme` for `dark`/`light` before the page's first layout. The colour follows later theme changes (settings patch, desktop `ThemeChanged` while on `system`). The pure theme→RGB mapping lives in `git-real-core`.

**Tech Stack:** Tauri 2.12 (`WebviewWindowBuilder::visible/background_color`, `WebviewWindow::theme/set_background_color/show`, `WindowEvent::ThemeChanged`), Rust 2024, Vitest for the one front-end test.

**Spec:** `docs/superpowers/specs/2026-10-26-gr19-cold-start-theme-design.md` (§1 is the evidence, §3 the design, §5 the acceptance walk, §7 the owner's rulings).

## Global Constraints

- No new crate or npm dependency; no change to the CSP or to the `settings.json` shape (spec §2 goal 3).
- Background RGB values are exactly `--color-bg` from `src/styles/tokens.css`: dark `#1e1e1e` = `(30, 30, 30)`, light `#f6f6f6` = `(246, 246, 246)`, alpha 255.
- `git-real-core` stays Tauri-free and platform-neutral; `tauri::Theme`/`Color` conversions live in `src-tauri`.
- The window is never shown before its background colour is set (spec §3.1); nothing in the fix may delay the window beyond one portal round-trip (spec §2 anti-goal).
- Nothing in §3.3 blocks the IPC thread or writes `settings.json`.
- The developer never edits test files; tests come from the test role first (project TDD policy). Commits use explicit paths, no `add -A`, no amend/reset/stash (shared worktrees).
- Gate before the final review: `npm run lint`, `npm run typecheck`, `npm test`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`, front-end coverage still 100 %.

## Review Focus

1. **Portal absent or failing** (no `xdg-desktop-portal`, or `theme()` returns `Err`): stored `system` must resolve to the light background, matching the CSS default when `prefers-color-scheme` is not dark; the app must still start. Pinned in Task 2 (`background_color(System, None)` test).
2. **A settings patch that does not touch the theme** (font size, layout) must not touch the window at all, so a patch arriving during shutdown cannot fail on a missing window. Pinned in Task 2 (`theme_changed` tests).
3. **Desktop scheme flips while the stored theme is explicit** (`dark`/`light`): the explicit theme wins and the background does not change. Pinned in Task 2 (`follows_desktop` tests).
4. **`document.documentElement` absent at document start** on some WebKit: the init script must not throw (the page would lose `window.__GIT_REAL_SETTINGS__` too). Pinned in Task 1 (the statement is guarded by `if (document.documentElement)`).
5. **Stored `maximized: true` with the hidden→show flow**: the window must still open maximized and focused. Not unit-testable; pinned in Task 4 walk step 4.

---

### Task 1: Pure mapping in core and `data-theme` in the init script

**Files:**
- Modify: `src-tauri/crates/git-real-core/src/settings.rs` (near `pub enum Theme`, line ~168)
- Modify: `src-tauri/src/settings_store.rs:109-116` (`to_init_script`)
- Test: `src-tauri/crates/git-real-core/tests/settings.rs`
- Test: `src-tauri/tests/settings_store.rs`

**Interfaces:**
- Consumes: `git_real_core::settings::Theme { System, Light, Dark }` (exists).
- Produces:
  - `pub const BG_DARK_RGB: (u8, u8, u8) = (30, 30, 30);` and `pub const BG_LIGHT_RGB: (u8, u8, u8) = (246, 246, 246);` in `git_real_core::settings`, each with a doc comment naming `src/styles/tokens.css --color-bg`.
  - `pub fn background_rgb(theme: Theme, desktop_dark: bool) -> (u8, u8, u8)` in `git_real_core::settings`: `Dark` → `BG_DARK_RGB`; `Light` → `BG_LIGHT_RGB`; `System` → `BG_DARK_RGB` when `desktop_dark`, else `BG_LIGHT_RGB`.
  - `SettingsStore::to_init_script(&self) -> String` (existing name) now returns `window.__GIT_REAL_SETTINGS__=<json>;` followed, for `Dark`/`Light` only, by exactly `if(document.documentElement)document.documentElement.setAttribute("data-theme","dark");` (or `"light"`). For `System` the output is unchanged from today.

- [ ] **Step 1: Write the failing core tests** in `src-tauri/crates/git-real-core/tests/settings.rs`

```rust
#[test]
fn background_rgb_matches_tokens_css() {
    use git_real_core::settings::{BG_DARK_RGB, BG_LIGHT_RGB, Theme, background_rgb};
    assert_eq!(BG_DARK_RGB, (30, 30, 30));
    assert_eq!(BG_LIGHT_RGB, (246, 246, 246));
    assert_eq!(background_rgb(Theme::Dark, false), (30, 30, 30));
    assert_eq!(background_rgb(Theme::Dark, true), (30, 30, 30));
    assert_eq!(background_rgb(Theme::Light, true), (246, 246, 246));
    assert_eq!(background_rgb(Theme::System, true), (30, 30, 30));
    assert_eq!(background_rgb(Theme::System, false), (246, 246, 246));
}
```

- [ ] **Step 2: Write the failing store tests** in `src-tauri/tests/settings_store.rs` (use the file's existing helpers to build a `SettingsStore` with a given theme; `update` with a `SettingsPatch` setting `appearance.theme` is enough)

```rust
#[test]
fn init_script_pre_applies_an_explicit_theme() {
    // store with theme dark
    let script = store.to_init_script();
    assert!(script.starts_with("window.__GIT_REAL_SETTINGS__={"));
    assert!(script.ends_with(
        r#";if(document.documentElement)document.documentElement.setAttribute("data-theme","dark");"#
    ));
    // store with theme light
    assert!(store_light.to_init_script().ends_with(r#".setAttribute("data-theme","light");"#));
}

#[test]
fn init_script_leaves_system_theme_to_the_page() {
    // store with the default (system) theme
    let script = store.to_init_script();
    assert!(script.ends_with("};"));
    assert!(!script.contains("data-theme"));
}
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `cd src-tauri && cargo test -p git-real-core --test settings background_rgb` and `cargo test --test settings_store init_script`
Expected: compile error (`background_rgb` not found) and the two `init_script` tests FAIL.

- [ ] **Step 4: Implement `BG_DARK_RGB`, `BG_LIGHT_RGB` and `background_rgb` in `git-real-core/src/settings.rs`**

- [ ] **Step 5: Extend `to_init_script` in `settings_store.rs`** to append the guarded `setAttribute` statement for `Dark`/`Light`. The existing `<` escaping stays on the JSON part; the appended statement contains no user data.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test -p git-real-core && cargo test --test settings_store`
Expected: all PASS, including the existing escaping test.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/crates/git-real-core/src/settings.rs src-tauri/crates/git-real-core/tests/settings.rs src-tauri/src/settings_store.rs src-tauri/tests/settings_store.rs
git commit -m "feat(GR-19): theme background mapping and data-theme in the init script"
```

---

### Task 2: Window background at launch and on theme changes

**Files:**
- Modify: `src-tauri/src/main_window.rs` (`build`, line ~41; new fns)
- Modify: `src-tauri/src/commands/settings.rs` (`update_settings`, `update_settings_inner`)
- Modify: `src-tauri/src/lib.rs:45-54` (`on_window_event`)
- Test: `src-tauri/tests/main_window.rs`
- Test: `src-tauri/tests/settings_store.rs` (the `update_settings_inner` tests live here today)

**Interfaces:**
- Consumes: Task 1's `background_rgb`; `SettingsStore::get()`, `SettingsStore::update()`.
- Produces, in `main_window`:
  - `pub fn background_color(theme: Theme, desktop: Option<tauri::Theme>) -> tauri::webview::Color` — `Color(r, g, b, 255)` from `background_rgb(theme, desktop == Some(tauri::Theme::Dark))`. `None` means "unknown", which maps to light.
  - `pub fn follows_desktop(theme: Theme) -> bool` — `true` only for `Theme::System`.
  - `pub fn apply_background(window: &WebviewWindow, theme: Theme) -> tauri::Result<()>` — resolves `desktop` as `window.theme().ok()` only when `follows_desktop(theme)` (no portal call for explicit themes), then `window.set_background_color(Some(background_color(theme, desktop)))`.
  - `build(app, store)` (existing signature) now: builder gains `.visible(false)`; after `build()`, `apply_background(&window, store.get().appearance.theme)?`, then `window.show()?`, then returns the window.
- Produces, in `commands::settings`:
  - `pub fn theme_changed(before: &Settings, after: &Settings) -> bool` — `before.appearance.theme != after.appearance.theme`.
  - `update_settings` (the `#[tauri::command]`) gains an `app: tauri::AppHandle` parameter. After `update_settings_inner` returns `Ok(next)`, if `theme_changed(&before, &next)` and `app.get_webview_window(main_window::LABEL)` is `Some`, it calls `main_window::apply_background(&window, next.appearance.theme)` and logs (does not fail the command on) an `Err`. `before` is `store.get()` taken inside the same `run_blocking` closure before the update. The front-end IPC wrapper does not change: Tauri injects `AppHandle`.
- Produces, in `lib.rs`: the `on_window_event` closure gains a second arm: `WindowEvent::ThemeChanged(_)` on the main window, when `follows_desktop(store.get().appearance.theme)`, calls `apply_background(&webview, Theme::System)` and logs an `Err` with `eprintln!("settings: cannot update window background: {e}")`.

- [ ] **Step 1: Write the failing tests** in `src-tauri/tests/main_window.rs` (follow the file's existing style)

```rust
#[test]
fn background_color_follows_the_stored_theme_then_the_desktop() {
    use git_real_core::settings::Theme;
    use tauri::webview::Color;
    assert_eq!(background_color(Theme::Dark, Some(tauri::Theme::Light)), Color(30, 30, 30, 255));
    assert_eq!(background_color(Theme::Light, Some(tauri::Theme::Dark)), Color(246, 246, 246, 255));
    assert_eq!(background_color(Theme::System, Some(tauri::Theme::Dark)), Color(30, 30, 30, 255));
    assert_eq!(background_color(Theme::System, Some(tauri::Theme::Light)), Color(246, 246, 246, 255));
    assert_eq!(background_color(Theme::System, None), Color(246, 246, 246, 255));
}

#[test]
fn only_the_system_theme_follows_the_desktop() {
    use git_real_core::settings::Theme;
    assert!(follows_desktop(Theme::System));
    assert!(!follows_desktop(Theme::Dark));
    assert!(!follows_desktop(Theme::Light));
}
```

and in `src-tauri/tests/settings_store.rs`, beside the `update_settings_inner` tests:

```rust
#[test]
fn theme_changed_only_when_the_theme_differs() {
    use git_real_lib::commands::settings::theme_changed; // the lib crate is `git_real_lib`, as tests/main_window.rs imports it
    let before = Settings::default();               // system
    let mut dark = before.clone(); dark.appearance.theme = Theme::Dark;
    let mut font = before.clone(); font.appearance.diff_font_size = 15;
    assert!(theme_changed(&before, &dark));
    assert!(!theme_changed(&before, &font));
    assert!(!theme_changed(&before, &before));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --test main_window` and `cargo test --test settings_store theme_changed`
Expected: compile errors (`background_color`, `follows_desktop`, `theme_changed` not found).

- [ ] **Step 3: Implement `background_color`, `follows_desktop`, `apply_background` and the hidden→show `build` in `main_window.rs`**

`Color` is `tauri::webview::Color` (re-export of `tauri_utils::config::Color`, a `(u8, u8, u8, u8)` tuple struct). `tauri::Theme` comes from `tauri::Theme`. `build` keeps every existing builder call.

- [ ] **Step 4: Implement `theme_changed` and the `AppHandle` follow-up in `commands/settings.rs`; add the `ThemeChanged` arm in `lib.rs`**

`WindowEvent::ThemeChanged(theme)` carries the new `tauri::Theme`; it may be passed as `Some(theme)` to `background_color` directly instead of re-reading `window.theme()`. Either shape is fine as long as `apply_background` stays the single place that calls `set_background_color`.

- [ ] **Step 5: Run the tests and the Rust gate**

Run: `cd src-tauri && cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --check`
Expected: all PASS, clippy clean, fmt clean. (`cargo test --workspace` also compiles `lib.rs`, which is the only check the `on_window_event` arm gets before the walk.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/main_window.rs src-tauri/src/commands/settings.rs src-tauri/src/lib.rs src-tauri/tests/main_window.rs src-tauri/tests/settings_store.rs
git commit -m "feat(GR-19): window background from the stored theme before show, following theme changes"
```

---

### Task 3: Front-end idempotence test and ADR note

**Files:**
- Test: `src/app/applyAppearance.test.ts` (new case in `describe("applyAppearance theme attribute")`)
- Modify: `docs/adr/0005-settings-owned-by-rust.md:28` (the "The main window is built in Rust" bullet)

**Interfaces:**
- Consumes: `applyAppearance(prefs, root?)` from `src/app/applyAppearance.ts` (unchanged).
- Produces: nothing new in code; this task proves the front end does not fight the pre-applied attribute.

- [ ] **Step 1: Write the test**

```ts
it("keeps a pre-applied data-theme equal to the stored theme without removing it", async () => {
  const { applyAppearance } = await import("./applyAppearance");
  document.documentElement.setAttribute("data-theme", "dark");
  const remove = vi.spyOn(document.documentElement, "removeAttribute");
  applyAppearance({ theme: "dark", diffFontFamily: null, diffFontSize: 13 });
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(remove).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/app/applyAppearance.test.ts`
Expected: PASS without any source change (this pins current behaviour; if it fails, `applyAppearance` has a bug to fix in `src/app/applyAppearance.ts`, not the test).

- [ ] **Step 3: Add one sentence to ADR 0005's main-window bullet**

Exact copy: `It also builds the window hidden, sets the window and webview background from the stored theme (desktop scheme via the settings portal for "system") and pre-applies data-theme in the init script before showing it, so the first frame is already in the right theme (GR-19).`

- [ ] **Step 4: Run the front-end gate**

Run: `npm run lint && npm run typecheck && npm test`
Expected: clean, all tests pass, coverage 100 % on all four metrics.

- [ ] **Step 5: Commit**

```bash
git add src/app/applyAppearance.test.ts docs/adr/0005-settings-owned-by-rust.md
git commit -m "test(GR-19): pin applyAppearance idempotence; note first-frame theme in ADR 0005"
```

---

### Task 4: Acceptance walk on the desktop and spec §8

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-gr19-cold-start-theme-design.md` (append `## 8. Walk results (YYYY-MM-DD)`)

**Interfaces:**
- Consumes: the harness attached to Jira GR-26 as `desktop-walk-harness.tar.gz` (also still in this session's scratchpad `walk19/`), spec §5 steps 1–5. Download via the Atlassian `downloadJiraIssueAttachment` operation (attachment id 10000) if the scratchpad copy is gone.

- [ ] **Step 1: Build the release binary**

Run: `npm run build && (cd src-tauri && cargo build --release --features tauri/custom-protocol)`
Expected: `Finished release` and `src-tauri/target/release/git-real` exists. Stop any running `git-real` first (`pkill -x git-real`).

- [ ] **Step 2: Run spec §5 steps 1, 2, 3 and 5** with `shot.py` (90 frames) + `analyze.py` with the fixed rect `1000 576 2272 1360`, three cold starts each for stored `dark`, `light`, `system` (edit `~/.config/com.harmonization.git-real/settings.json` between runs; back it up first and restore `theme: dark` after).

Expected: no frame inside the page area with mean luminance above 70 after mapping for `dark`/`system`; none below 180 for `light`; first mapped frame `rgb(30,30,30)`±2 / `rgb(246,246,246)`±2; median map time within 50 ms of 250 ms.

- [ ] **Step 3: Run spec §5 step 4 (window checks)** — hand-edit `window` to `1100 × 650` then to `maximized: true`, cold start each, read `innerWidth/innerHeight` and `plugin:window|is_maximized` through `drive.mjs`, confirm `document.hasFocus()` and that a real Ctrl+K through `kbd.py` opens the palette.

Expected: 1100 × 650 restored; maximized restored; focus true; palette opens.

- [ ] **Step 4: Run spec §5 step 6 as far as automation allows** — switch theme in Settings through the UI, then confirm through the inspector that `update_settings` ran and no error was logged; the mouse-resize sliver check is left to the owner.

- [ ] **Step 5: Append §8 to the spec** as a table in the GR-29 §15 style (step, checked, observed, result), including anything left to the owner, and restore `settings.json` to `theme: dark`.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-26-gr19-cold-start-theme-design.md
git commit -m "docs(GR-19): acceptance walk results"
```

---

## Execution notes

- Suggested batching (owner is cost-sensitive): Tasks 1 and 2 are one Rust implementer cycle (tester → developer → reviewer); Task 3 is a short front-end cycle; Task 4 is one walk agent with the harness; then the whole-branch review. Four dispatches plus reviews.
- The walk needs the owner's desktop session (COSMIC, `/dev/uinput` ACL); it is not a CI step.
- Merge/PR/keep is decided with superpowers:finishing-a-development-branch after the final review; Jira GR-19 gets a summary comment, not a transition, unless the owner says otherwise.
