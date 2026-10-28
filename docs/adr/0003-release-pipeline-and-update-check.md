# ADR 0003 — Release pipeline and update check

- Status: Accepted
- Date: 2026-10-25
- Epic: GR-1 / Story: GR-15 "Linux packaging and release pipeline"

## Context

Git Real had CI that built and tested the app but produced no distributable artifacts,
no release trigger, and no way for a running copy to learn that a newer version exists.
GR-15 adds Linux packaging (`.deb`, `.rpm`, AppImage), a tag-driven GitHub release, and
an in-app update check. Four choices in that work shape future tickets (code signing,
Flatpak, macOS and Windows builds), so they are recorded here. The constraints from
earlier ADRs hold: HTTP goes only through the existing `Transport` (ADR 0001's hybrid
backend), the CSP stays unchanged, and no network-enabled crate or Tauri plugin is
added.

## Decision

- **R1 — Update discovery by API, not by updater plugin.** A `check_for_update` command
  in Rust GETs `https://api.github.com/repos/harmonizationllc/git-real/releases/latest`
  through the existing `Transport`, compares the release `tag_name` with the running
  `CARGO_PKG_VERSION`, and the UI notifies with a link to the release page. This is the
  acceptance criterion (notify, not install). It adds no crate, no secret, and no
  capability, and it is testable with the existing fake transport. `tauri-plugin-updater`
  with signed artifacts is deferred to a later ticket.
- **R2 — Flatpak deferred.** No Flatpak manifest or `flatpak-builder` job ships now:
  `flatpak-builder` cannot be verified in this environment, a manifest would have to
  point at a release that does not yet exist, and a Flatpak needs its own Flathub update
  path rather than the GitHub check. It becomes a follow-up ticket.
- **R3 — Tag push publishes immediately.** A `v*` tag publishes a non-draft release with
  GitHub's generated notes, marked pre-release when the tag contains a hyphen. The
  acceptance criterion says "published on tag push", and the update check reads
  `releases/latest`, which ignores drafts.
- **R6 — Hand-written release workflow.** The release job is explicit steps
  (`npm run tauri build`, then `softprops/action-gh-release@v2` with file globs and
  generated notes) rather than `tauri-apps/tauri-action`. Every step is visible in the
  YAML and the build step is shared verbatim with the CI `package-linux` job.

## Consequences

- The update check is swappable: a later ticket can replace the command body with a
  signed-updater `check()` and add signing, keeping the toast and About UI.
- No signing key, GitHub secret, or extra capability is introduced by this story; Linux
  artifacts are unsigned, which is the norm for `.deb`/`.rpm`/AppImage.
- Flatpak, macOS, Windows, and signed in-app updates are tracked as separate follow-up
  tickets that build on these decisions. Windows builds landed in GR-24; see ADR 0006
  for the per-platform configuration and the signing recipe.
- Releases are reproducible from a tag with no manual build step, but the three version
  strings remain hand-edited and are kept in sync by a contract test and the release
  job's version guard.
