# GR-15 — Linux packaging and release pipeline

- Jira: GR-15 "Linux packaging and release pipeline". One spec, one branch
  (`feature/gr-15-linux-packaging`), no slices.
- Depends on: GR-13 (`Transport` trait and `UreqTransport`, the one HTTP
  path in the app), GR-14 (`SettingsDialog` sections, the shell store,
  `useCommands`, toast variants, `appearancePrefs` persistence pattern).
- Follows: ADR 0001/0002 (ADR 0002 §3 asked for `repository` in
  `Cargo.toml` and said "revisit `bundle.targets` in GR-15"; its CSP item is
  already done), the CLAUDE.md rules (HTTP only from Rust through the
  existing `Transport`; the IPC seam; `spawn_blocking`/`run_blocking`; no
  direct `tokio`), the GR-13 rule that the CSP stays unchanged, and the
  100 % front-end coverage gate.
- Date: 2026-10-25. Written unattended by the ticket orchestrator. Every
  decision in §2 is a ruling in the AFK format; person-grade ones are also
  Jira comments on GR-15.

## 1. Goal

A tagged commit becomes an installable Linux release without a human
building anything: CI builds the `.deb`, `.rpm` and AppImage on every push,
a `v*` tag publishes a versioned GitHub release carrying those files, the
installed app shows up in the COSMIC launcher with its own name and icon,
and the running app tells the user when a newer release exists.

### What already exists (not rebuilt here)

The survey of `main` at edfcb9c found:

- `.github/workflows/ci.yml`: one job on `ubuntu-latest` that installs the
  WebKitGTK/GTK build dependencies, then runs lint, typecheck, Vitest, the
  front-end build, `cargo fmt --check`, clippy and `cargo test --workspace`.
  No bundling, no artifacts, no tag or release trigger.
- `src-tauri/tauri.conf.json`: `productName` "Git Real", `version` 0.1.0,
  identifier `com.harmonization.git-real`, `bundle.targets`
  `["deb", "rpm", "appimage"]`, a restrictive CSP. No `category`,
  descriptions, homepage, license or Linux sub-config; no `plugins` key.
- `src-tauri/icons/`: the unmodified Tauri template icons (yellow/cyan
  rings) from the scaffold commit. No SVG source anywhere.
- Three hand-maintained version strings (`package.json`, `tauri.conf.json`,
  `src-tauri/Cargo.toml`, plus `git-real-core`'s own), all `0.1.0`. No tag
  has ever been pushed; `origin` is `github.com/harmonizationllc/git-real`
  (public).
- Networking: `git-real-core::hosting::{Transport, Request, Response,
Method}` over `ureq` + rustls, injected into commands as
  `State<'_, Arc<dyn Transport>>`; `src-tauri/tests/common/mod.rs` has a
  `FakeTransport`. The User-Agent is already `git-real/<CARGO_PKG_VERSION>`.
- UI: `SettingsDialog` with sections Appearance, Diff, Clone, Tools, Git and
  a bottom row (`Keyboard shortcuts…`, `Close`); `SettingsSection` union in
  `src/lib/store/shell.ts`; `useCommands` always-available commands;
  `useToasts.notify({ text, variant, action?, sticky? })`;
  `src/lib/ipc/opener.ts` `openExternal(url)` (https only).
- No version is shown anywhere in the UI and no command exposes one.

### Goals (the ticket's acceptance criteria, mapped)

| AC                                                                           | Delivered by                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1 Build produces .deb and AppImage (and Flatpak if feasible) on CI           | §3 `package` job in `ci.yml`; Flatpak deferred (R2).                           |
| 2 Desktop entry and icon installed so the app appears in the COSMIC launcher | §4 bundle metadata, desktop template, original icon set.                       |
| 3 Wayland and X11 both work; decorations and passthrough behave on COSMIC    | §5 explicit `decorations`, README notes; verified by the acceptance walk only. |
| 4 Versioned GitHub release with artifacts published on tag push              | §6 `release.yml` + version guard.                                              |
| 5 In-app update check notifies when a newer version is available             | §7 core `update` module, `check_for_update` command, About section, toast.     |
| 6 macOS and Windows builds tracked as follow-on stories                      | Two Jira stories opened at the end of the run (§10).                           |

### Non-goals (each becomes a Jira ticket or is already one)

- Flatpak manifest and Flathub submission (R2).
- Downloading or installing the update from inside the app (R1); code
  signing of Linux artifacts; `tauri-plugin-updater`.
- macOS and Windows bundles, notarization, MSI/NSIS (AC 6 follow-ups).
- A version-bump script; the three version strings stay hand-edited but a
  test keeps them equal (R8).
- A native application menu, an About window, crash reporting, telemetry.
- Debian repository / PPA / AUR publishing.

## 2. Decisions (rulings)

Shape: question / options / selected / cost if wrong. **P** = person-grade
(also a Jira comment), **R** = routine (ledger only).

- **R1 (P)** How the app learns about a newer version. A) `tauri-plugin-updater`
  with signed `latest.json` updater artifacts produced by the release job
  (needs a minisign key pair, two GitHub secrets, the `updater` and
  `process` plugins, `reqwest` in the dependency tree, and an `updater`
  capability); B) a `check_for_update` command in Rust that GETs
  `https://api.github.com/repos/harmonizationllc/git-real/releases/latest`
  through the existing `Transport`, compares `tag_name` with
  `CARGO_PKG_VERSION`, and the UI notifies with a link to the release page.
  **Selected B.** The AC asks for a notification, not an install; B adds no
  crate, no secret and no capability, is testable with `FakeTransport`, and
  does not require an unattended agent to generate and park a private
  signing key. Cost if wrong: the toast and About UI stay; a later ticket
  swaps the command's body for the plugin's `check()` and adds signing.
- **R2 (P)** Flatpak. A) add a `packaging/flatpak` manifest and a
  `flatpak-builder` CI job now; B) defer to a follow-up ticket. **Selected
  B.** The AC says "if feasible": `flatpak-builder` is not installed here so
  nothing could be verified, a manifest must point at a published release
  that does not exist yet, and a Flatpak needs its own update path (Flathub),
  not the GitHub check. Cost if wrong: one CI job and one manifest later;
  nothing in this ticket blocks it.
- **R3 (P)** Release publishing mode. A) the tag push publishes a
  non-draft release immediately, with GitHub's generated notes, marked
  pre-release when the tag contains a hyphen (`v0.2.0-beta.1`); B) a draft
  the user publishes by hand. **Selected A.** The AC says "published on tag
  push", and the update check reads `releases/latest`, which ignores drafts.
  Cost if wrong: one `draft:` flag.
- **R4 (P)** Icon. A) keep the Tauri template icons; B) author an original
  Git Real mark as `src-tauri/icons/icon.svg` and regenerate the whole set
  with `tauri icon`. **Selected B.** A launcher entry carrying the framework's
  sample logo is a defect against AC 2 ("icon installed"). The mark is
  deliberately simple (§4.3) so a designer can replace the SVG later. Cost
  if wrong: replace one SVG and rerun one command.
- **R5 (P)** Startup check cadence and privacy. A) check on startup, at
  most once per 24 h, on by default, with a `Check for updates on startup`
  switch in Settings → About; B) opt-in only; C) manual only. **Selected
  A.** The request is one unauthenticated GET to GitHub carrying only the
  existing `git-real/‹version›` User-Agent, and the AC says the app
  "notifies", which a manual-only check does not. Cost if wrong: flip one
  default.
- **R6 (P)** Release workflow implementation. A) hand-written steps
  (`npm run tauri build`, then `softprops/action-gh-release@v2` with file
  globs and `generate_release_notes: true`); B) `tauri-apps/tauri-action@v0`.
  **Selected A.** Every step is visible in the YAML, the same build step is
  shared verbatim with the CI `package` job, and generated release notes
  come for free. Cost if wrong: swap one job body.
- **R7 (R)** `bundle.targets` stays `["deb", "rpm", "appimage"]`: the rpm
  is built in pure Rust at no extra cost and ADR 0002 asked for this list to
  be revisited, not shrunk. All three are released.
- **R8 (R)** The version strings in `package.json`, `src-tauri/tauri.conf.json`
  and `src-tauri/Cargo.toml` must be equal; a Vitest contract test asserts
  it, and the release job refuses a tag whose `vX.Y.Z` differs from
  `tauri.conf.json`. `git-real-core`'s version is independent (it is not
  the app version) and is not checked.
- **R9 (R)** The `package` job runs in the existing `ci.yml` on the same
  `push`/`pull_request` triggers as the test job (the repository is public,
  so Actions minutes are free), as a separate job so a bundling failure is
  attributable. It runs on `ubuntu-22.04` (oldest supported glibc, so the
  AppImage runs on more distributions) and uploads the bundles as a
  workflow artifact kept for 14 days.
- **R10 (R)** Workflow files are tested structurally from Vitest through a
  `yaml` devDependency (parse, then assert triggers, runner, permissions,
  commands and globs). No new crate; one npm devDependency.
- **R11 (R)** The current version reaches the UI through
  `getVersion()` from `@tauri-apps/api/app`, wrapped in `src/lib/ipc/app.ts`
  (the seam allows `@tauri-apps/*` imports; `core:default` already grants
  `core:app:allow-version`). No Rust command for it.
- **R12 (R)** `UpdateInfo` and the new error kind are new wire shapes but
  not persisted; they are part of R1's comment.
- **R13 (R)** Placement: the pure check lives in `git-real-core/src/update.rs`
  (uses `hosting::{Transport, Request, Method}`; the URL is a parameter so
  the core knows no repository); the command in `src-tauri/src/commands/update.rs`;
  the persisted preference in `src/lib/store/updatePrefs.ts`; the startup
  hook in `src/app/useUpdateCheck.ts`; the About section in
  `src/features/settings/AboutSettings.tsx`; the contract tests in
  `src/test/release.test.ts`; the desktop template in
  `src-tauri/packaging/git-real.desktop`.
- **R14 (R)** A short ADR 0003 records R1, R2, R3 and R6 because future
  tickets (signing, Flatpak, macOS) build on them.
- **R15 (R)** README gains `Install`, `Releasing` and `Wayland and X11`
  sections; the Status paragraph drops "packaging … still ahead".

## 3. CI bundling (AC 1)

`.github/workflows/ci.yml` gains a second job:

```yaml
package:
  name: Package (Linux)
  runs-on: ubuntu-22.04
  steps:
    - checkout@v4
    - apt-get install: libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
      librsvg2-dev libssl-dev libxdo-dev pkg-config file patchelf
    - setup-node@v4 (node 24, npm cache)
    - dtolnay/rust-toolchain@stable
    - Swatinem/rust-cache@v2 (workspaces: src-tauri)
    - npm ci
    - npm run tauri build -- --bundles deb,rpm,appimage
    - actions/upload-artifact@v4
        name: git-real-linux-${{ github.sha }}
        path: |
          src-tauri/target/release/bundle/deb/*.deb
          src-tauri/target/release/bundle/rpm/*.rpm
          src-tauri/target/release/bundle/appimage/*.AppImage
        retention-days: 14
        if-no-files-found: error
```

`file` is required by linuxdeploy (the AppImage tool Tauri downloads at
build time); `patchelf` by its plugins. The existing `build-and-test` job is
unchanged. Both jobs get `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`
at workflow level so a force-pushed branch does not queue two release
builds.

## 4. Desktop entry and icon (AC 2)

### 4.1 Bundle metadata (`src-tauri/tauri.conf.json`)

```json
"bundle": {
  "active": true,
  "targets": ["deb", "rpm", "appimage"],
  "category": "DeveloperTool",
  "shortDescription": "Lightweight desktop Git client",
  "longDescription": "Git Real is a lightweight, cross-platform desktop Git client: stage, commit, branch, merge, rebase, stash, tag, sync with remotes and work with pull requests and issues on GitHub, GitLab and Bitbucket.",
  "homepage": "https://github.com/harmonizationllc/git-real",
  "license": "GPL-3.0-only",
  "licenseFile": "../LICENSE",
  "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.png", "icons/icon.icns", "icons/icon.ico"],
  "linux": {
    "deb": { "section": "vcs", "recommends": ["git"], "desktopTemplate": "packaging/git-real.desktop" },
    "rpm": { "desktopTemplate": "packaging/git-real.desktop" }
  }
}
```

`category` `DeveloperTool` maps to the freedesktop `Development` category.
`recommends: git` because every network operation shells out to the git
CLI. `src-tauri/Cargo.toml` gains `repository = "https://github.com/harmonizationllc/git-real"`
(ADR 0002 §3).

On Linux the Tauri CLI renames the binary to the kebab-cased product name,
so the binary, the desktop file and the icon are all `git-real`
(`/usr/bin/git-real`, `/usr/share/applications/git-real.desktop`,
`/usr/share/icons/hicolor/‹size›/apps/git-real.png`). Under Wayland GTK 3
sets the `app_id` to the program name, so COSMIC matches the running window
to that desktop file and shows the icon in the dock. Neither the rename
rule nor the default template's variables can be verified locally (the
bundler sources are not in the cargo registry; the CLI is the npm binary),
so the developer confirms the names by building the `.deb` locally and
listing it with `dpkg-deb -c`; if Tauri produces a different name, the
template and this section follow Tauri, not the other way round.

### 4.2 Desktop template (`src-tauri/packaging/git-real.desktop`)

Tauri's Handlebars template with two additions, `Keywords` (COSMIC's
launcher searches it) and `StartupNotify`:

```ini
[Desktop Entry]
Categories={{categories}}
{{#if comment}}
Comment={{comment}}
{{/if}}
Exec={{exec}} {{exec_arg}}
Icon={{icon}}
Name={{name}}
Terminal=false
Type=Application
Keywords=git;vcs;version control;repository;commit;branch;
StartupNotify=true
{{#if mime_type}}
MimeType={{mime_type}}
{{/if}}
```

### 4.3 Icon (`src-tauri/icons/icon.svg`, then `npx tauri icon src-tauri/icons/icon.svg`)

An original mark, 1024×1024 `viewBox`, no text, no external references:

- Background: a rounded square (corner radius 224) filled with a vertical
  gradient from `#2563eb` (top) to `#1e3a8a` (bottom).
- Foreground, stroke `#ffffff`, stroke width 72, round caps and joins, no
  fill: a vertical trunk from (384, 232) to (384, 792); a branch leaving the
  trunk at (384, 420) as a cubic curve to (640, 300) and continuing down to
  (640, 560), then curving back into the trunk at (384, 700).
- Three commit nodes, filled `#ffffff` with a `#1e3a8a` 40-wide stroke:
  circles of radius 84 at (384, 232), (384, 792) and (640, 430).

`tauri icon` regenerates `32x32.png`, `128x128.png`, `128x128@2x.png`,
`icon.png`, `icon.icns`, `icon.ico` and the `Square*`/`StoreLogo` files in
place; the `android/` and `ios/` directories it also writes are deleted
(mobile is not a target) and `icon.svg` is committed as the source of truth.

### 4.4 Tests

`src/test/release.test.ts` (Node `fs` + `JSON.parse`, `yaml`, `DOMParser`;
paths resolved from `__dirname` as `src/styles/tokens.test.ts` does, never
from `process.cwd()`; helpers stay inside the test file so they are not
counted by coverage):

- `tauri.conf.json`: `bundle.active`, `targets` exactly the three above,
  `category === "DeveloperTool"`, non-empty `shortDescription`,
  `longDescription`, `homepage`, `license`, `icon` includes `icons/icon.png`,
  `linux.deb.recommends` includes `git`, both `desktopTemplate`s point at a
  file that exists.
- The desktop template contains `Type=Application`, `Terminal=false`,
  `Keywords=` with `git;`, and the Handlebars `{{exec}}`, `{{icon}}`,
  `{{name}}`, `{{categories}}` placeholders.
- `icon.svg` parses as SVG, `viewBox` is `0 0 1024 1024`, and it contains
  no `<image>`, `<script>` or `href` to another file.
- Every PNG listed in `bundle.icon` exists and is not byte-identical to the
  Tauri template file of the same name (the template sizes are recorded as
  `TEMPLATE_SIZES` in the test: `32x32.png` 567 bytes, `128x128.png` 1593,
  `128x128@2x.png` 2861, `icon.png` 5664).

## 5. Wayland and X11 (AC 3)

- `app.windows[0].decorations: true` is written explicitly (today it is the
  implicit default), so the intent is visible next to `resizable`.
- Nothing else changes in code: on COSMIC, GTK 3 negotiates server-side
  decorations through the KDE decoration protocol, which `cosmic-comp`
  implements; under X11 the window manager decorates. There is no
  automated way to prove either, so the acceptance walk (§11) covers it and
  the README's `Wayland and X11` section documents the two switches a user
  may need: `GDK_BACKEND=x11 git-real` to force X11, and
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` if WebKitGTK shows a blank window on
  some NVIDIA/Wayland stacks.

## 6. Release on tag push (AC 4)

`.github/workflows/release.yml`:

```yaml
name: Release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
concurrency:
  group: release-${{ github.ref }}
jobs:
  release:
    runs-on: ubuntu-22.04
    steps:
      - checkout@v4
      - (same apt, node, rust, rust-cache, npm ci steps as the package job)
      - name: Check the tag matches the app version
        run: |
          tag="${GITHUB_REF_NAME#v}"
          conf="$(node -p "require('./src-tauri/tauri.conf.json').version")"
          test "$tag" = "$conf" || { echo "tag v$tag != tauri.conf.json $conf"; exit 1; }
      - npm run tauri build -- --bundles deb,rpm,appimage
      - softprops/action-gh-release@v2
          name: Git Real ${{ github.ref_name }}
          generate_release_notes: true
          prerelease: ${{ contains(github.ref_name, '-') }}
          fail_on_unmatched_files: true
          files: |
            src-tauri/target/release/bundle/deb/*.deb
            src-tauri/target/release/bundle/rpm/*.rpm
            src-tauri/target/release/bundle/appimage/*.AppImage
```

Release procedure (README `Releasing`): set the same version in
`package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, run
`npm test` (the contract test checks they agree), commit, `git tag vX.Y.Z`,
`git push origin main vX.Y.Z`. Nothing else is manual. A tag that does not
match fails before building.

### 6.1 Tests (`src/test/release.test.ts`)

- The three app version strings are equal and semver-shaped (`\d+\.\d+\.\d+`).
- `release.yml` parses; triggers on `push.tags` containing `v*` only;
  `permissions.contents === "write"`; runner `ubuntu-22.04`; a step runs
  `npm run tauri build` with `deb,rpm,appimage`; the gh-release step's
  `files` lists the three globs, `generate_release_notes: true`,
  `fail_on_unmatched_files: true`; a step named like the version check
  exists before the build step.
- `ci.yml` parses; has jobs `build-and-test` and `package`; `package` runs
  on `ubuntu-22.04`, runs the same build command, uploads the three globs
  with `if-no-files-found: error`; both workflows install the same apt
  packages as the README's Development section (parsed from the README's
  fenced block, so the three lists cannot drift).

## 7. In-app update check (AC 5)

### 7.1 Core (`git-real-core/src/update.rs`)

```rust
/// `MAJOR.MINOR.PATCH[-PRE]`, with or without a leading `v`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version { pub major: u64, pub minor: u64, pub patch: u64, pub pre: Option<String> }
impl Version {
    pub fn parse(s: &str) -> Option<Version>;   // trims, strips one leading 'v'/'V'; rejects anything else
}
impl Ord for Version { /* numeric triple; a pre-release sorts below the plain release; two pre-releases compare as strings */ }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,            // CARGO_PKG_VERSION as given
    pub latest: Option<String>,     // the release's tag without the leading 'v'; None when no release exists
    pub available: bool,            // latest > current
    pub url: Option<String>,        // the release's html_url
}

/// One GET of the "latest release" endpoint. 200 → parsed; 404 → no release yet
/// (available=false, latest=None); anything else → UpdateCheckFailed.
pub fn check_for_update(transport: &dyn Transport, current: &str, api_url: &str) -> Result<UpdateInfo, GitError>;
```

- Request headers: `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`. No authentication.
- Errors are all `GitError::UpdateCheckFailed { message }` (new variant,
  `#[error("update check failed: {message}")]`): a transport error is
  rewrapped with its message, a non-200/404 status becomes
  `GitHub answered ‹status›` (403 adds `(rate limited)` when the
  `x-ratelimit-remaining` header is `0`), a body that is not JSON or lacks
  a string `tag_name`/`html_url` becomes `unexpected response`, a tag that
  does not parse becomes `unrecognised release tag ‹tag›`, and an
  unparseable `current` is a programming error reported the same way.
- `From<GitError>` maps it to the new unit `AppErrorKind::UpdateCheckFailed`
  (camelCase `updateCheckFailed`), added to both `types.ts` and `errors.ts`.
  The match in `src-tauri/src/error.rs` is exhaustive, so the new arm is
  compiler-enforced.
- Wiring: `pub mod update;` plus `pub use update::{UpdateInfo, Version};`
  in `git-real-core/src/lib.rs`; `pub mod update;` in
  `src-tauri/src/commands/mod.rs`; the command added to
  `generate_handler!` in `src-tauri/src/lib.rs` (86 entries today; easy to
  miss, so the app test calls the command through the registered handler
  path the other command tests use).

### 7.2 Command (`src-tauri/src/commands/update.rs`)

```rust
pub const RELEASES_API_URL: &str = "https://api.github.com/repos/harmonizationllc/git-real/releases/latest";

#[tauri::command]
pub async fn check_for_update(transport: State<'_, Arc<dyn Transport>>) -> Result<UpdateInfo, AppError>;
// run_blocking(move || update::check_for_update(&*transport, env!("CARGO_PKG_VERSION"), RELEASES_API_URL)).map_err(Into::into)
```

Registered in `generate_handler!`. No new capability (Rust does the HTTP;
the CSP is untouched).

### 7.3 IPC seam

- `src/lib/ipc/update.ts`: `checkForUpdate(): Promise<UpdateInfo>` →
  `invoke("check_for_update")`.
- `src/lib/ipc/app.ts`: `appVersion(): Promise<string>` → `getVersion()`
  from `@tauri-apps/api/app` (R11). Tests mock `plugin:app|version`.
- `types.ts`: `interface UpdateInfo { current: string; latest: string | null; available: boolean; url: string | null }`;
  `AppErrorKind` += `"updateCheckFailed"`; `errors.ts` `KINDS` += the same.
- `index.ts` re-exports both new modules. `queryKeys.appVersion = ["appVersion"]`.

### 7.4 Preference store (`src/lib/store/updatePrefs.ts`)

zustand `persist`, key `git-real.updatePrefs`, `version: 1`:

```ts
interface UpdatePrefs {
  checkOnStartup: boolean; // default true
  lastCheckedAt: number | null; // epoch ms of the last completed startup check
  setCheckOnStartup(on: boolean): void;
  markChecked(at: number): void;
}
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const STARTUP_DELAY_MS = 10_000;
```

### 7.5 Startup hook (`src/app/useUpdateCheck.ts`, mounted once in `App.tsx`)

- On mount: if `checkOnStartup` is false, or `lastCheckedAt` is less than
  `CHECK_INTERVAL_MS` ago, do nothing. Otherwise after `STARTUP_DELAY_MS`
  call `checkForUpdate()`.
- Success: `markChecked(Date.now())`; when `available`, toast
  `notify({ variant: "info", sticky: true, text: "Git Real ‹latest› is available", action: { label: "Release notes", run: () => openExternal(url) } })`.
  The action is omitted when `url` is null.
- Failure: swallowed (also `markChecked`, so a broken network does not
  retry on every launch within the day). No toast, no console noise.
- Unmount clears the timer; the check runs at most once per mount.

### 7.6 Settings → About (`src/features/settings/AboutSettings.tsx`)

New last section (`SettingsSection` += `"about"`), `<h3>About</h3>`,
wrapped in the dialog's existing `Section` helper with `data-section="about"`
so the shell store's `section` focus mechanism reaches it:

- Line `Git Real ‹version›` (from `useQuery(queryKeys.appVersion, appVersion)`;
  `Git Real` alone while loading or on error).
- Checkbox `Check for updates on startup` bound to `checkOnStartup`.
- Button `Check for updates`; while running it is disabled and reads
  `Checking…`.
- Result line, `role="status"`: `You're up to date` when not available;
  `Git Real ‹latest› is available` followed by a button `Release notes`
  (`openExternal(url)`) when available; `No releases published yet` when
  `latest` is null. A failure shows `Couldn't check for updates: ‹message›`
  in a `role="alert"` instead. A manual check does not touch
  `lastCheckedAt`.
- A link row: button `Source and issues` → `openExternal("https://github.com/harmonizationllc/git-real")`.

The palette gains the always-available command `Check for updates…` which
opens Settings at `about` (one code path; the user presses the button).

### 7.7 Tests

- **Core (`cargo test -p git-real-core`):** `Version::parse` table
  (`v1.2.3`, `1.2.3`, `1.2.3-beta.1`, rejects `1.2`, `a.b.c`, `1.2.3.4`,
  empty); ordering table (patch/minor/major, pre-release below release,
  pre-release strings); `check_for_update` with a local fake `Transport`:
  newer → `available: true` with `latest`/`url`; equal and older → false;
  404 → `latest: None`; 403 with `x-ratelimit-remaining: 0`; 500; invalid
  JSON; missing `tag_name`; unparseable tag; transport error; the request
  sent carries the two headers and the given URL.
- **App (`cargo test --workspace`):** the command body with `FakeTransport`
  maps to `updateCheckFailed`; `From<GitError::UpdateCheckFailed>`.
- **Front end (Vitest, 100 %):** `update.ts`/`app.ts` wrappers; `errors.ts`
  KINDS; `updatePrefs` defaults, key, version, setters; `useUpdateCheck`
  (fake timers: delay, disabled, within 24 h, older than 24 h, available
  with and without url, not available, failure swallowed, unmount clears);
  `AboutSettings` (version line, checkbox, button states, three result
  copies, alert, `Release notes` and `Source and issues` open the URL,
  manual check leaves `lastCheckedAt`); `useCommands` has
  `Check for updates…` opening `{ kind: "settings", section: "about" }`;
  `SettingsDialog` renders About last and focuses it for `section: "about"`;
  `src/test/release.test.ts` (§4.4, §6.1).

## 8. Error handling summary

| Failure                                   | Surface                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| startup check fails (offline, rate limit) | nothing; retried after 24 h                                             |
| manual check fails                        | `Couldn't check for updates: ‹message›` alert in About                  |
| no release published                      | startup: nothing; manual: `No releases published yet`                   |
| tag does not match the version            | release job fails before building; nothing is published                 |
| bundle missing in CI                      | `if-no-files-found: error` / `fail_on_unmatched_files` fail the job     |
| release notes link is not https           | `openExternal` refuses (existing rule); the button does nothing visible |

## 9. Verification gate

From `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo fmt --check`, `cargo tree -i openssl-sys` prints nothing. From the
root: `npm run test:coverage` at 100 % statements/branches/functions/lines
(there is no threshold in `vite.config.ts`; the gate is the coverage agent
reading the table, and a source file no test imports never appears in it,
so every new `src/` file must be imported by at least one test),
`npm run lint`, `npm run typecheck`, `npx prettier --check .`. Plus a local
`npm run tauri build -- --bundles deb` by the developer, with `dpkg-deb -c`
showing `usr/bin/git-real`, `usr/share/applications/git-real.desktop` and
the hicolor icons (the AppImage needs linuxdeploy downloads and is left to
CI). Plus the coverage agent's confirmation and the architect's approval.

## 10. Follow-up tickets opened at the end of the run

- Flatpak manifest and CI job (R2).
- macOS build, signing and notarization (AC 6).
- Windows build, MSI/NSIS and code signing (AC 6).
- Signed in-app updates with `tauri-plugin-updater` (R1), if wanted later.

## 11. Acceptance walk (manual; the user, on COSMIC)

1. Push a tag `v0.1.0` (or bump to `0.1.1` first): the `Release` workflow
   publishes "Git Real v0.1.0" with a `.deb`, `.rpm` and `.AppImage`.
2. `sudo apt install ./git-real_0.1.0_amd64.deb`; Super → type `git`: the
   launcher lists Git Real with the blue branch icon; launch it; the dock
   shows the same icon and title; the window has COSMIC's server-side
   decorations and resizes from every edge.
3. `GDK_BACKEND=x11 git-real`: the window opens under XWayland with
   decorations; drag and drop into the Changes panel and clipboard copy
   work in both sessions.
4. `chmod +x Git.Real_0.1.0_amd64.AppImage && ./Git.Real_0.1.0_amd64.AppImage`
   starts without installing anything.
5. Settings → About shows `Git Real 0.1.0`; `Check for updates` reports
   `You're up to date`. Publish a `v0.1.1` later, relaunch: after ten
   seconds the toast `Git Real 0.1.1 is available` appears; `Release notes`
   opens the release page.
6. `dpkg -r git-real` to clean up.
