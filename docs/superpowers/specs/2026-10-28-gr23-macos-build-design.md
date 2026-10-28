# GR-23 — macOS build: unsigned DMG, signing and notarization wired

- Jira: GR-23 "macOS build, signing and notarization". One spec, one branch
  (`feature/gr-23-macos-build`), no slices.
- Depends on: GR-24 (per-platform Tauri overlays, the split release
  workflow `check-version` → `build-*` → `publish`, ADR 0006), GR-15 (the
  `src/test/release.test.ts` contract tests, ADR 0003), GR-38 step 1
  (release tags are `vX.Y.Z` only).
- Follows: ADR 0003 R6 (hand-written workflow steps, no `tauri-action`),
  ADR 0006 R2 (one overlay file per platform) and R3 (one publish job), the
  CLAUDE.md rules (hybrid git backend untouched; nothing platform-specific
  enters `git-real-core`), and the GR-24 R8 rules for what may be fixed when
  a platform compile disagrees with the code.
- Date: 2026-10-28. Written with the owner in the brainstorming session;
  decisions marked **owner** were theirs, decisions marked **call** are the
  author's and the owner may overturn them while reading.

## 1. Goal

A `v*` tag produces a GitHub release that carries a macOS `.dmg` next to
the Linux packages and Windows installers, built by the same workflow with
no human step. CI builds the DMG on every push so a macOS compile break is
caught when it lands. The release job is ready to sign the app with a
Developer ID certificate and notarize the DMG the moment the six Apple
repository secrets exist; until then it builds unsigned and says so in the
job log.

### What already exists (not rebuilt here)

Survey of `main` at 09b10ce:

- `.github/workflows/ci.yml`: `build-and-test`, `core-windows`,
  `package-linux` ("Package (Linux)"), `package-windows` ("Package
  (Windows)"), `bench`. The Windows package job is the template for the
  macOS one: checkout, Node 24 with npm cache, `dtolnay/rust-toolchain@stable`,
  `Swatinem/rust-cache@v2` with `workspaces: src-tauri`, `npm ci`,
  `npm run tauri build -- --bundles …`, `actions/upload-artifact@v4` with
  `retention-days: 14` and `if-no-files-found: error`.
- `.github/workflows/release.yml`: `check-version` (tag equals
  `tauri.conf.json` version and matches `^[0-9]+\.[0-9]+\.[0-9]+$`),
  `build-linux` and `build-windows` (each `needs: check-version`, uploads
  `release-linux` / `release-windows` with `retention-days: 1`), `publish`
  (`needs` both builds, `download-artifact@v4` with `pattern: release-*`,
  `merge-multiple: true`, `path: release-assets`, then
  `softprops/action-gh-release@v2` with `fail_on_unmatched_files: true` and
  five explicit globs of the form `release-assets/<dir>/*.<ext>`).
- `src-tauri/tauri.conf.json` holds only shared settings; `bundle.icon`
  already lists `icons/icon.icns`, regenerated from `icons/icon.svg` in
  GR-15. `tauri.linux.conf.json` and `tauri.windows.conf.json` each own
  their `bundle.targets`. No macOS overlay exists.
- `src-tauri/Cargo.toml`: `keyring = "3"` with the `apple-native` feature
  already on. Nothing has ever compiled the app crate on macOS.
- `git-real-core/src/git_cli.rs::locate()` uses the configured path, else
  the first `git` on `PATH`. On macOS `/usr/bin/git` is the Xcode Command
  Line Tools shim and is on the minimal `PATH` a Finder-launched app gets,
  so no lookup change is expected (§5).
- `src/test/release.test.ts` pins the overlay set to exactly
  `["linux", "windows"]`, the release job set to exactly four jobs, the
  `publish` globs, and several README sentences. Those assertions change
  here on purpose.
- README intro says "macOS is the follow-on target"; `## Install` covers
  Linux and Windows; `## Development` has "Building on Windows";
  `## Releasing` names the five files; `## Status` names two platforms.
- ADR 0006 R4 says "Signing stays out of the code" and its Consequences
  section describes exactly what adding macOS means: an overlay, a
  `build-macos` job and a `publish` dependency.
- Tauri CLI 2.12.3 (`@tauri-apps/cli`). Its bundler signs and notarizes
  macOS apps with no code in the project: it reads `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD` and `APPLE_TEAM_ID` from the environment. It reads them
  with `var_os`, so a variable that is present but empty counts as set: an
  empty `APPLE_CERTIFICATE` makes it try to import an empty certificate
  and fail the build. With no certificate variables it builds unsigned;
  with a certificate but no notarization trio it signs and logs "skipping
  app notarization". Read from the bundler source (`bundle/macos/sign.rs`,
  `app.rs`, `dmg/mod.rs` at Tauri 2.12):
  - `APPLE_CERTIFICATE` plus `APPLE_CERTIFICATE_PASSWORD` is the complete
    signing set. The bundler imports the `.p12` into a temporary keychain
    and takes the signing identity from the certificate itself.
    `APPLE_SIGNING_IDENTITY` is optional with a certificate: when given it
    is only checked against the certificate's identity, and a mismatch
    fails the build. Without a certificate, an identity alone makes the
    bundler sign with a keychain identity the runner does not have.
  - `APPLE_ID` and `APPLE_PASSWORD` without `APPLE_TEAM_ID` is a hard error
    in the bundler; any other incomplete trio is "skipping app
    notarization".
  - The `.app` is signed (hardened runtime), submitted to `notarytool`,
    and the ticket is stapled to the `.app`. The DMG is then built and
    code-signed with the same identity. The DMG itself is not notarized or
    stapled; Gatekeeper validates the app inside it, offline, through the
    stapled ticket.

### Goals (the ticket, mapped)

| Ticket item                                             | Delivered by                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| macOS `.dmg` from the release workflow, attached        | §4.2 `build-macos` job and the extended `publish` job.                 |
| Universal or per-arch                                   | One universal DMG (§2 R3). **Call.**                                   |
| Signed with Developer ID and notarized                  | Wired, dormant until the secrets exist (§2 R1, R2). **Owner.**         |
| `bundle.targets` per platform                           | `src-tauri/tauri.macos.conf.json` (§3), as ADR 0006 R2 planned.        |
| Extend `src/test/release.test.ts`                       | §6.                                                                    |
| Keyring `apple-native` and git CLI location need a walk | Compile proven by CI (§5); the runtime walk is an owner item (§5, §8). |

### Non-goals

- Obtaining an Apple Developer account, certificate or app-specific
  password. That is GR-37, already rewritten to cover both platforms.
- API-key notarization (`APPLE_API_KEY`, `APPLE_API_ISSUER`,
  `APPLE_API_KEY_PATH`). The bundler supports it; this story wires the
  Apple ID form only, which is what the ticket and GR-37 name.
- Signing in CI. `package-macos` never signs; signing is a release concern.
- Mac App Store, Homebrew cask, Sparkle or `tauri-plugin-updater` (GR-25),
  separate Intel and Apple Silicon downloads.
- Running the app's integration tests (`src-tauri/tests`) on macOS. The
  macOS jobs build; they do not test.
- Fixing any macOS runtime bug found later by the owner's walk. Only
  compile-time problems that block the macOS build are in scope (§5).

### Anti-goals

- A green macOS job that silently skipped bundling: `if-no-files-found:
error` on every upload, `fail_on_unmatched_files: true` on publish.
- A release missing the DMG while Linux and Windows files are published, or
  the reverse. `publish` needs all three builds, or no release.
- A build that is silently unsigned because one secret was misspelled, or
  silently signed-but-not-notarized because the notarization trio was
  incomplete. The gate (R5) fails on a half-configured set and prints the
  outcome it chose.
- Secrets or `APPLE_*` names appearing in `ci.yml`, in any Tauri config, or
  in any step other than the gate.
- Platform-specific code or `cfg` in `git-real-core` (CLAUDE.md).

## 2. Decisions

- **R1 — Unsigned DMG now.** **Owner.** No Apple Developer account or
  certificate exists. Gatekeeper will refuse the first launch; README
  documents the "Open Anyway" path (§7).
- **R2 — Signing and notarization are wired, dormant.** **Owner.** The
  release job carries everything needed to sign and notarize; only the six
  repository secrets are missing. Adding them turns signing on with no
  code or workflow change. This is the opposite of ADR 0006 R4 for
  Windows, and the ADR is amended rather than left contradicting the
  workflow (§7). The two rulings differ for a reason worth recording: the
  Windows path needs a `signCommand`, a CLI install step and an Azure
  wrapper, all of it project code that nobody could exercise; the macOS
  path is entirely inside the Tauri bundler and is driven by six
  environment variables, so "wiring" it is a short, testable shell gate.
- **R3 — One universal DMG.** **Call.** `--target universal-apple-darwin`
  builds `aarch64-apple-darwin` and `x86_64-apple-darwin` and merges them
  with `lipo`, so one download serves Intel and Apple Silicon Macs. It
  roughly doubles compile time on the macOS runner, which is acceptable
  on a public repository where Actions minutes are free. The cheaper
  alternative, an Apple Silicon-only build on `macos-latest`, would leave
  Intel Macs without a download while macOS still supports them.
- **R4 — macOS overlay carries only `targets: ["dmg"]`.** **Call.** The
  `dmg` target builds the `.app` as a step, so `app` need not be listed.
  No `bundle.macOS` block: `minimumSystemVersion`, `hardenedRuntime`
  (default true, required for notarization), `entitlements`, `frameworks`
  and `dmg` window settings keep Tauri's defaults. No `signingIdentity`
  in config, so the environment alone decides whether a build is signed
  (R5); the §6 test pins that the overlay has no signing keys, mirroring
  the Windows assertion.
- **R5 — A gate script exports the Apple variables only when the secrets
  are set.** **Call** on the mechanism, required by R2. The bundler's
  `var_os` reads mean the build step must not carry `env: APPLE_X: ${{
secrets.APPLE_X }}` lines (an unset secret is the empty string, which the
  bundler treats as set). Instead a step before the build runs
  `.github/scripts/apple-signing-env.sh` with the six secrets in its own
  `env:` block. The script:
  - treats the empty string as unset;
  - requires `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` together
    (one without the other exits 1 with a message naming the missing one);
    the pair alone is a complete signing configuration;
  - treats `APPLE_SIGNING_IDENTITY` as optional, exported when set so the
    bundler cross-checks it against the certificate, and requires
    `APPLE_CERTIFICATE` whenever it is set (an identity alone would make
    the bundler look for a certificate in the runner's keychain and fail
    at `codesign`);
  - requires `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` all together,
    and requires the certificate pair whenever any of the three is set;
  - appends every variable that is set to `$GITHUB_ENV` using the heredoc
    form (`name<<EOF`), so a base64 value with line breaks survives;
  - prints one line naming the outcome: `unsigned`, `signed, not
notarized`, or `signed and notarized`, as a workflow notice.
    GitHub masks secret values in logs whether they travel through `env:`
    or `GITHUB_ENV`. The script lives in its own file, not inline YAML, so
    the §6 tests can run it with controlled environments and a temporary
    `GITHUB_ENV` file. The build step that follows has no `env:` block.
- **R6 — CI gets a `package-macos` job.** **Call**, flagged to the owner as
  in GR-24 R7. Without it the first macOS compile of any change happens on
  a tag push. The job runs the same universal build command as the release
  job so both Rust targets are compiled on every push, never signs, and
  uploads the DMG for 14 days.
- **R7 — The DMG artifact lands at the artifact root; the publish glob
  is `release-assets/**/*.dmg`.** **Call.** `upload-artifact@v4` keeps the
  path hierarchy after the first wildcard of its search paths. The Linux
  and Windows uploads list several globs whose common ancestor is
  `bundle/`, so their files download into `deb/`, `nsis/` and so on. The
  macOS upload lists one glob whose only wildcard is the file name, so the
  DMG downloads to the root of `release-assets/`. A `**` glob matches
  either placement, which keeps the publish step correct if a later story
  adds a second macOS format and the layout shifts. `fail_on_unmatched_files`
  still fails the publish when no DMG exists at all.
- **R8 — macOS compile problems follow the GR-24 R8 rules.** **Call.** If
  the app crate fails to compile or the DMG fails to bundle: (1) a fix that
  is a gate, an import, or a one-line platform branch in `src-tauri/src/`
  is made in this story with a comment; (2) nothing in `git-real-core`
  changes; (3) anything larger is a Jira ticket and, if it blocks the
  build, the owner is asked before working around it. Known first-round
  risks: `keyring` with `apple-native` (never compiled), and Tauri's
  `bundle_dmg.sh`, which drives Finder through AppleScript to lay out the
  DMG window and is known to be flaky on headless runners (the script
  retries; a failure is retried once by re-running the job before
  anything is changed).
- **R9 — Explicit `--target` and `--bundles` in every macOS build step.**
  **Call.** Both macOS jobs run
  `npm run tauri build -- --target universal-apple-darwin --bundles dmg`,
  so the workflow reads correctly without opening the config and the
  existing assert-the-flag-text test style carries over. The Rust setup
  step lists `aarch64-apple-darwin` and `x86_64-apple-darwin` as targets;
  without both the universal build fails at `lipo`.
- **R10 — No `APPLE_*` text outside the gate.** **Call.** `ci.yml`, both
  Tauri overlays and the base config, and every step of `release.yml`
  other than the gate step and the script it runs stay free of `APPLE_`.
  The §6 test pins this so a future change cannot reintroduce the empty
  env-var failure by adding a convenient `env:` block.
- **R11 — Release download name.** **Call.** Tauri names the universal
  DMG `Git Real_X.Y.Z_universal.dmg`; GitHub serves it as
  `Git.Real_X.Y.Z_universal.dmg` (ADR 0006 R12). README documents the
  dotted name. The builder confirms the name from the first green CI
  artifact and corrects the README if Tauri's output differs.

## 3. Tauri configuration

`src-tauri/tauri.macos.conf.json` (new):

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "bundle": {
    "targets": ["dmg"]
  }
}
```

`tauri.conf.json`, `tauri.linux.conf.json` and `tauri.windows.conf.json`
do not change. Tauri merges the macOS overlay over the base with JSON Merge
Patch, as ADR 0006 records.

Bundle output path and file name for the universal target (Tauri 2.12
defaults, product name "Git Real", version `X.Y.Z`):

| Path under `src-tauri/target/universal-apple-darwin/release/bundle/` | File name                      |
| -------------------------------------------------------------------- | ------------------------------ |
| `macos/`                                                             | `Git Real.app` (not uploaded)  |
| `dmg/`                                                               | `Git Real_X.Y.Z_universal.dmg` |

Note the `universal-apple-darwin/` segment: a `--target` build does not
write under `target/release/`. Every macOS glob in both workflows uses the
target-specific path.

## 4. Workflows

### 4.1 `.github/scripts/apple-signing-env.sh`

A bash script, executable, with the R5 behaviour. Interface: reads the six
`APPLE_*` variables and `GITHUB_ENV` from its environment, writes to the
file `GITHUB_ENV` names, prints a `::notice::` line with the outcome, exits
0 on a consistent configuration and 1 on an inconsistent one with a message
naming the variable that is missing. It uses nothing beyond POSIX tools and
bash, so it runs identically on the Linux test runner and the macOS build
runner. `GITHUB_ENV` unset or empty is an error (the script must not
silently drop variables when run outside Actions).

### 4.2 `ci.yml`

New job `package-macos`, display name "Package (macOS)", on `macos-latest`:

1. Checkout (`actions/checkout@v4`).
2. Set up Node 24 with npm cache (`actions/setup-node@v4`).
3. Set up Rust stable (`dtolnay/rust-toolchain@stable`) with
   `targets: aarch64-apple-darwin, x86_64-apple-darwin`.
4. Cache Rust build (`Swatinem/rust-cache@v2`, `workspaces: src-tauri`).
5. `npm ci`.
6. `npm run tauri build -- --target universal-apple-darwin --bundles dmg`.
7. Upload with `actions/upload-artifact@v4`: name
   `git-real-macos-${{ github.sha }}`, path
   `src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg`,
   `retention-days: 14`, `if-no-files-found: error`.

No gate step, no secrets, no `shell:` override (the macOS default shell is
bash). The existing jobs do not change.

### 4.3 `release.yml`

Trigger, `check-version`, `build-linux`, `build-windows` and concurrency are
unchanged.

- New job `build-macos` on `macos-latest`, `needs: check-version`: the
  `package-macos` steps 1 to 5, then the gate step "Prepare Apple signing"
  running `.github/scripts/apple-signing-env.sh` with an `env:` block that
  maps each of the six `APPLE_*` names to `${{ secrets.APPLE_* }}` of the
  same name, then the build step (no `env:`), then upload artifact
  `release-macos` with the same DMG glob, `retention-days: 1`,
  `if-no-files-found: error`.
- `publish`: `needs: [build-linux, build-windows, build-macos]`; the
  release step gains a sixth glob, `release-assets/**/*.dmg`. Everything
  else in the step is unchanged.

Once the secrets exist, the gate exports them, the bundler imports the
certificate into a temporary keychain, signs the `.app` with the hardened
runtime, submits the `.app` to `notarytool`, waits, staples the ticket to
the `.app`, then builds the DMG and code-signs it. The DMG is not
notarized or stapled (§1, bundler facts). The job log's notice line says
which of the three outcomes applied.

## 5. Proving the macOS build

Nothing in this environment can compile the macOS app crate: the host is
Linux and there is no Mac. The proof is CI. The builder:

1. Lands the config, script and workflow changes on the feature branch and
   pushes it (a remote feature branch is normal here; GR-20 and GR-24 did
   the same).
2. Watches `Package (macOS)`. On a compile or bundle failure, applies R8,
   pushes, repeats. Each round is a commit on the branch with the failure
   and the fix named in the message, and §5.1 records the rounds.
3. Downloads the first green `git-real-macos-*` artifact and records the
   file name and size in §5.1. The DMG must exist and be larger than 5 MB:
   a universal binary carries two copies of the app, so a small DMG means
   something was left out. This is a one-time hand check recorded in §5.1,
   not a workflow step.
4. Confirms from the job log that the universal build compiled both
   targets (two `Compiling git-real` lines, or the `lipo` step) and that
   the bundler logged the DMG path under `universal-apple-darwin/`.
5. Does not run the DMG. The owner has no Mac in this session. An owner
   walk on a real Mac is listed as outstanding in the status memory, with
   these checks: mount the DMG, drag to Applications, first launch through
   Privacy & Security "Open Anyway", open a repository, confirm `git` is
   found (Command Line Tools installed) and that the hosting-token keychain
   round-trip works (the `apple-native` keyring backend prompts for
   keychain access on first use), then a fetch.

The gate script's branches are proven by the §6 tests on Linux. The
release workflow itself runs only on a tag; the GR-38 throwaway
`workflow_dispatch` check that is already outstanding should include the
`build-macos` job and the sixth glob when it runs.

### 5.1 Probe results

Filled in by the builder: runs, rounds, artifact name and size, durations.

## 6. Tests (`src/test/release.test.ts` and a new script test)

Written by the test role before any workflow, script or config change, per
the TDD policy. Assertions that change:

- `platform overlays`: the overlay set becomes exactly
  `["linux", "macos", "windows"]` (two assertions pin it today); new:
  `tauri.macos.conf.json` has `bundle.targets` equal to `["dmg"]` and
  carries the schema; new: `bundle.macOS` (note the capital `OS`, Tauri's
  key) is absent or has none of `signingIdentity`, `providerShortName`,
  `entitlements`, mirroring `windows overlay has no signing keys`.
- `ci workflow`: the job list assertion includes `package-macos`; new:
  `package-macos` runs on `macos-latest`, its Rust setup step lists both
  Apple targets, its build step contains `--target universal-apple-darwin`
  and `--bundles dmg`, its upload name contains `git-real-macos-`, its glob
  is the `universal-apple-darwin` DMG path, `retention-days: 14`,
  `if-no-files-found: error`; it has no `apt-get` step; the whole of
  `ci.yml` contains no `APPLE_` (R10).
- `release workflow`: the job set becomes five; `build-macos` needs
  `check-version`; `publish` needs all three builds; `build-macos` runs on
  `macos-latest` with the same build-step and Rust-targets assertions as
  CI; its upload is `release-macos` with `retention-days: 1`; the gate step
  runs `.github/scripts/apple-signing-env.sh`, comes before the build step,
  and its `env` maps exactly the six names to `${{ secrets.<same name> }}`;
  the build step has no `env` key; outside the gate step's `env` block the
  text of `release.yml` contains no `APPLE_` (R10); the release step lists
  six globs including `release-assets/**/*.dmg` and nothing else changed.
- New file `src/test/apple-signing-env.test.ts` runs the script with
  `execFileSync` and a temporary `GITHUB_ENV` file, each case with a fully
  controlled environment (`env: { PATH, GITHUB_ENV, ...APPLE vars }`, no
  inheritance): all six unset → exit 0, file empty, stdout contains
  `unsigned`; all six set → exit 0, file holds six assignments and the
  values round-trip, including a certificate value containing a newline;
  certificate pair only → exit 0, three or two assignments, stdout contains
  `not notarized`; certificate without password → exit 1, message names
  `APPLE_CERTIFICATE_PASSWORD`; identity without certificate → exit 1;
  notarization trio with one missing → exit 1, message names it;
  notarization trio without certificate → exit 1; `GITHUB_ENV` unset →
  exit 1. Values set to the empty string behave as unset in every case.
  The test skips with a message when `bash` is not on `PATH` (the Windows
  core job does not run the front-end tests, so this is belt and braces).
- `README`: intro no longer calls macOS a follow-on target; `## Install`
  contains `.dmg`, `Git.Real_`, `universal` and "Open Anyway"; `## Releasing`
  mentions macOS and "six"; `## Development` contains "Building on macOS".
- `ADR 0006 exists …` gains: the ADR text contains `build-macos`,
  `APPLE_CERTIFICATE` and the renamed heading text "Windows signing stays
  out of the code"; the unqualified "Signing stays out of the code" no
  longer appears. **Call.**

Everything else in the file (versions, icons, desktop template, apt
packages, bench workflow) is untouched.

## 7. Documentation

- **README intro and `## Status`**: Linux is first-class; Windows
  installers and a macOS disk image are built alongside the Linux packages.
  No platform is a follow-on any more.
- **README `## Install`**: a "macOS" bullet after Windows. Download
  `Git.Real_<version>_universal.dmg` (one file for Intel and Apple Silicon),
  open it and drag Git Real to Applications. The app is not yet signed or
  notarized, so the first launch is refused: on macOS 15 and later, open
  System Settings › Privacy & Security, find the Git Real entry and choose
  **Open Anyway**; on earlier versions Control-click the app and choose
  **Open**. The one-line `xattr -d com.apple.quarantine "/Applications/Git
Real.app"` alternative is given for people who prefer the terminal. Git
  itself comes with the Xcode Command Line Tools (`xcode-select --install`),
  which macOS offers to install the first time anything calls `git`.
- **README `## Releasing`**: the workflow builds the Linux packages, the
  Windows installers and the macOS disk image in parallel, then publishes
  one release carrying all six files. One sentence: the macOS job signs
  and notarizes when the `APPLE_*` repository secrets are present (see
  ADR 0006) and builds unsigned otherwise.
- **README `## Development`**: a "Building on macOS" paragraph after the
  Windows one: Xcode Command Line Tools, Rust stable with both Apple
  targets added through `rustup target add`, Node 24, and
  `npm run tauri build -- --target universal-apple-darwin --bundles dmg`
  writing under `src-tauri/target/universal-apple-darwin/release/bundle/`.
- **ADR 0006** (amended in place, 2026-10-28, keeping Accepted):
  - R4 becomes "Windows signing stays out of the code" with its reasoning
    unchanged.
  - New **R13 — macOS signing and notarization are wired, dormant**: the
    owner's ruling (R2), why it differs from R4, the gate script and its
    rules (R5), the `var_os` fact that makes the gate necessary, the six
    secret names with the identity marked optional, and what the bundler
    does with them: the `.app` is signed, notarized and stapled; the DMG
    is code-signed only.
  - New **R14 — One universal DMG** (R3) and the `universal-apple-darwin`
    output path.
  - Consequences: the "Adding macOS means…" paragraph is marked done by
    GR-23; the overlay contract line now reads three platforms; a macOS
    paragraph says the DMG ships unsigned until GR-37 adds the secrets,
    and that turning it on is adding secrets, nothing else.
- **ADR 0003**: no change (it already points at ADR 0006).

## 8. Finishing

- Merge to `main` with a merge commit, as every GR story has been. Push.
- Leave the remote feature branch in place as GR-20 and GR-24 did.
- Jira: GR-23 moves to Done with one summary comment (the project's
  one-comment rule). GR-37 was already rewritten in this session to cover
  Apple signing; link GR-37 to GR-23 as "relates to". No new tickets
  unless §5 produces one under R8.
- The owner's macOS walk (§5 step 5) is listed in the GR-23 status memory
  as outstanding, next to the Windows smoke test from GR-24.
- No tag is cut in this story (GR-38).

## 9. Left to the builder

- Exact YAML layout, step names and ordering within the conventions above.
- The script's wording and exit messages, and how the test extracts the
  `::notice::` line.
- Whether `package-macos` and `build-macos` need `timeout-minutes` after
  seeing how long the first green universal build takes.
- Which GR-24 R8 rule a given macOS compile failure falls under, and the
  wording of §5.1.
- Correcting the README's DMG file name from the real artifact (R11).
- Whether to retry a `bundle_dmg.sh` Finder failure by re-running the job
  or by a `continue`-style retry in the workflow; the first failure is
  re-run by hand before any workflow change (R8).
