# GR-24 — Windows build and installer

- Jira: GR-24 "Windows build, installer and code signing". One spec, one
  branch (`feature/gr-24-windows-build`), no slices.
- Depends on: GR-15 (Linux packaging, tag-driven release, the
  `src/test/release.test.ts` contract tests, ADR 0003), GR-20 (the Windows
  command splitter in `tools.rs`, the `git.exe` lookup in `git_cli.rs`, and
  the `core-windows` CI job that proves `git-real-core` compiles and tests
  green on Windows).
- Follows: ADR 0003 R3 (tag push publishes immediately, non-draft) and R6
  (hand-written workflow steps, no `tauri-action`), the CLAUDE.md rules
  (hybrid git backend untouched; nothing platform-specific enters
  `git-real-core`), and the GR-20 rules for what may be gated or fixed when
  Windows disagrees with the code.
- Date: 2026-10-27. Written with the owner in the brainstorming session;
  decisions marked **owner** were theirs, decisions marked **call** are the
  author's and the owner may overturn them while reading.

## 1. Goal

A `v*` tag produces a GitHub release that carries Windows installers next
to the Linux packages, built by the same workflow with no human step. CI
builds those installers on every push so a Windows compile break is caught
when it lands, not when a release is cut. The Tauri bundle configuration is
laid out per platform so the macOS story that follows adds one file and one
job without touching Linux or Windows.

### What already exists (not rebuilt here)

Survey of `main` at 4476849:

- `.github/workflows/ci.yml`: `build-and-test` (Linux lint, typecheck,
  Vitest, front-end build, fmt, clippy, `cargo test --workspace`),
  `core-windows` (clippy and tests for `git-real-core` only, on
  `windows-latest`, with a `git config --system core.autocrlf false` step
  before checkout), `package` (Linux deb/rpm/appimage bundles uploaded as a
  14-day artifact), `bench`. Workflow-level concurrency cancels stale runs
  per ref.
- `.github/workflows/release.yml`: one `release` job on `ubuntu-22.04`,
  triggered by `push.tags: ["v*"]`, with a version guard step ("Check the
  tag matches the app version") comparing `GITHUB_REF_NAME` against
  `tauri.conf.json`, then the Linux build, then
  `softprops/action-gh-release@v2` with generated notes, hyphen means
  pre-release, `fail_on_unmatched_files: true`.
- `src-tauri/tauri.conf.json`: version 0.1.0, `bundle.targets`
  `["deb", "rpm", "appimage"]`, shared metadata (category, descriptions,
  homepage, license, icon list including `icons/icon.ico`), and a
  `bundle.linux` block (deb section `vcs`, recommends `git`, desktop
  template for deb and rpm). No `tauri.<platform>.conf.json` files exist.
- `src-tauri/icons/`: the GR-15 set, including `icon.ico` and the
  `Square*Logo.png` / `StoreLogo.png` files. Nothing to regenerate.
- `src-tauri/src/main.rs` already has
  `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`, so a
  release build opens no console window. No `std::os::unix` use anywhere in
  `src-tauri/src/`.
- The ticket's three Windows gaps: the POSIX-only command splitter and the
  `git`-without-`.exe` lookup were both closed in GR-20. The third, the
  `keyring` crate's `windows-native` feature, has never been compiled
  because no job builds the app crate on Windows. That is the one known
  unknown of this story.
- `src/test/release.test.ts`: contract tests that pin the workflow shape,
  the bundle config, the desktop template, the icon source, and the apt
  package lists. Several assertions pin exactly the layout this story
  changes (targets array, `jobs.package`, `jobs.release.steps`).
- README `## Install` (Linux only), `## Releasing` (three version strings,
  tag procedure), `## Development` (Linux apt prerequisites).
- The in-app update check (ADR 0003 R1) reads `releases/latest` and opens
  `html_url`. It needs no change: a Windows user lands on the release page
  and downloads the installer by hand.

### Goals (the ticket, mapped)

| Ticket item                                             | Delivered by                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| Windows installer from the release workflow, attached   | §4 `build-windows` job and the `publish` job in `release.yml`.      |
| NSIS `.exe` and/or MSI                                  | Both (§3). **Call.**                                                |
| Code-signed                                             | Not in this story (§2, R4). Recipe recorded in ADR 0006; follow-up. |
| `bundle.targets` per platform                           | §3 overlay files. **Owner** chose full symmetry for macOS next.     |
| Known Windows gaps (splitter, `.exe` lookup, `keyring`) | First two already closed by GR-20; `keyring` is proven by §5.       |
| Extend `src/test/release.test.ts`                       | §6.                                                                 |

### Non-goals

- Code signing, Azure Trusted Signing account setup, or a signing step in
  any workflow. See R4.
- macOS. This story only makes room for it (§3).
- Fixing GR-32..GR-36 or any other Windows runtime bug. Only compile-time
  problems that block the Windows build are in scope (§5).
- `tauri-plugin-updater` (GR-25), Flatpak, ARM builds, Microsoft Store.
- Running the app's integration tests (`src-tauri/tests`) on Windows. The
  Windows jobs build; they do not test. `core-windows` keeps testing core.

### Anti-goals

- A Windows job that is green because it silently skipped bundling. Every
  upload uses `if-no-files-found: error` and the publish step keeps
  `fail_on_unmatched_files: true`.
- A release where Linux files are published and Windows files are missing,
  or the reverse. One publish job, after both builds, or no release.
- Platform-specific code or `cfg` in `git-real-core` (CLAUDE.md).

## 2. Decisions

- **R1 — Unsigned Windows installers now.** **Owner.** The owner has no
  certificate and no Azure Trusted Signing account; this is the first time
  signing has come up. SmartScreen will show "Windows protected your PC"
  on first launch of the installer; README documents the click-through.
- **R2 — Per-platform Tauri overlay files, full symmetry.** **Owner.**
  `tauri.conf.json` keeps what is shared; `tauri.linux.conf.json` and
  `tauri.windows.conf.json` each own their `bundle.targets` and
  platform block. The owner is adding macOS soon and wants that story to
  add `tauri.macos.conf.json` and nothing else in config.
- **R3 — Build jobs upload artifacts; one publish job creates the release.**
  **Call.** The current single job becomes `check-version`, `build-linux`,
  `build-windows`, `publish`. Two jobs both calling `action-gh-release`
  against the same tag would race on creating the release and could leave
  a half-populated release visible to the update check (ADR 0003 R3 says
  releases are non-draft). The publish job runs only when both builds
  succeeded, downloads both artifacts, and publishes once.
- **R4 — Signing stays out of the code.** **Call.** No `signCommand`, no
  conditional signing step, no secrets referenced. A path nobody can
  exercise until an Azure account exists would ship untested; the
  conditional-on-secret pattern in Actions also needs an env indirection
  that is easy to get wrong. ADR 0006 records the recipe (`bundle.windows.
signCommand` in `tauri.windows.conf.json` wrapping `trusted-signing-cli`,
  Azure credentials as repository secrets, a `trusted-signing-cli` install
  step before the build), so turning it on is a small, well-described
  follow-up story. The orchestrator files that Jira story at finish.
- **R5 — Both NSIS and MSI.** **Call.** One build produces both; NSIS is
  the double-click installer Tauri recommends (per-user, no admin prompt),
  MSI is what managed deployments want. `installMode: currentUser` for
  NSIS matches the Linux per-user AppImage experience and avoids a UAC
  prompt. WebView2 install mode stays at Tauri's default
  (`downloadBootstrapper`).
- **R6 — Explicit `--bundles` in every build step.** **Call.** Each job
  passes its platform's list even though the overlay would supply it, so
  the workflow reads correctly without opening the config, and the
  existing test style (assert the flag text) carries over.
- **R7 — CI gets a `package-windows` job.** **Call**, flagged to the owner
  as the one most worth vetoing. The repo is public so Actions minutes are
  free; without it the first Windows compile of any change happens on a
  tag push, which is the worst moment. The existing Linux job is renamed
  `package-linux` (display name stays "Package (Linux)") for symmetry.
- **R8 — Windows compile problems follow the GR-20 rules.** **Call.** If
  the app crate fails to compile or bundle on Windows: (1) a fix that is
  a gate, an import, or a one-line platform branch in `src-tauri/src/` is
  made in this story with a comment; (2) nothing in `git-real-core`
  changes (it already compiles and tests green on Windows); (3) anything
  larger is a Jira ticket and, if it blocks the build, the owner is asked
  before working around it. The expected first-round risks are `keyring`
  with `windows-native`, and the `notify` crate, both of which should just
  compile.
- **R9 — Version guard becomes its own first job.** **Call.** A guard that
  fails in seconds should stop both ten-minute builds from starting; a
  separate `check-version` job that `build-linux` and `build-windows`
  `need` does that. The script is the existing one, run with
  `shell: bash` so it is identical on both runners if it is ever moved,
  extended by one check (R10).
- **R10 — Pre-release identifiers are numeric.** **Call**, flagged to the
  owner. WiX accepts only `MAJOR.MINOR.PATCH.N` with every part numeric;
  Tauri's MSI bundler maps a semver pre-release such as `0.2.0-1` to
  `0.2.0.1` and rejects `0.2.0-beta.1` outright ("pre-release identifier
  must be numeric-only"). Because `publish` needs both builds, a
  `vX.Y.Z-beta.1` tag would publish nothing, Linux included. The rule
  adopted: a pre-release version is `X.Y.Z-N` with `N` an integer from 1
  to 65535, written the same way in the three version files and the tag.
  The `check-version` script enforces this shape and fails with a message
  naming the rule. README `## Releasing` replaces its `vX.Y.Z-beta.1`
  example with `vX.Y.Z-1`. The alternative, NSIS only on pre-release tags,
  would make the asset list conditional in two places and was rejected.
  No tag has been cut yet, so no existing convention is broken.
- **R11 — Windows build steps run under `shell: bash`.** **Call.** The
  `windows-latest` default shell is PowerShell, which splits an unquoted
  `nsis,msi` into two arguments before the Tauri CLI sees it. Every `run`
  step in `package-windows` and `build-windows` sets `shell: bash` (Git
  Bash is on the runner image). The step text still contains the literal
  `--bundles nsis,msi`, so the §6 assertion is unchanged.
- **R12 — Release download names carry a dot, not a space.** **Call.**
  GitHub replaces spaces in release asset names with dots, so the file a
  user downloads from the release page is `Git.Real_X.Y.Z_x64-setup.exe`,
  and the existing Linux text in README `## Install` (`Git Real_<version>_
amd64.deb`) is already wrong for a download, though right for a CI
  artifact. README documents the download names with the dot for all five
  files and says why in one sentence. The CI artifact keeps the original
  names; §3 confirms those from the artifact, and the dotted download names
  are confirmed by the owner at the first tag (not in this story). Renaming
  files in the publish job to avoid the space was rejected: it would invent
  a third spelling of the product name.

## 3. Tauri configuration

Tauri merges `src-tauri/tauri.<platform>.conf.json` over `tauri.conf.json`
at build time on that platform, using JSON Merge Patch: objects merge key
by key, arrays and scalars are replaced whole. The builder verifies this
holds for `bundle.targets` by building on Linux after the move and checking
that exactly deb, rpm and AppImage come out and that the `.deb` still
carries `Recommends: git` and the desktop template (that proves the moved
`bundle.linux` block is read).

`src-tauri/tauri.conf.json` after the change:

- Keeps `$schema`, `productName`, `version`, `identifier`, `build`, `app`,
  and under `bundle`: `active`, `category`, `shortDescription`,
  `longDescription`, `homepage`, `license`, `licenseFile`, `icon`.
- Drops `bundle.targets` and `bundle.linux`. With no `targets`, Tauri's
  default is `"all"`, which on a platform with no overlay builds that
  platform's native formats. Linux and Windows always have an overlay; a
  macOS build before its overlay exists would produce `app` and `dmg`,
  which is acceptable as a fallback and is caught by the test in §6 that
  requires an overlay per platform the workflows build.

`src-tauri/tauri.linux.conf.json` (new):

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "bundle": {
    "targets": ["deb", "rpm", "appimage"],
    "linux": {
      "deb": {
        "section": "vcs",
        "recommends": ["git"],
        "desktopTemplate": "packaging/git-real.desktop"
      },
      "rpm": {
        "desktopTemplate": "packaging/git-real.desktop"
      }
    }
  }
}
```

The `linux` block is the existing one moved verbatim.

`src-tauri/tauri.windows.conf.json` (new):

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "bundle": {
    "targets": ["nsis", "msi"],
    "windows": {
      "nsis": {
        "installMode": "currentUser"
      }
    }
  }
}
```

Nothing else under `bundle.windows` is set: `webviewInstallMode` keeps its
default, `wix` keeps its defaults (language `en-US`), icons fall back to
`icons/icon.ico`, `allowDowngrades` keeps its default of true. The
`signCommand` key is where signing goes later (R4); it is not present now.

Bundle output paths and file names (Tauri 2.12 defaults, product name
"Git Real", version `X.Y.Z`):

| Platform | Path under `src-tauri/target/release/bundle/` | File name                       |
| -------- | --------------------------------------------- | ------------------------------- |
| Linux    | `deb/`                                        | `Git Real_X.Y.Z_amd64.deb`      |
| Linux    | `rpm/`                                        | `Git Real-X.Y.Z-1.x86_64.rpm`   |
| Linux    | `appimage/`                                   | `Git Real_X.Y.Z_amd64.AppImage` |
| Windows  | `nsis/`                                       | `Git Real_X.Y.Z_x64-setup.exe`  |
| Windows  | `msi/`                                        | `Git Real_X.Y.Z_x64_en-US.msi`  |

The builder confirms the Windows names from the first green CI artifact and
corrects the README if Tauri's output differs.

## 4. Workflows

### 4.1 `ci.yml`

- `package` is renamed `package-linux`; its display name "Package (Linux)"
  and every step stay as they are.
- New job `package-windows`, display name "Package (Windows)", on
  `windows-latest`:
  1. Checkout (`actions/checkout@v4`).
  2. Set up Node 24 with npm cache (`actions/setup-node@v4`).
  3. Set up Rust stable (`dtolnay/rust-toolchain@stable`; the runner's
     default host is `x86_64-pc-windows-msvc`, which is what Tauri wants).
  4. Cache Rust build (`Swatinem/rust-cache@v2`, `workspaces: src-tauri`).
  5. `npm ci`.
  6. `npm run tauri build -- --bundles nsis,msi`. Tauri downloads NSIS and
     WiX itself on first use; no install step is needed.
  7. Upload with `actions/upload-artifact@v4`: name
     `git-real-windows-${{ github.sha }}`, paths
     `src-tauri/target/release/bundle/nsis/*.exe` and
     `src-tauri/target/release/bundle/msi/*.msi`, `retention-days: 14`,
     `if-no-files-found: error`.
- No `core.autocrlf` step: this job runs no tests, and the front-end build
  and bundling are indifferent to line endings. **Call**; the builder may
  add the step if the build turns out to care.
- No `timeout-minutes` beyond the default, matching `package-linux`.

### 4.2 `release.yml`

Trigger, permissions (`contents: write`) and concurrency are unchanged.
Jobs:

- `check-version` on `ubuntu-latest`: checkout, then the existing step
  "Check the tag matches the app version" with its script extended by one
  test: the version (tag without `v`) must match
  `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$` (R10). It needs only `node` and
  `bash`, both present on the runner image.
- `build-linux` on `ubuntu-22.04`, `needs: check-version`: the existing
  apt install, Node, Rust, cache, `npm ci`, build with
  `--bundles deb,rpm,appimage`, then upload artifact `release-linux` with
  the three Linux globs, `if-no-files-found: error`, `retention-days: 1`.
  The apt package list stays identical to `package-linux` and the README
  (the existing contract test enforces this; it must be pointed at the new
  job id).
- `build-windows` on `windows-latest`, `needs: check-version`: the same
  steps as `package-windows` in CI, uploading artifact `release-windows`
  with the two Windows globs, `if-no-files-found: error`,
  `retention-days: 1`.
- `publish` on `ubuntu-latest`, `needs: [build-linux, build-windows]`:
  `actions/download-artifact@v4` with `pattern: release-*`,
  `merge-multiple: true`, `path: release-assets`; then
  `softprops/action-gh-release@v2` with `name: Git Real ${{ github.ref_name }}`,
  `generate_release_notes: true`,
  `prerelease: ${{ contains(github.ref_name, '-') }}`,
  `fail_on_unmatched_files: true`, and five explicit globs:
  `release-assets/*.deb`, `release-assets/*.rpm`,
  `release-assets/*.AppImage`, `release-assets/*.exe`,
  `release-assets/*.msi`. Five globs rather than `release-assets/*` so a
  missing format fails the publish instead of shipping four files.
- Job-level `permissions: contents: write` may be scoped to `publish` only;
  the workflow-level grant may then be dropped. **Call**, builder's choice;
  the test in §6 accepts either as long as `publish` has write.

## 5. Proving the Windows build

Nothing in this environment can compile the Windows app crate: the host is
Linux, and a `x86_64-pc-windows-gnu` cross-build is not what Tauri ships.
The proof is CI. The builder:

1. Lands the config and workflow changes on the feature branch and pushes
   it (a remote feature branch is normal here, GR-20 did the same).
2. Watches `package-windows`. On a compile or bundle failure, applies R8,
   pushes, repeats. Each round is a commit on the branch with the failure
   and the fix named in the message, and the spec's §5.1 records the
   rounds, as GR-20 §6.1 did.
3. Downloads the first green `git-real-windows-*` artifact and records the
   actual file names and sizes in §5.1. The two installers must exist and
   be larger than 5 MB each (a bundle that is only the WebView2 bootstrapper
   or an empty wrapper is smaller). This is a one-time hand check recorded
   in §5.1, not a workflow step; the workflows guard existence with
   `if-no-files-found: error` and `fail_on_unmatched_files: true` only.
   **Call.**
4. Does not run the installers. The owner has no Windows machine in this
   session; an owner smoke test on real Windows (install, launch, open a
   repo, uninstall) is listed as an outstanding check in the status memory,
   as GR-19's desktop checks were.

### 5.1 Probe results

Filled in by the builder.

## 6. Tests (`src/test/release.test.ts`)

Written by the test role before any workflow or config change, per the
TDD policy. The existing file is restructured, not appended to blindly.

Assertions that must change:

- `bundle config › targets are deb, rpm, appimage` moves to a new
  `platform overlays` block: `tauri.linux.conf.json` has exactly
  `["deb", "rpm", "appimage"]`; `tauri.windows.conf.json` has exactly
  `["nsis", "msi"]` and `bundle.windows.nsis.installMode === "currentUser"`.
- `bundle config › deb recommends git and both desktop templates exist`
  reads the `linux` block from `tauri.linux.conf.json`.
- New: `tauri.conf.json` has no `bundle.targets` and no `bundle.linux` key
  (the base stays shared-only).
- New: every `src-tauri/tauri.*.conf.json` on disk sets `bundle.targets`
  to a non-empty array, and the set of platform files is exactly
  `{linux, windows}` for now (the macOS story extends this list on
  purpose).
- New: `tauri.windows.conf.json` has no `signCommand`,
  `certificateThumbprint` or `timestampUrl` (R4; the signing story deletes
  this assertion).
- `ci workflow`: `jobs.package` becomes `jobs["package-linux"]` with the
  same assertions; new `jobs["package-windows"]` on `windows-latest`,
  build step contains `--bundles nsis,msi`, upload name contains
  `git-real-windows-`, both Windows globs, `if-no-files-found: error`,
  `retention-days: 14`; the Windows job has no `apt-get` step.
- `release workflow`: `check-version` exists and contains the guard step
  with `GITHUB_REF_NAME`, `tauri.conf.json` and the R10 shape check (the
  assertion looks for the regex text `(-[0-9]+)?`); `build-linux` and
  `build-windows` both `need` `check-version`; `publish` `needs` both
  builds; the build steps carry their `--bundles` lists; `build-linux`
  runs on `ubuntu-22.04`, `build-windows` on `windows-latest`; `publish`
  has `download-artifact@v4` with `merge-multiple: true` before the
  `action-gh-release@v2` step; the release step keeps `generate_release_
notes`, `fail_on_unmatched_files`, the `prerelease` expression, the
  `Git Real` name, and lists all five globs; no job other than `publish`
  uses `action-gh-release`; `publish` has `contents: write` either on the
  job or inherited from the workflow.
- `apt packages`: reads `jobs["package-linux"]` and `jobs["build-linux"]`.
- README: `## Install` contains a Windows subsection naming the `-setup.exe`
  and `.msi` files and the word "SmartScreen"; every download file name in
  `## Install` is spelled `Git.Real` (R12) and the string `Git Real_` does
  not appear in that section; `## Releasing` mentions the Windows
  installers and contains `-1` as the pre-release example, not `-beta`;
  the README intro no longer lists Windows as a follow-on target.

Everything else in the file (versions, icons, desktop template, bench
workflow) is untouched.

## 7. Documentation

- **README intro and `## Status`**: wherever the text says Windows is a
  follow-on target or that only Linux packages are published, it now says
  Linux and Windows are built and macOS is the follow-on.
- **README `## Install`**: the Linux file names change from `Git Real_` to
  `Git.Real_` with a one-sentence note that GitHub replaces the space in
  download names (R12). Then a "Windows" bullet group after the Linux ones.
  Download `Git.Real_<version>_x64-setup.exe`, run it; Windows SmartScreen
  shows "Windows protected your PC" because the installer is not yet
  signed, click "More info" then "Run anyway"; the installer is per-user
  and needs no administrator rights. The `.msi` is for managed deployment
  (`msiexec /i "Git.Real_<version>_x64_en-US.msi"`), installs per-machine.
  Git for Windows must be installed and on `PATH`, for the same reason the
  Linux text gives. Windows 10 and 11 ship WebView2; on a machine without
  it the installer downloads it.
- **README `## Releasing`**: the workflow checks the tag, builds the Linux
  packages and the Windows installers in parallel, and publishes one
  release carrying all five files. The three version strings and the tag
  procedure are unchanged. The pre-release example becomes `vX.Y.Z-1` with
  the sentence that pre-release identifiers must be a plain integer because
  the Windows MSI format allows nothing else (R10).
- **README `## Development`**: a short "Building on Windows" paragraph:
  Rust stable (MSVC toolchain), Node 24, Visual Studio Build Tools with
  the C++ workload, and WebView2 (present on Windows 10/11). No Linux apt
  text changes, so the apt contract test is unaffected.
- **ADR 0006 — Per-platform bundle configuration and multi-platform
  release** (`docs/adr/0006-per-platform-bundles-and-release.md`,
  Accepted, 2026-10-27, GR-24): records R2, R3, R4, R5, R7, R10, R12, the
  merge semantics of overlay files, and the signing recipe in enough detail to
  write the follow-up story from: `bundle.windows.signCommand` in
  `tauri.windows.conf.json` calling a wrapper around `trusted-signing-cli`
  with `%1`; `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  plus the Trusted Signing endpoint, account and certificate profile names
  as repository secrets; an install step for `trusted-signing-cli` in
  `build-windows`; and the note that SmartScreen reputation accrues to the
  publisher certificate, so one certificate serves every app.
- **ADR 0003**: a one-line "Superseded in part by ADR 0006" note under
  Consequences, where it says Windows is a follow-up ticket.

## 8. Finishing

- Merge to `main` with a merge commit, as every GR story has been. Push.
- Leave the remote feature branch in place as GR-20 did.
- Jira: GR-24 moves to Done with a summary comment; a new story "Windows
  code signing with Azure Trusted Signing" is filed with the ADR 0006
  recipe as its description and GR-24 linked. The owner's Windows smoke
  test is listed in the GR-24 status memory as outstanding.
- No tag is cut in this story. The first `v0.1.0` tag is the owner's call
  and is still pending (GR-15 status).

## 9. Left to the builder

- Exact YAML layout, step names, and whether `permissions` is job- or
  workflow-level (§4.2).
- Whether `build-windows` needs the `core.autocrlf` step (§4.1).
- Which GR-20 rule a given Windows compile failure falls under (R8), and
  the wording of §5.1.
- Correcting the README's Windows file names from the real artifact (§3).
- Whether to also add `timeout-minutes` to the two Windows jobs after
  seeing how long the first green run takes.
