# GR-19: Cold-start theme flash — design

**Ticket:** GR-19 "Verify GR-14 shell on a real desktop: native shortcut
pass-through and theme flash" (Task, relates to GR-14).
**Builds on:** GR-29 / ADR 0005 (the main window is built in Rust and the
settings are injected before any page script).
**Status:** open points settled by the owner on 2026-10-26 (§7); plan in
`docs/superpowers/plans/2026-10-26-gr19-cold-start-theme.md`. Verification
results are in §1; the fix starts at §2.

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

- When a settings patch changes `appearance.theme`, Rust recomputes the
  colour (asking `window.theme()` again if the new value is `system`) and
  calls `set_background_color` on the main window.
- When the stored theme is `system` and Tauri delivers
  `WindowEvent::ThemeChanged`, Rust does the same.

Where exactly this hangs off the existing settings command and window-event
plumbing is the builder's choice; it must not block the IPC thread and must
not write to `settings.json`.

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
