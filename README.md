# Git Real

Git Real is a free, lightweight, cross-platform desktop Git client. It is built with
Tauri 2 and Rust on the backend and React with TypeScript on the front end, and it aims
to cover the everyday Git workflows of a developer in one fast, native-feeling window.

Linux (Wayland, with the COSMIC desktop as the primary target) is the first-class
platform. Windows installers and a macOS disk image are built alongside the Linux
packages.

## Features

- **Repositories**: open, clone, and initialize repositories; recent-repository list.
- **Working tree**: stage, unstage, and discard changes by file, hunk, or line, with a
  syntax-highlighted diff viewer.
- **Commits**: commit with subject and body, amend, and link hosting issues from the
  message editor.
- **Branches**: create, check out, rename, and delete branches; track upstreams.
- **History**: a commit graph with lanes, merges, and ref labels; commit detail with
  per-file diffs; file history and blame.
- **Merge and rebase**: merge, rebase, and interactive rebase with an inline conflict
  editor and drag-to-merge.
- **Stashes and tags**: create, apply, pop, and drop stashes; create and delete tags.
- **Remotes**: fetch, pull, and push with SSH and HTTPS credential prompts; manage
  remotes.
- **Hosting integration** (GitHub, GitLab, Bitbucket): connect accounts with personal
  access tokens stored in the OS keychain, list and check out pull requests, create a
  pull request from the current branch, browse open issues, and insert `#n` issue
  references while committing.

## Technology

| Layer     | Choice                                                                   |
| --------- | ------------------------------------------------------------------------ |
| Shell     | Tauri 2 (system WebView)                                                 |
| Backend   | Rust; `git2` (libgit2) for local reads, the system `git` CLI for network |
| Front end | React 19, TypeScript, TanStack Query, Zustand, CSS Modules               |
| Editor    | CodeMirror 6 for diffs and conflict editing                              |
| Secrets   | OS keychain via `keyring`                                                |
| Tests     | `cargo test` for Rust, Vitest for the front end                          |

The Git domain logic lives in a pure Rust crate, `git-real-core`, that has no Tauri
dependency, so it unit tests with a plain `cargo test`. A thin Tauri layer exposes it
to the front end over typed IPC commands.

## Architecture in brief

- **Hybrid Git backend.** `git2` handles status, log, diff, refs, and blame. Anything
  that touches the network, credentials, or signing shells out to the system `git`,
  so SSH agents, credential helpers, and GPG or SSH signing work the way they already
  do on your machine.
- **Single IPC seam.** Only `src/lib/ipc` talks to Tauri. Features import typed
  wrappers from there, which is also the one mock point for front-end tests.
- **Off the UI thread.** Blocking Git work runs in Tauri's async runtime so the
  interface never stalls.
- **Decisions are recorded.** Architecture decision records live in
  [docs/adr](docs/adr). Feature designs and implementation plans live under
  [docs/superpowers](docs/superpowers).

## Install

Pre-built Linux packages, Windows installers and a macOS disk image are published on each release. Download
the one for your system from the [GitHub Releases](https://github.com/harmonizationllc/git-real/releases)
page (`<version>` is the release, for example `0.1.0`). The product name has a space in
it, and GitHub replaces that space with a dot when it serves a release file, so a
download is named `Git.Real_<version>_amd64.deb`; quote the path:

- **Debian, Ubuntu, Pop!\_OS** — the `.deb`:

  ```sh
  sudo apt install "./Git.Real_<version>_amd64.deb"
  ```

- **Fedora, RHEL, openSUSE** — the `.rpm`:

  ```sh
  sudo dnf install "./Git.Real-<version>-1.x86_64.rpm"
  ```

- **Any distribution** — the AppImage, which installs nothing:

  ```sh
  chmod +x "Git.Real_<version>_amd64.AppImage"
  "./Git.Real_<version>_amd64.AppImage"
  ```

- **Windows** — download `Git.Real_<version>_x64-setup.exe` and run it. The installer is
  not yet code-signed, so Windows SmartScreen shows "Windows protected your PC":
  choose **More info**, then **Run anyway**. The installer is per-user and needs no
  administrator rights. For managed deployment use the per-machine MSI,
  `msiexec /i "Git.Real_<version>_x64_en-US.msi"`, which needs an elevated
  (administrator) prompt, unlike the per-user setup `.exe`. Windows 10 and 11 ship WebView2,
  and the installer downloads it on a machine that lacks it.

- **macOS** — download `Git.Real_<version>_universal.dmg`, one file for both Intel and
  Apple Silicon, open it and drag Git Real to Applications. The app is signed only
  with an ad-hoc signature, not with a Developer ID, and not notarized, so macOS
  refuses the first launch. On macOS 15 and later, open System Settings, then Privacy
  & Security, find the Git Real entry and choose **Open Anyway**. On earlier versions
  Control-click the app and choose **Open**. If you prefer the terminal, run:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Git Real.app"
  ```

The `.deb` recommends `git`, and you should have it on any install: every network
operation (fetch, pull, push, clone over the network) and all commit signing shell out
to the system `git` CLI, so Git Real needs it on your `PATH`. On Windows, install
[Git for Windows](https://gitforwindows.org/) and let it add `git` to `PATH`. On macOS,
`git` comes with the Xcode Command Line Tools (`xcode-select --install`), which macOS
offers to install the first time anything calls `git`.

## Wayland and X11

Git Real runs under both Wayland and X11. On COSMIC the window uses the compositor's
server-side decorations, so it looks and resizes like any other COSMIC window. Two
environment switches cover the stacks that need them:

- `GDK_BACKEND=x11 git-real` forces the app to run under X11 (XWayland) instead of
  Wayland.
- `WEBKIT_DISABLE_DMABUF_RENDERER=1 git-real` works around a blank window seen on some
  NVIDIA and Wayland driver combinations.

## Development

Prerequisites:

- **Rust** (stable, via [rustup](https://rustup.rs/))
- **Node.js 24** and npm
- On Debian, Ubuntu, or Pop!\_OS, the Tauri Linux system libraries:

  ```sh
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    libxdo-dev \
    pkg-config \
    file \
    patchelf
  ```

- **Building on Windows**: Rust stable with the MSVC toolchain (rustup's default on
  Windows), Node.js 24, Visual Studio Build Tools 2022 with the "Desktop development
  with C++" workload, and WebView2 (preinstalled on Windows 10 and 11).
  `npm run tauri build -- --bundles nsis,msi` produces the installers under
  `src-tauri\target\release\bundle\`.

- **Building on macOS**: the Xcode Command Line Tools, Rust stable with both Apple
  targets added (`rustup target add aarch64-apple-darwin x86_64-apple-darwin`), and
  Node.js 24. `npm run tauri build -- --target universal-apple-darwin --bundles dmg`
  produces one universal disk image under
  `src-tauri/target/universal-apple-darwin/release/bundle/`.

Getting started:

```sh
npm install        # install front-end dependencies
npm run tauri dev  # run the desktop app in development
```

Common commands:

| Command                                   | What it does                                  |
| ----------------------------------------- | --------------------------------------------- |
| `npm run tauri dev`                       | Run the app in development                    |
| `npm test`                                | Front-end unit tests (Vitest)                 |
| `npm run test:coverage`                   | Front-end tests with the 100 % coverage gate  |
| `npm run lint`                            | ESLint and Prettier checks                    |
| `npm run typecheck`                       | `tsc --noEmit`                                |
| `npm run build`                           | Type-check and build the front-end bundle     |
| `cargo test --workspace`                  | All Rust tests (run from `src-tauri`)         |
| `cargo test -p git-real-core`             | Fast pure-domain tests (run from `src-tauri`) |
| `cargo clippy --workspace -- -D warnings` | Rust lints (run from `src-tauri`)             |

Rust tests need `git` on `PATH`; set `GIT_REAL_SKIP_GIT_TESTS=1` to skip the tests that
drive the git CLI.

### How the project is built

Every feature starts as a design document, then an implementation plan, then
test-first development: tests are written before the code they exercise, coverage is
kept at 100 % on the front end, and each change passes a code review and an
architecture review before it is merged. The design and plan documents are checked in
under `docs/superpowers` so the reasoning behind each feature travels with the code.

## Benchmarks

`src-tauri/crates/git-real-bench` is a benchmark harness that measures the backend
against large repositories. For each repository it times opening the repository,
serializing the first 500-row page and completing the commit graph, pages through the
whole history while sampling resident memory, and times a working-tree status refresh.
It fails when a budget is exceeded:

| Metric              | Budget    | What it covers                                                     |
| ------------------- | --------- | ------------------------------------------------------------------ |
| `openToFirstPageMs` | 3,000 ms  | Open to the first streamed page at 100,000 commits                 |
| `graphCompleteMs`   | 10,000 ms | Open to a complete, topologically ordered graph at 100,000 commits |
| `statusMs`          | 1500 ms   | Status refresh on a worktree of 10,000+ files                      |
| `rssGrowthMb`       | 64 MB     | Memory growth while paging through the full history                |

The graph is built in the background and its first rows stream to the panel before
the build finishes, so `openToFirstPageMs` now measures the first streamed page, and
`graphCompleteMs` covers the whole build.

Prepare the three fixtures (a deterministic synthetic repository of 100,000 commits and
10,000 files built with `git fast-import`, the oldest 100,000 commits of `qemu/qemu`
for the graph, and a shallow `qemu/qemu` checkout of 11,488 files for status), then run
the suite, from `src-tauri`:

```sh
cargo run --release -p git-real-bench -- prepare synthetic ~/.cache/git-real-bench/synthetic
cargo run --release -p git-real-bench -- prepare public-graph ~/.cache/git-real-bench/qemu-graph
cargo run --release -p git-real-bench -- prepare public-worktree ~/.cache/git-real-bench/qemu-worktree
cargo run --release -p git-real-bench -- run ~/.cache/git-real-bench/synthetic ~/.cache/git-real-bench/qemu-graph ~/.cache/git-real-bench/qemu-worktree --json bench-results.json --summary bench-summary.md
```

`prepare` is idempotent: a directory that already holds a matching fixture is reused.
In CI the `bench` job runs the same suite on every push and pull request, writes the
results table to the job summary, and uploads the JSON report as the
`bench-results-‹sha›` artifact.

The Linux kernel is an informational run, outside the budgets:

```sh
cargo run --release -p git-real-bench -- prepare public-graph ~/.cache/git-real-bench/linux-graph --url https://github.com/torvalds/linux --commits 2000000
cargo run --release -p git-real-bench -- run ~/.cache/git-real-bench/linux-graph --no-assert
```

Its 1,501,435 commits were measured before GR-27: 41 s / 8.8 GB / +2 GB; GR-27 numbers
are recorded in ADR 0007. The budgets themselves are recorded in
[ADR 0004](docs/adr/0004-performance-budgets-and-benchmarks.md).

## Releasing

A release is cut from a tag. The three app version strings must agree, and the release
workflow refuses a tag that does not match.

1. Set the same `X.Y.Z` version in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml`.
2. Run `npm test` — a contract test checks that the three versions agree.
3. Commit the version bump.
4. Tag and push:

   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

The `Release` workflow first checks the tag against the version, then builds the
`.deb`, `.rpm` and AppImage on Linux, the NSIS `.exe` and `.msi` on Windows and the
universal `.dmg` on macOS in parallel, then publishes one GitHub release carrying all
six files with generated release notes. The macOS job signs and notarizes the app when
the `APPLE_*` repository secrets are present (see
[ADR 0006](docs/adr/0006-per-platform-bundles-and-release.md)) and builds ad-hoc
signed, without notarization, otherwise. A tag whose version differs from `tauri.conf.json` fails before anything
is built. Release tags are always `vX.Y.Z`; the workflow rejects any other shape, and
every release is a full release that the in-app update check can offer.

## Project layout

```
src/                 React front end (features, components, lib/ipc seam, stores)
src-tauri/           Tauri app crate: commands, events, keychain, registration
src-tauri/crates/
  git-real-core/     Pure Rust Git domain: git2 reads, git CLI network ops, hosting APIs
  git-real-bench/    Benchmark harness for large repositories (dev tool, not bundled)
docs/adr/            Architecture decision records
docs/superpowers/    Feature design specs and implementation plans
```

## Status

Git Real is at version 0.1.0 and under active development. The features above are
implemented and tested, Linux packages, Windows installers and a macOS disk image are published on each release, and a benchmark
suite holds the app to its performance budgets on 100,000-commit repositories in CI.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).
