# GR-15 Linux Packaging and Release Pipeline Implementation Plan

> For agentic workers: tests first, by the test role; the developer writes the minimum code that makes them pass and never edits test files. Every dispatch: `git add <explicit paths>` only; never `git reset`, `git commit --amend`, `git stash`, `git add -A`, `git add -u`, `git push`, or anything that rewrites history. Run `git log -3` before committing; other agents may be committing to this branch at the same time.

**Goal:** CI builds the `.deb`, `.rpm` and AppImage on every push; a `v*` tag publishes a GitHub release with those files; the installed app appears in the COSMIC launcher with its own name and icon; the running app notifies the user when a newer release exists.

**Architecture:** The update check is a pure function in `git-real-core` over the existing `Transport` trait, exposed by one Tauri command and consumed through the IPC seam by a persisted preference store, a startup hook and a new Settings → About section. Packaging is configuration: `tauri.conf.json` bundle metadata, a desktop template, an SVG icon source and two workflow files, all pinned by a Vitest contract test.

**Spec:** `docs/superpowers/specs/2026-10-25-gr15-linux-packaging-design.md` (rulings R1–R15 are decided; do not reopen them).

**Branch:** `feature/gr-15-linux-packaging` from `main` (edfcb9c).

## Global Constraints

- **Standing rules.** Tests first, by the test role; the developer never edits test files. The only importer of `@tauri-apps/*` is `src/lib/ipc` (the ESLint seam rule enforces it; `src/lib/ipc/app.ts` may import `@tauri-apps/api/app`). `git2` stays `default-features = false`. **No new crate**, no `tokio`, no `reqwest`, no Tauri plugin, no capability change, the CSP string is untouched. One new npm devDependency only: `yaml`. Every command body runs inside `run_blocking`. 100 % statements/branches/functions/lines on the front end (no threshold is configured; the coverage agent reads the table, and a `src/` file no test imports never appears in it, so every new source file is imported by a test). Commits carry the repo-local noreply author email. `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings`, ESLint and `prettier --check .` clean.
- **Wire shapes (camelCase):** `UpdateInfo { current: string; latest: string | null; available: boolean; url: string | null }`; command `check_for_update` (no args). New `AppErrorKind`: Rust unit variant `UpdateCheckFailed`, TS string `updateCheckFailed` in **both** `src/lib/ipc/types.ts` and `src/lib/ipc/errors.ts` `KINDS`. `GitError::UpdateCheckFailed { message: String }` with `#[error("update check failed: {message}")]`.
- **HTTP request (exact):** `GET ‹api_url›` with headers `accept: application/vnd.github+json` and `x-github-api-version: 2022-11-28`, no body, no auth. `RELEASES_API_URL = "https://api.github.com/repos/harmonizationllc/git-real/releases/latest"` lives in `src-tauri/src/commands/update.rs`; the core function takes the URL as a parameter.
- **Status handling:** 200 → parse `tag_name` and `html_url`; 404 → `Ok(UpdateInfo { available: false, latest: None, url: None })`; 403 with header `x-ratelimit-remaining: 0` → `UpdateCheckFailed { message: "GitHub answered 403 (rate limited)" }`; any other non-200 → `"GitHub answered ‹status›"`; non-JSON or missing/non-string `tag_name`/`html_url` → `"unexpected response"`; a tag `Version::parse` rejects → `"unrecognised release tag ‹tag›"`; a `current` that does not parse → `"unrecognised current version ‹current›"`; a transport `Err(e)` → `UpdateCheckFailed { message: e.to_string() }`. `latest` is the tag with one leading `v`/`V` stripped.
- **Version rules:** `Version::parse` trims, strips one leading `v`/`V`, requires exactly `MAJOR.MINOR.PATCH` decimal integers with an optional `-PRE` suffix (non-empty, anything after the first `-`); rejects `1.2`, `1.2.3.4`, `a.b.c`, empty, `+build` metadata. Ordering: numeric triple, then a version with `pre` sorts **below** the same triple without `pre`; two `pre`s compare as plain strings.
- **Persistence:** `localStorage` key `git-real.updatePrefs`, `version: 1`; `checkOnStartup` default `true`, `lastCheckedAt` default `null`; `CHECK_INTERVAL_MS = 86_400_000`, `STARTUP_DELAY_MS = 10_000`. The startup hook runs only when `checkOnStartup && (lastCheckedAt === null || now - lastCheckedAt >= CHECK_INTERVAL_MS)`, after `STARTUP_DELAY_MS`, at most once per mount, and calls `markChecked(Date.now())` on success **and** on failure; failures are silent. A manual check never touches `lastCheckedAt`.
- **Copy (verbatim; ‹…› are values):** toast `Git Real ‹latest› is available` (variant `info`, `sticky: true`, action `Release notes` → `openExternal(url)`, omitted when `url` is null); About section `<h3>About</h3>`, version line `Git Real ‹version›` (`Git Real` while loading or on error), checkbox `Check for updates on startup`, button `Check for updates` (busy: `Checking…`, disabled), status (`role="status"`) `You're up to date` / `Git Real ‹latest› is available` + button `Release notes` / `No releases published yet`, alert (`role="alert"`) `Couldn't check for updates: ‹message›`, button `Source and issues` → `openExternal("https://github.com/harmonizationllc/git-real")`; palette command `Check for updates…` → `useShell.getState().open({ kind: "settings", section: "about" })`; `SettingsSection` += `"about"`, rendered last, `data-section="about"`.
- **Bundle config (exact):** `bundle.category "DeveloperTool"`, `shortDescription "Lightweight desktop Git client"`, `longDescription` as in spec §4.1, `homepage "https://github.com/harmonizationllc/git-real"`, `license "GPL-3.0-only"`, `licenseFile "../LICENSE"`, `icon` = the five existing entries plus `icons/icon.png` (order: 32, 128, 128@2x, icon.png, icns, ico), `linux.deb { section "vcs", recommends ["git"], desktopTemplate "packaging/git-real.desktop" }`, `linux.rpm { desktopTemplate "packaging/git-real.desktop" }`, `app.windows[0].decorations true`. `src-tauri/Cargo.toml` gains `repository = "https://github.com/harmonizationllc/git-real"`. Targets stay `["deb", "rpm", "appimage"]`.
- **Workflows (exact):** both jobs that bundle run on `ubuntu-22.04`, install `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev pkg-config file patchelf`, use `actions/checkout@v4`, `actions/setup-node@v4` (node 24, npm cache), `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2` (`workspaces: src-tauri`), `npm ci`, and run `npm run tauri build -- --bundles deb,rpm,appimage`. Bundle globs: `src-tauri/target/release/bundle/deb/*.deb`, `…/rpm/*.rpm`, `…/appimage/*.AppImage`. `ci.yml`: workflow-level `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`; job `package` uploads with `actions/upload-artifact@v4` (`name: git-real-linux-${{ github.sha }}`, `retention-days: 14`, `if-no-files-found: error`). `release.yml`: `on.push.tags: ["v*"]`, `permissions: { contents: write }`, `concurrency: { group: release-${{ github.ref }} }`, a step `Check the tag matches the app version` (shell comparison of `${GITHUB_REF_NAME#v}` with `node -p "require('./src-tauri/tauri.conf.json').version"`) **before** the build, then `softprops/action-gh-release@v2` with `name: Git Real ${{ github.ref_name }}`, `generate_release_notes: true`, `prerelease: ${{ contains(github.ref_name, '-') }}`, `fail_on_unmatched_files: true`, `files:` the three globs. The README `Development` apt list is updated to the same package list so the contract test's cross-check holds.
- **Icon:** `src-tauri/icons/icon.svg` exactly as spec §4.3 (1024 viewBox, rounded square r=224 with a `#2563eb`→`#1e3a8a` vertical gradient, white stroke-72 trunk/branch paths, three r=84 nodes). Regenerate with `npx tauri icon src-tauri/icons/icon.svg`, delete the generated `src-tauri/icons/android/` and `src-tauri/icons/ios/`, commit `icon.svg` and the regenerated PNG/ICNS/ICO files. `TEMPLATE_SIZES` for the test: `32x32.png` 567, `128x128.png` 1593, `128x128@2x.png` 2861, `icon.png` 5664 bytes.
- **Desktop template (`src-tauri/packaging/git-real.desktop`):** exactly spec §4.2 (Handlebars placeholders `{{categories}}`, `{{comment}}`, `{{exec}}`, `{{exec_arg}}`, `{{icon}}`, `{{name}}`, `{{mime_type}}`; `Keywords=git;vcs;version control;repository;commit;branch;`; `StartupNotify=true`; `Terminal=false`; `Type=Application`).
- Checks: from `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `cargo tree -i openssl-sys` prints nothing; from the root: `npm run test:coverage` at 100 %, `npm run lint`, `npm run typecheck`, `npx prettier --check .`; and once, by the Cycle 2 developer, `npm run tauri build -- --bundles deb` followed by `dpkg-deb -c src-tauri/target/release/bundle/deb/*.deb` showing `./usr/bin/git-real`, `./usr/share/applications/git-real.desktop` and `./usr/share/icons/hicolor/*/apps/git-real.png` (if Tauri names them differently, record the real names in the ledger report and adjust the spec §4.1 text, not the config).

## Review Focus

- The session lock is irrelevant here (no repository is touched), but the command must still run inside `run_blocking` because `ureq` blocks.
- The startup check must never toast on failure and must never run twice per mount (StrictMode double-mount in dev is fine: the cleanup clears the timer).
- Nothing in `src/` outside `src/lib/ipc` imports `@tauri-apps/*`.
- `generate_handler!` gets the new command; the TS union and `KINDS` both get the new kind.
- The contract test reads files via `__dirname`, keeps its helpers in-file, and fails today on the unchanged config (red before green).

## Deviations and calls (decided here; the implementer does not reopen them)

- `FakeTransport` in `src-tauri/tests/common/mod.rs` serves the app-crate tests; the core tests define their own tiny fake inside `update.rs`'s test module (the core crate has no shared fake), as `hosting` tests do.
- `useQuery` for the version uses the v5 object form and `queryKeys.appVersion = ["appVersion"] as const` (global array style, beside `settings`).
- `AboutSettings` lives in its own file (`src/features/settings/AboutSettings.tsx`) like the other sections, rendered by `SettingsDialog` after `GitSettings`, using the dialog's `Section` helper so `data-section="about"` focus works.
- ADR 0003 is short (status, context, decision, consequences) and records R1, R2, R3, R6 only.

---

## Cycle 1 — Update check, end to end (Tasks 1–4)

### Task 1: Core — `update.rs`

**Files:** create `src-tauri/crates/git-real-core/src/update.rs`; edit `src-tauri/crates/git-real-core/src/lib.rs` (`pub mod update;` + `pub use update::{UpdateInfo, Version};`), `src-tauri/crates/git-real-core/src/error.rs` (`UpdateCheckFailed { message: String }`).

**Tests (in `update.rs` `#[cfg(test)]`):** `parse_accepts_plain_v_and_prerelease`, `parse_rejects_malformed` (table: `1.2`, `1.2.3.4`, `a.b.c`, ``, `1.2.3+build`), `ordering_numeric_then_prerelease_below_release`, `newer_release_is_available` (asserts `latest`, `url`, `available`, `current`), `equal_or_older_is_not_available`, `not_found_means_no_release`, `rate_limited_403_is_named`, `other_status_is_reported`, `non_json_body_is_unexpected`, `missing_tag_name_is_unexpected`, `unparseable_tag_is_reported`, `transport_error_is_wrapped`, `request_has_github_headers_and_url` (the fake records the `Request`).

### Task 2: App — `commands/update.rs`, error mapping, wiring

**Files:** create `src-tauri/src/commands/update.rs`; edit `src-tauri/src/commands/mod.rs`, `src-tauri/src/error.rs` (new unit variant + match arm), `src-tauri/src/lib.rs` (`generate_handler!`).

**Tests:** `src-tauri/tests/update_commands.rs` (or the existing command-test file pattern): `check_for_update_maps_failure_to_update_check_failed` (FakeTransport returning 500 → `AppError { kind: UpdateCheckFailed }`), `check_for_update_returns_info` (200 body → `UpdateInfo` JSON with camelCase keys `current`, `latest`, `available`, `url`), `app_error_kind_serializes_update_check_failed` (`"updateCheckFailed"`).

### Task 3: IPC seam

**Files:** create `src/lib/ipc/update.ts`, `src/lib/ipc/app.ts`; edit `src/lib/ipc/types.ts`, `src/lib/ipc/errors.ts`, `src/lib/ipc/index.ts`, `src/lib/query/keys.ts`.

**Tests:** `src/lib/ipc/update.test.ts` (`sends check_for_update with no arguments`, `rejects with the AppError`), `src/lib/ipc/app.test.ts` (`appVersion resolves plugin:app|version`), `src/lib/ipc/errors.test.ts` gains `recognises updateCheckFailed`.

### Task 4: Front end — `updatePrefs`, `useUpdateCheck`, About section, palette command, App mount

**Files:** create `src/lib/store/updatePrefs.ts`, `src/app/useUpdateCheck.ts`, `src/features/settings/AboutSettings.tsx`; edit `src/lib/store/shell.ts` (`"about"`), `src/features/settings/SettingsDialog.tsx` (render `AboutSettings` last), `src/features/palette/useCommands.ts` (`Check for updates…`), `src/app/App.tsx` (`useUpdateCheck()` in `AppShell`).

**Tests:** `src/lib/store/updatePrefs.test.ts` (`defaults`, `persists under git-real.updatePrefs v1`, `setCheckOnStartup`, `markChecked`); `src/app/useUpdateCheck.test.ts` with fake timers (`waits STARTUP_DELAY_MS then checks`, `does nothing when disabled`, `does nothing within 24 h`, `checks when older than 24 h`, `toasts with Release notes when available`, `omits the action without url`, `no toast when not available`, `swallows failure and marks checked`, `unmount clears the timer`); `src/features/settings/AboutSettings.test.tsx` (`shows Git Real and the version`, `shows Git Real alone while loading`, `checkbox toggles the preference`, `Check for updates shows Checking… then You're up to date`, `shows available with Release notes that opens the url`, `shows No releases published yet`, `shows the alert on failure`, `manual check leaves lastCheckedAt`, `Source and issues opens the repository`); `src/features/palette/useCommands.test.ts(x)` gains `Check for updates… opens Settings at About`; `src/features/settings/SettingsDialog.test.tsx` gains `renders About last` and `focuses About for section about`; `src/lib/store/shell.test.ts` (if it enumerates sections) gains `about`.

**Cycle 1 deliverable:** `cargo test --workspace` green; `npm test` green; Settings → About checks GitHub for the latest release; the startup toast fires in the dev app after ten seconds when a newer release exists.

## Cycle 2 — Packaging and release (Tasks 5–8)

### Task 5: Contract test (red first) and `yaml` devDependency

**Files:** create `src/test/release.test.ts`; edit `package.json` + `package-lock.json` (`yaml` devDependency, installed with `npm install --save-dev yaml`).

**Tests (all in `release.test.ts`, grouped by `describe`):** `versions` (`package.json, tauri.conf.json and Cargo.toml agree`, `version is MAJOR.MINOR.PATCH`); `bundle config` (`targets are deb, rpm, appimage`, `category is DeveloperTool`, `descriptions, homepage and license are set`, `icon list includes icon.png and every file exists`, `icons are not the Tauri template files`, `deb recommends git and both desktop templates exist`, `window decorations are explicit`); `desktop template` (`has the required keys and placeholders`); `icon source` (`is a 1024 square SVG without external references`); `ci workflow` (`has build-and-test and package jobs`, `package bundles on ubuntu-22.04 and uploads the three globs`, `cancels in-progress runs per ref`); `release workflow` (`runs on v tags only with contents write`, `checks the tag before building`, `builds the three bundles`, `publishes with generated notes and the three globs`); `apt packages` (`both workflows and the README list the same packages`).

### Task 6: Bundle metadata, desktop template, icon

**Files:** edit `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (`repository`); create `src-tauri/packaging/git-real.desktop`, `src-tauri/icons/icon.svg`; regenerate `src-tauri/icons/*.png|icns|ico` with `npx tauri icon src-tauri/icons/icon.svg` and delete `src-tauri/icons/android` and `src-tauri/icons/ios`. Then run the local `.deb` build check from Global Constraints and record the listed paths.

### Task 7: Workflows

**Files:** edit `.github/workflows/ci.yml` (concurrency + `package` job); create `.github/workflows/release.yml`; edit `README.md` `Development` apt list (add `file`, `patchelf`).

### Task 8: Docs

**Files:** edit `README.md` (new `Install`, `Releasing`, `Wayland and X11` sections; Status paragraph); create `docs/adr/0003-release-pipeline-and-update-check.md`.

**Cycle 2 deliverable:** `release.test.ts` green; a local `.deb` contains the binary, desktop entry and icons under the expected names; the two workflows parse and match the spec.

## Execution: batched agent cycles

Two cycles, five dispatches each (architect + tdd-tester in parallel → developer → tdd-tester-coverage + code-reviewer in parallel), then a final whole-branch architect review and the orchestrator's gate run. Expected dispatches: about 12, plus fix rounds.

## Verification gate

From `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `cargo tree -i openssl-sys` prints nothing. From the root: `npm run test:coverage` at 100 %, `npm run lint`, `npm run typecheck`, `npx prettier --check .`. Plus the coverage agent's confirmation and the architect's explicit approval of the final implementation.

## Acceptance walk

Spec §11; it needs a pushed tag and a COSMIC session, so it is listed as user checks in the final report.
