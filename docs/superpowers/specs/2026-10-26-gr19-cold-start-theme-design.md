# GR-19: Cold-start theme flash — design

**Ticket:** GR-19 "Verify GR-14 shell on a real desktop: native shortcut
pass-through and theme flash" (Task, relates to GR-14).
**Builds on:** GR-29 / ADR 0005 (the main window is built in Rust and the
settings are injected before any page script).
**Status:** open points settled by the owner on 2026-10-26 (§7); plan in
`docs/superpowers/plans/2026-10-26-gr19-cold-start-theme.md`. Verification
results are in §1; walk results in §8.

## 1. What the verification found (2026-10-26)

Run on the owner's COSMIC/Wayland desktop (cosmic-comp, WebKitGTK) against
`main` at 22a47e9, with **real keystrokes**: a virtual keyboard on
`/dev/uinput` (this user has an ACL on it), so every chord travelled
kernel → libinput → cosmic-comp → WebKitGTK like a physical keyboard. A
capture-phase `keydown` log and the resulting UI state were read through the
WebKit remote inspector. The cold start was measured with a non-interactive
desktop-portal screenshot burst (one frame every ~50 ms) around launches of a
**release** build (`tauri://localhost`, bundled front end; built with
`cargo build --release --features tauri/custom-protocol`), window 1280 × 800,
system colour scheme dark. The harness (keyboard, inspector driver,
screenshot burst, frame analyser, README) is attached to Jira GR-26 as
`desktop-walk-harness.tar.gz`; it is deliberately not in git (§7.1).

### 1.1 Native shortcut pass-through — pass, nothing to change

| Chord            | Delivered to the page as | What the app did                                             |
| ---------------- | ------------------------ | ------------------------------------------------------------ |
| Ctrl+K           | `Ctrl+KeyK`              | Command palette opened                                       |
| Ctrl+/           | `Ctrl+Slash`             | Keyboard shortcuts dialog opened                             |
| Ctrl+,           | `Ctrl+Comma`             | Settings dialog opened                                       |
| Ctrl+O           | `Ctrl+KeyO`              | Open repository (picker stubbed at the IPC seam); tab opened |
| Ctrl+Shift+O     | `Ctrl+Shift+KeyO`        | Clone dialog opened                                          |
| Ctrl+PageDown ×2 | `Ctrl+PageDown`          | Next tab, wrapping to the first                              |
| Ctrl+PageUp      | `Ctrl+PageUp`            | Previous tab                                                 |
| Ctrl+W ×3        | `Ctrl+KeyW`              | Closed the active tab; with no tab open nothing happened     |
| Escape           | `Escape`                 | Closed each dialog                                           |

Every chord arrived as a native `keydown` with `ctrlKey` set and the expected
`code`. Neither WebKitGTK nor COSMIC swallowed any of them (COSMIC's default
bindings use only Super+Ctrl chords; this machine has no custom overrides).
No alternative bindings are needed. `src/lib/shortcuts/index.ts` and
`src/app/useGlobalShortcuts.ts` stay as they are.

### 1.2 Theme flash on cold start — fails, two causes

1. **A white frame from the webview.** The window is mapped about 250 ms
   after launch and its first frame is pure white (`rgb(255,255,255)`, with
   the COSMIC title bar already drawn); the dark page (`rgb(30,30,30)`)
   follows 50–60 ms later. Caught in 2 of 3 dark cold starts at the 50 ms
   sampling rate, so it lasts roughly one sample (two to four display frames
   at 60 Hz). Cause: `src-tauri/src/main_window.rs` sets no background colour
   on the window or webview, so WebKitGTK paints its default white until the
   page's first layout. Confirmed by pointing the debug binary at a page
   server that answers after 2.5 s: the window stayed white the whole time.
2. **A wrong-scheme frame before the app script runs.** With `theme: light`
   stored on this dark-system machine the sequence was white → **dark**
   (~60 ms) → light. The dark frame is `index.html` painted with the
   `prefers-color-scheme` default from `tokens.css` before the deferred module
   script runs `bootstrapAppearance()`. The mirror case, stored `dark` on a
   light desktop, shows a light frame. It is invisible when the stored theme
   matches the desktop scheme, which is why the GR-29 walk could not see it
   on this machine.

Stored `theme: system` is unaffected by cause 2 (the CSS default _is_ the
system scheme) but still shows cause 1.

## 2. Intent

A cold start paints in the stored theme from the very first frame the
compositor shows. No white frame, no frame in the other scheme, no loading
screen, no delay in showing the window beyond what the fix itself needs.

### Goals

1. The first mapped frame of the main window has the theme's background
   colour: `#1e1e1e` for `dark`, `#f6f6f6` for `light`, and for `system`
   whichever of the two matches the desktop scheme at launch.
2. `index.html`'s first layout already carries `data-theme` for `dark` and
   `light`, so the first styled paint is in the stored theme.
3. No change to the `settings.json` shape (ADR 0005 version 2), no new crate
   or npm dependency, no change to the CSP.
4. The GR-29 window behaviour is preserved: stored size and maximized state
   apply before the window shows, the window is focused on launch as before,
   and geometry is still saved on close.

### Non-goals

- The diff font tokens (`--font-mono`, `--diff-font-size`) stay applied by
  `bootstrapAppearance()`; they cause no colour flash and nothing that uses
  them is visible at launch.
- The in-app theme switch keeps working exactly as today (it sets
  `data-theme` live). See §3.3 for the one thing it gains.
- No splash or loading screen, and no "show the window only when the page
  has loaded" (§6).

### Anti-goals

- Anything that makes the window appear later than it does now by more than
  the time of one portal round-trip (a few ms) is a failure even if no flash
  is visible: GR-16/GR-28 budget first paint, and a window that appears late
  reads as a slow app.
- A fix that hides the flash only on dark desktops.

## 3. Design

### 3.1 Window and webview background colour (Rust)

Tauri 2.12 exposes `WebviewWindowBuilder::background_color(Color)` (sets both
the GTK window and the WebKit view background; `wry` calls
`webkit_web_view_set_background_color`) and
`WebviewWindow::set_background_color(Option<Color>)` at runtime.
`WebviewWindow::theme()` returns the desktop scheme on Linux through the
settings portal (`org.freedesktop.appearance color-scheme`; `tao`'s `dbus`
feature is on in this build and the portal answers `1` = prefer dark on this
machine).

Behaviour, in `src-tauri/src/main_window.rs::build`:

1. Read the stored theme from the `SettingsStore`.
2. Build the window **hidden** (`.visible(false)`), with everything it has
   today (size, min size, maximized, decorations, init script).
3. Resolve the background: `dark` → `#1e1e1e`; `light` → `#f6f6f6`;
   `system` → ask `window.theme()` and pick `#1e1e1e` for `Theme::Dark`,
   `#f6f6f6` otherwise (the `tao` fallback when the portal is unavailable is
   `Light`, which matches the CSS default when `prefers-color-scheme` is not
   dark).
4. `set_background_color(Some(colour))`, then `show()`.

For `dark` and `light` the colour may also be given to the builder up front;
the builder may choose whichever shape keeps `build` simple, as long as the
window is never shown before its colour is set.

The two RGB values duplicate `--color-bg` in `src/styles/tokens.css`. They
live as named constants beside a comment that points at `tokens.css`, and a
Rust test asserts the exact values so a token change that forgets Rust fails
a test instead of reintroducing a flash. The mapping itself
(`theme`, `desktop is dark`) → RGB is a pure function in `git-real-core`'s
`settings` module, so it unit-tests without Tauri; converting to Tauri's
`Color` happens in `main_window.rs`.

### 3.2 `data-theme` before the first paint (init script)

`SettingsStore::to_init_script` appends, after the `window.__GIT_REAL_SETTINGS__`
assignment and **only** for `dark` and `light`:

```js
if (document.documentElement) document.documentElement.setAttribute("data-theme", "<theme>");
```

For `system` it appends nothing, so `tokens.css`'s `prefers-color-scheme`
default applies, as today. A WebKitGTK spike (user script injected at
document start) saw `document.documentElement` present with `readyState`
`"loading"`, so the attribute lands before the first layout; the `if` guard
is defence against a WebKit where it is not, in which case
`bootstrapAppearance()` still sets it as today and only the ~60 ms frame
returns. The builder verifies the timing in the real app during the
acceptance walk (§5), not only in the spike.

`bootstrapAppearance()` and `applyAppearance()` in `src/app/applyAppearance.ts`
stay unchanged; setting an attribute that already has that value is a no-op.

Known limitation (writer's call after the builder check): the init script is
fixed when the window is built, so a page reload after an in-app theme switch
would pre-apply the launch theme for one frame until `bootstrapAppearance()`
corrects it. The app has no reload action and WebKitGTK binds none by
default, so this is recorded here and not mitigated.

### 3.3 Following a theme change while the app runs

The webview background is only visible when the page is not covering it,
which on GTK happens for a few frames of newly exposed area during a resize.
If the user switches theme in Settings and later resizes, that sliver would
be in the launch theme. So the colour follows the theme:

- When a settings patch changes `appearance.theme` to `dark` or `light`,
  `update_settings` recomputes the colour and calls `set_background_color`
  on the main window directly.
- While the theme is `system`, the page reports the desktop scheme. In
  `bootstrapAppearance()` a `matchMedia("(prefers-color-scheme: dark)")`
  listener calls the `sync_window_background` command with the current
  `matches` on every change, and a settings switch to `system` calls it once.
  The command trusts the page's report and recolours the window for that
  scheme without re-checking the stored theme: the page store updates at
  once but the file save is debounced, so right after a switch to `system`
  the stored theme is still the old one. The debounced `update_settings` for
  `system` skips the recolour by rule, and a later explicit theme still
  recolours through `update_settings`. A recolour failure is only logged.
  There is no startup sync: `build` already coloured the window from the
  portal answer at creation, which is fresh at launch.

There is no `WindowEvent::ThemeChanged` handler. On Linux `tao` delivers the
portal's colour-scheme change to a dummy window id that `tauri-runtime-wry`
drops, and `window.theme()` returns the answer cached at window creation, so
neither can see a desktop flip after launch; the page's
`prefers-color-scheme` does follow it.

Neither path blocks the IPC thread or writes to `settings.json`.

### 3.4 Documentation

ADR 0005's "The main window is built in Rust" bullet gains one sentence: the
builder also sets the window and webview background from the stored theme
and pre-applies `data-theme` in the init script, so the first frame is in the
right theme. No new ADR.

## 4. Tests

- `git-real-core`: the pure mapping, four cases (`dark`, `light`,
  `system`+dark desktop, `system`+light desktop) and the two RGB constants.
- `src-tauri`: `to_init_script` ends with the `data-theme` statement for
  `dark` and `light`, with the theme name in it, and has none for `system`;
  the existing escaping test still passes.
- `src-tauri`: `main_window` tests for the pieces that need no display
  (colour resolution given a `Theme`), in the style of the existing
  `logical_geometry`/`close_geometry` tests. Building a window needs a
  display and is covered by the walk.
- Front end: an `applyAppearance` test that a pre-set `data-theme` equal to
  the stored theme is left untouched (no attribute removal/re-add), if no
  such test exists.
- `git-real-core`: the two RGB constants match `--color-bg` in
  `tokens.css` for `:root`, `:root[data-theme="dark"]` and the dark
  `prefers-color-scheme` block (a drift test that reads the file).
- `src-tauri`: `desktop_theme` maps the page's dark flag to
  `tauri::Theme::Dark` / `Light`.
- Front end: the `syncWindowBackground` IPC contract (command name,
  `desktopDark` argument, rejection passes through), and in
  `bootstrapAppearance()`: a scheme change syncs while on `system`, is
  ignored on an explicit theme, a switch to `system` syncs once, and the
  uninstaller removes the media-query listener.
- Gate as in GR-29 §9: `npm run lint`, `npm run typecheck`, `npm test`,
  `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`,
  coverage unchanged at 100 %.

## 5. Acceptance walk (release build, this desktop)

Re-run the §1 burst with the fixed release binary:

1. Stored `dark`, dark desktop: no frame inside the page area with mean
   luminance above 70 after the window is mapped; first mapped frame is
   `rgb(30,30,30)` ± 2.
2. Stored `light`, dark desktop: no frame darker than luminance 180 after
   mapping; first mapped frame is `rgb(246,246,246)` ± 2. (Stands in for
   stored `dark` on a light desktop, which this machine cannot show without
   changing the owner's desktop.)
3. Stored `system`: first mapped frame matches the desktop scheme.
4. GR-29 §15 window checks still hold with the hidden→show flow: stored
   1100 × 650 restores at that size, `maximized: true` restores maximized,
   the window has keyboard focus on launch (`document.hasFocus()` true, a
   real Ctrl+K opens the palette), and a resize → quit → relaunch keeps the
   size (owner, needs a real close).
5. Window appearance time: over three cold starts, the median time from
   launch to the first mapped frame is within one burst sample (50 ms) of
   the §1 baseline median (~250 ms). The burst cannot resolve less than
   that; a finer number is not required. (Writer's call after the builder
   check.)
6. Switch theme in Settings, then resize by mouse: no sliver of the previous
   theme (owner; a visual check).
7. Flip the desktop colour scheme while on `system`, then resize by mouse: no
   sliver (owner).

Results are recorded in a §8 of this document, as GR-29 did.

## 6. Alternatives considered

- **Show the window only once the page has loaded** (`visible(false)` and
  `show()` from `on_page_load`). Removes both frames with no colour
  bookkeeping, but delays the window by the page load (60–100 ms here, more
  on slow disks), and a page that fails to load leaves no window unless a
  timeout is added. Rejected for the anti-goal above.
- **A classic blocking `<script src>` in `index.html` `<head>`** that reads
  `window.__GIT_REAL_SETTINGS__` and sets `data-theme`. Works under the
  current CSP (same origin) but splits "before first paint" logic across two
  places when the init script already exists for exactly this purpose
  (ADR 0005). Rejected.
- **An inline `<script>` in `index.html`.** Blocked by `default-src 'self'`;
  would need a hash in the CSP for every edit. Rejected.
- **Read the portal colour scheme before building the window** so the
  builder gets the final colour for `system` too. Needs a direct D-Bus
  dependency or a second window; the hidden→show step costs nothing visible.
  Rejected.
- **Leave cause 2 alone** because it is invisible when stored theme equals
  desktop scheme. Rejected: a user who forces `dark` on a light desktop is
  exactly the user who notices a light frame.

## 7. Open points for the owner

1. ~~Keep the desktop walk harness in the repo?~~ **Decided by the owner
   (2026-10-26): not in git.** The harness (uinput keyboard, inspector
   driver, portal screenshot burst, frame analyser, slow page server, README)
   is attached to Jira GR-26 as `desktop-walk-harness.tar.gz`, with a usage
   comment. The §5 walk downloads it from there.
2. ~~Include §3.3 (background follows theme changes)?~~ **Decided by the
   owner (2026-10-26): yes, included.**
3. ~~Which ticket carries the fix?~~ **Decided by the owner (2026-10-26):
   the fix is implemented under GR-19**, on branch
   `feature/gr-19-cold-start-theme`.

Everything else in this document is the writer's call.

## 8. Walk results (2026-10-26)

Run by the builder on the owner's COSMIC/Wayland desktop against a release
build of `feature/gr-19-cold-start-theme` at 6897d61 (`npm run build`, then
`cargo build --release --features tauri/custom-protocol`), window 1280 × 800,
desktop colour scheme dark. Each cold start used the §1 harness unchanged: a
90-frame portal screenshot burst (~50 ms per frame) started 1 s before
launch, analysed inside the fixed page-area rect x1000 y576 – x2272 y1360. A
frame counts as mapped when its mean colour first moves away from the
desktop under the window (rgb(25,32,25), a dark terminal). The §1 baseline
bursts were re-analysed with the same script and rect for the time
comparison. Window and focus checks used the WebKit remote inspector and the
`/dev/uinput` keyboard. Stopping the app with `pkill` does not fire
`CloseRequested`, so nothing here counts as a save-on-close test.

| Step          | Checked                                                                           | Observed                                                                                                                                                                                                                                                    | Result        |
| ------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1 dark        | three cold starts, stored `dark`                                                  | first mapped frame rgb(30,30,30) in all three (+568, +184, +232 ms); every later frame rgb(30,30,30) then rgb(34,34,34) once the app renders; max mean luminance 34; 0 % light pixels                                                                       | pass          |
| 1 dark        | no white frame (baseline showed rgb(255,255,255) at +254 and +262 ms)             | none in 3 runs                                                                                                                                                                                                                                              | pass          |
| 2 light       | three cold starts, stored `light`, dark desktop                                   | first mapped frame rgb(246,246,246) in all three (+240, +215, +217 ms); then rgb(245,245,245) / rgb(240,240,240); min mean luminance 240; 0 % dark pixels                                                                                                   | pass          |
| 2 light       | no dark frame before the app script (baseline: white → dark → light)              | none in 3 runs                                                                                                                                                                                                                                              | pass          |
| 3 system      | three cold starts, stored `system`, desktop dark                                  | first mapped frame rgb(30,30,30) in all three (+299, +202, +240 ms); max mean luminance 34; 0 % light pixels; page reports `data-theme` absent, `prefers-color-scheme: dark`, body rgb(30,30,30)                                                            | pass          |
| 4 restore     | hand-edited `window` 1100 × 650, not maximized                                    | `innerWidth`/`innerHeight` 1100 × 650; `plugin:window\|is_maximized` → false; `data-theme="dark"`                                                                                                                                                           | pass          |
| 4 restore     | hand-edited `maximized: true`                                                     | `is_maximized` → true; viewport 3440 × 1347                                                                                                                                                                                                                 | pass          |
| 4 focus       | keyboard focus on launch (both launches above)                                    | `document.hasFocus()` true; a real Ctrl+K through `/dev/uinput` arrived as `Ctrl+KeyK` and opened the Command palette, both at 1100 × 650 and maximized                                                                                                     | pass          |
| 4 resize/quit | resize by mouse, quit, relaunch keeps the size                                    | —                                                                                                                                                                                                                                                           | left to owner |
| 5 map time    | median launch → first mapped frame over three cold starts                         | dark 232 ms, light 217 ms, system 240 ms (all nine: 232 ms); baseline re-analysed: 254, 262 ms (dark), 268, 340 ms (light); within one 50 ms sample of ~250 ms                                                                                              | pass          |
| 6 switch      | theme switch in Settings (real Ctrl+, then the radios)                            | Light → `data-theme="light"`, body rgb(246,246,246); System → attribute removed, rgb(30,30,30); Dark → `data-theme="dark"`; `settings.json` followed each change (`update_settings` ran); the native background cannot be observed while the page covers it | pass          |
| 6 switch      | no `settings: cannot update window background` error                              | app stderr empty after all three switches                                                                                                                                                                                                                   | pass          |
| 6 sliver      | switch theme, then resize by mouse: no previous-theme sliver                      | —                                                                                                                                                                                                                                                           | left to owner |
| 7 desktop     | flip the desktop colour scheme while on `system`, then resize by mouse: no sliver | —                                                                                                                                                                                                                                                           | left to owner |

The first dark start (+568 ms) was the first launch after the release build,
likely a cold page cache; the other eight starts fall between +184 and
+299 ms. One baseline dark burst (+448 ms, first frame already the app's
rgb(34,34,34)) missed the window's appearance and is left out of the
baseline times.

**Left to the owner:**

- Resize the window by mouse, quit, relaunch: the size is kept.
- Switch theme in Settings, then resize by mouse: no sliver of the previous
  theme shows at the growing edge.
- Flip the desktop colour scheme while the theme is `system`, then resize by
  mouse: no sliver of the previous scheme shows at the growing edge.
