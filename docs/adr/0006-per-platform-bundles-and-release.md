# ADR 0006 — Per-platform bundles and a multi-platform release

- Status: Accepted
- Date: 2026-10-27
- Epic: GR-1 / Story: GR-24 "Windows build, installer and code signing"

## Context

GR-15 shipped a Linux-only release pipeline: one job built the `.deb`, `.rpm` and
AppImage and published them. GR-24 adds Windows installers, and the owner wants macOS
next, so the configuration and the release workflow have to grow by one platform at a
time without touching what the others own.

## Decision

- **R2 — Per-platform Tauri overlay files, full symmetry.** `tauri.conf.json` keeps
  what is shared. `tauri.linux.conf.json` and `tauri.windows.conf.json` each own their
  `bundle.targets` and platform block. The macOS story adds `tauri.macos.conf.json` and
  nothing else in config.
- **Overlay merge semantics.** Tauri merges `tauri.<platform>.conf.json` over the base
  file with JSON Merge Patch: objects merge key by key, and arrays and scalars are
  replaced whole. A platform with no overlay falls back to Tauri's default of `"all"`,
  which builds that platform's native formats.
- **R3 — Build jobs upload artifacts; one publish job creates the release.** The single
  release job becomes `check-version`, `build-linux`, `build-windows` and `publish`.
  Two jobs calling the release action against one tag would race on creating the
  release and could leave a half-populated release visible to the update check, which
  reads non-draft releases (ADR 0003). `publish` runs only when both builds succeeded.
- **R4 — Signing stays out of the code.** No `signCommand`, no conditional signing step
  and no secrets are referenced. A path nobody can exercise until an Azure account
  exists would ship untested. The recipe below makes turning it on a small follow-up.
- **R5 — Both NSIS and MSI.** One build produces both. NSIS is the double-click
  installer, installed per user with `installMode: currentUser` so there is no UAC
  prompt. MSI is for managed deployment. WebView2 install mode keeps Tauri's default.
- **R7 — CI builds the Windows bundles on every push.** A `package-windows` job sits
  beside `package-linux`, so the first Windows compile of a change does not happen on a
  tag push.
- **R10 — withdrawn 2026-10-28.** GR-24 required numeric pre-release identifiers
  (`X.Y.Z-N`) because WiX accepts only numeric version parts. The owner then decided
  the project cuts no pre-release tags at all, so `check-version` accepts `X.Y.Z` only
  and the publish step has no `prerelease` flag. This supersedes the pre-release clause
  of ADR 0003 R3.
- **R12 — Release download names carry a dot, not a space.** GitHub replaces the space
  in `Git Real` with a dot when it serves a release file. The README documents the
  `Git.Real_…` names. CI artifacts keep Tauri's original names.

## Consequences

- Adding macOS means a `tauri.macos.conf.json`, a `build-macos` job and a `publish`
  dependency. The contract test requires an overlay for every platform a workflow
  builds.
- Windows installers ship unsigned until the signing story lands. Turning signing on
  takes these steps:
  1. Add `bundle.windows.signCommand` to `tauri.windows.conf.json`, wrapping
     `trusted-signing-cli` and passing the file to sign as `%1`.
  2. Add repository secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
     `AZURE_CLIENT_SECRET`, plus the Trusted Signing endpoint, account name and
     certificate profile name.
  3. Add an install step for `trusted-signing-cli` to `build-windows`, before the build.
  4. Delete the test assertion `windows overlay has no signing keys`, which exists to
     keep signing out until this story.
  5. Note that SmartScreen reputation accrues to the publisher certificate, so one
     certificate serves every app the business ships.
- Tags are `vX.Y.Z` only; a hyphenated tag fails the version check before any build starts.
